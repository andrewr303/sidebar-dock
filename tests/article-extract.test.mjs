import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createWindow } from './helpers/fake-dom.mjs';
import { parseNoteBlocks, serializeNoteBlocks, renderMarkdown } from '../extension/lib/markdown.js';

const READABILITY_PATH = new URL('../extension/lib/vendor/readability.js', import.meta.url);
const SCRIPT_PATH = new URL('../extension/content/article-extract.js', import.meta.url);
const LICENSE_PATH = new URL('../extension/assets/licenses/readability.txt', import.meta.url);
const READABILITY = readFileSync(READABILITY_PATH, 'utf8');
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8');
const PINNED = { bytes: 90944, sha256: 'e9330028c8a5a4aa7d75147be2605d520f7f213c7b28474947dc0e9c984e9bed', commit: 'ab4027a8b37669745016869a37a504727992b2ba' };

// Results cross from the vm realm as plain JSON, exactly as executeScript would return them.
const plain = value => JSON.parse(JSON.stringify(value));

// Loads the classic scripts into a vm context whose document and window come from the fake DOM, the way
// executeScript({ files }) runs them in the page's isolated world.
function page(html, { url = 'https://example.com/posts/hello', readability = true, contentType = '', setup } = {}) {
  const { window, document } = createWindow(html, { url });
  if (contentType) document.contentType = contentType;
  const context = vm.createContext({ document, window, location: window.location, URL, console, getComputedStyle: window.getComputedStyle });
  if (readability) vm.runInContext(READABILITY, context, { filename: 'readability.js' });
  setup?.(context, document);
  vm.runInContext(SCRIPT, context, { filename: 'article-extract.js' });
  const api = context.__stillArticle;
  return {
    document, window, context, api,
    extract: options => plain(api.extract(options)),
    fromElements: (elements, options) => plain(api.fromElements(elements, options)),
    md: (htmlOrSelector, options) => {
      if (htmlOrSelector.startsWith('<')) { const holder = document.createElement('div'); holder.innerHTML = htmlOrSelector; document.body.appendChild(holder); return api.toMarkdown(holder, options); }
      return api.toMarkdown(document.querySelector(htmlOrSelector), options);
    },
    metadata: () => plain(api.metadata()),
  };
}
const md = (fragment, options) => page('<html><body></body></html>').md(fragment, options);

// Markdown that lib/markdown.js would write itself: parsing it and re-serializing every block from scratch (no raw
// source kept) reproduces it byte for byte.
function canonical(markdown) {
  const fresh = parseNoteBlocks(markdown).map(block => Object.fromEntries(Object.entries(block).filter(([key]) => !key.startsWith('_'))));
  return serializeNoteBlocks(fresh);
}
const types = markdown => parseNoteBlocks(markdown).map(block => block.type);
const words = n => Array.from({ length: n }, (_, i) => `word${i % 7}, and more`).join(' ') + '.';
const prose = (n = 4) => Array.from({ length: n }, () => `<p>${words(30)}</p>`).join('');

// ---------------------------------------------------------------------------------------------------------------
// Vendored Readability

test('vendored Readability is the pinned upstream file, byte for byte, with provenance, NOTICE and the Apache text', () => {
  const bytes = readFileSync(READABILITY_PATH);
  assert.equal(bytes.length, PINNED.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), PINNED.sha256);
  assert.match(bytes.toString('utf8', 0, 40), /^\/\*\n \* Copyright \(c\) 2010 Arc90 Inc/, 'no header was added above the upstream notice');
  const license = readFileSync(LICENSE_PATH, 'utf8');
  for (const needle of [PINNED.commit, PINNED.sha256, 'extension/lib/vendor/readability.js', 'Readability.js', 'Copyright (c) 2010 Arc90 Inc',
    'Copyright (c) 2010-2026 Mozilla and Contributors', 'Apache License', 'Version 2.0, January 2004', 'END OF TERMS AND CONDITIONS']) {
    assert.ok(license.includes(needle), `license file mentions ${needle}`);
  }
});

test('both injected files are classic scripts that pass the repo checks (no imports, exports or dynamic code)', () => {
  for (const source of [READABILITY, SCRIPT]) {
    assert.doesNotMatch(source, /\b(?:import|export)\s+(?:[\w$*{},\s]+?\s+from\s*)?['"][^'"\r\n]+['"]/);
    assert.doesNotMatch(source, /\beval\s*\(|\bnew\s+Function\s*\(|\bimportScripts\s*\(/);
    assert.doesNotThrow(() => new vm.Script(source));
  }
  const context = vm.createContext({});
  vm.runInContext(READABILITY, context);
  assert.equal(typeof context.Readability, 'function');
  assert.equal(typeof context.Readability.prototype.parse, 'function');
});

test('the script defines one frozen global, once, and a second injection keeps it', () => {
  const p = page('<html><body><p>Hi</p></body></html>');
  const first = p.context.__stillArticle;
  assert.deepEqual(Object.keys(first).sort(), ['extract', 'fromElements', 'metadata', 'toMarkdown', 'version']);
  assert.ok(Object.isFrozen(first));
  vm.runInContext(SCRIPT, p.context);
  assert.equal(p.context.__stillArticle, first);
  vm.runInContext('Object.defineProperty(globalThis, "__stillArticle", { value: { version: 0 }, configurable: true })', p.context);
  vm.runInContext(SCRIPT, p.context);
  assert.equal(p.context.__stillArticle.version, first.version, 'an older copy left in the page is replaced');
});

// ---------------------------------------------------------------------------------------------------------------
// Article pipeline

const ARTICLE = `<!doctype html><html lang="en" dir="ltr"><head>
<title>How lighthouses work | The Coast Review</title>
<meta property="og:site_name" content="The Coast Review"><meta property="og:title" content="How lighthouses work (og)">
<meta name="description" content="A short guide to the lamps, lenses and keepers of coastal lighthouses.">
<meta property="og:image" content="/media/cover.jpg">
<link rel="canonical" href="/guides/lighthouses">
<link rel="icon" href="/favicon.ico"><link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png"><link rel="mask-icon" href="/mask.svg">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","name":"Page"},{"@type":"NewsArticle","headline":"How lighthouses work","author":[{"@type":"Person","name":"Ada Keeper"},{"@type":"Person","name":"Bo Lamp"}],"datePublished":"2026-09-30T08:00:00Z","publisher":{"@type":"Organization","name":"The Coast Review"}}]}</script>
<script>window.tracking = true;</script><style>p { color: red }</style>
</head><body>
<header class="site-header"><nav><a href="/">Home</a> <a href="/guides">Guides</a></nav></header>
<main><article class="post">
<h1>How lighthouses work</h1>
${prose(3)}
<h2>The lens</h2>
<p>A <a href="/fresnel">Fresnel lens</a> bends light. See <a href="javascript:alert(1)">this</a> and <a href="mailto:keeper@example.com">write to us</a>.</p>
<pre class="language-python"><code>def beam(angle):\n    return angle * 2\n</code></pre>
<div class="markdown-alert markdown-alert-tip"><p class="markdown-alert-title">Tip</p><p>Visit at dusk.</p></div>
<ul><li><input type="checkbox" checked> Check the lamp</li><li><input type="checkbox"> Wind the clock</li></ul>
<figure><img src="/media/lens.jpg" alt="A Fresnel lens" width="800" height="600"><figcaption>The lens at <b>Cape Point</b></figcaption></figure>
${prose(2)}
</article>
<aside class="related"><h3>Related</h3><ul><li><a href="/x">Other story</a></li></ul></aside></main>
<footer><p>Copyright The Coast Review</p></footer>
</body></html>`;

test('extract runs Readability on a clone, keeps metadata, and never changes the live page', () => {
  const p = page(ARTICLE, { url: 'https://coast.example/guides/lighthouses?utm=1' });
  const before = p.document.documentElement.outerHTML;
  let constructed = 0;
  const Original = p.context.Readability;
  p.context.Readability = function (doc, options) { constructed++; assert.notEqual(doc, p.document, 'Readability gets a clone'); assert.equal(options.charThreshold, 250); return new Original(doc, options); };
  const result = p.extract();
  assert.equal(constructed, 1);
  assert.equal(p.document.documentElement.outerHTML, before, 'the live document is untouched');
  assert.equal(result.ok, true);
  assert.equal(result.source, 'readability');
  assert.equal(result.url, 'https://coast.example/guides/lighthouses?utm=1');
  assert.equal(result.canonicalUrl, 'https://coast.example/guides/lighthouses');
  assert.equal(result.title, 'How lighthouses work', 'Readability title (JSON-LD headline) wins over og:title');
  assert.equal(result.siteName, 'The Coast Review');
  assert.equal(result.author, 'Ada Keeper, Bo Lamp');
  assert.equal(result.publishedAt, '2026-09-30T08:00:00.000Z');
  assert.equal(result.lang, 'en');
  assert.equal(result.dir, 'ltr');
  assert.equal(result.excerpt, 'A short guide to the lamps, lenses and keepers of coastal lighthouses.');
  assert.equal(result.icon, 'https://coast.example/icon-32.png');
  assert.equal(result.cover, 'https://coast.example/media/cover.jpg');
  assert.deepEqual(result.images, ['https://coast.example/media/lens.jpg']);
  assert.equal(result.truncated, false);
  const raw = p.api.extract();
  assert.ok(Object.values(raw).every(value => value !== undefined && typeof value !== 'function'), 'only plain data crosses back');
  assert.doesNotThrow(() => structuredClone(raw));
  assert.ok(result.wordCount > 100);
  assert.equal(result.readingMinutes, Math.max(1, Math.round(result.wordCount / 230)));
  assert.deepEqual(Object.keys(result).sort(), ['author', 'canonicalUrl', 'cover', 'dir', 'excerpt', 'icon', 'images', 'lang', 'markdown', 'ok', 'publishedAt',
    'readingMinutes', 'siteName', 'source', 'text', 'title', 'truncated', 'url', 'wordCount'].sort());
});

test('Readability output keeps code languages, callouts and task states through class stripping', () => {
  const { markdown, text } = page(ARTICLE, { url: 'https://coast.example/guides/lighthouses' }).extract();
  assert.doesNotMatch(markdown, /^# How lighthouses work/m, 'the title is not repeated as a heading');
  assert.match(markdown, /^## The lens$/m);
  assert.match(markdown, /A \[Fresnel lens\]\(https:\/\/coast\.example\/fresnel\) bends light\. See this and \[write to us\]\(mailto:keeper@example\.com\)\./);
  assert.match(markdown, /^```python\ndef beam\(angle\):\n {4}return angle \* 2\n```$/m);
  assert.match(markdown, /^> \[!TIP\]\n> Visit at dusk\.$/m);
  assert.match(markdown, /^- \[x\] Check the lamp\n- \[ \] Wind the clock$/m);
  assert.match(markdown, /^!\[A Fresnel lens\]\(https:\/\/coast\.example\/media\/lens\.jpg\)\n_The lens at \*\*Cape Point\*\*_$/m);
  for (const noise of ['Home', 'Other story', 'Copyright', 'tracking', 'color: red', 'Tip\n']) assert.ok(!markdown.includes(noise), `no ${JSON.stringify(noise)}`);
  assert.ok(!text.includes('**') && !text.includes(']('), 'text is plain');
  assert.equal(canonical(markdown), markdown, 'the Markdown is in the canonical Still form');
});

test('title rule: a Readability title equal to the site name falls back to og:title, then the tab title', () => {
  const html = title => `<html><head><title>${title}</title><meta property="og:site_name" content="Daily Planet"></head><body><article>${prose(4)}</article></body></html>`;
  const sameAsSite = page(`<html><head><title>Daily Planet</title><meta property="og:site_name" content="Daily Planet"><meta property="og:title" content="Big news today"></head><body><article>${prose(4)}</article></body></html>`).extract();
  assert.equal(sameAsSite.title, 'Big news today');
  const caseAndSpace = page(`<html><head><title>x</title><meta property="og:site_name" content="Daily Planet"><meta property="og:title" content="Fallback headline"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"daily  PLANET"}</script></head><body><article>${prose(4)}</article></body></html>`).extract();
  assert.equal(caseAndSpace.title, 'Fallback headline', 'the site-name comparison ignores case and spaces');
  const noReadability = page(html('Moon landing recap | Daily Planet'), { readability: false }).extract();
  assert.equal(noReadability.source, 'fallback');
  assert.equal(noReadability.title, 'Moon landing recap', 'without og:title the tab title loses its " | Site" suffix');
  assert.equal(page(html('Moon landing recap | Other Site'), { readability: false }).extract().title, 'Moon landing recap | Other Site');
});

test('fallback: Readability throwing, missing or thin uses article, then main, then body without page chrome', () => {
  const throwing = page(`<html><body><nav>Menu</nav><article>${prose(2)}</article><footer>Foot</footer></body></html>`, {
    setup: context => { context.Readability = function () { throw new TypeError("Failed to set the 'innerHTML' property: This document requires 'TrustedHTML' assignment."); }; },
  }).extract();
  assert.equal(throwing.ok, true);
  assert.equal(throwing.source, 'fallback');
  assert.ok(!/Menu|Foot/.test(throwing.markdown));

  const twoArticles = page(`<html><body><main><article><p>Short teaser one.</p></article><article><p>Short teaser two.</p></article>${prose(2)}</main><aside>Side</aside></body></html>`, { readability: false }).extract();
  assert.match(twoArticles.markdown, /^Short teaser one\.\nShort teaser two\./, 'two <article>s: main is the root');
  assert.ok(!twoArticles.markdown.includes('Side'));

  const teaser = page(`<html><body><article><p>Only a teaser.</p></article><div id="story">${prose(2)}</div><form><input value="secret"><p>Sign up</p></form><script>var x = 1</script></body></html>`, { readability: false }).extract();
  assert.equal(teaser.source, 'fallback');
  assert.match(teaser.markdown, /^Only a teaser\.\nword0/, 'a thin <article> falls through to the body');
  assert.ok(!/Sign up|secret|var x/.test(teaser.markdown));

  const hidden = page(`<html><body><main>${prose(2)}<p hidden>Hidden attr</p><p style="display: none">Inline none</p><p aria-hidden="true">Aria hidden</p><p class="gone">Computed none</p><div class="cookie-banner">Accept cookies</div></main></body></html>`, {
    readability: false,
    setup: (context, document) => { context.getComputedStyle = el => el.className === 'gone' ? { display: 'none', visibility: 'visible' } : document.defaultView.getComputedStyle(el); },
  }).extract();
  assert.ok(!/Hidden attr|Inline none|Aria hidden|Computed none|Accept cookies/.test(hidden.markdown), hidden.markdown);
});

test('a page wrapped in one big <form> still reads; a thin Readability result loses to a longer fallback', () => {
  const wrapped = page(`<html><body><form id="aspnetForm"><main><h1>Annual report</h1>${prose(2)}</main></form></body></html>`, { readability: false }).extract();
  assert.equal(wrapped.ok, true);
  assert.match(wrapped.markdown, /word0/);
  const thin = page(`<html><body><article><p>Tiny.</p></article></body></html>`, {
    setup: context => { context.Readability = function () { return { parse: () => ({ title: 'T', content: context.document.createElement('div'), textContent: '' }) }; }; },
  }).extract();
  assert.equal(thin.source, 'fallback');
  assert.equal(thin.markdown, 'Tiny.');
});

test('in-content <header>s survive on both paths (standfirst, lead figure, section headings); only the page banner is chrome', () => {
  const both = html => [page(html).extract(), page(html, { readability: false }).extract()];
  // An article intro header and a section header, one level below the <article> so Readability's output loses that ancestor.
  const intro = `<html><head><title>Story</title></head><body><article><div class="story-meta">By X</div><div class="story-body">
    <header><figure><img src="/lead.jpg" width="1200" height="800" alt="Lead"><figcaption>Lead caption</figcaption></figure><p>This is the important standfirst paragraph.</p></header>
    ${prose(5)}<section><header><h2>Section two</h2></header>${prose(2)}</section></div><div class="share-tools"><a href="/s">Share this story</a></div></article></body></html>`;
  const [reader, walker] = both(intro);
  assert.deepEqual([reader.source, walker.source], ['readability', 'fallback']);
  for (const result of [reader, walker]) {
    assert.match(result.markdown, /^!\[Lead\]\(https:\/\/example\.com\/lead\.jpg\)\n_Lead caption_\nThis is the important standfirst paragraph\.$/m, result.source);
    assert.match(result.markdown, /^## Section two$/m, result.source);
    assert.ok(!result.markdown.includes('Share this story'), `${result.source}: the share widget is still dropped`);
  }
  // No <article> or <main>: the masthead is the page banner, the section headers are not.
  const docs = `<html><head><title>Guide</title></head><body><header class="masthead"><a href="/">Daily Site</a><p>Tagline of the site</p></header>
    <div id="content"><section><header><h2>Installing</h2></header>${prose(2)}</section><section><header><h2>Usage</h2></header>${prose(2)}</section></div></body></html>`;
  for (const result of both(docs)) {
    assert.match(result.markdown, /^## Installing$/m, result.source);
    assert.match(result.markdown, /^## Usage$/m, result.source);
    assert.ok(!/Daily Site|Tagline/.test(result.markdown), `${result.source}: no masthead`);
  }
  // A header inside a web component's shadow root is scoped by the host's ancestors.
  const p = page(`<html><body><article><my-section id="host"></my-section>${prose(2)}</article></body></html>`, { readability: false });
  const host = p.document.getElementById('host'), shadow = p.document.createDocumentFragment(), holder = p.document.createElement('div');
  holder.innerHTML = '<header><h2>Shadow section</h2></header><p>Shadow body</p>';
  for (const node of [...holder.childNodes]) shadow.appendChild(node);
  Object.defineProperty(host, 'shadowRoot', { value: shadow });
  Object.defineProperty(shadow, 'host', { value: host });
  assert.match(p.extract().markdown, /^## Shadow section\nShadow body\nword0/);
});

test('section ids built from heading text (Sphinx, Pandoc, R Markdown) are content; widget classes and heading-less widget ids are not', () => {
  const both = html => [page(html, { url: 'https://docs.example/library/http.cookies.html' }).extract(), page(html, { url: 'https://docs.example/library/http.cookies.html', readability: false }).extract()];
  const sphinx = `<html><head><title>http.cookies — HTTP state management</title></head><body><div class="body" role="main">
    <section id="module-http.cookies"><span id="http-cookies"></span><h1>http.cookies — HTTP state management</h1>${prose(2)}
    <section id="cookie-objects"><span id="id1"></span><h2>Cookie Objects</h2><p>BaseCookie.value_decode ${words(30)}</p></section>
    <section id="morsel-objects"><h2>Morsel Objects</h2>${prose(1)}</section><section id="sharing-state"><h2>Sharing state</h2>${prose(1)}</section>
    <div class="section" id="newsletter-feeds"><h2>Newsletter feeds</h2>${prose(1)}</div></section></div></body></html>`;
  for (const result of both(sphinx)) {
    for (const heading of ['Cookie Objects', 'Morsel Objects', 'Sharing state', 'Newsletter feeds']) assert.match(result.markdown, new RegExp(`^## ${heading}$`, 'm'), `${result.source}: ${heading}`);
    assert.match(result.markdown, /^BaseCookie\.value_decode /m, result.source);
  }
  const pandoc = `<html><head><title>Notebook guide</title></head><body><main>${prose(2)}
    <section id="sharing-notebooks" class="level2"><h2>Sharing notebooks</h2>${prose(1)}</section>
    <div id="cookies-and-sessions" class="section level2"><h2><span class="header-section-number">2</span> Cookies and sessions</h2>${prose(1)}</div>
    <section id="share-a-notebook" class="level2"><h2>Share a notebook</h2>${prose(1)}</section>
    <section id="comments" class="level2"><h2>Comments</h2><p>A comment starts with a hash character. ${words(20)}</p></section>
    <div id="cookie-notice"><p>We use cookies to improve this site.</p></div><div class="share-bar"><h3>Share this page</h3><a href="/t">Post it</a></div></main></body></html>`;
  const [reader, walker] = both(pandoc);
  assert.deepEqual([reader.source, walker.source], ['readability', 'fallback']);
  for (const result of [reader, walker]) {
    assert.match(result.markdown, /^## Sharing notebooks$/m, result.source);
    assert.match(result.markdown, /^## (?:2 )?Cookies and sessions$/m, result.source);
    assert.ok(!/Share this page|Post it/.test(result.markdown), `${result.source}: a widget class is still chrome, heading or not`);
  }
  // Readability's own pass removes short #share-* and #comments sections and header-* spans before the converter sees
  // its output; the walker, which only has the rule above, keeps them.
  assert.match(walker.markdown, /^## 2 Cookies and sessions$/m);
  assert.match(walker.markdown, /^## Share a notebook$/m);
  assert.match(walker.markdown, /^## Comments\nA comment starts with a hash character\./m);
  assert.ok(!walker.markdown.includes('We use cookies'), 'on the live page a widget id without a heading is still chrome');
});

test('failures are results, never exceptions', () => {
  const empty = page('<html><body><nav>Only navigation</nav><script>1</script></body></html>').extract();
  assert.deepEqual(Object.keys(empty).sort(), ['code', 'error', 'ok']);
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'empty');
  assert.match(empty.error, /selecting parts/);
  assert.equal(page('<html><body><embed type="application/pdf"></body></html>', { contentType: 'application/pdf' }).extract().code, 'unreadable');
  const broken = page(`<html><body>${prose(1)}</body></html>`);
  broken.document.getElementsByTagName = () => { throw new Error('boom'); };
  const result = broken.extract();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'error');
  assert.match(result.error, /went wrong/);
  assert.equal(broken.api.toMarkdown(null), '');
  assert.equal(broken.api.toMarkdown({ nodeType: 3 }), '');
  assert.equal(broken.api.fromElements(null).code, 'empty');
  const meta = plain(broken.api.metadata());
  assert.equal(meta.url, 'https://example.com/posts/hello', 'metadata() degrades to the address instead of throwing');
  assert.equal(meta.title, '');
});

test('truncation stops on a block boundary, never inside a fence or table, and is reported', () => {
  const html = `<html><body><article>${prose(3)}<pre><code>${'line\n'.repeat(400)}</code></pre><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>${prose(3)}</article></body></html>`;
  const full = page(html).extract();
  assert.equal(full.truncated, false);
  for (const limit of [50, 700, 1500, 3500, full.markdown.length - 5]) {
    const cut = page(html).extract({ maxChars: limit });
    assert.equal(cut.truncated, true, `limit ${limit}`);
    assert.ok(cut.markdown.length <= limit, `limit ${limit}`);
    assert.ok(full.markdown.startsWith(cut.markdown) || limit === 50, `limit ${limit} keeps a prefix of whole blocks`);
    assert.equal((cut.markdown.match(/^```/gm) || []).length % 2, 0, 'fences stay paired');
    assert.ok(!/\| a \| b \|$/.test(cut.markdown), 'a table is never cut after its header');
  }
  const first = page(`<html><body><article><p>${words(80)}</p></article></body></html>`).extract({ maxChars: 60 });
  assert.equal(first.truncated, true);
  assert.ok(first.markdown.length <= 60 && first.markdown.endsWith('…'), 'an oversized first paragraph is cut on a word');
});

test('pathological documents: the node budget stops the walk and flags truncation; deep nesting degrades to text', () => {
  const huge = page(`<html><body><main>${'<span></span>'.repeat(160000)}<p>tail paragraph</p></main></body></html>`).extract();
  assert.equal(huge.ok, false, 'the budget ran out before any text');
  const mixed = page(`<html><body><main><p>${words(40)}</p>${'<i></i>'.repeat(160000)}<p>tail paragraph</p></main></body></html>`).extract();
  assert.equal(mixed.ok, true);
  assert.equal(mixed.truncated, true);
  assert.ok(!mixed.markdown.includes('tail paragraph'));
  const deep = page(`<html><body>${'<div>'.repeat(3000)}deep words here${'</div>'.repeat(3000)}</body></html>`).extract();
  assert.equal(deep.ok, true);
  assert.equal(deep.markdown, 'deep words here');
  const deepInline = md(`<p>${'<span>'.repeat(1000)}inline <b>words</b>${'</span>'.repeat(1000)}</p>`);
  assert.equal(deepInline, 'inline words');
});

test('a document past the Readability size cap skips it and uses the walker', () => {
  let called = false;
  const p = page(`<html><body><main>${prose(2)}${'<b></b>'.repeat(31000)}</main></body></html>`, { setup: context => { const R = context.Readability; context.Readability = function (...args) { called = true; return new R(...args); }; } });
  const result = p.extract();
  assert.equal(called, false);
  assert.equal(result.source, 'fallback');
});

// ---------------------------------------------------------------------------------------------------------------
// Metadata and icons

test('metadata() returns PageMeta with resolved, http(s)-only URLs and normalized fields', () => {
  const meta = page(`<html lang="en_GB"><head><base href="https://cdn.example/base/"><title>  Tab   title </title>
    <meta property="og:url" content="javascript:alert(1)"><link rel="canonical" href="ftp://example.com/x">
    <meta property="og:locale" content="fr_FR"><meta name="author" content="By Jane Doe"><meta property="article:published_time" content="not a date">
    <meta itemprop="datePublished" content="2025-02-03"><meta property="og:image" content="javascript:void(0)"><meta name="twitter:image" content="img/t.png">
    <meta property="og:description" content="${'Long description words. '.repeat(30)}"></head><body dir="rtl"><h1>Heading</h1></body></html>`, { url: 'https://example.com/a/b' }).metadata();
  assert.deepEqual(Object.keys(meta).sort(), ['author', 'canonicalUrl', 'cover', 'dir', 'excerpt', 'icon', 'lang', 'publishedAt', 'siteName', 'title', 'url'].sort());
  assert.equal(meta.url, 'https://example.com/a/b');
  assert.equal(meta.canonicalUrl, 'https://example.com/a/b', 'non-http canonical and og:url are ignored');
  assert.equal(meta.title, 'Tab title');
  assert.equal(meta.author, 'Jane Doe');
  assert.equal(meta.publishedAt, '2025-02-03T00:00:00.000Z');
  assert.equal(meta.lang, 'en-GB');
  assert.equal(meta.dir, 'rtl');
  assert.equal(meta.cover, 'https://cdn.example/base/img/t.png', 'a bad og:image falls through to twitter:image, resolved against <base>');
  assert.ok(meta.excerpt.length <= 300 && meta.excerpt.endsWith('…'));
  assert.equal(meta.icon, '');
});

test('icon choice prefers 32px+ PNG/SVG and apple-touch icons, skips mask-icon, never guesses /favicon.ico', () => {
  const icon = links => page(`<html><head>${links}</head><body></body></html>`, { url: 'https://site.example/page' }).metadata().icon;
  assert.equal(icon(''), '');
  assert.equal(icon('<link rel="shortcut icon" href="/favicon.ico">'), 'https://site.example/favicon.ico', 'a declared .ico is a last resort');
  assert.equal(icon('<link rel="icon" href="/favicon.ico"><link rel="icon" type="image/png" sizes="16x16" href="/16.png">'), 'https://site.example/16.png');
  assert.equal(icon('<link rel="icon" type="image/png" sizes="16x16" href="/16.png"><link rel="icon" type="image/png" sizes="32x32" href="/32.png">'), 'https://site.example/32.png');
  assert.equal(icon('<link rel="icon" sizes="32x32" href="/32.png"><link rel="apple-touch-icon" href="/apple.png">'), 'https://site.example/apple.png');
  assert.equal(icon('<link rel="icon" sizes="192x192" href="/192.png"><link rel="icon" sizes="96x96" href="/96.png">'), 'https://site.example/96.png', 'sizes near 64-180 px first');
  assert.equal(icon('<link rel="mask-icon" href="/mask.svg"><link rel="icon" href="/favicon.ico">'), 'https://site.example/favicon.ico');
  assert.equal(icon('<link rel="icon" type="image/svg+xml" href="/icon.svg"><link rel="icon" sizes="48x48" href="/48.ico">'), 'https://site.example/icon.svg');
  const small = 'data:image/png;base64,' + 'A'.repeat(100), big = 'data:image/png;base64,' + 'A'.repeat(17000);
  assert.equal(icon(`<link rel="icon" sizes="32x32" href="${small}">`), small);
  assert.equal(icon(`<link rel="icon" sizes="32x32" href="${big}">`), '');
  assert.equal(icon('<link rel="icon" href="javascript:alert(1)">'), '');
});

// ---------------------------------------------------------------------------------------------------------------
// HTML → Still Markdown

test('blocks: clamped headings, paragraphs, hard breaks, quotes, dividers and toggles in Still syntax', () => {
  const out = md(`<div><h1>One</h1><h2><a href="#two">Two</a></h2><h4>Four</h4><h6>Six</h6><p>First <span> line</span><br>second line</p><p>  </p><p>Next</p>
    <blockquote><p>Quoted one</p><p>Quoted two</p></blockquote><blockquote><p>Another quote</p></blockquote><hr><hr>
    <details open><summary>More <em>info</em></summary><p>Hidden body</p><ul><li>item</li></ul></details><details><summary>Closed</summary><p>x</p></details></div>`);
  assert.equal(out, ['# One', '## Two', '### Four', '### Six', 'First line\\', 'second line', 'Next', '> Quoted one', '>', '> Quoted two', '', '> Another quote', '---',
    ':::toggle [open] More _info_', 'Hidden body', '- item', ':::', ':::toggle [closed] Closed', 'x', ':::'].join('\n'));
  assert.deepEqual(types(out), ['h1', 'h2', 'h3', 'h3', 'paragraph', 'paragraph', 'quote', 'paragraph', 'quote', 'divider', 'toggle', 'toggle']);
  assert.equal(canonical(out), out);
});

test('a divider after a line holding a pipe stays a divider instead of turning the line into a one-column table', () => {
  // lib/markdown.js reads a line with '|' as a table header when the next line is a divider row with as many cells.
  for (const [html, line] of [['<p>| lead</p>', '| lead'], ['<p>end |</p>', 'end |'], ['<p>use <code>a|b</code> here</p>', 'use `a|b` here'],
    ['<ul><li>item |</li></ul>', '- item |'], ['<h2>Head |</h2>', '## Head |'], ['<blockquote><p>q |</p></blockquote>', '> q |']]) {
    const out = md(`${html}<hr><p>After one</p><p>After two</p>`);
    assert.equal(out, `${line}\n\n---\nAfter one\nAfter two`, html);
    assert.ok(!types(out).includes('table'), html);
    assert.deepEqual(types(out).slice(-3), ['divider', 'paragraph', 'paragraph'], html);
    assert.equal(canonical(out), out, html);
  }
  // Two cells never match a one-cell divider, and a table ends at the divider by itself: no blank line needed.
  assert.equal(md('<p>a | b</p><hr><p>After</p>'), 'a | b\n---\nAfter');
  const table = md('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><hr><p>After</p>');
  assert.equal(table, '| A | B |\n| --- | --- |\n| 1 | 2 |\n---\nAfter');
  assert.deepEqual(types(table), ['table', 'divider', 'paragraph']);
});

test('inline: marks, merged runs, intraword emphasis, code spans, escaping and safe absolute links', () => {
  const p = page('<html><head><base href="https://docs.example/guide/"></head><body></body></html>', { url: 'https://docs.example/guide/intro' });
  const out = p.md(`<p><strong>Bold</strong><b> more</b> <em>em</em> un<em>believ</em>able <del>gone</del> <code>a\`b</code> <kbd>Ctrl</kbd>
    <a href="page2">rel</a> <a href="#part">anchor</a> <a href="javascript:void(0)">js</a> <a href="https://x.example/a(b)">paren</a> <a href="/x"><img src="/i.png" width="16" height="16" alt="icon"></a>
    5 * 3 and 2*4 snake_case _lead [brackets] \\ back &lt;tag&gt; ~tilde~ https://raw.example/a_b?c=1*2</p>`);
  assert.equal(out, '**Bold more** _em_ un*believ*able ~~gone~~ ``a`b`` `Ctrl` [rel](https://docs.example/guide/page2) [anchor](https://docs.example/guide/#part) js '
    + '[paren](https://x.example/a%28b%29) [icon](https://docs.example/x) 5 * 3 and 2\\*4 snake_case \\_lead \\[brackets] \\ back \\<tag> ~tilde~ https://raw.example/a_b?c=1*2');
  const html = renderMarkdown(out);
  for (const fragment of ['<strong>Bold more</strong>', '<em>em</em>', 'un<em>believ</em>able', '<del>gone</del>', '<code>a`b</code>', 'href="https://docs.example/guide/page2"',
    'href="https://x.example/a%28b%29"', '5 * 3 and 2*4 snake_case _lead [brackets]', '&lt;tag&gt; ~tilde~']) {
    assert.ok(html.includes(fragment), `${fragment} in ${html}`);
  }
  assert.ok(!html.includes('javascript'));
});

test('line starts that would change block type are escaped', () => {
  const out = md('<div><p>- not a list</p><p>1. not numbered</p><p># not a heading</p><p>&gt; not a quote</p><p>---</p><p>::embed[x](https://a.example)</p><p>Line<br>- second</p></div>');
  assert.equal(out, ['\\- not a list', '1\\. not numbered', '\\# not a heading', '\\> not a quote', '\\---', '::embed\\[x](https://a.example)', 'Line\\', '\\- second'].join('\n'));
  assert.deepEqual(types(out), Array(7).fill('paragraph'));
  assert.equal(canonical(out), out);
});

test('lists: nesting, ordered starts, tasks, loose items, separate lists and blocks that cannot nest', () => {
  const out = md(`<div><ul><li>One<ul><li>One.a<ol start="3"><li>three</li><li>four</li></ol></li></ul></li><li><p>Two</p><p>Two again</p></li>
    <li><input type="checkbox" checked> done task</li><li><label><input type="checkbox"> open task</label></li><li></li></ul>
    <ul><li>Second list</li></ul><ol><li>first</li><li value="7">seven</li><li><pre>code inside</pre></li></ol><ul><li>[ ] literal brackets</li></ul></div>`);
  assert.equal(out, ['- One', '  - One.a', '    3. three', '    4. four', '- Two\\', '  Two again', '- [x] done task', '- [ ] open task', '', '- Second list', '', '1. first', '2. seven',
    '```', 'code inside', '```', '- \\[ ] literal brackets'].join('\n'));
  const blocks = parseNoteBlocks(out);
  assert.deepEqual(blocks.slice(0, 4).map(block => [block.type, block.indent]), [['bullet', 0], ['bullet', 1], ['number', 2], ['number', 2]]);
  assert.equal(blocks[2].ordinal, 3);
  assert.deepEqual(blocks.filter(block => block.type === 'todo').map(block => block.checked), [true, false]);
  assert.equal(canonical(out), out);
  const rendered = renderMarkdown(out);
  assert.ok(rendered.includes('<ol start="3">') && rendered.includes('task-line done'));
});

test('code: fences sized past inner backticks, languages from common highlighters, gutters dropped', () => {
  const out = md(`<div><pre><code class="hljs language-ts">const a = 1;\n\`\`\`\nnested fence</code></pre>
    <div class="highlight highlight-source-shell"><pre>npm test</pre></div>
    <pre class="lang-rb"><code>puts 1</code></pre><pre data-lang="go"><code>fmt.Println()</code></pre><pre><code class="language-none">plain</code></pre>
    <pre class="line-numbers"><code class="language-js"><span class="line-numbers-rows" aria-hidden="true"><span>1</span></span>let x;</code></pre>
    <table class="highlighttable"><tr><td class="linenos"><pre>1\n2</pre></td><td class="code"><pre><span>a = 1</span>\n<span>b = 2</span></pre></td></tr></table>
    <div><code>multi\nline code</code></div><p>Inline <code>x</code> stays</p>
    <div class="code-example"><p class="example-header"><span class="language-name">js</span></p><pre class="brush: js notranslate"><code>go()</code></pre></div></div>`);
  assert.equal(out, ['````ts', 'const a = 1;', '```', 'nested fence', '````', '```shell', 'npm test', '```', '```rb', 'puts 1', '```', '```go', 'fmt.Println()', '```',
    '```', 'plain', '```', '```js', 'let x;', '```', '```', 'a = 1', 'b = 2', '```', '```', 'multi', 'line code', '```', 'Inline `x` stays', '```js', 'go()', '```'].join('\n'),
  'a "js" label printed above a code block is dropped');
  assert.deepEqual(parseNoteBlocks(out).filter(block => block.type === 'code').map(block => block.language), ['ts', 'shell', 'rb', 'go', '', 'js', '', '', 'js']);
  assert.equal(canonical(out), out);
});

test('tables: GFM with escaped pipes and <br>, colspans, complex tables as bullet rows, layout tables as text', () => {
  const out = md(`<div><table><caption>Prices</caption><thead><tr><th>Item</th><th>Cost</th></tr></thead><tbody><tr><td>a|b</td><td>1<br>2</td></tr><tr><td colspan="2">wide</td></tr></tbody></table>
    <p>After</p><table><tr><td>no</td><td>header</td></tr><tr><td><img src="https://i.example/x.png" alt="pic" width="100" height="100"></td><td><a href="https://l.example">link</a></td></tr></table>
    <table><tr><th>Name</th><th>Notes</th></tr><tr><td rowspan="2">Ann</td><td>first</td></tr><tr><td>second</td></tr></table>
    <table><tr><th>K</th><th>V</th></tr><tr><td>x</td><td><pre>line1\nline2</pre></td></tr></table>
    <table role="presentation"><tr><td><p>Layout cell one</p></td><td><p>Layout cell two</p></td></tr></table>
    <table><tr><td>Spacer</td><td>One-row layout</td></tr></table><table><tr><td>a</td><td><div>Block cell</div></td></tr><tr><td>b</td><td>c</td></tr></table></div>`);
  assert.equal(out, ['_Prices_', '| Item | Cost |', '| --- | --- |', '| a\\|b | 1<br>2 |', '| wide |  |', '', 'After',
    '| no | header |', '| --- | --- |', '| ![pic](https://i.example/x.png) | [link](https://l.example/) |',
    '- Name: Ann · Notes: first', '- Name: Ann · Notes: second', '', '- K: x · V: `line1 line2`', 'Layout cell one', 'Layout cell two',
    'Spacer', 'One-row layout', 'a', 'Block cell', 'b', 'c'].join('\n'));
  assert.deepEqual(types(out), ['paragraph', 'table', 'paragraph', 'paragraph', 'table', 'bullet', 'bullet', 'paragraph', 'bullet', ...Array(8).fill('paragraph')]);
  const table = parseNoteBlocks(out)[1];
  assert.deepEqual([table.headers, table.rows], [['Item', 'Cost'], [['a\\|b', '1<br>2'], ['wide', '']]]);
  assert.equal(canonical(out), out);
  assert.ok(renderMarkdown(out).includes('<td>a|b</td><td>1<br>2</td>'));
});

test('images: lazy sources, srcset, picture, noscript, placeholders, trackers, tiny images and emoji', () => {
  const p = page('<html><body></body></html>', { url: 'https://news.example/story' });
  const out = p.md(`<div><img src="data:image/gif;base64,R0lGOD" data-src="/lazy.jpg" alt="Lazy">
    <img src="/small.jpg" srcset="/s-400.jpg 400w, /s-1200.jpg 1200w, /s-800.jpg 800w" alt="Set">
    <picture><source srcset="/p.avif 2x, /p1.avif 1x"><img alt="Pic"></picture>
    <img src="/spacer.gif" alt="Placeholder"><noscript><img src="/real.jpg" alt="From noscript"></noscript>
    <img src="https://www.google-analytics.com/collect?v=1" alt="">
    <img src="/pixel.png" width="1" height="1"><img src="/badge.png" width="20" height="20" alt="badge">
    <p>Nice <img src="/e.png" alt="😀" class="emoji"> day <img src="/data.png" alt=""></p>
    <figure><img src="/fig.png" alt="Chart"><figcaption>Sales by <a href="/q">quarter</a></figcaption></figure>
    <img src="https://img.example/a (1).png" alt="Spaces [and] brackets"><img src="https://music.example/track/cover.jpg" alt="Album"><img src="https://t.example/beacon.gif?u=1" alt="b"></div>`);
  assert.equal(out, ['![Lazy](https://news.example/lazy.jpg)', '![Set](https://news.example/s-1200.jpg)', '![Pic](https://news.example/p.avif)',
    '![From noscript](https://news.example/real.jpg)', 'badge', 'Nice 😀 day', '![](https://news.example/data.png)', '![Chart](https://news.example/fig.png)',
    '_Sales by [quarter](https://news.example/q)_', '![Spaces \\[and\\] brackets](https://img.example/a%20%281%29.png)', '![Album](https://music.example/track/cover.jpg)'].join('\n'));
  assert.equal(canonical(out), out);
});

test('live images use currentSrc and natural size; a loaded 1×1 placeholder does not hide the lazy original', () => {
  const p = page('<html><body><main><img id="a" src="/thumb.jpg" srcset="/big.jpg 2000w"><img id="b" src="/blank.gif" data-src="/real.jpg" alt="Real"><img id="c" src="/icon.png" alt="tiny icon"></main></body></html>', { url: 'https://site.example/' });
  Object.defineProperties(p.document.getElementById('a'), { currentSrc: { value: 'https://site.example/mid.jpg' }, naturalWidth: { value: 900 }, naturalHeight: { value: 600 } });
  Object.defineProperties(p.document.getElementById('b'), { currentSrc: { value: 'https://site.example/blank.gif' }, naturalWidth: { value: 1 }, naturalHeight: { value: 1 } });
  Object.defineProperties(p.document.getElementById('c'), { currentSrc: { value: 'https://site.example/icon.png' }, naturalWidth: { value: 24 }, naturalHeight: { value: 24 } });
  const result = p.fromElements([p.document.querySelector('main')]);
  assert.equal(result.markdown, '![](https://site.example/mid.jpg)\n![Real](https://site.example/real.jpg)\ntiny icon');
});

test('Readability path: noise removed from the clone does not unpair the live images from their clones', () => {
  // An image inside a screen-reader-only span comes before the content images; removing it from the clone must not
  // stop currentSrc and natural sizes from reaching the rest.
  const html = `<html><head><title>Post</title></head><body><article><h1>Post</h1><p>${words(40)}</p>
    <span class="sr-only"><img src="/sr.png" alt="Opens in a new tab"></span>
    <figure><img id="a" src="/thumb.jpg" srcset="/big.jpg 2000w" alt="Main"></figure><p>${words(40)}</p><p>Icon <img id="c" src="/icon.png" alt="tiny icon"> here.</p><p>${words(40)}</p></article></body></html>`;
  const p = page(html, { url: 'https://site.example/post' });
  Object.defineProperties(p.document.getElementById('a'), { currentSrc: { value: 'https://site.example/mid.jpg' }, naturalWidth: { value: 900 }, naturalHeight: { value: 600 } });
  Object.defineProperties(p.document.getElementById('c'), { currentSrc: { value: 'https://site.example/icon.png' }, naturalWidth: { value: 24 }, naturalHeight: { value: 24 } });
  const result = p.extract();
  assert.equal(result.source, 'readability');
  assert.match(result.markdown, /^!\[Main\]\(https:\/\/site\.example\/mid\.jpg\)$/m, 'the image the browser loaded');
  assert.match(result.markdown, /^Icon tiny icon here\.$/m, 'a 24px icon stays text');
  assert.deepEqual(result.images, ['https://site.example/mid.jpg']);
  assert.equal(result.cover, 'https://site.example/mid.jpg');
  assert.ok(!/sr\.png|Opens in a new tab/.test(result.markdown));
  assert.equal(p.document.getElementsByTagName('img').length, 3, 'the live page keeps every image');
});

test('embeds: player iframes become ::embed share links; other titled frames become links; video files link', () => {
  const out = md(`<div><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42" title="Never gonna"></iframe>
    <iframe src="https://player.vimeo.com/video/76979871?h=8272103f6e"></iframe><iframe src="https://www.loom.com/embed/0123456789abcdef0123456789abcdef"></iframe>
    <iframe src="https://platform.twitter.com/embed/Tweet.html?id=1234567890123"></iframe><iframe src="https://maps.example/embed?q=1" title="Map of the area"></iframe>
    <iframe src="https://ads.example/frame"></iframe><iframe src="https://w.example/x" title="Tiny" width="1" height="1"></iframe>
    <video src="/clip.mp4"></video><video poster="/poster.jpg"><source src="blob:https://x/1"></video></div>`, { baseUrl: 'https://host.example/' });
  assert.equal(out, ['::embed[Never gonna](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42)', '::embed[Vimeo video](https://vimeo.com/76979871/8272103f6e)',
    '::embed[Loom video](https://www.loom.com/share/0123456789abcdef0123456789abcdef)', '::embed[Post on X](https://x.com/i/status/1234567890123)',
    '[Map of the area](https://maps.example/embed?q=1)', '[Video](https://host.example/clip.mp4)', '![Video](https://host.example/poster.jpg)'].join('\n'));
  assert.deepEqual(types(out).slice(0, 4), ['embed', 'embed', 'embed', 'embed']);
  const rendered = renderMarkdown(out);
  assert.ok(rendered.includes('data-kind="video"') && rendered.includes('YouTube'));
  assert.equal(canonical(out), out);
});

test('callouts from GitHub alerts, admonitions, data-callout and alert classes; quotes keep nested lists as lines', () => {
  const out = md(`<div><div class="markdown-alert markdown-alert-important"><p class="markdown-alert-title">Important</p><p>Read this.</p></div>
    <div class="admonition danger"><p class="admonition-title">Danger</p><p>Hot.</p></div><div class="callout" data-callout="info"><p>Info body</p></div>
    <div class="alert alert-warning">Careful</div><div class="alert">Not a callout</div>
    <blockquote><p>[!NOTE] looks like syntax</p><ul><li>a</li><li>b</li></ul><img src="https://i.example/q.png" alt="q"></blockquote></div>`);
  assert.equal(out, ['> [!IMPORTANT]', '> Read this.', '> [!CAUTION]', '> Hot.', '> [!NOTE]', '> Info body', '> [!WARNING]', '> Careful', 'Not a callout',
    '> \\[!NOTE] looks like syntax', '>', '> - a', '> - b', '![q](https://i.example/q.png)'].join('\n'));
  assert.deepEqual(parseNoteBlocks(out).filter(block => block.type === 'callout').map(block => block.kind), ['important', 'caution', 'note', 'warning']);
  assert.equal(canonical(out), out);
});

test('open shadow roots are read in the live page; selected nav and aside content is kept', () => {
  const p = page('<html><body><nav id="n"><a href="/a">Alpha</a></nav><my-card id="card"><span>light</span></my-card></body></html>', { url: 'https://w.example/' });
  const card = p.document.getElementById('card');
  const shadow = p.document.createDocumentFragment();
  const holder = p.document.createElement('div');
  holder.innerHTML = '<h3>Shadow title</h3><p>Shadow body</p>';
  for (const node of [...holder.childNodes]) shadow.appendChild(node);
  Object.defineProperty(card, 'shadowRoot', { value: shadow });
  const result = p.fromElements([card, p.document.getElementById('n')]);
  assert.equal(result.markdown, '[Alpha](https://w.example/a)\n### Shadow title\nShadow body');
  assert.equal(result.selectionCount, 2);
});

test('fromElements: document order, nested selections absorbed, separate lists stay separate', () => {
  const p = page(`<html><head><title>Notes page</title><meta property="og:title" content="Picked page"></head><body>
    <section id="one"><h2>First</h2><p>Alpha <b id="inner">bold</b></p></section><ul id="list1"><li>x</li></ul><ul id="list2"><li>y</li></ul>
    <section id="two"><p>Second part</p></section></body></html>`, { url: 'https://pick.example/' });
  const $ = id => p.document.getElementById(id);
  const before = p.document.documentElement.outerHTML;
  const result = p.fromElements([$('two'), $('inner'), $('one'), $('list2'), $('list1'), $('one')]);
  assert.equal(p.document.documentElement.outerHTML, before);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'selection');
  assert.equal(result.selectionCount, 4);
  assert.equal(result.title, 'Picked page');
  assert.equal(result.markdown, '## First\nAlpha **bold**\n- x\n\n- y\nSecond part', 'headings that match nothing are kept and order follows the page');
  assert.equal(result.excerpt, 'First Alpha bold x y Second part', 'a selection is described by its own words');
  assert.equal(p.fromElements([]).error, 'Select at least one part of the page to save.');
  assert.equal(p.fromElements($('two')).markdown, 'Second part', 'a single element is accepted too');
});

test('wiki pages: edit links are removed so section headings survive Readability; TeX formulas are kept', () => {
  const formula = '<span class="mwe-math-element"><span class="mwe-math-mathml-inline" style="display: none;"><math><semantics><mi>D</mi>'
    + '<annotation encoding="application/x-tex">{\\displaystyle D=1.22{\\sqrt {H}}}</annotation></semantics></math></span>'
    + '<img src="https://wikimedia.org/api/rest_v1/media/math/render/svg/abc" class="mwe-math-fallback-image-inline" aria-hidden="true" alt="{\\displaystyle D=1.22{\\sqrt {H}}}"></span>';
  const section = name => `<div class="mw-heading mw-heading2"><h2 id="${name}">${name}</h2><span class="mw-editsection"><span class="mw-editsection-bracket">[</span><a href="/w/index.php?title=X&action=edit&section=1">edit</a><span class="mw-editsection-bracket">]</span></span></div>`;
  const html = `<html><head><title>Lighthouse - Wikipedia</title></head><body><div id="content"><h1>Lighthouse</h1><div class="mw-parser-output">
    <p>${words(40)}</p>${section('History')}<p>${words(40)}</p><p>The range is ${formula} nautical miles, with <span class="sr-only">(opens in a new tab)</span>care.</p>
    ${section('Design')}<p>${words(40)}</p></div></div></body></html>`;
  const result = page(html, { url: 'https://en.wikipedia.org/wiki/Lighthouse' }).extract();
  assert.equal(result.source, 'readability');
  assert.match(result.markdown, /^## History$/m);
  assert.match(result.markdown, /^## Design$/m);
  assert.ok(!/edit|opens in a new tab/.test(result.markdown));
  assert.match(result.markdown, /^The range is `D=1\.22\{\\sqrt \{H\}\}` nautical miles, with care\.$/m);
  assert.equal(md(`<p>Live ${formula} math</p>`), 'Live `D=1.22{\\sqrt {H}}` math');
});

// ---------------------------------------------------------------------------------------------------------------
// Site readers

const X_PAGE = `<html lang="en"><head><title>(2) Jack on X: "just setting up" / X</title><link rel="icon" href="https://abs.twimg.com/favicons/twitter.3.ico"></head><body><main role="main"><section>
<article data-testid="tweet"><div data-testid="User-Name"><a href="/parent"><span>Parent</span></a><span>@parent</span></div><div data-testid="tweetText"><span>thread start</span></div><a href="/parent/status/1111111111"><time datetime="2026-01-01T00:00:00.000Z">Jan 1</time></a></article>
<article data-testid="tweet" tabindex="-1">
  <div data-testid="User-Name"><div><a href="/jack" role="link"><div><span><span>Jack</span></span></div></a></div><div><a href="/jack" tabindex="-1"><span>@jack</span></a><span>·</span></div></div>
  <div data-testid="tweetText" lang="en"><span>just setting up my </span><a href="/hashtag/twttr">#twttr</a><img alt="🐦" draggable="false" src="https://abs-0.twimg.com/emoji/v2/svg/1f426.svg"><span> see https://example.com/a_b</span></div>
  <div data-testid="tweetPhoto"><img alt="Image" src="https://pbs.twimg.com/media/ABC?format=jpg&amp;name=small"></div>
  <div role="link" tabindex="0"><div data-testid="User-Name"><a href="/biz"><span>Biz</span></a><span>@biz</span></div><div data-testid="tweetText"><span>quoted words</span></div><div data-testid="tweetPhoto"><img alt="Image" src="https://pbs.twimg.com/media/QUOTED?name=small"></div></div>
  <a href="/jack/status/1234567890123456789"><time datetime="2006-03-21T20:50:14.000Z">Mar 21, 2006</time></a>
</article>
<article data-testid="tweet"><div data-testid="User-Name"><a href="/reply"><span>Replier</span></a><span>@reply</span></div><div data-testid="tweetText">a reply</div><a href="/reply/status/2222222222"><time datetime="2026-01-02T00:00:00Z">x</time></a></article>
</section></main></body></html>`;

test('X: the focal post with author, handle, text, full-size photo and quoted post', () => {
  const result = page(X_PAGE, { url: 'https://x.com/jack/status/1234567890123456789?s=20' }).extract();
  assert.equal(result.source, 'site:x');
  assert.equal(result.title, 'Jack on X: "just setting up my #twttr🐦 see https://example.com/a_b"');
  assert.equal(result.siteName, 'X');
  assert.equal(result.author, 'Jack (@jack)');
  assert.equal(result.publishedAt, '2006-03-21T20:50:14.000Z');
  assert.equal(result.canonicalUrl, 'https://x.com/jack/status/1234567890123456789');
  assert.equal(result.cover, 'https://pbs.twimg.com/media/ABC?format=jpg&name=large');
  assert.equal(result.markdown, ['**Jack** @jack', 'just setting up my [#twttr](https://x.com/hashtag/twttr)🐦 see https://example.com/a_b',
    '![](https://pbs.twimg.com/media/ABC?format=jpg&name=large)', '> **Biz** @biz', '>', '> quoted words'].join('\n'));
  assert.ok(!/thread start|a reply|QUOTED/.test(result.markdown));
  assert.equal(canonical(result.markdown), result.markdown);
});

test('X: a status page that has not rendered posts falls back to the generic reader', () => {
  const result = page(`<html><head><title>X</title></head><body><main>${prose(2)}</main></body></html>`, { url: 'https://twitter.com/jack/status/1234567890123456789' }).extract();
  assert.notEqual(result.source, 'site:x');
  assert.equal(result.ok, true);
});

const GITHUB_PAGE = `<html lang="en"><head><title>GitHub - octo/widget: A tiny widget library</title>
<meta name="description" content="A tiny widget library. Contribute to octo/widget development by creating an account on GitHub.">
<meta property="og:image" content="https://opengraph.githubassets.com/1/octo/widget"><link rel="icon" class="js-site-favicon" type="image/svg+xml" href="https://github.githubassets.com/favicons/favicon.svg"></head>
<body><header><nav>Product Solutions</nav></header><div class="BorderGrid"><a class="topic-tag topic-tag-link" href="/topics/ui">ui</a><a class="topic-tag topic-tag-link" href="/topics/widgets"> widgets </a></div>
<article class="markdown-body entry-content container-lg" itemprop="text">
<div class="markdown-heading"><h1 class="heading-element">Widget</h1><a id="user-content-widget" class="anchor" aria-label="Permalink: Widget" href="#widget"><svg class="octicon"><path d="M0"></path></svg></a></div>
<p>Install it:</p>
<div class="highlight highlight-source-shell notranslate position-relative overflow-auto"><pre>npm install widget</pre><div class="zeroclipboard-container"><clipboard-copy aria-label="Copy" value="npm install widget"><svg></svg></clipboard-copy></div></div>
<div class="markdown-alert markdown-alert-warning"><p class="markdown-alert-title"><svg></svg>Warning</p><p>Beta software.</p></div>
<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled checked> Ship it</li><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled> Docs</li></ul>
<p><a href="/octo/widget/blob/main/docs/guide.md">Guide</a></p>
</article></body></html>`;

test('GitHub: README with description, topics, code language, alert and task list', () => {
  const result = page(GITHUB_PAGE, { url: 'https://github.com/octo/widget' }).extract();
  assert.equal(result.source, 'site:github');
  assert.equal(result.title, 'octo/widget');
  assert.equal(result.siteName, 'GitHub');
  assert.equal(result.author, 'octo');
  assert.equal(result.canonicalUrl, 'https://github.com/octo/widget');
  assert.equal(result.excerpt, 'A tiny widget library');
  assert.equal(result.cover, 'https://opengraph.githubassets.com/1/octo/widget');
  assert.equal(result.icon, 'https://github.githubassets.com/favicons/favicon.svg');
  assert.equal(result.markdown, ['A tiny widget library', 'Topics: ui, widgets', '---', '# Widget', 'Install it:', '```shell', 'npm install widget', '```',
    '> [!WARNING]', '> Beta software.', '- [x] Ship it', '- [ ] Docs', '[Guide](https://github.com/octo/widget/blob/main/docs/guide.md)'].join('\n'));
  assert.equal(canonical(result.markdown), result.markdown);
  const issue = page(GITHUB_PAGE.replace('article class="markdown-body', 'article class="markdown-body comment'), { url: 'https://github.com/octo/widget/issues/7' }).extract();
  assert.notEqual(issue.source, 'site:github', 'issues and pull requests use the generic reader');
  const blob = page(GITHUB_PAGE, { url: 'https://github.com/octo/widget/blob/main/docs/guide.md' }).extract();
  assert.equal(blob.title, 'octo/widget: docs/guide.md');
  assert.equal(blob.canonicalUrl, 'https://github.com/octo/widget/blob/main/docs/guide.md');
});

const YOUTUBE_PAGE = `<html lang="en"><head><title>(3) Great talk - YouTube</title>
<meta property="og:title" content="Old video title"><meta property="og:url" content="https://www.youtube.com/watch?v=OLDVIDEO01">
<meta name="description" content="Old description"><meta property="og:image" content="https://i.ytimg.com/vi/OLDVIDEO01/maxresdefault.jpg"></head>
<body><ytd-app><ytd-watch-metadata><div id="title"><h1 class="style-scope ytd-watch-metadata"><yt-formatted-string>Great talk</yt-formatted-string></h1></div>
<div id="owner"><ytd-channel-name><a href="/@speaker">The Speaker</a></ytd-channel-name></div>
<div id="description-inline-expander"><yt-attributed-string>Line one of the talk.
Slides: https://example.com/slides

- Chapter list
0:00 Intro</yt-attributed-string></div></ytd-watch-metadata></ytd-app></body></html>`;

test('YouTube: title, channel, description and a player embed, ignoring meta tags left from an earlier video', () => {
  const result = page(YOUTUBE_PAGE, { url: 'https://www.youtube.com/watch?v=NEWVIDEO01&t=30s' }).extract();
  assert.equal(result.source, 'site:youtube');
  assert.equal(result.title, 'Great talk');
  assert.equal(result.siteName, 'YouTube');
  assert.equal(result.author, 'The Speaker');
  assert.equal(result.canonicalUrl, 'https://www.youtube.com/watch?v=NEWVIDEO01');
  assert.equal(result.cover, 'https://i.ytimg.com/vi/NEWVIDEO01/hqdefault.jpg');
  assert.equal(result.publishedAt, '');
  assert.match(result.excerpt, /^Line one of the talk\. Slides:/);
  assert.equal(result.markdown, ['::embed[Great talk](https://www.youtube.com/watch?v=NEWVIDEO01)', 'Channel: [The Speaker](https://www.youtube.com/@speaker)',
    'Line one of the talk.\\', 'Slides: https://example.com/slides', '\\- Chapter list\\', '0:00 Intro'].join('\n'));
  assert.equal(canonical(result.markdown), result.markdown);

  const fresh = page(`<html><head><title>Fresh - YouTube</title><meta property="og:url" content="https://www.youtube.com/watch?v=FRESHVID01"><meta property="og:title" content="Fresh title">
    <meta name="description" content="Fresh description"><meta property="og:image" content="https://i.ytimg.com/vi/FRESHVID01/maxresdefault.jpg"></head>
    <body><span itemprop="author"><link itemprop="url" href="https://www.youtube.com/@fresh"><link itemprop="name" content="Fresh Channel"></span><meta itemprop="datePublished" content="2026-10-20T07:00:00-07:00"></body></html>`,
  { url: 'https://www.youtube.com/watch?v=FRESHVID01' }).extract();
  assert.equal(fresh.title, 'Fresh title');
  assert.equal(fresh.author, 'Fresh Channel');
  assert.equal(fresh.publishedAt, '2026-10-20T14:00:00.000Z');
  assert.equal(fresh.cover, 'https://i.ytimg.com/vi/FRESHVID01/maxresdefault.jpg');
  assert.match(fresh.markdown, /^::embed\[Fresh title\]\(https:\/\/www\.youtube\.com\/watch\?v=FRESHVID01\)\nChannel: \[Fresh Channel\]\(https:\/\/www\.youtube\.com\/@fresh\)\nFresh description$/);
});

test('a site reader that throws falls back to the generic reader', () => {
  const p = page(`<html><body><article data-testid="tweet">${prose(3)}</article></body></html>`, { url: 'https://x.com/jack/status/1234567890123456789' });
  p.document.querySelectorAll = () => { throw new Error('reader bug'); };
  const result = p.extract();
  assert.equal(result.ok, true);
  assert.notEqual(result.source, 'site:x');
});

test('a site reader that returns a failed result falls through to the generic reader', () => {
  // A GitHub repo page whose README article is empty, with no description or topics: the GitHub reader has nothing.
  const html = `<html><head><title>octo/widget</title></head><body><main><h1>Widget docs</h1>${prose(3)}</main><article class="markdown-body"></article></body></html>`;
  const result = page(html, { url: 'https://github.com/octo/widget' }).extract();
  assert.equal(result.ok, true);
  assert.notEqual(result.source, 'site:github');
  assert.match(result.markdown, /word0, and more/);
  // A page with nothing readable anywhere still reports a failure, not a crash.
  const empty = page('<html><head><title>octo/widget</title></head><body><article class="markdown-body"></article></body></html>', { url: 'https://github.com/octo/widget' }).extract();
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'empty');
});
