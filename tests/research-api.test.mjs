import test from 'node:test';
import assert from 'node:assert/strict';
import { MANAGED_AGENTS_BETA, createManagedClient, managedHeaders } from '../extension/lib/ai/research/api.js';
import { KEY, chunkedResponse, json, sseFrame } from './research-fake-server.mjs';

const BASE = 'https://api.anthropic.com/v1';
const connection = { id: 'anthropic-1', workspaceId: 'wrkspc_123' };

function client(handler, extra = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null, signal: options.signal };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { calls, api: createManagedClient({ apiKey: KEY, baseUrl: BASE, connection, fetchImpl, ...extra }) };
}

test('headers: managed-agents beta, 2026-10-21, key, browser access and workspace; never the fallback beta', async () => {
  const headers = managedHeaders({ baseUrl: BASE, apiKey: KEY, connection });
  assert.equal(headers['anthropic-beta'], MANAGED_AGENTS_BETA);
  assert.equal(headers['anthropic-beta'], 'managed-agents-2026-04-01');
  assert.equal(headers['anthropic-version'], '2026-10-21');
  assert.equal(headers['x-api-key'], KEY);
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(headers['anthropic-workspace-id'], 'wrkspc_123');
  assert.equal(headers['content-type'], 'application/json');
  assert.ok(!headers['anthropic-beta'].includes('fallback'));
  assert.equal(managedHeaders({ baseUrl: BASE, apiKey: KEY, connection }, { stream: true }).accept, 'text/event-stream');

  const { calls, api } = client(() => json({ id: 'agent_1', version: 2 }));
  await api.updateAgent('agent_1', { name: 'x' }, { version: 1 });
  await api.interrupt('sesn_1');
  await api.createSession({ agent: 'agent_1' });
  assert.deepEqual(calls.map(call => `${call.method} ${call.url.replace(BASE, '')}`), ['POST /agents/agent_1', 'POST /sessions/sesn_1/events', 'POST /sessions']);
  assert.deepEqual(calls[0].body, { name: 'x', version: 1 }, 'optimistic concurrency version travels in the body');
  assert.deepEqual(calls[1].body, { events: [{ type: 'user.interrupt' }] });
  for (const call of calls) assert.equal(call.headers['anthropic-beta'], 'managed-agents-2026-04-01');
  assert.throws(() => api.getSession(''), /not valid/);
});

test('streamEvents parses SSE split across chunks: skips pings, comments and untyped frames, keeps unknown types, maps status_idle', async () => {
  const events = [
    { type: 'session.status_running', id: 'sevt_1', processed_at: 't' },
    { type: 'event_start', event: { type: 'agent.message', id: 'sevt_2' } },
    { type: 'event_delta', event_id: 'sevt_2', delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'Hel' } } },
    { type: 'agent.message', id: 'sevt_2', content: [{ type: 'text', text: 'Hello “world”' }], extra: { nested: true } },
    { type: 'brand_new.event', id: 'sevt_3', whatever: 1 },
  ];
  const text = `: comment\r\n\r\nevent: ping\r\ndata: {}\r\n\r\n${events.map(event => sseFrame(event)).join('').replace(/\n/g, '\r\n')}data: not json\n\ndata: {"no":"type"}\n\n`
    + `event: status_idle\ndata: {"type":"status_idle","id":"sevt_4","stop_reason":{"type":"end_turn"}}\n\n`;
  for (const size of [1, 3, 7, 64]) {
    const { calls, api } = client(() => chunkedResponse(text, { size }));
    const stream = api.streamEvents('sesn_1', { deltas: ['agent.message', 'bogus'] });
    assert.equal(await stream.opened, true);
    const got = [];
    for await (const event of stream) got.push(event);
    assert.deepEqual(got.map(event => event.type), ['session.status_running', 'event_start', 'event_delta', 'agent.message', 'brand_new.event', 'session.status_idle'], `chunk size ${size}`);
    assert.equal(got[3].content[0].text, 'Hello “world”', 'multi-byte text survives chunk splits');
    assert.equal(got[3].extra.nested, true, 'extra fields survive');
    assert.match(calls[0].url, /\/sessions\/sesn_1\/events\/stream\?event_deltas%5B%5D=agent\.message$/, 'only accepted delta types are requested');
    assert.equal(calls[0].headers.accept, 'text/event-stream');
  }
});

test('streamEvents: an in-band error frame throws a friendly error; a quiet stream throws a reconnectable stream_idle', async () => {
  const errorFrame = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
  const { api } = client(() => chunkedResponse(sseFrame({ type: 'session.status_running', id: 'a' }) + errorFrame));
  const seen = [];
  await assert.rejects(async () => { for await (const event of api.streamEvents('s')) seen.push(event.type); }, error => error.code === 'provider_down');
  assert.deepEqual(seen, ['session.status_running']);

  const quiet = client(() => chunkedResponse(sseFrame({ type: 'session.status_running', id: 'a' }), { hold: true }));
  const started = Date.now();
  await assert.rejects(async () => { for await (const event of quiet.api.streamEvents('s', { idleMs: 60 })) seen.push(event.type); },
    error => error.code === 'stream_idle' && error.reconnect === true);
  assert.ok(Date.now() - started < 2000);

  // The caller's own abort is an abort, not a reconnect.
  const controller = new AbortController();
  const held = client(() => chunkedResponse('', { hold: true }));
  const stream = held.api.streamEvents('s', { signal: controller.signal, idleMs: 5000 });
  await stream.opened;
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(async () => { for await (const event of stream) seen.push(event); }, error => error.code === 'aborted');
});

test('listAllEvents follows next_page in order and stops on a repeated cursor', async () => {
  const pages = { '': { data: [{ id: 'e1', type: 'a' }, { id: 'e2', type: 'b' }], next_page: 'p2' }, p2: { data: [{ id: 'e3', type: 'c' }, 'junk'], next_page: 'p3' }, p3: { data: [], next_page: 'p3' } };
  const { calls, api } = client(call => json(pages[new URL(call.url).searchParams.get('page') || '']));
  const ids = [];
  for await (const event of api.listAllEvents('sesn_9')) ids.push(event.id);
  assert.deepEqual(ids, ['e1', 'e2', 'e3']);
  assert.equal(calls.length, 3);
  const query = new URL(calls[0].url).searchParams;
  assert.equal(query.get('order'), 'asc');
  assert.equal(query.get('limit'), '1000');
});

test('errors reuse the assistant codes, name the missing resource, flag the spending cap, and never leak the key', async () => {
  const cases = [
    [json({ type: 'error', error: { type: 'authentication_error', message: `bad key ${KEY}` } }, 401), 'auth'],
    [json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429, { 'retry-after': '7' }), 'rate_limit'],
    [json({ type: 'error', error: { type: 'not_found_error', message: 'nope' } }, 404), 'not_found'],
    [json({ type: 'error', error: { type: 'invalid_request_error', message: 'budget.max_list_cost must be greater than the session\'s consumed list cost' } }, 400), 'budget'],
    [json({ type: 'error', error: { type: 'invalid_request_error', message: 'Version mismatch' } }, 409), 'bad_request'],
    [json({ type: 'error', error: { type: 'invalid_request_error', message: 'API key is not scoped to a workspace; pass anthropic-workspace-id' } }, 400), 'workspace_required'],
    [json({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, 529), 'provider_down'],
  ];
  for (const [response, code] of cases) {
    const { api } = client(() => response);
    const error = await api.getSession('sesn_1').catch(error => error);
    assert.equal(error.code, code, code);
    assert.ok(!error.message.includes(KEY) && !String(error.detail || '').includes(KEY), 'key redacted');
    if (code === 'rate_limit') assert.equal(error.retryAfter, 7);
    if (code === 'not_found') assert.match(error.message, /research session no longer exists/);
    if (code === 'budget') assert.match(error.message, /above what this research has already spent/);
    if (response.status === 409) assert.equal(error.status, 409, 'provisioning tells a version conflict apart by status');
  }
  const { api } = client(() => { throw new TypeError('Failed to fetch'); });
  assert.equal((await api.createAgent({}).catch(error => error)).code, 'network');
  const missingAgent = client(() => json({ type: 'error', error: { type: 'not_found_error', message: 'x' } }, 404));
  assert.match((await missingAgent.api.getAgent('agent_1').catch(error => error)).message, /research agent is missing/);
  assert.throws(() => createManagedClient({ apiKey: '', baseUrl: BASE }), error => error.code === 'auth');
});
