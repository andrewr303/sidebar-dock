#!/usr/bin/env node
// `npm run connect` / `still-connect`: registers Still with MCP clients, prints pairing steps, and issues Paperclip setup bundles.
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig as loadBridgeConfig, DEFAULT_CONFIG_PATH } from './config.mjs';
import { createConnectionsService, CLIENT_CATALOG } from './connections.mjs';

export const ALIASES = Object.freeze(Object.fromEntries(CLIENT_CATALOG.flatMap(client => [[client.id, client.id], ...(client.aliases || []).map(alias => [alias, client.id])])));
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCOPES = ['read', 'write', 'full'];
const HTTP_CLIENTS = ['claude', 'codex'];
const describe = mode => CLIENT_CATALOG.filter(client => client.mode === mode || (mode === 'auto' && ['native-cli', 'json-merge'].includes(client.mode)))
  .map(client => client.id + (client.aliases?.length ? ` (${client.name}; also ${client.aliases.join(', ')})` : client.id === client.name.toLowerCase() ? '' : ` (${client.name})`)).join(', ');
const USAGE = `Connect an MCP client to your Still library.

Usage: npm run connect -- <client|status|paperclip> [options]
       node bridge/setup.mjs <client|status|paperclip> [options]

Automatic:    ${describe('auto')}
Snippet only: ${describe('manual')}
paperclip     Create a scoped token for Paperclip and print its paste-in config, agent instructions and steps.
status        Show whether the bridge is running, whether Still is syncing, and each client's setup.

--skill            Also install the still-workspace agent skill for that client.
--dry-run          Show what would change without writing anything (no token is created).
--http             claude/codex only: print the direct HTTP alternative instead of the default stdio setup.
--scope <s>        paperclip only: read, write or full. Default: keep the current token's scope (write for a new token).
--rotate           paperclip only: replace the existing Paperclip token.
--revoke           paperclip only: delete the Paperclip token.
`;

function parseArgs(argv) {
  const flags = new Set(), words = [], values = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--scope' || value.startsWith('--scope=')) { flags.add('--scope'); values.scope = value.includes('=') ? value.slice(8) : argv[++index]; }
    else if (value.startsWith('--')) flags.add(value);
    else words.push(value);
  }
  return { flags, words, values };
}

export async function runSetup({ argv = [], stdout = process.stdout, connections, loadConfig = loadBridgeConfig, configPath, fetch: fetcher = globalThis.fetch } = {}) {
  const print = (line = '') => stdout.write(`${line}\n`);
  const { flags, words, values } = parseArgs(argv);
  if (!words.length || flags.has('--help') || words[0] === 'help') { print(USAGE); return words.length || flags.has('--help') ? 0 : 1; }
  const target = words[0].toLowerCase();
  const paperclip = target === 'paperclip';
  const allowed = ['--dry-run', '--help', ...(paperclip ? ['--scope', '--rotate', '--revoke'] : ['--skill', '--http'])];
  const unknownFlag = [...flags].find(flag => !allowed.includes(flag));
  if (unknownFlag || words.length > 1 || (target !== 'status' && !ALIASES[target])) { print(`${unknownFlag ? `Unknown option ${unknownFlag}${paperclip || target === 'status' || !['--scope', '--rotate', '--revoke'].includes(unknownFlag) ? '' : ' (it only applies to paperclip)'}.` : `Unknown client "${words.join(' ')}".`}\n`); print(USAGE); return 1; }
  if (paperclip && flags.has('--scope') && !SCOPES.includes(values.scope)) { print('Choose --scope read, write or full.\n'); print(USAGE); return 1; }
  if (flags.has('--http') && !HTTP_CLIENTS.includes(ALIASES[target])) { print('--http applies to claude and codex only.\n'); print(USAGE); return 1; }
  if (paperclip && flags.has('--rotate') && flags.has('--revoke')) { print('Choose either --rotate or --revoke.\n'); return 1; }

  // The bridge config (URL + pairing token) is created on first use so pairing steps can be printed right away;
  // a dry run (and the read-only --http printout) writes nothing, so it only describes the token a real run would create.
  const dryRun = (flags.has('--dry-run') || flags.has('--http')) && target !== 'status';
  const explicit = configPath || process.env.STILL_BRIDGE_CONFIG || undefined;
  let config;
  if (dryRun) {
    try { config = await loadConfig(explicit, { create: false }); }
    catch (failure) {
      const path = explicit || DEFAULT_CONFIG_PATH;
      if (await access(path).then(() => true, () => false)) throw failure;
      config = { url: 'http://127.0.0.1:43123', token: null, path: resolve(path) };
    }
  } else config = await loadConfig(explicit, { create: true });
  connections ||= createConnectionsService({ configPath: explicit });

  if (target === 'status') {
    let running = false, sync = null;
    try { running = (await fetcher(`${config.url}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch {}
    if (running) try { const response = await fetcher(`${config.url}/status`, { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(1500) }); if (response.ok) sync = await response.json(); } catch {}
    print(`Bridge     ${config.url}  ${running ? 'running' : 'not running (start it with: npm run bridge)'}`);
    if (running) print(`Still sync ${sync?.connected ? `connected, ${sync.items} items, last sync ${sync.ageSeconds}s ago` : sync ? 'waiting for an open Still view with bridge sync enabled' : `token rejected; check ${config.path}`}`);
    print(`Config     ${config.path}`);
    print('');
    for (const client of await connections.listConnections()) {
      const state = { configured: 'configured', not_configured: 'not configured', conflict: 'conflict', manual: 'manual setup' }[client.configurationStatus] || client.configurationStatus;
      print(`${client.name.padEnd(18)} ${state}${client.skillInstalled ? ', skill installed' : ''}${client.reason ? `  (${client.reason})` : ''}`);
    }
    print('');
    print(`Direct HTTP: ${config.url}/mcp with "Authorization: Bearer <token>". For Claude Code or Codex see: npm run connect -- claude --http`);
    print('');
    printPairing(print, config, null);
    return 0;
  }

  if (paperclip) return runPaperclip({ print, connections, flags, scope: values.scope, dryRun, config });

  const id = ALIASES[target];
  if (flags.has('--http')) { printHttp(print, id, config); return 0; }
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

async function runPaperclip({ print, connections, flags, scope, dryRun, config }) {
  if (flags.has('--revoke')) {
    if (dryRun) { print('Would revoke the Paperclip token. Nothing was changed.'); return 0; }
    const { removed } = await connections.paperclipRevoke();
    print(removed ? 'Revoked the Paperclip token. Paperclip can no longer call Still; remove the connection in Paperclip too.' : 'No Paperclip token existed. Nothing to revoke.');
    return 0;
  }
  const setup = await connections.paperclipSetup({ scope, rotate: flags.has('--rotate'), dryRun });
  print('Paperclip → Still');
  print(`URL     ${setup.url}`);
  print(`Scope   ${setup.scope}${setup.scopeChanged ? `  (changed from ${setup.previousScope})` : ''}`);
  print(`Token   ${setup.token ?? `(a scoped token is written to ${setup.configPath || config.path} on a run without --dry-run)`}${setup.token ? (setup.created ? '  (new)' : setup.rotated ? '  (rotated; paste the new value into Paperclip)' : '  (existing; use --rotate for a new one)') : ''}`);
  if (setup.token) print(`Authorization value for Paperclip's field: ${setup.authorizationHeader}`);
  print('');
  print('Steps');
  setup.steps.forEach((step, index) => print(`${index + 1}. ${step}`));
  print('');
  print('Paste config (Advanced → Paste a config)');
  print(setup.pasteConfig);
  print('');
  print('Agent instructions (paste into the connection\'s agent instructions)');
  print(setup.agentInstructions);
  print('');
  print('Notes');
  for (const note of setup.notes) print(`- ${note}`);
  return 0;
}

function printHttp(print, id, config) {
  const url = `${config.url}/mcp`, helper = `node ${JSON.stringify(resolve(ROOT, 'bridge', 'auth-header.mjs'))}`;
  print('Direct HTTP alternative (not written automatically; the default stdio setup keeps the token out of client config).');
  print('');
  if (id === 'claude') {
    print('Claude Code reads the token at connect time through a headers helper:');
    print(`  claude mcp add-json --scope user still ${JSON.stringify(JSON.stringify({ type: 'http', url, headersHelper: helper }))}`);
    print('');
    print('The equivalent ~/.claude.json entry:');
    print(JSON.stringify({ mcpServers: { still: { type: 'http', url, headersHelper: helper } } }, null, 2));
  } else {
    print(`Codex reads a bearer token from an environment variable. Set STILL_BRIDGE_TOKEN to the token in ${config.path}, then add:`);
    print(`[mcp_servers.still]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "STILL_BRIDGE_TOKEN"`);
  }
  print('');
  print('Keep the bridge running (npm run bridge) and one Still view open.');
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

function isMain() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) {
  runSetup({ argv: process.argv.slice(2) }).then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
