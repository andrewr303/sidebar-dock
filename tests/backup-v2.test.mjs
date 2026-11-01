import test from 'node:test';
import assert from 'node:assert/strict';
import { createFullBackup, importPortableFile, serializeBackup, BACKUP_VERSION } from '../extension/lib/portability.js';
import { createLibraryStore } from '../extension/lib/store.js';
import { createConversationStore, createMemoryStorage } from '../extension/lib/ai/conversations.js';
import { createDashboardStore, portableDashboard, mergeDashboards } from '../extension/lib/dashboard-store.js';

// One device: a library store over memory, an attachment map, and a log of writes in order.
function device(seed = { schemaVersion: 1, items: [], collections: [], settings: {} }) {
  let library = structuredClone(seed), seq = 0;
  const files = new Map(), log = [];
  const core = createLibraryStore({ read: async () => library, write: async value => { library = value; log.push('library'); } });
  return {
    files, log,
    get library() { return library; },
    store: {
      exportLibrary: () => core.dispatch('exportLibrary'),
      importLibrary: (value, options) => core.dispatch('importLibrary', [value, options]),
      updateItem: (id, patch) => core.dispatch('updateItem', [id, patch]),
      bulkUpdateItems: changes => core.dispatch('bulkUpdateItems', [changes]),
      async getAttachment(id) { return files.get(id); },
      async saveAttachment(file) {
        log.push('file');
        const attachmentId = `file_${++seq}`;
        files.set(attachmentId, { id: attachmentId, blob: file, name: file.name, mime: file.type, size: file.size });
        return { attachmentId, fileName: file.name, mime: file.type, size: file.size };
      },
      async deleteAttachment(id) { log.push(`delete:${id}`); files.delete(id); },
    },
  };
}
const blob = (text, type = 'application/octet-stream') => new Blob([text], { type });
const put = (target, id, value, name = 'file.bin') => target.files.set(id, { id, blob: value, name, mime: value.type, size: value.size });
const jsonFile = (value, name = 'still-backup.json') => new File([typeof value === 'string' ? value : JSON.stringify(value)], name, { type: 'application/json' });
const bytesOf = async value => new Uint8Array(await value.arrayBuffer());

function dashboardSource(initial) {
  let stored = structuredClone(initial);
  const store = createDashboardStore({ read: async () => stored, write: async value => { stored = structuredClone(value); }, locks: null });
  return {
    exportDashboard: async () => portableDashboard(await store.load()),
    async importDashboard(incoming) { const { state, boards } = mergeDashboards(await store.load(), incoming); await store.replace(state, { persist: true }); return { boards }; },
    get stored() { return stored; },
  };
}
// AI settings as connections.js would give them; this one leaks secret-named fields so the backup must strip them.
function aiSource(state = { version: 2, settings: {}, connections: [] }) {
  const calls = [];
  return {
    calls, state,
    async exportAiConfig() { return structuredClone(state); },
    async importAiConfig(data) {
      calls.push(structuredClone(data));
      const fresh = (data.connections || []).filter(entry => !state.connections.some(local => local.id === entry.id));
      state.connections.push(...fresh);
      return { connectionsAdded: fresh.length, settingsAdded: [] };
    },
  };
}
const snapshots = log => { const taken = []; return { taken, snapshot: async reason => { log.push(`snapshot:${reason}`); taken.push(reason); return { id: `snapshot_${taken.length}` }; } }; };

const sourceLibrary = () => ({ schemaVersion: 1, collections: [{ id: 'reading', name: 'Reading', updatedAt: '2026-09-01T00:00:00.000Z' }],
  settings: { theme: 'dark', accent: 'green', wallpaper: { kind: 'image', attachmentId: 'file_wall', dim: 20 }, githubToken: 'ghp_secret_value', nested: { apiKey: 'sk-nested-secret', density: 'compact' } },
  items: [
    { id: 'a', type: 'bookmark', title: 'Alpha', url: 'https://example.com/a', collectionId: 'reading', updatedAt: '2026-09-02T00:00:00.000Z' },
    { id: 'doc', type: 'file', title: 'Paper', attachmentId: 'file_doc', fileName: 'paper.pdf', mime: 'application/pdf', size: 5, updatedAt: '2026-09-02T00:00:00.000Z' },
    { id: 'n', type: 'note', title: 'Thoughts', content: 'Plain note', updatedAt: '2026-09-02T00:00:00.000Z' },
  ] });
const chat = { id: 'conversation_1', title: 'Links', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', messages: [
  { id: 'm1', role: 'user', text: 'Save these links', createdAt: '2026-10-01T00:00:00.000Z' },
  { id: 'm2', role: 'assistant', text: 'Saved Alpha [[a]].', citations: [{ id: 'a', title: 'Alpha', url: 'https://example.com/a' }],
    proposals: [{ id: 'p1', status: 'applied', label: 'Save 1 link', undo: { createdItems: ['a'] } }], createdAt: '2026-10-01T00:00:01.000Z' },
] };
const aiState = () => ({ version: 2, settings: { chat: { connectionId: 'conn_1', model: 'claude-x' }, bridgeToken: 'bridge-secret' },
  connections: [{ id: 'conn_1', providerId: 'anthropic', label: 'Work', apiKey: 'sk-ant-leaked', enabled: true }] });

async function sourceDevice() {
  const source = device(sourceLibrary());
  put(source, 'file_doc', blob('%PDF!', 'application/pdf'), 'paper.pdf');
  put(source, 'file_wall', blob('wallpaper-bytes', 'image/png'), 'wall.png');
  const chats = createConversationStore({ storage: createMemoryStorage() });
  await chats.saveConversation(chat);
  const dashboard = dashboardSource({ activeBoardId: 'main', boards: [{ id: 'main', name: 'Main', widgets: [{ id: 'w_links', type: 'links-folder', x: 0, y: 0, w: 4, h: 3, config: { collectionId: 'reading' } }] }] });
  return { source, chats, dashboard, ai: aiSource(aiState()) };
}

test('a version 2 backup carries the library, files, wallpaper, settings, dashboard, chats and AI setup without secrets', async () => {
  const { source, chats, dashboard, ai } = await sourceDevice();
  const backup = await createFullBackup(source.store, { dashboard, conversations: chats, aiConfig: ai, deviceId: 'device-1', extensionVersion: '0.5.0' });
  assert.equal(backup.backupVersion, BACKUP_VERSION);
  assert.equal(backup.schemaVersion, 1);
  assert.deepEqual(Object.keys(backup).slice(0, 4), ['backupVersion', 'schemaVersion', 'exportedAt', 'manifest']);
  assert.deepEqual(backup.manifest, { app: 'still', extensionVersion: '0.5.0', deviceId: 'device-1', warnings: [],
    counts: { items: 3, collections: 1, notes: 1, attachments: 2, boards: 1, conversations: 1, aiConnections: 1 } });
  assert.deepEqual(backup.attachments.map(entry => [entry.id, entry.ref]), [['file_wall', 'wallpaper'], ['file_doc', undefined]]);
  assert.equal(backup.conversations.version, 2);
  assert.equal(backup.conversations.conversations[0].messages[1].proposals[0].undo.createdItems[0], 'a', 'the export keeps the chat as saved');
  const text = serializeBackup(backup).text;
  for (const secret of ['ghp_secret_value', 'sk-nested-secret', 'sk-ant-leaked', 'bridge-secret']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(backup.aiConfig.connections, [{ id: 'conn_1', providerId: 'anthropic', label: 'Work', enabled: true }]);
  assert.deepEqual(backup.settings.nested, { density: 'compact' });

  // Another device with its own work: everything comes back, nothing local is lost.
  const target = device({ schemaVersion: 1, items: [{ id: 'local', type: 'note', title: 'Mine', content: 'local work' }], collections: [], settings: { theme: 'light', githubToken: 'mine' } });
  const targetChats = createConversationStore({ storage: createMemoryStorage() });
  const targetDashboard = dashboardSource({ activeBoardId: 'home', boards: [{ id: 'home', name: 'Home', widgets: [] }] });
  const targetAi = aiSource();
  const { taken, snapshot } = snapshots(target.log);
  const result = await importPortableFile(jsonFile(backup), target.store, { dashboard: targetDashboard, conversations: targetChats, aiConfig: targetAi, snapshot });
  assert.deepEqual(taken, ['before-import']);
  assert.equal(target.log[0], 'snapshot:before-import', 'the snapshot comes before any write');
  assert.equal(result.snapshotId, 'snapshot_1');
  assert.equal(result.items, 3);
  assert.equal(result.files, 2);
  assert.equal(result.settings, true);
  assert.equal(result.boards, 1);
  assert.deepEqual(result.conversations, { added: 1, updated: 0, skipped: 0, full: 0 });
  assert.equal(result.aiConnections, 1);
  assert.match(result.notes[0], /without its API key/);
  assert.deepEqual(result.warnings, []);

  const settings = target.library.settings;
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.accent, 'green');
  assert.equal(settings.githubToken, 'mine', 'device secrets stay');
  const wallpaperId = settings.wallpaper.attachmentId;
  assert.equal(settings.wallpaper.dim, 20);
  assert.deepEqual(await bytesOf(target.files.get(wallpaperId).blob), await bytesOf(blob('wallpaper-bytes')));
  const doc = target.library.items.find(item => item.id === 'doc');
  assert.equal(new TextDecoder().decode(await bytesOf(target.files.get(doc.attachmentId).blob)), '%PDF!');
  assert.equal(target.library.items.find(item => item.id === 'local').content, 'local work');
  assert.deepEqual(targetDashboard.stored.boards.map(board => board.id), ['home', 'main']);
  const restored = await targetChats.getConversation('conversation_1');
  assert.equal(restored.messages[1].text, 'Saved Alpha [[a]].');
  assert.equal(restored.messages[1].proposals[0].status, 'applied');
  assert.equal(restored.messages[1].proposals[0].undo, undefined, 'undo instructions from a file are never trusted');
  assert.deepEqual(targetAi.calls[0].connections, backup.aiConfig.connections);
});

test('restoring the same backup twice stores no second copy of any file', async () => {
  const { source, chats, dashboard, ai } = await sourceDevice();
  const backup = await createFullBackup(source.store, { dashboard, conversations: chats, aiConfig: ai, deviceId: null });
  const target = device();
  const options = { dashboard: null, conversations: null, aiConfig: null, snapshot: null };
  await importPortableFile(jsonFile(backup), target.store, options);
  const firstFiles = [...target.files.keys()].sort();
  const firstWallpaper = target.library.settings.wallpaper.attachmentId;
  const again = await importPortableFile(jsonFile(backup), target.store, options);
  assert.deepEqual([...target.files.keys()].sort(), firstFiles, 'no orphaned copies');
  assert.equal(target.library.settings.wallpaper.attachmentId, firstWallpaper);
  assert.equal(again.items, 0);
  assert.equal(again.library.items.kept, 3);
});

test('files for records the merge keeps local (newer here, or deleted forever) are removed again', async () => {
  const { source } = await sourceDevice();
  const backup = await createFullBackup(source.store, { dashboard: null, conversations: null, aiConfig: null, deviceId: null });
  const target = device({ schemaVersion: 1, collections: [], settings: {},
    items: [{ id: 'doc', type: 'file', title: 'Paper, edited here', attachmentId: 'file_mine', fileName: 'mine.pdf', mime: 'application/pdf', size: 3, updatedAt: '2026-10-30T00:00:00.000Z' }],
    tombstones: [{ kind: 'item', id: 'a', deletedAt: '2026-10-30T00:00:00.000Z' }] });
  put(target, 'file_mine', blob('new', 'application/pdf'), 'mine.pdf');
  const result = await importPortableFile(jsonFile(backup), target.store, { dashboard: null, conversations: null, aiConfig: null, snapshot: null });
  assert.equal(result.library.items.kept, 1);
  assert.equal(result.library.items.tombstoned, 1);
  assert.equal(target.library.items.find(item => item.id === 'doc').title, 'Paper, edited here');
  assert.ok(!target.library.items.some(item => item.id === 'a'), 'a deleted record is not resurrected');
  // Only this device's own file and the restored wallpaper remain.
  assert.deepEqual([...target.files.keys()].filter(id => id !== target.library.settings.wallpaper.attachmentId), ['file_mine']);
  assert.ok(target.log.some(entry => entry.startsWith('delete:')));
});

test('a failing safety snapshot stops the import before anything is written', async () => {
  const { source } = await sourceDevice();
  const backup = await createFullBackup(source.store, { dashboard: null, conversations: null, aiConfig: null, deviceId: null });
  const target = device();
  await assert.rejects(importPortableFile(jsonFile(backup), target.store, { snapshot: async () => { throw new Error('IndexedDB is blocked'); }, dashboard: null, conversations: null, aiConfig: null }),
    /could not save a snapshot.*nothing was changed.*IndexedDB is blocked/);
  assert.deepEqual(target.log, []);
  assert.equal(target.files.size, 0);
});

test('a version 1 backup still restores, now with its settings; newer files are refused untouched', async () => {
  const v1 = { schemaVersion: 1, backupVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z', settings: { theme: 'dark', wallpaper: { kind: 'image', attachmentId: 'file_old' } },
    collections: [{ id: 'c', name: 'Old' }], items: [{ id: 'f', type: 'file', title: 'Doc', attachmentId: 'file_1', fileName: 'a.bin', size: 2, collectionId: 'c' }],
    attachments: [{ id: 'file_1', name: 'a.bin', mime: 'application/octet-stream', data: 'data:application/octet-stream;base64,AAE=' }] };
  const target = device({ schemaVersion: 1, items: [], collections: [], settings: { wallpaper: { kind: 'preset', preset: 'dusk' } } });
  const options = { dashboard: null, conversations: null, aiConfig: null, snapshot: null };
  const result = await importPortableFile(jsonFile(v1), target.store, options);
  assert.equal(result.items, 1);
  assert.equal(result.files, 1);
  assert.equal(target.library.settings.theme, 'dark');
  assert.deepEqual(target.library.settings.wallpaper, { kind: 'preset', preset: 'dusk' }, 'a wallpaper without its image leaves the current one');
  assert.match(result.warnings.join(' '), /no copy of its wallpaper image/);

  for (const newer of [{ ...v1, backupVersion: 3 }, { ...v1, schemaVersion: 2 }, { ...v1, schemaVersion: 'x' }]) {
    const fresh = device();
    await assert.rejects(importPortableFile(jsonFile(newer), fresh.store, options), /newer version of Still|not supported/);
    assert.deepEqual(fresh.log, []);
  }
});

test('the import boundary refuses unsafe additions of version 2 before any write', async () => {
  const { source } = await sourceDevice();
  const good = await createFullBackup(source.store, { dashboard: null, conversations: null, aiConfig: null, deviceId: null });
  const bad = [
    data => { data.attachments[0].ref = 'avatar'; },
    data => { data.settings.wallpaper.attachmentId = 'other'; },
    data => { data.attachments[0].mime = 'text/html'; data.attachments[0].data = 'data:text/html;base64,PGI+'; },
    data => { data.items[0].sourceUrl = 'javascript:alert(1)'; },
    data => { data.items[0].highlights = [{ text: 'x', url: 'javascript:alert(1)' }]; },
    data => { data.items[0].reminderAt = 'not a date'; },
    data => { data.conversations = { conversations: 'nope' }; },
    data => { data.aiConfig = ['nope']; },
    // A prototype key deep inside a chat (JSON.parse makes it an own key, as a crafted file would).
    data => { data.conversations = JSON.parse('{"version":2,"conversations":[{"id":"x","messages":[],"__proto__":{"polluted":true}}]}'); },
  ];
  for (const mutate of bad) {
    const data = JSON.parse(JSON.stringify(good));
    mutate(data);
    const text = JSON.stringify(data);
    if (mutate === bad.at(-1)) assert.match(text, /"__proto__"/);
    const target = device();
    const snapshot = async () => { target.log.push('snapshot'); return { id: 's' }; };
    await assert.rejects(importPortableFile(jsonFile(text), target.store, { snapshot, dashboard: null, conversations: null, aiConfig: null }));
    assert.deepEqual(target.log, [], String(mutate));
  }
  assert.equal({}.polluted, undefined);
});

test('export never fails for one bad record, and what it writes always restores', async () => {
  const bigCover = `data:image/PNG;base64,${'A'.repeat(8 * 1024 * 1024)}`;
  const library = { schemaVersion: 1, settings: {}, collections: [{ id: 'c', name: 'Kept', parentId: 'gone' }, { id: 'bad id!', name: 'Broken' }],
    items: [
      { id: 'cover', type: 'image', title: 'Retina screenshot', url: 'https://example.com/shot', cover: bigCover },
      { id: 'long', type: 'note', title: 'Huge note', content: 'x'.repeat(1_200_000) },
      { id: 'url', type: 'bookmark', title: 'Long link', url: `https://example.com/?q=${'y'.repeat(9000)}` },
      { id: 'lost', type: 'file', title: 'Lost file', attachmentId: 'file_gone', size: 10 },
      { id: 'dates', type: 'bookmark', title: 'Odd dates', url: 'https://example.com/d', createdAt: 'yesterday-ish', deletedAt: 'sometime', tags: ['ok', 7] },
      { id: 'orphan', type: 'note', title: 'In a broken collection', collectionId: 'bad id!' },
      { id: 'broken', type: 'mystery', title: 'Written by a future build' },
    ] };
  // The store would not write these shapes itself; a stored library can still hold them (older builds, other tools).
  const source = device();
  source.store.exportLibrary = async () => structuredClone(library);
  const backup = await createFullBackup(source.store, { dashboard: null, conversations: null, aiConfig: null, deviceId: null });
  const warnings = backup.manifest.warnings.join(' ');
  assert.match(warnings, /Left out 1 damaged item that could not be restored \(“Written by a future build”\)/);
  assert.match(warnings, /Repaired 2 items/);
  assert.match(warnings, /Left out 1 damaged collection/);
  assert.match(warnings, /1 file could not be found/);
  assert.equal(backup.items.find(item => item.id === 'cover').cover, bigCover, 'a large upper-case PNG cover is kept');
  const dates = backup.items.find(item => item.id === 'dates');
  assert.equal(dates.createdAt, undefined);
  assert.ok(Number.isFinite(Date.parse(dates.deletedAt)), 'a trashed item stays in Trash');
  assert.deepEqual(dates.tags, ['ok']);
  assert.equal(backup.items.find(item => item.id === 'orphan').collectionId, '');
  assert.equal(backup.collections[0].parentId, '');

  const target = device();
  const file = jsonFile(serializeBackup(backup).text);
  const result = await importPortableFile(file, target.store, { dashboard: null, conversations: null, aiConfig: null, snapshot: null });
  assert.equal(result.items, 6);
  assert.equal(target.library.items.find(item => item.id === 'long').content.length, 1_200_000);
  assert.equal(target.library.items.find(item => item.id === 'cover').cover, bigCover);
  assert.ok(target.library.items.find(item => item.id === 'url').url.length > 9000);
  assert.match(target.library.items.find(item => item.id === 'lost').attachmentId, /^missing_/);
});

test('item file details are corrected to match the file so the backup restores', async () => {
  const source = device({ schemaVersion: 1, collections: [], settings: {}, items: [{ id: 'f', type: 'file', title: 'F', attachmentId: 'file_f', mime: 'text/plain', size: 99 }] });
  put(source, 'file_f', blob('abc', 'application/pdf'), 'f.pdf');
  const backup = await createFullBackup(source.store, { dashboard: null, conversations: null, aiConfig: null, deviceId: null });
  assert.equal(backup.items[0].size, 3);
  assert.equal(backup.items[0].mime, 'application/pdf');
  assert.match(backup.manifest.warnings[0], /Corrected the file size or type of 1 item/);
  const target = device();
  assert.equal((await importPortableFile(jsonFile(backup), target.store, { dashboard: null, conversations: null, aiConfig: null, snapshot: null })).files, 1);
});

test('a part that cannot be read becomes a warning instead of failing the backup or the restore', async () => {
  const { source } = await sourceDevice();
  const newer = Object.assign(new Error('Your assistant conversations were saved by a newer version of Still.'), { code: 'newer_version' });
  const backup = await createFullBackup(source.store, { deviceId: null, dashboard: { exportDashboard: async () => { throw new Error('dashboard storage failed'); } },
    conversations: { exportAll: async () => { throw newer; } }, aiConfig: null });
  assert.equal(backup.dashboard, undefined);
  assert.equal(backup.conversations, undefined);
  assert.match(backup.manifest.warnings.join(' '), /dashboards could not be included: dashboard storage failed/);
  assert.match(backup.manifest.warnings.join(' '), /chats could not be included: .*newer version/);

  const withChats = { ...backup, conversations: { version: 3, conversations: [chat] } };
  const target = device();
  const original = console.error; console.error = () => {};
  try {
    const result = await importPortableFile(jsonFile(withChats), target.store, { dashboard: null, aiConfig: null, snapshot: null,
      conversations: createConversationStore({ storage: createMemoryStorage() }) });
    assert.equal(result.items, 3);
    assert.match(result.warnings.join(' '), /Your library was restored, but not the assistant chats in this file\. .*newer version/);
  } finally { console.error = original; }
});

test('the downloaded text is what the size limit measures: readable when it fits, compact when only that fits', async () => {
  const backup = { backupVersion: 2, items: Array.from({ length: 50 }, (_, index) => ({ id: `i${index}`, title: 'x' })) };
  const pretty = JSON.stringify(backup, null, 2), compact = JSON.stringify(backup);
  const roomy = serializeBackup(backup, { maxBytes: pretty.length });
  assert.equal(roomy.text, pretty);
  assert.equal(roomy.bytes, new TextEncoder().encode(roomy.text).byteLength);
  const tight = serializeBackup(backup, { maxBytes: pretty.length - 1 });
  assert.equal(tight.text, compact);
  assert.throws(() => serializeBackup(backup, { maxBytes: compact.length - 1 }), /larger than/);
  // Multi-byte text is measured in bytes, not characters.
  assert.throws(() => serializeBackup({ title: 'é'.repeat(10) }, { maxBytes: JSON.stringify({ title: 'é'.repeat(10) }).length }), /larger than/);
});

test('a backup file without a .json name is still recognised', async () => {
  const { source } = await sourceDevice();
  const backup = await createFullBackup(source.store, { dashboard: null, conversations: null, aiConfig: null, deviceId: null });
  const target = device();
  const result = await importPortableFile(jsonFile(backup, 'still-backup (1)'), target.store, { dashboard: null, conversations: null, aiConfig: null, snapshot: null });
  assert.equal(result.items, 3);
  await assert.rejects(importPortableFile(new File(['just some words'], 'notes.txt'), device().store, { snapshot: null }), /Choose a Still JSON backup/);
});

test('files that would push the backup past the size limit are left out with a warning; the rest still restores', async () => {
  const source = device({ schemaVersion: 1, collections: [], settings: {}, items: [
    { id: 'small', type: 'file', title: 'Small', attachmentId: 'file_small', size: 3000 },
    { id: 'big', type: 'file', title: 'Big', attachmentId: 'file_big', size: 30000 },
  ] });
  put(source, 'file_small', blob('s'.repeat(3000)), 'small.bin');
  put(source, 'file_big', blob('b'.repeat(30000)), 'big.bin');
  const maxBytes = 20000;
  const backup = await createFullBackup(source.store, { dashboard: null, conversations: null, aiConfig: null, deviceId: null, maxBytes });
  assert.deepEqual(backup.attachments.map(entry => entry.id), ['file_small']);
  assert.match(backup.manifest.warnings.join(' '), /1 file did not fit/);
  const { text, bytes } = serializeBackup(backup, { maxBytes });
  assert.ok(bytes <= maxBytes);
  const target = device();
  const result = await importPortableFile(jsonFile(text), target.store, { dashboard: null, conversations: null, aiConfig: null, snapshot: null });
  assert.equal(result.files, 1);
  assert.match(target.library.items.find(item => item.id === 'big').attachmentId, /^missing_/);
});

test('a backup restores a file this device lost, even when the device keeps its newer copy of the item', async () => {
  const pdf = blob('%PDF-1.4 the only copy', 'application/pdf');
  const source = device({ schemaVersion: 1, collections: [], settings: {}, items: [
    { id: 'doc', type: 'file', title: 'Contract', attachmentId: 'file_doc', fileName: 'contract.pdf', mime: 'application/pdf', size: pdf.size, createdAt: '2026-01-01T00:00:00.000Z' }] });
  put(source, 'file_doc', pdf, 'contract.pdf');
  const backup = await createFullBackup(source.store, { dashboard: null, conversations: null, aiConfig: null, deviceId: null });
  // Later on this device the file's bytes are lost (a snapshot restore does not bring blobs back) and the item is edited.
  source.files.delete('file_doc');
  await source.store.updateItem('doc', { title: 'Contract (signed)' });
  const result = await importPortableFile(jsonFile(backup), source.store, { dashboard: null, conversations: null, aiConfig: null, snapshot: null });
  const item = source.library.items.find(entry => entry.id === 'doc');
  assert.equal(item.title, 'Contract (signed)', 'the newer local edit is kept');
  assert.notEqual(item.attachmentId, 'file_doc');
  assert.deepEqual(await bytesOf(source.files.get(item.attachmentId).blob), await bytesOf(pdf), 'the item points at the restored bytes');
  assert.equal(result.files, 1);
  assert.ok(result.warnings.some(warning => /restored from this backup/.test(warning)));
});

test('a URL or colour wallpaper restores even when it still names an old uploaded image the file does not carry', async () => {
  for (const wallpaper of [{ kind: 'url', url: 'https://images.example.com/sky.jpg', attachmentId: 'file_old' }, { kind: 'color', color: '#223344', attachmentId: 'file_old' }]) {
    const target = device();
    const v1 = { schemaVersion: 1, backupVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z', items: [], collections: [], settings: { wallpaper }, attachments: [] };
    const result = await importPortableFile(jsonFile(v1), target.store, { dashboard: null, conversations: null, aiConfig: null, snapshot: null });
    assert.equal(target.library.settings.wallpaper.kind, wallpaper.kind);
    assert.equal(target.library.settings.wallpaper.attachmentId, '', 'no dangling id to a file this device does not have');
    assert.ok(!result.warnings.some(warning => /wallpaper/.test(warning)));
  }
});
