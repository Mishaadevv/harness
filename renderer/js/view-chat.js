/* Chat view — quiet by default. Messages live on the background;
 * user turns get a whisper of surface; agent work collapses into activity. */
import { esc, timeAgo, el } from './utils.js';
import { renderMarkdown, bindCopyButtons } from './markdown.js';
import { todoView } from './tasks.js';

/* Entrance animation only for genuinely new messages —
 * streaming re-renders must not replay it (flicker). */
const seenIds = new Set();
function fresh(m) {
  if (!m || seenIds.has(m.id)) return false;
  seenIds.add(m.id);
  if (seenIds.size > 600) { const it = seenIds.values(); for (let i = 0; i < 200; i++) seenIds.delete(it.next().value); }
  return true;
}

/* Live streaming message: ONE DOM node per run, updated in place.
 * Full-chat re-renders move this node instead of rebuilding it, so the
 * text never flickers and code highlighting/images stay stable. */
let live = null;

/* Every message keeps its DOM node between renders, keyed by its content
 * signature. Rebuilding the whole transcript on each streamed token resets
 * scroll position and re-renders code blocks and images several times a
 * second — the reason a long answer felt like a page reloading itself while
 * the reader was trying to scroll through it. */
let mounted = [];   // [{ key, node }] in document order
let mountedChat = null;

function messageKey(m, state) {
  return [
    m.id, String(m.content || '').length, m.failed ? 'f' : '', m.partial ? 'p' : '',
    String(m.reasoning || '').length, (m.steps || []).length, (m.toolCalls || []).length,
    (m.memsUsed || []).length, m.branch ? 'b' : '', state.settings.showThinking ? 't' : '',
    (m.questions || []).map(q => q.id + ':' + (q.status || 'open') + ':' + (q.answer ?? '')).join(','),
    String(m.modelLabel || ''), String(m.tokens || '')
  ].join('|');
}

function clearMounted(root) {
  root.innerHTML = '';
  mounted = [];
  mountedChat = null;
}

function setupLine(api) {
  const n = el(`<div class="setup-line">
    <div class="grow">Connect a provider to begin.</div>
  </div>`);
  const b = el(`<button class="mini-btn">Open providers →</button>`);
  b.onclick = () => api.goto('settings', 'providers');
  n.appendChild(b);
  return n;
}

export function renderChat(root, state, api) {
  const chat = state.chats.find(c => c.id === state.activeChatId);
  if (mountedChat !== (chat?.id || null) || mounted.some(x => !x.node.isConnected)) clearMounted(root);
  if (!chat) {
    clearMounted(root);
    root.appendChild(hero(api));
    live = null;
    return;
  }
  mountedChat = chat.id;
  const hasProvider = state.providers.some(p => p.enabled && (p.models || []).length) || state.models.length;
  if (api.streaming) {
    const s = api.streaming;
    if (!live || live.chatId !== s.chatId || live.run !== s) live = createLiveNode(s);
  } else if (live) {
    live = null;
  }

  /* EVERY child of the container is part of one list — the empty-state hero
   * and the connect-a-provider hint included. They used to be appended next
   * to the reconciliation instead of inside it, so the hero stayed on the
   * page underneath the first messages of a chat. */
  const wanted = [];
  if (!hasProvider) wanted.push({ key: 'setup-line', make: () => setupLine(api) });
  if (!chat.messages.length) wanted.push({ key: 'hero', make: () => hero(api) });
  for (const m of chat.messages) {
    if (m._hidden) continue;
    wanted.push({ key: messageKey(m, state), make: () => messageNode(m, state, api) });
  }
  wanted.push({ key: 'todo:' + chat.id, make: () => todoView(state, chat, api) });
  if (live) wanted.push({ key: 'live', node: live.wrap });

  const pool = new Map();
  for (const x of mounted) if (!pool.has(x.key)) pool.set(x.key, x.node);
  const next = [];
  const reused = new Set();
  for (const w of wanted) {
    let node = w.node || (pool.get(w.key) && !reused.has(pool.get(w.key)) ? pool.get(w.key) : null);
    if (!node) node = w.make();
    reused.add(node);
    next.push({ key: w.key, node });
  }
  // Anything in the container that is not in the new list is gone: a replaced
  // node, a hero that no longer belongs, something a previous render left.
  const keep = new Set(reused);
  for (const child of [...root.children]) if (!keep.has(child)) child.remove();
  // Place them in order, moving only what is out of place.
  let ref = root.firstChild;
  for (const x of next) {
    if (x.node === ref) { ref = ref.nextSibling; continue; }
    root.insertBefore(x.node, ref);
  }
  mounted = next;
  if (api.streaming) syncLive(api.streaming, state, api);
}

/* The agent's task list lives in tasks.js — the chat only places it. */

/* ---------------- In-chat agent question (ask_user) ----------------
 * While the run waits for an answer the card is interactive: click one of
 * the model's options, or type your own. Once answered it collapses to a
 * quiet record — the transcript keeps the question and what you chose. */
export function questionNode(q, opts = {}) {
  const api = opts.api || null;
  // A question still open in a finished message can never be answered:
  // show it as not answered instead of dead buttons.
  const status = (q.status || 'open') === 'open' && !opts.live ? 'skipped' : (q.status || 'open');
  const wrap = el(`<div class="ask-card ${status}">
    <div class="ask-head"><span class="ask-mark">${status === 'open' ? '<span class="ask-pulse"></span>' : status === 'answered' ? '✓' : '○'}</span>
      <span class="ask-label"></span>
      ${status === 'open' ? '<span class="ask-wait">waiting for your answer</span>' : ''}</div>
    <div class="ask-body"><div class="ask-q"></div></div>
  </div>`);
  wrap.querySelector('.ask-label').textContent = q.header || 'Agent question';
  wrap.querySelector('.ask-q').textContent = q.question || '';
  const body = wrap.querySelector('.ask-body');

  if (status !== 'open') {
    const out = el(`<div class="ask-result"></div>`);
    if (status === 'answered') {
      for (const v of (Array.isArray(q.answer) ? q.answer : [q.answer])) {
        const chip = el(`<span class="ask-chip"></span>`);
        chip.textContent = String(v ?? '');
        out.appendChild(chip);
      }
    } else {
      out.appendChild(el(`<span class="ask-none">Not answered</span>`));
    }
    body.appendChild(out);
    return wrap;
  }

  const options = Array.isArray(q.options) ? q.options : [];
  const multiple = !!q.multiple;
  const picked = new Set();
  let sent = false;
  const answer = (value) => {
    if (sent) return;
    sent = true;
    if (api?.answerQuestion) api.answerQuestion(q.id, value);
    else console.warn('No answer channel for question', q.id);
    wrap.querySelector('.ask-wait')?.remove();
    wrap.querySelectorAll('button, input').forEach(x => { x.disabled = true; });
    const tag = el(`<span class="ask-sent">✓ ${value == null ? 'skipped' : 'answer sent'}</span>`);
    wrap.querySelector('.ask-head').appendChild(tag);
    wrap.classList.add('sent');
  };

  if (options.length) {
    const list = el(`<div class="ask-opts"></div>`);
    for (const o of options) {
      const b = el(`<button class="ask-opt" type="button"></button>`);
      b.textContent = o;
      b.onclick = () => {
        if (!multiple) { b.classList.add('on'); answer(o); return; }
        if (picked.has(o)) picked.delete(o); else picked.add(o);
        b.classList.toggle('on', picked.has(o));
        sync();
      };
      list.appendChild(b);
    }
    body.appendChild(list);
  }

  const row = el(`<div class="ask-row">
    <input class="ask-input" type="text" />
    <button class="ask-submit" type="button">${multiple ? 'Send' : 'Answer'}</button>
    <button class="ask-skip" type="button" title="Let the model continue without an answer">Skip</button>
  </div>`);
  const input = row.querySelector('.ask-input');
  const submit = row.querySelector('.ask-submit');
  input.placeholder = options.length ? '…or type your own answer' : 'Type your answer…';
  const sync = () => { submit.disabled = multiple && !picked.size && !input.value.trim(); };
  const send = () => {
    const typed = input.value.trim();
    if (multiple && picked.size) return answer(typed ? [...picked, typed] : [...picked]);
    if (typed) return answer(typed);
    if (!multiple && options.length === 1) answer(options[0]);
  };
  submit.onclick = send;
  input.oninput = sync;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
    if (e.key === 'Escape') answer(null);
  };
  row.querySelector('.ask-skip').onclick = () => answer(null);
  body.appendChild(row);
  sync();
  return wrap;
}

function hero(api) {
  const d = el(`<div class="hero">
    <h1>Start a new conversation</h1>
    <p>Chat with models, run agents, work with files.</p>
    <div class="sugg-list"></div>
  </div>`);
  const list = d.querySelector('.sugg-list');
  const items = [
    'Explain a concept',
    'Write code',
    'Plan with an agent',
    'Work with files'
  ];
  const prompts = {
    'Explain a concept': 'Explain how streaming LLM APIs work, simply and precisely.',
    'Write code': 'Write a clean Python function that parses server-sent events.',
    'Plan with an agent': 'Help me plan this step by step.',
    'Work with files': 'What can you help me do with project files?'
  };
  for (const label of items) {
    const b = el(`<button class="sugg-row"><span>${esc(label)}</span><span class="arrow">→</span></button>`);
    b.onclick = () => {
      if (label === 'Plan with an agent') api.setModeAndFill('agent', prompts[label]);
      else if (label === 'Work with files') api.goto('files');
      else api.fillComposer(prompts[label]);
    };
    list.appendChild(b);
  }
  return d;
}

function roleLine(role, meta) {
  return `<div class="role-line"><span class="role-name">${esc(role)}</span>
    ${meta ? `<span class="role-meta">${esc(meta)}</span>` : ''}
    <span class="msg-actions"></span></div>`;
}

/* Rendered-markdown cache for finished messages: streaming ticks must not
 * re-render (and re-layout) the whole history 9×/second. */
const mdCache = new Map(); // message id -> {src, html}

function messageNode(m, state, api) {
  const isUser = m.role === 'user';
  const wrap = el(`<div class="msg${fresh(m) ? ' fresh' : ''}"></div>`);
  const head = el(roleLine(
    isUser ? 'You' : (m.modelLabel || 'Assistant'),
    timeAgo(m.at) + (m.tokens ? ' · ' + m.tokens : '') + (m.branch ? ' · branch' : '') + (m.failed ? ' · run failed' : '')
  ));
  const acts = head.querySelector('.msg-actions');
  const mk = (label, fn) => { const b = el(`<button class="mini-btn">${esc(label)}</button>`); b.onclick = (e) => { e.stopPropagation(); fn(); }; acts.appendChild(b); };
  if (isUser) { mk('Edit', () => api.onEdit(m.id)); mk('Copy', () => navigator.clipboard.writeText(m.content || '')); }
  else { mk('Copy', () => navigator.clipboard.writeText(m.content || '')); mk('Retry', () => api.onRegenerate(m.id)); mk('Continue', () => api.onContinue(m.id)); mk('Branch', () => api.onBranch(m.id)); }
  wrap.appendChild(head);

  if (m.attachments && m.attachments.length) {
    const row = el(`<div class="msg-attach-row"></div>`);
    for (const a of m.attachments) {
      row.appendChild(el(`<span class="attach-thumb">${a.kind === 'image' && a.dataUrl ? `<img src="${a.dataUrl}" alt="" />` : '📄'}<span>${esc(a.name)}</span></span>`));
    }
    wrap.appendChild(row);
  }
  if (m.memsUsed && m.memsUsed.length && state.settings.memoryGlobal !== false) {
    const row = el(`<div class="mem-used" title="Memories used"></div>`);
    for (const t of m.memsUsed.slice(0, 3)) row.appendChild(el(`<span class="mem-chip">${esc(String(t).slice(0, 60))}</span>`));
    wrap.appendChild(row);
  }
  if (m.reasoning && state.settings.showThinking) wrap.appendChild(reasoningNode(m.reasoning, false));
  if (m.steps && m.steps.length) wrap.appendChild(activityNode(m.steps, false, m.modelLabel, m.id));
  else if (m.toolCalls && m.toolCalls.length) wrap.appendChild(activityNode(m.toolCalls.map(t => ({ name: t.name, ok: t.ok, result: t.result, ms: t.ms })), false, m.modelLabel, m.id + ':tools'));
  // Questions the agent asked mid-run, with the answers the user gave.
  for (const q of (m.questions || [])) wrap.appendChild(questionNode(q, { live: false, api }));

  if (isUser) {
    const b = el(`<div class="user-bubble"></div>`);
    b.textContent = m.content || '';
    wrap.appendChild(b);
  } else {
    const md = el(`<div class="md"></div>`);
    const cached = mdCache.get(m.id);
    if (cached && cached.src === (m.content || '')) {
      md.innerHTML = cached.html;
    } else {
      md.innerHTML = renderMarkdown(m.content || '');
      if (mdCache.size > 300) { const it = mdCache.keys(); for (let i = 0; i < 60; i++) mdCache.delete(it.next().value); }
      mdCache.set(m.id, { src: m.content || '', html: md.innerHTML });
    }
    bindCopyButtons(md);
    wrap.appendChild(md);
  }
  return wrap;
}

export function reasoningNode(text, live) {
  const d = el(`<div class="reasoning${live ? ' live' : ''}"><button class="reasoning-head">${live ? '<span class="pulse"></span><span>Thinking…</span>' : '<span>Reasoning</span><span style="opacity:.5">▾</span>'}</button>
    <div class="reasoning-body"></div></div>`);
  const body = d.querySelector('.reasoning-body');
  body.textContent = text || '';
  if (!live) body.style.display = 'none';
  d.querySelector('.reasoning-head').onclick = () => { body.style.display = body.style.display === 'none' ? '' : 'none'; };
  d._setText = (t) => { body.textContent = t; };
  return d;
}

/* Compact agent activity: one collapsible block, steps as quiet rows.
 *
 * The block is rebuilt whenever a new step lands, and the old code carried
 * "was it open?" through the rebuild — which, for the live block, always
 * landed on "open". So the panel could not be closed at all. The fold is
 * remembered per block here, and the default is CLOSED: a run's worth of
 * rows is noise next to the answer, and the header already says how many
 * steps there were. */
const activityOpen = new Map(); // block id -> true when the reader opened it

/* Ten identical "Updated the task list" rows teach nothing. Consecutive
 * repeats collapse into one row with a count. */
function groupSteps(steps) {
  const out = [];
  for (const s of steps) {
    const label = describeStep(s);
    const last = out[out.length - 1];
    if (last && last.label === label && last.ok === s.ok) {
      last.n++;
      if (s.result) last.result = s.result;
      if (s.ms != null) last.ms = s.ms;
      continue;
    }
    out.push({ label, ok: s.ok, n: 1, result: s.result, ms: s.ms });
  }
  return out;
}

export function activityNode(steps, live, label, id = null) {
  const key = id || (live ? 'live' : 'steps');
  const open = activityOpen.get(key) === true;
  const n = steps.length;
  const d = el(`<div class="activity"><button class="activity-head" aria-expanded="${open}">${live ? '<span class="pulse"></span>' : ''}
    <span>${esc(label ? label + ' · ' : '')}${n} step${n === 1 ? '' : 's'}${live ? ' · working…' : ''}</span>
    <span class="chev">${open ? '▾' : '▸'}</span></button><div class="activity-body"${open ? '' : ' hidden'}></div></div>`);
  const body = d.querySelector('.activity-body');
  const chev = d.querySelector('.chev');
  for (const g of groupSteps(steps)) {
    const cls = g.ok === true ? 'ok' : g.ok === false ? 'err' : '';
    const row = el(`<div class="activity-step ${cls}"><span>${esc(g.label)}${g.n > 1 ? `<span class="t">×${g.n}</span>` : ''}</span>${g.ms != null ? `<span class="t">${g.ms} ms</span>` : ''}</div>`);
    if (g.result) row.title = String(g.result).slice(0, 600);
    body.appendChild(row);
  }
  const head = d.querySelector('.activity-head');
  head.onclick = () => {
    body.hidden = !body.hidden;
    activityOpen.set(key, !body.hidden);
    chev.textContent = body.hidden ? '▸' : '▾';
    head.setAttribute('aria-expanded', String(!body.hidden));
  };
  return d;
}
function describeStep(s) {
  const name = s.name || 'step';
  if (/calculator|get_datetime|web_search|read_file|write_file|edit_file|search_files|project_files|shell_exec|ask_user|todo/.test(name)) {
    const nice = { calculator: 'Calculated', get_datetime: 'Checked time', web_search: 'Searched the web', read_file: 'Read a file', write_file: 'Wrote a file', edit_file: 'Edited a file', search_files: 'Searched files', project_files: 'Listed files', shell_exec: 'Ran a command', ask_user: 'Asked you a question', todo: 'Updated the task list' };
    const k = Object.keys(nice).find(k => name.includes(k));
    return (k ? nice[k] : 'Ran ' + name) + (s.ok === false ? ' — failed' : '');
  }
  if (name.startsWith('mcp__')) return 'Called MCP tool' + (s.ok === false ? ' — failed' : '');
  return (s.n ? `Step ${s.n} · ` : '') + name;
}

function toolLineNode(t) {
  const st = t.ok === true ? 'ok' : t.ok === false ? 'error' : 'running';
  const wrap = el(`<div></div>`);
  const b = el(`<button class="tool-line"><span class="status-dot ${st}"></span><span>${esc(t.name || 'tool')}</span><span style="opacity:.6">${t.ms != null ? t.ms + ' ms' : 'running…'}</span></button>`);
  const det = el(`<div class="tool-detail" hidden></div>`);
  det.textContent = String(t.result || '').slice(0, 2000);
  b.onclick = () => { det.hidden = !det.hidden; };
  wrap.appendChild(b); wrap.appendChild(det);
  return wrap;
}

function createLiveNode(s) {
  const wrap = el(`<div class="msg is-streaming"></div>`);
  const head = el(roleLine(s.modelLabel || 'Assistant', s.status || 'generating…'));
  const statusEl = head.querySelector('.role-meta');
  wrap.appendChild(head);
  const reasonSlot = el('<div></div>');
  const actSlot = el('<div></div>');
  const textSlot = el('<div></div>');
  const askSlot = el('<div></div>');
  const dots = el(`<div class="typing-row"><span class="typing-dots"><span></span><span></span><span></span></span></div>`);
  wrap.appendChild(reasonSlot); wrap.appendChild(actSlot); wrap.appendChild(textSlot); wrap.appendChild(askSlot); wrap.appendChild(dots);
  return { chatId: s.chatId, run: s, wrap, statusEl, reasonSlot, actSlot, textSlot, askSlot, dots, reason: null, act: null, actKey: '', askKey: '', md: null, blocks: [] };
}

function syncLive(s, state, api) {
  const L = live;
  if (!L) return;
  const compacting = /compact/i.test(s.status || '');
  L.statusEl.textContent = s.status || 'generating…';
  L.statusEl.style.color = compacting ? 'var(--amber)' : '';
  // reasoning (live, always visible while streaming)
  const showReason = !!(s.reasoning || s.statusAction === 'thinking');
  if (showReason) {
    if (!L.reason) { L.reason = reasoningNode(s.reasoning || '', true); L.reasonSlot.appendChild(L.reason); }
    L.reason._setText(s.reasoning || '');
    L.reasonSlot.style.display = '';
  } else if (L.reason) {
    L.reasonSlot.style.display = 'none';
  }
  // agent activity / tool cards
  const steps = [...(s.steps || [])];
  for (const tc of (s.toolCards || [])) {
    if (!steps.find(x => x.name === tc.name && x.result === tc.result)) steps.push({ name: tc.name, ok: tc.ok, result: tc.result, ms: tc.ms });
  }
  // agent questions (ask_user): rebuilt only when the question set or a
  // status changed, so text being typed into a card is never wiped.
  const questions = s.questions || [];
  const askKey = questions.map(q => q.id + ':' + (q.status || 'open')).join('|');
  if (L.askKey !== askKey) {
    L.askSlot.innerHTML = '';
    for (const q of questions) L.askSlot.appendChild(questionNode(q, { live: true, api }));
    L.askKey = askKey;
  }
  L.askSlot.style.display = questions.length ? '' : 'none';
  const key = JSON.stringify(steps.map(x => [x.name, x.ok, x.result ? String(x.result).slice(0, 60) : '', x.ms]));
  if (steps.length) {
    if (!L.act || L.actKey !== key) {
      // The fold state lives in activityNode, so a rebuild cannot reopen it.
      L.act = activityNode(steps, true, null, 'live:' + s.chatId);
      L.actSlot.innerHTML = '';
      L.actSlot.appendChild(L.act);
      L.actKey = key;
    }
    L.actSlot.style.display = '';
  } else {
    L.actSlot.style.display = 'none';
  }
  // streamed text: incremental markdown blocks
  if (s.text) {
    if (!L.md) { L.md = el('<div class="md"></div>'); L.textSlot.appendChild(L.md); }
    L.textSlot.style.display = '';
    L.dots.style.display = 'none';
    updateStreamText(L.md, s.text, L);
  } else {
    L.textSlot.style.display = 'none';
    L.dots.style.display = (!showReason && !steps.length && !questions.length) ? '' : 'none';
  }
  void state;
}

/* Split raw markdown into stable top-level chunks (paragraph groups and
 * fenced code, including a fence that is still open). Only chunks whose
 * source changed get re-rendered — everything else keeps its DOM. */
function splitBlocks(text) {
  const lines = String(text).split('\n');
  const out = [];
  let cur = [], inFence = false;
  for (const ln of lines) {
    if (inFence) {
      cur.push(ln);
      if (/^\s*```/.test(ln)) { inFence = false; out.push(cur.join('\n')); cur = []; }
      continue;
    }
    if (/^\s*```/.test(ln)) {
      if (cur.length) { out.push(cur.join('\n')); cur = []; }
      inFence = true; cur.push(ln);
      continue;
    }
    if (ln.trim() === '') { if (cur.length) { out.push(cur.join('\n')); cur = []; } continue; }
    cur.push(ln);
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

function updateStreamText(mdEl, text, L) {
  const blocks = splitBlocks(text);
  const kids = L.blocks;
  mdEl.querySelectorAll('.stream-caret').forEach(c => c.remove());
  for (let i = 0; i < blocks.length; i++) {
    const src = blocks[i];
    const k = kids[i];
    if (k && k.src === src) continue;
    const node = el(`<div class="blk"></div>`);
    node.innerHTML = renderMarkdown(src);
    bindCopyButtons(node);
    if (i === blocks.length - 1) attachCaret(node);
    if (k && k.node) mdEl.replaceChild(node, k.node);
    else mdEl.appendChild(node);
    kids[i] = { src, node };
  }
  for (let i = blocks.length; i < kids.length; i++) kids[i].node?.remove();
  kids.length = blocks.length;
}

function attachCaret(blockNode) {
  let host = blockNode;
  for (;;) {
    const last = host.lastElementChild;
    if (!last) break;
    if (last.tagName === 'PRE') break;
    host = (last.tagName === 'UL' || last.tagName === 'OL') ? last.lastElementChild || last : last;
    if (host.tagName === 'LI' || host.tagName === 'P' || /^[H][1-4]$/.test(host.tagName)) break;
  }
  host.appendChild(el('<span class="stream-caret"></span>'));
}
