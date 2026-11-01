import test from 'node:test';
import assert from 'node:assert/strict';

// The service worker as installed over an existing library from a build without snapshots (no still.meta.v1 yet).
const events = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); }, removeListener(listener) { this.listeners = this.listeners.filter(l => l !== listener); } });
const values = {
  'still.library.v1': { schemaVersion: 1, settings: {}, updatedAt: '2025-01-01T00:00:00.000Z', collections: [],
    items: [{ id: 'kept', type: 'note', title: 'Written before the update', content: 'Mine', futureField: 'from 0.5', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' }] },
  'still.dashboard.v1': { version: 1, boards: [{ id: 'main', widgets: [] }] },
};
const alarms = new Map();
const notified = [];
const storageEvents = events();
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
const chrome = {
  runtime: { id: 'test-extension', getManifest: () => ({ version: '0.6.0' }), getURL: path => `chrome-extension://test-extension/${path}`,
    onMessage: events(), onInstalled: events(), onStartup: events(), sendMessage: async () => undefined },
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
  notifications: { create: async id => { notified.push(id); }, clear: async () => {}, onClicked: events() },
  permissions: { contains: async () => false, onAdded: events(), onRemoved: events() },
};
globalThis.chrome = chrome;
const { handleMessage, handleAlarm, MESSAGE_TYPES } = await import('../extension/background.js');
const self = { id: chrome.runtime.id };
const store = (operation, ...args) => handleMessage({ type: 'still:store', operation, args }, self);
const snapshots = (op, ...args) => handleMessage({ type: 'still:snapshots', op, args }, self);
// Sent synchronously after the worker starts: the gate must snapshot before this write is served.
const firstWrite = store('saveItem', { type: 'note', title: 'Written right after the update' });
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('the update gate snapshots existing data before the first library operation is served', async () => {
  const saved = await firstWrite;
  const [update] = await snapshots('list');
  assert.equal(update.reason, 'update');
  assert.equal(update.extensionVersion, '0.6.0');
  assert.equal(update.counts.items, 1, 'the snapshot holds the library as it was before the first write');
  assert.equal(update.counts.boards, 1);
  assert.equal(values['still.meta.v1'].lastVersion, '0.6.0');
  assert.ok(values['still.meta.v1'].deviceId);
  assert.ok(values['still.library.v1'].items.some(item => item.id === saved.id));
  assert.ok(MESSAGE_TYPES.includes('still:snapshots'));
  // onInstalled reports the version this update came from; it is added to the gate's snapshot.
  for (const listener of chrome.runtime.onInstalled.listeners) listener({ reason: 'update', previousVersion: '0.5.0' });
  await settle();
  assert.equal((await snapshots('list'))[0].previousVersion, '0.5.0');
});

test('edits from this build keep fields an older or newer build wrote', async () => {
  const edited = await store('updateItem', 'kept', { title: 'Edited after the update' });
  assert.equal(edited.futureField, 'from 0.5');
  assert.equal(values['still.library.v1'].items.find(item => item.id === 'kept').futureField, 'from 0.5');
});

test('the daily alarm exists once and snapshots only when data changed since the last snapshot', async () => {
  assert.deepEqual(alarms.get('still:snapshot-daily'), { name: 'still:snapshot-daily', periodInMinutes: 1440 });
  const before = (await snapshots('list')).length;
  await handleAlarm({ name: 'still:snapshot-daily' });
  const afterChange = await snapshots('list');
  assert.equal(afterChange.length, before + 1, 'library writes since the update snapshot make the daily snapshot due');
  assert.equal(afterChange[0].reason, 'daily');
  await handleAlarm({ name: 'still:snapshot-daily' });
  assert.equal((await snapshots('list')).length, before + 1, 'nothing changed: no new snapshot');
  // A change to another Still key (the dashboard writes from pages) also makes it due.
  await chrome.storage.local.set({ 'still.dashboard.v1': { version: 1, boards: [{ id: 'main', widgets: [{ id: 'w' }] }] } });
  await settle();
  await handleAlarm({ name: 'still:snapshot-daily' });
  assert.equal((await snapshots('list')).length, before + 2);
});

test('pages can take, restore and delete snapshots through the worker', async () => {
  const manual = await snapshots('create', 'manual');
  await store('saveItem', { type: 'note', title: 'Made after the manual snapshot' });
  await chrome.storage.local.set({ 'still.ai.v2': { version: 2, connections: [] } });
  const result = await snapshots('restore', manual.id);
  assert.equal(result.restored, true);
  assert.equal(values['still.library.v1'].items.some(item => item.title === 'Made after the manual snapshot'), false);
  assert.equal('still.ai.v2' in values, false);
  const listed = await snapshots('list');
  assert.equal(listed.find(s => s.id === result.safetySnapshotId).reason, 'before-restore');
  assert.deepEqual(await snapshots('delete', manual.id), { deleted: true });
  await assert.rejects(snapshots('create', 'update'), /Unknown snapshot reason/);
  await assert.rejects(handleMessage({ type: 'still:snapshots', op: 'list', args: [] }, { id: 'other-extension' }), /Untrusted/);
});

test('a library from a newer schema is refused by the worker and left untouched', async () => {
  const newer = { schemaVersion: 99, items: [{ id: 'z', type: 'note', title: 'From the future' }], collections: [], settings: {} };
  values['still.library.v1'] = structuredClone(newer);
  await assert.rejects(store('saveItem', { type: 'note', title: 'Nope' }), /newer version of Still/);
  await assert.rejects(store('loadLibrary'), /newer version of Still/);
  // A due reminder in that library is not announced: this build could not record it and would repeat it.
  values['still.library.v1'].items[0].reminderAt = '2020-01-01T00:00:00.000Z';
  await handleAlarm({ name: 'still:reminder:z' });
  assert.equal(notified.length, 0);
  values['still.library.v1'] = structuredClone(newer);
  assert.deepEqual(values['still.library.v1'], newer);
});

test('a reminder alarm with no saved library reads storage and never seeds an empty one', async () => {
  delete values['still.library.v1'];
  await handleAlarm({ name: 'still:reminder:missing' });
  assert.equal('still.library.v1' in values, false);
});
