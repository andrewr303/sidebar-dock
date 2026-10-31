// Pure layout math for the dashboard grid (no DOM). A layout is an array of rects { id, x, y, w, h } in grid cells:
// x 0..cols-1, w 1..cols, y >= 0, h >= 1. Every function returns new rect objects and never mutates its input.
// The stored layout is free-form on 12 columns (widgets stay where they are put); collisions push widgets down,
// "Tidy up" applies vertical gravity, and narrower windows show a packed copy of the layout.

export const GRID_COLS = 12;

const copy = rects => rects.map(r => ({ id: r.id, x: r.x, y: r.y, w: r.w, h: r.h }));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const byReading = (a, b) => a.y - b.y || a.x - b.x;

/**
 * Columns to show for a grid this many pixels wide: the full 12 down to tablet widths (a 3-column widget is still
 * ~180px there), then 6 (every widget at half its columns, so rows pair up) and finally one stacked column of 2.
 */
export function columnsForWidth(px) {
  const width = Number(px) || 0;
  if (width >= 760) return 12;
  if (width >= 480) return 6;
  return 2;
}

export const collides = (a, b) => a.id !== b.id && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export const layoutBottom = rects => rects.reduce((max, r) => Math.max(max, r.y + r.h), 0);
export const sortReading = rects => [...rects].sort(byReading);

/** Keeps a rect inside the grid: width fits the columns, x leaves room for the width, y is never negative. */
export function clampRect(rect, cols = GRID_COLS) {
  const w = clamp(Math.round(rect.w) || 1, 1, cols);
  return { ...rect, w, h: Math.max(1, Math.round(rect.h) || 1), x: clamp(Math.round(rect.x) || 0, 0, cols - w), y: Math.max(0, Math.round(rect.y) || 0) };
}

// Pushes everything that overlaps `item` down below it, cascading through whatever those widgets then overlap.
function pushDown(layout, item, depth = 0) {
  if (depth > 200) return;
  const colliders = layout.filter(other => collides(other, item)).sort(byReading);
  for (const other of colliders) {
    if (!collides(other, item)) continue;
    other.y = item.y + item.h;
    pushDown(layout, other, depth + 1);
  }
}

/** Repairs a layout read from storage: clamps every rect and moves overlapping widgets down in reading order. */
export function settle(rects, cols = GRID_COLS) {
  const placed = [];
  for (const rect of sortReading(copy(rects)).map(r => clampRect(r, cols))) {
    while (placed.some(other => collides(other, rect))) rect.y++;
    placed.push(rect);
  }
  const order = new Map(rects.map((r, i) => [r.id, i]));
  return placed.sort((a, b) => order.get(a.id) - order.get(b.id));
}

/** Moves one widget to cell {x, y}; widgets it lands on are pushed down (and the ones they land on, and so on). */
export function moveWidget(rects, id, { x, y }, cols = GRID_COLS) {
  const layout = copy(rects);
  const item = layout.find(r => r.id === id);
  if (!item) return layout;
  Object.assign(item, clampRect({ ...item, x, y }, cols));
  pushDown(layout, item);
  return layout;
}

/** Resizes one widget (clamped to `limits` {minW, maxW, minH, maxH} and the columns); overlapped widgets move down. */
export function resizeWidget(rects, id, { w, h }, cols = GRID_COLS, limits = {}) {
  const layout = copy(rects);
  const item = layout.find(r => r.id === id);
  if (!item) return layout;
  item.w = clamp(Math.round(w), Math.max(1, limits.minW || 1), Math.min(cols - item.x, limits.maxW || cols));
  item.h = clamp(Math.round(h), Math.max(1, limits.minH || 1), Math.max(1, limits.maxH || 40));
  pushDown(layout, item);
  return layout;
}

/**
 * Keyboard move by one cell. Sideways moves push like a drag. Vertical moves swap with the widgets directly above or
 * below when there are any, so repeated presses step past a neighbor instead of shoving it down forever.
 */
export function nudgeWidget(rects, id, dx, dy, cols = GRID_COLS) {
  const layout = copy(rects);
  const item = layout.find(r => r.id === id);
  if (!item) return layout;
  if (dx) return moveWidget(rects, id, { x: item.x + Math.sign(dx), y: item.y }, cols);
  if (!dy) return layout;
  if (dy < 0) {
    if (item.y === 0) return layout;
    const band = { id: '\u0000band', x: item.x, y: item.y - 1, w: item.w, h: 1 };
    const above = layout.filter(other => other.id !== id && collides(other, band));
    const top = above.length ? Math.min(...above.map(r => r.y)) : item.y - 1;
    return moveWidget(rects, id, { x: item.x, y: top }, cols);
  }
  const band = { id: '\u0000band', x: item.x, y: item.y + item.h, w: item.w, h: 1 };
  const below = layout.filter(other => other.id !== id && collides(other, band));
  if (!below.length) return moveWidget(rects, id, { x: item.x, y: item.y + 1 }, cols);
  // Lift the neighbors below into the space this widget leaves, then place it under them.
  const shift = Math.min(...below.map(r => r.y)) - item.y;
  const lifted = below.map(r => ({ ...r, y: r.y - shift }));
  const others = layout.filter(r => r.id !== id && !below.some(b => b.id === r.id));
  if (lifted.some(r => others.some(o => collides(o, r)))) return moveWidget(rects, id, { x: item.x, y: item.y + 1 }, cols);
  for (const r of lifted) Object.assign(layout.find(l => l.id === r.id), { y: r.y });
  const nextY = Math.max(...lifted.map(r => r.y + r.h));
  Object.assign(item, { y: nextY });
  pushDown(layout, item);
  return layout;
}

/** Vertical gravity ("Tidy up"): every widget rises as far as it can, in reading order, keeping its column. */
export function compact(rects, cols = GRID_COLS) {
  const placed = [];
  for (const rect of sortReading(copy(rects)).map(r => clampRect(r, cols))) {
    while (rect.y > 0 && !placed.some(other => collides(other, { ...rect, y: rect.y - 1 }))) rect.y--;
    while (placed.some(other => collides(other, rect))) rect.y++;
    placed.push(rect);
  }
  const order = new Map(rects.map((r, i) => [r.id, i]));
  return placed.sort((a, b) => order.get(a.id) - order.get(b.id));
}

/** First free top-left cell for a w×h widget, scanning rows from `fromY`. Wider than the grid → full width. */
export function findFreeSpot(rects, w, h, cols = GRID_COLS, { fromY = 0 } = {}) {
  const width = clamp(Math.round(w) || 1, 1, cols);
  const height = Math.max(1, Math.round(h) || 1);
  const limit = layoutBottom(rects) + 1;
  for (let y = Math.max(0, fromY); y <= limit; y++) {
    for (let x = 0; x + width <= cols; x++) {
      const candidate = { id: '\u0000candidate', x, y, w: width, h: height };
      if (!rects.some(other => collides(other, candidate))) return { x, y };
    }
  }
  return { x: 0, y: limit };
}

/** Width a 12-column widget gets on a narrower grid: proportional, at least 2 columns (or the whole grid). */
export function scaledWidth(w, cols) {
  if (cols >= GRID_COLS) return clamp(w, 1, GRID_COLS);
  if (cols <= 2) return cols;
  return clamp(Math.ceil((w * cols) / GRID_COLS), Math.min(2, cols), cols);
}

/**
 * Layout for a narrower grid: widgets keep their reading order and height, take proportional widths and flow into
 * the first gap at or after the previous widget's row (so order is preserved without leaving holes).
 */
export function packForColumns(rects, cols) {
  if (cols >= GRID_COLS) return settle(rects, GRID_COLS);
  const placed = [];
  let cursor = 0;
  for (const rect of sortReading(copy(rects))) {
    const w = scaledWidth(rect.w, cols);
    const spot = findFreeSpot(placed, w, rect.h, cols, { fromY: cursor });
    const next = { ...rect, w, x: spot.x, y: spot.y };
    placed.push(next);
    cursor = spot.y;
  }
  const order = new Map(rects.map((r, i) => [r.id, i]));
  return placed.sort((a, b) => order.get(a.id) - order.get(b.id));
}

/** Rects in `after` whose position or size differs from `before` (what applyLayout needs to save). */
export function layoutChanges(before, after) {
  const old = new Map(before.map(r => [r.id, r]));
  return after.filter(r => {
    const prev = old.get(r.id);
    return !prev || prev.x !== r.x || prev.y !== r.y || prev.w !== r.w || prev.h !== r.h;
  }).map(r => ({ id: r.id, x: r.x, y: r.y, w: r.w, h: r.h }));
}

/**
 * Snaps a pixel offset inside the grid (relative to its top-left corner) to the cell a widget's top-left lands in.
 * metrics: { cols, colWidth, rowHeight, gap }. w keeps the widget inside the columns.
 */
export function cellAt(px, py, { cols = GRID_COLS, colWidth, rowHeight, gap }, w = 1) {
  const x = Math.round(px / (colWidth + gap));
  const y = Math.round(py / (rowHeight + gap));
  return { x: clamp(x, 0, Math.max(0, cols - w)), y: Math.max(0, y) };
}

/** Grid cells spanned by a pixel size (resize handles): rounds to the nearest whole cell. */
export function spanFor(pixels, unit, gap, min = 1) {
  return Math.max(min, Math.round((pixels + gap) / (unit + gap)));
}
