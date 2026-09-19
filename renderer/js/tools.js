/* Built-in tools + custom tool registry + safe executor.
 * Tools are exposed to models as OpenAI function tools. Execution is real
 * (calculator, datetime, file read, web search via pluggable endpoint) and
 * every call is recorded in toolCalls history with permission gating.
 */
import { uid, now } from './utils.js';

export const BUILTIN_TOOLS = [
  {
    id: 'calculator', name: 'calculator',
    description: 'Evaluate a math expression safely (numbers, + - * / % ^, parentheses, sqrt, sin, cos, log).',
    parameters: { type: 'object', properties: { expression: { type: 'string', description: 'e.g. (12.5*3+sqrt(16))/2' } }, required: ['expression'] },
    permissions: 'safe', timeoutMs: 5000
  },
  {
    id: 'datetime', name: 'get_datetime',
    description: 'Get the current date/time (optionally in an IANA timezone).',
    parameters: { type: 'object', properties: { timezone: { type: 'string', description: 'e.g. Europe/Berlin' } } },
    permissions: 'safe', timeoutMs: 3000
  },
  {
    id: 'web_search', name: 'web_search',
    description: 'Search the web (needs an endpoint in Tools settings).',
    parameters: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number', description: '1-10' } }, required: ['query'] },
    permissions: 'network', timeoutMs: 20000
  },
  {
    id: 'project_files', name: 'project_files',
    description: 'List files in the active project (sandboxed).',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Subfolder, empty for root' } } },
    permissions: 'files', timeoutMs: 8000
  },
  {
    id: 'read_file', name: 'read_file',
    description: 'Read a text file from the active project (2 MB limit).',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative path inside project' } }, required: ['path'] },
    permissions: 'files', timeoutMs: 8000
  },
  {
    id: 'edit_file', name: 'edit_file',
    description: 'Replace an exact text snippet inside a project file. Use for surgical edits; fails loudly if the snippet is not found (then read the file and retry).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path inside project' },
        oldText: { type: 'string', description: 'Exact existing text to replace (must be unique in the file)' },
        newText: { type: 'string', description: 'Replacement text' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false)' }
      },
      required: ['path', 'oldText', 'newText']
    },
    permissions: 'files', timeoutMs: 8000
  },
  {
    id: 'search_files', name: 'search_files',
    description: 'Search text inside project files (regex, case-insensitive by default). Returns file path, line number and the matching line, truncated to the first 200 matches.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regular expression to find' },
        path: { type: 'string', description: 'Subfolder to search, empty for whole project' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression' },
        caseSensitive: { type: 'boolean', description: 'Case-sensitive matching (default false)' },
        glob: { type: 'string', description: 'Optional filename filter, e.g. "*.js"' }
      },
      required: ['query']
    },
    permissions: 'files', timeoutMs: 20000
  },
  {
    id: 'write_file', name: 'write_file',
    description: 'Create or overwrite a text file in the active project.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    permissions: 'files', timeoutMs: 8000
  },
  {
    id: 'fetch_url', name: 'fetch_url',
    description: 'Fetch a URL and return its text (up to a character limit).',
    parameters: { type: 'object', properties: { url: { type: 'string' }, maxChars: { type: 'number' } }, required: ['url'] },
    permissions: 'network', timeoutMs: 20000
  },
  {
    id: 'shell', name: 'shell_exec',
    description: 'Run a command (program + arguments, no shell) inside the project folder. Stdout/stderr are returned. Always asks for approval first.',
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'Program, e.g. "git"' }, args: { type: 'string', description: 'Space-separated arguments' } }, required: ['command'] },
    permissions: 'danger', timeoutMs: 60000
  },
  {
    id: 'compact_context', name: 'compact_context',
    description: 'Compress older conversation history into a compact running summary to free context window space. Call this when the conversation is long, the context is running low, or before a big new task. Recent messages stay verbatim; nothing is deleted from the chat UI.',
    parameters: {
      type: 'object',
      properties: {
        instructions: { type: 'string', description: 'Optional: what to emphasize or preserve in the summary' }
      }
    },
    permissions: 'safe', timeoutMs: 90000
  },
  {
    id: 'todo', name: 'todo',
    description: 'Manage your own task list (a todo list the user can watch live in the Tasks panel). Actions: add — create a task (optionally with a one-line plan); update — change title/plan/priority; status — mark pending|doing|done; remove — delete; list — show the current list. Use it for any multi-step job: plan the steps first, mark a task doing when you start it and done when it is finished, so the user can follow progress.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'add | update | status | remove | list', enum: ['add', 'update', 'status', 'remove', 'list'] },
        id: { type: 'string', description: 'Task id (returned when created; list shows ids). Required for update/status/remove.' },
        title: { type: 'string', description: 'Task title (add/update)' },
        plan: { type: 'string', description: 'One-line plan or note for how you will do it (add/update, optional)' },
        priority: { type: 'string', description: 'low | normal | high (add/update, optional)' },
        status: { type: 'string', description: 'pending | doing | done (status action)', enum: ['pending', 'doing', 'done'] },
        chatId: { type: 'string', description: 'Internal — set automatically by the harness' }
      },
      required: ['action']
    },
    permissions: 'safe', timeoutMs: 3000
  }
];

export function toolToOpenAI(t) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } } };
}

export function enabledOpenAITools(state, chat) {
  const useTools = chat ? chat.toolsOn : state.composer.toolsOn;
  const useWeb = chat ? chat.webOn : state.composer.webOn;
  if (!useTools && !useWeb) return [];
  let list = state.tools.filter(t => t.enabled);
  if (chat) {
    const proj = state.projects.find(p => p.id === chat.projectId);
    if (proj && proj.tools && proj.tools.length) {
      const only = new Set(proj.tools);
      list = list.filter(t => only.has(t.id));
    }
  }
  if (!useTools) list = list.filter(t => t.id === 'web_search');
  if (!useWeb) list = list.filter(t => t.id !== 'web_search');
  // Defensive: duplicate function names make strict providers (Gemini)
  // reject the entire request with INVALID_ARGUMENT.
  const seen = new Set();
  return list.filter(t => (seen.has(t.name) ? false : (seen.add(t.name), true))).map(toolToOpenAI);
}

/* One system-prompt line naming every tool the model can actually call.
 * Without it small models assume they cannot touch files and answer
 * "copy this code into a file yourself" instead of calling write_file. */
export function toolCapabilityLine(state, chat) {
  const tools = enabledOpenAITools(state, chat);
  if (!tools.length) return '';
  const names = tools.map(t => t.function.name);
  const fs = names.filter(n => ['project_files', 'read_file', 'write_file', 'edit_file', 'search_files'].includes(n));
  const rest = names.filter(n => !fs.includes(n));
  const parts = [];
  if (fs.length) parts.push(`workspace file tools: ${fs.join(', ')} — you CAN and SHOULD create/modify files directly with write_file when asked; never tell the user to save files manually`);
  if (rest.length) parts.push(`other tools: ${rest.join(', ')}`);
  return `Available tools (call them via function calling): ${parts.join('; ')}.`;
}

/* Real execution. ctx: {projectId, webConfig} */
export async function executeTool(state, toolName, args, ctx = {}) {
  const t0 = performance.now();
  const rec = { id: uid('tc'), tool: toolName, args, ok: false, result: '', at: now(), chatId: ctx.chatId || null, ms: 0 };
  try {
    let out = '';
    if (toolName === 'calculator') out = runCalculator(String(args.expression || ''));
    else if (toolName === 'get_datetime') out = runDatetime(args.timezone);
    else if (toolName === 'web_search') out = await runWebSearch(String(args.query || ''), Number(args.count || 5), ctx.webConfig);
    else if (toolName === 'project_files') out = await runProjectFiles(ctx.projectId, ctx.base, String(args.path || ''));
    else if (toolName === 'read_file') out = await runReadFile(ctx.projectId, ctx.base, String(args.path || ''));
    else if (toolName === 'edit_file') out = await runEditFile(ctx.projectId, ctx.base, String(args.path || ''), String(args.oldText ?? ''), String(args.newText ?? ''), !!args.replaceAll);
    else if (toolName === 'search_files') out = await runSearchFiles(ctx.projectId, ctx.base, String(args.query || ''), args);
    else if (toolName === 'write_file') out = await runWriteFile(ctx.projectId, ctx.base, String(args.path || ''), String(args.content ?? ''));
    else if (toolName === 'fetch_url') out = await runFetchUrl(String(args.url || ''), Number(args.maxChars || 8000));
    else if (toolName === 'shell_exec') out = await runShell(ctx, String(args.command || ''), args.args, Number(args.timeoutMs || 30000));
    else if (toolName === 'compact_context') out = await (ctx.compact
      ? ctx.compact({ instructions: args?.instructions || '' })
      : Promise.resolve('Context compaction is not available here (no active run).'));
    else if (toolName === 'todo') out = runTodo(state, args, ctx);
    else if (toolName.startsWith('mcp__')) out = await runMcpTool(state, toolName, args);
    else {
      const custom = state.tools.find(t => t.name === toolName && t.custom);
      if (custom) out = await runCustomTool(custom, args);
      else throw new Error(`Unknown tool "${toolName}"`);
    }
    rec.ok = true; rec.result = String(out).slice(0, 12000);
  } catch (e) {
    rec.ok = false; rec.result = 'Error: ' + String(e.message || e).slice(0, 2000);
  }
  rec.ms = Math.round(performance.now() - t0);
  return rec;
}

function runCalculator(expr) {
  if (!expr || expr.length > 500) throw new Error('Expression empty or too long');
  if (/[^0-9+\-*/%^().,\s_a-zA-Z]/.test(expr)) throw new Error('Invalid characters in expression');
  const scope = { sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log, abs: Math.abs, pow: Math.pow, pi: Math.PI, e: Math.E };
  const safe = expr.replace(/\^/g, '**');
  const fn = new Function(...Object.keys(scope), `"use strict"; return (${safe});`);
  const v = fn(...Object.values(scope));
  if (typeof v !== 'number' || !isFinite(v)) throw new Error('Expression did not evaluate to a number');
  return String(Math.round(v * 1e10) / 1e10);
}
function runDatetime(tz) {
  try {
    const d = new Date();
    if (tz) return d.toLocaleString('en-US', { timeZone: tz }) + ` (${tz})`;
    return d.toString();
  } catch { throw new Error('Unknown timezone'); }
}
async function runWebSearch(query, count, webConfig) {
  if (!query) throw new Error('Empty query');
  const cfg = webConfig || {};
  // If user configured a Tavily key in secrets, main can't call it (renderer fetch is fine for https with CORS *).
  // We attempt direct fetch; failure returns a clear message (no fake results).
  if (cfg.endpoint) {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.headers || {}) },
      body: JSON.stringify({ query, max_results: Math.min(10, Math.max(1, count || 5)) })
    });
    if (!res.ok) throw new Error(`Search endpoint HTTP ${res.status}`);
    const j = await res.json();
    const items = j.results || j.items || j.data || [];
    if (!items.length) return 'No results.';
    return items.slice(0, 8).map((r, i) => `${i + 1}. ${r.title || r.url}\n${r.url || ''}\n${(r.content || r.snippet || '').slice(0, 400)}`).join('\n\n');
  }
  // DuckDuckGo instant answer (no key, CORS-enabled) as a best-effort fallback
  const res = await fetch('https://api.duckduckgo.com/?format=json&no_html=1&q=' + encodeURIComponent(query));
  if (!res.ok) throw new Error('Search unavailable (configure a search endpoint in Settings → Tools).');
  const j = await res.json();
  const parts = [];
  if (j.AbstractText) parts.push(j.AbstractText + (j.AbstractURL ? ` (${j.AbstractURL})` : ''));
  for (const t of (j.RelatedTopics || []).slice(0, 6)) {
    if (t.Text) parts.push('• ' + t.Text);
  }
  return parts.length ? parts.join('\n') : 'No concise results. Configure a full search endpoint in Settings → Tools for complete web search.';
}
async function runProjectFiles(projectId, base, rel) {
  const r = await window.zeqou.fs.list({ projectId: projectId || 'personal', rel: rel || '', base: base || undefined });
  if (!r.ok) throw new Error(r.error || 'Cannot list files');
  if (!r.entries.length) return '(empty folder)';
  return r.entries.map(e => (e.isDir ? '📁 ' : '📄 ') + e.rel + (e.isDir ? '' : ` (${e.size} B)`)).join('\n');
}
async function runReadFile(projectId, base, rel) {
  const r = await window.zeqou.fs.read({ projectId: projectId || 'personal', rel, base: base || undefined });
  if (!r.ok) throw new Error(r.error || 'Cannot read file');
  if (r.kind === 'image') return `[image file: ${rel}]`;
  return r.text.slice(0, 8000);
}
async function runEditFile(projectId, base, rel, oldText, newText, replaceAll) {
  if (!rel || rel.includes('..')) throw new Error('Invalid path');
  if (!oldText) throw new Error('oldText is empty — use write_file to create files');
  const r = await window.zeqou.fs.read({ projectId: projectId || 'personal', rel, base: base || undefined });
  if (!r.ok) throw new Error(r.error || 'Cannot read file');
  if (r.kind === 'image') throw new Error('Cannot edit a binary/image file');
  const text = r.text;
  const occurrences = text.split(oldText).length - 1;
  if (occurrences === 0) {
    throw new Error('oldText not found in ' + rel + '. Read the file first and copy the exact text (including whitespace) to replace.');
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(`oldText appears ${occurrences} times in ${rel}. Provide more surrounding text to make it unique, or set replaceAll=true.`);
  }
  const updated = replaceAll
    ? text.split(oldText).join(newText)
    : text.replace(oldText, () => newText);
  const w = await window.zeqou.fs.write({ projectId: projectId || 'personal', rel, text: updated, base: base || undefined });
  if (!w.ok) throw new Error(w.error || 'Cannot write file');
  return `Edited ${rel}: ${replaceAll ? occurrences : 1} replacement(s), file is now ${updated.length} chars.`;
}
async function runSearchFiles(projectId, base, query, opts = {}) {
  if (!query) throw new Error('Empty query');
  let re;
  try {
    re = new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? '' : 'i');
  } catch (e) { throw new Error('Invalid pattern: ' + e.message); }
  const rootRel = String(opts.path || '');
  const listRes = await window.zeqou.fs.list({ projectId: projectId || 'personal', rel: rootRel, base: base || undefined });
  if (!listRes.ok) throw new Error(listRes.error || 'Cannot list project files');
  const glob = opts.glob ? globToRegExp(opts.glob) : null;
  const results = [];
  const queue = [''];
  while (queue.length && results.length < 200) {
    const dir = queue.shift();
    let entries;
    try { entries = await window.zeqou.fs.list({ projectId: projectId || 'personal', rel: dir, base: base || undefined }); }
    catch { continue; }
    if (!entries.ok) continue;
    for (const e of entries.entries) {
      if (results.length >= 200) break;
      if (e.isDir) { queue.push(e.rel); continue; }
      if (glob && !glob.test(e.name)) continue;
      let f;
      try { f = await window.zeqou.fs.read({ projectId: projectId || 'personal', rel: e.rel, base: base || undefined }); }
      catch { continue; }
      if (!f.ok || f.kind !== 'text') continue;
      const lines = f.text.split('\n');
      for (let i = 0; i < lines.length && results.length < 200; i++) {
        if (re.test(lines[i])) results.push(`${e.rel}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
      }
    }
  }
  if (!results.length) return 'No matches found.';
  return results.join('\n') + (results.length >= 200 ? '\n(truncated to first 200 matches)' : '');
}
function globToRegExp(glob) {
  const esc2 = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp('^' + esc2(glob) + '$', 'i');
}
async function runWriteFile(projectId, base, rel, content) {
  if (!rel || rel.includes('..')) throw new Error('Invalid path');
  const r = await window.zeqou.fs.write({ projectId: projectId || 'personal', rel, text: content, base: base || undefined });
  if (!r.ok) throw new Error(r.error || 'Cannot write file');
  return `Wrote ${rel} (${content.length} chars).`;
}
async function runFetchUrl(url, maxChars) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are allowed');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 18000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Zeqou-Harness/1.1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const clean = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return clean.slice(0, Math.min(20000, Math.max(500, maxChars || 8000))) || '(empty page)';
  } finally { clearTimeout(t); }
}
async function runShell(ctx, command, args, timeoutMs) {
  if (!command) throw new Error('Empty command');
  const r = await window.zeqou.tools.exec({
    command, args: typeof args === 'string' ? args : '',
    base: ctx.base || undefined, projectId: ctx.projectId || 'personal',
    timeoutMs: Math.min(120000, timeoutMs || 30000)
  });
  if (!r.ok && r.error) throw new Error(r.error);
  const tail = r.timedOut ? '\n[command timed out]' : '';
  return `$ exit ${r.code}${r.timedOut ? ' (timeout)' : ''}\n${r.stdout || ''}${r.stderr ? '\nSTDERR:\n' + r.stderr : ''}${tail}`.slice(0, 12000);
}
function mcpPayload(sv) {
  return {
    transport: sv.transport, url: sv.url, command: sv.command,
    args: String(sv.args || '').split(/\s+/).filter(Boolean),
    headers: sv.headers || {}, env: sv.env || {}
  };
}
async function runMcpTool(state, toolName, args) {
  // names look like mcp__<serverIdSuffix>__<tool>
  const rest = toolName.slice(5);
  const sep = rest.indexOf('__');
  if (sep < 0) throw new Error('Malformed MCP tool name');
  const suffix = rest.slice(0, sep), tool = rest.slice(sep + 2);
  const sv = state.mcpServers.find(s => s.enabled && s.id.endsWith(suffix));
  if (!sv) throw new Error('MCP server is disabled or missing');
  const r = await window.zeqou.mcp.call(mcpPayload(sv), tool, args || {});
  if (!r.ok) throw new Error(r.error || 'MCP call failed');
  return r.result;
}
async function runCustomTool(custom, args) {
  // Custom tools can be webhook tools: POST args as JSON to URL.
  if (custom.webhookURL) {
    const res = await fetch(custom.webhookURL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...((custom.headers) || {}) },
      body: JSON.stringify(args || {})
    });
    const t = await res.text();
    if (!res.ok) throw new Error(`Webhook HTTP ${res.status}: ${t.slice(0, 500)}`);
    return t.slice(0, 6000);
  }
  throw new Error('Custom tool has no webhook configured');
}

/* ── todo: the agent's own task list ─────────────────────────────────────
 * State lives in store.state.tasks so the Tasks panel can render it live.
 * A hook (ctx.onTaskChange) is called after every mutation so an open run
 * view repaints immediately without waiting for the next store emit. */
export const TASK_STATUSES = ['pending', 'doing', 'done'];

function taskLine(t) {
  const mark = t.status === 'done' ? '[x]' : t.status === 'doing' ? '[~]' : '[ ]';
  const prio = t.priority && t.priority !== 'normal' ? ` (${t.priority})` : '';
  const plan = t.plan ? ` — ${t.plan}` : '';
  return `${mark} #${t.id}${prio} ${t.title}${plan}`;
}

export function runTodo(state, args, ctx = {}) {
  const action = String(args.action || 'list').toLowerCase();
  state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const done = (out) => {
    ctx.onTaskChange && ctx.onTaskChange();
    return out;
  };

  if (action === 'add') {
    const title = String(args.title || '').trim();
    if (!title) throw new Error('title is required for the add action');
    if (state.tasks.length >= 100) throw new Error('Too many tasks (limit 100) — remove finished ones first');
    const task = {
      id: uid('task'),
      chatId: ctx.chatId || null,
      title: title.slice(0, 200),
      plan: String(args.plan || '').slice(0, 300) || null,
      priority: ['low', 'normal', 'high'].includes(args.priority) ? args.priority : 'normal',
      status: 'pending',
      createdAt: now(),
      updatedAt: now()
    };
    state.tasks.push(task);
    return done(`Created task ${task.id}: ${taskLine(task)}`);
  }

  const findTask = () => {
    const t = state.tasks.find(x => x.id === args.id || x.id === String(args.id || '').replace(/^#/, ''));
    if (!t) throw new Error(`Task "${args.id}" not found. Call the todo tool with action=list to see current ids.`);
    return t;
  };

  if (action === 'update') {
    const t = findTask();
    if (args.title !== undefined) { const v = String(args.title).trim(); if (v) t.title = v.slice(0, 200); }
    if (args.plan !== undefined) t.plan = String(args.plan || '').slice(0, 300) || null;
    if (args.priority !== undefined && ['low', 'normal', 'high'].includes(args.priority)) t.priority = args.priority;
    t.updatedAt = now();
    return done(`Updated task ${t.id}: ${taskLine(t)}`);
  }

  if (action === 'status') {
    const t = findTask();
    const st = String(args.status || '').toLowerCase();
    if (!TASK_STATUSES.includes(st)) throw new Error('status must be one of: pending, doing, done');
    t.status = st;
    t.updatedAt = now();
    return done(`Task ${t.id} is now ${st}: ${taskLine(t)}`);
  }

  if (action === 'remove') {
    const idx = state.tasks.findIndex(x => x.id === args.id || x.id === String(args.id || '').replace(/^#/, ''));
    if (idx < 0) throw new Error(`Task "${args.id}" not found. Call the todo tool with action=list to see current ids.`);
    const [removed] = state.tasks.splice(idx, 1);
    return done(`Removed task ${removed.id}: ${removed.title}`);
  }

  if (action === 'list') {
    if (!state.tasks.length) return 'The task list is empty. Create tasks with action=add when you plan a multi-step job.';
    const counts = TASK_STATUSES.map(s => `${state.tasks.filter(t => t.status === s).length} ${s}`).join(', ');
    return `Tasks (${counts}):\n` + state.tasks.map(taskLine).join('\n');
  }

  throw new Error('Unknown action — use add, update, status, remove or list');
}
