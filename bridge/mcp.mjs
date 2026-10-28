import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';

export async function runStdio({ input = process.stdin, output = process.stdout, config, fetch: fetcher = globalThis.fetch } = {}) {
  config ||= await loadConfig();
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
  async function forward(line) {
    let message;
    try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    try {
      // semantic_search can wait up to 15 s for the extension, so the per-message limit leaves headroom above that.
      const response = await fetcher(`${config.url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', Accept: 'application/json,text/event-stream' }, body: JSON.stringify(message), signal: AbortSignal.timeout(30000) });
      if (response.status === 202) return;
      if (!response.ok) throw new Error(`Bridge returned HTTP ${response.status}. Verify the bridge token and local configuration.`);
      const result = await response.json();
      if (result) send(result);
    } catch (error) {
      if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `Still bridge unavailable: ${error.message}. Start it with \`npm run bridge\` (node bridge/server.mjs) and keep a syncing Still view open.` } });
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdio().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
