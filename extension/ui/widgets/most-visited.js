// Most visited widget: the sites Chrome lists on its own new tab page (chrome.topSites), as white icon tiles or a list
// with addresses. Reading them needs the optional "topSites" permission, asked for from the widget's Allow button.
// The list is kept in lib/widget-cache.js so a new tab paints at once, and is read again whenever the page regains
// focus. Sites can be hidden from one widget (their ⋯ or context menu) and brought back from the widget menu or its
// settings. Tiles share the links widgets' keyboard model (arrow keys, Shift+F10 / Menu key for options) and can be
// dragged into a links folder or quick links.
import { html, cx, plural, safeHref } from '../html.js';
import { icon } from '../icons.js';
import { registerActions } from '../runtime.js';
import { button, iconButton, select, segmented, field, emptyState } from '../components.js';
import { defineWidget, getSettingsDraft } from '../dashboard/registry.js';
import * as dashboardStore from '../../lib/dashboard-store.js';
import { hasPermissions, requestPermissions, onPermissionsChanged } from '../../lib/permissions.js';
import { readCache, writeCache, deleteCache, onWidgetCacheChange } from '../../lib/widget-cache.js';
import { OPEN_IN_OPTIONS, anchorTarget, copyLink, openMenuItems, openAll, tidyMenu, stableAnchor, registerLinkGrid, rovingStop, initLinkGrids } from './links/shared.js';
import { tileIcon } from './links/favicons.js';
import { hostOf } from './links/model.js';
import { mostVisitedConfig, mostVisitedDefaults, visibleSites, siteKey, siteLabel, cleanSites, COUNT_OPTIONS } from './most-visited/model.js';

const TYPE = 'most-visited';
const CACHE_KEY = 'most-visited';
const REFRESH_GAP = 15_000;   // ms between automatic reads (focus, visibility)
const VIEWS = [{ value: 'tiles', label: 'Tiles', icon: 'layout-grid' }, { value: 'list', label: 'List', icon: 'list' }];
const DENIED = 'Chrome did not allow access to your most visited sites. Try again and choose Allow.';

const inExtension = () => !!globalThis.chrome?.runtime?.id;
const topSitesApi = () => (typeof globalThis.chrome?.topSites?.get === 'function' ? globalThis.chrome.topSites : null);

/* ------------------------------------------------------------------ session (one list for every widget on the page) */

const session = { access: null, error: '', checkedAt: 0, loading: null };
let lastCtx = null;
let started = false;
const rerender = () => lastCtx?.render?.();
const cachedSites = () => { const value = readCache(CACHE_KEY)?.value; return Array.isArray(value) ? value : null; };

/** Reads Chrome's top sites into the cache. `force` skips the short gap between automatic reads. */
function refresh({ force = false } = {}) {
  if (!inExtension()) return Promise.resolve();
  if (session.loading) return session.loading;
  if (!force && session.access !== null && Date.now() - session.checkedAt < REFRESH_GAP) return Promise.resolve();
  session.loading = (async () => {
    session.access = await hasPermissions('topSites');
    if (!session.access) {
      // Access was removed (Chrome's settings, another tab): forget the list too.
      if (cachedSites()) deleteCache(CACHE_KEY);
      session.error = '';
      return;
    }
    try {
      const api = topSitesApi();
      if (!api) throw new Error('chrome.topSites is unavailable');
      const list = cleanSites(await api.get());
      session.error = '';
      if (JSON.stringify(cachedSites()) !== JSON.stringify(list)) writeCache(CACHE_KEY, list);
    } catch (error) {
      console.warn('[still] most visited sites not read', error?.message || error);
      session.error = 'Unable to read your most visited sites. Try again.';
    }
  })().finally(() => {
    session.checkedAt = Date.now();
    session.loading = null;
    rerender();
  });
  return session.loading;
}

function start(ctx) {
  lastCtx = ctx;
  if (started || typeof document === 'undefined') return;
  started = true;
  initLinkGrids(ctx);
  if (!inExtension()) return;
  refresh({ force: true });
  // Chrome updates its list as you browse: read it again when you come back to the page.
  globalThis.addEventListener?.('focus', () => refresh());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  onPermissionsChanged(() => refresh({ force: true }));
  onWidgetCacheChange(keys => { if (keys.includes(CACHE_KEY)) rerender(); });
}

/* ------------------------------------------------------------------ writes */

const configOf = widgetId => {
  const found = dashboardStore.findWidget(widgetId);
  return found ? mostVisitedConfig(found.widget.config) : null;
};

async function hideSite(ctx, widgetId, url) {
  const config = configOf(widgetId);
  const key = siteKey(url);
  if (!config || !key) return;
  const site = (cachedSites() || []).find(entry => siteKey(entry.url) === key);
  await dashboardStore.updateWidgetConfig(widgetId, { hidden: [...config.hidden, key] });
  ctx.toast(`Hid “${site ? siteLabel(site) : hostOf(url)}”`, { action: { label: 'Undo', run: () => dashboardStore.updateWidgetConfig(widgetId, { hidden: config.hidden }) } });
}

async function showHidden(ctx, widgetId) {
  const config = configOf(widgetId);
  if (!config?.hidden.length) return;
  await dashboardStore.updateWidgetConfig(widgetId, { hidden: [] });
  ctx.toast(`Showing ${plural(config.hidden.length, 'hidden site')} again`, { action: { label: 'Undo', run: () => dashboardStore.updateWidgetConfig(widgetId, { hidden: config.hidden }) } });
}

async function saveToStill(ctx, site) {
  const saved = await ctx.store.saveItem({ type: 'bookmark', url: site.url, ...(site.title && !/^https?:\/\//i.test(site.title) ? { title: site.title } : {}) });
  ctx.toast(`Saved “${saved.title}” to Inbox`, { tone: 'success', action: { label: 'Open', run: () => ctx.openItem(saved.id) } });
}

/** Asks Chrome for the topSites permission. Call from a click: the prompt needs the gesture. */
function allowAccess(ctx) {
  const asked = requestPermissions('topSites'); // during the gesture
  return asked.then(granted => {
    if (!granted) { ctx.toast(DENIED, { tone: 'danger' }); return undefined; }
    session.access = true;
    return refresh({ force: true });
  });
}

/* ------------------------------------------------------------------ menus */

function siteMenu(ctx, widgetId, key, anchor) {
  const config = configOf(widgetId);
  const site = (cachedSites() || []).find(entry => siteKey(entry.url) === key);
  if (!config || !site) return;
  const saved = ctx.select.savedForUrl(site.url);
  ctx.openMenu(stableAnchor(anchor), tidyMenu([
    ...openMenuItems(ctx, site.url, config.openIn),
    { separator: true },
    { label: 'Copy link', icon: 'copy', run: () => copyLink(ctx, site.url) },
    saved ? { label: 'Open in Still', icon: 'panel-right-open', run: () => ctx.openItem(saved.id) }
      : { label: 'Save to Still', icon: 'bookmark-plus', run: () => saveToStill(ctx, site) },
    { separator: true },
    { label: 'Hide from this widget', icon: 'eye-off', run: () => hideSite(ctx, widgetId, site.url) },
  ]), { label: `Options for ${siteLabel(site)}` });
}

function widgetMenu(ctx, widget) {
  const config = mostVisitedConfig(widget.config);
  const set = patch => dashboardStore.updateWidgetConfig(widget.id, patch);
  const sites = session.access === false ? [] : visibleSites(cachedSites() || [], config).sites;
  return tidyMenu([
    sites.length > 1 && { label: 'Open all in new tabs', icon: 'external-link', hint: sites.length.toLocaleString(), run: () => openAll(ctx, sites.map(site => site.url), { label: 'your most visited sites' }) },
    config.hidden.length && { label: 'Show hidden sites', icon: 'eye', hint: config.hidden.length.toLocaleString(), run: () => showHidden(ctx, widget.id) },
    { separator: true },
    { heading: 'Show as' },
    ...VIEWS.map(view => ({ label: view.label, checked: config.view === view.value, run: () => set({ view: view.value }) })),
    { separator: true },
    { heading: 'Open sites in' },
    ...OPEN_IN_OPTIONS.map(option => ({ label: option.label, checked: config.openIn === option.value, run: () => set({ openIn: option.value }) })),
  ]);
}

/* ------------------------------------------------------------------ render */

function previewState(env) {
  return html`<div class="w-most-visited is-state" data-key="mv-preview">${emptyState({ icon: 'trending-up', compact: true, title: 'Your most visited sites',
    body: env.h > 2 ? 'They appear here when Still runs as a Chrome extension. This preview can’t read Chrome’s list.' : '' })}</div>`;
}

function accessState(widget, env) {
  return html`<div class="w-most-visited is-state" data-key="mv-access">${emptyState({ icon: 'trending-up', compact: true, title: 'Show the sites you visit most',
    body: env.h > 2 || env.w > 3 ? 'Still reads the list Chrome keeps for its new tab page. It stays on this computer.' : '',
    actions: button({ label: 'Allow access', icon: 'lock-open', variant: 'primary', size: 'sm', action: 'w.most-visited.allow', data: { widget: widget.id } }) })}</div>`;
}

function errorState(widget) {
  return html`<div class="w-most-visited is-state" data-key="mv-error">${emptyState({ icon: 'triangle-alert', compact: true, tone: 'danger', title: 'Unable to read your most visited sites',
    body: 'Chrome didn’t answer. Try again in a moment.',
    actions: button({ label: 'Try again', icon: 'refresh-cw', size: 'sm', action: 'w.most-visited.retry', data: { widget: widget.id } }) })}</div>`;
}

function loadingState(config) {
  const n = Math.min(config.count, 12);
  return html`<div class="${cx('w-most-visited', `is-${config.view}`, 'is-loading')}" data-key="mv-loading" aria-busy="true">
    <span class="sr-only" role="status">Loading your most visited sites</span>
    <ul class="${config.view === 'list' ? 'w-most-visited-list' : 'w-most-visited-grid'}" role="presentation" aria-hidden="true">
      ${Array.from({ length: n }, (_, i) => config.view === 'list'
        ? html`<li class="w-most-visited-row is-skeleton" data-key="s${i}"><span class="w-most-visited-row-link"><span class="w-most-visited-row-icon skeleton-bone"></span>
            <span class="w-most-visited-row-text"><span class="skeleton-bone w-most-visited-bone"></span><span class="skeleton-bone w-most-visited-bone is-short"></span></span></span></li>`
        : html`<li class="w-most-visited-cell is-skeleton" data-key="s${i}"><span class="w-most-visited-link"><span class="w-most-visited-tile skeleton-bone"></span>
            <span class="skeleton-bone w-most-visited-bone is-label"></span></span></li>`)}
    </ul>
  </div>`;
}

function emptyList(widget, config, hiddenCount, env) {
  if (hiddenCount) {
    return html`<div class="w-most-visited is-state" data-key="mv-all-hidden">${emptyState({ icon: 'eye-off', compact: true, title: 'You hid every site',
      body: env.h > 2 ? `${plural(hiddenCount, 'site')} from Chrome’s list ${hiddenCount === 1 ? 'is' : 'are'} hidden in this widget.` : '',
      actions: button({ label: 'Show hidden sites', icon: 'eye', size: 'sm', action: 'w.most-visited.show-hidden', data: { widget: widget.id } }) })}</div>`;
  }
  return html`<div class="w-most-visited is-state" data-key="mv-empty">${emptyState({ icon: 'trending-up', compact: true, title: 'No sites yet',
    body: env.h > 2 || env.w > 3 ? 'Sites you visit often in Chrome show up here.' : '' })}</div>`;
}

function siteAttrs(site, key, config, gridKey, stop) {
  return html`href="${safeHref(site.url)}" ${anchorTarget(config.openIn)} data-action="w.links.open" data-open-in="${config.openIn}" draggable="true"
    data-link-tile data-tile-key="${key}" data-link-id="${key}" data-focus-key="${gridKey}:${key}" tabindex="${stop === key ? '0' : '-1'}"`;
}

const moreButton = (widget, site, key, gridKey, className) => html`<button type="button" class="${className}" tabindex="-1" aria-label="Options for ${siteLabel(site)}"
  data-action="w.most-visited.item-menu" data-widget="${widget.id}" data-id="${key}" data-grid="${gridKey}">${icon('ellipsis', { size: 14 })}</button>`;

function render(ctx, widget, env) {
  start(ctx);
  const config = mostVisitedConfig(widget.config);
  if (!inExtension()) return previewState(env);
  if (session.access === false) return accessState(widget, env);
  const list = cachedSites();
  if (!list) return session.error ? errorState(widget) : loadingState(config);
  const { sites, hiddenCount } = visibleSites(list, config);
  if (!sites.length) return emptyList(widget, config, hiddenCount, env);
  const gridKey = `mv:${widget.id}`;
  const keys = sites.map(site => siteKey(site.url));
  const stop = rovingStop(gridKey, keys);
  const tiles = config.view !== 'list';
  return html`<div class="${cx('w-most-visited', `is-${config.view}`)}" data-key="mv-${widget.id}" data-link-icons>
    <ul class="${tiles ? 'w-most-visited-grid' : 'w-most-visited-list'}" role="list" aria-label="Most visited sites" data-key="grid-${config.view}"
      data-links-grid="${gridKey}" data-links-kind="most-visited" ${tiles ? '' : html`data-links-axis="y"`} data-widget="${widget.id}" data-keydown="w.links.grid-key">
      ${sites.map((site, index) => {
        const key = keys[index];
        const label = siteLabel(site);
        const host = hostOf(site.url);
        if (!tiles) {
          return html`<li class="w-most-visited-row" data-key="${key}">
            <a class="w-most-visited-row-link" ${siteAttrs(site, key, config, gridKey, stop)} title="${site.url}">
              <span class="w-most-visited-row-icon">${tileIcon(site.url, { size: 16 })}</span>
              <span class="w-most-visited-row-text"><span class="w-most-visited-row-title">${label}</span>${label !== host ? html`<span class="w-most-visited-row-host">${host}</span>` : ''}</span>
            </a>${moreButton(widget, site, key, gridKey, 'w-most-visited-row-more')}
          </li>`;
        }
        return html`<li class="w-most-visited-cell" data-key="${key}">
          <a class="w-most-visited-link" ${siteAttrs(site, key, config, gridKey, stop)} title="${label === host ? label : `${label} (${host})`}">
            <span class="w-most-visited-tile">${tileIcon(site.url, { size: 32 })}</span>
            <span class="w-most-visited-label">${label}</span>
          </a>${moreButton(widget, site, key, gridKey, 'w-most-visited-more')}
        </li>`;
      })}
    </ul>
  </div>`;
}

/* ------------------------------------------------------------------ settings */

function renderSettings(_ctx, widget, draft) {
  const config = mostVisitedConfig(draft);
  const id = `mv-${widget.id}`;
  const list = cachedSites() || [];
  const labelFor = key => { const site = list.find(entry => siteKey(entry.url) === key); return site ? siteLabel(site) : key.split('/')[0]; };
  return html`<div class="w-most-visited-settings" data-key="mv-settings-${widget.id}">
    ${session.access === false ? html`<div class="w-most-visited-settings-access" role="status">
      <p>Still doesn’t have access to your most visited sites yet.</p>
      ${button({ label: 'Allow access', icon: 'lock-open', size: 'sm', action: 'w.most-visited.allow', data: { widget: widget.id } })}
    </div>` : ''}
    ${field({ label: 'Show as', control: segmented({ name: 'view', value: config.view, options: VIEWS, action: 'dashboard.draft-set', ariaLabel: 'Show as' }) })}
    <div class="w-most-visited-settings-row">
      ${field({ label: 'Number of sites', id: `${id}-count`, hint: 'Chrome lists up to about ten sites.',
        control: select({ id: `${id}-count`, name: 'count', value: String(COUNT_OPTIONS.includes(config.count) ? config.count : 8), action: 'dashboard.draft', className: 'is-block',
          options: COUNT_OPTIONS.map(n => ({ value: String(n), label: String(n) })) }) })}
      ${field({ label: 'Open sites in', id: `${id}-open`, control: select({ id: `${id}-open`, name: 'openIn', value: config.openIn, options: OPEN_IN_OPTIONS, action: 'dashboard.draft', className: 'is-block' }) })}
    </div>
    <fieldset class="w-most-visited-hidden">
      <legend class="w-most-visited-hidden-title">Hidden sites${config.hidden.length ? html` <span class="w-most-visited-hidden-count">${config.hidden.length}</span>` : ''}</legend>
      ${config.hidden.length ? html`<ul class="w-most-visited-hidden-list" role="list" data-link-icons>
        ${config.hidden.map(key => html`<li class="w-most-visited-hidden-row" data-key="${key}">
          <span class="w-most-visited-hidden-icon" aria-hidden="true">${tileIcon(`https://${key}`, { size: 16 })}</span>
          <span class="w-most-visited-hidden-label" title="${key}">${labelFor(key)}</span>
          ${button({ label: 'Show', size: 'sm', variant: 'ghost', action: 'w.most-visited.unhide', data: { key }, attrs: { 'aria-label': `Show ${labelFor(key)} again` } })}
        </li>`)}
      </ul>` : html`<p class="w-most-visited-hidden-empty">None. To hide a site, open its menu with a right-click or the ⋯ button.</p>`}
    </fieldset>
  </div>`;
}

const onSettingsSave = (_ctx, _widget, draft) => mostVisitedConfig({ ...draft, count: Number(draft.count) });

/* ------------------------------------------------------------------ definition and wiring */

registerLinkGrid('most-visited', {
  menu: (ctx, grid, key, anchor) => siteMenu(ctx, grid.dataset.widget, key, anchor),
  // Chrome keeps this list from your browsing, so a dropped link has nowhere to go: say where it can.
  dropLinks: ctx => ctx.toast('Chrome fills this list from your browsing. Drop links on a links folder or a bookmarks widget instead.'),
});

registerActions({
  'w.most-visited.allow': ({ ctx }) => allowAccess(ctx),
  'w.most-visited.retry': () => refresh({ force: true }),
  'w.most-visited.show-hidden': ({ ctx, data }) => showHidden(ctx, data.widget),
  'w.most-visited.item-menu': ({ el, ctx, data }) => siteMenu(ctx, data.widget, data.id, el),
  'w.most-visited.unhide': ({ data }) => {
    const holder = getSettingsDraft();
    if (!holder) return;
    const hidden = mostVisitedConfig(holder.draft).hidden.filter(key => key !== data.key);
    holder.set({ hidden });
  },
});

defineWidget({
  type: TYPE,
  title: 'Most visited',
  description: 'The sites you open most in Chrome, as tiles or a list.',
  icon: 'trending-up',
  category: 'web',
  keywords: ['top sites', 'frequent', 'speed dial', 'history', 'shortcuts', 'sites'],
  size: { w: 4, h: 3, minW: 2, minH: 2, maxW: 12, maxH: 8 },
  presets: { S: { w: 3, h: 2 }, M: { w: 4, h: 3 }, L: { w: 6, h: 3 }, XL: { w: 8, h: 4 } },
  permissions: { permissions: ['topSites'] },
  preview: 'Your top sites',
  defaults: mostVisitedDefaults,
  init: ctx => start(ctx),
  render,
  menu: (ctx, widget) => widgetMenu(ctx, widget),
  renderSettings,
  onSettingsSave,
  settingsSize: 'md',
});
