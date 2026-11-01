import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryStore, normalizeItem, normalizeSticky, mergeImportedSettings, TOMBSTONE_LIMIT } from '../extension/lib/store.js';
import { LIBRARY_SCHEMA_VERSION, NEWER_LIBRARY_MESSAGE, libraryVersion, migrateLibrary } from '../extension/lib/storage/migrations.js';

function fixture(initial = null, options = {}) {
  let value = initial ? structuredClone(initial) : null, writes = 0;
  const commits = [];
  const store = createLibraryStore({ read: async () => (value ? structuredClone(value) : null),
    write: async state => { writes++; value = structuredClone(state); }, onCommit: change => { commits.push(change); }, ...options });
  return { store, commits, call: (name, ...args) => store.dispatch(name, args), get value() { return value; }, get writes() { return writes; } };
}
const at = minutes => new Date(Date.UTC(2025, 0, 1, 0, minutes)).toISOString();

test('editing a record keeps fields this build does not know (items, highlights, stickies, collections)', async () => {
  const h = fixture({ schemaVersion: 1, settings: {}, collections: [{ id: 'c', name: 'Old', color: '#123456', futureCollectionField: { order: 'k1' }, createdAt: at(0), updatedAt: at(0) }],
    items: [{ id: 'n', type: 'note', title: 'Note', content: 'Body', futureField: 'kept', nested: { a: [1, 2] }, collectionId: 'c', createdAt: at(0), updatedAt: at(0),
      highlights: [{ id: 'h1', text: 'Quote', futureHighlight: 'yes', createdAt: at(0) }], sticky: { color: 'blue', layer: 'top' } }] });
  const edited = await h.call('updateItem', 'n', { title: 'Renamed', transient: 'ui-only', highlights: [{ id: 'h1', text: 'Quote', note: 'Mine' }, { id: 'h2', text: 'New', junk: 1 }] });
  assert.equal(edited.title, 'Renamed');
  assert.equal(edited.futureField, 'kept');
  assert.deepEqual(edited.nested, { a: [1, 2] });
  assert.equal(edited.transient, undefined, 'unknown keys that only arrive with a patch are dropped');
  assert.equal(edited.highlights[0].futureHighlight, 'yes');
  assert.equal(edited.highlights[0].note, 'Mine');
  assert.equal(edited.highlights[1].junk, undefined);
  assert.equal(edited.sticky.layer, 'top');
  const moved = await h.call('updateItem', 'n', { sticky: { x: 0.2 } });
  assert.equal(moved.sticky.layer, 'top');
  assert.equal(moved.sticky.x, 0.2);
  assert.equal((await h.call('updateItem', 'n', { sticky: null })).sticky, null);
  const renamed = await h.call('updateCollection', 'c', { name: 'New', uiOnly: true });
  assert.deepEqual(renamed.futureCollectionField, { order: 'k1' });
  assert.equal(renamed.uiOnly, undefined);
  const stored = h.value.items[0];
  assert.equal(stored.futureField, 'kept');
  // A known field can still be changed or cleared normally and prototype keys are never copied.
  const proto = normalizeItem({ title: 'x' }, JSON.parse('{"id":"p","type":"note","__proto__":{"polluted":true},"constructor":"x"}'));
  assert.equal(proto.polluted, undefined);
  assert.equal(Object.hasOwn(proto, 'constructor'), false);
  assert.deepEqual(normalizeSticky({ color: 'pink', extra: 1 }), { ...normalizeSticky({ color: 'pink' }) });
});

test('collections pass an optional deletedAt through and leave it out when unset', async () => {
  const h = fixture();
  const plain = await h.call('createCollection', { name: 'Plain' });
  assert.equal(Object.hasOwn(plain, 'deletedAt'), false);
  const removed = await h.call('updateCollection', plain.id, { deletedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(removed.deletedAt, '2026-01-01T00:00:00.000Z');
  const back = await h.call('updateCollection', plain.id, { deletedAt: null });
  assert.equal(Object.hasOwn(back, 'deletedAt'), false);
});

test('seed and import keep unknown record keys and valid timestamps from the file', async () => {
  const h = fixture();
  await h.call('loadLibrary', { schemaVersion: 1, settings: {}, collections: [{ id: 'c', name: 'C', createdAt: at(1), updatedAt: at(2), extra: 'c-extra' }],
    items: [{ id: 'i', type: 'note', title: 'I', createdAt: at(3), updatedAt: at(4), extra: 'i-extra', highlights: [{ id: 'h', text: 'T', extra: 'h-extra' }], sticky: { color: 'green', extra: 's-extra' } }] });
  const item = h.value.items[0], collection = h.value.collections[0];
  assert.equal(item.updatedAt, at(4));
  assert.equal(item.createdAt, at(3));
  assert.equal(item.extra, 'i-extra');
  assert.equal(item.highlights[0].extra, 'h-extra');
  assert.equal(item.sticky.extra, 's-extra');
  assert.equal(collection.updatedAt, at(2));
  assert.equal(collection.extra, 'c-extra');
  // A restored reminder that was already delivered is not announced again.
  await h.call('importLibrary', { items: [{ id: 'r', type: 'note', reminderAt: '2020-01-01T00:00:00.000Z', reminderNotifiedAt: '2020-01-01T00:00:05.000Z' }], collections: [] });
  assert.equal(h.value.items.find(i => i.id === 'r').reminderNotifiedAt, '2020-01-01T00:00:05.000Z');
  // Stamps from the future are clamped; unparseable ones are replaced by now.
  await h.call('importLibrary', { items: [{ id: 'future', type: 'note', updatedAt: '2999-01-01T00:00:00Z' }, { id: 'bad', type: 'note', updatedAt: 'yesterday' }], collections: [] });
  for (const id of ['future', 'bad']) assert.ok(Date.parse(h.value.items.find(i => i.id === id).updatedAt) <= Date.now(), id);
});

test('a library saved by a newer schema is never written: every operation refuses and storage is unchanged', async () => {
  const stored = { schemaVersion: LIBRARY_SCHEMA_VERSION + 1, items: [{ id: 'x', type: 'hologram', title: 'From the future' }], collections: [], settings: {}, updatedAt: at(0) };
  const h = fixture(stored);
  for (const [name, ...args] of [['loadLibrary'], ['exportLibrary'], ['saveItem', { type: 'note', title: 'New' }], ['updateItem', 'x', { title: 'Y' }],
    ['updateSettings', { theme: 'dark' }], ['importLibrary', { items: [], collections: [] }], ['emptyTrash'], ['createCollection', { name: 'C' }]]) {
    await assert.rejects(h.call(name, ...args), error => error.name === 'NewerLibraryError' && error.message === NEWER_LIBRARY_MESSAGE, name);
  }
  assert.equal(h.writes, 0);
  assert.deepEqual(h.value, stored);
  assert.equal(h.commits.length, 0);
  assert.match(NEWER_LIBRARY_MESSAGE, /newer version of Still.*Update Still to keep editing.*nothing was changed/);
  // A version that cannot be read as a number is treated the same way; a missing one is the original schema 1.
  assert.equal(libraryVersion({ schemaVersion: 'v9' }), Infinity);
  assert.equal(libraryVersion({}), 1);
  const corrupt = fixture({ items: 'nope', collections: [] });
  await assert.rejects(corrupt.call('saveItem', { type: 'note' }), /unreadable/);
  assert.equal(corrupt.writes, 0);
});

test('an older library is migrated after the before-migration hook, then written once', async () => {
  const events = [];
  const migrations = [{ version: 2, migrate: state => { events.push('migrate'); state.items = state.items.map(item => ({ ...item, title: `${item.title} (v2)` })); return state; } }];
  const h = fixture({ schemaVersion: 1, items: [{ id: 'a', type: 'note', title: 'A', updatedAt: at(0) }], collections: [], settings: {}, updatedAt: at(0) },
    { migrations, schemaVersion: 2, beforeMigration: async info => { events.push(['snapshot', info.from, info.to, info.operation]); } });
  const state = await h.call('loadLibrary');
  assert.deepEqual(events, [['snapshot', 1, 2, 'loadLibrary'], 'migrate']);
  assert.equal(state.schemaVersion, 2);
  assert.equal(h.value.schemaVersion, 2);
  assert.equal(h.value.items[0].title, 'A (v2)');
  assert.equal(h.writes, 1);
  assert.deepEqual(h.commits[0].changed.items, ['a'], 'a migration reports every record as changed');
  await h.call('loadLibrary');
  assert.equal(events.length, 2, 'a migrated library is not migrated again');
  assert.equal(h.writes, 1);
  // A newer file is refused on import; an older one is migrated on the way in.
  await assert.rejects(h.call('importLibrary', { schemaVersion: 3, items: [], collections: [] }), /saved by a newer version of Still/);
  await h.call('importLibrary', { schemaVersion: 1, items: [{ id: 'b', type: 'note', title: 'B' }], collections: [] });
  assert.equal(h.value.items.find(i => i.id === 'b').title, 'B (v2)');
});

test('a failing before-migration snapshot leaves the stored library untouched', async () => {
  const stored = { schemaVersion: 1, items: [], collections: [], settings: {}, updatedAt: at(0) };
  const h = fixture(stored, { migrations: [{ version: 2, migrate: state => state }], schemaVersion: 2, beforeMigration: async () => { throw new Error('disk full'); } });
  await assert.rejects(h.call('saveItem', { type: 'note', title: 'X' }), /safety snapshot.*nothing was changed.*disk full/);
  assert.equal(h.writes, 0);
  assert.deepEqual(h.value, stored);
  assert.throws(() => migrateLibrary({ schemaVersion: 1, items: [], collections: [] }, { migrations: [], target: 2 }), /cannot upgrade/);
  assert.throws(() => migrateLibrary({ schemaVersion: 1, items: [], collections: [] }, { migrations: [{ version: 2, migrate: () => null }], target: 2 }), /invalid library/);
});

test('hard deletes leave tombstones that re-creating the same id removes', async () => {
  const h = fixture();
  const keep = await h.call('saveItem', { type: 'note', title: 'Keep' });
  const gone = await h.call('saveItem', { type: 'note', title: 'Gone', relatedIds: [keep.id] });
  await h.call('updateItem', keep.id, { relatedIds: [gone.id] });
  await h.call('permanentlyDeleteItem', gone.id);
  assert.deepEqual(h.value.tombstones.map(t => [t.kind, t.id]), [['item', gone.id]]);
  assert.ok(Date.parse(h.value.tombstones[0].deletedAt));
  const trashed = await h.call('saveItem', { type: 'note', title: 'Trash me' });
  await h.call('deleteItem', trashed.id);
  await h.call('emptyTrash');
  const collection = await h.call('createCollection', { name: 'Doomed' });
  await h.call('deleteCollection', collection.id);
  assert.deepEqual(h.value.tombstones.map(t => [t.kind, t.id]), [['item', gone.id], ['item', trashed.id], ['collection', collection.id]]);
  await h.call('saveItem', { id: gone.id, type: 'note', title: 'Undone' });
  await h.call('createCollection', { id: collection.id, name: 'Doomed again' });
  assert.deepEqual(h.value.tombstones.map(t => t.id), [trashed.id]);
});

test('tombstones keep only the newest entries', async () => {
  const many = Array.from({ length: TOMBSTONE_LIMIT }, (_, n) => ({ kind: 'item', id: `old-${n}`, deletedAt: at(0) }));
  const h = fixture({ schemaVersion: 1, items: [{ id: 'last', type: 'note', title: 'Last' }], collections: [], settings: {}, tombstones: many, updatedAt: at(0) });
  await h.call('permanentlyDeleteItem', 'last');
  assert.equal(h.value.tombstones.length, TOMBSTONE_LIMIT);
  assert.equal(h.value.tombstones.at(-1).id, 'last');
  assert.equal(h.value.tombstones[0].id, 'old-1');
});

test('import merges by id: the newer updatedAt wins, newer local edits are kept and the result reports it', async () => {
  const h = fixture({ schemaVersion: 1, settings: { theme: 'dark' }, updatedAt: at(0), collections: [{ id: 'local', name: 'Local', updatedAt: at(10) }],
    items: [
      { id: 'mine-newer', type: 'note', title: 'Local edit', updatedAt: at(50) },
      { id: 'file-newer', type: 'note', title: 'Old local', updatedAt: at(10) },
      { id: 'same', type: 'note', title: 'Local twin', updatedAt: at(20) },
    ] });
  const result = await h.call('importLibrary', { schemaVersion: 1, collections: [{ id: 'fresh', name: 'Fresh', updatedAt: at(5) }], settings: { theme: 'light' }, items: [
    { id: 'mine-newer', type: 'note', title: 'Backup copy', updatedAt: at(40) },
    { id: 'file-newer', type: 'note', title: 'Backup edit', updatedAt: at(30) },
    { id: 'same', type: 'note', title: 'File twin', updatedAt: at(20) },
    { id: 'added', type: 'note', title: 'Added', collectionId: 'local', updatedAt: at(1) },
  ] });
  const byId = Object.fromEntries(h.value.items.map(i => [i.id, i]));
  assert.equal(byId['mine-newer'].title, 'Local edit');
  assert.equal(byId['file-newer'].title, 'Backup edit');
  assert.equal(byId['file-newer'].updatedAt, at(30), 'the imported record keeps its own timestamp');
  assert.equal(byId.same.title, 'Local twin', 'a tie keeps the local copy');
  assert.equal(byId.added.collectionId, 'local', 'imported items may point at a collection that is already in the library');
  assert.equal(h.value.settings.theme, 'dark', 'settings are only merged when asked for');
  assert.deepEqual(result.importSummary.items, { added: 1, updated: 1, kept: 2, tombstoned: 0 });
  assert.deepEqual(result.importSummary.collections, { added: 1, updated: 0, kept: 0, tombstoned: 0 });
  assert.deepEqual(result.importSummary.skippedItemIds.sort(), ['mine-newer', 'same']);
  assert.equal(result.importSummary.settings, false);
  assert.ok(Array.isArray(result.items), 'the result is still the library');
  assert.equal(h.value.importSummary, undefined, 'the summary is not stored');
});

test('import never resurrects a record deleted after the file copy was edited', async () => {
  const h = fixture();
  const item = await h.call('saveItem', { type: 'note', title: 'Deleted here' });
  const collection = await h.call('createCollection', { name: 'Deleted collection' });
  const backup = structuredClone(h.value);
  await h.call('permanentlyDeleteItem', item.id);
  await h.call('deleteCollection', collection.id);
  const result = await h.call('importLibrary', backup);
  assert.equal(h.value.items.some(i => i.id === item.id), false);
  assert.equal(h.value.collections.some(c => c.id === collection.id), false);
  assert.equal(result.importSummary.items.tombstoned, 1);
  assert.equal(result.importSummary.collections.tombstoned, 1);
  // A copy edited after the deletion comes back and clears the tombstone.
  await new Promise(resolve => setTimeout(resolve, 5));
  const later = { ...backup.items[0], title: 'Edited elsewhere later', updatedAt: new Date().toISOString() };
  await h.call('importLibrary', { items: [later], collections: [] });
  assert.equal(h.value.items.find(i => i.id === item.id).title, 'Edited elsewhere later');
  assert.equal(h.value.tombstones.some(t => t.id === item.id), false);
});

test('import repairs references to skipped collections and cross-file parent cycles', async () => {
  const h = fixture({ schemaVersion: 1, settings: {}, updatedAt: at(0), items: [], collections: [
    { id: 'a', name: 'A', parentId: 'b', updatedAt: at(50) }, { id: 'b', name: 'B', parentId: '', updatedAt: at(1) }] });
  await h.call('importLibrary', { collections: [{ id: 'b', name: 'B', parentId: 'a', updatedAt: at(60) }], items: [] });
  const byId = Object.fromEntries(h.value.collections.map(c => [c.id, c]));
  assert.ok(byId.a.parentId === '' || byId.b.parentId === '', 'the cycle is broken');
});

test('import with { settings: true } merges non-secret settings and keeps local secrets', async () => {
  const h = fixture({ schemaVersion: 1, items: [], collections: [], updatedAt: at(0),
    settings: { theme: 'dark', githubToken: 'local-token', newTab: { clock: true, apiKey: 'local-key' }, density: 'compact' } });
  const result = await h.call('importLibrary', { items: [], collections: [], settings: { theme: 'light', githubToken: 'evil', newTab: { clock: false, weather: true, apiKey: 'evil' },
    integrationUrl: 'x', accent: 'green', extras: [{ password: 'p', label: 'ok' }] } }, { settings: true });
  assert.deepEqual(h.value.settings, { theme: 'light', githubToken: 'local-token', newTab: { clock: false, weather: true, apiKey: 'local-key' }, density: 'compact',
    accent: 'green', extras: [{ label: 'ok' }] });
  assert.equal(result.importSummary.settings, true);
  assert.deepEqual(mergeImportedSettings({ bridgeUrl: 'keep' }, { bridgeUrl: 'drop', theme: 'x' }), { bridgeUrl: 'keep', theme: 'x' });
});

test('onCommit reports what each write changed and deleted, and never fails the write', async () => {
  const h = fixture();
  const collection = await h.call('createCollection', { name: 'C' });
  const a = await h.call('saveItem', { type: 'note', title: 'A', collectionId: collection.id });
  const b = await h.call('saveItem', { type: 'note', title: 'B', relatedIds: [a.id] });
  await h.call('updateSettings', { theme: 'dark' });
  await h.call('permanentlyDeleteItem', a.id);
  await h.call('deleteCollection', collection.id);
  await assert.rejects(h.call('updateItem', 'missing', { title: 'x' }));
  const [create, saveA, saveB, settings, purge, dropCollection] = h.commits;
  assert.equal(h.commits.length, 6, 'a failed operation reports nothing');
  assert.deepEqual(create, { operation: 'createCollection', changed: { items: [], collections: [collection.id], settings: false }, deleted: { items: [], collections: [] }, updatedAt: create.updatedAt });
  assert.deepEqual(saveA.changed.items, [a.id]);
  assert.deepEqual(saveB.changed.items, [b.id]);
  assert.deepEqual(settings.changed, { items: [], collections: [], settings: true });
  assert.deepEqual(purge.deleted.items, [a.id]);
  assert.deepEqual(purge.changed.items, [b.id], 'the backlink clean-up is reported');
  assert.deepEqual(dropCollection.deleted.collections, [collection.id]);
  assert.equal(dropCollection.updatedAt, h.value.updatedAt);
  // A throwing or rejecting hook is logged, not surfaced.
  const warn = console.warn; console.warn = () => {};
  try {
    const sync = fixture(null, { onCommit: () => { throw new Error('sync down'); } });
    assert.equal((await sync.call('saveItem', { type: 'note', title: 'Still saved' })).title, 'Still saved');
    const async = fixture(null, { onCommit: async () => { throw new Error('sync down'); } });
    await async.call('saveItem', { type: 'note', title: 'Saved too' });
    assert.equal(async.value.items.length, 1);
  } finally { console.warn = warn; }
});

test('every operation waits for the ready gate and exclusive tasks run alone in the queue', async () => {
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  const order = [];
  const h = fixture(null, { ready: () => gate });
  const saving = h.call('saveItem', { type: 'note', title: 'Waits' }).then(() => order.push('save'));
  const exclusive = h.store.exclusive(async () => { order.push('exclusive'); return 'done'; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(order, []);
  assert.equal(h.writes, 0);
  open();
  assert.equal(await exclusive, 'done');
  await saving;
  assert.deepEqual(order, ['save', 'exclusive']);
  // A gate that fails never blocks the library.
  const broken = fixture(null, { ready: async () => { throw new Error('snapshot failed'); } });
  assert.equal((await broken.call('saveItem', { type: 'note', title: 'Works' })).title, 'Works');
});

test('an imported record without a saved stamp counts as oldest: it never overwrites a local edit or undoes a deletion', async () => {
  const h = fixture({ schemaVersion: 1, settings: {}, collections: [], items: [
    { id: 'edited', type: 'note', title: 'Signed', content: 'x', createdAt: at(0), updatedAt: at(5) },
    { id: 'gone', type: 'note', title: 'Gone', content: 'x', createdAt: at(0), updatedAt: at(1) }] });
  await h.call('permanentlyDeleteItem', 'gone');
  const result = await h.call('importLibrary', { schemaVersion: 1, collections: [], items: [
    { id: 'edited', type: 'note', title: 'Draft', content: 'x', createdAt: at(0) },
    { id: 'gone', type: 'note', title: 'Gone', content: 'x', createdAt: at(0) },
    { id: 'fresh', type: 'note', title: 'Fresh', content: 'x', createdAt: at(0) }] });
  assert.equal(h.value.items.find(item => item.id === 'edited').title, 'Signed');
  assert.ok(!h.value.items.some(item => item.id === 'gone'), 'stays deleted');
  assert.ok(h.value.items.some(item => item.id === 'fresh'), 'new records still come in');
  assert.deepEqual(result.importSummary.items, { added: 1, updated: 0, kept: 1, tombstoned: 1 });
});
