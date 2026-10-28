// App frame for both surfaces and view routing (SPEC.md §13). Full tab: sidebar | main | optional panel.
// Side panel: header, one tab at a time (or a covering panel), bottom tab bar.
import { html, cx } from './html.js';
import { icon } from './icons.js';
import { iconButton, button, searchField, kbd } from './components.js';
import { registerActions, registerShortcuts } from './runtime.js';
import { renderOverlays } from './overlay.js';
import { renderSidebar, renderLibraryRoot } from './sidebar.js';
import { renderItemsView } from './library.js';
import { renderDetail } from './detail.js';
import { renderMap } from './map.js';
import { renderPageTab } from './page.js';
import { renderNotesWorkspace, renderTasks, renderSideNotes } from './notes.js';
import { renderAiPanel } from './ai-panel.js';
import { openCommandPalette } from './command.js';
import { openAdd } from './quick-add.js';
import { openSettings } from './settings.js';
import { askAi } from './ai-panel.js';

const SIDE_TABS = [
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'page', label: 'This page', icon: 'globe' },
  { id: 'notes', label: 'Notes', icon: 'sticky-note' },
  { id: 'ask', label: 'Ask', icon: 'sparkles' },
];

export function viewTitle(ctx, view = ctx.state.view) {
  if (view.startsWith('collection:')) return ctx.select.collection(view.slice(11))?.name || 'Collection';
  if (view.startsWith('tag:')) return `#${view.slice(4)}`;
  if (view.startsWith('type:')) return { bookmark: 'Links', article: 'Articles', image: 'Images', video: 'Videos', file: 'Files' }[view.slice(5)] || 'Items';
  return { all: 'All items', inbox: 'Inbox', favorites: 'Favorites', notes: 'Notes', tasks: 'Tasks', highlights: 'Highlights', map: 'Knowledge map',
    archive: 'Archive', trash: 'Trash', duplicates: 'Duplicates', untagged: 'Untagged', reminders: 'Reminders' }[view] || 'All items';
}

function renderBootError(ctx) {
  return html`<div class="boot-error" role="alert">${icon('triangle-alert', { size: 24 })}<h1>Still could not open your library</h1>
    <p>${ctx.state.boot.error}</p>${button({ label: 'Try again', variant: 'primary', action: 'app.retry-boot' })}</div>`;
}

function renderTopbar(ctx) {
  const { state } = ctx;
  return html`<header class="topbar">
    ${searchField({ value: state.query, placeholder: `Search ${viewTitle(ctx).toLowerCase() === 'all items' ? 'your library' : viewTitle(ctx)}`, action: 'shell.search', id: 'search', kbd: 'mod+k', clearAction: 'shell.clear-search', className: 'topbar-search' })}
    <div class="topbar-actions">
      ${button({ label: 'Ask', icon: 'sparkles', variant: 'ghost', action: 'shell.ask', pressed: state.panel?.kind === 'ai' })}
      ${button({ label: 'Add', icon: 'plus', variant: 'primary', action: 'shell.add', kbd: null })}
    </div>
  </header>`;
}

function renderMain(ctx) {
  const view = ctx.state.view;
  if (view === 'notes') return renderNotesWorkspace(ctx);
  if (view === 'tasks') return renderTasks(ctx);
  if (view === 'map') return renderMap(ctx);
  return renderItemsView(ctx, { surface: 'full' });
}

function renderPanel(ctx) {
  const panel = ctx.state.panel;
  if (!panel) return '';
  return html`<aside class="${cx('panel', `panel-${panel.kind}`)}" aria-label="${panel.kind === 'ai' ? 'Assistant' : 'Item details'}" data-key="panel">
    ${panel.kind === 'ai' ? renderAiPanel(ctx, { surface: 'full' }) : renderDetail(ctx, panel.id, { surface: 'full' })}
  </aside>`;
}

function renderFull(ctx) {
  return html`<div class="${cx('app-frame', 'is-full', ctx.state.panel && 'has-panel')}" data-key="frame-full">
    <nav class="sidebar" aria-label="Library" data-key="sidebar">${renderSidebar(ctx)}</nav>
    <div class="main-column" data-key="main-column">
      ${renderTopbar(ctx)}
      <main id="main" class="main" tabindex="-1" data-view="${ctx.state.view}">${renderMain(ctx)}</main>
    </div>
    ${renderPanel(ctx)}
  </div>`;
}

function renderSideHeader(ctx) {
  const tab = ctx.state.sideTab;
  return html`<header class="side-header">
    <span class="brand-mark" aria-hidden="true">${icon('bookmark', { size: 14 })}</span>
    <span class="side-header-title">${SIDE_TABS.find(t => t.id === tab)?.label || 'Still'}</span>
    <div class="side-header-actions">
      ${iconButton({ icon: 'search', label: 'Search', action: 'shell.command' })}
      ${iconButton({ icon: 'plus', label: 'Add', action: 'shell.add' })}
      ${iconButton({ icon: 'ellipsis', label: 'More', action: 'shell.side-menu' })}
    </div>
  </header>`;
}

function renderSideContent(ctx) {
  const { state } = ctx;
  if (state.panel?.kind === 'item') return renderDetail(ctx, state.panel.id, { surface: 'side' });
  if (state.panel?.kind === 'ai' || state.sideTab === 'ask') return renderAiPanel(ctx, { surface: 'side' });
  if (state.sideTab === 'page') return renderPageTab(ctx);
  if (state.sideTab === 'notes') return renderSideNotes(ctx);
  return state.sideStack.length ? renderItemsView(ctx, { surface: 'side' }) : renderLibraryRoot(ctx);
}

function renderSide(ctx) {
  const tab = ctx.state.panel?.kind === 'ai' ? 'ask' : ctx.state.sideTab;
  return html`<div class="app-frame is-side" data-key="frame-side">
    ${renderSideHeader(ctx)}
    <main id="main" class="side-main" tabindex="-1" data-tab="${tab}">${renderSideContent(ctx)}</main>
    <nav class="tabbar" aria-label="Sections"><div class="tabbar-inner" role="tablist">
      ${SIDE_TABS.map(t => html`<button type="button" role="tab" class="tabbar-tab" aria-selected="${t.id === tab ? 'true' : 'false'}" data-action="shell.side-tab" data-tab="${t.id}">
        ${icon(t.icon, { size: 18 })}<span>${t.label}</span></button>`)}
    </div></nav>
  </div>`;
}

export function renderApp(ctx) {
  if (ctx.state.boot.error) return renderBootError(ctx);
  if (!ctx.state.boot.ready) return '';
  return html`${ctx.env.isSidepanel ? renderSide(ctx) : renderFull(ctx)}<div class="overlay-root" data-key="overlays">${renderOverlays(ctx)}</div>`;
}

let searchTimer = 0;
registerActions({
  'shell.search': ({ el, ctx }) => {
    clearTimeout(searchTimer);
    const value = el.value;
    searchTimer = setTimeout(() => { ctx.state.query = value; ctx.syncUrl?.(); ctx.render(); }, 120);
  },
  'shell.clear-search': ({ ctx }) => { ctx.state.query = ''; ctx.render(); ctx.nextFrame(() => document.getElementById('search')?.focus()); },
  'shell.ask': ({ ctx }) => {
    if (ctx.state.panel?.kind === 'ai') return ctx.closePanel();
    askAi(ctx, {});
  },
  'shell.add': ({ ctx }) => openAdd(ctx, {}),
  'shell.command': ({ ctx }) => openCommandPalette(ctx, {}),
  'shell.side-tab': ({ ctx, data }) => {
    ctx.state.panel = null;
    if (ctx.state.sideTab === data.tab && data.tab === 'library') ctx.state.sideStack = [];
    ctx.state.sideTab = data.tab;
    ctx.render();
  },
  'shell.side-menu': ({ ctx, el }) => ctx.openMenu(el, [
    { label: 'Open in full tab', icon: 'external-link', action: 'app.open-full' },
    { label: 'Settings', icon: 'settings', run: () => openSettings(ctx, 'general') },
    { separator: true },
    { label: 'Help and shortcuts', icon: 'circle-help', run: () => openSettings(ctx, 'help') },
  ], { placement: 'bottom-end' }),
  'shell.focus-search': ({ ctx }) => {
    if (ctx.env.isSidepanel) return openCommandPalette(ctx, {});
    const el = document.getElementById('search');
    el?.focus(); el?.select();
  },
  'shell.escape': ({ ctx }) => { if (ctx.state.panel) ctx.closePanel(); },
});

registerShortcuts([
  { keys: 'mod+k', action: 'shell.command', label: 'Search and commands', allowInInputs: true },
  { keys: '/', action: 'shell.focus-search', label: 'Search this view' },
  { keys: 'a', action: 'shell.add', label: 'Add a link' },
  { keys: 'mod+shift+a', action: 'shell.ask', label: 'Ask AI', allowInInputs: true },
  { keys: 'escape', action: 'shell.escape', label: 'Close panel', when: ctx => !!ctx.state.panel && !ctx.state.dialogs.length && !ctx.state.popover },
]);
