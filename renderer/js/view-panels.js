/* Manager pages — quiet lists. One action visible, the rest behind •••.
 * Details and secondary config live in collapsed blocks, not on screen. */
import { esc, timeAgo, el, openModal, openMenu, toast, download } from './utils.js';
import { allModels, modelRefOf, guessCaps } from './providers.js';
import { addMemory } from './memory.js';
import { blankMcpServer, testServer, refreshTools, serverPayload } from './mcp.js';
import { executeTool } from './tools.js';
import { getWebConfig } from './agent.js';
import { uid, now } from './utils.js';

function moreBtn(anchor, items) {
  const b = el(`<button class="mini-btn">•••</button>`);
  b.onclick = (e) => { e.stopPropagation(); const r = b.getBoundingClientRect(); openMenu(r.left - 160, r.bottom + 6, items); };
  return b;
}
function emptyState(big, title, hint) {
  return el(`<div class="empty-state"><div class="big">${big}</div><b>${esc(title)}</b>${hint ? `<p class="muted">${esc(hint)}</p>` : ''}</div>`);
}

/* ---------------- HISTORY ---------------- */
export function renderHistory(root, state, api) {
  let showArchived = false;
  root.innerHTML = `<div class="page-head"><h2>History</h2></div>
    <div class="toolbar"><input class="search" id="hSearch" placeholder="Search…" />
    <button class="mini-btn" id="hArch">Archived</button></div>
    <div id="hList"></div>`;
  const paint = () => {
    const q = root.querySelector('#hSearch').value.toLowerCase();
    root.querySelector('#hArch').textContent = showArchived ? '← Active' : 'Archived';
    const list = root.querySelector('#hList');
    list.innerHTML = '';
    let chats = state.chats.filter(c => !!c.archived === showArchived);
    if (q) chats = chats.filter(c => (c.title + ' ' + c.messages.map(m => m.content).join(' ').slice(0, 2000)).toLowerCase().includes(q));
    chats.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
    if (!chats.length) { list.appendChild(emptyState('◔', showArchived ? 'Nothing archived' : 'No conversations')); return; }
    for (const c of chats) {
      const row = el(`<div class="list-row" style="cursor:pointer"><div class="grow"><div class="title">${esc(c.title)}</div>
        <div class="sub">${c.pinned ? 'Pinned · ' : ''}${esc(timeAgo(c.updatedAt))}</div></div></div>`);
      row.onclick = () => api.openChat(c.id);
      if (api.chatRuns && api.chatRuns(c.id)) {
        row.appendChild(el(`<span class="run-pulse" title="Generating in background"></span>`));
      }
      row.appendChild(moreBtn(row, [
        { label: c.pinned ? 'Unpin' : 'Pin', onClick: () => api.update(s => { s.chats.find(x => x.id === c.id).pinned = !c.pinned; }) },
        { label: 'Rename', onClick: () => api.renameChat(c.id) },
        { label: 'Move to folder…', onClick: () => api.moveChat(c.id) },
        { label: 'Duplicate', onClick: () => api.duplicateChat(c.id) },
        { label: 'Export (.json)', onClick: () => download(c.title.replace(/\W+/g, '_') + '.json', JSON.stringify(c, null, 2)) },
        { label: c.archived ? 'Unarchive' : 'Archive', onClick: () => api.update(s => { s.chats.find(x => x.id === c.id).archived = !c.archived; }) },
        { sep: true },
        { label: 'Delete', danger: true, onClick: () => api.deleteChat(c.id) }
      ]));
      list.appendChild(row);
    }
  };
  root.querySelector('#hSearch').oninput = paint;
  root.querySelector('#hArch').onclick = () => { showArchived = !showArchived; paint(); };
  paint();
}

/* ---------------- MEMORIES ---------------- */
export function renderMemories(root, state, api) {
  root.innerHTML = `<div class="page-head"><h2>Memories</h2></div>
    <div class="toolbar"><input class="search" id="mSearch" placeholder="Search…" />
    <button class="btn secondary small" id="mAdd">Add</button></div>
    <div id="mList"></div>`;
  const paint = () => {
    const q = (root.querySelector('#mSearch').value || '').toLowerCase();
    const list = root.querySelector('#mList'); list.innerHTML = '';
    const mems = state.memories.filter(m => !q || m.text.toLowerCase().includes(q));
    if (!mems.length) { list.appendChild(emptyState('◎', 'No memories yet', 'Things you tell the assistant to remember land here.')); return; }
    for (const m of mems) {
      const row = el(`<div class="list-row"><div class="grow"><div class="title" style="white-space:normal">${esc(m.text)}</div></div></div>`);
      const eb = el(`<button class="mini-btn">Edit</button>`);
      eb.onclick = () => editMemoryModal(m, api, paint);
      const db = el(`<button class="mini-btn">Delete</button>`);
      db.onclick = () => api.update(s => { s.memories = s.memories.filter(x => x.id !== m.id); });
      row.appendChild(eb); row.appendChild(db);
      list.appendChild(row);
    }
    if (state.memories.length > 1) {
      const clear = el(`<div style="padding:12px 2px"><button class="mini-btn">Clear all memories</button></div>`);
      clear.querySelector('button').onclick = async () => {
        await openModal({
          title: 'Clear all memories?', sub: 'This cannot be undone.', bodyHTML: '',
          actions: [{ label: 'Keep', kind: 'secondary', onClick: c => c(null) }, { label: 'Clear all', kind: 'danger', onClick: c => { api.update(s => { s.memories = []; }); c(true); } }]
        });
        paint();
      };
      list.appendChild(clear);
    }
  };
  root.querySelector('#mSearch').oninput = paint;
  root.querySelector('#mAdd').onclick = () => editMemoryModal(null, api, paint);
  paint();
}
async function editMemoryModal(m, api, repaint) {
  const body = `<div class="field"><textarea id="fText" rows="3" placeholder="e.g. Prefers short answers with code first">${esc(m?.text || '')}</textarea></div>`;
  await openModal({
    title: m ? 'Edit memory' : 'Add memory', bodyHTML: body,
    actions: [{ label: 'Cancel', kind: 'secondary', onClick: c => c(null) }, {
      label: m ? 'Save' : 'Add', onClick: (close, back) => {
        const t = back.querySelector('#fText').value.trim();
        if (!t) return;
        if (m) api.update(s => { const x = s.memories.find(y => y.id === m.id); x.text = t; x.updatedAt = now(); });
        else api.update(s => { addMemory(s, { text: t, tags: [], projectId: s.activeProjectId }); });
        close(true); repaint && repaint(); toast(m ? 'Saved' : 'Memory added', 'ok', 1500);
      }
    }]
  });
}

/* ---------------- TOOLS ---------------- */
export function renderTools(root, state, api) {
  const web = JSON.parse(localStorage.getItem('zeqou-webcfg') || '{}');
  const on = state.tools.filter(t => t.enabled).length;
  root.innerHTML = `<div class="page-head"><h2>Tools</h2></div>
    <div class="toolbar"><span style="flex:1"></span><button class="btn secondary small" id="tNew">New tool</button><button class="mini-btn" id="tMore">•••</button></div>
    <div id="tList"></div>
    <details class="collapsible"><summary>Web search endpoint</summary><div class="coll-body">
      <div class="form-grid"><div class="field"><label>Endpoint URL (optional)</label><input id="wUrl" placeholder="https://…" value="${esc(web.endpoint || '')}" /></div>
      <div class="field"><label>Auth header (optional)</label><input id="wAuth" placeholder="Bearer …" value="${esc(web.auth || '')}" /></div>
      <div><button class="btn secondary small" id="wSave">Save</button></div></div></div></details>
    <details class="collapsible"><summary>Recent calls</summary><div class="coll-body" id="tHist"></div></details>`;
  const paint = () => {
    const list = root.querySelector('#tList'); list.innerHTML = '';
    for (const t of state.tools) {
      const row = el(`<div class="list-row"><div class="grow"><div class="title">${esc(t.name)}</div></div></div>`);
      row.appendChild(moreBtn(row, [
        { label: 'Try…', onClick: () => openToolTryModal(t, state, api) },
        ...(t.custom ? [
          { label: 'Edit', onClick: () => api.editTool(t.id, paint) },
          { label: 'Delete', danger: true, onClick: () => api.update(s => { s.tools = s.tools.filter(x => x.id !== t.id); }) }
        ] : [])
      ]));
      const sw = el(`<label class="switch"><input type="checkbox" ${t.enabled ? 'checked' : ''} /><span class="track"></span><span class="thumb"></span></label>`);
      sw.querySelector('input').onchange = (e) => api.update(s => { s.tools.find(x => x.id === t.id).enabled = e.target.checked; });
      row.appendChild(sw);
      list.appendChild(row);
    }
    const h = root.querySelector('#tHist'); h.innerHTML = '';
    const calls = [...state.toolCalls].slice(0, 15);
    if (!calls.length) h.innerHTML = '<p class="muted">No calls yet.</p>';
    for (const c of calls) {
      h.appendChild(el(`<div class="list-row"><span class="status-dot ${c.ok ? 'ok' : 'error'}"></span>
        <div class="grow"><div class="title">${esc(c.tool)}</div><div class="sub">${esc(timeAgo(c.at))} · ${c.ms || 0} ms</div></div></div>`));
    }
  };
  root.querySelector('#tNew').onclick = () => api.editTool(null, paint);
  root.querySelector('#tMore').onclick = (e) => {
    const r = e.target.getBoundingClientRect();
    openMenu(r.left - 170, r.bottom + 6, [
      { label: 'Export custom tools', onClick: () => {
        const custom = state.tools.filter(t => t.custom);
        if (!custom.length) return toast('No custom tools', 'info', 1500);
        download('zeqou-tools.json', JSON.stringify(custom, null, 2));
      } },
      { label: 'Import tools', onClick: async () => {
        const files = await window.zeqou.dialogs.openFiles();
        if (!files.length) return;
        const fr = await window.zeqou.dialogs.readFileBuffer(files[0].path);
        if (!fr.ok) return toast(fr.error, 'err');
        try {
          const bin = atob(fr.base64);
          const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
          const arr = Array.isArray(data) ? data : data.tools;
          if (!Array.isArray(arr)) throw new Error('bad file');
          let n = 0;
          api.update(s => {
            for (const t of arr) {
              if (!t || !t.name) continue;
              s.tools.push({ id: uid('tool'), name: String(t.name).replace(/\s+/g, '_'), description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} }, permissions: t.permissions || 'network', webhookURL: t.webhookURL || '', enabled: true, custom: true });
              n++;
            }
          });
          toast(n ? `Imported ${n}` : 'Nothing to import', n ? 'ok' : 'info', 1800);
          paint();
        } catch { toast('Import failed', 'err'); }
      } }
    ]);
  };
  root.querySelector('#wSave').onclick = () => {
    localStorage.setItem('zeqou-webcfg', JSON.stringify({ endpoint: root.querySelector('#wUrl').value.trim(), headers: root.querySelector('#wAuth').value.trim() ? { Authorization: root.querySelector('#wAuth').value.trim() } : {} }));
    toast('Saved', 'ok', 1500);
  };
  paint();
}

/* ---------------- MCP ---------------- */
export function renderMcp(root, state, api) {
  root.innerHTML = `<div class="page-head"><h2>MCP</h2></div>
    <div class="toolbar"><span style="flex:1"></span><button class="btn secondary small" id="mAdd">Add server</button></div>
    <div id="mList"></div>`;
  const paint = () => {
    const list = root.querySelector('#mList'); list.innerHTML = '';
    if (!state.mcpServers.length) {
      list.appendChild(emptyState('⬢', 'No servers', 'Connect an MCP server to add external tools.'));
      return;
    }
    for (const sv of state.mcpServers) {
      const dot = sv.status === 'online' ? 'ok' : sv.status === 'connecting' ? 'running' : sv.status === 'error' ? 'error' : '';
      const wrap = el(`<div></div>`);
      const row = el(`<div class="list-row" style="cursor:pointer"><span class="status-dot ${dot}"></span>
        <div class="grow"><div class="title">${esc(sv.name)}</div>
        <div class="sub">${esc(sv.status)}${(sv.tools || []).length ? ` · ${(sv.tools || []).length} tools` : ''}</div></div></div>`);
      const toolsDiv = el(`<div style="padding:0 2px 10px 22px;display:none"></div>`);
      if (!(sv.tools || []).length) toolsDiv.appendChild(el(`<p class="muted">No tools discovered — press Connect.</p>`));
      for (const t of (sv.tools || [])) {
        const tr = el(`<div class="row-between" style="padding:3px 0"><div class="grow" style="font-size:12px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">⚙ ${esc(t.name)} <span style="color:var(--text-3)">— ${esc((t.description || '').slice(0, 80))}</span></div></div>`);
        const run = el(`<button class="mini-btn">Run</button>`);
        run.onclick = (ev) => { ev.stopPropagation(); openMcpRunModal(sv, t, api); };
        tr.appendChild(run);
        toolsDiv.appendChild(tr);
      }
      row.onclick = () => { toolsDiv.style.display = toolsDiv.style.display === 'none' ? '' : 'none'; };
      const conn = el(`<button class="mini-btn">${sv.status === 'online' ? 'Refresh' : 'Connect'}</button>`);
      conn.onclick = async (e) => {
        e.stopPropagation();
        conn.textContent = '…';
        const r = await testServer(sv);
        if (r.ok) await refreshTools(sv);
        api.update(s => {});
        toast(r.ok ? 'Connected' : 'Connection failed', r.ok ? 'ok' : 'err');
      };
      row.appendChild(conn);
      const sw = el(`<label class="switch" title="Enable"><input type="checkbox" ${sv.enabled ? 'checked' : ''} /><span class="track"></span><span class="thumb"></span></label>`);
      sw.querySelector('input').onchange = (e) => api.update(s => { s.mcpServers.find(x => x.id === sv.id).enabled = e.target.checked; });
      row.appendChild(sw);
      row.appendChild(moreBtn(row, [
        { label: 'Configure', onClick: () => api.editMcp(sv.id, paint) },
        { label: 'Logs', onClick: () => openModal({ title: sv.name + ' — logs', wide: true, bodyHTML: (sv.log || []).length ? sv.log.map(l => `<div class="code-inline" style="margin-bottom:6px">${esc(new Date(l.t).toLocaleTimeString())} · ${esc(l.msg)}</div>`).join('') : '<p class="muted">No log entries yet.</p>' }) },
        { sep: true },
        { label: 'Remove', danger: true, onClick: () => api.update(s => { s.mcpServers = s.mcpServers.filter(x => x.id !== sv.id); }) }
      ]));
      wrap.appendChild(row); wrap.appendChild(toolsDiv);
      list.appendChild(wrap);
    }
  };
  const MCP_PRESETS = [
    { label: 'Blank server', make: () => ({}) },
    { label: 'Filesystem — local files', make: () => ({ name: 'Filesystem', transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem C:\\path\\to\\allowed\\folder' }) },
    { label: 'Fetch — web pages', make: () => ({ name: 'Fetch', transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-fetch' }) },
    { label: 'Memory — persistent knowledge graph', make: () => ({ name: 'Memory', transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-memory' }) },
    { label: 'SQLite — database', make: () => ({ name: 'SQLite', transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-sqlite --db-path C:\\path\\to\\db.sqlite' }) },
    { label: 'GitHub — repos, issues, PRs', make: () => ({ name: 'GitHub', transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-github', env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' } }) },
    { label: 'Brave Search — web search', make: () => ({ name: 'Brave Search', transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-brave-search', env: { BRAVE_API_KEY: '' } }) },
    { label: 'Puppeteer — browser automation', make: () => ({ name: 'Puppeteer', transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-puppeteer' }) },
    { label: 'Everything — demo/test server', make: () => ({ name: 'Everything', transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-everything' }) },
    { label: 'Streamable HTTP — remote server', make: () => ({ name: 'Remote MCP', transport: 'http', url: 'https://example.com/mcp' }) },
    { label: 'SSE — legacy remote server', make: () => ({ name: 'Remote SSE', transport: 'sse', url: 'https://example.com/sse' }) }
  ];
  root.querySelector('#mAdd').onclick = (e) => {
    const r = e.target.getBoundingClientRect();
    const add = (preset) => {
      api.update(s => { s.mcpServers.unshift({ ...blankMcpServer(), ...preset, id: uid('mcp') }); });
      paint();
      const first = state.mcpServers[0];
      if (first) api.editMcp(first.id, paint);
    };
    openMenu(r.left - 190, r.bottom + 6, MCP_PRESETS.map(p => ({ label: p.label, onClick: () => add(p.make()) })));
  };
  paint();
}

/* ---------------- MODELS ---------------- */
export function renderModels(root, state, api) {
  const models = allModels(state);
  root.innerHTML = `<div class="page-head"><h2>Models</h2></div>
    <div class="toolbar"><input class="search" id="moSearch" placeholder="Search…" />
    <button class="mini-btn" id="moDiscover">Discover</button>
    <button class="btn secondary small" id="moAdd">Add</button></div>
    <div id="moList"></div>`;
  const paint = (q = '') => {
    const list = root.querySelector('#moList'); list.innerHTML = '';
    const rows = models.filter(m => !q || (m.label + m.modelId + m.providerName).toLowerCase().includes(q.toLowerCase()));
    if (!rows.length) { list.appendChild(emptyState('⬣', 'No models', 'Enable a provider or run Discover.')); return; }
    // Render all matches — providers like OpenRouter expose hundreds of
    // models and a cap silently hid everything past the first page.
    for (const m of rows) {
      const ref = modelRefOf(m.providerId, m.modelId);
      const active = state.composer.modelRef === ref;
      const row = el(`<div class="list-row"><div class="grow"><div class="title">${esc(m.label || m.modelId)}${active ? ' ✓' : ''}</div>
        <div class="sub">${esc(m.providerName)}${m.providerEnabled === false ? ' · off' : ''}</div></div></div>`);
      if (!active) {
        const use = el(`<button class="mini-btn">Use</button>`);
        use.onclick = () => { api.update(s => {
          s.composer.modelRef = ref;
          const c = s.chats.find(x => x.id === s.activeChatId);
          if (c) c.modelRef = ref; // per-chat ref wins; keep them in sync
        }); api.syncComposer(); api.ensureContextFits?.(state.activeChatId); paint(root.querySelector('#moSearch').value); };
        row.appendChild(use);
      }
      list.appendChild(row);
    }
  };
  root.querySelector('#moSearch').oninput = (e) => paint(e.target.value);
  root.querySelector('#moDiscover').onclick = () => api.discoverAllModels();
  root.querySelector('#moAdd').onclick = () => api.addModel();
  paint();
}

/* ---------------- PROJECTS ---------------- */
export function renderProjects(root, state, api) {
  root.innerHTML = `<div class="page-head"><h2>Projects</h2></div>
    <div class="toolbar"><span style="flex:1"></span><button class="btn secondary small" id="pAdd">New project</button></div><div id="pList"></div>`;
  const paint = () => {
    const list = root.querySelector('#pList'); list.innerHTML = '';
    for (const p of state.projects) {
      const n = state.chats.filter(c => c.projectId === p.id && !c.archived).length;
      const row = el(`<div class="list-row" style="cursor:pointer"><div class="grow"><div class="title">${esc(p.name)}${state.activeProjectId === p.id ? ' ✓' : ''}</div>
        <div class="sub">${n} chats</div></div></div>`);
      row.onclick = () => api.update(s => { s.activeProjectId = p.id; const c = s.chats.find(x => x.projectId === p.id && !x.archived); if (c) s.activeChatId = c.id; s.view = 'chat'; });
      row.appendChild(moreBtn(row, [
        { label: 'Configure', onClick: () => api.editProject(p.id, paint) },
        ...(state.projects.length > 1 ? [{ label: 'Delete', danger: true, onClick: () => api.update(s => { s.projects = s.projects.filter(x => x.id !== p.id); if (s.activeProjectId === p.id) s.activeProjectId = s.projects[0].id; }) }] : [])
      ]));
      list.appendChild(row);
    }
  };
  root.querySelector('#pAdd').onclick = () => api.addProject(paint);
  paint();
}

/* ---------------- FILES ---------------- */
export function renderFiles(root, state, api) {
  const proj = state.projects.find(p => p.id === state.activeProjectId) || state.projects[0];
  const base = proj.localPath || null;
  root.innerHTML = `<div class="page-head"><h2>Files</h2><p>${esc(proj.name)}</p></div>
    <div class="toolbar"><input class="search" id="fSearch" placeholder="Filter…" />
    <button class="btn secondary small" id="fAdd">＋</button></div>
    <div class="row-between" style="margin-bottom:10px"><div class="grow muted" style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(proj.localPath || '')}">${esc(proj.localPath || 'App storage')}</div>
    <button class="mini-btn" id="fLink">${proj.localPath ? 'Change' : 'Link folder'}</button>
    ${proj.localPath ? '<button class="mini-btn" id="fUnlink">Unlink</button>' : ''}</div>
    <div class="grid-2"><div><div id="fPath" class="muted" style="font-size:11.5px;padding:0 8px 6px"></div><div id="fTree" class="file-tree"></div></div>
    <div><div id="fPrev"><div class="empty-state"><div class="big">▦</div><b>Select a file</b></div></div></div></div>`;
  let rel = '', selFile = null;
  const paint = async (filter = '') => {
    root.querySelector('#fPath').textContent = rel ? '▸ ' + rel : '▸ root';
    const tree = root.querySelector('#fTree'); tree.innerHTML = '';
    const r = await window.zeqou.fs.list({ projectId: proj.id, rel, base });
    if (rel) {
      const up = el(`<div class="file-row">↩ <span>..</span></div>`);
      up.onclick = () => { rel = rel.split('/').slice(0, -1).join('/'); paint(root.querySelector('#fSearch').value); };
      tree.appendChild(up);
    }
    if (!r.ok) { tree.appendChild(el(`<p class="muted">${esc(r.error)}</p>`)); return; }
    const items = r.entries.filter(e => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
    if (!items.length) tree.appendChild(el(`<p class="muted" style="padding:8px">Empty.</p>`));
    for (const e of items) {
      const row = el(`<div class="file-row ${selFile === e.rel ? 'active' : ''}"><span>${e.isDir ? '📁' : '📄'}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.name)}</span></div>`);
      row.onclick = () => {
        if (e.isDir) { rel = e.rel; selFile = null; paint(root.querySelector('#fSearch').value); }
        else { selFile = e.rel; paint(root.querySelector('#fSearch').value); preview(e.rel); }
      };
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        openMenu(ev.clientX, ev.clientY, [
          ...(e.isDir ? [] : [{ label: 'Attach to chat', onClick: () => api.attachProjectFile(proj.id, e.rel) }]),
          { label: 'Delete', danger: true, onClick: async () => { await window.zeqou.fs.rm({ projectId: proj.id, rel: e.rel, base }); paint(); } }
        ]);
      };
      tree.appendChild(row);
    }
  };
  const preview = async (fileRel) => {
    const box = root.querySelector('#fPrev');
    box.innerHTML = '<div class="skeleton" style="height:160px"></div>';
    const r = await window.zeqou.fs.read({ projectId: proj.id, rel: fileRel, base });
    if (!r.ok) { box.innerHTML = `<p class="muted">${esc(r.error)}</p>`; return; }
    if (r.kind === 'image') {
      box.innerHTML = `<div class="file-preview"><img src="data:image/png;base64,${r.base64}" alt="" /></div>
        <div style="margin-top:8px"><button class="mini-btn" id="fpAttach">Attach to chat →</button></div>`;
      box.querySelector('#fpAttach').onclick = () => api.attachProjectFile(proj.id, fileRel);
    } else {
      box.innerHTML = `<div class="file-preview"><pre></pre></div>
        <div style="margin-top:8px"><button class="mini-btn" id="fpAttach">Attach to chat →</button></div>`;
      box.querySelector('.file-preview pre').textContent = r.text;
      box.querySelector('#fpAttach').onclick = () => api.attachProjectFile(proj.id, fileRel);
    }
  };
  root.querySelector('#fSearch').oninput = (e) => paint(e.target.value);
  root.querySelector('#fLink').onclick = () => api.linkProjectFolder(proj.id);
  root.querySelector('#fUnlink') && (root.querySelector('#fUnlink').onclick = () => api.unlinkProjectFolder(proj.id));
  root.querySelector('#fAdd').onclick = (e) => {
    const r = e.target.getBoundingClientRect();
    openMenu(r.left - 140, r.bottom + 6, [
      { label: 'New file', onClick: () => api.addProjectFile(proj.id, paint) },
      { label: 'New folder', onClick: () => api.addProjectFolder(proj.id, paint) },
      { label: 'Import files', onClick: async () => {
        const files = await window.zeqou.dialogs.openFiles();
        for (const f of files) await window.zeqou.fs.import({ projectId: proj.id, srcPath: f.path, base });
        paint(); toast(files.length ? `Imported ${files.length}` : 'Nothing selected', 'ok', 1500);
      } }
    ]);
  };
  paint();
}

/* ---------------- TRY / RUN ---------------- */
function argsHint(schema) {
  const keys = schema && schema.properties ? Object.keys(schema.properties) : [];
  const req = schema && Array.isArray(schema.required) ? schema.required : [];
  if (!keys.length) return 'Takes no arguments.';
  return 'Arguments: ' + keys.join(', ') + (req.length ? ` (required: ${req.join(', ')})` : '');
}

async function openToolTryModal(t, state, api) {
  const ap = state.projects.find(p => p.id === state.activeProjectId);
  const body = `<p class="muted" style="margin-bottom:10px">${esc(argsHint(t.parameters))}</p>
    <div class="field"><label>Arguments (JSON)</label><textarea id="xArgs" rows="4" spellcheck="false">{}</textarea></div>
    <div id="xOut" style="margin-top:10px"></div>`;
  const p = openModal({
    title: `Try ${t.name}`, bodyHTML: body,
    actions: [{ label: 'Close', kind: 'secondary', onClick: c => c(null) }, {
      label: 'Run', onClick: async (_close, back) => {
        let args = {};
        try { args = JSON.parse(back.querySelector('#xArgs').value || '{}'); }
        catch { toast('Not valid JSON', 'err'); return; }
        const btns = [...back.querySelectorAll('.modal-foot .btn')];
        const run = btns[btns.length - 1];
        if (run) run.textContent = 'Running…';
        const rec = await executeTool(state, t.name, args, { projectId: state.activeProjectId, base: ap?.localPath || null, chatId: null, webConfig: getWebConfig() });
        api.update(s => { s.toolCalls.unshift(rec); });
        if (run) run.textContent = 'Run';
        const out = back.querySelector('#xOut');
        out.innerHTML = '';
        out.appendChild(el(`<div class="code-inline" style="white-space:pre-wrap">${esc(rec.ok ? rec.result : 'Error: ' + rec.result)}</div>`));
      }
    }]
  });
  await p;
}

async function openMcpRunModal(sv, t, api) {
  const body = `<p class="muted" style="margin-bottom:10px">${esc(argsHint(t.inputSchema))}</p>
    <div class="field"><label>Arguments (JSON)</label><textarea id="xArgs" rows="4" spellcheck="false">{}</textarea></div>
    <div id="xOut" style="margin-top:10px"></div>`;
  const p = openModal({
    title: `Run ${t.name}`, sub: sv.name, bodyHTML: body,
    actions: [{ label: 'Close', kind: 'secondary', onClick: c => c(null) }, {
      label: 'Run', onClick: async (_close, back) => {
        let args = {};
        try { args = JSON.parse(back.querySelector('#xArgs').value || '{}'); }
        catch { toast('Not valid JSON', 'err'); return; }
        const btns = [...back.querySelectorAll('.modal-foot .btn')];
        const run = btns[btns.length - 1];
        if (run) run.textContent = 'Running…';
        const r = await window.zeqou.mcp.call(serverPayload(sv), t.name, args);
        if (run) run.textContent = 'Run';
        api.update(s => { s.toolCalls.unshift({ id: uid('tc'), tool: 'mcp:' + t.name, args, ok: r.ok, result: String(r.ok ? r.result : r.error).slice(0, 4000), at: now(), chatId: null, ms: 0 }); });
        const out = back.querySelector('#xOut');
        out.innerHTML = '';
        out.appendChild(el(`<div class="code-inline" style="white-space:pre-wrap">${esc(r.ok ? r.result : 'Error: ' + r.error)}</div>`));
      }
    }]
  });
  await p;
}
