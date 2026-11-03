// Bridge configuration: the per-user file (~/.still/bridge.json, or $STILL_HOME/bridge.json) holding the bridge URL, the
// primary pairing token and optional scoped client tokens, extra Host names and the bind address. The file is private
// (mode 0600) and its secrets are never logged or placed in error messages.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, unlink, access } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * Where the configuration lived before it moved out of the checkout. It is read in place when it is the only one, and the
 * bridge (loadConfig with create) copies it to the per-user file so copies of the code installed elsewhere find it too.
 */
export const LEGACY_CONFIG_PATH = fileURLToPath(new URL('./.local/config.json', import.meta.url));
export function defaultConfigPath(env = process.env) { return join(env.STILL_HOME || join(homedir(), '.still'), 'bridge.json'); }
export const DEFAULT_CONFIG_PATH = defaultConfigPath();
export const TOKEN_SCOPES = Object.freeze(['read', 'write', 'full']);
const TOKEN_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const validToken = value => typeof value === 'string' && value.length >= 24 && !/[\r\n]/.test(value);

/**
 * Resolve which file to use: an explicit path or STILL_BRIDGE_CONFIG wins; otherwise the per-user default when it exists,
 * else the legacy in-checkout file when it exists, else the per-user default (which loadConfig may create).
 */
export async function resolveConfigPath(path, { env = process.env, legacyPath = LEGACY_CONFIG_PATH } = {}) {
  if (path) return resolve(path);
  if (env.STILL_BRIDGE_CONFIG) return resolve(env.STILL_BRIDGE_CONFIG);
  const preferred = defaultConfigPath(env);
  if (await exists(preferred)) return preferred;
  if (legacyPath && await exists(legacyPath)) return resolve(legacyPath);
  return preferred;
}

function validate(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The bridge configuration is unreadable.');
  let url;
  try { url = new URL(value.url); } catch { throw new Error('Bridge configuration must use http://127.0.0.1 with an optional port.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Bridge configuration must use http://127.0.0.1 with an optional port.');
  if (!validToken(value.token)) throw new Error('Bridge configuration needs a valid random token.');
  // Optional hardening: list Chrome extension IDs to accept only those extension origins.
  const extensionIds = value.extensionIds ?? [];
  if (!Array.isArray(extensionIds) || extensionIds.length > 20 || extensionIds.some(id => typeof id !== 'string' || !/^[a-p]{32}$/.test(id))) throw new Error('Bridge configuration extensionIds must list Chrome extension IDs (32 letters a-p).');
  // Optional scoped tokens for MCP clients such as Paperclip: read, write (no destructive tools) or full.
  const tokens = value.tokens ?? [];
  if (!Array.isArray(tokens) || tokens.length > 20) throw new Error('Bridge configuration tokens must be a list of at most 20 client tokens.');
  const names = new Set(), secrets = new Set([value.token]);
  for (const entry of tokens) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !TOKEN_NAME.test(entry.name)) throw new Error('Each bridge client token needs a lowercase name such as "paperclip".');
    if (!TOKEN_SCOPES.includes(entry.scope)) throw new Error(`Bridge client token "${entry.name}" needs a scope of read, write or full.`);
    if (!validToken(entry.token)) throw new Error(`Bridge client token "${entry.name}" must be at least 24 characters on one line.`);
    if (names.has(entry.name)) throw new Error(`Bridge client token "${entry.name}" is listed twice.`);
    if (secrets.has(entry.token)) throw new Error(`Bridge client token "${entry.name}" must differ from the pairing token and other client tokens.`);
    names.add(entry.name); secrets.add(entry.token);
  }
  // Optional extra Host header names, for example host.docker.internal when Paperclip runs in a container.
  const allowedHosts = value.allowedHosts ?? [];
  if (!Array.isArray(allowedHosts) || allowedHosts.length > 20 || allowedHosts.some(host => typeof host !== 'string' || !(HOSTNAME.test(host) || isIP(host.replace(/^\[|\]$/g, ''))))) throw new Error('Bridge configuration allowedHosts must list at most 20 host names.');
  // Loopback by default; any other address is an explicit opt-in that exposes the bridge beyond this computer.
  const bindAddress = value.bindAddress ?? '127.0.0.1';
  if (typeof bindAddress !== 'string' || !isIP(bindAddress)) throw new Error('Bridge configuration bindAddress must be an IP address such as 127.0.0.1.');
  return { url: url.origin, token: value.token, path: resolve(path), extensionIds, tokens: tokens.map(({ name, scope, token }) => ({ name, scope, token })),
    allowedHosts: allowedHosts.map(host => host.replace(/^\[|\]$/g, '').toLowerCase()), bindAddress };
}

export async function loadConfig(path, { create = false, env = process.env, legacyPath = LEGACY_CONFIG_PATH } = {}) {
  const target = await resolveConfigPath(path, { env, legacyPath });
  // Migrate: the legacy file is resolved relative to this copy of the code, so a plugin or npm copy never sees it. The
  // bridge copies it to the per-user default (left in place, never overwritten) so every client agrees on one file.
  if (create && !path && !env.STILL_BRIDGE_CONFIG && legacyPath && target === resolve(legacyPath)) {
    let legacy;
    try { legacy = JSON.parse(await readFile(target, 'utf8')); } catch { throw new Error('The bridge configuration is unreadable.'); }
    validate(legacy, target);
    const preferred = defaultConfigPath(env);
    await mkdir(dirname(preferred), { recursive: true, mode: 0o700 });
    try { await writeFile(preferred, `${JSON.stringify(legacy, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (failure) { if (failure.code !== 'EEXIST') throw failure; legacy = JSON.parse(await readFile(preferred, 'utf8')); }
    return validate(legacy, preferred);
  }
  let value;
  try { value = JSON.parse(await readFile(target, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) throw new Error(error.code === 'ENOENT' ? 'Start the Still bridge (npm run bridge) first to create its local configuration.' : 'The bridge configuration is unreadable.');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    value = { url: 'http://127.0.0.1:43123', token: randomBytes(32).toString('base64url') };
    try { await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (failure) { if (failure.code !== 'EEXIST') throw failure; value = JSON.parse(await readFile(target, 'utf8')); }
  }
  return validate(value, target);
}

// Token edits from this process are serialized per file so two quick requests cannot drop each other's change.
const locks = new Map();
async function editConfig(configPath, change, { create = true } = {}) {
  const path = (await loadConfig(configPath, { create })).path;
  const previous = locks.get(path) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const value = JSON.parse(await readFile(path, 'utf8'));
    validate(value, path);
    const result = change(value);
    if (result.write) {
      validate(value, path);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
      catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    }
    return { ...result.value, path };
  });
  locks.set(path, run);
  try { return await run; } finally { if (locks.get(path) === run) locks.delete(path); }
}

/**
 * Create (or return) a named client token. scope undefined keeps an existing token's scope (a new token gets 'write');
 * a given scope replaces it, and scopeChanged/previousScope report that. rotate=true replaces its secret. Unknown fields are kept.
 */
export async function ensureClientToken(name, scope, { configPath, rotate = false } = {}) {
  if (typeof name !== 'string' || !TOKEN_NAME.test(name)) throw new Error('Client token names use lowercase letters, digits and hyphens.');
  if (scope !== undefined && !TOKEN_SCOPES.includes(scope)) throw new Error('Choose a client token scope of read, write or full.');
  return editConfig(configPath, value => {
    const tokens = Array.isArray(value.tokens) ? value.tokens : (value.tokens = []);
    const existing = tokens.find(entry => entry?.name === name);
    const previousScope = existing ? existing.scope : null, nextScope = scope ?? previousScope ?? 'write';
    const scopeChanged = !!existing && previousScope !== nextScope;
    if (existing && !rotate) {
      existing.scope = nextScope;
      return { write: scopeChanged, value: { name, scope: nextScope, token: existing.token, created: false, rotated: false, scopeChanged, previousScope } };
    }
    const token = randomBytes(32).toString('base64url');
    if (existing) Object.assign(existing, { scope: nextScope, token }); else tokens.push({ name, scope: nextScope, token });
    return { write: true, value: { name, scope: nextScope, token, created: !existing, rotated: !!existing, scopeChanged, previousScope } };
  });
}

/** Remove a named client token. Requests using it stop working once the bridge rereads the file. */
export async function revokeClientToken(name, { configPath } = {}) {
  // Nothing to revoke without a config: never create one (and a new pairing token) just to report that.
  try { await loadConfig(configPath); } catch (error) { if (/npm run bridge/.test(error.message)) return { removed: false }; throw error; }
  return editConfig(configPath, value => {
    const tokens = Array.isArray(value.tokens) ? value.tokens : [];
    const kept = tokens.filter(entry => entry?.name !== name);
    if (kept.length === tokens.length) return { write: false, value: { removed: false } };
    value.tokens = kept;
    return { write: true, value: { removed: true } };
  }, { create: false });
}
