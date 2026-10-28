// Semantic index builder. Opt-in (settings.embeddings.enabled): items are chunked, embedded in batches and stored in the
// vector store. Library changes re-index only items whose content hash changed and drop vectors of removed or trashed
// items. One Still view at a time does the work (Web Lock 'still.indexer'); the others read the shared IndexedDB.

export const CHUNK_SIZE = 1200;
export const CHUNK_OVERLAP = 150;
const CHUNKING_VERSION = 'c1';
const MAX_CHUNKS_PER_ITEM = 64;

const text = value => typeof value === 'string' ? value : '';
const domainOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const abortError = () => new DOMException('Indexing paused.', 'AbortError');
export const estimateTokens = chars => Math.ceil(chars / 4);

/** cyrb53: a fast, stable 53-bit string hash (hex). Used to detect changed item content, not for security. */
export function contentHash(input) {
  const value = String(input ?? '');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

const SENTENCE_END = /[.!?。！？](?=["'”’)\]]*\s)|\n/g;
function breakPoint(value, start, end, size) {
  const floor = start + Math.floor(size * 0.5);
  const paragraph = value.lastIndexOf('\n\n', end - 1);
  if (paragraph >= floor) return paragraph + 2;
  SENTENCE_END.lastIndex = floor;
  let sentence = -1;
  for (let match; (match = SENTENCE_END.exec(value)) && match.index < end - 1;) sentence = match.index + 1;
  if (sentence > floor) return sentence;
  const space = value.lastIndexOf(' ', end - 1);
  return space > floor ? space + 1 : end;
}

/**
 * Splits text into ~`size` character chunks with `overlap` characters repeated between neighbours, cutting at a
 * paragraph break, then a sentence end, then a space when one exists in the second half of the window.
 */
export function chunkText(input, { size = CHUNK_SIZE, overlap = CHUNK_OVERLAP, maxChunks = Infinity } = {}) {
  const value = String(input ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!value) return [];
  if (value.length <= size) return [value];
  const chunks = [];
  let start = 0;
  while (start < value.length && chunks.length < maxChunks) {
    const limit = Math.min(value.length, start + size);
    const end = limit < value.length ? breakPoint(value, start, limit, size) : limit;
    const piece = value.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= value.length) break;
    let next = Math.max(start + 1, end - overlap);
    const space = value.indexOf(' ', next);
    const newline = value.indexOf('\n', next);
    const boundary = Math.min(...[space, newline].filter(index => index >= 0 && index < end));
    if (Number.isFinite(boundary)) next = boundary + 1;
    start = next;
  }
  return chunks;
}

/** The text that represents an item in the index: a header (title, tags, source) and a body (description, note, article, highlights). */
export function itemIndexText(item = {}) {
  const tags = (Array.isArray(item.tags) ? item.tags : []).filter(tag => typeof tag === 'string' && tag);
  const domain = domainOf(text(item.url) || text(item.sourceUrl));
  const header = [text(item.title).trim(), tags.length ? `Tags: ${tags.join(', ')}` : '', domain ? `Source: ${domain}` : ''].filter(Boolean).join('\n');
  const excerpt = text(item.excerpt).trim();
  const content = text(item.content).trim();
  // A note's excerpt is a preview of its own content; indexing both would double-count it.
  const duplicateExcerpt = excerpt && content && content.replace(/\s+/g, ' ').includes(excerpt.replace(/[….\s]+$/, '').replace(/\s+/g, ' ').slice(0, 80));
  const highlights = (Array.isArray(item.highlights) ? item.highlights : [])
    .filter(h => h && text(h.text).trim()).map(h => `> ${text(h.text).trim()}${text(h.note).trim() ? `\n${text(h.note).trim()}` : ''}`);
  const body = [duplicateExcerpt ? '' : excerpt, content, text(item.articleContent).trim(), highlights.length ? `Highlights:\n${highlights.join('\n\n')}` : '']
    .filter(Boolean).join('\n\n');
  return { header, body };
}

/** [{ n, text, input }] where `text` is the stored snippet source and `input` is what gets embedded (header + chunk). */
export function itemChunks(item, { size = CHUNK_SIZE, overlap = CHUNK_OVERLAP, maxChunks = MAX_CHUNKS_PER_ITEM } = {}) {
  const { header, body } = itemIndexText(item);
  const pieces = chunkText(body, { size, overlap, maxChunks });
  if (!pieces.length) return header ? [{ n: 0, text: header, input: header }] : [];
  return pieces.map((piece, n) => ({ n, text: piece, input: header ? `${header}\n\n${piece}` : piece }));
}

export function itemHash(item) {
  const { header, body } = itemIndexText(item);
  return contentHash(`${CHUNKING_VERSION}:${CHUNK_SIZE}:${CHUNK_OVERLAP}\u0000${header}\u0000${body}`);
}

/**
 * Decides incremental work. states: Map(itemId -> { hash, error }). Returns items to (re)index, ids whose vectors
 * must go (deleted from the library or in Trash) and counts for the status line.
 */
export function planIndex(items, states, { hashOf = itemHash } = {}) {
  const live = (Array.isArray(items) ? items : []).filter(item => item && typeof item.id === 'string' && !item.deletedAt);
  const liveIds = new Set(live.map(item => item.id));
  const toDelete = [...states.keys()].filter(id => !liveIds.has(id));
  const toIndex = [];
  let indexed = 0;
  let failed = 0;
  for (const item of live) {
    const hash = hashOf(item);
    const state = states.get(item.id);
    if (state && state.hash === hash) { if (state.error) failed++; else indexed++; }
    else toIndex.push({ item, hash });
  }
  return { toIndex, toDelete, indexed, failed, total: live.length };
}

const permanentFailure = error => [400, 413, 422].includes(Number(error?.status));
// Rejections before any success are held back; this many in a row means a settings problem (model, dimensions), so
// the run stops with the error instead of marking the whole library as failed.
const MAX_REJECTIONS_BEFORE_SUCCESS = 5;
const configKey = value => value ? [value.connectionId, value.providerId, value.model, value.requestedDims || ''].join('\u0000') : '';

/**
 * createIndexer({ vectorStore, embedder, getLibrary, getSettings, locks }) -> {
 *   getIndexStatus, subscribeIndex, startIndexing, rebuildIndex, clearIndex, pauseIndexing, refresh, onLibraryChange, embedQuery, isReady, dispose }
 */
export function createIndexer({ vectorStore, embedder, getLibrary, getSettings, locks = globalThis.navigator?.locks, batchSize = 48, concurrency = 2,
  debounceMs = 1500, retryMs = 30000, schedule = globalThis.setTimeout?.bind(globalThis), cancel = globalThis.clearTimeout?.bind(globalThis) } = {}) {
  const status = { enabled: false, provider: '', providerId: '', connectionId: '', model: '', dims: null, total: 0, indexed: 0, pending: 0, failed: 0,
    pendingTokens: 0, running: false, paused: false, waiting: false, error: '', lastRunAt: '' };
  const listeners = new Set();
  const hashes = new Map(); // itemId -> { updatedAt, hash }
  let held = false; // set by pause/clear; automatic runs wait for startIndexing()
  let active = null; // { controller, promise }
  let rerun = false;
  let timer = null;
  let lastEmit = 0;
  let config = null;
  let runningKey = ''; // configKey of the run in progress

  const snapshot = () => ({ ...status });
  function emit(force = true) {
    const now = Date.now();
    if (!force && now - lastEmit < 200) return;
    lastEmit = now;
    const value = snapshot();
    for (const listener of listeners) { try { listener(value); } catch (error) { console.error(error); } }
  }
  const set = (patch, force = true) => { Object.assign(status, patch); emit(force); };
  const hashOf = item => {
    const stamp = typeof item.updatedAt === 'string' ? item.updatedAt : '';
    const cached = stamp && hashes.get(item.id);
    if (cached && cached.updatedAt === stamp) return cached.hash;
    const hash = itemHash(item);
    if (stamp) hashes.set(item.id, { updatedAt: stamp, hash });
    return hash;
  };
  const embeddingSettings = async () => (await getSettings())?.embeddings || {};

  // Settings that cannot be read count as off; a configured but unusable connection stays on with an error.
  async function resolveConfig() {
    let settings;
    try { settings = await embeddingSettings(); } catch (error) { return { enabled: false, error: String(error?.message || error) }; }
    const enabled = settings.enabled === true;
    if (!enabled) return { enabled };
    if (!settings.connectionId) return { enabled, error: 'Choose an embedding provider in Settings.' };
    let description;
    try { description = await embedder.describe(settings.connectionId); } catch (error) { return { enabled, error: String(error?.message || error) }; }
    const model = settings.model || description.defaultModel;
    if (!model && description.via !== 'bridge') return { enabled, error: 'Choose an embedding model in Settings.' };
    const requestedDims = Number.isSafeInteger(settings.dims) && settings.dims > 0 ? settings.dims : null;
    return { enabled, connectionId: settings.connectionId, providerId: description.providerId, provider: description.provider, model, requestedDims };
  }

  async function refreshCounts() {
    const library = await getLibrary();
    const plan = planIndex(library?.items, await vectorStore.itemStates(), { hashOf });
    const pendingChars = plan.toIndex.reduce((sum, { item }) => { const { header, body } = itemIndexText(item); return sum + header.length + body.length; }, 0);
    set({ total: plan.total, indexed: plan.indexed, failed: plan.failed, pending: plan.toIndex.length, pendingTokens: estimateTokens(pendingChars) });
    return plan;
  }

  // Another view paused or cleared the index (shared flag in the vector store).
  const heldElsewhere = async () => typeof vectorStore.isHeld === 'function' && (await vectorStore.isHeld().catch(() => false)) === true;
  // Pause and clear must still stop this view's run when the shared flag cannot be written.
  const persistHold = value => Promise.resolve().then(() => vectorStore.setHeld?.(value)).catch(error => console.error(error));

  async function embedItems(work, signal, runConfig) {
    // Flatten every pending item into chunk inputs, then group them into requests of at most `batchSize` inputs.
    const entries = work.map(({ item, hash }) => ({ item, hash, chunks: itemChunks(item), vectors: [], remaining: 0 }));
    const batches = [];
    let current = [];
    for (const entry of entries) {
      entry.remaining = entry.chunks.length;
      if (!entry.chunks.length) continue;
      for (const chunk of entry.chunks) {
        current.push({ entry, chunk });
        if (current.length >= batchSize) { batches.push(current); current = []; }
      }
    }
    if (current.length) batches.push(current);
    const commit = async finished => {
      if (!finished.length) return;
      await vectorStore.putItems(finished.map(entry => entry.error
        ? { itemId: entry.item.id, hash: entry.hash, chunks: [], error: entry.error }
        : { itemId: entry.item.id, hash: entry.hash, chunks: entry.chunks.map((chunk, i) => ({ n: chunk.n, text: chunk.text, vector: entry.vectors[i] })) }));
      const failed = finished.filter(entry => entry.error).length;
      set({ indexed: status.indexed + finished.length - failed, failed: status.failed + failed, pending: Math.max(0, status.pending - finished.length) }, false);
    };
    // Items without any text are committed immediately with no chunks so they are not retried.
    await commit(entries.filter(entry => !entry.chunks.length));
    let succeeded = 0;
    let deferred = [];
    const run = async batch => {
      if (signal.aborted) throw abortError();
      let result;
      try {
        // The configuration captured when this run started: a settings change aborts the run instead of mixing models.
        result = await embedder.embed({ connectionId: runConfig.connectionId, model: runConfig.model, dimensions: runConfig.requestedDims || undefined, inputs: batch.map(part => part.chunk.input), inputType: 'document', signal });
      } catch (error) {
        if (signal.aborted || !permanentFailure(error)) throw error;
        // One bad input fails the whole request: retry item by item so only the offending items are skipped.
        if (new Set(batch.map(part => part.entry)).size > 1) {
          const byEntry = new Map();
          for (const part of batch) byEntry.set(part.entry, [...(byEntry.get(part.entry) || []), part]);
          for (const parts of byEntry.values()) await run(parts);
          return;
        }
        const entry = batch[0].entry;
        if (!entry.error) {
          entry.error = String(error.message || 'This item could not be embedded.').slice(0, 300);
          if (succeeded) await commit([entry]);
          else {
            deferred.push(entry);
            if (deferred.length >= MAX_REJECTIONS_BEFORE_SUCCESS) throw error;
          }
        }
        return;
      }
      succeeded++;
      if (deferred.length) { const late = deferred; deferred = []; await commit(late); }
      const finished = [];
      batch.forEach((part, i) => {
        const { entry, chunk } = part;
        if (entry.error) return;
        entry.vectors[entry.chunks.indexOf(chunk)] = result.vectors[i];
        if (--entry.remaining === 0) finished.push(entry);
      });
      if (result.dims && status.dims !== result.dims) set({ dims: result.dims }, false);
      await commit(finished);
    };
    let cursor = 0;
    let failure = null;
    // A failure in one worker stops the others, so no further paid requests go out after the run has failed.
    const worker = async () => {
      while (!failure && cursor < batches.length) {
        try {
          if (await heldElsewhere()) throw Object.assign(abortError(), { held: true });
          await run(batches[cursor++]);
        } catch (error) { failure ||= error; }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, worker));
    if (failure) throw failure;
    await commit(deferred);
  }

  async function work(signal) {
    const resolved = await resolveConfig();
    if (!resolved.enabled) { set({ enabled: false, running: false, waiting: false }); return; }
    if (resolved.error) { set({ enabled: true, error: resolved.error, running: false }); return; }
    config = resolved;
    if (await heldElsewhere()) { await refreshCounts().catch(() => {}); set({ enabled: true, running: false, waiting: false, paused: true }); return; }
    runningKey = configKey(resolved);
    try {
      const { reset, config: stored } = await vectorStore.ensureConfig(resolved);
      if (reset) hashes.clear();
      set({ enabled: true, running: true, waiting: false, paused: false, error: '', provider: resolved.provider, providerId: resolved.providerId, connectionId: resolved.connectionId, model: resolved.model, dims: stored?.dims || null });
      // Re-plan after each pass: the library may change while a pass runs.
      for (let pass = 0; pass < 3 && !signal.aborted; pass++) {
        const plan = await refreshCounts();
        if (plan.toDelete.length) await vectorStore.deleteItems(plan.toDelete);
        if (!plan.toIndex.length) break;
        await embedItems(plan.toIndex, signal, resolved);
      }
      if (signal.aborted) throw abortError();
      await refreshCounts();
      set({ running: false, lastRunAt: new Date().toISOString() });
    } finally {
      runningKey = '';
    }
  }

  function run({ force = false } = {}) {
    if (held && !force) return Promise.resolve(snapshot());
    if (active) { rerun = true; return active.promise; }
    const controller = new AbortController();
    const guarded = async () => {
      try {
        if (!locks?.request) { await work(controller.signal); return; }
        const ran = await locks.request('still.indexer', { ifAvailable: true }, async lock => { if (!lock) return false; await work(controller.signal); return true; });
        if (!ran) {
          await refreshCounts().catch(() => {});
          set({ waiting: true, running: false });
          if (retryMs && schedule) { cancel?.(timer); timer = schedule(() => { timer = null; return run(); }, retryMs); }
        }
      } catch (error) {
        if (error?.name === 'AbortError' || controller.signal.aborted) set({ running: false, paused: held || error?.held === true });
        else set({ running: false, error: String(error?.message || error || 'Indexing failed.') });
      }
    };
    const promise = guarded().then(() => {
      active = null;
      if (rerun && !held) { rerun = false; return run(); }
      rerun = false;
      return snapshot();
    });
    active = { controller, promise };
    return promise;
  }

  function onLibraryChange() {
    if (!status.enabled || held || !schedule) return;
    cancel?.(timer);
    timer = schedule(() => { timer = null; return run(); }, debounceMs);
  }

  /** Re-reads settings (after they change) and updates the status; starts work when enabled unless start is false. */
  async function refresh({ start = true } = {}) {
    const resolved = await resolveConfig();
    if (!resolved.enabled) {
      if (active) active.controller.abort();
      const stats = await vectorStore.stats().catch(() => null);
      set({ enabled: false, running: false, waiting: false, error: resolved.error || '', pending: 0, indexed: stats?.items || 0, model: stats?.model || '', dims: stats?.dims || null });
      return snapshot();
    }
    if (!resolved.error) {
      // A run still embedding with the previous provider or model stops now; the rerun resets the index for the new one.
      if (active && runningKey && runningKey !== configKey(resolved)) { rerun = true; active.controller.abort(); }
      config = resolved;
    }
    const paused = held || await heldElsewhere();
    set({ enabled: true, paused, error: resolved.error || '', provider: resolved.provider || status.provider, providerId: resolved.providerId || status.providerId,
      connectionId: resolved.connectionId || status.connectionId, model: resolved.model || status.model });
    if (resolved.error) return snapshot();
    if (!start) { await refreshCounts().catch(() => {}); return snapshot(); }
    return run();
  }

  async function stopActive() {
    if (!active) return;
    active.controller.abort();
    await active.promise.catch(() => {});
  }

  return {
    getIndexStatus: snapshot,
    subscribeIndex(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      try { listener(snapshot()); } catch (error) { console.error(error); }
      return () => listeners.delete(listener);
    },
    async startIndexing() {
      held = false;
      await persistHold(false);
      set({ paused: false });
      const resolved = await resolveConfig();
      if (!resolved.enabled) throw new Error(resolved.error || 'Turn on semantic search in Settings first.');
      if (resolved.error) { set({ enabled: true, error: resolved.error }); throw new Error(resolved.error); }
      return run({ force: true });
    },
    async rebuildIndex() {
      held = false;
      await persistHold(false);
      await stopActive();
      await vectorStore.clear();
      hashes.clear();
      set({ indexed: 0, failed: 0, dims: null, paused: false });
      const resolved = await resolveConfig();
      if (!resolved.enabled) { await refreshCounts().catch(() => {}); return snapshot(); }
      return run({ force: true });
    },
    async clearIndex() {
      held = true;
      await persistHold(true);
      await stopActive();
      await vectorStore.clear();
      hashes.clear();
      await refreshCounts().catch(() => {});
      set({ running: false, paused: true, dims: null, lastRunAt: '' });
      return snapshot();
    },
    async pauseIndexing() {
      held = true;
      set({ paused: true });
      await persistHold(true);
      await stopActive();
      return snapshot();
    },
    refresh,
    onLibraryChange,
    /** True when searches can use vectors: enabled, configured, and the stored vectors match the configured model. */
    async isReady() {
      if (!status.enabled || !config?.connectionId) return false;
      const stored = await vectorStore.getConfig();
      return !!stored && stored.model === config.model && (stored.requestedDims || null) === (config.requestedDims || null);
    },
    async embedQuery(query, { signal } = {}) {
      if (!status.enabled || !config?.connectionId) throw new Error('Semantic search is off.');
      const result = await embedder.embed({ connectionId: config.connectionId, model: config.model, dimensions: config.requestedDims || undefined, inputs: [query], inputType: 'query', signal });
      return result.vectors[0];
    },
    dispose() { cancel?.(timer); listeners.clear(); active?.controller.abort(); },
  };
}
