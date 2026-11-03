import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSnapshotService, memorySnapshotBackend, idbSnapshotBackend, countSnapshot, handleSnapshotRequest, isSnapshotKey,
  listSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot, getDeviceId, SNAPSHOT_RETENTION,
} from '../extension/lib/storage/snapshots.js';
import { memoryArea, webArea } from '../extension/lib/storage/area.js';
import { createMetaStore, META_KEY, isDirty } from '../extension/lib/storage/meta.js';
import { saveAttachment, getAttachment, deleteAttachment } from '../extension/lib/store.js';

// A small IndexedDB stand-in: open/upgrade/versionchange, object stores with put/add/get/getAll/delete, transactions that
// complete after their requests.
function fakeIndexedDB() {
  const databases = new Map();
  const later = fn => setTimeout(fn, 0);
  const named = (name, message) => Object.assign(new Error(message), { name });
  function connect(name) {
    const record = databases.get(name);
    const db = {
      onversionchange: null, onclose: null, closed: false,
      objectStoreNames: { contains: store => record.stores.has(store) },
      createObjectStore(store, { keyPath }) {
        if (record.stores.has(store)) throw named('ConstraintError', `Object store ${store} already exists.`);
        record.stores.set(store, { keyPath, rows: new Map() });
      },
      close() { db.closed = true; record.connections.delete(db); },
      transaction(names) {
        if (db.closed) throw named('InvalidStateError', 'The database connection is closing.');
        const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
        later(() => later(() => tx.oncomplete?.()));
        tx.objectStore = storeName => {
          if (![names].flat().includes(storeName)) throw named('NotFoundError', storeName);
          const { keyPath, rows } = record.stores.get(storeName);
          const op = run => { const req = { onsuccess: null }; later(() => { req.result = run(); req.onsuccess?.(); }); return req; };
          return {
            put: value => op(() => { rows.set(value[keyPath], structuredClone(value)); return value[keyPath]; }),
            add: value => op(() => { rows.set(value[keyPath], value); return value[keyPath]; }),
            get: key => op(() => (rows.has(key) ? structuredClone(rows.get(key)) : undefined)),
            getAll: () => op(() => [...rows.values()].map(value => structuredClone(value))),
            delete: key => op(() => { rows.delete(key); }),
          };
        };
        return tx;
      },
    };
    record.connections.add(db);
    return db;
  }
  return {
    databases,
    seed(name, version, stores) { databases.set(name, { version, stores: new Map(stores.map(store => [store, { keyPath: 'id', rows: new Map() }])), connections: new Set() }); },
    open(name, version = 1) {
      const request = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => {
        if (!databases.has(name)) databases.set(name, { version: 0, stores: new Map(), connections: new Set() });
        const record = databases.get(name);
        if (version < record.version) { request.error = named('VersionError', 'Requested version is lower.'); request.onerror?.(); return; }
        request.result = connect(name);
        if (version > record.version) { record.version = version; request.onupgradeneeded?.(); }
        request.onsuccess?.();
      });
      return request;
    },
  };
}

const library = (items = 1) => ({ schemaVersion: 1, collections: [{ id: 'c', name: 'C' }], settings: {},
  items: [...Array.from({ length: items }, (_, n) => ({ id: `i${n}`, type: n % 2 ? 'note' : 'bookmark', url: 'https://example.com' })), { id: 'trashed', type: 'note', deletedAt: '2026-01-01' }] });
function harness({ data = {}, version = '1.0.0', backend = memorySnapshotBackend(), exclusive } = {}) {
  const area = memoryArea(data);
  let tick = Date.parse('2026-01-01T00:00:00Z');
  const ran = [];
  const service = createSnapshotService({ area, backend, clock: () => tick++, version: () => version,
    exclusive: exclusive || (async task => { ran.push('exclusive'); return task(); }) });
  return { area, service, backend, ran, setVersion: next => { version = next; } };
}

test('a snapshot holds every Still key except caches and device bookkeeping, with counts and size', async () => {
  const { service, backend } = harness({ data: {
    'still.library.v1': library(3), 'still.dashboard.v1': { boards: [{ id: 'b1' }, { id: 'b2' }] }, 'still.ai.conversations.v2': { items: [{ id: 'x' }] },
    'still.ai.secrets.v1': { conn: { apiKey: 'device-only' } }, 'still.widget-cache.v1': { big: 'cache' }, 'still.ui.recent.v1': { recentCollections: [] },
    [META_KEY]: { deviceId: 'd' }, 'other.app': 1 } });
  const summary = await service.create('manual');
  assert.deepEqual(summary.counts, { items: 3, collections: 1, notes: 1, boards: 2, conversations: 1 });
  assert.ok(summary.bytes > 0);
  assert.equal(summary.extensionVersion, '1.0.0');
  assert.equal(summary.data, undefined, 'summaries never carry the data');
  const data = await backend.data(summary.id);
  assert.deepEqual(Object.keys(data).sort(), ['still.ai.conversations.v2', 'still.ai.secrets.v1', 'still.dashboard.v1', 'still.library.v1']);
  assert.equal(isSnapshotKey('still.ai.conversation.v2:abc'), true);
  assert.equal(isSnapshotKey('still.widget-cache.v1'), false);
  assert.deepEqual(countSnapshot({ 'still.library.v1': JSON.stringify(library(1)) }), { items: 1, collections: 1, notes: 0, boards: 0, conversations: 0 });
  await assert.rejects(service.create('whenever'), /Unknown snapshot reason/);
});

test('retention keeps the newest 30 and never prunes the newest update/migration and restore safety snapshots', async () => {
  const { service } = harness({ data: { 'still.library.v1': library() } });
  for (let n = 0; n < 6; n++) await service.create(n % 2 ? 'update' : 'before-migration');
  for (let n = 0; n < 4; n++) await service.create('before-restore');
  for (let n = 0; n < 40; n++) await service.create(n % 3 ? 'manual' : 'daily');
  const all = await service.list();
  assert.equal(all.length, SNAPSHOT_RETENTION.keep + SNAPSHOT_RETENTION.updates + SNAPSHOT_RETENTION.restores);
  for (let index = 1; index < all.length; index++) assert.ok(all[index - 1].createdAt > all[index].createdAt, 'newest first');
  assert.equal(all.filter(s => ['update', 'before-migration'].includes(s.reason)).length, 5);
  assert.equal(all.filter(s => s.reason === 'before-restore').length, 3);
  assert.equal(all.filter(s => ['manual', 'daily'].includes(s.reason)).length, 30);
});

test('restore takes a safety snapshot first, replaces Still keys inside the write queue and leaves caches alone', async () => {
  const h = harness({ data: { 'still.library.v1': library(2), 'still.dashboard.v1': { boards: [{ id: 'old' }] }, 'still.widget-cache.v1': { keep: 1 } } });
  const before = await h.service.create('manual');
  await h.area.write('still.library.v1', { schemaVersion: 1, items: [], collections: [], settings: {} });
  await h.area.write('still.ai.v2', { version: 2, connections: [{ id: 'new' }] });
  await h.area.write('still.widget-cache.v1', { changed: true });
  await h.area.write(META_KEY, { deviceId: 'device-1', lastVersion: '1.0.0' });
  const result = await h.service.restore(before.id);
  assert.equal(result.restored, true);
  assert.deepEqual(h.ran, ['exclusive']);
  assert.deepEqual((await h.area.read('still.library.v1')).items.map(i => i.id), ['i0', 'i1', 'trashed']);
  assert.equal(await h.area.read('still.ai.v2'), undefined, 'keys absent from the snapshot are removed');
  assert.deepEqual(await h.area.read('still.widget-cache.v1'), { changed: true });
  assert.equal((await h.area.read(META_KEY)).deviceId, 'device-1');
  const safety = (await h.service.list()).find(s => s.id === result.safetySnapshotId);
  assert.equal(safety.reason, 'before-restore');
  assert.equal(safety.counts.items, 0);
  // The safety snapshot can undo the restore.
  await h.service.restore(result.safetySnapshotId);
  assert.deepEqual(await h.area.read('still.ai.v2'), { version: 2, connections: [{ id: 'new' }] });
  // A missing snapshot changes nothing.
  const count = (await h.service.list()).length;
  await assert.rejects(h.service.restore('snapshot_missing'), /no longer exists/);
  assert.equal((await h.service.list()).length, count);
  assert.deepEqual(await h.service.remove(before.id), { deleted: true });
  assert.deepEqual(await h.service.remove(before.id), { deleted: false });
});

test('restore holds the Web Lock of every store pages write, API keys included, while it replaces keys', async () => {
  const area = memoryArea({ 'still.library.v1': library(1), 'still.ai.secrets.v1': { conn: { apiKey: 'old' } } });
  const held = [];
  let heldDuringWrite = null;
  // Accepts request(name, task) and request(name, options, task), like navigator.locks (meta.js uses the short form).
  const locks = { request: async (name, options, task = options) => { held.push(name); try { return await task(); } finally { held.splice(held.indexOf(name), 1); } } };
  const load = area.load.bind(area);
  area.load = async values => { heldDuringWrite = [...held]; return load(values); };
  let tick = Date.parse('2026-01-01T00:00:00Z');
  const service = createSnapshotService({ area, backend: memorySnapshotBackend(), locks, clock: () => tick++, version: () => '1.0.0', exclusive: task => task() });
  const before = await service.create('manual');
  await area.write('still.ai.secrets.v1', { conn: { apiKey: 'new' } });
  await service.restore(before.id);
  assert.deepEqual(heldDuringWrite, ['still.dashboard.v1', 'still.ai.v2', 'still.ai.conversations', 'still.ai.secrets.v1']);
  assert.deepEqual(held, [], 'every lock is released afterwards');
  assert.deepEqual(await area.read('still.ai.secrets.v1'), { conn: { apiKey: 'old' } });
});

test('restore never runs when the safety snapshot cannot be saved', async () => {
  const backend = memorySnapshotBackend();
  const h = harness({ data: { 'still.library.v1': library(1) }, backend });
  const target = await h.service.create('manual');
  await h.area.write('still.library.v1', { schemaVersion: 1, items: [], collections: [] });
  backend.put = async () => { throw new Error('quota'); };
  await assert.rejects(h.service.restore(target.id), /quota/);
  assert.deepEqual((await h.area.read('still.library.v1')).items, []);
});

test('the startup gate snapshots once per version change and remembers the version', async () => {
  const h = harness({ data: { 'still.library.v1': library(2), [META_KEY]: { deviceId: 'dev', lastVersion: '1.0.0', future: 'kept' } }, version: '1.1.0' });
  const update = await h.service.startup();
  assert.equal(update.reason, 'update');
  assert.equal(update.previousVersion, '1.0.0');
  assert.equal(update.extensionVersion, '1.1.0');
  const meta = await h.area.read(META_KEY);
  assert.equal(meta.lastVersion, '1.1.0');
  assert.equal(meta.deviceId, 'dev');
  assert.equal(meta.future, 'kept');
  assert.equal(await h.service.startup(), null, 'same version: no snapshot');
  h.setVersion('1.0.0');
  assert.equal((await h.service.startup()).reason, 'update', 'a downgrade is protected too');
  // First run of a build with snapshots on existing data: no meta yet, the onInstalled previousVersion is added later.
  const first = harness({ data: { 'still.library.v1': library(1) }, version: '2.0.0' });
  const summary = await first.service.startup();
  assert.equal(summary.previousVersion, undefined);
  assert.equal((await first.service.annotate(summary.id, { previousVersion: '1.9.0' })).previousVersion, '1.9.0');
  assert.equal((await first.service.list())[0].previousVersion, '1.9.0');
  // A fresh install has nothing to protect.
  const fresh = harness({ version: '2.0.0' });
  assert.equal(await fresh.service.startup(), null);
  assert.equal((await fresh.area.read(META_KEY)).lastVersion, '2.0.0');
  assert.deepEqual(await fresh.service.list(), []);
  const unknown = harness({ data: { 'still.library.v1': library(1) }, version: '' });
  assert.equal(await unknown.service.startup(), null, 'no manifest version: nothing to compare');
});

test('the daily snapshot runs only when data changed since the last snapshot', async () => {
  const h = harness({ data: { 'still.library.v1': library(1) } });
  assert.equal((await h.service.daily()).reason, 'daily', 'the first daily snapshot happens when data exists');
  assert.equal(await h.service.daily(), null);
  await h.service.markDirty();
  assert.equal(isDirty(await h.area.read(META_KEY)), true);
  await h.service.markDirty();
  assert.equal((await h.service.daily()).reason, 'daily');
  assert.equal(isDirty(await h.area.read(META_KEY)), false);
  assert.equal(await h.service.daily(), null);
  const empty = harness();
  assert.equal(await empty.service.daily(), null, 'nothing to keep yet');
});

test('device meta keeps one stable id per install and unknown keys', async () => {
  const area = memoryArea({ [META_KEY]: { extra: { a: 1 } } });
  const meta = createMetaStore({ area });
  const [first, second] = await Promise.all([meta.deviceId(), meta.deviceId()]);
  assert.equal(first, second);
  assert.match(first, /^[\w-]{8,}$/);
  assert.equal((await meta.read()).extra.a, 1);
  assert.equal(await createMetaStore({ area }).deviceId(), first);
  const updated = await meta.update(value => ({ ...value, lastVersion: '3.0.0', deviceId: first }));
  assert.equal(updated.lastVersion, '3.0.0');
  assert.ok(updated.installedAt);
});

test('page requests are validated and only manual or before-import snapshots can be asked for', async () => {
  const { service } = harness({ data: { 'still.library.v1': library(1) } });
  assert.equal((await handleSnapshotRequest('create', ['before-import'], service)).reason, 'before-import');
  assert.equal((await handleSnapshotRequest('create', [], service)).reason, 'manual');
  await assert.rejects(handleSnapshotRequest('create', ['update'], service), /Unknown snapshot reason/);
  await assert.rejects(handleSnapshotRequest('explode', [], service), /Unknown snapshot request/);
  await assert.rejects(handleSnapshotRequest('list', 'nope', service), /array/);
  await assert.rejects(handleSnapshotRequest('restore', [42], service), /Choose a snapshot/);
  assert.equal((await handleSnapshotRequest('list', [], service)).length, 2);
});

test('the IndexedDB backend opens with guarded upgrades and stores summaries apart from data', async () => {
  const idb = fakeIndexedDB();
  idb.seed('still.snapshots.v1', 0, ['summaries']);
  const backend = idbSnapshotBackend(idb);
  const h = harness({ data: { 'still.library.v1': library(2) }, backend });
  const summary = await h.service.create('manual');
  assert.deepEqual([...idb.databases.get('still.snapshots.v1').stores.keys()].sort(), ['payloads', 'summaries']);
  assert.equal((await backend.list())[0].id, summary.id);
  assert.equal((await backend.data(summary.id))['still.library.v1'].items.length, 3);
  // Another view upgrading the database closes this connection; the next call reopens.
  const [connection] = idb.databases.get('still.snapshots.v1').connections;
  connection.onversionchange();
  assert.equal(connection.closed, true);
  assert.equal((await h.service.list()).length, 1);
  await backend.remove(summary.id);
  assert.deepEqual(await backend.list(), []);
  assert.equal(await backend.data(summary.id), undefined);
});

test('the attachment database tolerates an existing store and reopens after a version change', async () => {
  const idb = fakeIndexedDB();
  idb.seed('still.attachments.v1', 0, ['files']);
  globalThis.indexedDB = idb;
  try {
    const saved = await saveAttachment(new File(['hello'], 'hello.txt', { type: 'text/plain' }));
    assert.equal(saved.fileName, 'hello.txt');
    assert.equal((await getAttachment(saved.attachmentId)).name, 'hello.txt');
    const [connection] = idb.databases.get('still.attachments.v1').connections;
    connection.onversionchange();
    assert.equal(connection.closed, true);
    await deleteAttachment(saved.attachmentId);
    assert.equal(await getAttachment(saved.attachmentId), undefined);
  } finally { delete globalThis.indexedDB; }
});

test('localStorage snapshots move raw values so a restore is exact', async () => {
  const values = new Map([['still.library.v1', JSON.stringify(library(1))], ['still.ui.v1', '{"panelWidth":420}'], ['still.note', 'not json']]);
  const storage = { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const area = webArea(storage);
  const service = createSnapshotService({ area, backend: memorySnapshotBackend(), version: () => 'dev', exclusive: task => task() });
  const snapshot = await service.create('manual');
  assert.equal(snapshot.counts.items, 1);
  values.set('still.note', 'changed'); values.delete('still.ui.v1'); values.set('still.extra', '1');
  await service.restore(snapshot.id);
  values.delete(META_KEY);
  assert.deepEqual(Object.fromEntries(values), { 'still.library.v1': JSON.stringify(library(1)), 'still.note': 'not json', 'still.ui.v1': '{"panelWidth":420}' });
});

test('without the extension runtime the page API runs an in-process service', async () => {
  assert.equal(globalThis.chrome, undefined);
  const made = await createSnapshot();
  assert.equal(made.reason, 'manual');
  assert.ok((await listSnapshots()).some(s => s.id === made.id));
  await assert.rejects(createSnapshot('daily'), /Unknown snapshot reason/);
  assert.deepEqual(await restoreSnapshot(made.id).then(result => Object.keys(result).sort()), ['restored', 'safetySnapshotId']);
  assert.deepEqual(await deleteSnapshot(made.id), { deleted: true });
  assert.equal(await getDeviceId(), await getDeviceId());
});

test('extension pages send snapshot requests to the service worker', async () => {
  const sent = [];
  globalThis.chrome = { runtime: { id: 'ext', sendMessage: async message => { sent.push(message); return { ok: true, result: [] }; } }, storage: { local: {} } };
  try {
    assert.deepEqual(await listSnapshots(), []);
    await createSnapshot('before-import');
    assert.deepEqual(sent, [{ type: 'still:snapshots', op: 'list', args: [] }, { type: 'still:snapshots', op: 'create', args: ['before-import'] }]);
    globalThis.chrome.runtime.sendMessage = async () => ({ ok: false, error: 'Snapshot storage failed.' });
    await assert.rejects(deleteSnapshot('x'), /Snapshot storage failed/);
  } finally { delete globalThis.chrome; }
});

test('the Threadkeeper pairing state is device bookkeeping: never snapshotted, never removed by a restore', async () => {
  const { THREADKEEPER_STATE_KEY, SNAPSHOT_EXCLUDED_KEYS } = await import('../extension/lib/storage/snapshots.js');
  assert.equal(THREADKEEPER_STATE_KEY, 'still.threadkeeper.v1');
  assert.ok(SNAPSHOT_EXCLUDED_KEYS.includes(THREADKEEPER_STATE_KEY));
  assert.equal(isSnapshotKey('still.threadkeeper.v1'), false);
  const area = memoryArea({ 'still.library.v1': { schemaVersion: 1, items: [], collections: [], settings: {} }, 'still.threadkeeper.v1': { version: 1, status: 'paired' } });
  let tick = Date.parse('2026-01-01T00:00:00Z');
  const service = createSnapshotService({ area, backend: memorySnapshotBackend(), locks: null, clock: () => tick++, version: () => '1.0.0', exclusive: task => task() });
  const snapshot = await service.create('manual');
  await area.write('still.threadkeeper.v1', { version: 1, status: 'revoked' });
  await service.restore(snapshot.id);
  assert.deepEqual(await area.read('still.threadkeeper.v1'), { version: 1, status: 'revoked' });
});
