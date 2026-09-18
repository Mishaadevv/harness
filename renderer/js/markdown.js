/* Minimal, dependency-free Markdown renderer with code highlighting + sanitization.
 * Supports: headings, bold/italic/code, links, lists, quotes, tables, fenced code, hr.
 */
import { esc } from './utils.js';

/* Single-pass tokenizer: one regex walk over the RAW code, plain gaps are
 * escaped, matches become spans. Inserted markup is never rescanned,
 * so keywords inside strings/comments (or inside our own spans) can't break. */
const LANG_PATTERNS = {
  js: /(\/\/[^\n]*)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|import|export|from|if|else|for|while|class|new|await|async|try|catch|throw|switch|case|break|typeof|interface|extends)\b|\b(true|false|null|undefined|this)\b|([A-Za-z_$][\w$]*)(?=\s*\()/g,
  py: /(#[^\n]*)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")|\b(def|class|return|import|from|if|elif|else|for|while|with|as|pass|raise|try|except|lambda|None|True|False|await|async|yield|in|is|not|and|or)\b|([A-Za-z_]\w*)(?=\s*\()/g,
  json: /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?\b/g,
  generic: /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")|\b\d+(?:\.\d+)?\b/g
};
function langKey(lang) {
  const l = (lang || '').toLowerCase();
  if (/^(js|javascript|ts|typescript|jsx|tsx|java|c|cpp|cs|go|rust|php|swift|kt)$/.test(l)) return 'js';
  if (/^(py|python|rb|sh|bash|yml|yaml)$/.test(l)) return 'py';
  if (/^json$/.test(l)) return 'json';
  return 'generic';
}
function highlight(code, lang) {
  const key = langKey(lang);
  if (key === 'json') return highlightJson(code);
  const re = LANG_PATTERNS[key];
  re.lastIndex = 0;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const full = m[0];
    if (m[1]) out += `<span class="tok-c">${esc(m[1])}</span>`;          // comment
    else if (m[2]) out += `<span class="tok-s">${esc(m[2])}</span>`;     // string
    else if (key === 'generic' && m[3]) out += `<span class="tok-n">${esc(m[3])}</span>`; // number
    else if (m[3] || (key !== 'py' && m[4])) out += `<span class="tok-k">${esc(m[3] || m[4])}</span>`; // keyword
    else if (key === 'py' ? m[4] : m[5]) out += `<span class="tok-f">${esc(key === 'py' ? m[4] : m[5])}</span>`; // call
    else out += esc(full);
    last = m.index + full.length;
    if (!full) re.lastIndex++;
  }
  return out + esc(code.slice(last));
}
function highlightJson(code) {
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?\b)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    if (m[1]) out += m[2] ? `<span class="tok-p">${esc(m[1])}</span>${esc(m[2])}` : `<span class="tok-s">${esc(m[1])}</span>`;
    else if (m[3]) out += `<span class="tok-n">${esc(m[3])}</span>`;
    else if (m[4]) out += `<span class="tok-n">${esc(m[4])}</span>`;
    else out += esc(m[0]);
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}

function inline(s) {
  // images first
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
    const u = String(url).replace(/"/g, '&quot;');
    if (!/^https?:|^data:image\//i.test(u)) return esc(m);
    return `<img src="${u}" alt="${esc(alt)}" style="max-width:100%;border-radius:10px" loading="lazy" />`;
  });
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // underscore italics (_so_): guarded so snake_case identifiers never match
  s = s.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  return s;
}

export function renderMarkdown(src = '') {
  const text = String(src);
  // Extract fenced code blocks
  const blocks = [];
  const without = text.replace(/```(\w*)\n([\s\S]*?)(?:```|$)/g, (m, lang, code) => {
    blocks.push({ lang: (lang || '').trim(), code: code.replace(/\n$/, '') });
    return `\u0000CODE${blocks.length - 1}\u0000`;
  });
  const lines = without.split('\n');
  let html = '', i = 0, inList = null, para = [];
  const flushPara = () => {
    if (para.length) {
      const t = para.join(' ').trim();
      if (t) {
        if (t.startsWith('&gt;') || t.startsWith('>')) html += `<blockquote>${inline(esc(t.replace(/^(&gt;|>)\s?/, '')))}</blockquote>`;
        else html += `<p>${inline(t)}</p>`;
      }
      para = [];
    }
  };
  const closeList = () => { if (inList) { html += inList === 'ul' ? '</ul>' : '</ol>'; inList = null; } };
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    const codePh = line.match(/^\u0000CODE(\d+)\u0000$/);
    if (codePh) {
      flushPara(); closeList();
      const b = blocks[Number(codePh[1])];
      const lang = esc(b.lang || 'code');
      html += `<div class="codeblock"><div class="codeblock-head"><span>${lang}</span><span class="spacer"></span><button class="copy-btn" data-code="${Number(codePh[1])}">Copy</button></div><pre><code>${highlight(b.code, b.lang)}</code></pre></div>`;
      i++; continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      flushPara(); closeList();
      const lvl = line.match(/^#+/)[0].length;
      html += `<h${lvl}>${inline(esc(line.replace(/^#+\s*/, '')))}</h${lvl}>`;
    } else if (/^---+$/.test(line)) { flushPara(); closeList(); html += '<hr/>'; }
    else if (/^\s*&gt;/.test(raw) || /^\s*>/.test(raw)) { flushPara(); closeList(); html += `<blockquote>${inline(esc(line.replace(/^(&gt;|>)\s?/, '')))}</blockquote>`; }
    else if (/^\s*[-*]\s+/.test(raw)) {
      flushPara();
      if (inList !== 'ul') { closeList(); html += '<ul>'; inList = 'ul'; }
      html += `<li>${inline(esc(line.replace(/^\s*[-*]\s+/, '')))}</li>`;
    } else if (/^\s*\d+[.)]\s+/.test(raw)) {
      flushPara();
      if (inList !== 'ol') { closeList(); html += '<ol>'; inList = 'ol'; }
      html += `<li>${inline(esc(line.replace(/^\s*\d+[.)]\s+/, '')))}</li>`;
    } else if (/^\|.*\|$/.test(line) && /^\|?[\s:|-]+\|?$/.test((lines[i + 1] || '').trim())) {
      flushPara(); closeList();
      const head = line.split('|').map(s => s.trim()).filter(Boolean);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { rows.push(lines[i].trim().split('|').map(s => s.trim()).filter(Boolean)); i++; }
      i--;
      html += '<table><thead><tr>' + head.map(h => `<th>${inline(esc(h))}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => `<td>${inline(esc(c))}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
    } else if (line === '') { flushPara(); closeList(); }
    else para.push(esc(raw));
    i++;
  }
  flushPara(); closeList();
  // Attach code payloads for copy buttons
  html = html.replace(/data-code="(\d+)"/g, (m, n) => `data-codeidx="${n}" data-coderaw="${encodeURIComponent(blocks[Number(n)].code)}"`);
  return html || '<p class="muted">Empty response.</p>';
}

export function bindCopyButtons(root) {
  root.querySelectorAll('.copy-btn').forEach(b => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const raw = decodeURIComponent(b.getAttribute('data-coderaw') || '');
      try { await navigator.clipboard.writeText(raw); b.textContent = 'Copied'; }
      catch { b.textContent = 'Failed'; }
      setTimeout(() => { b.textContent = 'Copy'; }, 1400);
    };
  });
  root.querySelectorAll('a[href^="http"]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.zeqou?.shell.openExternal(a.href);
    });
  });
}
