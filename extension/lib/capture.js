import { safeUrl, canonicalUrl } from './store.js';

export const PAGE_TEXT_LIMIT = 120000;
export const ARTICLE_LIMIT = 250000;
// Classic scripts injected on demand with executeScript({ files }), in this order (paths relative to extension/).
// Readability must load first: content/article-extract.js uses it, and content/picker.js uses the extractor.
export const ARTICLE_SCRIPT_FILES = ['lib/vendor/readability.js', 'content/article-extract.js'];
export const PICKER_SCRIPT_FILES = [...ARTICLE_SCRIPT_FILES, 'content/picker.js'];
// storage.session key for picker results whose side panel was closed meanwhile: { [draftId]: { draftId, windowId, tabId,
// createdAt, article } }. Written by the worker, read (and removed) by that window's side panel when it starts.
export const PANEL_DRAFTS_KEY = 'still.capture.drafts.v1';
export const MENU_COLLECTION_LIMIT = 10;
export const MENU_TITLE_LIMIT = 40;
export const INBOX_MENU_ID = '__inbox';
export const CHOOSE_MENU_ID = '__choose';
export const SEPARATOR_MENU_ID = '__separator';
const SAVE_TO_PREFIX = 'still-save-to:';
const SAVE_TO_KINDS = ['page', 'link', 'image'];

const str = value => typeof value === 'string' ? value : '';
const clean = (value, max = 300) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const sameUrl = (a, b) => { try { return canonicalUrl(a) === canonicalUrl(b); } catch { return false; } };

// Runs only after an explicit capture gesture on the active tab.
export function readPageMetadata() {
  const meta = selector => document.querySelector(selector)?.getAttribute('content') || '';
  const selection = window.getSelection()?.toString().trim() || '';
  const article = document.querySelector('article, main, [role="main"]');
  return {
    title: document.title,
    url: location.href,
    excerpt: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    cover: meta('meta[property="og:image"]'),
    selection,
    articleText: article?.innerText?.trim().slice(0, 250000) || '',
    contentType: meta('meta[property="og:type"]'),
  };
}

// Injected by the service worker for "chat with this page". It runs in the page, so it must not
// reference anything outside its own body. Layout-aware innerText is used for every subtree that
// contains no navigation chrome (it keeps code indentation); only the path down to nav/footer/aside
// nodes is walked by hand, collapsing source whitespace the way the page renders it.
export function readPageContext(limit = 120000) {
  const meta = selector => document.querySelector(selector)?.getAttribute('content') || '';
  const skip = 'nav, footer, aside, script, style, noscript, template, [role="navigation"], [role="contentinfo"], [role="complementary"]';
  const extract = root => {
    const parts = [];
    let size = 0;
    const push = value => { if (value) { parts.push(value); size += value.length; } };
    const lineStart = () => !parts.length || parts[parts.length - 1].endsWith('\n');
    const newline = () => {
      if (parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace(/[ \t]+$/, '');
      push('\n');
    };
    const visit = element => {
      for (const node of element.childNodes) {
        if (size > limit) return;
        if (node.nodeType === 3) {
          const value = node.nodeValue.replace(/[ \t\n\r\f]+/g, ' ');
          push(lineStart() ? value.replace(/^ +/, '') : value);
          continue;
        }
        if (node.nodeType !== 1 || node.matches(skip)) continue;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const block = !style.display.startsWith('inline');
        if (block) newline();
        if (node.localName === 'br') newline();
        else if (node.querySelector(skip)) visit(node);
        else push(node.innerText || '');
        if (block) newline();
      }
    };
    if (root) visit(root);
    const text = parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, '');
    return { text, truncated: size > limit || text.length > limit };
  };
  const articles = document.querySelectorAll('article');
  const root = (articles.length === 1 ? articles[0] : null) || document.querySelector('main, [role="main"]') || document.body;
  let content = extract(root);
  // A lone teaser <article> or an empty <main> is not the page: read the whole body instead.
  if (root !== document.body && !content.truncated && content.text.length < 200) content = extract(document.body);
  return {
    url: location.href,
    title: document.title,
    excerpt: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    cover: meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]'),
    selection: (window.getSelection()?.toString().trim() || '').slice(0, 20000),
    text: content.text.slice(0, limit),
    truncated: content.truncated,
    lang: document.documentElement?.lang || meta('meta[property="og:locale"]') || '',
  };
}

// Injected with func: right after ARTICLE_SCRIPT_FILES, pinned to the same document. Self-contained (Chrome sends only
// this function's source); never throws, so a broken page reports a readable failure instead of an injection error.
export function runArticleExtract(options) {
  try {
    const reader = globalThis.__stillArticle;
    if (!reader || typeof reader.extract !== 'function') return { ok: false, code: 'error', error: 'Still could not load its article reader on this page.' };
    return reader.extract(options);
  } catch {
    return { ok: false, code: 'error', error: 'Still could not read this page.' };
  }
}

// Injected with func: after PICKER_SCRIPT_FILES. Self-contained; reports a failure instead of throwing.
export function startPagePicker(options) {
  try {
    const picker = globalThis.__stillPicker;
    if (!picker || typeof picker.start !== 'function') return { started: false, error: 'Still could not load the page picker here.' };
    const reply = picker.start(options);
    return { started: reply?.started === true, requestId: typeof reply?.requestId === 'string' ? reply.requestId : '' };
  } catch (error) {
    return { started: false, error: String(error?.message || 'The page picker could not start on this page.').slice(0, 300) };
  }
}

/* ------------------------------------------------------------------ article results (untrusted page data) */

const ARTICLE_SOURCES = new Set(['readability', 'fallback', 'selection', 'site:x', 'site:github', 'site:youtube']);
const ARTICLE_ERRORS = {
  empty: 'Still found no article text on this page.',
  unreadable: 'Still could not read an article on this page.',
  error: 'Still could not read this page.',
};
const webUrl = value => { try { return typeof value === 'string' && value ? safeUrl(value.trim()) : ''; } catch { return ''; } };
const count = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0);
// The store validates icons again (data:image size and type); this only keeps obviously wrong values out of replies.
const articleIcon = value => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^data:image\//i.test(text)) return text.length <= 16 * 1024 ? text : '';
  return text.length <= 8192 ? webUrl(text) : '';
};

/**
 * Cleans an ArticleResult that came from a web page (content/article-extract.js through executeScript, or the picker's
 * runtime message): unknown fields dropped, strings capped, URLs http(s) only, Markdown <= 250,000 characters. pageUrl
 * (the tab or sender URL Chrome reported) becomes `url` when given.
 * Returns { ok: true, source, url, canonicalUrl, title, siteName, author, publishedAt, lang, dir, excerpt, icon, cover,
 * markdown, wordCount, readingMinutes, images, truncated, selectionCount? } or { ok: false, code, error }.
 * The plain `text` copy is not kept: the word count travels with the result.
 */
export function normalizeArticleResult(raw, { pageUrl = '' } = {}) {
  if (!raw || typeof raw !== 'object' || raw.ok !== true) {
    const code = Object.hasOwn(ARTICLE_ERRORS, raw?.code) ? raw.code : 'error';
    return { ok: false, code, error: clean(raw?.error, 300) || ARTICLE_ERRORS[code] };
  }
  const source = str(raw.markdown).replace(/\u0000/g, '');
  const markdown = source.slice(0, ARTICLE_LIMIT);
  if (!markdown.trim()) return { ok: false, code: 'empty', error: ARTICLE_ERRORS.empty };
  // The tab or sender URL comes from Chrome; the page's own report is only used when Chrome gave none.
  const url = webUrl(pageUrl) || webUrl(raw.url);
  const words = count(raw.wordCount) || markdown.split(/\s+/).filter(Boolean).length;
  const result = {
    ok: true, source: ARTICLE_SOURCES.has(raw.source) ? raw.source : 'fallback', url, canonicalUrl: webUrl(raw.canonicalUrl) || url,
    title: clean(raw.title, 2000), siteName: clean(raw.siteName, 200), author: clean(raw.author, 300), publishedAt: clean(raw.publishedAt, 64),
    lang: clean(raw.lang, 35), dir: raw.dir === 'rtl' || raw.dir === 'ltr' ? raw.dir : '', excerpt: clean(raw.excerpt, 300),
    icon: articleIcon(raw.icon), cover: webUrl(raw.cover), markdown, wordCount: words,
    readingMinutes: count(raw.readingMinutes) || (words ? Math.max(1, Math.round(words / 230)) : 0),
    images: (Array.isArray(raw.images) ? raw.images : []).map(webUrl).filter(Boolean).slice(0, 50),
    truncated: raw.truncated === true || markdown.length < source.length,
  };
  if (raw.selectionCount !== undefined) result.selectionCount = count(raw.selectionCount);
  return result;
}

// Public suffixes where every subdomain belongs to a different owner (a small, offline subset of the Public Suffix
// List's private section). Without it two blogs on one host service would count as one site.
const SHARED_HOSTS = ['github.io', 'gitlab.io', 'bitbucket.io', 'codeberg.page', 'blogspot.com', 'wordpress.com', 'tumblr.com', 'substack.com',
  'livejournal.com', 'typepad.com', 'weebly.com', 'wixsite.com', 'squarespace.com', 'myshopify.com', 'ghost.io', 'hashnode.dev', 'webflow.io',
  'framer.app', 'framer.website', 'carrd.co', 'notion.site', 'gitbook.io', 'readthedocs.io', 'netlify.app', 'vercel.app', 'now.sh', 'pages.dev',
  'workers.dev', 'r2.dev', 'deno.dev', 'fly.dev', 'onrender.com', 'herokuapp.com', 'appspot.com', 'web.app', 'firebaseapp.com', 'glitch.me',
  'neocities.org', 'surge.sh', 'replit.app', 'repl.co', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 'githubusercontent.com',
  'sourceforge.io', 'translate.goog'];
// Country domains that register names one level down (example.co.uk, example.com.au).
const SECOND_LEVEL = new Set(['ac', 'asn', 'biz', 'co', 'com', 'edu', 'firm', 'gen', 'go', 'gob', 'gouv', 'gov', 'govt', 'id', 'in', 'ind', 'info',
  'ltd', 'me', 'mil', 'ne', 'net', 'nhs', 'nic', 'nom', 'or', 'org', 'plc', 'police', 'sch']);
const isIpHost = host => /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[');

/** The registrable part of a host name ("blog.example.co.uk" -> "example.co.uk"). IP addresses are returned unchanged. */
export function registrableDomain(host) {
  const name = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!name || isIpHost(name)) return name;
  const labels = name.split('.');
  if (labels.length < 2) return name;
  const shared = SHARED_HOSTS.find(suffix => name === suffix || name.endsWith(`.${suffix}`));
  if (shared) return labels.slice(-(shared.split('.').length + 1)).join('.');
  if (labels.length >= 3 && labels.at(-1).length === 2 && SECOND_LEVEL.has(labels.at(-2))) return labels.slice(-3).join('.');
  return labels.slice(-2).join('.');
}

/** True when two web addresses are on the same host or share a registrable domain (www.example.com, m.example.com). */
export function sameSite(a, b) {
  let first, second;
  try { first = new URL(a).hostname.toLowerCase(); second = new URL(b).hostname.toLowerCase(); } catch { return false; }
  if (!first || !second) return false;
  if (first === second) return true;
  if (isIpHost(first) || isIpHost(second)) return false;
  const domain = registrableDomain(first);
  return domain.includes('.') && domain === registrableDomain(second);
}

/**
 * The address an article is saved under: its canonical URL only when that stays on the page's own site (same host or
 * registrable domain) and does not downgrade https to http. A page cannot point the saved item, and the re-capture
 * merge, at another site's address. pageUrl is the tab's URL; without one, the URL the page reported is used.
 */
export function articleSaveUrl(article, pageUrl = '') {
  const page = webUrl(pageUrl) || webUrl(article?.url);
  const canonical = webUrl(article?.canonicalUrl);
  if (!page || !canonical || canonical === page) return page;
  if (new URL(page).protocol === 'https:' && new URL(canonical).protocol !== 'https:') return page;
  return sameSite(canonical, page) ? canonical : page;
}

/**
 * Item input for saving an ArticleResult (ok: true). options: { url (articleSaveUrl), pageUrl (tab URL), existing (the
 * item already saved at that address), collectionId, tags, note, title, fallbackTitle }. A new item gets everything; an
 * existing item only gets fresh article text and metadata it is missing. Its note, title, tags and collection stay as
 * the user left them, and the type is only ever upgraded (a bookmark becomes an article).
 */
export function buildArticleCapture(article, options = {}) {
  options ||= {};
  const url = webUrl(options.url) || articleSaveUrl(article, options.pageUrl);
  if (!url) throw new Error('Still could not tell which page this article came from.');
  const existing = options.existing && typeof options.existing === 'object' ? options.existing : null;
  const fill = (key, value) => (existing && str(existing[key]).trim() ? '' : value || '');
  const captured = isVideoUrl(url) ? 'video' : 'article';
  const type = existing && ['image', 'video', 'file'].includes(existing.type) ? existing.type : captured;
  const derived = clean(article.title, 2000) || clean(options.fallbackTitle, 2000) || new URL(url).hostname;
  const title = existing ? (isPlaceholderTitle(existing.title, existing.url || url) ? derived : existing.title) : clean(options.title, 2000) || derived;
  const note = typeof options.note === 'string' ? options.note.trim() : '';
  const input = {
    type, title, url: existing?.url || url, articleContent: str(article.markdown).slice(0, ARTICLE_LIMIT),
    excerpt: fill('excerpt', article.excerpt), cover: fill('cover', article.cover), icon: fill('icon', article.icon),
    siteName: fill('siteName', article.siteName), author: fill('author', article.author), publishedAt: fill('publishedAt', article.publishedAt),
    lang: fill('lang', article.lang), content: existing ? '' : note,
    tags: existing ? [] : normalizeTags(options.tags), collectionId: existing ? '' : typeof options.collectionId === 'string' ? options.collectionId : '',
    sourceUrl: webUrl(options.pageUrl) || webUrl(article.url),
  };
  return input;
}

/** "Saved 3 selections from example.com" for the picker's notification. */
export function savedSelectionMessage(article, url = '') {
  const parts = count(article?.selectionCount) || 1;
  let site = clean(article?.siteName, 80);
  if (!site) { try { site = new URL(url || article?.url).hostname.replace(/^www\./, ''); } catch { site = ''; } }
  return `Saved ${parts} ${parts === 1 ? 'selection' : 'selections'} from ${site || 'this page'}`;
}

export function isVideoUrl(url) {
  try { return /youtu\.be|youtube\.com|vimeo\.com/i.test(new URL(url).hostname); } catch { return false; }
}

// A title that only restates the address (or the store's fallback) can be replaced by a better one.
export function isPlaceholderTitle(title, url) {
  const value = clean(title, 2000);
  if (!value || value === 'Untitled item' || /^https?:\/\/\S+$/i.test(value)) return true;
  try { return value === new URL(url).hostname || sameUrl(value, url); } catch { return false; }
}

export function normalizeTags(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(raw.filter(tag => typeof tag === 'string').map(tag => tag.trim().replace(/^#+/, '').trim()).filter(Boolean))];
}

export function normalizeRecentCollections(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.recentCollections) ? value.recentCollections : [];
  return [...new Set(list.filter(id => typeof id === 'string' && id))];
}

// Saved-item lookups follow the store's saveItem dedupe (live or archived, never notes, canonical URL), plus one rule:
// an article saved under its <link rel="canonical"> address keeps the tab's own address in sourceUrl, and that tab
// counts as saved too. Only articles: a link, image or video keeps the page it was found on in sourceUrl, and that
// page is not the item. A direct address match always wins over a sourceUrl match.
const urlKey = value => { try { return value ? canonicalUrl(value) : ''; } catch { return ''; } };
const savable = item => !!item && !item.deletedAt && item.type !== 'note' && !!item.url;
const sourceKey = item => (item?.type === 'article' && item.sourceUrl ? urlKey(item.sourceUrl) : '');

export function indexSavedUrls(library) {
  const index = new Map();
  const items = (library?.items || []).filter(savable);
  // Legacy records with unreadable URLs cannot match.
  for (const item of items) { const key = urlKey(item.url); if (key && !index.has(key)) index.set(key, item); }
  for (const item of items) { const key = sourceKey(item); if (key && !index.has(key)) index.set(key, item); }
  return index;
}

export function findSavedItem(library, url) {
  const key = urlKey(url);
  if (!key) return null;
  const items = (library?.items || []).filter(savable);
  return items.find(item => urlKey(item.url) === key) || items.find(item => sourceKey(item) === key) || null;
}

/** True when `item` is an article saved under another address from the tab at `url` (its sourceUrl). A save of that tab
 * goes to the item's own address, so it updates the article instead of adding a copy under the tab's address. */
export function savedFromSource(item, url) {
  const key = urlKey(url);
  return !!key && savable(item) && sourceKey(item) === key && urlKey(item.url) !== key;
}

// requested: a string (explicit choice, '' = Inbox) or undefined/null (quick save: settings.defaultCollectionId
// for new items; an already saved item stays where it is because the store keeps its collection when given '').
export function resolveCaptureCollection(library, requested, { existing = null, preferred = '' } = {}) {
  const exists = id => typeof id === 'string' && id !== '' && (library?.collections || []).some(collection => collection?.id === id);
  if (requested === INBOX_MENU_ID) requested = '';
  if (typeof requested === 'string') return requested === '' || exists(requested) ? { collectionId: requested } : { collectionId: '', collectionFallback: true };
  if (existing) return { collectionId: '' };
  if (exists(preferred)) return { collectionId: preferred };
  const fallback = library?.settings?.defaultCollectionId;
  return { collectionId: exists(fallback) ? fallback : '' };
}

export function saveToMenuId(kind, target) {
  return `${SAVE_TO_PREFIX}${kind}:${target === '' ? INBOX_MENU_ID : target}`;
}

export function parseSaveToMenuId(id) {
  if (typeof id !== 'string' || !id.startsWith(SAVE_TO_PREFIX)) return null;
  const rest = id.slice(SAVE_TO_PREFIX.length);
  const split = rest.indexOf(':');
  const kind = rest.slice(0, split), target = rest.slice(split + 1);
  if (split < 1 || !SAVE_TO_KINDS.includes(kind) || !target || target === SEPARATOR_MENU_ID) return null;
  return { kind, target, choose: target === CHOOSE_MENU_ID, collectionId: target === INBOX_MENU_ID || target === CHOOSE_MENU_ID ? '' : target };
}

function truncateTitle(value, max) {
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
}

// 'Design › Inspiration'; long paths drop ancestors first so the collection itself stays readable.
export function menuCollectionTitle(collection, collectionsById = new Map(), max = MENU_TITLE_LIMIT) {
  const names = [];
  const seen = new Set();
  for (let current = collection; current && !seen.has(current.id); current = current.parentId ? collectionsById.get(current.parentId) : null) {
    seen.add(current.id);
    names.unshift(clean(current.name, 500) || 'Untitled collection');
  }
  const length = text => [...text].length;
  const full = names.join(' › ');
  if (length(full) <= max) return full;
  if (names.length === 1) return truncateTitle(full, max);
  for (let start = 1; start < names.length; start++) {
    const candidate = `… › ${names.slice(start).join(' › ')}`;
    if (length(candidate) <= max) return candidate;
  }
  return `… › ${truncateTitle(names.at(-1), max - 4)}`;
}

// Order for the "Save … to" submenus: recently used (UI recents), pinned, then latest item activity.
export function rankMenuCollections(library, recent = [], limit = MENU_COLLECTION_LIMIT) {
  const collections = (library?.collections || []).filter(collection => collection && typeof collection.id === 'string' && collection.id && !collection.deletedAt);
  const byId = new Map(collections.map(collection => [collection.id, collection]));
  const activity = new Map();
  for (const item of library?.items || []) {
    if (!item?.collectionId || item.deletedAt) continue;
    const at = Date.parse(item.updatedAt || item.createdAt) || 0;
    if (at > (activity.get(item.collectionId) || 0)) activity.set(item.collectionId, at);
  }
  const position = new Map(collections.map((collection, index) => [collection.id, index]));
  const byActivity = [...collections].sort((a, b) => (activity.get(b.id) || 0) - (activity.get(a.id) || 0)
    || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || position.get(a.id) - position.get(b.id));
  const ranked = new Set([
    ...normalizeRecentCollections(recent).filter(id => byId.has(id)),
    ...collections.filter(collection => collection.pinned === true).map(collection => collection.id),
    ...byActivity.map(collection => collection.id),
  ]);
  return [...ranked].slice(0, Math.max(0, limit)).map(id => byId.get(id));
}

export function collectionMenuEntries(library, recent = [], { limit = MENU_COLLECTION_LIMIT, maxTitle = MENU_TITLE_LIMIT } = {}) {
  const byId = new Map((library?.collections || []).filter(collection => collection?.id).map(collection => [collection.id, collection]));
  return [{ id: INBOX_MENU_ID, title: 'Inbox' },
    ...rankMenuCollections(library, recent, limit).map(collection => ({ id: collection.id, title: menuCollectionTitle(collection, byId, maxTitle) }))];
}

// options: { collectionId, tags, note, title, existing } where existing is the item already saved under
// this canonical URL. Re-saving never replaces a user's note, description, cover or a real title.
export function buildCapture(info = {}, tab = {}, metadata = {}, options = {}) {
  const { menuItemId = 'still-save-page', pageUrl, linkUrl, srcUrl, selectionText, mediaType, linkText } = info || {};
  tab ||= {}; metadata ||= {}; options ||= {};
  const target = parseSaveToMenuId(menuItemId)?.kind || '';
  const isNote = menuItemId === 'still-note-selection';
  const linkMenu = menuItemId === 'still-save-link' || target === 'link';
  // Chrome reports mediaType for a linked image or an image inside a selection too: the chosen menu wins.
  const isImage = !isNote && !linkMenu && (menuItemId === 'still-save-image' || target === 'image'
    || (!target && menuItemId !== 'still-save-selection' && mediaType === 'image'));
  const isSelection = !isNote && !isImage && !linkMenu && target !== 'page' && (menuItemId === 'still-save-selection' || !!selectionText);
  const isLink = !isNote && !isImage && !isSelection && target !== 'page' && !!linkUrl;
  const url = safeUrl(isImage ? srcUrl : isLink ? linkUrl : pageUrl || metadata.url || tab.url, { optional: false });
  const selected = selectionText || metadata.selection || '';
  const existing = !isNote && options.existing && typeof options.existing === 'object' ? options.existing : null;
  const derived = isLink ? clean(linkText) || clean(selectionText) || linkUrl : metadata.title || tab.title || new URL(url).hostname;
  const title = clean(options.title, 2000)
    || (existing && !isPlaceholderTitle(existing.title, url) ? existing.title : isNote ? `Notes on ${derived}` : derived);
  const articleContent = !isNote && !isImage && !isLink && typeof metadata.articleText === 'string' ? metadata.articleText.slice(0, 250000) : '';
  const captured = isNote ? 'note' : isImage ? 'image' : isVideoUrl(url) ? 'video' : articleContent ? 'article' : 'bookmark';
  // A bare link or tab save never downgrades an item that was saved as an article, image, video or file.
  const type = existing && captured === 'bookmark' && ['article', 'image', 'video', 'file'].includes(existing.type) ? existing.type : captured;
  let cover = existing?.cover ? '' : isImage ? url : isLink ? '' : metadata.cover || '';
  try { cover = cover ? safeUrl(new URL(cover, url).href) : ''; } catch { cover = ''; }
  const note = typeof options.note === 'string' ? options.note.trim() : '';
  const content = isNote ? [selected, note].filter(Boolean).join('\n\n') : note && !str(existing?.content).trim() ? note : '';
  return {
    type, title, url: existing?.url && (sameUrl(existing.url, url) || savedFromSource(existing, url)) ? existing.url : url,
    excerpt: isLink || existing?.excerpt ? '' : metadata.excerpt || '', content, articleContent,
    cover, tags: normalizeTags(options.tags), collectionId: typeof options.collectionId === 'string' ? options.collectionId : '',
    sourceUrl: safeUrl(pageUrl || metadata.url || tab.url),
    highlights: isSelection && selected ? [{ text: selected, url, color: 'amber' }] : [],
  };
}
