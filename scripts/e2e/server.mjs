// The local server of the browser checks (scripts/e2e-browser.mjs): fixture pages, a scripted model that speaks the
// OpenAI chat completions protocol, and the job and report endpoints the driver page inside the extension uses.
// Node built-ins only. It listens on 127.0.0.1; the pages also answer on localhost, which Chrome treats as another site.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const pagesRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'pages');
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

const readBody = request => new Promise((resolveBody, reject) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
  request.on('error', reject);
});

const escapeHtml = text => String(text).replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));

/**
 * startServer({ job }) -> { port, origin, close(), report: Promise, forms, modelRequests, setModel(name, script) }
 * job: what the driver page fetches from /e2e/job. report resolves with what it posts to /e2e/report.
 * A model script is a function (request, index) -> { text?, toolCalls?: [{ name, arguments }] }: `request` is the parsed
 * chat completions body and `index` counts that model's requests from 0.
 */
export async function startServer({ job = {} } = {}) {
  const forms = [];
  const modelRequests = [];
  const models = new Map();
  let settleReport;
  const report = new Promise(resolveReport => { settleReport = resolveReport; });
  const progress = [];

  const send = (response, status, headers, body) => { response.writeHead(status, { ...CORS, ...headers }); response.end(body); };
  const json = (response, status, value) => send(response, status, { 'content-type': 'application/json' }, JSON.stringify(value));

  async function chatCompletions(request, response) {
    const body = JSON.parse(await readBody(request));
    const script = models.get(body.model);
    const index = modelRequests.filter(entry => entry.model === body.model).length;
    modelRequests.push({ model: body.model, index, body });
    if (!script) { json(response, 404, { error: { message: `No script for model ${body.model}` } }); return; }
    let reply;
    try { reply = (await script(body, index)) || {}; }
    catch (error) { json(response, 500, { error: { message: `The model script failed: ${error.message}` } }); return; }
    if (reply.status) { send(response, reply.status, { 'content-type': 'application/json', ...(reply.headers || {}) }, JSON.stringify({ error: { message: reply.error || 'scripted error' } })); return; }
    response.writeHead(200, { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta, finish = null) => response.write(`data: ${JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    // Text arrives in a few pieces, as a real stream does.
    const text = String(reply.text || '');
    for (let start = 0; start < text.length; start += 24) chunk({ content: text.slice(start, start + 24) });
    const calls = Array.isArray(reply.toolCalls) ? reply.toolCalls : [];
    calls.forEach((call, position) => {
      chunk({ tool_calls: [{ index: position, id: `call_e2e_${index}_${position}`, type: 'function', function: { name: call.name, arguments: '' } }] });
      const args = JSON.stringify(call.arguments || {});
      for (let start = 0; start < args.length; start += 40) chunk({ tool_calls: [{ index: position, function: { arguments: args.slice(start, start + 40) } }] });
    });
    chunk({}, calls.length ? 'tool_calls' : 'stop');
    response.write(`data: ${JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 100 + index, completion_tokens: 10 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'OPTIONS') { send(response, 204, {}, ''); return; }
      if (url.pathname === '/e2e/job') { json(response, 200, job); return; }
      if (url.pathname === '/e2e/progress' && request.method === 'POST') { const entry = JSON.parse(await readBody(request)); progress.push(entry); process.stdout.write(`  ${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.detail ? ` · ${entry.detail}` : ''}\n`); json(response, 200, { ok: true }); return; }
      if (url.pathname === '/e2e/report' && request.method === 'POST') { const value = JSON.parse(await readBody(request)); json(response, 200, { ok: true }); settleReport(value); return; }
      if (url.pathname === '/e2e/forms') { json(response, 200, forms); return; }
      if (url.pathname === '/v1/models') { json(response, 200, { object: 'list', data: [...models.keys()].map(id => ({ id, object: 'model' })) }); return; }
      if (url.pathname === '/v1/chat/completions' && request.method === 'POST') { await chatCompletions(request, response); return; }
      if (request.method === 'POST' && ['/sent', '/signed-in'].includes(url.pathname)) {
        const fields = Object.fromEntries(new URLSearchParams(await readBody(request)));
        forms.push({ path: url.pathname, host: request.headers.host, fields });
        const title = url.pathname === '/sent' ? 'Message sent' : 'Signed in';
        send(response, 200, { 'content-type': 'text/html; charset=utf-8' }, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>Thank you, ${escapeHtml(fields.name || fields.email || 'visitor')}.</p></body></html>`);
        return;
      }
      if (url.pathname.startsWith('/pages/')) {
        const file = resolve(pagesRoot, decodeURIComponent(url.pathname.slice('/pages/'.length)));
        if (!file.startsWith(pagesRoot + sep) || !file.endsWith('.html')) { send(response, 404, {}, 'Not found'); return; }
        try { send(response, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, await readFile(file)); }
        catch { send(response, 404, {}, 'Not found'); }
        return;
      }
      send(response, 404, {}, 'Not found');
    } catch (error) {
      try { json(response, 500, { error: { message: error.message } }); } catch { /* The response was already sent. */ }
    }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const { port } = server.address();
  return { port, origin: `http://127.0.0.1:${port}`, report, forms, modelRequests, progress, setModel: (name, script) => models.set(name, script),
    close: () => new Promise(resolveClose => { server.closeAllConnections?.(); server.close(() => resolveClose()); }) };
}
