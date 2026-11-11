// Web search by the model's own provider. Anthropic and OpenAI run searches on their side when a request carries their
// web search tool; the results come back inside the model's answer with the addresses it used. Still does not fetch
// anything itself here, so no host permission is involved, and the searches are billed to the person's own API key.
//
// Off until the person turns it on (Settings > AI models), and kept on this device like the other switches that widen
// what the assistant may do: a search query is something the model writes, so it is a way for text to leave.
// Pure and dependency-free: lib/ai/connections.js stores the setting, the transports build the tool from it, and the
// assistant decides per turn whether to offer it.

export const WEB_SEARCH_LIMITS = Object.freeze({ minUses: 1, maxUses: 10 });
export const WEB_SEARCH_DEFAULTS = Object.freeze({
  enabled: false,
  // The most searches the provider may run for one answer.
  maxUses: 5,
});

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** Coerces anything into complete, valid settings; unknown or invalid values fall back to the defaults. */
export function normalizeWebSearch(value) {
  const input = isObject(value) ? value : {};
  const uses = typeof input.maxUses === 'string' && input.maxUses.trim() ? Number(input.maxUses) : input.maxUses;
  return {
    enabled: input.enabled === true,
    maxUses: Number.isFinite(uses) ? Math.min(WEB_SEARCH_LIMITS.maxUses, Math.max(WEB_SEARCH_LIMITS.minUses, Math.round(uses))) : WEB_SEARCH_DEFAULTS.maxUses,
  };
}

/** True when `value` is already what normalizeWebSearch would return for it. */
export function isNormalWebSearch(value) {
  if (!isObject(value)) return false;
  const normal = normalizeWebSearch(value);
  const keys = Object.keys(value);
  return keys.length === 2 && keys.every(key => Object.hasOwn(normal, key)) && Object.is(value.enabled, normal.enabled) && Object.is(value.maxUses, normal.maxUses);
}

const hostOf = address => { try { return new URL(address).hostname; } catch { return ''; } };

/**
 * Which provider-side search a connection can use: 'anthropic', 'openai' or ''. Only the providers' own hosts: a
 * compatible server at another address may not know the tool, and would refuse the whole request.
 */
export function webSearchKind({ provider, baseUrl } = {}) {
  const host = hostOf(baseUrl || provider?.baseUrl || '');
  if (provider?.id === 'anthropic' && host === 'api.anthropic.com') return 'anthropic';
  if (provider?.id === 'openai' && host === 'api.openai.com') return 'openai';
  return '';
}

// Claude models that take the newer search tool, which filters results before they reach the model's context.
const ANTHROPIC_DYNAMIC = /^claude-(?:(?:fable|mythos)-|opus-(?:[5-9]|4-[6-9])|sonnet-(?:[5-9]|4-[6-9]))/;

/** The Anthropic server tool for a model: the current version where the model takes it, else the basic one. */
export function anthropicWebSearchTool(model, { maxUses = WEB_SEARCH_DEFAULTS.maxUses } = {}) {
  return { type: ANTHROPIC_DYNAMIC.test(String(model || '')) ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: normalizeWebSearch({ maxUses }).maxUses };
}

/** The OpenAI Responses tool. It has no per-answer cap of its own. */
export const openAiWebSearchTool = () => ({ type: 'web_search' });

/** An address a provider returned, kept only when it is a web address: { url, title }, or null. */
export function webSource(url, title = '') {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // A tracking parameter the provider adds says nothing about the page.
  parsed.searchParams.delete('utm_source');
  const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { url: parsed.href.slice(0, 2048), title: clean || parsed.hostname.replace(/^www\./, '') };
}

/** Sources without repeats, in the order they were first used; at most `max`. */
export function mergeWebSources(...lists) {
  const seen = new Map();
  for (const list of lists) for (const entry of Array.isArray(list) ? list : []) {
    const source = entry && webSource(entry.url, entry.title);
    if (source && !seen.has(source.url)) seen.set(source.url, source);
  }
  return [...seen.values()].slice(0, 40);
}
