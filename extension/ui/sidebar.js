// Library navigation: the full-tab sidebar (Dashboard and AI Assistant, views, collection tree, filters, tags, footer)
// and the side panel's Library root. Collection rows carry a hover + (save the current tab in the side panel, Add dialog
// in the full tab) and a … menu; the tree follows the ARIA tree pattern with a roving tabindex. In the side panel the
// full-screen rows hand off: AI Assistant switches to the Ask tab, Dashboard and Sticky notes open in a tab.
import { html, cx, raw, plural } from './html.js';
import { icon, COLLECTION_COLORS } from './icons.js';
import { iconButton, collectionIcon } from './components.js';
import { registerActions } from './runtime.js';
import { openAdd } from './quick-add.js';
import { askAi } from './ai-panel.js';
import { openSettings } from './settings.js';
import { openCollectionEditor, visibleTree, deleteCollectionFlow, collectionSubset, revealInGrid, setCollectionPinned } from './collections.js';
import { initDnd } from './dnd.js';
import { exportBookmarkHtml } from '../lib/portability.js';
import { threadkeeperSnapshot, isPaired } from './chats.js';

const TOP = [
  { view: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', opensTab: true },
  { view: 'assistant', label: 'AI Assistant', icon: 'sparkles' },
  { view: 'all', label: 'All items', icon: 'book-open-text', count: c => c.all },
  { view: 'inbox', label: 'Inbox', icon: 'inbox', count: c => c.inbox, drop: '' },
  { view: 'favorites', label: 'Favorites', icon: 'star', count: c => c.favorites, filter: 'favorite' },
];
// Optional filters only appear when they have something to show.
const FILTERS = [
  { view: 'notes', label: 'Notes', icon: 'sticky-note', count: c => c.notes, always: true },
  // AI chats from Threadkeeper: shown while there are any, and while Threadkeeper is connected (so the empty view is reachable).
  { view: 'chats', label: 'Chats', icon: 'messages-square', count: c => c.byType.chat, show: c => c.threadkeeperPaired },
  { view: 'stickies', label: 'Sticky notes', icon: 'sticker', count: c => c.stickies || null, always: true, opensTab: true },
  // Tasks is a full-tab screen (notes.js renderTasks); the side panel's Library drill-down only lists items.
  { view: 'tasks', label: 'Tasks', icon: 'list-checks', count: c => c.tasksOpen, fullOnly: true },
  { view: 'highlights', label: 'Highlights', icon: 'highlighter', count: c => c.highlights },
  { view: 'reminders', label: 'Reminders', icon: 'bell', count: c => c.reminders },
  { view: 'type:article', label: 'Articles', icon: 'newspaper', count: c => c.byType.article },
  { view: 'type:image', label: 'Images', icon: 'image', count: c => c.byType.image },
  { view: 'type:video', label: 'Videos', icon: 'film', count: c => c.byType.video },
  { view: 'type:file', label: 'Files', icon: 'file-text', count: c => c.byType.file },
  { view: 'duplicates', label: 'Duplicates', icon: 'copy', count: c => c.duplicates },
  { view: 'untagged', label: 'Untagged', icon: 'tag', count: c => c.untagged },
  { view: 'map', label: 'Knowledge map', icon: 'waypoints', always: true },
];
const END = [
  { view: 'archive', label: 'Archive', icon: 'archive', count: c => c.archive, filter: 'archive' },
  { view: 'trash', label: 'Trash', icon: 'trash-2', count: c => c.trash, filter: 'trash' },
];
const TAG_LIMIT = 10;

let treeFocusId = '';
let pinFocusId = '';
let revealedView = '';
let tabsGranted = null;
let tabsDeclined = false;
let typed = { text: '', at: 0 };

const ui = ctx => (ctx.state.sidebar ||= { renamingId: '', allTags: false });
const fmt = n => Number(n || 0).toLocaleString();
const isOpen = (ctx, section) => !ctx.prefs.get('collapsedSections', []).includes(section);
// Rows are real links so Cmd/Ctrl/middle-click open a view in a tab; index.html always names the view (the new tab
// page and a bare index.html open the start page instead).
const viewHref = view => `index.html?libraryView=${encodeURIComponent(view)}`;
const modified = event => !!event && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0);
// Closing the overlay drawer makes it inert, which would drop focus on the page body: move it to the new view instead.
const closeNav = ctx => {
  if (!ctx.state.shell?.navOpen) return;
  ctx.state.shell.navOpen = false;
  ctx.nextFrame(() => document.getElementById('main')?.focus({ preventScroll: true }));
};
const parentKey = row => (row.depth > 0 ? row.parentId || '' : '');
// Sticky notes are notes with a sticky field; counted once per library snapshot.
let stickyMemo = { library: null, count: 0 };
function navCounts(ctx) {
  if (stickyMemo.library !== ctx.library) {
    stickyMemo = { library: ctx.library, count: ctx.select.live().reduce((n, item) => n + (item.type === 'note' && item.sticky ? 1 : 0), 0) };
  }
  return { ...ctx.select.counts(), stickies: stickyMemo.count, threadkeeperPaired: isPaired(threadkeeperSnapshot()) };
}

/**
 * Navigates to a main view from the sidebar, the side panel Library root or the palette. In the side panel, Notes is
 * its own tab (not a Library drill-down) and All items needs a stack entry, since an empty stack shows the Library root.
 */
export function goToView(ctx, view, { keep = false } = {}) {
  closeNav(ctx);
  if (ctx.env.isSidepanel && view === 'notes') {
    ctx.state.panel = null;
    ctx.state.sideTab = 'notes';
    ctx.render();
    return;
  }
  ctx.navigate(view, { keep });
  if (ctx.env.isSidepanel && view === 'all') { ctx.state.sideStack = ['all']; ctx.render(); }
}

/** The Still mark (same shape as the boot mark): a bookmark ribbon cut from a rounded square. Colors follow the theme. */
export function brandMark({ size = 22, className } = {}) {
  return html`<span class="${cx('brand-mark', className)}" style="--size:${size}px" aria-hidden="true"><svg viewBox="0 0 16 16"
    fill="currentColor"><path d="M5 3h6v10l-3-2.8L5 13z"/></svg></span>`;
}

function navRow(ctx, { view, label, icon: ico, count, drop, filter, opensTab }, counts, surface) {
  const current = surface === 'full' && ctx.state.view === view;
  const n = count ? count(counts) : null;
  const leavesPanel = opensTab && surface === 'side';
  return html`<a class="${cx('tree-row', 'nav-row', current && 'is-current')}" href="${viewHref(view)}" data-action="sidebar.navigate" data-view="${view}"
    ${current ? raw('aria-current="page"') : ''} ${drop != null ? html`data-drop-collection="${drop}"` : ''} ${filter ? html`data-drop-filter="${filter}"` : ''}>
    <span class="tree-chev is-leaf" aria-hidden="true"></span>${icon(ico, { size: 18, className: 'nav-icon' })}<span class="tree-name">${label}</span>
    ${n != null ? html`<span class="tree-count">${fmt(n)}</span>` : ''}
    ${leavesPanel ? html`${icon('arrow-up-right', { size: 14, className: 'nav-row-out' })}<span class="sr-only">(opens in a tab)</span>` : ''}</a>`;
}

function heading(ctx, section, label, { actions = '', count, attrs = '' } = {}) {
  const open = isOpen(ctx, section);
  return html`<div class="nav-heading" ${attrs}>
    <button type="button" class="heading-toggle" aria-expanded="${open ? 'true' : 'false'}" aria-controls="nav-${section}"
      data-action="sidebar.toggle-section" data-section="${section}"><span>${label}</span>${icon('chevron-down', { size: 12, className: 'heading-chev' })}</button>
    ${count != null ? html`<span class="tree-count nav-heading-count">${fmt(count)}</span>` : ''}${actions}</div>`;
}

function revealCurrent(ctx) {
  const view = ctx.state.view;
  if (view === revealedView) return;
  revealedView = view;
  if (!view.startsWith('collection:')) return;
  const ancestors = ctx.select.path(view.slice(11)).slice(0, -1).map(c => c.id);
  const expanded = new Set(ctx.prefs.get('expandedCollections', []));
  if (ancestors.every(id => expanded.has(id))) return;
  ctx.prefs.set('expandedCollections', [...new Set([...expanded, ...ancestors])]);
}

function treeRow(ctx, row, { counts, selectedId, focusId, surface }) {
  const selected = row.id === selectedId;
  const renaming = ui(ctx).renamingId === row.id;
  const addLabel = surface === 'side' ? `Save this page to ${row.name}` : `Add to ${row.name}`;
  return html`<div class="${cx('tree-row', 'collection-row', selected && 'is-current', renaming && 'is-renaming')}" role="treeitem" id="tree-${row.id}"
    data-key="tree-${row.id}" data-id="${row.id}" aria-level="${row.depth + 1}" aria-setsize="${row.setSize}" aria-posinset="${row.posInSet}"
    ${row.hasChildren ? html`aria-expanded="${row.expanded ? 'true' : 'false'}"` : ''} aria-selected="${selected ? 'true' : 'false'}"
    ${selected ? raw('aria-current="page"') : ''} tabindex="${row.id === focusId ? '0' : '-1'}" style="--indent:${row.depth}"
    data-action="sidebar.open" data-drop-collection="${row.id}" data-drag-collection="${row.id}" draggable="${renaming ? 'false' : 'true'}">
    ${row.hasChildren
      ? html`<span class="${cx('tree-chev', row.expanded && 'is-open')}" data-action="sidebar.toggle" data-id="${row.id}" aria-hidden="true">${icon('chevron-right', { size: 12 })}</span>`
      : html`<span class="tree-chev is-leaf" aria-hidden="true"></span>`}
    ${collectionIcon(row, { size: 22, className: 'tree-tile' })}
    ${renaming
      ? html`<input class="tree-rename" id="tree-rename" value="${row.name}" aria-label="Collection name" maxlength="500" autocomplete="off" spellcheck="false"
          data-keydown="sidebar.rename-key">`
      : html`<span class="tree-name">${row.name}</span>${row.pinned ? html`<span class="tree-pin" title="Pinned">${icon('pin', { size: 12 })}<span class="sr-only">Pinned</span></span>` : ''}`}
    <span class="tree-count">${fmt(counts.byCollectionDeep[row.id])}</span>
    <span class="tree-actions" aria-hidden="true">
      <button type="button" class="tree-action" tabindex="-1" data-action="sidebar.add" data-id="${row.id}" data-tooltip="${addLabel}" data-tooltip-pos="end">${icon('plus', { size: 14 })}</button>
      <button type="button" class="tree-action" tabindex="-1" data-action="sidebar.menu" data-id="${row.id}" data-tooltip="More actions" data-tooltip-pos="end">${icon('ellipsis', { size: 14 })}</button>
    </span>
  </div>`;
}

function renderCollections(ctx, counts, surface) {
  revealCurrent(ctx);
  const open = isOpen(ctx, 'collections');
  const rows = visibleTree(ctx.select.tree(), new Set(ctx.prefs.get('expandedCollections', [])));
  const pinned = renderPinned(ctx, counts, surface, open ? new Set(rows.map(r => r.id)) : new Set());
  const selectedId = surface === 'full' && ctx.state.view.startsWith('collection:') ? ctx.state.view.slice(11) : '';
  const focusId = rows.some(r => r.id === treeFocusId) ? treeFocusId : rows.some(r => r.id === selectedId) ? selectedId : rows[0]?.id;
  return html`${pinned}${heading(ctx, 'collections', 'Collections', {
    attrs: raw('data-drop-root'),
    actions: iconButton({ icon: 'plus', label: 'New collection', action: 'collections.new', size: 'sm', className: 'nav-heading-action' }),
  })}
    <div class="nav-section" id="nav-collections" ${open ? '' : raw('hidden')}>
      ${rows.length
        ? html`<div class="tree" role="tree" aria-label="Collections" data-keydown="sidebar.tree-key">${rows.map(row => treeRow(ctx, row, { counts, selectedId, focusId, surface }))}</div>`
        : html`<p class="nav-empty">Group links and notes into collections.</p>`}
      <button type="button" class="tree-row is-new" data-action="collections.new"><span class="tree-chev is-leaf" aria-hidden="true"></span>${icon('plus', { size: 18, className: 'nav-icon' })}<span class="tree-name">New collection</span></button>
    </div>`;
}

/**
 * The Pinned section above Collections: every pinned collection at any depth as one flat list, so a pinned sub-collection
 * is one click away without opening its parents. Same row anatomy as the tree (tile, name, count, hover actions), plus the
 * parent's name when it is nested. Rows are their own one-level tree for keyboard use. Hidden while nothing is pinned.
 */
function renderPinned(ctx, counts, surface, visibleIds) {
  const rows = ctx.select.pinnedCollections();
  if (!rows.length) return '';
  const open = isOpen(ctx, 'pinned');
  const selectedId = surface === 'full' && ctx.state.view.startsWith('collection:') ? ctx.state.view.slice(11) : '';
  const focusId = rows.some(r => r.id === pinFocusId) ? pinFocusId : rows[0].id;
  return html`${heading(ctx, 'pinned', 'Pinned', { count: rows.length, attrs: raw('data-drop-pin') })}
    <div class="nav-section nav-pinned" id="nav-pinned" data-drop-pin ${open ? '' : raw('hidden')}>
      <div class="tree" role="tree" aria-label="Pinned collections" data-keydown="sidebar.tree-key">
        ${rows.map((row, index) => {
          const selected = row.id === selectedId;
          return html`<div class="${cx('tree-row', 'collection-row', 'pinned-row', selected && 'is-current')}" role="treeitem" id="pin-${row.id}" data-key="pin-${row.id}"
            data-id="${row.id}" data-pinned-row aria-level="1" aria-setsize="${rows.length}" aria-posinset="${index + 1}" aria-selected="${selected ? 'true' : 'false'}"
            ${selected && !visibleIds.has(row.id) ? raw('aria-current="page"') : ''} tabindex="${row.id === focusId ? '0' : '-1'}"
            data-action="sidebar.open" data-drop-collection="${row.id}">
            <span class="tree-chev is-leaf" aria-hidden="true"></span>
            ${collectionIcon(row, { size: 22, className: 'tree-tile' })}
            <span class="tree-name">${row.name}${row.parentName ? html`<span class="tree-parent"><span class="sr-only">, in </span><span aria-hidden="true">in </span>${row.parentName}</span>` : ''}</span>
            <span class="tree-count">${fmt(counts.byCollectionDeep[row.id])}</span>
            <span class="tree-actions" aria-hidden="true">
              <button type="button" class="tree-action" tabindex="-1" data-action="sidebar.unpin" data-id="${row.id}" data-tooltip="Unpin" data-tooltip-pos="end">${icon('pin-off', { size: 14 })}</button>
              <button type="button" class="tree-action" tabindex="-1" data-action="sidebar.menu" data-id="${row.id}" data-pinned-row data-tooltip="More actions" data-tooltip-pos="end">${icon('ellipsis', { size: 14 })}</button>
            </span>
          </div>`;
        })}
      </div>
    </div>`;
}

function renderFilters(ctx, counts, surface) {
  const rows = FILTERS.filter(f => !(f.fullOnly && surface === 'side') && (f.always || f.show?.(counts) || (f.count(counts) || 0) > 0));
  return html`${heading(ctx, 'filters', 'Filters')}
    <div class="nav-section" id="nav-filters" ${isOpen(ctx, 'filters') ? '' : raw('hidden')}>${rows.map(row => navRow(ctx, row, counts, surface))}</div>`;
}

function renderTags(ctx, surface) {
  const tags = ctx.select.tags();
  if (!tags.length) return '';
  const all = ui(ctx).allTags;
  const shown = all ? tags : tags.slice(0, TAG_LIMIT);
  return html`${heading(ctx, 'tags', 'Tags', { count: tags.length })}
    <div class="nav-section tag-list" id="nav-tags" ${isOpen(ctx, 'tags') ? '' : raw('hidden')}>
      ${shown.map(({ name, count }) => {
        const view = `tag:${name}`;
        const current = surface === 'full' && ctx.state.view.toLowerCase() === view.toLowerCase();
        return html`<a class="${cx('tree-row', 'tag-row', current && 'is-current')}" href="${viewHref(view)}" data-action="sidebar.navigate" data-view="${view}"
          data-tag="${name}" data-drop-tag="${name}" ${current ? raw('aria-current="page"') : ''}>
          <span class="tree-chev is-leaf" aria-hidden="true"></span><span class="tag-hash" aria-hidden="true">#</span><span class="tree-name">${name}</span>
          <span class="tree-count">${fmt(count)}</span></a>`;
      })}
      ${tags.length > TAG_LIMIT ? html`<button type="button" class="tree-row is-more" data-action="sidebar.all-tags" aria-expanded="${all ? 'true' : 'false'}">
        <span class="tree-chev is-leaf" aria-hidden="true"></span>${icon(all ? 'chevron-up' : 'chevron-down', { size: 18, className: 'nav-icon' })}
        <span class="tree-name">${all ? 'Show fewer tags' : 'All tags'}</span>${all ? '' : html`<span class="tree-count">${fmt(tags.length - TAG_LIMIT)} more</span>`}</button>` : ''}
    </div>`;
}

function renderNav(ctx, counts, surface) {
  return html`<div class="nav-section nav-top">${TOP.map(row => navRow(ctx, row, counts, surface))}</div>
    ${renderCollections(ctx, counts, surface)}${renderFilters(ctx, counts, surface)}${renderTags(ctx, surface)}`;
}

/** Full-tab left navigation (inside <nav class="sidebar">, rendered by the shell). */
export function renderSidebar(ctx) {
  const counts = navCounts(ctx);
  const overlay = ctx.state.shell?.docked === false;
  const footLink = ({ view, label, icon: ico, filter }) => {
    const current = ctx.state.view === view;
    return html`<a class="${cx('btn', 'btn-ghost', 'sidebar-foot-link', current && 'is-current')}" href="${viewHref(view)}" data-action="sidebar.navigate"
      data-view="${view}" data-drop-filter="${filter}" data-tooltip="${label}" data-tooltip-pos="start" ${current ? raw('aria-current="page"') : ''}>${icon(ico, { size: 16 })}<span class="btn-label">${label}</span></a>`;
  };
  const home = ctx.startView?.() || 'dashboard';
  const inSettings = /^settings(?::|$)/.test(ctx.state.view);
  return html`<div class="sidebar-head">
      <a class="brand" href="${viewHref(home)}" data-action="sidebar.navigate" data-view="${home}" aria-label="Still, start page">${brandMark()}<span class="brand-name">Still</span></a>
      ${overlay ? iconButton({ icon: 'x', label: 'Close sidebar', action: 'shell.close-nav' })
        : iconButton({ icon: 'panel-left', label: 'Hide sidebar', action: 'shell.hide-sidebar', attrs: { 'aria-keyshortcuts': ctx.env.isMac ? 'Meta+\\' : 'Control+\\' } })}
    </div>
    <div class="sidebar-scroll">${renderNav(ctx, counts, 'full')}</div>
    <div class="sidebar-foot">
      ${END.map(footLink)}
      ${iconButton({ icon: 'settings', label: 'Settings', action: 'sidebar.settings', className: inSettings && 'is-current', attrs: inSettings ? { 'aria-current': 'page' } : undefined })}
      ${iconButton({ icon: 'circle-help', label: 'Help', action: 'sidebar.help' })}
    </div>`;
}

/** Side panel Library tab root: views, collection tree, filters, tags, Archive and Trash. */
export function renderLibraryRoot(ctx) {
  const counts = navCounts(ctx);
  return html`<div class="library-root" data-key="library-root">
    ${renderNav(ctx, counts, 'side')}
    <div class="nav-section library-root-end">${END.map(row => navRow(ctx, row, counts, 'side'))}</div>
  </div>`;
}

const windowIdOf = ctx => ctx.state.windowId ?? ctx.state.page?.windowId ?? undefined;

/**
 * Saves the active browser tab into a collection ('' = Inbox) with an Undo/Edit toast; falls back to the Add dialog
 * in preview mode, on pages Chrome will not expose, or without tab access. Call it synchronously from a click or
 * key handler: the optional 'tabs' permission prompt needs that user activation.
 */
export function saveCurrentTab(ctx, { collectionId } = {}) {
  if (!ctx.env.isExtension) { openAdd(ctx, { collectionId }); return Promise.resolve(null); }
  const asking = !tabsGranted && !tabsDeclined ? globalThis.chrome?.permissions?.request?.({ permissions: ['tabs'] }) : null;
  return ctx.run(async () => {
    if (asking) {
      try { tabsGranted = !!(await asking); } catch { tabsGranted = false; }
      if (!tabsGranted) tabsDeclined = true;
    }
    let result = null;
    try { result = await ctx.chrome('saveCurrentTab', { collectionId, windowId: windowIdOf(ctx) }); }
    catch (error) { console.info('[still] the active tab was not saved directly', error?.message); }
    if (!result || result.needsPermission || !result.id) { openAdd(ctx, { collectionId }); return null; }
    // Name where the item really is: the worker falls back to Inbox for a deleted collection.
    const savedTo = result.collectionFallback ? '' : result.collectionId ?? collectionId ?? '';
    ctx.prefs.touchCollection(savedTo);
    const name = savedTo ? ctx.select.collection(savedTo)?.name || 'collection' : 'Inbox';
    const edit = { label: 'Edit', run: () => ctx.openItem(result.id) };
    const undo = { label: 'Undo', run: async () => { await ctx.store.deleteItem(result.id); ctx.toast('Removed. It is in Trash if you need it.'); } };
    ctx.toast(result.collectionFallback ? 'Saved to Inbox instead' : `Saved to ${name}`,
      { tone: 'success', action: result.created ? undo : edit, actions: result.created ? [undo, edit] : [edit] });
    return result;
  });
}

/** The + on a collection row: side panel saves the current tab there; the full tab opens the Add dialog. */
export function addToCollection(ctx, collectionId) {
  if (ctx.env.isSidepanel) return saveCurrentTab(ctx, { collectionId });
  return openAdd(ctx, { collectionId });
}

function openViewInTab(ctx, view) {
  const base = ctx.env.isExtension ? globalThis.chrome.runtime.getURL('index.html') : new URL('index.html', location.href).href;
  const url = new URL(base);
  url.searchParams.set('libraryView', view);
  if (ctx.env.isExtension) return globalThis.chrome.tabs.create({ url: url.href });
  window.open(url.href, '_blank', 'noopener');
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function exportCollection(ctx, id) {
  const collection = ctx.select.collection(id);
  if (!collection) return;
  const file = collection.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'collection';
  download(`${file}.html`, exportBookmarkHtml(collectionSubset(ctx.library, id)), 'text/html');
  ctx.toast(`Exported ${collection.name} as a bookmarks file`, { tone: 'success' });
}

function changeLook(ctx, id) {
  const collection = ctx.select.collection(id);
  if (!collection) return;
  const anchor = document.getElementById(`tree-${id}`) || document.getElementById(`pin-${id}`);
  const toHex = color => (/^#[\da-f]{3,8}$/i.test(String(color)) ? color : COLLECTION_COLORS.find(c => c.name === color)?.hex);
  const onPick = ({ icon: nextIcon, color } = {}) => ctx.run(() => ctx.store.updateCollection(id, {
    ...(nextIcon ? { icon: nextIcon } : {}), ...(toHex(color) ? { color: toHex(color) } : {}),
  }));
  try {
    ctx.openPopover('pick.icon', anchor || { x: 260, y: 120 }, { icon: collection.icon, color: collection.color, onPick }, { placement: anchor ? 'right-start' : 'bottom-start' });
    ctx.nextFrame(() => revealInGrid(document.querySelector('#still-popover .pick-icon-cell[aria-checked="true"]')));
  } catch {
    // The icon picker popover belongs to pickers.js; the editor dialog has the same choices.
    openCollectionEditor(ctx, { id });
  }
}

function collectionMenu(ctx, id, { pinnedRow = false } = {}) {
  const collection = ctx.select.collection(id);
  if (!collection) return null;
  const side = ctx.env.isSidepanel;
  return [
    side ? { label: 'Save this page here', icon: 'bookmark-plus', run: () => saveCurrentTab(ctx, { collectionId: id }) }
      : { label: 'Add link here', icon: 'plus', run: () => openAdd(ctx, { collectionId: id }) },
    { label: 'New collection inside', icon: 'folder-plus', run: () => openCollectionEditor(ctx, { parentId: id }) },
    { separator: true },
    { label: 'Edit…', icon: 'pencil', run: () => openCollectionEditor(ctx, { id }) },
    // Renaming happens in the tree row, which a pinned sub-collection may not have on screen.
    !pinnedRow && { label: 'Rename', icon: 'text-cursor-input', shortcut: 'F2', keepFocus: true, run: () => startRename(ctx, id) },
    { label: 'Icon and color…', icon: 'palette', keepFocus: true, run: () => changeLook(ctx, id) },
    { label: collection.pinned ? 'Unpin from sidebar' : 'Pin to sidebar', icon: collection.pinned ? 'pin-off' : 'pin', run: () => setCollectionPinned(ctx, id) },
    { separator: true },
    { label: 'Ask AI about this collection', icon: 'sparkles', run: () => askAi(ctx, { scope: 'collection', collectionId: id }) },
    { label: side ? 'Open in full tab' : 'Open in new tab', icon: 'external-link', run: () => openViewInTab(ctx, `collection:${id}`) },
    { label: 'Export as HTML', icon: 'download', run: () => exportCollection(ctx, id) },
    { separator: true },
    { label: 'Delete…', icon: 'trash-2', danger: true, shortcut: 'Del', run: () => deleteCollectionFlow(ctx, id) },
  ].filter(Boolean);
}

export function openCollectionMenu(ctx, id, anchor, { pinnedRow, ...options } = {}) {
  const items = collectionMenu(ctx, id, { pinnedRow: !!pinnedRow });
  if (items) ctx.openMenu(anchor, items, { label: `Actions for ${ctx.select.collection(id).name}`, ...options });
}

async function renameTag(ctx, tag) {
  const value = await ctx.prompt({ title: `Rename #${tag}`, label: 'Tag name', value: tag, confirmLabel: 'Rename' });
  const next = String(value ?? '').trim().replace(/^#+/, '');
  if (!next || next === tag) return;
  const result = await ctx.store.mutateTags({ oldTag: tag, newTag: next, expectedLibraryUpdatedAt: ctx.library.updatedAt });
  if (ctx.state.view.toLowerCase() === `tag:${tag}`.toLowerCase()) ctx.navigate(`tag:${next}`);
  ctx.toast(`Renamed #${tag} to #${next} on ${plural(result.updated, 'item')}`, { tone: 'success' });
}
async function deleteTag(ctx, tag) {
  const count = ctx.select.tags().find(t => t.name.toLowerCase() === tag.toLowerCase())?.count || 0;
  const ok = await ctx.confirm({ title: `Delete #${tag}?`, body: `The tag is removed from ${plural(count, 'item')}. The items stay in your library.`, confirmLabel: 'Delete tag', tone: 'danger' });
  if (!ok) return;
  await ctx.store.mutateTags({ oldTag: tag, newTag: null, expectedLibraryUpdatedAt: ctx.library.updatedAt });
  if (ctx.state.view.toLowerCase() === `tag:${tag}`.toLowerCase()) ctx.navigate('all');
  ctx.toast(`Deleted #${tag}`);
}
const tagMenu = (ctx, tag) => [
  { label: 'Rename tag…', icon: 'pencil', run: () => renameTag(ctx, tag) },
  { label: 'Open in new tab', icon: 'external-link', run: () => openViewInTab(ctx, `tag:${tag}`) },
  { separator: true },
  { label: 'Delete tag…', icon: 'trash-2', danger: true, run: () => deleteTag(ctx, tag) },
];

function startRename(ctx, id) {
  ui(ctx).renamingId = id;
  ctx.render();
  ctx.nextFrame(() => { const input = document.getElementById('tree-rename'); input?.focus(); input?.select(); });
}
async function commitRename(ctx, value, { cancel = false } = {}) {
  const id = ui(ctx).renamingId;
  if (!id) return;
  ui(ctx).renamingId = '';
  treeFocusId = id;
  ctx.render();
  // Return focus to the row unless the user already moved it (a click on another row commits through focusout).
  ctx.nextFrame(() => {
    const focused = document.activeElement;
    if (!focused || focused === document.body || !focused.isConnected) document.getElementById(`tree-${id}`)?.focus({ preventScroll: true });
  });
  const collection = ctx.select.collection(id);
  const name = String(value || '').trim();
  if (cancel || !collection || !name || name === collection.name) return;
  await ctx.run(() => ctx.store.updateCollection(id, { name }, { expectedUpdatedAt: collection.updatedAt }));
}

const rememberFocus = (row, id) => { if (row.matches('[data-pinned-row]')) pinFocusId = id; else treeFocusId = id; };

function focusRow(rows, row) {
  if (!row) return;
  rememberFocus(row, row.dataset.id);
  for (const other of rows) other.tabIndex = other === row ? 0 : -1;
  row.focus();
  row.scrollIntoView({ block: 'nearest' });
}

function reorder(ctx, id, delta) {
  const tree = ctx.select.tree();
  const row = tree.find(r => r.id === id);
  if (!row) return;
  const siblings = tree.filter(r => parentKey(r) === parentKey(row));
  const index = siblings.findIndex(r => r.id === id);
  if (delta < 0 && index > 0) return ctx.run(() => ctx.store.moveCollection(id, { parentId: parentKey(row), beforeId: siblings[index - 1].id }));
  if (delta > 0 && index < siblings.length - 1) return ctx.run(() => ctx.store.moveCollection(id, { parentId: parentKey(row), beforeId: siblings[index + 2]?.id || '' }));
}

function treeKey({ ctx, el, event }) {
  const row = event.target.closest?.('[role="treeitem"]');
  if (!row || event.target !== row) return;
  const rows = [...el.querySelectorAll('[role="treeitem"]')];
  const index = rows.indexOf(row);
  const id = row.dataset.id;
  const expanded = row.getAttribute('aria-expanded');
  const level = Number(row.getAttribute('aria-level'));
  // The pinned list is a flat tree of shortcuts: it has no nesting, manual order or inline rename (those live in the tree below).
  const pinnedRow = row.matches('[data-pinned-row]');
  // The focused row keeps the tree's tab stop when a key re-renders the tree (expand, collapse, rename, reorder).
  rememberFocus(row, id);
  const setExpanded = on => { ctx.prefs.toggleInList('expandedCollections', id, on); ctx.render(); };
  let handled = true;
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { if (!pinnedRow) reorder(ctx, id, event.key === 'ArrowUp' ? -1 : 1); }
  else if (event.metaKey || event.ctrlKey || event.altKey) handled = false;
  else switch (event.key) {
    case 'ArrowDown': focusRow(rows, rows[index + 1]); break;
    case 'ArrowUp': focusRow(rows, rows[index - 1]); break;
    case 'Home': focusRow(rows, rows[0]); break;
    case 'End': focusRow(rows, rows.at(-1)); break;
    case 'ArrowRight':
      if (expanded === 'false') setExpanded(true); else if (expanded === 'true') focusRow(rows, rows[index + 1]);
      break;
    case 'ArrowLeft':
      if (expanded === 'true') setExpanded(false);
      else focusRow(rows, rows.slice(0, index).reverse().find(r => Number(r.getAttribute('aria-level')) === level - 1));
      break;
    case 'Enter': case ' ':
      rememberFocus(row, id); closeNav(ctx); ctx.navigate(`collection:${id}`);
      break;
    case 'F2': if (pinnedRow) handled = false; else startRename(ctx, id); break;
    case 'Delete': case 'Backspace': {
      // After a delete, focus moves to the next row (or the previous one) instead of falling back to the page.
      const neighbor = (rows[index + 1] || rows[index - 1])?.dataset.id;
      const prefix = pinnedRow ? 'pin' : 'tree';
      ctx.run(async () => {
        if (!(await deleteCollectionFlow(ctx, id)) || !neighbor) return;
        if (pinnedRow) pinFocusId = neighbor; else treeFocusId = neighbor;
        ctx.nextFrame(() => document.getElementById(`${prefix}-${neighbor}`)?.focus({ preventScroll: true }));
      });
      break;
    }
    case '*': {
      if (pinnedRow) { handled = false; break; }
      const tree = ctx.select.tree();
      const self = tree.find(r => r.id === id);
      const open = tree.filter(r => r.hasChildren && parentKey(r) === parentKey(self)).map(r => r.id);
      ctx.prefs.set('expandedCollections', [...new Set([...ctx.prefs.get('expandedCollections', []), ...open])]);
      ctx.render();
      break;
    }
    default:
      // Letters and digits only, so / and ? still reach the global shortcuts.
      if (event.key.length === 1 && /[\p{L}\p{N}]/u.test(event.key)) {
        // Type-ahead: jump to the next collection whose name starts with the typed letters.
        const now = Date.now();
        typed = { text: now - typed.at < 700 ? typed.text + event.key.toLowerCase() : event.key.toLowerCase(), at: now };
        const ordered = [...rows.slice(index + (typed.text.length > 1 ? 0 : 1)), ...rows.slice(0, index + 1)];
        focusRow(rows, ordered.find(r => r.querySelector('.tree-name')?.textContent.trim().toLowerCase().startsWith(typed.text)));
      } else handled = false;
  }
  if (handled) event.preventDefault();
}

registerActions({
  'sidebar.navigate': ({ ctx, data, event }) => {
    if (modified(event)) return;
    event?.preventDefault();
    goToView(ctx, data.view, { keep: data.keep === true || data.keep === 'true' });
  },
  'sidebar.open': ({ ctx, data, event, el }) => {
    if (event?.target?.closest?.('.tree-rename')) return;
    if (el?.matches?.('[data-pinned-row]')) pinFocusId = data.id; else treeFocusId = data.id;
    closeNav(ctx);
    ctx.navigate(`collection:${data.id}`);
  },
  'sidebar.toggle': ({ ctx, data }) => { ctx.prefs.toggleInList('expandedCollections', data.id); ctx.render(); },
  'sidebar.add': ({ ctx, data }) => addToCollection(ctx, data.id),
  'sidebar.menu': ({ ctx, data, el }) => {
    const pinnedRow = el.hasAttribute('data-pinned-row');
    if (pinnedRow) pinFocusId = data.id; else treeFocusId = data.id;
    openCollectionMenu(ctx, data.id, el, { placement: 'bottom-end', pinnedRow });
  },
  'sidebar.unpin': ({ ctx, data }) => ctx.run(() => setCollectionPinned(ctx, data.id, false)),
  'sidebar.toggle-section': ({ ctx, data }) => { ctx.prefs.toggleInList('collapsedSections', data.section); ctx.render(); },
  'sidebar.all-tags': ({ ctx }) => { ui(ctx).allTags = !ui(ctx).allTags; ctx.render(); },
  'sidebar.settings': ({ ctx }) => openSettings(ctx, 'general'),
  'sidebar.help': ({ ctx }) => openSettings(ctx, 'help'),
  'sidebar.tree-key': treeKey,
  'sidebar.rename-key': ({ ctx, el, event }) => {
    if (event.key === 'Enter') { event.preventDefault(); commitRename(ctx, el.value); }
    else if (event.key === 'Escape') { event.preventDefault(); commitRename(ctx, '', { cancel: true }); }
  },
});

export function init(ctx) {
  initDnd(ctx, { openAdd, setPinned: setCollectionPinned });
  const permissions = globalThis.chrome?.permissions;
  if (ctx.env.isExtension) {
    permissions?.contains?.({ permissions: ['tabs'] })?.then?.(granted => { tabsGranted = !!granted; }, () => {});
    permissions?.onAdded?.addListener?.(change => { if (change.permissions?.includes('tabs')) { tabsGranted = true; tabsDeclined = false; } });
    permissions?.onRemoved?.addListener?.(change => { if (change.permissions?.includes('tabs')) tabsGranted = false; });
    // The service worker targets this window's active tab when saving from the side panel.
    if (ctx.state.windowId == null) globalThis.chrome?.windows?.getCurrent?.()?.then?.(win => { ctx.state.windowId ??= win?.id; }, () => {});
  }
  document.addEventListener('contextmenu', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('input, textarea')) return;
    const row = target.closest('.collection-row[data-id]');
    const tag = !row && target.closest('.tag-row[data-tag]');
    if (!row && !tag) return;
    event.preventDefault();
    const el = row || tag;
    const rect = el.getBoundingClientRect();
    // The context-menu key reports no pointer position: anchor the menu to the focused row instead.
    const fromKeyboard = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    const anchor = fromKeyboard ? el : { x: event.clientX, y: event.clientY };
    if (row) {
      const pinnedRow = row.hasAttribute('data-pinned-row');
      rememberFocus(row, row.dataset.id);
      openCollectionMenu(ctx, row.dataset.id, anchor, { ...(fromKeyboard ? { placement: 'right-start' } : {}), pinnedRow });
    }
    else ctx.openMenu(anchor, tagMenu(ctx, tag.dataset.tag), { label: `Actions for #${tag.dataset.tag}` });
  });
  document.addEventListener('focusout', event => {
    if (event.target?.matches?.('.tree-rename')) commitRename(ctx, event.target.value);
  });
  // The row's + and … buttons are mouse affordances (aria-hidden, hidden again once the pointer leaves). When they take
  // focus (a click, or a menu or dialog returning focus to its opener) the row takes it instead, so keyboard focus
  // never sits on an invisible control.
  document.addEventListener('focusin', event => {
    const row = event.target instanceof Element && event.target.matches('.tree-action') ? event.target.closest('[role="treeitem"]') : null;
    if (!row) return;
    rememberFocus(row, row.dataset.id);
    row.focus({ preventScroll: true });
  });
}

/**
 * The "Show sidebar" button for views that draw their own header instead of the top bar (dashboard, assistant,
 * settings). Empty while the sidebar is docked or in the side panel.
 */
export function navToggle(ctx) {
  if (ctx.env.isSidepanel || ctx.state.shell?.docked !== false) return '';
  const open = !!ctx.state.shell?.navOpen;
  return iconButton({ icon: 'panel-left', label: 'Show sidebar', action: 'shell.toggle-nav', controls: 'sidebar', className: 'topbar-nav-toggle', id: 'nav-toggle',
    attrs: { 'aria-expanded': open ? 'true' : 'false', 'aria-keyshortcuts': ctx.env.isMac ? 'Meta+\\' : 'Control+\\' } });
}
