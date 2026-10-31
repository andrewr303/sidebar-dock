import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedDashboard, linkCollections, checklistNote, isValidLayout } from '../extension/lib/dashboard-seed.js';
import { SEED_LIBRARY } from '../extension/lib/seed.js';
import { normalizeDashboard } from '../extension/lib/dashboard-store.js';
import { collides, layoutBottom } from '../extension/ui/dashboard/grid.js';

const TYPES = ['clock', 'weather', 'quick-links', 'links-folder', 'notes', 'checklist', 'most-visited', 'sticky-notes'];
const defs = (overrides = {}) => Object.fromEntries(TYPES.map(type => [type, {
  type, size: { w: 3, h: 3, minW: 1, minH: 1, maxW: 12, maxH: 12, ...(overrides[type] || {}) },
  defaults: () => ({ fromDefaults: type }),
}]));

const check = state => {
  const widgets = state.boards[0].widgets;
  for (const a of widgets) {
    assert.ok(a.x >= 0 && a.x + a.w <= 12, `${a.type} fits 12 columns`);
    for (const b of widgets) if (a !== b) assert.equal(collides(a, b), false, `${a.type} overlaps ${b.type}`);
  }
  assert.ok(isValidLayout(state));
};

test('the seed board uses the library: link collections, a checklist note and every core widget', () => {
  const lookup = defs();
  const state = buildSeedDashboard({ library: SEED_LIBRARY, getDef: type => lookup[type] });
  check(state);
  const board = state.boards[0];
  assert.equal(board.name, 'Main');
  assert.equal(state.activeBoardId, board.id);
  const types = board.widgets.map(w => w.type);
  for (const type of TYPES) assert.ok(types.includes(type), `${type} is on the seed board`);
  const folders = board.widgets.filter(w => w.type === 'links-folder');
  assert.equal(folders.length, 3);
  assert.deepEqual(folders.map(w => w.config.collectionId), linkCollections(SEED_LIBRARY).map(e => e.collection.id));
  assert.equal(folders[0].config.collectionId, 'ai', 'the collection with the most links comes first');
  assert.equal(folders[0].config.fromDefaults, 'links-folder', 'defaults are merged under the seed config');
  const checklist = board.widgets.find(w => w.type === 'checklist');
  assert.equal(checklist.config.noteId, checklistNote(SEED_LIBRARY).id);
  assert.ok(layoutBottom(board.widgets) <= 8, 'fits a 1440×900 new tab (8 rows)');
  assert.deepEqual(normalizeDashboard(state).boards[0].widgets.map(w => [w.x, w.y, w.w, w.h]), board.widgets.map(w => [w.x, w.y, w.w, w.h]), 'already normalized');
});

test('size limits from the definitions are respected without overlaps', () => {
  const lookup = defs({ clock: { minW: 4, minH: 3 }, 'quick-links': { maxW: 4, maxH: 1 }, notes: { minW: 6 }, 'sticky-notes': { minH: 2 } });
  const state = buildSeedDashboard({ library: SEED_LIBRARY, getDef: type => lookup[type] });
  check(state);
  const by = type => state.boards[0].widgets.find(w => w.type === type);
  assert.ok(by('clock').w >= 4 && by('clock').h >= 3);
  assert.ok(by('quick-links').w <= 4 && by('quick-links').h <= 1);
  assert.ok(by('notes').w >= 6);
});

test('missing widget types and an empty library still give a tidy board', () => {
  const lookup = defs();
  delete lookup['most-visited'];
  const state = buildSeedDashboard({ library: { items: [], collections: [] }, getDef: type => lookup[type] });
  check(state);
  const types = state.boards[0].widgets.map(w => w.type);
  assert.ok(!types.includes('links-folder'), 'no folders without link collections');
  assert.ok(!types.includes('most-visited'));
  assert.equal(state.boards[0].widgets.find(w => w.type === 'checklist').config.noteId, undefined);
  assert.equal(buildSeedDashboard({ getDef: () => null }).boards[0].widgets.length, 0);
});

test('linkCollections ignores trashed, archived and note items and needs at least two links', () => {
  const library = {
    collections: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C', parentId: 'a' }],
    items: [
      { id: '1', type: 'bookmark', url: 'https://a.com', collectionId: 'a' },
      { id: '2', type: 'bookmark', url: 'https://b.com', collectionId: 'a' },
      { id: '3', type: 'bookmark', url: 'https://c.com', collectionId: 'b', deletedAt: '2024-01-01T00:00:00Z' },
      { id: '4', type: 'note', url: 'https://d.com', collectionId: 'b' },
      { id: '5', type: 'bookmark', url: 'https://e.com', collectionId: 'b' },
      { id: '6', type: 'bookmark', url: 'https://f.com', collectionId: 'c' },
      { id: '7', type: 'article', url: 'https://g.com', collectionId: 'c' },
      { id: '8', type: 'bookmark', url: 'https://h.com', collectionId: 'c', archived: true },
    ],
  };
  assert.deepEqual(linkCollections(library).map(e => [e.collection.id, e.count]), [['a', 2], ['c', 2]], 'root collections first on ties');
  assert.equal(checklistNote(library), null);
});
