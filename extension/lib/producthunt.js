// Product Hunt data for the dashboard's Product Hunt widget: a dependency-free XML parser for the public Atom feed, the
// API v2 GraphQL client (developer token), launch-day windows on Product Hunt's Pacific-time calendar, normalization and
// the pure list helpers (sorting, hiding, layouts). No DOM and no storage here; the widget (ui/widgets/product-hunt.js)
// owns caching and credentials. A token never appears in an error message or a return value.

export const ACCOUNT_ID = 'producthunt';
export const PH_SITE = 'https://www.producthunt.com';
export const FEED_URL = 'https://www.producthunt.com/feed';
/** The feed sends no CORS headers, so reading it needs host access. The API allows any origin and needs none. */
export const FEED_ORIGIN = 'https://www.producthunt.com/*';
export const API_URL = 'https://api.producthunt.com/v2/api/graphql';
export const TOKEN_URL = 'https://www.producthunt.com/v2/oauth/applications';
export const API_DOCS_URL = 'https://api.producthunt.com/v2/docs';
/** Product Hunt's launch day starts at midnight in San Francisco. */
export const PH_TIME_ZONE = 'America/Los_Angeles';
export const MAX_HIDDEN = 300;

/** Launch windows for the API. The public feed has one list ("Latest"). */
export const RANGES = Object.freeze([
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
]);
export const rangeOf = id => RANGES.find(range => range.id === id) || RANGES[0];

/** Sort orders. `order` is the API's PostsOrder; "Most discussed" fetches the ranking and sorts it here. */
export const SORTS = Object.freeze([
  { value: 'ranking', label: 'Ranking', feedLabel: 'Featured order', order: 'RANKING', feed: true },
  { value: 'votes', label: 'Most upvoted', order: 'VOTES', feed: false },
  { value: 'comments', label: 'Most discussed', order: 'RANKING', feed: false },
  { value: 'newest', label: 'Newest', feedLabel: 'Newest first', order: 'NEWEST', feed: true },
]);
export const sortOf = value => SORTS.find(sort => sort.value === value) || SORTS[0];

/** Popular Product Hunt topics (API topic slugs). Any other slug can be typed in the widget settings. */
export const TOPICS = Object.freeze([
  { slug: 'artificial-intelligence', label: 'Artificial intelligence' },
  { slug: 'developer-tools', label: 'Developer tools' },
  { slug: 'productivity', label: 'Productivity' },
  { slug: 'design-tools', label: 'Design tools' },
  { slug: 'marketing', label: 'Marketing' },
  { slug: 'saas', label: 'SaaS' },
  { slug: 'no-code', label: 'No-code' },
  { slug: 'open-source', label: 'Open source' },
  { slug: 'analytics', label: 'Analytics' },
  { slug: 'user-experience', label: 'User experience' },
  { slug: 'writing', label: 'Writing' },
  { slug: 'fintech', label: 'Fintech' },
  { slug: 'health-fitness', label: 'Health & fitness' },
  { slug: 'education', label: 'Education' },
  { slug: 'chrome-extensions', label: 'Chrome extensions' },
  { slug: 'mac', label: 'Mac' },
  { slug: 'iphone', label: 'iPhone' },
  { slug: 'android', label: 'Android' },
  { slug: 'github', label: 'GitHub' },
  { slug: 'api', label: 'API' },
  { slug: 'remote-work', label: 'Remote work' },
  { slug: 'games', label: 'Games' },
]);
export const topicLabel = slug => TOPICS.find(topic => topic.slug === slug)?.label
  || String(slug || '').split('-').filter(Boolean).map((word, index) => (index ? word : word[0].toUpperCase() + word.slice(1))).join(' ');

export const LAYOUTS = Object.freeze([
  { value: 'auto', label: 'Automatic' }, { value: 'top', label: 'Top 3' }, { value: 'list', label: 'List' }, { value: 'cards', label: 'Cards' },
]);
export const SOURCES = Object.freeze([
  { value: 'auto', label: 'Rankings when connected' }, { value: 'feed', label: 'Public feed only' },
]);
export const OPEN_TARGETS = Object.freeze([
  { value: 'product', label: 'Product Hunt page' }, { value: 'website', label: 'Product website' },
]);
export const REFRESH_OPTIONS = Object.freeze([
  { value: 15, label: 'Every 15 minutes' }, { value: 30, label: 'Every 30 minutes' }, { value: 60, label: 'Every hour' },
  { value: 180, label: 'Every 3 hours' }, { value: 0, label: 'Only when I refresh' },
]);
export const LIMITS = Object.freeze([5, 10, 15, 20, 30, 50]);

export const DEFAULT_CONFIG = Object.freeze({
  source: 'auto', range: 'today', sort: 'ranking', topic: '', featured: true, layout: 'auto', limit: 20,
  showThumbs: true, showTaglines: true, showTopics: true, open: 'product', collectionId: '', refresh: 30, hidden: [],
});

const bool = (value, fallback) => (value === true || value === 'true' ? true : value === false || value === 'false' ? false : fallback);
const pick = (list, value, fallback, key = 'value') => (list.some(entry => String(entry[key]) === String(value)) ? list.find(entry => String(entry[key]) === String(value))[key] : fallback);

/** Topic slug from a slug, a label or a topic URL: "Developer Tools" -> "developer-tools". */
export function topicSlug(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/^https?:\/\/[^/]+\/topics\//, '').replace(/[?#].*$/, '');
  return text.replace(/&/g, ' ').replace(/[^a-z\d]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** Topic select value that reveals a free-text topic field in the widget settings. */
export const OTHER_TOPIC = '__other';
/** The topic a settings draft asks for: a listed slug, or the typed one when "Another topic…" is chosen. */
export function draftTopic(draft = {}) {
  return draft?.topic === OTHER_TOPIC ? topicSlug(draft.topicOther) : topicSlug(draft?.topic);
}

/** Config with every key valid (select fields arrive as strings; older widgets miss newer keys). */
export function normalizeConfig(config = {}) {
  const c = { ...DEFAULT_CONFIG, ...(config && typeof config === 'object' ? config : {}) };
  const limit = Number(c.limit);
  const refresh = Number(c.refresh);
  return {
    source: pick(SOURCES, c.source, DEFAULT_CONFIG.source),
    range: rangeOf(c.range).id,
    sort: sortOf(c.sort).value,
    topic: topicSlug(c.topic),
    featured: bool(c.featured, true),
    layout: pick(LAYOUTS, c.layout, DEFAULT_CONFIG.layout),
    limit: LIMITS.includes(limit) ? limit : DEFAULT_CONFIG.limit,
    showThumbs: bool(c.showThumbs, true),
    showTaglines: bool(c.showTaglines, true),
    showTopics: bool(c.showTopics, true),
    open: pick(OPEN_TARGETS, c.open, DEFAULT_CONFIG.open),
    collectionId: typeof c.collectionId === 'string' ? c.collectionId : '',
    refresh: REFRESH_OPTIONS.some(o => o.value === refresh) ? refresh : DEFAULT_CONFIG.refresh,
    hidden: Array.isArray(c.hidden) ? [...new Set(c.hidden.filter(id => typeof id === 'string' && id))].slice(-MAX_HIDDEN) : [],
  };
}

/** Adds a product id to the hidden list (newest last, capped). */
export function hideId(hidden = [], id) {
  const list = (Array.isArray(hidden) ? hidden : []).filter(entry => entry !== id);
  if (id) list.push(String(id));
  return list.slice(-MAX_HIDDEN);
}

// ------------------------------------------------------------------------------------------------ errors

export class ProductHuntError extends Error {
  constructor(message, { kind = 'error', status = 0, retryAt = 0 } = {}) {
    super(message);
    this.name = 'ProductHuntError';
    this.kind = kind;       // auth | rate | network | timeout | server | graphql | parse | access
    this.status = status;
    this.retryAt = retryAt; // epoch ms when a rate limit resets (0 when unknown)
  }
}

/** Replaces the token (and anything shaped like a bearer token) before text reaches the UI. */
export function redact(text, token) {
  let value = String(text ?? '');
  if (token && token.length > 3) value = value.split(token).join('[token]');
  return value.replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer [token]');
}

/** Turns an API failure into a calm, specific error. `headers` is a Headers-like object (for the rate-limit reset). */
export function classifyError(status, body, { token = '', headers = null, now = Date.now() } = {}) {
  const first = Array.isArray(body?.errors) ? body.errors[0] || {} : {};
  const code = String(first.error || first.extensions?.code || '').toLowerCase();
  const said = redact(first.error_description || first.message || '', token).trim();
  if (status === 401 || /invalid_oauth_token|unauthori[sz]ed|invalid_token/.test(code)) {
    return new ProductHuntError('Product Hunt did not accept your token. Paste a new developer token to see rankings again.', { kind: 'auth', status });
  }
  if (status === 429 || /rate_limit/.test(code)) {
    const reset = Number(headers?.get?.('x-rate-limit-reset'));
    const retryAt = Number.isFinite(reset) && reset > 0 ? now + Math.min(reset, 3600) * 1000 : 0;
    return new ProductHuntError('Product Hunt is limiting requests right now. Still will try again in a few minutes.', { kind: 'rate', status, retryAt });
  }
  if (status >= 500) return new ProductHuntError('Product Hunt is not responding right now. Try again in a moment.', { kind: 'server', status });
  if (status === 403) return new ProductHuntError('Product Hunt refused the request. Try again later.', { kind: 'server', status });
  return new ProductHuntError(said ? `Product Hunt returned an error: ${said}` : `Product Hunt returned an error (HTTP ${status}).`, { kind: 'graphql', status });
}

// ------------------------------------------------------------------------------------------------ XML

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', times: '×', laquo: '«', raquo: '»',
};

/** Decodes XML/HTML character references (named, decimal and hex). Unknown names are left as written. */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]*);/g, (match, code) => {
    if (code[0] !== '#') return ENTITIES[code] ?? ENTITIES[code.toLowerCase()] ?? match;
    const n = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  });
}

function parseAttrs(source) {
  const attrs = {};
  for (const match of String(source).matchAll(/([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const name = match[1];
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

const MAX_XML = 4 * 1024 * 1024;

/**
 * Minimal, forgiving XML parser for feeds. Returns a tree of { name, attrs, children } where text children are decoded
 * strings (CDATA kept verbatim). Comments, processing instructions and doctypes are skipped; a stray close tag pops back
 * to its open element, so slightly broken feeds still parse.
 */
export function parseXml(source) {
  const text = String(source ?? '').slice(0, MAX_XML);
  const root = { name: '#document', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const pushText = value => { if (value) top().children.push(decodeEntities(value)); };
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) { pushText(text.slice(i)); break; }
    if (lt > i) pushText(text.slice(i, lt));
    const skipTo = (marker, from) => { const end = text.indexOf(marker, from); return end === -1 ? text.length : end + marker.length; };
    if (text.startsWith('<!--', lt)) { i = skipTo('-->', lt + 4); continue; }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      top().children.push(text.slice(lt + 9, end === -1 ? text.length : end));
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) { i = skipTo('?>', lt + 2); continue; }
    if (text.startsWith('<!', lt)) {
      let depth = 0;
      let j = lt + 2;
      for (; j < text.length; j++) {
        const c = text[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt + 2);
      const name = text.slice(lt + 2, end === -1 ? text.length : end).trim();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    let j = lt + 1;
    let quote = '';
    for (; j < text.length; j++) {
      const c = text[j];
      if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    let inner = text.slice(lt + 1, j);
    const match = /^[A-Za-z_][\w:.-]*/.exec(inner);
    if (!match) { pushText('<'); i = lt + 1; continue; }   // a lone "<" in text
    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);
    const node = { name: match[0], attrs: parseAttrs(inner.slice(match[0].length)), children: [] };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
    i = j + 1;
  }
  return root;
}

const localName = name => String(name).slice(String(name).indexOf(':') + 1);
const elements = node => (node?.children || []).filter(child => typeof child === 'object');
export const childrenNamed = (node, name) => elements(node).filter(child => localName(child.name) === name);
export const childNamed = (node, name) => elements(node).find(child => localName(child.name) === name) || null;
/** All text inside a node, in document order. */
export const textOf = node => (!node ? '' : node.children.map(child => (typeof child === 'string' ? child : textOf(child))).join(''));
/** Depth-first search for the first element with a local name. */
export function findElement(node, name) {
  for (const child of elements(node)) {
    if (localName(child.name) === name) return child;
    const found = findElement(child, name);
    if (found) return found;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ HTML snippets

/** Plain text from an HTML snippet: tags dropped, entities decoded, whitespace collapsed. */
export function htmlToText(source) {
  return decodeEntities(String(source ?? '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, ' ')
    .replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Anchors in an HTML snippet: [{ href, text }]. */
export function htmlLinks(source) {
  return [...String(source ?? '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)].map(match => ({ href: parseAttrs(match[1]).href || '', text: htmlToText(match[2]) }));
}

/** First image source in an HTML snippet, or ''. */
export function firstImage(source) {
  for (const match of String(source ?? '').matchAll(/<img\b([^>]*)>/gi)) {
    const src = cleanUrl(parseAttrs(match[1]).src);
    if (src) return src;
  }
  return '';
}

/** First paragraph that is not just links ("Discussion | Link"), as plain text. */
export function taglineFrom(source) {
  const htmlText = String(source ?? '');
  const blocks = [...htmlText.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)].map(match => match[1]);
  for (const block of blocks.length ? blocks : [htmlText]) {
    const withoutLinks = htmlToText(block.replace(/<a\b[\s\S]*?<\/a\s*>/gi, ' '));
    if (!withoutLinks.replace(/[|·•\-–—,:\s]/g, '')) continue;
    return htmlToText(block).slice(0, 300);
  }
  return '';
}

/** An http(s) URL without tracking parameters, or '' for anything else. */
export function cleanUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return ''; }
}

/**
 * Product Hunt's image CDN (imgix) resizes on request: a square crop sized for the slot, at 2x. Animated GIF thumbnails
 * are asked for as their first frame, so a dashboard full of launches stays still.
 */
export function thumbnailUrl(value, size = 48) {
  const url = cleanUrl(value);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (!/(^|\.)imgix\.net$/.test(parsed.hostname)) return url;
    const px = String(Math.max(16, Math.min(512, Math.round(size * 2))));
    parsed.searchParams.set('auto', 'format');
    parsed.searchParams.set('fit', 'crop');
    parsed.searchParams.set('w', px);
    parsed.searchParams.set('h', px);
    if (/\.gif$/i.test(parsed.pathname)) parsed.searchParams.set('frame', '1');
    return parsed.href;
  } catch { return url; }
}

// ------------------------------------------------------------------------------------------------ feed

const postIdOf = value => /Post\/(\d+)/.exec(String(value || ''))?.[1] || /\/r\/p\/(\d+)/.exec(String(value || ''))?.[1] || '';
const isoOrEmpty = value => { const time = Date.parse(String(value || '').trim()); return Number.isFinite(time) ? new Date(time).toISOString() : ''; };

function atomLink(entry) {
  const links = childrenNamed(entry, 'link');
  const alternate = links.find(link => (link.attrs.rel || 'alternate') === 'alternate' && link.attrs.href) || links.find(link => link.attrs.href);
  return cleanUrl(alternate?.attrs.href || '');
}

function mediaImage(entry) {
  // media:thumbnail always is an image; media:content only when its type or medium says so.
  const images = [...childrenNamed(entry, 'thumbnail'), ...childrenNamed(entry, 'content').filter(node => /^image\//.test(node.attrs.type || '') || node.attrs.medium === 'image')];
  for (const node of images) {
    const url = cleanUrl(node.attrs.url);
    if (url) return url;
  }
  const enclosure = childrenNamed(entry, 'enclosure').find(node => /^image\//.test(node.attrs.type || ''));
  return cleanUrl(enclosure?.attrs.url || '');
}

/** One feed post in the widget's shape. `body` is the entry's HTML content. */
function feedPost({ id, name, url, body, published, updated, author, image }, index) {
  const links = htmlLinks(body);
  const website = cleanUrl(links.find(link => /^(link|website|visit)$/i.test(link.text) || /\/r\/p\//.test(link.href))?.href || '');
  const discussion = cleanUrl(links.find(link => /^discussion$/i.test(link.text))?.href || '');
  const postId = postIdOf(id) || postIdOf(website) || String(id || url || name);
  return {
    id: postId, name: htmlToText(name).slice(0, 200) || 'Untitled', tagline: taglineFrom(body), url: url || discussion || PH_SITE,
    website, thumbnail: image || firstImage(body), votes: null, comments: null, createdAt: isoOrEmpty(published) || isoOrEmpty(updated),
    featuredAt: '', updatedAt: isoOrEmpty(updated), topics: [], makers: author ? [{ name: htmlToText(author), username: '', avatar: '' }] : [],
    rank: index + 1, source: 'feed',
  };
}

/**
 * Parses Product Hunt's public feed (Atom; RSS 2.0 also works) into { title, updated, posts }. Throws a
 * ProductHuntError (kind 'parse') when the document is not a feed.
 */
export function parseFeed(source) {
  const doc = parseXml(source);
  const atom = findElement(doc, 'feed');
  let raw = [];
  let title = '';
  let updated = '';
  if (atom) {
    title = htmlToText(textOf(childNamed(atom, 'title')));
    updated = isoOrEmpty(textOf(childNamed(atom, 'updated')));
    raw = childrenNamed(atom, 'entry').map(entry => ({
      id: textOf(childNamed(entry, 'id')).trim(), name: textOf(childNamed(entry, 'title')), url: atomLink(entry),
      body: textOf(childNamed(entry, 'content')) || textOf(childNamed(entry, 'summary')),
      published: textOf(childNamed(entry, 'published')), updated: textOf(childNamed(entry, 'updated')),
      author: textOf(childNamed(childNamed(entry, 'author'), 'name')).trim(), image: mediaImage(entry),
    }));
  } else {
    const channel = findElement(doc, 'channel');
    if (!channel) throw new ProductHuntError('Product Hunt sent something that is not a feed. Try again later.', { kind: 'parse' });
    title = htmlToText(textOf(childNamed(channel, 'title')));
    updated = isoOrEmpty(textOf(childNamed(channel, 'lastBuildDate')));
    raw = childrenNamed(channel, 'item').map(item => ({
      id: textOf(childNamed(item, 'guid')).trim() || textOf(childNamed(item, 'link')).trim(), name: textOf(childNamed(item, 'title')),
      url: cleanUrl(textOf(childNamed(item, 'link'))), body: textOf(childNamed(item, 'encoded')) || textOf(childNamed(item, 'description')),
      published: textOf(childNamed(item, 'pubDate')), updated: '', author: textOf(childNamed(item, 'creator')).trim() || textOf(childNamed(item, 'author')).trim(),
      image: mediaImage(item),
    }));
  }
  const seen = new Set();
  const posts = [];
  for (const entry of raw) {
    if (!entry.name.trim() && !entry.url) continue;
    const post = feedPost(entry, posts.length);
    if (seen.has(post.id)) continue;
    seen.add(post.id);
    posts.push(post);
  }
  return { kind: 'feed', title, updated, posts };
}

// ------------------------------------------------------------------------------------------------ dates

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const formatters = new Map();
/** Wall-clock parts of an instant in a time zone. */
export function zoneParts(ms, timeZone = PH_TIME_ZONE) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  }
  const parts = Object.fromEntries(formatters.get(timeZone).formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour % 24, minute: +parts.minute, second: +parts.second, weekday: WEEKDAYS.indexOf(parts.weekday) };
}
const offsetAt = (ms, timeZone) => {
  const p = zoneParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
};
/** The instant of local midnight on a calendar date in a time zone (day and month may overflow, like Date.UTC). */
export function zonedMidnight(year, month, day, timeZone = PH_TIME_ZONE) {
  const wall = Date.UTC(year, month - 1, day);
  const first = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(first, timeZone);   // the offset can change between the guess and the answer (DST)
}
const dateKey = (ms, timeZone) => { const p = zoneParts(ms, timeZone); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; };

/** ISO 8601 week number and its year for a calendar date. */
export function isoWeek(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday + 3);   // the Thursday of this week decides its year
  const weekYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return { year: weekYear, week };
}

/**
 * The launch window for a range on Product Hunt's calendar: { range, after, before, key } with ISO instants
 * (after inclusive, before exclusive) and `key`, the window's first day (YYYY-MM-DD) for cache keys. Weeks start on Monday.
 */
export function dateWindow(range = 'today', { now = Date.now(), timeZone = PH_TIME_ZONE } = {}) {
  const id = rangeOf(range).id;
  const { year, month, day, weekday } = zoneParts(now, timeZone);
  let start;
  let end;
  if (id === 'yesterday') { start = zonedMidnight(year, month, day - 1, timeZone); end = zonedMidnight(year, month, day, timeZone); }
  else if (id === 'week') { start = zonedMidnight(year, month, day - weekday, timeZone); end = zonedMidnight(year, month, day - weekday + 7, timeZone); }
  else if (id === 'month') { start = zonedMidnight(year, month, 1, timeZone); end = zonedMidnight(year, month + 1, 1, timeZone); }
  else { start = zonedMidnight(year, month, day, timeZone); end = zonedMidnight(year, month, day + 1, timeZone); }
  return { range: id, after: new Date(start).toISOString(), before: new Date(end).toISOString(), key: dateKey(start, timeZone) };
}

/** Product Hunt's leaderboard page for a range ('latest' and unknown ranges go to the home page). */
export function leaderboardUrl(range = 'today', { now = Date.now(), timeZone = PH_TIME_ZONE } = {}) {
  if (!RANGES.some(r => r.id === range)) return `${PH_SITE}/`;
  const start = Date.parse(dateWindow(range, { now, timeZone }).after);
  const p = zoneParts(start, timeZone);
  if (range === 'week') { const { year, week } = isoWeek(p.year, p.month, p.day); return `${PH_SITE}/leaderboard/weekly/${year}/${week}`; }
  if (range === 'month') return `${PH_SITE}/leaderboard/monthly/${p.year}/${p.month}`;
  return `${PH_SITE}/leaderboard/daily/${p.year}/${p.month}/${p.day}`;
}

// ------------------------------------------------------------------------------------------------ API

export const POSTS_QUERY = `query StillProductHuntPosts($first: Int!, $order: PostsOrder, $postedAfter: DateTime, $postedBefore: DateTime, $topic: String, $featured: Boolean) {
  posts(first: $first, order: $order, postedAfter: $postedAfter, postedBefore: $postedBefore, topic: $topic, featured: $featured) {
    edges { node {
      id name tagline slug url website votesCount commentsCount createdAt featuredAt
      thumbnail { type url }
      topics(first: 3) { edges { node { name slug } } }
      makers { name username profileImage }
    } }
  }
}`;

export const VIEWER_QUERY = `query StillProductHuntViewer {
  viewer { user { id name username profileImage } }
  posts(first: 1) { edges { node { id } } }
}`;

/**
 * GraphQL request for a launch list: { query, variables, window }. Topic and featured are only sent when set, so the
 * API's own defaults apply otherwise.
 */
export function buildPostsQuery({ range = 'today', sort = 'ranking', topic = '', featured = true, first = 20, now = Date.now(), timeZone = PH_TIME_ZONE } = {}) {
  const window = dateWindow(range, { now, timeZone });
  const variables = {
    first: Math.max(1, Math.min(50, Math.round(Number(first)) || 20)),
    order: sortOf(sort).order,
    postedAfter: window.after,
    postedBefore: window.before,
  };
  const slug = topicSlug(topic);
  if (slug) variables.topic = slug;
  if (featured) variables.featured = true;
  return { query: POSTS_QUERY, variables, window };
}

const REDACTED = /^\[?redacted\]?$/i;
const int = value => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Math.max(0, Math.round(Number(value))) : null);

/** One API post in the widget's shape (the same shape as feed posts, with votes, comments, topics and makers). */
export function normalizePost(node = {}, index = 0) {
  const slug = String(node.slug || '');
  const topics = (node.topics?.edges || node.topics?.nodes || []).map(edge => edge?.node || edge).filter(t => t?.name)
    .map(t => ({ name: String(t.name), slug: topicSlug(t.slug || t.name) })).slice(0, 3);
  const makers = (Array.isArray(node.makers) ? node.makers : []).filter(m => m?.name && !REDACTED.test(m.name) && !REDACTED.test(m.username || ''))
    .map(m => ({ name: String(m.name), username: String(m.username || ''), avatar: cleanUrl(m.profileImage) })).slice(0, 4);
  return {
    id: String(node.id ?? slug ?? index), name: String(node.name || 'Untitled').slice(0, 200), tagline: String(node.tagline || '').slice(0, 300),
    url: cleanUrl(node.url) || (slug ? `${PH_SITE}/posts/${encodeURIComponent(slug)}` : PH_SITE), website: cleanUrl(node.website),
    thumbnail: cleanUrl(node.thumbnail?.url), votes: int(node.votesCount), comments: int(node.commentsCount),
    createdAt: isoOrEmpty(node.createdAt), featuredAt: isoOrEmpty(node.featuredAt), updatedAt: '', topics, makers, rank: index + 1, source: 'api',
  };
}

export function normalizePosts(data) {
  const edges = data?.posts?.edges || [];
  return edges.map(edge => edge?.node).filter(Boolean).map((node, index) => normalizePost(node, index));
}

export function normalizeViewer(data) {
  const user = data?.viewer?.user;
  if (!user || REDACTED.test(user.name || '')) return { id: '', name: '', username: '', avatarUrl: '' };
  return { id: String(user.id || ''), name: String(user.name || ''), username: String(user.username || ''), avatarUrl: cleanUrl(user.profileImage) };
}

async function timed(fetcher, url, init, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new ProductHuntError(`${label} took too long to answer. Try again.`, { kind: 'timeout' });
    throw new ProductHuntError(`Unable to reach ${label}. Check your connection and try again.`, { kind: 'network' });
  } finally { clearTimeout(timer); }
}

/** Fetches and parses the public feed. Needs host access to www.producthunt.com in the extension (no CORS headers). */
export async function fetchFeed({ fetch: fetcher = globalThis.fetch?.bind(globalThis), url = FEED_URL, timeoutMs = 15000 } = {}) {
  if (typeof fetcher !== 'function') throw new ProductHuntError('This browser cannot reach Product Hunt.', { kind: 'network' });
  const response = await timed(fetcher, url, { method: 'GET', cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.5' } }, timeoutMs, 'Product Hunt');
  if (!response.ok) {
    if (response.status === 429) throw new ProductHuntError('Product Hunt is limiting requests right now. Still will try again in a few minutes.', { kind: 'rate', status: 429 });
    throw new ProductHuntError(response.status >= 500 ? 'Product Hunt is not responding right now. Try again in a moment.'
      : `Product Hunt did not send its feed (HTTP ${response.status}). Try again later.`, { kind: 'server', status: response.status });
  }
  return parseFeed(await response.text());
}

/** API v2 client for a developer token: { request, viewer(), posts(options) }. */
export function createProductHuntClient({ token, fetch: fetcher = globalThis.fetch?.bind(globalThis), endpoint = API_URL, timeoutMs = 15000 } = {}) {
  if (!token) throw new ProductHuntError('Add a Product Hunt developer token first.', { kind: 'auth' });
  if (typeof fetcher !== 'function') throw new ProductHuntError('This browser cannot reach Product Hunt.', { kind: 'network' });

  async function request(query, variables = {}) {
    const response = await timed(fetcher, endpoint, {
      method: 'POST', cache: 'no-store', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    }, timeoutMs, 'Product Hunt');
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok || (Array.isArray(body?.errors) && body.errors.length && !body?.data)) throw classifyError(response.status, body, { token, headers: response.headers });
    if (!body || typeof body !== 'object' || !body.data) throw new ProductHuntError(`Product Hunt sent a response Still could not read (HTTP ${response.status}).`, { kind: 'graphql', status: response.status });
    return body.data;
  }

  return {
    request,
    async viewer() { return normalizeViewer(await request(VIEWER_QUERY)); },
    async posts(options = {}) {
      const { query, variables, window } = buildPostsQuery(options);
      return { kind: 'posts', window, posts: normalizePosts(await request(query, variables)) };
    },
  };
}

// ------------------------------------------------------------------------------------------------ lists

const launchedAt = post => Date.parse(post.featuredAt || post.createdAt || '') || 0;

/** Sorted copy. Ranking keeps the source's order; the feed has no votes or comments, so those fall back to it. */
export function sortPosts(posts = [], sort = 'ranking') {
  const list = [...posts];
  const byRank = (a, b) => (a.rank || 0) - (b.rank || 0);
  if (sort === 'newest') return list.sort((a, b) => launchedAt(b) - launchedAt(a) || byRank(a, b));
  if (sort === 'votes') return list.sort((a, b) => (b.votes ?? -1) - (a.votes ?? -1) || byRank(a, b));
  if (sort === 'comments') return list.sort((a, b) => (b.comments ?? -1) - (a.comments ?? -1) || byRank(a, b));
  return list.sort(byRank);
}

/** What a widget shows: sorted, without hidden products, at most `limit`. Positions are renumbered 1…n. */
export function visiblePosts(posts = [], { sort = 'ranking', hidden = [], limit = DEFAULT_CONFIG.limit } = {}) {
  const skip = new Set(hidden);
  return sortPosts(posts.filter(post => !skip.has(post.id)), sort).slice(0, limit).map((post, index) => ({ ...post, position: index + 1 }));
}

/** Where the widget's data comes from: 'api' with a token (unless the feed is chosen), else 'feed'. */
export const modeFor = (config, { connected = false } = {}) => (connected && normalizeConfig(config).source !== 'feed' ? 'api' : 'feed');

/** Cache key for a widget's list. API keys carry the window's first day, so yesterday's "Today" is never shown as today's. */
export function feedKey(config, { mode = 'feed', now = Date.now() } = {}) {
  if (mode !== 'api') return 'producthunt:feed';
  const c = normalizeConfig(config);
  const window = dateWindow(c.range, { now });
  return ['producthunt', 'posts', c.range, window.key, sortOf(c.sort).order.toLowerCase(), c.topic || 'all', c.featured ? 'featured' : 'all'].join(':');
}

/**
 * Layout for a widget size: 'top' (the top three with big ranks) on small, short or very narrow widgets, 'cards' on
 * extra large ones wide enough for a few columns, else 'list' (tall narrow widgets get a list, not three lonely rows).
 * A chosen layout wins where it fits (lists need 3 columns and 3 rows, cards 4 columns).
 */
export function layoutFor(env = {}, config = {}) {
  const { w = 4, h = 5, size = 'm' } = env;
  const chosen = normalizeConfig(config).layout;
  const fitsList = w >= 3 && h >= 3;
  if (chosen === 'top') return 'top';
  if (chosen === 'cards') return fitsList ? (w >= 4 ? 'cards' : 'list') : 'top';
  if (chosen === 'list') return fitsList ? 'list' : 'top';
  if (w <= 2 || h <= 3) return 'top';
  return size === 'xl' && w >= 7 ? 'cards' : 'list';
}

/**
 * The product's own site for a favicon when it has no image, or ''. Product Hunt usually sends its redirect link
 * (www.producthunt.com/r/…) as the website, and that would show Product Hunt's icon on every row, so those are skipped.
 */
export function siteIconUrl(post) {
  const url = cleanUrl(post?.website);
  if (!url) return '';
  try { return /(^|\.)producthunt\.com$/i.test(new URL(url).hostname) ? '' : url; } catch { return ''; }
}

/** The link a row opens: the product page on Product Hunt, or the product's own site when chosen and known. */
export const openUrl = (post, open = 'product') => (open === 'website' && post?.website ? post.website : post?.url || PH_SITE);
