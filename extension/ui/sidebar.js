// Library navigation: the full-tab sidebar (views, collection tree, filters, tags, footer) and the side panel's
// Library root. Collection rows carry a hover + (save the current tab in the side panel, Add dialog in the full tab)
// and a … menu; the tree follows the ARIA tree pattern with a roving tabindex.
import { html, cx, raw, plural } from './html.js';
import { icon, COLLECTION_COLORS } from './icons.js';
import { iconButton, collectionIcon } from './components.js';
import { registerActions } from './runtime.js';
import { openAdd, saveCurrentTab as saveTab, requestPermission } from './quick-add.js';
import { askAi } from './ai-panel.js';
import { openSettings } from './settings.js';
import { openCollectionEditor, visibleTree, deleteCollectionFlow, collectionSubset } from './collections.js';
import { initDnd } from './dnd.js';
import { exportBookmarkHtml } from '../lib/portability.js';

const TOP = [
  { view: 'all', label: 'All items', icon: 'library', count: c => c.all },
  { view: 'inbox', label: 'Inbox', icon: 'inbox', count: c => c.inbox, drop: '' },
  { view: 'favorites', label: 'Favorites', icon: 'star', count: c => c.favorites, filter: 'favorite' },
];
// Optional filters only appear when they have something to show.
const FILTERS = [
  { view: 'notes', label: 'Notes', icon: 'sticky-note', count: c => c.notes, always: true },
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
let revealedView = '';
let tabsGranted = null;
let tabsDeclined = false;
let typed = { text: '', at: 0 };

const ui = ctx => (ctx.state.sidebar ||= { renamingId: '', allTags: false });
const fmt = n => Number(n || 0).toLocaleString();
const isOpen = (ctx, section) => !ctx.prefs.get('collapsedSections', []).includes(section);
const viewHref = view => `?libraryView=${encodeURIComponent(view)}`;
const modified = event => !!event && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0);
// Closing the overlay drawer makes it inert, which would drop focus on the page body: move it to the new view instead.
const closeNav = ctx => {
  if (!ctx.state.shell?.navOpen) return;
  ctx.state.shell.navOpen = false;
  ctx.nextFrame(() => document.getElementById('main')?.focus({ preventScroll: true }));
};
const parentKey = row => (row.depth > 0 ? row.parentId || '' : '');

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

function navRow(ctx, { view, label, icon: ico, count, drop, filter }, counts, surface) {
  const current = surface === 'full' && ctx.state.view === view;
  const n = count ? count(counts) : null;
  return html`<a class="${cx('tree-row', 'nav-row', current && 'is-current')}" href="${viewHref(view)}" data-action="sidebar.navigate" data-view="${view}"
    ${current ? raw('aria-current="page"') : ''} ${drop != null ? html`data-drop-collection="${drop}"` : ''} ${filter ? html`data-drop-filter="${filter}"` : ''}>
    <span class="tree-chev is-leaf" aria-hidden="true"></span>${icon(ico, { size: 16, className: 'nav-icon' })}<span class="tree-name">${label}</span>
    ${n != null ? html`<span class="tree-count">${fmt(n)}</span>` : ''}</a>`;
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
    ${collectionIcon(row, { size: 20, className: 'tree-tile' })}
    ${renaming
      ? html`<input class="tree-rename" id="tree-rename" value="${row.name}" aria-label="Collection name" maxlength="500" autocomplete="off" spellcheck="false"
          data-keydown="sidebar.rename-key">`
      : html`<span class="tree-name">${row.name}</span>`}
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
  const selectedId = surface === 'full' && ctx.state.view.startsWith('collection:') ? ctx.state.view.slice(11) : '';
  const focusId = rows.some(r => r.id === treeFocusId) ? treeFocusId : rows.some(r => r.id === selectedId) ? selectedId : rows[0]?.id;
  return html`${heading(ctx, 'collections', 'Collections', {
    attrs: raw('data-drop-root'),
    actions: iconButton({ icon: 'plus', label: 'New collection', action: 'collections.new', size: 'sm', className: 'nav-heading-action' }),
  })}
    <div class="nav-section" id="nav-collections" ${open ? '' : raw('hidden')}>
      ${rows.length
        ? html`<div class="tree" role="tree" aria-label="Collections" data-keydown="sidebar.tree-key">${rows.map(row => treeRow(ctx, row, { counts, selectedId, focusId, surface }))}</div>`
        : html`<p class="nav-empty">Group links and notes into collections.</p>`}
      <button type="button" class="tree-row is-new" data-action="collections.new"><span class="tree-chev is-leaf" aria-hidden="true"></span>${icon('plus', { size: 16, className: 'nav-icon' })}<span class="tree-name">New collection</span></button>
    </div>`;
}

function renderFilters(ctx, counts, surface) {
  const rows = FILTERS.filter(f => !(f.fullOnly && surface === 'side') && (f.always || (f.count(counts) || 0) > 0));
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
        <span class="tree-chev is-leaf" aria-hidden="true"></span>${icon(all ? 'chevron-up' : 'chevron-down', { size: 16, className: 'nav-icon' })}
        <span class="tree-name">${all ? 'Show fewer tags' : 'All tags'}</span>${all ? '' : html`<span class="tree-count">${fmt(tags.length - TAG_LIMIT)} more</span>`}</button>` : ''}
    </div>`;
}

function renderNav(ctx, counts, surface) {
  return html`<div class="nav-section">${TOP.map(row => navRow(ctx, row, counts, surface))}</div>
    ${renderCollections(ctx, counts, surface)}${renderFilters(ctx, counts, surface)}${renderTags(ctx, surface)}`;
}

/** Full-tab left navigation (inside <nav class="sidebar">, rendered by the shell). */
export function renderSidebar(ctx) {
  const counts = ctx.select.counts();
  const overlay = ctx.state.shell?.docked === false;
  const footLink = ({ view, label, icon: ico, filter }) => {
    const current = ctx.state.view === view;
    return html`<a class="${cx('btn', 'btn-ghost', 'sidebar-foot-link', current && 'is-current')}" href="${viewHref(view)}" data-action="sidebar.navigate"
      data-view="${view}" data-drop-filter="${filter}" ${current ? raw('aria-current="page"') : ''}>${icon(ico, { size: 16 })}<span class="btn-label">${label}</span></a>`;
  };
  return html`<div class="sidebar-head">
      <a class="brand" href="?" data-action="sidebar.navigate" data-view="all" aria-label="Still, all items">${brandMark()}<span class="brand-name">Still</span></a>
      ${overlay ? iconButton({ icon: 'x', label: 'Close sidebar', action: 'shell.close-nav' })
        : iconButton({ icon: 'panel-left', label: 'Hide sidebar', action: 'shell.hide-sidebar', attrs: { 'aria-keyshortcuts': ctx.env.isMac ? 'Meta+\\' : 'Control+\\' } })}
    </div>
    <div class="sidebar-scroll">${renderNav(ctx, counts, 'full')}</div>
    <div class="sidebar-foot">
      ${END.map(footLink)}
      ${iconButton({ icon: 'settings', label: 'Settings', action: 'sidebar.settings' })}
      ${iconButton({ icon: 'circle-help', label: 'Help', action: 'sidebar.help' })}
    </div>`;
}

/** Side panel Library tab root: views, collection tree, filters, tags, Archive and Trash. */
export function renderLibraryRoot(ctx) {
  const counts = ctx.select.counts();
  return html`<div class="library-root" data-key="library-root">
    ${renderNav(ctx, counts, 'side')}
    <div class="nav-section library-root-end">${END.map(row => navRow(ctx, row, counts, 'side'))}</div>
  </div>`;
}

/**
 * Saves the active browser tab into a collection ('' = Inbox) through quick-add's saveCurrentTab (Undo, browser-page
 * guard, This page state); opens the Add dialog in preview mode. Call it synchronously from a click or key handler:
 * the optional 'tabs' permission prompt needs that user activation.
 */
export function saveCurrentTab(ctx, { collectionId } = {}) {
  if (!ctx.env.isExtension) { openAdd(ctx, { collectionId }); return Promise.resolve(null); }
  const asking = !tabsGranted && !tabsDeclined ? requestPermission({ permissions: ['tabs'] }) : null;
  return ctx.run(async () => {
    if (asking) {
      tabsGranted = await asking;
      if (!tabsGranted) tabsDeclined = true;
    }
    return saveTab(ctx, { collectionId });
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
  const anchor = document.getElementById(`tree-${id}`);
  const toHex = color => (/^#[\da-f]{3,8}$/i.test(String(color)) ? color : COLLECTION_COLORS.find(c => c.name === color)?.hex);
  const onPick = ({ icon: nextIcon, color } = {}) => ctx.run(() => ctx.store.updateCollection(id, {
    ...(nextIcon ? { icon: nextIcon } : {}), ...(toHex(color) ? { color: toHex(color) } : {}),
  }));
  try {
    ctx.openPopover('pick.icon', anchor || { x: 260, y: 120 }, { icon: collection.icon, color: collection.color, onPick }, { placement: anchor ? 'right-start' : 'bottom-start' });
  } catch {
    // The icon picker popover belongs to pickers.js; the editor dialog has the same choices.
    openCollectionEditor(ctx, { id });
  }
}

function collectionMenu(ctx, id) {
  const collection = ctx.select.collection(id);
  if (!collection) return null;
  const side = ctx.env.isSidepanel;
  return [
    side ? { label: 'Save this page here', icon: 'bookmark-plus', run: () => saveCurrentTab(ctx, { collectionId: id }) }
      : { label: 'Add link here', icon: 'plus', run: () => openAdd(ctx, { collectionId: id }) },
    { label: 'New collection inside', icon: 'folder-plus', run: () => openCollectionEditor(ctx, { parentId: id }) },
    { separator: true },
    { label: 'Edit…', icon: 'pencil', run: () => openCollectionEditor(ctx, { id }) },
    { label: 'Rename', icon: 'text-cursor-input', shortcut: 'F2', keepFocus: true, run: () => startRename(ctx, id) },
    { label: 'Icon and color…', icon: 'palette', keepFocus: true, run: () => changeLook(ctx, id) },
    { label: collection.pinned ? 'Unpin' : 'Pin to top', icon: collection.pinned ? 'pin-off' : 'pin',
      run: () => ctx.store.updateCollection(id, { pinned: !collection.pinned }, { expectedUpdatedAt: collection.updatedAt }) },
    { separator: true },
    { label: 'Ask AI about this collection', icon: 'sparkles', run: () => askAi(ctx, { scope: 'collection', collectionId: id }) },
    { label: side ? 'Open in full tab' : 'Open in new tab', icon: 'external-link', run: () => openViewInTab(ctx, `collection:${id}`) },
    { label: 'Export as HTML', icon: 'download', run: () => exportCollection(ctx, id) },
    { separator: true },
    { label: 'Delete…', icon: 'trash-2', danger: true, shortcut: 'Del', run: () => deleteCollectionFlow(ctx, id) },
  ];
}

export function openCollectionMenu(ctx, id, anchor, options = {}) {
  const items = collectionMenu(ctx, id);
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

function focusRow(rows, row) {
  if (!row) return;
  treeFocusId = row.dataset.id;
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
  // The focused row keeps the tree's tab stop when a key re-renders the tree (expand, collapse, rename, reorder).
  treeFocusId = id;
  const setExpanded = on => { ctx.prefs.toggleInList('expandedCollections', id, on); ctx.render(); };
  let handled = true;
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) reorder(ctx, id, event.key === 'ArrowUp' ? -1 : 1);
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
      treeFocusId = id; closeNav(ctx); ctx.navigate(`collection:${id}`);
      break;
    case 'F2': startRename(ctx, id); break;
    case 'Delete': case 'Backspace': {
      // After a delete, focus moves to the next row (or the previous one) instead of falling back to the page.
      const neighbor = (rows[index + 1] || rows[index - 1])?.dataset.id;
      ctx.run(async () => {
        if (!(await deleteCollectionFlow(ctx, id)) || !neighbor) return;
        treeFocusId = neighbor;
        ctx.nextFrame(() => document.getElementById(`tree-${neighbor}`)?.focus({ preventScroll: true }));
      });
      break;
    }
    case '*': {
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
  'sidebar.open': ({ ctx, data, event }) => {
    if (event?.target?.closest?.('.tree-rename')) return;
    treeFocusId = data.id;
    closeNav(ctx);
    ctx.navigate(`collection:${data.id}`);
  },
  'sidebar.toggle': ({ ctx, data }) => { ctx.prefs.toggleInList('expandedCollections', data.id); ctx.render(); },
  'sidebar.add': ({ ctx, data }) => addToCollection(ctx, data.id),
  'sidebar.menu': ({ ctx, data, el }) => { treeFocusId = data.id; openCollectionMenu(ctx, data.id, el, { placement: 'bottom-end' }); },
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
  initDnd(ctx, { openAdd });
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
    if (row) { treeFocusId = row.dataset.id; openCollectionMenu(ctx, row.dataset.id, anchor, fromKeyboard ? { placement: 'right-start' } : {}); }
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
    treeFocusId = row.dataset.id;
    row.focus({ preventScroll: true });
  });
}
