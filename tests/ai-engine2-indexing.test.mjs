import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, contentHash, itemChunks, itemHash, itemIndexText, planIndex, createIndexer, CHUNK_SIZE } from '../extension/lib/ai/indexer.js';
import { createVectorStore } from '../extension/lib/ai/vector-store.js';
import { batchInputs, buildEmbeddingRequest, parseEmbeddingResponse, normalizeVector, createEmbedder, embeddingKind, isRetryable } from '../extension/lib/ai/embeddings.js';

const sentence = n => `Sentence number ${n} talks about calm interfaces and quiet tools.`;
const paragraphs = (count, perParagraph) => Array.from({ length: count }, (_, p) => Array.from({ length: perParagraph }, (_, s) => sentence(p * 10 + s)).join(' ')).join('\n\n');

test('chunking keeps short text whole and cuts long text near the size at paragraph or sentence boundaries with overlap', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('  Short note.  '), ['Short note.']);
  const longText = paragraphs(12, 6);
  const chunks = chunkText(longText);
  assert.ok(chunks.length > 3);
  for (const chunk of chunks) assert.ok(chunk.length <= CHUNK_SIZE, `chunk of ${chunk.length} chars`);
  for (const chunk of chunks.slice(0, -1)) assert.match(chunk, /[.!?]$/, 'every cut lands on a sentence end');
  // Neighbours share text (the overlap), and nothing from the source is lost.
  for (let i = 1; i < chunks.length; i++) {
    const tail = chunks[i - 1].slice(-60);
    const head = chunks[i].slice(0, 200);
    assert.ok(tail.split(' ').slice(-3).some(word => head.includes(word)), `chunk ${i} overlaps its predecessor`);
  }
  const words = new Set(longText.split(/\s+/));
  const covered = new Set(chunks.join(' ').split(/\s+/));
  for (const word of words) assert.ok(covered.has(word));
  // Text without spaces still terminates with bounded chunks.
  const solid = 'x'.repeat(5000);
  const hard = chunkText(solid, { size: 1200, overlap: 150 });
  assert.ok(hard.every(chunk => chunk.length <= 1200));
  assert.equal(hard.at(-1).at(-1), 'x');
  assert.equal(chunkText(longText, { maxChunks: 2 }).length, 2);
});

test('item text combines title, tags, source, description, note, article and highlights; notes skip a duplicate excerpt', () => {
  const item = { id: 'a', title: 'Calm design', url: 'https://www.example.com/post', tags: ['design', 'ui'], excerpt: 'A summary.', content: 'My note.', articleContent: 'Article body.',
    highlights: [{ text: 'Quiet tools win.', note: 'Agree' }] };
  const { header, body } = itemIndexText(item);
  assert.equal(header, 'Calm design\nTags: design, ui\nSource: example.com');
  assert.match(body, /A summary\.[\s\S]*My note\.[\s\S]*Article body\.[\s\S]*> Quiet tools win\.\nAgree/);
  const note = itemIndexText({ id: 'n', type: 'note', title: 'N', excerpt: 'Planning the trip to Kyoto in spring…', content: 'Planning the trip to Kyoto in spring with friends.' });
  assert.equal(note.body, 'Planning the trip to Kyoto in spring with friends.');
  const chunks = itemChunks(item);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].input.startsWith(header));
  assert.equal(chunks[0].text, body);
  assert.deepEqual(itemChunks({ id: 'b', title: 'Only a title' }).map(c => c.input), ['Only a title']);
});

test('content hashes are stable, content-sensitive and drive incremental index plans', () => {
  assert.equal(contentHash('abc'), contentHash('abc'));
  assert.notEqual(contentHash('abc'), contentHash('abd'));
  assert.match(contentHash(''), /^[0-9a-f]{14}$/);
  const items = [
    { id: 'same', title: 'Same', content: 'unchanged' },
    { id: 'edited', title: 'Edited', content: 'new text' },
    { id: 'fresh', title: 'Fresh' },
    { id: 'trashed', title: 'Trashed', deletedAt: '2026-10-01T00:00:00.000Z' },
    { id: 'failed', title: 'Failed' },
  ];
  const states = new Map([
    ['same', { hash: itemHash(items[0]) }],
    ['edited', { hash: itemHash({ id: 'edited', title: 'Edited', content: 'old text' }) }],
    ['trashed', { hash: 'x' }],
    ['gone', { hash: 'y' }],
    ['failed', { hash: itemHash(items[4]), error: 'Too long' }],
  ]);
  const plan = planIndex(items, states);
  assert.deepEqual(plan.toIndex.map(entry => entry.item.id), ['edited', 'fresh']);
  assert.deepEqual(plan.toDelete.sort(), ['gone', 'trashed']);
  assert.equal(plan.indexed, 1);
  assert.equal(plan.failed, 1);
  assert.equal(plan.total, 4);
  // Metadata the index does not read (favorite, collection) does not trigger re-embedding.
  assert.equal(itemHash({ ...items[0], favorite: true, collectionId: 'x' }), itemHash(items[0]));
});

// A deterministic fake embedding: letter frequencies folded into 16 dimensions.
const fakeVector = input => { const v = new Array(16).fill(0); for (const ch of String(input).toLowerCase()) if (/[a-z]/.test(ch)) v[ch.charCodeAt(0) % 16] += 1; v[15] += 0.01; return v; };
function fakeEmbedder({ fail } = {}) {
  const calls = [];
  return {
    calls,
    async describe() { return { providerId: 'fake', provider: 'Fake', via: 'direct', defaultModel: 'fake-embed' }; },
    async embed({ inputs, inputType, model, signal }) {
      calls.push({ inputs, inputType, model });
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (fail) { const bad = inputs.findIndex(fail); if (bad >= 0) { const error = new Error('Input rejected'); error.status = 400; throw error; } }
      const vectors = inputs.map(input => normalizeVector(fakeVector(input)));
      return { vectors, model, dims: 16, usage: { tokens: 1 } };
    },
  };
}
function fakeLocks() {
  return { held: false, async request(name, options, callback) { if (this.held) return callback(null); this.held = true; try { return await callback({ name }); } finally { this.held = false; } } };
}
function manualTimers() {
  const pending = new Map();
  let next = 1;
  return { schedule: (fn) => { const id = next++; pending.set(id, fn); return id; }, cancel: id => pending.delete(id), flush: async () => { const fns = [...pending.values()]; pending.clear(); for (const fn of fns) await fn(); }, get size() { return pending.size; } };
}

test('indexer embeds only changed items, removes vectors of trashed items, and reports progress', async () => {
  let library = { items: [
    { id: 'a', title: 'Kyoto temples', content: paragraphs(3, 8), updatedAt: '1' },
    { id: 'b', title: 'Tokyo food', content: 'Ramen and sushi.', updatedAt: '1' },
    { id: 'c', title: 'Old trash', deletedAt: 'now', updatedAt: '1' },
  ] };
  let settings = { embeddings: { enabled: true, connectionId: 'c1', model: 'fake-embed' } };
  const vectorStore = createVectorStore({ indexedDB: null });
  const embedder = fakeEmbedder();
  const timers = manualTimers();
  const indexer = createIndexer({ vectorStore, embedder, getLibrary: async () => library, getSettings: async () => settings, locks: fakeLocks(), batchSize: 4, ...timers });
  const statuses = [];
  indexer.subscribeIndex(status => statuses.push(status));
  const done = await indexer.startIndexing();
  assert.equal(done.enabled, true);
  assert.equal(done.indexed, 2);
  assert.equal(done.pending, 0);
  assert.equal(done.total, 2);
  assert.equal(done.dims, 16);
  assert.equal(done.provider, 'Fake');
  assert.ok(done.lastRunAt);
  assert.ok(statuses.some(status => status.running));
  assert.ok(embedder.calls.every(call => call.inputs.length <= 4 && call.inputType === 'document'));
  const chunksA = await vectorStore.chunksFor('a');
  assert.ok(chunksA.length > 1);
  assert.deepEqual(chunksA.map(chunk => chunk.n), chunksA.map((_, n) => n));
  assert.ok(chunksA.every(chunk => chunk.vector instanceof Float32Array && chunk.key === `a#${chunk.n}`));

  // Edit b, trash a, add d: only b and d are embedded again, a's vectors are removed.
  const before = embedder.calls.length;
  library = { items: [
    { id: 'a', title: 'Kyoto temples', content: paragraphs(3, 8), updatedAt: '2', deletedAt: 'now' },
    { id: 'b', title: 'Tokyo food', content: 'Ramen, sushi and coffee.', updatedAt: '2' },
    { id: 'd', title: 'Osaka castle', updatedAt: '2' },
  ] };
  indexer.onLibraryChange(library);
  assert.equal(timers.size, 1, 'library changes are debounced');
  indexer.onLibraryChange(library);
  assert.equal(timers.size, 1);
  await timers.flush();
  const status = indexer.getIndexStatus();
  assert.equal(status.indexed, 2);
  const embedded = embedder.calls.slice(before).flatMap(call => call.inputs);
  assert.ok(embedded.some(input => input.includes('coffee')) && embedded.some(input => input.includes('Osaka')));
  assert.ok(!embedded.some(input => input.includes('Kyoto')));
  assert.equal((await vectorStore.chunksFor('a')).length, 0);
  assert.deepEqual([...(await vectorStore.itemStates()).keys()].sort(), ['b', 'd']);

  // Changing the model clears the store and re-embeds everything.
  settings = { embeddings: { enabled: true, connectionId: 'c1', model: 'fake-embed-2' } };
  const calls = embedder.calls.length;
  await indexer.refresh();
  assert.equal(indexer.getIndexStatus().model, 'fake-embed-2');
  assert.equal((await vectorStore.getConfig()).model, 'fake-embed-2');
  assert.ok(embedder.calls.length > calls);
  assert.ok(embedder.calls.slice(calls).every(call => call.model === 'fake-embed-2'));
  assert.equal(await indexer.isReady(), true);
});

test('indexing is opt-in, one view leads via Web Locks, and pause/clear hold automatic runs', async () => {
  const library = { items: [{ id: 'a', title: 'Alpha', updatedAt: '1' }, { id: 'b', title: 'Beta', updatedAt: '1' }] };
  let settings = { embeddings: { enabled: false } };
  const vectorStore = createVectorStore({ indexedDB: null });
  const embedder = fakeEmbedder();
  const locks = fakeLocks();
  const timers = manualTimers();
  const indexer = createIndexer({ vectorStore, embedder, getLibrary: async () => library, getSettings: async () => settings, locks, retryMs: 1000, ...timers });
  await assert.rejects(indexer.startIndexing(), /Turn on semantic search/);
  assert.equal((await indexer.refresh()).enabled, false);
  assert.equal(embedder.calls.length, 0);
  assert.equal(await indexer.isReady(), false);

  settings = { embeddings: { enabled: true, connectionId: 'c1' } };
  locks.held = true; // another view holds 'still.indexer'
  const waiting = await indexer.refresh();
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.pending, 2);
  assert.equal(embedder.calls.length, 0);
  assert.equal(timers.size, 1, 'a follower retries later');
  locks.held = false;
  await timers.flush();
  assert.equal(indexer.getIndexStatus().indexed, 2);
  assert.equal(indexer.getIndexStatus().model, 'fake-embed', 'the provider default model is used when none is set');

  await indexer.pauseIndexing();
  assert.equal(indexer.getIndexStatus().paused, true);
  indexer.onLibraryChange(library);
  assert.equal(timers.size, 0, 'paused indexers ignore library changes');

  const cleared = await indexer.clearIndex();
  assert.equal(cleared.indexed, 0);
  assert.equal(cleared.pending, 2);
  assert.deepEqual(await vectorStore.allChunks(), []);
  const rebuilt = await indexer.rebuildIndex();
  assert.equal(rebuilt.indexed, 2);
  assert.equal(rebuilt.paused, false);
});

test('an input the provider rejects is skipped without blocking the rest of the index', async () => {
  const library = { items: [{ id: 'good', title: 'Good item', updatedAt: '1' }, { id: 'bad', title: 'POISON item', updatedAt: '1' }, { id: 'ok', title: 'Fine item', updatedAt: '1' }] };
  const vectorStore = createVectorStore({ indexedDB: null });
  const embedder = fakeEmbedder({ fail: input => input.includes('POISON') });
  const indexer = createIndexer({ vectorStore, embedder, getLibrary: async () => library, getSettings: async () => ({ embeddings: { enabled: true, connectionId: 'c1' } }), locks: null, batchSize: 10 });
  const status = await indexer.startIndexing();
  assert.equal(status.indexed, 2);
  assert.equal(status.failed, 1);
  assert.equal(status.error, '');
  assert.match((await vectorStore.itemStates()).get('bad').error, /rejected/);
  // An unchanged failed item is not retried on the next run.
  const calls = embedder.calls.length;
  await indexer.startIndexing();
  assert.equal(embedder.calls.length, calls);
});

test('embedding requests match each provider and responses are normalized in input order', () => {
  const inputs = ['one', 'two'];
  const openai = buildEmbeddingRequest('openai', { apiKey: 'k', model: 'text-embedding-3-small', inputs, dimensions: 512 });
  assert.equal(openai.url, 'https://api.openai.com/v1/embeddings');
  assert.equal(openai.headers.Authorization, 'Bearer k');
  assert.deepEqual(openai.body, { model: 'text-embedding-3-small', input: inputs, encoding_format: 'float', dimensions: 512 });
  assert.equal(buildEmbeddingRequest('openai', { baseUrl: 'http://localhost:1234/v1/', model: 'nomic', inputs, dimensions: 512 }).body.dimensions, undefined);
  const voyage = buildEmbeddingRequest('voyage', { baseUrl: 'https://api.voyageai.com/v1', apiKey: 'v', model: 'voyage-4', inputs, inputType: 'query', dimensions: 1024 });
  assert.equal(voyage.url, 'https://api.voyageai.com/v1/embeddings');
  assert.deepEqual(voyage.body, { input: inputs, model: 'voyage-4', input_type: 'query', truncation: true, output_dimension: 1024 });
  const gemini = buildEmbeddingRequest('gemini', { apiKey: 'g', model: 'models/gemini-embedding-001', inputs, inputType: 'document', dimensions: 768 });
  assert.equal(gemini.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents');
  assert.equal(gemini.headers['x-goog-api-key'], 'g');
  assert.equal(gemini.headers.Authorization, undefined);
  assert.deepEqual(gemini.body.requests[0], { model: 'models/gemini-embedding-001', content: { parts: [{ text: 'one' }] }, taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768 });
  const gemini2 = buildEmbeddingRequest('gemini', { model: 'gemini-embedding-2', inputs: ['q'], inputType: 'query' });
  assert.equal(gemini2.body.requests[0].taskType, undefined);
  assert.match(gemini2.body.requests[0].content.parts[0].text, /^task: search result \| query: q$/);
  assert.equal(buildEmbeddingRequest('ollama', { baseUrl: 'http://localhost:11434/api', model: 'embeddinggemma', inputs }).url, 'http://localhost:11434/api/embed');
  const cohere = buildEmbeddingRequest('cohere', { baseUrl: 'https://api.cohere.com/v2', model: 'embed-v5.0-fast', inputs, inputType: 'query' });
  assert.equal(cohere.url, 'https://api.cohere.com/v2/embed');
  assert.equal(cohere.body.input_type, 'search_query');
  assert.deepEqual(buildEmbeddingRequest('mistral', { model: 'mistral-embed', inputs, dimensions: 256 }).body, { model: 'mistral-embed', input: inputs });

  const parsed = parseEmbeddingResponse('openai', { data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 4] }], usage: { total_tokens: 7 } }, 2);
  assert.deepEqual([...parsed.vectors[0]], [0.6000000238418579, 0.800000011920929]);
  assert.deepEqual([...parsed.vectors[1]], [0, 1]);
  assert.equal(parsed.tokens, 7);
  assert.equal(parseEmbeddingResponse('gemini', { embeddings: [{ values: [1, 0] }] }, 1).vectors[0][0], 1);
  assert.equal(parseEmbeddingResponse('ollama', { embeddings: [[0, 5]] }, 1).vectors[0][1], 1);
  assert.equal(parseEmbeddingResponse('cohere', { embeddings: { float: [[2, 0]] } }, 1).vectors[0][0], 1);
  assert.throws(() => parseEmbeddingResponse('openai', { data: [] }, 1), /unexpected/);
  assert.equal(embeddingKind({ provider: { id: 'lmstudio', transport: 'openai-chat' } }), 'openai');
  assert.equal(embeddingKind({ provider: { id: 'bridge' }, via: 'bridge' }), 'bridge');
  assert.deepEqual(batchInputs(['aaaa', 'bb', 'cccccc', 'd'], { maxInputs: 2, maxChars: 7 }), [[0, 1], [2, 3]]);
  assert.deepEqual(batchInputs(['aaaa', 'bb', 'cccccc', 'd'], { maxInputs: 2, maxChars: 6 }), [[0, 1], [2], [3]]);
});

test('embedder batches by provider limits, retries rate limits with backoff and routes bridge connections', async () => {
  const requests = [];
  let failures = 1;
  const providerFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body, secrets: options.secrets });
    if (failures-- > 0) { const error = new Error('Rate limited by Mistral.'); error.status = 429; error.retryAfter = 2; throw error; }
    return { ok: true, json: async () => ({ data: body.input.map((_, index) => ({ index, embedding: [1, index + 1] })), usage: { total_tokens: body.input.length } }) };
  };
  const sleeps = [];
  const embedder = createEmbedder({ providerFetch, sleep: async ms => { sleeps.push(ms); },
    resolveConnection: async id => ({ connection: { id, providerId: 'mistral' }, provider: { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', embeddings: { default: 'mistral-embed' }, supports: { embeddings: true } }, apiKey: 'secret', baseUrl: 'https://api.mistral.ai/v1', via: 'direct' }) });
  const inputs = Array.from({ length: 70 }, (_, i) => `text ${i}`);
  const result = await embedder.embed({ connectionId: 'm1', inputs });
  assert.equal(result.vectors.length, 70);
  assert.equal(result.model, 'mistral-embed');
  assert.equal(result.dims, 2);
  assert.deepEqual(sleeps, [2000], 'Retry-After is honoured');
  assert.equal(requests.length, 4, 'one retried request plus three batches of at most 32');
  assert.ok(requests.every(request => request.body.input.length <= 32));
  assert.deepEqual(requests[0].secrets, ['secret']);
  assert.ok(Math.abs(result.vectors[69][1] - 6 / Math.hypot(1, 6)) < 1e-6);

  const bridgeCalls = [];
  const bridge = createEmbedder({ resolveConnection: async id => ({ connection: { id, via: 'bridge' }, provider: { id: 'bridge', embeddings: null }, via: 'bridge' }),
    requestBridge: async (path, options) => { bridgeCalls.push({ path, options }); return { vectors: options.body.inputs.map(() => [3, 4]), model: 'voyage-4', dimensions: 2, usage: { inputTokens: 3 } }; } });
  const viaBridge = await bridge.embed({ connectionId: 'bridge:provider_1', inputs: ['a', 'b'], inputType: 'query', dimensions: 512 });
  assert.equal(bridgeCalls[0].path, '/ai/embeddings');
  assert.deepEqual(bridgeCalls[0].options.body, { providerId: 'provider_1', inputs: ['a', 'b'], model: undefined, dimensions: 512, inputType: 'query' });
  assert.equal(viaBridge.model, 'voyage-4');
  assert.equal(viaBridge.usage.tokens, 3);
  assert.ok(Math.abs(viaBridge.vectors[0][0] - 0.6) < 1e-6);

  const claude = createEmbedder({ resolveConnection: async () => ({ connection: { id: 'a1' }, provider: { id: 'anthropic', name: 'Anthropic', embeddings: null, supports: { embeddings: false } }, via: 'direct' }) });
  await assert.rejects(claude.embed({ connectionId: 'a1', inputs: ['x'] }), /no embeddings API/);
  assert.equal(isRetryable({ status: 401 }), false);
  assert.equal(isRetryable({ status: 503 }), true);
});

test('the memory vector store resets on model or dimension changes and keeps per-item metadata', async () => {
  const store = createVectorStore({ indexedDB: null });
  assert.equal(store.kind, 'memory');
  assert.deepEqual(await store.ensureConfig({ providerId: 'voyage', connectionId: 'c', model: 'voyage-4', requestedDims: 512 }).then(r => r.reset), false);
  await store.putItem('x', { hash: 'h1', chunks: [{ n: 0, text: 'hello', vector: [1, 0] }, { n: 1, text: 'world', vector: [0, 1] }] });
  const revision = await store.revision();
  assert.equal((await store.allChunks()).length, 2);
  assert.equal((await store.getConfig()).dims, 2);
  assert.equal((await store.ensureConfig({ providerId: 'voyage', connectionId: 'c2', model: 'voyage-4', requestedDims: 512 })).reset, false, 'a renamed connection keeps vectors');
  await store.putItem('x', { hash: 'h2', chunks: [{ n: 0, text: 'replaced', vector: [1, 1] }] });
  assert.notEqual(await store.revision(), revision);
  assert.deepEqual((await store.chunksFor('x')).map(chunk => chunk.text), ['replaced']);
  assert.deepEqual((await store.itemStates()).get('x').hash, 'h2');
  assert.equal((await store.ensureConfig({ providerId: 'voyage', connectionId: 'c2', model: 'voyage-4', requestedDims: 1024 })).reset, true);
  assert.equal((await store.allChunks()).length, 0);
  assert.equal((await store.itemStates()).size, 0);
});

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check, tries = 200) { for (let i = 0; i < tries && !check(); i++) await tick(); assert.ok(check(), 'condition reached'); }

test('a settings change mid-run stops the stale run and re-indexes with the new model only', async () => {
  const library = { items: Array.from({ length: 4 }, (_, i) => ({ id: `i${i}`, title: `Item ${i}`, updatedAt: '1' })) };
  let settings = { embeddings: { enabled: true, connectionId: 'c1', model: 'm1' } };
  const vectorStore = createVectorStore({ indexedDB: null });
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const embedder = {
    async describe() { return { providerId: 'fake', provider: 'Fake', via: 'direct', defaultModel: 'm1' }; },
    async embed({ inputs, model, signal }) {
      calls.push(model);
      if (model === 'm1') await new Promise((resolve, reject) => { gate.then(resolve); signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
      return { vectors: inputs.map(input => normalizeVector(fakeVector(input))), model, dims: 16, usage: { tokens: 1 } };
    },
  };
  const indexer = createIndexer({ vectorStore, embedder, getLibrary: async () => library, getSettings: async () => settings, locks: fakeLocks(), batchSize: 1, concurrency: 1 });
  const first = indexer.startIndexing();
  await until(() => calls.length === 1);
  settings = { embeddings: { enabled: true, connectionId: 'c1', model: 'm2' } };
  await indexer.refresh();
  release();
  await first;
  await until(() => !indexer.getIndexStatus().running && indexer.getIndexStatus().indexed === 4);
  assert.deepEqual(calls.filter(model => model === 'm1').length, 1, 'no further requests go out with the old model');
  assert.ok(calls.slice(1).every(model => model === 'm2'));
  assert.equal((await vectorStore.getConfig()).model, 'm2');
  assert.equal((await vectorStore.itemStates()).size, 4);
});

test('a failed request stops the other workers, and a run where every input is rejected reports the error without marking items failed', async () => {
  const library = { items: Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, title: `Item ${i}`, updatedAt: '1' })) };
  const settings = { embeddings: { enabled: true, connectionId: 'c1', model: 'm' } };
  const calls = [];
  const failing = {
    async describe() { return { providerId: 'fake', provider: 'Fake', via: 'direct', defaultModel: 'm' }; },
    async embed({ inputs, model }) {
      calls.push(inputs);
      if (calls.length === 1) { const error = new Error('Check the API key.'); error.status = 401; throw error; }
      await new Promise(resolve => setTimeout(resolve, 5));
      return { vectors: inputs.map(input => normalizeVector(fakeVector(input))), model, dims: 16, usage: { tokens: 1 } };
    },
  };
  const indexer = createIndexer({ vectorStore: createVectorStore({ indexedDB: null }), embedder: failing, getLibrary: async () => library, getSettings: async () => settings, locks: null, batchSize: 1, concurrency: 2 });
  const status = await indexer.startIndexing();
  assert.match(status.error, /API key/);
  assert.ok(calls.length <= 2, `stopped after the failure (${calls.length} requests)`);

  const rejected = [];
  const misconfigured = {
    async describe() { return { providerId: 'fake', provider: 'Fake', via: 'direct', defaultModel: 'm' }; },
    async embed({ inputs }) { rejected.push(inputs.length); const error = new Error('Fake: output_dimension 4096 is not supported.'); error.status = 400; throw error; },
  };
  const vectorStore = createVectorStore({ indexedDB: null });
  const stopped = await createIndexer({ vectorStore, embedder: misconfigured, getLibrary: async () => library, getSettings: async () => settings, locks: null, batchSize: 48 }).startIndexing();
  assert.match(stopped.error, /not supported/);
  assert.equal(stopped.failed, 0);
  assert.equal((await vectorStore.itemStates()).size, 0, 'items stay pending so they are retried once the settings are fixed');
  assert.ok(rejected.length <= 6);
});

test('pause and clear are shared through the index, so other views and reloads hold automatic indexing too', async () => {
  const library = { items: [{ id: 'a', title: 'Alpha', updatedAt: '1' }, { id: 'b', title: 'Beta', updatedAt: '1' }] };
  const settings = { embeddings: { enabled: true, connectionId: 'c1' } };
  const vectorStore = createVectorStore({ indexedDB: null });
  const fullTab = fakeEmbedder();
  const sidePanel = fakeEmbedder();
  const make = embedder => createIndexer({ vectorStore, embedder, getLibrary: async () => library, getSettings: async () => settings, locks: fakeLocks() });
  const a = make(fullTab);
  const b = make(sidePanel);
  await a.pauseIndexing();
  const held = await b.refresh();
  assert.equal(held.paused, true);
  assert.equal(sidePanel.calls.length, 0, 'the other view does not index while paused');
  await a.startIndexing();
  assert.equal(a.getIndexStatus().indexed, 2);
  await a.clearIndex();
  const reloaded = make(fakeEmbedder());
  const afterReload = await reloaded.refresh();
  assert.equal(afterReload.paused, true);
  assert.equal(afterReload.indexed, 0);
  assert.deepEqual(await vectorStore.allChunks(), []);
  assert.equal((await b.rebuildIndex()).indexed, 2);
  assert.equal(await vectorStore.isHeld(), false);
});
