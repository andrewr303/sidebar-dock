// Widget gallery: a dialog listing every registered widget by category with search. Choosing one adds it to the active
// board in the first free spot (or the empty cell that was double-clicked), scrolls to it and opens its settings when
// it needs setup.
import { html, cx } from '../html.js';
import { icon } from '../icons.js';
import { dialogFrame, emptyState, input, button } from '../components.js';
import { registerActions } from '../runtime.js';
import { registerDialog } from '../overlay.js';
import { CATEGORIES, listWidgets, getWidget, clampSize } from './registry.js';
import * as dashboardStore from '../../lib/dashboard-store.js';
import { findFreeSpot, collides, GRID_COLS } from './grid.js';
import { highlight, openWidgetSettings } from './frame.js';

const DIALOG = 'dashboard.gallery';
const PERMISSION_LABELS = {
  topSites: 'your most visited sites', bookmarks: 'your bookmarks', tabs: 'your open tabs', history: 'your browsing history',
  geolocation: 'your location', notifications: 'notifications', sessions: 'recently closed tabs',
};

/** Plain-language access note for a definition's optional grants, e.g. "Asks for access to api.github.com". */
export function accessNote(def) {
  const host = pattern => {
    const match = /^[a-z*]+:\/\/([^/]+)/i.exec(String(pattern));
    return !match || match[1] === '*' ? 'the websites you choose' : match[1].replace(/^\*\./, '');
  };
  const parts = [...new Set([
    ...(def?.permissions?.permissions || []).map(name => PERMISSION_LABELS[name] || name),
    ...(def?.permissions?.origins || []).map(origin => (origin === '<all_urls>' ? 'the websites you choose' : host(origin))),
  ])];
  if (!parts.length) return '';
  return `Asks for access to ${parts.length > 2 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts.join(' and ')}`;
}

/** Widgets matching a search (title, description, keywords) and category ('all' for every category). */
export function filterWidgets(defs, { query = '', category = 'all' } = {}) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return defs.filter(def => (category === 'all' || def.category === category)
    && words.every(word => [def.title, def.description, def.type, ...(def.keywords || [])].join(' ').toLowerCase().includes(word)));
}

export function openWidgetGallery(ctx, { at = null } = {}) {
  if (ctx.state.dialogs.some(d => d.name === DIALOG)) return;
  ctx.openDialog(DIALOG, { query: '', category: 'all', at });
}

function card(def, board) {
  const size = clampSize(def, def.size);
  const onBoard = board?.widgets.filter(w => w.type === def.type).length || 0;
  const access = accessNote(def);
  return html`<button type="button" class="dash-gallery-card" data-action="dashboard.gallery-add" data-type="${def.type}"
    aria-describedby="gal-desc-${def.type}">
    <span class="dash-gallery-tile" data-category="${def.category}" aria-hidden="true">${icon(def.icon || 'layout-grid', { size: 22 })}</span>
    <span class="dash-gallery-text">
      <span class="dash-gallery-name">${def.title}</span>
      <span class="dash-gallery-desc" id="gal-desc-${def.type}">${def.description || def.preview || ''}</span>
      <span class="dash-gallery-meta">
        <span class="dash-gallery-size" title="Default size in grid cells">${size.w} × ${size.h}</span>
        ${onBoard ? html`<span class="dash-gallery-on">${icon('check', { size: 12 })}${onBoard === 1 ? 'On this board' : `${onBoard} on this board`}</span>` : ''}
        ${access ? html`<span class="dash-gallery-access">${icon('lock', { size: 12 })}${access}</span>` : ''}
      </span>
    </span>
    <span class="dash-gallery-plus" aria-hidden="true">${icon('plus', { size: 16 })}</span>
  </button>`;
}

function renderGallery(ctx, props) {
  const board = dashboardStore.activeBoard();
  const defs = listWidgets().sort((a, b) => CATEGORIES.findIndex(c => c.id === a.category) - CATEGORIES.findIndex(c => c.id === b.category));
  const matches = filterWidgets(defs, props);
  const grouped = props.category === 'all' && !props.query.trim();
  const count = id => (id === 'all' ? defs.length : defs.filter(d => d.category === id).length);
  const nav = [{ id: 'all', label: 'All widgets', icon: 'layout-grid' }, ...CATEGORIES].filter(c => count(c.id));
  const body = html`<div class="dash-gallery" data-key="dash-gallery">
    <nav class="dash-gallery-nav" aria-label="Widget categories">
      ${nav.map(c => html`<button type="button" class="${cx('dash-gallery-cat', props.category === c.id && 'is-active')}" data-action="dashboard.gallery-category"
        data-category="${c.id}" aria-current="${props.category === c.id ? 'true' : 'false'}">${icon(c.icon, { size: 16 })}<span>${c.label}</span><span class="dash-gallery-count">${count(c.id)}</span></button>`)}
    </nav>
    <div class="dash-gallery-main">
      ${input({ id: 'dash-gallery-search', value: props.query, placeholder: 'Search widgets', icon: 'search', label: 'Search widgets', action: 'dashboard.gallery-search',
        autofocus: true, className: 'dash-gallery-search', type: 'search' })}
      <div class="dash-gallery-results" data-key="dash-gallery-results">
        ${!matches.length ? emptyState({ icon: 'search', title: `No widgets match “${props.query.trim()}”`, body: 'Try another word, or browse all widgets.', compact: true,
          actions: button({ label: 'Show all widgets', size: 'sm', action: 'dashboard.gallery-reset' }) })
        : grouped ? CATEGORIES.map(c => {
          const list = matches.filter(d => d.category === c.id);
          return list.length ? html`<section class="dash-gallery-group" aria-labelledby="gal-group-${c.id}">
            <h3 class="dash-gallery-heading" id="gal-group-${c.id}">${c.label}</h3><div class="dash-gallery-grid">${list.map(def => card(def, board))}</div></section>` : '';
        }) : html`<div class="dash-gallery-grid">${matches.map(def => card(def, board))}</div>`}
      </div>
      <p class="sr-only" role="status" aria-live="polite">${props.query.trim() ? `${matches.length} ${matches.length === 1 ? 'widget' : 'widgets'}` : ''}</p>
    </div>
  </div>`;
  return dialogFrame({ name: DIALOG, title: 'Add a widget', subtitle: board ? `Adds to ${board.name}. You can move and resize it afterwards.` : '', body });
}

/** Where a new widget goes: the requested cell when the widget fits there, else the first free spot. */
export function placementFor(widgets, size, at) {
  if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
    const x = Math.max(0, Math.min(GRID_COLS - size.w, at.x));
    const rect = { id: '\u0000new', x, y: Math.max(0, at.y), w: size.w, h: size.h };
    if (!widgets.some(w => collides(w, rect))) return { x: rect.x, y: rect.y };
  }
  return findFreeSpot(widgets, size.w, size.h, GRID_COLS);
}

async function addFromGallery(ctx, type) {
  const def = getWidget(type);
  const board = dashboardStore.activeBoard();
  if (!def || !board) return;
  const props = ctx.state.dialogs.find(d => d.name === DIALOG)?.props || {};
  const size = clampSize(def, def.size);
  let config = {};
  try { config = def.defaults?.() || {}; } catch (error) { console.error(error); }
  const spot = placementFor(board.widgets, size, props.at);
  const widget = await dashboardStore.addWidget(board.id, { type, ...size, ...spot, config });
  ctx.closeDialog(DIALOG);
  highlight(ctx, widget.id);
  let setup = false;
  try { setup = !!def.needsSetup?.(config); } catch (error) { console.error(error); }
  if (setup) ctx.nextFrame(() => openWidgetSettings(ctx, widget.id));
  else ctx.toast(`Added ${def.title}`, { action: { label: 'Undo', run: () => dashboardStore.removeWidget(widget.id) } });
}

registerDialog(DIALOG, renderGallery, { size: 'xl', className: 'dash-gallery-dialog' });

registerActions({
  'dashboard.add-widget': ({ ctx, data, event }) => {
    const at = event?.type === 'keydown' ? null : data?.x != null ? { x: Number(data.x), y: Number(data.y) } : null;
    // From the command palette or another view: show the dashboard the widget will land on first.
    if (ctx.state.view !== 'dashboard') ctx.navigate('dashboard');
    openWidgetGallery(ctx, { at });
  },
  'dashboard.gallery-search': ({ ctx, el }) => ctx.updateDialog(DIALOG, { query: el.value }),
  'dashboard.gallery-category': ({ ctx, data }) => ctx.updateDialog(DIALOG, { category: data.category }),
  'dashboard.gallery-reset': ({ ctx }) => {
    ctx.updateDialog(DIALOG, { query: '', category: 'all' });
    ctx.nextFrame(() => { const el = document.getElementById('dash-gallery-search'); if (el) { el.value = ''; el.focus(); } });
  },
  'dashboard.gallery-add': ({ ctx, data }) => addFromGallery(ctx, data.type),
});
