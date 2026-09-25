/* Smoke test: boot the real Electron app with remote debugging, click through
 * every sidebar tab via CDP and report per-tab child count + console errors.
 * Usage: node scripts/smoke.js   (no external deps) */
const { spawn } = require('child_process');
const http = require('http');

const TABS = ['chat', 'history', 'projects', 'files', 'models', 'memories', 'tools', 'mcp', 'settings'];
const PORT = 9333;
const BOOT_MS = 20000;

/* The features the app is built around, driven through their real code paths
 * inside the running renderer. A tab that renders proves nothing about the
 * tool that fills it: an agent tool once reported "failed" while it had in
 * fact created its task, because the repaint callback threw. So the smoke
 * test runs the tool and the view together and insists both agree. */
const FEATURE_PROBE = `(async () => {
  const tasks = await import('./js/tasks.js');
  const tools = await import('./js/tools.js');
  const view = await import('./js/view-chat.js');
  const out = {};
  const FENCE = String.fromCharCode(96).repeat(3); // a far template literal cannot hold backticks

  const host = document.createElement('div');
  document.body.appendChild(host);
  const state = { tasks: [], chats: [{ id: 'c1', title: 'Probe' }], activeChatId: 'c1' };
  const api = { update: (fn) => fn(state), answerQuestion: () => {} };

  // 1. the agent's todo tool must succeed and the mounted list must show it
  const list = tasks.todoView(state, state.chats[0], api);
  host.appendChild(list);
  out.emptyListHidden = list.hidden === true;
  out.emptyListDisplay = getComputedStyle(list).display;
  const add = await tools.executeTool(state, 'todo', { action: 'add', title: 'Probe task', plan: 'from the smoke test' }, { chatId: 'c1', onTaskChange: () => tasks.refreshTodoLists() });
  out.todoOk = add.ok === true;
  out.listShown = list.hidden === false;
  out.listDisplay = getComputedStyle(list).display;
  out.todoRows = [...host.querySelectorAll('.todo-row .todo-name')].map(n => n.textContent);
  out.todoCount = host.querySelector('.todo-count')?.textContent || '';

  // 1b. the plan is READ-ONLY: no control anywhere in the rows, and clicking
  //     one changes nothing. "Why am I able to click this?" was the bug.
  out.todoControls = host.querySelectorAll('.todo-rows button, .todo-rows input, .todo-add-btn, .todo-rows [role=button]').length;
  out.todoRowCursor = getComputedStyle(host.querySelector('.todo-row')).cursor;
  const before = state.tasks[0].status;
  host.querySelector('.todo-row').click();
  out.todoClickChangedNothing = state.tasks[0].status === before;

  await tools.executeTool(state, 'todo', { action: 'status', status: 'done', id: state.tasks[0]?.id }, { chatId: 'c1', onTaskChange: () => tasks.refreshTodoLists() });
  out.todoTick = host.querySelector('.todo-row .todo-tick')?.textContent || '';
  out.todoCountAfterDone = host.querySelector('.todo-count')?.textContent || '';

  // 2. a broken repaint must not fail the tool, and the next repaint must
  //    still show the task that was created while the paint was broken
  const broken = await tools.executeTool(state, 'todo', { action: 'add', title: 'Probe task 2' }, { chatId: 'c1', onTaskChange: () => { throw new Error('paint exploded'); } });
  out.todoSurvivesBadRepaint = broken.ok === true;
  out.todoRowsStale = [...host.querySelectorAll('.todo-row .todo-name')].map(n => n.textContent);
  tasks.refreshTodoLists();
  out.todoRowsFinal = [...host.querySelectorAll('.todo-row .todo-name')].map(n => n.textContent);
  out.todoCountFinal = host.querySelector('.todo-count')?.textContent || '';

  // 2b. the fold survives a repaint — before this, every paint reopened it
  host.querySelector('.todo-fold').click();
  out.foldedRowsHidden = host.querySelector('.todo-rows').hidden === true;
  out.foldedChevron = host.querySelector('.todo-fold').textContent;
  tasks.refreshTodoLists();
  out.foldedAfterRepaint = host.querySelector('.todo-rows').hidden === true;
  host.querySelector('.todo-fold').click();
  out.unfoldedRowsHidden = host.querySelector('.todo-rows').hidden;
  out.unfoldedChevron = host.querySelector('.todo-fold').textContent;

  // 2b-bis. the agent timeline: folded by default, and a rebuild (which is
  //         what happens on every new step) must not undo the reader's click
  const act = view.activityNode([{ name: 'todo', ok: true, result: 'a' }, { name: 'todo', ok: true, result: 'b' }, { name: 'shell_exec', ok: true }], true, null, 'probe-live');
  out.actDefaultHidden = act.querySelector('.activity-body').hidden;
  out.actGrouped = [...act.querySelectorAll('.activity-step')].length; // 3 steps, 2 groups
  act.querySelector('.activity-head').click();
  out.actOpenedHidden = act.querySelector('.activity-body').hidden;
  const rebuilt = view.activityNode([{ name: 'todo', ok: true, result: 'c' }], true, null, 'probe-live');
  out.actOpenSurvivesRebuild = rebuilt.querySelector('.activity-body').hidden === false;
  rebuilt.querySelector('.activity-head').click();
  const rebuilt2 = view.activityNode([{ name: 'todo', ok: true }], true, null, 'probe-live');
  out.actClosedSurvivesRebuild = rebuilt2.querySelector('.activity-body').hidden === true;
  out.actChevronClosed = rebuilt2.querySelector('.chev').textContent;

  // 2c. the heuristic that decides whether an answer is really asking the user
  //     (the two positive texts are copied from a real chat where a model asked
  //     its questions as plain text instead of calling ask_user)
  out.asksQuestion = [
    tools.looksLikePlainTextQuestion('Понял! Ответь, и я начну писать код! 🚀'),
    tools.looksLikePlainTextQuestion('Файлы созданы. Что нужно сделать дальше?'),
    tools.looksLikePlainTextQuestion('Нужна ли мобильная версия или только для ПК?'),
    tools.looksLikePlainTextQuestion('Файл записан, готово.'),
    tools.looksLikePlainTextQuestion('const ok = a ? 1 : 0; // ternary'),
    // a fenced block is stripped before the verdict, so the "?" inside it is ignored
    // (the fence is built from char codes: this probe is itself a template literal)
    tools.looksLikePlainTextQuestion([FENCE, 'const q = ask("what?");', FENCE, 'Готово, файл записан.'].join(String.fromCharCode(10)))
  ].join(',');

  // 3. a run that dies takes its unfinished plan with it; what it finished
  //    stays as a record. (One task is 'done' here, one is not.)
  await tools.executeTool(state, 'todo', { action: 'status', status: 'doing', id: state.tasks.find(t => t.status === 'pending')?.id || state.tasks[0].id }, { chatId: 'c1' });
  out.doingBefore = state.tasks.filter(t => t.status === 'doing').length;
  out.dropped = tasks.discardUnfinishedTasks(state, 'c1');
  out.doingAfter = state.tasks.filter(t => t.status === 'doing').length;
  out.keptDone = state.tasks.filter(t => t.status === 'done').length;
  out.listHiddenAfterDiscard = (tasks.refreshTodoLists(), list.hidden);

  // 4. the question card answers through the api it is given
  const answers = [];
  const card = view.questionNode({ id: 'q1', question: 'Which colour?', options: ['Blue', 'Red'], header: 'Probe', status: 'open', answer: null }, { live: true, api: { answerQuestion: (id, v) => answers.push([id, v]) } });
  card.querySelectorAll('.ask-opt')[0].click();
  out.questionAnswered = JSON.stringify(answers);
  out.questionDone = !!card.querySelector('.ask-sent');

  host.remove();

  // 5. streaming must not rebuild the transcript: the message nodes a reader
  //    is looking at have to survive every painted frame, or the page jumps
  //    to the bottom and re-renders code blocks several times a second.
  const root = document.createElement('div');
  document.body.appendChild(root);
  const st = {
    chats: [{ id: 'cx', messages: [
      { id: 'm1', role: 'user', content: 'hi', at: 1 },
      { id: 'm2', role: 'assistant', content: 'hello', at: 2, steps: [], toolCalls: [] }
    ] }],
    activeChatId: 'cx', tasks: [], models: [],
    providers: [{ enabled: true, models: [{ id: 'x' }] }],
    settings: { showThinking: true }
  };
  const sapi = { streaming: null, onEdit() {}, onRegenerate() {}, onContinue() {}, onBranch() {}, goto() {}, update() {}, answerQuestion() {} };
  view.renderChat(root, st, sapi);
  const userNode = root.children[0], assistNode = root.children[1];
  out.transcriptChildren = root.children.length;
  sapi.streaming = { chatId: 'cx', run: {}, text: 'partial answer', status: 'writing…', steps: [{ name: 'todo', ok: true }], toolCards: [], questions: [], reasoning: '', modelLabel: 'm' };
  view.renderChat(root, st, sapi);
  out.streamKeptUser = root.children[0] === userNode;
  out.streamKeptAssistant = root.children[1] === assistNode;
  sapi.streaming = null;
  st.chats[0].messages.push({ id: 'm3', role: 'user', content: 'again', at: 3 });
  view.renderChat(root, st, sapi);
  out.appendKeptOldNodes = root.children[0] === userNode && root.children[1] === assistNode;
  out.appendedText = root.children[2]?.textContent?.trim() || '';
  out.transcriptAfterAppend = root.children.length;
  root.remove();

  // 6. the empty-state hero belongs to an EMPTY chat: the first message must
  //    clear it instead of leaving "Start a new conversation" under the text
  const root2 = document.createElement('div');
  document.body.appendChild(root2);
  const st2 = {
    chats: [{ id: 'cz', messages: [] }], activeChatId: 'cz', tasks: [], models: [],
    providers: [{ enabled: true, models: [{ id: 'x' }] }], settings: { showThinking: true }
  };
  const api2 = { ...sapi, streaming: null };
  const hasHero = () => [...root2.children].some(c => c.textContent.includes('Start a new conversation'));
  view.renderChat(root2, st2, api2);
  out.heroOnEmptyChat = hasHero();
  st2.chats[0].messages.push({ id: 'm9', role: 'user', content: 'привет', at: 5 });
  view.renderChat(root2, st2, api2);
  out.heroGoneAfterFirstMessage = !hasHero();
  out.emptyChatChildren = root2.children.length;
  st2.chats[0].messages.length = 0;
  view.renderChat(root2, st2, api2);
  out.heroBackOnEmptyChat = hasHero();
  root2.remove();
  return out;
})()`;

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let msgId = 0;
function send(cdp, method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      let m; try { m = JSON.parse(ev.data.toString()); } catch { return; }
      if (m.id === id) { cdp.removeEventListener('message', onMsg); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    };
    cdp.addEventListener('message', onMsg);
    cdp.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJS(cdp, expr) {
  const r = await send(cdp, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
  return r.result?.value;
}

async function main() {
  // In a plain Node process require('electron') resolves to the executable path.
  const electronCmd = require('electron');
  const app = spawn(electronCmd, ['.', '--remote-debugging-port=' + PORT], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const consoleErrors = [];
  let client = null;

  try {
    // wait for the debug endpoint
    let targets = null;
    for (let i = 0; i < BOOT_MS / 500; i++) {
      await sleep(500);
      try { targets = await getJSON('http://127.0.0.1:' + PORT + '/json/list'); if (targets.length) break; } catch (_) {}
    }
    if (!targets || !targets.length) throw new Error('DevTools endpoint never came up');
    const page = targets.find(t => t.type === 'page');
    if (!page) throw new Error('No page target');
    client = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { client.addEventListener('open', res, { once: true }); client.addEventListener('error', rej, { once: true }); });
    client.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data.toString()); } catch { return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const t = m.params.exceptionDetails;
        consoleErrors.push((t.exception?.description || t.text || 'exception').split('\n')[0]);
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        consoleErrors.push(m.params.entry.text.split('\n')[0]);
      }
    });
    await send(client, 'Runtime.enable');
    await send(client, 'Log.enable');
    await sleep(2500); // let boot + auto-discovery settle

    const results = {};
    let pass = true;
    let navRetries = 0;
    for (const tab of TABS) {
      await evalJS(client, `document.querySelector('.nav-item[data-view="${tab}"]')?.click()`);
      await sleep(220);
      // The very first click can land while boot is still settling (the state
      // loads from disk, then model discovery re-renders). A click that did
      // nothing gets exactly one more try; a nav that never responds still
      // fails the run below.
      const arrived = await evalJS(client, `(async () => (await import('./js/store.js')).store.state.view)()`);
      if (arrived !== tab) {
        navRetries++;
        await sleep(400);
        await evalJS(client, `document.querySelector('.nav-item[data-view="${tab}"]')?.click()`);
        await sleep(220);
      }
      const info = await evalJS(client, `(async () => {
        const el = document.getElementById('view-${tab}');
        if (!el) return { exists: false };
        const active = [...document.querySelectorAll('.nav-item')].filter(b => b.classList.contains('active')).map(b => b.dataset.view).join(',');
        const store = (await import('./js/store.js')).store;
        return { exists: true, hidden: el.hidden, children: el.children.length, active, storeView: store.state.view };
      })()`);
      results[tab] = info;
      // The view must be the tab that was clicked, must be visible and must
      // have painted something — a click that only half-worked passes none.
      if (!info || !info.exists || info.hidden || info.children === 0 || info.storeView !== tab) pass = false;
    }

    const features = await evalJS(client, FEATURE_PROBE);
    const featuresOk = !!features
      && features.emptyListHidden === true
      && features.emptyListDisplay === 'none'
      && features.listShown === true
      && features.listDisplay === 'block'
      && features.todoOk === true
      && features.todoSurvivesBadRepaint === true
      && features.todoRows?.join('|') === 'Probe task'
      && features.todoCount === '0/1'
      && features.todoCountAfterDone === '1/1'
      && features.todoTick === '✓'
      // read-only plan
      && features.todoControls === 0
      && features.todoRowCursor === 'auto'
      && features.todoClickChangedNothing === true
      && features.todoRowsStale?.length === 1
      && features.todoRowsFinal?.join('|') === 'Probe task|Probe task 2'
      && features.todoCountFinal === '1/2'
      && features.foldedRowsHidden === true
      && features.foldedChevron === '▸'
      && features.foldedAfterRepaint === true
      && features.unfoldedRowsHidden === false
      && features.unfoldedChevron === '▾'
      // the agent timeline folds, and a rebuild does not undo it
      && features.actDefaultHidden === true
      && features.actGrouped === 2
      && features.actOpenedHidden === false
      && features.actOpenSurvivesRebuild === true
      && features.actClosedSurvivesRebuild === true
      && features.actChevronClosed === '▸'
      && features.asksQuestion === 'true,true,true,false,false,false'
      // a dead run drops the plan it never finished
      && features.doingBefore === 1
      && features.dropped === 1
      && features.doingAfter === 0
      && features.keptDone === 1
      && features.listHiddenAfterDiscard === false
      && features.questionAnswered === '[["q1","Blue"]]'
      && features.questionDone === true
      // streaming reuses the nodes instead of rebuilding the chat
      && features.transcriptChildren === 3
      && features.streamKeptUser === true
      && features.streamKeptAssistant === true
      && features.appendKeptOldNodes === true
      && features.appendedText?.includes('again') === true
      && features.transcriptAfterAppend === 4
      // the hero must not survive the first message
      && features.heroOnEmptyChat === true
      && features.heroGoneAfterFirstMessage === true
      && features.emptyChatChildren === 2
      && features.heroBackOnEmptyChat === true;
    if (!featuresOk) pass = false;

    console.log(JSON.stringify({ pass, navRetries, tabs: results, features, featuresOk, consoleErrors }, null, 2));
    process.exitCode = pass && consoleErrors.length === 0 ? 0 : 1;
  } finally {
    try { if (client) client.close(); } catch (_) {}
    try { app.kill(); } catch (_) {}
    setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
  }
}
main().catch(e => { console.error('SMOKE FATAL:', e.message); try { process.exit(1); } catch (_) {} });
