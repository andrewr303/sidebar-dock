import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFullBackup, importPortableFile, serializeBackup, exportItemsCsv, exportBookmarkHtml, exportNotesMarkdown,
} from '../extension/lib/portability.js';
import { createLibraryStore } from '../extension/lib/store.js';
import { createChatDataStore } from '../extension/lib/chat-data.js';
import { chatItemId } from '../extension/lib/threadkeeper/protocol.js';

const KEY = 'chatgpt:acct_chatgpt_primary:ws_personal:abc:main';
const KEY2 = 'claude_code:acct_claude_code_primary:ws_personal:5f0c-ü/x y:main';
const ID = chatItemId(KEY), ID2 = chatItemId(KEY2);
const isolated = { dashboard: null, conversations: null, aiConfig: null, snapshot: null, deviceId: null, extensionVersion: '1.0.0' };

function device(seed = { schemaVersion: 1, items: [], collections: [], settings: {} }) {
  let library = structuredClone(seed);
  const core = createLibraryStore({ read: async () => library, write: async value => { library = value; } });
  return {
    get library() { return library; },
    call: (name, ...args) => core.dispatch(name, args),
    store: {
      exportLibrary: () => core.dispatch('exportLibrary'), importLibrary: (value, options) => core.dispatch('importLibrary', [value, options]),
      bulkUpdateItems: changes => core.dispatch('bulkUpdateItems', [changes]),
      async getAttachment() { return null; }, async saveAttachment() { throw new Error('no files here'); }, async deleteAttachment() {},
    },
  };
}
const jsonFile = value => new File([typeof value === 'string' ? value : JSON.stringify(value)], 'still-backup.json', { type: 'application/json' });
const message = (index, content, role = index % 2 ? 'assistant' : 'user') => ({ index, role, content, createdAt: null });
const thread = (threadKey, overrides = {}) => ({ threadKey, title: 'Thread', gist: 'Gist', provider: 'chatgpt', providerLabel: 'ChatGPT', seq: 4, revision: 2, fingerprint: 'fp',
  updatedAt: '2026-10-02T00:00:00.000Z', analysis: { gist: 'Gist', topics: ['x'] }, ...overrides });
const entry = (threadKey, title) => ({ threadKey, fingerprint: 'fp', seq: 4, origin: 'sync', item: { title, excerpt: 'Gist', sourceUrl: 'https://chatgpt.com/c/abc', siteName: 'ChatGPT' },
  chat: { provider: 'chatgpt', providerLabel: 'ChatGPT', project: 'Travel', messageCount: 3, revision: 2, hasTranscript: true } });

async function chatDevice() {
  const source = device();
  await source.call('upsertChats', [entry(KEY, 'Lisbon trip'), entry(KEY2, 'Store refactor')]);
  await source.call('updateItem', ID, { content: 'My packing list' });
  const chats = createChatDataStore({ indexedDB: null });
  await chats.put(ID, { thread: thread(KEY), transcript: { included: true, revision: 2, totalMessages: 2, messages: [message(0, 'Plan Lisbon'), message(1, 'Here is a plan')] } });
  await chats.put(ID2, { thread: thread(KEY2), transcript: { included: true, revision: 2, totalMessages: 1, messages: [message(0, 'x'.repeat(20000))] } });
  // Data for a chat that is not in the library is never exported.
  await chats.put(chatItemId('k:gone:1:2:3'), { thread: thread('k:gone:1:2:3') });
  return { source, chats };
}

test('a full backup carries chat items, their summaries and transcripts, and restores them', async () => {
  const { source, chats } = await chatDevice();
  const backup = await createFullBackup(source.store, { ...isolated, chatData: chats });
  assert.equal(backup.manifest.counts.chats, 2);
  assert.deepEqual(backup.manifest.warnings, []);
  assert.equal(backup.chats.version, 1);
  assert.deepEqual(backup.chats.records.map(r => r.id).sort(), [ID, ID2].sort());
  assert.deepEqual(backup.chats.transcripts.map(r => r.id).sort(), [ID, ID2].sort());
  assert.ok(backup.chats.records.every(record => !('transcriptMeta' in record)));
  const text = serializeBackup(backup).text;

  const target = device();
  const targetChats = createChatDataStore({ indexedDB: null });
  const result = await importPortableFile(jsonFile(text), target.store, { ...isolated, chatData: targetChats });
  assert.deepEqual(result.chats, { records: 2, transcripts: 2 });
  const item = target.library.items.find(i => i.id === ID);
  assert.equal(item.type, 'chat');
  assert.equal(item.content, 'My packing list');
  assert.equal(item.chat.threadKey, KEY);
  assert.equal((await targetChats.get(ID)).thread.analysis.topics[0], 'x');
  assert.deepEqual((await targetChats.getTranscript(ID)).messages.map(m => m.content), ['Plan Lisbon', 'Here is a plan']);
  assert.equal((await targetChats.get(ID)).transcript.stored, 2);
});

test('transcripts are the first thing left out when the backup runs out of room', async () => {
  const { source, chats } = await chatDevice();
  const small = await createFullBackup(source.store, { ...isolated, chatData: chats, maxBytes: 300 * 1024 });
  assert.deepEqual(small.chats.records.length, 2);
  const full = await createFullBackup(source.store, { ...isolated, chatData: chats });
  const roomForOne = serializeBackup(full).bytes - 15000;
  const partial = await createFullBackup(source.store, { ...isolated, chatData: chats, maxBytes: roomForOne });
  assert.deepEqual(partial.chats.transcripts.map(r => r.id), [ID], 'the smallest transcript fits');
  assert.equal(partial.chats.records.find(r => r.id === ID2).transcript, null);
  assert.match(partial.manifest.warnings.join(' '), /1 AI chat transcript did not fit/);
  // Restoring it keeps this device's own transcript of the same revision for the chat whose transcript was left out.
  const target = device();
  const targetChats = createChatDataStore({ indexedDB: null });
  await targetChats.put(ID2, { thread: thread(KEY2, { seq: 3 }), transcript: { included: true, revision: 2, totalMessages: 1, messages: [message(0, 'local copy')] } });
  await importPortableFile(jsonFile(serializeBackup(partial).text), target.store, { ...isolated, chatData: targetChats });
  assert.equal((await targetChats.getTranscript(ID2)).messages[0].content, 'local copy');
  assert.equal((await targetChats.get(ID2)).transcript.revision, 2);
});

test('a library without chats has no chats part; an older backup restores chats without their data', async () => {
  const plain = device();
  await plain.call('saveItem', { type: 'note', title: 'N' });
  const backup = await createFullBackup(plain.store, { ...isolated, chatData: createChatDataStore({ indexedDB: null }) });
  assert.equal(backup.chats, undefined);
  assert.equal(backup.manifest.counts.chats, 0);
  const { source } = await chatDevice();
  const older = await createFullBackup(source.store, { ...isolated, chatData: null });
  assert.equal(older.chats, undefined);
  const target = device();
  const targetChats = createChatDataStore({ indexedDB: null });
  const result = await importPortableFile(jsonFile(older), target.store, { ...isolated, chatData: targetChats });
  assert.equal(result.chats, undefined);
  assert.equal(target.library.items.filter(i => i.type === 'chat').length, 2);
  assert.equal(await targetChats.get(ID), null);
});

test('restore refuses forged chats and chat data before writing anything', async () => {
  const { source, chats } = await chatDevice();
  const backup = await createFullBackup(source.store, { ...isolated, chatData: chats });
  const cases = [
    [b => { b.items[0].chat.threadKey = 'other:key:a:b:c'; }, /A chat needs its Threadkeeper thread/],
    [b => { delete b.items[0].chat; }, /A chat needs its Threadkeeper thread/],
    [b => { b.chats.records.push({ ...b.chats.records[0], id: chatItemId('k:x:1:2:3'), threadKey: 'k:x:1:2:3' }); }, /no saved chat/],
    [b => { b.chats.transcripts[0].messages[0].role = 'system-override'; }, /invalid message/],
    [b => { b.chats.version = 9; }, /not in a form/],
  ];
  for (const [mutate, error] of cases) {
    const copy = structuredClone(backup);
    mutate(copy);
    const target = device();
    const targetChats = createChatDataStore({ indexedDB: null });
    await assert.rejects(importPortableFile(jsonFile(copy), target.store, { ...isolated, chatData: targetChats }), error);
    assert.equal(target.library.items.length, 0, 'nothing was written');
    assert.deepEqual(await targetChats.ids(), []);
  }
});

test('export repairs nothing it cannot: a chat without its thread is left out with a warning', async () => {
  const { source, chats } = await chatDevice();
  const broken = device({ ...source.library, items: source.library.items.map(item => item.id === ID2 ? { ...item, chat: { threadKey: '' } } : item) });
  const backup = await createFullBackup({ ...broken.store, exportLibrary: async () => broken.library }, { ...isolated, chatData: chats });
  assert.deepEqual(backup.items.map(i => i.id), [ID]);
  assert.match(backup.manifest.warnings.join(' '), /Left out 1 damaged item/);
  assert.deepEqual(backup.chats.records.map(r => r.id), [ID]);
});

test('chats only merge when the backup copy is newer; a chat kept here keeps its own data', async () => {
  const { source, chats } = await chatDevice();
  const backup = await createFullBackup(source.store, { ...isolated, chatData: chats });
  const target = device(structuredClone(source.library));
  await target.call('updateItem', ID, { title: 'Edited here later' });
  const targetChats = createChatDataStore({ indexedDB: null });
  await targetChats.put(ID, { thread: thread(KEY, { fingerprint: 'mine', seq: 1 }) });
  const result = await importPortableFile(jsonFile(backup), target.store, { ...isolated, chatData: targetChats });
  assert.deepEqual(result.chats, { records: 0, transcripts: 0 }, 'both chats here are as new or newer');
  assert.equal((await targetChats.get(ID)).fingerprint, 'mine', 'the merge kept the local chat, so its data stays');
});

test('CSV, bookmark HTML and notes Markdown treat chats as conversations, not links', async () => {
  const { source } = await chatDevice();
  const library = source.library;
  const csv = exportItemsCsv(library);
  assert.match(csv, /https:\/\/chatgpt\.com\/c\/abc,Lisbon trip,,My packing list,Gist,chat/);
  const target = device();
  const result = await importPortableFile(new File([csv], 'items.csv', { type: 'text/csv' }), target.store, isolated);
  assert.equal(result.items, 2);
  assert.ok(target.library.items.every(item => item.type === 'bookmark'), 'a chat row comes back as a bookmark to the conversation');
  // A chat row without a link is skipped.
  const bare = 'url,title,type\r\n,Orphan chat,chat\r\n';
  const skipped = await importPortableFile(new File([bare], 'x.csv', { type: 'text/csv' }), device().store, isolated);
  assert.equal(skipped.items, 0);
  const html = exportBookmarkHtml(library);
  assert.ok(!html.includes('Lisbon trip'));
  const markdown = exportNotesMarkdown(library);
  assert.match(markdown, /## Lisbon trip\n\n_AI chat · ChatGPT · project Travel · 3 messages_\n\nOriginal conversation: <https:\/\/chatgpt\.com\/c\/abc>\n\nMy packing list/);
  assert.ok(!markdown.includes('Store refactor'), 'a chat without notes is not a notes section');
});
