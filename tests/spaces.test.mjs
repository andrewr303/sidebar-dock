import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryStore, STORAGE_KEY } from '../extension/lib/store.js';
import { buildSpaceContext, getDescendantCollectionIds, buildRelationshipGraph } from '../extension/lib/library-views.js';
import { createBridgeState, TOOLS } from '../bridge/protocol.mjs';
import { createIntegrationClient } from '../extension/lib/integrations.js';

function adapter() {
  let library = null;
  const core = createLibraryStore({ read: async () => library, write: async value => { library = value; } });
  const dispatch = (operation, ...args) => core.dispatch(operation, args);
  const store = Object.fromEntries(['loadLibrary', 'createCollection', 'updateCollection'].map(operation => [operation, (...args) => dispatch(operation, ...args)]));
  return { dispatch, store, library: () => library };
}

test('legacy collections gain metadata defaults without changing storage or item identity; patches preserve metadata and revision checks', async () => {
  const h = adapter();
  await h.dispatch('loadLibrary', { schemaVersion: 1, items: [{ id: 'note', type: 'note', title: 'Legacy note', content: 'Retained', collectionId: 'old' }], collections: [{ id: 'old', name: 'Legacy', color: '#123456', icon: 'book', parentId: '', createdAt: '2025-01-01T00:00:00Z' }] });
  const first = h.library().collections[0];
  assert.equal(STORAGE_KEY, 'still.library.v1'); assert.equal(h.library().schemaVersion, 1);
  assert.deepEqual({ description: first.description, cover: first.cover, pinned: first.pinned, layout: first.layout, sidebarLayout: first.sidebarLayout }, { description: '', cover: '', pinned: false, layout: 'grid', sidebarLayout: 'list' });
  const changed = await h.dispatch('updateCollection', 'old', { description: 'A space for connected ideas', cover: 'assets/images/cover.webp', pinned: true, layout: 'masonry', sidebarLayout: 'grid' }, { expectedUpdatedAt: first.updatedAt });
  const renamed = await h.dispatch('updateCollection', 'old', { name: 'Renamed' }, { expectedUpdatedAt: changed.updatedAt });
  for (const key of ['description', 'cover', 'pinned', 'layout', 'sidebarLayout', 'color', 'icon', 'parentId', 'createdAt']) assert.equal(renamed[key], changed[key], key);
  assert.equal(renamed.id, 'old'); assert.notEqual(renamed.updatedAt, changed.updatedAt);
  await assert.rejects(h.dispatch('updateCollection', 'old', { description: 'Stale' }, { expectedUpdatedAt: changed.updatedAt }), /Conflict/);
  assert.equal(h.library().items[0].id, 'note'); assert.equal(h.library().items[0].content, 'Retained');
  const exported = await h.dispatch('exportLibrary');
  const copy = adapter(); await copy.dispatch('importLibrary', exported);
  assert.equal(copy.library().collections[0].description, renamed.description);
  assert.equal(copy.library().collections[0].sidebarLayout, 'grid');
});

test('collection normalization bounds descriptions and accepts only existing safe cover forms and layout choices', async () => {
  const h = adapter();
  const collection = await h.dispatch('createCollection', { name: 'Safe', description: 'a'.repeat(12001), cover: 'javascript:alert(1)', layout: 'unknown', sidebarLayout: null, pinned: 'true' });
  assert.equal(collection.description.length, 12000); assert.equal(collection.cover, '');
  assert.equal(collection.layout, 'grid'); assert.equal(collection.sidebarLayout, 'list'); assert.equal(collection.pinned, false);
  for (const cover of ['https://example.com/cover.jpg', 'images/cover.webp', 'data:image/png;base64,AA==']) assert.equal((await h.dispatch('updateCollection', collection.id, { cover })).cover, cover);
  for (const cover of ['assets/../private.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'https://user:secret@example.com/cover.png']) assert.equal((await h.dispatch('updateCollection', collection.id, { cover })).cover, '');
});

const workspace = () => ({ updatedAt: '2026-10-25T14:00:00Z', collections: [
  { id: 'a', name: 'Research', description: 'Work in progress', cover: 'images/cover.webp', color: '#abcdef', icon: 'book', updatedAt: '2026-10-25T13:00:00Z' },
  { id: 'b', name: 'Nested', parentId: 'a' }, { id: 'c', name: 'Deep', parentId: 'b' }, { id: 'other', name: 'Elsewhere' }, { id: 'removed', name: 'Removed', deletedAt: '2026-10-24' },
], items: [
  { id: 'note', type: 'note', collectionId: 'a' }, { id: 'article', type: 'article', collectionId: 'b' }, { id: 'image', type: 'image', collectionId: 'c' },
  { id: 'video', type: 'video', collectionId: 'b' }, { id: 'file', type: 'file', collectionId: 'c' }, { id: 'bookmark', type: 'bookmark', collectionId: 'a' },
  { id: 'archived', type: 'note', collectionId: 'b', archived: true }, { id: 'trashed', type: 'file', collectionId: 'a', deletedAt: '2026-10-24' },
  { id: 'inbox-note', type: 'note', collectionId: '' }, { id: 'inbox-source', type: 'bookmark' }, { id: 'elsewhere', type: 'note', collectionId: 'other' },
] });

test('space context scopes active nested resources and preserves metadata and update provenance', () => {
  const library = workspace(), space = buildSpaceContext(library, 'space:a');
  assert.deepEqual(space.collectionIds, ['a', 'b', 'c']);
  assert.deepEqual([space.itemCount, space.noteCount, space.fileCount, space.sourceCount], [6, 1, 3, 2]);
  assert.equal(space.name, 'Research'); assert.equal(space.description, 'Work in progress'); assert.equal(space.updatedAt, library.collections[0].updatedAt);
  assert.deepEqual([space.key, space.kind, space.id], ['space:a', 'collection', 'a']);
  const nested = buildSpaceContext(library, 'space:b'); assert.equal(nested.itemCount, 4); assert.deepEqual(nested.collectionIds, ['b', 'c']);
  const inbox = buildSpaceContext(library, 'inbox');
  assert.deepEqual(inbox.collectionIds, ['']); assert.deepEqual([inbox.id, inbox.kind], ['', 'inbox']);
  assert.deepEqual([inbox.itemCount, inbox.noteCount, inbox.fileCount, inbox.sourceCount], [2, 1, 0, 1]); assert.equal(inbox.updatedAt, library.updatedAt);
});

test('unknown and removed spaces never broaden context; collection traversal terminates cycles', () => {
  const library = workspace();
  for (const key of ['space:missing', 'space:removed', 'space:', 'all', '', null]) assert.equal(buildSpaceContext(library, key), null);
  library.collections[0].parentId = 'c'; library.collections.push({ id: 'dead-child', parentId: 'a', deletedAt: '2026-10-24' });
  assert.deepEqual(getDescendantCollectionIds(library, 'a'), ['a', 'b', 'c']);
  assert.deepEqual(getDescendantCollectionIds(library, 'missing'), ['missing']); assert.deepEqual(getDescendantCollectionIds(library, ''), ['']);
  assert.equal(buildSpaceContext(library, 'space:a').itemCount, 6);
});

test('relationship graph preserves explicit directions and backlinks, removes repeated/self/dangling/hidden links and creates no similarity edges', () => {
  const items = [
    { id: 'orphan', title: 'Same title', tags: ['shared'], type: 'note', relatedIds: [] },
    { id: 'a', title: 'Same title', tags: ['shared'], type: 'note', collectionId: 'research', relatedIds: ['b', 'b', 'a', 'missing', 'trashed', 'archived'] },
    { id: 'b', title: 'B', type: 'article', relatedIds: ['a'] }, { id: 'c', type: 'file', relatedIds: ['b'] },
    { id: 'trashed', relatedIds: ['a'], deletedAt: '2026-10-24' }, { id: 'archived', relatedIds: ['a'], archived: true },
  ];
  const before = structuredClone(items), graph = buildRelationshipGraph(items);
  assert.equal(graph.totalItems, 4); assert.equal(graph.truncated, false);
  assert.deepEqual(graph.nodes.map(node => node.id), ['a', 'b', 'c', 'orphan']);
  assert.deepEqual(graph.edges, [{ source: 'a', target: 'b', bidirectional: true }, { source: 'c', target: 'b', bidirectional: false }]);
  assert.deepEqual(graph.nodes.map(node => node.degree), [1, 2, 1, 0]);
  assert.equal(graph.nodes[0].collectionId, 'research');
  for (const node of graph.nodes) assert.ok(Number.isFinite(node.x) && node.x > 0 && node.x < 920 && Number.isFinite(node.y) && node.y > 0 && node.y < 580);
  assert.deepEqual(buildRelationshipGraph(items), graph); assert.deepEqual(items, before);
  const scoped = buildRelationshipGraph(items.filter(item => item.id !== 'b'));
  assert.deepEqual(scoped.edges, []); assert.equal(scoped.nodes.some(node => node.id === 'b'), false);
});

test('graph cap is bounded, prioritizes connected records, deduplicates identities and reports only rendered degrees', () => {
  const items = [{ id: 'orphan' }, { id: 'a', relatedIds: ['b'] }, { id: 'a', relatedIds: ['orphan'] }, { id: 'b', relatedIds: [] }, ...Array.from({ length: 1100 }, (_, i) => ({ id: `item-${i}` }))];
  const graph = buildRelationshipGraph(items, { limit: 2 });
  assert.deepEqual(graph.nodes.map(node => node.id), ['a', 'b']); assert.equal(graph.edges.length, 1); assert.equal(graph.totalItems, 1103); assert.equal(graph.truncated, true);
  const one = buildRelationshipGraph(items, { limit: 1 }); assert.deepEqual(one.edges, []); assert.equal(one.nodes[0].degree, 0);
  assert.equal(buildRelationshipGraph(items, { limit: 10000 }).nodes.length, 1000);
  assert.equal(buildRelationshipGraph(items).nodes.length, 60); assert.equal(buildRelationshipGraph(items, { limit: NaN }).nodes.length, 60);
  assert.deepEqual(buildRelationshipGraph(items, { limit: -1 }).nodes, []); assert.deepEqual(buildRelationshipGraph([]), { nodes: [], edges: [], totalItems: 0, truncated: false });
});

test('MCP creates, reads, patches and exports complete collection metadata through the extension executor while retaining revisions', async () => {
  const h = adapter(), bridge = createBridgeState(); let settings = {};
  const client = createIntegrationClient({ storage: { read: async () => settings, write: async value => { settings = value; } }, store: h.store,
    fetch: async (_url, options) => ({ ok: true, status: 200, json: async () => bridge.sync(JSON.parse(options.body)) }) });
  await client.configureBridge({ token: 'space-test-local-bridge-token-12345678' }); await client.syncBridgeOnce();
  const mutate = async (name, args) => { const queued = bridge.callTool(name, args); await client.syncBridgeOnce(); const receipt = bridge.callTool('get_operation', { id: queued.id }); assert.equal(receipt.status, 'saved', JSON.stringify(receipt)); return receipt.result; };
  const fields = { name: 'Ideas', description: 'Grounded work', cover: 'https://example.com/cover.webp', pinned: true, layout: 'masonry', sidebarLayout: 'grid' };
  const created = await mutate('create_collection', fields);
  for (const [key, value] of Object.entries(fields)) assert.equal(created[key], value);
  const updated = await mutate('update_collection', { id: created.id, patch: { description: 'Revised', pinned: false, sidebarLayout: 'list' }, expectedUpdatedAt: created.updatedAt });
  assert.equal(updated.cover, fields.cover); assert.equal(updated.layout, 'masonry'); assert.equal(updated.name, 'Ideas'); assert.equal(updated.pinned, false);
  const read = bridge.callTool('get_collection', { id: created.id }).collection; assert.equal(read.description, 'Revised'); assert.equal(read.updatedAt, updated.updatedAt);
  assert.equal(bridge.callTool('export_library').collections[0].sidebarLayout, 'list');
  const caps = bridge.callTool('library_capabilities'); for (const field of Object.keys(fields).concat('parentId')) assert.ok(caps.collectionFields.includes(field));
  for (const name of ['create_collection', 'update_collection']) {
    const schema = TOOLS.find(tool => tool.name === name).inputSchema;
    const properties = name === 'update_collection' ? schema.properties.patch.properties : schema.properties;
    assert.equal(properties.description.maxLength, 12000); assert.deepEqual(properties.layout.enum, ['grid', 'list', 'masonry']);
  }
  assert.throws(() => bridge.callTool('update_collection', { id: created.id, patch: { description: 'stale' }, expectedUpdatedAt: created.updatedAt }), /changed/);
  for (const patch of [{ description: 'x'.repeat(12001) }, { layout: 'gallery' }, { pinned: 'yes' }, { updatedAt: 'forbidden' }]) assert.throws(() => bridge.callTool('update_collection', { id: created.id, patch }), /invalid|unsupported|not supported/);
});
