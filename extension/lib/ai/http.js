// HTTP plumbing for provider calls: one fetch wrapper that turns transport and HTTP failures into plain messages.

import { hostOf, isLoopbackHost, originPattern } from './catalog.js';
import { redactSecrets } from './secrets.js';
import { abortError, readChunks } from './stream.js';

export function aiError(message, props = {}) {
  const error = new Error(message);
  for (const [key, value] of Object.entries(props)) if (value !== undefined) error[key] = value;
  return error;
}

// Auth headers per provider family. Anthropic uses x-api-key, Gemini x-goog-api-key, everything else a bearer token.
export function authHeaders({ provider, apiKey }) {
  if (!apiKey) return {};
  if (provider?.transport === 'anthropic') return { 'x-api-key': apiKey };
  if (provider?.id === 'google') return { 'x-goog-api-key': apiKey };
  return { Authorization: `Bearer ${apiKey}` };
}

export async function readBodyText(response, { signal, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!response.body) return '';
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of readChunks(response, { signal, maxBytes })) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

export async function readJsonBody(response, options = {}) {
  const text = await readBodyText(response, options);
  try { return JSON.parse(text); } catch { throw aiError('The provider returned an unreadable response.', { code: 'bad_response' }); }
}

function providerName(provider, url) { return provider?.name || hostOf(url); }

function detailFrom(text) {
  if (!text) return '';
  try {
    const data = JSON.parse(text);
    const value = data?.error?.message || data?.message || data?.detail?.message || (typeof data?.detail === 'string' ? data.detail : '')
      || (typeof data?.error === 'string' ? data.error : '') || data?.[0]?.error?.message || '';
    return String(value);
  } catch { return text.trim().startsWith('<') ? '' : text.trim(); }
}

const sentence = text => { const value = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 300); return value && !/[.!?]$/.test(value) ? `${value}.` : value; };

// Maps an HTTP failure to a message a person can act on. Exported for tests and for providers that report errors
// inside a stream rather than as an HTTP status.
export function friendlyHttpError({ status, detail = '', provider = null, url = '', model = '', retryAfter = null }) {
  const name = providerName(provider, url);
  const host = hostOf(url);
  const extra = detail ? ` ${sentence(detail)}` : '';
  const props = { status, provider: provider?.id, host, detail: detail || undefined, retryAfter: retryAfter ?? undefined };
  if (provider?.id === 'ollama' && status === 403) {
    return aiError('Ollama blocked the request. Start Ollama with OLLAMA_ORIGINS=chrome-extension://* and try again.', { ...props, code: 'origin_blocked' });
  }
  if (status === 400 && /not scoped to a workspace|anthropic-workspace-id/i.test(detail)) {
    return aiError('This Anthropic key is not tied to a workspace. Add a workspace ID to the connection or create a workspace key.', { ...props, code: 'workspace_required' });
  }
  if (status === 401) {
    const voyage = provider?.id === 'voyage' ? ' Keys made in MongoDB Atlas use the https://ai.mongodb.com/v1 base URL.' : '';
    return aiError(`Check the API key. ${name} did not accept it.${voyage}`, { ...props, code: 'auth' });
  }
  if (status === 403) return aiError(`Check the API key. ${name} refused access with it.${extra}`, { ...props, code: 'auth' });
  if (status === 404) {
    return aiError(model ? `${name} could not find the model ${model}. Pick another model in AI settings.` : `${name} could not find that address. Check the base URL.`, { ...props, code: 'not_found' });
  }
  if (status === 408) return aiError(`${name} took too long to answer. Try again.`, { ...props, code: 'timeout' });
  if (status === 413) return aiError(`The request is too large for ${name}. Use less context and try again.`, { ...props, code: 'too_large' });
  if (status === 429) {
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? ` Try again in ${Math.ceil(retryAfter)} s.` : ' Wait a moment and try again.';
    const quota = /quota|billing|credit|insufficient/i.test(detail) ? ` ${sentence(detail)}` : '';
    return aiError(`Rate limited by ${name}.${wait}${quota}`, { ...props, code: 'rate_limit' });
  }
  if (status === 529 || status >= 500) return aiError(`${name} is having trouble right now (HTTP ${status}). Try again in a moment.`, { ...props, code: 'provider_down' });
  if (status >= 400) return aiError(detail ? `${name}: ${sentence(detail)}` : `${name} rejected the request (HTTP ${status}).`, { ...props, code: 'bad_request' });
  return aiError(`${name} returned HTTP ${status}.`, { ...props, code: 'http' });
}

export async function hasHostPermission(url) {
  const api = globalThis.chrome?.permissions;
  if (typeof api?.contains !== 'function') return null;
  try { return !!(await api.contains({ origins: [originPattern(url)] })); } catch { return null; }
}

async function networkError(error, { provider, url }) {
  const host = hostOf(url);
  let hostname = '';
  try { hostname = new URL(url).hostname; } catch {}
  const name = providerName(provider, url);
  if (isLoopbackHost(hostname) || provider?.local) {
    return aiError(`Could not reach ${name} at ${host}. Make sure it is running.`, { code: 'network', host, provider: provider?.id, cause: error });
  }
  if ((await hasHostPermission(url)) === false) return aiError(`Allow Still to reach ${host}.`, { code: 'permission', host, provider: provider?.id, cause: error });
  return aiError(`Could not reach ${host}. Check your connection and try again.`, { code: 'network', host, provider: provider?.id, cause: error });
}

// fetch() for provider APIs. Rejects with a friendly, redacted error for HTTP failures; timeoutMs bounds the wait
// for response headers only, so long streams are not cut off. The caller's signal stays linked to the body.
export async function providerFetch(url, { method = 'GET', headers = {}, body, signal, timeoutMs = 60000, provider = null, secrets = [], model = '', fetch: fetcher } = {}) {
  if (signal?.aborted) throw abortError(signal);
  const run = fetcher || globalThis.fetch;
  if (typeof run !== 'function') throw aiError('This browser cannot make network requests here.', { code: 'network' });
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', forward, { once: true });
  let timedOut = false;
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort(new DOMException('The request timed out.', 'TimeoutError')); }, timeoutMs) : null;
  const finalHeaders = { ...headers };
  let payload = body;
  if (payload !== undefined && payload !== null && typeof payload !== 'string' && !(payload instanceof ArrayBuffer) && !ArrayBuffer.isView(payload) && !(globalThis.Blob && payload instanceof Blob) && !(globalThis.FormData && payload instanceof FormData)) {
    payload = JSON.stringify(payload);
    if (!Object.keys(finalHeaders).some(key => key.toLowerCase() === 'content-type')) finalHeaders['content-type'] = 'application/json';
  }
  let response;
  try {
    response = await run(url, { method, headers: finalHeaders, body: payload ?? undefined, signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    if (timedOut) throw aiError(`${providerName(provider, url)} did not respond in time. Try again.`, { code: 'timeout', host: hostOf(url), provider: provider?.id });
    throw redactAll(await networkError(error, { provider, url }), secrets);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (response.ok) return response;
  let text = '';
  try { text = await readBodyText(response, { signal, maxBytes: 65536 }); } catch (error) { if (signal?.aborted) throw abortError(signal); }
  const retry = Number(response.headers?.get?.('retry-after'));
  const error = friendlyHttpError({ status: response.status, detail: redactSecrets(detailFrom(text), secrets), provider, url, model, retryAfter: Number.isFinite(retry) ? retry : null });
  error.requestId = response.headers?.get?.('request-id') || response.headers?.get?.('x-request-id') || undefined;
  throw redactAll(error, secrets);
}

function redactAll(error, secrets) {
  error.message = redactSecrets(error.message, secrets);
  if (typeof error.detail === 'string') error.detail = redactSecrets(error.detail, secrets);
  return error;
}

// Errors reported inside a stream (Anthropic "error" events, OpenAI "error"/"response.failed", chunk-level errors).
export function streamError({ type = '', message = '', provider = null, model = '', secrets = [] }) {
  const detail = redactSecrets(message, secrets);
  const status = /overloaded/i.test(type) ? 529 : /rate_limit/i.test(type) ? 429 : /authentication|permission/i.test(type) ? 401
    : /not_found/i.test(type) ? 404 : /api_error|server_error|internal/i.test(type) ? 500 : 0;
  if (status) return friendlyHttpError({ status, detail, provider, model });
  return aiError(detail ? `${provider?.name || 'The provider'}: ${sentence(detail)}` : `${provider?.name || 'The provider'} stopped with an error.`, { code: 'provider_error', provider: provider?.id, detail: detail || undefined });
}
