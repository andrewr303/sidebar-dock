// App frame for both surfaces and view routing (SPEC.md §13). Full tab: sidebar | top bar + main | resizable panel.
// Side panel: context header, one tab at a time (or a covering panel), bottom tab bar.
import { html, cx, raw } from './html.js';
import { icon } from './icons.js';
import { iconButton, button, splitButton, kbd, favicon, collectionIcon, domainOf } from './components.js';
import { registerActions, registerShortcuts, hasAction } from './runtime.js';
import { renderOverlays } from './overlay.js';
import { renderSidebar, renderLibraryRoot, brandMark, saveCurrentTab } from './sidebar.js';
import { renderItemsView } from './library.js';
import { renderDetail } from './detail.js';
import { renderMap } from './map.js';
import { renderPageTab } from './page.js';
import { renderNotesWorkspace, renderTasks, renderSideNotes, createNote } from './notes.js';
import { renderAiPanel, askAi } from './ai-panel.js';
import { openCommandPalette } from './command.js';
import { openAdd } from './quick-add.js';
import { openSettings, renderSettingsPage } from './settings.js';
import { openCollectionEditor } from './collections.js';
import { SORT_OPTIONS } from './selectors.js';
import { dailyNoteTitle } from '../lib/notes.js';
import { renderDashboard } from './dashboard/index.js';
import { renderAssistantPage } from './assistant-page.js';
import { renderStickiesView } from './stickies.js';
import { ownsHeader, isSettingsView } from './routes.js';

const SIDE_TABS = [
  { id: 'library', label: 'Library', icon: 'book-open-text' },
  { id: 'page', label: 'This page', icon: 'app-window' },
  { id: 'notes', label: 'Notes', icon: 'sticky-note' },
  { id: 'ask', label: 'Ask', icon: 'sparkles' },
];
const TYPE_FILTERS = [
  { value: 'all', label: 'All types' }, { value: 'link', label: 'Links' }, { value: 'article', label: 'Articles' }, { value: 'note', label: 'Notes' },
  { value: 'image', label: 'Images' }, { value: 'video', label: 'Videos' }, { value: 'file', label: 'Files' },
];
const SEARCH_TOKENS = [
  { token: 'tag:', label: 'tag:name or #name', hint: 'Tag' },
  { token: 'type:', label: 'type:note, type:link', hint: 'Type' },
  { token: 'site:', label: 'site:example.com', hint: 'Website' },
  { token: '"', label: '"exact phrase"', hint: 'Phrase' },
];
const NON_ITEM_VIEWS = ['notes', 'tasks', 'map', 'dashboard', 'assistant', 'stickies'];
// Panels the full tab shows beside the main view (settings are a view there; the side panel shows them as a covering panel).
const FULL_PANELS = ['item', 'ai'];
const PANEL = { min: 340, max: 640, fallback: 400, step: 16 };
const WIDE = '(min-width: 1100px)';

const shell = ctx => (ctx.state.shell ||= { navOpen: false, wide: globalThis.matchMedia?.(WIDE).matches ?? true, docked: true });
const clampPanel = width => Math.round(Math.min(PANEL.max, Math.max(PANEL.min, Number(width) || PANEL.fallback)));
const panelWidth = ctx => clampPanel(ctx.prefs.get('panelWidth', PANEL.fallback));
const keys = (ctx, combo) => combo.replace('mod', ctx.env.isMac ? 'Meta' : 'Control').replace('shift', 'Shift');
// The collection the user is looking at ('' = Inbox), if any. In the side panel only the Library tab's drill-down counts,
// so + on This page or Notes does not preselect a collection left open in the Library tab earlier.
const currentCollection = ctx => {
  const { view, sideTab, sideStack, panel } = ctx.state;
  if (ctx.env.isSidepanel && (sideTab !== 'library' || !sideStack.length || panel)) return undefined;
  return view === 'inbox' ? '' : view.startsWith('collection:') ? view.slice(11) : undefined;
};
// Shortcuts run actions with the focused element's dataset; only clicks and dispatch() pass real payloads.
const payload = (event, data) => (event?.type === 'keydown' ? {} : data || {});
const menuOpenFor = (ctx, action) => ctx.state.popover?.anchorEl?.dataset?.action === action;
const nextTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
const dispatchOr = (ctx, name, fallback) => (hasAction(name) ? ctx.dispatch(name, {}) : fallback());

export function viewTitle(ctx, view = ctx.state.view) {
  if (isSettingsView(view)) return 'Settings';
  if (view.startsWith('collection:')) return ctx.select.collection(view.slice(11))?.name || 'Collection';
  if (view.startsWith('tag:')) return `#${view.slice(4)}`;
  if (view.startsWith('type:')) return { bookmark: 'Links', article: 'Articles', image: 'Images', video: 'Videos', file: 'Files' }[view.slice(5)] || 'Items';
  return { dashboard: 'Dashboard', assistant: 'AI Assistant', stickies: 'Sticky notes',
    all: 'All items', inbox: 'Inbox', favorites: 'Favorites', notes: 'Notes', tasks: 'Tasks', highlights: 'Highlights', map: 'Knowledge map',
    archive: 'Archive', trash: 'Trash', duplicates: 'Duplicates', untagged: 'Untagged', reminders: 'Reminders' }[view] || 'All items';
}

function renderBootError(ctx) {
  return html`<div class="boot-error" role="alert">
    ${brandMark({ size: 36 })}
    <h1 class="boot-error-title">Still could not open your library</h1>
    <p class="boot-error-body">${ctx.state.boot.error}</p>
    <p class="boot-error-hint">Nothing was changed. Try again, and restart Chrome if it keeps happening.</p>
    ${button({ label: 'Try again', icon: 'refresh-cw', variant: 'primary', action: 'app.retry-boot' })}
  </div>`;
}

function renderSearch(ctx) {
  const { state } = ctx;
  const itemView = !NON_ITEM_VIEWS.includes(state.view);
  const placeholder = itemView && state.view !== 'all' ? `Search ${viewTitle(ctx)}` : 'Search your library';
  const filtered = state.typeFilter !== 'all' || state.sort !== 'newest';
  return html`<div class="search-field topbar-search" role="search">
    ${icon('search', { size: 16, className: 'search-field-icon' })}
    <input class="search-field-input" type="search" id="search" data-focus-key="search" value="${state.query}" placeholder="${placeholder}" aria-label="Search"
      aria-keyshortcuts="/" autocomplete="off" spellcheck="false" data-input="shell.search" data-keydown="shell.search-key">
    ${state.query ? iconButton({ icon: 'x', label: 'Clear search', action: 'shell.clear-search', size: 'sm', className: 'search-field-clear' }) : kbd('/')}
    <span class="search-divider" aria-hidden="true"></span>
    ${iconButton({ icon: 'sliders-horizontal', label: filtered ? 'Filter and sort (active)' : 'Filter and sort', action: 'shell.search-menu', size: 'sm',
      expanded: menuOpenFor(ctx, 'shell.search-menu'), badge: filtered, className: 'search-field-filter' })}
  </div>`;
}

function renderTopbar(ctx, docked) {
  const ui = shell(ctx);
  return html`<header class="topbar">
    ${docked ? '' : iconButton({ icon: 'panel-left', label: 'Show sidebar', action: 'shell.toggle-nav', controls: 'sidebar', className: 'topbar-nav-toggle', id: 'nav-toggle',
      attrs: { 'aria-expanded': ui.navOpen ? 'true' : 'false', 'aria-keyshortcuts': keys(ctx, 'mod+\\') } })}
    ${renderSearch(ctx)}
    <div class="topbar-actions">
      ${button({ label: 'Ask', icon: 'sparkles', variant: 'ghost', action: 'shell.ask', pressed: ctx.state.panel?.kind === 'ai', className: 'topbar-ask',
        attrs: { 'aria-keyshortcuts': keys(ctx, 'mod+shift+A'), 'data-tooltip': `Ask AI (${ctx.env.modKey} Shift A)` } })}
      ${splitButton({ label: 'Add', icon: 'plus', action: 'shell.add', menuAction: 'shell.add-menu', menuLabel: 'More ways to add', className: 'topbar-add' })}
    </div>
  </header>`;
}

function renderMain(ctx) {
  const view = ctx.state.view;
  if (isSettingsView(view)) return renderSettingsPage(ctx, { surface: 'full' });
  if (view === 'dashboard') return renderDashboard(ctx);
  if (view === 'assistant') return renderAssistantPage(ctx);
  if (view === 'stickies') return renderStickiesView(ctx);
  if (view === 'notes') return renderNotesWorkspace(ctx);
  if (view === 'tasks') return renderTasks(ctx);
  if (view === 'map') return renderMap(ctx);
  return renderItemsView(ctx, { surface: 'full' });
}

function renderPanel(ctx, { inert }) {
  const panel = ctx.state.panel;
  if (!FULL_PANELS.includes(panel?.kind)) return '';
  return html`<div class="panel-scrim" data-key="panel-scrim" data-action="app.close-panel" aria-hidden="true"></div>
    <aside class="${cx('panel', `panel-${panel.kind}`)}" id="panel" aria-label="${panel.kind === 'ai' ? 'Assistant' : 'Item details'}" data-key="panel" ${inert ? raw('inert') : ''}>
      ${panel.kind === 'ai' ? renderAiPanel(ctx, { surface: 'full' }) : renderDetail(ctx, panel.id, { surface: 'full' })}
    </aside>
    <div class="panel-resizer" data-key="panel-resizer" role="separator" aria-orientation="vertical" aria-label="Resize panel" aria-controls="panel" tabindex="0"
      aria-valuemin="${PANEL.min}" aria-valuemax="${PANEL.max}" aria-valuenow="${panelWidth(ctx)}" data-keydown="shell.panel-resize-key" ${inert ? raw('inert') : ''}></div>`;
}

function renderFull(ctx) {
  const ui = shell(ctx);
  const docked = ui.wide && !ctx.prefs.get('sidebarHidden', false);
  ui.docked = docked;
  if (docked) ui.navOpen = false;
  const navOpen = !docked && ui.navOpen;
  // The dashboard, the assistant and settings draw their own header (with navToggle from sidebar.js) instead of the top bar.
  const topbar = !ownsHeader(ctx.state.view);
  const panel = FULL_PANELS.includes(ctx.state.panel?.kind);
  return html`<div class="${cx('app-frame', 'is-full', docked ? 'has-sidebar' : 'is-nav-collapsed', navOpen && 'is-nav-open', panel && 'has-panel', !topbar && 'has-own-header')}"
    data-key="frame-full" style="--shell-panel-w:${panelWidth(ctx)}px">
    <nav class="sidebar" id="sidebar" aria-label="Library" data-key="sidebar" data-keydown="shell.nav-key" ${!docked && !navOpen ? raw('inert') : ''}>${renderSidebar(ctx)}</nav>
    ${docked ? '' : html`<div class="nav-scrim" data-key="nav-scrim" data-action="shell.close-nav" aria-hidden="true"></div>`}
    <div class="main-column" data-key="main-column" ${navOpen ? raw('inert') : ''}>
      ${topbar ? renderTopbar(ctx, docked) : ''}
      <main id="main" class="main" tabindex="-1" data-view="${ctx.state.view}" data-drop-zone="main">${renderMain(ctx)}</main>
    </div>
    ${renderPanel(ctx, { inert: navOpen })}
  </div>`;
}

function renderPageIdentity(ctx, page) {
  const saved = ctx.select.savedForUrl(page.url);
  const path = saved?.collectionId ? ctx.select.path(saved.collectionId) : [];
  const status = saved
    ? html`<span class="side-page-saved">${collectionIcon(path.at(-1) || null, { size: 14 })}<span class="side-page-path">Saved in ${path.length ? path.map(c => c.name).join(' / ') : 'Inbox'}</span></span>`
    : html`<span class="side-page-path">${domainOf(page.url)} · Not saved</span>`;
  return html`<div class="side-page">${favicon(page.url, { size: 22 })}
    <div class="side-page-text"><h1 class="side-page-title" title="${page.title || page.url}">${page.title || domainOf(page.url)}</h1><p class="side-page-meta">${status}</p></div></div>`;
}

function renderSideHeader(ctx, tab) {
  const page = ctx.state.page;
  const showPage = tab === 'page' && !ctx.state.panel && /^https?:/i.test(page?.url || '');
  return html`<header class="side-header">
    ${showPage ? renderPageIdentity(ctx, page)
      : html`<div class="side-brand">${brandMark({ size: 20 })}<h1 class="side-header-title">${SIDE_TABS.find(t => t.id === tab)?.label || 'Still'}</h1></div>`}
    <div class="side-header-actions">
      ${iconButton({ icon: 'search', label: 'Search and commands', action: 'shell.command', attrs: { 'aria-keyshortcuts': keys(ctx, 'mod+K') } })}
      ${iconButton({ icon: 'plus', label: 'Add', action: 'shell.add' })}
      ${iconButton({ icon: 'ellipsis', label: 'More', action: 'shell.side-menu', expanded: menuOpenFor(ctx, 'shell.side-menu') })}
    </div>
  </header>`;
}

function renderSideContent(ctx) {
  const { state } = ctx;
  if (state.panel?.kind === 'settings') return renderSettingsPage(ctx, { surface: 'side' });
  if (state.panel?.kind === 'item') return renderDetail(ctx, state.panel.id, { surface: 'side' });
  if (state.panel?.kind === 'ai' || state.sideTab === 'ask') return renderAiPanel(ctx, { surface: 'side' });
  if (state.sideTab === 'page') return renderPageTab(ctx);
  if (state.sideTab === 'notes') return renderSideNotes(ctx);
  return state.sideStack.length ? renderItemsView(ctx, { surface: 'side' }) : renderLibraryRoot(ctx);
}

function renderSide(ctx) {
  const tab = ctx.state.panel?.kind === 'ai' ? 'ask' : ctx.state.sideTab;
  // A Library drill-down brings its own header (back, title, layout, search, menu with Open in full tab), as in the
  // mock's side-library screen; stacking the app header above it would show two header rows.
  // Item detail and settings draw their own back header too.
  const drill = ['item', 'settings'].includes(ctx.state.panel?.kind) || (!ctx.state.panel && tab === 'library' && ctx.state.sideStack.length > 0);
  return html`<div class="app-frame is-side" data-key="frame-side">
    ${drill ? '' : renderSideHeader(ctx, tab)}
    <main id="main" class="side-main" tabindex="-1" data-tab="${ctx.state.panel?.kind === 'settings' ? 'settings' : tab}" data-drop-zone="side">${renderSideContent(ctx)}</main>
    <nav class="tabbar" aria-label="Sections"><div class="tabbar-inner">
      ${SIDE_TABS.map(t => html`<button type="button" class="tabbar-tab" ${t.id === tab ? raw('aria-current="page"') : ''} data-action="shell.side-tab" data-tab="${t.id}">
        ${icon(t.icon, { size: 18 })}<span class="tabbar-label">${t.label}</span></button>`)}
    </div></nav>
  </div>`;
}

export function renderApp(ctx) {
  if (ctx.state.boot.error) return renderBootError(ctx);
  if (!ctx.state.boot.ready) return '';
  init(ctx);
  return html`${ctx.env.isSidepanel ? renderSide(ctx) : renderFull(ctx)}<div class="overlay-root" data-key="overlays">${renderOverlays(ctx)}</div>`;
}

/** Focuses the first element matching the first selector that matches anything, after the next render. */
function focusLater(ctx, ...selectors) {
  ctx.nextFrame(() => selectors.map(selector => document.querySelector(selector)).find(el => el?.getClientRects().length)?.focus({ preventScroll: true }));
}
// The current view's row, else the first row (a selector list would pick whichever comes first in the document).
const NAV_FOCUS = ['#sidebar [aria-current="page"]', '#sidebar .tree-row'];

function setNav(ctx, open) {
  shell(ctx).navOpen = open;
  ctx.render();
  if (open) focusLater(ctx, ...NAV_FOCUS); else focusLater(ctx, '#nav-toggle');
}

function toggleSidebar(ctx) {
  const ui = shell(ctx);
  if (ui.docked) { ctx.prefs.set('sidebarHidden', true); ctx.render(); focusLater(ctx, '#nav-toggle'); return; }
  if (ui.wide) { ctx.prefs.set('sidebarHidden', false); ctx.render(); focusLater(ctx, ...NAV_FOCUS); return; }
  setNav(ctx, !ui.navOpen);
}

/** Opens a note in the notes editor of either surface (notes.js reads state.notes.noteId). */
function openNote(ctx, id) {
  ctx.state.notes = { ...ctx.state.notes, noteId: id };
  if (ctx.env.isSidepanel) { ctx.state.panel = null; ctx.state.sideTab = 'notes'; ctx.render(); return; }
  ctx.navigate('notes');
}

function newNote(ctx) {
  const collectionId = currentCollection(ctx);
  return createNote(ctx, collectionId === undefined ? {} : { collectionId });
}

function todayNote(ctx) {
  const title = dailyNoteTitle(new Date());
  const existing = ctx.select.live().find(item => item.type === 'note' && item.title === title);
  if (existing) return openNote(ctx, existing.id);
  return createNote(ctx, { title, content: '' });
}

function setSearchState(ctx, patch) {
  Object.assign(ctx.state, patch);
  ctx.syncUrl?.();
  ctx.render();
}

function insertSearchToken(ctx, token) {
  const input = document.getElementById('search');
  if (!input) return;
  const value = input.value.trim();
  input.value = `${value ? `${value} ` : ''}${token === '"' ? '""' : token}`;
  input.focus();
  // A phrase puts the caret between its quotes; the other operators wait for their value.
  const end = input.value.length - (token === '"' ? 1 : 0);
  input.setSelectionRange(end, end);
}

function addMenu(ctx) {
  const collectionId = currentCollection(ctx);
  return [
    { label: 'Add link', icon: 'link', shortcut: 'A', run: () => openAdd(ctx, collectionId === undefined ? {} : { collectionId }) },
    { label: 'New note', icon: 'square-pen', shortcut: 'N', run: () => newNote(ctx) },
    { label: 'Upload files', icon: 'upload', run: () => dispatchOr(ctx, 'add.upload', () => openAdd(ctx, { type: 'file' })) },
    ...(ctx.env.isExtension ? [{ label: 'Save all tabs', icon: 'layers', run: () => dispatchOr(ctx, 'add.save-tabs', () => openAdd(ctx, {})) }] : []),
    { label: 'New collection', icon: 'folder-plus', run: () => openCollectionEditor(ctx, {}) },
    { separator: true },
    { label: 'Import bookmarks…', icon: 'folder-input', run: () => openSettings(ctx, 'library') },
  ];
}

let searchTimer = 0;
registerActions({
  'shell.search': ({ el, ctx }) => {
    clearTimeout(searchTimer);
    const value = el.value;
    searchTimer = setTimeout(() => {
      ctx.state.query = value;
      // Notes, Tasks and the map have their own filters: a library search from there shows All items.
      if (value.trim() && NON_ITEM_VIEWS.includes(ctx.state.view)) { ctx.navigate('all', { keep: true }); return; }
      ctx.syncUrl?.();
      ctx.render();
    }, 120);
  },
  'shell.clear-search': ({ ctx }) => {
    clearTimeout(searchTimer);
    setSearchState(ctx, { query: '' });
    focusLater(ctx, '#search');
  },
  'shell.search-key': ({ ctx, el, event }) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    clearTimeout(searchTimer);
    if (el.value) { el.value = ''; setSearchState(ctx, { query: '' }); return; }
    el.blur();
    document.getElementById('main')?.focus({ preventScroll: true });
  },
  'shell.search-menu': ({ ctx, el }) => ctx.openMenu(el, [
    { heading: 'Type' },
    ...TYPE_FILTERS.map(t => ({ label: t.label, checked: ctx.state.typeFilter === t.value, run: () => setSearchState(ctx, { typeFilter: t.value }) })),
    { separator: true },
    { heading: 'Sort' },
    ...SORT_OPTIONS.map(o => ({ label: o.label, checked: ctx.state.sort === o.value, run: () => setSearchState(ctx, { sort: o.value }) })),
    { separator: true },
    { heading: 'Search syntax' },
    ...SEARCH_TOKENS.map(t => ({ label: t.label, hint: t.hint, keepFocus: true, run: () => insertSearchToken(ctx, t.token) })),
  ], { placement: 'bottom-end', label: 'Filter and sort' }),
  'shell.ask': ({ ctx, data, event }) => {
    const prompt = payload(event, data).prompt || '';
    if (!prompt && ctx.state.panel?.kind === 'ai' && !ctx.env.isSidepanel) return ctx.closePanel();
    askAi(ctx, prompt ? { prompt, send: true } : {});
  },
  'shell.add': ({ ctx, data, event }) => {
    const { url } = payload(event, data);
    if (url) return openAdd(ctx, { url });
    const collectionId = currentCollection(ctx);
    openAdd(ctx, collectionId === undefined ? {} : { collectionId });
  },
  'shell.add-menu': ({ ctx, el }) => ctx.openMenu(el, addMenu(ctx), { placement: 'bottom-end', label: 'Add' }),
  'shell.new-note': ({ ctx }) => newNote(ctx),
  'shell.today-note': ({ ctx }) => todayNote(ctx),
  'shell.save-page': ({ ctx }) => saveCurrentTab(ctx, {}),
  'shell.settings': ({ ctx, data, event }) => openSettings(ctx, payload(event, data).section || 'general', { anchor: payload(event, data).anchor || '' }),
  'shell.shortcuts': ({ ctx }) => openSettings(ctx, 'shortcuts'),
  'shell.toggle-theme': ({ ctx }) => ctx.store.updateSettings({ theme: nextTheme() }),
  'shell.command': ({ ctx, el }) => {
    if (ctx.state.dialogs.some(d => d.name !== 'command.palette')) return;
    openCommandPalette(ctx, { query: el?.id === 'search' ? el.value : '' });
  },
  'shell.side-tab': ({ ctx, data }) => {
    ctx.state.panel = null;
    if (ctx.state.sideTab === data.tab && data.tab === 'library') ctx.state.sideStack = [];
    ctx.state.sideTab = data.tab;
    ctx.render();
    focusLater(ctx, '#main');
  },
  'shell.side-menu': ({ ctx, el }) => ctx.openMenu(el, [
    { label: 'Open in full tab', icon: 'external-link', action: 'app.open-full' },
    { label: 'New collection', icon: 'folder-plus', run: () => openCollectionEditor(ctx, {}) },
    // Page capture: the side panel sits next to the page it reads.
    ...(ctx.env.isExtension && hasAction('add.save-article') ? [
      { label: 'Save article…', icon: 'newspaper', action: 'add.save-article' },
      { label: 'Select parts of page…', icon: 'square-dashed-mouse-pointer', action: 'add.select-parts', disabled: ctx.state.picker?.status === 'selecting' },
    ] : []),
    ...(ctx.env.isExtension ? [{ label: 'Save all tabs', icon: 'layers', run: () => dispatchOr(ctx, 'add.save-tabs', () => openAdd(ctx, {})) }] : []),
    { separator: true },
    { label: nextTheme() === 'dark' ? 'Switch to dark theme' : 'Switch to light theme', icon: nextTheme() === 'dark' ? 'moon' : 'sun', run: () => ctx.store.updateSettings({ theme: nextTheme() }) },
    { label: 'Settings', icon: 'settings', run: () => openSettings(ctx, 'general') },
    { label: 'Keyboard shortcuts', icon: 'keyboard', shortcut: '?', run: () => openSettings(ctx, 'shortcuts') },
    { label: 'Help', icon: 'circle-help', run: () => openSettings(ctx, 'help') },
  ], { placement: 'bottom-end', label: 'More' }),
  'shell.focus-search': ({ ctx }) => {
    if (ctx.env.isSidepanel) return openCommandPalette(ctx, {});
    if (!shell(ctx).docked && shell(ctx).navOpen) setNav(ctx, false);
    // Views without the top bar may mark their own search field (the dashboard's, settings') with data-view-search.
    const el = [document.getElementById('search'), ...document.querySelectorAll('#main [data-view-search]')].find(node => node?.getClientRects().length);
    if (!el) return openCommandPalette(ctx, {});
    el.focus();
    el.select?.();
  },
  'shell.toggle-nav': ({ ctx }) => (shell(ctx).wide ? toggleSidebar(ctx) : setNav(ctx, !shell(ctx).navOpen)),
  'shell.close-nav': ({ ctx }) => setNav(ctx, false),
  'shell.hide-sidebar': ({ ctx }) => toggleSidebar(ctx),
  'shell.toggle-sidebar': ({ ctx }) => toggleSidebar(ctx),
  'shell.nav-key': ({ ctx, el, event }) => {
    // While the sidebar overlays the page, Tab cycles inside it (the rest of the page is inert).
    if (event.key !== 'Tab' || shell(ctx).docked || !shell(ctx).navOpen) return;
    const focusable = [...el.querySelectorAll('a[href], button:not([disabled]), input, [tabindex="0"]')].filter(n => n.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  },
  'shell.panel-resize-key': ({ ctx, event }) => {
    const width = panelWidth(ctx);
    const next = { ArrowLeft: width + PANEL.step, ArrowRight: width - PANEL.step, Home: PANEL.min, End: PANEL.max }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    ctx.prefs.set('panelWidth', clampPanel(next));
    ctx.render();
  },
  'shell.escape': ({ ctx }) => {
    const ui = shell(ctx);
    if (!ui.docked && ui.navOpen) return setNav(ctx, false);
    if (ctx.state.panel) ctx.closePanel();
  },
});

const noDialog = ctx => !ctx.state.dialogs.length;
registerShortcuts([
  { keys: 'mod+k', action: 'shell.command', label: 'Search and commands', allowInInputs: true },
  { keys: '/', action: 'shell.focus-search', label: 'Search this view', when: noDialog },
  // mod+shift+s (Quick add) is registered by quick-add.js.
  { keys: 'a', action: 'shell.add', label: 'Add a link', when: noDialog },
  { keys: 'n', action: 'shell.new-note', label: 'New note', when: noDialog },
  { keys: 'mod+shift+a', action: 'shell.ask', label: 'Ask AI', allowInInputs: true, when: noDialog },
  { keys: 'mod+\\', action: 'shell.toggle-sidebar', label: 'Show or hide the sidebar', when: ctx => noDialog(ctx) && !ctx.env.isSidepanel },
  { keys: '?', action: 'shell.shortcuts', label: 'Keyboard shortcuts', when: noDialog },
  { keys: 'escape', action: 'shell.escape', label: 'Close the panel or sidebar',
    when: ctx => noDialog(ctx) && !ctx.state.popover && (!!ctx.state.panel || (!shell(ctx).docked && shell(ctx).navOpen)) },
]);

let initialized = false;
/** One-time wiring (called on the first ready render): sidebar breakpoint and the panel resizer. */
export function init(ctx) {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;
  const media = globalThis.matchMedia?.(WIDE);
  media?.addEventListener('change', () => {
    const ui = shell(ctx);
    ui.wide = media.matches;
    if (ui.wide) ui.navOpen = false;
    ctx.render();
  });
  document.addEventListener('pointerdown', event => {
    const handle = event.target instanceof Element ? event.target.closest('.panel-resizer') : null;
    if (!handle || event.button !== 0) return;
    event.preventDefault();
    const frame = handle.closest('.app-frame');
    const startX = event.clientX;
    const startWidth = panelWidth(ctx);
    let width = startWidth;
    handle.setPointerCapture(event.pointerId);
    document.documentElement.classList.add('is-resizing');
    const move = moveEvent => {
      width = clampPanel(startWidth + startX - moveEvent.clientX);
      frame?.style.setProperty('--shell-panel-w', `${width}px`);
      handle.setAttribute('aria-valuenow', String(width));
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.documentElement.classList.remove('is-resizing');
      ctx.prefs.set('panelWidth', width);
      ctx.render();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}
