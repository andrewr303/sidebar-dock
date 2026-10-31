// Bookmarks widget: one of your Chrome bookmark folders on the dashboard, as a list, an icon grid, large icons or an
// expandable tree. Subfolders open in place with a path to step back, and large widgets search the whole folder.
// Reading bookmarks needs the optional "bookmarks" permission, asked for from the widget's Allow access button.
//
// The bookmarks stay Chrome's: dragging rearranges them in Chrome, dropping a link bookmarks it there, and edits,
// renames and deletions (with Undo) go straight to Chrome's bookmarks. Any folder can be copied into Still as a
// collection with subcollections ("Import into Still"), and single links saved to Still. The widget follows changes
// made anywhere (chrome.bookmarks events) and keeps a compact copy of the tree in lib/widget-cache.js so a new tab
// draws them at once. Which subfolder is open, the search and the tree's open folders are per widget and per page.
import { html, cx, plural, safeHref } from '../html.js';
import { icon } from '../icons.js';
import { registerActions, registerMount } from '../runtime.js';
import { button, iconButton, input, select, segmented, switchToggle, field, emptyState, spinner } from '../components.js';
import { colorForName } from '../pickers.js';
import { defineWidget, getSettingsDraft } from '../dashboard/registry.js';
import * as dashboardStore from '../../lib/dashboard-store.js';
import { hasPermissions, requestPermissions, onPermissionsChanged } from '../../lib/permissions.js';
import { readCache, writeCache, deleteCache } from '../../lib/widget-cache.js';
import { canonicalUrl } from '../../lib/store.js';
import {
  OPEN_IN_OPTIONS, anchorTarget, copyLink, openMenuItems, openAll, openLinkForm, tidyMenu, stableAnchor, registerLinkGrid, rovingStop, initLinkGrids, refocusTile,
} from './links/shared.js';
import { tileIcon } from './links/favicons.js';
import { hostOf, normalizeLinkUrl } from './links/model.js';
import {
  ROOT_ID, BAR_ID, bookmarkConfig, bookmarkDefaults, indexTree, isFolder, nodeTitle, folderChildren, folderPath, isWithin, folderOptions, filterFolderOptions,
  searchBookmarks, treeRows, allFolderIds, importPlan, moveIndex, dropMove, dropCreate, folderUrls, compactTree, expandTree,
} from './bookmarks/tree.js';

const TYPE = 'bookmarks';
const CACHE_KEY = 'bookmarks';
const SEARCH_LIMIT = 60;
const DENIED = 'Chrome did not allow access to your bookmarks. Try again and choose Allow.';
const VIEWS = [
  { value: 'list', label: 'List', icon: 'layout-list' },
  { value: 'icons', label: 'Icons', icon: 'grid-3x3' },
  { value: 'large', label: 'Large icons', icon: 'grid-2x2' },
  { value: 'tree', label: 'Tree', icon: 'list-tree' },
];
const SORTS = [
  { value: 'manual', label: 'Chrome’s order' },
  { value: 'title', label: 'Title A to Z' },
  { value: 'recent', label: 'Recently added' },
];
const ICON_SIZE = { list: 16, icons: 28, large: 44 };
// Chrome's permanent top folders get their own glyphs in the folder picker.
const ROOT_ICONS = { 1: 'panel-top', 2: 'folder', 3: 'smartphone' };

const inExtension = () => !!globalThis.chrome?.runtime?.id;
const api = () => (typeof globalThis.chrome?.bookmarks?.getTree === 'function' ? globalThis.chrome.bookmarks : null);
const newId = prefix => `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`}`;

/* ------------------------------------------------------------------ session (one tree for every widget on the page) */

const session = { access: null, index: null, live: false, error: '', loading: null, again: false, listening: false, importingChrome: false, timer: 0 };
let lastCtx = null;
let started = false;
let cached = { at: 0, index: null };
const rerender = () => lastCtx?.render?.();

/** The tree to draw: Chrome's live one, else the cached copy from the last visit (null before either exists). */
function currentIndex() {
  if (session.index) return session.index;
  if (session.access === false) return null;
  const entry = readCache(CACHE_KEY);
  if (!Array.isArray(entry?.value) || !entry.value.length) return null;
  if (cached.at !== entry.at) cached = { at: entry.at, index: expandTree(entry.value) };
  return cached.index;
}

/** Reads Chrome's bookmark tree (and the permission) again. Bursts of calls share one read. */
function refresh() {
  if (!inExtension()) return Promise.resolve();
  if (session.loading) { session.again = true; return session.loading; }
  session.loading = (async () => {
    session.access = await hasPermissions('bookmarks');
    if (!session.access) {
      // Access was removed (Chrome's settings, another tab): forget the tree and its copy too.
      session.index = null;
      session.live = false;
      session.error = '';
      if (readCache(CACHE_KEY)) deleteCache(CACHE_KEY);
      return;
    }
    try {
      const bookmarks = api();
      if (!bookmarks) throw new Error('chrome.bookmarks is unavailable');
      session.index = indexTree(await bookmarks.getTree());
      session.live = true;
      session.error = '';
      listen();
      const compact = compactTree(session.index);
      if (JSON.stringify(readCache(CACHE_KEY)?.value) !== JSON.stringify(compact)) writeCache(CACHE_KEY, compact);
    } catch (error) {
      console.warn('[still] bookmarks not read', error?.message || error);
      session.error = 'unreadable';
    }
  })().finally(() => {
    session.loading = null;
    rerender();
    if (session.again) { session.again = false; refresh(); }
  });
  return session.loading;
}

/** Follows bookmark changes made anywhere (this widget, Chrome's manager, sync). Chrome's own imports are read once at the end. */
function listen() {
  const bookmarks = api();
  if (!bookmarks || session.listening) return;
  session.listening = true;
  const changed = () => {
    if (session.importingChrome) return;
    clearTimeout(session.timer);
    session.timer = setTimeout(refresh, 120);
  };
  for (const name of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered']) bookmarks[name]?.addListener?.(changed);
  bookmarks.onImportBegan?.addListener?.(() => { session.importingChrome = true; });
  bookmarks.onImportEnded?.addListener?.(() => { session.importingChrome = false; changed(); });
}

function start(ctx) {
  lastCtx = ctx;
  if (started || typeof document === 'undefined') return;
  started = true;
  initLinkGrids(ctx);
  if (!inExtension()) return;
  refresh();
  onPermissionsChanged(() => refresh());
}

/* ------------------------------------------------------------------ per-widget view state */

const views = new Map();      // widget id -> { root, folderId, query, searchOpen, expanded: Set }
const importing = new Map();  // widget id -> { name, count } while an import runs
const pickerQuery = new Map(); // widget id -> folder picker filter in the settings dialog

function viewOf(widgetId, config) {
  let view = views.get(widgetId);
  if (!view || view.root !== config.folderId) {
    view = { root: config.folderId, folderId: config.folderId, query: '', searchOpen: false, expanded: new Set() };
    views.set(widgetId, view);
  }
  return view;
}

/** Everything an action needs about a widget: { widget, config, view, index } (index may be the cached copy). */
function stateOf(widgetId) {
  const found = dashboardStore.findWidget(widgetId);
  if (!found) return null;
  const config = bookmarkConfig(found.widget.config);
  return { widget: found.widget, config, view: viewOf(widgetId, config), index: currentIndex() };
}

const alwaysSearch = env => env.size === 'l' || env.size === 'xl';
const searchShown = (config, view, env) => config.showSearch && (alwaysSearch(env) || view.searchOpen || !!view.query);
const canEdit = node => !!node && !node.locked && node.id !== ROOT_ID;
/** New bookmarks can go into any folder but managed ones (Chrome's locked top folders take them too). */
const canAddTo = node => isFolder(node) && !node.managed && node.id !== ROOT_ID;

/** Something on screen to anchor a popover for a widget. */
function anchorFor(widgetId, nodeId = '') {
  const id = CSS.escape(widgetId);
  const tile = nodeId ? document.querySelector(`[data-links-grid="bm:${id}"] [data-link-id="${CSS.escape(nodeId)}"]`) : null;
  return tile || document.querySelector(`.w-bookmarks[data-widget="${id}"]`) || document.querySelector(`[data-widget-id="${id}"]`) || document.body;
}

function goTo(widgetId, folderId, { focus = 'first' } = {}) {
  const s = stateOf(widgetId);
  if (!s?.index) return;
  const from = s.view.folderId;
  s.view.folderId = isFolder(s.index.nodes.get(folderId)) && isWithin(s.index, folderId, s.view.root) ? folderId : s.view.root;
  s.view.query = '';
  lastCtx?.render();
  // Going up lands on the folder you came from; going in lands on its first entry (or the back button when empty).
  lastCtx?.nextFrame(() => {
    const grid = document.querySelector(`[data-links-grid="bm:${CSS.escape(widgetId)}"]`);
    const target = focus === 'from' ? grid?.querySelector(`[data-tile-key="${CSS.escape(from)}"]`) : grid?.querySelector('[data-link-tile][tabindex="0"]');
    (target || document.querySelector(`.w-bookmarks[data-widget="${CSS.escape(widgetId)}"] .w-bookmarks-back`))?.focus({ preventScroll: true });
  });
}

/* ------------------------------------------------------------------ writes to Chrome's bookmarks */

/** Runs a chrome.bookmarks call, turning Chrome's technical refusals into a calm message. */
async function chromeCall(fn, failure) {
  try { return await fn(api()); } catch (error) {
    console.warn('[still] bookmark change refused', error?.message || error);
    throw new Error(failure);
  }
}

async function saveToStill(ctx, node) {
  const saved = await ctx.store.saveItem({ type: 'bookmark', url: node.url, ...(node.title.trim() ? { title: node.title.trim() } : {}) });
  ctx.toast(`Saved “${saved.title}” to Inbox`, { tone: 'success', action: { label: 'Open', run: () => ctx.openItem(saved.id) } });
}

function editBookmark(ctx, widgetId, node) {
  openLinkForm(ctx, anchorFor(widgetId, node.id), {
    heading: 'Edit bookmark', url: node.url, title: node.title, submitLabel: 'Save bookmark',
    onSubmit: ({ url, title }) => chromeCall(b => b.update(node.id, { url, title: title || hostOf(url) }), 'Chrome didn’t save that bookmark. Try again.'),
  });
}

async function deleteBookmark(ctx, node) {
  await chromeCall(b => b.remove(node.id), 'Chrome didn’t delete that bookmark. Try again.');
  ctx.toast(`Deleted “${nodeTitle(node)}”`, { action: { label: 'Undo', run: () => chromeCall(b => b.create({ parentId: node.parentId, index: node.index, title: node.title, url: node.url }),
    'Chrome didn’t restore that bookmark.') } });
}

async function renameFolder(ctx, node) {
  const value = await ctx.prompt({ title: 'Rename folder', label: 'Folder name', value: node.title, placeholder: 'Folder name', confirmLabel: 'Rename' });
  const title = value?.trim();
  if (!title || title === node.title) return;
  await chromeCall(b => b.update(node.id, { title }), 'Chrome didn’t rename that folder. Try again.');
}

function addBookmark(ctx, widgetId) {
  const s = stateOf(widgetId);
  const folder = s?.index?.nodes.get(s.view.folderId);
  if (!canAddTo(folder) || !api()) return;
  openLinkForm(ctx, anchorFor(widgetId), {
    heading: `Add a bookmark to ${nodeTitle(folder)}`, submitLabel: 'Add bookmark',
    onSubmit: async ({ url, title }) => {
      await chromeCall(b => b.create({ parentId: folder.id, title: title || hostOf(url), url }), 'Chrome didn’t add that bookmark. Try again.');
      ctx.toast(`Bookmarked “${title || hostOf(url)}” in ${nodeTitle(folder)}`, { tone: 'success' });
    },
  });
}

/** Links dropped on the widget (from a page, the address bar, another widget or Still) become bookmarks at the drop point. */
async function createBookmarks(ctx, widgetId, links, beforeId = '') {
  const s = stateOf(widgetId);
  if (!s?.index || !session.live || !api() || s.view.query) return;
  const where = dropCreate(s.index, s.view.folderId, s.config.sort === 'manual' ? beforeId : '');
  const folder = s.index.nodes.get(where.parentId);
  if (!isFolder(folder)) return;
  if (!canAddTo(folder)) { ctx.toast('This folder is managed by your organization, so it can’t be changed here.'); return; }
  const created = [];
  for (const link of links) {
    const url = normalizeLinkUrl(link.url);
    if (!url) continue;
    const title = String(link.title || '').trim() || hostOf(url);
    const index = where.index == null ? undefined : where.index + created.length;
    created.push(await chromeCall(b => b.create({ parentId: folder.id, ...(index == null ? {} : { index }), title, url }), 'Chrome didn’t add that bookmark. Try again.'));
  }
  if (!created.length) return;
  ctx.toast(created.length > 1 ? `Bookmarked ${plural(created.length, 'link')} in ${nodeTitle(folder)}` : `Bookmarked “${created[0].title}” in ${nodeTitle(folder)}`, {
    tone: 'success', action: { label: 'Undo', run: () => chromeCall(async b => { for (const node of created) await b.remove(node.id); }, 'Chrome didn’t remove those bookmarks.') },
  });
}

const SORTED = 'These bookmarks are sorted by title or date. Choose Chrome’s order in the widget menu to arrange them.';

/** A bookmark dragged within the widget: Chrome moves it (into another folder when dropped among that folder's rows). */
async function moveNode(ctx, widgetId, id, beforeId) {
  const s = stateOf(widgetId);
  const node = s?.index?.nodes.get(id);
  if (!node || s.view.query || !session.live || !api()) return;
  if (!canEdit(node)) { ctx.toast(node.managed ? 'This bookmark is managed by your organization, so it can’t be moved.' : 'Chrome keeps this folder in place.'); return; }
  const target = dropMove(s.index, id, { beforeId, folderId: s.view.folderId });
  if (!target) return;
  const across = target.parentId !== node.parentId;
  if (!across && s.config.sort !== 'manual') { ctx.toast(SORTED); return; }
  await chromeCall(b => b.move(id, across && s.config.sort !== 'manual' ? { parentId: target.parentId } : target), 'Chrome didn’t move that bookmark. Try again.');
  if (across) {
    const parent = s.index.nodes.get(target.parentId);
    ctx.toast(`Moved “${nodeTitle(node)}” to ${nodeTitle(parent)}`, { action: { label: 'Undo', run: () => chromeCall(b => b.move(id, { parentId: node.parentId, index: node.index }),
      'Chrome didn’t move that bookmark back.') } });
  }
}

/** Alt+arrow keys: one step through the folder (a row up or down in a grid). */
async function shiftNode(ctx, widgetId, id, delta) {
  const s = stateOf(widgetId);
  const node = s?.index?.nodes.get(id);
  if (!node || s.view.query || !session.live || !api()) return;
  if (s.config.sort !== 'manual') { ctx.toast(SORTED); return; }
  if (!canEdit(node)) return;
  const at = moveIndex(s.index, node.parentId, id, { delta, showFolders: s.config.showFolders || s.config.view === 'tree' });
  if (at < 0) return;
  await chromeCall(b => b.move(id, { parentId: node.parentId, index: at }), 'Chrome didn’t move that bookmark. Try again.');
}

function openManager(folderId) {
  const tabs = globalThis.chrome?.tabs;
  if (tabs?.create) tabs.create({ url: `chrome://bookmarks/?id=${encodeURIComponent(folderId)}` });
}

/* ------------------------------------------------------------------ import into Still */

/** Copies a folder (and its subfolders) into Still as a collection tree, in one library write. */
async function importFolder(ctx, widgetId, folderId) {
  const s = stateOf(widgetId);
  const index = session.live ? session.index : null;
  const folder = index?.nodes.get(folderId);
  if (!s || !isFolder(folder) || importing.has(widgetId)) return;
  const existing = new Set();
  for (const item of ctx.select.live()) {
    if (!item.url || item.type === 'note') continue;
    try { existing.add(canonicalUrl(item.url)); } catch { /* not a web address */ }
  }
  const plan = importPlan(index, folder.id, { existing, makeId: newId });
  const name = nodeTitle(folder);
  if (!plan.items.length) {
    ctx.toast(plan.skipped ? `Every link in “${name}” is already in Still` : `“${name}” has no links to import`);
    return;
  }
  const subs = plan.collections.length - 1;
  const body = [
    `Still creates the collection “${name}”${subs ? ` with ${plural(subs, 'subcollection')} for its folders` : ''} and saves ${plural(plan.items.length, 'link')} in it.`,
    plan.skipped ? `${plural(plan.skipped, 'link')} already in Still ${plan.skipped === 1 ? 'stays where it is' : 'stay where they are'}.` : '',
    'Your Chrome bookmarks don’t change.',
  ].filter(Boolean).join(' ');
  if (!(await ctx.confirm({ title: `Import “${name}” into Still?`, body, confirmLabel: `Import ${plural(plan.items.length, 'link')}` }))) return;
  importing.set(widgetId, { name, count: plan.items.length });
  ctx.render();
  try {
    const collections = plan.collections.map(collection => ({ ...collection, color: colorForName(collection.name) }));
    await ctx.store.importLibrary({ collections, items: plan.items });
    ctx.toast(`Imported ${plural(plan.items.length, 'link')} into “${name}”`, { tone: 'success', duration: 8000, actions: [
      { label: 'Open', run: () => ctx.navigate(`collection:${plan.rootId}`) },
      { label: 'Undo', run: () => undoImport(ctx, plan) },
    ] });
  } catch (error) {
    console.error(error);
    ctx.toast(`Unable to import “${name}”. Your library is unchanged. Try again.`, { tone: 'danger' });
  } finally {
    importing.delete(widgetId);
    ctx.render();
  }
}

async function undoImport(ctx, plan) {
  const at = new Date().toISOString();
  const live = new Set(ctx.select.live().map(item => item.id));
  const items = plan.items.filter(item => live.has(item.id));
  if (items.length) await ctx.store.bulkUpdateItems(items.map(item => ({ id: item.id, patch: { deletedAt: at } })));
  for (const collection of [...plan.collections].reverse()) {
    if (ctx.select.collection(collection.id)) await ctx.store.deleteCollection(collection.id);
  }
  ctx.toast(`Moved ${plural(items.length, 'imported link')} to Trash`);
}

/* ------------------------------------------------------------------ menus */

function itemMenu(ctx, widgetId, id, anchor) {
  const s = stateOf(widgetId);
  const node = s?.index?.nodes.get(id);
  if (!node) return;
  const title = nodeTitle(node);
  if (isFolder(node)) {
    const urls = folderUrls(s.index, node.id);
    ctx.openMenu(stableAnchor(anchor), tidyMenu([
      { label: 'Open folder', icon: 'folder-open', run: () => goTo(widgetId, node.id) },
      urls.length > 1 && { label: 'Open all in new tabs', icon: 'external-link', hint: urls.length.toLocaleString(), run: () => openAll(ctx, urls, { label: title }) },
      { separator: true },
      node.total > 0 && session.live && { label: 'Import into Still…', icon: 'folder-input', run: () => importFolder(ctx, widgetId, node.id) },
      canEdit(node) && { label: 'Rename…', icon: 'pencil', run: () => renameFolder(ctx, node) },
      globalThis.chrome?.tabs?.create && { label: 'Show in Chrome bookmarks', icon: 'square-arrow-out-up-right', run: () => openManager(node.id) },
    ]), { label: `Options for ${title}` });
    return;
  }
  const saved = ctx.select.savedForUrl(node.url);
  ctx.openMenu(stableAnchor(anchor), tidyMenu([
    ...openMenuItems(ctx, node.url, s.config.openIn),
    { separator: true },
    { label: 'Copy link', icon: 'copy', run: () => copyLink(ctx, node.url) },
    saved ? { label: 'Open in Still', icon: 'panel-right-open', run: () => ctx.openItem(saved.id) }
      : { label: 'Save to Still', icon: 'bookmark-plus', run: () => saveToStill(ctx, node) },
    { separator: true },
    canEdit(node) && { label: 'Edit…', icon: 'pencil', run: () => editBookmark(ctx, widgetId, node) },
    canEdit(node) && { label: 'Delete', icon: 'trash-2', danger: true, run: () => deleteBookmark(ctx, node) },
  ]), { label: `Options for ${title}` });
}

function widgetMenu(ctx, widget) {
  const config = bookmarkConfig(widget.config);
  const set = patch => dashboardStore.updateWidgetConfig(widget.id, patch);
  const display = [
    { separator: true },
    { heading: 'Show as' },
    ...VIEWS.map(view => ({ label: view.label, checked: config.view === view.value, run: () => set({ view: view.value }) })),
    { separator: true },
    { heading: 'Sort' },
    ...SORTS.map(sort => ({ label: sort.label, checked: config.sort === sort.value, run: () => set({ sort: sort.value }) })),
    { separator: true },
    config.view !== 'tree' && { label: 'Show subfolders', checked: config.showFolders, run: () => set({ showFolders: !config.showFolders }) },
  ];
  const s = stateOf(widget.id);
  const folder = session.access !== false ? s?.index?.nodes.get(s.view.folderId) : null;
  if (!isFolder(folder)) return tidyMenu(display);
  const urls = folderUrls(s.index, folder.id);
  const folders = config.view === 'tree' ? allFolderIds(s.index, folder.id) : [];
  return tidyMenu([
    api() && session.live && canAddTo(folder) && { label: 'Add bookmark…', icon: 'plus', run: () => addBookmark(ctx, widget.id) },
    urls.length > 1 && { label: 'Open all in new tabs', icon: 'external-link', hint: urls.length.toLocaleString(), run: () => openAll(ctx, urls, { label: nodeTitle(folder) }) },
    folder.total > 0 && session.live && { label: 'Import this folder into Still…', icon: 'folder-input', run: () => importFolder(ctx, widget.id, folder.id) },
    globalThis.chrome?.tabs?.create && { label: 'Show in Chrome bookmarks', icon: 'square-arrow-out-up-right', run: () => openManager(folder.id) },
    folders.length > 0 && { separator: true },
    folders.length > 0 && (s.view.expanded.size
      ? { label: 'Collapse all folders', icon: 'chevrons-down-up', run: () => { s.view.expanded.clear(); ctx.render(); } }
      : { label: 'Expand all folders', icon: 'chevrons-up-down', run: () => { s.view.expanded = new Set(folders); ctx.render(); } }),
    ...display,
  ]);
}

function openWidgetMenu(ctx, widgetId, point) {
  const found = dashboardStore.findWidget(widgetId);
  if (found) ctx.openMenu(point, widgetMenu(ctx, found.widget), { label: 'Bookmarks options' });
}

/* ------------------------------------------------------------------ render: states */

const stateBox = (key, body) => html`<div class="w-bookmarks is-state" data-key="${key}">${body}</div>`;

function previewState(env) {
  return stateBox('bm-preview', emptyState({ icon: 'bookmark', compact: true, title: 'Your Chrome bookmarks',
    body: env.h > 2 ? 'They appear here when Still runs as a Chrome extension. This preview can’t read them.' : '' }));
}

function accessState(widget, env) {
  return stateBox('bm-access', emptyState({ icon: 'bookmark', compact: true, title: 'Show your Chrome bookmarks',
    body: env.h > 2 || env.w > 3 ? 'Still reads your bookmarks on this computer to show a folder here. Nothing leaves your browser.' : '',
    actions: button({ label: 'Allow access', icon: 'lock-open', variant: 'primary', size: 'sm', action: 'w.bookmarks.allow', data: { widget: widget.id } }) }));
}

function errorState(widget) {
  return stateBox('bm-error', emptyState({ icon: 'triangle-alert', compact: true, tone: 'danger', title: 'Unable to read your bookmarks',
    body: 'Chrome didn’t answer. Try again in a moment.',
    actions: button({ label: 'Try again', icon: 'refresh-cw', size: 'sm', action: 'w.bookmarks.retry', data: { widget: widget.id } }) }));
}

function missingState(widget, env) {
  return stateBox('bm-missing', emptyState({ icon: 'folder', compact: true, title: 'This folder is gone',
    body: env.h > 2 ? 'It was deleted or moved out of your bookmarks. Choose another folder to show.' : '',
    actions: html`${button({ label: 'Choose a folder', icon: 'folder-open', size: 'sm', action: 'dashboard.widget-settings', data: { widget: widget.id } })}
      ${env.h > 2 ? button({ label: 'Show the bookmarks bar', variant: 'ghost', size: 'sm', action: 'w.bookmarks.use-bar', data: { widget: widget.id } }) : ''}` }));
}

function loadingState(config, env) {
  const tiles = config.view === 'icons' || config.view === 'large';
  const n = tiles ? (config.view === 'large' ? 6 : 10) : Math.max(3, Math.min(8, env.h * 2));
  return html`<div class="${cx('w-bookmarks', `is-${config.view}`, 'is-loading')}" data-key="bm-loading" aria-busy="true">
    <span class="sr-only" role="status">Loading your bookmarks</span>
    <ul class="${tiles ? 'w-bookmarks-grid' : 'w-bookmarks-list'}" role="presentation" aria-hidden="true">
      ${Array.from({ length: n }, (_, i) => tiles
        ? html`<li class="w-bookmarks-cell is-skeleton" data-key="s${i}"><span class="w-bookmarks-tile-link"><span class="w-bookmarks-tile skeleton-bone"></span>
            <span class="skeleton-bone w-bookmarks-bone is-label"></span></span></li>`
        : html`<li class="w-bookmarks-row is-skeleton" data-key="s${i}"><span class="w-bookmarks-row-link"><span class="w-bookmarks-row-icon skeleton-bone"></span>
            <span class="w-bookmarks-row-text"><span class="skeleton-bone w-bookmarks-bone"></span></span></span></li>`)}
    </ul>
  </div>`;
}

/* ------------------------------------------------------------------ render: entries */

const countLabel = node => plural(node.total, 'bookmark');

function linkAttrs(node, { config, gridKey, stop }) {
  return html`href="${safeHref(node.url)}" ${anchorTarget(config.openIn)} data-action="w.links.open" data-open-in="${config.openIn}" draggable="true"
    data-link-tile data-tile-key="${node.id}" data-link-id="${node.id}" data-focus-key="${gridKey}:${node.id}" tabindex="${stop === node.id ? '0' : '-1'}"`;
}
function folderAttrs(widget, node, { gridKey, stop }, action = 'w.bookmarks.open-folder') {
  return html`type="button" data-action="${action}" data-widget="${widget.id}" data-id="${node.id}" draggable="${canEdit(node) ? 'true' : 'false'}"
    data-link-tile data-tile-key="${node.id}" data-link-id="${node.id}" data-focus-key="${gridKey}:${node.id}" tabindex="${stop === node.id ? '0' : '-1'}"`;
}
const moreButton = (widget, node, className) => html`<button type="button" class="${className}" tabindex="-1" aria-label="Options for ${nodeTitle(node)}"
  data-action="w.bookmarks.item-menu" data-widget="${widget.id}" data-id="${node.id}">${icon('ellipsis', { size: 14 })}</button>`;

function renderRow(widget, node, ctx2, meta = '') {
  const title = nodeTitle(node);
  if (isFolder(node)) {
    return html`<li class="w-bookmarks-row is-folder" data-key="${node.id}" data-link-cell>
      <button class="w-bookmarks-row-link" ${folderAttrs(widget, node, ctx2)} aria-label="${title}, folder, ${countLabel(node)}">
        <span class="w-bookmarks-row-icon is-folder" aria-hidden="true">${icon('folder', { size: 16 })}</span>
        <span class="w-bookmarks-row-text"><span class="w-bookmarks-row-title">${title}</span></span>
        <span class="w-bookmarks-row-count" aria-hidden="true">${node.total.toLocaleString()}</span>
        ${icon('chevron-right', { size: 14, className: 'w-bookmarks-row-chevron' })}
      </button>${moreButton(widget, node, 'w-bookmarks-row-more')}
    </li>`;
  }
  const host = hostOf(node.url);
  return html`<li class="w-bookmarks-row" data-key="${node.id}" data-link-cell>
    <a class="w-bookmarks-row-link" ${linkAttrs(node, ctx2)} title="${node.url}">
      <span class="w-bookmarks-row-icon">${tileIcon(node.url, { size: ICON_SIZE.list })}</span>
      <span class="w-bookmarks-row-text"><span class="w-bookmarks-row-title">${title}</span>${meta || title !== host ? html`<span class="w-bookmarks-row-meta">${meta || host}</span>` : ''}</span>
    </a>${moreButton(widget, node, 'w-bookmarks-row-more')}
  </li>`;
}

function renderTile(widget, node, ctx2) {
  const title = nodeTitle(node);
  const size = ICON_SIZE[ctx2.config.view] || ICON_SIZE.icons;
  if (isFolder(node)) {
    return html`<li class="w-bookmarks-cell is-folder" data-key="${node.id}" data-link-cell>
      <button class="w-bookmarks-tile-link" ${folderAttrs(widget, node, ctx2)} title="${title}" aria-label="${title}, folder, ${countLabel(node)}">
        <span class="w-bookmarks-tile is-folder" aria-hidden="true">${icon('folder', { size: Math.round(size * 0.86), strokeWidth: 1.5 })}
          <span class="w-bookmarks-tile-count">${node.total > 999 ? '999+' : node.total.toLocaleString()}</span></span>
        <span class="w-bookmarks-label">${title}</span>
      </button>${moreButton(widget, node, 'w-bookmarks-tile-more')}
    </li>`;
  }
  const host = hostOf(node.url);
  return html`<li class="w-bookmarks-cell" data-key="${node.id}" data-link-cell>
    <a class="w-bookmarks-tile-link" ${linkAttrs(node, ctx2)} title="${title === host ? title : `${title} (${host})`}">
      <span class="w-bookmarks-tile">${tileIcon(node.url, { size })}</span>
      <span class="w-bookmarks-label">${title}</span>
    </a>${moreButton(widget, node, 'w-bookmarks-tile-more')}
  </li>`;
}

function renderTreeRow(widget, { node, depth, expanded }, ctx2, position) {
  const title = nodeTitle(node);
  const common = html`aria-level="${depth + 1}" aria-setsize="${position.size}" aria-posinset="${position.at}"`;
  if (isFolder(node)) {
    return html`<li class="w-bookmarks-trow is-folder" role="none" data-key="${node.id}" data-link-cell style="--depth:${depth}">
      <button class="w-bookmarks-trow-link" role="treeitem" ${folderAttrs(widget, node, ctx2, 'w.bookmarks.toggle')} ${common} aria-expanded="${expanded ? 'true' : 'false'}"
        data-parent="${node.parentId}" aria-label="${title}, ${countLabel(node)}">
        <span class="w-bookmarks-twisty" aria-hidden="true">${icon('chevron-right', { size: 14 })}</span>
        <span class="w-bookmarks-trow-icon is-folder" aria-hidden="true">${icon(expanded ? 'folder-open' : 'folder', { size: 16 })}</span>
        <span class="w-bookmarks-trow-title">${title}</span>
        <span class="w-bookmarks-row-count" aria-hidden="true">${node.total.toLocaleString()}</span>
      </button>
    </li>`;
  }
  const host = hostOf(node.url);
  return html`<li class="w-bookmarks-trow" role="none" data-key="${node.id}" data-link-cell style="--depth:${depth}">
    <a class="w-bookmarks-trow-link" role="treeitem" ${linkAttrs(node, ctx2)} ${common} data-parent="${node.parentId}" title="${node.url}">
      <span class="w-bookmarks-twisty" aria-hidden="true"></span>
      <span class="w-bookmarks-trow-icon">${tileIcon(node.url, { size: 14 })}</span>
      <span class="w-bookmarks-trow-title">${title}</span>
      ${title !== host ? html`<span class="w-bookmarks-trow-meta">${host}</span>` : ''}
    </a>
  </li>`;
}

/** aria-setsize / aria-posinset for the flat tree: each row's position among its visible siblings. */
function treePositions(rows) {
  const groups = new Map();
  for (const row of rows) groups.set(row.node.parentId, (groups.get(row.node.parentId) || 0) + 1);
  const seen = new Map();
  return rows.map(row => {
    const at = (seen.get(row.node.parentId) || 0) + 1;
    seen.set(row.node.parentId, at);
    return { at, size: groups.get(row.node.parentId) };
  });
}

/* ------------------------------------------------------------------ render: widget */

function toolbar(widget, s, env, folder) {
  const { view, config, index } = s;
  const nested = view.folderId !== view.root;
  const search = searchShown(config, view, env);
  if (!nested && !search) return '';
  const crumbs = nested ? folderPath(index, view.folderId).slice(Math.max(0, folderPath(index, view.root).length - 1)) : [];
  const parent = index.nodes.get(folder.parentId);
  return html`<div class="${cx('w-bookmarks-bar', nested && 'is-nested', search && 'has-search')}" data-key="bar">
    ${nested ? html`<div class="w-bookmarks-path">
      ${iconButton({ icon: 'arrow-left', label: `Back to ${nodeTitle(parent)}`, size: 'sm', action: 'w.bookmarks.up', data: { widget: widget.id }, className: 'w-bookmarks-back' })}
      <nav class="w-bookmarks-crumbs" aria-label="Folder path"><ol>
        ${crumbs.map((crumb, i) => i === crumbs.length - 1
          ? html`<li data-key="c-${crumb.id}"><span class="w-bookmarks-crumb is-current" aria-current="location" title="${crumb.title}">${crumb.title}</span></li>`
          : html`<li data-key="c-${crumb.id}"><button type="button" class="w-bookmarks-crumb" data-action="w.bookmarks.go" data-widget="${widget.id}" data-id="${crumb.id}"
              title="${crumb.title}">${crumb.title}</button>${icon('chevron-right', { size: 12, className: 'w-bookmarks-crumb-sep' })}</li>`)}
      </ol></nav>
    </div>` : ''}
    ${search ? html`<div class="w-bookmarks-search" role="search">
      ${input({ id: `bm-q-${widget.id}`, type: 'search', icon: 'search', value: view.query, size: 'sm', placeholder: `Search ${nodeTitle(index.nodes.get(view.root))}`,
        label: 'Search bookmarks', action: 'w.bookmarks.search', keydown: 'w.bookmarks.search-key', attrs: { 'data-widget': widget.id, enterkeyhint: 'go' } })}
    </div>` : ''}
  </div>`;
}

function renderResults(widget, s, ctx2) {
  const hits = searchBookmarks(s.index, s.view.root, s.view.query, { limit: SEARCH_LIMIT });
  const status = html`<p class="sr-only" role="status">${hits.length ? `${hits.length >= SEARCH_LIMIT ? `${SEARCH_LIMIT}+` : hits.length} ${hits.length === 1 ? 'result' : 'results'}` : 'No results'}</p>`;
  if (!hits.length) {
    return html`${status}<div class="w-bookmarks-empty" data-key="no-results">${emptyState({ icon: 'search', compact: true, title: `No bookmarks match “${s.view.query.trim()}”`,
      body: 'Try another word from the title or address.',
      actions: button({ label: 'Clear search', size: 'sm', variant: 'ghost', action: 'w.bookmarks.clear', data: { widget: widget.id } }) })}</div>`;
  }
  const keys = hits.map(hit => hit.node.id);
  const stop = rovingStop(ctx2.gridKey, keys);
  const showFolder = hits.some(hit => hit.node.parentId !== s.view.root);
  return html`${status}<ul class="w-bookmarks-list is-results" role="list" aria-label="Search results" data-key="results"
    data-links-grid="${ctx2.gridKey}" data-links-kind="bookmarks" data-links-axis="y" data-widget="${widget.id}" data-keydown="w.links.grid-key">
    ${hits.map(hit => renderRow(widget, hit.node, { ...ctx2, stop }, showFolder ? `${hit.folderTitle} · ${hostOf(hit.node.url)}` : ''))}
  </ul>`;
}

function renderEntries(widget, s, ctx2, folder) {
  const { config, view, index } = s;
  const gridAttrs = kind => html`data-links-grid="${ctx2.gridKey}" data-links-kind="bookmarks" data-widget="${widget.id}" ${kind === 'grid' ? '' : html`data-links-axis="y"`}`;
  if (config.view === 'tree') {
    const rows = treeRows(index, view.folderId, view.expanded, { sort: config.sort });
    if (!rows.length) return emptyFolder(widget, folder, ctx2);
    const stop = rovingStop(ctx2.gridKey, rows.map(row => row.node.id));
    const positions = treePositions(rows);
    return html`<ul class="w-bookmarks-tree" role="tree" aria-label="Bookmarks in ${nodeTitle(folder)}" data-key="tree" ${gridAttrs('list')} data-keydown="w.bookmarks.tree-key">
      ${rows.map((row, i) => renderTreeRow(widget, row, { ...ctx2, stop }, positions[i]))}
    </ul>`;
  }
  const nodes = folderChildren(index, view.folderId, { sort: config.sort, showFolders: config.showFolders });
  if (!nodes.length) return emptyFolder(widget, folder, ctx2);
  const stop = rovingStop(ctx2.gridKey, nodes.map(node => node.id));
  const list = config.view === 'list';
  return html`<ul class="${list ? 'w-bookmarks-list' : 'w-bookmarks-grid'}" role="list" aria-label="Bookmarks in ${nodeTitle(folder)}" data-key="${config.view}"
    ${gridAttrs(list ? 'list' : 'grid')} data-keydown="w.links.grid-key">
    ${nodes.map(node => (list ? renderRow(widget, node, { ...ctx2, stop }) : renderTile(widget, node, { ...ctx2, stop })))}
  </ul>`;
}

function emptyFolder(widget, folder, ctx2) {
  const hidden = !ctx2.config.showFolders && ctx2.config.view !== 'tree' && folder.children.some(id => isFolder(ctx2.index.nodes.get(id)));
  // The empty state is itself a drop target, so a link can be dropped in to start the folder.
  return html`<div class="w-bookmarks-empty" data-key="empty" data-links-grid="${ctx2.gridKey}" data-links-kind="bookmarks" data-widget="${widget.id}">
    ${emptyState({ icon: hidden ? 'folder-closed' : 'bookmark-plus', compact: true,
      title: hidden ? `${nodeTitle(folder)} only has subfolders` : `No bookmarks in ${nodeTitle(folder)}`,
      body: ctx2.env.h > 2 ? (hidden ? 'Subfolders are hidden in this widget.' : 'Drop a link here to bookmark it, or add one.') : '',
      actions: hidden ? button({ label: 'Show subfolders', size: 'sm', action: 'w.bookmarks.show-folders', data: { widget: widget.id } })
        : api() && canAddTo(folder) ? button({ label: 'Add bookmark', icon: 'plus', size: 'sm', action: 'w.bookmarks.add', data: { widget: widget.id } }) : '' })}
  </div>`;
}

function render(ctx, widget, env) {
  start(ctx);
  const config = bookmarkConfig(widget.config);
  if (!inExtension()) return previewState(env);
  if (session.access === false) return accessState(widget, env);
  const index = currentIndex();
  if (!index) return session.error ? errorState(widget) : loadingState(config, env);
  const root = index.nodes.get(config.folderId);
  // The cached copy may be cut short: wait for the live tree before calling a folder gone.
  if (!isFolder(root)) return session.live ? missingState(widget, env) : loadingState(config, env);
  const view = viewOf(widget.id, config);
  if (!isFolder(index.nodes.get(view.folderId)) || !isWithin(index, view.folderId, root.id)) view.folderId = root.id;
  const folder = index.nodes.get(view.folderId);
  const s = { widget, config, view, index };
  const ctx2 = { config, index, env, gridKey: `bm:${widget.id}`, stop: '' };
  const job = importing.get(widget.id);
  return html`<div class="${cx('w-bookmarks', `is-${config.view}`)}" data-key="bm-${widget.id}" data-widget="${widget.id}" data-link-icons>
    ${toolbar(widget, s, env, folder)}
    <div class="w-bookmarks-scroll" data-key="scroll" data-links-menu="bookmarks" data-widget="${widget.id}">
      ${view.query.trim() ? renderResults(widget, s, ctx2) : renderEntries(widget, s, ctx2, folder)}
    </div>
    ${job ? html`<div class="w-bookmarks-progress" role="status" data-key="progress">${spinner({ size: 14 })}<span>Importing ${plural(job.count, 'link')} into Still…</span></div>` : ''}
  </div>`;
}

function headerActions(_ctx, widget, env) {
  const config = bookmarkConfig(widget.config);
  // Two-column widgets keep their title readable; search starts at three columns.
  if (!config.showSearch || alwaysSearch(env) || env.w <= 2 || !inExtension() || session.access === false || !currentIndex()) return '';
  const view = viewOf(widget.id, config);
  const open = view.searchOpen || !!view.query;
  return iconButton({ icon: 'search', label: open ? 'Close search' : 'Search bookmarks', size: 'sm', action: 'w.bookmarks.search-toggle', data: { widget: widget.id }, pressed: open });
}

/* ------------------------------------------------------------------ settings */

function folderPicker(widget, draft, index, error) {
  const config = bookmarkConfig(draft);
  const query = pickerQuery.get(widget.id) || '';
  const options = filterFolderOptions(folderOptions(index), query);
  const id = `bm-folders-${widget.id}`;
  const selected = options.some(option => option.id === config.folderId);
  return html`<div class="w-bookmarks-picker" data-key="picker">
    ${input({ id: `${id}-q`, type: 'search', icon: 'search', value: query, size: 'sm', placeholder: 'Find a folder', label: 'Find a folder', action: 'w.bookmarks.folder-query',
      attrs: { 'data-widget': widget.id } })}
    <div class="w-bookmarks-picker-list" role="radiogroup" aria-labelledby="${id}-label" ${error ? html`aria-invalid="true" aria-describedby="${id}-error" tabindex="-1"` : ''}
      data-keydown="w.bookmarks.picker-key" data-key="picker-list">
      ${options.length ? options.map((option, i) => {
        const checked = option.id === config.folderId;
        return html`<button type="button" role="radio" class="${cx('w-bookmarks-option', checked && 'is-selected')}" aria-checked="${checked ? 'true' : 'false'}"
          tabindex="${checked || (!selected && i === 0) ? '0' : '-1'}" data-action="dashboard.draft-set" data-name="folderId" data-value="${option.id}"
          data-key="o-${option.id}" style="--depth:${Math.min(option.depth, 8)}">
          ${icon(option.depth === 0 ? ROOT_ICONS[option.id] || 'folder' : 'folder', { size: 16, className: 'w-bookmarks-option-icon' })}
          <span class="w-bookmarks-option-title">${option.title}</span>
          <span class="w-bookmarks-option-count" aria-label="${countLabel(option)}">${option.total.toLocaleString()}</span>
          <span class="w-bookmarks-option-check" aria-hidden="true">${checked ? icon('check', { size: 14 }) : ''}</span>
        </button>`;
      }) : html`<p class="w-bookmarks-picker-empty">No folders match “${query}”.</p>`}
    </div>
    <span data-mount="w.bookmarks.picker-scroll" data-morph="skip" data-key="picker-scroll" hidden></span>
  </div>`;
}

function renderSettings(_ctx, widget, draft, env) {
  const config = bookmarkConfig(draft);
  const id = `bm-${widget.id}`;
  const index = session.live ? session.index : currentIndex();
  const error = env.errors?.folderId;
  let folders;
  if (!inExtension()) folders = html`<p class="w-bookmarks-settings-note">Your Chrome bookmark folders appear here when Still runs as a Chrome extension.</p>`;
  else if (session.access === false) {
    folders = html`<div class="w-bookmarks-settings-access" role="status">
      <p>Allow Still to read your bookmarks to choose a folder.</p>
      ${button({ label: 'Allow access', icon: 'lock-open', size: 'sm', action: 'w.bookmarks.allow', data: { widget: widget.id } })}
    </div>`;
  } else if (!index) folders = html`<p class="w-bookmarks-settings-note" role="status">${session.error ? 'Chrome didn’t share your bookmark folders. Close this dialog and try again.' : 'Loading your folders…'}</p>`;
  else folders = folderPicker(widget, draft, index, error);
  return html`<div class="w-bookmarks-settings" data-key="bm-settings-${widget.id}">
    <div class="field ${error ? 'has-error' : ''}">
      <span class="field-label" id="bm-folders-${widget.id}-label">Folder</span>
      <div class="field-control">${folders}</div>
      ${error ? html`<p class="field-error" role="alert" id="bm-folders-${widget.id}-error">${icon('circle-alert', { size: 14 })}<span>${error}</span></p>`
        : html`<p class="field-hint">The number beside each folder counts every bookmark inside it.</p>`}
    </div>
    ${field({ label: 'Show as', control: segmented({ name: 'view', value: config.view, options: VIEWS, action: 'dashboard.draft-set', ariaLabel: 'Show as' }),
      hint: config.view === 'tree' ? 'Subfolders open in place, like a file browser.' : config.view === 'list' ? 'One bookmark per row, with its address.' : 'Site icons with their names.' })}
    <div class="w-bookmarks-settings-row">
      ${field({ label: 'Sort', id: `${id}-sort`, control: select({ id: `${id}-sort`, name: 'sort', value: config.sort, options: SORTS, action: 'dashboard.draft', className: 'is-block' }) })}
      ${field({ label: 'Open links in', id: `${id}-open`, control: select({ id: `${id}-open`, name: 'openIn', value: config.openIn, options: OPEN_IN_OPTIONS, action: 'dashboard.draft', className: 'is-block' }) })}
    </div>
    <div class="w-bookmarks-settings-switches">
      ${switchToggle({ checked: config.showFolders, label: 'Show subfolders', description: 'Open them in place, with a path back. The tree view always shows them.',
        action: 'dashboard.draft', data: { name: 'showFolders', type: 'boolean' } })}
      ${switchToggle({ checked: config.showSearch, label: 'Show a search field', description: 'Always on large widgets; smaller ones get a search button in the title bar.',
        action: 'dashboard.draft', data: { name: 'showSearch', type: 'boolean' } })}
    </div>
  </div>`;
}

function validateSettings(draft) {
  if (!session.live || !session.index) return null;
  return isFolder(session.index.nodes.get(bookmarkConfig(draft).folderId)) ? null : { folderId: 'Choose a folder to show.' };
}

function onSettingsSave(_ctx, widget, draft) {
  pickerQuery.delete(widget.id);
  return bookmarkConfig(draft);
}

/* ------------------------------------------------------------------ definition and wiring */

/** Asks Chrome for the bookmarks permission. Call from a click: the prompt needs the gesture. */
function allowAccess(ctx) {
  const asked = requestPermissions('bookmarks'); // during the gesture
  return asked.then(granted => {
    if (!granted) { ctx.toast(DENIED, { tone: 'danger' }); return undefined; }
    session.access = true;
    return refresh().then(() => getSettingsDraft()?.render());
  });
}

registerLinkGrid('bookmarks', {
  menu: (ctx, grid, id, anchor) => itemMenu(ctx, grid.dataset.widget, id, anchor),
  reorder: (ctx, grid, id, beforeId) => moveNode(ctx, grid.dataset.widget, id, beforeId),
  shift: (ctx, grid, id, delta) => shiftNode(ctx, grid.dataset.widget, id, delta),
  dropLinks: (ctx, grid, links, beforeId) => createBookmarks(ctx, grid.dataset.widget, links, beforeId),
  dropItems: (ctx, grid, ids, beforeId) => createBookmarks(ctx, grid.dataset.widget,
    ids.map(id => ctx.select.byId(id)).filter(item => item && !item.deletedAt && /^https?:/i.test(item.url || '')).map(item => ({ url: item.url, title: item.title })), beforeId),
  widgetMenu: (ctx, widgetId, point) => openWidgetMenu(ctx, widgetId, point),
});

// Scrolls the chosen folder into view when the settings dialog opens.
registerMount('w.bookmarks.picker-scroll', el => {
  requestAnimationFrame(() => el.parentElement?.querySelector('.w-bookmarks-option[aria-checked="true"]')?.scrollIntoView({ block: 'nearest' }));
  return null;
});

const treeItems = grid => [...grid.querySelectorAll('[role="treeitem"]')];

registerActions({
  'w.bookmarks.allow': ({ ctx }) => allowAccess(ctx),
  'w.bookmarks.retry': () => refresh(),
  'w.bookmarks.use-bar': ({ data }) => dashboardStore.updateWidgetConfig(data.widget, { folderId: BAR_ID }),
  'w.bookmarks.show-folders': ({ data }) => dashboardStore.updateWidgetConfig(data.widget, { showFolders: true }),
  'w.bookmarks.add': ({ ctx, data }) => addBookmark(ctx, data.widget),
  'w.bookmarks.open-folder': ({ data }) => goTo(data.widget, data.id),
  'w.bookmarks.go': ({ data }) => goTo(data.widget, data.id, { focus: 'from' }),
  'w.bookmarks.up': ({ data }) => {
    const s = stateOf(data.widget);
    const folder = s?.index?.nodes.get(s.view.folderId);
    if (folder && s.view.folderId !== s.view.root) goTo(data.widget, folder.parentId, { focus: 'from' });
  },
  'w.bookmarks.item-menu': ({ el, ctx, data }) => itemMenu(ctx, data.widget, data.id, el),
  'w.bookmarks.toggle': ({ ctx, data }) => {
    const s = stateOf(data.widget);
    if (!s) return;
    if (s.view.expanded.has(data.id)) s.view.expanded.delete(data.id); else s.view.expanded.add(data.id);
    ctx.render();
    refocusTile(ctx, `bm:${data.widget}`, data.id);
  },
  'w.bookmarks.tree-key': ({ el: grid, event, ctx }) => {
    const item = event.target.closest?.('[role="treeitem"]');
    if (!item || !grid.contains(item)) return;
    const widgetId = grid.dataset.widget;
    const id = item.dataset.linkId;
    const s = stateOf(widgetId);
    if (!s) return;
    const items = treeItems(grid);
    const at = items.indexOf(item);
    const rtl = getComputedStyle(grid).direction === 'rtl';
    const key = rtl && event.key === 'ArrowLeft' ? 'ArrowRight' : rtl && event.key === 'ArrowRight' ? 'ArrowLeft' : event.key;
    const folder = item.getAttribute('aria-expanded') !== null;
    const open = item.getAttribute('aria-expanded') === 'true';
    const focus = el => { if (el) { event.preventDefault(); el.focus(); } };
    if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey)) { event.preventDefault(); itemMenu(ctx, widgetId, id, item); return; }
    if (event.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      event.preventDefault();
      refocusTile(ctx, `bm:${widgetId}`, id);
      ctx.run(() => shiftNode(ctx, widgetId, id, key === 'ArrowUp' ? -1 : 1));
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (key === 'ArrowDown') focus(items[at + 1]);
    else if (key === 'ArrowUp') focus(items[at - 1]);
    else if (key === 'Home') focus(items[0]);
    else if (key === 'End') focus(items.at(-1));
    else if (key === 'ArrowRight' && folder) {
      event.preventDefault();
      if (!open) { s.view.expanded.add(id); ctx.render(); refocusTile(ctx, `bm:${widgetId}`, id); } else if (items[at + 1]?.dataset.parent === id) items[at + 1].focus();
    } else if (key === 'ArrowLeft') {
      if (folder && open) { event.preventDefault(); s.view.expanded.delete(id); ctx.render(); refocusTile(ctx, `bm:${widgetId}`, id); return; }
      focus(items.find(el => el.dataset.linkId === item.dataset.parent));
    }
  },
  'w.bookmarks.search': ({ el, ctx, data }) => {
    const s = stateOf(data.widget);
    if (!s) return;
    s.view.query = el.value;
    ctx.render();
  },
  'w.bookmarks.search-key': ({ el, event, ctx, data }) => {
    const s = stateOf(data.widget);
    if (!s) return;
    const grid = () => document.querySelector(`[data-links-grid="bm:${CSS.escape(data.widget)}"]`);
    if (event.key === 'Escape' && (s.view.query || s.view.searchOpen)) {
      event.preventDefault();
      event.stopPropagation();
      if (s.view.query) { s.view.query = ''; el.value = ''; } else s.view.searchOpen = false;
      ctx.render();
      if (!s.view.searchOpen && !s.view.query) ctx.nextFrame(() => document.querySelector(`[data-widget-id="${CSS.escape(data.widget)}"] [data-action="w.bookmarks.search-toggle"]`)?.focus());
    } else if (event.key === 'ArrowDown') {
      const first = grid()?.querySelector('[data-link-tile]');
      if (first) { event.preventDefault(); first.focus(); }
    } else if (event.key === 'Enter' && s.view.query.trim() && !event.isComposing) {
      // Enter opens the best match the way the widget opens links.
      const first = grid()?.querySelector('a[data-link-tile]');
      if (first) { event.preventDefault(); first.click(); }
    }
  },
  'w.bookmarks.clear': ({ ctx, data }) => {
    const s = stateOf(data.widget);
    if (!s) return;
    s.view.query = '';
    ctx.render();
    ctx.nextFrame(() => document.getElementById(`bm-q-${data.widget}`)?.focus());
  },
  'w.bookmarks.search-toggle': ({ ctx, data }) => {
    const s = stateOf(data.widget);
    if (!s) return;
    const open = s.view.searchOpen || !!s.view.query;
    s.view.searchOpen = !open;
    if (open) s.view.query = '';
    ctx.render();
    if (!open) ctx.nextFrame(() => document.getElementById(`bm-q-${data.widget}`)?.focus());
  },
  'w.bookmarks.folder-query': ({ el, data }) => {
    pickerQuery.set(data.widget, el.value);
    getSettingsDraft()?.render();
  },
  'w.bookmarks.picker-key': ({ el: list, event }) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = [...list.querySelectorAll('[role="radio"]')];
    const at = options.indexOf(event.target.closest?.('[role="radio"]'));
    if (at < 0) return;
    event.preventDefault();
    const next = options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : Math.max(0, Math.min(options.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (!next || next === options[at]) return;
    getSettingsDraft()?.set({ folderId: next.dataset.value });
    requestAnimationFrame(() => list.querySelector(`[data-value="${CSS.escape(next.dataset.value)}"]`)?.focus());
  },
});

defineWidget({
  type: TYPE,
  title: 'Bookmarks',
  description: 'A Chrome bookmark folder as a list, icons or a tree. Search it, open subfolders in place or import it into Still.',
  icon: 'bookmark',
  category: 'web',
  keywords: ['bookmarks', 'chrome', 'favorites', 'folder', 'links', 'bookmarks bar', 'tree', 'import'],
  size: { w: 3, h: 4, minW: 2, minH: 2, maxW: 12, maxH: 12 },
  presets: { S: { w: 3, h: 3 }, M: { w: 4, h: 4 }, L: { w: 6, h: 5 }, XL: { w: 8, h: 6 } },
  permissions: { permissions: ['bookmarks'] },
  preview: 'Your bookmarks bar',
  displayTitle: (_ctx, widget) => {
    const node = currentIndex()?.nodes.get(bookmarkConfig(widget.config).folderId);
    return isFolder(node) ? nodeTitle(node) : '';
  },
  defaults: bookmarkDefaults,
  init: ctx => start(ctx),
  render,
  headerActions,
  menu: (ctx, widget) => widgetMenu(ctx, widget),
  renderSettings,
  validateSettings,
  onSettingsSave,
  settingsSize: 'md',
});
