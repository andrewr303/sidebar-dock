/*
 * Device metadata: chrome.storage.local['still.meta.v1'] =
 *   { deviceId, installedAt, lastVersion, lastSnapshotAt, changedAt }
 * deviceId is a random UUID made once per install and never synced or exported as a secret; a future sync engine uses it
 * as the origin of changes. lastVersion is the extension version that last started (the update snapshot gate compares it
 * with the manifest). changedAt marks "data changed since lastSnapshotAt" for the daily snapshot. Unknown keys written
 * by other builds are kept. Writes run under the Web Lock 'still.meta.v1' so the worker and pages never interleave.
 */
import { defaultArea, isPlainObject } from './area.js';

export const META_KEY = 'still.meta.v1';
const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

export function normalizeMeta(value) {
  const meta = isPlainObject(value) ? { ...value } : {};
  for (const key of ['deviceId', 'installedAt', 'lastVersion', 'lastSnapshotAt', 'changedAt']) {
    if (meta[key] !== undefined && typeof meta[key] !== 'string') delete meta[key];
  }
  return meta;
}

/** True when data changed after the last snapshot (or nothing was ever snapshotted but a change was seen). */
export const isDirty = meta => !!meta.changedAt && (!meta.lastSnapshotAt || meta.changedAt >= meta.lastSnapshotAt);

export function createMetaStore({ area = defaultArea(), locks = globalThis.navigator?.locks, now = () => new Date().toISOString(), makeId = uuid } = {}) {
  let queue = Promise.resolve();
  const exclusive = task => {
    const run = () => (locks?.request ? locks.request(META_KEY, task) : task());
    const next = queue.then(run, run); queue = next.catch(() => {}); return next;
  };
  const read = async () => normalizeMeta(await area.read(META_KEY));
  const withIdentity = meta => ({ ...meta, deviceId: meta.deviceId || makeId(), installedAt: meta.installedAt || now() });
  /** Read-modify-write under the lock. The mutator gets a copy and returns the next meta (or nothing to keep its edits). */
  const update = mutator => exclusive(async () => {
    const current = withIdentity(await read());
    const next = withIdentity(normalizeMeta((await mutator({ ...current })) ?? current));
    await area.write(META_KEY, next);
    return next;
  });
  async function ensure() {
    const meta = await read();
    return meta.deviceId && meta.installedAt ? meta : update(value => value);
  }
  return { read, update, ensure, deviceId: async () => (await ensure()).deviceId };
}

let shared = null;
const metaStore = () => shared ||= createMetaStore();
export const readMeta = () => metaStore().read();
export const updateMeta = mutator => metaStore().update(mutator);
/** This install's stable device id (created on first use). */
export const getDeviceId = () => metaStore().deviceId();
