import test from 'node:test';
import assert from 'node:assert/strict';

// Pages reach the store through { type: 'still:store', operation, args } messages to the service worker. The page side
// is checked first (the store module in an extension page), then the worker's own handler (background.js).
const events = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); }, removeListener(listener) { this.listeners = this.listeners.filter(l => l !== listener); } });
const at = '2026-01-01T00:00:00.000Z';
const values = {
  'still.library.v1': { schemaVersion: 1, settings: {}, updatedAt: at, collections: [{ id: 'work', name: 'Work', createdAt: at, updatedAt: at }], items: [
    { id: 'parent', type: 'article', title: 'Saved article', url: 'https://example.com/a', collectionId: 'work', content: '', createdAt: at, updatedAt: at },
    { id: 'child', type: 'note', title: 'Child', content: 'Mine', futureField: 'kept', createdAt: at, updatedAt: at },
  ] },
};
const clone = value => (value === undefined ? undefined : structuredClone(value));
const sent = [];
let route = null;
globalThis.chrome = {
  runtime: { id: 'test-extension', getManifest: () => ({ version: '0.7.0' }), getURL: path => `chrome-extension://test-extension/${path}`,
    onMessage: events(), onInstalled: events(), onStartup: events(),
    // Messages cross the boundary as structured clones and come back as { ok, result | error }, like the real worker.
    sendMessage: async message => { sent.push(clone(message)); if (!route) return undefined; try { return { ok: true, result: clone(await route(clone(message))) }; } catch (error) { return { ok: false, error: error.message }; } } },
  storage: {
    local: {
      get: async keys => Object.fromEntries((keys === null || keys === undefined ? Object.keys(values) : [keys].flat()).filter(key => key in values).map(key => [key, clone(values[key])])),
      set: async patch => { Object.assign(values, clone(patch)); },
      remove: async keys => { for (const key of [keys].flat()) delete values[key]; },
    },
    onChanged: events(),
  },
  contextMenus: { removeAll: async () => {}, create: () => {}, remove: async () => {}, onClicked: events() },
  tabs: { query: async () => [], create: async tab => tab },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  sidePanel: { open: async () => {}, setPanelBehavior: async () => {} },
  alarms: { getAll: async () => [], create: async () => {}, clear: async () => true, onAlarm: events() },
  commands: { onCommand: events() },
  notifications: { create: async () => {}, clear: async () => {}, onClicked: events() },
  permissions: { contains: async () => false, onAdded: events(), onRemoved: events() },
};
const store = await import('../extension/lib/store.js');
const library = () => values['still.library.v1'];
const item = id => library().items.find(entry => entry.id === id);

test('the page-side wrappers send movePage and upsertContentSection to the worker with their arguments', async () => {
  route = message => {
    assert.equal(message.type, 'still:store');
    return store.handleStoreOperation(message.operation, message.args);
  };
  const moved = await store.movePage('child', { parentId: 'parent' });
  assert.deepEqual(sent.at(-1), { type: 'still:store', operation: 'movePage', args: ['child', { parentId: 'parent' }] });
  assert.equal(moved.parentId, 'parent');
  assert.equal(moved.collectionId, 'work');
  const written = await store.upsertContentSection('parent', { next: '## Research\n\nFound' });
  assert.deepEqual(sent.at(-1).args, ['parent', { next: '## Research\n\nFound' }]);
  assert.equal(written.replaced, false);
  assert.equal(item('parent').content, '## Research\n\nFound');
  await assert.rejects(store.movePage('parent', { parentId: 'child' }), /Only notes/);
  route = null;
});

test('the worker runs the subpage operations and cascades for extension pages', async () => {
  const { handleMessage } = await import('../extension/background.js');
  const self = { id: chrome.runtime.id };
  const call = (operation, ...args) => handleMessage({ type: 'still:store', operation, args }, self);
  const sub = await call('saveItem', { type: 'note', title: 'Grandchild', parentId: 'child' });
  assert.equal(sub.collectionId, 'work');
  const trashed = await call('deleteItem', 'parent');
  assert.equal(item('child').deletedAt, trashed.deletedAt);
  assert.equal(item(sub.id).deletedAt, trashed.deletedAt);
  await call('bulkUpdateItems', [{ id: 'parent', patch: { deletedAt: null } }]);
  assert.equal(item(sub.id).deletedAt, null);
  const moved = await call('movePage', 'child', { parentId: '', expectedUpdatedAt: item('child').updatedAt });
  assert.equal(moved.parentId, '');
  assert.equal(item('child').futureField, 'kept', 'fields from another build survive');
  const section = await call('upsertContentSection', 'child', { previous: 'Mine', next: 'Mine, revised' });
  assert.equal(section.replaced, true);
  const removed = await call('permanentlyDeleteItem', 'child');
  assert.deepEqual(removed.ids, ['child']);
  assert.equal(item(sub.id).parentId, '', 'its subpage moved up to the top level');
  await assert.rejects(handleMessage({ type: 'still:store', operation: 'movePage', args: [sub.id, { parentId: sub.id }] }, self), /inside itself/);
  await assert.rejects(handleMessage({ type: 'still:store', operation: 'movePage', args: [sub.id, {}] }, { id: 'another-extension' }), /Untrusted/);
});
