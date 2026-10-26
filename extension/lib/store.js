export const STORAGE_KEY = 'still.library.v1';
export const ITEM_TYPES = ['bookmark', 'article', 'image', 'video', 'file', 'note'];
const STORE_MESSAGE = 'still:store';
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const nextStamp = previous => new Date(Math.max(Date.now(), (Date.parse(previous) || 0) + 1)).toISOString();
const uid = prefix => `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
const list = value => [...new Set((Array.isArray(value) ? value : []).filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean))];
const text = value => typeof value === 'string' ? value : '';

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

function normalizeHighlight(value) {
  if (!value || typeof value !== 'object' || !text(value.text).trim()) return null;
  return { id: text(value.id) || uid('highlight'), text: value.text, note: text(value.note), color: text(value.color) || 'amber',
    createdAt: text(value.createdAt) || now(), url: safeUrl(value.url) };
}

export function normalizeItem(input, existing = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Item must be an object.');
  const merged = { ...existing, ...input };
  const type = merged.type || 'bookmark';
  if (!ITEM_TYPES.includes(type)) throw new Error('Unknown item type.');
  const url = safeUrl(merged.url);
  if (['bookmark', 'image', 'video'].includes(type) && !url && !merged.attachmentId && !merged.cover) {
    throw new Error('This item needs a URL or attached file.');
  }
  const createdAt = text(existing.createdAt) || text(input.createdAt) || now();
  const item = {
    id: text(existing.id) || text(input.id) || uid('item'), type,
    title: text(merged.title).trim() || (url ? new URL(url).hostname : type === 'note' ? 'Untitled note' : 'Untitled item'),
    url, excerpt: text(merged.excerpt), content: text(merged.content), articleContent: text(merged.articleContent).slice(0, 250000), tags: list(merged.tags),
    collectionId: text(merged.collectionId), favorite: merged.favorite === true,
    archived: merged.archived === true, deletedAt: merged.deletedAt ? text(merged.deletedAt) : null,
    createdAt, updatedAt: nextStamp(existing.updatedAt), cover: coverUrl(merged.cover),
    art: ['quiet', 'note', 'glass', 'type', 'landscape', 'welcome', 'web', 'palette', 'mcp'].includes(merged.art) ? merged.art : '',
    sourceUrl: safeUrl(merged.sourceUrl),
    highlights: (Array.isArray(merged.highlights) ? merged.highlights : []).map(normalizeHighlight).filter(Boolean),
    relatedIds: list(merged.relatedIds), reminderAt: merged.reminderAt ? new Date(merged.reminderAt).toISOString() : null,
    reminderNotifiedAt: Object.hasOwn(input, 'reminderAt') && input.reminderAt !== existing.reminderAt
      ? null : merged.reminderNotifiedAt ? text(merged.reminderNotifiedAt) : null,
    attachmentId: text(merged.attachmentId), fileName: text(merged.fileName), mime: text(merged.mime),
    size: Number.isFinite(merged.size) && merged.size >= 0 ? merged.size : 0,
    pinned: merged.pinned === true, read: merged.read === true,
  };
  return item;
}

function normalizeCollection(input, existing = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Collection must be an object.');
  const merged = { ...existing, ...input };
  if (!text(merged.name).trim()) throw new Error('Give the collection a name.');
  return { id: text(existing.id) || text(input.id) || uid('collection'), name: merged.name.trim(),
    color: /^#[\da-f]{3,8}$/i.test(text(merged.color)) ? merged.color : '#a99eea', icon: text(merged.icon) || 'folder', parentId: text(merged.parentId),
    description: text(merged.description).slice(0, 12000), cover: coverUrl(merged.cover), pinned: merged.pinned === true,
    layout: ['grid', 'list', 'masonry'].includes(merged.layout) ? merged.layout : 'grid',
    sidebarLayout: ['grid', 'list', 'masonry'].includes(merged.sidebarLayout) ? merged.sidebarLayout : 'list',
    createdAt: text(existing.createdAt) || text(merged.createdAt) || now(), updatedAt: nextStamp(existing.updatedAt) };
}

export function emptyLibrary() {
  return { schemaVersion: 1, items: [], collections: [], settings: {}, updatedAt: now() };
}

function validateLibrary(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.items) || !Array.isArray(value.collections)) {
    throw new Error('Import a Still library JSON file with items and collections arrays.');
  }
  if (value.schemaVersion && value.schemaVersion !== 1) throw new Error('This library version is not supported.');
  const collections = value.collections.map(c => normalizeCollection(c));
  const ids = new Set(collections.map(c => c.id));
  if (ids.size !== collections.length) throw new Error('Duplicate collection IDs in library.');
  const items = value.items.map(i => normalizeItem(i));
  if (new Set(items.map(i => i.id)).size !== items.length) throw new Error('Duplicate item IDs in library.');
  for (const item of items) if (item.collectionId && !ids.has(item.collectionId)) item.collectionId = '';
  for (const collection of collections) {
    if (!ids.has(collection.parentId) || collection.parentId === collection.id) collection.parentId = '';
    const seen = new Set([collection.id]);
    let parentId = collection.parentId;
    while (parentId) {
      if (seen.has(parentId)) throw new Error('Imported collections cannot contain a parent cycle.');
      seen.add(parentId); parentId = collections.find(c => c.id === parentId)?.parentId || '';
    }
  }
  return { schemaVersion: 1, items, collections,
    settings: value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings) ? clone(value.settings) : {}, updatedAt: now() };
}

// A single service-worker queue owns extension writes; preview tabs use Web Locks.
export function createLibraryStore({ read, write, withLock = task => task() }) {
  let queue = Promise.resolve();
  const listeners = new Set();
  const notify = state => { for (const listener of listeners) listener(clone(state)); };
  async function current() { const state = await read(); return state ? clone(state) : null; }
  const dispatch = (operation, args = []) => {
    const task = async () => withLock(async () => {
      let state = await current();
      if (!state) state = args[0] && operation === 'loadLibrary' ? validateLibrary(args[0]) : emptyLibrary();
      let result;
      let changed = operation === 'loadLibrary' && !(await current());
      const [input, patch, options = {}] = args;
      const assertRevision = (record, opts) => { if (typeof opts?.expectedUpdatedAt === 'string' && opts.expectedUpdatedAt !== record.updatedAt) throw new Error('Conflict: this item changed in another view. Reopen it before applying your edits.'); };
      const findItem = id => { const item = state.items.find(i => i.id === id); if (!item) throw new Error('Item no longer exists.'); return item; };
      const findCollection = id => { const collection = state.collections.find(c => c.id === id); if (!collection) throw new Error('Collection no longer exists.'); return collection; };
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
          for (const item of state.items) item.relatedIds = item.relatedIds.filter(id => id !== input);
          result = { id: input }; changed = true; break;
        }
        case 'createCollection': {
          result = normalizeCollection(input);
          if (state.collections.some(c => c.id === result.id)) throw new Error('Collection ID already exists.');
          if (result.parentId) findCollection(result.parentId);
          state.collections.push(result); changed = true; break;
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
          for (const item of state.items) if (item.collectionId === input) { item.collectionId = ''; item.updatedAt = now(); }
          for (const collection of state.collections) if (collection.parentId === input) collection.parentId = existing.parentId;
          state.collections = state.collections.filter(c => c.id !== input);
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
          const imported = validateLibrary(input);
          const byId = new Map(state.items.map(i => [i.id, i]));
          for (const item of imported.items) byId.set(item.id, item);
          const collections = new Map(state.collections.map(c => [c.id, c]));
          for (const collection of imported.collections) collections.set(collection.id, collection);
          state.items = [...byId.values()]; state.collections = [...collections.values()];
          // Keep device integration credentials/settings local when importing backups.
          result = state; changed = true; break;
        }
        default: throw new Error('Unknown library operation.');
      }
      if (changed) { state.updatedAt = nextStamp(state.updatedAt); await write(clone(state)); notify(state); }
      return clone(result);
    });
    const next = queue.then(task, task); queue = next.catch(() => {}); return next;
  };
  return { dispatch, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}

let workerMode = false;
let memoryState = null;
const hasExtensionStorage = () => !!globalThis.chrome?.storage?.local;
const localStore = createLibraryStore({
  read: async () => {
    if (hasExtensionStorage()) return (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || null;
    if (globalThis.localStorage) {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { throw new Error('Saved library is unreadable. Restore a backup before continuing.'); }
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

export function configureStoreWorker() { workerMode = true; }
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
export const updateSettings = patch => operation('updateSettings', [patch]);
export const importLibrary = data => operation('importLibrary', [data]);
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
    request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { attachmentDb = null; reject(request.error); };
  });
  return attachmentDb;
}
async function attachmentTransaction(mode, action) {
  const db = await openAttachmentDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('files', mode);
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
