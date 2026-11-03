#!/usr/bin/env node
// Prints the Still bridge Authorization header as JSON, for MCP clients that run a helper to get headers (Claude Code's
// `headersHelper`), so the token never has to be copied into a client configuration file.
//   node bridge/auth-header.mjs                         -> {"Authorization":"Bearer <pairing token>"}
//   node bridge/auth-header.mjs --token-name paperclip  -> {"Authorization":"Bearer <that client token>"}
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

export async function authHeaders({ argv = process.argv.slice(2), load = loadConfig } = {}) {
  let tokenName = null;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--token-name') { tokenName = argv[++index] ?? ''; continue; }
    if (argv[index].startsWith('--token-name=')) { tokenName = argv[index].slice('--token-name='.length); continue; }
    throw new Error(`Unknown option ${String(argv[index]).slice(0, 40)}. Use --token-name <name> or no options.`);
  }
  if (tokenName !== null && !/^[a-z][a-z0-9-]{0,40}$/.test(tokenName)) throw new Error('Use --token-name with a client token name such as paperclip.');
  const config = await load();
  if (tokenName === null) return { Authorization: `Bearer ${config.token}` };
  const entry = config.tokens.find(token => token.name === tokenName);
  if (!entry) throw new Error(`No client token named ${tokenName} in ${config.path}. Create one with \`npm run connect -- ${tokenName}\`.`);
  return { Authorization: `Bearer ${entry.token}` };
}

const launchedDirectly = () => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (launchedDirectly()) {
  authHeaders().then(headers => { process.stdout.write(`${JSON.stringify(headers)}\n`); })
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
