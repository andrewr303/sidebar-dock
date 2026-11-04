// Settings > New tab & dashboard: start page, search, greeting, dashboard look, wallpaper and boards.
// Grouped settings (newTab, dashboard, wallpaper) are written whole through patchGroup (lib/settings-schema.js); boards
// live in lib/dashboard-store.js. Uploaded wallpapers are IndexedDB attachments: replacing or removing one deletes the old file.
import { html, cx, plural } from '../html.js';
import { icon } from '../icons.js';
import { segmented, materialPicker, select, input, button, iconButton, badge, spinner } from '../components.js';
import { registerActions } from '../runtime.js';
import { WALLPAPER_PRESETS, WIDGET_STYLES, wallpaperPreset, themeById, resolveMode } from '../themes.js';
import { settingsGroup, patchGroup, appearanceOf } from '../../lib/settings-schema.js';
import * as boards from '../../lib/dashboard-store.js';
import { group, card, row, switchRow, blockRow, matches, loadingBlock, isBusy, withBusy } from './parts.js';

export const START_PAGES = Object.freeze([
  { value: 'dashboard', label: 'Dashboard' }, { value: 'all', label: 'All items' }, { value: 'inbox', label: 'Inbox' },
  { value: 'notes', label: 'Notes' }, { value: 'assistant', label: 'AI assistant' },
]);
export const SEARCH_ENGINES = Object.freeze([
  { value: 'default', label: 'Chrome’s search engine' }, { value: 'google', label: 'Google' }, { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'bing', label: 'Bing' }, { value: 'kagi', label: 'Kagi' }, { value: 'perplexity', label: 'Perplexity' }, { value: 'brave', label: 'Brave Search' },
]);
const GAPS = [{ value: 'sm', label: 'Tight' }, { value: 'md', label: 'Default' }, { value: 'lg', label: 'Roomy' }];
const SCOPES = [{ value: 'dashboard', label: 'Dashboard only' }, { value: 'app', label: 'Every page' }];
const KINDS = [
  { value: 'none', label: 'None', icon: 'ban' }, { value: 'preset', label: 'Gradient', icon: 'blend' }, { value: 'color', label: 'Color', icon: 'droplet' },
  { value: 'image', label: 'Your image', icon: 'image-up' }, { value: 'url', label: 'Image link', icon: 'link' },
];
export const MAX_WALLPAPER_BYTES = 25 * 1024 * 1024;

// Allowed values per grouped key; writes outside these are ignored.
const CHOICES = {
  newTab: { view: START_PAGES.map(p => p.value), engine: SEARCH_ENGINES.map(e => e.value) },
  dashboard: { widgetStyle: WIDGET_STYLES.map(s => s.value), gap: GAPS.map(g => g.value) },
  wallpaper: { kind: KINDS.map(k => k.value), preset: WALLPAPER_PRESETS.map(p => p.id), scope: SCOPES.map(s => s.value) },
};
const FLAGS = { newTab: ['search', 'greeting', 'focusSearch'], dashboard: ['header', 'weatherChip', 'stickies'] };

/** An https image address, normalized, or '' when the text is not one. */
export function wallpaperUrl(text) {
  try {
    const url = new URL(String(text || '').trim());
    return url.protocol === 'https:' && url.hostname ? url.href : '';
  } catch { return ''; }
}
/** A CSS url() value with the address quoted and escaped. */
export const cssUrl = href => `url("${String(href).replace(/["\\\n\r]/g, c => `\\${c.charCodeAt(0).toString(16)} `)}")`;
/** #rrggbb or '' (the color input only produces this form). */
export const hexColor = value => (/^#[\da-f]{6}$/i.test(String(value || '').trim()) ? String(value).trim().toLowerCase() : '');

/* ------------------------------------------------------------------ state */

const local = { name: null, url: null, urlError: '', nameTimer: 0, rangeTimer: 0, preview: { id: '', url: '', loading: false }, offBoards: null };

/** Follow boards and accounts while the page is open (called by settings.js on mount). */
export function attachNewTab(ctx) {
  boards.loadDashboard().then(() => ctx.render(), error => console.warn('[still] boards unavailable', error));
  local.offBoards = boards.subscribeDashboard(() => ctx.render());
}
export function detachNewTab() {
  local.offBoards?.();
  local.offBoards = null;
  clearTimeout(local.nameTimer);
  clearTimeout(local.rangeTimer);
  Object.assign(local, { name: null, url: null, urlError: '' });
  if (local.preview.url) URL.revokeObjectURL(local.preview.url);
  local.preview = { id: '', url: '', loading: false };
}

// Object URL for the uploaded wallpaper preview, loaded once per attachment id.
function uploadedPreview(ctx, id) {
  if (!id) return '';
  if (local.preview.id === id) return local.preview.url;
  if (local.preview.url) URL.revokeObjectURL(local.preview.url);
  local.preview = { id, url: '', loading: true };
  Promise.resolve(ctx.store.getAttachment?.(id)).then(record => {
    if (local.preview.id !== id) return;
    local.preview = { id, url: record?.blob ? URL.createObjectURL(record.blob) : '', loading: false, missing: !record?.blob };
    ctx.render();
  }, () => { if (local.preview.id === id) { local.preview = { id, url: '', loading: false, missing: true }; ctx.render(); } });
  return '';
}

/* ------------------------------------------------------------------ render */

export function renderNewTab(ctx) {
  const settings = ctx.library?.settings || {};
  const tab = settingsGroup(settings, 'newTab');
  const dash = settingsGroup(settings, 'dashboard');
  return html`
    ${group({ title: 'New tab', body: () => card([
      row({ label: 'Open new tabs to', keywords: 'start page home default view', description: 'Opening Still in a tab from the toolbar starts here too.',
        control: select({ name: 'view', value: tab.view, options: START_PAGES, label: 'Open new tabs to', action: 'settings.newtab-choice', className: 'settings-select' }) }),
      switchRow({ label: 'Show the search bar', keywords: 'search engine web', description: 'Search the web or your library from the top of the dashboard.',
        checked: tab.search, action: 'settings.group-flag', data: { group: 'newTab', key: 'search' } }),
      row({ label: 'Search engine', keywords: 'google duckduckgo bing kagi perplexity brave web', description: tab.engine === 'default'
        ? 'Uses the search engine you chose in Chrome.' : 'Web searches from the dashboard go here.',
        control: select({ name: 'engine', value: tab.engine, options: SEARCH_ENGINES, label: 'Search engine', action: 'settings.newtab-choice', className: 'settings-select', disabled: !tab.search }) }),
      switchRow({ label: 'Put the cursor in the search bar', keywords: 'focus autofocus type', description: 'Start typing a search as soon as a new tab opens. Chrome may keep the cursor in the address bar.',
        checked: tab.focusSearch, disabled: !tab.search, action: 'settings.group-flag', data: { group: 'newTab', key: 'focusSearch' } }),
    ]) })}
    ${group({ title: 'Greeting', body: () => card([
      switchRow({ label: 'Show a greeting', keywords: 'good morning hello', description: 'Good morning, good afternoon or good evening at the top of the dashboard.',
        checked: tab.greeting, action: 'settings.group-flag', data: { group: 'newTab', key: 'greeting' } }),
      row({ label: 'Your name', keywords: 'greeting first name', description: 'Optional. Used only in the greeting, on this device.',
        control: input({ id: 'settings-greeting-name', name: 'name', value: local.name ?? tab.name, placeholder: 'Add your name', label: 'Your name',
          action: 'settings.newtab-name', disabled: !tab.greeting, className: 'settings-text-input', attrs: { maxlength: '40' } }) }),
    ]) })}
    ${group({ title: 'Dashboard', body: () => card([
      row({ label: 'Widget style', keywords: 'card glass flat frame', description: `${WIDGET_STYLES.find(style => style.value === dash.widgetStyle)?.description || ''} A widget can override it from its menu.`.trim(),
        control: materialPicker({ name: 'widgetStyle', value: dash.widgetStyle, options: WIDGET_STYLES, action: 'settings.dashboard-choice', ariaLabel: 'Widget style' }) }),
      row({ label: 'Widget spacing', keywords: 'gap gutter', description: 'Space between widgets on the board.',
        control: segmented({ name: 'gap', value: dash.gap, options: GAPS, action: 'settings.dashboard-choice', ariaLabel: 'Widget spacing' }) }),
      switchRow({ label: 'Show the board header', keywords: 'title switcher', description: 'Board name, board switcher and greeting above the widgets.',
        checked: dash.header, action: 'settings.group-flag', data: { group: 'dashboard', key: 'header' } }),
      switchRow({ label: 'Show the weather in the header', keywords: 'temperature forecast', description: 'Uses the location from your Weather widget.',
        checked: dash.weatherChip, disabled: !dash.header, action: 'settings.group-flag', data: { group: 'dashboard', key: 'weatherChip' } }),
      switchRow({ label: 'Show sticky notes on the dashboard', keywords: 'stickies notes floating', description: 'Sticky notes float above the widgets. They stay in Notes when hidden.',
        checked: dash.stickies, action: 'settings.group-flag', data: { group: 'dashboard', key: 'stickies' } }),
    ]) })}
    ${group({ title: 'Wallpaper', keywords: 'background', body: () => renderWallpaper(ctx, settings) })}
    ${group({ title: 'Boards', description: 'Each board is its own set of widgets. New tabs open to the default board.', keywords: 'dashboards pages',
      actions: matches('new board add') ? button({ label: 'New board', icon: 'plus', size: 'sm', action: 'settings.board-add' }) : '',
      body: () => renderBoards(ctx) })}`;
}

function renderWallpaper(ctx, settings) {
  const wp = settingsGroup(settings, 'wallpaper');
  const skin = themeById(appearanceOf(settings).skin);
  const glass = skin.id === 'glass';
  const mode = globalThis.document?.documentElement?.dataset.theme === 'dark' ? 'dark' : resolveMode(skin.id, appearanceOf(settings).theme, false);
  return card([
    blockRow({ label: 'Background', keywords: 'wallpaper image photo gradient color none upload link', id: 'settings-wallpaper',
      description: glass && wp.kind === 'none' ? 'Liquid Glass shows its own gradient until you choose one here.' : 'Shown behind the dashboard. Dim and blur keep widgets readable.',
      body: html`<div class="wallpaper-editor">
        ${wallpaperPreview(ctx, wp, mode)}
        <div class="wallpaper-controls">
          <div class="choice-tiles is-kinds" role="radiogroup" aria-label="Wallpaper">${KINDS.map(kind => html`<button type="button" role="radio" class="choice-tile is-inline"
            aria-checked="${kind.value === wp.kind ? 'true' : 'false'}" tabindex="${kind.value === wp.kind ? '0' : '-1'}" data-action="settings.wallpaper-kind" data-value="${kind.value}">
            ${icon(kind.icon, { size: 16 })}<span class="choice-tile-label">${kind.label}</span></button>`)}</div>
          ${wallpaperSource(ctx, wp, mode)}
        </div>
      </div>` }),
    wp.kind === 'none' ? '' : row({ label: 'Dim', keywords: 'darken overlay contrast', description: 'Darkens the wallpaper so text stays readable.',
      control: rangeControl({ key: 'dim', value: wp.dim, min: 0, max: 80, step: 5, unit: '%', label: 'Dim' }) }),
    wp.kind === 'none' ? '' : row({ label: 'Blur', keywords: 'soften frosted', description: 'Softens busy images behind widgets.',
      control: rangeControl({ key: 'blur', value: wp.blur, min: 0, max: 40, step: 2, unit: 'px', label: 'Blur' }) }),
    wp.kind === 'none' ? '' : row({ label: 'Show it on', keywords: 'scope everywhere', description: glass ? 'Liquid Glass always shows the wallpaper on every page.'
      : wp.scope === 'app' ? 'Behind the dashboard, your library, notes and settings.' : 'Only behind the dashboard.',
      control: glass ? badge({ label: 'Every page', icon: 'layers' })
        : segmented({ name: 'scope', value: wp.scope, options: SCOPES, action: 'settings.wallpaper-choice', ariaLabel: 'Show the wallpaper on' }) }),
  ]);
}

function wallpaperBackground(ctx, wp, mode) {
  if (wp.kind === 'preset') { const preset = wallpaperPreset(wp.preset); return `background-image:${mode === 'dark' ? preset.dark : preset.css}`; }
  if (wp.kind === 'color') return `background-color:${hexColor(wp.color) || '#1f2a44'}`;
  if (wp.kind === 'url' && wallpaperUrl(wp.url)) return `background-image:${cssUrl(wallpaperUrl(wp.url))}`;
  if (wp.kind === 'image') { const url = uploadedPreview(ctx, wp.attachmentId); return url ? `background-image:${cssUrl(url)}` : ''; }
  return '';
}

function wallpaperPreview(ctx, wp, mode) {
  const background = wallpaperBackground(ctx, wp, mode);
  const empty = !background;
  const waiting = wp.kind === 'image' && wp.attachmentId && local.preview.loading;
  const label = wp.kind === 'none' ? 'No wallpaper' : waiting ? 'Loading image' : empty ? (wp.kind === 'image' && local.preview.missing ? 'Image not found' : 'Nothing chosen yet') : '';
  return html`<div class="${cx('wallpaper-preview', empty && 'is-empty')}" aria-hidden="true"
    style="--wp-dim:${(Number(wp.dim) || 0) / 100};--wp-blur:${Math.round((Number(wp.blur) || 0) / 4)}px">
    <span class="wallpaper-preview-image" style="${background}"></span><span class="wallpaper-preview-dim"></span>
    <span class="wallpaper-preview-board"><span class="wp-widget is-wide"></span><span class="wp-widget"></span><span class="wp-widget"></span><span class="wp-widget is-tall"></span></span>
    ${label ? html`<span class="wallpaper-preview-label">${waiting ? spinner({ size: 14 }) : icon(wp.kind === 'none' ? 'image-off' : 'image', { size: 16 })}${label}</span>` : ''}
  </div>`;
}

function wallpaperSource(ctx, wp, mode) {
  if (wp.kind === 'preset') {
    return html`<div class="wallpaper-presets" role="radiogroup" aria-label="Gradient">${WALLPAPER_PRESETS.map(preset => html`<button type="button" role="radio"
      class="wallpaper-swatch" aria-checked="${preset.id === wp.preset ? 'true' : 'false'}" tabindex="${preset.id === wp.preset ? '0' : '-1'}" data-tooltip="${preset.label}"
      aria-label="${preset.label}" data-action="settings.wallpaper-preset" data-value="${preset.id}" style="background-image:${mode === 'dark' ? preset.dark : preset.css}">
      ${icon('check', { size: 14, className: 'wallpaper-swatch-check' })}</button>`)}</div>`;
  }
  if (wp.kind === 'color') {
    const color = hexColor(wp.color) || '#1f2a44';
    return html`<div class="wallpaper-color"><label class="color-field"><input type="color" class="color-input" value="${color}" data-change="settings.wallpaper-color"
      aria-label="Wallpaper color"><span class="color-field-value">${color.toUpperCase()}</span></label>
      <span class="settings-row-desc">Pick any color. Dark colors work best with light text.</span></div>`;
  }
  if (wp.kind === 'image') {
    const has = !!wp.attachmentId;
    return html`<div class="wallpaper-upload">
      <input type="file" id="settings-wallpaper-file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" hidden data-change="settings.wallpaper-file">
      <div class="settings-actions">
        ${button({ label: has ? 'Replace image' : 'Choose image', icon: 'upload', size: 'sm', variant: has ? 'secondary' : 'primary', action: 'settings.wallpaper-pick', loading: isBusy('wallpaper-upload') })}
        ${has ? button({ label: 'Remove image', icon: 'trash-2', size: 'sm', variant: 'ghost', action: 'settings.wallpaper-remove' }) : ''}
      </div>
      <span class="settings-row-desc">PNG, JPEG, WebP, GIF or AVIF up to 25 MB. The image stays on this device.</span></div>`;
  }
  if (wp.kind === 'url') {
    const value = local.url ?? wp.url;
    return html`<form class="wallpaper-url" data-submit="settings.wallpaper-url" novalidate>
      <div class="wallpaper-url-row">${input({ id: 'settings-wallpaper-url', name: 'url', type: 'url', value, placeholder: 'https://images.example.com/photo.jpg', label: 'Image address',
        action: 'settings.wallpaper-url-field', invalid: !!local.urlError, describedBy: local.urlError ? 'settings-wallpaper-url-error' : 'settings-wallpaper-url-hint' })}
        ${button({ label: 'Use image', type: 'submit', variant: value && value !== wp.url ? 'primary' : 'secondary' })}</div>
      ${local.urlError ? html`<p class="field-error" id="settings-wallpaper-url-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${local.urlError}</span></p>`
        : html`<p class="settings-row-desc" id="settings-wallpaper-url-hint">An https:// address of an image. It loads from that site each time.</p>`}
    </form>`;
  }
  return '';
}

function rangeControl({ key, value, min, max, step, unit, label }) {
  const n = Math.min(max, Math.max(min, Number(value) || 0));
  return html`<span class="settings-range"><input type="range" class="range" id="settings-wallpaper-${key}" min="${min}" max="${max}" step="${step}" value="${n}"
    aria-label="${label}" aria-valuetext="${n} ${unit === '%' ? 'percent' : 'pixels'}" data-input="settings.wallpaper-range" data-change="settings.wallpaper-range-commit" data-key="${key}"
    style="--fill:${((n - min) / (max - min)) * 100}%"><output class="settings-range-value" for="settings-wallpaper-${key}">${n}${unit === '%' ? '%' : ' px'}</output></span>`;
}

function renderBoards(ctx) {
  const state = boards.getDashboard();
  if (!state) return loadingBlock('Loading boards');
  const list = state.boards;
  const rows = list.map((board, index) => {
    const active = board.id === state.activeBoardId;
    return row({ className: 'board-row', label: html`${board.name}${active ? badge({ label: 'Default', tone: 'accent' }) : ''}`, keywords: 'board',
      lead: html`<span class="settings-row-icon" aria-hidden="true">${icon(board.icon || 'layout-dashboard', { size: 16 })}</span>`,
      description: `${plural(board.widgets.length, 'widget')}${active ? ' · New tabs open here' : ''}`,
      control: html`${active ? '' : button({ label: 'Make default', size: 'sm', variant: 'ghost', action: 'settings.board-default', data: { id: board.id } })}
        <span class="settings-icon-actions">
        ${iconButton({ icon: 'pencil', label: `Rename ${board.name}`, size: 'sm', action: 'settings.board-rename', data: { id: board.id } })}
        ${iconButton({ icon: 'arrow-up', label: `Move ${board.name} up`, size: 'sm', action: 'settings.board-move', data: { id: board.id, to: index - 1 }, disabled: index === 0 })}
        ${iconButton({ icon: 'arrow-down', label: `Move ${board.name} down`, size: 'sm', action: 'settings.board-move', data: { id: board.id, to: index + 1 }, disabled: index === list.length - 1 })}
        ${iconButton({ icon: 'trash-2', label: `Delete ${board.name}`, size: 'sm', variant: 'danger', action: 'settings.board-delete', data: { id: board.id }, disabled: list.length < 2 })}
        </span>` });
  });
  return card(rows, 'board-list');
}

/* ------------------------------------------------------------------ actions */

const settingsOf = ctx => ctx.library?.settings || {};
const writeGroup = (ctx, key, patch) => patchGroup(ctx.store, settingsOf(ctx), key, patch);
const boardName = id => boards.getDashboard()?.boards.find(b => b.id === id)?.name || 'this board';

function setRangePreview(key, value) {
  // Immediate feedback while dragging; app.js sets the same properties from the saved setting afterwards.
  const root = document.documentElement;
  if (root.dataset.wallpaper !== 'on') return;
  if (key === 'dim') root.style.setProperty('--wallpaper-dim', String(value / 100));
  if (key === 'blur') root.style.setProperty('--wallpaper-blur', `${value}px`);
}

registerActions({
  'settings.newtab-choice': ({ ctx, el }) => {
    if (!CHOICES.newTab[el.name]?.includes(el.value)) return undefined;
    return writeGroup(ctx, 'newTab', { [el.name]: el.value });
  },
  'settings.dashboard-choice': ({ ctx, data }) => {
    if (!CHOICES.dashboard[data.name]?.includes(data.value)) return undefined;
    return writeGroup(ctx, 'dashboard', { [data.name]: data.value });
  },
  'settings.group-flag': ({ ctx, el, data }) => {
    if (!FLAGS[data.group]?.includes(data.key)) return undefined;
    return writeGroup(ctx, data.group, { [data.key]: !!el.checked });
  },
  'settings.newtab-name': ({ ctx, el }) => {
    local.name = el.value;
    clearTimeout(local.nameTimer);
    local.nameTimer = setTimeout(() => ctx.run(async () => {
      const name = String(local.name ?? '').trim().slice(0, 40);
      if (name !== settingsGroup(settingsOf(ctx), 'newTab').name) await writeGroup(ctx, 'newTab', { name });
      local.name = null;
    }), 500);
  },

  // Wallpaper
  'settings.wallpaper-kind': ({ ctx, data }) => {
    if (!CHOICES.wallpaper.kind.includes(data.value)) return undefined;
    local.urlError = '';
    const wp = settingsGroup(settingsOf(ctx), 'wallpaper');
    if (data.value === wp.kind) return undefined;
    // An image kind without an image yet opens the picker right away (this click is the user gesture it needs).
    if (data.value === 'image' && !wp.attachmentId) ctx.nextFrame(() => document.getElementById('settings-wallpaper-file')?.click());
    if (data.value === 'url' && !wp.url) ctx.nextFrame(() => document.getElementById('settings-wallpaper-url')?.focus());
    return writeGroup(ctx, 'wallpaper', { kind: data.value });
  },
  'settings.wallpaper-choice': ({ ctx, data }) => (CHOICES.wallpaper[data.name]?.includes(data.value) ? writeGroup(ctx, 'wallpaper', { [data.name]: data.value }) : undefined),
  'settings.wallpaper-preset': ({ ctx, data }) => (CHOICES.wallpaper.preset.includes(data.value) ? writeGroup(ctx, 'wallpaper', { kind: 'preset', preset: data.value }) : undefined),
  'settings.wallpaper-color': ({ ctx, el }) => {
    const color = hexColor(el.value);
    return color ? writeGroup(ctx, 'wallpaper', { kind: 'color', color }) : undefined;
  },
  'settings.wallpaper-range': ({ ctx, el, data }) => {
    const value = Number(el.value);
    el.style.setProperty('--fill', `${((value - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100}%`);
    const output = el.parentElement?.querySelector('output');
    if (output) output.textContent = data.key === 'dim' ? `${value}%` : `${value} px`;
    el.setAttribute('aria-valuetext', `${value} ${data.key === 'dim' ? 'percent' : 'pixels'}`);
    setRangePreview(data.key, value);
    clearTimeout(local.rangeTimer);
    local.rangeTimer = setTimeout(() => ctx.run(() => writeGroup(ctx, 'wallpaper', { [data.key]: value })), 250);
  },
  'settings.wallpaper-range-commit': ({ ctx, el, data }) => {
    if (!['dim', 'blur'].includes(data.key)) return undefined;
    clearTimeout(local.rangeTimer);
    return writeGroup(ctx, 'wallpaper', { [data.key]: Number(el.value) });
  },
  'settings.wallpaper-pick': () => document.getElementById('settings-wallpaper-file')?.click(),
  'settings.wallpaper-file': ({ ctx, el }) => {
    const file = el.files?.[0];
    el.value = '';
    if (!file) return undefined;
    if (!/^image\/(png|jpe?g|webp|gif|avif)$/i.test(file.type)) throw new Error('Choose a PNG, JPEG, WebP, GIF or AVIF image.');
    if (file.size > MAX_WALLPAPER_BYTES) throw new Error('That image is larger than 25 MB. Choose a smaller one.');
    return withBusy(ctx, 'wallpaper-upload', async () => {
      const previous = settingsGroup(settingsOf(ctx), 'wallpaper').attachmentId;
      const { attachmentId } = await ctx.store.saveAttachment(file);
      await writeGroup(ctx, 'wallpaper', { kind: 'image', attachmentId });
      if (previous && previous !== attachmentId) await ctx.store.deleteAttachment(previous).catch(() => {});
      ctx.toast('Wallpaper updated', { tone: 'success' });
    });
  },
  'settings.wallpaper-remove': async ({ ctx }) => {
    const previous = settingsGroup(settingsOf(ctx), 'wallpaper').attachmentId;
    await writeGroup(ctx, 'wallpaper', { kind: 'none', attachmentId: '' });
    if (previous) await ctx.store.deleteAttachment(previous).catch(() => {});
    ctx.toast('Wallpaper removed');
  },
  'settings.wallpaper-url-field': ({ ctx, el }) => {
    local.url = el.value;
    if (local.urlError) { local.urlError = ''; ctx.render(); }
  },
  'settings.wallpaper-url': ({ ctx, el }) => {
    const text = el.querySelector('input[name="url"]')?.value ?? local.url ?? '';
    const href = wallpaperUrl(text);
    if (!href) {
      local.urlError = /^http:/i.test(text.trim()) ? 'Use an https:// address. Chrome blocks http images on secure pages.' : 'Paste the full address of an image, starting with https://.';
      ctx.render();
      ctx.nextFrame(() => document.getElementById('settings-wallpaper-url')?.focus());
      return undefined;
    }
    local.url = null;
    local.urlError = '';
    return writeGroup(ctx, 'wallpaper', { kind: 'url', url: href });
  },

  // Boards
  'settings.board-default': ({ ctx, data }) => boards.setActiveBoard(data.id).then(() => ctx.toast(`New tabs open to ${boardName(data.id)}`)),
  'settings.board-move': ({ data }) => boards.moveBoard(data.id, Number(data.to)),
  'settings.board-rename': async ({ ctx, data }) => {
    const current = boardName(data.id);
    const name = await ctx.prompt({ title: 'Rename board', label: 'Board name', value: current, confirmLabel: 'Rename board' });
    const next = String(name ?? '').trim().slice(0, 80);
    if (!next || next === current) return;
    await boards.updateBoard(data.id, { name: next });
  },
  'settings.board-add': async ({ ctx }) => {
    const name = await ctx.prompt({ title: 'New board', label: 'Board name', placeholder: 'Work, Reading, Projects…', confirmLabel: 'Create board' });
    const next = String(name ?? '').trim().slice(0, 80);
    if (!next) return;
    const previous = boards.getDashboard()?.activeBoardId;
    await boards.addBoard({ name: next });
    // addBoard makes the new board active; keep the default where it was.
    if (previous) await boards.setActiveBoard(previous);
    ctx.toast(`${next} created. Add widgets to it from the dashboard.`, { tone: 'success' });
  },
  'settings.board-delete': async ({ ctx, data }) => {
    const state = boards.getDashboard();
    const board = state?.boards.find(b => b.id === data.id);
    if (!board) return;
    const ok = await ctx.confirm({ title: `Delete ${board.name}?`, confirmLabel: 'Delete board', tone: 'danger',
      body: `${board.widgets.length === 1 ? 'Its widget is' : board.widgets.length ? `Its ${plural(board.widgets.length, 'widget')} are` : 'The board is'} removed. Notes, links and other library items stay in Still.` });
    if (!ok) return;
    await boards.removeBoard(board.id);
    ctx.toast(`${board.name} deleted`);
  },
});
