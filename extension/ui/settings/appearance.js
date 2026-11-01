// Settings > Appearance: theme gallery, color mode, accent, text size, density, corners, sidebar width, transparency,
// motion and website icons. Every control writes a top-level library setting (lib/settings-schema.js APPEARANCE_DEFAULTS)
// through ctx.store.updateSettings; app.js and theme-boot.js turn them into <html data-*> attributes.
import { html, cx } from '../html.js';
import { icon } from '../icons.js';
import { segmented, switchToggle, button, chip, collectionIcon, badge } from '../components.js';
import { registerActions } from '../runtime.js';
import { THEMES, themeById, resolveMode, FONT_SIZES, RADII, SIDEBAR_WIDTHS, wallpaperPreset } from '../themes.js';
import { appearanceOf, APPEARANCE_DEFAULTS } from '../../lib/settings-schema.js';
import { group, card, row, switchRow, blockRow, matches } from './parts.js';

// Order and labels follow tokens.css (Settings > Appearance). "amber" is an alias of gold and is not offered.
export const ACCENTS = Object.freeze([
  { id: 'blue', label: 'Blue' }, { id: 'teal', label: 'Teal' }, { id: 'green', label: 'Green' }, { id: 'gold', label: 'Raindrop gold' },
  { id: 'orange', label: 'Orange' }, { id: 'pink', label: 'Pink' }, { id: 'graphite', label: 'Graphite' },
]);
const MODES = [{ value: 'system', label: 'System', icon: 'sun-moon' }, { value: 'light', label: 'Light', icon: 'sun' }, { value: 'dark', label: 'Dark', icon: 'moon' }];
const DENSITIES = [{ value: 'comfortable', label: 'Comfortable', icon: 'rows-3' }, { value: 'compact', label: 'Compact', icon: 'list' }];

// Every key this section may write, with the values each accepts (anything else is ignored).
const CHOICES = {
  skin: THEMES.map(t => t.id), theme: MODES.map(m => m.value), accent: ACCENTS.map(a => a.id), density: DENSITIES.map(d => d.value),
  fontSize: FONT_SIZES.map(f => f.value), radius: RADII.map(r => r.value), sidebarWidth: SIDEBAR_WIDTHS.map(w => w.value),
};
const prefersDark = () => !!globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches;
// In other skins the default accent ("blue") is the skin's own (Ice blue, Frost, Sienna…), so it takes that name.
const accentName = (entry, skin) => (entry.id === 'blue' && skin.id !== 'still' ? skin.accentLabel : entry.label);
const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);

/** Appearance values with defaults, plus the accent normalized the way tokens.css reads it. */
export function appearanceValues(settings = {}) {
  const a = appearanceOf(settings);
  const accent = ACCENTS.some(entry => entry.id === a.accent) ? a.accent : a.accent === 'amber' ? 'gold' : 'blue';
  return { ...a, accent, theme: ['light', 'dark'].includes(a.theme) ? a.theme : 'system', skin: themeById(a.skin).id };
}

/** Inline custom properties that paint a theme card's miniature in the mode it would use. */
export function themePreviewStyle(theme, mode) {
  const [bg, surface, accent, fg] = theme.swatches[mode] || theme.swatches[theme.modes[0]];
  const wallpaper = theme.wallpaper ? wallpaperPreset(theme.wallpaper)[mode === 'dark' ? 'dark' : 'css'] : '';
  return `--tp-bg:${bg};--tp-surface:${surface};--tp-accent:${accent};--tp-fg:${fg}${wallpaper ? `;--tp-wallpaper:${wallpaper}` : ''}`;
}

export function renderAppearance(ctx) {
  const a = appearanceValues(ctx.library?.settings);
  const skin = themeById(a.skin);
  const mode = resolveMode(skin.id, a.theme, prefersDark());
  return html`
    ${group({ title: 'Theme', description: 'A theme recolors the sidebar, full tab, side panel and dashboard.', keywords: 'skin look',
      body: () => themeGallery(a, mode) })}
    ${group({ title: 'Color', body: () => card([
      row({ label: 'Mode', keywords: 'dark light system night', description: skin.modes.length === 1
        ? `${skin.label} is ${skin.modes[0]} only. Your choice applies again when you pick a theme with both modes.`
        : a.theme === 'system' ? `Follows your system setting. Now ${mode}.` : `Always ${a.theme}.`,
        control: skin.modes.length === 1 ? badge({ label: `${capitalize(skin.modes[0])} only`, icon: skin.modes[0] === 'dark' ? 'moon' : 'sun' })
          : segmented({ name: 'theme', value: a.theme, options: MODES, action: 'settings.appearance', ariaLabel: 'Mode' }) }),
      row({ label: 'Accent color', keywords: 'highlight tint', description: `${accentName(ACCENTS.find(entry => entry.id === a.accent) || ACCENTS[0], skin)}. Used for buttons, selection and links.`,
        control: accentSwatches(a.accent, mode, skin) }),
    ]) })}
    ${group({ title: 'Text and layout', body: () => card([
      blockRow({ label: 'Text size', keywords: 'font zoom bigger smaller', description: 'Scales text across Still. Chrome’s zoom still works on top of this.',
        body: fontSizePicker(a.fontSize) }),
      row({ label: 'Density', keywords: 'compact spacing rows', description: a.density === 'compact' ? 'Compact rows fit more on screen.' : 'Comfortable rows are easier to scan.',
        control: segmented({ name: 'density', value: a.density, options: DENSITIES, action: 'settings.appearance', ariaLabel: 'Density' }) }),
      row({ label: 'Corners', keywords: 'radius rounded sharp', description: 'How rounded cards, buttons and menus are.', control: radiusPicker(a.radius) }),
      row({ label: 'Sidebar width', keywords: 'navigation', description: 'The library sidebar in the full tab.',
        control: segmented({ name: 'sidebarWidth', value: a.sidebarWidth, options: SIDEBAR_WIDTHS.map(({ value, label }) => ({ value, label })), action: 'settings.appearance', ariaLabel: 'Sidebar width' }) }),
    ]) })}
    ${group({ title: 'Comfort', body: () => card([
      switchRow({ label: 'Reduce transparency', keywords: 'glass blur frosted', description: 'Uses solid surfaces instead of frosted glass. Easier to read over wallpapers.',
        checked: a.transparency === 'reduced', action: 'settings.appearance-flag', data: { key: 'transparency', on: 'reduced', off: 'full' } }),
      switchRow({ label: 'Reduce motion', keywords: 'animation', description: 'Replaces movement with simple fades. When off, Still follows your system setting.',
        checked: a.motion === 'reduced', action: 'settings.appearance-flag', data: { key: 'motion', on: 'reduced', off: 'system' } }),
      switchRow({ label: 'Show website icons', keywords: 'favicons', description: 'Shows each site’s icon in library lists. When off, links show a letter tile. Dashboard widgets always show icons.',
        checked: a.favicons !== false, action: 'settings.appearance-flag', data: { key: 'favicons', on: 'true', off: 'false' } }),
    ]) })}
    ${group({ title: 'Preview', description: 'Lists, collections and buttons with these settings.', body: () => (matches('preview sample') ? appearancePreview() : '') })}
    ${matches('reset defaults') ? html`<div class="settings-actions settings-actions-end">${button({ label: 'Reset appearance', icon: 'rotate-ccw', size: 'sm', variant: 'ghost', action: 'settings.appearance-reset' })}</div>` : ''}`;
}

function themeGallery(a, currentMode) {
  const cards = THEMES.filter(theme => matches(theme.label, theme.description)).map(theme => {
    const selected = theme.id === a.skin;
    const mode = theme.modes.includes(currentMode) ? currentMode : theme.modes[0];
    const modes = theme.modes.length === 2 ? 'Light and dark' : `${capitalize(theme.modes[0])} only`;
    return html`<button type="button" role="radio" class="${cx('theme-card', theme.wallpaper && 'has-wallpaper')}" aria-checked="${selected ? 'true' : 'false'}"
      tabindex="${selected ? '0' : '-1'}" data-action="settings.appearance" data-name="skin" data-value="${theme.id}" aria-describedby="theme-desc-${theme.id}">
      <span class="theme-preview" data-mode="${mode}" style="${themePreviewStyle(theme, mode)}" aria-hidden="true">
        <span class="tp-side"><span class="tp-brand"></span><span class="tp-nav is-active"></span><span class="tp-nav"></span><span class="tp-nav"></span><span class="tp-nav is-short"></span></span>
        <span class="tp-main"><span class="tp-bar"><span class="tp-search"></span><span class="tp-button"></span></span>
          <span class="tp-cards"><span class="tp-card"><span class="tp-line is-title"></span><span class="tp-line"></span></span><span class="tp-card"><span class="tp-line is-title"></span><span class="tp-line is-short"></span></span></span></span>
      </span>
      <span class="theme-card-text"><span class="theme-card-name">${theme.label}${selected ? icon('circle-check', { size: 16, className: 'theme-card-check' }) : ''}</span>
        <span class="theme-card-desc" id="theme-desc-${theme.id}">${theme.description} ${modes}.</span></span>
    </button>`;
  });
  if (!cards.length) return '';
  return html`<div class="theme-gallery" role="radiogroup" aria-label="Theme">${cards}</div>`;
}

function accentSwatches(accent, mode, skin) {
  // The skin's own accent is painted from the catalogue; without the preset attributes its check and ring take the page's
  // tokens, which are that accent's whenever it is the selected one.
  const own = skin.id !== 'still' ? skin.swatches[mode]?.[2] : '';
  return html`<div class="accent-swatches" role="radiogroup" aria-label="Accent color">${ACCENTS.map(entry => html`<button type="button" role="radio"
    class="accent-swatch" ${entry.id === 'blue' && own ? html`style="background:${own}"` : html`data-accent="${entry.id}" data-theme="${mode}"`}
    aria-checked="${entry.id === accent ? 'true' : 'false'}" tabindex="${entry.id === accent ? '0' : '-1'}" aria-label="${accentName(entry, skin)}"
    data-tooltip="${accentName(entry, skin)}" data-action="settings.appearance" data-name="accent" data-value="${entry.id}">${icon('check', { size: 14, className: 'accent-swatch-check' })}</button>`)}</div>`;
}

function fontSizePicker(value) {
  return html`<div class="choice-tiles is-font" role="radiogroup" aria-label="Text size">${FONT_SIZES.map(size => html`<button type="button" role="radio" class="choice-tile"
    aria-checked="${size.value === value ? 'true' : 'false'}" tabindex="${size.value === value ? '0' : '-1'}" data-action="settings.appearance" data-name="fontSize" data-value="${size.value}">
    <span class="choice-tile-sample font-sample" style="font-size:${Math.round(size.px * 1.5)}px" aria-hidden="true">Aa</span>
    <span class="choice-tile-label">${size.label}</span><span class="choice-tile-meta">${size.px} px</span></button>`)}</div>`;
}

function radiusPicker(value) {
  return html`<div class="choice-tiles is-radius" role="radiogroup" aria-label="Corners">${RADII.map(entry => html`<button type="button" role="radio" class="choice-tile is-inline"
    aria-checked="${entry.value === value ? 'true' : 'false'}" tabindex="${entry.value === value ? '0' : '-1'}" data-action="settings.appearance" data-name="radius" data-value="${entry.value}">
    <span class="radius-sample" style="--sample-radius:${Math.round(10 * (entry.k ?? 1))}px" aria-hidden="true"></span><span class="choice-tile-label">${entry.label}</span></button>`)}</div>`;
}

function appearancePreview() {
  const rows = [
    { name: 'Inbox', icon: null, count: 23 },
    { name: 'Design', icon: 'palette', color: 'pink', count: 24, selected: true },
    { name: 'Reading list', icon: 'book-open', color: 'orange', count: 9 },
  ];
  const items = [
    { title: 'Refactoring UI: Design tips for developers', site: 'refactoringui.com', tag: 'ui', letter: 'R', color: 'blue' },
    { title: 'Inter typeface family', site: 'rsms.me', tag: 'typography', letter: 'A', color: 'gray' },
  ];
  return html`<div class="appearance-preview" aria-hidden="true" inert>
    <div class="appearance-preview-side">${rows.map(entry => html`<span class="${cx('ap-row', entry.selected && 'is-selected')}">
      ${collectionIcon(entry.icon ? { icon: entry.icon, color: entry.color } : null, { size: 18 })}<span class="ap-name">${entry.name}</span><span class="count">${entry.count}</span></span>`)}</div>
    <div class="appearance-preview-main">
      ${items.map(item => html`<span class="ap-item"><span class="ap-thumb" data-color="${item.color}">${item.letter}</span>
        <span class="ap-lines"><span class="ap-title">${item.title}</span><span class="ap-meta">${item.site} · <span class="ap-tag">#${item.tag}</span></span></span></span>`)}
      <span class="ap-actions">${button({ label: 'Save', variant: 'primary', size: 'sm' })}${button({ label: 'Cancel', variant: 'secondary', size: 'sm' })}
        ${chip({ label: 'Selected', selected: true })}<span class="ap-switch">${switchToggle({ checked: true, label: 'On' })}</span></span>
    </div>
  </div>`;
}

registerActions({
  'settings.appearance': ({ ctx, data }) => {
    if (!CHOICES[data.name]?.includes(data.value)) return undefined;
    if (ctx.library?.settings?.[data.name] === data.value) return undefined;
    return ctx.store.updateSettings({ [data.name]: data.value });
  },
  // Switches store a named value for each state (e.g. transparency: reduced | full).
  'settings.appearance-flag': ({ ctx, el, data }) => {
    if (!['transparency', 'motion', 'favicons'].includes(data.key)) return undefined;
    const value = el.checked ? data.on : data.off;
    return ctx.store.updateSettings({ [data.key]: data.key === 'favicons' ? value === 'true' : value });
  },
  'settings.appearance-reset': async ({ ctx }) => {
    const ok = await ctx.confirm({ title: 'Reset appearance?', body: 'Theme, mode, accent, text size, density, corners, sidebar width and comfort settings go back to their defaults.',
      confirmLabel: 'Reset appearance' });
    if (!ok) return;
    await ctx.store.updateSettings({ ...APPEARANCE_DEFAULTS });
    ctx.toast('Appearance reset');
  },
});
