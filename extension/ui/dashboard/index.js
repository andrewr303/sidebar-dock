// Dashboard view: header (greeting, search, board switcher, actions), the 12-column widget grid with edit mode, the
// sticky notes layer and the empty-board state. The new tab page shows this view, so it renders from stored data
// only (dashboard store + widget cache, both preloaded beside the library) and never waits on the network.
//
// Exports used elsewhere: renderDashboard(ctx), init(ctx), preload(), openWidgetGallery(ctx), openWidgetSettings(ctx, id).
// Actions: 'dashboard.add-widget', 'dashboard.edit' and the other 'dashboard.*' actions registered by the modules below.
import { html, cx } from '../html.js';
import { icon } from '../icons.js';
import { button, emptyState, skeleton } from '../components.js';
import { registerActions, registerMount } from '../runtime.js';
import * as store from '../../lib/store.js';
import { SEED_LIBRARY } from '../../lib/seed.js';
import '../widgets/index.js';
import * as stickies from '../stickies.js';
import { getWidget, clampSize } from './registry.js';
import * as dashboardStore from '../../lib/dashboard-store.js';
import { loadWidgetCache, onWidgetCacheChange } from '../../lib/widget-cache.js';
import { buildSeedDashboard } from '../../lib/dashboard-seed.js';
import { GRID_COLS, columnsForWidth, layoutBottom, findFreeSpot } from './grid.js';
import { dashUi, shownLayout, dashboardPrefs, newTabPrefs, canEdit, layoutPreview, greetingFor } from './state.js';
import { renderHeader, switchBoard, dateLabel } from './header.js';
import { initSearch } from './search.js';
import { renderFrame, highlight, openWidgetSettings } from './frame.js';
import { initEdit } from './edit.js';
import { initMotion, dragVisual } from './motion.js';
import { openWidgetGallery } from './gallery.js';
import './widget-settings.js';

export { openWidgetGallery, openWidgetSettings };

const SUGGESTIONS = ['clock', 'weather', 'links-folder', 'notes', 'checklist', 'quick-links', 'calendar', 'kanban'];

let preloading = null;
let loadError = '';

async function seedDashboard() {
  let library = null;
  try { library = await store.loadLibrary(SEED_LIBRARY); } catch (error) { console.warn('[still] seeding the dashboard without the library', error); }
  return buildSeedDashboard({ library, getDef: getWidget });
}

/** Loads the dashboard store (seeding the first-run board) and the widget cache. Idempotent; never rejects. */
export function preload() {
  preloading ||= (async () => {
    dashboardStore.setDashboardSeed(seedDashboard);
    const [dashboard] = await Promise.allSettled([dashboardStore.loadDashboard(), loadWidgetCache()]);
    if (dashboard.status === 'rejected') {
      console.error('[still] dashboard could not be loaded', dashboard.reason);
      loadError = 'Your dashboard could not be opened. Your library is unchanged.';
    }
  })();
  return preloading;
}

// ------------------------------------------------------------------ rendering

function renderCells(rows, preview) {
  const cells = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < GRID_COLS; x++) cells.push(html`<span class="dash-cell" data-x="${x}" data-y="${y}" style="grid-column:${x + 1};grid-row:${y + 1}"></span>`);
  }
  const drag = dragVisual();
  const target = drag && preview?.rects.find(r => r.id === drag.id);
  return html`<div class="dash-cells" data-key="dash-cells" aria-hidden="true">${cells}
    <span class="dash-placeholder" data-key="dash-placeholder" ${target ? html`style="grid-column:${target.x + 1} / span ${target.w};grid-row:${target.y + 1} / span ${target.h}"` : html`hidden`}></span></div>`;
}

function renderEmptyBoard(ctx, board) {
  const picks = SUGGESTIONS.map(getWidget).filter(Boolean).slice(0, 6);
  return html`<div class="dash-empty" data-key="dash-empty">
    ${emptyState({ icon: 'layout-dashboard', title: `${board.name} has no widgets yet`,
      body: 'Widgets bring your links, notes, tasks and the day ahead into one place. Start with one of these, or browse them all.',
      actions: button({ label: 'Add a widget', icon: 'plus', variant: 'primary', action: 'dashboard.add-widget' }) })}
    ${picks.length ? html`<ul class="dash-suggestions" aria-label="Suggested widgets">${picks.map(def => html`<li>
      <button type="button" class="dash-suggestion" data-action="dashboard.quick-add" data-type="${def.type}">
        <span class="dash-gallery-tile" data-category="${def.category}" aria-hidden="true">${icon(def.icon, { size: 18 })}</span>
        <span class="dash-suggestion-text"><span class="dash-suggestion-title">${def.title}</span>${def.description ? html`<span class="dash-suggestion-desc">${def.description}</span>` : ''}</span>
        ${icon('plus', { size: 16, className: 'dash-suggestion-plus' })}
      </button></li>`)}</ul>` : ''}
  </div>`;
}

function renderLoading() {
  return html`<div class="dashboard is-loading" data-key="dashboard" aria-busy="true">
    <div class="dash-header"><div class="dash-heading-text">${skeleton({ rows: 1, variant: 'text' })}</div></div>
    <div class="dash-grid" style="--cols:12" aria-hidden="true">${[[0, 3, 2], [3, 3, 2], [6, 6, 2], [0, 4, 3], [4, 4, 3], [8, 4, 3]].map(([x, w, h], i) => html`<span class="widget is-skeleton"
      data-key="sk-${i}" style="grid-column:${x + 1} / span ${w};grid-row:span ${h}"></span>`)}</div>
  </div>`;
}

/** Main-area renderer for the 'dashboard' view. */
export function renderDashboard(ctx) {
  const state = dashboardStore.getDashboard();
  if (!state) {
    if (loadError) {
      return html`<div class="dashboard" data-key="dashboard">${emptyState({ icon: 'triangle-alert', title: 'Your dashboard could not be opened', body: loadError, tone: 'danger',
        actions: button({ label: 'Try again', icon: 'refresh-cw', action: 'app.retry-boot' }) })}</div>`;
    }
    return renderLoading();
  }
  const ui = dashUi(ctx);
  const board = dashboardStore.activeBoard();
  const prefs = dashboardPrefs(ctx);
  const editing = !!ui.editing && canEdit(ctx);
  const layout = shownLayout(ctx, board);
  const rows = layoutBottom([...layout.values()]);
  const showStickies = prefs.stickies !== false && !state.prefs?.stickiesHidden && typeof stickies.renderStickyLayer === 'function';
  let stickyLayer = '';
  if (showStickies) {
    try { stickyLayer = stickies.renderStickyLayer(ctx, { boardId: board.id }) || ''; } catch (error) { console.error('[still] sticky notes layer failed', error); }
  }
  return html`<div class="${cx('dashboard', editing && 'is-editing', ui.cols < GRID_COLS && 'is-packed')}" data-key="dashboard" data-board="${board.id}"
    data-widget-style="${prefs.widgetStyle || 'card'}" data-gap="${prefs.gap || 'md'}" data-cols="${ui.cols}">
    ${renderHeader(ctx, board)}
    ${ui.editing && !canEdit(ctx) ? html`<p class="dash-edit-hint" data-key="dash-narrow">${icon('info', { size: 14 })}<span>Widen the window to rearrange widgets. On narrow screens they stack in order.</span></p>` : ''}
    <div class="dash-stage" data-key="dash-stage" style="--cols:${ui.cols}">
      ${editing ? renderCells(Math.max(rows + 4, 10), layoutPreview()) : ''}
      ${board.widgets.length ? html`<div class="dash-grid" data-key="dash-grid-${board.id}">${board.widgets.map(widget => renderFrame(ctx, board, widget, layout.get(widget.id)))}</div>`
        : renderEmptyBoard(ctx, board)}
      ${stickyLayer ? html`<div class="dash-stickies" data-key="dash-stickies">${stickyLayer}</div>` : ''}
      <div class="dash-measure" data-mount="dashboard.measure" data-morph="skip" data-key="dash-measure" aria-hidden="true"></div>
    </div>
    <p id="dash-edit-help" class="sr-only">Arrow keys move this widget, Shift and arrow keys resize it, Enter opens its settings, Delete removes it and Escape leaves edit mode.</p>
    <p class="sr-only" role="status" aria-live="polite" data-key="dash-announce">${ui.announce}</p>
  </div>`;
}

// Columns follow the stage width; a change re-renders before the browser paints (ResizeObserver runs before paint).
registerMount('dashboard.measure', (el, ctx) => {
  const stage = el.parentElement;
  if (!stage || typeof ResizeObserver === 'undefined') return null;
  const observer = new ResizeObserver(() => {
    const ui = dashUi(ctx);
    const cols = columnsForWidth(stage.clientWidth);
    ui.measured = true;
    if (cols === ui.cols) return;
    ui.cols = cols;
    ctx.renderNow();
  });
  observer.observe(stage);
  return { destroy: () => observer.disconnect() };
});

async function quickAdd(ctx, type) {
  const def = getWidget(type);
  const board = dashboardStore.activeBoard();
  if (!def || !board) return;
  const size = clampSize(def, def.size);
  let config = {};
  try { config = def.defaults?.() || {}; } catch (error) { console.error(error); }
  const widget = await dashboardStore.addWidget(board.id, { type, ...size, ...findFreeSpot(board.widgets, size.w, size.h, GRID_COLS), config,
    ...(def.style ? { style: { ...def.style } } : {}) });
  highlight(ctx, widget.id);
  let setup = false;
  try { setup = !!def.needsSetup?.(config); } catch (error) { console.error(error); }
  if (setup) ctx.nextFrame(() => openWidgetSettings(ctx, widget.id));
}

registerActions({
  'dashboard.quick-add': ({ ctx, data }) => quickAdd(ctx, data.type),
  'dashboard.noop': () => {},
});

// ------------------------------------------------------------------ init

let initialized = false;
export async function init(ctx) {
  if (initialized || ctx.env.isSidepanel || typeof document === 'undefined') return;
  initialized = true;
  await preload();
  dashboardStore.subscribeDashboard(() => ctx.render());
  // Another tab refreshed a widget's data (weather, pull requests…): show it here too.
  onWidgetCacheChange(() => { if (ctx.state.view === 'dashboard') ctx.render(); });
  initSearch(ctx);
  initEdit(ctx);
  initMotion(ctx);

  // Leaving the dashboard ends edit mode and closes the search suggestions.
  ctx.onRendered?.(() => {
    const ui = ctx.state.dash;
    if (ui && ctx.state.view !== 'dashboard' && (ui.editing || ui.search.open)) { ui.editing = false; ui.search.open = false; }
  });

  // Alt+1…9 switches boards. Ctrl/⌘+digits work too where the browser lets the page see them (Chrome keeps them for
  // switching tabs, so the menu shows the Alt shortcut).
  document.addEventListener('keydown', event => {
    const mod = ctx.env.isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    const chord = (event.altKey && !event.ctrlKey && !event.metaKey) || (mod && !event.altKey);
    if (ctx.state.view !== 'dashboard' || ctx.state.dialogs.length || event.defaultPrevented || !chord || event.shiftKey) return;
    const match = /^Digit([1-9])$/.exec(event.code);
    if (!match || event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const board = dashboardStore.getDashboard()?.boards[Number(match[1]) - 1];
    if (!board) return;
    event.preventDefault();
    ctx.run(() => switchBoard(ctx, board.id));
  });

  // Double-clicking an empty cell in edit mode opens the gallery for that spot.
  document.addEventListener('dblclick', event => {
    const cell = event.target instanceof Element ? event.target.closest('.dashboard.is-editing .dash-cell') : null;
    if (!cell) return;
    openWidgetGallery(ctx, { at: { x: Number(cell.dataset.x), y: Number(cell.dataset.y) } });
  });

  // The greeting and date follow the clock on a tab left open across the day.
  let label = `${greetingFor()}|${dateLabel()}`;
  setInterval(() => {
    const next = `${greetingFor()}|${dateLabel()}`;
    if (next === label) return;
    label = next;
    if (ctx.state.view === 'dashboard') ctx.render();
  }, 60_000);

  ctx.render();
  if (ctx.state.view === 'dashboard' && newTabPrefs(ctx).focusSearch && newTabPrefs(ctx).search) {
    ctx.nextFrame(() => { if (!document.activeElement || document.activeElement === document.body) document.getElementById('search')?.focus({ preventScroll: true }); });
  }
}
