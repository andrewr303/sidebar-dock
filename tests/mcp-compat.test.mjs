import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createBridgeServer } from '../bridge/server.mjs';
import { createBridgeState, TOOLS, DESTRUCTIVE_TOOLS, SUPPORTED_PROTOCOL_VERSIONS, SERVER_VERSION, PROMPTS, RESOURCE_TEMPLATES, initializeResult, toolAllowed } from '../bridge/protocol.mjs';
import { runStdio } from '../bridge/mcp.mjs';

const TOKEN = 'compat-primary-token-longer-than-twenty-four';
const READ_TOKEN = 'compat-read-token-longer-than-twenty-four';
const WRITE_TOKEN = 'compat-write-token-longer-than-twenty-four';
const at = '2026-10-30T10:00:00.000Z';
const fixture = () => ({ schemaVersion: 1, updatedAt: at,
  collections: [{ id: 'research', name: 'Research', description: 'Reading for the motion project', updatedAt: at }, { id: 'inbox-sorted', name: 'Sorted', parentId: 'research', updatedAt: at }],
  items: [
    { id: 'motion', type: 'article', title: 'Accessible motion', url: 'https://example.com/motion', excerpt: 'Respect reduced motion preferences.', articleContent: 'Vestibular disorders matter.', content: 'My take', tags: ['motion'], collectionId: 'research', relatedIds: [], updatedAt: '2026-10-29T10:00:00.000Z' },
    { id: 'pinned', type: 'note', title: 'Pinned plan', content: 'Plan the motion audit', tags: [], collectionId: 'research', pinned: true, relatedIds: [], updatedAt: '2026-10-01T10:00:00.000Z' },
    { id: 'fresh', type: 'bookmark', title: 'Fresh link', url: 'https://example.com/fresh', tags: [], collectionId: '', relatedIds: [], updatedAt: at },
    { id: 'archived', type: 'note', title: 'Archived motion note', content: 'Old', archived: true, relatedIds: [], updatedAt: at },
    { id: 'binned', type: 'note', title: 'Binned motion note', content: 'Gone', deletedAt: at, relatedIds: [], updatedAt: at },
  ] });

async function harness(t, { state = createBridgeState(), synced = true, ...options } = {}) {
  if (synced) state.sync({ library: fixture(), semanticSearch: true });
  const server = createBridgeServer({ token: TOKEN, state, tokens: [{ name: 'reader', scope: 'read', token: READ_TOKEN }, { name: 'writer', scope: 'write', token: WRITE_TOKEN }], ...options });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  let id = 0;
  const post = (body, { token = TOKEN, headers = {}, path = '/mcp' } = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const rpc = async (method, params, options) => (await (await post({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }, options)).json());
  const call = async (name, args = {}, options) => (await rpc('tools/call', { name, arguments: args }, options)).result;
  return { url, state, post, rpc, call, port: server.address().port };
}
const rawStatus = (port, path, headers) => new Promise((resolve, reject) => {
  const request = httpRequest({ host: '127.0.0.1', port, path, headers }, response => { response.resume(); resolve(response.statusCode); });
  request.once('error', reject); request.end();
});

test('Streamable HTTP edge cases follow MCP 2025-11-25', async t => {
  const h = await harness(t);
  const unsupported = await h.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { 'MCP-Protocol-Version': '1999-01-01' } });
  assert.equal(unsupported.status, 400);
  const unsupportedBody = await unsupported.json();
  assert.equal(unsupportedBody.id, null); assert.equal(unsupportedBody.error.code, -32600);
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) assert.equal((await h.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { 'MCP-Protocol-Version': version } })).status, 200);
  // Client responses and notifications are accepted without a body.
  for (const body of [{ jsonrpc: '2.0', id: 'server-1', result: {} }, { jsonrpc: '2.0', id: 7, error: { code: -1, message: 'declined' } }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } }]) {
    const response = await h.post(body);
    assert.equal(response.status, 202); assert.equal(await response.text(), '');
  }
  const unknown = await h.rpc('tools/call', { name: 'nope', arguments: {} });
  assert.deepEqual(unknown.error, { code: -32602, message: 'Unknown tool: nope' });
  const invalidArguments = await h.call('get_item', { id: 'motion', extra: true });
  assert.equal(invalidArguments.isError, true); assert.equal(invalidArguments.structuredContent.error.code, 'INVALID_ARGUMENT');
  const malformed = await h.post('{"jsonrpc":');
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  const oversized = await h.post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(16 * 1024 * 1024) } }));
  assert.equal(oversized.status, 413); assert.equal((await oversized.json()).error.code, -32600);
  for (const method of ['GET', 'DELETE']) {
    const response = await fetch(`${h.url}/mcp`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 405, method); assert.equal(response.headers.get('Allow'), 'POST');
  }
  const slash = await h.post({ jsonrpc: '2.0', id: 2, method: 'ping' }, { path: '/mcp/' });
  assert.equal(slash.status, 200); assert.deepEqual((await slash.json()).result, {});
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server/mcp']) {
    const response = await fetch(`${h.url}${path}`);
    assert.equal(response.status, 404, path); assert.match((await response.json()).error, /bearer token/);
  }
  const unauthenticated = await fetch(`${h.url}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(unauthenticated.status, 401); assert.equal(unauthenticated.headers.get('WWW-Authenticate'), 'Bearer realm="still"');
  const preflight = await fetch(`${h.url}/mcp`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:6274' } });
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Mcp-Session-Id/); assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Last-Event-ID/);
  assert.match(preflight.headers.get('Access-Control-Expose-Headers'), /MCP-Protocol-Version/);
});

test('initialize advertises Still with the package version, resources, prompts and completions', async t => {
  const h = await harness(t, { synced: false });
  const { result } = await h.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'paperclip', version: '1' } });
  const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.deepEqual(result.serverInfo, { name: 'still-library', title: 'Still', version: packageVersion });
  assert.equal(SERVER_VERSION, packageVersion);
  assert.deepEqual(result.capabilities, { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false }, completions: {} });
  assert.match(result.instructions, /still:\/\/item\/<id>/); assert.match(result.instructions, /untrusted/);
  assert.equal(initializeResult({ protocolVersion: '1999-01-01' }).protocolVersion, '2025-11-25');
});

test('tool annotations follow the access-profile policy and every tool has a title', () => {
  assert.equal(TOOLS.length, 33);
  assert.deepEqual(TOOLS.filter(tool => tool.annotations.destructiveHint).map(tool => tool.name).sort(), ['bulk_update_items', 'delete_collection', 'permanently_delete_item', 'remove_tag', 'rename_tag', 'update_article_content']);
  assert.deepEqual([...DESTRUCTIVE_TOOLS].sort(), TOOLS.filter(tool => tool.annotations.destructiveHint).map(tool => tool.name).sort());
  const reads = ['bridge_status', 'library_capabilities', 'search_library', 'semantic_search', 'list_items', 'get_item', 'get_related_items', 'list_collections', 'get_collection', 'list_tags', 'export_item', 'export_library', 'read_file', 'get_operation'];
  assert.deepEqual(TOOLS.filter(tool => tool.annotations.readOnlyHint).map(tool => tool.name).sort(), [...reads].sort());
  for (const tool of TOOLS) {
    assert.equal(typeof tool.title, 'string', tool.name); assert.ok(tool.title.length > 2 && tool.title !== tool.name, tool.name);
    if (!tool.annotations.readOnlyHint) assert.equal(tool.annotations.readOnlyHint, false, tool.name);
    if (!tool.annotations.readOnlyHint && !DESTRUCTIVE_TOOLS.includes(tool.name)) assert.equal(tool.annotations.destructiveHint, false, tool.name);
  }
  for (const name of ['update_item', 'set_item_tags', 'update_collection', 'update_highlight', 'remove_highlight', 'unlink_items', 'move_page', 'trash_item']) assert.equal(TOOLS.find(tool => tool.name === name).annotations.destructiveHint, false, name);
  assert.deepEqual(TOOLS.filter(tool => tool._meta).map(tool => tool.name).sort(), ['export_item', 'export_library', 'get_item', 'get_operation', 'read_file']);
  assert.equal(TOOLS.find(tool => tool.name === 'get_item')._meta['anthropic/maxResultSizeChars'], 200000);
  assert.equal(toolAllowed(TOOLS[0], 'unknown-scope'), false);
});

test('scoped tokens see and call only their tools and cannot reach non-MCP routes', async t => {
  const h = await harness(t);
  const readTools = (await h.rpc('tools/list', {}, { token: READ_TOKEN })).result.tools;
  assert.ok(readTools.length > 0 && readTools.every(tool => tool.annotations.readOnlyHint === true));
  const writeTools = (await h.rpc('tools/list', {}, { token: WRITE_TOKEN })).result.tools.map(tool => tool.name);
  assert.equal(writeTools.length, 27);
  for (const name of DESTRUCTIVE_TOOLS) assert.equal(writeTools.includes(name), false, name);
  assert.ok(writeTools.includes('update_item') && writeTools.includes('create_item'));
  assert.equal((await h.rpc('tools/list', {}, {})).result.tools.length, 33);
  assert.equal((await h.call('search_library', { query: 'motion' }, { token: READ_TOKEN })).structuredContent.total, 2);
  const denied = await h.call('create_item', { type: 'note', title: 'Nope' }, { token: READ_TOKEN });
  assert.equal(denied.isError, true); assert.equal(denied.structuredContent.error.code, 'SCOPE_DENIED'); assert.match(denied.structuredContent.error.message, /read access/);
  assert.equal(h.state.status().pending, 0, 'a denied call queues nothing');
  assert.equal((await h.call('create_item', { type: 'note', title: 'Allowed' }, { token: WRITE_TOKEN })).structuredContent.status, 'queued');
  const destructive = await h.call('remove_tag', { tag: 'motion' }, { token: WRITE_TOKEN });
  assert.equal(destructive.structuredContent.error.code, 'SCOPE_DENIED');
  assert.equal((await h.rpc('tools/call', { name: 'nope' }, { token: READ_TOKEN })).error.code, -32602);
  // Resources are read-only, so every scope may read them.
  assert.equal((await h.rpc('resources/read', { uri: 'still://item/motion' }, { token: READ_TOKEN })).result.contents.length, 1);
  for (const token of [READ_TOKEN, WRITE_TOKEN]) {
    assert.equal((await fetch(`${h.url}/status`, { headers: { Authorization: `Bearer ${token}` } })).status, 403);
    assert.equal((await h.post({ library: fixture() }, { token, path: '/sync' })).status, 403);
    assert.equal((await fetch(`${h.url}/connections`, { headers: { Authorization: `Bearer ${token}` } })).status, 403);
  }
  assert.equal((await fetch(`${h.url}/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
  assert.equal((await fetch(`${h.url}/status`, { headers: { Authorization: `Bearer ${READ_TOKEN}x` } })).status, 401);
});

test('scoped tokens can come from a function, so tokens created while running work at once', async t => {
  let tokens = [];
  const h = await harness(t, { tokens: () => tokens });
  assert.equal((await h.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: READ_TOKEN })).status, 401);
  tokens = [{ name: 'paperclip', scope: 'read', token: READ_TOKEN }];
  assert.equal((await h.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: READ_TOKEN })).status, 200);
});

test('allowedHosts accepts extra Host names while other hosts stay rejected', async t => {
  const plain = await harness(t);
  const headers = { Authorization: `Bearer ${TOKEN}` };
  assert.equal(await rawStatus(plain.port, '/status', { ...headers, Host: `host.docker.internal:${plain.port}` }), 403);
  const docker = await harness(t, { allowedHosts: ['host.docker.internal'] });
  assert.equal(await rawStatus(docker.port, '/status', { ...headers, Host: `host.docker.internal:${docker.port}` }), 200);
  assert.equal(await rawStatus(docker.port, '/status', { ...headers, Host: 'HOST.DOCKER.INTERNAL' }), 200);
  assert.equal(await rawStatus(docker.port, '/status', { ...headers, Host: 'evil.example' }), 403);
  assert.equal(await rawStatus(docker.port, '/status', { ...headers, Host: `[::1]:${docker.port}` }), 200);
  assert.equal(await rawStatus(docker.port, '/status', { ...headers, Host: `host.docker.internal:${docker.port}`, Origin: 'https://evil.example' }), 403, 'Origin rules are unchanged');
});

test('resources list pinned and recent items first, paginate with a cursor and read as Markdown', async t => {
  const h = await harness(t);
  const first = (await h.rpc('resources/list', {})).result;
  assert.deepEqual(first.resources.map(resource => resource.uri), ['still://item/pinned', 'still://item/fresh', 'still://item/motion', 'still://collection/research', 'still://collection/inbox-sorted']);
  assert.equal(first.nextCursor, undefined);
  const motion = first.resources.find(resource => resource.name === 'motion');
  assert.deepEqual(motion, { uri: 'still://item/motion', name: 'motion', title: 'Accessible motion', description: 'Respect reduced motion preferences.', mimeType: 'text/markdown', annotations: { lastModified: '2026-10-29T10:00:00.000Z' } });
  // 60 items page at 50 with an opaque cursor.
  const big = fixture(); big.items = Array.from({ length: 60 }, (_, i) => ({ id: `item-${String(i).padStart(2, '0')}`, type: 'note', title: `Note ${i}`, content: 'x', relatedIds: [], updatedAt: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z` }));
  h.state.sync({ library: big });
  const page1 = (await h.rpc('resources/list', {})).result;
  assert.equal(page1.resources.length, 50); assert.equal(typeof page1.nextCursor, 'string');
  const page2 = (await h.rpc('resources/list', { cursor: page1.nextCursor })).result;
  assert.equal(page2.resources.length, 12); assert.equal(page2.nextCursor, undefined);
  assert.equal(new Set([...page1.resources, ...page2.resources].map(resource => resource.uri)).size, 62);
  assert.equal((await h.rpc('resources/list', { cursor: 'not a cursor!' })).error.code, -32602);
  h.state.sync({ library: fixture() });
  const item = (await h.rpc('resources/read', { uri: 'still://item/motion' })).result.contents[0];
  assert.equal(item.uri, 'still://item/motion'); assert.equal(item.mimeType, 'text/markdown');
  assert.match(item.text, /^# Accessible motion/); assert.match(item.text, /Vestibular disorders matter/); assert.match(item.text, /## Personal notes\n\nMy take/);
  assert.match((await h.rpc('resources/read', { uri: 'still://item/archived' })).result.contents[0].text, /Archived motion note/);
  const collection = (await h.rpc('resources/read', { uri: 'still://collection/research' })).result.contents[0].text;
  assert.match(collection, /^# Research/); assert.match(collection, /\[Accessible motion\]\(still:\/\/item\/motion\) — https:\/\/example.com\/motion/); assert.match(collection, /\[Sorted\]\(still:\/\/collection\/inbox-sorted\)/);
  const search = (await h.rpc('resources/read', { uri: 'still://search/motion%20audit' })).result.contents[0].text;
  assert.match(search, /^# Search: motion audit/); assert.match(search, /still:\/\/item\/pinned/); assert.doesNotMatch(search, /binned/);
  for (const uri of ['still://item/binned', 'still://item/ghost', 'still://collection/ghost', 'https://example.com', 'still://item/%E0%A4%A']) {
    assert.deepEqual((await h.rpc('resources/read', { uri })).error, { code: -32002, message: 'Resource not found', data: { uri } }, uri);
  }
  const templates = (await h.rpc('resources/templates/list', {})).result.resourceTemplates;
  assert.deepEqual(templates.map(template => template.uriTemplate), ['still://item/{id}', 'still://collection/{id}', 'still://search/{query}']);
  assert.deepEqual(templates, RESOURCE_TEMPLATES);
});

test('resources explain a missing sync with a JSON-RPC error', async t => {
  const h = await harness(t, { synced: false });
  for (const [method, params] of [['resources/list', {}], ['resources/read', { uri: 'still://item/motion' }]]) {
    const { error } = await h.rpc(method, params);
    assert.equal(error.code, -32000); assert.match(error.message, /Open Still/); assert.equal(error.data.code, 'STALE_SNAPSHOT');
  }
  assert.equal((await h.rpc('resources/templates/list', {})).result.resourceTemplates.length, 3);
});

test('prompts list and render tool-using instructions; completion suggests item and collection IDs', async t => {
  const h = await harness(t);
  const prompts = (await h.rpc('prompts/list', {})).result.prompts;
  assert.deepEqual(prompts.map(prompt => prompt.name), ['research', 'brief_collection', 'triage_inbox', 'task_context', 'save_page']);
  assert.deepEqual(prompts, PROMPTS);
  const research = (await h.rpc('prompts/get', { name: 'research', arguments: { topic: 'reduced motion' } })).result;
  assert.equal(research.messages.length, 1); assert.equal(research.messages[0].role, 'user'); assert.equal(research.messages[0].content.type, 'text');
  assert.match(research.messages[0].content.text, /search_library/); assert.match(research.messages[0].content.text, /semantic_search/); assert.match(research.messages[0].content.text, /\[\[item_id\]\]/);
  assert.match(research.messages[0].content.text, /prefix/);
  const task = (await h.rpc('prompts/get', { name: 'task_context', arguments: { task: 'PAP-12: Audit motion in onboarding' } })).result.messages[0].content.text;
  assert.match(task, /PAP-12: Audit motion in onboarding/); assert.match(task, /Only if I ask/); assert.match(task, /IDs and URLs/);
  assert.match((await h.rpc('prompts/get', { name: 'brief_collection', arguments: { collectionId: 'research' } })).result.messages[0].content.text, /collectionId "research"/);
  assert.match((await h.rpc('prompts/get', { name: 'triage_inbox' })).result.messages[0].content.text, /confirm/);
  assert.match((await h.rpc('prompts/get', { name: 'save_page', arguments: { url: 'https://example.com/new', collectionId: 'research' } })).result.messages[0].content.text, /collectionId "research"/);
  for (const params of [{ name: 'nope' }, { name: 'research', arguments: {} }, { name: 'save_page', arguments: { url: 'javascript:alert(1)' } }, { name: 'research', arguments: { topic: 5 } }]) assert.equal((await h.rpc('prompts/get', params)).error.code, -32602, JSON.stringify(params));
  const collections = (await h.rpc('completion/complete', { ref: { type: 'ref/prompt', name: 'brief_collection' }, argument: { name: 'collectionId', value: 'sort' } })).result.completion;
  assert.deepEqual(collections, { values: ['inbox-sorted'], total: 1, hasMore: false });
  const items = (await h.rpc('completion/complete', { ref: { type: 'ref/resource', uri: 'still://item/{id}' }, argument: { name: 'id', value: 'MOTION' } })).result.completion;
  assert.deepEqual(items.values.sort(), ['archived', 'motion'], 'id prefix or title substring; trashed items are left out');
  assert.deepEqual((await h.rpc('completion/complete', { ref: { type: 'ref/prompt', name: 'research' }, argument: { name: 'topic', value: 'm' } })).result.completion, { values: [], hasMore: false });
});

test('Paperclip context headers label receipts, and semantic_search answers within Paperclip\'s gateway timeout', async t => {
  const state = createBridgeState({ searchTimeoutMs: 5000, paperclipSearchTimeoutMs: 30 });
  const h = await harness(t, { state });
  const headers = { 'X-Paperclip-Agent-Id': 'agent-7', 'X-Paperclip-Issue-Id': 'issue_42', 'X-Paperclip-Run-Id': 'run-1', 'X-Paperclip-Company-Id': 'acme', 'X-Paperclip-Correlation-Id': 'ignored' };
  const queued = (await h.call('create_item', { type: 'note', title: 'From an agent' }, { token: WRITE_TOKEN, headers })).structuredContent;
  const receipt = (await h.call('get_operation', { id: queued.id })).structuredContent;
  assert.deepEqual(receipt.origin, { client: 'paperclip', agentId: 'agent-7', issueId: 'issue_42', runId: 'run-1', companyId: 'acme' });
  const command = state.sync({ library: fixture(), semanticSearch: true }).commands.find(entry => entry.id === queued.id);
  assert.deepEqual(Object.keys(command), ['id', 'operation', 'args'], 'the extension contract is unchanged');
  const plain = (await h.call('create_item', { type: 'note', title: 'From a person' })).structuredContent;
  assert.equal((await h.call('get_operation', { id: plain.id })).structuredContent.origin, undefined);
  const invalid = (await h.call('create_item', { type: 'note', title: 'Odd headers' }, { headers: { 'X-Paperclip-Agent-Id': 'x'.repeat(200) } })).structuredContent;
  assert.equal((await h.call('get_operation', { id: invalid.id })).structuredContent.origin, undefined, 'unvalidated header values are dropped');
  const started = Date.now();
  const timedOut = await h.call('semantic_search', { query: 'calm motion' }, { headers: { 'X-Paperclip-Run-Id': 'run-2' } });
  assert.equal(timedOut.structuredContent.error.code, 'SEARCH_TIMEOUT');
  assert.ok(Date.now() - started < 2000, 'Paperclip searches use the shorter wait');
});

test('a call with the scoped paperclip token or Paperclip\'s User-Agent counts as Paperclip without context headers', async t => {
  const PAPERCLIP_TOKEN = 'compat-paperclip-token-longer-than-twenty-four';
  const state = createBridgeState({ searchTimeoutMs: 5000, paperclipSearchTimeoutMs: 30 });
  const h = await harness(t, { state, tokens: [{ name: 'paperclip', scope: 'write', token: PAPERCLIP_TOKEN }, { name: 'writer', scope: 'write', token: WRITE_TOKEN }] });
  for (const options of [{ token: PAPERCLIP_TOKEN }, { token: WRITE_TOKEN, headers: { 'User-Agent': 'Paperclip/1.0' } }]) {
    const started = Date.now();
    const timedOut = await h.call('semantic_search', { query: 'calm motion' }, options);
    assert.equal(timedOut.structuredContent.error.code, 'SEARCH_TIMEOUT');
    assert.ok(Date.now() - started < 2000, 'the shorter Paperclip wait applies');
  }
  const queued = (await h.call('create_item', { type: 'note', title: 'From Paperclip' }, { token: PAPERCLIP_TOKEN })).structuredContent;
  assert.deepEqual((await h.call('get_operation', { id: queued.id })).structuredContent.origin, { client: 'paperclip' });
  const other = (await h.call('create_item', { type: 'note', title: 'From another agent' }, { token: WRITE_TOKEN })).structuredContent;
  assert.equal((await h.call('get_operation', { id: other.id })).structuredContent.origin, undefined, 'other scoped tokens are not labelled Paperclip');
});

test('the stdio adapter retries a missing configuration, so starting the bridge later works without a client restart', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const lines = []; let pending = '';
  output.setEncoding('utf8'); output.on('data', chunk => { pending += chunk; let end; while ((end = pending.indexOf('\n')) !== -1) { lines.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1); } });
  let clock = 0, loads = 0, available = false, fetched = 0;
  const load = async () => { loads += 1; if (!available) throw new Error('Start the Still bridge (npm run bridge) first to create its local configuration.'); return { url: 'http://127.0.0.1:9', token: TOKEN }; };
  const fetcher = async (url, init) => { fetched += 1; const { id } = JSON.parse(init.body); return Response.json({ jsonrpc: '2.0', id, result: { forwarded: true } }); };
  const job = runStdio({ input, output, load, fetch: fetcher, now: () => clock, retryConfigMs: 1000 });
  const send = async message => { const before = lines.length; input.write(`${JSON.stringify(message)}\n`); while (lines.length === before) await new Promise(resolve => setImmediate(resolve)); return lines.at(-1); };
  const status = id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'bridge_status', arguments: {} } });
  assert.equal((await send(status(1))).result.structuredContent.error.code, 'BRIDGE_UNAVAILABLE');
  assert.equal(loads, 1, 'no reload inside the retry interval');
  available = true; clock = 500;
  assert.equal((await send(status(2))).result.structuredContent.error.code, 'BRIDGE_UNAVAILABLE');
  assert.equal(loads, 1);
  clock = 1500;
  assert.deepEqual((await send(status(3))).result, { forwarded: true });
  assert.equal(loads, 2); assert.equal(fetched, 1);
  clock = 5000;
  assert.deepEqual((await send(status(4))).result, { forwarded: true });
  assert.equal(loads, 2, 'a loaded configuration is kept'); assert.equal(fetched, 2);
  input.end(); await job;
});

test('the stdio adapter answers locally when the configuration is missing or the bridge is down', async () => {
  const exchange = async (options, messages) => {
    const input = new PassThrough(), output = new PassThrough();
    let received = ''; output.setEncoding('utf8'); output.on('data', chunk => { received += chunk; });
    const job = runStdio({ input, output, ...options });
    input.end(`${messages.map(message => JSON.stringify(message)).join('\n')}\n`);
    await job;
    return received.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_library', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'resources/list' },
    { jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'research', arguments: { topic: 'motion' } } },
    { jsonrpc: '2.0', id: 6, method: 'ping' },
    { jsonrpc: '2.0', id: 7, method: 'logging/setLevel', params: { level: 'info' } },
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope' } },
  ];
  const missing = await exchange({ load: async () => { throw new Error('Start the Still bridge (npm run bridge) first to create its local configuration.'); } }, messages);
  const down = await exchange({ config: { url: 'http://127.0.0.1:9', token: TOKEN }, fetch: async () => { throw new TypeError('fetch failed'); } }, messages);
  for (const results of [missing, down]) {
    assert.deepEqual(results.map(result => result.id), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(results[0].result.serverInfo.name, 'still-library'); assert.equal(results[0].result.protocolVersion, '2025-06-18');
    assert.equal(results[1].result.tools.length, 33);
    assert.equal(results[2].result.isError, true); assert.equal(results[2].result.structuredContent.error.code, 'BRIDGE_UNAVAILABLE'); assert.match(results[2].result.structuredContent.error.action, /npm run bridge/);
    assert.deepEqual(results[3].result, { resources: [] });
    assert.match(results[4].result.messages[0].content.text, /motion/);
    assert.deepEqual(results[5].result, {});
    assert.equal(results[6].error.code, -32000);
    assert.equal(results[7].error.code, -32602);
    assert.equal(JSON.stringify(results).includes(TOKEN), false);
  }
  // A JSON-RPC error answer from the bridge passes through unchanged.
  const passthrough = await exchange({ config: { url: 'http://127.0.0.1:9', token: TOKEN }, fetch: async () => Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Unsupported MCP-Protocol-Version.' } }, { status: 400 }) }, [{ jsonrpc: '2.0', id: 9, method: 'ping' }]);
  assert.deepEqual(passthrough, [{ jsonrpc: '2.0', id: 9, error: { code: -32600, message: 'Unsupported MCP-Protocol-Version.' } }]);
});

test('Paperclip setup and revoke routes need the pairing token and come before generic connection routes', async t => {
  const calls = [];
  const connections = {
    listConnections: async () => [],
    previewConnection: async id => { calls.push(['preview', id]); return { clientId: id, canConnect: false }; },
    paperclipSetup: async options => { calls.push(['setup', options]); return { clientId: 'paperclip', scope: options.scope || 'write', token: 'issued-token-value-longer-than-24' }; },
    paperclipRevoke: async () => { calls.push(['revoke']); return { removed: true }; },
  };
  const h = await harness(t, { connections });
  const setup = await h.post({ scope: 'read', rotate: true }, { path: '/connections/paperclip/setup' });
  assert.equal(setup.status, 200); assert.equal((await setup.json()).scope, 'read');
  const empty = await fetch(`${h.url}/connections/paperclip/setup`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(empty.status, 200);
  assert.equal((await h.post({ scope: 'admin' }, { path: '/connections/paperclip/setup' })).status, 400);
  assert.equal((await h.post({ rotate: 'yes' }, { path: '/connections/paperclip/setup' })).status, 400);
  assert.deepEqual(await (await h.post({}, { path: '/connections/paperclip/revoke' })).json(), { removed: true });
  assert.equal((await fetch(`${h.url}/connections/paperclip/setup`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 405);
  for (const token of [READ_TOKEN, WRITE_TOKEN]) assert.equal((await h.post({}, { token, path: '/connections/paperclip/setup' })).status, 403);
  assert.equal((await h.post({}, { path: '/connections/paperclip/preview' })).status, 200);
  assert.deepEqual(calls, [['setup', { scope: 'read', rotate: true }], ['setup', { rotate: false }], ['revoke'], ['preview', 'paperclip']]);
});
