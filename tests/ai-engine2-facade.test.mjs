import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as ai from '../extension/lib/ai/index.js';

const SPEC_EXPORTS = ['CATALOG', 'listConnections', 'saveConnection', 'deleteConnection', 'testConnection', 'listModels', 'getAiSettings', 'setAiSettings', 'streamChat',
  'runAssistant', 'transformText', 'suggestForSave', 'searchLibrary', 'relatedItems', 'getIndexStatus', 'subscribeIndex', 'startIndexing', 'rebuildIndex', 'clearIndex',
  'handoffUrl', 'buildHandoffPrompt', 'listConversations', 'getConversation', 'saveConversation', 'deleteConversation', 'init'];

test('the facade exposes the SPEC 7.2 API (plus pauseIndexing and the semanticSearch adapter) with explicit re-exports', async () => {
  for (const name of SPEC_EXPORTS) assert.ok(name in ai, name);
  assert.deepEqual(Object.keys(ai).filter(name => !SPEC_EXPORTS.includes(name)).sort(), ['pauseIndexing', 'semanticSearch']);
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
