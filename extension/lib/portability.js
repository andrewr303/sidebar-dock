// Portable files: the full JSON backup, bookmark HTML, CSV, notes and chats as Markdown, and bringing files back in.
//
// Full backup, backupVersion 2 (one JSON file; the download is exactly serializeBackup(backup).text):
//   { backupVersion: 2, schemaVersion, exportedAt,
//     manifest: { app: 'still', extensionVersion, deviceId?, counts: { items, collections, notes, attachments, boards,
//       conversations, aiConnections }, warnings: [text] },
//     items, collections, settings, tombstones?, updatedAt,   the library (store.exportLibrary) without secret settings
//     dashboard?,                                            boards and widgets (dashboard-store portableDashboard)
//     attachments: [{ id, name, mime, data: 'data:<mime>;base64,…', ref?: 'wallpaper' }],
//     conversations?: { version: 2, conversations },         assistant chats (ai/conversations.js exportAll)
//     aiConfig?: { version: 2, settings, connections },      AI setup without keys (ai/connections.js exportAiConfig)
//     chats?: { version: 1, records, transcripts } }         AI chats' summaries and transcripts (lib/chat-data.js), for the
//                                                            library's chat items only; manifest.counts.chats counts those items
// Never in a backup: API keys, account and integration tokens, snapshots, caches. Version 1 files (library, dashboard
// and item files) still restore.
//
// Export never fails because of one bad record: a record that could not be restored is repaired or left out, and the
// manifest says so. Import is the security boundary: the whole file is checked before anything is written, and its
// limits accept everything this version exports. Restore merges (newer copy wins, see store.importLibrary) after a
// 'before-import' snapshot, so it can always be undone from Settings.
import { dashboardBackupSource } from './dashboard-store.js';
import { LIBRARY_SCHEMA_VERSION, libraryVersion } from './storage/migrations.js';
import { createSnapshot } from './storage/snapshots.js';
import { getDeviceId } from './storage/meta.js';
import { pageIndex, parentOf, childrenOf, parsePageBlockLine } from './pages.js';
import { chatItemId } from './threadkeeper/protocol.js';
import { validateChatBackup } from './chat-data.js';

export const BACKUP_VERSION = 2;
export const MAX_BACKUP_BYTES = 200 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
// The store caps almost no text, so any string that fits in a backup file is accepted back.
const MAX_STRING = MAX_BACKUP_BYTES;
// Chrome refuses URLs over 2 MB, so no saved page has a longer one.
const MAX_URL = 2 * 1024 * 1024;
const MAX_LIST = 100000;
const TYPES = new Set(['bookmark', 'article', 'image', 'video', 'file', 'note', 'chat']);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Settings keys that hold credentials or device wiring (the store uses the same rule for imports).
const SECRET_KEY = /token|secret|password|passphrase|credential|bridge|integration|api[-_]?key|authorization|cookie/i;
const NEWER_BACKUP = 'This backup was made by a newer version of Still. Update Still to restore it; nothing was changed.';
const uid = prefix => `${prefix}_${crypto.randomUUID()}`;
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const byteLength = text => new TextEncoder().encode(text).byteLength;
const reason = error => String(error?.message || error || 'unknown error').replace(/\.?$/, '.');
const validId = (value, label) => { if (typeof value !== 'string' || !/^[\w:.-]{1,200}$/.test(value)) throw new Error(`${label} has an invalid ID.`); return value; };
const escapeHtml = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const manifestVersion = () => { try { return globalThis.chrome?.runtime?.getManifest?.()?.version || ''; } catch { return ''; } };

function guardJson(value, depth = 0) {
  if (depth > 30) throw new Error('The backup is nested too deeply.');
  if (!value || typeof value !== 'object') return;
  for (const [key, next] of Object.entries(value)) {
    if (BAD_KEYS.has(key)) throw new Error('The backup contains an unsafe object key.');
    guardJson(next, depth + 1);
  }
}
// Export side: a JSON-safe copy without prototype keys, functions or undefined (import refuses such data instead).
function plainCopy(value) {
  if (Array.isArray(value)) return value.map(entry => plainCopy(entry) ?? null);
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      const copy = BAD_KEYS.has(key) ? undefined : plainCopy(entry);
      if (copy !== undefined) output[key] = copy;
    }
    return output;
  }
  if (['function', 'symbol', 'bigint', 'undefined'].includes(typeof value)) return undefined;
  return typeof value === 'number' && !Number.isFinite(value) ? null : value;
}
function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(entry => (entry && typeof entry === 'object' ? stripSecrets(entry) : entry));
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEY.test(key) && !BAD_KEYS.has(key))
    .map(([key, entry]) => [key, entry && typeof entry === 'object' ? stripSecrets(entry) : entry]));
}

function webUrl(value, label = 'URL', optional = true) {
  if (!value && optional) return '';
  if (typeof value !== 'string' || value.length > MAX_URL) throw new Error(`${label} must be a valid web URL.`);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be an absolute http or https URL.`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`${label} must use http or https without embedded credentials.`);
  return parsed.href;
}
function mimeType(value, label) {
  if (!value) return 'application/octet-stream';
  if (typeof value !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value)) throw new Error(`${label} has an invalid MIME type.`);
  return value.toLowerCase();
}
function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
function decodeDataUrl(value, expectedMime, label, maximum = MAX_FILE_BYTES) {
  if (typeof value !== 'string') throw new Error(`${label} needs base64 file data.`);
  const match = /^data:([^;,]*);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match || match[2].length % 4 || match[2].length / 4 * 3 > maximum + 2) throw new Error(`${label} has invalid or oversized base64 file data.`);
  const mime = mimeType(match[1], label);
  if (expectedMime && mime !== mimeType(expectedMime, label)) throw new Error(`${label} MIME type does not match its file data.`);
  let binary;
  try { binary = atob(match[2]); } catch { throw new Error(`${label} has invalid base64 file data.`); }
  if (binary.length > maximum || btoa(binary) !== match[2]) throw new Error(`${label} has invalid or oversized base64 file data.`);
  return { mime, bytes: Uint8Array.from(binary, char => char.charCodeAt(0)) };
}
// Covers follow the store's rule (store.js coverUrl): raster data in any letter case, packaged assets or web URLs. Data is
// checked for shape and size without decoding, so a library of large screenshots exports and imports quickly.
function validCover(value) {
  if (!value) return '';
  if (typeof value !== 'string') throw new Error('Item cover must be a string.');
  if (/^data:/i.test(value)) {
    const match = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
    if (!match) throw new Error('Only raster image data is allowed for an item cover.');
    if (match[1].length % 4 || match[1].length / 4 * 3 > MAX_FILE_BYTES + 2) throw new Error('Item cover has invalid or oversized base64 file data.');
    return value;
  }
  if (/^(?:assets|images)\/[\w./ -]+$/i.test(value) && !value.includes('..')) return value;
  return webUrl(value, 'Item cover', false);
}
const boundedString = value => typeof value === 'string' && value.length <= MAX_STRING;
function checkStrings(value, label) {
  if (!Array.isArray(value) || value.length > MAX_LIST || !value.every(boundedString)) throw new Error(`${label} must be an array of strings.`);
}
function safeSettings(settings) { return stripSecrets(settings); }

/* ------------------------------------------------------------------ record checks (shared by import and export) */

// parentId (subpages) and the captured page details (siteName, author, publishedAt, icon, lang) are plain strings here; the
// store's normalizeItem repairs any value it cannot use (an unreadable date or icon becomes '').
const ITEM_STRINGS = ['title', 'url', 'excerpt', 'content', 'articleContent', 'fileName', 'mime', 'sourceUrl', 'art', 'collectionId', 'attachmentId',
  'parentId', 'siteName', 'author', 'publishedAt', 'icon', 'lang'];
const ITEM_FLAGS = ['favorite', 'archived', 'pinned', 'read'];
const ITEM_DATES = ['createdAt', 'updatedAt', 'deletedAt', 'reminderAt', 'reminderNotifiedAt'];
const validDate = value => value === undefined || value === null || value === '' || (typeof value === 'string' && Number.isFinite(Date.parse(value)));

function checkHighlight(highlight) {
  if (!isObject(highlight) || !boundedString(highlight.text) || !highlight.text.trim()) throw new Error('A highlight needs text.');
  if (highlight.id) validId(highlight.id, 'Highlight');
  if (highlight.note !== undefined && !boundedString(highlight.note)) throw new Error('A highlight annotation must be text.');
  if (highlight.url) highlight.url = webUrl(highlight.url, 'Highlight source', false);
}

/*
 * One saved item. Strict (import, no `fix`): any problem throws, so nothing is written. Repair (export, `fix` callback):
 * a field that would stop the file from restoring is dropped or replaced and reported through fix(field); only an item
 * that cannot be restored at all throws. Every field the store's normalizeItem would reject is covered here.
 */
function checkItem(item, fix = null) {
  if (!isObject(item)) throw new Error('Every saved item must be an object.');
  validId(item.id, 'Item');
  if (!TYPES.has(item.type)) throw new Error('The backup contains an unsupported item type.');
  const repair = (field, error, value) => {
    if (!fix) throw error instanceof Error ? error : new Error(error);
    if (value === undefined) delete item[field]; else item[field] = value;
    fix(field);
  };
  const attempt = (field, check, value) => { try { check(); } catch (error) { repair(field, error, value); } };
  for (const field of ITEM_STRINGS) {
    if (has(item, field) && item[field] !== null && !boundedString(item[field])) repair(field, `Item ${field} must be a bounded string.`);
  }
  attempt('url', () => { item.url = webUrl(item.url); }, '');
  attempt('sourceUrl', () => { if (item.sourceUrl) item.sourceUrl = webUrl(item.sourceUrl, 'Item source'); });
  attempt('cover', () => { item.cover = validCover(item.cover); }, '');
  attempt('attachmentId', () => { if (item.attachmentId) validId(item.attachmentId, 'Attachment'); });
  attempt('collectionId', () => { if (item.collectionId) validId(item.collectionId, 'Collection'); }, '');
  attempt('parentId', () => { if (item.parentId) validId(item.parentId, 'Parent page'); }, '');
  if (['bookmark', 'image', 'video'].includes(item.type) && !item.url && !item.attachmentId && !item.cover) throw new Error('A bookmark or media item needs a URL, cover or attachment.');
  checkChat(item);
  for (const field of ITEM_FLAGS) if (has(item, field) && typeof item[field] !== 'boolean') repair(field, `Item ${field} must be a boolean.`);
  if (has(item, 'size') && item.size !== null && !(Number.isFinite(item.size) && item.size >= 0 && item.size <= Number.MAX_SAFE_INTEGER)) repair('size', 'An item has an invalid file size.');
  // A trashed item with a damaged date stays in Trash rather than coming back.
  for (const field of ITEM_DATES) if (!validDate(item[field])) repair(field, `Item ${field} is not a valid date.`, field === 'deletedAt' ? new Date().toISOString() : undefined);
  attempt('mime', () => { if (item.mime) mimeType(item.mime, 'Item'); });
  if (has(item, 'tags') && item.tags !== null) attempt('tags', () => checkStrings(item.tags, 'Item tags'), Array.isArray(item.tags) ? item.tags.filter(boundedString).slice(0, MAX_LIST) : undefined);
  if (has(item, 'relatedIds') && item.relatedIds !== null) {
    const okId = id => { try { validId(id, 'Related item'); return true; } catch { return false; } };
    attempt('relatedIds', () => { checkStrings(item.relatedIds, 'Related IDs'); item.relatedIds.forEach(id => validId(id, 'Related item')); },
      Array.isArray(item.relatedIds) ? item.relatedIds.filter(okId).slice(0, MAX_LIST) : undefined);
  }
  if (has(item, 'highlights') && item.highlights !== null) {
    if (!Array.isArray(item.highlights)) repair('highlights', 'Highlights must be an array.');
    else if (!fix) item.highlights.forEach(checkHighlight);
    else {
      const kept = item.highlights.filter(highlight => { try { checkHighlight(highlight); return true; } catch { return false; } });
      if (kept.length !== item.highlights.length) repair('highlights', '', kept);
    }
  }
}

// A chat (from Threadkeeper) needs its thread: { chat: { threadKey } } with id = chatItemId(threadKey), as the store's
// normalizeItem requires. Nothing else in it can stop a restore (the store coerces every other chat field), so there is
// nothing to repair: a chat without its thread cannot be restored at all.
function checkChat(item) {
  if (item.type !== 'chat') return;
  const threadKey = isObject(item.chat) && typeof item.chat.threadKey === 'string' ? item.chat.threadKey.trim() : '';
  if (!threadKey || threadKey.length > 600 || chatItemId(threadKey) !== item.id) throw new Error('A chat needs its Threadkeeper thread.');
}

function checkCollection(collection) {
  if (!isObject(collection)) throw new Error('Every collection must be an object.');
  validId(collection.id, 'Collection');
  if (!boundedString(collection.name) || !collection.name.trim()) throw new Error('Every collection needs a name.');
  if (collection.parentId) validId(collection.parentId, 'Parent collection');
}

function checkVersions(raw) {
  if (raw.backupVersion !== undefined && !(Number.isInteger(raw.backupVersion) && raw.backupVersion >= 1)) throw new Error('This portable backup version is not supported.');
  const schema = raw.schemaVersion;
  if (schema !== undefined && schema !== null && !(Number.isInteger(Number(schema)) && Number(schema) >= 1)) throw new Error('This backup schema version is not supported.');
  if (raw.backupVersion > BACKUP_VERSION || libraryVersion(raw) > LIBRARY_SCHEMA_VERSION) throw new Error(NEWER_BACKUP);
}

/**
 * Import: checks a whole Still library or backup file and returns a copy ready for the store. `known` holds collection
 * ids that already exist on this device (an imported collection or item may sit inside one).
 */
function validateLibrary(raw, { known = new Set() } = {}) {
  guardJson(raw);
  if (!isObject(raw) || !Array.isArray(raw.items) || !Array.isArray(raw.collections)) throw new Error('Import a Still backup with items and collections arrays.');
  checkVersions(raw);
  const snapshot = structuredClone(raw);
  const collectionIds = new Set();
  for (const collection of snapshot.collections) {
    checkCollection(collection);
    if (collectionIds.has(collection.id)) throw new Error('The backup has duplicate collection IDs.');
    collectionIds.add(collection.id);
  }
  const collectionMap = new Map(snapshot.collections.map(collection => [collection.id, collection]));
  for (const collection of snapshot.collections) {
    const seen = new Set([collection.id]);
    let ancestorId = collection.parentId;
    while (ancestorId && collectionMap.has(ancestorId)) {
      if (seen.has(ancestorId)) throw new Error('The backup contains a collection cycle.');
      seen.add(ancestorId); ancestorId = collectionMap.get(ancestorId).parentId;
    }
    if (ancestorId && !known.has(ancestorId)) throw new Error('A collection refers to a missing parent.');
  }
  const itemIds = new Set();
  for (const item of snapshot.items) {
    checkItem(item);
    if (itemIds.has(item.id)) throw new Error('The backup has duplicate item IDs.');
    itemIds.add(item.id);
  }
  snapshot.schemaVersion = libraryVersion(raw);
  snapshot.settings = safeSettings(snapshot.settings);
  return snapshot;
}

const titleOf = record => (isObject(record) && typeof record.title === 'string' && record.title.trim() ? `“${record.title.trim().slice(0, 80)}”` : '');
/**
 * Export: the library as it can be restored. Damaged records are repaired where a field is at fault and left out
 * otherwise; dangling collection references and parent cycles are lifted to the top level. Each change is reported in
 * `warnings`. Throws only when the library itself cannot be read.
 */
function exportableLibrary(raw, warnings = []) {
  if (!isObject(raw) || !Array.isArray(raw.items) || !Array.isArray(raw.collections)) throw new Error('Your library could not be read for export. Reload Still and try again.');
  const library = plainCopy(raw);
  const collectionIds = new Set();
  let droppedCollections = 0;
  const collections = library.collections.filter(collection => {
    try { guardJson(collection, 2); checkCollection(collection); } catch { droppedCollections++; return false; }
    if (collectionIds.has(collection.id)) { droppedCollections++; return false; }
    collectionIds.add(collection.id);
    return true;
  });
  const byId = new Map(collections.map(collection => [collection.id, collection]));
  for (const collection of collections) {
    if (collection.parentId && !byId.has(collection.parentId)) collection.parentId = '';
    const seen = new Set([collection.id]);
    let parentId = collection.parentId;
    while (parentId) {
      if (parentId === collection.id) { collection.parentId = ''; break; }
      if (seen.has(parentId)) break;
      seen.add(parentId); parentId = byId.get(parentId)?.parentId || '';
    }
  }
  const itemIds = new Set(), dropped = [];
  let repaired = 0;
  const items = library.items.filter(item => {
    let fixed = false;
    try {
      guardJson(item, 2);
      checkItem(item, () => { fixed = true; });
      if (itemIds.has(item.id)) throw new Error('duplicate');
    } catch { dropped.push(item); return false; }
    if (item.collectionId && !byId.has(item.collectionId)) item.collectionId = '';
    itemIds.add(item.id);
    if (fixed) repaired++;
    return true;
  });
  // A subpage whose parent page is not in the file (left out above, or already missing) restores at the top level.
  let lifted = 0;
  for (const item of items) if (item.parentId && (item.parentId === item.id || !itemIds.has(item.parentId))) { item.parentId = ''; lifted++; }
  if (dropped.length) {
    const named = dropped.map(titleOf).filter(Boolean).slice(0, 3);
    warnings.push(`Left out ${plural(dropped.length, 'damaged item')} that could not be restored${named.length ? ` (${named.join(', ')}${dropped.length > named.length ? ', …' : ''})` : ''}.`);
  }
  if (repaired) warnings.push(`Repaired ${plural(repaired, 'item')} with an invalid detail (such as a broken cover image, link or date) so the backup restores cleanly.`);
  if (lifted) warnings.push(`Moved ${plural(lifted, 'subpage')} to the top level because ${lifted === 1 ? 'its parent page is' : 'their parent pages are'} not in the backup.`);
  if (droppedCollections) warnings.push(`Left out ${plural(droppedCollections, 'damaged collection')}; ${droppedCollections === 1 ? 'its' : 'their'} items are in the backup without a collection.`);
  const output = { schemaVersion: libraryVersion(raw) === Infinity ? LIBRARY_SCHEMA_VERSION : libraryVersion(raw), items, collections, settings: safeSettings(library.settings) };
  if (Array.isArray(library.tombstones)) {
    output.tombstones = library.tombstones.filter(t => isObject(t) && ['item', 'collection'].includes(t.kind) && typeof t.id === 'string' && typeof t.deletedAt === 'string')
      .map(({ kind, id, deletedAt }) => ({ kind, id, deletedAt }));
  }
  if (typeof library.updatedAt === 'string') output.updatedAt = library.updatedAt;
  return output;
}

// Dashboard boards and widgets travel with a full backup. Widget config never holds credentials (lib/accounts.js keeps
// them on the device) and the dashboard source strips credential-like keys anyway.
const MAX_BOARDS = 100;
const MAX_WIDGETS = 400;
function validateDashboard(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || !Array.isArray(value.boards)) throw new Error('The backup dashboard must have a boards array.');
  if (value.boards.length > MAX_BOARDS) throw new Error(`The backup has more than ${MAX_BOARDS} dashboards.`);
  for (const board of value.boards) {
    if (!isObject(board) || (board.widgets !== undefined && !Array.isArray(board.widgets))) throw new Error('Every dashboard in the backup needs a widgets array.');
    if (board.id !== undefined) validId(board.id, 'Dashboard');
    if ((board.widgets || []).length > MAX_WIDGETS) throw new Error(`A dashboard in the backup has more than ${MAX_WIDGETS} widgets.`);
    for (const widget of board.widgets || []) {
      if (!isObject(widget) || typeof widget.type !== 'string' || !/^[a-z0-9-]{1,60}$/.test(widget.type)) throw new Error('A dashboard widget in the backup has an invalid type.');
      if (widget.id !== undefined) validId(widget.id, 'Widget');
      if (widget.config !== undefined && !isObject(widget.config)) throw new Error('A dashboard widget in the backup has invalid settings.');
    }
  }
  return value;
}
// Chats and AI settings are checked in depth by their own stores (conversations.js importAll, connections.js
// importAiConfig); here only their outer shape, after guardJson has checked keys and depth for the whole file.
function validateConversations(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || !Array.isArray(value.conversations)) throw new Error('The assistant chats in this backup are not in a form Still can read.');
  return value;
}
function validateAiConfig(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new Error('The AI settings in this backup are not in a form Still can read.');
  return value;
}
// A saved proposal's or research run's undo data is an instruction (delete these items, restore those fields). One from
// a file is never trusted: restored chats show their proposals and research history without live session state or undo.
const IMPORT_STOPPED_STATUSES = new Set(['starting', 'running', 'waiting']);
function importableResearch(research) {
  if (!isObject(research)) return research;
  const copy = Object.fromEntries(Object.entries(research).filter(([key]) =>
    !['undo', 'allowOriginalEdits', 'settings', 'sessionId', 'connectionId', 'ownerId', 'heartbeatAt', 'stopRequestedAt', 'budgetStopped'].includes(key)));
  if (IMPORT_STOPPED_STATUSES.has(copy.status)) { copy.status = 'stopped'; delete copy.reason; }
  if (Array.isArray(copy.pages)) copy.pages = copy.pages.map(page => (isObject(page) ? { ...page, imported: true } : page));
  return copy;
}
function importableConversations(value) {
  const withoutUndo = message => {
    if (!isObject(message)) return message;
    let next = message;
    if (Array.isArray(message.proposals)) {
      next = { ...next, proposals: message.proposals.map(proposal => (isObject(proposal) ? Object.fromEntries(Object.entries(proposal).filter(([key]) => key !== 'undo')) : proposal)) };
    }
    if (isObject(message.research)) {
      const { sessionId: _s, live: _l, preview: _p, ...rest } = message.research;
      next = { ...next, research: { ...rest, live: false } };
    }
    return next;
  };
  return { ...value, conversations: value.conversations.map(conversation => {
    if (!isObject(conversation)) return conversation;
    const next = { ...conversation };
    if (Array.isArray(conversation.messages)) next.messages = conversation.messages.map(withoutUndo);
    if ('research' in conversation) next.research = importableResearch(conversation.research);
    return next;
  }) };
}

// Where backups read and write the other stores. Each can be replaced (or turned off with null) through options; the AI
// modules load only when a backup or restore needs them.
const SOURCES = {
  dashboard: async () => dashboardBackupSource(),
  conversations: async () => (await import('./ai/conversations.js')).createConversationStore(),
  aiConfig: async () => import('./ai/connections.js'),
  snapshot: async () => createSnapshot,
  chatData: async () => {
    const chats = await import('./chat-data.js');
    // In the extension only the service worker writes the chat store (inside its Threadkeeper apply mutex); the page
    // sends the restored part there. The preview build has no worker and writes its own.
    const client = await import('./threadkeeper/client.js');
    return { list: chats.listChatRecords, getTranscript: chats.getChatTranscript,
      importBackup: client.canUseWorker() ? client.importChatBackupInWorker : chats.importChatBackup };
  },
  deviceId: async () => getDeviceId(),
};
const sourceOf = (options, key) => (has(options, key) ? options[key] : SOURCES[key]());

/* ------------------------------------------------------------------ full backup */

async function readAttachment(store, id) {
  try {
    const record = await store.getAttachment(id);
    return record?.blob instanceof Blob ? record : null;
  } catch { return null; }
}

/**
 * Full backup (format at the top of this file). options: { dashboard, conversations, aiConfig } sources (null leaves a
 * part out), deviceId, extensionVersion, maxBytes (the size budget, for tests). Problems with single records, files or
 * parts become manifest.warnings; it throws only when the library cannot be read. Download serializeBackup(backup).text.
 */
export async function createFullBackup(store, options = {}) {
  const warnings = [];
  const library = exportableLibrary(await store.exportLibrary(), warnings);
  const parts = {};
  const part = async (key, label, read) => {
    try {
      const source = await sourceOf(options, key);
      const value = source ? await read(source) : null;
      if (value !== null && value !== undefined) parts[key] = value;
    } catch (error) { console.warn(`Still backup (${key}):`, error?.message); warnings.push(`${label} could not be included: ${reason(error)}`); }
  };
  await part('dashboard', 'Your dashboards', async source => {
    if (!source.exportDashboard) return null;
    const value = plainCopy(await source.exportDashboard());
    if (value === null || value === undefined) return null;
    guardJson(value, 1);
    return validateDashboard(value);
  });
  await part('conversations', 'Your assistant chats', async source => {
    if (!source.exportAll) return null;
    const value = plainCopy(await source.exportAll());
    if (!validateConversations(value)) return null;
    let damaged = 0;
    const conversations = value.conversations.filter(conversation => {
      try { guardJson(conversation, 3); if (!isObject(conversation)) throw new Error('not a chat'); return true; } catch { damaged++; return false; }
    });
    if (damaged) warnings.push(`Left out ${plural(damaged, 'damaged assistant chat')}.`);
    return { version: value.version ?? 2, conversations };
  });
  await part('aiConfig', 'Your AI settings', async source => {
    if (!source.exportAiConfig) return null;
    // exportAiConfig carries no keys; stripping secret-like names again keeps that true whatever a later build adds.
    const value = stripSecrets(plainCopy(await source.exportAiConfig()));
    guardJson(value, 1);
    if (value.connections !== undefined && !Array.isArray(value.connections)) throw new Error('The AI connections are unreadable.');
    return value;
  });

  // AI chats: the summary records of the library's chats now; their transcripts after the files (they go first when
  // the backup runs out of room, because Threadkeeper can send them again).
  const limit = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_BACKUP_BYTES;
  const chatIds = new Set(library.items.filter(item => item.type === 'chat').map(item => item.id));
  let chatSource = null;
  if (chatIds.size) {
    await part('chatData', 'Your AI chats\' summaries and transcripts', async source => {
      if (!source?.list) return null;
      chatSource = source;
      const records = [];
      let damaged = 0, budget = Math.floor(limit / 2);
      const rows = plainCopy(await source.list()).filter(record => isObject(record) && chatIds.has(record.id))
        .map(record => ({ record, size: byteLength(JSON.stringify(record, null, 2)) })).sort((a, b) => a.size - b.size);
      let left = 0;
      for (const { record, size } of rows) {
        try { guardJson(record, 3); validateChatBackup({ version: 1, records: [record], transcripts: [] }); } catch { damaged++; continue; }
        if (size > budget) { left++; continue; }
        budget -= size;
        const { transcript, ...rest } = record;
        records.push({ ...rest, transcript: null, ...(transcript ? { transcriptMeta: transcript } : {}) });
      }
      if (damaged) warnings.push(`Left out the saved summaries of ${plural(damaged, 'damaged AI chat')}.`);
      if (left) warnings.push(`Left out the saved summaries of ${plural(left, 'AI chat')} to keep the backup under ${Math.round(limit / 1024 / 1024)} MB; Threadkeeper can send them again.`);
      return { version: 1, records, transcripts: [] };
    });
  }

  const backup = {
    backupVersion: BACKUP_VERSION, schemaVersion: library.schemaVersion, exportedAt: new Date().toISOString(), manifest: null,
    ...library, ...(parts.dashboard ? { dashboard: parts.dashboard } : {}), attachments: [],
    ...(parts.conversations ? { conversations: parts.conversations } : {}), ...(parts.aiConfig ? { aiConfig: parts.aiConfig } : {}),
    ...(parts.chatData ? { chats: parts.chatData } : {}),
  };
  // Transcript sizes come from the records, so choosing them never loads every transcript.
  const transcriptPlan = (parts.chatData?.records || []).filter(record => record.transcriptMeta).map(record => ({ record, meta: record.transcriptMeta }))
    .sort((a, b) => (a.meta.bytes || 0) - (b.meta.bytes || 0));
  for (const record of parts.chatData?.records || []) delete record.transcriptMeta;

  // Files: the wallpaper first, then item files smallest first, while the file stays under the import limit.
  // Only an image wallpaper needs its bytes; other kinds can keep the id of an older upload, which is not exported.
  const wallpaperId = isObject(backup.settings.wallpaper) && backup.settings.wallpaper.kind === 'image' && typeof backup.settings.wallpaper.attachmentId === 'string'
    ? backup.settings.wallpaper.attachmentId : '';
  const entries = [];
  const missing = { items: 0, wallpaper: false }, skipped = { large: 0, budget: 0 };
  if (wallpaperId) {
    const record = await readAttachment(store, wallpaperId);
    if (record) entries.push({ id: wallpaperId, record, ref: 'wallpaper' }); else missing.wallpaper = true;
  }
  const itemFiles = [];
  for (const id of new Set(backup.items.map(item => item.attachmentId).filter(id => id && id !== wallpaperId))) {
    const record = await readAttachment(store, id);
    if (record) itemFiles.push({ id, record }); else missing.items++;
  }
  entries.push(...itemFiles.sort((a, b) => a.record.blob.size - b.record.blob.size));
  // Measured against the readable JSON (the larger form); serializeBackup makes the exact check on the final text.
  let room = entries.length ? limit - byteLength(JSON.stringify(backup, null, 2)) - Math.min(64 * 1024, limit / 8) : 0;
  let corrected = 0;
  for (const { id, record, ref } of entries) {
    if (record.blob.size > MAX_FILE_BYTES) { skipped.large++; continue; }
    let mime;
    try { mime = mimeType(record.mime || record.blob.type, 'Attachment'); } catch { mime = 'application/octet-stream'; }
    const name = typeof record.name === 'string' && record.name && record.name.length <= 1000 && !/[\x00-\x1f/\\]/.test(record.name) && !['.', '..'].includes(record.name) ? record.name : 'attachment';
    const prefix = `data:${mime};base64,`;
    const cost = byteLength(JSON.stringify({ id, name, mime, data: prefix, ...(ref ? { ref } : {}) }, null, 2)) + Math.ceil(record.blob.size / 3) * 4 + 64;
    if (cost > room) { skipped.budget++; if (ref) missing.wallpaper = true; continue; }
    let data;
    try { data = prefix + encodeBase64(new Uint8Array(await record.blob.arrayBuffer())); }
    catch { if (ref) missing.wallpaper = true; else missing.items++; continue; }
    room -= cost;
    backup.attachments.push({ id, name, mime, data, ...(ref ? { ref } : {}) });
    // Import checks each item's size and type against its file; the file is the truth.
    for (const item of backup.items) {
      if (item.attachmentId !== id) continue;
      let fixed = false;
      if (has(item, 'size') && item.size !== null && item.size !== record.blob.size) { item.size = record.blob.size; fixed = true; }
      if (item.mime && item.mime.toLowerCase() !== mime) { item.mime = mime; fixed = true; }
      if (fixed) corrected++;
    }
  }
  if (corrected) warnings.push(`Corrected the file size or type of ${plural(corrected, 'item')} to match ${corrected === 1 ? 'its' : 'their'} file.`);
  if (missing.items) warnings.push(`${plural(missing.items, 'file')} could not be found on this device and ${missing.items === 1 ? 'is' : 'are'} not in the backup; the ${missing.items === 1 ? 'item that uses it is' : 'items that use them are'} included without ${missing.items === 1 ? 'it' : 'them'}.`);
  if (skipped.large) warnings.push(`${plural(skipped.large, 'file')} over 100 MB ${skipped.large === 1 ? 'is' : 'are'} not in the backup. Download ${skipped.large === 1 ? 'it' : 'them'} from your library to keep a copy.`);
  if (skipped.budget) warnings.push(`${plural(skipped.budget, 'file')} did not fit: a backup can hold up to ${Math.round(limit / 1024 / 1024)} MB. Download the largest files from your library to keep a copy.`);
  if (missing.wallpaper && !skipped.budget) warnings.push('Your wallpaper image could not be read, so it is not in the backup.');

  if (backup.chats && transcriptPlan.length) {
    let roomLeft = limit - byteLength(JSON.stringify(backup, null, 2)) - Math.min(64 * 1024, limit / 8);
    let dropped = 0, unreadable = 0;
    for (const { record, meta } of transcriptPlan) {
      // Readable JSON indents each message line deeply; 160 bytes per message covers it.
      const estimate = (meta.bytes || 0) + (meta.stored || 0) * 160 + 512;
      if (estimate > roomLeft) { dropped++; continue; }
      let row;
      try {
        row = plainCopy(await chatSource.getTranscript(record.id));
        if (!isObject(row) || row.revision !== record.revision) { unreadable++; continue; }
        guardJson(row, 3);
        validateChatBackup({ version: 1, records: [record], transcripts: [row] });
      } catch { unreadable++; continue; }
      const cost = byteLength(JSON.stringify(row)) + row.messages.length * 160 + 512;
      if (cost > roomLeft) { dropped++; continue; }
      roomLeft -= cost;
      backup.chats.transcripts.push(row);
      record.transcript = { revision: row.revision, totalMessages: row.totalMessages, stored: row.messages.length, truncated: row.truncated === true };
    }
    if (dropped) warnings.push(`${plural(dropped, 'AI chat transcript')} did not fit in the backup and ${dropped === 1 ? 'is' : 'are'} left out; the chat${dropped === 1 ? '' : 's'} and ${dropped === 1 ? 'its' : 'their'} summar${dropped === 1 ? 'y are' : 'ies are'} included, and Threadkeeper can send ${dropped === 1 ? 'it' : 'them'} again.`);
    if (unreadable) warnings.push(`${plural(unreadable, 'AI chat transcript')} could not be read on this device and ${unreadable === 1 ? 'is' : 'are'} not in the backup.`);
  }

  let deviceId = '';
  try { deviceId = String(await sourceOf(options, 'deviceId') || ''); } catch { deviceId = ''; }
  backup.manifest = {
    app: 'still', extensionVersion: has(options, 'extensionVersion') ? String(options.extensionVersion || '') : manifestVersion(),
    ...(deviceId ? { deviceId } : {}),
    counts: { items: backup.items.length, collections: backup.collections.length, notes: backup.items.filter(item => item.type === 'note').length,
      attachments: backup.attachments.length, boards: backup.dashboard?.boards?.length || 0,
      conversations: backup.conversations?.conversations?.length || 0, aiConnections: backup.aiConfig?.connections?.length || 0,
      chats: backup.items.filter(item => item.type === 'chat').length },
    warnings,
  };
  return backup;
}

/**
 * The exact text to download for a backup and its size in bytes. Readable (indented) JSON when it fits under the import
 * limit, compact JSON when only that fits; throws when neither does, so every downloaded backup can be restored.
 */
export function serializeBackup(backup, { maxBytes = MAX_BACKUP_BYTES } = {}) {
  for (const space of [2, undefined]) {
    const text = JSON.stringify(backup, null, space);
    const bytes = byteLength(text);
    if (bytes <= maxBytes) return { text, bytes };
  }
  throw new Error(`This backup is larger than ${Math.round(maxBytes / 1024 / 1024)} MB, the most Still can restore. Move large files or old chats out of Still, then try again.`);
}

/* ------------------------------------------------------------------ CSV */

export function parseCsv(source) {
  source = source.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false, closedQuote = false;
  const finishField = () => { row.push(field); field = ''; closedQuote = false; };
  const finishRow = () => { finishField(); if (row.some(value => value.trim())) rows.push(row); row = []; };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else field += char;
    } else if (char === '"') {
      if (field || closedQuote) throw new Error('CSV has an unexpected quote.');
      quoted = true;
    } else if (char === ',') finishField();
    else if (char === '\n' || char === '\r') { if (char === '\r' && source[index + 1] === '\n') index++; finishRow(); }
    else if (closedQuote) { if (!/[ \t]/.test(char)) throw new Error('CSV has text after a closing quote.'); }
    else field += char;
  }
  if (quoted) throw new Error('CSV has an unclosed quoted field.');
  if (field || row.length || closedQuote) finishRow();
  return rows;
}

// site, author, published and language are the captured page details (siteName, author, publishedAt, lang). Subpages
// export as flat rows: a CSV has no item ids, so their place in a page does not travel.
export const CSV_COLUMNS = Object.freeze(['url', 'title', 'tags', 'note', 'excerpt', 'type', 'collection', 'created', 'updated', 'site', 'author', 'published', 'language']);
const PATH_SEPARATOR = ' / ';
// Spreadsheet apps run cells that start with = + - @ as formulas, so such cells get a leading apostrophe; import drops it.
const FORMULA_START = /^[=+\-@\t\r]/;
function csvCell(value) {
  let text = String(value ?? '');
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}
const csvValue = value => (/^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value);

// "Parent / Child" paths resolve to collections already in the library (by name, ignoring case) or new ones.
function collectionResolver(local, created) {
  const byPath = new Map();
  for (const collection of local) {
    if (!isObject(collection) || typeof collection.id !== 'string' || typeof collection.name !== 'string' || collection.deletedAt) continue;
    const key = `${collection.parentId || ''}\u0000${collection.name.trim().toLowerCase()}`;
    if (!byPath.has(key)) byPath.set(key, collection.id);
  }
  return path => {
    let parentId = '';
    for (const name of path.split(PATH_SEPARATOR).map(part => part.trim()).filter(Boolean)) {
      const key = `${parentId}\u0000${name.toLowerCase()}`;
      let id = byPath.get(key);
      if (!id) { id = uid('collection'); created.push({ id, name, parentId }); byPath.set(key, id); }
      parentId = id;
    }
    return parentId;
  };
}
// The type column: blank or "link" is a bookmark. Only notes and articles exist without a link; a file row (its bytes
// are not in a CSV), a chat row (chats come only from Threadkeeper; its link is the original conversation) or an unknown
// type with a link comes in as a bookmark.
function csvType(value, url) {
  const name = value.trim().toLowerCase();
  const type = !name || name === 'link' ? 'bookmark' : name;
  if (!url) return type === 'note' || type === 'article' ? type : '';
  return TYPES.has(type) && type !== 'file' && type !== 'chat' ? type : 'bookmark';
}
function csvLibrary(source, localCollections = []) {
  const rows = parseCsv(source);
  const headers = (rows.shift() || []).map(value => value.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error('CSV has duplicate column names.');
  const at = key => headers.indexOf(key);
  if (at('url') < 0) throw new Error(`CSV needs a URL column. Optional columns: ${CSV_COLUMNS.slice(1).join(', ')}.`);
  const collections = [];
  const resolve = collectionResolver(localCollections, collections);
  let skipped = 0;
  const items = rows.map((row, index) => {
    if (row.length !== headers.length) throw new Error(`CSV row ${index + 2} has an unexpected number of columns.`);
    const cell = key => (at(key) < 0 ? '' : csvValue(row[at(key)]));
    const url = cell('url').trim();
    const type = csvType(cell('type'), url);
    if (!type) { skipped++; return null; }
    const item = { id: uid('item'), type, url: url ? webUrl(url, `CSV row ${index + 2}`, false) : '', title: cell('title') || url,
      tags: cell('tags').split(/[,;]/).map(tag => tag.trim()).filter(Boolean), content: cell('note'), excerpt: cell('excerpt') };
    const collectionId = resolve(cell('collection'));
    if (collectionId) item.collectionId = collectionId;
    for (const [column, field] of [['site', 'siteName'], ['author', 'author'], ['language', 'lang']]) if (cell(column).trim()) item[field] = cell(column).trim();
    for (const [column, field] of [['created', 'createdAt'], ['updated', 'updatedAt'], ['published', 'publishedAt']]) {
      const time = Date.parse(cell(column).trim());
      if (Number.isFinite(time)) item[field] = new Date(time).toISOString();
    }
    return item;
  }).filter(Boolean);
  return { library: { schemaVersion: 1, items, collections, settings: {} },
    warnings: skipped ? [`Skipped ${plural(skipped, 'row')} without a link (only notes and articles can come in without one).`] : [] };
}

/**
 * Every item that is not in Trash as CSV with the columns in CSV_COLUMNS (collection is a "Parent / Child" path). The
 * file comes back in through importPortableFile.
 */
export function exportItemsCsv(library) {
  const snapshot = exportableLibrary(library, []);
  const byId = new Map(snapshot.collections.map(collection => [collection.id, collection]));
  const path = id => {
    const names = [], seen = new Set();
    while (id && byId.has(id) && !seen.has(id)) { seen.add(id); names.unshift(byId.get(id).name.trim()); id = byId.get(id).parentId; }
    return names.join(PATH_SEPARATOR);
  };
  // A chat has no url of its own; its row carries the original conversation's link (it comes back in as a bookmark).
  const rows = snapshot.items.filter(item => !item.deletedAt).map(item => [(item.type === 'chat' ? item.sourceUrl : item.url) || '', item.title || '', (item.tags || []).join(', '), item.content || '',
    item.excerpt || '', item.type, path(item.collectionId), item.createdAt || '', item.updatedAt || '',
    item.siteName || '', item.author || '', item.publishedAt || '', item.lang || '']);
  return `﻿${[CSV_COLUMNS, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/* ------------------------------------------------------------------ bookmark HTML */

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeHtml(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? match;
    const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isInteger(number) && number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '�';
  });
}
const stripHtml = value => decodeHtml(value.replace(/<[^>]*>/g, '')).trim();
function attributes(source) {
  const values = {};
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    const name = match[1].toLowerCase();
    if (!BAD_KEYS.has(name)) values[name] = decodeHtml(match[2] ?? match[3] ?? match[4]);
  }
  return values;
}
function htmlLibrary(source) {
  const clean = source.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const items = [], collections = [], parents = [];
  let pendingCollection = '', lastItem, skipped = 0;
  const currentParent = () => parents.at(-1) || '';
  for (const match of clean.matchAll(/<h3\b([^>]*)>([\s\S]*?)<\/h3\s*>|<(\/?)dl\b[^>]*>|<a\b([^>]*)>([\s\S]*?)<\/a\s*>|<dd\b[^>]*>([\s\S]*?)(?=<(?:dt|dd|dl|\/dl)\b|$)/gi)) {
    if (match[1] !== undefined) {
      const collection = { id: uid('collection'), name: stripHtml(match[2]) || 'Imported collection', parentId: currentParent() };
      collections.push(collection); pendingCollection = collection.id; lastItem = null;
    } else if (/^<\/?dl\b/i.test(match[0])) {
      if (match[3]) parents.pop(); else { parents.push(pendingCollection || currentParent()); pendingCollection = ''; }
      lastItem = null;
    } else if (match[4] !== undefined) {
      const attrs = attributes(match[4]);
      let url;
      try { url = webUrl(attrs.href, 'HTML bookmark', false); } catch { skipped++; lastItem = null; continue; }
      lastItem = { id: uid('item'), type: 'bookmark', url, title: stripHtml(match[5]) || url, tags: (attrs.tags || '').split(',').map(tag => tag.trim()).filter(Boolean), collectionId: currentParent() };
      const added = Number(attrs.add_date);
      if (attrs.add_date && Number.isFinite(added) && added > 0 && added < 8640000000000) lastItem.createdAt = new Date(added * 1000).toISOString();
      items.push(lastItem);
    } else if (lastItem && match[6] !== undefined) lastItem.content = stripHtml(match[6]);
  }
  if (!items.length && !collections.length) throw new Error('No supported web bookmarks were found in this HTML file.');
  return { library: { schemaVersion: 1, items, collections, settings: {} }, warnings: skipped ? [`Skipped ${skipped} bookmark${skipped === 1 ? '' : 's'} with unsupported or invalid URLs.`] : [] };
}

/* ------------------------------------------------------------------ import */

// By extension first; a file without a known extension (renamed, or saved by another app) is recognised by its content.
function formatOf(name, source) {
  if (/\.json$/i.test(name)) return 'json';
  if (/\.html?$/i.test(name)) return 'html';
  if (/\.csv$/i.test(name)) return 'csv';
  const start = source.replace(/^﻿/, '').trimStart();
  if (start.startsWith('{')) return 'json';
  if (/^<(?:!doctype\s+(?:netscape-bookmark|html)|html|dl|meta|title)\b/i.test(start)) return 'html';
  if (/^[^\r\n]*\burl\b/i.test(start)) return 'csv';
  return '';
}

async function sameFile(store, ids, file) {
  for (const id of new Set(ids.filter(Boolean))) {
    const record = await readAttachment(store, id);
    if (!record || record.blob.size !== file.size) continue;
    try {
      const [mine, theirs] = await Promise.all([record.blob.arrayBuffer(), file.arrayBuffer()]).then(buffers => buffers.map(buffer => new Uint8Array(buffer)));
      if (mine.every((byte, index) => byte === theirs[index])) return id;
    } catch { /* unreadable here: a new copy is saved */ }
  }
  return '';
}

// A part restored after the library failed on its own; its store's message says why (for example a newer version).
const sectionWarning = (error, what) => `Your library was restored, but not ${what}. ${reason(error)}`;

/**
 * Imports a Still JSON backup (version 1 or 2), bookmark HTML or CSV file. The whole file is checked first; then a
 * 'before-import' snapshot is taken (options.snapshot, null to skip), files are saved, and the library is merged
 * (store.importLibrary: the newer copy of each record wins; a JSON backup's settings and wallpaper are restored too).
 * Dashboards, assistant chats and AI connections in a backup follow; a failure there becomes a warning.
 * options: { dashboard, conversations, aiConfig, snapshot } sources (null turns one off).
 * Returns { items, files, warnings, notes, library?: store importSummary, settings?, boards?, conversations?: { added,
 * updated, skipped }, aiConnections?, snapshotId? }.
 */
export async function importPortableFile(file, store, options = {}) {
  if (!file || typeof file.text !== 'function') throw new Error('Choose a backup, bookmark HTML or CSV file.');
  if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_BACKUP_BYTES) throw new Error('This import exceeds the 200 MB limit.');
  const source = await file.text();
  const format = formatOf(file.name || '', source);
  if (!format) throw new Error('Choose a Still JSON backup, bookmark HTML, or CSV file.');
  // The current library: collections a CSV row or imported item may already sit in, and files already on this device.
  let local = null;
  try { local = await store.exportLibrary?.(); } catch { local = null; }
  const localCollections = Array.isArray(local?.collections) ? local.collections : [];
  const localItems = new Map((Array.isArray(local?.items) ? local.items : []).filter(item => isObject(item) && typeof item.id === 'string').map(item => [item.id, item]));
  let raw, warnings = [];
  if (format === 'json') {
    try { raw = JSON.parse(source.replace(/^﻿/, '')); } catch { throw new Error('The selected file is not valid JSON.'); }
  } else if (format === 'html') ({ library: raw, warnings } = htmlLibrary(source));
  else ({ library: raw, warnings } = csvLibrary(source, localCollections));
  const snapshot = validateLibrary(raw, { known: new Set(localCollections.map(collection => collection?.id).filter(id => typeof id === 'string')) });
  const backupDashboard = validateDashboard(snapshot.dashboard);
  const backupChats = validateConversations(snapshot.conversations);
  const backupAi = validateAiConfig(snapshot.aiConfig);
  const backupChatData = validateChatBackup(snapshot.chats, { chatIds: snapshot.items.filter(item => item.type === 'chat').map(item => item.id) });
  const wallpaper = isObject(snapshot.settings.wallpaper) ? snapshot.settings.wallpaper : null;
  const wallpaperId = typeof wallpaper?.attachmentId === 'string' ? wallpaper.attachmentId : '';
  const records = snapshot.attachments ?? [];
  if (!Array.isArray(records)) throw new Error('The backup attachments must be an array.');
  const attachmentIds = new Set();
  let totalBytes = 0;
  const validated = records.map((record, index) => {
    const label = `Attachment ${index + 1}`;
    if (!isObject(record)) throw new Error(`${label} must be an object.`);
    validId(record.id, label);
    if (attachmentIds.has(record.id)) throw new Error('The backup has duplicate attachment IDs.');
    attachmentIds.add(record.id);
    if (record.ref !== undefined && record.ref !== 'wallpaper') throw new Error(`${label} has an unknown role.`);
    if (record.ref === 'wallpaper' && record.id !== wallpaperId) throw new Error('The backup wallpaper does not match its settings.');
    if (typeof record.name !== 'string' || !record.name || record.name.length > 1000 || /[\x00-\x1f/\\]/.test(record.name) || ['.', '..'].includes(record.name)) throw new Error(`${label} has an invalid filename.`);
    const decoded = decodeDataUrl(record.data, record.mime, label);
    if (record.id === wallpaperId && !decoded.mime.startsWith('image/')) throw new Error('The backup wallpaper must be an image.');
    totalBytes += decoded.bytes.length;
    if (totalBytes > MAX_BACKUP_BYTES) throw new Error('The decoded attachments exceed the 200 MB limit.');
    return { oldId: record.id, file: new File([decoded.bytes], record.name, { type: decoded.mime }) };
  });
  const referencedIds = new Set(snapshot.items.map(item => item.attachmentId).filter(Boolean));
  if (validated.some(record => !referencedIds.has(record.oldId) && record.oldId !== wallpaperId)) throw new Error('The backup contains an attachment with no saved item.');
  for (const item of snapshot.items) {
    const record = validated.find(record => record.oldId === item.attachmentId);
    if (record && has(item, 'size') && item.size !== null && item.size !== record.file.size) throw new Error(`File size does not match the saved item ${item.title || item.id}.`);
    if (record && item.mime && mimeType(item.mime, 'Item') !== record.file.type) throw new Error(`File MIME type does not match the saved item ${item.title || item.id}.`);
  }

  // Everything is checked. Keep a way back before the first write.
  let snapshotId = '';
  const takeSnapshot = await sourceOf(options, 'snapshot');
  if (typeof takeSnapshot === 'function') {
    try { snapshotId = (await takeSnapshot('before-import'))?.id || ''; }
    catch (error) { throw new Error(`Still could not save a snapshot of your data before bringing this file in, so nothing was changed. ${reason(error)}`); }
  }

  const written = [], mapped = new Map(), relink = new Map();
  let imported;
  try {
    for (const record of validated) {
      // The same bytes already on this device (this item's own file, or the current wallpaper) are reused, so restoring
      // a backup twice never stores a second copy.
      const own = snapshot.items.filter(item => item.attachmentId === record.oldId).map(item => localItems.get(item.id)?.attachmentId);
      if (record.oldId === wallpaperId) own.push(local?.settings?.wallpaper?.attachmentId);
      const reused = await sameFile(store, own.filter(id => typeof id === 'string'), record.file);
      if (reused) { mapped.set(record.oldId, { attachmentId: reused, fileName: record.file.name, mime: record.file.type, size: record.file.size }); continue; }
      const metadata = await store.saveAttachment(record.file);
      written.push(metadata.attachmentId); mapped.set(record.oldId, metadata);
    }
    let missing = 0;
    const missingMap = new Map();
    for (const item of snapshot.items) {
      if (!item.attachmentId) continue;
      if (mapped.has(item.attachmentId)) {
        // This device has the item but lost its file: if the merge keeps the local record (it is newer here), the item is
        // re-linked to these bytes afterwards instead of the file's only copy being thrown away.
        const dangling = localItems.get(item.id)?.attachmentId;
        if (typeof dangling === 'string' && dangling && dangling !== mapped.get(item.attachmentId).attachmentId
          && (dangling.startsWith('missing_') || !(await readAttachment(store, dangling)))) relink.set(item.id, { dangling, metadata: mapped.get(item.attachmentId) });
        Object.assign(item, mapped.get(item.attachmentId));
        continue;
      }
      // No bytes in the file: keep this device's own file for the same item, never another item's file with that id.
      const own = localItems.get(item.id)?.attachmentId;
      if (own) { item.attachmentId = own; continue; }
      if (!missingMap.has(item.attachmentId)) { missingMap.set(item.attachmentId, uid('missing')); missing++; }
      item.attachmentId = missingMap.get(item.attachmentId);
    }
    if (missing) warnings.push(`${missing} file${missing === 1 ? '' : 's'} imported as metadata only: this backup has no original bytes for ${missing === 1 ? 'it' : 'them'}. Restore a complete backup to recover ${missing === 1 ? 'that file' : 'those files'}.`);
    if (wallpaperId) {
      if (mapped.has(wallpaperId)) snapshot.settings.wallpaper = { ...wallpaper, attachmentId: mapped.get(wallpaperId).attachmentId };
      // A URL, preset or colour wallpaper can still carry the id of an image uploaded earlier: it restores as is, with
      // this device's own uploaded image kept for that id. Only an image wallpaper needs the bytes.
      else if (wallpaper?.kind !== 'image') snapshot.settings.wallpaper = { ...wallpaper, attachmentId: typeof local?.settings?.wallpaper?.attachmentId === 'string' ? local.settings.wallpaper.attachmentId : '' };
      else { delete snapshot.settings.wallpaper; warnings.push('This file has no copy of its wallpaper image, so your current wallpaper is unchanged.'); }
    }
    imported = await store.importLibrary({ schemaVersion: snapshot.schemaVersion, items: snapshot.items, collections: snapshot.collections, settings: snapshot.settings },
      { settings: format === 'json' });
  } catch (error) {
    const cleanup = await Promise.allSettled(written.map(id => store.deleteAttachment(id)));
    const failed = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failed.length) throw new AggregateError([error, ...failed], `${error.message} Import failed; ${failed.length} newly written file record${failed.length === 1 ? '' : 's'} could not be cleaned up.`);
    throw error;
  }

  // Records the merge did not take (this device's copy is newer, or it was deleted here) leave their new files unused.
  const summary = isObject(imported?.importSummary) ? imported.importSummary : null;
  const skippedIds = new Set(Array.isArray(summary?.skippedItemIds) ? summary.skippedItemIds : []);
  const taken = snapshot.items.filter(item => !skippedIds.has(item.id));
  const inUse = new Set(taken.map(item => item.attachmentId).filter(Boolean));
  if ((summary ? summary.settings : format === 'json') && snapshot.settings.wallpaper?.attachmentId) inUse.add(snapshot.settings.wallpaper.attachmentId);
  // Kept local records whose own file is gone take this file's bytes, when they still point at the lost file.
  const repairs = [...relink].filter(([id]) => skippedIds.has(id));
  if (repairs.length) {
    try {
      const latest = await store.exportLibrary();
      const now = new Map((Array.isArray(latest?.items) ? latest.items : []).map(item => [item.id, item]));
      const patches = repairs.filter(([id, { dangling }]) => now.get(id)?.attachmentId === dangling)
        .map(([id, { metadata }]) => ({ id, patch: { attachmentId: metadata.attachmentId, fileName: metadata.fileName, mime: metadata.mime, size: metadata.size } }));
      if (patches.length) {
        await store.bulkUpdateItems(patches);
        for (const { patch } of patches) inUse.add(patch.attachmentId);
        warnings.push(`${plural(patches.length, 'file')} missing on this device ${patches.length === 1 ? 'was' : 'were'} restored from this backup.`);
      }
    } catch (error) { console.error(error); warnings.push(`Some files missing on this device could not be restored from this backup: ${reason(error)}`); }
  }
  await Promise.allSettled(written.filter(id => !inUse.has(id)).map(id => store.deleteAttachment(id)));
  const linked = new Set([...mapped.values()].map(metadata => metadata.attachmentId).filter(id => inUse.has(id)));

  const result = { items: summary ? summary.items.added + summary.items.updated : snapshot.items.length, files: linked.size, warnings, notes: [] };
  if (summary) { result.library = summary; result.settings = summary.settings === true; }
  if (snapshotId) result.snapshotId = snapshotId;
  const restore = async (key, value, what, run) => {
    if (!value) return;
    try { const target = await sourceOf(options, key); if (target) await run(target); }
    catch (error) { console.error(error); warnings.push(sectionWarning(error, what)); }
  };
  await restore('dashboard', backupDashboard, 'the dashboards in this file; your current dashboard is unchanged', async target => {
    if (!target.importDashboard) return;
    const outcome = await target.importDashboard(backupDashboard);
    result.boards = outcome?.boards ?? backupDashboard.boards.length;
    const kept = Number(outcome?.kept) || 0;
    if (kept) result.notes.push(`${plural(kept, 'dashboard')} already here ${kept === 1 ? 'was' : 'were'} kept as ${kept === 1 ? 'it is' : 'they are'}: this device's copy is newer than the backup. To go back to an earlier layout, restore a snapshot.`);
  });
  await restore('conversations', backupChats, 'the assistant chats in this file', async target => {
    if (!target.importAll) return;
    result.conversations = await target.importAll(importableConversations(backupChats));
    const full = Number(result.conversations?.full) || 0;
    if (full) warnings.push(`${plural(full, 'assistant chat')} ${full === 1 ? 'was' : 'were'} not restored: this device already keeps the most chats it can. Delete some chats, then restore this file again.`);
  });
  // AI chat summaries and transcripts, for the chats the merge took (a chat kept from this device keeps its own data).
  await restore('chatData', backupChatData, 'the AI chat summaries and transcripts in this file', async target => {
    if (!target.importBackup) return;
    result.chats = await target.importBackup(backupChatData, { ids: taken.filter(item => item.type === 'chat').map(item => item.id) });
  });
  await restore('aiConfig', backupAi, 'the AI connections in this file', async target => {
    if (!target.importAiConfig) return;
    const outcome = await target.importAiConfig(backupAi);
    result.aiConnections = Number(outcome?.connectionsAdded) || 0;
    if (result.aiConnections) result.notes.push(`${plural(result.aiConnections, 'AI connection')} came back turned off and without ${result.aiConnections === 1 ? 'its' : 'their'} API key. Check ${result.aiConnections === 1 ? 'it' : 'each one'} in AI models, add the key and turn ${result.aiConnections === 1 ? 'it' : 'them'} on.`);
  });
  return result;
}

/* ------------------------------------------------------------------ bookmark HTML and Markdown exports */

export function exportBookmarkHtml(library) {
  const snapshot = exportableLibrary(library);
  const entries = snapshot.items.filter(item => !item.deletedAt && item.url && item.type !== 'chat');
  const renderItems = collectionId => entries.filter(item => (item.collectionId || '') === collectionId).map(item => `    <DT><A HREF="${escapeHtml(item.url)}"${item.createdAt ? ` ADD_DATE="${Math.floor(Date.parse(item.createdAt) / 1000)}"` : ''} TAGS="${escapeHtml((item.tags || []).join(','))}">${escapeHtml(item.title || item.url)}</A>${item.content ? `\n    <DD>${escapeHtml(item.content)}` : ''}`).join('\n');
  const renderCollection = parentId => snapshot.collections.filter(collection => (collection.parentId || '') === parentId).map(collection => `    <DT><H3>${escapeHtml(collection.name)}</H3>\n    <DL><p>\n${renderItems(collection.id)}\n${renderCollection(collection.id)}\n    </DL><p>`).join('\n');
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Still bookmarks</TITLE>\n<H1>Still bookmarks</H1>\n<DL><p>\n${renderItems('')}\n${renderCollection('')}\n</DL><p>\n`;
}
// Heading anchors as GitHub, VS Code and most Markdown viewers make them: lower case, punctuation removed, spaces to
// hyphens, and -1, -2... for repeats.
function anchorSlugger() {
  const used = new Map();
  return text => {
    const base = text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    let slug = base;
    while (used.has(slug)) { used.set(base, used.get(base) + 1); slug = `${base}-${used.get(base)}`; }
    used.set(slug, 0);
    return slug;
  };
}
const linkText = value => String(value).replace(/[\r\n]+/g, ' ').replace(/[[\]\\]/g, '\\$&');
// Feed lines in order: true while inside a fenced code block (the fence lines included), where nothing is rewritten.
function fenceTracker() {
  let fence = '';
  return line => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) { fence = fence ? '' : marker; return true; }
    return !!fence;
  };
}

/**
 * Notes as one Markdown file: every live note, and every other item with a note or highlights, as a "## Title" section.
 * Subpages follow their parent page (depth first, oldest first) under a "Subpage of" line, and page blocks
 * ([[id|Title]]{page}) become links to the subpage's section (or its title when it is not in the file).
 */
export function exportNotesMarkdown(library) {
  const snapshot = exportableLibrary(library);
  const active = snapshot.items.filter(item => !item.deletedAt);
  const byId = new Map(active.map(item => [item.id, item]));
  const pages = pageIndex(active);
  const ordered = [], seen = new Set();
  const visit = root => {
    const stack = [root];
    while (stack.length) {
      const item = stack.pop();
      if (seen.has(item.id)) continue;
      seen.add(item.id); ordered.push(item);
      stack.push(...childrenOf(pages, item.id).reverse());
    }
  };
  for (const item of active) if (!parentOf(pages, item)) visit(item);
  for (const item of active) visit(item); // pages caught in a loop of parents
  const titleOf = item => (item.title || 'Untitled note').replace(/[\r\n]/g, ' ');
  // Lines are text, or markers resolved once every heading anchor is known: { heading }, { parent }, { page, label }.
  const lines = ['# Still notes', ''];
  const sections = ordered.filter(item => item.type === 'note' || item.content || item.highlights?.length);
  sections.forEach((item, position) => {
    if (position) lines.push('', '---', '');
    lines.push({ heading: item.id, text: `## ${titleOf(item)}` });
    const parent = parentOf(pages, item);
    if (parent) lines.push('', { parent: parent.id });
    if (item.url) lines.push('', `Source: <${item.url}>`);
    // A chat's section holds the user's own notes on it, under where the conversation came from.
    if (item.type === 'chat') {
      const chat = isObject(item.chat) ? item.chat : {};
      const about = [chat.providerLabel || item.siteName || 'AI', chat.project && `project ${chat.project}`, Number(chat.messageCount) > 0 && plural(Number(chat.messageCount), 'message')].filter(Boolean).map(oneLine);
      lines.push('', `_AI chat · ${about.join(' · ').replace(/[_*]/g, '\\$&')}_`);
      if (isWebUrl(item.sourceUrl)) lines.push('', `Original conversation: <${item.sourceUrl}>`);
    }
    const byline = item.type === 'chat' ? [] : [item.siteName, item.author && `by ${item.author}`, day(item.publishedAt) && `published ${day(item.publishedAt)}`].filter(Boolean).map(oneLine);
    if (byline.length) lines.push('', `_${byline.join(' · ').replace(/[_*]/g, '\\$&')}_`);
    const body = String(item.content || '').replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
    if (body) {
      lines.push('');
      const fenced = fenceTracker();
      for (const line of body.split('\n')) { const page = !fenced(line) && parsePageBlockLine(line); lines.push(page ? { page: page.id, label: page.label } : line); }
    }
    const highlights = (item.highlights || []).map(highlight => `> ${highlight.text.replace(/\n/g, '\n> ')}${highlight.note ? `\n\n${highlight.note}` : ''}`).join('\n\n');
    if (highlights) lines.push('', '### Highlights', '', ...highlights.split('\n'));
    const related = (item.relatedIds || []).map(id => byId.get(id)).filter(Boolean).map(related => related.url ? `- ${related.title || related.url}: <${related.url}>` : `- ${related.title || related.id} (${related.id})`).join('\n');
    if (related) lines.push('', '### Connected items', '', ...related.split('\n'));
  });
  // Anchors follow every heading in the file, in order, outside code fences (as viewers count them).
  const slug = anchorSlugger(), anchors = new Map(), fenced = fenceTracker();
  for (const line of lines) {
    if (typeof line !== 'string') { if (line.heading) anchors.set(line.heading, slug(line.text.replace(/^#+\s*/, ''))); continue; }
    const heading = !fenced(line) && /^\s{0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading) slug(heading[1]);
  }
  const link = (id, fallback) => {
    const item = byId.get(id), label = linkText(item ? titleOf(item) : fallback || 'Untitled page');
    if (anchors.has(id)) return `[${label}](#${anchors.get(id)})`;
    return item?.url ? `[${label}](<${item.url}>)` : label;
  };
  const text = lines.map(line => (typeof line === 'string' ? line : line.heading ? line.text : line.parent ? `Subpage of ${link(line.parent)}` : `- ${link(line.page, line.label)}`));
  return `${text.join('\n')}\n`;
}

// Assistant answers cite saved items as [[id]] markers; outside Still a marker becomes the source's title or link.
const CITATION = /\[\[([\w:.-]+)\]\]/g;
const oneLine = value => String(value ?? '').replace(/[[\]|]+/g, ' ').replace(/\s+/g, ' ').trim();
const isWebUrl = url => /^https?:\/\/[^/\s]/i.test(String(url || ''));
const day = value => { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : ''; };
function answerMarkdown(message) {
  const sources = new Map((Array.isArray(message.citations) ? message.citations : []).filter(isObject).map(source => [String(source.id), source]));
  return String(message.text || '').replace(CITATION, (match, id) => {
    const source = sources.get(id);
    if (!source) return '';
    const title = oneLine(source.title) || oneLine(source.url) || 'Source';
    // Parentheses and spaces would end a Markdown link early.
    const href = String(source.url).replace(/[()\s]/g, char => ({ '(': '%28', ')': '%29' }[char] || encodeURIComponent(char)));
    return isWebUrl(source.url) ? `[${title}](${href})` : title;
  }).replace(/[ \t]+([.,;:!?])/g, '$1').trim();
}

/** Every assistant conversation (conversations.js exportAll output) as one Markdown document, newest first. */
export function exportConversationsMarkdown(data) {
  const sections = (Array.isArray(data?.conversations) ? data.conversations : []).filter(isObject).map(conversation => {
    const parts = [`## ${oneLine(conversation.title) || 'Assistant chat'}`];
    const started = day(conversation.createdAt), updated = day(conversation.updatedAt);
    if (started) parts.push(`_Started ${started}${updated && updated !== started ? `, last message ${updated}` : ''}_`);
    for (const message of Array.isArray(conversation.messages) ? conversation.messages : []) {
      if (message?.role === 'user') {
        const lines = String(message.text || '').trim().split('\n');
        parts.push([`> **You:** ${lines[0]}`, ...lines.slice(1).map(line => (line.trim() ? `> ${line}` : '>'))].join('\n'));
      } else if (message?.role === 'assistant') {
        const answer = answerMarkdown(message);
        if (answer) parts.push(answer);
        else if (message.error && message.error !== 'Stopped') parts.push(`_The answer did not finish: ${oneLine(message.error)}_`);
      }
    }
    return parts.join('\n\n');
  });
  return `# Still assistant chats\n\n${sections.length ? sections.join('\n\n---\n\n') : '_No assistant chats yet._'}\n`;
}

/** All assistant chats as one Markdown file: { markdown, count }. options.conversations replaces the chat store. */
export async function exportChatsMarkdown(options = {}) {
  const chats = await sourceOf(options, 'conversations');
  if (!chats?.exportAll) throw new Error('Assistant chats are not available here.');
  const data = await chats.exportAll();
  return { markdown: exportConversationsMarkdown(data), count: Array.isArray(data?.conversations) ? data.conversations.length : 0 };
}
