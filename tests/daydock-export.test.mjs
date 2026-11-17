import test from 'node:test';
import assert from 'node:assert/strict';
import { createDayDockExport, countLeftBehind, summarizeDayDockExport, dayDockExportFileName, DAYDOCK_IMPORT_URL } from '../extension/lib/daydock-export.js';
import { importPortableFile, serializeBackup, BACKUP_VERSION } from '../extension/lib/portability.js';
import { createLibraryStore } from '../extension/lib/store.js';
import { createConversationStore, createMemoryStorage } from '../extension/lib/ai/conversations.js';
import { createChatDataStore } from '../extension/lib/chat-data.js';
import { createDashboardStore, portableDashboard, mergeDashboards } from '../extension/lib/dashboard-store.js';
import { chatItemId } from '../extension/lib/threadkeeper/protocol.js';
import { matchSections } from '../extension/ui/settings/catalog.js';
import { rankCommands, COMMANDS } from '../extension/ui/command.js';

// One device: a library store over memory and an attachment map (as in backup-v2.test.mjs). null starts with no stored
// library, so loadLibrary(seed) stores the seed the way a first run does.
function device(seed = { schemaVersion: 1, items: [], collections: [], settings: {} }) {
  let library = seed ? structuredClone(seed) : undefined, seq = 0;
  const files = new Map();
  const core = createLibraryStore({ read: async () => library, write: async value => { library = value; } });
  return {
    files,
    get library() { return library; },
    call: (name, ...args) => core.dispatch(name, args),
    store: {
      exportLibrary: () => core.dispatch('exportLibrary'),
      importLibrary: (value, options) => core.dispatch('importLibrary', [value, options]),
      bulkUpdateItems: changes => core.dispatch('bulkUpdateItems', [changes]),
      async getAttachment(id) { return files.get(id); },
      async saveAttachment(file) {
        const attachmentId = `file_${++seq}`;
        files.set(attachmentId, { id: attachmentId, blob: file, name: file.name, mime: file.type, size: file.size });
        return { attachmentId, fileName: file.name, mime: file.type, size: file.size };
      },
      async deleteAttachment(id) { files.delete(id); },
    },
  };
}
const blob = (text, type = 'application/octet-stream') => new Blob([text], { type });
const put = (target, id, value, name = 'file.bin') => target.files.set(id, { id, blob: value, name, mime: value.type, size: value.size });
const jsonFile = (value, name = 'still-for-daydock.json') => new File([typeof value === 'string' ? value : JSON.stringify(value)], name, { type: 'application/json' });
const bytesOf = async value => [...new Uint8Array(await value.arrayBuffer())];

function dashboardSource(initial) {
  let stored = structuredClone(initial);
  const store = createDashboardStore({ read: async () => stored, write: async value => { stored = structuredClone(value); }, locks: null });
  return {
    exportDashboard: async () => portableDashboard(await store.load()),
    async importDashboard(incoming) { const { state, boards } = mergeDashboards(await store.load(), incoming); await store.replace(state, { persist: true }); return { boards }; },
    get stored() { return stored; },
  };
}
function aiSource(state = { version: 2, settings: {}, connections: [] }) {
  const calls = [];
  return { calls, async exportAiConfig() { return structuredClone(state); }, async importAiConfig(data) { calls.push(data); return { connectionsAdded: 0 }; } };
}

const KEY = 'chatgpt:acct_chatgpt_primary:ws_personal:abc:main';
const CHAT = chatItemId(KEY);
const PDF = '%PDF-1.7 sample bytes';
const SECRETS = ['sk-setting-secret', 'nested-bridge-secret', 'widget-token-secret', 'widget-nested-password', 'sk-ant-connection-key'];

// The known fixture: 5 saves (one of them a Threadkeeper chat, one in Trash), 2 notes (one in Trash), 2 collections,
// 3 highlights, 2 boards with 3 widgets, 1 item file of 21 bytes plus the wallpaper, and 2 tombstones once 'gone' and
// 'old' are deleted forever.
const fixtureLibrary = () => ({ schemaVersion: 1,
  collections: [{ id: 'reading', name: 'Reading', updatedAt: '2026-09-01T00:00:00.000Z' }, { id: 'deep', name: 'Deeper', parentId: 'reading', updatedAt: '2026-09-01T00:00:00.000Z' },
    { id: 'old', name: 'Old' }],
  settings: { theme: 'dark', apiKey: 'sk-setting-secret', nested: { bridgeToken: 'nested-bridge-secret', density: 'compact' }, wallpaper: { kind: 'image', attachmentId: 'file_wall', dim: 20 } },
  items: [
    { id: 'gone', type: 'bookmark', title: 'Deleted forever', url: 'https://example.com/gone', deletedAt: '2026-08-01T00:00:00.000Z' },
    { id: 'a', type: 'bookmark', title: 'Alpha', url: 'https://example.com/a', collectionId: 'deep', tags: ['design', 'ideas'], content: 'My note on Alpha', updatedAt: '2026-09-02T00:00:00.000Z',
      highlights: [{ id: 'h1', text: 'First passage', color: 'yellow', note: 'why it matters', createdAt: '2026-09-02T00:00:00.000Z' }, { id: 'h2', text: 'Second passage', color: 'blue', createdAt: '2026-09-02T00:00:00.000Z' }] },
    { id: 'art', type: 'article', title: 'Long read', url: 'https://example.com/long', articleContent: '# Long read\n\nBody', updatedAt: '2026-09-02T00:00:00.000Z',
      highlights: [{ id: 'h3', text: 'Third passage', color: 'green', createdAt: '2026-09-02T00:00:00.000Z' }] },
    { id: 'doc', type: 'file', title: 'Paper', attachmentId: 'file_doc', fileName: 'paper.pdf', mime: 'application/pdf', size: PDF.length, updatedAt: '2026-09-02T00:00:00.000Z' },
    { id: 'binned', type: 'bookmark', title: 'In Trash', url: 'https://example.com/binned', deletedAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z' },
    { id: 'n', type: 'note', title: 'Thoughts', content: '- [ ] One\n- [x] Two', collectionId: 'reading', updatedAt: '2026-09-02T00:00:00.000Z' },
    { id: 'n-old', type: 'note', title: 'Old draft', content: 'Draft', deletedAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z' },
  ] });
const fixtureDashboard = () => ({ activeBoardId: 'main', updatedAt: '2026-09-02T00:00:00.000Z', boards: [
  { id: 'main', name: 'Main', widgets: [
    { id: 'w_links', type: 'links-folder', x: 0, y: 0, w: 4, h: 3, config: { collectionId: 'reading', token: 'widget-token-secret' } },
    { id: 'w_check', type: 'checklist', x: 4, y: 0, w: 4, h: 3, config: { source: 'note', noteId: 'n', account: { password: 'widget-nested-password', login: 'me' } } }] },
  { id: 'work', name: 'Work', widgets: [{ id: 'w_clock', type: 'clock', x: 0, y: 0, w: 3, h: 2, config: { style: 'digital' } }] }] });
const conversation = { id: 'conversation_1', title: 'Links', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
  messages: [{ id: 'm1', role: 'user', text: 'Save these links', createdAt: '2026-10-01T00:00:00.000Z' }] };

async function sourceDevice() {
  const source = device(null);
  await source.call('loadLibrary', fixtureLibrary());
  await source.call('permanentlyDeleteItem', 'gone');
  await source.call('deleteCollection', 'old');
  await source.call('upsertChats', [{ threadKey: KEY, fingerprint: 'fp', seq: 4, origin: 'sync', item: { title: 'Lisbon trip', excerpt: 'Gist', sourceUrl: 'https://chatgpt.com/c/abc' },
    chat: { provider: 'chatgpt', providerLabel: 'ChatGPT', messageCount: 2, revision: 2, hasTranscript: true } }]);
  put(source, 'file_doc', blob(PDF, 'application/pdf'), 'paper.pdf');
  put(source, 'file_wall', blob('wallpaper-bytes', 'image/png'), 'wall.png');
  const conversations = createConversationStore({ storage: createMemoryStorage() });
  await conversations.saveConversation(conversation);
  const chatData = createChatDataStore({ indexedDB: null });
  await chatData.put(CHAT, { thread: { threadKey: KEY, title: 'Lisbon trip', seq: 4, revision: 2, fingerprint: 'fp', updatedAt: '2026-10-02T00:00:00.000Z' },
    transcript: { included: true, revision: 2, totalMessages: 1, messages: [{ index: 0, role: 'user', content: 'Plan Lisbon', createdAt: null }] } });
  const aiConfig = aiSource({ version: 2, settings: {}, connections: [{ id: 'conn_1', providerId: 'anthropic', label: 'Work', apiKey: 'sk-ant-connection-key' }] });
  // Every source a full backup would read is offered; the export must leave the three AI parts out anyway.
  const options = { dashboard: dashboardSource(fixtureDashboard()), conversations, aiConfig, chatData, deviceId: 'device-1', extensionVersion: '0.5.0' };
  return { source, options };
}

test('the export for DayDock is a version 2 backup with the DayDock marker and without chats, AI setup or secrets', async () => {
  const { source, options } = await sourceDevice();
  const backup = await createDayDockExport(source.store, options);
  assert.equal(backup.backupVersion, BACKUP_VERSION);
  assert.equal(backup.schemaVersion, 1);
  assert.deepEqual(Object.keys(backup).slice(0, 5), ['backupVersion', 'schemaVersion', 'exportedAt', 'manifest', 'daydock']);
  assert.deepEqual(backup.daydock, { exportVersion: 1, exportedFor: 'daydock', source: 'still-extension' });
  for (const part of ['conversations', 'aiConfig', 'chats']) assert.ok(!(part in backup), `${part} is never in the file`);
  assert.deepEqual(backup.manifest, { app: 'still', extensionVersion: '0.5.0', deviceId: 'device-1', warnings: [],
    counts: { items: 7, collections: 2, notes: 2, attachments: 2, boards: 2, conversations: 0, aiConnections: 0, chats: 1 } });

  const { text } = serializeBackup(backup);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), secret);
  for (const word of ['Save these links', 'Plan Lisbon', 'conn_1']) assert.ok(!text.includes(word), `${word} stays in the extension`);
  assert.deepEqual(backup.settings, { theme: 'dark', nested: { density: 'compact' }, wallpaper: { kind: 'image', attachmentId: 'file_wall', dim: 20 } });
  assert.deepEqual(backup.dashboard.boards[0].widgets.map(widget => widget.config), [{ collectionId: 'reading' }, { source: 'note', noteId: 'n', account: { login: 'me' } }]);

  // Trash is an item's deletedAt; items deleted forever travel as tombstones.
  assert.deepEqual(backup.items.filter(item => item.deletedAt).map(item => [item.id, item.deletedAt]), [['binned', '2026-09-03T00:00:00.000Z'], ['n-old', '2026-09-03T00:00:00.000Z']]);
  assert.deepEqual(backup.tombstones.map(({ deletedAt, ...tombstone }) => tombstone), [{ kind: 'item', id: 'gone' }, { kind: 'collection', id: 'old' }]);
  assert.ok(backup.tombstones.every(tombstone => Number.isFinite(Date.parse(tombstone.deletedAt))));
  assert.ok(!backup.items.some(item => item.id === 'gone') && !backup.collections.some(collection => collection.id === 'old'));
  assert.equal(backup.items.find(item => item.id === CHAT).chat.threadKey, KEY, 'a chat travels as an item, without its transcript');
  assert.deepEqual(backup.attachments.map(({ data, ...entry }) => entry), [{ id: 'file_wall', name: 'wall.png', mime: 'image/png', ref: 'wallpaper' }, { id: 'file_doc', name: 'paper.pdf', mime: 'application/pdf' }]);
  assert.equal(backup.attachments[1].data, `data:application/pdf;base64,${Buffer.from(PDF).toString('base64')}`);
});

test('Still restores the export like any backup: the extra top-level key is ignored and everything comes back identical', async () => {
  const { source, options } = await sourceDevice();
  const backup = await createDayDockExport(source.store, options);
  const target = device();
  const targetDashboard = dashboardSource({ activeBoardId: 'home', updatedAt: '2026-01-01T00:00:00.000Z', boards: [{ id: 'home', name: 'Home', widgets: [] }] });
  const targetChats = createConversationStore({ storage: createMemoryStorage() });
  const targetAi = aiSource();
  const result = await importPortableFile(jsonFile(serializeBackup(backup).text), target.store,
    { dashboard: targetDashboard, conversations: targetChats, aiConfig: targetAi, chatData: createChatDataStore({ indexedDB: null }), snapshot: null });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.library.items, { added: 7, updated: 0, kept: 0, tombstoned: 0 });
  assert.deepEqual(result.library.collections, { added: 2, updated: 0, kept: 0, tombstoned: 0 });
  assert.equal(result.files, 2);
  assert.equal(result.boards, 2);
  for (const part of ['conversations', 'aiConnections', 'chats']) assert.equal(result[part], undefined, `no ${part} to restore`);
  assert.equal(targetAi.calls.length, 0);
  assert.deepEqual((await targetChats.exportAll()).conversations, []);

  // Files get new ids on the device that restores them; everything else is the same record.
  const sent = await source.store.exportLibrary(), got = await target.store.exportLibrary();
  const withoutFile = ({ attachmentId, ...item }) => item;
  assert.deepEqual(got.items.map(withoutFile), sent.items.map(withoutFile));
  assert.deepEqual(got.collections, sent.collections);
  assert.deepEqual(got.items.find(item => item.id === 'a').highlights, sent.items.find(item => item.id === 'a').highlights);
  assert.equal(got.items.flatMap(item => item.highlights).length, 3);
  assert.deepEqual(got.items.filter(item => item.deletedAt).map(item => item.id), ['binned', 'n-old'], 'Trash stays Trash');
  const mine = target.files.get(got.items.find(item => item.id === 'doc').attachmentId), theirs = source.files.get('file_doc');
  assert.deepEqual(await bytesOf(mine.blob), await bytesOf(theirs.blob));
  assert.deepEqual([mine.name, mine.mime, mine.size], ['paper.pdf', 'application/pdf', PDF.length]);
  assert.deepEqual(await bytesOf(target.files.get(got.settings.wallpaper.attachmentId).blob), await bytesOf(blob('wallpaper-bytes')));
  assert.deepEqual(targetDashboard.stored.boards.filter(board => board.id !== 'home'), backup.dashboard.boards);
  assert.deepEqual(backup.dashboard.boards, portableDashboard(fixtureDashboard()).boards);
});

test('the summary counts what the file holds and names what stays in the extension', async () => {
  const { source, options } = await sourceDevice();
  const backup = await createDayDockExport(source.store, options);
  const stays = await countLeftBehind(backup, options);
  assert.deepEqual(stays, { conversations: 1, aiConnections: 1, chatTranscripts: 1 });
  assert.deepEqual(summarizeDayDockExport(backup, stays), { saves: 5, notes: 2, collections: 2, highlights: 3, boards: 2, widgets: 3, files: 1, fileBytes: PDF.length, trash: 2, deleted: 2, warnings: [],
    left: ['1 assistant conversation', '1 AI connection', '1 AI chat transcript', 'settings and wallpaper', 'connected accounts and API keys'] });
  // Nothing to count (or sources turned off): the two fixed lines remain. A store that cannot be read keeps its line.
  assert.deepEqual(await countLeftBehind(backup, { conversations: null, aiConfig: null, chatData: null }), { conversations: 0, aiConnections: 0, chatTranscripts: 0 });
  assert.deepEqual(summarizeDayDockExport(backup).left, ['settings and wallpaper', 'connected accounts and API keys']);
  const broken = await countLeftBehind(backup, { ...options, conversations: { listConversations: async () => { throw new Error('blocked'); } } });
  assert.equal(broken.conversations, null);
  // Counting reads the index only: a store whose bodies cannot be loaded is still counted, and exportAll is never called.
  const indexOnly = await countLeftBehind(backup, { ...options, conversations: {
    listConversations: async () => [{ id: 'c1' }, { id: 'c2' }, null], exportAll: async () => { throw new Error('bodies were loaded'); } } });
  assert.equal(indexOnly.conversations, 2);
  assert.equal(summarizeDayDockExport(backup, broken).left[0], 'assistant conversations');
  // An empty library and a backup without a dashboard still summarize.
  const empty = await createDayDockExport(device().store, { dashboard: null, deviceId: null });
  assert.deepEqual(summarizeDayDockExport(empty), { saves: 0, notes: 0, collections: 0, highlights: 0, boards: 0, widgets: 0, files: 0, fileBytes: 0, trash: 0, deleted: 0, warnings: [],
    left: ['settings and wallpaper', 'connected accounts and API keys'] });
});

test('the file name carries the date, and the import page is DayDock\'s', () => {
  assert.equal(dayDockExportFileName(new Date('2026-11-13T23:59:59.000Z')), 'still-for-daydock-2026-11-13.json');
  assert.equal(dayDockExportFileName('2027-01-02T03:04:05.000Z'), 'still-for-daydock-2027-01-02.json');
  assert.match(dayDockExportFileName(), /^still-for-daydock-\d{4}-\d{2}-\d{2}\.json$/);
  assert.match(dayDockExportFileName('not a date'), /^still-for-daydock-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(DAYDOCK_IMPORT_URL, 'https://daydock.tech/library/import');
});

test('a library with a broken record or a lost file still exports, with warnings in the manifest and the summary', async () => {
  const source = device();
  source.store.exportLibrary = async () => ({ schemaVersion: 1, settings: {}, collections: [{ id: 'c', name: 'Kept' }, { id: 'bad id!', name: 'Broken' }], items: [
    { id: 'ok', type: 'bookmark', title: 'Fine', url: 'https://example.com/ok', collectionId: 'c' },
    { id: 'dates', type: 'bookmark', title: 'Odd dates', url: 'https://example.com/d', createdAt: 'yesterday-ish' },
    { id: 'lost', type: 'file', title: 'Lost file', attachmentId: 'file_gone', size: 10 },
    { id: 'broken', type: 'mystery', title: 'Written by a future build' },
  ] });
  const backup = await createDayDockExport(source.store, { dashboard: null, deviceId: null });
  assert.deepEqual(backup.items.map(item => item.id), ['ok', 'dates', 'lost']);
  const summary = summarizeDayDockExport(backup);
  assert.deepEqual(summary.warnings, backup.manifest.warnings);
  const warnings = summary.warnings.join(' ');
  assert.match(warnings, /Left out 1 damaged item that could not be restored \(“Written by a future build”\)/);
  assert.match(warnings, /Repaired 1 item/);
  assert.match(warnings, /Left out 1 damaged collection/);
  assert.match(warnings, /1 file could not be found/);
  assert.equal(summary.saves, 3);
  assert.equal(summary.files, 0);
  const result = await importPortableFile(jsonFile(serializeBackup(backup).text), device().store, { dashboard: null, snapshot: null });
  assert.equal(result.items, 3);
});

test('the backup\'s size limit applies: a file that does not fit is left out with a warning, and the rest still imports', async () => {
  const source = device({ schemaVersion: 1, collections: [], settings: {}, items: [
    { id: 'small', type: 'file', title: 'Small', attachmentId: 'file_small', size: 3000 },
    { id: 'big', type: 'file', title: 'Big', attachmentId: 'file_big', size: 30000 },
  ] });
  put(source, 'file_small', blob('s'.repeat(3000)), 'small.bin');
  put(source, 'file_big', blob('b'.repeat(30000)), 'big.bin');
  const maxBytes = 20000;
  const backup = await createDayDockExport(source.store, { dashboard: null, deviceId: null, maxBytes });
  const summary = summarizeDayDockExport(backup);
  assert.equal(summary.files, 1);
  assert.equal(summary.fileBytes, 3000);
  assert.match(summary.warnings.join(' '), /1 file did not fit/);
  assert.ok(serializeBackup(backup, { maxBytes }).bytes <= maxBytes);
  assert.throws(() => serializeBackup(backup, { maxBytes: 1000 }), /larger than/, 'a library too large for any file is refused, as for a backup');
  const target = device();
  const result = await importPortableFile(jsonFile(serializeBackup(backup, { maxBytes }).text), target.store, { dashboard: null, snapshot: null });
  assert.equal(result.files, 1);
  assert.match(target.library.items.find(item => item.id === 'big').attachmentId, /^missing_/);
});

test('Settings search and the command list find the export', () => {
  for (const query of ['daydock', 'migrate', 'move', 'transfer', 'export']) assert.ok(matchSections(query).some(section => section.id === 'library'), query);
  const found = rankCommands(COMMANDS, 'daydock', command => command.label)[0];
  assert.equal(found.id, 'daydock');
  assert.equal(found.label, 'Export for DayDock');
  assert.deepEqual([found.action, found.data], ['shell.settings', { section: 'library' }]);
});
