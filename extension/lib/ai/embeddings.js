// Embedding calls for semantic search. Direct connections call the provider from the page; bridge connections go
// through the local bridge's /ai/embeddings route. Every vector comes back L2-normalized as a Float32Array, so cosine
// similarity is a dot product.

export const DEFAULT_EMBEDDING_MODELS = Object.freeze({
  openai: 'text-embedding-3-small', voyage: 'voyage-4', gemini: 'gemini-embedding-001', mistral: 'mistral-embed', cohere: 'embed-v5.0-fast', ollama: 'embeddinggemma',
});
// Conservative per-request limits (inputs and characters, about 4 characters per token) from each provider's documentation.
export const EMBEDDING_LIMITS = Object.freeze({
  openai: { maxInputs: 256, maxChars: 600000, inputChars: 24000 },
  voyage: { maxInputs: 128, maxChars: 400000, inputChars: 24000 },
  gemini: { maxInputs: 100, maxChars: 300000, inputChars: 24000 },
  mistral: { maxInputs: 32, maxChars: 48000, inputChars: 24000 },
  cohere: { maxInputs: 96, maxChars: 400000, inputChars: 24000 },
  ollama: { maxInputs: 32, maxChars: 96000, inputChars: 24000 },
  bridge: { maxInputs: 64, maxChars: 400000, inputChars: 24000 },
});
const NO_EMBEDDINGS = new Set(['anthropic', 'custom-anthropic', 'xai', 'groq', 'deepseek', 'perplexity']);

const trimSlash = value => String(value || '').replace(/\/+$/, '');
const sleepFor = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason || new DOMException('Aborted', 'AbortError')); return; }
  const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

export function normalizeVector(values) {
  const vector = values instanceof Float32Array ? new Float32Array(values) : Float32Array.from(values || []);
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}

/** Which wire format a connection uses for embeddings. */
export function embeddingKind({ provider, connection, via } = {}) {
  if ((via || connection?.via) === 'bridge') return 'bridge';
  const id = provider?.id || connection?.providerId || '';
  if (id === 'voyage') return 'voyage';
  if (id === 'google' || id === 'gemini' || provider?.transport === 'gemini') return 'gemini';
  if (id === 'ollama' || provider?.transport === 'ollama') return 'ollama';
  if (id === 'cohere') return 'cohere';
  if (id === 'mistral') return 'mistral';
  return 'openai';
}

/** Splits inputs into request-sized groups of indexes, respecting both the input count and the character budget. */
export function batchInputs(inputs, { maxInputs = 64, maxChars = 200000 } = {}) {
  const batches = [];
  let current = [];
  let chars = 0;
  inputs.forEach((input, index) => {
    const size = String(input).length;
    if (current.length && (current.length >= maxInputs || chars + size > maxChars)) { batches.push(current); current = []; chars = 0; }
    current.push(index);
    chars += size;
  });
  if (current.length) batches.push(current);
  return batches;
}

const geminiModel = model => String(model).replace(/^models\//, '');
const ollamaRoot = baseUrl => trimSlash(baseUrl || 'http://localhost:11434').replace(/\/(?:api|v1)$/, '');

/** Builds the HTTP request for one batch. Pure, so it is unit-tested without a network. */
export function buildEmbeddingRequest(kind, { baseUrl, apiKey, model, inputs, inputType = 'document', dimensions } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey && kind !== 'gemini') headers.Authorization = `Bearer ${apiKey}`;
  const dims = Number.isSafeInteger(dimensions) && dimensions > 0 ? dimensions : null;
  switch (kind) {
    case 'voyage':
      return { url: `${trimSlash(baseUrl || 'https://ai.mongodb.com/v1')}/embeddings`, headers,
        body: { input: inputs, model, input_type: inputType === 'query' ? 'query' : 'document', truncation: true, ...(dims ? { output_dimension: dims } : {}) } };
    case 'gemini': {
      if (apiKey) headers['x-goog-api-key'] = apiKey;
      const name = geminiModel(model);
      // gemini-embedding-2 rejects taskType; its documented alternative is a task prefix inside the text.
      const prefixed = /^gemini-embedding-2/.test(name);
      return { url: `${trimSlash(baseUrl || 'https://generativelanguage.googleapis.com/v1beta')}/models/${encodeURIComponent(name)}:batchEmbedContents`, headers,
        body: { requests: inputs.map(input => ({ model: `models/${name}`,
          content: { parts: [{ text: prefixed ? (inputType === 'query' ? `task: search result | query: ${input}` : `title: none | text: ${input}`) : input }] },
          ...(prefixed ? {} : { taskType: inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT' }),
          ...(dims ? { outputDimensionality: dims } : {}) })) } };
    }
    case 'ollama':
      return { url: `${ollamaRoot(baseUrl)}/api/embed`, headers, body: { model, input: inputs, truncate: true, ...(dims ? { dimensions: dims } : {}) } };
    case 'cohere':
      return { url: `${trimSlash(baseUrl || 'https://api.cohere.com').replace(/\/v\d+$/, '')}/v2/embed`, headers,
        body: { model, texts: inputs, input_type: inputType === 'query' ? 'search_query' : 'search_document', embedding_types: ['float'], truncate: 'END', ...(dims ? { output_dimension: dims } : {}) } };
    case 'mistral':
      return { url: `${trimSlash(baseUrl || 'https://api.mistral.ai/v1')}/embeddings`, headers,
        body: { model, input: inputs, ...(dims && /^codestral-embed/.test(model) ? { output_dimension: dims } : {}) } };
    default:
      // OpenAI and OpenAI-compatible servers (LM Studio, custom). Only text-embedding-3 models accept `dimensions`.
      return { url: `${trimSlash(baseUrl || 'https://api.openai.com/v1')}/embeddings`, headers,
        body: { model, input: inputs, encoding_format: 'float', ...(dims && /^text-embedding-3/.test(model) ? { dimensions: dims } : {}) } };
  }
}

/** Reads vectors (in input order) and token usage out of a provider response. */
export function parseEmbeddingResponse(kind, data, count) {
  let vectors;
  let tokens = 0;
  if (kind === 'gemini') vectors = (data?.embeddings || []).map(entry => entry?.values);
  else if (kind === 'ollama') { vectors = data?.embeddings || []; tokens = data?.prompt_eval_count || 0; }
  else if (kind === 'cohere') { vectors = data?.embeddings?.float || []; tokens = data?.meta?.billed_units?.input_tokens || 0; }
  else if (kind === 'bridge') { vectors = data?.vectors || []; tokens = data?.usage?.tokens || data?.usage?.total_tokens || 0; }
  else {
    vectors = [...(data?.data || [])].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0)).map(entry => entry?.embedding);
    tokens = data?.usage?.total_tokens || data?.usage?.prompt_tokens || 0;
  }
  if (!Array.isArray(vectors) || vectors.length !== count || vectors.some(vector => !Array.isArray(vector) && !(vector instanceof Float32Array) || !vector.length)) {
    throw new Error('The embedding provider returned an unexpected response.');
  }
  return { vectors: vectors.map(normalizeVector), tokens, model: typeof data?.model === 'string' ? data.model : '' };
}

export function isRetryable(error) {
  const status = Number(error?.status);
  if ([408, 425, 429, 500, 502, 503, 504, 529].includes(status)) return true;
  return !status && /rate.?limit|too many requests|overloaded|temporarily unavailable/i.test(error?.message || '');
}
export function retryDelay(error, attempt, baseMs = 1000) {
  const retryAfter = Number(error?.retryAfter ?? error?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(60000, retryAfter * 1000);
  return Math.min(30000, baseMs * 2 ** attempt + Math.floor(Math.random() * baseMs * 0.25));
}

async function defaultPostJson(url, { headers, body, signal }) {
  const response = await fetch(url, { method: 'POST', headers, body, signal, cache: 'no-store' });
  if (!response.ok) {
    let detail = '';
    try { const data = await response.json(); detail = data?.error?.message || data?.error || data?.message || ''; } catch {}
    const error = new Error(response.status === 429 ? 'Rate limited by the embedding provider.' : `Embedding request failed (HTTP ${response.status})${detail ? `: ${String(detail).slice(0, 200)}` : '.'}`);
    error.status = response.status;
    error.retryAfter = Number(response.headers.get('retry-after')) || undefined;
    throw error;
  }
  return response.json();
}

/**
 * createEmbedder({ resolveConnection, providerFetch, requestBridge }) -> { embed, describe }
 * embed({ connectionId, model, inputs, inputType: 'document'|'query', dimensions, signal }) -> { vectors: Float32Array[], model, dims, usage: { tokens } }
 */
export function createEmbedder({ resolveConnection, providerFetch, requestBridge, sleep = sleepFor, retries = 4, baseDelayMs = 1000 } = {}) {
  const postJson = async (url, { headers, body, signal }) => {
    if (!providerFetch) return defaultPostJson(url, { headers, body: JSON.stringify(body), signal });
    const response = await providerFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal, timeoutMs: 90000 });
    if (response && response.ok === false) {
      const error = new Error(response.status === 429 ? 'Rate limited by the embedding provider.' : `Embedding request failed (HTTP ${response.status}).`);
      error.status = response.status;
      error.retryAfter = Number(response.headers?.get?.('retry-after')) || undefined;
      throw error;
    }
    return response.json();
  };
  async function withRetry(task, signal) {
    for (let attempt = 0; ; attempt++) {
      try { return await task(); }
      catch (error) {
        if (signal?.aborted || error?.name === 'AbortError' || attempt >= retries || !isRetryable(error)) throw error;
        await sleep(retryDelay(error, attempt, baseDelayMs), signal);
      }
    }
  }
  async function resolve(connectionId) {
    if (!resolveConnection) throw new Error('Connect an AI provider in Settings');
    const resolved = await resolveConnection(connectionId);
    const { provider, connection } = resolved;
    const via = resolved.via || connection?.via || 'direct';
    if (via === 'agent') throw new Error(`${connection?.label || 'This agent'} cannot create embeddings. Choose Voyage, OpenAI, Gemini, Mistral or Ollama for semantic search.`);
    const providerId = provider?.id || connection?.providerId || '';
    if (via !== 'bridge' && (NO_EMBEDDINGS.has(providerId) || provider?.supports?.embeddings === false)) {
      throw new Error(`${provider?.name || 'This provider'} has no embeddings API. Choose Voyage, OpenAI, Gemini, Mistral or Ollama for semantic search.`);
    }
    return { ...resolved, via, providerId, kind: embeddingKind({ provider, connection, via }) };
  }
  const defaultModel = target => target.connection?.embeddingModel || target.provider?.embeddings?.default
    || DEFAULT_EMBEDDING_MODELS[target.kind === 'bridge' ? embeddingKind({ provider: target.provider, connection: target.connection, via: 'direct' }) : target.kind] || '';

  async function describe(connectionId) {
    const target = await resolve(connectionId);
    return { providerId: target.providerId, provider: target.provider?.name || target.connection?.label || target.providerId, via: target.via, defaultModel: defaultModel(target) };
  }

  async function embed({ connectionId, model, inputs, inputType = 'document', dimensions, signal } = {}) {
    if (!Array.isArray(inputs) || !inputs.length) return { vectors: [], model: model || '', dims: 0, usage: { tokens: 0 } };
    const target = await resolve(connectionId);
    const useModel = model || defaultModel(target);
    if (!useModel) throw new Error('Choose an embedding model in Settings.');
    const limits = EMBEDDING_LIMITS[target.kind] || EMBEDDING_LIMITS.openai;
    const inputCap = target.kind === 'gemini' && /embedding-001/.test(useModel) ? 7000 : limits.inputChars;
    const texts = inputs.map(input => String(input ?? '').slice(0, inputCap) || ' ');
    const vectors = new Array(texts.length);
    let tokens = 0;
    let reportedModel = '';
    for (const indexes of batchInputs(texts, limits)) {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      const batch = indexes.map(index => texts[index]);
      let parsed;
      if (target.kind === 'bridge') {
        if (!requestBridge) throw new Error('Pair the local bridge first to use bridge embeddings.');
        const providerId = target.connection?.bridgeProviderId || String(target.connection?.id || connectionId).replace(/^bridge:/, '');
        const data = await withRetry(() => requestBridge('/ai/embeddings', { method: 'POST', signal,
          body: { providerId, inputs: batch, model: useModel, dimensions: dimensions || undefined, inputType } }), signal);
        parsed = parseEmbeddingResponse('bridge', data, batch.length);
      } else {
        const request = buildEmbeddingRequest(target.kind, { baseUrl: target.baseUrl || target.provider?.baseUrl, apiKey: target.apiKey, model: useModel, inputs: batch, inputType, dimensions });
        const data = await withRetry(() => postJson(request.url, { headers: request.headers, body: request.body, signal }), signal);
        parsed = parseEmbeddingResponse(target.kind, data, batch.length);
      }
      parsed.vectors.forEach((vector, offset) => { vectors[indexes[offset]] = vector; });
      tokens += parsed.tokens || Math.ceil(batch.reduce((sum, text) => sum + text.length, 0) / 4);
      reportedModel ||= parsed.model;
    }
    const dims = vectors[0].length;
    if (vectors.some(vector => vector.length !== dims)) throw new Error('The embedding provider returned vectors of different sizes.');
    return { vectors, model: useModel, dims, usage: { tokens }, ...(reportedModel && reportedModel !== useModel ? { providerModel: reportedModel } : {}) };
  }
  return { embed, describe };
}
