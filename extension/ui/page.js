// Side panel "This page": tracks the active browser tab, saves it into a collection in one click, and shows what the
// library knows about it (notes, highlights, related items) with a shortcut into Ask.
import { html, cx } from './html.js';
import { icon } from './icons.js';
import { button, iconButton, collectionIcon, domainOf, relativeDate, shortDate, emptyState, skeleton, spinner, cover, highlightColor, TYPE_LABELS, TYPE_ICONS } from './components.js';
import { registerActions } from './runtime.js';
import { renderTagInput, openCollectionPicker } from './pickers.js';
import { openAdd, ensureWindowId, requestPermission, defaultCollectionId, collectionLabel, saveCurrentTab, renderCaptureProgress } from './quick-add.js';
import { renderPageNotes, createNote } from './notes.js';
import { confirmTrash } from './note-editor.js';
import { askAi } from './ai-panel.js';
import { canonicalUrl } from '../lib/store.js';

/* ------------------------------------------------------------------ pure helpers */

export const isWebUrl = url => /^https?:\/\/[^/\s]/i.test(String(url || ''));
const canonical = url => { try { return url ? canonicalUrl(url) : ''; } catch { return ''; } };
const STOP_WORDS = new Set(('the and for with from that this your you are was were have has had not but can will what when where which who how why into onto over under about after '
  + 'before than then them they their there here its it our out all any some more most less very just also only use using used new one two how-to guide blog post page home '
  + 'www com org net http https').split(' '));

/** Lowercase content words (3+ letters, no stop words) from a title or excerpt, de-duplicated. */
export function contentWords(text) {
  const words = String(text ?? '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || [];
  return [...new Set(words.map(word => word.replace(/['-]+$/g, '')).filter(word => word.length >= 3 && !STOP_WORDS.has(word)))];
}

/**
 * Library items related to a page without an embeddings index: same site (+2) and shared title/description words (+1 each).
 * Excludes items saved at the same address and ids in `exclude`. Needs a score of 2 or more.
 */
export function relatedLexical(items = [], page = {}, { limit = 5, exclude = [] } = {}) {
  const domain = domainOf(page.url);
  const words = contentWords(`${page.title || ''} ${page.excerpt || ''}`);
  const skip = new Set(exclude);
  const self = canonical(page.url);
  const scored = [];
  for (const item of items) {
    if (!item || item.deletedAt || item.archived || skip.has(item.id) || (self && item.url && canonical(item.url) === self)) continue;
    const haystack = new Set(contentWords([item.title, item.excerpt, ...(item.tags || [])].join(' ')));
    let score = domain && domainOf(item.url) === domain ? 2 : 0;
    for (const word of words) if (haystack.has(word)) score += 1;
    if (score >= 2) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || String(b.item.updatedAt).localeCompare(String(a.item.updatedAt)));
  return scored.slice(0, limit).map(entry => entry.item);
}

/* ------------------------------------------------------------------ active tab tracking */

const pageState = { loading: false, error: '', saving: false };
const relatedCache = new Map();
let refreshTimer = 0;
let askDraft = '';

function applyTab(ctx, tab) {
  if (!tab) return;
  const previous = ctx.state.page;
  ctx.state.page = {
    tabId: tab.tabId ?? null, windowId: tab.windowId ?? ctx.state.windowId ?? null, url: tab.url || '', title: tab.title || '',
    favIconUrl: tab.favIconUrl || '', saved: tab.saved === true, itemId: tab.itemId || '', granted: tab.granted !== false,
  };
  pageState.loading = false;
  pageState.error = '';
  if (previous?.url !== ctx.state.page.url) askDraft = '';
  ctx.render();
}

let refreshSeq = 0;
async function refreshPage(ctx) {
  if (!ctx.env.isExtension) return;
  // Quick tab switches overlap requests; only the latest answer may update the page.
  const seq = ++refreshSeq;
  try {
    const windowId = await ensureWindowId(ctx);
    const tab = await ctx.chrome('getActiveTab', { windowId });
    if (seq === refreshSeq) applyTab(ctx, tab);
  } catch (error) {
    if (seq !== refreshSeq) return;
    pageState.loading = false;
    pageState.error = error?.message || 'Still could not read the current tab.';
    ctx.render();
  }
}

function scheduleRefresh(ctx, delay = 150) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshPage(ctx), delay);
}

function demoPage(ctx) {
  const params = new URLSearchParams(location.search);
  const wanted = params.get('pageUrl');
  const seed = ctx.select.byId('effective-agents') || ctx.select.live().find(item => isWebUrl(item.url));
  const url = wanted && isWebUrl(wanted) ? wanted : seed?.url || 'https://www.anthropic.com/engineering/building-effective-agents';
  const known = ctx.select.savedForUrl(url);
  return { tabId: null, windowId: null, url, title: params.get('pageTitle') || known?.title || domainOf(url), favIconUrl: '', saved: !!known, itemId: known?.id || '', granted: true, demo: true };
}

export async function init(ctx) {
  if (!ctx.env.isSidepanel) return;
  if (!ctx.env.isExtension) { ctx.state.page = demoPage(ctx); ctx.render(); return; }
  const api = globalThis.chrome;
  pageState.loading = true;
  await ensureWindowId(ctx);
  refreshPage(ctx);
  addEventListener('focus', () => scheduleRefresh(ctx));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleRefresh(ctx); });
  api.tabs?.onActivated?.addListener?.(info => { if (!Number.isInteger(ctx.state.windowId) || info?.windowId === ctx.state.windowId) scheduleRefresh(ctx); });
  api.tabs?.onUpdated?.addListener?.((tabId, change) => {
    if (tabId === ctx.state.page?.tabId && ('url' in change || 'title' in change || change.status === 'complete')) scheduleRefresh(ctx, 250);
  });
  api.permissions?.onAdded?.addListener?.(() => scheduleRefresh(ctx, 0));
  api.permissions?.onRemoved?.addListener?.(() => scheduleRefresh(ctx, 0));
  api.runtime?.onMessage?.addListener?.((message, sender) => {
    if (message?.type !== 'still:active-tab' || !message.tab || (sender?.id && sender.id !== api.runtime.id)) return;
    if (Number.isInteger(ctx.state.windowId) && message.tab.windowId !== ctx.state.windowId) return;
    applyTab(ctx, { ...message.tab, granted: true });
  });
}

/* ------------------------------------------------------------------ saving */

async function savePage(ctx, collectionId) {
  const page = ctx.state.page;
  if (!page?.url || pageState.saving) return null;
  pageState.saving = true;
  ctx.render();
  try {
    if (ctx.env.isExtension && !page.demo) return await saveCurrentTab(ctx, { collectionId });
    const before = ctx.select.savedForUrl(page.url);
    const item = await ctx.store.saveItem({ url: page.url, title: page.title, collectionId });
    ctx.prefs.touchCollection(collectionId);
    const where = collectionLabel(ctx, item.collectionId);
    ctx.toast(before ? `Already saved in ${where}` : `Saved to ${where}`, { tone: 'success',
      action: before ? { label: 'Open', run: () => ctx.openItem(item.id) } : { label: 'Undo', run: () => ctx.store.deleteItem(item.id) } });
    return item;
  } finally {
    pageState.saving = false;
    ctx.render();
  }
}

const savedItem = ctx => (ctx.state.page?.url ? ctx.select.savedForUrl(ctx.state.page.url) : null);

async function newPageNote(ctx) {
  const page = ctx.state.page;
  const item = savedItem(ctx);
  const title = `Notes on ${page?.title || domainOf(page?.url) || 'this page'}`;
  const collectionId = item?.collectionId ?? defaultCollectionId(ctx);
  const note = await createNote(ctx, { title, content: '', url: page?.url || '', collectionId, relatedIds: item ? [item.id] : [], open: true });
  if (!note) openAdd(ctx, { type: 'note', title, url: page?.url || '', collectionId });
}

/* ------------------------------------------------------------------ view */

const sectionHead = (id, title, count, trailing = '') => html`<div class="page-section-head">
  <h2 class="page-section-title" id="${id}">${title}</h2>${count ? html`<span class="page-section-count">${count}</span>` : ''}<span class="page-spacer"></span>${trailing}</div>`;

function renderSaveBar(ctx, page) {
  const target = defaultCollectionId(ctx);
  const label = collectionLabel(ctx, target);
  const extension = ctx.env.isExtension && !page.demo;
  const busy = ['preparing', 'capturing', 'stitching', 'saving'].includes(ctx.state.capture?.status);
  const open = ctx.state.popover?.name === 'pick.collection' && ctx.state.popover.props?.pickerKey === 'page-save';
  // Alt+Shift+S (the browser command) saves to the settings default; only advertise it when it saves to the same place.
  const setting = ctx.library?.settings?.defaultCollectionId;
  const sameAsCommand = target === (setting && ctx.select.collection(setting) ? setting : '');
  return html`<div class="page-save-bar">
    <div class="split-btn split-btn-primary page-split" role="group" aria-label="Save this page">
      <button type="button" class="${cx('btn', 'btn-primary', 'split-btn-main', 'page-save-main', pageState.saving && 'is-loading')}" data-action="page.save"
        ${sameAsCommand ? html`aria-keyshortcuts="Alt+Shift+S"` : ''} data-tooltip="Save to ${label}${sameAsCommand ? ' (Alt+Shift+S)' : ''}" ${pageState.saving ? html`aria-busy="true" aria-disabled="true"` : ''}>
        ${icon('bookmark', { size: 16 })}<span class="btn-label">Save to ${label}</span>${pageState.saving ? spinner({ size: 14 }) : ''}</button>
      <button type="button" class="btn btn-primary split-btn-menu" aria-label="Save to another collection" aria-haspopup="listbox" aria-expanded="${open ? 'true' : 'false'}"
        data-tooltip="Choose collection" data-action="page.save-menu">${icon('chevron-down', { size: 14 })}</button>
    </div>
    ${iconButton({ icon: 'notebook-pen', label: 'Save with note', action: 'add.save-with-note', variant: 'secondary' })}
    ${iconButton({ icon: 'camera', label: extension ? 'Screenshot' : 'Screenshot (extension only)', action: 'add.screenshot', variant: 'secondary', disabled: !extension })}
    ${iconButton({ icon: 'scan', label: extension ? 'Full-page screenshot' : 'Full-page screenshot (extension only)', action: 'add.full-page', variant: 'secondary', disabled: !extension || busy })}
  </div>`;
}

function renderSaved(ctx, page, item) {
  const collection = ctx.select.collection(item.collectionId);
  const path = collection ? ctx.select.path(collection.id).map(c => c.name).join(' / ') : 'Inbox';
  const extension = ctx.env.isExtension && !page.demo;
  const busy = ['preparing', 'capturing', 'stitching', 'saving'].includes(ctx.state.capture?.status);
  const open = ctx.state.popover?.name === 'pick.collection' && ctx.state.popover.props?.pickerKey === 'page-move';
  return html`<div class="page-saved-bar">
      <button type="button" class="page-saved-main" data-action="page.move" aria-haspopup="listbox" aria-expanded="${open ? 'true' : 'false'}"
        aria-label="Saved in ${path}. Move to another collection" data-tooltip="Move to another collection">
        <span class="page-saved-check" aria-hidden="true">${icon('check', { size: 12, strokeWidth: 2.5 })}</span><span class="page-saved-label">Saved in</span>
        ${collectionIcon(collection, { size: 16 })}<span class="page-saved-path">${path}</span>${icon('chevron-down', { size: 14, className: 'page-saved-chevron' })}
      </button>
      ${iconButton({ icon: 'star', label: item.favorite ? 'Remove from favorites' : 'Add to favorites', action: 'page.favorite', pressed: item.favorite === true, variant: 'secondary', className: 'page-star' })}
      ${iconButton({ icon: 'panel-right', label: 'Open details', action: 'page.open-item', variant: 'secondary' })}
      ${iconButton({ icon: 'trash-2', label: 'Remove from library', action: 'page.remove', variant: 'secondary', className: 'page-remove' })}
    </div>
    <div class="page-tags">${renderTagInput({ ctx, id: 'page-tags', tags: item.tags || [], action: 'page.set-tags', placeholder: 'Add tags', label: 'Tags for this page' })}</div>
    <div class="page-quick">
      ${button({ label: 'Edit details', icon: 'pencil', variant: 'ghost', size: 'sm', action: 'page.edit' })}
      ${button({ label: 'Screenshot', icon: 'camera', variant: 'ghost', size: 'sm', action: 'add.screenshot', disabled: !extension })}
      ${button({ label: 'Full page', icon: 'scan', variant: 'ghost', size: 'sm', action: 'add.full-page', disabled: !extension || busy })}
    </div>`;
}

function renderNotesSection(ctx, page) {
  const notes = ctx.select.notesForUrl(page.url);
  let body = '';
  try { body = renderPageNotes(ctx, page.url); } catch (error) { console.error('[still] page notes', error); }
  const own = String(body ?? '').trim();
  const fallback = notes.length
    ? html`<div class="page-note-list">${notes.slice(0, 4).map(note => html`<button type="button" class="page-note-row" data-action="app.open-item" data-id="${note.id}" data-key="note:${note.id}">
        <span class="page-note-title">${note.title || 'Untitled note'}</span>${note.excerpt ? html`<span class="page-note-excerpt">${note.excerpt}</span>` : ''}
        <span class="page-note-meta">${relativeDate(note.updatedAt)}</span></button>`)}</div>`
    : html`<button type="button" class="page-note-empty" data-action="page.new-note">${icon('pen-line', { size: 16 })}<span>Write a note about this page</span></button>`;
  return html`<section class="page-section" aria-labelledby="page-notes-title">
    ${sectionHead('page-notes-title', 'Notes on this page', notes.length, button({ label: 'New note', icon: 'plus', variant: 'ghost', size: 'sm', action: 'page.new-note' }))}
    ${own ? body : fallback}
  </section>`;
}

function renderHighlights(ctx, item) {
  const list = item?.highlights || [];
  const shown = list.slice(-3).reverse();
  return html`<section class="page-section" aria-labelledby="page-hl-title">
    ${sectionHead('page-hl-title', 'Highlights', list.length, list.length > 3 ? button({ label: 'Show all', variant: 'link', size: 'sm', action: 'page.open-item' }) : '')}
    ${list.length ? html`<div class="page-hl-card">${shown.map(highlight => html`<figure class="page-hl" data-key="hl:${highlight.id}">
        <blockquote class="page-hl-quote"><mark class="hl" data-color="${highlightColor(highlight.color)}">${highlight.text}</mark></blockquote>
        <figcaption class="page-hl-meta">${highlight.note ? html`${icon('message-square', { size: 12 })}<span class="page-hl-note">${highlight.note}</span><span aria-hidden="true">·</span>` : ''}<span>${relativeDate(highlight.createdAt) || shortDate(highlight.createdAt)}</span></figcaption>
      </figure>`)}</div>`
      : html`<p class="page-tip">${icon('highlighter', { size: 14 })}<span>Select text on the page, right-click, then choose Highlight selection in Still.</span></p>`}
  </section>`;
}

function queueRelated(ctx, page, item) {
  const key = canonical(page.url);
  if (!key || relatedCache.has(key)) return;
  relatedCache.set(key, { status: 'loading', ids: [] });
  while (relatedCache.size > 40) relatedCache.delete(relatedCache.keys().next().value);
  setTimeout(async () => {
    let ids = [];
    const excerpt = item?.excerpt || '';
    try {
      // Semantic neighbours when the embeddings index has content; otherwise the stricter local match below.
      const index = ctx.ai?.getIndexStatus?.();
      if (ctx.ai?.searchLibrary && index?.enabled && index.indexed > 0) {
        const query = [page.title, excerpt].filter(Boolean).join('. ').slice(0, 600);
        if (query.trim()) ids = (await ctx.ai.searchLibrary(query, { mode: 'hybrid', limit: 12 }) || []).map(hit => hit.id);
      }
    } catch (error) { console.warn('[still] related search', error); }
    if (!ids.length) ids = relatedLexical(ctx.select.live(), { url: page.url, title: page.title, excerpt }, { limit: 12 }).map(entry => entry.id);
    relatedCache.set(key, { status: 'done', ids });
    ctx.render();
  }, 0);
}

function relatedThumb(ctx, item) {
  const collection = ctx.select.collection(item.collectionId);
  const glyph = item.type === 'note' ? 'sticky-note' : item.url ? '' : TYPE_ICONS[item.type] || 'file';
  return cover(item.cover, { className: 'page-related-thumb', color: item.type === 'note' ? 'yellow' : collection?.color || 'gray',
    icon: glyph || undefined, letter: glyph ? '' : domainOf(item.url) });
}

function renderRelated(ctx, page, item) {
  const key = canonical(page.url);
  if (!key) return '';
  const entry = relatedCache.get(key);
  if (!entry) queueRelated(ctx, page, item);
  const skip = new Set([item?.id, ...ctx.select.notesForUrl(page.url).map(note => note.id)].filter(Boolean));
  const rows = (entry?.ids || []).map(id => ctx.select.byId(id))
    .filter(row => row && !row.deletedAt && !row.archived && !skip.has(row.id) && !(row.url && canonical(row.url) === key)).slice(0, 5);
  if (entry?.status === 'done' && !rows.length) return '';
  return html`<section class="page-section" aria-labelledby="page-related-title" aria-busy="${entry?.status === 'done' ? 'false' : 'true'}">
    ${sectionHead('page-related-title', 'Related in your library', rows.length)}
    ${entry?.status === 'done' ? html`<div class="page-related">${rows.map(row => html`<button type="button" class="page-related-row" data-action="app.open-item" data-id="${row.id}" data-key="rel:${row.id}">
        ${relatedThumb(ctx, row)}<span class="page-related-text"><span class="page-related-title">${row.title}</span>
        <span class="page-related-meta">${row.type === 'note' ? 'Note' : domainOf(row.url) || TYPE_LABELS[row.type] || 'Item'}<span aria-hidden="true"> · </span>${collectionLabel(ctx, row.collectionId)}</span></span>
      </button>`)}</div>` : skeleton({ rows: 3, variant: 'row', className: 'page-related-skeleton' })}
  </section>`;
}

function renderAsk() {
  return html`<form class="page-ask" data-submit="page.ask" aria-label="Ask about this page">
    ${icon('sparkles', { size: 16, className: 'page-ask-icon' })}
    <input class="page-ask-input" id="page-ask" data-focus-key="page-ask" name="prompt" value="${askDraft}" placeholder="Ask about this page" aria-label="Ask about this page"
      data-input="page.ask-input" autocomplete="off">
    <button type="submit" class="icon-btn icon-btn-sm page-ask-send" aria-label="Ask" data-tooltip="Ask">${icon('arrow-up', { size: 14, strokeWidth: 2.25 })}</button>
  </form>`;
}

function renderRecent(ctx) {
  // The memoized newest-first view, so a render never re-sorts the whole library.
  const recent = [];
  for (const item of ctx.select.itemsForView({ view: 'all', sort: 'newest' })) {
    if (item.type !== 'note' || item.title) recent.push(item);
    if (recent.length === 5) break;
  }
  if (!recent.length) return '';
  return html`<section class="page-section" aria-labelledby="page-recent-title">
    ${sectionHead('page-recent-title', 'Recently saved', 0, button({ label: 'Library', variant: 'link', size: 'sm', action: 'page.open-library' }))}
    <div class="page-related">${recent.map(row => html`<button type="button" class="page-related-row" data-action="app.open-item" data-id="${row.id}" data-key="recent:${row.id}">
      ${relatedThumb(ctx, row)}<span class="page-related-text"><span class="page-related-title">${row.title}</span>
      <span class="page-related-meta">${row.type === 'note' ? 'Note' : domainOf(row.url) || TYPE_LABELS[row.type] || 'Item'}<span aria-hidden="true"> · </span>${relativeDate(row.createdAt)}</span></span>
    </button>`)}</div>
  </section>`;
}

function renderQuickLinks(ctx) {
  return html`<div class="page-quick-grid">
    ${button({ label: 'Add a link', icon: 'link', variant: 'secondary', action: 'add.open' })}
    ${button({ label: 'New note', icon: 'sticky-note', variant: 'secondary', action: 'page.blank-note' })}
    ${button({ label: 'Upload files', icon: 'upload', variant: 'secondary', action: 'add.upload' })}
    ${button({ label: 'Save all tabs', icon: 'layers', variant: 'secondary', action: 'add.save-tabs', disabled: !ctx.env.isExtension })}
  </div>`;
}

/** Side panel "This page" tab. */
export function renderPageTab(ctx) {
  const page = ctx.state.page;
  if (!page) {
    if (pageState.error) {
      return html`<div class="page-tab is-state" data-key="page-tab:error">${emptyState({ icon: 'circle-alert', title: 'Could not read the current tab', body: pageState.error,
        actions: button({ label: 'Try again', variant: 'secondary', size: 'sm', action: 'page.refresh' }) })}${renderQuickLinks(ctx)}</div>`;
    }
    return html`<div class="page-tab" data-key="page-tab:loading" aria-busy="true">${skeleton({ rows: 4, variant: 'row' })}</div>`;
  }
  if (page.granted === false) {
    return html`<div class="page-tab" data-key="page-tab:permission">
      ${renderCaptureProgress(ctx)}
      <div class="page-permission">
        <span class="page-permission-icon" aria-hidden="true">${icon('app-window', { size: 20 })}</span>
        <div class="page-permission-text"><p class="page-permission-title">See the page you are on</p>
          <p class="page-permission-body">Allow Still to read the address and title of your tabs. Then you can save the current page in one click and see your notes for it.</p></div>
        ${button({ label: 'Allow', variant: 'primary', size: 'sm', action: 'page.allow' })}
      </div>
      ${renderQuickLinks(ctx)}${renderRecent(ctx)}</div>`;
  }
  if (!isWebUrl(page.url)) {
    return html`<div class="page-tab is-state" data-key="page-tab:other">
      ${renderCaptureProgress(ctx)}
      ${emptyState({ icon: 'globe', title: 'Nothing to save on this page', compact: true, body: 'Open a website to save it, write notes about it or ask about it. Browser pages like this one cannot be saved.' })}
      ${renderQuickLinks(ctx)}${renderRecent(ctx)}</div>`;
  }
  const item = savedItem(ctx);
  return html`<div class="page-tab" data-key="page-tab:${canonical(page.url)}">
    ${page.demo ? html`<p class="page-demo">${icon('info', { size: 14 })}<span>Preview with a sample page. In Chrome this shows the tab you are on.</span></p>` : ''}
    <section class="page-section page-save" aria-label="Save this page">${item ? renderSaved(ctx, page, item) : renderSaveBar(ctx, page)}${renderCaptureProgress(ctx)}</section>
    ${renderNotesSection(ctx, page)}
    ${renderHighlights(ctx, item)}
    ${renderRelated(ctx, page, item)}
    ${renderAsk()}
  </div>`;
}

/* ------------------------------------------------------------------ actions */

registerActions({
  'page.refresh': ({ ctx }) => { pageState.error = ''; ctx.render(); return refreshPage(ctx); },
  'page.allow': ({ ctx }) => {
    const pending = requestPermission({ permissions: ['tabs'] });
    return pending.then(granted => {
      if (granted) return refreshPage(ctx);
      ctx.toast('Chrome did not allow access to your tabs. You can still add links by pasting them.', { tone: 'warning' });
    });
  },
  'page.save': ({ ctx }) => {
    // Ask for the tab permission inside the click, before any await, when the tab could not be read.
    const pending = ctx.state.page?.granted === false ? requestPermission({ permissions: ['tabs'] }) : null;
    return (async () => {
      if (pending && !(await pending)) return;
      await savePage(ctx, defaultCollectionId(ctx));
    })();
  },
  'page.save-menu': ({ ctx, el }) => openCollectionPicker(ctx, el, {
    value: defaultCollectionId(ctx), title: 'Save to', pickerKey: 'page-save',
    onPick: id => savePage(ctx, id),
  }),
  'page.move': ({ ctx, el }) => {
    const item = savedItem(ctx);
    if (!item) return;
    openCollectionPicker(ctx, el, {
      value: item.collectionId || '', title: 'Move to', pickerKey: 'page-move',
      onPick: async id => {
        const current = ctx.select.byId(item.id);
        if (!current || (current.collectionId || '') === id) return;
        const from = current.collectionId || '';
        await ctx.store.updateItem(current.id, { collectionId: id });
        ctx.prefs.touchCollection(id);
        ctx.toast(`Moved to ${collectionLabel(ctx, id)}`, { tone: 'success', action: { label: 'Undo', run: () => ctx.store.updateItem(current.id, { collectionId: from }) } });
      },
    });
  },
  'page.favorite': async ({ ctx }) => {
    const item = savedItem(ctx);
    if (!item) return;
    await ctx.store.updateItem(item.id, { favorite: !item.favorite });
  },
  'page.set-tags': async ({ ctx, data }) => {
    const item = savedItem(ctx);
    if (!item) return;
    await ctx.store.updateItem(item.id, { tags: Array.isArray(data.tags) ? data.tags : [] });
  },
  'page.open-item': ({ ctx }) => { const item = savedItem(ctx); if (item) ctx.openItem(item.id); },
  'page.edit': ({ ctx }) => {
    const item = savedItem(ctx);
    if (item) openAdd(ctx, { updateId: item.id, url: item.url, source: 'tab' });
  },
  'page.remove': async ({ ctx }) => {
    const item = savedItem(ctx);
    if (!item || !(await confirmTrash(ctx, [item]))) return;
    await ctx.store.deleteItem(item.id);
    if (ctx.state.page) Object.assign(ctx.state.page, { saved: false, itemId: '' });
    ctx.toast('Moved to Trash', { action: { label: 'Undo', run: () => ctx.store.restoreItem(item.id) } });
  },
  'page.new-note': ({ ctx }) => newPageNote(ctx),
  'page.blank-note': async ({ ctx }) => {
    const note = await createNote(ctx, { title: '', content: '', collectionId: defaultCollectionId(ctx), open: true });
    if (!note) openAdd(ctx, { type: 'note' });
  },
  'page.open-library': ({ ctx }) => { ctx.state.sideTab = 'library'; ctx.state.sideStack = []; ctx.render(); },
  'page.ask-input': ({ el }) => { askDraft = el.value; },
  'page.ask': ({ ctx, el }) => {
    const prompt = String(new FormData(el).get('prompt') || askDraft || '').trim();
    askDraft = '';
    const input = el.querySelector('input');
    if (input) input.value = '';
    askAi(ctx, { scope: 'page', prompt, send: !!prompt });
    if (ctx.env.isSidepanel && ctx.state.sideTab === 'page' && !ctx.state.panel) ctx.state.sideTab = 'ask';
    ctx.render();
  },
});

