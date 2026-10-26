import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { createBridgeState } from './protocol.mjs';
import { createAiRouter } from './ai/router.mjs';
import { createConnectionsService } from './connections.mjs';

const MAX_BODY = 16 * 1024 * 1024;
function allowedOrigin(origin) {
  if (!origin) return true;
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return true;
  try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.origin === origin; } catch { return false; }
}
function authorized(value, token) {
  const actual = Buffer.from(value || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request exceeds the 16 MiB bridge limit.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Request must contain valid JSON.'), { status: 400 }); }
}
export function createBridgeServer({ token, state = createBridgeState(), ai = createAiRouter(), connections = createConnectionsService() }) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('A strong bridge token is required.');
  return createServer(async (request, response) => {
    const origin = request.headers.origin;
    const reply = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(body === undefined ? undefined : JSON.stringify(body)); };
    // Host validation also rejects DNS rebinding through an attacker-controlled name.
    const host = request.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) || !allowedOrigin(origin)) return reply(403, { error: 'Origin or host is not allowed.' });
    if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept,MCP-Protocol-Version');
      response.setHeader('Access-Control-Max-Age', '600');
      return reply(204);
    }
    if (request.url === '/health' && request.method === 'GET') return reply(200, { name: 'still-library', requiresAuth: true });
    if (!authorized(request.headers.authorization, token)) return reply(401, { error: 'Invalid bridge token.' });
    try {
      if (await ai.handle(request, response, { readJson, reply })) return;
      const connectionRoute = /^\/connections(?:\/([a-z]+)\/(preview|connect|disconnect|skills))?$/.exec(request.url);
      if (connectionRoute) {
        if (!connectionRoute[1] && request.method === 'GET') return reply(200, { clients: await connections.listConnections() });
        if (request.method !== 'POST' || !connectionRoute[1]) return reply(405, { error: 'Choose a supported connection action.' });
        const body = await readJson(request), [, client, action] = connectionRoute;
        if (action === 'preview') return reply(200, await connections.previewConnection(client));
        if (action === 'connect') return reply(200, await connections.connectClient(client, { expectedHash: body.previewHash }));
        if (action === 'disconnect') return reply(200, await connections.disconnectClient(client, { expectedHash: body.previewHash }));
        if (action === 'skills') return reply(200, await connections.installSkills(client));
      }
      if (request.url === '/status' && request.method === 'GET') return reply(200, state.status());
      if (request.url === '/sync' && request.method === 'POST') return reply(200, state.sync(await readJson(request)));
      if (request.url === '/mcp' && request.method === 'POST') {
        const result = await state.rpc(await readJson(request));
        return result ? reply(200, result) : reply(202);
      }
      if (request.url === '/mcp' && request.method === 'GET') { response.setHeader('Allow', 'POST'); return reply(405, { error: 'This server uses JSON response mode. Send MCP requests with POST.' }); }
      return reply(404, { error: 'Route not found.' });
    } catch (error) { return reply(error.status || 400, { error: error.message }); }
  });
}
export async function startBridge({ configPath } = {}) {
  const config = await loadConfig(configPath, { create: true });
  const url = new URL(config.url);
  const server = createBridgeServer({ token: config.token });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(url.port) || 80, '127.0.0.1', resolve); });
  process.stderr.write(`Still bridge listening at ${config.url}\nCopy the token from ${config.path} into Still → Integrations. Keep a Still view open to sync.\n`);
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startBridge().then(server => {
    const stop = () => server.close(() => process.exit(0));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
