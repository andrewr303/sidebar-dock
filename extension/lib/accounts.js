// Connected accounts for dashboard integrations (GitHub, Linear, Product Hunt). Credentials live only in this device's
// extension storage (localStorage in the preview server) under their own key: never in library settings, backups,
// bridge sync or logs. Integrations register a provider so Settings > Connected accounts can render their card.

export const ACCOUNTS_KEY = 'still.accounts.v1';

const providers = new Map();
const listeners = new Set();
let queue = Promise.resolve();
let cache = null;

const area = () => globalThis.chrome?.storage?.local || null;

async function readAll() {
  if (cache) return cache;
  const local = area();
  let value = null;
  if (local) value = (await local.get(ACCOUNTS_KEY))?.[ACCOUNTS_KEY];
  else {
    try { value = JSON.parse(globalThis.localStorage?.getItem(ACCOUNTS_KEY) || 'null'); } catch { value = null; }
  }
  cache = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return cache;
}

async function writeAll(value) {
  cache = value;
  const local = area();
  if (local) await local.set({ [ACCOUNTS_KEY]: value });
  else if (globalThis.localStorage) globalThis.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(value));
  else throw new Error('Local storage is unavailable, so the account was not saved.');
}

function mutate(change) {
  const run = queue.then(async () => {
    const next = change(structuredClone(await readAll()));
    await writeAll(next);
    for (const fn of listeners) { try { fn(next); } catch (error) { console.error(error); } }
    return next;
  });
  queue = run.catch(() => {});
  return run;
}

// Another tab or the side panel changed an account: drop the cache and tell subscribers.
globalThis.chrome?.storage?.onChanged?.addListener?.((changes, areaName) => {
  if (areaName !== 'local' || !changes[ACCOUNTS_KEY]) return;
  cache = changes[ACCOUNTS_KEY].newValue || {};
  for (const fn of listeners) { try { fn(cache); } catch (error) { console.error(error); } }
});

export function validateToken(value, { label = 'token' } = {}) {
  if (typeof value !== 'string') throw new Error(`Paste the ${label} as text.`);
  const token = value.trim();
  if (!token) throw new Error(`Paste a ${label}.`);
  if (token.length > 4000 || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error(`That does not look like a ${label}. Paste it again without spaces or line breaks.`);
  return token;
}

/**
 * The stored account for a provider id, or null. Shape: { token, method: 'token'|'oauth'|'bridge'|..., login, name, avatarUrl,
 * scopes: [], meta: {}, connectedAt, updatedAt }. Only the integration that owns the id should read the token.
 */
export async function getAccount(id) {
  const entry = (await readAll())[id];
  return entry && typeof entry === 'object' ? structuredClone(entry) : null;
}

/** Account without its secret, for display. */
export async function getAccountInfo(id) {
  const entry = await getAccount(id);
  if (!entry) return null;
  const { token, refreshToken, ...rest } = entry;
  return { ...rest, connected: !!token };
}

/** Saves or merges an account. Pass token to replace the credential. */
export function saveAccount(id, patch = {}) {
  if (!id) throw new Error('Account id is required.');
  if (Object.hasOwn(patch, 'token')) patch = { ...patch, token: validateToken(patch.token) };
  const stamp = new Date().toISOString();
  return mutate(all => {
    const previous = all[id] && typeof all[id] === 'object' ? all[id] : {};
    all[id] = { ...previous, ...patch, connectedAt: previous.connectedAt || stamp, updatedAt: stamp };
    return all;
  }).then(all => structuredClone(all[id]));
}

export function removeAccount(id) {
  return mutate(all => { delete all[id]; return all; });
}

/** Subscribe to account changes (any provider). Returns an unsubscribe. */
export function onAccountsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Replaces any token in text with a placeholder before showing an error. */
export function redactToken(text, token) {
  const value = String(text ?? '');
  return token && token.length > 3 ? value.split(token).join('[token]') : value;
}

/**
 * Integrations register how Settings > Connected accounts shows them:
 * { id, name, icon, description, order, renderCard(ctx) => html fragment }. renderCard owns its actions.
 */
export function registerAccountProvider(provider) {
  if (!provider?.id || typeof provider.renderCard !== 'function') throw new Error('Account providers need an id and renderCard.');
  providers.set(provider.id, provider);
}
export const listAccountProviders = () => [...providers.values()].sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.name.localeCompare(b.name));

/** Test helper: forget the in-memory cache. */
export function resetAccountsCache() { cache = null; }
