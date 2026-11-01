import test from 'node:test';
import assert from 'node:assert/strict';
import { hueForDomain, tileHue, notePreviewSource, readingMinutes } from '../extension/ui/cards.js';
import { layoutFor, viewFacets, selectRange, dateGroupLabel, groupByDate, parseTags, unionTags, undoFor, planMerge, confirmTrash, trashItems } from '../extension/ui/library.js';
import { findHighlightRanges, readerSource, reminderPresets, reminderLabel, highlightColor } from '../extension/ui/detail.js';
import { filterMapItems, similarEdges, relaxLayout, crowdedLabels, labelAnchor, nodeRadius, MAP_WIDTH, MAP_HEIGHT } from '../extension/ui/map.js';
import { buildRelationshipGraph } from '../extension/lib/library-views.js';

const item = (id, props = {}) => ({ id, type: 'bookmark', title: id, url: '', tags: [], collectionId: '', highlights: [], relatedIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...props });

test('generated covers use the collection hue, then a type hue, then a stable site hue', () => {
  assert.equal(hueForDomain('example.com'), hueForDomain('example.com'));
  assert.equal(hueForDomain(''), 'gray');
  assert.deepEqual(tileHue(item('a', { url: 'https://x.dev' }), { color: '#d9467a' }), { name: 'pink' });
  assert.deepEqual(tileHue(item('a'), { color: '#123456' }), { hex: '#123456' }, 'custom collection colors keep their hex');
  assert.deepEqual(tileHue(item('n', { type: 'note' }), null), { name: 'yellow' });
  assert.deepEqual(tileHue(item('b', { url: 'https://www.example.com/a' }), null), { name: hueForDomain('example.com') });
});

test('note previews drop a heading that repeats the title and reading time rounds up to a minute', () => {
  assert.equal(notePreviewSource('# Design principles\n\nStart with space.', 'Design principles'), 'Start with space.');
  assert.equal(notePreviewSource('# Other heading\nBody', 'Design principles'), '# Other heading\nBody');
  assert.equal(notePreviewSource('', 'x'), '');
  assert.equal(readingMinutes(''), 0);
  assert.equal(readingMinutes('word '.repeat(10)), 1);
  assert.equal(readingMinutes('word '.repeat(2300)), 10);
});

test('layouts follow the saved choice per surface, with sensible defaults', () => {
  assert.equal(layoutFor({}, 'all'), 'list');
  assert.equal(layoutFor({}, 'type:image'), 'masonry');
  assert.equal(layoutFor({ layouts: { all: 'headlines' } }, 'all'), 'headlines');
  assert.equal(layoutFor({ layouts: { all: 'nonsense' } }, 'all'), 'list');
  assert.equal(layoutFor({}, 'collection:x', 'side'), 'cards');
  assert.equal(layoutFor({}, 'favorites', 'side'), 'list');
  assert.equal(layoutFor({ sideLayouts: { 'collection:x': 'headlines' } }, 'collection:x', 'side'), 'cards', 'headlines is not a side-panel layout');
  assert.equal(layoutFor({ sideLayouts: { 'collection:x': 'masonry' } }, 'collection:x', 'side'), 'masonry');
});

test('facets count types, top tags case-insensitively and untagged items', () => {
  const rows = [item('a', { tags: ['UI', 'type'] }), item('b', { type: 'note', tags: ['ui'] }), item('c')];
  const facets = viewFacets(rows, { tagLimit: 1 });
  assert.equal(facets.total, 3);
  assert.deepEqual(facets.types, { bookmark: 2, note: 1 });
  assert.equal(facets.untagged, 1);
  assert.deepEqual(facets.tags, [{ name: 'UI', count: 2 }]);
});

test('range selection spans the anchor and target in display order', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(selectRange(order, 'b', 'd'), ['b', 'c', 'd']);
  assert.deepEqual(selectRange(order, 'd', 'b'), ['b', 'c', 'd']);
  assert.deepEqual(selectRange(order, 'gone', 'c'), ['c']);
  assert.deepEqual(selectRange(order, 'a', 'missing'), []);
});

test('date groups read Today, Yesterday, Previous 7 days, then months', () => {
  const now = new Date(2026, 9, 28, 15, 0);
  const at = (y, m, d) => new Date(y, m, d, 10).toISOString();
  assert.equal(dateGroupLabel(at(2026, 9, 28), now, 'en-US'), 'Today');
  assert.equal(dateGroupLabel(at(2026, 9, 27), now, 'en-US'), 'Yesterday');
  assert.equal(dateGroupLabel(at(2026, 9, 23), now, 'en-US'), 'Previous 7 days');
  assert.equal(dateGroupLabel(at(2026, 9, 2), now, 'en-US'), 'Earlier in October');
  assert.equal(dateGroupLabel(at(2026, 8, 30), now, 'en-US'), 'September');
  assert.equal(dateGroupLabel(at(2025, 11, 30), now, 'en-US'), 'December 2025');
  assert.equal(dateGroupLabel('not a date', now), 'Undated');
  const groups = groupByDate([
    item('p', { pinned: true, createdAt: at(2025, 0, 1) }), item('t1', { createdAt: at(2026, 9, 28) }), item('t2', { createdAt: at(2026, 9, 28) }), item('y', { createdAt: at(2026, 9, 27) }),
  ], { now, locale: 'en-US' });
  assert.deepEqual(groups.map(g => [g.label, g.items.map(i => i.id)]), [['Pinned', ['p']], ['Today', ['t1', 't2']], ['Yesterday', ['y']]]);
});

test('tag input parsing, tag union and undo patches', () => {
  assert.deepEqual(parseTags('design, #Reading,  , design #ux'), ['design', 'Reading', 'ux']);
  assert.deepEqual(unionTags(['Design', 'ui'], ['design', 'type']), ['Design', 'ui', 'type']);
  const before = { a: { id: 'a', collectionId: 'x', favorite: true, tags: ['t'] }, b: { id: 'b' } };
  assert.deepEqual(undoFor([{ id: 'a', patch: { collectionId: 'y', tags: ['t', 'u'] } }, { id: 'b', patch: { deletedAt: 'now', tags: ['z'], collectionId: 'y' } }], id => before[id]), [
    { id: 'a', patch: { collectionId: 'x', tags: ['t'] } },
    { id: 'b', patch: { deletedAt: null, tags: [], collectionId: '' } },
  ]);
});

test('merging duplicates keeps the newest copy, unions its data, trashes the rest and repoints links', () => {
  const keep = item('new', { url: 'https://a.com', tags: ['ui'], highlights: [{ id: 'h1', text: 'Same quote' }], relatedIds: ['old', 'x'], content: '', excerpt: '' });
  const old = item('old', { url: 'https://a.com/', tags: ['UI', 'design'], favorite: true, highlights: [{ id: 'h2', text: ' same  quote ' }, { id: 'h3', text: 'Other' }], relatedIds: ['y'], content: 'My note', excerpt: 'About A', collectionId: 'c1', cover: 'https://a.com/c.png' });
  const linker = item('linker', { relatedIds: ['old', 'new'] });
  const changes = planMerge([keep, old], [keep, old, linker, item('gone', { deletedAt: 'x', relatedIds: ['old'] })], { now: 'NOW' });
  assert.deepEqual(changes[0], { id: 'new', patch: {
    tags: ['ui', 'design'],
    highlights: [{ id: 'h1', text: 'Same quote' }, { id: 'h3', text: 'Other' }],
    relatedIds: ['x', 'y'],
    content: 'My note', excerpt: 'About A', cover: 'https://a.com/c.png', collectionId: 'c1', favorite: true,
  } });
  assert.deepEqual(changes[1], { id: 'old', patch: { deletedAt: 'NOW' } });
  assert.deepEqual(changes[2], { id: 'linker', patch: { relatedIds: ['new'] } }, 'links to the removed copy point at the kept one, without duplicates');
  assert.equal(changes.length, 3, 'trashed items are left alone');
  assert.deepEqual(planMerge([keep]), []);
  const both = planMerge([item('k', { content: 'A' }), item('r', { content: 'B' })]);
  assert.equal(both[0].patch.content, 'A\n\n---\n\nB');
});

test('reader highlights match across case and whitespace, skip missing text and never overlap', () => {
  const text = 'Every  extra unit of\ninformation competes. Prioritize the content.';
  const ranges = findHighlightRanges(text, [
    { id: 'a', text: 'every extra unit of information', color: 'green' },
    { id: 'b', text: 'not in the text' },
    { id: 'c', text: 'unit of information competes', color: 'amber' },
    { id: 'd', text: 'Prioritize', color: 'weird' },
  ]);
  assert.deepEqual(ranges.map(r => [r.id, text.slice(r.start, r.end), r.color]), [['a', 'Every  extra unit of\ninformation', 'green'], ['d', 'Prioritize', 'yellow']]);
  assert.equal(highlightColor('amber'), 'amber');
  assert.equal(highlightColor('unknown'), 'yellow');
});

test('reader source turns captured lines into paragraphs and keeps Markdown files as written', () => {
  assert.equal(readerSource('First line\n\n\n  Second line  \r\nThird'), 'First line\nSecond line\nThird');
  const md = '# Title\n\n- item\n\nText';
  assert.equal(readerSource(md), md);
});

test('reminder presets and labels', () => {
  const now = new Date(2026, 9, 28, 10, 20);
  const presets = reminderPresets(now);
  assert.deepEqual(presets.map(p => p.id), ['later', 'tomorrow', 'next-week']);
  assert.equal(new Date(presets[0].iso).getHours(), 13);
  assert.equal(new Date(presets[1].iso).getDate(), 29);
  assert.equal(new Date(presets[1].iso).getHours(), 9);
  assert.equal(new Date(presets[2].iso).getDay(), 1, 'next week means next Monday');
  assert.equal(reminderPresets(new Date(2026, 9, 28, 22, 30)).some(p => p.id === 'later'), false, 'no "later today" late at night');
  assert.match(reminderLabel(presets[1].iso, now, 'en-US'), /^Tomorrow, 9:00/);
  assert.match(reminderLabel(new Date(2026, 9, 28, 18).toISOString(), now, 'en-US'), /^Today, 6:00/);
  assert.equal(reminderLabel('nope'), '');
});

test('map filtering keeps matches plus their direct neighbours and the chosen type', () => {
  const rows = [
    item('a', { title: 'Agents overview', relatedIds: ['b'] }), item('b', { type: 'note', title: 'Notes' }),
    item('c', { title: 'Unrelated', relatedIds: ['a'] }), item('d', { type: 'image', title: 'Picture' }),
  ];
  const { items, matches } = filterMapItems(rows, { query: 'agents' });
  assert.deepEqual(items.map(i => i.id), ['a', 'b', 'c']);
  assert.deepEqual([...matches], ['a']);
  assert.deepEqual(filterMapItems(rows, { type: 'media' }).items.map(i => i.id), ['d']);
  assert.deepEqual(filterMapItems(rows, { type: 'note' }).items.map(i => i.id), ['b']);
});

test('similar edges skip linked pairs, unknown nodes and repeats', () => {
  const graph = { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [{ source: 'a', target: 'b' }] };
  const edges = similarEdges([['a', [{ id: 'b', score: 0.9 }, { id: 'c', score: 0.8 }, { id: 'zz' }]], ['c', [{ id: 'a', score: 0.8 }, { id: 'c' }]]], graph);
  assert.deepEqual(edges, [{ source: 'a', target: 'c', score: 0.8 }]);
});

test('force layout is deterministic, stays in the 920×580 frame and pulls linked items together', () => {
  const rows = [
    item('a', { relatedIds: ['b'] }), item('b', { relatedIds: ['c'] }), item('c'),
    item('x', { relatedIds: ['y'] }), item('y'),
    ...Array.from({ length: 10 }, (_, i) => item(`o${i}`)),
  ];
  const graph = buildRelationshipGraph(rows);
  const one = relaxLayout(graph);
  assert.deepEqual(one, relaxLayout(graph));
  assert.deepEqual(one.edges, graph.edges, 'edges and the graph contract are untouched');
  for (const node of one.nodes) {
    assert.ok(node.x >= 0 && node.x <= MAP_WIDTH && node.y >= 0 && node.y <= MAP_HEIGHT, `${node.id} inside the frame`);
  }
  const pos = new Map(one.nodes.map(n => [n.id, n]));
  const dist = (p, q) => Math.hypot(pos.get(p).x - pos.get(q).x, pos.get(p).y - pos.get(q).y);
  const linked = (dist('a', 'b') + dist('b', 'c') + dist('x', 'y')) / 3;
  const ids = [...pos.keys()];
  let total = 0, pairs = 0;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { total += dist(ids[i], ids[j]); pairs++; }
  assert.ok(linked < total / pairs, 'linked items sit closer than the average pair');
  assert.deepEqual(relaxLayout({ nodes: [{ id: 's', x: 1, y: 1, degree: 0 }], edges: [] }).nodes[0], { id: 's', x: 460, y: 290, degree: 0 });
  assert.equal(nodeRadius(0) < nodeRadius(4), true);
});

test('crowded labels hide the lower-degree label of two overlapping ones', () => {
  const nodes = [{ id: 'hub', title: 'A long title for the hub', x: 100, y: 100, degree: 3 }, { id: 'leaf', title: 'Another long title', x: 120, y: 102, degree: 1 }, { id: 'far', title: 'Far away', x: 600, y: 400, degree: 0 }];
  assert.deepEqual([...crowdedLabels(nodes)], ['leaf']);
});

test('map labels near the frame edge anchor inward', () => {
  assert.deepEqual(labelAnchor({ title: 'Centered label', x: 200, degree: 0 }, 400), { anchor: 'middle', x: 0 });
  assert.equal(labelAnchor({ title: 'A rather long label near the left', x: 20, degree: 0 }, 400).anchor, 'start');
  assert.equal(labelAnchor({ title: 'A rather long label near the right', x: 390, degree: 0 }, 400).anchor, 'end');
});

// A fake ctx for trashItems: two live items, recorded confirm prompts and writes.
function trashCtx(settings, answer) {
  const items = [{ id: 'a', title: 'Alpha' }, { id: 'b', title: '' }];
  const seen = { asked: [], writes: [] };
  const ctx = {
    library: { settings, items }, state: { selection: new Set(), panel: null },
    select: { byId: id => items.find(item => item.id === id) },
    confirm: async options => { seen.asked.push(options); return answer; },
    store: { bulkUpdateItems: async changes => { seen.writes.push(changes); return changes; } },
    toast() {}, render() {}, closePanel() {},
  };
  return { ctx, seen };
}

test('moving to Trash asks first only when "Confirm before moving items to Trash" is on', async () => {
  const off = trashCtx({}, false);
  assert.equal(await confirmTrash(off.ctx, off.ctx.library.items), true);
  await trashItems(off.ctx, ['a']);
  assert.equal(off.seen.asked.length, 0);
  assert.deepEqual(off.seen.writes[0].map(change => change.id), ['a']);

  const declined = trashCtx({ confirmDelete: true }, false);
  await trashItems(declined.ctx, ['a', 'b']);
  assert.equal(declined.seen.asked[0].title, 'Move 2 items to Trash?');
  assert.equal(declined.seen.asked[0].confirmLabel, 'Move to Trash');
  assert.equal(declined.seen.writes.length, 0, 'nothing moves when the prompt is cancelled');

  const accepted = trashCtx({ confirmDelete: true }, true);
  await trashItems(accepted.ctx, ['a']);
  assert.equal(accepted.seen.asked[0].title, 'Move “Alpha” to Trash?');
  assert.deepEqual(accepted.seen.writes[0].map(change => change.id), ['a']);
  const untitled = trashCtx({ confirmDelete: true }, true);
  await confirmTrash(untitled.ctx, [untitled.ctx.library.items[1]]);
  assert.equal(untitled.seen.asked[0].title, 'Move this item to Trash?');
  assert.equal(await confirmTrash(untitled.ctx, []), true, 'no prompt when nothing would move');
});
