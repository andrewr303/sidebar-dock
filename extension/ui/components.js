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

export function button({ label, icon: ico, iconRight, variant = 'secondary', size = 'md', action, data, type = 'button', disabled, pressed, loading,
  kbd: keys, title, id, className, attrs, hideLabel = false } = {}) {
  return html`<button type="${type}" class="${cx('btn', `btn-${variant}`, size !== 'md' && `btn-${size}`, loading && 'is-loading', className)}"
    ${id ? html`id="${id}"` : ''} ${action ? html`data-action="${action}"` : ''} ${dataAttrs(data)}
    ${pressed !== undefined ? html`aria-pressed="${pressed ? 'true' : 'false'}"` : ''} ${disabled ? raw('disabled') : ''}
    ${loading ? raw('aria-busy="true"') : ''} ${title ? html`title="${title}"` : ''} ${hideLabel ? html`aria-label="${label}"` : ''} ${extra(attrs)}>
    ${loading ? spinner({ size: 14 }) : ico ? icon(ico, { size: size === 'sm' ? 14 : 16 }) : ''}${hideLabel ? '' : html`<span class="btn-label">${label}</span>`}${iconRight ? icon(iconRight, { size: 14, className: 'btn-icon-right' }) : ''}${keys ? kbd(keys) : ''}
  </button>`;
}

/** Icon-only button. `label` is required: it becomes aria-label and the tooltip. */
export function iconButton({ icon: ico, label, action, data, size = 'md', variant = 'ghost', pressed, expanded, badge: dot, disabled, id, className, attrs, controls } = {}) {
  return html`<button type="button" class="${cx('icon-btn', size !== 'md' && `icon-btn-${size}`, variant !== 'ghost' && `icon-btn-${variant}`, className)}"
    aria-label="${label}" data-tooltip="${label}" ${id ? html`id="${id}"` : ''} ${action ? html`data-action="${action}"` : ''} ${dataAttrs(data)}
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

export function input({ name, value = '', placeholder = '', type = 'text', icon: ico, action, change, keydown, id, autofocus, required, disabled, className, attrs, label, size = 'md' } = {}) {
  const field = html`<input class="${cx('input', ico && 'has-icon', size !== 'md' && `input-${size}`)}" type="${type}" ${name ? html`name="${name}"` : ''} value="${value}"
    placeholder="${placeholder}" ${id ? html`id="${id}" data-focus-key="${id}"` : ''} ${action ? html`data-input="${action}"` : ''} ${change ? html`data-change="${change}"` : ''}
    ${keydown ? html`data-keydown="${keydown}"` : ''} ${autofocus ? raw('data-autofocus') : ''} ${required ? raw('required') : ''} ${disabled ? raw('disabled') : ''}
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

export function textarea({ name, value = '', placeholder = '', rows = 3, action, change, id, autofocus, className, label, attrs } = {}) {
  return html`<textarea class="${cx('textarea', className)}" ${name ? html`name="${name}"` : ''} rows="${rows}" placeholder="${placeholder}"
    ${id ? html`id="${id}" data-focus-key="${id}"` : ''} ${action ? html`data-input="${action}"` : ''} ${change ? html`data-change="${change}"` : ''}
    ${autofocus ? raw('data-autofocus') : ''} ${label ? html`aria-label="${label}"` : ''} ${extra(attrs)}>${value}</textarea>`;
}

/** Native select styled as a control. options: [{ value, label }] or [{ group, options }] */
export function select({ name, value, options, action, id, label, className, size = 'md' } = {}) {
  const option = o => html`<option value="${o.value}" ${String(o.value) === String(value) ? raw('selected') : ''}>${o.label}</option>`;
  return html`<span class="${cx('select', size !== 'md' && `select-${size}`, className)}"><select ${name ? html`name="${name}"` : ''} ${id ? html`id="${id}"` : ''}
    ${action ? html`data-change="${action}"` : ''} ${label ? html`aria-label="${label}"` : ''}>
    ${options.map(o => o.group ? html`<optgroup label="${o.group}">${o.options.map(option)}</optgroup>` : option(o))}
  </select>${icon('chevrons-up-down', { size: 14, className: 'select-icon' })}</span>`;
}

export function checkbox({ checked, label, action, data, name, id, className, hideLabel, indeterminate } = {}) {
  return html`<label class="${cx('checkbox', className)}"><input type="checkbox" ${name ? html`name="${name}"` : ''} ${id ? html`id="${id}"` : ''}
    ${checked ? raw('checked') : ''} ${indeterminate ? raw('data-indeterminate') : ''} ${action ? html`data-change="${action}"` : ''} ${dataAttrs(data)}
    ${hideLabel ? html`aria-label="${label}"` : ''}><span class="checkbox-box" aria-hidden="true">${icon('check', { size: 12, strokeWidth: 3 })}</span>${hideLabel ? '' : html`<span class="checkbox-label">${label}</span>`}</label>`;
}

export function switchToggle({ checked, label, description, action, data, name, id, disabled, className } = {}) {
  return html`<label class="${cx('switch', disabled && 'is-disabled', className)}"><span class="switch-text"><span class="switch-label">${label}</span>${description ? html`<span class="switch-description">${description}</span>` : ''}</span>
    <input type="checkbox" role="switch" ${name ? html`name="${name}"` : ''} ${id ? html`id="${id}"` : ''} ${checked ? raw('checked') : ''} ${disabled ? raw('disabled') : ''}
      ${action ? html`data-change="${action}"` : ''} ${dataAttrs(data)}><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></label>`;
}

export function field({ label, hint, error, control, id, className, inline } = {}) {
  return html`<div class="${cx('field', inline && 'field-inline', error && 'has-error', className)}">
    ${label ? html`<label class="field-label" ${id ? html`for="${id}"` : ''}>${label}</label>` : ''}
    <div class="field-control">${control}</div>
    ${error ? html`<p class="field-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${error}</span></p>` : hint ? html`<p class="field-hint">${hint}</p>` : ''}
  </div>`;
}

export const badge = ({ label, tone = 'neutral', icon: ico, className } = {}) => html`<span class="${cx('badge', className)}" data-tone="${tone}">${ico ? icon(ico, { size: 12 }) : ''}${label}</span>`;
export const count = n => html`<span class="count">${typeof n === 'number' ? n.toLocaleString() : n}</span>`;
export const spinner = ({ size = 16, label } = {}) => html`<span class="spinner" style="--size:${size}px" ${label ? html`role="status" aria-label="${label}"` : raw('aria-hidden="true"')}></span>`;

export function emptyState({ icon: ico = 'inbox', title, body, actions, compact, className } = {}) {
  return html`<div class="${cx('empty-state', compact && 'is-compact', className)}">
    <span class="empty-state-icon" aria-hidden="true">${icon(ico, { size: compact ? 20 : 24 })}</span>
    <p class="empty-state-title">${title}</p>${body ? html`<p class="empty-state-body">${body}</p>` : ''}
    ${actions ? html`<div class="empty-state-actions">${actions}</div>` : ''}
  </div>`;
}

export function skeleton({ rows = 3, variant = 'row', className } = {}) {
  return html`<div class="${cx('skeleton-group', className)}" aria-hidden="true">${Array.from({ length: rows }, () => html`<div class="skeleton skeleton-${variant}"></div>`)}</div>`;
}

/** Dialog chrome for overlay.registerDialog renderers. The title id matches overlay.js aria-labelledby. */
export function dialogFrame({ name, title, subtitle, body, footer, closable = true, headerActions, className } = {}) {
  return html`<header class="${cx('dialog-header', className)}">
      <div class="dialog-heading"><h2 class="dialog-title" id="dialog-title-${name}">${title}</h2>${subtitle ? html`<p class="dialog-subtitle">${subtitle}</p>` : ''}</div>
      ${headerActions || ''}${closable ? iconButton({ icon: 'x', label: 'Close', action: 'overlay.dismiss', size: 'sm', className: 'dialog-close' }) : ''}
    </header>
    <div class="dialog-body">${body}</div>
    ${footer ? html`<footer class="dialog-footer">${footer}</footer>` : ''}`;
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

/** Cover image with a graceful fallback block. */
export function cover(src, { alt = '', className, ratio, fallback } = {}) {
  const url = safeSrc(src);
  return url
    ? html`<span class="${cx('cover', className)}" ${ratio ? html`style="aspect-ratio:${ratio}"` : ''}><img src="${url}" alt="${alt}" loading="lazy" decoding="async" referrerpolicy="no-referrer"></span>`
    : html`<span class="${cx('cover', 'is-empty', className)}" ${ratio ? html`style="aspect-ratio:${ratio}"` : ''} aria-hidden="true">${fallback || ''}</span>`;
}

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
export const TYPE_LABELS = { bookmark: 'Link', article: 'Article', note: 'Note', file: 'File', image: 'Image', video: 'Video' };
export const TYPE_ICONS = { bookmark: 'bookmark', article: 'newspaper', note: 'sticky-note', file: 'file-text', image: 'image', video: 'film' };
