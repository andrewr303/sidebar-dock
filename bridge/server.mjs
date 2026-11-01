import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { createBridgeState } from './protocol.mjs';
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
async function readJson(request, { maximum = MAX_BODY } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error(`Request exceeds the ${Math.round(maximum / 1024 / 1024)} MiB bridge limit.`), { status: 413 });
    chunks.push(chunk);
  }
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
export function createBridgeServer({ token, state = createBridgeState(), ai = createAiRouter(), connections = createConnectionsService(), extensionIds = [], githubToken = createGitHubTokenSource() }) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('A strong bridge token is required.');
  return createServer(async (request, response) => {
    const origin = request.headers.origin;
    const reply = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(body === undefined ? undefined : JSON.stringify(body)); };
    // Host validation also rejects DNS rebinding through an attacker-controlled name.
    const host = request.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) || !allowedOrigin(origin, extensionIds)) return reply(403, { error: 'Origin or host is not allowed.' });
    if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept,MCP-Protocol-Version');
      response.setHeader('Access-Control-Max-Age', '600');
      return reply(204);
    }
    // Routes match the pathname, so a cache-busting query string does not turn a known route into a 404.
    let path;
    try { path = new URL(request.url, 'http://127.0.0.1').pathname; } catch { return reply(400, { error: 'Invalid request path.' }); }
    if (path === '/health' && request.method === 'GET') return reply(200, { name: 'still-library', requiresAuth: true });
    if (!authorized(request.headers.authorization, token)) return reply(401, { error: 'Invalid bridge token.' });
    try {
      if (path === '/github/token') {
        if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); return reply(405, { error: 'Use GET to read the GitHub token.' }); }
        const found = await githubToken();
        if (!found) return reply(404, { error: 'No GitHub sign-in found on this computer. Run gh auth login, or start the bridge with GITHUB_TOKEN set, then try again.' });
        return reply(200, { token: found.token, source: found.source });
      }
      if (await ai.handle(request, response, { readJson, reply })) return;
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
      if (path === '/mcp' && request.method === 'POST') {
        const result = await state.rpc(await readJson(request));
        return result ? reply(200, result) : reply(202);
      }
      if (path === '/mcp' && request.method === 'GET') { response.setHeader('Allow', 'POST'); return reply(405, { error: 'This server uses JSON response mode. Send MCP requests with POST.' }); }
      return reply(404, { error: 'Route not found.' });
    } catch (error) { return reply(error.status || 400, { error: error.message }); }
  });
}
export async function startBridge({ configPath } = {}) {
  const config = await loadConfig(configPath, { create: true });
  const url = new URL(config.url);
  const server = createBridgeServer({ token: config.token, extensionIds: config.extensionIds });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(url.port) || 80, '127.0.0.1', resolve); }); }
  catch (error) { if (error.code === 'EADDRINUSE') throw new Error(`Port ${url.port} is already in use. Another Still bridge may be running; stop it or change the port in ${config.path}.`); throw error; }
  process.stderr.write(`Still bridge listening at ${config.url}\nPair Still (Settings → Agents & MCP) with this URL and the token in ${config.path}, or run \`npm run connect -- status\`. Keep a Still view open to sync.\n`);
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startBridge().then(server => {
    const stop = () => server.close(() => process.exit(0));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
