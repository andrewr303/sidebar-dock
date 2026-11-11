import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationStore, createMemoryStorage, migrateLegacyChats, normalizeConversation, titleFromQuestion, CONVERSATIONS_KEY, LEGACY_CHATS_KEY, CONVERSATION_LIMITS } from '../extension/lib/ai/conversations.js';

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

test('an answer keeps what it did in browser tabs as bounded plain text', () => {
  const lines = Array.from({ length: 90 }, (_, index) => ({ step: index + 1, kind: index % 2 ? 'write' : 'read', text: `tab 7 · line ${index + 1}`, id: `b${index}`, extra: { nested: true } }));
  const conversation = normalizeConversation({ id: 'c1', messages: [
    { id: 'u1', role: 'user', text: 'Send the form' },
    { id: 'a1', role: 'assistant', text: 'Sent.', browser: { activity: [...lines, { step: 'x', kind: 7, text: 'y'.repeat(900) }, { text: '' }, null, 'not a line'],
      unverified: ['click button «Send» on tab 7: the page showed no effect', 5, '', ...Array.from({ length: 30 }, (_, index) => `step ${index}`)], secret: 'dropped' } },
    { id: 'a2', role: 'assistant', text: 'Nothing done in the browser.', browser: { activity: [], unverified: [] } },
    { id: 'a3', role: 'assistant', text: 'Damaged record.', browser: 'yes' },
  ] });
  const [, first, second, third] = conversation.messages;
  assert.equal(first.browser.activity.length, 60, 'the newest lines are kept');
  assert.deepEqual(first.browser.activity.at(-2), { step: 90, kind: 'write', text: 'tab 7 · line 90' }, 'only step, kind and text are stored');
  assert.deepEqual(Object.keys(first.browser.activity.at(-1)), ['step', 'kind', 'text']);
  assert.equal(first.browser.activity.at(-1).step, 0);
  assert.equal(first.browser.activity.at(-1).kind, 'action');
  assert.equal(first.browser.activity.at(-1).text.length, 400);
  assert.equal(first.browser.unverified.length, 20);
  assert.equal(first.browser.unverified[0], 'click button «Send» on tab 7: the page showed no effect');
  assert.deepEqual(Object.keys(first.browser), ['activity', 'unverified']);
  assert.equal('browser' in second, false, 'an empty record is not stored');
  assert.equal('browser' in third, false);
});
