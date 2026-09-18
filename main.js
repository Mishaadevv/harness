/* Zeqou Harness — Electron main process
 * Responsibilities: window lifecycle, encrypted secret vault (safeStorage),
 * persistent state file, project filesystem sandbox, provider HTTP gateway
 * (avoids renderer CORS, keeps API keys in main), MCP connectors, logging.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, net } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { spawn } = require('child_process');

const isDev = process.argv.includes('--dev');
let win = null;

// ---------- Paths ----------
function userDir() { return app.getPath('userData'); }
function statePath() { return path.join(userDir(), 'zeqou-state.json'); }
function secretsPath() { return path.join(userDir(), 'zeqou-secrets.bin'); }
function logsPath() { return path.join(userDir(), 'zeqou-logs.jsonl'); }
function projectsRoot() { return path.join(userDir(), 'projects'); }

function ensureDirs() {
  for (const p of [userDir(), projectsRoot()]) {
    try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
  }
}

// ---------- Logging ----------
function appendLog(entry) {
  try {
    const line = JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(logsPath(), line);
  } catch (_) {}
}

// ---------- Secrets vault (safeStorage encrypted at rest) ----------
function loadSecrets() {
  try {
    if (!fs.existsSync(secretsPath())) return {};
    const raw = fs.readFileSync(secretsPath());
    if (!safeStorage.isEncryptionAvailable()) {
      try { return JSON.parse(raw.toString('utf8')); } catch { return {}; }
    }
    const dec = safeStorage.decryptString(raw);
    return JSON.parse(dec || '{}');
  } catch (e) { appendLog({ kind: 'secrets-load-error', error: String(e) }); return {}; }
}
function saveSecrets(obj) {
  try {
    const s = JSON.stringify(obj);
    if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(secretsPath(), safeStorage.encryptString(s));
    else fs.writeFileSync(secretsPath(), s, 'utf8');
  } catch (e) { appendLog({ kind: 'secrets-save-error', error: String(e) }); }
}
function maskKey(k) {
  if (!k || typeof k !== 'string') return '';
  if (k.length <= 8) return '••••••••';
  return k.slice(0, 3) + '••••••••' + k.slice(-4);
}

// ---------- Window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Zeqou Harness',
    icon: path.join(__dirname, 'ico.png'),
    backgroundColor: '#0b0e13',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  ensureDirs();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------- State file ----------
ipcMain.handle('zeqou:state:load', async () => {
  try {
    if (!fs.existsSync(statePath())) return null;
    return JSON.parse(await fsp.readFile(statePath(), 'utf8'));
  } catch (e) { appendLog({ kind: 'state-load-error', error: String(e) }); return null; }
});
ipcMain.handle('zeqou:state:save', async (_e, state) => {
  try {
    await fsp.writeFile(statePath(), JSON.stringify(state), 'utf8');
    return true;
  } catch (e) { appendLog({ kind: 'state-save-error', error: String(e) }); return false; }
});
ipcMain.handle('zeqou:state:path', async () => statePath());
ipcMain.handle('zeqou:logs:tail', async (_e, n = 200) => {
  try {
    if (!fs.existsSync(logsPath())) return [];
    const txt = await fsp.readFile(logsPath(), 'utf8');
    return txt.trim().split('\n').slice(-n).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch { return []; }
});

// ---------- Secrets ----------
ipcMain.handle('zeqou:secrets:set', async (_e, { key, value }) => {
  const s = loadSecrets(); s[key] = value; saveSecrets(s);
  appendLog({ kind: 'secret-set', key });
  return { ok: true, masked: maskKey(value) };
});
ipcMain.handle('zeqou:secrets:get-masked', async (_e, { key }) => {
  const s = loadSecrets();
  const v = s[key] || '';
  return { masked: v ? maskKey(v) : '', has: !!v };
});
ipcMain.handle('zeqou:secrets:has', async (_e, { key }) => ({ has: !!loadSecrets()[key] }));
ipcMain.handle('zeqou:secrets:delete', async (_e, { key }) => {
  const s = loadSecrets(); delete s[key]; saveSecrets(s);
  appendLog({ kind: 'secret-delete', key });
  return { ok: true };
});

// ---------- Dialogs / shell ----------
ipcMain.handle('zeqou:dialog:openFiles', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  if (r.canceled) return [];
  const out = [];
  for (const fp of r.filePaths) {
    try {
      const st = await fsp.stat(fp);
      out.push({ path: fp, name: path.basename(fp), size: st.size });
    } catch (_) {}
  }
  return out;
});
ipcMain.handle('zeqou:dialog:readFileBuffer', async (_e, fp) => {
  try {
    const buf = await fsp.readFile(fp);
    if (buf.length > 6 * 1024 * 1024) return { ok: false, error: 'File is larger than 6 MB' };
    return { ok: true, base64: buf.toString('base64'), name: path.basename(fp) };
  } catch (e) { return { ok: false, error: String(e) }; }
});
ipcMain.handle('zeqou:dialog:openDirectory', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});
ipcMain.handle('zeqou:shell:openExternal', async (_e, url) => { await shell.openExternal(url); return true; });

// ---------- Project filesystem ----------
// Default root: sandboxed userData/projects/<id>. A project may instead link
// any local folder on disk (user-picked via dialog); `base` carries that path.
function resolveRoot(projectId, base) {
  if (base && path.isAbsolute(base)) {
    try { if (fs.statSync(base).isDirectory()) return base; } catch (_) {}
  }
  return path.join(projectsRoot(), String(projectId || 'default'));
}

// ---------- Project filesystem (sandboxed storage or a linked local folder) ----------
function safeJoin(root, rel) {
  const p = path.normalize(path.join(root, rel || ''));
  const normRoot = path.normalize(root);
  if (p !== normRoot && !p.startsWith(normRoot + path.sep)) throw new Error('Path escapes project root');
  return p;
}
ipcMain.handle('zeqou:fs:list', async (_e, { projectId, rel = '', base }) => {
  const root = resolveRoot(projectId, base);
  await fsp.mkdir(root, { recursive: true });
  const dir = safeJoin(root, rel);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const st = await fsp.stat(full);
    out.push({ name: e.name, isDir: e.isDirectory(), size: st.size, mtime: st.mtimeMs, rel: path.relative(root, full) });
  }
  out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { ok: true, entries: out, root };
});
ipcMain.handle('zeqou:fs:read', async (_e, { projectId, rel, base }) => {
  try {
    const root = resolveRoot(projectId, base);
    const full = safeJoin(root, rel);
    const st = await fsp.stat(full);
    if (st.size > 2 * 1024 * 1024) return { ok: false, error: 'File too large to preview (2 MB limit)' };
    const buf = await fsp.readFile(full);
    const ext = path.extname(full).toLowerCase();
    const imgExt = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'];
    if (imgExt.includes(ext)) return { ok: true, kind: 'image', base64: buf.toString('base64'), ext };
    return { ok: true, kind: 'text', text: buf.toString('utf8').slice(0, 500000), ext };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('zeqou:fs:write', async (_e, { projectId, rel, text, base }) => {
  try {
    const root = resolveRoot(projectId, base);
    const full = safeJoin(root, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, String(text ?? ''), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('zeqou:fs:mkdir', async (_e, { projectId, rel, base }) => {
  try {
    const root = resolveRoot(projectId, base);
    await fsp.mkdir(safeJoin(root, rel), { recursive: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('zeqou:fs:rm', async (_e, { projectId, rel, base }) => {
  try {
    const root = resolveRoot(projectId, base);
    await fsp.rm(safeJoin(root, rel), { recursive: true, force: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('zeqou:fs:import', async (_e, { projectId, srcPath, base }) => {
  try {
    const root = resolveRoot(projectId, base);
    await fsp.mkdir(root, { recursive: true });
    const name = path.basename(srcPath);
    await fsp.copyFile(srcPath, path.join(root, name));
    return { ok: true, name };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// =====================================================================
// Provider gateway — real HTTP to AI APIs from main (no CORS, keys stay
// in main). Supports OpenAI-compatible chat completions + streaming.
// =====================================================================
const activeStreams = new Map(); // requestId -> { aborted }

function buildHeaders(provider, apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) {
    const mode = provider.authMode || 'bearer';
    if (mode === 'bearer') h.Authorization = 'Bearer ' + apiKey;
    else if (mode === 'x-api-key') h['x-api-key'] = apiKey;
    else if (mode === 'api-key') h['api-key'] = apiKey; // Azure OpenAI / Anthropic-style headers
    else if (mode === 'none') { /* key in query or custom */ }
  }
  if (provider.organization) {
    if (/anthropic/i.test(provider.type || '')) h['anthropic-organization'] = provider.organization;
    else h['OpenAI-Organization'] = provider.organization;
  }
  if (provider.projectId) h['OpenAI-Project'] = provider.projectId;
  Object.assign(h, provider.customHeaders || {});
  return h;
}

function openAIChatBody(provider, model, messages, opts) {
  const body = { model, messages, stream: !!opts.stream };
  if (opts.temperature != null && opts.temperature !== '') body.temperature = Number(opts.temperature);
  if (opts.maxTokens != null && opts.maxTokens !== '') body.max_tokens = Number(opts.maxTokens);
  if (opts.reasoningEffort && opts.reasoningEffort !== 'off') {
    body.reasoning_effort = opts.reasoningEffort; // OpenAI o-series / compatible
    body.reasoning = { effort: opts.reasoningEffort };
  }
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools;
    if (opts.toolChoice) body.tool_choice = opts.toolChoice;
  }
  if (opts.responseFormat) body.response_format = opts.responseFormat;
  return body;
}

async function doFetchJSON(url, { method = 'GET', headers = {}, body = null, timeoutMs = 30000 }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    return { status: res.status, ok: res.ok, json, text: text.slice(0, 8000) };
  } finally { clearTimeout(t); }
}

ipcMain.handle('zeqou:ai:test', async (_e, { provider }) => {
  try {
    const secrets = loadSecrets();
    const apiKey = secrets['provider:' + provider.id] || '';
    if ((provider.authMode || 'bearer') !== 'none' && !apiKey) {
      return { ok: false, error: 'No API key saved for this provider. Save a key first.' };
    }
    const base = (provider.baseURL || '').replace(/\/+$/, '');
    if (!base) return { ok: false, error: 'Base URL is empty.' };
    const headers = buildHeaders(provider, apiKey);
    // Prefer /models discovery
    const r = await doFetchJSON(base + '/models', { headers, timeoutMs: 20000 });
    if (r.ok) {
      const n = r.json && Array.isArray(r.json.data) ? r.json.data.length : 0;
      appendLog({ kind: 'provider-test-ok', provider: provider.id, models: n });
      return { ok: true, detail: `Connected. ${n} model(s) discovered.`, count: n };
    }
    // Fallback: minimal chat probe for endpoints without /models
    if (provider.probeModel) {
      const body = openAIChatBody(provider, provider.probeModel, [{ role: 'user', content: 'ping' }], { stream: false, maxTokens: 4 });
      const r2 = await doFetchJSON(base + '/chat/completions', { method: 'POST', headers, body, timeoutMs: 25000 });
      if (r2.ok) return { ok: true, detail: 'Connected (chat probe succeeded).' };
      return { ok: false, error: `HTTP ${r2.status}: ${(r2.json && (r2.json.error?.message || JSON.stringify(r2.json))) || r2.text || 'request failed'}`.slice(0, 500) };
    }
    return { ok: false, error: `HTTP ${r.status}: ${(r.json && (r.json.error?.message || JSON.stringify(r.json))) || r.text || 'request failed'}`.slice(0, 500) };
  } catch (e) { appendLog({ kind: 'provider-test-error', error: String(e) }); return { ok: false, error: String(e.message || e).slice(0, 500) }; }
});

ipcMain.handle('zeqou:ai:models', async (_e, { provider }) => {
  try {
    const secrets = loadSecrets();
    const apiKey = secrets['provider:' + provider.id] || '';
    const base = (provider.baseURL || '').replace(/\/+$/, '');
    const headers = buildHeaders(provider, apiKey);
    const r = await doFetchJSON(base + '/models', { headers, timeoutMs: 25000 });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}: ${(r.json && (r.json.error?.message || '')) || r.text || 'failed'}`.slice(0, 500) };
    const list = (r.json && r.json.data ? r.json.data : []).map(m => ({ id: m.id, owned_by: m.owned_by, created: m.created }));
    return { ok: true, models: list };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 500) }; }
});

// Streaming chat: main fetches with stream:true (SSE) and forwards chunks.
ipcMain.handle('zeqou:ai:chat', async (event, { requestId, provider, model, messages, opts = {} }) => {
  const wc = event.sender;
  const send = (type, payload) => { try { wc.send('zeqou:ai:stream', { requestId, type, ...payload }); } catch (_) {} };
  const ctrl = new AbortController();
  activeStreams.set(requestId, ctrl);
  try {
    const secrets = loadSecrets();
    const apiKey = secrets['provider:' + provider.id] || '';
    if ((provider.authMode || 'bearer') !== 'none' && !apiKey) {
      send('error', { error: 'No API key saved for this provider.' });
      return { ok: false };
    }
    const base = (provider.baseURL || '').replace(/\/+$/, '');
    const headers = { ...buildHeaders(provider, apiKey), Accept: 'text/event-stream' };
    const body = openAIChatBody(provider, model, messages, { ...opts, stream: true });
    appendLog({ kind: 'ai-chat-start', provider: provider.id, model });
    const res = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      let msg = `HTTP ${res.status}`;
      try { const j = JSON.parse(t); msg += ': ' + (j.error?.message || JSON.stringify(j)).slice(0, 600); }
      catch { msg += ': ' + t.slice(0, 600); }
      send('error', { error: msg });
      appendLog({ kind: 'ai-chat-error', provider: provider.id, error: msg.slice(0, 300) });
      return { ok: false };
    }
    send('start', {});
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    const toolCalls = {};
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for (const part of parts) {
        const lines = part.split('\n');
        for (const ln of lines) {
          const line = ln.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const delta = j.choices && j.choices[0] && j.choices[0].delta ? j.choices[0].delta : {};
            // reasoning deltas (deepseek-reasoner, o-series style passthrough)
            const reasoning = delta.reasoning_content || delta.reasoning || '';
            if (reasoning) { send('reasoning', { text: reasoning }); full += ''; }
            if (delta.content) { full += delta.content; send('token', { text: delta.content }); }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const i = tc.index ?? 0;
                toolCalls[i] = toolCalls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } };
                if (tc.id) toolCalls[i].id = tc.id;
                if (tc.function) {
                  if (tc.function.name) toolCalls[i].function.name += tc.function.name;
                  if (tc.function.arguments) toolCalls[i].function.arguments += tc.function.arguments;
                }
              }
              send('tool_delta', { toolCalls: Object.values(toolCalls) });
            }
          } catch (_) {}
        }
      }
    }
    const finished = Object.values(toolCalls).filter(t => t.function && t.function.name);
    send('done', { toolCalls: finished });
    appendLog({ kind: 'ai-chat-done', provider: provider.id, chars: full.length, toolCalls: finished.length });
    return { ok: true };
  } catch (e) {
    if (e && e.name === 'AbortError') { send('aborted', {}); return { ok: false, aborted: true }; }
    send('error', { error: String(e.message || e).slice(0, 600) });
    return { ok: false };
  } finally { activeStreams.delete(requestId); }
});

ipcMain.handle('zeqou:ai:abort', async (_e, { requestId }) => {
  const c = activeStreams.get(requestId);
  if (c) { try { c.abort(); } catch (_) {} return true; }
  return false;
});

// =====================================================================
// MCP connectors — real JSON-RPC 2.0 client.
//  • stdio: persistent child process per server (spawned once, reused),
//    initialize handshake + notifications/initialized, best-effort
//    notifications/cancelled on timeout, idle reaper.
//  • http: Streamable HTTP transport (POST JSON-RPC with Accept:
//    application/json, text/event-stream; parses SSE or JSON replies,
//    honors Mcp-Session-Id with transparent re-initialize).
//  • sse: legacy HTTP+SSE transport (GET stream for the endpoint event,
//    POST messages to that endpoint, response arrives on the stream).
// =====================================================================
const MCP_PROTOCOL_VERSION = '2025-03-26';
const MCP_CLIENT_INFO = { name: 'zeqou-harness', version: '1.2.0' };

let mcpRpcId = 100;
const mcpSessions = new Map(); // sessionKey -> stdio session | http session

function mcpSessionKey(server) {
  return server.transport + '|' + (server.transport === 'stdio'
    ? (server.command || '') + ' ' + JSON.stringify(server.args || []) + ' ' + JSON.stringify(server.env || {})
    : (server.url || '') + ' ' + JSON.stringify(server.headers || {}));
}

/* Split an SSE buffer into complete events; returns parsed data payloads. */
function parseSseData(buf) {
  const msgs = [];
  const events = buf.split('\n\n');
  for (const ev of events) {
    const dataLines = ev.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart());
    if (!dataLines.length) continue;
    try { msgs.push(JSON.parse(dataLines.join('\n'))); } catch (_) {}
  }
  return msgs;
}

/* ---- stdio transport: persistent child process ---- */
function mcpStdioRaw(sess, msg, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      sess.pending.delete(msg.id);
      try { sess.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: msg.id } }) + '\n'); } catch (_) {}
      resolve({ error: { code: -1, message: 'Timed out waiting for MCP server (' + Math.round((timeoutMs || 30000) / 1000) + 's)' } });
    }, timeoutMs || 30000);
    sess.pending.set(msg.id, { resolve: (v) => { if (settled) return; settled = true; clearTimeout(t); resolve(v); } });
    try { sess.child.stdin.write(JSON.stringify(msg) + '\n'); }
    catch (e) {
      if (!settled) { settled = true; clearTimeout(t); sess.pending.delete(msg.id); resolve({ error: { code: -1, message: 'MCP server is not running: ' + String(e.message || e) } }); }
    }
  });
}

function mcpStdioRequest(server, method, params, timeoutMs) {
  const key = mcpSessionKey(server);
  let sess = mcpSessions.get(key);
  const alive = sess && sess.kind === 'stdio' && sess.child && sess.child.pid && !sess.broken;
  if (!alive) {
    if (sess) { try { sess.child.kill(); } catch (_) {} mcpSessions.delete(key); }
    const child = spawn(server.command, server.args || [], {
      shell: false, windowsHide: true,
      env: { ...process.env, ...(server.env || {}) }
    });
    sess = { kind: 'stdio', child, pending: new Map(), buf: '', readyPromise: null, lastUsed: Date.now() };
    mcpSessions.set(key, sess);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      sess.buf += d;
      let idx;
      while ((idx = sess.buf.indexOf('\n')) >= 0) {
        const line = sess.buf.slice(0, idx).trim();
        sess.buf = sess.buf.slice(idx + 1);
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.id != null && sess.pending.has(j.id)) {
          const p = sess.pending.get(j.id);
          sess.pending.delete(j.id);
          p.resolve(j);
        }
      }
    });
    child.stderr.on('data', () => {}); // servers log verbosely on stderr; ignore
    child.on('exit', () => {
      for (const [, p] of sess.pending) p.resolve({ error: { code: -1, message: 'MCP server process exited' } });
      sess.pending.clear();
      if (mcpSessions.get(key) === sess) mcpSessions.delete(key);
    });
    child.on('error', () => {
      sess.broken = true;
      for (const [, p] of sess.pending) p.resolve({ error: { code: -1, message: 'Failed to start MCP server process' } });
      sess.pending.clear();
      if (mcpSessions.get(key) === sess) mcpSessions.delete(key);
    });
    sess.readyPromise = (async () => {
      const init = await mcpStdioRaw(sess, { jsonrpc: '2.0', id: ++mcpRpcId, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT_INFO } }, 20000);
      if (init.error) throw new Error(init.error.message || 'MCP initialize failed');
      try { sess.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); } catch (_) {}
      return init.result || {};
    })();
    sess.readyPromise.catch(() => {
      sess.broken = true;
      try { sess.child.kill(); } catch (_) {}
      if (mcpSessions.get(key) === sess) mcpSessions.delete(key);
    });
  }
  sess.lastUsed = Date.now();
  return sess.readyPromise.then(() => mcpStdioRaw(sess, { jsonrpc: '2.0', id: ++mcpRpcId, method, params }, timeoutMs));
}

/* ---- Streamable HTTP transport ---- */
async function mcpHttpRpc(server, method, params, timeoutMs) {
  const base = (server.url || '').replace(/\/+$/, '');
  const key = mcpSessionKey(server);
  const sess = mcpSessions.get(key) || {};
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    ...(server.headers || {})
  };
  if (sess.sessionId) headers['Mcp-Session-Id'] = sess.sessionId;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
  try {
    const res = await fetch(base, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++mcpRpcId, method, params }),
      signal: ctrl.signal
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) mcpSessions.set(key, { kind: 'http', sessionId: sid });
    const ctype = res.headers.get('content-type') || '';
    const text = await res.text();
    let msg = null;
    if (/text\/event-stream/i.test(ctype)) {
      const msgs = parseSseData(text);
      msg = msgs.find(m => m && m.id != null) || null;
    } else if (text) {
      try { msg = JSON.parse(text); } catch (_) {}
    }
    if (!res.ok && !msg) return { error: { code: res.status, message: 'HTTP ' + res.status + ': ' + text.slice(0, 300) } };
    if (!msg) return { error: { code: -1, message: 'Empty response from MCP endpoint' } };
    return msg;
  } catch (e) {
    return { error: { code: -1, message: String(e.message || e) } };
  } finally { clearTimeout(t); }
}

/* ---- Legacy HTTP+SSE transport ---- */
async function mcpSseOpen(server) {
  const base = (server.url || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(base, { headers: { Accept: 'text/event-stream', ...(server.headers || {}) }, signal: ctrl.signal });
    if (!res.ok || !res.body) { clearTimeout(t); return { ok: false, error: 'HTTP ' + res.status + ' on SSE stream' }; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', endpoint = null;
    const deadline = Date.now() + 10000;
    while (!endpoint && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop() || '';
      for (const ev of events) {
        let isEndpoint = false, data = '';
        for (const ln of ev.split('\n')) {
          if (ln.startsWith('event:')) isEndpoint = ln.slice(6).trim() === 'endpoint';
          else if (ln.startsWith('data:')) data += ln.slice(5).trimStart();
        }
        if (data && (isEndpoint || /^\/?messages|https?:|^\/[^\s]*\?/.test(data))) endpoint = new URL(data, base).toString();
      }
    }
    clearTimeout(t);
    if (!endpoint) {
      try { reader.cancel(); } catch (_) {}
      try { ctrl.abort(); } catch (_) {}
      return { ok: false, error: 'No endpoint event received from SSE server' };
    }
    return { ok: true, reader, dec, ctrl, endpoint, buf };
  } catch (e) {
    clearTimeout(t);
    try { ctrl.abort(); } catch (_) {}
    return { ok: false, error: String(e.message || e).slice(0, 300) };
  }
}

async function mcpSseRpc(server, method, params, timeoutMs = 30000) {
  const open = await mcpSseOpen(server);
  if (!open.ok) return { error: { code: -1, message: open.error } };
  const { reader, dec, ctrl, endpoint } = open;
  let buf = open.buf || '';
  const id = ++mcpRpcId;
  try {
    const post = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(server.headers || {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: ctrl.signal
    });
    if (!post.ok && post.status !== 202) {
      const txt = await post.text().catch(() => '');
      return { error: { code: post.status, message: 'HTTP ' + post.status + ': ' + txt.slice(0, 300) } };
    }
    const deadline = Date.now() + (timeoutMs || 30000);
    for (;;) {
      if (Date.now() > deadline) return { error: { code: -1, message: 'Timed out waiting for MCP response' } };
      const { done, value } = await reader.read();
      if (done) return { error: { code: -1, message: 'SSE stream closed before response' } };
      buf += dec.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop() || '';
      for (const ev of events) {
        for (const ln of ev.split('\n')) {
          if (!ln.startsWith('data:')) continue;
          let j; try { j = JSON.parse(ln.slice(5).trim()); } catch { continue; }
          if (j && j.id === id) return j;
        }
      }
    }
  } catch (e) {
    return { error: { code: -1, message: String(e.message || e).slice(0, 300) } };
  } finally {
    try { reader.cancel(); } catch (_) {}
    try { ctrl.abort(); } catch (_) {}
  }
}

/* Unified dispatcher with one transparent re-try when an HTTP session expired. */
async function mcpRpc(server, method, params, timeoutMs) {
  if (server.transport === 'stdio') {
    try { return await mcpStdioRequest(server, method, params, timeoutMs); }
    catch (e) { return { error: { code: -1, message: String(e.message || e) } }; }
  }
  if (server.transport === 'http') {
    let r = await mcpHttpRpc(server, method, params, timeoutMs);
    if (r.error && /session/i.test(r.error.message || '')) {
      mcpSessions.delete(mcpSessionKey(server));
      r = await mcpHttpRpc(server, method, params, timeoutMs);
    }
    return r;
  }
  return mcpSseRpc(server, method, params, timeoutMs);
}

/* Close idle stdio servers so npx processes don't pile up. */
setInterval(() => {
  const ts = Date.now();
  for (const [k, s] of mcpSessions) {
    if (s.kind === 'stdio' && ts - (s.lastUsed || 0) > 5 * 60 * 1000) {
      try { s.child.kill(); } catch (_) {}
      mcpSessions.delete(k);
    }
  }
}, 120000);

function formatMcpContent(res) {
  if (!res) return '(empty result)';
  if (res.isError && Array.isArray(res.content)) {
    return 'Tool reported an error: ' + formatMcpContent({ content: res.content });
  }
  if (res.structuredContent) return JSON.stringify(res.structuredContent, null, 2).slice(0, 10000);
  const c = res.content;
  if (Array.isArray(c)) {
    const out = c.map(b => {
      if (typeof b.text === 'string') return b.text;
      if (b.resource && typeof b.resource === 'object') {
        const r = b.resource;
        if (typeof r.text === 'string') return (r.uri ? r.uri + '\n' : '') + r.text;
        if (r.blob) return '[resource ' + (r.uri || '') + ': ' + String(r.blob).slice(0, 120) + '…]';
      }
      if (b.type === 'image' && b.data) return '[image ' + (b.mimeType || 'data') + ': ' + String(b.data).slice(0, 120) + '…]';
      if (b.data) return '[' + (b.mimeType || 'data') + ': ' + String(b.data).slice(0, 200) + '…]';
      return JSON.stringify(b).slice(0, 400);
    }).join('\n');
    return (out || '(empty result)').slice(0, 10000);
  }
  return JSON.stringify(res).slice(0, 10000);
}

ipcMain.handle('zeqou:mcp:test', async (_e, { server }) => {
  try {
    if (server.transport === 'stdio') {
      if (!server.command) return { ok: false, error: 'Command is empty.' };
      const r = await mcpRpc(server, 'initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT_INFO }, 20000);
      if (r.error) return { ok: false, error: String(r.error.message || 'MCP handshake failed').slice(0, 400) };
      const info = r.result && r.result.serverInfo && r.result.serverInfo.name ? ' — ' + r.result.serverInfo.name : '';
      return { ok: true, detail: 'MCP handshake OK' + info };
    }
    if (server.transport === 'http') {
      if (!server.url) return { ok: false, error: 'URL is empty.' };
      const r = await mcpRpc(server, 'initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT_INFO }, 15000);
      if (!r.error) {
        const info = r.result && r.result.serverInfo && r.result.serverInfo.name ? ' — ' + r.result.serverInfo.name : '';
        return { ok: true, detail: 'MCP handshake OK' + info };
      }
      // Endpoint reachable but didn't answer initialize (e.g. simple bridge).
      try {
        const res = await fetch(server.url, { headers: server.headers || {} });
        if (res.ok || res.status === 405) return { ok: true, detail: 'Reachable (HTTP ' + res.status + '); no MCP handshake.' };
        return { ok: false, error: 'HTTP ' + res.status + '; ' + String(r.error.message || '').slice(0, 200) };
      } catch (e2) {
        return { ok: false, error: String(e2.message || e2).slice(0, 300) };
      }
    }
    if (server.transport === 'sse') {
      if (!server.url) return { ok: false, error: 'URL is empty.' };
      const open = await mcpSseOpen(server);
      if (!open.ok) return { ok: false, error: open.error };
      try { open.reader.cancel(); } catch (_) {}
      try { open.ctrl.abort(); } catch (_) {}
      return { ok: true, detail: 'SSE stream OK.' };
    }
    return { ok: false, error: 'Unknown transport.' };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 400) }; }
});

ipcMain.handle('zeqou:mcp:list-tools', async (_e, { server }) => {
  try {
    const r = await mcpRpc(server, 'tools/list', {}, 25000);
    if (r.error) {
      // Fallback for simple HTTP bridges that expose a plain /tools listing.
      if ((server.transport === 'http' || server.transport === 'sse') && server.url) {
        try {
          const g = await fetch(server.url.replace(/\/+$/, '') + '/tools', { headers: server.headers || {} });
          if (g.ok) {
            const j = await g.json().catch(() => null);
            const tools = (j && (j.tools || j.data)) || [];
            if (Array.isArray(tools)) return { ok: true, tools: tools.map(x => ({ name: x.name || x.id, description: x.description || '', inputSchema: x.inputSchema || {} })) };
          }
        } catch (_) {}
      }
      return { ok: false, error: String(r.error.message || 'tools/list failed').slice(0, 400) };
    }
    const tools = (r.result && r.result.tools) || [];
    return { ok: true, tools: tools.map(x => ({ name: x.name, description: x.description || '', inputSchema: x.inputSchema || {} })) };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 400) }; }
});

ipcMain.handle('zeqou:mcp:call', async (_e, { server, tool, args }) => {
  try {
    const r = await mcpRpc(server, 'tools/call', { name: tool, arguments: args || {} }, 60000);
    if (r.error) return { ok: false, error: String(r.error.message || JSON.stringify(r.error)).slice(0, 400) };
    return { ok: true, result: formatMcpContent(r.result) };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 400) }; }
});

// Shell execution for the shell_exec tool. No shell: command + argv only,
// confined to the project folder, hard timeout, truncated output.
ipcMain.handle('zeqou:tools:exec', async (_e, { command, args = [], cwd = null, base = null, projectId = null, timeoutMs = 30000 }) => {
  try {
    if (!command || typeof command !== 'string') return { ok: false, error: 'Empty command' };
    const root = resolveRoot(projectId, base || cwd);
    const argv = Array.isArray(args) ? args.map(String) : String(args || '').split(/\s+/).filter(Boolean);
    const child = spawn(command, argv, { cwd: root, timeout: Math.min(120000, Number(timeoutMs) || 30000), windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString(); if (out.length > 100000) out = out.slice(0, 100000); });
    child.stderr.on('data', d => { err += d.toString(); if (err.length > 100000) err = err.slice(0, 100000); });
    const code = await new Promise((resolve) => {
      child.on('error', e => resolve('ERR:' + e.message));
      child.on('close', (c, signal) => resolve(c === null && signal ? 'TIMEOUT' : c));
    });
    if (code === 'TIMEOUT') return { ok: false, code: null, timedOut: true, stdout: out.slice(0, 20000), stderr: (err + '\n[command timed out]').slice(0, 8000) };
    if (typeof code === 'string') return { ok: false, error: code.slice(0, 300) };
    return { ok: code === 0, code, stdout: out.slice(0, 20000), stderr: err.slice(0, 8000) };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 300) }; }
});
