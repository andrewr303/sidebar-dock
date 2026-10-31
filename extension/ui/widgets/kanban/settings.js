// Settings editor for the kanban widget (inside the dashboard's widget settings dialog): layout, descriptions on cards,
// the columns (name, color, work-in-progress limit, done) and the labels (name, color). Edits stay in the dialog's
// draft (draft.columns / draft.labels, written through the registry's draft API) until Save; onSettingsSave then applies
// them to the live board, so cards added meanwhile are kept and cards in removed columns move to the first column.
import { html, cx, plural, raw } from '../../html.js';
import { icon } from '../../icons.js';
import { registerActions } from '../../runtime.js';
import { getSettingsDraft } from '../../dashboard/registry.js';
import { findWidget } from '../../../lib/dashboard-store.js';
import { button, iconButton, segmented, switchToggle, field, colorVar } from '../../components.js';
import * as M from './model.js';
import { boardFor } from './store.js';
import './escape.js';

export const LAYOUT_OPTIONS = Object.freeze([
  { value: 'auto', label: 'Automatic' },
  { value: 'board', label: 'Board' },
  { value: 'summary', label: 'Summary' },
]);

const prepared = new WeakSet();   // drafts already loaded from the live board
const pickers = new WeakMap();    // draft -> 'columns:<id>' | 'labels:<id>' (the row whose color picker is open)
const rowId = (widgetId, list, id, part) => `wks-${widgetId}-${list}-${id}-${part}`;
const liveBoard = widget => boardFor(findWidget(widget.id)?.widget || widget);
const colorName = color => (color ? M.COLOR_LABELS[color] || 'Gray' : 'No color');

/**
 * Loads the columns, labels and view options of the live board into a fresh draft, once. The dialog's draft starts as
 * the stored config merged over the defaults, which can hold sample columns or labels for boards saved by older
 * versions; the editor always starts from what the board really shows.
 */
function prepare(widget, draft) {
  if (prepared.has(draft)) return;
  prepared.add(draft);
  const board = liveBoard(widget);
  draft.columns = board.columns.map(column => ({ ...column, limit: column.limit || null }));
  draft.labels = board.labels.map(label => ({ ...label }));
  draft.layout = board.layout;
  draft.showDescriptions = board.showDescriptions;
}

function swatchPicker(widgetId, list, index, row, allowNone) {
  const value = row.color || '';
  const options = [...(allowNone ? [''] : []), ...M.COLORS];
  const name = (list === 'columns' ? row.title : row.name) || (list === 'columns' ? `column ${index + 1}` : `label ${index + 1}`);
  return html`<div class="w-kanban-set-swatches w-kanban-swatches" id="${rowId(widgetId, list, row.id, 'colors')}" role="radiogroup" aria-label="Color for ${name}"
    data-mount="w.kanban.escape" data-escape="w.kanban.set-swatch-close" data-keydown="w.kanban.set-swatch-close" data-list="${list}" data-id="${row.id}">
    ${options.map(color => html`<button type="button" role="radio" class="${cx('w-kanban-swatch', !color && 'is-none')}" style="${color ? `--swatch:${colorVar(color)}` : ''}"
      aria-checked="${color === value ? 'true' : 'false'}" tabindex="${color === value ? '0' : '-1'}" aria-label="${colorName(color)}" title="${colorName(color)}"
      data-action="dashboard.draft-set" data-name="${list}.${index}.color" data-value="${color}">${color === value ? icon('check', { size: 12, strokeWidth: 3 }) : ''}</button>`)}
  </div>`;
}

function colorToggle(widgetId, list, row, index, open) {
  const name = (list === 'columns' ? row.title : row.name) || (list === 'columns' ? `column ${index + 1}` : `label ${index + 1}`);
  return html`<button type="button" class="${cx('w-kanban-set-color', !row.color && 'is-none')}" id="${rowId(widgetId, list, row.id, 'color')}"
    style="${row.color ? `--swatch:${colorVar(row.color)}` : ''}" aria-expanded="${open ? 'true' : 'false'}" aria-controls="${rowId(widgetId, list, row.id, 'colors')}"
    aria-label="Color for ${name}: ${colorName(row.color)}" data-tooltip="Change color" data-action="w.kanban.set-color-toggle" data-list="${list}" data-id="${row.id}">
    <span class="w-kanban-set-color-dot" aria-hidden="true"></span></button>`;
}

function rowError(id, message) {
  return message ? html`<p class="field-error w-kanban-set-error" id="${id}">${icon('circle-alert', { size: 14 })}<span>${message}</span></p>` : '';
}

function columnRow(widgetId, draft, errors, row, index, counts) {
  const open = pickers.get(draft) === `columns:${row.id}`;
  const nameId = rowId(widgetId, 'columns', row.id, 'name');
  const limitId = rowId(widgetId, 'columns', row.id, 'limit');
  const nameError = errors[`columns.${index}.title`];
  const limitError = errors[`columns.${index}.limit`];
  const total = draft.columns.length;
  const label = row.title || `column ${index + 1}`;
  const count = counts.get(row.id);
  return html`<li class="w-kanban-set-row is-column" data-key="col-${row.id}">
    ${colorToggle(widgetId, 'columns', row, index, open)}
    <input class="input input-sm w-kanban-set-name" id="${nameId}" value="${row.title || ''}" maxlength="${M.LIMITS.column}" placeholder="Column name"
      aria-label="Column ${index + 1} name" data-input="dashboard.draft" data-name="columns.${index}.title" autocomplete="off" spellcheck="true" dir="auto"
      ${nameError ? html`aria-invalid="true" aria-describedby="${nameId}-error"` : ''}>
    <span class="w-kanban-set-limit">
      <label class="w-kanban-set-limit-label" for="${limitId}">Limit</label>
      <input class="input input-sm" id="${limitId}" type="number" inputmode="numeric" min="0" max="${M.LIMITS.wip}" step="1" value="${row.limit ?? ''}" placeholder="None"
        aria-label="Limit for ${label}"
        data-input="dashboard.draft" data-name="columns.${index}.limit" data-type="number" ${limitError ? html`aria-invalid="true" aria-describedby="${limitId}-error"` : ''}>
    </span>
    <label class="checkbox w-kanban-set-done"><input type="checkbox" ${row.done === true ? raw('checked') : ''} aria-label="Done: cards in ${label} count as finished"
      data-change="dashboard.draft" data-name="columns.${index}.done" data-type="boolean"><span class="checkbox-box" aria-hidden="true">${icon('check', { size: 12, strokeWidth: 3 })}</span><span class="checkbox-label" aria-hidden="true">Done</span></label>
    <span class="w-kanban-set-count">${count ? plural(count, 'card') : row.isNew ? 'New' : 'Empty'}</span>
    <span class="w-kanban-set-tools">
      ${iconButton({ icon: 'arrow-up', label: `Move ${label} up`, size: 'sm', action: 'w.kanban.set-move', disabled: index === 0, data: { list: 'columns', index, dir: -1 } })}
      ${iconButton({ icon: 'arrow-down', label: `Move ${label} down`, size: 'sm', action: 'w.kanban.set-move', disabled: index === total - 1, data: { list: 'columns', index, dir: 1 } })}
      ${iconButton({ icon: 'x', label: `Remove ${label}`, size: 'sm', action: 'w.kanban.set-remove', disabled: total < 2, data: { list: 'columns', index } })}
    </span>
    ${open ? swatchPicker(widgetId, 'columns', index, row, true) : ''}
    ${rowError(`${nameId}-error`, nameError)}${rowError(`${limitId}-error`, limitError)}
  </li>`;
}

function labelRow(widgetId, draft, errors, row, index, counts) {
  const open = pickers.get(draft) === `labels:${row.id}`;
  const nameId = rowId(widgetId, 'labels', row.id, 'name');
  const nameError = errors[`labels.${index}.name`];
  const count = counts.get(row.id);
  return html`<li class="w-kanban-set-row is-label" data-key="lbl-${row.id}">
    ${colorToggle(widgetId, 'labels', row, index, open)}
    <input class="input input-sm w-kanban-set-name" id="${nameId}" value="${row.name || ''}" maxlength="${M.LIMITS.label}" placeholder="Label name"
      aria-label="Label ${index + 1} name" data-input="dashboard.draft" data-name="labels.${index}.name" autocomplete="off" spellcheck="true" dir="auto"
      ${nameError ? html`aria-invalid="true" aria-describedby="${nameId}-error"` : ''}>
    <span class="w-kanban-set-count">${count ? `On ${plural(count, 'card')}` : row.isNew ? 'New' : 'Unused'}</span>
    <span class="w-kanban-set-tools">
      ${iconButton({ icon: 'x', label: `Remove ${row.name || `label ${index + 1}`}`, size: 'sm', action: 'w.kanban.set-remove', data: { list: 'labels', index } })}
    </span>
    ${open ? swatchPicker(widgetId, 'labels', index, row, false) : ''}
    ${rowError(`${nameId}-error`, nameError)}
  </li>`;
}

export function renderSettings(ctx, widget, draft, env = {}) {
  prepare(widget, draft);
  const errors = env.errors || {};
  const board = liveBoard(widget);
  const columnCounts = new Map(board.columns.map(c => [c.id, 0]));
  const labelCounts = new Map(board.labels.map(l => [l.id, 0]));
  for (const card of board.cards) {
    columnCounts.set(card.columnId, (columnCounts.get(card.columnId) || 0) + 1);
    for (const id of card.labels) labelCounts.set(id, (labelCounts.get(id) || 0) + 1);
  }
  const notes = M.settingsNotes(board, draft);
  const columns = draft.columns || [];
  const labels = draft.labels || [];
  const id = `wks-${widget.id}`;
  return html`<div class="w-kanban-set" data-key="${id}">
    ${field({ label: 'Layout', hint: 'Automatic shows the full board when the widget is large enough and a summary when it is small.',
      control: segmented({ name: 'layout', value: draft.layout || 'auto', options: LAYOUT_OPTIONS, action: 'dashboard.draft-set', ariaLabel: 'Layout' }) })}
    <div class="dash-settings-toggle">${switchToggle({ checked: draft.showDescriptions === true, label: 'Show descriptions on cards',
      description: 'Cards show the first lines of their description under the title.', action: 'dashboard.draft', data: { name: 'showDescriptions', type: 'boolean' } })}</div>

    <section class="w-kanban-set-group" aria-labelledby="${id}-cols">
      <div class="w-kanban-set-head">
        <h4 class="w-kanban-set-title" id="${id}-cols">Columns <span class="w-kanban-set-total">${columns.length} of ${M.LIMITS.columns}</span></h4>
        <p class="w-kanban-set-hint">A limit warns when a column holds more cards. Cards in a done column count as finished: they leave Up next and their due dates stop warning.</p>
      </div>
      <ol class="w-kanban-set-list" role="list">${columns.map((row, index) => columnRow(widget.id, draft, errors, row, index, columnCounts))}</ol>
      ${errors.columns ? rowError(`${id}-cols-error`, errors.columns) : ''}
      ${notes.columns ? html`<p class="w-kanban-set-note">${icon('info', { size: 14 })}<span>${notes.columns}</span></p>` : ''}
      ${columns.length < M.LIMITS.columns ? button({ label: 'Add column', icon: 'plus', size: 'sm', variant: 'ghost', action: 'w.kanban.set-add', data: { list: 'columns', widget: widget.id }, className: 'w-kanban-set-add' }) : ''}
    </section>

    <section class="w-kanban-set-group" aria-labelledby="${id}-labels">
      <div class="w-kanban-set-head">
        <h4 class="w-kanban-set-title" id="${id}-labels">Labels <span class="w-kanban-set-total">${labels.length} of ${M.LIMITS.labels}</span></h4>
        <p class="w-kanban-set-hint">Labels group cards across columns. Large boards can show only the cards with one label.</p>
      </div>
      ${labels.length ? html`<ul class="w-kanban-set-list" role="list">${labels.map((row, index) => labelRow(widget.id, draft, errors, row, index, labelCounts))}</ul>`
        : html`<p class="w-kanban-set-empty">No labels yet. Add one here, or create labels while editing a card.</p>`}
      ${notes.labels ? html`<p class="w-kanban-set-note">${icon('info', { size: 14 })}<span>${notes.labels}</span></p>` : ''}
      ${labels.length < M.LIMITS.labels ? button({ label: 'Add label', icon: 'plus', size: 'sm', variant: 'ghost', action: 'w.kanban.set-add', data: { list: 'labels', widget: widget.id }, className: 'w-kanban-set-add' }) : ''}
    </section>
  </div>`;
}

/** Inline errors before saving (the dialog focuses the first invalid field). */
export const validateSettings = draft => M.settingsErrors(draft);

/** The config to store: the draft's columns, labels and view options applied to the live board. */
export function onSettingsSave(ctx, widget, draft) {
  const board = liveBoard(widget);
  if (!prepared.has(draft)) return M.toConfig(board);
  const columns = (draft.columns || []).map(({ isNew, ...column }) => column);
  const labels = (draft.labels || []).map(({ isNew, ...label }) => label);
  return M.toConfig(M.applySettings(board, { ...draft, columns, labels }));
}

/* ------------------------------------------------------------------ actions */

function focusSoon(ctx, id) {
  ctx.nextFrame(() => ctx.nextFrame(() => {
    const el = document.getElementById(id);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView?.({ block: 'nearest' });
  }));
}

registerActions({
  'w.kanban.set-color-toggle': ({ ctx, data }) => {
    const holder = getSettingsDraft();
    if (!holder) return;
    const key = `${data.list}:${data.id}`;
    const open = pickers.get(holder.draft) === key;
    if (open) pickers.delete(holder.draft); else pickers.set(holder.draft, key);
    holder.render();
    // Opening moves focus to the chosen swatch so arrow keys pick at once; closing keeps it on the toggle.
    if (!open) {
      ctx.nextFrame(() => ctx.nextFrame(() => document.querySelector(`#${CSS.escape(`wks-${holder.widget.id}-${data.list}-${data.id}-colors`)} [aria-checked="true"]`)?.focus()));
    }
  },
  // Escape (through the escape scope) or Enter closes the swatches, not the dialog, and returns focus to the color button.
  'w.kanban.set-swatch-close': ({ ctx, event, data }) => {
    if (event?.type === 'keydown' && event.key !== 'Escape' && event.key !== 'Enter') return;
    const holder = getSettingsDraft();
    if (!holder) return;
    event?.preventDefault();
    pickers.delete(holder.draft);
    holder.render();
    focusSoon(ctx, `wks-${holder.widget.id}-${data.list}-${data.id}-color`);
  },
  'w.kanban.set-add': ({ ctx, data }) => {
    const holder = getSettingsDraft();
    if (!holder) return;
    const rows = [...(holder.draft[data.list] || [])];
    let row;
    if (data.list === 'columns') {
      if (rows.length >= M.LIMITS.columns) return;
      row = { id: M.uid('col'), title: '', color: '', limit: null, done: false, isNew: true };
      // New columns go before the done column, like the board's own "Add column".
      const done = rows.findIndex(column => column.done);
      rows.splice(done < 0 ? rows.length : done, 0, row);
    } else {
      if (rows.length >= M.LIMITS.labels) return;
      const used = new Set(rows.map(label => label.color));
      row = { id: M.uid('lbl'), name: '', color: M.COLORS.find(color => !used.has(color) && color !== 'gray') || 'gray', isNew: true };
      rows.push(row);
    }
    holder.set({ [data.list]: rows });
    focusSoon(ctx, `wks-${holder.widget.id}-${data.list}-${row.id}-name`);
  },
  'w.kanban.set-remove': ({ ctx, data }) => {
    const holder = getSettingsDraft();
    if (!holder) return;
    const rows = [...(holder.draft[data.list] || [])];
    const index = Number(data.index);
    if (data.list === 'columns' && rows.length < 2) return;
    const [removed] = rows.splice(index, 1);
    if (!removed) return;
    if (pickers.get(holder.draft) === `${data.list}:${removed.id}`) pickers.delete(holder.draft);
    holder.set({ [data.list]: rows });
    // Focus moves to the row that took its place (or the list's add button).
    const next = rows[index] || rows[index - 1];
    if (next) focusSoon(ctx, `wks-${holder.widget.id}-${data.list}-${next.id}-name`);
    else ctx.nextFrame(() => ctx.nextFrame(() => document.querySelector(`.w-kanban-set-add[data-list="${data.list}"]`)?.focus()));
  },
  'w.kanban.set-move': ({ ctx, el, data }) => {
    const holder = getSettingsDraft();
    if (!holder) return;
    const rows = [...(holder.draft[data.list] || [])];
    const from = Number(data.index);
    const to = from + Number(data.dir);
    if (to < 0 || to >= rows.length) return;
    [rows[from], rows[to]] = [rows[to], rows[from]];
    holder.set({ [data.list]: rows });
    // Focus follows the moved row: the same arrow, or the other one once it reaches the edge.
    const moved = rows[to];
    ctx.nextFrame(() => ctx.nextFrame(() => {
      const row = document.querySelector(`.w-kanban-set [data-key="col-${CSS.escape(moved.id)}"]`);
      const arrows = row ? [...row.querySelectorAll('.w-kanban-set-tools [data-dir]')] : [];
      const target = arrows.find(b => b.dataset.dir === String(data.dir) && !b.disabled) || arrows.find(b => !b.disabled);
      (target || el)?.focus?.();
    }));
  },
});
