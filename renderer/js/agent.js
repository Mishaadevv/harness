/* Agent Mode runner: Thinking → Tool → Result → Next → Final.
 * Multi-step loop with real tool execution, error recovery, file context,
 * per-step timeline events for the UI. Collapses detail behind expanders.
 */
import { uid, now } from './utils.js';
import { streamChat } from './providers.js';
import { enabledOpenAITools, executeTool, toolCapabilityLine } from './tools.js';
import { relevantMemories, memorySystemBlock } from './memory.js';

export async function runAgent({ state, chat, provider, model, userText, attachments, onEvent, signal, save, confirmTool, compact }) {
  // onEvent({kind:'thinking'|'tool'|'result'|'step'|'token'|'reasoning'|'tool_delta'|'done'|'error', ...})
  const agent = state.agents.find(a => a.id === (chat.agentId || state.activeAgentId)) || state.agents[0];
  const maxSteps = Math.min(12, Math.max(1, agent.maxSteps || state.settings.agentMaxSteps || 6));
  const mems = relevantMemories(state, chat, userText);
  for (const m of mems) m.useCount = (m.useCount || 0) + 1;

  const project = state.projects.find(p => p.id === chat.projectId);
  const sys = [
    project?.systemInstructions ? `Project instructions:\n${project.systemInstructions}` : '',
    agent.instructions ? `Agent role (${agent.name}): ${agent.instructions}` : '',
    toolCapabilityLine(state, chat),
    mems.length ? memorySystemBlock(mems) : '',
    'You are running in Agent Mode. Think step by step. Use tools when they help. ' +
    'After each tool result, decide the next step. When finished, write the final response. ' +
    'Keep intermediate reasoning compact; the UI shows timeline steps. ' +
    'For any job with several steps, keep a visible plan: create tasks with the todo tool ' +
    '(action=add), mark a task doing when you start it and done when it is finished, ' +
    'and add new tasks as you discover more work. The user watches this list live.'
  ].filter(Boolean).join('\n\n');

  const history = chat.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-14)
    .map(m => ({ role: m.role, content: m.content }));

  let fileContext = '';
  if (attachments && attachments.length) {
    fileContext = 'Attached files:\n' + attachments.map(a =>
      `- ${a.name} (${a.kind || 'file'}${a.size ? ', ' + a.size + ' B' : ''})${a.text ? '\n```\n' + String(a.text).slice(0, 4000) + '\n```' : ''}`
    ).join('\n');
  }

  const messages = [
    { role: 'system', content: sys },
    ...history,
    { role: 'user', content: fileContext ? userText + '\n\n' + fileContext : userText }
  ];

  const tools = enabledOpenAITools(state, chat);
  // Let the model manage its own context window while it works.
  // compact_context is a built-in that may already be enabled — adding it
  // twice makes strict providers (Gemini) reject the whole request with
  // "Duplicate function declaration found".
  if (compact && !tools.some(t => t.function?.name === 'compact_context')) {
    tools.push({
      type: 'function',
      function: {
        name: 'compact_context',
        description: 'Compress older conversation history into a compact running summary to free context window space. Call this when the context is running low or before a big new task. Recent messages stay verbatim.',
        parameters: { type: 'object', properties: { instructions: { type: 'string', description: 'Optional: what to emphasize or preserve in the summary' } } }
      }
    });
  }
  const webConfig = readWebConfig();
  const steps = [];
  let stepNo = 0;

  while (stepNo < maxSteps) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    stepNo++;
    onEvent({ kind: 'step', n: stepNo, of: maxSteps });
    let acc = '', reasoning = '';
    onEvent({ kind: 'thinking', n: stepNo });
    const stream = streamChat({
      provider, modelId: model.modelId, messages,
      opts: {
        temperature: state.settings.temperature, maxTokens: state.settings.maxTokens,
        reasoningEffort: state.settings.reasoningEffort,
        tools, toolChoice: tools.length ? 'auto' : undefined
      },
      signal,
      onToken: t => { acc += t; onEvent({ kind: 'token', n: stepNo, text: t }); },
      onReasoning: t => { reasoning += t; onEvent({ kind: 'reasoning', n: stepNo, text: t }); }
    });
    const res = await stream.done;
    if (res.aborted) throw new DOMException('Aborted', 'AbortError');
    const calls = (res.toolCalls || []).filter(c => c.function?.name);
    if (!calls.length) {
      onEvent({ kind: 'final', n: stepNo, text: acc });
      return { text: acc, reasoning, steps, mems };
    }
    // Execute tool calls sequentially with error recovery
    messages.push({ role: 'assistant', content: acc || null, tool_calls: calls.map(c => ({ id: c.id || uid('call'), type: 'function', function: { name: c.function.name, arguments: c.function.arguments || '{}' } })) });
    for (const c of calls) {
      const name = c.function.name;
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch { args = { _raw: c.function.arguments }; }
      onEvent({ kind: 'tool', n: stepNo, name, args });
      const proj = state.projects.find(p => p.id === chat.projectId);
      const ctx = { projectId: chat.projectId, base: proj?.localPath || null, chatId: chat.id, webConfig, compact, onTaskChange: () => onEvent({ kind: 'tasks', n: stepNo }) };
      let rec;
      if (name === 'compact_context' && compact) {
        onEvent({ kind: 'compacting', n: stepNo });
        const r = await compact({ instructions: args?.instructions || '' });
        rec = { id: uid('call'), tool: name, args, ok: !!r.ok, result: r.message || (r.ok ? 'Context compacted.' : 'Nothing to compact.'), at: now(), chatId: chat.id, ms: 0 };
      } else if (confirmTool && !(await confirmTool(name, args))) {
        rec = { id: uid('call'), tool: name, args, ok: false, result: 'Denied by user.', at: now(), chatId: chat.id, ms: 0 };
      } else {
        rec = await executeTool(state, name, args, ctx);
      }
      save && save(rec);
      onEvent({ kind: 'result', n: stepNo, name, ok: rec.ok, result: rec.result, ms: rec.ms });
      steps.push({ n: stepNo, name, args, ok: rec.ok, result: rec.result });
      messages.push({ role: 'tool', tool_call_id: c.id || 'call', content: String(rec.result).slice(0, 8000) });
    }
    // loop continues; model decides next step
  }
  onEvent({ kind: 'final', n: stepNo, text: '_Stopped after the step limit. Increase Max steps in Settings → Agent for longer runs._' });
  return { text: '_Stopped after the step limit._', reasoning: '', steps, mems };
}

function readWebConfig() {
  try { return JSON.parse(localStorage.getItem('zeqou-webcfg') || '{}'); } catch { return {}; }
}
export function saveWebConfig(cfg) {
  try { localStorage.setItem('zeqou-webcfg', JSON.stringify(cfg)); } catch (_) {}
}
export function getWebConfig() { return readWebConfig(); }
