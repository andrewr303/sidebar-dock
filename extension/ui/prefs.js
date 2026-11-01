// Device-local UI preferences (expanded collections, panel widths, recent collections). Never synced or backed up.
// Every open view (tabs, side panel) shares the one localStorage record, so writes re-read it first and another view's
// keys are never overwritten with this view's stale copy.
const KEY = 'still.ui.v1';
const RECENT_KEY = 'still.ui.recent.v1';
const storage = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
let cache = null;

// The stored record, or null when localStorage cannot be read (then this view's in-memory copy is all there is).
function read() {
  const area = storage();
  if (!area) return null;
  let raw;
  try { raw = area.getItem(KEY); } catch { return null; }
  try { const value = JSON.parse(raw || '{}'); return isRecord(value) ? value : {}; } catch { return {}; }
}
function load() { return cache ||= read() || {}; }
function fresh() { const value = read(); if (value) cache = value; return load(); }
function persist() { try { storage()?.setItem(KEY, JSON.stringify(cache)); } catch {} }

// Another tab changed a preference: read it again on next use.
try { globalThis.addEventListener?.('storage', event => { if (event.key === KEY || event.key === null) cache = null; }); } catch {}

export const prefs = {
  all: () => load(),
  get: (key, fallback) => (key in load() ? load()[key] : fallback),
  set(key, value) { fresh()[key] = value; persist(); return value; },
  toggleInList(key, value, on) {
    const current = fresh()[key];
    const list = new Set(Array.isArray(current) ? current : []);
    if (on ?? !list.has(value)) list.add(value); else list.delete(value);
    return prefs.set(key, [...list]);
  },
  /** Moves a collection id to the front of the recent list (used by quick add and the context menu order). */
  touchCollection(id) {
    if (!id) return;
    const current = fresh().recentCollections;
    const recent = prefs.set('recentCollections', [id, ...(Array.isArray(current) ? current : []).filter(x => x !== id)].slice(0, 12));
    // The service worker cannot read localStorage; it orders the "Save page to" menu from this copy. Other fields in that
    // record are kept.
    try {
      const local = globalThis.chrome?.storage?.local;
      if (!local?.set) return;
      Promise.resolve(typeof local.get === 'function' ? local.get(RECENT_KEY) : null)
        .then(stored => local.set({ [RECENT_KEY]: { ...(isRecord(stored?.[RECENT_KEY]) ? stored[RECENT_KEY] : {}), recentCollections: recent } }))
        .catch(() => {});
    } catch {}
  },
};

// Asks the browser once per page to treat this extension's storage as persistent, so it is not evicted under storage
// pressure. Extensions are not prompted; a refusal or a missing API is ignored. Resolves to whether storage is persistent.
let durable = null;
export function requestDurableStorage() {
  durable ||= (async () => {
    try {
      const api = globalThis.navigator?.storage;
      if (typeof api?.persist !== 'function') return false;
      if (typeof api.persisted === 'function' && await api.persisted()) return true;
      return !!(await api.persist());
    } catch { return false; }
  })();
  return durable;
}
requestDurableStorage();

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
