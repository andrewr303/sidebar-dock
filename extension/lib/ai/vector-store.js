// Embedding vectors live in their own IndexedDB database, never in the library JSON (which is rewritten, broadcast and
// synced to the bridge on every change). Chunks are keyed `itemId#n`; `meta` holds the index config, one record per
// indexed item (content hash, chunk count, error) and a revision token that tells other views their cache is stale.
export const EMBEDDINGS_DB = 'still.embeddings.v1';
const CONFIG_KEY = 'config';
const REVISION_KEY = 'revision';
// Shared across views: a pause or clear in one view must stop automatic indexing in every view (and after a reload).
const CONTROL_KEY = 'control';
// Changes whenever the index is emptied (clear, or a reset for another model). A run started before that cannot write
// into the new index: putItems({ generation }) checks it inside the write transaction.
const GENERATION_KEY = 'generation';
const ITEM_PREFIX = 'item:';

const token = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
export const chunkKey = (itemId, n) => `${itemId}#${n}`;

function memoryBackend() {
  const chunks = new Map();
  const meta = new Map();
  return {
    kind: 'memory',
    getMeta: async key => meta.get(key),
    allMeta: async () => [...meta.values()],
    putMeta: async records => { for (const record of records) meta.set(record.key, record); },
    allChunks: async () => [...chunks.values()],
    chunksFor: async itemId => [...chunks.values()].filter(chunk => chunk.itemId === itemId).sort((a, b) => a.n - b.n),
    replaceItems: async (entries, metaRecords, { expectGeneration } = {}) => {
      if (expectGeneration !== undefined && (meta.get(GENERATION_KEY)?.value || '') !== expectGeneration) return false;
      for (const { itemId, chunks: next } of entries) {
        for (const [key, chunk] of chunks) if (chunk.itemId === itemId) chunks.delete(key);
        for (const chunk of next) chunks.set(chunk.key, chunk);
      }
      for (const record of metaRecords) meta.set(record.key, record);
      return true;
    },
    deleteItems: async (itemIds, metaRecords) => {
      const ids = new Set(itemIds);
      for (const [key, chunk] of chunks) if (ids.has(chunk.itemId)) chunks.delete(key);
      for (const id of ids) meta.delete(ITEM_PREFIX + id);
      for (const record of metaRecords) meta.set(record.key, record);
    },
    clear: async metaRecords => { chunks.clear(); meta.clear(); for (const record of metaRecords) meta.set(record.key, record); },
  };
}

function idbBackend(idb, name) {
  let database = null;
  const open = () => database ||= new Promise((resolve, reject) => {
    const request = idb.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'key' }).createIndex('itemId', 'itemId');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = null; };
      // The browser can close the connection (site data cleared, storage pressure); reopen on the next call.
      db.onclose = () => { database = null; };
      resolve(db);
    };
    request.onerror = () => { database = null; reject(request.error || new Error('The semantic index could not be opened.')); };
    request.onblocked = () => { database = null; reject(new Error('Close other Still views to upgrade the semantic index.')); };
  });
  async function transact(stores, mode, body) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('The semantic index write failed.'));
      tx.onabort = () => reject(tx.error || new Error('The semantic index write was interrupted.'));
      try { body(tx, value => { result = value; }); } catch (error) { try { tx.abort(); } catch {} reject(error); }
    });
  }
  const read = (store, method, ...args) => transact([store], 'readonly', (tx, done) => {
    const request = tx.objectStore(store)[method](...args);
    request.onsuccess = () => done(request.result);
  });
  const deleteChunksOf = (tx, itemId, then = () => {}) => {
    const chunks = tx.objectStore('chunks');
    const request = chunks.index('itemId').getAllKeys(itemId);
    request.onsuccess = () => { for (const key of request.result) chunks.delete(key); then(); };
  };
  return {
    kind: 'indexeddb',
    getMeta: key => read('meta', 'get', key),
    allMeta: () => read('meta', 'getAll'),
    putMeta: records => transact(['meta'], 'readwrite', tx => { for (const record of records) tx.objectStore('meta').put(record); }),
    allChunks: () => read('chunks', 'getAll'),
    chunksFor: async itemId => (await transact(['chunks'], 'readonly', (tx, done) => {
      const request = tx.objectStore('chunks').index('itemId').getAll(itemId);
      request.onsuccess = () => done(request.result);
    })).sort((a, b) => a.n - b.n),
    replaceItems: (entries, metaRecords, { expectGeneration } = {}) => transact(['chunks', 'meta'], 'readwrite', (tx, done) => {
      const write = () => {
        for (const { itemId, chunks } of entries) deleteChunksOf(tx, itemId, () => { for (const chunk of chunks) tx.objectStore('chunks').put(chunk); });
        for (const record of metaRecords) tx.objectStore('meta').put(record);
        done(true);
      };
      if (expectGeneration === undefined) { write(); return; }
      // Checked in the same readwrite transaction as the writes, so a clear from another view cannot slip in between.
      const request = tx.objectStore('meta').get(GENERATION_KEY);
      request.onsuccess = () => { if ((request.result?.value || '') === expectGeneration) write(); else done(false); };
    }),
    deleteItems: (itemIds, metaRecords) => transact(['chunks', 'meta'], 'readwrite', tx => {
      for (const itemId of itemIds) { deleteChunksOf(tx, itemId); tx.objectStore('meta').delete(ITEM_PREFIX + itemId); }
      for (const record of metaRecords) tx.objectStore('meta').put(record);
    }),
    clear: metaRecords => transact(['chunks', 'meta'], 'readwrite', tx => {
      tx.objectStore('chunks').clear();
      tx.objectStore('meta').clear();
      for (const record of metaRecords) tx.objectStore('meta').put(record);
    }),
  };
}

/**
 * Vector store over IndexedDB (or memory when IndexedDB is absent, e.g. in Node tests).
 * Vectors are stored as Float32Array; `allChunks()` is cached per view and reloaded when another view bumps the revision.
 */
export function createVectorStore({ indexedDB: idb = globalThis.indexedDB, name = EMBEDDINGS_DB } = {}) {
  const backend = idb ? idbBackend(idb, name) : memoryBackend();
  let cache = null; // { revision, chunks }
  const revisionRecord = () => ({ key: REVISION_KEY, value: token() });
  const generationRecord = () => ({ key: GENERATION_KEY, value: token() });
  const currentRevision = async () => (await backend.getMeta(REVISION_KEY))?.value || '';
  const currentGeneration = async () => (await backend.getMeta(GENERATION_KEY))?.value || '';

  async function getConfig() {
    const record = await backend.getMeta(CONFIG_KEY);
    return record ? { providerId: record.providerId || '', connectionId: record.connectionId || '', model: record.model || '', requestedDims: record.requestedDims || null, dims: record.dims || null, createdAt: record.createdAt || '' } : null;
  }
  /** Returns { reset: true } after clearing every vector when the provider, model or requested dimensions changed. */
  async function ensureConfig({ providerId = '', connectionId = '', model = '', requestedDims = null } = {}) {
    const current = await getConfig();
    const same = current && current.providerId === providerId && current.model === model && (current.requestedDims || null) === (requestedDims || null);
    if (same) {
      if (current.connectionId !== connectionId) await backend.putMeta([{ key: CONFIG_KEY, ...current, connectionId }]);
      return { reset: false, config: { ...current, connectionId } };
    }
    const config = { providerId, connectionId, model, requestedDims: requestedDims || null, dims: null, createdAt: new Date().toISOString() };
    await backend.clear([{ key: CONFIG_KEY, ...config }, revisionRecord(), generationRecord(), ...await controlRecords()]);
    cache = null;
    return { reset: !!current, config };
  }
  async function itemStates() {
    const states = new Map();
    for (const record of await backend.allMeta()) {
      if (typeof record?.key !== 'string' || !record.key.startsWith(ITEM_PREFIX)) continue;
      states.set(record.itemId, { hash: record.hash, chunks: record.chunks || 0, indexedAt: record.indexedAt || '', error: record.error || '' });
    }
    return states;
  }
  /**
   * Replaces the chunks of several items in one transaction. entries: [{ itemId, hash, chunks: [{ n, text, vector }], error }].
   * With { generation } the write happens only if the index was not emptied since that generation was read; returns
   * false when it was refused, true otherwise.
   */
  async function putItems(entries, { generation } = {}) {
    if (!entries.length) return true;
    const now = new Date().toISOString();
    const dims = entries.flatMap(entry => entry.chunks || []).find(chunk => chunk.vector?.length)?.vector.length || null;
    const metaRecords = entries.map(({ itemId, hash, chunks = [], error = '' }) => ({ key: ITEM_PREFIX + itemId, itemId, hash, chunks: chunks.length, indexedAt: now, error }));
    const config = dims ? await getConfig() : null;
    if (config && config.dims !== dims) metaRecords.push({ key: CONFIG_KEY, ...config, dims });
    metaRecords.push(revisionRecord());
    const written = await backend.replaceItems(entries.map(({ itemId, chunks = [] }) => ({
      itemId,
      chunks: chunks.map(chunk => ({ key: chunkKey(itemId, chunk.n), itemId, n: chunk.n, text: chunk.text, vector: chunk.vector instanceof Float32Array ? chunk.vector : Float32Array.from(chunk.vector) })),
    })), metaRecords, typeof generation === 'string' ? { expectGeneration: generation } : {});
    cache = null;
    return written !== false;
  }
  async function deleteItems(itemIds) {
    const ids = [...new Set(itemIds)].filter(id => typeof id === 'string');
    if (!ids.length) return;
    await backend.deleteItems(ids, [revisionRecord()]);
    cache = null;
  }
  async function allChunks() {
    const revision = await currentRevision();
    if (cache && cache.revision === revision) return cache.chunks;
    const chunks = (await backend.allChunks()).filter(chunk => chunk?.vector?.length);
    cache = { revision, chunks };
    return chunks;
  }
  async function clear() {
    await backend.clear([revisionRecord(), generationRecord(), ...await controlRecords()]);
    cache = null;
  }
  const controlRecords = async () => { const record = await backend.getMeta(CONTROL_KEY); return record ? [record] : []; };
  /** True while automatic indexing is held (paused or cleared) by any view. */
  const isHeld = async () => (await backend.getMeta(CONTROL_KEY))?.held === true;
  const setHeld = held => backend.putMeta([{ key: CONTROL_KEY, held: held === true, updatedAt: new Date().toISOString() }]);
  async function stats() {
    const [config, states] = await Promise.all([getConfig(), itemStates()]);
    let chunks = 0;
    for (const state of states.values()) chunks += state.chunks;
    return { items: [...states.values()].filter(state => !state.error).length, failed: [...states.values()].filter(state => state.error).length, chunks, model: config?.model || '', dims: config?.dims || null };
  }
  return { kind: backend.kind, getConfig, ensureConfig, itemStates, putItems, putItem: (itemId, entry) => putItems([{ itemId, ...entry }]),
    deleteItems, allChunks, chunksFor: itemId => backend.chunksFor(itemId), revision: currentRevision, generation: currentGeneration, clear, stats, isHeld, setHeld };
}
