#!/usr/bin/env node
// stdio MCP adapter: forwards newline-delimited JSON-RPC to the local Still bridge (POST <url>/mcp with the pairing token
// from the bridge configuration). When the configuration is missing or the bridge is down it still answers initialize,
// ping and the list methods locally, so clients show Still as connected and tool calls explain how to start the bridge.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { TOOLS, PROMPTS, RESOURCE_TEMPLATES, initializeResult, getPrompt } from './protocol.mjs';

const START_HINT = 'Start it with `npm run bridge` (node bridge/server.mjs) and keep a syncing Still view open.';

// Local answers while the bridge cannot be reached. reason is a calm sentence without secrets.
export function offlineResponse(message, reason) {
  if (!message || typeof message !== 'object' || message.id === undefined || typeof message.method !== 'string') return null;
  const answer = result => ({ jsonrpc: '2.0', id: message.id, result });
  const params = message.params ?? {};
  switch (message.method) {
    case 'initialize': return answer(initializeResult(params));
    case 'ping': return answer({});
    case 'tools/list': return answer({ tools: TOOLS });
    case 'resources/list': return answer({ resources: [] });
    case 'resources/templates/list': return answer({ resourceTemplates: RESOURCE_TEMPLATES });
    case 'prompts/list': return answer({ prompts: PROMPTS });
    case 'prompts/get':
      try { return answer(getPrompt(params.name, params.arguments ?? {})); } catch (error) { return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: error.message } }; }
    case 'completion/complete': return answer({ completion: { values: [], hasMore: false } });
    case 'tools/call': {
      if (!TOOLS.some(tool => tool.name === params.name)) return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool: ${String(params.name).slice(0, 100)}` } };
      const detail = { code: 'BRIDGE_UNAVAILABLE', message: `Still bridge unavailable: ${reason}`, action: START_HINT };
      return answer({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: detail }) }], structuredContent: { error: detail } });
    }
    default: return { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `Still bridge unavailable: ${reason} ${START_HINT}` } };
  }
}

export async function runStdio({ input = process.stdin, output = process.stdout, config, fetch: fetcher = globalThis.fetch, load = loadConfig, retryConfigMs = 2000, now = Date.now } = {}) {
  // A missing configuration is not cached: the bridge may create it after this adapter starts (a plugin starts with the
  // agent session), so loading is retried at most every retryConfigMs until it succeeds, then kept.
  let configProblem = null, loadedAt = -Infinity;
  async function ensureConfig() {
    if (config) return true;
    if (now() - loadedAt < retryConfigMs) return false;
    loadedAt = now();
    try { config = await load(); configProblem = null; return true; } catch (error) { configProblem = error.message; return false; }
  }
  await ensureConfig();
  let buffer = '';
  let queue = Promise.resolve();
  // semantic_search can wait up to 15 s for the extension. It is read-only, so it runs beside the ordered queue
  // instead of holding back pings and other tool calls that a client sends meanwhile.
  const waiting = new Set();
  const awaitsExtension = line => { try { const message = JSON.parse(line); return message?.method === 'tools/call' && message.params?.name === 'semantic_search'; } catch { return false; } };
  const dispatch = line => {
    if (!awaitsExtension(line)) { queue = queue.then(() => forward(line)); return; }
    const task = forward(line).catch(() => {}).finally(() => waiting.delete(task)); waiting.add(task);
  };
  const send = value => output.write(`${JSON.stringify(value)}\n`);
  const offline = (message, reason) => { const response = offlineResponse(message, reason); if (response) send(response); };
  async function forward(line) {
    let message;
    try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (!await ensureConfig()) { offline(message, configProblem); return; }
    try {
      // semantic_search can wait up to 15 s for the extension, so the per-message limit leaves headroom above that.
      const response = await fetcher(`${config.url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', Accept: 'application/json,text/event-stream' }, body: JSON.stringify(message), signal: AbortSignal.timeout(30000) });
      if (response.status === 202) return;
      if (!response.ok) {
        // A JSON-RPC error body (for example a parse error) is passed through; anything else falls back to local answers.
        const body = await response.json().catch(() => null);
        if (body?.jsonrpc === '2.0' && body.error) { send(message?.id !== undefined ? { ...body, id: message.id } : body); return; }
        throw new Error(response.status === 401 ? 'the bridge rejected the token. Check the bridge configuration.' : `the bridge returned HTTP ${response.status}.`);
      }
      const result = await response.json();
      if (result) send(result);
    } catch (error) {
      offline(message, /^the bridge/.test(error.message) ? error.message : 'the bridge is not reachable.');
    }
  }
  input.setEncoding('utf8');
  for await (const chunk of input) {
    buffer += chunk;
    if (buffer.length > 2 * 1024 * 1024) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'MCP message exceeds the 2 MiB input limit.' } }); buffer = ''; continue; }
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (line) dispatch(line);
    }
  }
  await queue;
  if (buffer.trim()) await forward(buffer);
  await Promise.all(waiting);
}
// Robust to npm bin symlinks: compare real paths, not the launched path.
const launchedDirectly = () => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (launchedDirectly()) {
  runStdio().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
