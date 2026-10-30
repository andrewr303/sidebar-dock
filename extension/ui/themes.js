// Theme ("skin") and wallpaper catalogue. A skin recolors every surface (sidebar, full tab, side panel, dashboard) through
// the semantic tokens in styles/skins.css; the color mode (light/dark/system) still applies unless the skin has one mode.
// <html data-skin="<id>" data-theme="light|dark"> is set by theme-boot.js before paint and app.js afterwards.

export const THEMES = Object.freeze([
  { id: 'still', label: 'Still', description: 'The original warm, matte look.', modes: ['light', 'dark'],
    swatches: { light: ['#f7f6f3', '#ffffff', '#0d74ce', '#1f1f1f'], dark: ['#171717', '#202020', '#5eb1ef', '#ededed'] } },
  { id: 'white', label: 'White', description: 'Pure white surfaces with crisp hairlines.', modes: ['light'],
    swatches: { light: ['#ffffff', '#ffffff', '#0d74ce', '#111111'] } },
  { id: 'glass', label: 'Liquid Glass', description: 'Frosted, translucent panels over a soft ambient wallpaper.', modes: ['light', 'dark'], wallpaper: 'aurora',
    swatches: { light: ['#e5edf7', 'rgba(255,255,255,.64)', '#2463bd', '#182236'], dark: ['#0a1021', 'rgba(19,30,51,.55)', '#9fd2ff', '#f5f7fb'] } },
  { id: 'midnight', label: 'Midnight', description: 'True black for OLED screens and late nights.', modes: ['dark'],
    swatches: { dark: ['#000000', '#0b0b0d', '#7aa2ff', '#f2f2f2'] } },
  { id: 'nord', label: 'Nord', description: 'Cool arctic blues and frost.', modes: ['light', 'dark'],
    swatches: { light: ['#eceff4', '#f8f9fb', '#5e81ac', '#2e3440'], dark: ['#2e3440', '#3b4252', '#88c0d0', '#eceff4'] } },
  { id: 'paper', label: 'Paper', description: 'Warm sepia, easy on the eyes for reading.', modes: ['light', 'dark'],
    swatches: { light: ['#f4ecd8', '#fbf6ea', '#9a5b2d', '#3b2f22'], dark: ['#1f1a14', '#2a231b', '#d9a066', '#eadfcb'] } },
  { id: 'rose', label: 'Rosé', description: 'Soft pinks and muted plum.', modes: ['light', 'dark'],
    swatches: { light: ['#faf4f4', '#fffafa', '#c4467a', '#3a2530'], dark: ['#191419', '#231c23', '#eb8fb5', '#f1e4ea'] } },
]);

export const THEME_IDS = THEMES.map(t => t.id);
export const themeById = id => THEMES.find(t => t.id === id) || THEMES[0];

/** The color mode to paint: the skin's only mode when it has one, else the user's choice (system resolved by prefersDark). */
export function resolveMode(skinId, theme = 'system', prefersDark = false) {
  const skin = themeById(skinId);
  if (skin.modes.length === 1) return skin.modes[0];
  if (theme === 'light' || theme === 'dark') return theme;
  return prefersDark ? 'dark' : 'light';
}

/** Gradient wallpapers that ship with Still (no photos). css is a background-image value. */
export const WALLPAPER_PRESETS = Object.freeze([
  { id: 'aurora', label: 'Aurora', css: 'radial-gradient(ellipse at 0% 0%, #d2ebef 0, transparent 55%), radial-gradient(ellipse at 100% 90%, #ddd5ef 0, transparent 55%), linear-gradient(135deg, #e5edf7, #edf0f8 55%, #eee6f4)',
    dark: 'radial-gradient(ellipse at -8% -10%, rgba(38,104,120,.58), transparent 53%), radial-gradient(ellipse at 106% 106%, rgba(84,45,121,.56), transparent 57%), radial-gradient(ellipse at 54% 42%, rgba(33,49,103,.35), transparent 65%), linear-gradient(145deg, #101c2d, #0a1021 55%, #180f28)' },
  { id: 'canyon', label: 'Canyon', css: 'radial-gradient(ellipse at 20% 10%, #f6c9a0 0, transparent 50%), radial-gradient(ellipse at 90% 80%, #c96f4a 0, transparent 55%), linear-gradient(160deg, #8fc3ec 0%, #f2b98d 45%, #b4532f 100%)',
    dark: 'radial-gradient(ellipse at 20% 10%, rgba(201,111,74,.55), transparent 50%), radial-gradient(ellipse at 90% 80%, rgba(120,48,30,.7), transparent 55%), linear-gradient(160deg, #142235 0%, #4a2416 60%, #1d0f0a 100%)' },
  { id: 'lagoon', label: 'Lagoon', css: 'radial-gradient(ellipse at 10% 90%, #9ee6d9 0, transparent 55%), radial-gradient(ellipse at 90% 10%, #9cc7f5 0, transparent 50%), linear-gradient(135deg, #e3f7f3, #e2eefc)',
    dark: 'radial-gradient(ellipse at 10% 90%, rgba(20,140,130,.55), transparent 55%), radial-gradient(ellipse at 90% 10%, rgba(30,80,160,.6), transparent 50%), linear-gradient(135deg, #04151a, #071426)' },
  { id: 'dusk', label: 'Dusk', css: 'radial-gradient(ellipse at 80% 0%, #ffd1dc 0, transparent 50%), radial-gradient(ellipse at 0% 100%, #b9a7f5 0, transparent 55%), linear-gradient(180deg, #f8e6f0, #e7e1fb)',
    dark: 'radial-gradient(ellipse at 80% 0%, rgba(214,90,140,.45), transparent 50%), radial-gradient(ellipse at 0% 100%, rgba(90,60,190,.55), transparent 55%), linear-gradient(180deg, #1a0f1f, #120f26)' },
  { id: 'meadow', label: 'Meadow', css: 'radial-gradient(ellipse at 0% 0%, #e8f5c8 0, transparent 55%), radial-gradient(ellipse at 100% 100%, #b7e0c2 0, transparent 55%), linear-gradient(135deg, #f1f8e6, #e3f3ea)',
    dark: 'radial-gradient(ellipse at 0% 0%, rgba(110,150,40,.45), transparent 55%), radial-gradient(ellipse at 100% 100%, rgba(30,120,80,.5), transparent 55%), linear-gradient(135deg, #0e1708, #08160f)' },
  { id: 'graphite', label: 'Graphite', css: 'radial-gradient(ellipse at 50% 0%, #ffffff 0, transparent 60%), linear-gradient(180deg, #e9eaee, #d6d8de)',
    dark: 'radial-gradient(ellipse at 50% 0%, rgba(255,255,255,.08), transparent 60%), linear-gradient(180deg, #17181b, #0c0d0f)' },
]);

export const wallpaperPreset = id => WALLPAPER_PRESETS.find(p => p.id === id) || WALLPAPER_PRESETS[0];

export const FONT_SIZES = Object.freeze([
  { value: 'sm', label: 'Small', px: 12 }, { value: 'md', label: 'Default', px: 13 }, { value: 'lg', label: 'Large', px: 14 }, { value: 'xl', label: 'Extra large', px: 16 },
]);
export const RADII = Object.freeze([{ value: 'sharp', label: 'Sharp' }, { value: 'default', label: 'Default' }, { value: 'round', label: 'Round' }]);
