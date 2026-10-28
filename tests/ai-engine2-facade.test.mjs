import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as ai from '../extension/lib/ai/index.js';

const SPEC_EXPORTS = ['CATALOG', 'listConnections', 'saveConnection', 'deleteConnection', 'testConnection', 'listModels', 'getAiSettings', 'setAiSettings', 'streamChat',
  'runAssistant', 'transformText', 'suggestForSave', 'searchLibrary', 'relatedItems', 'getIndexStatus', 'subscribeIndex', 'startIndexing', 'rebuildIndex', 'clearIndex',
  'handoffUrl', 'buildHandoffPrompt', 'listConversations', 'getConversation', 'saveConversation', 'deleteConversation', 'init'];

test('the facade exposes the SPEC 7.2 API (plus pauseIndexing and the semanticSearch adapters) with explicit re-exports', async () => {
  for (const name of SPEC_EXPORTS) assert.ok(name in ai, name);
  // Beyond SPEC 7.2: indexing control, the bridge search adapter, and helpers the settings and assistant UIs need.
  assert.deepEqual(Object.keys(ai).filter(name => !SPEC_EXPORTS.includes(name)).sort(), ['ANTHROPIC_EFFORTS', 'DEFAULT_AI_SETTINGS', 'EFFORT_LABELS', 'EFFORT_LEVELS',
    'HANDOFF_TARGETS', 'cancelChatGptSignIn', 'chatGptSignInStatus', 'chatProviders', 'cliSignInStatus', 'embeddingProviders', 'ensureHostPermission', 'getBridgeStatus',
    'getProvider', 'handoffPlan', 'hostPermissionOrigins', 'onConnectionsChanged', 'pairBridge', 'pauseIndexing', 'resolveChatTarget', 'semanticSearch',
    'semanticSearchAvailable', 'startChatGptSignIn', 'undoProposal']);
  assert.ok(Array.isArray(ai.CATALOG) && ai.CATALOG.length > 5);
  for (const name of SPEC_EXPORTS.filter(name => name !== 'CATALOG')) assert.equal(typeof ai[name], 'function', name);
  const source = await readFile(new URL('../extension/lib/ai/index.js', import.meta.url), 'utf8');
  assert.ok(!/export\s*\*/.test(source), 'no export *');
});

test('init wires the app store and library hook; search, the semanticSearch adapter and history work without an index', async () => {
  const library = {
    updatedAt: '2026-10-28T00:00:00.000Z',
    collections: [{ id: 'design', name: 'Design', parentId: '' }],
    items: [
      { id: 'calm', type: 'article', title: 'Calm interface design', url: 'https://example.com/calm', excerpt: 'Quiet tools.', content: '', articleContent: 'Restraint and spacing.', tags: ['design'], collectionId: 'design', highlights: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
      { id: 'kyoto', type: 'bookmark', title: 'Kyoto temples', url: 'https://example.com/kyoto', excerpt: '', content: '', articleContent: '', tags: [], collectionId: '', highlights: [], createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' },
    ],
  };
  const listeners = [];
  const handle = ai.init({ store: { loadLibrary: async () => library }, getLibrary: () => library, onLibraryChange: listener => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); } });
  const status = await handle.ready;
  assert.equal(status.enabled, false, 'semantic search is opt-in');
  assert.equal(listeners.length, 1);
  listeners[0](library);
  assert.deepEqual(ai.getIndexStatus().enabled, false);
  const seen = [];
  const unsubscribe = ai.subscribeIndex(value => seen.push(value));
  assert.equal(seen.length, 1);
  unsubscribe();

  const results = await ai.searchLibrary('calm design', { limit: 5 });
  assert.deepEqual(results.map(result => [result.id, result.source]), [['calm', 'lexical']]);
  assert.deepEqual(await ai.relatedItems('calm'), []);
  const adapter = await ai.semanticSearch('kyoto', { limit: 3, collectionId: '' });
  assert.deepEqual(adapter.results, [{ id: 'kyoto', title: 'Kyoto temples', type: 'bookmark', url: 'https://example.com/kyoto', score: adapter.results[0].score, snippet: '', source: 'lexical' }]);
  assert.equal(adapter.index.enabled, false);
  assert.equal(await ai.semanticSearchAvailable(), false, 'the bridge does not advertise semantic_search while the index is off');
  assert.deepEqual((await ai.semanticSearch('calm', { type: 'note' })).results, []);

  const saved = await ai.saveConversation({ messages: [{ role: 'user', text: 'Hello there' }] });
  assert.equal((await ai.listConversations())[0].id, saved.id);
  assert.equal((await ai.getConversation(saved.id)).title, 'Hello there');
  await ai.deleteConversation(saved.id);
  assert.equal(await ai.getConversation(saved.id), null);

  const suggestion = await ai.suggestForSave({ url: 'https://example.com/a', title: 'Design systems that stay calm', collections: library.collections, tags: [{ name: 'design', count: 3 }] });
  assert.equal(suggestion.source, 'heuristic', 'no AI connection: the heuristic answers');
  assert.equal(suggestion.collectionId, 'design');
  handle.dispose();
  assert.equal(listeners.length, 0);
});

test('init hands the semanticSearch adapter to the bridge client and removes it on dispose', async () => {
  const hooks = [];
  const integrations = { setBridgeSearch: (search, options = {}) => hooks.push({ search, available: options.available }) };
  const library = { updatedAt: '1', collections: [], items: [] };
  const handle = ai.init({ store: { loadLibrary: async () => library }, getLibrary: () => library, integrations, onLibraryChange: () => () => {} });
  await handle.ready;
  assert.equal(hooks[0].search, ai.semanticSearch);
  assert.equal(hooks[0].available, ai.semanticSearchAvailable);
  handle.dispose();
  assert.equal(hooks.at(-1).search, null);
});

test('undoProposal reverts an applied proposal from its saved record through the app store', async () => {
  const { createLibraryStore } = await import('../extension/lib/store.js');
  const { createToolSession } = await import('../extension/lib/ai/tools.js');
  let state = null;
  const library = createLibraryStore({ read: async () => state, write: async next => { state = next; } });
  const op = (name, ...args) => library.dispatch(name, args);
  await op('loadLibrary', { schemaVersion: 1, collections: [], items: [{ id: 'kyoto', type: 'bookmark', title: 'Kyoto', url: 'https://example.com/kyoto', tags: ['japan'] }] });
  const store = { loadLibrary: () => op('loadLibrary'), bulkUpdateItems: (changes, options = {}) => op('bulkUpdateItems', changes, options), createCollection: input => op('createCollection', input),
    saveItem: input => op('saveItem', input), deleteItem: (id, options = {}) => op('deleteItem', id, options), permanentlyDeleteItem: (id, options = {}) => op('permanentlyDeleteItem', id, options),
    deleteCollection: (id, options = {}) => op('deleteCollection', id, options) };
  const getLibrary = () => store.loadLibrary();
  const handle = ai.init({ store, getLibrary, onLibraryChange: () => () => {} });
  await handle.ready;
  const session = createToolSession({ getLibrary, searchLibrary: async () => [], store, onProposal: async () => 'apply' });
  await session.execute([{ id: 'a', name: 'add_tags', input: { ids: ['kyoto'], tags: ['trip'] } }, { id: 'b', name: 'create_collection', input: { name: 'Trips' } }]);
  assert.deepEqual((await getLibrary()).items[0].tags, ['japan', 'trip']);
  const saved = JSON.parse(JSON.stringify(session.proposals[0].undo));
  assert.deepEqual(await ai.undoProposal(saved), { reverted: 2, kept: 0 });
  const after = await getLibrary();
  assert.deepEqual(after.items[0].tags, ['japan']);
  assert.deepEqual(after.collections, []);
  assert.deepEqual(await ai.undoProposal(null), { reverted: 0, kept: 0 });
  handle.dispose();
});
