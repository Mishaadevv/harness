/* Shared utilities */
export const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
export const now = () => Date.now();
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const timeAgo = (t) => {
  if (!t) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  const d = Math.floor(s / 86400);
  if (d === 1) return 'yesterday';
  if (d < 30) return d + 'd ago';
  return new Date(t).toLocaleDateString();
};
export const fmtTokens = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n);
export function download(filename, text, mime = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export function toast(msg, kind = 'info', ms = 3400) {
  const root = document.getElementById('toastRoot');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<span>${esc(msg)}</span>`;
  root.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, ms);
}
/* Raw provider errors are JSON soup ("HTTP 400: [{\"error\":{\"code\":400,...
 * Extract the human sentence so the toast reads like a message, not a dump. */
export function humanError(e) {
  let s = String(e?.message || e || '');
  // strip provider prefix, keep the payload part
  const m = s.match(/HTTP \d+:\s*([\s\S]*)$/);
  if (m) {
    let payload = m[1].trim();
    // try JSON (object or array-wrapped) and pull the deepest message string
    try {
      const j = JSON.parse(payload);
      let node = Array.isArray(j) ? j[0] : j;
      for (const k of ['error', 'message', 'detail', 'msg']) {
        if (node && typeof node === 'object' && k in node) node = node[k];
      }
      if (typeof node === 'string' && node.trim()) s = node.trim();
      else if (node && typeof node === 'object' && node.message) s = String(node.message);
    } catch (_) {
      // not JSON — plain text after the colon is usually the message already
      if (payload.length > 12 && !/^[\[{]/.test(payload)) s = payload;
    }
  }
  // final polish: cap length, cut trailing JSON fragments
  s = s.replace(/\s*\"status\"\s*:\s*\"?[A-Z_]+\"?[\}\]]*\s*$/i, '').replace(/\},?\s*$/, '').trim();
  if (s.length > 240) s = s.slice(0, 240).replace(/\s\S*$/, '') + '…';
  return s || 'Request failed';
}
export function openModal({ title, sub = '', bodyHTML = '', wide = false, actions = [] }) {
  // actions: [{label, kind:'primary'|'secondary'|'danger', onClick(close)}]
  return new Promise((resolve) => {
    const root = document.getElementById('modalRoot');
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3>${sub ? `<p class="muted">${esc(sub)}</p>` : ''}
      <div class="modal-body">${bodyHTML}</div>
      <div class="modal-foot"></div></div>`;
    const foot = back.querySelector('.modal-foot');
    const close = (v) => { back.remove(); resolve(v); };
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(null); }
    });
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'btn' + (a.kind === 'secondary' ? ' secondary' : a.kind === 'danger' ? ' danger' : '') + (a.small ? ' small' : '');
      b.textContent = a.label;
      b.onclick = () => (a.onClick ? a.onClick(close, back) : close(true));
      foot.appendChild(b);
    }
    if (!actions.length) {
      const b = document.createElement('button');
      b.className = 'btn secondary'; b.textContent = 'Close';
      b.onclick = () => close(null); foot.appendChild(b);
    }
    root.appendChild(back);
  });
}
export function openMenu(x, y, items) {
  // items: [{label, danger?, checked?, onClick} | {sep:true}]
  closeMenu();
  const root = document.getElementById('menuRoot');
  const m = document.createElement('div');
  m.className = 'ctx-menu'; m.id = 'ctxMenu';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; m.appendChild(s); continue; }
    const b = document.createElement('button');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    b.innerHTML = `<span>${esc(it.label)}</span>${it.checked ? '<span class="check">✓</span>' : ''}`;
    b.onclick = () => { closeMenu(); it.onClick && it.onClick(); };
    m.appendChild(b);
  }
  root.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 12) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 12) + 'px';
  setTimeout(() => document.addEventListener('mousedown', menuOutside), 0);
}
function menuOutside(e) {
  const m = document.getElementById('ctxMenu');
  if (m && !m.contains(e.target)) closeMenu();
}
export function closeMenu() {
  document.getElementById('ctxMenu')?.remove();
  document.removeEventListener('mousedown', menuOutside);
}
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
