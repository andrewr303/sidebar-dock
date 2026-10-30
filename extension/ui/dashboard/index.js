// Dashboard view (minimal scaffold: header, static grid and widget frames). The dashboard core module replaces this
// with editing, drag and resize, the widget gallery and widget settings while keeping these exports.
import { html, cx } from '../html.js';
import { icon } from '../icons.js';
import { registerActions } from '../runtime.js';
import { getWidget, widgetEnv } from './registry.js';
import '../widgets/index.js';
import * as dashboardStore from '../../lib/dashboard-store.js';
import { loadWidgetCache } from '../../lib/widget-cache.js';

let ready = false;

/** Main-area renderer for the 'dashboard' view. */
export function renderDashboard(ctx) {
  const state = dashboardStore.getDashboard();
  if (!ready || !state) return html`<div class="dashboard is-loading" data-key="dashboard" aria-busy="true"></div>`;
  const board = dashboardStore.activeBoard();
  return html`<div class="dashboard" data-key="dashboard" data-board="${board.id}">
    <header class="dash-header"><h1 class="dash-title">${board.name}</h1></header>
    <div class="dash-grid" style="--cols:12">
      ${board.widgets.map(widget => renderFrame(ctx, board, widget))}
    </div>
  </div>`;
}

function renderFrame(ctx, board, widget) {
  const def = getWidget(widget.type);
  const env = widgetEnv({ widget, board, newtab: !!ctx.env.isNewtab, update: patch => dashboardStore.updateWidgetConfig(widget.id, patch) });
  const title = widget.title || def?.title || 'Widget';
  let body;
  try { body = def ? def.render(ctx, widget, env) : html`<p class="widget-placeholder">This widget is not available.</p>`; }
  catch (error) { console.error(error); body = html`<p class="widget-placeholder">This widget could not be shown.</p>`; }
  const bare = def?.frame === 'bare';
  return html`<section class="${cx('widget', bare && 'is-bare')}" data-key="widget-${widget.id}" data-widget-id="${widget.id}" data-type="${widget.type}"
    data-size="${env.size}" style="grid-column:${widget.x + 1} / span ${widget.w};grid-row:${widget.y + 1} / span ${widget.h}" aria-label="${title}">
    ${bare || widget.style?.hideTitle ? '' : html`<header class="widget-head">${icon(def?.icon || 'layout-grid', { size: 14 })}<h2 class="widget-title">${title}</h2>
      <span class="widget-head-actions">${def?.headerActions ? def.headerActions(ctx, widget, env) : ''}</span></header>`}
    <div class="widget-body">${body}</div>
  </section>`;
}

export async function init(ctx) {
  await Promise.all([dashboardStore.loadDashboard(), loadWidgetCache()]);
  dashboardStore.subscribeDashboard(() => ctx.render());
  ready = true;
  ctx.render();
}

registerActions({
  'dashboard.noop': () => {},
});
