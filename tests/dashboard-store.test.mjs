import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardStore, normalizeDashboard, normalizeWidget, portableDashboard, mergeDashboards } from '../extension/lib/dashboard-store.js';
import { collides } from '../extension/ui/dashboard/grid.js';

function memory(initial = null, seed = () => null) {
  let stored = initial ? structuredClone(initial) : null;
  let reads = 0, writes = 0;
  const store = createDashboardStore({
    read: async () => { reads++; return stored ? structuredClone(stored) : null; },
    write: async value => { writes++; stored = structuredClone(value); },
    seed,
  });
  return { store, get stored() { return stored; }, get reads() { return reads; }, get writes() { return writes; } };
}
const noOverlap = widgets => widgets.every((a, i) => widgets.every((b, j) => i === j || !collides(a, b)));

test('normalizeDashboard repairs anything into a valid state with one board', () => {
  for (const input of [null, undefined, 42, 'x', [], {}, { boards: 'nope' }, { boards: [null, 3] }]) {
    const state = normalizeDashboard(input);
    assert.equal(state.version, 1);
    assert.equal(state.boards.length, 1);
    assert.equal(state.boards[0].name, 'Main');
    assert.equal(state.activeBoardId, state.boards[0].id);
  }
  const state = normalizeDashboard({ activeBoardId: 'missing', boards: [{ id: 'a', name: 'A', widgets: [{ id: 'w', type: 'clock' }, { id: 'w', type: 'clock' }] }, { id: 'a', name: 'dupe' }] });
  assert.equal(state.boards.length, 1, 'duplicate board ids are dropped');
  assert.equal(state.boards[0].widgets.length, 1, 'duplicate widget ids are dropped');
  assert.equal(state.activeBoardId, 'a');
});

test('normalizeWidget clamps geometry, frames and config', () => {
  const input = { type: 'clock', x: 11, y: -2, w: 30, h: 0, style: { frame: 'neon', hideTitle: 'yes' }, config: [1, 2] };
  const widget = normalizeWidget(input, { strict: true });
  assert.deepEqual([widget.x, widget.y, widget.w, widget.h], [0, 0, 12, 1]);
  assert.deepEqual(widget.style, { frame: 'default', hideTitle: false }, 'a new widget from the UI only gets known frames');
  assert.deepEqual(widget.config, {});
  assert.match(widget.id, /^w_/);
  // A stored widget keeps a frame this build does not draw (a newer build's); the renderer falls back to the default look.
  assert.deepEqual(normalizeWidget(input).style, { frame: 'neon', hideTitle: false });
  assert.equal(normalizeWidget({ type: 'clock', style: { frame: '<b>' } }).style.frame, 'default', 'only a plain frame name is kept');
});

test('first load seeds once even with concurrent callers, later loads read storage', async () => {
  let seeds = 0;
  const env = memory(null, async () => { seeds++; return { boards: [{ id: 'main', name: 'Main', widgets: [{ id: 'c', type: 'clock', x: 0, y: 0, w: 3, h: 2 }] }] }; });
  const [a, b] = await Promise.all([env.store.load(), env.store.load()]);
  assert.equal(a, b);
  assert.equal(seeds, 1);
  assert.equal(env.writes, 1);
  assert.equal(env.reads, 1);
  assert.equal(env.stored.boards[0].widgets[0].type, 'clock');
  const again = memory(env.stored, () => { throw new Error('should not seed'); });
  assert.equal((await again.store.load()).boards[0].id, 'main');
});

test('a failing seed still yields an empty Main board, kept unsaved so the seed can run again', async () => {
  const env = memory(null, async () => { throw new Error('boom'); });
  const original = console.error;
  console.error = () => {};
  try {
    const state = await env.store.load();
    assert.equal(state.boards[0].widgets.length, 0);
    assert.equal(env.writes, 0, 'the empty board is not saved over a future first-run seed');
    assert.equal(env.store.isPlaceholder(), true);
  } finally { console.error = original; }
});

test('widgets: add places in a free spot, update, config merge, layout, duplicate, remove and restore', async () => {
  const env = memory({ boards: [{ id: 'main', name: 'Main', widgets: [{ id: 'a', type: 'clock', x: 0, y: 0, w: 6, h: 2 }] }] });
  const { store } = env;
  await store.load();
  const added = await store.addWidget('main', { type: 'notes', w: 6, h: 3, config: { limit: 4 } });
  assert.deepEqual([added.x, added.y], [6, 0], 'first free spot');
  const explicit = await store.addWidget('main', { type: 'kanban', x: 0, y: 5, w: 4, h: 3 });
  assert.deepEqual([explicit.x, explicit.y], [0, 5], 'explicit position is kept');
  await store.updateWidget(added.id, { title: 'Reading', style: { hideTitle: true }, config: { sort: 'updated' } });
  await store.updateWidgetConfig(added.id, { limit: 6 });
  const { widget } = store.findWidget(added.id);
  assert.equal(widget.title, 'Reading');
  assert.deepEqual(widget.style, { frame: 'default', hideTitle: true });
  assert.deepEqual(widget.config, { limit: 6, sort: 'updated' });

  await store.applyLayout('main', [{ id: 'a', x: 0, y: 2, w: 3, h: 2 }, { id: 'ghost', x: 1, y: 1, w: 1, h: 1 }]);
  assert.deepEqual((({ x, y, w, h }) => [x, y, w, h])(store.findWidget('a').widget), [0, 2, 3, 2]);

  const copy = await store.duplicateWidget(added.id);
  assert.notEqual(copy.id, added.id);
  assert.deepEqual(copy.config, { limit: 6, sort: 'updated' });
  assert.ok(noOverlap(store.activeBoard().widgets), 'duplicate does not overlap');

  const removed = await store.removeWidget(added.id);
  assert.equal(store.findWidget(added.id), null);
  await store.restoreWidget(removed.boardId, removed.widget);
  assert.equal(store.findWidget(added.id).widget.title, 'Reading');
  await store.restoreWidget(removed.boardId, removed.widget);
  assert.equal(store.activeBoard().widgets.filter(w => w.id === added.id).length, 1, 'restore is idempotent');
  await assert.rejects(store.updateWidget('missing', { title: 'x' }), /no longer on your dashboard/);
});

test('restoring into an occupied spot moves the widget to a free one', async () => {
  const env = memory({ boards: [{ id: 'main', widgets: [{ id: 'a', type: 'clock', x: 0, y: 0, w: 4, h: 2 }] }] });
  await env.store.load();
  const removed = await env.store.removeWidget('a');
  await env.store.addWidget('main', { id: 'b', type: 'notes', x: 0, y: 0, w: 4, h: 2 });
  await env.store.restoreWidget(removed.boardId, removed.widget);
  assert.ok(noOverlap(env.store.activeBoard().widgets));
});

test('boards: add, rename, reorder, switch, move widgets between boards, remove and restore', async () => {
  const env = memory({ boards: [{ id: 'main', name: 'Main', widgets: [{ id: 'a', type: 'clock', x: 0, y: 0, w: 3, h: 2 }] }] });
  const { store } = env;
  await store.load();
  const work = await store.addBoard({ name: 'Work', icon: 'briefcase' });
  assert.equal(store.get().activeBoardId, work.id, 'a new board becomes active');
  await store.updateBoard(work.id, { name: 'Work stuff' });
  await store.moveBoard(work.id, 0);
  assert.deepEqual(store.get().boards.map(b => b.name), ['Work stuff', 'Main']);
  await store.setActiveBoard('main');
  await store.moveWidgetToBoard('a', work.id);
  assert.equal(store.findWidget('a').board.id, work.id);
  assert.equal(store.get().boards.find(b => b.id === 'main').widgets.length, 0);
  const snapshot = structuredClone(store.get().boards.find(b => b.id === work.id));
  await store.removeBoard(work.id);
  assert.equal(store.get().boards.length, 1);
  await assert.rejects(store.removeBoard('main'), /at least one/);
  await store.restoreBoard(snapshot, 0);
  assert.deepEqual(store.get().boards.map(b => b.id), [work.id, 'main']);
  assert.equal(store.get().activeBoardId, work.id);
  await store.setPrefs({ stickiesHidden: true });
  assert.equal(env.stored.prefs.stickiesHidden, true, 'every change is persisted');
});

test('subscribers hear every change and replace() adopts another view’s state', async () => {
  const env = memory({ boards: [{ id: 'main', widgets: [] }] });
  await env.store.load();
  const seen = [];
  const off = env.store.subscribe(state => seen.push(state.boards[0].widgets.length));
  await env.store.addWidget('main', { type: 'clock' });
  await env.store.replace({ boards: [{ id: 'other', name: 'Other', widgets: [] }] });
  off();
  await env.store.addWidget('other', { type: 'clock' });
  assert.deepEqual(seen, [1, 0]);
  assert.equal(env.store.activeBoard().id, 'other');
});

test('portable dashboards drop credential-like keys and merge by board id', () => {
  const state = { activeBoardId: 'b2', boards: [
    { id: 'b1', name: 'One', widgets: [{ id: 'w1', type: 'github', config: { owner: 'me', token: 'ghp_secret', nested: { apiKey: 'x', keep: 1 }, list: [{ password: 'p', label: 'ok' }] } }] },
    { id: 'b2', name: 'Two', widgets: [] },
  ], prefs: { stickiesHidden: true, secretThing: 'x' } };
  const portable = portableDashboard(state);
  assert.deepEqual(portable.boards[0].widgets[0].config, { owner: 'me', nested: { keep: 1 }, list: [{ label: 'ok' }] });
  assert.deepEqual(portable.prefs, { stickiesHidden: true });

  const current = { activeBoardId: 'b1', boards: [{ id: 'b1', name: 'Local one', widgets: [] }, { id: 'local', name: 'Local only', widgets: [] }], prefs: { a: 1 } };
  const { state: merged, boards } = mergeDashboards(current, state);
  assert.equal(boards, 2);
  assert.deepEqual(merged.boards.map(b => [b.id, b.name]), [['b1', 'One'], ['local', 'Local only'], ['b2', 'Two']]);
  assert.equal(merged.activeBoardId, 'b2');
  assert.deepEqual(merged.prefs, { a: 1, stickiesHidden: true });
  assert.equal(merged.boards[0].widgets[0].config.token, undefined);
});

test('a backup never switches on website embedding', () => {
  const state = normalizeDashboard({ boards: [{ id: 'b', name: 'Home', widgets: [
    { id: 'w1', type: 'embed', x: 0, y: 0, w: 4, h: 3, config: { url: 'https://grafana.example.com', allowFraming: true, zoom: 90 } },
    { id: 'w2', type: 'notes', x: 4, y: 0, w: 3, h: 3, config: { allowFraming: true } },
  ] }] });
  const [embed, notes] = portableDashboard(state).boards[0].widgets;
  assert.equal(embed.config.allowFraming, false);
  assert.equal(embed.config.zoom, 90, 'other settings survive');
  assert.equal(notes.config.allowFraming, true, 'only website widgets are affected');
  const merged = mergeDashboards(normalizeDashboard({}), state).state;
  assert.equal(merged.boards.find(b => b.id === 'b').widgets.find(w => w.id === 'w1').config.allowFraming, false);
});

test('restoring an older backup never removes widgets or rolls back a dashboard saved since', () => {
  const backup = { updatedAt: '2026-10-01T00:00:00.000Z', activeBoardId: 'main', boards: [{ id: 'main', name: 'Main', widgets: [{ id: 'w_clock', type: 'clock', x: 0, y: 0, w: 3, h: 2 }] }] };
  const local = { updatedAt: '2026-10-20T00:00:00.000Z', activeBoardId: 'main', boards: [{ id: 'main', name: 'Main', widgets: [
    { id: 'w_clock', type: 'clock', x: 0, y: 0, w: 3, h: 2 },
    { id: 'w_links', type: 'quick-links', x: 3, y: 0, w: 4, h: 2, config: { links: [{ id: 'ql_1', title: 'Mine', url: 'https://example.com/' }] } }] }] };
  const newer = mergeDashboards(local, backup);
  assert.equal(newer.kept, 1);
  assert.equal(newer.boards, 0);
  assert.deepEqual(newer.state.boards[0].widgets.map(w => w.id), ['w_clock', 'w_links'], 'this device saved later: its board stays');
  assert.equal(newer.state.boards[0].widgets[1].config.links[0].title, 'Mine');
  // A backup newer than this device wins the board, but widgets only this device has stay, placed without overlap.
  const older = mergeDashboards({ ...local, updatedAt: '2026-09-01T00:00:00.000Z' }, backup);
  assert.equal(older.kept, 0);
  const widgets = older.state.boards[0].widgets;
  assert.deepEqual(widgets.map(w => w.id), ['w_clock', 'w_links']);
  assert.equal(widgets[1].config.links[0].title, 'Mine');
  assert.ok(widgets[1].y >= 2 || widgets[1].x >= 3, 'no overlap with the clock');
});
