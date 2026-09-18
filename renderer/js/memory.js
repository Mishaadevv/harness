/* Memory system: retrieval, injection, attribution. */
import { uid, now } from './utils.js';

export function relevantMemories(state, chat, text, limit = 6) {
  if (!state.settings.memoryGlobal) return [];
  if (chat && chat.memoryOn === false) return [];
  const pool = state.memories.filter(m =>
    !m.projectId || m.projectId === (chat ? chat.projectId : state.activeProjectId) || !chat
  );
  if (!text) return pool.slice(0, limit);
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
  const scored = pool.map(m => {
    const hay = (m.text + ' ' + (m.tags || []).join(' ')).toLowerCase();
    let s = 0;
    for (const w of words) if (hay.includes(w)) s += 2;
    s += Math.min(3, (m.useCount || 0) * 0.3);
    return { m, s };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  const picked = scored.slice(0, limit).map(x => x.m);
  return picked.length ? picked : pool.slice(0, Math.min(2, limit));
}

export function memorySystemBlock(mems) {
  if (!mems.length) return '';
  return 'Relevant long-term memories about the user (use naturally, do not mention this block):\n' +
    mems.map((m, i) => `[M${i + 1}] ${m.text}`).join('\n');
}

export function addMemory(state, { text, tags = [], projectId = null }) {
  const m = { id: uid('mem'), text: String(text).slice(0, 2000), tags, projectId, createdAt: now(), updatedAt: now(), useCount: 0 };
  state.memories.unshift(m);
  return m;
}
