import { spawn as nativeSpawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, lstat, readdir, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentExecutable, redactCliOutput } from './ai/cli.mjs';

export const CLIENT_CATALOG = Object.freeze([
  { id: 'codex', name: 'Codex', mode: 'native-cli', config: ['.codex', 'config.toml'], skill: ['.agents', 'skills'], docs: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli' },
  { id: 'claude', name: 'Claude Code', mode: 'native-cli', config: ['.claude.json'], skill: ['.claude', 'skills'], docs: 'https://code.claude.com/docs/en/mcp' },
  { id: 'opencode', name: 'OpenCode', mode: 'json-merge', config: ['.config', 'opencode', 'opencode.json'], skill: ['.config', 'opencode', 'skills'], docs: 'https://opencode.ai/docs/mcp-servers/' },
  { id: 'cursor', name: 'Cursor', mode: 'json-merge', config: ['.cursor', 'mcp.json'], skill: ['.cursor', 'skills'], docs: 'https://cursor.com/docs/mcp' },
  { id: 'gemini', name: 'Gemini CLI', mode: 'json-merge', config: ['.gemini', 'settings.json'], skill: ['.gemini', 'skills'], docs: 'https://geminicli.com/docs/tools/mcp-server/' },
]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const own = (object, key) => Object.hasOwn(object, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const error = (code, message) => Object.assign(new Error(message), { code });
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceSkillFiles = ['SKILL.md', 'references/workflows.md'];

async function rejectSymlinks(root, target) {
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('..' + sep) || resolve(root, rel) !== resolve(target)) throw error('UNSAFE_PATH', 'The connection target is outside the selected home directory.');
  const pieces = rel ? rel.split(sep) : [];
  let current = root;
  for (let index = -1; index < pieces.length; index++) {
    if (index >= 0) current = join(current, pieces[index]);
    try { if ((await lstat(current)).isSymbolicLink()) throw error('UNSAFE_PATH', 'A connection target is a symbolic link. Use the client’s manual setup to preserve your chosen layout.'); }
    catch (failure) { if (failure.code === 'ENOENT') return; throw failure; }
  }
}
async function snapshot(home, path) {
  await rejectSymlinks(home, path);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw error('INVALID_CONFIG', 'The client configuration must be a regular file smaller than 4 MiB.');
    const bytes = await readFile(path); return { exists: true, bytes, hash: hash(bytes), text: bytes.toString('utf8'), mode: stat.mode & 0o777 };
  } catch (failure) { if (failure.code === 'ENOENT') return { exists: false, bytes: Buffer.alloc(0), hash: 'missing', text: '', mode: 0o600 }; throw failure; }
}
function parseTomlStill(text) {
  // Read only the common MCP table shape; delegate all actual TOML writes to Codex.
  const pattern = /^\s*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:still|"still"|'still')\s*\]\s*(?:#.*)?$/gm;
  const match = pattern.exec(text);
  if (!match) {
    const uncommented = text.split(/\r?\n/).filter(line => !line.trim().startsWith('#')).join('\n');
    if (/mcp_servers/.test(uncommented) && /(?:["']still["']|\bstill\s*[.=\]])/.test(uncommented)) return { foreign: true };
    return null;
  }
  if (pattern.exec(text)) return { foreign: true };
  const tail = text.slice(match.index + match[0].length), next = /^\s*\[/m.exec(tail), table = tail.slice(0, next?.index ?? tail.length);
  const parseString = value => value?.trim().startsWith("'") ? value.trim().slice(1, -1) : JSON.parse(value.trim());
  try {
    const command = parseString(/^\s*command\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/m.exec(table)?.[1]);
    const rawArgs = /^\s*args\s*=\s*(\[[\s\S]*?\])\s*(?:#.*)?$/m.exec(table)?.[1];
    const args = JSON.parse(rawArgs.replace(/,\s*\]/g, ']'));
    const enabled = !/^\s*enabled\s*=\s*false/m.test(table);
    const extra = /^\s*(?:env|env_vars|cwd)\s*=/m.test(table) || /^\s*\[\s*mcp_servers\s*\.\s*(?:still|"still"|'still')\s*\./m.test(tail);
    return { command, args, enabled, foreign: extra };
  } catch { return { foreign: true }; }
}
function readEntry(client, contents) {
  if (!contents.exists) return { document: {}, entry: null, hasEntry: false };
  if (client.id === 'codex') { const entry = parseTomlStill(contents.text); return { document: null, entry, hasEntry: entry !== null }; }
  let document;
  try { document = JSON.parse(contents.text); } catch { throw error('INVALID_CONFIG', 'Existing configuration is not strict JSON. Use the manual snippet; Still will not rewrite JSONC/comments or malformed data.'); }
  // JSON.parse accepts duplicate keys. Rewriting such a document could silently
  // discard an earlier user entry, so preserve it for a manual merge instead.
  const contexts = [];
  const tokens = contents.text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g);
  for (const token of tokens) {
    if (token[0] === '{') contexts.push(new Set());
    else if (token[0] === '[') contexts.push(null);
    else if (token[0] === '}' || token[0] === ']') contexts.pop();
    else if (token[0].startsWith('"') && /^\s*:/.test(contents.text.slice(token.index + token[0].length))) {
      const keys = contexts.at(-1), key = JSON.parse(token[0]);
      if (keys?.has(key)) throw error('INVALID_CONFIG', 'Existing configuration has duplicate JSON keys. Use a manual merge so no entry is discarded.');
      keys?.add(key);
    }
  }
  if (!object(document)) throw error('INVALID_CONFIG', 'Existing client configuration must be a JSON object.');
  const key = client.id === 'opencode' ? 'mcp' : 'mcpServers';
  if (own(document, key) && !object(document[key])) throw error('INVALID_CONFIG', `Existing ${key} configuration must be an object.`);
  const hasEntry = own(document[key] || {}, 'still');
  return { document, entry: hasEntry ? document[key].still : null, hasEntry };
}
function expectedEntry(client, entry, nodeCommand) {
  return client.id === 'opencode' ? { type: 'local', command: [nodeCommand, entry], enabled: true }
    : { ...(client.id === 'cursor' || client.id === 'claude' ? { type: 'stdio' } : {}), command: nodeCommand, args: [entry] };
}
function matchesEntry(client, actual, expected) {
  if (!actual || actual.foreign || actual.enabled === false) return false;
  if (client.id === 'opencode') return actual.type === 'local' && JSON.stringify(actual.command) === JSON.stringify(expected.command) && !actual.environment;
  return actual.command === expected.command && JSON.stringify(actual.args) === JSON.stringify(expected.args) && !actual.env && !actual.env_vars && !actual.cwd && (!actual.type || actual.type === 'stdio');
}
function commandArgs(client, action, nodeCommand, entry) {
  if (client.id === 'codex') return action === 'connect' ? ['mcp', 'add', 'still', '--', nodeCommand, entry] : ['mcp', 'remove', 'still'];
  if (client.id === 'claude') return action === 'connect' ? ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'still', '--', nodeCommand, entry] : ['mcp', 'remove', '--scope', 'user', 'still'];
  return [];
}

export function createConnectionsService({ homeDir = homedir(), projectRoot = DEFAULT_ROOT, spawn = nativeSpawn, resolveExecutable = resolveAgentExecutable, env = process.env, timeoutMs = 20000 } = {}) {
  const home = resolve(homeDir), root = resolve(projectRoot), entry = join(root, 'bridge', 'mcp.mjs'), nodeCommand = process.execPath;
  let queue = Promise.resolve();
  const serialize = work => { const task = queue.then(work, work); queue = task.catch(() => {}); return task; };
  const identify = id => CLIENT_CATALOG.find(client => client.id === id) || (() => { throw error('UNKNOWN_CLIENT', 'Choose a supported client from the connection catalog.'); })();
  const pathFor = client => join(home, ...client.config);
  const skillPathFor = client => join(home, ...client.skill, 'still-workspace');
  const receipt = async data => {
    const path = join(home, '.still', 'connection-receipts', `${Date.now()}-${randomUUID()}.json`);
    await rejectSymlinks(home, path); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ ...data, createdAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); return path;
  };
  const backup = async (path, contents) => {
    if (!contents.exists) return null;
    const destination = `${path}.still-backup-${Date.now()}-${randomUUID()}`;
    await rejectSymlinks(home, destination); await writeFile(destination, contents.bytes, { flag: 'wx', mode: 0o600 }); return destination;
  };
  async function inspect(id) {
    const client = identify(id), configPath = pathFor(client), skillPath = skillPathFor(client);
    let current, parsed, reason, launcher;
    try { current = await snapshot(home, configPath); parsed = readEntry(client, current); }
    catch (failure) { reason = failure.message; current ||= { hash: null, exists: false }; }
    if (client.mode === 'native-cli') try { launcher = await resolveExecutable(client.id); } catch (failure) { reason ||= failure.message; }
    // Honor known explicit config overrides by refusing to guess another file.
    if (client.id === 'codex' && env.CODEX_HOME && resolve(env.CODEX_HOME) !== join(home, '.codex')) reason = 'CODEX_HOME selects another configuration directory. Use manual setup in that client.';
    if (client.id === 'claude' && env.CLAUDE_CONFIG_DIR) reason = 'CLAUDE_CONFIG_DIR selects a custom configuration layout. Use manual setup in that client.';
    if (client.id === 'opencode' && (env.OPENCODE_CONFIG || env.OPENCODE_CONFIG_CONTENT || env.OPENCODE_CONFIG_DIR)) reason = 'An OpenCode configuration override is active. Use manual setup in that client.';
    if (client.id === 'opencode' && !current.exists) {
      try { if ((await lstat(join(dirname(configPath), 'opencode.jsonc'))).isFile()) reason = 'An OpenCode JSONC configuration already exists. Merge the manual snippet there to preserve its comments.'; } catch (failure) { if (failure.code !== 'ENOENT') reason ||= failure.message; }
    }
    const expected = expectedEntry(client, entry, nodeCommand), configured = matchesEntry(client, parsed?.entry, expected), conflict = !!parsed?.hasEntry && !configured;
    let skillInstalled = false;
    try { await rejectSymlinks(home, join(skillPath, 'SKILL.md')); skillInstalled = (await lstat(join(skillPath, 'SKILL.md'))).isFile(); } catch (failure) { if (failure.code !== 'ENOENT') reason ||= failure.message; }
    const commands = client.mode === 'native-cli' ? [{ command: launcher?.command || client.id, args: [...(launcher?.prefix || []), ...commandArgs(client, 'connect', nodeCommand, entry)] }] : [];
    const configSnippet = client.id === 'codex' ? `[mcp_servers.still]\ncommand = ${JSON.stringify(nodeCommand)}\nargs = [${JSON.stringify(entry)}]\n`
      : JSON.stringify({ [client.id === 'opencode' ? 'mcp' : 'mcpServers']: { still: expected } }, null, 2);
    const result = { clientId: client.id, id: client.id, name: client.name, configPath, target: configPath, configHash: current.hash, previewHash: current.hash,
      mode: client.mode, configured, configurationStatus: reason ? 'manual' : conflict ? 'conflict' : configured ? 'configured' : 'not_configured',
      canConnect: !reason && !conflict, conflict, reason: reason || (conflict ? 'An existing still entry has a different configuration. Preserve it and choose manual setup.' : null),
      configSnippet, commands, backupRequired: current.exists && !configured, skillPath, skillInstalled, restartRequired: true, runtimeConnected: false,
      installed: client.mode === 'native-cli' ? !!launcher : current.exists, docs: client.docs };
    return { client, current, parsed, expected, launcher, result };
  }
  async function listConnections() { return Promise.all(CLIENT_CATALOG.map(async client => (await inspect(client.id)).result)); }
  async function previewConnection(id) { return (await inspect(id)).result; }
  function requireExpected(preview, options) {
    const expectedHash = options?.expectedHash ?? options?.expectedConfigHash ?? options?.previewHash;
    if (typeof expectedHash !== 'string' || expectedHash !== preview.configHash) throw error('CONFIG_CHANGED', 'The client configuration changed or no preview was supplied. Review a fresh connection preview before applying.');
  }
  async function runNative(launcher, args, client) {
    const childEnv = { ...env, HOME: home, USERPROFILE: home, ...(client.id === 'codex' ? { CODEX_HOME: join(home, '.codex') } : {}), NO_COLOR: '1', FORCE_COLOR: '0' };
    return new Promise((resolveRun, reject) => {
      let child, output = '', settled = false;
      const settle = failure => { if (settled) return; settled = true; clearTimeout(timer); failure ? reject(failure) : resolveRun(); };
      const timer = setTimeout(() => { settle(error('CLI_TIMEOUT', 'The client configuration command timed out. Inspect its configuration before trying again.')); child?.kill(); }, timeoutMs);
      try { child = spawn(launcher.command, [...launcher.prefix, ...args], { cwd: root, env: childEnv, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (failure) { settle(error('CLI_FAILED', redactCliOutput(failure.message))); return; }
      const capture = chunk => { output = (output + chunk.toString()).slice(-10000); };
      child.stdout?.on('data', capture); child.stderr?.on('data', capture);
      child.once('error', failure => settle(error('CLI_FAILED', redactCliOutput(failure.message))));
      child.once('close', code => settle(code === 0 ? null : error('CLI_FAILED', `Client configuration command failed (${code}). ${redactCliOutput(output).slice(0, 1000)}`)));
    });
  }
  async function writeJson(path, document, previous) {
    await rejectSymlinks(home, path); await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.still-pending-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: previous.mode || 0o600 });
    try {
      if ((await snapshot(home, path)).hash !== previous.hash) throw error('CONFIG_CHANGED', 'The client configuration changed before writing. Review a fresh preview.');
      await rename(temporary, path);
    } catch (failure) { await rm(temporary, { force: true }); throw failure; }
  }
  function changeConnection(id, options, disconnect = false) {
    return serialize(async () => {
      const info = await inspect(id), { client, current, parsed, expected, launcher, result } = info;
      requireExpected(result, options);
      if (result.conflict || result.configurationStatus === 'manual') throw error('MANUAL_SETUP_REQUIRED', result.reason || 'This client requires manual setup.');
      if (disconnect && !result.configured || !disconnect && result.configured) return { clientId: id, configured: !disconnect, configurationStatus: disconnect ? 'not_configured' : 'configured', restartRequired: true, runtimeConnected: false, unchanged: true, backupPath: null };
      // Backup is exact, create-new and local; its contents never appear in a response.
      const backupPath = await backup(result.configPath, current);
      if ((await snapshot(home, result.configPath)).hash !== current.hash) throw error('CONFIG_CHANGED', 'The client configuration changed before applying. Review a fresh preview.');
      try {
        if (client.mode === 'native-cli') await runNative(launcher, commandArgs(client, disconnect ? 'disconnect' : 'connect', nodeCommand, entry), client);
        else { const document = structuredClone(parsed.document), key = client.id === 'opencode' ? 'mcp' : 'mcpServers'; document[key] ||= {}; if (disconnect) delete document[key].still; else document[key].still = expected; await writeJson(result.configPath, document, current); }
        const after = await snapshot(home, result.configPath), checked = readEntry(client, after);
        if (disconnect ? checked.hasEntry : !matchesEntry(client, checked.entry, expected)) throw error('CONFIG_NOT_APPLIED', 'The client command completed but the expected Still entry was not verified. Inspect the client configuration before retrying.');
        const record = { action: disconnect ? 'disconnect' : 'connect', clientId: id, configPath: result.configPath, beforeHash: current.hash, afterHash: after.hash, backupPath };
        return { clientId: id, configured: !disconnect, configurationStatus: disconnect ? 'not_configured' : 'configured', restartRequired: true, runtimeConnected: false, unchanged: false, backupPath, receiptPath: await receipt(record) };
      } catch (failure) {
        const receiptPath = await receipt({ action: disconnect ? 'disconnect_failed' : 'connect_failed', clientId: id, configPath: result.configPath, backupPath, errorCode: failure.code || 'CONFIG_FAILED' });
        failure.backupPath = backupPath; failure.receiptPath = receiptPath; throw failure;
      }
    });
  }
  async function installSkills(id) {
    return serialize(async () => {
      const client = identify(id), destination = skillPathFor(client), source = join(root, 'agent-skills', 'still-workspace');
      await rejectSymlinks(home, destination);
      const files = await Promise.all(sourceSkillFiles.map(async path => {
        const sourcePath = join(source, path); if ((await lstat(sourcePath)).isSymbolicLink()) throw error('UNSAFE_PATH', 'The bundled skill contains a symbolic link.');
        return { path, bytes: await readFile(sourcePath) };
      }));
      let exists = false;
      try { exists = (await lstat(destination)).isDirectory(); if (!exists) throw error('SKILL_CONFLICT', 'The skill destination exists and is not a directory.'); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
      if (exists) {
        for (const file of files) { await rejectSymlinks(home, join(destination, file.path)); let bytes; try { bytes = await readFile(join(destination, file.path)); } catch { throw error('SKILL_CONFLICT', 'An existing still-workspace skill differs. It was preserved; review it manually.'); } if (!bytes.equals(file.bytes)) throw error('SKILL_CONFLICT', 'An existing still-workspace skill differs. It was preserved; review it manually.'); }
        // Do not consider a directory with additional user material an owned exact install.
        const expected = new Set(sourceSkillFiles);
        async function checkDirectory(directory, prefix = '') { for (const item of await readdir(directory, { withFileTypes: true })) { const path = prefix + item.name; if (item.isSymbolicLink()) throw error('SKILL_CONFLICT', 'Existing skill contains a symbolic link.'); if (item.isDirectory()) await checkDirectory(join(directory, item.name), path + '/'); else if (!expected.has(path)) throw error('SKILL_CONFLICT', 'Existing skill contains additional files and was preserved.'); } }
        await checkDirectory(destination);
        return { clientId: id, installed: true, unchanged: true, skillPath: destination, restartRequired: true };
      }
      await mkdir(dirname(destination), { recursive: true });
      const staging = join(dirname(destination), `.still-workspace-${randomUUID()}`);
      await mkdir(staging);
      try {
        for (const file of files) { const path = join(staging, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.bytes, { flag: 'wx', mode: 0o600 }); }
        await rejectSymlinks(home, destination); await rename(staging, destination);
      } catch (failure) {
        // Only this freshly created, checked staging directory is eligible for cleanup.
        if (dirname(resolve(staging)) !== dirname(resolve(destination)) || !/^\.still-workspace-[\da-f-]+$/.test(relative(dirname(destination), staging))) throw error('UNSAFE_PATH', 'Refusing to clean up an unowned skill staging directory.');
        await rm(staging, { recursive: true, force: true }); throw failure;
      }
      const receiptPath = await receipt({ action: 'install_skill', clientId: id, skillPath: destination, files: files.map(file => ({ path: file.path, sha256: hash(file.bytes) })) });
      return { clientId: id, installed: true, unchanged: false, skillPath: destination, restartRequired: true, receiptPath };
    });
  }
  return { listConnections, previewConnection, connectClient: (id, options) => changeConnection(id, options), disconnectClient: (id, options) => changeConnection(id, options, true), installSkills };
}
