// Item renderers for every layout: list rows, cover cards, masonry tiles, headline rows, side-panel media cards,
// compact side rows and note cards. Each card opens its item through app.open-item, can be dragged onto a collection
// (data-drag-item) and carries the selection checkbox used by library.js.
import { html, raw, cx, esc, safeSrc } from './html.js';
import { icon } from './icons.js';
import { favicon, relativeDate, shortDate, domainOf, colorName, colorVar, collectionIcon, TYPE_LABELS, TYPE_ICONS } from './components.js';
import { renderMarkdown } from '../lib/markdown.js';
import { taskProgress, linkResolver } from '../lib/notes.js';

const TILE_HUES = ['red', 'orange', 'amber', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'pink'];
const TYPE_HUES = { note: 'yellow', image: 'violet', video: 'pink', file: 'gray' };
const MEDIA_TYPES = new Set(['image', 'video']);
const brokenCovers = new Set();
let notifyBroken = null;

/** Same hash as components.favicon, so a generated tile matches the site's letter tile. */
export function hueForDomain(domain) {
  if (!domain) return 'gray';
  let hash = 0;
  for (const ch of domain) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TILE_HUES[hash % TILE_HUES.length];
}

/** Tile color for an item without a cover: its collection's hue, else a type hue, else the site's hue. */
export function tileHue(item, collection) {
  const named = collection && colorName(collection.color);
  if (named) return { name: named };
  if (collection && /^#[\da-f]{3,8}$/i.test(collection.color || '')) return { hex: collection.color };
  if (TYPE_HUES[item.type]) return { name: TYPE_HUES[item.type] };
  return { name: hueForDomain(domainOf(item.url || item.sourceUrl)) };
}

/** Drops a leading "# Title" heading that only repeats the note title, so previews start with the body. */
export function notePreviewSource(content, title) {
  const text = String(content || '');
  const match = /^\s*#{1,3}[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/.exec(text);
  if (match && match[1].trim().toLowerCase() === String(title || '').trim().toLowerCase()) return text.slice(match[0].length).replace(/^\s*\n/, '');
  return text;
}

/** Minutes to read a text at 230 words per minute (0 for no text). */
export function readingMinutes(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return words ? Math.max(1, Math.round(words / 230)) : 0;
}

const memo = new Map();
function remember(key, compute) {
  if (memo.has(key)) return memo.get(key);
  const value = compute();
  memo.set(key, value);
  if (memo.size > 800) memo.delete(memo.keys().next().value);
  return value;
}
let resolverStamp = null;
let resolver = () => null;
export function noteLinkResolver(ctx) {
  const library = ctx.library;
  if (library?.updatedAt !== resolverStamp) { resolverStamp = library?.updatedAt; resolver = linkResolver(library?.items || []); }
  return resolver;
}
const progressOf = item => item.type === 'note' && item.content ? remember(`tasks:${item.id}:${item.updatedAt}`, () => taskProgress(item.content)) : { done: 0, total: 0 };
const previewOf = (ctx, item, compact = true) => remember(`md:${item.id}:${item.updatedAt}:${compact}`,
  () => raw(renderMarkdown(notePreviewSource(item.content || item.excerpt, item.title), { compact, resolveLink: noteLinkResolver(ctx) })));

export const itemDomain = item => domainOf(item.url) || domainOf(item.sourceUrl);
export function itemSource(item) {
  if (item.type === 'note') return itemDomain(item) || 'Note';
  return itemDomain(item) || item.fileName || TYPE_LABELS[item.type] || 'Item';
}
export const coverOf = item => {
  const src = safeSrc(item.cover);
  return src && !brokenCovers.has(src) ? src : '';
};

/** Called by library.js once: a broken cover image falls back to its generated tile on the next render. */
export function watchBrokenCovers(onChange) {
  notifyBroken = onChange;
  document.addEventListener('error', event => {
    const img = event.target;
    if (img?.tagName !== 'IMG' || !img.closest('[data-cover]')) return;
    const src = img.getAttribute('src');
    if (!src || brokenCovers.has(src)) return;
    brokenCovers.add(src);
    notifyBroken?.();
  }, true);
}

const img = (src, { alt = '', className } = {}) => html`<img class="${className || ''}" src="${src}" alt="${alt}" loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable="false">`;
const hueStyle = hue => hue.name ? `--gen:var(--c-${hue.name})` : `--gen:${hue.hex}`;

/** Generated cover: tinted tile in the collection (or type, or site) hue with the site letter or type icon. */
export function generatedArt(ctx, item, { size = 'md', className } = {}) {
  const hue = tileHue(item, item.collectionId ? ctx.select.collection(item.collectionId) : null);
  const domain = itemDomain(item);
  const glyph = item.type === 'note' || item.type === 'file' || !domain || (MEDIA_TYPES.has(item.type) && !item.url)
    ? icon(TYPE_ICONS[item.type] || 'bookmark', { size: size === 'lg' ? 32 : size === 'sm' ? 18 : 22 })
    : html`<span class="item-gen-letter">${domain[0].toUpperCase()}</span>`;
  return html`<span class="${cx('item-gen', `item-gen-${size}`, className)}" style="${hueStyle(hue)}" aria-hidden="true">${glyph}</span>`;
}

/** Thumbnail for list rows and related lists: the cover image or a generated tile. */
export function itemThumb(ctx, item, { className, size = 'md' } = {}) {
  const src = coverOf(item);
  return src
    ? html`<span class="${cx('item-thumb', className)}" data-cover>${img(src)}</span>`
    : html`<span class="${cx('item-thumb', 'is-generated', className)}">${generatedArt(ctx, item, { size })}</span>`;
}

const dot = html`<span class="item-dot" aria-hidden="true">·</span>`;

function sourceBit(item, { fav = 14 } = {}) {
  if (item.type === 'note' && !itemDomain(item)) return html`<span class="item-source">${icon('sticky-note', { size: 12 })}<span class="item-source-text">Note</span></span>`;
  const url = item.url || item.sourceUrl;
  if (!url) return html`<span class="item-source">${icon(TYPE_ICONS[item.type] || 'file', { size: 12 })}<span class="item-source-text">${item.fileName || TYPE_LABELS[item.type] || 'Item'}</span></span>`;
  return html`<span class="item-source">${favicon(url, { size: fav })}<span class="item-source-text">${itemSource(item)}</span></span>`;
}

function collectionBit(ctx, item) {
  const collection = item.collectionId ? ctx.select.collection(item.collectionId) : null;
  if (!collection) return '';
  return html`<span class="item-collection">${collectionIcon(collection, { size: 14 })}<span>${collection.name}</span></span>`;
}

function tagBits(item, limit = 3) {
  const tags = (item.tags || []).slice(0, limit);
  if (!tags.length) return '';
  return html`<span class="item-tags">${tags.map(tag => html`<button type="button" class="item-tag" data-action="library.filter-tag" data-tag="${tag}" tabindex="-1" title="Show items tagged ${tag}"><span class="item-hash" aria-hidden="true">#</span>${tag}</button>`)}${(item.tags || []).length > limit ? html`<span class="item-tag-more">+${item.tags.length - limit}</span>` : ''}</span>`;
}

const sentence = text => text === 'Just now' ? 'just now' : text;
function itemDate(item, view) {
  if (view === 'trash' && item.deletedAt) return `Deleted ${sentence(relativeDate(item.deletedAt))}`;
  return relativeDate(item.createdAt);
}

/** Small status icons on the end of a row: favorite, highlights, notes, tasks, reminder, file. */
export function indicators(ctx, item, { compact = false } = {}) {
  const parts = [];
  const notes = item.type !== 'note' && item.url ? ctx.select.notesForUrl(item.url).length : 0;
  const tasks = progressOf(item);
  const highlights = item.highlights?.length || 0;
  if (item.reminderAt && !item.reminderNotifiedAt) parts.push(html`<span class="item-ind" title="Reminder ${shortDate(item.reminderAt)}">${icon('bell', { size: 14 })}<span class="sr-only">Reminder set</span></span>`);
  if (tasks.total) parts.push(html`<span class="${cx('item-ind', tasks.done === tasks.total && 'is-done')}" title="${tasks.done} of ${tasks.total} tasks done">${icon('list-checks', { size: 14 })}${tasks.done}/${tasks.total}</span>`);
  if (highlights) parts.push(html`<span class="item-ind" title="${highlights} ${highlights === 1 ? 'highlight' : 'highlights'}">${icon('highlighter', { size: 14 })}${highlights}</span>`);
  if (notes) parts.push(html`<span class="item-ind" title="${notes} ${notes === 1 ? 'note' : 'notes'} on this page">${icon('sticky-note', { size: 14 })}${notes}</span>`);
  else if (item.type !== 'note' && item.content && !compact) parts.push(html`<span class="item-ind" title="Has a note">${icon('notebook-pen', { size: 14 })}<span class="sr-only">Has a note</span></span>`);
  if (item.attachmentId && !compact) parts.push(html`<span class="item-ind" title="${item.fileName || 'Attached file'}">${icon('paperclip', { size: 14 })}<span class="sr-only">Attached file</span></span>`);
  if (item.favorite) parts.push(html`<span class="item-ind is-favorite" title="Favorite">${icon('star', { size: 14 })}<span class="sr-only">Favorite</span></span>`);
  return parts.length ? html`<span class="item-indicators">${parts}</span>` : '';
}

const dataAttrs = data => raw(Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' '));
/** Row action button. Cards clip their corners, so overlay actions open their tooltip downwards, inside the card. */
const act = (glyph, label, action, data = {}, { extra = '', below = false } = {}) => html`<button type="button" class="${cx('item-act', extra)}" aria-label="${label}"
  data-tooltip="${label}" ${below ? raw('data-tooltip-pos="bottom end"') : ''} data-action="${action}" ${dataAttrs(data)} tabindex="-1">${icon(glyph, { size: 16 })}</button>`;

/** Hover toolbar. Trash and Archive swap in their own primary actions. */
export function rowActions(ctx, item, { overlay = false } = {}) {
  const id = item.id;
  const below = overlay;
  let buttons;
  if (item.deletedAt) {
    buttons = [act('rotate-ccw', 'Restore', 'library.restore', { id }, { below }), act('trash-2', 'Delete forever', 'library.delete-forever', { id }, { extra: 'is-danger', below })];
  } else if (item.archived) {
    buttons = [act('archive-restore', 'Unarchive', 'library.unarchive', { id }, { below }), act('ellipsis', 'More actions', 'library.item-menu', { id }, { below })];
  } else {
    buttons = [
      item.url ? act('external-link', 'Open page', 'app.open-url', { url: item.url }, { below }) : '',
      act('star', item.favorite ? 'Remove from favorites' : 'Add to favorites', 'library.favorite', { id }, { extra: item.favorite && 'is-on', below }),
      act('pencil', 'Edit details', 'app.open-item', { id, tab: 'details' }, { below }),
      act('ellipsis', 'More actions', 'library.item-menu', { id }, { below }),
    ];
  }
  return html`<span class="${cx('item-actions', overlay && 'is-overlay')}" role="group" aria-label="Actions for ${item.title}">${buttons}</span>`;
}

function check(item, selected) {
  return html`<button type="button" class="item-check" role="checkbox" aria-checked="${selected ? 'true' : 'false'}" aria-label="Select ${item.title}"
    data-action="library.toggle-select" data-id="${item.id}" tabindex="-1">${icon('check', { size: 12, strokeWidth: 3 })}</button>`;
}

function shell(ctx, item, { selected, tabStop, className, label }, inner) {
  const active = ctx.state.panel?.kind === 'item' && ctx.state.panel.id === item.id;
  if (selected) label += ', selected';
  return html`<article class="${cx('item', className, selected && 'is-selected', active && 'is-active', item.type === 'note' && 'is-note')}"
    data-key="item:${item.id}" data-item-card data-id="${item.id}" data-action="app.open-item" draggable="true" data-drag-item="${item.id}"
    role="listitem" tabindex="${tabStop ? '0' : '-1'}" aria-label="${label}" ${active ? raw('aria-current="true"') : ''}>${inner}</article>`;
}

const ariaLabel = item => [item.title, TYPE_LABELS[item.type], itemSource(item) !== TYPE_LABELS[item.type] ? itemSource(item) : '', item.favorite ? 'favorite' : ''].filter(Boolean).join(', ');

function listRow(ctx, item, opts) {
  const desc = item.excerpt;
  return shell(ctx, item, { ...opts, className: 'item-row', label: ariaLabel(item) }, html`
    <span class="item-lead">${itemThumb(ctx, item)}${check(item, opts.selected)}</span>
    <span class="item-main">
      <span class="item-title">${item.title}</span>
      ${desc ? html`<span class="item-desc">${desc}</span>` : ''}
      <span class="item-meta">${sourceBit(item)}${dot}<span class="item-date">${itemDate(item, opts.view)}</span>${opts.showCollection && item.collectionId ? html`${dot}${collectionBit(ctx, item)}` : ''}${tagBits(item)}</span>
      ${opts.view === 'highlights' ? quotes(item) : ''}
    </span>
    <span class="item-side">${indicators(ctx, item)}${rowActions(ctx, item, opts)}</span>`);
}

/** Highlights view: the first few quotes under the row, in their marker colors. */
function quotes(item) {
  const list = (item.highlights || []).slice(0, 3);
  if (!list.length) return '';
  const more = (item.highlights || []).length - list.length;
  return html`<span class="item-quotes markdown-body">${list.map(h => html`<span class="item-quote"><span class="item-quote-text"><mark data-color="${h.color || 'yellow'}">${h.text}</mark></span>${h.note ? html`<span class="item-quote-note">${h.note}</span>` : ''}</span>`)}${more > 0 ? html`<span class="item-quote-more">${more} more</span>` : ''}</span>`;
}

function headlineRow(ctx, item, opts) {
  return shell(ctx, item, { ...opts, className: 'item-headline', label: ariaLabel(item) }, html`
    <span class="item-lead">${item.url || item.sourceUrl ? favicon(item.url || item.sourceUrl, { size: 16 }) : html`<span class="item-type-glyph">${icon(TYPE_ICONS[item.type] || 'file', { size: 14 })}</span>`}${check(item, opts.selected)}</span>
    <span class="item-title">${item.title}</span>
    ${tagBits(item, 2)}
    <span class="item-meta"><span class="item-source-text">${itemSource(item)}</span>${dot}<span class="item-date">${itemDate(item, opts.view)}</span></span>
    <span class="item-side">${indicators(ctx, item, { compact: true })}${rowActions(ctx, item, opts)}</span>`);
}

function noteCard(ctx, item, opts) {
  const tasks = progressOf(item);
  const collection = item.collectionId ? ctx.select.collection(item.collectionId) : null;
  const domain = itemDomain(item);
  return shell(ctx, item, { ...opts, className: cx('item-notecard', opts.surface === 'side' && 'is-side'), label: ariaLabel(item) }, html`
    ${check(item, opts.selected)}
    <span class="note-head">${collection ? html`<span class="note-dot" style="--dot:${colorVar(collection.color)}" aria-hidden="true"></span>` : ''}<span class="item-title">${item.title}</span>${item.pinned ? html`<span class="note-pin" title="Pinned">${icon('pin', { size: 14 })}<span class="sr-only">Pinned</span></span>` : ''}</span>
    <span class="note-preview markdown-body">${previewOf(ctx, item)}</span>
    <span class="item-meta">${domain ? html`<span class="item-source">${favicon(item.url, { size: 14 })}<span class="item-source-text">${domain}</span></span>${dot}` : ''}${tasks.total ? html`<span class="${cx('item-ind', tasks.done === tasks.total && 'is-done')}" title="${tasks.done} of ${tasks.total} tasks done">${icon('list-checks', { size: 14 })}${tasks.done}/${tasks.total}</span>${dot}` : ''}<span class="item-date">Edited ${sentence(relativeDate(item.updatedAt))}</span>${item.favorite ? html`<span class="item-ind is-favorite">${icon('star', { size: 14 })}<span class="sr-only">Favorite</span></span>` : ''}</span>
    ${rowActions(ctx, item, { ...opts, overlay: true })}`);
}

function coverCard(ctx, item, opts) {
  const src = coverOf(item);
  return shell(ctx, item, { ...opts, className: 'item-card', label: ariaLabel(item) }, html`
    <span class="item-card-cover" data-cover>${src ? img(src) : generatedArt(ctx, item, { size: 'lg' })}</span>
    ${check(item, opts.selected)}
    ${rowActions(ctx, item, { ...opts, overlay: true })}
    <span class="item-card-body">
      <span class="item-title">${item.title}</span>
      ${item.excerpt ? html`<span class="item-desc">${item.excerpt}</span>` : ''}
      <span class="item-meta">${sourceBit(item)}${dot}<span class="item-date">${itemDate(item, opts.view)}</span><span class="item-spacer"></span>${indicators(ctx, item, { compact: true })}</span>
    </span>`);
}

function masonryTile(ctx, item, opts) {
  const src = coverOf(item);
  const imageFirst = MEDIA_TYPES.has(item.type);
  return shell(ctx, item, { ...opts, className: cx('item-tile', imageFirst && src && 'is-image'), label: ariaLabel(item) }, html`
    <span class="item-tile-media" data-cover>${src ? img(src) : generatedArt(ctx, item, { size: 'lg' })}</span>
    ${check(item, opts.selected)}
    ${rowActions(ctx, item, { ...opts, overlay: true })}
    <span class="item-tile-body">
      <span class="item-title">${item.title}</span>
      <span class="item-meta">${sourceBit(item)}<span class="item-spacer"></span>${indicators(ctx, item, { compact: true })}</span>
    </span>`);
}

function sideMetaLine(ctx, item, opts) {
  const notes = item.type !== 'note' && item.url ? ctx.select.notesForUrl(item.url).length : 0;
  const highlights = item.highlights?.length || 0;
  return html`<span class="item-media-meta"><span>${itemDate(item, opts.view)}</span>${notes ? html`<span class="item-ind" title="${notes} ${notes === 1 ? 'note' : 'notes'}">${icon('sticky-note', { size: 13 })}${notes}</span>` : ''}${highlights ? html`<span class="item-ind" title="${highlights} ${highlights === 1 ? 'highlight' : 'highlights'}">${icon('highlighter', { size: 13 })}${highlights}</span>` : ''}${item.favorite ? html`<span class="item-ind is-favorite" title="Favorite">${icon('star', { size: 13 })}<span class="sr-only">Favorite</span></span>` : ''}</span>`;
}

/** Side panel media card after the "Web Collections" reference: light = card with inset cover; dark = full-bleed cover under a scrim. */
function mediaCard(ctx, item, opts) {
  const src = coverOf(item);
  const url = item.url || item.sourceUrl;
  return shell(ctx, item, { ...opts, className: cx('item-media', !src && 'is-generated'), label: ariaLabel(item) }, html`
    <span class="item-media-art" data-cover>${src ? img(src) : generatedArt(ctx, item, { size: 'lg' })}</span>
    <span class="item-media-text">
      <span class="item-media-domain">${url ? favicon(url, { size: 14 }) : icon(TYPE_ICONS[item.type] || 'file', { size: 12 })}<span class="item-source-text">${itemSource(item)}</span></span>
      <span class="item-title">${item.title}</span>
      ${sideMetaLine(ctx, item, opts)}
    </span>
    ${check(item, opts.selected)}
    ${rowActions(ctx, item, { ...opts, overlay: true })}`);
}

function sideRow(ctx, item, opts) {
  return shell(ctx, item, { ...opts, className: 'item-compact', label: ariaLabel(item) }, html`
    <span class="item-lead">${itemThumb(ctx, item, { size: 'sm', className: 'is-small' })}${check(item, opts.selected)}</span>
    <span class="item-main">
      <span class="item-title">${item.title}</span>
      <span class="item-meta">${sourceBit(item, { fav: 12 })}${dot}<span class="item-date">${itemDate(item, opts.view)}</span></span>
    </span>
    <span class="item-side">${indicators(ctx, item, { compact: true })}${rowActions(ctx, item, opts)}</span>`);
}

/**
 * renderItem(ctx, item, { layout, surface, index, selected, tabStop, showCollection, view })
 * layout: 'list' | 'cards' | 'masonry' | 'headlines'. In the side panel 'cards' renders media cards and 'list' compact rows.
 */
export function renderItem(ctx, item, { layout = 'list', surface = 'full', index = 0, selected = false, tabStop, showCollection = false, view = ctx.state.view } = {}) {
  if (!item) return '';
  const opts = { layout, surface, index, selected, tabStop: tabStop ?? index === 0, showCollection, view };
  if (item.type === 'note' && (layout === 'cards' || layout === 'masonry')) return noteCard(ctx, item, opts);
  if (surface === 'side') {
    if (layout === 'cards') return item.type === 'note' ? noteCard(ctx, item, opts) : mediaCard(ctx, item, opts);
    if (layout === 'masonry') return masonryTile(ctx, item, opts);
    return sideRow(ctx, item, opts);
  }
  if (layout === 'cards') return coverCard(ctx, item, opts);
  if (layout === 'masonry') return masonryTile(ctx, item, opts);
  if (layout === 'headlines') return headlineRow(ctx, item, opts);
  return listRow(ctx, item, opts);
}

/** A small linked row (detail panel related items, duplicates): thumb + title + source line, opens the item. */
export function renderItemLink(ctx, item, { meta, actions } = {}) {
  const collection = item.collectionId ? ctx.select.collection(item.collectionId) : null;
  return html`<div class="item-link" data-key="link:${item.id}">
    <button type="button" class="item-link-main" data-action="app.open-item" data-id="${item.id}">
      ${itemThumb(ctx, item, { size: 'sm', className: 'is-small' })}
      <span class="item-link-text"><span class="item-link-title">${item.title}</span>
        <span class="item-link-meta">${meta ?? [itemSource(item), collection?.name].filter(Boolean).join(' · ')}</span></span>
    </button>${actions || ''}
  </div>`;
}
