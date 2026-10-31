// Bookmarks widget model: an index over Chrome's bookmark tree (chrome.bookmarks.getTree() nodes) and the views the
// widget draws from it: a folder's children sorted, the folder list for the picker, breadcrumbs, search across a
// folder and everything under it, the visible rows of the expandable tree, and the plan for copying a folder into
// Still as collections and links. Pure: no DOM, no chrome.*.
import { canonicalUrl } from '../../../lib/store.js';

export const ROOT_ID = '0';
export const BAR_ID = '1';
export const BOOKMARK_VIEWS = Object.freeze(['list', 'icons', 'large', 'tree']);
export const BOOKMARK_SORTS = Object.freeze(['manual', 'title', 'recent']);
const OPEN_IN = ['current', 'new', 'background'];

export const bookmarkDefaults = () => ({ folderId: BAR_ID, view: 'list', sort: 'manual', showFolders: true, openIn: 'current', showSearch: true });

export function bookmarkConfig(config = {}) {
  const c = { ...bookmarkDefaults(), ...(config && typeof config === 'object' ? config : {}) };
  return {
    folderId: typeof c.folderId === 'string' && c.folderId ? c.folderId : BAR_ID,
    view: BOOKMARK_VIEWS.includes(c.view) ? c.view : 'list',
    sort: BOOKMARK_SORTS.includes(c.sort) ? c.sort : 'manual',
    showFolders: c.showFolders !== false,
    openIn: OPEN_IN.includes(c.openIn) ? c.openIn : 'current',
    showSearch: c.showSearch !== false,
  };
}

const isWeb = url => /^https?:\/\//i.test(String(url || ''));

/**
 * Flattens chrome.bookmarks.getTree() output into { nodes: Map(id -> node), links (count of web links) } where each
 * node is { id, parentId, title, url, dateAdded, index, children: [ids] | undefined, links, total }. `links` counts a
 * folder's direct web links and `total` every web link under it.
 */
export function indexTree(roots = []) {
  const nodes = new Map();
  const visit = (node, parentId) => {
    if (!node || node.id == null) return null;
    const id = String(node.id);
    const entry = {
      id, parentId: node.parentId != null ? String(node.parentId) : parentId, title: String(node.title || ''), url: node.url ? String(node.url) : '',
      dateAdded: Number(node.dateAdded) || 0, index: Number.isInteger(node.index) ? node.index : 0, children: undefined, links: 0, total: 0,
    };
    nodes.set(id, entry);
    if (!node.url) {
      entry.children = [];
      for (const child of Array.isArray(node.children) ? node.children : []) {
        const done = visit(child, id);
        if (!done) continue;
        entry.children.push(done.id);
        if (done.url) { if (isWeb(done.url)) { entry.links++; entry.total++; } } else entry.total += done.total;
      }
    }
    return entry;
  };
  for (const root of [roots].flat()) visit(root, '');
  return { nodes, links: [...nodes.values()].filter(n => n.url && isWeb(n.url)).length };
}

export const isFolder = node => !!node && !node.url;

/** A node's display title: Chrome's root folders always have titles; untitled links fall back to their host. */
export function nodeTitle(node) {
  if (!node) return '';
  if (node.title.trim()) return node.title.trim();
  if (!node.url) return 'Untitled folder';
  try { return new URL(node.url).hostname.replace(/^www\./, ''); } catch { return node.url; }
}

const collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;
const byTitle = (a, b) => (collator ? collator.compare(nodeTitle(a), nodeTitle(b)) : nodeTitle(a).localeCompare(nodeTitle(b)));

/**
 * A folder's children to show: web links (other schemes such as javascript: bookmarklets are left out) and, with
 * showFolders, subfolders. manual keeps Chrome's order; title sorts A–Z with folders first; recent puts the newest
 * links first, folders first.
 */
export function folderChildren(index, folderId, { sort = 'manual', showFolders = true } = {}) {
  const folder = index?.nodes.get(String(folderId));
  if (!isFolder(folder)) return [];
  const children = folder.children.map(id => index.nodes.get(id)).filter(node => node && (node.url ? isWeb(node.url) : showFolders));
  if (sort === 'title') return [...children.filter(isFolder).sort(byTitle), ...children.filter(n => !isFolder(n)).sort(byTitle)];
  if (sort === 'recent') return [...children.filter(isFolder).sort(byTitle), ...children.filter(n => !isFolder(n)).sort((a, b) => b.dateAdded - a.dateAdded || byTitle(a, b))];
  return children;
}

/** Ancestors from the top-level folder down to folderId (Chrome's invisible root excluded): [{ id, title }]. */
export function folderPath(index, folderId) {
  const path = [];
  const seen = new Set();
  let node = index?.nodes.get(String(folderId));
  while (node && node.id !== ROOT_ID && !seen.has(node.id)) {
    seen.add(node.id);
    path.unshift({ id: node.id, title: nodeTitle(node) });
    node = index.nodes.get(node.parentId);
  }
  return path;
}

/** True when `id` is folderId itself or inside it. */
export function isWithin(index, id, folderId) {
  const seen = new Set();
  let node = index?.nodes.get(String(id));
  while (node && !seen.has(node.id)) {
    if (node.id === String(folderId)) return true;
    seen.add(node.id);
    node = index.nodes.get(node.parentId);
  }
  return false;
}

/** Every folder in tree order for the folder picker: [{ id, title, depth, links, total, folders }] (root excluded). */
export function folderOptions(index) {
  const out = [];
  const root = index?.nodes.get(ROOT_ID);
  const walk = (ids, depth) => {
    for (const id of ids) {
      const node = index.nodes.get(id);
      if (!isFolder(node)) continue;
      out.push({ id, title: nodeTitle(node), depth, links: node.links, total: node.total, folders: node.children.filter(c => isFolder(index.nodes.get(c))).length });
      walk(node.children, depth + 1);
    }
  };
  if (root) walk(root.children, 0);
  else for (const node of index?.nodes.values() || []) if (isFolder(node) && !index.nodes.has(node.parentId)) walk([node.id], 0);
  return out;
}

/** Folder options whose title (or any ancestor's) matches the query, keeping ancestors so the indentation reads. */
export function filterFolderOptions(options, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  const keep = new Set();
  const stack = [];
  for (const [i, option] of options.entries()) {
    stack.length = option.depth;
    stack.push(i);
    if (words.every(word => option.title.toLowerCase().includes(word))) for (const j of stack) keep.add(j);
  }
  return options.filter((_, i) => keep.has(i));
}

/**
 * Web links inside a folder (at any depth) matching every word of the query in the title or address, best first
 * (title starts with the query, then title contains, then address), at most `limit`: [{ node, folderTitle }].
 */
export function searchBookmarks(index, folderId, query, { limit = 50 } = {}) {
  const text = String(query || '').trim().toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || !index) return [];
  const hits = [];
  const walk = id => {
    const node = index.nodes.get(id);
    if (!node) return;
    if (isFolder(node)) { for (const child of node.children) walk(child); return; }
    if (!isWeb(node.url)) return;
    const title = nodeTitle(node).toLowerCase();
    const url = node.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
    if (!words.every(word => title.includes(word) || url.includes(word))) return;
    const rank = title.startsWith(text) ? 0 : words.every(word => title.includes(word)) ? 1 : 2;
    hits.push({ node, rank, folderTitle: nodeTitle(index.nodes.get(node.parentId)) });
  };
  walk(String(folderId));
  return hits.sort((a, b) => a.rank - b.rank || byTitle(a.node, b.node)).slice(0, limit).map(({ node, folderTitle }) => ({ node, folderTitle }));
}

/**
 * Visible rows of the expandable tree view below folderId: [{ node, depth, expanded }] — a folder's children appear
 * only while it is in `expanded` (a Set of ids).
 */
export function treeRows(index, folderId, expanded = new Set(), options = {}) {
  const rows = [];
  const walk = (id, depth) => {
    for (const node of folderChildren(index, id, { ...options, showFolders: true })) {
      const open = isFolder(node) && expanded.has(node.id);
      rows.push({ node, depth, expanded: open });
      if (open) walk(node.id, depth + 1);
    }
  };
  walk(String(folderId), 0);
  return rows;
}

/** Ids of every folder inside folderId (not folderId itself), e.g. for "Expand all". */
export function allFolderIds(index, folderId) {
  const out = [];
  const walk = id => {
    for (const childId of index?.nodes.get(id)?.children || []) {
      if (!isFolder(index.nodes.get(childId))) continue;
      out.push(childId);
      walk(childId);
    }
  };
  walk(String(folderId));
  return out;
}

/**
 * The plan for copying a folder into Still: one collection for the folder and one per subfolder that holds links
 * (at any depth), and a link item for every web address not already in the library (`existing`: a Set of
 * canonical URLs) — each address once. Ids come from makeId(prefix). Returns
 * { collections: [{ id, name, parentId, icon }], items: [{ id, type, title, url, collectionId, createdAt }], skipped, rootId }.
 */
export function importPlan(index, folderId, { existing = new Set(), makeId, parentId = '' } = {}) {
  const root = index?.nodes.get(String(folderId));
  if (!isFolder(root)) return { collections: [], items: [], skipped: 0, rootId: '' };
  const id = makeId || (prefix => `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);
  const collections = [];
  const items = [];
  const seen = new Set(existing);
  let skipped = 0;
  const walk = (node, collectionParent) => {
    const collection = { id: id('collection'), name: nodeTitle(node).slice(0, 200), parentId: collectionParent, icon: 'folder' };
    collections.push(collection);
    for (const childId of node.children) {
      const child = index.nodes.get(childId);
      if (!child) continue;
      if (isFolder(child)) { if (child.total > 0) walk(child, collection.id); continue; }
      let key = '';
      try { key = isWeb(child.url) ? canonicalUrl(child.url) : ''; } catch { key = ''; }
      if (!key) continue;
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      items.push({ id: id('item'), type: 'bookmark', title: nodeTitle(child).slice(0, 500), url: child.url, collectionId: collection.id,
        createdAt: child.dateAdded ? new Date(child.dateAdded).toISOString() : undefined });
    }
  };
  walk(root, parentId);
  return { collections, items, skipped, rootId: collections[0]?.id || '' };
}
