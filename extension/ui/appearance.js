// Pure appearance math shared by app.js (live), prefs.js (cache) and the tests: library settings -> the attributes on
// <html> and the wallpaper layer's CSS. theme-boot.js replays the cached result before any module loads, so a new tab
// paints with the right skin, mode, font size and wallpaper on its first frame.
import { THEME_IDS, FONT_SIZES, RADII, themeById, resolveMode, wallpaperPreset } from './themes.js';
import { appearanceOf, settingsGroup } from '../lib/settings-schema.js';

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : min));
const HEX = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
// Accent names are plain words that tokens.css maps to colors; violet is a retired name that now means the default.
const accentOf = value => (/^[a-z]{2,16}$/.test(value || '') && value !== 'violet' ? value : 'blue');

/** A wallpaper https URL as a CSS url() value, or '' when it is not a plain https address. */
export function cssUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { return ''; }
  if (url.protocol !== 'https:' || url.username || url.password) return '';
  // Quote and escape so the address can never close the url() or the declaration.
  return `url("${url.href.replace(/["\\\n\r\f]/g, char => `\\${char.charCodeAt(0).toString(16)} `)}")`;
}

/** Whether the wallpaper group has a usable source (an uploaded image counts even before its object URL exists). */
export function wallpaperActive(wallpaper = {}) {
  switch (wallpaper.kind) {
    case 'preset': return true;
    case 'color': return HEX.test(String(wallpaper.color || ''));
    case 'url': return !!cssUrl(wallpaper.url);
    case 'image': return !!wallpaper.attachmentId;
    default: return false;
  }
}

/**
 * The wallpaper layer for a resolved mode: { image, dim, blur, attachmentId }. image is a CSS background-image value
 * ('' for none, and for uploaded images, which app.js resolves to an object URL); dim is 0..0.8; blur is px.
 */
export function wallpaperStyle(wallpaper = {}, mode = 'light') {
  const dim = clamp(wallpaper.dim, 0, 80) / 100;
  const blur = Math.round(clamp(wallpaper.blur, 0, 40));
  let image = '';
  if (wallpaper.kind === 'preset') {
    const preset = wallpaperPreset(wallpaper.preset);
    image = mode === 'dark' && preset.dark ? preset.dark : preset.css;
  } else if (wallpaper.kind === 'color' && HEX.test(String(wallpaper.color || ''))) {
    image = `linear-gradient(${wallpaper.color}, ${wallpaper.color})`;
  } else if (wallpaper.kind === 'url') {
    image = cssUrl(wallpaper.url);
  }
  return { image, dim, blur, attachmentId: wallpaper.kind === 'image' ? String(wallpaper.attachmentId || '') : '' };
}

/**
 * Every appearance attribute for <html> from library settings. prefersDark resolves the 'system' mode. Single-mode
 * skins (White, Midnight) force their mode. The glass skin always paints behind the whole app; with no wallpaper chosen
 * skins.css draws its own ambient background, so data-wallpaper stays off.
 */
export function appearanceAttributes(settings = {}, { prefersDark = false } = {}) {
  const look = appearanceOf(settings);
  const wallpaper = settingsGroup(settings, 'wallpaper');
  const skin = oneOf(look.skin, THEME_IDS, 'still');
  return {
    'data-skin': skin,
    'data-theme': resolveMode(skin, look.theme, prefersDark),
    'data-accent': accentOf(look.accent),
    'data-density': oneOf(look.density, ['comfortable', 'compact'], 'comfortable'),
    'data-font-size': oneOf(look.fontSize, FONT_SIZES.map(size => size.value), 'md'),
    'data-radius': oneOf(look.radius, RADII.map(radius => radius.value), 'default'),
    'data-motion': oneOf(look.motion, ['system', 'reduced'], 'system'),
    'data-transparency': oneOf(look.transparency, ['full', 'reduced'], 'full'),
    'data-sidebar-width': oneOf(look.sidebarWidth, ['narrow', 'default', 'wide'], 'default'),
    'data-wallpaper': wallpaperActive(wallpaper) ? 'on' : 'off',
    'data-wallpaper-scope': skin === 'glass' || wallpaper.scope === 'app' ? 'app' : 'dashboard',
  };
}

/** The mode preference theme-boot.js resolves before paint: a single-mode skin's mode, else the user's choice. */
export function modePreference(settings = {}) {
  const look = appearanceOf(settings);
  const { modes } = themeById(oneOf(look.skin, THEME_IDS, 'still'));
  return modes.length === 1 ? modes[0] : oneOf(look.theme, ['light', 'dark'], 'system');
}

/**
 * What prefs.cacheAppearance stores for theme-boot.js: the attributes (minus the resolved mode), the mode preference
 * and the wallpaper CSS for both modes. Uploaded images are never cached (object URLs die with the page).
 */
export function appearanceSnapshot(settings = {}) {
  const { 'data-theme': _mode, ...attrs } = appearanceAttributes(settings);
  const wallpaper = settingsGroup(settings, 'wallpaper');
  const light = wallpaperStyle(wallpaper, 'light');
  const dark = wallpaperStyle(wallpaper, 'dark');
  return {
    v: 2, theme: modePreference(settings), attrs,
    wallpaper: { light: light.image, dark: dark.image, dim: light.dim, blur: light.blur, attachmentId: light.attachmentId },
  };
}

/** Settings keys whose change means the appearance must be applied again. */
export const APPEARANCE_KEYS = Object.freeze(['skin', 'theme', 'accent', 'density', 'fontSize', 'radius', 'motion', 'transparency', 'sidebarWidth', 'wallpaper']);
export const appearanceChanged = (before = {}, after = {}) =>
  APPEARANCE_KEYS.some(key => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null));
