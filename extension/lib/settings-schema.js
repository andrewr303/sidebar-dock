// Defaults and helpers for library.settings keys added with the dashboard, themes and new tab. Top-level appearance keys
// sit beside the existing theme/accent/density; grouped keys (newTab, wallpaper, dashboard) are objects that
// store.updateSettings replaces whole, so always write them through patchGroup.

export const APPEARANCE_DEFAULTS = Object.freeze({
  skin: 'still',          // ui/themes.js THEMES ids
  theme: 'system',        // system | light | dark (the color mode)
  accent: 'blue',
  density: 'comfortable', // comfortable | compact
  fontSize: 'md',         // sm | md | lg | xl
  radius: 'default',      // sharp | default | round
  motion: 'system',       // system | reduced
  transparency: 'full',   // full | reduced (glass blur and translucency)
  favicons: true,         // real site icons in library lists (dashboard widgets always use them)
  sidebarWidth: 'default', // narrow | default | wide
});

export const NEWTAB_DEFAULTS = Object.freeze({
  view: 'dashboard',      // view a new tab and a bare index.html open: dashboard | all | inbox | notes | assistant
  search: true,           // unified search bar on the dashboard
  engine: 'default',      // default (browser's engine via chrome.search) | google | duckduckgo | bing | kagi | perplexity | brave
  greeting: true,
  name: '',               // name used in the greeting
  focusSearch: false,     // focus the dashboard search when a new tab opens
});

export const WALLPAPER_DEFAULTS = Object.freeze({
  kind: 'none',           // none | preset | color | image | url
  preset: 'aurora',       // ui/themes.js WALLPAPER_PRESETS ids
  color: '#1f2a44',
  url: '',                // https image URL
  attachmentId: '',       // uploaded image (IndexedDB attachment via store.saveAttachment)
  dim: 0,                 // 0..80 percent dark overlay
  blur: 0,                // 0..40 px
  scope: 'dashboard',     // dashboard | app (glass skin always uses app)
});

export const DASHBOARD_DEFAULTS = Object.freeze({
  widgetStyle: 'card',    // card | glass | flat
  gap: 'md',              // sm | md | lg
  header: true,           // board header (switcher, greeting, weather)
  weatherChip: true,
  stickies: true,         // floating sticky notes layer
});

const GROUP_DEFAULTS = { newTab: NEWTAB_DEFAULTS, wallpaper: WALLPAPER_DEFAULTS, dashboard: DASHBOARD_DEFAULTS };

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** Appearance values with defaults filled in (unknown values fall back to the default). */
export function appearanceOf(settings = {}) {
  const out = {};
  for (const [key, fallback] of Object.entries(APPEARANCE_DEFAULTS)) {
    const value = settings?.[key];
    out[key] = value === undefined || value === null || value === '' || typeof value !== typeof fallback ? fallback : value;
  }
  return out;
}

/** A grouped settings object (newTab, wallpaper, dashboard) merged over its defaults. */
export function settingsGroup(settings = {}, key) {
  const defaults = GROUP_DEFAULTS[key];
  if (!defaults) throw new Error(`Unknown settings group: ${key}`);
  const stored = isObject(settings?.[key]) ? settings[key] : {};
  return { ...defaults, ...stored };
}

/** Writes a patch into a grouped settings object without dropping its other keys. Returns the store promise. */
export function patchGroup(store, settings = {}, key, patch) {
  const current = isObject(settings?.[key]) ? settings[key] : {};
  return store.updateSettings({ [key]: { ...current, ...patch } });
}
