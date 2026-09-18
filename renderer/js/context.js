/* Context-window meter: how much of the model's context the conversation
 * already uses. Estimation is honest and conservative:
 *  • known context windows for popular model families (first match wins);
 *  • ~4 chars/token for latin text, ~1.5 chars/token for CJK;
 *  • counts system-visible history (user + assistant + tool) of the active chat.
 * A user-set "Context length" on a model always wins over the table.
 */
import { resolveModelRef } from './providers.js';
import { fmtTokens } from './utils.js';

/* [regex, context window in tokens] */
const KNOWN_CONTEXT = [
  [/gemini-2\.5-pro/, 2097152],
  [/gemini-(1\.5-pro|2\.5-flash|2\.0-flash|2\.5-flash-lite|1\.5-flash)/, 1048576],
  [/gpt-4\.1/, 1047576],
  [/llama-4/, 1048576],
  [/gpt-5/, 400000],
  [/command-a/, 256000],
  [/grok-(3|4)/, 256000],
  [/claude-(sonnet|opus|haiku|3-5|3-7|4)/, 200000],
  [/^o[134](-|$)|o1-|o3-|o4-/, 200000],
  [/kimi/, 200000],
  [/gemini/, 32768],
  [/gpt-4o/, 128000],
  [/gpt-4-turbo|gpt-4-32k/, 128000],
  [/gpt-3\.5/, 16385],
  [/^gpt-4(-|$)/, 8192],
  [/deepseek/, 131072],
  [/qwen/, 131072],
  [/glm-4/, 128000],
  [/moonshot/, 131072],
  [/mistral|codestral|ministral/, 131072],
  [/llama-3/, 131072],
  [/mixtral/, 32768],
  [/command-r/, 128000],
  [/phi-3/, 128000]
];

export function knownContextFor(modelId = '') {
  const m = String(modelId).toLowerCase();
  for (const [re, n] of KNOWN_CONTEXT) if (re.test(m)) return n;
  return 0;
}

export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u2e80-\u9fff\uac00-\ud7af\u3040-\u30ff]/g) || []).length;
  const other = s.length - cjk;
  return Math.round(other / 4 + cjk / 1.5);
}

export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages || []) {
    const c = m.content;
    const text = typeof c === 'string' ? c : JSON.stringify(c ?? '');
    total += estimateTokens(text) + 4; // per-message overhead
  }
  return total;
}

/* Current usage for the active chat + model.
 * liveText (optional) counts the in-flight streaming answer as well. */
export function contextUsage(state, liveText = '') {
  const chat = (state.chats || []).find(c => c.id === state.activeChatId) || null;
  const ref = (chat && chat.modelRef) || state.composer.modelRef;
  const compacted = !!(chat && chat.compaction && chat.compaction.summary);
  const r = ref ? resolveModelRef(state, ref) : null;
  const modelId = r ? (r.model.modelId || r.model.id || '') : '';
  const userSet = Number(r?.model?.context) || 0;
  const known = userSet || knownContextFor(modelId);
  const limit = known || 0;
  const msgs = [];
  if (chat) {
    for (const m of chat.messages) {
      if (m._hidden) continue;
      if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue;
      let text = m.content || '';
      if (m.role === 'user' && m.attachments?.length) {
        text += '\n' + m.attachments.map(a => a.text || `[attached file: ${a.name}]`).join('\n');
      }
      msgs.push({ role: m.role, content: text });
    }
  }
  // After compaction the older turns live in the summary — count that instead.
  const used = (compacted ? estimateTokens(chat.compaction.summary) : 0)
    + estimateMessagesTokens(msgs)
    + (liveText ? estimateTokens(liveText) + 4 : 0);
  return {
    used,
    limit,
    known: !!known,
    modelId,
    compacted,
    ratio: limit ? Math.min(1, used / limit) : 0,
    label: limit ? `${fmtTokens(used)} / ${fmtTokens(limit)}` : fmtTokens(used)
  };
}
