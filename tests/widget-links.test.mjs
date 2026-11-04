import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLinkUrl, linkKey, linkLabel, folderLinks, orderLinks, placeBefore, shiftId, gridRows, neighborIndex, gridColumns, dropTarget,
  validateLinkRows, planLinkChanges, hasErrors, normalizeQuickLinks, defaultQuickLinks, planQuickLinks, popoverArrow, URL_ERROR, folderConfig, quickConfig,
  DEFAULT_PARENT_NAME, NAME_REQUIRED, findDefaultParent, planWidgetCollection,
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

const col = (id, name, parentId = '', props = {}) => ({ id, name, parentId, ...props });

test('the default parent is the remembered collection, else one named Links folders (top level first)', () => {
  assert.equal(DEFAULT_PARENT_NAME, 'Links folders');
  const collections = [col('dev', 'Development'), col('nested', 'links folders', 'dev'), col('top', 'Links Folders'), col('renamed', 'My widgets')];
  assert.equal(findDefaultParent(collections, 'renamed')?.id, 'renamed', 'a renamed default parent is still found by id');
  assert.equal(findDefaultParent(collections, 'gone')?.id, 'top', 'a deleted remembered one falls back to the name, top level first');
  assert.equal(findDefaultParent([col('nested', 'Links folders', 'dev')], '')?.id, 'nested');
  assert.equal(findDefaultParent([col('x', 'Links folders', '', { deletedAt: '2026-01-01' })], 'x'), null, 'soft-deleted collections do not count');
  assert.equal(findDefaultParent([], ''), null);
  assert.equal(findDefaultParent(undefined, 'x'), null);
});

test('collection widget settings: a name plus a chosen collection makes a subcollection, never a rename', () => {
  const collections = [col('dev', 'Development'), col('repos', 'My repos', 'dev'), col('lf', 'Links folders'), col('tools', 'Dev tools', 'lf')];
  assert.deepEqual(planWidgetCollection({ collectionId: 'dev', name: '' }, collections, 'lf'), { kind: 'show', collectionId: 'dev' });
  assert.deepEqual(planWidgetCollection({ collectionId: 'dev', name: '  Side projects ' }, collections, 'lf'), { kind: 'create', name: 'Side projects', parentId: 'dev' });
  assert.deepEqual(planWidgetCollection({ collectionId: '', name: 'Reading' }, collections, 'lf'), { kind: 'create', name: 'Reading', parentId: '' },
    'no chosen collection: the default parent (created on save when missing)');
  assert.deepEqual(planWidgetCollection({ name: 'Reading' }, collections, ''), { kind: 'create', name: 'Reading', parentId: '' });
  assert.deepEqual(planWidgetCollection({ collectionId: 'dev', name: 'my REPOS' }, collections, 'lf'), { kind: 'exists', collectionId: 'repos', name: 'My repos' });
  assert.deepEqual(planWidgetCollection({ name: 'dev tools' }, collections, 'lf'), { kind: 'exists', collectionId: 'tools', name: 'Dev tools' });
  assert.deepEqual(planWidgetCollection({ collectionId: 'dev', name: 'Dev tools' }, collections, 'lf').kind, 'create', 'same name under another parent is fine');
  assert.deepEqual(planWidgetCollection({}, collections, 'lf'), { kind: 'invalid', error: NAME_REQUIRED });
  assert.deepEqual(planWidgetCollection({ collectionId: 'deleted', name: ' ' }, collections, 'lf'), { kind: 'invalid', error: NAME_REQUIRED },
    'a collection that no longer exists cannot be shown');
  assert.deepEqual(planWidgetCollection({ collectionId: 'deleted', name: 'Reading' }, collections, 'lf'), { kind: 'create', name: 'Reading', parentId: '' },
    'a vanished parent falls back to the default parent');
});

test('quick links without a stored id keep the same id on every read', () => {
  const stored = [{ url: 'https://a.com' }, { url: 'https://b.com', title: 'B' }, { url: 'https://a.com' }, { id: 'keep', url: 'https://c.com' }];
  const first = normalizeQuickLinks(stored).map(link => link.id);
  assert.deepEqual(normalizeQuickLinks(stored).map(link => link.id), first);
  assert.equal(new Set(first).size, 4, 'two entries with the same address still get distinct ids');
  assert.equal(first[3], 'keep');
  const clash = normalizeQuickLinks([{ id: 'x', url: 'https://a.com' }, { id: 'x', url: 'https://b.com' }]).map(link => link.id);
  assert.deepEqual(clash, ['x', 'x_2'], 'duplicate stored ids are made unique, the same way each time');
});

test('quick links Undo keeps edits made after the add or remove', async () => {
  const { undoAddLinks, undoRemoveLink } = await import('../extension/ui/widgets/quick-links.js');
  const a = { id: 'a', title: '', url: 'https://a.com/' }, b = { id: 'b', title: '', url: 'https://b.com/' }, c = { id: 'c', title: '', url: 'https://c.com/' };
  // Add c, then undo straight away: back to the old list.
  assert.deepEqual(undoAddLinks([a, b, c], { previous: [a, b], saved: [a, b, c], addedIds: ['c'] }), [a, b]);
  // Add c, then remove a, then undo the add: only c goes; a stays removed.
  assert.deepEqual(undoAddLinks([b, c], { previous: [a, b], saved: [a, b, c], addedIds: ['c'] }), [b]);
  // Remove b, then undo: b returns to its place.
  assert.deepEqual(undoRemoveLink([a, c], { previous: [a, b, c], saved: [a, c], link: b, beforeId: 'c' }), [a, b, c]);
  // Remove b, add d, then undo the removal: d is kept and b goes back before c.
  const d = { id: 'd', title: '', url: 'https://d.com/' };
  assert.deepEqual(undoRemoveLink([a, c, d], { previous: [a, b, c], saved: [a, c], link: b, beforeId: 'c' }), [a, b, c, d]);
  // Its follower is gone too: b goes to the end. Already back: nothing doubles.
  assert.deepEqual(undoRemoveLink([a, d], { previous: [a, b, c], saved: [a, c], link: b, beforeId: 'c' }), [a, d, b]);
  assert.deepEqual(undoRemoveLink([a, b, d], { previous: [a, b, c], saved: [a, c], link: b, beforeId: 'c' }), [a, b, d]);
});

test('a site touch icon is used only when it is square-ish and sharp enough for the tile', async () => {
  const { usableTouchIcon } = await import('../extension/ui/widgets/links/favicons.js');
  assert.equal(usableTouchIcon(180, 180, 36, 2), true);
  assert.equal(usableTouchIcon(120, 120, 44, 2), true, '96 px or more is always enough');
  assert.equal(usableTouchIcon(57, 57, 36, 2), false, 'an old 57 px icon would blur on a 2x tile');
  assert.equal(usableTouchIcon(57, 57, 36, 1), true);
  assert.equal(usableTouchIcon(400, 200, 36, 2), false, 'a banner image is not an icon');
  assert.equal(usableTouchIcon(0, 0, 36, 1), false);
});

test('a tile grid scrolls only when tiles are cut off, not for its own bottom padding', async () => {
  const { gridOverflows } = await import('../extension/ui/widgets/links/shared.js');
  assert.equal(gridOverflows(400, 400, 20), false);
  assert.equal(gridOverflows(418, 400, 20), false, 'only padding is hidden: every tile shows');
  assert.equal(gridOverflows(420.5, 400, 20), false, 'sub-pixel rounding');
  assert.equal(gridOverflows(460, 400, 20), true);
  assert.equal(gridOverflows(405, 400, 0), true);
});
