import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLinkUrl, linkKey, linkLabel, folderLinks, orderLinks, placeBefore, shiftId, gridRows, neighborIndex, gridColumns, dropTarget,
  validateLinkRows, planLinkChanges, hasErrors, normalizeQuickLinks, defaultQuickLinks, planQuickLinks, popoverArrow, URL_ERROR, folderConfig, quickConfig,
} from '../extension/ui/widgets/links/model.js';

const item = (id, props = {}) => ({ id, type: 'bookmark', title: id, url: `https://${id}.example/`, collectionId: 'c1', deletedAt: null, archived: false,
  createdAt: '2026-01-01T00:00:00.000Z', ...props });

test('typed URLs become http(s) addresses; other schemes and junk are refused', () => {
  assert.equal(normalizeLinkUrl('github.com'), 'https://github.com/');
  assert.equal(normalizeLinkUrl('  github.com/anthropics?tab=repos  '), 'https://github.com/anthropics?tab=repos');
  assert.equal(normalizeLinkUrl('http://example.com/a'), 'http://example.com/a');
  assert.equal(normalizeLinkUrl('localhost:3000/app'), 'https://localhost:3000/app');
  assert.equal(normalizeLinkUrl('192.168.1.10:8080'), 'https://192.168.1.10:8080/');
  assert.equal(normalizeLinkUrl('//cdn.example.com/x'), 'https://cdn.example.com/x');
  assert.equal(normalizeLinkUrl('bücher.de'), 'https://xn--bcher-kva.de/');
  for (const bad of ['', '   ', 'hello', 'hello world', 'javascript:alert(1)', 'javascript:alert(document.cookie)', 'mailto:a@b.com',
    'ftp://example.com', 'data:text/html,hi', 'https://user:pw@example.com', 'chrome://settings', 'file:///etc/passwd', null, undefined]) {
    assert.equal(normalizeLinkUrl(bad), '', String(bad));
  }
});

test('link keys ignore tracking parameters and trailing slashes; labels fall back to the host', () => {
  assert.equal(linkKey('https://a.com/x/?utm_source=x'), linkKey('https://a.com/x'));
  assert.equal(linkKey('not a url'), '');
  assert.equal(linkLabel({ title: '  Docs ', url: 'https://docs.a.com' }), 'Docs');
  assert.equal(linkLabel({ title: '', url: 'https://www.github.com/x' }), 'github.com');
  assert.equal(linkLabel({}), 'Link');
});

test('a folder shows live web links of its collections only', () => {
  const items = [
    item('a'), item('b', { type: 'article' }), item('c', { type: 'video' }),
    item('note', { type: 'note' }), item('file', { type: 'file' }), item('gone', { deletedAt: '2026-02-01' }), item('old', { archived: true }),
    item('nourl', { url: '' }), item('other', { collectionId: 'c2' }), item('inbox', { collectionId: '' }), item('ftp', { url: 'ftp://x.example/' }),
  ];
  assert.deepEqual(folderLinks(items, ['c1']).map(i => i.id), ['a', 'b', 'c']);
  assert.deepEqual(folderLinks(items, ['c1', 'c2']).map(i => i.id), ['a', 'b', 'c', 'other']);
  assert.deepEqual(folderLinks(items, ['']).map(i => i.id), [], 'an empty collection id never selects the Inbox');
});

test('manual order keeps the saved order, skips stale ids and appends new links oldest first', () => {
  const rows = [
    item('a', { createdAt: '2026-01-03T00:00:00Z', title: 'Zed' }), item('b', { createdAt: '2026-01-01T00:00:00Z', title: 'alpha' }),
    item('c', { createdAt: '2026-01-02T00:00:00Z', title: 'Beta' }), item('d', { createdAt: '2026-01-05T00:00:00Z', title: 'beta 2' }),
  ];
  assert.deepEqual(orderLinks(rows, { sort: 'manual', order: ['d', 'gone', 'a'] }).map(i => i.id), ['d', 'a', 'b', 'c']);
  assert.deepEqual(orderLinks(rows, { sort: 'manual' }).map(i => i.id), ['b', 'c', 'a', 'd']);
  assert.deepEqual(orderLinks(rows, { sort: 'manual', order: 'nonsense' }).map(i => i.id), ['b', 'c', 'a', 'd']);
  assert.deepEqual(orderLinks(rows, { sort: 'title' }).map(i => i.id), ['b', 'c', 'd', 'a']);
  assert.deepEqual(orderLinks(rows, { sort: 'newest' }).map(i => i.id), ['d', 'a', 'c', 'b']);
  assert.deepEqual(orderLinks(rows, { sort: 'oldest' }).map(i => i.id), ['b', 'c', 'a', 'd']);
  assert.deepEqual(rows.map(i => i.id), ['a', 'b', 'c', 'd'], 'input is not mutated');
});

test('reordering places links before a target or at the end, and shifts by keyboard', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(placeBefore(ids, ['d'], 'a'), ['d', 'a', 'b', 'c']);
  assert.deepEqual(placeBefore(ids, ['a'], 'c'), ['b', 'a', 'c', 'd']);
  assert.deepEqual(placeBefore(ids, ['a'], ''), ['b', 'c', 'd', 'a']);
  assert.deepEqual(placeBefore(ids, ['b'], 'b'), ids, 'dropping on itself is a no-op');
  assert.deepEqual(placeBefore(ids, ['new'], 'b'), ['a', 'new', 'b', 'c', 'd'], 'new ids are inserted');
  assert.deepEqual(placeBefore(ids, ['x'], 'missing'), ['a', 'b', 'c', 'd', 'x']);
  assert.deepEqual(shiftId(ids, 'b', 1), ['a', 'c', 'b', 'd']);
  assert.deepEqual(shiftId(ids, 'b', -5), ['b', 'a', 'c', 'd']);
  assert.deepEqual(shiftId(ids, 'd', 2), ids);
  assert.deepEqual(shiftId(ids, 'zz', 1), ids);
});

test('arrow keys move through a wrapping grid by row and column', () => {
  // 3 columns, 7 tiles: rows [0,1,2] [3,4,5] [6]
  const positions = Array.from({ length: 7 }, (_, i) => ({ top: Math.floor(i / 3) * 90 + (i % 2 ? 0.4 : 0), left: (i % 3) * 80 }));
  assert.deepEqual(gridRows(positions), [[0, 1, 2], [3, 4, 5], [6]]);
  assert.equal(gridColumns(positions), 3);
  assert.equal(neighborIndex(positions, 4, 'ArrowUp'), 1);
  assert.equal(neighborIndex(positions, 1, 'ArrowDown'), 4);
  assert.equal(neighborIndex(positions, 5, 'ArrowDown'), 6, 'a short last row clamps to its last tile');
  assert.equal(neighborIndex(positions, 6, 'ArrowDown'), 6);
  assert.equal(neighborIndex(positions, 0, 'ArrowUp'), 0);
  assert.equal(neighborIndex(positions, 2, 'ArrowRight'), 3);
  assert.equal(neighborIndex(positions, 0, 'ArrowLeft'), 0);
  assert.equal(neighborIndex(positions, 2, 'ArrowRight', { rtl: true }), 1);
  assert.equal(neighborIndex(positions, 3, 'Home'), 0);
  assert.equal(neighborIndex(positions, 3, 'End'), 6);
  assert.equal(neighborIndex([], 0, 'ArrowRight'), -1);
});

test('drops land before the tile under the pointer, or after the last tile of the nearest row', () => {
  // 3 columns of 80×90 tiles: a b c / d e
  const rects = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, top: Math.floor(i / 3) * 90, left: (i % 3) * 80, width: 80, height: 90 }));
  assert.deepEqual(dropTarget(rects, 10, 40), { before: 'a', mark: 'a', side: 'before' });
  assert.deepEqual(dropTarget(rects, 130, 40), { before: 'c', mark: 'c', side: 'before' });
  assert.deepEqual(dropTarget(rects, 230, 40), { before: 'd', mark: 'c', side: 'after' }, 'past the end of a row continues on the next one');
  assert.deepEqual(dropTarget(rects, 200, 130), { before: '', mark: 'e', side: 'after' });
  assert.deepEqual(dropTarget(rects, 10, 400), { before: 'd', mark: 'd', side: 'before' }, 'below the grid uses the last row');
  assert.deepEqual(dropTarget(rects, 230, 40, { rtl: true }), { before: 'a', mark: 'a', side: 'before' });
  assert.deepEqual(dropTarget([], 0, 0), { before: '', mark: '', side: 'after' });
  const rows = ['a', 'b', 'c'].map((id, i) => ({ id, top: i * 40, left: 0, width: 300, height: 40 }));
  assert.deepEqual(dropTarget(rows, 290, 45, { vertical: true }), { before: 'b', mark: 'b', side: 'before' }, 'lists ignore the horizontal position');
  assert.deepEqual(dropTarget(rows, 5, 70, { vertical: true }), { before: 'c', mark: 'c', side: 'before' });
  assert.deepEqual(dropTarget(rows, 5, 200, { vertical: true }), { before: '', mark: 'c', side: 'after' });
});

test('folder settings plan creates, updates, trashes and orders links', () => {
  const existing = [
    item('a', { url: 'https://a.example/', title: 'A' }), item('b', { url: 'https://b.example/', title: 'B' }),
    item('c', { url: 'https://c.example/', title: 'c.example' }),
  ];
  const plan = planLinkChanges(existing, [
    { id: 'b', url: 'https://b.example/new', title: 'B' },
    { url: 'new.example', title: 'New' },
    { id: 'a', url: 'https://a.example/', title: 'A' },
    { url: '', title: '' },
    { id: 'c', url: 'https://c.example/', title: '' },
  ]);
  assert.equal(hasErrors(plan), false);
  assert.deepEqual(plan.create, [{ url: 'https://new.example/', title: 'New' }]);
  assert.deepEqual(plan.update, [{ id: 'b', patch: { url: 'https://b.example/new' } }], 'a cleared title that already equals the host changes nothing');
  assert.deepEqual(plan.trash, []);
  assert.deepEqual(plan.sequence, [{ id: 'b' }, { create: 0 }, { id: 'a' }, { id: 'c' }]);

  const removed = planLinkChanges(existing, [{ id: 'a', url: 'https://a.example/', title: 'Renamed' }]);
  assert.deepEqual(removed.trash, ['b', 'c']);
  assert.deepEqual(removed.update, [{ id: 'a', patch: { title: 'Renamed' } }]);
  const cleared = planLinkChanges(existing, [{ id: 'a', url: 'https://a.example/', title: '' }]);
  assert.deepEqual(cleared.update, [{ id: 'a', patch: { title: 'a.example' } }]);
});

test('invalid and duplicate rows are reported and never cost an existing link', () => {
  const existing = [item('a', { url: 'https://a.example/', title: 'A' }), item('b', { url: 'https://b.example/', title: 'B' })];
  const plan = planLinkChanges(existing, [
    { id: 'a', url: 'not a url', title: 'A' },
    { url: 'https://b.example/?utm_source=x', title: 'dupe of b?' },
    { id: 'b', url: 'https://b.example', title: 'B' },
    { url: '', title: 'Only a title' },
  ]);
  assert.equal(hasErrors(plan), true);
  assert.deepEqual(plan.errors, { 0: URL_ERROR, 2: 'This link is already in the list.', 3: 'Enter a URL for this link.' });
  assert.deepEqual(plan.trash, [], 'the mistyped link a and the duplicate b both stay');
  const { errors } = validateLinkRows([{ id: 'x', url: '' }]);
  assert.deepEqual(errors, { 0: 'Enter a URL, or remove this link.' });
});

test('quick links are cleaned up, defaulted and planned from settings rows', () => {
  const cleaned = normalizeQuickLinks([{ id: 'x', title: ' Mail ', url: 'mail.google.com' }, { id: 'x', url: 'https://a.example' }, { url: 'javascript:alert(1)' }, null]);
  assert.equal(cleaned.length, 2);
  assert.deepEqual(cleaned[0], { id: 'x', title: 'Mail', url: 'https://mail.google.com/' });
  assert.notEqual(cleaned[1].id, 'x', 'duplicate ids are replaced');
  assert.ok(defaultQuickLinks().length >= 4);
  assert.ok(defaultQuickLinks().every(link => link.url.startsWith('https://') && link.id && link.title));
  const ok = planQuickLinks([{ id: 'q1', url: 'github.com', title: '' }, { url: '', title: '' }]);
  assert.deepEqual(ok.links, [{ id: 'q1', title: '', url: 'https://github.com/' }]);
  const bad = planQuickLinks([{ url: 'nope' }]);
  assert.equal(bad.links, null);
  assert.deepEqual(bad.errors, { 0: URL_ERROR });
});

test('the popup arrow points back at its anchor from the facing edge', () => {
  const anchor = { left: 100, top: 100, width: 80, height: 80 };
  assert.deepEqual(popoverArrow(anchor, { left: 5, top: 190, width: 270, height: 380 }), { edge: 'top', offset: 135 });
  assert.deepEqual(popoverArrow(anchor, { left: 5, top: -300, width: 270, height: 380 }), { edge: 'bottom', offset: 135 });
  assert.deepEqual(popoverArrow({ left: 0, top: 0, width: 10, height: 10 }, { left: 0, top: 20, width: 270, height: 100 }), { edge: 'top', offset: 20 }, 'clamped to the inset');
});

test('widget configs fill defaults and drop invalid values', () => {
  assert.deepEqual(folderConfig({}), { collectionId: '', includeSubcollections: false, openIn: 'current', sort: 'manual', order: [], showLabels: true, tileSize: 'md' });
  assert.deepEqual(folderConfig({ collectionId: 'c', openIn: 'background', sort: 'title', order: ['a', 'a', 3, '', 'b'], showLabels: false, tileSize: 'lg', includeSubcollections: true }),
    { collectionId: 'c', includeSubcollections: true, openIn: 'background', sort: 'title', order: ['a', 'b'], showLabels: false, tileSize: 'lg' });
  assert.deepEqual(folderConfig({ openIn: 'modal', sort: 'random', tileSize: 'xl', collectionId: 5 }), folderConfig({}));
  assert.deepEqual(folderConfig(null), folderConfig({}));
  const quick = quickConfig({});
  assert.equal(quick.style, 'tiles');
  assert.ok(quick.links.length > 0, 'a new widget starts with a few well-known sites');
  assert.deepEqual(quickConfig({ links: [] }).links, [], 'an emptied list stays empty');
  assert.equal(quickConfig({ style: 'chips', openIn: 'new', showLabels: false }).style, 'chips');
  assert.equal(quickConfig({ style: 'cloud' }).style, 'tiles');
});
