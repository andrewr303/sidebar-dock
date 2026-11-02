import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERMISSION_CATEGORIES, PERMISSION_LEVELS, PERMISSION_PRESETS, DEFAULT_PERMISSIONS, categoryOf, categoriesOf, normalizePermissions, presetOf,
  allowedCategories, autoApproves, toolAutoApplies, changedItemCount, MAX_AUTO_ITEMS,
} from '../extension/lib/ai/permissions.js';
import { LIBRARY_TOOLS, buildChanges } from '../extension/lib/ai/tools.js';

const ALL = { create: 'allow', organize: 'allow', edit: 'allow', dashboard: 'allow', delete: 'allow' };
const ASK = { create: 'ask', organize: 'ask', edit: 'ask', dashboard: 'ask', delete: 'ask' };
// Every op buildChanges / applyDraft can stage (critic addendum G-P1).
const OPS = ['add_dashboard_widget', 'add_tags', 'append_to_note', 'archive_items', 'convert_items', 'create_collection', 'create_note', 'delete_collection', 'link_items',
  'move_items', 'remove_tags', 'rename_tag', 'restore_items', 'save_links', 'set_favorite', 'trash_items', 'unarchive_items', 'unlink_items', 'update_collection', 'update_item'];

test('five categories with labels and hints; presets and defaults match the contract', () => {
  assert.deepEqual(PERMISSION_CATEGORIES.map(category => category.id), ['create', 'organize', 'edit', 'dashboard', 'delete']);
  for (const category of PERMISSION_CATEGORIES) assert.ok(category.label && category.hint && !/[—!]/.test(category.hint), category.id);
  assert.deepEqual(PERMISSION_LEVELS, ['ask', 'allow']);
  assert.deepEqual({ ...PERMISSION_PRESETS.ask }, ASK);
  assert.deepEqual({ ...PERMISSION_PRESETS.trusted }, { ...ALL, delete: 'ask' });
  assert.deepEqual({ ...PERMISSION_PRESETS.full }, ALL);
  assert.deepEqual({ ...DEFAULT_PERMISSIONS }, ASK);
  assert.ok(Object.isFrozen(PERMISSION_PRESETS.trusted), 'presets cannot be changed by a caller');
});

test('categoryOf classifies by tool first, then op; every write tool and staged op has a category', () => {
  assert.equal(categoryOf({ tool: 'delete_tag', op: 'remove_tags' }), 'delete', 'delete_tag stages remove_tags but is a deletion');
  assert.equal(categoryOf({ op: 'remove_tags' }), 'organize');
  for (const [tool, category] of [['trash_items', 'delete'], ['delete_collection', 'delete'], ['create_note', 'create'], ['save_links', 'create'], ['create_collection', 'create'],
    ['update_item', 'edit'], ['append_to_note', 'edit'], ['update_collection', 'edit'], ['convert_items', 'edit'], ['rename_tag', 'edit'],
    ['move_items', 'organize'], ['add_tags', 'organize'], ['remove_tags', 'organize'], ['set_favorite', 'organize'], ['archive_items', 'organize'],
    ['unarchive_items', 'organize'], ['restore_items', 'organize'], ['link_items', 'organize'], ['unlink_items', 'organize'],
    ['show_collection_on_dashboard', 'dashboard']]) assert.equal(categoryOf({ tool }), category, tool);
  assert.equal(categoryOf({ op: 'add_dashboard_widget' }), 'dashboard');
  assert.equal(categoryOf({ tool: 'update_item', op: 'update_item', fields: ['content'] }), 'edit', 'replacing a note body is an edit');
  for (const tool of LIBRARY_TOOLS.filter(entry => entry.access === 'write')) assert.ok(categoryOf({ tool: tool.name }), `${tool.name} is classified`);
  for (const tool of LIBRARY_TOOLS.filter(entry => entry.access === 'read')) assert.equal(categoryOf({ tool: tool.name }), null, `${tool.name} is a read`);
  for (const op of OPS) assert.ok(categoryOf({ op }), `${op} is classified`);
  for (const unknown of [{}, { tool: 'drop_table' }, { op: 'wipe' }, { tool: 'toString' }, { op: '__proto__' }, { tool: 42 }]) assert.equal(categoryOf(unknown), null, JSON.stringify(unknown));
  assert.equal(categoryOf(), null);
});

test('categoriesOf lists every category a staged change touches and refuses unknown halves', () => {
  assert.deepEqual(categoriesOf({ tool: 'save_links', op: 'save_links' }), ['create']);
  assert.deepEqual(categoriesOf({ tool: 'save_links', op: 'move_items' }), ['create', 'organize'], 'adding links to folders uses Create and Organize');
  assert.deepEqual(categoriesOf({ tool: 'delete_tag', op: 'remove_tags' }), ['delete', 'organize']);
  assert.deepEqual(categoriesOf({ tool: 'show_collection_on_dashboard', op: 'add_dashboard_widget' }), ['dashboard']);
  assert.deepEqual(categoriesOf({ op: 'trash_items' }), ['delete']);
  assert.equal(categoriesOf({ tool: 'save_links', op: 'teleport_items' }), null, 'a known tool staging an unknown op asks');
  assert.equal(categoriesOf({ tool: 'mystery', op: 'move_items' }), null);
});

test('normalizePermissions coerces anything to complete ask/allow levels; only exactly "allow" allows', () => {
  for (const value of [null, undefined, 'allow', true, 7, ['allow'], () => 'allow']) assert.deepEqual(normalizePermissions(value), ASK, String(value));
  assert.deepEqual(normalizePermissions({ create: 'allow', organize: 'Allow', edit: 'auto', dashboard: true, delete: 'allow', extra: 'allow' }),
    { create: 'allow', organize: 'ask', edit: 'ask', dashboard: 'ask', delete: 'allow' });
  assert.deepEqual(Object.keys(normalizePermissions({ extra: 'allow' })), ['create', 'organize', 'edit', 'dashboard', 'delete']);
});

test('presetOf names the matching preset or custom', () => {
  assert.equal(presetOf(undefined), 'ask');
  assert.equal(presetOf(ASK), 'ask');
  assert.equal(presetOf({ ...ALL, delete: 'ask' }), 'trusted');
  assert.equal(presetOf(ALL), 'full');
  assert.equal(presetOf({ create: 'allow' }), 'custom');
  assert.equal(presetOf({ ...ALL, dashboard: 'ask' }), 'custom');
  assert.deepEqual(allowedCategories({ create: 'allow', delete: 'allow' }).map(category => category.id), ['create', 'delete']);
  assert.deepEqual(allowedCategories(null), []);
});

test('autoApproves needs at least one change and every category of every change allowed', () => {
  const trusted = PERMISSION_PRESETS.trusted;
  assert.equal(autoApproves([{ tool: 'create_note', op: 'create_note' }, { tool: 'move_items', op: 'move_items' }], trusted), true);
  assert.equal(autoApproves([{ tool: 'create_note', op: 'create_note' }, { tool: 'trash_items', op: 'trash_items' }], trusted), false, 'one deletion makes the whole proposal ask');
  assert.equal(autoApproves([{ tool: 'delete_tag', op: 'remove_tags' }], trusted), false, 'delete_tag stays a deletion under Trusted');
  assert.equal(autoApproves([{ tool: 'delete_tag', op: 'remove_tags' }], ALL), true);
  assert.equal(autoApproves([{ tool: 'remove_tags', op: 'remove_tags' }], trusted), true, 'removing a few tags is organizing');
  assert.equal(autoApproves([{ tool: 'save_links', op: 'save_links' }, { tool: 'save_links', op: 'move_items' }], { create: 'allow' }), false, 'moving saved links needs Organize too');
  assert.equal(autoApproves([{ tool: 'save_links', op: 'save_links' }, { tool: 'save_links', op: 'move_items' }], { create: 'allow', organize: 'allow' }), true);
  assert.equal(autoApproves([{ tool: 'save_links', op: 'save_links' }], { create: 'allow' }), true);
  // Unknown ops, unknown tools and malformed entries always ask, even with everything allowed.
  for (const changes of [[{ op: 'wipe_library' }], [{ tool: 'drop_table' }], [{ tool: 'create_note', op: 'create_note' }, null], [{ tool: 'save_links', op: 'teleport' }], ['create_note'], [], null, 'create_note']) {
    assert.equal(autoApproves(changes, ALL), false, JSON.stringify(changes));
  }
  assert.equal(autoApproves([{ op: 'create_note' }], ASK), false);
  assert.equal(autoApproves([{ op: 'create_note' }], 'allow'), false, 'a non-object setting asks');
});

test('autoApproves reads the rows of a proposal card by the tools behind them; a row that names no tool always asks', () => {
  const library = { items: [{ id: 'a', title: 'A', tags: ['japan'] }, { id: 'b', title: 'B', tags: ['japan'] }], collections: [] };
  const rows = (ops, collections = []) => buildChanges({ collections, ops }, library);
  const changes = rows([{ callId: 'c1', tool: 'add_tags', op: { op: 'add_tags', itemIds: ['a'], tags: ['x'] } }, { callId: 'c2', tool: 'trash_items', op: { op: 'trash_items', itemIds: ['a'] } }]);
  assert.deepEqual(changes.map(change => change.tools), [['add_tags'], ['trash_items']]);
  assert.equal(autoApproves(changes, PERMISSION_PRESETS.trusted), false);
  assert.equal(autoApproves(changes, ALL), true);
  assert.equal(autoApproves(changes.slice(0, 1), PERMISSION_PRESETS.trusted), true);
  const created = rows([], [{ id: 'n', name: 'New', parentId: '', tool: 'create_collection' }]);
  assert.deepEqual(created.map(change => [change.op, change.tools]), [['create_collection', ['create_collection']]]);
  assert.equal(autoApproves(created, PERMISSION_PRESETS.trusted), true);
  // delete_tag stages remove_tags: its row is a deletion under Trusted, also when it shares a row with a plain remove_tags.
  const deleting = rows([{ callId: 'd', tool: 'delete_tag', op: { op: 'remove_tags', itemIds: ['a', 'b'], tags: ['japan'] } }]);
  assert.deepEqual(deleting.map(change => [change.op, change.label, change.tools]), [['remove_tags', 'Remove tag #japan from 2 items', ['delete_tag']]]);
  assert.equal(autoApproves(deleting, PERMISSION_PRESETS.trusted), false);
  assert.equal(autoApproves(deleting, ALL), true);
  const merged = rows([{ callId: 'r', tool: 'remove_tags', op: { op: 'remove_tags', itemIds: ['a'], tags: ['Japan'] } }, { callId: 'd', tool: 'delete_tag', op: { op: 'remove_tags', itemIds: ['a', 'b'], tags: ['japan'] } }]);
  assert.deepEqual(merged.map(change => change.tools), [['remove_tags', 'delete_tag']], 'one row for both calls names both tools');
  assert.equal(autoApproves(merged, PERMISSION_PRESETS.trusted), false);
  // Rows that do not name their tools (hand-built drafts, or proposals saved before rows carried them) never apply by
  // themselves: a remove_tags row may be a delete_tag.
  const unnamed = rows([{ callId: 'd', op: { op: 'remove_tags', itemIds: ['a', 'b'], tags: ['japan'] } }]);
  assert.equal(unnamed[0].tools, undefined);
  assert.equal(autoApproves(unnamed, PERMISSION_PRESETS.trusted), false);
  assert.equal(autoApproves(unnamed, ALL), false);
  assert.equal(autoApproves(rows([], [{ id: 'n', name: 'New', parentId: '' }]), ALL), false);
  const partly = rows([{ callId: 'x', tool: 'add_tags', op: { op: 'add_tags', itemIds: ['a'], tags: ['x'] } }, { callId: 'y', op: { op: 'add_tags', itemIds: ['b'], tags: ['x'] } }]);
  assert.equal(partly.length, 1);
  assert.equal(autoApproves(partly, ALL), false, 'one unnamed call in a row makes it ask');
  for (const change of [{ op: 'add_tags' }, { op: 'add_tags', tools: [] }, { op: 'add_tags', tools: [null] }, { op: 'add_tags', tools: ['add_tags', 'mystery'] }, { op: 'add_tags', tools: 'add_tags' },
    { op: 'add_tags', tool: '' }, { op: 'add_tags', tool: null }, { tools: ['add_tags'] }, { tool: 'add_tags' }, { op: 'remove_tags', tools: ['remove_tags'], tool: 'delete_tag' }]) {
    assert.equal(autoApproves([change], PERMISSION_PRESETS.trusted), false, JSON.stringify(change));
  }
});

test('autoApproves asks when a proposal changes more than MAX_AUTO_ITEMS items, counted from staged calls or card rows', () => {
  assert.equal(MAX_AUTO_ITEMS, 50);
  const idList = (n, prefix = 'i') => Array.from({ length: n }, (_, k) => `${prefix}${k}`);
  const tags = n => [{ tool: 'add_tags', op: 'add_tags', itemIds: idList(n) }];
  assert.equal(autoApproves(tags(MAX_AUTO_ITEMS), PERMISSION_PRESETS.trusted), true, 'exactly at the limit applies');
  assert.equal(autoApproves(tags(MAX_AUTO_ITEMS + 1), PERMISSION_PRESETS.trusted), false);
  assert.equal(autoApproves(tags(MAX_AUTO_ITEMS + 1), ALL), false, 'even under Full access');
  // Distinct ids across changes: the same items tagged and moved count once; subpages a move carries count too.
  const both = [{ tool: 'add_tags', op: 'add_tags', itemIds: idList(40) }, { tool: 'move_items', op: 'move_items', itemIds: idList(40) }];
  assert.equal(changedItemCount(both), 40);
  assert.equal(autoApproves(both, PERMISSION_PRESETS.trusted), true);
  const carried = [{ tool: 'move_items', op: 'move_items', itemIds: ['page'], subpageIds: idList(MAX_AUTO_ITEMS, 'sub') }];
  assert.equal(changedItemCount(carried), MAX_AUTO_ITEMS + 1);
  assert.equal(autoApproves(carried, PERMISSION_PRESETS.trusted), false);
  // Created notes count one each; a deleted collection counts the items it sends to Inbox.
  const notes = n => Array.from({ length: n }, (_, k) => ({ tool: 'create_note', op: 'create_note', noteId: `n${k}` }));
  assert.equal(changedItemCount(notes(3)), 3);
  assert.equal(autoApproves(notes(MAX_AUTO_ITEMS + 1), { create: 'allow' }), false);
  assert.equal(changedItemCount([{ tool: 'create_note', op: 'create_note' }, { tool: 'create_note', op: 'create_note' }]), 2, 'a note without an id still counts');
  assert.equal(autoApproves([{ tool: 'delete_collection', op: 'delete_collection', itemIds: [], itemCount: MAX_AUTO_ITEMS + 1 }], ALL), false);
  assert.equal(autoApproves([{ tool: 'delete_collection', op: 'delete_collection', itemIds: [], itemCount: 3 }], ALL), true);
  // The rows of a proposal card count the same way.
  const library = { items: idList(60).map(id => ({ id, title: id })), collections: [] };
  const rows = buildChanges({ collections: [], ops: [{ callId: 'c', tool: 'add_tags', op: { op: 'add_tags', itemIds: idList(60), tags: ['x'] } }] }, library);
  assert.equal(changedItemCount(rows), 60);
  assert.equal(autoApproves(rows, PERMISSION_PRESETS.trusted), false);
  const created = buildChanges({ collections: [], ops: [{ callId: 'c', tool: 'create_note', op: { op: 'create_note', noteId: 'n1', title: 'T', markdown: '' } }] }, library);
  assert.equal(changedItemCount(created), 1);
  assert.equal(autoApproves(created, { create: 'allow' }), true);
  // Malformed sizes count nothing and never make an otherwise asking proposal apply.
  assert.equal(changedItemCount([{ itemIds: 'abc', itemCount: -5, subpageIds: [null, 7] }]), 0);
  assert.equal(changedItemCount(null), 0);
});

test('unlinking counts the related items toward MAX_AUTO_ITEMS (a link goes from both sides); linking changes only the item', () => {
  const idList = n => Array.from({ length: n }, (_, k) => `r${k}`);
  const unlink = n => [{ tool: 'unlink_items', op: 'unlink_items', itemIds: ['hub'], relatedIds: idList(n) }];
  assert.equal(changedItemCount(unlink(MAX_AUTO_ITEMS)), MAX_AUTO_ITEMS + 1);
  assert.equal(autoApproves(unlink(MAX_AUTO_ITEMS - 1), PERMISSION_PRESETS.trusted), true, 'the item and 49 others: at the limit');
  assert.equal(autoApproves(unlink(MAX_AUTO_ITEMS), PERMISSION_PRESETS.trusted), false, 'the item and 50 others: over it');
  assert.equal(autoApproves(unlink(MAX_AUTO_ITEMS), ALL), false, 'even under Full access');
  assert.equal(changedItemCount([{ tool: 'unlink_items', op: 'unlink_items', itemIds: ['hub'], relatedIds: ['hub', 'r1', 'r1'] }]), 2, 'distinct ids');
  assert.equal(changedItemCount([{ tool: 'link_items', op: 'link_items', itemIds: ['hub'], relatedIds: idList(80) }]), 1);
  // The rows of a proposal card count the same way.
  const library = { items: [{ id: 'hub', title: 'Hub' }, ...idList(MAX_AUTO_ITEMS).map(id => ({ id, title: id }))], collections: [] };
  const rows = buildChanges({ collections: [], ops: [{ callId: 'u', tool: 'unlink_items', op: { op: 'unlink_items', itemIds: ['hub'], relatedIds: idList(MAX_AUTO_ITEMS) } }] }, library);
  assert.equal(changedItemCount(rows), MAX_AUTO_ITEMS + 1);
  assert.equal(autoApproves(rows, PERMISSION_PRESETS.trusted), false);
});

test('toolAutoApplies is true only when everything a tool can stage is allowed', () => {
  assert.equal(toolAutoApplies('create_note', { create: 'allow' }), true);
  assert.equal(toolAutoApplies('save_links', { create: 'allow' }), false, 'save_links may also move saved links');
  assert.equal(toolAutoApplies('save_links', { create: 'allow', organize: 'allow' }), true);
  assert.equal(toolAutoApplies('delete_tag', PERMISSION_PRESETS.trusted), false);
  assert.equal(toolAutoApplies('show_collection_on_dashboard', { dashboard: 'allow' }), true);
  assert.equal(toolAutoApplies('search_library', ALL), false, 'read tools are never described as auto-applied');
  assert.equal(toolAutoApplies('mystery', ALL), false);
});
