import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeServer } from '../bridge/server.mjs';
import { createBridgeState } from '../bridge/protocol.mjs';
import { loadConfig } from '../bridge/config.mjs';
import { runStdio } from '../bridge/mcp.mjs';
import { createIntegrationClient, mapRaindropLibrary, getMcpSetup } from '../extension/lib/integrations.js';
import { createLibraryStore } from '../extension/lib/store.js';

const TOKEN = 'a-test-token-longer-than-24-characters';
const item = { id: 'first', type: 'article', title: 'Motion design', url: 'https://example.com/motion', content: 'Use gentle spring transitions', tags: ['design'], highlights: [{ text: 'Reduced motion matters' }], collectionId: 'design', relatedIds: [], deletedAt: null };
const fixture = () => ({ schemaVersion: 1, items: [structuredClone(item)], collections: [{ id: 'design', name: 'Design' }], settings: { secretToken: 'must-not-cross-bridge' } });
const storageFixture = initial => {
  let value = structuredClone(initial || {});
  return { read: async () => structuredClone(value), write: async next => { value = structuredClone(next); } };
};
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test('bridge rejects stale snapshots, searches note/highlight content and only reports acknowledged writes as saved', async () => {
  let time = 100000;
  const state = createBridgeState({ now: () => time });
  assert.throws(() => state.callTool('search_library', {}), /enable its local bridge sync/);
  state.sync({ library: fixture() });
  assert.equal(state.callTool('search_library', { query: 'reduced' }).total, 1);
  const queued = state.callTool('create_item', { type: 'note', title: 'A linked note', content: 'See design', relatedIds: ['first'] });
  assert.equal(queued.saved, false);
  const command = state.sync({ library: fixture() }).commands[0];
  assert.equal(command.id, queued.id);
  assert.equal(command.operation, 'saveItem');
  assert.match(command.args.id, /^item_/);
  assert.equal(state.callTool('get_operation', { id: queued.id }).status, 'queued');
  state.sync({ library: fixture(), acknowledgements: [{ id: queued.id, result: { id: command.args.id } }] });
  assert.equal(state.callTool('get_operation', { id: queued.id }).status, 'saved');
  assert.throws(() => state.callTool('create_item', { type: 'bookmark', title: 'Unsafe', url: 'javascript:alert(1)' }), /http or https/);
  assert.throws(() => state.callTool('update_item', { id: 'first', patch: { deletedAt: 'now' } }), /not supported/);
  time += 31000;
  assert.equal(state.callTool('bridge_status').connected, false);
  assert.throws(() => state.callTool('get_item', { id: 'first' }), /last 30 seconds/);
});

test('HTTP boundary enforces authentication, Host and Origin, and supports MCP JSON response mode', async () => {
  const state = createBridgeState();
  const server = createBridgeServer({ token: TOKEN, state });
  const url = await listen(server);
  try {
    assert.equal((await fetch(`${url}/status`)).status, 401);
    assert.equal((await fetch(`${url}/status`, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' } })).status, 403);
    // Fetch controls Host itself; use a raw HTTP request to actually send a hostile Host.
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const request = httpRequest(`${url}/status`, { headers: { Authorization: `Bearer ${TOKEN}`, Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      request.once('error', reject); request.end();
    });
    assert.equal(hostileHostStatus, 403);
    const allowed = await fetch(`${url}/status`, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: `chrome-extension://${'a'.repeat(32)}` } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), `chrome-extension://${'a'.repeat(32)}`);
    const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
    const invalid = await fetch(`${url}/sync`, { method: 'POST', headers, body: 'not-json' });
    assert.equal(invalid.status, 400);
    const initialize = await fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) });
    const data = await initialize.json();
    assert.equal(data.result.protocolVersion, '2025-06-18');
    assert.equal(data.result.serverInfo.name, 'still-library');
    const notification = await fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(notification.status, 202);
    const badMethod = await fetch(`${url}/mcp`, { method: 'GET', headers });
    assert.equal(badMethod.status, 405);
  } finally { await close(server); }
});

test('extension sync executes MCP edits through the real store, preserves linked notes and does not send credentials or file bytes', async () => {
  const state = createBridgeState();
  const server = createBridgeServer({ token: TOKEN, state });
  const url = await listen(server);
  let library = fixture();
  library.items[0].attachmentId = 'private-local-file';
  library.items[0].cover = 'data:image/png;base64,cHJpdmF0ZQ==';
  const core = createLibraryStore({ read: async () => library, write: async next => { library = next; } });
  const store = Object.fromEntries(['loadLibrary', 'saveItem', 'updateItem', 'deleteItem', 'createCollection'].map(name => [name, (...args) => core.dispatch(name, args)]));
  let outgoing;
  const fetcher = (url, options) => { if (options?.body) outgoing = JSON.parse(options.body); return fetch(url, options); };
  const client = createIntegrationClient({ storage: storageFixture(), store, fetch: fetcher });
  try {
    await client.configureBridge({ url, token: TOKEN });
    await client.syncBridgeOnce();
    assert.equal(outgoing.library.settings, undefined);
    assert.equal(outgoing.library.items[0].attachmentId, undefined);
    assert.equal(outgoing.library.items[0].cover, '');
    const queued = state.callTool('create_item', { type: 'note', title: 'Research synthesis', content: 'Connected evidence', relatedIds: ['first'], collectionId: 'design' });
    const status = await client.syncBridgeOnce();
    assert.equal(status.changed, true);
    const operation = state.callTool('get_operation', { id: queued.id });
    assert.equal(operation.status, 'saved');
    const note = library.items.find(entry => entry.id === operation.result.id);
    assert.equal(note.content, 'Connected evidence');
    assert.deepEqual(note.relatedIds, ['first']);
    const edit = state.callTool('update_item', { id: note.id, patch: { content: 'Revised evidence' } });
    await client.syncBridgeOnce();
    assert.equal(state.callTool('get_operation', { id: edit.id }).status, 'saved');
    assert.equal(state.callTool('get_item', { id: note.id }).item.content, 'Revised evidence');
    const trash = state.callTool('trash_item', { id: note.id });
    await client.syncBridgeOnce();
    assert.equal(state.callTool('get_operation', { id: trash.id }).status, 'saved');
    assert.ok(library.items.find(entry => entry.id === note.id).deletedAt);
    assert.equal(state.callTool('search_library', { query: 'synthesis' }).total, 0);
    await client.disconnectBridge();
    await assert.rejects(client.syncBridgeOnce(), /Configure and enable/);
  } finally { await close(server); }
});

test('MCP edits notes on local media while keeping captured article text separate and file bytes private', async () => {
  const state = createBridgeState();
  const server = createBridgeServer({ token: TOKEN, state });
  const url = await listen(server);
  let library = fixture();
  library.items[0].articleContent = 'A captured article about kinetic typography.';
  library.items.push(...['image', 'video'].map(type => ({
    id: `local_${type}`, type, title: `Local ${type}`, url: '', attachmentId: `private_${type}`,
    fileName: type === 'image' ? 'inspiration.png' : 'motion.mp4', mime: type === 'image' ? 'image/png' : 'video/mp4',
    content: 'Original local note', tags: [], highlights: [], relatedIds: [], collectionId: '',
  })));
  const core = createLibraryStore({ read: async () => library, write: async next => { library = next; } });
  const store = Object.fromEntries(['loadLibrary', 'saveItem', 'updateItem', 'deleteItem', 'createCollection'].map(name => [name, (...args) => core.dispatch(name, args)]));
  let outgoing;
  const client = createIntegrationClient({ storage: storageFixture(), store, fetch: (endpoint, options) => { if (options?.body) outgoing = JSON.parse(options.body); return fetch(endpoint, options); } });
  try {
    await client.configureBridge({ url, token: TOKEN });
    await client.syncBridgeOnce();
    assert.equal(state.callTool('search_library', { query: 'kinetic typography' }).total, 1);
    assert.equal(state.callTool('get_item', { id: 'first' }).item.articleContent, 'A captured article about kinetic typography.');
    assert.throws(() => state.callTool('update_item', { id: 'first', patch: { articleContent: 'Replace source text' } }), /not supported/);
    const articleEdit = state.callTool('update_item', { id: 'first', patch: { content: 'My annotation, separate from the page' } });
    const mediaEdits = ['image', 'video'].map(type => state.callTool('update_item', { id: `local_${type}`, patch: { content: `Updated ${type} note` } }));
    for (const type of ['image', 'video']) assert.throws(() => state.callTool('create_item', { type, title: 'New media without a source' }), /web URL/);
    await client.syncBridgeOnce();
    for (const operation of [articleEdit, ...mediaEdits]) assert.equal(state.callTool('get_operation', { id: operation.id }).status, 'saved');
    for (const type of ['image', 'video']) {
      const local = library.items.find(item => item.id === `local_${type}`);
      assert.equal(local.content, `Updated ${type} note`);
      assert.equal(local.attachmentId, `private_${type}`);
      assert.equal(outgoing.library.items.find(item => item.id === local.id).attachmentId, undefined);
      assert.equal(state.callTool('get_item', { id: local.id }).item.attachmentId, undefined);
    }
    const article = state.callTool('get_item', { id: 'first' }).item;
    assert.equal(article.content, 'My annotation, separate from the page');
    assert.equal(article.articleContent, 'A captured article about kinetic typography.');
  } finally { await close(server); }
});

test('stdio exchanges actual newline-delimited MCP initialize/list/search messages with authenticated HTTP bridge', async () => {
  const state = createBridgeState(); state.sync({ library: fixture() });
  const server = createBridgeServer({ token: TOKEN, state });
  const url = await listen(server);
  const input = new PassThrough(); const output = new PassThrough();
  let received = ''; output.setEncoding('utf8'); output.on('data', chunk => { received += chunk; });
  try {
    const job = runStdio({ input, output, config: { url, token: TOKEN } });
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_library', arguments: { query: 'spring' } } },
    ];
    const encoded = `${messages.map(message => JSON.stringify(message)).join('\n')}\n`;
    input.write(encoded.slice(0, 31)); input.end(encoded.slice(31));
    await job;
    const results = received.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(results.length, 3);
    assert.equal(results[0].result.serverInfo.name, 'still-library');
    assert.ok(results[1].result.tools.some(tool => tool.name === 'create_item'));
    assert.equal(JSON.parse(results[2].result.content[0].text).total, 1);
  } finally { await close(server); }
});

test('Raindrop import paginates 50-item pages, maps nested collections/notes/highlights and imports atomically', async () => {
  let imported;
  let seenToken;
  const requests = [];
  const mock = createServer((request, response) => {
    requests.push(request.url); seenToken = request.headers.authorization;
    let payload;
    if (request.url === '/collections') payload = { result: true, items: [{ _id: 7, title: 'Design' }] };
    else if (request.url === '/collections/childrens') payload = { result: true, items: [{ _id: 8, title: 'Motion', parent: { $id: 7 } }] };
    else if (request.url.includes('page=0')) payload = { result: true, items: Array.from({ length: 50 }, (_, index) => ({ _id: index + 1, type: 'article', title: `Article ${index}`, link: `https://example.com/${index}`, note: 'A note', collection: { $id: 8 }, tags: ['motion'], highlights: [{ _id: 'h1', text: 'Highlight', note: 'My annotation', color: 'blue' }] })) };
    else payload = { result: true, items: [{ _id: 51, title: 'Last bookmark', link: 'https://example.com/last' }] };
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload));
  });
  const url = await listen(mock);
  const client = createIntegrationClient({ storage: storageFixture(), store: { importLibrary: async library => { assert.equal(imported, undefined); imported = library; } }, fetch: (remote, options) => fetch(`${url}${new URL(remote).pathname.replace('/rest/v1', '')}${new URL(remote).search}`, options) });
  try {
    await client.setRaindropToken('local-test-token');
    const connection = await client.testRaindropConnection();
    assert.equal(connection.rootCollections, 1);
    const result = await client.importFromRaindrop();
    assert.equal(result.items, 51);
    assert.equal(imported.items[0].content, 'A note');
    assert.equal(imported.items[0].highlights[0].note, 'My annotation');
    assert.equal(imported.items[0].collectionId, 'raindrop-8');
    assert.equal(imported.collections[1].parentId, 'raindrop-7');
    assert.equal(seenToken, 'Bearer local-test-token');
    assert.equal(requests.filter(path => path.startsWith('/raindrops')).length, 2);
    assert.equal((await client.getIntegrationSettings()).raindropConfigured, true);
    assert.equal('raindropToken' in await client.getIntegrationSettings(), false);
  } finally { await close(mock); }
});

test('Raindrop failed page does not partially merge; sending a selected item maps notes and highlights', async () => {
  let imported = false;
  let sent;
  let fail = true;
  const client = createIntegrationClient({ storage: storageFixture({ raindropToken: 'test' }), store: { importLibrary: async () => { imported = true; } }, fetch: async (url, options) => {
    if (options.method === 'POST') { sent = JSON.parse(options.body); return Response.json({ result: true, item: { _id: 42 } }); }
    if (url.includes('/raindrops/') && fail) return Response.json({ error: 'Rate limit reached' }, { status: 429 });
    return Response.json({ result: true, items: [] });
  } });
  await assert.rejects(client.importFromRaindrop(), /Rate limit reached/);
  assert.equal(imported, false);
  const result = await client.sendToRaindrop({ ...item, content: 'My thoughts', favorite: true });
  assert.equal(result.id, 42);
  assert.equal(sent.note, 'My thoughts'); assert.equal(sent.important, true);
  assert.equal(sent.collection.$id, -1);
  assert.equal(sent.highlights[0].text, 'Reduced motion matters');
  await assert.rejects(client.sendToRaindrop({ type: 'note', content: 'No URL' }), /web URL/);
});

test('local config creates a unique secret once and generated client setup keeps secrets out', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'still-integration-'));
  const path = join(directory, 'config.json');
  try {
    const initial = await loadConfig(path, { create: true });
    const restored = await loadConfig(path);
    assert.equal(initial.token, restored.token);
    assert.ok(initial.token.length >= 32);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).token, initial.token);
    const setup = getMcpSetup();
    assert.match(setup.codex, /\[mcp_servers.still\]/);
    // User scope makes the entry available in every project, matching the in-app Connect action.
    assert.match(setup.claudeCommand, /--transport stdio --scope user still -- node/);
    assert.equal(setup.rootKnown, false); assert.match(setup.entry, /^\/path\/to\/sidebar-dock\/bridge\/mcp\.mjs$/);
    assert.equal(JSON.stringify(setup).includes('C:/dev'), false);
    assert.equal(JSON.stringify(setup).includes(initial.token), false);
    assert.equal(mapRaindropLibrary([], [{ _id: 1, link: 'https://example.com', collection: { $id: -1 } }]).items[0].collectionId, '');
  } finally { await unlink(path); await rmdir(directory); }
});

test('MCP setup snippets reproduce the exact node and adapter paths the bridge writes on each platform', async () => {
  const posix = getMcpSetup('/home/me/sidebar-dock/', { nodePath: '/usr/local/bin/node' });
  assert.equal(posix.entry, '/home/me/sidebar-dock/bridge/mcp.mjs');
  assert.equal(posix.claudeCommand, 'claude mcp add --transport stdio --scope user still -- "/usr/local/bin/node" "/home/me/sidebar-dock/bridge/mcp.mjs"');
  assert.equal(posix.codexCommand, 'codex mcp add still -- "/usr/local/bin/node" "/home/me/sidebar-dock/bridge/mcp.mjs"');
  assert.equal(posix.codex, '[mcp_servers.still]\ncommand = "/usr/local/bin/node"\nargs = ["/home/me/sidebar-dock/bridge/mcp.mjs"]\n');
  assert.deepEqual(JSON.parse(posix.claudeDesktop).mcpServers.still, { command: '/usr/local/bin/node', args: ['/home/me/sidebar-dock/bridge/mcp.mjs'] });
  assert.equal(JSON.parse(posix.cursor).mcpServers.still.type, 'stdio');
  const windows = getMcpSetup('C:\\Users\\me\\sidebar-dock\\', { nodePath: 'C:\\Program Files\\nodejs\\node.exe' });
  assert.equal(windows.entry, 'C:\\Users\\me\\sidebar-dock\\bridge\\mcp.mjs');
  assert.deepEqual(JSON.parse(windows.claude).mcpServers.still, { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Users\\me\\sidebar-dock\\bridge\\mcp.mjs'] });
  assert.equal(windows.configPath, 'C:\\Users\\me\\sidebar-dock\\bridge\\.local\\config.json');
});

test('bridge routes match the path even with a query string, and pinned extension IDs restrict extension origins', async () => {
  const state = createBridgeState();
  const pinned = 'b'.repeat(32);
  const server = createBridgeServer({ token: TOKEN, state, extensionIds: [pinned] });
  const url = await listen(server);
  try {
    const headers = { Authorization: `Bearer ${TOKEN}` };
    assert.equal((await fetch(`${url}/status?cache=1`, { headers })).status, 200);
    assert.equal((await fetch(`${url}/health?probe=1`)).status, 200);
    assert.equal((await fetch(`${url}/status`, { headers: { ...headers, Origin: `chrome-extension://${pinned}` } })).status, 200);
    assert.equal((await fetch(`${url}/status`, { headers: { ...headers, Origin: `chrome-extension://${'a'.repeat(32)}` } })).status, 403);
  } finally { await close(server); }
  const directory = await mkdtemp(join(tmpdir(), 'still-integration-'));
  const path = join(directory, 'config.json');
  try {
    await writeFile(path, JSON.stringify({ url: 'http://127.0.0.1:43123', token: TOKEN, extensionIds: [pinned] }));
    assert.deepEqual((await loadConfig(path)).extensionIds, [pinned]);
    await writeFile(path, JSON.stringify({ url: 'http://127.0.0.1:43123', token: TOKEN, extensionIds: ['not-an-id'] }));
    await assert.rejects(loadConfig(path), /extensionIds/);
  } finally { await unlink(path); await rmdir(directory); }
});
