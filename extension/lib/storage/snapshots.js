/*
 * Automatic device-local snapshots of everything Still keeps in storage, so an update, a migration, a restore or an
 * import can always be undone. Snapshots live in IndexedDB 'still.snapshots.v1' on this device only: they include
 * device secrets (API keys, account tokens) and are never exported or synced. Item attachment blobs are not copied; they
 * are only removed by an explicit delete forever / empty trash.
 *
 * Record (logical): { id, reason, createdAt, extensionVersion, previousVersion?, counts: { items, collections, notes,
 *   boards, conversations }, bytes, data }. Stored as a summary (store 'summaries') plus its data (store 'payloads') so
 *   listing never loads the data.
 * Reasons: 'update' (the extension version changed, taken before any library operation is served), 'daily' (alarm, only
 *   when data changed since the last snapshot), 'manual', 'before-restore', 'before-import', 'before-migration'.
 * Retention: the newest 30 stay; the newest 5 'update'/'before-migration' and the newest 3 'before-restore' are never
 *   pruned (so up to 38 can exist).
 * Restore replaces every snapshotted key inside the library write queue (and the other stores' Web Locks), after taking
 * a 'before-restore' snapshot. Open views follow through storage.onChanged; no view needs to be open.
 *
 * Page API (messages the service worker; the preview/test build without chrome.runtime runs an in-process service):
 *   listSnapshots() -> [summary] newest first      createSnapshot(reason = 'manual') -> summary ('manual' | 'before-import')
 *   restoreSnapshot(id) -> { restored: true, safetySnapshotId }      deleteSnapshot(id) -> { deleted }
 */
import { STORAGE_KEY, runExclusive } from '../store.js';
import { defaultArea, isPlainObject, parseStored } from './area.js';
import { createMetaStore, isDirty, META_KEY } from './meta.js';

export { getDeviceId, readMeta } from './meta.js';
export const SNAPSHOT_DB = 'still.snapshots.v1';
export const SNAPSHOT_ALARM = 'still:snapshot-daily';
export const SNAPSHOT_MESSAGE = 'still:snapshots';
export const SNAPSHOT_REASONS = Object.freeze(['update', 'daily', 'manual', 'before-restore', 'before-import', 'before-migration']);
export const PAGE_SNAPSHOT_REASONS = Object.freeze(['manual', 'before-import']);
export const SNAPSHOT_RETENTION = Object.freeze({ keep: 30, updates: 5, restores: 3 });
// Rebuildable caches and device bookkeeping are neither copied nor removed by a restore.
export const SNAPSHOT_EXCLUDED_KEYS = Object.freeze(['still.widget-cache.v1', 'still.ui.recent.v1', META_KEY,
  'still.link-icons.v1', 'still.appearance.v1', 'still.embed.hints.v1']);
// Stores that write their own keys from pages; a restore waits for (and holds) their locks so it never interleaves.
// API keys (secrets.js) come last: their lock is taken inside 'still.ai.v2' work, never the other way round.
const RESTORE_LOCKS = ['still.dashboard.v1', 'still.ai.v2', 'still.ai.conversations', 'still.ai.secrets.v1'];

export const isSnapshotKey = key => typeof key === 'string' && key.startsWith('still.') && !SNAPSHOT_EXCLUDED_KEYS.includes(key);
const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
const manifestVersion = () => { try { return globalThis.chrome?.runtime?.getManifest?.()?.version || ''; } catch { return ''; } };
const newestFirst = (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
const byteLength = json => (globalThis.TextEncoder ? new TextEncoder().encode(json).byteLength : json.length);
const publicSummary = ({ id, reason, createdAt, extensionVersion, previousVersion, counts, bytes }) =>
  ({ id, reason, createdAt, extensionVersion, ...(previousVersion ? { previousVersion } : {}), counts, bytes });

/** What a snapshot holds, from its stored data (chrome.storage objects or localStorage JSON strings). */
export function countSnapshot(data = {}) {
  const library = parseStored(data[STORAGE_KEY]), dashboard = parseStored(data['still.dashboard.v1']);
  const chats = parseStored(data['still.ai.conversations.v2']);
  const live = value => (Array.isArray(value) ? value.filter(entry => isPlainObject(entry) && !entry.deletedAt) : []);
  const items = live(library?.items);
  return { items: items.length, collections: live(library?.collections).length, notes: items.filter(item => item.type === 'note').length,
    boards: Array.isArray(dashboard?.boards) ? dashboard.boards.length : 0, conversations: Array.isArray(chats?.items) ? chats.items.length : 0 };
}

export function memorySnapshotBackend() {
  const summaries = new Map(), payloads = new Map();
  return {
    async put(summary, data) { summaries.set(summary.id, structuredClone(summary)); payloads.set(summary.id, structuredClone(data)); },
    async update(summary) { if (summaries.has(summary.id)) summaries.set(summary.id, structuredClone(summary)); },
    async list() { return [...summaries.values()].map(summary => structuredClone(summary)); },
    async data(id) { return payloads.has(id) ? structuredClone(payloads.get(id)) : undefined; },
    async remove(id) { summaries.delete(id); payloads.delete(id); },
  };
}

export function idbSnapshotBackend(idb = globalThis.indexedDB, name = SNAPSHOT_DB) {
  let database = null;
  const open = () => database ||= new Promise((resolve, reject) => {
    let request;
    try { request = idb.open(name, 1); } catch (error) { database = null; reject(error); return; }
    // contains() guards let a later version reuse this handler; onversionchange lets that version open while we run.
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('summaries')) db.createObjectStore('summaries', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('payloads')) db.createObjectStore('payloads', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = null; };
      db.onclose = () => { database = null; };
      resolve(db);
    };
    request.onerror = () => { database = null; reject(request.error || new Error('Snapshots could not be opened.')); };
    request.onblocked = () => { database = null; reject(new Error('Close other Still tabs so snapshot storage can update, then try again.')); };
  });
  async function transact(stores, mode, body) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(stores, mode); } catch (error) { database = null; reject(error); return; }
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('Snapshot storage failed.'));
      tx.onabort = () => reject(tx.error || new Error('Snapshot storage was interrupted.'));
      const request = body(name => tx.objectStore(name));
      if (request) request.onsuccess = () => { result = request.result; };
    });
  }
  return {
    put: (summary, data) => transact(['summaries', 'payloads'], 'readwrite', store => { store('payloads').put({ id: summary.id, data }); store('summaries').put(summary); }),
    update: summary => transact(['summaries'], 'readwrite', store => { store('summaries').put(summary); }),
    list: async () => (await transact(['summaries'], 'readonly', store => store('summaries').getAll())) || [],
    data: async id => (await transact(['payloads'], 'readonly', store => store('payloads').get(id)))?.data,
    remove: id => transact(['summaries', 'payloads'], 'readwrite', store => { store('summaries').delete(id); store('payloads').delete(id); }),
  };
}

// Production contexts (the worker, extension pages) always have IndexedDB; Node tests fall back to memory.
const defaultBackend = () => (globalThis.indexedDB ? idbSnapshotBackend(globalThis.indexedDB) : memorySnapshotBackend());

// Waits for each named Web Lock in turn (up to `wait` ms each, then carries on without it) and runs task while holding them.
async function underLocks(names, task, locks, wait = 5000) {
  if (!names.length || !locks?.request) return task();
  const [name, ...rest] = names;
  let entered = false;
  const signal = globalThis.AbortSignal?.timeout ? AbortSignal.timeout(wait) : undefined;
  try {
    return await locks.request(name, signal ? { signal } : {}, () => { entered = true; return underLocks(rest, task, locks, wait); });
  } catch (error) {
    if (entered) throw error;
    return underLocks(rest, task, locks, wait);
  }
}

export function createSnapshotService({
  area = defaultArea(), backend = defaultBackend(), locks = globalThis.navigator?.locks, meta = createMetaStore({ area, locks }),
  clock = () => Date.now(), version = manifestVersion, exclusive = runExclusive, retention = SNAPSHOT_RETENTION,
} = {}) {
  let queue = Promise.resolve(), last = 0, dirtyKnown = false;
  const serial = task => { const next = queue.then(task, task); queue = next.catch(() => {}); return next; };
  // Strictly increasing stamps, so snapshots and change marks taken in the same millisecond still order correctly.
  const stamp = () => { last = Math.max(Number(clock()) || Date.now(), last + 1); return new Date(last).toISOString(); };
  const capture = async () => Object.fromEntries(Object.entries(await area.dump()).filter(([key, value]) => isSnapshotKey(key) && value !== undefined));

  // The newest `keep` snapshots stay; the newest update/migration and restore-safety snapshots stay in addition.
  async function prune(protect = []) {
    const all = (await backend.list()).sort(newestFirst);
    const newest = (reasons, count) => all.filter(summary => reasons.includes(summary.reason)).slice(0, count);
    const keep = new Set([...protect, ...all.slice(0, retention.keep).map(summary => summary.id),
      ...newest(['update', 'before-migration'], retention.updates).map(summary => summary.id),
      ...newest(['before-restore'], retention.restores).map(summary => summary.id)]);
    const doomed = all.filter(summary => !keep.has(summary.id));
    for (const summary of doomed) await backend.remove(summary.id);
    return doomed.map(summary => summary.id);
  }

  function create(reason = 'manual', { previousVersion, protect = [], data } = {}) {
    if (!SNAPSHOT_REASONS.includes(reason)) return Promise.reject(new Error('Unknown snapshot reason.'));
    return serial(async () => {
      // Changes seen from here on are newer than this snapshot (their marks get a later stamp).
      dirtyKnown = false;
      const createdAt = stamp();
      const content = data ? Object.fromEntries(Object.entries(data).filter(([key]) => isSnapshotKey(key))) : await capture();
      const summary = { id: `snapshot_${uuid()}`, reason, createdAt, extensionVersion: version() || '',
        ...(typeof previousVersion === 'string' && previousVersion ? { previousVersion } : {}),
        counts: countSnapshot(content), bytes: byteLength(JSON.stringify(content)) };
      await backend.put(summary, content);
      await meta.update(value => ({ ...value, lastSnapshotAt: createdAt }));
      await prune([summary.id, ...protect]);
      return publicSummary(summary);
    });
  }

  const list = async () => (await backend.list()).sort(newestFirst).map(publicSummary);

  function remove(id) {
    if (typeof id !== 'string' || !id) return Promise.reject(new Error('Choose a snapshot to delete.'));
    return serial(async () => {
      const deleted = (await backend.list()).some(summary => summary.id === id);
      if (deleted) await backend.remove(id);
      return { deleted };
    });
  }

  function restore(id) {
    if (typeof id !== 'string' || !id) return Promise.reject(new Error('Choose a snapshot to restore.'));
    return exclusive(() => underLocks(RESTORE_LOCKS, async () => {
      const data = await backend.data(id);
      if (!isPlainObject(data)) throw new Error('That snapshot no longer exists.');
      const current = await capture();
      // Nothing is replaced unless the current data is safely kept first.
      const safety = await create('before-restore', { protect: [id], data: current });
      const restored = Object.fromEntries(Object.entries(data).filter(([key, value]) => isSnapshotKey(key) && value !== undefined));
      // Write first, then drop keys the snapshot did not have: an interruption leaves extra keys, never missing ones.
      await area.load(restored);
      await area.remove(Object.keys(current).filter(key => !Object.hasOwn(restored, key)));
      return { restored: true, safetySnapshotId: safety.id };
    }, locks));
  }

  // Worker start: when the extension version differs from the last one that ran (or this is the first run of a build
  // with snapshots on existing data), snapshot before anything else touches the data, then remember the version.
  async function startup({ previousVersion } = {}) {
    const current = version();
    if (!current) return null;
    const saved = await meta.read();
    if (saved.lastVersion === current) { if (!saved.deviceId) await meta.ensure(); return null; }
    const data = await capture();
    const summary = Object.keys(data).length
      ? await create('update', { previousVersion: saved.lastVersion || previousVersion, data }) : null;
    await meta.update(value => ({ ...value, lastVersion: current }));
    return summary;
  }

  /** Adds details learned later (runtime.onInstalled's previousVersion) to a snapshot summary. */
  async function annotate(id, { previousVersion } = {}) {
    if (!id || typeof previousVersion !== 'string' || !previousVersion) return null;
    return serial(async () => {
      const summary = (await backend.list()).find(entry => entry.id === id);
      if (!summary || summary.previousVersion) return summary ? publicSummary(summary) : null;
      const next = { ...summary, previousVersion };
      await backend.update(next);
      return publicSummary(next);
    });
  }

  /** Marks data as changed since the last snapshot (persisted once per clean period, so commits stay cheap). */
  async function markDirty() {
    if (dirtyKnown) return;
    dirtyKnown = true;
    const changedAt = stamp();
    try { await meta.update(value => ({ ...value, changedAt })); }
    catch (error) { dirtyKnown = false; throw error; }
  }

  /** The daily alarm: a snapshot only when something changed since the last one (or none exists yet but data does). */
  async function daily() {
    const saved = await meta.read();
    if (isDirty(saved)) return create('daily');
    if ((await backend.list()).length) return null;
    const data = await capture();
    return Object.keys(data).length ? create('daily', { data }) : null;
  }

  return { list, create, remove, restore, prune, startup, annotate, markDirty, daily, meta };
}

/** Routes a { op, args } snapshot request (from a page message or an in-process call) to a service. */
export async function handleSnapshotRequest(op, args = [], service) {
  if (!Array.isArray(args)) throw new Error('Snapshot arguments must be an array.');
  switch (op) {
    case 'list': return service.list();
    case 'create': {
      const reason = args[0] ?? 'manual';
      if (!PAGE_SNAPSHOT_REASONS.includes(reason)) throw new Error('Unknown snapshot reason.');
      return service.create(reason);
    }
    case 'restore': return service.restore(args[0]);
    case 'delete': return service.remove(args[0]);
    default: throw new Error('Unknown snapshot request.');
  }
}

let workerService = null, inProcess = null;
/** Called once by the service worker: it owns snapshots for every page. Returns the worker's service. */
export function configureSnapshotWorker(options = {}) { return workerService = createSnapshotService(options); }
/** The service that runs in this context (the worker's, or an in-process one in the preview/test build). */
export const localSnapshotService = () => workerService || (inProcess ||= createSnapshotService());

const viaWorker = () => !workerService && !!globalThis.chrome?.runtime?.id && typeof globalThis.chrome.runtime.sendMessage === 'function'
  && !!globalThis.chrome?.storage?.local;
async function request(op, args) {
  if (!viaWorker()) return handleSnapshotRequest(op, args, localSnapshotService());
  const response = await globalThis.chrome.runtime.sendMessage({ type: SNAPSHOT_MESSAGE, op, args });
  if (!response?.ok) throw new Error(response?.error || 'Snapshots are unavailable. Reload the extension.');
  return response.result;
}
export const listSnapshots = () => request('list', []);
export const createSnapshot = (reason = 'manual') => request('create', [reason]);
export const restoreSnapshot = id => request('restore', [id]);
export const deleteSnapshot = id => request('delete', [id]);
