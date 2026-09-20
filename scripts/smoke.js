/* Smoke test: boot the real Electron app with remote debugging, click through
 * every sidebar tab via CDP and report per-tab child count + console errors.
 * Usage: node scripts/smoke.js   (no external deps) */
const { spawn } = require('child_process');
const http = require('http');

const TABS = ['chat', 'history', 'projects', 'files', 'models', 'memories', 'tools', 'mcp', 'settings'];
const PORT = 9333;
const BOOT_MS = 20000;

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
    for (const tab of TABS) {
      await evalJS(client, `document.querySelector('.nav-item[data-view="${tab}"]')?.click()`);
      await sleep(220);
      const info = await evalJS(client, `(() => {
        const el = document.getElementById('view-${tab}');
        if (!el) return { exists: false };
        return { exists: true, hidden: el.hidden, children: el.children.length };
      })()`);
      results[tab] = info;
      if (!info || !info.exists || info.hidden || info.children === 0) pass = false;
    }
    console.log(JSON.stringify({ pass, tabs: results, consoleErrors }, null, 2));
    process.exitCode = pass && consoleErrors.length === 0 ? 0 : 1;
  } finally {
    try { if (client) client.close(); } catch (_) {}
    try { app.kill(); } catch (_) {}
    setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
  }
}
main().catch(e => { console.error('SMOKE FATAL:', e.message); try { process.exit(1); } catch (_) {} });
