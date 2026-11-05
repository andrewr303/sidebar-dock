#!/usr/bin/env node
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { createBridgeState, SUPPORTED_PROTOCOL_VERSIONS } from './protocol.mjs';
import { createAiRouter } from './ai/router.mjs';
import { createConnectionsService } from './connections.mjs';

const MAX_BODY = 16 * 1024 * 1024;
// Library snapshots carry captured article text, so /sync accepts larger bodies than other routes.
const MAX_SYNC_BODY = 64 * 1024 * 1024;
function allowedOrigin(origin, extensionIds) {
  if (!origin) return true;
  const extension = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  if (extension) return !extensionIds?.length || extensionIds.includes(extension[1]);
  try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.origin === origin; } catch { return false; }
}
function authorized(value, token) {
  const actual = Buffer.from(value || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
// The Host header's name without its port; IPv6 literals arrive in brackets.
function hostName(host) {
  const match = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+))(?::\d{1,5})?$/i.exec(host || '');
  return match ? (match[1] || match[2]).toLowerCase() : null;
}
export const isLoopbackAddress = address => address === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address || '');
// Paperclip's tool gateway can forward these metadata headers; they only label receipts and never grant access.
const PAPERCLIP_HEADERS = { agentId: 'x-paperclip-agent-id', issueId: 'x-paperclip-issue-id', runId: 'x-paperclip-run-id', companyId: 'x-paperclip-company-id' };
// Paperclip forwards those headers only when the connection's header policy allows it (off by default), so a call also
// counts as Paperclip's when it uses the scoped "paperclip" token or Paperclip's User-Agent. That keeps the shorter
// semantic_search wait (under Paperclip's 10 s gateway limit) working for a plain pasted connection.
function requestContext(headers, caller) {
  const context = {};
  for (const [key, name] of Object.entries(PAPERCLIP_HEADERS)) { const value = headers[name]; if (typeof value === 'string' && /^[A-Za-z0-9._:@-]{1,128}$/.test(value)) context[key] = value; }
  const paperclip = Object.keys(context).length || caller?.name === 'paperclip' || /^Paperclip\//.test(headers['user-agent'] || '');
  return paperclip ? { client: 'paperclip', ...context } : undefined;
}
const rpcError = (code, message) => ({ jsonrpc: '2.0', id: null, error: { code, message } });
async function readJson(request, { maximum = MAX_BODY, allowEmpty = false } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error(`Request exceeds the ${Math.round(maximum / 1024 / 1024)} MiB bridge limit.`), { status: 413 });
    chunks.push(chunk);
  }
  if (allowEmpty && !size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Request must contain valid JSON.'), { status: 400 }); }
}
const GITHUB_TOKEN_RE = /^[A-Za-z0-9_.-]{20,255}$/;
/**
 * The GitHub credential this computer already uses, for Still's GitHub widget: `gh auth token` (no shell, bounded time and
 * output), then GITHUB_TOKEN / GH_TOKEN from the bridge's environment. Resolves { token, source } or null. Never logged.
 */
export function createGitHubTokenSource({ execFile = nodeExecFile, env = process.env, timeout = 5000 } = {}) {
  const fromCli = () => new Promise(resolve => {
    try {
      execFile('gh', ['auth', 'token'], { timeout, windowsHide: true, maxBuffer: 16 * 1024, env: { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (error, stdout) => {
        const value = String(stdout || '').trim();
        resolve(!error && GITHUB_TOKEN_RE.test(value) ? value : '');
      });
    } catch { resolve(''); }
  });
  return async () => {
    const cli = await fromCli();
    if (cli) return { token: cli, source: 'gh' };
    for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
      const value = String(env?.[name] || '').trim();
      if (GITHUB_TOKEN_RE.test(value)) return { token: value, source: name };
    }
    return null;
  };
}
/**
 * tokens: scoped client tokens [{name, scope, token}] (or a function returning them, so tokens created while the bridge
 * runs work at once). They are accepted only on /mcp; every other route needs the primary pairing token.
 * allowedHosts: extra Host header names to accept besides loopback (for example host.docker.internal).
 */
export function createBridgeServer({ token, tokens = [], allowedHosts = [], state = createBridgeState(), ai = createAiRouter(), connections = createConnectionsService(), extensionIds = [], githubToken = createGitHubTokenSource() }) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('A strong bridge token is required.');
  const hosts = new Set([...LOOPBACK_HOSTS, ...allowedHosts.map(host => String(host).replace(/^\[|\]$/g, '').toLowerCase())]);
  const scopedTokens = async () => { try { const list = typeof tokens === 'function' ? await tokens() : tokens; return Array.isArray(list) ? list : []; } catch { return []; } };
  // Every candidate is compared so the time taken does not reveal which token matched.
  async function credential(header) {
    let found = authorized(header, token) ? { primary: true, scope: 'full' } : null;
    for (const entry of await scopedTokens()) if (typeof entry?.token === 'string' && entry.token.length >= 24 && authorized(header, entry.token) && !found) found = { primary: false, scope: entry.scope, name: entry.name };
    return found;
  }
  return createServer(async (request, response) => {
    const origin = request.headers.origin;
    const reply = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(body === undefined ? undefined : JSON.stringify(body)); };
    // Host validation also rejects DNS rebinding through an attacker-controlled name.
    const name = hostName(request.headers.host);
    if (!name || !hosts.has(name) || !allowedOrigin(origin, extensionIds)) return reply(403, { error: 'Origin or host is not allowed.' });
    if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); response.setHeader('Access-Control-Expose-Headers', 'MCP-Protocol-Version, Mcp-Session-Id, WWW-Authenticate'); }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept,MCP-Protocol-Version,Mcp-Session-Id,Last-Event-ID');
      response.setHeader('Access-Control-Max-Age', '600');
      return reply(204);
    }
    // Routes match the pathname, so a cache-busting query string does not turn a known route into a 404.
    let path;
    try { path = new URL(request.url, 'http://127.0.0.1').pathname; } catch { return reply(400, { error: 'Invalid request path.' }); }
    if (path === '/mcp/') path = '/mcp';
    if (path === '/health' && request.method === 'GET') return reply(200, { name: 'still-library', requiresAuth: true });
    // No OAuth here: a plain 404 stops clients from looping into authorization-server discovery.
    if (path.startsWith('/.well-known/')) return reply(404, { error: 'This bridge uses a bearer token, not OAuth. Add the Authorization header from the Still bridge configuration.' });
    const caller = await credential(request.headers.authorization);
    if (!caller) { response.setHeader('WWW-Authenticate', 'Bearer realm="still"'); return reply(401, { error: 'Invalid bridge token.' }); }
    try {
      if (path === '/mcp') {
        if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return reply(405, { error: 'This server uses JSON response mode. Send MCP requests with POST.' }); }
        const version = request.headers['mcp-protocol-version'];
        if (version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) return reply(400, rpcError(-32600, `Unsupported MCP-Protocol-Version. Supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`));
        let message;
        try { message = await readJson(request); }
        catch (error) { return error.status === 413 ? reply(413, rpcError(-32600, error.message)) : reply(400, rpcError(-32700, 'Parse error')); }
        const result = await state.rpc(message, { scope: caller.scope, context: requestContext(request.headers, caller) });
        return result ? reply(200, result) : reply(202);
      }
      if (!caller.primary) return reply(403, { error: 'This client token only works for MCP requests at /mcp.' });
      if (path === '/github/token') {
        if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); return reply(405, { error: 'Use GET to read the GitHub token.' }); }
        const found = await githubToken();
        if (!found) return reply(404, { error: 'No GitHub sign-in found on this computer. Run gh auth login, or start the bridge with GITHUB_TOKEN set, then try again.' });
        return reply(200, { token: found.token, source: found.source });
      }
      if (await ai.handle(request, response, { readJson, reply })) return;
      // Paperclip gets a scoped token instead of a client config file, so its routes come before the generic ones.
      const paperclipRoute = /^\/connections\/paperclip\/(setup|revoke)$/.exec(path);
      if (paperclipRoute) {
        if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return reply(405, { error: 'Use POST for Paperclip setup.' }); }
        const body = await readJson(request, { allowEmpty: true });
        if (paperclipRoute[1] === 'revoke') {
          if (typeof connections.paperclipRevoke !== 'function') return reply(404, { error: 'Paperclip setup is not available in this bridge.' });
          return reply(200, await connections.paperclipRevoke());
        }
        if (typeof connections.paperclipSetup !== 'function') return reply(404, { error: 'Paperclip setup is not available in this bridge.' });
        if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'Send Paperclip setup options as a JSON object.' });
        if (body.scope !== undefined && !['read', 'write', 'full'].includes(body.scope)) return reply(400, { error: 'Choose read, write or full access for Paperclip.' });
        if (body.rotate !== undefined && typeof body.rotate !== 'boolean') return reply(400, { error: 'rotate must be true or false.' });
        return reply(200, await connections.paperclipSetup({ ...(body.scope ? { scope: body.scope } : {}), rotate: body.rotate === true }));
      }
      const connectionRoute = /^\/connections(?:\/([a-z][a-z-]{0,40})\/(preview|connect|disconnect|skills))?$/.exec(path);
      if (connectionRoute) {
        if (!connectionRoute[1] && request.method === 'GET') return reply(200, { clients: await connections.listConnections() });
        if (request.method !== 'POST' || !connectionRoute[1]) return reply(405, { error: 'Choose a supported connection action.' });
        const body = await readJson(request), [, client, action] = connectionRoute;
        if (action === 'preview') return reply(200, await connections.previewConnection(client));
        if (action === 'connect') return reply(200, await connections.connectClient(client, { expectedHash: body.previewHash }));
        if (action === 'disconnect') return reply(200, await connections.disconnectClient(client, { expectedHash: body.previewHash }));
        if (action === 'skills') return reply(200, await connections.installSkills(client));
      }
      if (path === '/status' && request.method === 'GET') return reply(200, state.status());
      if (path === '/sync' && request.method === 'POST') return reply(200, state.sync(await readJson(request, { maximum: MAX_SYNC_BODY })));
      return reply(404, { error: 'Route not found.' });
    } catch (error) { return reply(error.status || 400, { error: error.message }); }
  });
}
// Scoped tokens are reread when the file changes, so a token created by `npm run connect -- paperclip` works without a restart.
export function configTokens(config) {
  let current = config.tokens, checkedAt = 0, modified = null;
  return async () => {
    if (Date.now() - checkedAt < 1000) return current;
    checkedAt = Date.now();
    try {
      const { mtimeMs } = await stat(config.path);
      if (mtimeMs !== modified) current = (await loadConfig(config.path)).tokens;
      modified = mtimeMs;
    } catch { current = []; modified = null; /* missing or invalid file: accept no scoped tokens, so a revoked one cannot linger */ }
    return current;
  };
}
export async function startBridge({ configPath } = {}) {
  const config = await loadConfig(configPath, { create: true });
  const url = new URL(config.url);
  const server = createBridgeServer({ token: config.token, tokens: configTokens(config), allowedHosts: config.allowedHosts, extensionIds: config.extensionIds, connections: createConnectionsService({ configPath: config.path }) });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(url.port) || 80, config.bindAddress || '127.0.0.1', resolve); }); }
  catch (error) { if (error.code === 'EADDRINUSE') throw new Error(`Port ${url.port} is already in use. Another Still bridge may be running; stop it or change the port in ${config.path}.`); throw error; }
  if (!isLoopbackAddress(config.bindAddress || '127.0.0.1')) process.stderr.write(`Warning: the Still bridge is listening on ${config.bindAddress}, beyond this computer. Anyone who can reach it and has a token can use your library; keep the token private and remove bindAddress from ${config.path} when you no longer need it.\n`);
  process.stderr.write(`Still bridge listening at ${config.url}\nPair Still (Settings → Agents & MCP) with this URL and the token in ${config.path}, or run \`npm run connect -- status\`. Keep a Still view open to sync.\n`);
  return server;
}
// Robust to npm bin symlinks: compare real paths, not the launched path.
const launchedDirectly = () => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (launchedDirectly()) {
  startBridge().then(server => {
    const stop = () => server.close(() => process.exit(0));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
