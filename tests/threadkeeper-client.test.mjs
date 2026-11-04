import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getThreadkeeperState, onThreadkeeperChange, discoverThreadkeeper, connectThreadkeeper, threadkeeperRequest, importThreadkeeperThreads,
  refreshChat, loadTranscriptWindow, isThreadkeeperReady, hasThreadkeeperCapability, setThreadkeeperPrefs, disconnectThreadkeeper,
} from '../extension/lib/threadkeeper/client.js';
import { ThreadkeeperError } from '../extension/lib/threadkeeper/protocol.js';

const TK = 'abcdefghijklmnopabcdefghijklmnop';
const events = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); }, removeListener(listener) { this.listeners = this.listeners.filter(l => l !== listener); } });

test('outside the extension everything is calm: an "off" state and unavailable errors', async () => {
  delete globalThis.chrome;
  const state = await getThreadkeeperState();
  assert.deepEqual([state.status, state.available, state.prefs.scope], ['off', false, 'all']);
  assert.equal(typeof onThreadkeeperChange(() => {}), 'function');
  for (const call of [() => connectThreadkeeper(TK), () => threadkeeperRequest('facets'), () => discoverThreadkeeper(), () => refreshChat('x')]) {
    await assert.rejects(call(), error => error instanceof ThreadkeeperError && error.code === 'unavailable' && /extension/.test(error.message));
  }
  assert.equal(isThreadkeeperReady(state), false);
});

test('in the extension: state from storage, ops through the worker, codes kept, discovery drops the grant', async () => {
  const sent = [];
  const removed = [];
  const changed = events();
  const stored = { 'still.threadkeeper.v1': { status: 'paired', extensionId: TK, tk: { capabilities: ['search'] }, collections: { a: 'c' } } };
  globalThis.chrome = {
    runtime: {
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sendMessage: async message => {
        sent.push(message);
        if (message.args?.type === 'facets') return { ok: true, result: { ok: false, error: { code: 'disabled', message: 'Search is off.' } } };
        if (message.op === 'boom') return { ok: false, error: 'Unknown Still request.' };
        return { ok: true, result: { ok: true, data: { echoed: message.op } } };
      },
    },
    storage: { local: { get: async key => ({ [key]: stored[key] }) }, onChanged: changed },
    management: { getAll: async () => [
      { id: TK, name: 'Threadkeeper', version: '1.2', enabled: true, type: 'extension', installType: 'development' },
      { id: 'ponmlkjihgfedcbaponmlkjihgfedcba', name: 'Threadkeeper (old)', version: '0.9', enabled: false, type: 'extension' },
      { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Other tool', enabled: true, type: 'extension' },
      { id: 'cccccccccccccccccccccccccccccccc', name: 'Threadkeeper theme', enabled: true, type: 'theme' },
    ] },
    permissions: { remove: async request => { removed.push(request); return true; } },
  };
  const state = await getThreadkeeperState();
  assert.deepEqual([state.status, state.available, 'collections' in state], ['paired', true, false]);
  assert.equal(hasThreadkeeperCapability(state, 'search'), true);
  assert.equal(hasThreadkeeperCapability(state, 'context'), false);
  const seen = [];
  const stop = onThreadkeeperChange(next => seen.push(next.status));
  changed.listeners[0]({ 'still.threadkeeper.v1': { newValue: { status: 'revoked', extensionId: TK } } }, 'local');
  changed.listeners[0]({ other: {} }, 'local');
  stop();
  assert.deepEqual(seen, ['revoked']);
  assert.equal(changed.listeners.length, 0);

  const found = await discoverThreadkeeper();
  assert.deepEqual(found.map(entry => [entry.id, entry.enabled]), [[TK, true], ['ponmlkjihgfedcbaponmlkjihgfedcba', false]]);
  assert.deepEqual(removed, [{ permissions: ['management'] }]);

  assert.deepEqual(await connectThreadkeeper(TK), { echoed: 'connect' });
  assert.deepEqual(sent.at(-1), { type: 'still:threadkeeper', op: 'connect', args: { extensionId: TK } });
  await importThreadkeeperThreads(['k1'], { target: { collectionId: 'c1' } });
  assert.deepEqual(sent.at(-1).args, { threadKeys: ['k1'], citeIds: [], target: { collectionId: 'c1' }, origin: 'manual' });
  await loadTranscriptWindow('chat_tk_x', 5, 50);
  assert.deepEqual(sent.at(-1).args, { id: 'chat_tk_x', from: 5, count: 50 });
  await setThreadkeeperPrefs({ scope: 'manual' });
  assert.deepEqual(sent.at(-1).args, { patch: { scope: 'manual' } });
  await disconnectThreadkeeper({ removeChats: 'yes' });
  assert.deepEqual(sent.at(-1).args, { removeChats: false });
  await assert.rejects(threadkeeperRequest('facets'), error => error.code === 'disabled' && error.message === 'Search is off.');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(threadkeeperRequest('threads.search', { query: 'x' }, { signal: controller.signal }), error => error.code === 'aborted');
  delete globalThis.chrome.management;
  await assert.rejects(discoverThreadkeeper(), error => error.code === 'no_permission');
  delete globalThis.chrome;
});

test('a backup’s AI chat data goes to the worker in chunks; the page never writes the chat store itself', async () => {
  const { importChatBackupInWorker, canUseWorker } = await import('../extension/lib/threadkeeper/client.js');
  const sent = [];
  globalThis.chrome = {
    runtime: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sendMessage: async message => {
      sent.push(message);
      const { part } = message.args;
      return { ok: true, result: { ok: true, data: { records: part.records.length, transcripts: part.transcripts.length } } };
    } },
    storage: { local: { get: async () => ({}) }, onChanged: events() },
  };
  assert.equal(canUseWorker(), true);
  const big = 'x'.repeat(5 * 1024 * 1024);
  const id = n => `chat_tk_${String(n).repeat(32).slice(0, 32)}`;
  const part = { version: 1, records: [1, 2, 3].map(n => ({ id: id(n), threadKey: `k${n}`, thread: { gist: big } })),
    transcripts: [{ id: id(2), threadKey: 'k2', revision: 1, messages: [] }] };
  const result = await importChatBackupInWorker(part, { ids: [id(1), id(2), id(3)] });
  assert.deepEqual(result, { records: 3, transcripts: 1 });
  assert.equal(sent.length, 3, 'about 8 MB per message');
  assert.ok(sent.every(message => message.type === 'still:threadkeeper' && message.op === 'importChatBackup' && message.args.part.version === 1));
  assert.deepEqual(sent[1].args.part.transcripts.map(row => row.id), [id(2)], 'each transcript travels with its record');
  delete globalThis.chrome;
  assert.equal(canUseWorker(), false);
});
