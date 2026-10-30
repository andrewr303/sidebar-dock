// Last-fetched results for dashboard widgets (weather, GitHub, Linear, Product Hunt...), kept in extension storage so a
// new tab paints immediately and refreshes in the background. Values must be plain JSON and never contain credentials.

export const WIDGET_CACHE_KEY = 'still.widget-cache.v1';
const MAX_ENTRIES = 120;

let memory = {};
let loaded = false;
let timer = 0;

const area = () => globalThis.chrome?.storage?.local || null;

export async function loadWidgetCache() {
  if (loaded) return memory;
  try {
    const local = area();
    const value = local ? (await local.get(WIDGET_CACHE_KEY))?.[WIDGET_CACHE_KEY]
      : JSON.parse(globalThis.localStorage?.getItem(WIDGET_CACHE_KEY) || 'null');
    memory = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { memory = {}; }
  loaded = true;
  return memory;
}

/** { value, at } for a key, or null. `at` is the epoch ms when it was written. */
export function readCache(key) {
  const entry = memory[key];
  return entry && typeof entry === 'object' && 'value' in entry ? entry : null;
}

/** True when the entry is missing or older than maxAgeMs. */
export function isStale(key, maxAgeMs) {
  const entry = readCache(key);
  return !entry || Date.now() - entry.at > maxAgeMs;
}

export function writeCache(key, value) {
  memory[key] = { value, at: Date.now() };
  schedulePersist();
  return memory[key];
}

export function deleteCache(prefix) {
  for (const key of Object.keys(memory)) if (key === prefix || key.startsWith(`${prefix}:`)) delete memory[key];
  schedulePersist();
}

function schedulePersist() {
  clearTimeout(timer);
  timer = setTimeout(persist, 400);
}

async function persist() {
  const keys = Object.keys(memory);
  if (keys.length > MAX_ENTRIES) {
    for (const key of keys.sort((a, b) => memory[a].at - memory[b].at).slice(0, keys.length - MAX_ENTRIES)) delete memory[key];
  }
  try {
    const local = area();
    if (local) await local.set({ [WIDGET_CACHE_KEY]: memory });
    else globalThis.localStorage?.setItem(WIDGET_CACHE_KEY, JSON.stringify(memory));
  } catch (error) { console.warn('[still] widget cache not saved', error); }
}
