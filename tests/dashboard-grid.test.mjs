import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRID_COLS, columnsForWidth, collides, layoutBottom, clampRect, settle, moveWidget, resizeWidget, nudgeWidget, compact,
  findFreeSpot, scaledWidth, packForColumns, layoutChanges, cellAt, spanFor,
} from '../extension/ui/dashboard/grid.js';

const noOverlaps = layout => {
  for (const a of layout) for (const b of layout) if (a !== b) assert.equal(collides(a, b), false, `${a.id} overlaps ${b.id}`);
};
const inBounds = (layout, cols = GRID_COLS) => {
  for (const r of layout) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1, `${r.id} has a valid origin and size`);
    assert.ok(r.x + r.w <= cols, `${r.id} fits ${cols} columns`);
  }
};
const at = (layout, id) => layout.find(r => r.id === id);
const sortReadingIds = rects => [...rects].sort((p, q) => p.y - q.y || p.x - q.x).map(r => r.id);

const sample = () => [
  { id: 'a', x: 0, y: 0, w: 3, h: 3 },
  { id: 'b', x: 3, y: 0, w: 3, h: 3 },
  { id: 'c', x: 0, y: 3, w: 6, h: 2 },
  { id: 'd', x: 6, y: 0, w: 6, h: 4 },
];

test('columns follow the measured grid width', () => {
  assert.equal(columnsForWidth(1200), 12);
  assert.equal(columnsForWidth(760), 12);
  assert.equal(columnsForWidth(759), 6);
  assert.equal(columnsForWidth(480), 6);
  assert.equal(columnsForWidth(479), 2);
  assert.equal(columnsForWidth(320), 2);
  assert.equal(columnsForWidth(undefined), 2);
});

test('collisions ignore the same widget and touching edges', () => {
  assert.equal(collides({ id: 'a', x: 0, y: 0, w: 2, h: 2 }, { id: 'b', x: 2, y: 0, w: 2, h: 2 }), false);
  assert.equal(collides({ id: 'a', x: 0, y: 0, w: 2, h: 2 }, { id: 'b', x: 1, y: 1, w: 2, h: 2 }), true);
  assert.equal(collides({ id: 'a', x: 0, y: 0, w: 2, h: 2 }, { id: 'a', x: 0, y: 0, w: 2, h: 2 }), false);
  assert.equal(layoutBottom(sample()), 5);
});

test('clampRect keeps rects inside the grid', () => {
  assert.deepEqual(clampRect({ id: 'x', x: 11, y: -3, w: 4, h: 0 }), { id: 'x', x: 8, y: 0, w: 4, h: 1 });
  assert.deepEqual(clampRect({ id: 'x', x: 2, y: 1, w: 20, h: 2 }, 8), { id: 'x', x: 0, y: 1, w: 8, h: 2 });
});

test('settle repairs overlapping layouts without reordering the array', () => {
  const broken = [{ id: 'a', x: 0, y: 0, w: 4, h: 2 }, { id: 'b', x: 2, y: 1, w: 4, h: 2 }, { id: 'c', x: 10, y: 0, w: 5, h: 1 }];
  const fixed = settle(broken);
  noOverlaps(fixed);
  inBounds(fixed);
  assert.deepEqual(fixed.map(r => r.id), ['a', 'b', 'c']);
  assert.equal(at(fixed, 'b').y, 2);
  assert.equal(at(fixed, 'c').x, 7);
});

test('moveWidget pushes colliders down and cascades', () => {
  const input = sample();
  const frozen = JSON.stringify(input);
  const next = moveWidget(input, 'd', { x: 0, y: 0 });
  assert.equal(JSON.stringify(input), frozen, 'input untouched');
  noOverlaps(next);
  inBounds(next);
  assert.deepEqual(at(next, 'd'), { id: 'd', x: 0, y: 0, w: 6, h: 4 });
  assert.equal(at(next, 'a').y, 4);
  assert.equal(at(next, 'b').y, 4);
  assert.equal(at(next, 'c').y, 7, 'c moves below a and b');
});

test('moveWidget clamps the target into the grid', () => {
  const next = moveWidget(sample(), 'a', { x: 20, y: -4 });
  assert.equal(at(next, 'a').x, 9);
  assert.equal(at(next, 'a').y, 0);
  noOverlaps(next);
});

test('resizeWidget respects limits and the right edge, pushing neighbors down', () => {
  const next = resizeWidget(sample(), 'a', { w: 6, h: 4 }, GRID_COLS, { maxW: 5, minH: 2 });
  assert.equal(at(next, 'a').w, 5);
  assert.equal(at(next, 'a').h, 4);
  noOverlaps(next);
  const edge = resizeWidget(sample(), 'd', { w: 12, h: 1 }, GRID_COLS, { minH: 2 });
  assert.equal(at(edge, 'd').w, 6, 'cannot grow past column 12');
  assert.equal(at(edge, 'd').h, 2);
});

test('nudgeWidget swaps vertically with direct neighbors and moves freely otherwise', () => {
  const layout = [{ id: 'a', x: 0, y: 0, w: 4, h: 2 }, { id: 'b', x: 0, y: 2, w: 4, h: 3 }];
  const down = nudgeWidget(layout, 'a', 0, 1);
  assert.equal(at(down, 'b').y, 0);
  assert.equal(at(down, 'a').y, 3);
  noOverlaps(down);
  const up = nudgeWidget(down, 'a', 0, -1);
  assert.equal(at(up, 'a').y, 0);
  assert.equal(at(up, 'b').y, 2);
  noOverlaps(up);
  const free = nudgeWidget([{ id: 'a', x: 0, y: 0, w: 2, h: 2 }], 'a', 0, 1);
  assert.equal(at(free, 'a').y, 1);
  const right = nudgeWidget(layout, 'a', 1, 0);
  assert.equal(at(right, 'a').x, 1);
  noOverlaps(right);
  assert.deepEqual(nudgeWidget(layout, 'a', 0, -1), layout, 'top row stays put');
});

test('compact lifts widgets into gaps in reading order', () => {
  const loose = [{ id: 'a', x: 0, y: 3, w: 3, h: 2 }, { id: 'b', x: 0, y: 9, w: 3, h: 2 }, { id: 'c', x: 3, y: 6, w: 3, h: 1 }];
  const tidy = compact(loose);
  assert.deepEqual(tidy.map(r => [r.id, r.y]), [['a', 0], ['b', 2], ['c', 0]]);
  noOverlaps(tidy);
});

test('findFreeSpot finds the first top-left gap', () => {
  assert.deepEqual(findFreeSpot(sample(), 3, 2), { x: 6, y: 4 });
  assert.deepEqual(findFreeSpot([], 4, 2), { x: 0, y: 0 });
  assert.deepEqual(findFreeSpot(sample(), 12, 1), { x: 0, y: 5 });
  assert.deepEqual(findFreeSpot([{ id: 'a', x: 0, y: 0, w: 12, h: 2 }], 20, 2), { x: 0, y: 2 }, 'too wide → full width');
});

test('packForColumns keeps order, fits narrower grids and never overlaps', () => {
  for (const cols of [8, 6, 4, 2]) {
    const packed = packForColumns(sample(), cols);
    noOverlaps(packed);
    inBounds(packed, cols);
    assert.deepEqual(packed.map(r => r.id), ['a', 'b', 'c', 'd']);
    const reading = [...packed].sort((p, q) => p.y - q.y || p.x - q.x).map(r => r.id);
    assert.deepEqual(reading, ['a', 'b', 'd', 'c'], `reading order kept at ${cols} columns`);
  }
  assert.equal(scaledWidth(3, 8), 4);
  assert.equal(scaledWidth(6, 8), 4);
  assert.equal(scaledWidth(7, 8), 8);
  assert.equal(scaledWidth(1, 8), 4);
  assert.equal(scaledWidth(12, 4), 4);
  assert.equal(scaledWidth(3, 6), 3, 'half the row, not a squeezed third');
  assert.equal(scaledWidth(4, 6), 3);
  assert.equal(scaledWidth(6, 6), 3);
  assert.equal(scaledWidth(8, 6), 6, 'wider than half takes the row');
  assert.equal(scaledWidth(5, 2), 2);
  assert.equal(scaledWidth(3, 3), 3);
  assert.deepEqual(packForColumns(sample(), 12), settle(sample()));
});

test('packForColumns leaves no holes in the first-run board at 6 columns', () => {
  const seed = [
    ['clock', 0, 0, 3, 2], ['weather', 3, 0, 3, 2], ['quick', 6, 0, 6, 2], ['f1', 0, 2, 4, 3], ['f2', 4, 2, 4, 3], ['f3', 8, 2, 4, 3],
    ['notes', 0, 5, 4, 3], ['check', 4, 5, 4, 3], ['visited', 8, 5, 4, 2], ['sticky', 8, 7, 4, 1],
  ].map(([id, x, y, w, h]) => ({ id, x, y, w, h }));
  const packed = packForColumns(seed, 6);
  noOverlaps(packed);
  inBounds(packed, 6);
  assert.deepEqual(sortReadingIds(packed), sortReadingIds(seed), 'reading order kept');
  // No empty cell has a widget below it in the same column: columns only end raggedly at the bottom.
  const bottom = layoutBottom(packed);
  for (let x = 0; x < 6; x++) {
    let open = false;
    for (let y = 0; y < bottom; y++) {
      const covered = packed.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
      if (!covered) open = true;
      else assert.equal(open, false, `hole above row ${y} in column ${x}`);
    }
  }
  assert.ok(packed.every(r => r.w === 3), 'two widgets per row');
});

test('packForColumns widens a half-width widget left alone in its rows', () => {
  // 4 + 8 on 12 columns: the 8 takes the whole row at 6 columns, so the 4 would sit next to a hole.
  const narrowThenWide = packForColumns([{ id: 'cal', x: 0, y: 0, w: 4, h: 3 }, { id: 'lin', x: 4, y: 0, w: 8, h: 2 }], 6);
  assert.deepEqual(narrowThenWide.map(({ id, x, y, w }) => [id, x, y, w]), [['cal', 0, 0, 6], ['lin', 0, 3, 6]]);
  // An odd count: the last widget gets the row to itself.
  const three = packForColumns([0, 4, 8].map((x, i) => ({ id: `w${i}`, x, y: 0, w: 4, h: 2 })), 6);
  assert.deepEqual(three.map(({ id, x, y, w }) => [id, x, y, w]), [['w0', 0, 0, 3], ['w1', 3, 0, 3], ['w2', 0, 2, 6]]);
  // A half that shares any of its rows keeps its width.
  const staggered = packForColumns([{ id: 'a', x: 0, y: 0, w: 4, h: 2 }, { id: 'b', x: 4, y: 0, w: 4, h: 3 }, { id: 'c', x: 8, y: 0, w: 4, h: 2 }], 6);
  assert.deepEqual(staggered.map(({ id, x, y, w }) => [id, x, y, w]), [['a', 0, 0, 3], ['b', 3, 0, 3], ['c', 0, 2, 3]]);
  noOverlaps(staggered);
});

test('layoutChanges lists only moved or resized rects', () => {
  const next = moveWidget(sample(), 'd', { x: 0, y: 0 });
  assert.deepEqual(layoutChanges(sample(), next).map(r => r.id).sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(layoutChanges(sample(), sample()), []);
});

test('pixel helpers snap to cells', () => {
  const metrics = { cols: 12, colWidth: 80, rowHeight: 72, gap: 16 };
  assert.deepEqual(cellAt(0, 0, metrics), { x: 0, y: 0 });
  assert.deepEqual(cellAt(150, 100, metrics), { x: 2, y: 1 });
  assert.deepEqual(cellAt(5000, -50, metrics, 3), { x: 9, y: 0 });
  assert.equal(spanFor(80, 80, 16), 1);
  assert.equal(spanFor(176, 80, 16), 2);
  assert.equal(spanFor(10, 80, 16, 2), 2);
});
