import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { PassThrough } from 'node:stream';
import { createBridgeState, TOOLS } from '../bridge/protocol.mjs';
import { runStdio } from '../bridge/mcp.mjs';
import { createBridgeServer } from '../bridge/server.mjs';
import { createIntegrationClient } from '../extension/lib/integrations.js';
import { createLibraryStore } from '../extension/lib/store.js';

const TOKEN = 'mcp-tools-test-token-longer-than-twenty-four';
const fixture = () => ({ schemaVersion: 1, updatedAt: '2026-10-28T09:00:00.000Z', settings: {},
  collections: [{ id: 'design', name: 'Design', parentId: '', updatedAt: '2026-10-28T09:00:00.000Z' }, { id: 'reading', name: 'Reading', parentId: '', updatedAt: '2026-10-28T09:00:00.000Z' }],
  items: [
    { id: 'motion', type: 'article', title: 'Accessible motion', url: 'https://example.com/motion', content: 'Spring curves', tags: ['motion'], collectionId: 'design', relatedIds: [], updatedAt: '2026-10-28T09:00:00.000Z' },
    { id: 'type', type: 'bookmark', title: 'Variable fonts', url: 'https://example.com/fonts', tags: ['type'], collectionId: 'design', relatedIds: [], updatedAt: '2026-10-28T09:00:00.000Z' },
    { id: 'note', type: 'note', title: 'Reading list', content: '- [ ] Finish', tags: [], collectionId: '', relatedIds: [], updatedAt: '2026-10-28T09:00:00.000Z' },
    { id: 'trashed', type: 'note', title: 'Old motion idea', content: 'Bounce', tags: ['motion'], deletedAt: '2026-10-27T09:00:00.000Z', relatedIds: [] },
  ] });

async function harness(t, { search, searchAvailable, state = createBridgeState() } = {}) {
  let library = null;
  const core = createLibraryStore({ read: async () => library, write: async value => { library = value; } });
  await core.dispatch('loadLibrary', [fixture()]);
  const store = Object.fromEntries(['loadLibrary', 'saveItem', 'updateItem', 'bulkUpdateItems'].map(operation => [operation, (...args) => core.dispatch(operation, args)]));
  const server = createBridgeServer({ token: TOKEN, state });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  let settings = {};
  const client = createIntegrationClient({ storage: { read: async () => settings, write: async value => { settings = value; } }, store, search, searchAvailable });
  await client.configureBridge({ url, token: TOKEN }); await client.syncBridgeOnce();
  let rpcId = 0;
  const rpc = async (name, args = {}) => (await (await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
  // An asynchronous tool answers only after the extension's next sync acknowledges it, so keep syncing until it does.
  const searched = async args => {
    const pending = rpc('semantic_search', args);
    for (let attempt = 0; attempt < 50; attempt++) {
      await client.syncBridgeOnce();
      const done = await Promise.race([pending, delay(10).then(() => null)]);
      if (done) return done;
    }
    return pending;
  };
  return { state, client, store, rpc, searched, library: () => library };
}

test('semantic_search delegates to the extension index, returns only live matching items and leaves the library unchanged', async t => {
  const calls = [];
  const search = async (query, options) => {
    calls.push({ query, options });
    return { results: [{ id: 'trashed', title: 'Old motion idea', score: 0.99 }, { id: 'motion', title: 'Accessible motion', type: 'article', url: 'https://example.com/motion', score: 0.91, snippet: 'Spring curves feel calm.' }, { id: 'missing', score: 0.5 }, { id: 'type', score: 0.4, snippet: 'Variable fonts' }], index: { provider: 'voyage', model: 'voyage-4', indexed: 3, total: 3 } };
  };
  const h = await harness(t, { search, searchAvailable: async () => true });
  const capabilities = (await h.rpc('library_capabilities')).structuredContent;
  assert.deepEqual(capabilities.search, { lexical: true, semantic: true, semanticTool: 'semantic_search', semanticMaximumLimit: 50 });
  const result = await h.searched({ query: '  calm animation  ', limit: 5, collectionId: 'design' });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const data = result.structuredContent;
  assert.deepEqual(calls, [{ query: 'calm animation', options: { limit: 5, type: undefined, collectionId: 'design', tag: undefined } }]);
  assert.deepEqual(data.items.map(item => [item.id, item.score]), [['motion', 0.91], ['type', 0.4]]);
  assert.equal(data.items[0].snippet, 'Spring curves feel calm.'); assert.equal(data.items[0].collectionId, 'design'); assert.deepEqual(data.items[0].tags, ['motion']);
  assert.deepEqual(data.index, { provider: 'voyage', model: 'voyage-4', indexed: 3, total: 3 });
  assert.equal(data.query, 'calm animation'); assert.equal(data.total, 2);
  const filtered = (await h.searched({ query: 'motion', tag: 'motion' })).structuredContent;
  assert.deepEqual(filtered.items.map(item => item.id), ['motion']);
  assert.equal(h.state.status().pending, 0);
  assert.equal((await h.client.syncBridgeOnce()).changed, false);
  const tool = TOOLS.find(entry => entry.name === 'semantic_search');
  assert.equal(tool.annotations.readOnlyHint, true); assert.deepEqual(tool.inputSchema.required, ['query']);
});

test('semantic_search reports EMBEDDINGS_UNAVAILABLE when Still has no enabled index or cannot run the command', async t => {
  const none = await harness(t);
  assert.equal((await none.rpc('library_capabilities')).structuredContent.search.semantic, false);
  const unavailable = await none.rpc('semantic_search', { query: 'motion' });
  assert.equal(unavailable.isError, true); assert.equal(unavailable.structuredContent.error.code, 'EMBEDDINGS_UNAVAILABLE'); assert.match(unavailable.structuredContent.error.action, /search_library/);
  const disabled = await harness(t, { search: async () => ({ results: [] }), searchAvailable: async () => false });
  assert.equal((await disabled.rpc('semantic_search', { query: 'motion' })).structuredContent.error.code, 'EMBEDDINGS_UNAVAILABLE');
  const switchedOff = await harness(t, { search: async () => { throw new Error('Semantic search is not enabled in Still.'); } });
  assert.equal((await switchedOff.searched({ query: 'motion' })).structuredContent.error.code, 'EMBEDDINGS_UNAVAILABLE');
  const broken = await harness(t, { search: async () => { throw new Error('Voyage AI returned HTTP 500.'); } });
  const failed = (await broken.searched({ query: 'motion' })).structuredContent.error;
  assert.equal(failed.code, 'SEARCH_FAILED'); assert.match(failed.message, /HTTP 500/);
  const invalid = await none.rpc('semantic_search', { query: 'motion', limit: 51 });
  assert.equal(invalid.structuredContent.error.code, 'INVALID_ARGUMENT');
});

test('semantic_search times out, drops its unanswered command, and still honours staleness and the synchronous callTool contract', async () => {
  let time = 100000;
  const state = createBridgeState({ now: () => time, searchTimeoutMs: 40 });
  await assert.rejects(state.callToolAsync('semantic_search', { query: 'motion' }), error => error.code === 'STALE_SNAPSHOT');
  state.sync({ library: fixture(), semanticSearch: true });
  assert.equal(state.callTool('library_capabilities').search.semantic, true);
  assert.throws(() => state.callTool('semantic_search', { query: 'motion' }), /asynchronously/);
  const waiting = state.callToolAsync('semantic_search', { query: 'motion' });
  assert.equal(state.status().pending, 1);
  await assert.rejects(waiting, error => error.code === 'SEARCH_TIMEOUT');
  assert.equal(state.status().pending, 0); assert.deepEqual(state.sync({ library: fixture(), semanticSearch: true }).commands, []);
  // An older extension that cannot run the command acknowledges it with an error.
  const legacy = state.callToolAsync('semantic_search', { query: 'motion' });
  const command = state.sync({ library: fixture(), semanticSearch: true }).commands[0];
  assert.deepEqual(command.args, { query: 'motion', limit: 10 }); assert.equal(command.operation, 'semanticSearch');
  state.sync({ library: fixture(), semanticSearch: true, acknowledgements: [{ id: command.id, error: 'Unsupported bridge command.' }] });
  await assert.rejects(legacy, error => error.code === 'EMBEDDINGS_UNAVAILABLE');
  state.sync({ library: fixture(), unknownFutureField: { ignored: true } });
  assert.equal(state.callTool('bridge_status').capabilities.search.semantic, false);
  time += 31000;
  await assert.rejects(state.callToolAsync('semantic_search', { query: 'motion' }), error => error.code === 'STALE_SNAPSHOT');
});

test('bulk_update_items applies organizing patches atomically through the store and keeps optimistic concurrency', async t => {
  const h = await harness(t);
  const call = async (name, args) => { const result = await h.rpc(name, args); assert.equal(result.isError, undefined, JSON.stringify(result)); return result.structuredContent; };
  const queued = await call('bulk_update_items', { updates: [{ id: 'motion', patch: { collectionId: 'reading', tags: ['motion', 'motion ', 'calm'] } }, { id: 'note', patch: { favorite: true, archived: true } }] });
  assert.equal(queued.saved, false);
  assert.equal((await h.client.syncBridgeOnce()).changed, true);
  const receipt = await call('get_operation', { id: queued.id });
  assert.equal(receipt.status, 'saved'); assert.equal(receipt.result.updated, 2);
  assert.deepEqual(receipt.result.items.map(item => item.id), ['motion', 'note']); assert.equal(receipt.result.items[0].content, undefined);
  const motion = h.library().items.find(item => item.id === 'motion'), note = h.library().items.find(item => item.id === 'note');
  assert.equal(motion.collectionId, 'reading'); assert.deepEqual(motion.tags, ['motion', 'calm']); assert.equal(motion.content, 'Spring curves');
  assert.equal(note.favorite, true); assert.equal(note.archived, true);
  for (const [args, code] of [
    [{ updates: [] }, 'INVALID_ARGUMENT'],
    [{ updates: [{ id: 'type', patch: { favorite: true } }, { id: 'type', patch: { pinned: true } }] }, 'INVALID_ARGUMENT'],
    [{ updates: [{ id: 'type', patch: {} }] }, 'INVALID_ARGUMENT'],
    [{ updates: [{ id: 'type', patch: { content: 'Overwrite' } }] }, 'INVALID_ARGUMENT'],
    [{ updates: [{ id: 'type', patch: { collectionId: 'nowhere' } }] }, 'NOT_FOUND'],
    [{ updates: [{ id: 'ghost', patch: { favorite: true } }] }, 'NOT_FOUND'],
    [{ updates: Array.from({ length: 101 }, () => ({ id: 'type', patch: { favorite: true } })) }, 'INVALID_ARGUMENT'],
    [{ updates: [{ id: 'type', patch: { favorite: true } }], expectedLibraryUpdatedAt: '2000-01-01T00:00:00.000Z' }, 'VERSION_CONFLICT'],
  ]) assert.equal((await h.rpc('bulk_update_items', args)).structuredContent.error.code, code, JSON.stringify(args));
  const stale = await call('bulk_update_items', { updates: [{ id: 'type', patch: { favorite: true } }] });
  await h.store.updateItem('type', { title: 'Variable fonts, revised' });
  await h.client.syncBridgeOnce();
  const conflict = await call('get_operation', { id: stale.id });
  assert.equal(conflict.status, 'failed'); assert.equal(conflict.errorCode, 'VERSION_CONFLICT');
  assert.equal(h.library().items.find(item => item.id === 'type').favorite, false);
  assert.equal(TOOLS.find(entry => entry.name === 'bulk_update_items').annotations.destructiveHint, true);
});

test('the stdio adapter keeps answering other messages while a semantic_search waits for the extension', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const forwarded = [];
  const fetcher = async (url, options) => {
    const message = JSON.parse(options.body); forwarded.push(message.id);
    if (message.params?.name === 'semantic_search') await gate;
    return Response.json({ jsonrpc: '2.0', id: message.id, result: { echoed: message.method } });
  };
  const input = new PassThrough(), output = new PassThrough();
  let received = ''; output.setEncoding('utf8'); output.on('data', chunk => { received += chunk; });
  const job = runStdio({ input, output, config: { url: 'http://127.0.0.1:9', token: TOKEN }, fetch: fetcher });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'semantic_search', arguments: { query: 'calm motion' } } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_library', arguments: { query: 'motion' } } })}\n`);
  for (let attempt = 0; attempt < 200 && !received.includes('"id":3'); attempt++) await delay(5);
  assert.deepEqual(received.trim().split('\n').map(line => JSON.parse(line).id), [2, 3], 'ping and search_library answer before the pending semantic_search');
  release(); input.end(); await job;
  assert.deepEqual(received.trim().split('\n').map(line => JSON.parse(line).id), [2, 3, 1]);
  assert.deepEqual(forwarded.sort(), [1, 2, 3]);
});
