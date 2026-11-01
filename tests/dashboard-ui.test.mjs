import test from 'node:test';
import assert from 'node:assert/strict';
import { searchUrl, urlFromText, libraryMatches, suggestionRows, SEARCH_ENGINES } from '../extension/ui/dashboard/search.js';
import { accessNote, filterWidgets, placementFor } from '../extension/ui/dashboard/gallery.js';
import { validateFields } from '../extension/ui/dashboard/widget-settings.js';
import { sizePresets, readPath, writePath, sizeBucket, clampSize } from '../extension/ui/dashboard/registry.js';
import { greetingFor } from '../extension/ui/dashboard/state.js';

test('search URLs for every engine encode the query', () => {
  assert.equal(searchUrl('duckduckgo', 'a&b c'), 'https://duckduckgo.com/?q=a%26b%20c');
  assert.equal(searchUrl('nope', 'x'), 'https://www.google.com/search?q=x');
  for (const engine of SEARCH_ENGINES) assert.match(searchUrl(engine.id, 'still'), /^https:\/\/[^ ]+still$/);
});

test('urlFromText recognizes addresses but not searches', () => {
  assert.equal(urlFromText('github.com'), 'https://github.com/');
  assert.equal(urlFromText('news.ycombinator.com/item?id=1'), 'https://news.ycombinator.com/item?id=1');
  assert.equal(urlFromText('http://example.org/a'), 'http://example.org/a');
  assert.equal(urlFromText('localhost:3000'), 'http://localhost:3000/');
  assert.equal(urlFromText('192.168.1.1'), 'http://192.168.1.1/');
  for (const text of ['how to cook rice', 'rice', 'javascript:alert(1)', 'mailto:me@x.com', 'file.txt', '', 'a.b c']) assert.equal(urlFromText(text), '', text);
});

const library = {
  collections: [{ id: 'design', name: 'Design' }, { id: 'dev', name: 'Development' }],
  items: [
    { id: '1', type: 'bookmark', title: 'Refactoring UI', url: 'https://refactoringui.com', collectionId: 'design', updatedAt: '2024-01-01' },
    { id: '2', type: 'note', title: 'Design principles', content: 'calm', collectionId: 'design', updatedAt: '2024-03-01' },
    { id: '3', type: 'bookmark', title: 'Old design link', url: 'https://x.com', deletedAt: '2024-01-01', updatedAt: '2024-05-01' },
    { id: '4', type: 'article', title: 'On design systems', url: 'https://y.com', updatedAt: '2024-04-01' },
  ],
};

test('library matches rank title matches first and skip trashed items', () => {
  const { items, collections } = libraryMatches(library, 'design');
  assert.deepEqual(items.map(i => i.id), ['2', '4', '1']);
  assert.deepEqual(collections.map(c => c.id), ['design']);
  assert.deepEqual(libraryMatches(library, '  '), { items: [], collections: [] });
});

test('suggestion rows: address, web search (Enter), Ask AI, then the library', () => {
  const rows = suggestionRows({ query: 'design', engine: 'kagi', library });
  assert.deepEqual(rows.map(r => r.kind), ['web', 'ai', 'collection', 'item', 'item', 'item']);
  assert.equal(rows[0].label, 'Search Kagi for “design”');
  const url = suggestionRows({ query: 'github.com', library });
  assert.equal(url[0].kind, 'url');
  assert.equal(url[0].label, 'Go to github.com');
  assert.equal(url[1].label, 'Search the web for “github.com”');
  assert.deepEqual(suggestionRows({ query: '' }), []);
});

test('gallery helpers: access notes, search filtering and placement', () => {
  assert.equal(accessNote({}), '');
  assert.equal(accessNote({ permissions: { origins: ['https://api.github.com/*'] } }), 'Asks for access to api.github.com');
  assert.equal(accessNote({ permissions: { permissions: ['topSites'], origins: ['https://*/*'] } }), 'Asks for access to your most visited sites and the websites you choose');
  assert.equal(accessNote({ permissions: { permissions: ['bookmarks', 'tabs'], origins: ['https://api.linear.app/*'] } }),
    'Asks for access to your bookmarks, your open tabs and api.linear.app');
  const defs = [
    { type: 'clock', title: 'Clock', description: 'Time and world clocks', category: 'info', keywords: ['time'] },
    { type: 'github', title: 'GitHub', description: 'Pull requests', category: 'developer', keywords: ['pr', 'ci'] },
  ];
  assert.deepEqual(filterWidgets(defs, { query: 'time' }).map(d => d.type), ['clock']);
  assert.deepEqual(filterWidgets(defs, { query: 'CI' }).map(d => d.type), ['github']);
  assert.deepEqual(filterWidgets(defs, { category: 'developer' }).map(d => d.type), ['github']);
  assert.deepEqual(filterWidgets(defs, { query: 'pull clock' }), []);
  const widgets = [{ id: 'a', x: 0, y: 0, w: 6, h: 2 }];
  assert.deepEqual(placementFor(widgets, { w: 3, h: 2 }, { x: 8, y: 0 }), { x: 8, y: 0 }, 'free requested cell');
  assert.deepEqual(placementFor(widgets, { w: 3, h: 2 }, { x: 11, y: 4 }), { x: 9, y: 4 }, 'clamped into the grid');
  assert.deepEqual(placementFor(widgets, { w: 3, h: 2 }, { x: 2, y: 1 }), { x: 6, y: 0 }, 'taken → first free spot');
  assert.deepEqual(placementFor(widgets, { w: 3, h: 2 }, null), { x: 6, y: 0 });
});

test('generic settings validation covers required, URL, number range and list rows', () => {
  const fields = [
    { name: 'title', label: 'Folder name', type: 'text', required: true },
    { name: 'url', label: 'Address', type: 'url' },
    { name: 'limit', label: 'Limit', type: 'number', min: 1, max: 20 },
    { name: 'noteId', label: 'Note', type: 'note', required: true },
    { name: 'hidden', label: 'Hidden', type: 'text', required: true, when: draft => draft.mode === 'x' },
    { name: 'show.hourly', label: 'Hourly', type: 'number', min: 0 },
    { name: 'links', label: 'Links', type: 'list', itemFields: [{ name: 'url', label: 'URL', type: 'url', required: true }, { name: 'title', label: 'Title', type: 'text' }] },
  ];
  const errors = validateFields(fields, { title: ' ', url: 'ftp://x', limit: 40, show: { hourly: -1 }, links: [{ url: 'https://ok.com' }, { url: '' }, { url: 'nope' }] });
  assert.deepEqual(Object.keys(errors).sort(), ['limit', 'links.1.url', 'links.2.url', 'noteId', 'show.hourly', 'title', 'url']);
  assert.equal(errors.title, 'Enter folder name.');
  assert.equal(errors.limit, 'Enter a number from 1 to 20.');
  assert.equal(errors.noteId, 'Choose a note.');
  assert.equal(errors['show.hourly'], 'Enter 0 or more.');
  assert.deepEqual(validateFields(fields, { title: 'Ok', noteId: 'n1', links: [] }), {});
});

test('registry helpers: presets, paths, buckets and clamping', () => {
  const def = { size: { w: 3, h: 3, minW: 2, minH: 2, maxW: 6, maxH: 6 } };
  assert.deepEqual(sizePresets(def).map(p => [p.key, p.w, p.h]), [['S', 2, 2], ['M', 3, 3], ['L', 5, 5], ['XL', 6, 6]]);
  assert.deepEqual(sizePresets({ size: { w: 2, h: 1, minW: 2, maxW: 2, minH: 1, maxH: 1 } }).map(p => p.key), ['S'], 'duplicates collapse');
  assert.deepEqual(sizePresets({ size: { w: 4, h: 4 }, presets: { S: { w: 2, h: 2 }, L: { w: 8, h: 6 } } }).map(p => p.label), ['Small', 'Large']);
  const target = {};
  writePath(target, 'show.hourly', true);
  writePath(target, 'links.0.title', 'A');
  writePath(target, '__proto__.polluted', true);
  assert.deepEqual(target, { show: { hourly: true }, links: [{ title: 'A' }] });
  assert.equal({}.polluted, undefined);
  assert.equal(readPath(target, 'links.0.title'), 'A');
  assert.equal(readPath(target, 'missing.deep'), undefined);
  assert.equal(sizeBucket(2, 2), 'xs');
  assert.equal(sizeBucket(12, 9), 'xl');
  assert.deepEqual(clampSize(def, { w: 20, h: 0 }), { w: 6, h: 3 });
});

test('greeting follows the hour', () => {
  const at = hour => greetingFor(new Date(2024, 0, 1, hour));
  assert.equal(at(4), 'Good night');
  assert.equal(at(5), 'Good morning');
  assert.equal(at(12), 'Good afternoon');
  assert.equal(at(18), 'Good evening');
  assert.equal(at(22), 'Good night');
});
