const MAX_BACKUP_BYTES = 200 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const TYPES = new Set(['bookmark', 'article', 'image', 'video', 'file', 'note']);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const uid = prefix => `${prefix}_${crypto.randomUUID()}`;
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const validId = (value, label) => { if (typeof value !== 'string' || !/^[\w:.-]{1,200}$/.test(value)) throw new Error(`${label} has an invalid ID.`); return value; };
const escapeHtml = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function guardJson(value, depth = 0) {
  if (depth > 30) throw new Error('The backup is nested too deeply.');
  if (!value || typeof value !== 'object') return;
  for (const [key, next] of Object.entries(value)) {
    if (BAD_KEYS.has(key)) throw new Error('The backup contains an unsafe object key.');
    guardJson(next, depth + 1);
  }
}
function webUrl(value, label = 'URL', optional = true) {
  if (!value && optional) return '';
  if (typeof value !== 'string' || value.length > 8192) throw new Error(`${label} must be a valid web URL.`);
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
function validCover(value) {
  if (!value) return '';
  if (typeof value !== 'string') throw new Error('Item cover must be a string.');
  if (value.startsWith('data:')) {
    if (!/^data:image\/(png|jpeg|gif|webp|avif);base64,/.test(value)) throw new Error('Only raster image data is allowed for an item cover.');
    decodeDataUrl(value, null, 'Item cover', 5 * 1024 * 1024);
    return value;
  }
  if (/^(?:assets|images)\/[\w./ -]+$/.test(value) && !value.includes('..')) return value;
  return webUrl(value, 'Item cover', false);
}
function checkString(object, field, max = 1000000) {
  if (has(object, field) && (typeof object[field] !== 'string' || object[field].length > max)) throw new Error(`Item ${field} must be a bounded string.`);
}
function checkStrings(value, label) {
  if (!Array.isArray(value) || value.length > 10000 || value.some(entry => typeof entry !== 'string' || entry.length > 1000)) throw new Error(`${label} must be an array of strings.`);
}
function safeSettings(settings) {
  if (Array.isArray(settings)) return settings.map(value => value && typeof value === 'object' ? safeSettings(value) : value);
  if (!isObject(settings)) return {};
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !/token|secret|password|credential|bridge|integration/i.test(key)).map(([key, value]) => [key, value && typeof value === 'object' ? safeSettings(value) : value]));
}

function validateLibrary(raw) {
  guardJson(raw);
  if (!isObject(raw) || !Array.isArray(raw.items) || !Array.isArray(raw.collections)) throw new Error('Import a Still backup with items and collections arrays.');
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) throw new Error('This backup schema version is not supported.');
  if (raw.backupVersion !== undefined && raw.backupVersion !== 1) throw new Error('This portable backup version is not supported.');
  const snapshot = structuredClone(raw);
  const collectionIds = new Set();
  for (const collection of snapshot.collections) {
    if (!isObject(collection)) throw new Error('Every collection must be an object.');
    validId(collection.id, 'Collection');
    if (collectionIds.has(collection.id)) throw new Error('The backup has duplicate collection IDs.');
    collectionIds.add(collection.id);
    if (typeof collection.name !== 'string' || !collection.name.trim() || collection.name.length > 1000) throw new Error('Every collection needs a name.');
    if (collection.parentId) validId(collection.parentId, 'Parent collection');
  }
  const collectionMap = new Map(snapshot.collections.map(collection => [collection.id, collection]));
  for (const collection of snapshot.collections) {
    const seen = new Set([collection.id]);
    let ancestorId = collection.parentId;
    while (ancestorId) {
      if (!collectionIds.has(ancestorId)) throw new Error('A collection refers to a missing parent.');
      if (seen.has(ancestorId)) throw new Error('The backup contains a collection cycle.');
      seen.add(ancestorId); ancestorId = collectionMap.get(ancestorId).parentId;
    }
  }
  const itemIds = new Set();
  for (const item of snapshot.items) {
    if (!isObject(item)) throw new Error('Every saved item must be an object.');
    validId(item.id, 'Item');
    if (itemIds.has(item.id)) throw new Error('The backup has duplicate item IDs.');
    itemIds.add(item.id);
    if (!TYPES.has(item.type)) throw new Error('The backup contains an unsupported item type.');
    for (const field of ['title', 'url', 'excerpt', 'content', 'fileName', 'mime']) checkString(item, field);
    item.url = webUrl(item.url);
    item.cover = validCover(item.cover);
    if (item.attachmentId) validId(item.attachmentId, 'Attachment');
    if (['bookmark', 'image', 'video'].includes(item.type) && !item.url && !item.attachmentId && !item.cover) throw new Error('A bookmark or media item needs a URL, cover or attachment.');
    if (item.collectionId && !collectionIds.has(item.collectionId)) throw new Error('An item refers to a missing collection.');
    for (const field of ['favorite', 'archived', 'pinned', 'read']) if (has(item, field) && typeof item[field] !== 'boolean') throw new Error(`Item ${field} must be a boolean.`);
    if (has(item, 'size') && (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE_BYTES)) throw new Error('An item has an invalid file size.');
    for (const field of ['createdAt', 'updatedAt', 'deletedAt', 'reminderAt', 'reminderNotifiedAt']) {
      if (item[field] !== undefined && item[field] !== null && item[field] !== '' && (typeof item[field] !== 'string' || !Number.isFinite(Date.parse(item[field])))) throw new Error(`Item ${field} is not a valid date.`);
    }
    if (item.mime) mimeType(item.mime, 'Item');
    if (item.tags !== undefined) checkStrings(item.tags, 'Item tags');
    if (item.relatedIds !== undefined) { checkStrings(item.relatedIds, 'Related IDs'); item.relatedIds.forEach(id => validId(id, 'Related item')); }
    if (item.highlights !== undefined) {
      if (!Array.isArray(item.highlights)) throw new Error('Highlights must be an array.');
      for (const highlight of item.highlights) {
        if (!isObject(highlight) || typeof highlight.text !== 'string' || !highlight.text.trim()) throw new Error('A highlight needs text.');
        if (highlight.id) validId(highlight.id, 'Highlight');
        if (highlight.note !== undefined && typeof highlight.note !== 'string') throw new Error('A highlight annotation must be text.');
        if (highlight.url) webUrl(highlight.url, 'Highlight source', false);
      }
    }
  }
  snapshot.schemaVersion = 1;
  snapshot.settings = safeSettings(snapshot.settings);
  return snapshot;
}

export async function createFullBackup(store) {
  const snapshot = validateLibrary(await store.exportLibrary());
  snapshot.backupVersion = 1;
  snapshot.exportedAt = new Date().toISOString();
  snapshot.attachments = [];
  for (const id of new Set(snapshot.items.map(item => item.attachmentId).filter(Boolean))) {
    const record = await store.getAttachment(id);
    if (!record?.blob || !(record.blob instanceof Blob)) throw new Error(`The original file for attachment ${id} is missing. Restore its original backup before creating a complete backup.`);
    if (record.blob.size > MAX_FILE_BYTES) throw new Error('A file exceeds the 100 MB portable backup limit.');
    const mime = mimeType(record.mime || record.blob.type, 'Attachment');
    const name = typeof record.name === 'string' && record.name ? record.name : 'attachment';
    snapshot.attachments.push({ id, name, mime, data: `data:${mime};base64,${encodeBase64(new Uint8Array(await record.blob.arrayBuffer()))}` });
  }
  if (new Blob([JSON.stringify(snapshot)]).size > MAX_BACKUP_BYTES) throw new Error('This complete backup exceeds 200 MB. Export a smaller library.');
  return snapshot;
}

export function parseCsv(source) {
  source = source.replace(/^\uFEFF/, '');
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
function csvLibrary(source) {
  const rows = parseCsv(source);
  const headers = (rows.shift() || []).map(value => value.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error('CSV has duplicate column names.');
  const at = key => headers.indexOf(key);
  if (at('url') < 0) throw new Error('CSV needs a URL column. Optional columns: title, tags, note, excerpt.');
  const items = rows.map((row, index) => {
    if (row.length !== headers.length) throw new Error(`CSV row ${index + 2} has an unexpected number of columns.`);
    const url = row[at('url')].trim();
    if (!url) return null;
    return { id: uid('item'), type: 'bookmark', url: webUrl(url, `CSV row ${index + 2}`, false), title: row[at('title')] || url,
      tags: (row[at('tags')] || '').split(/[,;]/).map(tag => tag.trim()).filter(Boolean), content: row[at('note')] || '', excerpt: row[at('excerpt')] || '' };
  }).filter(Boolean);
  return { schemaVersion: 1, items, collections: [], settings: {} };
}
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeHtml(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? match;
    const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isInteger(number) && number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '\uFFFD';
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

export async function importPortableFile(file, store) {
  if (!file || typeof file.text !== 'function') throw new Error('Choose a backup, bookmark HTML or CSV file.');
  if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_BACKUP_BYTES) throw new Error('This import exceeds the 200 MB limit.');
  const source = await file.text();
  let raw, warnings = [];
  if (/\.json$/i.test(file.name || '')) {
    try { raw = JSON.parse(source.replace(/^\uFEFF/, '')); } catch { throw new Error('The selected file is not valid JSON.'); }
  } else if (/\.html?$/i.test(file.name || '')) { const parsed = htmlLibrary(source); raw = parsed.library; warnings = parsed.warnings; }
  else if (/\.csv$/i.test(file.name || '')) raw = csvLibrary(source);
  else throw new Error('Choose a Still JSON backup, bookmark HTML, or CSV file.');
  const snapshot = validateLibrary(raw);
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
    if (typeof record.name !== 'string' || !record.name || record.name.length > 1000 || /[\x00-\x1f/\\]/.test(record.name) || ['.', '..'].includes(record.name)) throw new Error(`${label} has an invalid filename.`);
    const decoded = decodeDataUrl(record.data, record.mime, label);
    totalBytes += decoded.bytes.length;
    if (totalBytes > MAX_BACKUP_BYTES) throw new Error('The decoded attachments exceed the 200 MB limit.');
    return { oldId: record.id, file: new File([decoded.bytes], record.name, { type: decoded.mime }) };
  });
  const referencedIds = new Set(snapshot.items.map(item => item.attachmentId).filter(Boolean));
  if (validated.some(record => !referencedIds.has(record.oldId))) throw new Error('The backup contains an attachment with no saved item.');
  for (const item of snapshot.items) {
    const record = validated.find(record => record.oldId === item.attachmentId);
    if (record && has(item, 'size') && item.size !== record.file.size) throw new Error(`File size does not match the saved item ${item.title || item.id}.`);
    if (record && item.mime && mimeType(item.mime, 'Item') !== record.file.type) throw new Error(`File MIME type does not match the saved item ${item.title || item.id}.`);
  }
  const missingIds = [...referencedIds].filter(id => !attachmentIds.has(id));
  const missingMap = new Map(missingIds.map(id => [id, uid('missing')]));
  if (missingIds.length) warnings.push(`${missingIds.length} file${missingIds.length === 1 ? '' : 's'} imported as metadata only: this older backup has no original bytes for them. Restore a complete backup to recover those files.`);
  const written = [];
  try {
    const mapped = new Map();
    for (const record of validated) { const metadata = await store.saveAttachment(record.file); written.push(metadata.attachmentId); mapped.set(record.oldId, metadata); }
    for (const item of snapshot.items) {
      if (mapped.has(item.attachmentId)) Object.assign(item, mapped.get(item.attachmentId));
      else if (missingMap.has(item.attachmentId)) item.attachmentId = missingMap.get(item.attachmentId);
    }
    delete snapshot.attachments;
    await store.importLibrary(snapshot);
  } catch (error) {
    const cleanup = await Promise.allSettled(written.map(id => store.deleteAttachment(id)));
    const failed = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failed.length) throw new AggregateError([error, ...failed], `${error.message} Import failed; ${failed.length} newly written file record${failed.length === 1 ? '' : 's'} could not be cleaned up.`);
    throw error;
  }
  return { items: snapshot.items.length, files: written.length, warnings };
}

export function exportBookmarkHtml(library) {
  const snapshot = validateLibrary(library);
  const entries = snapshot.items.filter(item => !item.deletedAt && item.url);
  const renderItems = collectionId => entries.filter(item => (item.collectionId || '') === collectionId).map(item => `    <DT><A HREF="${escapeHtml(item.url)}"${item.createdAt ? ` ADD_DATE="${Math.floor(Date.parse(item.createdAt) / 1000)}"` : ''} TAGS="${escapeHtml((item.tags || []).join(','))}">${escapeHtml(item.title || item.url)}</A>${item.content ? `\n    <DD>${escapeHtml(item.content)}` : ''}`).join('\n');
  const renderCollection = parentId => snapshot.collections.filter(collection => (collection.parentId || '') === parentId).map(collection => `    <DT><H3>${escapeHtml(collection.name)}</H3>\n    <DL><p>\n${renderItems(collection.id)}\n${renderCollection(collection.id)}\n    </DL><p>`).join('\n');
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Still bookmarks</TITLE>\n<H1>Still bookmarks</H1>\n<DL><p>\n${renderItems('')}\n${renderCollection('')}\n</DL><p>\n`;
}
export function exportNotesMarkdown(library) {
  const snapshot = validateLibrary(library);
  const active = snapshot.items.filter(item => !item.deletedAt);
  const byId = new Map(active.map(item => [item.id, item]));
  const sections = active.filter(item => item.type === 'note' || item.content || item.highlights?.length).map(item => {
    const title = (item.title || 'Untitled note').replace(/[\r\n]/g, ' ');
    const source = item.url ? `\nSource: <${item.url}>\n` : '';
    const highlights = (item.highlights || []).map(highlight => `> ${highlight.text.replace(/\n/g, '\n> ')}${highlight.note ? `\n\n${highlight.note}` : ''}`).join('\n\n');
    const related = (item.relatedIds || []).map(id => byId.get(id)).filter(Boolean).map(related => related.url ? `- ${related.title || related.url}: <${related.url}>` : `- ${related.title || related.id} (${related.id})`).join('\n');
    return `## ${title}\n${source}\n${item.content || ''}${highlights ? `\n\n### Highlights\n\n${highlights}` : ''}${related ? `\n\n### Connected items\n\n${related}` : ''}`.trim();
  });
  return `# Still notes\n\n${sections.join('\n\n---\n\n')}\n`;
}
