// Kanban board widget: columns of cards with labels, priority, due dates, checklists and links to library items.
// Medium and larger sizes show the board (columns scroll sideways; large sizes add a search and label filter); small
// sizes show a summary of column counts and the cards to look at next. Cards move by dragging, with ] and [ (next or
// previous column), Alt with the arrow keys, or the card menu. The board lives in widget.config (kanban/model.js).
import { html, cx, plural } from '../html.js';
import { icon, registerIcons } from '../icons.js';
import { registerActions, registerMount } from '../runtime.js';
import { defineWidget, sizeBucket } from '../dashboard/registry.js';
import { findWidget } from '../../lib/dashboard-store.js';
import { button, iconButton, emptyState, select, siteIcon, colorVar, TYPE_ICONS } from '../components.js';
import * as M from './kanban/model.js';
import { boardFor, boardById, save, ui, ids, announce, focusAfterRender, cardIn } from './kanban/store.js';
import { dragFor } from './kanban/drag.js';
import { openCardDialog } from './kanban/card-dialog.js';
import { LAYOUT_OPTIONS, renderSettings, validateSettings, onSettingsSave } from './kanban/settings.js';

// Lucide glyphs (ISC) this widget uses that ui/icons.js does not inline, plus color dots for the column color menu
// (a filled dot per palette color; the chosen one carries a check so the choice never rests on color alone).
registerIcons({
  eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  'kanban-color-none': '<circle cx="12" cy="12" r="6.5" stroke-dasharray="2.6 2.4"/>',
  'kanban-color-none-on': '<circle cx="12" cy="12" r="8" stroke-dasharray="2.6 2.4"/><path d="m8.6 12.2 2.3 2.3 4.6-4.8"/>',
  ...Object.fromEntries(M.COLORS.flatMap(color => [
    [`kanban-color-${color}`, `<circle cx="12" cy="12" r="6.5" style="fill:var(--c-${color});stroke:none"/>`],
    [`kanban-color-${color}-on`, `<circle cx="12" cy="12" r="9" style="fill:var(--c-${color});stroke:none"/><path d="m8.4 12.2 2.4 2.4 4.8-5" style="stroke:var(--fg-on-tile)" stroke-width="2.4"/>`],
  ])),
});

const COLUMN_COLORS = [{ value: '', label: 'No color' }, ...M.COLORS.map(value => ({ value, label: M.COLOR_LABELS[value] }))];
const MAX_LABELS_SHOWN = 3;

const configOf = widget => boardFor(widget);
// Automatic: the full board from 5 × 4 cells; smaller sizes show the summary (counts, cards due next, quick add).
const layoutOf = (board, env) => M.layoutFor(board, { w: env.w ?? 6, h: env.h ?? 4 });
const liveFilter = (widgetId, board) => (ui.query.has(widgetId) ? { ...board.filter, query: ui.query.get(widgetId) } : board.filter);
const filterShown = (widgetId, board, env) => M.isFiltered(liveFilter(widgetId, board)) || (ui.filterBar.get(widgetId) ?? (env.size === 'l' || env.size === 'xl'));
const tint = color => (color ? `--tint:${colorVar(color)}` : '');
// The frame passes env to render; actions only know the widget, so they recompute its size bucket the same way.
const sizeOf = widget => ({ size: sizeBucket(widget.w, widget.h), w: widget.w, h: widget.h });

/* ------------------------------------------------------------------ small pieces */

/** Priority glyph: one to three bars for low, medium and high, a filled square with "!" for urgent (shape, not only color). */
export function priorityGlyph(priority, { size = 14 } = {}) {
  if (!priority || priority === 'none') return '';
  if (priority === 'urgent') {
    return html`<svg class="w-kanban-prio" data-priority="urgent" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="14" height="14" rx="3.5" class="w-kanban-prio-fill"/><rect x="7" y="3.6" width="2" height="5.6" rx="1" class="w-kanban-prio-knock"/><rect x="7" y="10.6" width="2" height="2" rx="1" class="w-kanban-prio-knock"/></svg>`;
  }
  const level = M.priorityOf(priority).rank;
  return html`<svg class="w-kanban-prio" data-priority="${priority}" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    ${[[1.5, 9.5, 4.5], [6.5, 6, 8], [11.5, 2.5, 11.5]].map(([x, y, h], i) => html`<rect x="${x}" y="${y}" width="3" height="${h}" rx="1" class="${cx('w-kanban-prio-bar', i < level && 'is-on')}"/>`)}</svg>`;
}

function dueBadge(card, done) {
  if (!card.due) return '';
  const info = M.dueInfo(card.due);
  const label = M.dueLabel(card.due);
  const state = done ? 'done' : info.state;
  const glyph = state === 'overdue' ? 'alarm-clock' : state === 'done' ? 'calendar-check' : state === 'today' || state === 'tomorrow' ? 'calendar-clock' : 'calendar';
  const spoken = state === 'overdue' ? `Overdue, was due ${label}` : `Due ${label}`;
  return html`<span class="w-kanban-due" data-state="${state}" title="${spoken}">${icon(glyph, { size: 12 })}<span aria-hidden="true">${label}</span><span class="sr-only">${spoken}</span></span>`;
}

function labelChips(board, card, labels) {
  const chips = card.labels.map(id => labels.get(id)).filter(Boolean);
  if (!chips.length) return '';
  const shown = chips.slice(0, MAX_LABELS_SHOWN);
  const more = chips.length - shown.length;
  return html`<span class="w-kanban-labels"><span class="sr-only">Labels: ${chips.map(l => l.name).join(', ')}.</span>
    ${shown.map(label => html`<span class="w-kanban-label" style="--label:${colorVar(label.color)}" aria-hidden="true" title="${label.name}"><span class="w-kanban-label-dot"></span><span class="w-kanban-label-name" dir="auto">${label.name}</span></span>`)}
    ${more ? html`<span class="w-kanban-label is-more" aria-hidden="true" title="${chips.slice(MAX_LABELS_SHOWN).map(l => l.name).join(', ')}">+${more}</span>` : ''}</span>`;
}

function linkedBadge(ctx, card) {
  if (!card.itemId) return '';
  const item = ctx.select.byId(card.itemId);
  if (!item || item.deletedAt) return html`<span class="w-kanban-meta-icon is-missing" title="The linked item is no longer in your library">${icon('unlink', { size: 12 })}<span class="sr-only">The linked item is no longer in your library.</span></span>`;
  const title = item.title || item.url || 'Untitled';
  return html`<span class="w-kanban-meta-icon is-link" title="Linked to ${title}">${item.url && item.type !== 'note' ? siteIcon(item.url, { size: 12 }) : icon(TYPE_ICONS[item.type] || 'link-2', { size: 12 })}<span class="sr-only">Linked to ${title}.</span></span>`;
}

function cardMeta(ctx, board, card, done) {
  const progress = M.checklistProgress(card);
  const priority = M.priorityOf(card.priority);
  const parts = [
    card.priority !== 'none' ? html`<span class="w-kanban-meta-prio" title="${priority.label} priority">${priorityGlyph(card.priority, { size: 12 })}<span class="sr-only">${priority.label} priority.</span></span>` : '',
    dueBadge(card, done),
    progress.total ? html`<span class="${cx('w-kanban-meta-check', progress.done === progress.total && 'is-complete')}" title="${progress.done} of ${progress.total} checklist items done">
      ${icon(progress.done === progress.total ? 'circle-check' : 'list-checks', { size: 12 })}<span aria-hidden="true">${progress.done}/${progress.total}</span><span class="sr-only">${progress.done} of ${progress.total} checklist items done.</span></span>` : '',
    card.description.trim() && !board.showDescriptions ? html`<span class="w-kanban-meta-icon" title="Has a description">${icon('text', { size: 12 })}<span class="sr-only">Has a description.</span></span>` : '',
    linkedBadge(ctx, card),
  ].filter(part => part !== '');
  return parts.length ? html`<span class="w-kanban-meta">${parts}</span>` : '';
}

/* ------------------------------------------------------------------ board */

function renderCard(ctx, widget, board, card, { labels, done, tabbable, source }) {
  const metaId = `${ids.card(widget.id, card.id)}-meta`;
  const description = board.showDescriptions && card.description.trim() ? card.description.trim() : '';
  return html`<li class="${cx('w-kanban-card', done && 'is-done', source && 'is-drag-source', card.priority === 'urgent' && !done && 'is-urgent')}" data-key="${card.id}" data-card="${card.id}">
    <button type="button" class="w-kanban-card-open" id="${ids.card(widget.id, card.id)}" tabindex="${tabbable ? '0' : '-1'}"
      data-action="w.kanban.card-open" data-keydown="w.kanban.card-key" data-widget="${widget.id}" data-card="${card.id}"
      aria-describedby="${metaId} wk-${widget.id}-help" aria-keyshortcuts="] [ Alt+ArrowUp Alt+ArrowDown Shift+F10 Delete"><span class="w-kanban-card-title" dir="auto">${card.title}</span></button>
    <span class="w-kanban-card-details" id="${metaId}">
      ${description ? html`<span class="w-kanban-card-desc" dir="auto">${description}</span>` : ''}
      ${labelChips(board, card, labels)}
      ${cardMeta(ctx, board, card, done)}
    </span>
    <button type="button" class="icon-btn icon-btn-sm w-kanban-card-menu" tabindex="-1" aria-label="Options for “${card.title}”" title="Card options"
      aria-haspopup="true" data-action="w.kanban.card-menu" data-widget="${widget.id}" data-card="${card.id}">${icon('ellipsis', { size: 14 })}</button>
  </li>`;
}

function columnCount(column, count, shown) {
  const wip = M.wipState(column, count);
  const spoken = `${plural(count, 'card')}${shown !== count ? `, ${shown} shown` : ''}${column.limit ? `, limit ${column.limit}${wip === 'over' ? ', over the limit' : ''}` : ''}`;
  return html`<span class="w-kanban-col-count" data-wip="${wip}" title="${column.limit ? `Work-in-progress limit: ${column.limit}` : ''}">
    ${wip === 'over' ? icon('triangle-alert', { size: 12 }) : ''}<span aria-hidden="true">${shown !== count ? `${shown}/${count}` : count}${column.limit ? html`<span class="w-kanban-col-limit"> / ${column.limit}</span>` : ''}</span><span class="sr-only">${spoken}</span></span>`;
}

function composerForm(widget, column) {
  const draft = ui.composer.get(widget.id);
  return html`<form class="w-kanban-composer" data-submit="w.kanban.composer-add" data-widget="${widget.id}" data-column="${column.id}" autocomplete="off" data-key="composer">
    <label class="sr-only" for="${ids.composer(widget.id)}">New card in ${column.title}</label>
    <textarea class="w-kanban-composer-input" id="${ids.composer(widget.id)}" name="title" rows="2" maxlength="${M.LIMITS.title}" placeholder="Card title"
      data-mount="w.kanban.composer" data-key="composer-input" data-input="w.kanban.composer-input" data-widget="${widget.id}" data-column="${column.id}"
      enterkeyhint="done" spellcheck="true" dir="auto">${draft?.text || ''}</textarea>
    <div class="w-kanban-composer-actions">
      ${button({ label: 'Add card', type: 'submit', variant: 'primary', size: 'sm' })}
      ${iconButton({ icon: 'x', label: 'Close', size: 'sm', action: 'w.kanban.composer-close', data: { widget: widget.id, column: column.id } })}
    </div>
  </form>`;
}

function renderColumn(ctx, widget, board, column, { visible, labels, drag, rovingId, filtered }) {
  const all = M.columnCards(board, column.id);
  const shown = all.filter(card => visible.has(card.id));
  const done = column.done;
  const composing = ui.composer.get(widget.id)?.columnId === column.id;
  const target = drag?.kind === 'card' && drag.target?.columnId === column.id ? drag.target : null;
  const placeholder = html`<li class="w-kanban-placeholder" data-key="placeholder" aria-hidden="true" style="block-size:${drag?.height || 40}px"></li>`;
  const items = [];
  for (const card of shown) {
    if (target && target.beforeId === card.id) items.push(placeholder);
    items.push(renderCard(ctx, widget, board, card, { labels, done, tabbable: card.id === rovingId, source: drag?.kind === 'card' && drag.id === card.id }));
  }
  if (target && !shown.some(card => card.id === target.beforeId)) items.push(placeholder);
  const titleId = ids.columnTitle(widget.id, column.id);
  const hasCards = shown.some(card => !(drag?.kind === 'card' && drag.id === card.id)) || !!target;
  const isSource = drag?.kind === 'column' && drag.id === column.id;
  return html`<li class="${cx('w-kanban-col', done && 'is-done', column.color && 'has-color', isSource && 'is-drag-source', M.wipState(column, all.length) === 'over' && 'is-over')}"
    data-key="col-${column.id}" data-column="${column.id}" id="${ids.column(widget.id, column.id)}" style="${tint(column.color)}">
    <div class="w-kanban-col-head" title="Drag to reorder columns">
      <span class="${cx('w-kanban-col-dot', done && 'is-done')}" aria-hidden="true">${done ? icon('check', { size: 10, strokeWidth: 3 }) : ''}</span>
      <h3 class="w-kanban-col-title" id="${titleId}" dir="auto" title="${column.title}">${column.title}</h3>
      ${columnCount(column, all.length, filtered ? shown.length : all.length)}
      <button type="button" class="icon-btn icon-btn-sm w-kanban-col-menu" id="${ids.columnMenu(widget.id, column.id)}" aria-label="${column.title} column options"
        data-tooltip="Column options" data-tooltip-pos="bottom end" aria-haspopup="true" aria-expanded="false" data-action="w.kanban.column-menu" data-widget="${widget.id}" data-column="${column.id}">${icon('ellipsis', { size: 14 })}</button>
    </div>
    <ol class="w-kanban-list w-kanban-fade-y" aria-labelledby="${titleId}" data-column="${column.id}">${items}</ol>
    ${hasCards ? '' : html`<p class="w-kanban-col-empty" data-key="empty">${filtered && all.length ? 'No matching cards' : done ? 'Finished cards land here' : 'No cards yet'}</p>`}
    <div class="w-kanban-col-foot" data-key="foot">
      ${composing ? composerForm(widget, column)
        : html`<button type="button" class="w-kanban-add" id="${ids.addCard(widget.id, column.id)}" data-action="w.kanban.composer-open" data-widget="${widget.id}" data-column="${column.id}"
          ${board.cards.length >= M.LIMITS.cards ? html`disabled` : ''}>${icon('plus', { size: 14 })}<span>Add card</span><span class="sr-only"> to ${column.title}</span></button>`}
    </div>
  </li>`;
}

function addColumnTile(widget, board) {
  if (board.columns.length >= M.LIMITS.columns) return '';
  const draft = ui.addColumn.get(widget.id);
  if (draft == null) {
    return html`<li class="w-kanban-col-add" data-key="add-col">
      <button type="button" class="w-kanban-col-add-btn" id="${ids.addColumn(widget.id)}" data-action="w.kanban.add-column-open" data-widget="${widget.id}"
        aria-label="Add column" data-tooltip="Add column" data-tooltip-pos="bottom end">${icon('plus', { size: 16 })}</button></li>`;
  }
  return html`<li class="w-kanban-col-add is-open" data-key="add-col">
    <form class="w-kanban-col-form" data-submit="w.kanban.add-column" data-widget="${widget.id}" autocomplete="off">
      <label class="field-label" for="${ids.addColumnInput(widget.id)}">New column</label>
      <input class="input input-sm" id="${ids.addColumnInput(widget.id)}" name="title" value="${draft}" maxlength="${M.LIMITS.column}" placeholder="Column name"
        data-input="w.kanban.add-column-input" data-keydown="w.kanban.add-column-key" data-widget="${widget.id}" data-autofocus>
      <div class="w-kanban-composer-actions">
        ${button({ label: 'Add column', type: 'submit', variant: 'primary', size: 'sm' })}
        ${iconButton({ icon: 'x', label: 'Cancel', size: 'sm', action: 'w.kanban.add-column-close', data: { widget: widget.id } })}
      </div>
    </form></li>`;
}

function filterBar(widget, board, visibleCount) {
  const filter = liveFilter(widget.id, board);
  const filtered = M.isFiltered(filter);
  return html`<div class="w-kanban-filter" role="search" aria-label="Filter cards" data-key="filter">
    <span class="w-kanban-search">${icon('search', { size: 14, className: 'w-kanban-search-icon' })}
      <input class="input input-sm" type="search" id="${ids.search(widget.id)}" value="${filter.query}" placeholder="Search cards" aria-label="Search cards"
        data-input="w.kanban.query" data-keydown="w.kanban.query-key" data-widget="${widget.id}" autocomplete="off" spellcheck="false"></span>
    ${board.labels.length ? select({ value: filter.label, label: 'Show cards with label', size: 'sm', action: 'w.kanban.filter-label', className: 'w-kanban-filter-label',
      options: [{ value: '', label: 'All labels' }, ...board.labels.map(l => ({ value: l.id, label: l.name }))] }) : ''}
    ${filtered ? html`<span class="w-kanban-filter-count" aria-hidden="true">${visibleCount} of ${board.cards.length}</span>
      ${button({ label: 'Clear', icon: 'filter-x', size: 'sm', variant: 'ghost', action: 'w.kanban.filter-clear', data: { widget: widget.id }, className: 'w-kanban-filter-clear' })}` : ''}
  </div>`;
}

function renderBoard(ctx, widget, board, env) {
  const filter = liveFilter(widget.id, board);
  const filtered = M.isFiltered(filter);
  const visibleCards = M.filterCards(board, board.cards, filter);
  const visible = new Set(visibleCards.map(card => card.id));
  const labels = M.labelMap(board);
  const drag = dragFor(widget.id);
  const ordered = board.columns.flatMap(column => visibleCards.filter(card => card.columnId === column.id));
  const rovingId = ordered.some(card => card.id === ui.roving.get(widget.id)) ? ui.roving.get(widget.id) : ordered[0]?.id;
  const columnTarget = drag?.kind === 'column' ? drag.target : null;
  const columns = [];
  for (const column of board.columns) {
    if (columnTarget && columnTarget.beforeId === column.id) columns.push(html`<li class="w-kanban-col-placeholder" data-key="col-placeholder" aria-hidden="true" style="inline-size:${drag.width}px"></li>`);
    columns.push(renderColumn(ctx, widget, board, column, { visible, labels, drag, rovingId, filtered }));
  }
  if (columnTarget && !columnTarget.beforeId) columns.push(html`<li class="w-kanban-col-placeholder" data-key="col-placeholder" aria-hidden="true" style="inline-size:${drag.width}px"></li>`);
  const showFilter = filterShown(widget.id, board, env);
  return html`<div class="${cx('w-kanban', drag && 'is-dragging')}" data-layout="board" data-widget="${widget.id}" data-mount="w.kanban.board" data-key="kanban-board">
    ${showFilter ? filterBar(widget, board, visibleCards.length) : ''}
    <div class="w-kanban-strip-wrap" data-key="strip-wrap">
      <ol class="w-kanban-strip" aria-label="Columns" data-key="strip" data-mount="w.kanban.strip">${columns}${addColumnTile(widget, board)}</ol>
      <button type="button" class="w-kanban-edge is-start" tabindex="-1" aria-label="Show earlier columns" data-action="w.kanban.scroll" data-dir="-1" data-key="edge-start">${icon('chevron-left', { size: 16 })}</button>
      <button type="button" class="w-kanban-edge is-end" tabindex="-1" aria-label="Show later columns" data-action="w.kanban.scroll" data-dir="1" data-key="edge-end">${icon('chevron-right', { size: 16 })}</button>
    </div>
    <p class="sr-only" id="wk-${widget.id}-help">Enter opens the card. ] moves it to the next column and [ to the previous one. Alt with the up or down arrow changes its place. Shift+F10 shows more options.</p>
    <p class="sr-only" role="status" aria-live="polite" data-key="announce">${ui.announce.get(widget.id) || ''}</p>
  </div>`;
}

/* ------------------------------------------------------------------ summary (small sizes) */

function renderSummary(ctx, widget, board, env) {
  const stats = M.columnStats(board);
  const doneCount = stats.filter(s => s.column.done).reduce((n, s) => n + s.count, 0);
  const open = board.cards.length - doneCount;
  const next = M.upNext(board, { limit: env.h >= 4 ? 5 : 3 });
  const first = board.columns.find(c => !c.done) || board.columns[0];
  const total = board.cards.length;
  return html`<div class="w-kanban is-summary" data-layout="summary" data-widget="${widget.id}" data-key="kanban-summary">
    <div class="w-kanban-sum-top">
      ${total ? html`<p class="w-kanban-sum-total"><span class="w-kanban-sum-num">${open.toLocaleString()}</span> open<span class="w-kanban-sum-done"><span class="w-kanban-sum-sep" aria-hidden="true">·</span>${doneCount.toLocaleString()} done</span></p>`
        : html`<p class="w-kanban-sum-total is-empty">${icon('square-kanban', { size: 16 })}No cards yet</p>`}
      ${total ? html`<span class="w-kanban-sum-bar" role="img" aria-label="${stats.map(s => `${s.column.title}: ${s.count}`).join(', ')}" title="${stats.map(s => `${s.column.title}: ${s.count}`).join(' · ')}">
        ${stats.filter(s => s.count).map(s => html`<span class="w-kanban-sum-seg" style="flex-grow:${s.count};${tint(s.column.color || (s.column.done ? 'green' : 'gray'))}"></span>`)}</span>` : ''}
    </div>
    <div class="w-kanban-sum-scroll w-kanban-fade-y">
      ${total ? html`<ul class="w-kanban-sum-cols" role="list">${stats.map(s => html`<li class="${cx('w-kanban-sum-col', s.wip === 'over' && 'is-over')}" style="${tint(s.column.color)}">
        <span class="${cx('w-kanban-col-dot', s.column.done && 'is-done')}" aria-hidden="true">${s.column.done ? icon('check', { size: 10, strokeWidth: 3 }) : ''}</span>
        <span class="w-kanban-sum-col-name" dir="auto">${s.column.title}</span>${columnCount(s.column, s.count, s.count)}</li>`)}</ul>` : ''}
      ${next.length ? html`<section class="w-kanban-sum-next" aria-labelledby="wk-${widget.id}-next">
        <h3 class="w-kanban-sum-heading" id="wk-${widget.id}-next">Up next</h3>
        <ul class="w-kanban-sum-list" role="list">${next.map(card => html`<li data-key="${card.id}">
          <button type="button" class="w-kanban-sum-card" id="${ids.summaryCard(widget.id, card.id)}" data-action="w.kanban.card-open" data-widget="${widget.id}" data-card="${card.id}">
            <span class="w-kanban-sum-prio">${priorityGlyph(card.priority, { size: 12 })}<span class="sr-only">${card.priority !== 'none' ? `${M.priorityOf(card.priority).label} priority. ` : ''}</span></span>
            <span class="w-kanban-sum-card-title" dir="auto" title="${card.title}">${card.title}</span>${dueBadge(card, false)}</button></li>`)}</ul>
      </section>` : total ? html`<p class="w-kanban-sum-empty">${open ? 'Nothing is due. Add due dates or priorities to see cards here.' : 'Everything on this board is done.'}</p>`
        : html`<p class="w-kanban-sum-empty">Add your first card below. Make the widget larger to see the whole board.</p>`}
    </div>
    <form class="w-kanban-quick" data-submit="w.kanban.quick-add" data-widget="${widget.id}" data-column="${first.id}" autocomplete="off">
      ${icon('plus', { size: 14, className: 'w-kanban-quick-icon' })}
      <label class="sr-only" for="${ids.quick(widget.id)}">New card in ${first.title}</label>
      <input class="w-kanban-quick-input" id="${ids.quick(widget.id)}" name="title" maxlength="${M.LIMITS.title}" placeholder="Add a card" enterkeyhint="done" spellcheck="true" dir="auto">
    </form>
    <p class="sr-only" role="status" aria-live="polite" data-key="announce">${ui.announce.get(widget.id) || ''}</p>
  </div>`;
}

function render(ctx, widget, env) {
  const board = configOf(widget);
  return layoutOf(board, env) === 'summary' ? renderSummary(ctx, widget, board, env) : renderBoard(ctx, widget, board, env);
}

/* ------------------------------------------------------------------ frame header, menu and settings */

function headerActions(ctx, widget, env) {
  const board = configOf(widget);
  const summary = layoutOf(board, env) === 'summary';
  const shown = !summary && filterShown(widget.id, board, env);
  return html`${summary ? '' : iconButton({ icon: 'list-filter', label: shown ? 'Hide the filter bar' : 'Filter cards', size: 'sm', pressed: shown, action: 'w.kanban.filter-toggle',
      data: { widget: widget.id }, tooltipPlacement: 'bottom' })}
    ${iconButton({ icon: 'plus', label: 'New card', size: 'sm', action: 'w.kanban.new-card', data: { widget: widget.id }, tooltipPlacement: 'bottom' })}`;
}

function menu(ctx, widget, env) {
  const board = configOf(widget);
  const summary = layoutOf(board, env) === 'summary';
  const items = [
    { label: 'New card', icon: 'plus', run: () => newCard(ctx, widget.id, env) },
    { label: 'New column', icon: 'columns-3', disabled: board.columns.length >= M.LIMITS.columns, run: () => newColumn(ctx, widget.id, env) },
    { separator: true },
    { heading: 'Layout' },
    ...LAYOUT_OPTIONS.map(option => ({ label: option.label, checked: board.layout === option.value,
      run: () => ctx.run(() => save(ctx, widget.id, b => ({ ...b, layout: option.value }))) })),
    { separator: true },
    { label: 'Show descriptions on cards', checked: board.showDescriptions, run: () => ctx.run(() => save(ctx, widget.id, b => ({ ...b, showDescriptions: !b.showDescriptions }))) },
  ];
  if (M.isFiltered(liveFilter(widget.id, board))) items.push({ label: 'Clear filters', icon: 'filter-x', run: () => clearFilters(ctx, widget.id) });
  else if (!summary) items.push({ label: 'Filter cards', icon: 'list-filter', run: () => toggleFilter(ctx, widget.id, env, true) });
  items.push({ label: 'Edit columns and labels…', icon: 'settings-2', run: () => env.openSettings?.() });
  return items;
}

defineWidget({
  type: 'kanban',
  title: 'Kanban board',
  description: 'Move cards across columns, with labels, due dates, checklists and links to your library.',
  icon: 'square-kanban',
  category: 'productivity',
  keywords: ['kanban', 'board', 'tasks', 'todo', 'to-do', 'project', 'cards', 'columns', 'trello', 'workflow'],
  size: { w: 6, h: 4, minW: 2, minH: 2, maxW: 12, maxH: 12 },
  presets: { S: { w: 3, h: 3 }, M: { w: 6, h: 4 }, L: { w: 8, h: 5 }, XL: { w: 12, h: 6 } },
  settingsSize: 'lg',
  defaults: () => M.toConfig(M.defaultBoard(new Date())),
  render,
  headerActions,
  menu,
  renderSettings,
  validateSettings,
  onSettingsSave,
  preview: 'Columns of cards you drag along',
});

/* ------------------------------------------------------------------ commands */

function firstOpenColumn(board) { return board.columns.find(c => !c.done) || board.columns[0]; }

function newCard(ctx, widgetId, env) {
  const widget = findWidget(widgetId)?.widget;
  if (!widget) return;
  const board = boardFor(widget);
  if (env && layoutOf(board, env) === 'summary') { focusAfterRender(ctx, ids.quick(widgetId)); ctx.render(); return; }
  openComposer(ctx, widgetId, firstOpenColumn(board).id);
}

function newColumn(ctx, widgetId, env) {
  const widget = findWidget(widgetId)?.widget;
  if (!widget) return;
  if (env && layoutOf(boardFor(widget), env) === 'summary') { env.openSettings?.(); return; }
  ui.addColumn.set(widgetId, '');
  ctx.render();
  ctx.nextFrame(() => {
    const input = document.getElementById(ids.addColumnInput(widgetId));
    input?.scrollIntoView({ block: 'nearest', inline: 'end' });
    input?.focus({ preventScroll: true });
  });
}

function openComposer(ctx, widgetId, columnId) {
  const open = ui.composer.get(widgetId);
  ui.composer.set(widgetId, { columnId, text: open?.columnId === columnId ? open.text : '' });
  ctx.render();
  ctx.nextFrame(() => {
    const input = document.getElementById(ids.composer(widgetId));
    if (!input) return;
    input.focus({ preventScroll: true });
    input.closest('.w-kanban-col')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    input.closest('.w-kanban-col-foot')?.scrollIntoView({ block: 'nearest' });
  });
}

function closeComposer(ctx, widgetId, { refocus = true } = {}) {
  const open = ui.composer.get(widgetId);
  if (!open) return;
  ui.composer.delete(widgetId);
  ctx.render();
  if (refocus) focusAfterRender(ctx, ids.addCard(widgetId, open.columnId));
}

async function addFromComposer(ctx, widgetId, columnId, input) {
  const title = input.value.replace(/\s+/g, ' ').trim();
  if (!title) { input.focus(); return; }
  const id = M.uid('card');
  input.value = '';
  ui.composer.set(widgetId, { columnId, text: '' });
  let next = null;
  try { next = await save(ctx, widgetId, b => M.addCard(b, columnId, { id, title })); } finally {
    // A card that did not make it onto the board keeps its title in the field so nothing typed is lost.
    if (!next && !cardIn(widgetId, id) && input.isConnected && !input.value) { input.value = title; ui.composer.set(widgetId, { columnId, text: title }); }
  }
  if (!next) return;
  const column = M.findColumn(next, columnId);
  announce(ctx, widgetId, `Added “${title}” to ${column?.title || 'the column'}.`);
  ctx.nextFrame(() => {
    const list = document.getElementById(ids.column(widgetId, columnId))?.querySelector('.w-kanban-list');
    list?.scrollTo({ top: list.scrollHeight });
  });
}

function toggleFilter(ctx, widgetId, env, force) {
  const board = boardById(widgetId);
  if (!board) return;
  const shown = filterShown(widgetId, board, env || { size: 'm' });
  const next = typeof force === 'boolean' ? force : !shown;
  ui.filterBar.set(widgetId, next);
  if (!next && M.isFiltered(liveFilter(widgetId, board))) clearFilters(ctx, widgetId);
  ctx.render();
  if (next) focusAfterRender(ctx, ids.search(widgetId));
}

function clearFilters(ctx, widgetId) {
  ui.query.delete(widgetId);
  clearTimeout(queryTimers.get(widgetId));
  return ctx.run(() => save(ctx, widgetId, M.clearFilter));
}

const queryTimers = new Map();
function persistQuery(ctx, widgetId) {
  clearTimeout(queryTimers.get(widgetId));
  queryTimers.set(widgetId, setTimeout(() => {
    queryTimers.delete(widgetId);
    // The widget may have been removed while the search was typed: nothing to save then (and no error to show).
    if (!ui.query.has(widgetId) || !findWidget(widgetId)) { ui.query.delete(widgetId); return; }
    const query = ui.query.get(widgetId);
    ctx.run(async () => {
      await save(ctx, widgetId, b => M.setFilter(b, { query }));
      if (ui.query.get(widgetId) === query) ui.query.delete(widgetId);
    });
  }, 500));
}

/** Card id order as drawn for one column (filter applied). */
function shownIds(widgetId, board, columnId) {
  const visible = new Set(M.filterCards(board, board.cards, liveFilter(widgetId, board)).map(card => card.id));
  return M.columnCards(board, columnId).filter(card => visible.has(card.id)).map(card => card.id);
}

async function moveBy(ctx, widgetId, cardId, { columns = 0, rows = 0 }) {
  const found = cardIn(widgetId, cardId);
  if (!found) return;
  const { board, card } = found;
  const next = await save(ctx, widgetId, b => (columns ? M.shiftCard(b, cardId, columns) : M.stepCard(b, cardId, rows, shownIds(widgetId, b, card.columnId))));
  ui.roving.set(widgetId, cardId);
  focusAfterRender(ctx, ids.card(widgetId, cardId));
  if (!next) {
    const edge = columns ? (columns < 0 ? 'already in the first column' : 'already in the last column') : rows < 0 ? 'already at the top' : 'already at the bottom';
    announce(ctx, widgetId, `“${card.title}” is ${edge}.`);
    return;
  }
  const moved = M.findCard(next, cardId);
  const column = M.findColumn(next, moved.columnId);
  const order = shownIds(widgetId, next, moved.columnId);
  announce(ctx, widgetId, `${columns ? `Moved to ${column.title}` : 'Moved'}, ${order.indexOf(cardId) + 1} of ${order.length}.`);
  if (columns && !board.columns.some(c => c.id === moved.columnId && c.id === card.columnId)) {
    ctx.nextFrame(() => document.getElementById(ids.column(widgetId, moved.columnId))?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }
}

async function moveToColumn(ctx, widgetId, cardId, columnId, { atStart = false } = {}) {
  const found = cardIn(widgetId, cardId);
  if (!found) return;
  const first = atStart ? M.columnCards(found.board, columnId).find(c => c.id !== cardId)?.id || null : null;
  const next = await save(ctx, widgetId, b => M.moveCard(b, cardId, columnId, first));
  if (next) announce(ctx, widgetId, `Moved “${found.card.title}” to ${M.findColumn(next, columnId).title}.`);
}

async function deleteCardWithUndo(ctx, widgetId, cardId, { refocus = true } = {}) {
  const found = cardIn(widgetId, cardId);
  if (!found) return;
  const { board, card } = found;
  const beforeId = M.nextInColumn(board, cardId);
  // Focus goes to the neighbour that takes the card's place.
  const order = shownIds(widgetId, board, card.columnId);
  const neighbour = order[order.indexOf(cardId) + 1] || order[order.indexOf(cardId) - 1];
  await save(ctx, widgetId, b => M.deleteCard(b, cardId));
  if (refocus) {
    if (neighbour) { ui.roving.set(widgetId, neighbour); focusAfterRender(ctx, ids.card(widgetId, neighbour)); }
    else focusAfterRender(ctx, ids.addCard(widgetId, card.columnId));
  }
  ctx.toast(`Deleted “${card.title}”`, { action: { label: 'Undo', run: () => save(ctx, widgetId, b => M.insertCard(b, card, { beforeId })) } });
}

async function duplicate(ctx, widgetId, cardId) {
  const id = M.uid('card');
  const next = await save(ctx, widgetId, b => M.duplicateCard(b, cardId, { id }));
  if (!next) return;
  ui.roving.set(widgetId, id);
  focusAfterRender(ctx, ids.card(widgetId, id));
  announce(ctx, widgetId, 'Card duplicated.');
}

function cardMenu(ctx, anchor, widgetId, cardId) {
  const found = cardIn(widgetId, cardId);
  if (!found) return;
  const { board, card } = found;
  const index = M.columnIndex(board, card.columnId);
  const order = shownIds(widgetId, board, card.columnId);
  const at = order.indexOf(cardId);
  const linked = card.itemId ? ctx.select.byId(card.itemId) : null;
  const run = fn => () => ctx.run(fn);
  ctx.openMenu(anchor, [
    { label: 'Open card', icon: 'square-pen', run: () => openCardDialog(ctx, widgetId, cardId) },
    ...(linked && !linked.deletedAt ? [{ label: 'Open linked item', icon: 'arrow-up-right', run: () => ctx.openItem(linked.id) }] : []),
    { separator: true },
    { heading: 'Move to' },
    ...board.columns.map(column => ({ label: column.title, checked: column.id === card.columnId, disabled: column.id === card.columnId,
      run: run(() => moveToColumn(ctx, widgetId, cardId, column.id)) })),
    { separator: true },
    { label: 'Move to the previous column', icon: 'arrow-left', shortcut: '[', disabled: index <= 0, run: run(() => moveBy(ctx, widgetId, cardId, { columns: -1 })) },
    { label: 'Move to the next column', icon: 'arrow-right', shortcut: ']', disabled: index >= board.columns.length - 1, run: run(() => moveBy(ctx, widgetId, cardId, { columns: 1 })) },
    { label: 'Move up', icon: 'arrow-up', shortcut: 'alt+↑', disabled: at <= 0, run: run(() => moveBy(ctx, widgetId, cardId, { rows: -1 })) },
    { label: 'Move down', icon: 'arrow-down', shortcut: 'alt+↓', disabled: at < 0 || at >= order.length - 1, run: run(() => moveBy(ctx, widgetId, cardId, { rows: 1 })) },
    { separator: true },
    { label: 'Duplicate', icon: 'copy', run: run(() => duplicate(ctx, widgetId, cardId)) },
    { label: 'Delete card', icon: 'trash-2', danger: true, shortcut: 'Delete', run: run(() => deleteCardWithUndo(ctx, widgetId, cardId)) },
  ], { placement: 'bottom-end', label: `Options for ${card.title}` });
}

async function promptLimit(ctx, widgetId, column) {
  const value = await ctx.prompt({ title: `Limit for ${column.title}`, label: 'Most cards this column should hold (0 for no limit)', value: column.limit ? String(column.limit) : '', placeholder: 'No limit', confirmLabel: 'Set limit' });
  if (value === null) return;
  const limit = value.trim() === '' ? 0 : Number(value.trim());
  if (!Number.isInteger(limit) || limit < 0 || limit > M.LIMITS.wip) {
    ctx.toast(`Enter a whole number from 0 to ${M.LIMITS.wip}.`, { tone: 'danger' });
    return;
  }
  await save(ctx, widgetId, b => M.setLimit(b, column.id, limit));
  announce(ctx, widgetId, limit ? `${column.title} is limited to ${plural(limit, 'card')}.` : `${column.title} has no limit.`);
}

function colorMenu(ctx, anchor, widgetId, column) {
  ctx.openMenu(anchor, COLUMN_COLORS.map(option => ({ label: option.label, checked: column.color === option.value,
    icon: `kanban-color-${option.value || 'none'}${column.color === option.value ? '-on' : ''}`,
    run: () => ctx.run(() => save(ctx, widgetId, b => M.setColumnColor(b, column.id, option.value))) })), { placement: 'bottom-end', label: `Color for ${column.title}` });
}

async function deleteColumnFlow(ctx, widgetId, column) {
  const board = boardById(widgetId);
  if (!board || board.columns.length < 2) { ctx.toast('A board needs at least one column.', { tone: 'warning' }); return; }
  const cards = M.columnCards(board, column.id);
  if (cards.length && !(await ctx.confirm({ title: `Delete ${column.title}?`, tone: 'danger', confirmLabel: 'Delete column',
    body: `Its ${plural(cards.length, 'card')} will be deleted too. You can undo this right after.` }))) return;
  const index = M.columnIndex(board, column.id);
  await save(ctx, widgetId, b => M.deleteColumn(b, column.id));
  if (ui.composer.get(widgetId)?.columnId === column.id) ui.composer.delete(widgetId);
  const neighbour = board.columns[index + 1] || board.columns[index - 1];
  if (neighbour) focusAfterRender(ctx, ids.columnMenu(widgetId, neighbour.id));
  ctx.toast(`Deleted ${column.title}`, { action: { label: 'Undo', run: () => save(ctx, widgetId, b => M.restoreColumn(b, column, index, cards)) } });
}

async function clearColumn(ctx, widgetId, column) {
  const board = boardById(widgetId);
  const cards = board ? M.columnCards(board, column.id) : [];
  if (!cards.length) return;
  await save(ctx, widgetId, b => M.clearDone(b, column.id));
  ctx.toast(`Cleared ${plural(cards.length, 'card')} from ${column.title}`, { action: { label: 'Undo', run: () => save(ctx, widgetId, b => M.restoreCards(b, cards)) } });
}

function columnMenu(ctx, anchor, widgetId, columnId) {
  const board = boardById(widgetId);
  const column = board && M.findColumn(board, columnId);
  if (!column) return;
  const index = M.columnIndex(board, columnId);
  const count = M.columnCards(board, columnId).length;
  const run = fn => () => ctx.run(fn);
  ctx.openMenu(anchor, [
    { label: 'Add card', icon: 'plus', run: () => openComposer(ctx, widgetId, columnId) },
    { separator: true },
    { label: 'Rename…', icon: 'pencil', run: run(async () => {
      const title = await ctx.prompt({ title: 'Rename column', label: 'Column name', value: column.title, confirmLabel: 'Rename' });
      if (title === null || !title.trim()) return;
      await save(ctx, widgetId, b => M.renameColumn(b, columnId, title));
    }) },
    { label: 'Color…', icon: 'palette', keepFocus: true, run: () => anchor.isConnected && colorMenu(ctx, anchor, widgetId, column) },
    { label: column.limit ? `Limit: ${column.limit}…` : 'Set a limit…', icon: 'gauge', run: run(() => promptLimit(ctx, widgetId, column)) },
    { label: 'Cards here are done', checked: column.done, run: run(() => save(ctx, widgetId, b => M.updateColumn(b, columnId, { done: !column.done }))) },
    { separator: true },
    { label: 'Move left', icon: 'arrow-left', disabled: index <= 0, run: run(async () => {
      await save(ctx, widgetId, b => M.moveColumn(b, columnId, index - 1));
      focusAfterRender(ctx, ids.columnMenu(widgetId, columnId));
      announce(ctx, widgetId, `Moved ${column.title} to position ${index} of ${board.columns.length}.`);
    }) },
    { label: 'Move right', icon: 'arrow-right', disabled: index >= board.columns.length - 1, run: run(async () => {
      await save(ctx, widgetId, b => M.moveColumn(b, columnId, index + 1));
      focusAfterRender(ctx, ids.columnMenu(widgetId, columnId));
      announce(ctx, widgetId, `Moved ${column.title} to position ${index + 2} of ${board.columns.length}.`);
    }) },
    { separator: true },
    { label: column.done ? 'Clear done cards' : 'Clear all cards', icon: 'eraser', disabled: !count, run: run(() => clearColumn(ctx, widgetId, column)) },
    { label: 'Delete column…', icon: 'trash-2', danger: true, disabled: board.columns.length < 2, run: run(() => deleteColumnFlow(ctx, widgetId, column)) },
  ], { placement: 'bottom-end', label: `${column.title} column options` });
}

/* ------------------------------------------------------------------ keyboard */

const cardButtons = (root, columnId) => [...root.querySelectorAll(`.w-kanban-col[data-column="${CSS.escape(columnId)}"] .w-kanban-card:not(.is-drag-source) > .w-kanban-card-open`)];

function moveFocus(ctx, el, widgetId, key) {
  const root = el.closest('.w-kanban');
  const columnEl = el.closest('.w-kanban-col');
  if (!root || !columnEl) return false;
  const inColumn = cardButtons(root, columnEl.dataset.column);
  const index = inColumn.indexOf(el);
  let target = null;
  if (key === 'ArrowUp') target = inColumn[index - 1];
  else if (key === 'ArrowDown') target = inColumn[index + 1];
  else if (key === 'Home') target = inColumn[0];
  else if (key === 'End') target = inColumn.at(-1);
  else {
    const rtl = getComputedStyle(root).direction === 'rtl';
    const step = (key === 'ArrowRight') !== rtl ? 1 : -1;
    const columns = [...root.querySelectorAll('.w-kanban-strip > .w-kanban-col')];
    for (let i = columns.indexOf(columnEl) + step; i >= 0 && i < columns.length; i += step) {
      const cards = cardButtons(root, columns[i].dataset.column);
      if (cards.length) { target = cards[Math.min(index, cards.length - 1)]; break; }
    }
  }
  if (!target) return false;
  ui.roving.set(widgetId, target.dataset.card);
  target.focus();
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  ctx.render();
  return true;
}

registerMount('w.kanban.composer', (el, ctx) => {
  // Closing an empty composer when focus leaves it, so it never lingers open and blank.
  const onBlur = event => {
    const form = el.closest('form');
    if (form?.contains(event.relatedTarget) || el.value.trim()) return;
    setTimeout(() => {
      if (!el.isConnected || form?.contains(document.activeElement) || el.value.trim()) return;
      closeComposer(ctx, el.dataset.widget, { refocus: false });
    }, 0);
  };
  const onKey = event => {
    if (event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); el.form?.requestSubmit(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeComposer(ctx, el.dataset.widget); }
  };
  el.addEventListener('blur', onBlur);
  el.addEventListener('keydown', onKey);
  return { destroy() { el.removeEventListener('blur', onBlur); el.removeEventListener('keydown', onKey); } };
});

// Tracks the card that keeps Tab focus, opens the card menu on right-click, and marks the board when columns wait past
// either edge (data-more-start / data-more-end) so the edge buttons can show. Keyboard users move between columns with
// the arrow keys instead; the buttons are for mice without a horizontal wheel.
registerMount('w.kanban.strip', (el, ctx) => {
  const sync = () => {
    const root = el.closest('.w-kanban');
    if (!root) return;
    const max = el.scrollWidth - el.clientWidth;
    const at = Math.abs(el.scrollLeft);
    root.toggleAttribute('data-more-start', max > 1 && at > 1);
    root.toggleAttribute('data-more-end', max > 1 && max - at > 1);
  };
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
  resize?.observe(el);
  el.addEventListener('scroll', sync, { passive: true });
  sync();
  const onFocus = event => {
    const card = event.target.closest?.('.w-kanban-card-open');
    if (!card) return;
    const widgetId = card.dataset.widget;
    if (ui.roving.get(widgetId) === card.dataset.card) return;
    ui.roving.set(widgetId, card.dataset.card);
    ctx.render();
  };
  const onContext = event => {
    const card = event.target.closest?.('.w-kanban-card');
    if (!card || event.target.closest('input, textarea')) return;
    event.preventDefault();
    const button = card.querySelector('.w-kanban-card-open');
    cardMenu(ctx, { x: event.clientX, y: event.clientY }, button.dataset.widget, card.dataset.card);
  };
  el.addEventListener('focusin', onFocus);
  el.addEventListener('contextmenu', onContext);
  return {
    update: sync, // a render resets the board's attributes and may add or remove columns
    destroy() {
      resize?.disconnect();
      el.removeEventListener('scroll', sync);
      el.removeEventListener('focusin', onFocus);
      el.removeEventListener('contextmenu', onContext);
    },
  };
});

registerActions({
  'w.kanban.scroll': ({ el, data }) => {
    const strip = el.closest('.w-kanban-strip-wrap')?.querySelector('.w-kanban-strip');
    const column = strip?.querySelector(':scope > .w-kanban-col');
    if (!strip) return;
    const rtl = getComputedStyle(strip).direction === 'rtl';
    const step = (column?.getBoundingClientRect().width || strip.clientWidth / 2) + parseFloat(getComputedStyle(strip).columnGap || '0');
    const reduced = document.documentElement.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;
    strip.scrollBy({ left: Number(data.dir) * (rtl ? -1 : 1) * step, behavior: reduced ? 'auto' : 'smooth' });
  },
  'w.kanban.card-open': ({ ctx, data }) => openCardDialog(ctx, data.widget, data.card),
  'w.kanban.card-menu': ({ ctx, el, data }) => cardMenu(ctx, el, data.widget, data.card),
  'w.kanban.card-key': ({ ctx, el, event, data }) => {
    if (event.isComposing) return undefined;
    const { key, altKey, ctrlKey, metaKey, shiftKey } = event;
    if (ctrlKey || metaKey) return undefined;
    const rtl = getComputedStyle(el).direction === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    let move = null;
    if (key === ']' || (altKey && key === forward)) move = { columns: 1 };
    else if (key === '[' || (altKey && key === back)) move = { columns: -1 };
    else if (altKey && key === 'ArrowUp') move = { rows: -1 };
    else if (altKey && key === 'ArrowDown') move = { rows: 1 };
    if (move) { event.preventDefault(); return moveBy(ctx, data.widget, data.card, move); }
    if (altKey) return undefined;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key) && !shiftKey) {
      event.preventDefault();
      moveFocus(ctx, el, data.widget, key);
      return undefined;
    }
    if ((key === 'F10' && shiftKey) || key === 'ContextMenu') {
      event.preventDefault();
      // Anchored at a point under the card's ⋯ button (not the button itself) so closing the menu returns focus to
      // the card, where the arrow keys and shortcuts work, rather than to the hidden button.
      const rect = (el.closest('.w-kanban-card')?.querySelector('.w-kanban-card-menu') || el).getBoundingClientRect();
      const rtl = getComputedStyle(el).direction === 'rtl';
      cardMenu(ctx, { x: rtl ? rect.left : rect.right, y: rect.bottom }, data.widget, data.card);
      return undefined;
    }
    if (key === 'Delete' || key === 'Backspace') { event.preventDefault(); return deleteCardWithUndo(ctx, data.widget, data.card); }
    return undefined;
  },
  'w.kanban.column-menu': ({ ctx, el, data }) => columnMenu(ctx, el, data.widget, data.column),
  'w.kanban.composer-open': ({ ctx, data }) => openComposer(ctx, data.widget, data.column),
  'w.kanban.composer-close': ({ ctx, data }) => closeComposer(ctx, data.widget),
  'w.kanban.composer-input': ({ el, data }) => { ui.composer.set(data.widget, { columnId: data.column, text: el.value }); },
  'w.kanban.composer-add': ({ ctx, el, data }) => addFromComposer(ctx, data.widget, data.column, el.querySelector('[name="title"]')),
  'w.kanban.quick-add': async ({ ctx, el, data }) => {
    const input = el.querySelector('[name="title"]');
    const title = input?.value.replace(/\s+/g, ' ').trim();
    if (!title) { input?.focus(); return; }
    input.value = '';
    const id = M.uid('card');
    let next = null;
    try { next = await save(ctx, data.widget, b => M.addCard(b, data.column, { id, title })); } finally {
      if (!next && !cardIn(data.widget, id) && input.isConnected && !input.value) input.value = title;
    }
    if (!next) return;
    announce(ctx, data.widget, `Added “${title}” to ${M.findColumn(next, data.column)?.title || 'the board'}.`);
  },
  'w.kanban.add-column-open': ({ ctx, data }) => newColumn(ctx, data.widget),
  'w.kanban.add-column-input': ({ el, data }) => { ui.addColumn.set(data.widget, el.value); },
  'w.kanban.add-column-close': ({ ctx, data }) => { ui.addColumn.delete(data.widget); ctx.render(); focusAfterRender(ctx, ids.addColumn(data.widget)); },
  'w.kanban.add-column-key': ({ ctx, event, data }) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    ui.addColumn.delete(data.widget);
    ctx.render();
    focusAfterRender(ctx, ids.addColumn(data.widget));
  },
  'w.kanban.add-column': async ({ ctx, el, data }) => {
    const input = el.querySelector('[name="title"]');
    const title = input?.value.replace(/\s+/g, ' ').trim();
    if (!title) { input?.focus(); return; }
    const id = M.uid('col');
    const next = await save(ctx, data.widget, b => M.addColumn(b, { id, title }, (() => { const done = b.columns.findIndex(c => c.done); return done < 0 ? b.columns.length : done; })()));
    if (!next) return;
    ui.addColumn.delete(data.widget);
    announce(ctx, data.widget, `Added the ${title} column.`);
    openComposer(ctx, data.widget, id);
  },
  'w.kanban.filter-toggle': ({ ctx, data }) => {
    const found = findWidget(data.widget);
    if (!found) return;
    toggleFilter(ctx, data.widget, sizeOf(found.widget));
  },
  'w.kanban.filter-clear': ({ ctx, data }) => clearFilters(ctx, data.widget),
  'w.kanban.filter-label': ({ ctx, el }) => {
    const widgetId = el.closest('.w-kanban')?.dataset.widget;
    if (widgetId) return ctx.run(() => save(ctx, widgetId, b => M.setFilter(b, { label: el.value })));
    return undefined;
  },
  'w.kanban.query': ({ ctx, el, data }) => {
    ui.query.set(data.widget, el.value);
    ctx.render();
    persistQuery(ctx, data.widget);
  },
  'w.kanban.query-key': ({ ctx, event, data }) => {
    if (event.key !== 'Escape' || !event.target.value) return;
    event.preventDefault();
    event.stopPropagation();
    event.target.value = '';
    ui.query.set(data.widget, '');
    ctx.render();
    persistQuery(ctx, data.widget);
  },
  'w.kanban.new-card': ({ ctx, data }) => {
    const found = findWidget(data.widget);
    if (!found) return;
    newCard(ctx, data.widget, sizeOf(found.widget));
  },
});
