// Subpages: a note can live inside another item through `parentId` ('' = top level). Only notes have a parent; the
// parent may be any item type (a note, a saved article, a bookmark, a file...). Siblings are ordered by createdAt, then
// id. These helpers are pure: they read a library snapshot ({ items }, an items array, or an index from pageIndex) and
// never change it. Every walk over stored data is guarded against cycles and capped, because an older build, an import
// or a hand-edited file can leave loops behind.
//
// Calling several helpers over the same snapshot? Build pageIndex(library) once and pass it instead of the library, so
// each call does not rebuild the parent -> children map.

export const MAX_PAGE_DEPTH = 32;

const INDEX = Symbol('still.pageIndex');
const live = item => !!item && !item.deletedAt;
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string';
// Code-unit order (not localeCompare) so the same library sorts the same way on every device.
const before = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sibling = (a, b) => before(String(a.createdAt || ''), String(b.createdAt || '')) || before(a.id, b.id);

/** The parent id an item really has: only notes have one, and an item never sits inside itself. */
export function parentIdOf(item) {
  if (!isRecord(item) || item.type !== 'note' || typeof item.parentId !== 'string') return '';
  const parentId = item.parentId.trim();
  return parentId && parentId !== item.id ? parentId : '';
}

/** { byId, children } over a library. Accepts { items }, an items array, a Map of items or an existing index. */
export function pageIndex(library) {
  if (library?.[INDEX]) return library;
  const items = Array.isArray(library) ? library : library instanceof Map ? [...library.values()]
    : Array.isArray(library?.items) ? library.items : [];
  const byId = new Map(), children = new Map();
  for (const item of items) if (isRecord(item)) byId.set(item.id, item);
  for (const item of byId.values()) {
    const parentId = parentIdOf(item);
    if (!parentId) continue;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(item);
  }
  for (const list of children.values()) list.sort(sibling);
  return { [INDEX]: true, byId, children };
}

const itemFrom = (index, itemOrId) => (typeof itemOrId === 'string' ? index.byId.get(itemOrId) : itemOrId);

/** The live parent item of an item (or id), or null at the top level or when the parent is missing or in Trash. */
export function parentOf(library, itemOrId) {
  const index = pageIndex(library);
  const parentId = parentIdOf(itemFrom(index, itemOrId));
  const parent = parentId ? index.byId.get(parentId) : null;
  return live(parent) ? parent : null;
}

/** Notes whose parentId is `id`, oldest first (then by id). Trashed children only with includeDeleted. */
export function childrenOf(library, id, { includeDeleted = false } = {}) {
  const list = pageIndex(library).children.get(id) || [];
  return includeDeleted ? [...list] : list.filter(live);
}

/**
 * Every descendant id of `id`, depth first in sibling order, without `id` itself. Without includeDeleted the walk only
 * follows live pages (a trashed page hides its subtree).
 */
export function descendantIds(library, id, { includeDeleted = false } = {}) {
  const index = pageIndex(library);
  const out = [], seen = new Set([id]);
  const stack = [...childrenOf(index, id, { includeDeleted })].reverse();
  while (stack.length) {
    const item = stack.pop();
    if (seen.has(item.id)) continue;
    seen.add(item.id); out.push(item.id);
    stack.push(...[...childrenOf(index, item.id, { includeDeleted })].reverse());
  }
  return out;
}

/** Live ancestors for breadcrumbs, top level first: [root, ..., parent]. Stops at a missing or trashed parent. */
export function ancestorsOf(library, id) {
  const index = pageIndex(library);
  const out = [], seen = new Set([id]);
  let item = index.byId.get(id);
  while (out.length < MAX_PAGE_DEPTH) {
    const parent = parentOf(index, item);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id); out.unshift(parent); item = parent;
  }
  return out;
}

/** True when the item sits inside a live parent (browse lists show it under that parent, not on its own). */
export function isSubpage(library, item) {
  return !!parentOf(library, item);
}

/** True when putting `childId` inside `parentId` would make a page contain itself. Trashed pages count too. */
export function wouldCycle(library, childId, parentId) {
  if (!parentId) return false;
  const index = pageIndex(library);
  const seen = new Set();
  for (let id = parentId; id && !seen.has(id); id = parentIdOf(index.byId.get(id))) {
    if (id === childId) return true;
    seen.add(id);
  }
  return false;
}

/** How many pages an item sits inside (0 at the top level), following stored parents. A loop counts as Infinity. */
export function pageDepth(library, id) {
  const index = pageIndex(library);
  const seen = new Set([id]);
  let depth = 0;
  for (let parentId = parentIdOf(index.byId.get(id)); parentId && index.byId.has(parentId); parentId = parentIdOf(index.byId.get(parentId))) {
    if (seen.has(parentId)) return Infinity;
    seen.add(parentId); depth++;
  }
  return depth;
}

/** How many levels of subpages sit below an item (0 without children), trashed ones included. */
export function pageHeight(library, id) {
  const index = pageIndex(library);
  const seen = new Set([id]);
  const stack = [[id, 0]];
  let height = 0;
  while (stack.length) {
    const [current, depth] = stack.pop();
    height = Math.max(height, depth);
    for (const child of childrenOf(index, current, { includeDeleted: true })) {
      if (seen.has(child.id)) continue;
      seen.add(child.id); stack.push([child.id, depth + 1]);
    }
  }
  return height;
}

/** { item, children: [{ item, children }] } for an item and its subpages in sibling order, or null when it is missing. */
export function pageTree(library, rootId, { includeDeleted = false } = {}) {
  const index = pageIndex(library);
  const root = index.byId.get(rootId);
  if (!root) return null;
  const tree = { item: root, children: [] };
  const seen = new Set([rootId]), stack = [tree];
  while (stack.length) {
    const node = stack.pop();
    for (const child of childrenOf(index, node.item.id, { includeDeleted })) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      const entry = { item: child, children: [] };
      node.children.push(entry); stack.push(entry);
    }
  }
  return tree;
}

// Wiki targets and labels cannot hold brackets, pipes or line breaks (the same rule as wiki labels in lib/markdown.js).
const wikiText = (value, max) => String(value ?? '').replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
/** A page id or label as it may stand inside [[…]]: no brackets, pipes or line breaks, one line, at most 200 characters. */
export const pageText = value => wikiText(value, 200);

/**
 * The canonical page-block line for a subpage: [[id|Title]]{page}. Older builds and wiki-aware tools read it as a wiki
 * link to the page. The title is only a fallback label: Still shows the page's current title.
 */
export function pageBlockLine(id, title) {
  return `[[${pageText(id)}|${pageText(title) || 'Untitled page'}]]{page}`;
}

// A page-block line inside note Markdown: [[id]]{page} or [[id|Label]]{page}, alone on its line.
const PAGE_LINE = /^[ \t]*\[\[([^[\]\n|]{1,200})(?:\|([^[\]\n]{1,200}))?\]\]\{page\}[ \t]*\r?$/;
/** { id, label } when a line is a page block, else null. */
export function parsePageBlockLine(line) {
  const match = PAGE_LINE.exec(String(line ?? ''));
  return match && match[1].trim() ? { id: match[1].trim(), label: (match[2] || '').trim() } : null;
}
