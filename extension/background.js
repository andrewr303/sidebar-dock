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
 *                               tab URL is unreadable. collectionId '' = Inbox; omitted = settings.defaultCollectionId
 *                               for new items. note fills content only when the item is new or its note is empty.
 *   saveTabs                 { windowId?, tabIds?, collectionId?, newCollectionName?, tags? }
 *                            -> { saved, created, skipped, collectionId, itemIds } | { needsPermission: 'tabs' }
 *   listTabs                 { windowId? } -> [{ tabId, windowId, url, title, favIconUrl, active, saved }] (http/https)
 *                            | { needsPermission: 'tabs' }
 *   getActiveTab             { windowId? } -> { granted: true, tabId, windowId, url, title, favIconUrl, saved, itemId }
 *                            | { granted: false, tabId, windowId } when neither 'tabs' nor an activeTab grant exposes the URL
 *   getPageContext           { tabId?, windowId? } -> { tabId, url, title, excerpt, cover, selection, text (<= 120000 chars),
 *                               truncated, lang } | { needsPermission: '<scheme>://<host>/*' | 'tabs', tabId, windowId }
 *                               (request it with chrome.permissions.request inside a click, then ask again)
 *   captureScreenshot | still:capture-screenshot, captureFullPage { jobId }, cancelFullPageCapture { jobId },
 *   getFullPageCaptureJob { jobId? }, openLibrary | still:open-library { itemId? },
 *   openSidePanel | still:open-sidepanel { windowId? } -> { opened, windowId }, newNote | still:new-note,
 *   importBrowserBookmarks
 *   still:snapshots          { op: 'list'|'create'|'restore'|'delete', args[] } -> lib/storage/snapshots.js results
 *   still:capture-article    { tabId?, windowId?, collectionId?, tags?, note?, title?, save?: boolean }
 *                            -> save false (the side panel preview): { article, existing, url, tabId, windowId } where
 *                               article is a cleaned ArticleResult ({ ok: false, code, error } when nothing was readable),
 *                               existing the saved item at that address (summary) or null, url the address it saves under;
 *                               save true: saved Item + { created, updated } (an already saved page only gets fresh article
 *                               text and missing metadata). { needsPermission } exactly like getPageContext.
 *   still:threadkeeper       { op, args } -> { ok: true, data } | { ok: false, error: { code, message } } (never a thrown error,
 *                            so pages keep the code): the Threadkeeper link's page proxy (lib/threadkeeper/worker.js;
 *                            pages use lib/threadkeeper/client.js).
 *   still:start-picker       { tabId?, windowId?, from: 'panel' | 'menu' } -> { requestId, tabId, windowId } | { needsPermission }
 *                               Injects the page picker; its single result comes back as still:picker-result.
 *   still:picker-result      content script only (the picker in frame 0 of the tab it was started in, with a request id
 *                            the worker issued): { requestId, from, result } | { requestId, from, cancelled: true }.
 *                            from 'menu' saves (badge + notification); from 'panel' is read by the side panel itself.
 *
 * Senders: content scripts share the extension id, so senders are classified by origin (sender.url outside
 * chrome-extension://<id>/), never by sender.tab (a full-tab Still page has one). A content script may only send
 * still:picker-result; everything else from a web page, including still:store, is refused.
 *
 * Threadkeeper (docs/threadkeeper-integration.md): runtime.onMessageExternal accepts only the protocol envelope from the
 * paired Threadkeeper's own extension pages (sender id + chrome-extension://<id> origin, no tab; unpaired senders may only
 * say hello or answer Still's pairing request) and answers with flat protocol responses. It never reaches handleMessage
 * or the store's operation set. Chats arrive through one coalesced upsertChats write; chat data (summaries, transcripts)
 * lives in IndexedDB (lib/chat-data.js). Alarms 'still:threadkeeper:retry' (sync.configure backoff) and
 * 'still:threadkeeper:sweep' (daily orphan sweep + liveness hello); onStartup/onInstalled sweep and say hello after the
 * startup gate. A snapshot restore or library import gives Threadkeeper a new epoch so it re-offers what Still may lack.
 *
 * Storage safety (lib/storage/): on every worker start the snapshot gate compares the manifest version with
 * still.meta.v1.lastVersion and, when it changed, snapshots all Still data (reason 'update') before any library operation
 * is served (the store awaits the gate). A library migration snapshots first ('before-migration'); the daily alarm
 * 'still:snapshot-daily' snapshots only when data changed since the last snapshot (marked by the store's onCommit hook
 * and by storage changes to other Still keys).
 *
 * Broadcasts to extension pages (runtime.sendMessage; nobody listening is fine):
 *   still:full-page-progress { jobId, status, ... }
 *   still:active-tab { tab: { tabId, windowId, url, title, favIconUrl, saved, itemId } }   (only with 'tabs')
 *   still:open-add  { payload: { url, title, kind: 'page'|'link'|'image', sourceUrl }, windowId, requestId }
 *   still:open-note { id, windowId, requestId }
 *   still:research  { itemId, windowId, requestId }   ("Save and research with AI": the item is already saved)
 * still:open-add, still:open-note and still:research are retried for about 2 s while the side panel loads: the side panel
 * answers with sendResponse({ ok: true }) once handled and ignores a requestId it has already seen.
 */
import {
  configureStoreWorker, handleStoreOperation, loadLibrary, saveItem, updateItem,
  createCollection, subscribe, STORAGE_KEY, canonicalUrl, safeUrl, saveAttachment, deleteAttachment,
} from './lib/store.js';
import {
  buildCapture, readPageMetadata, readPageContext, collectionMenuEntries, parseSaveToMenuId, saveToMenuId,
  resolveCaptureCollection, findSavedItem, indexSavedUrls, savedFromSource, isPlaceholderTitle, isVideoUrl, normalizeTags,
  normalizeRecentCollections, PAGE_TEXT_LIMIT, CHOOSE_MENU_ID, SEPARATOR_MENU_ID, INBOX_MENU_ID,
  ARTICLE_LIMIT, ARTICLE_SCRIPT_FILES, PICKER_SCRIPT_FILES, runArticleExtract, startPagePicker, normalizeArticleResult,
  articleSaveUrl, buildArticleCapture, savedSelectionMessage, PANEL_DRAFTS_KEY,
} from './lib/capture.js';
import { assertCaptureTab, captureRateLimiter, captureFullPagePixels, checkCaptureCancelled, pngDataUrlBlob } from './lib/full-page-capture.js';
import { configureSnapshotWorker, handleSnapshotRequest, isSnapshotKey, SNAPSHOT_ALARM, SNAPSHOT_MESSAGE } from './lib/storage/snapshots.js';
import { LIBRARY_SCHEMA_VERSION, libraryVersion } from './lib/storage/migrations.js';
import { configureThreadkeeperWorker, handleExternalMessage, handleThreadkeeperRequest, THREADKEEPER_MESSAGE } from './lib/threadkeeper/worker.js';
import { STATE_KEY as THREADKEEPER_STATE_KEY } from './lib/threadkeeper/state.js';
import { chatDataStore } from './lib/chat-data.js';
import { createBrowserHost } from './lib/browser/host.js';
import { loadBrowserControl } from './lib/browser-control/layer.js';

// The worker owns snapshots and the library. Store operations wait for the startup snapshot gate (set below once the
// extension APIs exist); a failed snapshot is logged and never blocks the library.
const snapshots = configureSnapshotWorker();
let startupGate = Promise.resolve(null);
const warnSnapshot = error => console.warn('Still snapshot:', error?.message || String(error));
configureStoreWorker({
  ready: () => startupGate,
  // Chats deleted forever lose their chat data (and the user's deletions stop Threadkeeper from sending them again).
  onCommit: change => { snapshots.markDirty().catch(warnSnapshot); threadkeeper.onCommit(change); },
  beforeMigration: () => snapshots.create('before-migration'),
});

const api = globalThis.chrome;
// The Threadkeeper link reads the stored library directly: it decides against the latest write, not the cached copy.
const freshLibrary = async () => (api?.storage?.local ? (await api.storage.local.get(STORAGE_KEY))[STORAGE_KEY] : null) || { items: [], collections: [], settings: {} };
const storeOperation = name => (...args) => handleStoreOperation(name, args);
const threadkeeper = configureThreadkeeperWorker({
  store: Object.fromEntries(['upsertChats', 'markChatsRemoved', 'placeChats', 'setChatFlags', 'deleteChats'].map(name => [name, storeOperation(name)])),
  // The same chat store this context's chat-data helpers use (one IndexedDB connection; pages open their own).
  chatData: chatDataStore(),
  readLibrary: freshLibrary,
});
const warnThreadkeeper = error => console.warn('Still Threadkeeper:', error?.message || String(error));
// Browser automation for the assistant: the worker holds the browser control layer and the assistant's pages reach it
// over a port (lib/browser/host.js). Importing the layer runs nothing; it is evaluated when a page first opens a session.
const browserHost = createBrowserHost({ api, loadLayer: loadBrowserControl, isContentSender });
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
  // New top-level items go before the "Save … to" parents: those are recreated at the end on every rebuild.
  { id: 'still-save-article', title: 'Save article to Still', contexts: ['page'], documentUrlPatterns: WEB_PAGES },
  { id: 'still-select-parts', title: 'Select parts of page…', contexts: ['page'], documentUrlPatterns: WEB_PAGES },
  { id: 'still-save-research', title: 'Save and research with AI', contexts: ['page'], documentUrlPatterns: WEB_PAGES },
  { id: 'still-save-page-to', title: 'Save page to', contexts: ['page'], documentUrlPatterns: WEB_PAGES },
  { id: 'still-save-link-to', title: 'Save link to', contexts: ['link'], targetUrlPatterns: WEB_PAGES },
  { id: 'still-save-image-to', title: 'Save image to', contexts: ['image'], targetUrlPatterns: WEB_PAGES },
];
const SAVE_TO_MENUS = { page: 'still-save-page-to', link: 'still-save-link-to', image: 'still-save-image-to' };
const CAPTURE_MESSAGES = ['captureCurrent', 'saveCurrentTab', 'still:capture-current'];
const MESSAGE_TYPES = ['still:store', SNAPSHOT_MESSAGE, ...CAPTURE_MESSAGES, 'captureScreenshot', 'still:capture-screenshot', 'captureFullPage',
  'cancelFullPageCapture', 'getFullPageCaptureJob', 'openLibrary', 'still:open-library', 'openSidePanel', 'still:open-sidepanel',
  'newNote', 'still:new-note', 'importBrowserBookmarks', 'saveTabs', 'getActiveTab', 'getPageContext', 'listTabs',
  'still:capture-article', 'still:start-picker', 'still:picker-result', THREADKEEPER_MESSAGE];
// Picker requests survive a worker restart in storage.session (cleared with the browser, never readable by pages).
const PICKER_SESSION_KEY = 'still.capture.pickers.v1';
const PICKER_TTL_MS = 30 * 60 * 1000;

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
const STARTUP_GATE_MS = 20000;

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
  const target = resolveCaptureCollection(library, options.collectionId, { existing, preferred: source?.collectionId });
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
  const name = typeof input.newCollectionName === 'string' ? input.newCollectionName.trim() : '';
  const explicit = Boolean(name) || typeof input.collectionId === 'string';
  const target = name ? { collectionId: (await createCollection({ name })).id }
    : resolveCaptureCollection(library, typeof input.collectionId === 'string' ? input.collectionId : undefined);
  const tags = normalizeTags(input.tags);
  const seen = new Set(), itemIds = [];
  let saved = 0, created = 0, skipped = 0;
  for (const tab of wanted ? tabs.filter(tab => wanted.has(tab.id)) : tabs) {
    let url = '', key = '';
    try { if (/^https?:\/\//i.test(tab.url || '')) { url = safeUrl(tab.url); key = canonicalUrl(url); } } catch { url = ''; }
    if (!url || seen.has(key)) { skipped++; continue; }
    seen.add(key);
    const existing = findSavedItem(library, url);
    // An existing item keeps its type, title and (for quick saves) its collection. A tab an article was saved from under
    // its canonical address updates that article (saved at its own address) instead of adding a copy.
    const entry = { url: savedFromSource(existing, url) ? existing.url : url, tags, collectionId: explicit || !existing ? target.collectionId : '' };
    if (!existing) entry.type = isVideoUrl(url) ? 'video' : 'bookmark';
    if (!existing || isPlaceholderTitle(existing.title, url)) entry.title = tab.title || '';
    try {
      const item = await saveItem(entry);
      saved++; itemIds.push(item.id);
      if (!existing) created++;
    } catch (error) { skipped++; console.info('Still skipped a tab:', error?.message); }
  }
  return { saved, created, skipped, collectionId: target.collectionId, itemIds, ...(target.collectionFallback ? { collectionFallback: true } : {}) };
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

// An injection failed: name the grant the UI must request inside a click, or rethrow when access was already granted
// (the page itself refuses scripts, for example the Chrome Web Store).
async function missingAccess(tab, error) {
  if (!tab.url) return { needsPermission: 'tabs', tabId: tab.id, windowId: tab.windowId };
  const { protocol, hostname } = new URL(tab.url);
  const origin = `${protocol}//${hostname}/*`;
  if (await hasPermission({ origins: [origin] })) throw error;
  return { needsPermission: origin, tabId: tab.id, windowId: tab.windowId };
}

async function getPageContext(input) {
  const tab = await targetTab(input);
  if (tab.url && !/^https?:\/\//i.test(tab.url)) throw new Error('Still can read web pages only (http or https).');
  let result;
  try {
    [result] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: readPageContext, args: [PAGE_TEXT_LIMIT] });
  } catch (error) {
    return missingAccess(tab, error);
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

/* ------------------------------------------------------------------ article capture and the page picker */

const webAddress = value => { try { return /^https?:\/\//i.test(value || '') ? safeUrl(value) : ''; } catch { return ''; } };
const newRequestId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
// The second injection targets the document the files ran in, so a navigation in between cannot mix two pages.
const sameDocument = (tab, injected) => (typeof injected?.documentId === 'string' && injected.documentId
  ? { tabId: tab.id, documentIds: [injected.documentId] } : { tabId: tab.id, frameIds: [0] });

// Loads Readability and the extractor into frame 0 (isolated world), then reads the article from that same document.
// Resolves { article, pageUrl } (article cleaned by normalizeArticleResult) or { needsPermission, tabId, windowId }.
export async function extractArticle(tab) {
  if (!Number.isInteger(tab?.id)) throw new Error('No active browser tab was found.');
  if (tab.url && !/^https?:\/\//i.test(tab.url)) throw new Error('Still can read web pages only (http or https).');
  let result;
  try {
    const [loaded] = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ARTICLE_SCRIPT_FILES });
    [result] = await api.scripting.executeScript({ target: sameDocument(tab, loaded), func: runArticleExtract, args: [{ maxChars: ARTICLE_LIMIT }] });
  } catch (error) {
    return missingAccess(tab, error);
  }
  const pageUrl = webAddress(tab.url) || webAddress(result?.result?.url);
  return { article: normalizeArticleResult(result?.result, { pageUrl }), pageUrl };
}

const itemSummary = item => (item ? { id: item.id, type: item.type, title: item.title, url: item.url, collectionId: item.collectionId || '', updatedAt: item.updatedAt } : null);

// Saves a readable article. A page saved before (under the address it saves to, or under the tab's own address) keeps
// its note, title, tags and collection and only gets fresh article text plus metadata it was missing.
export async function saveArticle(tab, article, { pageUrl = webAddress(tab?.url) || article?.url, ...options } = {}) {
  if (!article?.ok) throw new Error(article?.error || 'Still could not read an article on this page.');
  const library = await readLibrary();
  const url = articleSaveUrl(article, pageUrl);
  const existing = findSavedItem(library, url) || (pageUrl ? findSavedItem(library, pageUrl) : null);
  const target = existing ? { collectionId: '' } : resolveCaptureCollection(library, options.collectionId);
  const input = buildArticleCapture(article, { ...options, url, pageUrl, existing, collectionId: target.collectionId, fallbackTitle: tab?.title });
  const item = await saveItem(input);
  await showSavedBadge(tab?.id);
  const created = !(library.items || []).some(entry => entry?.id === item.id);
  return { ...item, created, updated: !created, ...(target.collectionFallback ? { collectionFallback: true } : {}) };
}

async function captureArticleRequest(input) {
  const tab = await targetTab(input);
  const extracted = await extractArticle(tab);
  if (extracted.needsPermission) return extracted;
  const { article, pageUrl } = extracted;
  if (input.save !== true) {
    // The preview reads the article straight from this reply: no broadcast carries it.
    if (!article.ok) return { article, existing: null, url: pageUrl, tabId: tab.id, windowId: tab.windowId ?? null };
    const library = await readLibrary();
    const url = articleSaveUrl(article, pageUrl);
    const existing = findSavedItem(library, url) || (pageUrl ? findSavedItem(library, pageUrl) : null);
    return { article, existing: itemSummary(existing), url: existing?.url || url, tabId: tab.id, windowId: tab.windowId ?? null };
  }
  return saveArticle(tab, article, { pageUrl, ...captureOptions(input) });
}

// Context-menu article save. When no article is readable (or the page refuses scripts) the page is saved the usual way,
// so the click never loses the page.
async function captureArticleForMenu(tab, info = {}) {
  const page = { ...tab, url: tab?.url || info.pageUrl };
  try {
    const extracted = await extractArticle(page);
    if (extracted.article?.ok) return await saveArticle(page, extracted.article, { pageUrl: extracted.pageUrl });
    console.info('Still saved the page without article text:', extracted.article?.error || 'no access to the page');
  } catch (error) { console.info('Still saved the page without article text:', error?.message); }
  return captureTab(page, { pageUrl: info.pageUrl || page.url, menuItemId: 'still-save-page' });
}

// "Save and research with AI": the panel is opened inside the click (no await before it), the article is saved, then
// the side panel is asked to start research on it. Without a panel the item opens in a Still tab instead.
function saveAndResearch(tab, info) {
  const opening = openSidePanel(tab).catch(() => false);
  return (async () => {
    const item = await captureArticleForMenu(tab, info);
    const delivered = (await opening) && await deliverToPanel({ type: 'still:research', itemId: item.id, windowId: tab?.windowId });
    if (!delivered) await openLibrary(item.id);
    return item;
  })();
}

const pickerRequests = new Map();
const freshRecords = (records, now = Date.now()) => Object.fromEntries(Object.entries(records && typeof records === 'object' ? records : {})
  .filter(([, record]) => record && typeof record === 'object' && now - Number(record.startedAt ?? record.createdAt) <= PICKER_TTL_MS));
const newestRecords = (records, limit) => Object.fromEntries(Object.entries(records)
  .sort(([, a], [, b]) => Number(b.startedAt ?? b.createdAt) - Number(a.startedAt ?? a.createdAt)).slice(0, limit));

async function readSession(key) {
  try { return (await api.storage?.session?.get?.(key))?.[key] || {}; } catch { return {}; }
}
async function writeSession(key, value) {
  try { await api.storage?.session?.set?.({ [key]: value }); } catch (error) { console.warn('Still session storage:', error?.message); }
}

async function rememberPicker(requestId, record) {
  pickerRequests.set(requestId, record);
  const stored = freshRecords(await readSession(PICKER_SESSION_KEY));
  stored[requestId] = record;
  await writeSession(PICKER_SESSION_KEY, newestRecords(stored, 20));
}

async function findPicker(requestId) {
  const record = pickerRequests.get(requestId) || (await readSession(PICKER_SESSION_KEY))[requestId];
  return record && Date.now() - Number(record.startedAt) <= PICKER_TTL_MS ? record : null;
}

async function forgetPicker(requestId) {
  pickerRequests.delete(requestId);
  const stored = await readSession(PICKER_SESSION_KEY);
  if (Object.hasOwn(stored, requestId)) { delete stored[requestId]; await writeSession(PICKER_SESSION_KEY, freshRecords(stored)); }
}

// Injects the picker into frame 0 and starts it with a fresh request id. Its one result message must come back from
// that tab, frame and document with that id (handlePickerResult).
export async function startPicker(tab, { from = 'panel' } = {}) {
  const origin = from === 'menu' ? 'menu' : 'panel';
  if (!Number.isInteger(tab?.id)) throw new Error('No active browser tab was found.');
  if (tab.url && !/^https?:\/\//i.test(tab.url)) throw new Error('Still can select parts of web pages only (http or https).');
  let loaded;
  try { [loaded] = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: PICKER_SCRIPT_FILES }); }
  catch (error) { return missingAccess(tab, error); }
  const requestId = newRequestId();
  const documentId = typeof loaded?.documentId === 'string' ? loaded.documentId : '';
  // Remembered before start(): a quick Done must find its request.
  await rememberPicker(requestId, { tabId: tab.id, windowId: Number.isInteger(tab.windowId) ? tab.windowId : null, from: origin, documentId, startedAt: Date.now() });
  let started;
  try { [started] = await api.scripting.executeScript({ target: sameDocument(tab, loaded), func: startPagePicker, args: [{ requestId, from: origin }] }); }
  catch (error) { await forgetPicker(requestId); throw error; }
  if (started?.result?.started !== true) {
    await forgetPicker(requestId);
    throw new Error(started?.result?.error || 'The page picker could not start on this page.');
  }
  return { requestId, tabId: tab.id, windowId: Number.isInteger(tab.windowId) ? tab.windowId : null };
}

// Content scripts carry this extension's id too; only the origin tells them apart from Still's own pages.
export function isContentSender(sender) {
  const base = api.runtime.getURL('');
  if (typeof sender?.url === 'string') return !sender.url.startsWith(base);
  if (typeof sender?.origin === 'string') return `${sender.origin}/` !== base;
  return false;
}

const pickerSenderMatches = (record, sender) => sender?.tab?.id === record.tabId && sender.frameId === 0
  && (!record.documentId || typeof sender.documentId !== 'string' || sender.documentId === record.documentId);

async function notify(id, title, message) {
  await attempt(() => api.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', title: String(title || 'Still').slice(0, 200), message, priority: 0 }));
}

// A side panel that is open in the picker's window takes the result straight from the page. When none is open (closed
// while the user was selecting), the cleaned result waits in storage.session until that window's panel starts.
async function stashPanelDraft(requestId, record, article) {
  if (!article.ok || typeof api.runtime.getContexts !== 'function') return false;
  let panels;
  try {
    panels = await api.runtime.getContexts({ contextTypes: ['SIDE_PANEL'], ...(Number.isInteger(record.windowId) ? { windowIds: [record.windowId] } : {}) });
  } catch { return false; }
  if (panels?.length) return false;
  const drafts = freshRecords(await readSession(PANEL_DRAFTS_KEY));
  drafts[requestId] = { draftId: requestId, windowId: record.windowId, tabId: record.tabId, createdAt: Date.now(), article };
  await writeSession(PANEL_DRAFTS_KEY, newestRecords(drafts, 3));
  return true;
}

async function handlePickerResult(input, sender) {
  const requestId = typeof input.requestId === 'string' && input.requestId.length <= 200 ? input.requestId : '';
  const record = requestId ? await findPicker(requestId) : null;
  if (!record || !pickerSenderMatches(record, sender)) throw new Error('Still did not ask for this page selection.');
  await forgetPicker(requestId);
  if (input.cancelled === true) return { cancelled: true };
  const pageUrl = webAddress(sender.url) || webAddress(sender.tab?.url);
  const article = normalizeArticleResult(input.result, { pageUrl });
  if (record.from !== 'menu') return { received: true, stashed: await stashPanelDraft(requestId, record, article) };
  const site = pageUrl ? new URL(pageUrl).hostname.replace(/^www\./, '') : 'the page';
  if (!article.ok) {
    await notify(`still:capture:${requestId}`, 'Nothing was saved', `${article.error} (${site})`);
    return { saved: false, error: article.error };
  }
  const tab = { id: record.tabId, windowId: record.windowId, url: pageUrl, title: sender.tab?.title || '' };
  const item = await saveArticle(tab, article, { pageUrl });
  await notify(`still:item:${item.id}`, item.title, savedSelectionMessage(article, item.url));
  return { saved: true, id: item.id, created: item.created, updated: item.updated };
}

export async function createPageNote(tab) {
  let url = '';
  try { url = /^https?:\/\//i.test(tab?.url || '') ? safeUrl(tab.url) : ''; } catch { url = ''; }
  if (!url) return saveItem({ type: 'note', title: 'Untitled note', content: '' });
  const library = await readLibrary();
  const source = findSavedItem(library, url);
  const { collectionId } = resolveCaptureCollection(library, undefined, { preferred: source?.collectionId });
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
  const payload = { url, title, kind, sourceUrl: safeUrl(info.pageUrl || tab?.url) };
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

const onTabActivated = ({ tabId }) => { attempt(async () => refreshTab(await api.tabs.get(tabId), true)); };
const onTabUpdated = (tabId, change, tab) => {
  if (!('url' in change || change.status === 'complete' || 'title' in change || 'favIconUrl' in change)) return;
  attempt(() => refreshTab(tab || { id: tabId }, tab?.active === true));
};
const onWindowFocusChanged = windowId => {
  if (!Number.isInteger(windowId) || windowId < 0) return;
  attempt(async () => refreshTab((await api.tabs.query({ active: true, windowId }))[0], true));
};

function startTabTracking() {
  if (tabTracking) return;
  tabTracking = true;
  api.tabs?.onActivated?.addListener(onTabActivated);
  api.tabs?.onUpdated?.addListener(onTabUpdated);
  api.windows?.onFocusChanged?.addListener(onWindowFocusChanged);
  attempt(refreshActiveTabs);
}

function stopTabTracking() {
  if (!tabTracking) return;
  tabTracking = false;
  api.tabs?.onActivated?.removeListener(onTabActivated);
  api.tabs?.onUpdated?.removeListener(onTabUpdated);
  api.windows?.onFocusChanged?.removeListener(onWindowFocusChanged);
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

export async function captureScreenshot(tab, { persistAttachment = saveAttachment, removeAttachment = deleteAttachment, persistItem = saveItem, limiter = captureRateLimiter } = {}) {
  const sourceUrl = safeUrl(tab?.url, { optional: false });
  if (activeFullPageJob) throw new Error('Wait for the full-page screenshot to finish or cancel it first.');
  visibleScreenshotJobs++;
  try {
    const dataUrl = await limiter(() => api.tabs.captureVisibleTab(tab.windowId, { format: 'png' }), undefined, () => assertCaptureTab(api, tab));
    // captureVisibleTab targets a window, so do not attach a changed tab's pixels to the old page.
    await assertCaptureTab(api, tab);
    const file = pngDataUrlBlob(dataUrl);
    Object.defineProperty(file, 'name', { value: `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png` });
    const attachment = await persistAttachment(file);
    let item;
    try {
      item = await persistItem({ type: 'image', title: `Screenshot of ${tab.title || new URL(sourceUrl).hostname}`, url: '', sourceUrl,
        excerpt: 'Visible page screenshot', content: '', articleContent: '', cover: dataUrl, ...attachment });
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
  if (!tab?.then) safeUrl(tab?.url, { optional: false });
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
      const sourceUrl = safeUrl(tab?.url, { optional: false });
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
  if (alarm.name === SNAPSHOT_ALARM) { await startupGate; await snapshots.daily(); return; }
  if (alarm.name.startsWith('still:threadkeeper:')) { await startupGate; await threadkeeper.handleAlarm(alarm); return; }
  if (!alarm.name.startsWith(REMINDER_PREFIX)) return;
  const id = alarm.name.slice(REMINDER_PREFIX.length);
  // Read storage directly: a seedless loadLibrary() would persist an empty library when none exists yet.
  const state = api?.storage?.local ? (await api.storage.local.get(STORAGE_KEY))[STORAGE_KEY] : libraryCache;
  // A library from a newer build cannot record the notification here, so it would repeat on every start: leave it.
  if (!state || libraryVersion(state) > LIBRARY_SCHEMA_VERSION) return;
  const item = Array.isArray(state.items) ? state.items.find(value => value?.id === id) : null;
  if (!item || item.deletedAt || !item.reminderAt || item.reminderNotifiedAt) return;
  if (new Date(item.reminderAt).getTime() > Date.now() + 1000) return;
  await api.notifications.create(`still:item:${id}`, { type: 'basic', iconUrl: 'icons/icon128.png', title: item.title,
    message: item.excerpt || 'A little reminder from your Still library.', priority: 1 });
  await updateItem(id, { reminderNotifiedAt: new Date().toISOString() });
}

// A periodic alarm keeps its schedule across worker restarts; re-creating it would restart the 24 h countdown.
async function ensureSnapshotAlarm() {
  if (!api?.alarms?.create) return;
  const alarms = (await api.alarms.getAll?.()) || [];
  if (!alarms.some(alarm => alarm?.name === SNAPSHOT_ALARM)) await api.alarms.create(SNAPSHOT_ALARM, { periodInMinutes: 1440 });
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
  // A web page (through the picker content script) may only report the selection it was asked for.
  if (isContentSender(sender)) {
    if (message.type === 'still:picker-result') return handlePickerResult(input, sender);
    throw new Error('Untrusted extension message.');
  }
  if (message.type === 'still:picker-result') throw new Error('Only the page picker reports selections.');
  if (message.type === 'still:store') {
    const result = await handleStoreOperation(input.operation, input.args);
    // A restored backup may hold other chats than Threadkeeper believes Still has: start a new epoch.
    if (input.operation === 'importLibrary') threadkeeper.onDataRestored().catch(warnThreadkeeper);
    return result;
  }
  if (message.type === SNAPSHOT_MESSAGE) {
    const result = await handleSnapshotRequest(input.op, input.args, snapshots);
    if (input.op === 'restore') threadkeeper.onDataRestored().catch(warnThreadkeeper);
    return result;
  }
  if (message.type === THREADKEEPER_MESSAGE) return handleThreadkeeperRequest(input.op, input.args);
  if (CAPTURE_MESSAGES.includes(message.type)) return captureCurrentTab(input);
  if (['captureScreenshot', 'still:capture-screenshot'].includes(message.type)) return captureScreenshot(await targetTab(input));
  if (message.type === 'captureFullPage') return captureFullPage(targetTab(input), { jobId: input.jobId });
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
  if (message.type === 'still:capture-article') return captureArticleRequest(input);
  if (message.type === 'still:start-picker') return startPicker(await targetTab(input), { from: input.from });
  throw new Error('Unknown Still request.');
}

function handleMenuClick(info, tab) {
  if (info.menuItemId === 'still-open-library') { openLibrary().catch(reportError); return; }
  const saveTo = parseSaveToMenuId(info.menuItemId);
  if (saveTo?.choose) { chooseCollection(info, tab, saveTo.kind).catch(reportError); return; }
  // Research lives in the side panel, so it opens even when saves are set to stay quiet.
  if (info.menuItemId === 'still-save-research') { saveAndResearch(tab, info).catch(reportError); return; }
  // The user is about to select on the page: no side panel (it would narrow the page); a notification confirms the save.
  if (info.menuItemId === 'still-select-parts') {
    startPicker({ ...tab, url: tab?.url || info.pageUrl }, { from: 'menu' })
      .then(result => { if (result?.needsPermission) throw new Error('Chrome did not let Still select parts of this page.'); })
      .catch(reportError);
    return;
  }
  // Side panel open is invoked directly inside the user gesture, before capture awaits.
  const quiet = libraryCache?.settings?.openPanelOnSave === false && !['still-screenshot', 'still-screenshot-full'].includes(info.menuItemId);
  const panelOpening = quiet ? Promise.resolve(false) : openSidePanel(tab).catch(reportError);
  if (info.menuItemId === 'still-screenshot') { captureScreenshot(tab).catch(reportError); return; }
  if (info.menuItemId === 'still-screenshot-full') { panelOpening.then(() => captureFullPage(tab)).catch(reportError); return; }
  if (info.menuItemId === 'still-save-article') { captureArticleForMenu(tab, info).catch(reportError); return; }
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
  // Other extensions (only the paired Threadkeeper gets anywhere; see lib/threadkeeper/worker.js). Registered synchronously so
  // a message can wake the worker. The answer is the flat protocol envelope, never { ok, result }.
  api.runtime.onMessageExternal?.addListener((message, sender, sendResponse) => {
    const respond = response => { try { sendResponse(response); } catch { /* Threadkeeper stopped waiting. */ } };
    handleExternalMessage(message, sender).then(respond, () => respond({ ok: false, proto: 'still-threadkeeper/1', error: { code: 'internal', message: 'Still could not handle that message.' } }));
    return true;
  });
  // The assistant's pages open a port to work in browser tabs. Registered synchronously, so a connection wakes the worker.
  api.runtime.onConnect?.addListener(port => { browserHost.connect(port); });
  // Snapshot gate first: nothing below may change data before an update snapshot exists. Bounded, so a stalled
  // IndexedDB can delay the library by at most STARTUP_GATE_MS, never lock it.
  startupGate = Promise.race([snapshots.startup(), new Promise((resolve, reject) => {
    later(() => reject(new Error('the update snapshot is taking too long')), STARTUP_GATE_MS);
  })]).catch(error => { warnSnapshot(error); return null; });
  ensureSnapshotAlarm().catch(warnSnapshot);
  threadkeeper.init().catch(warnThreadkeeper);
  api.runtime.onInstalled.addListener(details => {
    installMenus().then(readLibrary).then(library => installCollectionMenus(library, { force: true })).catch(reportError);
    Promise.resolve(api.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })).catch(reportError);
    // The UI seeds a new library; installing does not overwrite existing captures. An update's previousVersion is added
    // to the snapshot the gate took for it.
    if (details?.reason === 'update' && details.previousVersion) {
      startupGate.then(summary => snapshots.annotate(summary?.id, { previousVersion: details.previousVersion })).catch(warnSnapshot);
    }
    startupGate.then(() => threadkeeper.startup()).catch(warnThreadkeeper);
  });
  api.runtime.onStartup.addListener(() => {
    Promise.resolve(api.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })).catch(reportError);
    restoreReminders().catch(reportError);
    readLibrary().then(library => installCollectionMenus(library)).catch(error => console.warn('Still menus:', error?.message));
    startupGate.then(() => threadkeeper.startup()).catch(warnThreadkeeper);
  });
  api.contextMenus.onClicked.addListener(handleMenuClick);
  api.commands.onCommand.addListener(handleCommand);
  api.alarms.onAlarm.addListener(alarm => { handleAlarm(alarm).catch(reportError); });
  api.notifications.onClicked.addListener(id => {
    if (id.startsWith('still:item:')) openLibrary(id.slice('still:item:'.length)).catch(reportError);
    api.notifications.clear(id);
  });
  api.storage?.onChanged?.addListener((changes, area) => { if (area === 'local' && changes[RECENT_COLLECTIONS_KEY]) scheduleLibraryRefresh(); });
  api.storage?.onChanged?.addListener((changes, area) => { if (area === 'local' && changes[THREADKEEPER_STATE_KEY]) threadkeeper.invalidate(); });
  // Dashboard, AI and other Still keys change outside the library store: they also make the next daily snapshot due.
  api.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some(isSnapshotKey)) snapshots.markDirty().catch(warnSnapshot);
  });
  api.permissions?.onAdded?.addListener(change => { if (change?.permissions?.includes('tabs')) startTabTracking(); });
  api.permissions?.onRemoved?.addListener(change => { if (change?.permissions?.includes('tabs')) stopTabTracking(); });
  subscribe(state => {
    libraryCache = state;
    syncReminders(state).catch(reportError);
    scheduleLibraryRefresh();
  });
  restoreReminders().catch(reportError);
  hasPermission({ permissions: ['tabs'] }).then(granted => { if (granted) startTabTracking(); });
}

export { MENU_ITEMS, MESSAGE_TYPES, STORAGE_KEY, PANEL_DRAFTS_KEY, handleExternalMessage, threadkeeper, browserHost };
