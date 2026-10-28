import { safeUrl, canonicalUrl } from './store.js';

export const PAGE_TEXT_LIMIT = 120000;
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

// Same match rule as the store's saveItem dedupe: live or archived, never notes, canonical URL.
export function indexSavedUrls(library) {
  const index = new Map();
  for (const item of library?.items || []) {
    if (!item || item.deletedAt || item.type === 'note' || !item.url) continue;
    try {
      const key = canonicalUrl(item.url);
      if (key && !index.has(key)) index.set(key, item);
    } catch { /* Legacy records with unreadable URLs cannot match. */ }
  }
  return index;
}

export function findSavedItem(library, url) {
  if (!url) return null;
  let key;
  try { key = canonicalUrl(url); } catch { return null; }
  return (library?.items || []).find(item => {
    if (!item || item.deletedAt || item.type === 'note' || !item.url) return false;
    try { return canonicalUrl(item.url) === key; } catch { return false; }
  }) || null;
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
    type, title, url: existing?.url && sameUrl(existing.url, url) ? existing.url : url,
    excerpt: isLink || existing?.excerpt ? '' : metadata.excerpt || '', content, articleContent,
    cover, tags: normalizeTags(options.tags), collectionId: typeof options.collectionId === 'string' ? options.collectionId : '',
    sourceUrl: safeUrl(pageUrl || metadata.url || tab.url),
    highlights: isSelection && selected ? [{ text: selected, url, color: 'amber' }] : [],
  };
}
