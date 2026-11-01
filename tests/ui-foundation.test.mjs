import test from 'node:test';
import assert from 'node:assert/strict';
import { html, raw, cx, attrs, safeHref, safeSrc, plural } from '../extension/ui/html.js';
import { createSelectors, parseQuery, searchRows, sortRows } from '../extension/ui/selectors.js';

test('html escapes interpolated values, joins arrays and keeps nested fragments', () => {
  const name = '<img src=x onerror=alert(1)>';
  const out = String(html`<p title="${name}">${name}${[html`<b>${'a&b'}</b>`, ' & ']}${null}${false}${raw('<i>ok</i>')}</p>`);
  assert.equal(out, '<p title="&lt;img src=x onerror=alert(1)&gt;">&lt;img src=x onerror=alert(1)&gt;<b>a&amp;b</b> &amp; <i>ok</i></p>');
  assert.equal(cx('a', false && 'b', ['c', null, 'd']), 'a c d');
  assert.equal(String(attrs({ title: 'x"y', hidden: true, 'aria-pressed': true, gone: false })), 'title="x&quot;y" hidden aria-pressed="true"');
  assert.equal(plural(1, 'item'), '1 item');
  assert.equal(plural(1200, 'item'), `${(1200).toLocaleString()} items`);
});

test('URL helpers only allow safe schemes', () => {
  assert.equal(safeHref('javascript:alert(1)'), '#');
  assert.equal(safeHref('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeHref('#section'), '#section');
  assert.equal(safeHref('data:text/html,hi'), '#');
  assert.equal(safeSrc('data:image/svg+xml;base64,AAAA'), 'data:image/svg+xml;base64,AAAA');
  assert.equal(safeSrc('javascript:alert(1)'), '');
  assert.equal(safeSrc('assets/../secret.png'), '');
  assert.equal(safeSrc('assets/fonts/x.png'), 'assets/fonts/x.png');
});

test('query parsing understands tags, types, sites and phrases', () => {
  assert.deepEqual(parseQuery('tag:Design #ui type:note site:www.example.com "spring curves" motion'), {
    tokens: ['spring curves', 'motion'], tags: ['design', 'ui'], types: ['note'], sites: ['example.com'],
  });
  const rows = [
    { id: 'a', type: 'note', title: 'Motion notes', tags: ['Design'], url: '', highlights: [{ text: 'spring curves feel right' }] },
    { id: 'b', type: 'bookmark', title: 'Motion', tags: ['design'], url: 'https://example.com/x', highlights: [] },
    { id: 'c', type: 'bookmark', title: 'Other', tags: [], url: 'https://sub.example.com/y', excerpt: 'motion', collectionId: 'k' },
  ];
  assert.deepEqual(searchRows(rows, '#design "spring curves"').map(r => r.id), ['a']);
  assert.deepEqual(searchRows(rows, 'site:example.com motion').map(r => r.id), ['b', 'c']);
  assert.deepEqual(searchRows(rows, 'type:link').map(r => r.id), ['b', 'c']);
  assert.deepEqual(searchRows(rows, 'kitchen', new Map([['k', { name: 'Kitchen' }]])).map(r => r.id), ['c'], 'collection names are searchable');
  assert.deepEqual(sortRows([{ title: 'b', createdAt: '1' }, { title: 'a', createdAt: '2', pinned: true }, { title: 'c', createdAt: '3' }], 'title').map(r => r.title), ['a', 'b', 'c']);
});

function library() {
  const item = (id, props = {}) => ({ id, type: 'bookmark', title: id, url: '', tags: [], collectionId: '', highlights: [], relatedIds: [], createdAt: '2026-01-01', updatedAt: '2026-01-01', ...props });
  return {
    updatedAt: '1',
    settings: {},
    collections: [
      { id: 'root', name: 'Root', parentId: '' },
      { id: 'child', name: 'Child', parentId: 'root', pinned: true },
      { id: 'grand', name: 'Grand', parentId: 'child' },
      { id: 'loop-a', name: 'Loop A', parentId: 'loop-b' },
      { id: 'loop-b', name: 'Loop B', parentId: 'loop-a' },
    ],
    items: [
      item('one', { collectionId: 'root', url: 'https://example.com/a?utm_source=x', tags: ['x'] }),
      item('two', { collectionId: 'grand', url: 'https://example.com/a', favorite: true }),
      item('note', { type: 'note', url: 'https://example.com/a', content: '- [ ] open\n- [x] done\n* [ ] another', relatedIds: ['one'] }),
      item('gone', { deletedAt: '2026-01-02', url: 'https://example.com/a' }),
      item('kept', { archived: true }),
    ],
  };
}

test('selectors count descendants, survive cycles and memoize on updatedAt', () => {
  let lib = library();
  const select = createSelectors(() => lib);
  const tree = select.tree();
  assert.deepEqual(tree.slice(0, 3).map(c => [c.id, c.depth]), [['root', 0], ['child', 1], ['grand', 2]]);
  assert.equal(tree.length, 5, 'cyclic collections are still listed');
  const counts = select.counts();
  assert.equal(counts.all, 3);
  assert.equal(counts.inbox, 1);
  assert.equal(counts.byCollection.root, 1);
  assert.equal(counts.byCollectionDeep.root, 2);
  assert.equal(counts.tasksOpen, 2);
  assert.equal(counts.trash, 1);
  assert.equal(counts.archive, 1);
  assert.equal(counts.duplicates, 1, 'one extra copy of the same canonical URL');
  assert.deepEqual(select.descendants('root'), ['root', 'child', 'grand']);
  assert.deepEqual(select.path('grand').map(c => c.id), ['root', 'child', 'grand']);
  assert.deepEqual(select.itemsForView({ view: 'collection:root' }).map(i => i.id).sort(), ['one', 'two']);
  assert.deepEqual(select.itemsForView({ view: 'trash' }).map(i => i.id), ['gone']);
  assert.deepEqual(select.notesForUrl('https://example.com/a#frag').map(i => i.id), ['note']);
  assert.equal(select.savedForUrl('https://example.com/a').id, 'one');
  assert.deepEqual(select.backlinks('one').map(i => i.id), ['note']);
  assert.equal(select.counts(), counts, 'memoized while updatedAt is unchanged');
  lib = { ...lib, updatedAt: '2', items: lib.items.filter(i => i.id !== 'two') };
  assert.equal(select.counts().byCollectionDeep.root, 1, 'recomputed after a library change');
});

test('"/" typed into an empty, already-focused search field is the focus shortcut, not a query', async () => {
  const { isSearchSlash } = await import('../extension/ui/runtime.js');
  const field = (attrs = {}, value = '') => ({ tagName: 'INPUT', value, id: attrs.id || '',
    hasAttribute: name => Object.hasOwn(attrs, name), getAttribute: name => attrs[name] ?? null });
  const key = (target, extra = {}) => ({ key: '/', ctrlKey: false, metaKey: false, altKey: false, isComposing: false, target, ...extra });
  assert.equal(isSearchSlash(key(field({ 'aria-keyshortcuts': '/' }))), true, 'dashboard search');
  assert.equal(isSearchSlash(key(field({ id: 'search' }))), true, 'top bar search');
  assert.equal(isSearchSlash(key(field({ 'data-view-search': '' }))), true, 'a view’s own search field');
  assert.equal(isSearchSlash(key(field({ 'aria-keyshortcuts': '/' }, 'a'))), false, 'a slash after text is part of the query');
  assert.equal(isSearchSlash(key(field({}))), false, 'other inputs keep their slash');
  assert.equal(isSearchSlash(key(field({ 'aria-keyshortcuts': '/' }), { metaKey: true })), false);
  assert.equal(isSearchSlash(key(field({ 'aria-keyshortcuts': '/' }), { key: '?' })), false);
  assert.equal(isSearchSlash(key({ tagName: 'TEXTAREA', value: '', hasAttribute: () => true, getAttribute: () => '/' })), false);
});
