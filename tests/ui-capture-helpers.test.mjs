import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCollectionPath, pathNames, filterCollectionTree, planCollectionPath, colorForName, splitTags, mergeTags, removeTag, matchTags,
  reminderPresets, toDateTimeLocal, formatReminder,
} from '../extension/ui/pickers.js';
import { detectUrl, parseHtmlMetadata, fileKind, defaultTabsCollectionName, localTagSuggestions, MAX_FILE_BYTES } from '../extension/ui/quick-add.js';
import { contentWords, relatedLexical, isWebUrl } from '../extension/ui/page.js';
import { COLLECTION_COLORS } from '../extension/ui/icons.js';

const rows = [
  { id: 'design', name: 'Design', parentId: '', depth: 0 },
  { id: 'insp', name: 'Inspiration', parentId: 'design', depth: 1 },
  { id: 'type', name: 'Typography', parentId: 'design', depth: 1 },
  { id: 'ai', name: 'AI & Agents', parentId: '', depth: 0 },
  { id: 'research', name: 'Research', parentId: '', depth: 0 },
  { id: 'prod', name: 'Agents in production', parentId: 'research', depth: 1 },
];

test('collection paths parse and resolve names from the root', () => {
  assert.deepEqual(parseCollectionPath(' Design /  Inspiration '), ['Design', 'Inspiration']);
  assert.deepEqual(parseCollectionPath('Research › Agents  in production'), ['Research', 'Agents in production']);
  assert.deepEqual(parseCollectionPath(' / '), []);
  assert.deepEqual(pathNames(rows, 'prod'), ['Research', 'Agents in production']);
  assert.deepEqual(pathNames([{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }], 'a'), ['B', 'A'], 'cycles stop');
});

test('collection filter keeps ancestors of matches for context, in tree order', () => {
  assert.equal(filterCollectionTree(rows, '').length, rows.length);
  const agents = filterCollectionTree(rows, 'agents');
  assert.deepEqual(agents.map(({ row, match }) => `${row.id}:${match}`), ['ai:true', 'research:false', 'prod:true']);
  const path = filterCollectionTree(rows, 'design / insp');
  assert.deepEqual(path.map(({ row, match }) => `${row.id}:${match}`), ['design:false', 'insp:true']);
  assert.deepEqual(filterCollectionTree(rows, 'nothing here'), []);
});

test('create plans reuse existing parents and support "Parent / Child"', () => {
  assert.deepEqual(planCollectionPath(rows, 'Design / Inspiration'), { existingId: 'insp', parentId: 'design', create: [] });
  assert.deepEqual(planCollectionPath(rows, 'design / Moodboards'), { existingId: '', parentId: 'design', create: ['Moodboards'] });
  assert.deepEqual(planCollectionPath(rows, 'Inspiration / Posters'), { existingId: '', parentId: 'insp', create: ['Posters'] }, 'a unique nested name anchors the path');
  assert.deepEqual(planCollectionPath(rows, 'Cooking / Breads'), { existingId: '', parentId: '', create: ['Cooking', 'Breads'] });
  assert.deepEqual(planCollectionPath(rows, '   '), { existingId: '', parentId: '', create: [] });
  assert.equal(planCollectionPath(rows, 'ai & agents').existingId, 'ai', 'exact names match case-insensitively');
  const color = colorForName('Moodboards');
  assert.equal(color, colorForName('moodboards'));
  assert.ok(COLLECTION_COLORS.some(c => c.hex === color && c.name !== 'gray'));
});

test('a collection whose own name contains a separator is found, not re-created as a path', () => {
  const withSlash = [...rows, { id: 'aiml', name: 'AI/ML', parentId: '', depth: 0 }, { id: 'ux', name: 'UI › UX', parentId: 'design', depth: 1 }];
  assert.deepEqual(filterCollectionTree(withSlash, 'AI/ML').filter(r => r.match).map(r => r.row.id), ['aiml']);
  assert.deepEqual(planCollectionPath(withSlash, 'AI/ML'), { existingId: 'aiml', parentId: '', create: [] });
  assert.deepEqual(planCollectionPath(withSlash, 'ui  ›  ux'), { existingId: 'ux', parentId: 'design', create: [] });
  assert.deepEqual(planCollectionPath(withSlash, 'AI/Vision'), { existingId: '', parentId: '', create: ['AI', 'Vision'] }, 'other slashes still mean a path');
  assert.deepEqual(filterCollectionTree(withSlash, 'design / insp').map(({ row, match }) => `${row.id}:${match}`), ['design:false', 'insp:true']);
});

test('tag helpers split, merge, remove and autocomplete', () => {
  assert.deepEqual(splitTags('ai, #Research,\n  deep   work ,,'), ['ai', 'Research', 'deep work']);
  assert.equal(splitTags('x'.repeat(80))[0].length, 64);
  assert.deepEqual(mergeTags(['AI', 'design'], ['ai', 'Type', ' ', 'type']), ['AI', 'design', 'Type']);
  assert.deepEqual(removeTag(['AI', 'design'], 'ai'), ['design']);
  const all = [{ name: 'design', count: 9 }, { name: 'ux-design', count: 4 }, { name: 'devtools', count: 3 }, { name: 'ai', count: 2 }];
  assert.deepEqual(matchTags(all, '#de').map(t => t.name), ['design', 'devtools', 'ux-design'], 'prefix matches first');
  assert.deepEqual(matchTags(all, 'de', ['Design']).map(t => t.name), ['devtools', 'ux-design'], 'chosen tags are excluded');
  assert.deepEqual(matchTags(all, '', [], 2).map(t => t.name), ['design', 'ux-design']);
});

test('reminder presets: later today until 10 PM, tomorrow 9 AM, next Monday 9 AM', () => {
  const afternoon = new Date(2026, 9, 28, 15, 10); // Wednesday
  const [later, tomorrow, nextWeek] = reminderPresets(afternoon);
  assert.equal(later.id, 'later');
  assert.equal(toDateTimeLocal(later.date), '2026-10-28T19:00');
  assert.equal(toDateTimeLocal(tomorrow.date), '2026-10-29T09:00');
  assert.equal(toDateTimeLocal(nextWeek.date), '2026-11-02T09:00');
  const late = reminderPresets(new Date(2026, 9, 28, 20, 30));
  assert.deepEqual(late.map(p => p.id), ['tomorrow', 'next-week'], 'no "later today" after 7 PM');
  const monday = reminderPresets(new Date(2026, 10, 2, 8, 0));
  assert.equal(toDateTimeLocal(monday.at(-1).date), '2026-11-09T09:00', 'on a Monday, next week is seven days out');
  assert.equal(toDateTimeLocal('not a date'), '');
  assert.match(formatReminder(new Date(2026, 9, 28, 19, 0), afternoon), /^Today, /);
  assert.match(formatReminder(new Date(2026, 9, 29, 9, 0), afternoon), /^Tomorrow, /);
  assert.doesNotMatch(formatReminder(new Date(2027, 0, 4, 9, 0), afternoon), /^(Today|Tomorrow)/);
  assert.match(formatReminder(new Date(2027, 0, 4, 9, 0), afternoon), /2027/);
});

test('detectUrl accepts links, www hosts and (in the URL field) bare domains only', () => {
  assert.equal(detectUrl('  https://example.com/a?b=1 '), 'https://example.com/a?b=1');
  assert.equal(detectUrl('<https://example.com>'), 'https://example.com/');
  assert.equal(detectUrl('www.example.com/path'), 'https://www.example.com/path');
  assert.equal(detectUrl('example.com/path'), '', 'bare domains are not links when pasting anywhere');
  assert.equal(detectUrl('example.com/path', { bare: true }), 'https://example.com/path');
  assert.equal(detectUrl('notes.txt', { bare: true }), 'https://notes.txt/', 'the URL field trusts what the user typed');
  for (const value of ['hello world', 'javascript:alert(1)', 'ftp://example.com', 'https://intranet', 'mailto:a@b.co', '']) assert.equal(detectUrl(value), '', value);
  assert.equal(detectUrl('http://localhost:3000/x'), 'http://localhost:3000/x');
});

test('parseHtmlMetadata prefers Open Graph, decodes entities and resolves relative images', () => {
  const page = `<!doctype html><html><head><title>Plain &amp; simple</title>
    <meta content="A description" name="description">
    <meta property='og:title' content='Building &quot;effective&quot; agents &#8212; notes'>
    <meta property="og:image" content="/img/cover.png">
    <meta name="twitter:description" content="Twitter text">
    <meta property="og:site_name" content="Anthropic"><meta property="og:type" content="article">
  </head><body>ignored</body></html>`;
  assert.deepEqual(parseHtmlMetadata(page, 'https://www.anthropic.com/engineering/x'), {
    title: 'Building "effective" agents — notes', excerpt: 'Twitter text', cover: 'https://www.anthropic.com/img/cover.png', siteName: 'Anthropic', type: 'article',
  });
  const plain = parseHtmlMetadata('<title>\n  Just a   title </title><meta property="og:image" content="javascript:alert(1)">', 'https://example.com/');
  assert.equal(plain.title, 'Just a title');
  assert.equal(plain.excerpt, '');
  assert.equal(plain.cover, '', 'non-http images are dropped');
  assert.deepEqual(parseHtmlMetadata('', ''), { title: '', excerpt: '', cover: '', siteName: '', type: '' });
});

test('file kinds, tab collection names and local tag ideas', () => {
  assert.equal(fileKind({ type: 'image/png' }), 'image');
  assert.equal(fileKind({ type: 'video/mp4' }), 'video');
  assert.equal(fileKind({ type: 'application/pdf' }), 'file');
  assert.equal(fileKind({}), 'file');
  assert.equal(MAX_FILE_BYTES, 100 * 1024 * 1024);
  assert.match(defaultTabsCollectionName(new Date(2026, 9, 28)), /^Tabs .*2026/);
  const items = [
    { url: 'https://blog.example.com/a', tags: ['writing', 'ai'] },
    { url: 'https://blog.example.com/b', tags: ['ai'] },
    { url: 'https://blog.example.com/c', tags: ['old'], deletedAt: '2026-01-01' },
    { url: 'https://other.com', tags: ['cooking'] },
  ];
  const allTags = [{ name: 'design', count: 9 }, { name: 'ai', count: 5 }, { name: 'cooking', count: 3 }, { name: 'travel', count: 2 }];
  assert.deepEqual(localTagSuggestions(items, { url: 'https://blog.example.com/new', allTags }), ['ai', 'writing', 'design', 'cooking'], 'same site first, then two frequent tags');
  assert.deepEqual(localTagSuggestions(items, { url: 'https://blog.example.com/new', allTags, exclude: ['AI'], frequent: 1 }), ['writing', 'design']);
  assert.deepEqual(localTagSuggestions([], { allTags, limit: 3, frequent: 5 }), ['design', 'ai', 'cooking']);
});

test('related-by-text needs the same site or shared words and skips the page itself', () => {
  assert.deepEqual(contentWords('Building effective AI agents: the guide for agents'), ['building', 'effective', 'agents']);
  const page = { url: 'https://www.anthropic.com/engineering/building-effective-agents', title: 'Building effective agents', excerpt: 'Workflows versus agents' };
  const items = [
    { id: 'self', url: 'https://www.anthropic.com/engineering/building-effective-agents/#top', title: 'Same page' },
    { id: 'site', url: 'https://www.anthropic.com/news/claude', title: 'Claude agents news', updatedAt: '2026-10-01' },
    { id: 'words', url: 'https://example.com/a', title: 'Agents and workflows in practice', updatedAt: '2026-10-02' },
    { id: 'weak', url: 'https://example.com/b', title: 'Effective meetings', updatedAt: '2026-10-03' },
    { id: 'gone', url: 'https://www.anthropic.com/x', title: 'Agents', deletedAt: '2026-10-04' },
    { id: 'skip', url: 'https://www.anthropic.com/y', title: 'Agents workflows' },
  ];
  assert.deepEqual(relatedLexical(items, page, { exclude: ['skip'] }).map(i => i.id), ['site', 'words']);
  assert.deepEqual(relatedLexical(items, page, { limit: 1, exclude: ['skip'] }).map(i => i.id), ['site']);
  assert.ok(isWebUrl('https://a.b/c'));
  assert.ok(!isWebUrl('chrome://newtab'));
  assert.ok(!isWebUrl(''));
});
