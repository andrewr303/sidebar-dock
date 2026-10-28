// Provider catalog for the in-extension AI engine. Pure data plus small pure helpers; Node-importable.
// Model ids for non-Anthropic providers follow the October 2026 research notes and are refreshed at runtime from each
// provider's model list, so a retired default only affects the first run.

export const ANTHROPIC_VERSION = '2026-10-21';
// Compatible servers that are not api.anthropic.com may not know the newest version header.
export const ANTHROPIC_COMPAT_VERSION = '2023-06-01';
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const ANTHROPIC_FALLBACK_MODELS = Object.freeze(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
export const DEFAULT_MAX_TOKENS = 32000;

// Ordered from least to most reasoning; clampEffort walks this scale.
export const EFFORT_LEVELS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const ANTHROPIC_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const EFFORT_LABELS = Object.freeze({ none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' });

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const key of Object.keys(value)) freeze(value[key]); }
  return value;
};
const model = (id, label, extra = {}) => ({ id, label, description: '', contextWindow: null, maxOutput: null, images: true, tools: true, reasoning: true, efforts: [], ...extra });
const embed = (id, label, dims, extra = {}) => ({ id, label, dims, dimsOptions: [dims], ...extra });

const CLAUDE_MODELS = [
  model('claude-opus-5-5', 'Claude Opus 5.5', { description: 'Most capable', efforts: [...ANTHROPIC_EFFORTS], defaultEffort: 'medium' }),
  model('claude-sonnet-5-5', 'Claude Sonnet 5.5', { description: 'Fast and capable', efforts: [...ANTHROPIC_EFFORTS], defaultEffort: 'high' }),
  model('claude-haiku-5-5', 'Claude Haiku 5.5', { description: 'Fastest, lowest cost', efforts: [...ANTHROPIC_EFFORTS], defaultEffort: 'medium' }),
  model('claude-fable-5-1', 'Claude Fable 5.1', { efforts: [...ANTHROPIC_EFFORTS], defaultEffort: 'high' }),
];

export const CATALOG = freeze([
  {
    id: 'anthropic', name: 'Anthropic', shortName: 'Claude', kind: 'cloud', via: 'direct', transport: 'anthropic',
    description: 'Claude Opus, Sonnet, Haiku and Fable from the Claude API.',
    baseUrl: 'https://api.anthropic.com/v1', editableBaseUrl: false,
    keyUrl: 'https://platform.claude.com/settings/keys', docsUrl: 'https://platform.claude.com/docs/en/api/overview',
    keyPlaceholder: 'sk-ant-…', needsKey: true, local: false, modelList: true,
    chat: { defaults: CLAUDE_MODELS, recommended: 'claude-opus-5-5', fast: 'claude-haiku-5-5' },
    embeddings: null, embeddingsHint: 'Claude has no embeddings model. Add Voyage AI for semantic search.',
    supports: { tools: true, images: true, reasoning: true, embeddings: false },
  },
  {
    id: 'openai', name: 'OpenAI', shortName: 'ChatGPT models', kind: 'cloud', via: 'direct', transport: 'openai-responses',
    description: 'GPT models from the OpenAI API, plus embeddings for semantic search.',
    baseUrl: 'https://api.openai.com/v1', editableBaseUrl: false,
    keyUrl: 'https://platform.openai.com/api-keys', docsUrl: 'https://developers.openai.com/api/docs/models',
    keyPlaceholder: 'sk-…', needsKey: true, local: false, modelList: true,
    chat: {
      defaults: [
        model('gpt-6.1-sol', 'GPT-6.1 Sol', { description: 'Balanced', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' }),
        model('gpt-6-astra', 'GPT-6 Astra', { description: 'Most capable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' }),
        model('gpt-6.1-terra', 'GPT-6.1 Terra', { description: 'Fast and efficient', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' }),
        model('gpt-6-luna', 'GPT-6 Luna', { description: 'Fastest, lowest cost', efforts: ['none', 'low', 'medium', 'high'], defaultEffort: 'medium' }),
      ],
      recommended: 'gpt-6.1-sol', fast: 'gpt-6-luna',
    },
    embeddings: { default: 'text-embedding-3-small', models: [
      embed('text-embedding-3-small', 'Text embedding 3 small', 1536, { dimsOptions: [512, 1024, 1536], maxBatch: 2048 }),
      embed('text-embedding-3-large', 'Text embedding 3 large', 3072, { dimsOptions: [256, 1024, 3072], maxBatch: 2048 }),
    ] },
    supports: { tools: true, images: true, reasoning: true, embeddings: true },
  },
  {
    id: 'xai', name: 'xAI', shortName: 'Grok', kind: 'cloud', via: 'direct', transport: 'openai-chat',
    description: 'Grok models from the xAI API.',
    baseUrl: 'https://api.x.ai/v1', editableBaseUrl: false,
    keyUrl: 'https://console.x.ai/', docsUrl: 'https://docs.x.ai/docs/models',
    keyPlaceholder: 'xai-…', needsKey: true, local: false, modelList: true,
    // Reasoning on Grok 4.x is always on and its effort control is documented for the Responses API only.
    chatOptions: { streamUsage: false, effortParam: null, reasoningField: 'reasoning_content' },
    chat: {
      defaults: [
        model('grok-4.7', 'Grok 4.7', { description: 'Most capable, best for code', contextWindow: 500000 }),
        model('grok-4.3', 'Grok 4.3', { description: 'Fast, lower cost', contextWindow: 1000000 }),
        model('grok-4.6', 'Grok 4.6', { contextWindow: 500000 }),
      ],
      recommended: 'grok-4.7', fast: 'grok-4.3',
    },
    embeddings: null,
    supports: { tools: true, images: true, reasoning: true, embeddings: false },
  },
  {
    id: 'google', name: 'Google Gemini', shortName: 'Gemini', kind: 'cloud', via: 'direct', transport: 'gemini',
    description: 'Gemini models from Google AI Studio, plus embeddings.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', editableBaseUrl: false,
    keyUrl: 'https://aistudio.google.com/apikey', docsUrl: 'https://ai.google.dev/gemini-api/docs/models',
    keyPlaceholder: 'AIza…', needsKey: true, local: false, modelList: true,
    chat: {
      defaults: [
        model('gemini-3.8-flash', 'Gemini 3.8 Flash', { description: 'Fast and capable', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }),
        model('gemini-4-argon', 'Gemini 4 Argon', { description: 'Most capable', contextWindow: 1000000, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }),
        model('gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', { description: 'Fastest, lowest cost', efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'minimal' }),
      ],
      recommended: 'gemini-3.8-flash', fast: 'gemini-3.5-flash-lite',
    },
    embeddings: { default: 'gemini-embedding-001', models: [
      embed('gemini-embedding-001', 'Gemini embedding 001', 768, { dimsOptions: [768, 1536, 3072], maxBatch: 100, taskType: true, normalize: true }),
      embed('gemini-embedding-2', 'Gemini embedding 2', 768, { dimsOptions: [768, 1536, 3072], maxBatch: 100 }),
    ] },
    supports: { tools: true, images: true, reasoning: true, embeddings: true },
  },
  {
    id: 'openrouter', name: 'OpenRouter', shortName: 'OpenRouter', kind: 'cloud', via: 'direct', transport: 'openai-chat',
    description: 'One key for hundreds of models, including Claude, GPT and Grok.',
    baseUrl: 'https://openrouter.ai/api/v1', editableBaseUrl: false,
    keyUrl: 'https://openrouter.ai/settings/keys', docsUrl: 'https://openrouter.ai/docs/api-reference/overview',
    keyPlaceholder: 'sk-or-…', needsKey: true, local: false, modelList: true,
    chatOptions: { streamUsage: true, effortParam: 'reasoning', reasoningField: 'reasoning',
      headers: { 'HTTP-Referer': 'https://github.com/AVRCORP/sidebar-dock', 'X-Title': 'Still' } },
    chat: {
      defaults: [
        model('anthropic/claude-opus-5.5', 'Claude Opus 5.5', { efforts: [...ANTHROPIC_EFFORTS] }),
        model('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', { efforts: [...ANTHROPIC_EFFORTS] }),
        model('anthropic/claude-haiku-5.5', 'Claude Haiku 5.5', { efforts: [...ANTHROPIC_EFFORTS] }),
        model('openai/gpt-6.1-sol', 'GPT-6.1 Sol', { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }),
        model('x-ai/grok-4.7', 'Grok 4.7'),
        model('google/gemini-3.8-flash', 'Gemini 3.8 Flash'),
      ],
      recommended: 'anthropic/claude-opus-5.5', fast: 'anthropic/claude-haiku-5.5',
    },
    embeddings: null,
    supports: { tools: true, images: true, reasoning: true, embeddings: false },
  },
  {
    id: 'mistral', name: 'Mistral', shortName: 'Mistral', kind: 'cloud', via: 'direct', transport: 'openai-chat',
    description: 'Mistral models, plus mistral-embed for semantic search.',
    baseUrl: 'https://api.mistral.ai/v1', editableBaseUrl: false,
    keyUrl: 'https://console.mistral.ai/api-keys', docsUrl: 'https://docs.mistral.ai/api/',
    needsKey: true, local: false, modelList: true,
    chatOptions: { streamUsage: false, effortParam: null },
    chat: {
      defaults: [
        model('mistral-medium-latest', 'Mistral Medium', { description: 'Balanced' }),
        model('mistral-large-latest', 'Mistral Large', { description: 'Most capable' }),
        model('mistral-small-latest', 'Mistral Small', { description: 'Fast, lower cost' }),
        model('codestral-latest', 'Codestral', { description: 'Code', images: false }),
      ],
      recommended: 'mistral-medium-latest', fast: 'mistral-small-latest',
    },
    embeddings: { default: 'mistral-embed', models: [embed('mistral-embed', 'Mistral embed', 1024, { maxBatch: 512 })] },
    supports: { tools: true, images: true, reasoning: false, embeddings: true },
  },
  {
    id: 'groq', name: 'Groq', shortName: 'Groq', kind: 'cloud', via: 'direct', transport: 'openai-chat',
    description: 'Open models served at very high speed.',
    baseUrl: 'https://api.groq.com/openai/v1', editableBaseUrl: false,
    keyUrl: 'https://console.groq.com/keys', docsUrl: 'https://console.groq.com/docs/models',
    keyPlaceholder: 'gsk_…', needsKey: true, local: false, modelList: true,
    chatOptions: { streamUsage: true, effortParam: 'reasoning_effort', reasoningField: 'reasoning' },
    chat: {
      defaults: [
        model('openai/gpt-oss-120b', 'GPT-OSS 120B', { description: 'Most capable', images: false, efforts: ['low', 'medium', 'high'] }),
        model('openai/gpt-oss-20b', 'GPT-OSS 20B', { description: 'Very fast', images: false, efforts: ['low', 'medium', 'high'] }),
        model('llama-3.3-70b-versatile', 'Llama 3.3 70B', { images: false, reasoning: false }),
        model('llama-3.1-8b-instant', 'Llama 3.1 8B', { description: 'Fastest, lowest cost', images: false, reasoning: false }),
      ],
      recommended: 'openai/gpt-oss-120b', fast: 'llama-3.1-8b-instant',
    },
    embeddings: null,
    supports: { tools: true, images: false, reasoning: true, embeddings: false },
  },
  {
    id: 'deepseek', name: 'DeepSeek', shortName: 'DeepSeek', kind: 'cloud', via: 'direct', transport: 'openai-chat',
    description: 'DeepSeek models with strong reasoning at low cost.',
    baseUrl: 'https://api.deepseek.com', editableBaseUrl: false,
    keyUrl: 'https://platform.deepseek.com/api_keys', docsUrl: 'https://api-docs.deepseek.com/',
    keyPlaceholder: 'sk-…', needsKey: true, local: false, modelList: true,
    // Tool calls in thinking mode fail unless earlier reasoning_content is sent back.
    chatOptions: { streamUsage: true, effortParam: 'reasoning_effort', reasoningField: 'reasoning_content', echoReasoning: true },
    chat: {
      defaults: [
        model('deepseek-v4-pro', 'DeepSeek V4 Pro', { description: 'Most capable', images: false, efforts: ['low', 'high', 'max'], defaultEffort: 'high' }),
        model('deepseek-flash', 'DeepSeek Flash', { description: 'Fast, lower cost', efforts: ['low', 'high', 'max'], defaultEffort: 'high' }),
      ],
      recommended: 'deepseek-v4-pro', fast: 'deepseek-flash',
    },
    embeddings: null,
    supports: { tools: true, images: true, reasoning: true, embeddings: false },
  },
  {
    id: 'perplexity', name: 'Perplexity', shortName: 'Perplexity', kind: 'cloud', via: 'direct', transport: 'openai-responses',
    description: 'Answers with live web search and citations.',
    baseUrl: 'https://api.perplexity.ai/v1', editableBaseUrl: false,
    keyUrl: 'https://www.perplexity.ai/account/api/keys', docsUrl: 'https://docs.perplexity.ai/docs/agent-api',
    keyPlaceholder: 'pplx-…', needsKey: true, local: false, modelList: false,
    // The Agent API takes preset efforts instead of model ids; preset:<effort> selects one.
    responsesOptions: { presets: true },
    chat: {
      defaults: [
        model('preset:fast', 'Sonar', { description: 'Quick answers with search', images: false, tools: false, reasoning: false }),
        model('preset:low', 'Sonar Reasoning', { description: 'Search with reasoning', images: false, tools: false }),
        model('preset:high', 'Deep research', { description: 'Slow, thorough research', images: false, tools: false }),
      ],
      recommended: 'preset:fast', fast: 'preset:fast',
    },
    embeddings: null,
    supports: { tools: false, images: false, reasoning: true, embeddings: false },
  },
  {
    id: 'voyage', name: 'Voyage AI', shortName: 'Voyage', kind: 'cloud', via: 'direct', transport: null,
    description: 'Embeddings for semantic search. Recommended with Claude.',
    baseUrl: 'https://api.voyageai.com/v1', editableBaseUrl: true,
    baseUrlOptions: [
      { url: 'https://api.voyageai.com/v1', label: 'Voyage key' },
      { url: 'https://ai.mongodb.com/v1', label: 'MongoDB Atlas key' },
    ],
    keyUrl: 'https://dashboard.voyageai.com/organization/api-keys', docsUrl: 'https://docs.voyageai.com/docs/embeddings',
    keyPlaceholder: 'pa-…', needsKey: true, local: false, modelList: false,
    chat: null,
    embeddings: { default: 'voyage-4', models: [
      embed('voyage-4', 'Voyage 4', 1024, { dimsOptions: [256, 512, 1024, 2048], maxBatch: 1000, inputType: true }),
      embed('voyage-4-lite', 'Voyage 4 Lite', 1024, { dimsOptions: [256, 512, 1024, 2048], maxBatch: 1000, inputType: true }),
      embed('voyage-4-large', 'Voyage 4 Large', 1024, { dimsOptions: [256, 512, 1024, 2048], maxBatch: 1000, inputType: true }),
      embed('voyage-code-4', 'Voyage Code 4', 1024, { dimsOptions: [256, 512, 1024, 2048], maxBatch: 1000, inputType: true }),
    ] },
    supports: { tools: false, images: false, reasoning: false, embeddings: true },
  },
  {
    id: 'cohere', name: 'Cohere', shortName: 'Cohere', kind: 'cloud', via: 'direct', transport: null,
    description: 'Embeddings for semantic search.',
    baseUrl: 'https://api.cohere.com/v2', editableBaseUrl: false,
    keyUrl: 'https://dashboard.cohere.com/api-keys', docsUrl: 'https://docs.cohere.com/reference/embed',
    needsKey: true, local: false, modelList: false,
    chat: null,
    embeddings: { default: 'embed-v5.0-fast', models: [
      embed('embed-v5.0-fast', 'Embed 5 Fast', 1024, { dimsOptions: [256, 512, 768, 1024, 1536, 2048], maxBatch: 96, inputType: true }),
      embed('embed-v5.0-pro', 'Embed 5 Pro', 1024, { dimsOptions: [256, 512, 768, 1024, 1536, 2048], maxBatch: 96, inputType: true }),
    ] },
    supports: { tools: false, images: false, reasoning: false, embeddings: true },
  },
  {
    id: 'ollama', name: 'Ollama', shortName: 'Ollama', kind: 'local', via: 'direct', transport: 'ollama',
    description: 'Run open models on this computer. No key needed.',
    baseUrl: 'http://localhost:11434', editableBaseUrl: true,
    keyUrl: '', docsUrl: 'https://docs.ollama.com/faq',
    setupHint: 'Start Ollama with OLLAMA_ORIGINS=chrome-extension://* so Still can reach it.',
    needsKey: false, local: true, modelList: true,
    chat: { defaults: [], recommended: '', fast: '' },
    embeddings: { default: 'embeddinggemma', models: [
      embed('embeddinggemma', 'EmbeddingGemma', 768),
      embed('nomic-embed-text', 'Nomic Embed Text', 768),
      embed('qwen3-embedding', 'Qwen3 Embedding', null, { dimsOptions: [] }),
    ] },
    supports: { tools: true, images: true, reasoning: true, embeddings: true },
  },
  {
    id: 'lmstudio', name: 'LM Studio', shortName: 'LM Studio', kind: 'local', via: 'direct', transport: 'openai-chat',
    description: 'Run local models with LM Studio. No key needed.',
    baseUrl: 'http://localhost:1234/v1', editableBaseUrl: true,
    keyUrl: '', docsUrl: 'https://lmstudio.ai/docs/developer/openai-compat',
    needsKey: false, local: true, modelList: true,
    chatOptions: { streamUsage: false, effortParam: null, reasoningField: 'reasoning_content' },
    chat: { defaults: [], recommended: '', fast: '' },
    embeddings: { default: '', models: [] },
    supports: { tools: true, images: true, reasoning: true, embeddings: true },
  },
  {
    id: 'custom-openai', name: 'OpenAI-compatible server', shortName: 'Custom', kind: 'custom', via: 'direct', transport: 'openai-chat',
    description: 'Any server that speaks the OpenAI chat completions API.',
    baseUrl: '', editableBaseUrl: true, baseUrlPlaceholder: 'https://example.com/v1',
    keyUrl: '', docsUrl: '', needsKey: false, local: false, modelList: true,
    chatOptions: { streamUsage: false, effortParam: null, reasoningField: 'reasoning_content' },
    chat: { defaults: [], recommended: '', fast: '' },
    embeddings: { default: '', models: [] },
    supports: { tools: true, images: true, reasoning: true, embeddings: true },
  },
  {
    id: 'custom-anthropic', name: 'Anthropic-compatible server', shortName: 'Custom', kind: 'custom', via: 'direct', transport: 'anthropic',
    description: 'Any server that speaks the Anthropic Messages API.',
    baseUrl: '', editableBaseUrl: true, baseUrlPlaceholder: 'https://example.com/v1',
    keyUrl: '', docsUrl: '', needsKey: false, local: false, modelList: true,
    chat: { defaults: CLAUDE_MODELS, recommended: 'claude-opus-5-5', fast: 'claude-haiku-5-5' },
    embeddings: null,
    supports: { tools: true, images: true, reasoning: true, embeddings: false },
  },
  {
    id: 'bridge', name: 'Local bridge', shortName: 'Bridge', kind: 'bridge', via: 'bridge', transport: 'bridge',
    description: 'Providers set up in the Still bridge on this computer, via local bridge. Keys stay outside the browser.',
    baseUrl: '', editableBaseUrl: false, keyUrl: '', docsUrl: '', needsKey: false, local: true, modelList: true,
    chat: { defaults: [], recommended: '', fast: '' }, embeddings: null,
    supports: { tools: false, images: true, reasoning: true, embeddings: false },
  },
  {
    id: 'agent:claude-code', name: 'Claude Code', shortName: 'Claude Code', kind: 'agent', via: 'agent', transport: 'bridge', agentId: 'claude',
    description: 'Use your Claude Code sign-in, via local bridge.',
    baseUrl: '', editableBaseUrl: false, keyUrl: '', docsUrl: 'https://code.claude.com/docs', needsKey: false, local: true, modelList: false,
    chat: { defaults: [
      model('default', 'Claude Code default', { images: false, tools: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }),
      model('claude-opus-5-5', 'Claude Opus 5.5', { images: false, tools: false, efforts: [...ANTHROPIC_EFFORTS] }),
      model('claude-sonnet-5-5', 'Claude Sonnet 5.5', { images: false, tools: false, efforts: [...ANTHROPIC_EFFORTS] }),
      model('claude-haiku-5-5', 'Claude Haiku 5.5', { images: false, tools: false, efforts: [...ANTHROPIC_EFFORTS] }),
    ], recommended: 'default', fast: 'claude-haiku-5-5' },
    embeddings: null,
    supports: { tools: false, images: false, reasoning: true, embeddings: false },
  },
  {
    id: 'agent:codex', name: 'Codex CLI', shortName: 'Codex', kind: 'agent', via: 'agent', transport: 'bridge', agentId: 'codex',
    description: 'Use the Codex CLI and its sign-in, via local bridge.',
    baseUrl: '', editableBaseUrl: false, keyUrl: '', docsUrl: 'https://developers.openai.com/codex/', needsKey: false, local: true, modelList: false,
    chat: { defaults: [
      model('default', 'Codex default', { images: false, tools: false, efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }),
      model('gpt-6.1-sol', 'GPT-6.1 Sol', { images: false, tools: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }),
      model('gpt-6-astra', 'GPT-6 Astra', { images: false, tools: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }),
      model('gpt-6.1-terra', 'GPT-6.1 Terra', { images: false, tools: false, efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }),
    ], recommended: 'default', fast: 'gpt-6.1-terra' },
    embeddings: null,
    supports: { tools: false, images: false, reasoning: true, embeddings: false },
  },
  {
    id: 'chatgpt-oauth', name: 'ChatGPT', shortName: 'ChatGPT', kind: 'agent', via: 'agent', transport: 'bridge', agentId: 'codex',
    description: 'Use your ChatGPT plan by signing in through Codex, via local bridge.',
    baseUrl: '', editableBaseUrl: false, keyUrl: '', docsUrl: 'https://developers.openai.com/codex/', needsKey: false, local: true, modelList: false,
    chat: { defaults: [
      model('default', 'ChatGPT default', { images: false, tools: false, efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }),
      model('gpt-6.1-sol', 'GPT-6.1 Sol', { images: false, tools: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }),
      model('gpt-6-astra', 'GPT-6 Astra', { images: false, tools: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }),
    ], recommended: 'default', fast: 'default' },
    embeddings: null,
    supports: { tools: false, images: false, reasoning: true, embeddings: false },
  },
]);

const BY_ID = new Map(CATALOG.map(provider => [provider.id, provider]));

export function getProvider(id) { return BY_ID.get(id) || null; }

export function requireProvider(id) {
  const provider = BY_ID.get(id);
  if (!provider) throw new Error('Choose a supported AI provider.');
  return provider;
}

export const directProviders = () => CATALOG.filter(provider => provider.via === 'direct');
export const chatProviders = () => CATALOG.filter(provider => provider.chat);
export const embeddingProviders = () => CATALOG.filter(provider => provider.embeddings);

export function isLoopbackHost(hostname) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(String(hostname).toLowerCase());
}

export function isPrivateHost(hostname) {
  const host = String(hostname).toLowerCase();
  if (isLoopbackHost(host) || host.endsWith('.local')) return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!octets) return false;
  const [a, b] = [Number(octets[1]), Number(octets[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Validates a provider base URL. Remote servers need HTTPS; plain HTTP is allowed for loopback, and for private-network
// hosts only on keyless local providers.
export function normalizeBaseUrl(value, provider = null) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('Enter a full base URL, for example https://example.com/v1.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The base URL must start with https:// (or http:// for a local server).');
  if (url.username || url.password || url.search || url.hash) throw new Error('The base URL cannot contain a password, query string or fragment.');
  const allowHttp = isLoopbackHost(url.hostname) || ((provider?.local || provider?.kind === 'custom') && isPrivateHost(url.hostname));
  if (url.protocol === 'http:' && !allowHttp) throw new Error('Remote servers need https://. Plain http:// works only for servers on this computer or your local network.');
  return url.href.replace(/\/+$/, '');
}

// Chrome match patterns without a port match every port, which is what the manifest's optional hosts declare.
export function originPattern(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname}/*`;
}

export function hostOf(value) {
  try { return new URL(value).host; } catch { return String(value || ''); }
}

export function clampEffort(effort, supported = EFFORT_LEVELS) {
  const list = (supported || []).filter(level => EFFORT_LEVELS.includes(level));
  if (!list.length) return null;
  if (list.includes(effort)) return effort;
  const rank = EFFORT_LEVELS.indexOf(EFFORT_LEVELS.includes(effort) ? effort : 'medium');
  let best = list[0], distance = Infinity;
  for (const level of list) {
    const gap = Math.abs(EFFORT_LEVELS.indexOf(level) - rank);
    // Ties resolve toward less reasoning, which is cheaper and never rejected for being too high.
    if (gap < distance || (gap === distance && EFFORT_LEVELS.indexOf(level) < EFFORT_LEVELS.indexOf(best))) { best = level; distance = gap; }
  }
  return best;
}

export function catalogModel(providerId, modelId) {
  const provider = BY_ID.get(providerId);
  return provider?.chat?.defaults.find(entry => entry.id === modelId) || null;
}

export function catalogEmbeddingModel(providerId, modelId) {
  const provider = BY_ID.get(providerId);
  return provider?.embeddings?.models.find(entry => entry.id === modelId) || null;
}

// The shape listModels() returns, built from a catalog entry.
export function modelFromCatalog(entry, { embeddings = false } = {}) {
  if (embeddings) return { id: entry.id, name: entry.label, contextWindow: null, maxOutput: null, dims: entry.dims ?? null, dimsOptions: entry.dimsOptions || [], capabilities: { tools: false, images: false, reasoning: false, embeddings: true } };
  return { id: entry.id, name: entry.label, description: entry.description || '', contextWindow: entry.contextWindow ?? null, maxOutput: entry.maxOutput ?? null,
    efforts: [...(entry.efforts || [])], defaultEffort: entry.defaultEffort || null,
    capabilities: { tools: entry.tools !== false, images: entry.images !== false, reasoning: entry.reasoning !== false, embeddings: false } };
}

export function supportsFallbacks(modelId) {
  return ANTHROPIC_FALLBACK_MODELS.some(id => modelId === id || new RegExp(`^${id}-\\d{8}$`).test(modelId));
}
