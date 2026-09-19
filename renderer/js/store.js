/* Central persistent store: UI / state layer.
 * Non-secret state -> Electron userData file (+ localStorage mirror).
 * Secrets (API keys) -> main-process encrypted vault, renderer only sees masked values.
 */
import { uid, now } from './utils.js';
import { DEFAULT_PROVIDERS } from './providers.js';
import { BUILTIN_TOOLS } from './tools.js';

const LS_KEY = 'zeqou-harness-state-v1';

function defaultState() {
  return {
    version: 9,
    theme: 'system',           // system | dark | light
    view: 'chat',
    mode: 'chat',              // chat | agent
    activeChatId: null,
    activeProjectId: 'personal',
    chats: [],                 // {id,title,projectId,modelRef,agentId,memoryOn,toolsOn,mcpOn,webOn,pinned,archived,folder,createdAt,updatedAt,messages:[],branches?}
    folders: [{ id: 'general', name: 'General' }],
    projects: [
      { id: 'personal', name: 'Personal', description: 'Default workspace', systemInstructions: '', models: [], tools: [], mcpServers: [], createdAt: now() }
    ],
    memories: [],              // {id,text,tags,projectId,createdAt,updatedAt,useCount}
    tasks: [],                 // agent todo list {id,chatId,title,plan,priority,status,createdAt,updatedAt}
    tools: BUILTIN_TOOLS.map(t => ({ ...t, enabled: ['calculator', 'datetime', 'web_search', 'project_files', 'read_file', 'edit_file', 'search_files', 'write_file', 'compact_context', 'todo'].includes(t.id), custom: false })),
    toolCalls: [],             // history {id,tool,args,result,ok,at,chatId}
    mcpServers: [],            // {id,name,transport,url,command,args,headers,enabled,status,tools,lastLog[]}
    providers: DEFAULT_PROVIDERS,
    models: [],                // discovered/registered {id,providerId,modelId,label,context,capabilities{},status}
    agents: [
      { id: 'general', name: 'General agent', description: 'Balanced assistant that can use tools and files.', instructions: 'Be concise, helpful and precise. Use tools when they genuinely help.', maxSteps: 6 },
      { id: 'coder', name: 'Code agent', description: 'Senior engineer. Reads project files, writes code, verifies.', instructions: 'You are a senior software engineer. Prefer reading project files before answering. Produce clean, complete code.', maxSteps: 10 },
      { id: 'researcher', name: 'Research agent', description: 'Deep research with web search and multi-step reasoning.', instructions: 'Research thoroughly, cite sources inline, compare viewpoints, finish with a summary.', maxSteps: 8 }
    ],
    activeAgentId: 'general',
    settings: {
      temperature: 0.7, maxTokens: 2048, contextLength: 64000, reasoningEffort: 'off',
      chatFont: 'default', enterToSend: true, showThinking: true,
      memoryGlobal: true, autoMemory: false,
      agentAutoApprove: true, agentMaxSteps: 8,
      notifications: true, soundOff: true,
      streamResponses: true, retryOnFail: true, autoCompact: true
    },
    composer: { modelRef: null, toolsOn: true, mcpOn: true, webOn: false },
    archivedVisible: false
  };
}

class Store {
  constructor() {
    this.state = defaultState();
    this.listeners = new Set();
    this._saveT = null;
  }
  async load() {
    // 1) localStorage fast path
    try {
      const ls = localStorage.getItem(LS_KEY);
      if (ls) this.state = { ...defaultState(), ...JSON.parse(ls) };
    } catch (_) {}
    // 2) main file wins if present
    try {
      if (window.zeqou?.state) {
        const file = await window.zeqou.state.load();
        if (file && file.version >= 1) this.state = { ...defaultState(), ...file };
      }
    } catch (_) {}
    // 3) v2 migration: drop hardcoded seed models — everything is
    // auto-discovered from providers now (see autoDiscoverModels).
    if (!this.state.version || this.state.version < 2) {
      for (const p of this.state.providers) p.models = [];
      this.state.models = [];
      this.state.composer.modelRef = null;
      for (const c of this.state.chats) c.modelRef = null;
      this.state.version = 2;
      this.saveNow();
    }
    // 4) v4 migration: add new built-in tools without touching the rest.
    if (this.state.version < 4) {
      const have = new Set(this.state.tools.map(t => t.id));
      for (const t of BUILTIN_TOOLS) {
        if (!have.has(t.id)) this.state.tools.push({ ...t, enabled: false, custom: false });
      }
      this.state.version = 4;
      this.saveNow();
    }
    // 5) v5 migration: new built-in tools default ON (edit_file, search_files),
    //    and legacy builtin ids are renamed to their exported tool names.
    if (this.state.version < 5) {
      const fix = (t) => {
        if (t.id === 'shell' && t.name === 'shell') t.name = 'shell_exec';
        return t;
      };
      this.state.tools = this.state.tools.map(fix);
      const have = new Set(this.state.tools.map(t => t.id));
      for (const t of BUILTIN_TOOLS) {
        if (have.has(t.id)) continue;
        this.state.tools.push({ ...t, enabled: ['edit_file', 'search_files'].includes(t.id), custom: false });
      }
      this.state.version = 5;
      this.saveNow();
    }
    // 6) v6 migration: compact_context tool + auto-compact setting default.
    if (this.state.version < 6) {
      const have = new Set(this.state.tools.map(t => t.id));
      for (const t of BUILTIN_TOOLS) {
        if (have.has(t.id)) continue;
        this.state.tools.push({ ...t, enabled: t.id === 'compact_context', custom: false });
      }
      if (this.state.settings.autoCompact === undefined) this.state.settings.autoCompact = true;
      this.state.version = 6;
      this.saveNow();
    }
    // 7) v7 migration: file-writing tools must be ON, and per-chat toggles
    //    must exist. An agent workspace that cannot save files is useless —
    //    small models then answer "I can't save files" instead of writing.
    //    Chats created before per-chat toggles have toolsOn === undefined,
    //    which enabledOpenAITools() treats as OFF — silently toolless chats.
    if (this.state.version < 7) {
      const have = new Set(this.state.tools.map(t => t.id));
      for (const t of BUILTIN_TOOLS) {
        if (!have.has(t.id)) this.state.tools.push({ ...t, enabled: ['write_file', 'compact_context'].includes(t.id), custom: false });
      }
      const wf = this.state.tools.find(t => t.id === 'write_file');
      if (wf) wf.enabled = true;
      for (const c of this.state.chats) {
        if (typeof c.toolsOn !== 'boolean') c.toolsOn = this.state.composer.toolsOn !== false;
        if (typeof c.mcpOn !== 'boolean') c.mcpOn = this.state.composer.mcpOn !== false;
        if (typeof c.webOn !== 'boolean') c.webOn = this.state.composer.webOn === true;
        if (typeof c.memoryOn !== 'boolean') c.memoryOn = true;
      }
      this.state.version = 7;
      this.saveNow();
    }
    // 8) v8 migration: add newly preset providers without touching the ones
    //    the user already configured (keys live in the encrypted vault keyed
    //    by provider id, so merging is safe).
    if (this.state.version < 8) {
      const have = new Set(this.state.providers.map(p => p.id));
      for (const p of DEFAULT_PROVIDERS) {
        if (!have.has(p.id)) this.state.providers.push({ ...p, models: [] });
      }
      this.state.version = 8;
      this.saveNow();
    }
    // 9) v9 migration: the todo tool — agent-owned task list, on by default.
    if (this.state.version < 9) {
      if (!Array.isArray(this.state.tasks)) this.state.tasks = [];
      const have = new Set(this.state.tools.map(t => t.id));
      for (const t of BUILTIN_TOOLS) {
        if (!have.has(t.id)) this.state.tools.push({ ...t, enabled: t.id === 'todo', custom: false });
      }
      const todo = this.state.tools.find(t => t.id === 'todo');
      if (todo && todo.enabled === undefined) todo.enabled = true;
      this.state.version = 9;
      this.saveNow();
    }
    this.emit();
  }
  saveSoon() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this.saveNow(), 350);
  }
  async saveNow() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.state)); } catch (_) {}
    try { await window.zeqou?.state.save(this.state); } catch (_) {}
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of [...this.listeners]) { try { fn(this.state); } catch (_) {} } }
  update(mut, save = true) { mut(this.state); if (save) this.saveSoon(); this.emit(); }

  // ---- chats ----
  getChat(id) { return this.state.chats.find(c => c.id === id); }
  get activeChat() { return this.getChat(this.state.activeChatId); }
  newChat(projectId) {
    const c = {
      id: uid('chat'), title: 'New conversation',
      projectId: projectId || this.state.activeProjectId || 'personal',
      modelRef: this.state.composer.modelRef, agentId: this.state.activeAgentId,
      memoryOn: true, toolsOn: this.state.composer.toolsOn, mcpOn: this.state.composer.mcpOn,
      webOn: this.state.composer.webOn,
      pinned: false, archived: false, folder: 'general',
      createdAt: now(), updatedAt: now(), messages: []
    };
    this.update(s => { s.chats.unshift(c); s.activeChatId = c.id; s.view = 'chat'; });
    return c;
  }
}

export const store = new Store();
export function activeProject(s) {
  return s.projects.find(p => p.id === (s.activeChat?.projectId || s.activeProjectId)) || s.projects[0];
}
