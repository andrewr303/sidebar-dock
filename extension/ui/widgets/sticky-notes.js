// Sticky notes widget: the dashboard's handle on its floating sticky notes. One row or a small tile offers "New sticky
// note" (on this board) and one switch that shows or hides every floating note; larger sizes add a mini board of this
// board's notes (select one to bring it forward and edit it) and a way to the Sticky notes view. The notes themselves
// are library notes (ui/stickies.js); the widget stores only the color it gives new notes.
import { html, cx, plural } from '../html.js';
import { icon } from '../icons.js';
import { registerActions } from '../runtime.js';
import { defineWidget } from '../dashboard/registry.js';
import { findWidget } from '../../lib/dashboard-store.js';
import { button, field } from '../components.js';
import {
  STICKY_COLORS, STICKY_COLOR_LABELS, boardStickyNotes, stickiesShown, setStickiesShown, createSticky, revealSticky, stickyName, stickyPlainText,
} from '../stickies.js';

const defaults = () => ({ color: 'yellow' });
const configOf = widget => {
  const config = { ...defaults(), ...(widget?.config || {}) };
  if (!STICKY_COLORS.includes(config.color)) config.color = 'yellow';
  return config;
};

/** Layout for a size: one row, a small tile, or the tile with a mini board of notes. */
export function stickyWidgetLayout(w, h) {
  if (h <= 1) return 'bar';
  if (h <= 2) return 'tile';
  return w <= 2 ? 'tile' : 'board';
}

/** "3 on this board · 1 hidden", "Hidden on the dashboard", "None on this board yet". */
export function stickySummary({ shown = 0, hidden = 0, layerOn = true } = {}) {
  if (!shown && !hidden) return 'None on this board yet';
  if (!layerOn) return `${plural(shown + hidden, 'note')}, hidden on the dashboard`;
  const parts = [shown ? `${plural(shown, 'note')} on this board` : 'None showing'];
  if (hidden) parts.push(`${hidden.toLocaleString()} hidden`);
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ rendering */

function eyeToggle(widget, on, className) {
  // The label names the ON state and stays the same; aria-pressed says whether it is on. Both icons cross-fade.
  return html`<button type="button" class="${cx('w-sticky-notes-btn', 'is-eye', className)}" data-action="w.sticky-notes.toggle" data-widget="${widget.id}"
    aria-pressed="${on ? 'true' : 'false'}" aria-label="Show sticky notes on the dashboard" data-tooltip="${on ? 'Hide sticky notes' : 'Show sticky notes'}">
    <span class="w-sticky-notes-eye is-on" aria-hidden="true">${icon('eye', { size: 16 })}</span>
    <span class="w-sticky-notes-eye is-off" aria-hidden="true">${icon('eye-off', { size: 16 })}</span>
  </button>`;
}

function addButton(widget, config, className) {
  return html`<button type="button" class="${cx('w-sticky-notes-btn', 'is-add', className)}" data-action="w.sticky-notes.new" data-widget="${widget.id}"
    aria-label="New sticky note on this board" data-tooltip="New sticky note">${icon('plus', { size: 16 })}</button>`;
}

function miniNote(widget, note) {
  const name = stickyName(note);
  const hidden = note.sticky.hidden;
  return html`<li data-key="mini-${note.id}"><button type="button" class="${cx('w-sticky-notes-note', hidden && 'is-hidden')}" data-color="${note.sticky.color}"
    data-action="w.sticky-notes.focus" data-widget="${widget.id}" data-id="${note.id}" title="${hidden ? `${name} (hidden)` : name}">
    <span class="w-sticky-notes-note-text">${stickyPlainText(note.content, 160) || 'Empty sticky note'}</span>
    ${hidden ? html`<span class="w-sticky-notes-note-badge">${icon('eye-off', { size: 12 })}<span class="sr-only">Hidden</span></span>` : ''}
  </button></li>`;
}

function render(ctx, widget, env) {
  const config = configOf(widget);
  const boardId = env.board?.id || '';
  const notes = boardStickyNotes(ctx, boardId, { includeHidden: true });
  const hidden = notes.filter(note => note.sticky.hidden).length;
  const layerOn = stickiesShown(ctx);
  const summary = stickySummary({ shown: notes.length - hidden, hidden, layerOn });
  const layout = stickyWidgetLayout(env.w, env.h);
  if (layout === 'board') {
    const newest = [...notes].reverse();
    return html`<div class="w-sticky-notes" data-layout="board" data-color="${config.color}" data-widget="${widget.id}">
      <header class="w-sticky-notes-head">
        <span class="w-sticky-notes-glyph" data-color="${config.color}" aria-hidden="true">${icon('sticker', { size: 16 })}</span>
        <div class="w-sticky-notes-text">
          <p class="w-sticky-notes-title" aria-hidden="true">Sticky notes</p>
          <p class="w-sticky-notes-summary">${summary}</p>
        </div>
        <div class="w-sticky-notes-actions">${addButton(widget, config)}${eyeToggle(widget, layerOn)}</div>
      </header>
      ${newest.length ? html`<ul class="w-sticky-notes-grid w-scroll-fade" role="list" aria-label="Sticky notes on this board">${newest.map(note => miniNote(widget, note))}</ul>`
        : html`<div class="w-sticky-notes-empty"><p>Sticky notes you add here float above this board. Drag them by the top bar and resize them from the corner.</p>
          ${button({ label: 'New sticky note', icon: 'plus', size: 'sm', action: 'w.sticky-notes.new', data: { widget: widget.id } })}</div>`}
      <footer class="w-sticky-notes-foot">
        <a class="w-sticky-notes-all" href="index.html?libraryView=stickies" data-action="w.sticky-notes.open-all" data-widget="${widget.id}">Open all sticky notes${icon('arrow-right', { size: 14 })}</a>
      </footer>
    </div>`;
  }
  return html`<div class="w-sticky-notes" data-layout="${layout}" data-color="${config.color}" data-widget="${widget.id}">
    <span class="w-sticky-notes-glyph" data-color="${config.color}" aria-hidden="true">${icon('sticker', { size: layout === 'tile' ? 18 : 16 })}</span>
    <div class="w-sticky-notes-text">
      <p class="w-sticky-notes-title" aria-hidden="true">Sticky notes</p>
      <p class="w-sticky-notes-summary">${summary}</p>
    </div>
    <div class="w-sticky-notes-actions">${addButton(widget, config)}${eyeToggle(widget, layerOn)}</div>
  </div>`;
}

/* ------------------------------------------------------------------ settings */

function renderSettings(ctx, widget, draft) {
  const current = STICKY_COLORS.includes(draft.color) ? draft.color : 'yellow';
  return html`<div class="w-sticky-notes-settings">
    ${field({ label: 'Color for new notes', hint: 'Notes added from this widget start in this color. Change any note’s color from its color dot.',
      control: html`<div class="w-sticky-notes-swatches" role="radiogroup" aria-label="Color for new notes">${STICKY_COLORS.map(color => html`<button type="button" role="radio"
        class="w-sticky-notes-swatch" aria-checked="${color === current ? 'true' : 'false'}" tabindex="${color === current ? '0' : '-1'}"
        data-action="dashboard.draft-set" data-name="color" data-value="${color}" aria-label="${STICKY_COLOR_LABELS[color]}" data-tooltip="${STICKY_COLOR_LABELS[color]}">
        <span class="sticky-swatch" data-color="${color}" aria-hidden="true"></span>${icon('check', { size: 14, className: 'w-sticky-notes-swatch-check' })}</button>`)}</div>` })}
  </div>`;
}

/* ------------------------------------------------------------------ menu and actions */

function menu(ctx, widget, env) {
  const on = stickiesShown(ctx);
  return [
    { label: 'New sticky note', icon: 'plus', run: () => newOnBoard(ctx, widget.id) },
    { label: 'Show sticky notes', checked: on, run: () => setStickiesShown(ctx, !on) },
    { label: 'Open all sticky notes', icon: 'sticker', run: () => ctx.navigate('stickies') },
  ];
}

function newOnBoard(ctx, widgetId) {
  const found = findWidget(widgetId);
  return createSticky(ctx, { boardId: found?.board.id || '', color: configOf(found?.widget).color });
}

registerActions({
  'w.sticky-notes.new': ({ ctx, data }) => newOnBoard(ctx, data.widget),
  'w.sticky-notes.toggle': ({ ctx }) => setStickiesShown(ctx, !stickiesShown(ctx)),
  'w.sticky-notes.focus': ({ ctx, data }) => revealSticky(ctx, data.id),
  // A real link (Ctrl/⌘-click and middle-click open a tab); a plain click switches views in place.
  'w.sticky-notes.open-all': ({ ctx, event }) => {
    if (event?.metaKey || event?.ctrlKey || event?.shiftKey || event?.altKey) return;
    event?.preventDefault();
    ctx.navigate('stickies');
  },
});

defineWidget({
  type: 'sticky-notes',
  title: 'Sticky notes',
  description: 'Add sticky notes to this board and show or hide them all at once.',
  icon: 'sticker',
  category: 'library',
  keywords: ['sticky', 'stickies', 'post-it', 'memo', 'jot', 'notes', 'floating', 'reminder'],
  size: { w: 3, h: 2, minW: 2, minH: 1, maxW: 8, maxH: 8 },
  presets: { S: { w: 3, h: 1 }, M: { w: 3, h: 2 }, L: { w: 4, h: 4 }, XL: { w: 6, h: 5 } },
  frame: 'bare',
  defaults,
  displayTitle: () => 'Sticky notes',
  render,
  menu,
  renderSettings,
  preview: 'New note · Show or hide',
});
