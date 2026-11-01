import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseXml, parseFeed, decodeEntities, htmlToText, htmlLinks, firstImage, taglineFrom, cleanUrl, thumbnailUrl, textOf, findElement,
  dateWindow, zonedMidnight, isoWeek, leaderboardUrl, buildPostsQuery, normalizePost, normalizePosts, normalizeViewer, normalizeConfig,
  classifyError, redact, createProductHuntClient, fetchFeed, sortPosts, visiblePosts, layoutFor, feedKey, modeFor, hideId, topicSlug, topicLabel,
  openUrl, siteIconUrl, draftTopic, OTHER_TOPIC, ProductHuntError, POSTS_QUERY, API_URL, FEED_URL, MAX_HIDDEN, DEFAULT_CONFIG,
} from '../extension/lib/producthunt.js';

const TOKEN = 'ph_dev_0123456789abcdefghijklmnopqrstuvwxyzABCDEF';

// Shaped like https://www.producthunt.com/feed (Atom, HTML content escaped once), plus the edge cases feeds produce.
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<!-- generated -->
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <id>tag:www.producthunt.com,2005:/feed</id>
  <link rel="alternate" type="text/html" href="https://www.producthunt.com"/>
  <link rel="self" type="application/atom+xml" href="https://www.producthunt.com/feed"/>
  <title>Product Hunt — The best new products, every day</title>
  <updated>2026-10-30T00:01:00-07:00</updated>
  <entry>
    <id>tag:www.producthunt.com,2005:Post/1292499</id>
    <published>2026-10-25T10:43:45-07:00</published>
    <updated>2026-10-30T15:35:06-07:00</updated>
    <link rel="alternate" type="text/html" href="https://www.producthunt.com/products/stereolift-live?utm_source=feed"/>
    <title>StereoLift Live</title>
    <content type="html">          &lt;p&gt;
            your desktop in real 3D, live on your Quest
          &lt;/p&gt;
          &lt;p&gt;
            &lt;a href="https://www.producthunt.com/products/stereolift-live?utm_campaign=producthunt-atom-posts-feed&amp;amp;utm_medium=rss-feed"&gt;Discussion&lt;/a&gt;
            |
            &lt;a href="https://www.producthunt.com/r/p/1292499?app_id=339"&gt;Link&lt;/a&gt;
          &lt;/p&gt;
</content>
    <author>
      <name>Marvin Weigand</name>
    </author>
  </entry>
  <entry>
    <id>tag:www.producthunt.com,2005:Post/1282624</id>
    <published>2026-10-29T08:08:14-07:00</published>
    <updated>2026-10-30T14:50:23-07:00</updated>
    <link rel="alternate" type="text/html" href="https://www.producthunt.com/products/cluinn"/>
    <title>Cluinn &amp; Co &#8212; &#x201C;calls&#x201D;</title>
    <content type="html"><![CDATA[<p><img src="https://ph-files.imgix.net/abc.png?auto=format"> Answers your questions <b>during</b> the call, not after. For Mac.</p><p><a href="https://www.producthunt.com/products/cluinn">Discussion</a> | <a href="https://www.producthunt.com/r/p/1282624">Link</a></p>]]></content>
    <author><name>Hoid P</name></author>
  </entry>
  <entry>
    <id>tag:www.producthunt.com,2005:Post/1292499</id>
    <title>StereoLift Live (duplicate)</title>
    <link href="https://www.producthunt.com/products/stereolift-live"/>
  </entry>
  <entry>
    <id>tag:www.producthunt.com,2005:Post/77</id>
    <title>Media Thumb</title>
    <link rel="alternate" href="javascript:alert(1)"/>
    <media:thumbnail url="https://ph-files.imgix.net/thumb.png"/>
    <summary>Plain summary text</summary>
  </entry>
</feed>`;

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Launches</title>
<lastBuildDate>Fri, 30 Oct 2026 07:00:00 GMT</lastBuildDate>
<item><title>Orbit</title><link>https://www.producthunt.com/posts/orbit?utm_medium=rss</link><guid>https://www.producthunt.com/posts/orbit</guid>
<description>&lt;p&gt;Plan your week in orbit&lt;/p&gt;</description><pubDate>Thu, 29 Oct 2026 07:01:00 GMT</pubDate><dc:creator>Ana</dc:creator>
<enclosure url="https://example.com/orbit.png" type="image/png" length="1"/></item>
</channel></rss>`;

// ------------------------------------------------------------------------------------------------ XML

test('decodeEntities handles named, decimal and hex references and leaves unknown names alone', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'), 'a & b <c> "d" \'e\'');
  assert.equal(decodeEntities('&#8212; &#x201C;x&#x201D; &hellip;'), '— “x” …');
  assert.equal(decodeEntities('&unknown; &#0; &#xD800;'), '&unknown;  ');
  assert.equal(decodeEntities('&amp;amp;'), '&amp;', 'decodes once');
});

test('parseXml builds a tree, keeps CDATA verbatim, skips comments and doctypes and tolerates stray markup', () => {
  const doc = parseXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><!-- c --><root a="1" b=\'two &amp; three\'><x/>text &lt; 3 <![CDATA[<b>raw</b>]]><y>in</z></y> 1 < 2</root>');
  const root = findElement(doc, 'root');
  assert.deepEqual(root.attrs, { a: '1', b: 'two & three' });
  assert.equal(root.children[0].name, 'x');
  assert.equal(textOf(root), 'text < 3 <b>raw</b>in 1 < 2');
  assert.equal(findElement(doc, 'y').children[0], 'in');
});

test('parseXml ignores prototype attribute names', () => {
  const doc = parseXml('<a __proto__="x" constructor="y" ok="1"/>');
  const a = findElement(doc, 'a');
  assert.deepEqual(Object.keys(a.attrs), ['ok']);
  assert.equal(({}).polluted, undefined);
});

// ------------------------------------------------------------------------------------------------ HTML helpers

test('HTML helpers extract text, links, the first image and the tagline paragraph', () => {
  const html = '<p>\n  Ship <b>faster</b> &amp; calmer\n</p><p><a href="https://x.test/d?utm_source=a&amp;k=1">Discussion</a> | <a href="https://x.test/r/p/1">Link</a></p>';
  assert.equal(htmlToText(html), 'Ship faster & calmer Discussion | Link');
  assert.deepEqual(htmlLinks(html), [{ href: 'https://x.test/d?utm_source=a&k=1', text: 'Discussion' }, { href: 'https://x.test/r/p/1', text: 'Link' }]);
  assert.equal(taglineFrom(html), 'Ship faster & calmer');
  assert.equal(taglineFrom('<p><a href="#">Discussion</a> | <a href="#">Link</a></p>'), '');
  assert.equal(taglineFrom('No paragraphs here'), 'No paragraphs here');
  assert.equal(htmlToText('<script>alert(1)</script>Safe<style>p{}</style>'), 'Safe');
  assert.equal(firstImage('<img src="data:x"><img alt="" src="https://cdn.test/a.png?utm_medium=x">'), 'https://cdn.test/a.png');
});

test('cleanUrl keeps http(s) only and drops tracking parameters; thumbnailUrl sizes imgix images', () => {
  assert.equal(cleanUrl('https://a.test/p?utm_source=x&id=2'), 'https://a.test/p?id=2');
  assert.equal(cleanUrl('javascript:alert(1)'), '');
  assert.equal(cleanUrl('not a url'), '');
  assert.equal(thumbnailUrl('https://ph-files.imgix.net/a.png?auto=format', 40), 'https://ph-files.imgix.net/a.png?auto=format&fit=crop&w=80&h=80');
  assert.equal(thumbnailUrl('https://ph-files.imgix.net/b.gif', 24), 'https://ph-files.imgix.net/b.gif?auto=format&fit=crop&w=48&h=48&frame=1');
  assert.equal(thumbnailUrl('https://example.com/a.png', 40), 'https://example.com/a.png');
  assert.equal(thumbnailUrl('', 40), '');
});

// ------------------------------------------------------------------------------------------------ feed

test('parseFeed reads Product Hunt’s Atom feed into posts', () => {
  const feed = parseFeed(ATOM);
  assert.equal(feed.kind, 'feed');
  assert.equal(feed.title, 'Product Hunt — The best new products, every day');
  assert.equal(feed.updated, '2026-10-30T07:01:00.000Z');
  assert.equal(feed.posts.length, 3, 'duplicate post ids are dropped');
  const [first, second, third] = feed.posts;
  assert.deepEqual(first, {
    id: '1292499', name: 'StereoLift Live', tagline: 'your desktop in real 3D, live on your Quest',
    url: 'https://www.producthunt.com/products/stereolift-live', website: 'https://www.producthunt.com/r/p/1292499?app_id=339',
    thumbnail: '', votes: null, comments: null, createdAt: '2026-10-25T17:43:45.000Z', featuredAt: '', updatedAt: '2026-10-30T22:35:06.000Z',
    topics: [], makers: [{ name: 'Marvin Weigand', username: '', avatar: '' }], rank: 1, source: 'feed',
  });
  assert.equal(second.name, 'Cluinn & Co — “calls”');
  assert.equal(second.tagline, 'Answers your questions during the call, not after. For Mac.');
  assert.equal(second.thumbnail, 'https://ph-files.imgix.net/abc.png?auto=format');
  assert.equal(second.website, 'https://www.producthunt.com/r/p/1282624');
  assert.equal(second.rank, 2);
  assert.equal(third.id, '77');
  assert.equal(third.url, 'https://www.producthunt.com', 'unsafe links fall back to Product Hunt');
  assert.equal(third.thumbnail, 'https://ph-files.imgix.net/thumb.png');
  assert.equal(third.tagline, 'Plain summary text');
});

test('parseFeed also reads RSS 2.0 and rejects documents that are not feeds', () => {
  const feed = parseFeed(RSS);
  assert.equal(feed.title, 'Launches');
  assert.equal(feed.posts.length, 1);
  assert.equal(feed.posts[0].url, 'https://www.producthunt.com/posts/orbit');
  assert.equal(feed.posts[0].tagline, 'Plan your week in orbit');
  assert.equal(feed.posts[0].thumbnail, 'https://example.com/orbit.png');
  assert.equal(feed.posts[0].makers[0].name, 'Ana');
  assert.equal(feed.posts[0].createdAt, '2026-10-29T07:01:00.000Z');
  assert.throws(() => parseFeed('<html><body>Just a moment…</body></html>'), error => error instanceof ProductHuntError && error.kind === 'parse');
  assert.throws(() => parseFeed(''), ProductHuntError);
});

test('fetchFeed reports HTTP failures and network errors calmly', async () => {
  const ok = await fetchFeed({ fetch: async url => { assert.equal(url, FEED_URL); return { ok: true, status: 200, text: async () => ATOM }; } });
  assert.equal(ok.posts.length, 3);
  await assert.rejects(fetchFeed({ fetch: async () => ({ ok: false, status: 503, text: async () => '' }) }), { kind: 'server', message: /not responding/ });
  await assert.rejects(fetchFeed({ fetch: async () => ({ ok: false, status: 429, text: async () => '' }) }), { kind: 'rate' });
  await assert.rejects(fetchFeed({ fetch: async () => { throw new TypeError('Failed to fetch'); } }), { kind: 'network', message: /Unable to reach Product Hunt/ });
});

// ------------------------------------------------------------------------------------------------ dates

test('dateWindow follows Product Hunt’s Pacific-time day', () => {
  const morning = Date.parse('2026-10-30T12:00:00Z');   // 05:00 PDT
  assert.deepEqual(dateWindow('today', { now: morning }), { range: 'today', after: '2026-10-30T07:00:00.000Z', before: '2026-10-31T07:00:00.000Z', key: '2026-10-30' });
  assert.deepEqual(dateWindow('yesterday', { now: morning }), { range: 'yesterday', after: '2026-10-29T07:00:00.000Z', before: '2026-10-30T07:00:00.000Z', key: '2026-10-29' });
  // 23:30 PDT on Oct 30 is already Oct 31 in UTC, but still Oct 30 on Product Hunt.
  assert.equal(dateWindow('today', { now: Date.parse('2026-10-31T06:30:00Z') }).key, '2026-10-30');
  assert.equal(dateWindow('nonsense', { now: morning }).range, 'today');
});

test('dateWindow handles weeks from Monday, months and the daylight-saving change', () => {
  const friday = Date.parse('2026-10-30T12:00:00Z');
  assert.deepEqual(dateWindow('week', { now: friday }), { range: 'week', after: '2026-10-26T07:00:00.000Z', before: '2026-11-02T08:00:00.000Z', key: '2026-10-26' });
  assert.deepEqual(dateWindow('month', { now: friday }), { range: 'month', after: '2026-10-01T07:00:00.000Z', before: '2026-11-01T07:00:00.000Z', key: '2026-10-01' });
  // Daylight saving ends on Nov 1, 2026: Nov 1 starts at 07:00Z (PDT), Nov 2 at 08:00Z (PST).
  const monday = Date.parse('2026-11-02T12:00:00Z');
  assert.deepEqual(dateWindow('yesterday', { now: monday }), { range: 'yesterday', after: '2026-11-01T07:00:00.000Z', before: '2026-11-02T08:00:00.000Z', key: '2026-11-01' });
  assert.equal(dateWindow('week', { now: monday }).after, '2026-11-02T08:00:00.000Z', 'Monday starts a new week');
  assert.equal(dateWindow('month', { now: Date.parse('2026-12-15T12:00:00Z') }).before, '2027-01-01T08:00:00.000Z', 'December rolls into January');
  assert.equal(new Date(zonedMidnight(2026, 3, 8)).toISOString(), '2026-03-08T08:00:00.000Z', 'spring-forward day starts in PST');
  assert.equal(new Date(zonedMidnight(2026, 3, 9)).toISOString(), '2026-03-09T07:00:00.000Z');
  assert.equal(new Date(zonedMidnight(2026, 1, 1, 'UTC')).toISOString(), '2026-01-01T00:00:00.000Z');
});

test('isoWeek and leaderboardUrl match Product Hunt’s leaderboard pages', () => {
  assert.deepEqual(isoWeek(2026, 10, 30), { year: 2026, week: 44 });
  assert.deepEqual(isoWeek(2027, 1, 1), { year: 2026, week: 53 });
  assert.deepEqual(isoWeek(2025, 12, 29), { year: 2026, week: 1 });
  const now = Date.parse('2026-10-30T12:00:00Z');
  assert.equal(leaderboardUrl('today', { now }), 'https://www.producthunt.com/leaderboard/daily/2026/10/30');
  assert.equal(leaderboardUrl('yesterday', { now }), 'https://www.producthunt.com/leaderboard/daily/2026/10/29');
  assert.equal(leaderboardUrl('week', { now }), 'https://www.producthunt.com/leaderboard/weekly/2026/44');
  assert.equal(leaderboardUrl('month', { now }), 'https://www.producthunt.com/leaderboard/monthly/2026/10');
  assert.equal(leaderboardUrl('latest', { now }), 'https://www.producthunt.com/');
});

// ------------------------------------------------------------------------------------------------ GraphQL

test('buildPostsQuery sends the window, order, topic and featured filter', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const { query, variables, window } = buildPostsQuery({ range: 'yesterday', sort: 'votes', topic: 'Developer Tools', featured: true, first: 15, now });
  assert.equal(query, POSTS_QUERY);
  assert.match(query, /posts\(first: \$first, order: \$order, postedAfter: \$postedAfter, postedBefore: \$postedBefore, topic: \$topic, featured: \$featured\)/);
  assert.match(query, /votesCount commentsCount/);
  assert.match(query, /thumbnail \{ type url \}/);
  assert.deepEqual(variables, { first: 15, order: 'VOTES', postedAfter: '2026-10-29T07:00:00.000Z', postedBefore: '2026-10-30T07:00:00.000Z', topic: 'developer-tools', featured: true });
  assert.equal(window.key, '2026-10-29');

  const all = buildPostsQuery({ range: 'week', sort: 'comments', featured: false, first: 500, now }).variables;
  assert.equal(all.order, 'RANKING', 'most discussed sorts the ranking locally');
  assert.equal(all.first, 50, 'the API caps a page at 50');
  assert.equal('topic' in all, false);
  assert.equal('featured' in all, false);
  assert.equal(buildPostsQuery({ sort: 'newest', now }).variables.order, 'NEWEST');
});

test('normalizePost maps API nodes, strips tracking and drops redacted makers', () => {
  const post = normalizePost({
    id: '991', name: 'Lumen', tagline: 'Light for your notes', slug: 'lumen', url: 'https://www.producthunt.com/posts/lumen?utm_campaign=producthunt-api&utm_medium=api-v2',
    website: 'https://www.producthunt.com/r/ABC?utm_campaign=producthunt-api', votesCount: '412', commentsCount: 38, createdAt: '2026-10-30T07:01:00Z', featuredAt: '2026-10-30T07:01:00Z',
    thumbnail: { type: 'image', url: 'https://ph-files.imgix.net/lumen.png?auto=format' },
    topics: { edges: [{ node: { name: 'Productivity', slug: 'productivity' } }, { node: { name: 'Writing', slug: 'writing' } }] },
    makers: [{ name: '[REDACTED]', username: '[REDACTED]' }, { name: 'Ada', username: 'ada', profileImage: 'https://ph-avatars.imgix.net/1.png' }],
  }, 2);
  assert.deepEqual(post, {
    id: '991', name: 'Lumen', tagline: 'Light for your notes', url: 'https://www.producthunt.com/posts/lumen', website: 'https://www.producthunt.com/r/ABC',
    thumbnail: 'https://ph-files.imgix.net/lumen.png?auto=format', votes: 412, comments: 38, createdAt: '2026-10-30T07:01:00.000Z', featuredAt: '2026-10-30T07:01:00.000Z',
    updatedAt: '', topics: [{ name: 'Productivity', slug: 'productivity' }, { name: 'Writing', slug: 'writing' }],
    makers: [{ name: 'Ada', username: 'ada', avatar: 'https://ph-avatars.imgix.net/1.png' }], rank: 3, source: 'api',
  });
  const bare = normalizePost({ id: 5, slug: 'x y' });
  assert.equal(bare.name, 'Untitled');
  assert.equal(bare.url, 'https://www.producthunt.com/posts/x%20y');
  assert.equal(bare.votes, null);
  assert.deepEqual(normalizePosts({ posts: { edges: [{ node: { id: 1, name: 'A' } }, null, { node: { id: 2, name: 'B' } }] } }).map(p => [p.id, p.rank]), [['1', 1], ['2', 2]]);
  assert.deepEqual(normalizePosts(null), []);
  assert.deepEqual(normalizeViewer({ viewer: { user: { id: 7, name: 'Maddy', username: 'maddy', profileImage: 'https://ph-avatars.imgix.net/7.png' } } }),
    { id: '7', name: 'Maddy', username: 'maddy', avatarUrl: 'https://ph-avatars.imgix.net/7.png' });
  assert.deepEqual(normalizeViewer({ viewer: null }), { id: '', name: '', username: '', avatarUrl: '' });
});

test('classifyError and redact keep tokens out of messages', () => {
  assert.equal(classifyError(401, { errors: [{ error: 'invalid_oauth_token' }] }).kind, 'auth');
  assert.equal(classifyError(200, { errors: [{ error: 'invalid_oauth_token', error_description: 'bad' }] }).kind, 'auth');
  const headers = { get: name => (name === 'x-rate-limit-reset' ? '120' : null) };
  const rate = classifyError(429, null, { headers, now: 1000 });
  assert.equal(rate.kind, 'rate');
  assert.equal(rate.retryAt, 121000);
  assert.equal(classifyError(502, null).kind, 'server');
  const leaked = classifyError(400, { errors: [{ message: `Field bad for ${TOKEN}` }] }, { token: TOKEN });
  assert.equal(leaked.kind, 'graphql');
  assert.ok(!leaked.message.includes(TOKEN));
  assert.match(leaked.message, /\[token\]/);
  assert.equal(redact('Authorization: Bearer abc.def-123'), 'Authorization: Bearer [token]');
});

test('createProductHuntClient posts GraphQL with a bearer token and normalizes posts', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { posts: { edges: [{ node: { id: '1', name: 'One', votesCount: 9 } }] } } }) };
  };
  const client = createProductHuntClient({ token: TOKEN, fetch: fetcher });
  const result = await client.posts({ range: 'today', now: Date.parse('2026-10-30T12:00:00Z') });
  assert.equal(calls[0].url, API_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].body.variables.postedAfter, '2026-10-30T07:00:00.000Z');
  assert.equal(result.kind, 'posts');
  assert.equal(result.window.key, '2026-10-30');
  assert.deepEqual(result.posts.map(p => [p.name, p.votes]), [['One', 9]]);

  const rejecting = createProductHuntClient({ token: TOKEN, fetch: async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({ data: null, errors: [{ error: 'invalid_oauth_token' }] }) }) });
  await assert.rejects(rejecting.viewer(), error => error.kind === 'auth' && !error.message.includes(TOKEN));
  const garbled = createProductHuntClient({ token: TOKEN, fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('x'); } }) });
  await assert.rejects(garbled.posts(), { kind: 'graphql' });
  const offline = createProductHuntClient({ token: TOKEN, fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.posts(), { kind: 'network' });
  assert.throws(() => createProductHuntClient({ token: '' }), { kind: 'auth' });
});

// ------------------------------------------------------------------------------------------------ config and lists

test('normalizeConfig fills defaults and coerces stored values', () => {
  assert.deepEqual(normalizeConfig(), { ...DEFAULT_CONFIG, hidden: [] });
  const c = normalizeConfig({ source: 'feed', range: 'week', sort: 'bogus', topic: 'Health & Fitness', featured: 'false', layout: 'cards', limit: '10',
    showThumbs: 'false', open: 'website', refresh: '0', hidden: ['a', 'a', 3, 'b'], collectionId: 42 });
  assert.equal(c.source, 'feed');
  assert.equal(c.range, 'week');
  assert.equal(c.sort, 'ranking');
  assert.equal(c.topic, 'health-fitness');
  assert.equal(c.featured, false);
  assert.equal(c.layout, 'cards');
  assert.equal(c.limit, 10);
  assert.equal(c.showThumbs, false);
  assert.equal(c.open, 'website');
  assert.equal(c.refresh, 0);
  assert.deepEqual(c.hidden, ['a', 'b']);
  assert.equal(c.collectionId, '');
  assert.equal(normalizeConfig({ limit: 7, refresh: 2 }).limit, 20);
  assert.equal(normalizeConfig({ refresh: 2 }).refresh, 30);
});

test('topic helpers turn labels and URLs into slugs and back', () => {
  assert.equal(topicSlug('https://www.producthunt.com/topics/developer-tools?ref=x'), 'developer-tools');
  assert.equal(topicSlug('  AI / ML  '), 'ai-ml');
  assert.equal(topicLabel('developer-tools'), 'Developer tools');
  assert.equal(topicLabel('space-tech'), 'Space tech');
  assert.equal(topicLabel(''), '');
});

test('draftTopic reads the typed topic only when "Another topic…" is chosen', () => {
  assert.equal(draftTopic({ topic: 'developer-tools', topicOther: 'ignored' }), 'developer-tools');
  assert.equal(draftTopic({ topic: OTHER_TOPIC, topicOther: 'Space Tech' }), 'space-tech');
  assert.equal(draftTopic({ topic: OTHER_TOPIC, topicOther: 'https://www.producthunt.com/topics/web3?ref=x' }), 'web3');
  assert.equal(draftTopic({ topic: OTHER_TOPIC, topicOther: '  !! ' }), '');
  assert.equal(draftTopic({ topic: '' }), '');
  assert.equal(draftTopic(), '');
  assert.equal(normalizeConfig({ topic: draftTopic({ topic: OTHER_TOPIC, topicOther: 'Climate tech' }), topicOther: 'x' }).topic, 'climate-tech');
  assert.equal('topicOther' in normalizeConfig({ topicOther: 'x' }), false, 'the free-text field never reaches the stored config');
});

test('hideId appends once and caps the list', () => {
  assert.deepEqual(hideId(['a', 'b'], 'a'), ['b', 'a']);
  const many = hideId(Array.from({ length: MAX_HIDDEN }, (_, i) => `p${i}`), 'new');
  assert.equal(many.length, MAX_HIDDEN);
  assert.equal(many.at(-1), 'new');
  assert.equal(many[0], 'p1');
});

const posts = [
  { id: 'a', rank: 1, votes: 10, comments: 1, createdAt: '2026-10-30T07:01:00Z', featuredAt: '' },
  { id: 'b', rank: 2, votes: 50, comments: 9, createdAt: '2026-10-30T09:00:00Z', featuredAt: '' },
  { id: 'c', rank: 3, votes: 50, comments: 3, createdAt: '2026-10-29T09:00:00Z', featuredAt: '2026-10-30T08:00:00Z' },
  { id: 'd', rank: 4, votes: null, comments: null, createdAt: '', featuredAt: '' },
];

test('sortPosts and visiblePosts order, hide and renumber', () => {
  assert.deepEqual(sortPosts(posts, 'ranking').map(p => p.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(sortPosts(posts, 'votes').map(p => p.id), ['b', 'c', 'a', 'd']);
  assert.deepEqual(sortPosts(posts, 'comments').map(p => p.id), ['b', 'c', 'a', 'd']);
  assert.deepEqual(sortPosts(posts, 'newest').map(p => p.id), ['b', 'c', 'a', 'd']);
  assert.deepEqual(sortPosts([...posts].reverse(), 'ranking').map(p => p.id), ['a', 'b', 'c', 'd']);
  const shown = visiblePosts(posts, { sort: 'votes', hidden: ['b'], limit: 2 });
  assert.deepEqual(shown.map(p => [p.id, p.position]), [['c', 1], ['a', 2]]);
  assert.equal(posts[0].position, undefined, 'inputs are not mutated');
});

test('modeFor, feedKey and layoutFor', () => {
  assert.equal(modeFor({}, { connected: true }), 'api');
  assert.equal(modeFor({ source: 'feed' }, { connected: true }), 'feed');
  assert.equal(modeFor({}, { connected: false }), 'feed');
  const now = Date.parse('2026-10-30T12:00:00Z');
  assert.equal(feedKey({}, { mode: 'feed', now }), 'producthunt:feed');
  assert.equal(feedKey({ topic: 'saas' }, { mode: 'api', now }), 'producthunt:posts:today:2026-10-30:ranking:saas:featured');
  assert.equal(feedKey({ sort: 'comments', featured: false }, { mode: 'api', now }), 'producthunt:posts:today:2026-10-30:ranking:all:all');
  assert.equal(feedKey({ range: 'today' }, { mode: 'api', now: Date.parse('2026-10-31T12:00:00Z') }), 'producthunt:posts:today:2026-10-31:ranking:all:featured');

  assert.equal(layoutFor({ w: 2, h: 2, size: 'xs' }), 'top');
  assert.equal(layoutFor({ w: 3, h: 3, size: 's' }), 'top');
  assert.equal(layoutFor({ w: 12, h: 2, size: 's' }), 'top', 'wide and short');
  assert.equal(layoutFor({ w: 2, h: 8, size: 's' }), 'top', 'too narrow for rows');
  assert.equal(layoutFor({ w: 3, h: 7, size: 's' }), 'list', 'tall and narrow gets a list');
  assert.equal(layoutFor({ w: 4, h: 5, size: 'm' }), 'list');
  assert.equal(layoutFor({ w: 8, h: 6, size: 'l' }), 'list');
  assert.equal(layoutFor({ w: 10, h: 8, size: 'xl' }), 'cards');
  assert.equal(layoutFor({ w: 4, h: 10, size: 'xl' }), 'list', 'extra tall but narrow stays a list');
  assert.equal(layoutFor({ w: 6, h: 4, size: 'm' }, { layout: 'cards' }), 'cards');
  assert.equal(layoutFor({ w: 3, h: 4, size: 's' }, { layout: 'cards' }), 'list');
  assert.equal(layoutFor({ w: 3, h: 4, size: 's' }, { layout: 'list' }), 'list');
  assert.equal(layoutFor({ w: 2, h: 2, size: 'xs' }, { layout: 'list' }), 'top');
  assert.equal(layoutFor({ w: 10, h: 8, size: 'xl' }, { layout: 'top' }), 'top');
});

test('siteIconUrl skips Product Hunt redirect links and keeps real product sites', () => {
  assert.equal(siteIconUrl({ website: 'https://www.producthunt.com/r/p/1297499?app_id=339' }), '');
  assert.equal(siteIconUrl({ website: 'https://producthunt.com/r/abc' }), '');
  assert.equal(siteIconUrl({ website: 'https://linear.app/?utm_source=producthunt&ref=ph' }), 'https://linear.app/?ref=ph');
  assert.equal(siteIconUrl({ website: 'javascript:alert(1)' }), '');
  assert.equal(siteIconUrl({}), '');
  assert.equal(siteIconUrl(null), '');
});

test('openUrl prefers the product site only when chosen and known', () => {
  const post = { url: 'https://www.producthunt.com/posts/a', website: 'https://www.producthunt.com/r/p/1' };
  assert.equal(openUrl(post), post.url);
  assert.equal(openUrl(post, 'website'), post.website);
  assert.equal(openUrl({ url: post.url, website: '' }, 'website'), post.url);
  assert.equal(openUrl(null), 'https://www.producthunt.com');
});
