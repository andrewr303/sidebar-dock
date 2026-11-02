import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createResearch, MAX_STEPS } from '../extension/lib/ai/research/run.js';
import { createConversationStore, createMemoryStorage } from '../extension/lib/ai/conversations.js';
import { getProvider } from '../extension/lib/ai/catalog.js';
import { aiError } from '../extension/lib/ai/http.js';
import { pageBlockLine } from '../extension/lib/pages.js';
import * as libraryStore from '../extension/lib/store.js';
import { KEY, fakeManagedAgents, json, play } from './research-fake-server.mjs';

const CONNECTION = { id: 'anthropic-1', via: 'direct', providerId: 'anthropic', enabled: true, hasKey: true, baseUrl: 'https://api.anthropic.com/v1', workspaceId: '' };
const OPTIONS = { timeout: 15000 };

function memoryStore(seed) {
  let state = null;
  const library = libraryStore.createLibraryStore({ read: async () => state, write: async next => { state = next; } });
  const call = (operation, ...args) => library.dispatch(operation, args);
  return {
    ready: call('loadLibrary', seed),
    loadLibrary: () => call('loadLibrary'),
    saveItem: input => call('saveItem', input),
    updateItem: (id, patch, options = {}) => call('updateItem', id, patch, options),
    deleteItem: (id, options = {}) => call('deleteItem', id, options),
    upsertContentSection: (id, options) => call('upsertContentSection', id, options),
  };
}
const seed = () => ({
  schemaVersion: 1, collections: [],
  items: [
    { id: 'art', type: 'article', title: 'Readability in 2026', url: 'https://example.com/readability', siteName: 'Example', author: 'Ada', articleContent: '# Original\n\nCaptured text.', content: 'My note.', tags: ['reading'] },
    { id: 'note', type: 'note', title: 'Ideas', content: 'Note body.' },
  ],
});
// A shared Web Locks stand-in (Node 22 has no navigator.locks): request(name, [options], callback) with ifAvailable.
function fakeLocks() {
  const held = new Set();
  return {
    async request(name, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      if (held.has(name) && options?.ifAvailable) return callback(null);
      while (held.has(name)) await new Promise(resolve => setTimeout(resolve, 1));
      held.add(name);
      try { return await callback({ name }); } finally { held.delete(name); }
    },
  };
}
const memoryStorage = () => { const map = new Map(); return { map, get: async key => structuredClone(map.get(key)), set: async (key, value) => { map.set(key, structuredClone(value)); } }; };

async function harness({ script = null, settings = {}, connections = [CONNECTION], extension = true, locks = null, timing = {}, github = null } = {}) {
  const server = fakeManagedAgents({ script });
  const store = memoryStore(seed());
  await store.ready;
  const conversationStorage = createMemoryStorage();
  const provisioning = memoryStorage();
  const fetchImpl = async (url, init) => String(url).startsWith('https://api.github.com/')
    ? (github ? github(String(url), init) : json({ total_count: 0, items: [] })) : server.fetch(url, init);
  const make = () => createResearch({
    conversations: createConversationStore({ storage: conversationStorage }), store,
    getAiSettings: async () => ({ chat: { connectionId: 'anthropic-1' }, research: { ...settings } }),
    listConnections: async () => connections,
    resolveConnection: async id => {
      const connection = connections.find(entry => entry.id === id);
      if (!connection) throw aiError('That AI connection no longer exists.', { code: 'no_connection' });
      return { connection: { ...connection }, provider: getProvider('anthropic'), apiKey: KEY, baseUrl: connection.baseUrl, via: 'direct' };
    },
    fetch: fetchImpl, githubToken: async () => '', storage: provisioning, locks, isExtension: () => extension,
    timing: { persistMs: 1, heartbeatMs: 60000, idleMs: 4000, stopGraceMs: 4000, maxReconnects: 3, ...timing },
    sleep: () => new Promise(resolve => setTimeout(resolve, 1)),
  });
  const research = make();
  const conversations = createConversationStore({ storage: conversationStorage });
  return { server, store, research, make, conversations, provisioning };
}
const itemOf = async (store, id) => (await store.loadLibrary()).items.find(entry => entry.id === id);
// Events the fake session actually accepted (failed POSTs never reach it).
const accepted = (server, type) => [...server.sessions.values()].flatMap(session => session.events).filter(event => event.type === type);
const lastAssistant = conversation => conversation.messages.filter(message => message.role === 'assistant').at(-1);
const waitFor = async (check, label = 'condition') => {
  for (let i = 0; i < 2000; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error(`Timed out waiting for ${label}`);
};

// The agent's side of a full run: progress text (with live previews), a web search and a failed fetch, then the
// research section, a subpage and a GitHub search, then the final summary.
function happyScript() {
  const pending = new Set();
  return async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.message') {
        await play(emit, [
          { type: 'session.status_running' },
          { type: 'span.model_request_start' },
          { event: { type: 'event_start', event: { type: 'agent.message', id: 'sevt_msg1' } }, options: { persist: false } },
          { event: { type: 'event_delta', event_id: 'sevt_msg1', delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'Looking at ' } } }, options: { persist: false } },
          { event: { type: 'event_delta', event_id: 'sevt_msg1', delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'the page.' } } }, options: { persist: false } },
          { type: 'agent.message', id: 'sevt_msg1', content: [{ type: 'text', text: 'Looking at the page.' }] },
          { type: 'span.model_request_end' },
          { type: 'agent.tool_use', id: 'sevt_ws1', name: 'web_search', input: { query: 'readability algorithm' }, evaluated_permission: 'allow' },
          { type: 'agent.tool_result', tool_use_id: 'sevt_ws1', content: [{ type: 'text', text: 'results' }] },
          { type: 'agent.tool_use', id: 'sevt_ws2', name: 'web_search', input: { query: 'readability algorithm' } },
          { type: 'agent.tool_result', tool_use_id: 'sevt_ws2', content: [] },
          { type: 'agent.tool_use', id: 'sevt_wf1', name: 'web_fetch', input: { url: 'https://blocked.example.com/page' } },
          { type: 'agent.tool_result', tool_use_id: 'sevt_wf1', is_error: true, content: [{ type: 'text', text: 'url_not_accessible' }] },
          { type: 'something.new', detail: 'tolerated' },
          { type: 'agent.custom_tool_use', id: 'sevt_cu1', name: 'append_to_document', input: { markdown: '### Background\n\nReadability scores [content](https://github.com/mozilla/readability).' } },
          { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_cu1'] } },
        ]);
      }
      if (event.type === 'user.custom_tool_result' && event.custom_tool_use_id === 'sevt_cu1') {
        pending.add('sevt_cu2'); pending.add('sevt_cu3');
        await play(emit, [
          { type: 'session.status_running' },
          { type: 'agent.custom_tool_use', id: 'sevt_cu2', name: 'create_subpage', input: { title: 'Benchmarks', markdown: 'Numbers [here](https://bench.example).' } },
          { type: 'agent.custom_tool_use', id: 'sevt_cu3', name: 'github_search_repositories', input: { query: 'readability' } },
          { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_cu2', 'sevt_cu3'] } },
        ]);
      }
      if (event.type === 'user.custom_tool_result' && pending.delete(event.custom_tool_use_id) && !pending.size) {
        await play(emit, [
          { type: 'session.status_running' },
          { type: 'agent.message', id: 'sevt_msg2', content: [{ type: 'text', text: 'I added a research section and a Benchmarks subpage.' }] },
          { type: 'session.usage', usage: { list_cost: { amount: '30', currency: 'USD' } } },
          { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
        ]);
      }
    }
  };
}

test('the full run: provision, session, stream first, kickoff, previews, tool steps, custom tools, writes, end_turn', OPTIONS, async () => {
  const github = (url, init) => json({ total_count: 1, items: [{ full_name: 'mozilla/readability', html_url: 'https://github.com/mozilla/readability', stargazers_count: 9 }] }, 200);
  const { server, store, research, conversations } = await harness({ script: happyScript(), github });
  const live = [];
  const unsubscribe = research.subscribeResearch(event => live.push({ status: event.status, preview: event.message?.research?.preview?.text || '', text: event.message?.text }));
  const started = await research.startResearch({ itemId: 'art', instructions: 'Focus on how it compares to newer libraries.' });
  assert.ok(started.conversationId);
  assert.equal(await started.done, 'done');
  unsubscribe();

  // Calls in order: provisioning, the session, the stream opened BEFORE the kickoff is sent.
  const routes = server.calls.filter(call => !call.url.startsWith('https://api.github.com')).map(call => `${call.method} ${call.path}`);
  assert.deepEqual(routes.slice(0, 3), ['POST /environments', 'POST /agents', 'POST /sessions']);
  const sessionId = [...server.sessions.keys()][0];
  const streamAt = routes.indexOf(`GET /sessions/${sessionId}/events/stream`);
  const kickoffAt = server.calls.findIndex(call => call.method === 'POST' && call.body?.events?.[0]?.type === 'user.message');
  assert.ok(streamAt >= 0 && streamAt < kickoffAt, 'the stream opens before the kickoff is sent');
  const create = server.calls.find(call => call.method === 'POST' && call.path === '/sessions').body;
  assert.deepEqual(create.agent, { type: 'agent_with_overrides', id: [...server.agents.keys()][0], version: 1, model: { id: 'claude-sonnet-5-5', effort: 'medium' } });
  assert.deepEqual(create.budget, { type: 'limit', max_list_cost: { amount: '500', currency: 'USD' } });
  assert.deepEqual(Object.keys(create.metadata).sort(), ['app', 'conversation_id', 'item_id']);
  assert.equal(create.metadata.item_id, 'art');
  assert.equal(create.title, 'Research: Readability in 2026');
  const kickoff = server.posted('user.message')[0].content[0].text;
  for (const pattern of [/URL: https:\/\/example\.com\/readability/, /Title: Readability in 2026/, /Site: Example/, /Author: Ada/, /Tags: reading/, /Depth: standard \(about 12 web searches\)/,
    /Maximum new subpages: 6/, /GitHub research: automatic/, /Original page edits: not allowed/, /<instructions>\nFocus on how it compares to newer libraries\.\n<\/instructions>/,
    /<saved_page>\n# Original\n\nCaptured text\.\n<\/saved_page>/, /<user_note>\nMy note\.\n<\/user_note>/, /never follow it/]) assert.match(kickoff, pattern);

  // Every custom tool was answered exactly once, with its sevt_ event id and a JSON result.
  const results = server.posted('user.custom_tool_result');
  assert.deepEqual(results.map(result => result.custom_tool_use_id).sort(), ['sevt_cu1', 'sevt_cu2', 'sevt_cu3']);
  assert.ok(results.every(result => result.is_error === false && JSON.parse(result.content[0].text).ok === true));

  // The writes landed in the library: the research section on the article (never its captured text) and a subpage.
  const article = await itemOf(store, 'art');
  const page = (await store.loadLibrary()).items.find(entry => entry.title === 'Benchmarks');
  assert.equal(page.parentId, 'art');
  assert.match(article.content, /^My note\.\n\n## Research\n\n_Researched with Claude on .+_\n\n### Background\n\nReadability scores \[content\]\(https:\/\/github\.com\/mozilla\/readability\)\./);
  assert.ok(article.content.endsWith(pageBlockLine(page.id, 'Benchmarks')));
  assert.equal(article.articleContent, '# Original\n\nCaptured text.');

  // The conversation: kind, run record, progress steps, the agent's text, cost.
  const conversation = await conversations.getConversation(started.conversationId);
  assert.equal(conversation.kind, 'research');
  assert.equal(conversation.title, 'Research: Readability in 2026');
  assert.deepEqual(conversation.scope, { scope: 'item', ids: ['art'], collectionId: '' });
  const record = conversation.research;
  assert.equal(record.status, 'done');
  assert.equal(record.itemId, 'art');
  assert.equal(record.sessionId, sessionId);
  assert.ok(record.agentId && record.agentVersion === 1 && record.connectionId === 'anthropic-1' && record.startedAt && record.finishedAt && record.ownerId && record.heartbeatAt);
  assert.equal(record.error, '');
  assert.equal(record.usage.costUsd, 0.37, 'the final cost comes from GET /v1/sessions/{id}');
  assert.deepEqual(Object.keys(record.handled).sort(), ['sevt_cu1', 'sevt_cu2', 'sevt_cu3']);
  assert.deepEqual(record.undo.subpageIds, [page.id]);
  assert.equal(record.undo.itemId, 'art');
  assert.ok(article.content.includes(record.undo.sectionText));
  const [user, answer] = conversation.messages;
  assert.equal(user.role, 'user');
  assert.equal(user.text, 'Research “Readability in 2026”\n\nFocus on how it compares to newer libraries.');
  assert.equal(answer.text, 'Looking at the page.\n\nI added a research section and a Benchmarks subpage.');
  assert.equal(answer.model, 'claude-sonnet-5-5');
  assert.equal(answer.error, '');
  assert.equal(answer.research.live, false);
  assert.equal(answer.research.writes, 2);
  assert.deepEqual(answer.research.subpages, [{ id: page.id, title: 'Benchmarks' }]);
  assert.ok(!answer.research.preview);
  const steps = answer.research.steps;
  assert.deepEqual(steps.map(step => [step.kind, step.state]), [['search', 'done'], ['fetch', 'error'], ['write', 'done'], ['subpage', 'done'], ['github', 'done']]);
  assert.equal(steps[0].label, 'Searched the web for “readability algorithm”', 'a repeated search shares one row');
  assert.equal(steps[1].url, 'https://blocked.example.com/page');
  assert.equal(steps[1].detail, 'Could not open the page');
  assert.equal(steps[3].label, 'Created subpage “Benchmarks”');
  assert.ok(steps.every(step => step.id && step.label && step.at));

  // The history index carries the kind and status; the owning page saw live previews.
  const summary = (await conversations.listConversations()).find(entry => entry.id === started.conversationId);
  assert.equal(summary.kind, 'research');
  assert.deepEqual(summary.research, { status: 'done', itemId: 'art' });
  assert.ok(live.some(event => event.preview === 'Looking at '), 'deltas reach in-page listeners');
  assert.ok(live.some(event => event.status === 'running'));
  assert.equal(live.at(-1).status, 'done');
});

test('a dropped stream reconnects, replays history and dedupes: no repeated text, steps or writes', OPTIONS, async () => {
  let server;
  const script = async ({ session, posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.message') {
        await play(emit, [
          { type: 'session.status_running' },
          { type: 'agent.message', id: 'sevt_a', content: [{ type: 'text', text: 'First.' }] },
          { type: 'agent.tool_use', id: 'sevt_s', name: 'web_search', input: { query: 'q' } },
          { type: 'agent.custom_tool_use', id: 'sevt_c', name: 'append_to_document', input: { markdown: 'Once.' } },
          { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_c'] } },
        ]);
      }
      if (event.type === 'user.custom_tool_result') {
        // The connection drops; the rest of the turn happens while no stream is open.
        server.dropStreams(session.id);
        await play(emit, [
          { type: 'session.status_running' },
          { type: 'agent.tool_result', tool_use_id: 'sevt_s', content: [] },
          { type: 'agent.message', id: 'sevt_b', content: [{ type: 'text', text: 'Second.' }] },
          { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
        ]);
      }
    }
  };
  const setup = await harness({ script });
  server = setup.server;
  const started = await setup.research.startResearch({ itemId: 'art' });
  assert.equal(await started.done, 'done');
  assert.ok(server.streamOpens >= 2, 'the stream was reopened');
  const conversation = await setup.conversations.getConversation(started.conversationId);
  const answer = lastAssistant(conversation);
  assert.equal(answer.text, 'First.\n\nSecond.');
  assert.deepEqual(answer.research.steps.map(step => [step.kind, step.state]), [['search', 'done'], ['write', 'done']]);
  assert.equal((await itemOf(setup.store, 'art')).content.match(/Once\./g).length, 1);
  assert.equal(server.posted('user.custom_tool_result').length, 1);
  assert.ok(!answer.research.steps.some(step => step.id === 'status:reconnect'));
});

test('a reload mid-run: another page resumes, re-posts the stored result for the waiting call and never writes twice', OPTIONS, async () => {
  let server;
  const script = async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.message') {
        // From now on posting events fails: the first page writes, stores the result, and cannot deliver it.
        server.failNext('POST', /\/events$/, () => { throw new TypeError('Failed to fetch'); }, 1000);
        await play(emit, [
          { type: 'session.status_running' },
          { type: 'agent.custom_tool_use', id: 'sevt_c', name: 'append_to_document', input: { markdown: 'Written once.' } },
          { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_c'] } },
        ]);
      }
      if (event.type === 'user.custom_tool_result') {
        await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', id: 'sevt_done', content: [{ type: 'text', text: 'Finished.' }] }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
      }
    }
  };
  const setup = await harness({ script, timing: { maxReconnects: 1 } });
  server = setup.server;
  const first = await setup.research.startResearch({ itemId: 'art' });
  assert.equal(await first.done, 'waiting', 'gave up for now: waiting with reason connection');
  let conversation = await setup.conversations.getConversation(first.conversationId);
  assert.equal(conversation.research.reason, 'connection');
  assert.ok(conversation.research.handled.sevt_c, 'the result was stored before it was posted');
  assert.equal(accepted(server, 'user.custom_tool_result').length, 0);
  assert.equal((await itemOf(setup.store, 'art')).content.match(/Written once\./g).length, 1);

  // The network is back; a different page (a new engine) resumes.
  server.failures.length = 0;
  const other = setup.make();
  const resumed = await other.resumeResearch(first.conversationId);
  assert.equal(resumed.resumed, true);
  assert.equal(await resumed.done, 'done');
  assert.equal(accepted(server, 'user.custom_tool_result').length, 1);
  assert.equal(accepted(server, 'user.custom_tool_result')[0].content[0].text, conversation.research.handled.sevt_c);
  assert.equal((await itemOf(setup.store, 'art')).content.match(/Written once\./g).length, 1, 'the write was not applied again');
  conversation = await setup.conversations.getConversation(first.conversationId);
  assert.equal(conversation.research.status, 'done');
  assert.equal(lastAssistant(conversation).text, 'Finished.');
  assert.deepEqual(await other.resumeResearch(first.conversationId), { resumed: false, conversationId: first.conversationId, reason: 'finished' });
});

test('only one page drives a run: resume elsewhere reports busy while the Web Lock is held', OPTIONS, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const script = async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.message') { await play(emit, [{ type: 'session.status_running' }]); await gate; await play(emit, [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]); }
    }
  };
  const setup = await harness({ script, locks: fakeLocks() });
  const started = await setup.research.startResearch({ itemId: 'art' });
  await waitFor(async () => (await setup.conversations.getConversation(started.conversationId))?.research.status === 'running', 'running');
  const elsewhere = setup.make();
  assert.deepEqual(await elsewhere.resumeResearch(started.conversationId), { resumed: false, conversationId: started.conversationId, reason: 'busy' });
  const again = await setup.research.startResearch({ itemId: 'art' });
  assert.deepEqual([again.conversationId, again.existing], [started.conversationId, true], 'an item already being researched is not started twice');
  await assert.rejects(setup.research.continueResearch(started.conversationId, 'more'), error => error.code === 'busy');
  await assert.rejects(setup.research.undoResearch(started.conversationId), error => error.code === 'busy');
  release();
  assert.equal(await started.done, 'done');
});

test('stop sends user.interrupt; the interrupted end_turn becomes "stopped"', OPTIONS, async () => {
  const script = async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.message') await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', id: 'sevt_m', content: [{ type: 'text', text: 'Working.' }] }]);
      if (event.type === 'user.interrupt') await play(emit, [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
    }
  };
  const setup = await harness({ script });
  const started = await setup.research.startResearch({ itemId: 'art' });
  await waitFor(async () => lastAssistant(await setup.conversations.getConversation(started.conversationId))?.text === 'Working.', 'first text');
  assert.deepEqual(await setup.research.stopResearch(started.conversationId), { stopping: true });
  assert.equal(await started.done, 'stopped');
  assert.equal(setup.server.posted('user.interrupt').length, 1);
  const conversation = await setup.conversations.getConversation(started.conversationId);
  assert.equal(conversation.research.status, 'stopped');
  assert.ok(conversation.research.stopRequestedAt);
  assert.equal(lastAssistant(conversation).error, 'Stopped');
  assert.equal(lastAssistant(conversation).research.live, false);
  assert.deepEqual(await setup.research.stopResearch(started.conversationId), { stopped: false, status: 'stopped' });
});

test('a call that arrives after stop is answered with a stop result and never written', OPTIONS, async () => {
  let stop;
  const script = async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.message') { await play(emit, [{ type: 'session.status_running' }]); await stop(); await play(emit, [{ type: 'agent.custom_tool_use', id: 'sevt_late', name: 'append_to_document', input: { markdown: 'Too late.' } }, { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_late'] } }]); }
      if (event.type === 'user.custom_tool_result') await play(emit, [{ type: 'session.status_running' }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
    }
  };
  const setup = await harness({ script });
  const started = await setup.research.startResearch({ itemId: 'art' });
  stop = () => setup.research.stopResearch(started.conversationId);
  assert.equal(await started.done, 'stopped');
  assert.equal(JSON.parse(setup.server.posted('user.custom_tool_result')[0].content[0].text).error, 'stopped');
  assert.equal((await itemOf(setup.store, 'art')).content, 'My note.');
});

test('budget_reached pauses as waiting/budget; raising the cap resumes the same turn to the end', OPTIONS, async () => {
  const script = async ({ session, posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.message') {
        await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', id: 'sevt_1', content: [{ type: 'text', text: 'Part one.' }] },
          { type: 'session.usage', usage: { list_cost: { amount: '501', currency: 'USD' } } }, { type: 'session.status_idle', stop_reason: { type: 'budget_reached' } }]);
        session.atBudget = true;
      }
      if (event.type === 'budget') {
        session.atBudget = false;
        await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', id: 'sevt_2', content: [{ type: 'text', text: 'Part two.' }] }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
      }
    }
  };
  const setup = await harness({ script });
  const started = await setup.research.startResearch({ itemId: 'art' });
  assert.equal(await started.done, 'waiting');
  let conversation = await setup.conversations.getConversation(started.conversationId);
  assert.deepEqual([conversation.research.status, conversation.research.reason], ['waiting', 'budget']);
  assert.equal(lastAssistant(conversation).research.live, false);
  assert.equal(conversation.research.usage.costUsd, 0.37);
  await assert.rejects(setup.research.raiseResearchBudget(started.conversationId, 'lots'), error => error.code === 'bad_request');

  const raised = await setup.research.raiseResearchBudget(started.conversationId, 12.5);
  assert.equal(raised.budgetUsd, 12.5);
  const update = setup.server.calls.find(call => call.method === 'POST' && /^\/sessions\/[^/]+$/.test(call.path));
  assert.deepEqual(update.body, { budget: { type: 'limit', max_list_cost: { amount: '1250', currency: 'USD' } } });
  assert.equal(await raised.done, 'done');
  conversation = await setup.conversations.getConversation(started.conversationId);
  assert.equal(conversation.research.status, 'done');
  assert.equal(conversation.research.settings.budgetUsd, 12.5);
  assert.equal(lastAssistant(conversation).text, 'Part one.\n\nPart two.');
});

test('a cap below what was spent is refused and leaves the research waiting', OPTIONS, async () => {
  const script = async ({ posted, emit }) => { for (const event of posted) if (event.type === 'user.message') await play(emit, [{ type: 'session.status_running' }, { type: 'session.status_idle', stop_reason: { type: 'budget_reached' } }]); };
  const setup = await harness({ script });
  const started = await setup.research.startResearch({ itemId: 'art' });
  await started.done;
  setup.server.failNext('POST', /^\/sessions\/[^/]+$/, json({ type: 'error', error: { type: 'invalid_request_error', message: 'budget.max_list_cost must be greater than the session\'s consumed list cost' } }, 400));
  await assert.rejects(setup.research.raiseResearchBudget(started.conversationId, 2), error => error.code === 'budget');
  assert.equal((await setup.conversations.getConversation(started.conversationId)).research.status, 'waiting');
});

test('errors end the run readably: auth at provisioning, refusal, retries exhausted, a terminated session', OPTIONS, async () => {
  const auth = await harness();
  auth.server.failNext('POST', /^\/environments$/, json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401));
  const failed = await auth.research.startResearch({ itemId: 'art' });
  assert.equal(await failed.done, 'failed');
  let conversation = await auth.conversations.getConversation(failed.conversationId);
  assert.equal(conversation.research.errorCode, 'auth', '"Open AI settings" keeps working through the shared error code');
  assert.match(conversation.research.error, /Check the API key/);
  assert.match(lastAssistant(conversation).error, /Check the API key/);

  const outcomes = [
    [{ type: 'session.status_idle', stop_reason: { type: 'refusal' }, stop_details: { type: 'refusal', category: 'cyber', explanation: 'This request is not something I can help with.' } }, /Claude stopped this research: This request/],
    [{ type: 'session.error', error: { type: 'billing_error', message: 'x', retry_status: { type: 'exhausted' } } }, null],
    [{ type: 'session.status_terminated' }, /ended unexpectedly/],
  ];
  for (const [last, pattern] of outcomes) {
    const events = last.type === 'session.error' ? [last, { type: 'session.status_idle', stop_reason: { type: 'retries_exhausted' } }] : [last];
    const script = async ({ posted, emit }) => { for (const event of posted) if (event.type === 'user.message') await play(emit, [{ type: 'session.status_running' }, ...events]); };
    const setup = await harness({ script });
    const run = await setup.research.startResearch({ itemId: 'art' });
    assert.equal(await run.done, 'failed');
    conversation = await setup.conversations.getConversation(run.conversationId);
    assert.match(conversation.research.error, pattern || /billing problem/);
  }
});

test('a session create 404 re-checks the agent and environment, recreates what is gone, and continues', OPTIONS, async () => {
  const script = async ({ posted, emit }) => { for (const event of posted) if (event.type === 'user.message') await play(emit, [{ type: 'session.status_running' }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]); };
  const setup = await harness({ script });
  const first = await setup.research.startResearch({ itemId: 'art' });
  assert.equal(await first.done, 'done');
  // The agent was deleted in the Console after it was provisioned.
  setup.server.agents.clear();
  const second = await setup.research.startResearch({ itemId: 'note' });
  assert.equal(await second.done, 'done');
  assert.equal(setup.server.agents.size, 1, 'a new agent was created');
  assert.equal(setup.server.calls.filter(call => call.method === 'POST' && call.path === '/sessions').length, 3, 'one failed create, one retry');
});

test('continueResearch reuses the session; the earlier turn\'s idle never ends the new turn', OPTIONS, async () => {
  let turn = 0;
  const script = async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type !== 'user.message') continue;
      turn++;
      await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', id: `sevt_turn${turn}`, content: [{ type: 'text', text: `Turn ${turn}.` }] }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
    }
  };
  const setup = await harness({ script });
  const started = await setup.research.startResearch({ itemId: 'art' });
  assert.equal(await started.done, 'done');
  await assert.rejects(setup.research.continueResearch(started.conversationId, '   '), error => error.code === 'bad_request');
  const next = await setup.research.continueResearch(started.conversationId, 'Also compare it with Defuddle.');
  assert.equal(await next.done, 'done');
  assert.equal(setup.server.sessions.size, 1, 'the same session');
  const followUp = setup.server.posted('user.message')[1].content[0].text;
  assert.match(followUp, /^Follow-up from the user \(today is \d{4}-\d{2}-\d{2}\):\n\n<instructions>\nAlso compare it with Defuddle\.\n<\/instructions>/);
  const conversation = await setup.conversations.getConversation(started.conversationId);
  assert.deepEqual(conversation.messages.map(message => [message.role, message.text]), [
    ['user', 'Research “Readability in 2026”'], ['assistant', 'Turn 1.'], ['user', 'Also compare it with Defuddle.'], ['assistant', 'Turn 2.'],
  ]);
  assert.equal(lastAssistant(conversation).research.baseline, 1);
  assert.equal(conversation.research.status, 'done');
});

test('continueResearch starts a new session with a summary when the old one is gone', OPTIONS, async () => {
  const script = async ({ posted, emit }) => { for (const event of posted) if (event.type === 'user.message') await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', content: [{ type: 'text', text: 'Earlier findings.' }] }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]); };
  const setup = await harness({ script });
  const started = await setup.research.startResearch({ itemId: 'art' });
  await started.done;
  const oldSession = (await setup.conversations.getConversation(started.conversationId)).research.sessionId;
  setup.server.sessions.clear();
  const next = await setup.research.continueResearch(started.conversationId, 'Dig into licensing.');
  assert.equal(await next.done, 'done');
  const kickoffs = setup.server.posted('user.message');
  assert.match(kickoffs.at(-1).content[0].text, /^Continue the research on this page[\s\S]*<instructions>\nDig into licensing\.\n<\/instructions>[\s\S]*<earlier_research>\nEarlier findings\.\n<\/earlier_research>/);
  const conversation = await setup.conversations.getConversation(started.conversationId);
  assert.notEqual(conversation.research.sessionId, oldSession);
  assert.equal(lastAssistant(conversation).research.sessionId, conversation.research.sessionId);
  assert.equal(conversation.research.status, 'done');
});

// Each user.message is a turn that ends on its own, except the first, which keeps working until it is interrupted.
function stoppableScript() {
  let turn = 0;
  return async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.interrupt') await play(emit, [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
      if (event.type !== 'user.message') continue;
      turn++;
      const events = [{ type: 'session.status_running' }, { type: 'agent.message', id: `sevt_turn${turn}`, content: [{ type: 'text', text: `Turn ${turn}.` }] }];
      await play(emit, turn === 1 ? events : [...events, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
    }
  };
}

test('a follow-up after a stop runs to the end: the earlier stop is not adopted again', OPTIONS, async () => {
  const setup = await harness({ script: stoppableScript() });
  const started = await setup.research.startResearch({ itemId: 'art' });
  await waitFor(async () => lastAssistant(await setup.conversations.getConversation(started.conversationId))?.text === 'Turn 1.', 'first turn');
  await setup.research.stopResearch(started.conversationId);
  assert.equal(await started.done, 'stopped');

  for (const [request, turn] of [['Now look at licensing.', 2], ['And the changelog.', 3]]) {
    const next = await setup.research.continueResearch(started.conversationId, request);
    assert.equal(await next.done, 'done', `follow-up ${turn - 1} ran to its end`);
    const messages = accepted(setup.server, 'user.message');
    assert.equal(messages.length, turn, 'the follow-up reached the session');
    assert.ok(messages.at(-1).content[0].text.includes(`<instructions>\n${request}\n</instructions>`));
    const conversation = await setup.conversations.getConversation(started.conversationId);
    assert.equal(conversation.research.status, 'done');
    assert.equal(conversation.research.stopRequestedAt, undefined, 'the stored stop is cleared');
    assert.deepEqual([lastAssistant(conversation).text, lastAssistant(conversation).error], [`Turn ${turn}.`, '']);
  }
  assert.equal(setup.server.posted('user.interrupt').length, 1, 'only the real stop interrupted the session');
});

test('a follow-up after another view stopped a run nobody drove runs to the end', OPTIONS, async () => {
  // staleMs 0: no heartbeat counts as fresh, so the second view treats the run as unowned.
  const setup = await harness({ script: stoppableScript(), timing: { staleMs: 0 } });
  const started = await setup.research.startResearch({ itemId: 'art' });
  await waitFor(async () => lastAssistant(await setup.conversations.getConversation(started.conversationId))?.text === 'Turn 1.', 'first turn');
  setup.research.dispose();
  assert.equal(await started.done, 'detached');
  const other = setup.make();
  assert.deepEqual(await other.stopResearch(started.conversationId), { stopping: true });
  let conversation = await setup.conversations.getConversation(started.conversationId);
  assert.equal(conversation.research.status, 'stopped');
  assert.ok(conversation.research.stopRequestedAt);
  // The interrupt idles the session (it jumps the queue) well before anyone types a follow-up.
  await waitFor(() => setup.server.session(conversation.research.sessionId).events.at(-1)?.type === 'session.status_idle', 'the interrupted turn to end');

  const next = await other.continueResearch(started.conversationId, 'Now look at licensing.');
  assert.equal(await next.done, 'done');
  assert.equal(accepted(setup.server, 'user.message').length, 2);
  conversation = await setup.conversations.getConversation(started.conversationId);
  assert.equal(conversation.research.stopRequestedAt, undefined);
  assert.equal(lastAssistant(conversation).text, 'Turn 2.');
});

test('a newer stop during a follow-up is still adopted from another view', OPTIONS, async () => {
  const setup = await harness({ script: stoppableScript() });
  const started = await setup.research.startResearch({ itemId: 'art' });
  await waitFor(async () => lastAssistant(await setup.conversations.getConversation(started.conversationId))?.text === 'Turn 1.', 'first turn');
  await setup.research.stopResearch(started.conversationId);
  assert.equal(await started.done, 'stopped');
  // The follow-up's turn never ends on its own, and a view that does not drive it asks for the stop through storage.
  setup.server.script = async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.message') await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', id: 'sevt_long', content: [{ type: 'text', text: 'Still going.' }] }]);
      if (event.type === 'user.interrupt') await play(emit, [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
    }
  };
  const next = await setup.research.continueResearch(started.conversationId, 'Keep going.');
  await waitFor(async () => lastAssistant(await setup.conversations.getConversation(started.conversationId))?.text === 'Still going.', 'follow-up text');
  const stored = await setup.conversations.getConversation(started.conversationId);
  stored.research.stopRequestedAt = new Date(Date.now() + 1000).toISOString();
  await setup.conversations.saveConversation(stored);
  // The run's next save (here, after a new event) reads the stored record and adopts the stop.
  setup.server.emit(stored.research.sessionId, { type: 'agent.thinking' });
  assert.equal(await next.done, 'stopped');
  assert.equal(setup.server.posted('user.interrupt').length, 2);
});

test('a follow-up to a session that never got its kickoff sends the full kickoff, not a bare follow-up', OPTIONS, async () => {
  const script = async ({ posted, emit }) => { for (const event of posted) if (event.type === 'user.message') await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', content: [{ type: 'text', text: 'Researched.' }] }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]); };
  const kickoff = /^Research this page the user saved in Still[\s\S]*Title: Readability in 2026\nURL: https:\/\/example\.com\/readability[\s\S]*<instructions>\nFocus on licensing\.\n<\/instructions>[\s\S]*<saved_page>\n# Original/;

  // The kickoff POST fails for good: the run fails with a session that has no message.
  const failed = await harness({ script });
  failed.server.failNext('POST', /^\/sessions\/[^/]+\/events$/, json({ type: 'error', error: { type: 'invalid_request_error', message: 'Bad event.' } }, 400));
  const first = await failed.research.startResearch({ itemId: 'art', instructions: 'Focus on pricing.' });
  assert.equal(await first.done, 'failed');
  let conversation = await failed.conversations.getConversation(first.conversationId);
  assert.ok(conversation.research.sessionId);
  assert.equal(lastAssistant(conversation).research.sent, false);
  assert.equal(accepted(failed.server, 'user.message').length, 0);
  const next = await failed.research.continueResearch(first.conversationId, 'Focus on licensing.');
  assert.equal(await next.done, 'done');
  assert.equal(failed.server.sessions.size, 1, 'the same session');
  let messages = accepted(failed.server, 'user.message');
  assert.equal(messages.length, 1);
  assert.match(messages[0].content[0].text, kickoff);
  assert.doesNotMatch(messages[0].content[0].text, /Follow-up from the user|Continue the research/);
  conversation = await failed.conversations.getConversation(first.conversationId);
  assert.deepEqual([conversation.research.status, lastAssistant(conversation).text, lastAssistant(conversation).research.sent], ['done', 'Researched.', true]);

  // A stop while the run is still starting, after the session was created.
  const stopped = await harness({ script });
  let id = '';
  stopped.server.failNext('POST', /^\/sessions$/, async call => {
    await waitFor(() => id, 'conversation id');
    await stopped.research.stopResearch(id);
    return stopped.server.fetch(call.url, { method: 'POST', headers: call.headers, body: JSON.stringify(call.body) });
  });
  const started = await stopped.research.startResearch({ itemId: 'art' });
  id = started.conversationId;
  assert.equal(await started.done, 'stopped');
  conversation = await stopped.conversations.getConversation(id);
  assert.ok(conversation.research.sessionId);
  assert.equal(lastAssistant(conversation).research.sent, false);
  const after = await stopped.research.continueResearch(id, 'Focus on licensing.');
  assert.equal(await after.done, 'done');
  messages = accepted(stopped.server, 'user.message');
  assert.equal(messages.length, 1);
  assert.match(messages[0].content[0].text, kickoff);
});

test('Try again on a kickoff that never went out keeps its focus and adds no second request', OPTIONS, async () => {
  const script = async ({ posted, emit }) => { for (const event of posted) if (event.type === 'user.message') await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', content: [{ type: 'text', text: 'Researched.' }] }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]); };
  const kickoffFails = async instructions => {
    const setup = await harness({ script });
    setup.server.failNext('POST', /^\/sessions\/[^/]+\/events$/, json({ type: 'error', error: { type: 'invalid_request_error', message: 'Bad event.' } }, 400));
    const first = await setup.research.startResearch({ itemId: 'art', instructions });
    assert.equal(await first.done, 'failed');
    return { setup, id: first.conversationId };
  };
  const transcript = async (setup, id) => (await setup.conversations.getConversation(id)).messages.map(message => [message.role, message.role === 'user' ? message.text : message.research?.request?.text]);

  // Try again sends the focus it was started with (ui/research.js retryText): one request in the transcript.
  const focused = await kickoffFails('Focus on pricing.');
  assert.equal(await (await focused.setup.research.continueResearch(focused.id, 'Focus on pricing.')).done, 'done');
  assert.deepEqual(await transcript(focused.setup, focused.id), [['user', 'Research “Readability in 2026”\n\nFocus on pricing.'], ['assistant', 'Focus on pricing.'], ['assistant', 'Focus on pricing.']]);
  assert.match(accepted(focused.setup.server, 'user.message')[0].content[0].text, /^Research this page[\s\S]*<instructions>\nFocus on pricing\.\n<\/instructions>/);

  // An empty retry keeps the original focus instead of dropping it.
  const empty = await kickoffFails('Focus on pricing.');
  assert.equal(await (await empty.setup.research.continueResearch(empty.id, '')).done, 'done');
  assert.deepEqual((await transcript(empty.setup, empty.id)).map(([role]) => role), ['user', 'assistant', 'assistant']);
  assert.match(accepted(empty.setup.server, 'user.message')[0].content[0].text, /<instructions>\nFocus on pricing\.\n<\/instructions>/);

  // Without a focus, Try again sends no text: no empty request appears, and the kickoff has no instructions.
  const plain = await kickoffFails('');
  assert.equal(await (await plain.setup.research.continueResearch(plain.id, '')).done, 'done');
  assert.deepEqual(await transcript(plain.setup, plain.id), [['user', 'Research “Readability in 2026”'], ['assistant', ''], ['assistant', '']]);
  assert.doesNotMatch(accepted(plain.setup.server, 'user.message')[0].content[0].text, /<instructions>/);

  // A different request typed after the failure is the user's new request, so it is shown.
  const changed = await kickoffFails('Focus on pricing.');
  assert.equal(await (await changed.setup.research.continueResearch(changed.id, 'Focus on licensing.')).done, 'done');
  assert.deepEqual((await transcript(changed.setup, changed.id)).map(([role, text]) => `${role}:${text}`).slice(2), ['user:Focus on licensing.', 'assistant:Focus on licensing.']);
});

test('a follow-up to a new session that never got its continuation still carries the earlier work', OPTIONS, async () => {
  const script = async ({ posted, emit }) => { for (const event of posted) if (event.type === 'user.message') await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', content: [{ type: 'text', text: 'Earlier findings.' }] }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]); };
  const setup = await harness({ script });
  const started = await setup.research.startResearch({ itemId: 'art' });
  assert.equal(await started.done, 'done');
  // The first session is gone; the continuation's message to its new session fails for good.
  setup.server.sessions.clear();
  setup.server.failNext('POST', /^\/sessions\/[^/]+\/events$/, json({ type: 'error', error: { type: 'invalid_request_error', message: 'Bad event.' } }, 400));
  const lost = await setup.research.continueResearch(started.conversationId, 'Dig into licensing.');
  assert.equal(await lost.done, 'failed');
  assert.equal(setup.server.sessions.size, 1);
  const next = await setup.research.continueResearch(started.conversationId, 'Dig into licensing, please.');
  assert.equal(await next.done, 'done');
  assert.equal(setup.server.sessions.size, 1, 'the new session is reused');
  const [message] = accepted(setup.server, 'user.message');
  assert.match(message.content[0].text, /^Continue the research on this page[\s\S]*Title: Readability in 2026[\s\S]*<instructions>\nDig into licensing, please\.\n<\/instructions>[\s\S]*<earlier_research>\nEarlier findings\.\n<\/earlier_research>/);
});

test('raising the cap after a stop that ended at the cap continues the research', OPTIONS, async () => {
  const script = async ({ session, posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.message') await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', id: 'sevt_1', content: [{ type: 'text', text: 'Part one.' }] }]);
      // The cap is reached as the interrupt arrives: the turn pauses at the cap instead of ending.
      if (event.type === 'user.interrupt') { session.atBudget = true; await play(emit, [{ type: 'session.status_idle', stop_reason: { type: 'budget_reached' } }]); }
      if (event.type === 'budget') {
        session.atBudget = false;
        await play(emit, [{ type: 'session.status_running' }, { type: 'agent.custom_tool_use', id: 'sevt_w', name: 'append_to_document', input: { markdown: 'After the raise.' } }, { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_w'] } }]);
      }
      if (event.type === 'user.custom_tool_result') await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', id: 'sevt_2', content: [{ type: 'text', text: 'Part two.' }] }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
    }
  };
  const setup = await harness({ script });
  const started = await setup.research.startResearch({ itemId: 'art' });
  await waitFor(async () => lastAssistant(await setup.conversations.getConversation(started.conversationId))?.text === 'Part one.', 'first text');
  await setup.research.stopResearch(started.conversationId);
  assert.equal(await started.done, 'waiting');
  assert.ok((await setup.conversations.getConversation(started.conversationId)).research.stopRequestedAt);

  const raised = await setup.research.raiseResearchBudget(started.conversationId, 12);
  assert.equal(await raised.done, 'done');
  const conversation = await setup.conversations.getConversation(started.conversationId);
  assert.equal(conversation.research.stopRequestedAt, undefined);
  assert.equal(lastAssistant(conversation).text, 'Part one.\n\nPart two.');
  assert.match((await itemOf(setup.store, 'art')).content, /After the raise\./, 'the write after the raise was applied, not refused as stopped');
});

test('a stop that lands before a follow-up is sent keeps it from being sent', OPTIONS, async () => {
  let turn = 0;
  const script = async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type !== 'user.message') continue;
      turn++;
      await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', id: `sevt_t${turn}`, content: [{ type: 'text', text: `Turn ${turn}.` }] }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
    }
  };
  const setup = await harness({ script });
  const started = await setup.research.startResearch({ itemId: 'art' });
  assert.equal(await started.done, 'done');
  // The stop arrives while the follow-up replays the session's history, after its status is 'running'.
  setup.server.failNext('GET', /^\/sessions\/[^/]+\/events$/, async call => {
    await setup.research.stopResearch(started.conversationId);
    return setup.server.fetch(call.url, { method: 'GET', headers: call.headers });
  });
  const next = await setup.research.continueResearch(started.conversationId, 'Also compare it with Defuddle.');
  assert.equal(await next.done, 'stopped');
  assert.equal(accepted(setup.server, 'user.message').length, 1, 'the follow-up was never sent');
  assert.equal(turn, 1);
  const conversation = await setup.conversations.getConversation(started.conversationId);
  assert.deepEqual([conversation.research.status, lastAssistant(conversation).error, lastAssistant(conversation).research.sent], ['stopped', 'Stopped', false]);
});

test('stopping a paused run: a lost connection still interrupts the session; one paused at its cap does not, and is not reused', OPTIONS, async () => {
  // Paused because the connection was lost: the session may still be working, so it is interrupted.
  let server;
  const lostScript = async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type !== 'user.message') continue;
      server.failNext('GET', /\/events\/stream$/, () => { throw new TypeError('Failed to fetch'); }, 1000);
      server.dropStreams([...server.sessions.keys()][0]);
      await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', id: 'sevt_l', content: [{ type: 'text', text: 'Working offline.' }] }]);
    }
  };
  const lost = await harness({ script: lostScript, timing: { maxReconnects: 1 } });
  server = lost.server;
  const offline = await lost.research.startResearch({ itemId: 'art' });
  assert.equal(await offline.done, 'waiting');
  let conversation = await lost.conversations.getConversation(offline.conversationId);
  assert.deepEqual([conversation.research.status, conversation.research.reason], ['waiting', 'connection']);
  lost.server.failures.length = 0;
  assert.deepEqual(await lost.research.stopResearch(offline.conversationId), { stopping: true });
  assert.equal(accepted(lost.server, 'user.interrupt').length, 1, 'the session was interrupted');
  conversation = await lost.conversations.getConversation(offline.conversationId);
  assert.equal(conversation.research.status, 'stopped');
  assert.equal(conversation.research.budgetStopped, undefined);

  // Paused at its cap: an interrupt would be ignored, and the session cannot take a follow-up until its cap is raised.
  const capScript = async ({ session, posted, emit }) => {
    for (const event of posted) {
      if (event.type !== 'user.message') continue;
      // A session at its cap cannot run another turn.
      if (session.atBudget) { await play(emit, [{ type: 'session.status_idle', stop_reason: { type: 'budget_reached' } }]); continue; }
      await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', content: [{ type: 'text', text: 'Some findings.' }] }, { type: 'session.status_idle', stop_reason: { type: 'budget_reached' } }]);
      session.atBudget = true;
    }
  };
  const capped = await harness({ script: capScript });
  const paused = await capped.research.startResearch({ itemId: 'art' });
  assert.equal(await paused.done, 'waiting');
  assert.deepEqual(await capped.research.stopResearch(paused.conversationId), { stopping: true });
  assert.equal(capped.server.posted('user.interrupt').length, 0, 'no interrupt for a session paused at its cap');
  conversation = await capped.conversations.getConversation(paused.conversationId);
  assert.deepEqual([conversation.research.status, conversation.research.budgetStopped], ['stopped', true]);
  const oldSession = conversation.research.sessionId;
  const next = await capped.research.continueResearch(paused.conversationId, 'Dig into licensing.');
  assert.equal(await next.done, 'waiting', 'the follow-up ran (and paused at the new session’s own cap here)');
  assert.equal(capped.server.sessions.size, 2, 'a new session, not the one stuck at its cap');
  assert.equal(lastAssistant(await capped.conversations.getConversation(paused.conversationId)).text, 'Some findings.', 'the new session did the work');
  assert.match(accepted(capped.server, 'user.message').at(-1).content[0].text, /^Continue the research on this page[\s\S]*<instructions>\nDig into licensing\.\n<\/instructions>/);
  conversation = await capped.conversations.getConversation(paused.conversationId);
  assert.notEqual(conversation.research.sessionId, oldSession);
  assert.equal(conversation.research.budgetStopped, undefined, 'the new session starts clean');
});

test('raising the cap or resuming a run lets Undo cover what it writes next; raising a finished run does not', OPTIONS, async () => {
  const script = async ({ session, posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.message') {
        await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', id: 'sevt_1', content: [{ type: 'text', text: 'Part one.' }] }, { type: 'session.status_idle', stop_reason: { type: 'budget_reached' } }]);
        session.atBudget = true;
      }
      if (event.type === 'budget' && session.atBudget) {
        session.atBudget = false;
        await play(emit, [{ type: 'session.status_running' }, { type: 'agent.custom_tool_use', id: 'sevt_w', name: 'append_to_document', input: { markdown: 'After the raise.' } }, { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_w'] } }]);
      }
      if (event.type === 'user.custom_tool_result') await play(emit, [{ type: 'session.status_running' }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
    }
  };
  const setup = await harness({ script });
  const started = await setup.research.startResearch({ itemId: 'art' });
  assert.equal(await started.done, 'waiting');
  await setup.research.undoResearch(started.conversationId);
  assert.ok((await setup.conversations.getConversation(started.conversationId)).research.undoneAt, 'undone while paused');
  const raised = await setup.research.raiseResearchBudget(started.conversationId, 10);
  assert.equal(await raised.done, 'done');
  let conversation = await setup.conversations.getConversation(started.conversationId);
  assert.equal(conversation.research.undoneAt, undefined, 'the run went on, so its new writes can be undone');
  const undone = await setup.research.undoResearch(started.conversationId);
  assert.equal(undone.section, 'removed', 'Undo removes the section written after the raise');
  assert.doesNotMatch((await itemOf(setup.store, 'art')).content, /After the raise/);
  // A finished run whose cap changes does not continue, so its undo stays done.
  await setup.research.raiseResearchBudget(started.conversationId, 20);
  conversation = await setup.conversations.getConversation(started.conversationId);
  assert.ok(conversation.research.undoneAt);
  assert.equal((await setup.research.undoResearch(started.conversationId)).alreadyUndone, true);

  // Resuming a run paused by a lost connection.
  let server;
  const lostScript = async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.message') {
        server.failNext('POST', /\/events$/, () => { throw new TypeError('Failed to fetch'); }, 1000);
        await play(emit, [{ type: 'session.status_running' }, { type: 'agent.custom_tool_use', id: 'sevt_c', name: 'append_to_document', input: { markdown: 'Written once.' } }, { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_c'] } }]);
      }
      if (event.type === 'user.custom_tool_result') await play(emit, [{ type: 'session.status_running' }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
    }
  };
  const lost = await harness({ script: lostScript, timing: { maxReconnects: 1 } });
  server = lost.server;
  const first = await lost.research.startResearch({ itemId: 'art' });
  assert.equal(await first.done, 'waiting');
  await lost.research.undoResearch(first.conversationId);
  assert.ok((await lost.conversations.getConversation(first.conversationId)).research.undoneAt);
  server.failures.length = 0;
  const resumed = await lost.make().resumeResearch(first.conversationId);
  assert.equal(await resumed.done, 'done');
  conversation = await lost.conversations.getConversation(first.conversationId);
  assert.equal(conversation.research.undoneAt, undefined);
});

test('a run past MAX_STEPS folds its oldest steps into one row and keeps at most MAX_STEPS, which storage keeps whole', OPTIONS, async () => {
  const total = MAX_STEPS + 30;
  let most = 0, firstFold = null;
  const script = async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type !== 'user.message') continue;
      const steps = Array.from({ length: total }, (_, k) => [
        { type: 'agent.tool_use', id: `sevt_q${k}`, name: 'web_search', input: { query: `query ${k}` } },
        { type: 'agent.tool_result', tool_use_id: `sevt_q${k}`, content: [] },
      ]).flat();
      await play(emit, [{ type: 'session.status_running' }, ...steps, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }], () => Promise.resolve());
    }
  };
  const setup = await harness({ script });
  // Every state the run hands out (and may save) stays within MAX_STEPS, from the first fold on.
  setup.research.subscribeResearch(event => {
    const live = event.message?.research?.steps || [];
    most = Math.max(most, live.length);
    if (!firstFold && live[0]?.id === 'collapsed') firstFold = live.map(entry => entry.id);
  });
  const started = await setup.research.startResearch({ itemId: 'art' });
  assert.equal(await started.done, 'done');
  assert.equal(most, MAX_STEPS, 'never more than MAX_STEPS rows');
  assert.equal(firstFold.length, MAX_STEPS, 'not even right after the first fold');
  const steps = lastAssistant(await setup.conversations.getConversation(started.conversationId)).research.steps;
  assert.equal(steps.length, MAX_STEPS, 'at most MAX_STEPS rows, the folded row included');
  assert.equal(steps[0].id, 'collapsed', 'the "earlier steps" row survives saving');
  assert.equal(steps[0].count, total - (MAX_STEPS - 1));
  assert.equal(steps[0].label, `${total - (MAX_STEPS - 1)} earlier steps`);
  assert.equal(steps.at(-1).detail, `query ${total - 1}`);
  assert.equal(steps[0].count + steps.length - 1, total, 'every step is counted once');
});

test('the assistant’s store passes page moves and section writes through to lib/store.js', async () => {
  const source = await readFile(new URL('../extension/lib/ai/index.js', import.meta.url), 'utf8');
  const list = /const STORE_METHODS = \[([^\]]*)\]/.exec(source)?.[1] || '';
  const names = [...list.matchAll(/'([A-Za-z]+)'/g)].map(match => match[1]);
  for (const name of ['movePage', 'upsertContentSection']) assert.ok(names.includes(name), name);
  for (const name of names) assert.equal(typeof libraryStore[name], 'function', `lib/store.js exports ${name}`);
});

test('allowOriginalEdits travels from startResearch to the tools and the kickoff', OPTIONS, async () => {
  const script = async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.message') await play(emit, [{ type: 'session.status_running' }, { type: 'agent.custom_tool_use', id: 'sevt_e', name: 'edit_original', input: { markdown: '# Cleaned up' } }, { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_e'] } }]);
      if (event.type === 'user.custom_tool_result') await play(emit, [{ type: 'session.status_running' }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
    }
  };
  const refused = await harness({ script });
  await (await refused.research.startResearch({ itemId: 'art' })).done;
  assert.equal((await itemOf(refused.store, 'art')).articleContent, '# Original\n\nCaptured text.');
  assert.equal(JSON.parse(refused.server.posted('user.custom_tool_result')[0].content[0].text).error, 'not_allowed');
  assert.equal(refused.server.posted('user.custom_tool_result')[0].is_error, true);

  const allowed = await harness({ script });
  await (await allowed.research.startResearch({ itemId: 'art', allowOriginalEdits: true })).done;
  assert.equal((await itemOf(allowed.store, 'art')).articleContent, '# Cleaned up');
  assert.match(allowed.server.posted('user.message')[0].content[0].text, /Original page edits: allowed, because the user asked/);
});

test('undoResearch removes an unchanged section, trashes subpages, restores the original, and runs once', OPTIONS, async () => {
  const script = async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.message') await play(emit, [{ type: 'session.status_running' },
        { type: 'agent.custom_tool_use', id: 'sevt_1', name: 'append_to_document', input: { markdown: 'Findings.' } },
        { type: 'agent.custom_tool_use', id: 'sevt_2', name: 'create_subpage', input: { title: 'Deep dive', markdown: 'Details.' } },
        { type: 'agent.custom_tool_use', id: 'sevt_3', name: 'edit_original', input: { markdown: 'New original.' } },
        { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_1', 'sevt_2', 'sevt_3'] } }]);
      if (event.type === 'user.custom_tool_result' && event.custom_tool_use_id === 'sevt_3') await play(emit, [{ type: 'session.status_running' }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
    }
  };
  const setup = await harness({ script, settings: { allowOriginalEdits: true } });
  const started = await setup.research.startResearch({ itemId: 'art' });
  assert.equal(await started.done, 'done');
  const before = await itemOf(setup.store, 'art');
  assert.match(before.content, /Findings\./);
  assert.equal(before.articleContent, 'New original.');
  const page = (await setup.store.loadLibrary()).items.find(entry => entry.title === 'Deep dive');
  const result = await setup.research.undoResearch(started.conversationId);
  assert.deepEqual(result, { section: 'removed', original: 'restored', trashed: [page.id], kept: [] });
  const after = await itemOf(setup.store, 'art');
  assert.equal(after.content, 'My note.');
  assert.equal(after.articleContent, '# Original\n\nCaptured text.');
  assert.ok((await itemOf(setup.store, page.id)).deletedAt, 'the subpage is in the Trash, not deleted');
  assert.equal((await setup.research.undoResearch(started.conversationId)).alreadyUndone, true);
  assert.ok((await setup.conversations.getConversation(started.conversationId)).research.undoneAt);
});

test('undo keeps what the user changed since: an edited section and an edited original stay', OPTIONS, async () => {
  const script = async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.message') await play(emit, [{ type: 'session.status_running' },
        { type: 'agent.custom_tool_use', id: 'sevt_1', name: 'append_to_document', input: { markdown: 'Findings.' } },
        { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_1'] } }]);
      if (event.type === 'user.custom_tool_result') await play(emit, [{ type: 'session.status_running' }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
    }
  };
  const setup = await harness({ script });
  const started = await setup.research.startResearch({ itemId: 'art' });
  await started.done;
  const item = await itemOf(setup.store, 'art');
  await setup.store.updateItem('art', { content: item.content.replace('Findings.', 'Findings, annotated.') });
  const result = await setup.research.undoResearch(started.conversationId);
  assert.deepEqual(result, { section: 'changed', original: 'none', trashed: [], kept: ['section'] });
  assert.match((await itemOf(setup.store, 'art')).content, /Findings, annotated\./);
});

test('availability and start errors: preview build, turned off, no Anthropic key, missing item', OPTIONS, async () => {
  const preview = await harness({ extension: false });
  assert.deepEqual(await preview.research.researchAvailability(), { available: false, code: 'extension_only', reason: 'Research runs in the Still extension. It is not available in this preview.' });
  await assert.rejects(preview.research.startResearch({ itemId: 'art' }), error => error.code === 'extension_only');

  const off = await harness({ settings: { enabled: false } });
  assert.equal((await off.research.researchAvailability()).code, 'disabled');
  await assert.rejects(off.research.startResearch({ itemId: 'art' }), error => error.code === 'disabled');

  const bridgeOnly = await harness({ connections: [{ id: 'bridge:x', via: 'bridge', providerId: 'bridge', enabled: true, hasKey: true }] });
  assert.equal((await bridgeOnly.research.researchAvailability()).code, 'no_research_connection');
  await assert.rejects(bridgeOnly.research.startResearch({ itemId: 'art' }), error => error.code === 'no_research_connection');
  assert.equal((await bridgeOnly.conversations.listConversations()).length, 0, 'nothing is saved when research cannot start');

  const ok = await harness();
  assert.deepEqual(await ok.research.researchAvailability(), { available: true, connectionId: 'anthropic-1' });
  await assert.rejects(ok.research.startResearch({ itemId: 'gone' }), error => error.code === 'not_found');
  await assert.rejects(ok.research.startResearch({}), error => error.code === 'bad_request');
  await assert.rejects(ok.research.resumeResearch('missing'), error => error.code === 'not_found');
  assert.equal(ok.server.calls.length, 0);
});

test('deleting the conversation mid-run interrupts the session and stops driving it', OPTIONS, async () => {
  const script = async ({ posted, emit }) => { for (const event of posted) if (event.type === 'user.message') await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', id: 'sevt_x', content: [{ type: 'text', text: 'Going.' }] }]); };
  const setup = await harness({ script });
  const started = await setup.research.startResearch({ itemId: 'art' });
  await waitFor(async () => lastAssistant(await setup.conversations.getConversation(started.conversationId))?.text === 'Going.', 'text');
  await setup.conversations.deleteConversation(started.conversationId);
  // The next save notices; a heartbeat-sized nudge comes from a later event.
  setup.server.emit([...setup.server.sessions.keys()][0], { type: 'agent.message', content: [{ type: 'text', text: 'More.' }] });
  assert.equal(await started.done, 'deleted');
  assert.equal(setup.server.posted('user.interrupt').length, 1);
  assert.equal(await setup.conversations.getConversation(started.conversationId), null, 'the deleted conversation is not brought back');
});

test('a silent stream trips the idle watchdog, reconnects and still sees the end of the turn', OPTIONS, async () => {
  const script = async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type !== 'user.message') continue;
      await play(emit, [{ type: 'session.status_running' }]);
      await new Promise(resolve => setTimeout(resolve, 150));
      await play(emit, [{ type: 'agent.message', id: 'sevt_late', content: [{ type: 'text', text: 'After the silence.' }] }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
    }
  };
  const setup = await harness({ script, timing: { idleMs: 40, maxReconnects: 20 } });
  const started = await setup.research.startResearch({ itemId: 'art' });
  assert.equal(await started.done, 'done');
  assert.ok(setup.server.streamOpens >= 2);
  assert.equal(lastAssistant(await setup.conversations.getConversation(started.conversationId)).text, 'After the silence.');
});

test('a built-in tool that asks for approval is denied, never allowed (no approval prompts in research)', OPTIONS, async () => {
  const script = async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.message') await play(emit, [{ type: 'session.status_running' },
        { type: 'agent.tool_use', id: 'sevt_bash', name: 'bash', input: { command: 'curl https://evil.example' }, evaluated_permission: 'ask' },
        { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_bash'] } }]);
      if (event.type === 'user.tool_confirmation') await play(emit, [{ type: 'session.status_running' }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
    }
  };
  const setup = await harness({ script });
  const started = await setup.research.startResearch({ itemId: 'art' });
  assert.equal(await started.done, 'done');
  const [confirmation] = setup.server.posted('user.tool_confirmation');
  assert.deepEqual([confirmation.tool_use_id, confirmation.result], ['sevt_bash', 'deny']);
  assert.match(confirmation.deny_message, /without approval prompts/);
});

test('undoResearch clears undo state so a follow-up turn without new edits does not clobber user edits on a second undo', OPTIONS, async () => {
  let turn = 0;
  const script = async ({ posted, emit }) => {
    for (const event of posted) {
      if (event.type === 'user.message') {
        turn++;
        if (turn === 1) {
          await play(emit, [{ type: 'session.status_running' },
            { type: 'agent.custom_tool_use', id: 'sevt_1', name: 'append_to_document', input: { markdown: 'Findings.' } },
            { type: 'agent.custom_tool_use', id: 'sevt_2', name: 'create_subpage', input: { title: 'Deep dive', markdown: 'Details.' } },
            { type: 'agent.custom_tool_use', id: 'sevt_3', name: 'edit_original', input: { markdown: 'New original.' } },
            { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_1', 'sevt_2', 'sevt_3'] } }]);
        } else {
          await play(emit, [{ type: 'session.status_running' }, { type: 'agent.message', id: 'sevt_m2', content: [{ type: 'text', text: 'Reply only.' }] }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
        }
      }
      if (event.type === 'user.custom_tool_result' && event.custom_tool_use_id === 'sevt_3') {
        await play(emit, [{ type: 'session.status_running' }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
      }
    }
  };
  const setup = await harness({ script, settings: { allowOriginalEdits: true } });
  const started = await setup.research.startResearch({ itemId: 'art' });
  assert.equal(await started.done, 'done');
  const firstUndo = await setup.research.undoResearch(started.conversationId);
  assert.equal(firstUndo.original, 'restored');
  assert.equal(firstUndo.section, 'removed');
  assert.equal(firstUndo.trashed.length, 1);

  await setup.store.updateItem('art', { articleContent: '# User edited original' });
  const followed = await setup.research.continueResearch(started.conversationId, 'Just answer in chat.');
  assert.equal(await followed.done, 'done');

  const secondUndo = await setup.research.undoResearch(started.conversationId);
  assert.deepEqual(secondUndo, { section: 'none', original: 'none', trashed: [], kept: [] });
  assert.equal((await itemOf(setup.store, 'art')).articleContent, '# User edited original');
});

