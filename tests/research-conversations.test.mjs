import test from 'node:test';
import assert from 'node:assert/strict';
import { CONVERSATIONS_KEY, RESEARCH_RECORD_LIMITS, createConversationStore, createMemoryStorage, normalizeConversation } from '../extension/lib/ai/conversations.js';
import * as ai from '../extension/lib/ai/index.js';

const at = '2026-11-01T10:00:00.000Z';
const researchConversation = (extra = {}) => ({
  id: 'conversation_r1', title: 'Research: Readability in 2026', kind: 'research', createdAt: at, updatedAt: at, connectionId: 'anthropic-1', model: 'claude-sonnet-5-5',
  scope: { scope: 'item', ids: ['art'] },
  research: {
    itemId: 'art', sessionId: 'sesn_1', agentId: 'agent_1', agentVersion: 2, connectionId: 'anthropic-1', status: 'running', startedAt: at, finishedAt: '', ownerId: 'view_1',
    heartbeatAt: at, error: '', usage: { costUsd: 0.37, currency: 'USD' }, handled: { sevt_1: '{"ok":true}' }, settings: { depth: 'deep', maxSubpages: 3, github: 'auto', budgetUsd: 5 },
    undo: { itemId: 'art', sectionText: '## Research\n\nText.', originalField: 'articleContent', originalText: 'Old.', subpageIds: ['item_2'] }, pages: [{ id: 'item_2', title: 'Deep dive', parent: 'document' }],
    futureField: { kept: true },
  },
  messages: [
    { id: 'm1', role: 'user', text: 'Research “Readability in 2026”', createdAt: at },
    { id: 'm2', role: 'assistant', text: 'Looking at the page.', createdAt: at, research: { live: true, steps: [{ id: 'sevt_s', kind: 'search', label: 'Searched the web for “x”', detail: 'x', state: 'done', at }],
      subpages: [{ id: 'item_2', title: 'Deep dive' }], writes: 2, sessionId: 'sesn_1', baseline: 0, sent: true, messageIds: ['sevt_m'], preview: { id: 'sevt_p', text: 'Typing' } } },
  ],
  ...extra,
});

test('research fields round trip through save, load, the history index, export and import', async () => {
  const storage = createMemoryStorage();
  const store = createConversationStore({ storage, now: () => at });
  const saved = await store.saveConversation(researchConversation());
  const loaded = await store.getConversation('conversation_r1');
  const input = researchConversation();
  assert.equal(loaded.kind, 'research');
  assert.deepEqual(loaded.research, input.research);
  assert.deepEqual(loaded.messages[1].research, input.messages[1].research);
  assert.deepEqual(saved.research, loaded.research);

  const [summary] = await store.listConversations();
  assert.equal(summary.kind, 'research');
  assert.deepEqual(summary.research, { status: 'running', itemId: 'art' });
  assert.equal(summary.preview, 'Looking at the page.');
  assert.ok(!('handled' in summary.research), 'the index stays small');

  const exported = await store.exportAll();
  const elsewhere = createConversationStore({ storage: createMemoryStorage(), now: () => at });
  assert.deepEqual(await elsewhere.importAll(exported), { added: 1, updated: 0, skipped: 0, full: 0 });
  assert.deepEqual((await elsewhere.getConversation('conversation_r1')).research, input.research);
});

test('a plain chat summary is unchanged: no kind or research keys appear', async () => {
  const store = createConversationStore({ storage: createMemoryStorage(), now: () => at });
  await store.saveConversation({ id: 'plain', messages: [{ role: 'user', text: 'Hello' }] });
  const [summary] = await store.listConversations();
  assert.deepEqual(Object.keys(summary).sort(), ['connectionId', 'createdAt', 'id', 'messageCount', 'model', 'preview', 'scope', 'title', 'updatedAt']);
});

test('research records stay bounded and well-formed: newest 300 results, 200 steps, junk shapes dropped', () => {
  const handled = Object.fromEntries(Array.from({ length: 320 }, (_, index) => [`sevt_${index}`, `{"ok":true,"n":${index}}`]));
  Object.defineProperty(handled, '__proto__', { value: '{"ok":true}', enumerable: true, configurable: true, writable: true });
  handled.bad = { not: 'text' };
  const steps = Array.from({ length: 230 }, (_, index) => ({ id: `s${index}`, kind: 'search', label: `q${index}`, state: 'done', at }));
  const conversation = normalizeConversation(researchConversation({
    research: { ...researchConversation().research, handled },
    messages: [
      { id: 'm1', role: 'user', text: 'x', createdAt: at },
      { id: 'm2', role: 'assistant', text: 'y', createdAt: at, research: { live: false, steps } },
      { id: 'm3', role: 'assistant', text: 'z', createdAt: at, research: 'broken' },
    ],
  }), { now: at });
  const keys = Object.keys(conversation.research.handled);
  assert.equal(keys.length, RESEARCH_RECORD_LIMITS.handled);
  assert.equal(keys[0], 'sevt_20');
  assert.equal(keys.at(-1), 'sevt_319');
  assert.equal(Object.getPrototypeOf(conversation.research.handled), Object.prototype, 'a __proto__ key is dropped, never applied');
  assert.equal(conversation.messages[1].research.steps.length, RESEARCH_RECORD_LIMITS.steps);
  assert.equal(conversation.messages[1].research.steps[0].id, 's30');
  assert.ok(!('research' in conversation.messages[2]));
  assert.ok(!('kind' in normalizeConversation({ kind: 42, messages: [] }, { now: at })));
  assert.ok(!('research' in normalizeConversation({ research: 'nope', messages: [] }, { now: at })));
  assert.equal(normalizeConversation({ kind: 'research', messages: [] }, { now: at }).kind, 'research');
});

test('the facade answers research availability without the extension (the preview build)', async () => {
  assert.equal(globalThis.chrome?.runtime?.id, undefined);
  const availability = await ai.researchAvailability();
  assert.equal(availability.available, false);
  assert.equal(availability.code, 'extension_only');
  await assert.rejects(ai.startResearch({ itemId: 'x' }), error => error.code === 'extension_only');
  const unsubscribe = ai.subscribeResearch(() => {});
  assert.equal(typeof unsubscribe, 'function');
  unsubscribe();
  assert.ok(CONVERSATIONS_KEY);
});
