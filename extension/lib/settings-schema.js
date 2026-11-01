// Defaults and helpers for library.settings keys added with the dashboard, themes and new tab. Top-level appearance keys
// sit beside the existing theme/accent/density; grouped keys (newTab, wallpaper, dashboard) are objects that
// store.updateSettings replaces whole, so always write them through patchGroup. Readers get values that are always
// usable: a stored value of the wrong type, outside its choices or out of range reads as the default.
import { THEME_IDS, FONT_SIZES, RADII, SIDEBAR_WIDTHS, WIDGET_STYLES, WALLPAPER_PRESETS } from '../ui/themes.js';

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

/** Allowed values per key: an array of choices, or [min, max] for numbers. Keys without a rule only need the type. */
export const SETTINGS_CHOICES = Object.freeze({
  appearance: {
    skin: THEME_IDS,
    theme: ['system', 'light', 'dark'],
    density: ['comfortable', 'compact'],
    fontSize: FONT_SIZES.map(size => size.value),
    radius: RADII.map(radius => radius.value),
    motion: ['system', 'reduced'],
    transparency: ['full', 'reduced'],
    sidebarWidth: SIDEBAR_WIDTHS.map(width => width.value),
  },
  newTab: {
    engine: ['default', 'google', 'duckduckgo', 'bing', 'kagi', 'perplexity', 'brave'],
  },
  wallpaper: {
    kind: ['none', 'preset', 'color', 'image', 'url'],
    preset: WALLPAPER_PRESETS.map(preset => preset.id),
    scope: ['dashboard', 'app'],
    dim: [0, 80],
    blur: [0, 40],
  },
  dashboard: {
    widgetStyle: WIDGET_STYLES.map(style => style.value),
    gap: ['sm', 'md', 'lg'],
  },
});

const GROUP_DEFAULTS = { newTab: NEWTAB_DEFAULTS, wallpaper: WALLPAPER_DEFAULTS, dashboard: DASHBOARD_DEFAULTS };

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

// One value read against its default and rule: wrong type, a choice that is not offered or a non-finite number falls
// back to the default; numbers with a range are clamped into it.
function readValue(value, fallback, rule) {
  if (value === undefined || value === null || typeof value !== typeof fallback) return fallback;
  if (typeof fallback === 'string' && value === '' && fallback !== '') return fallback;
  if (typeof fallback === 'number') {
    if (!Number.isFinite(value)) return fallback;
    return Array.isArray(rule) && rule.length === 2 && typeof rule[0] === 'number' ? Math.min(rule[1], Math.max(rule[0], value)) : value;
  }
  if (Array.isArray(rule) && typeof rule[0] === 'string' && !rule.includes(value)) return fallback;
  return value;
}

function readAll(stored, defaults, rules = {}) {
  const out = {};
  for (const [key, fallback] of Object.entries(defaults)) out[key] = readValue(stored?.[key], fallback, rules[key]);
  return out;
}

/** Appearance values with defaults filled in (unknown values fall back to the default). */
export function appearanceOf(settings = {}) {
  return readAll(settings, APPEARANCE_DEFAULTS, SETTINGS_CHOICES.appearance);
}

/**
 * A grouped settings object (newTab, wallpaper, dashboard) merged over its defaults. Keys the group does not define are
 * kept as stored, so a newer build's settings survive a round trip through an older reader.
 */
export function settingsGroup(settings = {}, key) {
  const defaults = GROUP_DEFAULTS[key];
  if (!defaults) throw new Error(`Unknown settings group: ${key}`);
  const stored = isObject(settings?.[key]) ? settings[key] : {};
  return { ...stored, ...readAll(stored, defaults, SETTINGS_CHOICES[key]) };
}

/** Writes a patch into a grouped settings object without dropping its other keys. Returns the store promise. */
export function patchGroup(store, settings = {}, key, patch) {
  const current = isObject(settings?.[key]) ? settings[key] : {};
  return store.updateSettings({ [key]: { ...current, ...patch } });
}
