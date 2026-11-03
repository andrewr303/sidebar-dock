import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createThreadkeeperWorker, isUserTouched, inSyncScope, listCollections, RETRY_ALARM, SWEEP_ALARM,
} from '../extension/lib/threadkeeper/worker.js';
import { createLibraryStore } from '../extension/lib/store.js';
import { createChatDataStore } from '../extension/lib/chat-data.js';
import { createThreadkeeperStateStore, normalizeThreadkeeperState, STATE_KEY } from '../extension/lib/threadkeeper/state.js';
import { memoryArea } from '../extension/lib/storage/area.js';
import { PROTO, chatItemId, syncedHash, threadHash } from '../extension/lib/threadkeeper/protocol.js';

const TK = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const SELF = 'stillstillstillstillstillstillst'.replace(/[^a-p]/g, 'a');
const sender = (id = TK) => ({ id, url: `chrome-extension://${id}/background.js` });
const msg = (type, fields = {}) => ({ proto: PROTO, from: 'threadkeeper', type, requestId: `r-${Math.random()}`, ...fields });
const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const KEY = n => `chatgpt:acct:ws:thread${n}:main`;
const payload = (n, extra = {}) => ({
  threadKey: KEY(n), title: `Thread ${n}`, gist: `Gist ${n}`, provider: 'chatgpt', providerLabel: 'ChatGPT', category: 'chat',
  project: extra.project ?? 'Still', workflowState: 'active', updatedAt: '2026-10-01T00:00:00Z', messageCount: 2, url: `https://chatgpt.com/c/${n}`,
  seq: extra.seq ?? 10, revision: extra.revision ?? 1, fingerprint: extra.fingerprint ?? `fp${n}-${extra.seq ?? 10}`,
  analysis: { source: 'ai', gist: `Gist ${n}`, topics: ['alpha', 'beta'], generatedAt: '2026-10-01T00:00:00Z' },
  transcript: extra.transcript ?? { included: true, revision: extra.revision ?? 1, totalMessages: 2, truncated: false, from: 0,
    messages: [{ index: 0, role: 'user', content: 'Hi' }, { index: 1, role: 'assistant', content: 'Hello' }] },
  ...extra.fields,
});

// The real library store (lib/store.js) over a memory value the tests can poke at: store.library is the live stored
// document (tests edit it directly to stand in for the user), store.calls logs the operations the worker used.
function fakeStore() {
  const memory = { value: null };
  const calls = [];
  const commits = [];
  const real = createLibraryStore({ read: async () => memory.value, write: async state => { memory.value = state; },
    onCommit: change => Promise.all(commits.map(hook => hook(change))) });
  const op = name => async (...args) => { calls.push([name, ...args.map(arg => (Array.isArray(arg) ? arg.map(entry => entry?.id ?? entry) : arg))]); return real.dispatch(name, args); };
  const store = {
    calls, commits,
    get library() { return memory.value || (memory.value = { schemaVersion: 1, settings: {}, updatedAt: '2026-01-01T00:00:00.000Z', items: [], collections: [], tombstones: [] }); },
    item: id => store.library.items.find(item => item.id === id),
    dispatch: (name, ...args) => real.dispatch(name, args),
  };
  for (const name of ['upsertChats', 'markChatsRemoved', 'placeChats', 'setChatFlags', 'deleteChats', 'createCollection', 'permanentlyDeleteItem', 'emptyTrash']) store[name] = op(name);
  return store;
}

// The real chat data store (lib/chat-data.js, memory backend) on a test clock.
function fakeChatData() {
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const real = createChatDataStore({ indexedDB: null, now: () => clock });
  return Object.assign(real, { tick(ms) { clock += ms; }, async has(id) { return !!(await real.get(id)); } });
}

// Threadkeeper on the other end: answers by type, records what Still sent.
function fakeTk(handlers = {}) {
  const sent = [];
  const transport = async (to, message, timeoutMs) => {
    sent.push({ to, message, timeoutMs });
    const handler = handlers[message.type];
    if (handler === 'unreachable') throw new Error('Could not establish connection. Receiving end does not exist.');
    const data = typeof handler === 'function' ? await handler(message) : handler;
    if (data && data.ok === false) return { proto: PROTO, ...data };
    return { ok: true, proto: PROTO, ...(data || {}) };
  };
  return { sent, transport, handlers, types: () => sent.map(entry => entry.message.type) };
}

async function harness({ tk = {}, state = {}, writeIntervalMs = 20, now } = {}) {
  const area = memoryArea(Object.keys(state).length ? { [STATE_KEY]: state } : {});
  const store = fakeStore();
  const chatData = fakeChatData();
  const remote = fakeTk({ hello: { app: 'threadkeeper', version: '1.0', paired: true, tk: { version: '1.0', capabilities: ['sync', 'search', 'context', 'transcripts', 'open'] } },
    'pair.request': { status: 'pending' }, 'sync.configure': { queued: 3, total: 40 }, 'threads.untrack': { untracked: 1 }, ...tk });
  const alarms = new Map();
  const worker = createThreadkeeperWorker({
    store, chatData, readLibrary: async () => structuredClone(store.library), state: createThreadkeeperStateStore({ area, locks: null }),
    transport: remote.transport, alarms: { create: async (name, options) => { alarms.set(name, options); }, clear: async name => alarms.delete(name), getAll: async () => [...alarms].map(([name, options]) => ({ name, ...options })) },
    selfId: SELF, version: () => '0.4.0', writeIntervalMs, log: () => {}, ...(now ? { now } : {}),
  });
  store.commits.push(change => worker.onCommit(change));
  return { area, store, chatData, remote, alarms, worker, read: async () => normalizeThreadkeeperState(await area.read(STATE_KEY)) };
}

const PAIRED = { status: 'paired', extensionId: TK, epoch: 'epoch-0001', configured: true, tk: { version: '1.0', capabilities: ['sync', 'search', 'context', 'transcripts', 'open'] } };

test('spoofed and unpaired senders are refused before anything is written', async () => {
  const { worker, store, chatData, area } = await harness({ state: PAIRED });
  const upsert = msg('threads.upsert', { threads: [payload(1)], origin: 'sync' });
  const refused = [
    [{ id: OTHER, url: `chrome-extension://${OTHER}/x.html` }, 'not_paired'],
    [{ id: TK, url: 'https://chatgpt.com/c/1', tab: { id: 3 } }, 'not_paired'],                       // Threadkeeper's content script
    [{ id: TK, url: `chrome-extension://${TK}/manager.html`, tab: { id: 3 } }, 'not_paired'],
    [{ id: TK, origin: `chrome-extension://${TK}/` }, 'not_paired'],
    [{ id: 'not-an-id', url: 'chrome-extension://not-an-id/x' }, 'not_paired'],
    [null, 'not_paired'],
  ];
  for (const [who, code] of refused) {
    const response = await worker.handleExternalMessage(upsert, who);
    assert.equal(response.ok, false);
    assert.equal(response.proto, PROTO);
    assert.equal(response.error.code, code, JSON.stringify(who));
  }
  assert.equal(store.calls.length, 0);
  assert.equal((await chatData.ids()).length, 0);
  assert.equal((await worker.handleExternalMessage({ ...upsert, proto: 'still-threadkeeper/2' }, sender())).error.code, 'version_mismatch');
  assert.equal((await worker.handleExternalMessage('hello', sender())).error.code, 'bad_request');
  assert.equal((await worker.handleExternalMessage(msg('threads.explode'), sender())).error.code, 'unsupported');
  assert.equal((await worker.handleExternalMessage(msg('threads.upsert', { threads: [{ threadKey: 'k', title: 'x'.repeat(4.2 * 1024 * 1024) }], origin: 'sync' }), sender())).error.code, 'too_large');
  assert.equal((await worker.handleExternalMessage(msg('threads.upsert', { threads: [], origin: 'sync' }), sender())).error.code, 'bad_request');
  assert.equal((await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1)], origin: 'push' }), sender())).error.code, 'bad_request');
  // origin works too, and an unknown sender may say hello without a write.
  const viaOrigin = await worker.handleExternalMessage(msg('hello'), { id: TK, origin: `chrome-extension://${TK}` });
  assert.deepEqual([viaOrigin.ok, viaOrigin.paired, viaOrigin.epoch], [true, true, 'epoch-0001']);
  const stranger = await worker.handleExternalMessage(msg('hello'), sender(OTHER));
  assert.deepEqual(stranger, { app: 'still', version: '0.4.0', paired: false, ok: true, proto: PROTO });
  const before = JSON.stringify(await area.read(STATE_KEY));
  assert.equal((await worker.handleExternalMessage(msg('pair.revoke'), sender(OTHER))).error.code, 'not_paired');
  assert.equal((await worker.handleExternalMessage(msg('collections.list'), sender(OTHER))).error.code, 'not_paired');
  assert.equal(JSON.stringify(await area.read(STATE_KEY)), before);
});

test('pairing: hello probe, pending code, only the matching pair.granted pairs, nothing syncs until Start syncing', async () => {
  const { worker, remote, read, store } = await harness();
  const pending = await worker.handleRequest('connect', { extensionId: TK });
  assert.equal(pending.ok, true);
  assert.equal(pending.data.status, 'pending');
  assert.match(pending.data.code, /^\d{6}$/);
  assert.deepEqual(remote.types(), ['hello', 'pair.request']);
  const request = remote.sent[1].message;
  assert.equal(request.appName, 'Still');
  assert.equal(request.code, pending.data.code);
  assert.equal(request.from, 'still');
  const state = await read();
  assert.equal(state.status, 'pending');
  assert.equal(state.epoch, request.epoch);
  // Unpaired: an upsert from the pending id waits for approval; a grant with another requestId or from another id is refused.
  assert.equal((await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1)], origin: 'manual' }), sender())).error.code, 'pending_approval');
  assert.equal((await worker.handleExternalMessage(msg('pair.granted', { requestId: 'wrong', tk: {} }), sender())).error.code, 'not_paired');
  assert.equal((await worker.handleExternalMessage(msg('pair.granted', { requestId: state.pending.requestId, tk: {} }), sender(OTHER))).error.code, 'not_paired');
  assert.equal((await read()).status, 'pending');
  const granted = await worker.handleExternalMessage(msg('pair.granted', { requestId: state.pending.requestId, tk: { version: '1.0', capabilities: ['sync', 'transcripts'] } }), sender());
  assert.equal(granted.ok, true);
  const paired = await read();
  assert.deepEqual([paired.status, paired.configured, paired.pending, paired.tk.capabilities], ['paired', false, null, ['sync', 'transcripts']]);
  assert.equal((await worker.handleExternalMessage(msg('pair.granted', { requestId: state.pending.requestId, tk: {} }), sender())).ok, true, 'a repeated grant is acknowledged');
  // Paired but not configured: sync pushes are out of scope.
  const early = await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1)], origin: 'sync' }), sender());
  assert.equal(early.results[0].status, 'skipped');
  assert.equal(early.results[0].reason, 'out_of_scope');
  assert.equal(store.calls.length, 0);
  const started = await worker.handleRequest('startSync', { patch: { scope: 'projects', projects: ['Still'] } });
  assert.deepEqual(started.data, { queued: 3, total: 40, retrying: false });
  const configure = remote.sent.find(entry => entry.message.type === 'sync.configure').message;
  assert.deepEqual(configure.prefs, { scope: 'projects', projects: ['Still'], providers: [], transcripts: true, autoUpdate: true });
  assert.equal(configure.epoch, paired.epoch);
  const after = await read();
  assert.deepEqual([after.configured, after.configDirty, after.backfill.total], [true, false, 40]);
});

test('connect refuses bad ids, non-Threadkeeper extensions and a busy Threadkeeper; denial is recorded', async () => {
  const { worker, read } = await harness({ tk: { hello: { app: 'other', version: '1', paired: false } } });
  assert.equal((await worker.handleRequest('connect', { extensionId: 'nope' })).error.code, 'bad_request');
  assert.equal((await worker.handleRequest('connect', { extensionId: SELF })).error.code, 'bad_request');
  assert.match((await worker.handleRequest('connect', { extensionId: TK })).error.message, /not Threadkeeper/);
  const busy = await harness({ tk: { 'pair.request': { ok: false, error: { code: 'busy', message: 'x' } } } });
  const refused = await busy.worker.handleRequest('connect', { extensionId: TK });
  assert.equal(refused.error.code, 'busy');
  assert.equal((await busy.read()).status, 'off');
  const gone = await harness({ tk: { hello: 'unreachable' } });
  assert.equal((await gone.worker.handleRequest('connect', { extensionId: TK })).error.code, 'unreachable');
  const denied = await harness();
  await denied.worker.handleRequest('connect', { extensionId: TK });
  const { pending } = await denied.read();
  assert.equal((await denied.worker.handleExternalMessage(msg('pair.denied', { requestId: pending.requestId }), sender())).ok, true);
  assert.equal((await denied.read()).status, 'denied');
  assert.equal((await read()).status, 'off');
});

test('a pending request expires after ten minutes', async () => {
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const { worker, read } = await harness({ now: () => clock });
  await worker.handleRequest('connect', { extensionId: TK });
  const { pending } = await read();
  clock += 11 * 60 * 1000;
  worker.invalidate();
  assert.equal((await worker.handleExternalMessage(msg('pair.granted', { requestId: pending.requestId, tk: {} }), sender())).error.code, 'not_paired');
  assert.equal((await worker.handleRequest('state')).data.status, 'off');
});

test('pushes: chat data first, mirror placement, one coalesced library write, idempotent repeats', async () => {
  const { worker, store, chatData, read } = await harness({ state: PAIRED });
  const [first, second] = await Promise.all([
    worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1), payload(2, { project: 'Unfiled / Uncertain' })], origin: 'sync' }), sender()),
    worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(3, { project: 'Other' })], origin: 'sync' }), sender()),
  ]);
  assert.deepEqual(first.results.map(row => row.status), ['created', 'created']);
  assert.equal(first.results[0].itemId, chatItemId(KEY(1)));
  assert.equal(first.results[0].fingerprint, 'fp1-10');
  assert.equal(first.results[0].seq, 10);
  assert.equal(first.results[0].needsTranscript, undefined);
  assert.equal(second.results[0].status, 'created');
  const writes = store.calls.filter(call => call[0] === 'upsertChats');
  assert.ok(writes.length <= 2);
  const [parent] = store.library.collections;
  assert.equal(parent.name, 'AI chats');
  const still = store.library.collections.find(c => c.name === 'Still');
  assert.equal(still.parentId, parent.id);
  const items = Object.fromEntries(store.library.items.map(item => [item.chat.threadKey, item]));
  assert.equal(items[KEY(1)].collectionId, still.id);
  assert.equal(items[KEY(2)].collectionId, parent.id, 'unfiled threads land in the parent');
  assert.equal(items[KEY(1)].excerpt, 'Gist 1');
  assert.equal(items[KEY(1)].chat.hasTranscript, true);
  assert.equal(items[KEY(1)].chat.origin, 'sync');
  assert.deepEqual(items[KEY(1)].tags, [], 'topics become tags only when asked');
  const record = await chatData.get(chatItemId(KEY(1)));
  assert.deepEqual([record.transcript.revision, record.transcript.stored, record.transcript.truncated], [1, 2, false]);
  assert.equal(record.thread.transcript, undefined, 'the record never carries the messages');
  assert.equal((await chatData.getTranscript(chatItemId(KEY(1)))).messages.length, 2);
  const memory = (await read()).collections;
  assert.equal(memory.__parent, parent.id);
  assert.equal(memory.still, still.id);
  // The same payload again: unchanged, and no chat-data write.
  const writesBefore = store.calls.length;
  const stored = record.storedAt;
  chatData.tick(1000);
  const again = await worker.handleExternalMessage(msg('threads.upsert', { threads: [{ ...payload(1), transcript: { included: false, revision: 1, totalMessages: 2 } }], origin: 'sync' }), sender());
  assert.equal(again.results[0].status, 'unchanged');
  assert.equal(again.results[0].needsTranscript, undefined, 'Still holds the transcript of this revision');
  assert.equal((await chatData.get(chatItemId(KEY(1)))).storedAt, stored);
  assert.equal(store.calls.length, writesBefore + 1);
  // An older seq is stale; Still answers with what it holds.
  const stale = await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1, { seq: 5, fingerprint: 'old' })], origin: 'sync' }), sender());
  assert.deepEqual(stale.results[0], { threadKey: KEY(1), status: 'skipped', reason: 'stale', itemId: chatItemId(KEY(1)), fingerprint: 'fp1-10', seq: 10 });
  // Malformed entries are skipped one by one.
  const mixed = await worker.handleExternalMessage(msg('threads.upsert', { threads: [{ nope: 1 }, payload(4)], origin: 'sync' }), sender());
  assert.deepEqual(mixed.results.map(row => row.status), ['skipped', 'created']);
  assert.equal(mixed.results[0].reason, 'invalid');
  await worker.flushBookkeeping();
  assert.equal((await read()).counts.created, 4);
});

test('a metadata-only push for a new revision asks for the transcript; Still’s own prefs are enforced', async () => {
  const { worker, chatData } = await harness({ state: { ...PAIRED, prefs: { scope: 'projects', projects: ['Still'] } } });
  const meta = await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1, { transcript: { included: false, revision: 1, totalMessages: 2 } })], origin: 'sync' }), sender());
  assert.equal(meta.results[0].needsTranscript, true);
  const outside = await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(2, { project: 'Elsewhere' })], origin: 'sync' }), sender());
  assert.equal(outside.results[0].reason, 'out_of_scope');
  assert.equal(await chatData.has(chatItemId(KEY(2))), false);
  const manual = await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(2, { project: 'Elsewhere' })], origin: 'manual' }), sender());
  assert.equal(manual.results[0].status, 'created', 'Send to Still ignores the scope');
  const off = await harness({ state: { ...PAIRED, prefs: { transcripts: false } } });
  const noTranscript = await off.worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1)], origin: 'sync' }), sender());
  assert.equal(noTranscript.results[0].status, 'created');
  assert.equal(noTranscript.results[0].needsTranscript, undefined);
  assert.equal(await off.chatData.getTranscript(chatItemId(KEY(1))), null, 'transcripts off: none stored');
});

test('a third concurrent push is told to come back later', async () => {
  const { worker, store } = await harness({ state: PAIRED, writeIntervalMs: 50 });
  const original = store.upsertChats;
  let release;
  store.upsertChats = async (...args) => { await new Promise(resolve => { release = resolve; }); return original(...args); };
  const a = worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1)], origin: 'sync' }), sender());
  const b = worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(2)], origin: 'sync' }), sender());
  await settle(5);
  const c = await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(3)], origin: 'sync' }), sender());
  assert.equal(c.error.code, 'busy');
  assert.ok(c.error.retryAfterMs > 0);
  store.upsertChats = original;
  while (!release) await settle(5);
  release();
  assert.equal((await a).results[0].status, 'created');
  assert.equal((await b).results[0].status, 'created');
});

test('dismissed and trashed chats: sync skips them, a manual send brings them back', async () => {
  const { worker, store, chatData, remote } = await harness({ state: PAIRED });
  await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1), payload(2)], origin: 'sync' }), sender());
  // The user deletes chat 1 forever: chat data goes, the id is dismissed, Threadkeeper stops tracking it.
  await store.permanentlyDeleteItem(chatItemId(KEY(1)));
  await settle(5);
  assert.equal(await chatData.has(chatItemId(KEY(1))), false);
  assert.deepEqual(await chatData.dismissed([chatItemId(KEY(1))]), [chatItemId(KEY(1))]);
  const untrack = remote.sent.find(entry => entry.message.type === 'threads.untrack');
  assert.deepEqual(untrack.message.hashes, [threadHash(KEY(1))]);
  const skipped = await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1, { seq: 11 })], origin: 'sync' }), sender());
  assert.equal(skipped.results[0].reason, 'dismissed');
  assert.equal(await chatData.has(chatItemId(KEY(1))), false, 'no chat data for a dismissed chat');
  const revived = await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1, { seq: 12 })], origin: 'manual' }), sender());
  assert.equal(revived.results[0].status, 'created');
  assert.deepEqual(await chatData.dismissed([chatItemId(KEY(1))]), []);
  // Chat 2 in Trash: sync leaves it there; a manual send restores it and moves it to the chosen collection.
  store.item(chatItemId(KEY(2))).deletedAt = '2026-10-02T00:00:00Z';
  const trashed = await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(2, { seq: 11 })], origin: 'sync' }), sender());
  assert.equal(trashed.results[0].reason, 'trashed');
  const restored = await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(2, { seq: 13 })], origin: 'manual', target: { collectionName: 'Keep' } }), sender());
  assert.equal(restored.results[0].status, 'updated');
  const two = store.item(chatItemId(KEY(2)));
  assert.equal(two.deletedAt, null);
  const keep = store.library.collections.find(c => c.name === 'Keep');
  assert.equal(two.collectionId, keep.id);
  assert.equal(two.chat.autoCollectionId, keep.id, 'a move Still made is not the user’s move');
});

test('threads.remove: local_only deletes untouched chats without dismissing and strips touched ones; others follow onRemoved', async () => {
  const { worker, store, chatData } = await harness({ state: { ...PAIRED, prefs: { onRemoved: 'trash' } } });
  await worker.handleExternalMessage(msg('threads.upsert', { threads: [1, 2, 3, 4].map(n => payload(n)), origin: 'sync' }), sender());
  const item = n => store.item(chatItemId(KEY(n)));
  item(2).content = 'My notes';
  item(4).title = 'Renamed by me';
  const local = await worker.handleExternalMessage(msg('threads.remove', { threadKeys: [KEY(1), KEY(2), 'unknown:key'], reason: 'local_only' }), sender());
  assert.deepEqual(local.results.map(row => row.status), ['removed', 'removed', 'missing']);
  assert.equal(item(1), undefined, 'untouched: deleted forever');
  await settle(5);
  assert.deepEqual(await chatData.dismissed([chatItemId(KEY(1))]), [], 'not a user dismissal');
  assert.equal(await chatData.has(chatItemId(KEY(2))), false, 'thread data gone');
  assert.equal(item(2).title, 'Private thread');
  assert.equal(item(2).content, 'My notes');
  assert.equal(item(2).chat.removed, 'local_only');
  assert.equal(item(2).deletedAt, null);
  const gone = await worker.handleExternalMessage(msg('threads.remove', { threadKeys: [KEY(3), KEY(4)], reason: 'deleted' }), sender());
  assert.deepEqual(gone.results.map(row => row.status), ['removed', 'kept']);
  assert.ok(item(3).deletedAt);
  assert.equal(item(4).deletedAt, null);
  assert.equal(item(4).chat.removed, 'deleted');
  assert.equal((await worker.handleExternalMessage(msg('threads.remove', { threadKeys: [KEY(3)], reason: 'whatever' }), sender())).error.code, 'bad_request');
});

test('collections.list and chats.status answer from the library', async () => {
  const { worker, store } = await harness({ state: PAIRED });
  await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1)], origin: 'sync' }), sender());
  store.library.collections.push({ id: 'gone', name: 'Gone', parentId: '', deletedAt: '2026-01-01T00:00:00Z' });
  const list = await worker.handleExternalMessage(msg('collections.list'), sender());
  assert.deepEqual(list.collections.map(c => c.path), ['AI chats', 'AI chats / Still']);
  const status = await worker.handleExternalMessage(msg('chats.status', { threadKeys: [KEY(1), KEY(9)] }), sender());
  assert.deepEqual(Object.keys(status.chats), [KEY(1)]);
  assert.deepEqual(status.chats[KEY(1)], { itemId: chatItemId(KEY(1)), collectionId: list.collections[1].id, collectionName: 'Still', trashed: false, hasTranscript: true, transcriptRevision: 1 });
  assert.equal((await worker.handleExternalMessage(msg('chats.status', { threadKeys: 'x' }), sender())).error.code, 'bad_request');
});

test('imports: threads.get in batches of 20 with track, deferred keys asked again, missing reported', async () => {
  const keys = Array.from({ length: 23 }, (_, n) => KEY(n));
  let calls = 0;
  const { worker, store, remote } = await harness({ state: PAIRED, tk: {
    'threads.get': message => {
      calls++;
      const asked = message.threadKeys;
      const deferred = calls === 1 ? asked.slice(18) : [];
      const sendNow = asked.filter(key => !deferred.includes(key) && key !== KEY(22));
      return { threads: sendNow.map(key => payload(Number(key.match(/thread(\d+)/)[1]))), missing: asked.includes(KEY(22)) ? [KEY(22)] : [], deferred };
    },
  } });
  const result = await worker.handleRequest('importThreads', { threadKeys: keys, target: { collectionName: 'Agents' }, origin: 'manual' });
  assert.equal(result.ok, true);
  assert.equal(result.data.created, 22);
  assert.equal(result.data.results.find(row => row.threadKey === KEY(22)).reason, 'missing');
  const gets = remote.sent.filter(entry => entry.message.type === 'threads.get').map(entry => entry.message);
  assert.ok(gets.every(message => message.track === true && message.transcript === 'full' && message.threadKeys.length <= 20));
  assert.equal(gets.filter(message => message.threadKeys.includes(KEY(18))).length, 2, 'deferred keys were asked again');
  const agents = store.library.collections.find(c => c.name === 'Agents');
  assert.ok(store.library.items.every(item => item.collectionId === agents.id && item.chat.origin === 'manual'));
  assert.equal(store.library.collections.filter(c => c.name === 'Agents').length, 1);
  // Assistant imports never revive a dismissed chat; undo deletes without dismissing.
  const undo = await worker.handleRequest('undoImport', { ids: [chatItemId(KEY(0)), 'note_x'] });
  assert.equal(undo.data.deleted, 1);
  const again = await worker.handleRequest('importThreads', { threadKeys: [KEY(0)], origin: 'assistant' });
  assert.equal(again.data.created, 1, 'an undone import is not a dismissal');
});

test('page requests: reads only, validated, track forced off; errors keep their code', async () => {
  const { worker, remote } = await harness({ state: PAIRED, tk: {
    'threads.search': { results: [{ threadKey: 'a', title: 'A' }, { bad: 1 }], total: 1, nextCursor: null, semantic: true, reranked: false },
    facets: { ok: false, error: { code: 'disabled', message: 'off' } },
    'threads.get': message => ({ threads: [], missing: message.threadKeys, deferred: [] }),
  } });
  const search = await worker.handleRequest('request', { type: 'threads.search', fields: { query: 'refactor', limit: 5 } });
  assert.deepEqual(search.data.results.map(row => row.threadKey), ['a']);
  const sent = remote.sent.at(-1);
  assert.equal(sent.timeoutMs, 15000);
  assert.equal(sent.message.query, 'refactor');
  assert.equal((await worker.handleRequest('request', { type: 'facets' })).error.code, 'disabled');
  assert.equal((await worker.handleRequest('request', { type: 'pair.revoke' })).error.code, 'unsupported');
  assert.equal((await worker.handleRequest('request', { type: 'threads.upsert' })).error.code, 'unsupported');
  await worker.handleRequest('request', { type: 'threads.get', fields: { threadKeys: ['x'], track: true } });
  assert.equal(remote.sent.at(-1).message.track, false);
  assert.equal((await worker.handleRequest('nope')).error.code, 'unsupported');
  const unpaired = await harness();
  assert.equal((await unpaired.worker.handleRequest('request', { type: 'facets' })).error.code, 'not_paired');
});

test('Threadkeeper answering not_paired marks the link revoked; unreachable keeps it', async () => {
  const { worker, read } = await harness({ state: PAIRED, tk: { 'threads.list': 'unreachable', facets: { ok: false, error: { code: 'not_paired' } } } });
  assert.equal((await worker.handleRequest('request', { type: 'threads.list' })).error.code, 'unreachable');
  assert.equal((await read()).status, 'paired');
  assert.equal((await worker.handleRequest('request', { type: 'facets' })).error.code, 'not_paired');
  assert.equal((await read()).status, 'revoked');
});

test('a failed sync.configure keeps the prefs dirty and backs off with the retry alarm', async () => {
  let up = false;
  const { worker, alarms, read } = await harness({ state: PAIRED, tk: { 'sync.configure': () => (up ? { queued: 1, total: 2 } : { ok: false, error: { code: 'busy', retryAfterMs: 100 } }) } });
  const saved = await worker.handleRequest('setPrefs', { patch: { transcripts: false } });
  assert.equal(saved.data.prefs.transcripts, false);
  assert.equal((await read()).configDirty, true);
  assert.deepEqual(alarms.get(RETRY_ALARM), { delayInMinutes: 1 });
  await worker.handleAlarm({ name: RETRY_ALARM });
  assert.deepEqual(alarms.get(RETRY_ALARM), { delayInMinutes: 5 });
  up = true;
  assert.equal(await worker.handleAlarm({ name: RETRY_ALARM }), true);
  assert.equal((await read()).configDirty, false);
  assert.equal(alarms.has(RETRY_ALARM), false);
  assert.equal((await worker.handleRequest('setPrefs', { patch: { scope: 'nope' } })).error.code, 'bad_request');
  assert.equal(await worker.handleAlarm({ name: 'still:reminder:x' }), false);
});

test('Threadkeeper’s pair.revoke keeps the chats; disconnect can move untouched ones to Trash and a new pairing restores them', async () => {
  const { worker, store, read, remote } = await harness({ state: PAIRED });
  await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1), payload(2)], origin: 'sync' }), sender());
  store.library.items[1].favorite = true;
  const counts = await worker.handleRequest('impact', { disconnect: true });
  assert.deepEqual([counts.data.chats, counts.data.untouched, counts.data.touched], [2, 1, 1]);
  const epoch = (await read()).epoch;
  const result = await worker.handleRequest('disconnect', { removeChats: true });
  assert.deepEqual(result.data, { removed: 1, kept: 1 });
  assert.ok(remote.types().includes('pair.revoke'));
  const state = await read();
  assert.equal(state.status, 'off');
  assert.notEqual(state.epoch, epoch, 'a new epoch after disconnect');
  assert.equal(store.library.items[0].chat.removed, 'disconnected');
  assert.ok(store.library.items[0].deletedAt);
  // Reconnect: the trashed chat comes back.
  await worker.handleRequest('connect', { extensionId: TK });
  const { pending } = await read();
  await worker.handleExternalMessage(msg('pair.granted', { requestId: pending.requestId, tk: {} }), sender());
  await settle(10);
  assert.equal(store.library.items[0].deletedAt, null);
  assert.equal(store.library.items[0].chat.removed, '');
  const revoked = await harness({ state: PAIRED });
  await revoked.worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1)], origin: 'sync' }), sender());
  assert.equal((await revoked.worker.handleExternalMessage(msg('pair.revoke'), sender())).ok, true);
  assert.equal((await revoked.read()).status, 'revoked');
  assert.equal(revoked.store.library.items.length, 1);
  assert.equal((await revoked.worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1)], origin: 'sync' }), sender())).error.code, 'not_paired');
});

test('refresh and transcript windows merge into the stored copy of the same revision', async () => {
  const full = n => Array.from({ length: n }, (_, index) => ({ index, role: index % 2 ? 'assistant' : 'user', content: `m${index}` }));
  const truncated = { included: true, revision: 2, totalMessages: 30, truncated: true, from: 0, messages: [...full(30).slice(0, 5), ...full(30).slice(25)] };
  const { worker, store, chatData } = await harness({ state: PAIRED, tk: {
    'threads.get': message => (message.transcript === 'window'
      ? { threads: [payload(1, { revision: 2, seq: 20, transcript: { included: true, revision: 2, totalMessages: 30, truncated: true, from: message.window.from,
        messages: full(30).slice(message.window.from, message.window.from + message.window.count) } })], missing: [], deferred: [] }
      : { threads: [payload(1, { revision: 2, seq: 21, transcript: truncated })], missing: [], deferred: [] }),
  } });
  await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1, { revision: 2, seq: 15, transcript: truncated })], origin: 'sync' }), sender());
  const id = chatItemId(KEY(1));
  assert.equal(store.library.items[0].chat.transcriptTruncated, true);
  const window = await worker.handleRequest('loadTranscriptWindow', { id, from: 5, count: 20 });
  assert.equal(window.ok, true);
  assert.deepEqual([window.data.stored, window.data.stale, window.data.truncated, window.data.messages.length], [true, false, false, 20]);
  assert.equal((await chatData.getTranscript(id)).messages.length, 30);
  assert.equal((await chatData.getTranscript(id)).truncated, false);
  assert.equal(store.library.items[0].chat.transcriptTruncated, false);
  const refreshed = await worker.handleRequest('refreshChat', { id });
  assert.equal(refreshed.data.status, 'updated');
  assert.equal((await chatData.getTranscript(id)).messages.length, 30, 'a truncated refresh of the same revision keeps the merged copy');
  assert.equal((await worker.handleRequest('refreshChat', { id: 'chat_tk_missing' })).error.code, 'not_found');
});

test('sweep deletes old orphans only; a missing chat store starts a new epoch', async () => {
  const { worker, chatData, store, read } = await harness({ state: PAIRED });
  await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1)], origin: 'sync' }), sender());
  await chatData.put(chatItemId('x'), { thread: { threadKey: 'x', revision: 1 } });
  chatData.tick(11 * 60 * 1000);
  await chatData.put(chatItemId('y'), { thread: { threadKey: 'y', revision: 1 } });
  const swept = await worker.sweep();
  assert.equal(swept.deleted, 1);
  assert.ok(await chatData.has(chatItemId('y')), 'a write in flight is not an orphan yet');
  assert.equal(await chatData.has(chatItemId('x')), false);
  assert.ok(await chatData.has(chatItemId(KEY(1))), 'library chats keep their data however old');
  const epoch = (await read()).epoch;
  await chatData.clear();
  assert.equal((await worker.sweep()).lost, true);
  assert.notEqual((await read()).epoch, epoch);
  assert.equal(store.library.items.length, 1);
});

test('startup and restores: alarms, liveness hello, a new epoch and sync.configure', async () => {
  const { worker, alarms, remote, read } = await harness({ state: PAIRED, tk: { hello: { app: 'threadkeeper', version: '2.0', paired: true, tk: { version: '2.0', capabilities: ['sync', 'analyze'] } } } });
  await worker.startup();
  assert.deepEqual(alarms.get(SWEEP_ALARM), { periodInMinutes: 1440 });
  assert.equal(remote.sent.find(entry => entry.message.type === 'hello').message.epoch, 'epoch-0001');
  assert.deepEqual((await read()).tk, { version: '2.0', capabilities: ['sync', 'analyze'] });
  await worker.onDataRestored();
  const state = await read();
  assert.notEqual(state.epoch, 'epoch-0001');
  const configure = remote.sent.filter(entry => entry.message.type === 'sync.configure').at(-1).message;
  assert.equal(configure.epoch, state.epoch);
  const forgotten = await harness({ state: PAIRED, tk: { hello: { app: 'threadkeeper', version: '2.0', paired: false } } });
  await forgotten.worker.startup();
  assert.equal((await forgotten.read()).status, 'revoked');
});

test('impact, re-placing untouched chats and removing stored transcripts', async () => {
  const { worker, store, chatData } = await harness({ state: PAIRED });
  await worker.handleExternalMessage(msg('threads.upsert', { threads: [payload(1), payload(2, { project: 'Other' })], origin: 'sync' }), sender());
  store.library.items[1].tags = ['mine'];
  const impact = await worker.handleRequest('impact', { patch: { placement: 'single', transcripts: false, scope: 'projects', projects: ['Other'] } });
  assert.deepEqual([impact.data.replace, impact.data.transcripts, impact.data.outOfScope], [1, 2, 1]);
  const target = await store.createCollection({ name: 'All chats' });
  await worker.handleRequest('setPrefs', { patch: { placement: 'single', singleCollectionId: target.id } });
  const moved = await worker.handleRequest('replaceChats');
  assert.equal(moved.data.moved, 1);
  assert.equal(store.library.items[0].collectionId, target.id);
  assert.notEqual(store.library.items[1].collectionId, target.id, 'touched chats stay where the user has them');
  const removed = await worker.handleRequest('removeTranscripts');
  assert.equal(removed.data.removed, 2);
  const records = await chatData.list();
  assert.ok(records.length === 2 && records.every(record => record.transcript === null));
  assert.equal(await chatData.getTranscript(chatItemId(KEY(1))), null);
  assert.ok(store.library.items.every(item => item.chat.hasTranscript === false));
});

test('pure helpers: touched chats, scope, collection paths', () => {
  const chat = { id: 'c', type: 'chat', title: 'T', content: '', tags: ['alpha'], collectionId: 'x', favorite: false,
    chat: { threadKey: 'k', syncedTitleHash: syncedHash('T'), syncedTags: ['alpha'], autoCollectionId: 'x' } };
  const library = { items: [chat] };
  assert.equal(isUserTouched(chat, library), false);
  assert.equal(isUserTouched({ ...chat, title: 'Mine' }, library), true);
  assert.equal(isUserTouched({ ...chat, tags: ['alpha', 'own'] }, library), true);
  assert.equal(isUserTouched({ ...chat, collectionId: 'y' }, library), true);
  assert.equal(isUserTouched({ ...chat, content: ' notes ' }, library), true);
  assert.equal(isUserTouched(chat, { items: [chat, { id: 'n', type: 'note', parentId: 'c', deletedAt: null }] }), true);
  assert.equal(isUserTouched(chat, { items: [chat, { id: 'n', type: 'note', parentId: 'c', deletedAt: '2026-01-01' }] }), false);
  assert.equal(inSyncScope({ project: 'A', provider: 'codex' }, { scope: 'all', providers: [] }), true);
  assert.equal(inSyncScope({ project: 'A', provider: 'codex' }, { scope: 'all', providers: ['chatgpt'] }), false);
  assert.equal(inSyncScope({ project: 'a ', provider: 'codex' }, { scope: 'projects', projects: ['A'], providers: [] }), true);
  assert.equal(inSyncScope({ project: 'A' }, { scope: 'manual' }), false);
  assert.deepEqual(listCollections({ collections: [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }] }).map(c => c.path), ['B / A', 'A / B'], 'cycles end');
});

test('a hello from the paired Threadkeeper refreshes its capabilities; ping reports liveness', async () => {
  const { worker, remote, read } = await harness({ state: PAIRED, tk: { hello: { app: 'threadkeeper', version: '3.0', paired: true, tk: { version: '3.0', capabilities: ['sync', 'remote_models'] } } } });
  const answer = await worker.handleExternalMessage(msg('hello'), sender());
  assert.equal(answer.paired, true);
  await settle(1100);
  assert.deepEqual(remote.types(), ['hello']);
  assert.deepEqual((await read()).tk.capabilities, ['sync', 'remote_models']);
  assert.deepEqual((await worker.handleRequest('ping')).data, { reachable: true, version: '3.0', tk: { version: '3.0', capabilities: ['sync', 'remote_models'] } });
  const down = await harness({ state: PAIRED, tk: { hello: 'unreachable' } });
  assert.deepEqual((await down.worker.handleRequest('ping')).data, { reachable: false, code: 'unreachable' });
  assert.equal((await down.read()).status, 'paired', 'an unreachable Threadkeeper keeps the pairing');
});
