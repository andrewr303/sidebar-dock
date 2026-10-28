import test from 'node:test';
import assert from 'node:assert/strict';
import { readSse, readNdjson } from '../extension/lib/ai/stream.js';
import { providerFetch, friendlyHttpError, streamError } from '../extension/lib/ai/http.js';
import { redactSecrets, redactError, validateApiKey } from '../extension/lib/ai/secrets.js';
import { getProvider } from '../extension/lib/ai/catalog.js';

const encoder = new TextEncoder();
function chunked(text, size) {
  const bytes = encoder.encode(text);
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.subarray(i, i + size)); controller.close(); } }));
}
async function collect(iterator) { const output = []; for await (const value of iterator) output.push(value); return output; }
function withFetch(t, impl) { const previous = globalThis.fetch; globalThis.fetch = impl; t.after(() => { globalThis.fetch = previous; }); }
function withChrome(t, value) { const previous = globalThis.chrome; globalThis.chrome = value; t.after(() => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; }); }

const SSE = 'event: message_start\ndata: {"type":"message_start"}\n\n: keep-alive comment\n\nevent: delta\r\ndata: {"text":"café ☃"}\r\n\r\ndata: line one\ndata: line two\n\ndata: [DONE]\n\n';

test('readSse yields identical events for every chunk size, including split UTF-8 and CRLF', async () => {
  const expected = [
    { event: 'message_start', data: '{"type":"message_start"}' },
    { event: 'delta', data: '{"text":"café ☃"}' },
    { event: 'message', data: 'line one\nline two' },
    { event: 'message', data: '[DONE]' },
  ];
  for (const size of [1, 2, 3, 5, 8, 13, 64, 4096]) assert.deepEqual(await collect(readSse(chunked(SSE, size))), expected, `chunk size ${size}`);
});

test('readSse treats lone CR as a line ending, waits on a trailing CR and flushes a final event without a blank line', async () => {
  assert.deepEqual(await collect(readSse(chunked('data: a\rdata: b\r\rdata: tail', 1))), [{ event: 'message', data: 'a\nb' }, { event: 'message', data: 'tail' }]);
  // CRLF split across chunks must not produce an extra blank line that would cut the event in two.
  assert.deepEqual(await collect(readSse(chunked('data: x\r\ndata: y\r\n\r\n', 8))), [{ event: 'message', data: 'x\ny' }]);
});

test('readNdjson parses objects across chunk boundaries and rejects broken lines', async () => {
  const text = '{"a":1}\n\n{"b":"ü"}\r\n{"c":[1,2]}';
  for (const size of [1, 4, 100]) assert.deepEqual(await collect(readNdjson(chunked(text, size))), [{ a: 1 }, { b: 'ü' }, { c: [1, 2] }]);
  await assert.rejects(collect(readNdjson(chunked('{"a":1}\n{oops\n', 3))), /unreadable stream event/);
});

test('aborting a stream stops the read promptly with an AbortError', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(stream) { stream.enqueue(encoder.encode('data: first\n\n')); },
    cancel() { cancelled = true; },
  }));
  const events = [];
  const started = Date.now();
  await assert.rejects((async () => {
    for await (const event of readSse(response, { signal: controller.signal })) { events.push(event); setTimeout(() => controller.abort(), 10); }
  })(), error => error.name === 'AbortError' && error.code === 'aborted');
  assert.equal(events.length, 1);
  assert.ok(Date.now() - started < 1000);
  assert.equal(cancelled, true);
});

test('friendly HTTP errors cover key, model, rate limit, outage and Ollama origin problems', () => {
  const anthropic = getProvider('anthropic');
  assert.match(friendlyHttpError({ status: 401, provider: anthropic }).message, /^Check the API key/);
  assert.equal(friendlyHttpError({ status: 401, provider: anthropic }).code, 'auth');
  assert.match(friendlyHttpError({ status: 404, provider: anthropic, model: 'claude-x' }).message, /could not find the model claude-x/);
  assert.match(friendlyHttpError({ status: 429, provider: anthropic, retryAfter: 3 }).message, /Rate limited by Anthropic\. Try again in 3 s/);
  assert.equal(friendlyHttpError({ status: 529, provider: anthropic }).code, 'provider_down');
  assert.match(friendlyHttpError({ status: 503, provider: getProvider('openai') }).message, /OpenAI is having trouble right now \(HTTP 503\)/);
  assert.match(friendlyHttpError({ status: 403, provider: getProvider('ollama') }).message, /OLLAMA_ORIGINS=chrome-extension:\/\/\*/);
  assert.match(friendlyHttpError({ status: 400, provider: anthropic, detail: 'This API key is not scoped to a workspace.' }).message, /workspace ID/);
  assert.equal(streamError({ type: 'overloaded_error', message: 'Overloaded', provider: anthropic }).code, 'provider_down');
  assert.equal(streamError({ type: 'rate_limit_error', provider: anthropic }).code, 'rate_limit');
});

test('providerFetch maps HTTP failures and never leaks the key a provider echoes back', async t => {
  const key = 'sk-ant-api03-SECRETSECRETSECRET-1234567890';
  withFetch(t, async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    return new Response(JSON.stringify({ error: { message: `Invalid key ${key} (Bearer ${key})` } }), { status: 400, headers: { 'content-type': 'application/json' } });
  });
  const error = await providerFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: { a: 1 }, provider: getProvider('anthropic'), secrets: [key] }).catch(caught => caught);
  assert.equal(error.code, 'bad_request');
  assert.ok(!error.message.includes(key) && !error.detail.includes(key));
  assert.ok(!error.message.includes('SECRETSECRET'));
  assert.match(error.message, /\[redacted\]/);

  withFetch(t, async () => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }));
  const limited = await providerFetch('https://api.openai.com/v1/models', { provider: getProvider('openai') }).catch(caught => caught);
  assert.equal(limited.code, 'rate_limit');
  assert.equal(limited.retryAfter, 7);
});

test('network failures name the host, and ask for access when the host permission is missing', async t => {
  withFetch(t, async () => { throw new TypeError('Failed to fetch'); });
  withChrome(t, { permissions: { contains: async ({ origins }) => { assert.deepEqual(origins, ['https://api.openai.com/*']); return false; } } });
  const denied = await providerFetch('https://api.openai.com/v1/responses', { provider: getProvider('openai') }).catch(caught => caught);
  assert.equal(denied.code, 'permission');
  assert.equal(denied.message, 'Allow Still to reach api.openai.com.');
  globalThis.chrome = { permissions: { contains: async () => true } };
  const offline = await providerFetch('https://api.openai.com/v1/responses', { provider: getProvider('openai') }).catch(caught => caught);
  assert.equal(offline.code, 'network');
  const local = await providerFetch('http://localhost:11434/api/tags', { provider: getProvider('ollama') }).catch(caught => caught);
  assert.match(local.message, /Could not reach Ollama at localhost:11434\. Make sure it is running/);
});

test('providerFetch times out waiting for headers and honours an already-aborted signal', async t => {
  withFetch(t, (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
  const slow = await providerFetch('https://api.x.ai/v1/models', { provider: getProvider('xai'), timeoutMs: 20 }).catch(caught => caught);
  assert.equal(slow.code, 'timeout');
  const controller = new AbortController(); controller.abort();
  const stopped = await providerFetch('https://api.x.ai/v1/models', { signal: controller.signal }).catch(caught => caught);
  assert.equal(stopped.name, 'AbortError');
});

test('redaction removes explicit secrets and anything shaped like a provider key', () => {
  const text = 'key sk-proj-abcdefghijklmnop1234 and AIzaSyA1234567890abcdefghijklmn and Bearer abc.def.ghi123 x-api-key: my-own-secret-value ?key=zzzzzz&x=1 custom-token-9876';
  const clean = redactSecrets(text, ['custom-token-9876']);
  for (const leaked of ['sk-proj-abcdefghijklmnop1234', 'AIzaSyA1234567890abcdefghijklmn', 'abc.def.ghi123', 'my-own-secret-value', 'zzzzzz', 'custom-token-9876']) assert.ok(!clean.includes(leaked), leaked);
  const error = redactError(new Error('failed with custom-token-9876'), ['custom-token-9876']);
  assert.equal(error.message, 'failed with [redacted]');
  assert.throws(() => validateApiKey('sk-with space'), /without spaces/);
  assert.equal(validateApiKey('  sk-abc  '), 'sk-abc');
});

test('readSse and readNdjson stop handing out events buffered in the same chunk once the caller aborts', async () => {
  const controller = new AbortController();
  const events = [];
  await assert.rejects((async () => {
    for await (const event of readSse(chunked('data: 1\n\ndata: 2\n\ndata: 3\n\n', 4096), { signal: controller.signal })) { events.push(event.data); controller.abort(); }
  })(), error => error.code === 'aborted');
  assert.deepEqual(events, ['1']);
  const lines = new AbortController();
  const objects = [];
  await assert.rejects((async () => {
    for await (const value of readNdjson(chunked('{"n":1}\n{"n":2}\n{"n":3}\n', 4096), { signal: lines.signal })) { objects.push(value.n); lines.abort(); }
  })(), error => error.code === 'aborted');
  assert.deepEqual(objects, [1]);
});
