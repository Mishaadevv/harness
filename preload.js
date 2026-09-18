/* Zeqou Harness — preload bridge (sandbox-safe, minimal surface) */
const { contextBridge, ipcRenderer } = require('electron');

const streamListeners = new Map(); // requestId -> Set<fn>

ipcRenderer.on('zeqou:ai:stream', (_e, msg) => {
  const set = streamListeners.get(msg.requestId);
  if (set) for (const fn of [...set]) { try { fn(msg); } catch (_) {} }
});

contextBridge.exposeInMainWorld('zeqou', {
  platform: process.platform,
  state: {
    load: () => ipcRenderer.invoke('zeqou:state:load'),
    save: (s) => ipcRenderer.invoke('zeqou:state:save', s),
    path: () => ipcRenderer.invoke('zeqou:state:path')
  },
  secrets: {
    set: (key, value) => ipcRenderer.invoke('zeqou:secrets:set', { key, value }),
    masked: (key) => ipcRenderer.invoke('zeqou:secrets:get-masked', { key }),
    has: (key) => ipcRenderer.invoke('zeqou:secrets:has', { key }),
    remove: (key) => ipcRenderer.invoke('zeqou:secrets:delete', { key })
  },
  dialogs: {
    openFiles: () => ipcRenderer.invoke('zeqou:dialog:openFiles'),
    openDirectory: () => ipcRenderer.invoke('zeqou:dialog:openDirectory'),
    readFileBuffer: (fp) => ipcRenderer.invoke('zeqou:dialog:readFileBuffer', fp)
  },
  fs: {
    list: (a) => ipcRenderer.invoke('zeqou:fs:list', a),
    read: (a) => ipcRenderer.invoke('zeqou:fs:read', a),
    write: (a) => ipcRenderer.invoke('zeqou:fs:write', a),
    mkdir: (a) => ipcRenderer.invoke('zeqou:fs:mkdir', a),
    rm: (a) => ipcRenderer.invoke('zeqou:fs:rm', a),
    import: (a) => ipcRenderer.invoke('zeqou:fs:import', a)
  },
  ai: {
    test: (provider) => ipcRenderer.invoke('zeqou:ai:test', { provider }),
    listModels: (provider) => ipcRenderer.invoke('zeqou:ai:models', { provider }),
    chat(requestId, provider, model, messages, opts) {
      return ipcRenderer.invoke('zeqou:ai:chat', { requestId, provider, model, messages, opts });
    },
    abort: (requestId) => ipcRenderer.invoke('zeqou:ai:abort', { requestId }),
    onStream(requestId, fn) {
      if (!streamListeners.has(requestId)) streamListeners.set(requestId, new Set());
      streamListeners.get(requestId).add(fn);
      return () => {
        const s = streamListeners.get(requestId);
        if (s) { s.delete(fn); if (!s.size) streamListeners.delete(requestId); }
      };
    }
  },
  mcp: {
    test: (server) => ipcRenderer.invoke('zeqou:mcp:test', { server }),
    listTools: (server) => ipcRenderer.invoke('zeqou:mcp:list-tools', { server }),
    call: (server, tool, args) => ipcRenderer.invoke('zeqou:mcp:call', { server, tool, args })
  },
  tools: {
    exec: (a) => ipcRenderer.invoke('zeqou:tools:exec', a)
  },
  logs: { tail: (n) => ipcRenderer.invoke('zeqou:logs:tail', n) },
  shell: { openExternal: (u) => ipcRenderer.invoke('zeqou:shell:openExternal', u) }
});
