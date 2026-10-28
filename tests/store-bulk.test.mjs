import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryStore } from '../extension/lib/store.js';

function fixture() {
  let value;
  let writes = 0;
  const store = createLibraryStore({ read: async () => value ? structuredClone(value) : null,
    write: async state => { writes++; value = structuredClone(state); } });
  return { call: (name, ...args) => store.dispatch(name, args), writes: () => writes };
}

test('bulk updates apply many patches in one write and validate every target first', async () => {
  const { call, writes } = fixture();
  const travel = await call('createCollection', { name: 'Travel' });
  const a = await call('saveItem', { title: 'A', url: 'https://example.com/a' });
  const b = await call('saveItem', { title: 'B', url: 'https://example.com/b', tags: ['old'] });
  const before = writes();
  const updated = await call('bulkUpdateItems', [{ id: a.id, patch: { collectionId: travel.id, favorite: true } }, { id: b.id, patch: { collectionId: travel.id, tags: ['old', 'japan'] } }]);
  assert.equal(writes(), before + 1);
  assert.deepEqual(updated.map(i => i.collectionId), [travel.id, travel.id]);
  assert.deepEqual(updated[1].tags, ['old', 'japan']);
  await assert.rejects(call('bulkUpdateItems', [{ id: a.id, patch: { title: 'X' } }, { id: 'missing', patch: {} }]), /no longer exists/);
  await assert.rejects(call('bulkUpdateItems', [{ id: a.id, patch: { collectionId: 'nope' } }]), /Collection no longer exists/);
  const state = await call('loadLibrary');
  assert.equal(state.items.find(i => i.id === a.id).title, 'A', 'a failed batch changes nothing');
  await assert.rejects(call('bulkUpdateItems', [{ id: a.id, patch: { title: 'Y' } }], { expectedLibraryUpdatedAt: '2000-01-01T00:00:00.000Z' }), /Conflict/);
  await assert.rejects(call('bulkUpdateItems', []), /at least one/);
});

test('empty trash removes only trashed items, clears backlinks and reports orphaned files', async () => {
  const { call } = fixture();
  const keep = await call('saveItem', { title: 'Keep', url: 'https://example.com/keep', attachmentId: 'file_shared' });
  const gone = await call('saveItem', { title: 'Gone', url: 'https://example.com/gone', attachmentId: 'file_gone', relatedIds: [keep.id] });
  const shared = await call('saveItem', { title: 'Shared', url: 'https://example.com/shared', attachmentId: 'file_shared' });
  await call('updateItem', keep.id, { relatedIds: [gone.id] });
  await call('deleteItem', gone.id);
  await call('deleteItem', shared.id);
  const result = await call('emptyTrash');
  assert.deepEqual(new Set(result.ids), new Set([gone.id, shared.id]));
  assert.deepEqual(result.attachmentIds, ['file_gone']);
  const state = await call('loadLibrary');
  assert.deepEqual(state.items.map(i => i.id), [keep.id]);
  assert.deepEqual(state.items[0].relatedIds, []);
});

test('moving a collection reorders siblings, reparents and refuses cycles', async () => {
  const { call } = fixture();
  const a = await call('createCollection', { name: 'A' });
  const b = await call('createCollection', { name: 'B' });
  const c = await call('createCollection', { name: 'C' });
  await call('moveCollection', c.id, { beforeId: a.id });
  let state = await call('loadLibrary');
  assert.deepEqual(state.collections.map(x => x.name), ['C', 'A', 'B']);
  await call('moveCollection', b.id, { parentId: a.id });
  state = await call('loadLibrary');
  assert.equal(state.collections.find(x => x.id === b.id).parentId, a.id);
  await assert.rejects(call('moveCollection', a.id, { parentId: b.id }), /contain itself/);
  await call('moveCollection', b.id, { parentId: '' });
  state = await call('loadLibrary');
  assert.equal(state.collections.find(x => x.id === b.id).parentId, '');
});
