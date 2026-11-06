import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLibraryStore, normalizeItem, normalizeChat, chatTextHash, isChatTouched, ITEM_TYPES, CHAT_SYSTEM_DELETES, CHAT_LIMITS,
} from '../extension/lib/store.js';
import { chatItemId } from '../extension/lib/threadkeeper/protocol.js';

function fixture(seed = null) {
  let value = seed && structuredClone(seed);
  let writes = 0;
  const commits = [];
  const store = createLibraryStore({ read: async () => value ? structuredClone(value) : null,
    write: async state => { writes++; value = structuredClone(state); }, onCommit: change => { commits.push(change); } });
  return { call: (name, ...args) => store.dispatch(name, args), writes: () => writes, library: () => value, commits };
}

const KEY = 'chatgpt:acct_chatgpt_primary:ws_personal:abc:main';
const KEY2 = 'claude_code:acct_claude_code_primary:ws_personal:5f0c-ü/x y:main';
const entry = (threadKey = KEY, overrides = {}) => ({
  threadKey, fingerprint: 'fp1', seq: 10, origin: 'sync',
  item: { title: 'Planning the trip', excerpt: 'Booked flights to Lisbon.', sourceUrl: 'https://chatgpt.com/c/abc', siteName: 'ChatGPT', createdAt: '2026-10-01T10:00:00.000Z' },
  chat: { provider: 'chatgpt', providerLabel: 'ChatGPT', category: 'chat', kind: 'planning', project: 'Travel', model: 'gpt-5',
    workflowState: 'done', messageCount: 12, lastActivityAt: '2026-10-02T10:00:00.000Z', topics: ['lisbon', 'flights'],
    analysis: { source: 'ai', generatedAt: '2026-10-02T11:00:00.000Z' }, analysisVersion: 2, revision: 4, hasTranscript: true },
  ...overrides,
});

test('chat is an item type with a compact, capped chat object', () => {
  assert.ok(ITEM_TYPES.includes('chat'));
  const chat = normalizeChat({ threadKey: ` ${KEY} `, provider: 'ChatGPT!', category: 'nope', topics: ['a', 'A', ' b ', 'x'.repeat(80), 1, 'c', 'd', 'e', 'f', 'g', 'h'],
    messageCount: -3, revision: 2.5, seq: '7', workflowState: 'weird', origin: 'elsewhere', removed: 'gone', syncedTitleHash: 'XYZ',
    analysis: { source: 'remote', generatedAt: 'not a date', extra: 1 }, lastActivityAt: '2026-10-02', unknownKey: 'dropped' });
  assert.equal(chat.threadKey, KEY);
  assert.equal(chat.provider, '');
  assert.equal(chat.category, 'chat');
  assert.deepEqual(chat.topics, ['a', 'b', 'x'.repeat(40), 'c', 'd', 'e', 'f', 'g']);
  assert.equal(chat.messageCount, 0);
  assert.equal(chat.revision, 0);
  assert.equal(chat.seq, 7);
  assert.equal(chat.workflowState, '');
  assert.equal(chat.origin, 'sync');
  assert.equal(chat.removed, '');
  assert.equal(chat.syncedTitleHash, '');
  assert.deepEqual(chat.analysis, { source: '', generatedAt: '' });
  assert.equal(chat.lastActivityAt, '2026-10-02T00:00:00.000Z');
  assert.equal(chat.unknownKey, undefined, 'unknown keys only survive from stored data');
  assert.equal(normalizeChat({ threadKey: KEY }, 'note'), null);
  assert.equal(normalizeChat({ threadKey: 'k'.repeat(601) }).threadKey, '');
  // Keys from a newer build survive on a stored chat.
  assert.equal(normalizeChat({ threadKey: KEY }, 'chat', { future: 1 }).future, 1);
  assert.match(chatTextHash('Planning'), /^[0-9a-f]{8}$/);
  assert.notEqual(chatTextHash('Planning'), chatTextHash('planning'));
});

test('normalizeItem guards chats: thread required, id from the thread, no URL, no conversion', () => {
  const id = chatItemId(KEY);
  assert.throws(() => normalizeItem({ id, type: 'chat', title: 'x' }), /A chat needs its Threadkeeper thread/);
  assert.throws(() => normalizeItem({ id: 'item_1', type: 'chat', chat: { threadKey: KEY } }), /A chat needs its Threadkeeper thread/);
  const item = normalizeItem({ id, type: 'chat', url: 'https://chatgpt.com/c/abc', chat: { threadKey: KEY } }, {}, { stored: true });
  assert.equal(item.url, '', 'a chat never has a url: saveItem dedupes non-notes by url');
  assert.equal(item.title, 'Untitled chat');
  assert.equal(item.parentId, '');
  assert.throws(() => normalizeItem({ type: 'note' }, item), /Chats cannot be converted/);
  const note = normalizeItem({ id: 'n1', type: 'note', title: 'N' });
  assert.throws(() => normalizeItem({ type: 'chat', chat: { threadKey: KEY } }, note), /Chats cannot be converted/);
  assert.equal(normalizeItem({ title: 'n', chat: { threadKey: KEY } }, note).chat, undefined, 'other types never carry a chat');
  // A plain edit cannot rewrite the chat object (only stored data and the chat operations can).
  const renamed = normalizeItem({ title: 'Mine', chat: { threadKey: KEY2, project: 'Forged' } }, item);
  assert.equal(renamed.chat.threadKey, KEY);
  assert.equal(renamed.chat.project, '');
  assert.equal(renamed.title, 'Mine');
});

test('saveItem refuses chats; updateItem keeps the chat object', async () => {
  const { call } = fixture();
  await assert.rejects(call('saveItem', { type: 'chat', chat: { threadKey: KEY } }), /Chats come from Threadkeeper/);
  const { results } = await call('upsertChats', [entry()]);
  const id = results[0].id;
  const updated = await call('updateItem', id, { title: 'My trip', content: 'my notes', chat: { project: 'Forged' } });
  assert.equal(updated.title, 'My trip');
  assert.equal(updated.chat.project, 'Travel');
  await assert.rejects(call('updateItem', id, { type: 'note' }), /Chats cannot be converted/);
});

test('upsertChats creates chats in one write with sync bookkeeping, and leaves an unchanged batch unwritten', async () => {
  const { call, writes, library, commits } = fixture();
  const out = await call('upsertChats', [entry(), entry(KEY2, { item: { title: 'Refactor store' }, chat: { provider: 'claude_code', providerLabel: 'Claude Code', category: 'coding_agent', revision: 1 } })]);
  assert.equal(writes(), 1);
  assert.deepEqual(out.results.map(r => [r.threadKey, r.id, r.status, r.fingerprint, r.seq]), [[KEY, chatItemId(KEY), 'created', 'fp1', 10], [KEY2, chatItemId(KEY2), 'created', 'fp1', 10]]);
  const chat = library().items.find(item => item.id === chatItemId(KEY));
  assert.equal(chat.type, 'chat');
  assert.equal(chat.url, '');
  assert.equal(chat.sourceUrl, 'https://chatgpt.com/c/abc');
  assert.equal(chat.siteName, 'ChatGPT');
  assert.equal(chat.content, '');
  assert.equal(chat.createdAt, '2026-10-01T10:00:00.000Z', 'createdAt is the thread\'s');
  assert.equal(chat.collectionId, '');
  assert.equal(chat.chat.origin, 'sync');
  assert.equal(chat.chat.syncedTitleHash, chatTextHash('Planning the trip'));
  assert.equal(chat.chat.syncedExcerptHash, chatTextHash('Booked flights to Lisbon.'));
  assert.equal(chat.chat.autoCollectionId, '');
  assert.ok(chat.chat.syncedAt);
  assert.equal(chat.chat.category, 'chat');
  assert.equal(library().items.find(item => item.id === chatItemId(KEY2)).chat.category, 'coding_agent');
  assert.ok(JSON.stringify(chat).length < 1600, `a chat item stays compact (${JSON.stringify(chat).length} bytes)`);
  assert.deepEqual(commits.at(-1).changed.items.sort(), [chatItemId(KEY), chatItemId(KEY2)].sort());
  assert.equal(commits.at(-1).operation, 'upsertChats');

  const again = await call('upsertChats', [entry(), entry(KEY2, { item: { title: 'Refactor store' }, chat: { provider: 'claude_code', providerLabel: 'Claude Code', category: 'coding_agent', revision: 1 } })]);
  assert.deepEqual(again.results.map(r => r.status), ['unchanged', 'unchanged']);
  assert.equal(writes(), 1, 'nothing changed, nothing written');
  // A newer seq with the same content is still unchanged: an epoch reset must not rewrite every chat.
  assert.equal((await call('upsertChats', [entry(KEY, { seq: 11 })])).results[0].status, 'unchanged');
  assert.equal(writes(), 1);
  assert.deepEqual(await call('upsertChats', []), { results: [], collections: [] });
  assert.equal(writes(), 1);
});

test('upsertChats refreshes sync-owned fields only while the user has not changed them', async () => {
  const { call, library, writes } = fixture();
  const reading = await call('createCollection', { name: 'Reading' });
  const { results: [first] } = await call('upsertChats', [entry(KEY, { placement: { collectionId: reading.id } })]);
  const id = first.id;
  assert.equal(library().items.find(i => i.id === id).collectionId, reading.id);
  const before = library().items.find(i => i.id === id);
  // Newer thread: everything sync owns follows.
  const next = entry(KEY, { fingerprint: 'fp2', seq: 12, item: { title: 'Lisbon trip', excerpt: 'Booked flights and a hotel.', sourceUrl: 'https://chatgpt.com/c/abc' }, chat: { ...entry().chat, project: 'Holidays', messageCount: 20 } });
  const out = await call('upsertChats', [next]);
  assert.equal(out.results[0].status, 'updated');
  let item = library().items.find(i => i.id === id);
  assert.equal(item.title, 'Lisbon trip');
  assert.equal(item.excerpt, 'Booked flights and a hotel.');
  assert.equal(item.chat.project, 'Holidays');
  assert.equal(item.chat.messageCount, 20);
  assert.equal(item.chat.fingerprint, 'fp2');
  assert.equal(item.createdAt, before.createdAt);
  assert.ok(item.updatedAt > before.updatedAt, 'updatedAt moves so caches refresh');

  // The user renames, edits the excerpt, moves it, writes notes, adds a tag and stars it.
  const other = await call('createCollection', { name: 'Mine' });
  await call('updateItem', id, { title: 'My Lisbon chat', excerpt: 'My summary', collectionId: other.id, content: 'Pack light', tags: ['personal'], favorite: true });
  await call('upsertChats', [entry(KEY, { fingerprint: 'fp3', seq: 13, item: { title: 'Lisbon trip v3', excerpt: 'New gist' }, placement: { collectionId: reading.id }, tags: ['sync-tag'] })]);
  item = library().items.find(i => i.id === id);
  assert.equal(item.title, 'My Lisbon chat');
  assert.equal(item.excerpt, 'My summary');
  assert.equal(item.collectionId, other.id, 'a chat the user moved stays put');
  assert.equal(item.content, 'Pack light');
  assert.deepEqual(item.tags, ['personal']);
  assert.equal(item.favorite, true);
  assert.equal(item.chat.fingerprint, 'fp3');
  // A forced placement (an explicit manual target) moves it anyway.
  await call('upsertChats', [entry(KEY, { fingerprint: 'fp4', seq: 14, origin: 'manual', placement: { collectionId: reading.id, force: true } })]);
  item = library().items.find(i => i.id === id);
  assert.equal(item.collectionId, reading.id);
  assert.equal(item.chat.autoCollectionId, reading.id);
  assert.equal(item.chat.origin, 'sync', 'origin records how the chat was first created');
  // A collection that no longer exists falls back to the Inbox for a new chat.
  const w = writes();
  const gone = await call('upsertChats', [entry(KEY2, { placement: { collectionId: 'collection_gone' } })]);
  assert.equal(writes(), w + 1);
  assert.equal(library().items.find(i => i.id === gone.results[0].id).collectionId, '');
});

test('upsertChats skips stale, invalid, dismissed and trashed entries', async () => {
  const { call, library, writes } = fixture();
  await call('upsertChats', [entry(KEY, { seq: 20 })]);
  const id = chatItemId(KEY);
  const stale = await call('upsertChats', [entry(KEY, { seq: 19, fingerprint: 'old' })]);
  assert.deepEqual(stale.results[0], { threadKey: KEY, id, status: 'skipped', reason: 'stale', fingerprint: 'fp1', seq: 20 });
  // Wrong id, no chat object, a duplicate, an id that is not a chat of this thread.
  await call('loadLibrary');
  const note = await call('saveItem', { type: 'note', title: 'N' });
  const bad = await call('upsertChats', [
    { ...entry(KEY2), id: note.id }, { threadKey: KEY2 }, entry(''), entry(KEY2), entry(KEY2),
  ]);
  assert.deepEqual(bad.results.map(r => [r.status, r.reason]), [['skipped', 'invalid'], ['skipped', 'invalid'], ['skipped', 'invalid'], ['created', undefined], ['skipped', 'invalid']]);
  // Dismissed (deleted forever by the user): skipped unless revived.
  const KEY3 = 'gemini:acct:ws:x:main';
  const before = writes();
  const dismissed = await call('upsertChats', [entry(KEY3)], { dismissedIds: [chatItemId(KEY3)] });
  assert.deepEqual(dismissed.results.map(r => [r.status, r.reason]), [['skipped', 'dismissed']]);
  assert.equal(writes(), before);
  const revived = await call('upsertChats', [entry(KEY3, { revive: true, origin: 'manual' })], { dismissedIds: [chatItemId(KEY3)] });
  assert.equal(revived.results[0].status, 'created');
  assert.equal(library().items.find(i => i.id === chatItemId(KEY3)).chat.origin, 'manual');
  // Trash: only the chat metadata follows; removed is kept; revive restores it with its trashed subpages.
  const sub = await call('saveItem', { type: 'note', title: 'My notes', parentId: id });
  await call('deleteItem', id);
  await call('markChatsRemoved', [{ id, reason: 'deleted' }]);
  const trashed = await call('upsertChats', [entry(KEY, { seq: 21, fingerprint: 'fp5', item: { title: 'Changed' } })]);
  assert.deepEqual([trashed.results[0].status, trashed.results[0].reason], ['skipped', 'trashed']);
  let item = library().items.find(i => i.id === id);
  assert.ok(item.deletedAt);
  assert.equal(item.chat.fingerprint, 'fp5');
  assert.equal(item.chat.removed, 'deleted');
  assert.equal(item.title, 'Planning the trip');
  const same = writes();
  assert.equal((await call('upsertChats', [entry(KEY, { seq: 21, fingerprint: 'fp5', item: { title: 'Changed' } })])).results[0].reason, 'trashed');
  assert.equal(writes(), same, 'an unchanged trashed chat is not rewritten');
  const travel = await call('createCollection', { name: 'Travel' });
  const restored = await call('upsertChats', [entry(KEY, { seq: 22, fingerprint: 'fp6', origin: 'manual', revive: true, item: { title: 'Changed' }, placement: { collectionId: travel.id } })]);
  assert.equal(restored.results[0].status, 'updated');
  item = library().items.find(i => i.id === id);
  assert.equal(item.deletedAt, null);
  assert.equal(item.chat.removed, '');
  assert.equal(item.title, 'Changed');
  assert.equal(item.collectionId, travel.id);
  const page = library().items.find(i => i.id === sub.id);
  assert.equal(page.deletedAt, null, 'the subpage trashed with the chat comes back');
  assert.equal(page.collectionId, travel.id, 'and follows it into the collection');
});

test('upsertChats ensures collections by name under their parent, only when an entry needs one', async () => {
  const { call, library, writes } = fixture();
  const existing = await call('createCollection', { name: 'Travel' });
  const ensureCollections = [{ key: '__parent', name: 'AI chats', icon: 'messages-square' }, { key: 'p:travel', name: 'travel', parentKey: '__parent' },
    { key: 'p:top', name: ' TRAVEL ' }, { key: 'p:unused', name: 'Never used' }];
  const out = await call('upsertChats', [
    entry(KEY, { placement: { collectionKey: 'p:travel' } }), entry(KEY2, { placement: { collectionKey: 'p:top' } }),
  ], { ensureCollections });
  const parent = library().collections.find(c => c.name === 'AI chats');
  const child = library().collections.find(c => c.name === 'travel');
  assert.equal(parent.parentId, '');
  assert.equal(parent.icon, 'messages-square');
  assert.equal(child.parentId, parent.id);
  assert.deepEqual(out.collections, [{ key: '__parent', id: parent.id, created: true }, { key: 'p:travel', id: child.id, created: true }, { key: 'p:top', id: existing.id, created: false }]);
  assert.equal(library().items.find(i => i.id === chatItemId(KEY)).collectionId, child.id);
  assert.equal(library().items.find(i => i.id === chatItemId(KEY2)).chat.autoCollectionId, existing.id);
  assert.ok(!library().collections.some(c => c.name === 'Never used'));
  // Same specs again: matched by name, nothing created, nothing written.
  const w = writes();
  const again = await call('upsertChats', [entry(KEY, { placement: { collectionKey: 'p:travel' } })], { ensureCollections });
  assert.equal(writes(), w);
  assert.equal(again.results[0].status, 'unchanged');
  assert.equal(library().collections.length, 3);
  // A collection in Trash is not reused.
  await call('updateCollection', child.id, { deletedAt: '2026-10-05T00:00:00.000Z' });
  await call('upsertChats', [entry('k:new:1:2:3', { placement: { collectionKey: 'p:travel' } })], { ensureCollections });
  assert.equal(library().collections.filter(c => c.name === 'travel' && !c.deletedAt).length, 1);
});

test('upsertChats refuses oversized batches and non-arrays', async () => {
  const { call } = fixture();
  await assert.rejects(call('upsertChats', Array.from({ length: CHAT_LIMITS.batch + 1 }, (_, i) => entry(`k:${i}`))), /at most 100/);
  await assert.rejects(call('upsertChats', 'nope'), /list of chats/);
});

test('a chat deleted forever can come back through upsertChats (the worker decides dismissal)', async () => {
  const { call, library } = fixture();
  await call('upsertChats', [entry()]);
  const id = chatItemId(KEY);
  await call('permanentlyDeleteItem', id);
  assert.ok(library().tombstones.some(t => t.id === id));
  assert.equal((await call('upsertChats', [entry()])).results[0].status, 'created');
  assert.ok(!library().tombstones.some(t => t.id === id), 'recreating a chat lifts its tombstone');
});

test('isChatTouched sees notes, subpages, user tags, favorite, rename and move', async () => {
  const { call, library } = fixture();
  await call('upsertChats', [entry(KEY, { tags: ['lisbon'] })]);
  const id = chatItemId(KEY);
  const fresh = () => library().items.find(i => i.id === id);
  assert.equal(isChatTouched(fresh(), library().items), false);
  assert.equal(isChatTouched({ type: 'note' }), false);
  for (const patch of [{ content: 'x' }, { favorite: true }, { tags: ['lisbon', 'mine'] }, { title: 'Renamed' }]) {
    assert.equal(isChatTouched({ ...fresh(), ...patch }, library().items), true, JSON.stringify(patch));
  }
  assert.equal(isChatTouched({ ...fresh(), tags: [] }, library().items), false, 'removing a synced tag is not a touch');
  const c = await call('createCollection', { name: 'Mine' });
  assert.equal(isChatTouched({ ...fresh(), collectionId: c.id }, library().items), true);
  const sub = await call('saveItem', { type: 'note', title: 'Sub', parentId: id });
  assert.equal(isChatTouched(fresh(), library().items), true);
  await call('deleteItem', sub.id);
  assert.equal(isChatTouched(fresh(), library().items), false, 'only live subpages count');
});

test('markChatsRemoved: local_only deletes untouched chats and strips touched ones', async () => {
  const { call, library, commits } = fixture();
  await call('upsertChats', [entry(KEY, { tags: ['lisbon'] }), entry(KEY2)]);
  const a = chatItemId(KEY), b = chatItemId(KEY2);
  await call('updateItem', b, { content: 'My notes', tags: ['mine'] });
  const sub = await call('saveItem', { type: 'note', title: 'Sub', parentId: b });
  const out = await call('markChatsRemoved', [{ id: a, reason: 'local_only' }, { id: b, reason: 'local_only' }, { id: 'chat_tk_missing', reason: 'local_only' }, { id: b, reason: 'nope' }]);
  assert.deepEqual(out.results, [{ id: a, status: 'removed' }, { id: b, status: 'removed' }, { id: 'chat_tk_missing', status: 'missing' }, { id: b, status: 'missing' }]);
  assert.ok(!library().items.some(i => i.id === a), 'untouched → deleted forever');
  assert.ok(library().tombstones.some(t => t.id === a), 'a backup import cannot bring the private thread back');
  assert.ok(CHAT_SYSTEM_DELETES.includes(commits.at(-1).operation), 'the worker does not dismiss it');
  assert.deepEqual(commits.at(-1).deleted.items, [a]);
  const kept = library().items.find(i => i.id === b);
  assert.equal(kept.title, 'Private thread');
  assert.equal(kept.excerpt, '');
  assert.equal(kept.sourceUrl, '');
  assert.equal(kept.siteName, '');
  assert.equal(kept.content, 'My notes');
  assert.deepEqual(kept.tags, ['mine']);
  assert.deepEqual(Object.keys(kept.chat).filter(key => kept.chat[key] && !(Array.isArray(kept.chat[key]) && !kept.chat[key].length) && !(typeof kept.chat[key] === 'object' && !Array.isArray(kept.chat[key]))).sort(),
    ['category', 'origin', 'removed', 'source', 'syncedTitleHash', 'threadKey', 'v']);
  assert.equal(kept.chat.category, 'chat', 'the neutral default');
  assert.equal(kept.chat.removed, 'local_only');
  assert.equal(kept.chat.project, '');
  assert.deepEqual(kept.chat.topics, []);
  assert.equal(library().items.find(i => i.id === sub.id).parentId, b, 'subpages stay inside');
  // A rename survives the strip.
  await call('upsertChats', [entry('k:r:1:2:3')]);
  const r = chatItemId('k:r:1:2:3');
  await call('updateItem', r, { title: 'My name' });
  await call('markChatsRemoved', [{ id: r, reason: 'local_only' }]);
  assert.equal(library().items.find(i => i.id === r).title, 'My name');
});

test('markChatsRemoved: deleted / out_of_scope keep by default and trash only untouched chats', async () => {
  const { call, library, writes } = fixture();
  await call('upsertChats', [entry(KEY), entry(KEY2)]);
  const a = chatItemId(KEY), b = chatItemId(KEY2);
  await call('updateItem', b, { favorite: true });
  let out = await call('markChatsRemoved', [{ id: a, reason: 'deleted' }, { id: b, reason: 'out_of_scope' }]);
  assert.deepEqual(out.results.map(r => r.status), ['kept', 'kept']);
  assert.equal(library().items.find(i => i.id === a).chat.removed, 'deleted');
  assert.equal(library().items.find(i => i.id === a).deletedAt, null);
  const w = writes();
  await call('markChatsRemoved', [{ id: a, reason: 'deleted' }]);
  assert.equal(writes(), w, 'nothing new, nothing written');
  out = await call('markChatsRemoved', [{ id: a, reason: 'deleted' }, { id: b, reason: 'out_of_scope' }], { trash: true });
  assert.deepEqual(out.results.map(r => r.status), ['removed', 'kept']);
  assert.ok(library().items.find(i => i.id === a).deletedAt);
  assert.equal(library().items.find(i => i.id === b).deletedAt, null, 'a touched chat is never trashed by sync');
  // Disconnect-with-removal marks what it trashed, so a new pairing can bring those back.
  await call('upsertChats', [entry('k:d:1:2:3')]);
  out = await call('markChatsRemoved', [{ id: chatItemId('k:d:1:2:3'), reason: 'disconnected' }], { trash: true });
  assert.equal(out.results[0].status, 'removed');
  assert.equal(library().items.find(i => i.id === chatItemId('k:d:1:2:3')).chat.removed, 'disconnected');
  // Any later upsert clears the flag.
  await call('upsertChats', [entry(KEY2, { fingerprint: 'fp9', seq: 30 })]);
  assert.equal(library().items.find(i => i.id === b).chat.removed, '');
});

test('placeChats moves only chats still where sync put them; deleteChats leaves no tombstone', async () => {
  const { call, library, commits } = fixture();
  await call('upsertChats', [entry(KEY), entry(KEY2)]);
  const a = chatItemId(KEY), b = chatItemId(KEY2);
  const mine = await call('createCollection', { name: 'Mine' });
  await call('updateItem', b, { collectionId: mine.id });
  const out = await call('placeChats', [{ id: a, collectionKey: 'x' }, { id: b, collectionKey: 'x' }, { id: 'nope', collectionId: '' }], { ensureCollections: [{ key: 'x', name: 'AI chats' }] });
  const created = library().collections.find(c => c.name === 'AI chats');
  assert.deepEqual(out.results, [{ id: a, status: 'moved', collectionId: created.id }, { id: b, status: 'kept' }, { id: 'nope', status: 'missing' }]);
  assert.equal(library().items.find(i => i.id === a).chat.autoCollectionId, created.id);
  assert.equal((await call('placeChats', [{ id: a, collectionId: created.id }])).results[0].status, 'unchanged');
  const note = await call('saveItem', { type: 'note', title: 'x' });
  const sub = await call('saveItem', { type: 'note', title: 'Sub', parentId: a });
  const removed = await call('deleteChats', [a, note.id, 'nope']);
  assert.deepEqual(removed, { ids: [a] });
  assert.ok(!(library().tombstones || []).some(t => t.id === a));
  assert.ok(library().items.some(i => i.id === note.id), 'other types are ignored');
  assert.equal(library().items.find(i => i.id === sub.id).parentId, '', 'its subpage moves to the top level');
  assert.equal(commits.at(-1).operation, 'deleteChats');
  assert.ok(CHAT_SYSTEM_DELETES.includes('deleteChats'));
});

test('chats survive import/export round trips and older-build keys', async () => {
  const { call, library } = fixture();
  await call('upsertChats', [entry()]);
  const exported = await call('exportLibrary');
  exported.items[0].chat.futureField = 'kept';
  exported.items[0].updatedAt = new Date(Date.now() + 1000).toISOString();
  const target = fixture();
  await target.call('importLibrary', exported);
  const item = target.library().items[0];
  assert.equal(item.type, 'chat');
  assert.equal(item.chat.threadKey, KEY);
  assert.equal(item.chat.futureField, 'kept');
  // An edit keeps unknown chat keys.
  await target.call('updateItem', item.id, { title: 'x' });
  assert.equal(target.library().items[0].chat.futureField, 'kept');
  // A forged chat id is refused for the whole import (nothing written).
  const forged = structuredClone(exported);
  forged.items[0].id = 'chat_tk_forged';
  await assert.rejects(fixture().call('importLibrary', forged), /A chat needs its Threadkeeper thread/);
  assert.ok(library().items.length === 1);
});

test('queryItems finds chats by provider, project and topic', async () => {
  const { queryItems } = await import('../extension/lib/store.js');
  const { call } = fixture();
  await call('upsertChats', [entry()]);
  const state = await call('loadLibrary');
  assert.equal(queryItems(state, { query: 'lisbon' }).length, 1);
  assert.equal(queryItems(state, { query: 'travel chatgpt' }).length, 1);
  assert.equal(queryItems(state, { query: 'type:chat' }).length, 1);
  assert.equal(queryItems(state, { type: 'note' }).length, 0);
});

test('reviving a trashed chat the user moved keeps their collection unless the send names a target', async () => {
  const { call, library } = fixture();
  const mirror = await call('createCollection', { name: 'AI chats' });
  const research = await call('createCollection', { name: 'Research' });
  await call('upsertChats', [entry(KEY, { seq: 10, placement: { collectionId: mirror.id } })]);
  const id = chatItemId(KEY);
  await call('updateItem', id, { collectionId: research.id });
  await call('deleteItem', id);
  // A manual send with no target: revive, default (mirror) placement, no force.
  const revived = await call('upsertChats', [entry(KEY, { seq: 11, fingerprint: 'fp2', origin: 'manual', revive: true, placement: { collectionId: mirror.id } })]);
  assert.equal(revived.results[0].status, 'updated');
  let item = library().items.find(i => i.id === id);
  assert.equal(item.deletedAt, null);
  assert.equal(item.collectionId, research.id, 'the chat comes back where the user put it');
  assert.equal(item.chat.autoCollectionId, mirror.id);
  assert.equal(isChatTouched(item, library().items), true, 'it still counts as moved');
  // A send with an explicit target (force) moves it.
  await call('deleteItem', id);
  await call('upsertChats', [entry(KEY, { seq: 12, fingerprint: 'fp3', origin: 'manual', revive: true, placement: { collectionId: mirror.id, force: true } })]);
  item = library().items.find(i => i.id === id);
  assert.equal(item.collectionId, mirror.id);
});
