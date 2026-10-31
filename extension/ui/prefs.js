// Device-local UI preferences (expanded collections, panel widths, recent collections). Never synced or backed up.
const KEY = 'still.ui.v1';
const storage = () => { try { return globalThis.localStorage || null; } catch { return null; } };
let cache = null;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(storage()?.getItem(KEY) || '{}') || {}; } catch { cache = {}; }
  return cache;
}
function persist() { try { storage()?.setItem(KEY, JSON.stringify(cache)); } catch {} }

export const prefs = {
  all: () => load(),
  get: (key, fallback) => (key in load() ? load()[key] : fallback),
  set(key, value) { load()[key] = value; persist(); return value; },
  toggleInList(key, value, on) {
    const list = new Set(prefs.get(key, []));
    if (on ?? !list.has(value)) list.add(value); else list.delete(value);
    return prefs.set(key, [...list]);
  },
  /** Moves a collection id to the front of the recent list (used by quick add and the context menu order). */
  touchCollection(id) {
    if (!id) return;
    const recent = prefs.set('recentCollections', [id, ...prefs.get('recentCollections', []).filter(x => x !== id)].slice(0, 12));
    // The service worker cannot read localStorage; it orders the "Save page to" menu from this copy.
    try { globalThis.chrome?.storage?.local?.set({ 'still.ui.recent.v1': { recentCollections: recent } }); } catch {}
  },
};

// The appearance snapshot (ui/appearance.js appearanceSnapshot) is cached here so theme-boot.js can paint the right skin,
// mode, scales and wallpaper before the library loads. Written only when it changes.
const APPEARANCE_KEY = 'still.appearance.v1';
export function cacheAppearance(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  try {
    const text = JSON.stringify(snapshot);
    if (storage()?.getItem(APPEARANCE_KEY) !== text) storage()?.setItem(APPEARANCE_KEY, text);
  } catch {}
}
/** The cached snapshot (may be an older { theme, accent, density } record, or {}). */
export function cachedAppearance() {
  try { return JSON.parse(storage()?.getItem(APPEARANCE_KEY) || '{}') || {}; } catch { return {}; }
}
