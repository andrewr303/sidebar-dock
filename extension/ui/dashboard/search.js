// Unified dashboard search: one input for the web, the library and the assistant, with an ARIA combobox listbox.
// Enter runs the highlighted row (the web search by default), Shift+Enter asks AI, Ctrl/⌘+Enter opens in a new tab.
import { html, cx } from '../html.js';
import { icon } from '../icons.js';
import { iconButton, siteIcon, collectionIcon, kbd, domainOf, TYPE_ICONS } from '../components.js';
import { registerActions } from '../runtime.js';
import { searchRows } from '../selectors.js';
import { askAi } from '../ai-panel.js';
import { dashUi, newTabPrefs } from './state.js';

export const SEARCH_ENGINES = Object.freeze([
  { id: 'default', label: 'the web', url: 'https://www.google.com/search?q=' },
  { id: 'google', label: 'Google', url: 'https://www.google.com/search?q=' },
  { id: 'duckduckgo', label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  { id: 'bing', label: 'Bing', url: 'https://www.bing.com/search?q=' },
  { id: 'kagi', label: 'Kagi', url: 'https://kagi.com/search?q=' },
  { id: 'perplexity', label: 'Perplexity', url: 'https://www.perplexity.ai/search?q=' },
  { id: 'brave', label: 'Brave Search', url: 'https://search.brave.com/search?q=' },
]);
const engineOf = id => SEARCH_ENGINES.find(e => e.id === id) || SEARCH_ENGINES[0];

/** Search results URL for an engine id (unknown ids and 'default' fall back to Google when chrome.search is absent). */
export function searchUrl(engine, text) {
  return `${engineOf(engine).url}${encodeURIComponent(String(text || '').trim())}`;
}

/**
 * A web address typed into the search box, normalized to an absolute http(s) URL, or ''. Accepts full URLs and bare
 * hosts with a dot and a plausible TLD ("github.com", "news.ycombinator.com/item?id=1", "localhost:3000").
 */
export function urlFromText(text) {
  const value = String(text || '').trim();
  if (!value || /\s/.test(value)) return '';
  if (/^https?:\/\//i.test(value)) {
    try { const url = new URL(value); return url.hostname ? url.href : ''; } catch { return ''; }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^localhost:\d/i.test(value)) return '';
  const host = value.split(/[/?#]/)[0];
  const looksLikeHost = /^localhost(:\d+)?$/i.test(host) || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(host)
    || /^([a-z\d]([a-z\d-]*[a-z\d])?\.)+[a-z]{2,24}(:\d+)?$/i.test(host);
  // "notes.txt" or "report.pdf" on their own read as file names, not sites.
  if (!looksLikeHost || (value === host && /^[^.]+\.(txt|pdf|docx?|xlsx?|pptx?|md|json|csv|png|jpe?g|gif|svg|webp|js|ts|py|rb|exe|dmg|html?|css)$/i.test(host))) return '';
  try { return new URL(`${/^localhost|^\d/.test(host) ? 'http' : 'https'}://${value}`).href; } catch { return ''; }
}

const lower = value => String(value || '').toLowerCase();
const rank = (title, query) => {
  const t = lower(title);
  const q = lower(query).trim();
  return t === q ? 4 : t.startsWith(q) ? 3 : t.split(/\W+/).some(word => word.startsWith(q)) ? 2 : 1;
};

/**
 * Library matches for the search box: up to `limit` live items (title matches first, then recent edits) and up to two
 * collections whose name contains the query. Pure (takes plain library data).
 */
export function libraryMatches(library, query, { limit = 5 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { items: [], collections: [] };
  const collections = new Map((library?.collections || []).map(c => [c.id, c]));
  const live = (library?.items || []).filter(item => !item.deletedAt && !item.archived);
  const items = searchRows(live, q, collections)
    .map(item => ({ item, score: rank(item.title || item.url, q) }))
    .sort((a, b) => b.score - a.score || String(b.item.updatedAt || '').localeCompare(String(a.item.updatedAt || '')))
    .slice(0, limit).map(entry => entry.item);
  const words = lower(q).split(/\s+/).filter(Boolean);
  const matchedCollections = [...collections.values()].filter(c => words.every(word => lower(c.name).includes(word))).slice(0, 2);
  return { items, collections: matchedCollections };
}

/** Rows for the suggestion list, in order (the first row is what Enter runs). */
export function suggestionRows({ query, engine = 'default', library = null }) {
  const text = String(query || '').trim();
  if (!text) return [];
  const rows = [];
  const url = urlFromText(text);
  if (url) rows.push({ kind: 'url', url, label: `Go to ${url.replace(/^https?:\/\//, '').replace(/\/$/, '')}` });
  rows.push({ kind: 'web', label: `Search ${engineOf(engine).label} for “${text}”`, text });
  rows.push({ kind: 'ai', label: `Ask AI: “${text}”`, text });
  const { items, collections } = libraryMatches(library, text);
  for (const collection of collections) rows.push({ kind: 'collection', id: collection.id, label: collection.name, group: 'library' });
  for (const item of items) rows.push({ kind: 'item', id: item.id, label: item.title || item.url || 'Untitled', url: item.url, type: item.type, group: 'library' });
  return rows;
}

// ------------------------------------------------------------------ rendering

const rowsFor = ctx => suggestionRows({ query: dashUi(ctx).search.query, engine: newTabPrefs(ctx).engine, library: ctx.library });

function rowIcon(ctx, row) {
  if (row.kind === 'url') return siteIcon(row.url, { size: 18 });
  if (row.kind === 'web') return icon('search', { size: 16 });
  if (row.kind === 'ai') return icon('sparkles', { size: 16 });
  if (row.kind === 'collection') return collectionIcon(ctx.select.collection(row.id), { size: 18 });
  if (row.url && row.type !== 'note') return siteIcon(row.url, { size: 18 });
  return icon(TYPE_ICONS[row.type] || 'file-text', { size: 16 });
}

function rowMeta(ctx, row) {
  if (row.kind === 'collection') return 'Collection';
  if (row.kind !== 'item') return '';
  if (row.url && row.type !== 'note') return domainOf(row.url);
  const item = ctx.select.byId(row.id);
  return item?.collectionId ? ctx.select.collection(item.collectionId)?.name || 'Note' : row.type === 'note' ? 'Note' : 'Inbox';
}

export function renderSearch(ctx) {
  const ui = dashUi(ctx);
  const { query, open } = ui.search;
  const rows = open ? rowsFor(ctx) : [];
  const active = Math.min(ui.search.active, Math.max(0, rows.length - 1));
  const expanded = rows.length > 0;
  let lastGroup = '';
  return html`<div class="${cx('dash-search', expanded && 'is-open')}" data-key="dash-search" role="search">
    <div class="dash-search-field">
      ${icon('search', { size: 18, className: 'dash-search-icon' })}
      <input class="dash-search-input" id="search" data-focus-key="search" type="text" role="combobox" value="${query}" autocomplete="off" spellcheck="false"
        placeholder="Search the web or your library, or ask AI" aria-label="Search the web or your library, or ask AI" aria-autocomplete="list"
        aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="dash-search-list" aria-keyshortcuts="/"
        ${expanded ? html`aria-activedescendant="dash-sugg-${active}"` : ''} data-input="dashboard.search-input" data-keydown="dashboard.search-key" data-view-search>
      ${query ? iconButton({ icon: 'x', label: 'Clear search', action: 'dashboard.search-clear', size: 'sm', className: 'dash-search-clear' }) : kbd('/')}
    </div>
    ${expanded ? html`<div class="dash-search-pop">
      <ul class="dash-search-list" id="dash-search-list" role="listbox" aria-label="Suggestions">
        ${rows.map((row, index) => {
          const heading = row.group === 'library' && lastGroup !== 'library' ? html`<li class="dash-search-heading" role="presentation">In your library</li>` : '';
          lastGroup = row.group || '';
          const meta = rowMeta(ctx, row);
          return html`${heading}<li class="${cx('dash-search-option', index === active && 'is-active', `is-${row.kind}`)}" role="option" id="dash-sugg-${index}"
            aria-selected="${index === active ? 'true' : 'false'}" data-action="dashboard.search-pick" data-index="${index}">
            <span class="dash-search-option-icon" aria-hidden="true">${rowIcon(ctx, row)}</span>
            <span class="dash-search-option-label">${row.label}</span>
            ${meta ? html`<span class="dash-search-option-meta">${meta}</span>` : ''}
            ${index === active ? kbd('enter') : ''}
          </li>`;
        })}
      </ul>
      <p class="dash-search-hints" aria-hidden="true"><span>${kbd('enter')} Open</span><span>${kbd('shift+enter')} Ask AI</span><span>${kbd('mod+enter')} New tab</span><span>${kbd('Esc')} Close</span></p>
    </div>` : ''}
  </div>`;
}

// ------------------------------------------------------------------ running a row

const isExtension = () => !!globalThis.chrome?.runtime?.id;

async function openUrl(ctx, url, newTab) {
  if (!/^https?:/i.test(url || '')) return;
  if (newTab) {
    if (isExtension() && globalThis.chrome?.tabs?.create) await chrome.tabs.create({ url, active: true });
    else window.open(url, '_blank', 'noopener');
  } else location.assign(url);
}

async function webSearch(ctx, text, newTab) {
  const engine = newTabPrefs(ctx).engine;
  if (engine === 'default' && isExtension() && globalThis.chrome?.search?.query) {
    await chrome.search.query({ text, disposition: newTab ? 'NEW_TAB' : 'CURRENT_TAB' });
    return;
  }
  await openUrl(ctx, searchUrl(engine, text), newTab);
}

function askAssistant(ctx, text) {
  ctx.navigate('assistant');
  askAi(ctx, { prompt: text, send: true });
}

function openLibraryItem(ctx, id, newTab) {
  const item = ctx.select.byId(id);
  if (!item) return ctx.toast('That item is no longer in your library.', { tone: 'danger' });
  if (item.type === 'note') {
    ctx.state.notes = { ...ctx.state.notes, noteId: id };
    return ctx.navigate('notes');
  }
  if (/^https?:/i.test(item.url || '')) return openUrl(ctx, item.url, newTab);
  ctx.openItem(id);
}

function resetSearch(ctx, { keepQuery = false } = {}) {
  const ui = dashUi(ctx);
  ui.search = { query: keepQuery ? ui.search.query : '', open: false, active: 0 };
}

async function runRow(ctx, row, { newTab = false, ai = false } = {}) {
  if (!row) return;
  const text = dashUi(ctx).search.query.trim();
  if (ai) { resetSearch(ctx); return askAssistant(ctx, text); }
  resetSearch(ctx, { keepQuery: !newTab && ['url', 'web'].includes(row.kind) });
  ctx.render();
  if (row.kind === 'url') return openUrl(ctx, row.url, newTab);
  if (row.kind === 'web') return webSearch(ctx, row.text, newTab);
  if (row.kind === 'ai') { resetSearch(ctx); return askAssistant(ctx, row.text); }
  if (row.kind === 'collection') return ctx.navigate(`collection:${row.id}`);
  if (row.kind === 'item') return openLibraryItem(ctx, row.id, newTab);
}

const modPressed = (ctx, event) => !!(ctx.env.isMac ? event?.metaKey : event?.ctrlKey);

registerActions({
  'dashboard.search-input': ({ ctx, el }) => {
    const ui = dashUi(ctx);
    ui.search = { query: el.value, open: !!el.value.trim(), active: 0 };
    ctx.render();
  },
  'dashboard.search-clear': ({ ctx }) => {
    resetSearch(ctx);
    ctx.render();
    ctx.nextFrame(() => document.getElementById('search')?.focus({ preventScroll: true }));
  },
  'dashboard.search-pick': ({ ctx, data, event }) => {
    const rows = rowsFor(ctx);
    return runRow(ctx, rows[Number(data.index)], { newTab: modPressed(ctx, event) || event?.button === 1 });
  },
  'dashboard.search-key': ({ ctx, el, event }) => {
    const ui = dashUi(ctx);
    const rows = ui.search.open ? rowsFor(ctx) : [];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!rows.length) {
        if (el.value.trim()) { ui.search.open = true; ctx.render(); }
        return;
      }
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      ui.search.active = (Math.min(ui.search.active, rows.length - 1) + step + rows.length) % rows.length;
      ctx.render();
      ctx.nextFrame(() => document.getElementById(`dash-sugg-${ui.search.active}`)?.scrollIntoView({ block: 'nearest' }));
      return;
    }
    if (event.key === 'Enter' && !event.isComposing) {
      const text = el.value.trim();
      if (!text) return;
      event.preventDefault();
      ui.search.query = el.value;
      const list = suggestionRows({ query: text, engine: newTabPrefs(ctx).engine, library: ctx.library });
      const row = list[Math.min(ui.search.open ? ui.search.active : 0, list.length - 1)];
      return runRow(ctx, row, { newTab: modPressed(ctx, event), ai: event.shiftKey });
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (ui.search.open) { ui.search.open = false; ctx.render(); return; }
      if (el.value) { el.value = ''; resetSearch(ctx); ctx.render(); return; }
      el.blur();
      return;
    }
    if (event.key === 'Tab' && ui.search.open) { ui.search.open = false; ctx.render(); }
  },
});

/** Closes the suggestion list when focus or a pointer goes elsewhere (called once from the dashboard's init). */
export function initSearch(ctx) {
  const close = target => {
    const ui = ctx.state.dash;
    if (!ui?.search.open || target?.closest?.('.dash-search')) return;
    ui.search.open = false;
    ctx.render();
  };
  document.addEventListener('pointerdown', event => close(event.target), true);
  document.addEventListener('focusin', event => close(event.target));
}
