import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnectionsService, CLIENT_CATALOG } from '../bridge/connections.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function temporary(t) {
  const base = await mkdtemp(join(tmpdir(), 'still-connections-'));
  t.after(async () => { const absolute = resolve(base); assert.ok(absolute.startsWith(resolve(tmpdir()) + sep)); assert.ok(basename(absolute).startsWith('still-connections-')); await rm(absolute, { recursive: true, force: true }); });
  const home = join(base, 'home'); await mkdir(home); return { base, home };
}
const absent = async () => { throw new Error('CLI not installed in test home.'); };
const service = (homeDir, rest = {}) => createConnectionsService({ homeDir, projectRoot: ROOT, env: {}, resolveExecutable: absent, ...rest });
async function put(home, path, value) { const target = join(home, ...path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, value); return target; }
function fakeSpawn(handler, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options }); const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { child.emit('close', 1); return true; };
    Promise.resolve().then(async () => { try { const code = await handler({ command, args, options, child }); child.emit('close', code ?? 0); } catch (failure) { child.emit('error', failure); } }); return child;
  };
}

test('connection discovery and preview are read-only, token-free and distinguish configuration from runtime connection', async t => {
  const { home } = await temporary(t), calls = [];
  const config = await put(home, ['.cursor', 'mcp.json'], JSON.stringify({ secret: 'private-existing-token', mcpServers: { other: { command: 'keep', env: { TOKEN: 'private-other' } } } }));
  const before = await readFile(config, 'utf8');
  const connections = service(home, { spawn: (...args) => calls.push(args) });
  const list = await connections.listConnections(); assert.equal(list.length, CLIENT_CATALOG.length);
  assert.deepEqual(CLIENT_CATALOG.map(client => client.id), ['codex', 'claude', 'opencode', 'cursor', 'gemini', 'claude-desktop', 'vscode', 'copilot', 'kiro', 'factory', 'windsurf', 'devin', 'qwen', 'zed', 'goose', 'amp', 'crush', 'lm-studio', 'paperclip']);
  assert.equal(list.find(c => c.id === 'codex').configurationStatus, 'manual');
  assert.equal(list.find(c => c.id === 'cursor').runtimeConnected, false);
  const preview = await connections.previewConnection('cursor'); assert.equal(preview.canConnect, true); assert.equal(preview.backupRequired, true);
  assert.equal(preview.previewHash, preview.configHash); assert.equal(preview.target, config); assert.equal(preview.restartRequired, true);
  assert.equal(JSON.stringify(preview).includes('private-existing-token'), false); assert.equal(JSON.stringify(preview).includes('private-other'), false);
  assert.equal(await readFile(config, 'utf8'), before); assert.equal(calls.length, 0);
  assert.equal((await readdir(home)).includes('.still'), false);
  await assert.rejects(connections.previewConnection('../arbitrary'), /supported client/);
});

test('JSON client connection requires a fresh preview, preserves unrelated entries and exact backups, and safely disconnects', async t => {
  const { home } = await temporary(t), connections = service(home);
  const original = '{\n  "theme": "matte",\n  "mcpServers": { "other": { "command": "keep", "env": {"TOKEN":"private"} } }\n}\n';
  const path = await put(home, ['.cursor', 'mcp.json'], original);
  await assert.rejects(connections.connectClient('cursor', {}), /no preview/);
  const stale = await connections.previewConnection('cursor');
  await writeFile(path, original.replace('matte', 'glass'));
  await assert.rejects(connections.connectClient('cursor', { expectedHash: stale.previewHash }), /configuration changed/);
  const preview = await connections.previewConnection('cursor'), applied = await connections.connectClient('cursor', { expectedHash: preview.previewHash });
  assert.equal(applied.configured, true); assert.equal(applied.runtimeConnected, false); assert.equal(applied.restartRequired, true);
  assert.equal(await readFile(applied.backupPath, 'utf8'), original.replace('matte', 'glass'));
  const next = JSON.parse(await readFile(path, 'utf8')); assert.equal(next.theme, 'glass'); assert.equal(next.mcpServers.other.env.TOKEN, 'private');
  assert.equal(next.mcpServers.still.command, process.execPath); assert.deepEqual(next.mcpServers.still.args, [join(ROOT, 'bridge', 'mcp.mjs')]);
  const record = JSON.parse(await readFile(applied.receiptPath, 'utf8')); assert.equal(record.action, 'connect'); assert.equal('document' in record, false);
  const exact = await connections.previewConnection('cursor');
  assert.equal((await connections.connectClient('cursor', { expectedHash: exact.previewHash })).unchanged, true);
  const removed = await connections.disconnectClient('cursor', { expectedHash: exact.previewHash }); assert.equal(removed.configured, false);
  const restored = JSON.parse(await readFile(path, 'utf8')); assert.equal(restored.mcpServers.still, undefined); assert.equal(restored.mcpServers.other.env.TOKEN, 'private'); assert.equal(restored.theme, 'glass');
});

test('OpenCode and Gemini configuration use their documented local MCP schemas without arbitrary commands', async t => {
  const { home } = await temporary(t), connections = service(home);
  const openPath = await put(home, ['.config', 'opencode', 'opencode.json'], '{"model":"keep-provider/model","mcp":{"existing":{"type":"remote","url":"https://example.com/mcp"}}}');
  const geminiPath = await put(home, ['.gemini', 'settings.json'], '{"general":{"theme":"keep"},"mcpServers":{"existing":{"command":"keep"}}}');
  for (const id of ['opencode', 'gemini']) { const preview = await connections.previewConnection(id); await connections.connectClient(id, { expectedConfigHash: preview.configHash }); }
  const open = JSON.parse(await readFile(openPath, 'utf8')); assert.equal(open.model, 'keep-provider/model'); assert.equal(open.mcp.existing.url, 'https://example.com/mcp'); assert.deepEqual(open.mcp.still.command, [process.execPath, join(ROOT, 'bridge', 'mcp.mjs')]); assert.equal(open.mcp.still.type, 'local'); assert.equal(open.mcp.still.enabled, true);
  const gemini = JSON.parse(await readFile(geminiPath, 'utf8')); assert.equal(gemini.general.theme, 'keep'); assert.equal(gemini.mcpServers.existing.command, 'keep'); assert.equal(gemini.mcpServers.still.command, process.execPath);
});

test('Codex and Claude registration invoke only allowlisted native MCP commands with hidden windows and preserve existing user configuration', async t => {
  const { home } = await temporary(t), calls = [];
  const codexPath = await put(home, ['.codex', 'config.toml'], 'model = "selected-model"\n\n[mcp_servers.other]\ncommand = "keep"\nargs = []\n');
  const claudePath = await put(home, ['.claude.json'], '{"projects":{"keep":{}},"mcpServers":{"other":{"command":"keep"}}}');
  const spawn = fakeSpawn(async ({ command, args, options }) => {
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.equal(options.env.USERPROFILE, home); assert.equal(args[0], 'mcp'); assert.equal(args[1], 'add');
    const marker = args.indexOf('--'); assert.ok(marker > 1); assert.equal(args[marker + 1], process.execPath); assert.equal(args[marker + 2], join(ROOT, 'bridge', 'mcp.mjs'));
    if (command.endsWith('codex.exe')) { assert.equal(options.env.CODEX_HOME, join(home, '.codex')); await writeFile(codexPath, (await readFile(codexPath, 'utf8')) + `\n[mcp_servers.still]\ncommand = ${JSON.stringify(args[marker + 1])}\nargs = [${JSON.stringify(args[marker + 2])}]\n`); }
    else { assert.deepEqual(args.slice(0, 7), ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'still']); const data = JSON.parse(await readFile(claudePath, 'utf8')); data.mcpServers.still = { type: 'stdio', command: args[marker + 1], args: [args[marker + 2]] }; await writeFile(claudePath, JSON.stringify(data)); }
  }, calls);
  const connections = service(home, { spawn, resolveExecutable: async id => ({ command: `C:/trusted/${id}.exe`, prefix: [], launchMode: 'native' }) });
  for (const id of ['codex', 'claude']) { const preview = await connections.previewConnection(id); assert.equal(preview.canConnect, true); const result = await connections.connectClient(id, { expectedHash: preview.previewHash }); assert.ok(result.backupPath); assert.equal((await connections.previewConnection(id)).configured, true); }
  assert.equal(calls.length, 2); assert.match(await readFile(codexPath, 'utf8'), /selected-model/); assert.match(await readFile(codexPath, 'utf8'), /mcp_servers.other/);
  assert.ok(JSON.parse(await readFile(claudePath, 'utf8')).projects.keep);
  const codexPreview = await connections.previewConnection('codex'); await connections.connectClient('codex', { expectedHash: codexPreview.previewHash }); assert.equal(calls.length, 2);
});

test('foreign entries, malformed/commented configurations and custom overrides remain untouched with manual guidance', async t => {
  const { home } = await temporary(t), connections = service(home);
  for (const foreign of [{ command: 'someone-elses-server', args: [] }, false, null]) {
    const raw = JSON.stringify({ mcpServers: { still: foreign, other: { command: 'keep' } } }); const path = await put(home, ['.cursor', 'mcp.json'], raw);
    const preview = await connections.previewConnection('cursor'); assert.equal(preview.conflict, true); assert.equal(preview.canConnect, false);
    await assert.rejects(connections.connectClient('cursor', { expectedHash: preview.previewHash }), /existing still entry/); assert.equal(await readFile(path, 'utf8'), raw);
  }
  const bad = await put(home, ['.gemini', 'settings.json'], '{ // custom comment\n "mcpServers": {}\n}');
  const preview = await connections.previewConnection('gemini'); assert.equal(preview.configurationStatus, 'manual'); assert.equal(preview.canConnect, false); assert.match(preview.reason, /strict JSON/);
  assert.match(await readFile(bad, 'utf8'), /custom comment/);
  await writeFile(bad, '{"mcpServers":{"first":{"command":"keep"}},"mcpServers":{}}');
  assert.match((await connections.previewConnection('gemini')).reason, /duplicate JSON keys/);
  await put(home, ['.config', 'opencode', 'opencode.jsonc'], '{ // keep comments\n}');
  assert.match((await connections.previewConnection('opencode')).reason, /JSONC/);
  const override = service(home, { env: { CODEX_HOME: join(home, 'custom') }, resolveExecutable: async () => ({ command: 'trusted', prefix: [] }) });
  assert.match((await override.previewConnection('codex')).reason, /CODEX_HOME/);
});

test('failed CLI commands retain an exact backup and receipt without falsely reporting configured or leaking tokens', async t => {
  const { home } = await temporary(t), calls = [], raw = '{"mcpServers":{"other":{"command":"keep"}}}';
  const path = await put(home, ['.claude.json'], raw);
  const connections = service(home, { resolveExecutable: async () => ({ command: 'trusted', prefix: [] }), spawn: fakeSpawn(async ({ child }) => { child.stderr.write('Authorization: Bearer private-long-token-value'); return 1; }, calls) });
  const preview = await connections.previewConnection('claude');
  let captured;
  await assert.rejects(connections.connectClient('claude', { expectedHash: preview.previewHash }), failure => {
    assert.equal(failure.code, 'CLI_FAILED'); assert.equal(failure.message.includes('private-long-token-value'), false);
    captured = failure; return true;
  });
  assert.equal(await readFile(captured.backupPath, 'utf8'), raw); assert.equal(JSON.parse(await readFile(captured.receiptPath, 'utf8')).action, 'connect_failed');
  assert.equal(await readFile(path, 'utf8'), raw); assert.equal(calls.length, 1);
});

test('explicit skill install copies only its own portable files, is repeatable, and preserves differing local skills', async t => {
  const { home } = await temporary(t), connections = service(home);
  await put(home, ['.agents', 'skills', 'unrelated', 'SKILL.md'], 'Keep this existing skill.');
  const result = await connections.installSkills('codex'); assert.equal(result.installed, true); assert.equal(result.unchanged, false);
  assert.equal(await readFile(join(result.skillPath, 'SKILL.md'), 'utf8'), await readFile(join(ROOT, 'agent-skills', 'still-workspace', 'SKILL.md'), 'utf8'));
  assert.match(await readFile(join(result.skillPath, 'references', 'workflows.md'), 'utf8'), /File upload\/replacement is unavailable/);
  assert.equal((await connections.installSkills('codex')).unchanged, true);
  assert.equal((await connections.previewConnection('codex')).skillInstalled, true);
  await writeFile(join(result.skillPath, 'SKILL.md'), 'User customized skill.');
  await assert.rejects(connections.installSkills('codex'), /existing still-workspace skill differs/);
  assert.equal(await readFile(join(result.skillPath, 'SKILL.md'), 'utf8'), 'User customized skill.');
  assert.equal(await readFile(join(home, '.agents', 'skills', 'unrelated', 'SKILL.md'), 'utf8'), 'Keep this existing skill.');
  await assert.rejects(readFile(join(home, '.codex', 'config.toml')), { code: 'ENOENT' });
});

test('symlinked client targets are refused instead of writing through another configuration location', async t => {
  const { home, base } = await temporary(t), elsewhere = join(base, 'elsewhere'); await mkdir(elsewhere);
  try { await symlink(elsewhere, join(home, '.cursor'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (failure) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(failure.code)) { t.skip('Host does not permit test symlinks.'); return; } throw failure; }
  const connections = service(home), preview = await connections.previewConnection('cursor'); assert.equal(preview.canConnect, false); assert.match(preview.reason, /symbolic link/);
  await assert.rejects(connections.connectClient('cursor', { expectedHash: preview.previewHash }), /no preview|symbolic link/); assert.deepEqual(await readdir(elsewhere), []);
});

test('Claude Desktop merges a type-less stdio entry into its per-platform config and declines skill installs cleanly', async t => {
  const { home } = await temporary(t);
  const linux = service(home, { platform: 'linux' });
  const path = await put(home, ['.config', 'Claude', 'claude_desktop_config.json'], '{"preferences":{"keep":true},"mcpServers":{"other":{"command":"keep"}}}');
  const preview = await linux.previewConnection('claude-desktop');
  assert.equal(preview.configPath, path); assert.equal(preview.canConnect, true); assert.equal(preview.skillPath, null); assert.equal(preview.skillSupported, false); assert.deepEqual(preview.commands, []);
  assert.deepEqual(JSON.parse(preview.configSnippet).mcpServers.still, { command: process.execPath, args: [join(ROOT, 'bridge', 'mcp.mjs')] });
  const applied = await linux.connectClient('claude-desktop', { expectedHash: preview.previewHash });
  assert.equal(applied.configured, true); assert.ok(applied.backupPath);
  const written = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(written.mcpServers.still, { command: process.execPath, args: [join(ROOT, 'bridge', 'mcp.mjs')] }); assert.equal(written.preferences.keep, true); assert.equal(written.mcpServers.other.command, 'keep');
  assert.equal((await linux.previewConnection('claude-desktop')).configurationStatus, 'configured');
  await assert.rejects(linux.installSkills('claude-desktop'), error => error.code === 'SKILL_UNSUPPORTED');
  assert.equal((await service(home, { platform: 'darwin' }).previewConnection('claude-desktop')).configPath, join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  assert.equal((await service(home, { platform: 'win32' }).previewConnection('claude-desktop')).configPath, join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  assert.equal((await service(home, { platform: 'win32', env: { APPDATA: join(home, 'Roaming') } }).previewConnection('claude-desktop')).configPath, join(home, 'Roaming', 'Claude', 'claude_desktop_config.json'));
  const outside = await service(home, { platform: 'win32', env: { APPDATA: join(dirname(home), 'elsewhere') } }).previewConnection('claude-desktop');
  assert.equal(outside.configurationStatus, 'manual'); assert.equal(outside.canConnect, false);
});

test('catalog entries declare their config key, entry builder and matcher, and keep the original clients byte-identical', () => {
  const node = '/usr/bin/node', mcp = '/still/bridge/mcp.mjs';
  for (const client of CLIENT_CATALOG) {
    assert.ok(client.docs.startsWith('https://'), client.id); assert.ok(['native-cli', 'json-merge', 'manual', 'paperclip'].includes(client.mode), client.id);
    if (client.mode === 'json-merge' || client.mode === 'native-cli') { assert.equal(typeof client.key, 'string'); assert.equal(typeof client.entry, 'function'); assert.equal(typeof client.matches, 'function'); assert.equal(client.matches(client.entry(node, mcp), client.entry(node, mcp)), true, client.id); }
    if (client.mode === 'manual') { assert.equal(typeof client.snippet, 'function'); assert.ok(client.reason); }
  }
  const by = id => CLIENT_CATALOG.find(client => client.id === id);
  assert.deepEqual(by('opencode').entry(node, mcp), { type: 'local', command: [node, mcp], enabled: true }); assert.equal(by('opencode').key, 'mcp');
  assert.deepEqual(by('cursor').entry(node, mcp), { type: 'stdio', command: node, args: [mcp] }); assert.deepEqual(by('claude').entry(node, mcp), { type: 'stdio', command: node, args: [mcp] });
  for (const id of ['gemini', 'claude-desktop', 'kiro', 'windsurf', 'devin', 'qwen']) assert.deepEqual(by(id).entry(node, mcp), { command: node, args: [mcp] }, id);
  assert.deepEqual(by('vscode').entry(node, mcp), { type: 'stdio', command: node, args: [mcp] }); assert.equal(by('vscode').key, 'servers');
  assert.deepEqual(by('copilot').entry(node, mcp), { type: 'local', command: node, args: [mcp], tools: ['*'] });
  assert.deepEqual(by('factory').entry(node, mcp), { type: 'stdio', command: node, args: [mcp] });
  assert.equal(by('cursor').matches({ type: 'sse', command: node, args: [mcp] }, by('cursor').entry(node, mcp)), false);
  assert.equal(by('gemini').matches({ command: node, args: [mcp], env: { A: '1' } }, by('gemini').entry(node, mcp)), false);
});

const NEW_JSON_CLIENTS = [
  { id: 'vscode', path: ['.config', 'Code', 'User', 'mcp.json'], key: 'servers', entry: { type: 'stdio' }, skill: null },
  { id: 'copilot', path: ['.copilot', 'mcp-config.json'], key: 'mcpServers', entry: { type: 'local', tools: ['*'] }, skill: ['.copilot', 'skills'] },
  { id: 'kiro', path: ['.kiro', 'settings', 'mcp.json'], key: 'mcpServers', entry: {}, skill: ['.kiro', 'skills'] },
  { id: 'factory', path: ['.factory', 'mcp.json'], key: 'mcpServers', entry: { type: 'stdio' }, skill: ['.factory', 'skills'] },
  { id: 'windsurf', path: ['.codeium', 'windsurf', 'mcp_config.json'], key: 'mcpServers', entry: {}, skill: null },
  { id: 'devin', path: ['.config', 'devin', 'mcp_config.json'], key: 'mcpServers', entry: {}, skill: null },
  { id: 'qwen', path: ['.qwen', 'settings.json'], key: 'mcpServers', entry: {}, skill: null },
];

test('new JSON clients write their documented entry shape, preserve foreign entries, and report conflicts', async t => {
  const { home } = await temporary(t), connections = service(home, { platform: 'linux' }), mcp = join(ROOT, 'bridge', 'mcp.mjs');
  for (const spec of NEW_JSON_CLIENTS) {
    const fresh = await connections.previewConnection(spec.id);
    assert.equal(fresh.configPath, join(home, ...spec.path), spec.id); assert.equal(fresh.canConnect, true, spec.id); assert.equal(fresh.configurationStatus, 'not_configured');
    assert.equal(fresh.skillSupported, !!spec.skill, spec.id); assert.equal(fresh.skillPath, spec.skill ? join(home, ...spec.skill, 'still-workspace') : null);
    const expected = { ...spec.entry, command: process.execPath, args: [mcp] };
    assert.deepEqual(JSON.parse(fresh.configSnippet)[spec.key].still, expected, spec.id);
    const path = await put(home, spec.path, JSON.stringify({ keep: { nested: true }, [spec.key]: { other: { command: 'keep', env: { TOKEN: 'private' } } } }));
    const preview = await connections.previewConnection(spec.id); assert.equal(preview.backupRequired, true);
    const applied = await connections.connectClient(spec.id, { expectedHash: preview.previewHash }); assert.equal(applied.configured, true, spec.id); assert.ok(applied.backupPath);
    const written = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(written[spec.key].still, expected, spec.id); assert.equal(written[spec.key].other.env.TOKEN, 'private'); assert.equal(written.keep.nested, true);
    assert.equal((await connections.previewConnection(spec.id)).configurationStatus, 'configured', spec.id);
    const done = await connections.previewConnection(spec.id); await connections.disconnectClient(spec.id, { expectedHash: done.previewHash });
    assert.equal(JSON.parse(await readFile(path, 'utf8'))[spec.key].still, undefined);
    const foreign = JSON.stringify({ [spec.key]: { still: { command: 'someone-else', args: [] } } }); await writeFile(path, foreign);
    const conflict = await connections.previewConnection(spec.id); assert.equal(conflict.conflict, true, spec.id); assert.equal(conflict.canConnect, false);
    await assert.rejects(connections.connectClient(spec.id, { expectedHash: conflict.previewHash }), /existing still entry/); assert.equal(await readFile(path, 'utf8'), foreign);
    await writeFile(path, '{ // JSONC\n}'); assert.match((await connections.previewConnection(spec.id)).reason, /strict JSON/);
  }
  // Disabled entries are not reported as configured.
  await put(home, ['.kiro', 'settings', 'mcp.json'], JSON.stringify({ mcpServers: { still: { command: process.execPath, args: [mcp], disabled: true } } }));
  assert.equal((await connections.previewConnection('kiro')).conflict, true);
  // Copilot honours an explicit COPILOT_HOME by refusing to guess.
  assert.match((await service(home, { env: { COPILOT_HOME: join(home, 'custom') } }).previewConnection('copilot')).reason, /COPILOT_HOME/);
  assert.equal((await service(home, { platform: 'darwin' }).previewConnection('vscode')).configPath, join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'));
  assert.equal((await service(home, { platform: 'win32' }).previewConnection('vscode')).configPath, join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json'));
  const skill = await connections.installSkills('factory'); assert.equal(skill.skillPath, join(home, '.factory', 'skills', 'still-workspace'));
  await assert.rejects(connections.installSkills('vscode'), error => error.code === 'SKILL_UNSUPPORTED');
});

test('manual-only clients return a copyable snippet and never write', async t => {
  const { home } = await temporary(t), connections = service(home, { platform: 'linux' }), mcp = join(ROOT, 'bridge', 'mcp.mjs');
  const zedPath = await put(home, ['.config', 'zed', 'settings.json'], '{ // mine\n "theme": "One" }');
  for (const id of ['zed', 'goose', 'amp', 'crush', 'lm-studio']) {
    const preview = await connections.previewConnection(id);
    assert.equal(preview.mode, 'manual'); assert.equal(preview.canConnect, false, id); assert.equal(preview.configurationStatus, 'manual'); assert.ok(preview.reason, id); assert.ok(preview.configSnippet.includes(mcp), id);
    assert.equal(preview.skillSupported, false); assert.deepEqual(preview.commands, []);
    await assert.rejects(connections.connectClient(id, { expectedHash: preview.previewHash }), error => error.code === 'MANUAL_SETUP_REQUIRED');
  }
  const zed = await connections.previewConnection('zed'); assert.equal(zed.installed, true); assert.equal(zed.configPath, zedPath);
  assert.deepEqual(JSON.parse(zed.configSnippet).context_servers.still, { command: process.execPath, args: [mcp], env: {} });
  assert.deepEqual(JSON.parse((await connections.previewConnection('amp')).configSnippet)['amp.mcpServers'].still, { command: process.execPath, args: [mcp] });
  assert.deepEqual(JSON.parse((await connections.previewConnection('lm-studio')).configSnippet).mcpServers.still, { command: process.execPath, args: [mcp] });
  const goose = (await connections.previewConnection('goose')).configSnippet;
  assert.match(goose, /^extensions:\n  still:\n/); assert.match(goose, /type: stdio/); assert.ok(goose.includes(`cmd: ${JSON.stringify(process.execPath)}`)); assert.ok(goose.includes(`- ${JSON.stringify(mcp)}`));
  assert.match((await connections.previewConnection('crush')).configSnippet, /^mcp add still --command /);
  assert.equal(await readFile(zedPath, 'utf8'), '{ // mine\n "theme": "One" }');
  assert.deepEqual((await readdir(home)).sort(), ['.config']);
});
