/*
 * Still's own copy of each AI chat's thread data: the Threadkeeper analysis (summary record) and the transcript. They live
 * in IndexedDB 'still.chats.v1', next to the compact `chat` item in the library (lib/store.js), so chats keep working
 * when Threadkeeper is disabled or gone. Never in chrome.storage (and so never in snapshots); full backups carry them as
 * the optional `chats` part (lib/portability.js).
 *
 * Stores (version 1, keyPath `id` = the chat item id, 'chat_tk_' + threadHash(threadKey)):
 *   records      { id, threadKey, fingerprint, revision, seq, storedAt, bytes,
 *                  transcript: null | { revision, totalMessages, stored, truncated, bytes, storedAt },   // mirrors the row
 *                  thread }                     // the sanitized ThreadPayload without its transcript
 *   transcripts  { id, threadKey, revision, truncated, totalMessages, messages: [{ index, role, content, createdAt }],
 *                  storedAt, bytes }            // messages sorted by 0-based index; may have gaps (truncated)
 *   dismissed    { id, at }                     // chats the user deleted forever (sync never recreates them)
 *   meta         { id: 'store', storeId, createdAt }   // a new storeId means the chat store was lost or recreated
 *
 * Rules: a record and its transcript are written in one transaction. A put without a transcript keeps the stored one only
 * when it belongs to the record's new revision (a stale transcript never pairs with a newer summary). A put whose `seq` is
 * older than the stored one is refused (stale). Writes in one context are serialized; the extension writes only from the
 * service worker (pages read). Without IndexedDB (Node tests) everything works in memory.
 */
import { chatItemId } from './threadkeeper/protocol.js';

export const CHAT_DB = 'still.chats.v1';
export const CHAT_DB_VERSION = 1;
export const CHAT_DATA_STORES = Object.freeze(['records', 'transcripts', 'dismissed', 'meta']);
export const CHAT_DATA_LIMITS = Object.freeze({
  recordBytes: 1024 * 1024,        // one summary record (JSON characters)
  messages: 20000,                 // stored messages per transcript (windows merge up to this)
  messageChars: 121000,            // 120,000 + Threadkeeper's "[… cut: N more characters]" marker
  transcriptChars: 32 * 1024 * 1024,
  sweepAgeMs: 10 * 60 * 1000,      // the orphan sweep leaves rows younger than this (an apply may be in flight)
  backupRecords: 100000,
});
const ROLES = new Set(['user', 'assistant', 'system', 'tool']);
const CHAT_ID = /^chat_tk_[0-9a-f]{32}$/;
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value : '');
const count = value => { const n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? n : 0; };
const isoOrNull = value => { const time = Date.parse(text(value)); return Number.isFinite(time) ? new Date(time).toISOString() : null; };
const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/** True for a chat item id ('chat_tk_' + 32 hex). */
export const isChatId = value => typeof value === 'string' && CHAT_ID.test(value);

/* ------------------------------------------------------------------ validation (shared by puts and backups) */

function checkId(id, threadKey) {
  if (!isChatId(id)) throw new Error('A chat has an invalid ID.');
  if (typeof threadKey !== 'string' || !threadKey.trim() || threadKey.length > 600 || chatItemId(threadKey) !== id) throw new Error('A chat does not match its Threadkeeper thread.');
}

// The stored summary: the payload without its transcript (that has its own store), JSON-safe and bounded.
function cleanThread(thread) {
  if (!isObject(thread)) throw new Error('A chat needs its thread data.');
  const { transcript: _transcript, ...rest } = thread;
  let json;
  try { json = JSON.stringify(rest); } catch { throw new Error('A chat\'s thread data cannot be stored.'); }
  if (json.length > CHAT_DATA_LIMITS.recordBytes) throw new Error('A chat\'s summary is too large to store.');
  return { thread: JSON.parse(json), bytes: json.length };
}

// Messages: known roles, 0-based integer index, bounded text; one per index (the later wins), sorted. Over the count or
// character budget the first 20 and the newest messages are kept.
function cleanMessages(messages) {
  const byIndex = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isObject(message) || !ROLES.has(message.role) || typeof message.content !== 'string') continue;
    const index = Number(message.index);
    if (!Number.isSafeInteger(index) || index < 0) continue;
    byIndex.set(index, { index, role: message.role, content: message.content.slice(0, CHAT_DATA_LIMITS.messageChars), createdAt: isoOrNull(message.createdAt) });
  }
  const list = [...byIndex.values()].sort((a, b) => a.index - b.index);
  let cut = false;
  if (list.length > CHAT_DATA_LIMITS.messages) { list.splice(20, list.length - CHAT_DATA_LIMITS.messages); cut = true; }
  let chars = list.reduce((sum, message) => sum + message.content.length, 0), drop = 0;
  while (chars > CHAT_DATA_LIMITS.transcriptChars && 20 + drop < list.length - 1) chars -= list[20 + drop++].content.length;
  if (drop) { list.splice(20, drop); cut = true; }
  return { messages: list, cut };
}
const contiguous = (messages, total) => messages.length === total && messages.every((message, position) => message.index === position);
const transcriptBytes = messages => messages.reduce((sum, message) => sum + message.content.length + 64, 0);

function transcriptRow(id, threadKey, raw, storedAt) {
  const { messages, cut } = cleanMessages(raw.messages);
  const totalMessages = Math.max(count(raw.totalMessages), messages.length ? messages.at(-1).index + 1 : 0);
  return { id, threadKey, revision: count(raw.revision), truncated: cut || !contiguous(messages, totalMessages), totalMessages, messages, storedAt, bytes: transcriptBytes(messages) };
}
const transcriptMeta = row => (row ? { revision: row.revision, totalMessages: row.totalMessages, stored: row.messages.length, truncated: row.truncated, bytes: row.bytes, storedAt: row.storedAt } : null);

/*
 * The `chats` part of a full backup: { version: 1, records, transcripts }. Strict: any problem throws (nothing is
 * written). `chatIds` (optional) are the chat item ids in the same backup: data for any other id is refused.
 */
export function validateChatBackup(part, { chatIds = null } = {}) {
  if (part === undefined || part === null) return null;
  if (!isObject(part) || part.version !== 1 || !Array.isArray(part.records) || !Array.isArray(part.transcripts)) throw new Error('The AI chats in this backup are not in a form Still can read.');
  if (part.records.length > CHAT_DATA_LIMITS.backupRecords || part.transcripts.length > CHAT_DATA_LIMITS.backupRecords) throw new Error('This backup has too many AI chats.');
  const owned = chatIds ? new Set(chatIds) : null;
  const records = new Map();
  for (const record of part.records) {
    if (!isObject(record)) throw new Error('An AI chat in this backup is unreadable.');
    checkId(record.id, record.threadKey);
    if (owned && !owned.has(record.id)) throw new Error('The backup contains AI chat data with no saved chat.');
    if (records.has(record.id)) throw new Error('The backup has duplicate AI chats.');
    cleanThread(record.thread);
    records.set(record.id, record);
  }
  const seen = new Set();
  for (const row of part.transcripts) {
    if (!isObject(row)) throw new Error('An AI chat transcript in this backup is unreadable.');
    checkId(row.id, row.threadKey);
    if (!records.has(row.id)) throw new Error('The backup contains a transcript with no AI chat.');
    if (seen.has(row.id)) throw new Error('The backup has duplicate AI chat transcripts.');
    seen.add(row.id);
    if (!Array.isArray(row.messages) || row.messages.length > CHAT_DATA_LIMITS.messages) throw new Error('An AI chat transcript in this backup is too long.');
    for (const message of row.messages) {
      if (!isObject(message) || !ROLES.has(message.role) || typeof message.content !== 'string' || message.content.length > CHAT_DATA_LIMITS.messageChars
        || !Number.isSafeInteger(message.index) || message.index < 0) throw new Error('An AI chat transcript in this backup has an invalid message.');
    }
  }
  return part;
}

/**
 * The upsertChats entry (lib/store.js) for a sanitized ThreadPayload. `transcript` is the stored transcript meta after
 * putChatData (or null), which sets chat.hasTranscript / transcriptTruncated. Pure; the store caps every field again.
 */
export function chatEntryFromThread(thread, { origin = 'sync', placement, tags, revive = false, transcript = null } = {}) {
  if (!isObject(thread) || typeof thread.threadKey !== 'string') throw new Error('A chat needs its Threadkeeper thread.');
  const analysis = isObject(thread.analysis) ? thread.analysis : null;
  const has = !!transcript && transcript.revision === count(thread.revision);
  return {
    id: chatItemId(thread.threadKey), threadKey: thread.threadKey, fingerprint: text(thread.fingerprint), seq: count(thread.seq), origin,
    ...(revive ? { revive: true } : {}), ...(Array.isArray(tags) && tags.length ? { tags } : {}), ...(placement ? { placement } : {}),
    item: { title: text(thread.title), excerpt: text(thread.gist) || text(analysis?.gist), sourceUrl: text(thread.url), siteName: text(thread.providerLabel),
      createdAt: text(thread.createdAt) || text(thread.updatedAt) },
    chat: { provider: text(thread.provider), providerLabel: text(thread.providerLabel), category: text(thread.category), kind: text(thread.kind) || text(analysis?.kind),
      project: text(thread.project), model: text(thread.model), workflowState: text(thread.workflowState), messageCount: count(thread.messageCount),
      lastActivityAt: text(thread.updatedAt), topics: Array.isArray(analysis?.topics) ? analysis.topics : [],
      analysis: { source: text(analysis?.source), generatedAt: text(analysis?.generatedAt) },
      analysisVersion: count(thread.analysisVersion ?? analysis?.analysisVersion), revision: count(thread.revision),
      hasTranscript: has, transcriptTruncated: has && transcript.truncated === true },
  };
}

/* ------------------------------------------------------------------ backends */

function memoryBackend() {
  const stores = new Map(CHAT_DATA_STORES.map(name => [name, new Map()]));
  return {
    async get(store, key) { const value = stores.get(store).get(key); return value === undefined ? undefined : structuredClone(value); },
    async getAll(store) { return [...stores.get(store).values()].map(value => structuredClone(value)); },
    async keys(store) { return [...stores.get(store).keys()]; },
    async write(ops) {
      for (const op of ops) {
        const rows = stores.get(op.store);
        if (op.clear) rows.clear(); else if ('delete' in op) rows.delete(op.delete); else rows.set(op.put.id, structuredClone(op.put));
      }
    },
  };
}

// Modelled on the snapshot backend: a cached connection, guarded upgrades, close on versionchange, a clear blocked error.
function idbBackend(idb, name) {
  let database = null;
  const open = () => database ||= new Promise((resolve, reject) => {
    let request;
    try { request = idb.open(name, CHAT_DB_VERSION); } catch (error) { database = null; reject(error); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of CHAT_DATA_STORES) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = null; };
      db.onclose = () => { database = null; };
      resolve(db);
    };
    request.onerror = () => { database = null; reject(request.error || new Error('AI chat storage could not be opened.')); };
    request.onblocked = () => { database = null; reject(new Error('Close other Still tabs so AI chat storage can update, then try again.')); };
  });
  async function transact(stores, mode, body) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(stores, mode); } catch (error) { database = null; reject(error); return; }
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('AI chat storage failed.'));
      tx.onabort = () => reject(tx.error || new Error('AI chat storage was interrupted.'));
      const request = body(store => tx.objectStore(store));
      if (request) request.onsuccess = () => { result = request.result; };
    });
  }
  return {
    get: (store, key) => transact([store], 'readonly', s => s(store).get(key)),
    getAll: async store => (await transact([store], 'readonly', s => s(store).getAll())) || [],
    keys: async store => (await transact([store], 'readonly', s => (typeof s(store).getAllKeys === 'function' ? s(store).getAllKeys() : s(store).getAll())) || [])
      .map(entry => (isObject(entry) ? entry.id : entry)),
    write: async ops => {
      if (!ops.length) return;
      await transact([...new Set(ops.map(op => op.store))], 'readwrite', s => {
        for (const op of ops) {
          if (op.clear) s(op.store).clear(); else if ('delete' in op) s(op.store).delete(op.delete); else s(op.store).put(op.put);
        }
      });
    },
  };
}

/* ------------------------------------------------------------------ search */

const STOP_WORDS = new Set(['a', 'an', 'and', 'the', 'of', 'to', 'in', 'on', 'for', 'with', 'about', 'is', 'are', 'was', 'were', 'it', 'my', 'me', 'i',
  'we', 'you', 'what', 'which', 'that', 'this', 'all', 'any', 'how', 'did', 'do', 'from', 'or', 'at', 'by', 'be']);
export function chatSearchTokens(query) {
  const words = text(query).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}_.+#-]*/gu) || [];
  const tokens = [...new Set(words.map(word => word.replace(/[.\-]+$/, '')).filter(word => word.length > 1 && !STOP_WORDS.has(word)))];
  return tokens.slice(0, 16);
}
const joined = values => values.flat(Infinity).filter(value => typeof value === 'string' && value).join(' \n ').toLowerCase();
const evidenceText = list => (Array.isArray(list) ? list : []).flatMap(entry => (isObject(entry) ? [entry.text, entry.rationale, entry.label, entry.description, entry.quote] : [entry]));
// Weighted fields of a summary record: title and gist count most, then topics/entities, then the analysis body.
function recordFields(record) {
  const thread = isObject(record.thread) ? record.thread : {};
  const analysis = isObject(thread.analysis) ? thread.analysis : {};
  return [
    [4, joined([thread.title])],
    [3, joined([analysis.gist, thread.gist])],
    [3, joined([analysis.topics, analysis.entities, thread.tags])],
    [2, joined([thread.project, thread.providerLabel, thread.agentLabel, thread.kindLabel, analysis.kindLabel, analysis.languages, thread.workspacePath, thread.gitBranch])],
    [1.5, joined([analysis.overview, analysis.summary, analysis.userGoal, analysis.outcome, analysis.statusReason, analysis.nextStep,
      evidenceText(analysis.keyPoints), analysis.whereYouLeftOff?.text])],
    [1, joined([evidenceText(analysis.decisions), evidenceText(analysis.actionItems), evidenceText(analysis.openQuestions),
      evidenceText(analysis.constraints), evidenceText(analysis.artifacts)])],
  ];
}
function inFilters(record, filters) {
  const thread = isObject(record.thread) ? record.thread : {};
  const any = (values, value) => !Array.isArray(values) || !values.length || values.includes(value);
  const stamp = Date.parse(thread.updatedAt) || 0;
  return any(filters.providers, thread.provider) && any(filters.categories, thread.category) && any(filters.kinds, thread.kind || thread.analysis?.kind)
    && any(filters.projects, thread.project) && any(filters.states, thread.workflowState) && any(filters.threadKeys, record.threadKey) && any(filters.ids, record.id)
    && (!filters.since || stamp >= (Date.parse(filters.since) || 0)) && (!filters.until || stamp <= (Date.parse(filters.until) || Infinity));
}
function snippetAround(content, tokens, size = 220) {
  const lower = content.toLowerCase();
  const found = tokens.map(token => lower.indexOf(token)).filter(index => index >= 0);
  const at = found.length ? Math.min(...found) : 0;
  const start = Math.max(0, at - Math.floor(size / 3));
  const piece = content.slice(start, start + size).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${piece}${start + size < content.length ? '…' : ''}`;
}

/* ------------------------------------------------------------------ the store */

/**
 * createChatDataStore({ indexedDB, name, now }) — indexedDB defaults to globalThis.indexedDB; without one the data lives
 * in memory. Methods are documented inline; ids are chat item ids.
 */
export function createChatDataStore({ indexedDB = globalThis.indexedDB, name = CHAT_DB, now = () => Date.now() } = {}) {
  const backend = indexedDB ? idbBackend(indexedDB, name) : memoryBackend();
  let queue = Promise.resolve();
  const serial = task => { const next = queue.then(task, task); queue = next.catch(() => {}); return next; };
  const stamp = () => new Date(now()).toISOString();
  const ageOf = row => now() - (Date.parse(row?.storedAt) || 0);

  const api = {
    /**
     * put(id, { thread, transcript }) stores a summary record and, when `transcript` carries messages for the record's
     * revision, its transcript (replacing the stored one). Without one the stored transcript stays only if it has the
     * same revision. Returns { stored, reason?, record, transcript } (transcript = the row's meta or null).
     */
    put(id, { thread, transcript = null } = {}) {
      checkId(id, thread?.threadKey);
      const { thread: clean, bytes } = cleanThread(thread);
      return serial(async () => {
        const existing = await backend.get('records', id);
        const seq = count(clean.seq), revision = count(clean.revision);
        if (existing && seq && existing.seq > seq) return { stored: false, reason: 'stale', record: existing, transcript: existing.transcript || null };
        const storedAt = stamp(), ops = [];
        let meta = existing?.transcript || null;
        const given = isObject(transcript) && transcript.included !== false && Array.isArray(transcript.messages) ? transcript : null;
        if (given && count(given.revision) === revision) {
          const row = transcriptRow(id, clean.threadKey, given, storedAt);
          ops.push({ store: 'transcripts', put: row }); meta = transcriptMeta(row);
        } else if (meta && meta.revision !== revision) {
          ops.push({ store: 'transcripts', delete: id }); meta = null;
        }
        const record = { id, threadKey: clean.threadKey, fingerprint: text(clean.fingerprint).slice(0, 128), revision, seq, storedAt, bytes, transcript: meta, thread: clean };
        ops.push({ store: 'records', put: record });
        await backend.write(ops);
        return { stored: true, record, transcript: meta };
      });
    },
    /** The summary record or null. */
    get: async id => (await backend.get('records', id)) || null,
    /** The transcript or null; { from, count } returns only the messages with from <= index < from + count. */
    async getTranscript(id, { from, count: size } = {}) {
      const row = await backend.get('transcripts', id);
      if (!row) return null;
      if (from === undefined && size === undefined) return row;
      const start = count(from), end = size === undefined ? Infinity : start + count(size);
      return { ...row, messages: row.messages.filter(message => message.index >= start && message.index < end) };
    },
    /**
     * Merges a window of messages fetched later into the stored transcript of the same revision (creating it when the
     * record has that revision but no transcript yet). `truncated` clears once the messages are contiguous.
     * Returns { merged, reason?, transcript }.
     */
    mergeTranscriptWindow(id, window = {}) {
      return serial(async () => {
        const record = await backend.get('records', id);
        const revision = count(window.revision);
        if (!record || record.revision !== revision) return { merged: false, reason: 'revision', transcript: record?.transcript || null };
        const existing = await backend.get('transcripts', id);
        const base = existing && existing.revision === revision ? existing.messages : [];
        const row = transcriptRow(id, record.threadKey, { revision, totalMessages: Math.max(count(window.totalMessages), existing?.totalMessages || 0),
          messages: [...base, ...(Array.isArray(window.messages) ? window.messages : [])] }, stamp());
        const next = { ...record, transcript: transcriptMeta(row) };
        await backend.write([{ store: 'transcripts', put: row }, { store: 'records', put: next }]);
        return { merged: true, transcript: next.transcript };
      });
    },
    /** Deletes records and transcripts; returns how many ids had data. Unknown ids are a no-op. */
    delete(ids) {
      const list = [...new Set([].concat(ids || []).filter(id => typeof id === 'string'))];
      if (!list.length) return Promise.resolve(0);
      return serial(async () => {
        const present = new Set([...(await backend.keys('records')), ...(await backend.keys('transcripts'))]);
        const hit = list.filter(id => present.has(id));
        await backend.write(hit.flatMap(id => [{ store: 'records', delete: id }, { store: 'transcripts', delete: id }]));
        return hit.length;
      });
    },
    /** Removes the transcripts of these chats (keeps the summaries): "Remove stored transcripts". Returns how many. */
    deleteTranscripts(ids) {
      const list = [...new Set([].concat(ids || []).filter(id => typeof id === 'string'))];
      return serial(async () => {
        const present = new Set(await backend.keys('transcripts'));
        const hit = list.filter(id => present.has(id));
        const ops = [];
        for (const id of hit) {
          ops.push({ store: 'transcripts', delete: id });
          const record = await backend.get('records', id);
          if (record) ops.push({ store: 'records', put: { ...record, transcript: null } });
        }
        await backend.write(ops);
        return hit.length;
      });
    },
    ids: () => backend.keys('records'),
    /** Every summary record (small: no transcripts). */
    list: () => backend.getAll('records'),
    /** { chats, transcripts, bytes } from the records (transcripts are not loaded). */
    async stats() {
      const records = await backend.getAll('records');
      return { chats: records.length, transcripts: records.filter(record => record.transcript).length,
        bytes: records.reduce((sum, record) => sum + (record.bytes || 0) + (record.transcript?.bytes || 0), 0) };
    },
    clear: () => serial(() => backend.write(['records', 'transcripts', 'dismissed'].map(store => ({ store, clear: true })))),

    /** Chats the user deleted forever: sync never recreates them (a manual send does, after undismiss). */
    dismiss(ids, at = stamp()) {
      const list = [...new Set([].concat(ids || []).filter(isChatId))];
      return serial(() => backend.write(list.map(id => ({ store: 'dismissed', put: { id, at } })))).then(() => list.length);
    },
    undismiss(ids) {
      const list = [...new Set([].concat(ids || []).filter(isChatId))];
      return serial(() => backend.write(list.map(id => ({ store: 'dismissed', delete: id })))).then(() => list.length);
    },
    /** The dismissed ids among `ids` (or all of them when ids is omitted). */
    async dismissed(ids) {
      const all = new Set(await backend.keys('dismissed'));
      return ids === undefined ? [...all] : [...new Set([].concat(ids || []))].filter(id => all.has(id));
    },
    /** A stable id for this chat store; a different one later means the store was lost or recreated (new epoch). */
    storeId() {
      return serial(async () => {
        const meta = await backend.get('meta', 'store');
        if (meta?.storeId) return meta.storeId;
        const next = { id: 'store', storeId: uuid(), createdAt: stamp() };
        await backend.write([{ store: 'meta', put: next }]);
        return next.storeId;
      });
    },

    /**
     * Orphan sweep: deletes data whose id is not a library item (Trash counts; tombstones do not) once it is older than
     * minAgeMs, and the data of chats stripped as private (chat.removed 'local_only') at once. `library` is the library
     * document or its items. Returns { records, transcripts } deleted.
     */
    sweep(library, { minAgeMs = CHAT_DATA_LIMITS.sweepAgeMs } = {}) {
      const items = Array.isArray(library) ? library : Array.isArray(library?.items) ? library.items : null;
      if (!items) return Promise.reject(new Error('The sweep needs the library.'));
      return serial(async () => {
        const live = new Set(), privateIds = new Set();
        for (const item of items) {
          if (!isObject(item) || typeof item.id !== 'string') continue;
          live.add(item.id);
          if (item.type === 'chat' && item.chat?.removed === 'local_only') privateIds.add(item.id);
        }
        const records = await backend.getAll('records');
        const recordAt = new Map(records.map(record => [record.id, record]));
        const doomed = id => privateIds.has(id) || (!live.has(id) && (!recordAt.has(id) || ageOf(recordAt.get(id)) >= minAgeMs));
        const goneRecords = records.filter(record => doomed(record.id)).map(record => record.id);
        const goneTranscripts = (await backend.keys('transcripts')).filter(doomed);
        await backend.write([...goneRecords.map(id => ({ store: 'records', delete: id })), ...goneTranscripts.map(id => ({ store: 'transcripts', delete: id }))]);
        return { records: goneRecords.length, transcripts: goneTranscripts.length };
      });
    },

    /**
     * Offline search over the stored chats: token scoring over the summary (title, gist, topics, entities, project,
     * overview, key points, decisions…) and the transcript text. options: { filters: { providers, categories, kinds,
     * projects, states, since, until, threadKeys, ids }, limit = 20, transcripts = true, budgetMs = 1500 }.
     * An empty query lists matching chats, most recent first. Returns { results: [{ id, threadKey, title, gist, provider,
     * providerLabel, category, kind, project, updatedAt, messageCount, score (0..1), match: 'strong' | 'weak', snippet,
     * passage: { messageIndex, role, text } | null }], total }.
     */
    async search(query, { filters = {}, limit = 20, transcripts = true, budgetMs = 1500 } = {}) {
      const started = now();
      const tokens = chatSearchTokens(query);
      const records = (await backend.getAll('records')).filter(record => inFilters(record, isObject(filters) ? filters : {}));
      const rows = records.map(record => {
        const thread = isObject(record.thread) ? record.thread : {};
        const fields = recordFields(record);
        const hits = new Map();
        for (const token of tokens) {
          const weight = Math.max(0, ...fields.filter(([, value]) => value.includes(token)).map(([w]) => w));
          if (weight) hits.set(token, weight);
        }
        return { record, thread, hits, passage: null, snippet: '' };
      });
      if (tokens.length && transcripts) {
        // Transcripts load one at a time, best metadata matches first, within the time budget.
        const order = rows.filter(row => row.record.transcript).sort((a, b) => b.hits.size - a.hits.size);
        for (const row of order) {
          if (now() - started > budgetMs) break;
          const transcript = await backend.get('transcripts', row.record.id);
          if (!transcript) continue;
          let best = null;
          for (const message of transcript.messages) {
            const lower = message.content.toLowerCase();
            const found = tokens.filter(token => lower.includes(token));
            if (found.length && (!best || found.length > best.found.length)) best = { message, found };
            if (best?.found.length === tokens.length) break;
          }
          if (!best) continue;
          for (const token of best.found) if (!row.hits.has(token)) row.hits.set(token, 1);
          row.passage = { messageIndex: best.message.index, role: best.message.role, text: snippetAround(best.message.content, best.found, 400) };
          row.snippet = snippetAround(best.message.content, best.found);
        }
      }
      const scored = rows.filter(row => !tokens.length || row.hits.size).map(row => {
        const coverage = tokens.length ? row.hits.size / tokens.length : 1;
        const weight = tokens.length ? [...row.hits.values()].reduce((sum, w) => sum + w, 0) / (tokens.length * 4) : 0;
        const score = tokens.length ? Math.round((coverage * 0.7 + Math.min(1, weight) * 0.3) * 1000) / 1000 : 0;
        const gist = text(row.thread.analysis?.gist) || text(row.thread.gist);
        return { id: row.record.id, threadKey: row.record.threadKey, title: text(row.thread.title), gist, provider: text(row.thread.provider),
          providerLabel: text(row.thread.providerLabel), category: text(row.thread.category), kind: text(row.thread.kind), project: text(row.thread.project),
          updatedAt: text(row.thread.updatedAt), messageCount: count(row.thread.messageCount), score,
          match: tokens.length && row.hits.size === tokens.length ? 'strong' : 'weak',
          snippet: row.snippet || (tokens.length ? snippetAround(gist || text(row.thread.title), [...row.hits.keys()]) : gist.slice(0, 220)), passage: row.passage };
      });
      scored.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
      const max = Math.min(200, Math.max(1, count(limit) || 20));
      return { results: scored.slice(0, max), total: scored.length };
    },

    /**
     * Restores the `chats` part of a backup (validateChatBackup first). Only ids in `ids` (the chats the merge took) are
     * written, and a record older (by seq) than the one already here is skipped. Returns { records, transcripts }.
     */
    importBackup(part, { ids = null } = {}) {
      validateChatBackup(part);
      const allowed = ids ? new Set(ids) : null;
      return serial(async () => {
        const ops = [], kept = new Map();
        for (const raw of part.records) {
          if (allowed && !allowed.has(raw.id)) continue;
          const local = await backend.get('records', raw.id);
          const { thread, bytes } = cleanThread(raw.thread);
          const seq = count(raw.seq ?? thread.seq);
          if (local && local.seq > seq) continue;
          kept.set(raw.id, { id: raw.id, threadKey: raw.threadKey, fingerprint: text(raw.fingerprint).slice(0, 128), revision: count(raw.revision ?? thread.revision),
            seq, storedAt: stamp(), bytes, transcript: null, thread });
        }
        let transcriptsWritten = 0;
        for (const raw of part.transcripts) {
          const record = kept.get(raw.id);
          if (!record || count(raw.revision) !== record.revision) continue;
          const row = transcriptRow(raw.id, record.threadKey, raw, record.storedAt);
          row.truncated = row.truncated || raw.truncated === true;
          record.transcript = transcriptMeta(row);
          ops.push({ store: 'transcripts', put: row }); transcriptsWritten++;
        }
        for (const record of kept.values()) {
          // No transcript in the file (left out for size): this device's own copy stays if it is for the same revision.
          if (!record.transcript) {
            const local = await backend.get('records', record.id);
            if (local?.transcript && local.transcript.revision === record.revision) record.transcript = local.transcript;
            else ops.push({ store: 'transcripts', delete: record.id });
          }
          ops.push({ store: 'records', put: record });
        }
        await backend.write(ops);
        return { records: kept.size, transcripts: transcriptsWritten };
      });
    },
  };
  return api;
}

/* ------------------------------------------------------------------ this context's store */

let shared = null;
const store = () => (shared ||= createChatDataStore());
/** Replaces this context's chat store (tests, or a worker with its own IndexedDB handle). Returns the previous one. */
export function setChatDataStore(next) { const previous = shared; shared = next || null; return previous; }
export const putChatData = (id, data) => store().put(id, data);
export const getChatRecord = id => store().get(id);
export const getChatTranscript = (id, window) => store().getTranscript(id, window);
export const mergeChatTranscriptWindow = (id, window) => store().mergeTranscriptWindow(id, window);
export const deleteChatData = ids => store().delete(ids);
export const deleteChatTranscripts = ids => store().deleteTranscripts(ids);
export const listChatDataIds = () => store().ids();
export const listChatRecords = () => store().list();
export const chatDataStats = () => store().stats();
export const clearChatData = () => store().clear();
export const dismissChats = (ids, at) => store().dismiss(ids, at);
export const undismissChats = ids => store().undismiss(ids);
export const dismissedChatIds = ids => store().dismissed(ids);
export const chatStoreId = () => store().storeId();
export const sweepChatData = (library, options) => store().sweep(library, options);
export const searchChats = (query, options) => store().search(query, options);
export const importChatBackup = (part, options) => store().importBackup(part, options);
