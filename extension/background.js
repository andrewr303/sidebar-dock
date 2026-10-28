/*
 * Still service worker: the single library writer, capture, context menus, commands, reminders and the
 * saved-page badge.
 *
 * Runtime messages from extension pages: { type, ...fields } (fields may also sit under `payload`).
 * Every reply is { ok: true, result } or { ok: false, error }. Pass windowId from the side panel
 * (chrome.windows.getCurrent()): without it "active tab" means the last focused window.
 *
 *   still:store              { operation, args[] }                  -> store operation result
 *   captureCurrent | saveCurrentTab | still:capture-current
 *                            { tabId?, windowId?, collectionId?, tags?, note?, title? }
 *                            -> saved Item + { created } (+ collectionFallback: true when collectionId no longer
 *                               exists and Inbox was used); { needsPermission: 'tabs', tabId, windowId } when the
 *                               tab URL is unreadable. collectionId: a collection id moves the item there (new or
 *                               already saved); '' = Inbox for a new item and never moves a saved one; omitted = quick
 *                               save (see below). note fills content only when the item is new or its note is empty;
 *                               a re-save never replaces a note, description, cover or real title (an explicit
 *                               title field does replace the title).
 *   saveTabs                 { windowId?, tabIds?, collectionId?, newCollectionName?, tags? }
 *                            -> { saved, created, skipped, moved: [{ id, from }], collectionId, itemIds }
 *                               | { needsPermission: 'tabs' }. Web tabs only, one item per canonical URL. A chosen
 *                               collection (or the new one, created only when at least one tab can be saved) is the
 *                               destination for every tab: a tab that is already saved MOVES there, and `moved` lists
 *                               it with its previous collectionId (from, '' = Inbox) so the UI can undo. Inbox ('')
 *                               never moves a saved item. Moving never touches its note, description, type, stored
 *                               URL or title (only a title that is just the address is replaced by the tab title).
 *   listTabs                 { windowId? } -> [{ tabId, windowId, url, title, favIconUrl, active, saved }] (http/https)
 *                            | { needsPermission: 'tabs' }
 *   getActiveTab             { windowId? } -> { granted: true, tabId, windowId, url, title, favIconUrl, saved, itemId }
 *                            | { granted: false, tabId, windowId } when neither 'tabs' nor an activeTab grant exposes the URL
 *   getPageContext           { tabId?, windowId? } -> { tabId, url, title, excerpt, cover, selection, text (<= 120000 chars),
 *                               truncated, lang } | { needsPermission: '<scheme>://<host>/*' | 'tabs', tabId, windowId }
 *                               (request it with chrome.permissions.request inside a click, then ask again)
 *   captureScreenshot | still:capture-screenshot { tabId?, windowId? } -> image Item (PNG attachment, WebP cover preview)
 *   captureFullPage          { jobId, tabId?, windowId? } -> resolves when the job ends: { id, item, jobId, width, height,
 *                               tileCount }. jobId: 8-80 chars [A-Za-z0-9_-] (a UUID works), unique per job.
 *   cancelFullPageCapture    { jobId } -> { jobId, cancelled, status }
 *   getFullPageCaptureJob    { jobId? } -> latest progress (see broadcast) or null; no jobId = the running job
 *   openLibrary | still:open-library { itemId? } -> the new tab; newNote | still:new-note -> note Item
 *   openSidePanel | still:open-sidepanel { windowId? } -> { opened, windowId }; importBrowserBookmarks -> { imported }
 * Screenshot errors on a tab Chrome has not granted say "Cannot access this tab" (the UI maps it to its toolbar hint).
 *
 * Quick save (captureCurrent without collectionId, the Alt+Shift+S command and the "Save page/link/image to Still" and
 * "Highlight selection" menus): a new item goes to the last-used collection (chrome.storage.local
 * still.ui.recent.v1 { recentCollections }, first id that still exists), else settings.defaultCollectionId, else
 * Inbox, matching the side panel's Save button; an already saved item stays in its collection. A note from a
 * selection (and the new-note command) goes to the collection of its saved source page (Inbox included) first.
 *
 * Broadcasts to extension pages (runtime.sendMessage; nobody listening is fine):
 *   still:full-page-progress { jobId, status: 'preparing'|'capturing'|'stitching'|'saving'|'saved'|'cancelled'|'error',
 *                               completed, total, width?, height?, itemId? (saved), message? (error/cancelled) }
 *   still:active-tab { tab: { tabId, windowId, url, title, favIconUrl, saved, itemId } }   (only with 'tabs')
 *   still:open-add  { payload: { url, title, kind: 'page'|'link'|'image', sourceUrl }, windowId, requestId }
 *   still:open-note { id, windowId, requestId }
 * still:open-add and still:open-note are retried for about 2 s while the side panel loads: the side panel
 * answers with sendResponse({ ok: true }) once handled and ignores a requestId it has already seen.
 */
import {
  configureStoreWorker, handleStoreOperation, loadLibrary, saveItem, updateItem,
  createCollection, subscribe, STORAGE_KEY, canonicalUrl, safeUrl, saveAttachment, deleteAttachment,
} from './lib/store.js';
import {
  buildCapture, readPageMetadata, readPageContext, collectionMenuEntries, parseSaveToMenuId, saveToMenuId,
  resolveCaptureCollection, findSavedItem, indexSavedUrls, isPlaceholderTitle, isVideoUrl, normalizeTags,
  normalizeRecentCollections, PAGE_TEXT_LIMIT, CHOOSE_MENU_ID, SEPARATOR_MENU_ID, INBOX_MENU_ID,
} from './lib/capture.js';
import {
  assertCaptureTab, captureRateLimiter, captureFullPagePixels, checkCaptureCancelled, imagePreviewDataUrl, pngDataUrlBlob,
} from './lib/full-page-capture.js';

configureStoreWorker();

const api = globalThis.chrome;
let visibleScreenshotJobs = 0;
const REMINDER_PREFIX = 'still:reminder:';
const RECENT_COLLECTIONS_KEY = 'still.ui.recent.v1';
const WEB_PAGES = ['http://*/*', 'https://*/*'];
const SAVED_COLOR = '#718a77';
const SAVED_DOT_COLOR = '#6b7280';
const MENU_ITEMS = [
  { id: 'still-save-page', title: 'Save page to Still', contexts: ['page'], documentUrlPatterns: WEB_PAGES },
  { id: 'still-save-link', title: 'Save link to Still', contexts: ['link'], targetUrlPatterns: WEB_PAGES },
  { id: 'still-save-selection', title: 'Highlight selection in Still', contexts: ['selection'], documentUrlPatterns: WEB_PAGES },
  { id: 'still-note-selection', title: 'Create a note from selection', contexts: ['selection'], documentUrlPatterns: WEB_PAGES },
  { id: 'still-save-image', title: 'Save image to Still', contexts: ['image'], targetUrlPatterns: WEB_PAGES },
  { id: 'still-screenshot', title: 'Save a screenshot to Still', contexts: ['action'] },
  { id: 'still-screenshot-full', title: 'Save full-page screenshot to Still', contexts: ['page', 'action'], documentUrlPatterns: WEB_PAGES },
  { id: 'still-open-library', title: 'Open Still in a new tab', contexts: ['action'] },
  { id: 'still-save-page-to', title: 'Save page to', contexts: ['page'], documentUrlPatterns: WEB_PAGES },
  { id: 'still-save-link-to', title: 'Save link to', contexts: ['link'], targetUrlPatterns: WEB_PAGES },
  { id: 'still-save-image-to', title: 'Save image to', contexts: ['image'], targetUrlPatterns: WEB_PAGES },
];
const SAVE_TO_MENUS = { page: 'still-save-page-to', link: 'still-save-link-to', image: 'still-save-image-to' };
const CAPTURE_MESSAGES = ['captureCurrent', 'saveCurrentTab', 'still:capture-current'];
const MESSAGE_TYPES = ['still:store', ...CAPTURE_MESSAGES, 'captureScreenshot', 'still:capture-screenshot', 'captureFullPage',
  'cancelFullPageCapture', 'getFullPageCaptureJob', 'openLibrary', 'still:open-library', 'openSidePanel', 'still:open-sidepanel',
  'newNote', 'still:new-note', 'importBrowserBookmarks', 'saveTabs', 'getActiveTab', 'getPageContext', 'listTabs'];

// Badge and broadcast calls are best effort: a closed view or a missing API never fails the capture.
function attempt(call) {
  try { return Promise.resolve(call()).catch(() => undefined); } catch { return Promise.resolve(undefined); }
}

function later(task, delay) {
  const timer = setTimeout(task, delay);
  timer?.unref?.();
  return timer;
}

const wait = delay => new Promise(resolve => setTimeout(resolve, delay));

function reportError(error) {
  console.error('Still:', error?.message || String(error));
  attempt(() => api.action.setBadgeText({ text: '!' }));
  attempt(() => api.action.setBadgeBackgroundColor({ color: '#bc6666' }));
  scheduleBadgeClear(8000);
}

let libraryCache = null;
// Read without the store: loadLibrary() on an empty store would persist an empty library before the UI seeds it.
async function readLibrary() {
  if (libraryCache) return libraryCache;
  const stored = api?.storage?.local ? (await api.storage.local.get(STORAGE_KEY))[STORAGE_KEY] : await loadLibrary();
  return stored || { items: [], collections: [], settings: {} };
}

async function hasPermission(request) {
  try { return (await api.permissions?.contains?.(request)) === true; } catch { return false; }
}

function messageInput(message) {
  return message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload) ? { ...message, ...message.payload, type: message.type } : message;
}

function captureOptions(input = {}) {
  const options = {};
  if (typeof input.collectionId === 'string') options.collectionId = input.collectionId === INBOX_MENU_ID ? '' : input.collectionId;
  if (input.tags !== undefined) options.tags = input.tags;
  if (typeof input.note === 'string') options.note = input.note;
  if (typeof input.title === 'string') options.title = input.title;
  return options;
}

function contextMenuCall(method, argument) {
  return new Promise(resolve => {
    const done = () => {
      const error = api.runtime?.lastError;
      if (error && !/cannot find|not found/i.test(error.message || '')) console.warn('Still menu:', error.message);
      resolve();
    };
    try {
      const call = api.contextMenus?.[method];
      if (!call) { resolve(); return; }
      const result = call.call(api.contextMenus, argument, done);
      if (result?.then) result.then(() => resolve(), error => { if (!/cannot find|not found/i.test(error?.message || '')) console.warn('Still menu:', error?.message); resolve(); });
      // create() returns its id at once and reports failures through the callback; calls stay ordered.
      else if (method === 'create') resolve();
    } catch (error) {
      if (!/cannot find|not found/i.test(error?.message || '')) console.warn('Still menu:', error?.message);
      resolve();
    }
  });
}

let collectionMenuSignature = '';
let collectionMenuQueue = Promise.resolve();

// Shares the collection-menu queue so a rebuild never interleaves with removeAll().
export function installMenus() {
  const run = async () => {
    collectionMenuSignature = '';
    await api.contextMenus.removeAll();
    for (const item of MENU_ITEMS) await contextMenuCall('create', item);
  };
  const next = collectionMenuQueue.then(run, run);
  collectionMenuQueue = next.catch(() => {});
  return next;
}

async function readRecentCollections() {
  try { return normalizeRecentCollections((await api.storage.local.get(RECENT_COLLECTIONS_KEY))[RECENT_COLLECTIONS_KEY]); } catch { return []; }
}

async function touchRecentCollection(id) {
  if (!id || !api?.storage?.local) return;
  const stored = (await api.storage.local.get(RECENT_COLLECTIONS_KEY))[RECENT_COLLECTIONS_KEY];
  const recentCollections = [id, ...normalizeRecentCollections(stored).filter(value => value !== id)].slice(0, 12);
  // Keep the UI's shape (ui/prefs.js mirrors { recentCollections } here).
  await api.storage.local.set({ [RECENT_COLLECTIONS_KEY]: Array.isArray(stored) ? recentCollections
    : { ...(stored && typeof stored === 'object' ? stored : {}), recentCollections } });
}

// Rebuilds the children of the three "Save … to" parents. Removing a parent drops its children in one
// call; parents are the last top-level items, so recreating them keeps the menu order.
export function installCollectionMenus(library, { recent, force = false } = {}) {
  const run = async () => {
    const entries = collectionMenuEntries(library, recent ?? await readRecentCollections());
    const signature = JSON.stringify(entries);
    if (!force && signature === collectionMenuSignature) return false;
    collectionMenuSignature = signature;
    for (const [kind, parentId] of Object.entries(SAVE_TO_MENUS)) {
      const parent = MENU_ITEMS.find(item => item.id === parentId);
      const scope = { contexts: parent.contexts, documentUrlPatterns: parent.documentUrlPatterns, targetUrlPatterns: parent.targetUrlPatterns };
      for (const key of Object.keys(scope)) if (!scope[key]) delete scope[key];
      await contextMenuCall('remove', parentId);
      await contextMenuCall('create', parent);
      const child = properties => contextMenuCall('create', { ...scope, ...properties, parentId });
      for (const entry of entries) await child({ id: saveToMenuId(kind, entry.id), title: entry.title });
      await child({ id: saveToMenuId(kind, SEPARATOR_MENU_ID), type: 'separator' });
      await child({ id: saveToMenuId(kind, CHOOSE_MENU_ID), title: 'Choose collection…' });
    }
    return true;
  };
  const next = collectionMenuQueue.then(run, run);
  collectionMenuQueue = next.catch(() => { collectionMenuSignature = ''; });
  return next;
}

export function openLibrary(itemId = '') {
  const target = api.runtime.getURL(`index.html${itemId ? `?item=${encodeURIComponent(itemId)}` : ''}`);
  return api.tabs.create({ url: target });
}

// Call synchronously inside the user gesture (context menu click, command): Chrome rejects sidePanel.open
// once the handler has awaited anything. Resolves true when Chrome accepted the request.
function openSidePanel(tab) {
  if (!api.sidePanel?.open) return Promise.resolve(false);
  try {
    if (Number.isInteger(tab?.windowId)) return Promise.resolve(api.sidePanel.open({ windowId: tab.windowId })).then(() => true);
    if (Number.isInteger(tab?.id)) return Promise.resolve(api.sidePanel.open({ tabId: tab.id })).then(() => true);
  } catch (error) { return Promise.reject(error); }
  return Promise.resolve(false);
}

async function deliverToPanel(message, { attempts = 9, interval = 250 } = {}) {
  const request = { ...message, requestId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}` };
  for (let round = 0; round < attempts; round++) {
    if (round) await wait(interval);
    try { if (await api.runtime.sendMessage(request)) return true; } catch { /* The side panel is still loading. */ }
  }
  return false;
}

async function activeTab(windowId) {
  const tabs = await api.tabs.query(Number.isInteger(windowId) ? { active: true, windowId } : { active: true, currentWindow: true });
  if (!tabs[0]) throw new Error('No active browser tab was found.');
  return tabs[0];
}

async function targetTab({ tabId, windowId } = {}) {
  if (Number.isInteger(tabId) && api.tabs.get) return api.tabs.get(tabId);
  return activeTab(windowId);
}

let badgeTimer = null;
const checkedTabs = new Set();

function scheduleBadgeClear(delay) {
  clearTimeout(badgeTimer);
  // Chrome may hold short alarms for 30 s; the timer clears on time while the worker is awake.
  badgeTimer = later(() => { handleAlarm({ name: 'still:clear-badge' }).catch(error => console.warn('Still badge:', error?.message)); }, delay);
  return attempt(() => api.alarms.create('still:clear-badge', { when: Date.now() + delay }));
}

async function showSavedBadge(tabId) {
  await attempt(() => api.action.setBadgeText({ text: '✓' }));
  await attempt(() => api.action.setBadgeBackgroundColor({ color: SAVED_COLOR }));
  if (tabTracking && Number.isInteger(tabId)) {
    checkedTabs.add(tabId);
    await attempt(() => api.action.setBadgeText({ tabId, text: '✓' }));
    await attempt(() => api.action.setBadgeBackgroundColor({ tabId, color: SAVED_COLOR }));
  }
  await scheduleBadgeClear(4000);
}

export async function captureTab(tab, info = {}, options = {}) {
  info ||= {}; options ||= {};
  let metadata = {};
  if (!info.linkUrl && !info.srcUrl && Number.isInteger(tab?.id) && /^https?:\/\//i.test(tab.url || info.pageUrl || '')) {
    try {
      const result = await api.scripting.executeScript({ target: { tabId: tab.id }, func: readPageMetadata });
      metadata = result?.[0]?.result || {};
    } catch (error) {
      // URL/title capture remains possible when a site disallows DOM access.
      metadata = { title: tab.title, url: tab.url };
      console.info('Still saved tab metadata; page content could not be read:', error?.message);
    }
  }
  const draft = buildCapture(info, tab, metadata);
  const library = await readLibrary();
  const existing = draft.type === 'note' ? null : findSavedItem(library, draft.url);
  const source = draft.type === 'note' ? findSavedItem(library, draft.url) : null;
  // Quick save (no collectionId): a new item follows the last-used collection, like the side panel's Save button.
  const recent = typeof options.collectionId !== 'string' && !existing ? await readRecentCollections() : [];
  const target = resolveCaptureCollection(library, options.collectionId, { existing, preferred: source?.collectionId, recent });
  const input = buildCapture(info, tab, metadata, { ...options, collectionId: target.collectionId, existing });
  if (source) input.relatedIds = [source.id];
  const item = await saveItem(input);
  await showSavedBadge(tab?.id);
  const created = !(library.items || []).some(entry => entry?.id === item.id);
  return { ...item, created, ...(target.collectionFallback ? { collectionFallback: true } : {}) };
}

async function captureCurrentTab(input) {
  const tab = await targetTab(input);
  if (!tab.url) return { needsPermission: 'tabs', tabId: tab.id, windowId: tab.windowId };
  return captureTab(tab, {}, captureOptions(input));
}

async function saveTabs(input) {
  if (!(await hasPermission({ permissions: ['tabs'] }))) return { needsPermission: 'tabs' };
  const windowId = Number.isInteger(input.windowId) ? input.windowId : null;
  const wanted = Array.isArray(input.tabIds) ? new Set(input.tabIds.filter(Number.isInteger)) : null;
  const tabs = await api.tabs.query(windowId !== null ? { windowId } : wanted ? {} : { currentWindow: true });
  const library = await readLibrary();
  const index = indexSavedUrls(library);
  const seen = new Set(), pages = [];
  let saved = 0, created = 0, skipped = 0;
  for (const tab of wanted ? tabs.filter(tab => wanted.has(tab.id)) : tabs) {
    let url = '', key = '';
    try { if (/^https?:\/\//i.test(tab.url || '')) { url = safeUrl(tab.url); key = canonicalUrl(url); } } catch { url = ''; }
    if (!url || seen.has(key)) { skipped++; continue; }
    seen.add(key);
    pages.push({ tab, url, existing: index.get(key) || null });
  }
  const name = typeof input.newCollectionName === 'string' ? input.newCollectionName.trim() : '';
  const explicit = Boolean(name) || typeof input.collectionId === 'string';
  // No empty collection when every chosen tab was closed or is not a web page.
  const target = name ? { collectionId: pages.length ? (await createCollection({ name })).id : '' }
    : resolveCaptureCollection(library, typeof input.collectionId === 'string' ? input.collectionId : undefined,
      { recent: explicit ? [] : await readRecentCollections() });
  const tags = normalizeTags(input.tags);
  const itemIds = [], moved = [];
  for (const { tab, url, existing } of pages) {
    // A chosen collection is the destination for every tab, so a saved page moves there; a quick save leaves it.
    // The store keeps the note, description and cover; the stored URL, type and a real title are kept here.
    const entry = { url: existing?.url || url, tags, collectionId: explicit || !existing ? target.collectionId : '' };
    if (!existing) entry.type = isVideoUrl(url) ? 'video' : 'bookmark';
    if (!existing || (tab.title?.trim() && isPlaceholderTitle(existing.title, url))) entry.title = tab.title || '';
    try {
      const item = await saveItem(entry);
      saved++; itemIds.push(item.id);
      if (!existing) created++;
      else if (entry.collectionId && entry.collectionId !== (existing.collectionId || '')) moved.push({ id: item.id, from: existing.collectionId || '' });
    } catch (error) { skipped++; console.info('Still skipped a tab:', error?.message); }
  }
  return { saved, created, skipped, moved, collectionId: target.collectionId, itemIds, ...(target.collectionFallback ? { collectionFallback: true } : {}) };
}

async function listTabs(input) {
  if (!(await hasPermission({ permissions: ['tabs'] }))) return { needsPermission: 'tabs' };
  const tabs = await api.tabs.query(Number.isInteger(input.windowId) ? { windowId: input.windowId } : { currentWindow: true });
  const index = indexSavedUrls(await readLibrary());
  return tabs.filter(tab => /^https?:\/\//i.test(tab.url || '')).map(tab => {
    let saved = false;
    try { saved = index.has(canonicalUrl(tab.url)); } catch { saved = false; }
    return { tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title || '', favIconUrl: tab.favIconUrl || '', active: tab.active === true, saved };
  });
}

async function lookupSaved(url) {
  if (!/^https?:\/\//i.test(url || '')) return null;
  return findSavedItem(await readLibrary(), url);
}

async function getActiveTab(input) {
  const tab = await activeTab(input.windowId);
  if (!tab.url) return { granted: false, tabId: tab.id, windowId: tab.windowId };
  const saved = await lookupSaved(tab.url);
  return { granted: true, tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title || '', favIconUrl: tab.favIconUrl || '',
    saved: Boolean(saved), itemId: saved?.id || '' };
}

async function getPageContext(input) {
  const tab = await targetTab(input);
  if (tab.url && !/^https?:\/\//i.test(tab.url)) throw new Error('Still can read web pages only (http or https).');
  let result;
  try {
    [result] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: readPageContext, args: [PAGE_TEXT_LIMIT] });
  } catch (error) {
    if (!tab.url) return { needsPermission: 'tabs', tabId: tab.id, windowId: tab.windowId };
    const { protocol, hostname } = new URL(tab.url);
    const origin = `${protocol}//${hostname}/*`;
    if (await hasPermission({ origins: [origin] })) throw error;
    return { needsPermission: origin, tabId: tab.id, windowId: tab.windowId };
  }
  const page = result?.result || {};
  let url = '';
  try { url = safeUrl(page.url || tab.url); } catch { url = tab.url || ''; }
  let cover = '';
  try { cover = page.cover ? safeUrl(new URL(page.cover, url).href) : ''; } catch { cover = ''; }
  const text = typeof page.text === 'string' ? page.text.slice(0, PAGE_TEXT_LIMIT) : '';
  return { tabId: tab.id, url, title: page.title || tab.title || '', excerpt: page.excerpt || '', cover,
    selection: page.selection || '', text, truncated: page.truncated === true, lang: page.lang || '' };
}

export async function createPageNote(tab) {
  let url = '';
  try { url = /^https?:\/\//i.test(tab?.url || '') ? safeUrl(tab.url) : ''; } catch { url = ''; }
  if (!url) return saveItem({ type: 'note', title: 'Untitled note', content: '' });
  const library = await readLibrary();
  const source = findSavedItem(library, url);
  const { collectionId } = resolveCaptureCollection(library, undefined, { preferred: source?.collectionId, recent: await readRecentCollections() });
  return saveItem({ type: 'note', title: `Notes on ${tab.title?.trim() || new URL(url).hostname}`, url, content: '',
    relatedIds: source ? [source.id] : [], collectionId });
}

function newPageNote(tab) {
  const opening = Number.isInteger(tab?.windowId) ? openSidePanel(tab).catch(() => false) : Promise.resolve(false);
  return (async () => {
    const page = Number.isInteger(tab?.id) ? tab : await activeTab().catch(() => null);
    const item = await createPageNote(page);
    if (await opening) await deliverToPanel({ type: 'still:open-note', id: item.id, windowId: tab.windowId });
    else await openLibrary(item.id);
    return item;
  })();
}

async function chooseCollection(info, tab, kind) {
  const opening = openSidePanel(tab);
  const url = safeUrl(kind === 'image' ? info.srcUrl : kind === 'link' ? info.linkUrl : info.pageUrl || tab?.url, { optional: false });
  const title = kind === 'page' ? tab?.title || '' : kind === 'link' ? (info.linkText || info.selectionText || '').replace(/\s+/g, ' ').trim() : '';
  // The menu also shows on file and extension pages; their address is not a web source.
  let sourceUrl = '';
  try { sourceUrl = safeUrl(info.pageUrl || tab?.url); } catch { sourceUrl = ''; }
  const payload = { url, title, kind, sourceUrl };
  return opening.then(() => deliverToPanel({ type: 'still:open-add', payload, windowId: tab?.windowId }));
}

// Saved-page dot: only with the optional 'tabs' permission, which lets the worker read every tab URL.
let tabTracking = false;

async function updateTabBadge(tab) {
  if (!Number.isInteger(tab?.id)) return null;
  const saved = tabTracking ? await lookupSaved(tab.url) : null;
  if (!checkedTabs.has(tab.id)) {
    // null falls back to the global badge (for example the error mark).
    await attempt(() => api.action.setBadgeText({ tabId: tab.id, text: saved ? '•' : null }));
    if (saved) await attempt(() => api.action.setBadgeBackgroundColor({ tabId: tab.id, color: SAVED_DOT_COLOR }));
  }
  return saved;
}

// A page load fires several updates (about:blank, URL, title, complete); send the last one per tab.
const pendingBroadcasts = new Map();
async function refreshTab(tab, broadcast) {
  if (!tabTracking || !tab) return;
  const saved = await updateTabBadge(tab);
  if (!broadcast || tab.active === false) return;
  const message = { type: 'still:active-tab', tab: { tabId: tab.id, windowId: tab.windowId, url: tab.url || '',
    title: tab.title || '', favIconUrl: tab.favIconUrl || '', saved: Boolean(saved), itemId: saved?.id || '' } };
  clearTimeout(pendingBroadcasts.get(tab.id));
  pendingBroadcasts.set(tab.id, later(() => {
    pendingBroadcasts.delete(tab.id);
    attempt(() => api.runtime.sendMessage(message));
  }, 120));
}

async function refreshActiveTabs() {
  if (!tabTracking) return;
  for (const tab of await api.tabs.query({ active: true })) await refreshTab(tab, false);
}

// The tab listeners are added synchronously when the worker script starts (see the bottom of this file): an event
// that wakes a stopped worker is dispatched right after that first run, before the async permission check
// resolves, so a listener added only after the check would miss it. Handlers wait for the check, and the
// listeners are removed again when 'tabs' is not granted so tab events do not keep waking the worker.
let tabTrackingReady = Promise.resolve();
let tabListening = false;
const whenTracking = task => { tabTrackingReady.then(() => (tabTracking ? attempt(task) : undefined), () => undefined); };
const onTabActivated = ({ tabId }) => { whenTracking(async () => refreshTab(await api.tabs.get(tabId), true)); };
const onTabUpdated = (tabId, change, tab) => {
  if (!('url' in change || change.status === 'complete' || 'title' in change || 'favIconUrl' in change)) return;
  whenTracking(() => refreshTab(tab || { id: tabId }, tab?.active === true));
};
const onWindowFocusChanged = windowId => {
  if (!Number.isInteger(windowId) || windowId < 0) return;
  whenTracking(async () => refreshTab((await api.tabs.query({ active: true, windowId }))[0], true));
};

function listenToTabs(on) {
  if (tabListening === on) return;
  tabListening = on;
  const method = on ? 'addListener' : 'removeListener';
  api.tabs?.onActivated?.[method]?.(onTabActivated);
  api.tabs?.onUpdated?.[method]?.(onTabUpdated);
  api.windows?.onFocusChanged?.[method]?.(onWindowFocusChanged);
}

function startTabTracking() {
  listenToTabs(true);
  if (tabTracking) return;
  tabTracking = true;
  attempt(refreshActiveTabs);
}

function stopTabTracking() {
  listenToTabs(false);
  if (!tabTracking) return;
  tabTracking = false;
  for (const timer of pendingBroadcasts.values()) clearTimeout(timer);
  pendingBroadcasts.clear();
  checkedTabs.clear();
  attempt(async () => { for (const tab of await api.tabs.query({})) await attempt(() => api.action.setBadgeText({ tabId: tab.id, text: null })); });
}

let libraryRefreshTimer = null;
function scheduleLibraryRefresh() {
  clearTimeout(libraryRefreshTimer);
  libraryRefreshTimer = later(() => {
    readLibrary()
      .then(library => Promise.all([installCollectionMenus(library), refreshActiveTabs()]))
      .catch(error => console.warn('Still could not refresh menus or badges:', error?.message));
  }, 500);
}

// Without 'tabs' or an activeTab grant Chrome hides the tab URL. Say so in words the UI maps to its toolbar hint
// instead of the address validation message.
function screenshotSourceUrl(tab) {
  if (tab && typeof tab === 'object' && !tab.url) throw new Error('Cannot access this tab until you click the Still toolbar button on it (activeTab).');
  return safeUrl(tab?.url, { optional: false });
}

export async function captureScreenshot(tab, { persistAttachment = saveAttachment, removeAttachment = deleteAttachment, persistItem = saveItem,
  limiter = captureRateLimiter, makePreview = imagePreviewDataUrl } = {}) {
  const sourceUrl = screenshotSourceUrl(tab);
  if (activeFullPageJob) throw new Error('Wait for the full-page screenshot to finish or cancel it first.');
  visibleScreenshotJobs++;
  try {
    const dataUrl = await limiter(() => api.tabs.captureVisibleTab(tab.windowId, { format: 'png' }), undefined, () => assertCaptureTab(api, tab));
    // captureVisibleTab targets a window, so do not attach a changed tab's pixels to the old page.
    await assertCaptureTab(api, tab);
    const file = pngDataUrlBlob(dataUrl);
    Object.defineProperty(file, 'name', { value: `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png` });
    // The cover is a small card preview; the PNG itself is the attachment (the detail view shows it when there is no cover).
    const cover = await Promise.resolve().then(() => makePreview(file)).catch(() => '');
    const attachment = await persistAttachment(file);
    let item;
    try {
      item = await persistItem({ type: 'image', title: `Screenshot of ${tab.title || new URL(sourceUrl).hostname}`, url: '', sourceUrl,
        excerpt: 'Visible page screenshot', content: '', articleContent: '', cover, ...attachment });
    } catch (error) {
      try { await removeAttachment(attachment.attachmentId); }
      catch (cleanupError) { throw new Error(`${error.message} Screenshot file cleanup also failed: ${cleanupError.message}`); }
      throw error;
    }
    return item;
  } finally { visibleScreenshotJobs--; }
}

const fullPageJobs = new Map();
let activeFullPageJob = null;

function publishCaptureProgress(job, progress, runtime = api.runtime) {
  job.status = progress.status;
  job.progress = { ...job.progress, ...progress, jobId: job.id };
  // Opening/closing an extension view is independent of the owned capture job.
  try { Promise.resolve(runtime.sendMessage?.({ type: 'still:full-page-progress', ...job.progress })).catch(() => {}); }
  catch { /* No receiving view. */ }
}

export function getFullPageCaptureJob(jobId) {
  const job = jobId ? fullPageJobs.get(jobId) : activeFullPageJob;
  return job ? { ...job.progress, jobId: job.id, status: job.status } : null;
}

export function cancelFullPageCapture(jobId) {
  const job = fullPageJobs.get(jobId);
  const canCancel = job && !['saving', 'saved', 'error', 'cancelled'].includes(job.status) && !job.controller.signal.aborted;
  if (canCancel) job.controller.abort(new Error('Full-page capture cancelled.'));
  return { jobId, cancelled: Boolean(canCancel), status: job?.status || 'unknown' };
}

// Keep the handle while work is pending; the runtime message listener below
// returns true until this promise resolves, keeping the worker response alive.
export function startFullPageCapture(tab, { jobId = crypto.randomUUID(), persistAttachment = saveAttachment, removeAttachment = deleteAttachment,
  persistItem = saveItem, capturePixels = captureFullPagePixels, captureApi = api, limiter = captureRateLimiter, timeoutMs = 120_000, ...pixelOptions } = {}) {
  if (typeof jobId !== 'string' || !/^[a-z\d][a-z\d_-]{7,79}$/i.test(jobId)) throw new Error('Invalid full-page capture job ID.');
  if (activeFullPageJob) throw new Error('A full-page screenshot is already running.');
  if (visibleScreenshotJobs) throw new Error('Wait for the visible screenshot to finish before capturing the full page.');
  if (fullPageJobs.has(jobId)) throw new Error('This capture job ID has already been used.');
  // A runtime request registers its handle before resolving the active tab, so
  // a Cancel arriving during tabs.query cannot race ahead of job ownership.
  if (!tab?.then) screenshotSourceUrl(tab);
  const job = { id: jobId, controller: new AbortController(), status: 'preparing', progress: {}, startedAt: Date.now() };
  // Retain a small number of status receipts, never the PNG/blob or library item.
  for (const [id, previous] of fullPageJobs) if (previous !== activeFullPageJob && (fullPageJobs.size >= 8 || Date.now() - previous.startedAt > 180_000)) fullPageJobs.delete(id);
  fullPageJobs.set(jobId, job); activeFullPageJob = job;
  const timer = setTimeout(() => {
    if (!['saving', 'saved'].includes(job.status)) job.controller.abort(new Error('Full-page capture timed out. Try a shorter page or visible screenshot.'));
  }, timeoutMs);
  const promise = (async () => {
    let attachment, committed = false;
    try {
      tab = { ...await tab };
      checkCaptureCancelled(job.controller.signal);
      const sourceUrl = screenshotSourceUrl(tab);
      const image = await capturePixels(tab, { ...pixelOptions, api: captureApi, jobId, signal: job.controller.signal, limiter,
        onProgress: progress => publishCaptureProgress(job, progress, captureApi.runtime) });
      checkCaptureCancelled(job.controller.signal);
      await assertCaptureTab(captureApi, tab);
      const file = image.blob;
      if (!(file instanceof Blob) || file.type !== 'image/png') throw new Error('Chrome did not produce a PNG full-page screenshot.');
      Object.defineProperty(file, 'name', { value: `full-page-${new Date().toISOString().replace(/[:.]/g, '-')}.png` });
      attachment = await persistAttachment(file);
      checkCaptureCancelled(job.controller.signal);
      // Recheck after IndexedDB work; never save a screenshot under a changed URL.
      await assertCaptureTab(captureApi, tab);
      checkCaptureCancelled(job.controller.signal);
      publishCaptureProgress(job, { status: 'saving', completed: image.tileCount, total: image.tileCount, width: image.width, height: image.height }, captureApi.runtime);
      const item = await persistItem({ type: 'image', title: `Full-page screenshot of ${tab.title || new URL(sourceUrl).hostname}`, url: '', sourceUrl,
        excerpt: `${image.width} × ${image.height} PNG · ${image.tileCount} ${image.tileCount === 1 ? 'tile' : 'tiles'}`, content: '', articleContent: '', cover: image.cover, ...attachment });
      committed = true;
      publishCaptureProgress(job, { status: 'saved', itemId: item.id, completed: image.tileCount, total: image.tileCount, width: image.width, height: image.height }, captureApi.runtime);
      return { id: item.id, item, jobId, width: image.width, height: image.height, tileCount: image.tileCount };
    } catch (error) {
      let failure = error;
      if (attachment && !committed) {
        try { await removeAttachment(attachment.attachmentId); }
        catch (cleanupError) { failure = new Error(`${error.message} Screenshot file cleanup also failed: ${cleanupError.message}`); }
      }
      publishCaptureProgress(job, { status: job.controller.signal.aborted && /cancelled/i.test(job.controller.signal.reason?.message || '') ? 'cancelled' : 'error', message: failure.message }, captureApi.runtime);
      throw failure;
    } finally {
      clearTimeout(timer);
      if (activeFullPageJob === job) activeFullPageJob = null;
    }
  })();
  return { id: jobId, promise, cancel: () => cancelFullPageCapture(jobId) };
}

export function captureFullPage(tab, options) { return startFullPageCapture(tab, options).promise; }

async function syncReminders(state) {
  const currentAlarms = await api.alarms.getAll();
  const needed = new Map(state.items.filter(item => item.reminderAt && !item.deletedAt && !item.reminderNotifiedAt)
    .map(item => [REMINDER_PREFIX + item.id, Math.max(Date.now() + 1000, new Date(item.reminderAt).getTime())]));
  for (const alarm of currentAlarms) if (alarm.name.startsWith(REMINDER_PREFIX) && !needed.has(alarm.name)) await api.alarms.clear(alarm.name);
  for (const [name, when] of needed) {
    const existing = currentAlarms.find(alarm => alarm.name === name);
    if (!existing || Math.abs(existing.scheduledTime - when) > 1000) await api.alarms.create(name, { when });
  }
}

async function restoreReminders() {
  const stored = (await api.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (stored) { libraryCache ??= stored; await syncReminders(stored); }
}

export async function handleAlarm(alarm) {
  if (alarm.name === 'still:clear-badge') {
    clearTimeout(badgeTimer);
    await attempt(() => api.action.setBadgeText({ text: '' }));
    const tabIds = [...checkedTabs];
    checkedTabs.clear();
    for (const tabId of tabIds) {
      const tab = tabTracking ? await attempt(() => api.tabs.get(tabId)) : null;
      if (tab) await updateTabBadge(tab);
      else await attempt(() => api.action.setBadgeText({ tabId, text: null }));
    }
    return;
  }
  if (!alarm.name.startsWith(REMINDER_PREFIX)) return;
  const id = alarm.name.slice(REMINDER_PREFIX.length);
  const state = await loadLibrary();
  const item = state.items.find(value => value.id === id);
  if (!item || item.deletedAt || !item.reminderAt || item.reminderNotifiedAt) return;
  if (new Date(item.reminderAt).getTime() > Date.now() + 1000) return;
  await api.notifications.create(`still:item:${id}`, { type: 'basic', iconUrl: 'icons/icon128.png', title: item.title,
    message: item.excerpt || 'A little reminder from your Still library.', priority: 1 });
  await updateItem(id, { reminderNotifiedAt: new Date().toISOString() });
}

async function importBrowserBookmarks() {
  if (!(await api.permissions.contains({ permissions: ['bookmarks'] }))) throw new Error('Allow bookmark access in Settings before importing.');
  const roots = await api.bookmarks.getTree();
  let imported = 0;
  async function walk(nodes, collectionId = '') {
    for (const node of nodes) {
      if (node.url) {
        if (!/^https?:\/\//i.test(node.url)) continue;
        await saveItem({ type: 'bookmark', title: node.title, url: node.url, collectionId }); imported++;
      } else if (node.children) {
        const collection = node.title ? await createCollection({ name: node.title, parentId: collectionId }) : null;
        await walk(node.children, collection?.id || collectionId);
      }
    }
  }
  await walk(roots);
  return { imported };
}

export async function handleMessage(message, sender) {
  if (!sender || sender.id !== api.runtime.id) throw new Error('Untrusted extension message.');
  if (!message || typeof message !== 'object') throw new Error('Invalid request.');
  const input = messageInput(message);
  if (message.type === 'still:store') return handleStoreOperation(input.operation, input.args);
  if (CAPTURE_MESSAGES.includes(message.type)) return captureCurrentTab(input);
  if (['captureScreenshot', 'still:capture-screenshot'].includes(message.type)) return captureScreenshot(await targetTab(input));
  if (message.type === 'captureFullPage') {
    // The tab lookup starts first so a Cancel can own the job at once; if the job is refused (one already runs,
    // bad jobId) nothing awaits the lookup, so its rejection must not surface as an unhandled one.
    const tab = targetTab(input);
    tab.catch(() => {});
    return captureFullPage(tab, { jobId: input.jobId });
  }
  if (message.type === 'cancelFullPageCapture') return cancelFullPageCapture(input.jobId);
  if (message.type === 'getFullPageCaptureJob') return getFullPageCaptureJob(input.jobId);
  if (['openLibrary', 'still:open-library'].includes(message.type)) return openLibrary(typeof input.itemId === 'string' ? input.itemId : '');
  if (['openSidePanel', 'still:open-sidepanel'].includes(message.type)) {
    // Opened before any await so a gesture forwarded with the message is still usable.
    const windowId = sender.tab?.windowId ?? input.windowId;
    const tab = Number.isInteger(windowId) ? { windowId } : await activeTab();
    return { opened: await openSidePanel(tab), windowId: tab.windowId ?? null };
  }
  if (['newNote', 'still:new-note'].includes(message.type)) return saveItem({ type: 'note', title: 'Untitled note', content: '' });
  if (message.type === 'importBrowserBookmarks') return importBrowserBookmarks();
  if (message.type === 'saveTabs') return saveTabs(input);
  if (message.type === 'listTabs') return listTabs(input);
  if (message.type === 'getActiveTab') return getActiveTab(input);
  if (message.type === 'getPageContext') return getPageContext(input);
  throw new Error('Unknown Still request.');
}

function handleMenuClick(info, tab) {
  if (info.menuItemId === 'still-open-library') { openLibrary().catch(reportError); return; }
  const saveTo = parseSaveToMenuId(info.menuItemId);
  if (saveTo?.choose) { chooseCollection(info, tab, saveTo.kind).catch(reportError); return; }
  // Side panel open is invoked directly inside the user gesture, before capture awaits.
  const quiet = libraryCache?.settings?.openPanelOnSave === false && !['still-screenshot', 'still-screenshot-full'].includes(info.menuItemId);
  const panelOpening = quiet ? Promise.resolve(false) : openSidePanel(tab).catch(reportError);
  if (info.menuItemId === 'still-screenshot') { captureScreenshot(tab).catch(reportError); return; }
  if (info.menuItemId === 'still-screenshot-full') { panelOpening.then(() => captureFullPage(tab)).catch(reportError); return; }
  if (saveTo) {
    captureTab(tab, info, { collectionId: saveTo.collectionId })
      .then(item => (saveTo.collectionId && !item.collectionFallback ? touchRecentCollection(saveTo.collectionId) : null))
      .catch(reportError);
    return;
  }
  captureTab(tab, info).catch(reportError);
}

function handleCommand(command, tab) {
  if (command === 'open-library') { openLibrary().catch(reportError); return; }
  if (command === 'new-note') { newPageNote(tab).catch(reportError); return; }
  if (command === 'save-current') (Number.isInteger(tab?.id) ? Promise.resolve(tab) : activeTab()).then(target => captureTab(target)).catch(reportError);
}

if (api?.runtime?.onMessage) {
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !MESSAGE_TYPES.includes(message.type)) return false;
    const respond = response => { try { sendResponse(response); } catch { /* The requesting view closed. */ } };
    handleMessage(message, sender).then(result => respond({ ok: true, result }), error => respond({ ok: false, error: error.message }));
    return true;
  });
  api.runtime.onInstalled?.addListener(() => {
    installMenus().then(readLibrary).then(library => installCollectionMenus(library, { force: true })).catch(reportError);
    Promise.resolve(api.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })).catch(reportError);
    // The UI seeds a new library; installing does not overwrite existing captures.
  });
  api.runtime.onStartup?.addListener(() => {
    Promise.resolve(api.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })).catch(reportError);
    restoreReminders().catch(reportError);
    readLibrary().then(library => installCollectionMenus(library)).catch(error => console.warn('Still menus:', error?.message));
  });
  api.contextMenus?.onClicked?.addListener(handleMenuClick);
  api.commands?.onCommand?.addListener(handleCommand);
  api.alarms?.onAlarm?.addListener(alarm => { handleAlarm(alarm).catch(reportError); });
  api.notifications?.onClicked?.addListener(id => {
    if (id.startsWith('still:item:')) openLibrary(id.slice('still:item:'.length)).catch(reportError);
    attempt(() => api.notifications.clear(id));
  });
  api.storage?.onChanged?.addListener((changes, area) => { if (area === 'local' && changes[RECENT_COLLECTIONS_KEY]) scheduleLibraryRefresh(); });
  api.permissions?.onAdded?.addListener(change => { if (change?.permissions?.includes('tabs')) startTabTracking(); });
  api.permissions?.onRemoved?.addListener(change => { if (change?.permissions?.includes('tabs')) stopTabTracking(); });
  subscribe(state => {
    libraryCache = state;
    syncReminders(state).catch(reportError);
    scheduleLibraryRefresh();
  });
  restoreReminders().catch(reportError);
  listenToTabs(true);
  tabTrackingReady = hasPermission({ permissions: ['tabs'] }).then(granted => {
    if (granted) startTabTracking(); else if (!tabTracking) listenToTabs(false);
  });
}

export { MENU_ITEMS, MESSAGE_TYPES, STORAGE_KEY };
