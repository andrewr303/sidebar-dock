// Pure routing rules for app.js: which views exist, which one a page opens on and what its tab is called.
import { settingsGroup } from '../lib/settings-schema.js';

export const MAIN_VIEWS = /^(dashboard|assistant|stickies|settings(?::[a-z-]+)?|all|inbox|favorites|notes|chats|tasks|highlights|map|archive|trash|duplicates|untagged|reminders|type:[a-z]+|collection:.+|tag:.+)$/;
export const isMainView = view => typeof view === 'string' && MAIN_VIEWS.test(view);
export const isSettingsView = view => typeof view === 'string' && /^settings(?::|$)/.test(view);
/** Views that draw their own page header, so the shell leaves out the top bar (search, Ask, Add). */
export const OWN_HEADER_VIEWS = Object.freeze(['dashboard', 'assistant']);
export const ownsHeader = view => OWN_HEADER_VIEWS.includes(view) || isSettingsView(view);
// Library addresses (search, tag, type or an open item) describe a list, so they open on All items, not the start page.
const LIBRARY_PARAMS = ['q', 'tag', 'type', 'item'];

/**
 * The start page from settings (newTab.view): any main view except Settings, and a collection only while it exists.
 * Falls back to the dashboard.
 */
export function startView(settings = {}, { hasCollection = () => true } = {}) {
  const view = settingsGroup(settings, 'newTab').view;
  if (!isMainView(view) || isSettingsView(view)) return 'dashboard';
  if (view.startsWith('collection:') && !hasCollection(view.slice(11))) return 'dashboard';
  return view;
}

/**
 * The view a page opens on. An explicit libraryView wins; the side panel otherwise starts on All items (its tabs decide
 * what shows); other library addresses mean All items; a bare index.html or the new tab opens the start page.
 */
export function bootView(params, settings = {}, { sidepanel = false, hasCollection } = {}) {
  const explicit = params?.get?.('libraryView');
  if (isMainView(explicit)) return explicit;
  if (sidepanel || LIBRARY_PARAMS.some(key => params?.get?.(key))) return 'all';
  return startView(settings, { hasCollection });
}

/** The browser tab title: the new tab keeps Chrome's own name; the full tab names the view. */
export function documentTitle({ newtab = false, sidepanel = false, label = '' } = {}) {
  if (newtab) return 'New Tab';
  if (sidepanel || !label) return 'Still';
  return `${label} · Still`;
}
