import test from 'node:test';
import assert from 'node:assert/strict';
import { createFullBackup, importPortableFile } from '../extension/lib/portability.js';
import { createLibraryStore } from '../extension/lib/store.js';
import { createDashboardStore, portableDashboard, mergeDashboards } from '../extension/lib/dashboard-store.js';

function libraryAdapter(seed = { schemaVersion: 1, items: [], collections: [], settings: {} }) {
  let library = structuredClone(seed);
  const core = createLibraryStore({ read: async () => library, write: async value => { library = value; } });
  return {
    store: {
      exportLibrary: () => core.dispatch('exportLibrary'), importLibrary: value => core.dispatch('importLibrary', [value]),
      async getAttachment() { return null; }, async saveAttachment() { throw new Error('no files here'); }, async deleteAttachment() {},
    },
    get library() { return library; },
  };
}

// A dashboard source backed by an in-memory dashboard store (the shape lib/dashboard-store.js dashboardBackupSource returns).
function dashboardSource(initial) {
  let stored = structuredClone(initial);
  const store = createDashboardStore({ read: async () => stored, write: async value => { stored = structuredClone(value); } });
  return {
    exportDashboard: async () => portableDashboard(await store.load()),
    async importDashboard(incoming) {
      const { state, boards } = mergeDashboards(await store.load(), incoming);
      await store.replace(state, { persist: true });
      return { boards };
    },
    get stored() { return stored; },
  };
}

const library = () => ({ schemaVersion: 1, collections: [{ id: 'reading', name: 'Reading' }], settings: {},
  items: [{ id: 'a', type: 'bookmark', title: 'A', url: 'https://example.com/a', collectionId: 'reading' }] });
const dashboard = () => ({ activeBoardId: 'work', prefs: { stickiesHidden: false }, boards: [
  { id: 'main', name: 'Main', icon: 'house', widgets: [{ id: 'w_folder', type: 'links-folder', x: 0, y: 0, w: 4, h: 3, config: { collectionId: 'reading' } }] },
  { id: 'work', name: 'Work', icon: 'briefcase', widgets: [{ id: 'w_gh', type: 'github', x: 0, y: 0, w: 6, h: 4, title: 'PRs', config: { orgs: ['acme'], token: 'ghp_never_exported' } }] },
] });
const jsonFile = value => new File([JSON.stringify(value)], 'still-backup.json', { type: 'application/json' });

test('a full backup carries the dashboard without credentials and restores it into another device', async () => {
  const sourceLibrary = libraryAdapter(library());
  const sourceDashboard = dashboardSource(dashboard());
  const backup = await createFullBackup(sourceLibrary.store, { dashboard: sourceDashboard });
  assert.equal(backup.dashboard.boards.length, 2);
  assert.equal(backup.dashboard.boards[1].widgets[0].config.token, undefined);
  assert.deepEqual(backup.dashboard.boards[1].widgets[0].config.orgs, ['acme']);
  assert.ok(!JSON.stringify(backup).includes('ghp_never_exported'));

  const targetLibrary = libraryAdapter();
  const targetDashboard = dashboardSource({ activeBoardId: 'local', boards: [{ id: 'local', name: 'Home', widgets: [{ id: 'w_clock', type: 'clock', x: 0, y: 0, w: 3, h: 2 }] }] });
  const result = await importPortableFile(jsonFile(backup), targetLibrary.store, { dashboard: targetDashboard });
  assert.equal(result.items, 1);
  assert.equal(result.boards, 2);
  assert.deepEqual(result.warnings, []);
  assert.equal(targetLibrary.library.dashboard, undefined, 'the dashboard never lands in the library');
  assert.deepEqual(targetDashboard.stored.boards.map(b => b.id), ['local', 'main', 'work'], 'local boards are kept, backup boards added');
  assert.equal(targetDashboard.stored.activeBoardId, 'work');
  assert.equal(targetDashboard.stored.boards[1].widgets[0].config.collectionId, 'reading');
});

test('restoring the same backup twice replaces boards by id instead of duplicating them', async () => {
  const backup = await createFullBackup(libraryAdapter(library()).store, { dashboard: dashboardSource(dashboard()) });
  const target = dashboardSource({ boards: [{ id: 'main', name: 'Old main', widgets: [] }] });
  await importPortableFile(jsonFile(backup), libraryAdapter().store, { dashboard: target });
  await importPortableFile(jsonFile(backup), libraryAdapter().store, { dashboard: target });
  assert.deepEqual(target.stored.boards.map(b => [b.id, b.name]), [['main', 'Main'], ['work', 'Work']]);
});

test('backups without a dashboard, or without a dashboard source, leave the dashboard alone', async () => {
  const backup = await createFullBackup(libraryAdapter(library()).store, { dashboard: null });
  assert.equal(backup.dashboard, undefined);
  const target = dashboardSource({ boards: [{ id: 'keep', name: 'Keep', widgets: [] }] });
  const result = await importPortableFile(jsonFile(backup), libraryAdapter().store, { dashboard: target });
  assert.equal(result.boards, undefined);
  assert.deepEqual(target.stored.boards.map(b => b.id), ['keep']);
  const withDashboard = await createFullBackup(libraryAdapter(library()).store, { dashboard: dashboardSource(dashboard()) });
  const plain = await importPortableFile(jsonFile(withDashboard), libraryAdapter().store, { dashboard: null });
  assert.equal(plain.boards, undefined);
});

test('a malformed dashboard rejects the whole import before anything is written', async () => {
  const bad = [
    value => { value.dashboard = { boards: 'nope' }; },
    value => { value.dashboard.boards[0].widgets = {}; },
    value => { value.dashboard.boards[0].widgets[0].type = '<script>'; },
    value => { value.dashboard.boards[0].id = '../escape'; },
    value => { value.dashboard.boards[0].widgets[0].config = ['x']; },
    value => { value.dashboard.boards = Array.from({ length: 101 }, (_, i) => ({ id: `b${i}`, widgets: [] })); },
  ];
  for (const mutate of bad) {
    const backup = await createFullBackup(libraryAdapter(library()).store, { dashboard: dashboardSource(dashboard()) });
    mutate(backup);
    const target = libraryAdapter();
    const before = JSON.stringify(target.library);
    const dash = dashboardSource({ boards: [{ id: 'keep', widgets: [] }] });
    await assert.rejects(importPortableFile(jsonFile(backup), target.store, { dashboard: dash }));
    assert.equal(JSON.stringify(target.library), before);
    assert.deepEqual(dash.stored.boards.map(b => b.id), ['keep']);
  }
});

test('a dashboard that fails to save after the library import becomes a warning', async () => {
  const backup = await createFullBackup(libraryAdapter(library()).store, { dashboard: dashboardSource(dashboard()) });
  const original = console.error;
  console.error = () => {};
  try {
    const result = await importPortableFile(jsonFile(backup), libraryAdapter().store, { dashboard: { importDashboard: async () => { throw new Error('disk full'); } } });
    assert.equal(result.items, 1);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /dashboard/);
  } finally { console.error = original; }
});
