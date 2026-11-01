import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryStore, queryItems, safeUrl, canonicalUrl, normalizeItem } from '../extension/lib/store.js';

function fixture() {
  let value;
  const store = createLibraryStore({ read: async () => value ? structuredClone(value) : null,
    write: async state => { await new Promise(resolve => setTimeout(resolve, 1)); value = structuredClone(state); } });
  return { call: (name, ...args) => store.dispatch(name, args), store };
}

test('serializes concurrent captures and always reads the last committed state', async () => {
  const { call } = fixture();
  await Promise.all(Array.from({ length: 25 }, (_, n) => call('saveItem', { title: `Item ${n}`, url: `https://example.com/${n}` })));
  const state = await call('loadLibrary');
  assert.equal(state.items.length, 25);
  assert.equal(new Set(state.items.map(i => i.id)).size, 25);
});

test('capture deduplicates canonical URLs and preserves notes, organization and metadata', async () => {
  const { call } = fixture();
  const collection = await call('createCollection', { name: 'Research' });
  const first = await call('saveItem', { url: 'https://example.com/post?utm_source=mail#section', title: 'First', content: 'Retain this text',
    collectionId: collection.id, favorite: true, tags: ['design'], highlights: [{ text: 'A useful passage' }] });
  const next = await call('saveItem', { url: 'https://example.com/post', title: 'Updated', content: '', collectionId: '', tags: ['reading'], highlights: [{ text: 'Another passage' }] });
  assert.equal(next.id, first.id);
  assert.equal(next.content, 'Retain this text');
  assert.equal(next.collectionId, collection.id);
  assert.equal(next.favorite, true);
  assert.deepEqual(next.tags, ['design', 'reading']);
  assert.equal(next.highlights.length, 2);
  assert.equal((await call('loadLibrary')).items.length, 1);
});

test('search spans linked note content and highlights with type and tag filters', async () => {
  const { call } = fixture();
  await call('saveItem', { type: 'note', title: 'Motion thoughts', content: 'Use a spring with restrained overshoot', tags: ['Design'] });
  await call('saveItem', { url: 'https://example.com', title: 'Article', highlights: [{ text: 'Delightful spring curves' }], tags: ['Design'] });
  const state = await call('loadLibrary');
  assert.equal(queryItems(state, { query: '#design type:note spring' }).length, 1);
  assert.equal(queryItems(state, { query: '"spring curves"' }).length, 1);
  assert.equal(queryItems(state, { query: 'tag:design missing' }).length, 0);
});

test('trash is recoverable and permanent removal clears backlinks', async () => {
  const { call } = fixture();
  const source = await call('saveItem', { url: 'https://example.com', title: 'Source' });
  const note = await call('saveItem', { type: 'note', title: 'Thoughts', relatedIds: [source.id] });
  await call('deleteItem', source.id);
  let state = await call('loadLibrary');
  assert.equal(queryItems(state).length, 1);
  assert.equal(queryItems(state, { trash: true }).length, 1);
  await call('restoreItem', source.id);
  assert.equal(queryItems(await call('loadLibrary')).length, 2);
  await call('permanentlyDeleteItem', source.id);
  state = await call('loadLibrary');
  assert.deepEqual(state.items.find(i => i.id === note.id).relatedIds, []);
});

test('deleting a collection retains its items and reparents children', async () => {
  const { call } = fixture();
  const parent = await call('createCollection', { name: 'Parent' });
  const child = await call('createCollection', { name: 'Child', parentId: parent.id });
  await call('saveItem', { url: 'https://example.com', collectionId: parent.id });
  await assert.rejects(call('updateCollection', parent.id, { parentId: child.id }), /contain itself/);
  await call('deleteCollection', parent.id);
  const state = await call('loadLibrary');
  assert.equal(state.items[0].collectionId, '');
  assert.equal(state.collections[0].parentId, '');
});

test('invalid import is atomic and valid imports merge without replacing local settings', async () => {
  const { call } = fixture();
  await call('saveItem', { type: 'note', title: 'Existing' });
  await call('updateSettings', { theme: 'dark' });
  await assert.rejects(call('importLibrary', { schemaVersion: 1, items: [{ url: 'javascript:alert(1)' }], collections: [] }), /http or https/);
  assert.equal((await call('loadLibrary')).items.length, 1);
  await call('importLibrary', { schemaVersion: 1, items: [{ id: 'imported', type: 'note', title: 'Imported' }], collections: [], settings: { theme: 'light' } });
  const state = await call('loadLibrary');
  assert.equal(state.items.length, 2);
  assert.equal(state.settings.theme, 'dark');
});

test('rejects executable URLs and rearms an edited reminder', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///secret', 'https://user:pass@example.com']) assert.throws(() => safeUrl(url));
  assert.equal(canonicalUrl('https://example.com/?utm_source=a&b=1#x'), 'https://example.com/?b=1');
  const item = normalizeItem({ type: 'note', title: 'Reminder', reminderAt: '2030-01-01T00:00:00Z' });
  const updated = normalizeItem({ reminderAt: '2030-02-01T00:00:00Z' }, { ...item, reminderNotifiedAt: '2029-01-01T00:00:00Z' });
  assert.equal(updated.reminderNotifiedAt, null);
});

test('failed write is reported and subsequent mutations can recover', async () => {
  let fail = true;
  let saved;
  const store = createLibraryStore({ read: async () => saved, write: async state => { if (fail) throw new Error('Quota exceeded'); saved = state; } });
  await assert.rejects(store.dispatch('saveItem', [{ type: 'note', title: 'First' }]), /Quota/);
  fail = false;
  await store.dispatch('saveItem', [{ type: 'note', title: 'Second' }]);
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].title, 'Second');
});

test('archived items remain recoverable from Trash and cyclic import does not modify data', async () => {
  const { call } = fixture();
  const item = await call('saveItem', { type: 'note', title: 'Archived', archived: true });
  await call('deleteItem', item.id);
  assert.equal(queryItems(await call('loadLibrary'), { trash: true }).length, 1);
  await assert.rejects(call('importLibrary', { items: [], collections: [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }] }), /parent cycle/);
  assert.equal((await call('loadLibrary')).collections.length, 0);
});

test('article snapshots remain searchable and separate from editable notes', async () => {
  const { call } = fixture();
  const item = await call('saveItem', { type: 'article', title: 'A saved article', url: 'https://example.com/article', articleContent: 'Original author text about echolocation.', content: 'My own notes.' });
  const edited = await call('updateItem', item.id, { content: 'A new personal thought.' });
  assert.equal(edited.articleContent, 'Original author text about echolocation.');
  assert.equal(edited.content, 'A new personal thought.');
  assert.equal(queryItems(await call('loadLibrary'), { query: 'echolocation' }).length, 1);
  assert.equal(normalizeItem({ type: 'article', articleContent: 'a'.repeat(260000) }).articleContent.length, 250000);
});

test('imports keep the file timestamps so an older backup cannot overwrite newer local edits', async () => {
  const { call } = fixture();
  const local = await call('saveItem', { id: 'shared', type: 'note', title: 'Edited today', content: 'Newest' });
  await call('importLibrary', { schemaVersion: 1, items: [{ id: 'shared', type: 'note', title: 'From an old backup', updatedAt: '2020-01-02T00:00:00.000Z' },
    { id: 'old', type: 'note', title: 'Only in the backup', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z' }], collections: [] });
  const state = await call('loadLibrary');
  assert.equal(state.items.find(i => i.id === 'shared').title, 'Edited today');
  assert.equal(state.items.find(i => i.id === 'shared').updatedAt, local.updatedAt);
  assert.equal(state.items.find(i => i.id === 'old').updatedAt, '2020-01-02T00:00:00.000Z');
});
