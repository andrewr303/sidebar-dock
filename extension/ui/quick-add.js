// Quick add: the Add dialog (links, notes, files), paste-to-add, uploads, "Save all tabs", the capture menu and
// screenshot progress. Saving a link into a collection should take one paste and one keystroke.
import { html, cx, plural, safeSrc } from './html.js';
import { icon } from './icons.js';
import { button, iconButton, segmented, checkbox, collectionIcon, favicon, domainOf, fileSize, spinner, badge, emptyState, keyshortcuts, shortcutLabel } from './components.js';
import { registerActions, registerShortcuts } from './runtime.js';
import { registerDialog, isDialogOpen } from './overlay.js';
import { renderCollectionPickerTrigger, renderTagInput, splitTags, mergeTags, formatReminder } from './pickers.js';
import { canonicalUrl, safeUrl } from '../lib/store.js';
import { noteExcerpt } from '../lib/notes.js';
import { isVideoUrl } from '../lib/capture.js';

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
const PENDING_CAPTURE = new Set(['preparing', 'capturing', 'stitching', 'saving']);

/* ------------------------------------------------------------------ pure helpers */

const lower = value => String(value ?? '').toLowerCase();

/**
 * Finds a web link in pasted or typed text. Accepts http(s) URLs, and "www." hosts. With { bare: true } (the URL field)
 * also accepts "example.com/path" and adds https://. Returns the normalized href or ''.
 */
export function detectUrl(text, { bare = false } = {}) {
  const value = String(text ?? '').trim().replace(/^<|>$/g, '');
  if (!value || /\s/.test(value) || value.length > 4000) return '';
  let candidate = value;
  if (!/^https?:\/\//i.test(candidate)) {
    if (/^www\.[^\s/]+\.[^\s/]+/i.test(candidate) || (bare && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(candidate))) candidate = `https://${candidate}`;
    else return '';
  }
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return '';
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return '';
    return url.href;
  } catch { return ''; }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const decodeEntities = text => String(text ?? '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, code) => {
  if (code[0] === '#') {
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
  }
  return ENTITIES[code.toLowerCase()] ?? match;
});
const squash = (text, max) => decodeEntities(text).replace(/\s+/g, ' ').trim().slice(0, max);

/** Reads <title>, Open Graph, Twitter and description tags from HTML source. Returns { title, excerpt, cover, siteName, type }. */
export function parseHtmlMetadata(source, baseUrl = '') {
  const head = String(source ?? '').slice(0, 400_000);
  const meta = new Map();
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = {};
    for (const match of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
    const key = lower(attributes.property || attributes.name || attributes.itemprop);
    if (key && attributes.content != null && !meta.has(key)) meta.set(key, attributes.content);
  }
  const titleTag = head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const pick = (...keys) => keys.map(key => meta.get(key)).find(value => value && value.trim()) || '';
  let cover = pick('og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src', 'image');
  try { cover = cover ? new URL(decodeEntities(cover).trim(), baseUrl || undefined).href : ''; } catch { cover = ''; }
  if (!/^https?:\/\//i.test(cover)) cover = '';
  return {
    title: squash(pick('og:title', 'twitter:title') || titleTag, 300),
    excerpt: squash(pick('og:description', 'twitter:description', 'description'), 500),
    cover,
    siteName: squash(pick('og:site_name', 'application-name'), 120),
    type: lower(pick('og:type')),
  };
}

/** Item type for an uploaded file. */
export const fileKind = ({ type = '' } = {}) => type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : 'file';
const isTextFile = file => /^(text\/plain|text\/markdown)$/.test(file.type || '') || /\.(txt|md|markdown)$/i.test(file.name || '');

/** "Tabs Oct 28, 2026" */
export function defaultTabsCollectionName(date = new Date()) {
  return `Tabs ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

/**
 * Local tag ideas for a link: tags used on items from the same site (most used first), then up to `frequent` of the
 * library's most used tags. items: library items; allTags: [{ name, count }] sorted by count; exclude: tags already chosen.
 */
export function localTagSuggestions(items = [], { url = '', allTags = [], exclude = [], limit = 5, frequent = 2 } = {}) {
  const skip = new Set(exclude.map(lower));
  const out = [];
  const add = name => { const key = lower(name); if (key && !skip.has(key) && !out.some(tag => lower(tag) === key)) { out.push(name); return true; } return false; };
  const domain = domainOf(url);
  if (domain) {
    const counts = new Map();
    for (const item of items) {
      if (item?.deletedAt || domainOf(item?.url) !== domain) continue;
      for (const tag of item.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([tag]) => add(tag));
  }
  let added = 0;
  for (const tag of allTags) { if (added >= frequent || out.length >= limit) break; if (add(tag.name)) added++; }
  return out.slice(0, limit);
}

const validUrl = value => {
  const href = detectUrl(value, { bare: true });
  if (!href) return '';
  try { return safeUrl(href, { optional: false }); } catch { return ''; }
};
const sameUrl = (a, b) => { try { return !!a && !!b && canonicalUrl(a) === canonicalUrl(b); } catch { return false; } };
const originPattern = url => { try { const { protocol, hostname } = new URL(url); return `${protocol}//${hostname}/*`; } catch { return ''; } };

/* ------------------------------------------------------------------ shared helpers (page.js, sidebar) */

let windowIdPromise = null;
/** The browser window this view lives in (side panel), cached in ctx.state.windowId. null outside the extension. */
export function ensureWindowId(ctx) {
  if (!ctx.env.isExtension) return Promise.resolve(null);
  if (Number.isInteger(ctx.state.windowId)) return Promise.resolve(ctx.state.windowId);
  windowIdPromise ||= Promise.resolve(globalThis.chrome?.windows?.getCurrent?.())
    .then(win => { if (Number.isInteger(win?.id)) ctx.state.windowId = win.id; return ctx.state.windowId ?? null; })
    .catch(() => null);
  return windowIdPromise;
}

/** Starts chrome.permissions.request synchronously; call it inside a click handler before any await. Resolves to a boolean. */
export function requestPermission(request) {
  try {
    const pending = globalThis.chrome?.permissions?.request?.(request);
    return Promise.resolve(pending).then(Boolean, () => false);
  } catch { return Promise.resolve(false); }
}

/** Quick-save target: the last collection used here, else settings.defaultCollectionId, else Inbox (''). */
export function defaultCollectionId(ctx) {
  const valid = id => id && ctx.select.collection(id);
  const recent = (ctx.prefs.get('recentCollections', []) || []).find(valid);
  if (recent) return recent;
  const setting = ctx.library?.settings?.defaultCollectionId;
  return valid(setting) ? setting : '';
}

export const collectionLabel = (ctx, id) => (id && ctx.select.collection(id)?.name) || 'Inbox';

/**
 * Saves the active tab through the service worker (keeps its metadata, article text and badge). Handles the
 * permission and fallback answers, updates ctx.state.page and shows "Saved to X" with Undo or Open.
 * Returns the saved item, or null when a permission is still needed.
 */
export async function saveCurrentTab(ctx, { collectionId, note, tags, title } = {}) {
  const windowId = await ensureWindowId(ctx);
  const target = typeof collectionId === 'string' ? collectionId : defaultCollectionId(ctx);
  const page = ctx.state.page;
  const before = page?.url ? ctx.select.savedForUrl(page.url) : null;
  const result = await ctx.chrome('saveCurrentTab', { windowId, collectionId: target, ...(note ? { note } : {}), ...(tags ? { tags } : {}), ...(title ? { title } : {}) });
  if (result?.needsPermission) {
    const ask = result.needsPermission === 'tabs' ? { permissions: ['tabs'] } : { origins: [result.needsPermission] };
    ctx.toast('Allow Still to read this tab to save it.', { action: { label: 'Allow', run: () => requestPermission(ask).then(granted => granted ? saveCurrentTab(ctx, { collectionId: target, note, tags, title }) : null) } });
    return null;
  }
  const item = result;
  if (target && !item.collectionFallback) ctx.prefs.touchCollection(target);
  if (ctx.state.page && (!page?.url || sameUrl(ctx.state.page.url, item.url))) Object.assign(ctx.state.page, { saved: true, itemId: item.id });
  const where = collectionLabel(ctx, item.collectionId);
  const moved = !item.created && before && before.collectionId !== item.collectionId;
  const action = item.created
    ? { label: 'Undo', run: async () => { await ctx.store.deleteItem(item.id); ctx.toast('Removed from your library'); } }
    : moved
      ? { label: 'Undo', run: async () => { await ctx.store.updateItem(item.id, { collectionId: before.collectionId }); ctx.toast(`Moved back to ${collectionLabel(ctx, before.collectionId)}`); } }
      : { label: 'Open', run: () => ctx.openItem(item.id) };
  const message = item.collectionFallback ? 'Saved to Inbox instead. That collection no longer exists.'
    : item.created ? `Saved to ${where}` : moved ? `Moved to ${where}` : `Already saved in ${where}`;
  ctx.toast(message, { tone: item.collectionFallback ? 'warning' : 'success', action });
  ctx.render();
  return item;
}

/* ------------------------------------------------------------------ Add dialog state */

let draft = null;
let draftSeq = 0;
let metaTimer = 0;

const TYPE_OPTIONS = [
  { value: 'link', label: 'Link', icon: 'link' },
  { value: 'note', label: 'Note', icon: 'sticky-note' },
  { value: 'file', label: 'File', icon: 'paperclip' },
];

const fileEntry = file => ({
  id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, file, name: file.name || 'Untitled file', size: file.size || 0, kind: fileKind(file),
  error: file.size > MAX_FILE_BYTES ? 'Over 100 MB. Choose a smaller file.' : '',
});

function createDraft(ctx, prefill = {}) {
  const files = [...(prefill.files || [])].filter(file => file && typeof file === 'object');
  const type = prefill.type === 'note' ? 'note' : prefill.type === 'file' || files.length ? 'file' : 'link';
  const itemType = ['bookmark', 'article', 'image', 'video'].includes(prefill.type) ? prefill.type : prefill.kind === 'image' ? 'image' : '';
  const url = prefill.url ? detectUrl(prefill.url, { bare: true }) || String(prefill.url) : '';
  // An explicit collection wins, then the collection open in the full tab, then the quick-save default.
  const viewCollection = !ctx.env.isSidepanel && ctx.state.view?.startsWith('collection:') ? ctx.state.view.slice(11) : '';
  let collectionId = defaultCollectionId(ctx);
  if (typeof prefill.collectionId === 'string' && (prefill.collectionId === '' || ctx.select.collection(prefill.collectionId))) collectionId = prefill.collectionId;
  else if (viewCollection && ctx.select.collection(viewCollection)) collectionId = viewCollection;
  const touched = new Set(['title', 'excerpt', 'cover', 'note', 'tags'].filter(key => prefill[key]?.length));
  if (typeof prefill.collectionId === 'string') touched.add('collection');
  return {
    id: ++draftSeq, type, itemType, url, title: String(prefill.title || ''), excerpt: String(prefill.excerpt || ''),
    cover: String(prefill.cover || (itemType === 'image' ? url : '')), note: String(prefill.note || ''),
    collectionId, tags: Array.isArray(prefill.tags) ? prefill.tags.map(String) : splitTags(prefill.tags),
    favorite: prefill.favorite === true, reminderAt: prefill.reminderAt || null,
    files: files.map(fileEntry), sourceUrl: String(prefill.sourceUrl || ''), articleContent: '',
    source: prefill.source || 'manual', urlFirst: type === 'link' && !url, touched,
    meta: { status: 'idle', forUrl: '' }, suggest: { status: 'idle', key: '', tags: [], collectionId: '', source: '' },
    updateId: '', saving: false, error: '', urlError: '', dragging: false,
  };
}

// "Update it": the draft edits the saved item; anything the user already typed wins over the stored values.
function editExisting(d, item) {
  Object.assign(d, {
    updateId: item.id, type: 'link', urlFirst: false, url: d.url || item.url,
    title: d.touched.has('title') && d.title ? d.title : item.title || d.title,
    excerpt: d.touched.has('excerpt') && d.excerpt ? d.excerpt : item.excerpt || d.excerpt,
    cover: d.touched.has('cover') ? d.cover : item.cover || d.cover, note: d.note.trim() ? d.note : item.content || '',
    collectionId: d.touched.has('collection') ? d.collectionId : item.collectionId || '', tags: mergeTags(item.tags || [], d.tags),
    favorite: d.favorite || item.favorite === true, reminderAt: d.reminderAt || item.reminderAt || null,
  });
  // Saved values are the user's: page details fetched later must not replace them.
  for (const key of ['title', 'excerpt', 'cover']) if (item[key]) d.touched.add(key);
}

/**
 * Opens the Add dialog. prefill: { url, title, excerpt, cover, collectionId, tags, note, type: 'link'|'note'|'file'|item type,
 * kind: 'page'|'link'|'image', files, source: 'tab'|'paste'|'menu'|'upload'|'drop', sourceUrl, favorite, reminderAt,
 * updateId: edit that saved link instead of adding }. When the dialog is already open, the prefill is merged into it.
 */
export function openAdd(ctx, prefill = {}) {
  prefill ||= {};
  if (draft && isDialogOpen('add.item')) {
    const next = createDraft(ctx, prefill);
    if (prefill.files?.length) { draft.type = 'file'; draft.files.push(...next.files); }
    if (prefill.url && !validUrl(draft.url)) { draft.url = next.url; draft.type = 'link'; scheduleMeta(ctx, 0); }
    for (const key of ['title', 'excerpt', 'note']) if (prefill[key] && !draft[key]) draft[key] = next[key];
    if (typeof prefill.collectionId === 'string') draft.collectionId = next.collectionId;
    ctx.render();
    return;
  }
  draft = createDraft(ctx, prefill);
  const existing = prefill.updateId ? ctx.select.byId(prefill.updateId) : null;
  if (existing?.url && existing.type !== 'note') editExisting(draft, existing);
  const id = draft.id;
  ctx.openDialog('add.item', { onClose: () => { if (draft?.id === id) draft = null; clearTimeout(metaTimer); } });
  if (draft.type === 'link' && validUrl(draft.url)) scheduleMeta(ctx, 0);
  else if (draft.type === 'link' && !draft.url) prefillFromClipboard(ctx, id);
}

/** Opens Add prefilled with the active tab (side panel). */
export function openAddForPage(ctx, extra = {}) {
  const page = ctx.state.page;
  if (!page?.url) return openAdd(ctx, extra);
  return openAdd(ctx, { url: page.url, title: page.title, source: 'tab', ...extra });
}

// Reads the clipboard only when the browser already granted it, so opening Add never triggers a prompt.
async function prefillFromClipboard(ctx, id) {
  try {
    const status = await navigator.permissions?.query?.({ name: 'clipboard-read' });
    if (status?.state !== 'granted') return;
    const url = detectUrl(await navigator.clipboard.readText());
    if (!url || draft?.id !== id || draft.url) return;
    draft.url = url;
    draft.source = 'paste';
    ctx.render();
    scheduleMeta(ctx, 0);
  } catch { /* Clipboard access is optional. */ }
}

/* ------------------------------------------------------------------ metadata + suggestions */

function scheduleMeta(ctx, delay = 450) {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => { loadMeta(ctx).catch(error => console.warn('[still] page details', error)); }, delay);
}

async function hasOrigin(origin) {
  try { return (await globalThis.chrome?.permissions?.contains?.({ origins: [origin] })) === true; } catch { return false; }
}

async function readLimited(response, limit = 512 * 1024) {
  if (!response.body?.getReader) return (await response.text()).slice(0, limit);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (out.length < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (/<\/head>/i.test(out)) break;
  }
  reader.cancel().catch(() => {});
  return out;
}

async function fetchMetadata(url) {
  const response = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout?.(8000) });
  if (!response.ok) throw new Error(`The page answered ${response.status}.`);
  if (!/html|xml/i.test(response.headers.get('content-type') || 'text/html')) return { title: '', excerpt: '', cover: '' };
  return parseHtmlMetadata(await readLimited(response), response.url || url);
}

function applyMeta(d, meta) {
  if (!meta) return;
  if (meta.title && !d.touched.has('title')) d.title = meta.title;
  if (meta.excerpt && !d.touched.has('excerpt')) d.excerpt = meta.excerpt;
  if (meta.cover && !d.touched.has('cover') && !d.cover) d.cover = meta.cover;
  if (typeof meta.text === 'string' && meta.text.trim().length > 600) d.articleContent = meta.text;
}

async function loadMeta(ctx, { force = false } = {}) {
  const d = draft;
  if (!d || d.type !== 'link') return;
  const url = validUrl(d.url);
  if (!url || (!force && d.meta.forUrl === url)) return;
  const id = d.id;
  // An image link (context menu "Save image to") has no page details to read; asking for its CDN's access would mislead.
  if (d.itemType === 'image') { d.meta = { status: 'done', forUrl: url }; loadSuggestions(ctx); return; }
  d.meta = { status: 'loading', forUrl: url };
  ctx.render();
  let meta = null, needs = '';
  try {
    if (ctx.env.isExtension && sameUrl(ctx.state.page?.url, url)) {
      const windowId = await ensureWindowId(ctx);
      const page = await ctx.chrome('getPageContext', { tabId: ctx.state.page?.tabId, windowId });
      if (page?.needsPermission) needs = page.needsPermission === 'tabs' ? '' : page.needsPermission;
      else meta = page;
    }
    // Outside the extension a cross-site fetch is blocked by CORS, so the preview skips it.
    if (!meta && !needs && ctx.env.isExtension) {
      const origin = originPattern(url);
      if (!(await hasOrigin(origin))) needs = origin;
      else meta = await fetchMetadata(url);
    }
  } catch (error) {
    if (draft?.id === id && draft.meta.forUrl === url) { draft.meta = { status: 'error', forUrl: url, message: error?.message || '' }; ctx.render(); }
    loadSuggestions(ctx);
    return;
  }
  if (draft?.id !== id || validUrl(draft.url) !== url) return;
  if (needs) d.meta = { status: 'permission', forUrl: url, origin: needs };
  else { applyMeta(d, meta); d.meta = { status: 'done', forUrl: url }; }
  ctx.render();
  loadSuggestions(ctx);
}

async function loadSuggestions(ctx) {
  const d = draft;
  if (!d || d.type !== 'link' || !ctx.ai?.suggestForSave) return;
  const url = validUrl(d.url);
  const key = `${url}|${d.title}`;
  if (!url || d.suggest.key === key) return;
  d.suggest = { ...d.suggest, key, status: 'loading' };
  const id = d.id;
  try {
    const settings = await ctx.ai.getAiSettings?.().catch(() => null);
    if (settings && settings.autoSuggestOnSave === false) { d.suggest.status = 'off'; return; }
    const result = await ctx.ai.suggestForSave({ url, title: d.title, excerpt: d.excerpt, content: d.articleContent,
      collections: ctx.library?.collections || [], tags: ctx.select.tags() });
    if (draft?.id !== id || draft.suggest.key !== key) return;
    const collectionId = result?.collectionId && ctx.select.collection(result.collectionId) ? result.collectionId : '';
    draft.suggest = { key, status: 'done', tags: Array.isArray(result?.tags) ? result.tags : [], collectionId, source: result?.source || '' };
    // Only a model's title and summary are worth filling in; the heuristic just echoes the page.
    if (result?.source === 'ai' && !draft.touched.has('title') && !draft.title && result.title) draft.title = result.title;
    if (result?.source === 'ai' && !draft.touched.has('excerpt') && !draft.excerpt && result.summary) draft.excerpt = result.summary;
    ctx.render();
  } catch (error) {
    if (draft?.id === id) draft.suggest.status = 'error';
    console.warn('[still] save suggestions', error);
  }
}

// Suggested tags: AI (or the engine's heuristic) first, then tags from the same site, then a few frequent tags.
function tagSuggestions(ctx, d) {
  const smart = (d.suggest.tags || []).filter(tag => !d.tags.some(t => lower(t) === lower(tag)));
  const local = localTagSuggestions(ctx.select.live(), { url: d.url, allTags: ctx.select.tags(), exclude: [...d.tags, ...smart], limit: 5, frequent: smart.length >= 2 ? 1 : 2 });
  return mergeTags(smart, local).slice(0, 5);
}

/* ------------------------------------------------------------------ Add dialog view */

const row = (label, control, { id, className } = {}) => html`<div class="${cx('add-row', className)}">
  ${id ? html`<label class="add-label" for="${id}">${label}</label>` : html`<span class="add-label">${label}</span>`}<div class="add-control">${control}</div></div>`;

function renderUrlRow(ctx, d) {
  const meta = d.meta;
  const status = meta.status === 'loading' && meta.forUrl === validUrl(d.url)
    ? html`<span class="add-url-status">${spinner({ size: 14 })}<span>Reading the page</span></span>` : '';
  return html`${row('URL', html`<div class="${cx('add-url', d.urlError && 'has-error')}">
      <span class="input-wrap add-url-field">${icon('link', { size: 16, className: 'input-icon' })}<input class="input has-icon" type="url" inputmode="url" id="add-url" data-focus-key="add-url"
        name="url" value="${d.url}" placeholder="Paste or type a link" ${d.urlFirst && !d.url ? html`data-autofocus` : ''} data-input="add.url" data-keydown="add.url-key"
        autocomplete="off" spellcheck="false" ${d.urlError ? html`aria-invalid="true" aria-describedby="add-url-error"` : ''}></span>${status}</div>
      ${d.urlError ? html`<p class="add-error" id="add-url-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${d.urlError}</span></p>` : ''}`,
    { id: 'add-url', className: 'add-row-url' })}`;
}

function renderPermissionNotice(d) {
  if (d.meta.status !== 'permission') return '';
  let host = '';
  try { host = new URL(d.meta.forUrl).hostname.replace(/^www\./, ''); } catch { host = ''; }
  return html`<div class="add-permission">${icon('shield-check', { size: 16 })}
    <span>Allow Still to read ${host || 'this site'} to fill in details</span>
    ${button({ label: 'Allow', variant: 'secondary', size: 'sm', action: 'add.meta-allow', data: { origin: d.meta.origin } })}</div>`;
}

function renderCover(d) {
  // A cover that failed to load (404, blocked host) shows the fallback tile instead of a broken image.
  const src = d.cover && d.cover !== d.coverFailed ? safeSrc(d.cover) : '';
  const fallback = html`<span class="add-cover-fallback">${d.url ? favicon(d.url, { size: 28 }) : icon('image', { size: 20 })}</span>`;
  return html`<div class="${cx('add-cover', !src && 'is-empty')}">
    ${src ? html`<img src="${src}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : fallback}
    <button type="button" class="add-cover-btn" aria-label="${src ? 'Change or remove cover' : 'Add a cover image'}" data-tooltip="${src ? 'Change cover' : 'Add cover'}"
      aria-haspopup="menu" data-action="add.cover-menu">${icon('image', { size: 14 })}</button>
  </div>`;
}

function renderPreview(ctx, d) {
  const domain = domainOf(d.url);
  const url = validUrl(d.url);
  const saved = url && !d.updateId ? ctx.select.savedForUrl(url) : null;
  const loading = d.meta.status === 'loading';
  return html`<div class="add-preview">
    ${renderCover(d)}
    <div class="add-preview-text">
      <input class="add-title" id="add-title" data-focus-key="add-title" name="title" value="${d.title}" placeholder="${loading ? 'Reading the page…' : saved?.title || domain || 'Title'}"
        aria-label="Title" data-input="add.field" data-field="title" autocomplete="off">
      <textarea class="add-desc" id="add-excerpt" data-focus-key="add-excerpt" name="excerpt" rows="2" placeholder="Add a description" aria-label="Description"
        data-input="add.field" data-field="excerpt">${d.excerpt}</textarea>
      ${renderPermissionNotice(d)}
    </div>
  </div>`;
}

function renderDuplicate(ctx, d) {
  const url = validUrl(d.url);
  if (d.type !== 'link' || !url) return '';
  if (d.updateId) {
    const item = ctx.select.byId(d.updateId);
    if (!item) return '';
    return html`<div class="add-notice is-update" role="status">${icon('pencil', { size: 16 })}<span class="add-notice-text">Editing the saved link in
      ${collectionIcon(ctx.select.collection(item.collectionId), { size: 16 })}<strong>${collectionLabel(ctx, item.collectionId)}</strong></span></div>`;
  }
  const existing = ctx.select.savedForUrl(url);
  if (!existing) return '';
  const collection = ctx.select.collection(existing.collectionId);
  const path = collection ? ctx.select.path(collection.id).map(c => c.name).join(' / ') : 'Inbox';
  return html`<div class="add-notice" role="status">${icon('bookmark-check', { size: 16 })}
    <span class="add-notice-text">Already saved in ${collectionIcon(collection, { size: 16 })}<strong>${path}</strong></span>
    <span class="add-notice-actions">
      ${button({ label: 'Open', variant: 'ghost', size: 'sm', action: 'add.open-existing', data: { id: existing.id } })}
      ${button({ label: 'Update it', variant: 'secondary', size: 'sm', action: 'add.update-existing', data: { id: existing.id } })}
    </span></div>`;
}

function renderNoteField(d, { rows = 3, autofocus = false } = {}) {
  return html`<div class="add-note">
    <textarea class="add-note-input" id="add-note" data-focus-key="add-note" name="note" rows="${rows}" placeholder="${d.type === 'note' ? 'Write your note' : 'Add a note'}"
      data-input="add.field" data-field="note" ${autofocus ? html`data-autofocus` : ''} aria-describedby="add-note-hint">${d.note}</textarea>
    <div class="add-note-foot" id="add-note-hint">${icon('pilcrow', { size: 12 })}<span>Markdown</span></div>
  </div>`;
}

function renderCollectionField(ctx, d) {
  const suggestion = d.suggest.collectionId && d.suggest.collectionId !== d.collectionId && !d.touched.has('collection') ? ctx.select.collection(d.suggest.collectionId) : null;
  return html`<div class="add-collection">
    ${renderCollectionPickerTrigger({ ctx, value: d.collectionId, action: 'add.set-collection', id: 'add-collection', label: 'Collection' })}
    ${suggestion ? html`<button type="button" class="tag-suggest add-suggest-collection" data-action="add.use-suggested-collection" aria-label="Use suggested collection ${suggestion.name}">
      ${icon(d.suggest.source === 'ai' ? 'sparkles' : 'lightbulb', { size: 14, className: 'tag-suggest-icon' })}<span>Suggested:</span>${collectionIcon(suggestion, { size: 14 })}<span class="add-suggest-name">${suggestion.name}</span></button>` : ''}
  </div>`;
}

function renderTagsField(ctx, d) {
  return renderTagInput({ ctx, id: 'add-tags', tags: d.tags, action: 'add.set-tags', label: 'Tags', placeholder: 'Add tags',
    suggestions: d.type === 'link' ? tagSuggestions(ctx, d) : localTagSuggestions([], { allTags: ctx.select.tags(), exclude: d.tags, limit: 4 }),
    suggestionIcon: d.suggest.source === 'ai' ? 'sparkles' : 'tag' });
}

function renderReminderRow(d) {
  if (!d.reminderAt) return '';
  return row('Reminder', html`<span class="add-reminder-chip">${icon('bell', { size: 14 })}<span>${formatReminder(d.reminderAt)}</span>
    <button type="button" class="add-chip-remove" aria-label="Clear reminder" data-action="add.clear-reminder">${icon('x', { size: 12 })}</button></span>`);
}

function renderFiles(d) {
  return html`<div class="${cx('add-drop', d.dragging && 'is-dragging')}" data-add-drop>
      <input type="file" multiple class="sr-only" id="add-file-input" tabindex="-1" aria-hidden="true" data-change="add.files-picked">
      <span class="add-drop-icon" aria-hidden="true">${icon('upload', { size: 20 })}</span>
      <p class="add-drop-title">Drop files here</p>
      <p class="add-drop-hint">Images, videos, PDFs and documents up to 100 MB each</p>
      ${button({ label: d.files.length ? 'Add more files' : 'Choose files', variant: 'secondary', size: 'sm', action: 'add.choose-files', icon: 'paperclip', id: 'add-choose-files', attrs: { 'data-autofocus': d.files.length ? null : true } })}
    </div>
    ${d.files.length ? html`<ul class="add-files" aria-label="Files to upload">${d.files.map(entry => html`<li class="${cx('add-file', entry.error && 'has-error')}" data-key="file:${entry.id}">
      <span class="add-file-icon" aria-hidden="true">${icon(entry.kind === 'image' ? 'image' : entry.kind === 'video' ? 'film' : 'file-text', { size: 16 })}</span>
      <span class="add-file-text"><span class="add-file-name">${entry.name}</span><span class="add-file-meta">${entry.error || fileSize(entry.size)}</span></span>
      ${iconButton({ icon: 'x', label: `Remove ${entry.name}`, action: 'add.remove-file', data: { id: entry.id }, size: 'sm' })}
    </li>`)}</ul>` : ''}`;
}

function renderBody(ctx, d) {
  if (d.type === 'file') {
    const single = d.files.filter(f => !f.error).length === 1;
    return html`${renderFiles(d)}
      ${single ? row('Title', html`<input class="input" id="add-file-title" data-focus-key="add-file-title" value="${d.title || d.files.find(f => !f.error)?.name || ''}" data-input="add.field" data-field="title" autocomplete="off">`, { id: 'add-file-title' }) : ''}
      ${row('Note', renderNoteField(d, { rows: 2 }), { id: 'add-note', className: 'add-row-note' })}
      ${row('Collection', renderCollectionField(ctx, d), { id: 'add-collection' })}
      ${row('Tags', renderTagsField(ctx, d), { id: 'tag-input-add-tags' })}
      ${renderReminderRow(d)}`;
  }
  if (d.type === 'note') {
    const page = validUrl(d.url);
    return html`${row('Title', html`<input class="input add-note-title" id="add-note-title" data-focus-key="add-note-title" value="${d.title}" placeholder="Untitled note"
        data-input="add.field" data-field="title" ${d.title ? '' : html`data-autofocus`} autocomplete="off">`, { id: 'add-note-title' })}
      ${row('Note', renderNoteField(d, { rows: 7, autofocus: !!d.title }), { id: 'add-note', className: 'add-row-note' })}
      ${row('Collection', renderCollectionField(ctx, d), { id: 'add-collection' })}
      ${row('Tags', renderTagsField(ctx, d), { id: 'tag-input-add-tags' })}
      ${page ? row('Page', html`<span class="add-page-chip">${favicon(page, { size: 16 })}<span class="add-page-domain">${domainOf(page)}</span>
        <button type="button" class="add-chip-remove" aria-label="Unlink this page" data-action="add.unlink-page">${icon('x', { size: 12 })}</button></span>`) : ''}
      ${renderReminderRow(d)}`;
  }
  const url = validUrl(d.url);
  const showPreview = !d.urlFirst || url || d.title || d.cover;
  return html`${d.urlFirst ? renderUrlRow(ctx, d) : ''}
    ${renderDuplicate(ctx, d)}
    ${showPreview ? renderPreview(ctx, d) : ''}
    ${row('Note', renderNoteField(d), { id: 'add-note', className: 'add-row-note' })}
    ${row('Collection', renderCollectionField(ctx, d), { id: 'add-collection' })}
    ${row('Tags', renderTagsField(ctx, d), { id: 'tag-input-add-tags' })}
    ${d.urlFirst ? '' : renderUrlRow(ctx, d)}
    ${renderReminderRow(d)}`;
}

function renderAddDialog(ctx) {
  const d = draft;
  if (!d) return '';
  const title = d.type === 'note' ? 'New note' : d.type === 'file' ? 'Upload files' : d.updateId ? 'Update link' : 'Add link';
  const validFiles = d.files.filter(f => !f.error).length;
  const saveLabel = d.type === 'file' ? (validFiles > 1 ? `Upload ${validFiles} files` : 'Upload') : d.updateId ? 'Update' : 'Save';
  const headerActions = html`<div class="add-head-actions">
    <div class="add-type">${segmented({ name: 'add-type', value: d.type, options: TYPE_OPTIONS, action: 'add.type', size: 'sm', ariaLabel: 'What to add' })}</div>
    ${iconButton({ icon: 'star', label: d.favorite ? 'Remove from favorites' : 'Add to favorites', action: 'add.favorite', pressed: d.favorite, size: 'sm', className: 'add-fav' })}
    ${iconButton({ icon: d.reminderAt ? 'bell-ring' : 'bell', label: d.reminderAt ? `Reminder: ${formatReminder(d.reminderAt)}` : 'Remind me', action: 'add.reminder', pressed: !!d.reminderAt, size: 'sm', className: 'add-remind' })}
    <span class="add-vr" aria-hidden="true"></span>
  </div>`;
  const heading = html`<span>${title}</span>${d.source === 'tab' && d.type === 'link' ? html`<span class="add-source-chip">${icon('app-window', { size: 12 })}From current tab</span>` : ''}`;
  const footer = html`<div class="add-foot-start">${d.error ? html`<p class="add-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${d.error}</span></p>` : ''}</div>
    ${button({ label: 'Cancel', variant: 'ghost', action: 'overlay.dismiss' })}
    ${button({ label: saveLabel, variant: 'primary', type: 'submit', loading: d.saving, disabled: d.saving || (d.type === 'file' && !validFiles),
      tooltip: `${saveLabel} (${shortcutLabel('mod+enter')})`, attrs: { 'aria-keyshortcuts': keyshortcuts('mod+enter') }, className: 'add-save' })}`;
  return html`<form class="dialog-form add-form" data-submit="add.save" data-type="${d.type}" novalidate data-key="add-form">
    <header class="dialog-header add-header">
      <div class="dialog-heading"><h2 class="dialog-title" id="dialog-title-add.item">${heading}</h2></div>
      ${headerActions}${iconButton({ icon: 'x', label: 'Close', action: 'overlay.dismiss', size: 'sm', className: 'dialog-close' })}
    </header>
    <div class="dialog-body add-body">${renderBody(ctx, d)}</div>
    <footer class="dialog-footer add-footer">${footer}</footer>
  </form>`;
}

registerDialog('add.item', renderAddDialog, { size: 'md', className: 'add-dialog' });

/* ------------------------------------------------------------------ saving */

async function imageThumbnail(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // WebP keeps transparency (JPEG turns transparent logos black); Chrome falls back to PNG, which the store also accepts.
    return canvas.toDataURL('image/webp', 0.82);
  } finally { bitmap.close?.(); }
}

async function saveLink(ctx, d, url) {
  const existing = d.updateId ? ctx.select.byId(d.updateId) : ctx.select.savedForUrl(url);
  const type = d.itemType === 'image' ? 'image' : isVideoUrl(url) ? 'video' : d.articleContent ? 'article' : d.itemType || 'bookmark';
  if (d.updateId && existing) {
    const patch = { url, title: d.title.trim() || existing.title, excerpt: d.excerpt.trim(), cover: d.cover, content: d.note, collectionId: d.collectionId,
      tags: d.tags, favorite: d.favorite, reminderAt: d.reminderAt || null };
    if (d.articleContent && !existing.articleContent) patch.articleContent = d.articleContent;
    if (existing.type === 'bookmark' && type !== 'bookmark') patch.type = type;
    return ctx.store.updateItem(existing.id, patch, { expectedUpdatedAt: existing.updatedAt });
  }
  // The store merges a save into an existing item with the same address, so only send what the user set.
  // A fetched cover that failed to load here is dropped rather than saved as a broken image.
  const cover = d.cover && d.cover === d.coverFailed && !d.touched.has('cover') ? '' : d.cover;
  const input = { url, excerpt: d.excerpt.trim(), cover, content: d.note, collectionId: d.collectionId, tags: d.tags, articleContent: d.articleContent, sourceUrl: d.sourceUrl };
  if (d.title.trim()) input.title = d.title.trim();
  if (!existing || (existing.type === 'bookmark' && type !== 'bookmark')) input.type = type;
  if (d.favorite) input.favorite = true;
  if (d.reminderAt) input.reminderAt = d.reminderAt;
  return ctx.store.saveItem(input);
}

function noteInput(ctx, d) {
  const url = validUrl(d.url);
  const source = url ? ctx.select.savedForUrl(url) : null;
  const input = { type: 'note', title: d.title.trim(), content: d.note, excerpt: noteExcerpt(d.note), url, collectionId: d.collectionId, tags: d.tags,
    relatedIds: source ? [source.id] : [] };
  if (d.favorite) input.favorite = true;
  if (d.reminderAt) input.reminderAt = d.reminderAt;
  return input;
}

async function saveFiles(ctx, d) {
  const saved = [];
  const pending = d.files.filter(entry => !entry.error && !entry.savedId);
  for (const entry of pending) {
    const file = entry.file;
    const kind = fileKind(file);
    const cover = kind === 'image' && /^image\/(png|jpeg|gif|webp|avif)$/.test(file.type) && file.size < 20 * 1024 * 1024 ? await imageThumbnail(file).catch(() => '') : '';
    // Read only the start of large text files: the store keeps 250,000 characters (at most 4 bytes each).
    const articleContent = isTextFile(file) ? (await file.slice(0, 1_000_000).text()).slice(0, 250000) : '';
    const attachment = await ctx.store.saveAttachment(file);
    try {
      const title = pending.length === 1 && d.title.trim() ? d.title.trim() : entry.name;
      const input = { type: kind, title, ...attachment, cover, articleContent, content: d.note, collectionId: d.collectionId, tags: d.tags };
      if (d.favorite) input.favorite = true;
      if (d.reminderAt) input.reminderAt = d.reminderAt;
      const item = await ctx.store.saveItem(input);
      entry.savedId = item.id;
      saved.push(item);
    } catch (error) {
      await ctx.store.deleteAttachment(attachment.attachmentId).catch(() => {});
      throw error;
    }
  }
  return saved;
}

async function saveDraft(ctx) {
  const d = draft;
  if (!d || d.saving) return;
  d.error = '';
  d.urlError = '';
  let url = '';
  if (d.type === 'link') {
    url = validUrl(d.url);
    if (!url) {
      d.urlError = d.url.trim() ? 'Enter a full web address, for example https://example.com.' : 'Paste or type a link to save.';
      ctx.render();
      ctx.nextFrame(() => document.getElementById('add-url')?.focus());
      return;
    }
  } else if (d.type === 'note' && !d.title.trim() && !d.note.trim()) {
    d.error = 'Write a title or a note first.';
    ctx.render();
    ctx.nextFrame(() => document.getElementById('add-note-title')?.focus());
    return;
  } else if (d.type === 'file' && !d.files.some(entry => !entry.error && !entry.savedId)) {
    d.error = 'Choose a file to upload.';
    ctx.render();
    return;
  }
  d.saving = true;
  ctx.render();
  // A link already in the library is merged by the store (it keeps its collection when Inbox is chosen).
  const merged = d.type === 'link' && !d.updateId && !!ctx.select.savedForUrl(url);
  let saved = [];
  try {
    if (d.type === 'file') saved = await saveFiles(ctx, d);
    else if (d.type === 'note') saved = [await ctx.store.saveItem(noteInput(ctx, d))];
    else saved = [await saveLink(ctx, d, url)];
  } catch (error) {
    d.saving = false;
    d.error = /conflict/i.test(error?.message || '') ? 'This item changed in another view. Close and try again.' : error?.message || 'Could not save. Try again.';
    if (draft === d) ctx.render();
    return;
  }
  ctx.prefs.touchCollection(d.collectionId);
  if (draft === d) { draft = null; ctx.closeDialog('add.item'); }
  const first = saved[0];
  const where = collectionLabel(ctx, first ? first.collectionId : d.collectionId);
  const message = d.type === 'file' && saved.length > 1 ? `Saved ${saved.length} files to ${where}` : d.updateId || merged ? `Updated in ${where}` : `Saved to ${where}`;
  ctx.toast(message, { tone: 'success', action: first ? { label: 'Open', run: () => ctx.openItem(first.id) } : null });
  if (url && first && ctx.state.page && sameUrl(ctx.state.page.url, url)) Object.assign(ctx.state.page, { saved: true, itemId: first.id });
  ctx.render();
}

function addFiles(ctx, list) {
  const d = draft;
  if (!d) return;
  const files = [...(list || [])];
  if (!files.length) return;
  d.type = 'file';
  d.files.push(...files.map(fileEntry));
  d.error = '';
  ctx.render();
}

/* ------------------------------------------------------------------ Save all tabs */

let tabsDraft = null;

/** Opens the "Save all tabs" dialog. */
export function openSaveTabs(ctx, { collectionId } = {}) {
  tabsDraft = { status: ctx.env.isExtension ? 'loading' : 'unavailable', tabs: [], selected: new Set(), mode: collectionId ? 'existing' : 'new',
    name: defaultTabsCollectionName(new Date()), collectionId: typeof collectionId === 'string' ? collectionId : defaultCollectionId(ctx), saving: false, error: '' };
  const current = tabsDraft;
  ctx.openDialog('add.tabs', { onClose: () => { if (tabsDraft === current) tabsDraft = null; } });
  if (ctx.env.isExtension) loadTabs(ctx);
}

async function loadTabs(ctx) {
  const t = tabsDraft;
  if (!t) return;
  t.status = 'loading';
  ctx.render();
  try {
    const windowId = await ensureWindowId(ctx);
    const result = await ctx.chrome('listTabs', { windowId });
    if (tabsDraft !== t) return;
    if (result?.needsPermission) t.status = 'permission';
    else {
      t.tabs = Array.isArray(result) ? result : [];
      t.selected = new Set(t.tabs.map(tab => tab.tabId));
      t.status = t.tabs.length ? 'ready' : 'empty';
    }
  } catch (error) {
    if (tabsDraft !== t) return;
    t.status = 'error';
    t.error = error?.message || 'Could not read your tabs.';
  }
  ctx.render();
}

function renderTabsList(t) {
  if (t.status === 'unavailable') return emptyState({ icon: 'app-window', title: 'Available in the extension', body: 'Install Still in Chrome to save every open tab at once.', compact: true });
  if (t.status === 'loading') return html`<div class="tabs-loading">${spinner({ size: 16, label: 'Loading tabs' })}<span>Reading your open tabs</span></div>`;
  if (t.status === 'permission') return emptyState({ icon: 'app-window', title: 'Allow Still to see your open tabs', compact: true,
    body: 'Chrome asks once. Still reads tab titles and addresses only to save them.', actions: button({ label: 'Allow access', variant: 'primary', size: 'sm', action: 'add.tabs-allow' }) });
  if (t.status === 'error') return emptyState({ icon: 'circle-alert', title: 'Could not read your tabs', body: t.error, compact: true, actions: button({ label: 'Try again', size: 'sm', action: 'add.tabs-reload' }) });
  if (t.status === 'empty') return emptyState({ icon: 'app-window', title: 'No web pages in this window', body: 'Open the pages you want to keep, then try again.', compact: true });
  const all = t.tabs.length && t.selected.size === t.tabs.length;
  return html`<div class="tabs-list-head"><span>${plural(t.tabs.length, 'tab')} in this window</span>
      ${button({ label: all ? 'Select none' : 'Select all', variant: 'link', size: 'sm', action: 'add.tabs-all' })}</div>
    <ul class="tabs-list">${t.tabs.map(tab => html`<li class="tabs-row" data-key="tab:${tab.tabId}">
      ${checkbox({ checked: t.selected.has(tab.tabId), label: tab.title || tab.url, action: 'add.tabs-toggle', data: { tabId: tab.tabId }, className: 'tabs-check' })}
      <span class="tabs-meta">${favicon(tab.url, { size: 14 })}<span class="tabs-domain">${domainOf(tab.url)}</span>${tab.saved ? badge({ label: 'Saved', tone: 'neutral' }) : ''}</span>
    </li>`)}</ul>`;
}

function renderTabsDialog(ctx) {
  const t = tabsDraft;
  if (!t) return '';
  const count = t.selected.size;
  const ready = t.status === 'ready';
  const body = html`<div class="tabs-dest">
      <span class="add-label" id="tabs-dest-label">Save to</span>
      <div class="tabs-dest-control">
        ${segmented({ name: 'tabs-mode', value: t.mode, action: 'add.tabs-mode', size: 'sm', ariaLabel: 'Destination',
          options: [{ value: 'new', label: 'New collection', icon: 'folder-plus' }, { value: 'existing', label: 'Existing collection', icon: 'folder' }] })}
        ${t.mode === 'new'
          ? html`<input class="input" id="tabs-name" data-focus-key="tabs-name" aria-labelledby="tabs-dest-label" value="${t.name}" data-input="add.tabs-name" placeholder="Collection name" autocomplete="off">`
          : renderCollectionPickerTrigger({ ctx, value: t.collectionId, action: 'add.tabs-collection', id: 'tabs-collection', label: 'Save to' })}
      </div>
    </div>
    <div class="tabs-body">${renderTabsList(t)}</div>`;
  const footer = html`<div class="add-foot-start">${t.error && t.status === 'ready' ? html`<p class="add-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${t.error}</span></p>` : ''}</div>
    ${button({ label: 'Cancel', variant: 'ghost', action: 'overlay.dismiss' })}
    ${button({ label: ready ? `Save ${plural(count, 'tab')}` : 'Save tabs', variant: 'primary', action: 'add.tabs-save', disabled: !ready || !count || t.saving, loading: t.saving,
      tooltip: `Save (${shortcutLabel('mod+enter')})`, attrs: { 'aria-keyshortcuts': keyshortcuts('mod+enter') } })}`;
  return html`<header class="dialog-header"><div class="dialog-heading"><h2 class="dialog-title" id="dialog-title-add.tabs">Save all tabs</h2>
      <p class="dialog-subtitle">Keep every page in this window in one collection.</p></div>
      ${iconButton({ icon: 'x', label: 'Close', action: 'overlay.dismiss', size: 'sm', className: 'dialog-close' })}</header>
    <div class="dialog-body tabs-dialog-body">${body}</div>
    <footer class="dialog-footer add-footer">${footer}</footer>`;
}

registerDialog('add.tabs', renderTabsDialog, { size: 'md', className: 'tabs-dialog' });

async function saveTabs(ctx) {
  const t = tabsDraft;
  if (!t || t.saving || t.status !== 'ready') return;
  t.error = '';
  if (!t.selected.size) { t.error = 'Choose at least one tab.'; ctx.render(); return; }
  if (t.mode === 'new' && !t.name.trim()) { t.error = 'Name the new collection.'; ctx.render(); ctx.nextFrame(() => document.getElementById('tabs-name')?.focus()); return; }
  t.saving = true;
  ctx.render();
  let result;
  try {
    const windowId = await ensureWindowId(ctx);
    const payload = { windowId, tabIds: [...t.selected] };
    if (t.mode === 'new') payload.newCollectionName = t.name.trim(); else payload.collectionId = t.collectionId;
    result = await ctx.chrome('saveTabs', payload);
  } catch (error) {
    t.saving = false;
    t.error = error?.message || 'Could not save the tabs.';
    ctx.render();
    return;
  }
  if (result?.needsPermission) { t.saving = false; t.status = 'permission'; ctx.render(); return; }
  if (result.collectionId) ctx.prefs.touchCollection(result.collectionId);
  if (tabsDraft === t) { tabsDraft = null; ctx.closeDialog('add.tabs'); }
  const where = result.collectionFallback ? 'Inbox' : t.mode === 'new' ? t.name.trim() : collectionLabel(ctx, result.collectionId);
  const skipped = result.skipped ? `. ${plural(result.skipped, 'tab')} skipped` : '';
  ctx.toast(`Saved ${plural(result.saved || 0, 'tab')} to ${where}${skipped}`, { tone: result.saved ? 'success' : 'warning',
    action: result.collectionId ? { label: 'Open', run: () => ctx.navigate(`collection:${result.collectionId}`) } : null });
}

/* ------------------------------------------------------------------ capture menu + screenshots */

const capturePending = ctx => PENDING_CAPTURE.has(ctx.state.capture?.status);

/** Menu of every way to add: links, uploads, the current page, screenshots, tabs. */
export function openCaptureMenu(ctx, anchor, options = {}) {
  const page = ctx.env.isExtension && ctx.env.isSidepanel;
  const hint = page ? '' : 'Side panel';
  ctx.openMenu(anchor, [
    { label: 'Add link…', icon: 'link', run: () => openAdd(ctx, {}) },
    { label: 'Upload files…', icon: 'upload', action: 'add.upload' },
    { separator: true },
    { label: 'Save page', icon: 'bookmark-plus', action: 'add.save-page', disabled: !page, hint },
    { label: 'Save with note…', icon: 'notebook-pen', action: 'add.save-with-note', disabled: !page, hint },
    { label: 'Screenshot visible area', icon: 'camera', action: 'add.screenshot', disabled: !page, hint },
    { label: 'Full-page screenshot', icon: 'scan', action: 'add.full-page', disabled: !page || capturePending(ctx), hint },
    { label: 'Highlight selection', icon: 'highlighter', action: 'add.highlight-tip' },
    { separator: true },
    { label: 'Save all tabs…', icon: 'layers', action: 'add.save-tabs', disabled: !ctx.env.isExtension, hint: ctx.env.isExtension ? '' : 'Extension' },
  ], { placement: options.placement || 'bottom-end', label: 'Add' });
}

const CAPTURE_LABELS = { preparing: 'Preparing full-page screenshot', stitching: 'Stitching sections', saving: 'Saving screenshot',
  saved: 'Full-page screenshot saved', cancelled: 'Screenshot cancelled', error: 'Screenshot failed' };

/** Progress row for a full-page capture (ctx.state.capture); '' when idle. */
export function renderCaptureProgress(ctx) {
  const job = ctx.state.capture;
  if (!job?.status) return '';
  const pending = PENDING_CAPTURE.has(job.status);
  const total = Number(job.total) || 0;
  const done = Math.min(Number(job.completed) || 0, total);
  const label = job.status === 'capturing' ? (total ? `Capturing section ${Math.min(done + 1, total)} of ${total}` : 'Capturing the page') : CAPTURE_LABELS[job.status] || 'Working';
  const detail = job.status === 'saved' && job.width ? `${job.width.toLocaleString()} × ${Number(job.height || 0).toLocaleString()} px` : job.status === 'error' ? job.message : '';
  const percent = total ? Math.round((done / total) * 100) : null;
  return html`<div class="capture-progress" data-status="${job.status}" data-key="capture-progress" role="status" aria-live="polite">
    <span class="capture-progress-icon" aria-hidden="true">${icon(pending ? 'scan' : job.status === 'saved' ? 'circle-check' : job.status === 'error' ? 'circle-alert' : 'circle-x', { size: 16 })}</span>
    <span class="capture-progress-text"><span class="capture-progress-label">${label}</span>${detail ? html`<span class="capture-progress-detail">${detail}</span>` : ''}
      ${pending ? html`<progress class="capture-progress-bar" max="100" ${percent != null ? html`value="${percent}"` : ''} aria-label="Screenshot progress"></progress>` : ''}</span>
    ${pending
      ? button({ label: job.cancelRequested ? 'Cancelling…' : 'Cancel', variant: 'ghost', size: 'sm', action: 'add.capture-cancel', disabled: job.cancelRequested || job.status === 'saving' })
      : html`${job.status === 'saved' && job.itemId ? button({ label: 'Open', variant: 'secondary', size: 'sm', action: 'add.capture-view' }) : ''}
        ${iconButton({ icon: 'x', label: 'Dismiss', action: 'add.capture-dismiss', size: 'sm' })}`}
  </div>`;
}

// Chrome grants screenshots of a page only after the user invokes the extension on it (activeTab).
const friendlyCaptureError = error => /all_urls|activeTab|cannot access|not allowed/i.test(error?.message || '')
  ? new Error('Chrome needs you to click the Still button in the toolbar on this page first. Then try again.')
  : error;

async function captureVisible(ctx) {
  const windowId = await ensureWindowId(ctx);
  const item = await ctx.chrome('captureScreenshot', { windowId }).catch(error => { throw friendlyCaptureError(error); });
  ctx.toast('Screenshot saved', { tone: 'success', action: item?.id ? { label: 'Open', run: () => ctx.openItem(item.id) } : null });
}

async function captureFull(ctx) {
  if (capturePending(ctx)) return;
  const jobId = globalThis.crypto?.randomUUID?.() || `job-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  ctx.state.capture = { jobId, status: 'preparing', completed: 0, total: 0 };
  ctx.render();
  try {
    const windowId = await ensureWindowId(ctx);
    const result = await ctx.chrome('captureFullPage', { jobId, windowId });
    ctx.state.capture = { ...ctx.state.capture, jobId, status: 'saved', itemId: result?.id || result?.item?.id || '', width: result?.width, height: result?.height };
    ctx.toast('Full-page screenshot saved', { tone: 'success', action: ctx.state.capture.itemId ? { label: 'Open', run: () => ctx.openItem(ctx.state.capture.itemId) } : null });
  } catch (error) {
    const cancelled = ctx.state.capture?.cancelRequested || /cancel/i.test(error?.message || '');
    ctx.state.capture = { ...ctx.state.capture, jobId, status: cancelled ? 'cancelled' : 'error', message: cancelled ? '' : friendlyCaptureError(error)?.message || 'Try again.' };
  }
  ctx.render();
}

/* ------------------------------------------------------------------ actions */

let uploadArmed = false;

registerActions({
  'add.open': ({ ctx, data }) => openAdd(ctx, {
    ...(typeof data.collectionId === 'string' ? { collectionId: data.collectionId } : {}),
    ...(data.url ? { url: data.url } : {}), ...(data.type ? { type: data.type } : {}), ...(data.source ? { source: data.source } : {}),
  }),
  // Keyboard quick add: the focused element's data-* must not leak into the prefill.
  'add.quick': ({ ctx }) => openAdd(ctx, {}),
  'add.upload': ({ ctx }) => {
    const input = document.getElementById('file-input');
    if (!input) { openAdd(ctx, { type: 'file' }); return; }
    uploadArmed = true;
    input.value = '';
    input.click();
  },
  'add.save-tabs': ({ ctx, data }) => openSaveTabs(ctx, typeof data.collectionId === 'string' ? { collectionId: data.collectionId } : {}),
  'add.capture-menu': ({ ctx, el }) => openCaptureMenu(ctx, el),
  'add.save-page': ({ ctx }) => saveCurrentTab(ctx, {}),
  'add.save-with-note': ({ ctx }) => openAddForPage(ctx),
  'add.screenshot': ({ ctx }) => captureVisible(ctx),
  'add.full-page': ({ ctx }) => captureFull(ctx),
  'add.capture-cancel': async ({ ctx }) => {
    const job = ctx.state.capture;
    if (!job?.jobId || !PENDING_CAPTURE.has(job.status)) return;
    job.cancelRequested = true;
    ctx.render();
    await ctx.chrome('cancelFullPageCapture', { jobId: job.jobId });
  },
  'add.capture-view': ({ ctx }) => { const id = ctx.state.capture?.itemId; ctx.state.capture = null; if (id) ctx.openItem(id); else ctx.render(); },
  'add.capture-dismiss': ({ ctx }) => { ctx.state.capture = null; ctx.render(); },
  'add.highlight-tip': ({ ctx }) => ctx.toast('Select text on the page, then right-click and choose Highlight selection in Still.', { duration: 7000 }),

  'add.type': ({ ctx, data, event }) => {
    const d = draft;
    if (!d || !TYPE_OPTIONS.some(o => o.value === data.value) || d.type === data.value) return;
    d.type = data.value;
    d.error = '';
    if (d.type === 'link') d.urlFirst = !validUrl(d.url);
    ctx.render();
    // Arrow keys move through the options (overlay.js clicks them with detail 0); keep focus there.
    if (!event?.detail) return;
    const focusId = d.type === 'link' ? (d.urlFirst ? 'add-url' : 'add-title') : d.type === 'note' ? (d.title ? 'add-note' : 'add-note-title') : 'add-choose-files';
    ctx.nextFrame(() => document.getElementById(focusId)?.focus());
  },
  'add.favorite': ({ ctx }) => { if (!draft) return; draft.favorite = !draft.favorite; ctx.render(); },
  'add.reminder': ({ ctx, el }) => {
    const d = draft;
    if (!d) return;
    ctx.openPopover('pick.reminder', el, { value: d.reminderAt, onPick: iso => { if (draft === d) { d.reminderAt = iso; ctx.render(); } } }, { placement: 'bottom-end' });
  },
  'add.clear-reminder': ({ ctx }) => { if (!draft) return; draft.reminderAt = null; ctx.render(); },
  'add.field': ({ el }) => {
    const d = draft;
    const key = el.dataset.field;
    if (!d || !['title', 'excerpt', 'note'].includes(key)) return;
    d[key] = el.value;
    d.touched.add(key);
  },
  'add.url': ({ ctx, el }) => {
    const d = draft;
    if (!d) return;
    const changed = validUrl(el.value) !== validUrl(d.url);
    d.url = el.value;
    d.urlError = '';
    if (changed) {
      d.updateId = '';
      d.articleContent = '';
      if (!d.touched.has('cover') && d.meta.status === 'done') d.cover = '';
      d.meta = { status: 'idle', forUrl: '' };
      if (validUrl(d.url)) scheduleMeta(ctx);
    }
    ctx.render();
  },
  'add.url-key': ({ ctx, event }) => {
    const d = draft;
    if (!d || event.key !== 'Enter' || event.metaKey || event.ctrlKey || !d.urlFirst) return;
    event.preventDefault();
    if (!validUrl(d.url)) { d.urlError = 'Enter a full web address, for example https://example.com.'; ctx.render(); return; }
    scheduleMeta(ctx, 0);
    ctx.nextFrame(() => document.getElementById('add-note')?.focus());
  },
  'add.meta-allow': ({ ctx, data }) => {
    const origin = data.origin;
    if (!origin) return;
    const pending = requestPermission({ origins: [origin] });
    return pending.then(granted => {
      if (granted) return loadMeta(ctx, { force: true });
      ctx.toast('Still cannot read this site. You can still save the link.');
    });
  },
  'add.set-collection': ({ data }) => { if (!draft) return; draft.collectionId = data.value || ''; draft.touched.add('collection'); },
  'add.use-suggested-collection': ({ ctx }) => {
    if (!draft?.suggest.collectionId) return;
    draft.collectionId = draft.suggest.collectionId;
    draft.touched.add('collection');
    ctx.render();
  },
  'add.set-tags': ({ data }) => { if (!draft) return; draft.tags = Array.isArray(data.tags) ? data.tags : splitTags(data.value); draft.touched.add('tags'); },
  'add.open-existing': ({ ctx, data }) => { draft = null; ctx.closeDialog('add.item'); ctx.openItem(data.id); },
  'add.update-existing': ({ ctx, data }) => {
    const d = draft;
    const item = ctx.select.byId(data.id);
    if (!d || !item) return;
    editExisting(d, item);
    ctx.render();
    ctx.nextFrame(() => document.getElementById('add-note')?.focus());
  },
  'add.unlink-page': ({ ctx }) => { if (!draft) return; draft.url = ''; ctx.render(); },
  'add.cover-menu': ({ ctx, el }) => {
    const d = draft;
    if (!d) return;
    ctx.openMenu(el, [
      { label: 'Upload image…', icon: 'upload', run: () => chooseCoverFile(ctx, d) },
      { label: 'Use image link…', icon: 'link', run: () => coverFromLink(ctx, d) },
      ...(d.cover ? [{ separator: true }, { label: 'Remove cover', icon: 'trash-2', danger: true, run: () => { d.cover = ''; d.touched.add('cover'); ctx.render(); } }] : []),
    ], { label: 'Cover' });
  },
  'add.choose-files': () => { document.getElementById('add-file-input')?.click(); },
  'add.files-picked': ({ ctx, el }) => { const files = [...(el.files || [])]; el.value = ''; addFiles(ctx, files); },
  'add.remove-file': ({ ctx, data }) => {
    if (!draft) return;
    draft.files = draft.files.filter(entry => entry.id !== data.id);
    ctx.render();
    ctx.nextFrame(() => document.getElementById('add-choose-files')?.focus());
  },
  'add.save': ({ ctx }) => saveDraft(ctx),

  'add.tabs-allow': ({ ctx }) => {
    const pending = requestPermission({ permissions: ['tabs'] });
    return pending.then(granted => {
      if (granted) return loadTabs(ctx);
      ctx.toast('Chrome did not allow access to your tabs. Allow it to save them all at once.', { tone: 'warning' });
    });
  },
  'add.tabs-reload': ({ ctx }) => loadTabs(ctx),
  'add.tabs-mode': ({ ctx, data }) => {
    if (!tabsDraft || !['new', 'existing'].includes(data.value)) return;
    tabsDraft.mode = data.value;
    tabsDraft.error = '';
    ctx.render();
    ctx.nextFrame(() => document.getElementById(data.value === 'new' ? 'tabs-name' : 'tabs-collection')?.focus());
  },
  'add.tabs-name': ({ el }) => { if (tabsDraft) tabsDraft.name = el.value; },
  'add.tabs-collection': ({ data }) => { if (tabsDraft) tabsDraft.collectionId = data.value || ''; },
  'add.tabs-toggle': ({ ctx, el, data }) => {
    const t = tabsDraft;
    const id = Number(data.tabId);
    if (!t || !Number.isInteger(id)) return;
    if (el.checked) t.selected.add(id); else t.selected.delete(id);
    ctx.render();
  },
  'add.tabs-all': ({ ctx }) => {
    const t = tabsDraft;
    if (!t) return;
    t.selected = t.selected.size === t.tabs.length ? new Set() : new Set(t.tabs.map(tab => tab.tabId));
    ctx.render();
  },
  'add.tabs-save': ({ ctx }) => saveTabs(ctx),
});

function chooseCoverFile(ctx, d) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/avif';
  input.addEventListener('change', () => ctx.run(async () => {
    const file = input.files?.[0];
    if (!file || draft !== d) return;
    if (file.size > 20 * 1024 * 1024) throw new Error('Choose an image under 20 MB.');
    d.cover = await imageThumbnail(file);
    d.touched.add('cover');
    ctx.render();
  }), { once: true });
  input.click();
}

async function coverFromLink(ctx, d) {
  const value = await ctx.prompt({ title: 'Cover image', label: 'Image link', value: /^https?:/i.test(d.cover) ? d.cover : '', placeholder: 'https://', confirmLabel: 'Use image' });
  if (value == null || draft !== d) return;
  const url = detectUrl(value);
  if (value.trim() && !url) { ctx.toast('Enter an image link that starts with https://', { tone: 'danger' }); return; }
  d.cover = url;
  d.touched.add('cover');
  ctx.render();
}

registerShortcuts([
  { keys: 'mod+shift+s', action: 'add.quick', label: 'Quick add' },
  { keys: 'mod+enter', action: 'add.save', label: 'Save in the Add dialog', allowInInputs: true, when: ctx => ctx.state.dialogs.at(-1)?.name === 'add.item' },
  { keys: 'mod+enter', action: 'add.tabs-save', allowInInputs: true, when: ctx => ctx.state.dialogs.at(-1)?.name === 'add.tabs' },
]);

/* ------------------------------------------------------------------ init: paste, uploads, drops, menu requests */

const editableTarget = target => target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-mount]');

/** Merges the recent collections the service worker stored (context-menu saves) into device prefs. */
async function syncRecentCollections(ctx) {
  try {
    const stored = (await globalThis.chrome?.storage?.local?.get?.('still.ui.recent.v1'))?.['still.ui.recent.v1'];
    const fromWorker = Array.isArray(stored?.recentCollections) ? stored.recentCollections.filter(id => typeof id === 'string' && id) : [];
    const mine = ctx.prefs.get('recentCollections', []) || [];
    const merged = [...new Set([...fromWorker, ...mine])].slice(0, 12);
    if (merged.join('|') !== mine.join('|')) { ctx.prefs.set('recentCollections', merged); ctx.render(); }
  } catch { /* Preview mode or storage unavailable. */ }
}

export async function init(ctx) {
  document.addEventListener('paste', event => {
    if (event.defaultPrevented || editableTarget(event.target) || ctx.state.popover) return;
    const top = ctx.state.dialogs.at(-1);
    if (top && top.name !== 'add.item') return;
    const files = [...(event.clipboardData?.files || [])];
    const url = detectUrl(event.clipboardData?.getData('text/plain') || '');
    if (!files.length && !url) return;
    event.preventDefault();
    if (files.length) openAdd(ctx, { type: 'file', files, source: 'paste' });
    else openAdd(ctx, { url, source: 'paste' });
  });

  const fileInput = document.getElementById('file-input');
  fileInput?.addEventListener('change', () => {
    if (!uploadArmed) return;
    uploadArmed = false;
    const files = [...(fileInput.files || [])];
    fileInput.value = '';
    if (files.length) openAdd(ctx, { type: 'file', files, source: 'upload' });
  });
  fileInput?.addEventListener('cancel', () => { uploadArmed = false; });

  // Drops onto the Add dialog's drop zone are handled here (capture phase) so app-wide drop handlers stay out of it.
  // Image errors do not bubble; catch a failed cover in the capture phase and show the fallback tile.
  document.addEventListener('error', event => {
    const img = event.target;
    if (!draft || img?.tagName !== 'IMG' || !img.closest?.('.add-cover')) return;
    draft.coverFailed = draft.cover;
    ctx.render();
  }, true);

  const zone = event => event.target?.closest?.('[data-add-drop]');
  const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragover', event => {
    if (!zone(event) || !hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    if (draft && !draft.dragging) { draft.dragging = true; ctx.render(); }
  }, true);
  document.addEventListener('dragleave', event => {
    if (!draft?.dragging || event.relatedTarget?.closest?.('[data-add-drop]')) return;
    draft.dragging = false;
    ctx.render();
  }, true);
  document.addEventListener('drop', event => {
    if (!zone(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (draft) draft.dragging = false;
    addFiles(ctx, event.dataTransfer?.files);
    ctx.render();
  }, true);

  if (!ctx.env.isExtension) return;
  await ensureWindowId(ctx);
  syncRecentCollections(ctx);
  globalThis.chrome?.storage?.onChanged?.addListener?.((changes, area) => {
    if (area === 'local' && changes['still.ui.recent.v1']) syncRecentCollections(ctx);
  });

  // "Save page to › Choose collection…" in the context menu opens the side panel and asks it to open Add.
  const seen = new Set();
  globalThis.chrome?.runtime?.onMessage?.addListener?.((message, sender, sendResponse) => {
    if (message?.type !== 'still:open-add' || !ctx.env.isSidepanel) return;
    if (sender?.id && sender.id !== globalThis.chrome.runtime.id) return;
    if (Number.isInteger(message.windowId) && Number.isInteger(ctx.state.windowId) && message.windowId !== ctx.state.windowId) return;
    sendResponse({ ok: true });
    if (message.requestId) {
      if (seen.has(message.requestId)) return;
      seen.add(message.requestId);
    }
    const payload = message.payload || {};
    openAdd(ctx, { url: payload.url, title: payload.title, kind: payload.kind, sourceUrl: payload.sourceUrl,
      source: payload.kind === 'page' ? 'tab' : 'menu', ...(payload.kind === 'image' ? { type: 'image', cover: payload.url } : {}) });
  });
}
