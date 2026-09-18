/* Settings — 6 quiet tabs. Full managers live in the sidebar;
 * here are defaults, providers + keys, and data. Nothing twice. */
import { esc, el, openModal, toast, download } from './utils.js';
import { providerById, blankProvider, guessCaps, allModels, modelRefOf, providerSnapshot } from './providers.js';
import { renderModels } from './view-panels.js';
import { uid, now } from './utils.js';

const TABS = [
  ['general', 'General'], ['appearance', 'Appearance'], ['providers', 'Providers'],
  ['models', 'Models'], ['agent', 'Agent'], ['data', 'Data & Privacy']
];

export function renderSettings(root, state, api, sub = 'general') {
  if (!TABS.some(([id]) => id === sub)) sub = 'general';
  root.innerHTML = `<div class="page-head"><h2>Settings</h2></div>
    <div class="tabs" id="sTabs"></div><div id="sBody"></div>`;
  const tabs = root.querySelector('#sTabs');
  for (const [id, label] of TABS) {
    const b = el(`<button class="tab ${sub === id ? 'active' : ''}">${label}</button>`);
    b.onclick = () => renderSettings(root, state, api, id);
    tabs.appendChild(b);
  }
  const body = root.querySelector('#sBody');
  if (sub === 'models') return renderModels(body, state, api);
  ({ general: vGeneral, appearance: vAppearance, providers: vProviders, agent: vAgent, data: vData })[sub](body, state, api);
}

/* ---------------- GENERAL ---------------- */
function vGeneral(body, state, api) {
  const models = allModels(state).filter(m => m.providerEnabled);
  const cur = state.composer.modelRef ? (models.find(m => modelRefOf(m.providerId, m.modelId) === state.composer.modelRef)?.label || 'Custom') : 'Not set';
  body.innerHTML = `
    <div class="sec"><div class="sec-title">Defaults</div>
      <div class="list-row"><div class="grow"><div class="title">Model</div><div class="sub">${esc(cur)}</div></div>
      <button class="mini-btn" id="gModel">Change</button></div>
      <div class="list-row"><div class="grow"><div class="title">Agent</div></div>
      <select id="gAgent" style="background:var(--panel-2);border:0;border-radius:8px;padding:6px 10px;font-size:12.5px">
        ${state.agents.map(a => `<option value="${a.id}" ${state.activeAgentId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
      </select></div>
      <div class="list-row"><div class="grow"><div class="title">Project</div></div>
      <select id="gProj" style="background:var(--panel-2);border:0;border-radius:8px;padding:6px 10px;font-size:12.5px">
        ${state.projects.map(p => `<option value="${p.id}" ${state.activeProjectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select></div>
    </div>
    <div class="sec"><div class="sec-title">Memory</div>
      <div class="list-row"><div class="grow"><div class="title">Use memory</div></div>
      <label class="switch"><input type="checkbox" id="mG" ${state.settings.memoryGlobal ? 'checked' : ''} /><span class="track"></span><span class="thumb"></span></label></div>
      <div class="list-row"><div class="grow"><div class="title">Memories</div><div class="sub">${state.memories.length} stored</div></div>
      <button class="mini-btn" id="mGo">Open →</button></div>
    </div>
    <div class="sec"><div class="sec-title">Notifications & Shortcuts</div>
      <div class="list-row"><div class="grow"><div class="title">Notify when long runs finish</div></div>
      <label class="switch"><input type="checkbox" id="nE" ${state.settings.notifications ? 'checked' : ''} /><span class="track"></span><span class="thumb"></span></label></div>
      <div class="list-row"><div class="grow"><div class="sub">New chat · Send · Stop · Sidebar</div></div><div><kbd>⌘K</kbd> <kbd>↵</kbd> <kbd>esc</kbd> <kbd>⌘/</kbd></div></div>
    </div>
    <details class="collapsible"><summary>Generation defaults</summary><div class="coll-body">
      <div class="grid-2">
        <div class="field"><label>Temperature</label><input type="number" id="gTemp" step="0.1" min="0" max="2" value="${esc(state.settings.temperature)}" /></div>
        <div class="field"><label>Max tokens</label><input type="number" id="gMax" value="${esc(state.settings.maxTokens)}" /></div>
      </div>
      <div class="grid-2" style="margin-top:10px">
        <div class="field"><label>Reasoning effort</label><select id="gReason">
          ${['off', 'low', 'medium', 'high'].map(v => `<option ${state.settings.reasoningEffort === v ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
        <div class="field"><label>Show reasoning</label><select id="gThink">
          <option value="1" ${state.settings.showThinking ? 'selected' : ''}>On</option><option value="0" ${!state.settings.showThinking ? 'selected' : ''}>Off</option>
        </select></div>
      </div>
    </div></details>`;
  body.querySelector('#gModel').onclick = () => api.pickModel();
  body.querySelector('#gAgent').onchange = (e) => api.update(s => { s.activeAgentId = e.target.value; });
  body.querySelector('#gProj').onchange = (e) => api.update(s => { s.activeProjectId = e.target.value; });
  body.querySelector('#mG').onchange = (e) => api.update(s => { s.settings.memoryGlobal = e.target.checked; });
  body.querySelector('#mGo').onclick = () => api.goto('memories');
  body.querySelector('#nE').onchange = (e) => api.update(s => { s.settings.notifications = e.target.checked; });
  body.querySelector('#gTemp').onchange = (e) => api.update(s => { s.settings.temperature = Number(e.target.value); });
  body.querySelector('#gMax').onchange = (e) => api.update(s => { s.settings.maxTokens = Number(e.target.value); });
  body.querySelector('#gReason').onchange = (e) => api.update(s => { s.settings.reasoningEffort = e.target.value; });
  body.querySelector('#gThink').onchange = (e) => api.update(s => { s.settings.showThinking = e.target.value === '1'; });
}

/* ---------------- APPEARANCE ---------------- */
function vAppearance(body, state, api) {
  body.innerHTML = `<div class="sec"><div class="sec-title">Theme</div>
    <div class="list-row"><div class="grow"><div class="title">Appearance</div><div class="sub">System follows your OS</div></div>
    <div style="display:flex;gap:4px" id="thRow"></div></div></div>`;
  const row = body.querySelector('#thRow');
  for (const [v, label] of [['system', 'Auto'], ['dark', 'Dark'], ['light', 'Light']]) {
    const b = el(`<button class="mini-btn" style="${state.theme === v ? 'color:var(--acc)' : ''}">${label}</button>`);
    b.onclick = () => api.update(s => { s.theme = v; });
    row.appendChild(b);
  }
}

/* ---------------- PROVIDERS (+ keys inline) ---------------- */
function providerFormHTML(p) {
  return `<div class="form-grid">
    <div class="grid-2">
      <div class="field"><label>Name</label><input id="fName" value="${esc(p.name)}" /></div>
      <div class="field"><label>Type</label><select id="fType">
        ${['openai-compatible', 'openai', 'deepseek', 'anthropic-proxy', 'custom'].map(t => `<option ${p.type === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select></div>
    </div>
    <div class="field"><label>Base URL</label><input id="fBase" value="${esc(p.baseURL)}" placeholder="https://api.example.com/v1" /><div class="hint">Any OpenAI-compatible endpoint — cloud or local.</div></div>
    <div class="grid-2">
      <div class="field"><label>Auth</label><select id="fAuth">
        ${['bearer', 'x-api-key', 'api-key', 'none'].map(t => `<option ${p.authMode === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select></div>
      <div class="field"><label>Probe model</label><input id="fProbe" value="${esc(p.probeModel || '')}" placeholder="gpt-4o-mini" /></div>
    </div>
    <details class="collapsible"><summary>Advanced</summary><div class="coll-body">
      <div class="field"><label>Custom headers (JSON)</label><textarea id="fHeaders" rows="2" spellcheck="false">${esc(JSON.stringify(p.customHeaders || {}, null, 2))}</textarea></div>
    </div></details>
  </div>`;
}
function readProviderForm(back, p) {
  p.name = back.querySelector('#fName').value.trim() || p.name;
  p.type = back.querySelector('#fType').value;
  p.baseURL = back.querySelector('#fBase').value.trim().replace(/\/+$/, '');
  p.authMode = back.querySelector('#fAuth').value;
  p.probeModel = back.querySelector('#fProbe').value.trim();
  try { p.customHeaders = JSON.parse(back.querySelector('#fHeaders').value || '{}'); } catch { throw new Error('Headers are not valid JSON'); }
}
function snapshot(p, state) {
  return providerSnapshot(providerById(state, p.id) || p);
}

function vProviders(body, state, api) {
  const on = state.providers.filter(p => p.enabled).length;
  body.innerHTML = `<div class="page-head" style="margin-bottom:12px"><p>Keys never leave this device.</p></div>
    <div class="toolbar"><span style="flex:1"></span><button class="btn secondary small" id="pAdd">Add provider</button></div>
    <div id="pList"></div>`;
  const list = body.querySelector('#pList');
  for (const p of state.providers) {
    const wrap = el(`<div></div>`);
    const row = el(`<div class="list-row"><div class="grow"><div class="title">${esc(p.name)}</div>
      <div class="sub" data-a="sub">${esc(p.baseURL)} · <span data-a="key">checking key…</span></div></div></div>`);
    const sw = el(`<label class="switch" title="Enable"><input type="checkbox" ${p.enabled ? 'checked' : ''} /><span class="track"></span><span class="thumb"></span></label>`);
    sw.querySelector('input').onchange = (e) => {
      api.update(s => { providerById(s, p.id).enabled = e.target.checked; });
      if (e.target.checked) api.rediscover();
    };
    row.appendChild(sw);
    const acts = el(`<div style="display:flex;gap:2px;padding:2px 2px 10px 22px"></div>`);
    const status = el(`<span class="muted" data-a="status" style="font-size:12px"></span>`);
    const mk = (label, fn, danger) => {
      const b = el(`<button class="mini-btn"${danger ? ' style="color:var(--red)"' : ''}>${label}</button>`);
      b.onclick = fn; acts.appendChild(b);
    };
    mk('Test', async () => {
      status.textContent = 'Testing…';
      const r = await window.zeqou.ai.test(snapshot(p, state));
      status.textContent = r.ok ? '✓ ' + r.detail : '✗ ' + r.error;
      status.style.color = r.ok ? 'var(--green)' : 'var(--red)';
    });
    mk('Models', async () => {
      status.textContent = 'Discovering…';
      const r = await window.zeqou.ai.listModels(snapshot(p, state));
      if (!r.ok) { status.textContent = '✗ ' + r.error; status.style.color = 'var(--red)'; return; }
      api.update(s => {
        const pp = providerById(s, p.id);
        const known = new Set((pp.models || []).map(m => m.modelId));
        for (const m of r.models) {
          if (known.has(m.id)) continue;
          pp.models.push({ id: uid('m'), providerId: pp.id, modelId: m.id, label: m.id, context: 0, caps: guessCaps(m.id), status: 'online' });
        }
      });
      status.textContent = `✓ ${r.models.length} models`; status.style.color = 'var(--green)';
      renderSettings(body.closest('.view'), state, api, 'providers');
    });
    mk('API key', () => api.editApiKey(p.id, () => renderSettings(body.closest('.view'), state, api, 'providers')));
    mk('Configure', async () => {
      await openModal({
        title: p.name, wide: true, bodyHTML: providerFormHTML(p),
        actions: [{ label: 'Cancel', kind: 'secondary', onClick: c => c(null) }, {
          label: 'Save', onClick: (close, back) => {
            try { api.update(s => { readProviderForm(back, providerById(s, p.id)); }); close(true); }
            catch (e) { toast(e.message, 'err'); }
          }
        }]
      });
      renderSettings(body.closest('.view'), state, api, 'providers');
    });
    mk('Remove', async () => {
      await openModal({
        title: 'Remove provider?', sub: p.name, bodyHTML: '',
        actions: [{ label: 'Keep', kind: 'secondary', onClick: c => c(null) }, { label: 'Remove', kind: 'danger', onClick: c => { api.update(s => { s.providers = s.providers.filter(x => x.id !== p.id); }); c(true); } }]
      });
      renderSettings(body.closest('.view'), state, api, 'providers');
    }, true);
    wrap.appendChild(row); wrap.appendChild(acts); wrap.appendChild(status);
    list.appendChild(wrap);
    window.zeqou.secrets.masked('provider:' + p.id).then(r => {
      const k = row.querySelector('[data-a="key"]');
      if (k) k.textContent = r.has ? 'key ' + r.masked : (p.authMode === 'none' ? 'no key needed' : 'no key');
    });
  }
  body.querySelector('#pAdd').onclick = async () => {
    const p = blankProvider();
    await openModal({
      title: 'Add provider', sub: 'Any OpenAI-compatible endpoint works.', wide: true, bodyHTML: providerFormHTML(p),
      actions: [{ label: 'Cancel', kind: 'secondary', onClick: c => c(null) }, {
        label: 'Add', onClick: (close, back) => {
          try {
            readProviderForm(back, p);
            api.update(s => { s.providers.push(p); });
            close(true);
            api.rediscover();
          } catch (e) { toast(e.message, 'err'); }
        }
      }]
    });
    renderSettings(body.closest('.view'), state, api, 'providers');
  };
}

/* ---------------- AGENT ---------------- */
function vAgent(body, state, api) {
  body.innerHTML = `
    <div class="sec"><div class="sec-title">Behavior</div>
      <div class="list-row"><div class="grow"><div class="title">Max steps</div></div>
      <input id="aSteps" type="number" min="1" max="12" value="${esc(state.settings.agentMaxSteps)}" style="width:70px;background:var(--panel-2);border:0;border-radius:8px;padding:6px 10px" /></div>
      <div class="list-row"><div class="grow"><div class="title">Auto-approve tools</div></div>
      <label class="switch"><input type="checkbox" id="aAuto" ${state.settings.agentAutoApprove ? 'checked' : ''} /><span class="track"></span><span class="thumb"></span></label></div>
      <div class="list-row"><div class="grow"><div class="title">Auto-compact context</div><div class="sub">Fold older turns into a summary near the context limit; the model can also do it itself via compact_context</div></div>
      <label class="switch"><input type="checkbox" id="aCmp" ${state.settings.autoCompact !== false ? 'checked' : ''} /><span class="track"></span><span class="thumb"></span></label></div>
    </div>
    <div class="sec"><div class="sec-title">Agents</div><div id="aList"></div>
      <div style="padding-top:8px"><button class="btn secondary small" id="aAdd">New agent</button></div></div>`;
  body.querySelector('#aSteps').onchange = (e) => api.update(s => { s.settings.agentMaxSteps = Number(e.target.value); });
  body.querySelector('#aAuto').onchange = (e) => api.update(s => { s.settings.agentAutoApprove = e.target.checked; });
  body.querySelector('#aCmp').onchange = (e) => api.update(s => { s.settings.autoCompact = e.target.checked; });
  const list = body.querySelector('#aList');
  for (const a of state.agents) {
    const row = el(`<div class="list-row"><div class="grow"><div class="title">${esc(a.name)}</div><div class="sub">${esc((a.description || '').slice(0, 80))}</div></div></div>`);
    const eb = el(`<button class="mini-btn">Edit</button>`);
    eb.onclick = () => api.editAgent(a.id, () => renderSettings(body.closest('.view'), state, api, 'agent'));
    row.appendChild(eb); list.appendChild(row);
  }
  body.querySelector('#aAdd').onclick = () => api.editAgent(null, () => renderSettings(body.closest('.view'), state, api, 'agent'));
}

/* ---------------- DATA & PRIVACY ---------------- */
function vData(body, state, api) {
  body.innerHTML = `
    <div class="sec"><div class="sec-title">Backup</div>
      <div class="list-row"><div class="grow"><div class="title">Export backup</div></div>
      <button class="mini-btn" id="dExp">Export</button></div>
      <div class="list-row"><div class="grow"><div class="title">Import backup</div></div>
      <button class="mini-btn" id="dImp">Import</button></div>
      <div class="list-row"><div class="grow"><div class="title">Erase everything</div></div>
      <button class="mini-btn" style="color:var(--red)" id="dWipe">Erase</button></div>
    </div>
    <div class="sec"><div class="sec-title">Privacy</div>
      <p class="muted" style="padding:0 2px">Keys are encrypted locally. No telemetry, no accounts.</p><p class="muted" style="padding:8px 2px 0">Zeqou Harness v1.1.0</p>
      <div class="field" style="margin-top:10px"><label>Local data location</label><input id="aPath" readonly /></div>
    </div>
    <details class="collapsible"><summary>Diagnostics</summary><div class="coll-body" id="dLogs"></div></details>`;
  body.querySelector('#dExp').onclick = () => download('zeqou-backup.json', JSON.stringify(state, null, 2));
  body.querySelector('#dImp').onclick = async () => {
    const files = await window.zeqou.dialogs.openFiles();
    if (!files.length) return;
    const r = await window.zeqou.dialogs.readFileBuffer(files[0].path);
    if (!r.ok) return toast(r.error, 'err');
    try {
      const bin = atob(r.base64);
      const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
      if (data.version !== 1) throw new Error('Unknown backup version');
      api.update(s => { Object.assign(s, data); });
      toast('Restored', 'ok', 1500);
    } catch (e) { toast('Import failed', 'err'); }
  };
  body.querySelector('#dWipe').onclick = async () => {
    await openModal({
      title: 'Erase all local data?', sub: 'Cannot be undone.', bodyHTML: '',
      actions: [{ label: 'Keep', kind: 'secondary', onClick: c => c(null) }, { label: 'Erase', kind: 'danger', onClick: () => { localStorage.clear(); location.reload(); } }]
    });
  };
  window.zeqou.state.path().then(p => { const i = body.querySelector('#aPath'); if (i) i.value = p || ''; });
  window.zeqou.logs.tail(40).then(logs => {
    const box = body.querySelector('#dLogs');
    if (!box) return;
    box.innerHTML = logs.length
      ? logs.slice(-12).reverse().map(l => `<div class="code-inline" style="margin-bottom:6px">${esc(JSON.stringify(l).slice(0, 180))}</div>`).join('')
      : '<p class="muted">No entries.</p>';
  });
}
