// Last-fetched results for dashboard widgets (weather, GitHub, Linear, Product Hunt...), kept in extension storage so a
// new tab paints immediately and refreshes in the background. Values must be plain JSON and never contain credentials.
//
// Storage: chrome.storage.local['still.widget-cache.v1'] = { "<key>": { value, at } } (localStorage in the preview).
// Several tabs share it: each view keeps a copy in memory, merges what other views save (newest `at` wins) and merges
// again before writing, so one tab never wipes another tab's fresher entries.

export const WIDGET_CACHE_KEY = 'still.widget-cache.v1';
const MAX_ENTRIES = 120;

let memory = {};
let loaded = false;
let loading = null;
let timer = 0;
const deleted = new Set();
const listeners = new Set();

const area = () => globalThis.chrome?.storage?.local || null;
const isEntry = entry => !!entry && typeof entry === 'object' && 'value' in entry && Number.isFinite(entry.at);

/**
 * Merges stored entries into a cache object: an incoming entry wins when it is newer (or the key is missing), keys in
 * `removed` stay removed, and the result keeps at most `max` entries (oldest dropped). Returns the keys that changed.
 */
export function mergeCacheEntries(target, incoming, { removed = new Set(), max = MAX_ENTRIES } = {}) {
  const changed = [];
  if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
    for (const [key, entry] of Object.entries(incoming)) {
      if (!isEntry(entry) || removed.has(key) || key === '__proto__') continue;
      if (!isEntry(target[key]) || entry.at > target[key].at) { target[key] = entry; changed.push(key); }
    }
  }
  const keys = Object.keys(target);
  if (keys.length > max) for (const key of keys.sort((a, b) => (target[a]?.at || 0) - (target[b]?.at || 0)).slice(0, keys.length - max)) delete target[key];
  return changed;
}

async function readStored() {
  const local = area();
  if (local) return (await local.get(WIDGET_CACHE_KEY))?.[WIDGET_CACHE_KEY] || null;
  return JSON.parse(globalThis.localStorage?.getItem(WIDGET_CACHE_KEY) || 'null');
}

export async function loadWidgetCache() {
  if (loaded) return memory;
  loading ||= (async () => {
    try { mergeCacheEntries(memory, await readStored()); } catch { /* an unreadable cache is just empty */ }
    loaded = true;
    followOtherViews();
    return memory;
  })();
  return loading;
}

/** { value, at } for a key, or null. `at` is the epoch ms when it was written. */
export function readCache(key) {
  const entry = memory[key];
  return isEntry(entry) ? entry : null;
}

/** True when the entry is missing or older than maxAgeMs. */
export function isStale(key, maxAgeMs) {
  const entry = readCache(key);
  return !entry || Date.now() - entry.at > maxAgeMs;
}

export function writeCache(key, value) {
  memory[key] = { value, at: Date.now() };
  deleted.delete(key);
  schedulePersist();
  return memory[key];
}

/** Removes a key and every key under it ("github" also removes "github:prs:…"). */
export function deleteCache(prefix) {
  for (const key of Object.keys(memory)) {
    if (key === prefix || key.startsWith(`${prefix}:`)) { delete memory[key]; deleted.add(key); }
  }
  schedulePersist();
}

/** Calls fn(changedKeys) when another view saves newer entries. Returns an unsubscribe function. */
export function onWidgetCacheChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function schedulePersist() {
  clearTimeout(timer);
  timer = setTimeout(persist, 400);
}

async function persist() {
  try {
    // Pick up what other views saved meanwhile so their newer entries survive this write.
    mergeCacheEntries(memory, await readStored().catch(() => null), { removed: deleted });
    const local = area();
    if (local) await local.set({ [WIDGET_CACHE_KEY]: memory });
    else globalThis.localStorage?.setItem(WIDGET_CACHE_KEY, JSON.stringify(memory));
    deleted.clear();
  } catch (error) { console.warn('[still] widget cache not saved', error); }
}

let following = false;
function followOtherViews() {
  if (following) return;
  following = true;
  const adopt = next => {
    const changed = mergeCacheEntries(memory, next, { removed: deleted });
    if (!changed.length) return;
    for (const fn of listeners) { try { fn(changed); } catch (error) { console.error(error); } }
  };
  if (area()) {
    globalThis.chrome.storage.onChanged?.addListener((changes, name) => {
      if (name === 'local' && changes[WIDGET_CACHE_KEY]?.newValue) adopt(changes[WIDGET_CACHE_KEY].newValue);
    });
  } else {
    globalThis.addEventListener?.('storage', event => {
      if (event.key !== WIDGET_CACHE_KEY || !event.newValue) return;
      try { adopt(JSON.parse(event.newValue)); } catch { /* ignore malformed */ }
    });
  }
}
