// Delegated drag and drop. Items ([data-drag-item]) drop onto collections ([data-drop-collection], '' = Inbox), tags
// ([data-drop-tag]) and filters ([data-drop-filter] favorite|archive|trash). Collection rows ([data-drag-collection])
// reorder or nest. Links and files dragged in from other pages or apps save to a collection row or open the Add dialog
// when dropped on a [data-drop-zone]. The pure helpers at the top are unit tested.

const ITEMS_TYPE = 'application/x-still-items';
const COLLECTION_TYPE = 'application/x-still-collection';
const WEB_URL = /^https?:\/\/[^\s]+$/i;

/** Where a pointer at clientY falls on a row: 'before' | 'inside' | 'after'. Without allowInside the row splits in half. */
export function dropPlacement(clientY, top, height, { allowInside = true } = {}) {
  const offset = Math.min(Math.max(clientY - top, 0), height);
  if (!allowInside) return offset < height / 2 ? 'before' : 'after';
  if (offset < height * 0.25) return 'before';
  if (offset > height * 0.75) return 'after';
  return 'inside';
}

/**
 * Translates a drop of collection dragId on targetId into store.moveCollection placement ({ parentId, beforeId }),
 * or null when the drop is invalid (onto itself or a descendant) or would change nothing.
 * tree: selectors.tree() rows; expanded: Set of expanded ids (dropping "after" an open parent nests as its first child).
 */
export function collectionMove(tree, dragId, targetId, placement, expanded = new Set()) {
  const byId = new Map(tree.map(row => [row.id, row]));
  const dragged = byId.get(dragId);
  const target = targetId === '' ? null : byId.get(targetId);
  if (!dragged || (targetId !== '' && !target)) return null;
  for (let cursor = target, guard = 0; cursor && guard < 1000; cursor = byId.get(cursor.parentId), guard++) {
    if (cursor.id === dragId) return null;
  }
  const parentOf = row => (row.depth > 0 ? row.parentId || '' : '');
  const children = parentId => tree.filter(row => parentOf(row) === parentId && row.id !== dragId);
  let move;
  if (!target) move = { parentId: '', beforeId: '' };
  else if (placement === 'inside') move = { parentId: target.id, beforeId: '' };
  else if (placement === 'after' && target.hasChildren && expanded.has(target.id)) move = { parentId: target.id, beforeId: children(target.id)[0]?.id || '' };
  else {
    const siblings = children(parentOf(target));
    const index = siblings.findIndex(row => row.id === target.id);
    move = { parentId: parentOf(target), beforeId: placement === 'before' ? target.id : siblings[index + 1]?.id || '' };
  }
  const current = tree.filter(row => parentOf(row) === parentOf(dragged));
  const nextSibling = current[current.findIndex(row => row.id === dragId) + 1]?.id || '';
  if (move.parentId === parentOf(dragged) && move.beforeId === nextSibling) return null;
  return move;
}

const decodeEntities = text => text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }[name]));

/** Links carried by a drag from a web page or another app: [{ url, title }] (http and https only, deduped). */
export function droppedLinks(read) {
  const get = type => { try { return String(read(type) || ''); } catch { return ''; } };
  const urls = get('text/uri-list').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const plain = get('text/plain').trim();
  if (!urls.length && plain) urls.push(...plain.split(/\s+/));
  const anchor = get('text/html').match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
  const anchorText = anchor ? decodeEntities(anchor[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
  const seen = new Set();
  return urls.filter(url => WEB_URL.test(url) && !seen.has(url) && seen.add(url))
    .map((url, index) => ({ url, title: index === 0 && anchorText && anchorText !== url ? anchorText.slice(0, 300) : '' }));
}

let drag = null;          // internal drag: { kind: 'items', ids } | { kind: 'collection', id }
let marked = [];          // elements carrying drop-state classes
let expandTimer = 0;
let expandTarget = '';
let initialized = false;

const MARKS = ['is-drop-target', 'is-drop-before', 'is-drop-after', 'is-drop-inside', 'is-drop-active'];
function clearMarks() {
  for (const el of marked) el.classList.remove(...MARKS);
  marked = [];
}
function mark(el, className) {
  if (marked.length === 1 && marked[0] === el && el.classList.contains(className)) return;
  clearMarks();
  el.classList.add(className);
  marked = [el];
}
const isEditable = target => !!target?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
const hasExternal = types => types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain');

function stopExpandTimer() { clearTimeout(expandTimer); expandTimer = 0; expandTarget = ''; }

/** Wires the delegated listeners once. openAdd is quick-add's openAdd (injected so this module stays dependency free). */
export function initDnd(ctx, { openAdd } = {}) {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;
  const expanded = () => new Set(ctx.prefs.get('expandedCollections', []));
  // The collection on screen ('' = Inbox). In the side panel only the Library tab's drill-down shows one; a view left
  // open there must not capture drops on This page or Notes.
  const viewCollection = () => {
    const { view, sideTab, sideStack, panel } = ctx.state;
    if (ctx.env.isSidepanel && (sideTab !== 'library' || !sideStack?.length || panel)) return undefined;
    return view === 'inbox' ? '' : view.startsWith('collection:') ? view.slice(11) : undefined;
  };
  const collectionName = id => (id ? ctx.select.collection(id)?.name || 'collection' : 'Inbox');

  document.addEventListener('dragstart', event => {
    const target = event.target instanceof Element ? event.target : null;
    const collectionRow = target?.closest('[data-drag-collection]');
    const itemEl = !collectionRow && target?.closest('[data-drag-item]');
    if (collectionRow) {
      if (collectionRow.querySelector('.tree-rename')) { event.preventDefault(); return; }
      drag = { kind: 'collection', id: collectionRow.dataset.dragCollection };
      event.dataTransfer.setData(COLLECTION_TYPE, drag.id);
      event.dataTransfer.effectAllowed = 'move';
      document.documentElement.classList.add('is-dragging', 'is-dragging-collection');
    } else if (itemEl) {
      const id = itemEl.dataset.dragItem;
      const ids = ctx.state.selection?.has(id) ? [...ctx.state.selection] : [id];
      drag = { kind: 'items', ids };
      event.dataTransfer.setData(ITEMS_TYPE, JSON.stringify(ids));
      const item = ctx.select.byId(id);
      // Single links still drop into other apps (address bar, editors) as a plain URL.
      if (ids.length === 1 && item?.url) { event.dataTransfer.setData('text/uri-list', item.url); event.dataTransfer.setData('text/plain', item.url); }
      event.dataTransfer.effectAllowed = 'copyMove';
      if (ids.length > 1) {
        const ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.textContent = `${ids.length} items`;
        document.body.append(ghost);
        event.dataTransfer.setDragImage(ghost, 14, 14);
        setTimeout(() => ghost.remove(), 0);
      }
      document.documentElement.classList.add('is-dragging', 'is-dragging-items');
    }
  });

  document.addEventListener('dragover', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const types = [...(event.dataTransfer?.types || [])];
    if (drag?.kind === 'collection') {
      const row = target.closest('[data-drop-collection]:not([data-drop-collection=""])');
      const root = !row && target.closest('[data-drop-root]');
      if (!row && !root) { clearMarks(); stopExpandTimer(); return; }
      const id = row ? row.dataset.dropCollection : '';
      const rect = row?.getBoundingClientRect();
      const placement = row ? dropPlacement(event.clientY, rect.top, rect.height) : 'inside';
      if (!collectionMove(ctx.select.tree(), drag.id, id, placement, expanded())) { clearMarks(); stopExpandTimer(); return; }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      mark(row || root, row ? `is-drop-${placement}` : 'is-drop-target');
      if (row && placement === 'inside') scheduleExpand(ctx, row);
      else stopExpandTimer();
      return;
    }
    if (drag?.kind === 'items') {
      const zone = target.closest('[data-drop-collection], [data-drop-tag], [data-drop-filter]');
      if (!zone) { clearMarks(); stopExpandTimer(); return; }
      event.preventDefault();
      event.dataTransfer.dropEffect = zone.hasAttribute('data-drop-collection') ? 'move' : 'copy';
      mark(zone, 'is-drop-target');
      if (zone.hasAttribute('data-drag-collection')) scheduleExpand(ctx, zone); else stopExpandTimer();
      return;
    }
    if (!hasExternal(types) || isEditable(target)) { clearMarks(); return; }
    const row = target.closest('[data-drop-collection]');
    const zone = row || target.closest('[data-drop-zone]');
    if (!zone) { clearMarks(); return; }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    mark(zone, row ? 'is-drop-target' : 'is-drop-active');
    if (row?.hasAttribute('data-drag-collection')) scheduleExpand(ctx, row); else stopExpandTimer();
  });

  document.addEventListener('dragleave', event => {
    // Leaving the window (no related target) clears every cue; moving between rows is handled by dragover.
    if (!event.relatedTarget) { clearMarks(); stopExpandTimer(); }
  });

  document.addEventListener('drop', event => {
    const target = event.target instanceof Element ? event.target : null;
    const current = drag;
    const transfer = event.dataTransfer;
    // dragend never reaches the document when the dragged row re-renders away; do not let this drag leak into the next.
    drag = null;
    document.documentElement.classList.remove('is-dragging', 'is-dragging-items', 'is-dragging-collection');
    clearMarks();
    stopExpandTimer();
    if (!target) return;
    if (current?.kind === 'collection') {
      const row = target.closest('[data-drop-collection]:not([data-drop-collection=""])');
      const root = !row && target.closest('[data-drop-root]');
      if (!row && !root) return;
      const id = row ? row.dataset.dropCollection : '';
      const rect = row?.getBoundingClientRect();
      const placement = row ? dropPlacement(event.clientY, rect.top, rect.height) : 'inside';
      const move = collectionMove(ctx.select.tree(), current.id, id, placement, expanded());
      if (!move) return;
      event.preventDefault();
      ctx.run(async () => {
        await ctx.store.moveCollection(current.id, move);
        if (move.parentId) ctx.prefs.toggleInList('expandedCollections', move.parentId, true);
        ctx.render();
      });
      return;
    }
    if (current?.kind === 'items') {
      const zone = target.closest('[data-drop-collection], [data-drop-tag], [data-drop-filter]');
      if (!zone) return;
      event.preventDefault();
      ctx.run(() => dropItems(ctx, current.ids, zone, collectionName));
      return;
    }
    if (isEditable(target)) return;
    const row = target.closest('[data-drop-collection]');
    const zone = row || target.closest('[data-drop-zone]');
    if (!zone) return;
    const files = [...(transfer?.files || [])];
    const links = droppedLinks(type => transfer.getData(type));
    if (!files.length && !links.length) return;
    event.preventDefault();
    const collectionId = row ? row.dataset.dropCollection : viewCollection();
    if (files.length) { openAdd?.(ctx, { files, collectionId, source: 'drop' }); return; }
    if (!row) { openAdd?.(ctx, { ...links[0], collectionId, source: 'drop' }); return; }
    ctx.run(async () => {
      const saved = [];
      let status = 'saved';
      for (const link of links) {
        // A link that is already saved only moves: saveItem would merge the drop's bare data over it and replace its
        // title (with the anchor text or the host name) and its type (article, image, video) with a plain bookmark.
        const existing = ctx.select.savedForUrl(link.url);
        if (!existing) saved.push(await ctx.store.saveItem({ type: 'bookmark', url: link.url, ...(link.title ? { title: link.title } : {}), collectionId }));
        else if ((existing.collectionId || '') === collectionId) { saved.push(existing); status = 'already'; }
        else { saved.push(await ctx.store.updateItem(existing.id, { collectionId })); status = 'moved'; }
      }
      ctx.prefs.touchCollection(collectionId);
      const where = collectionName(collectionId);
      const message = saved.length > 1 ? `Saved ${saved.length} links to ${where}`
        : { saved: `Saved to ${where}`, moved: `Moved the saved link to ${where}`, already: `Already saved in ${where}` }[status];
      ctx.toast(message, { tone: 'success', action: saved.length === 1 ? { label: 'Edit', run: () => ctx.openItem(saved[0].id) } : null });
    });
  });

  document.addEventListener('dragend', () => {
    drag = null;
    clearMarks();
    stopExpandTimer();
    document.documentElement.classList.remove('is-dragging', 'is-dragging-items', 'is-dragging-collection');
  });
}

function scheduleExpand(ctx, row) {
  const id = row.dataset.dragCollection || row.dataset.dropCollection;
  if (!id || row.getAttribute('aria-expanded') !== 'false') { stopExpandTimer(); return; }
  if (expandTarget === id) return;
  stopExpandTimer();
  expandTarget = id;
  // Hovering a collapsed parent while dragging opens it, like a file manager.
  expandTimer = setTimeout(() => { ctx.prefs.toggleInList('expandedCollections', id, true); ctx.render(); expandTarget = ''; }, 650);
}

async function dropItems(ctx, ids, zone, collectionName) {
  const items = ids.map(id => ctx.select.byId(id)).filter(Boolean);
  if (!items.length) return;
  let label, previous;
  if (zone.hasAttribute('data-drop-collection')) {
    const collectionId = zone.dataset.dropCollection;
    const moving = items.filter(item => (item.collectionId || '') !== collectionId);
    if (!moving.length) return;
    await ctx.store.bulkUpdateItems(moving.map(item => ({ id: item.id, patch: { collectionId } })));
    ctx.prefs.touchCollection(collectionId);
    previous = moving.map(item => ({ id: item.id, patch: { collectionId: item.collectionId || '' } }));
    label = `Moved ${moving.length === 1 ? `“${moving[0].title || 'item'}”` : `${moving.length} items`} to ${collectionName(collectionId)}`;
  } else if (zone.hasAttribute('data-drop-tag')) {
    const tag = zone.dataset.dropTag;
    const adding = items.filter(item => !(item.tags || []).some(t => t.toLowerCase() === tag.toLowerCase()));
    if (!adding.length) return;
    await ctx.store.bulkUpdateItems(adding.map(item => ({ id: item.id, patch: { tags: [...(item.tags || []), tag] } })));
    previous = adding.map(item => ({ id: item.id, patch: { tags: item.tags || [] } }));
    label = `Tagged ${adding.length === 1 ? '1 item' : `${adding.length} items`} #${tag}`;
  } else {
    const filter = zone.dataset.dropFilter;
    const field = { favorite: 'favorite', archive: 'archived', trash: 'deletedAt' }[filter];
    if (!field) return;
    const value = field === 'deletedAt' ? new Date().toISOString() : true;
    const patch = { [field]: value };
    const changing = items.filter(item => (field === 'deletedAt' ? !item.deletedAt : !item[field]));
    if (!changing.length) return;
    await ctx.store.bulkUpdateItems(changing.map(item => ({ id: item.id, patch })));
    previous = changing.map(item => ({ id: item.id, patch: { [field]: field === 'deletedAt' ? null : false } }));
    const count = changing.length === 1 ? '1 item' : `${changing.length} items`;
    label = { favorite: `Added ${count} to Favorites`, archive: `Archived ${count}`, trash: `Moved ${count} to Trash` }[filter];
    if (filter !== 'favorite') for (const item of changing) ctx.state.selection?.delete(item.id);
  }
  ctx.toast(label, { tone: 'success', action: { label: 'Undo', run: () => ctx.store.bulkUpdateItems(previous) } });
}
