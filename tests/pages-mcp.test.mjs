import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeState, TOOLS } from '../bridge/protocol.mjs';
import { createBridgeServer } from '../bridge/server.mjs';
import { createIntegrationClient } from '../extension/lib/integrations.js';
import { createLibraryStore } from '../extension/lib/store.js';

const TOKEN = 'pages-mcp-test-token-longer-than-twenty-four';
const at = '2026-10-25T12:00:00.000Z';
const fixture = () => ({ schemaVersion: 1, updatedAt: at, settings: {},
  collections: [{ id: 'research', name: 'Research', parentId: '', updatedAt: at }],
  items: [
    { id: 'article', type: 'article', title: 'Accessible motion', url: 'https://example.com/motion', collectionId: 'research', siteName: 'Example', icon: 'data:image/png;base64,AAAA', updatedAt: at },
    { id: 'page', type: 'note', title: 'Findings', parentId: 'article', collectionId: 'research', attachmentId: 'file_page', fileName: 'page.bin', mime: 'application/octet-stream', updatedAt: at, createdAt: at },
    { id: 'sub', type: 'note', title: 'Details', parentId: 'page', collectionId: 'research', attachmentId: 'file_sub', fileName: 'sub.bin', mime: 'application/octet-stream', updatedAt: at, createdAt: at },
    { id: 'loose', type: 'note', title: 'Loose note', updatedAt: at },
    { id: 'link', type: 'bookmark', title: 'A link', url: 'https://example.com/link', updatedAt: at },
    { id: 'binned', type: 'note', title: 'In Trash', deletedAt: at, updatedAt: at },
  ] });

async function harness(t) {
  let library = null;
  const removedFiles = [];
  const core = createLibraryStore({ read: async () => library, write: async value => { library = value; } });
  await core.dispatch('loadLibrary', [fixture()]);
  const operations = ['loadLibrary', 'saveItem', 'updateItem', 'deleteItem', 'restoreItem', 'permanentlyDeleteItem', 'movePage', 'bulkUpdateItems'];
  const store = Object.fromEntries(operations.map(operation => [operation, (...args) => core.dispatch(operation, args)]));
  store.deleteAttachment = async id => { removedFiles.push(id); };
  const state = createBridgeState();
  const server = createBridgeServer({ token: TOKEN, state });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  let settings = {};
  const client = createIntegrationClient({ storage: { read: async () => settings, write: async value => { settings = value; } }, store });
  await client.configureBridge({ url, token: TOKEN }); await client.syncBridgeOnce();
  let rpcId = 0;
  const rpc = async (name, args = {}) => {
    const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
    return (await response.json()).result;
  };
  const call = async (name, args) => { const result = await rpc(name, args); assert.equal(result.isError, undefined, JSON.stringify(result)); return result.structuredContent; };
  const refused = async (name, args) => { const result = await rpc(name, args); assert.equal(result.isError, true, JSON.stringify(result)); return result.structuredContent.error; };
  const receipt = async id => call('get_operation', { id });
  const mutate = async (name, args) => { const queued = await call(name, args); assert.equal(queued.saved, false); await client.syncBridgeOnce(); const done = await receipt(queued.id); assert.equal(done.status, 'saved', JSON.stringify(done)); return done.result; };
  return { client, call, refused, receipt, mutate, removedFiles, item: id => library.items.find(entry => entry.id === id) };
}

test('MCP reads show parents and subpages, and list_items can list a page\'s subpages', async t => {
  const h = await harness(t);
  const listed = await h.call('list_items', { limit: 100 });
  assert.equal(listed.items.find(item => item.id === 'page').parentId, 'article');
  assert.equal(listed.items.find(item => item.id === 'loose').parentId, '');
  assert.deepEqual((await h.call('list_items', { parentId: 'article' })).items.map(item => item.id), ['page']);
  assert.deepEqual((await h.call('list_items', { parentId: '', type: 'note' })).items.map(item => item.id), ['loose']);
  const read = await h.call('get_item', { id: 'page' });
  assert.equal(read.item.parentId, 'article');
  assert.deepEqual(read.subpageIds, ['sub']);
  assert.equal((await h.call('get_item', { id: 'article' })).item.icon, '', 'inline icons stay on the device');
  const exported = await h.call('export_item', { id: 'page', format: 'markdown' });
  assert.match(exported.content, /Parent page: Accessible motion \(article\)/);
  assert.match(exported.content, /## Subpages\n\n- Details \(sub\)/);
  const caps = await h.call('library_capabilities');
  assert.equal(caps.pages.moveTool, 'move_page');
  assert.equal(caps.pages.maximumDepth, 32);
  assert.ok(TOOLS.some(tool => tool.name === 'move_page'));
  assert.ok(TOOLS.find(tool => tool.name === 'create_item').inputSchema.properties.parentId);
  assert.equal(TOOLS.find(tool => tool.name === 'update_item').inputSchema.properties.patch.properties.parentId, undefined, 'moves go through move_page');
  // An agent that changes one page's collection or trashes it learns that unlisted subpages change too.
  for (const name of ['update_item', 'bulk_update_items', 'move_page']) {
    const { description } = TOOLS.find(tool => tool.name === name);
    assert.match(description, /collection/i, name);
    assert.match(description, /subpages/, name);
    assert.match(description, /trash_item.*trashes (a page together with )?its subpages/, name);
  }
  assert.match(caps.pages.cascade, /collection change .* carries down to its live subpages/);
});

test('a collection change through update_item and bulk_update_items carries down to subpages', async t => {
  const h = await harness(t);
  await h.mutate('update_item', { id: 'page', patch: { collectionId: '' } });
  assert.equal(h.item('page').collectionId, '');
  assert.equal(h.item('sub').collectionId, '', 'the subpage moves with its page');
  await h.mutate('bulk_update_items', { updates: [{ id: 'page', patch: { collectionId: 'research' } }] });
  assert.equal(h.item('sub').collectionId, 'research');
});

test('create_item makes a subpage that lands in its parent\'s collection; bad parents are refused before queueing', async t => {
  const h = await harness(t);
  const created = await h.mutate('create_item', { type: 'note', title: 'Follow-up', content: 'More', parentId: 'page' });
  assert.equal(created.parentId, 'page');
  assert.equal(created.collectionId, 'research');
  assert.equal(h.item(created.id).parentId, 'page');
  assert.equal((await h.refused('create_item', { type: 'bookmark', title: 'Link', url: 'https://example.com/x', parentId: 'page' })).code, 'INVALID_ARGUMENT');
  assert.equal((await h.refused('create_item', { type: 'note', title: 'Orphan', parentId: 'item_missing' })).code, 'NOT_FOUND');
  assert.match((await h.refused('create_item', { type: 'note', title: 'Under trash', parentId: 'binned' })).message, /in Trash/);
});

test('move_page re-parents through the extension executor and refuses loops and non-notes', async t => {
  const h = await harness(t);
  const moved = await h.mutate('move_page', { id: 'loose', parentId: 'sub' });
  assert.equal(moved.parentId, 'sub');
  assert.equal(moved.collectionId, 'research', 'it takes the new parent\'s collection');
  assert.match((await h.refused('move_page', { id: 'page', parentId: 'loose' })).message, /inside itself/);
  assert.match((await h.refused('move_page', { id: 'page', parentId: 'page' })).message, /inside itself/);
  assert.match((await h.refused('move_page', { id: 'link', parentId: 'page' })).message, /Only notes/);
  assert.match((await h.refused('move_page', { id: 'binned', parentId: '' })).message, /Restore this page/);
  const top = await h.mutate('move_page', { id: 'loose', parentId: '' });
  assert.equal(top.parentId, '');
  assert.equal(h.item('loose').parentId, '');
});

test('trash, restore and permanent deletion carry subpages, and the executor cleans every file a cascade removed', async t => {
  const h = await harness(t);
  await h.mutate('trash_item', { id: 'page' });
  assert.equal(h.item('sub').deletedAt, h.item('page').deletedAt, 'the subpage is trashed with its page');
  await h.mutate('restore_item', { id: 'page' });
  assert.equal(h.item('sub').deletedAt, null);
  await h.mutate('trash_item', { id: 'page' });
  // Both deletions are queued before the extension syncs: the first one's cascade already removes the second item.
  const first = await h.call('permanently_delete_item', { id: 'page', confirm: true });
  const second = await h.call('permanently_delete_item', { id: 'sub', confirm: true });
  await h.client.syncBridgeOnce();
  const one = await h.receipt(first.id), two = await h.receipt(second.id);
  assert.equal(one.status, 'saved');
  assert.deepEqual(new Set(one.result.ids), new Set(['page', 'sub']));
  assert.equal(one.result.fileCleanup, 'complete');
  assert.deepEqual(new Set(h.removedFiles), new Set(['file_page', 'file_sub']));
  assert.equal(two.status, 'saved', JSON.stringify(two));
  assert.equal(two.result.alreadyDeleted, true);
  assert.equal(h.item('page'), undefined);
  assert.equal(h.item('sub'), undefined);
});
