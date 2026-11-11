import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_STORE_KEY, LEGACY_PREFS_KEY, DEFAULT_AI_SETTINGS, configureConnections, deleteConnection, ensureHostPermission, getAiSettings, hostPermissionOrigins,
  listConnections, listModels, migrateLegacyPreferences, onConnectionsChanged, resolveChatTarget, resolveConnection, saveConnection, setAiSettings, testConnection,
  exportAiConfig, importAiConfig,
} from '../extension/lib/ai/connections.js';
import { PERMISSION_PRESETS } from '../extension/lib/ai/permissions.js';
import { RESEARCH_DEFAULTS } from '../extension/lib/ai/research/settings.js';
import { BROWSER_DEFAULTS } from '../extension/lib/browser/settings.js';
import { SECRETS_KEY } from '../extension/lib/ai/secrets.js';
import { CATALOG, clampEffort, getProvider, normalizeBaseUrl } from '../extension/lib/ai/catalog.js';
import { streamChat } from '../extension/lib/ai/chat.js';

const KEY = 'sk-ant-api03-TESTKEY-abcdefghijklmnop';
function memoryStorage() {
  const map = new Map();
  return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), clear: () => map.clear() };
}
globalThis.localStorage = memoryStorage();
const stored = key => JSON.parse(localStorage.getItem(key) || 'null');
const noBridge = { getIntegrationSettings: async () => ({ bridgeConfigured: false }) };

function reset(t, { chrome, integrations = noBridge } = {}) {
  localStorage.clear();
  configureConnections({ integrations });
  const previousChrome = globalThis.chrome, previousFetch = globalThis.fetch;
  if (chrome) globalThis.chrome = chrome; else delete globalThis.chrome;
  t.after(() => { if (previousChrome === undefined) delete globalThis.chrome; else globalThis.chrome = previousChrome; globalThis.fetch = previousFetch; });
}
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => { const call = { url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null }; calls.push(call); return handler(call); };
  return calls;
}

test('catalog lists every provider with the fields the settings UI needs', () => {
  const ids = CATALOG.map(provider => provider.id);
  for (const id of ['anthropic', 'openai', 'xai', 'google', 'openrouter', 'mistral', 'groq', 'deepseek', 'perplexity', 'voyage', 'cohere', 'ollama', 'lmstudio', 'custom-openai', 'custom-anthropic', 'bridge', 'agent:claude-code', 'agent:codex', 'chatgpt-oauth']) assert.ok(ids.includes(id), id);
  for (const provider of CATALOG) {
    for (const field of ['id', 'name', 'kind', 'description', 'needsKey', 'local', 'supports']) assert.ok(field in provider, `${provider.id}.${field}`);
    assert.ok(!/—/.test(provider.description), `${provider.id} copy has no em dash`);
    if (provider.via !== 'direct') assert.match(provider.description, /via local bridge/);
    if (provider.chat?.recommended) assert.ok(provider.chat.defaults.some(model => model.id === provider.chat.recommended), `${provider.id} recommended model is listed`);
    if (provider.embeddings?.default) assert.ok(provider.embeddings.models.some(model => model.id === provider.embeddings.default), `${provider.id} embeddings default is listed`);
  }
  const anthropic = getProvider('anthropic');
  assert.deepEqual(anthropic.chat.defaults.map(model => model.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
  assert.equal(anthropic.chat.recommended, 'claude-opus-5-5');
  assert.equal(anthropic.embeddings, null);
  assert.equal(getProvider('openai').embeddings.default, 'text-embedding-3-small');
  assert.equal(getProvider('voyage').chat, null);
  assert.equal(clampEffort('max', ['low', 'medium', 'high']), 'high');
  assert.equal(clampEffort('none', ['low', 'medium']), 'low');
  assert.equal(clampEffort('medium', ['low', 'high', 'max']), 'low');
  assert.throws(() => normalizeBaseUrl('http://example.com/v1'), /https/);
  assert.equal(normalizeBaseUrl('http://192.168.1.20:11434/', getProvider('ollama')), 'http://192.168.1.20:11434');
  assert.throws(() => normalizeBaseUrl('https://user:pw@example.com'), /password/);
});

test('legacy bridge preferences migrate into v2 settings and keep the bridge selection working', async t => {
  reset(t);
  assert.deepEqual(migrateLegacyPreferences({ providerId: 'cli:claude', model: '', reasoningEffort: 'minimal' }).settings.chat, { connectionId: 'agent:claude-code', model: '', effort: 'minimal' });
  localStorage.setItem(LEGACY_PREFS_KEY, JSON.stringify({ providerId: 'provider_abc', model: 'gpt-6.1-sol', reasoningEffort: 'high', tone: 'concise', depth: 'brief', scope: 'library' }));
  const settings = await getAiSettings();
  assert.deepEqual(settings.chat, { connectionId: 'bridge:provider_abc', model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual(settings.writing, { tone: 'concise', depth: 'brief', scope: 'library' });
  assert.equal(stored(AI_STORE_KEY).migratedFrom, LEGACY_PREFS_KEY);
  assert.ok(localStorage.getItem(LEGACY_PREFS_KEY), 'the legacy key is left in place');
  const requests = [];
  configureConnections({ integrations: { getIntegrationSettings: async () => ({ bridgeConfigured: true }), requestBridge: async (path, options = {}) => {
    requests.push({ path, body: options.body });
    options.onEvent?.({ type: 'delta', text: 'ok' });
    return { type: 'done', text: 'ok' };
  } } });
  const resolved = await resolveConnection();
  assert.equal(resolved.via, 'bridge');
  assert.equal(resolved.connection.bridgeProviderId, 'provider_abc');
  const result = await streamChat({ messages: [{ role: 'user', content: 'Hello' }] });
  assert.equal(result.text, 'ok');
  // Resolution reads the bridge provider list first (for its enabled efforts); the chat request follows.
  const chatRequest = requests.find(request => request.path === '/ai/chat');
  assert.equal(chatRequest.body.providerId, 'provider_abc');
  assert.equal(chatRequest.body.model, 'gpt-6.1-sol', 'the migrated model override still applies');
  assert.equal(chatRequest.body.reasoningEffort, undefined, 'an effort the bridge provider does not enable is not sent');
});

test('AI settings have spec defaults, merge per section and refuse secrets or invalid values', async t => {
  reset(t);
  const defaults = await getAiSettings();
  assert.deepEqual(defaults, structuredClone({ ...DEFAULT_AI_SETTINGS, chat: { ...DEFAULT_AI_SETTINGS.chat }, quick: { ...DEFAULT_AI_SETTINGS.quick }, embeddings: { ...DEFAULT_AI_SETTINGS.embeddings } }));
  assert.equal(defaults.chat.effort, 'medium');
  assert.equal(defaults.autoSuggestOnSave, true);
  assert.equal(defaults.handoffTarget, 'claude');
  const next = await setAiSettings({ chat: { effort: 'high' }, embeddings: { enabled: true, dims: 1024 }, handoffTarget: 'grok' });
  assert.equal(next.chat.effort, 'high');
  assert.equal(next.chat.model, '');
  assert.equal(next.embeddings.dims, 1024);
  assert.equal(next.handoffTarget, 'grok');
  await assert.rejects(setAiSettings({ chat: { effort: 'turbo' } }), /reasoning effort/);
  await assert.rejects(setAiSettings({ chat: { apiKey: 'sk-nope' } }), /belong in a connection/);
  await assert.rejects(setAiSettings({ embeddings: { dims: 1.5 } }), /whole number/);
  assert.equal((await getAiSettings()).chat.effort, 'high');
});

const ASK_ALL = { create: 'ask', organize: 'ask', edit: 'ask', dashboard: 'ask', delete: 'ask' };

test('assistant permissions default to asking for everything, merge per kind and refuse anything but ask or allow', async t => {
  reset(t);
  assert.deepEqual({ ...DEFAULT_AI_SETTINGS.assistantPermissions }, ASK_ALL);
  assert.deepEqual((await getAiSettings()).assistantPermissions, ASK_ALL);
  let next = await setAiSettings({ assistantPermissions: { create: 'allow', organize: 'allow' } });
  assert.deepEqual(next.assistantPermissions, { ...ASK_ALL, create: 'allow', organize: 'allow' });
  next = await setAiSettings({ assistantPermissions: { ...PERMISSION_PRESETS.trusted } });
  assert.deepEqual(next.assistantPermissions, { ...PERMISSION_PRESETS.trusted });
  for (const [patch, message] of [
    [{ assistantPermissions: { delete: 'yes' } }, /either Ask or Allow/],
    [{ assistantPermissions: { delete: 'auto' } }, /either Ask or Allow/],
    [{ assistantPermissions: { delete: true } }, /either Ask or Allow/],
    [{ assistantPermissions: { everything: 'allow' } }, /only cover create, organize, edit, dashboard and delete/],
    [{ assistantPermissions: 'allow' }, /must list each kind of change/],
    [{ assistantPermissions: true }, /must list each kind of change/],
    [{ assistantPermissions: null }, /must list each kind of change/],
  ]) await assert.rejects(setAiSettings(patch), error => error.code === 'bad_request' && message.test(error.message), JSON.stringify(patch));
  // A refused write changes nothing.
  assert.deepEqual((await getAiSettings()).assistantPermissions, { ...PERMISSION_PRESETS.trusted });
});

test('research settings default from lib/ai/research/settings.js and accept only values already in range', async t => {
  reset(t);
  assert.deepEqual({ ...DEFAULT_AI_SETTINGS.research }, { ...RESEARCH_DEFAULTS });
  assert.deepEqual((await getAiSettings()).research, { ...RESEARCH_DEFAULTS });
  const next = await setAiSettings({ research: { depth: 'deep', github: 'off', maxSubpages: 0, budgetUsd: 12.5, allowOriginalEdits: true, enabled: false, connectionId: 'conn_1' } });
  assert.deepEqual(next.research, { ...RESEARCH_DEFAULTS, depth: 'deep', github: 'off', maxSubpages: 0, budgetUsd: 12.5, allowOriginalEdits: true, enabled: false, connectionId: 'conn_1' });
  assert.equal((await setAiSettings({ research: { maxSubpages: 12, budgetUsd: 50 } })).research.depth, 'deep', 'one level deep merge keeps the other fields');
  for (const [patch, message] of [
    [{ depth: 'extreme' }, /research depth/], [{ github: 'sometimes' }, /uses GitHub/], [{ maxSubpages: 13 }, /0 to 12 subpages/], [{ maxSubpages: 2.5 }, /0 to 12 subpages/],
    [{ maxSubpages: '3' }, /0 to 12 subpages/], [{ budgetUsd: 0 }, /between \$1 and \$50/], [{ budgetUsd: 51 }, /between \$1 and \$50/], [{ budgetUsd: '5' }, /between \$1 and \$50/],
    [{ budgetUsd: Number.NaN }, /between \$1 and \$50/], [{ enabled: 'yes' }, /on or off/], [{ allowOriginalEdits: 1 }, /Editing the original/], [{ connectionId: ' padded ' }, /connection for research/],
    [{ connectionId: 'x'.repeat(201) }, /connection for research/], [{ model: 'claude-opus-5-5' }, /not a research agent setting/],
  ]) await assert.rejects(setAiSettings({ research: patch }), error => error.code === 'bad_request' && message.test(error.message), JSON.stringify(patch));
  await assert.rejects(setAiSettings({ research: true }), /Research agent settings must be an object/);
  await assert.rejects(setAiSettings({ research: { token: 'ghp_nope' } }), /belong in a connection/);
  assert.deepEqual((await getAiSettings()).research, { ...RESEARCH_DEFAULTS, depth: 'deep', github: 'off', maxSubpages: 12, budgetUsd: 50, allowOriginalEdits: true, enabled: false, connectionId: 'conn_1' });
});

test('browser automation settings default to off and Ask, merge one level deep and accept only values already in their saved form', async t => {
  reset(t);
  assert.deepEqual({ ...DEFAULT_AI_SETTINGS.browser, sites: {} }, { ...BROWSER_DEFAULTS, sites: {} });
  assert.deepEqual((await getAiSettings()).browser, { enabled: false, engine: 'quiet', mode: 'ask', sites: {}, maxSteps: 60 });
  let next = await setAiSettings({ browser: { enabled: true, mode: 'auto' } });
  assert.deepEqual(next.browser, { enabled: true, engine: 'quiet', mode: 'auto', sites: {}, maxSteps: 60 });
  next = await setAiSettings({ browser: { sites: { 'shop.example': 'allow', 'bank.example': 'ask', 'localhost:3000': 'block' }, maxSteps: 120 } });
  assert.deepEqual(next.browser, { enabled: true, engine: 'quiet', mode: 'auto', sites: { 'shop.example': 'allow', 'bank.example': 'ask', 'localhost:3000': 'block' }, maxSteps: 120 });
  assert.equal((await setAiSettings({ browser: { engine: 'precise' } })).browser.engine, 'precise');
  await assert.rejects(setAiSettings({ browser: { engine: 'loud' } }), error => error.code === 'bad_request');
  // A host may be called like a secret; it is still only a host.
  assert.equal((await setAiSettings({ browser: { sites: { token: 'block' } } })).browser.sites.token, 'block');
  for (const patch of [{ mode: 'always' }, { enabled: 'yes' }, { glow: true }, { maxSteps: 5 }, { maxSteps: 500 }, { maxSteps: 60.5 }, { sites: { 'https://www.Shop.example/cart': 'allow' } },
    { sites: { 'shop.example': 'maybe' } }, { sites: ['shop.example'] }, { sites: { 'not a host !!': 'allow' } }, { unknown: true }]) {
    await assert.rejects(setAiSettings({ browser: patch }), error => error.code === 'bad_request' && /Browser automation settings are not valid/.test(error.message), JSON.stringify(patch));
  }
  await assert.rejects(setAiSettings({ browser: true }), /Browser automation settings are not valid/);
  await assert.rejects(setAiSettings({ browser: null }), /Browser automation settings are not valid/);
  assert.deepEqual((await getAiSettings()).browser.sites, { token: 'block' }, 'a refused write changes nothing');
});

test('web search is off by default, stays on the device and accepts only values already in range', async t => {
  reset(t, { chrome: { permissions: { request: async () => true, contains: async () => true } } });
  assert.deepEqual((await getAiSettings()).webSearch, { enabled: false, maxUses: 5 });
  assert.deepEqual((await setAiSettings({ webSearch: { enabled: true } })).webSearch, { enabled: true, maxUses: 5 });
  assert.deepEqual((await setAiSettings({ webSearch: { maxUses: 8 } })).webSearch, { enabled: true, maxUses: 8 }, 'one level deep merge keeps the switch');
  for (const patch of [{ enabled: 'yes' }, { maxUses: 0 }, { maxUses: 50 }, { maxUses: 2.5 }, { extra: true }]) {
    await assert.rejects(setAiSettings({ webSearch: patch }), error => error.code === 'bad_request' && /Web search must be on or off/.test(error.message), JSON.stringify(patch));
  }
  await assert.rejects(setAiSettings({ webSearch: true }), /Web search must be on or off/);
  const exported = await exportAiConfig();
  assert.ok(!('webSearch' in exported.settings), 'not in a backup');
  localStorage.clear();
  const result = await importAiConfig({ ...exported, settings: { ...exported.settings, webSearch: { enabled: true, maxUses: 10 } } });
  assert.ok(!result.settingsAdded.includes('webSearch'));
  assert.deepEqual((await getAiSettings()).webSearch, { enabled: false, maxUses: 5 }, 'a backup file cannot turn web search on');
  // A stored value this build cannot use is read as a safe one.
  localStorage.setItem(AI_STORE_KEY, JSON.stringify({ version: 2, connections: [], overlays: {}, modelCache: {}, settings: { webSearch: { enabled: 1, maxUses: 999 } } }));
  assert.deepEqual((await getAiSettings()).webSearch, { enabled: false, maxUses: 10 });
});

test('a stored browser section a build cannot use is read as safe values', async t => {
  reset(t);
  localStorage.setItem(AI_STORE_KEY, JSON.stringify({ version: 2, connections: [], overlays: {}, modelCache: {},
    settings: { browser: { enabled: 'true', mode: 'yolo', sites: { 'Shop.example': 'allow', 'x.example': 'sometimes' }, maxSteps: 9999, extra: 1 } } }));
  const settings = await getAiSettings();
  assert.deepEqual(settings.browser, { enabled: false, engine: 'quiet', mode: 'ask', sites: { 'shop.example': 'allow' }, maxSteps: 200 }, 'only an exact true turns it on, and only Auto is Auto');
  assert.equal((await setAiSettings({ handoffTarget: 'grok' })).handoffTarget, 'grok', 'another setting can still be saved');
});

test('stored permission and research values a build cannot use are read as safe values and never block other writes', async t => {
  reset(t);
  localStorage.setItem(AI_STORE_KEY, JSON.stringify({ version: 2, connections: [], overlays: {}, modelCache: {},
    settings: { handoffTarget: 'claude', assistantPermissions: { create: 'allow', delete: 'always', wipe: 'allow' }, research: { depth: 'galaxy', budgetUsd: 999, extra: 1 } } }));
  const settings = await getAiSettings();
  assert.deepEqual(settings.assistantPermissions, { ...ASK_ALL, create: 'allow' }, 'only an exact allow allows');
  assert.equal(settings.research.depth, RESEARCH_DEFAULTS.depth);
  assert.equal(settings.research.budgetUsd, 50, 'clamped by normalizeResearchSettings');
  assert.ok(!('extra' in settings.research));
  assert.equal((await setAiSettings({ handoffTarget: 'grok' })).handoffTarget, 'grok');
  const saved = stored(AI_STORE_KEY).settings;
  assert.deepEqual(saved.assistantPermissions, { ...ASK_ALL, create: 'allow' });
  assert.ok(!('extra' in saved.research));
});

test('assistant permissions and research settings stay on the device: never exported, never imported from a file', async t => {
  reset(t, { chrome: { permissions: { request: async () => true, contains: async () => true } } });
  const connection = await saveConnection({ providerId: 'anthropic', apiKey: KEY });
  await setAiSettings({ assistantPermissions: { ...PERMISSION_PRESETS.full }, research: { connectionId: connection.id, budgetUsd: 20, allowOriginalEdits: true }, handoffTarget: 'grok',
    browser: { enabled: true, mode: 'auto', sites: { 'shop.example': 'allow' } } });
  const exported = await exportAiConfig();
  assert.equal(exported.settings.handoffTarget, 'grok');
  assert.ok(!('assistantPermissions' in exported.settings), 'permissions are not in the backup');
  assert.ok(!('research' in exported.settings), 'research settings are not in the backup');
  assert.ok(!('browser' in exported.settings), 'browser automation settings are not in the backup');
  // A crafted backup on a fresh device cannot turn on auto-apply or loosen the research agent.
  localStorage.clear();
  const crafted = { ...exported, settings: { ...exported.settings, assistantPermissions: { ...PERMISSION_PRESETS.full }, research: { ...RESEARCH_DEFAULTS, allowOriginalEdits: true, budgetUsd: 50 },
    browser: { enabled: true, mode: 'auto', sites: { 'bank.example': 'allow' }, maxSteps: 200 } } };
  const result = await importAiConfig(crafted);
  assert.ok(result.settingsAdded.includes('handoffTarget'));
  assert.ok(!result.settingsAdded.includes('assistantPermissions') && !result.settingsAdded.includes('research') && !result.settingsAdded.includes('browser'));
  const settings = await getAiSettings();
  // A backup file cannot turn browser automation on, switch it to Auto or allow a site.
  assert.deepEqual(settings.browser, { enabled: false, engine: 'quiet', mode: 'ask', sites: {}, maxSteps: 60 });
  assert.deepEqual(settings.assistantPermissions, ASK_ALL);
  assert.deepEqual(settings.research, { ...RESEARCH_DEFAULTS });
  assert.ok(!('assistantPermissions' in stored(AI_STORE_KEY).settings), 'nothing from the file was stored');
});

test('removing a connection sends research back to automatic', async t => {
  reset(t, { chrome: { permissions: { request: async () => true, contains: async () => true } } });
  const connection = await saveConnection({ providerId: 'anthropic', apiKey: KEY });
  await setAiSettings({ research: { connectionId: connection.id, depth: 'quick' } });
  await deleteConnection(connection.id);
  const { research } = await getAiSettings();
  assert.equal(research.connectionId, '');
  assert.equal(research.depth, 'quick', 'the rest of the research settings stay');
});

test('saveConnection asks for host access inside the gesture, stores the key apart and makes it the default', async t => {
  const requested = [];
  reset(t, { chrome: { permissions: { request: async ({ origins }) => { requested.push(origins); return true; }, contains: async () => true } } });
  const changes = [];
  const stop = onConnectionsChanged(() => changes.push('changed'));
  t.after(stop);
  const pending = saveConnection({ providerId: 'anthropic', apiKey: `  ${KEY}  `, label: 'Work' });
  assert.deepEqual(requested, [['https://api.anthropic.com/*']], 'permissions.request runs before the first await');
  const connection = await pending;
  assert.equal(connection.providerId, 'anthropic');
  assert.equal(connection.label, 'Work');
  assert.equal(connection.hasKey, true);
  assert.equal(connection.via, 'direct');
  assert.equal(connection.status, 'untested');
  assert.equal(connection.defaultModel, 'claude-opus-5-5');
  assert.ok(connection.models.some(model => model.id === 'claude-haiku-5-5'));
  assert.ok(!JSON.stringify(stored(AI_STORE_KEY)).includes(KEY), 'the key never lands in still.ai.v2');
  assert.equal(stored(SECRETS_KEY)[connection.id].apiKey, KEY);
  assert.equal((await getAiSettings()).chat.connectionId, connection.id);
  const listed = await listConnections();
  assert.equal(listed.length, 1);
  assert.ok(!JSON.stringify(listed).includes(KEY));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(changes.length >= 1);
  const resolved = await resolveConnection();
  assert.equal(resolved.apiKey, KEY);
  assert.equal(resolved.baseUrl, 'https://api.anthropic.com/v1');
  const target = await resolveChatTarget({ purpose: 'quick' });
  assert.equal(target.model, 'claude-haiku-5-5');
  assert.equal(target.modelLabel, 'Claude Haiku 5.5');
  assert.equal(target.effort, 'low');
});

test('saveConnection stops when access is denied or a key is missing, and validates custom servers', async t => {
  reset(t, { chrome: { permissions: { request: async () => false } } });
  await assert.rejects(saveConnection({ providerId: 'openai', apiKey: 'sk-proj-abcdefghijklmnopqrst' }), error => error.code === 'permission' && /Allow Still to reach api\.openai\.com/.test(error.message));
  assert.equal(localStorage.getItem(SECRETS_KEY), null);
  globalThis.chrome = { permissions: { request: async () => true } };
  await assert.rejects(saveConnection({ providerId: 'openai' }), /Paste your OpenAI API key/);
  await assert.rejects(saveConnection({ providerId: 'custom-openai' }), /base URL/);
  await assert.rejects(saveConnection({ providerId: 'custom-openai', baseUrl: 'http://example.com/v1' }), /https/);
  const local = await saveConnection({ providerId: 'ollama' });
  assert.equal(local.baseUrl, 'http://localhost:11434');
  assert.equal(local.hasKey, false);
  const custom = await saveConnection({ providerId: 'custom-openai', baseUrl: 'https://llm.example.com/v1/', defaultModel: 'my-model' });
  assert.equal(custom.baseUrl, 'https://llm.example.com/v1');
  assert.deepEqual(hostPermissionOrigins({ providerId: 'custom-openai', baseUrl: 'https://llm.example.com/v1' }), ['https://llm.example.com/*']);
  assert.deepEqual(hostPermissionOrigins('ollama'), ['http://localhost/*']);
  assert.deepEqual(hostPermissionOrigins('agent:codex'), []);
  await assert.rejects(ensureHostPermission('http://evil.example.com'), /https/);
  // Without a gesture Chrome throws instead of asking; a host granted earlier still passes.
  globalThis.chrome = { permissions: { request: () => { throw new Error('This function must be called during a user gesture'); }, contains: async ({ origins }) => origins[0] === 'https://api.x.ai/*' } };
  assert.equal(await ensureHostPermission('xai'), true);
  await assert.rejects(ensureHostPermission('groq'), error => error.code === 'permission' && /api\.groq\.com/.test(error.message));
});

test('deleteConnection removes the key and clears settings that pointed at it', async t => {
  reset(t, { chrome: { permissions: { request: async () => true } } });
  const voyage = await saveConnection({ providerId: 'voyage', apiKey: 'pa-abcdefghijklmnopqrstuvwxyz' });
  const settings = await getAiSettings();
  assert.equal(settings.embeddings.connectionId, voyage.id);
  assert.equal(settings.embeddings.model, 'voyage-4');
  assert.equal(settings.embeddings.dims, 1024);
  assert.equal(settings.embeddings.enabled, false);
  assert.equal(settings.chat.connectionId, '', 'an embeddings-only provider is never the chat default');
  await deleteConnection(voyage.id);
  assert.deepEqual(stored(SECRETS_KEY), {});
  assert.equal((await getAiSettings()).embeddings.connectionId, '');
  assert.deepEqual(await listConnections(), []);
  await assert.rejects(resolveConnection(), /Connect an AI provider in Settings/);
});

test('testConnection lists models with latency, caches them for a day and maps a rejected key', async t => {
  reset(t, { chrome: { permissions: { request: async () => true } } });
  const connection = await saveConnection({ providerId: 'openai', apiKey: 'sk-proj-REALLYSECRET-0123456789' });
  let status = 200;
  const calls = mockFetch(() => status === 200
    ? new Response(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }, { id: 'text-embedding-3-small' }, { id: 'tts-1' }, { id: 'gpt-6.1-sol-realtime' }] }))
    : new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-proj-REALLYSECRET-0123456789' } }), { status: 401 }));
  const ok = await testConnection(connection.id);
  assert.equal(ok.ok, true);
  assert.ok(Number.isFinite(ok.latencyMs));
  assert.equal(ok.model, 'gpt-6.1-sol');
  assert.match(ok.message, /2 models available/);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models');
  const chatModels = await listModels(connection.id);
  assert.deepEqual(chatModels.map(model => model.id), ['gpt-6.1-sol', 'gpt-6-luna']);
  assert.equal(chatModels[0].name, 'GPT-6.1 Sol');
  assert.deepEqual(chatModels[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  const embeddingModels = await listModels(connection.id, { kind: 'embeddings' });
  assert.equal(embeddingModels[0].id, 'text-embedding-3-small');
  assert.equal(embeddingModels[0].dims, 1536);
  assert.equal(calls.length, 1, 'model lists come from the 24 hour cache');
  assert.equal((await listConnections())[0].status, 'ok');
  status = 401;
  const failed = await testConnection(connection.id);
  assert.equal(failed.ok, false);
  assert.match(failed.message, /^Check the API key/);
  assert.ok(!failed.message.includes('REALLYSECRET'));
  const listed = (await listConnections())[0];
  assert.equal(listed.status, 'error');
  assert.ok(!JSON.stringify(listed).includes('REALLYSECRET'));
});

test('bridge providers and CLI agents are listed with via bridge/agent, and an offline bridge shows why', async t => {
  let online = true;
  reset(t, { integrations: {
    getIntegrationSettings: async () => ({ bridgeConfigured: true }),
    requestBridge: async path => {
      if (!online) throw new Error('Failed to fetch');
      if (path === '/ai/providers') return {
        providers: [{ id: 'provider_1', type: 'bedrock', name: 'Bedrock', model: 'anthropic.claude-opus-5-5', hasCredentials: true, capabilities: { images: true, reasoningEfforts: [] } }],
        agents: [{ id: 'claude', name: 'Claude Code', available: true, status: 'ready', capabilities: { generate: true } }, { id: 'codex', name: 'Codex CLI', available: true, status: 'ready', capabilities: { generate: true, oauthLogin: true } }],
      };
      if (path === '/ai/cli/auth') return { agents: { codex: { status: 'authenticated', method: 'chatgpt' }, claude: { status: 'unauthenticated' } } };
      throw new Error(`unexpected ${path}`);
    },
  } });
  const listed = await listConnections();
  assert.deepEqual(listed.map(entry => [entry.id, entry.via]), [['bridge:provider_1', 'bridge'], ['agent:claude-code', 'agent'], ['agent:codex', 'agent'], ['chatgpt-oauth', 'agent']]);
  assert.equal(listed[0].defaultModel, 'anthropic.claude-opus-5-5');
  assert.equal(listed[3].status, 'untested');
  const oauth = await testConnection('chatgpt-oauth');
  assert.equal(oauth.ok, true);
  const claude = await testConnection('agent:claude-code');
  assert.equal(claude.ok, false);
  assert.match(claude.message, /not signed in/);
  const refreshed = await listConnections({ refresh: true });
  assert.equal(refreshed.find(entry => entry.id === 'chatgpt-oauth').status, 'ok');
  assert.equal(refreshed.find(entry => entry.id === 'agent:claude-code').status, 'error');
  online = false;
  const offline = await listConnections({ refresh: true });
  assert.equal(offline.length, 4, 'last known bridge connections stay listed');
  assert.ok(offline.every(entry => entry.status === 'error' && /local bridge/.test(entry.lastError)));
});

test('a local connection adopts its first model on test, and a custom server without /models is checked with a tiny chat', async t => {
  reset(t, { chrome: { permissions: { request: async () => true, contains: async () => true } } });
  const local = await saveConnection({ providerId: 'ollama' });
  assert.equal(local.defaultModel, '');
  await assert.rejects(streamChat({ connectionId: local.id, messages: [{ role: 'user', content: 'Hi' }] }), /Pick a model for Ollama/);
  mockFetch(call => {
    if (call.url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', details: { family: 'nomic-bert' } }, { name: 'qwen3:8b', model: 'qwen3:8b', details: { parameter_size: '8B' } }] }));
    if (call.url.endsWith('/models')) return new Response('', { status: 404 });
    if (call.url.endsWith('/chat/completions')) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    throw new Error(`unexpected ${call.url}`);
  });
  const checked = await testConnection(local.id);
  assert.equal(checked.ok, true);
  assert.equal(checked.model, 'qwen3:8b');
  assert.match(checked.message, /1 model available/);
  const listed = (await listConnections()).find(entry => entry.id === local.id);
  assert.equal(listed.defaultModel, 'qwen3:8b');
  assert.deepEqual(listed.models.map(model => model.id), ['qwen3:8b']);
  assert.ok(listed.embeddingModels.some(model => model.id === 'nomic-embed-text:latest'));
  assert.ok(listed.embeddingModels.some(model => model.id === 'embeddinggemma' && model.installed === false));
  const custom = await saveConnection({ providerId: 'custom-openai', baseUrl: 'https://llm.example.com/v1', defaultModel: 'house-model' });
  const probe = await testConnection(custom.id);
  assert.equal(probe.ok, true);
  assert.match(probe.message, /answered/);
  const calls = [];
  const stop = onConnectionsChanged(() => calls.push(1));
  stop();
  await setAiSettings({ includePageText: false });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls.length, 0, 'unsubscribed listeners are not called');
});

test('OpenRouter connection test checks the key, because its model list is public', async t => {
  reset(t, { chrome: { permissions: { request: async () => true } } });
  const connection = await saveConnection({ providerId: 'openrouter', apiKey: 'sk-or-v1-WRONGKEY-0123456789abcdef' });
  let keyStatus = 401;
  const calls = mockFetch(call => {
    if (call.url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } }] }));
    if (call.url.endsWith('/key')) return keyStatus === 200 ? new Response(JSON.stringify({ data: { label: 'still' } })) : new Response(JSON.stringify({ error: { message: 'No auth credentials found' } }), { status: keyStatus });
    throw new Error(`unexpected ${call.url}`);
  });
  const failed = await testConnection(connection.id);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'auth');
  const check = calls.find(call => call.url === 'https://openrouter.ai/api/v1/key');
  assert.equal(check.headers.Authorization, 'Bearer sk-or-v1-WRONGKEY-0123456789abcdef');
  assert.ok(!failed.message.includes('WRONGKEY'));
  keyStatus = 200;
  assert.equal((await testConnection(connection.id)).ok, true);
  keyStatus = 404;
  assert.equal((await testConnection(connection.id)).ok, true, 'a server without the key route is not a failure');
});
