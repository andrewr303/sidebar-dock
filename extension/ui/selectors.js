// Derived library data, memoized on library.updatedAt so renders never re-sort or re-count the whole library.
//
// Subpages (lib/pages.js): a note inside another live item is not listed on its own in browse lists (All items, Inbox,
// collections, Notes): it shows under its parent. A parent in Trash or the archive does not count, and the Notes views
// hide only subpages of a note, so a note inside a saved article (research findings) is still listed among the notes.
// Search results, Favorites, Highlights, Reminders, tags, Untagged, Duplicates and Archive stay flat (cards show the
// parent path). Trash lists the pages that were trashed on their own; the subpages trashed together with them are
// counted on that row. Counts (counts()) are item counts: every live item, subpages included, so the sidebar can read
// higher than the number of rows a browse list shows.
import { canonicalUrl } from '../lib/store.js';
import { pageIndex, parentIdOf, childrenOf, ancestorsOf, descendantIds } from '../lib/pages.js';

const ITEM_VIEW_TYPES = ['bookmark', 'article', 'image', 'video', 'file', 'note'];
const alive = item => !item.deletedAt && !item.archived;
const safeCanonical = url => { try { return url ? canonicalUrl(url) : ''; } catch { return ''; } };
const lower = value => String(value ?? '').toLowerCase();
export const domainOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const TASK_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+/;
/** Views that list items by place (where they live): they hide subpages, which show under their parent instead. */
export const isBrowseView = view => view === 'all' || view === 'inbox' || view === 'notes' || /^(?:type|collection):/.test(String(view || ''));

/** The live item an item sits inside (a note's page parent), or null. byId: Map of every item. */
export function liveParentOf(byId, item) {
  const parent = byId.get(parentIdOf(item));
  return parent && !parent.deletedAt && !parent.archived ? parent : null;
}

/** Trashed together with its parent: the parent is in Trash with the identical stamp (one trash action took both). */
export function trashedWithParent(byId, item) {
  if (!item?.deletedAt) return false;
  const parent = byId.get(parentIdOf(item));
  return !!parent && parent.deletedAt === item.deletedAt;
}

/** Ids of the subpages that went to Trash together with `id` (same deletedAt), walking only through those pages. */
export function trashedTogetherIds(library, id) {
  const index = pageIndex(library || []);
  const root = index.byId.get(id);
  if (!root?.deletedAt) return [];
  const out = [], seen = new Set([id]), stack = [id];
  while (stack.length) {
    for (const child of childrenOf(index, stack.pop(), { includeDeleted: true })) {
      if (seen.has(child.id) || child.deletedAt !== root.deletedAt) continue;
      seen.add(child.id); out.push(child.id); stack.push(child.id);
    }
  }
  return out;
}

export function createSelectors(getLibrary, getPrefs = () => ({})) {
  let stamp = null;
  let memo = {};
  const cached = (key, compute) => {
    const library = getLibrary();
    const next = library?.updatedAt ?? null;
    if (next !== stamp) { stamp = next; memo = {}; }
    if (!(key in memo)) memo[key] = compute(library || { items: [], collections: [], settings: {} });
    return memo[key];
  };

  const index = () => cached('index', lib => new Map(lib.items.map(item => [item.id, item])));
  const pages = () => cached('pages', lib => pageIndex(lib.items));
  /** The live item `id` sits inside, or null at the top level. */
  const parentOf = id => liveParentOf(index(), index().get(id));
  /** Live subpages of an item, oldest first. */
  const children = id => cached(`children:${id}`, () => childrenOf(pages(), id));
  /** Live ancestors of an item for breadcrumbs: [root, ..., parent]. */
  const pagePath = id => cached(`pagePath:${id}`, () => ancestorsOf(pages(), id));
  /** Ids of every live subpage below an item (all levels). */
  const pageDescendants = id => cached(`pageDesc:${id}`, () => descendantIds(pages(), id));
  /** How many subpages went to Trash together with this trashed item. */
  const trashedWith = id => cached(`trashedWith:${id}`, () => trashedTogetherIds(pages(), id).length);
  const collectionIndex = () => cached('collectionIndex', lib => new Map(lib.collections.filter(c => !c.deletedAt).map(c => [c.id, c])));
  const live = () => cached('live', lib => lib.items.filter(alive));

  /** Ordered collection tree: [{ ...collection, depth, childIds, hasChildren }], pinned first among siblings, cycle safe. */
  const tree = () => cached('tree', lib => {
    const all = lib.collections.filter(c => !c.deletedAt && c.id);
    const byParent = new Map();
    for (const c of all) {
      const parent = c.parentId && all.some(p => p.id === c.parentId) ? c.parentId : '';
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(c);
    }
    for (const rows of byParent.values()) rows.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
    const out = [];
    const seen = new Set();
    const walk = (parentId, depth) => {
      for (const c of byParent.get(parentId) || []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        const childIds = (byParent.get(c.id) || []).map(child => child.id);
        out.push({ ...c, depth, childIds, hasChildren: childIds.length > 0 });
        walk(c.id, depth + 1);
      }
    };
    walk('', 0);
    for (const c of all) if (!seen.has(c.id)) out.push({ ...c, depth: 0, childIds: [], hasChildren: false });
    return out;
  });

  const descendants = id => cached(`desc:${id}`, () => {
    const result = [id];
    const rows = tree();
    const queue = [id];
    const seen = new Set(queue);
    while (queue.length) {
      const current = queue.shift();
      for (const row of rows) if (row.parentId === current && !seen.has(row.id)) { seen.add(row.id); result.push(row.id); queue.push(row.id); }
    }
    return result;
  });

  const path = id => cached(`path:${id}`, () => {
    const out = [];
    const seen = new Set();
    let current = collectionIndex().get(id);
    while (current && !seen.has(current.id)) { seen.add(current.id); out.unshift(current); current = collectionIndex().get(current.parentId); }
    return out;
  });

  const duplicateGroups = () => cached('duplicates', lib => {
    const groups = new Map();
    for (const item of lib.items) {
      if (item.deletedAt || item.type === 'note' || !item.url) continue;
      const key = safeCanonical(item.url);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return [...groups.entries()].filter(([, rows]) => rows.length > 1).map(([url, rows]) => ({ url, items: rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) }));
  });

  const counts = () => cached('counts', lib => {
    const items = live();
    const byType = Object.fromEntries(ITEM_VIEW_TYPES.map(type => [type, 0]));
    const byCollection = {};
    let favorites = 0, notes = 0, highlights = 0, untagged = 0, tasksOpen = 0, inbox = 0, reminders = 0;
    for (const item of items) {
      byType[item.type] = (byType[item.type] || 0) + 1;
      if (item.collectionId) byCollection[item.collectionId] = (byCollection[item.collectionId] || 0) + 1; else inbox++;
      if (item.favorite) favorites++;
      if (item.type === 'note') notes++;
      if (item.reminderAt && !item.reminderNotifiedAt) reminders++;
      highlights += item.highlights?.length || 0;
      if (!item.tags?.length) untagged++;
      if (item.type === 'note' && item.content) for (const line of item.content.split('\n')) if (TASK_LINE.test(line) && / \]/.test(line.match(TASK_LINE)[0])) tasksOpen++;
    }
    const byCollectionDeep = {};
    for (const row of tree()) byCollectionDeep[row.id] = descendants(row.id).reduce((sum, id) => sum + (byCollection[id] || 0), 0);
    return {
      all: items.length, inbox, favorites, notes, highlights, untagged, tasksOpen, reminders, byType, byCollection, byCollectionDeep,
      archive: lib.items.filter(i => i.archived && !i.deletedAt).length,
      trash: lib.items.filter(i => i.deletedAt).length,
      duplicates: duplicateGroups().reduce((sum, group) => sum + group.items.length - 1, 0),
    };
  });

  const tags = () => cached('tags', () => {
    const map = new Map();
    for (const item of live()) for (const tag of item.tags || []) {
      const key = tag.toLowerCase();
      const entry = map.get(key) || { name: tag, count: 0 };
      entry.count++;
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  });

  const backlinks = id => cached(`backlinks:${id}`, lib => lib.items.filter(item => !item.deletedAt && item.id !== id && (item.relatedIds || []).includes(id)));
  const related = id => {
    const item = index().get(id);
    if (!item) return [];
    const out = new Map();
    for (const rid of item.relatedIds || []) { const target = index().get(rid); if (target && !target.deletedAt) out.set(rid, target); }
    for (const back of backlinks(id)) out.set(back.id, back);
    return [...out.values()];
  };
  // Items saved at an address, plus (after them) an article saved under its canonical address from that tab: it keeps
  // the tab's address in sourceUrl (the same rule as lib/capture.js findSavedItem). Links, images and videos keep the
  // page they were found on in sourceUrl, and that page is not them, so only articles match that way.
  const findByUrl = url => {
    const key = safeCanonical(url);
    if (!key) return [];
    return cached(`url:${key}`, lib => {
      const direct = [], bySource = [];
      for (const item of lib.items) {
        if (item.deletedAt) continue;
        if (item.url && safeCanonical(item.url) === key) direct.push(item);
        else if (item.type === 'article' && item.url && item.sourceUrl && safeCanonical(item.sourceUrl) === key) bySource.push(item);
      }
      return [...direct, ...bySource];
    });
  };
  const savedForUrl = url => findByUrl(url).find(item => item.type !== 'note') || null;
  const notesForUrl = url => findByUrl(url).filter(item => item.type === 'note' && !item.archived)
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || String(b.updatedAt).localeCompare(String(a.updatedAt)));

  const recentCollections = (limit = 8) => cached(`recent:${limit}`, lib => {
    const recents = (getPrefs().recentCollections || []).filter(id => collectionIndex().has(id));
    const pinned = tree().filter(c => c.pinned).map(c => c.id);
    const byActivity = [...lib.items].filter(i => i.collectionId && !i.deletedAt)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(i => i.collectionId);
    return [...new Set([...recents, ...pinned, ...byActivity])].filter(id => collectionIndex().has(id)).slice(0, limit).map(id => collectionIndex().get(id));
  });

  /** Items for a main view, filtered by query/type/tag and sorted. state: { view, query, typeFilter, tagFilter, sort }. */
  function itemsForView({ view = 'all', query = '', typeFilter = 'all', tagFilter = '', sort = 'newest' } = {}) {
    return cached(`view:${view}|${query}|${typeFilter}|${tagFilter}|${sort}`, lib => {
      let rows;
      if (view === 'trash') rows = lib.items.filter(i => i.deletedAt);
      else if (view === 'archive') rows = lib.items.filter(i => i.archived && !i.deletedAt);
      else {
        rows = live();
        if (view === 'inbox') rows = rows.filter(i => !i.collectionId);
        else if (view === 'favorites') rows = rows.filter(i => i.favorite);
        else if (view === 'notes') rows = rows.filter(i => i.type === 'note');
        else if (view === 'highlights') rows = rows.filter(i => i.highlights?.length);
        else if (view === 'untagged') rows = rows.filter(i => !i.tags?.length);
        else if (view === 'reminders') rows = rows.filter(i => i.reminderAt && !i.reminderNotifiedAt);
        else if (view === 'duplicates') { const ids = new Set(duplicateGroups().flatMap(g => g.items.map(i => i.id))); rows = rows.filter(i => ids.has(i.id)); }
        else if (view.startsWith('type:')) { const type = view.slice(5); rows = rows.filter(i => type === 'file' ? ['file'].includes(i.type) : i.type === type); }
        else if (view.startsWith('collection:')) { const ids = new Set(descendants(view.slice(11))); rows = rows.filter(i => ids.has(i.collectionId)); }
        else if (view.startsWith('tag:')) { const tag = lower(view.slice(4)); rows = rows.filter(i => i.tags?.some(t => lower(t) === tag)); }
      }
      // Without a search, browse views list top-level items only, and Trash lists what was trashed on its own.
      if (!query.trim()) {
        if (view === 'trash') rows = rows.filter(i => !trashedWithParent(index(), i));
        else if (isBrowseView(view)) {
          const byId = index(), noteView = view === 'notes' || view === 'type:note';
          rows = rows.filter(i => {
            const parent = liveParentOf(byId, i);
            return !parent || (noteView && parent.type !== 'note');
          });
        }
      }
      if (typeFilter && typeFilter !== 'all') rows = rows.filter(i => typeFilter === 'link' ? ['bookmark', 'article'].includes(i.type) : typeFilter === 'media' ? ['image', 'video', 'file'].includes(i.type) : i.type === typeFilter);
      if (tagFilter) rows = rows.filter(i => i.tags?.some(t => lower(t) === lower(tagFilter)));
      if (query.trim()) rows = searchRows(rows, query, collectionIndex());
      return sortRows(rows, sort);
    });
  }

  return {
    live, byId: id => index().get(id) || null, collection: id => collectionIndex().get(id) || null, tree, path, descendants, counts, tags,
    duplicates: duplicateGroups, backlinks, related, findByUrl, savedForUrl, notesForUrl, recentCollections, itemsForView,
    pages, parentOf, children, pagePath, pageDescendants, subpageCount: id => children(id).length, trashedWith,
  };
}

const SORTERS = {
  newest: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
  oldest: (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)),
  updated: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)),
  title: (a, b) => String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base', numeric: true }),
  domain: (a, b) => domainOf(a.url).localeCompare(domainOf(b.url)) || SORTERS.newest(a, b),
};
export const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' }, { value: 'oldest', label: 'Oldest first' }, { value: 'updated', label: 'Recently updated' },
  { value: 'title', label: 'Title A to Z' }, { value: 'domain', label: 'Website' },
];
export function sortRows(rows, sort = 'newest') {
  const pinnedFirst = (a, b) => Number(!!b.pinned) - Number(!!a.pinned);
  return [...rows].sort((a, b) => pinnedFirst(a, b) || (SORTERS[sort] || SORTERS.newest)(a, b));
}

/** Search syntax: words AND-ed, "quoted phrases", tag:x / #x, type:x, site:domain. Matches title, url, excerpt, content, article text, tags, highlights, file name and collection name. */
export function parseQuery(query) {
  const tokens = [];
  const tags = [];
  const types = [];
  const sites = [];
  const re = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = re.exec(String(query || '')))) {
    if (match[1]) { tokens.push(match[1].toLowerCase()); continue; }
    const word = match[2];
    if (/^tag:/i.test(word) && word.length > 4) tags.push(word.slice(4).toLowerCase());
    else if (/^#\S/.test(word)) tags.push(word.slice(1).toLowerCase());
    else if (/^type:/i.test(word)) types.push(word.slice(5).toLowerCase());
    else if (/^site:/i.test(word)) sites.push(word.slice(5).toLowerCase().replace(/^www\./, ''));
    else tokens.push(word.toLowerCase());
  }
  return { tokens, tags, types, sites };
}

export function searchRows(rows, query, collections = new Map()) {
  const { tokens, tags, types, sites } = parseQuery(query);
  return rows.filter(item => {
    if (tags.length && !tags.every(tag => item.tags?.some(t => t.toLowerCase() === tag))) return false;
    if (types.length && !types.includes(item.type) && !(types.includes('link') && ['bookmark', 'article'].includes(item.type))) return false;
    if (sites.length && !sites.some(site => domainOf(item.url).endsWith(site))) return false;
    if (!tokens.length) return true;
    const haystack = [item.title, item.url, item.excerpt, item.content, item.articleContent, item.fileName, collections.get(item.collectionId)?.name,
      ...(item.tags || []), ...(item.highlights || []).flatMap(h => [h.text, h.note])].join('\n').toLowerCase();
    return tokens.every(token => haystack.includes(token));
  });
}
