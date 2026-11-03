import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ensureClientToken, revokeClientToken, resolveConfigPath, defaultConfigPath, DEFAULT_CONFIG_PATH, LEGACY_CONFIG_PATH } from '../bridge/config.mjs';
import { authHeaders } from '../bridge/auth-header.mjs';
import { configTokens } from '../bridge/server.mjs';

const TOKEN = 'config-test-primary-token-longer-than-24';
const POSIX = process.platform !== 'win32';
async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'still-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('the default configuration lives under STILL_HOME (or ~/.still), outside the checkout', async t => {
  const home = await workspace(t);
  assert.equal(defaultConfigPath({ STILL_HOME: home }), join(home, 'bridge.json'));
  assert.match(DEFAULT_CONFIG_PATH, /bridge\.json$/);
  assert.match(LEGACY_CONFIG_PATH.replaceAll('\\', '/'), /bridge\/\.local\/config\.json$/);
  const env = { STILL_HOME: join(home, 'nested') }, legacyPath = join(home, 'missing-legacy.json');
  const created = await loadConfig(undefined, { create: true, env, legacyPath });
  assert.equal(created.path, join(home, 'nested', 'bridge.json'));
  assert.equal(created.bindAddress, '127.0.0.1');
  assert.deepEqual(created.tokens, []); assert.deepEqual(created.allowedHosts, []);
  if (POSIX) {
    assert.equal((await stat(created.path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, 'nested'))).mode & 0o777, 0o700);
  }
  assert.equal((await loadConfig(undefined, { env, legacyPath })).token, created.token);
  // STILL_BRIDGE_CONFIG still names an explicit file.
  assert.equal(await resolveConfigPath(undefined, { env: { ...env, STILL_BRIDGE_CONFIG: join(home, 'other.json') }, legacyPath }), join(home, 'other.json'));
  await assert.rejects(loadConfig(undefined, { env: { STILL_HOME: join(home, 'empty') }, legacyPath }), /npm run bridge/);
});

test('a legacy in-checkout configuration is read in place, and the bridge copies it to the per-user file', async t => {
  const home = await workspace(t);
  const legacyPath = join(home, 'legacy', 'config.json'), env = { STILL_HOME: join(home, 'user') };
  await mkdir(join(home, 'legacy'));
  await writeFile(legacyPath, JSON.stringify({ url: 'http://127.0.0.1:43999', token: TOKEN }));
  // A reader (the stdio adapter) uses the legacy file where it is and creates nothing.
  const read = await loadConfig(undefined, { env, legacyPath });
  assert.equal(read.path, legacyPath); assert.equal(read.token, TOKEN);
  assert.deepEqual(await readdir(home), ['legacy'], 'a plain read creates nothing');
  // The bridge (create) migrates it so copies of the code installed elsewhere (plugin cache, node_modules) find it.
  const migrated = await loadConfig(undefined, { create: true, env, legacyPath });
  const preferred = join(env.STILL_HOME, 'bridge.json');
  assert.equal(migrated.path, preferred); assert.equal(migrated.token, TOKEN); assert.equal(migrated.url, 'http://127.0.0.1:43999');
  if (POSIX) { assert.equal((await stat(preferred)).mode & 0o777, 0o600); assert.equal((await stat(env.STILL_HOME)).mode & 0o777, 0o700); }
  assert.equal(JSON.parse(await readFile(legacyPath, 'utf8')).token, TOKEN, 'the legacy file is left in place');
  // A copy of the code with no legacy file next to it now finds the same config.
  assert.equal((await loadConfig(undefined, { env, legacyPath: join(home, 'elsewhere', 'config.json') })).token, TOKEN);
  // Once the per-user file exists it wins and is never overwritten by the legacy file.
  await writeFile(preferred, JSON.stringify({ url: 'http://127.0.0.1:43123', token: `${TOKEN}-new` }));
  assert.equal((await loadConfig(undefined, { create: true, env, legacyPath })).token, `${TOKEN}-new`);
  // An explicit path is never migrated.
  const explicit = await loadConfig(legacyPath, { create: true, env: { STILL_HOME: join(home, 'other') }, legacyPath });
  assert.equal(explicit.path, legacyPath); assert.equal((await readdir(home)).includes('other'), false);
});

test('a client token keeps its scope when none is given, and a new one defaults to write', async t => {
  const home = await workspace(t), configPath = join(home, 'bridge.json');
  await writeFile(configPath, JSON.stringify({ url: 'http://127.0.0.1:43123', token: TOKEN }), { mode: 0o600 });
  const created = await ensureClientToken('paperclip', undefined, { configPath });
  assert.equal(created.scope, 'write'); assert.equal(created.created, true); assert.equal(created.scopeChanged, false);
  const narrowed = await ensureClientToken('paperclip', 'read', { configPath });
  assert.equal(narrowed.scopeChanged, true); assert.equal(narrowed.previousScope, 'write');
  const kept = await ensureClientToken('paperclip', undefined, { configPath });
  assert.equal(kept.scope, 'read'); assert.equal(kept.scopeChanged, false); assert.equal(kept.token, created.token);
  const rotated = await ensureClientToken('paperclip', undefined, { configPath, rotate: true });
  assert.equal(rotated.scope, 'read'); assert.equal(rotated.rotated, true); assert.notEqual(rotated.token, created.token);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).tokens[0].scope, 'read');
});

test('client tokens are created once, keep their secret, change scope in place, rotate and revoke atomically', async t => {
  const home = await workspace(t), configPath = join(home, 'bridge.json');
  await writeFile(configPath, JSON.stringify({ url: 'http://127.0.0.1:43123', token: TOKEN, futureField: { kept: true } }), { mode: 0o600 });
  const first = await ensureClientToken('paperclip', 'write', { configPath });
  assert.equal(first.created, true); assert.equal(first.scope, 'write'); assert.equal(first.path, configPath);
  assert.ok(first.token.length >= 40); assert.notEqual(first.token, TOKEN);
  const again = await ensureClientToken('paperclip', 'write', { configPath });
  assert.equal(again.created, false); assert.equal(again.token, first.token);
  const narrowed = await ensureClientToken('paperclip', 'read', { configPath });
  assert.equal(narrowed.token, first.token); assert.equal(narrowed.scope, 'read');
  const rotated = await ensureClientToken('paperclip', 'read', { configPath, rotate: true });
  assert.notEqual(rotated.token, first.token); assert.equal(rotated.created, false);
  await ensureClientToken('ci-agent', 'full', { configPath });
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(raw.futureField, { kept: true }, 'unknown fields survive');
  assert.deepEqual(raw.tokens.map(({ name, scope }) => [name, scope]), [['paperclip', 'read'], ['ci-agent', 'full']]);
  if (POSIX) assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(home)).filter(name => name.endsWith('.tmp')), [], 'no temporary files remain');
  const loaded = await loadConfig(configPath);
  assert.equal(loaded.tokens.find(entry => entry.name === 'paperclip').token, rotated.token);
  // Concurrent edits from one process do not drop each other.
  await Promise.all([ensureClientToken('one', 'read', { configPath }), ensureClientToken('two', 'write', { configPath })]);
  assert.deepEqual((await loadConfig(configPath)).tokens.map(entry => entry.name), ['paperclip', 'ci-agent', 'one', 'two']);
  assert.deepEqual(await revokeClientToken('paperclip', { configPath }).then(({ removed }) => removed), true);
  assert.equal((await revokeClientToken('paperclip', { configPath })).removed, false);
  assert.equal((await loadConfig(configPath)).tokens.some(entry => entry.name === 'paperclip'), false);
  await assert.rejects(ensureClientToken('Bad Name', 'read', { configPath }), /lowercase/);
  await assert.rejects(ensureClientToken('paperclip', 'admin', { configPath }), /read, write or full/);
});

test('the header helper prints the pairing token or a named client token and fails calmly without leaking secrets', async t => {
  const home = await workspace(t), configPath = join(home, 'bridge.json');
  await writeFile(configPath, JSON.stringify({ url: 'http://127.0.0.1:43123', token: TOKEN }));
  const load = () => loadConfig(configPath);
  assert.deepEqual(await authHeaders({ argv: [], load }), { Authorization: `Bearer ${TOKEN}` });
  const { token } = await ensureClientToken('paperclip', 'write', { configPath });
  assert.deepEqual(await authHeaders({ argv: ['--token-name', 'paperclip'], load }), { Authorization: `Bearer ${token}` });
  const missing = await authHeaders({ argv: ['--token-name=other'], load }).catch(error => error);
  assert.match(missing.message, /No client token named other/);
  assert.equal(missing.message.includes(TOKEN) || missing.message.includes(token), false);
  await assert.rejects(authHeaders({ argv: ['--verbose'], load }), /Unknown option/);
  await assert.rejects(authHeaders({ argv: [], load: () => loadConfig(join(home, 'absent.json')) }), /npm run bridge/);
});

test('configuration validation covers client tokens, extra hosts and the bind address', async t => {
  const home = await workspace(t), path = join(home, 'bridge.json');
  const check = async extra => { await writeFile(path, JSON.stringify({ url: 'http://127.0.0.1:43123', token: TOKEN, ...extra })); return loadConfig(path); };
  const good = await check({ tokens: [{ name: 'paperclip', scope: 'write', token: 'p'.repeat(32) }], allowedHosts: ['host.docker.internal', 'Still.Local', '10.0.0.5'], bindAddress: '0.0.0.0' });
  assert.deepEqual(good.tokens, [{ name: 'paperclip', scope: 'write', token: 'p'.repeat(32) }]);
  assert.deepEqual(good.allowedHosts, ['host.docker.internal', 'still.local', '10.0.0.5']);
  assert.equal(good.bindAddress, '0.0.0.0');
  for (const [extra, pattern] of [
    [{ tokens: {} }, /tokens/],
    [{ tokens: Array.from({ length: 21 }, (_, i) => ({ name: `t${i}`, scope: 'read', token: `${'x'.repeat(30)}${i}` })) }, /at most 20/],
    [{ tokens: [{ name: 'Paperclip', scope: 'read', token: 'p'.repeat(32) }] }, /lowercase name/],
    [{ tokens: [{ name: 'paperclip', scope: 'admin', token: 'p'.repeat(32) }] }, /read, write or full/],
    [{ tokens: [{ name: 'paperclip', scope: 'read', token: 'short' }] }, /at least 24/],
    [{ tokens: [{ name: 'paperclip', scope: 'read', token: `${'p'.repeat(30)}\n` }] }, /at least 24/],
    [{ tokens: [{ name: 'paperclip', scope: 'read', token: TOKEN }] }, /must differ/],
    [{ tokens: [{ name: 'a', scope: 'read', token: 'p'.repeat(32) }, { name: 'a', scope: 'read', token: 'q'.repeat(32) }] }, /listed twice/],
    [{ allowedHosts: ['evil.example/path'] }, /allowedHosts/],
    [{ allowedHosts: 'host.docker.internal' }, /allowedHosts/],
    [{ bindAddress: 'everywhere' }, /bindAddress/],
    [{ bindAddress: '' }, /bindAddress/],
  ]) await assert.rejects(check(extra), pattern, JSON.stringify(extra).slice(0, 80));
  const failure = await check({ tokens: [{ name: 'paperclip', scope: 'read', token: TOKEN }] }).catch(error => error);
  assert.equal(failure.message.includes(TOKEN), false, 'secrets never appear in errors');
});

test('revoking without a bridge config creates nothing, and a missing or invalid config drops scoped tokens', async t => {
  const home = await workspace(t), configPath = join(home, 'bridge.json');
  assert.deepEqual(await revokeClientToken('paperclip', { configPath }), { removed: false });
  assert.deepEqual(await readdir(home), [], 'no config or pairing token is created');
  await writeFile(configPath, JSON.stringify({ url: 'http://127.0.0.1:43123', token: TOKEN }));
  await ensureClientToken('paperclip', 'read', { configPath });
  const tokens = configTokens(await loadConfig(configPath));
  assert.equal((await tokens()).length, 1);
  await writeFile(configPath, '{ not json');
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.deepEqual(await tokens(), [], 'an unreadable config accepts no scoped tokens');
});
