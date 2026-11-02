// Pure capture helpers for "Save article" and the picker (lib/capture.js): cleaning page results, the canonical-URL
// rule, the item input for new and re-captured pages, and the self-contained functions the worker injects.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createWindow } from './helpers/fake-dom.mjs';
import {
  normalizeArticleResult, registrableDomain, sameSite, articleSaveUrl, buildArticleCapture, savedSelectionMessage,
  runArticleExtract, startPagePicker, ARTICLE_SCRIPT_FILES, PICKER_SCRIPT_FILES, ARTICLE_LIMIT,
} from '../extension/lib/capture.js';

const good = (extra = {}) => ({
  ok: true, source: 'readability', url: 'https://example.com/a', canonicalUrl: 'https://example.com/a', title: 'Title', siteName: 'Site', author: 'Author',
  publishedAt: '2026-10-01', lang: 'en', dir: 'ltr', excerpt: 'Excerpt', icon: 'https://example.com/i.png', cover: 'https://example.com/c.jpg',
  markdown: 'Some text here', text: 'Some text here', wordCount: 3, readingMinutes: 1, images: ['https://example.com/c.jpg'], truncated: false, ...extra,
});

test('the injected script lists load Readability first and the picker last, all from packaged folders', () => {
  assert.deepEqual(ARTICLE_SCRIPT_FILES, ['lib/vendor/readability.js', 'content/article-extract.js']);
  assert.deepEqual(PICKER_SCRIPT_FILES, [...ARTICLE_SCRIPT_FILES, 'content/picker.js']);
  for (const file of PICKER_SCRIPT_FILES) assert.ok(readFileSync(new URL(`../extension/${file}`, import.meta.url)).length > 1000, file);
});

test('article results from a page are cleaned: http(s) URLs, capped strings, no plain text copy, known sources', () => {
  const clean = normalizeArticleResult(good({
    url: 'javascript:alert(1)', canonicalUrl: 'ftp://example.com/x', cover: 'http://user:pw@example.com/c.jpg', icon: 'javascript:x',
    title: `  A   long ${'t'.repeat(3000)}`, siteName: 'S\n\nite', source: 'evil', dir: 'sideways', images: ['https://ok.example/a.png', 'data:x', 7, ...Array(60).fill('https://example.com/i.png')],
    selectionCount: 3, markdown: `x\u0000${'y'.repeat(ARTICLE_LIMIT + 10)}`, extra: { nested: true },
  }), { pageUrl: 'https://example.com/tab' });
  assert.equal(clean.url, 'https://example.com/tab', 'a page that reports a strange URL falls back to the tab URL');
  assert.equal(clean.canonicalUrl, 'https://example.com/tab');
  assert.deepEqual([clean.cover, clean.icon, clean.source, clean.dir, clean.siteName], ['', '', 'fallback', '', 'S ite']);
  assert.equal(clean.title.length, 2000);
  assert.equal(clean.markdown.length, ARTICLE_LIMIT);
  assert.ok(!clean.markdown.includes('\u0000'));
  assert.equal(clean.truncated, true, 'cutting the Markdown marks it truncated');
  assert.equal(clean.images.length, 50);
  assert.equal(clean.images[0], 'https://ok.example/a.png');
  assert.equal(clean.selectionCount, 3);
  assert.equal(clean.text, undefined);
  assert.equal(clean.extra, undefined);
  const icon = normalizeArticleResult(good({ icon: 'data:image/png;base64,AAAA', wordCount: 'many', readingMinutes: -2, markdown: 'one two three four' }));
  assert.deepEqual([icon.icon, icon.wordCount, icon.readingMinutes], ['data:image/png;base64,AAAA', 4, 1]);
  assert.equal(normalizeArticleResult(good({ icon: `data:image/png;base64,${'A'.repeat(20000)}` })).icon, '');
});

test('failed or empty results become a readable failure', () => {
  assert.deepEqual(normalizeArticleResult({ ok: false, code: 'empty', error: '  Nothing\nhere ' }), { ok: false, code: 'empty', error: 'Nothing here' });
  assert.deepEqual(normalizeArticleResult({ ok: false, code: 'weird' }), { ok: false, code: 'error', error: 'Still could not read this page.' });
  assert.deepEqual(normalizeArticleResult(null), { ok: false, code: 'error', error: 'Still could not read this page.' });
  assert.deepEqual(normalizeArticleResult({ ok: 'yes', markdown: 'x' }), { ok: false, code: 'error', error: 'Still could not read this page.' });
  assert.deepEqual(normalizeArticleResult(good({ markdown: ' \n ' })), { ok: false, code: 'empty', error: 'Still found no article text on this page.' });
});

test('registrable domains handle country second levels, shared hosts and IP addresses', () => {
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('blog.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('news.site.com.au'), 'site.com.au');
  assert.equal(registrableDomain('alice.github.io'), 'alice.github.io');
  assert.equal(registrableDomain('docs.alice.github.io'), 'alice.github.io');
  assert.equal(registrableDomain('my-app.vercel.app'), 'my-app.vercel.app');
  assert.equal(registrableDomain('localhost'), 'localhost');
  assert.equal(registrableDomain('192.168.0.1'), '192.168.0.1');
  assert.ok(sameSite('https://www.example.com/a', 'https://m.example.com/b'));
  assert.ok(sameSite('https://example.com:8443/a', 'https://example.com/b'));
  assert.equal(sameSite('https://alice.github.io/x', 'https://bob.github.io/x'), false);
  assert.equal(sameSite('https://example.co.uk/', 'https://other.co.uk/'), false);
  assert.equal(sameSite('http://10.0.0.1/', 'http://10.0.0.2/'), false);
  assert.equal(sameSite('https://example.com/', 'not a url'), false);
});

test('an article saves under its canonical URL only on its own site and never downgraded to http', () => {
  const at = (canonicalUrl, url = 'https://www.example.com/post?ref=feed') => articleSaveUrl({ url, canonicalUrl }, url);
  assert.equal(at('https://www.example.com/post'), 'https://www.example.com/post');
  assert.equal(at('https://example.com/post'), 'https://example.com/post', 'www and the bare domain are one site');
  assert.equal(at('https://amp.example.com/post'), 'https://amp.example.com/post');
  assert.equal(at('https://other.example.net/post'), 'https://www.example.com/post?ref=feed', 'another site cannot claim the item');
  assert.equal(at('http://www.example.com/post'), 'https://www.example.com/post?ref=feed', 'no https to http downgrade');
  assert.equal(at('javascript:alert(1)'), 'https://www.example.com/post?ref=feed');
  assert.equal(at('https://bob.github.io/post', 'https://alice.github.io/post'), 'https://alice.github.io/post');
  assert.equal(articleSaveUrl({ url: 'https://example.com/p', canonicalUrl: 'https://example.com/q' }), 'https://example.com/q', 'without a tab URL the page URL is the reference');
  assert.equal(articleSaveUrl({ url: 'https://evil.example/p', canonicalUrl: 'https://evil.example/p' }, 'https://example.com/tab'), 'https://example.com/tab',
    'the tab URL wins over what the page reports');
  assert.equal(articleSaveUrl({}, ''), '');
});

test('a new article item carries the capture; a re-capture only refreshes text and fills gaps', () => {
  const article = normalizeArticleResult(good());
  const fresh = buildArticleCapture(article, { url: 'https://example.com/a', pageUrl: 'https://example.com/a?utm_source=x', collectionId: 'reading', tags: '#one, two', note: ' My note ' });
  assert.deepEqual(fresh, {
    type: 'article', title: 'Title', url: 'https://example.com/a', articleContent: 'Some text here', excerpt: 'Excerpt', cover: 'https://example.com/c.jpg',
    icon: 'https://example.com/i.png', siteName: 'Site', author: 'Author', publishedAt: '2026-10-01', lang: 'en', content: 'My note',
    tags: ['one', 'two'], collectionId: 'reading', sourceUrl: 'https://example.com/a?utm_source=x',
  });
  const existing = { id: 'x', type: 'bookmark', title: 'Kept', url: 'https://example.com/a/', content: 'Note', excerpt: 'Mine', cover: '', icon: '', author: 'Me' };
  const again = buildArticleCapture(article, { url: 'https://example.com/a', existing, collectionId: 'other', tags: ['new'], note: 'ignored', title: 'Ignored' });
  assert.deepEqual([again.type, again.title, again.url, again.content, again.tags, again.collectionId], ['article', 'Kept', 'https://example.com/a/', '', [], '']);
  assert.deepEqual([again.excerpt, again.cover, again.icon, again.author, again.siteName], ['', 'https://example.com/c.jpg', 'https://example.com/i.png', '', 'Site']);
  assert.equal(again.articleContent, 'Some text here');
  assert.equal(buildArticleCapture(article, { url: 'https://example.com/a', existing: { ...existing, title: 'https://example.com/a' } }).title, 'Title', 'a placeholder title is replaced');
  assert.equal(buildArticleCapture(article, { url: 'https://example.com/a', existing: { ...existing, type: 'file' } }).type, 'file', 'never downgraded');
  assert.equal(buildArticleCapture(article, { url: 'https://www.youtube.com/watch?v=1' }).type, 'video');
  assert.equal(buildArticleCapture({ ...article, title: '' }, { url: 'https://example.com/a', fallbackTitle: 'Tab title' }).title, 'Tab title');
  assert.equal(buildArticleCapture(article, { url: 'javascript:x' }).url, 'https://example.com/a', 'an unusable address falls back to the article rule');
  assert.throws(() => buildArticleCapture({ ...article, url: '', canonicalUrl: '' }, { url: 'javascript:x' }), /which page/);
});

test('the selection notification names the count and the site', () => {
  assert.equal(savedSelectionMessage({ selectionCount: 3, siteName: 'Example Journal' }), 'Saved 3 selections from Example Journal');
  assert.equal(savedSelectionMessage({ selectionCount: 1 }, 'https://www.example.com/x'), 'Saved 1 selection from example.com');
  assert.equal(savedSelectionMessage({}, 'nope'), 'Saved 1 selection from this page');
});

test('the injected functions are self-contained and never throw into executeScript', () => {
  // Chrome sends only the function source: run it in a realm that has nothing but what the page's isolated world has.
  const run = (fn, globals, ...args) => JSON.parse(JSON.stringify(vm.runInContext(`(${fn.toString()})(...__args)`, vm.createContext({ ...globals, __args: args }))));
  assert.deepEqual(run(runArticleExtract, {}, { maxChars: 10 }), { ok: false, code: 'error', error: 'Still could not load its article reader on this page.' });
  assert.deepEqual(run(runArticleExtract, { __stillArticle: { extract: options => ({ ok: true, max: options.maxChars }) } }, { maxChars: 10 }), { ok: true, max: 10 });
  assert.deepEqual(run(runArticleExtract, { __stillArticle: { extract: () => { throw new Error('boom'); } } }, {}), { ok: false, code: 'error', error: 'Still could not read this page.' });
  assert.deepEqual(run(startPagePicker, {}, { requestId: 'r' }), { started: false, error: 'Still could not load the page picker here.' });
  assert.deepEqual(run(startPagePicker, { __stillPicker: { start: options => ({ started: true, requestId: options.requestId }) } }, { requestId: 'r1', from: 'panel' }), { started: true, requestId: 'r1' });
  assert.deepEqual(run(startPagePicker, { __stillPicker: { start: () => { throw new Error('This page cannot be selected from.'); } } }, {}), { started: false, error: 'This page cannot be selected from.' });
});

test('the real extractor, run the way the worker injects it, yields a result the worker can save', () => {
  const { window, document } = createWindow(`<html lang="en"><head><title>Hello | Example</title><link rel="canonical" href="https://example.com/posts/hello">
    <meta property="og:site_name" content="Example"></head><body><nav>Menu</nav><article><h1>Hello</h1>${'<p>Plenty of words in this paragraph to read as an article body.</p>'.repeat(8)}</article></body></html>`,
  { url: 'https://www.example.com/posts/hello?utm_source=x' });
  const context = vm.createContext({ document, window, location: window.location, URL, console, getComputedStyle: window.getComputedStyle });
  for (const file of ARTICLE_SCRIPT_FILES) vm.runInContext(readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8'), context, { filename: file });
  const raw = JSON.parse(JSON.stringify(vm.runInContext(`(${runArticleExtract.toString()})({ maxChars: 250000 })`, context)));
  const article = normalizeArticleResult(raw, { pageUrl: 'https://www.example.com/posts/hello?utm_source=x' });
  assert.equal(article.ok, true);
  assert.match(article.markdown, /Plenty of words/);
  assert.equal(articleSaveUrl(article, 'https://www.example.com/posts/hello?utm_source=x'), 'https://example.com/posts/hello');
  const input = buildArticleCapture(article, { pageUrl: 'https://www.example.com/posts/hello?utm_source=x' });
  assert.deepEqual([input.type, input.url, input.siteName], ['article', 'https://example.com/posts/hello', 'Example']);
});
