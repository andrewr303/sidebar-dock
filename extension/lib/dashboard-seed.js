// First-run dashboard: a "Main" board built from the widget definitions and the library the person already has, laid
// out on the 12-column grid so it fills a 1440×900 new tab without scrolling. Pure: the caller passes the library and
// a getDef(type) lookup (ui/dashboard/registry.js getWidget), so tests can run it with plain objects.
import { settle, compact, collides, GRID_COLS } from '../ui/dashboard/grid.js';

const isWebUrl = url => /^https?:\/\//i.test(String(url || ''));
const live = item => item && !item.deletedAt && !item.archived;

/** Collections with the most saved web links (direct members), best first: [{ collection, count }]. */
export function linkCollections(library, limit = 3) {
  const items = (library?.items || []).filter(item => live(item) && isWebUrl(item.url) && item.type !== 'note');
  const order = new Map((library?.collections || []).map((c, i) => [c.id, i]));
  const counts = new Map();
  for (const item of items) if (item.collectionId && order.has(item.collectionId)) counts.set(item.collectionId, (counts.get(item.collectionId) || 0) + 1);
  return [...counts.entries()]
    .map(([id, count]) => ({ collection: library.collections.find(c => c.id === id), count }))
    .filter(entry => entry.count >= 2)
    .sort((a, b) => b.count - a.count || Number(!!a.collection.parentId) - Number(!!b.collection.parentId) || order.get(a.collection.id) - order.get(b.collection.id))
    .slice(0, limit);
}

/** The live note with the most unchecked tasks (for the checklist), or null. */
export function checklistNote(library) {
  let best = null;
  for (const item of library?.items || []) {
    if (!live(item) || item.type !== 'note' || item.sticky) continue;
    const open = (String(item.content || '').match(/^\s*[-*+] \[ \]/gm) || []).length;
    if (open && (!best || open > best.open)) best = { item, open };
  }
  return best?.item || null;
}

// The template: where each widget goes at 12 columns. Missing link collections leave their slots to the others.
function template(library) {
  const folders = linkCollections(library, 3);
  const note = checklistNote(library);
  const slots = [
    { type: 'clock', x: 0, y: 0, w: 3, h: 2 },
    { type: 'weather', x: 3, y: 0, w: 3, h: 2 },
    { type: 'quick-links', x: 6, y: 0, w: 6, h: 2 },
  ];
  const folderWidth = folders.length ? Math.floor(GRID_COLS / folders.length) : 0;
  folders.forEach(({ collection }, i) => slots.push({ type: 'links-folder', x: i * folderWidth, y: 2, w: folderWidth, h: 3, config: { collectionId: collection.id } }));
  const row = folders.length ? 5 : 2;
  slots.push(
    { type: 'notes', x: 0, y: row, w: 4, h: 3 },
    { type: 'checklist', x: 4, y: row, w: 4, h: 3, config: note ? { source: 'note', noteId: note.id } : {} },
    { type: 'most-visited', x: 8, y: row, w: 4, h: 2 },
    { type: 'sticky-notes', x: 8, y: row + 2, w: 4, h: 1 },
  );
  return slots;
}

let seq = 0;
const seedId = prefix => `${prefix}_${globalThis.crypto?.randomUUID?.().slice(0, 12) || `${Date.now().toString(36)}${(++seq).toString(36)}`}`;

/**
 * Builds the first-run dashboard state. getDef(type) returns a widget definition (size limits and defaults()); types
 * without a definition are skipped. Sizes are clamped to each definition's limits and the result never overlaps.
 */
export function buildSeedDashboard({ library = null, getDef = () => null } = {}) {
  const widgets = [];
  for (const slot of template(library)) {
    const def = getDef(slot.type);
    if (!def) continue;
    const size = def.size || {};
    const w = Math.max(size.minW || 1, Math.min(size.maxW || GRID_COLS, slot.w));
    const h = Math.max(size.minH || 1, Math.min(size.maxH || 40, slot.h));
    let defaults = {};
    try { defaults = def.defaults?.() || {}; } catch (error) { console.warn(`[still] ${slot.type} defaults failed`, error); }
    widgets.push({ id: seedId('w'), type: slot.type, x: slot.x, y: slot.y, w, h, title: '', style: { frame: 'default', hideTitle: false },
      config: { ...defaults, ...(slot.config || {}) } });
  }
  // Clamped sizes can collide with a neighbor's slot; settle moves those down and compact closes any gaps left behind.
  const layout = compact(settle(widgets.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }))));
  const byId = new Map(layout.map(r => [r.id, r]));
  for (const widget of widgets) Object.assign(widget, byId.get(widget.id));
  const board = { id: seedId('board'), name: 'Main', icon: 'layout-dashboard', widgets };
  return { version: 1, activeBoardId: board.id, boards: [board], prefs: {}, updatedAt: new Date().toISOString() };
}

/** True when no two widgets on any board overlap and all fit the 12 columns (used by tests and as a sanity check). */
export function isValidLayout(state) {
  return (state?.boards || []).every(board => board.widgets.every((a, i) => a.x >= 0 && a.y >= 0 && a.x + a.w <= GRID_COLS
    && board.widgets.every((b, j) => i === j || !collides(a, b))));
}
