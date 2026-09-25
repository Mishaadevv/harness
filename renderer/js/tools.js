/* Built-in tools + custom tool registry + safe executor.
 * Tools are exposed to models as OpenAI function tools. Execution is real
 * (calculator, datetime, file read, web search via pluggable endpoint) and
 * every call is recorded in toolCalls history with permission gating.
 */
import { uid, now } from './utils.js';
import { runTodo } from './tasks.js';

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
    description: 'Manage your own task list (a todo list the user watches live in the chat). Actions: add - create a task (optionally with a one-line plan); update - change title/plan/priority; status - mark pending, doing or done; remove - delete one task; clear - drop every finished task; list - show the current list. Use it for any multi-step job: plan the steps first, mark a task doing when you start it and done when it is finished, so the user can follow progress.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'add | update | status | remove | clear | list', enum: ['add', 'update', 'status', 'remove', 'clear', 'list'] },
        id: { type: 'string', description: 'Task id (returned when created; list shows ids). Required for update/status/remove.' },
        title: { type: 'string', description: 'Task title (add/update)' },
        plan: { type: 'string', description: 'One-line plan or note for how you will do it (add/update, optional)' },
        priority: { type: 'string', description: 'low | normal | high (add/update, optional)', enum: ['low', 'normal', 'high'] },
        status: { type: 'string', description: 'pending | doing | done (status action)', enum: ['pending', 'doing', 'done'] },
        chatId: { type: 'string', description: 'Internal - set automatically by the harness' }
      },
      required: ['action']
    },
    permissions: 'safe', timeoutMs: 3000
  },
  {
    id: 'ask_user', name: 'ask_user',
    description: 'Ask the user a question and WAIT for the answer. The question appears as a card inside the chat: the user clicks one of your options or types their own answer, and it comes back to you as the tool result. Use it whenever the decision, preference or missing detail belongs to the user — ask instead of guessing, and do not write the question as plain text (a plain question is not answerable). Ask one focused question at a time, with 2-5 concrete options when the answers are predictable.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask. Self-contained, plain language, one sentence when possible.' },
        options: { type: 'array', description: 'Optional 2-5 suggested answers shown as buttons the user can click.', items: { type: 'string' } },
        header: { type: 'string', description: 'Optional short label above the question, e.g. "Scope" or "Format".' },
        multiple: { type: 'boolean', description: 'Let the user pick several options at once (default false).' }
      },
      required: ['question']
    },
    permissions: 'safe', timeoutMs: 0
  }
];

/* Make a JSON Schema safe for strict OpenAI-compatible providers (Gemini,
 * Mistral, …). Gemini's compatibility layer rejects schemas where a property
 * has no "type" ("Request contains an invalid argument"), where "enum"
 * appears without a sibling "type", where a field description is not a
 * string, or where "required" mentions unknown properties. It also dislikes
 * $schema/$ref/definitions and additionalProperties-as-object. */
export function sanitizeJsonSchema(schema, depth = 0) {
  if (depth > 8 || !schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'object', properties: {} };
  const clean = {};
  for (const k of ['type', 'format', 'description', 'enum', 'items', 'properties', 'required', 'minimum', 'maximum']) {
    if (schema[k] !== undefined) clean[k] = schema[k];
  }
  if (!clean.type) {
    clean.type = clean.properties || clean.required ? 'object' : (clean.items ? 'array' : (clean.enum ? 'string' : 'string'));
  }
  if (clean.type === 'object') {
    clean.properties = {};
    for (const [k, v] of Object.entries(schema.properties || {})) clean.properties[k] = sanitizeJsonSchema(v, depth + 1);
    clean.required = (Array.isArray(clean.required) ? clean.required : []).filter(r =>
      typeof r === 'string' && clean.properties[r] !== undefined);
    if (!clean.required.length) delete clean.required;
  }
  if (clean.type === 'array' && schema.items) clean.items = sanitizeJsonSchema(schema.items, depth + 1);
  if (clean.enum && !clean.type) clean.type = 'string';
  if (clean.description !== undefined && typeof clean.description !== 'string') clean.description = JSON.stringify(clean.description);
  if (clean.type === 'string' && clean.format === 'date-time') delete clean.format; // Gemini rejects date-time on strings
  return clean;
}

export function toolToOpenAI(t) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: sanitizeJsonSchema(t.parameters || { type: 'object', properties: {} }) } };
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
  const todo = names.includes('todo')
    ? ' Keep a visible task list for any real work: before you start, write the steps down with todo (action=add) — one task per step, even for a short job — then mark a task doing when you start it and done when it is finished, and add steps you discover on the way. The user watches this list live, and an empty list while you work reads as work you never planned.'
    : '';
  const ask = names.includes('ask_user')
    ? ' When you need a decision, a preference or a missing detail from the user, call ask_user: it shows a question card in the chat and waits for the real answer. Never guess silently and never write the question only as text.'
    : '';
  return `Available tools (call them via function calling): ${parts.join('; ')}.${todo}${ask}`;
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
    else if (toolName === 'ask_user') out = await runAskUser(args, ctx);
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

/* ── ask_user: pause the run and let the user answer in the chat ────────
 * The UI owns the waiting: ctx.ask(...) renders the question card and
 * resolves with the answer (string, array for multi-select, or null when
 * the user skipped / the run was stopped). No ctx.ask means the run is not
 * attached to a chat, which is the only case where we cannot ask. */
async function runAskUser(args, ctx = {}) {
  const question = String(args.question || '').trim();
  if (!question) throw new Error('question is required for the ask_user tool');
  if (!ctx.ask) throw new Error('Asking the user is only possible during a live chat run.');
  const options = (Array.isArray(args.options) ? args.options : [])
    .map(o => String(o).trim().slice(0, 300)).filter(Boolean).slice(0, 6);
  const answer = await ctx.ask({
    question: question.slice(0, 2000),
    options,
    header: args.header ? String(args.header).slice(0, 60) : null,
    multiple: !!args.multiple
  });
  if (answer === null || answer === undefined || (Array.isArray(answer) && !answer.length)) {
    return 'The user did not answer (skipped or the run was stopped). Do not ask again in a loop — continue with a sensible default and say which one you assumed, or finish and ask in plain text.';
  }
  return `User answered: ${Array.isArray(answer) ? answer.join(' | ') : String(answer)}`;
}

/* ── enforcing the two tools small models forget ────────────────────────
 * A 7–14B model will happily write "Хочешь, чтобы я написал код?" as plain
 * text instead of calling ask_user, and work through a job without ever
 * touching the todo tool — a prompt is a suggestion, not a guarantee. So the
 * harness checks the answer and, exactly once per run, states what was
 * expected. The line is appended to the existing system message: no fake
 * turns enter the conversation and the tool results stay intact. */
export const PLAIN_QUESTION_NUDGE = 'Your answer asks the user something as plain text, which nobody can answer: no reply is attached to it. If you still need that information, call the ask_user tool with the question now (with its options when you have them) and stop the answer there. Write the answer again without the question if it was rhetorical or the user already answered it.';

export const TODO_NUDGE = 'You are working without a task list, so the user cannot see the plan. Create the remaining steps with the todo tool (action=add), mark the step you are working on as doing, and keep the list updated as you go.';

/* Does this answer look like it is asking the user something? Fenced code is
 * stripped first (code is full of question marks), and the verdict comes from
 * the part of the text where an answer normally asks: a request for a reply
 * ("Ответь, и я начну") or a question that opens a sentence and is aimed at
 * the user. */
export function looksLikePlainTextQuestion(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 6000) return false;
  const prose = raw.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  // A short answer is read whole ("Ответь, и я начну!" is 29 characters —
  // slicing a share off the front used to throw the request away). In a long
  // one only the closing part matters: that is where a model turns to the
  // user, while the opening is usually a summary or a quoted snippet.
  const tail = prose.length > 400 ? prose.slice(Math.floor(prose.length * 0.4)) : prose;
  if (/(ответь|скажи|уточни|подтверди|дай знать|let me know|tell me)/i.test(tail)) return true;
  if (!/[?？]/.test(tail)) return false;
  // A short text whose last character is a question mark is a question too —
  // models end up with things like "Нужны ли другие блоки? Камень, дерево,
  // песок?" or "Камень, дерево, песок, вода?", where no question word opens a
  // sentence. Code is stripped above, so the mark is prose punctuation.
  if (/[?？]$/.test(tail.trimEnd()) && tail.trimEnd().length <= 240) return true;
  const asks = /(^|[.!?\n]\s*)(что|как|чем|где\s|когда|почему|зачем|сколько|какие|какой|какую|хоч(ешь|ете)|может|можно|нужн|надо|есть ли|do you|would you|should i|which|what|how|can you|could you|are you|is it|want me)/i;
  // JS \b is ASCII-only, so a Cyrillic word boundary has to be spelled out —
  // /\bвы\b/ can never match inside Russian text.
  const addresses = /(?<![а-яё])(тебе|вам|вы|ты)(?![а-яё])|\b(your|you)\b/i;
  return asks.test(tail) || addresses.test(tail);
}

/* ── questions the agent already asked ─────────────────────────────────
 * The transcript keeps the answer only on the assistant message, and tool
 * results are never part of the saved history — so without this block the
 * model forgets the exchange and later answers "you never asked me
 * anything" about a question the user already answered. */
export function questionHistoryBlock(messages, limit = 6) {
  const asked = [];
  for (let i = (messages || []).length - 1; i >= 0 && asked.length < limit; i--) {
    const m = messages[i];
    if (m?.role !== 'assistant' || !Array.isArray(m.questions)) continue;
    // Within one message, oldest first — the whole list is reversed below.
    for (let j = m.questions.length - 1; j >= 0 && asked.length < limit; j--) asked.push(m.questions[j]);
  }
  const lines = asked.filter(q => q && q.question).reverse().map(q => {
    const answer = q.status === 'answered'
      ? (Array.isArray(q.answer) ? q.answer.join(', ') : String(q.answer ?? ''))
      : '(the user did not answer)'; 
    return `- “${String(q.question).slice(0, 240)}” → ${answer}`;
  });
  if (!lines.length) return '';
  return 'Questions you have already asked this user in this conversation — never ask the same thing again, '
    + 'and treat these answers as facts you know:\n' + lines.join('\n');
}
