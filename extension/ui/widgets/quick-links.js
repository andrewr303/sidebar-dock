// Quick links widget: a handful of shortcuts kept in the widget itself (like a browser's shortcuts row), independent of
// the library. Three looks: white icon tiles (as in a links folder), compact chips, or a list with addresses. Links
// are added inline (+), edited or removed from their menu, reordered by dragging or Alt+arrows, and can be saved
// to Still with one click.
import { html, cx, plural, safeHref } from '../html.js';
import { icon } from '../icons.js';
import { registerActions } from '../runtime.js';
import { button, iconButton, select, segmented, switchToggle, field, emptyState } from '../components.js';
import { defineWidget } from '../dashboard/registry.js';
import * as dashboardStore from '../../lib/dashboard-store.js';
import { quickConfig, defaultQuickLinks, normalizeQuickLinks, planQuickLinks, validateLinkRows, placeBefore, shiftId, linkKey, linkLabel, hostOf, quickLinkId } from './links/model.js';
import {
  OPEN_IN_OPTIONS, openAll, anchorTarget, copyLink, openMenuItems, tidyMenu, stableAnchor, openLinkForm, toRows, renderLinkRows, focusFirstError,
  registerLinkGrid, rovingStop, initLinkGrids,
} from './links/shared.js';
import { tileIcon } from './links/favicons.js';

const TYPE = 'quick-links';
const EDIT = '_quickEditor';
const STYLES = [{ value: 'tiles', label: 'Tiles', icon: 'layout-grid' }, { value: 'chips', label: 'Chips', icon: 'tags' }, { value: 'list', label: 'List', icon: 'list' }];

const configOf = widgetId => {
  const found = dashboardStore.findWidget(widgetId);
  return found ? quickConfig(found.widget.config) : null;
};
const saveLinks = (widgetId, links) => dashboardStore.updateWidgetConfig(widgetId, { links: normalizeQuickLinks(links) });

function anchorFor(widgetId) {
  const id = CSS.escape(widgetId);
  return [`[data-links-grid="ql:${id}"] [data-link-add]`, `[data-widget-id="${id}"] .w-quick-links-add-btn`, `[data-widget-id="${id}"]`]
    .map(selector => document.querySelector(selector)).find(el => el?.isConnected) || document.body;
}

/* ------------------------------------------------------------------ writes */

const sameLinks = (a, b) => JSON.stringify(normalizeQuickLinks(a)) === JSON.stringify(normalizeQuickLinks(b));

/**
 * The links after undoing an add: the list from before it while nothing else changed since, else the current list
 * without the added links (so links added, edited or moved after it are kept).
 */
export function undoAddLinks(current, { previous, saved, addedIds }) {
  if (sameLinks(current, saved)) return previous;
  const added = new Set(addedIds);
  return current.filter(link => !added.has(link.id));
}

/**
 * The links after undoing a removal: the list from before it while nothing else changed since, else the current list
 * with the link put back before the link that followed it (at the end when that one is gone too). A link already back
 * (same id or address) is not added twice.
 */
export function undoRemoveLink(current, { previous, saved, link, beforeId = '' }) {
  if (sameLinks(current, saved)) return previous;
  if (current.some(entry => entry.id === link.id || linkKey(entry.url) === linkKey(link.url))) return current;
  const all = [...current, link];
  const byId = new Map(all.map(entry => [entry.id, entry]));
  return placeBefore(all.map(entry => entry.id), [link.id], current.some(entry => entry.id === beforeId) ? beforeId : '').map(id => byId.get(id));
}

/** Adds links at beforeId ('' = end); links already in the widget move there instead of doubling up. */
async function addLinks(ctx, widgetId, links, beforeId = '') {
  const config = configOf(widgetId);
  if (!config) return;
  const byKey = new Map(config.links.map(link => [linkKey(link.url), link]));
  const added = [];
  const moving = [];
  for (const link of links) {
    const existing = byKey.get(linkKey(link.url));
    if (existing) { moving.push(existing.id); continue; }
    const entry = { id: quickLinkId(), url: link.url, title: link.title || '' };
    byKey.set(linkKey(link.url), entry);
    added.push(entry);
  }
  const all = [...config.links, ...added];
  const ids = placeBefore(all.map(link => link.id), [...moving, ...added.map(link => link.id)], beforeId);
  const byId = new Map(all.map(link => [link.id, link]));
  const previous = config.links;
  const saved = ids.map(id => byId.get(id));
  await saveLinks(widgetId, saved);
  if (!added.length) { if (!moving.length || links.length === 1) ctx.toast(links.length > 1 ? 'Those links are already here' : 'That link is already here'); return; }
  const addedIds = added.map(link => link.id);
  ctx.toast(added.length > 1 ? `Added ${plural(added.length, 'quick link')}` : `Added “${linkLabel(added[0])}”`,
    { tone: 'success', action: { label: 'Undo', run: () => {
      const now = configOf(widgetId);
      return now && saveLinks(widgetId, undoAddLinks(now.links, { previous, saved, addedIds }));
    } } });
}

async function removeLink(ctx, widgetId, id) {
  const config = configOf(widgetId);
  const link = config?.links.find(entry => entry.id === id);
  if (!link) return;
  const at = config.links.indexOf(link);
  const beforeId = config.links[at + 1]?.id || '';
  const saved = config.links.filter(entry => entry.id !== id);
  await saveLinks(widgetId, saved);
  ctx.toast(`Removed “${linkLabel(link)}”`, { action: { label: 'Undo', run: () => {
    const now = configOf(widgetId);
    return now && saveLinks(widgetId, undoRemoveLink(now.links, { previous: config.links, saved, link, beforeId }));
  } } });
}

async function reorder(ctx, widgetId, ids) {
  const config = configOf(widgetId);
  if (!config) return;
  const byId = new Map(config.links.map(link => [link.id, link]));
  const next = ids.map(id => byId.get(id)).filter(Boolean);
  if (next.map(link => link.id).join() !== config.links.map(link => link.id).join()) await saveLinks(widgetId, next);
}

async function saveToStill(ctx, link) {
  const saved = await ctx.store.saveItem({ type: 'bookmark', url: link.url, ...(link.title ? { title: link.title } : {}) });
  ctx.toast(`Saved “${linkLabel(saved)}” to Inbox`, { tone: 'success', action: { label: 'Open', run: () => ctx.openItem(saved.id) } });
}

/* ------------------------------------------------------------------ menus and forms */

function openAddForm(ctx, widgetId, anchor) {
  openLinkForm(ctx, anchor?.isConnected ? anchor : anchorFor(widgetId), {
    heading: 'Add a quick link', submitLabel: 'Add link',
    onSubmit: link => addLinks(ctx, widgetId, [link], ''),
  });
}

function openEditForm(ctx, widgetId, link, anchor) {
  openLinkForm(ctx, anchor, {
    heading: 'Edit quick link', url: link.url, title: link.title, submitLabel: 'Save link',
    onSubmit: async ({ url, title }) => {
      const config = configOf(widgetId);
      if (!config) return;
      const clash = config.links.find(entry => entry.id !== link.id && linkKey(entry.url) === linkKey(url));
      if (clash) throw new Error(`“${linkLabel(clash)}” already links there.`);
      await saveLinks(widgetId, config.links.map(entry => entry.id === link.id ? { ...entry, url, title } : entry));
    },
  });
}

function openTileMenu(ctx, widgetId, id, anchor, gridKey) {
  const config = configOf(widgetId);
  const link = config?.links.find(entry => entry.id === id);
  if (!link) return;
  const tile = () => document.querySelector(`[data-links-grid="${CSS.escape(gridKey)}"] [data-link-id="${CSS.escape(id)}"]`) || anchorFor(widgetId);
  const saved = ctx.select.savedForUrl(link.url);
  ctx.openMenu(stableAnchor(anchor), tidyMenu([
    ...openMenuItems(ctx, link.url, config.openIn),
    { separator: true },
    { label: 'Edit title and URL…', icon: 'pencil', run: () => openEditForm(ctx, widgetId, link, tile()) },
    { label: 'Copy link', icon: 'copy', run: () => copyLink(ctx, link.url) },
    saved ? { label: 'Open in Still', icon: 'panel-right-open', run: () => ctx.openItem(saved.id) }
      : { label: 'Save to Still', icon: 'bookmark-plus', run: () => saveToStill(ctx, link) },
    { separator: true },
    { label: 'Remove', icon: 'trash-2', danger: true, run: () => removeLink(ctx, widgetId, id) },
  ]), { label: `Options for ${linkLabel(link)}` });
}

function widgetMenu(ctx, widget) {
  const config = quickConfig(widget.config);
  const set = patch => dashboardStore.updateWidgetConfig(widget.id, patch);
  return tidyMenu([
    { label: 'Add link…', icon: 'plus', run: () => openAddForm(ctx, widget.id) },
    config.links.length > 1 && { label: 'Open all in new tabs', icon: 'external-link', hint: config.links.length.toLocaleString(), run: () => openAll(ctx, config.links.map(link => link.url), { label: 'these quick links' }) },
    !config.links.length && { label: 'Restore suggested links', icon: 'rotate-ccw', run: () => saveLinks(widget.id, defaultQuickLinks()) },
    { separator: true },
    { heading: 'Show as' },
    ...STYLES.map(style => ({ label: style.label, checked: config.style === style.value, run: () => set({ style: style.value }) })),
    config.style === 'tiles' && { label: 'Show labels', checked: config.showLabels, run: () => set({ showLabels: !config.showLabels }) },
    { separator: true },
    { heading: 'Open links in' },
    ...OPEN_IN_OPTIONS.map(option => ({ label: option.label, checked: config.openIn === option.value, run: () => set({ openIn: option.value }) })),
  ]);
}

/* ------------------------------------------------------------------ render */

function linkAttrs(link, config, { gridKey, stop }) {
  return html`href="${safeHref(link.url)}" ${anchorTarget(config.openIn)} data-action="w.links.open" data-open-in="${config.openIn}"
    data-link-tile data-tile-key="${link.id}" data-link-id="${link.id}" draggable="true" data-focus-key="ql:${gridKey}:${link.id}" tabindex="${stop === link.id ? '0' : '-1'}"`;
}

const moreButton = (widget, link, gridKey, className = 'w-links-more') => html`<button type="button" class="${className}" tabindex="-1" aria-label="Options for ${linkLabel(link)}"
  data-action="w.quick-links.item-menu" data-widget="${widget.id}" data-id="${link.id}" data-grid="${gridKey}">${icon('ellipsis', { size: 14 })}</button>`;

function renderTiles(widget, config, ctxKeys) {
  const { gridKey, stop } = ctxKeys;
  return html`${config.links.map(link => {
    const label = linkLabel(link);
    const host = hostOf(link.url);
    return html`<li class="w-links-cell" data-key="${link.id}" data-link-cell>
      <a class="w-links-link" ${linkAttrs(link, config, ctxKeys)}
        ${config.showLabels ? html`title="${label === host ? label : `${label} (${host})`}"` : html`aria-label="${label}" data-tooltip="${label}"`}>
        <span class="w-links-tile">${tileIcon(link.url, { size: 36 })}</span>
        ${config.showLabels ? html`<span class="w-links-label">${label}</span>` : ''}
      </a>${moreButton(widget, link, gridKey)}
    </li>`;
  })}
  <li class="w-links-cell is-add" data-key="add">
    <button type="button" class="w-links-link is-add" data-action="w.quick-links.add" data-widget="${widget.id}" data-link-tile data-link-add data-tile-key="add"
      data-focus-key="ql:${gridKey}:add" tabindex="${stop === 'add' ? '0' : '-1'}" aria-label="Add a quick link" ${config.showLabels ? '' : html`data-tooltip="Add a quick link"`}>
      <span class="w-links-tile">${icon('plus', { size: 22 })}</span>${config.showLabels ? html`<span class="w-links-label">Add</span>` : ''}
    </button>
  </li>`;
}

function renderChips(widget, config, ctxKeys) {
  const { gridKey, stop } = ctxKeys;
  return html`${config.links.map(link => html`<li class="w-quick-links-chip-cell" data-key="${link.id}" data-link-cell>
      <a class="w-quick-links-chip" ${linkAttrs(link, config, ctxKeys)} title="${link.url}">${tileIcon(link.url, { size: 16 })}<span class="w-quick-links-chip-label">${linkLabel(link)}</span></a>
    </li>`)}
    <li class="w-quick-links-chip-cell" data-key="add">
      <button type="button" class="w-quick-links-chip is-add" data-action="w.quick-links.add" data-widget="${widget.id}" data-link-tile data-link-add data-tile-key="add"
        data-focus-key="ql:${gridKey}:add" tabindex="${stop === 'add' ? '0' : '-1'}" aria-label="Add a quick link">${icon('plus', { size: 14 })}<span class="w-quick-links-chip-label">Add</span></button>
    </li>`;
}

function renderList(widget, config, ctxKeys) {
  const { gridKey, stop } = ctxKeys;
  return html`${config.links.map(link => html`<li class="w-quick-links-row" data-key="${link.id}" data-link-cell>
      <a class="w-quick-links-row-link" ${linkAttrs(link, config, ctxKeys)}>
        <span class="w-quick-links-row-icon">${tileIcon(link.url, { size: 20 })}</span>
        <span class="w-quick-links-row-text"><span class="w-quick-links-row-title">${linkLabel(link)}</span><span class="w-quick-links-row-host">${hostOf(link.url)}</span></span>
      </a>${moreButton(widget, link, gridKey, 'w-quick-links-row-more')}
    </li>`)}
    <li class="w-quick-links-row is-add" data-key="add">
      <button type="button" class="w-quick-links-row-link is-add" data-action="w.quick-links.add" data-widget="${widget.id}" data-link-tile data-link-add data-tile-key="add"
        data-focus-key="ql:${gridKey}:add" tabindex="${stop === 'add' ? '0' : '-1'}">
        <span class="w-quick-links-row-icon">${icon('plus', { size: 16 })}</span><span class="w-quick-links-row-title">Add a quick link</span>
      </button>
    </li>`;
}

function render(ctx, widget, env) {
  initLinkGrids(ctx);
  const config = quickConfig(widget.config);
  if (!config.links.length) {
    return html`<div class="w-quick-links is-empty" data-key="ql-empty-${widget.id}">${emptyState({ icon: 'link', compact: true, title: 'No quick links yet',
      body: env.h > 2 ? 'Keep the sites you open every day one click away.' : '',
      actions: html`${button({ label: 'Add a link', icon: 'plus', size: 'sm', action: 'w.quick-links.add', data: { widget: widget.id } })}
        ${button({ label: 'Use suggestions', variant: 'ghost', size: 'sm', action: 'w.quick-links.restore', data: { widget: widget.id } })}` })}</div>`;
  }
  const gridKey = `ql:${widget.id}`;
  const stop = rovingStop(gridKey, [...config.links.map(link => link.id), 'add']);
  const keys = { gridKey, stop };
  const body = config.style === 'chips' ? renderChips(widget, config, keys) : config.style === 'list' ? renderList(widget, config, keys) : renderTiles(widget, config, keys);
  return html`<div class="${cx('w-quick-links', `is-${config.style}`)}" data-key="ql-${widget.id}" data-link-icons data-labels="${config.showLabels ? 'on' : 'off'}">
    <ul class="${cx(config.style === 'tiles' ? 'w-links-grid' : `w-quick-links-${config.style}`)}" role="list" aria-label="Quick links" data-key="grid-${config.style}"
      data-links-grid="${gridKey}" data-links-kind="quick" ${config.style === 'list' ? html`data-links-axis="y"` : ''} data-widget="${widget.id}" data-keydown="w.links.grid-key">${body}</ul>
  </div>`;
}

const headerActions = (_ctx, widget) => iconButton({ icon: 'plus', label: 'Add a quick link', action: 'w.quick-links.add', data: { widget: widget.id }, size: 'sm',
  className: 'w-quick-links-add-btn' });

/* ------------------------------------------------------------------ settings */

let session = null; // { widgetId, draft }

function editState(widget, draft) {
  if (!draft[EDIT]) draft[EDIT] = { rows: toRows(quickConfig(draft).links), errors: {} };
  session = { widgetId: widget.id, draft };
  return draft[EDIT];
}

function renderSettings(ctx, widget, draft) {
  const edit = editState(widget, draft);
  const config = quickConfig({ ...draft, links: [] });
  const id = `ql-${widget.id}`;
  return html`<div class="w-links-settings" data-key="ql-settings-${widget.id}">
    <div class="w-links-settings-fields">
      ${field({ label: 'Show as', control: segmented({ name: 'style', value: config.style, ariaLabel: 'Show as', action: 'w.quick-links.settings-field', options: STYLES }) })}
      ${field({ label: 'Open links in', id: `${id}-open`, control: select({ name: 'openIn', id: `${id}-open`, value: config.openIn, options: OPEN_IN_OPTIONS, action: 'w.quick-links.settings-field', className: 'is-block' }) })}
      ${config.style === 'tiles' ? html`<div class="w-links-settings-switches">${switchToggle({ label: 'Show labels under icons', name: 'showLabels', checked: config.showLabels,
        action: 'w.quick-links.settings-field' })}</div>` : ''}
    </div>
    ${renderLinkRows(ctx, { key: id, state: edit, legend: 'Links', addLabel: 'Add link', emptyText: 'No links yet. Add the sites you open most.' })}
  </div>`;
}

function validateSettings(draft) {
  const edit = draft?.[EDIT];
  if (!edit) return {};
  edit.errors = validateLinkRows(edit.rows).errors;
  return Object.fromEntries(Object.entries(edit.errors).map(([index, message]) => [`links.${index}`, message]));
}

function onSettingsSave(ctx, widget, draft) {
  const edit = draft[EDIT];
  const base = quickConfig({ ...draft, links: [] });
  if (!edit) return { ...base, links: quickConfig(draft).links };
  const { links, errors } = planQuickLinks(edit.rows);
  if (!links) {
    edit.errors = errors;
    ctx.render();
    focusFirstError(ctx, `ql-${widget.id}`);
    throw new Error('Fix the highlighted links, then save again.');
  }
  delete draft[EDIT];
  if (session?.draft === draft) session = null;
  return { ...base, links };
}

/* ------------------------------------------------------------------ definition and wiring */

registerLinkGrid('quick', {
  menu: (ctx, grid, id, anchor) => openTileMenu(ctx, grid.dataset.widget, id, anchor, grid.dataset.linksGrid),
  reorder: (ctx, grid, id, beforeId) => {
    const config = configOf(grid.dataset.widget);
    return config && reorder(ctx, grid.dataset.widget, placeBefore(config.links.map(link => link.id), [id], beforeId));
  },
  shift: (ctx, grid, id, delta) => {
    const config = configOf(grid.dataset.widget);
    return config && reorder(ctx, grid.dataset.widget, shiftId(config.links.map(link => link.id), id, delta));
  },
  dropLinks: (ctx, grid, links, beforeId) => addLinks(ctx, grid.dataset.widget, links, beforeId),
});

registerActions({
  'w.quick-links.add': ({ el, ctx, data }) => openAddForm(ctx, data.widget, el),
  'w.quick-links.item-menu': ({ el, ctx, data }) => openTileMenu(ctx, data.widget, data.id, el, data.grid),
  'w.quick-links.restore': ({ data }) => saveLinks(data.widget, defaultQuickLinks()),
  'w.quick-links.settings-field': ({ el, ctx, data }) => {
    const name = el.name || data.name;
    if (!session || !name) return;
    session.draft[name] = el.type === 'checkbox' ? el.checked : (data.value ?? el.value);
    ctx.render();
  },
});

defineWidget({
  type: TYPE,
  title: 'Quick links',
  description: 'Shortcuts to the sites you open most, as tiles, chips or a list.',
  icon: 'link',
  category: 'web',
  keywords: ['links', 'shortcuts', 'speed dial', 'favorites', 'sites', 'bookmarks', 'top sites'],
  size: { w: 6, h: 2, minW: 2, minH: 2, maxW: 12, maxH: 8 },
  presets: { S: { w: 3, h: 2 }, M: { w: 6, h: 2 }, L: { w: 8, h: 3 }, XL: { w: 12, h: 2 } },
  preview: 'Your everyday sites',
  defaults: () => ({ links: defaultQuickLinks(), style: 'tiles', showLabels: true, openIn: 'current' }),
  render,
  headerActions,
  menu: (ctx, widget) => widgetMenu(ctx, widget),
  renderSettings,
  validateSettings,
  onSettingsSave,
  init: ctx => initLinkGrids(ctx),
});
