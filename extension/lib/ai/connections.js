// AI connections and settings. Direct connections (keys on this device) live in chrome.storage.local['still.ai.v2'];
// bridge providers and CLI agents are discovered from the local bridge and listed alongside them.

import { EFFORT_LEVELS, getProvider, hostOf, modelFromCatalog, normalizeBaseUrl, originPattern, requireProvider } from './catalog.js';
import { SECRETS_KEY, connectionIdsWithKeys, deleteApiKey, getApiKey, keyHint, keyHints, setApiKey, validateApiKey } from './secrets.js';
import { aiError, authHeaders, providerFetch, readJsonBody } from './http.js';
import * as integrationsModule from '../integrations.js';
import * as anthropicTransport from './transports/anthropic.js';
import * as responsesTransport from './transports/openai-responses.js';
import * as chatTransport from './transports/openai-chat.js';
import * as geminiTransport from './transports/gemini.js';
import * as ollamaTransport from './transports/ollama.js';

export const AI_STORE_KEY = 'still.ai.v2';
export const LEGACY_PREFS_KEY = 'still.ai.preferences.v1';
export const MODEL_CACHE_MS = 24 * 60 * 60 * 1000;
const BRIDGE_CACHE_MS = 30000;
const BRIDGE_TIMEOUT_MS = 4000;

export const TRANSPORTS = Object.freeze({ anthropic: anthropicTransport, 'openai-responses': responsesTransport, 'openai-chat': chatTransport, gemini: geminiTransport, ollama: ollamaTransport });

export const DEFAULT_AI_SETTINGS = Object.freeze({
  chat: Object.freeze({ connectionId: '', model: '', effort: 'medium' }),
  quick: Object.freeze({ connectionId: '', model: '', effort: 'low' }),
  embeddings: Object.freeze({ enabled: false, connectionId: '', model: '', dims: null }),
  autoSuggestOnSave: true,
  includePageText: true,
  handoffTarget: 'claude',
});

const AGENT_IDS = { claude: 'agent:claude-code', codex: 'agent:codex' };
const LEGACY_IDS = { 'cli:codex': 'agent:codex', 'cli:claude': 'agent:claude-code' };
const BRIDGED_PROVIDERS = new Set(['bridge', 'agent:claude-code', 'agent:codex', 'chatgpt-oauth']);
export const isBridgedId = id => typeof id === 'string' && (id.startsWith('bridge:') || id.startsWith('agent:') || id === 'chatgpt-oauth' || id in LEGACY_IDS);

let integrations = integrationsModule;
let bridgeMemory = null;
let queue = Promise.resolve();
const listeners = new Set();
let detachStorage = null;
let notifyTimer = null;

// Lets the facade (and tests) supply the integrations client; also clears in-memory bridge state.
export function configureConnections({ integrations: client } = {}) {
  if (client) integrations = client;
  bridgeMemory = null;
}

const nowIso = () => new Date().toISOString();
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const randomId = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 10);

// ---------- storage ----------

function area() { return globalThis.chrome?.storage?.local || null; }

async function readKey(key) {
  const local = area();
  if (local) return (await local.get(key))?.[key];
  const raw = globalThis.localStorage?.getItem(key);
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

async function writeKey(key, value) {
  const local = area();
  if (local) await local.set({ [key]: value });
  else if (globalThis.localStorage) globalThis.localStorage.setItem(key, JSON.stringify(value));
  else throw new Error('Local storage is unavailable, so AI settings could not be saved.');
}

function blankState() {
  return { version: 2, connections: [], overlays: {}, settings: {}, modelCache: {}, bridge: null, migratedFrom: null, migratedAt: null };
}

function normalizeState(value) {
  const state = { ...blankState(), ...(isObject(value) ? value : {}) };
  state.connections = Array.isArray(state.connections) ? state.connections.filter(entry => isObject(entry) && typeof entry.id === 'string' && getProvider(entry.providerId)) : [];
  for (const key of ['overlays', 'settings', 'modelCache']) if (!isObject(state[key])) state[key] = {};
  return state;
}

const legacyEffort = value => EFFORT_LEVELS.includes(value) ? value : '';

// Maps still.ai.preferences.v1 (bridge-only AI) onto the v2 settings. Bridge and CLI selections keep working because
// their ids resolve through the bridge.
export function migrateLegacyPreferences(prefs, now = nowIso()) {
  const state = blankState();
  if (!isObject(prefs)) return state;
  const raw = typeof prefs.providerId === 'string' ? prefs.providerId.trim() : '';
  const connectionId = !raw ? '' : LEGACY_IDS[raw] || (/^[\w-]{1,100}$/.test(raw) ? `bridge:${raw}` : '');
  const effort = legacyEffort(prefs.reasoningEffort);
  state.settings.chat = { connectionId, model: typeof prefs.model === 'string' ? prefs.model.trim().slice(0, 300) : '', ...(effort ? { effort } : {}) };
  const writing = {};
  for (const key of ['tone', 'depth', 'scope']) if (typeof prefs[key] === 'string' && prefs[key]) writing[key] = prefs[key];
  if (Object.keys(writing).length) state.settings.writing = writing;
  state.migratedFrom = LEGACY_PREFS_KEY;
  state.migratedAt = now;
  return state;
}

async function loadState() {
  const stored = await readKey(AI_STORE_KEY);
  if (isObject(stored) && stored.version === 2) return normalizeState(stored);
  const legacy = await readKey(LEGACY_PREFS_KEY);
  const state = legacy ? migrateLegacyPreferences(legacy) : blankState();
  await writeKey(AI_STORE_KEY, state);
  return state;
}

function update(mutator, { notify: shouldNotify = true } = {}) {
  const run = queue.then(async () => {
    const state = await loadState();
    const result = await mutator(state);
    await writeKey(AI_STORE_KEY, state);
    return result;
  });
  queue = run.catch(() => {});
  return run.then(result => { if (shouldNotify) scheduleNotify(); return result; });
}

// ---------- change notifications ----------

function scheduleNotify() {
  if (!listeners.size) return;
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    for (const listener of [...listeners]) { try { listener(); } catch (error) { console.error(error); } }
  }, 25);
}

function attachStorageListener() {
  const onChanged = globalThis.chrome?.storage?.onChanged;
  if (typeof onChanged?.addListener === 'function') {
    const handler = (changes, areaName) => { if (areaName === 'local' && (changes[AI_STORE_KEY] || changes[SECRETS_KEY])) { bridgeMemory = null; scheduleNotify(); } };
    onChanged.addListener(handler);
    return () => onChanged.removeListener(handler);
  }
  if (typeof globalThis.addEventListener === 'function') {
    const handler = event => { if (event.key === AI_STORE_KEY || event.key === SECRETS_KEY) scheduleNotify(); };
    globalThis.addEventListener('storage', handler);
    return () => globalThis.removeEventListener('storage', handler);
  }
  return () => {};
}

export function onConnectionsChanged(listener) {
  if (typeof listener !== 'function') throw new TypeError('onConnectionsChanged needs a function.');
  listeners.add(listener);
  if (!detachStorage) detachStorage = attachStorageListener();
  return () => {
    listeners.delete(listener);
    if (!listeners.size && detachStorage) { detachStorage(); detachStorage = null; }
  };
}

// ---------- host permissions ----------

export function hostPermissionOrigins(target) {
  if (!target) return [];
  if (typeof target === 'string') {
    const provider = getProvider(target);
    if (provider) return provider.baseUrl ? [originPattern(provider.baseUrl)] : [];
    return [originPattern(normalizeBaseUrl(target, { local: true }))];
  }
  if (isObject(target)) {
    if (target.baseUrl) return [originPattern(normalizeBaseUrl(target.baseUrl, getProvider(target.providerId || target.id) || target))];
    const provider = getProvider(target.providerId || target.id);
    return provider?.baseUrl ? [originPattern(provider.baseUrl)] : [];
  }
  return [];
}

function permissionError(origins, cause) {
  const host = origins.map(origin => origin.replace(/^\w+:\/\//, '').replace(/\/\*$/, '')).join(', ');
  return aiError(`Allow Still to reach ${host} to use this connection.`, { code: 'permission', host, cause });
}

// Requests optional host access for a provider, base URL or { providerId, baseUrl }. Chrome only shows the prompt
// during a user gesture, so call this directly from the click handler before awaiting anything else.
export function ensureHostPermission(target) {
  let origins;
  try { origins = hostPermissionOrigins(target); } catch (error) { return Promise.reject(error); }
  const api = globalThis.chrome?.permissions;
  if (!origins.length || typeof api?.request !== 'function') return Promise.resolve(true);
  // Outside a gesture Chrome refuses to ask at all; access granted earlier still counts.
  const alreadyGranted = async error => {
    if (typeof api.contains === 'function' && await Promise.resolve(api.contains({ origins })).catch(() => false)) return true;
    throw permissionError(origins, error);
  };
  let pending;
  try { pending = api.request({ origins }); } catch (error) { return alreadyGranted(error); }
  return Promise.resolve(pending).then(granted => {
    if (!granted) throw permissionError(origins);
    return true;
  }, alreadyGranted);
}

async function ensureHostPermissionLate(baseUrl) {
  const api = globalThis.chrome?.permissions;
  if (typeof api?.contains !== 'function') return true;
  const origins = [originPattern(baseUrl)];
  if (await api.contains({ origins })) return true;
  return ensureHostPermission(baseUrl);
}

// ---------- settings ----------

function mergeSettings(stored = {}) {
  const result = structuredClone({ ...DEFAULT_AI_SETTINGS, chat: { ...DEFAULT_AI_SETTINGS.chat }, quick: { ...DEFAULT_AI_SETTINGS.quick }, embeddings: { ...DEFAULT_AI_SETTINGS.embeddings } });
  for (const [key, value] of Object.entries(isObject(stored) ? stored : {})) {
    if (isObject(value) && isObject(result[key])) result[key] = { ...result[key], ...value };
    else if (value !== undefined) result[key] = value;
  }
  return result;
}

const SECRET_NAME = /^(?:api_?key|apikey|secret|secret_?key|password|token|access_?token|bearer|authorization|credentials?)$/i;
function checkSettingsValue(key, value, depth = 0) {
  if (SECRET_NAME.test(key)) throw aiError('API keys belong in a connection, not in AI settings.', { code: 'bad_request' });
  if (depth > 4) throw aiError('AI settings are nested too deeply.', { code: 'bad_request' });
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (Array.isArray(value)) { value.forEach(entry => checkSettingsValue('', entry, depth + 1)); return; }
  if (isObject(value)) { for (const [name, entry] of Object.entries(value)) checkSettingsValue(name, entry, depth + 1); return; }
  throw aiError(`AI setting ${key || 'value'} has an unsupported value.`, { code: 'bad_request' });
}

function validateSettings(settings) {
  for (const section of ['chat', 'quick', 'embeddings']) {
    const value = settings[section];
    if (!isObject(value)) throw aiError(`AI setting ${section} must be an object.`, { code: 'bad_request' });
    if (typeof value.connectionId !== 'string' || value.connectionId.length > 200) throw aiError('Choose a valid AI connection.', { code: 'bad_request' });
    if (typeof value.model !== 'string' || value.model.length > 300 || /[\s\x00-\x1f]/.test(value.model)) throw aiError('Choose a valid model.', { code: 'bad_request' });
    if (value.effort !== undefined && !EFFORT_LEVELS.includes(value.effort)) throw aiError('Choose a supported reasoning effort.', { code: 'bad_request' });
  }
  const dims = settings.embeddings.dims;
  if (dims !== null && !(Number.isInteger(dims) && dims > 0 && dims <= 8192)) throw aiError('Embedding dimensions must be a whole number.', { code: 'bad_request' });
  for (const key of ['autoSuggestOnSave', 'includePageText']) if (typeof settings[key] !== 'boolean') throw aiError(`AI setting ${key} must be on or off.`, { code: 'bad_request' });
  if (typeof settings.embeddings.enabled !== 'boolean') throw aiError('Semantic search must be on or off.', { code: 'bad_request' });
  if (typeof settings.handoffTarget !== 'string' || !/^[\w-]{1,40}$/.test(settings.handoffTarget)) throw aiError('Choose a supported app to open answers in.', { code: 'bad_request' });
}

export async function getAiSettings() {
  return mergeSettings((await loadState()).settings);
}

export async function setAiSettings(patch = {}) {
  if (!isObject(patch)) throw aiError('AI settings must be an object.', { code: 'bad_request' });
  for (const [key, value] of Object.entries(patch)) checkSettingsValue(key, value);
  return update(state => {
    const next = mergeSettings(state.settings);
    for (const [key, value] of Object.entries(patch)) {
      if (isObject(value) && isObject(next[key])) next[key] = { ...next[key], ...value };
      else next[key] = value;
    }
    validateSettings(next);
    state.settings = next;
    return structuredClone(next);
  });
}

// ---------- bridge discovery ----------

async function bridgeRequest(path, options = {}) {
  if (typeof integrations?.requestBridge !== 'function') throw aiError('The local bridge is not available here.', { code: 'bridge_unavailable' });
  return integrations.requestBridge(path, options);
}

const compactProvider = entry => ({ id: String(entry.id), type: entry.type || '', name: entry.name || 'Bridge provider', model: entry.model || '', baseUrl: entry.baseUrl || '',
  hasCredentials: !!entry.hasCredentials, capabilities: { images: entry.capabilities?.images === true, reasoningEfforts: Array.isArray(entry.capabilities?.reasoningEfforts) ? entry.capabilities.reasoningEfforts : [] } });
const compactAgent = entry => ({ id: entry.id, name: entry.name || entry.id, available: entry.available === true, status: entry.status || 'unavailable', reason: entry.reason || '',
  capabilities: { generate: entry.capabilities?.generate === true, oauthLogin: entry.capabilities?.oauthLogin === true } });

async function bridgeSnapshot({ refresh = false } = {}) {
  if (!refresh && bridgeMemory && Date.now() - bridgeMemory.checkedAt < BRIDGE_CACHE_MS) return bridgeMemory;
  let paired = false;
  try { paired = !!(await integrations?.getIntegrationSettings?.())?.bridgeConfigured; } catch {}
  const state = await loadState();
  const stored = state.bridge || {};
  if (!paired) {
    bridgeMemory = { checkedAt: Date.now(), paired: false, reachable: false, error: null, providers: [], agents: [], auth: stored.auth || {}, runtime: null };
    return bridgeMemory;
  }
  try {
    const data = await bridgeRequest('/ai/providers', { signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS) });
    const providers = (Array.isArray(data?.providers) ? data.providers : []).filter(entry => entry?.id).map(compactProvider);
    const agents = (Array.isArray(data?.agents) ? data.agents : []).filter(entry => entry?.id in AGENT_IDS).map(compactAgent);
    bridgeMemory = { checkedAt: Date.now(), paired: true, reachable: true, error: null, providers, agents, auth: stored.auth || {}, runtime: data?.runtime || null };
    if (JSON.stringify({ providers, agents }) !== JSON.stringify({ providers: stored.providers || [], agents: stored.agents || [] })) {
      await update(next => { next.bridge = { ...(next.bridge || {}), providers, agents, seenAt: nowIso() }; }, { notify: false });
    }
  } catch (error) {
    bridgeMemory = { checkedAt: Date.now(), paired: true, reachable: false, error: error.message || 'The local bridge is not running.', providers: stored.providers || [], agents: stored.agents || [], auth: stored.auth || {}, runtime: null };
  }
  return bridgeMemory;
}

export async function getBridgeStatus({ refresh = false } = {}) {
  const snapshot = await bridgeSnapshot({ refresh });
  return structuredClone({ paired: snapshot.paired, reachable: snapshot.reachable, error: snapshot.error, providers: snapshot.providers, agents: snapshot.agents, auth: snapshot.auth, runtime: snapshot.runtime });
}

// Pairs the bridge through the integrations client. Requests loopback access first, so call it from a click handler.
export async function pairBridge({ url, token }) {
  const permission = ensureHostPermission(url || 'http://127.0.0.1:43123');
  await permission;
  if (typeof integrations?.configureBridge !== 'function') throw aiError('The local bridge is not available here.', { code: 'bridge_unavailable' });
  await integrations.configureBridge({ url, token, enabled: true });
  bridgeMemory = null;
  scheduleNotify();
  return getBridgeStatus({ refresh: true });
}

async function recordAuth(agents) {
  await update(state => {
    const auth = { ...(state.bridge?.auth || {}) };
    for (const [id, value] of Object.entries(agents || {})) if (id in AGENT_IDS && isObject(value)) auth[id] = { status: value.status || 'unknown', method: value.method || null, checkedAt: nowIso() };
    state.bridge = { ...(state.bridge || {}), auth };
  });
  if (bridgeMemory) bridgeMemory.auth = { ...bridgeMemory.auth, ...Object.fromEntries(Object.entries(agents || {}).filter(([id]) => id in AGENT_IDS)) };
}

export async function cliSignInStatus() {
  const data = await bridgeRequest('/ai/cli/auth');
  await recordAuth(data?.agents);
  return structuredClone(data?.agents || {});
}

export async function startChatGptSignIn() {
  return (await bridgeRequest('/ai/cli/login', { method: 'POST', body: {} }))?.login || null;
}

export async function chatGptSignInStatus(loginId) {
  const login = (await bridgeRequest(`/ai/cli/login/${encodeURIComponent(loginId)}`))?.login || null;
  if (login?.status === 'authenticated') await recordAuth({ codex: { status: 'authenticated', method: 'chatgpt' } });
  return login;
}

export async function cancelChatGptSignIn(loginId) {
  return (await bridgeRequest(`/ai/cli/login/${encodeURIComponent(loginId)}/cancel`, { method: 'POST', body: {} }))?.login || null;
}

// ---------- public shapes ----------

const effectiveBaseUrl = (record, provider) => record.baseUrl || provider.baseUrl || '';

function cachedModels(state, id) {
  const entry = state.modelCache[id];
  return entry && Array.isArray(entry.models) ? entry.models : null;
}

function catalogModels(provider, kind = 'chat') {
  if (kind === 'embeddings') return (provider.embeddings?.models || []).map(entry => modelFromCatalog(entry, { embeddings: true }));
  const chat = (provider.chat?.defaults || []).map(entry => ({ ...modelFromCatalog(entry), recommended: entry.id === provider.chat.recommended || undefined }));
  return kind === 'all' ? [...chat, ...catalogModels(provider, 'embeddings')] : chat;
}

const publicModel = ({ chat, created, ...model }) => model;
function filterKind(models, kind) {
  if (kind === 'all') return models.map(publicModel);
  if (kind === 'embeddings') return models.filter(model => model.capabilities?.embeddings).map(publicModel);
  return models.filter(model => !model.capabilities?.embeddings && model.chat !== false).map(publicModel);
}

function publicDirect(record, state, keyIds, hints = new Map()) {
  const provider = getProvider(record.providerId);
  const cache = cachedModels(state, record.id);
  return {
    id: record.id, providerId: provider.id, providerName: provider.name, label: record.label || provider.name, via: 'direct', kind: provider.kind,
    transport: provider.transport, baseUrl: effectiveBaseUrl(record, provider), hasKey: keyIds.has(record.id), needsKey: provider.needsKey, local: provider.local,
    ...(keyIds.has(record.id) && hints.get(record.id) ? { keyHint: hints.get(record.id) } : {}),
    enabled: record.enabled !== false, defaultModel: record.defaultModel || provider.chat?.recommended || '',
    models: provider.chat ? (cache ? filterKind(cache, 'chat') : catalogModels(provider)) : [],
    embeddingModels: provider.embeddings ? (cache ? mergeEmbeddingSuggestions(provider, filterKind(cache, 'embeddings')) : catalogModels(provider, 'embeddings')) : [],
    modelsUpdatedAt: state.modelCache[record.id]?.at || null,
    workspaceId: record.workspaceId || '',
    status: record.status || 'untested', lastError: record.lastError || null, lastTestedAt: record.lastTestedAt || null,
    supports: { ...provider.supports }, createdAt: record.createdAt || null, updatedAt: record.updatedAt || null,
  };
}

function mergeEmbeddingSuggestions(provider, listed) {
  const ids = new Set(listed.map(model => model.id.replace(/:latest$/, '')));
  const suggestions = catalogModels(provider, 'embeddings').filter(model => !ids.has(model.id)).map(model => ({ ...model, installed: provider.local ? false : undefined }));
  return [...listed, ...suggestions];
}

function bridgedConnections(state, snapshot) {
  const output = [];
  const overlay = id => state.overlays[id] || {};
  const offline = snapshot.reachable ? null : snapshot.error ? 'Start the local bridge to use this connection.' : null;
  const statusFor = (id, fallbackError) => {
    const extra = overlay(id);
    if (offline) return { status: 'error', lastError: offline };
    if (fallbackError) return { status: 'error', lastError: fallbackError };
    return { status: extra.status || 'untested', lastError: extra.lastError || null };
  };
  const base = (id, provider, extra) => ({
    id, providerId: provider.id, providerName: provider.name, via: provider.via, kind: provider.kind, transport: 'bridge', baseUrl: '', hasKey: false, needsKey: false, local: true,
    enabled: overlay(id).enabled !== false, lastTestedAt: overlay(id).lastTestedAt || null, workspaceId: '', embeddingModels: [], modelsUpdatedAt: state.modelCache[id]?.at || null,
    supports: { ...provider.supports }, createdAt: null, updatedAt: null, ...extra,
  });
  const bridge = getProvider('bridge');
  for (const entry of snapshot.providers) {
    const id = `bridge:${entry.id}`;
    const cache = cachedModels(state, id);
    output.push(base(id, bridge, {
      label: overlay(id).label || entry.name, bridgeProviderId: entry.id, bridgeType: entry.type, hasKey: entry.hasCredentials,
      defaultModel: overlay(id).defaultModel || entry.model || '',
      models: cache ? filterKind(cache, 'chat') : entry.model ? [{ id: entry.model, name: entry.model, description: '', contextWindow: null, maxOutput: null, efforts: entry.capabilities.reasoningEfforts, defaultEffort: null, capabilities: { tools: false, images: entry.capabilities.images, reasoning: entry.capabilities.reasoningEfforts.length > 0, embeddings: false } }] : [],
      supports: { tools: false, images: entry.capabilities.images, reasoning: entry.capabilities.reasoningEfforts.length > 0, embeddings: false },
      ...statusFor(id),
    }));
  }
  for (const agent of snapshot.agents) {
    if (!agent.available) continue;
    const ready = agent.status === 'ready' && agent.capabilities.generate;
    const problem = ready ? null : agent.reason || 'Update this CLI to use it with Still.';
    const id = AGENT_IDS[agent.id];
    const provider = getProvider(id);
    output.push(base(id, provider, { label: overlay(id).label || provider.name, agentId: agent.id, defaultModel: overlay(id).defaultModel || provider.chat.recommended, models: catalogModels(provider), ...statusFor(id, problem) }));
    if (agent.id === 'codex' && agent.capabilities.oauthLogin) {
      const oauth = getProvider('chatgpt-oauth');
      const auth = snapshot.auth?.codex || state.bridge?.auth?.codex;
      const signedIn = auth?.status === 'authenticated' && auth.method === 'chatgpt';
      const status = statusFor('chatgpt-oauth', problem);
      output.push(base('chatgpt-oauth', oauth, {
        label: overlay('chatgpt-oauth').label || oauth.name, agentId: 'codex', defaultModel: overlay('chatgpt-oauth').defaultModel || oauth.chat.recommended, models: catalogModels(oauth),
        signedIn, ...(status.status === 'error' ? status : signedIn ? { status: 'ok', lastError: null } : { status: 'untested', lastError: 'Sign in with ChatGPT to use your plan.' }),
      }));
    }
  }
  return output;
}

export async function listConnections({ refresh = false } = {}) {
  const [snapshot, keyIds, hints] = await Promise.all([bridgeSnapshot({ refresh }), connectionIdsWithKeys().then(ids => new Set(ids)), keyHints()]);
  const state = await loadState();
  return [...state.connections.map(record => publicDirect(record, state, keyIds, hints)), ...bridgedConnections(state, snapshot)];
}

// ---------- resolution ----------

function pickDefaultConnection(state, keyIds, snapshot) {
  for (const record of state.connections) {
    const provider = getProvider(record.providerId);
    if (record.enabled !== false && provider.chat && (!provider.needsKey || keyIds.has(record.id))) return record.id;
  }
  return bridgedConnections(state, snapshot).find(entry => entry.enabled && entry.status !== 'error')?.id || '';
}

export async function resolveConnection(id, { allowDisabled = false } = {}) {
  const state = await loadState();
  let connectionId = typeof id === 'string' ? id.trim() : '';
  if (!connectionId) connectionId = state.settings?.chat?.connectionId || '';
  if (!connectionId) {
    const keyIds = new Set(await connectionIdsWithKeys());
    connectionId = pickDefaultConnection(state, keyIds, bridgeMemory || { reachable: false, providers: [], agents: [] });
  }
  if (!connectionId) throw aiError('Connect an AI provider in Settings.', { code: 'no_connection' });
  connectionId = LEGACY_IDS[connectionId] || connectionId;
  if (isBridgedId(connectionId)) {
    // Bridge provider capabilities (enabled efforts, images) come from the bridge listing (cached for 30 s).
    if (connectionId.startsWith('bridge:')) await bridgeSnapshot().catch(() => null);
    return resolveBridged(connectionId, state, { allowDisabled });
  }
  const record = state.connections.find(entry => entry.id === connectionId);
  if (!record) throw aiError('That AI connection no longer exists. Connect an AI provider in Settings.', { code: 'no_connection' });
  const provider = getProvider(record.providerId);
  if (record.enabled === false && !allowDisabled) throw aiError(`${record.label || provider.name} is turned off. Turn it on in AI settings.`, { code: 'disabled' });
  const apiKey = await getApiKey(record.id);
  if (provider.needsKey && !apiKey) throw aiError(`Add your ${provider.name} API key in AI settings.`, { code: 'auth' });
  const keyIds = new Set(apiKey ? [record.id] : []);
  return { connection: publicDirect(record, state, keyIds), provider, apiKey, baseUrl: effectiveBaseUrl(record, provider), via: 'direct' };
}

function resolveBridged(connectionId, state, { allowDisabled }) {
  const extra = state.overlays[connectionId] || {};
  if (extra.enabled === false && !allowDisabled) throw aiError('This connection is turned off. Turn it on in AI settings.', { code: 'disabled' });
  const request = (path, options) => bridgeRequest(path, options);
  if (connectionId.startsWith('bridge:')) {
    const bridgeProviderId = connectionId.slice('bridge:'.length);
    if (!/^[\w-]{1,100}$/.test(bridgeProviderId)) throw aiError('That bridge connection is not valid.', { code: 'no_connection' });
    const known = (bridgeMemory?.providers || state.bridge?.providers || []).find(entry => entry.id === bridgeProviderId);
    const provider = getProvider('bridge');
    // The bridge rejects an effort or image its provider does not enable, so the transport needs these capabilities.
    const capabilities = known?.capabilities ? { images: known.capabilities.images === true, reasoningEfforts: [...(known.capabilities.reasoningEfforts || [])] } : null;
    return { connection: { id: connectionId, providerId: 'bridge', label: extra.label || known?.name || 'Bridge provider', via: 'bridge', bridgeProviderId, bridgeType: known?.type || '', defaultModel: extra.defaultModel || known?.model || '', enabled: extra.enabled !== false, capabilities },
      provider, apiKey: '', baseUrl: '', via: 'bridge', request };
  }
  const provider = getProvider(connectionId);
  if (!provider) throw aiError('That AI connection no longer exists. Connect an AI provider in Settings.', { code: 'no_connection' });
  return { connection: { id: connectionId, providerId: provider.id, label: extra.label || provider.name, via: 'agent', agentId: provider.agentId, defaultModel: extra.defaultModel || provider.chat.recommended, enabled: extra.enabled !== false },
    provider, apiKey: '', baseUrl: '', via: 'agent', request };
}

// Resolves which connection and model a request will use, without exposing the key. purpose 'quick' prefers the fast model.
export async function resolveChatTarget({ connectionId = '', model = '', effort = '', purpose = 'chat' } = {}) {
  const settings = await getAiSettings();
  const section = purpose === 'quick' ? settings.quick : settings.chat;
  const resolved = await resolveConnection(connectionId || section.connectionId || (purpose === 'quick' ? settings.chat.connectionId : ''));
  const { provider, connection } = resolved;
  const sameConnection = !connectionId || connectionId === section.connectionId;
  const chosen = model || (sameConnection && section.model) || (purpose === 'quick' ? provider.chat?.fast : '') || connection.defaultModel || provider.chat?.recommended || '';
  const info = await modelInfo(resolved, chosen);
  return {
    connectionId: connection.id, providerId: provider.id, providerName: provider.name, label: connection.label, via: resolved.via,
    model: chosen, modelLabel: info?.name || chosen, effort: effort || section.effort || (purpose === 'quick' ? 'low' : 'medium'),
  };
}

export async function modelInfo(resolved, model) {
  if (!model) return null;
  const state = await loadState();
  const cached = cachedModels(state, resolved.connection.id)?.find(entry => entry.id === model);
  if (cached) return publicModel(cached);
  const entry = resolved.provider.chat?.defaults.find(item => item.id === model);
  return entry ? modelFromCatalog(entry) : null;
}

// ---------- save / delete ----------

function cleanModel(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 300 || /[\s\x00-\x1f]/.test(value.trim())) throw aiError('Enter a valid model name.', { code: 'bad_request' });
  return value.trim();
}

function cleanLabel(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw aiError('Enter a name for this connection.', { code: 'bad_request' });
  return value.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 80);
}

async function saveBridged(input) {
  let id = LEGACY_IDS[input.id] || input.id || '';
  if (isObject(input.bridgeProvider)) {
    const saved = (await bridgeRequest('/ai/providers', { method: 'POST', body: input.bridgeProvider }))?.provider;
    if (!saved?.id) throw aiError('The bridge did not save the provider.', { code: 'bad_response' });
    id = `bridge:${saved.id}`;
    bridgeMemory = null;
  }
  if (!id && input.providerId && input.providerId !== 'bridge') id = input.providerId;
  if (!isBridgedId(id)) throw aiError('Choose a bridge connection to update.', { code: 'bad_request' });
  const label = cleanLabel(input.label), defaultModel = cleanModel(input.defaultModel);
  await update(state => {
    const current = { ...(state.overlays[id] || {}) };
    if (label !== undefined) current.label = label;
    if (defaultModel !== undefined) current.defaultModel = defaultModel;
    if (typeof input.enabled === 'boolean') current.enabled = input.enabled;
    state.overlays[id] = current;
    if (!state.settings?.chat?.connectionId && current.enabled !== false) state.settings = { ...state.settings, chat: { ...(state.settings.chat || {}), connectionId: id } };
  });
  const listed = (await listConnections()).find(entry => entry.id === id);
  return listed || (await resolveConnection(id, { allowDisabled: true })).connection;
}

// Creates or updates a connection. For direct providers it requests host access first (synchronously, so the click
// that called it still counts as the user gesture), stores the key in secrets and never in the connection record.
export async function saveConnection(input = {}) {
  if (!isObject(input)) throw aiError('Choose a provider to connect.', { code: 'bad_request' });
  if (isBridgedId(input.id) || BRIDGED_PROVIDERS.has(input.providerId) || isObject(input.bridgeProvider)) return saveBridged(input);
  const early = input.providerId ? requireProvider(input.providerId) : null;
  const earlyTarget = early && (input.baseUrl ? normalizeBaseUrl(input.baseUrl, early) : !input.id || !early.editableBaseUrl ? early.baseUrl : '');
  const permission = earlyTarget && input.enabled !== false ? ensureHostPermission(earlyTarget) : null;
  const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? validateApiKey(input.apiKey) : null;
  const label = cleanLabel(input.label), defaultModel = cleanModel(input.defaultModel);
  if (input.workspaceId !== undefined && input.workspaceId !== null && input.workspaceId !== '' && !/^[\w-]{1,120}$/.test(String(input.workspaceId))) throw aiError('Enter a valid workspace ID.', { code: 'bad_request' });
  if (permission) await permission;
  return update(async state => {
    const existing = input.id ? state.connections.find(entry => entry.id === input.id) : null;
    if (input.id && !existing) throw aiError('That connection no longer exists.', { code: 'no_connection' });
    if (existing && input.providerId && input.providerId !== existing.providerId) throw aiError('Create a new connection to switch providers.', { code: 'bad_request' });
    const provider = requireProvider(existing?.providerId || input.providerId);
    if (provider.via !== 'direct') throw aiError('Choose a provider to connect.', { code: 'bad_request' });
    const requestedBase = input.baseUrl ? normalizeBaseUrl(input.baseUrl, provider) : null;
    if (requestedBase && !provider.editableBaseUrl && requestedBase !== provider.baseUrl) throw aiError(`${provider.name} uses a fixed address.`, { code: 'bad_request' });
    const baseUrl = requestedBase || (existing ? effectiveBaseUrl(existing, provider) : provider.baseUrl);
    if (!baseUrl) throw aiError('Enter the server base URL.', { code: 'bad_request' });
    // Turning a connection off makes no request, so it must not depend on host access (which may have been revoked).
    if (!earlyTarget && input.enabled !== false) await ensureHostPermissionLate(baseUrl);
    const id = existing?.id || `${provider.id}-${randomId()}`;
    const hadKey = !!(await getApiKey(id));
    if (provider.needsKey && !apiKey && !hadKey) throw aiError(`Paste your ${provider.name} API key.`, { code: 'auth' });
    if (apiKey) await setApiKey(id, apiKey);
    else if (input.apiKey === null && hadKey) await deleteApiKey(id);
    const storedBase = baseUrl === provider.baseUrl ? '' : baseUrl;
    const workspaceId = input.workspaceId === undefined ? existing?.workspaceId || '' : String(input.workspaceId || '');
    const changed = !existing || !!apiKey || input.apiKey === null || storedBase !== (existing.baseUrl || '') || workspaceId !== (existing.workspaceId || '');
    const stamp = nowIso();
    const record = {
      ...(existing || {}), id, providerId: provider.id,
      label: label !== undefined ? label : existing?.label || '',
      baseUrl: storedBase,
      defaultModel: defaultModel !== undefined ? defaultModel : existing?.defaultModel || '',
      enabled: typeof input.enabled === 'boolean' ? input.enabled : existing?.enabled !== false,
      ...(provider.transport === 'anthropic' ? { workspaceId } : {}),
      status: changed ? 'untested' : existing.status || 'untested',
      lastError: changed ? null : existing.lastError || null,
      lastTestedAt: changed ? null : existing.lastTestedAt || null,
      createdAt: existing?.createdAt || stamp, updatedAt: stamp,
    };
    if (changed) delete state.modelCache[id];
    state.connections = existing ? state.connections.map(entry => entry.id === id ? record : entry) : [...state.connections, record];
    const settings = mergeSettings(state.settings);
    if (provider.chat && record.enabled && !settings.chat.connectionId) settings.chat = { ...settings.chat, connectionId: id, model: '' };
    if (provider.embeddings?.default && !settings.embeddings.connectionId) {
      const entry = provider.embeddings.models.find(model => model.id === provider.embeddings.default);
      settings.embeddings = { ...settings.embeddings, connectionId: id, model: provider.embeddings.default, dims: entry?.dims ?? null };
    }
    state.settings = settings;
    const hasKey = apiKey ? true : input.apiKey === null ? false : hadKey;
    const hint = apiKey ? keyHint(apiKey) : hasKey ? (await keyHints()).get(id) : '';
    return publicDirect(record, state, new Set(hasKey ? [id] : []), new Map(hint ? [[id, hint]] : []));
  });
}

export async function deleteConnection(id) {
  const connectionId = LEGACY_IDS[id] || id;
  if (typeof connectionId !== 'string' || !connectionId) throw aiError('Choose a connection to remove.', { code: 'bad_request' });
  if (connectionId.startsWith('bridge:')) {
    await bridgeRequest(`/ai/providers/${encodeURIComponent(connectionId.slice('bridge:'.length))}`, { method: 'DELETE' });
    bridgeMemory = null;
  }
  const direct = !isBridgedId(connectionId);
  if (direct) await deleteApiKey(connectionId);
  await update(state => {
    if (direct) {
      if (!state.connections.some(entry => entry.id === connectionId)) throw aiError('That connection no longer exists.', { code: 'no_connection' });
      state.connections = state.connections.filter(entry => entry.id !== connectionId);
    } else if (connectionId.startsWith('bridge:')) delete state.overlays[connectionId];
    else state.overlays[connectionId] = { ...(state.overlays[connectionId] || {}), enabled: false };
    delete state.modelCache[connectionId];
    const settings = mergeSettings(state.settings);
    for (const section of ['chat', 'quick', 'embeddings']) {
      if (settings[section].connectionId === connectionId) settings[section] = { ...settings[section], connectionId: '', model: '', ...(section === 'embeddings' ? { enabled: false } : {}) };
    }
    state.settings = settings;
  });
  return { deleted: true, id: connectionId };
}

// ---------- models ----------

function mergeWithCatalog(provider, listed) {
  const known = new Map([...(provider.chat?.defaults || [])].map(entry => [entry.id, entry]));
  const embeddings = new Map([...(provider.embeddings?.models || [])].map(entry => [entry.id, entry]));
  const merged = listed.map(model => {
    const entry = known.get(model.id);
    if (entry) {
      const base = modelFromCatalog(entry);
      return { ...model, name: entry.label || model.name, description: base.description || model.description,
        contextWindow: model.contextWindow ?? base.contextWindow, maxOutput: model.maxOutput ?? base.maxOutput,
        efforts: model.efforts?.length ? model.efforts : base.efforts, defaultEffort: model.defaultEffort || base.defaultEffort,
        recommended: entry.id === provider.chat.recommended || undefined,
        capabilities: { tools: model.capabilities.tools ?? base.capabilities.tools, images: model.capabilities.images ?? base.capabilities.images, reasoning: model.capabilities.reasoning ?? base.capabilities.reasoning, embeddings: false } };
    }
    const embedding = embeddings.get(model.id) || embeddings.get(String(model.id).replace(/:latest$/, ''));
    if (embedding) return { ...model, name: embedding.label || model.name, dims: embedding.dims ?? null, dimsOptions: embedding.dimsOptions || [], chat: false, capabilities: { ...model.capabilities, embeddings: true } };
    return model;
  });
  const order = [...known.keys()];
  return merged.sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
    if (a.created && b.created && a.created !== b.created) return b.created - a.created;
    return String(a.name).localeCompare(String(b.name));
  });
}

const compactModel = model => Object.fromEntries(Object.entries(model).filter(([, value]) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length)));

async function fetchModels(resolved, { signal }) {
  const { provider, connection, via } = resolved;
  if (via === 'bridge') {
    const data = await bridgeRequest(`/ai/providers/${encodeURIComponent(connection.bridgeProviderId)}/models`, { signal });
    return (Array.isArray(data?.models) ? data.models : []).filter(entry => entry?.id).map(entry => ({
      id: entry.id, name: entry.name || entry.id, description: '', contextWindow: entry.contextWindow ?? null, maxOutput: entry.maxOutput ?? null,
      efforts: Array.isArray(entry.reasoningEfforts) ? entry.reasoningEfforts : [], defaultEffort: null,
      capabilities: { tools: false, images: entry.supportsImages ?? null, reasoning: Array.isArray(entry.reasoningEfforts) && entry.reasoningEfforts.length > 0, embeddings: /embed/i.test(entry.id) },
    }));
  }
  const transport = TRANSPORTS[provider.transport];
  if (!transport?.listModels) return null;
  return mergeWithCatalog(provider, await transport.listModels({ ...resolved, signal }));
}

export async function listModels(id, { refresh = false, kind = 'chat', signal } = {}) {
  const resolved = await resolveConnection(id, { allowDisabled: true });
  const { provider, connection, via } = resolved;
  if (via === 'agent' || (via === 'direct' && !provider.modelList)) return catalogModels(provider, kind);
  const state = await loadState();
  const cache = state.modelCache[connection.id];
  let models = cache && Array.isArray(cache.models) && !refresh && Date.now() - Date.parse(cache.at) < MODEL_CACHE_MS ? cache.models : null;
  if (!models) {
    models = await fetchModels(resolved, { signal });
    if (!models) return catalogModels(provider, kind);
    const compact = models.map(compactModel);
    await update(next => { next.modelCache[connection.id] = { at: nowIso(), models: compact }; });
    models = compact;
  }
  const normalized = models.map(model => ({ description: '', contextWindow: null, maxOutput: null, efforts: [], defaultEffort: null, ...model, capabilities: { tools: null, images: null, reasoning: null, embeddings: false, ...(model.capabilities || {}) } }));
  if (kind === 'embeddings' && provider.embeddings) return mergeEmbeddingSuggestions(provider, filterKind(normalized, 'embeddings'));
  return filterKind(normalized, kind);
}

// ---------- testing ----------

async function embeddingProbe({ provider, baseUrl, apiKey, signal }) {
  const model = provider.embeddings.default;
  const body = provider.id === 'cohere'
    ? { model, input_type: 'search_query', texts: ['Still connection check'], embedding_types: ['float'] }
    : { model, input: ['Still connection check'], input_type: 'query' };
  const path = provider.id === 'cohere' ? '/embed' : '/embeddings';
  const response = await providerFetch(`${baseUrl}${path}`, { method: 'POST', headers: authHeaders({ provider, apiKey }), body, signal, provider, secrets: [apiKey], model, timeoutMs: 20000 });
  const data = await readJsonBody(response, { signal });
  const vector = data?.data?.[0]?.embedding || data?.embeddings?.float?.[0];
  if (!Array.isArray(vector) || !vector.length) throw aiError(`${provider.name} answered, but returned no embedding.`, { code: 'bad_response' });
  return { model, message: `Connected. ${model} returned a ${vector.length}-dimension embedding.` };
}

async function chatProbe(resolved, { signal }) {
  const { provider, connection } = resolved;
  const model = connection.defaultModel || provider.chat?.recommended;
  if (!model) throw aiError('Pick a model first.', { code: 'no_model' });
  const transport = TRANSPORTS[provider.transport];
  const result = await transport.stream({ ...resolved, model, modelInfo: null, system: '', messages: [{ role: 'user', content: 'Reply with the single word OK.' }], tools: [], effort: 'low', maxTokens: 16, signal, emit: () => {} });
  return { model, message: `Connected. ${result.model || model} answered.` };
}

// For providers whose model list needs no key: a cheap authenticated call that fails on a wrong key. A server without
// the route (404) is not treated as a failure.
async function keyCheck({ provider, baseUrl, apiKey }, { signal }) {
  if (!provider.keyCheckPath) return;
  try {
    const response = await providerFetch(`${baseUrl}${provider.keyCheckPath}`, { headers: { ...authHeaders({ provider, apiKey }), ...(provider.chatOptions?.headers || {}) }, signal, provider, secrets: [apiKey], timeoutMs: 20000 });
    await response.body?.cancel?.().catch(() => {});
  } catch (error) {
    if (error.code !== 'not_found') throw error;
  }
}

async function recordStatus(id, patch) {
  await update(state => {
    if (isBridgedId(id)) state.overlays[id] = { ...(state.overlays[id] || {}), ...patch };
    else state.connections = state.connections.map(entry => entry.id === id ? { ...entry, ...patch } : entry);
  });
}

export async function testConnection(id, { signal } = {}) {
  const resolved = await resolveConnection(id, { allowDisabled: true }).catch(error => {
    if (error.code === 'no_connection') throw error;
    return { error };
  });
  const connectionId = resolved.connection?.id || LEGACY_IDS[id] || id;
  const started = Date.now();
  let adoptModel = '';
  try {
    if (resolved.error) throw resolved.error;
    const { provider, connection, via } = resolved;
    let outcome;
    if (via === 'bridge') {
      const data = await bridgeRequest(`/ai/providers/${encodeURIComponent(connection.bridgeProviderId)}/test`, { method: 'POST', body: {}, signal });
      outcome = { model: connection.defaultModel, message: `Connected through the local bridge. ${data?.modelCount ?? 0} models available.`, modelCount: data?.modelCount ?? null };
    } else if (via === 'agent') {
      const agents = await cliSignInStatus();
      const auth = agents?.[provider.agentId];
      if (auth?.status !== 'authenticated') {
        throw aiError(provider.agentId === 'codex' ? 'Codex is not signed in. Sign in with ChatGPT in AI settings, or run codex login.' : 'Claude Code is not signed in. Run claude in a terminal to sign in.', { code: 'auth' });
      }
      if (provider.id === 'chatgpt-oauth' && auth.method !== 'chatgpt') throw aiError('Codex is signed in with an API key, not ChatGPT. Sign in with ChatGPT to use your plan.', { code: 'auth' });
      outcome = { model: connection.defaultModel, message: `${provider.name} is signed in${auth.method ? ` (${auth.method.replace(/_/g, ' ')})` : ''}.` };
    } else if (!provider.chat) {
      outcome = await embeddingProbe({ ...resolved, signal });
    } else if (provider.modelList) {
      let models;
      try { models = await listModels(connectionId, { refresh: true, kind: 'all', signal }); }
      catch (error) {
        // Some compatible servers have no model list; a one-token chat still proves the connection.
        if (provider.kind !== 'custom' || error.code !== 'not_found') throw error;
      }
      if (models) {
        await keyCheck(resolved, { signal });
        const chatModels = await listModels(connectionId, { kind: 'chat', signal });
        const model = connection.defaultModel || chatModels[0]?.id || '';
        const missing = model && chatModels.length && !models.some(entry => entry.id === model || entry.id === `${model}:latest`);
        const count = `${chatModels.length} ${chatModels.length === 1 ? 'model' : 'models'} available`;
        outcome = { model, modelCount: chatModels.length, message: missing ? `Connected. ${count}, but ${model} is not one of them. Pick another model.` : `Connected. ${count}.` };
        // Local servers have no catalog default, so adopt the first model found until the person picks one.
        if (!connection.defaultModel && model) adoptModel = model;
      } else outcome = await chatProbe(resolved, { signal });
    } else {
      outcome = await chatProbe(resolved, { signal });
    }
    const latencyMs = Date.now() - started;
    await recordStatus(connectionId, { status: 'ok', lastError: null, lastTestedAt: nowIso(), ...(adoptModel ? { defaultModel: adoptModel } : {}) });
    return { ok: true, latencyMs, ...outcome };
  } catch (error) {
    if (signal?.aborted) throw error;
    const latencyMs = Date.now() - started;
    const message = error.message || 'The connection test failed.';
    await recordStatus(connectionId, { status: 'error', lastError: message, lastTestedAt: nowIso() }).catch(() => {});
    return { ok: false, latencyMs, model: resolved.connection?.defaultModel || '', message, code: error.code || 'error', host: error.host || (resolved.baseUrl ? hostOf(resolved.baseUrl) : undefined) };
  }
}

