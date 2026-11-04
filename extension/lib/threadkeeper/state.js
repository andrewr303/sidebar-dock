/*
 * Device-only Threadkeeper link state: chrome.storage.local['still.threadkeeper.v1'] (localStorage in the preview build).
 * Never in backups (createFullBackup does not read it) and left out of snapshots (SNAPSHOT_EXCLUDED_KEYS): a restore
 * bumps the epoch instead. Written under the Web Lock 'still.threadkeeper.v1' (in practice only by the service worker;
 * pages change it through the worker).
 *
 * {
 *   version: 1, extensionId, status: 'off'|'pending'|'paired'|'denied'|'revoked',
 *   pending: null | { requestId, extensionId, at, code },     // expires after 10 minutes
 *   tk: { version, capabilities }, epoch, configured, configDirty,
 *   backfill: { total, startedAt, paused },
 *   pairedAt, lastSeenAt, lastSyncAt, lastError, lastErrorAt, counts: { created, updated, removed },
 *   prefs: { scope, projects, providers, transcripts, autoUpdate, placement, parentName, singleCollectionId, matchExisting,
 *            topicsAsTags, onRemoved, defaultView, assistant: { search, context, decision } },
 *   collections: { [projectNameLower]: collectionId, __parent: collectionId },   // mirror placement memory
 *   retry: { attempts, at },                                                     // sync.configure backoff
 *   untrack: [hash],            // threads.untrack hashes not yet confirmed by Threadkeeper (retried; ≤ 20000)
 * }
 */
import { defaultArea, isPlainObject } from '../storage/area.js';
import { CAPABILITIES, PENDING_TTL_MS, clampInt, isExtensionId, isThreadHash, isoOrNull, oneLine, stringList } from './protocol.js';

export const STATE_KEY = 'still.threadkeeper.v1';
export const STATE_LOCK = 'still.threadkeeper.v1';
export const MAX_PENDING_UNTRACK = 20000;
export const STATUSES = Object.freeze(['off', 'pending', 'paired', 'denied', 'revoked']);
export const SYNC_PREF_KEYS = Object.freeze(['scope', 'projects', 'providers', 'transcripts', 'autoUpdate']);
export const DEFAULT_PREFS = Object.freeze({
  scope: 'all', projects: [], providers: [], transcripts: true, autoUpdate: true, placement: 'mirror', parentName: 'AI chats',
  singleCollectionId: '', matchExisting: true, topicsAsTags: false, onRemoved: 'keep', defaultView: 'summary',
  assistant: Object.freeze({ search: true, context: 'auto', decision: true }),
});
const PREF_KEYS = Object.keys(DEFAULT_PREFS);
const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
export const newEpoch = uuid;
const iso = value => isoOrNull(value) || '';
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const providerList = value => stringList(value, 100, 40).filter(id => /^[a-z0-9_]+$/.test(id));
const collectionId = value => (typeof value === 'string' && /^[\w:.-]{1,200}$/.test(value) ? value : '');

function normalizePrefs(raw) {
  const prefs = isPlainObject(raw) ? raw : {};
  const assistant = isPlainObject(prefs.assistant) ? prefs.assistant : {};
  return {
    scope: oneOf(prefs.scope, ['all', 'projects', 'manual'], DEFAULT_PREFS.scope),
    projects: stringList(prefs.projects, 200, 200),
    providers: providerList(prefs.providers),
    transcripts: bool(prefs.transcripts, DEFAULT_PREFS.transcripts),
    autoUpdate: bool(prefs.autoUpdate, DEFAULT_PREFS.autoUpdate),
    placement: oneOf(prefs.placement, ['mirror', 'single', 'inbox'], DEFAULT_PREFS.placement),
    parentName: oneLine(prefs.parentName, 80) || DEFAULT_PREFS.parentName,
    singleCollectionId: collectionId(prefs.singleCollectionId),
    matchExisting: bool(prefs.matchExisting, DEFAULT_PREFS.matchExisting),
    topicsAsTags: bool(prefs.topicsAsTags, DEFAULT_PREFS.topicsAsTags),
    onRemoved: oneOf(prefs.onRemoved, ['keep', 'trash'], DEFAULT_PREFS.onRemoved),
    defaultView: oneOf(prefs.defaultView, ['summary', 'transcript'], DEFAULT_PREFS.defaultView),
    assistant: {
      search: bool(assistant.search, DEFAULT_PREFS.assistant.search),
      context: oneOf(assistant.context, ['auto', 'always', 'off'], DEFAULT_PREFS.assistant.context),
      decision: bool(assistant.decision, DEFAULT_PREFS.assistant.decision),
    },
  };
}

function normalizePending(raw) {
  if (!isPlainObject(raw) || !isExtensionId(raw.extensionId) || typeof raw.requestId !== 'string' || !raw.requestId) return null;
  const at = iso(raw.at);
  if (!at) return null;
  return { requestId: raw.requestId.slice(0, 100), extensionId: raw.extensionId, at, code: /^\d{6}$/.test(raw.code) ? raw.code : '' };
}

/** Fills defaults and coerces every field. Pure. */
export function normalizeThreadkeeperState(raw) {
  const state = isPlainObject(raw) ? raw : {};
  const tk = isPlainObject(state.tk) ? state.tk : {};
  const counts = isPlainObject(state.counts) ? state.counts : {};
  const backfill = isPlainObject(state.backfill) ? state.backfill : {};
  const retry = isPlainObject(state.retry) ? state.retry : {};
  const collections = {};
  if (isPlainObject(state.collections)) {
    for (const [key, value] of Object.entries(state.collections).slice(0, 2000)) {
      const id = collectionId(value);
      if (id && key.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(key)) collections[key] = id;
    }
  }
  let status = oneOf(state.status, STATUSES, 'off');
  const extensionId = isExtensionId(state.extensionId) ? state.extensionId : '';
  const pending = status === 'pending' ? normalizePending(state.pending) : null;
  if (status === 'pending' && !pending) status = 'off';
  if (status === 'paired' && !extensionId) status = 'off';
  return {
    version: 1, extensionId, status, pending,
    tk: { version: oneLine(tk.version, 40), capabilities: stringList(tk.capabilities, CAPABILITIES.length, 40).filter(cap => CAPABILITIES.includes(cap)) },
    epoch: typeof state.epoch === 'string' && /^[\w-]{8,64}$/.test(state.epoch) ? state.epoch : '',
    configured: status === 'paired' && state.configured === true,
    configDirty: status === 'paired' && state.configDirty === true,
    backfill: { total: clampInt(backfill.total, 0, 1e7, 0), startedAt: iso(backfill.startedAt), paused: backfill.paused === true },
    pairedAt: iso(state.pairedAt), lastSeenAt: iso(state.lastSeenAt), lastSyncAt: iso(state.lastSyncAt),
    lastError: oneLine(state.lastError, 300), lastErrorAt: iso(state.lastErrorAt),
    counts: { created: clampInt(counts.created, 0, 1e9, 0), updated: clampInt(counts.updated, 0, 1e9, 0), removed: clampInt(counts.removed, 0, 1e9, 0) },
    prefs: normalizePrefs(state.prefs),
    collections,
    retry: { attempts: clampInt(retry.attempts, 0, 100, 0), at: iso(retry.at) },
    untrack: [...new Set((Array.isArray(state.untrack) ? state.untrack : []).filter(isThreadHash))].slice(-MAX_PENDING_UNTRACK),
  };
}

/** True when a pending request is older than 10 minutes (Still's side of the pairing expiry). */
export const pendingExpired = (state, now = Date.now()) => !!state?.pending && now - Date.parse(state.pending.at) > PENDING_TTL_MS;
/** The state with an expired pending request dropped (status back to 'off'). Pure. */
export function expirePending(state, now = Date.now()) {
  if (state?.status !== 'pending' || !pendingExpired(state, now)) return state;
  return { ...state, status: 'off', pending: null };
}

/** What pages see: a copy without the placement memory, retry bookkeeping and pending untracks. */
export function publicState(state, { available = true, now = Date.now() } = {}) {
  const current = expirePending(normalizeThreadkeeperState(state), now);
  const { collections, retry, untrack, ...rest } = structuredClone(current);
  return { ...rest, available };
}

const fail = message => { throw new Error(message); };
/**
 * prefs with `patch` applied. Only known keys; each value is checked and a clear message is thrown for bad input.
 * `assistant` may be patched partially. Pure.
 */
export function patchPrefs(prefs, patch) {
  if (!isPlainObject(patch)) fail('Choose a setting to change.');
  const next = structuredClone(normalizePrefs(prefs));
  for (const [key, value] of Object.entries(patch)) {
    if (!PREF_KEYS.includes(key)) fail('That is not a Threadkeeper setting.');
    switch (key) {
      case 'scope': next.scope = oneOf(value, ['all', 'projects', 'manual'], null) ?? fail('Choose what to sync.'); break;
      case 'placement': next.placement = oneOf(value, ['mirror', 'single', 'inbox'], null) ?? fail('Choose where chats go.'); break;
      case 'onRemoved': next.onRemoved = oneOf(value, ['keep', 'trash'], null) ?? fail('Choose what happens when a thread leaves Threadkeeper.'); break;
      case 'defaultView': next.defaultView = oneOf(value, ['summary', 'transcript'], null) ?? fail('Choose how chats open.'); break;
      case 'projects':
        if (!Array.isArray(value) || value.some(name => typeof name !== 'string')) fail('Choose projects from the list.');
        if (value.length > 200) fail('Choose at most 200 projects.');
        next.projects = stringList(value, 200, 200); break;
      case 'providers':
        if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !/^[a-z0-9_]{1,40}$/.test(id))) fail('Choose providers from the list.');
        next.providers = providerList(value); break;
      case 'parentName': {
        const name = oneLine(value, 81);
        if (!name) fail('Give the parent collection a name.');
        if (name.length > 80) fail('Keep the collection name under 80 characters.');
        next.parentName = name; break;
      }
      case 'singleCollectionId':
        if (typeof value !== 'string' || (value && !collectionId(value))) fail('Choose a collection.');
        next.singleCollectionId = value; break;
      case 'assistant': {
        if (!isPlainObject(value)) fail('Choose an assistant setting.');
        for (const [inner, setting] of Object.entries(value)) {
          if (inner === 'context') next.assistant.context = oneOf(setting, ['auto', 'always', 'off'], null) ?? fail('Choose when the assistant reads your threads.');
          else if (['search', 'decision'].includes(inner)) next.assistant[inner] = typeof setting === 'boolean' ? setting : fail('Turn it on or off.');
          else fail('That is not an assistant setting.');
        }
        break;
      }
      default: next[key] = typeof value === 'boolean' ? value : fail('Turn it on or off.');
    }
  }
  return next;
}

/** The SyncPrefs sent to Threadkeeper with sync.configure. */
export const syncPrefsOf = prefs => {
  const clean = normalizePrefs(prefs);
  return { scope: clean.scope, projects: clean.projects, providers: clean.providers, transcripts: clean.transcripts, autoUpdate: clean.autoUpdate };
};
/** True when a patch changes what Threadkeeper must know (sync.configure is due). */
export const syncPrefsChanged = (before, after) => JSON.stringify(syncPrefsOf(before)) !== JSON.stringify(syncPrefsOf(after));

/**
 * A small store over the state key: read() → normalized state; update(mutator) → next state (read-modify-write under the
 * Web Lock; the mutator gets a copy and returns the next state or nothing to keep its edits).
 */
export function createThreadkeeperStateStore({ area = defaultArea(), locks = globalThis.navigator?.locks } = {}) {
  let queue = Promise.resolve();
  const exclusive = task => {
    const run = () => (locks?.request ? locks.request(STATE_LOCK, task) : task());
    const next = queue.then(run, run); queue = next.catch(() => {}); return next;
  };
  const read = async () => normalizeThreadkeeperState(await area.read(STATE_KEY));
  const update = mutator => exclusive(async () => {
    const current = await read();
    const draft = structuredClone(current);
    const next = normalizeThreadkeeperState((await mutator(draft)) ?? draft);
    if (JSON.stringify(next) !== JSON.stringify(current)) await area.write(STATE_KEY, next);
    return next;
  });
  return { read, update, key: STATE_KEY };
}
