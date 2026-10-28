// API keys for direct provider connections. They live only in this device's extension storage (localStorage in the
// preview server), keyed by connection id. Nothing here returns the whole map, and keys never reach library settings,
// backups, bridge sync or logs.

export const SECRETS_KEY = 'still.ai.secrets.v1';

let queue = Promise.resolve();

function area() { return globalThis.chrome?.storage?.local || null; }

async function readAll() {
  const local = area();
  if (local) {
    const value = (await local.get(SECRETS_KEY))?.[SECRETS_KEY];
    return value && typeof value === 'object' ? value : {};
  }
  const raw = globalThis.localStorage?.getItem(SECRETS_KEY);
  if (!raw) return {};
  try { const value = JSON.parse(raw); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}

async function writeAll(value) {
  const local = area();
  if (local) await local.set({ [SECRETS_KEY]: value });
  else if (globalThis.localStorage) globalThis.localStorage.setItem(SECRETS_KEY, JSON.stringify(value));
  else throw new Error('Secure local storage is unavailable, so the key was not saved.');
}

function mutate(change) {
  const run = queue.then(async () => { const all = await readAll(); const next = change({ ...all }); await writeAll(next); });
  queue = run.catch(() => {});
  return run;
}

export function validateApiKey(value) {
  if (typeof value !== 'string') throw new Error('Paste the API key as text.');
  const key = value.trim();
  if (!key) throw new Error('Paste an API key.');
  if (key.length > 4000 || /[\s\x00-\x1f\x7f]/.test(key)) throw new Error('That does not look like an API key. Paste it again without spaces or line breaks.');
  return key;
}

export async function getApiKey(connectionId) {
  const entry = (await readAll())[connectionId];
  return typeof entry?.apiKey === 'string' ? entry.apiKey : '';
}

export async function hasApiKey(connectionId) { return !!(await getApiKey(connectionId)); }

export async function connectionIdsWithKeys() {
  return Object.entries(await readAll()).filter(([, entry]) => typeof entry?.apiKey === 'string' && entry.apiKey).map(([id]) => id);
}

/** Last four characters of a long key, for a masked "••••WXYZ" label; '' for short keys, which four characters would mostly reveal. */
export function keyHint(apiKey) {
  return typeof apiKey === 'string' && apiKey.length >= 16 ? apiKey.slice(-4) : '';
}

/** connection id -> keyHint, for keys long enough to show one. */
export async function keyHints() {
  return new Map(Object.entries(await readAll()).map(([id, entry]) => [id, keyHint(entry?.apiKey)]).filter(([, hint]) => hint));
}

export function setApiKey(connectionId, apiKey) {
  const key = validateApiKey(apiKey);
  return mutate(all => ({ ...all, [connectionId]: { apiKey: key, updatedAt: new Date().toISOString() } }));
}

export function deleteApiKey(connectionId) {
  return mutate(all => { delete all[connectionId]; return all; });
}

const PATTERNS = [
  [/\bsk-(?:ant-|proj-|or-|svcacct-)?[A-Za-z0-9_-]{12,}/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[redacted]'],
  [/\bxai-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\bgsk_[A-Za-z0-9]{16,}/g, '[redacted]'],
  [/\bpplx-[A-Za-z0-9]{16,}/g, '[redacted]'],
  [/\bpa-[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi, '$1[redacted]'],
  [/((?:x-api-key|x-goog-api-key|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]{6,}/gi, '$1[redacted]'],
];

// Removes the given secrets (raw and URL-encoded) and anything shaped like a provider key from a message.
export function redactSecrets(text, secrets = []) {
  let result = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 6) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) result = result.split(form).join('[redacted]');
  }
  for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

export function redactError(error, secrets = []) {
  if (!error || typeof error !== 'object') return new Error(redactSecrets(error, secrets));
  try { error.message = redactSecrets(error.message, secrets); } catch {}
  if (typeof error.detail === 'string') error.detail = redactSecrets(error.detail, secrets);
  if (error.stack) { try { error.stack = redactSecrets(error.stack, secrets); } catch {} }
  return error;
}
