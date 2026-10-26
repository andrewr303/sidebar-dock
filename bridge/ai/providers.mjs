import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createEncryptedStore } from './secrets.mjs';
import { validateProviderUrl, checkedFetch, readJson, readSSE, readNDJSON, readBedrockEvents, requestSignal } from './http.mjs';

export const PROVIDER_TYPES = [
  { type: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', transport: 'responses' },
  { type: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', transport: 'messages' },
  { type: 'openai-compatible', name: 'OpenAI compatible', baseUrl: '', transport: 'chat' },
  { type: 'anthropic-compatible', name: 'Anthropic compatible', baseUrl: '', transport: 'messages' },
  { type: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', transport: 'chat' },
  { type: 'cloudflare', name: 'Cloudflare Workers AI', baseUrl: 'https://api.cloudflare.com/client/v4', transport: 'chat' },
  { type: 'bedrock', name: 'AWS Bedrock', baseUrl: '', transport: 'bedrock' },
  { type: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', transport: 'gemini' },
  { type: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', transport: 'ollama' },
  { type: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', transport: 'chat' },
];
const TYPE_MAP = new Map(PROVIDER_TYPES.map(value => [value.type, value]));
const defaultConfigPath = fileURLToPath(new URL('../.local/ai-providers.enc.json', import.meta.url));
const execute = promisify(execFile);
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, label, maximum = 1000) => { if (typeof value !== 'string' || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error(`${label} must be a bounded string.`); return value; };
const scrub = (message, credentials = {}) => { let result = String(message || 'AI request failed.'); for (const secret of Object.values(credentials)) if (typeof secret === 'string' && secret.length >= 4) result = result.split(secret).join('[redacted]'); return result; };
function publicProvider(provider) {
  return { id: provider.id, type: provider.type, name: provider.name, baseUrl: provider.baseUrl, model: provider.model, config: structuredClone(provider.config), capabilities: structuredClone(provider.capabilities), hasCredentials: Object.values(provider.credentials || {}).some(Boolean), updatedAt: provider.updatedAt };
}
function validateProvider(input, existing) {
  if (!isObject(input)) throw new Error('Provider settings must be an object.');
  const definition = TYPE_MAP.get(input.type || existing?.type); if (!definition) throw new Error('Unsupported AI provider type.');
  if (existing && input.type && input.type !== existing.type) throw new Error('Create a separate provider to change its protocol type.');
  const config = { ...(existing?.config || {}), ...(input.config || {}) };
  for (const key of Object.keys(config)) if (config[key] === null) delete config[key];
  const allowedConfig = new Set(['accountId', 'region', 'profile', 'useDefaultCredentials', 'maxOutputTokens', 'temperature', 'reasoningEffort', 'contextWindow', 'additionalModelRequestFields']);
  for (const key of Object.keys(config)) if (!allowedConfig.has(key)) throw new Error(`Unsupported AI configuration field: ${key}.`);
  for (const key of ['accountId', 'region', 'profile', 'reasoningEffort']) if (config[key] !== undefined) text(config[key], key);
  if (config.region && !/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(config.region)) throw new Error('Enter a valid AWS region.');
  if (config.accountId && !/^[a-zA-Z0-9_-]{1,128}$/.test(config.accountId)) throw new Error('Enter a valid Cloudflare account ID.');
  if (config.profile && !/^[\w.@+=,-]{1,128}$/.test(config.profile)) throw new Error('Enter a valid AWS profile name.');
  if (config.useDefaultCredentials !== undefined && typeof config.useDefaultCredentials !== 'boolean') throw new Error('Default credential chain must be a boolean.');
  for (const key of ['maxOutputTokens', 'contextWindow']) if (config[key] !== undefined && (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > 4000000)) throw new Error(`${key} must be a positive integer.`);
  if (config.temperature !== undefined && (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)) throw new Error('Temperature must be between 0 and 2.');
  if (config.additionalModelRequestFields !== undefined && (!isObject(config.additionalModelRequestFields) || JSON.stringify(config.additionalModelRequestFields).length > 20000)) throw new Error('Bedrock additional request fields must be a bounded JSON object.');
  const capabilityInput = { ...(existing?.capabilities || {}), ...(input.capabilities || {}) };
  const efforts = capabilityInput.reasoningEfforts || [];
  if (!Array.isArray(efforts) || efforts.length > 20 || efforts.some(effort => typeof effort !== 'string' || !/^[\w-]{1,30}$/.test(effort))) throw new Error('Reasoning efforts must be a list of supported effort names.');
  const capabilities = { images: capabilityInput.images === true, temperature: capabilityInput.temperature === true, reasoningEfforts: [...new Set(efforts)] };
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

export function createAiProviderService({ configPath = defaultConfigPath, fetch: fetcher = globalThis.fetch, timeoutMs = 120000, execFile: runExecutable, now = () => new Date() } = {}) {
  const encrypted = createEncryptedStore({ configPath });
  async function getProvider(id) { const provider = (await encrypted.read()).providers.find(provider => provider.id === id); if (!provider) throw new Error('AI provider not found.'); return provider; }
  async function credentialsFor(provider, signal) {
    if (provider.type === 'bedrock') {
      const credentials = provider.config.useDefaultCredentials ? await defaultAwsCredentials({ profile: provider.config.profile, signal, execFile: runExecutable }) : provider.credentials;
      if (!credentials.accessKeyId || !credentials.secretAccessKey) throw new Error('Add Bedrock credentials or select the AWS CLI default credential chain.');
      return credentials;
    }
    const credentials = provider.credentials;
    if (!['ollama', 'lmstudio', 'openai-compatible', 'anthropic-compatible'].includes(provider.type) && !(credentials.apiKey || credentials.apiToken)) throw new Error('Add an API key for this provider first.');
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
    if (provider.type === 'anthropic' || provider.type === 'anthropic-compatible') { if (credentials.apiKey) headers['x-api-key'] = credentials.apiKey; headers['anthropic-version'] = '2023-06-01'; }
    else if (provider.type === 'gemini') headers['x-goog-api-key'] = credentials.apiKey;
    else if (credentials.apiKey || credentials.apiToken) headers.Authorization = `Bearer ${credentials.apiKey || credentials.apiToken}`;
    return headers;
  }
  async function listModels(id, { signal: callerSignal } = {}) {
    const provider = await getProvider(id); const signal = requestSignal(callerSignal, Math.min(timeoutMs, 30000)); let credentials = {};
    try {
      credentials = await credentialsFor(provider, signal);
      let path = '/models';
      if (provider.type === 'ollama') path = '/api/tags';
      if (provider.type === 'cloudflare') path = '/models/search?per_page=100';
      if (provider.type === 'bedrock') path = '/foundation-models';
      const url = endpoint(provider, path, { control: true });
      const headers = provider.type === 'bedrock' ? signAwsRequest({ url, method: 'GET', region: provider.config.region || 'us-east-1', credentials, date: now() }) : headersFor(provider, credentials);
      const response = await checkedFetch(fetcher, url, { headers, signal });
      const data = await readJson(response, { signal });
      const models = data.data || data.models || data.modelSummaries || data.result;
      if (!Array.isArray(models)) throw new Error('The provider did not return a supported model list. Enter its exact model ID manually.');
      return models.slice(0, 2000).map(model => ({ id: provider.type === 'cloudflare' ? model.name : model.id || model.modelId || (provider.type === 'gemini' ? model.name?.replace(/^models\//, '') : model.name), name: model.displayName || model.display_name || model.modelName || model.name || model.id,
        contextWindow: model.context_length || model.inputTokenLimit || model.max_input_tokens || null, inputModalities: model.inputModalities || model.architecture?.input_modalities || [], outputModalities: model.outputModalities || model.architecture?.output_modalities || [],
        supportsImages: model.capabilities?.image_input?.supported ?? null, reasoningEfforts: model.capabilities?.effort ? Object.entries(model.capabilities.effort).filter(([, value]) => value?.supported === true).map(([key]) => key) : [] })).filter(model => typeof model.id === 'string');
    } catch (error) { throw new Error(scrub(error.message, credentials)); }
  }
  async function generate({ providerId, system = '', messages, model: requestedModel, reasoningEffort, temperature, maxOutputTokens, signal: callerSignal, onDelta = () => {} }) {
    const provider = await getProvider(providerId); const signal = requestSignal(callerSignal, timeoutMs); let credentials = {}, resultText = '';
    const add = async delta => { if (typeof delta !== 'string' || !delta) return; resultText += delta; if (resultText.length > 4 * 1024 * 1024) throw new Error('AI output exceeded the 4 MiB local limit.'); await onDelta(delta); signal.throwIfAborted(); };
    try {
      signal.throwIfAborted();
      const normalized = normalizedMessages(messages); text(system, 'System instruction', 1024 * 1024);
      const model = text(requestedModel || provider.model, 'Model ID', 500); if (!model) throw new Error('Choose a model for this provider.');
      const hasImages = normalized.some(message => message.content.some(block => block.type === 'image'));
      if (hasImages && !provider.capabilities.images) throw new Error('Enable image input only after confirming this model supports it.');
      const outputLimit = maxOutputTokens ?? provider.config.maxOutputTokens ?? 4096;
      if (!Number.isInteger(outputLimit) || outputLimit < 1 || outputLimit > 1000000) throw new Error('Maximum output tokens is out of range.');
      const chosenTemperature = temperature ?? provider.config.temperature;
      if (chosenTemperature !== undefined && (!provider.capabilities.temperature || !Number.isFinite(chosenTemperature) || chosenTemperature < 0 || chosenTemperature > 2)) throw new Error('Temperature is disabled or out of range for this provider configuration.');
      const effort = reasoningEffort || provider.config.reasoningEffort;
      if (effort && !provider.capabilities.reasoningEfforts.includes(effort)) throw new Error('The chosen reasoning effort is not enabled for this model.');
      const transport = TYPE_MAP.get(provider.type).transport;
      credentials = await credentialsFor(provider, signal);
      let body, url, format = 'sse', completed = false, usage, actualModel = model, stopReason;
      const textOnly = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (transport === 'responses') {
        url = endpoint(provider, '/responses');
        body = { model, instructions: system, input: normalized.map(message => ({ role: message.role, content: message.role === 'assistant' ? textOnly(message) : message.content.map(block => block.type === 'text' ? { type: 'input_text', text: block.text } : { type: 'input_image', image_url: block.dataUrl }) })), stream: true, store: false, max_output_tokens: outputLimit };
        if (effort) body.reasoning = { effort };
        if (chosenTemperature !== undefined) body.temperature = chosenTemperature;
      } else if (transport === 'messages') {
        url = endpoint(provider, '/messages');
        body = { model, system, messages: normalized.map(message => ({ role: message.role, content: message.content.map(block => block.type === 'text' ? { type: 'text', text: block.text } : { type: 'image', source: { type: 'base64', media_type: block.mime, data: block.data } }) })), max_tokens: outputLimit, stream: true };
        if (effort) { body.thinking = { type: 'adaptive' }; body.output_config = { effort }; }
        if (chosenTemperature !== undefined) body.temperature = chosenTemperature;
      } else if (transport === 'gemini') {
        url = endpoint(provider, `/models/${encodeURIComponent(model.replace(/^models\//, ''))}:streamGenerateContent?alt=sse`);
        body = { systemInstruction: { parts: [{ text: system }] }, contents: normalized.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: message.content.map(block => block.type === 'text' ? { text: block.text } : { inlineData: { mimeType: block.mime, data: block.data } }) })), generationConfig: { maxOutputTokens: outputLimit } };
        if (effort) body.generationConfig.thinkingConfig = { thinkingLevel: effort };
        if (chosenTemperature !== undefined) body.generationConfig.temperature = chosenTemperature;
      } else if (transport === 'ollama') {
        url = endpoint(provider, '/api/chat'); format = 'ndjson';
        body = { model, messages: [...(system ? [{ role: 'system', content: system }] : []), ...normalized.map(message => ({ role: message.role, content: textOnly(message), ...(hasImages ? { images: message.content.filter(block => block.type === 'image').map(block => block.data) } : {}) }))], stream: true, options: { num_predict: outputLimit } };
        if (effort) body.think = effort;
        if (chosenTemperature !== undefined) body.options.temperature = chosenTemperature;
      } else if (transport === 'bedrock') {
        url = endpoint(provider, `/model/${encodeURIComponent(model)}/converse-stream`); format = 'bedrock';
        body = { system: system ? [{ text: system }] : [], messages: normalized.map(message => ({ role: message.role, content: message.content.map(block => block.type === 'text' ? { text: block.text } : { image: { format: block.mime.split('/')[1], source: { bytes: block.data } } }) })), inferenceConfig: { maxTokens: outputLimit } };
        if (chosenTemperature !== undefined) body.inferenceConfig.temperature = chosenTemperature;
        if (effort) throw new Error('Bedrock reasoning settings are model-specific. Set additionalModelRequestFields rather than a generic effort.');
        if (provider.config.additionalModelRequestFields) body.additionalModelRequestFields = provider.config.additionalModelRequestFields;
      } else {
        url = endpoint(provider, provider.type === 'cloudflare' ? '/v1/chat/completions' : '/chat/completions');
        body = { model, messages: [...(system ? [{ role: 'system', content: system }] : []), ...normalized.map(message => ({ role: message.role, content: message.content.every(block => block.type === 'text') ? textOnly(message) : message.content.map(block => block.type === 'text' ? { type: 'text', text: block.text } : { type: 'image_url', image_url: { url: block.dataUrl } }) }))], stream: true, max_tokens: outputLimit };
        if (effort) body.reasoning_effort = effort;
        if (chosenTemperature !== undefined) body.temperature = chosenTemperature;
      }
      const encoded = JSON.stringify(body);
      const headers = transport === 'bedrock' ? signAwsRequest({ url, body: encoded, region: provider.config.region || 'us-east-1', credentials, date: now() }) : headersFor(provider, credentials);
      headers.Accept = format === 'bedrock' ? 'application/vnd.amazon.eventstream' : format === 'ndjson' ? 'application/x-ndjson' : 'text/event-stream';
      const response = await checkedFetch(fetcher, url, { method: 'POST', headers, body: encoded, signal });
      const handle = async event => {
        if (event.error) throw new Error(event.error.message || event.error);
        if (transport === 'responses') {
          if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') await add(event.delta);
          if (event.type === 'response.completed') { completed = true; usage = event.response?.usage; actualModel = event.response?.model || actualModel; }
          if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new Error(event.message || event.response?.error?.message || `Response ended with ${event.type}.`);
        } else if (transport === 'messages') {
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') await add(event.delta.text);
          if (event.type === 'content_block_start' && event.content_block?.type === 'text') await add(event.content_block.text);
          if (event.type === 'message_start') { usage = event.message?.usage; actualModel = event.message?.model || actualModel; }
          if (event.type === 'message_delta') { usage = { ...usage, ...event.usage }; stopReason = event.delta?.stop_reason; }
          if (event.type === 'message_stop') completed = true;
          if (event.type === 'error') throw new Error(event.error?.message || 'Anthropic stream failed.');
        } else if (transport === 'gemini') {
          if (event.promptFeedback?.blockReason) throw new Error(`Gemini blocked this prompt: ${event.promptFeedback.blockReason}.`);
          for (const part of event.candidates?.[0]?.content?.parts || []) if (!part.thought) await add(part.text);
          const reason = event.candidates?.[0]?.finishReason;
          if (reason) { if (!['STOP', 'MAX_TOKENS'].includes(reason)) throw new Error(`Gemini generation stopped: ${reason}.`); completed = true; stopReason = reason; }
          usage = event.usageMetadata || usage; actualModel = event.modelVersion || actualModel;
        } else if (transport === 'ollama') {
          await add(event.message?.content);
          if (event.done) { completed = true; usage = { input_tokens: event.prompt_eval_count, output_tokens: event.eval_count }; stopReason = event.done_reason; }
        } else if (transport === 'bedrock') {
          if (event.type === 'contentBlockDelta') await add(event.delta?.text);
          if (event.type === 'messageStop') { completed = true; stopReason = event.stopReason; }
          if (event.type === 'metadata') usage = event.usage;
        } else {
          const delta = event.choices?.[0]?.delta; if (delta?.content) await add(delta.content);
          if (event.choices?.[0]?.finish_reason) { completed = true; stopReason = event.choices[0].finish_reason; }
          usage = event.usage || usage; actualModel = event.model || actualModel;
        }
      };
      if (format === 'ndjson') await readNDJSON(response, handle, { signal });
      else if (format === 'bedrock') await readBedrockEvents(response, handle, { signal });
      else await readSSE(response, async event => { if (event.data === '[DONE]') { if (transport === 'chat') completed = true; return; } let data; try { data = JSON.parse(event.data); } catch { throw new Error('The AI provider returned an invalid streaming event.'); } await handle(data); }, { signal });
      signal.throwIfAborted();
      if (!completed) throw new Error('The AI stream ended before a completion event. The partial response has not been marked complete.');
      return { text: resultText, usage, model: actualModel, stopReason };
    } catch (error) {
      const failure = new Error(scrub(signal.aborted ? 'AI generation was stopped or timed out.' : error.message, credentials));
      failure.partialText = resultText; failure.aborted = signal.aborted; throw failure;
    }
  }
  return {
    listProviders: async () => (await encrypted.read()).providers.map(publicProvider),
    saveProvider: input => encrypted.update(state => { const existing = input?.id ? state.providers.find(provider => provider.id === input.id) : undefined; const provider = validateProvider(input, existing); const index = state.providers.findIndex(value => value.id === provider.id); if (index >= 0) state.providers[index] = provider; else state.providers.push(provider); return publicProvider(provider); }),
    deleteProvider: id => encrypted.update(state => { const index = state.providers.findIndex(provider => provider.id === id); if (index < 0) throw new Error('AI provider not found.'); state.providers.splice(index, 1); return { deleted: true, id }; }),
    testProvider: async (id, options) => { const models = await listModels(id, options); return { ok: true, modelCount: models.length, models: models.slice(0, 20), testedAt: new Date().toISOString(), inferenceTested: false }; },
    listModels, generate,
  };
}
