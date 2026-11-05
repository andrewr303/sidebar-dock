// Component helpers. Each returns an html fragment with stable class names styled by styles/components.css.
// Interactive helpers take `action` (data-action) plus `data` (extra data-* attributes) so the runtime can route events.
import { html, raw, cx, esc, attrs as attrList, safeSrc, isFragment } from './html.js';
import { icon } from './icons.js';
import { modKey } from './runtime.js';

const dataAttrs = (data = {}) => raw(Object.entries(data)
  .filter(([, v]) => v != null && v !== false)
  .map(([k, v]) => `data-${k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}="${esc(v === true ? 'true' : v)}"`).join(' '));
const extra = value => !value ? '' : isFragment(value) ? value : typeof value === 'object' ? attrList(value) : raw(String(value));

/** Keyboard hint: kbd('mod+k') -> ⌘ K / Ctrl K. */
export function kbd(keys) {
  const parts = String(keys).split('+').map(k => k === 'mod' ? modKey : k === 'shift' ? '⇧' : k === 'alt' ? (modKey === '⌘' ? '⌥' : 'Alt') : k === 'enter' ? '↵' : k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1));
  return html`<kbd class="kbd">${parts.map(p => html`<span>${p}</span>`)}</kbd>`;
}

/** aria-keyshortcuts value: keyshortcuts('mod+shift+s') -> 'Control+Shift+S' ('Meta+…' on macOS). */
export function keyshortcuts(keys, mac = modKey === '⌘') {
  const names = { mod: mac ? 'Meta' : 'Control', ctrl: 'Control', cmd: 'Meta', shift: 'Shift', alt: 'Alt', enter: 'Enter', escape: 'Escape', esc: 'Escape', space: 'Space' };
  return String(keys).split(/\s+/).map(chord => chord.split('+').map(k => names[k.toLowerCase()] || (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))).join('+')).join(' ');
}

/** Readable shortcut text for tooltips: shortcutLabel('mod+enter') -> 'Ctrl+Enter' / '⌘↵'. */
export function shortcutLabel(keys, mac = modKey === '⌘') {
  const names = mac ? { mod: '⌘', shift: '⇧', alt: '⌥', enter: '↵' } : { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', enter: 'Enter' };
  return String(keys).split('+').map(k => names[k.toLowerCase()] || (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))).join(mac ? '' : '+');
}

/**
 * Tooltip attributes for any element (styled in base.css): shown after a hover delay and at once on keyboard focus.
 * placement: 'top' (default) | 'bottom', optionally with ' start' / ' end' alignment, e.g. 'bottom end'.
 * The tooltip is not an accessible name: icon-only controls also need aria-label (iconButton does both).
 */
export function tooltipAttrs(label, { placement } = {}) {
  return html`data-tooltip="${label}" ${placement ? html`data-tooltip-pos="${placement}"` : ''}`;
}

/**
 * Text button. `kbd` adds aria-keyshortcuts; secondary and ghost buttons also show the key caps, primary and danger
 * buttons show the shortcut in a tooltip instead (no key caps inside a filled button). `loading` keeps the label's
 * width under a centered spinner and makes the button inert (aria-busy + aria-disabled).
 */
export function button({ label, icon: ico, iconRight, variant = 'secondary', size = 'md', action, data, type = 'button', disabled, pressed, loading,
  kbd: keys, title, id, className, attrs, hideLabel = false, tooltip, expanded } = {}) {
  const filled = variant === 'primary' || variant === 'danger';
  const tip = tooltip ?? (hideLabel ? label : keys && filled ? `${label} (${shortcutLabel(keys)})` : '');
  return html`<button type="${type}" class="${cx('btn', `btn-${variant}`, size !== 'md' && `btn-${size}`, loading && 'is-loading', className)}"
    ${id ? html`id="${id}"` : ''} ${action ? html`data-action="${action}"` : ''} ${dataAttrs(data)}
    ${pressed !== undefined ? html`aria-pressed="${pressed ? 'true' : 'false'}"` : ''} ${expanded !== undefined ? html`aria-expanded="${expanded ? 'true' : 'false'}" aria-haspopup="true"` : ''}
    ${disabled ? raw('disabled') : ''} ${loading ? raw('aria-busy="true" aria-disabled="true"') : ''} ${title ? html`title="${title}"` : ''}
    ${hideLabel ? html`aria-label="${label}"` : ''} ${tip ? html`data-tooltip="${tip}"` : ''} ${keys ? html`aria-keyshortcuts="${keyshortcuts(keys)}"` : ''} ${extra(attrs)}>
    ${ico ? icon(ico, { size: size === 'sm' ? 14 : 16 }) : ''}${hideLabel ? '' : html`<span class="btn-label">${label}</span>`}${iconRight ? icon(iconRight, { size: 14, className: 'btn-icon-right' }) : ''}${keys && !filled ? kbd(keys) : ''}${loading ? spinner({ size: size === 'lg' ? 16 : 14 }) : ''}
  </button>`;
}

/** Icon-only button. `label` is required: it becomes aria-label and the tooltip. */
export function iconButton({ icon: ico, label, action, data, size = 'md', variant = 'ghost', pressed, expanded, badge: dot, disabled, id, className, attrs, controls,
  tooltipPlacement, kbd: keys } = {}) {
  return html`<button type="button" class="${cx('icon-btn', size !== 'md' && `icon-btn-${size}`, variant !== 'ghost' && `icon-btn-${variant}`, className)}"
    aria-label="${label}" data-tooltip="${keys ? `${label} (${shortcutLabel(keys)})` : label}" ${tooltipPlacement ? html`data-tooltip-pos="${tooltipPlacement}"` : ''}
    ${keys ? html`aria-keyshortcuts="${keyshortcuts(keys)}"` : ''} ${id ? html`id="${id}"` : ''} ${action ? html`data-action="${action}"` : ''} ${dataAttrs(data)}
    ${pressed !== undefined ? html`aria-pressed="${pressed ? 'true' : 'false'}"` : ''} ${expanded !== undefined ? html`aria-expanded="${expanded ? 'true' : 'false'}" aria-haspopup="true"` : ''}
    ${controls ? html`aria-controls="${controls}"` : ''} ${disabled ? raw('disabled') : ''} ${extra(attrs)}>
    ${icon(ico, { size: size === 'sm' ? 14 : size === 'lg' ? 20 : 16 })}${dot ? html`<span class="icon-btn-badge" aria-hidden="true"></span>` : ''}
  </button>`;
}

/** Primary action with an attached menu trigger, e.g. "Save to Inbox ▾". */
export function splitButton({ label, icon: ico, action, data, menuAction, menuData, menuLabel = 'More options', variant = 'primary', size = 'md', disabled, className, loading } = {}) {
  return html`<div class="${cx('split-btn', `split-btn-${variant}`, size !== 'md' && `split-btn-${size}`, className)}" role="group">
    ${button({ label, icon: ico, variant, size, action, data, disabled, loading, className: 'split-btn-main' })}
    <button type="button" class="${cx('btn', `btn-${variant}`, size !== 'md' && `btn-${size}`, 'split-btn-menu')}" aria-label="${menuLabel}" aria-haspopup="true" aria-expanded="false"
      data-action="${menuAction}" ${dataAttrs(menuData)} ${disabled ? raw('disabled') : ''}>${icon('chevron-down', { size: 14 })}</button>
  </div>`;
}

/** Single-choice control. options: [{ value, label, icon, count, hideLabel }] */
export function segmented({ name, value, options, action, size = 'md', ariaLabel, className } = {}) {
  return html`<div class="${cx('segmented', size !== 'md' && `segmented-${size}`, className)}" role="radiogroup" aria-label="${ariaLabel || name}">
    ${options.map(option => html`<button type="button" role="radio" class="segmented-option" aria-checked="${option.value === value ? 'true' : 'false'}"
      tabindex="${option.value === value ? '0' : '-1'}" data-action="${action}" data-value="${option.value}" ${name ? html`data-name="${name}"` : ''}
      ${option.hideLabel ? html`aria-label="${option.label}" data-tooltip="${option.label}"` : ''}>
      ${option.icon ? icon(option.icon, { size: 14 }) : ''}${option.hideLabel ? '' : html`<span>${option.label}</span>`}${option.count != null ? count(option.count) : ''}
    </button>`)}
  </div>`;
}

/**
 * Picker for widget materials: a radiogroup of small previews painted by the same [data-frame] styles as widgets
 * (styles/dashboard.css). Same data attributes as segmented(), so the same actions handle it.
 */
export function materialPicker({ name, value, options, action, ariaLabel, className } = {}) {
  return html`<div class="${cx('material-picker', className)}" role="radiogroup" aria-label="${ariaLabel || name}">
    ${options.map(option => html`<button type="button" role="radio" class="material-option" aria-checked="${option.value === value ? 'true' : 'false'}"
      tabindex="${option.value === value ? '0' : '-1'}" data-action="${action}" data-value="${option.value}" ${name ? html`data-name="${name}"` : ''}
      ${option.description ? html`title="${option.description}"` : ''}>
      <span class="material-swatch" data-frame="${option.value}" aria-hidden="true"><span class="material-swatch-line"></span><span class="material-swatch-line is-short"></span></span>
      <span class="material-label">${option.label}</span>
    </button>`)}
  </div>`;
}

/** Tab list. options: [{ value, label, icon, count }]; panels are the caller's job (aria-controls via `controls`). */
export function tabs({ value, options, action, ariaLabel, className, controls } = {}) {
  return html`<div class="${cx('tabs', className)}" role="tablist" aria-label="${ariaLabel}">
    ${options.map(option => html`<button type="button" role="tab" class="tab" id="tab-${option.value}" aria-selected="${option.value === value ? 'true' : 'false'}"
      tabindex="${option.value === value ? '0' : '-1'}" data-action="${action}" data-value="${option.value}" ${controls ? html`aria-controls="${controls}"` : ''}>
      ${option.icon ? icon(option.icon, { size: 14 }) : ''}<span>${option.label}</span>${option.count != null ? count(option.count) : ''}
    </button>`)}
  </div>`;
}

export function chip({ label, icon: ico, color, selected, removable, action, removeAction, data, count: n, className, title } = {}) {
  const inner = html`${color ? html`<span class="chip-dot" style="--dot:${colorVar(color)}"></span>` : ico ? icon(ico, { size: 12 }) : ''}<span class="chip-label">${label}</span>${n != null ? html`<span class="chip-count">${n}</span>` : ''}`;
  const remove = removable ? html`<button type="button" class="chip-remove" aria-label="Remove ${label}" data-action="${removeAction}" ${dataAttrs(data)}>${icon('x', { size: 12 })}</button>` : '';
  return action
    ? html`<span class="${cx('chip', selected && 'is-selected', className)}"><button type="button" class="chip-main" data-action="${action}" ${dataAttrs(data)} aria-pressed="${selected ? 'true' : 'false'}" ${title ? html`title="${title}"` : ''}>${inner}</button>${remove}</span>`
    : html`<span class="${cx('chip', selected && 'is-selected', className)}" ${title ? html`title="${title}"` : ''}>${inner}${remove}</span>`;
}

/** Text input. `invalid` sets aria-invalid; `describedBy` links a hint or error (field() gives its error the id `${id}-error`). */
export function input({ name, value = '', placeholder = '', type = 'text', icon: ico, action, change, keydown, id, autofocus, required, disabled, className, attrs, label, size = 'md',
  invalid, describedBy, readonly } = {}) {
  const field = html`<input class="${cx('input', ico && 'has-icon', size !== 'md' && `input-${size}`)}" type="${type}" ${name ? html`name="${name}"` : ''} value="${value}"
    placeholder="${placeholder}" ${id ? html`id="${id}" data-focus-key="${id}"` : ''} ${action ? html`data-input="${action}"` : ''} ${change ? html`data-change="${change}"` : ''}
    ${keydown ? html`data-keydown="${keydown}"` : ''} ${autofocus ? raw('data-autofocus') : ''} ${required ? raw('required') : ''} ${disabled ? raw('disabled') : ''} ${readonly ? raw('readonly') : ''}
    ${invalid ? raw('aria-invalid="true"') : ''} ${describedBy ? html`aria-describedby="${describedBy}"` : ''}
    ${label ? html`aria-label="${label}"` : ''} autocomplete="off" spellcheck="false" ${extra(attrs)}>`;
  return ico ? html`<span class="${cx('input-wrap', className)}">${icon(ico, { size: 16, className: 'input-icon' })}${field}</span>` : className ? html`<span class="${className}">${field}</span>` : field;
}

export function searchField({ value = '', placeholder = 'Search', action, keydown, id = 'search', kbd: keys, className, label = 'Search', clearAction } = {}) {
  return html`<div class="${cx('search-field', className)}" role="search">
    ${icon('search', { size: 16, className: 'search-field-icon' })}
    <input class="search-field-input" type="search" id="${id}" data-focus-key="${id}" value="${value}" placeholder="${placeholder}" aria-label="${label}"
      autocomplete="off" spellcheck="false" ${action ? html`data-input="${action}"` : ''} ${keydown ? html`data-keydown="${keydown}"` : ''}>
    ${value && clearAction ? iconButton({ icon: 'x', label: 'Clear search', action: clearAction, size: 'sm', className: 'search-field-clear' }) : keys ? kbd(keys) : ''}
  </div>`;
}

export function textarea({ name, value = '', placeholder = '', rows = 3, action, change, keydown, id, autofocus, className, label, attrs, invalid, describedBy, disabled } = {}) {
  return html`<textarea class="${cx('textarea', className)}" ${name ? html`name="${name}"` : ''} rows="${rows}" placeholder="${placeholder}"
    ${id ? html`id="${id}" data-focus-key="${id}"` : ''} ${action ? html`data-input="${action}"` : ''} ${change ? html`data-change="${change}"` : ''}
    ${keydown ? html`data-keydown="${keydown}"` : ''} ${autofocus ? raw('data-autofocus') : ''} ${label ? html`aria-label="${label}"` : ''} ${disabled ? raw('disabled') : ''}
    ${invalid ? raw('aria-invalid="true"') : ''} ${describedBy ? html`aria-describedby="${describedBy}"` : ''} ${extra(attrs)}>${value}</textarea>`;
}

/** Native select styled as a control. options: [{ value, label }] or [{ group, options }] */
export function select({ name, value, options, action, id, label, className, size = 'md', disabled, invalid, describedBy } = {}) {
  const option = o => html`<option value="${o.value}" ${String(o.value) === String(value) ? raw('selected') : ''} ${o.disabled ? raw('disabled') : ''}>${o.label}</option>`;
  return html`<span class="${cx('select', size !== 'md' && `select-${size}`, className)}"><select ${name ? html`name="${name}"` : ''} ${id ? html`id="${id}"` : ''}
    ${action ? html`data-change="${action}"` : ''} ${label ? html`aria-label="${label}"` : ''} ${disabled ? raw('disabled') : ''}
    ${invalid ? raw('aria-invalid="true"') : ''} ${describedBy ? html`aria-describedby="${describedBy}"` : ''}>
    ${options.map(o => o.group ? html`<optgroup label="${o.group}">${o.options.map(option)}</optgroup>` : option(o))}
  </select>${icon('chevrons-up-down', { size: 14, className: 'select-icon' })}</span>`;
}

export function checkbox({ checked, label, action, data, name, id, className, hideLabel, indeterminate, disabled, value } = {}) {
  return html`<label class="${cx('checkbox', className)}"><input type="checkbox" ${name ? html`name="${name}"` : ''} ${id ? html`id="${id}"` : ''} ${value != null ? html`value="${value}"` : ''}
    ${checked ? raw('checked') : ''} ${indeterminate ? raw('data-indeterminate') : ''} ${disabled ? raw('disabled') : ''} ${action ? html`data-change="${action}"` : ''} ${dataAttrs(data)}
    ${hideLabel ? html`aria-label="${label}"` : ''}><span class="checkbox-box" aria-hidden="true">${icon('check', { size: 12, strokeWidth: 3 })}</span>${hideLabel ? '' : html`<span class="checkbox-label">${label}</span>`}</label>`;
}

export function switchToggle({ checked, label, description, action, data, name, id, disabled, className } = {}) {
  return html`<label class="${cx('switch', disabled && 'is-disabled', className)}"><span class="switch-text"><span class="switch-label">${label}</span>${description ? html`<span class="switch-description">${description}</span>` : ''}</span>
    <input type="checkbox" role="switch" ${name ? html`name="${name}"` : ''} ${id ? html`id="${id}"` : ''} ${checked ? raw('checked') : ''} ${disabled ? raw('disabled') : ''}
      ${action ? html`data-change="${action}"` : ''} ${dataAttrs(data)}><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></label>`;
}

/** Label + control + hint or error. With `id`, the hint is `${id}-hint` and the error `${id}-error` (pass it to the control's describedBy). */
export function field({ label, hint, error, control, id, className, inline } = {}) {
  return html`<div class="${cx('field', inline && 'field-inline', error && 'has-error', className)}">
    ${label ? html`<label class="field-label" ${id ? html`for="${id}"` : ''}>${label}</label>` : ''}
    <div class="field-control">${control}</div>
    ${error ? html`<p class="field-error" role="alert" ${id ? html`id="${id}-error"` : ''}>${icon('circle-alert', { size: 14 })}<span>${error}</span></p>`
      : hint ? html`<p class="field-hint" ${id ? html`id="${id}-hint"` : ''}>${hint}</p>` : ''}
  </div>`;
}

export const badge = ({ label, tone = 'neutral', icon: ico, className } = {}) => html`<span class="${cx('badge', className)}" data-tone="${tone}">${ico ? icon(ico, { size: 12 }) : ''}${label}</span>`;
export const count = n => html`<span class="count">${typeof n === 'number' ? n.toLocaleString() : n}</span>`;
export const spinner = ({ size = 16, label } = {}) => html`<span class="spinner" style="--size:${size}px" ${label ? html`role="status" aria-label="${label}"` : raw('aria-hidden="true"')}></span>`;

/** Empty, no-results and error screens. tone: 'danger' tints the icon for load errors. */
export function emptyState({ icon: ico = 'inbox', title, body, actions, compact, className, tone } = {}) {
  return html`<div class="${cx('empty-state', compact && 'is-compact', className)}" ${tone ? html`data-tone="${tone}"` : ''} ${tone === 'danger' ? raw('role="alert"') : ''}>
    <span class="empty-state-icon" aria-hidden="true">${icon(ico, { size: compact ? 20 : 24 })}</span>
    <p class="empty-state-title">${title}</p>${body ? html`<p class="empty-state-body">${body}</p>` : ''}
    ${actions ? html`<div class="empty-state-actions">${actions}</div>` : ''}
  </div>`;
}

const bone = cls => html`<span class="${cx('skeleton-bone', cls)}"></span>`;
const SKELETON_PARTS = {
  row: () => html`${bone('skeleton-thumb')}<span class="skeleton-lines">${bone('skeleton-line is-title')}${bone('skeleton-line')}${bone('skeleton-line is-short')}</span>`,
  card: () => html`${bone('skeleton-thumb')}<span class="skeleton-lines">${bone('skeleton-line is-title')}${bone('skeleton-line is-short')}</span>`,
  tree: () => html`${bone('skeleton-thumb')}${bone('skeleton-line')}`,
  text: () => bone('skeleton-line'),
};
/** Loading placeholders in the final geometry. variant: 'row' (list row) | 'card' | 'tree' (sidebar row) | 'text' (one line). */
export function skeleton({ rows = 3, variant = 'row', className } = {}) {
  const parts = SKELETON_PARTS[variant] || SKELETON_PARTS.text;
  return html`<div class="${cx('skeleton-group', className)}" aria-hidden="true">${Array.from({ length: rows }, () => html`<div class="skeleton skeleton-${variant}">${parts()}</div>`)}</div>`;
}

/** Dialog chrome for overlay.registerDialog renderers. The title id matches overlay.js aria-labelledby. */
export function dialogFrame({ name, title, subtitle, body, footer, closable = true, headerActions, className } = {}) {
  return html`<div class="${cx('dialog-header', className)}">
      <div class="dialog-heading"><h2 class="dialog-title" id="dialog-title-${name}">${title}</h2>${subtitle ? html`<p class="dialog-subtitle">${subtitle}</p>` : ''}</div>
      ${headerActions || ''}${closable ? iconButton({ icon: 'x', label: 'Close', action: 'overlay.dismiss', size: 'sm', className: 'dialog-close' }) : ''}
    </div>
    <div class="dialog-body">${body}</div>
    ${footer ? html`<div class="dialog-footer">${footer}</div>` : ''}`;
}

const NAMED_COLORS = new Set(['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'pink', 'gray']);
const HEX_TO_NAME = { '#e5484d': 'red', '#f76b15': 'orange', '#e08a1e': 'amber', '#d6a90b': 'yellow', '#5c9a1f': 'lime', '#30a46c': 'green', '#12a594': 'teal',
  '#0797b9': 'cyan', '#0d74ce': 'blue', '#5b5bd6': 'indigo', '#8e4ec6': 'violet', '#d9467a': 'pink', '#7c7f86': 'gray', '#cc4e00': 'orange' };
/** Maps a stored collection color (named or #hex) to a CSS value: a palette token when known, else the sanitized hex. */
export function colorVar(color) {
  const value = String(color || '').toLowerCase();
  if (NAMED_COLORS.has(value)) return `var(--c-${value})`;
  if (HEX_TO_NAME[value]) return `var(--c-${HEX_TO_NAME[value]})`;
  return /^#[\da-f]{3,8}$/.test(value) ? value : 'var(--c-gray)';
}
export const colorName = color => NAMED_COLORS.has(String(color).toLowerCase()) ? String(color).toLowerCase() : HEX_TO_NAME[String(color || '').toLowerCase()] || null;
const EMOJI = /\p{Extended_Pictographic}/u;

/** Colored tile with the collection's icon (or the user's emoji). Inbox: collectionIcon(null). */
export function collectionIcon(collection, { size = 18, className } = {}) {
  if (!collection) return html`<span class="${cx('collection-icon', 'is-inbox', className)}" style="--size:${size}px" aria-hidden="true">${icon('inbox', { size: Math.round(size * 0.72) })}</span>`;
  const glyph = String(collection.icon || 'folder');
  const name = colorName(collection.color);
  return html`<span class="${cx('collection-icon', className)}" ${name ? html`data-color="${name}"` : ''} style="--size:${size}px${name ? '' : `;--tile:${colorVar(collection.color)}`}" aria-hidden="true">${EMOJI.test(glyph)
    ? html`<span class="collection-emoji">${[...glyph].slice(0, 2).join('')}</span>`
    : icon(glyph, { size: Math.round(size * 0.72) })}</span>`;
}

export const domainOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const TILE_HUES = ['red', 'orange', 'amber', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'pink'];
/** Letter tile for a site (no favicon permission); deterministic color per domain. */
export function favicon(url, { size = 16, className } = {}) {
  const domain = domainOf(url);
  if (!domain) return html`<span class="${cx('favicon', 'is-empty', className)}" style="--size:${size}px" aria-hidden="true">${icon('sticky-note', { size: Math.round(size * 0.75) })}</span>`;
  let hash = 0;
  for (const ch of domain) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return html`<span class="${cx('favicon', className)}" data-color="${TILE_HUES[hash % TILE_HUES.length]}" style="--size:${size}px" aria-hidden="true">${domain[0].toUpperCase()}</span>`;
}

/**
 * Real site icon (Chrome's favicon cache through the "favicon" permission) on a letter-tile fallback. The letter tile
 * shows until the image loads and stays when Chrome has no icon, so a missing favicon never leaves an empty box.
 * Outside the extension it is the letter tile alone. src: the page's own icon (an article's saved `icon`), used instead
 * of Chrome's favicon when it is a safe image address; it sits on the same letter tile.
 */
export function siteIcon(url, { size = 16, className, rounded = true, src = '' } = {}) {
  const tile = favicon(url, { size, className: cx('site-icon-fallback', rounded && 'is-rounded') });
  const own = safeSrc(src);
  const img = value => html`<img class="site-icon-img" src="${value}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async" draggable="false"${own ? raw(' referrerpolicy="no-referrer"') : ''}>`;
  if (own) return html`<span class="${cx('site-icon', className)}" style="--size:${size}px">${tile}${img(own)}</span>`;
  const domain = domainOf(url);
  const runtime = globalThis.chrome?.runtime;
  if (!domain || !runtime?.id || typeof runtime.getURL !== 'function') return html`<span class="${cx('site-icon', className)}" style="--size:${size}px">${tile}</span>`;
  return html`<span class="${cx('site-icon', className)}" style="--size:${size}px">${tile}${img(`${runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=${size > 32 ? 64 : 32}`)}</span>`;
}

/**
 * Cover image with a graceful fallback: without art it renders a tile tinted with `color` (a collection color name or
 * hex) showing `fallback` markup, else `icon` (e.g. TYPE_ICONS[item.type]), else `letter`. Never a dark empty slab.
 */
export function cover(src, { alt = '', className, ratio, fallback, color, icon: ico, letter, width, height } = {}) {
  const url = safeSrc(src);
  const name = colorName(color);
  const style = [ratio && `aspect-ratio:${ratio}`, color && !name && `--tile:${colorVar(color)}`].filter(Boolean).join(';');
  const size = width && height ? html`width="${width}" height="${height}"` : '';
  return url
    ? html`<span class="${cx('cover', className)}" ${style ? html`style="${style}"` : ''}><img src="${url}" alt="${alt}" ${size} loading="lazy" decoding="async" referrerpolicy="no-referrer"></span>`
    : html`<span class="${cx('cover', 'is-empty', className)}" ${name ? html`data-color="${name}"` : ''} ${style ? html`style="${style}"` : ''} aria-hidden="true">${fallback
      || (ico ? icon(ico, { size: 24 }) : letter ? html`<span class="cover-letter">${String(letter).slice(0, 1).toUpperCase()}</span>` : '')}</span>`;
}

/** Letter or icon tile (providers, people). color: palette name or hex; solid: filled tile with a contrasting glyph. */
export function avatarTile({ label = '', icon: ico, color, size = 28, round, solid, className, title } = {}) {
  const name = colorName(color);
  const initials = String(label).trim().split(/\s+/).slice(0, 2).map(word => [...word][0] || '').join('').toUpperCase();
  return html`<span class="${cx('avatar-tile', round && 'is-round', solid && 'is-solid', className)}" ${name ? html`data-color="${name}"` : ''}
    style="--size:${size}px${color && !name ? `;--tile:${colorVar(color)}` : ''}" ${title ? html`title="${title}"` : ''} aria-hidden="true">${ico
    ? icon(ico, { size: Math.round(size * 0.57) }) : initials.slice(0, size < 24 ? 1 : 2)}</span>`;
}

/** Highlight colors with tokens (--hl-<name>, --hl-<name>-mark). highlightColor() maps anything else to yellow. */
export const HIGHLIGHT_COLORS = ['yellow', 'amber', 'orange', 'red', 'pink', 'purple', 'blue', 'green', 'teal', 'gray'];
export const highlightColor = color => {
  const value = String(color || '').toLowerCase();
  return value === 'violet' ? 'purple' : HIGHLIGHT_COLORS.includes(value) ? value : 'yellow';
};

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;
export function relativeDate(iso) {
  const time = Date.parse(iso);
  if (!time) return '';
  const diff = (time - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return 'Just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  return shortDate(iso);
}
export function shortDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
export function fileSize(bytes = 0) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}
export const TYPE_LABELS = { bookmark: 'Link', article: 'Article', note: 'Note', file: 'File', image: 'Image', video: 'Video', chat: 'Chat' };
export const TYPE_ICONS = { bookmark: 'bookmark', article: 'newspaper', note: 'sticky-note', file: 'file-text', image: 'image', video: 'film', chat: 'messages-square' };
