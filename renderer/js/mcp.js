/* MCP manager (renderer side): CRUD + status + logs, real test/list via main. */
import { uid, now } from './utils.js';

export function blankMcpServer() {
  return {
    id: uid('mcp'), name: 'New MCP server', transport: 'http',
    url: 'http://localhost:8000/mcp', command: '', args: '',
    headers: {}, env: {}, enabled: false, autoConnect: true, status: 'offline',
    tools: [], log: []
  };
}
export function serverPayload(server) {
  return {
    transport: server.transport, url: server.url,
    command: server.command, args: String(server.args || '').split(/\s+/).filter(Boolean),
    headers: server.headers || {}, env: server.env || {}
  };
}

export function mcpLog(server, msg, ok = true) {
  server.log = server.log || [];
  server.log.unshift({ t: now(), msg: String(msg).slice(0, 600), ok });
  server.log = server.log.slice(0, 100);
}

export async function testServer(server) {
  server.status = 'connecting';
  const r = await window.zeqou.mcp.test(serverPayload(server));
  server.status = r.ok ? 'online' : 'error';
  mcpLog(server, r.ok ? ('Connected: ' + (r.detail || 'OK')) : ('Failed: ' + (r.error || 'unknown')), r.ok);
  return r;
}

export async function refreshTools(server) {
  const r = await window.zeqou.mcp.listTools(serverPayload(server));
  if (r.ok) {
    server.tools = r.tools || [];
    mcpLog(server, `Discovered ${(r.tools || []).length} tool(s).`, true);
  } else {
    mcpLog(server, 'Tool discovery failed: ' + (r.error || 'unknown'), false);
  }
  return r;
}

export function mcpToolsAsOpenAI(server) {
  if (!server.enabled || server.status !== 'online') return [];
  return (server.tools || []).map(t => ({
    type: 'function',
    function: {
      name: 'mcp__' + server.name.replace(/[^a-zA-Z0-9_]/g, '_') + '__' + t.name,
      description: `[MCP:${server.name}] ${t.description || t.name}`,
      parameters: t.inputSchema || { type: 'object', properties: {} }
    }
  }));
}
