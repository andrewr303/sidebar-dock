import {
  LIBRARY_SCHEMA_VERSION, LIBRARY_MIGRATIONS, assertLibraryVersion, migrateLibrary,
} from './storage/migrations.js';
import { MAX_PAGE_DEPTH, pageIndex, childrenOf, wouldCycle, pageDepth, pageHeight } from './pages.js';
import { chatItemId } from './threadkeeper/protocol.js';

export const STORAGE_KEY = 'still.library.v1';
export const ITEM_TYPES = ['bookmark', 'article', 'image', 'video', 'file', 'note', 'chat'];
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
  'reminderNotifiedAt', 'attachmentId', 'fileName', 'mime', 'size', 'pinned', 'read', 'sticky', 'chat',
  'parentId', 'siteName', 'author', 'publishedAt', 'icon', 'lang']);
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

// Page metadata captured with an article (publisher, byline, date, icon, language). Each is optional: '' when unknown.
const oneLine = (value, max) => text(value).replace(/\s+/g, ' ').trim().slice(0, max).trim();
function isoDate(value) {
  const time = Date.parse(text(value).trim());
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}
// A page icon is a web address or a small inline image: base64 raster, SVG or ICO data, or percent-encoded SVG (raw
// double quotes, angle brackets, backslashes and spaces are refused). Anything else is dropped.
export const MAX_ICON_DATA = 16 * 1024;
const ICON_BASE64 = /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}$/i;
const ICON_SVG = /^data:image\/svg\+xml(?:;charset=utf-8|;utf8)?,[\w%!$&'()*+,;=:@/?#.~[\]-]+$/i;
function iconUrl(value) {
  const str = text(value).trim();
  if (!str) return '';
  if (/^data:/i.test(str)) return str.length <= MAX_ICON_DATA && (ICON_BASE64.test(str) || ICON_SVG.test(str)) ? str : '';
  if (str.length > 8192) return '';
  try { return safeUrl(str); } catch { return ''; }
}
const langTag = value => { const tag = text(value).trim().replace(/_/g, '-'); return tag.length <= 35 && /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/i.test(tag) ? tag : ''; };
// Only notes sit inside a page, and never inside themselves. Whether the parent exists is checked by the store ops.
const MAX_PARENT_ID = 200;
const pageParent = (value, type, id) => { const parentId = type === 'note' ? text(value).trim() : ''; return parentId && parentId !== id && parentId.length <= MAX_PARENT_ID ? parentId : ''; };

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

/*
 * AI chats from Threadkeeper (item type 'chat'). The library keeps only this compact `chat` object; the analysis and the
 * transcript live in IndexedDB (lib/chat-data.js). Chats are created only by upsertChats and by imports or restores, are
 * never converted to or from another type, have no `url` (the original thread link is `sourceUrl`), and their id is
 * always chatItemId(threadKey). Title, excerpt and collection are written by sync only while the user has not changed
 * them: syncedTitleHash / syncedExcerptHash hold chatTextHash() of what sync last wrote and autoCollectionId the
 * collection it last chose. `content`, tags the user added and subpages are the user's own and are never written by sync.
 */
export const CHAT_CATEGORIES = Object.freeze(['chat', 'coding_agent', 'agent', 'builder', 'search', 'companion']);
export const CHAT_WORKFLOW_STATES = Object.freeze(['active', 'needs_review', 'waiting', 'paused', 'done', 'archived']);
export const CHAT_ORIGINS = Object.freeze(['sync', 'manual', 'assistant', 'import']);
// '' = live; deleted / out_of_scope / local_only came from Threadkeeper; disconnected = trashed by "Disconnect and remove".
export const CHAT_REMOVED_REASONS = Object.freeze(['deleted', 'out_of_scope', 'local_only', 'disconnected']);
export const CHAT_LIMITS = Object.freeze({ batch: 100, threadKey: 600, title: 300, excerpt: 300, topics: 8, topic: 40, tags: 20, tag: 60 });
// Operations whose hard deletes are Still's own bookkeeping, not "the user deleted this chat forever" (the worker's
// onCommit hook dismisses chats deleted by any other operation).
export const CHAT_SYSTEM_DELETES = Object.freeze(['markChatsRemoved', 'deleteChats']);
const CHAT_FIELDS = new Set(['v', 'source', 'threadKey', 'provider', 'providerLabel', 'category', 'kind', 'project', 'model', 'workflowState',
  'messageCount', 'lastActivityAt', 'topics', 'analysis', 'analysisVersion', 'fingerprint', 'revision', 'seq', 'hasTranscript',
  'transcriptTruncated', 'origin', 'syncedAt', 'syncedTitleHash', 'syncedExcerptHash', 'syncedTags', 'autoCollectionId', 'removed']);
const CHAT_ANALYSIS_FIELDS = new Set(['source', 'generatedAt']);
const count = (value, max = Number.MAX_SAFE_INTEGER) => { const n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, max) : 0; };
const oneOf = (value, allowed, fallback = '') => (allowed.includes(value) ? value : fallback);
const capList = (value, max, each) => {
  const seen = new Set(), out = [];
  for (const entry of list(value)) {
    const clean = oneLine(entry, each), key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key); out.push(clean);
    if (out.length >= max) break;
  }
  return out;
};
const chatHashPattern = /^[0-9a-f]{8}$/;
/** 8 hex chars (FNV-1a 32 over UTF-8) of a title or excerpt as the item stores it: sync's "did the user change it" check. */
export function chatTextHash(value) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text(value))) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}
const chatThreadKey = value => { const key = text(value).trim(); return key.length <= CHAT_LIMITS.threadKey ? key : ''; };

/**
 * The stored `chat` object for an item type ('chat' only), or null. Every field is coerced and capped; `stored` is the
 * saved object (keys this build does not know are kept from it).
 */
export function normalizeChat(value, type = 'chat', stored = null) {
  if (type !== 'chat' || !isObject(value)) return null;
  const analysis = isObject(value.analysis) ? value.analysis : {};
  return keepUnknown({
    v: 1, source: 'threadkeeper',
    threadKey: chatThreadKey(value.threadKey),
    provider: /^[a-z0-9_]{1,40}$/.test(text(value.provider)) ? value.provider : '',
    providerLabel: oneLine(value.providerLabel, 80),
    category: oneOf(value.category, CHAT_CATEGORIES, 'chat'),
    kind: oneLine(value.kind, 40), project: oneLine(value.project, 200), model: oneLine(value.model, 120),
    workflowState: oneOf(value.workflowState, CHAT_WORKFLOW_STATES),
    messageCount: count(value.messageCount, 10000000),
    lastActivityAt: isoDate(value.lastActivityAt),
    topics: capList(value.topics, CHAT_LIMITS.topics, CHAT_LIMITS.topic),
    analysis: keepUnknown({ source: oneOf(analysis.source, ['ai', 'local']), generatedAt: isoDate(analysis.generatedAt) },
      isObject(stored?.analysis) ? stored.analysis : null, CHAT_ANALYSIS_FIELDS),
    analysisVersion: count(value.analysisVersion, 1000),
    fingerprint: oneLine(value.fingerprint, 128), revision: count(value.revision), seq: count(value.seq),
    hasTranscript: value.hasTranscript === true, transcriptTruncated: value.transcriptTruncated === true,
    origin: oneOf(value.origin, CHAT_ORIGINS, 'sync'),
    syncedAt: isoDate(value.syncedAt),
    syncedTitleHash: chatHashPattern.test(text(value.syncedTitleHash)) ? value.syncedTitleHash : '',
    syncedExcerptHash: chatHashPattern.test(text(value.syncedExcerptHash)) ? value.syncedExcerptHash : '',
    syncedTags: capList(value.syncedTags, CHAT_LIMITS.tags, CHAT_LIMITS.tag),
    autoCollectionId: oneLine(value.autoCollectionId, MAX_PARENT_ID),
    removed: oneOf(value.removed, CHAT_REMOVED_REASONS),
  }, stored, CHAT_FIELDS);
}

/**
 * Whether the user made a chat their own: notes, live subpages, tags they added, favorite, a rename or a move. Sync
 * never trashes or deletes such a chat. `items` is the library's item list (for subpages).
 */
export function isChatTouched(item, items = []) {
  if (!isObject(item) || item.type !== 'chat') return false;
  const chat = isObject(item.chat) ? item.chat : {};
  const synced = new Set((chat.syncedTags || []).map(tag => String(tag).toLowerCase()));
  if (text(item.content).trim() || item.favorite === true) return true;
  if ((item.tags || []).some(tag => !synced.has(String(tag).toLowerCase()))) return true;
  if (chatTextHash(item.title) !== chat.syncedTitleHash) return true;
  if (text(item.collectionId) !== text(chat.autoCollectionId)) return true;
  return (Array.isArray(items) ? items : []).some(other => isObject(other) && other.parentId === item.id && !other.deletedAt);
}

/**
 * Validates and fills an item. `existing` is the stored record being edited: its unknown keys survive. With
 * { stored: true } the input itself is stored data (seed, import, backup): its unknown keys and a valid updatedAt are kept.
 * A chat's `chat` object is taken from the input only for stored data and for the store's own chat operations
 * (`syncChat`); every other edit keeps the stored one.
 */
export function normalizeItem(input, existing = {}, { stored = false, syncChat = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Item must be an object.');
  const merged = { ...existing, ...input };
  // A partial sticky patch ({ sticky: { x, y } }) updates the stored placement; null turns the sticky back into a plain note.
  const stickyPatch = input.sticky && typeof input.sticky === 'object' && !Array.isArray(input.sticky) && existing.sticky && typeof existing.sticky === 'object';
  if (stickyPatch) merged.sticky = { ...existing.sticky, ...input.sticky };
  const type = merged.type || 'bookmark';
  if (!ITEM_TYPES.includes(type)) throw new Error('Unknown item type.');
  if (existing.type && existing.type !== type && (existing.type === 'chat' || type === 'chat')) throw new Error('Chats cannot be converted.');
  let chat = null;
  if (type === 'chat') {
    const source = stored || syncChat || !existing.type ? merged.chat : existing.chat;
    chat = normalizeChat(source, type, stored ? merged.chat : existing.chat);
    const id = text(existing.id) || text(input.id);
    if (!chat?.threadKey || id !== chatItemId(chat.threadKey)) throw new Error('A chat needs its Threadkeeper thread.');
  }
  const url = type === 'chat' ? '' : safeUrl(merged.url);
  if (['bookmark', 'image', 'video'].includes(type) && !url && !merged.attachmentId && !merged.cover) {
    throw new Error('This item needs a URL or attached file.');
  }
  const savedHighlights = new Map([...(Array.isArray(existing.highlights) ? existing.highlights : []),
    ...(stored && Array.isArray(input.highlights) ? input.highlights : [])].filter(h => isObject(h) && text(h.id)).map(h => [h.id, h]));
  const createdAt = text(existing.createdAt) || text(input.createdAt) || now();
  const id = text(existing.id) || text(input.id) || uid('item');
  const item = {
    id, type,
    title: text(merged.title).trim() || (url ? new URL(url).hostname : type === 'note' ? 'Untitled note' : type === 'chat' ? 'Untitled chat' : 'Untitled item'),
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
    ...(chat ? { chat } : {}),
    parentId: pageParent(merged.parentId, type, id),
    siteName: oneLine(merged.siteName, 200), author: oneLine(merged.author, 300), publishedAt: isoDate(merged.publishedAt),
    icon: iconUrl(merged.icon), lang: langTag(merged.lang),
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

// Ids below rootId in a page index, following only children whose current record matches `follow` (the walk stops at the
// first child that does not). `current` reads the latest copy of a record while a change is being built.
function subtreeIds(index, rootId, follow, current = id => index.byId.get(id)) {
  const out = [], seen = new Set([rootId]), stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    for (const child of childrenOf(index, id, { includeDeleted: true })) {
      const record = current(child.id);
      if (seen.has(child.id) || !record || record.parentId !== id || !follow(record)) continue;
      seen.add(child.id); out.push(child.id); stack.push(child.id);
    }
  }
  return out;
}

// Seed and import repair for subpages: a parent that is missing, a non-note child, a page that sits inside itself
// through a loop, or one nested deeper than MAX_PAGE_DEPTH moves to the top level. `order` decides which page of a loop
// is lifted (the first one met). With `bump` each repaired record gets a new updatedAt.
function repairPages(items, { bump = true, order = items } = {}) {
  const byId = new Map(items.map(item => [item.id, item]));
  const lift = item => { item.parentId = ''; if (bump) item.updatedAt = nextStamp(item.updatedAt); };
  for (const item of items) {
    if (item.parentId && (item.type !== 'note' || item.parentId === item.id || !byId.has(item.parentId))) lift(item);
  }
  for (const item of order) {
    const seen = new Set([item.id]);
    let depth = 0;
    for (let parentId = item.parentId; parentId; parentId = byId.get(parentId)?.parentId || '') {
      if (parentId === item.id || ++depth > MAX_PAGE_DEPTH) { lift(item); break; }
      if (seen.has(parentId)) break;
      seen.add(parentId);
    }
  }
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
    if (!state) {
      state = args[0] && operation === 'loadLibrary' ? validateLibrary(args[0], libraryOptions) : emptyLibrary(target);
      repairPages(state.items, { bump: false });
    }
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
    // An explicit request to put a page inside itself is refused (normalizeItem would quietly drop it).
    const refuseSelfParent = (id, value) => {
      if (isObject(value) && typeof value.parentId === 'string' && value.parentId.trim() && value.parentId.trim() === id) throw new Error('A page cannot be placed inside itself.');
    };
    // normalizeItem also quietly drops a parent id no item could have (not a string, or longer than an id). For a note an
    // explicit request like that is refused, instead of moving the page to the top level. null and '' mean the top level.
    const refuseBadParent = (value, type) => {
      if (!isObject(value) || type !== 'note' || value.parentId === undefined || value.parentId === null) return;
      if (typeof value.parentId !== 'string' || value.parentId.trim().length > MAX_PARENT_ID) throw new Error('That page no longer exists.');
    };
    /*
     * Every item edit goes through here so subpages stay consistent. changes: [[existing | null, next]] (normalized).
     * 1. A note given a new parent needs a live parent, no loop and room under MAX_PAGE_DEPTH, all judged on the state
     *    after the whole change, so one batch cannot build a loop (A inside B and B inside A).
     * 2. Restoring a page restores the subpages trashed together with it (the identical deletedAt stamp); a restored
     *    page whose parent is still in Trash (or sent there by the same batch) or gone moves to the top level.
     * 3. Trashing a page gives its live subpages its exact deletedAt stamp (a page already in Trash that gets a new stamp
     *    takes the subpages trashed with it along). Pages are stamped from the top of each tree down, and a subpage the
     *    same batch also trashes (with any stamp) or only edits takes its ancestor's, so the two stay "trashed together".
     * 4. A page moved into another takes that page's collection, and so does its whole live subtree (even when the moved
     *    page already had it); a page's collection change carries down to its live subpages, counting those the same
     *    batch trashes with it (subpages given their own collection in the same batch keep it).
     * Records changed only by a cascade get a new updatedAt (onCommit reports them). Returns the final `next` records.
     */
    const commitItems = changes => {
      const post = new Map(state.items.map(item => [item.id, item]));
      const previous = new Map();
      for (const [existing, next] of changes) { post.set(next.id, next); previous.set(next.id, existing || null); }
      const pageWork = changes.some(([existing, next]) => (existing ? next.parentId !== (existing.parentId || '') || (next.deletedAt || null) !== (existing.deletedAt || null)
        || next.collectionId !== text(existing.collectionId) : !!next.parentId));
      const bumped = new Set();
      const touch = (id, patch) => {
        const record = { ...post.get(id), ...patch };
        if (!previous.has(id) && !bumped.has(id)) { record.updatedAt = nextStamp(record.updatedAt); bumped.add(id); }
        post.set(id, record);
      };
      if (pageWork) {
        let index = pageIndex(post);
        const below = (id, follow) => subtreeIds(index, id, follow, key => post.get(key));
        const moved = new Set();
        for (const [existing, next] of changes) {
          if (!next.parentId || next.parentId === (existing?.parentId || '')) continue;
          const parent = post.get(next.parentId);
          if (!parent || parent.deletedAt) throw new Error('That page no longer exists.');
          if (wouldCycle(index, next.id, next.parentId)) throw new Error('A page cannot be placed inside itself.');
          moved.add(next.id);
        }
        for (const id of moved) {
          if (pageDepth(index, id) + pageHeight(index, id) > MAX_PAGE_DEPTH) throw new Error(`Pages can be nested ${MAX_PAGE_DEPTH} levels deep.`);
        }
        const restored = changes.filter(([existing, next]) => existing?.deletedAt && !next.deletedAt);
        for (const [existing, next] of restored) for (const id of below(next.id, item => item.deletedAt === existing.deletedAt)) touch(id, { deletedAt: null });
        // Top of each tree first, so an ancestor's stamp reaches a subpage the batch trashes with a stamp of its own.
        const trashing = changes.filter(([existing, next]) => existing && next.deletedAt && next.deletedAt !== existing.deletedAt)
          .sort(([, a], [, b]) => pageDepth(index, a.id) - pageDepth(index, b.id));
        const stamped = new Set();
        for (const [existing, next] of trashing) {
          if (stamped.has(next.id)) continue;
          // Never treat two missing stamps as "trashed together": a live page takes only live subpages, a trashed one
          // only those with its old stamp. A subpage in this batch counts by its state before the batch, so one the batch
          // only edits (tags, title, collection) or trashes too is followed, and one it restores stays out.
          const from = existing.deletedAt || null;
          const together = item => (previous.has(item.id) ? (previous.get(item.id)?.deletedAt || null) === from && (!from || !!item.deletedAt)
            : from ? item.deletedAt === from : !item.deletedAt);
          for (const id of below(next.id, together)) { touch(id, { deletedAt: next.deletedAt }); stamped.add(id); }
        }
        // After the trash cascade, so a parent this same batch sends to Trash (directly or through its own parent) counts.
        let lifted = false;
        for (const [, next] of restored) {
          const parentId = post.get(next.id).parentId;
          if (parentId && (!post.get(parentId) || post.get(parentId).deletedAt)) { touch(next.id, { parentId: '' }); lifted = true; }
        }
        if (lifted) index = pageIndex(post);
        const anchors = changes.filter(([existing, next]) => existing && (moved.has(next.id) || next.collectionId !== text(existing.collectionId))).map(([, next]) => next.id);
        const anchored = new Set(anchors);
        anchors.sort((a, b) => pageDepth(index, a) - pageDepth(index, b));
        for (const id of anchors) {
          const parent = moved.has(id) ? post.get(post.get(id).parentId) : null;
          if (parent && post.get(id).collectionId !== text(parent.collectionId)) touch(id, { collectionId: text(parent.collectionId) });
          const collectionId = post.get(id).collectionId;
          // A moved page always carries its parent's collection down: it may already have had it while its subpages did not.
          if (!moved.has(id) && collectionId === text(previous.get(id).collectionId)) continue;
          // A subpage this batch sent to Trash along with a page counts as live here, so the tree comes back in one collection.
          for (const child of below(id, item => (!item.deletedAt || stamped.has(item.id)) && !anchored.has(item.id))) {
            if (post.get(child).collectionId !== collectionId) touch(child, { collectionId });
          }
        }
      }
      const positions = new Map(state.items.map((item, position) => [item.id, position]));
      for (const id of new Set([...previous.keys(), ...bumped])) {
        if (positions.has(id)) state.items[positions.get(id)] = post.get(id);
        else { positions.set(id, state.items.length); state.items.push(post.get(id)); }
      }
      return changes.map(([, next]) => post.get(next.id));
    };
    /*
     * Deletes items for good. Their surviving subpages move up to the nearest page that stays (or the top level), with a
     * new updatedAt. Backlinks are cleared and each id leaves a tombstone. Returns { ids, attachmentIds }: the file blobs
     * that no remaining item uses, for the caller to delete.
     */
    const removeItems = removed => {
      const byId = new Map(state.items.map(item => [item.id, item]));
      const survivor = (parentId, childId) => {
        const seen = new Set();
        while (parentId && removed.has(parentId) && !seen.has(parentId)) { seen.add(parentId); parentId = byId.get(parentId)?.parentId || ''; }
        return parentId && parentId !== childId && byId.has(parentId) && !removed.has(parentId) ? parentId : '';
      };
      for (const item of state.items) {
        if (removed.has(item.id) || !item.parentId || !removed.has(item.parentId)) continue;
        item.parentId = survivor(item.parentId, item.id); item.updatedAt = nextStamp(item.updatedAt);
      }
      const gone = state.items.filter(item => removed.has(item.id));
      state.items = state.items.filter(item => !removed.has(item.id));
      unlink(removed);
      bury(state, 'item', gone.map(item => item.id));
      const stillUsed = new Set(state.items.map(item => item.attachmentId).filter(Boolean));
      return { ids: gone.map(item => item.id), attachmentIds: [...new Set(gone.map(item => item.attachmentId).filter(id => id && !stillUsed.has(id)))] };
    };
    /*
     * Collections a chat operation may need: [{ key, name, parentKey?, parentId?, icon?, color? }]. A key is resolved on
     * first use only (so a batch that changes nothing creates nothing): a live collection with the same name (trimmed, any
     * case) under the same parent is reused, else one is created. parentKey refers to another spec, parentId to an
     * existing collection (gone or in Trash → top level). place({ collectionKey } | { collectionId }) → collection id or
     * '' (Inbox): an id that no longer exists falls back to the Inbox.
     */
    const collectionPlanner = specs => {
      const byKey = new Map(), resolved = new Map(), busy = new Set();
      let created = 0;
      for (const spec of Array.isArray(specs) ? specs : []) {
        const key = isObject(spec) ? text(spec.key) : '';
        if (key && oneLine(spec.name, 200) && !byKey.has(key)) byKey.set(key, spec);
      }
      const live = id => !!id && state.collections.some(c => c.id === id && !c.deletedAt);
      const ensure = key => {
        if (resolved.has(key)) return resolved.get(key).id;
        const spec = byKey.get(key);
        if (!spec || busy.has(key)) return '';
        busy.add(key);
        const parentId = text(spec.parentKey) ? ensure(text(spec.parentKey)) : live(text(spec.parentId)) ? text(spec.parentId) : '';
        busy.delete(key);
        const name = oneLine(spec.name, 200), lower = name.toLowerCase();
        const match = state.collections.find(c => !c.deletedAt && (c.parentId || '') === parentId && text(c.name).trim().toLowerCase() === lower);
        if (match) { resolved.set(key, { id: match.id, created: false }); return match.id; }
        const collection = normalizeCollection({ name, parentId, ...(text(spec.icon) ? { icon: oneLine(spec.icon, 100) } : {}), ...(text(spec.color) ? { color: spec.color } : {}) });
        state.collections.push(collection);
        unbury(state, 'collection', [collection.id]);
        resolved.set(key, { id: collection.id, created: true }); created++;
        return collection.id;
      };
      return {
        // undefined when the entry asks for no placement.
        target: placement => {
          if (!isObject(placement)) return undefined;
          if (text(placement.collectionKey)) return { key: text(placement.collectionKey), force: placement.force === true };
          if (typeof placement.collectionId === 'string') return { id: placement.collectionId.trim(), force: placement.force === true };
          return undefined;
        },
        place: target => (target.key !== undefined ? ensure(target.key) : live(target.id) ? target.id : ''),
        get created() { return created; },
        report: () => [...resolved].map(([key, { id, created: made }]) => ({ key, id, created: made })),
      };
    };
    // The chat fields a Threadkeeper sync writes; origin, removed and the synced* bookkeeping belong to the store.
    const SYNC_CHAT_FIELDS = ['provider', 'providerLabel', 'category', 'kind', 'project', 'model', 'workflowState', 'messageCount',
      'lastActivityAt', 'topics', 'analysis', 'analysisVersion', 'revision', 'hasTranscript', 'transcriptTruncated'];
    const syncFields = chat => Object.fromEntries(SYNC_CHAT_FIELDS.filter(key => Object.hasOwn(chat, key)).map(key => [key, chat[key]]));
    // What a chat sync can change, for the "unchanged" check. syncedAt and updatedAt are clocks; a newer seq alone (the
    // same thread offered again, e.g. after an epoch change) is not worth a library write either.
    const chatView = item => JSON.stringify([item.title, item.excerpt, item.sourceUrl, item.siteName, item.collectionId, item.deletedAt || null,
      item.tags, { ...item.chat, syncedAt: '', seq: 0 }]);
    switch (operation) {
      case 'loadLibrary': case 'exportLibrary': result = state; break;
      case 'saveItem': {
        if (input?.type === 'chat') throw new Error('Chats come from Threadkeeper.');
        const valid = normalizeItem(input);
        const existing = input.id ? state.items.find(i => i.id === input.id) : valid.url && valid.type !== 'note'
          ? state.items.find(i => !i.deletedAt && i.type !== 'note' && canonicalUrl(i.url) === canonicalUrl(valid.url)) : null;
        // Saving a page again never blanks what was captured before (metadata a new capture could not read stays). The
        // page details compare the NORMALIZED incoming value (`valid`), so a non-empty but invalid one (an unparsable date,
        // a javascript: icon) cannot win the merge and then normalize to '' over the stored value.
        const nextInput = existing && !input.id ? { ...input,
          content: input.content || existing.content, articleContent: input.articleContent || existing.articleContent, excerpt: input.excerpt || existing.excerpt,
          cover: valid.cover || existing.cover, collectionId: input.collectionId || existing.collectionId,
          siteName: valid.siteName || existing.siteName, author: valid.author || existing.author, publishedAt: valid.publishedAt || existing.publishedAt,
          icon: valid.icon || existing.icon, lang: valid.lang || existing.lang,
          tags: list([...existing.tags, ...valid.tags]),
          highlights: [...existing.highlights, ...valid.highlights], relatedIds: list([...existing.relatedIds, ...valid.relatedIds]) } : input;
        refuseSelfParent(text(input.id), input);
        result = normalizeItem(nextInput, existing || {});
        refuseBadParent(input, result.type);
        // A new subpage lands in its parent's collection unless the caller chose one.
        const parent = !existing && result.parentId ? state.items.find(i => i.id === result.parentId) : null;
        if (parent && !text(input.collectionId) && parent.collectionId && state.collections.some(c => c.id === parent.collectionId)) result.collectionId = parent.collectionId;
        if (result.collectionId) findCollection(result.collectionId);
        [result] = commitItems([[existing || null, result]]);
        unbury(state, 'item', [result.id]);
        changed = true; break;
      }
      case 'updateItem': {
        const existing = findItem(input);
        assertRevision(existing, options);
        refuseSelfParent(input, patch);
        const next = normalizeItem({ ...patch, id: input }, existing);
        refuseBadParent(patch, next.type);
        if (next.collectionId) findCollection(next.collectionId);
        [result] = commitItems([[existing, next]]);
        changed = true; break;
      }
      case 'deleteItem': case 'restoreItem': {
        // Trash and restore carry the page's subpages along (see commitItems).
        const existing = findItem(input);
        assertRevision(existing, patch);
        [result] = commitItems([[existing, normalizeItem({ deletedAt: operation === 'deleteItem' ? now() : null }, existing)]]);
        changed = true; break;
      }
      case 'permanentlyDeleteItem': {
        // From Trash, the subpages trashed together with the item (same deletedAt) are deleted too. A live item (the
        // assistant's undo deletes notes it created) never takes subpages with it. Other subpages move up a level.
        // Returns { id, ids, attachmentIds } (every deleted id, and the file blobs nothing uses any more).
        const target = findItem(input);
        assertRevision(target, patch);
        const together = target.deletedAt ? subtreeIds(pageIndex(state.items), input, item => item.deletedAt === target.deletedAt) : [];
        result = { id: input, ...removeItems(new Set([input, ...together])) }; changed = true; break;
      }
      case 'movePage': {
        // Moves a note into another item ({ parentId }) or to the top level (parentId: ''). Inside a page it takes that
        // page's collection, and so do its subpages. Optional expectedUpdatedAt.
        const existing = findItem(input);
        assertRevision(existing, patch);
        if (existing.type !== 'note') throw new Error('Only notes can be moved inside a page.');
        if (existing.deletedAt) throw new Error('Restore this page from Trash before moving it.');
        refuseBadParent(patch, existing.type);
        const parentId = typeof patch?.parentId === 'string' ? patch.parentId.trim() : existing.parentId;
        refuseSelfParent(input, { parentId });
        if (parentId === (existing.parentId || '')) { result = existing; break; }
        [result] = commitItems([[existing, normalizeItem({ parentId }, existing)]]);
        changed = true; break;
      }
      case 'upsertContentSection': {
        // The research agent's write, read and applied inside the queue so a concurrent edit is never lost:
        // { previous, next, field }. When `previous` is non-empty and found, its LAST occurrence becomes `next`;
        // otherwise `next` is appended after a blank line. Only content (and articleContent, for the original-edit path).
        // Returns { item, replaced }.
        const existing = findItem(input);
        const { previous = '', next, field = 'content' } = isObject(patch) ? patch : {};
        if (!['content', 'articleContent'].includes(field)) throw new Error('Only the note or the saved page text can be written here.');
        if (typeof next !== 'string' || typeof previous !== 'string') throw new Error('Write the section as Markdown text.');
        const current = text(existing[field]);
        const at = previous ? current.lastIndexOf(previous) : -1;
        const gap = !current || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
        const value = at >= 0 ? current.slice(0, at) + next + current.slice(at + previous.length) : next ? current + gap + next : current;
        if (field === 'articleContent' && value.length > 250000) throw new Error('The saved page text is limited to 250,000 characters.');
        if (value === current) { result = { item: existing, replaced: at >= 0 }; break; }
        const [item] = commitItems([[existing, normalizeItem({ [field]: value }, existing)]]);
        result = { item, replaced: at >= 0 }; changed = true; break;
      }
      case 'bulkUpdateItems': {
        // One write for many item patches: [{ id, patch }]. Trash via patch.deletedAt, restore via deletedAt: null.
        if (!Array.isArray(input) || !input.length) throw new Error('Choose at least one item.');
        if (patch?.expectedLibraryUpdatedAt && patch.expectedLibraryUpdatedAt !== state.updatedAt) throw new Error('Conflict: the library changed. Refresh before applying these changes.');
        const updates = input.map(entry => {
          if (!entry || typeof entry.id !== 'string' || !entry.patch || typeof entry.patch !== 'object') throw new Error('Each change needs an item id and a patch.');
          const existing = findItem(entry.id);
          refuseSelfParent(entry.id, entry.patch);
          const next = normalizeItem({ ...entry.patch, id: entry.id }, existing);
          refuseBadParent(entry.patch, next.type);
          if (next.collectionId) findCollection(next.collectionId);
          return [existing, next];
        });
        // Trash and restore patches cascade to subpages exactly like deleteItem and restoreItem (see commitItems).
        result = commitItems(updates); changed = true; break;
      }
      case 'emptyTrash': {
        // Live subpages of trashed pages (left by an older build) move up to a page that stays.
        const removed = new Set(state.items.filter(i => i.deletedAt).map(i => i.id));
        result = removeItems(removed);
        changed = removed.size > 0; break;
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
        const revivedItems = new Set();
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
          if (kind === 'item') for (const id of revived) revivedItems.add(id);
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
        // Subpages whose parent did not come in (missing from the file and this library, skipped or deleted here), or that
        // would sit inside themselves across the file and this library, move to the top level. In a loop, an incoming
        // page is lifted before a local one.
        repairPages(state.items, { order: [...state.items.filter(item => revivedItems.has(item.id)), ...state.items.filter(item => !revivedItems.has(item.id))] });
        if (importOptions.settings === true && Object.keys(publicSettings(imported.settings)).length) {
          state.settings = mergeImportedSettings(state.settings, imported.settings);
          summary.settings = true;
        }
        result = state; extra = { importSummary: summary }; changed = true; break;
      }
      case 'upsertChats': {
        /*
         * Threadkeeper threads into chat items, in one write: upsertChats(entries, { revive, ensureCollections, dismissedIds }).
         * entry: { threadKey, id? (must be chatItemId(threadKey)), fingerprint, seq, origin, revive?, tags?,
         *   item: { title, excerpt, sourceUrl, siteName, createdAt }, chat: { provider, …, revision, hasTranscript, … },
         *   placement?: { collectionId } | { collectionKey } (+ force: true to move a chat the user moved, for manual sends) }.
         * Rules (against the stored record, inside the queue): an id that is not a chat of this thread → skipped/invalid; an
         * older seq → skipped/stale; a new id listed in dismissedIds (deleted forever by the user) → skipped/dismissed
         * unless revive; a chat in Trash only refreshes its chat metadata (skipped/trashed) unless revive, which restores
         * it (with the subpages trashed with it) and applies the placement. Title, excerpt and collection change only
         * while the user has not changed them; notes, tags, favorite, archive, links and subpages are never touched.
         * Nothing is written when every entry is unchanged or skipped.
         * Returns { results: [{ threadKey, id, status, reason?, fingerprint?, seq? }], collections: [{ key, id, created }] }.
         */
        if (!Array.isArray(input)) throw new Error('Send a list of chats.');
        if (input.length > CHAT_LIMITS.batch) throw new Error(`Send at most ${CHAT_LIMITS.batch} chats at once.`);
        const opts = isObject(patch) ? patch : {};
        const dismissed = new Set(list(opts.dismissedIds));
        const planner = collectionPlanner(opts.ensureCollections);
        const byId = new Map(state.items.map(item => [item.id, item]));
        const stamp = now(), changes = [], created = [], results = [], seen = new Set();
        for (const entry of input) {
          const threadKey = isObject(entry) ? chatThreadKey(entry.threadKey) : '';
          const id = threadKey ? chatItemId(threadKey) : '';
          const done = (status, extra = {}) => results.push({ threadKey: threadKey || (isObject(entry) ? text(entry.threadKey).slice(0, CHAT_LIMITS.threadKey) : ''), id, status, ...extra });
          if (!threadKey || !isObject(entry.chat) || (entry.id !== undefined && entry.id !== id) || seen.has(id)) { done('skipped', { reason: 'invalid' }); continue; }
          seen.add(id);
          const existing = byId.get(id);
          if (existing && (existing.type !== 'chat' || existing.chat?.threadKey !== threadKey)) { done('skipped', { reason: 'invalid' }); continue; }
          const revive = opts.revive === true || entry.revive === true;
          const info = isObject(entry.item) ? entry.item : {};
          const incoming = { ...syncFields(entry.chat), threadKey, fingerprint: oneLine(entry.fingerprint ?? entry.chat.fingerprint, 128), seq: count(entry.seq ?? entry.chat.seq) };
          let sourceUrl = '';
          try { sourceUrl = safeUrl(text(info.sourceUrl).trim()); } catch { sourceUrl = ''; }
          const fields = { title: oneLine(info.title, CHAT_LIMITS.title) || 'Untitled chat', excerpt: oneLine(info.excerpt, CHAT_LIMITS.excerpt),
            sourceUrl, siteName: oneLine(info.siteName || entry.chat.providerLabel, 200) };
          const target = planner.target(entry.placement);
          try {
            if (!existing) {
              if (dismissed.has(id) && !revive) { done('skipped', { reason: 'dismissed' }); continue; }
              const collectionId = target ? planner.place(target) : '';
              const tags = capList(entry.tags, CHAT_LIMITS.tags, CHAT_LIMITS.tag);
              const createdAt = storedStamp(info.createdAt);
              const next = normalizeItem({ id, type: 'chat', ...fields, tags, collectionId, ...(createdAt ? { createdAt } : {}),
                chat: { ...incoming, origin: oneOf(entry.origin ?? entry.chat.origin, CHAT_ORIGINS, 'sync'), removed: '', autoCollectionId: collectionId,
                  syncedTags: tags, syncedAt: stamp } }, {}, { syncChat: true });
              next.chat.syncedTitleHash = chatTextHash(next.title);
              next.chat.syncedExcerptHash = chatTextHash(next.excerpt);
              changes.push([null, next]); created.push(id);
              done('created', { fingerprint: next.chat.fingerprint, seq: next.chat.seq });
              continue;
            }
            const old = existing.chat;
            if (incoming.seq && old.seq && incoming.seq < old.seq) { done('skipped', { reason: 'stale', fingerprint: old.fingerprint, seq: old.seq }); continue; }
            const trashed = !!existing.deletedAt, restore = trashed && revive;
            const chat = { ...old, ...incoming, removed: trashed && !restore ? old.removed : '' };
            const change = { chat };
            if (!trashed || restore) {
              const own = { title: chatTextHash(existing.title) === old.syncedTitleHash, excerpt: chatTextHash(existing.excerpt) === old.syncedExcerptHash };
              if (own.title) change.title = fields.title;
              if (own.excerpt) change.excerpt = fields.excerpt;
              change.sourceUrl = fields.sourceUrl; change.siteName = fields.siteName;
              if (target && (restore || target.force || text(existing.collectionId) === text(old.autoCollectionId))) {
                change.collectionId = planner.place(target);
                chat.autoCollectionId = change.collectionId;
              }
              if (restore) change.deletedAt = null;
            }
            const next = normalizeItem(change, existing, { syncChat: true });
            if ('title' in change) next.chat.syncedTitleHash = chatTextHash(next.title);
            if ('excerpt' in change) next.chat.syncedExcerptHash = chatTextHash(next.excerpt);
            const status = trashed && !restore ? ['skipped', { reason: 'trashed' }] : ['updated', {}];
            if (chatView(next) === chatView(existing)) {
              done(status[0] === 'updated' ? 'unchanged' : status[0], { ...status[1], fingerprint: old.fingerprint, seq: old.seq });
              continue;
            }
            next.chat.syncedAt = stamp;
            changes.push([existing, next]);
            done(status[0], { ...status[1], fingerprint: next.chat.fingerprint, seq: next.chat.seq });
          } catch { done('skipped', { reason: 'invalid' }); }
        }
        if (changes.length) commitItems(changes);
        unbury(state, 'item', created);
        result = { results, collections: planner.report() };
        changed = changes.length > 0 || planner.created > 0; break;
      }
      case 'markChatsRemoved': {
        /*
         * A thread left Threadkeeper or may no longer be shared: markChatsRemoved([{ id, reason }], { trash }).
         * local_only: an untouched chat (see isChatTouched) is deleted forever; a touched one keeps the user's notes, tags and
         *   subpages but loses everything that came from the thread (title "Private thread" unless renamed). The caller
         *   deletes the chat's IndexedDB data.
         * deleted / out_of_scope / disconnected: chat.removed is set; with { trash: true } an untouched chat goes to Trash.
         *   A touched chat is always kept.
         * Returns { results: [{ id, status: 'removed' | 'kept' | 'missing' }] }.
         */
        if (!Array.isArray(input)) throw new Error('Send a list of chats.');
        const trash = isObject(patch) && patch.trash === true;
        const byId = new Map(state.items.map(item => [item.id, item]));
        const changes = [], removed = new Set(), results = [], seen = new Set();
        for (const entry of input) {
          const id = isObject(entry) ? text(entry.id) : '';
          const reason = isObject(entry) ? oneOf(entry.reason, CHAT_REMOVED_REASONS) : '';
          const item = byId.get(id);
          if (!item || item.type !== 'chat' || !reason || seen.has(id)) { results.push({ id, status: 'missing' }); continue; }
          seen.add(id);
          const touched = isChatTouched(item, state.items);
          if (reason === 'local_only') {
            if (!touched) { removed.add(id); results.push({ id, status: 'removed' }); continue; }
            const renamed = chatTextHash(item.title) !== item.chat.syncedTitleHash;
            const title = renamed ? item.title : 'Private thread';
            const synced = new Set((item.chat.syncedTags || []).map(tag => tag.toLowerCase()));
            const next = normalizeItem({ title, excerpt: chatTextHash(item.excerpt) === item.chat.syncedExcerptHash ? '' : item.excerpt,
              tags: item.tags.filter(tag => !synced.has(tag.toLowerCase())), sourceUrl: '', siteName: '' }, item);
            next.chat = normalizeChat({ threadKey: item.chat.threadKey, origin: item.chat.origin, removed: 'local_only',
              syncedTitleHash: renamed ? item.chat.syncedTitleHash : chatTextHash(title), autoCollectionId: item.chat.autoCollectionId });
            changes.push([item, next]); results.push({ id, status: 'removed' });
            continue;
          }
          const toTrash = trash && !touched;
          if (item.chat.removed !== reason || (toTrash && !item.deletedAt)) {
            changes.push([item, normalizeItem({ chat: { ...item.chat, removed: reason }, ...(toTrash && !item.deletedAt ? { deletedAt: now() } : {}) }, item, { syncChat: true })]);
          }
          results.push({ id, status: toTrash ? 'removed' : 'kept' });
        }
        if (changes.length) commitItems(changes);
        if (removed.size) removeItems(removed);
        result = { results };
        changed = changes.length > 0 || removed.size > 0; break;
      }
      case 'placeChats': {
        /*
         * Re-places chats after the placement preference changed: placeChats([{ id, collectionId } | { id, collectionKey }],
         * { ensureCollections }). Only live chats still where sync put them move; one the user moved is 'kept'.
         * Returns { results: [{ id, status: 'moved' | 'unchanged' | 'kept' | 'missing', collectionId? }], collections }.
         */
        if (!Array.isArray(input)) throw new Error('Send a list of chats.');
        const planner = collectionPlanner(isObject(patch) ? patch.ensureCollections : []);
        const byId = new Map(state.items.map(item => [item.id, item]));
        const changes = [], results = [], seen = new Set();
        for (const entry of input) {
          const id = isObject(entry) ? text(entry.id) : '';
          const item = byId.get(id), target = planner.target(entry);
          if (!item || item.type !== 'chat' || item.deletedAt || !target || seen.has(id)) { results.push({ id, status: 'missing' }); continue; }
          seen.add(id);
          if (text(item.collectionId) !== text(item.chat.autoCollectionId)) { results.push({ id, status: 'kept' }); continue; }
          const collectionId = planner.place(target);
          if (collectionId === text(item.collectionId)) { results.push({ id, status: 'unchanged', collectionId }); continue; }
          changes.push([item, normalizeItem({ collectionId, chat: { ...item.chat, autoCollectionId: collectionId } }, item, { syncChat: true })]);
          results.push({ id, status: 'moved', collectionId });
        }
        if (changes.length) commitItems(changes);
        result = { results, collections: planner.report() };
        changed = changes.length > 0 || planner.created > 0; break;
      }
      case 'deleteChats': {
        // Deletes chats forever without a tombstone (an assistant import being undone): deleteChats(ids) → { ids }.
        // Their subpages move to the top level. Other item types are ignored.
        const ids = new Set(list(input).filter(id => state.items.some(item => item.id === id && item.type === 'chat')));
        if (!ids.size) { result = { ids: [] }; break; }
        result = { ids: removeItems(ids).ids };
        unbury(state, 'item', result.ids);
        changed = true; break;
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
/** Moves a note into another item ({ parentId, expectedUpdatedAt }) or to the top level (parentId: ''). */
export const movePage = (id, placement = {}) => operation('movePage', [id, placement]);
/** In-queue section write for the research agent: { previous = '', next, field = 'content' } -> { item, replaced }. */
export const upsertContentSection = (id, section = {}) => operation('upsertContentSection', [id, section]);
export const updateSettings = patch => operation('updateSettings', [patch]);
export const importLibrary = (data, options = {}) => operation('importLibrary', [data, options]);
/** Threadkeeper threads into chat items (one write): (entries, { revive, ensureCollections, dismissedIds }) → { results, collections }. */
export const upsertChats = (entries, options = {}) => operation('upsertChats', [entries, options]);
/** Threads that left Threadkeeper: ([{ id, reason }], { trash }) → { results: [{ id, status }] }. */
export const markChatsRemoved = (entries, options = {}) => operation('markChatsRemoved', [entries, options]);
/** Moves chats still where sync put them: ([{ id, collectionId | collectionKey }], { ensureCollections }) → { results, collections }. */
export const placeChats = (entries, options = {}) => operation('placeChats', [entries, options]);
/** Deletes chats forever without a tombstone or dismissal (undoing an import): (ids) → { ids }. */
export const deleteChats = ids => operation('deleteChats', [ids]);
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
    const chat = item.type === 'chat' && isObject(item.chat) ? [item.chat.providerLabel, item.chat.project, ...(item.chat.topics || [])] : [];
    const haystack = [item.title, item.url, item.excerpt, item.content, item.articleContent, ...item.tags, ...item.highlights.map(h => h.text), ...chat].join(' ').toLowerCase();
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
