// Still bootstrap: builds the shared ctx, loads the library and starts the render loop.
// Feature modules register their actions, dialogs, popovers, mounts and shortcuts at import time
// and may export init(ctx) for one-time wiring (listeners, timers).
import * as store from './lib/store.js';
import * as integrations from './lib/integrations.js';
import { SEED_LIBRARY } from './lib/seed.js';
import { createRuntime, dispatch, registerActions, modKey } from './ui/runtime.js';
import { initOverlays, openDialog, closeDialog, updateDialog, openPopover, closePopover, openMenu, confirm, prompt, toast } from './ui/overlay.js';
import { createSelectors } from './ui/selectors.js';
import { prefs, cacheAppearance } from './ui/prefs.js';
import { renderApp } from './ui/shell.js';
import * as sidebar from './ui/sidebar.js';
import * as command from './ui/command.js';
import * as collections from './ui/collections.js';
import * as libraryView from './ui/library.js';
import * as detail from './ui/detail.js';
import * as map from './ui/map.js';
import * as quickAdd from './ui/quick-add.js';
import * as pickers from './ui/pickers.js';
import * as page from './ui/page.js';
import * as notes from './ui/notes.js';
import * as noteEditor from './ui/note-editor.js';
import * as aiPanel from './ui/ai-panel.js';
import * as settings from './ui/settings.js';
import * as dashboard from './ui/dashboard/index.js';
import * as stickies from './ui/stickies.js';

const params = new URLSearchParams(location.search);
const isExtension = !!globalThis.chrome?.runtime?.id;
const isSidepanel = params.get('view') === 'sidepanel';
const isNewtab = document.documentElement.dataset.entry === 'newtab';
const MAIN_VIEWS = /^(dashboard|assistant|stickies|settings(?::[a-z-]+)?|all|inbox|favorites|notes|tasks|highlights|map|archive|trash|duplicates|untagged|reminders|type:[a-z]+|collection:.+|tag:.+)$/;

let library = null;
const state = {
  view: 'all', query: '', sort: 'newest', typeFilter: 'all', tagFilter: '',
  selection: new Set(), selectMode: false,
  panel: null, sideTab: 'page', sideStack: [],
  dialogs: [], popover: null,
  page: null, notes: { scope: 'all', collectionId: '', noteId: null, query: '', mode: 'list', sort: 'updated' },
  ai: {}, capture: null, boot: { ready: false, error: null },
};

const ctx = {
  state,
  get library() { return library; },
  store,
  integrations,
  env: { isExtension, isSidepanel, isNewtab, isMac: modKey === '⌘', modKey },
  prefs,
  ai: undefined,
  dispatch: (name, args = {}) => dispatch(name, { ctx, el: document.body, data: {}, ...args }),
  async run(fn) {
    try { return await fn(); } catch (error) {
      console.error(error);
      toast(error?.message || 'Something went wrong. Your library is unchanged.', { tone: 'danger' });
      return undefined;
    }
  },
  toast, confirm, prompt, openDialog, closeDialog, updateDialog, openPopover, closePopover, openMenu,
  set(patch) { Object.assign(state, patch); ctx.render(); },
  navigate(view, { keep = false, item = null } = {}) {
    if (!MAIN_VIEWS.test(view)) view = 'all';
    closePopover({ restore: false });
    const changed = view !== state.view;
    state.view = view;
    if (changed && !keep) Object.assign(state, { query: '', typeFilter: 'all', tagFilter: '', selectMode: false });
    state.selection = new Set();
    if (isSidepanel) {
      state.sideTab = view === 'notes' ? 'notes' : 'library';
      if (changed && view !== 'notes') state.sideStack = view === 'all' ? [] : [...state.sideStack.filter(v => v !== view), view].slice(-8);
      state.panel = null;
    }
    if (item) ctx.openItem(item); else if (isSidepanel) state.panel = null;
    syncUrl();
    ctx.render();
  },
  openItem(id, { tab = 'details' } = {}) {
    if (!id || !ctx.select.byId(id)) { toast('That item is no longer in your library.', { tone: 'danger' }); return; }
    state.panel = { kind: 'item', id, tab };
    syncUrl();
    ctx.render();
  },
  closePanel() { state.panel = null; syncUrl(); ctx.render(); },
  async chrome(type, payload = {}) {
    if (!isExtension) throw new Error('This needs Still installed as a Chrome extension.');
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (!response?.ok) throw new Error(response?.error || 'Chrome could not complete that action.');
    return response.result;
  },
};
ctx.select = createSelectors(() => library, () => prefs.all());

const root = document.getElementById('app');
const runtime = createRuntime({ root, ctx, view: renderApp });
Object.assign(ctx, { render: runtime.render, renderNow: runtime.renderNow, nextFrame: runtime.nextFrame, onRendered: runtime.onRendered });
initOverlays(ctx, runtime);

function syncUrl() {
  if (isSidepanel) return;
  const url = new URL(location.href);
  for (const key of ['libraryView', 'q', 'tag', 'type', 'item']) url.searchParams.delete(key);
  if (state.view !== 'all') url.searchParams.set('libraryView', state.view);
  if (state.query) url.searchParams.set('q', state.query);
  if (state.tagFilter) url.searchParams.set('tag', state.tagFilter);
  if (state.typeFilter !== 'all') url.searchParams.set('type', state.typeFilter);
  if (state.panel?.kind === 'item') url.searchParams.set('item', state.panel.id);
  if (url.href !== location.href) history.replaceState(null, '', url);
}
ctx.syncUrl = syncUrl;

function applyAppearance() {
  const s = library?.settings || {};
  const theme = ['light', 'dark'].includes(s.theme) ? s.theme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const html = document.documentElement;
  if (html.dataset.theme && html.dataset.theme !== theme) {
    // Swap every color at once instead of animating each surface's transition.
    html.classList.add('theme-switching');
    requestAnimationFrame(() => requestAnimationFrame(() => html.classList.remove('theme-switching')));
  }
  html.dataset.theme = theme;
  html.dataset.accent = s.accent && s.accent !== 'violet' ? s.accent : 'blue';
  html.dataset.density = s.density || 'comfortable';
  html.dataset.surface = isSidepanel ? 'side' : 'full';
  cacheAppearance({ theme: s.theme || 'system', accent: html.dataset.accent, density: s.density || 'comfortable' });
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyAppearance(); });
ctx.applyAppearance = applyAppearance;

registerActions({
  'app.navigate': ({ data }) => ctx.navigate(data.view, { keep: data.keep === 'true' }),
  'app.open-item': ({ data, event }) => {
    if (event?.target?.closest?.('a[href]:not([data-action])')) return;
    ctx.openItem(data.id, { tab: data.tab || 'details' });
  },
  'app.close-panel': () => ctx.closePanel(),
  'app.open-full': async () => {
    const url = new URL(isExtension ? chrome.runtime.getURL('index.html') : new URL('index.html', location.href));
    if (state.view !== 'all') url.searchParams.set('libraryView', state.view);
    if (state.query) url.searchParams.set('q', state.query);
    if (state.panel?.kind === 'item') url.searchParams.set('item', state.panel.id);
    if (isExtension) await chrome.tabs.create({ url: url.href }); else window.open(url.href, '_blank', 'noopener');
  },
  'app.open-url': async ({ data, event }) => {
    const href = data.url;
    if (!/^https?:/i.test(href || '')) return;
    if (isExtension) await chrome.tabs.create({ url: href, active: !(event?.metaKey || event?.ctrlKey) });
    else window.open(href, '_blank', 'noopener');
  },
  'app.copy': async ({ data }) => { await navigator.clipboard.writeText(data.text || ''); toast(data.done || 'Copied'); },
  'app.retry-boot': () => location.reload(),
});

function applyBootParams() {
  const view = params.get('libraryView');
  if (view && MAIN_VIEWS.test(view)) state.view = view;
  if (params.get('q')) state.query = params.get('q');
  if (params.get('tag')) state.tagFilter = params.get('tag');
  if (params.get('type') && (store.ITEM_TYPES.includes(params.get('type')) || ['link', 'media'].includes(params.get('type')))) state.typeFilter = params.get('type');
  if (isSidepanel) {
    const deepLink = state.view !== 'all' && state.view !== 'notes';
    state.sideTab = params.get('tab') || (deepLink ? 'library' : state.view === 'notes' ? 'notes' : isExtension ? 'page' : 'library');
    if (deepLink) state.sideStack = [state.view];
  }
  const item = params.get('item');
  if (item && library.items.some(i => i.id === item)) state.panel = { kind: 'item', id: item, tab: 'details' };
}

const modules = [sidebar, command, collections, libraryView, detail, map, quickAdd, pickers, page, notes, noteEditor, aiPanel, settings, dashboard, stickies];

async function boot() {
  try {
    library = await store.loadLibrary(SEED_LIBRARY);
  } catch (error) {
    console.error(error);
    state.boot.error = error?.message || 'Your library could not be opened.';
    root.removeAttribute('aria-busy');
    root.innerHTML = '';
    runtime.render();
    return;
  }
  applyAppearance();
  applyBootParams();
  store.subscribe(next => {
    const themeChanged = ['theme', 'accent', 'density'].some(k => next?.settings?.[k] !== library?.settings?.[k]);
    library = next;
    if (themeChanged) applyAppearance();
    if (state.panel?.kind === 'item' && !next.items.some(i => i.id === state.panel.id)) state.panel = null;
    for (const id of [...state.selection]) if (!next.items.some(i => i.id === id)) state.selection.delete(id);
    runtime.render();
  });
  state.boot.ready = true;
  root.removeAttribute('aria-busy');
  root.innerHTML = '';
  runtime.renderNow();

  try {
    const ai = await import('./lib/ai/index.js');
    ai.init?.({ store, getLibrary: () => library, integrations, onLibraryChange: fn => store.subscribe(fn) });
    ctx.ai = ai;
  } catch (error) { console.warn('[still] AI engine unavailable', error); }

  for (const mod of modules) {
    try { await mod.init?.(ctx); } catch (error) { console.error('[still] module init failed', error); }
  }
  startBridgeSync();
  if (isExtension) chrome.runtime.onMessage?.addListener(message => {
    if (message?.type === 'still:full-page-progress') { state.capture = { ...(state.capture || {}), ...message }; runtime.render(); }
  });
  runtime.render();
}

async function startBridgeSync() {
  try {
    const status = await integrations.getIntegrationSettings();
    if (!status.bridgeEnabled) return;
    ctx.stopBridgeSync?.();
    ctx.stopBridgeSync = integrations.startBridgeSync({
      onStatus: info => { state.bridge = info; },
      onChange: () => runtime.render(),
    });
  } catch (error) { console.warn('[still] bridge sync not started', error); }
}
ctx.startBridgeSync = startBridgeSync;

boot();
