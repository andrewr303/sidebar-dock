// Still bootstrap: builds the shared ctx, loads the library and starts the render loop.
// Feature modules register their actions, dialogs, popovers, mounts and shortcuts at import time
// and may export init(ctx) for one-time wiring (listeners, timers).
import * as store from './lib/store.js';
import * as integrations from './lib/integrations.js';
import { SEED_LIBRARY } from './lib/seed.js';
import { createRuntime, dispatch, registerActions, modKey } from './ui/runtime.js';
import { initOverlays, openDialog, closeDialog, updateDialog, openPopover, closePopover, openMenu, confirm, prompt, toast } from './ui/overlay.js';
import { createSelectors } from './ui/selectors.js';
import { prefs, cacheAppearance, cachedAppearance } from './ui/prefs.js';
import { appearanceAttributes, appearanceSnapshot, appearanceChanged, wallpaperStyle } from './ui/appearance.js';
import { isMainView, isSettingsView, bootView, startView, documentTitle } from './ui/routes.js';
import { settingsGroup } from './lib/settings-schema.js';
import { renderApp, viewTitle } from './ui/shell.js';
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
import * as assistantPage from './ui/assistant-page.js';

const params = new URLSearchParams(location.search);
const isExtension = !!globalThis.chrome?.runtime?.id;
const isSidepanel = params.get('view') === 'sidepanel';
// The new tab page (newtab.html, Chrome's new tab override) is the full-tab app with an empty address bar: it never
// writes its URL, so Chrome keeps showing a blank omnibox like any other new tab.
const isNewtab = document.documentElement.dataset.entry === 'newtab';
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

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
    if (!isMainView(view)) view = 'all';
    // The side panel has no room for the full-screen views: the assistant is its Ask tab, settings cover the panel,
    // and the dashboard and sticky notes open in a tab.
    if (isSidepanel && sidePanelRoute(view)) return;
    closePopover({ restore: false });
    const changed = view !== state.view;
    if (view === 'assistant' && !isSidepanel && state.panel?.kind === 'ai') state.panel = null; // the page is the assistant
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
const hasCollection = id => !!library?.collections?.some(c => c.id === id && !c.deletedAt);
ctx.startView = () => startView(library?.settings, { hasCollection });

const root = document.getElementById('app');
const runtime = createRuntime({ root, ctx, view: renderApp });
Object.assign(ctx, { render: runtime.render, renderNow: runtime.renderNow, nextFrame: runtime.nextFrame, onRendered: runtime.onRendered });
initOverlays(ctx, runtime);

function syncUrl() {
  if (isSidepanel || isNewtab) return;
  const url = new URL(location.href);
  for (const key of ['libraryView', 'q', 'tag', 'type', 'item']) url.searchParams.delete(key);
  // A conversation address belongs to the assistant view only.
  if (state.view !== 'assistant') url.searchParams.delete('conversation');
  // Always explicit: a bare index.html opens the start page, which is not All items any more.
  url.searchParams.set('libraryView', state.view);
  if (state.query) url.searchParams.set('q', state.query);
  if (state.tagFilter) url.searchParams.set('tag', state.tagFilter);
  if (state.typeFilter !== 'all') url.searchParams.set('type', state.typeFilter);
  if (state.panel?.kind === 'item') url.searchParams.set('item', state.panel.id);
  if (url.href !== location.href) history.replaceState(null, '', url);
}
ctx.syncUrl = syncUrl;

// Uploaded wallpapers live in IndexedDB; the layer shows them through one object URL, revoked when it is replaced.
// The URL is handed out only once its image is decoded, so the layer paints it at once instead of blank for a few frames.
const wallpaperImage = { id: '', url: '', loading: null, token: 0 };
const decodeImage = url => { const img = new Image(); img.src = url; return img.decode().catch(() => {}); };
function loadWallpaperImage(id) {
  if (wallpaperImage.id === id && (wallpaperImage.url || wallpaperImage.loading)) return wallpaperImage.loading || Promise.resolve(wallpaperImage.url);
  const token = ++wallpaperImage.token;
  wallpaperImage.id = id;
  wallpaperImage.loading = Promise.resolve().then(() => store.getAttachment(id)).then(async record => {
    if (token !== wallpaperImage.token) return '';
    const blob = record?.blob;
    const url = blob instanceof Blob && /^image\//.test(blob.type || record.mime || '') ? URL.createObjectURL(blob) : '';
    // The side panel shows the layer only with Liquid Glass; elsewhere there it would decode an image nothing paints.
    if (url && (!isSidepanel || document.documentElement.dataset.skin === 'glass')) await decodeImage(url);
    if (token !== wallpaperImage.token) { if (url) URL.revokeObjectURL(url); return ''; }
    if (wallpaperImage.url) URL.revokeObjectURL(wallpaperImage.url);
    Object.assign(wallpaperImage, { url, loading: null });
    return url;
  }, error => {
    console.warn('[still] wallpaper image unavailable', error?.message);
    if (token === wallpaperImage.token) wallpaperImage.loading = null;
    return '';
  });
  return wallpaperImage.loading;
}
function releaseWallpaperImage() {
  wallpaperImage.token++;
  if (wallpaperImage.url) URL.revokeObjectURL(wallpaperImage.url);
  Object.assign(wallpaperImage, { id: '', url: '', loading: null });
}
// Start reading a cached uploaded wallpaper while the library loads, so it appears with the first frame or soon after.
{
  const cached = cachedAppearance();
  if (cached?.attrs?.['data-wallpaper'] === 'on' && cached.wallpaper?.attachmentId) loadWallpaperImage(String(cached.wallpaper.attachmentId));
}

function paintWallpaper(on, { image, dim, blur, attachmentId }) {
  const html = document.documentElement;
  if (!on) {
    for (const name of ['--wallpaper-image', '--wallpaper-dim', '--wallpaper-blur']) html.style.removeProperty(name);
    releaseWallpaperImage();
    return;
  }
  html.style.setProperty('--wallpaper-dim', String(dim));
  html.style.setProperty('--wallpaper-blur', `${blur}px`);
  if (!attachmentId) {
    releaseWallpaperImage();
    if (image) html.style.setProperty('--wallpaper-image', image); else html.style.removeProperty('--wallpaper-image');
    return;
  }
  if (wallpaperImage.id === attachmentId && wallpaperImage.url) { html.style.setProperty('--wallpaper-image', `url("${wallpaperImage.url}")`); return; }
  loadWallpaperImage(attachmentId).then(url => {
    // A newer wallpaper may have been chosen meanwhile.
    if (wallpaperImage.id !== attachmentId) return;
    if (url) { html.style.setProperty('--wallpaper-image', `url("${url}")`); return; }
    // The image is gone (deleted or unreadable): show no wallpaper, and do not pre-paint one on the next page either.
    html.dataset.wallpaper = 'off';
    html.style.removeProperty('--wallpaper-image');
    const cached = cachedAppearance();
    if (cached?.attrs) cacheAppearance({ ...cached, attrs: { ...cached.attrs, 'data-wallpaper': 'off' } });
  });
}

/** Applies skin, mode and every appearance scale to <html>, paints the wallpaper layer and caches it for theme-boot.js. */
function applyAppearance() {
  const values = library?.settings || {};
  const attrs = appearanceAttributes(values, { prefersDark: darkQuery.matches });
  const html = document.documentElement;
  if (['data-theme', 'data-skin'].some(name => html.hasAttribute(name) && html.getAttribute(name) !== attrs[name])) {
    // Swap every color at once instead of animating each surface's transition.
    html.classList.add('theme-switching');
    requestAnimationFrame(() => requestAnimationFrame(() => html.classList.remove('theme-switching')));
  }
  for (const [name, value] of Object.entries(attrs)) if (html.getAttribute(name) !== value) html.setAttribute(name, value);
  html.dataset.surface = isSidepanel ? 'side' : 'full';
  paintWallpaper(attrs['data-wallpaper'] === 'on', wallpaperStyle(settingsGroup(values, 'wallpaper'), attrs['data-theme']));
  cacheAppearance(appearanceSnapshot(values));
}
darkQuery.addEventListener('change', () => { applyAppearance(); });
ctx.applyAppearance = applyAppearance;

/** The full-tab address of a view (index.html always names it, so the start page setting never changes its meaning). */
function fullTabUrl(view, extra = {}) {
  const url = new URL(isExtension ? chrome.runtime.getURL('index.html') : new URL('index.html', location.href));
  url.searchParams.set('libraryView', isMainView(view) ? view : 'all');
  for (const [key, value] of Object.entries(extra)) if (value) url.searchParams.set(key, value);
  return url.href;
}
async function openTab(url, { active = true } = {}) {
  if (isExtension) await chrome.tabs.create({ ...(url ? { url } : {}), active });
  else window.open(url || new URL('newtab.html', location.href).href, '_blank', 'noopener');
}
/** Opens a view in a new tab. The dashboard, when it is the start page, opens as a plain new tab (no address shown). */
function openViewInTab(view, options) {
  if (view === 'dashboard' && ctx.startView() === 'dashboard') return openTab('', options);
  return openTab(fullTabUrl(view), options);
}
ctx.openViewInTab = openViewInTab;

// Side panel stand-ins for views it cannot show; returns true when the view was handled here.
let routingSettings = false;
function sidePanelRoute(view) {
  if (view === 'assistant') {
    Object.assign(state, { panel: null, sideTab: 'ask' });
    ctx.render();
    return true;
  }
  if (isSettingsView(view) && !routingSettings && typeof settings.openSettings === 'function') {
    routingSettings = true;
    try { settings.openSettings(ctx, view.slice(9) || 'general'); } finally { routingSettings = false; }
    return true;
  }
  if (view === 'dashboard' || view === 'stickies') {
    ctx.run(() => openViewInTab(view));
    return true;
  }
  return false;
}

registerActions({
  'app.navigate': ({ data }) => ctx.navigate(data.view, { keep: data.keep === 'true' }),
  'app.open-item': ({ data, event }) => {
    if (event?.target?.closest?.('a[href]:not([data-action])')) return;
    ctx.openItem(data.id, { tab: data.tab || 'details' });
  },
  'app.close-panel': () => ctx.closePanel(),
  'app.open-full': async () => {
    // Carry the side panel's context into the full tab: the open item, the Ask conversation, Notes or the library view.
    const tab = state.panel?.kind === 'ai' ? 'ask' : state.sideTab;
    const view = state.panel?.kind === 'settings' ? 'settings'
      : state.panel?.kind === 'item' ? state.view
      : tab === 'ask' ? 'assistant' : tab === 'notes' ? 'notes' : state.view;
    const item = state.panel?.kind === 'item' ? state.panel.id : '';
    // The full-screen assistant opens the same conversation (assistant-page.js reads the conversation parameter).
    const conversation = view === 'assistant' ? aiPanel.conversationIdOf(state.ai) : '';
    await openTab(fullTabUrl(view, { q: view === state.view ? state.query : '', item, conversation }));
  },
  // Opens a main view: navigates in place in a full tab; from the side panel opens it in a tab (the Ask tab for the assistant).
  'app.open-view': ({ data, event }) => {
    const view = isMainView(data.view) ? data.view : 'all';
    if (!isSidepanel) {
      if (event?.metaKey || event?.ctrlKey) return openViewInTab(view, { active: false });
      return ctx.navigate(view);
    }
    if (sidePanelRoute(view)) return;
    return openViewInTab(view);
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
  state.view = bootView(params, library?.settings, { sidepanel: isSidepanel, hasCollection });
  if (params.get('q')) state.query = params.get('q');
  if (params.get('tag')) state.tagFilter = params.get('tag');
  if (params.get('type') && (store.ITEM_TYPES.includes(params.get('type')) || ['link', 'media'].includes(params.get('type')))) state.typeFilter = params.get('type');
  if (isSidepanel) {
    // Full-screen views have side panel stand-ins: the Ask tab for the assistant, the Library root for the others.
    const askTab = state.view === 'assistant';
    if (askTab || state.view === 'dashboard' || state.view === 'stickies' || isSettingsView(state.view)) state.view = 'all';
    const deepLink = state.view !== 'all' && state.view !== 'notes';
    // "Start on This page" (Settings > General) picks the tab a plain open lands on; off, the panel starts on the library.
    const pageFirst = isExtension && library?.settings?.startOnPage !== false;
    state.sideTab = params.get('tab') || (askTab ? 'ask' : deepLink ? 'library' : state.view === 'notes' ? 'notes' : pageFirst ? 'page' : 'library');
    if (deepLink) state.sideStack = [state.view];
  }
  const item = params.get('item');
  if (item && library.items.some(i => i.id === item)) state.panel = { kind: 'item', id: item, tab: 'details' };
}

const modules = [sidebar, command, collections, libraryView, detail, map, quickAdd, pickers, page, notes, noteEditor, aiPanel, settings, dashboard, stickies, assistantPage];

/** Keeps the browser tab title in step with the view (the new tab always reads "New Tab"). */
function updateTitle() {
  let label = '';
  try { label = state.boot.ready && !isSidepanel && !isNewtab ? viewTitle(ctx) : ''; } catch { label = ''; }
  const title = documentTitle({ newtab: isNewtab, sidepanel: isSidepanel, label });
  if (document.title !== title) document.title = title;
}
runtime.onRendered(updateTitle);

// The dashboard store and its widget cache load beside the library (the side panel never shows the dashboard).
const dashboardReady = isSidepanel ? Promise.resolve()
  : Promise.resolve().then(() => dashboard.preload?.()).catch(error => console.warn('[still] dashboard data not preloaded', error));
const settle = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))]);
// Where skins.css paints the wallpaper layer: behind the dashboard, behind the whole full tab with the "app" scope, and
// everywhere with Liquid Glass.
function wallpaperShows() {
  const { wallpaper, skin, wallpaperScope } = document.documentElement.dataset;
  return wallpaper === 'on' && (skin === 'glass' || state.view === 'dashboard' || (wallpaperScope === 'app' && !isSidepanel));
}

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
  // Paint the dashboard with its data instead of a loading frame (bounded, so a stuck store never blocks the app).
  if (state.view === 'dashboard') await settle(dashboardReady, 1500);
  // Likewise an uploaded wallpaper the first frame shows, so the page does not paint on a plain background first and the
  // image pop in after it. Where the layer is hidden (the side panel and other views with the dashboard scope) nothing waits.
  if (wallpaperImage.loading && wallpaperShows()) await settle(wallpaperImage.loading, 300);
  store.subscribe(next => {
    const looksChanged = appearanceChanged(library?.settings, next?.settings);
    library = next;
    if (looksChanged) applyAppearance();
    if (state.panel?.kind === 'item' && !next.items.some(i => i.id === state.panel.id)) state.panel = null;
    for (const id of [...state.selection]) if (!next.items.some(i => i.id === id)) state.selection.delete(id);
    runtime.render();
  });
  state.boot.ready = true;
  root.removeAttribute('aria-busy');
  root.innerHTML = '';
  runtime.renderNow();
  performance.mark?.('still:first-render');

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

// Every new tab is a Still page, so only one page at a time syncs with the local bridge: the pages queue for a Web Lock
// and the holder runs the loop, sharing its status with the others; when it closes, the next page in line takes over.
const bridgeStatus = globalThis.BroadcastChannel ? new BroadcastChannel('still.bridge.status.v1') : null;
bridgeStatus?.addEventListener('message', event => {
  if (ctx.bridgeLeader || !event.data || typeof event.data !== 'object') return;
  state.bridge = event.data;
});
async function startBridgeSync() {
  try {
    const status = await integrations.getIntegrationSettings();
    if (!status.bridgeEnabled) return;
    ctx.stopBridgeSync?.();
    let stopLoop = null;
    let release = null;
    const controller = new AbortController();
    const lead = () => {
      ctx.bridgeLeader = true;
      stopLoop = integrations.startBridgeSync({
        onStatus: info => { state.bridge = info; bridgeStatus?.postMessage(info); },
        onChange: () => runtime.render(),
      });
    };
    const stop = () => {
      controller.abort();
      stopLoop?.();
      release?.();
      ctx.bridgeLeader = false;
      if (ctx.stopBridgeSync === stop) ctx.stopBridgeSync = null;
    };
    ctx.stopBridgeSync = stop;
    if (!globalThis.navigator?.locks) { lead(); return; }
    navigator.locks.request('still.bridge.leader.v1', { signal: controller.signal }, async () => {
      // The bridge may have been turned off in another page while this one waited in line.
      const enabled = !controller.signal.aborted && (await integrations.getIntegrationSettings()).bridgeEnabled;
      if (!enabled || controller.signal.aborted) return;
      await new Promise(resolve => { release = resolve; lead(); });
    }).catch(error => { if (error?.name !== 'AbortError') console.warn('[still] bridge sync lock', error); });
  } catch (error) { console.warn('[still] bridge sync not started', error); }
}
ctx.startBridgeSync = startBridgeSync;

boot();
