import test from 'node:test';
import assert from 'node:assert/strict';
import {
  indexTree, folderChildren, folderPath, folderOptions, filterFolderOptions, searchBookmarks, treeRows, importPlan, isWithin, nodeTitle,
  allFolderIds, bookmarkConfig, bookmarkDefaults, moveIndex, dropMove, dropCreate, folderUrls, compactTree, expandTree,
} from '../extension/ui/widgets/bookmarks/tree.js';

const link = (id, title, url, dateAdded = 0) => ({ id, title, url, dateAdded });
const folder = (id, title, children) => ({ id, title, children });
const TREE = [folder('0', '', [
  folder('1', 'Bookmarks bar', [
    link('10', 'Zeta', 'https://zeta.example/', 3),
    folder('11', 'Work', [
      link('110', 'Docs', 'https://docs.example/', 5),
      folder('111', 'Empty', []),
      folder('112', 'Deep', [link('1120', 'Deep link', 'https://deep.example/a', 9)]),
      link('113', 'Dup of Zeta', 'https://zeta.example', 1),
    ]),
    link('12', 'alpha', 'https://alpha.example/', 7),
    link('13', 'Bookmarklet', 'javascript:alert(1)'),
    link('14', '', 'https://www.untitled.example/page'),
  ]),
  folder('2', 'Other bookmarks', [link('20', 'Recipes', 'https://food.example/recipes')]),
])];

test('the index counts direct and total web links per folder', () => {
  const index = indexTree(TREE);
  assert.equal(index.links, 7);
  assert.equal(index.nodes.get('1').links, 3);
  assert.equal(index.nodes.get('1').total, 6);
  assert.equal(index.nodes.get('11').total, 3);
  assert.equal(index.nodes.get('111').total, 0);
  assert.equal(index.nodes.get('110').parentId, '11');
  assert.equal(nodeTitle(index.nodes.get('14')), 'untitled.example');
  assert.equal(nodeTitle(index.nodes.get('111')), 'Empty');
});

test('folder children: manual order, title (folders first) and recent', () => {
  const index = indexTree(TREE);
  assert.deepEqual(folderChildren(index, '1').map(n => n.id), ['10', '11', '12', '14']);
  assert.deepEqual(folderChildren(index, '1', { showFolders: false }).map(n => n.id), ['10', '12', '14']);
  assert.deepEqual(folderChildren(index, '1', { sort: 'title' }).map(n => n.id), ['11', '12', '14', '10']);
  assert.deepEqual(folderChildren(index, '1', { sort: 'recent' }).map(n => n.id), ['11', '12', '10', '14']);
  assert.deepEqual(folderChildren(index, 'missing'), []);
  assert.deepEqual(folderChildren(index, '10'), []);
});

test('paths, containment and the folder picker list', () => {
  const index = indexTree(TREE);
  assert.deepEqual(folderPath(index, '112').map(p => p.title), ['Bookmarks bar', 'Work', 'Deep']);
  assert.deepEqual(folderPath(index, '0'), []);
  assert.ok(isWithin(index, '1120', '11'));
  assert.ok(!isWithin(index, '20', '11'));
  const options = folderOptions(index);
  assert.deepEqual(options.map(o => [o.id, o.depth]), [['1', 0], ['11', 1], ['111', 2], ['112', 2], ['2', 0]]);
  assert.deepEqual(options.find(o => o.id === '11'), { id: '11', title: 'Work', depth: 1, links: 2, total: 3, folders: 2 });
  assert.deepEqual(filterFolderOptions(options, 'deep').map(o => o.id), ['1', '11', '112']);
  assert.deepEqual(filterFolderOptions(options, '').length, 5);
  assert.deepEqual(allFolderIds(index, '1'), ['11', '111', '112']);
});

test('search covers subfolders, ranks title matches first and skips bookmarklets', () => {
  const index = indexTree(TREE);
  assert.deepEqual(searchBookmarks(index, '1', 'deep').map(h => h.node.id), ['1120']);
  assert.equal(searchBookmarks(index, '1', 'deep')[0].folderTitle, 'Deep');
  assert.deepEqual(searchBookmarks(index, '1', 'zeta').map(h => h.node.id), ['10', '113']);
  assert.deepEqual(searchBookmarks(index, '1', 'example').length, 6);
  assert.deepEqual(searchBookmarks(index, '1', 'alert'), []);
  assert.deepEqual(searchBookmarks(index, '1', '  '), []);
  assert.deepEqual(searchBookmarks(index, '2', 'docs'), []);
  assert.equal(searchBookmarks(index, '1', 'example', { limit: 2 }).length, 2);
});

test('tree rows open only expanded folders', () => {
  const index = indexTree(TREE);
  assert.deepEqual(treeRows(index, '1').map(r => r.node.id), ['10', '11', '12', '14']);
  const open = treeRows(index, '1', new Set(['11', '112']));
  assert.deepEqual(open.map(r => [r.node.id, r.depth]), [['10', 0], ['11', 0], ['110', 1], ['111', 1], ['112', 1], ['1120', 2], ['113', 1], ['12', 0], ['14', 0]]);
  assert.equal(open[1].expanded, true);
});

test('import plan: one collection per folder with links, each address once, existing ones skipped', () => {
  const index = indexTree(TREE);
  let n = 0;
  const makeId = prefix => `${prefix}_${++n}`;
  const existing = new Set(['https://alpha.example']);
  const plan = importPlan(index, '1', { existing, makeId });
  const [bar, work, deep] = plan.collections;
  assert.deepEqual(plan.collections.map(c => c.name), ['Bookmarks bar', 'Work', 'Deep']);
  assert.deepEqual([bar.parentId, work.parentId, deep.parentId], ['', bar.id, work.id]);
  assert.equal(plan.rootId, 'collection_1');
  assert.deepEqual(plan.items.map(i => i.url), ['https://zeta.example/', 'https://docs.example/', 'https://deep.example/a', 'https://www.untitled.example/page']);
  assert.equal(plan.items[0].collectionId, 'collection_1');
  assert.equal(plan.items[2].collectionId, deep.id);
  assert.equal(plan.items[0].createdAt, new Date(3).toISOString());
  assert.equal(plan.items[3].title, 'untitled.example');
  assert.equal(plan.skipped, 2); // alpha (already in Still) and the second Zeta
  assert.deepEqual(importPlan(index, '10'), { collections: [], items: [], skipped: 0, rootId: '' });
});

test('config defaults and limits', () => {
  assert.deepEqual(bookmarkConfig(), bookmarkDefaults());
  assert.deepEqual(bookmarkConfig({ folderId: '', view: 'grid', sort: 'x', openIn: 'window', showFolders: false }),
    { folderId: '1', view: 'list', sort: 'manual', showFolders: false, openIn: 'current', showSearch: true });
});

test('Chrome\'s top folders and managed bookmarks are locked', () => {
  const index = indexTree([folder('0', '', [folder('1', 'Bookmarks bar', [link('10', 'A', 'https://a.example/')]),
    { id: '9', title: 'Managed', unmodifiable: 'managed', children: [{ id: '90', title: 'Intranet', url: 'https://intranet.example/', unmodifiable: 'managed' }] }])]);
  assert.equal(index.nodes.get('1').locked, true);
  assert.equal(index.nodes.get('1').managed, false);
  assert.equal(index.nodes.get('10').locked, false);
  assert.equal(index.nodes.get('9').managed, true);
  assert.equal(index.nodes.get('90').locked, true);
});

test('move indexes count Chrome\'s own children and skip moves onto the same place', () => {
  const index = indexTree(TREE);
  // Bar children (Chrome order): 10 Zeta, 11 Work, 12 alpha, 13 Bookmarklet, 14 untitled.
  assert.equal(moveIndex(index, '1', '10', { beforeId: '12' }), 2);
  assert.equal(moveIndex(index, '1', '12', { beforeId: '10' }), 0);
  assert.equal(moveIndex(index, '1', '12', { beforeId: '' }), 5);
  assert.equal(moveIndex(index, '1', '10', { beforeId: '11' }), -1, 'just after itself is no move');
  assert.equal(moveIndex(index, '1', '10', { delta: 1 }), 2);
  assert.equal(moveIndex(index, '1', '10', { delta: -1 }), -1, 'already first');
  // A grid row down (+3): from Zeta past Work and alpha to after the untitled link (the bookmarklet is not shown).
  assert.equal(moveIndex(index, '1', '10', { delta: 3 }), 5);
  assert.equal(moveIndex(index, '1', '14', { delta: -2 }), 1);
  assert.equal(moveIndex(index, '1', '110', { delta: 1 }), -1, 'not in that folder');
});

test('drops: moving between folders, never into itself; new bookmarks land at the drop point', () => {
  const index = indexTree(TREE);
  assert.deepEqual(dropMove(index, '20', { beforeId: '110', folderId: '1' }), { parentId: '11', index: 0 });
  assert.deepEqual(dropMove(index, '10', { beforeId: '', folderId: '11' }), { parentId: '11', index: 4 });
  assert.equal(dropMove(index, '11', { beforeId: '1120', folderId: '1' }), null, 'a folder into its own subfolder');
  assert.equal(dropMove(index, '1', { beforeId: '20', folderId: '2' }), null, 'Chrome\'s top folders stay put');
  assert.equal(dropMove(index, '10', { beforeId: '11', folderId: '1' }), null, 'onto its own place');
  assert.deepEqual(dropCreate(index, '1', '12'), { parentId: '1', index: 2 });
  assert.deepEqual(dropCreate(index, '1', '110'), { parentId: '11', index: 0 });
  assert.deepEqual(dropCreate(index, '1', ''), { parentId: '1', index: undefined });
  assert.deepEqual(folderUrls(index, '1'), ['https://zeta.example/', 'https://alpha.example/', 'https://www.untitled.example/page']);
});

test('the cached copy round-trips and can be cut short', () => {
  const index = indexTree(TREE);
  const rows = compactTree(index);
  assert.equal(rows.length, index.nodes.size);
  assert.deepEqual(rows[0], ['0', '', '', '', 0, 0]);
  const back = expandTree(JSON.parse(JSON.stringify(rows)));
  assert.equal(back.links, index.links);
  assert.deepEqual(folderChildren(back, '1').map(n => n.id), folderChildren(index, '1').map(n => n.id));
  assert.deepEqual(folderOptions(back), folderOptions(index));
  assert.equal(back.nodes.get('1').locked, true);
  const cut = expandTree(compactTree(index, { limit: 4 }));
  assert.deepEqual([...cut.nodes.keys()].sort(), ['0', '1', '10', '2']);
  assert.equal(cut.nodes.get('1').total, 1, 'counts follow what was kept');
  assert.deepEqual(expandTree(null).nodes.size, 0);
});
