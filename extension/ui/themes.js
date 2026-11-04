// Theme ("skin") and wallpaper catalogue. A skin recolors every surface (sidebar, full tab, side panel, dashboard) through
// the semantic tokens in styles/skins.css; the color mode (light/dark/system) still applies unless the skin has one mode.
// <html data-skin="<id>" data-theme="light|dark"> is set by theme-boot.js before paint and app.js afterwards.

// swatches per mode: [canvas, surface, accent, text], the resolved --bg-app, --bg-surface, --accent (with the default
// accent) and --fg-default of styles/skins.css (tests/themes-skins.test.mjs keeps them in sync). Glass lists its ambient
// base and translucent pane instead, since its canvas is the Aurora gradient. accentLabel names the skin's own accent,
// which is what the default accent ("blue") shows in that skin; the other accent presets keep their names.
export const THEMES = Object.freeze([
  { id: 'still', label: 'Still', description: 'The original warm, matte look.', modes: ['light', 'dark'], accentLabel: 'Blue',
    swatches: { light: ['#fcfcfb', '#ffffff', '#1a66d6', '#1f1e1c'], dark: ['#25262a', '#2a2b2f', '#2c6bd3', '#e8e6e3'] } },
  { id: 'white', label: 'White', description: 'Pure white surfaces with crisp hairlines.', modes: ['light'], accentLabel: 'Blue',
    swatches: { light: ['#ffffff', '#ffffff', '#0d6fc4', '#18181b'] } },
  { id: 'glass', label: 'Liquid Glass', description: 'Frosted, translucent panels over a soft ambient wallpaper.', modes: ['light', 'dark'], wallpaper: 'aurora', accentLabel: 'Ice blue',
    swatches: { light: ['#e5edf7', 'rgba(255,255,255,.6)', '#2463bd', '#182236'], dark: ['#0a1021', 'rgba(19,30,51,.55)', '#9fd2ff', '#f5f7fb'] } },
  { id: 'midnight', label: 'Midnight', description: 'True black for OLED screens and late nights.', modes: ['dark'], accentLabel: 'Periwinkle',
    swatches: { dark: ['#000000', '#0c0c0e', '#7aa2ff', '#f2f2f3'] } },
  { id: 'nord', label: 'Nord', description: 'Cool arctic blues and frost.', modes: ['light', 'dark'], accentLabel: 'Frost',
    swatches: { light: ['#f4f6f9', '#fbfcfd', '#4b6d9a', '#2e3440'], dark: ['#2e3440', '#333a47', '#88c0d0', '#eceff4'] } },
  { id: 'paper', label: 'Paper', description: 'Warm sepia, easy on the eyes for reading.', modes: ['light', 'dark'], accentLabel: 'Sienna',
    swatches: { light: ['#f7f1e3', '#fbf7ee', '#9a5b2d', '#33281c'], dark: ['#1f1a14', '#251f18', '#d9a066', '#ebe0cc'] } },
  { id: 'rose', label: 'Rosé', description: 'Soft pinks and muted plum.', modes: ['light', 'dark'], accentLabel: 'Raspberry',
    swatches: { light: ['#fcf7f8', '#fffbfc', '#b83c70', '#36222d'], dark: ['#1c161c', '#221b22', '#eb8fb5', '#f1e4ea'] } },
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

// px is the default UI text size (--text-sm) at each step; styles/tokens.css holds the full scale.
export const FONT_SIZES = Object.freeze([
  { value: 'sm', label: 'Small', px: 12 }, { value: 'md', label: 'Default', px: 13 }, { value: 'lg', label: 'Large', px: 14 }, { value: 'xl', label: 'Extra large', px: 16 },
]);
// k multiplies every --radius-* step (tokens.css [data-radius]).
export const RADII = Object.freeze([{ value: 'sharp', label: 'Sharp', k: 0.4 }, { value: 'default', label: 'Default', k: 1 }, { value: 'round', label: 'Round', k: 1.5 }]);
// --sidebar-w at each width (tokens.css [data-sidebar-width]).
export const SIDEBAR_WIDTHS = Object.freeze([{ value: 'narrow', label: 'Narrow', px: 220 }, { value: 'default', label: 'Default', px: 248 }, { value: 'wide', label: 'Wide', px: 288 }]);
// Dashboard widget materials (settings dashboard.widgetStyle); skins.css paints each one per skin.
export const WIDGET_STYLES = Object.freeze([
  { value: 'card', label: 'Cards', description: 'Solid cards with a soft shadow.' },
  { value: 'glass', label: 'Glass', description: 'Frosted, translucent cards. Best over a wallpaper.' },
  { value: 'flat', label: 'Flat', description: 'No card, just a hairline outline.' },
  { value: 'raised', label: 'Raised', description: 'Solid cards lifted with a deeper shadow.' },
  { value: 'clear', label: 'Clear glass', description: 'See-through glass with a light frost. Best over a wallpaper.' },
  { value: 'tinted', label: 'Tinted', description: 'Cards washed with your accent color.' },
  { value: 'gradient', label: 'Gradient', description: 'Cards that fade from your accent color into the surface.' },
  { value: 'outline', label: 'Outline', description: 'No fill, just a clear outline.' },
]);
/** A widget's own Background choices: the dashboard default, every material, and none. */
export const WIDGET_FRAMES = Object.freeze([
  { value: 'default', label: 'Default', description: 'Follows the widget style chosen for the whole dashboard.' },
  ...WIDGET_STYLES.map(({ value, label, description }) => ({ value, label: value === 'card' ? 'Card' : label, description })),
  { value: 'none', label: 'None', description: 'No background or title bar.' },
]);

/** Whether a skin can show the given color mode. */
export const supportsMode = (skinId, mode) => themeById(skinId).modes.includes(mode);
