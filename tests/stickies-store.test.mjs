import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryStore, normalizeItem, normalizeSticky, queryItems, STICKY_COLORS, STICKY_DEFAULTS, STICKY_LIMITS } from '../extension/lib/store.js';

function fixture() {
  let value;
  const store = createLibraryStore({ read: async () => (value ? structuredClone(value) : null), write: async state => { value = structuredClone(state); } });
  return { call: (name, ...args) => store.dispatch(name, args) };
}

test('plain notes and every other item type have no sticky placement', () => {
  assert.equal(normalizeItem({ type: 'note', content: 'Plain' }).sticky, null);
  assert.equal(normalizeItem({ type: 'note', content: 'Plain', sticky: false }).sticky, null);
  assert.equal(normalizeItem({ type: 'note', content: 'Plain', sticky: [1, 2] }).sticky, null);
  assert.equal(normalizeItem({ type: 'bookmark', url: 'https://example.com', sticky: { color: 'pink' } }).sticky, null);
  assert.equal(normalizeSticky({ color: 'pink' }, 'article'), null);
});

test('a sticky placement fills defaults and keeps valid values', () => {
  assert.deepEqual(normalizeItem({ type: 'note', sticky: {} }).sticky, { ...STICKY_DEFAULTS });
  const item = normalizeItem({ type: 'note', content: 'Hi', sticky: { color: 'purple', board: ' board_1 ', x: 0.25, y: 140.4, w: 300, h: 260, z: 7, hidden: true } });
  assert.deepEqual(item.sticky, { color: 'purple', board: 'board_1', x: 0.25, y: 140, w: 300, h: 260, z: 7, hidden: true });
  for (const color of STICKY_COLORS) assert.equal(normalizeSticky({ color }).color, color);
});

test('sticky values are clamped to the layout limits and invalid values fall back', () => {
  const wild = normalizeSticky({ color: 'chartreuse', board: 42, x: 3, y: -50, w: 20, h: 9000, z: -4, hidden: 'yes' });
  assert.deepEqual(wild, { color: 'yellow', board: '', x: 1, y: 0, w: STICKY_LIMITS.minW, h: STICKY_LIMITS.maxH, z: 0, hidden: false });
  const junk = normalizeSticky({ x: 'left', y: null, w: '', h: undefined, z: NaN });
  assert.equal(junk.x, STICKY_DEFAULTS.x);
  assert.equal(junk.y, STICKY_DEFAULTS.y);
  assert.equal(junk.w, STICKY_DEFAULTS.w);
  assert.equal(junk.h, STICKY_DEFAULTS.h);
  assert.equal(junk.z, 0);
  assert.equal(normalizeSticky({ x: -0.2 }).x, 0);
  assert.equal(normalizeSticky({ x: 0.123456 }).x, 0.1235);
  assert.equal(normalizeSticky({ w: 999 }).w, STICKY_LIMITS.maxW);
  assert.equal(normalizeSticky({ h: 1 }).h, STICKY_LIMITS.minH);
  assert.equal(normalizeSticky({ y: 1e9 }).y, STICKY_LIMITS.maxY);
  assert.equal(normalizeSticky({ board: 'b'.repeat(500) }).board.length, 120);
});

test('updating a sticky merges a partial placement, and null turns it back into a plain note', async () => {
  const { call } = fixture();
  const note = await call('saveItem', { type: 'note', content: 'Buy milk', sticky: { color: 'green', x: 0.1, y: 80, w: 200, h: 160, z: 2 } });
  const moved = await call('updateItem', note.id, { sticky: { x: 0.5, y: 300 } });
  assert.deepEqual(moved.sticky, { color: 'green', board: '', x: 0.5, y: 300, w: 200, h: 160, z: 2, hidden: false });
  const recolored = await call('updateItem', note.id, { sticky: { color: 'blue', hidden: true } });
  assert.equal(recolored.sticky.color, 'blue');
  assert.equal(recolored.sticky.hidden, true);
  assert.equal(recolored.sticky.x, 0.5);
  // Content edits leave the placement alone.
  const edited = await call('updateItem', note.id, { content: 'Buy oat milk' });
  assert.deepEqual(edited.sticky, recolored.sticky);
  const plain = await call('updateItem', note.id, { sticky: null });
  assert.equal(plain.sticky, null);
  // A patch on a plain note starts from the defaults.
  const again = await call('updateItem', note.id, { sticky: { color: 'pink' } });
  assert.deepEqual(again.sticky, { ...STICKY_DEFAULTS, color: 'pink' });
});

test('bulk updates and trash keep the placement; sticky notes stay searchable notes', async () => {
  const { call } = fixture();
  const note = await call('saveItem', { type: 'note', content: 'Quarterly taxes due', sticky: { color: 'orange', y: 40 } });
  await call('saveItem', { type: 'note', content: 'Quarterly review' });
  const [bulk] = await call('bulkUpdateItems', [{ id: note.id, patch: { tags: ['money'] } }]);
  assert.equal(bulk.sticky.color, 'orange');
  const trashed = await call('deleteItem', note.id);
  assert.equal(trashed.sticky.color, 'orange');
  const restored = await call('restoreItem', note.id);
  assert.equal(restored.sticky.y, 40);
  const state = await call('loadLibrary');
  assert.deepEqual(queryItems(state, { query: 'taxes type:note' }).map(i => i.id), [note.id]);
  assert.equal(queryItems(state, { query: 'quarterly' }).length, 2);
});

test('imports keep sticky placements and normalize broken ones', async () => {
  const { call } = fixture();
  await call('importLibrary', { items: [
    { id: 'n1', type: 'note', title: 'A', content: 'A', sticky: { color: 'blue', x: 0.4, y: 10, w: 250, h: 200, z: 3, board: 'b1' } },
    { id: 'n2', type: 'note', title: 'B', content: 'B', sticky: { color: 'nope', x: 7 } },
    { id: 'l1', type: 'bookmark', url: 'https://example.com', sticky: { color: 'blue' } },
  ], collections: [] });
  const state = await call('loadLibrary');
  const byId = Object.fromEntries(state.items.map(i => [i.id, i]));
  assert.deepEqual(byId.n1.sticky, { color: 'blue', board: 'b1', x: 0.4, y: 10, w: 250, h: 200, z: 3, hidden: false });
  assert.equal(byId.n2.sticky.color, 'yellow');
  assert.equal(byId.n2.sticky.x, 1);
  assert.equal(byId.l1.sticky, null);
});

test('placement keys written by another build survive moves and edits; keys sent only by the UI do not', async () => {
  let value = { schemaVersion: 1, settings: {}, collections: [], items: [{ id: 's', type: 'note', title: 'S', content: 'S',
    sticky: { color: 'pink', x: 0.3, y: 10, w: 200, h: 160, z: 1, hidden: false, rotation: 4 } }] };
  const store = createLibraryStore({ read: async () => structuredClone(value), write: async state => { value = structuredClone(state); } });
  const moved = await store.dispatch('updateItem', ['s', { sticky: { x: 0.6, dragGhost: true } }]);
  assert.equal(moved.sticky.rotation, 4);
  assert.equal(moved.sticky.x, 0.6);
  assert.equal(moved.sticky.dragGhost, undefined);
  assert.equal((await store.dispatch('updateItem', ['s', { content: 'Edited' }])).sticky.rotation, 4);
  assert.equal(normalizeSticky({ color: 'blue', rotation: 9 }).rotation, undefined, 'without a stored placement nothing unknown is kept');
});
