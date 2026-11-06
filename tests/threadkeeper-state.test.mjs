import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeThreadkeeperState, patchPrefs, publicState, expirePending, pendingExpired, syncPrefsOf, syncPrefsChanged,
  createThreadkeeperStateStore, DEFAULT_PREFS, STATE_KEY,
} from '../extension/lib/threadkeeper/state.js';
import { memoryArea } from '../extension/lib/storage/area.js';
import { SNAPSHOT_EXCLUDED_KEYS, isSnapshotKey } from '../extension/lib/storage/snapshots.js';

const TK = 'abcdefghijklmnopabcdefghijklmnop';

test('defaults: not connected, every thread, mirror placement, assistant on', () => {
  const state = normalizeThreadkeeperState(undefined);
  assert.equal(state.version, 1);
  assert.equal(state.status, 'off');
  assert.equal(state.configured, false);
  assert.deepEqual(state.prefs, { ...DEFAULT_PREFS, assistant: { ...DEFAULT_PREFS.assistant } });
  assert.equal(state.prefs.scope, 'all');
  assert.equal(state.prefs.placement, 'mirror');
  assert.equal(state.prefs.parentName, 'AI chats');
  assert.deepEqual(state.counts, { created: 0, updated: 0, removed: 0 });
  assert.deepEqual(state.collections, {});
});

test('every field is coerced; impossible combinations fall back', () => {
  const state = normalizeThreadkeeperState({
    status: 'paired', extensionId: 'not-an-id', configured: true, tk: { version: 'x'.repeat(99), capabilities: ['sync', 'root'] },
    prefs: { scope: 'everything', projects: ['A', 'a', 7], providers: ['chatgpt', 'Bad Id'], transcripts: 'no', parentName: '  ', onRemoved: 'burn',
      assistant: { context: 'sometimes', search: false } },
    counts: { created: -5, updated: 'x' }, collections: { alpha: 'collection_1', __proto__: 'x', bad: 'has spaces' }, epoch: 'short',
  });
  assert.equal(state.status, 'off', 'paired needs a valid id');
  assert.equal(state.configured, false);
  assert.equal(state.tk.version.length, 40);
  assert.deepEqual(state.tk.capabilities, ['sync']);
  assert.equal(state.prefs.scope, 'all');
  assert.deepEqual(state.prefs.projects, ['A']);
  assert.deepEqual(state.prefs.providers, ['chatgpt']);
  assert.equal(state.prefs.transcripts, true);
  assert.equal(state.prefs.parentName, 'AI chats');
  assert.equal(state.prefs.onRemoved, 'keep');
  assert.deepEqual(state.prefs.assistant, { search: false, context: 'auto', decision: true });
  assert.deepEqual(state.counts, { created: 0, updated: 0, removed: 0 });
  assert.deepEqual(state.collections, { alpha: 'collection_1' });
  assert.equal(state.epoch, '');
});

test('pending requests expire after ten minutes', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const state = normalizeThreadkeeperState({ status: 'pending', extensionId: TK, pending: { requestId: 'r', extensionId: TK, at, code: '123456' } });
  assert.equal(state.status, 'pending');
  assert.equal(state.pending.code, '123456');
  const start = Date.parse(at);
  assert.equal(pendingExpired(state, start + 9 * 60000), false);
  assert.equal(expirePending(state, start + 9 * 60000).status, 'pending');
  assert.deepEqual([expirePending(state, start + 11 * 60000).status, expirePending(state, start + 11 * 60000).pending], ['off', null]);
  assert.equal(normalizeThreadkeeperState({ status: 'pending', extensionId: TK, pending: { requestId: 'r' } }).status, 'off', 'a broken pending request is dropped');
  assert.equal(publicState(state, { now: start + 11 * 60000 }).status, 'off');
});

test('publicState is a copy without placement memory', () => {
  const raw = { status: 'paired', extensionId: TK, collections: { a: 'c1' }, retry: { attempts: 2 } };
  const view = publicState(raw);
  assert.equal(view.status, 'paired');
  assert.equal(view.available, true);
  assert.equal('collections' in view, false);
  assert.equal('retry' in view, false);
  view.prefs.scope = 'manual';
  assert.equal(normalizeThreadkeeperState(raw).prefs.scope, 'all');
  assert.equal(publicState(raw, { available: false }).available, false);
});

test('patchPrefs accepts known keys and explains bad input', () => {
  const prefs = patchPrefs(DEFAULT_PREFS, { scope: 'projects', projects: ['Alpha', 'alpha', 'Beta'], assistant: { context: 'off' }, topicsAsTags: true });
  assert.equal(prefs.scope, 'projects');
  assert.deepEqual(prefs.projects, ['Alpha', 'Beta']);
  assert.deepEqual(prefs.assistant, { search: true, context: 'off', decision: true });
  assert.equal(prefs.topicsAsTags, true);
  assert.equal(DEFAULT_PREFS.scope, 'all', 'pure');
  assert.throws(() => patchPrefs(DEFAULT_PREFS, { scope: 'some' }), /Choose what to sync/);
  assert.throws(() => patchPrefs(DEFAULT_PREFS, { evil: true }), /not a Threadkeeper setting/);
  assert.throws(() => patchPrefs(DEFAULT_PREFS, { transcripts: 'yes' }), /on or off/);
  assert.throws(() => patchPrefs(DEFAULT_PREFS, { parentName: '   ' }), /name/);
  assert.throws(() => patchPrefs(DEFAULT_PREFS, { parentName: 'x'.repeat(90) }), /80/);
  assert.throws(() => patchPrefs(DEFAULT_PREFS, { providers: ['Chat GPT'] }), /providers/);
  assert.throws(() => patchPrefs(DEFAULT_PREFS, { assistant: { model: 'x' } }), /assistant setting/);
  assert.throws(() => patchPrefs(DEFAULT_PREFS, { singleCollectionId: 'has space' }), /collection/);
  assert.throws(() => patchPrefs(DEFAULT_PREFS, null), /Choose a setting/);
  assert.equal(patchPrefs(DEFAULT_PREFS, { singleCollectionId: '' }).singleCollectionId, '');
});

test('only scope, projects, providers, transcripts and autoUpdate reach Threadkeeper', () => {
  assert.deepEqual(syncPrefsOf(DEFAULT_PREFS), { scope: 'all', projects: [], providers: [], transcripts: true, autoUpdate: true });
  assert.equal(syncPrefsChanged(DEFAULT_PREFS, patchPrefs(DEFAULT_PREFS, { placement: 'inbox', topicsAsTags: true })), false);
  assert.equal(syncPrefsChanged(DEFAULT_PREFS, patchPrefs(DEFAULT_PREFS, { transcripts: false })), true);
});

test('the state store writes normalized state and skips no-op writes', async () => {
  const area = memoryArea();
  let writes = 0;
  const counting = { ...area, write: async (key, value) => { writes++; return area.write(key, value); } };
  const store = createThreadkeeperStateStore({ area: counting, locks: null });
  assert.equal((await store.read()).status, 'off');
  const next = await store.update(draft => { draft.status = 'pending'; draft.extensionId = TK; draft.pending = { requestId: 'r', extensionId: TK, at: new Date().toISOString(), code: '000123' }; });
  assert.equal(next.status, 'pending');
  assert.equal(writes, 1);
  await store.update(() => {});
  assert.equal(writes, 1, 'unchanged state is not written');
  assert.equal((await area.read(STATE_KEY)).pending.code, '000123');
  await Promise.all([store.update(draft => { draft.counts.created += 1; }), store.update(draft => { draft.counts.created += 1; })]);
  assert.equal((await store.read()).counts.created, 2, 'updates are serialized');
});

test('the link state is device bookkeeping: snapshots neither copy nor restore it', () => {
  assert.ok(SNAPSHOT_EXCLUDED_KEYS.includes(STATE_KEY));
  assert.equal(isSnapshotKey(STATE_KEY), false);
});
