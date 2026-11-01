// Durability of the stores outside the library: dashboard, AI connections and keys, conversations and UI preferences.
// Each must keep data it does not understand, never rewrite a newer build's data, and survive concurrent views.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardStore, DASHBOARD_KEY, DASHBOARD_VERSION, isNewerDashboard, mergeDashboards, normalizeDashboard, portableDashboard } from '../extension/lib/dashboard-store.js';
import {
  AI_STORE_KEY, configureConnections, exportAiConfig, getAiSettings, importAiConfig, listConnections, resolveConnection, saveConnection, setAiSettings,
} from '../extension/lib/ai/connections.js';
import { SECRETS_KEY, getApiKey, setApiKey } from '../extension/lib/ai/secrets.js';
import { BODY_PREFIX, CONVERSATIONS_KEY, CONVERSATION_LIMITS, LEGACY_CHATS_KEY, createConversationStore, createMemoryStorage, normalizeConversation } from '../extension/lib/ai/conversations.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), clear: () => map.clear(),
    key: index => [...map.keys()][index] ?? null, get length() { return map.size; } };
}
globalThis.localStorage = memoryStorage();
const stored = key => JSON.parse(localStorage.getItem(key) || 'null');
// A separate module instance (its own module-level state), as a new page would load it.
const freshModule = (path, tag) => import(`${new URL(path, import.meta.url).href}?${tag}`);
const put = (key, value) => localStorage.setItem(key, JSON.stringify(value));

// A Web Lock stand-in that records which lock each write took and runs tasks one at a time.
function fakeLocks() {
  const names = [];
  let tail = Promise.resolve();
  return { names, request(name, task) { names.push(name); const run = tail.then(() => task({ name })); tail = run.catch(() => {}); return run; } };
}

// ------------------------------------------------------------------ dashboard

// One shared "chrome.storage" value; each createDashboardStore over it is one open view.
function sharedDashboard(initial = null) {
  let value = initial ? structuredClone(initial) : null;
  let writes = 0;
  const locks = fakeLocks();
  const view = (seed = () => null) => createDashboardStore({ read: async () => value ? structuredClone(value) : null, write: async next => { writes++; value = structuredClone(next); }, seed, locks });
  return { view, locks, get value() { return value; }, set value(next) { value = structuredClone(next); }, get writes() { return writes; } };
}

const futureDashboard = () => ({
  version: 1, activeBoardId: 'main', layoutEngine: 'masonry', prefs: { stickiesHidden: false }, updatedAt: '2026-10-01T00:00:00.000Z',
  boards: [{ id: 'main', name: 'Main', icon: 'house', wallpaper: { tint: 'sea' }, widgets: [
    { id: 'w1', type: 'clock', x: 0, y: 0, w: 3, h: 2, title: '', style: { frame: 'neon', hideTitle: false, accent: 'violet' }, config: { zone: 'UTC' }, pinnedAt: '2026-09-01', z: 4 },
  ] }],
});

test('dashboard: fields, style keys and frames a newer build wrote survive this build’s edits', async () => {
  const env = sharedDashboard(futureDashboard());
  const view = env.view();
  await view.load();
  await view.updateWidget('w1', { title: 'Clock' });
  await view.addWidget('main', { type: 'notes', w: 3, h: 2, config: {}, transient: 'ui-only', style: { frame: 'sparkle', glow: true } });
  const saved = env.value;
  assert.equal(saved.layoutEngine, 'masonry', 'unknown top-level key kept');
  assert.deepEqual(saved.boards[0].wallpaper, { tint: 'sea' }, 'unknown board key kept');
  const clock = saved.boards[0].widgets.find(w => w.id === 'w1');
  assert.equal(clock.title, 'Clock');
  assert.equal(clock.pinnedAt, '2026-09-01');
  assert.equal(clock.z, 4);
  assert.deepEqual(clock.style, { accent: 'violet', frame: 'neon', hideTitle: false }, 'unknown style key and frame kept');
  const notes = saved.boards[0].widgets.find(w => w.type === 'notes');
  assert.equal(notes.transient, undefined, 'a new widget from the UI keeps only documented fields');
  assert.deepEqual(notes.style, { frame: 'default', hideTitle: false });
  // Functions never reach storage, even as unknown fields.
  assert.equal(normalizeDashboard({ boards: [{ id: 'b', widgets: [{ id: 'w', type: 'clock', onClick: () => {} }] }] }).boards[0].widgets[0].onClick, undefined);
});

test('dashboard: a newer version is shown read-only and nothing is ever written', async () => {
  const newer = { ...futureDashboard(), version: DASHBOARD_VERSION + 1 };
  const env = sharedDashboard(newer);
  const view = env.view();
  const state = await view.load();
  assert.equal(state.boards[0].widgets[0].id, 'w1', 'the newer dashboard is still shown');
  assert.equal(view.readOnly(), true);
  assert.equal(isNewerDashboard(state), true, 'the state keeps its newer version');
  for (const attempt of [() => view.addWidget('main', { type: 'clock' }), () => view.setPrefs({ stickiesHidden: true }), () => view.update(() => {}),
    () => view.replace(normalizeDashboard({ boards: [] }), { persist: true })]) {
    await assert.rejects(attempt(), error => error.code === 'newer_version' && /newer version of Still/.test(error.message) && /nothing was changed/.test(error.message));
  }
  assert.equal(env.writes, 0);
  assert.deepEqual(env.value, newer);
  assert.throws(() => mergeDashboards(state, futureDashboard()), /newer version/);
  assert.throws(() => mergeDashboards(futureDashboard(), newer), /newer version/, 'a newer backup is not merged into an older format');
  assert.equal(portableDashboard(newer).version, DASHBOARD_VERSION + 1, 'a backup keeps the real version');
});

test('dashboard: two views editing at once never lose each other’s change (lock + re-read)', async () => {
  const env = sharedDashboard({ boards: [{ id: 'main', name: 'Main', widgets: [] }], updatedAt: '2026-10-01T00:00:00.000Z' });
  const tab = env.view(), panel = env.view();
  await tab.load();
  await panel.load();
  await tab.addWidget('main', { id: 'from-tab', type: 'clock', x: 0, y: 0, w: 3, h: 2 });
  // The panel still holds the old state in memory; its write must build on the tab's save.
  await panel.addWidget('main', { id: 'from-panel', type: 'notes', w: 3, h: 2 });
  assert.deepEqual(env.value.boards[0].widgets.map(w => w.id), ['from-tab', 'from-panel']);
  assert.deepEqual(panel.get().boards[0].widgets.map(w => w.id), ['from-tab', 'from-panel'], 'the panel adopted the newer state');
  assert.ok(env.locks.names.length >= 2 && env.locks.names.every(name => name === DASHBOARD_KEY), 'writes take the still.dashboard.v1 lock');
  assert.ok(env.value.updatedAt > '2026-10-01T00:00:00.000Z');
  // Concurrent updates from both views in the same tick also both land.
  await Promise.all([tab.setPrefs({ a: 1 }), panel.setPrefs({ b: 2 })]);
  assert.deepEqual(env.value.prefs, { a: 1, b: 2 });
});

test('dashboard: a restored (older) snapshot in storage wins over a view’s stale memory', async () => {
  const env = sharedDashboard({ boards: [{ id: 'main', name: 'Main', widgets: [] }], updatedAt: '2026-10-01T00:00:00.000Z' });
  const view = env.view();
  await view.load();
  await view.addWidget('main', { id: 'later', type: 'clock', x: 0, y: 0, w: 3, h: 2 });
  env.value = { boards: [{ id: 'main', name: 'Restored', widgets: [] }], updatedAt: '2026-09-01T00:00:00.000Z' };
  await view.setPrefs({ c: 3 });
  assert.equal(env.value.boards[0].name, 'Restored');
  assert.deepEqual(env.value.boards[0].widgets, [], 'the snapshot is not overwritten with the old in-memory board');
  assert.deepEqual(env.value.prefs, { c: 3 });
});

test('dashboard: replace() and refresh() wait for this view’s queued update, and refresh follows storage', async () => {
  const env = sharedDashboard({ boards: [{ id: 'main', name: 'Main', widgets: [] }], updatedAt: '2026-10-01T00:00:00.000Z' });
  const view = env.view();
  await view.load();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const order = [];
  const slow = view.update(async draft => { await gate; draft.boards[0].name = 'Slow'; order.push('update'); });
  const replaced = view.replace({ boards: [{ id: 'other', name: 'Other', widgets: [] }] }).then(() => order.push('replace'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(order, [], 'replace waits behind the running update');
  release();
  await Promise.all([slow, replaced]);
  assert.deepEqual(order, ['update', 'replace']);
  assert.equal(view.get().boards[0].id, 'other');

  // Another view saved: refresh adopts storage; an unchanged store is a no-op.
  const other = env.view();
  await other.load();
  await other.updateBoard('main', { name: 'Renamed elsewhere' });
  await view.refresh();
  assert.equal(view.get().boards[0].name, 'Renamed elsewhere');
  const before = view.get();
  await view.refresh();
  assert.equal(view.get(), before, 'nothing new in storage: the state object is unchanged');
});

test('dashboard: with nothing stored and no seed, the default board stays unsaved until a seed exists', async () => {
  const env = sharedDashboard(null);
  let seed = () => null;
  const view = env.view(() => seed());
  const placeholder = await view.load();
  assert.equal(placeholder.boards[0].name, 'Main');
  assert.equal(env.writes, 0, 'no empty board is saved over the future first-run seed');
  assert.equal(view.isPlaceholder(), true);
  // A view that later gains a seed provider (the dashboard preload) seeds and saves the real first-run board.
  seed = async () => ({ boards: [{ id: 'seeded', name: 'Home', widgets: [{ id: 'c', type: 'clock', x: 0, y: 0, w: 3, h: 2 }] }] });
  const seeded = await view.load();
  assert.equal(seeded.boards[0].id, 'seeded');
  assert.equal(env.writes, 1);
  assert.equal(view.isPlaceholder(), false);
  assert.equal(env.value.boards[0].id, 'seeded');
});

test('dashboard: two views opening on first run seed once, and a failed save shows what is really stored', async () => {
  const env = sharedDashboard(null);
  let seeds = 0;
  const seed = async () => { seeds++; return { boards: [{ id: 'home', name: 'Home', widgets: [] }] }; };
  const [a, b] = await Promise.all([env.view(seed).load(), env.view(seed).load()]);
  assert.equal(seeds, 1, 'the second view re-reads inside the lock and finds the first view’s seed');
  assert.equal(env.writes, 1);
  assert.equal(a.boards[0].id, 'home');
  assert.equal(b.boards[0].id, 'home');

  let fail = false;
  const seen = [];
  const store = createDashboardStore({ read: async () => ({ boards: [{ id: 'main', widgets: [] }], updatedAt: '2026-10-01T00:00:00.000Z' }),
    write: async () => { if (fail) throw new Error('quota'); }, locks: null });
  await store.load();
  store.subscribe(state => seen.push(state.boards[0].widgets.length));
  fail = true;
  await assert.rejects(store.addWidget('main', { type: 'clock' }), /quota/);
  assert.equal(store.get().boards[0].widgets.length, 0, 'the unsaved change is rolled back');
  assert.deepEqual(seen, [1, 0]);
});

test('dashboard: a backup strips credential-like keys from unknown fields too', () => {
  const portable = portableDashboard({ boards: [{ id: 'b', name: 'B', sessionToken: 'x', note: 'keep', widgets: [
    { id: 'w', type: 'clock', apiKey: 'secret', label: 'keep me', style: { frame: 'card', cookie: 'c' }, config: { token: 't', city: 'Oslo' } },
  ] }], authorization: 'Bearer x', theme: 'sea' });
  assert.equal(portable.authorization, undefined);
  assert.equal(portable.theme, 'sea');
  assert.equal(portable.boards[0].sessionToken, undefined);
  assert.equal(portable.boards[0].note, 'keep');
  const widget = portable.boards[0].widgets[0];
  assert.equal(widget.apiKey, undefined);
  assert.equal(widget.label, 'keep me');
  assert.deepEqual(widget.style, { frame: 'card', hideTitle: false });
  assert.deepEqual(widget.config, { city: 'Oslo' });
});

test('dashboard (extension instance): views follow another view’s save, skip their own echo, and export nothing unsaved', async t => {
  let value;
  const listeners = [];
  const previous = globalThis.chrome;
  globalThis.chrome = { storage: { local: { get: async key => ({ [key]: value === undefined ? undefined : structuredClone(value) }), set: async entries => { value = structuredClone(entries[DASHBOARD_KEY]); } },
    onChanged: { addListener: fn => listeners.push(fn) } } };
  t.after(() => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; });
  const module = await freshModule('../extension/lib/dashboard-store.js', 'extension-instance');
  const source = module.dashboardBackupSource();
  assert.equal(await source.exportDashboard(), null, 'nothing saved yet: no placeholder board in a backup');
  assert.equal(value, undefined, 'and nothing was written');
  module.setDashboardSeed(async () => ({ boards: [{ id: 'home', name: 'Home', widgets: [] }] }));
  await module.loadDashboard();
  assert.equal(value.boards[0].id, 'home', 'the first-run seed runs once a seed provider exists');
  assert.equal(listeners.length, 1);
  assert.equal(module.isDashboardReadOnly(), false);

  // Another tab saves: the event is followed by a re-read.
  value = { ...value, boards: [{ id: 'home', name: 'Renamed in another tab', widgets: [] }], updatedAt: '2099-01-01T00:00:00.000Z' };
  listeners[0]({ [DASHBOARD_KEY]: { newValue: structuredClone(value) } }, 'local');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(module.getDashboard().boards[0].name, 'Renamed in another tab');
  // This view's own echo is ignored; a stale event never rolls the view back.
  await module.updateBoard('home', { name: 'Mine' });
  listeners[0]({ [DASHBOARD_KEY]: { newValue: { boards: [{ id: 'home', name: 'Stale', widgets: [] }], updatedAt: '2000-01-01T00:00:00.000Z' } } }, 'local');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(module.getDashboard().boards[0].name, 'Mine');
  assert.equal((await source.exportDashboard()).boards[0].name, 'Mine');
});

// ------------------------------------------------------------------ AI connections and keys

const noBridge = { getIntegrationSettings: async () => ({ bridgeConfigured: false }) };
function resetAi(t, chrome = { permissions: { request: async () => true, contains: async () => true } }) {
  localStorage.clear();
  configureConnections({ integrations: noBridge });
  const previous = globalThis.chrome;
  if (chrome) globalThis.chrome = chrome; else delete globalThis.chrome;
  t.after(() => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; });
}

test('AI state of an unknown version or shape is never rewritten; writes refuse with a clear error', async t => {
  resetAi(t);
  const future = { version: 3, connections: [{ id: 'anthropic-x', providerId: 'anthropic', label: 'Work' }], settings: { chat: { connectionId: 'anthropic-x' } }, vault: { sealed: true } };
  put(AI_STORE_KEY, future);
  const settings = await getAiSettings();
  assert.equal(settings.chat.connectionId, '', 'reads get a blank stand-in');
  assert.deepEqual(await listConnections(), []);
  assert.deepEqual(stored(AI_STORE_KEY), future, 'reading never rewrites the stored state');
  await assert.rejects(setAiSettings({ includePageText: false }), error => error.code === 'newer_version' && /newer version of Still/.test(error.message));
  await assert.rejects(saveConnection({ providerId: 'ollama' }), error => error.code === 'newer_version');
  await assert.rejects(exportAiConfig(), error => error.code === 'newer_version');
  assert.deepEqual(stored(AI_STORE_KEY), future, 'refused writes change nothing');

  for (const odd of [{ connections: [] }, 'garbage', [1, 2]]) {
    put(AI_STORE_KEY, odd);
    await getAiSettings();
    await assert.rejects(setAiSettings({ includePageText: false }), error => error.code === 'newer_version');
    assert.deepEqual(stored(AI_STORE_KEY), odd);
  }
  localStorage.setItem(AI_STORE_KEY, '{not json');
  await getAiSettings();
  assert.equal(localStorage.getItem(AI_STORE_KEY), '{not json', 'unparseable data is not treated as missing');

  localStorage.removeItem(AI_STORE_KEY);
  await getAiSettings();
  assert.equal(stored(AI_STORE_KEY).version, 2, 'a missing key still starts a blank v2 state');
});

test('AI writes take the still.ai.v2 Web Lock', async t => {
  resetAi(t);
  const names = [];
  const original = navigator.locks.request;
  navigator.locks.request = function (name, ...rest) { names.push(name); return original.call(this, name, ...rest); };
  t.after(() => { delete navigator.locks.request; });
  await setAiSettings({ includePageText: false });
  await setApiKey('openai-x', 'sk-proj-abcdefghijklmnopqrst');
  assert.ok(names.includes(AI_STORE_KEY));
  assert.ok(names.includes(SECRETS_KEY));
});

test('a connection for a provider this build does not know survives unrelated writes and stays hidden', async t => {
  resetAi(t);
  const futureConnection = { id: 'future-1', providerId: 'future-provider', label: 'Future', baseUrl: 'https://future.example/v1', modelHint: 'x', createdAt: '2026-01-01T00:00:00.000Z' };
  put(AI_STORE_KEY, { version: 2, connections: [futureConnection], overlays: {}, settings: {}, modelCache: {}, bridge: null, futureTopLevel: { keep: true } });
  const local = await saveConnection({ providerId: 'ollama' });
  await setAiSettings({ autoSuggestOnSave: false });
  const state = stored(AI_STORE_KEY);
  assert.deepEqual(state.connections.find(entry => entry.id === 'future-1'), futureConnection, 'kept exactly as stored');
  assert.deepEqual(state.futureTopLevel, { keep: true });
  assert.deepEqual((await listConnections()).map(entry => entry.id), [local.id], 'hidden from the runtime list');
  await assert.rejects(resolveConnection('future-1'), /does not support/);
  assert.equal((await resolveConnection()).connection.id, local.id, 'never picked as the default');
});

test('a stored keys record in a shape this build cannot read is never overwritten', async t => {
  resetAi(t);
  put(SECRETS_KEY, ['sealed-by-a-newer-build']);
  assert.equal(await getApiKey('x'), '');
  await assert.rejects(setApiKey('x', 'sk-proj-abcdefghijklmnopqrst'), error => error.code === 'newer_version');
  assert.deepEqual(stored(SECRETS_KEY), ['sealed-by-a-newer-build']);
});

test('exportAiConfig carries settings and connections without any secret; importAiConfig adds, never overwrites', async t => {
  resetAi(t);
  const KEY = 'sk-ant-api03-EXPORTSECRET-abcdefghijklmnop';
  const anthropic = await saveConnection({ providerId: 'anthropic', apiKey: KEY, label: 'Work', workspaceId: 'ws_1' });
  const custom = await saveConnection({ providerId: 'custom-openai', baseUrl: 'https://llm.example.com/v1', defaultModel: 'house' });
  await setAiSettings({ handoffTarget: 'grok', chat: { effort: 'high' } });
  // Stray credentials on a record or in bridge state must never be exported.
  const state = stored(AI_STORE_KEY);
  state.connections[0].apiKey = 'sk-should-not-leak-0000000000';
  state.connections[0].token = 'tok-should-not-leak';
  state.bridge = { auth: { codex: { status: 'authenticated', token: 'bridge-secret' } } };
  state.overlays = { 'bridge:x': { label: 'Bridge' } };
  put(AI_STORE_KEY, state);

  const exported = await exportAiConfig();
  const text = JSON.stringify(exported);
  for (const secret of [KEY, 'sk-should-not-leak', 'tok-should-not-leak', 'bridge-secret']) assert.ok(!text.includes(secret), secret);
  assert.equal(exported.version, 2);
  assert.equal(exported.settings.handoffTarget, 'grok');
  assert.deepEqual(exported.connections.map(entry => entry.id), [anthropic.id, custom.id]);
  assert.deepEqual(Object.keys(exported.connections[0]).sort(), ['createdAt', 'defaultModel', 'enabled', 'id', 'label', 'providerId', 'updatedAt', 'workspaceId', 'baseUrl'].sort());
  assert.equal(exported.connections[1].baseUrl, 'https://llm.example.com/v1');

  // A fresh device: everything is added, no key is imported, settings are filled in.
  localStorage.clear();
  const result = await importAiConfig(exported);
  assert.equal(result.connectionsAdded, 2);
  assert.ok(result.settingsAdded.includes('handoffTarget'));
  assert.equal(stored(SECRETS_KEY), null, 'no key is ever imported');
  const listed = await listConnections();
  assert.deepEqual(listed.map(entry => [entry.id, entry.hasKey, entry.status]), [[anthropic.id, false, 'untested'], [custom.id, false, 'untested']]);
  assert.equal(listed[0].label, 'Work');
  assert.equal(listed[1].baseUrl, 'https://llm.example.com/v1');
  assert.equal((await getAiSettings()).handoffTarget, 'grok');
  // A file cannot route library data anywhere by itself: its connections arrive turned off, and no restored model choice
  // points at a connection the file just added.
  assert.deepEqual(stored(AI_STORE_KEY).connections.map(entry => entry.enabled), [false, false]);
  assert.ok(!result.settingsAdded.includes('chat'));
  assert.notEqual((await getAiSettings()).chat?.connectionId, custom.id);

  // Importing again (or onto a device with its own copy) never overwrites local connections or settings.
  await saveConnection({ id: custom.id, label: 'Renamed here' });
  await setAiSettings({ handoffTarget: 'claude' });
  const again = await importAiConfig({ ...exported, connections: [...exported.connections,
    { id: 'openai-evil', providerId: 'openai', baseUrl: 'https://evil.example.com/v1', apiKey: 'sk-x' },
    { id: 'bridge:abc', providerId: 'bridge' },
    { id: 'agent:codex', providerId: 'agent:codex' },
    { id: 'future-9', providerId: 'future-provider', baseUrl: 'https://future.example/v1', apiKey: 'sk-also-not' },
    { id: '../bad id', providerId: 'openai' },
  ] });
  assert.equal(again.connectionsAdded, 1, 'only the unknown-provider connection is new and valid');
  assert.deepEqual(again.settingsAdded, []);
  const after = stored(AI_STORE_KEY);
  assert.equal(after.connections.find(entry => entry.id === custom.id).label, 'Renamed here');
  assert.equal(after.connections.find(entry => entry.id === anthropic.id).label, 'Work');
  assert.equal(after.settings.handoffTarget, 'claude');
  assert.ok(!JSON.stringify(after).includes('sk-also-not'));
  assert.equal(after.connections.find(entry => entry.id === 'future-9').providerId, 'future-provider');
  assert.ok(!after.connections.some(entry => entry.id === 'openai-evil'), 'a fixed-address provider never gets another address');

  await assert.rejects(importAiConfig({ version: 3, connections: [] }), error => error.code === 'newer_version');
  await assert.rejects(importAiConfig({ version: 1 }), /cannot read/);
  await assert.rejects(importAiConfig(null), /no AI settings/);
});

test('importAiConfig never imports secret-named settings or a model choice for a missing connection', async t => {
  resetAi(t);
  const result = await importAiConfig({ version: 2, connections: [], settings: { apiKey: 'sk-nope', chat: { connectionId: 'openai-missing', model: 'x' }, includePageText: false, writing: { tone: 'concise' } } });
  assert.deepEqual(result.settingsAdded.sort(), ['includePageText', 'writing']);
  const settings = await getAiSettings();
  assert.equal(settings.apiKey, undefined);
  assert.equal(settings.chat.connectionId, '');
  assert.equal(settings.includePageText, false);
});

// ------------------------------------------------------------------ conversations

const conversation = (id, updatedAt, extra = {}) => ({ id, title: `Chat ${id}`, createdAt: '2026-09-01T00:00:00.000Z', updatedAt,
  messages: [{ id: `${id}-q`, role: 'user', text: `Question ${id}`, createdAt: '2026-09-01T00:00:00.000Z' }, { id: `${id}-a`, role: 'assistant', text: `Answer ${id}`, createdAt: updatedAt }], ...extra });

test('conversations keep unknown plain-data fields and valid timestamps; missing ones stay stable', async () => {
  const storage = createMemoryStorage();
  const store = createConversationStore({ storage, now: () => '2026-10-30T00:00:00.000Z' });
  await store.saveConversation({ ...conversation('c1', '2026-10-01T00:00:00.000Z'), pinned: true, folder: { id: 'f1' }, onRender: () => {},
    messages: [{ id: 'm1', role: 'user', text: 'Hi', createdAt: '2026-10-01T00:00:00.000Z', attachments: [{ name: 'a.png' }], handler: () => {} }, { id: 'm2', role: 'assistant', text: 'Hello' }] });
  const loaded = await store.getConversation('c1');
  assert.equal(loaded.pinned, true);
  assert.deepEqual(loaded.folder, { id: 'f1' });
  assert.equal('onRender' in loaded, false, 'functions are stripped');
  assert.deepEqual(loaded.messages[0].attachments, [{ name: 'a.png' }]);
  assert.equal('handler' in loaded.messages[0], false);
  assert.equal(loaded.createdAt, '2026-09-01T00:00:00.000Z');
  assert.equal(loaded.updatedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(loaded.messages[0].createdAt, '2026-10-01T00:00:00.000Z');
  assert.equal(loaded.messages[1].createdAt, '2026-10-01T00:00:00.000Z', 'a missing message time falls back to the conversation’s');
  // A stored body without timestamps reads the same way every time (not "now").
  const bare = { id: 'old', messages: [{ role: 'user', text: 'x', createdAt: '2026-01-02T00:00:00.000Z' }, { role: 'assistant', text: 'y' }] };
  const first = normalizeConversation(bare, { now: '2026-10-01T00:00:00.000Z' });
  const second = normalizeConversation(bare, { now: '2026-10-02T00:00:00.000Z' });
  assert.equal(first.createdAt, '2026-01-02T00:00:00.000Z');
  assert.equal(first.updatedAt, second.updatedAt);
});

test('conversations: an index from a newer build is listed but never rewritten', async () => {
  const index = { version: 3, migratedLegacy: true, items: [{ id: 'c1', title: 'Newer', updatedAt: '2026-10-01T00:00:00.000Z' }], shards: 4 };
  const storage = createMemoryStorage({ [CONVERSATIONS_KEY]: index, [BODY_PREFIX + 'c1']: conversation('c1', '2026-10-01T00:00:00.000Z'), [BODY_PREFIX + 'orphan']: conversation('orphan', '2026-10-02T00:00:00.000Z') });
  const store = createConversationStore({ storage });
  assert.deepEqual((await store.listConversations()).map(item => item.id), ['c1']);
  assert.equal((await store.getConversation('c1')).id, 'c1');
  const before = structuredClone(Object.fromEntries(storage.map));
  for (const attempt of [() => store.saveConversation(conversation('c2', '2026-10-03T00:00:00.000Z')), () => store.deleteConversation('c1'),
    () => store.importAll({ version: 2, conversations: [conversation('c3', '2026-10-03T00:00:00.000Z')] })]) {
    await assert.rejects(attempt(), error => error.code === 'newer_version' && /nothing was changed/.test(error.message));
  }
  assert.deepEqual(Object.fromEntries(storage.map), before, 'nothing written, no orphan recovery either');
});

test('conversations: a lost, corrupt or incomplete index is rebuilt from the saved bodies', async () => {
  // Lost index: every body comes back, and legacy chats are not migrated twice.
  const legacy = [{ id: 'c1', title: 'Old copy', messages: [{ id: 'q', role: 'user', content: 'old' }] }];
  const lost = createMemoryStorage({ [LEGACY_CHATS_KEY]: legacy, [BODY_PREFIX + 'c1']: conversation('c1', '2026-10-01T00:00:00.000Z'), [BODY_PREFIX + 'c2']: conversation('c2', '2026-10-02T00:00:00.000Z') });
  const listed = await createConversationStore({ storage: lost }).listConversations();
  assert.deepEqual(listed.map(item => item.id), ['c2', 'c1']);
  assert.equal(listed[1].title, 'Chat c1', 'the saved body wins over the legacy copy');
  assert.deepEqual((await lost.get(CONVERSATIONS_KEY)).items.map(item => item.id), ['c2', 'c1'], 'the rebuilt index is saved');

  // Corrupt index plus a dangling entry and an orphan.
  const corrupt = createMemoryStorage({ [CONVERSATIONS_KEY]: 'garbage', [BODY_PREFIX + 'c1']: conversation('c1', '2026-10-01T00:00:00.000Z') });
  assert.deepEqual((await createConversationStore({ storage: corrupt }).listConversations()).map(item => item.id), ['c1']);
  const partial = createMemoryStorage({
    [CONVERSATIONS_KEY]: { version: 2, migratedLegacy: true, items: [{ id: 'gone', title: 'Gone', updatedAt: '2026-10-05T00:00:00.000Z' }, { id: 'c1', title: 'Chat c1', updatedAt: '2026-10-01T00:00:00.000Z' }], futureField: 'keep' },
    [BODY_PREFIX + 'c1']: conversation('c1', '2026-10-01T00:00:00.000Z'), [BODY_PREFIX + 'c9']: conversation('c9', '2026-10-09T00:00:00.000Z'),
  });
  const partialStore = createConversationStore({ storage: partial });
  assert.deepEqual((await partialStore.listConversations()).map(item => item.id), ['c9', 'c1'], 'orphan recovered, dangling entry dropped');
  assert.equal((await partial.get(CONVERSATIONS_KEY)).futureField, 'keep', 'unknown index fields survive');

  // The index disappears after the store was ready: the next save rebuilds it instead of orphaning every body.
  await partial.remove([CONVERSATIONS_KEY]);
  await partialStore.saveConversation(conversation('c10', '2026-10-10T00:00:00.000Z'));
  assert.deepEqual((await partialStore.listConversations()).map(item => item.id), ['c10', 'c9', 'c1']);
});

test('conversations: exportAll / importAll round trip with newer-wins, limits and the shared lock', async () => {
  const source = createConversationStore({ storage: createMemoryStorage() });
  await source.saveConversation(conversation('a', '2026-10-01T00:00:00.000Z', { tag: 'kept' }));
  await source.saveConversation(conversation('b', '2026-10-02T00:00:00.000Z'));
  const exported = await source.exportAll();
  assert.equal(exported.version, 2);
  assert.deepEqual(exported.conversations.map(c => c.id), ['b', 'a']);
  assert.equal(exported.conversations[1].messages.length, 2, 'full conversations, not summaries');

  const locks = fakeLocks();
  const targetStorage = createMemoryStorage();
  const target = createConversationStore({ storage: targetStorage, locks });
  await target.saveConversation(conversation('b', '2026-10-05T00:00:00.000Z', { title: 'Local newer' }));
  const result = await target.importAll(exported);
  assert.deepEqual(result, { added: 1, updated: 0, skipped: 1, full: 0 });
  assert.equal((await target.getConversation('b')).title, 'Local newer', 'a newer local copy is kept');
  assert.equal((await target.getConversation('a')).tag, 'kept');
  assert.ok(locks.names.every(name => name === 'still.ai.conversations') && locks.names.length >= 3);

  const newer = await target.importAll({ version: 2, conversations: [conversation('a', '2026-10-09T00:00:00.000Z', { title: 'Edited elsewhere' }),
    conversation('a', '2026-10-08T00:00:00.000Z'), { id: 'bad' }, 'junk', { id: 'x'.repeat(300), messages: [] }] });
  assert.deepEqual(newer, { added: 0, updated: 1, skipped: 4, full: 0 });
  assert.equal((await target.getConversation('a')).title, 'Edited elsewhere');
  assert.deepEqual((await target.listConversations()).map(c => c.id), ['a', 'b']);

  await assert.rejects(target.importAll({ version: 3, conversations: [] }), error => error.code === 'newer_version');
  await assert.rejects(target.importAll({ nope: true }), /no assistant conversations/);
});

test('conversations: an import fills free room only and never evicts a conversation saved here', async () => {
  const storage = createMemoryStorage();
  const items = [];
  for (let i = 0; i < CONVERSATION_LIMITS.conversations - 1; i++) {
    const c = normalizeConversation(conversation(`l${i}`, new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString()));
    storage.map.set(BODY_PREFIX + c.id, c);
    items.push({ id: c.id, title: c.title, updatedAt: c.updatedAt });
  }
  storage.map.set(CONVERSATIONS_KEY, { version: 2, migratedLegacy: true, items });
  const store = createConversationStore({ storage });
  const result = await store.importAll({ version: 2, conversations: [conversation('n1', '2026-10-01T00:00:00.000Z'), conversation('n2', '2026-10-02T00:00:00.000Z'), conversation('n3', '2020-01-01T00:00:00.000Z')] });
  assert.deepEqual(result, { added: 1, updated: 0, skipped: 2, full: 2 });
  const list = await store.listConversations();
  assert.equal(list.length, CONVERSATION_LIMITS.conversations);
  assert.equal(list[0].id, 'n2', 'the newest import takes the one free slot');
  assert.ok(list.some(c => c.id === 'l0'), 'the oldest local conversation is still there');
  assert.equal(await storage.get(BODY_PREFIX + 'n1'), undefined, 'skipped imports are not written');
});

test('conversation storage lists keys without loading everything when Chrome allows it', async t => {
  const previous = globalThis.chrome;
  t.after(() => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; });
  let fullReads = 0;
  const data = { [BODY_PREFIX + 'a']: conversation('a', '2026-10-01T00:00:00.000Z'), 'still.library.v1': { items: [] } };
  const local = { get: async key => { if (key === null) { fullReads++; return structuredClone(data); } return { [key]: structuredClone(data[key]) }; }, set: async entries => Object.assign(data, entries), remove: async () => {} };
  globalThis.chrome = { storage: { local: { ...local, getKeys: async () => Object.keys(data) } } };
  const store = createConversationStore({ locks: null });
  assert.deepEqual((await store.listConversations()).map(c => c.id), ['a'], 'the orphaned body is found');
  assert.equal(fullReads, 0, 'getKeys avoids reading the library');
  delete data[CONVERSATIONS_KEY];
  globalThis.chrome = { storage: { local } };
  assert.deepEqual((await createConversationStore({ locks: null }).listConversations()).map(c => c.id), ['a']);
  assert.equal(fullReads, 1, 'older Chrome falls back to one full read');
  delete globalThis.chrome;
  localStorage.clear();
  put(BODY_PREFIX + 'b', conversation('b', '2026-10-02T00:00:00.000Z'));
  assert.deepEqual((await createConversationStore({ locks: null }).listConversations()).map(c => c.id), ['b'], 'the preview build lists localStorage keys');
  localStorage.clear();
});

// ------------------------------------------------------------------ UI preferences

test('prefs.set re-reads localStorage so another tab’s keys survive; touchCollection keeps other recent fields', async t => {
  localStorage.clear();
  const values = { 'still.ui.recent.v1': { recentCollections: ['old'], pinnedMenu: ['x'] } };
  const previous = globalThis.chrome;
  globalThis.chrome = { storage: { local: { get: async key => ({ [key]: structuredClone(values[key]) }), set: async entries => Object.assign(values, structuredClone(entries)) } } };
  t.after(() => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; });
  const { prefs } = await freshModule('../extension/ui/prefs.js', 'prefs-test');
  prefs.set('panelWidth', 320);
  // Another tab writes its own key to the shared record.
  put('still.ui.v1', { ...stored('still.ui.v1'), expandedCollections: ['travel'] });
  prefs.set('notesRail', true);
  assert.deepEqual(stored('still.ui.v1'), { panelWidth: 320, expandedCollections: ['travel'], notesRail: true });
  put('still.ui.v1', { ...stored('still.ui.v1'), expandedCollections: ['travel', 'work'] });
  prefs.toggleInList('expandedCollections', 'home', true);
  assert.deepEqual(stored('still.ui.v1').expandedCollections, ['travel', 'work', 'home'], 'toggling builds on the other tab’s list');
  prefs.touchCollection('reading');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(values['still.ui.recent.v1'], { recentCollections: ['reading'], pinnedMenu: ['x'] });
  assert.deepEqual(stored('still.ui.v1').recentCollections, ['reading']);
});

test('prefs ask for durable storage once per page and ignore a refusal', async t => {
  const previous = navigator.storage;
  t.after(() => { if (previous === undefined) delete navigator.storage; else navigator.storage = previous; });
  let calls = 0;
  navigator.storage = { persisted: async () => false, persist: async () => { calls++; return true; } };
  const granted = await freshModule('../extension/ui/prefs.js', 'durable-granted');
  assert.equal(await granted.requestDurableStorage(), true);
  assert.equal(await granted.requestDurableStorage(), true);
  assert.equal(calls, 1, 'asked once, at page load');
  navigator.storage = { persist: async () => { calls++; throw new Error('denied'); } };
  const refused = await freshModule('../extension/ui/prefs.js', 'durable-refused');
  assert.equal(await refused.requestDurableStorage(), false);
  assert.equal(calls, 2);
  delete navigator.storage;
  const missing = await freshModule('../extension/ui/prefs.js', 'durable-missing');
  assert.equal(await missing.requestDurableStorage(), false);
});
