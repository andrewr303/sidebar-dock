// Kanban persistence and transient UI state shared by the board, the drag controller and the card dialog.
// Writes are optimistic: the next board is shown at once (pending) and saved to widget.config through the dashboard
// store; the pending copy is dropped once the store has it. Each write starts from the newest board, so quick
// successive edits (typing cards, keyboard moves) never undo each other.
import { findWidget, updateWidgetConfig } from '../../../lib/dashboard-store.js';
import { normalizeBoard, toConfig, findCard } from './model.js';

const pending = new Map();          // widget id -> board shown while its write is in flight
const normalized = new WeakMap();   // stored config object -> normalized board (configs are replaced, never mutated)

/** The board for a widget instance: the in-flight copy, else its stored config, normalized. */
export function boardFor(widget) {
  if (!widget) return null;
  const mine = pending.get(widget.id);
  if (mine) return mine;
  const config = widget.config || {};
  let board = normalized.get(config);
  if (!board) { board = normalizeBoard(config); normalized.set(config, board); }
  return board;
}
export const boardById = widgetId => boardFor(findWidget(widgetId)?.widget);

/**
 * Applies change(board) -> nextBoard to a widget's board and saves it. Returns the saved board, or null when the
 * reducer changed nothing. Throws a readable error when the widget is gone (ctx.run shows it).
 */
export async function save(ctx, widgetId, change) {
  const found = findWidget(widgetId);
  if (!found) throw new Error('This board is no longer on your dashboard.');
  const current = boardFor(found.widget);
  const next = change(current);
  if (!next || next === current) return null;
  pending.set(widgetId, next);
  ctx.render();
  try {
    await updateWidgetConfig(widgetId, toConfig(next));
  } finally {
    if (pending.get(widgetId) === next) pending.delete(widgetId);
    ctx.render();
  }
  return next;
}

/** A card with the board it lives on, or null. */
export function cardIn(widgetId, cardId) {
  const board = boardById(widgetId);
  const card = board && findCard(board, cardId);
  return card ? { board, card } : null;
}

/* ------------------------------------------------------------------ transient UI state (per widget, not persisted) */

export const ui = {
  composer: new Map(),   // widget id -> { columnId, text } for the inline "Add card" form
  addColumn: new Map(),  // widget id -> draft title while the "Add column" form is open
  filterBar: new Map(),  // widget id -> true | false when toggled from the header (else: shown on large sizes)
  query: new Map(),      // widget id -> search text typed but not yet saved
  roving: new Map(),     // widget id -> card id that takes Tab focus in the board
  announce: new Map(),   // widget id -> last status message for screen readers
};

/** Says `message` in the widget's polite live region. */
export function announce(ctx, widgetId, message) {
  // A trailing non-breaking space toggles so the same sentence twice is still read out.
  const previous = ui.announce.get(widgetId) || '';
  ui.announce.set(widgetId, previous.replace(/ $/, '') === message ? `${message} ` : message);
  ctx.render();
}

/** DOM ids, shared so actions can move focus to what a render just drew. */
export const ids = {
  card: (widgetId, cardId) => `wk-${widgetId}-card-${cardId}`,
  column: (widgetId, columnId) => `wk-${widgetId}-col-${columnId}`,
  columnTitle: (widgetId, columnId) => `wk-${widgetId}-colt-${columnId}`,
  columnMenu: (widgetId, columnId) => `wk-${widgetId}-colm-${columnId}`,
  addCard: (widgetId, columnId) => `wk-${widgetId}-add-${columnId}`,
  composer: widgetId => `wk-${widgetId}-composer`,
  addColumn: widgetId => `wk-${widgetId}-addcol`,
  addColumnInput: widgetId => `wk-${widgetId}-addcol-input`,
  search: widgetId => `wk-${widgetId}-search`,
  quick: widgetId => `wk-${widgetId}-quick`,
};

/** Focuses an element by id after the next render (or now, when it is already there and nothing is pending). */
export function focusAfterRender(ctx, id, { scroll = 'nearest' } = {}) {
  ctx.nextFrame(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: scroll, inline: 'nearest' });
  });
}
