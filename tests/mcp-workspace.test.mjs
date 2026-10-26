import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeState, TOOLS } from '../bridge/protocol.mjs';
import { createBridgeServer } from '../bridge/server.mjs';
import { createIntegrationClient } from '../extension/lib/integrations.js';
import { createLibraryStore } from '../extension/lib/store.js';

const TOKEN = 'workspace-test-token-longer-than-twenty-four';
const fixture = () => ({ schemaVersion: 1, updatedAt: '2026-10-25T12:00:00.000Z', settings: { secretToken: 'private' },
  collections: [{ id: 'research', name: 'Research', parentId: '', updatedAt: '2026-10-25T12:00:00.000Z' }],
  items: [
    { id: 'article', type: 'article', title: 'Accessible motion', url: 'https://example.com/motion', content: 'Personal judgment', articleContent: 'Source about vestibular effects', tags: ['motion'], collectionId: 'research', relatedIds: [], updatedAt: '2026-10-25T12:00:00.000Z', highlights: [{ id: 'quote', text: 'Respect preferences', note: 'Annotation about reduced-motion', color: 'amber' }] },
    { id: 'note', type: 'note', title: 'Research note', content: '- [ ] Explore springs', tags: ['motion'], relatedIds: ['article'], collectionId: 'research', updatedAt: '2026-10-25T12:00:00.000Z' },
    { id: 'file', type: 'file', title: 'Design brief', fileName: 'brief.bin', mime: 'application/octet-stream', size: 150001, attachmentId: 'browser-attachment', relatedIds: [], tags: [], content: 'File context', updatedAt: '2026-10-25T12:00:00.000Z' },
    { id: 'archived', type: 'note', title: 'Archived note', content: 'Kept', tags: ['motion'], archived: true, relatedIds: [] },
    { id: 'trashed', type: 'note', title: 'Trashed note', content: 'Recoverable', tags: ['motion'], deletedAt: '2026-10-25T11:00:00.000Z', relatedIds: [] },
  ] });

async function harness(t) {
  let library = null, settings = {};
  const core = createLibraryStore({ read: async () => library, write: async value => { library = value; } });
  await core.dispatch('loadLibrary', [fixture()]);
  const operations = ['loadLibrary', 'saveItem', 'updateItem', 'deleteItem', 'restoreItem', 'permanentlyDeleteItem', 'createCollection', 'updateCollection', 'deleteCollection', 'mutateTags'];
  const store = Object.fromEntries(operations.map(operation => [operation, (...args) => core.dispatch(operation, args)]));
  const bytes = Uint8Array.from({ length: 150001 }, (_, i) => i % 251);
  store.getAttachment = async id => id === 'browser-attachment' ? { blob: new Blob([bytes]), name: 'brief.bin', mime: 'application/octet-stream' } : null;
  const state = createBridgeState();
  const server = createBridgeServer({ token: TOKEN, state });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = createIntegrationClient({ storage: { read: async () => settings, write: async value => { settings = value; } }, store });
  await client.configureBridge({ url, token: TOKEN }); await client.syncBridgeOnce();
  let rpcId = 0;
  const rpc = async (name, args = {}) => {
    const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
    assert.equal(response.status, 200); return (await response.json()).result;
  };
  const call = async (name, args) => { const result = await rpc(name, args); assert.equal(result.isError, undefined, JSON.stringify(result)); return result.structuredContent; };
  const mutate = async (name, args) => { const queued = await call(name, args); assert.equal(queued.saved, false); await client.syncBridgeOnce(); const receipt = await call('get_operation', { id: queued.id }); assert.equal(receipt.status, 'saved', JSON.stringify(receipt)); return receipt.result; };
  return { state, client, store, call, rpc, mutate, bytes, library: () => library };
}

test('MCP traverses all item states, source/annotation/file metadata, backlinks and paginated exports without credentials', async t => {
  const h = await harness(t);
  for (const query of ['vestibular', 'reduced-motion', 'brief.bin', 'Personal judgment']) assert.equal((await h.call('search_library', { query })).total, 1);
  assert.equal((await h.call('list_items', {})).total, 3);
  const ids = []; let offset = 0, version;
  for (;;) { const page = await h.call('list_items', { state: 'all', offset, limit: 2 }); version ||= page.snapshotVersion; assert.equal(page.snapshotVersion, version); ids.push(...page.items.map(i => i.id)); if (page.complete) break; offset = page.nextOffset; }
  assert.equal(new Set(ids).size, 5);
  assert.equal((await h.call('get_related_items', { id: 'article', direction: 'incoming' })).items[0].id, 'note');
  assert.deepEqual((await h.call('get_collection', { id: 'research' })).collection.childIds, []);
  assert.equal((await h.call('list_tags', { includeArchived: true, includeDeleted: true })).tags.find(tag => tag.name === 'motion').count, 4);
  const item = await h.call('get_item', { id: 'file' }); assert.equal(item.item.attachmentId, undefined); assert.equal(item.item.fileName, 'brief.bin');
  const exported = await h.call('export_item', { id: 'article', format: 'markdown' });
  assert.match(exported.content, /## Saved source/); assert.match(exported.content, /## Personal notes/); assert.match(exported.content, /Annotation about reduced-motion/);
  const page = await h.call('export_library', { state: 'all', limit: 1 }); assert.equal(page.complete, false); assert.equal(page.items.length, 1);
  assert.equal(JSON.stringify(page).includes('secretToken'), false); assert.equal(JSON.stringify(page).includes('browser-attachment'), false);
  const caps = await h.call('library_capabilities'); assert.equal(caps.files.maximumChunkBytes, 65536); assert.equal(caps.files.upload, false);
});

test('MCP source, notes, highlights, links, tags and collection edits persist through the actual extension executor and store', async t => {
  const h = await harness(t);
  const note = await h.mutate('create_item', { type: 'note', title: 'Synthesis', content: 'Related evidence', relatedIds: ['article'], collectionId: 'research' });
  await h.mutate('update_item', { id: note.id, patch: { content: 'Revised synthesis', pinned: true } });
  await h.mutate('update_article_content', { id: 'article', articleContent: 'Corrected source' });
  let article = (await h.call('get_item', { id: 'article' })).item;
  assert.equal(article.content, 'Personal judgment'); assert.equal(article.articleContent, 'Corrected source');
  await h.mutate('add_highlight', { id: 'article', text: 'New quote', note: 'New annotation', color: 'blue' });
  article = (await h.call('get_item', { id: 'article' })).item;
  const highlight = article.highlights.find(h => h.text === 'New quote'); assert.ok(highlight.id);
  await h.mutate('update_highlight', { id: 'article', highlightId: highlight.id, patch: { note: 'Edited annotation' } });
  assert.equal((await h.call('search_library', { query: 'Edited annotation' })).total, 1);
  await h.mutate('remove_highlight', { id: 'article', highlightId: highlight.id });
  await h.mutate('unlink_items', { id: note.id, targetId: 'article' });
  assert.deepEqual((await h.call('get_item', { id: note.id })).item.relatedIds, []);
  await h.mutate('link_items', { id: note.id, targetId: 'article' });
  await h.mutate('set_item_tags', { id: note.id, tags: ['motion', 'synthesis'] });
  await h.mutate('rename_tag', { oldTag: 'motion', newTag: 'accessibility' });
  assert.equal(h.library().items.filter(i => i.tags.includes('motion')).length, 0);
  assert.equal(h.library().items.filter(i => i.tags.includes('accessibility')).length, 5);
  await h.mutate('remove_tag', { tag: 'synthesis' });
  assert.deepEqual((await h.call('get_item', { id: note.id })).item.tags, ['accessibility']);
  const collection = await h.mutate('create_collection', { name: 'Ideas', parentId: 'research' });
  await h.mutate('update_collection', { id: collection.id, patch: { name: 'Connected ideas' } });
  await h.mutate('update_item', { id: note.id, patch: { collectionId: collection.id } });
  await h.mutate('delete_collection', { id: collection.id, confirm: true });
  assert.equal((await h.call('get_item', { id: note.id })).item.collectionId, '');
  assert.equal((await h.call('get_item', { id: note.id })).item.content, 'Revised synthesis');
});

test('optimistic versions reject a UI edit occurring after queueing; errors and destructive boundaries remain explicit', async t => {
  const h = await harness(t);
  const initial = (await h.call('get_item', { id: 'article' })).item;
  const queued = await h.call('update_item', { id: 'article', patch: { content: 'Agent stale edit' }, expectedUpdatedAt: initial.updatedAt });
  await h.store.updateItem('article', { content: 'New UI note' });
  await h.client.syncBridgeOnce();
  const receipt = await h.call('get_operation', { id: queued.id }); assert.equal(receipt.status, 'failed'); assert.equal(receipt.errorCode, 'VERSION_CONFLICT');
  assert.equal((await h.call('get_item', { id: 'article' })).item.content, 'New UI note');
  const conflict = await h.rpc('update_item', { id: 'article', patch: { content: 'Old version' }, expectedUpdatedAt: initial.updatedAt });
  assert.equal(conflict.isError, true); assert.equal(conflict.structuredContent.error.code, 'VERSION_CONFLICT'); assert.match(conflict.structuredContent.error.action, /Read it again/);
  for (const field of ['id', 'updatedAt', 'attachmentId', 'articleContent']) assert.equal((await h.rpc('update_item', { id: 'article', patch: { [field]: 'forbidden' } })).structuredContent.error.code, 'INVALID_ARGUMENT');
  assert.equal((await h.rpc('permanently_delete_item', { id: 'article', confirm: true })).isError, true);
  assert.equal((await h.rpc('delete_collection', { id: 'research', confirm: false })).isError, true);
  assert.equal((await h.rpc('update_collection', { id: 'research', patch: { parentId: 'research' } })).isError, true);
  await h.mutate('trash_item', { id: 'article' }); assert.equal((await h.call('list_items', { state: 'trash' })).total, 2);
  await h.mutate('restore_item', { id: 'article' }); assert.equal((await h.call('get_item', { id: 'article' })).item.deletedAt, null);
  await h.mutate('trash_item', { id: 'article' }); await h.mutate('permanently_delete_item', { id: 'article', confirm: true });
  assert.equal((await h.rpc('get_item', { id: 'article' })).structuredContent.error.code, 'NOT_FOUND');
  assert.deepEqual((await h.call('get_item', { id: 'note' })).item.relatedIds, []);
  assert.equal(TOOLS.find(t => t.name === 'permanently_delete_item').annotations.destructiveHint, true);
  assert.equal(TOOLS.find(t => t.name === 'read_file').annotations.readOnlyHint, true);
  assert.equal(TOOLS.find(t => t.name === 'create_item').annotations.idempotentHint, false);
});

test('MCP file reads complete byte-for-byte over browser attachment chunks and cannot request arbitrary paths', async t => {
  const h = await harness(t), chunks = []; let offset = 0;
  for (;;) {
    const queued = await h.call('read_file', { itemId: 'file', offset, length: 65536 }); assert.equal(queued.completed, false);
    const status = await h.client.syncBridgeOnce(); assert.equal(status.changed, false);
    const receipt = await h.call('get_operation', { id: queued.id }); assert.equal(receipt.status, 'completed');
    const result = receipt.result; assert.equal(result.offset, offset); assert.equal(result.name, 'brief.bin'); assert.equal(result.size, h.bytes.length);
    const bytes = Buffer.from(result.base64, 'base64'); assert.ok(bytes.length <= 65536); chunks.push(bytes);
    if (result.complete) break; assert.ok(result.nextOffset > offset); offset = result.nextOffset;
  }
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(h.bytes));
  assert.equal((await h.rpc('read_file', { itemId: 'file', path: 'C:/secret', length: 1 })).isError, true);
  assert.equal((await h.rpc('read_file', { itemId: 'file', length: 65537 })).isError, true);
  assert.equal((await h.rpc('read_file', { itemId: 'article' })).structuredContent.error.code, 'FILE_UNAVAILABLE');
  const beyond = await h.call('read_file', { itemId: 'file', offset: h.bytes.length + 1 }); await h.client.syncBridgeOnce();
  assert.equal((await h.call('get_operation', { id: beyond.id })).status, 'failed');
});

test('protocol reports stale state, bounds queueing, preserves queued commands and expires only completed receipts', () => {
  let time = 100000; const state = createBridgeState({ now: () => time });
  assert.equal(state.callTool('bridge_status').connected, false); state.sync({ library: fixture() });
  const queued = state.callTool('create_item', { type: 'note', title: 'Pending' });
  for (let i = 1; i < 100; i++) state.callTool('create_item', { type: 'note', title: `Pending ${i}` });
  assert.throws(() => state.callTool('create_item', { type: 'note', title: 'Overflow' }), /queue is full/);
  assert.equal(state.sync({ library: fixture() }).commands[0].id, queued.id);
  state.sync({ library: fixture(), acknowledgements: [{ id: queued.id, result: { id: 'new-item' } }] });
  assert.equal(state.callTool('get_operation', { id: queued.id }).status, 'saved');
  time += 3600001; assert.throws(() => state.callTool('get_item', { id: 'article' }), /last 30 seconds/);
  const next = state.sync({ library: fixture() }); assert.equal(next.commands.length, 99);
  assert.throws(() => state.callTool('get_operation', { id: queued.id }), /expired/);
});
