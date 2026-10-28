// Shared pickers: the collection combobox popover ('pick.collection') and its trigger button, the tag token input
// with an autocomplete listbox ('pick.tag-suggest'), the icon and color picker ('pick.icon') and the reminder picker
// ('pick.reminder'). Pure helpers are exported for tests; nothing here touches the DOM at import time.
import { html, cx } from './html.js';
import { icon, iconNames, COLLECTION_ICONS, COLLECTION_COLORS } from './icons.js';
import { collectionIcon, colorName, kbd } from './components.js';
import { registerActions } from './runtime.js';
import { registerPopover } from './overlay.js';

const lower = value => String(value ?? '').toLowerCase();
const slug = value => lower(value).replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

/* ------------------------------------------------------------------ pure helpers: collections */

/** "Design / Inspiration" or "Design › Inspiration" -> ['Design', 'Inspiration']. */
export function parseCollectionPath(input) {
  return String(input ?? '').split(/\s*[/›]\s*/).map(part => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Names from the root to `id` for ordered tree rows ({ id, name, parentId }). Cycle safe. */
export function pathNames(rows, id) {
  const byId = rows instanceof Map ? rows : new Map(rows.map(row => [row.id, row]));
  const out = [];
  const seen = new Set();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) { seen.add(current.id); out.unshift(current.name); current = byId.get(current.parentId); }
  return out;
}

/**
 * Filters ordered tree rows for a query. A row matches when its name contains the last path segment and, for
 * "Parent / Child" queries, its full path contains the whole query. Ancestors of matches stay in the result
 * (match: false) so the tree keeps its context. Returns [{ row, match }] in tree order.
 */
export function filterCollectionTree(rows, query) {
  const segments = parseCollectionPath(lower(query));
  if (!segments.length) return rows.map(row => ({ row, match: true }));
  const byId = new Map(rows.map(row => [row.id, row]));
  const last = segments.at(-1);
  const joined = segments.join(' / ');
  const matched = new Set();
  for (const row of rows) {
    if (!lower(row.name).includes(last)) continue;
    if (segments.length > 1 && !lower(pathNames(byId, row.id).join(' / ')).includes(joined)) continue;
    matched.add(row.id);
  }
  const keep = new Set(matched);
  for (const id of matched) {
    const seen = new Set();
    let parent = byId.get(byId.get(id)?.parentId);
    while (parent && !seen.has(parent.id)) { seen.add(parent.id); keep.add(parent.id); parent = byId.get(parent.parentId); }
  }
  return rows.filter(row => keep.has(row.id)).map(row => ({ row, match: matched.has(row.id) }));
}

/**
 * Resolves "Parent / Child" against existing collections. Returns { existingId } when the whole path exists,
 * otherwise { parentId, create: [names still missing] }. A first segment that is not a root name may name any
 * collection with exactly that name ("Inspiration / Moodboards" nests under Design › Inspiration).
 */
export function planCollectionPath(rows, input) {
  const names = parseCollectionPath(input);
  if (!names.length) return { existingId: '', parentId: '', create: [] };
  const childNamed = (parentId, name) => rows.find(row => (row.parentId || '') === parentId && lower(row.name) === lower(name));
  let current = childNamed('', names[0]);
  if (!current) {
    const anywhere = rows.filter(row => lower(row.name) === lower(names[0]));
    if (anywhere.length === 1) current = anywhere[0];
  }
  if (!current) return { existingId: '', parentId: '', create: names };
  for (let i = 1; i < names.length; i++) {
    const next = childNamed(current.id, names[i]);
    if (!next) return { existingId: '', parentId: current.id, create: names.slice(i) };
    current = next;
  }
  return { existingId: current.id, parentId: current.parentId || '', create: [] };
}

/** Deterministic palette color (stored as hex) for a new collection. */
export function colorForName(name) {
  const palette = COLLECTION_COLORS.filter(color => color.name !== 'gray');
  let hash = 0;
  for (const ch of lower(name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length].hex;
}

/* ------------------------------------------------------------------ pure helpers: tags */

/** "a, #b,\n c" -> ['a', 'b', 'c'] (trimmed, leading # dropped, inner whitespace collapsed, 64 chars max). */
export function splitTags(text) {
  return String(text ?? '').split(/[,\n]+/).map(tag => tag.trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 64)).filter(Boolean);
}

/** Appends tags that are not already present (case-insensitive); keeps the first spelling. */
export function mergeTags(current = [], incoming = []) {
  const seen = new Set(current.map(lower));
  const out = [...current];
  for (const tag of incoming) {
    const key = lower(tag).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(String(tag).trim());
  }
  return out;
}

export const removeTag = (list = [], tag) => list.filter(entry => lower(entry) !== lower(tag));

/** Autocomplete over [{ name, count }]: prefix matches first, then substring matches; excludes tags already chosen. */
export function matchTags(all = [], query = '', exclude = [], limit = 8) {
  const q = lower(query).replace(/^#+/, '').trim();
  const skip = new Set(exclude.map(lower));
  const pool = all.filter(tag => tag?.name && !skip.has(lower(tag.name)));
  if (!q) return pool.slice(0, limit);
  const starts = [], contains = [];
  for (const tag of pool) {
    const name = lower(tag.name);
    if (name.startsWith(q)) starts.push(tag); else if (name.includes(q)) contains.push(tag);
  }
  return [...starts, ...contains].slice(0, limit);
}

/* ------------------------------------------------------------------ pure helpers: reminders */

const atTime = (base, days, hours) => { const date = new Date(base); date.setDate(date.getDate() + days); date.setHours(hours, 0, 0, 0); return date; };

/** Quick reminder choices relative to `now`: later today (3 hours ahead, on the hour, until 10 PM), tomorrow 9 AM, next Monday 9 AM. */
export function reminderPresets(now = new Date()) {
  const presets = [];
  const later = new Date(now.getTime() + 3 * 3600_000);
  if (later.getMinutes() || later.getSeconds() || later.getMilliseconds()) later.setHours(later.getHours() + 1, 0, 0, 0);
  if (later.getDate() === now.getDate() && later.getHours() <= 22) presets.push({ id: 'later', label: 'Later today', icon: 'clock', date: later });
  presets.push({ id: 'tomorrow', label: 'Tomorrow morning', icon: 'sunrise', date: atTime(now, 1, 9) });
  presets.push({ id: 'next-week', label: 'Next week', icon: 'calendar', date: atTime(now, ((8 - now.getDay()) % 7) || 7, 9) });
  return presets;
}

const pad = n => String(n).padStart(2, '0');
/** Date -> 'YYYY-MM-DDTHH:MM' in local time, for <input type="datetime-local">. */
export function toDateTimeLocal(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** "Today, 6:00 PM" · "Tomorrow, 9:00 AM" · "Mon, 9:00 AM" (this week) · "Nov 2, 9:00 AM" · "Jan 4, 2027, 9:00 AM". */
export function formatReminder(value, now = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay(date, now)) return `Today, ${time}`;
  if (sameDay(date, atTime(now, 1, 0))) return `Tomorrow, ${time}`;
  const days = (atTime(date, 0, 0) - atTime(now, 0, 0)) / 86400_000;
  if (days > 1 && days < 7) return `${date.toLocaleDateString(undefined, { weekday: 'short' })}, ${time}`;
  const options = date.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' };
  return `${date.toLocaleDateString(undefined, options)}, ${time}`;
}

const EMOJI = /\p{Extended_Pictographic}/u;

/* ------------------------------------------------------------------ collection picker */

const highlight = (text, query) => {
  const value = String(text ?? '');
  const q = parseCollectionPath(lower(query)).at(-1);
  const at = q ? lower(value).indexOf(q) : -1;
  if (at < 0) return value;
  return html`${value.slice(0, at)}<strong class="pick-match">${value.slice(at, at + q.length)}</strong>${value.slice(at + q.length)}`;
};

function pathFragment(ctx, id, query = '') {
  const path = ctx.select.path(id);
  if (!path.length) return '';
  return html`${path.slice(0, -1).map(c => html`<span class="pick-path-parent">${c.name}</span>${icon('chevron-right', { size: 12, className: 'pick-path-sep' })}`)}${highlight(path.at(-1).name, query)}`;
}

/** Options shown in the collection popover for its current props. */
function collectionOptions(ctx, props) {
  const rows = ctx.select.tree();
  const exclude = new Set(props.excludeIds || []);
  const query = String(props.query || '');
  const options = [];
  const allowInbox = props.allowInbox !== false;
  if (!query.trim()) {
    if (allowInbox) options.push({ kind: 'inbox', id: '', group: 'top' });
    if (rows.length > 6) {
      for (const c of ctx.select.recentCollections(5)) if (!exclude.has(c.id)) options.push({ kind: 'collection', id: c.id, group: 'recent', showPath: true });
    }
    for (const row of rows) if (!exclude.has(row.id)) options.push({ kind: 'collection', id: row.id, group: 'all', depth: row.depth });
    return options;
  }
  if (allowInbox && 'inbox'.startsWith(lower(query).trim())) options.push({ kind: 'inbox', id: '', group: 'top' });
  for (const { row, match } of filterCollectionTree(rows, query)) {
    if (!exclude.has(row.id)) options.push({ kind: 'collection', id: row.id, group: 'all', depth: row.depth, context: !match });
  }
  const plan = planCollectionPath(rows.filter(row => !exclude.has(row.id)), query);
  if (props.allowCreate !== false && !plan.existingId && plan.create.length) options.push({ kind: 'create', plan, group: 'create' });
  return options;
}

function activeIndex(options, props) {
  if (Number.isInteger(props.active) && props.active >= 0 && props.active < options.length) return props.active;
  if (String(props.query || '').trim()) {
    const q = lower(parseCollectionPath(props.query).at(-1));
    const named = (o, test) => o.kind === 'collection' && !o.context && test(lower(o.name));
    const exact = options.findIndex(o => named(o, n => n === q));
    if (exact >= 0) return exact;
    const prefix = options.findIndex(o => named(o, n => n.startsWith(q)));
    if (prefix >= 0) return prefix;
    const any = options.findIndex(o => o.kind !== 'collection' || !o.context);
    return any >= 0 ? any : 0;
  }
  const current = options.findIndex(o => o.kind !== 'create' && o.id === (props.value || ''));
  return current >= 0 ? current : 0;
}

function createLabel(ctx, plan) {
  const names = plan.create.join(' / ');
  const parent = plan.parentId ? ctx.select.collection(plan.parentId)?.name : '';
  return parent ? html`Create “${names}” in ${parent}` : html`Create “${names}”`;
}

// The overlay closes a role="none" popover on Tab before our keydown handler runs, so the opener is kept here
// to return focus to it.
let collectionAnchor = null;

function renderCollectionPopover(ctx, props) {
  collectionAnchor = ctx.state.popover?.anchorEl || collectionAnchor;
  const options = collectionOptions(ctx, props);
  for (const o of options) if (o.kind === 'collection') o.name = ctx.select.collection(o.id)?.name || '';
  const active = activeIndex(options, props);
  const counts = ctx.select.counts();
  const query = String(props.query || '');
  const option = (o, index) => {
    const isActive = index === active;
    if (o.kind === 'create') {
      return html`<div role="option" id="pick-opt-${index}" class="${cx('pick-option', 'is-create', isActive && 'is-active')}" aria-selected="false"
        data-action="pick.collection-create" data-index="${index}">${icon('folder-plus', { size: 16 })}<span class="pick-option-label">${createLabel(ctx, o.plan)}</span>${isActive ? kbd('enter') : ''}</div>`;
    }
    const collection = o.kind === 'inbox' ? null : ctx.select.collection(o.id);
    const selected = (props.value || '') === o.id;
    const n = o.kind === 'inbox' ? counts.inbox : counts.byCollectionDeep[o.id];
    const label = o.kind === 'inbox' ? highlight('Inbox', query) : o.showPath ? pathFragment(ctx, o.id) : highlight(o.name, query);
    return html`<div role="option" id="pick-opt-${index}" class="${cx('pick-option', isActive && 'is-active', o.context && 'is-context')}" aria-selected="${selected ? 'true' : 'false'}"
      data-action="pick.collection-choose" data-id="${o.id}" data-index="${index}" style="--depth:${o.depth || 0}">
      ${collectionIcon(collection, { size: 18 })}<span class="pick-option-label">${label}</span>
      ${n ? html`<span class="pick-option-count">${n.toLocaleString()}</span>` : ''}${selected ? icon('check', { size: 14, className: 'pick-option-check' }) : ''}</div>`;
  };
  const group = (name, label) => {
    const rows = options.map((o, i) => [o, i]).filter(([o]) => o.group === name);
    if (!rows.length) return '';
    return label
      ? html`<div class="pick-group" role="group" aria-label="${label}"><div class="pick-group-label" aria-hidden="true">${label}</div>${rows.map(([o, i]) => option(o, i))}</div>`
      : html`<div class="pick-group">${rows.map(([o, i]) => option(o, i))}</div>`;
  };
  const hasCollections = options.some(o => o.kind === 'collection');
  const empty = query.trim() && !options.length;
  return html`<div class="pick-collection" data-key="pick-collection">
    ${props.title ? html`<div class="pick-title">${props.title}</div>` : ''}
    <div class="pick-search">${icon('search', { size: 16 })}
      <input class="pick-search-input" id="pick-collection-search" data-focus-key="pick-collection-search" type="text" role="combobox" aria-expanded="true"
        aria-controls="pick-collection-list" aria-autocomplete="list" aria-activedescendant="${options.length ? `pick-opt-${active}` : ''}"
        aria-label="Find or create a collection" placeholder="${props.allowCreate === false ? 'Find a collection' : 'Find or create a collection'}" value="${query}"
        data-input="pick.collection-query" data-keydown="pick.collection-key" data-autofocus autocomplete="off" spellcheck="false">
      ${kbd('Esc')}
    </div>
    <div class="pick-list" role="listbox" id="pick-collection-list" aria-label="Collections">
      ${group('top', '')}${group('recent', 'Recent')}${group('all', hasCollections && (query.trim() || options.some(o => o.group === 'recent')) ? (query.trim() ? 'Collections' : 'All collections') : '')}
      ${options.some(o => o.group === 'create') ? html`<div class="pick-group pick-group-create" role="group" aria-label="Create">${options.map((o, i) => o.group === 'create' ? option(o, i) : '')}</div>` : ''}
      ${empty ? html`<p class="pick-empty" role="presentation">No collections match “${query.trim()}”</p>` : ''}
    </div>
    <p class="sr-only" role="status" aria-live="polite">${query.trim() ? `${options.filter(o => o.kind !== 'create').length} matches` : ''}</p>
  </div>`;
}

async function chooseCollection(ctx, id) {
  const props = ctx.state.popover?.props;
  if (!props) return;
  ctx.closePopover();
  await props.onPick?.(id);
}

async function createCollectionFromQuery(ctx) {
  const props = ctx.state.popover?.props;
  if (!props) return;
  const exclude = new Set(props.excludeIds || []);
  const plan = planCollectionPath(ctx.select.tree().filter(row => !exclude.has(row.id)), props.query);
  if (plan.existingId) return chooseCollection(ctx, plan.existingId);
  if (!plan.create.length) return;
  ctx.closePopover();
  let parentId = plan.parentId;
  let created = null;
  for (const name of plan.create) {
    created = await ctx.store.createCollection({ name, parentId, color: colorForName(name), icon: 'folder' });
    parentId = created.id;
  }
  if (props.onPick) await props.onPick(created.id, { created: true });
  else ctx.toast(`Created ${plan.create.join(' / ')}`, { tone: 'success' });
}

/* Trigger state: a trigger mirrors its `value` prop, but remembers a pick made without an `action` (plain forms). */
const triggerState = new Map();
function syncValue(map, key, propValue) {
  const state = map.get(key);
  if (!state || state.prop !== propValue) { map.set(key, { prop: propValue, value: propValue }); return propValue; }
  return state.value;
}

/**
 * Button that shows a collection (tile + path) and opens 'pick.collection'. After a pick it dispatches `action` with
 * data { value: collectionId, name } and keeps a hidden input `name` in sync for forms. `value` '' means Inbox.
 */
export function renderCollectionPickerTrigger({ ctx, value = '', action, name, placeholder = 'Choose a collection', allowInbox = true, allowCreate = true,
  id, label = 'Collection', size = 'md', className, disabled, excludeIds } = {}) {
  const key = id || name || action || 'collection';
  const current = syncValue(triggerState, key, String(value || ''));
  const collection = current ? ctx.select.collection(current) : null;
  const text = collection ? ctx.select.path(collection.id).map(c => c.name).join(' / ') : allowInbox ? 'Inbox' : placeholder;
  const open = ctx.state.popover?.name === 'pick.collection' && ctx.state.popover.props?.pickerKey === key;
  return html`<span class="${cx('pick-trigger-wrap', className)}" data-key="pick-trigger:${key}">
    <button type="button" class="${cx('pick-trigger', size === 'sm' && 'is-sm', !collection && !allowInbox && 'is-placeholder')}" ${id ? html`id="${id}"` : ''}
      aria-haspopup="listbox" aria-expanded="${open ? 'true' : 'false'}" aria-label="${label}: ${text}"
      data-action="pick.collection-open" data-picker="${key}" data-value="${collection ? current : ''}" ${action ? html`data-pick-action="${action}"` : ''}
      ${name ? html`data-name="${name}"` : ''} data-allow-inbox="${allowInbox ? 'true' : 'false'}" data-allow-create="${allowCreate ? 'true' : 'false'}"
      ${excludeIds?.length ? html`data-exclude="${excludeIds.join(',')}"` : ''} ${disabled ? html`disabled` : ''}>
      ${collection || allowInbox ? collectionIcon(collection, { size: size === 'sm' ? 16 : 18 }) : icon('folder', { size: 16, className: 'pick-trigger-icon' })}
      <span class="pick-trigger-label">${collection ? pathFragment(ctx, collection.id) : text}</span>${icon('chevron-down', { size: 14, className: 'pick-trigger-chevron' })}
    </button>${name ? html`<input type="hidden" name="${name}" value="${collection ? current : ''}">` : ''}</span>`;
}

/** Opens the collection popover from code: openCollectionPicker(ctx, anchorEl, { value, onPick, allowInbox, allowCreate, title }). */
export function openCollectionPicker(ctx, anchor, props = {}) {
  ctx.openPopover('pick.collection', anchor, { allowInbox: true, allowCreate: true, ...props, query: '', active: null });
}

/* ------------------------------------------------------------------ tag input */

const tagState = new Map();
function syncTags(key, tags, meta) {
  const list = Array.isArray(tags) ? tags.map(String) : splitTags(tags);
  const sig = list.join('\u0000');
  let state = tagState.get(key);
  if (!state || state.sig !== sig) { state = { sig, tags: list }; tagState.set(key, state); }
  Object.assign(state, meta);
  return state;
}

/**
 * Tag token input: chips with remove buttons, an input with autocomplete from ctx.select.tags() (Enter or comma adds,
 * Backspace removes the last chip, pasting "a, b, c" adds all), and an optional "Suggested" row of one-click chips.
 * After every change it dispatches `action` with data { name, tags, value: 'a, b' }; a hidden input `name` mirrors it.
 */
export function renderTagInput({ ctx, name, tags = [], suggestions = [], action, id, placeholder = 'Add tags', label = 'Tags',
  suggestionLabel = 'Suggested', suggestionIcon = 'sparkles', className } = {}) {
  const key = id || name || action || 'tags';
  const inputId = `tag-input-${slug(key)}`;
  const state = syncTags(key, tags, { action, name, inputId });
  const pop = ctx.state.popover;
  const open = pop?.name === 'pick.tag-suggest' && pop.props?.key === key;
  const active = open && pop.props.active >= 0 ? `tag-opt-${slug(key)}-${pop.props.active}` : '';
  const chosen = new Set(state.tags.map(lower));
  const suggested = [];
  for (const entry of suggestions || []) {
    const tag = typeof entry === 'string' ? entry : entry?.name;
    if (tag && !chosen.has(lower(tag)) && !suggested.some(s => lower(s) === lower(tag))) suggested.push(tag);
  }
  return html`<div class="${cx('tag-field', className)}" data-key="tag-field:${key}">
    <div class="tag-input" data-action="pick.tags-focus" data-target="${inputId}">
      ${state.tags.map(tag => html`<span class="tag-token" data-key="tag:${lower(tag)}"><span class="tag-token-hash" aria-hidden="true">#</span><span class="tag-token-label">${tag}</span><button type="button"
        class="tag-token-remove" aria-label="Remove tag ${tag}" data-action="pick.tags-remove" data-tags="${key}" data-tag="${tag}">${icon('x', { size: 12 })}</button></span>`)}
      <input class="tag-input-field" id="${inputId}" data-focus-key="${inputId}" type="text" role="combobox" aria-label="${label}" aria-autocomplete="list"
        aria-expanded="${open ? 'true' : 'false'}" ${open ? html`aria-controls="tag-suggest-${slug(key)}"` : ''} aria-activedescendant="${active}"
        placeholder="${placeholder}" data-input="pick.tags-input" data-keydown="pick.tags-key" data-tags="${key}" autocomplete="off" spellcheck="false" enterkeyhint="done">
    </div>
    ${name ? html`<input type="hidden" name="${name}" value="${state.tags.join(', ')}">` : ''}
    ${suggested.length ? html`<div class="tag-suggest-row">${icon(suggestionIcon, { size: 14, className: 'tag-suggest-icon' })}<span>${suggestionLabel}:</span>
      ${suggested.slice(0, 6).map(tag => html`<button type="button" class="tag-suggest" data-action="pick.tags-add" data-tags="${key}" data-tag="${tag}" aria-label="Add tag ${tag}"><span class="tag-suggest-plus" aria-hidden="true">+</span>#${tag}</button>`)}</div>` : ''}
  </div>`;
}

function commitTags(ctx, key, next, el) {
  const state = tagState.get(key);
  if (!state) return;
  state.tags = next;
  if (state.action) ctx.run(() => ctx.dispatch(state.action, { el, data: { name: state.name, tags: next, value: next.join(', ') } }));
  ctx.render();
}

const tagInputEl = key => document.getElementById(tagState.get(key)?.inputId || '');

function showTagSuggestions(ctx, el, key, query, { force = false } = {}) {
  const state = tagState.get(key);
  const items = matchTags(ctx.select.tags(), query, state?.tags || [], 8);
  const pop = ctx.state.popover;
  const mine = pop?.name === 'pick.tag-suggest' && pop.props?.key === key;
  if (!items.length || (!query.trim() && !force)) { if (mine) ctx.closePopover({ restore: false }); return; }
  const active = query.trim() ? 0 : -1;
  if (mine) { Object.assign(pop.props, { items, active }); ctx.render(); return; }
  ctx.openPopover('pick.tag-suggest', el, { key, items, active }, { placement: 'bottom-start', focus: false });
}

function renderTagSuggest(ctx, { key, items = [], active = -1 }) {
  return html`<div class="pick-list pick-tag-list" role="listbox" id="tag-suggest-${slug(key)}" aria-label="Matching tags">
    ${items.map((tag, i) => html`<div role="option" id="tag-opt-${slug(key)}-${i}" class="${cx('pick-option', i === active && 'is-active')}" aria-selected="${i === active ? 'true' : 'false'}"
      data-action="pick.tag-suggest-choose" data-tags="${key}" data-tag="${tag.name}">${icon('hash', { size: 14 })}<span class="pick-option-label">${tag.name}</span>
      <span class="pick-option-count">${tag.count}</span></div>`)}</div>`;
}

/* ------------------------------------------------------------------ icon + color picker */

function iconChoices(query) {
  const q = lower(query).trim();
  if (!q) return COLLECTION_ICONS;
  const names = [...new Set([...COLLECTION_ICONS, ...iconNames()])];
  return names.filter(name => name.includes(q)).slice(0, 96);
}

function renderIconPopover(ctx, props) {
  const current = String(props.icon || 'folder');
  const isEmoji = EMOJI.test(current);
  const hue = colorName(props.color) || 'gray';
  const choices = iconChoices(props.query);
  const focusIndex = Math.max(0, choices.indexOf(current));
  return html`<div class="pick-icon" style="--pick-hue:var(--c-${hue});--pick-hue-soft:var(--c-${hue}-soft)" data-key="pick-icon">
    <div class="pick-search">${icon('search', { size: 16 })}<input class="pick-search-input" type="text" id="pick-icon-search" data-focus-key="pick-icon-search"
      aria-label="Search icons" placeholder="Search icons" value="${props.query || ''}" data-input="pick.icon-query" data-keydown="pick.icon-search-key" data-autofocus autocomplete="off" spellcheck="false"></div>
    ${choices.length ? html`<div class="pick-icon-grid" role="radiogroup" aria-label="Icon" data-keydown="pick.icon-grid-key">
      ${choices.map((name, i) => html`<button type="button" role="radio" class="pick-icon-cell" aria-checked="${!isEmoji && name === current ? 'true' : 'false'}" tabindex="${i === focusIndex ? '0' : '-1'}"
        aria-label="${name.replace(/-/g, ' ')}" title="${name.replace(/-/g, ' ')}" data-action="pick.icon-choose" data-icon="${name}">${icon(name, { size: 18 })}</button>`)}
    </div>` : html`<p class="pick-empty">No icons match “${props.query}”</p>`}
    <div class="pick-section-label" id="pick-color-label">Color</div>
    <div class="pick-swatches" role="radiogroup" aria-labelledby="pick-color-label" data-keydown="pick.icon-swatch-key">
      ${COLLECTION_COLORS.map(color => html`<button type="button" role="radio" class="pick-swatch" style="--swatch:var(--c-${color.name})" aria-checked="${color.name === hue ? 'true' : 'false'}"
        tabindex="${color.name === hue ? '0' : '-1'}" aria-label="${color.name}" title="${color.name}" data-action="pick.icon-color" data-color="${color.hex}">${color.name === hue ? icon('check', { size: 12, strokeWidth: 3 }) : ''}</button>`)}
    </div>
    <form class="pick-emoji" data-submit="pick.icon-emoji">
      <span class="pick-emoji-preview" aria-hidden="true">${isEmoji ? current : icon('smile', { size: 16 })}</span>
      <input class="input input-sm pick-emoji-input" type="text" name="emoji" maxlength="8" placeholder="Or type an emoji" aria-label="Emoji" value="${isEmoji ? current : ''}"
        ${props.emojiError ? html`aria-invalid="true" aria-describedby="pick-emoji-error"` : ''} autocomplete="off">
      <button type="submit" class="btn btn-secondary btn-sm">Use</button>
    </form>
    ${props.emojiError ? html`<p class="pick-error" id="pick-emoji-error" role="alert">${props.emojiError}</p>` : ''}
  </div>`;
}

async function applyIcon(ctx, patch) {
  const props = ctx.state.popover?.props;
  if (!props) return;
  Object.assign(props, patch, { emojiError: '' });
  ctx.render();
  await props.onPick?.({ icon: props.icon || 'folder', color: props.color || COLLECTION_COLORS.find(c => c.name === 'gray').hex });
}

function moveRoving(container, selector, event, columns = 1) {
  const cells = [...container.querySelectorAll(selector)];
  const index = cells.indexOf(document.activeElement);
  if (index < 0) return false;
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
  let next = index;
  if (step) next = Math.min(cells.length - 1, Math.max(0, index + step));
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = cells.length - 1;
  else return false;
  event.preventDefault();
  cells.forEach((cell, i) => cell.setAttribute('tabindex', i === next ? '0' : '-1'));
  cells[next].focus();
  return true;
}

/* ------------------------------------------------------------------ reminder picker */

function renderReminderPopover(ctx, props) {
  if (props.view === 'custom') {
    const initial = props.value && Date.parse(props.value) > Date.now() ? new Date(props.value) : reminderPresets()[1].date;
    return html`<form class="pick-reminder-custom" data-submit="pick.reminder-custom" data-key="pick-reminder-custom" aria-label="Pick date and time">
      <label class="pick-section-label" for="pick-reminder-at">Remind me on</label>
      <input class="input" type="datetime-local" id="pick-reminder-at" name="at" value="${toDateTimeLocal(initial)}" min="${toDateTimeLocal(new Date())}" required data-autofocus
        ${props.error ? html`aria-invalid="true" aria-describedby="pick-reminder-error"` : ''}>
      ${props.error ? html`<p class="pick-error" id="pick-reminder-error" role="alert">${props.error}</p>` : ''}
      <div class="pick-reminder-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-action="pick.reminder-back">Back</button>
        <button type="submit" class="btn btn-primary btn-sm">Set reminder</button>
      </div>
    </form>`;
  }
  const now = new Date();
  return html`<div class="menu pick-reminder" role="menu" aria-label="Remind me" data-key="pick-reminder">
    ${props.value ? html`<div class="menu-heading" role="presentation">${formatReminder(props.value, now)}</div>` : ''}
    ${reminderPresets(now).map(preset => html`<button type="button" class="menu-item" role="menuitem" tabindex="-1" data-action="pick.reminder-choose" data-at="${preset.date.toISOString()}">
      ${icon(preset.icon, { size: 16 })}<span class="menu-label">${preset.label}</span><span class="menu-hint">${formatReminder(preset.date, now).replace(/^(Today|Tomorrow), /, '')}</span></button>`)}
    <div class="menu-separator" role="separator"></div>
    <button type="button" class="menu-item" role="menuitem" tabindex="-1" data-action="pick.reminder-custom-view">${icon('calendar-clock', { size: 16 })}<span class="menu-label">Pick date and time</span></button>
    ${props.value ? html`<button type="button" class="menu-item is-danger" role="menuitem" tabindex="-1" data-action="pick.reminder-choose" data-at="">${icon('bell-off', { size: 16 })}<span class="menu-label">Clear reminder</span></button>` : ''}
  </div>`;
}

async function pickReminder(ctx, iso) {
  const props = ctx.state.popover?.props;
  if (!props) return;
  ctx.closePopover();
  await props.onPick?.(iso || null);
}

/* ------------------------------------------------------------------ registration */

registerPopover('pick.collection', renderCollectionPopover, { role: 'none', className: 'pick-popover pick-collection-popover' });
registerPopover('pick.tag-suggest', renderTagSuggest, { role: 'none', className: 'pick-popover pick-tag-popover' });
registerPopover('pick.icon', renderIconPopover, { role: 'dialog', className: 'pick-popover pick-icon-popover' });
registerPopover('pick.reminder', renderReminderPopover, { role: 'menu', className: 'popover-menu pick-reminder-popover' });

const popoverIs = (ctx, name) => ctx.state.popover?.name === name ? ctx.state.popover.props : null;
const scrollActive = (ctx, id) => ctx.nextFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'nearest' }));

registerActions({
  'pick.collection-open': ({ el, ctx, data }) => {
    const key = data.picker;
    openCollectionPicker(ctx, el, {
      value: data.value || '', allowInbox: data.allowInbox !== 'false', allowCreate: data.allowCreate !== 'false',
      excludeIds: data.exclude ? data.exclude.split(',') : [], pickerKey: key,
      onPick: async id => {
        const state = triggerState.get(key);
        if (state) state.value = id;
        if (data.pickAction) await ctx.dispatch(data.pickAction, { el, data: { name: data.name, picker: key, value: id } });
        ctx.render();
      },
    });
  },
  'pick.collection-query': ({ el, ctx }) => {
    const props = popoverIs(ctx, 'pick.collection');
    if (!props) return;
    props.query = el.value;
    props.active = null;
    ctx.render();
  },
  'pick.collection-key': async ({ event, ctx }) => {
    const props = popoverIs(ctx, 'pick.collection');
    if (event.key === 'Tab' && !props) {
      event.preventDefault();
      if (collectionAnchor?.isConnected) collectionAnchor.focus();
      return;
    }
    if (!props || event.metaKey || event.ctrlKey || event.altKey) return;
    const options = collectionOptions(ctx, props);
    for (const o of options) if (o.kind === 'collection') o.name = ctx.select.collection(o.id)?.name || '';
    const active = activeIndex(options, props);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!options.length) return;
      props.active = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      ctx.render();
      scrollActive(ctx, `pick-opt-${props.active}`);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = options[active];
      if (!option) return;
      if (option.kind === 'create') await createCollectionFromQuery(ctx);
      else await chooseCollection(ctx, option.id);
    }
  },
  'pick.collection-choose': ({ ctx, data }) => chooseCollection(ctx, data.id || ''),
  'pick.collection-create': ({ ctx }) => createCollectionFromQuery(ctx),

  'pick.tags-focus': ({ data, event }) => {
    if (event?.target?.closest?.('button, input')) return;
    document.getElementById(data.target)?.focus();
  },
  'pick.tags-input': ({ el, event, ctx }) => {
    const key = el.dataset.tags;
    const state = tagState.get(key);
    if (!state) return;
    if (/[,\n]/.test(el.value)) {
      const pasted = event?.inputType === 'insertFromPaste';
      const parts = el.value.split(/[,\n]/);
      const rest = pasted ? '' : parts.pop();
      const add = splitTags(parts.join(','));
      el.value = rest.replace(/^\s+/, '');
      if (add.length) commitTags(ctx, key, mergeTags(state.tags, add), el);
    }
    showTagSuggestions(ctx, el, key, el.value);
  },
  'pick.tags-key': ({ el, event, ctx }) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    const key = el.dataset.tags;
    const state = tagState.get(key);
    if (!state) return;
    const pop = popoverIs(ctx, 'pick.tag-suggest');
    const mine = pop?.key === key ? pop : null;
    if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = mine && mine.active >= 0 ? [mine.items[mine.active]?.name] : splitTags(el.value);
      el.value = '';
      if (mine) ctx.closePopover({ restore: false });
      if (chosen.filter(Boolean).length) commitTags(ctx, key, mergeTags(state.tags, chosen.filter(Boolean)), el);
    } else if (event.key === 'Backspace' && !el.value && el.selectionStart === 0 && state.tags.length) {
      event.preventDefault();
      commitTags(ctx, key, state.tags.slice(0, -1), el);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!mine) { showTagSuggestions(ctx, el, key, el.value, { force: true }); return; }
      const count = mine.items.length;
      if (!count) return;
      mine.active = mine.active < 0 ? (event.key === 'ArrowDown' ? 0 : count - 1) : (mine.active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      ctx.render();
      scrollActive(ctx, `tag-opt-${slug(key)}-${mine.active}`);
    } else if (event.key === 'Tab' && mine) {
      ctx.closePopover({ restore: false });
    }
  },
  'pick.tags-remove': ({ el, ctx, data }) => {
    const state = tagState.get(data.tags);
    if (!state) return;
    commitTags(ctx, data.tags, removeTag(state.tags, data.tag), el);
    ctx.nextFrame(() => tagInputEl(data.tags)?.focus());
  },
  'pick.tags-add': ({ el, ctx, data }) => {
    const state = tagState.get(data.tags);
    if (!state) return;
    commitTags(ctx, data.tags, mergeTags(state.tags, [data.tag]), el);
    ctx.nextFrame(() => tagInputEl(data.tags)?.focus());
  },
  'pick.tag-suggest-choose': ({ el, ctx, data }) => {
    const state = tagState.get(data.tags);
    if (!state) return;
    const input = tagInputEl(data.tags);
    if (input) input.value = '';
    ctx.closePopover();
    commitTags(ctx, data.tags, mergeTags(state.tags, [data.tag]), input || el);
  },

  'pick.icon-query': ({ el, ctx }) => {
    const props = popoverIs(ctx, 'pick.icon');
    if (!props) return;
    props.query = el.value;
    ctx.render();
  },
  'pick.icon-search-key': ({ event }) => {
    if (event.key !== 'ArrowDown') return;
    const cell = document.querySelector('#still-popover .pick-icon-cell[tabindex="0"]') || document.querySelector('#still-popover .pick-icon-cell');
    if (cell) { event.preventDefault(); cell.focus(); }
  },
  'pick.icon-grid-key': ({ el, event }) => { moveRoving(el, '.pick-icon-cell', event, 8); },
  'pick.icon-swatch-key': ({ el, event }) => { moveRoving(el, '.pick-swatch', event, 1); },
  'pick.icon-choose': ({ ctx, data }) => applyIcon(ctx, { icon: data.icon }),
  'pick.icon-color': ({ ctx, data }) => applyIcon(ctx, { color: data.color }),
  'pick.icon-emoji': ({ el, ctx }) => {
    const props = popoverIs(ctx, 'pick.icon');
    if (!props) return;
    const value = String(new FormData(el).get('emoji') || '').trim();
    if (!EMOJI.test(value)) { props.emojiError = 'Type or paste one emoji, for example a star or a plant.'; ctx.render(); return; }
    return applyIcon(ctx, { icon: [...value].slice(0, 2).join('') });
  },

  'pick.reminder-choose': ({ ctx, data }) => pickReminder(ctx, data.at),
  'pick.reminder-custom-view': ({ ctx }) => {
    const props = popoverIs(ctx, 'pick.reminder');
    if (!props) return;
    props.view = 'custom';
    ctx.render();
    ctx.nextFrame(() => document.getElementById('pick-reminder-at')?.focus());
  },
  'pick.reminder-back': ({ ctx }) => {
    const props = popoverIs(ctx, 'pick.reminder');
    if (!props) return;
    props.view = '';
    props.error = '';
    ctx.render();
    ctx.nextFrame(() => document.querySelector('#still-popover [role="menuitem"]')?.focus());
  },
  'pick.reminder-custom': ({ el, ctx }) => {
    const props = popoverIs(ctx, 'pick.reminder');
    if (!props) return;
    const value = String(new FormData(el).get('at') || '');
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) { props.error = 'Choose a date and time.'; ctx.render(); return; }
    if (date.getTime() <= Date.now()) { props.error = 'Choose a time in the future.'; ctx.render(); return; }
    return pickReminder(ctx, date.toISOString());
  },
});
