// Interaction plumbing shared by the links-folder and quick-links widgets: opening a link the way the widget is set
// up, the add/edit link popover, the URL + title rows editor of their settings, and tile-grid behaviour (roving focus
// with arrow keys, Alt+arrows to reorder, context menus, drag to reorder and drops from the browser or other widgets).
//
// A grid is any element with data-links-grid="<unique key>" data-links-kind="<kind>" data-widget="<widget id>"
// data-keydown="w.links.grid-key". Its tiles carry data-link-tile and data-tile-key (the add tile: data-link-add);
// link tiles also carry data-link-id. Each kind registers handlers with registerLinkGrid().
import { html, cx } from '../../html.js';
import { icon } from '../../icons.js';
import { registerActions, registerMount } from '../../runtime.js';
import { registerPopover } from '../../overlay.js';
import { button, iconButton, field, input } from '../../components.js';
import { droppedLinks } from '../../dnd.js';
import { normalizeLinkUrl, hostOf, neighborIndex, gridColumns, dropTarget, URL_ERROR } from './model.js';
import { watchTileIcons, tileIcon } from './favicons.js';

export const OPEN_IN_OPTIONS = Object.freeze([
  { value: 'current', label: 'Current tab' },
  { value: 'new', label: 'New tab' },
  { value: 'background', label: 'Background tab' },
]);

const ITEMS_TYPE = 'application/x-still-items';
const extensionApi = () => (globalThis.chrome?.runtime?.id ? globalThis.chrome : null);
export const canOpenWindows = () => !!extensionApi()?.windows?.create;

async function currentTab() {
  try { return (await extensionApi()?.tabs?.getCurrent?.()) || null; } catch { return null; }
}

/** Opens url in 'current' | 'new' | 'background' | 'window' | 'incognito'. The side panel's "current tab" is the browser tab. */
export async function openLink(ctx, url, mode = 'current') {
  const href = normalizeLinkUrl(url);
  if (!href) return;
  const api = extensionApi();
  if ((mode === 'window' || mode === 'incognito') && api?.windows?.create) {
    await api.windows.create({ url: href, incognito: mode === 'incognito' });
    return;
  }
  if (mode !== 'current') {
    if (!api?.tabs?.create) { window.open(href, '_blank', 'noopener'); return; }
    const tab = await currentTab();
    await api.tabs.create({ url: href, active: mode !== 'background', ...(tab ? { index: tab.index + 1, openerTabId: tab.id } : {}) });
    return;
  }
  if (ctx.env.isSidepanel && api?.tabs?.update) { await api.tabs.update({ url: href }); return; }
  location.assign(href);
}

/** Opens every url in background tabs next to this one, in order. Asks first when there are many. */
export async function openAll(ctx, urls, { label = 'these links' } = {}) {
  const list = urls.map(normalizeLinkUrl).filter(Boolean);
  if (!list.length) return;
  if (list.length > 12 && !(await ctx.confirm({ title: `Open ${list.length} tabs?`, body: `This opens every link in ${label} in a new tab.`, confirmLabel: `Open ${list.length} tabs` }))) return;
  const api = extensionApi();
  if (!api?.tabs?.create) { for (const href of list) window.open(href, '_blank', 'noopener'); return; }
  const tab = await currentTab();
  for (const [i, href] of list.entries()) {
    await api.tabs.create({ url: href, active: false, ...(tab ? { index: tab.index + 1 + i, openerTabId: tab.id } : {}) });
  }
}

/** target/rel for a tile's <a>: "new tab" uses target=_blank; background tabs are opened by the click handler. */
export const anchorTarget = openIn => openIn === 'new' ? html`target="_blank" rel="noopener"` : '';

export async function copyLink(ctx, url) {
  await navigator.clipboard.writeText(url);
  ctx.toast('Link copied');
}

/** Menu entries to open a link every supported way (the first one follows the widget's own setting). */
export function openMenuItems(ctx, url, openIn) {
  return [
    { label: 'Open', icon: 'arrow-up-right', run: () => openLink(ctx, url, openIn) },
    openIn !== 'new' && { label: 'Open in new tab', icon: 'external-link', run: () => openLink(ctx, url, 'new') },
    openIn !== 'background' && { label: 'Open in background tab', icon: 'panel-top', run: () => openLink(ctx, url, 'background') },
    canOpenWindows() && { label: 'Open in new window', icon: 'app-window', run: () => openLink(ctx, url, 'window') },
    canOpenWindows() && { label: 'Open in incognito window', icon: 'eye-off', run: () => openLink(ctx, url, 'incognito') },
  ].filter(Boolean);
}

/**
 * An anchor that survives the popover it is in being replaced: an element inside the current popover (the 2×2
 * folder's popup) becomes the point under it, since opening a menu or form closes that popover and its elements.
 */
export function stableAnchor(anchor) {
  if (!(anchor instanceof Element) || !anchor.closest('#still-popover')) return anchor;
  const rect = anchor.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

/** Drops leading, trailing and doubled separators left by conditional menu entries. */
export function tidyMenu(items) {
  const out = [];
  for (const item of items.filter(Boolean)) {
    if (item.separator && (!out.length || out.at(-1).separator)) continue;
    out.push(item);
  }
  while (out.at(-1)?.separator) out.pop();
  return out;
}

/* ------------------------------------------------------------------ add / edit link popover */

const FORM_ID = 'w-links-form';

/**
 * Opens the link form anchored to an element: { heading, url, title, submitLabel, onSubmit({ url, title }) }.
 * onSubmit may throw; its message shows under the URL field and the form stays open.
 */
export function openLinkForm(ctx, anchor, props) {
  ctx.openPopover('w.links.form', anchor, { url: '', title: '', error: '', busy: false, ...props }, { placement: 'bottom-start' });
}

function renderLinkForm(_ctx, props) {
  const urlId = `${FORM_ID}-url`;
  const host = hostOf(normalizeLinkUrl(props.url));
  return html`<div class="w-links-form" role="dialog" aria-labelledby="${FORM_ID}-heading" data-key="${FORM_ID}">
    <form data-submit="w.links.form-submit" novalidate>
      <h2 class="w-links-form-heading" id="${FORM_ID}-heading">${props.heading}</h2>
      ${field({ label: 'URL', id: urlId, error: props.error, control: input({ name: 'url', id: urlId, value: props.url, placeholder: 'example.com', autofocus: true,
        invalid: !!props.error, describedBy: props.error ? `${urlId}-error` : '', attrs: { inputmode: 'url', enterkeyhint: 'next' }, action: 'w.links.form-url' }) })}
      ${field({ label: 'Title', id: `${FORM_ID}-title`, hint: 'Optional. Leave it empty to use the site name.', control: input({ name: 'title', id: `${FORM_ID}-title`,
        value: props.title, placeholder: host || 'Site name', describedBy: `${FORM_ID}-title-hint`, attrs: { enterkeyhint: 'done' } }) })}
      <div class="w-links-form-actions">
        ${button({ label: 'Cancel', variant: 'ghost', action: 'w.links.form-cancel' })}
        ${button({ label: props.submitLabel || 'Save', variant: 'primary', type: 'submit', loading: props.busy })}
      </div>
    </form>
  </div>`;
}

/* ------------------------------------------------------------------ URL + title rows editor (settings) */

const editors = new Map();
let rowSeq = 0;
export const rowKey = () => `r${Date.now().toString(36)}${(++rowSeq).toString(36)}`;

/** Editor rows from links: [{ key, id, url, title }]. */
export const toRows = links => links.map(link => ({ key: link.id ? `id-${link.id}` : rowKey(), id: link.id || '', url: link.url || '', title: link.title || '' }));

/**
 * The rows editor. `state` ({ rows, errors }) is owned by the caller (usually kept on the settings draft) and is edited
 * in place by the row actions; errors are keyed by row index as validateLinkRows reports them.
 */
export function renderLinkRows(ctx, { key, state, legend = 'Links', addLabel = 'Add link', hint = '', emptyText = 'No links yet.' }) {
  editors.set(key, state);
  initRowDrag(ctx);
  const rows = state.rows;
  return html`<fieldset class="w-links-rows" data-key="rows-${key}" data-link-icons>
    <legend class="w-links-rows-legend">${legend}${rows.length ? html` <span class="w-links-rows-count">${rows.length}</span>` : ''}</legend>
    ${hint ? html`<p class="w-links-rows-hint">${hint}</p>` : ''}
    ${rows.length ? html`<div class="w-links-rows-head" aria-hidden="true"><span>URL</span><span>Title</span></div>` : html`<p class="w-links-rows-empty">${emptyText}</p>`}
    <ol class="w-links-rows-list" role="list">
      ${rows.map((row, index) => {
        const error = state.errors?.[index];
        const base = `lr-${key}-${row.key}`;
        const url = normalizeLinkUrl(row.url);
        const name = row.title.trim() || hostOf(url) || `link ${index + 1}`;
        return html`<li class="${cx('w-links-row', error && 'is-invalid')}" data-key="${row.key}" data-link-row="${row.key}" data-editor="${key}">
          ${rows.length > 1 ? html`<button type="button" class="w-links-row-grip" data-keydown="w.links.row-grip-key" data-editor="${key}" data-row="${row.key}"
            id="${base}-grip" data-focus-key="${base}-grip" aria-label="Move ${name}, ${index + 1} of ${rows.length}. Drag, or use the up and down arrow keys."
            data-tooltip="Drag to reorder">${icon('grip-vertical', { size: 14 })}</button>` : html`<span class="w-links-row-grip is-empty" aria-hidden="true"></span>`}
          <span class="w-links-row-icon" aria-hidden="true">${url ? tileIcon(url, { size: 16 }) : icon('link', { size: 14 })}</span>
          <input class="input w-links-row-url" id="${base}-url" data-focus-key="${base}-url" value="${row.url}" placeholder="example.com" aria-label="URL of link ${index + 1}"
            inputmode="url" autocomplete="off" spellcheck="false" data-input="w.links.row-input" data-keydown="w.links.row-key" data-editor="${key}" data-row="${row.key}" data-field="url"
            ${error ? html`aria-invalid="true" aria-describedby="${base}-error"` : ''}>
          <input class="input w-links-row-title" id="${base}-title" data-focus-key="${base}-title" value="${row.title}" placeholder="${hostOf(url) || 'Title'}"
            aria-label="Title of link ${index + 1}" autocomplete="off" data-input="w.links.row-input" data-keydown="w.links.row-key" data-editor="${key}" data-row="${row.key}" data-field="title">
          ${iconButton({ icon: 'x', label: `Remove link ${index + 1}`, action: 'w.links.row-remove', data: { editor: key, row: row.key }, size: 'sm', className: 'w-links-row-remove' })}
          ${error ? html`<p class="field-error w-links-row-error" id="${base}-error">${icon('circle-alert', { size: 14 })}<span>${error}</span></p>` : ''}
        </li>`;
      })}
    </ol>
    ${button({ label: addLabel, icon: 'plus', variant: 'ghost', size: 'sm', action: 'w.links.row-add', data: { editor: key }, className: 'w-links-rows-add' })}
    <p class="sr-only" aria-live="polite">${state.announce || ''}</p>
  </fieldset>`;
}

/** Moves a row of an editor to `to` (an index in the rows after removal); marks the editor reordered. */
function moveRow(ctx, key, rowKeyToMove, to, { focus = false } = {}) {
  const state = editors.get(key);
  const from = state?.rows.findIndex(r => r.key === rowKeyToMove) ?? -1;
  if (from < 0) return;
  const target = Math.max(0, Math.min(state.rows.length - 1, to));
  if (target === from) return;
  const [row] = state.rows.splice(from, 1);
  state.rows.splice(target, 0, row);
  // Errors are keyed by row index; they are checked again on save.
  state.errors = {};
  state.reordered = true;
  state.announce = `Moved to ${target + 1} of ${state.rows.length}`;
  ctx.render();
  if (focus) ctx.nextFrame(() => document.getElementById(`lr-${key}-${row.key}-grip`)?.focus());
}

// Pointer drag on a row's grip (mouse, pen or touch): the row under the pointer shows where it will land.
let rowDragReady = false;
function initRowDrag(ctx) {
  if (rowDragReady || typeof document === 'undefined') return;
  rowDragReady = true;
  document.addEventListener('pointerdown', event => {
    const grip = event.target instanceof Element ? event.target.closest('.w-links-row-grip:not(.is-empty)') : null;
    if (!grip || event.button !== 0) return;
    const list = grip.closest('.w-links-rows-list');
    const source = grip.closest('[data-link-row]');
    if (!list || !source) return;
    event.preventDefault();
    grip.setPointerCapture?.(event.pointerId);
    source.classList.add('is-dragging');
    let target = null;
    let after = false;
    const clear = () => { for (const el of list.querySelectorAll('.is-drop-before, .is-drop-after')) el.classList.remove('is-drop-before', 'is-drop-after'); };
    const move = e => {
      const rows = [...list.querySelectorAll(':scope > [data-link-row]')];
      target = rows.find(row => { const r = row.getBoundingClientRect(); return e.clientY < r.bottom; }) || rows.at(-1);
      const r = target.getBoundingClientRect();
      after = e.clientY > r.top + r.height / 2;
      clear();
      if (target !== source) target.classList.add(after ? 'is-drop-after' : 'is-drop-before');
    };
    const end = e => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      source.classList.remove('is-dragging');
      clear();
      if (e.type !== 'pointerup' || !target || target === source) return;
      const rows = [...list.querySelectorAll(':scope > [data-link-row]')];
      const from = rows.indexOf(source);
      let to = rows.indexOf(target) + (after ? 1 : 0);
      if (from < to) to -= 1;
      moveRow(ctx, source.dataset.editor, source.dataset.linkRow, to);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  });
}

const focusRow = (ctx, key, row, field = 'url') => ctx.nextFrame(() => document.getElementById(`lr-${key}-${row}-${field}`)?.focus());

/** Moves focus to the first row with an error (call after a failed save). */
export function focusFirstError(ctx, key) {
  const state = editors.get(key);
  const index = Object.keys(state?.errors || {}).map(Number).sort((a, b) => a - b)[0];
  const row = state?.rows[index];
  if (row) focusRow(ctx, key, row.key);
}

/* ------------------------------------------------------------------ grid scrolling */

/**
 * Whether a tile grid has tiles out of view. Overflow that is only the grid's own bottom padding (every tile visible)
 * does not count: scrolling there would show a stray scrollbar and catch the wheel on its way to the page.
 */
export const gridOverflows = (scrollHeight, clientHeight, paddingEnd = 0) => scrollHeight - clientHeight > Math.max(0, paddingEnd) + 1;

// data-mount="w.links.fit" on a .w-links-grid: it scrolls (is-scrollable) only while tiles are cut off, rechecked when
// the widget is resized or its tiles change.
registerMount('w.links.fit', el => {
  const check = () => {
    const paddingEnd = parseFloat(getComputedStyle(el).paddingBlockEnd) || 0;
    el.classList.toggle('is-scrollable', gridOverflows(el.scrollHeight, el.clientHeight, paddingEnd));
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(check) : null;
  observer?.observe(el);
  check();
  return { update: check, destroy: () => observer?.disconnect() };
});

/* ------------------------------------------------------------------ tile grids */

const grids = new Map();     // kind -> { menu, reorder, shift, dropItems?, dropLinks, widgetMenu? }
const roving = new Map();    // grid key -> tile key that holds the tab stop
let dragging = null;         // { grid, kind, id } while a tile from one of our grids is dragged
let marked = [];
let initialized = false;

/**
 * Handlers for a grid kind, each (ctx, gridEl, ...):
 *   menu(ctx, grid, id, anchorOrPoint)    tile context menu
 *   reorder(ctx, grid, id, beforeId)      a tile dragged within its grid
 *   shift(ctx, grid, id, delta)           Alt+arrow keys
 *   dropLinks(ctx, grid, links, beforeId) links dropped from the browser or another grid ([{ url, title }])
 *   dropItems?(ctx, grid, itemIds, beforeId)   Still library items dropped (folders only)
 *   widgetMenu?(ctx, widgetId, point)     right-click on an element with data-links-menu="<kind>"
 */
export function registerLinkGrid(kind, handlers) { grids.set(kind, handlers); }

/** The tile key that gets tabindex=0 in a grid (the last focused tile, else the first). */
export function rovingStop(gridKey, keys) {
  const active = roving.get(gridKey);
  return keys.includes(active) ? active : keys[0];
}

const gridOf = el => el?.closest?.('[data-links-grid]') || null;
const tileOf = el => el?.closest?.('[data-link-tile]') || null;
const linkRects = grid => [...grid.querySelectorAll('[data-link-id]')].filter(el => gridOf(el) === grid).map(el => {
  const rect = (el.closest('[data-link-cell]') || el).getBoundingClientRect();
  return { id: el.dataset.linkId, top: rect.top, left: rect.left, width: rect.width, height: rect.height };
});
const dropOptions = grid => ({ rtl: getComputedStyle(grid).direction === 'rtl', vertical: grid.dataset.linksAxis === 'y' });
const cellOf = (grid, id) => grid.querySelector(`[data-link-id="${CSS.escape(id)}"]`)?.closest('[data-link-cell]') || null;

function clearMarks() {
  for (const el of marked) el.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-active');
  marked = [];
}
function markDrop(grid, target) {
  const cell = target.mark ? cellOf(grid, target.mark) : null;
  const cls = `is-drop-${target.side}`;
  if (marked.length === 2 && marked[0] === grid && marked[1] === cell && cell?.classList.contains(cls)) return;
  clearMarks();
  grid.classList.add('is-drop-active');
  marked.push(grid);
  if (cell) { cell.classList.add(cls); marked.push(cell); }
}

/** Which drop a dragover/drop on grid is: 'reorder' | 'items' | 'links' | null. */
function dropKind(grid, transfer) {
  const types = [...(transfer?.types || [])];
  const handlers = grids.get(grid.dataset.linksKind);
  if (!handlers) return null;
  if (dragging && dragging.grid === grid.dataset.linksGrid) return 'reorder';
  if (types.includes(ITEMS_TYPE) && handlers.dropItems) return 'items';
  if (types.includes('text/uri-list') || types.includes('text/plain')) return 'links';
  return null;
}

/** A drop effect the source allows: wanted when possible, else copy, else link. */
function effectFor(allowed = 'all', wanted) {
  const ok = effect => allowed === 'all' || allowed === 'uninitialized' || allowed.toLowerCase().includes(effect);
  return ok(wanted) ? wanted : ok('copy') ? 'copy' : ok('link') ? 'link' : 'none';
}

function focusTile(gridKey, tileKey) {
  const grid = document.querySelector(`[data-links-grid="${CSS.escape(gridKey)}"]`);
  grid?.querySelector(`[data-tile-key="${CSS.escape(tileKey)}"]`)?.focus({ preventScroll: false });
}

/** Wires the document listeners once (capture phase, so a drop on a grid never reaches the app's generic drop zone). */
export function initLinkGrids(ctx) {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;
  watchTileIcons(() => ctx.render());

  document.addEventListener('focusin', event => {
    const tile = tileOf(event.target);
    const grid = gridOf(tile);
    if (!grid) return;
    roving.set(grid.dataset.linksGrid, tile.dataset.tileKey);
    for (const el of grid.querySelectorAll('[data-link-tile]')) if (gridOf(el) === grid) el.tabIndex = el === tile ? 0 : -1;
  });

  document.addEventListener('dragstart', event => {
    const tile = event.target instanceof Element ? event.target.closest('[data-link-id]') : null;
    const grid = gridOf(tile);
    if (!grid) return;
    dragging = { grid: grid.dataset.linksGrid, kind: grid.dataset.linksKind, id: tile.dataset.linkId };
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
    const cell = tile.closest('[data-link-cell]');
    // Fade the source after the browser has captured the drag image.
    requestAnimationFrame(() => cell?.classList.add('is-dragging'));
  }, true);

  document.addEventListener('dragover', event => {
    const grid = gridOf(event.target instanceof Element ? event.target : null);
    if (!grid) { if (marked.length) clearMarks(); return; }
    const kind = dropKind(grid, event.dataTransfer);
    if (!kind) { clearMarks(); return; }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = effectFor(event.dataTransfer.effectAllowed, kind === 'links' ? 'copy' : 'move');
    markDrop(grid, dropTarget(linkRects(grid), event.clientX, event.clientY, dropOptions(grid)));
  }, true);

  document.addEventListener('dragleave', event => {
    const grid = gridOf(event.target instanceof Element ? event.target : null);
    if (grid && !grid.contains(event.relatedTarget)) clearMarks();
  }, true);

  document.addEventListener('drop', event => {
    const grid = gridOf(event.target instanceof Element ? event.target : null);
    if (!grid) return;
    const kind = dropKind(grid, event.dataTransfer);
    if (!kind) return;
    event.preventDefault();
    event.stopPropagation();
    const handlers = grids.get(grid.dataset.linksKind);
    const { before } = dropTarget(linkRects(grid), event.clientX, event.clientY, dropOptions(grid));
    const source = dragging;
    const transfer = event.dataTransfer;
    let payload = null;
    if (kind === 'items') { try { payload = JSON.parse(transfer.getData(ITEMS_TYPE) || '[]'); } catch { payload = []; } }
    if (kind === 'links') payload = droppedLinks(type => transfer.getData(type));
    clearMarks();
    // The app's drag-and-drop module resets its own drag state on dragend, which a re-rendered source tile never fires.
    document.dispatchEvent(new Event('dragend'));
    ctx.run(async () => {
      if (kind === 'reorder') await handlers.reorder?.(ctx, grid, source.id, before);
      else if (kind === 'items' && payload.length) await handlers.dropItems(ctx, grid, payload.filter(id => typeof id === 'string'), before);
      else if (kind === 'links' && payload?.length) await handlers.dropLinks?.(ctx, grid, payload, before);
    });
  }, true);

  document.addEventListener('dragend', () => {
    dragging = null;
    clearMarks();
    for (const el of document.querySelectorAll('[data-link-cell].is-dragging')) el.classList.remove('is-dragging');
  }, true);

  document.addEventListener('contextmenu', event => {
    const target = event.target instanceof Element ? event.target : null;
    const tile = target?.closest('[data-link-id]');
    const grid = gridOf(tile);
    const point = { x: event.clientX, y: event.clientY };
    if (grid) {
      const handlers = grids.get(grid.dataset.linksKind);
      if (!handlers?.menu) return;
      event.preventDefault();
      event.stopPropagation();
      ctx.run(() => handlers.menu(ctx, grid, tile.dataset.linkId, point));
      return;
    }
    const owner = target?.closest('[data-links-menu]');
    const handlers = owner && grids.get(owner.dataset.linksMenu);
    if (!handlers?.widgetMenu) return;
    event.preventDefault();
    event.stopPropagation();
    ctx.run(() => handlers.widgetMenu(ctx, owner.dataset.widget, point));
  }, true);
}

/** Re-focuses a tile after the grid re-renders (reorders move nodes, which drops focus). */
export const refocusTile = (ctx, gridKey, tileKey) => ctx.nextFrame(() => focusTile(gridKey, tileKey));

registerPopover('w.links.form', renderLinkForm, { role: 'none', className: 'w-links-form-popover' });

registerActions({
  'w.links.open': ({ el, event, ctx, data }) => {
    // Modified and middle clicks are the browser's (new tab, new window, download); plain clicks follow the setting.
    if (!event || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (data.openIn === 'background' || (data.openIn !== 'new' && ctx.env.isSidepanel)) {
      event.preventDefault();
      return openLink(ctx, el.getAttribute('href'), data.openIn === 'background' ? 'background' : 'current');
    }
    return undefined;
  },

  'w.links.grid-key': ({ el: grid, event, ctx }) => {
    const tile = tileOf(event.target);
    if (!tile || gridOf(tile) !== grid || event.target !== tile) return;
    const handlers = grids.get(grid.dataset.linksKind);
    const id = tile.dataset.linkId;
    if ((event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) && id) {
      event.preventDefault();
      return handlers?.menu?.(ctx, grid, id, tile);
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || event.ctrlKey || event.metaKey) return;
    const tiles = [...grid.querySelectorAll('[data-link-tile]')].filter(el => gridOf(el) === grid);
    const positions = tiles.map(el => { const rect = (el.closest('[data-link-cell]') || el).getBoundingClientRect(); return { top: rect.top, left: rect.left }; });
    const rtl = getComputedStyle(grid).direction === 'rtl';
    if (event.altKey) {
      if (!id || event.key === 'Home' || event.key === 'End' || !handlers?.shift) return;
      event.preventDefault();
      const columns = gridColumns(positions);
      const step = event.key === 'ArrowUp' ? -columns : event.key === 'ArrowDown' ? columns : (event.key === 'ArrowRight') !== rtl ? 1 : -1;
      refocusTile(ctx, grid.dataset.linksGrid, tile.dataset.tileKey);
      return handlers.shift(ctx, grid, id, step);
    }
    if (event.shiftKey) return;
    event.preventDefault();
    tiles[neighborIndex(positions, tiles.indexOf(tile), event.key, { rtl })]?.focus();
  },

  'w.links.form-url': ({ el, ctx }) => {
    const props = ctx.state.popover?.name === 'w.links.form' ? ctx.state.popover.props : null;
    if (!props) return;
    props.url = el.value;
    if (props.error) props.error = '';
    ctx.render();
  },
  'w.links.form-cancel': ({ ctx }) => ctx.closePopover(),
  'w.links.form-submit': async ({ el, ctx }) => {
    const pop = ctx.state.popover;
    if (pop?.name !== 'w.links.form' || pop.props.busy) return;
    const props = pop.props;
    const form = new FormData(el);
    props.url = String(form.get('url') ?? '');
    props.title = String(form.get('title') ?? '');
    const url = normalizeLinkUrl(props.url);
    if (!url) {
      props.error = props.url.trim() ? URL_ERROR : 'Enter the address of the page to add.';
      ctx.render();
      ctx.nextFrame(() => document.getElementById(`${FORM_ID}-url`)?.focus());
      return;
    }
    Object.assign(props, { error: '', busy: true });
    ctx.render();
    try {
      await props.onSubmit({ url, title: props.title.trim() });
      if (ctx.state.popover?.props === props) ctx.closePopover();
    } catch (error) {
      Object.assign(props, { busy: false, error: error?.message || 'That link could not be saved. Try again.' });
      ctx.render();
    }
  },

  'w.links.row-input': ({ el, ctx, data }) => {
    const state = editors.get(data.editor);
    const row = state?.rows.find(r => r.key === data.row);
    if (!row) return;
    row[data.field] = el.value;
    const index = state.rows.indexOf(row);
    if (state.errors?.[index]) delete state.errors[index];
    ctx.render();
  },
  'w.links.row-key': ({ el, event, ctx, data }) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    // Enter walks the rows like a sheet (URL -> title -> next URL, adding a row at the end) instead of saving the dialog.
    event.preventDefault();
    const state = editors.get(data.editor);
    const index = state?.rows.findIndex(r => r.key === data.row) ?? -1;
    if (index < 0) return;
    if (data.field === 'url') { document.getElementById(el.id.replace(/-url$/, '-title'))?.focus(); return; }
    const next = state.rows[index + 1];
    if (next) { focusRow(ctx, data.editor, next.key); return; }
    if (!state.rows[index].url.trim()) return;
    const row = { key: rowKey(), id: '', url: '', title: '' };
    state.rows.push(row);
    ctx.render();
    focusRow(ctx, data.editor, row.key);
  },
  'w.links.row-grip-key': ({ event, ctx, data }) => {
    const state = editors.get(data.editor);
    const index = state?.rows.findIndex(r => r.key === data.row) ?? -1;
    if (index < 0) return;
    const to = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: state.rows.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    moveRow(ctx, data.editor, data.row, to, { focus: true });
  },
  'w.links.row-remove': ({ ctx, data }) => {
    const state = editors.get(data.editor);
    const index = state?.rows.findIndex(r => r.key === data.row) ?? -1;
    if (index < 0) return;
    state.rows.splice(index, 1);
    state.errors = {};
    ctx.render();
    const next = state.rows[index] || state.rows[index - 1];
    if (next) focusRow(ctx, data.editor, next.key);
    else ctx.nextFrame(() => document.querySelector(`[data-key="rows-${CSS.escape(data.editor)}"] .w-links-rows-add`)?.focus());
  },
  'w.links.row-add': ({ ctx, data }) => {
    const state = editors.get(data.editor);
    if (!state) return;
    const row = { key: rowKey(), id: '', url: '', title: '' };
    state.rows.push(row);
    ctx.render();
    focusRow(ctx, data.editor, row.key);
  },
});
