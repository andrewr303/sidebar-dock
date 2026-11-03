import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeState, TOOLS } from '../bridge/protocol.mjs';
import { createIntegrationClient } from '../extension/lib/integrations.js';
import { createLibraryStore } from '../extension/lib/store.js';
import { chatItemId } from '../extension/lib/threadkeeper/protocol.js';

const KEY = 'chatgpt:acct_chatgpt_primary:ws_personal:abc:main';
const PRIVATE = 'claude:acct:ws:private:main';
const at = '2026-10-28T09:00:00.000Z';
const chatItem = (threadKey, overrides = {}) => ({ id: chatItemId(threadKey), type: 'chat', title: 'Lisbon trip', url: '', excerpt: 'Booked flights to Lisbon.',
  sourceUrl: 'https://chatgpt.com/c/abc', siteName: 'ChatGPT', tags: [], collectionId: '', relatedIds: [], updatedAt: at,
  chat: { v: 1, source: 'threadkeeper', threadKey, provider: 'chatgpt', providerLabel: 'ChatGPT', category: 'chat', project: 'Travel', messageCount: 12,
    lastActivityAt: '2026-10-02T10:00:00.000Z', topics: ['flights'], removed: '' }, ...overrides });
const library = () => ({ schemaVersion: 1, updatedAt: at, settings: {}, collections: [],
  items: [
    { id: 'note', type: 'note', title: 'Reading list', content: 'x', tags: [], collectionId: '', relatedIds: [], updatedAt: at },
    chatItem(KEY),
    chatItem(PRIVATE, { title: 'Private thread', chat: { v: 1, source: 'threadkeeper', threadKey: PRIVATE, removed: 'local_only' } }),
  ] });

test('chats are searchable and filterable through the bridge, never creatable or convertible', () => {
  const state = createBridgeState();
  state.sync({ library: library() });
  const capabilities = state.callTool('library_capabilities');
  assert.ok(capabilities.itemTypes.includes('chat'));
  assert.ok(!capabilities.creatableItemTypes.includes('chat'));
  assert.ok(capabilities.pages.parentTypes.includes('chat'), 'a chat can hold subpage notes');
  for (const name of ['search_library', 'list_items', 'semantic_search', 'export_library']) {
    assert.ok(TOOLS.find(tool => tool.name === name).inputSchema.properties.type.enum.includes('chat'), name);
  }
  assert.ok(!TOOLS.find(tool => tool.name === 'create_item').inputSchema.properties.type.enum.includes('chat'));
  assert.ok(!TOOLS.find(tool => tool.name === 'update_item').inputSchema.properties.patch.properties.type.enum.includes('chat'));
  assert.throws(() => state.callTool('create_item', { type: 'chat', title: 'Forged' }), /unsupported value/);

  const listed = state.callTool('list_items', { type: 'chat' });
  assert.deepEqual(listed.items.map(item => item.id), [chatItemId(KEY)], 'a private chat is not in the bridge snapshot');
  assert.deepEqual(listed.items[0].chat, { provider: 'chatgpt', providerLabel: 'ChatGPT', category: 'chat', project: 'Travel', messageCount: 12, lastActivityAt: '2026-10-02T10:00:00.000Z' });
  assert.equal(state.callTool('search_library', { query: 'travel flights' }).items[0].id, chatItemId(KEY));
  assert.throws(() => state.callTool('get_item', { id: chatItemId(PRIVATE) }), /not found/i);
  const markdown = state.callTool('export_item', { id: chatItemId(KEY), format: 'markdown' }).content;
  assert.match(markdown, /AI chat from ChatGPT · project Travel · 12 messages · last active 2026-10-02 · topics: flights/);
  assert.match(markdown, /Original conversation: https:\/\/chatgpt\.com\/c\/abc/);

  assert.throws(() => state.callTool('update_item', { id: chatItemId(KEY), patch: { type: 'note' } }), /cannot be converted/);
  assert.throws(() => state.callTool('update_item', { id: chatItemId(KEY), patch: { url: 'https://example.com' } }), /no link of its own/);
  const queued = state.callTool('update_item', { id: chatItemId(KEY), patch: { tags: ['trip'], title: 'My trip' } });
  assert.equal(queued.status, 'queued');
});

test('the extension never posts a private chat to the bridge', async () => {
  let posted = null;
  const fetchStub = async (url, init) => {
    if (String(url).endsWith('/sync')) posted = JSON.parse(init.body);
    return new Response(JSON.stringify({ syncedAt: at, commands: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  let stored = null;
  const core = createLibraryStore({ read: async () => stored, write: async value => { stored = value; } });
  await core.dispatch('loadLibrary', [library()]);
  const store = { loadLibrary: () => core.dispatch('loadLibrary', []) };
  let settings = {};
  const original = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    const client = createIntegrationClient({ storage: { read: async () => settings, write: async value => { settings = value; } }, store });
    await client.configureBridge({ url: 'http://127.0.0.1:9', token: 'mcp-tools-test-token-longer-than-twenty-four' });
    await client.syncBridgeOnce();
  } finally { globalThis.fetch = original; }
  assert.ok(posted, 'a snapshot was posted');
  assert.deepEqual(posted.library.items.map(item => item.id).sort(), ['note', chatItemId(KEY)].sort());
});
