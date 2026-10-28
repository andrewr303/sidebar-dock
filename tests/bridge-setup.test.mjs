import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetup } from '../bridge/setup.mjs';
import { createConnectionsService } from '../bridge/connections.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function workspace(t) {
  const base = await mkdtemp(join(tmpdir(), 'still-setup-'));
  t.after(async () => { const absolute = resolve(base); assert.ok(absolute.startsWith(resolve(tmpdir()) + sep)); assert.ok(basename(absolute).startsWith('still-setup-')); await rm(absolute, { recursive: true, force: true }); });
  const home = join(base, 'home'); await mkdir(home);
  return { home, configPath: join(base, 'bridge', 'config.json') };
}
function output() { let text = ''; return { stream: { write: chunk => { text += chunk; } }, text: () => text }; }
const offline = async () => { throw new Error('Bridge not running.'); };
const connectionsFor = (home, rest = {}) => createConnectionsService({ homeDir: home, projectRoot: ROOT, env: {}, platform: 'linux', resolveExecutable: async () => { throw new Error('CLI not installed in test home.'); }, ...rest });

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
  for (const argv of [[], ['vscode'], ['claude', '--force'], ['claude', 'codex']]) {
    const usage = output(), fresh = join(dirname(configPath), `unused-${argv.length}.json`);
    assert.equal(await runSetup({ argv, stdout: usage.stream, connections: connectionsFor(home), configPath: fresh, fetch: offline }), 1, argv.join(' '));
    assert.match(usage.text(), /Usage: npm run connect/);
    await assert.rejects(readFile(fresh), { code: 'ENOENT' });
  }
  assert.equal(await runSetup({ argv: ['--help'], stdout: output().stream, connections: connectionsFor(home), configPath, fetch: offline }), 0);
});
