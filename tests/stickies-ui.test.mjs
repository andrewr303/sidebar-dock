import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItem, STICKY_DEFAULTS, STICKY_LIMITS } from '../extension/lib/store.js';
import {
  liveStickies, boardStickies, onBoard, leftFor, fractionFor, clampPlacement, clampResize, nextZ, placeNewSticky, newStickyInput,
  stickyTitleAfterEdit, stickyName, filterStickies, stickyPlainText, createSticky, shownWidth,
} from '../extension/ui/stickies.js';
import { stickyWidgetLayout, stickySummary } from '../extension/ui/widgets/sticky-notes.js';

let seq = 0;
const sticky = (sticky = {}, extra = {}) => normalizeItem({ id: `n${++seq}`, type: 'note', content: extra.content ?? `Note ${seq}`, createdAt: extra.createdAt
  || new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString(), sticky, ...extra });

test('live stickies keep a stable creation order and skip trashed, archived and plain notes', () => {
  const a = sticky({}, { createdAt: '2026-01-02T00:00:00.000Z' });
  const b = sticky({}, { createdAt: '2026-01-01T00:00:00.000Z' });
  const plain = normalizeItem({ id: 'p', type: 'note', content: 'plain' });
  const gone = { ...sticky(), deletedAt: '2026-01-03T00:00:00.000Z' };
  const archived = { ...sticky(), archived: true };
  assert.deepEqual(liveStickies([a, plain, gone, b, archived]).map(n => n.id), [b.id, a.id]);
});

test('board filtering: every-board notes show everywhere, hidden notes nowhere', () => {
  const all = sticky({ board: '' });
  const mine = sticky({ board: 'b1' });
  const other = sticky({ board: 'b2' });
  const hidden = sticky({ board: 'b1', hidden: true });
  assert.deepEqual(boardStickies([all, mine, other, hidden], 'b1').map(n => n.id), [all.id, mine.id]);
  assert.equal(onBoard({ board: '' }, 'anything'), true);
  assert.equal(onBoard({ board: 'b2' }, 'b1'), false);
});

test('x converts between a share of the stage and a left edge that stays inside it', () => {
  assert.equal(leftFor(0.5, 200, 1000), 500);
  assert.equal(leftFor(0.95, 200, 1000), 800);
  assert.equal(leftFor(-1, 200, 1000), 0);
  assert.equal(leftFor(0.5, 400, 300), 0);
  assert.equal(shownWidth(400, 300), 300);
  assert.equal(fractionFor(250, 1000), 0.25);
  assert.equal(fractionFor(1500, 1000), 1);
  assert.equal(fractionFor(100, 0), 0);
  // A note dragged against the right edge keeps that edge on a narrower stage.
  const x = fractionFor(800, 1000);
  assert.equal(leftFor(x, 200, 900), 700);
});

test('placement and resize clamps keep notes on the stage and within the size limits', () => {
  assert.deepEqual(clampPlacement({ left: -40, y: -10, w: 240, h: 200 }, 1000), { left: 0, y: 0, w: 240, h: 200 });
  assert.deepEqual(clampPlacement({ left: 900, y: 50, w: 240, h: 200 }, 1000), { left: 760, y: 50, w: 240, h: 200 });
  assert.deepEqual(clampPlacement({ left: 10, y: 20, w: 10, h: 9999 }, 1000), { left: 10, y: 20, w: STICKY_LIMITS.minW, h: STICKY_LIMITS.maxH });
  assert.equal(clampPlacement({ left: 50, y: 0, w: 400 }, 300).left, 0);
  assert.deepEqual(clampResize({ left: 700, w: 500, h: 100 }, 1000), { w: 300, h: STICKY_LIMITS.minH });
  assert.deepEqual(clampResize({ left: 0, w: 900, h: 700 }, 2000), { w: STICKY_LIMITS.maxW, h: STICKY_LIMITS.maxH });
  assert.equal(clampResize({ left: 950, w: 300, h: 200 }, 1000).w, STICKY_LIMITS.minW);
});

test('nextZ raises above every other note and ignores the note itself', () => {
  assert.equal(nextZ([]), 0);
  assert.equal(nextZ([sticky({ z: 3 }), sticky({ z: 9 })]), 10);
  const top = sticky({ z: 12 });
  assert.equal(nextZ([sticky({ z: 4 }), top], top.id), 5);
  assert.equal(nextZ([{ id: 'x', z: STICKY_LIMITS.maxZ }]), STICKY_LIMITS.maxZ);
});

test('new notes land near the top inline-end corner and fan out past occupied spots', () => {
  const first = placeNewSticky([], { stageWidth: 1000, top: 30, w: 240 });
  assert.deepEqual(first, { x: 0.736, y: 30 });
  const second = placeNewSticky([{ sticky: { ...first, w: 240 } }], { stageWidth: 1000, top: 30, w: 240 });
  assert.deepEqual(second, { x: 0.708, y: 58 });
  const third = placeNewSticky([{ sticky: { ...first, w: 240 } }, { sticky: { ...second, w: 240 } }], { stageWidth: 1000, top: 30, w: 240 });
  assert.deepEqual(third, { x: 0.68, y: 86 });
  // A narrow stage still yields a valid spot.
  const narrow = placeNewSticky([], { stageWidth: 200, top: 0, w: 240 });
  assert.deepEqual(narrow, { x: 0, y: 0 });
});

test('newStickyInput and createSticky defaults', async () => {
  const input = newStickyInput({ content: 'Pick up keys\nFrom the office' });
  assert.equal(input.type, 'note');
  assert.equal(input.title, 'Pick up keys');
  assert.equal(input.excerpt.startsWith('Pick up keys'), true);
  assert.deepEqual(input.sticky, { color: 'yellow', board: '', x: STICKY_DEFAULTS.x, y: STICKY_DEFAULTS.y, w: STICKY_DEFAULTS.w, h: STICKY_DEFAULTS.h, z: 0, hidden: false });
  assert.equal(newStickyInput({ color: 'teal' }).sticky.color, 'yellow');

  const saved = [];
  const existing = [sticky({ z: 4, x: 0.736, y: 24 })];
  const ctx = {
    state: { view: 'stickies', stickies: { query: 'old search', color: 'blue', show: 'hidden' } },
    env: {},
    select: { live: () => existing },
    store: { saveItem: async value => { saved.push(value); return normalizeItem(value); } },
    render() {},
  };
  const item = await createSticky(ctx, { content: 'Hello' });
  assert.equal(item.type, 'note');
  assert.equal(item.title, 'Hello');
  assert.equal(item.sticky.color, 'blue', 'uses the corkboard color filter');
  assert.equal(item.sticky.board, '', 'outside the dashboard a note shows on every board');
  assert.equal(item.sticky.z, 5);
  assert.equal(item.sticky.hidden, false);
  assert.deepEqual(ctx.state.stickies, { query: '', color: 'blue', show: 'all' }, 'filters that would hide the new note are cleared');
  const onBoard = await createSticky(ctx, { boardId: 'board_2', color: 'pink', x: 0.1, y: 300, focus: false });
  assert.deepEqual([onBoard.sticky.board, onBoard.sticky.color, onBoard.sticky.x, onBoard.sticky.y], ['board_2', 'pink', 0.1, 300]);
  assert.equal(saved.length, 2);
  // An empty note gets the store's untitled name and an empty excerpt.
  const empty = await createSticky({ ...ctx, state: { view: 'all' } }, {});
  assert.equal(empty.content, '');
  assert.equal(empty.sticky.color, 'yellow');
});

test('createSticky opens the Sticky notes view from a full tab that shows no sticky notes', async () => {
  const visits = [];
  const make = (view, env = {}) => ({
    state: { view }, env, select: { live: () => [] }, library: { settings: {} },
    store: { saveItem: async value => normalizeItem(value) }, render() {}, toast() {}, navigate: next => visits.push(next),
  });
  await createSticky(make('all'));
  assert.deepEqual(visits, ['stickies'], 'All items has no sticky surface: the corkboard opens');
  await createSticky(make('stickies'));
  await createSticky(make('dashboard'));
  await createSticky(make('inbox'), { focus: false });
  assert.deepEqual(visits, ['stickies'], 'the dashboard and the corkboard show the note where it is; focus: false stays put');
});

test('a new sticky takes focus even when its editor mounted before the save returned', async () => {
  const saved = globalThis.document;
  const savedCss = globalThis.CSS;
  const focused = [];
  const editors = [];
  const area = id => ({ dataset: { stickyText: id }, offsetParent: {}, value: '', closest: () => null, focus() { focused.push(id); }, setSelectionRange() {} });
  globalThis.CSS = { escape: value => String(value) };
  globalThis.document = { querySelectorAll: selector => editors.filter(el => selector.includes(`"${el.dataset.stickyText}"`)) };
  try {
    const ctx = {
      state: { view: 'stickies' }, env: {}, select: { live: () => [] }, render() {},
      // The library's change event wins the race: the editor is on the page before saveItem resolves.
      store: { saveItem: async value => { const item = normalizeItem({ ...value, id: 'race-1' }); editors.push(area(item.id)); return item; } },
    };
    await createSticky(ctx);
    assert.deepEqual(focused, ['race-1']);
  } finally {
    globalThis.document = saved;
    globalThis.CSS = savedCss;
  }
});

test('a sticky keeps its first line as the title unless it was given a title of its own', () => {
  const note = { title: 'Groceries', content: 'Groceries\nEggs' };
  assert.equal(stickyTitleAfterEdit(note, 'Shopping\nEggs'), 'Shopping');
  assert.equal(stickyTitleAfterEdit({ title: 'Untitled note', content: '' }, 'First words'), 'First words');
  assert.equal(stickyTitleAfterEdit({ title: 'My list', content: 'Eggs' }, 'Milk'), null);
  assert.equal(stickyTitleAfterEdit({ title: 'Plan', content: 'Plan' }, ''), '');
  assert.equal(stickyName({ title: 'Untitled note', content: '' }), 'Empty sticky note');
  assert.equal(stickyName({ title: 'Untitled note', content: '## Call Sam\nlater' }), 'Call Sam');
});

test('corkboard filter matches text, color and where a note shows', () => {
  const notes = [
    sticky({ color: 'yellow' }, { content: 'Dentist on Friday' }),
    sticky({ color: 'pink', hidden: true }, { content: 'Taxes' }),
    sticky({ color: 'pink' }, { content: 'Call the dentist back' }),
  ];
  assert.equal(filterStickies(notes, { query: 'dentist' }).length, 2);
  assert.equal(filterStickies(notes, { query: 'DENTIST friday' }).length, 1);
  assert.equal(filterStickies(notes, { color: 'pink' }).length, 2);
  assert.equal(filterStickies(notes, { color: 'pink', show: 'shown' }).length, 1);
  assert.deepEqual(filterStickies(notes, { show: 'hidden' }).map(n => n.content), ['Taxes']);
  assert.equal(filterStickies(notes, {}).length, 3);
});

test('plain previews drop Markdown markers and keep lines', () => {
  assert.equal(stickyPlainText('Ship it\n- [ ] Polish **icons**\n- [x] Tests\n## Later\n\n\n* one [link](https://example.com)'),
    'Ship it\n☐ Polish icons\n☑ Tests\nLater\n\n• one link');
  assert.equal(stickyPlainText('a'.repeat(300), 20).length, 20);
  assert.equal(stickyPlainText('a'.repeat(300), 20).endsWith('…'), true);
  assert.equal(stickyPlainText(''), '');
});

test('widget layout and summary by size and counts', () => {
  assert.equal(stickyWidgetLayout(4, 1), 'bar');
  assert.equal(stickyWidgetLayout(2, 1), 'bar');
  assert.equal(stickyWidgetLayout(3, 2), 'tile');
  assert.equal(stickyWidgetLayout(2, 4), 'tile');
  assert.equal(stickyWidgetLayout(4, 4), 'board');
  assert.equal(stickySummary({}), 'None on this board yet');
  assert.equal(stickySummary({ shown: 1 }), '1 note on this board');
  assert.equal(stickySummary({ shown: 3, hidden: 2 }), '3 notes on this board · 2 hidden');
  assert.equal(stickySummary({ shown: 0, hidden: 2 }), 'None showing · 2 hidden');
  assert.equal(stickySummary({ shown: 2, hidden: 1, layerOn: false }), '3 notes, hidden on the dashboard');
});
