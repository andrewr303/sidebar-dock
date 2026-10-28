import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  buildCapture, collectionMenuEntries, findSavedItem, indexSavedUrls, isPlaceholderTitle, menuCollectionTitle, normalizeRecentCollections,
  normalizeTags, parseSaveToMenuId, rankMenuCollections, readPageContext, readPageMetadata, resolveCaptureCollection, saveToMenuId,
} from '../extension/lib/capture.js';

const at = minutes => new Date(Date.UTC(2026, 9, 1, 12, minutes)).toISOString();
const collection = (id, name, extra = {}) => ({ id, name, parentId: '', pinned: false, updatedAt: at(0), ...extra });

test('save-to menu ids round-trip Inbox, choose and collection ids that contain colons', () => {
  assert.equal(saveToMenuId('page', ''), 'still-save-to:page:__inbox');
  assert.equal(saveToMenuId('link', 'raindrop:42'), 'still-save-to:link:raindrop:42');
  assert.deepEqual(parseSaveToMenuId('still-save-to:link:raindrop:42'), { kind: 'link', target: 'raindrop:42', choose: false, collectionId: 'raindrop:42' });
  assert.deepEqual(parseSaveToMenuId('still-save-to:image:__inbox'), { kind: 'image', target: '__inbox', choose: false, collectionId: '' });
  assert.equal(parseSaveToMenuId('still-save-to:page:__choose').choose, true);
  for (const id of ['still-save-page', 'still-save-to:page:__separator', 'still-save-to:video:design', 'still-save-to:page:', 'still-save-to::x', 7]) {
    assert.equal(parseSaveToMenuId(id), null, String(id));
  }
});

test('menu titles show the collection path and keep the collection itself readable within 40 characters', () => {
  const design = collection('design', 'Design');
  const inspiration = collection('inspiration', 'Inspiration', { parentId: 'design' });
  const deep = collection('deep', 'Typography specimens and type foundries', { parentId: 'inspiration' });
  const loop = collection('loop', 'Loop', { parentId: 'loop-parent' });
  const loopParent = collection('loop-parent', 'Parent', { parentId: 'loop' });
  const byId = new Map([design, inspiration, deep, loop, loopParent].map(value => [value.id, value]));
  assert.equal(menuCollectionTitle(design, byId), 'Design');
  assert.equal(menuCollectionTitle(inspiration, byId), 'Design › Inspiration');
  const deepTitle = menuCollectionTitle(deep, byId);
  assert.equal(deepTitle, '… › Typography specimens and type found…');
  assert.equal([...deepTitle].length, 40);
  assert.equal(menuCollectionTitle(collection('x', 'An extremely long single collection name for testing'), byId), 'An extremely long single collection nam…');
  assert.equal(menuCollectionTitle(loop, byId), 'Parent › Loop');
  const midPath = menuCollectionTitle(collection('leaf', 'Fonts', { parentId: 'inspiration' }), new Map([...byId, ['inspiration', { ...inspiration, name: 'Inspiration for the quarterly redesign' }]]));
  assert.equal(midPath, '… › Fonts');
  assert.equal(menuCollectionTitle(collection('leaf', 'Fonts', { parentId: 'inspiration' }), byId), 'Design › Inspiration › Fonts');
});

test('menu collections rank recent, then pinned, then latest item activity, capped at 10 plus Inbox', () => {
  const collections = [
    collection('design', 'Design', { pinned: true, updatedAt: at(1) }),
    collection('inspiration', 'Inspiration', { parentId: 'design', updatedAt: at(2) }),
    collection('reading', 'Reading', { updatedAt: at(3) }),
    ...Array.from({ length: 12 }, (_, index) => collection(`p${index + 1}`, `Project ${index + 1}`, { updatedAt: at(10 + index) })),
  ];
  const items = [
    { id: 'a', collectionId: 'p2', updatedAt: at(50) },
    { id: 'b', collectionId: 'p5', updatedAt: at(40) },
    { id: 'c', collectionId: 'p9', updatedAt: at(59), deletedAt: at(59) },
  ];
  const library = { collections, items };
  const ranked = rankMenuCollections(library, { recentCollections: ['reading', 'missing', 'inspiration'] }).map(value => value.id);
  assert.deepEqual(ranked, ['reading', 'inspiration', 'design', 'p2', 'p5', 'p12', 'p11', 'p10', 'p9', 'p8']);
  const entries = collectionMenuEntries(library, ['inspiration']);
  assert.equal(entries.length, 11);
  assert.deepEqual(entries.slice(0, 4), [
    { id: '__inbox', title: 'Inbox' }, { id: 'inspiration', title: 'Design › Inspiration' }, { id: 'design', title: 'Design' }, { id: 'p2', title: 'Project 2' },
  ]);
  assert.deepEqual(collectionMenuEntries({}, []), [{ id: '__inbox', title: 'Inbox' }]);
  assert.equal(collectionMenuEntries(library, [], { limit: 3 }).length, 4);
});

test('recent collections and tags accept the UI shapes', () => {
  assert.deepEqual(normalizeRecentCollections({ recentCollections: ['a', 'b', 'a', 3, ''] }), ['a', 'b']);
  assert.deepEqual(normalizeRecentCollections(['x']), ['x']);
  assert.deepEqual(normalizeRecentCollections(null), []);
  assert.deepEqual(normalizeTags(['#design', ' ui ', 'design', '', 4]), ['design', 'ui']);
  assert.deepEqual(normalizeTags('reading, #later ,'), ['reading', 'later']);
  assert.deepEqual(normalizeTags(undefined), []);
});

test('capture collection resolution falls back to Inbox for a missing collection and keeps quick saves in place', () => {
  const library = { collections: [collection('design', 'Design'), collection('reading', 'Reading')], settings: { defaultCollectionId: 'reading' } };
  assert.deepEqual(resolveCaptureCollection(library, 'design'), { collectionId: 'design' });
  assert.deepEqual(resolveCaptureCollection(library, 'gone'), { collectionId: '', collectionFallback: true });
  assert.deepEqual(resolveCaptureCollection(library, ''), { collectionId: '' });
  assert.deepEqual(resolveCaptureCollection(library, '__inbox'), { collectionId: '' });
  assert.deepEqual(resolveCaptureCollection(library, undefined), { collectionId: 'reading' });
  assert.deepEqual(resolveCaptureCollection(library, null, { existing: { id: 'x' } }), { collectionId: '' });
  assert.deepEqual(resolveCaptureCollection(library, undefined, { preferred: 'design' }), { collectionId: 'design' });
  assert.deepEqual(resolveCaptureCollection({ collections: [], settings: { defaultCollectionId: 'gone' } }, undefined), { collectionId: '' });
});

test('a quick save follows the last-used collection (the side panel order), then the default, then Inbox', () => {
  const library = { collections: [collection('design', 'Design'), collection('reading', 'Reading')], settings: { defaultCollectionId: 'reading' } };
  assert.deepEqual(resolveCaptureCollection(library, undefined, { recent: ['gone', 'design', 'reading'] }), { collectionId: 'design' });
  assert.deepEqual(resolveCaptureCollection(library, undefined, { recent: { recentCollections: ['design'] } }), { collectionId: 'design' }, 'the UI storage shape');
  assert.deepEqual(resolveCaptureCollection(library, undefined, { recent: ['gone'] }), { collectionId: 'reading' });
  assert.deepEqual(resolveCaptureCollection(library, undefined, { recent: ['design'], existing: { id: 'saved' } }), { collectionId: '' }, 'a saved item stays put');
  assert.deepEqual(resolveCaptureCollection(library, undefined, { recent: ['design'], preferred: 'reading' }), { collectionId: 'reading' }, 'a note prefers its source page');
  assert.deepEqual(resolveCaptureCollection(library, undefined, { recent: ['design'], preferred: '' }), { collectionId: '' }, 'a source page in Inbox keeps its note in Inbox');
  assert.deepEqual(resolveCaptureCollection(library, undefined, { recent: ['design'], preferred: undefined }), { collectionId: 'design' }, 'no saved source page');
  assert.deepEqual(resolveCaptureCollection(library, 'reading', { recent: ['design'] }), { collectionId: 'reading' }, 'an explicit choice wins');
  assert.deepEqual(resolveCaptureCollection({ collections: [], settings: {} }, undefined, { recent: ['design'] }), { collectionId: '' });
});

test('a link or image found on a file or extension page is saved without a source address', () => {
  for (const pageUrl of ['chrome-extension://abc/index.html', 'file:///home/me/notes.html', 'about:blank']) {
    const link = buildCapture({ menuItemId: 'still-save-link', linkUrl: 'https://example.com/a', pageUrl });
    assert.deepEqual([link.url, link.sourceUrl], ['https://example.com/a', ''], pageUrl);
    const image = buildCapture({ menuItemId: 'still-save-image', srcUrl: 'https://cdn.example.com/a.png', pageUrl, mediaType: 'image' });
    assert.deepEqual([image.type, image.sourceUrl], ['image', ''], pageUrl);
  }
  assert.throws(() => buildCapture({ menuItemId: 'still-save-page', pageUrl: 'file:///home/me/notes.html' }), /http or https/);
});

// Runs the injected readers the way executeScript does: the function source alone, in a fake page.
function runInPage(func, args, { metaContent = '', title = '', selection = '', lang = '' } = {}) {
  const body = { nodeType: 1, childNodes: [{ nodeType: 3, nodeValue: 'Body text' }], localName: 'body', matches: () => false, querySelector: () => null, innerText: 'Body text' };
  const page = {
    document: { title, body, documentElement: { lang }, querySelector: selector => (selector.startsWith('meta') ? { getAttribute: () => metaContent } : null), querySelectorAll: () => [] },
    location: { href: 'https://example.com/page' }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };
  page.window = { getSelection: () => ({ toString: () => selection }) };
  return vm.runInNewContext(`(${func.toString()})(...args)`, { ...page, args });
}

test('the injected page readers are self-contained and bound every field a page controls', () => {
  const huge = 'x'.repeat(1_000_000);
  const context = runInPage(readPageContext, [120000], { metaContent: huge, title: huge, selection: huge, lang: huge });
  assert.equal(context.text, 'Body text');
  assert.ok(context.title.length <= 2000 && context.excerpt.length <= 5000 && context.cover.length <= 5000 && context.selection.length <= 20000 && context.lang.length <= 35);
  const metadata = runInPage(readPageMetadata, [], { metaContent: huge, title: huge, selection: huge });
  assert.ok(metadata.title.length <= 2000 && metadata.excerpt.length <= 5000 && metadata.cover.length <= 5000 && metadata.selection.length <= 20000 && metadata.contentType.length <= 100);
  assert.equal(metadata.url, 'https://example.com/page');
});

test('saved-item lookup follows store dedupe: canonical URL, never notes or trashed items', () => {
  const library = { items: [
    { id: 'note', type: 'note', url: 'https://example.com/a' },
    { id: 'trashed', type: 'bookmark', url: 'https://example.com/a', deletedAt: at(1) },
    { id: 'live', type: 'article', url: 'https://example.com/a?utm_source=x#top', archived: true },
    { id: 'other', type: 'bookmark', url: 'https://example.com/b' },
  ] };
  assert.equal(findSavedItem(library, 'https://example.com/a/')?.id, 'live');
  assert.equal(findSavedItem(library, 'https://example.com/missing'), null);
  assert.equal(findSavedItem(library, 'not a url'), null);
  const index = indexSavedUrls(library);
  assert.deepEqual([...index.keys()], ['https://example.com/a', 'https://example.com/b']);
  assert.equal(index.get('https://example.com/a').id, 'live');
});

test('placeholder titles are only addresses or the store fallback', () => {
  assert.equal(isPlaceholderTitle('https://example.com/a', 'https://example.com/a'), true);
  assert.equal(isPlaceholderTitle('https://example.com/a?utm_source=x', 'https://example.com/a'), true);
  assert.equal(isPlaceholderTitle('example.com', 'https://example.com/a'), true);
  assert.equal(isPlaceholderTitle('  ', 'https://example.com/a'), true);
  assert.equal(isPlaceholderTitle('Untitled item', 'https://example.com/a'), true);
  assert.equal(isPlaceholderTitle('A careful essay', 'https://example.com/a'), false);
});

test('buildCapture passes collection, tags and note through and never replaces a note or real title on re-save', () => {
  const tab = { title: 'Tab title', url: 'https://example.com/post' };
  const metadata = { title: 'Page title', excerpt: 'Fresh description', cover: '/c.jpg', articleText: 'Body' };
  const fresh = buildCapture({ pageUrl: tab.url }, tab, metadata, { collectionId: 'design', tags: ['ui', '#type'], note: '  Why I kept this  ' });
  assert.equal(fresh.collectionId, 'design');
  assert.deepEqual(fresh.tags, ['ui', 'type']);
  assert.equal(fresh.content, 'Why I kept this');
  assert.equal(fresh.title, 'Page title');
  assert.equal(fresh.excerpt, 'Fresh description');
  assert.equal(fresh.cover, 'https://example.com/c.jpg');
  assert.equal(fresh.type, 'article');
  const existing = { id: 'x', title: 'My renamed post', content: 'My earlier note', excerpt: 'Edited description', cover: 'https://example.com/mine.png' };
  const again = buildCapture({ pageUrl: tab.url }, tab, metadata, { note: 'Another thought', existing });
  assert.equal(again.content, '', 'the store keeps the existing note when content is empty');
  assert.equal(again.title, 'My renamed post');
  assert.equal(again.excerpt, '');
  assert.equal(again.cover, '');
  assert.equal(buildCapture({ pageUrl: tab.url }, tab, metadata, { note: 'Fills an empty note', existing: { ...existing, content: '  ' } }).content, 'Fills an empty note');
  assert.equal(buildCapture({ pageUrl: tab.url }, tab, metadata, { title: 'Chosen in the dialog', existing }).title, 'Chosen in the dialog');
  assert.equal(buildCapture({ pageUrl: tab.url }, tab, metadata, { existing: { title: 'https://example.com/post' } }).title, 'Page title');
  assert.equal(buildCapture({ pageUrl: tab.url }, tab, metadata).collectionId, '');
});

test('saving a link uses its text, keeps an existing title and never stores the raw URL over it', () => {
  const page = { pageUrl: 'https://example.com/post' };
  const link = 'https://elsewhere.example/essay';
  assert.equal(buildCapture({ ...page, menuItemId: 'still-save-link', linkUrl: link }).title, link);
  assert.equal(buildCapture({ ...page, menuItemId: 'still-save-link', linkUrl: link, linkText: '  A long\nessay ' }).title, 'A long essay');
  const selected = buildCapture({ ...page, menuItemId: 'still-save-link', linkUrl: link, selectionText: 'Selected link text' });
  assert.equal(selected.title, 'Selected link text');
  assert.equal(selected.url, link, 'a selection on a link still saves the link');
  assert.deepEqual(selected.highlights, []);
  assert.equal(buildCapture({ ...page, menuItemId: 'still-save-link', linkUrl: link }, {}, {}, { existing: { title: 'An essay on craft' } }).title, 'An essay on craft');
  assert.equal(buildCapture({ ...page, menuItemId: 'still-save-link', linkUrl: link, selectionText: 'Better text' }, {}, {}, { existing: { title: link } }).title, 'Better text');
  const tracked = buildCapture({ ...page, menuItemId: 'still-save-link', linkUrl: `${link}?utm_source=feed` }, {}, {}, { existing: { title: 'Essay', type: 'article', url: link } });
  assert.deepEqual([tracked.url, tracked.type], [link, 'article'], 'a re-save keeps the stored address and does not downgrade the type');
  assert.equal(buildCapture({ ...page, menuItemId: 'still-save-link', linkUrl: link }, {}, {}, { existing: { title: 'Essay', type: 'bookmark', url: 'https://other.example/' } }).url, link);
});

test('save-to menu items capture the page, the link or the image they were opened on', () => {
  const info = { pageUrl: 'https://example.com/post', linkUrl: 'https://example.com/next', srcUrl: 'https://cdn.example.com/a.png' };
  const metadata = { title: 'Post', articleText: 'Body text' };
  const page = buildCapture({ ...info, linkUrl: undefined, srcUrl: undefined, menuItemId: 'still-save-to:page:design' }, {}, metadata, { collectionId: 'design' });
  assert.deepEqual([page.type, page.url, page.collectionId, page.articleContent], ['article', 'https://example.com/post', 'design', 'Body text']);
  const link = buildCapture({ ...info, srcUrl: undefined, menuItemId: 'still-save-to:link:__inbox' }, {}, metadata);
  assert.deepEqual([link.type, link.url, link.articleContent, link.sourceUrl], ['bookmark', 'https://example.com/next', '', 'https://example.com/post']);
  const image = buildCapture({ ...info, menuItemId: 'still-save-to:image:design' }, {}, metadata);
  assert.deepEqual([image.type, image.url, image.cover], ['image', 'https://cdn.example.com/a.png', 'https://cdn.example.com/a.png']);
  const note = buildCapture({ pageUrl: info.pageUrl, menuItemId: 'still-note-selection', selectionText: 'Quote' }, {}, metadata, { note: 'My take' });
  assert.deepEqual([note.type, note.title, note.content], ['note', 'Notes on Post', 'Quote\n\nMy take']);
});
