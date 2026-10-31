// Widget frames: the chrome around every widget body (title row, header actions, ⋯ menu, edit handles) and the
// frame menu (settings, size, rename, style, duplicate, move to board, remove with undo). Bodies come from the
// widget definitions and render inside an error boundary.
import { html, cx, raw } from '../html.js';
import { icon } from '../icons.js';
import { button, emptyState } from '../components.js';
import { registerActions } from '../runtime.js';
import { getWidget, widgetEnv, sizePresets } from './registry.js';
import { resizeWidget, GRID_COLS } from './grid.js';
import * as dashboardStore from '../../lib/dashboard-store.js';
import { dashUi, canEdit } from './state.js';
import { dragVisual, animateNextLayout } from './motion.js';

const FRAMES = [
  { value: 'default', label: 'Dashboard default' }, { value: 'card', label: 'Card' }, { value: 'glass', label: 'Glass' },
  { value: 'flat', label: 'Flat' }, { value: 'none', label: 'No background' },
];
const initialized = new Set();

/** Display title: the instance's own title, else the definition's displayTitle (e.g. a collection name), else its title. */
export function widgetTitle(widget, def = getWidget(widget.type), ctx = null) {
  if (widget.title) return widget.title;
  if (def?.displayTitle && ctx) {
    try { const title = def.displayTitle(ctx, widget); if (title) return String(title); } catch (error) { console.error(error); }
  }
  return def?.title || 'Widget';
}

/** The env for a widget instance (registry.widgetEnv plus the dashboard's extras). */
export function envFor(ctx, board, widget) {
  const ui = dashUi(ctx);
  return {
    ...widgetEnv({ widget, board, editing: !!ui.editing && canEdit(ctx), surface: ctx.env.isSidepanel ? 'side' : 'full', newtab: !!ctx.env.isNewtab,
      update: patch => dashboardStore.updateWidgetConfig(widget.id, patch) }),
    cols: ui.cols,
    openSettings: () => ctx.dispatch('dashboard.widget-settings', { data: { widget: widget.id } }),
  };
}

function renderBody(ctx, board, widget, def, env) {
  const ui = dashUi(ctx);
  if (!def) {
    return emptyState({ icon: 'puzzle', title: 'This widget is not available', compact: true,
      body: 'It may come from a newer version of Still. Remove it or keep it for later.',
      actions: button({ label: 'Remove widget', icon: 'trash-2', size: 'sm', action: 'dashboard.widget-remove', data: { widget: widget.id } }) });
  }
  if (ui.errors.get(widget.id) === ui.stamp) {
    return emptyState({ icon: 'triangle-alert', title: `${widgetTitle(widget, def, ctx)} could not be shown`, compact: true, tone: 'danger',
      body: 'Something went wrong while drawing this widget. Your dashboard and library are unchanged.',
      actions: button({ label: 'Reload widget', icon: 'refresh-cw', size: 'sm', action: 'dashboard.widget-reload', data: { widget: widget.id } }) });
  }
  if (def.init && !initialized.has(def.type)) {
    initialized.add(def.type);
    try { def.init(ctx); } catch (error) { console.error(`[still] ${def.type} init failed`, error); }
  }
  try { return def.render(ctx, widget, env); } catch (error) {
    console.error(`[still] widget ${widget.type} failed to render`, error);
    ui.errors.set(widget.id, ui.stamp);
    return emptyState({ icon: 'triangle-alert', title: `${widgetTitle(widget, def, ctx)} could not be shown`, compact: true, tone: 'danger',
      body: 'Something went wrong while drawing this widget. Your dashboard and library are unchanged.',
      actions: button({ label: 'Reload widget', icon: 'refresh-cw', size: 'sm', action: 'dashboard.widget-reload', data: { widget: widget.id } }) });
  }
}

function headerActions(ctx, widget, def, env) {
  if (!def?.headerActions) return '';
  try { return def.headerActions(ctx, widget, env) || ''; } catch (error) { console.error(error); return ''; }
}

const menuButton = (ctx, widget, title, className = 'widget-menu-btn') => html`<button type="button" class="${cx('icon-btn', 'icon-btn-sm', className)}"
  data-action="dashboard.widget-menu" data-widget="${widget.id}" aria-label="${title} options" data-tooltip="Widget options" data-tooltip-pos="bottom end"
  aria-haspopup="true" aria-expanded="${ctx.state.popover?.anchorEl?.dataset?.widget === widget.id ? 'true' : 'false'}">${icon('ellipsis', { size: 14 })}</button>`;

/** One widget frame placed on the grid at rect (cells on the shown grid). */
export function renderFrame(ctx, board, widget, rect) {
  const ui = dashUi(ctx);
  const def = getWidget(widget.type);
  const env = envFor(ctx, board, widget);
  const title = widgetTitle(widget, def, ctx);
  const editing = env.editing;
  const frame = widget.style?.frame || 'default';
  // Bare definitions (a big clock, a folder tile) draw no chrome unless a background is chosen; they never show a title row.
  const bare = frame === 'none' || (def?.frame === 'bare' && frame === 'default');
  const showHead = def?.frame !== 'bare' && frame !== 'none' && !widget.style?.hideTitle;
  const drag = dragVisual();
  const dragging = drag?.id === widget.id;
  const style = [`grid-column:${rect.x + 1} / span ${rect.w}`, `grid-row:${rect.y + 1} / span ${rect.h}`,
    dragging ? `transform:translate(${Math.round(drag.tx)}px, ${Math.round(drag.ty)}px)` : ''].filter(Boolean).join(';');
  const titleId = `wt-${widget.id}`;
  return html`<section class="${cx('widget', bare && 'is-bare', def?.frame === 'bare' && 'is-bare-def', !showHead && 'is-headless', dragging && (drag.kind === 'move' ? 'is-moving' : 'is-resizing'),
      ui.highlight === widget.id && 'is-new')}"
    data-key="widget-${widget.id}" data-widget-id="${widget.id}" data-type="${widget.type}" data-size="${env.size}" data-w="${widget.w}" data-h="${widget.h}"
    data-frame="${frame}" style="${style}" aria-labelledby="${titleId}"
    ${editing ? raw(`tabindex="0" aria-roledescription="widget" aria-describedby="dash-edit-help" data-keydown="dashboard.frame-key"`) : ''}>
    ${showHead ? html`<header class="widget-head" ${editing ? raw('data-drag-handle') : ''}>
        ${editing ? icon('grip-vertical', { size: 14, className: 'widget-grip' }) : html`<span class="widget-icon" aria-hidden="true">${icon(def?.icon || 'layout-grid', { size: 14 })}</span>`}
        <h2 class="widget-title" id="${titleId}" title="${title}">${title}</h2>
        <span class="widget-head-actions">${editing ? '' : headerActions(ctx, widget, def, env)}${menuButton(ctx, widget, title)}</span>
      </header>`
      : html`<h2 class="sr-only" id="${titleId}">${title}</h2>
        <div class="widget-float" ${editing ? raw('data-drag-handle') : ''}>
          ${editing ? html`<span class="widget-float-grip" title="Drag to move">${icon('grip', { size: 14 })}</span>` : ''}
          ${editing ? '' : html`<span class="widget-float-actions">${headerActions(ctx, widget, def, env)}</span>`}
          ${menuButton(ctx, widget, title, 'widget-menu-btn widget-float-btn')}
        </div>`}
    <div class="widget-body" ${editing ? raw('inert') : ''}>${renderBody(ctx, board, widget, def, env)}</div>
    ${editing ? html`<span class="widget-size-badge" aria-hidden="true">${widget.w} × ${widget.h}</span>
      <span class="widget-resize is-e" data-resize="e" aria-hidden="true"></span>
      <span class="widget-resize is-s" data-resize="s" aria-hidden="true"></span>
      <span class="widget-resize is-se" data-resize="se" aria-hidden="true">${icon('move-diagonal-2', { size: 12 })}</span>` : ''}
  </section>`;
}

// ------------------------------------------------------------------ frame menu

function sizeMenu(ctx, widget, def) {
  return sizePresets(def).map(preset => ({ label: `${preset.label}`, hint: `${preset.w} × ${preset.h}`, checked: widget.w === preset.w && widget.h === preset.h,
    run: () => resizeTo(ctx, widget, preset) }));
}

export async function resizeTo(ctx, widget, { w, h }) {
  const found = dashboardStore.findWidget(widget.id);
  if (!found) return;
  const def = getWidget(widget.type);
  const rects = found.board.widgets.map(({ id, x, y, w: ww, h: hh }) => ({ id, x, y, w: ww, h: hh }));
  // A size wider than the space to the right shifts the widget left instead of shrinking it.
  const target = rects.find(r => r.id === widget.id);
  if (target.x + w > GRID_COLS) target.x = Math.max(0, GRID_COLS - w);
  const next = resizeWidget(rects, widget.id, { w, h }, GRID_COLS, def?.size);
  animateNextLayout(ctx);
  await dashboardStore.applyLayout(found.board.id, next);
}

function styleMenu(ctx, widget, def) {
  const frame = widget.style?.frame || 'default';
  return [
    { heading: 'Background' },
    ...FRAMES.map(f => ({ label: f.label, checked: frame === f.value, run: () => dashboardStore.updateWidget(widget.id, { style: { frame: f.value } }) })),
    { separator: true },
    { label: 'Show title', checked: !widget.style?.hideTitle, disabled: def?.frame === 'bare',
      run: () => dashboardStore.updateWidget(widget.id, { style: { hideTitle: !widget.style?.hideTitle } }) },
  ];
}

function moveMenu(ctx, widget) {
  const state = dashboardStore.getDashboard();
  const current = dashboardStore.findWidget(widget.id)?.board;
  return [
    { heading: 'Move to board' },
    ...state.boards.filter(b => b.id !== current?.id).map(b => ({ label: b.name, icon: b.icon, run: async () => {
      await dashboardStore.moveWidgetToBoard(widget.id, b.id);
      ctx.toast(`Moved to ${b.name}`, { action: { label: 'Show', run: () => dashboardStore.setActiveBoard(b.id) } });
    } })),
    { separator: true },
    { label: 'New board…', icon: 'plus', run: async () => {
      const name = await ctx.prompt({ title: 'New board', label: 'Board name', placeholder: 'Work, Reading…', confirmLabel: 'Create and move' });
      if (name === null) return;
      const previous = state.activeBoardId;
      const board = await dashboardStore.addBoard({ name: name.trim() || 'New board' });
      await dashboardStore.setActiveBoard(previous);
      await dashboardStore.moveWidgetToBoard(widget.id, board.id);
      ctx.toast(`Moved to ${board.name}`, { action: { label: 'Show', run: () => dashboardStore.setActiveBoard(board.id) } });
    } },
  ];
}

export async function removeWidget(ctx, widgetId) {
  const found = dashboardStore.findWidget(widgetId);
  if (!found) return;
  const title = widgetTitle(found.widget, undefined, ctx);
  const { boardId, widget } = await dashboardStore.removeWidget(widgetId);
  dashUi(ctx).announce = `Removed ${title}`;
  ctx.toast(`Removed ${title}`, { action: { label: 'Undo', run: () => dashboardStore.restoreWidget(boardId, widget) } });
}

function frameMenu(ctx, widget, anchor) {
  const def = getWidget(widget.type);
  const found = dashboardStore.findWidget(widget.id);
  const env = found ? envFor(ctx, found.board, widget) : null;
  let extra = [];
  try { extra = def?.menu && env ? def.menu(ctx, widget, env) || [] : []; } catch (error) { console.error(error); }
  const boards = dashboardStore.getDashboard()?.boards.length || 1;
  const sub = (label, iconName, build) => ({ label: `${label}…`, icon: iconName, keepFocus: true,
    run: () => anchor.isConnected && ctx.openMenu(anchor, build(), { placement: 'bottom-end', label }) });
  return [
    ...(def ? [{ label: 'Settings…', icon: 'settings-2', run: () => openWidgetSettings(ctx, widget.id) }] : []),
    ...(extra.length ? [{ separator: true }, ...extra, { separator: true }] : []),
    ...(def ? [sub('Size', 'scaling', () => sizeMenu(ctx, widget, def))] : []),
    { label: 'Rename…', icon: 'pencil', run: () => renameWidget(ctx, widget) },
    sub('Style', 'palette', () => styleMenu(ctx, widget, def)),
    { label: 'Duplicate', icon: 'copy', disabled: !def, run: () => duplicate(ctx, widget) },
    sub(boards > 1 ? 'Move to board' : 'Move to a new board', 'layers', () => moveMenu(ctx, widget)),
    { separator: true },
    { label: 'Remove', icon: 'trash-2', danger: true, run: () => removeWidget(ctx, widget.id) },
  ];
}

async function renameWidget(ctx, widget) {
  const def = getWidget(widget.type);
  const fallback = widgetTitle({ ...widget, title: '' }, def, ctx);
  const value = await ctx.prompt({ title: 'Rename widget', label: 'Title', value: widgetTitle(widget, def, ctx), placeholder: fallback, confirmLabel: 'Rename' });
  if (value === null) return;
  // An empty title or the default one goes back to following the widget's own title (e.g. a collection name).
  const title = [def?.title || '', fallback].includes(value.trim()) ? '' : value.trim();
  await dashboardStore.updateWidget(widget.id, { title });
}

async function duplicate(ctx, widget) {
  const copy = await dashboardStore.duplicateWidget(widget.id);
  highlight(ctx, copy.id);
}

/** Scrolls a widget into view and pulses it briefly (after adding or duplicating). */
export function highlight(ctx, widgetId) {
  const ui = dashUi(ctx);
  ui.highlight = widgetId;
  ctx.render();
  ctx.nextFrame(() => {
    const el = document.querySelector(`[data-widget-id="${CSS.escape(widgetId)}"]`);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'reduced';
    el?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  });
  setTimeout(() => { if (ui.highlight === widgetId) { ui.highlight = ''; ctx.render(); } }, 1800);
}

// Late-bound to avoid an import cycle with widget-settings.js (which imports this module for titles).
let openSettingsImpl = null;
export const bindWidgetSettings = fn => { openSettingsImpl = fn; };
export const openWidgetSettings = (ctx, widgetId) => openSettingsImpl?.(ctx, widgetId);

registerActions({
  'dashboard.widget-menu': ({ ctx, el, data }) => {
    const found = dashboardStore.findWidget(data.widget);
    if (!found) return;
    ctx.openMenu(el, frameMenu(ctx, found.widget, el), { placement: 'bottom-end', label: `${widgetTitle(found.widget, undefined, ctx)} options` });
  },
  'dashboard.widget-settings': ({ ctx, data }) => openWidgetSettings(ctx, data.widget),
  'dashboard.widget-remove': ({ ctx, data }) => removeWidget(ctx, data.widget),
  'dashboard.widget-reload': ({ ctx, data }) => {
    const ui = dashUi(ctx);
    ui.errors.delete(data.widget);
    ui.stamp++;
    ctx.render();
  },
});

