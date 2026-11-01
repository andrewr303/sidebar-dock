// Pure helpers shared by the links-folder and quick-links widgets: which library items a folder shows and in what
// order, typed-URL normalization, settings-save planning and grid keyboard movement. No DOM; unit tested.
import { safeUrl, canonicalUrl } from '../../../lib/store.js';

/** Library item types a links folder shows (when they carry a web address). Notes and files are left out. */
export const LINK_TYPES = Object.freeze(['bookmark', 'article', 'image', 'video']);
export const OPEN_IN = Object.freeze(['current', 'new', 'background']);
export const FOLDER_SORTS = Object.freeze(['manual', 'title', 'newest', 'oldest']);
export const TILE_SIZES = Object.freeze(['md', 'lg']);
export const QUICK_STYLES = Object.freeze(['tiles', 'chips', 'list']);

export const URL_ERROR = 'Enter a web address, like example.com or https://example.com.';

const ids = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && id))] : [];

/** links-folder widget.config with every key present and valid. */
export function folderConfig(config = {}) {
  const c = config && typeof config === 'object' ? config : {};
  return {
    collectionId: typeof c.collectionId === 'string' ? c.collectionId : '',
    includeSubcollections: c.includeSubcollections === true,
    openIn: OPEN_IN.includes(c.openIn) ? c.openIn : 'current',
    sort: FOLDER_SORTS.includes(c.sort) ? c.sort : 'manual',
    order: ids(c.order),
    showLabels: c.showLabels !== false,
    tileSize: TILE_SIZES.includes(c.tileSize) ? c.tileSize : 'md',
  };
}

/** quick-links widget.config with every key present and valid (links are cleaned by normalizeQuickLinks). */
export function quickConfig(config = {}) {
  const c = config && typeof config === 'object' ? config : {};
  return {
    links: Array.isArray(c.links) ? normalizeQuickLinks(c.links) : defaultQuickLinks(),
    style: QUICK_STYLES.includes(c.style) ? c.style : 'tiles',
    showLabels: c.showLabels !== false,
    openIn: OPEN_IN.includes(c.openIn) ? c.openIn : 'current',
  };
}

const WEB = /^https?:\/\//i;
const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;
// A bare host the user typed: localhost, an IPv4/IPv6 address or a dotted name (international names included).
const LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?';
const BARE_HOST = new RegExp(`^(?:localhost|\\d{1,3}(?:\\.\\d{1,3}){3}|\\[[\\da-f:]+\\]|(?:${LABEL}\\.)+${LABEL})$`, 'iu');

/**
 * Typed link text to an http(s) URL, or '' when it is not one. Bare hosts ("github.com/new", "localhost:3000") get
 * https://; anything with another scheme (javascript:, mailto:, ftp://) or credentials is refused.
 */
export function normalizeLinkUrl(value) {
  let text = String(value ?? '').trim();
  if (!text || /\s/.test(text)) return '';
  if (text.startsWith('//')) text = `https:${text}`;
  else if (!SCHEME.test(text)) {
    const host = text.split(/[/?#]/)[0].replace(/:\d{1,5}$/, '');
    if (!BARE_HOST.test(host)) return '';
    text = `https://${text}`;
  }
  try { return safeUrl(text, { optional: false }); } catch { return ''; }
}

/** Comparison key for "is this the same link" (tracking parameters, hash and a trailing slash ignored). */
export function linkKey(url) {
  try { return url ? canonicalUrl(url) : ''; } catch { return ''; }
}

export const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** A link's visible label: its title, else the host name. */
export const linkLabel = link => String(link?.title || '').trim() || hostOf(link?.url) || 'Link';

export const isLinkItem = item => !!item && !item.deletedAt && !item.archived && LINK_TYPES.includes(item.type) && WEB.test(item.url || '');

/** Live link items whose collection is one of collectionIds (unordered). */
export function folderLinks(items = [], collectionIds = []) {
  const ids = new Set(collectionIds.filter(Boolean));
  return items.filter(item => isLinkItem(item) && ids.has(item.collectionId));
}

const byTitle = (a, b) => String(a.title ?? '').localeCompare(String(b.title ?? ''), undefined, { sensitivity: 'base', numeric: true });
const byCreated = (a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || String(a.id).localeCompare(String(b.id));

/**
 * Display order for a folder. 'manual' follows config.order (ids that left the folder are skipped) and appends links
 * that are not in it yet oldest first, so a link saved from elsewhere lands at the end like a new file in a folder.
 */
export function orderLinks(items = [], { sort = 'manual', order = [] } = {}) {
  const rows = [...items];
  if (sort === 'title') return rows.sort((a, b) => byTitle(a, b) || byCreated(a, b));
  if (sort === 'newest') return rows.sort((a, b) => byCreated(b, a));
  if (sort === 'oldest') return rows.sort(byCreated);
  const rank = new Map((Array.isArray(order) ? order : []).map((id, index) => [id, index]));
  const at = item => rank.has(item.id) ? rank.get(item.id) : Infinity;
  // Infinity - Infinity is NaN (falsy), so two unranked links fall through to their age.
  return rows.sort((a, b) => (at(a) - at(b)) || byCreated(a, b));
}

/** ids with `moving` placed right before `beforeId` ('' = at the end). Dropping onto one of the moved ids changes nothing. */
export function placeBefore(ids = [], moving = [], beforeId = '') {
  const set = new Set(moving);
  if (!moving.length || (beforeId && set.has(beforeId))) return [...ids];
  const rest = ids.filter(id => !set.has(id));
  const at = beforeId ? rest.indexOf(beforeId) : -1;
  rest.splice(at < 0 ? rest.length : at, 0, ...moving);
  return rest;
}

/** ids with id moved by delta positions (clamped to the list). */
export function shiftId(ids = [], id, delta) {
  const from = ids.indexOf(id);
  const to = Math.max(0, Math.min(ids.length - 1, from + delta));
  if (from < 0 || to === from) return [...ids];
  const rest = ids.filter(x => x !== id);
  rest.splice(to, 0, id);
  return rest;
}

/** Visual rows of a wrapping grid: positions [{ top, left }] in DOM order -> [[index, ...], ...] (tolerant to subpixel tops). */
export function gridRows(positions = []) {
  const rows = [];
  positions.forEach((pos, index) => {
    const row = rows.find(r => Math.abs(r.top - pos.top) < 4);
    if (row) row.items.push(index); else rows.push({ top: pos.top, items: [index] });
  });
  return rows.sort((a, b) => a.top - b.top).map(r => r.items.sort((x, y) => positions[x].left - positions[y].left));
}

/**
 * The tile an arrow key moves focus to in a wrapping grid. Left/Right walk DOM order (mirrored for right-to-left),
 * Up/Down keep the column on the neighbouring row, Home/End jump to the ends.
 */
export function neighborIndex(positions = [], index, key, { rtl = false } = {}) {
  const n = positions.length;
  if (!n) return -1;
  const current = Math.max(0, Math.min(n - 1, index));
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const step = (key === 'ArrowRight') !== rtl ? 1 : -1;
    return Math.max(0, Math.min(n - 1, current + step));
  }
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return current;
  const rows = gridRows(positions);
  const r = rows.findIndex(row => row.includes(current));
  const target = rows[r + (key === 'ArrowDown' ? 1 : -1)];
  if (!target) return current;
  const column = rows[r].indexOf(current);
  return target[Math.min(column, target.length - 1)];
}

/** Tiles per row in a wrapping grid (the first row's length). */
export const gridColumns = positions => gridRows(positions)[0]?.length || 1;

/**
 * Where a drop at (x, y) lands among tile rects [{ id, top, left, width, height }] in DOM order. Returns
 * { before } (the id to insert before, '' = at the end) and the cue to draw: { mark, side: 'before' | 'after' }.
 * The pointer picks the nearest row, then the first tile whose centre it has not passed in reading direction; in a
 * vertical list only the pointer's height matters.
 */
export function dropTarget(rects = [], x, y, { rtl = false, vertical = false } = {}) {
  if (!rects.length) return { before: '', mark: '', side: 'after' };
  if (vertical) {
    // A one-column list: the first row whose middle is below the pointer.
    const hit = rects.find(rect => y < rect.top + rect.height / 2);
    return hit ? { before: hit.id, mark: hit.id, side: 'before' } : { before: '', mark: rects.at(-1).id, side: 'after' };
  }
  let row = null;
  let distance = Infinity;
  for (const indices of gridRows(rects)) {
    const top = Math.min(...indices.map(i => rects[i].top));
    const bottom = Math.max(...indices.map(i => rects[i].top + rects[i].height));
    const d = y < top ? top - y : y > bottom ? y - bottom : 0;
    if (d < distance) { distance = d; row = indices; }
  }
  const dom = [...row].sort((a, b) => a - b);
  const hit = dom.find(i => { const center = rects[i].left + rects[i].width / 2; return rtl ? x > center : x < center; });
  if (hit !== undefined) return { before: rects[hit].id, mark: rects[hit].id, side: 'before' };
  const last = dom.at(-1);
  return { before: rects[last + 1]?.id || '', mark: rects[last].id, side: 'after' };
}

/**
 * Validates editor rows [{ id?, url, title }]: blank new rows are skipped, URLs normalized, duplicates flagged.
 * Returns { entries: [{ index, id, url, title }], errors: { [rowIndex]: message } }.
 */
export function validateLinkRows(rows = []) {
  const entries = [];
  const errors = {};
  const seen = new Set();
  rows.forEach((row, index) => {
    const raw = String(row?.url ?? '').trim();
    const title = String(row?.title ?? '').trim();
    if (!raw && !title && !row?.id) return;
    if (!raw) { errors[index] = row?.id ? 'Enter a URL, or remove this link.' : 'Enter a URL for this link.'; return; }
    const url = normalizeLinkUrl(raw);
    if (!url) { errors[index] = URL_ERROR; return; }
    const key = linkKey(url);
    if (seen.has(key)) { errors[index] = 'This link is already in the list.'; return; }
    seen.add(key);
    entries.push({ index, id: row?.id || '', url, title });
  });
  return { entries, errors };
}

/**
 * Plans the library writes for a folder's settings form. existing: the folder's own link items; rows: the edited list
 * in display order. Returns { create: [{ url, title }], update: [{ id, patch }], trash: [id],
 * sequence: [{ id } | { create: n }] (the new manual order), errors }. With errors nothing should be written; rows
 * that failed validation keep their item (it is never trashed because of a typo).
 */
export function planLinkChanges(existing = [], rows = []) {
  const byId = new Map(existing.map(item => [item.id, item]));
  const { entries, errors } = validateLinkRows(rows);
  const plan = { create: [], update: [], trash: [], sequence: [], errors };
  const kept = new Set(Object.keys(errors).map(i => rows[i]?.id).filter(Boolean));
  for (const entry of entries) {
    const item = entry.id ? byId.get(entry.id) : null;
    if (!item) {
      plan.create.push({ url: entry.url, title: entry.title });
      plan.sequence.push({ create: plan.create.length - 1 });
      continue;
    }
    kept.add(item.id);
    const patch = {};
    if (entry.url !== item.url) patch.url = entry.url;
    // A cleared title falls back to the host name, as the store does for a new link.
    const title = entry.title || hostOf(entry.url);
    if (title !== item.title) patch.title = title;
    if (Object.keys(patch).length) plan.update.push({ id: item.id, patch });
    plan.sequence.push({ id: item.id });
  }
  for (const item of existing) if (!kept.has(item.id)) plan.trash.push(item.id);
  return plan;
}

export const hasErrors = plan => Object.keys(plan?.errors || {}).length > 0;

export const quickLinkId = () => `ql_${globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(36).slice(2, 10)}`;
const uid = quickLinkId;

export const DEFAULT_QUICK_LINKS = Object.freeze([
  { title: 'Gmail', url: 'https://mail.google.com/' },
  { title: 'Calendar', url: 'https://calendar.google.com/' },
  { title: 'GitHub', url: 'https://github.com/' },
  { title: 'YouTube', url: 'https://www.youtube.com/' },
  { title: 'Wikipedia', url: 'https://www.wikipedia.org/' },
  { title: 'Claude', url: 'https://claude.ai/' },
]);

/** Stored quick links cleaned up: valid http(s) URLs only, unique ids, trimmed titles. */
export function normalizeQuickLinks(list = []) {
  const ids = new Set();
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const url = normalizeLinkUrl(entry?.url);
    if (!url) continue;
    let id = typeof entry.id === 'string' && entry.id ? entry.id : uid();
    while (ids.has(id)) id = uid();
    ids.add(id);
    out.push({ id, title: String(entry.title ?? '').trim().slice(0, 120), url });
  }
  return out;
}

export const defaultQuickLinks = () => normalizeQuickLinks(DEFAULT_QUICK_LINKS.map((link, i) => ({ id: `ql_default_${i + 1}`, ...link })));

/** Quick links settings rows to the stored list, or { errors } when a row needs fixing. */
export function planQuickLinks(rows = []) {
  const { entries, errors } = validateLinkRows(rows);
  if (Object.keys(errors).length) return { links: null, errors };
  return { links: normalizeQuickLinks(entries.map(({ id, url, title }) => ({ id, url, title }))), errors };
}

/** Where the arrow of an anchored popup goes: the popup edge facing the anchor and an x offset inside the popup. */
export function popoverArrow(anchor, pop, { inset = 20 } = {}) {
  const below = pop.top >= anchor.top + anchor.height / 2;
  const center = anchor.left + anchor.width / 2 - pop.left;
  return { edge: below ? 'top' : 'bottom', offset: Math.round(Math.max(inset, Math.min(pop.width - inset, center))) };
}
