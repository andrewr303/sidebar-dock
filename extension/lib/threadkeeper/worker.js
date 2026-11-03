/*
 * The Threadkeeper link inside Still's service worker (docs/threadkeeper-integration.md). Service worker only; every
 * dependency is injected so tests can fake them:
 *
 *   configureThreadkeeperWorker({
 *     store: { upsertChats, markChatsRemoved, permanentlyDeleteItem, restoreItem, bulkUpdateItems, createCollection },
 *     readLibrary: async () => library,            // the worker's cached library read (never seeds an empty store)
 *     chatData: { put, get, getTranscript, delete, ids, dismiss?, dismissed?, undismiss? },   // lib/chat-data.js
 *     state: createThreadkeeperStateStore(),       // still.threadkeeper.v1
 *     transport: (extensionId, message, timeoutMs) => Promise<response>,   // chrome.runtime.sendMessage to Threadkeeper
 *     alarms: chrome.alarms, selfId, version: () => manifest version, now: () => Date.now(),
 *     writeIntervalMs = 2000,                     // coalescing window for library writes from pushes
 *   })
 *
 * Inbound (handleExternalMessage(message, sender) → flat protocol response; never throws):
 *   sender check (id + extension page origin, no tab) → pairing role → type allowlist → size (4 MB) → fields.
 *   Unpaired senders: hello only (no state write). The pending id: hello, pair.granted, pair.denied (matching requestId,
 *   unexpired); anything else → pending_approval. Requests from one sender run one at a time; at most one push
 *   (threads.upsert / threads.remove) runs and one waits, a third gets busy + retryAfterMs.
 *
 * Applying threads (pushes, imports, refresh) runs under one worker-wide apply mutex: each entry is decided against a fresh
 * library read before anything is written to IndexedDB (invalid, stale seq, dismissed, trashed, out of Still's own scope),
 * chat data (transcript first) is written, then the library entries are coalesced into at most one upsertChats write per
 * writeIntervalMs (≤ 100 chats). Chat data written for a chat the library did not take is deleted again.
 *
 * Page proxy (handleThreadkeeperRequest(op, args) → { ok: true, data } | { ok: false, error: { code, message } }), for
 * worker message type 'still:threadkeeper': state, ping, connect, cancel, disconnect, setPrefs, startSync, syncNow, request,
 * importThreads, refreshChat, loadTranscriptWindow, undoImport, impact, replaceChats, removeTranscripts.
 *
 * Hooks for background.js: onCommit(change) (chat data cleanup + "deleted forever" dismissals), handleAlarm(alarm),
 * init() on every worker start, startup() on onStartup/onInstalled (orphan sweep + hello), onDataRestored() after a snapshot
 * restore or backup import (new epoch, hello, sync.configure), invalidate() when the state key changes.
 */
import {
  APP_NAME, LIMITS, MAX_MESSAGE_CHARS, MESSAGE_TYPES_IN, PROTO, READ_TYPES, REMOVE_REASONS, UNPAIRED_TYPES, UPSERT_ORIGINS,
  ThreadkeeperError, chatItemId, clampInt, envelope, errorFromResponse, errorResponse, errorText, hashOfChatId, isChatItemId,
  isContiguous, isExtensionId, isThreadKey, isTrustedSender, jsonSize, newRequestId, okResponse, oneLine, sanitizeRequestFields,
  sanitizeResponse, sanitizeThreadPayload, syncedHash, timeoutFor,
} from './protocol.js';
import { createThreadkeeperStateStore, expirePending, newEpoch, patchPrefs, pendingExpired, publicState, syncPrefsChanged, syncPrefsOf } from './state.js';
import { PARENT_MEMORY, planPlacement, resolveTarget } from './placement.js';

export const THREADKEEPER_MESSAGE = 'still:threadkeeper';
export const RETRY_ALARM = 'still:threadkeeper:retry';
export const SWEEP_ALARM = 'still:threadkeeper:sweep';
export const RETRY_MINUTES = Object.freeze([1, 5, 30, 120]);
export const ORPHAN_AGE_MS = 10 * 60 * 1000;
const BOOKKEEPING_MS = 60 * 1000;
const MAX_WRITE_ENTRIES = 100;
const IMPORT_BATCH = 20;
const READS_PER_MINUTE = 30;
const READS_IN_FLIGHT = 2;
const PAIRING_TYPES = new Set(['hello', 'pair.request', 'pair.revoke']);
const PLACEMENT_PREFS = ['placement', 'parentName', 'singleCollectionId', 'matchExisting'];

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const items = library => (Array.isArray(library?.items) ? library.items : []).filter(isObject);
const isTkChat = item => item?.type === 'chat' && isObject(item.chat) && item.chat.source !== 'other' && typeof item.chat.threadKey === 'string';
const failure = (code, message, retryAfterMs) => ({ ok: false, error: { code, message: message || errorText(code), ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}) } });
const toError = result => new ThreadkeeperError(result.error.code, result.error.message, { retryAfterMs: result.error.retryAfterMs });

/**
 * True when the user made a chat their own: notes, live subpages, tags of their own, favorite, a rename (title no longer
 * what sync wrote) or a move (collection no longer where sync placed it). Touched chats are never deleted or trashed by
 * sync and keep the user's work when a thread turns local-only.
 */
export function isUserTouched(item, library) {
  if (!isObject(item)) return false;
  const chat = isObject(item.chat) ? item.chat : {};
  if (typeof item.content === 'string' && item.content.trim()) return true;
  if (item.favorite === true) return true;
  const synced = new Set((Array.isArray(chat.syncedTags) ? chat.syncedTags : []).map(tag => String(tag).toLowerCase()));
  if ((Array.isArray(item.tags) ? item.tags : []).some(tag => !synced.has(String(tag).toLowerCase()))) return true;
  if (typeof chat.syncedTitleHash === 'string' && chat.syncedTitleHash && syncedHash(item.title) !== chat.syncedTitleHash) return true;
  if (typeof chat.autoCollectionId === 'string' && (item.collectionId || '') !== chat.autoCollectionId) return true;
  return items(library).some(other => other.parentId === item.id && !other.deletedAt);
}

/** True when a thread (payload or chat metadata) falls inside Still's own sync scope. */
export function inSyncScope(thread, prefs = {}) {
  if (!thread || prefs.scope === 'manual') return false;
  if (prefs.scope === 'projects') {
    const wanted = new Set((prefs.projects || []).map(name => name.trim().toLowerCase()));
    if (!wanted.has(String(thread.project || '').trim().toLowerCase())) return false;
  }
  return !(prefs.providers || []).length || prefs.providers.includes(thread.provider);
}

/**
 * Merges a transcript window into a stored transcript of the same revision (by message index; incoming wins). A window of
 * another revision replaces the stored copy. `truncated` is cleared once the indexes are contiguous. Pure.
 */
export function mergeTranscript(stored, incoming) {
  const base = stored && stored.revision === incoming.revision ? stored.messages || [] : [];
  const byIndex = new Map(base.map(message => [message.index, message]));
  for (const message of incoming.messages || []) byIndex.set(message.index, message);
  const messages = [...byIndex.values()].sort((a, b) => a.index - b.index).slice(-LIMITS.messages);
  const totalMessages = Math.max(incoming.totalMessages || 0, stored?.revision === incoming.revision ? stored.totalMessages || 0 : 0,
    messages.length ? messages[messages.length - 1].index + 1 : 0);
  return { threadKey: incoming.threadKey || stored?.threadKey || '', revision: incoming.revision, totalMessages,
    truncated: !isContiguous(messages, totalMessages), messages };
}

/** Collections as Threadkeeper's Send to Still picker lists them: live, with their full path. */
export function listCollections(library) {
  const live = (Array.isArray(library?.collections) ? library.collections : []).filter(c => isObject(c) && typeof c.id === 'string' && !c.deletedAt);
  const byId = new Map(live.map(c => [c.id, c]));
  const path = collection => {
    const names = [];
    const seen = new Set();
    for (let current = collection; current && !seen.has(current.id) && names.length < 12; current = byId.get(current.parentId)) { seen.add(current.id); names.unshift(oneLine(current.name, 120)); }
    return names.join(' / ');
  };
  return live.slice(0, 2000).map(c => ({ id: c.id, name: oneLine(c.name, 120), parentId: byId.has(c.parentId) ? c.parentId : '', path: path(c),
    icon: oneLine(c.icon, 40), color: oneLine(c.color, 20) }));
}

/** The default transport: chrome.runtime.sendMessage to another extension, with a timeout and lastError handling. */
export function chromeTransport(runtime = globalThis.chrome?.runtime) {
  return (extensionId, message, timeoutMs) => new Promise((resolve, reject) => {
    if (typeof runtime?.sendMessage !== 'function') { reject(new Error('Messaging is unavailable.')); return; }
    const timer = setTimeout(() => reject(new Error('Threadkeeper did not answer in time.')), timeoutMs);
    try {
      runtime.sendMessage(extensionId, message, response => {
        clearTimeout(timer);
        const error = runtime.lastError;
        if (error) reject(new Error(error.message || 'Receiving end does not exist.'));
        else resolve(response);
      });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}

const sixDigits = () => {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return String(values[0] % 1000000).padStart(6, '0');
};

export function createThreadkeeperWorker(deps = {}) {
  const {
    store, chatData, readLibrary, state: stateStore = createThreadkeeperStateStore(), transport = chromeTransport(),
    alarms = globalThis.chrome?.alarms, selfId = globalThis.chrome?.runtime?.id || '', now = () => Date.now(),
    version = () => { try { return globalThis.chrome?.runtime?.getManifest?.()?.version || ''; } catch { return ''; } },
    writeIntervalMs = 2000, randomCode = sixDigits, log = (...args) => console.warn('Still Threadkeeper:', ...args),
  } = deps;
  const isoNow = () => new Date(now()).toISOString();

  // ---- state (cached; reloaded when the key changes outside this worker) --------------------------------------------
  let cached = null;
  const getState = async () => expirePending(cached ||= await stateStore.read(), now());
  const updateState = async mutator => (cached = await stateStore.update(mutator));
  // lastSeenAt and lifetime counts are written at most once a minute (each write reaches every open page).
  let lastBookkeeping = 0, bookkeepingTimer = null;
  const pendingCounts = { created: 0, updated: 0, removed: 0 };
  let seenSince = '', syncedSince = '';
  const flushBookkeeping = async () => {
    clearTimeout(bookkeepingTimer); bookkeepingTimer = null;
    if (!seenSince && !syncedSince && !pendingCounts.created && !pendingCounts.updated && !pendingCounts.removed) return;
    const counts = { ...pendingCounts }, seen = seenSince, synced = syncedSince;
    pendingCounts.created = pendingCounts.updated = pendingCounts.removed = 0; seenSince = syncedSince = '';
    lastBookkeeping = now();
    await updateState(draft => {
      if (draft.status !== 'paired') return;
      if (seen) draft.lastSeenAt = seen;
      if (synced) draft.lastSyncAt = synced;
      for (const key of Object.keys(counts)) draft.counts[key] += counts[key];
    }).catch(error => log(error?.message));
  };
  const bookkeeping = ({ seen = false, counts = null } = {}) => {
    if (seen) seenSince = isoNow();
    if (counts) {
      for (const key of Object.keys(pendingCounts)) pendingCounts[key] += counts[key] || 0;
      if (counts.created || counts.updated || counts.removed) syncedSince = isoNow();
    }
    if (now() - lastBookkeeping >= BOOKKEEPING_MS) return flushBookkeeping();
    if (!bookkeepingTimer) { bookkeepingTimer = setTimeout(() => { flushBookkeeping(); }, BOOKKEEPING_MS - (now() - lastBookkeeping)); bookkeepingTimer?.unref?.(); }
    return Promise.resolve();
  };
  async function recordError(message) {
    await updateState(draft => { draft.lastError = oneLine(message, 300); draft.lastErrorAt = isoNow(); }).catch(() => {});
  }

  // ---- the apply mutex and coalesced library writes ------------------------------------------------------------------
  let applyQueue = Promise.resolve();
  const exclusive = task => { const next = applyQueue.then(task, task); applyQueue = next.catch(() => {}); return next; };
  const buffer = [];
  let flushTimer = null, lastFlushAt = -Infinity, flushing = false;
  const scheduleFlush = () => {
    if (flushTimer || flushing || !buffer.length) return;
    // Not unref'd: a push is waiting on this write.
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, Math.max(0, lastFlushAt + writeIntervalMs - now()));
  };
  async function flush() {
    flushing = true;
    lastFlushAt = now();
    let batch = [];
    try {
      await exclusive(async () => {
        let count = 0;
        while (buffer.length && (!batch.length || count + buffer[0].entries.length <= MAX_WRITE_ENTRIES)) { const job = buffer.shift(); batch.push(job); count += job.entries.length; }
        const entries = batch.flatMap(job => job.entries);
        const ensure = new Map();
        for (const job of batch) for (const entry of job.ensureCollections) if (!ensure.has(entry.key)) ensure.set(entry.key, entry);
        const options = ensure.size ? { ensureCollections: [...ensure.values()] } : {};
        const result = await store.upsertChats(entries, options);
        const results = Array.isArray(result?.results) ? result.results : [];
        const collections = Array.isArray(result?.collections) ? result.collections : [];
        let offset = 0;
        for (const job of batch) {
          job.resolve({ results: job.entries.map((entry, index) => {
            const found = results[offset + index];
            return found?.id === entry.id ? found : results.find(row => row?.id === entry.id) || { threadKey: entry.threadKey, id: entry.id, status: 'skipped', reason: 'invalid' };
          }), collections });
          offset += job.entries.length;
        }
      });
    } catch (error) {
      for (const job of batch) job.reject(error);
    } finally {
      flushing = false;
      scheduleFlush();
    }
  }
  const submit = (entries, ensureCollections) => new Promise((resolve, reject) => {
    buffer.push({ entries, ensureCollections, resolve, reject });
    scheduleFlush();
  });

  // ---- dismissed chats (deleted forever by the user) ----------------------------------------------------------------
  // lib/chat-data.js keeps them in its 'dismissed' store; without it the library tombstone is the fallback signal.
  async function dismissedIds(ids, library) {
    if (!ids.length) return new Set();
    if (typeof chatData.dismissed === 'function') {
      try { return new Set(await chatData.dismissed(ids)); } catch (error) { log(error?.message); }
    }
    const graves = new Set((Array.isArray(library?.tombstones) ? library.tombstones : []).filter(t => t?.kind === 'item').map(t => t.id));
    return new Set(ids.filter(id => graves.has(id)));
  }
  const selfDeleting = new Set();
  async function deleteChatsForever(ids) {
    let deleted = 0;
    for (const id of ids) {
      selfDeleting.add(id);
      try { await store.permanentlyDeleteItem(id); deleted++; } catch (error) { log(error?.message); } finally { selfDeleting.delete(id); }
    }
    await chatData.delete(ids).catch(error => log(error?.message));
    return deleted;
  }

  // ---- outbound -----------------------------------------------------------------------------------------------------
  let readsInFlight = 0;
  const readWaiters = [];
  const readStamps = [];
  async function acquireRead() {
    while (readStamps.length && now() - readStamps[0] > 60000) readStamps.shift();
    if (readStamps.length >= READS_PER_MINUTE) return 60000 - (now() - readStamps[0]);
    readStamps.push(now());
    if (readsInFlight >= READS_IN_FLIGHT) await new Promise(resolve => readWaiters.push(resolve));
    readsInFlight++;
    return 0;
  }
  const releaseRead = () => { readsInFlight--; readWaiters.shift()?.(); };

  /** Sends one message to Threadkeeper → { ok: true, data } | { ok: false, error }. Never throws. */
  async function send(type, fields = {}, { to = '', timeoutMs } = {}) {
    const current = await getState();
    const target = to || (current.status === 'paired' ? current.extensionId : '');
    if (!isExtensionId(target)) return failure('not_paired');
    const limited = !PAIRING_TYPES.has(type);
    if (limited) {
      const waitMs = await acquireRead();
      if (waitMs > 0) return failure('busy', 'Still asked Threadkeeper too often. Try again in a moment.', waitMs);
    }
    let raw;
    try { raw = await transport(target, envelope(type, fields), timeoutMs ?? timeoutFor(type, fields)); }
    catch { return failure('unreachable'); }
    finally { if (limited) releaseRead(); }
    if (!isObject(raw) || raw.proto !== PROTO) return failure(raw === undefined ? 'unreachable' : 'internal', raw === undefined ? undefined : 'Threadkeeper sent a reply Still could not read.');
    if (jsonSize(raw) > MAX_MESSAGE_CHARS) return failure('too_large', 'Threadkeeper sent a reply that is too large.');
    if (raw.ok !== true) {
      const error = errorFromResponse(raw);
      if (error.code === 'not_paired') {
        await updateState(draft => {
          if (draft.status === 'paired' && draft.extensionId === target) { draft.status = 'revoked'; draft.configured = false; draft.lastError = errorText('not_paired'); draft.lastErrorAt = isoNow(); }
        }).catch(() => {});
      }
      return failure(error.code, error.message, error.retryAfterMs);
    }
    if (current.status === 'paired' && target === current.extensionId) bookkeeping({ seen: true });
    return { ok: true, data: sanitizeResponse(type, raw, fields) };
  }

  async function scheduleRetry(attempts) {
    const minutes = RETRY_MINUTES[Math.min(Math.max(attempts, 1), RETRY_MINUTES.length) - 1];
    try { await alarms?.create?.(RETRY_ALARM, { delayInMinutes: minutes }); } catch (error) { log(error?.message); }
  }

  /** sync.configure with Still's prefs and epoch. On failure configDirty stays set and the retry alarm backs off. */
  async function configure() {
    let current = await getState();
    if (current.status !== 'paired' || !current.configured) return null;
    if (!current.epoch) current = await updateState(draft => { draft.epoch ||= newEpoch(); });
    const result = await send('sync.configure', { prefs: syncPrefsOf(current.prefs), epoch: current.epoch });
    if (result.ok) {
      await updateState(draft => {
        draft.configDirty = false; draft.retry = { attempts: 0, at: '' }; draft.lastError = ''; draft.lastErrorAt = '';
        if (draft.backfill.startedAt && !draft.backfill.total) draft.backfill.total = result.data.total;
      });
      await Promise.resolve(alarms?.clear?.(RETRY_ALARM)).catch(() => {});
      return result;
    }
    if (result.error.code === 'not_paired') return result;
    const next = await updateState(draft => {
      if (draft.status !== 'paired') return;
      draft.configDirty = true; draft.retry = { attempts: Math.min(draft.retry.attempts + 1, 100), at: isoNow() };
      draft.lastError = result.error.message; draft.lastErrorAt = isoNow();
    });
    if (next.status === 'paired') await scheduleRetry(next.retry.attempts);
    return result;
  }

  async function hello() {
    const current = await getState();
    if (current.status !== 'paired') return null;
    const result = await send('hello', current.epoch ? { epoch: current.epoch } : {});
    if (!result.ok) return result;
    await updateState(draft => {
      if (draft.status !== 'paired' || draft.extensionId !== current.extensionId) return;
      if (result.data.tk) draft.tk = result.data.tk;
      if (result.data.paired === false) { draft.status = 'revoked'; draft.configured = false; draft.lastError = errorText('not_paired'); draft.lastErrorAt = isoNow(); }
    });
    return result;
  }

  // ---- applying threads (pushes, imports, refresh) ------------------------------------------------------------------
  const skipped = (threadKey, reason, held = null) => ({ threadKey, status: 'skipped', reason, ...(held?.id ? { itemId: held.id } : {}),
    ...(held?.chat?.fingerprint ? { fingerprint: held.chat.fingerprint } : {}), ...(Number.isFinite(held?.chat?.seq) ? { seq: held.chat.seq } : {}) });

  /**
   * origin: 'sync' | 'manual' (Threadkeeper's Send to Still or a picker import) | 'assistant' | 'refresh'.
   * Returns protocol results [{ threadKey, status, reason?, itemId?, fingerprint?, seq?, needsTranscript? }] in input order.
   */
  async function applyThreads(rawThreads, { origin = 'sync', target = null } = {}) {
    const results = new Array(rawThreads.length);
    const plan = await exclusive(async () => {
      const current = await getState();
      const { prefs } = current;
      const library = await readLibrary();
      const byId = new Map(items(library).map(item => [item.id, item]));
      const transcriptsOn = prefs.transcripts && current.tk.capabilities.includes('transcripts');
      const accepted = [];
      const newest = new Map();
      rawThreads.forEach((raw, index) => {
        let payload;
        try { payload = sanitizeThreadPayload(raw); } catch { results[index] = skipped(isThreadKey(raw?.threadKey) ? raw.threadKey : '', 'invalid'); return; }
        const earlier = newest.get(payload.threadKey);
        if (earlier !== undefined) {
          // The same thread twice in one batch: keep the newest.
          if (accepted[earlier].payload.seq > payload.seq) { results[index] = skipped(payload.threadKey, 'stale'); return; }
          results[accepted[earlier].index] = skipped(payload.threadKey, 'stale');
          accepted[earlier] = { payload, index };
          return;
        }
        newest.set(payload.threadKey, accepted.length);
        accepted.push({ payload, index });
      });
      const ids = accepted.map(({ payload }) => chatItemId(payload.threadKey));
      const dismissed = await dismissedIds(ids.filter(id => !byId.has(id)), library);
      // Library tombstones are not the dismissal signal (deleting a local-only chat or undoing an import leaves one too): a chat
      // the worker decided to take again clears its tombstone.
      const graves = new Set((Array.isArray(library?.tombstones) ? library.tombstones : []).filter(t => t?.kind === 'item').map(t => t.id));
      const decided = [];
      for (const { payload, index } of accepted) {
        const id = chatItemId(payload.threadKey);
        const existing = byId.get(id) || null;
        if (existing && (existing.type !== 'chat' || existing.chat?.threadKey !== payload.threadKey)) { results[index] = skipped(payload.threadKey, 'invalid'); continue; }
        if (!existing && dismissed.has(id) && origin !== 'manual') { results[index] = skipped(payload.threadKey, 'dismissed'); continue; }
        if (!existing && origin === 'sync' && (!current.configured || !inSyncScope(payload, prefs))) { results[index] = skipped(payload.threadKey, 'out_of_scope'); continue; }
        if (!existing && origin === 'refresh') { results[index] = skipped(payload.threadKey, 'invalid'); continue; }
        if (existing && origin === 'sync' && !prefs.autoUpdate && existing.chat?.removed !== 'local_only') { results[index] = skipped(payload.threadKey, 'out_of_scope', existing); continue; }
        if (existing?.deletedAt && origin !== 'manual' && origin !== 'refresh') {
          // Trashed: only Still's own metadata would change; nothing is stored until the user restores it.
          results[index] = skipped(payload.threadKey, 'trashed', existing); continue;
        }
        let record = null;
        try { record = await chatData.get(id); } catch (error) { log(error?.message); }
        const heldSeq = Math.max(Number(existing?.chat?.seq) || 0, Number(record?.thread?.seq) || 0);
        if (payload.seq && heldSeq && payload.seq < heldSeq) { results[index] = skipped(payload.threadKey, 'stale', existing); continue; }
        decided.push({ payload, index, id, existing, record });
      }
      const placement = planPlacement(decided.map(entry => entry.payload), prefs, library, current.collections, { origin, target });
      const entries = [], written = [];
      try {
        for (const entry of decided) {
          const { payload, id, existing, record } = entry;
          const incoming = transcriptsOn && payload.transcript.included ? payload.transcript : null;
          const before = record?.thread?.transcript;
          let transcript = null, meta;
          if (incoming) {
            let stored = null;
            if (!isContiguous(incoming.messages, incoming.totalMessages) && before?.stored && before.revision === incoming.revision) {
              try { stored = await chatData.getTranscript(id); } catch { stored = null; }
            }
            transcript = mergeTranscript(stored, { ...incoming, threadKey: payload.threadKey });
            meta = { revision: transcript.revision, truncated: transcript.truncated, totalMessages: transcript.totalMessages, stored: true };
          } else {
            const kept = !!before?.stored && before.revision === payload.revision;
            meta = { revision: payload.revision, truncated: kept ? before.truncated : false, totalMessages: payload.transcript.totalMessages || payload.messageCount, stored: kept };
          }
          const { transcript: _omit, ...thread } = payload;
          thread.transcript = meta;
          const unchangedRecord = record?.thread && record.thread.fingerprint === payload.fingerprint && record.thread.seq === payload.seq
            && !transcript && JSON.stringify(record.thread.transcript) === JSON.stringify(meta);
          if (!unchangedRecord) {
            // Transcript first, then the record (chat-data writes both in one transaction).
            await chatData.put(id, { thread, transcript });
            if (!existing) written.push(id);
          }
          entry.needsTranscript = transcriptsOn && !meta.stored;
          const chatOrigin = origin === 'refresh' ? existing?.chat?.origin || 'sync' : origin;
          const topics = (payload.analysis?.topics || []).map(topic => oneLine(topic, 40)).filter(Boolean).slice(0, 8);
          const revive = (origin === 'manual' && (!existing ? dismissed.has(id) : !!existing.deletedAt)) || (!existing && graves.has(id));
          if (revive && existing?.deletedAt) await store.restoreItem(id);
          entries.push({
            id, threadKey: payload.threadKey, fingerprint: payload.fingerprint, seq: payload.seq, origin: chatOrigin, revive,
            createdAt: payload.createdAt || payload.updatedAt || undefined,
            item: { title: payload.title, excerpt: payload.analysis?.gist || payload.gist, sourceUrl: payload.url, siteName: payload.providerLabel },
            chat: {
              v: 1, source: 'threadkeeper', threadKey: payload.threadKey, provider: payload.provider, providerLabel: payload.providerLabel,
              category: payload.category, kind: payload.kind, project: payload.project, model: payload.model, workflowState: payload.workflowState,
              messageCount: payload.messageCount, lastActivityAt: payload.updatedAt || '', topics,
              analysis: payload.analysis ? { source: payload.analysis.source, generatedAt: payload.analysis.generatedAt } : { source: '', generatedAt: '' },
              fingerprint: payload.fingerprint, revision: payload.revision, seq: payload.seq, analysisVersion: payload.analysisVersion,
              hasTranscript: meta.stored, transcriptTruncated: meta.stored && meta.truncated, origin: chatOrigin, syncedAt: isoNow(),
            },
            placement: placement.byThreadKey[payload.threadKey] || { collectionId: '' },
            ...(!existing && prefs.topicsAsTags && topics.length ? { tags: topics } : {}),
          });
          if (revive && !existing && typeof chatData.undismiss === 'function') await chatData.undismiss([id]).catch(error => log(error?.message));
        }
      } catch (error) {
        // Nothing reaches the library: chat data already written for new chats goes again, and Threadkeeper retries.
        await chatData.delete(written).catch(() => {});
        throw error;
      }
      return { entries, written, decided, placement, prefs };
    });

    if (plan.entries.length) {
      let outcome;
      try { outcome = await submit(plan.entries, plan.placement.ensureCollections); }
      catch (error) {
        // The library refused the batch: chat data written for chats it never took goes again.
        await chatData.delete(plan.written).catch(() => {});
        throw error;
      }
      const byId = new Map(outcome.results.map(row => [row.id, row]));
      const orphaned = [];
      const counts = { created: 0, updated: 0 };
      for (const entry of plan.decided) {
        const row = byId.get(entry.id) || { status: 'skipped', reason: 'invalid' };
        if (row.status === 'created') counts.created++;
        if (row.status === 'updated') counts.updated++;
        if (row.status === 'skipped' && !entry.existing && plan.written.includes(entry.id)) orphaned.push(entry.id);
        const held = row.status === 'skipped' ? entry.existing : null;
        results[entry.index] = {
          threadKey: entry.payload.threadKey, status: row.status, ...(row.reason ? { reason: row.reason } : {}),
          ...(row.status !== 'skipped' || held ? { itemId: entry.id } : {}),
          fingerprint: held ? held.chat?.fingerprint || '' : entry.payload.fingerprint,
          seq: held ? Number(held.chat?.seq) || 0 : entry.payload.seq,
          ...(row.status !== 'skipped' && entry.needsTranscript ? { needsTranscript: true } : {}),
        };
      }
      if (orphaned.length) await chatData.delete(orphaned).catch(() => {});
      await remember(plan.placement, outcome.collections);
      if (origin === 'manual' && target) await moveToTarget(plan, outcome.collections, target);
      bookkeeping({ counts });
    }
    return results.map((row, index) => row || skipped(isThreadKey(rawThreads[index]?.threadKey) ? rawThreads[index].threadKey : '', 'invalid'));
  }

  /** Mirror placement memory: matched and ensured collections are remembered per project. */
  async function remember(placement, collections) {
    const patch = { ...placement.remember };
    for (const { key, id } of collections || []) if (placement.memoryKeys[key] && typeof id === 'string' && id) patch[placement.memoryKeys[key]] = id;
    if (!Object.keys(patch).length) return;
    await updateState(draft => { Object.assign(draft.collections, patch); }).catch(error => log(error?.message));
  }

  /** A manual send with an explicit target moves chats that already existed elsewhere (one write). */
  async function moveToTarget(plan, collections, target) {
    await exclusive(async () => {
      const library = await readLibrary();
      const resolved = resolveTarget(target, library);
      const targetId = resolved?.ensure ? collections.find(entry => entry.key === resolved.ensure.key)?.id : resolved?.collectionId;
      if (typeof targetId !== 'string') return;
      const byId = new Map(items(library).map(item => [item.id, item]));
      const changes = plan.entries.map(entry => byId.get(entry.id)).filter(item => item && !item.deletedAt && (item.collectionId || '') !== targetId)
        .map(item => ({ id: item.id, patch: { collectionId: targetId, chat: { autoCollectionId: targetId } } }));
      if (changes.length) await store.bulkUpdateItems(changes);
    });
  }

  /** threads.remove: reason local_only deletes chat data (and untouched chats); others follow prefs.onRemoved. */
  async function removeThreads(threadKeys, reason) {
    return exclusive(async () => {
      const { prefs } = await getState();
      const library = await readLibrary();
      const byId = new Map(items(library).map(item => [item.id, item]));
      const results = [];
      const forever = [], strip = [], trash = [], keep = [];
      for (const threadKey of threadKeys) {
        const id = chatItemId(threadKey);
        const item = byId.get(id);
        if (!item || !isTkChat(item) || item.chat.threadKey !== threadKey) { results.push({ threadKey, status: 'missing' }); continue; }
        const touched = isUserTouched(item, library);
        if (reason === 'local_only') {
          (touched ? strip : forever).push(id);
          results.push({ threadKey, status: 'removed' });
        } else if (prefs.onRemoved === 'trash' && !touched && !item.deletedAt) {
          trash.push(id); results.push({ threadKey, status: 'removed' });
        } else {
          keep.push(id); results.push({ threadKey, status: 'kept' });
        }
      }
      if (reason === 'local_only' && (forever.length || strip.length)) {
        await chatData.delete([...forever, ...strip]).catch(error => log(error?.message));
        if (strip.length) await store.markChatsRemoved(strip.map(id => ({ id, reason })));
        if (forever.length) await deleteChatsForever(forever);
      }
      if (trash.length) await store.markChatsRemoved(trash.map(id => ({ id, reason })), { trash: true });
      if (keep.length) await store.markChatsRemoved(keep.map(id => ({ id, reason })));
      bookkeeping({ counts: { removed: forever.length + strip.length + trash.length } });
      return results;
    });
  }

  function chatsStatus(threadKeys, library) {
    const byId = new Map(items(library).map(item => [item.id, item]));
    const names = new Map((Array.isArray(library?.collections) ? library.collections : []).filter(isObject).map(c => [c.id, c]));
    const chats = {};
    for (const threadKey of threadKeys) {
      const item = byId.get(chatItemId(threadKey));
      if (!item || !isTkChat(item) || item.chat.threadKey !== threadKey || item.chat.removed === 'local_only') continue;
      const collection = names.get(item.collectionId);
      chats[threadKey] = { itemId: item.id, collectionId: collection && !collection.deletedAt ? item.collectionId : '',
        collectionName: collection && !collection.deletedAt ? oneLine(collection.name, 120) : '', trashed: !!item.deletedAt,
        hasTranscript: item.chat.hasTranscript === true, transcriptRevision: item.chat.hasTranscript === true ? Number(item.chat.revision) || 0 : null };
    }
    return chats;
  }

  // ---- pairing ------------------------------------------------------------------------------------------------------
  async function markPaired(extensionId, tk) {
    const next = await updateState(draft => {
      draft.status = 'paired'; draft.extensionId = extensionId; draft.pending = null; draft.tk = tk || draft.tk;
      draft.pairedAt = isoNow(); draft.lastSeenAt = isoNow(); draft.epoch ||= newEpoch();
      draft.configured = false; draft.configDirty = false; draft.backfill = { total: 0, startedAt: '', paused: false };
      draft.retry = { attempts: 0, at: '' }; draft.lastError = ''; draft.lastErrorAt = '';
    });
    // Chats a disconnect moved to Trash come back with the new pairing.
    exclusive(async () => {
      const library = await readLibrary();
      const back = items(library).filter(item => isTkChat(item) && item.deletedAt && item.chat.removed === 'disconnected');
      for (const item of back) await store.restoreItem(item.id);
      if (back.length) await store.bulkUpdateItems(back.map(item => ({ id: item.id, patch: { chat: { removed: '' } } })));
    }).catch(error => log(error?.message));
    return next;
  }

  // ---- inbound ------------------------------------------------------------------------------------------------------
  const senderQueues = new Map();
  let pushesWaiting = 0, helloBack = null;
  const inSenderQueue = (senderId, task) => {
    const previous = senderQueues.get(senderId) || Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => {});
    senderQueues.set(senderId, settled);
    settled.then(() => { if (senderQueues.get(senderId) === settled) senderQueues.delete(senderId); });
    return next;
  };

  async function handleExternalMessage(message, sender) {
    try {
      const current = await getState();
      const senderId = isObject(sender) && isExtensionId(sender.id) ? sender.id : '';
      if (!senderId || !isTrustedSender(sender, senderId)) return errorResponse('not_paired', 'Only Threadkeeper’s own pages can talk to Still.');
      if (!isObject(message)) return errorResponse('bad_request', 'Messages must be objects.');
      if (message.proto !== PROTO) return errorResponse('version_mismatch', `Still speaks ${PROTO}.`);
      const paired = current.status === 'paired' && current.extensionId === senderId;
      const pending = current.status === 'pending' && current.pending?.extensionId === senderId;
      const type = typeof message.type === 'string' ? message.type : '';
      if (!paired && !UNPAIRED_TYPES.includes(type)) {
        return pending && MESSAGE_TYPES_IN.includes(type) ? errorResponse('pending_approval') : errorResponse('not_paired', 'Still is not connected to this extension.');
      }
      if (!MESSAGE_TYPES_IN.includes(type)) return errorResponse('unsupported', `Still does not handle ${oneLine(type, 60) || 'that'}.`);
      if (message.from !== undefined && message.from !== 'threadkeeper') return errorResponse('bad_request', 'Messages to Still come from Threadkeeper.');
      if (jsonSize(message) > MAX_MESSAGE_CHARS) return errorResponse('too_large', 'Send at most 4 MB at a time.');
      if (type === 'hello' && !paired) return okResponse({ app: 'still', version: version(), paired: false });
      const push = type === 'threads.upsert' || type === 'threads.remove';
      if (push && pushesWaiting >= 2) return errorResponse('busy', 'Still is saving earlier threads.', writeIntervalMs);
      if (push) pushesWaiting++;
      try { return await inSenderQueue(senderId, () => dispatchInbound(type, message, senderId)); }
      finally { if (push) pushesWaiting--; }
    } catch (error) {
      log(error?.message);
      return errorResponse('internal', 'Still could not handle that message.');
    }
  }

  async function dispatchInbound(type, message, senderId) {
    const current = await getState();
    const paired = current.status === 'paired' && current.extensionId === senderId;
    if (paired) bookkeeping({ seen: true });
    switch (type) {
      case 'hello': {
        // The paired Threadkeeper is back: a sync.configure that failed earlier goes out now instead of at the next retry.
        // Threadkeeper says hello when one of its integration toggles changed: refresh its capabilities (once per burst).
        if (current.configDirty) setTimeout(() => { configure().catch(error => log(error?.message)); }, 0);
        if (!helloBack) helloBack = setTimeout(() => { helloBack = null; hello().catch(error => log(error?.message)); }, 1000);
        return okResponse({ app: 'still', version: version(), paired: true, epoch: current.epoch });
      }
      case 'pair.granted': case 'pair.denied': {
        if (paired && type === 'pair.granted') return okResponse({});   // a repeated delivery after Still already acknowledged
        const waiting = current.status === 'pending' && current.pending?.extensionId === senderId && !pendingExpired(current, now());
        if (!waiting || typeof message.requestId !== 'string' || message.requestId !== current.pending.requestId) {
          return errorResponse('not_paired', 'No pairing request from Still is waiting.');
        }
        if (type === 'pair.denied') {
          await updateState(draft => { draft.status = 'denied'; draft.pending = null; draft.lastError = errorText('denied'); draft.lastErrorAt = isoNow(); });
          return okResponse({});
        }
        const tk = sanitizeResponse('hello', { tk: message.tk }).tk;
        await markPaired(senderId, tk);
        return okResponse({});
      }
      case 'pair.revoke': {
        await updateState(draft => {
          if (draft.extensionId !== senderId) return;
          draft.status = 'revoked'; draft.configured = false; draft.configDirty = false; draft.pending = null;
          draft.lastError = 'Threadkeeper disconnected. Your chats stay in Still.'; draft.lastErrorAt = isoNow();
        });
        return okResponse({});
      }
      case 'threads.upsert': {
        const threads = message.threads;
        if (!Array.isArray(threads) || !threads.length || threads.length > LIMITS.upsertThreads) return errorResponse('bad_request', `Send 1 to ${LIMITS.upsertThreads} threads at a time.`);
        if (!UPSERT_ORIGINS.includes(message.origin)) return errorResponse('bad_request', 'Say whether this is a sync or a manual send.');
        let target = null;
        if (message.target !== undefined && message.target !== null) {
          if (!isObject(message.target)) return errorResponse('bad_request', 'The target must be a collection.');
          const { collectionId, collectionName } = message.target;
          if (typeof collectionId === 'string' && collectionId.length <= 200) target = { collectionId };
          else if (typeof collectionName === 'string' && oneLine(collectionName, 80)) target = { collectionName: oneLine(collectionName, 80) };
          else if (collectionId !== undefined || collectionName !== undefined) return errorResponse('bad_request', 'The target must be a collection.');
        }
        const results = await applyThreads(threads, { origin: message.origin, target: message.origin === 'manual' ? target : null });
        return okResponse({ results });
      }
      case 'threads.remove': {
        const keys = message.threadKeys;
        if (!Array.isArray(keys) || keys.length > LIMITS.removeKeys || !keys.every(isThreadKey)) return errorResponse('bad_request', `Send up to ${LIMITS.removeKeys} thread keys.`);
        if (!REMOVE_REASONS.includes(message.reason)) return errorResponse('bad_request', 'Say why these threads left Threadkeeper.');
        return okResponse({ results: await removeThreads([...new Set(keys)], message.reason) });
      }
      case 'collections.list': return okResponse({ collections: listCollections(await readLibrary()) });
      case 'chats.status': {
        const keys = message.threadKeys;
        if (!Array.isArray(keys) || keys.length > LIMITS.statusKeys || !keys.every(isThreadKey)) return errorResponse('bad_request', `Ask about up to ${LIMITS.statusKeys} threads.`);
        return okResponse({ chats: chatsStatus(keys, await readLibrary()) });
      }
      default: return errorResponse('unsupported');
    }
  }

  // ---- page requests ------------------------------------------------------------------------------------------------
  const requirePaired = async () => {
    const current = await getState();
    if (current.status !== 'paired') throw new ThreadkeeperError('not_paired', current.status === 'pending' ? errorText('pending_approval') : 'Connect Threadkeeper in Settings first.');
    return current;
  };
  const unwrap = result => { if (!result.ok) throw toError(result); return result.data; };
  const transcriptMode = current => (current.prefs.transcripts && current.tk.capabilities.includes('transcripts') ? 'full' : 'none');

  async function getThreads(fields, current) {
    const threads = [], missing = [];
    let queue = [...(fields.threadKeys || [])], cites = [...(fields.citeIds || [])];
    for (let rounds = 0; (queue.length || cites.length) && rounds < 40; rounds++) {
      const batch = queue.splice(0, IMPORT_BATCH), citeBatch = batch.length ? [] : cites.splice(0, IMPORT_BATCH);
      const request = sanitizeRequestFields('threads.get', { ...(batch.length ? { threadKeys: batch } : { citeIds: citeBatch }),
        transcript: fields.transcript || transcriptMode(current), track: fields.track !== false, ...(fields.window ? { window: fields.window } : {}) });
      const data = unwrap(await send('threads.get', request));
      threads.push(...data.threads);
      missing.push(...data.missing);
      const asked = new Set([...batch, ...citeBatch]);
      const deferred = data.deferred.filter(key => asked.has(key));
      if (deferred.length && deferred.length === asked.size && !data.threads.length) break;   // no progress: stop instead of looping
      if (batch.length) queue = [...deferred, ...queue]; else cites = [...deferred, ...cites];
    }
    return { threads, missing };
  }

  const ops = {
    async state() { return publicState(await getState(), { now: now() }); },

    async connect({ extensionId } = {}) {
      if (!isExtensionId(extensionId)) throw new ThreadkeeperError('bad_request', 'Paste the 32-letter ID shown in Threadkeeper → Settings → Sidebar Dock.');
      if (extensionId === selfId) throw new ThreadkeeperError('bad_request', 'That is Still’s own ID. Copy the one Threadkeeper shows.');
      let current = await getState();
      if (current.status === 'paired' && current.extensionId === extensionId) return { status: 'paired' };
      if (current.status === 'paired') throw new ThreadkeeperError('busy', 'Still is connected to another Threadkeeper. Disconnect it first.');
      const probe = await send('hello', {}, { to: extensionId, timeoutMs: 5000 });
      if (!probe.ok) {
        if (probe.error.code === 'unreachable') throw new ThreadkeeperError('unreachable', 'No Threadkeeper answered at that ID. Check that it is installed and turned on.');
        throw toError(probe);
      }
      if (probe.data.app !== 'threadkeeper') throw new ThreadkeeperError('bad_request', 'That extension is not Threadkeeper.');
      const reuse = current.status === 'pending' && current.pending?.extensionId === extensionId && current.pending.code;
      current = await updateState(draft => {
        draft.status = 'pending'; draft.extensionId = extensionId; draft.epoch = reuse && draft.epoch ? draft.epoch : newEpoch();
        draft.pending = reuse ? draft.pending : { requestId: newRequestId(), extensionId, at: isoNow(), code: randomCode() };
        draft.configured = false; draft.configDirty = false; draft.lastError = ''; draft.lastErrorAt = '';
      });
      const result = await send('pair.request', { appName: APP_NAME, appVersion: version(), code: current.pending.code, epoch: current.epoch }, { to: extensionId });
      if (result.ok) {
        if (result.data.status === 'paired') { await markPaired(extensionId, result.data.tk); return { status: 'paired' }; }
        return { status: 'pending', code: current.pending.code };
      }
      await updateState(draft => {
        if (draft.pending?.requestId !== current.pending.requestId) return;
        draft.pending = null;
        draft.status = result.error.code === 'denied' ? 'denied' : 'off';
        draft.lastError = result.error.message; draft.lastErrorAt = isoNow();
      });
      if (result.error.code === 'busy') throw new ThreadkeeperError('busy', 'Threadkeeper is connected to another extension or already has a request open. Disconnect or finish it in Threadkeeper first.');
      throw toError(result);
    },

    /** Liveness probe (settings status, warming Threadkeeper before an assistant turn): { reachable, tk, version }. */
    async ping() {
      await requirePaired();
      const result = await hello();
      if (!result?.ok) return { reachable: false, code: result?.error?.code || 'unreachable' };
      return { reachable: true, version: result.data.version, tk: (await getState()).tk };
    },

    async cancel() {
      await updateState(draft => { if (draft.status === 'pending') { draft.status = 'off'; draft.pending = null; } });
      return { status: (await getState()).status };
    },

    async disconnect({ removeChats = false } = {}) {
      const current = await getState();
      if (current.status === 'paired') await send('pair.revoke', {}, { timeoutMs: 3000 });
      await updateState(draft => {
        draft.status = 'off'; draft.pending = null; draft.configured = false; draft.configDirty = false; draft.epoch = newEpoch();
        draft.tk = { version: '', capabilities: [] }; draft.backfill = { total: 0, startedAt: '', paused: false }; draft.retry = { attempts: 0, at: '' };
        draft.lastError = ''; draft.lastErrorAt = '';
      });
      await Promise.resolve(alarms?.clear?.(RETRY_ALARM)).catch(() => {});
      if (removeChats !== true) return { removed: 0, kept: 0 };
      return exclusive(async () => {
        const library = await readLibrary();
        const chats = items(library).filter(item => isTkChat(item) && !item.deletedAt);
        const untouched = chats.filter(item => !isUserTouched(item, library));
        if (untouched.length) await store.markChatsRemoved(untouched.map(item => ({ id: item.id, reason: 'disconnected' })), { trash: true });
        return { removed: untouched.length, kept: chats.length - untouched.length };
      });
    },

    async setPrefs({ patch } = {}) {
      const before = await getState();
      let prefs;
      try { prefs = patchPrefs(before.prefs, patch); } catch (error) { throw new ThreadkeeperError('bad_request', error.message); }
      const after = await updateState(draft => { draft.prefs = prefs; if (draft.configured && syncPrefsChanged(before.prefs, prefs)) draft.configDirty = true; });
      if (after.configured && after.configDirty) await configure();
      return publicState(await getState(), { now: now() });
    },

    async startSync({ patch } = {}) {
      const before = await requirePaired();
      let prefs = before.prefs;
      if (patch !== undefined) { try { prefs = patchPrefs(before.prefs, patch); } catch (error) { throw new ThreadkeeperError('bad_request', error.message); } }
      await updateState(draft => {
        draft.prefs = prefs; draft.configured = true; draft.configDirty = true; draft.epoch ||= newEpoch();
        draft.backfill = { total: 0, startedAt: isoNow(), paused: false };
      });
      const result = await configure();
      if (result?.ok) return { queued: result.data.queued, total: result.data.total, retrying: false };
      if (result && result.error.code === 'not_paired') throw toError(result);
      return { queued: 0, total: 0, retrying: true };
    },

    async syncNow() {
      const current = await requirePaired();
      if (!current.configured) throw new ThreadkeeperError('bad_request', 'Choose what to sync first.');
      if (current.configDirty) { const configured = await configure(); if (configured && !configured.ok) throw toError(configured); }
      return unwrap(await send('sync.resync', { epoch: (await getState()).epoch }));
    },

    async request({ type, fields = {}, timeoutMs } = {}) {
      if (!READ_TYPES.includes(type)) throw new ThreadkeeperError('unsupported', 'Still cannot ask Threadkeeper for that.');
      await requirePaired();
      const clean = sanitizeRequestFields(type, fields);
      if (type === 'threads.get') clean.track = false;   // tracking happens only through imports
      const limit = Number.isFinite(timeoutMs) ? clampInt(timeoutMs, 500, 60000) : undefined;
      return unwrap(await send(type, clean, { timeoutMs: limit }));
    },

    async importThreads({ threadKeys = [], citeIds = [], target = null, origin = 'manual' } = {}) {
      const current = await requirePaired();
      const keys = [...new Set((Array.isArray(threadKeys) ? threadKeys : []).filter(isThreadKey))].slice(0, LIMITS.importKeys);
      const cites = [...new Set((Array.isArray(citeIds) ? citeIds : []).filter(id => typeof id === 'string' && /^tk:[0-9a-f]{16}$/.test(id)))].slice(0, LIMITS.importKeys);
      if (!keys.length && !cites.length) throw new ThreadkeeperError('bad_request', 'Choose at least one thread.');
      const from = origin === 'assistant' ? 'assistant' : 'manual';
      const place = isObject(target) ? (typeof target.collectionId === 'string' ? { collectionId: target.collectionId.slice(0, 200) }
        : typeof target.collectionName === 'string' && oneLine(target.collectionName, 80) ? { collectionName: oneLine(target.collectionName, 80) } : null) : null;
      const { threads, missing } = await getThreads({ threadKeys: keys, citeIds: cites, track: true }, current);
      const results = [];
      for (let start = 0; start < threads.length; start += IMPORT_BATCH) {
        results.push(...await applyThreads(threads.slice(start, start + IMPORT_BATCH), { origin: from, target: place }));
      }
      for (const key of missing) results.push({ threadKey: key, status: 'skipped', reason: 'missing' });
      const tally = status => results.filter(row => row.status === status).length;
      return { results, created: tally('created'), updated: tally('updated'), unchanged: tally('unchanged'), skipped: tally('skipped') };
    },

    async refreshChat({ id } = {}) {
      const current = await requirePaired();
      const item = items(await readLibrary()).find(entry => entry.id === id);
      if (!item || !isTkChat(item)) throw new ThreadkeeperError('not_found', 'That chat is not in Still.');
      const { threads } = await getThreads({ threadKeys: [item.chat.threadKey], track: true }, current);
      if (!threads.length) throw new ThreadkeeperError('not_found', 'Threadkeeper no longer shares this thread.');
      const [result] = await applyThreads(threads.slice(0, 1), { origin: 'refresh' });
      return result;
    },

    async loadTranscriptWindow({ id, from = 0, count = 200 } = {}) {
      const current = await requirePaired();
      const item = items(await readLibrary()).find(entry => entry.id === id);
      if (!item || !isTkChat(item)) throw new ThreadkeeperError('not_found', 'That chat is not in Still.');
      const window = { from: clampInt(from, 0, 1e6, 0), count: clampInt(count, 1, LIMITS.windowCount, 200) };
      const { threads } = await getThreads({ threadKeys: [item.chat.threadKey], transcript: 'window', window, track: true }, current);
      const payload = threads[0];
      if (!payload) throw new ThreadkeeperError('not_found', 'Threadkeeper no longer shares this thread.');
      if (!payload.transcript.included) throw new ThreadkeeperError('disabled', 'Transcript sharing is turned off in Threadkeeper.');
      const windowOut = { revision: payload.transcript.revision, totalMessages: payload.transcript.totalMessages, messages: payload.transcript.messages };
      if (!current.prefs.transcripts) return { ...windowOut, stored: false, stale: false, truncated: true };
      return exclusive(async () => {
        const record = await chatData.get(id).catch(() => null);
        if (!record?.thread || record.thread.revision !== payload.transcript.revision) return { ...windowOut, stored: false, stale: true, truncated: true };
        const stored = record.thread.transcript?.stored ? await chatData.getTranscript(id).catch(() => null) : null;
        const merged = mergeTranscript(stored, { ...payload.transcript, threadKey: payload.threadKey });
        const meta = { revision: merged.revision, truncated: merged.truncated, totalMessages: merged.totalMessages, stored: true };
        await chatData.put(id, { thread: { ...record.thread, transcript: meta }, transcript: merged });
        if (item.chat.hasTranscript !== true || item.chat.transcriptTruncated !== merged.truncated) {
          await store.bulkUpdateItems([{ id, patch: { chat: { hasTranscript: true, transcriptTruncated: merged.truncated } } }]);
        }
        return { ...windowOut, stored: true, stale: false, truncated: merged.truncated };
      });
    },

    async undoImport({ ids = [] } = {}) {
      const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter(isChatItemId))].slice(0, LIMITS.importKeys);
      return exclusive(async () => {
        const library = await readLibrary();
        const present = new Set(items(library).filter(isTkChat).map(item => item.id));
        return { deleted: await deleteChatsForever(wanted.filter(id => present.has(id))) };
      });
    },

    async impact({ patch, disconnect = false } = {}) {
      const current = await getState();
      const library = await readLibrary();
      const chats = items(library).filter(item => isTkChat(item) && !item.deletedAt && item.chat.removed !== 'local_only');
      const untouched = chats.filter(item => !isUserTouched(item, library));
      const out = { chats: chats.length, untouched: untouched.length, touched: chats.length - untouched.length, replace: 0, transcripts: 0, outOfScope: 0 };
      if (disconnect || !isObject(patch)) return out;
      let next;
      try { next = patchPrefs(current.prefs, patch); } catch (error) { throw new ThreadkeeperError('bad_request', error.message); }
      if (PLACEMENT_PREFS.some(key => JSON.stringify(next[key]) !== JSON.stringify(current.prefs[key]))) out.replace = untouched.length;
      if (current.prefs.transcripts && !next.transcripts) out.transcripts = chats.filter(item => item.chat.hasTranscript === true).length;
      out.outOfScope = chats.filter(item => item.chat.origin === 'sync' && !inSyncScope(item.chat, next)).length;
      return out;
    },

    async replaceChats() {
      const current = await getState();
      return exclusive(async () => {
        const library = await readLibrary();
        const untouched = items(library).filter(item => isTkChat(item) && !item.deletedAt && item.chat.removed !== 'local_only' && !isUserTouched(item, library));
        const plan = planPlacement(untouched.map(item => ({ threadKey: item.chat.threadKey, project: item.chat.project })), current.prefs, library, current.collections);
        const ids = new Map();
        for (const entry of plan.ensureCollections) {
          const parentId = entry.parentId || (entry.parentKey ? ids.get(entry.parentKey) || '' : '');
          const created = await store.createCollection({ name: entry.name, parentId });
          ids.set(entry.key, created.id);
        }
        const changes = [];
        for (const item of untouched) {
          const place = plan.byThreadKey[item.chat.threadKey];
          const collectionId = place?.collectionKey ? ids.get(place.collectionKey) : place?.collectionId;
          if (typeof collectionId === 'string' && collectionId !== (item.collectionId || '')) changes.push({ id: item.id, patch: { collectionId, chat: { autoCollectionId: collectionId } } });
        }
        for (let start = 0; start < changes.length; start += 500) await store.bulkUpdateItems(changes.slice(start, start + 500));
        await remember(plan, [...ids].map(([key, id]) => ({ key, id })));
        return { moved: changes.length };
      });
    },

    async removeTranscripts() {
      return exclusive(async () => {
        const library = await readLibrary();
        const chats = items(library).filter(item => isTkChat(item) && item.chat.hasTranscript === true);
        for (const item of chats) {
          const record = await chatData.get(item.id).catch(() => null);
          await chatData.delete([item.id]);
          if (record?.thread) await chatData.put(item.id, { thread: { ...record.thread, transcript: { ...(record.thread.transcript || {}), stored: false, truncated: false } }, transcript: null });
        }
        for (let start = 0; start < chats.length; start += 500) {
          await store.bulkUpdateItems(chats.slice(start, start + 500).map(item => ({ id: item.id, patch: { chat: { hasTranscript: false, transcriptTruncated: false } } })));
        }
        return { removed: chats.length };
      });
    },
  };

  /** Page proxy: never throws. */
  async function handleRequest(op, args = {}) {
    try {
      if (typeof op !== 'string' || !Object.hasOwn(ops, op)) throw new ThreadkeeperError('unsupported', 'Unknown Threadkeeper request.');
      return { ok: true, data: await ops[op](isObject(args) ? args : {}) };
    } catch (error) {
      const code = error instanceof ThreadkeeperError ? error.code : 'internal';
      return { ok: false, error: { code, message: error?.message || errorText(code), ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}) } };
    }
  }

  // ---- hooks --------------------------------------------------------------------------------------------------------
  /** Store onCommit: chats deleted forever lose their chat data; the user's own deletions become dismissals. */
  function onCommit(change) {
    const deleted = (Array.isArray(change?.deleted?.items) ? change.deleted.items : []).filter(isChatItemId);
    if (!deleted.length) return Promise.resolve();
    const byUser = deleted.filter(id => !selfDeleting.has(id));
    return (async () => {
      await chatData.delete(deleted).catch(error => log(error?.message));
      if (!byUser.length) return;
      if (typeof chatData.dismiss === 'function') await chatData.dismiss(byUser).catch(error => log(error?.message));
      const current = await getState();
      if (current.status === 'paired') await send('threads.untrack', { hashes: byUser.map(hashOfChatId) });
    })().catch(error => log(error?.message));
  }

  async function sweep() {
    return exclusive(async () => {
      const library = await readLibrary();
      const present = new Set(items(library).map(item => item.id));
      let stored = [];
      try { stored = await chatData.ids(); } catch (error) { log(error?.message); return { deleted: 0 }; }
      const orphans = [];
      for (const id of stored) {
        if (present.has(id)) continue;
        const record = await chatData.get(id).catch(() => null);
        const age = now() - (Date.parse(record?.storedAt) || 0);
        if (age > ORPHAN_AGE_MS) orphans.push(id);
      }
      if (orphans.length) await chatData.delete(orphans).catch(error => log(error?.message));
      // The chat store went missing (cleared site data, a new profile copy): Threadkeeper must re-offer everything.
      const chats = items(library).filter(item => isTkChat(item) && !item.deletedAt && item.chat.removed !== 'local_only');
      if (chats.length && !stored.length) await updateState(draft => { draft.epoch = newEpoch(); });
      return { deleted: orphans.length, lost: chats.length > 0 && !stored.length };
    });
  }

  async function ensureAlarms() {
    if (!alarms?.create) return;
    const all = (await alarms.getAll?.()) || [];
    if (!all.some(alarm => alarm?.name === SWEEP_ALARM)) await alarms.create(SWEEP_ALARM, { periodInMinutes: 1440 });
  }

  async function liveness() {
    const result = await hello();
    if (result?.ok && (await getState()).configDirty) await configure();
    return result;
  }

  return {
    handleExternalMessage, handleRequest, onCommit, send, configure, applyThreads, removeThreads, sweep,
    /** Every worker start: alarms only (never blocks, never messages Threadkeeper). */
    async init() { await ensureAlarms().catch(error => log(error?.message)); },
    /** onStartup / onInstalled, after the startup gate: orphan sweep, then a liveness hello. */
    async startup() {
      await ensureAlarms().catch(error => log(error?.message));
      await sweep().catch(error => log(error?.message));
      await liveness().catch(error => log(error?.message));
    },
    /** Returns true when the alarm belonged to the Threadkeeper link. */
    async handleAlarm(alarm) {
      if (alarm?.name === RETRY_ALARM) { await configure(); return true; }
      if (alarm?.name === SWEEP_ALARM) { await sweep(); await liveness(); return true; }
      return false;
    },
    /** After a snapshot restore or a backup import: Threadkeeper must not trust what it believes Still holds. */
    async onDataRestored() {
      const next = await updateState(draft => { draft.epoch = newEpoch(); if (draft.configured) draft.configDirty = true; });
      if (next.status !== 'paired') return;
      await hello();
      if (next.configured) await configure();
    },
    invalidate() { cached = null; },
    async flushBookkeeping() { await flushBookkeeping(); },
    getState,
  };
}

let service = null;
/** Called once by the service worker. Returns the service (tests call its methods directly). */
export function configureThreadkeeperWorker(deps) { return service = createThreadkeeperWorker(deps); }
export const threadkeeperWorker = () => service;
export async function handleExternalMessage(message, sender) {
  return service ? service.handleExternalMessage(message, sender) : errorResponse('internal', 'Still is starting. Try again in a moment.');
}
export async function handleThreadkeeperRequest(op, args) {
  return service ? service.handleRequest(op, args) : { ok: false, error: { code: 'unavailable', message: errorText('unavailable') } };
}
export { THREADKEEPER_MESSAGE as THREADKEEPER_MESSAGE_TYPE, PARENT_MEMORY };
