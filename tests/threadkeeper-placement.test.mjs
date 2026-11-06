import test from 'node:test';
import assert from 'node:assert/strict';
import { planPlacement, resolveTarget, isUnfiledProject, PARENT_MEMORY } from '../extension/lib/threadkeeper/placement.js';
import { DEFAULT_PREFS } from '../extension/lib/threadkeeper/state.js';

const prefs = (patch = {}) => ({ ...DEFAULT_PREFS, ...patch });
const library = (collections = []) => ({ items: [], collections });
const threads = [{ threadKey: 'a', project: 'Still' }, { threadKey: 'b', project: 'Still ' }, { threadKey: 'c', project: 'Unfiled / Uncertain' }, { threadKey: 'd', project: '' }];

test('mirror on an empty library ensures the parent and one child per project', () => {
  const plan = planPlacement(threads, prefs(), library(), {});
  assert.deepEqual(plan.ensureCollections, [
    { key: 'parent', name: 'AI chats' },
    { key: 'project:still', name: 'Still', parentKey: 'parent' },
  ]);
  assert.deepEqual(plan.byThreadKey, { a: { collectionKey: 'project:still' }, b: { collectionKey: 'project:still' }, c: { collectionKey: 'parent' }, d: { collectionKey: 'parent' } });
  assert.deepEqual(plan.memoryKeys, { parent: PARENT_MEMORY, 'project:still': 'still' });
});

test('mirror reuses remembered and matching collections and skips deleted ones', () => {
  const collections = [
    { id: 'c_parent', name: 'ai chats', parentId: '' },
    { id: 'c_top', name: 'Research', parentId: '' },
    { id: 'c_child', name: 'Still', parentId: 'c_parent' },
    { id: 'c_gone', name: 'Old', parentId: '', deletedAt: '2026-01-01T00:00:00Z' },
  ];
  const plan = planPlacement([...threads, { threadKey: 'r', project: 'research' }, { threadKey: 'o', project: 'Old' }], prefs(), library(collections), { old: 'c_gone' });
  assert.equal(plan.byThreadKey.a.collectionId, 'c_child');
  assert.equal(plan.byThreadKey.c.collectionId, 'c_parent');
  assert.equal(plan.byThreadKey.r.collectionId, 'c_top', 'matchExisting: a top-level collection with the project name');
  assert.deepEqual(plan.byThreadKey.o, { collectionKey: 'project:old' }, 'a remembered collection that was deleted is not used');
  assert.deepEqual(plan.ensureCollections, [{ key: 'project:old', name: 'Old', parentId: 'c_parent' }]);
  assert.deepEqual(plan.remember, { [PARENT_MEMORY]: 'c_parent', still: 'c_child', research: 'c_top' });
  const noMatch = planPlacement([{ threadKey: 'r', project: 'Research' }], prefs({ matchExisting: false }), library(collections), {});
  assert.deepEqual(noMatch.byThreadKey.r, { collectionKey: 'project:research' });
  const remembered = planPlacement([{ threadKey: 'a', project: 'Still' }], prefs(), library([{ id: 'mine', name: 'Renamed by me', parentId: 'x' }]), { still: 'mine' });
  assert.deepEqual(remembered.byThreadKey.a, { collectionId: 'mine' }, 'a remembered id wins over names (the user renamed it)');
});

test('single and inbox placement', () => {
  const lib = library([{ id: 'c1', name: 'Chats', parentId: '' }]);
  assert.deepEqual(planPlacement(threads, prefs({ placement: 'single', singleCollectionId: 'c1' }), lib, {}).byThreadKey.a, { collectionId: 'c1' });
  assert.deepEqual(planPlacement(threads, prefs({ placement: 'single', singleCollectionId: 'gone' }), lib, {}).byThreadKey.a, { collectionId: '' });
  const inbox = planPlacement(threads, prefs({ placement: 'inbox' }), lib, {});
  assert.deepEqual(inbox.byThreadKey.d, { collectionId: '' });
  assert.deepEqual(inbox.ensureCollections, []);
});

test('a manual target wins for manual and assistant origins only', () => {
  const lib = library([{ id: 'c1', name: 'Reading', parentId: '' }, { id: 'c2', name: 'Nested', parentId: 'c1' }]);
  assert.deepEqual(planPlacement(threads, prefs(), lib, {}, { origin: 'manual', target: { collectionId: 'c2' } }).byThreadKey.a, { collectionId: 'c2' });
  assert.deepEqual(planPlacement(threads, prefs(), lib, {}, { origin: 'assistant', target: { collectionId: 'missing' } }).byThreadKey.a, { collectionId: '' });
  assert.deepEqual(planPlacement(threads, prefs(), lib, {}, { origin: 'manual', target: { collectionName: ' reading ' } }).byThreadKey.a, { collectionId: 'c1' });
  const created = planPlacement(threads, prefs(), lib, {}, { origin: 'manual', target: { collectionName: 'Agents' } });
  assert.deepEqual(created.ensureCollections, [{ key: 'target:agents', name: 'Agents' }]);
  assert.deepEqual(created.byThreadKey.b, { collectionKey: 'target:agents' });
  assert.deepEqual(planPlacement(threads, prefs({ placement: 'inbox' }), lib, {}, { origin: 'sync', target: { collectionId: 'c1' } }).byThreadKey.a, { collectionId: '' });
  assert.equal(resolveTarget(null, lib), null);
  assert.equal(resolveTarget({ collectionName: '' }, lib), null);
});

test('unfiled project names', () => {
  for (const name of ['', 'Unfiled', 'unfiled / uncertain', '  Uncertain ']) assert.ok(isUnfiledProject(name), name);
  assert.equal(isUnfiledProject('Still'), false);
});
