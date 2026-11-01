import {
  LIBRARY_SCHEMA_VERSION, LIBRARY_MIGRATIONS, assertLibraryVersion, migrateLibrary,
} from './storage/migrations.js';

export const STORAGE_KEY = 'still.library.v1';
export const ITEM_TYPES = ['bookmark', 'article', 'image', 'video', 'file', 'note'];
// Hard deletes leave { kind, id, deletedAt } so an import (and later a sync engine) never resurrects them.
export const TOMBSTONE_LIMIT = 10000;
const STORE_MESSAGE = 'still:store';
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const nextStamp = previous => new Date(Math.max(Date.now(), (Date.parse(previous) || 0) + 1)).toISOString();
const uid = prefix => `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
const list = value => [...new Set((Array.isArray(value) ? value : []).filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean))];
const text = value => typeof value === 'string' ? value : '';
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

// The fields this build understands. Anything else on a STORED record (written by a newer or older build) is carried
// over untouched when this build edits the record; unknown keys that arrive only with a patch are transient UI state and
// are dropped. Prototype keys are never copied.
const ITEM_FIELDS = new Set(['id', 'type', 'title', 'url', 'excerpt', 'content', 'articleContent', 'tags', 'collectionId', 'favorite',
  'archived', 'deletedAt', 'createdAt', 'updatedAt', 'cover', 'art', 'sourceUrl', 'highlights', 'relatedIds', 'reminderAt',
  'reminderNotifiedAt', 'attachmentId', 'fileName', 'mime', 'size', 'pinned', 'read', 'sticky']);
const COLLECTION_FIELDS = new Set(['id', 'name', 'color', 'icon', 'parentId', 'description', 'cover', 'pinned', 'layout', 'sidebarLayout',
  'createdAt', 'updatedAt', 'deletedAt']);
const HIGHLIGHT_FIELDS = new Set(['id', 'text', 'note', 'color', 'createdAt', 'url']);
const STICKY_FIELDS = new Set(['color', 'board', 'x', 'y', 'w', 'h', 'z', 'hidden']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function keepUnknown(target, stored, known) {
  if (!isObject(stored)) return target;
  for (const key of Object.keys(stored)) {
    if (known.has(key) || UNSAFE_KEYS.has(key) || Object.hasOwn(target, key)) continue;
    const value = stored[key];
    if (value !== undefined && typeof value !== 'function' && typeof value !== 'symbol') target[key] = value;
  }
  return target;
}

// A timestamp from stored data (seed, import, backup) is kept when it parses; one from the future (another device's
// clock) is clamped to now so it cannot win every later comparison.
function storedStamp(value) {
  const time = typeof value === 'string' && value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(Math.min(time, Date.now())).toISOString() : '';
}
const stampOf = record => Date.parse(record?.updatedAt) || 0;

export function safeUrl(value, { optional = true } = {}) {
  if (!value && optional) return '';
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    if (parsed.username || parsed.password) throw new Error();
    return parsed.href;
  } catch { throw new Error('Enter a valid http or https URL.'); }
}

export function canonicalUrl(value) {
  if (!value) return '';
  const parsed = new URL(safeUrl(value));
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^utm_|^(fbclid|gclid)$/i.test(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  return parsed.href.replace(/\/$/, '');
}

function coverUrl(value) {
  const str = text(value);
  if (!str) return '';
  if (/^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(str)) return str;
  if (/^(assets|images)\/[a-z0-9_./ -]+$/i.test(str) && !str.includes('..')) return str;
  try { return safeUrl(str); } catch { return ''; }
}

// `stored` is the saved highlight with the same id (its unknown keys survive the edit).
function normalizeHighlight(value, stored) {
  if (!value || typeof value !== 'object' || !text(value.text).trim()) return null;
  return keepUnknown({ id: text(value.id) || uid('highlight'), text: value.text, note: text(value.note), color: text(value.color) || 'amber',
    createdAt: text(value.createdAt) || now(), url: safeUrl(value.url) }, stored, HIGHLIGHT_FIELDS);
}

// Sticky notes are notes with a `sticky` placement: { color, board, x, y, w, h, z, hidden }. board is a dashboard board id
// ('' = every board); x is a 0..1 fraction of the dashboard width; y, w and h are pixels; z orders overlapping notes.
export const STICKY_COLORS = Object.freeze(['yellow', 'orange', 'pink', 'purple', 'blue', 'green', 'gray']);
export const STICKY_LIMITS = Object.freeze({ minW: 160, maxW: 520, minH: 120, maxH: 520, maxY: 100000, maxZ: 1000000 });
export const STICKY_DEFAULTS = Object.freeze({ color: 'yellow', board: '', x: 0.72, y: 24, w: 240, h: 220, z: 0, hidden: false });
const finite = (value, fallback) => { const n = Number(value); return value !== null && value !== '' && Number.isFinite(n) ? n : fallback; };
const within = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * The stored sticky placement for an item type ('note' only), or null. Missing or invalid fields take the defaults.
 * `stored` is the saved placement: keys this build does not know are kept from it.
 */
export function normalizeSticky(value, type = 'note', stored = null) {
  if (type !== 'note' || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const L = STICKY_LIMITS, D = STICKY_DEFAULTS;
  return keepUnknown({
    color: STICKY_COLORS.includes(value.color) ? value.color : D.color,
    board: typeof value.board === 'string' ? value.board.trim().slice(0, 120) : D.board,
    x: Math.round(within(finite(value.x, D.x), 0, 1) * 10000) / 10000,
    y: Math.round(within(finite(value.y, D.y), 0, L.maxY)),
    w: Math.round(within(finite(value.w, D.w), L.minW, L.maxW)),
    h: Math.round(within(finite(value.h, D.h), L.minH, L.maxH)),
    z: Math.round(within(finite(value.z, D.z), 0, L.maxZ)),
    hidden: value.hidden === true,
  }, stored, STICKY_FIELDS);
}

/**
 * Validates and fills an item. `existing` is the stored record being edited: its unknown keys survive. With
 * { stored: true } the input itself is stored data (seed, import, backup): its unknown keys and a valid updatedAt are kept.
 */
export function normalizeItem(input, existing = {}, { stored = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Item must be an object.');
  const merged = { ...existing, ...input };
  // A partial sticky patch ({ sticky: { x, y } }) updates the stored placement; null turns the sticky back into a plain note.
  const stickyPatch = input.sticky && typeof input.sticky === 'object' && !Array.isArray(input.sticky) && existing.sticky && typeof existing.sticky === 'object';
  if (stickyPatch) merged.sticky = { ...existing.sticky, ...input.sticky };
  const type = merged.type || 'bookmark';
  if (!ITEM_TYPES.includes(type)) throw new Error('Unknown item type.');
  const url = safeUrl(merged.url);
  if (['bookmark', 'image', 'video'].includes(type) && !url && !merged.attachmentId && !merged.cover) {
    throw new Error('This item needs a URL or attached file.');
  }
  const savedHighlights = new Map([...(Array.isArray(existing.highlights) ? existing.highlights : []),
    ...(stored && Array.isArray(input.highlights) ? input.highlights : [])].filter(h => isObject(h) && text(h.id)).map(h => [h.id, h]));
  const createdAt = text(existing.createdAt) || text(input.createdAt) || now();
  const item = {
    id: text(existing.id) || text(input.id) || uid('item'), type,
    title: text(merged.title).trim() || (url ? new URL(url).hostname : type === 'note' ? 'Untitled note' : 'Untitled item'),
    url, excerpt: text(merged.excerpt), content: text(merged.content), articleContent: text(merged.articleContent).slice(0, 250000), tags: list(merged.tags),
    collectionId: text(merged.collectionId), favorite: merged.favorite === true,
    archived: merged.archived === true, deletedAt: merged.deletedAt ? text(merged.deletedAt) : null,
    createdAt, updatedAt: (stored && storedStamp(input.updatedAt)) || nextStamp(existing.updatedAt), cover: coverUrl(merged.cover),
    art: ['quiet', 'note', 'glass', 'type', 'landscape', 'welcome', 'web', 'palette', 'mcp'].includes(merged.art) ? merged.art : '',
    sourceUrl: safeUrl(merged.sourceUrl),
    highlights: (Array.isArray(merged.highlights) ? merged.highlights : []).map(h => normalizeHighlight(h, savedHighlights.get(h?.id))).filter(Boolean),
    relatedIds: list(merged.relatedIds), reminderAt: merged.reminderAt ? new Date(merged.reminderAt).toISOString() : null,
    // Editing the reminder re-arms it; stored data (a restored backup) keeps its delivery record so it is not announced twice.
    reminderNotifiedAt: !stored && Object.hasOwn(input, 'reminderAt') && input.reminderAt !== existing.reminderAt
      ? null : merged.reminderNotifiedAt ? text(merged.reminderNotifiedAt) : null,
    attachmentId: text(merged.attachmentId), fileName: text(merged.fileName), mime: text(merged.mime),
    size: Number.isFinite(merged.size) && merged.size >= 0 ? merged.size : 0,
    pinned: merged.pinned === true, read: merged.read === true,
    sticky: normalizeSticky(merged.sticky, type, stored ? merged.sticky : existing.sticky),
  };
  return keepUnknown(item, stored ? merged : existing, ITEM_FIELDS);
}

function normalizeCollection(input, existing = {}, { stored = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Collection must be an object.');
  const merged = { ...existing, ...input };
  if (!text(merged.name).trim()) throw new Error('Give the collection a name.');
  // deletedAt is reserved for a soft-deleted collection (written by sync or a newer build); it is only kept when set.
  const deletedAt = text(merged.deletedAt);
  return keepUnknown({ id: text(existing.id) || text(input.id) || uid('collection'), name: merged.name.trim(),
    color: /^#[\da-f]{3,8}$/i.test(text(merged.color)) ? merged.color : '#a99eea', icon: text(merged.icon) || 'folder', parentId: text(merged.parentId),
    description: text(merged.description).slice(0, 12000), cover: coverUrl(merged.cover), pinned: merged.pinned === true,
    layout: ['grid', 'list', 'masonry'].includes(merged.layout) ? merged.layout : 'grid',
    sidebarLayout: ['grid', 'list', 'masonry'].includes(merged.sidebarLayout) ? merged.sidebarLayout : 'list',
    createdAt: text(existing.createdAt) || text(merged.createdAt) || now(),
    updatedAt: (stored && storedStamp(input.updatedAt)) || nextStamp(existing.updatedAt),
    ...(deletedAt ? { deletedAt } : {}) }, stored ? merged : existing, COLLECTION_FIELDS);
}

export function emptyLibrary(schemaVersion = LIBRARY_SCHEMA_VERSION) {
  return { schemaVersion, items: [], collections: [], settings: {}, updatedAt: now() };
}

const isLibraryShape = value => isObject(value) && Array.isArray(value.items) && Array.isArray(value.collections);

// Seed and import data: older schemas are migrated first, newer ones refused. Records keep their unknown keys and valid
// timestamps. knownCollectionIds are collections already in the library, so imported items may point at them.
function validateLibrary(value, { migrations = LIBRARY_MIGRATIONS, target = LIBRARY_SCHEMA_VERSION, knownCollectionIds = [] } = {}) {
  if (!isLibraryShape(value)) {
    throw new Error('Import a Still library JSON file with items and collections arrays.');
  }
  value = migrateLibrary(value, { migrations, target }).data;
  const collections = value.collections.map(c => normalizeCollection(c, {}, { stored: true }));
  const ids = new Set(collections.map(c => c.id));
  if (ids.size !== collections.length) throw new Error('Duplicate collection IDs in library.');
  const items = value.items.map(i => normalizeItem(i, {}, { stored: true }));
  if (new Set(items.map(i => i.id)).size !== items.length) throw new Error('Duplicate item IDs in library.');
  const known = new Set([...ids, ...knownCollectionIds]);
  for (const item of items) if (item.collectionId && !known.has(item.collectionId)) item.collectionId = '';
  for (const collection of collections) {
    if (!known.has(collection.parentId) || collection.parentId === collection.id) collection.parentId = '';
    const seen = new Set([collection.id]);
    let parentId = collection.parentId;
    while (parentId) {
      if (seen.has(parentId)) throw new Error('Imported collections cannot contain a parent cycle.');
      seen.add(parentId); parentId = collections.find(c => c.id === parentId)?.parentId || '';
    }
  }
  return { schemaVersion: target, items, collections,
    settings: isObject(value.settings) ? clone(value.settings) : {}, updatedAt: now() };
}

// Settings keys that hold credentials or device wiring: never taken from an import, and the local ones are always kept.
const SECRET_SETTING = /token|secret|password|passphrase|credential|bridge|integration|api[-_]?key|authorization|cookie/i;
function publicSettings(value) {
  if (Array.isArray(value)) return value.map(entry => (entry && typeof entry === 'object' ? publicSettings(entry) : entry));
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_SETTING.test(key) && !UNSAFE_KEYS.has(key))
    .map(([key, entry]) => [key, entry && typeof entry === 'object' ? publicSettings(entry) : entry]));
}
function withLocalSecrets(local, incoming) {
  const next = { ...incoming };
  for (const [key, value] of Object.entries(local)) {
    if (SECRET_SETTING.test(key)) next[key] = value;
    else if (isObject(value) && isObject(next[key])) next[key] = withLocalSecrets(value, next[key]);
  }
  return next;
}
// Imported settings win key by key (groups such as newTab are replaced whole, as the settings UI writes them); secret-like
// keys are stripped from the import and the device's own secret-like keys survive at every level.
export function mergeImportedSettings(local = {}, incoming = {}) {
  return withLocalSecrets(isObject(local) ? local : {}, { ...(isObject(local) ? local : {}), ...publicSettings(incoming) });
}

const tombstonesOf = state => (Array.isArray(state.tombstones) ? state.tombstones : [])
  .filter(t => isObject(t) && ['item', 'collection'].includes(t.kind) && typeof t.id === 'string');
function bury(state, kind, ids) {
  if (!ids.length) return;
  const gone = new Set(ids), deletedAt = now();
  state.tombstones = [...tombstonesOf(state).filter(t => !(t.kind === kind && gone.has(t.id))), ...[...gone].map(id => ({ kind, id, deletedAt }))]
    .slice(-TOMBSTONE_LIMIT);
}
function unbury(state, kind, ids) {
  if (!Array.isArray(state.tombstones) || !state.tombstones.length || !ids.length) return;
  const back = new Set(ids);
  state.tombstones = tombstonesOf(state).filter(t => !(t.kind === kind && back.has(t.id)));
}

// What a commit changed, for onCommit: records whose updatedAt moved (or that appeared), records that disappeared,
// plus records touched by derived clean-ups (backlink removal) that deliberately keep their updatedAt.
const indexRecords = records => new Map((records || []).filter(isObject).map(record => [record.id, record.updatedAt]));
function commitIndex(state) {
  return state ? { items: indexRecords(state.items), collections: indexRecords(state.collections), settings: JSON.stringify(state.settings ?? {}) }
    : { items: new Map(), collections: new Map(), settings: null };
}
function commitChange(operation, before, state, touched) {
  const diff = (previous, records, extra = new Set()) => {
    const changed = [], present = new Set();
    for (const record of records || []) {
      if (!isObject(record)) continue;
      present.add(record.id);
      if (!previous.has(record.id) || previous.get(record.id) !== record.updatedAt || extra.has(record.id)) changed.push(record.id);
    }
    return { changed, deleted: [...previous.keys()].filter(id => !present.has(id)) };
  };
  const items = diff(before.items, state.items, touched), collections = diff(before.collections, state.collections);
  return { operation, changed: { items: items.changed, collections: collections.changed, settings: before.settings !== JSON.stringify(state.settings ?? {}) },
    deleted: { items: items.deleted, collections: collections.deleted }, updatedAt: state.updatedAt };
}

const NEWER_FILE_MESSAGE = 'This file was saved by a newer version of Still. Update Still to import it; nothing was changed.';

/*
 * A single service-worker queue owns extension writes; preview tabs use Web Locks.
 * - ready(): awaited before every queued task (the worker's update-snapshot gate).
 * - beforeMigration({ from, to, operation }): awaited before an older stored library is migrated; if it throws nothing is
 *   written. A library from a newer schema is never written: every operation throws NewerLibraryError.
 * - onCommit({ operation, changed: { items, collections, settings }, deleted: { items, collections }, updatedAt }) runs after
 *   each successful write (the seam a sync engine or the snapshot "dirty" marker hooks into). Its errors never fail the write.
 * - migrations / schemaVersion: the registry and target version (injectable for tests).
 */
export function createLibraryStore({ read, write, withLock = task => task(), ready, onCommit, beforeMigration,
  migrations = LIBRARY_MIGRATIONS, schemaVersion: target = LIBRARY_SCHEMA_VERSION }) {
  let queue = Promise.resolve();
  const listeners = new Set();
  const notify = state => { for (const listener of listeners) listener(clone(state)); };
  const libraryOptions = { migrations, target };
  async function current() { const state = await read(); return state ? clone(state) : null; }
  const enqueue = work => {
    const task = async () => {
      if (ready) await Promise.resolve().then(ready).catch(() => {});
      return withLock(work);
    };
    const next = queue.then(task, task); queue = next.catch(() => {}); return next;
  };
  const report = change => {
    try { Promise.resolve(onCommit(change)).catch(error => console.warn('Still commit hook:', error?.message)); }
    catch (error) { console.warn('Still commit hook:', error?.message); }
  };
  const dispatch = (operation, args = []) => enqueue(async () => {
    let state = await current();
    let migrated = false;
    if (state) {
      if (!isLibraryShape(state)) throw new Error('Saved library is unreadable. Restore a snapshot or backup before continuing; nothing was changed.');
      const from = assertLibraryVersion(state, target);
      if (from < target) {
        try { await beforeMigration?.({ from, to: target, operation }); }
        catch (error) { throw new Error(`Still could not save a safety snapshot before upgrading your library, so nothing was changed. ${error?.message || ''}`.trim()); }
        state = migrateLibrary(state, libraryOptions).data;
        migrated = true;
      }
    }
    const fresh = !state;
    if (!state) state = args[0] && operation === 'loadLibrary' ? validateLibrary(args[0], libraryOptions) : emptyLibrary(target);
    const before = onCommit ? commitIndex(migrated ? null : fresh ? emptyLibrary(target) : state) : null;
    const touched = new Set();
    let result, extra;
    let changed = (operation === 'loadLibrary' && fresh) || migrated;
    const [input, patch, options = {}] = args;
    const assertRevision = (record, opts) => { if (typeof opts?.expectedUpdatedAt === 'string' && opts.expectedUpdatedAt !== record.updatedAt) throw new Error('Conflict: this item changed in another view. Reopen it before applying your edits.'); };
    const findItem = id => { const item = state.items.find(i => i.id === id); if (!item) throw new Error('Item no longer exists.'); return item; };
    const findCollection = id => { const collection = state.collections.find(c => c.id === id); if (!collection) throw new Error('Collection no longer exists.'); return collection; };
    // Removing items drops them from other items' relatedIds without bumping updatedAt (an open editor's revision stays
    // valid); every device re-derives this when it applies the tombstone.
    const unlink = removed => {
      for (const item of state.items) {
        if (!Array.isArray(item.relatedIds) || !item.relatedIds.some(id => removed.has(id))) continue;
        item.relatedIds = item.relatedIds.filter(id => !removed.has(id)); touched.add(item.id);
      }
    };
    switch (operation) {
      case 'loadLibrary': case 'exportLibrary': result = state; break;
      case 'saveItem': {
        const valid = normalizeItem(input);
        const existing = input.id ? state.items.find(i => i.id === input.id) : valid.url && valid.type !== 'note'
          ? state.items.find(i => !i.deletedAt && i.type !== 'note' && canonicalUrl(i.url) === canonicalUrl(valid.url)) : null;
        const nextInput = existing && !input.id ? { ...input,
          content: input.content || existing.content, articleContent: input.articleContent || existing.articleContent, excerpt: input.excerpt || existing.excerpt,
          cover: input.cover || existing.cover, collectionId: input.collectionId || existing.collectionId,
          tags: list([...existing.tags, ...valid.tags]),
          highlights: [...existing.highlights, ...valid.highlights], relatedIds: list([...existing.relatedIds, ...valid.relatedIds]) } : input;
        result = normalizeItem(nextInput, existing || {});
        if (result.collectionId) findCollection(result.collectionId);
        if (existing) state.items[state.items.indexOf(existing)] = result; else state.items.push(result);
        unbury(state, 'item', [result.id]);
        changed = true; break;
      }
      case 'updateItem': {
        const existing = findItem(input);
        assertRevision(existing, options);
        result = normalizeItem({ ...patch, id: input }, existing);
        if (result.collectionId) findCollection(result.collectionId);
        state.items[state.items.indexOf(existing)] = result;
        changed = true; break;
      }
      case 'deleteItem': case 'restoreItem': {
        const existing = findItem(input);
        assertRevision(existing, patch);
        result = normalizeItem({ deletedAt: operation === 'deleteItem' ? now() : null }, existing);
        state.items[state.items.indexOf(existing)] = result; changed = true; break;
      }
      case 'permanentlyDeleteItem': {
        assertRevision(findItem(input), patch);
        state.items = state.items.filter(i => i.id !== input);
        unlink(new Set([input]));
        bury(state, 'item', [input]);
        result = { id: input }; changed = true; break;
      }
      case 'bulkUpdateItems': {
        // One write for many item patches: [{ id, patch }]. Trash via patch.deletedAt, restore via deletedAt: null.
        if (!Array.isArray(input) || !input.length) throw new Error('Choose at least one item.');
        if (patch?.expectedLibraryUpdatedAt && patch.expectedLibraryUpdatedAt !== state.updatedAt) throw new Error('Conflict: the library changed. Refresh before applying these changes.');
        const updates = input.map(entry => {
          if (!entry || typeof entry.id !== 'string' || !entry.patch || typeof entry.patch !== 'object') throw new Error('Each change needs an item id and a patch.');
          const existing = findItem(entry.id);
          const next = normalizeItem({ ...entry.patch, id: entry.id }, existing);
          if (next.collectionId) findCollection(next.collectionId);
          return [existing, next];
        });
        for (const [existing, next] of updates) state.items[state.items.indexOf(existing)] = next;
        result = updates.map(([, next]) => next); changed = true; break;
      }
      case 'emptyTrash': {
        const removed = state.items.filter(i => i.deletedAt);
        const ids = new Set(removed.map(i => i.id));
        state.items = state.items.filter(i => !i.deletedAt);
        unlink(ids);
        bury(state, 'item', [...ids]);
        const stillUsed = new Set(state.items.map(i => i.attachmentId).filter(Boolean));
        result = { ids: [...ids], attachmentIds: [...new Set(removed.map(i => i.attachmentId).filter(id => id && !stillUsed.has(id)))] };
        changed = ids.size > 0; break;
      }
      case 'moveCollection': {
        // Reparent and/or reorder: { parentId, beforeId } places the collection before a sibling (or last when beforeId is empty).
        const existing = findCollection(input);
        const parentId = typeof patch?.parentId === 'string' ? patch.parentId : existing.parentId || '';
        let ancestorId = parentId;
        const seen = new Set([input]);
        while (ancestorId) {
          if (seen.has(ancestorId)) throw new Error('A collection cannot contain itself.');
          seen.add(ancestorId); ancestorId = findCollection(ancestorId).parentId;
        }
        const moved = normalizeCollection({ parentId }, existing);
        const rest = state.collections.filter(c => c.id !== input);
        const position = patch?.beforeId ? rest.findIndex(c => c.id === patch.beforeId) : -1;
        if (position >= 0) rest.splice(position, 0, moved);
        else {
          const lastSibling = rest.findLastIndex(c => (c.parentId || '') === parentId);
          rest.splice(lastSibling >= 0 ? lastSibling + 1 : rest.length, 0, moved);
        }
        state.collections = rest; result = moved; changed = true; break;
      }
      case 'createCollection': {
        result = normalizeCollection(input);
        if (state.collections.some(c => c.id === result.id)) throw new Error('Collection ID already exists.');
        if (result.parentId) findCollection(result.parentId);
        state.collections.push(result);
        unbury(state, 'collection', [result.id]);
        changed = true; break;
      }
      case 'updateCollection': {
        const existing = findCollection(input);
        assertRevision(existing, options);
        result = normalizeCollection(patch, existing);
        let ancestorId = result.parentId;
        const seen = new Set([input]);
        while (ancestorId) {
          if (seen.has(ancestorId)) throw new Error('A collection cannot contain itself.');
          seen.add(ancestorId); ancestorId = findCollection(ancestorId).parentId;
        }
        state.collections[state.collections.indexOf(existing)] = result; changed = true; break;
      }
      case 'deleteCollection': {
        const existing = findCollection(input);
        assertRevision(existing, patch);
        for (const item of state.items) if (item.collectionId === input) { item.collectionId = ''; item.updatedAt = nextStamp(item.updatedAt); }
        for (const collection of state.collections) {
          if (collection.parentId === input) { collection.parentId = existing.parentId; collection.updatedAt = nextStamp(collection.updatedAt); }
        }
        state.collections = state.collections.filter(c => c.id !== input);
        bury(state, 'collection', [input]);
        result = state; changed = true; break;
      }
      case 'mutateTags': {
        if (!input || typeof input.oldTag !== 'string' || !input.oldTag.trim() || (input.newTag !== null && (typeof input.newTag !== 'string' || !input.newTag.trim()))) throw new Error('Choose a tag and a replacement name, or null to remove it.');
        if (input.expectedLibraryUpdatedAt && input.expectedLibraryUpdatedAt !== state.updatedAt) throw new Error('Conflict: the library changed. Refresh before changing tags.');
        let updated = 0;
        for (const item of state.items) if (item.tags.some(t => t.toLowerCase() === input.oldTag.toLowerCase())) {
          item.tags = list(item.tags.flatMap(t => t.toLowerCase() === input.oldTag.toLowerCase() ? input.newTag === null ? [] : [input.newTag.trim()] : [t]));
          item.updatedAt = nextStamp(item.updatedAt); updated++;
        }
        result = { updated, oldTag: input.oldTag, newTag: input.newTag }; changed = updated > 0; break;
      }
      case 'updateSettings': {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be an object.');
        state.settings = { ...state.settings, ...clone(input) }; result = state.settings; changed = true; break;
      }
      case 'importLibrary': {
        // importLibrary(data, { settings }) merges by id: the newer updatedAt wins (newer local edits are kept) and a record
        // deleted here after the file's copy was last edited stays deleted. { settings: true } also merges the file's
        // non-secret settings. The result is the library plus an importSummary.
        const importOptions = isObject(patch) ? patch : {};
        let imported;
        try { imported = validateLibrary(input, { ...libraryOptions, knownCollectionIds: state.collections.map(c => c.id) }); }
        catch (error) { throw error?.name === 'NewerLibraryError' ? new Error(NEWER_FILE_MESSAGE) : error; }
        const graves = new Map(tombstonesOf(state).map(t => [`${t.kind}:${t.id}`, Date.parse(t.deletedAt) || 0]));
        const summary = { items: { added: 0, updated: 0, kept: 0, tombstoned: 0 }, collections: { added: 0, updated: 0, kept: 0, tombstoned: 0 },
          settings: false, skippedItemIds: [] };
        // Compare with the stamp the file actually carries: validateLibrary fills a missing one with now, which would let
        // a stampless record from an old file overwrite a newer local edit. Missing or invalid counts as oldest.
        const fileStamps = kind => new Map((Array.isArray(input?.[kind]) ? input[kind] : []).filter(isObject)
          .map(record => [record.id, Date.parse(typeof record.updatedAt === 'string' ? record.updatedAt : '') || 0]));
        const merge = (kind, local, incoming, counts) => {
          const byId = new Map(local.map(record => [record.id, record]));
          const given = fileStamps(kind === 'item' ? 'items' : 'collections');
          const stampIn = record => Math.min(given.get(record.id) ?? 0, stampOf(record));
          const revived = [];
          for (const record of incoming) {
            const existing = byId.get(record.id);
            const grave = graves.get(`${kind}:${record.id}`);
            if (!existing && grave !== undefined && grave >= stampIn(record)) { counts.tombstoned++; if (kind === 'item') summary.skippedItemIds.push(record.id); continue; }
            if (existing && stampOf(existing) >= stampIn(record)) { counts.kept++; if (kind === 'item') summary.skippedItemIds.push(record.id); continue; }
            byId.set(record.id, record); counts[existing ? 'updated' : 'added']++; revived.push(record.id);
          }
          unbury(state, kind, revived);
          return [...byId.values()];
        };
        state.collections = merge('collection', state.collections, imported.collections, summary.collections);
        state.items = merge('item', state.items, imported.items, summary.items);
        // A skipped (newer local or deleted) collection can leave references or a cross-file cycle: repair them.
        const collectionsById = new Map(state.collections.map(c => [c.id, c]));
        const lift = collection => { collection.parentId = ''; collection.updatedAt = nextStamp(collection.updatedAt); };
        for (const collection of state.collections) {
          if (collection.parentId && (!collectionsById.has(collection.parentId) || collection.parentId === collection.id)) lift(collection);
          const seen = new Set([collection.id]);
          let parentId = collection.parentId;
          while (parentId) {
            if (parentId === collection.id) { lift(collection); break; }
            if (seen.has(parentId)) break;
            seen.add(parentId); parentId = collectionsById.get(parentId)?.parentId || '';
          }
        }
        for (const item of state.items) {
          if (item.collectionId && !collectionsById.has(item.collectionId)) { item.collectionId = ''; item.updatedAt = nextStamp(item.updatedAt); }
        }
        if (importOptions.settings === true && Object.keys(publicSettings(imported.settings)).length) {
          state.settings = mergeImportedSettings(state.settings, imported.settings);
          summary.settings = true;
        }
        result = state; extra = { importSummary: summary }; changed = true; break;
      }
      default: throw new Error('Unknown library operation.');
    }
    if (changed) {
      state.schemaVersion = target;
      state.updatedAt = nextStamp(state.updatedAt);
      await write(clone(state)); notify(state);
      if (onCommit) report(commitChange(operation, before, state, touched));
    }
    const output = clone(result);
    return extra && isObject(output) ? Object.assign(output, extra) : output;
  });
  /** Runs task() alone in the write queue (after ready()), e.g. a snapshot restore. The task must not call dispatch. */
  const exclusive = task => enqueue(() => task());
  return { dispatch, exclusive, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}

let workerMode = false;
let workerHooks = {};
let memoryState = null;
const hasExtensionStorage = () => !!globalThis.chrome?.storage?.local;
// Outside the extension worker (preview build) the library is migrated in the page, so the page takes the snapshot.
async function pageMigrationSnapshot() {
  const { localSnapshotService } = await import('./storage/snapshots.js');
  await localSnapshotService().create('before-migration');
}
const localStore = createLibraryStore({
  ready: () => workerHooks.ready?.(),
  onCommit: change => workerHooks.onCommit?.(change),
  beforeMigration: info => (workerMode ? workerHooks.beforeMigration?.(info) : pageMigrationSnapshot()),
  read: async () => {
    if (hasExtensionStorage()) return (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || null;
    if (globalThis.localStorage) {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { throw new Error('Saved library is unreadable. Restore a snapshot or backup before continuing.'); }
    }
    return memoryState;
  },
  write: async state => {
    if (hasExtensionStorage()) await chrome.storage.local.set({ [STORAGE_KEY]: state });
    else if (globalThis.localStorage) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    else memoryState = state;
  },
  withLock: task => !hasExtensionStorage() && globalThis.navigator?.locks ? navigator.locks.request(STORAGE_KEY, task) : task(),
});

// The service worker owns the library. hooks: { ready, onCommit, beforeMigration } (see createLibraryStore).
export function configureStoreWorker(hooks = {}) { workerMode = true; workerHooks = hooks || {}; }
/** Runs task() alone in this context's library write queue (the worker's, or the preview's Web Lock). */
export const runExclusive = task => localStore.exclusive(task);
export async function handleStoreOperation(operation, args) {
  if (!Array.isArray(args)) throw new Error('Library operation arguments must be an array.');
  return localStore.dispatch(operation, args);
}
async function operation(name, args) {
  if (hasExtensionStorage() && !workerMode && globalThis.chrome?.runtime?.id) {
    const response = await chrome.runtime.sendMessage({ type: STORE_MESSAGE, operation: name, args });
    if (!response?.ok) throw new Error(response?.error || 'Library service is unavailable. Reload the extension.');
    return response.result;
  }
  return localStore.dispatch(name, args);
}
export const loadLibrary = seed => operation('loadLibrary', [seed]);
export const saveItem = input => operation('saveItem', [input]);
export const updateItem = (id, patch, options = {}) => operation('updateItem', [id, patch, options]);
export const deleteItem = (id, options = {}) => operation('deleteItem', [id, options]);
export const restoreItem = (id, options = {}) => operation('restoreItem', [id, options]);
export const permanentlyDeleteItem = (id, options = {}) => operation('permanentlyDeleteItem', [id, options]);
export const createCollection = input => operation('createCollection', [input]);
export const updateCollection = (id, patch, options = {}) => operation('updateCollection', [id, patch, options]);
export const deleteCollection = (id, options = {}) => operation('deleteCollection', [id, options]);
export const mutateTags = input => operation('mutateTags', [input]);
export const bulkUpdateItems = (changes, options = {}) => operation('bulkUpdateItems', [changes, options]);
export const emptyTrash = () => operation('emptyTrash', []);
export const moveCollection = (id, placement = {}) => operation('moveCollection', [id, placement]);
export const updateSettings = patch => operation('updateSettings', [patch]);
export const importLibrary = (data, options = {}) => operation('importLibrary', [data, options]);
export const exportLibrary = async () => {
  const state = await operation('exportLibrary', []);
  // Integration tokens are device-only and never included in portable backups.
  state.settings = Object.fromEntries(Object.entries(state.settings).filter(([key]) => !/token|secret|password|credential|bridge/i.test(key)));
  return state;
};
export function subscribe(listener) {
  const unsubscribe = localStore.subscribe(listener);
  const onChromeChange = (changes, area) => { if (area === 'local' && changes[STORAGE_KEY]?.newValue) listener(clone(changes[STORAGE_KEY].newValue)); };
  const onStorage = event => { if (event.key === STORAGE_KEY && event.newValue) listener(JSON.parse(event.newValue)); };
  if (hasExtensionStorage()) chrome.storage.onChanged.addListener(onChromeChange);
  else globalThis.addEventListener?.('storage', onStorage);
  return () => { unsubscribe(); globalThis.chrome?.storage?.onChanged?.removeListener?.(onChromeChange); globalThis.removeEventListener?.('storage', onStorage); };
}

export function queryItems(state, filters = {}) {
  let query = text(filters.query).toLowerCase().trim();
  const tokenTags = [...query.matchAll(/(?:^|\s)(?:tag:|#)([^\s]+)/g)].map(match => match[1]);
  const typeToken = query.match(/(?:^|\s)type:([^\s]+)/)?.[1];
  query = query.replace(/(?:^|\s)(?:tag:|#|type:)[^\s]+/g, ' ').trim();
  const terms = query.match(/"[^"]+"|\S+/g)?.map(term => term.replace(/^"|"$/g, '')) || [];
  const results = state.items.filter(item => {
    if (filters.trash ? !item.deletedAt : item.deletedAt) return false;
    if (filters.archived === true ? !item.archived : filters.archived !== 'all' && !filters.trash && item.archived) return false;
    if (filters.favorite && !item.favorite) return false;
    if (filters.collectionId !== undefined && filters.collectionId !== null && item.collectionId !== filters.collectionId) return false;
    if ((filters.type || typeToken) && (filters.type || typeToken) !== 'all' && item.type !== (filters.type || typeToken)) return false;
    const tags = item.tags.map(tag => tag.toLowerCase());
    if (filters.tag && !tags.includes(filters.tag.toLowerCase())) return false;
    if (tokenTags.some(tag => !tags.includes(tag))) return false;
    const haystack = [item.title, item.url, item.excerpt, item.content, item.articleContent, ...item.tags, ...item.highlights.map(h => h.text)].join(' ').toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
  const sort = filters.sort || 'newest';
  return results.sort((a, b) => {
    if (sort === 'title' || sort === 'a-z') return a.title.localeCompare(b.title);
    if (sort === 'oldest') return a.createdAt.localeCompare(b.createdAt);
    if (sort === 'updated' || sort === 'recent') return b.updatedAt.localeCompare(a.updatedAt);
    return b.createdAt.localeCompare(a.createdAt);
  });
}

let attachmentDb;
function openAttachmentDb() {
  if (!globalThis.indexedDB) throw new Error('This browser does not support local file storage.');
  if (!attachmentDb) attachmentDb = new Promise((resolve, reject) => {
    const request = indexedDB.open('still.attachments.v1', 1);
    // Guarded so a future version bump can reuse this handler without failing on the existing store.
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Let another view upgrade the database (or the browser close it) and reopen on the next call.
      db.onversionchange = () => { db.close(); attachmentDb = null; };
      db.onclose = () => { attachmentDb = null; };
      resolve(db);
    };
    request.onerror = () => { attachmentDb = null; reject(request.error || new Error('File storage could not be opened.')); };
    request.onblocked = () => { attachmentDb = null; reject(new Error('Close other Still tabs so file storage can update, then try again.')); };
  });
  return attachmentDb;
}
async function attachmentTransaction(mode, action) {
  const db = await openAttachmentDb();
  return new Promise((resolve, reject) => {
    let transaction;
    try { transaction = db.transaction('files', mode); }
    catch (error) { attachmentDb = null; reject(error); return; }
    const request = action(transaction.objectStore('files'));
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('File storage was interrupted.'));
  });
}
export async function saveAttachment(file) {
  if (!(file instanceof Blob)) throw new Error('Choose a file to attach.');
  const record = { id: uid('file'), blob: file, name: file.name || 'attachment', mime: file.type, size: file.size, createdAt: now() };
  await attachmentTransaction('readwrite', store => store.add(record));
  return { attachmentId: record.id, fileName: record.name, mime: record.mime, size: record.size };
}
export const getAttachment = id => attachmentTransaction('readonly', store => store.get(id));
export const deleteAttachment = id => attachmentTransaction('readwrite', store => store.delete(id));
