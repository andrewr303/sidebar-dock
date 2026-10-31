// Dashboard view state shared by the dashboard modules: transient UI state in ctx.state.dash and the layout actually
// shown (the stored 12-column layout, repaired, or a packed copy on narrow grids, or a live preview while dragging).
import { getDashboard, activeBoard } from '../../lib/dashboard-store.js';
import { settingsGroup } from '../../lib/settings-schema.js';
import { settle, packForColumns, GRID_COLS, columnsForWidth } from './grid.js';

// Before the first measurement, guess the grid width from the window (sidebar ~248px when docked at ≥1100px), so the
// first paint almost always has the right column count.
function guessColumns() {
  const width = globalThis.innerWidth || 1280;
  return columnsForWidth(width - (width >= 1100 ? 248 : 0) - 48);
}

/** Transient dashboard UI state (not persisted): edit mode, measured columns, search box, highlight, announcements. */
export function dashUi(ctx) {
  return ctx.state.dash ||= {
    editing: false,
    cols: guessColumns(),
    measured: false,
    search: { query: '', open: false, active: 0 },
    highlight: '',
    announce: '',
    errors: new Map(),
    stamp: 0,
  };
}

export const dashboardPrefs = ctx => settingsGroup(ctx.library?.settings || {}, 'dashboard');
export const newTabPrefs = ctx => settingsGroup(ctx.library?.settings || {}, 'newTab');
export const canEdit = ctx => dashUi(ctx).cols >= GRID_COLS;
export { getDashboard, activeBoard };

// While a drag or resize is in progress, edit.js publishes the previewed layout here so any re-render (another tab
// saving, a library change) draws the preview instead of snapping widgets back to their stored cells.
let preview = null;
export const setLayoutPreview = value => { preview = value; };
export const layoutPreview = () => preview;

const rectsOf = widgets => widgets.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));

/** Rects to draw for a board at the current column count: Map(id -> {x, y, w, h}). */
export function shownLayout(ctx, board) {
  const cols = dashUi(ctx).cols;
  if (preview?.boardId === board.id && cols >= GRID_COLS) return new Map(preview.rects.map(r => [r.id, r]));
  const rects = cols >= GRID_COLS ? settle(rectsOf(board.widgets)) : packForColumns(rectsOf(board.widgets), cols);
  return new Map(rects.map(r => [r.id, r]));
}

/** The stored layout of a board, repaired (what drags and keyboard moves start from). */
export const storedLayout = board => settle(rectsOf(board.widgets));

/** Greeting for the hour: "Good morning" (5–12), "Good afternoon" (12–18), "Good evening" (18–22), else "Good night". */
export function greetingFor(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  if (hour >= 18 && hour < 22) return 'Good evening';
  return 'Good night';
}
