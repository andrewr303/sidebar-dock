// The context window a local model server is running a model with. Cloud providers list a model's window; a local server
// decides it when it loads the model, and it is often far smaller than the model's own maximum (Ollama loads a few
// thousand tokens unless told otherwise). A request sized for the wrong window is cut by the server without a word, so
// the assistant asks the server before it sizes one (lib/ai/assistant.js).
//
// Only what the server has loaded, or is set to load, counts as known:
//   Ollama      GET /api/ps (the running model's context_length), else POST /api/show and a num_ctx in its parameters
//   LM Studio   GET /api/v0/models (the model's loaded_context_length)
// The model's own maximum is not used: it says what could be loaded, not what is.
import { authHeaders, providerFetch, readJsonBody } from './http.js';

/** An answer is kept this long: a person can reload the model with another window at any time. */
const TTL_MS = 30_000;
const TIMEOUT_MS = 2500;
const cache = new Map();

const positive = value => (Number.isInteger(value) && value > 0 ? value : 0);
const rootOf = baseUrl => String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
// "llama3.2" and "llama3.2:latest" name the same Ollama model.
const sameModel = (a, b) => typeof a === 'string' && typeof b === 'string' && (a === b || a.replace(/:latest$/, '') === b.replace(/:latest$/, ''));

async function getJson(url, { provider, apiKey, signal, method = 'GET', body }) {
  try {
    const response = await providerFetch(url, { method, headers: authHeaders({ provider, apiKey }), ...(body ? { body } : {}), signal, provider, secrets: apiKey ? [apiKey] : [], timeoutMs: TIMEOUT_MS });
    return await readJsonBody(response, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

async function ollamaWindow(root, model, request) {
  const running = await request(`${root}/api/ps`);
  const loaded = (Array.isArray(running?.models) ? running.models : []).find(entry => sameModel(entry?.name, model) || sameModel(entry?.model, model));
  if (positive(loaded?.context_length)) return loaded.context_length;
  const shown = await request(`${root}/api/show`, { method: 'POST', body: { model } });
  // A num_ctx in the model's parameters is what the server will load it with.
  const configured = Number(/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(String(shown?.parameters ?? ''))?.[1]);
  return positive(configured);
}

async function lmStudioWindow(root, model, request) {
  const listed = await request(`${root}/api/v0/models`);
  const entry = (Array.isArray(listed?.data) ? listed.data : []).find(item => item?.id === model);
  return positive(entry?.loaded_context_length);
}

/**
 * detectLocalWindow({ provider, baseUrl, apiKey, model, signal, fresh }) -> tokens, or 0 when the server does not say
 * (not a local server Still knows, the model is not loaded yet, the server is not reachable). Never throws, except
 * when the person stops the run. fresh: ask again even when a recent answer is kept.
 */
export async function detectLocalWindow({ provider, baseUrl, apiKey = '', model, signal, fresh = false, request = null, now = Date.now } = {}) {
  const kind = provider?.id === 'ollama' ? 'ollama' : provider?.id === 'lmstudio' ? 'lmstudio' : '';
  const root = rootOf(baseUrl || provider?.baseUrl);
  if (!kind || !root || typeof model !== 'string' || !model) return 0;
  const key = `${kind}|${root}|${model}`;
  const kept = cache.get(key);
  if (!fresh && kept && now() - kept.at < TTL_MS) return kept.window;
  const ask = request || ((url, options = {}) => getJson(url, { provider, apiKey, signal, ...options }));
  const window = kind === 'ollama' ? await ollamaWindow(root, model, ask) : await lmStudioWindow(root, model, ask);
  // "Not loaded yet" is not kept: the next request loads the model, and the answer changes.
  if (window) cache.set(key, { window, at: now() });
  else cache.delete(key);
  return window;
}

/** Forgets what was detected (tests, and a connection that changed). */
export const resetLocalWindows = () => cache.clear();
