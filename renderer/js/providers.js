/* Provider registry — plugin-like architecture.
 * Every provider speaks OpenAI-compatible HTTP (chat/completions + models).
 * Adding a new vendor = one preset entry below. Custom endpoints supported.
 * Real HTTP happens in the Electron main process (no CORS, keys stay there).
 *
 * No hardcoded models: the app auto-discovers models from each provider
 * (see autoDiscoverModels in app.js) and only then offers them.
 */
import { uid } from './utils.js';

export const PROVIDER_TYPES = ['openai-compatible', 'openai', 'anthropic-proxy', 'deepseek', 'custom'];

export const DEFAULT_PROVIDERS = [
  {
    id: 'openai', name: 'OpenAI', type: 'openai',
    baseURL: 'https://api.openai.com/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: true, probeModel: 'gpt-4o-mini',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'deepseek', name: 'DeepSeek', type: 'deepseek',
    baseURL: 'https://api.deepseek.com/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'deepseek-chat',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'anthropic', name: 'Anthropic (OpenAI-compatible proxy)', type: 'anthropic-proxy',
    baseURL: 'https://api.anthropic.com/v1', authMode: 'x-api-key',
    organization: '', projectId: '', customHeaders: { 'anthropic-version': '2023-06-01' },
    enabled: false, probeModel: '',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'ollama', name: 'Ollama (local)', type: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1', authMode: 'none',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'llama3.1',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'lmstudio', name: 'LM Studio (local)', type: 'openai-compatible',
    baseURL: 'http://localhost:1234/v1', authMode: 'none',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'local-model',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'openrouter', name: 'OpenRouter', type: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'openai/gpt-4o-mini',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'together', name: 'Together AI', type: 'openai-compatible',
    baseURL: 'https://api.together.xyz/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'groq', name: 'Groq', type: 'openai-compatible',
    baseURL: 'https://api.groq.com/openai/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'llama-3.1-8b-instant',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'mistral', name: 'Mistral', type: 'openai-compatible',
    baseURL: 'https://api.mistral.ai/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'mistral-small-latest',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'xai', name: 'xAI (Grok)', type: 'openai-compatible',
    baseURL: 'https://api.x.ai/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'grok-3-mini',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'gemini', name: 'Google Gemini', type: 'openai-compatible',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'gemini-2.0-flash',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'perplexity', name: 'Perplexity', type: 'openai-compatible',
    baseURL: 'https://api.perplexity.ai', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'sonar',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'fireworks', name: 'Fireworks AI', type: 'openai-compatible',
    baseURL: 'https://api.fireworks.ai/inference/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'deepinfra', name: 'DeepInfra', type: 'openai-compatible',
    baseURL: 'https://api.deepinfra.com/v1/openai', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'cohere', name: 'Cohere', type: 'openai-compatible',
    baseURL: 'https://api.cohere.com/compatibility/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'command-r',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'moonshot', name: 'Moonshot (Kimi)', type: 'openai-compatible',
    baseURL: 'https://api.moonshot.ai/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'moonshot-v1-8k',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'zhipu', name: 'Zhipu (GLM)', type: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'glm-4-flash',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'qwen', name: 'Alibaba Qwen', type: 'openai-compatible',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'qwen-plus',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'siliconflow', name: 'SiliconFlow', type: 'openai-compatible',
    baseURL: 'https://api.siliconflow.cn/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'Qwen/Qwen2.5-7B-Instruct',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'novita', name: 'Novita', type: 'openai-compatible',
    baseURL: 'https://api.novita.ai/v3/openai', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'meta-llama/llama-3.1-8b-instruct',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'hyperbolic', name: 'Hyperbolic', type: 'openai-compatible',
    baseURL: 'https://api.hyperbolic.xyz/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  // ---- New presets (v8 migration adds these to existing installs) ----
  {
    id: 'azure-openai', name: 'Azure OpenAI', type: 'openai-compatible',
    baseURL: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1', authMode: 'api-key',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: '',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'github-copilot', name: 'GitHub Copilot', type: 'openai-compatible',
    baseURL: 'https://api.githubcopilot.com', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: { 'Copilot-Integration-Id': 'vscode-chat' },
    enabled: false, probeModel: 'gpt-4o-mini',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'not_supported' },
    models: []
  },
  {
    id: 'cerebras', name: 'Cerebras', type: 'openai-compatible',
    baseURL: 'https://api.cerebras.ai/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'qwen-3.8-27b',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'sambanova', name: 'SambaNova', type: 'openai-compatible',
    baseURL: 'https://api.sambanova.ai/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'Meta-Llama-3.1-8B-Instruct',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'nebius', name: 'Nebius AI Studio', type: 'openai-compatible',
    baseURL: 'https://api.studio.nebius.ai/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'openai/gpt-oss-120b',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'ppio', name: 'PPIO', type: 'openai-compatible',
    baseURL: 'https://api.ppinfra.com/v3/openai', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'qwen/qwen-2.5-7b-instruct',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'targon', name: 'Targon', type: 'openai-compatible',
    baseURL: 'https://api.targon.com/v4', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'sn50/Llama-3.2-3B-Instruct',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'upstage', name: 'Upstage', type: 'openai-compatible',
    baseURL: 'https://api.upstage.ai/v1/solar', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'solar-pro',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'lfm', name: 'Liquid AI', type: 'openai-compatible',
    baseURL: 'https://api.liquid.ai/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'lfm-3b',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'inference-net', name: 'Inference.net', type: 'openai-compatible',
    baseURL: 'https://api.inference.net/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'meta-llama/llama-3.1-8b-instruct/fp-8',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'aimlapi', name: 'AI/ML API', type: 'openai-compatible',
    baseURL: 'https://api.aimlapi.com/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: '',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'amazon-bedrock', name: 'Amazon Bedrock (OpenAI-compat endpoint)', type: 'openai-compatible',
    baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: '',
    defaults: { temperature: 0.7, maxTokens: 2000, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'baichuan', name: 'Baichuan', type: 'openai-compatible',
    baseURL: 'https://api.baichuan-ai.com/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: '',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'minimax', name: 'MiniMax', type: 'openai-compatible',
    baseURL: 'https://api.minimax.chat/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'abab6.5s-chat',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'stepfun', name: 'StepFun', type: 'openai-compatible',
    baseURL: 'https://api.stepfun.com/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'step-1-8k',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  },
  {
    id: 'nvidia', name: 'NVIDIA NIM', type: 'openai-compatible',
    baseURL: 'https://integrate.api.nvidia.com/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: false, probeModel: 'meta/llama-3.1-8b-instruct',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  }
];

export function blankProvider() {
  return {
    id: uid('prov'), name: 'Custom endpoint', type: 'custom',
    baseURL: 'https://your-gateway.example.com/v1', authMode: 'bearer',
    organization: '', projectId: '', customHeaders: {},
    enabled: true, probeModel: '',
    defaults: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'off' },
    models: []
  };
}

export function providerById(s, id) { return s.providers.find(p => p.id === id); }
/* Secret-free snapshot for the main-process gateway (keys are injected there). */
export function providerSnapshot(p) {
  return { id: p.id, type: p.type, baseURL: p.baseURL, authMode: p.authMode, organization: p.organization, projectId: p.projectId, customHeaders: p.customHeaders || {}, probeModel: p.probeModel };
}
export function allModels(s) {
  const out = [];
  for (const p of s.providers) for (const m of (p.models || [])) out.push({ ...m, providerName: p.name, providerEnabled: p.enabled });
  for (const m of (s.models || [])) {
    const p = providerById(s, m.providerId);
    out.push({ ...m, providerName: p ? p.name : m.providerId, providerEnabled: p ? p.enabled : true });
  }
  return out;
}
export function resolveModelRef(s, ref) {
  if (!ref) return null;
  const [providerId, ...rest] = String(ref).split(':');
  const modelId = rest.join(':');
  const p = providerById(s, providerId);
  if (!p) return null;
  const m = [...(p.models || []), ...(s.models || []).filter(x => x.providerId === providerId)].find(x => x.modelId === modelId || x.id === modelId);
  return p && m ? { provider: p, model: m } : (p ? { provider: p, model: { modelId, label: modelId } } : null);
}
export function modelRefOf(providerId, modelId) { return providerId + ':' + modelId; }

/* Streaming chat through main gateway. Returns {abort, done} */
export function streamChat({ provider, modelId, messages, opts, onToken, onReasoning, onToolDelta, signal }) {
  const requestId = 'req_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  let off = null, settled = false;
  const done = new Promise((resolve, reject) => {
    off = window.zeqou.ai.onStream(requestId, (msg) => {
      if (msg.type === 'token') onToken && onToken(msg.text);
      else if (msg.type === 'reasoning') onReasoning && onReasoning(msg.text);
      else if (msg.type === 'tool_delta') onToolDelta && onToolDelta(msg.toolCalls || []);
      else if (msg.type === 'done') { settled = true; cleanup(); resolve({ toolCalls: msg.toolCalls || [] }); }
      else if (msg.type === 'error') { settled = true; cleanup(); reject(new Error(msg.error || 'Request failed')); }
      else if (msg.type === 'aborted') { settled = true; cleanup(); resolve({ aborted: true, toolCalls: [] }); }
    });
  });
  function cleanup() { try { off && off(); } catch (_) {} }
  if (signal) {
    if (signal.aborted) window.zeqou.ai.abort(requestId);
    else signal.addEventListener('abort', () => window.zeqou.ai.abort(requestId), { once: true });
  }
  // Sanitize provider: never send secrets (main injects them)
  const safeProvider = {
    id: provider.id, type: provider.type, baseURL: provider.baseURL,
    authMode: provider.authMode, organization: provider.organization,
    projectId: provider.projectId, customHeaders: provider.customHeaders || {}
  };
  window.zeqou.ai.chat(requestId, safeProvider, modelId, messages, opts).catch(e => {
    if (!settled) { cleanup(); }
  });
  return {
    requestId, done,
    abort() { window.zeqou.ai.abort(requestId); }
  };
}

export function guessCaps(modelId = '') {
  const m = modelId.toLowerCase();
  return {
    vision: /vision|gpt-4o|claude|gemini|llava|qwen-vl|4o|sonnet|opus/i.test(m),
    tools: !/reasoner|o1-mini|o1-preview/i.test(m),
    reasoning: /reason|o1|o3|deepseek-reasoner|r1|think/i.test(m),
    embeddings: /embed/i.test(m)
  };
}
