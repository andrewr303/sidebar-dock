// The assistant's AI thread tools (lib/ai/tools.js): search_ai_threads, get_ai_threads and the staged import_ai_threads,
// with fake Threadkeeper and saved-chat adapters over a real library store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolSession, undoChanges, buildChanges, toolDefinitions } from '../extension/lib/ai/tools.js';
import { categoryOf, toolAutoApplies, PERMISSION_PRESETS } from '../extension/lib/ai/permissions.js';
import { createSearch } from '../extension/lib/ai/search.js';
import { createLibraryStore, normalizeItem, ITEM_TYPES } from '../extension/lib/store.js';
import { threadIds, sanitizeThreadSummary, sanitizeThreadPayload } from '../extension/lib/ai/thread-context.js';
import { ThreadsUnavailable } from '../extension/lib/ai/threads.js';
import { WRITE_TOOLS, changeIcon, appliedLines, renderSourceRows, changeLabel, changeSub, aiState } from '../extension/ui/ai-panel.js';
import { dispatch } from '../extension/ui/runtime.js';
import { hasIcon } from '../extension/ui/icons.js';

// The real data layer knows the `chat` item type.
assert.ok(ITEM_TYPES.includes('chat'));

const KEY_A = 'chatgpt:acct_chatgpt_primary:ws_personal:abc:main';
const KEY_B = 'claude_code:acct_claude_code_primary:ws_personal:5f0c-ü/x y:main';
const KEY_C = 'gemini:acct_gemini_primary:ws_personal:g1:main';
const KEY_D = 'codex:acct_codex_primary:ws_personal:d1:main';
const ids = key => threadIds(key);

const summary = (threadKey, extra = {}) => ({ threadKey, title: `Thread ${threadKey.split(':')[0]}`, gist: `Gist of ${threadKey.split(':')[0]}`, provider: threadKey.split(':')[0],
  providerLabel: { chatgpt: 'ChatGPT', claude_code: 'Claude Code', gemini: 'Gemini', codex: 'Codex' }[threadKey.split(':')[0]], category: /claude_code|codex/.test(threadKey) ? 'coding_agent' : 'chat',
  kind: 'coding', kindLabel: 'Building', project: 'Billing', workflowState: 'active', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', messageCount: 40,
  url: 'https://example.com/thread', analysisVersion: 2, ...extra });
const transcript = count => ({ included: true, revision: 1, truncated: false, totalMessages: count, from: 0, messages: Array.from({ length: count }, (_, index) => ({
  index, role: index % 5 === 4 ? 'tool' : index % 2 ? 'assistant' : 'user', content: index === 17 ? 'We settled on a ledger table for refunds.' : `Message ${index} ${'text '.repeat(200)}`, createdAt: null })) });
const payload = (threadKey, extra = {}) => sanitizeThreadPayload({ ...summary(threadKey), seq: 1, revision: 1, fingerprint: 'fp', analysis: { source: 'ai', gist: `Gist of ${threadKey.split(':')[0]}`,
  overview: ['An overview paragraph.'], decisions: [{ text: 'Use a ledger', refs: [17] }], topics: ['billing'] }, transcript: transcript(30), ...extra });

const chatItem = (threadKey, extra = {}) => normalizeItem({ id: ids(threadKey).chatId, type: 'chat', title: `Saved ${threadKey.split(':')[0]}`, url: '', sourceUrl: 'https://example.com/thread',
  excerpt: 'Saved gist about billing', content: '', tags: [], collectionId: '', siteName: 'ChatGPT', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z',
  chat: { v: 1, source: 'threadkeeper', threadKey, provider: threadKey.split(':')[0], providerLabel: 'ChatGPT', category: 'chat', project: 'Billing', messageCount: 4, lastActivityAt: '2026-10-20T00:00:00.000Z',
    topics: ['billing'], fingerprint: 'fp', revision: 1, removed: '', origin: 'sync' }, ...extra }, {}, { stored: true });

function memoryStore(seed) {
  let state = null;
  const library = createLibraryStore({ read: async () => state, write: async next => { state = next; } });
  const call = (operation, ...args) => library.dispatch(operation, args);
  return {
    ready: call('loadLibrary', seed),
    // What the worker's upsertChats does for a created chat (sd-link / sd-data), done directly on the stored state.
    addChat(item) { state = { ...state, items: [...state.items, item], updatedAt: new Date(Date.parse(state.updatedAt || 0) + 1000).toISOString() }; },
    removeChats(list) { state = { ...state, items: state.items.filter(item => !list.includes(item.id)) }; },
    loadLibrary: () => call('loadLibrary'),
    saveItem: input => call('saveItem', input),
    updateItem: (id, patch, options = {}) => call('updateItem', id, patch, options),
    bulkUpdateItems: (changes, options = {}) => call('bulkUpdateItems', changes, options),
    createCollection: input => call('createCollection', input),
    deleteItem: (id, options = {}) => call('deleteItem', id, options),
    restoreItem: (id, options = {}) => call('restoreItem', id, options),
    permanentlyDeleteItem: (id, options = {}) => call('permanentlyDeleteItem', id, options),
    updateCollection: (id, patch, options = {}) => call('updateCollection', id, patch, options),
    moveCollection: (id, placement = {}) => call('moveCollection', id, placement),
    deleteCollection: (id, options = {}) => call('deleteCollection', id, options),
  };
}
const seed = () => ({ schemaVersion: 1, collections: [{ id: 'billing', name: 'Billing' }, { id: 'misc', name: 'Misc' }], items: [
  { id: 'note1', type: 'note', title: 'Billing notes', content: 'Refund flow ideas', createdAt: '2026-03-01T00:00:00.000Z' },
  chatItem(KEY_A, { collectionId: 'misc' }),
  chatItem(KEY_C, { deletedAt: '2026-10-25T00:00:00.000Z' }),
  chatItem(KEY_D, { title: 'Private thread', chat: { v: 1, source: 'threadkeeper', threadKey: KEY_D, origin: 'sync', removed: 'local_only' }, content: 'My private notes' }),
] });

function fakeThreads(store, { threads = [KEY_A, KEY_B, KEY_C], fail = false, importFail = false, skip = {} } = {}) {
  const log = [];
  return {
    log, capabilities: ['search', 'context', 'open', 'remote_models'], paused: false,
    prefs: () => ({ search: true, context: 'auto', decision: true }),
    async search(options) {
      log.push(['search', { ...options, signal: undefined }]);
      if (fail) throw new ThreadsUnavailable();
      const all = threads.map((key, n) => sanitizeThreadSummary(summary(key, { score: 0.9 - n * 0.1, match: n < 2 ? 'strong' : 'weak', excerpt: { text: `snippet ${n}`, messageIndex: 17, role: 'assistant' } })));
      const start = options.cursor === 'page2' ? 2 : 0;
      const page = all.slice(start, start + options.limit);
      return { results: page, total: all.length, nextCursor: start + page.length < all.length ? 'page2' : null, semantic: true, reranked: true };
    },
    async list(options) { log.push(['list', { ...options, signal: undefined }]); return { results: [sanitizeThreadSummary(summary(KEY_B))], total: 1, nextCursor: null }; },
    async get(options) {
      log.push(['get', { ...options, signal: undefined }]);
      if (fail) throw new ThreadsUnavailable();
      const keys = [...(options.threadKeys || []), ...threads.filter(key => (options.citeIds || []).includes(ids(key).citeId))];
      const found = keys.filter(key => threads.includes(key)).map(key => payload(key, options.transcript === 'none' ? { transcript: { included: false } } : {}));
      return { threads: found, missing: keys.filter(key => !threads.includes(key)) };
    },
    async context() { return { threads: [] }; },
    async importThreads(keys, options) {
      log.push(['import', keys, options]);
      if (importFail) throw new ThreadsUnavailable('Threadkeeper is not responding, so these threads could not be imported. Try again in a moment.');
      const results = [];
      for (const threadKey of keys) {
        if (skip[threadKey]) { results.push({ threadKey, id: ids(threadKey).chatId, status: 'skipped', reason: skip[threadKey] }); continue; }
        store.addChat(chatItem(threadKey, { title: summary(threadKey).title, collectionId: options.target?.collectionId ?? 'auto', updatedAt: new Date().toISOString() }));
        results.push({ threadKey, id: ids(threadKey).chatId, status: 'created' });
      }
      return { results };
    },
  };
}
function fakeChats(store, records = {}) {
  const undone = [];
  return {
    undone,
    readLocal: async id => records[id] || null,
    summaryMarkdown: (record, item) => `## What this thread is about\n\n${record?.thread?.analysis?.gist || item.excerpt}`,
    localChatFor: () => null, chatForCite: () => null, searchLocal: async (query, { limit }) => [
      { itemId: ids(KEY_A).chatId, threadKey: KEY_A, title: 'Saved chatgpt', gist: 'Saved gist about billing', provider: 'chatgpt', providerLabel: 'ChatGPT', category: 'chat', project: 'Billing',
        updatedAt: '2026-10-20T00:00:00.000Z', messageCount: 4, score: 1, snippet: 'billing', url: '' }].slice(0, limit),
    async undoImport(list) { undone.push(...list); store.removeChats(list); return list.length; },
  };
}

async function session({ threads: threadOptions, chats: chatRecords, withThreads = true, withChats = true, decision = 'apply', permissions, session: extra } = {}) {
  const store = memoryStore(seed());
  await store.ready;
  const getLibrary = () => store.loadLibrary();
  const events = [];
  const proposals = [];
  let counter = 0;
  const threads = withThreads ? fakeThreads(store, threadOptions) : null;
  const chats = withChats ? fakeChats(store, chatRecords) : null;
  const tools = createToolSession({ getLibrary, searchLibrary: createSearch({ getLibrary }).searchLibrary, store, threads, chats, permissions, uid: prefix => `${prefix}_${++counter}`,
    onEvent: event => events.push(event), onProposal: async proposal => { proposals.push(proposal); return typeof decision === 'function' ? decision(proposal) : decision; }, ...extra });
  return { store, tools, events, proposals, threads, chats, getLibrary };
}
const call = (name, input, id = `call_${name}`) => ({ id, name, input });
const parse = result => JSON.parse(result.content);

test('the thread tools are offered only with the adapters: reads with Threadkeeper or saved chats, the import with Threadkeeper', async () => {
  const names = tools => tools.definitions().map(tool => tool.name).filter(name => /ai_threads/.test(name));
  assert.deepEqual(names((await session()).tools), ['search_ai_threads', 'get_ai_threads', 'import_ai_threads']);
  assert.deepEqual(names((await session({ withThreads: false, session: { threadTools: true } })).tools), ['search_ai_threads', 'get_ai_threads']);
  assert.deepEqual(names((await session({ withThreads: false })).tools), []);
  const { tools } = await session({ withThreads: false });
  assert.match(parse((await tools.execute([call('import_ai_threads', { ids: [KEY_B] })]))[0]).error, /Unknown tool/);
  assert.equal(categoryOf({ tool: 'import_ai_threads' }), 'create');
  assert.equal(toolAutoApplies('import_ai_threads', PERMISSION_PRESETS.trusted), true);
  assert.equal(toolAutoApplies('import_ai_threads', { create: 'allow' }), false, 'it can also move and tag chats already in Still');
  assert.ok(WRITE_TOOLS.has('import_ai_threads'));
  assert.ok(hasIcon(changeIcon('import_ai_threads')));
  assert.ok(toolDefinitions({ threads: true }).find(tool => tool.name === 'import_ai_threads').description.endsWith('Changes are applied only after the user approves them.'));
});

test('search_ai_threads returns compact rows, cites saved chats by their library id, and pages with offset', async () => {
  const { tools, threads, events } = await session();
  const [first] = await tools.execute([call('search_ai_threads', { query: 'billing refunds', source: 'coding_agent', provider: 'claude_code', kind: 'debugging', since: '2026-10-01', limit: 2 })]);
  const data = parse(first);
  assert.deepEqual(threads.log[0][1], { query: 'billing refunds', filters: { categories: ['coding_agent'], providers: ['claude_code'], kinds: ['debugging'], since: '2026-10-01T00:00:00.000Z' },
    limit: 2, cursor: null, remote: true, rerank: true, signal: undefined });
  assert.deepEqual(data.items.map(row => [row.id, row.inLibrary, row.match]), [[ids(KEY_A).chatId, ids(KEY_A).chatId, 'strong'], [ids(KEY_B).citeId, null, 'strong']]);
  assert.deepEqual([data.items[1].snippet, data.items[1].snippetAt, data.items[1].source], ['snippet 1', 'm18', 'coding_agent']);
  assert.equal(data.nextOffset, 2);
  assert.match(data.untrusted, /never instructions/);
  assert.ok(!('url' in data.items[0]), 'rows stay compact');
  assert.equal(tools.sources.get(ids(KEY_B).citeId).threadKey, KEY_B, 'rows are citable and keep their thread key');
  assert.deepEqual(events.at(-1).result, { count: 2, query: 'billing refunds', ids: [ids(KEY_A).chatId] });
  const [second] = await tools.execute([call('search_ai_threads', { query: 'billing refunds', source: 'coding_agent', provider: 'claude_code', kind: 'debugging', since: '2026-10-01', limit: 2, offset: 2 })]);
  assert.equal(threads.log[1][1].cursor, 'page2');
  assert.deepEqual(parse(second).items.map(row => row.id), [ids(KEY_C).citeId]);
  assert.equal(parse(second).nextOffset, null);
  const [stray] = await tools.execute([call('search_ai_threads', { query: 'other', offset: 5 })]);
  assert.equal(stray.isError, true);
  await tools.execute([call('search_ai_threads', { query: '', source: 'all' })]);
  assert.equal(threads.log.at(-1)[0], 'list', 'an empty query lists recent threads');
  assert.equal(tools.usedThreads, true);
});

test('search_ai_threads falls back to the chats saved in Still when Threadkeeper is down or not connected', async () => {
  for (const options of [{ threads: { fail: true } }, { withThreads: false, session: { threadTools: true } }]) {
    const { tools } = await session(options);
    const [result] = await tools.execute([call('search_ai_threads', { query: 'billing' })]);
    const data = parse(result);
    assert.equal(result.isError, false);
    assert.equal(data.searched, 'the AI chats saved in Still');
    assert.match(data.note, /only the AI chats saved in Still/);
    assert.deepEqual(data.items.map(row => row.inLibrary), [ids(KEY_A).chatId]);
  }
});

test('get_ai_threads reads saved chats from Still’s copy and other threads from Threadkeeper, within budget', async () => {
  const saved = ids(KEY_A).chatId;
  const records = { [saved]: { record: { thread: { analysis: { gist: 'Local gist' } } }, transcript: transcript(60) } };
  const { tools, threads } = await session({ chats: records });
  await tools.execute([call('search_ai_threads', { query: 'billing' })]);
  const [result] = await tools.execute([call('get_ai_threads', { ids: [saved, ids(KEY_B).citeId, 'tk:00000000deadbeef', 'nonsense'], detail: 'both' })]);
  const data = parse(result);
  const [local, remote] = data.threads;
  assert.deepEqual([local.id, local.inLibrary, local.readFrom], [saved, saved, 'still']);
  assert.match(local.summary, /Local gist/);
  assert.deepEqual([remote.id, remote.inLibrary, remote.readFrom, remote.provider], [ids(KEY_B).citeId, null, 'threadkeeper', 'Claude Code']);
  assert.match(remote.summary, /Gist of claude_code/);
  const get = threads.log.find(entry => entry[0] === 'get')[1];
  assert.deepEqual([get.threadKeys, get.citeIds, get.transcript], [[KEY_B], ['tk:00000000deadbeef'], 'full'], 'the saved chat is not fetched again');
  assert.deepEqual(data.missing.sort(), ['nonsense', 'tk:00000000deadbeef']);
  // The default transcript: the opening messages and the newest, with the gap named; tool output left out.
  assert.equal(local.transcript.total, 60);
  assert.ok(local.transcript.messages.every(message => ['user', 'assistant'].includes(message.role)));
  assert.equal(local.transcript.toolMessagesLeftOut, 12);
  assert.deepEqual(local.transcript.messages.slice(0, 2).map(message => message.m), ['m1', 'm2']);
  assert.equal(local.transcript.messages.at(-1).m, 'm59', 'm60 is tool output');
  assert.match(local.transcript.gap, /^m3 to m\d+ not shown/);
  assert.ok(result.content.length < 70000, `stays within the read budget (${result.content.length})`);
  // query focuses on matching messages; offset reads on from a message number.
  const [focused] = await tools.execute([call('get_ai_threads', { ids: [saved], detail: 'transcript', query: 'ledger refunds' })]);
  assert.deepEqual(parse(focused).threads[0].transcript.messages.map(message => message.m), ['m18']);
  assert.ok(!('summary' in parse(focused).threads[0]));
  const [paged] = await tools.execute([call('get_ai_threads', { ids: [saved], detail: 'transcript', offset: 50, include_tools: true })]);
  assert.deepEqual(parse(paged).threads[0].transcript.messages.map(message => message.m).slice(0, 3), ['m50', 'm51', 'm52']);
  assert.ok(parse(paged).threads[0].transcript.messages.some(message => message.role === 'tool'));
});

test('get_ai_threads reads saved chats offline, and says when Threadkeeper is needed for the rest', async () => {
  const saved = ids(KEY_A).chatId;
  const { tools } = await session({ threads: { fail: true }, chats: { [saved]: { record: { thread: { analysis: { gist: 'Offline gist' } } }, transcript: null } } });
  const data = parse((await tools.execute([call('get_ai_threads', { ids: [saved, KEY_B] })]))[0]);
  assert.deepEqual(data.threads.map(thread => thread.id), [saved]);
  assert.deepEqual(data.missing, [KEY_B]);
  assert.match(data.note, /not responding/);
});

test('chats made private are invisible to every tool; get_items gives a chat’s summary as its article', async () => {
  const saved = ids(KEY_A).chatId;
  const { tools } = await session({ chats: { [saved]: { record: { thread: { agentLabel: 'CEO · Grok Bot', analysis: { gist: 'Stored summary gist' } } }, transcript: transcript(3) } } });
  const [items, list, search, hidden] = await tools.execute([call('get_items', { ids: [saved, ids(KEY_D).chatId] }), call('list_items', { type: 'chat', state: 'all' }),
    call('search_library', { query: 'private' }), call('add_tags', { ids: [ids(KEY_D).chatId], tags: ['x'] })]);
  const [chat] = parse(items).items;
  assert.match(chat.article, /Stored summary gist/);
  assert.deepEqual([chat.chat.threadKey, chat.chat.agent, chat.chat.hasTranscript], [KEY_A, 'CEO · Grok Bot', true]);
  assert.deepEqual(parse(items).missing, [ids(KEY_D).chatId]);
  assert.match(parse(items).chatNote, /article is the chat’s summary/);
  assert.ok(!parse(list).items.some(item => item.id === ids(KEY_D).chatId));
  assert.ok(!parse(search).items.some(item => item.id === ids(KEY_D).chatId));
  assert.equal(hidden.isError, true);
});

test('chats cannot be converted or given a web address', async () => {
  const { tools } = await session();
  const [convert, url] = await tools.execute([call('convert_items', { ids: [ids(KEY_A).chatId], type: 'note' }), call('update_item', { id: ids(KEY_A).chatId, url: 'https://example.com' })]);
  assert.match(parse(convert).error, /Chats cannot be converted/);
  assert.match(parse(url).error, /keeps the link to its original conversation/);
});

test('import_ai_threads proposes one row, imports with origin assistant into the new collection, and undo removes only what it added', async () => {
  const { tools, proposals, threads, chats, getLibrary, events } = await session();
  await tools.execute([call('search_ai_threads', { query: 'billing' })]);
  const results = await tools.execute([
    call('create_collection', { name: 'Refunds' }, 'c1'),
    call('import_ai_threads', { ids: [ids(KEY_A).chatId, ids(KEY_B).citeId, ids(KEY_C).citeId, 'tk:00000000deadbeef'], collectionId: 'new:Refunds', tags: ['refunds'] }, 'i1'),
  ]);
  const proposal = proposals[0];
  assert.deepEqual(proposal.changes.map(change => change.label), ['Create collection Refunds', 'Import 1 chat to Refunds', 'Move 1 item to Refunds', 'Add tag #refunds to 1 item']);
  const row = proposal.changes[1];
  assert.deepEqual(row.items, [{ id: ids(KEY_B).chatId, title: 'Thread claude_code', provider: 'Claude Code' }]);
  assert.deepEqual(Object.keys(row.chats[0]).sort(), ['id', 'provider', 'threadKey', 'title'], 'no summaries or transcripts in the saved row');
  assert.equal(proposal.autoApproved, undefined);
  const [, imported] = threads.log.filter(entry => entry[0] === 'import' || entry[0] === 'get').slice(-2);
  assert.deepEqual(imported.slice(1), [[KEY_B], { target: { collectionId: 'collection_1' }, origin: 'assistant' }]);
  const data = parse(results[1]);
  assert.equal(data.status, 'applied');
  assert.equal(data.imported, 1);
  assert.deepEqual(data.items, [{ id: ids(KEY_B).chatId, title: 'Thread claude_code', cite: `[[${ids(KEY_B).chatId}]]` }]);
  assert.deepEqual(data.alreadyImported, [{ id: ids(KEY_A).chatId, title: 'Saved chatgpt', collection: 'Misc', moved: true }]);
  assert.deepEqual(data.inTrash.map(entry => entry.id), [ids(KEY_C).chatId]);
  assert.deepEqual(data.notFound, ['tk:00000000deadbeef']);
  let library = await getLibrary();
  const created = library.items.find(item => item.id === ids(KEY_B).chatId);
  assert.deepEqual([created.collectionId, created.tags], ['collection_1', ['refunds']]);
  assert.equal(library.items.find(item => item.id === ids(KEY_A).chatId).collectionId, 'collection_1');
  assert.equal(tools.sources.get(ids(KEY_B).chatId).type, 'chat', 'the new chat is citable at once');
  assert.match(events.find(event => event.type === 'tool' && event.name === 'import_ai_threads').summary, /^Imported 1 chat to Refunds/);
  // Undo: the worker op removes the imported chat without dismissing it; the move is reverted; the empty collection goes.
  await events.find(event => event.type === 'proposal_result').undo();
  library = await getLibrary();
  assert.deepEqual(chats.undone, [ids(KEY_B).chatId]);
  assert.ok(!library.items.some(item => item.id === ids(KEY_B).chatId));
  assert.equal(library.items.find(item => item.id === ids(KEY_A).chatId).collectionId, 'misc');
  assert.ok(!library.collections.some(collection => collection.name === 'Refunds'));
});

test('a chat left out in Review is not imported; leaving the collection out uses Still’s usual placement', async () => {
  const { tools, proposals, threads } = await session({ threads: { threads: [KEY_A, KEY_B, KEY_C, KEY_D, 'gemini:acct:ws:other:main'] }, decision: proposal => ({ decision: 'apply', exclude: [ids('gemini:acct:ws:other:main').chatId] }) });
  await tools.execute([call('search_ai_threads', { query: 'x', limit: 5 })]);
  const [result] = await tools.execute([call('import_ai_threads', { ids: [ids(KEY_B).citeId, ids('gemini:acct:ws:other:main').citeId] })]);
  const row = proposals[0].changes[0];
  assert.equal(row.label, 'Import 2 chats into Still');
  assert.equal(row.collectionName, '');
  const imported = threads.log.find(entry => entry[0] === 'import');
  assert.deepEqual(imported.slice(1), [[KEY_B], { target: null, origin: 'assistant' }]);
  assert.equal(parse(result).leftOutByUser, 1);
  assert.deepEqual(appliedLines(proposals[0], [ids('gemini:acct:ws:other:main').chatId]), ['Imported 1 chat into Still']);
});

test('chats Still refuses (deleted by the user) are reported, not counted as imported', async () => {
  const { tools } = await session({ threads: { skip: { [KEY_B]: 'dismissed' } } });
  await tools.execute([call('search_ai_threads', { query: 'x' })]);
  const data = parse((await tools.execute([call('import_ai_threads', { ids: [ids(KEY_B).citeId], collectionId: '' })]))[0]);
  assert.equal(data.imported, 0);
  assert.deepEqual(data.notImported, [{ id: ids(KEY_B).chatId, title: 'Thread claude_code', reason: 'dismissed' }]);
  assert.match(data.notImportedHint, /deleted that chat/);
});

test('an import that fails leaves nothing behind; ids from earlier turns resolve through Threadkeeper', async () => {
  const { tools, getLibrary, threads } = await session({ threads: { importFail: true } });
  const before = await getLibrary();
  const results = await tools.execute([call('create_collection', { name: 'Refunds' }, 'c1'), call('import_ai_threads', { ids: [ids(KEY_B).citeId], collectionId: 'new:Refunds' }, 'i1')]);
  assert.deepEqual(threads.log.find(entry => entry[0] === 'get')[1].citeIds, [ids(KEY_B).citeId], 'an unknown cite id is looked up');
  assert.equal(parse(results[1]).status, 'failed');
  assert.match(parse(results[1]).message, /not responding/);
  const after = await getLibrary();
  assert.deepEqual(after.collections.map(collection => collection.id), before.collections.map(collection => collection.id));
  // Ids cited in earlier turns (knownThreads) resolve without asking Threadkeeper.
  const second = await session({ session: { knownThreads: [{ id: ids(KEY_B).citeId, title: 'Earlier', threadKey: KEY_B }] } });
  await second.tools.execute([call('import_ai_threads', { ids: [ids(KEY_B).citeId] })]);
  assert.ok(!second.threads.log.some(entry => entry[0] === 'get'));
  assert.deepEqual(second.proposals[0].changes[0].items[0].title, 'Earlier');
});

test('thread tools and thread context keep proposals under review, even under Full access', async () => {
  const { tools, proposals, events } = await session({ permissions: PERMISSION_PRESETS.full });
  await tools.execute([call('create_note', { title: 'Plain', markdown: 'Fine' })]);
  assert.equal(events.find(event => event.type === 'proposal').proposal.autoApproved, true, 'without thread text, allowed changes still apply at once');
  await tools.execute([call('search_ai_threads', { query: 'x' })]);
  await tools.execute([call('create_note', { title: 'From threads', markdown: 'Text' })]);
  assert.equal(proposals.length, 1, 'the second proposal waited for the user');
  const context = await session({ permissions: PERMISSION_PRESETS.full, session: { threadContext: true } });
  await context.tools.execute([call('create_note', { title: 'X', markdown: 'Y' })]);
  assert.equal(context.proposals.length, 1);
});

test('undo of an import after a reload works from the saved record, and falls back to deleting when the worker op is missing', async () => {
  const store = memoryStore(seed());
  await store.ready;
  store.addChat(chatItem(KEY_B, { updatedAt: '2026-11-01T00:00:00.000Z' }));
  const stamp = (await store.loadLibrary()).items.find(item => item.id === ids(KEY_B).chatId).updatedAt;
  await undoChanges(store, JSON.parse(JSON.stringify({ importedChats: [{ id: ids(KEY_B).chatId, updatedAt: stamp }] })), { chats: null });
  assert.ok(!(await store.loadLibrary()).items.some(item => item.id === ids(KEY_B).chatId), 'deleted for good while untouched');
  // A chat the user changed since goes to Trash instead.
  store.addChat(chatItem(KEY_B));
  const removed = [];
  await undoChanges(store, { importedChats: [{ id: ids(KEY_B).chatId, updatedAt: '2000-01-01T00:00:00.000Z' }] }, { chats: { undoImport: async list => { removed.push(...list); return list.length; } } });
  assert.deepEqual(removed, []);
  assert.ok((await store.loadLibrary()).items.find(item => item.id === ids(KEY_B).chatId).deletedAt);
  // A failing worker op is reported and does not fall back to a deletion that would dismiss the chat.
  store.addChat(chatItem(KEY_A.replace('abc', 'zzz')));
  await assert.rejects(undoChanges(store, { importedChats: [ids(KEY_A.replace('abc', 'zzz')).chatId] }, { chats: { undoImport: async () => { throw new Error('worker down'); } } }), /worker down/);
  assert.ok((await store.loadLibrary()).items.some(item => item.id === ids(KEY_A.replace('abc', 'zzz')).chatId));
});

test('buildChanges merges import calls into one row per collection', () => {
  const draft = { collections: [], ops: [
    { callId: 'a', tool: 'import_ai_threads', op: { op: 'import_ai_threads', itemIds: ['chat_tk_1'], collectionId: 'billing', chats: [{ id: 'chat_tk_1', threadKey: 'k:1', title: 'One', provider: 'ChatGPT' }] } },
    { callId: 'b', tool: 'import_ai_threads', op: { op: 'import_ai_threads', itemIds: ['chat_tk_2'], collectionId: 'billing', chats: [{ id: 'chat_tk_2', threadKey: 'k:2', title: 'Two', provider: '' }] } },
  ] };
  const [row] = buildChanges(draft, { collections: [{ id: 'billing', name: 'Billing' }], items: [] });
  assert.deepEqual([row.label, row.itemIds, row.tools], ['Import 2 chats to Billing', ['chat_tk_1', 'chat_tk_2'], ['import_ai_threads']]);
});

// ------------------------------------------------------------------------------------------------ the panel

const flat = fragment => String(fragment).replace(/\s+/g, ' ');
function panelCtx({ items = [], ai = {} } = {}) {
  const calls = { opened: [], menus: [], toasts: [] };
  const byId = new Map(items.map(item => [item.id, item]));
  const ctx = {
    state: { view: 'assistant', panel: null, selection: new Set(), popover: null, dialogs: [], shell: { docked: true }, assistant: { layout: 'wide', sheet: null, query: '' } },
    env: { isSidepanel: false, isNewtab: false, isExtension: true },
    prefs: { get: (key, fallback) => fallback, set() {} },
    library: { items, collections: [{ id: 'billing', name: 'Billing' }], settings: {} },
    select: { byId: id => byId.get(id) || null, collection: id => id === 'billing' ? { id, name: 'Billing' } : null, live: () => items },
    ai, openItem: id => calls.opened.push(id), openMenu: (el, entries) => calls.menus.push(entries), toast: (message, options) => calls.toasts.push([message, options]),
    render() {}, renderNow() {}, dispatch() {},
  };
  aiState(ctx).conversation = { id: 'c', messages: [{ id: 'm1', role: 'assistant', text: 'x', citations: [{ n: 1, id: ids(KEY_B).citeId, title: 'Refactor', url: '', kind: 'ai_thread', threadKey: KEY_B }] }] };
  return { ctx, calls };
}

test('the panel lists cited AI threads as sources and words import rows', () => {
  const saved = chatItem(KEY_A);
  const { ctx } = panelCtx({ items: [saved] });
  const rows = flat(renderSourceRows(ctx, [{ n: 1, id: saved.id, title: 'Saved', url: '' }, { n: 2, id: ids(KEY_B).citeId, title: 'Refactor session', url: '', kind: 'ai_thread', threadKey: KEY_B },
    { n: 3, id: 'tk:0000000000000000', title: 'No key' }]));
  assert.match(rows, new RegExp(`data-id="${saved.id}"`));
  assert.match(rows, /data-id="tk:ec30122ef1e1608e" data-thread="claude_code:acct_claude_code_primary:ws_personal:5f0c-ü\/x y:main">/);
  assert.match(rows, /Refactor session<\/span><span class="ai-source-meta">AI thread/);
  assert.doesNotMatch(rows, /No key/, 'a thread citation without its key cannot be opened, so it is not listed');
  const change = { op: 'import_ai_threads', itemIds: ['chat_tk_1', 'chat_tk_2'], count: 2, collectionId: 'billing', collectionName: 'Billing', tags: ['refunds'],
    items: [{ id: 'chat_tk_1', title: 'One', provider: 'ChatGPT' }, { id: 'chat_tk_2', title: 'Two', provider: 'Claude Code' }] };
  assert.match(flat(changeLabel(ctx, change, 1)), /Import 1 chat to/);
  assert.equal(String(changeLabel(ctx, { ...change, collectionId: undefined }, 2)), 'Import 2 chats into Still');
  assert.match(String(changeSub(ctx, change, new Set(['chat_tk_1']))), /Two · Claude Code/);
});

test('clicking a cited thread opens the saved chat, or offers Import and Open in Threadkeeper', async () => {
  const resolved = [];
  const imported = [];
  const { ctx, calls } = panelCtx({ ai: {
    resolveThreadCitation: async target => { resolved.push(target); return target.id === 'tk:aaaaaaaaaaaaaaaa' ? { itemId: 'chat_tk_saved' } : { threadKey: KEY_B, canImport: true, canOpen: true }; },
    importThreadCitation: async target => { imported.push(target); return { itemId: ids(KEY_B).chatId }; },
    openThreadInThreadkeeper: async () => {},
  } });
  const el = { dataset: {} };
  await dispatch('ai.cite', { ctx, el, data: { id: 'tk:aaaaaaaaaaaaaaaa' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.opened, ['chat_tk_saved']);
  // A numbered citation carries only its id: the thread key comes from the saved citation.
  await dispatch('ai.cite', { ctx, el, data: { id: ids(KEY_B).citeId } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(resolved.at(-1), { id: ids(KEY_B).citeId, threadKey: KEY_B });
  const menu = calls.menus.at(-1);
  assert.deepEqual(menu.map(entry => entry.label), ['Import to Still', 'Open in Threadkeeper']);
  await menu[0].run();
  assert.deepEqual(imported, [{ id: ids(KEY_B).citeId, threadKey: KEY_B }]);
  assert.equal(calls.toasts.at(-1)[0], 'Chat imported');
});

test('get_ai_threads asks Threadkeeper for the window a truncated saved transcript lacks, and names gaps it cannot fill', async () => {
  const saved = ids(KEY_A).chatId;
  // Still kept the first 5 and the newest 5 of 30 messages (chat-data.js keeps gaps when over budget).
  const full = transcript(30);
  const stored = { ...full, truncated: true, messages: full.messages.filter(message => message.index < 5 || message.index >= 25) };
  const records = { [saved]: { record: { thread: payload(KEY_A) }, transcript: stored } };
  const { tools, threads } = await session({ chats: records });
  const [paged] = await tools.execute([call('get_ai_threads', { ids: [saved], detail: 'transcript', offset: 11 })]);
  const get = threads.log.find(entry => entry[0] === 'get');
  assert.ok(get, 'Threadkeeper was asked');
  assert.deepEqual([get[1].transcript, get[1].window], ['window', { from: 10, count: 500 }]);
  const read = parse(paged).threads[0];
  assert.deepEqual(read.transcript.messages.slice(0, 2).map(message => message.m), ['m11', 'm12'], 'the asked-for messages, not the stored tail');
  assert.equal(read.readFrom, 'still and threadkeeper');
  assert.equal(read.transcript.missing, undefined);
  // Threadkeeper down: the stored tail is shown, with the skipped range named.
  const offline = await session({ chats: records, threads: { fail: true } });
  const [alone] = await offline.tools.execute([call('get_ai_threads', { ids: [saved], detail: 'transcript', offset: 11 })]);
  const fallback = parse(alone).threads[0].transcript;
  assert.equal(fallback.messages[0].m, 'm26');
  assert.deepEqual(fallback.missing, ['m11 to m25 are not available']);
  // A complete stored copy is read from Still alone.
  const whole = await session({ chats: { [saved]: { record: { thread: payload(KEY_A) }, transcript: full } } });
  await whole.tools.execute([call('get_ai_threads', { ids: [saved], detail: 'transcript', offset: 11 })]);
  assert.equal(whole.threads.log.some(entry => entry[0] === 'get'), false);
});
