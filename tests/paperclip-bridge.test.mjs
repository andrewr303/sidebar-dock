import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnectionsService, CLIENT_CATALOG, PAPERCLIP_AGENT_INSTRUCTIONS, PAPERCLIP_TOKEN_PLACEHOLDER } from '../bridge/connections.mjs';
import * as bridgeConfig from '../bridge/config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function workspace(t) {
  const base = await mkdtemp(join(tmpdir(), 'still-paperclip-'));
  t.after(async () => { const absolute = resolve(base); assert.ok(absolute.startsWith(resolve(tmpdir()) + sep)); assert.ok(basename(absolute).startsWith('still-paperclip-')); await rm(absolute, { recursive: true, force: true }); });
  const home = join(base, 'home'); await mkdir(home);
  return { base, home, configPath: join(base, 'still', 'bridge.json') };
}
const service = (home, configPath, rest = {}) => createConnectionsService({ homeDir: home, projectRoot: ROOT, env: {}, platform: 'linux', configPath, resolveExecutable: async () => { throw new Error('CLI not installed in test home.'); }, ...rest });
const exists = path => access(path).then(() => true, () => false);

test('Paperclip setup creates a scoped token, is idempotent, rotates on request, and revokes', async t => {
  const { home, configPath } = await workspace(t), connections = service(home, configPath);
  const first = await connections.paperclipSetup();
  assert.equal(first.clientId, 'paperclip'); assert.equal(first.name, 'Paperclip'); assert.equal(first.tokenName, 'paperclip'); assert.equal(first.scope, 'write'); assert.equal(first.created, true);
  assert.equal(first.url, 'http://127.0.0.1:43123/mcp'); assert.ok(first.token.length >= 24); assert.equal(resolve(first.configPath), resolve(configPath));
  const stored = JSON.parse(await readFile(configPath, 'utf8'));
  assert.notEqual(stored.token, first.token); assert.deepEqual(stored.tokens, [{ name: 'paperclip', scope: 'write', token: first.token }]);
  if (process.platform !== 'win32') assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  const paste = JSON.parse(first.pasteConfig);
  assert.deepEqual(paste, { mcpServers: { still: { type: 'http', url: first.url, headers: { Authorization: `Bearer ${first.token}` } } } });
  assert.ok(first.agentInstructions.length <= 2000); assert.equal(first.agentInstructions, PAPERCLIP_AGENT_INSTRUCTIONS);
  assert.match(first.agentInstructions, /search_library/); assert.match(first.agentInstructions, /untrusted/); assert.match(first.agentInstructions, /get_operation/); assert.match(first.agentInstructions, /Still view/);
  assert.ok(first.steps.some(step => /Connect your own MCP server/.test(step))); assert.ok(first.steps.some(step => /Paste a config/.test(step))); assert.ok(first.steps.some(step => /Read-only, Everyday work or Full access/.test(step)));
  assert.ok(first.notes.some(note => /local_trusted/.test(note))); assert.ok(first.notes.some(note => /host\.docker\.internal:43123/.test(note)));
  assert.equal(first.notes.join(' ').includes(first.token), false); assert.equal(first.steps.join(' ').includes(first.token), false);

  assert.equal(first.authorizationHeader, `Bearer ${first.token}`);
  assert.ok(first.steps.some(step => /Authorization field: paste exactly "Bearer <token>"/.test(step)), 'the steps say Paperclip asks for the header value again, with Bearer');
  assert.equal(first.scopeChanged, false);

  const again = await connections.paperclipSetup({ scope: 'read' });
  assert.equal(again.token, first.token); assert.equal(again.created, false); assert.equal(again.scope, 'read');
  assert.equal(again.scopeChanged, true); assert.equal(again.previousScope, 'write'); assert.ok(again.notes.some(note => /Access changed from "write" to "read"/.test(note)));
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).tokens[0].scope, 'read');
  // Running setup again without a scope (Settings reloaded, or the CLI without --scope) never changes the token's access.
  const reopened = await connections.paperclipSetup({});
  assert.equal(reopened.token, first.token); assert.equal(reopened.scope, 'read'); assert.equal(reopened.scopeChanged, false);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).tokens[0].scope, 'read');
  assert.equal((await connections.paperclipSetup({ dryRun: true })).scope, 'read', 'a dry run reports the current scope');
  const rotated = await connections.paperclipSetup({ scope: 'full', rotate: true });
  assert.notEqual(rotated.token, first.token); assert.equal(rotated.scope, 'full');
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).token, stored.token, 'the primary token is never rotated');

  await assert.rejects(connections.paperclipSetup({ scope: 'admin' }), error => error.code === 'INVALID_SCOPE' && /read, write or full/.test(error.message));
  assert.deepEqual(await connections.paperclipRevoke(), { removed: true });
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).tokens, []);
  assert.deepEqual(await connections.paperclipRevoke(), { removed: false });
});

test('Paperclip dry runs and previews never create a token or the bridge config', async t => {
  const { home, configPath } = await workspace(t), connections = service(home, configPath);
  const dry = await connections.paperclipSetup({ scope: 'read', dryRun: true });
  assert.equal(dry.token, null); assert.equal(dry.dryRun, true); assert.equal(dry.scope, 'read');
  assert.equal(JSON.parse(dry.pasteConfig).mcpServers.still.headers.Authorization, `Bearer ${PAPERCLIP_TOKEN_PLACEHOLDER}`);
  assert.equal(await exists(configPath), false);
  const preview = await connections.previewConnection('paperclip');
  assert.equal(preview.canConnect, false); assert.equal(preview.configurationStatus, 'manual'); assert.match(preview.reason, /Connect Paperclip/);
  assert.equal(JSON.parse(preview.configSnippet).mcpServers.still.headers.Authorization, `Bearer ${PAPERCLIP_TOKEN_PLACEHOLDER}`);
  assert.equal(await exists(configPath), false);
  const listed = (await connections.listConnections()).find(client => client.id === 'paperclip');
  assert.equal(listed.configurationStatus, 'manual'); assert.match(listed.reason, /Connect Paperclip/);
  await assert.rejects(connections.connectClient('paperclip', { expectedHash: preview.previewHash }), error => error.code === 'USE_PAPERCLIP_SETUP');
  await assert.rejects(connections.disconnectClient('paperclip', {}), error => error.code === 'USE_PAPERCLIP_SETUP');
  await assert.rejects(connections.installSkills('paperclip'), error => error.code === 'SKILL_UNSUPPORTED');
  assert.deepEqual(CLIENT_CATALOG.find(client => client.id === 'paperclip'), { id: 'paperclip', name: 'Paperclip', mode: 'paperclip', config: null, skill: null, docs: 'https://docs.paperclip.ing' });
});

test('Paperclip preview and setup never leak an existing token and honour a configured bridge URL and Docker hosts', async t => {
  const { home, configPath } = await workspace(t);
  await mkdir(dirname(configPath), { recursive: true });
  const primary = 'primary-private-token-value-0123456789';
  await writeFile(configPath, JSON.stringify({ url: 'http://127.0.0.1:45555', token: primary, allowedHosts: ['host.docker.internal'], keepMe: true }), { mode: 0o600 });
  const connections = service(home, configPath);
  const preview = await connections.previewConnection('paperclip');
  assert.equal(JSON.parse(preview.configSnippet).mcpServers.still.url, 'http://127.0.0.1:45555/mcp'); assert.equal(JSON.stringify(preview).includes(primary), false);
  const setup = await connections.paperclipSetup();
  assert.equal(setup.url, 'http://127.0.0.1:45555/mcp'); assert.equal(JSON.stringify(setup).includes(primary), false);
  assert.ok(setup.notes.some(note => /allowedHosts host\.docker\.internal/.test(note)));
  const stored = JSON.parse(await readFile(configPath, 'utf8')); assert.equal(stored.keepMe, true); assert.equal(stored.token, primary);
});

test('an injected token store is used so the service works against the C1 contract', async t => {
  const { home } = await workspace(t), calls = [];
  const tokens = {
    loadConfig: async (path, options) => { calls.push(['load', path, options]); return { url: 'http://127.0.0.1:43123', path: '/fake/bridge.json' }; },
    ensureClientToken: async (name, scope, options) => { calls.push(['ensure', name, scope, options]); return { name, scope, token: 'x'.repeat(43), created: true, path: '/fake/bridge.json' }; },
    revokeClientToken: async (name, options) => { calls.push(['revoke', name, options]); return { removed: true }; },
  };
  const connections = service(home, '/fake/bridge.json', { tokens });
  const setup = await connections.paperclipSetup({ scope: 'full', rotate: true });
  assert.equal(setup.token, 'x'.repeat(43)); assert.equal(setup.scope, 'full');
  assert.deepEqual(calls[1], ['ensure', 'paperclip', 'full', { configPath: '/fake/bridge.json', rotate: true }]);
  assert.deepEqual(await connections.paperclipRevoke(), { removed: true }); assert.deepEqual(calls.at(-1), ['revoke', 'paperclip', { configPath: '/fake/bridge.json' }]);
  assert.equal(typeof bridgeConfig.ensureClientToken, 'function'); assert.equal(typeof bridgeConfig.revokeClientToken, 'function');
});

test('Claude Code plugin manifest and marketplace parse and reference existing paths; package bin and files cover the bridge', async () => {
  const plugin = JSON.parse(await readFile(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert.equal(plugin.name, 'still'); assert.equal(plugin.version, manifest.version); assert.equal(plugin.author.name, 'Still'); assert.ok(plugin.description);
  assert.deepEqual(plugin.mcpServers.still, { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bridge/mcp.mjs'] });
  assert.ok(await exists(join(ROOT, 'bridge', 'mcp.mjs')));
  assert.ok(plugin.skills.startsWith('./')); assert.ok(await exists(join(ROOT, plugin.skills, 'still-workspace', 'SKILL.md')));
  assert.equal(await exists(join(ROOT, '.mcp.json')), false, 'no root .mcp.json: contributors should not be auto-prompted');
  const market = JSON.parse(await readFile(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.ok(/^[a-z][a-z0-9-]*$/.test(market.name)); assert.ok(market.owner.name);
  const entry = market.plugins.find(item => item.name === plugin.name); assert.ok(entry); assert.equal(entry.source, './');
  assert.ok(await exists(join(ROOT, entry.source, '.claude-plugin', 'plugin.json')));

  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true); assert.equal(pkg.scripts.mcp, 'node bridge/mcp.mjs'); assert.equal(pkg.scripts.connect, 'node bridge/setup.mjs');
  assert.deepEqual(Object.keys(pkg.bin).sort(), ['still-auth-header', 'still-bridge', 'still-connect', 'still-mcp']);
  for (const target of ['bridge/mcp.mjs', 'bridge/server.mjs', 'bridge/setup.mjs']) assert.ok(await exists(join(ROOT, target)), target);
  assert.match(await readFile(join(ROOT, 'bridge', 'setup.mjs'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
  // Every file outside bridge/ that the bridge imports (transitively) must ship in the package.
  const seen = new Set(), outside = new Set();
  async function walk(file) {
    if (seen.has(file)) return; seen.add(file);
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const target = resolve(dirname(file), match[1] || match[2]);
      if (!target.startsWith(join(ROOT, 'bridge') + sep)) outside.add(target.slice(ROOT.length + 1).split(sep).join('/'));
      if (await exists(target)) await walk(target);
    }
  }
  for (const entry of ['mcp.mjs', 'server.mjs', 'setup.mjs']) await walk(join(ROOT, 'bridge', entry));
  for (const file of outside) assert.ok(pkg.files.some(pattern => !pattern.startsWith('!') && (pattern.endsWith('/') ? file.startsWith(pattern) : file === pattern)), `package.json files must include ${file}`);
});
