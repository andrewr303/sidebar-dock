/*
 * One small interface over the places Still keeps key/value data, so meta and snapshots work the same in the extension
 * (chrome.storage.local), the preview build (localStorage) and tests (memory):
 *   read(key) -> value | undefined        write(key, value)
 *   dump() -> { key: raw }                 load({ key: raw })        remove([keys])
 * dump/load move values exactly as stored (localStorage keeps its JSON strings untouched) so a restore is byte-for-byte.
 */
export const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
export const parseStored = value => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
};

export function chromeArea(local = globalThis.chrome?.storage?.local) {
  return {
    kind: 'chrome',
    async read(key) { return (await local.get(key))?.[key]; },
    async write(key, value) { await local.set({ [key]: value }); },
    async dump() { const all = await local.get(null); return isPlainObject(all) ? all : {}; },
    async load(values) { if (Object.keys(values).length) await local.set(values); },
    async remove(keys) { if (keys.length) await local.remove(keys); },
  };
}

export function webArea(storage = globalThis.localStorage) {
  return {
    kind: 'web',
    async read(key) { const raw = storage.getItem(key); return raw === null ? undefined : parseStored(raw); },
    async write(key, value) { storage.setItem(key, JSON.stringify(value)); },
    async dump() {
      const out = {};
      for (let index = 0; index < storage.length; index++) { const key = storage.key(index); if (key !== null) out[key] = storage.getItem(key); }
      return out;
    },
    async load(values) { for (const [key, value] of Object.entries(values)) storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); },
    async remove(keys) { for (const key of keys) storage.removeItem(key); },
  };
}

export function memoryArea(initial = {}) {
  const values = new Map(Object.entries(structuredClone(initial)));
  return {
    kind: 'memory', values,
    async read(key) { return values.has(key) ? structuredClone(values.get(key)) : undefined; },
    async write(key, value) { values.set(key, structuredClone(value)); },
    async dump() { return structuredClone(Object.fromEntries(values)); },
    async load(entries) { for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value)); },
    async remove(keys) { for (const key of keys) values.delete(key); },
  };
}

let fallback = null;
/** The area this context's stores use: chrome.storage.local, else localStorage, else one in-memory area per context. */
export function defaultArea() {
  if (globalThis.chrome?.storage?.local) return chromeArea(globalThis.chrome.storage.local);
  if (globalThis.localStorage) return webArea(globalThis.localStorage);
  return fallback ||= memoryArea();
}
