import test from 'node:test';
import assert from 'node:assert/strict';

// The real service worker with the Threadkeeper link wired in: external listener, page proxy, alarms.
const TK = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const events = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); }, removeListener(listener) { this.listeners = this.listeners.filter(l => l !== listener); } });
const values = {
  'still.library.v1': { schemaVersion: 1, settings: {}, updatedAt: '2026-01-01T00:00:00.000Z', items: [],
    collections: [{ id: 'c1', name: 'Research', parentId: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'c2', name: 'Agents', parentId: 'c1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] },
  'still.threadkeeper.v1': { version: 1, status: 'paired', extensionId: TK, epoch: 'epoch-0001', configured: true, tk: { version: '1.0', capabilities: ['sync'] } },
};
const storageEvents = events();
const alarms = new Map();
const outgoing = [];
const clone = value => (value === undefined ? undefined : structuredClone(value));
const keysOf = keys => (keys === null || keys === undefined ? Object.keys(values) : [keys].flat());
const change = mutate => {
  const before = clone(values);
  mutate();
  const changes = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(values)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(values[key])) changes[key] = { oldValue: before[key], newValue: clone(values[key]) };
  }
  if (Object.keys(changes).length) for (const listener of storageEvents.listeners) listener(changes, 'local');
};
const SELF = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const runtime = {
  id: SELF, getManifest: () => ({ version: '0.4.0' }), getURL: path => `chrome-extension://${SELF}/${path}`,
  onMessage: events(), onMessageExternal: events(), onInstalled: events(), onStartup: events(), lastError: undefined,
  sendMessage(...args) {
    if (typeof args[0] !== 'string') return Promise.resolve(undefined);   // broadcasts to pages
    const [to, message, callback] = args;
    outgoing.push({ to, message });
    setTimeout(() => callback(message.type === 'hello' ? { ok: true, proto: 'still-threadkeeper/1', app: 'threadkeeper', version: '1.1', paired: true, tk: { version: '1.1', capabilities: ['sync', 'search'] } }
      : { ok: true, proto: 'still-threadkeeper/1' }), 0);
  },
};
globalThis.chrome = {
  runtime,
  storage: {
    local: {
      get: async keys => Object.fromEntries(keysOf(keys).filter(key => key in values).map(key => [key, clone(values[key])])),
      set: async patch => change(() => Object.assign(values, structuredClone(patch))),
      remove: async keys => change(() => { for (const key of [keys].flat()) delete values[key]; }),
    },
    onChanged: storageEvents,
  },
  contextMenus: { removeAll: async () => {}, create: () => {}, remove: async () => {}, onClicked: events() },
  tabs: { query: async () => [], create: async tab => tab },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  sidePanel: { open: async () => {}, setPanelBehavior: async () => {} },
  alarms: { getAll: async () => [...alarms.values()], create: async (name, options) => { alarms.set(name, { name, ...options }); }, clear: async name => alarms.delete(name), onAlarm: events() },
  commands: { onCommand: events() },
  notifications: { create: async () => {}, clear: async () => {}, onClicked: events() },
  permissions: { contains: async () => false, onAdded: events(), onRemoved: events() },
};
const { handleMessage, handleAlarm, MESSAGE_TYPES, handleExternalMessage } = await import('../extension/background.js');
const self = { id: runtime.id, url: `chrome-extension://${runtime.id}/index.html` };
const envelope = (type, fields = {}) => ({ proto: 'still-threadkeeper/1', from: 'threadkeeper', type, requestId: 'r1', ...fields });
const external = (message, sender) => new Promise(resolve => {
  const [listener] = runtime.onMessageExternal.listeners;
  const kept = listener(message, sender, resolve);
  assert.equal(kept, true, 'the listener answers asynchronously');
});

test('the external listener is registered and answers with flat protocol envelopes', async () => {
  assert.equal(runtime.onMessageExternal.listeners.length, 1);
  const hello = await external(envelope('hello'), { id: TK, url: `chrome-extension://${TK}/background.js` });
  assert.deepEqual(hello, { app: 'still', version: '0.4.0', paired: true, epoch: 'epoch-0001', ok: true, proto: 'still-threadkeeper/1' });
  const list = await external(envelope('collections.list'), { id: TK, origin: `chrome-extension://${TK}` });
  assert.equal(list.ok, true);
  assert.deepEqual(list.collections.map(c => c.path), ['Research', 'Research / Agents']);
});

test('spoofed senders never reach the library or the store operations', async () => {
  const before = JSON.stringify(values['still.library.v1']);
  const attempts = [
    [envelope('threads.remove', { threadKeys: ['k'], reason: 'deleted' }), { id: OTHER, url: `chrome-extension://${OTHER}/x.html` }],
    [envelope('threads.remove', { threadKeys: ['k'], reason: 'deleted' }), { id: TK, url: 'https://chatgpt.com/c/1', tab: { id: 2 } }],
    [{ type: 'still:store', operation: 'emptyTrash', args: [] }, { id: TK, url: `chrome-extension://${TK}/x.html` }],
    [envelope('still:store', { operation: 'saveItem', args: [{ type: 'note' }] }), { id: TK, url: `chrome-extension://${TK}/x.html` }],
    [envelope('collections.list'), { id: runtime.id, url: `chrome-extension://${runtime.id}/index.html` }],
  ];
  const codes = [];
  for (const [message, sender] of attempts) codes.push((await external(message, sender)).error?.code);
  assert.deepEqual(codes, ['not_paired', 'not_paired', 'version_mismatch', 'unsupported', 'not_paired']);
  assert.equal(JSON.stringify(values['still.library.v1']), before);
  // The page-side router still refuses foreign extension ids.
  await assert.rejects(handleMessage({ type: 'still:threadkeeper', op: 'state' }, { id: TK }), /Untrusted/);
});

test('paired requests: remove of an unknown thread and chats.status touch nothing', async () => {
  const sender = { id: TK, url: `chrome-extension://${TK}/background.js` };
  const removed = await external(envelope('threads.remove', { threadKeys: ['chatgpt:a:b:c:main'], reason: 'deleted' }), sender);
  assert.deepEqual(removed.results, [{ threadKey: 'chatgpt:a:b:c:main', status: 'missing' }]);
  const status = await external(envelope('chats.status', { threadKeys: ['chatgpt:a:b:c:main'] }), sender);
  assert.deepEqual(status.chats, {});
  assert.equal((await handleExternalMessage(envelope('threads.upsert', { threads: 'x', origin: 'sync' }), sender)).error.code, 'bad_request');
});

test('pages reach the link through still:threadkeeper; codes survive the round trip', async () => {
  assert.ok(MESSAGE_TYPES.includes('still:threadkeeper'));
  const state = await handleMessage({ type: 'still:threadkeeper', op: 'state' }, self);
  assert.equal(state.ok, true);
  assert.equal(state.data.status, 'paired');
  assert.equal('collections' in state.data, false);
  const bad = await handleMessage({ type: 'still:threadkeeper', op: 'request', args: { type: 'threads.upsert' } }, self);
  assert.deepEqual([bad.ok, bad.error.code], [false, 'unsupported']);
  const content = { id: runtime.id, url: 'https://example.com/', tab: { id: 1 } };
  await assert.rejects(handleMessage({ type: 'still:threadkeeper', op: 'state' }, content), /Untrusted/);
});

test('alarms and startup: the sweep alarm exists, liveness hello refreshes capabilities', async () => {
  for (const listener of runtime.onStartup.listeners) listener();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(alarms.get('still:threadkeeper:sweep'), { name: 'still:threadkeeper:sweep', periodInMinutes: 1440 });
  assert.ok(outgoing.some(entry => entry.to === TK && entry.message.type === 'hello' && entry.message.epoch === 'epoch-0001'));
  assert.deepEqual(values['still.threadkeeper.v1'].tk, { version: '1.1', capabilities: ['sync', 'search'] });
  await handleAlarm({ name: 'still:threadkeeper:sweep' });
  assert.ok(outgoing.filter(entry => entry.message.type === 'hello').length >= 2);
});

test('a snapshot restore starts a new epoch and tells Threadkeeper', async () => {
  const [snapshot] = await handleMessage({ type: 'still:snapshots', op: 'list', args: [] }, self).then(list => list.length ? list : handleMessage({ type: 'still:snapshots', op: 'create', args: ['manual'] }, self).then(created => [created]));
  await handleMessage({ type: 'still:snapshots', op: 'restore', args: [snapshot.id] }, self);
  await new Promise(resolve => setTimeout(resolve, 50));
  const state = values['still.threadkeeper.v1'];
  assert.notEqual(state.epoch, 'epoch-0001');
  assert.equal(state.status, 'paired', 'the link state is not rolled back by a restore');
  const configure = outgoing.filter(entry => entry.message.type === 'sync.configure').at(-1);
  assert.equal(configure?.message.epoch, state.epoch);
});
