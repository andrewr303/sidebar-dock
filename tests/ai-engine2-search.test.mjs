import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, parseQuery, lexicalSearch, makeSnippet, plainText, cosine, dot, centroid, semanticRank, reciprocalRankFusion, semanticHead, itemMatcher, createSearch } from '../extension/lib/ai/search.js';
import { createVectorStore } from '../extension/lib/ai/vector-store.js';
import { normalizeVector } from '../extension/lib/ai/embeddings.js';
import { queryItems } from '../extension/lib/store.js';

const library = {
  updatedAt: '2026-10-28T00:00:00.000Z',
  collections: [{ id: 'travel', name: 'Travel', parentId: '' }, { id: 'japan', name: 'Japan', parentId: 'travel' }, { id: 'design', name: 'Design', parentId: '' }],
  items: [
    { id: 'kyoto', type: 'article', title: 'Kyoto temples in autumn', url: 'https://travel.example.com/kyoto', excerpt: 'A walking guide.', content: '', articleContent: 'Kinkaku-ji and Fushimi Inari are best early in the morning. Autumn leaves peak in November.', tags: ['travel', 'japan'], collectionId: 'japan', highlights: [{ text: 'best early in the morning', note: 'plan for 7am' }], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
    { id: 'ramen', type: 'note', title: 'Ramen list', content: '# Tokyo ramen\n- [ ] Ichiran\n- [ ] Afuri yuzu shio', excerpt: 'Tokyo ramen', tags: ['food'], collectionId: 'travel', highlights: [], createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' },
    { id: 'calm', type: 'article', title: 'Calm interface design', url: 'https://design.example.com/calm', excerpt: 'Quiet tools respect attention.', content: 'My take: fewer colors.', articleContent: 'Design systems that stay calm use restraint, spacing and typography.', tags: ['design', 'ui'], collectionId: 'design', highlights: [], createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z' },
    { id: 'colors', type: 'bookmark', title: 'Color palettes for interfaces', url: 'https://colors.example.com', excerpt: 'Palette generator.', content: '', articleContent: '', tags: ['design'], collectionId: 'design', highlights: [], createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z' },
    { id: 'archived', type: 'bookmark', title: 'Old design notes', url: 'https://old.example.com', excerpt: '', content: 'design design design', articleContent: '', tags: ['design'], collectionId: 'design', archived: true, highlights: [], createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' },
    { id: 'trash', type: 'bookmark', title: 'Kyoto hotel deals', url: 'https://spam.example.com', excerpt: 'Kyoto Kyoto Kyoto', content: '', articleContent: '', tags: ['japan'], collectionId: 'japan', deletedAt: '2026-10-06T00:00:00.000Z', highlights: [], createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z' },
    { id: 'tokyo-cjk', type: 'note', title: '東京の旅行メモ', content: '浅草と上野を歩く。', excerpt: '', tags: [], collectionId: '', highlights: [], createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' },
  ],
};
const ids = results => results.map(result => result.id);

test('tokenizer folds case, accents and plurals and splits CJK into bigrams', () => {
  assert.deepEqual(tokenize('Cafés, Temples & Interfaces!'), ['cafe', 'temple', 'interface']);
  assert.deepEqual(tokenize('class status'), ['class', 'status']);
  assert.deepEqual(tokenize('Libraries'), ['library']);
  assert.deepEqual(tokenize('東京の旅'), ['東京', '京の', 'の旅']);
  assert.deepEqual(tokenize('2027年'), ['2027', '年']);
});

test('query syntax matches store.queryItems: tag:, #, type: and quoted phrases', () => {
  const parsed = parseQuery('the best #Travel type:article "early in the morning" Kyoto');
  assert.deepEqual(parsed.tags, ['travel']);
  assert.equal(parsed.type, 'article');
  assert.deepEqual(parsed.phrases, ['early in the morning']);
  assert.deepEqual(parsed.terms, ['best', 'kyoto']);
  assert.equal(parsed.semanticText, 'the best kyoto early in the morning');
  // Filter-only queries return the same set as the store's own filter, newest first.
  for (const query of ['tag:design', '#japan type:article', '"fewer colors"', 'type:note']) {
    const expected = queryItems(library, { query }).map(item => item.id).sort();
    assert.deepEqual(ids(lexicalSearch(library.items, query)).sort(), expected, query);
  }
  assert.deepEqual(ids(lexicalSearch(library.items, 'tag:design')), ['colors', 'calm']);
  assert.deepEqual(lexicalSearch(library.items, 'tag:missing calm'), []);
});

test('lexical scoring weights titles and tags, rewards full coverage, prefixes short fields and never returns trash', () => {
  const kyoto = lexicalSearch(library.items, 'kyoto');
  assert.deepEqual(ids(kyoto), ['kyoto']);
  const design = lexicalSearch(library.items, 'design');
  assert.equal(design[0].id, 'calm', 'a title match outranks tag-only matches');
  assert.ok(ids(design).includes('colors'));
  assert.ok(!ids(design).includes('archived'), 'archived items are excluded unless asked for');
  assert.ok(ids(lexicalSearch(library.items, 'design', { allow: itemMatcher(library, { archived: 'all' }) })).includes('archived'));
  const both = lexicalSearch(library.items, 'calm palettes');
  assert.ok(both.length === 2 && both.every(hit => hit.score > 0));
  const coverage = lexicalSearch(library.items, 'calm interface');
  assert.equal(coverage[0].id, 'calm', 'matching every term beats matching one');
  assert.ok(coverage[0].score > coverage[1].score);
  assert.deepEqual(ids(lexicalSearch(library.items, 'palet')), ['colors'], 'as-you-type prefixes match titles');
  assert.deepEqual(ids(lexicalSearch(library.items, '浅草')), ['tokyo-cjk']);
  assert.deepEqual(ids(lexicalSearch(library.items, 'Kyoto', { allow: itemMatcher(library, { collectionId: 'travel' }) })), ['kyoto'], 'collections include descendants');
  assert.deepEqual(ids(lexicalSearch(library.items, 'kyoto', { allow: itemMatcher(library, { collectionId: 'travel', includeDescendants: false }) })), []);
  const hit = lexicalSearch(library.items, 'morning')[0];
  assert.match(hit.snippet, /best early in the morning/);
  // Deterministic: the same query gives the same order every time.
  assert.deepEqual(ids(lexicalSearch(library.items, 'design ui')), ids(lexicalSearch(library.items, 'design ui')));
});

test('snippets center on the first match and plain text strips Markdown', () => {
  const long = `${'Intro words here. '.repeat(30)}The important part mentions Fushimi Inari at dawn. ${'Tail words. '.repeat(30)}`;
  const snippet = makeSnippet(long, ['fushimi'], 120);
  assert.match(snippet, /^….*Fushimi Inari.*…$/);
  assert.ok(snippet.length <= 125);
  assert.equal(plainText('# Title\n- [ ] Task with **bold** and [link](https://x.y) and [[Note|Label]]'), 'Title Task with bold and link and Label');
});

test('cosine, centroids and reciprocal-rank fusion are deterministic', () => {
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosine([1, 1], [2, 2]) - 1) < 1e-9);
  assert.ok(Number.isNaN(dot([1], [1, 2])));
  const mean = centroid([normalizeVector([1, 0]), normalizeVector([0, 1])]);
  assert.ok(Math.abs(mean[0] - Math.SQRT1_2) < 1e-6 && Math.abs(mean[1] - Math.SQRT1_2) < 1e-6);
  const chunks = [
    { itemId: 'a', n: 0, vector: normalizeVector([1, 0]) }, { itemId: 'a', n: 1, vector: normalizeVector([0.6, 0.8]) },
    { itemId: 'b', n: 0, vector: normalizeVector([0.8, 0.6]) }, { itemId: 'c', n: 0, vector: normalizeVector([0, 1]) },
  ];
  const ranked = semanticRank(normalizeVector([1, 0]), chunks, { allow: id => id !== 'c' });
  assert.deepEqual(ranked.map(entry => entry.id), ['a', 'b']);
  assert.equal(ranked[0].chunk.n, 0, 'item score is its best chunk');
  const fused = reciprocalRankFusion([['x', 'y', 'z'], ['y', 'w', 'x']]);
  assert.deepEqual(fused.map(row => row.id), ['y', 'x', 'w', 'z']);
  assert.ok(Math.abs(fused[0].score - (1 / 62 + 1 / 61)) < 1e-12);
  assert.deepEqual(fused[0].ranks, [2, 1]);
  // Ties break on best single rank, then id, regardless of list order.
  assert.deepEqual(reciprocalRankFusion([['b'], ['a']]).map(row => row.id), ['a', 'b']);
  assert.deepEqual(reciprocalRankFusion([['a'], ['b']]).map(row => row.id), ['a', 'b']);
  assert.deepEqual(semanticHead([{ id: 'a', score: 0.8 }, { id: 'b', score: 0.6 }, { id: 'c', score: 0.5 }], { size: 5, relative: 0.7 }).map(entry => entry.id), ['a', 'b']);
});

// A concept-level fake embedding: words map to topic axes so "temples" and "shrines" land close together.
const TOPICS = { travel: ['kyoto', 'temple', 'shrine', 'autumn', 'tokyo', 'ramen', 'trip', 'japan', 'inari', 'kinkaku'], design: ['design', 'calm', 'interface', 'color', 'palette', 'typography', 'quiet'], food: ['ramen', 'shio', 'food', 'noodle'] };
const embedText = input => normalizeVector([...Object.values(TOPICS).map(words => tokenize(input).filter(token => words.includes(token)).length), 0.05]);

async function semanticFixture() {
  const vectorStore = createVectorStore({ indexedDB: null });
  await vectorStore.ensureConfig({ providerId: 'fake', model: 'fake' });
  for (const item of library.items.filter(entry => !entry.deletedAt)) {
    const text = [item.title, item.excerpt, item.content, item.articleContent, ...(item.tags || [])].join(' ');
    await vectorStore.putItem(item.id, { hash: item.id, chunks: [{ n: 0, text: item.articleContent || item.content || item.excerpt || item.title, vector: embedText(text) }] });
  }
  return vectorStore;
}

test('hybrid search fuses lexical and semantic ranks and finds conceptual matches with no shared words', async () => {
  const vectorStore = await semanticFixture();
  let embedded = 0;
  const search = createSearch({ getLibrary: async () => library, vectorStore, isSemanticReady: async () => true, embedQuery: async query => { embedded++; return embedText(query); } });
  const shrines = await search.searchLibrary('shrines trip', { limit: 5 });
  assert.equal(shrines[0].id, 'kyoto', 'semantic match without the word "kyoto"');
  assert.equal(shrines[0].source, 'semantic');
  assert.ok(shrines[0].snippet.length > 0);
  assert.ok(!ids(shrines).includes('trash'));
  const hybrid = await search.searchLibrary('calm design', { limit: 5 });
  assert.equal(hybrid[0].id, 'calm');
  assert.equal(hybrid[0].source, 'both');
  assert.equal(hybrid[0].title, 'Calm interface design');
  assert.equal(hybrid[0].url, 'https://design.example.com/calm');
  const filtered = await search.searchLibrary('calm design', { filter: { collectionId: 'travel' } });
  assert.deepEqual(filtered, []);
  const typed = await search.searchLibrary('type:note ramen');
  assert.ok(typed.every(hit => library.items.find(item => item.id === hit.id).type === 'note'));
  const lexicalOnly = await search.searchLibrary('shrines trip', { mode: 'lexical' });
  assert.deepEqual(lexicalOnly, []);
  const semanticOnly = await search.searchLibrary('palette', { mode: 'semantic', limit: 2 });
  assert.ok(semanticOnly.every(hit => hit.source === 'semantic') && semanticOnly.length <= 2);
  const before = embedded;
  await search.searchLibrary('shrines trip');
  assert.equal(embedded, before, 'query vectors are cached');
});

test('search degrades to lexical when the index is off or the query cannot be embedded', async () => {
  const vectorStore = await semanticFixture();
  const off = createSearch({ getLibrary: async () => library, vectorStore, isSemanticReady: async () => false, embedQuery: async () => { throw new Error('should not embed'); } });
  const offResults = await off.searchLibrary('calm design', { mode: 'semantic' });
  assert.equal(offResults[0].id, 'calm');
  assert.ok(offResults.every(hit => hit.source === 'lexical'));
  const failing = createSearch({ getLibrary: async () => library, vectorStore, isSemanticReady: async () => true, embedQuery: async () => { throw new Error('Rate limited'); } });
  const failed = await failing.searchLibrary('kyoto');
  assert.deepEqual(ids(failed), ['kyoto']);
  assert.equal(failed[0].source, 'lexical');
  assert.deepEqual(await off.relatedItems('calm'), []);
});

test('related items rank by centroid similarity and exclude the item itself and trash', async () => {
  const vectorStore = await semanticFixture();
  await vectorStore.putItem('trash', { hash: 't', chunks: [{ n: 0, text: 'Calm design palette', vector: embedText('calm design palette') }] });
  const search = createSearch({ getLibrary: async () => library, vectorStore, isSemanticReady: async () => true, embedQuery: async query => embedText(query) });
  const related = await search.relatedItems('calm', { limit: 3 });
  assert.ok(related.length >= 2);
  // Archived items stay eligible (only Trash is excluded); both design items outrank travel items.
  assert.deepEqual(ids(related).slice(0, 2).sort(), ['archived', 'colors']);
  assert.ok(!ids(related).includes('calm') && !ids(related).includes('trash') && !ids(related).includes('kyoto'));
  assert.ok(related.every(entry => typeof entry.score === 'number' && entry.title));
  assert.deepEqual(await search.relatedItems('missing'), []);
});

test('warming tokenizes the library ahead of the first search without changing results', async () => {
  const search = createSearch({ getLibrary: async () => library });
  const cold = await createSearch({ getLibrary: async () => library }).searchLibrary('calm design');
  await search.warm({ slice: 2 });
  assert.deepEqual(await search.searchLibrary('calm design'), cold);
});
