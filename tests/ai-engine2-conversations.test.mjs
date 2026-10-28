import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationStore, createMemoryStorage, migrateLegacyChats, normalizeConversation, normalizeMessage, titleFromQuestion, CONVERSATIONS_KEY, LEGACY_CHATS_KEY, CONVERSATION_LIMITS } from '../extension/lib/ai/conversations.js';

const legacy = [
  { id: 'chat-2', title: 'Japan trip', spaceKey: 'space:travel', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T01:00:00.000Z', messages: [
    { id: 'u1', role: 'user', content: 'What should I see in Kyoto?', createdAt: '2026-09-02T00:00:00.000Z' },
    { id: 'a1', role: 'assistant', content: 'Temples [[kyoto]].', createdAt: '2026-09-02T00:00:01.000Z', status: 'complete', model: 'claude-x', sources: [{ id: 'kyoto', title: 'Kyoto', url: 'https://k', truncated: false }] },
  ] },
  { id: 'chat-1', title: 'New conversation', spaceKey: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', messages: [
    { id: 'u0', role: 'user', content: 'Summarize **my** reading', createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 'a0', role: 'assistant', content: 'Half an ans', status: 'streaming', createdAt: '2026-09-01T00:00:01.000Z' },
    { id: 'x', role: 'system', content: 'dropped' },
  ] },
  'garbage',
];

test('legacy 0.2 chats migrate to v2 conversations with scopes, citations and interrupted answers marked', () => {
  const [trip, reading] = migrateLegacyChats(legacy, { now: '2026-10-28T00:00:00.000Z' });
  assert.equal(migrateLegacyChats(null).length, 0);
  assert.deepEqual(trip.scope, { scope: 'collection', ids: [], collectionId: 'travel' });
  assert.equal(trip.title, 'Japan trip');
  assert.equal(trip.model, 'claude-x');
  assert.deepEqual(trip.messages[1].citations, [{ n: 1, id: 'kyoto', title: 'Kyoto', url: 'https://k' }]);
  assert.equal(trip.messages[1].text, 'Temples [[kyoto]].');
  assert.equal(trip.messages[1].error, '');
  assert.equal(reading.title, 'Summarize my reading', 'placeholder titles become the first question');
  assert.deepEqual(reading.scope, { scope: 'library', ids: [], collectionId: '' });
  assert.deepEqual(reading.messages.map(m => m.role), ['user', 'assistant']);
  assert.match(reading.messages[1].error, /Interrupted/);
  assert.equal(reading.messages[1].text, 'Half an ans');
});

test('the store migrates legacy chats once, lists newest first and saves, reads and deletes conversations', async () => {
  const storage = createMemoryStorage({ [LEGACY_CHATS_KEY]: legacy });
  const store = createConversationStore({ storage, now: () => '2026-10-28T00:00:00.000Z' });
  const listed = await store.listConversations();
  assert.deepEqual(listed.map(c => c.id), ['chat-2', 'chat-1']);
  assert.equal(listed[0].messageCount, 2);
  assert.equal(listed[0].preview, 'Temples [[kyoto]].');
  assert.equal((await storage.get(CONVERSATIONS_KEY)).migratedLegacy, true);
  assert.ok(await storage.get(LEGACY_CHATS_KEY), 'the legacy key stays as a backup');
  // A second store instance (another view) does not migrate again.
  await store.deleteConversation('chat-1');
  const again = createConversationStore({ storage });
  assert.deepEqual((await again.listConversations()).map(c => c.id), ['chat-2']);

  const saved = await again.saveConversation({ messages: [{ role: 'user', text: 'How do I organize\nmy notes?' }, { role: 'assistant', text: 'Use collections.', proposals: [{ id: 'p', title: 'x', undo: { patches: [] }, apply: () => {} }] }], scope: 'library' });
  assert.match(saved.id, /^conversation_/);
  assert.equal(saved.title, 'How do I organize');
  assert.equal(saved.messages[1].proposals[0].apply, undefined, 'functions never reach storage');
  assert.deepEqual(saved.scope, { scope: 'library', ids: [], collectionId: '' });
  const loaded = await again.getConversation(saved.id);
  assert.deepEqual(loaded.messages.map(m => m.text), ['How do I organize\nmy notes?', 'Use collections.']);
  assert.equal((await again.listConversations())[0].id, saved.id);
  assert.equal(await again.getConversation('missing'), null);
  await again.deleteConversation(saved.id);
  assert.equal(await again.getConversation(saved.id), null);
  assert.equal(await storage.get(`still.ai.conversation.v2:${saved.id}`), undefined);
});

test('size caps trim the oldest turns and the oldest conversations', async () => {
  const many = Array.from({ length: CONVERSATION_LIMITS.messages + 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}` }));
  const capped = normalizeConversation({ messages: many });
  assert.equal(capped.messages.length, CONVERSATION_LIMITS.messages);
  assert.equal(capped.messages.at(-1).text, `m${many.length - 1}`);
  const huge = normalizeConversation({ messages: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(190000) })) });
  assert.ok(JSON.stringify(huge).length <= CONVERSATION_LIMITS.bytes);
  assert.ok(huge.messages.length >= 2 && huge.messages.length < 30);
  assert.equal(normalizeConversation({ messages: [{ role: 'user', text: 'y'.repeat(CONVERSATION_LIMITS.messageChars + 5) }] }).messages[0].text.length, CONVERSATION_LIMITS.messageChars);

  const storage = createMemoryStorage();
  let tick = 0;
  const store = createConversationStore({ storage, now: () => new Date(Date.UTC(2026, 9, 1) + tick++ * 1000).toISOString() });
  for (let i = 0; i < CONVERSATION_LIMITS.conversations + 2; i++) await store.saveConversation({ id: `c${i}`, messages: [{ role: 'user', text: `q${i}` }] });
  const list = await store.listConversations();
  assert.equal(list.length, CONVERSATION_LIMITS.conversations);
  assert.ok(!list.some(c => c.id === 'c0' || c.id === 'c1'), 'the oldest conversations are dropped');
  assert.equal(await storage.get('still.ai.conversation.v2:c0'), undefined);
});

test('titles come from the first question', () => {
  assert.equal(titleFromQuestion(''), 'New conversation');
  assert.equal(titleFromQuestion('\n\n  ## What is **calm** design?  \nmore'), 'What is calm design?');
  const long = titleFromQuestion('Find everything I saved about Japanese temples and gardens and move it to Travel');
  assert.ok(long.length <= 61 && long.endsWith('…'));
  assert.ok(!/\s…$/.test(long));
});

test('the total size cap drops the oldest conversations; the one being saved always stays', async () => {
  const storage = createMemoryStorage();
  let tick = 0;
  const store = createConversationStore({ storage, now: () => new Date(Date.UTC(2026, 9, 1) + tick++ * 1000).toISOString() });
  // Each conversation is about 3.4 MB (17 answers at the per-message cap), so ten of them pass the 32 MB total.
  const answer = 'z'.repeat(CONVERSATION_LIMITS.messageChars);
  const messages = Array.from({ length: 34 }, (_, n) => n % 2 ? { role: 'assistant', text: answer } : { role: 'user', text: `q${n}` });
  const count = 12;
  for (let i = 0; i < count; i++) await store.saveConversation({ id: `big${i}`, messages });
  const list = await store.listConversations();
  const total = list.reduce((sum, item) => sum + item.bytes, 0);
  assert.ok(list.length < count, `the oldest conversations were dropped (${list.length} kept)`);
  assert.ok(total <= CONVERSATION_LIMITS.totalBytes, `summaries stay under the total cap (${total})`);
  assert.ok(total > CONVERSATION_LIMITS.totalBytes - list[0].bytes, 'and nothing is dropped that would have fit');
  assert.equal(list[0].id, `big${count - 1}`);
  assert.ok(!list.some(item => item.id === 'big0'));
  const kept = new Set(list.map(item => item.id));
  for (let i = 0; i < count; i++) {
    const body = await storage.get(`still.ai.conversation.v2:big${i}`);
    assert.equal(!!body, kept.has(`big${i}`), `body and summary agree for big${i}`);
  }
  // Message fields the UI branches on survive a save.
  const saved = await store.saveConversation({ id: 'codes', messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: '', error: 'Claude declined this request.', errorCode: 'refusal', stopReason: 'refusal' }] });
  assert.deepEqual([saved.messages[1].errorCode, saved.messages[1].stopReason], ['refusal', 'refusal']);
  assert.equal((await store.getConversation('codes')).messages[1].errorCode, 'refusal');
});

test('read step results and answer notes survive a save within their caps', async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `item_${i}`);
  const message = normalizeMessage({ role: 'assistant', text: 'a', tools: [
    { name: 'search_library', summary: 'Searched library · 60 matches', result: { query: `  ${'q'.repeat(250)} `, count: 60, ids: [...ids, 7, '', 'x'.repeat(201)], extra: 'dropped' } },
    { name: 'get_items', summary: 'Read 2 items', result: { count: 2 } },
    { name: 'get_page', summary: 'Read this page', result: { chars: 10 } },
    { name: 'list_tags', summary: 'Listed', result: 'nope' },
    { name: 'list_collections', summary: 'Listed', result: { count: -1, ids: 'x' } },
  ], notes: ['The answer reached the length limit and may be cut off.', 'The answer reached the length limit and may be cut off.', '', 4, ` ${'n'.repeat(400)}`, ...Array.from({ length: 20 }, (_, i) => `Note ${i}.`)] });
  assert.deepEqual(message.tools[0].result, { query: 'q'.repeat(200), count: 60, ids: ids.slice(0, 50) });
  assert.deepEqual(message.tools[1].result, { count: 2 });
  assert.ok(!('result' in message.tools[2]) && !('result' in message.tools[3]), 'results without a query, count or ids are not kept');
  assert.deepEqual(message.tools[4].result, undefined);
  assert.equal(message.notes.length, 10);
  assert.equal(message.notes[0], 'The answer reached the length limit and may be cut off.');
  assert.equal(message.notes[1], 'n'.repeat(300));
  assert.equal(normalizeMessage({ role: 'assistant', text: 'b', notes: [] }).notes, undefined, 'no notes, no field');

  const store = createConversationStore({ storage: createMemoryStorage() });
  const saved = await store.saveConversation({ id: 'c', messages: [{ role: 'user', text: 'Find japan' }, message] });
  const loaded = await store.getConversation(saved.id);
  assert.deepEqual(loaded.messages[1].tools.map(tool => tool.result), message.tools.map(tool => tool.result));
  assert.deepEqual(loaded.messages[1].notes, message.notes);
  assert.ok(JSON.stringify(loaded).length <= CONVERSATION_LIMITS.bytes);
});

test('an "existing" save goes into the stored conversation: a deleted one stays deleted and a newer title wins', async () => {
  const storage = createMemoryStorage();
  const store = createConversationStore({ storage, now: () => '2026-10-28T00:00:00.000Z' });
  const first = await store.saveConversation({ id: 'c1', messages: [{ role: 'user', text: 'Kyoto?' }] });
  await store.saveConversation({ ...first, title: 'Kyoto trip' });
  const appended = await store.saveConversation({ ...first, messages: [...first.messages, { role: 'assistant', text: 'Temples.' }] }, { existing: true });
  assert.equal(appended.title, 'Kyoto trip');
  assert.deepEqual((await store.getConversation('c1')).messages.map(m => m.text), ['Kyoto?', 'Temples.']);
  await store.deleteConversation('c1');
  assert.equal(await store.saveConversation({ ...appended, messages: [...appended.messages, { role: 'user', text: 'More?' }] }, { existing: true }), null);
  assert.equal(await store.getConversation('c1'), null);
  assert.deepEqual(await store.listConversations(), []);
  assert.equal((await store.saveConversation({ id: 'c2', messages: [{ role: 'user', text: 'New' }] })).id, 'c2', 'a plain save still creates');
});
