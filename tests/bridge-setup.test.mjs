import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetup, ALIASES } from '../bridge/setup.mjs';
import { createConnectionsService, CLIENT_CATALOG } from '../bridge/connections.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function workspace(t) {
  const base = await mkdtemp(join(tmpdir(), 'still-setup-'));
  t.after(async () => { const absolute = resolve(base); assert.ok(absolute.startsWith(resolve(tmpdir()) + sep)); assert.ok(basename(absolute).startsWith('still-setup-')); await rm(absolute, { recursive: true, force: true }); });
  const home = join(base, 'home'); await mkdir(home);
  return { home, configPath: join(base, 'bridge', 'config.json') };
}
function output() { let text = ''; return { stream: { write: chunk => { text += chunk; } }, text: () => text }; }
const offline = async () => { throw new Error('Bridge not running.'); };
const connectionsFor = (home, rest = {}) => createConnectionsService({ homeDir: home, projectRoot: ROOT, env: {}, platform: 'linux', configPath: rest.configPath, resolveExecutable: async () => { throw new Error('CLI not installed in test home.'); }, ...rest });

test('connect desktop writes the Claude Desktop entry, creates the pairing token and prints the pairing steps', async t => {
  const { home, configPath } = await workspace(t), out = output();
  const code = await runSetup({ argv: ['desktop'], stdout: out.stream, connections: connectionsFor(home), configPath, fetch: offline });
  assert.equal(code, 0);
  const token = JSON.parse(await readFile(configPath, 'utf8')).token;
  assert.ok(token.length >= 32);
  const written = JSON.parse(await readFile(join(home, '.config', 'Claude', 'claude_desktop_config.json'), 'utf8'));
  assert.deepEqual(written.mcpServers.still, { command: process.execPath, args: [join(ROOT, 'bridge', 'mcp.mjs')] });
  assert.match(out.text(), /Connected\./); assert.match(out.text(), /npm run bridge/); assert.ok(out.text().includes(`Token  ${token}`)); assert.match(out.text(), /Restart Claude Desktop/);
  const again = output();
  assert.equal(await runSetup({ argv: ['desktop', '--skill'], stdout: again.stream, connections: connectionsFor(home), configPath, fetch: offline }), 0);
  assert.match(again.text(), /Already configured/); assert.match(again.text(), /does not read a personal skills folder/);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).token, token);
});

test('dry runs change nothing, CLI clients without their executable get the manual snippet, and skills install on request', async t => {
  const { home, configPath } = await workspace(t);
  const dry = output();
  assert.equal(await runSetup({ argv: ['cursor', '--dry-run', '--skill'], stdout: dry.stream, connections: connectionsFor(home), configPath, fetch: offline }), 0);
  assert.match(dry.text(), /Would merge into/); assert.match(dry.text(), /Would install the still-workspace skill/);
  await assert.rejects(readFile(join(home, '.cursor', 'mcp.json')), { code: 'ENOENT' });
  // Not even the bridge's own pairing token is written by a dry run.
  await assert.rejects(readFile(configPath), { code: 'ENOENT' }); assert.match(dry.text(), /new random token is written .* without --dry-run/);
  const manual = output();
  assert.equal(await runSetup({ argv: ['claude'], stdout: manual.stream, connections: connectionsFor(home), configPath, fetch: offline }), 2);
  assert.match(manual.text(), /Automatic setup is not possible: CLI not installed/); assert.match(manual.text(), /"mcpServers"/);
  const skill = output();
  assert.equal(await runSetup({ argv: ['codex', '--skill'], stdout: skill.stream, connections: connectionsFor(home), configPath, fetch: offline }), 2);
  assert.match(skill.text(), /Installed the still-workspace skill/);
  assert.match(await readFile(join(home, '.agents', 'skills', 'still-workspace', 'SKILL.md'), 'utf8'), /still-workspace/);
});

test('status reports the bridge, sync freshness and each client; usage errors exit non-zero without writing config', async t => {
  const { home, configPath } = await workspace(t), out = output(), requests = [];
  const fetcher = async (url, options) => { requests.push({ url, authorization: options.headers?.Authorization }); return url.endsWith('/health') ? Response.json({ name: 'still-library' }) : Response.json({ connected: true, items: 12, ageSeconds: 1 }); };
  assert.equal(await runSetup({ argv: ['status'], stdout: out.stream, connections: connectionsFor(home), configPath, fetch: fetcher }), 0);
  const token = JSON.parse(await readFile(configPath, 'utf8')).token;
  assert.deepEqual(requests.map(request => new URL(request.url).pathname), ['/health', '/status']); assert.equal(requests[1].authorization, `Bearer ${token}`);
  assert.match(out.text(), /running/); assert.match(out.text(), /connected, 12 items/); assert.match(out.text(), /Claude Desktop\s+not configured/);
  for (const argv of [[], ['notepad'], ['claude', '--force'], ['claude', 'codex'], ['cursor', '--scope', 'read'], ['paperclip', '--scope', 'admin'], ['paperclip', '--skill'], ['cursor', '--http']]) {
    const usage = output(), fresh = join(dirname(configPath), `unused-${argv.join('-')}.json`);
    assert.equal(await runSetup({ argv, stdout: usage.stream, connections: connectionsFor(home), configPath: fresh, fetch: offline }), 1, argv.join(' '));
    assert.match(usage.text(), /Usage: npm run connect/);
    await assert.rejects(readFile(fresh), { code: 'ENOENT' });
  }
  assert.equal(await runSetup({ argv: ['--help'], stdout: output().stream, connections: connectionsFor(home), configPath, fetch: offline }), 0);
});

test('aliases come from the catalog and new automatic clients connect through setup', async t => {
  const { home, configPath } = await workspace(t);
  for (const client of CLIENT_CATALOG) assert.equal(ALIASES[client.id], client.id);
  assert.equal(ALIASES['claude-code'], 'claude'); assert.equal(ALIASES.code, 'claude'); assert.equal(ALIASES.desktop, 'claude-desktop'); assert.equal(ALIASES.droid, 'factory'); assert.equal(ALIASES.lmstudio, 'lm-studio');
  const usage = output(); await runSetup({ argv: ['--help'], stdout: usage.stream, configPath, fetch: offline, connections: connectionsFor(home) });
  for (const client of CLIENT_CATALOG) assert.ok(usage.text().includes(client.id), client.id);
  const out = output();
  assert.equal(await runSetup({ argv: ['droid', '--skill'], stdout: out.stream, connections: connectionsFor(home), configPath, fetch: offline }), 0);
  assert.deepEqual(JSON.parse(await readFile(join(home, '.factory', 'mcp.json'), 'utf8')).mcpServers.still, { type: 'stdio', command: process.execPath, args: [join(ROOT, 'bridge', 'mcp.mjs')] });
  assert.match(out.text(), /Installed the still-workspace skill/); assert.match(out.text(), /Restart Factory Droid/);
  const dry = output();
  assert.equal(await runSetup({ argv: ['vscode', '--dry-run'], stdout: dry.stream, connections: connectionsFor(home), configPath, fetch: offline }), 0);
  assert.match(dry.text(), /"servers"/); await assert.rejects(readFile(join(home, '.config', 'Code', 'User', 'mcp.json')), { code: 'ENOENT' });
  const manual = output();
  assert.equal(await runSetup({ argv: ['goose'], stdout: manual.stream, connections: connectionsFor(home), configPath, fetch: offline }), 2);
  assert.match(manual.text(), /extensions:/);
});

test('paperclip target prints URL, scoped token, paste config, instructions and steps; dry run and revoke behave', async t => {
  const { home, configPath } = await workspace(t);
  const dry = output();
  assert.equal(await runSetup({ argv: ['paperclip', '--dry-run', '--scope', 'read'], stdout: dry.stream, connections: connectionsFor(home, { configPath }), configPath, fetch: offline }), 0);
  await assert.rejects(readFile(configPath), { code: 'ENOENT' });
  assert.match(dry.text(), /Scope   read/); assert.match(dry.text(), /<run npm run connect -- paperclip>/); assert.match(dry.text(), /Connect your own MCP server/);

  const out = output();
  assert.equal(await runSetup({ argv: ['paperclip'], stdout: out.stream, connections: connectionsFor(home, { configPath }), configPath, fetch: offline }), 0);
  const stored = JSON.parse(await readFile(configPath, 'utf8')), scoped = stored.tokens.find(entry => entry.name === 'paperclip');
  assert.equal(scoped.scope, 'write'); assert.ok(out.text().includes(`Token   ${scoped.token}  (new)`)); assert.equal(out.text().includes(stored.token), false, 'the primary token is not printed for Paperclip');
  assert.match(out.text(), /URL     http:\/\/127\.0\.0\.1:43123\/mcp/); assert.ok(out.text().includes(`"Authorization": "Bearer ${scoped.token}"`));
  assert.match(out.text(), /Advanced → Paste a config/); assert.match(out.text(), /Access profiles/); assert.match(out.text(), /Read-only, Everyday work or Full access/); assert.match(out.text(), /untrusted/);

  const again = output();
  await runSetup({ argv: ['paperclip', '--scope=full'], stdout: again.stream, connections: connectionsFor(home, { configPath }), configPath, fetch: offline });
  assert.ok(again.text().includes(`Token   ${scoped.token}  (existing; use --rotate for a new one)`)); assert.match(again.text(), /Scope   full/);
  assert.match(again.text(), /Scope   full  \(changed from write\)/);
  assert.ok(out.text().includes(`Authorization value for Paperclip's field: Bearer ${scoped.token}`));
  const rotated = output();
  await runSetup({ argv: ['paperclip', '--rotate'], stdout: rotated.stream, connections: connectionsFor(home, { configPath }), configPath, fetch: offline });
  assert.equal(rotated.text().includes(scoped.token), false);
  assert.match(rotated.text(), /Scope   full\n/, '--rotate without --scope keeps the scope');
  assert.match(rotated.text(), /\(rotated; paste the new value into Paperclip\)/);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).tokens[0].scope, 'full');

  const revoke = output();
  assert.equal(await runSetup({ argv: ['paperclip', '--revoke'], stdout: revoke.stream, connections: connectionsFor(home, { configPath }), configPath, fetch: offline }), 0);
  assert.match(revoke.text(), /Revoked the Paperclip token/); assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).tokens, []);
  const none = output();
  await runSetup({ argv: ['paperclip', '--revoke'], stdout: none.stream, connections: connectionsFor(home, { configPath }), configPath, fetch: offline });
  assert.match(none.text(), /No Paperclip token existed/);
  assert.equal(await runSetup({ argv: ['paperclip', '--rotate', '--revoke'], stdout: output().stream, connections: connectionsFor(home, { configPath }), configPath, fetch: offline }), 1);
});

test('--http prints the direct HTTP alternative for Claude Code and Codex without writing anything', async t => {
  const { home, configPath } = await workspace(t);
  const claude = output();
  assert.equal(await runSetup({ argv: ['claude', '--http'], stdout: claude.stream, connections: connectionsFor(home), configPath, fetch: offline }), 0);
  assert.match(claude.text(), /claude mcp add-json --scope user still/); assert.match(claude.text(), /headersHelper/); assert.match(claude.text(), /auth-header\.mjs/);
  const codex = output();
  assert.equal(await runSetup({ argv: ['codex', '--http'], stdout: codex.stream, connections: connectionsFor(home), configPath, fetch: offline }), 0);
  assert.match(codex.text(), /bearer_token_env_var = "STILL_BRIDGE_TOKEN"/);
  await assert.rejects(readFile(configPath), { code: 'ENOENT' }); await assert.rejects(readFile(join(home, '.claude.json')), { code: 'ENOENT' });
});

test('setup runs when launched through a symlinked bin path', { skip: process.platform === 'win32' }, async t => {
  const { home, configPath } = await workspace(t), link = join(dirname(configPath), 'still-connect');
  await mkdir(dirname(link), { recursive: true }); await symlink(join(ROOT, 'bridge', 'setup.mjs'), link);
  const { stdout } = await promisify(execFile)(process.execPath, [link, '--help'], { env: { ...process.env, HOME: home, STILL_HOME: join(home, '.still') } });
  assert.match(stdout, /Usage: npm run connect/);
  assert.equal(await realpath(link), join(ROOT, 'bridge', 'setup.mjs'));
});
