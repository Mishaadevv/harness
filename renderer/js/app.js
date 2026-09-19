/* Zeqou Harness — app shell: routing, theme, quiet sidebar/topbar,
 * hero composer, drawers + popovers, send pipeline (unchanged engine). */
import { uid, now, esc, el, openModal, openMenu, closeMenu, toast, humanError, download, debounce, fmtTokens } from './utils.js';
import { store, activeProject } from './store.js';
import { providerById, allModels, modelRefOf, resolveModelRef, streamChat, guessCaps, providerSnapshot } from './providers.js';
import { enabledOpenAITools, executeTool, toolCapabilityLine } from './tools.js';
import { relevantMemories, memorySystemBlock, addMemory } from './memory.js';
import { runAgent, getWebConfig } from './agent.js';
import { contextUsage, knownContextFor, estimateTokens } from './context.js';
import { blankMcpServer, mcpLog, testServer, refreshTools } from './mcp.js';
import { renderChat } from './view-chat.js';
import { renderHistory, renderMemories, renderTools, renderMcp, renderModels, renderProjects, renderFiles, renderTasks } from './view-panels.js';
import { renderSettings } from './view-settings.js';

const $ = (s) => document.querySelector(s);
let settingsSub = 'general';
let attachments = [];
let streaming = null;                 // run attached to the VISIBLE chat (drives composer/stop button)
const runs = new Map();               // chatId -> live run (parallel chats supported)
const chatQueues = new Map();         // chatId -> [queued user texts]
let renderQueued = false;
let openDrawerKind = null;

const api = {
  get streaming() { return streaming; },
  runs,
  chatRuns: (id) => runs.has(id),
  update(fn, save) { store.update(fn, save !== false); },
  rerender() { renderAll(); },
  refreshCounts,
  syncComposer,
  goto(view, sub) {
    closeDrawer(); closePop();
    store.update(s => { s.view = view; });
    if (view === 'settings' && sub) settingsSub = sub;
    renderAll();
  },
  setMode(m) { setMode(m); },
  setModeAndFill(m, t) { setMode(m); store.update(s => { s.view = 'chat'; }); api.fillComposer(t); },
  fillComposer(t) { $('#composerInput').value = t; autosize(); $('#composerInput').focus(); },
  openChat(id) { store.update(s => { s.activeChatId = id; s.activeProjectId = s.chats.find(c => c.id === id)?.projectId || s.activeProjectId; s.view = 'chat'; }); bindVisibleRun(); renderAll(); },
  renameChat(id) { renameChat(id); },
  moveChat(id) { moveChat(id); },
  duplicateChat(id) { duplicateChat(id); },
  deleteChat(id) { deleteChat(id); },
  editTool(id, repaint) { editToolModal(id, repaint); },
  editMcp(id, repaint) { editMcpModal(id, repaint); },
  editProject(id, repaint) { editProjectModal(id, repaint); },
  async linkProjectFolder(projectId) {
    const dir = await window.zeqou.dialogs.openDirectory();
    if (!dir) return;
    store.update(s => { s.projects.find(x => x.id === projectId).localPath = dir; });
    toast('Folder linked', 'ok', 1800);
    renderAll();
  },
  unlinkProjectFolder(projectId) {
    store.update(s => { delete s.projects.find(x => x.id === projectId).localPath; });
    renderAll();
  },
  async addProject(repaint) {
    await openModal({
      title: 'New project', bodyHTML: `<div class="form-grid"><div class="field"><label>Name</label><input id="fName" placeholder="Website Redesign" /></div></div>`,
      actions: [{ label: 'Cancel', kind: 'secondary', onClick: c => c(null) }, {
        label: 'Create', onClick: (close, back) => {
          const name = back.querySelector('#fName').value.trim() || 'Untitled project';
          store.update(s => { const p = { id: uid('proj'), name, description: '', systemInstructions: '', models: [], tools: [], mcpServers: [], createdAt: now() }; s.projects.push(p); s.activeProjectId = p.id; });
          close(true); repaint && repaint();
        }
      }]
    });
  },
  async addProjectFile(projectId, repaint) {
    await openModal({
      title: 'New file', bodyHTML: `<div class="form-grid"><div class="field"><label>Path</label><input id="fP" placeholder="notes/todo.md" /></div>
        <div class="field"><label>Content</label><textarea id="fC" rows="5"></textarea></div></div>`,
      actions: [{ label: 'Cancel', kind: 'secondary', onClick: c => c(null) }, {
        label: 'Create', onClick: async (close, back) => {
          const p = back.querySelector('#fP').value.trim();
          if (!p) return;
          await window.zeqou.fs.write({ projectId, rel: p, text: back.querySelector('#fC').value, base: projectBase(projectId) });
          close(true); repaint && repaint(); toast('Created', 'ok', 1500);
        }
      }]
    });
  },
  async addProjectFolder(projectId, repaint) {
    await openModal({
      title: 'New folder', bodyHTML: `<div class="field"><label>Path</label><input id="fP" placeholder="docs/specs" /></div>`,
      actions: [{ label: 'Cancel', kind: 'secondary', onClick: c => c(null) }, {
        label: 'Create', onClick: async (close, back) => {
          const p = back.querySelector('#fP').value.trim();
          if (!p) return;
          await window.zeqou.fs.mkdir({ projectId, rel: p, base: projectBase(projectId) });
          close(true); repaint && repaint();
        }
      }]
    });
  },
  editApiKey(pid, cb) { editApiKeyModal(pid, cb); },
  editAgent(id, cb) { editAgentModal(id, cb); },
  pickModel() { openModelPicker(); },
  discoverAllModels,
  addModel,
  attachProjectFile,
  openToolsDrawer() { openDrawer('tools'); },
  openMcpDrawer() { openDrawer('mcp'); },
  rediscover() { autoDiscoverModels(true); },
  onEdit: editMessage,
  onRegenerate: regenerate,
  onContinue: continueFrom,
  onBranch: branchFrom,
  ensureContextFits
};

/* ================= BOOT ================= */
async function boot() {
  await store.load();
  if (!store.state.chats.length) store.newChat();
  if (!store.state.activeChatId) store.state.activeChatId = store.state.chats[0]?.id || null;
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
  bindShell();
  store.subscribe(() => { applyTheme(); bindVisibleRun(); renderAll(); if (openDrawerKind) paintDrawer(); });
  renderAll();
  syncComposer();
  // Auto-detect: connection, models and capabilities — no hardcoded models.
  autoDiscoverModels(true);
  // Reconnect MCP servers that were online.
  autoConnectMcp();
}
document.addEventListener('DOMContentLoaded', boot);

/* ================= AUTO-DISCOVERY =================
 * For every enabled provider that has what it needs (a saved key, or a
 * local endpoint needing none), fetch /models and register what answers.
 * Capabilities (vision / tools / reasoning) are inferred per model id. */
let discovering = false;
async function autoDiscoverModels(quiet = true) {
  if (discovering || !window.zeqou?.ai) return 0;
  discovering = true;
  let found = 0;
  try {
    for (const p of store.state.providers.filter(p => p.enabled)) {
      try {
        if (p.authMode !== 'none') {
          const h = await window.zeqou.secrets.has('provider:' + p.id);
          if (!h.has) continue;
        }
        const r = await window.zeqou.ai.listModels(providerSnapshot(p));
        if (!r.ok || !r.models?.length) continue;
        store.update(st => {
          const pp = providerById(st, p.id);
          if (!pp) return;
          const known = new Set((pp.models || []).map(m => m.modelId));
          for (const m of r.models) {
            if (known.has(m.id)) continue;
            pp.models.push({ id: uid('m'), providerId: pp.id, modelId: m.id, label: m.id, context: 0, caps: guessCaps(m.id), status: 'online' });
            found++;
          }
        }, false);
      } catch (_) {}
    }
    // Auto-pick the first thing that answered, so the composer just works.
    if (!store.state.composer.modelRef) {
      const all = allModels(store.state).filter(m => m.providerEnabled);
      if (all.length) {
        const ref = modelRefOf(all[0].providerId, all[0].modelId);
        store.update(st => { st.composer.modelRef = ref; }, false);
      }
    }
    store.saveNow();
    renderAll();
    if (found > 0 && !quiet) toast(`Detected ${found} model${found === 1 ? '' : 's'}`, 'ok', 2200);
  } finally { discovering = false; }
  return found;
}

/* ================= THEME ================= */
function effectiveTheme() {
  const t = store.state.theme || 'system';
  if (t !== 'system') return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme() {
  document.documentElement.dataset.theme = effectiveTheme();
}

/* ================= SHELL ================= */
function bindShell() {
  document.querySelectorAll('#mainNav .nav-item, .side-foot .nav-item').forEach(b => {
    b.onclick = () => { api.goto(b.dataset.view); if (window.innerWidth < 900) $('#app').classList.add('side-collapsed'); };
  });
  $('#btnNewChat').onclick = () => { if (streaming) switchChatKeepRuns(store.activeChatId); store.newChat(); attachments = []; syncComposer(); $('#composerInput').focus(); };
  $('#btnCollapse').onclick = () => $('#app').classList.toggle('side-collapsed');
  $('#btnSide').onclick = () => $('#app').classList.toggle('side-collapsed');
  $('#projectBtn').onclick = projectMenu;
  $('#modeChat').onclick = () => setMode('chat');
  $('#modeAgent').onclick = () => setMode('agent');
  $('#btnMemoryToggle').onclick = memoryPop;
  $('#btnMore').onclick = moreMenu;
  const input = $('#composerInput');
  input.addEventListener('input', () => { autosize(); refreshComposerGlow(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
    if (e.key === 'Escape' && streaming) stopGeneration();
  });
  wireChatToggles();
  $('#btnSend').onclick = () => (streaming ? stopGeneration() : sendCurrent());
  $('#pillModel').onclick = openModelPicker;
  $('#pillAgent').onclick = agentMenu;
  $('#btnAttach').onclick = plusMenu;
  $('#toBottom').onclick = () => $('#contentScroll').scrollTo({ top: $('#contentScroll').scrollHeight, behavior: 'smooth' });
  $('#contentScroll').addEventListener('scroll', () => {
    const sc = $('#contentScroll');
    const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 220;
    $('#toBottom').classList.toggle('show', !nearBottom && store.state.view === 'chat');
  }, { passive: true });
  const comp = $('#composer');
  ['dragenter', 'dragover'].forEach(ev => comp.addEventListener(ev, (e) => { e.preventDefault(); comp.classList.add('drag'); $('#dropHint').hidden = false; }));
  ['dragleave', 'drop'].forEach(ev => comp.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop') handleDrop(e); comp.classList.remove('drag'); $('#dropHint').hidden = true; }));
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#btnNewChat').click(); }
    if (mod && e.key === '/') { e.preventDefault(); $('#app').classList.toggle('side-collapsed'); }
    if (e.key === 'Escape') { closeDrawer(); closePop(); closeMenu(); }
  });
  if (window.innerWidth < 900) $('#app').classList.add('side-collapsed');
}
function wireChatToggles() {
  // Chat toggles now act on the ACTIVE CHAT (per-chat parallel chats),
  // falling back to composer defaults for chats without explicit state.
  const setToggle = (key, on) => store.update(s => {
    const c = s.chats.find(x => x.id === s.activeChatId);
    if (!c) { s.composer[key] = on; return; }
    c[key] = on;
    if (c[key + 'Touched'] === undefined) c[key + 'Touched'] = true;
  });
  $('#tglTools').onclick = () => setToggle('toolsOn', !(store.activeChat ? store.activeChat.toolsOn : store.state.composer.toolsOn));
  $('#tglMcp').onclick = () => setToggle('mcpOn', !(store.activeChat ? store.activeChat.mcpOn : store.state.composer.mcpOn));
  $('#tglWeb').onclick = () => setToggle('webOn', !(store.activeChat ? store.activeChat.webOn : store.state.composer.webOn));
}
function setMode(m) {
  store.update(s => { s.mode = m; const c = s.chats.find(x => x.id === s.activeChatId); if (c) c.mode = m; });
  $('#modeChat').classList.toggle('active', m === 'chat');
  $('#modeAgent').classList.toggle('active', m === 'agent');
  $('#pillAgent').style.display = m === 'agent' ? '' : 'none';
}
function autosize() {
  const i = $('#composerInput');
  i.style.height = 'auto';
  i.style.height = Math.min(180, i.scrollHeight) + 'px';
}

/* Keep `streaming` + composer bound to the run of the VISIBLE chat. */
function bindVisibleRun() {
  const id = store.state.activeChatId;
  const run = id ? runs.get(id) : null;
  const changed = streaming !== run;
  streaming = run || null;
  if (changed) { updateSendBtn(); updateRunChip(); }
}
/* Paint scheduling: per-run throttle, immediate when the chat is visible. */
const runPaintT = new Map();
function scheduleRunPaint(run) {
  const vis = run.chatId === store.state.activeChatId;
  if (vis) { queueRerenderChat(); updateCtxRing(); }
  if (runPaintT.has(run.chatId)) return;
  runPaintT.set(run.chatId, setTimeout(() => {
    runPaintT.delete(run.chatId);
    if (runs.get(run.chatId) === run) {
      updateRunChip();
      if (store.state.view === 'history') renderAll();
    }
  }, 700));
}
/* ================= RENDER ================= */
function renderAll() {
  const s = store.state;
  document.querySelectorAll('.nav-item[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === s.view));
  const chat = s.chats.find(c => c.id === s.activeChatId);
  const proj = activeProject(s);
  $('#projectBtnLabel').textContent = proj ? proj.name : 'Workspace';
  const cm = chat?.mode || s.mode;
  $('#modeChat').classList.toggle('active', cm === 'chat');
  $('#modeAgent').classList.toggle('active', cm === 'agent');
  $('#pillAgent').style.display = cm === 'agent' ? '' : 'none';
  const memOff = chat && chat.memoryOn === false;
  $('#memToggleLabel').textContent = memOff ? 'Memory off' : 'Memory on';
  $('#btnMemoryToggle').classList.toggle('on', !memOff);
  $('#composerWrap').style.display = s.view === 'chat' ? '' : 'none';
  const views = ['chat', 'history', 'tasks', 'memories', 'tools', 'mcp', 'models', 'projects', 'files', 'settings'];
  for (const v of views) {
    const sec = $('#view-' + v);
    const on = s.view === v;
    sec.hidden = !on;
    if (on) {
      if (v === 'chat') renderChat(sec, s, api);
      else if (v === 'history') renderHistory(sec, s, api);
      else if (v === 'tasks') renderTasks(sec, s, api);
      else if (v === 'memories') renderMemories(sec, s, api);
      else if (v === 'tools') renderTools(sec, s, api);
      else if (v === 'mcp') renderMcp(sec, s, api);
      else if (v === 'models') renderModels(sec, s, api);
      else if (v === 'projects') renderProjects(sec, s, api);
      else if (v === 'files') renderFiles(sec, s, api);
      else if (v === 'settings') renderSettings(sec, s, api, settingsSub);
    }
  }
  if (s.view === 'chat') scrollBottom(false);
  refreshCounts();
  updateCtxRing();
  updateRunChip();
  syncComposer();
  updateSendBtn();
}
/* Run chip in the topbar: other chats generating in the background. */
function updateRunChip() {
  const chip = $('#runChip');
  if (!chip) return;
  const s = store.state;
  const others = [...runs.values()].filter(r => r.chatId !== s.activeChatId);
  chip.hidden = !others.length;
  chip.innerHTML = others.slice(0, 3).map(r => {
    const ch = s.chats.find(c => c.id === r.chatId);
    return `<span class="run-pill" data-id="${esc(r.chatId)}" title="${esc((ch?.title || 'Chat') + ' — ' + (r.status || 'running'))}"><span class="run-pulse"></span>${esc((ch?.title || 'Chat').slice(0, 22))}</span>`;
  }).join('') + (others.length > 3 ? `<span class="run-pill muted">+${others.length - 3}</span>` : '');
  chip.querySelectorAll('.run-pill[data-id]').forEach(p => {
    p.onclick = () => api.openChat(p.dataset.id);
  });
}
function switchChatKeepRuns(chatId) {
  // Deliberately leave the old run alive in the background: parallel chats.
  store.update(s => { s.activeChatId = chatId; s.view = 'chat'; });
  renderAll();
}
function refreshCounts() {
  const s = store.state;
  $('#dotMcp')?.classList.toggle('on', s.mcpServers.some(m => m.enabled && m.status === 'online'));
  refreshTaskDot();
}
/* Sidebar dot on Tasks: lit while the agent has work in progress. */
function refreshTaskDot() {
  const s = store.state;
  const doing = (s.tasks || []).some(t => t.status === 'doing');
  const open = (s.tasks || []).some(t => t.status !== 'done');
  const dot = $('#dotTasks');
  if (dot) { dot.classList.toggle('on', doing); dot.title = doing ? 'The agent is working on a task' : open ? 'Open tasks' : ''; }
}
/* Context-usage ring in the composer: % of the model's context in use. */
function updateCtxRing() {
  const ring = $('#ctxRing');
  if (!ring) return;
  const u = contextUsage(store.state, streaming ? (streaming.text || '') : '');
  const fg = $('#ctxRingFg');
  const num = $('#ctxRingNum');
  const C = 2 * Math.PI * 7.5; // circumference of r=7.5
  const pct = u.limit ? Math.round(u.ratio * 100) : 0;
  fg.style.strokeDashoffset = String(u.limit ? C * (1 - u.ratio) : C);
  num.textContent = u.limit ? (pct >= 100 ? '!' : pct) : '∞';
  ring.classList.toggle('warn', u.limit && u.ratio >= 0.7 && u.ratio < 0.9);
  ring.classList.toggle('full', u.limit && u.ratio >= 0.9);
  const tip = u.limit
    ? `Context: ~${u.label} tokens (${pct}%) · ${u.modelId || 'model'}${u.compacted ? '\nOlder turns folded into a compact summary.' : ''}\nThe model can compact context itself (compact_context); auto-compaction runs near the limit.`
    : `Context: ~${u.label} tokens\nUnknown context window for this model — set it in Models → Add.`;
  ring.title = tip;
}
window.__ctxDetails = () => {
  const u = contextUsage(store.state);
  return u;
};
function syncComposer() {
  const s = store.state;
  const chat = s.chats.find(c => c.id === s.activeChatId);
  const ref = chat?.modelRef || s.composer.modelRef;
  const found = ref ? resolveModelRef(s, ref) : null;
  const lbl = found ? (found.model.label || found.model.modelId) : 'Select model';
  $('#pillModelLabel').textContent = lbl;
  $('#pillModel').title = found ? `${lbl} — click to change model` : 'Select model';
  $('#modelLiveDot').style.display = found && found.provider.enabled ? '' : 'none';
  const ag = s.agents.find(a => a.id === (chat?.agentId || s.activeAgentId)) || s.agents[0];
  $('#pillAgentLabel').textContent = ag?.name || 'Agent';
  const tState = (k) => !!(chat ? chat[k] : s.composer[k]);
  $('#tglTools').classList.toggle('on', tState('toolsOn'));
  $('#tglMcp').classList.toggle('on', tState('mcpOn'));
  $('#tglWeb').classList.toggle('on', tState('webOn'));
  const bar = $('#attachBar');
  bar.hidden = !attachments.length;
  bar.innerHTML = '';
  for (const a of attachments) {
    const p = el(`<span class="attach-pill">${a.kind === 'image' && a.dataUrl ? `<img src="${a.dataUrl}" alt="" />` : '📄'}<span>${esc(a.name)}</span><button title="Remove">×</button></span>`);
    p.querySelector('button').onclick = () => { attachments = attachments.filter(x => x.id !== a.id); syncComposer(); };
    bar.appendChild(p);
  }
  updateSendBtn();
}
function updateSendBtn() {
  const btn = $('#btnSend');
  btn.classList.toggle('stop', !!streaming);
  if (!streaming) btn.classList.toggle('ready', !!$('#composerInput').value.trim() || attachments.length > 0);
  else btn.classList.remove('ready');
  $('#sendIcon').style.display = streaming ? 'none' : '';
  $('#stopIcon').style.display = streaming ? '' : 'none';
  btn.title = streaming ? 'Stop' : 'Send';
  refreshComposerGlow();
}
function refreshComposerGlow() {
  const comp = $('#composer');
  if (!comp) return;
  comp.classList.toggle('typing', !!$('#composerInput').value.trim() && !streaming);
  comp.classList.toggle('streaming', !!streaming);
}
function scrollBottom(smooth = true) {
  requestAnimationFrame(() => {
    const sc = $('#contentScroll');
    // while streaming, don't yank the user away from history they are reading
    if (streaming && sc.scrollHeight - sc.scrollTop - sc.clientHeight > 220) return;
    sc.scrollTo({ top: sc.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  });
}
function queueRerenderChat() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    if (store.state.view !== 'chat') return;
    renderChat($('#view-chat'), store.state, api);
    updateCtxRing();
    updateSendBtn();
    scrollBottom(false);
  }, 110);
}

/* ================= MENUS / PICKERS ================= */
function projectMenu() {
  const s = store.state;
  const r = $('#projectBtn').getBoundingClientRect();
  openMenu(r.left, r.bottom + 6, [
    ...s.projects.map(p => ({
      label: p.name, checked: s.activeProjectId === p.id,
      onClick: () => store.update(st => { st.activeProjectId = p.id; const c = st.chats.find(x => x.projectId === p.id && !x.archived); if (st.view === 'chat') st.activeChatId = c ? c.id : st.activeChatId; })
    })),
    { sep: true },
    { label: 'Open folder as project…', onClick: addProjectFromFolder },
    { label: 'Manage projects…', onClick: () => api.goto('projects') }
  ]);
}
/* Pick any folder on the computer and make it a project (chat + files live there). */
async function addProjectFromFolder() {
  const dir = await window.zeqou.dialogs.openDirectory();
  if (!dir) return;
  const name = dir.split(/[\\/]/).filter(Boolean).pop() || 'Project';
  store.update(s => {
    const p = { id: uid('proj'), name, description: '', systemInstructions: '', localPath: dir, models: [], tools: [], mcpServers: [], createdAt: now() };
    s.projects.push(p);
    s.activeProjectId = p.id;
  });
  toast('Project linked: ' + name, 'ok', 2200);
  renderAll();
}
function moreMenu() {
  const c = store.activeChat;
  const r = $('#btnMore').getBoundingClientRect();
  const items = [];
  if (c) {
    items.push(
      { label: 'Rename', onClick: () => renameChat(c.id) },
      { label: c.pinned ? 'Unpin' : 'Pin', onClick: () => store.update(s => { s.chats.find(x => x.id === c.id).pinned = !c.pinned; }) },
      { label: c.archived ? 'Unarchive' : 'Archive', onClick: () => store.update(s => { s.chats.find(x => x.id === c.id).archived = !c.archived; }) },
      { label: 'Duplicate', onClick: () => duplicateChat(c.id) },
      { label: 'Export (.md)', onClick: exportChat },
      { sep: true }
    );
  }
  const th = store.state.theme || 'system';
  for (const [v, label] of [['system', 'Appearance: System'], ['dark', 'Appearance: Dark'], ['light', 'Appearance: Light']]) {
    items.push({ label, checked: th === v, onClick: () => store.update(s => { s.theme = v; }) });
  }
  if (c) {
    items.push({ sep: true });
    items.push({ label: 'Delete conversation', danger: true, onClick: () => deleteChat(c.id) });
  }
  openMenu(r.left - 190, r.bottom + 6, items);
}
function plusMenu() {
  const r = $('#btnAttach').getBoundingClientRect();
  const crect = $('#composer').getBoundingClientRect();
  openMenu(crect.left + 8, crect.top - 178, [
    { label: 'Attach files', onClick: attachViaDialog },
    { label: 'Attach from project', onClick: () => api.goto('files') },
    { sep: true },
    { label: 'Browse tools…', onClick: () => openDrawer('tools') },
    { label: 'MCP servers…', onClick: () => openDrawer('mcp') }
  ]);
  void r;
}
function agentMenu() {
  const s = store.state;
  const r = $('#pillAgent').getBoundingClientRect();
  openMenu(r.left, r.top - s.agents.length * 34 - 70, [
    ...s.agents.map(a => ({ label: a.name, checked: s.activeAgentId === a.id, onClick: () => store.update(st => { st.activeAgentId = a.id; }) })),
    { sep: true },
    { label: 'Manage agents…', onClick: () => api.goto('settings', 'general') }
  ]);
}
async function openModelPicker() {
  const s = store.state;
  const models = allModels(s).filter(m => m.providerEnabled);
  const byProv = new Map();
  for (const m of models) {
    if (!byProv.has(m.providerName)) byProv.set(m.providerName, []);
    byProv.get(m.providerName).push(m);
  }
  // Render ALL models (providers like OpenRouter expose hundreds; a cap here
  // hid e.g. ":free" variants — they were visible in Settings but unpickable).
  const groupsHTML = (list) => [...byProv.entries()].map(([prov, all]) => {
    const l = list ? all.filter(list) : all;
    if (!l.length) return '';
    return `<div class="model-group">${esc(prov)}</div>` + l.map(m => {
      const ref = modelRefOf(m.providerId, m.modelId);
      return `<button class="model-opt" data-ref="${esc(ref)}"><span class="grow">${esc(m.label || m.modelId)}<br/><span class="sub">${m.context ? (m.context / 1000) + 'k context' : esc(m.modelId)}</span></span>${s.composer.modelRef === ref ? '<span class="check">✓</span>' : ''}</button>`;
    }).join('');
  }).join('') || '<p class="muted">No models from enabled providers.</p>';
  const modalDone = openModal({
    title: 'Select model',
    sub: `${models.length} models from enabled providers. Manage everything in Settings → Providers.`,
    bodyHTML: `<input class="search" id="mpSearch" placeholder="Search models…" /><div class="model-pick" id="mpList">${groupsHTML()}</div>`,
    actions: [
      { label: 'Manage providers', kind: 'secondary', small: true, onClick: (close) => { close(null); api.goto('settings', 'providers'); } },
      { label: 'Done', kind: 'secondary', onClick: c => c(null) }
    ]
  });
  // wire while the modal is open (openModal appends synchronously)
  const list = document.querySelector('#mpList');
  if (list) {
    // Data-driven search: re-render from the full catalog so any model is
    // reachable, then one delegated click handler covers re-renders.
    document.querySelector('#mpSearch')?.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      list.innerHTML = groupsHTML(q ? (m) => `${m.label || ''} ${m.modelId} ${m.providerName}`.toLowerCase().includes(q) : null);
    });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('.model-opt');
      if (!b) return;
      const ref = b.dataset.ref;
      store.update(st => { st.composer.modelRef = ref; const c = st.chats.find(x => x.id === st.activeChatId); if (c) c.modelRef = ref; });
      ensureContextFits(store.state.activeChatId);
      document.querySelector('.modal-back')?.remove();
      try { modalDone.then(() => {}); } catch (_) {}
      const mb = $('#pillModel');
      mb.classList.remove('flash'); void mb.offsetWidth; mb.classList.add('flash');
      setTimeout(() => mb.classList.remove('flash'), 750);
    });
  }
  await modalDone;
}

/* ================= DRAWER (tools / mcp) ================= */
function openDrawer(kind) {
  openDrawerKind = kind;
  paintDrawer();
}
function closeDrawer() {
  openDrawerKind = null;
  $('#drawerRoot').innerHTML = '';
}
function paintDrawer() {
  const s = store.state;
  const root = $('#drawerRoot');
  const isTools = openDrawerKind === 'tools';
  const q = root.querySelector('.drawer-search')?.value || '';
  root.innerHTML = `<div class="drawer-scrim"></div>
    <div class="drawer" role="dialog">
      <div class="drawer-head"><h3>${isTools ? 'Tools' : 'MCP servers'}</h3>
        <button class="link" id="drManage">${isTools ? 'Manage' : 'Manage'}</button>
        <button class="icon-btn" id="drClose">✕</button></div>
      ${isTools ? '<input class="drawer-search" placeholder="Search tools…" />' : ''}
      <div class="drawer-body"></div>
    </div>`;
  root.querySelector('.drawer-scrim').onclick = closeDrawer;
  root.querySelector('#drClose').onclick = closeDrawer;
  root.querySelector('#drManage').onclick = () => { closeDrawer(); api.goto(isTools ? 'tools' : 'mcp'); };
  const search = root.querySelector('.drawer-search');
  if (search) { search.value = q; search.oninput = () => paintRows(search.value); }
  paintRows(q);
  if (search) { search.focus(); }
  function paintRows(query) {
    const body = root.querySelector('.drawer-body');
    body.innerHTML = '';
    if (isTools) {
      const list = s.tools.filter(t => !query || (t.name + t.description).toLowerCase().includes(query.toLowerCase()));
      if (!list.length) body.innerHTML = '<p class="muted" style="padding:8px">No tools match.</p>';
      for (const t of list) {
        const row = el(`<div class="drawer-row"><div class="grow"><div class="t">${esc(t.name)}</div><div class="s">${esc((t.description || '').slice(0, 80))}</div></div></div>`);
        const sw = el(`<label class="switch"><input type="checkbox" ${t.enabled ? 'checked' : ''} /><span class="track"></span><span class="thumb"></span></label>`);
        sw.querySelector('input').onchange = (e) => store.update(st => { st.tools.find(x => x.id === t.id).enabled = e.target.checked; });
        row.appendChild(sw);
        body.appendChild(row);
      }
      const n = s.tools.filter(t => t.enabled).length;
      body.appendChild(el(`<p class="muted" style="padding:10px 8px">${n} enabled</p>`));
    } else {
      if (!s.mcpServers.length) body.innerHTML = '<p class="muted" style="padding:8px">No servers yet. Open the manager to add one.</p>';
      for (const sv of s.mcpServers) {
        const dot = sv.status === 'online' ? 'ok' : sv.status === 'connecting' ? 'running' : sv.status === 'error' ? 'error' : '';
        const row = el(`<div class="drawer-row"><span class="status-dot ${dot}"></span><div class="grow"><div class="t">${esc(sv.name)}</div><div class="s">${esc(sv.status)} · ${(sv.tools || []).length} tools</div></div></div>`);
        const btn = el(`<button class="mini-btn">${sv.status === 'online' ? 'Refresh' : 'Connect'}</button>`);
        btn.onclick = async () => {
          btn.textContent = '…';
          sv.status = 'connecting'; paintRows(query);
          const r = await testServer(sv);
          if (r.ok) await refreshTools(sv);
          store.update(st => {});
          toast(r.ok ? `${sv.name} connected` : 'Connection failed', r.ok ? 'ok' : 'err');
        };
        row.appendChild(btn);
        const sw = el(`<label class="switch" title="Enable"><input type="checkbox" ${sv.enabled ? 'checked' : ''} /><span class="track"></span><span class="thumb"></span></label>`);
        sw.querySelector('input').onchange = (e) => store.update(st => { st.mcpServers.find(x => x.id === sv.id).enabled = e.target.checked; });
        row.appendChild(sw);
        body.appendChild(row);
      }
    }
  }
}

/* ================= MEMORY POPOVER ================= */
function closePop() { $('#popRoot').innerHTML = ''; }
function memoryPop() {
  const root = $('#popRoot');
  if (root.innerHTML) { closePop(); return; }
  const s = store.state;
  const chat = s.chats.find(c => c.id === s.activeChatId);
  const r = $('#btnMemoryToggle').getBoundingClientRect();
  const pop = el(`<div class="pop">
    <h4>Memory</h4><div class="muted">${s.memories.length} stored</div>
    <div class="pop-row"><span style="flex:1">Use memory in this chat</span>
      <label class="switch"><input type="checkbox" id="ppSw" ${chat && chat.memoryOn === false ? '' : 'checked'} /><span class="track"></span><span class="thumb"></span></label></div>
    <div class="pop-row"><button class="mini-btn" id="ppAdd">＋ Add memory</button>
      <button class="mini-btn" id="ppOpen" style="margin-left:auto">Open all →</button></div>
  </div>`);
  pop.style.top = (r.bottom + 8) + 'px';
  pop.style.right = Math.max(12, window.innerWidth - r.right) + 'px';
  root.appendChild(pop);
  pop.querySelector('#ppSw').onchange = (e) => {
    if (!chat) return;
    store.update(st => { st.chats.find(x => x.id === chat.id).memoryOn = e.target.checked; });
  };
  pop.querySelector('#ppAdd').onclick = async () => {
    closePop();
    await openModal({
      title: 'Add memory', bodyHTML: `<div class="field"><textarea id="mT" rows="3" placeholder="e.g. Prefers concise answers with code first"></textarea></div>`,
      actions: [{ label: 'Cancel', kind: 'secondary', onClick: c => c(null) }, {
        label: 'Add', onClick: (close, back) => {
          const t = back.querySelector('#mT').value.trim();
          if (!t) return;
          store.update(st => { addMemory(st, { text: t, tags: [], projectId: st.activeProjectId }); });
          close(true); toast('Memory added', 'ok', 1800);
        }
      }]
    });
  };
  pop.querySelector('#ppOpen').onclick = () => { closePop(); api.goto('memories'); };
  setTimeout(() => document.addEventListener('mousedown', popOutside), 0);
}
function popOutside(e) {
  const p = document.querySelector('#popRoot .pop');
  if (p && !p.contains(e.target) && e.target.id !== 'btnMemoryToggle' && !$('#btnMemoryToggle').contains(e.target)) {
    closePop();
    document.removeEventListener('mousedown', popOutside);
  }
}

/* ================= MCP AUTO-CONNECT ================= */
async function autoConnectMcp() {
  const servers = store.state.mcpServers.filter(s => s.enabled && s.autoConnect !== false);
  if (!servers.length || !window.zeqou?.mcp) return;
  for (const sv of servers) {
    try {
      sv.status = 'connecting';
      const r = await testServer(sv);
      if (r.ok) await refreshTools(sv);
    } catch (_) {}
  }
  store.saveNow();
  renderAll();
  if (openDrawerKind) paintDrawer();
}

/* ================= ATTACHMENTS ================= */
async function attachViaDialog() {
  const files = await window.zeqou.dialogs.openFiles();
  for (const f of files) {
    const r = await window.zeqou.dialogs.readFileBuffer(f.path);
    if (!r.ok) { toast(r.error || 'Cannot read file', 'err'); continue; }
    pushAttachment({ name: r.name || f.name, base64: r.base64, size: f.size });
  }
  syncComposer();
}
async function handleDrop(e) {
  const files = [...(e.dataTransfer?.files || [])];
  for (const f of files.slice(0, 8)) {
    if (f.size > 8 * 1024 * 1024) { toast(`"${f.name}" is larger than 8 MB`, 'err'); continue; }
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
    pushAttachment({ name: f.name, base64: btoa(bin), size: f.size, mime: f.type });
  }
  syncComposer();
}
function pushAttachment({ name, base64, size, mime }) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const isImg = (mime && mime.startsWith('image/')) || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
  if (isImg) {
    const mt = mime || (ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
    attachments.push({ id: uid('a'), name, size, kind: 'image', dataUrl: `data:${mt};base64,${base64}` });
  } else {
    let text = '';
    try {
      const bin = atob(base64.slice(0, 400000));
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).slice(0, 12000);
    } catch { text = ''; }
    attachments.push({ id: uid('a'), name, size, kind: text ? 'text' : 'file', text, base64: text ? undefined : base64.slice(0, 200000) });
  }
}
async function attachProjectFile(projectId, fileRel) {
  const r = await window.zeqou.fs.read({ projectId, rel: fileRel, base: projectBase(projectId) });
  if (!r.ok) return toast(r.error, 'err');
  const name = fileRel.split('/').pop();
  if (r.kind === 'image') attachments.push({ id: uid('a'), name, size: 0, kind: 'image', dataUrl: `data:image/png;base64,${r.base64}` });
  else attachments.push({ id: uid('a'), name, size: r.text.length, kind: 'text', text: r.text.slice(0, 12000) });
  store.update(s => { s.view = 'chat'; });
  syncComposer();
  toast(`Attached ${name}`, 'ok', 1800);
}

/* ================= SEND PIPELINE ================= */
/* Dangerous tools (shell) always ask first — unless auto-approve is on
 * in Agent mode. Denials are reported back to the model. */
async function confirmToolUse(name, args) {
  const def = store.state.tools.find(t => t.name === name);
  if (!def || def.permissions !== 'danger') return true;
  if (store.state.settings.agentAutoApprove && store.state.mode === 'agent') return true;
  const ok = await openModal({
    title: `Run “${name}”?`, sub: 'This tool can change your system. Review the arguments.',
    bodyHTML: `<div class="code-inline">${esc(JSON.stringify(args, null, 2).slice(0, 2000))}</div>`,
    actions: [{ label: 'Deny', kind: 'secondary', onClick: c => c(false) }, { label: 'Run', onClick: c => c(true) }]
  });
  return !!ok;
}
function projectBase(projectId) {
  const p = store.state.projects.find(x => x.id === (projectId || store.state.activeProjectId));
  return p?.localPath || null;
}
function ensureChat() {
  let c = store.activeChat;
  if (!c) c = store.newChat();
  return c;
}
function resolveActiveModel() {
  const s = store.state;
  const chat = s.chats.find(c => c.id === s.activeChatId);
  let ref = chat?.modelRef || s.composer.modelRef;
  let r = ref ? resolveModelRef(s, ref) : null;
  if (!r || !r.provider.enabled) {
    const all = allModels(s).filter(m => m.providerEnabled);
    if (all.length) {
      r = { provider: providerById(s, all[0].providerId), model: all[0] };
      ref = modelRefOf(all[0].providerId, all[0].modelId);
    }
  }
  return r ? { ...r, ref } : null;
}
async function sendCurrent(prefill) {
  const text = (prefill ?? $('#composerInput').value).trim();
  if (!text && !attachments.length) return;
  // The composer is attached to the visible chat; a run there is still ours to feed —
  // queue the text. Switching away + send starts a PARALLEL run in another chat.
  const chat = ensureChat();
  if (streaming && streaming.chatId === chat.id) {
    chatQueues.set(chat.id, (chatQueues.get(chat.id) || []).concat(text));
    toast('Queued for this chat — it will be sent after the current answer', 'info', 2200);
    $('#composerInput').value = '';
    autosize(); syncComposer(); updateSendBtn();
    return;
  }
  const current = [...attachments];
  attachments = [];
  $('#composerInput').value = '';
  autosize(); syncComposer(); updateSendBtn();
  await sendUser(chat.id, text || '(see attachments)', current);
}
async function sendUser(chatId, text, atts) {
  store.update(s => {
    const c = s.chats.find(x => x.id === chatId);
    c.messages.push({ id: uid('m'), role: 'user', content: text, attachments: atts, at: now() });
    c.updatedAt = now();
    if ((c.title === 'New conversation' || !c.title) && text) c.title = text.slice(0, 52);
  });
  renderAll();
  await generate(chatId);
}
async function buildMessages(chat, extraSystem = '') {
  const s = store.state;
  const mems = relevantMemories(s, chat, chat.messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '');
  for (const m of mems) m.useCount = (m.useCount || 0) + 1;
  const proj = s.projects.find(p => p.id === chat.projectId);
  const sys = [
    'You are Zeqou, a precise senior engineering assistant inside Zeqou Harness. Be helpful, concise and honest. Format with Markdown when it helps.',
    toolCapabilityLine(s, chat),
    proj?.systemInstructions ? `Project instructions:\n${proj.systemInstructions}` : '',
    mems.length ? memorySystemBlock(mems) : '',
    extraSystem
  ].filter(Boolean).join('\n\n');
  const budget = Math.max(4000, chatLimit(s, chat));
  const comp = chat.compaction;
  const msgs = chat.messages.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool');
  const idx = comp?.uptoId ? msgs.findIndex(m => m.id === comp.uptoId) : -1;
  const start = idx >= 0 ? idx + 1 : 0; // everything before this is folded into the summary
  const hist = [];
  let used = sys.length + (idx >= 0 ? estimateTokens(comp.summary) : 0);
  for (let i = msgs.length - 1; i >= start; i--) {
    const m = msgs[i];
    if (m._hidden) continue;
    const c = toProviderContent(m);
    const len = JSON.stringify(c).length;
    if (used + len > budget && hist.length > 2) break;
    used += len;
    hist.unshift({ role: m.role === 'tool' ? 'tool' : m.role, content: c });
  }
  const clean = hist.filter((m, i) => m.role !== 'tool' || (m.content && i > 0));
  const pre = idx >= 0 ? [{ role: 'user', content: '[Summary of the earlier part of this conversation]\n' + comp.summary + '\n[End of summary. Continue naturally.]' }] : [];
  return { messages: [{ role: 'system', content: sys }, ...pre, ...clean.map(m => ({ role: m.role, content: m.content }))], mems };
}
function toProviderContent(m) {
  if (m.role !== 'user' || !m.attachments?.length) return m.content || '';
  const parts = [{ type: 'text', text: m.content || '' }];
  for (const a of m.attachments) {
    if (a.kind === 'image' && a.dataUrl) parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
    else if (a.kind === 'text' && a.text) parts.push({ type: 'text', text: `\n\nFile ${a.name}:\n\`\`\`\n${a.text.slice(0, 6000)}\n\`\`\`` });
    else parts.push({ type: 'text', text: `\n\n[attached file: ${a.name}]` });
  }
  return parts;
}

/* ================= GENERATION (parallel) =================
 * Every chat runs independently: `runs` maps chatId -> live run object.
 * `streaming` mirrors the run of the VISIBLE chat so the composer, stop
 * button and ctx ring behave as before. Switching chats re-binds them. */
async function generate(chatId, attempt = 1) {
  const chat = store.state.chats.find(c => c.id === chatId);
  if (!chat || runs.has(chatId)) return;
  const mdl = resolveActiveModel();
  if (!mdl) {
    toast('Select a model first — open Providers to connect one', 'err');
    api.goto('settings', 'providers');
    return;
  }
  const keyCheck = mdl.provider.authMode !== 'none' ? await window.zeqou.secrets.has('provider:' + mdl.provider.id) : { has: true };
  if (!keyCheck.has) {
    toast(`Save an API key for ${mdl.provider.name} first`, 'err');
    editApiKeyModal(mdl.provider.id);
    return;
  }
  const abortCtrl = new AbortController();
  const modelLabel = mdl.model.label || mdl.model.modelId;
  const run = {
    chatId, modelLabel, text: '', reasoning: '', toolCards: [], steps: [],
    status: (chat.mode || store.state.mode) === 'agent' ? 'Agent starting…' : 'Contacting model…',
    startedAt: Date.now(), abortCtrl
  };
  runs.set(chatId, run);
  bindVisibleRun();
  queueRerenderChat(); updateSendBtn();
  try {
    if ((chat.mode || store.state.mode) === 'agent') await generateAgent(chat, mdl, run);
    else await generateChat(chat, mdl, run);
  } catch (e) {
    if (e?.name === 'AbortError') { run.status = 'Stopped'; }
    else {
      console.error(e);
      if (store.state.settings.retryOnFail && attempt === 1 && !abortCtrl.signal.aborted && /network|fetch|timeout|500|502|503|529/i.test(e.message || '')) {
        run.status = 'Retrying…';
        await new Promise(r => setTimeout(r, 1200));
        runs.delete(chatId);
        bindVisibleRun();
        return generate(chatId, 2);
      }
      run.status = 'Failed';
      toast(humanError(e), 'err', 5000);
    }
  } finally {
    const q = chatQueues.get(chatId) || [];
    const failed = run.status === 'Failed' || run.status === 'Stopped';
    // Keep whatever the model managed to stream before a failure or a stop —
    // losing half a good answer hurts more than an imperfect one.
    const partialText = failed ? (run.text || '').trim() : '';
    const partialMeta = {
      reasoning: run.reasoning || '', steps: run.steps || [],
      toolCalls: (run.toolCards || []).map(t => ({ name: t.name, args: t.args, ok: t.ok, result: t.result, ms: t.ms }))
    };
    // Only remove OUR run: on the auto-retry path a new run for this chat
    // may already be registered — deleting it would orphan the live stream.
    if (runs.get(chatId) === run) runs.delete(chatId);
    bindVisibleRun();
    if (partialText) {
      const note = run.status === 'Stopped'
        ? '\n\n_(stopped — answer may be incomplete)_'
        : '\n\n_(generation failed — partial answer kept)_';
      saveAssistant(chatId, { content: partialText + note, ...partialMeta, mems: [], modelLabel: run.modelLabel, partial: true });
    }
    store.saveNow();
    renderAll();
    // Fire queued follow-ups for this chat, sequentially, after success.
    if (q.length) {
      if (failed) {
        chatQueues.delete(chatId);
        toast('Queued message was dropped — send it again', 'info', 2600);
      } else {
        const [next, ...rest] = q;
        if (rest.length) chatQueues.set(chatId, rest); else chatQueues.delete(chatId);
        store.update(s => {
          const c = s.chats.find(x => x.id === chatId);
          c.messages.push({ id: uid('m'), role: 'user', content: next, at: now() });
          c.updatedAt = now();
        });
        renderAll();
        generate(chatId);
      }
    } else {
      chatQueues.delete(chatId);
    }
  }
}

/* ================= CONTEXT COMPACTION =================
 * Old turns are folded into a running summary stored on the chat
 * (chat.compaction = {summary, uptoId, cycles}). The model can trigger it
 * itself via the compact_context tool; it also runs automatically when
 * usage crosses the soft threshold. UI history stays intact. */
function chatLimit(s, chat) {
  const ref = chat.modelRef || s.composer.modelRef;
  const r = ref ? resolveModelRef(s, ref) : null;
  const modelId = r ? (r.model.modelId || r.model.id || '') : '';
  return Number(r?.model?.context) || knownContextFor(modelId) || (s.settings.contextLength || 64000);
}
function estMsgTokens(m) {
  const c = m.content;
  const text = typeof c === 'string' ? c : JSON.stringify(c ?? '');
  const att = m.role === 'user' && m.attachments?.length
    ? m.attachments.reduce((n, a) => n + estimateTokens(a.text || ''), 0) : 0;
  return estimateTokens(text) + att;
}
/* Current context occupancy of a chat, projected against its (possibly new)
 * model limit. Shared by auto-compact and model-switch compaction. */
function estimateContextTokens(s, chat) {
  const limit = chatLimit(s, chat);
  let total = Math.round(limit * 0.03) + 200; // system prompt + memory reserve
  const comp = chat.compaction;
  const msgs = chat.messages.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool');
  const idx = comp?.uptoId ? msgs.findIndex(m => m.id === comp.uptoId) : -1;
  const start = idx >= 0 ? idx + 1 : 0;
  if (idx >= 0) total += estimateTokens(comp.summary);
  for (let i = start; i < msgs.length; i++) {
    if (msgs[i]._hidden) continue;
    total += estMsgTokens(msgs[i]) + 4;
  }
  return { total, limit };
}
function shouldAutoCompact(s, chat) {
  if (s.settings.autoCompact === false) return false;
  const { total, limit } = estimateContextTokens(s, chat);
  const turns = chat.messages.filter(m => m.role === 'user' || m.role === 'assistant').length;
  return total > limit * 0.75 && turns >= 8;
}
/* After switching models the new context window may be smaller than the
 * conversation. Fold history into the running summary NOW so the next
 * message doesn't fail or silently truncate — the UI history stays intact. */
async function ensureContextFits(chatId) {
  const s = store.state;
  const chat = s.chats.find(c => c.id === chatId);
  if (!chat || !chat.messages.length) return;
  const { total, limit } = estimateContextTokens(s, chat);
  if (!limit || total <= limit * 0.85) return;
  const mdl = resolveActiveModel();
  if (!mdl) return;
  try {
    const r = await compactChat(chat, mdl, null);
    if (r?.ok) toast('History compacted to fit the new model\u2019s context window', 'ok', 3200);
  } catch (e) {
    if (e?.name !== 'AbortError') console.warn('Switch-compaction failed:', e);
  }
}

const COMPACTION_SYSTEM = 'You are the context compactor of an AI workspace. Produce a dense RUNNING SUMMARY of the conversation so far: key facts, decisions, open questions, file paths, code names, and what remains to be done. Keep technical details the assistant will need (identifiers, paths, exact names). Be concise; never narrate; output ONLY the summary text.';

async function compactChat(chat, mdl, run, opts = {}) {
  const prev = chat.compaction || { summary: '', uptoId: null, cycles: 0 };
  const visible = chat.messages.filter(m => !m._hidden && (m.role === 'user' || m.role === 'assistant' || m.role === 'tool'));
  const keepCount = Math.min(6, visible.length);
  const toFold = visible.slice(0, Math.max(0, visible.length - keepCount));
  if (toFold.length < 2) return { ok: false, message: 'Nothing to compact yet — the conversation is too short.' };
  const foldedTokens = toFold.reduce((n, m) => n + estMsgTokens(m) + 4, 0);
  const transcript = toFold.map(m => {
    const who = m.role === 'user' ? 'User' : m.role === 'tool' ? 'Tool result' : 'Assistant';
    const att = m.role === 'user' && m.attachments?.length ? ' [attached: ' + m.attachments.map(a => a.name).join(', ') + ']' : '';
    return `${who}: ${String(m.content || '').slice(0, 4000)}${att}`;
  }).join('\n\n');
  if (run) run.status = 'Compacting context…';
  queueRerenderChat();
  let acc = '';
  const h = streamChat({
    provider: mdl.provider, modelId: mdl.model.modelId,
    messages: [
      { role: 'system', content: COMPACTION_SYSTEM + (prev.summary ? '\n\nCurrent summary to update and extend:\n' + prev.summary : '') },
      { role: 'user', content: (opts.instructions ? 'Extra instructions for the summary: ' + opts.instructions + '\n\n' : '') + 'Summarize the conversation continuation below. Output ONLY the updated summary.\n\n' + transcript }
    ],
    opts: { temperature: 0.2, maxTokens: Math.min(2048, Math.max(600, store.state.settings.maxTokens || 2048)) },
    onToken: t => { acc += t; },
    onReasoning: () => {},
    onToolDelta: () => {}
  });
  const res = await h.done;
  if (res.aborted) throw new DOMException('Aborted', 'AbortError');
  if (res.toolCalls?.length) throw new Error('Compaction model tried to call tools');
  const summary = (acc || '').trim() || prev.summary;
  if (!summary) throw new Error('Compaction produced an empty summary');
  const lastFolded = toFold[toFold.length - 1];
  store.update(st => {
    const c = st.chats.find(x => x.id === chat.id);
    c.compaction = { summary, uptoId: lastFolded.id, updatedAt: now(), cycles: (prev.cycles || 0) + 1 };
  });
  return { ok: true, message: `Context compacted: ${toFold.length} older message(s) (~${fmtTokens(foldedTokens)} tokens) folded into the running summary (cycle ${(prev.cycles || 0) + 1}). Recent messages stay verbatim; the full transcript remains in the UI.` };
}

async function generateChat(chat, mdl, run) {
  const s = store.state;
  const tools = enabledOpenAITools(s, chat);
  const mcpExtra = collectMcpTools(s, chat);
  const allTools = [...tools, ...mcpExtra];
  if (shouldAutoCompact(s, chat)) {
    try { await compactChat(chat, mdl, run); }
    catch (e) { if (e?.name === 'AbortError') throw e; console.warn('Auto-compact failed:', e); }
  }
  let { messages, mems } = buildMessages(chat);
  let rounds = 0, finalText = '', finalReasoning = '';
  const toolHistory = [];
  while (rounds < 4) {
    rounds++;
    run.status = rounds > 1 ? `Step ${rounds}` : 'Generating…';
    const acc = await streamOnce(mdl, messages, allTools, run);
    finalText = acc.text; finalReasoning = acc.reasoning;
    if (!acc.toolCalls.length) break;
    const toolCallsResp = acc.toolCalls;
    messages.push({ role: 'assistant', content: acc.text || null, tool_calls: toolCallsResp.map(c => ({ id: c.id || uid('call'), type: 'function', function: { name: c.function.name, arguments: c.function.arguments || '{}' } })) });
    for (const c of toolCallsResp) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch { args = {}; }
      upsertToolCard(run, c.function.name, args, 'Running…', null);
      let rec;
      if (!(await confirmToolUse(c.function.name, args))) {
        rec = { id: uid('tc'), tool: c.function.name, args, ok: false, result: 'Denied by user.', at: now(), chatId: chat.id, ms: 0 };
      } else {
        rec = await executeTool(store.state, c.function.name, args, { projectId: chat.projectId, base: projectBase(chat.projectId), chatId: chat.id, webConfig: getWebConfig(), compact: (o = {}) => compactChat(chat, mdl, run, o), onTaskChange: () => refreshTaskDot() });
      }
      store.update(st => { st.toolCalls.unshift(rec); }, true);
      toolHistory.push({ name: c.function.name, args, ok: rec.ok, result: rec.result, ms: rec.ms });
      upsertToolCard(run, c.function.name, args, rec.result, rec.ok, rec.ms);
      if (c.function.name === 'compact_context') {
        messages = buildMessages(chat, 'Context was just compacted; the summary above replaces older turns.').messages;
      } else {
        messages.push({ role: 'tool', tool_call_id: c.id || 'call', content: String(rec.result).slice(0, 8000) });
      }
    }
  }
  saveAssistant(chat.id, { content: finalText || '(empty response)', reasoning: finalReasoning, toolCalls: toolHistory, mems, modelLabel: run.modelLabel });
}
function collectMcpTools(s, chat) {
  if (chat && chat.mcpOn === false) return [];
  const out = [];
  for (const sv of s.mcpServers) {
    if (!sv.enabled || sv.status !== 'online') continue;
    for (const t of (sv.tools || [])) {
      out.push({ type: 'function', function: { name: 'mcp__' + sv.id.slice(-4) + '__' + t.name, description: `[MCP:${sv.name}] ${t.description || t.name}`, parameters: t.inputSchema || { type: 'object', properties: {} } } });
    }
  }
  return out;
}
function upsertToolCard(run, name, args, result, ok, ms) {
  run.toolCards = run.toolCards || [];
  const f = run.toolCards.find(t => t.name === name && t.ok == null);
  if (f) { f.args = args; f.result = result; f.ok = ok; f.ms = ms; }
  else run.toolCards.push({ name, args, result, ok, ms });
  scheduleRunPaint(run);
}
function streamOnce(mdl, messages, tools, run) {
  return new Promise((resolve, reject) => {
    let text = run.text || '', reasoning = run.reasoning || '';
    const h = streamChat({
      provider: mdl.provider, modelId: mdl.model.modelId, messages,
      opts: {
        temperature: store.state.settings.temperature, maxTokens: store.state.settings.maxTokens,
        reasoningEffort: store.state.settings.reasoningEffort,
        tools, toolChoice: tools.length ? 'auto' : undefined
      },
      signal: run.abortCtrl.signal,
      onToken: t => { text += t; run.text = text; scheduleRunPaint(run); },
      onReasoning: t => { reasoning += t; run.reasoning = reasoning; scheduleRunPaint(run); },
      onToolDelta: () => { run.status = 'Calling tools…'; scheduleRunPaint(run); }
    });
    h.done.then(res => {
      if (res.aborted) throw new DOMException('Aborted', 'AbortError');
      resolve({ text, reasoning, toolCalls: res.toolCalls || [] });
    }).catch(reject);
  });
}

async function generateAgent(chat, mdl, run) {
  if (shouldAutoCompact(store.state, chat)) {
    try { await compactChat(chat, mdl, run); }
    catch (e) { if (e?.name === 'AbortError') throw e; console.warn('Auto-compact failed:', e); }
  }
  const res = await runAgent({
    state: store.state, chat,
    provider: mdl.provider, model: mdl.model,
    userText: chat.messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '',
    attachments: chat.messages.filter(m => m.role === 'user').slice(-1)[0]?.attachments || [],
    signal: run.abortCtrl.signal,
    compact: (o = {}) => compactChat(chat, mdl, run, o),
    save: (rec) => store.update(st => { st.toolCalls.unshift(rec); }, true),
    confirmTool: (n, a) => confirmToolUse(n, a),
    onEvent: (ev) => {
      if (ev.kind === 'token') { run.text = (run.text || '') + ev.text; run.status = `Step ${ev.n} · writing…`; }
      else if (ev.kind === 'reasoning') { run.reasoning = (run.reasoning || '') + ev.text; }
      else if (ev.kind === 'thinking') { run.status = `Step ${ev.n} · thinking…`; run.statusAction = 'thinking'; }
      else if (ev.kind === 'step') { run.status = `Step ${ev.n}/${ev.of}…`; }
      else if (ev.kind === 'tool') { (run.toolCards = run.toolCards || []).push({ name: ev.name, args: ev.args, result: 'Running…', ok: null }); run.status = `Step ${ev.n} · ${ev.name}…`; }
      else if (ev.kind === 'result') {
        const c = (run.toolCards || []).find(t => t.name === ev.name && t.ok == null);
        if (c) { c.result = ev.result; c.ok = ev.ok; c.ms = ev.ms; }
        (run.steps = run.steps || []).push({ n: ev.n, name: ev.name, args: {}, ok: ev.ok, result: ev.result });
        run.status = `Step ${ev.n} · done`;
      }
      else if (ev.kind === 'final') { run.text = ev.text; run.status = 'Done'; }
      else if (ev.kind === 'tasks') {
        // The agent touched its todo list — repaint the Tasks view if open.
        if (store.state.view === 'tasks') renderAll();
        refreshTaskDot();
      }
      scheduleRunPaint(run);
    }
  });
  saveAssistant(chat.id, { content: res.text, reasoning: res.reasoning, steps: res.steps, toolCalls: (run.toolCards || []).map(t => ({ name: t.name, args: t.args, ok: t.ok, result: t.result, ms: t.ms })), mems: res.mems, modelLabel: run.modelLabel });
}
function saveAssistant(chatId, { content, reasoning, steps, toolCalls, mems, modelLabel, partial }) {
  const toks = Math.round((content || '').length / 4);
  store.update(s => {
    const c = s.chats.find(x => x.id === chatId);
    if (!c) return; // chat deleted while the run was in flight
    c.messages.push({
      id: uid('m'), role: 'assistant', content, reasoning: reasoning || '',
      steps: steps || [], toolCalls: toolCalls || [],
      memsUsed: (mems || []).map(m => m.text.slice(0, 90)),
      modelLabel, at: now(), tokens: toks + ' tok', partial: !!partial
    });
    c.updatedAt = now();
  });
}
function stopGeneration() {
  if (!streaming) return;
  try { streaming.abortCtrl?.abort(); } catch (_) {}
}

/* ================= MESSAGE ACTIONS ================= */
function editMessage(mid) {
  const chat = store.activeChat; if (!chat) return;
  if (runs.has(chat.id)) return toast('Wait for the current answer to finish (or stop it) first', 'info', 2200);
  const m = chat.messages.find(x => x.id === mid); if (!m) return;
  openModal({
    title: 'Edit message', bodyHTML: `<div class="field"><textarea id="eT" rows="5">${esc(m.content || '')}</textarea></div>`,
    actions: [{ label: 'Cancel', kind: 'secondary', onClick: c => c(null) }, {
      label: 'Save & resend', onClick: (close) => {
        const v = document.querySelector('#eT').value;
        store.update(s => {
          const c = s.chats.find(x => x.id === chat.id);
          const i = c.messages.findIndex(x => x.id === mid);
          c.messages[i].content = v;
          c.messages = c.messages.slice(0, i + 1);
          c.updatedAt = now();
        });
        close(true);
        generate(chat.id);
      }
    }]
  });
}
function regenerate(mid) {
  const chat = store.activeChat; if (!chat) return;
  if (runs.has(chat.id)) return toast('Wait for the current answer to finish (or stop it) first', 'info', 2200);
  store.update(s => {
    const c = s.chats.find(x => x.id === chat.id);
    const i = c.messages.findIndex(x => x.id === mid);
    if (i >= 0) c.messages.splice(i, 1);
    c.updatedAt = now();
  });
  generate(chat.id);
}
function continueFrom() {
  const chat = store.activeChat; if (!chat) return;
  if (runs.has(chat.id)) return toast('Wait for the current answer to finish (or stop it) first', 'info', 2200);
  store.update(s => {
    const c = s.chats.find(x => x.id === chat.id);
    c.messages.push({ id: uid('m'), role: 'user', content: 'Continue where you left off.', at: now(), _hidden: true });
  });
  generate(chat.id);
}
function branchFrom(mid) {
  const chat = store.activeChat; if (!chat) return;
  const i = chat.messages.findIndex(x => x.id === mid);
  const sliced = chat.messages.slice(0, i + 1).map(m => ({ ...m, id: uid('m') }));
  store.update(s => {
    const nc = { ...chat, id: uid('chat'), title: chat.title + ' (branch)', messages: sliced, updatedAt: now(), createdAt: now() };
    s.chats.unshift(nc);
    s.activeChatId = nc.id;
  });
  toast('Branched into a new conversation', 'ok', 2000);
}

/* ================= CHAT MGMT ================= */
function renameChat(id) {
  const c = store.state.chats.find(x => x.id === id);
  openModal({
    title: 'Rename conversation', bodyHTML: `<div class="field"><input id="rT" value="${esc(c?.title || '')}" maxlength="80" /></div>`,
    actions: [{ label: 'Cancel', kind: 'secondary', onClick: cl => cl(null) }, {
      label: 'Rename', onClick: (close) => {
        const v = document.querySelector('#rT').value.trim();
        if (v) store.update(s => { s.chats.find(x => x.id === id).title = v; });
        close(true);
      }
    }]
  });
}
function moveChat(id) {
  const s = store.state;
  openMenu(300, 300, s.folders.map(f => ({
    label: f.name, checked: s.chats.find(c => c.id === id)?.folder === f.id,
    onClick: () => store.update(st => { st.chats.find(c => c.id === id).folder = f.id; })
  })));
}
function duplicateChat(id) {
  store.update(s => {
    const c = s.chats.find(x => x.id === id);
    const nc = JSON.parse(JSON.stringify(c));
    nc.id = uid('chat'); nc.title = c.title + ' (copy)'; nc.createdAt = now(); nc.updatedAt = now();
    nc.messages = nc.messages.map(m => ({ ...m, id: uid('m') }));
    s.chats.unshift(nc);
  });
}
function deleteChat(id) {
  openModal({
    title: 'Delete conversation?', sub: runs.has(id) ? 'This chat is currently generating — it will be stopped. This cannot be undone.' : 'This cannot be undone.', bodyHTML: '',
    actions: [{ label: 'Keep', kind: 'secondary', onClick: c => c(null) }, {
      label: 'Delete', kind: 'danger', onClick: (close) => {
        if (runs.has(id)) { try { runs.get(id).abortCtrl.abort(); } catch (_) {} runs.delete(id); }
        chatQueues.delete(id);
        store.update(s => {
          s.chats = s.chats.filter(x => x.id !== id);
          if (s.activeChatId === id) s.activeChatId = s.chats[0]?.id || null;
        });
        bindVisibleRun();
        close(true);
      }
    }]
  });
}
function exportChat() {
  const c = store.activeChat; if (!c) return;
  const md = `# ${c.title}\n\n` + c.messages.map(m => `## ${m.role}\n${m.content}`).join('\n\n');
  download(c.title.replace(/\W+/g, '_') + '.md', md, 'text/markdown');
}

/* ================= MODALS: tools / mcp / models / projects / keys / agents ================= */
async function editToolModal(id, repaint) {
  const s = store.state;
  const t = id ? s.tools.find(x => x.id === id) : { id: uid('tool'), name: 'my_tool', description: '', parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }, permissions: 'network', enabled: true, custom: true, webhookURL: '', headers: {} };
  const body = `<div class="form-grid">
    <div class="grid-2"><div class="field"><label>Function name</label><input id="tName" value="${esc(t.name)}" /></div>
    <div class="field"><label>Permission</label><select id="tPerm">${['safe', 'network', 'files'].map(p => `<option ${t.permissions === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div></div>
    <div class="field"><label>Description</label><textarea id="tDesc" rows="2">${esc(t.description || '')}</textarea></div>
    <div class="field"><label>Parameters (JSON Schema)</label><textarea id="tParams" rows="5" spellcheck="false">${esc(JSON.stringify(t.parameters || {}, null, 2))}</textarea></div>
    <div class="field"><label>Webhook URL (POST args as JSON, optional)</label><input id="tHook" value="${esc(t.webhookURL || '')}" placeholder="https://…" /></div>
  </div>`;
  await openModal({
    title: id ? 'Edit tool' : 'New custom tool', wide: true, bodyHTML: body,
    actions: [{ label: 'Cancel', kind: 'secondary', onClick: c => c(null) }, {
      label: 'Save', onClick: (close, back) => {
        try {
          const nt = {
            name: back.querySelector('#tName').value.trim().replace(/\s+/g, '_') || 'my_tool',
            description: back.querySelector('#tDesc').value.trim(),
            parameters: JSON.parse(back.querySelector('#tParams').value || '{}'),
            permissions: back.querySelector('#tPerm').value,
            webhookURL: back.querySelector('#tHook').value.trim()
          };
          if (!/^[a-zA-Z0-9_-]+$/.test(nt.name)) throw new Error('Name may contain letters, numbers, _ and -');
          store.update(st => {
            if (id) Object.assign(st.tools.find(x => x.id === id), nt);
            else st.tools.push({ ...t, ...nt });
          });
          close(true); repaint && repaint(); if (openDrawerKind) paintDrawer(); toast('Tool saved', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      }
    }]
  });
}
async function editMcpModal(id, repaint) {
  const sv = store.state.mcpServers.find(x => x.id === id);
  if (!sv) return;
  const body = `<div class="form-grid">
    <div class="grid-2"><div class="field"><label>Name</label><input id="mName" value="${esc(sv.name)}" /></div>
    <div class="field"><label>Transport</label><select id="mTr">${['http', 'sse', 'stdio'].map(t => `<option ${sv.transport === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div>
    <div class="field"><label>URL (http/sse)</label><input id="mUrl" value="${esc(sv.url || '')}" placeholder="http://localhost:8000/mcp" /></div>
    <div class="grid-2"><div class="field"><label>Command (stdio)</label><input id="mCmd" value="${esc(sv.command || '')}" placeholder="npx" /></div>
    <div class="field"><label>Args (stdio)</label><input id="mArgs" value="${esc(sv.args || '')}" placeholder="-y my-mcp-server" /></div></div>
    <div class="field"><label>Headers (JSON)</label><textarea id="mH" rows="2" spellcheck="false">${esc(JSON.stringify(sv.headers || {}, null, 2))}</textarea></div>
    <div class="field"><label>Environment (JSON, for stdio)</label><textarea id="mE" rows="2" spellcheck="false" placeholder='{"GITHUB_PERSONAL_ACCESS_TOKEN": "…"}'>${esc(JSON.stringify(sv.env || {}, null, 2))}</textarea></div>
    <div class="row-between"><div class="grow"><b>Connect on startup</b></div>
    <label class="switch"><input type="checkbox" id="mA" ${sv.autoConnect !== false ? 'checked' : ''} /><span class="track"></span><span class="thumb"></span></label></div>
  </div>`;
  await openModal({
    title: 'Configure MCP server', wide: true, bodyHTML: body,
    actions: [{ label: 'Cancel', kind: 'secondary', onClick: c => c(null) }, {
      label: 'Save', onClick: (close, back) => {
        try {
          store.update(st => {
            const x = st.mcpServers.find(y => y.id === id);
            x.name = back.querySelector('#mName').value.trim() || 'MCP server';
            x.transport = back.querySelector('#mTr').value;
            x.url = back.querySelector('#mUrl').value.trim();
            x.command = back.querySelector('#mCmd').value.trim();
            x.args = back.querySelector('#mArgs').value.trim();
            x.headers = JSON.parse(back.querySelector('#mH').value || '{}');
            try { x.env = JSON.parse(back.querySelector('#mE').value || '{}'); } catch { throw new Error('Environment is not valid JSON'); }
            x.autoConnect = back.querySelector('#mA').checked;
            x.status = 'offline';
            mcpLog(x, 'Configuration updated.');
          });
          close(true); repaint && repaint(); if (openDrawerKind) paintDrawer();
        } catch (e) { toast(e.message, 'err'); }
      }
    }]
  });
}
async function editProjectModal(id, repaint) {
  const p = store.state.projects.find(x => x.id === id);
  if (!p) return;
  const s = store.state;
  const toolBoxes = s.tools.map(t => `<label style="display:flex;gap:8px;align-items:center;font-size:13px;padding:4px 0"><input type="checkbox" data-t="${t.id}" ${(p.tools || []).includes(t.id) ? 'checked' : ''} /> ${esc(t.name)}</label>`).join('') || '<p class="muted">No tools.</p>';
  const body = `<div class="form-grid">
    <div class="field"><label>Name</label><input id="pName" value="${esc(p.name)}" /></div>
    <div class="field"><label>Description</label><input id="pDesc" value="${esc(p.description || '')}" /></div>
    <div class="field"><label>System instructions</label><textarea id="pSys" rows="4">${esc(p.systemInstructions || '')}</textarea><div class="hint">Injected into every chat in this project.</div></div>
    <div class="field"><label>Local folder</label>
      <div class="row-between"><div class="grow muted" id="pPath" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.localPath || 'App storage (sandboxed)')}</div>
      <button class="btn secondary small" id="pLink">${p.localPath ? 'Change' : 'Link folder'}</button>
      ${p.localPath ? '<button class="btn danger small" id="pUnlink">Unlink</button>' : ''}</div>
      <div class="hint">Use any folder on your computer instead of app storage.</div></div>
    <details class="collapsible"><summary>Project tools (empty = all enabled tools)</summary><div class="coll-body">${toolBoxes}</div></details>
  </div>`;
  const projModal = openModal({
    title: 'Configure project', wide: true, bodyHTML: body,
    actions: [{ label: 'Cancel', kind: 'secondary', onClick: c => c(null) }, {
      label: 'Save', onClick: (close, back) => {
        store.update(st => {
          const x = st.projects.find(y => y.id === id);
          x.name = back.querySelector('#pName').value.trim() || x.name;
          x.description = back.querySelector('#pDesc').value.trim();
          x.systemInstructions = back.querySelector('#pSys').value;
          x.tools = [...back.querySelectorAll('input[data-t]:checked')].map(i => i.dataset.t);
        });
        close(true); repaint && repaint(); toast('Project saved', 'ok');
      }
    }]
  });
  document.querySelector('#pLink')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const dir = await window.zeqou.dialogs.openDirectory();
    if (!dir) return;
    store.update(st => { st.projects.find(y => y.id === id).localPath = dir; });
    const lbl = document.querySelector('#pPath');
    if (lbl) lbl.textContent = dir;
    toast('Folder linked', 'ok', 1800);
  });
  document.querySelector('#pUnlink')?.addEventListener('click', (e) => {
    e.preventDefault();
    store.update(st => { delete st.projects.find(y => y.id === id).localPath; });
    const lbl = document.querySelector('#pPath');
    if (lbl) lbl.textContent = 'App storage (sandboxed)';
  });
  await projModal;
}
async function editApiKeyModal(providerId, cb) {
  const p = providerById(store.state, providerId);
  const cur = await window.zeqou.secrets.masked('provider:' + providerId);
  await openModal({
    title: 'API key — ' + (p?.name || ''), sub: cur.has ? 'Saved: ' + cur.masked : 'No key saved yet.',
    bodyHTML: `<div class="field"><label>New key</label><input id="kV" type="password" placeholder="sk-…" autocomplete="off" /><div class="hint">Stored encrypted via the OS keychain. Never displayed in full.</div></div>`,
    actions: [{ label: 'Cancel', kind: 'secondary', onClick: c => c(null) }, {
      label: 'Save key', onClick: async (close, back) => {
        const v = back.querySelector('#kV').value.trim();
        if (!v) return;
        await window.zeqou.secrets.set('provider:' + providerId, v);
        close(true); cb && cb();
        toast('Key saved — detecting models…', 'info', 2000);
        autoDiscoverModels(false);
      }
    }]
  });
}
async function editAgentModal(id, cb) {
  const a = id ? store.state.agents.find(x => x.id === id) : { id: uid('agent'), name: '', description: '', instructions: '', maxSteps: 6 };
  const body = `<div class="form-grid">
    <div class="field"><label>Name</label><input id="aN" value="${esc(a.name)}" /></div>
    <div class="field"><label>Description</label><input id="aD" value="${esc(a.description || '')}" /></div>
    <div class="field"><label>Instructions</label><textarea id="aI" rows="4">${esc(a.instructions || '')}</textarea></div>
    <div class="field"><label>Max steps</label><input id="aS" type="number" min="1" max="12" value="${esc(a.maxSteps || 6)}" /></div>
  </div>`;
  await openModal({
    title: id ? 'Edit agent' : 'New agent', wide: true, bodyHTML: body,
    actions: [{ label: 'Cancel', kind: 'secondary', onClick: c => c(null) }, {
      label: 'Save', onClick: (close, back) => {
        const name = back.querySelector('#aN').value.trim();
        if (!name) return toast('Name is required', 'err');
        store.update(s => {
          if (id) Object.assign(s.agents.find(x => x.id === id), { name, description: back.querySelector('#aD').value.trim(), instructions: back.querySelector('#aI').value, maxSteps: Number(back.querySelector('#aS').value || 6) });
          else s.agents.push({ ...a, name, description: back.querySelector('#aD').value.trim(), instructions: back.querySelector('#aI').value, maxSteps: Number(back.querySelector('#aS').value || 6) });
        });
        close(true); cb && cb();
      }
    }]
  });
}
async function discoverAllModels() {
  toast('Detecting models…', 'info', 1800);
  await autoDiscoverModels(false);
  renderAll();
}
async function addModel() {
  const s = store.state;
  const opts = s.providers.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const body = `<div class="form-grid">
    <div class="field"><label>Provider</label><select id="mP">${opts}</select></div>
    <div class="field"><label>Model ID (exact API id)</label><input id="mId" placeholder="gpt-4o-mini" /></div>
    <div class="field"><label>Context length</label><input id="mCtx" type="number" value="128000" /></div>
  </div>`;
  await openModal({
    title: 'Add model', bodyHTML: body,
    actions: [{ label: 'Cancel', kind: 'secondary', onClick: c => c(null) }, {
      label: 'Add', onClick: (close, back) => {
        const pid = back.querySelector('#mP').value;
        const mid = back.querySelector('#mId').value.trim();
        if (!mid) return;
        store.update(st => {
          providerById(st, pid).models.push({ id: uid('m'), providerId: pid, modelId: mid, label: mid, context: Number(back.querySelector('#mCtx').value || 0), caps: guessCaps(mid), status: 'unknown' });
        });
        close(true); renderAll();
      }
    }]
  });
}
