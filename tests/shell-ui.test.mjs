import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectors } from '../extension/ui/selectors.js';
import { visibleTree, parentChoices, descendantIds, collectionSubset } from '../extension/ui/collections.js';
import { dropPlacement, collectionMove, droppedLinks } from '../extension/ui/dnd.js';
import { fuzzyScore, rankCommands, COMMANDS } from '../extension/ui/command.js';
import { exportBookmarkHtml } from '../extension/lib/portability.js';

const collection = (id, parentId = '', props = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), parentId, color: '#0d74ce', icon: 'folder', ...props });
function library() {
  return {
    updatedAt: '1', settings: {},
    collections: [
      collection('design'), collection('inspiration', 'design'), collection('type', 'design'), collection('fonts', 'type'),
      collection('dev'), collection('ai', '', { pinned: true }),
    ],
    items: [
      { id: 'a', type: 'bookmark', title: 'A', url: 'https://a.example/', collectionId: 'inspiration', tags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', type: 'bookmark', title: 'B', url: 'https://b.example/', collectionId: 'fonts', tags: ['t'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'c', type: 'bookmark', title: 'C', url: 'https://c.example/', collectionId: 'dev', tags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'gone', type: 'bookmark', title: 'Gone', url: 'https://d.example/', collectionId: 'design', tags: [], deletedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
    ],
  };
}
const treeOf = lib => createSelectors(() => lib).tree();

test('visibleTree hides children of collapsed rows and annotates ARIA set positions', () => {
  const tree = treeOf(library());
  assert.deepEqual(tree.map(r => r.id), ['ai', 'design', 'inspiration', 'type', 'fonts', 'dev'], 'pinned first, then depth-first order');
  const collapsed = visibleTree(tree, new Set());
  assert.deepEqual(collapsed.map(r => r.id), ['ai', 'design', 'dev']);
  assert.deepEqual(collapsed.map(r => [r.posInSet, r.setSize, r.expanded]), [[1, 3, false], [2, 3, false], [3, 3, false]]);
  const open = visibleTree(tree, new Set(['design']));
  assert.deepEqual(open.map(r => r.id), ['ai', 'design', 'inspiration', 'type', 'dev'], 'grandchildren stay hidden until their parent opens');
  const type = open.find(r => r.id === 'type');
  assert.deepEqual([type.depth, type.posInSet, type.setSize, type.expanded, type.hasChildren], [1, 2, 2, false, true]);
  assert.deepEqual(visibleTree(tree, new Set(['design', 'type'])).map(r => r.id), ['ai', 'design', 'inspiration', 'type', 'fonts', 'dev']);
  assert.deepEqual(visibleTree(tree, new Set(['type'])).map(r => r.id), ['ai', 'design', 'dev'], 'an open child under a closed parent stays hidden');
});

test('parentChoices excludes the collection and its descendants; descendantIds walks the subtree', () => {
  const tree = treeOf(library());
  assert.deepEqual(parentChoices(tree, 'design').map(r => r.id), ['ai', 'dev']);
  assert.deepEqual(parentChoices(tree, 'type').map(r => r.id), ['ai', 'design', 'inspiration', 'dev']);
  assert.equal(parentChoices(tree, '').length, tree.length, 'a new collection may go anywhere');
  assert.deepEqual(descendantIds(library().collections, 'design').sort(), ['design', 'fonts', 'inspiration', 'type']);
  const cyclic = [collection('x', 'y'), collection('y', 'x')];
  assert.deepEqual(descendantIds(cyclic, 'x'), ['x', 'y'], 'cycles terminate');
});

test('collectionSubset exports one subtree as a valid bookmarks file', () => {
  const subset = collectionSubset(library(), 'type');
  assert.deepEqual(subset.collections.map(c => [c.id, c.parentId]), [['type', ''], ['fonts', 'type']]);
  assert.deepEqual(subset.items.map(i => i.id), ['b']);
  const file = exportBookmarkHtml(subset);
  assert.match(file, /<H3>Type<\/H3>[\s\S]*<H3>Fonts<\/H3>[\s\S]*https:\/\/b\.example\//);
  assert.doesNotMatch(file, /a\.example|c\.example/);
  assert.deepEqual(collectionSubset(library(), 'design').items.map(i => i.id).sort(), ['a', 'b'], 'trashed items are left out');
});

test('dropPlacement splits a row into before, inside and after zones', () => {
  assert.equal(dropPlacement(102, 100, 30), 'before');
  assert.equal(dropPlacement(115, 100, 30), 'inside');
  assert.equal(dropPlacement(128, 100, 30), 'after');
  assert.equal(dropPlacement(90, 100, 30), 'before', 'clamped above the row');
  assert.equal(dropPlacement(112, 100, 30, { allowInside: false }), 'before');
  assert.equal(dropPlacement(118, 100, 30, { allowInside: false }), 'after');
});

test('collectionMove maps drops to moveCollection placements and rejects invalid or no-op moves', () => {
  const tree = treeOf(library());
  assert.equal(collectionMove(tree, 'design', 'design', 'inside'), null, 'onto itself');
  assert.equal(collectionMove(tree, 'design', 'fonts', 'inside'), null, 'into its own descendant');
  assert.equal(collectionMove(tree, 'design', 'missing', 'inside'), null);
  assert.deepEqual(collectionMove(tree, 'dev', 'design', 'inside'), { parentId: 'design', beforeId: '' });
  assert.deepEqual(collectionMove(tree, 'dev', 'design', 'before'), { parentId: '', beforeId: 'design' });
  assert.deepEqual(collectionMove(tree, 'ai', 'design', 'after'), { parentId: '', beforeId: 'dev' });
  assert.equal(collectionMove(tree, 'design', 'ai', 'after'), null, 'already right after it');
  assert.equal(collectionMove(tree, 'dev', 'design', 'after', new Set()), null, 'already right after the collapsed Design');
  assert.deepEqual(collectionMove(tree, 'dev', 'design', 'after', new Set(['design'])), { parentId: 'design', beforeId: 'inspiration' },
    'after an open parent means its first child slot');
  assert.deepEqual(collectionMove(tree, 'fonts', 'inspiration', 'before'), { parentId: 'design', beforeId: 'inspiration' });
  assert.deepEqual(collectionMove(tree, 'fonts', '', 'inside'), { parentId: '', beforeId: '' }, 'the Collections heading means top level');
  assert.equal(collectionMove(tree, 'dev', '', 'inside'), null, 'already last at the top level');
});

test('droppedLinks reads web links from drag data', () => {
  const data = map => type => map[type] || '';
  assert.deepEqual(droppedLinks(data({
    'text/uri-list': '# comment\r\nhttps://example.com/a\r\nhttps://example.com/b\r\nhttps://example.com/a',
    'text/html': '<meta charset="utf-8"><a href="https://example.com/a">Read <b>this</b> &amp; that</a>',
  })), [{ url: 'https://example.com/a', title: 'Read this & that' }, { url: 'https://example.com/b', title: '' }]);
  assert.deepEqual(droppedLinks(data({ 'text/plain': 'https://example.com/x' })), [{ url: 'https://example.com/x', title: '' }]);
  assert.deepEqual(droppedLinks(data({ 'text/plain': 'just some words' })), []);
  assert.deepEqual(droppedLinks(data({ 'text/uri-list': 'javascript:alert(1)\nfile:///etc/passwd' })), [], 'only http and https');
  assert.deepEqual(droppedLinks(() => { throw new Error('protected'); }), [], 'unreadable data is ignored');
});

test('fuzzyScore ranks exact, prefix, word, substring and subsequence matches', () => {
  assert.equal(fuzzyScore('inbox', 'Inbox'), 100);
  assert.ok(fuzzyScore('inb', 'Inbox') > fuzzyScore('nbo', 'Inbox'), 'a prefix beats a substring');
  assert.ok(fuzzyScore('inbox', 'Go to Inbox') > fuzzyScore('inbox', 'main box'), 'a word start beats a scattered subsequence');
  assert.ok(fuzzyScore('inbox', 'main box') > 0, 'subsequences still match');
  assert.ok(fuzzyScore('gti', 'Go to Inbox') >= 50, 'initials match');
  assert.equal(fuzzyScore('inbox', 'inbound links'), 0);
  assert.ok(fuzzyScore('nts', 'Notes') > 0, 'small typos still match');
  assert.equal(fuzzyScore('des', 'Upload files'), 0, 'scattered letters do not');
  assert.equal(fuzzyScore('des', 'settings provider', { loose: false }), 0, 'strict mode needs a prefix or substring');
  assert.ok(fuzzyScore('prov', 'settings provider', { loose: false }) > 0);
  assert.equal(fuzzyScore('xyz', 'inbox'), 0);
  assert.ok(fuzzyScore('go inbox', 'Go to Inbox') > 0, 'every word must match, in any position');
  assert.equal(fuzzyScore('go trash', 'Go to Inbox'), 0);
  assert.ok(fuzzyScore('cafe', 'Café notes') > 0, 'accents are ignored');
  assert.equal(fuzzyScore('', 'anything'), 1);
});

test('rankCommands orders commands by label first and keywords second', () => {
  const label = command => (typeof command.label === 'function' ? 'Switch theme' : command.label);
  assert.equal(rankCommands(COMMANDS, 'new note', label)[0].id, 'note');
  assert.equal(rankCommands(COMMANDS, 'inbox', label)[0].id, 'go-inbox');
  assert.equal(rankCommands(COMMANDS, 'anthropic', label)[0].id, 'ai-models', 'keywords find settings pages');
  assert.equal(rankCommands(COMMANDS, 'dark', label)[0].id, 'theme');
  assert.deepEqual(rankCommands(COMMANDS, 'zzzz', label), []);
  assert.ok(COMMANDS.every(command => command.view || command.action), 'every command does something');
  assert.equal(new Set(COMMANDS.map(command => command.id)).size, COMMANDS.length, 'ids are unique');
});
