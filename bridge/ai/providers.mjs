import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createEncryptedStore } from './secrets.mjs';
import { validateProviderUrl, checkedFetch, readJson, readSSE, readNDJSON, readBedrockEvents, requestSignal } from './http.mjs';

// Catalog metadata the settings UI renders: maxOutputTokens null means the provider's own default applies;
// streamUsage sends stream_options.include_usage; embeddings lists the embedding models Still knows about.
export const PROVIDER_TYPES = [
  { type: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', transport: 'responses', keyRequired: true, temperature: true, maxOutputTokens: 32000, embeddings: { default: 'text-embedding-3-small', models: ['text-embedding-3-small', 'text-embedding-3-large'] } },
  { type: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', transport: 'messages', keyRequired: true, temperature: false, maxOutputTokens: 32000, embeddings: null },
  { type: 'openai-compatible', name: 'OpenAI compatible', baseUrl: '', transport: 'chat', keyRequired: false, temperature: true, maxOutputTokens: null, streamUsage: true, embeddings: { default: '', models: [] } },
  { type: 'anthropic-compatible', name: 'Anthropic compatible', baseUrl: '', transport: 'messages', keyRequired: false, temperature: false, maxOutputTokens: 4096, embeddings: null },
  { type: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', transport: 'chat', keyRequired: true, temperature: true, maxOutputTokens: null, streamUsage: true, embeddings: null },
  { type: 'cloudflare', name: 'Cloudflare Workers AI', baseUrl: 'https://api.cloudflare.com/client/v4', transport: 'chat', keyRequired: true, temperature: true, maxOutputTokens: 4096, embeddings: null },
  { type: 'bedrock', name: 'AWS Bedrock', baseUrl: '', transport: 'bedrock', keyRequired: true, temperature: true, maxOutputTokens: 4096, embeddings: null },
  { type: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', transport: 'gemini', keyRequired: true, temperature: true, maxOutputTokens: null, embeddings: { default: 'gemini-embedding-2', models: ['gemini-embedding-2', 'gemini-embedding-001'] } },
  { type: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', transport: 'ollama', keyRequired: false, temperature: true, maxOutputTokens: 4096, embeddings: { default: 'embeddinggemma', models: ['embeddinggemma', 'nomic-embed-text', 'mxbai-embed-large', 'qwen3-embedding'] } },
  { type: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', transport: 'chat', keyRequired: false, temperature: true, maxOutputTokens: null, streamUsage: true, embeddings: { default: '', models: [] } },
  { type: 'xai', name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', transport: 'chat', keyRequired: true, temperature: true, maxOutputTokens: null, streamUsage: true, embeddings: null },
  { type: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', transport: 'chat', keyRequired: true, temperature: true, maxOutputTokens: null, embeddings: { default: 'mistral-embed', models: ['mistral-embed', 'codestral-embed'] } },
  { type: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', transport: 'chat', keyRequired: true, temperature: true, maxOutputTokens: null, streamUsage: true, embeddings: null },
  { type: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', transport: 'chat', keyRequired: true, temperature: true, maxOutputTokens: null, streamUsage: true, embeddings: null },
  { type: 'voyage', name: 'Voyage AI', baseUrl: 'https://api.voyageai.com/v1', transport: 'none', keyRequired: true, temperature: false, maxOutputTokens: null, embeddings: { default: 'voyage-4', models: ['voyage-4', 'voyage-4-large', 'voyage-4-lite', 'voyage-code-4', 'voyage-3.5', 'voyage-3.5-lite', 'voyage-3-large', 'voyage-code-3'] } },
];
export const ANTHROPIC_VERSION = '2026-10-21';
const COMPATIBLE_ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Server-side refusal fallback ("default" routing) exists for these first-party models only; never Haiku or proxies.
const FALLBACK_MODEL = /^claude-(?:opus-5(?:-5)?|sonnet-5-5|fable-5-1)(?:$|@|-\d{8}$)/;
const THINKING_LIMIT = 4 * 1024 * 1024;
const TYPE_MAP = new Map(PROVIDER_TYPES.map(value => [value.type, value]));
const defaultConfigPath = fileURLToPath(new URL('../.local/ai-providers.enc.json', import.meta.url));
const execute = promisify(execFile);
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, label, maximum = 1000) => { if (typeof value !== 'string' || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error(`${label} must be a bounded string.`); return value; };
const scrub = (message, credentials = {}) => { let result = String(message || 'AI request failed.'); for (const secret of Object.values(credentials)) if (typeof secret === 'string' && secret.length >= 4) result = result.split(secret).join('[redacted]'); return result; };
function claudeModel(model) {
  const match = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:$|[-@])/.exec(model);
  return match ? { line: match[1], version: Number(match[2]) + (match[3] ? Number(match[3]) / 10 : 0) } : null;
}
// Adaptive thinking exists on Claude 4.6+ (Haiku from 5); older models reject it.
const adaptiveThinking = model => { const claude = claudeModel(model); return !!claude && (claude.line === 'fable' || claude.line === 'mythos' || claude.version >= (claude.line === 'haiku' ? 5 : 4.6)); };
function publicProvider(provider) {
  return { id: provider.id, type: provider.type, name: provider.name, baseUrl: provider.baseUrl, model: provider.model, config: structuredClone(provider.config), capabilities: structuredClone(provider.capabilities), hasCredentials: Object.values(provider.credentials || {}).some(Boolean), updatedAt: provider.updatedAt };
}
function validateProvider(input, existing) {
  if (!isObject(input)) throw new Error('Provider settings must be an object.');
  const definition = TYPE_MAP.get(input.type || existing?.type); if (!definition) throw new Error('Unsupported AI provider type.');
  if (existing && input.type && input.type !== existing.type) throw new Error('Create a separate provider to change its protocol type.');
  if (!definition.temperature && Number.isFinite(input.config?.temperature)) throw new Error(definition.transport === 'messages' ? `${definition.name} requests never include temperature; Anthropic API version ${ANTHROPIC_VERSION} rejects it on every model.` : `${definition.name} has no temperature setting.`);
  const config = { ...(existing?.config || {}), ...(input.config || {}) };
  for (const key of Object.keys(config)) if (config[key] === null) delete config[key];
  // A stored temperature from before the 2026-10-21 Messages API is dropped rather than blocking later edits.
  if (!definition.temperature) delete config.temperature;
  const allowedConfig = new Set(['accountId', 'region', 'profile', 'useDefaultCredentials', 'maxOutputTokens', 'temperature', 'reasoningEffort', 'contextWindow', 'additionalModelRequestFields', 'embeddingModel', 'embeddingDimensions', 'anthropicVersion', 'workspaceId']);
  for (const key of Object.keys(config)) if (!allowedConfig.has(key)) throw new Error(`Unsupported AI configuration field: ${key}.`);
  for (const key of ['accountId', 'region', 'profile', 'reasoningEffort', 'embeddingModel']) if (config[key] !== undefined) text(config[key], key, key === 'embeddingModel' ? 500 : 1000);
  if (config.embeddingModel !== undefined && !config.embeddingModel.trim()) delete config.embeddingModel;
  if (config.embeddingDimensions !== undefined && (!Number.isInteger(config.embeddingDimensions) || config.embeddingDimensions < 1 || config.embeddingDimensions > 8192)) throw new Error('Embedding dimensions must be a whole number between 1 and 8192.');
  if (config.anthropicVersion !== undefined && (typeof config.anthropicVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(config.anthropicVersion))) throw new Error('Anthropic version must be a date such as 2023-06-01.');
  if (config.workspaceId !== undefined && (typeof config.workspaceId !== 'string' || !/^[\w-]{1,128}$/.test(config.workspaceId))) throw new Error('Enter a valid Anthropic workspace ID.');
  if (config.region && !/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(config.region)) throw new Error('Enter a valid AWS region.');
  if (config.accountId && !/^[a-zA-Z0-9_-]{1,128}$/.test(config.accountId)) throw new Error('Enter a valid Cloudflare account ID.');
  if (config.profile && !/^[\w.@+=,-]{1,128}$/.test(config.profile)) throw new Error('Enter a valid AWS profile name.');
  if (config.useDefaultCredentials !== undefined && typeof config.useDefaultCredentials !== 'boolean') throw new Error('Default credential chain must be a boolean.');
  for (const key of ['maxOutputTokens', 'contextWindow']) if (config[key] !== undefined && (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > 4000000)) throw new Error(`${key} must be a positive integer.`);
  if (config.temperature !== undefined && (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)) throw new Error('Temperature must be between 0 and 2.');
  if (config.additionalModelRequestFields !== undefined && (!isObject(config.additionalModelRequestFields) || JSON.stringify(config.additionalModelRequestFields).length > 20000)) throw new Error('Bedrock additional request fields must be a bounded JSON object.');
  // First-party Claude models all accept images and the five effort levels; other types start with every control off.
  const typeDefaults = definition.type === 'anthropic' && !existing ? { images: true, reasoningEfforts: ANTHROPIC_EFFORTS } : {};
  const capabilityInput = { ...typeDefaults, ...(existing?.capabilities || {}), ...(input.capabilities || {}) };
  const efforts = capabilityInput.reasoningEfforts || [];
  if (!Array.isArray(efforts) || efforts.length > 20 || efforts.some(effort => typeof effort !== 'string' || !/^[\w-]{1,30}$/.test(effort))) throw new Error('Reasoning efforts must be a list of supported effort names.');
  const capabilities = { images: capabilityInput.images === true, temperature: definition.temperature && capabilityInput.temperature === true, reasoningEfforts: [...new Set(efforts)] };
  const credentials = { ...(existing?.credentials || {}) };
  if (input.credentials !== undefined) {
    if (!isObject(input.credentials)) throw new Error('Provider credentials must be an object.');
    for (const [key, value] of Object.entries(input.credentials)) {
      if (!['apiKey', 'apiToken', 'accessKeyId', 'secretAccessKey', 'sessionToken'].includes(key)) throw new Error('Unsupported credential field.');
      if (value === null) delete credentials[key];
      else { text(value, 'Credential', 16000); if (/[\r\n]/.test(value)) throw new Error('Credentials cannot contain newlines.'); if (value) credentials[key] = value; }
    }
  }
  const rawBase = input.baseUrl || existing?.baseUrl || definition.baseUrl || (definition.type === 'bedrock' ? `https://bedrock-runtime.${config.region || 'us-east-1'}.amazonaws.com` : '');
  const baseUrl = validateProviderUrl(rawBase);
  const id = input.id || existing?.id || `provider_${randomUUID()}`;
  if (!/^[\w-]{1,100}$/.test(id)) throw new Error('Provider ID is invalid.');
  return { id, type: definition.type, name: text(input.name ?? existing?.name ?? definition.name, 'Provider name', 200).trim() || definition.name,
    baseUrl, model: text(input.model ?? existing?.model ?? '', 'Model ID', 500).trim(), config, capabilities, credentials, updatedAt: new Date().toISOString() };
}
function normalizedMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 1000) throw new Error('Provide a bounded list of chat messages.');
  let size = 0;
  return messages.map(message => {
    if (!isObject(message) || !['user', 'assistant'].includes(message.role)) throw new Error('Chat messages must use user or assistant roles.');
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (!Array.isArray(content) || content.length > 100) throw new Error('Message content must be text or a bounded list of text/image blocks.');
    const blocks = content.map(block => {
      if (block.type === 'text' || block.type === 'input_text') { const value = text(block.text, 'Message text', 4 * 1024 * 1024); size += value.length; return { type: 'text', text: value }; }
      const dataUrl = block.type === 'image' ? block.dataUrl : block.type === 'image_url' ? block.image_url?.url : null;
      const match = typeof dataUrl === 'string' && /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
      if (!match || match[2].length % 4 || Buffer.from(match[2], 'base64').toString('base64') !== match[2]) throw new Error('Image context must be a base64 PNG, JPEG, GIF or WebP image.');
      size += dataUrl.length; return { type: 'image', dataUrl, mime: match[1], data: match[2] };
    });
    if (size > 16 * 1024 * 1024) throw new Error('The AI request exceeds the 16 MiB context limit.');
    return { role: message.role, content: blocks };
  });
}
const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const awsEncode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
export function signAwsRequest({ url, method = 'POST', body = '', region, service = 'bedrock', credentials, date = new Date(), headers: inputHeaders = { 'content-type': 'application/json' } }) {
  const parsed = new URL(url); const dateTime = date.toISOString().replace(/[:-]|\.\d{3}/g, ''); const day = dateTime.slice(0, 8);
  const headers = { ...inputHeaders, host: parsed.host, 'x-amz-date': dateTime, 'x-amz-content-sha256': hash(body) };
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;
  const names = Object.keys(headers).sort(); const canonicalHeaders = names.map(name => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('');
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const query = [...parsed.searchParams.entries()].map(([key, value]) => [awsEncode(key), awsEncode(value)]).sort(([a, av], [b, bv]) => a === b ? compare(av, bv) : compare(a, b)).map(([key, value]) => `${key}=${value}`).join('&');
  // AWS's non-S3 signer double-encodes the escaped wire path, including model ARN escapes.
  const segments = parsed.pathname.split('/').filter(Boolean);
  const normalizedPath = `/${segments.join('/')}${segments.length && parsed.pathname.endsWith('/') ? '/' : ''}`;
  const path = awsEncode(normalizedPath).replace(/%2F/g, '/');
  const canonical = [method, path, query, canonicalHeaders, names.join(';'), hash(body)].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`; const stringToSign = `AWS4-HMAC-SHA256\n${dateTime}\n${scope}\n${hash(canonical)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), service), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${createHmac('sha256', signingKey).update(stringToSign).digest('hex')}`;
  return headers;
}
async function defaultAwsCredentials({ profile, signal, execFile: runner = execute }) {
  const args = ['configure', 'export-credentials', '--format', 'process']; if (profile) args.push('--profile', profile);
  let stdout;
  try { ({ stdout } = await runner('aws', args, { windowsHide: true, shell: false, signal, timeout: 15000, maxBuffer: 65536, env: { ...process.env, AWS_PAGER: '' } })); }
  catch { throw new Error('AWS CLI credential resolution failed. Sign in to your selected AWS profile, or enter explicit Bedrock credentials.'); }
  let value;
  try { value = JSON.parse(stdout); } catch { throw new Error('AWS CLI returned invalid credential-process output.'); }
  if (!value.AccessKeyId || !value.SecretAccessKey) throw new Error('AWS CLI returned no usable credentials.');
  return { accessKeyId: value.AccessKeyId, secretAccessKey: value.SecretAccessKey, sessionToken: value.SessionToken || '' };
}

function embeddingInputs(inputs) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 256) throw new Error('Send between 1 and 256 texts to embed.');
  let total = 0;
  return inputs.map(value => {
    if (typeof value !== 'string' || !value.trim() || value.length > 100000 || value.includes('\0')) throw new Error('Each embedding input must be non-empty text of at most 100,000 characters.');
    total += value.length; if (total > 8 * 1024 * 1024) throw new Error('Embedding inputs exceed the 8 MiB request limit.');
    return value;
  });
}
const unitVector = vector => { const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)); return length ? vector.map(value => value / length) : vector; };
function refusalMessage(details) {
  const category = typeof details?.category === 'string' && details.category ? ` (${details.category})` : '';
  const explanation = typeof details?.explanation === 'string' && details.explanation.trim() ? ` ${details.explanation.trim().slice(0, 2000)}` : '';
  return `Claude declined this request${category}.${explanation}`;
}
function modelKind(provider, model, id) {
  if (provider.type === 'gemini') {
    const methods = model.supportedGenerationMethods || [];
    return methods.includes('generateContent') ? 'chat' : methods.includes('embedContent') ? 'embedding' : 'other';
  }
  if (model.capabilities?.completion_chat === false || /embed/i.test(id || '')) return 'embedding';
  return 'chat';
}

export function createAiProviderService({ configPath = defaultConfigPath, fetch: fetcher = globalThis.fetch, timeoutMs = 300000, execFile: runExecutable, now = () => new Date() } = {}) {
  const encrypted = createEncryptedStore({ configPath });
  async function getProvider(id) { const provider = (await encrypted.read()).providers.find(provider => provider.id === id); if (!provider) throw new Error('AI provider not found.'); return provider; }
  async function credentialsFor(provider, signal) {
    if (provider.type === 'bedrock') {
      const credentials = provider.config.useDefaultCredentials ? await defaultAwsCredentials({ profile: provider.config.profile, signal, execFile: runExecutable }) : provider.credentials;
      if (!credentials.accessKeyId || !credentials.secretAccessKey) throw new Error('Add Bedrock credentials or select the AWS CLI default credential chain.');
      return credentials;
    }
    const credentials = provider.credentials;
    if (TYPE_MAP.get(provider.type).keyRequired && !(credentials.apiKey || credentials.apiToken)) throw new Error('Add an API key for this provider first.');
    return credentials;
  }
  function endpoint(provider, path, { control = false } = {}) {
    if (provider.type === 'cloudflare') {
      if (!provider.config.accountId) throw new Error('Enter your Cloudflare account ID.');
      return `${provider.baseUrl}/accounts/${encodeURIComponent(provider.config.accountId)}/ai${path}`;
    }
    if (provider.type === 'bedrock' && control) {
      const url = new URL(provider.baseUrl);
      if (url.hostname.startsWith('bedrock-runtime.')) url.hostname = url.hostname.replace(/^bedrock-runtime\./, 'bedrock.');
      return `${url.href.replace(/\/$/, '')}${path}`;
    }
    return `${provider.baseUrl}${path}`;
  }
  function headersFor(provider, credentials) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (provider.type === 'anthropic' || provider.type === 'anthropic-compatible') {
      if (credentials.apiKey) headers['x-api-key'] = credentials.apiKey;
      // Proxies and self-hosted Messages servers keep the version they were built against unless configured.
      headers['anthropic-version'] = provider.type === 'anthropic' ? ANTHROPIC_VERSION : provider.config.anthropicVersion || COMPATIBLE_ANTHROPIC_VERSION;
      if (provider.type === 'anthropic' && provider.config.workspaceId) headers['anthropic-workspace-id'] = provider.config.workspaceId;
    } else if (provider.type === 'gemini') headers['x-goog-api-key'] = credentials.apiKey;
    else if (credentials.apiKey || credentials.apiToken) headers.Authorization = `Bearer ${credentials.apiKey || credentials.apiToken}`;
    if (provider.type === 'openrouter') headers['X-Title'] = 'Still';
    return headers;
  }
  const friendly = (provider, message) => provider.type === 'anthropic' && /not scoped to a workspace/i.test(message) ? `${message} Add your Anthropic workspace ID to this provider, or create a workspace-scoped API key.` : message;
  async function listModels(id, { signal: callerSignal } = {}) {
    const provider = await getProvider(id), definition = TYPE_MAP.get(provider.type); const signal = requestSignal(callerSignal, Math.min(timeoutMs, 30000)); let credentials = {};
    // Voyage publishes no model-list endpoint; its documented models are offered without a request.
    if (provider.type === 'voyage') return definition.embeddings.models.map(model => ({ id: model, name: model, kind: 'embedding', contextWindow: 32000, maxOutputTokens: null, inputModalities: ['text'], outputModalities: [], supportsImages: false, reasoningEfforts: [] }));
    try {
      credentials = await credentialsFor(provider, signal);
      let path = '/models';
      if (provider.type === 'anthropic') path = '/models?limit=1000';
      if (provider.type === 'gemini') path = '/models?pageSize=1000';
      if (provider.type === 'ollama') path = '/api/tags';
      if (provider.type === 'cloudflare') path = '/models/search?per_page=100';
      if (provider.type === 'bedrock') path = '/foundation-models';
      const first = endpoint(provider, path, { control: true }), collected = [];
      let url = first;
      // Anthropic pages with has_more/last_id and Gemini with nextPageToken; other lists arrive whole.
      for (let page = 0; url && page < 20 && collected.length < 2000; page++) {
        const headers = provider.type === 'bedrock' ? signAwsRequest({ url, method: 'GET', region: provider.config.region || 'us-east-1', credentials, date: now() }) : headersFor(provider, credentials);
        const response = await checkedFetch(fetcher, url, { headers, signal });
        const data = await readJson(response, { signal });
        const models = data.data || data.models || data.modelSummaries || data.result;
        if (!Array.isArray(models)) throw new Error('The provider did not return a supported model list. Enter its exact model ID manually.');
        collected.push(...models);
        const next = new URL(first);
        if (provider.type === 'anthropic' && data.has_more === true && typeof data.last_id === 'string' && data.last_id) { next.searchParams.set('after_id', data.last_id); url = next.href; }
        else if (provider.type === 'gemini' && typeof data.nextPageToken === 'string' && data.nextPageToken) { next.searchParams.set('pageToken', data.nextPageToken); url = next.href; }
        else url = null;
      }
      return collected.slice(0, 2000).map(model => {
        const id = provider.type === 'cloudflare' ? model.name : model.id || model.modelId || (provider.type === 'gemini' ? model.name?.replace(/^models\//, '') : provider.type === 'ollama' ? model.model || model.name : model.name);
        const inputModalities = model.inputModalities || model.architecture?.input_modalities || model.input_modalities || [];
        return { id, name: model.displayName || model.display_name || model.modelName || model.name || model.id, kind: modelKind(provider, model, id),
          contextWindow: model.context_length || model.inputTokenLimit || model.max_input_tokens || model.max_context_length || null, maxOutputTokens: model.max_tokens || model.outputTokenLimit || model.top_provider?.max_completion_tokens || null,
          inputModalities, outputModalities: model.outputModalities || model.architecture?.output_modalities || model.output_modalities || [],
          supportsImages: model.capabilities?.image_input?.supported ?? (typeof model.capabilities?.vision === 'boolean' ? model.capabilities.vision : inputModalities.includes('image') ? true : null),
          reasoningEfforts: model.capabilities?.effort ? Object.entries(model.capabilities.effort).filter(([, value]) => value?.supported === true).map(([key]) => key) : [] };
      }).filter(model => typeof model.id === 'string' && !(provider.type === 'gemini' && model.kind === 'other'));
    } catch (error) { throw new Error(scrub(friendly(provider, error.message), credentials)); }
  }
  async function generate({ providerId, system = '', messages, model: requestedModel, reasoningEffort, temperature, maxOutputTokens, signal: callerSignal, onDelta = () => {}, onThinking = () => {} }) {
    const provider = await getProvider(providerId), definition = TYPE_MAP.get(provider.type); const signal = requestSignal(callerSignal, timeoutMs); let credentials = {}, resultText = '', thinkingText = '';
    const add = async delta => { if (typeof delta !== 'string' || !delta) return; resultText += delta; if (resultText.length > 4 * 1024 * 1024) throw new Error('AI output exceeded the 4 MiB local limit.'); await onDelta(delta); signal.throwIfAborted(); };
    // Reasoning summaries are a separate, optional channel; past the cap they are dropped rather than failing the answer.
    const think = async delta => { if (typeof delta !== 'string' || !delta || thinkingText.length + delta.length > THINKING_LIMIT) return; thinkingText += delta; await onThinking(delta); signal.throwIfAborted(); };
    try {
      signal.throwIfAborted();
      if (definition.transport === 'none') throw new Error(`${definition.name} provides embeddings only. Choose a chat provider for answers.`);
      const normalized = normalizedMessages(messages); text(system, 'System instruction', 1024 * 1024);
      const model = text(requestedModel || provider.model, 'Model ID', 500); if (!model) throw new Error('Choose a model for this provider.');
      const hasImages = normalized.some(message => message.content.some(block => block.type === 'image'));
      if (hasImages && !provider.capabilities.images) throw new Error('Enable image input only after confirming this model supports it.');
      const outputLimit = maxOutputTokens ?? provider.config.maxOutputTokens ?? definition.maxOutputTokens;
      if (outputLimit !== null && (!Number.isInteger(outputLimit) || outputLimit < 1 || outputLimit > 1000000)) throw new Error('Maximum output tokens is out of range.');
      if (!definition.temperature && temperature !== undefined) throw new Error(`Temperature is disabled for ${definition.name}: Anthropic API version ${ANTHROPIC_VERSION} rejects temperature, top_p and top_k on every model.`);
      const chosenTemperature = definition.temperature ? temperature ?? provider.config.temperature : undefined;
      if (chosenTemperature !== undefined && (!provider.capabilities.temperature || !Number.isFinite(chosenTemperature) || chosenTemperature < 0 || chosenTemperature > 2)) throw new Error('Temperature is disabled or out of range for this provider configuration.');
      const effort = reasoningEffort || provider.config.reasoningEffort;
      if (effort && !provider.capabilities.reasoningEfforts.includes(effort)) throw new Error('The chosen reasoning effort is not enabled for this model.');
      const transport = definition.transport;
      credentials = await credentialsFor(provider, signal);
      let body, url, format = 'sse', completed = false, usage, actualModel = model, stopReason, stopDetails, fallback = null;
      const extraHeaders = {};
      const textOnly = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (transport === 'responses') {
        url = endpoint(provider, '/responses');
        body = { model, instructions: system, input: normalized.map(message => ({ role: message.role, content: message.role === 'assistant' ? textOnly(message) : message.content.map(block => block.type === 'text' ? { type: 'input_text', text: block.text } : { type: 'input_image', image_url: block.dataUrl }) })), stream: true, store: false, max_output_tokens: outputLimit };
        if (effort) body.reasoning = { effort };
        if (chosenTemperature !== undefined) body.temperature = chosenTemperature;
      } else if (transport === 'messages') {
        url = endpoint(provider, '/messages');
        body = { model, system, messages: normalized.map(message => ({ role: message.role, content: message.content.map(block => block.type === 'text' ? { type: 'text', text: block.text } : { type: 'image', source: { type: 'base64', media_type: block.mime, data: block.data } }) })), max_tokens: outputLimit, stream: true };
        if (provider.type === 'anthropic') {
          // Summarized adaptive thinking streams readable reasoning; temperature/top_p/top_k are never sent on 2026-10-21.
          if (effort || adaptiveThinking(model)) body.thinking = { type: 'adaptive', display: 'summarized' };
          if (effort) body.output_config = { effort };
          body.cache_control = { type: 'ephemeral' };
          if (FALLBACK_MODEL.test(model)) { body.fallbacks = 'default'; extraHeaders['anthropic-beta'] = 'server-side-fallback-2026-07-01'; }
        } else if (effort) { body.thinking = { type: 'adaptive' }; body.output_config = { effort }; }
      } else if (transport === 'gemini') {
        url = endpoint(provider, `/models/${encodeURIComponent(model.replace(/^models\//, ''))}:streamGenerateContent?alt=sse`);
        body = { systemInstruction: { parts: [{ text: system }] }, contents: normalized.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: message.content.map(block => block.type === 'text' ? { text: block.text } : { inlineData: { mimeType: block.mime, data: block.data } }) })), generationConfig: {} };
        if (outputLimit !== null) body.generationConfig.maxOutputTokens = outputLimit;
        if (effort) body.generationConfig.thinkingConfig = { thinkingLevel: effort };
        if (chosenTemperature !== undefined) body.generationConfig.temperature = chosenTemperature;
      } else if (transport === 'ollama') {
        url = endpoint(provider, '/api/chat'); format = 'ndjson';
        body = { model, messages: [...(system ? [{ role: 'system', content: system }] : []), ...normalized.map(message => ({ role: message.role, content: textOnly(message), ...(hasImages ? { images: message.content.filter(block => block.type === 'image').map(block => block.data) } : {}) }))], stream: true, options: outputLimit !== null ? { num_predict: outputLimit } : {} };
        if (effort) body.think = effort;
        if (chosenTemperature !== undefined) body.options.temperature = chosenTemperature;
      } else if (transport === 'bedrock') {
        url = endpoint(provider, `/model/${encodeURIComponent(model)}/converse-stream`); format = 'bedrock';
        body = { system: system ? [{ text: system }] : [], messages: normalized.map(message => ({ role: message.role, content: message.content.map(block => block.type === 'text' ? { text: block.text } : { image: { format: block.mime.split('/')[1], source: { bytes: block.data } } }) })), inferenceConfig: outputLimit !== null ? { maxTokens: outputLimit } : {} };
        if (chosenTemperature !== undefined) body.inferenceConfig.temperature = chosenTemperature;
        if (effort) throw new Error('Bedrock reasoning settings are model-specific. Set additionalModelRequestFields rather than a generic effort.');
        if (provider.config.additionalModelRequestFields) body.additionalModelRequestFields = provider.config.additionalModelRequestFields;
      } else {
        url = endpoint(provider, provider.type === 'cloudflare' ? '/v1/chat/completions' : '/chat/completions');
        body = { model, messages: [...(system ? [{ role: 'system', content: system }] : []), ...normalized.map(message => ({ role: message.role, content: message.content.every(block => block.type === 'text') ? textOnly(message) : message.content.map(block => block.type === 'text' ? { type: 'text', text: block.text } : { type: 'image_url', image_url: { url: block.dataUrl } }) }))], stream: true };
        if (outputLimit !== null) body.max_tokens = outputLimit;
        if (definition.streamUsage) body.stream_options = { include_usage: true };
        if (effort) body.reasoning_effort = effort;
        if (chosenTemperature !== undefined) body.temperature = chosenTemperature;
      }
      const encoded = JSON.stringify(body);
      const headers = transport === 'bedrock' ? signAwsRequest({ url, body: encoded, region: provider.config.region || 'us-east-1', credentials, date: now() }) : { ...headersFor(provider, credentials), ...extraHeaders };
      headers.Accept = format === 'bedrock' ? 'application/vnd.amazon.eventstream' : format === 'ndjson' ? 'application/x-ndjson' : 'text/event-stream';
      const response = await checkedFetch(fetcher, url, { method: 'POST', headers, body: encoded, signal });
      const handle = async event => {
        if (event.error) throw new Error(event.error.message || event.error);
        if (transport === 'responses') {
          if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') await add(event.delta);
          if (event.type === 'response.reasoning_summary_text.delta') await think(event.delta);
          if (event.type === 'response.completed') { completed = true; usage = event.response?.usage; actualModel = event.response?.model || actualModel; }
          // Running out of output tokens keeps the answer as truncated text; every other incomplete or failed response is an error.
          if (event.type === 'response.incomplete' && event.response?.incomplete_details?.reason === 'max_output_tokens' && resultText) { completed = true; stopReason = 'max_tokens'; usage = event.response?.usage; actualModel = event.response?.model || actualModel; }
          else if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new Error(event.message || event.response?.error?.message || (event.response?.incomplete_details?.reason ? `Response incomplete: ${event.response.incomplete_details.reason}.` : `Response ended with ${event.type}.`));
        } else if (transport === 'messages') {
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') await add(event.delta.text);
          if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') await think(event.delta.thinking);
          if (event.type === 'content_block_start' && event.content_block?.type === 'text') await add(event.content_block.text);
          if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') await think(event.content_block.thinking);
          // A server-side fallback marks the switch with a content block; the streamed text continues on the fallback model.
          if (event.type === 'content_block_start' && event.content_block?.type === 'fallback') { fallback = { from: event.content_block.from?.model || actualModel, to: event.content_block.to?.model || null }; actualModel = fallback.to || actualModel; }
          if (event.type === 'message_start') { usage = event.message?.usage; actualModel = event.message?.model || actualModel; }
          if (event.type === 'message_delta') { usage = { ...usage, ...event.usage }; stopReason = event.delta?.stop_reason ?? stopReason; stopDetails = event.delta?.stop_details ?? event.stop_details ?? stopDetails; }
          if (event.type === 'message_stop') completed = true;
          if (event.type === 'error') throw new Error(event.error?.message || 'Anthropic stream failed.');
        } else if (transport === 'gemini') {
          if (event.promptFeedback?.blockReason) throw new Error(`Gemini blocked this prompt: ${event.promptFeedback.blockReason}.`);
          for (const part of event.candidates?.[0]?.content?.parts || []) await (part.thought ? think(part.text) : add(part.text));
          const reason = event.candidates?.[0]?.finishReason;
          if (reason) { if (!['STOP', 'MAX_TOKENS'].includes(reason)) throw new Error(`Gemini generation stopped: ${reason}.`); completed = true; stopReason = reason; }
          usage = event.usageMetadata || usage; actualModel = event.modelVersion || actualModel;
        } else if (transport === 'ollama') {
          await think(event.message?.thinking);
          await add(event.message?.content);
          if (event.done) { completed = true; usage = { input_tokens: event.prompt_eval_count, output_tokens: event.eval_count }; stopReason = event.done_reason; }
        } else if (transport === 'bedrock') {
          if (event.type === 'contentBlockDelta') await add(event.delta?.text);
          if (event.type === 'messageStop') { completed = true; stopReason = event.stopReason; }
          if (event.type === 'metadata') usage = event.usage;
        } else {
          const choice = event.choices?.[0], delta = choice?.delta;
          // xAI and DeepSeek stream reasoning_content, OpenRouter reasoning; Mistral reasoning models send typed content parts.
          await think(delta?.reasoning_content ?? delta?.reasoning);
          if (Array.isArray(delta?.content)) { for (const part of delta.content) await (part?.type === 'thinking' ? think((part.thinking || []).map(item => item?.text || '').join('')) : add(part?.text)); }
          else if (delta?.content) await add(delta.content);
          if (choice?.finish_reason) { completed = true; stopReason = choice.finish_reason; }
          usage = event.usage || event.x_groq?.usage || usage; actualModel = event.model || actualModel;
        }
      };
      if (format === 'ndjson') await readNDJSON(response, handle, { signal });
      else if (format === 'bedrock') await readBedrockEvents(response, handle, { signal });
      else await readSSE(response, async event => { if (event.data === '[DONE]') { if (transport === 'chat') completed = true; return; } let data; try { data = JSON.parse(event.data); } catch { throw new Error('The AI provider returned an invalid streaming event.'); } await handle(data); }, { signal });
      signal.throwIfAborted();
      if (!completed) throw new Error('The AI stream ended before a completion event. The partial response has not been marked complete.');
      if (stopReason === 'refusal') throw Object.assign(new Error(refusalMessage(stopDetails)), { stopReason });
      if (['max_tokens', 'length', 'MAX_TOKENS'].includes(stopReason) && !resultText.trim()) throw Object.assign(new Error('The model used its whole output budget before writing an answer. Raise the maximum output tokens or lower the effort.'), { stopReason: 'max_tokens' });
      return { text: resultText, thinking: thinkingText, usage, model: actualModel, stopReason, ...(fallback ? { fallback } : {}) };
    } catch (error) {
      const failure = new Error(scrub(signal.aborted ? 'AI generation was stopped or timed out.' : friendly(provider, error.message), credentials));
      failure.partialText = resultText; failure.aborted = signal.aborted; if (error.stopReason && !signal.aborted) failure.stopReason = error.stopReason; throw failure;
    }
  }
  async function embed({ providerId, inputs, model: requestedModel, dimensions: requestedDimensions, inputType = 'document', signal: callerSignal } = {}) {
    const provider = await getProvider(providerId), definition = TYPE_MAP.get(provider.type); const signal = requestSignal(callerSignal, Math.min(timeoutMs, 120000)); let credentials = {};
    try {
      signal.throwIfAborted();
      if (provider.type === 'anthropic' || provider.type === 'anthropic-compatible') throw new Error('Anthropic offers no embeddings API. Add a Voyage AI provider, Anthropic’s recommended embeddings partner.');
      if (!definition.embeddings) throw new Error(`${definition.name} does not offer embeddings through Still. Choose OpenAI, Voyage AI, Gemini, Mistral, Ollama, LM Studio or an OpenAI-compatible server.`);
      const texts = embeddingInputs(inputs);
      if (!['document', 'query'].includes(inputType)) throw new Error('Embedding input type must be document or query.');
      const model = text(requestedModel || provider.config.embeddingModel || definition.embeddings.default || '', 'Embedding model ID', 500).trim();
      if (!model) throw new Error('Choose an embedding model for this provider.');
      const dimensions = requestedDimensions ?? provider.config.embeddingDimensions;
      if (dimensions !== undefined && dimensions !== null && (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192)) throw new Error('Embedding dimensions must be a whole number between 1 and 8192.');
      credentials = await credentialsFor(provider, signal);
      const post = async (url, body) => readJson(await checkedFetch(fetcher, url, { method: 'POST', headers: headersFor(provider, credentials), body: JSON.stringify(body), signal }), { signal, maximum: 64 * 1024 * 1024 });
      const ordered = data => [...(data.data || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(entry => entry.embedding);
      let vectors, usage = { inputTokens: null }, servedModel = model;
      if (provider.type === 'gemini') {
        const name = model.replace(/^models\//, ''), taskField = !/^gemini-embedding-2/.test(name);
        vectors = [];
        // batchEmbedContents takes about 100 requests per call. gemini-embedding-2 rejects taskType and reads the task from a text prefix.
        for (let index = 0; index < texts.length; index += 100) {
          const data = await post(endpoint(provider, `/models/${encodeURIComponent(name)}:batchEmbedContents`), { requests: texts.slice(index, index + 100).map(value => ({ model: `models/${name}`,
            content: { parts: [{ text: taskField ? value : inputType === 'query' ? `task: search result | query: ${value}` : `title: none | text: ${value}` }] },
            ...(taskField ? { taskType: inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT' } : {}), ...(dimensions ? { outputDimensionality: dimensions } : {}) })) });
          vectors.push(...(data.embeddings || []).map(entry => entry?.values));
        }
        // gemini-embedding-001 returns unnormalized vectors below 3072 dimensions.
        vectors = vectors.map(vector => Array.isArray(vector) ? unitVector(vector) : vector);
      } else if (provider.type === 'ollama') {
        const data = await post(endpoint(provider, '/api/embed'), { model, input: texts, truncate: true, ...(dimensions ? { dimensions } : {}) });
        vectors = data.embeddings; servedModel = data.model || model; usage = { inputTokens: data.prompt_eval_count ?? null };
      } else if (provider.type === 'voyage') {
        const data = await post(endpoint(provider, '/embeddings'), { input: texts, model, input_type: inputType, truncation: true, ...(dimensions ? { output_dimension: dimensions } : {}) });
        vectors = ordered(data); servedModel = data.model || model; usage = { inputTokens: data.usage?.total_tokens ?? null };
      } else if (provider.type === 'mistral') {
        const data = await post(endpoint(provider, '/embeddings'), { model, input: texts, ...(dimensions ? { output_dimension: dimensions } : {}) });
        vectors = ordered(data); servedModel = data.model || model; usage = { inputTokens: data.usage?.prompt_tokens ?? data.usage?.total_tokens ?? null };
      } else {
        const data = await post(endpoint(provider, '/embeddings'), { model, input: texts, encoding_format: 'float', ...(dimensions ? { dimensions } : {}) });
        vectors = ordered(data); servedModel = data.model || model; usage = { inputTokens: data.usage?.prompt_tokens ?? data.usage?.total_tokens ?? null };
      }
      const size = vectors?.[0]?.length;
      if (!Array.isArray(vectors) || vectors.length !== texts.length || !size || size > 8192 || vectors.some(vector => !Array.isArray(vector) || vector.length !== size || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)))) throw new Error('The provider returned an unexpected embedding response.');
      return { vectors, model: servedModel, dimensions: size, usage };
    } catch (error) { throw new Error(scrub(signal.aborted ? 'The embedding request was stopped or timed out.' : friendly(provider, error.message), credentials)); }
  }
  async function testProvider(id, options) {
    const provider = await getProvider(id);
    // An embeddings-only provider has no model list to prove the key, so its explicit test embeds one short query.
    if (provider.type === 'voyage') { const result = await embed({ providerId: id, inputs: ['Still connection test'], inputType: 'query', signal: options?.signal }); const models = await listModels(id); return { ok: true, modelCount: models.length, models: models.slice(0, 20), testedAt: new Date().toISOString(), inferenceTested: true, embeddingModel: result.model, dimensions: result.dimensions }; }
    const models = await listModels(id, options); return { ok: true, modelCount: models.length, models: models.slice(0, 20), testedAt: new Date().toISOString(), inferenceTested: false };
  }
  return {
    listProviders: async () => (await encrypted.read()).providers.map(publicProvider),
    saveProvider: input => encrypted.update(state => { const existing = input?.id ? state.providers.find(provider => provider.id === input.id) : undefined; const provider = validateProvider(input, existing); const index = state.providers.findIndex(value => value.id === provider.id); if (index >= 0) state.providers[index] = provider; else state.providers.push(provider); return publicProvider(provider); }),
    deleteProvider: id => encrypted.update(state => { const index = state.providers.findIndex(provider => provider.id === id); if (index < 0) throw new Error('AI provider not found.'); state.providers.splice(index, 1); return { deleted: true, id }; }),
    testProvider, listModels, generate, embed,
  };
}
