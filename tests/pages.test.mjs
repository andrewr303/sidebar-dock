import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PAGE_DEPTH, pageIndex, parentIdOf, parentOf, childrenOf, descendantIds, ancestorsOf, isSubpage, wouldCycle, pageDepth, pageHeight,
  pageTree, pageBlockLine, parsePageBlockLine,
} from '../extension/lib/pages.js';

const at = minutes => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
const note = (id, parentId = '', extra = {}) => ({ id, type: 'note', title: id.toUpperCase(), parentId, createdAt: at(extra.minute ?? 0), ...extra });
// root (article) > a > [b (trashed) > c, d]; e at the top level; x <-> y form a damaged loop.
const library = () => ({ items: [
  { id: 'root', type: 'article', title: 'Saved article', url: 'https://example.com/a', parentId: '', createdAt: at(0) },
  note('d', 'a', { minute: 5 }),
  note('a', 'root', { minute: 1 }),
  note('b', 'a', { minute: 2, deletedAt: at(9) }),
  note('c', 'b', { minute: 3, deletedAt: at(9) }),
  note('e', '', { minute: 4 }),
  note('x', 'y'), note('y', 'x'),
  { id: 'link', type: 'bookmark', title: 'Not a page child', url: 'https://example.com', parentId: 'root' },
] });

test('only notes have a parent, and never themselves', () => {
  assert.equal(parentIdOf(note('a', 'root')), 'root');
  assert.equal(parentIdOf(note('a', ' root ')), 'root');
  assert.equal(parentIdOf(note('a', 'a')), '');
  assert.equal(parentIdOf({ id: 'b', type: 'bookmark', parentId: 'root' }), '');
  assert.equal(parentIdOf(null), '');
  assert.equal(parentIdOf({ id: 'n', type: 'note', parentId: 42 }), '');
});

test('children are notes in createdAt then id order; trashed ones only on request', () => {
  const lib = library();
  assert.deepEqual(childrenOf(lib, 'a').map(item => item.id), ['d']);
  assert.deepEqual(childrenOf(lib, 'a', { includeDeleted: true }).map(item => item.id), ['b', 'd']);
  assert.deepEqual(childrenOf(lib, 'root').map(item => item.id), ['a'], 'a bookmark never counts as a subpage');
  const ties = { items: [note('n2', 'p'), note('n1', 'p'), note('n0', 'p', { minute: 1 }), note('p')] };
  assert.deepEqual(childrenOf(ties, 'p').map(item => item.id), ['n1', 'n2', 'n0'], 'same createdAt sorts by id');
  assert.deepEqual(childrenOf(lib, 'missing'), []);
});

test('descendants walk depth first, skip the start and stay finite on a damaged loop', () => {
  const lib = library();
  assert.deepEqual(descendantIds(lib, 'root'), ['a', 'd'], 'a trashed page hides its subtree');
  assert.deepEqual(descendantIds(lib, 'root', { includeDeleted: true }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(descendantIds(lib, 'x'), ['y']);
  assert.deepEqual(descendantIds(lib, 'e'), []);
});

test('ancestors read top level first and stop at a trashed or missing parent, a loop or the depth cap', () => {
  const lib = library();
  assert.deepEqual(ancestorsOf(lib, 'd').map(item => item.id), ['root', 'a']);
  assert.deepEqual(ancestorsOf(lib, 'c').map(item => item.id), [], 'the parent b is in Trash');
  assert.deepEqual(ancestorsOf(lib, 'x').map(item => item.id), ['y']);
  assert.deepEqual(ancestorsOf({ items: [note('orphan', 'gone')] }, 'orphan'), []);
  const chain = Array.from({ length: 40 }, (_, n) => note(`p${n}`, n ? `p${n - 1}` : ''));
  assert.equal(ancestorsOf({ items: chain }, 'p39').length, MAX_PAGE_DEPTH);
});

test('parentOf and isSubpage need a live parent of any type', () => {
  const lib = library();
  assert.equal(parentOf(lib, 'a').id, 'root');
  assert.equal(parentOf(lib, lib.items.find(item => item.id === 'd')).id, 'a');
  assert.equal(parentOf(lib, 'c'), null);
  assert.equal(isSubpage(lib, lib.items.find(item => item.id === 'a')), true);
  assert.equal(isSubpage(lib, lib.items.find(item => item.id === 'c')), false);
  assert.equal(isSubpage(lib, lib.items.find(item => item.id === 'e')), false);
});

test('cycle, depth and height checks follow stored parents, trashed ones included', () => {
  const lib = library();
  assert.equal(wouldCycle(lib, 'a', 'a'), true);
  assert.equal(wouldCycle(lib, 'a', 'c'), true, 'c sits inside a through the trashed b');
  assert.equal(wouldCycle(lib, 'e', 'c'), false);
  assert.equal(wouldCycle(lib, 'a', ''), false);
  assert.equal(wouldCycle(lib, 'e', 'x'), false, 'a damaged loop above is not a loop through e');
  assert.equal(pageDepth(lib, 'root'), 0);
  assert.equal(pageDepth(lib, 'c'), 3);
  assert.equal(pageDepth(lib, 'x'), Infinity);
  assert.equal(pageHeight(lib, 'root'), 3);
  assert.equal(pageHeight(lib, 'e'), 0);
  assert.equal(pageHeight(lib, 'x'), 1);
});

test('a page tree nests children in sibling order and survives loops', () => {
  const lib = library();
  const tree = pageTree(lib, 'root', { includeDeleted: true });
  assert.equal(tree.item.id, 'root');
  assert.deepEqual(tree.children.map(node => node.item.id), ['a']);
  assert.deepEqual(tree.children[0].children.map(node => node.item.id), ['b', 'd']);
  assert.deepEqual(tree.children[0].children[0].children.map(node => node.item.id), ['c']);
  assert.deepEqual(pageTree(lib, 'root').children[0].children.map(node => node.item.id), ['d']);
  assert.deepEqual(pageTree(lib, 'x').children[0].children, []);
  assert.equal(pageTree(lib, 'missing'), null);
});

test('one index serves many calls and accepts arrays and maps', () => {
  const lib = library();
  const index = pageIndex(lib);
  assert.equal(pageIndex(index), index);
  assert.deepEqual(descendantIds(index, 'root'), descendantIds(lib, 'root'));
  assert.deepEqual(childrenOf(lib.items, 'a').map(item => item.id), ['d']);
  assert.deepEqual(childrenOf(new Map(lib.items.map(item => [item.id, item])), 'a').map(item => item.id), ['d']);
  assert.deepEqual(childrenOf(null, 'a'), []);
});

test('page block lines are canonical wiki links that parse back', () => {
  assert.equal(pageBlockLine('item_1', 'Research notes'), '[[item_1|Research notes]]{page}');
  assert.equal(pageBlockLine('item_1', ' A [b] | c\nd '), '[[item_1|A b c d]]{page}');
  assert.equal(pageBlockLine('item_1', ''), '[[item_1|Untitled page]]{page}');
  assert.equal(pageBlockLine('item_1', 'x'.repeat(300)).length, '[[item_1|]]{page}'.length + 200);
  assert.deepEqual(parsePageBlockLine(pageBlockLine('item_1', 'Research notes')), { id: 'item_1', label: 'Research notes' });
  assert.deepEqual(parsePageBlockLine('[[item_2]]{page}  \r'), { id: 'item_2', label: '' });
  assert.equal(parsePageBlockLine('[[item_2|Title]]'), null, 'a plain wiki link line is not a page block');
  assert.equal(parsePageBlockLine('See [[item_2|Title]]{page}'), null);
});
