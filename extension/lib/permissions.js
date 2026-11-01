// Optional Chrome permissions and host access, requested at the moment of use. Chrome only shows the prompt during a
// user gesture, so call request*() synchronously from a click handler, before the handler's first await.
// Outside the extension (preview server) there is nothing to grant and every check resolves true.

const api = () => globalThis.chrome?.permissions || null;

/** Origin patterns for URLs or origins: 'https://api.github.com/x' -> 'https://api.github.com/*'. Invalid entries are dropped. */
export function originPatterns(list = []) {
  const out = new Set();
  for (const value of [list].flat()) {
    const text = String(value || '').trim();
    if (!text) continue;
    if (/^https?:\/\/[^/]+\/\*$/.test(text)) { out.add(text); continue; }
    try {
      const url = new URL(text);
      if (url.protocol === 'https:' || url.protocol === 'http:') out.add(`${url.protocol}//${url.host}/*`);
    } catch { /* not a URL */ }
  }
  return [...out];
}

export async function hasOrigins(origins) {
  const p = api();
  const list = originPatterns(origins);
  if (!p?.contains || !list.length) return true;
  try { return await p.contains({ origins: list }); } catch { return false; }
}

/** Prompts for host access. Call synchronously inside the click handler; resolves true when granted. */
export function requestOrigins(origins) {
  const p = api();
  const list = originPatterns(origins);
  if (!p?.request || !list.length) return Promise.resolve(true);
  try { return Promise.resolve(p.request({ origins: list })).then(Boolean, () => false); } catch { return Promise.resolve(false); }
}

export async function hasPermissions(permissions) {
  const p = api();
  const list = [permissions].flat().filter(Boolean);
  if (!p?.contains || !list.length) return true;
  try { return await p.contains({ permissions: list }); } catch { return false; }
}

/** Prompts for optional API permissions (topSites, bookmarks, tabs). Call synchronously inside the click handler. */
export function requestPermissions(permissions) {
  const p = api();
  const list = [permissions].flat().filter(Boolean);
  if (!p?.request || !list.length) return Promise.resolve(true);
  try { return Promise.resolve(p.request({ permissions: list })).then(Boolean, () => false); } catch { return Promise.resolve(false); }
}

/** Calls fn whenever Chrome grants or removes a permission (to refresh "Allow access" states). Returns an unsubscribe. */
export function onPermissionsChanged(fn) {
  const p = api();
  if (!p?.onAdded) return () => {};
  p.onAdded.addListener(fn);
  p.onRemoved?.addListener(fn);
  return () => { p.onAdded.removeListener(fn); p.onRemoved?.removeListener(fn); };
}
