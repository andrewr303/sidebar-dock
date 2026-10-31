// Links folder widget: a collection's web links as app-style tiles, the dashboard's home-screen folder. At 2×2 it is a
// folder icon (three peeking site icons, name and count) that opens an anchored popup; larger it is a frosted panel
// of white icon tiles. The links are the library's own items, so adding, renaming, moving or deleting one here changes
// the collection everywhere in Still. The widget keeps only references in its config (collection id, manual order).
import { html, cx, plural, safeHref } from '../html.js';
import { icon } from '../icons.js';
import { registerActions, registerMount } from '../runtime.js';
import { registerPopover } from '../overlay.js';
import { button, select, segmented, switchToggle, field, input, emptyState } from '../components.js';
import { renderCollectionPickerTrigger, openCollectionPicker, colorForName } from '../pickers.js';
import { moveItems, trashItems } from '../library.js';
import { defineWidget } from '../dashboard/registry.js';
// Namespace import: the dashboard module imports every widget, so its exports are read only when a user acts.
import * as dashboardView from '../dashboard/index.js';
import * as dashboardStore from '../../lib/dashboard-store.js';
import {
  folderConfig, folderLinks, orderLinks, placeBefore, shiftId, planLinkChanges, validateLinkRows, hasErrors, linkLabel, hostOf, isLinkItem, popoverArrow,
} from './links/model.js';
import {
  OPEN_IN_OPTIONS, openAll, anchorTarget, copyLink, openMenuItems, tidyMenu, stableAnchor, openLinkForm, toRows, rowKey, renderLinkRows, focusFirstError,
  registerLinkGrid, rovingStop, initLinkGrids,
} from './links/shared.js';
import { tileIcon } from './links/favicons.js';

const TYPE = 'links-folder';
const POPUP = 'w.links-folder.popup';
const EDIT = '_linksEditor';   // settings editor state kept on the settings draft (removed before saving)
const SORT_OPTIONS = [
  { value: 'manual', label: 'Manual (drag to arrange)', short: 'Manual' },
  { value: 'title', label: 'Title A to Z', short: 'Title A to Z' },
  { value: 'newest', label: 'Newest first', short: 'Newest first' },
  { value: 'oldest', label: 'Oldest first', short: 'Oldest first' },
];
const ICON_SIZE = { md: 36, lg: 44 };

/* ------------------------------------------------------------------ data */

// Folder rows are memoized per library snapshot (ctx.select.live() changes identity when the library does).
const memo = new WeakMap();
function linksOf(ctx, collectionIds, config) {
  const live = ctx.select.live();
  let cache = memo.get(live);
  if (!cache) { cache = new Map(); memo.set(live, cache); }
  const key = `${collectionIds.join(',')}|${config.sort}|${config.order.join(',')}`;
  if (!cache.has(key)) cache.set(key, orderLinks(folderLinks(live, collectionIds), config));
  return cache.get(key);
}

/** Everything a render needs: { config, collection, links, title, collectionIds }. */
function folderState(ctx, widget) {
  const config = folderConfig(widget.config);
  const collection = config.collectionId ? ctx.select.collection(config.collectionId) : null;
  const collectionIds = collection ? (config.includeSubcollections ? ctx.select.descendants(collection.id) : [collection.id]) : [];
  return { config, collection, collectionIds, links: collection ? linksOf(ctx, collectionIds, config) : [], title: widget.title || collection?.name || 'Links folder' };
}

const stateFor = (ctx, widgetId) => {
  const found = dashboardStore.findWidget(widgetId);
  return found ? { widget: found.widget, ...folderState(ctx, found.widget) } : null;
};
const setConfig = (widgetId, patch) => dashboardStore.updateWidgetConfig(widgetId, patch);

/** Something on screen to anchor a popover for this widget: its add tile, folder tile or frame. */
function anchorFor(widgetId) {
  const id = CSS.escape(widgetId);
  return [`[data-links-grid="${id}"] [data-link-add]`, `.w-links-folder-folder[data-widget="${id}"]`, `[data-widget-id="${id}"]`, `[data-lf="${id}"]`]
    .map(selector => document.querySelector(selector)).find(el => el?.isConnected) || document.getElementById('main') || document.body;
}

/* ------------------------------------------------------------------ writes */

/** Saves (or moves) a link into the collection without clobbering an existing item's title or type. Returns its id. */
async function saveLink(ctx, { url, title }, collectionId, { skip = new Set() } = {}) {
  const existing = ctx.select.savedForUrl(url);
  if (existing && !skip.has(existing.id)) {
    const patch = {};
    if ((existing.collectionId || '') !== collectionId) patch.collectionId = collectionId;
    if (existing.archived) patch.archived = false;
    if (title && title !== existing.title) patch.title = title;
    if (Object.keys(patch).length) await ctx.store.updateItem(existing.id, patch);
    return { id: existing.id, status: patch.collectionId ? 'moved' : 'already', previous: existing };
  }
  const saved = await ctx.store.saveItem({ type: 'bookmark', url, ...(title ? { title } : {}), collectionId });
  return { id: saved.id, status: 'created', previous: null };
}

const displayedIds = (ctx, widgetId) => stateFor(ctx, widgetId)?.links.map(item => item.id) || [];

async function saveOrder(ctx, widgetId, order) {
  const current = stateFor(ctx, widgetId);
  if (!current) return;
  const same = current.config.sort === 'manual' && order.join() === current.links.map(item => item.id).join();
  if (!same) await setConfig(widgetId, { sort: 'manual', order });
}

/** Adds links (from the add form or a drop) at beforeId ('' = end), with one summary toast that can undo it. */
async function addLinks(ctx, widgetId, links, beforeId = '') {
  const s = stateFor(ctx, widgetId);
  if (!s?.collection) throw new Error('Choose a collection for this folder first.');
  const ids = [];
  const results = [];
  for (const link of links) {
    const existing = ctx.select.savedForUrl(link.url);
    if (existing && isLinkItem(existing) && s.collectionIds.includes(existing.collectionId)) { ids.push(existing.id); results.push({ id: existing.id, status: 'already' }); continue; }
    const result = await saveLink(ctx, link, s.collection.id);
    ids.push(result.id);
    results.push(result);
  }
  if (s.config.sort === 'manual' || beforeId) await saveOrder(ctx, widgetId, placeBefore(displayedIds(ctx, widgetId), ids, beforeId));
  ctx.prefs.touchCollection?.(s.collection.id);
  const changed = results.filter(r => r.status !== 'already');
  const name = s.collection.name;
  if (!changed.length) { ctx.toast(results.length > 1 ? `Those links are already in ${name}` : `That link is already in ${name}`); return; }
  const undo = async () => {
    for (const r of changed) {
      if (r.status === 'created') await ctx.store.permanentlyDeleteItem(r.id);
      else await ctx.store.updateItem(r.id, { collectionId: r.previous.collectionId || '', archived: r.previous.archived === true });
    }
  };
  const one = changed.length === 1 ? linkLabel(ctx.select.byId(changed[0].id) || links[0]) : '';
  const message = changed.length > 1 ? `Added ${plural(changed.length, 'link')} to ${name}`
    : changed[0].status === 'moved' ? `Moved “${one}” to ${name}` : `Added “${one}” to ${name}`;
  ctx.toast(message, { tone: 'success', action: { label: 'Undo', run: undo } });
}

/** Still items dropped from another folder or the library: move them in, at the drop position. */
async function moveIntoFolder(ctx, widgetId, itemIds, beforeId = '') {
  const s = stateFor(ctx, widgetId);
  if (!s?.collection) return;
  const items = itemIds.map(id => ctx.select.byId(id)).filter(item => item && !item.deletedAt);
  const linkItems = items.filter(isLinkItem);
  if (!linkItems.length) { if (items.length) ctx.toast('Only links can go in a links folder. Notes and files stay where they are.'); return; }
  const moving = linkItems.filter(item => !s.collectionIds.includes(item.collectionId));
  if (moving.length) await ctx.store.bulkUpdateItems(moving.map(item => ({ id: item.id, patch: { collectionId: s.collection.id, archived: false } })));
  await saveOrder(ctx, widgetId, placeBefore(displayedIds(ctx, widgetId), linkItems.map(item => item.id), beforeId));
  if (!moving.length) return;
  const previous = moving.map(item => ({ id: item.id, patch: { collectionId: item.collectionId || '', archived: item.archived === true } }));
  ctx.toast(moving.length > 1 ? `Moved ${plural(moving.length, 'link')} to ${s.collection.name}` : `Moved “${linkLabel(moving[0])}” to ${s.collection.name}`,
    { tone: 'success', action: { label: 'Undo', run: () => ctx.store.bulkUpdateItems(previous) } });
}

async function removeFromFolder(ctx, item) {
  const previous = item.collectionId || '';
  await ctx.store.updateItem(item.id, { collectionId: '' });
  ctx.toast(`Moved “${linkLabel(item)}” to Inbox`, { action: { label: 'Undo', run: () => ctx.store.updateItem(item.id, { collectionId: previous }) } });
}

async function createCollectionFor(ctx, widgetId) {
  const name = (await ctx.prompt({ title: 'Create a collection', label: 'Collection name', placeholder: 'For example, Dev tools', confirmLabel: 'Create collection' }))?.trim();
  if (!name) return;
  const collection = await ctx.store.createCollection({ name, color: colorForName(name), icon: 'folder' });
  await setConfig(widgetId, { collectionId: collection.id, order: [] });
  ctx.toast(`Created ${name}. Add links with +, or drop them on the folder.`, { tone: 'success' });
}

function chooseCollection(ctx, widgetId, anchor) {
  const s = stateFor(ctx, widgetId);
  openCollectionPicker(ctx, anchor, {
    value: s?.collection?.id || '', allowInbox: false, title: 'Show links from',
    onPick: id => ctx.run(async () => { if (id) await setConfig(widgetId, { collectionId: id, order: [] }); }),
  });
}

function openSettings(ctx, widgetId) {
  if (typeof dashboardView.openWidgetSettings === 'function') return dashboardView.openWidgetSettings(ctx, widgetId);
  ctx.toast('Widget settings are not available right now.', { tone: 'danger' });
  return undefined;
}

/* ------------------------------------------------------------------ menus and forms */

function openAddForm(ctx, widgetId, anchor) {
  const s = stateFor(ctx, widgetId);
  if (!s) return;
  // From inside the 2×2 popup the form takes the popup's place, anchored to the folder itself.
  const target = anchor?.isConnected && !anchor.closest('#still-popover') ? anchor : anchorFor(widgetId);
  if (!s.collection) { chooseCollection(ctx, widgetId, target); return; }
  openLinkForm(ctx, target, {
    heading: `Add a link to ${s.title}`, submitLabel: 'Add link',
    onSubmit: link => addLinks(ctx, widgetId, [link], ''),
  });
}

function openEditForm(ctx, item, anchor) {
  openLinkForm(ctx, anchor, {
    heading: 'Edit link', url: item.url, title: item.title === hostOf(item.url) ? '' : item.title, submitLabel: 'Save link',
    onSubmit: async ({ url, title }) => {
      const patch = {};
      if (url !== item.url) patch.url = url;
      if ((title || hostOf(url)) !== item.title) patch.title = title;
      if (Object.keys(patch).length) await ctx.store.updateItem(item.id, patch);
    },
  });
}

function folderMenuItems(ctx, widget, { withSettings = false } = {}) {
  const s = folderState(ctx, widget);
  const settings = withSettings && { label: 'Edit folder…', icon: 'settings-2', run: () => openSettings(ctx, widget.id) };
  if (!s.collection) {
    return tidyMenu([
      { label: 'Choose a collection…', icon: 'folder', run: () => chooseCollection(ctx, widget.id, anchorFor(widget.id)) },
      { label: 'Create a collection…', icon: 'folder-plus', run: () => createCollectionFor(ctx, widget.id) },
      settings && { separator: true }, settings,
    ]);
  }
  return tidyMenu([
    { label: 'Add link…', icon: 'plus', run: () => openAddForm(ctx, widget.id) },
    s.links.length > 1 && { label: 'Open all in new tabs', icon: 'external-link', hint: s.links.length.toLocaleString(), run: () => openAll(ctx, s.links.map(item => item.url), { label: s.title }) },
    { label: 'Open collection in Still', icon: 'folder-open', run: () => ctx.navigate(`collection:${s.collection.id}`) },
    { separator: true },
    { heading: 'Sort' },
    ...SORT_OPTIONS.map(option => ({ label: option.short, checked: s.config.sort === option.value, run: () => setConfig(widget.id, { sort: option.value }) })),
    { separator: true },
    { label: 'Show labels', checked: s.config.showLabels, run: () => setConfig(widget.id, { showLabels: !s.config.showLabels }) },
    { label: 'Large tiles', checked: s.config.tileSize === 'lg', run: () => setConfig(widget.id, { tileSize: s.config.tileSize === 'lg' ? 'md' : 'lg' }) },
    settings && { separator: true }, settings,
  ]);
}

function openFolderMenu(ctx, widgetId, anchor) {
  const found = dashboardStore.findWidget(widgetId);
  if (!found) return;
  ctx.openMenu(anchor, folderMenuItems(ctx, found.widget, { withSettings: true }), { label: 'Folder options', placement: 'bottom-end' });
}

function openTileMenu(ctx, widgetId, id, anchor, gridKey) {
  const s = stateFor(ctx, widgetId);
  const item = ctx.select.byId(id);
  if (!s || !item) return;
  // Follow-up popovers anchor to the tile; inside the 2×2 popup (which the menu closes) they fall back to the folder.
  const tile = () => document.querySelector(`[data-links-grid="${CSS.escape(gridKey)}"] [data-link-id="${CSS.escape(id)}"]`) || anchorFor(widgetId);
  ctx.openMenu(stableAnchor(anchor), tidyMenu([
    ...openMenuItems(ctx, item.url, s.config.openIn),
    { separator: true },
    { label: 'Edit title and URL…', icon: 'pencil', run: () => openEditForm(ctx, item, tile()) },
    { label: 'Move to collection…', icon: 'folder-input', run: () => moveItems(ctx, [id], tile()) },
    item.collectionId && { label: 'Remove from folder', icon: 'inbox', hint: 'To Inbox', run: () => removeFromFolder(ctx, item) },
    { label: 'Copy link', icon: 'copy', run: () => copyLink(ctx, item.url) },
    { label: 'Open in Still', icon: 'panel-right-open', run: () => ctx.openItem(id) },
    { separator: true },
    { label: 'Delete', icon: 'trash-2', danger: true, run: () => trashItems(ctx, [id]) },
  ]), { label: `Options for ${linkLabel(item)}` });
}

/* ------------------------------------------------------------------ render */

function renderTile(widget, s, item, { gridKey, stop, popup }) {
  const label = linkLabel(item);
  const host = hostOf(item.url);
  const { openIn, showLabels, tileSize } = s.config;
  return html`<li class="w-links-cell" data-key="${item.id}" data-link-cell>
    <a class="w-links-link" href="${safeHref(item.url)}" ${anchorTarget(openIn)} data-action="w.links.open" data-open-in="${openIn}"
      data-link-tile data-tile-key="${item.id}" data-link-id="${item.id}" data-drag-item="${item.id}" draggable="true"
      data-focus-key="lf:${gridKey}:${item.id}" tabindex="${stop === item.id ? '0' : '-1'}" ${popup && stop === item.id ? html`data-autofocus` : ''}
      ${showLabels ? html`title="${label === host ? label : `${label} (${host})`}"` : html`aria-label="${label}" data-tooltip="${label}"`}>
      <span class="w-links-tile">${tileIcon(item.url, { size: ICON_SIZE[tileSize] })}</span>
      ${showLabels ? html`<span class="w-links-label">${label}</span>` : ''}
    </a>
    <button type="button" class="w-links-more" tabindex="-1" aria-label="Options for ${label}" data-action="w.links-folder.item-menu"
      data-widget="${widget.id}" data-id="${item.id}" data-grid="${gridKey}">${icon('ellipsis', { size: 14 })}</button>
  </li>`;
}

function renderGrid(widget, s, { gridKey, popup = false }) {
  const keys = [...s.links.map(item => item.id), 'add'];
  const stop = rovingStop(gridKey, keys);
  return html`<ul class="${cx('w-links-grid', popup && 'is-popup')}" role="list" aria-label="Links in ${s.title}" data-key="grid-${gridKey}"
    data-links-grid="${gridKey}" data-links-kind="folder" data-widget="${widget.id}" data-keydown="w.links.grid-key">
    ${s.links.map(item => renderTile(widget, s, item, { gridKey, stop, popup }))}
    <li class="w-links-cell is-add" data-key="add">
      <button type="button" class="w-links-link is-add" data-action="w.links-folder.add" data-widget="${widget.id}" data-link-tile data-link-add data-tile-key="add"
        data-focus-key="lf:${gridKey}:add" tabindex="${stop === 'add' ? '0' : '-1'}" ${popup && stop === 'add' ? html`data-autofocus` : ''} aria-label="Add a link to ${s.title}"
        ${s.config.showLabels ? '' : html`data-tooltip="Add a link"`}>
        <span class="w-links-tile">${icon('plus', { size: 22 })}</span>
        ${s.config.showLabels ? html`<span class="w-links-label">Add</span>` : ''}
      </button>
    </li>
  </ul>`;
}

function renderPanel(widget, s, env) {
  return html`<div class="${cx('w-links-folder', `is-${env.size}`)}" data-key="lf-panel-${widget.id}" data-lf="${widget.id}" data-link-icons data-tiles="${s.config.tileSize}"
    data-labels="${s.config.showLabels ? 'on' : 'off'}">
    <header class="w-links-folder-head"><h3 class="w-links-folder-title" title="${s.title}">${s.title}</h3></header>
    ${renderGrid(widget, s, { gridKey: widget.id })}
    ${s.links.length ? '' : html`<p class="w-links-folder-hint">Drop links here, or use + to add one.</p>`}
  </div>`;
}

function renderFolderTile(ctx, widget, s) {
  const peek = s.links.slice(0, 3);
  const pop = ctx.state.popover;
  const open = pop?.name === POPUP && pop.props.widgetId === widget.id;
  return html`<div class="w-links-folder-xs" data-key="lf-xs-${widget.id}" data-lf="${widget.id}" data-link-icons>
    <button type="button" class="w-links-folder-folder" data-action="w.links-folder.popup" data-keydown="w.links-folder.folder-key" data-widget="${widget.id}"
      data-links-menu="folder" aria-haspopup="dialog" aria-expanded="${open ? 'true' : 'false'}" aria-label="${s.title}, ${plural(s.links.length, 'link')}">
      <span class="w-links-folder-peek" data-count="${peek.length}" aria-hidden="true">${peek.map((item, i) => html`<span class="w-links-folder-peek-tile" data-i="${i}">${tileIcon(item.url, { size: 28 })}</span>`)}</span>
      <span class="w-links-folder-front" aria-hidden="true"><span class="w-links-folder-name">${s.title}</span><span class="w-links-folder-count">${s.links.length.toLocaleString()}</span></span>
    </button>
  </div>`;
}

function renderSetup(widget, s, env) {
  const missing = !!s.config.collectionId && !s.collection;
  const compact = env.size === 'xs' || env.h <= 2;
  return html`<div class="${cx('w-links-folder', 'is-setup', `is-${env.size}`)}" data-key="lf-setup-${widget.id}" data-lf="${widget.id}">
    ${emptyState({ icon: missing ? 'folder' : 'folder-plus', compact: true, className: 'w-links-folder-empty',
      title: missing ? 'This collection is gone' : 'Choose a collection',
      body: compact ? '' : missing ? 'It was deleted or merged. Pick another collection to show its links here.' : 'Show the links from one of your collections as a folder of tiles.',
      actions: html`${button({ label: missing ? 'Choose another' : 'Choose a collection', icon: 'folder', size: 'sm', action: 'w.links-folder.choose', data: { widget: widget.id } })}
        ${compact ? '' : button({ label: 'Create a collection', icon: 'plus', variant: 'ghost', size: 'sm', action: 'w.links-folder.create', data: { widget: widget.id } })}` })}
  </div>`;
}

function render(ctx, widget, env) {
  initLinkGrids(ctx);
  const s = folderState(ctx, widget);
  if (!s.collection) return renderSetup(widget, s, env);
  return env.size === 'xs' ? renderFolderTile(ctx, widget, s) : renderPanel(widget, s, env);
}

/** The 2×2 folder's popup: a three-column scrolling grid with an arrow pointing back at the folder. */
function renderPopup(ctx, { widgetId }) {
  const s = stateFor(ctx, widgetId);
  if (!s) return '';
  return html`<div class="w-links-folder-popup" role="dialog" aria-labelledby="lfp-title-${widgetId}" data-key="lfp-${widgetId}" data-mount="w.links-folder.arrow" data-link-icons
    data-tiles="md" data-labels="${s.config.showLabels ? 'on' : 'off'}">
    <span class="w-links-folder-arrow" aria-hidden="true"></span>
    <div class="w-links-folder-popup-head"><h2 class="w-links-folder-popup-title" id="lfp-title-${widgetId}">${s.title}</h2>
      <span class="w-links-folder-popup-count">${plural(s.links.length, 'link')}</span></div>
    ${renderGrid(s.widget, s, { gridKey: `${widgetId}:popup`, popup: true })}
  </div>`;
}

/* ------------------------------------------------------------------ settings */

let session = null; // { widgetId, draft } of the open settings dialog

function ownLinks(ctx, draft) {
  const config = folderConfig(draft);
  return config.collectionId ? orderLinks(folderLinks(ctx.select.live(), [config.collectionId]), config) : [];
}

/** The links editor's state for this draft; reloaded when the chosen collection changes (typed new rows are kept). */
function editState(ctx, widget, draft) {
  const collectionId = typeof draft.collectionId === 'string' ? draft.collectionId : '';
  let edit = draft[EDIT];
  if (!edit || edit.collectionId !== collectionId) {
    const collection = collectionId ? ctx.select.collection(collectionId) : null;
    const pending = (edit?.rows || []).filter(row => !row.id && (row.url.trim() || row.title.trim()));
    const rows = [...toRows(ownLinks(ctx, draft)), ...pending];
    // A new folder starts with one empty row to fill in, like the add form.
    if (!collectionId && !rows.length) rows.push({ key: rowKey(), id: '', url: '', title: '' });
    edit = { collectionId, name: collection?.name || edit?.name || '', nameError: '', rows, errors: {} };
    draft[EDIT] = edit;
  }
  session = { widgetId: widget.id, draft };
  return edit;
}

function renderSettings(ctx, widget, draft) {
  const edit = editState(ctx, widget, draft);
  const config = folderConfig(draft);
  const collection = config.collectionId ? ctx.select.collection(config.collectionId) : null;
  const id = `lf-${widget.id}`;
  const nameChanged = collection && edit.name.trim() && edit.name.trim() !== collection.name;
  return html`<div class="w-links-settings" data-key="lf-settings-${widget.id}">
    <div class="w-links-settings-fields is-pair">
      ${field({ label: 'Folder name', id: `${id}-name`, error: edit.nameError,
        hint: collection ? (nameChanged ? `Renames the collection “${collection.name}” everywhere in Still.` : 'Renaming the folder renames its collection everywhere in Still.') : 'Saving creates a collection with this name.',
        control: input({ id: `${id}-name`, value: edit.name, placeholder: collection?.name || 'For example, Dev tools', action: 'w.links-folder.settings-name',
          invalid: !!edit.nameError, describedBy: edit.nameError ? `${id}-name-error` : `${id}-name-hint` }) })}
      ${field({ label: 'Collection', hint: collection ? 'The folder shows the links saved in this collection.' : 'Or show an existing collection instead.', id: `${id}-collection`,
        control: renderCollectionPickerTrigger({ ctx, value: config.collectionId, action: 'w.links-folder.settings-collection', id: `${id}-collection`,
          allowInbox: false, placeholder: 'New collection', label: 'Collection', className: 'w-links-settings-picker' }) })}
    </div>
    <div class="w-links-settings-fields">
      ${field({ label: 'Open links in', id: `${id}-open`, control: select({ name: 'openIn', id: `${id}-open`, value: config.openIn, options: OPEN_IN_OPTIONS, action: 'w.links-folder.settings-field', className: 'is-block' }) })}
      ${field({ label: 'Sort', id: `${id}-sort`, control: select({ name: 'sort', id: `${id}-sort`, value: config.sort, options: SORT_OPTIONS, action: 'w.links-folder.settings-field', className: 'is-block' }) })}
      ${field({ label: 'Tile size', control: segmented({ name: 'tileSize', value: config.tileSize, ariaLabel: 'Tile size', action: 'w.links-folder.settings-field',
        options: [{ value: 'md', label: 'Medium' }, { value: 'lg', label: 'Large' }] }) })}
    </div>
    <div class="w-links-settings-switches">
      ${switchToggle({ label: 'Show labels under icons', name: 'showLabels', checked: config.showLabels, action: 'w.links-folder.settings-field' })}
      ${switchToggle({ label: 'Include links from subcollections', name: 'includeSubcollections', checked: config.includeSubcollections, action: 'w.links-folder.settings-field',
        description: 'Links saved in nested collections appear in this folder too.' })}
    </div>
    ${renderLinkRows(ctx, { key: id, state: edit, legend: 'Links', addLabel: 'Add link',
      emptyText: collection ? 'This collection has no links yet. Add some below, or drop links on the folder.' : 'Add the links this folder should hold.',
      hint: config.includeSubcollections ? 'Links saved in subcollections show in the folder but are edited in their own collection.' : '' })}
  </div>`;
}

/** Runs before saving: marks invalid link rows and a missing name inline (the dialog then focuses the first one). */
function validateSettings(draft) {
  const edit = draft?.[EDIT];
  if (!edit) return {};
  edit.errors = validateLinkRows(edit.rows).errors;
  edit.nameError = !draft.collectionId && !edit.name.trim() ? 'Name the folder, or choose a collection to show.' : '';
  const errors = Object.fromEntries(Object.entries(edit.errors).map(([index, message]) => [`links.${index}`, message]));
  if (edit.nameError) errors.name = edit.nameError;
  return errors;
}

async function onSettingsSave(ctx, widget, draft) {
  const config = folderConfig(draft);
  const edit = draft[EDIT];
  if (!edit) return config;
  const collection = config.collectionId ? ctx.select.collection(config.collectionId) : null;
  const name = edit.name.trim();
  const plan = planLinkChanges(collection ? folderLinks(ctx.select.live(), [collection.id]) : [], edit.rows);
  edit.errors = plan.errors;
  edit.nameError = !collection && !name ? 'Name the folder, or choose a collection to show.' : '';
  if (edit.nameError || hasErrors(plan)) {
    ctx.render();
    if (edit.nameError) ctx.nextFrame(() => document.getElementById(`lf-${widget.id}-name`)?.focus());
    else focusFirstError(ctx, `lf-${widget.id}`);
    throw new Error(edit.nameError ? 'Name the folder or choose a collection, then save again.' : 'Fix the highlighted links, then save again.');
  }
  let collectionId = collection?.id;
  if (!collection) collectionId = (await ctx.store.createCollection({ name, color: colorForName(name), icon: 'folder' })).id;
  else if (name && name !== collection.name) await ctx.store.updateCollection(collection.id, { name });
  const at = new Date().toISOString();
  const trashed = new Set(plan.trash);
  const changes = [...plan.update, ...plan.trash.map(id => ({ id, patch: { deletedAt: at } }))];
  if (changes.length) await ctx.store.bulkUpdateItems(changes);
  const created = [];
  for (const entry of plan.create) created.push((await saveLink(ctx, entry, collectionId, { skip: trashed })).id);
  const sequence = plan.sequence.map(step => step.id || created[step.create]).filter(Boolean);
  const listed = new Set(sequence);
  const order = [...sequence, ...config.order.filter(id => !listed.has(id) && !trashed.has(id))];
  delete draft[EDIT];
  if (session?.draft === draft) session = null;
  if (plan.trash.length) {
    ctx.toast(`Moved ${plural(plan.trash.length, 'link')} to Trash`, { action: { label: 'Undo', run: () => ctx.store.bulkUpdateItems(plan.trash.map(id => ({ id, patch: { deletedAt: null } }))) } });
  }
  return { ...config, collectionId, order };
}

/* ------------------------------------------------------------------ definition and wiring */

registerLinkGrid('folder', {
  menu: (ctx, grid, id, anchor) => openTileMenu(ctx, grid.dataset.widget, id, anchor, grid.dataset.linksGrid),
  reorder: (ctx, grid, id, beforeId) => saveOrder(ctx, grid.dataset.widget, placeBefore(displayedIds(ctx, grid.dataset.widget), [id], beforeId)),
  shift: (ctx, grid, id, delta) => saveOrder(ctx, grid.dataset.widget, shiftId(displayedIds(ctx, grid.dataset.widget), id, delta)),
  dropItems: (ctx, grid, ids, beforeId) => moveIntoFolder(ctx, grid.dataset.widget, ids, beforeId),
  dropLinks: (ctx, grid, links, beforeId) => addLinks(ctx, grid.dataset.widget, links, beforeId),
  widgetMenu: (ctx, widgetId, point) => openFolderMenu(ctx, widgetId, point),
});

registerPopover(POPUP, renderPopup, { role: 'none', className: 'w-links-folder-popover' });

// Points the popup's arrow at the folder after every placement (the overlay may flip the popup above it).
registerMount('w.links-folder.arrow', (el, ctx) => {
  const position = () => {
    const pop = el.closest('.popover');
    const anchor = ctx.state.popover?.anchorEl;
    if (!pop || !anchor?.isConnected) return;
    const { edge, offset } = popoverArrow(anchor.getBoundingClientRect(), pop.getBoundingClientRect());
    el.dataset.edge = edge;
    el.style.setProperty('--arrow-x', `${offset}px`);
  };
  const off = ctx.onRendered(position);
  addEventListener('resize', position);
  requestAnimationFrame(position);
  return { destroy() { off(); removeEventListener('resize', position); } };
});

registerActions({
  'w.links-folder.add': ({ el, ctx, data }) => openAddForm(ctx, data.widget, el),
  'w.links-folder.item-menu': ({ el, ctx, data }) => openTileMenu(ctx, data.widget, data.id, el, data.grid),
  'w.links-folder.choose': ({ el, ctx, data }) => chooseCollection(ctx, data.widget, el),
  'w.links-folder.create': ({ ctx, data }) => createCollectionFor(ctx, data.widget),
  'w.links-folder.popup': ({ el, ctx, data }) => ctx.openPopover(POPUP, el, { widgetId: data.widget }, { placement: 'bottom' }),
  'w.links-folder.folder-key': ({ el, event, ctx, data }) => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    event.preventDefault();
    openFolderMenu(ctx, data.widget, el);
  },
  'w.links-folder.settings-name': ({ el, ctx }) => {
    const edit = session?.draft?.[EDIT];
    if (!edit) return;
    edit.name = el.value;
    if (edit.nameError) edit.nameError = '';
    ctx.render();
  },
  'w.links-folder.settings-collection': ({ ctx, data }) => {
    if (!session) return;
    session.draft.collectionId = data.value || '';
    session.draft.order = [];
    ctx.render();
  },
  'w.links-folder.settings-field': ({ el, ctx, data }) => {
    const name = el.name || data.name;
    if (!session || !name) return;
    session.draft[name] = el.type === 'checkbox' ? el.checked : (data.value ?? el.value);
    ctx.render();
  },
});

defineWidget({
  type: TYPE,
  title: 'Links folder',
  description: 'A collection’s links as app-style tiles. At its smallest it is a folder that opens on click.',
  icon: 'folder',
  category: 'library',
  keywords: ['links', 'bookmarks', 'folder', 'collection', 'shortcuts', 'speed dial', 'apps', 'tiles', 'group'],
  size: { w: 4, h: 3, minW: 2, minH: 2, maxW: 12, maxH: 10 },
  presets: { S: { w: 2, h: 2 }, M: { w: 3, h: 3 }, L: { w: 4, h: 3 }, XL: { w: 6, h: 4 } },
  frame: 'bare',
  preview: 'Folder of link tiles',
  defaults: () => folderConfig({}),
  needsSetup: config => !folderConfig(config).collectionId,
  // The name to show when the instance has no title of its own (the collection's), for frames that ask for it.
  titleFor: (ctx, widget) => folderState(ctx, widget).collection?.name || '',
  render,
  menu: (ctx, widget) => folderMenuItems(ctx, widget),
  renderSettings,
  validateSettings,
  onSettingsSave,
  init: ctx => initLinkGrids(ctx),
});
