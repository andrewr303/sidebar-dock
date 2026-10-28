// Item views for both surfaces: view header and toolbar (sort, layout, select, view menu), type and tag filter chips,
// a progressively rendered item list, multi-select with a bulk action bar, item context menus, duplicates, trash and
// archive handling, empty states, and the side panel's collection screen ("Add this page here").
import { html, cx, plural } from './html.js';
import { icon } from './icons.js';
import { button, iconButton, segmented, chip, emptyState, collectionIcon, searchField, favicon, domainOf } from './components.js';
import { registerActions, registerMount, registerShortcuts } from './runtime.js';
import { SORT_OPTIONS } from './selectors.js';
import { renderItem, watchBrokenCovers } from './cards.js';
import { renderMap, setMapScope } from './map.js';
import { openAdd } from './quick-add.js';
import { createNote } from './notes.js';
import { askAi } from './ai-panel.js';
import { openCollectionEditor } from './collections.js';
import { exportBookmarkHtml, exportNotesMarkdown } from '../lib/portability.js';

const PAGE = 150;
export const LAYOUTS = ['list', 'cards', 'masonry', 'headlines'];
const SIDE_LAYOUTS = ['cards', 'list', 'masonry'];
const LAYOUT_OPTIONS = [
  { value: 'list', label: 'List', icon: 'list', hideLabel: true },
  { value: 'cards', label: 'Cards', icon: 'layout-grid', hideLabel: true },
  { value: 'masonry', label: 'Masonry', icon: 'layout-dashboard', hideLabel: true },
  { value: 'headlines', label: 'Headlines', icon: 'rows-3', hideLabel: true },
];
const SIDE_LAYOUT_OPTIONS = [
  { value: 'cards', label: 'Cards', icon: 'rows-3', hideLabel: true },
  { value: 'list', label: 'List', icon: 'list', hideLabel: true },
  { value: 'masonry', label: 'Grid', icon: 'layout-grid', hideLabel: true },
];
const SORT_SHORT = { newest: 'Newest', oldest: 'Oldest', updated: 'Updated', title: 'Title', domain: 'Website' };
const TYPE_CHIPS = [
  { value: 'bookmark', label: 'Links' }, { value: 'article', label: 'Articles' }, { value: 'note', label: 'Notes' },
  { value: 'image', label: 'Images' }, { value: 'video', label: 'Videos' }, { value: 'file', label: 'Files' },
];
const VIEW_META = {
  all: { icon: 'library', title: 'All items' },
  inbox: { icon: 'inbox', title: 'Inbox' },
  favorites: { icon: 'star', title: 'Favorites' },
  notes: { icon: 'sticky-note', title: 'Notes' },
  highlights: { icon: 'highlighter', title: 'Highlights' },
  archive: { icon: 'archive', title: 'Archive' },
  trash: { icon: 'trash-2', title: 'Trash' },
  duplicates: { icon: 'files', title: 'Duplicates' },
  untagged: { icon: 'tag', title: 'Untagged' },
  reminders: { icon: 'bell', title: 'Reminders' },
  'type:bookmark': { icon: 'bookmark', title: 'Links' },
  'type:article': { icon: 'newspaper', title: 'Articles' },
  'type:image': { icon: 'image', title: 'Images' },
  'type:video': { icon: 'film', title: 'Videos' },
  'type:file': { icon: 'file-text', title: 'Files' },
  'type:note': { icon: 'sticky-note', title: 'Notes' },
};

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)

/** Layout for a view: the saved choice, else images/videos as masonry, side-panel collections as media cards, else list. */
export function layoutFor(settings, view, surface = 'full') {
  const saved = settings?.[surface === 'side' ? 'sideLayouts' : 'layouts']?.[view];
  if ((surface === 'side' ? SIDE_LAYOUTS : LAYOUTS).includes(saved)) return saved;
  if (view === 'type:image' || view === 'type:video') return 'masonry';
  if (surface === 'side') return view.startsWith('collection:') || view === 'inbox' ? 'cards' : 'list';
  return 'list';
}

/** Type counts, top tags and the untagged count for a set of rows (the filter chips). */
export function viewFacets(rows, { tagLimit = 10 } = {}) {
  const types = {};
  const tags = new Map();
  let untagged = 0;
  for (const item of rows) {
    types[item.type] = (types[item.type] || 0) + 1;
    if (!item.tags?.length) untagged++;
    for (const tag of item.tags || []) {
      const key = tag.toLowerCase();
      const entry = tags.get(key) || { name: tag, count: 0 };
      entry.count++;
      tags.set(key, entry);
    }
  }
  return { total: rows.length, types, untagged, tags: [...tags.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, tagLimit) };
}

/** Ids between the anchor and the target (inclusive) in display order; just the target when the anchor is gone. */
export function selectRange(order, anchorId, targetId) {
  const to = order.indexOf(targetId);
  if (to < 0) return [];
  const from = order.indexOf(anchorId);
  if (from < 0) return [targetId];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** Group label for a saved date: Today, Yesterday, Previous 7 days, Earlier in <month>, <month>, <month year>. */
export function dateGroupLabel(iso, now = new Date(), locale) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Undated';
  const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  const month = date.toLocaleDateString(locale, { month: 'long' });
  if (date.getFullYear() !== now.getFullYear()) return `${month} ${date.getFullYear()}`;
  return date.getMonth() === now.getMonth() ? `Earlier in ${month}` : month;
}

/** Consecutive date groups for sorted rows; pinned items (sorted first) form their own group. */
export function groupByDate(rows, { now = new Date(), field = 'createdAt', locale } = {}) {
  const groups = [];
  for (const item of rows) {
    const label = item.pinned ? 'Pinned' : dateGroupLabel(item[field], now, locale);
    const last = groups.at(-1);
    if (last && last.label === label) last.items.push(item); else groups.push({ label, items: [item] });
  }
  return groups;
}

/** Tags typed as "a, b #c" -> ['a', 'b', 'c'] (trimmed, no leading #, de-duplicated case-insensitively). */
export function parseTags(text) {
  const seen = new Set();
  return String(text || '').split(/[,\n]|\s+(?=#)/).map(tag => tag.trim().replace(/^#+/, '').trim()).filter(tag => {
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Adds tags to an item's list, keeping existing spelling and order. */
export function unionTags(existing = [], added = []) {
  const out = [...existing];
  const seen = new Set(out.map(tag => tag.toLowerCase()));
  for (const tag of added) if (!seen.has(tag.toLowerCase())) { seen.add(tag.toLowerCase()); out.push(tag); }
  return out;
}

/** Undo patches for a bulk change: the previous value of every patched field. */
export function undoFor(changes, lookup) {
  return changes.map(({ id, patch }) => {
    const before = lookup(id) || {};
    const previous = {};
    for (const key of Object.keys(patch)) previous[key] = before[key] === undefined ? (key === 'deletedAt' || key === 'reminderAt' ? null : Array.isArray(patch[key]) ? [] : '') : before[key];
    return { id, patch: previous };
  });
}

const uniq = list => [...new Set(list)];
/**
 * Merges duplicate copies into the first item (the newest): tags, highlights, links, notes and missing metadata are
 * combined, the other copies go to Trash, and links that pointed at a removed copy now point at the kept one.
 */
export function planMerge(groupItems, allItems = [], { now = new Date().toISOString() } = {}) {
  const [keep, ...rest] = groupItems;
  if (!keep || !rest.length) return [];
  const restIds = new Set(rest.map(item => item.id));
  const all = [keep, ...rest];
  const tags = all.reduce((list, item) => unionTags(list, item.tags || []), []);
  const seenHighlights = new Set();
  const highlights = all.flatMap(item => item.highlights || []).filter(h => {
    const key = (h.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!key || seenHighlights.has(key)) return false;
    seenHighlights.add(key);
    return true;
  });
  const relatedIds = uniq(all.flatMap(item => item.relatedIds || []).map(id => restIds.has(id) ? keep.id : id)).filter(id => id !== keep.id);
  const patch = { tags, highlights, relatedIds };
  const contents = uniq(all.map(item => (item.content || '').trim()).filter(Boolean));
  if (contents.length > 1 || (contents.length === 1 && !keep.content)) patch.content = contents.join('\n\n---\n\n');
  for (const field of ['excerpt', 'cover', 'articleContent', 'collectionId', 'reminderAt']) {
    if (!keep[field]) { const donor = rest.find(item => item[field]); if (donor) patch[field] = donor[field]; }
  }
  if (!keep.favorite && rest.some(item => item.favorite)) patch.favorite = true;
  const changes = [{ id: keep.id, patch }, ...rest.map(item => ({ id: item.id, patch: { deletedAt: now } }))];
  for (const item of allItems) {
    if (item.deletedAt || item.id === keep.id || restIds.has(item.id) || !(item.relatedIds || []).some(id => restIds.has(id))) continue;
    changes.push({ id: item.id, patch: { relatedIds: uniq(item.relatedIds.map(id => restIds.has(id) ? keep.id : id)).filter(id => id !== item.id) } });
  }
  return changes;
}

// ---------------------------------------------------------------------------------------------------------------
// Module state and derived rows

let appCtx = null;
const ui = ctx => ctx.state.lib ||= { view: null, limit: PAGE, limitKey: '', anchorId: null, focusId: null, noTags: false, sideSearch: false, layouts: {} };
function syncUi(ctx) {
  const u = ui(ctx);
  const { state } = ctx;
  if (u.view !== state.view) Object.assign(u, { view: state.view, noTags: false, anchorId: null, focusId: null, sideSearch: !!state.query });
  const key = [state.view, state.query, state.typeFilter, state.tagFilter, u.noTags, state.sort].join('|');
  if (u.limitKey !== key) {
    const first = !u.limitKey;
    Object.assign(u, { limitKey: key, limit: PAGE });
    if (!first) ctx.nextFrame(() => document.querySelector('.lib-scroll')?.scrollTo({ top: 0 }));
  }
  return u;
}
const untaggedCache = new WeakMap();
function viewRows(ctx) {
  const rows = ctx.select.itemsForView(ctx.state);
  if (!ui(ctx).noTags) return rows;
  if (!untaggedCache.has(rows)) untaggedCache.set(rows, rows.filter(item => !item.tags?.length));
  return untaggedCache.get(rows);
}
const facetCache = new WeakMap();
function facetsFor(ctx) {
  const rows = ctx.select.itemsForView({ ...ctx.state, typeFilter: 'all', tagFilter: '' });
  if (!facetCache.has(rows)) facetCache.set(rows, viewFacets(rows));
  return facetCache.get(rows);
}
const groupCache = new WeakMap();
function dateGroups(rows) {
  if (!groupCache.has(rows)) groupCache.set(rows, groupByDate(rows));
  return groupCache.get(rows);
}
const collectionOf = view => view.startsWith('collection:') ? view.slice(11) : null;

function currentLayout(ctx, surface) {
  const view = ctx.state.view;
  if (view === 'duplicates') return 'list';
  return ui(ctx).layouts[`${surface}:${view}`] || layoutFor(ctx.library?.settings, view, surface);
}

export function viewMeta(ctx, view = ctx.state.view) {
  const id = collectionOf(view);
  if (id) {
    const collection = ctx.select.collection(id);
    return { title: collection?.name || 'Collection', collection, path: ctx.select.path(id).slice(0, -1), tile: collectionIcon(collection, { size: 22, className: 'lib-head-tile' }) };
  }
  if (view.startsWith('tag:')) return { title: `#${view.slice(4)}`, tile: html`<span class="lib-head-glyph" aria-hidden="true">${icon('hash', { size: 16 })}</span>` };
  const meta = VIEW_META[view] || VIEW_META.all;
  return { title: meta.title, tile: html`<span class="lib-head-glyph" aria-hidden="true">${icon(meta.icon, { size: 16 })}</span>` };
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

function renderSortButton(ctx) {
  return button({ label: SORT_SHORT[ctx.state.sort] || 'Newest', icon: 'arrow-down-wide-narrow', iconRight: 'chevron-down', variant: 'ghost', size: 'sm',
    action: 'library.sort-menu', className: 'lib-sort', attrs: { 'aria-haspopup': 'menu', 'aria-label': `Sort: ${SORT_OPTIONS.find(o => o.value === ctx.state.sort)?.label || 'Newest first'}` } });
}

function renderLayoutSwitch(layout, side) {
  return html`<span class="lib-layout" data-keydown="library.seg-key">${segmented({ name: 'layout', value: layout, options: side ? SIDE_LAYOUT_OPTIONS : LAYOUT_OPTIONS, action: 'library.layout', size: 'sm', ariaLabel: 'Layout' })}</span>`;
}

function renderFullHead(ctx, meta, count, layout) {
  const { state } = ctx;
  return html`<header class="lib-head">
    <div class="lib-heading">
      ${meta.path?.length ? html`<nav class="lib-crumbs" aria-label="Parent collections">${meta.path.map(c => html`<button type="button" class="lib-crumb" data-action="app.navigate" data-view="collection:${c.id}">${c.name}</button>${icon('chevron-right', { size: 12, className: 'lib-crumb-sep' })}`)}</nav>` : ''}
      ${meta.tile}
      <h1 class="lib-title" id="lib-title" tabindex="-1">${meta.title}</h1>
      <span class="lib-count">${count.toLocaleString()}<span class="sr-only"> ${count === 1 ? 'item' : 'items'}</span></span>
    </div>
    <div class="lib-tools">
      ${state.view === 'trash' && count ? button({ label: 'Empty trash', icon: 'trash-2', variant: 'ghost', size: 'sm', action: 'library.empty-trash', className: 'lib-danger' }) : ''}
      ${state.view !== 'duplicates' ? html`${renderSortButton(ctx)}${renderLayoutSwitch(layout, false)}` : ''}
      ${button({ label: 'Select', icon: 'square-check', variant: 'ghost', size: 'sm', action: 'library.select-mode', pressed: state.selectMode })}
      ${iconButton({ icon: 'ellipsis', label: 'More view options', action: 'library.view-menu', size: 'sm', expanded: false })}
    </div>
  </header>`;
}

function renderSideHead(ctx, meta, count, layout) {
  const u = ui(ctx);
  return html`<header class="lib-side-head">
    ${iconButton({ icon: 'arrow-left', label: 'Back', action: 'library.side-back', size: 'sm' })}
    <h1 class="lib-side-title" id="lib-title" tabindex="-1">${meta.collection ? collectionIcon(meta.collection, { size: 20, className: 'lib-head-tile' }) : meta.tile}<span class="lib-side-name">${meta.title}</span><span class="lib-count">${count.toLocaleString()}<span class="sr-only"> ${count === 1 ? 'item' : 'items'}</span></span></h1>
    ${ctx.state.view !== 'duplicates' ? renderLayoutSwitch(layout, true) : ''}
    ${iconButton({ icon: 'search', label: `Search ${meta.title}`, action: 'library.side-search', size: 'sm', pressed: u.sideSearch })}
    ${iconButton({ icon: 'ellipsis', label: 'More options', action: 'library.view-menu', size: 'sm', expanded: false })}
  </header>
  ${u.sideSearch ? html`<div class="lib-side-search">${searchField({ value: ctx.state.query, placeholder: `Search ${meta.title}`, action: 'library.search', id: 'lib-side-search', clearAction: 'library.clear-search', label: `Search ${meta.title}` })}</div>` : ''}`;
}

function renderFilters(ctx, facets) {
  const { state } = ctx;
  const u = ui(ctx);
  const view = state.view;
  const showTypes = !view.startsWith('type:') && view !== 'notes' && Object.keys(facets.types).length > 1;
  const viewTag = view.startsWith('tag:') ? view.slice(4).toLowerCase() : '';
  const tags = facets.tags.filter(t => t.name.toLowerCase() !== viewTag);
  if (state.tagFilter && !tags.some(t => t.name.toLowerCase() === state.tagFilter.toLowerCase())) tags.unshift({ name: state.tagFilter, count: null });
  const showUntagged = facets.untagged > 0 && facets.untagged < facets.total && view !== 'untagged';
  if (!showTypes && !tags.length && !showUntagged) return '';
  const none = state.typeFilter === 'all' && !state.tagFilter && !u.noTags;
  const hash = html`<span class="lib-hash" aria-hidden="true">#</span>`;
  return html`<div class="lib-filters" role="group" aria-label="Filters">
    ${chip({ label: 'All', count: facets.total, selected: none, action: 'library.clear-filters' })}
    ${showTypes ? TYPE_CHIPS.filter(t => facets.types[t.value]).map(t => chip({ label: t.label, count: facets.types[t.value], selected: state.typeFilter === t.value, action: 'library.type-filter', data: { value: t.value } })) : ''}
    ${showTypes && (tags.length || showUntagged) ? html`<span class="lib-filters-sep" aria-hidden="true"></span>` : ''}
    ${tags.map(t => chip({ label: html`${hash}${t.name}`, count: t.count ?? undefined, selected: state.tagFilter.toLowerCase() === t.name.toLowerCase(), action: 'library.tag-filter', data: { tag: t.name }, title: `Show items tagged ${t.name}` }))}
    ${showUntagged ? html`${tags.length ? html`<span class="lib-filters-sep" aria-hidden="true"></span>` : ''}${chip({ label: 'Without tags', count: facets.untagged, selected: u.noTags, action: 'library.no-tags' })}` : ''}
  </div>`;
}

function renderAddHere(ctx, collectionId) {
  const page = ctx.state.page;
  const url = /^https?:/i.test(page?.url || '') ? page.url : '';
  const saved = url ? ctx.select.savedForUrl(url) : null;
  if (saved && (saved.collectionId || '') === collectionId) {
    return html`<div class="lib-addrow is-saved">${icon('circle-check', { size: 16 })}<span class="lib-addrow-label">This page is saved here</span>
      ${button({ label: 'Open', variant: 'ghost', size: 'sm', action: 'app.open-item', data: { id: saved.id } })}</div>`;
  }
  return html`<button type="button" class="lib-addrow" data-action="library.add-here" data-collection="${collectionId}">
    ${icon('plus', { size: 16 })}<span class="lib-addrow-label">Add this page</span>
    ${url ? html`<span class="lib-addrow-page">${favicon(url, { size: 14 })}<span class="lib-addrow-title">${page.title || domainOf(url)}</span></span>` : ''}
  </button>`;
}

const EMPTY = {
  all: { icon: 'bookmark', title: 'No items yet', body: 'Save a page with Alt+Shift+S, or paste a link anywhere to add it.' },
  inbox: { icon: 'inbox', title: 'Nothing unsorted', body: 'Save a page with Alt+Shift+S or the + next to a collection.' },
  favorites: { icon: 'star', title: 'No favorites yet', body: 'Star an item to keep it here.' },
  highlights: { icon: 'highlighter', title: 'No highlights yet', body: 'Select text on a page, right-click and choose Highlight selection in Still.' },
  archive: { icon: 'archive', title: 'Nothing archived', body: 'Archive items you are done with. They stay searchable here.' },
  trash: { icon: 'trash-2', title: 'Trash is empty', body: 'Deleted items stay here until you empty the trash.' },
  duplicates: { icon: 'files', title: 'No duplicates', body: 'Every saved link points to a different page.' },
  untagged: { icon: 'tag', title: 'Everything is tagged', body: 'Items without tags show up here.' },
  reminders: { icon: 'bell', title: 'No reminders', body: 'Set a reminder on an item to see it here.' },
  notes: { icon: 'sticky-note', title: 'No notes yet', body: 'Write a note about a page, or start a blank one.' },
};

function renderEmpty(ctx, meta, { side }) {
  const { state } = ctx;
  const view = state.view;
  const u = ui(ctx);
  const compact = side;
  if (state.query.trim()) {
    return emptyState({ icon: 'search', compact, title: `No results for “${state.query.trim()}”`,
      body: view === 'all' ? 'Try different words, or narrow with tag:, type: or site:.' : `Nothing in ${meta.title} matches. You can search all items instead.`,
      actions: html`${button({ label: 'Clear search', variant: 'secondary', size: 'sm', action: 'library.clear-search' })}${view !== 'all' ? button({ label: 'Search all items', variant: 'ghost', size: 'sm', action: 'app.navigate', data: { view: 'all', keep: 'true' } }) : ''}` });
  }
  if (state.typeFilter !== 'all' || state.tagFilter || u.noTags) {
    return emptyState({ icon: 'filter-x', compact, title: 'No items match these filters', actions: button({ label: 'Clear filters', variant: 'secondary', size: 'sm', action: 'library.clear-filters' }) });
  }
  const collectionId = collectionOf(view);
  if (collectionId) {
    return emptyState({ icon: 'folder-open', compact, title: 'This collection is empty', body: side ? 'Add the page you are on, or drag items here from another view.' : 'Add a link or a note, or drag items here from another view.',
      actions: html`${button({ label: 'Add link', icon: 'plus', variant: 'primary', size: 'sm', action: 'library.add', data: { collection: collectionId } })}${button({ label: 'New note', icon: 'sticky-note', variant: 'secondary', size: 'sm', action: 'library.new-note', data: { collection: collectionId } })}` });
  }
  if (view.startsWith('tag:')) return emptyState({ icon: 'hash', compact, title: `Nothing tagged ${meta.title}`, body: 'Add this tag to an item from its details or with Add tags in the item menu.' });
  if (view.startsWith('type:')) return emptyState({ icon: VIEW_META[view]?.icon || 'file', compact, title: `No ${meta.title.toLowerCase()} yet`, body: 'Items of this type show up here when you save them.' });
  const copy = EMPTY[view] || EMPTY.all;
  const addable = ['all', 'inbox'].includes(view);
  return emptyState({ ...copy, compact, actions: addable ? button({ label: 'Add link', icon: 'plus', variant: 'primary', size: 'sm', action: 'library.add', data: { collection: '' } }) : '' });
}

function listClass(layout, side) {
  if (side) return layout === 'cards' ? 'is-media' : layout === 'masonry' ? 'is-grid' : 'is-compact';
  return `is-${layout}`;
}

function renderDuplicates(ctx, rows, cardOpts) {
  const ids = new Set(rows.map(row => row.id));
  const groups = ctx.select.duplicates().filter(group => group.items.some(item => ids.has(item.id)));
  return groups.map(group => {
    let path = '';
    try { const url = new URL(group.url); path = url.hostname.replace(/^www\./, '') + (url.pathname === '/' ? '' : url.pathname); } catch { path = group.url; }
    return html`<div class="lib-dupe" role="group" data-key="dupe:${group.url}" aria-label="${group.items.length} copies of ${path}">
      <header class="lib-dupe-head">${favicon(group.url, { size: 16 })}<span class="lib-dupe-url" title="${group.url}">${path}</span><span class="lib-dupe-count">${group.items.length} copies</span>
        <span class="lib-dupe-actions">
          ${button({ label: 'Keep newest', variant: 'ghost', size: 'sm', action: 'library.dupe-keep', data: { url: group.url }, title: 'Keep the most recently updated copy and move the others to Trash' })}
          ${button({ label: 'Merge', icon: 'git-fork', variant: 'secondary', size: 'sm', action: 'library.dupe-merge', data: { url: group.url }, title: 'Combine tags, highlights, notes and links into the newest copy, then move the others to Trash' })}
        </span></header>
      <div class="lib-items is-list" role="list">${group.items.map((item, i) => renderItem(ctx, item, { ...cardOpts(item), index: i, showCollection: true }))}</div>
    </div>`;
  });
}

function renderBulkBar(ctx, rows, side) {
  const { state } = ctx;
  const ids = [...state.selection];
  if (!ids.length) return '';
  const items = ids.map(id => ctx.select.byId(id)).filter(Boolean);
  const trash = state.view === 'trash';
  const archived = items.length && items.every(item => item.archived);
  const allFavorite = items.length && items.every(item => item.favorite);
  const act = (label, glyph, action, extra = {}) => side
    ? iconButton({ icon: glyph, label, action, size: 'sm', className: extra.danger ? 'lib-danger' : '' })
    : button({ label, icon: glyph, variant: 'ghost', size: 'sm', action, className: extra.danger ? 'lib-danger' : '' });
  return html`<div class="lib-bulk" role="region" aria-label="Selected items" data-key="lib-bulk">
    <span class="lib-bulk-count" aria-live="polite">${ids.length.toLocaleString()} selected</span>
    ${ids.length < rows.length ? button({ label: side ? 'All' : `Select all ${rows.length.toLocaleString()}`, variant: 'ghost', size: 'sm', action: 'library.select-all', className: 'lib-bulk-all' }) : ''}
    <span class="lib-bulk-sep" aria-hidden="true"></span>
    ${trash ? html`${act('Restore', 'rotate-ccw', 'library.bulk-restore')}${act('Delete forever', 'trash-2', 'library.bulk-delete-forever', { danger: true })}` : html`
      ${act('Move to…', 'folder-input', 'library.bulk-move')}
      ${act('Tag…', 'tag', 'library.bulk-tag')}
      ${act(allFavorite ? 'Unfavorite' : 'Favorite', 'star', 'library.bulk-favorite')}
      ${act(archived ? 'Unarchive' : 'Archive', archived ? 'archive-restore' : 'archive', 'library.bulk-archive')}
      ${act('Delete', 'trash-2', 'library.bulk-delete', { danger: true })}
      ${act('Ask AI', 'sparkles', 'library.bulk-ask')}
      ${act('Export', 'download', 'library.bulk-export')}`}
    ${iconButton({ icon: 'x', label: 'Clear selection', action: 'library.clear-selection', size: 'sm', className: 'lib-bulk-clear' })}
  </div>`;
}

/** Header, toolbar, filter chips, items (or an empty state), progressive loading and the bulk bar for the current view. */
export function renderItemsView(ctx, { surface = 'full' } = {}) {
  const { state } = ctx;
  if (state.view === 'map') return renderMap(ctx, { surface });
  const side = surface === 'side';
  const u = syncUi(ctx);
  const rows = viewRows(ctx);
  const facets = facetsFor(ctx);
  const layout = currentLayout(ctx, surface);
  const meta = viewMeta(ctx);
  const collectionId = collectionOf(state.view);
  const activeId = state.panel?.kind === 'item' ? state.panel.id : null;
  const visible = rows.slice(0, u.limit);
  const tabId = [u.focusId, activeId].find(id => id && visible.some(item => item.id === id)) || visible[0]?.id;
  const cardOpts = item => ({ layout, surface, selected: state.selection.has(item.id), tabStop: item.id === tabId, view: state.view,
    showCollection: !collectionId ? !!item.collectionId : item.collectionId !== collectionId });
  const one = (item, index) => renderItem(ctx, item, { ...cardOpts(item), index });
  const grouped = !side && ['list', 'headlines'].includes(layout) || (side && layout === 'list');
  const groups = grouped && ['newest', 'oldest'].includes(state.sort) && ctx.library?.settings?.density !== 'compact' && !['trash', 'duplicates'].includes(state.view)
    ? dateGroups(rows) : null;
  let content;
  if (!rows.length) content = html`<div class="lib-empty">${renderEmpty(ctx, meta, { side })}</div>`;
  else if (state.view === 'duplicates') content = renderDuplicates(ctx, visible, cardOpts);
  else if (groups && groups.length > 1) {
    let budget = u.limit;
    content = groups.map(group => {
      if (budget <= 0) return '';
      const slice = group.items.slice(0, budget);
      budget -= slice.length;
      return html`<div class="lib-group" data-key="group:${group.label}">
        <h2 class="lib-group-head">${group.label}<span class="lib-group-count">${group.items.length.toLocaleString()}<span class="sr-only"> ${group.items.length === 1 ? 'item' : 'items'}</span></span></h2>
        <div class="${cx('lib-items', listClass(layout, side))}" role="list" aria-label="${group.label}">${slice.map(one)}</div></div>`;
    });
  } else content = html`<div class="${cx('lib-items', listClass(layout, side))}" role="list" aria-label="${meta.title}">${visible.map(one)}</div>`;
  const remaining = rows.length - visible.length;
  const more = remaining > 0 ? html`<div class="lib-more">
      <div class="lib-more-sentinel" data-mount="library.more" data-morph="skip" data-key="more:${u.limitKey}:${u.limit}" aria-hidden="true"></div>
      <span class="lib-more-count">Showing ${visible.length.toLocaleString()} of ${rows.length.toLocaleString()}</span>
      ${button({ label: `Show ${Math.min(PAGE, remaining).toLocaleString()} more`, variant: 'secondary', size: 'sm', action: 'library.show-more' })}
    </div>` : '';
  return html`<section class="${cx('lib-view', state.selection.size && 'has-bulk', state.selectMode && 'is-selecting')}" data-surface="${surface}" data-layout="${layout}" data-view="${state.view}" data-key="lib-view" aria-labelledby="lib-title">
    <div class="lib-top">
      ${side ? renderSideHead(ctx, meta, rows.length, layout) : renderFullHead(ctx, meta, rows.length, layout)}
      ${renderFilters(ctx, facets)}
    </div>
    <div class="lib-scroll" data-keydown="library.keys" data-key="lib-scroll:${state.view}">
      ${side && (collectionId || state.view === 'inbox') ? renderAddHere(ctx, collectionId || '') : ''}
      ${content}
      ${more}
    </div>
    ${renderBulkBar(ctx, rows, side)}
  </section>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Actions

const byId = ctx => id => ctx.select.byId(id);
const nowIso = () => new Date().toISOString();
const label = (n, one = 'item', many) => plural(n, one, many);

function download(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function applyChanges(ctx, changes, message, { undo = true } = {}) {
  if (!changes.length) return [];
  const previous = undo ? undoFor(changes, byId(ctx)) : null;
  const updated = await ctx.store.bulkUpdateItems(changes);
  if (message) ctx.toast(message, previous ? { action: { label: 'Undo', run: () => ctx.store.bulkUpdateItems(previous) } } : {});
  return updated;
}

/** Collection picker popover from pickers.js; falls back to a menu of collections while that module is unavailable. */
export function pickCollection(ctx, anchor, { value, onPick, title = 'Move to' } = {}) {
  const pick = id => ctx.run(() => onPick(id));
  try {
    ctx.openPopover('pick.collection', anchor, { ...(value === undefined ? {} : { value }), onPick: pick, allowInbox: true, allowCreate: true, title });
  } catch {
    const rows = ctx.select.tree().map(c => ({ label: ctx.select.path(c.id).map(p => p.name).join(' / '), icon: 'folder', checked: c.id === value, run: () => pick(c.id) }));
    ctx.openMenu(anchor, [{ label: 'Inbox', icon: 'inbox', checked: value === '', run: () => pick('') }, ...(rows.length ? [{ separator: true }, ...rows] : [])], { label: title });
  }
}

const collectionName = (ctx, id) => id ? ctx.select.collection(id)?.name || 'collection' : 'Inbox';

export function moveItems(ctx, ids, anchor) {
  const items = ids.map(byId(ctx)).filter(Boolean);
  const common = items.every(item => item.collectionId === items[0]?.collectionId) ? items[0]?.collectionId || '' : null;
  pickCollection(ctx, anchor, { value: common ?? undefined, title: items.length > 1 ? `Move ${label(items.length)} to` : 'Move to', onPick: async collectionId => {
    const changes = items.filter(item => (item.collectionId || '') !== collectionId).map(item => ({ id: item.id, patch: { collectionId } }));
    if (!changes.length) return;
    await applyChanges(ctx, changes, `Moved ${label(changes.length)} to ${collectionName(ctx, collectionId)}`);
    if (collectionId) ctx.prefs.touchCollection?.(collectionId);
  } });
}

export async function tagItems(ctx, ids) {
  const items = ids.map(byId(ctx)).filter(Boolean);
  if (!items.length) return;
  const value = await ctx.prompt({ title: items.length > 1 ? `Add tags to ${label(items.length)}` : 'Add tags', label: 'Tags, separated by commas', placeholder: 'design, reading', confirmLabel: 'Add tags' });
  const tags = parseTags(value);
  if (!tags.length) return;
  const changes = items.map(item => ({ id: item.id, patch: { tags: unionTags(item.tags, tags) } })).filter((change, i) => change.patch.tags.length !== (items[i].tags || []).length);
  if (!changes.length) { ctx.toast(tags.length > 1 ? 'Those tags are already there' : 'That tag is already there'); return; }
  await applyChanges(ctx, changes, `Tagged ${label(changes.length)} with ${tags.map(t => `#${t}`).join(', ')}`);
}

export async function setFavorite(ctx, ids, favorite, { quiet = false } = {}) {
  const changes = ids.map(byId(ctx)).filter(item => item && item.favorite !== favorite).map(item => ({ id: item.id, patch: { favorite } }));
  await applyChanges(ctx, changes, quiet ? '' : favorite ? `Added ${label(changes.length)} to favorites` : `Removed ${label(changes.length)} from favorites`);
}

export async function setArchived(ctx, ids, archived) {
  const changes = ids.map(byId(ctx)).filter(item => item && item.archived !== archived).map(item => ({ id: item.id, patch: { archived } }));
  await applyChanges(ctx, changes, archived ? `Archived ${label(changes.length)}` : `Moved ${label(changes.length)} out of the archive`);
  clearSelectionOf(ctx, ids);
}

export async function trashItems(ctx, ids) {
  const at = nowIso();
  const changes = ids.map(byId(ctx)).filter(item => item && !item.deletedAt).map(item => ({ id: item.id, patch: { deletedAt: at } }));
  await applyChanges(ctx, changes, `Moved ${label(changes.length)} to Trash`);
  clearSelectionOf(ctx, ids);
  if (ctx.state.panel?.kind === 'item' && ids.includes(ctx.state.panel.id)) ctx.closePanel();
}

export async function restoreItems(ctx, ids) {
  const changes = ids.map(byId(ctx)).filter(item => item?.deletedAt).map(item => ({ id: item.id, patch: { deletedAt: null } }));
  await applyChanges(ctx, changes, `Restored ${label(changes.length)}`, { undo: false });
  clearSelectionOf(ctx, ids);
}

export async function deleteForever(ctx, ids) {
  const items = ids.map(byId(ctx)).filter(Boolean);
  if (!items.length) return;
  const ok = await ctx.confirm({ title: items.length > 1 ? `Delete ${label(items.length)} forever?` : `Delete “${items[0].title}” forever?`,
    body: 'This cannot be undone. Attached files are removed from this device too.', confirmLabel: 'Delete forever', tone: 'danger' });
  if (!ok) return;
  const gone = new Set(items.map(item => item.id));
  for (const item of items) await ctx.store.permanentlyDeleteItem(item.id);
  const kept = (ctx.library?.items || []).filter(item => !gone.has(item.id));
  const orphans = [...new Set(items.map(item => item.attachmentId).filter(Boolean))].filter(id => !kept.some(item => item.attachmentId === id));
  await Promise.allSettled(orphans.map(id => ctx.store.deleteAttachment(id)));
  clearSelectionOf(ctx, ids);
  ctx.toast(`Deleted ${label(items.length)}`);
}

async function emptyTrash(ctx) {
  const total = ctx.select.counts().trash;
  if (!total) return;
  const ok = await ctx.confirm({ title: 'Empty the trash?', body: `${label(total)} will be deleted forever. This cannot be undone.`, confirmLabel: 'Empty trash', tone: 'danger' });
  if (!ok) return;
  const { ids = [], attachmentIds = [] } = await ctx.store.emptyTrash() || {};
  await Promise.allSettled(attachmentIds.map(id => ctx.store.deleteAttachment(id)));
  ctx.state.selection = new Set();
  ctx.toast(`Deleted ${label(ids.length)}`);
}

function clearSelectionOf(ctx, ids) {
  const before = ctx.state.selection.size;
  for (const id of ids) ctx.state.selection.delete(id);
  if (before !== ctx.state.selection.size) ctx.render();
}

export async function addNoteFor(ctx, item) {
  await createNote(ctx, { title: `Notes on ${item.title}`, content: '', url: item.url || '', collectionId: item.collectionId || '', relatedIds: [item.id] });
}

function exportItems(ctx, ids, kind) {
  const items = ids.map(byId(ctx)).filter(Boolean);
  if (!items.length) return;
  // Only the collections these items live in (and their parents), so the file has no empty folders.
  const used = new Set(items.flatMap(item => item.collectionId ? ctx.select.path(item.collectionId).map(c => c.id) : []));
  const library = { ...ctx.library, items, collections: (ctx.library?.collections || []).filter(c => used.has(c.id)) };
  const base = `still-${viewMeta(ctx).title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export'}`;
  if (kind === 'html') {
    if (!items.some(item => item.url)) { ctx.toast('None of these items has a link to export.'); return; }
    download(exportBookmarkHtml(library), `${base}.html`, 'text/html');
  } else download(exportNotesMarkdown(library), `${base}.md`, 'text/markdown');
  ctx.toast(`Exported ${label(items.length)}`);
}

function exportMenu(ctx, anchor, ids) {
  ctx.openMenu(anchor, [
    { label: 'Bookmarks file (HTML)', icon: 'bookmark', run: () => ctx.run(() => exportItems(ctx, ids, 'html')) },
    { label: 'Notes and highlights (Markdown)', icon: 'file-down', run: () => ctx.run(() => exportItems(ctx, ids, 'md')) },
  ], { label: 'Export' });
}

function askAboutView(ctx) {
  const id = collectionOf(ctx.state.view);
  if (id) return askAi(ctx, { scope: 'collection', collectionId: id });
  if (ctx.state.view === 'all' && !ctx.state.query) return askAi(ctx, { scope: 'library' });
  return askAi(ctx, { scope: 'items', ids: viewRows(ctx).slice(0, 200).map(item => item.id) });
}

function selectAll(ctx) {
  ctx.state.selection = new Set(viewRows(ctx).map(item => item.id));
  ctx.render();
}

function toggleSelected(ctx, id, { range = false } = {}) {
  const u = ui(ctx);
  const selection = new Set(ctx.state.selection);
  if (range && u.anchorId) {
    for (const rid of selectRange(viewRows(ctx).map(item => item.id), u.anchorId, id)) selection.add(rid);
  } else {
    if (selection.has(id)) selection.delete(id); else selection.add(id);
    u.anchorId = id;
  }
  ctx.state.selection = selection;
  ctx.render();
}

/** Context menu for one item, or for the whole selection when the item is part of a multi-selection. */
export function openItemMenu(ctx, id, anchor) {
  const item = ctx.select.byId(id);
  if (!item) return;
  const selected = ctx.state.selection;
  if (selected.size > 1 && selected.has(id)) return openSelectionMenu(ctx, [...selected], anchor);
  const ids = [id];
  let items;
  if (item.deletedAt) {
    items = [
      { label: 'Restore', icon: 'rotate-ccw', run: () => ctx.run(() => restoreItems(ctx, ids)) },
      { label: 'Open', icon: 'panel-right-open', run: () => ctx.openItem(id) },
      { separator: true },
      { label: 'Delete forever', icon: 'trash-2', danger: true, run: () => ctx.run(() => deleteForever(ctx, ids)) },
    ];
  } else {
    items = [
      { label: 'Open', icon: 'panel-right-open', run: () => ctx.openItem(id) },
      item.url && { label: 'Open in new tab', icon: 'external-link', action: 'app.open-url', data: { url: item.url } },
      item.url && { label: 'Copy link', icon: 'link', action: 'app.copy', data: { text: item.url, done: 'Link copied' } },
      { label: 'Edit details', icon: 'pencil', run: () => ctx.openItem(id, { tab: 'details' }) },
      { separator: true },
      { label: 'Move to…', icon: 'folder-input', run: () => moveItems(ctx, ids, anchor) },
      { label: 'Add tags…', icon: 'tag', run: () => ctx.run(() => tagItems(ctx, ids)) },
      { label: item.favorite ? 'Remove from favorites' : 'Add to favorites', icon: 'star', run: () => ctx.run(() => setFavorite(ctx, ids, !item.favorite, { quiet: true })) },
      item.type !== 'note' && { label: 'Add note', icon: 'notebook-pen', run: () => ctx.run(() => addNoteFor(ctx, item)) },
      { label: 'Ask AI about this', icon: 'sparkles', run: () => askAi(ctx, { scope: 'item', ids }) },
      { separator: true },
      { label: item.archived ? 'Unarchive' : 'Archive', icon: item.archived ? 'archive-restore' : 'archive', run: () => ctx.run(() => setArchived(ctx, ids, !item.archived)) },
      { label: 'Delete', icon: 'trash-2', danger: true, hint: 'Moves to Trash', run: () => ctx.run(() => trashItems(ctx, ids)) },
    ].filter(Boolean);
  }
  ctx.openMenu(anchor, items, { label: `Actions for ${item.title}` });
}

function openSelectionMenu(ctx, ids, anchor) {
  const items = ids.map(byId(ctx)).filter(Boolean);
  const n = items.length;
  if (ctx.state.view === 'trash' || items.every(item => item.deletedAt)) {
    return ctx.openMenu(anchor, [
      { heading: `${n} selected` },
      { label: 'Restore', icon: 'rotate-ccw', run: () => ctx.run(() => restoreItems(ctx, ids)) },
      { separator: true },
      { label: 'Delete forever', icon: 'trash-2', danger: true, run: () => ctx.run(() => deleteForever(ctx, ids)) },
    ], { label: `${n} selected` });
  }
  const allFavorite = items.every(item => item.favorite);
  const archived = items.every(item => item.archived);
  ctx.openMenu(anchor, [
    { heading: `${n} selected` },
    { label: 'Move to…', icon: 'folder-input', run: () => moveItems(ctx, ids, anchor) },
    { label: 'Add tags…', icon: 'tag', run: () => ctx.run(() => tagItems(ctx, ids)) },
    { label: allFavorite ? 'Remove from favorites' : 'Add to favorites', icon: 'star', run: () => ctx.run(() => setFavorite(ctx, ids, !allFavorite)) },
    { label: 'Ask AI about these', icon: 'sparkles', run: () => askAi(ctx, { scope: 'items', ids }) },
    { label: 'Export…', icon: 'download', run: () => exportMenu(ctx, anchor, ids) },
    { separator: true },
    { label: archived ? 'Unarchive' : 'Archive', icon: archived ? 'archive-restore' : 'archive', run: () => ctx.run(() => setArchived(ctx, ids, !archived)) },
    { label: 'Delete', icon: 'trash-2', danger: true, hint: 'Moves to Trash', run: () => ctx.run(() => trashItems(ctx, ids)) },
  ], { label: `${n} selected` });
}

function openViewMenu(ctx, anchor) {
  const { state } = ctx;
  const view = state.view;
  const side = !!anchor.closest?.('[data-surface="side"]');
  const id = collectionOf(view);
  const rows = viewRows(ctx);
  const ids = rows.map(item => item.id);
  const mappable = !['trash', 'archive', 'duplicates'].includes(view);
  const entries = [
    { label: 'Ask AI about this view', icon: 'sparkles', run: () => askAboutView(ctx) },
    id && { label: 'Edit collection…', icon: 'pencil', run: () => openCollectionEditor(ctx, { id }) },
    id && { label: 'New collection inside…', icon: 'folder-plus', run: () => openCollectionEditor(ctx, { parentId: id }) },
    mappable && { label: 'Show on knowledge map', icon: 'waypoints', run: () => { setMapScope(ctx, id || (view === 'inbox' ? 'inbox' : '')); ctx.navigate('map'); } },
    side && { separator: true },
    side && { heading: 'Sort by' },
    ...(side ? SORT_OPTIONS.map(option => ({ label: option.label, checked: state.sort === option.value, run: () => { state.sort = option.value; ctx.render(); } })) : []),
    { separator: true },
    rows.length && { label: state.selectMode ? 'Stop selecting' : 'Select items', icon: 'square-check', run: () => { state.selectMode = !state.selectMode; if (!state.selectMode) state.selection = new Set(); ctx.render(); } },
    rows.length && { label: 'Select all', icon: 'list-checks', hint: rows.length.toLocaleString(), run: () => selectAll(ctx) },
    rows.length && { label: 'Export…', icon: 'download', run: () => exportMenu(ctx, anchor, ids) },
    side && { label: 'Open in full tab', icon: 'external-link', action: 'app.open-full' },
    view === 'trash' && rows.length && { separator: true },
    view === 'trash' && rows.length && { label: 'Empty trash…', icon: 'trash-2', danger: true, run: () => ctx.run(() => emptyTrash(ctx)) },
  ].filter(Boolean);
  while (entries[0]?.separator) entries.shift();
  while (entries.at(-1)?.separator) entries.pop();
  ctx.openMenu(anchor, entries.filter((entry, i) => !(entry.separator && entries[i - 1]?.separator)), { label: 'View options', placement: 'bottom-end' });
}

async function addHere(ctx, collectionId) {
  if (!ctx.env.isExtension) return openAdd(ctx, { collectionId });
  let result;
  try {
    result = await ctx.chrome('saveCurrentTab', { collectionId });
  } catch {
    return openAdd(ctx, { collectionId });
  }
  const item = result?.item || result;
  if (!item?.id) return openAdd(ctx, { collectionId });
  if (collectionId) ctx.prefs.touchCollection?.(collectionId);
  const created = result?.created ?? false;
  ctx.toast(`Saved to ${collectionName(ctx, collectionId)}`, {
    tone: 'success',
    action: created ? { label: 'Undo', run: () => ctx.store.deleteItem(item.id) } : { label: 'Open', run: () => ctx.openItem(item.id) },
  });
}

function moveFocus(card, target) {
  if (!target) return;
  card.setAttribute('tabindex', '-1');
  target.setAttribute('tabindex', '0');
  target.focus();
  target.scrollIntoView({ block: 'nearest' });
}

function neighbour(cards, index, key, gridLike) {
  if (key === 'Home') return cards[0];
  if (key === 'End') return cards.at(-1);
  if (!gridLike) return key === 'ArrowDown' ? cards[index + 1] : key === 'ArrowUp' ? cards[index - 1] : null;
  if (key === 'ArrowRight') return cards[index + 1];
  if (key === 'ArrowLeft') return cards[index - 1];
  const from = cards[index].getBoundingClientRect();
  const cx0 = from.left + from.width / 2;
  let best = null, score = Infinity;
  for (const card of cards) {
    if (card === cards[index]) continue;
    const r = card.getBoundingClientRect();
    const below = key === 'ArrowDown' ? r.top >= from.bottom - 4 : r.bottom <= from.top + 4;
    if (!below) continue;
    const dy = key === 'ArrowDown' ? r.top - from.bottom : from.top - r.bottom;
    const s = Math.abs(r.left + r.width / 2 - cx0) * 2 + dy;
    if (s < score) { score = s; best = card; }
  }
  return best;
}

let searchTimer = 0;
registerActions({
  'library.sort-menu': ({ ctx, el }) => ctx.openMenu(el, SORT_OPTIONS.map(option => ({ label: option.label, checked: ctx.state.sort === option.value, run: () => { ctx.state.sort = option.value; ctx.render(); } })), { label: 'Sort by', placement: 'bottom-end' }),
  'library.layout': async ({ ctx, el, data }) => {
    const surface = el.closest('[data-surface]')?.dataset.surface === 'side' ? 'side' : 'full';
    const key = surface === 'side' ? 'sideLayouts' : 'layouts';
    const view = ctx.state.view;
    ui(ctx).layouts[`${surface}:${view}`] = data.value;
    ctx.render();
    const saved = ctx.library?.settings?.[key] || {};
    if (saved[view] !== data.value) await ctx.store.updateSettings({ [key]: { ...saved, [view]: data.value } });
  },
  'library.seg-key': ({ event }) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const radios = [...event.target.closest('[role="radiogroup"]')?.querySelectorAll('[role="radio"]') || []];
    const index = radios.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? radios[0] : event.key === 'End' ? radios.at(-1) : radios[(index + (event.key === 'ArrowRight' ? 1 : -1) + radios.length) % radios.length];
    next.focus();
    next.click();
  },
  'library.select-mode': ({ ctx }) => {
    ctx.state.selectMode = !ctx.state.selectMode;
    if (!ctx.state.selectMode) ctx.state.selection = new Set();
    ctx.render();
  },
  'library.view-menu': ({ ctx, el }) => openViewMenu(ctx, el),
  'library.type-filter': ({ ctx, data }) => { ctx.state.typeFilter = ctx.state.typeFilter === data.value ? 'all' : data.value; ctx.syncUrl?.(); ctx.render(); },
  'library.tag-filter': ({ ctx, data }) => {
    const same = ctx.state.tagFilter.toLowerCase() === String(data.tag).toLowerCase();
    ctx.state.tagFilter = same ? '' : data.tag;
    ui(ctx).noTags = false;
    ctx.syncUrl?.();
    ctx.render();
  },
  'library.filter-tag': ({ ctx, data }) => {
    if (ctx.state.view === `tag:${data.tag}`) return;
    ctx.state.tagFilter = data.tag;
    ui(ctx).noTags = false;
    ctx.syncUrl?.();
    ctx.render();
  },
  'library.no-tags': ({ ctx }) => { const u = ui(ctx); u.noTags = !u.noTags; ctx.state.tagFilter = ''; ctx.render(); },
  'library.clear-filters': ({ ctx }) => { Object.assign(ctx.state, { typeFilter: 'all', tagFilter: '' }); ui(ctx).noTags = false; ctx.syncUrl?.(); ctx.render(); },
  'library.toggle-select': ({ ctx, data, event }) => toggleSelected(ctx, data.id, { range: !!event?.shiftKey }),
  'library.select-all': ({ ctx }) => selectAll(ctx),
  'library.clear-selection': ({ ctx }) => { ctx.state.selection = new Set(); ctx.render(); },
  'library.bulk-move': ({ ctx, el }) => moveItems(ctx, [...ctx.state.selection], el),
  'library.bulk-tag': ({ ctx }) => tagItems(ctx, [...ctx.state.selection]),
  'library.bulk-favorite': ({ ctx }) => {
    const ids = [...ctx.state.selection];
    return setFavorite(ctx, ids, !ids.every(id => ctx.select.byId(id)?.favorite));
  },
  'library.bulk-archive': ({ ctx }) => {
    const ids = [...ctx.state.selection];
    return setArchived(ctx, ids, !ids.every(id => ctx.select.byId(id)?.archived));
  },
  'library.bulk-delete': ({ ctx }) => trashItems(ctx, [...ctx.state.selection]),
  'library.bulk-restore': ({ ctx }) => restoreItems(ctx, [...ctx.state.selection]),
  'library.bulk-delete-forever': ({ ctx }) => deleteForever(ctx, [...ctx.state.selection]),
  'library.bulk-ask': ({ ctx }) => askAi(ctx, { scope: 'items', ids: [...ctx.state.selection] }),
  'library.bulk-export': ({ ctx, el }) => exportMenu(ctx, el, [...ctx.state.selection]),
  'library.favorite': ({ ctx, data }) => {
    const item = ctx.select.byId(data.id);
    if (item) return ctx.store.updateItem(item.id, { favorite: !item.favorite });
  },
  'library.item-menu': ({ ctx, el, data }) => openItemMenu(ctx, data.id, el),
  'library.restore': ({ ctx, data }) => restoreItems(ctx, [data.id]),
  'library.delete-forever': ({ ctx, data }) => deleteForever(ctx, [data.id]),
  'library.unarchive': ({ ctx, data }) => setArchived(ctx, [data.id], false),
  'library.empty-trash': ({ ctx }) => emptyTrash(ctx),
  'library.show-more': ({ ctx }) => { ui(ctx).limit += PAGE; ctx.render(); },
  'library.add': ({ ctx, data }) => openAdd(ctx, { collectionId: data.collection || '' }),
  'library.new-note': ({ ctx, data }) => createNote(ctx, { title: '', content: '', collectionId: data.collection || '' }),
  'library.add-here': ({ ctx, data }) => addHere(ctx, data.collection || ''),
  'library.side-back': ({ ctx }) => {
    const stack = ctx.state.sideStack.slice(0, -1);
    ctx.state.sideStack = stack;
    if (stack.length) { ctx.navigate(stack.at(-1)); return; }
    Object.assign(ctx.state, { view: 'all', query: '', typeFilter: 'all', tagFilter: '', selectMode: false, selection: new Set() });
    ctx.render();
  },
  'library.side-search': ({ ctx }) => {
    const u = ui(ctx);
    u.sideSearch = !u.sideSearch;
    if (!u.sideSearch && ctx.state.query) ctx.state.query = '';
    ctx.render();
    if (u.sideSearch) ctx.nextFrame(() => document.getElementById('lib-side-search')?.focus());
  },
  'library.search': ({ ctx, el }) => {
    clearTimeout(searchTimer);
    const value = el.value;
    searchTimer = setTimeout(() => { ctx.state.query = value; ctx.syncUrl?.(); ctx.render(); }, 120);
  },
  'library.clear-search': ({ ctx }) => {
    ctx.state.query = '';
    ctx.syncUrl?.();
    ctx.render();
    ctx.nextFrame(() => (document.getElementById('lib-side-search') || document.getElementById('search'))?.focus());
  },
  'library.dupe-keep': async ({ ctx, data }) => {
    const group = ctx.select.duplicates().find(g => g.url === data.url);
    if (!group) return;
    const at = nowIso();
    await applyChanges(ctx, group.items.slice(1).map(item => ({ id: item.id, patch: { deletedAt: at } })), `Kept the newest copy and moved ${label(group.items.length - 1, 'copy', 'copies')} to Trash`);
  },
  'library.dupe-merge': async ({ ctx, data }) => {
    const group = ctx.select.duplicates().find(g => g.url === data.url);
    if (!group) return;
    await applyChanges(ctx, planMerge(group.items, ctx.library?.items || []), `Merged ${label(group.items.length, 'copy', 'copies')} into one`);
  },
  'library.keys': ({ ctx, el, event }) => {
    const card = event.target;
    if (!card?.matches?.('[data-item-card]')) return;
    const id = card.dataset.id;
    const key = event.key;
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
      const cards = [...el.querySelectorAll('[data-item-card]')];
      const layout = el.closest('[data-layout]')?.dataset.layout;
      const gridLike = ['cards', 'masonry'].includes(layout) && !(layout === 'cards' && el.closest('[data-surface="side"]'));
      const target = neighbour(cards, cards.indexOf(card), key, gridLike);
      if (!target) return;
      event.preventDefault();
      moveFocus(card, target);
      if (event.shiftKey) {
        const u = ui(ctx);
        u.anchorId ||= id;
        ctx.state.selection = new Set([...ctx.state.selection, ...selectRange(viewRows(ctx).map(item => item.id), u.anchorId, target.dataset.id)]);
        ctx.render();
      }
      return;
    }
    if (key === 'Enter') { event.preventDefault(); ctx.openItem(id); return; }
    if (key === ' ') { event.preventDefault(); toggleSelected(ctx, id, { range: event.shiftKey }); return; }
    if (key === 'Escape' && ctx.state.selection.size) { event.preventDefault(); ctx.state.selection = new Set(); ctx.render(); return; }
    if (key === 'Delete' || (key === 'Backspace' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      const ids = ctx.state.selection.size ? [...ctx.state.selection] : [id];
      if (ctx.state.view === 'trash') deleteForever(ctx, ids); else trashItems(ctx, ids);
      return;
    }
    if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey)) { event.preventDefault(); openItemMenu(ctx, id, card); }
  },
});

registerShortcuts([
  { keys: 'escape', action: 'library.clear-selection', label: 'Clear the selection', when: ctx => ctx.state.selection.size > 0 && !ctx.state.dialogs.length && !ctx.state.popover },
  { keys: 'mod+a', action: 'library.select-all', label: 'Select all items in the list', when: () => !!document.activeElement?.closest?.('.lib-scroll') },
]);

registerMount('library.more', (el, ctx) => {
  if (typeof IntersectionObserver !== 'function') return null;
  const observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    observer.disconnect();
    ui(ctx).limit += PAGE;
    ctx.render();
  }, { rootMargin: '0px 0px 800px 0px' });
  observer.observe(el);
  return { destroy: () => observer.disconnect() };
});

const modPressed = (ctx, event) => ctx.env.isMac ? event.metaKey : event.ctrlKey;
const inApp = el => !!el?.closest?.('#app');

export function init(ctx) {
  appCtx = ctx;
  watchBrokenCovers(() => appCtx.render());
  document.addEventListener('mousedown', event => {
    if (event.shiftKey && event.target.closest?.('[data-item-card]')) event.preventDefault();
  }, true);
  // Shift and Cmd/Ctrl clicks select instead of opening; this runs before the runtime's click delegation.
  document.addEventListener('click', event => {
    const card = event.target.closest?.('[data-item-card]');
    if (!card || !inApp(card)) return;
    const link = event.target.closest('a.note-link[data-id]');
    if (link) { event.preventDefault(); event.stopPropagation(); appCtx.openItem(link.dataset.id); return; }
    const inner = event.target.closest('[data-action], a[href], button, input, textarea, select, label, summary');
    if (inner && inner !== card) return;
    const id = card.dataset.id;
    if (!(event.shiftKey || modPressed(appCtx, event) || appCtx.state.selectMode)) { ui(appCtx).anchorId = id; return; }
    event.preventDefault();
    event.stopPropagation();
    toggleSelected(appCtx, id, { range: event.shiftKey });
  }, true);
  document.addEventListener('contextmenu', event => {
    const card = event.target.closest?.('[data-item-card]');
    if (!card || !inApp(card) || event.target.closest('a[href]:not([href="#"]), input, textarea')) return;
    event.preventDefault();
    openItemMenu(appCtx, card.dataset.id, { x: event.clientX, y: event.clientY });
  });
  document.addEventListener('focusin', event => {
    const card = event.target;
    if (!card?.matches?.('[data-item-card]') || !inApp(card)) return;
    ui(appCtx).focusId = card.dataset.id;
    for (const other of card.closest('.lib-scroll')?.querySelectorAll('[data-item-card][tabindex="0"]') || []) if (other !== card) other.setAttribute('tabindex', '-1');
    card.setAttribute('tabindex', '0');
  });
}
