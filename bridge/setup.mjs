import { pathToFileURL, fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig as loadBridgeConfig, DEFAULT_CONFIG_PATH } from './config.mjs';
import { createConnectionsService } from './connections.mjs';

const ALIASES = { claude: 'claude', 'claude-code': 'claude', code: 'claude', codex: 'codex', desktop: 'claude-desktop', 'claude-desktop': 'claude-desktop', cursor: 'cursor', opencode: 'opencode', gemini: 'gemini' };
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const USAGE = `Connect an MCP client to your Still library.

Usage: npm run connect -- <client|status> [--skill] [--dry-run]
       node bridge/setup.mjs <client|status> [--skill] [--dry-run]

Clients:  claude (Claude Code), codex, desktop (Claude Desktop), cursor, opencode, gemini
status    Show whether the bridge is running, whether Still is syncing, and each client's setup.
--skill   Also install the still-workspace agent skill for that client.
--dry-run Show what would change without writing anything.
`;

export async function runSetup({ argv = [], stdout = process.stdout, connections, loadConfig = loadBridgeConfig, configPath, fetch: fetcher = globalThis.fetch } = {}) {
  const print = (line = '') => stdout.write(`${line}\n`);
  const flags = new Set(argv.filter(value => value.startsWith('--')));
  const words = argv.filter(value => !value.startsWith('--'));
  const unknownFlag = [...flags].find(flag => !['--skill', '--dry-run', '--help'].includes(flag));
  if (!words.length || flags.has('--help') || words[0] === 'help') { print(USAGE); return words.length || flags.has('--help') ? 0 : 1; }
  const target = words[0].toLowerCase();
  if (unknownFlag || words.length > 1 || (target !== 'status' && !ALIASES[target])) { print(`${unknownFlag ? `Unknown option ${unknownFlag}.` : `Unknown client "${words.join(' ')}".`}\n`); print(USAGE); return 1; }
  // The bridge config (URL + pairing token) is created on first use so pairing steps can be printed right away;
  // a dry run writes nothing, so it only describes the token a real run would create.
  const dryRun = flags.has('--dry-run') && target !== 'status';
  const path = configPath || process.env.STILL_BRIDGE_CONFIG || DEFAULT_CONFIG_PATH;
  const config = dryRun && !(await access(path).then(() => true, () => false))
    ? { url: 'http://127.0.0.1:43123', token: null, path: resolve(path) }
    : await loadConfig(path, { create: !dryRun });
  connections ||= createConnectionsService();

  if (target === 'status') {
    let running = false, sync = null;
    try { running = (await fetcher(`${config.url}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch {}
    if (running) try { const response = await fetcher(`${config.url}/status`, { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(1500) }); if (response.ok) sync = await response.json(); } catch {}
    print(`Bridge     ${config.url}  ${running ? 'running' : 'not running (start it with: npm run bridge)'}`);
    if (running) print(`Still sync ${sync?.connected ? `connected, ${sync.items} items, last sync ${sync.ageSeconds}s ago` : sync ? 'waiting for an open Still view with bridge sync enabled' : 'token rejected; check bridge/.local/config.json'}`);
    print(`Config     ${config.path}`);
    print('');
    for (const client of await connections.listConnections()) {
      const state = { configured: 'configured', not_configured: 'not configured', conflict: 'conflict', manual: 'manual setup' }[client.configurationStatus] || client.configurationStatus;
      print(`${client.name.padEnd(15)} ${state}${client.skillInstalled ? ', skill installed' : ''}${client.reason ? `  (${client.reason})` : ''}`);
    }
    print('');
    printPairing(print, config, null);
    return 0;
  }

  const id = ALIASES[target];
  const preview = await connections.previewConnection(id);
  print(`${preview.name}: ${preview.configPath}`);
  let code = 0;
  if (preview.configured) print('Already configured. Nothing to change.');
  else if (!preview.canConnect) {
    print(`Automatic setup is not possible: ${preview.reason}`);
    print('Add this entry yourself:');
    print('');
    print(preview.configSnippet);
    code = 2;
  } else if (dryRun) {
    print(preview.commands?.length ? `Would run: ${preview.commands.map(command => [command.command, ...command.args].map(part => /\s/.test(part) ? JSON.stringify(part) : part).join(' ')).join('\n')}` : `Would merge into ${preview.configPath}:\n\n${preview.configSnippet}`);
  } else {
    const result = await connections.connectClient(id, { expectedHash: preview.previewHash });
    print(`Connected. ${result.backupPath ? `Backup of the previous config: ${result.backupPath}` : 'No previous config file existed.'}`);
    if (result.receiptPath) print(`Receipt: ${result.receiptPath}`);
  }
  if (flags.has('--skill')) {
    if (preview.skillSupported === false) print(`${preview.name} does not read a personal skills folder; skipped the skill.`);
    else if (dryRun) print(`Would install the still-workspace skill into ${preview.skillPath}.`);
    else try { const skill = await connections.installSkills(id); print(skill.unchanged ? `Skill already installed at ${skill.skillPath}.` : `Installed the still-workspace skill at ${skill.skillPath}.`); }
    catch (failure) { print(`Skill not installed: ${failure.message}`); if (!code) code = 2; }
  }
  print('');
  printPairing(print, config, preview.name);
  return code;
}

function printPairing(print, config, clientName) {
  print('Next steps');
  print('1. Start the bridge and leave it running:  npm run bridge');
  print(`   (or: node "${ROOT}bridge/server.mjs")`);
  print('2. In Still, open Settings → Agents & MCP and pair the bridge:');
  print(`     URL    ${config.url}`);
  print(`     Token  ${config.token ?? `(a new random token is written to ${config.path} on the first run without --dry-run)`}`);
  print('   Keep one Still view open; it syncs with the bridge every 2 seconds.');
  print(`3. Restart ${clientName || 'your MCP client'} so it loads the "still" server, then ask it to call bridge_status.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSetup({ argv: process.argv.slice(2) }).then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
