import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { createServer } from 'node:http';
import { createAiProviderService, signAwsRequest } from '../bridge/ai/providers.mjs';
import { crc32, validateProviderUrl, readJson } from '../bridge/ai/http.mjs';

const FAKE_KEY = 'unit-test-api-key-never-a-real-credential';
const prompt = { system: 'Use only the supplied context.', messages: [{ role: 'user', content: 'Summarize my notes.' }] };
async function serviceFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'still-ai-test-'));
  t.after(async () => {
    // This test owns only this mkdtemp child. Verify the absolute recursive target.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('still-ai-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = join(directory, 'providers.enc.json');
  return { directory, configPath, service: createAiProviderService({ configPath, ...options }) };
}
function responseStream(source, { contentType = 'text/event-stream', split = 7 } = {}) {
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source;
  return new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += split) controller.enqueue(bytes.subarray(index, index + split)); controller.close(); } }), { headers: { 'Content-Type': contentType } });
}
const sse = (...events) => events.map(event => typeof event === 'string' ? `data: ${event}\r\n\r\n` : `event: ${event.type || 'message'}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('');
const chatStream = () => responseStream(`: keep-alive\r\n\r\n${sse({ choices: [{ delta: { content: 'Hello ' }, finish_reason: null }] }, { choices: [{ delta: { content: 'world' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2 } }, '[DONE]')}`);
async function provider(service, type = 'openai', extra = {}) {
  return service.saveProvider({ type, name: `Test ${type}`, model: 'explicit-model-id', baseUrl: type.endsWith('-compatible') ? 'https://compatible.example/v1' : undefined, credentials: { apiKey: FAKE_KEY }, ...extra });
}

test('provider CRUD is encrypted, sanitized, persistent and does not make implicit network calls', async t => {
  let calls = 0;
  const fixture = await serviceFixture(t, { fetch: async () => { calls++; throw new Error('Unexpected request'); } });
  assert.deepEqual(await fixture.service.listProviders(), []);
  const saved = await provider(fixture.service);
  assert.equal(saved.hasCredentials, true); assert.equal(saved.credentials, undefined); assert.equal(JSON.stringify(saved).includes(FAKE_KEY), false);
  const disk = await readFile(fixture.configPath, 'utf8');
  assert.equal(disk.includes(FAKE_KEY), false); assert.equal(disk.includes('Test openai'), false);
  assert.equal((await readFile(`${fixture.configPath}.key`)).length, 32);
  if (process.platform !== 'win32') assert.equal((await stat(`${fixture.configPath}.key`)).mode & 0o077, 0);
  const reopened = createAiProviderService({ configPath: fixture.configPath });
  assert.equal((await reopened.listProviders())[0].id, saved.id);
  await Promise.all(['One', 'Two', 'Three'].map(name => fixture.service.saveProvider({ type: 'ollama', name, model: 'local' })));
  assert.equal((await fixture.service.listProviders()).length, 4);
  await fixture.service.saveProvider({ id: saved.id, name: 'Renamed', credentials: { apiKey: '' } });
  assert.equal((await fixture.service.listProviders()).find(entry => entry.id === saved.id).hasCredentials, true);
  await fixture.service.deleteProvider(saved.id);
  assert.equal((await fixture.service.listProviders()).length, 3);
  assert.equal(calls, 0);
});
test('selecting provider defaults clears previous optional controls without changing the saved credential or model',async t=>{
 const {service}=await serviceFixture(t);
 const original=await provider(service,'openai',{config:{temperature:.3,reasoningEffort:'high',contextWindow:64000},capabilities:{temperature:true,reasoningEfforts:['high']}});
 const updated=await service.saveProvider({id:original.id,config:{temperature:null,reasoningEffort:null,contextWindow:null},capabilities:{temperature:false,reasoningEfforts:[]}});
 assert.equal(updated.config.temperature,undefined);assert.equal(updated.config.reasoningEffort,undefined);assert.equal(updated.config.contextWindow,undefined);assert.equal(updated.model,original.model);assert.equal(updated.hasCredentials,true);
});

test('tampered ciphertext fails closed without replacing saved credentials', async t => {
  const { service, configPath } = await serviceFixture(t);
  await provider(service);
  const record = JSON.parse(await readFile(configPath, 'utf8'));
  const data = Buffer.from(record.data, 'base64'); data[0] ^= 1; record.data = data.toString('base64');
  const tampered = JSON.stringify(record); await writeFile(configPath, tampered);
  await assert.rejects(service.listProviders(), /cannot be decrypted/);
  await assert.rejects(service.saveProvider({ type: 'ollama', name: 'Should not overwrite' }), /cannot be decrypted/);
  assert.equal(await readFile(configPath, 'utf8'), tampered);
});

test('provider URL and credential validation reject unsafe settings before storage or requests', async t => {
  const { service } = await serviceFixture(t);
  for (const baseUrl of ['http://remote.example/v1', 'https://user:password@example.com', 'https://example.com/?api_key=secret', 'file:///secret', 'javascript:alert(1)']) {
    await assert.rejects(provider(service, 'openai-compatible', { baseUrl }));
  }
  assert.equal(validateProviderUrl('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1');
  await assert.rejects(provider(service, 'openai', { credentials: { apiKey: 'bad\r\nheader' } }), /newlines/);
  assert.deepEqual(await service.listProviders(), []);
});

test('OpenAI Responses streams fragmented UTF-8 live, uses exact model, and omits unsupported controls', async t => {
  let sent; const deltas = [];
  const { service } = await serviceFixture(t, { fetch: async (url, options) => {
    sent = { url, ...options, body: JSON.parse(options.body) };
    return responseStream(sse({ type: 'response.output_text.delta', delta: 'Hello 🌙' }, { type: 'response.output_text.delta', delta: ' notes.' }, { type: 'response.completed', response: { model: 'served-model-id', usage: { input_tokens: 5, output_tokens: 4 } } }), { split: 2 });
  } });
  const saved = await provider(service);
  const result = await service.generate({ providerId: saved.id, ...prompt, onDelta: text => { deltas.push(text); } });
  assert.equal(result.text, 'Hello 🌙 notes.'); assert.deepEqual(deltas, ['Hello 🌙', ' notes.']);
  assert.equal(result.model, 'served-model-id'); assert.equal(result.usage.output_tokens, 4);
  assert.equal(sent.url, 'https://api.openai.com/v1/responses'); assert.equal(sent.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(sent.body.model, 'explicit-model-id'); assert.equal(sent.body.store, false); assert.equal(sent.body.stream, true);
  assert.equal(sent.body.temperature, undefined); assert.equal(sent.body.reasoning, undefined); assert.equal(sent.redirect, 'error');
  assert.deepEqual(sent.body.input[0].content, [{ type: 'input_text', text: 'Summarize my notes.' }]);
});

test('Anthropic Messages maps image blocks, explicit effort and temperature, and usage events', async t => {
  let sent;
  const { service } = await serviceFixture(t, { fetch: async (url, options) => {
    sent = { url, ...options, body: JSON.parse(options.body) };
    return responseStream(sse({ type: 'message_start', message: { model: 'anthropic-model', usage: { input_tokens: 8 } } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A visual note' } }, { type: 'message_delta', usage: { output_tokens: 3 }, delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }));
  } });
  const saved = await provider(service, 'anthropic', { capabilities: { images: true, temperature: true, reasoningEfforts: ['high'] } });
  const result = await service.generate({ providerId: saved.id, system: prompt.system, messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe' }, { type: 'image', dataUrl: 'data:image/png;base64,AA==' }] }], reasoningEffort: 'high', temperature: 0.5 });
  assert.equal(result.text, 'A visual note'); assert.deepEqual(result.usage, { input_tokens: 8, output_tokens: 3 });
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages'); assert.equal(sent.headers['x-api-key'], FAKE_KEY);
  assert.equal(sent.body.output_config.effort, 'high'); assert.equal(sent.body.thinking.type, 'adaptive');
  assert.equal(sent.body.temperature, 0.5); assert.equal(sent.body.messages[0].content[1].source.media_type, 'image/png');
});

test('Chat Completions adapters route compatible, OpenRouter, Cloudflare and LM Studio correctly', async t => {
  const requests = [];
  const { service } = await serviceFixture(t, { fetch: async (url, options) => { requests.push({ url, ...options, body: JSON.parse(options.body) }); return chatStream(); } });
  const types = [
    ['openai-compatible', 'https://compatible.example/v1/chat/completions', {}],
    ['openrouter', 'https://openrouter.ai/api/v1/chat/completions', {}],
    ['cloudflare', 'https://api.cloudflare.com/client/v4/accounts/account123/ai/v1/chat/completions', { config: { accountId: 'account123' }, credentials: { apiToken: FAKE_KEY } }],
    ['lmstudio', 'http://127.0.0.1:1234/v1/chat/completions', { credentials: {} }],
  ];
  for (const [type, endpoint, extra] of types) {
    const saved = await provider(service, type, extra);
    const result = await service.generate({ providerId: saved.id, ...prompt });
    assert.equal(result.text, 'Hello world'); assert.equal(requests.at(-1).url, endpoint);
    assert.equal(requests.at(-1).body.messages[0].role, 'system');
    assert.equal(result.usage.completion_tokens, 2);
  }
});

test('Gemini SSE and Ollama NDJSON preserve message roles and generation settings', async t => {
  const requests = [];
  const { service } = await serviceFixture(t, { fetch: async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    return url.includes('/api/chat')
      ? responseStream(`${JSON.stringify({ message: { content: 'Local ' }, done: false })}\n${JSON.stringify({ message: { content: 'answer' }, done: true, prompt_eval_count: 5, eval_count: 2 })}\n`, { contentType: 'application/x-ndjson' })
      : responseStream(sse({ candidates: [{ content: { parts: [{ text: 'Gemini answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 6 }, modelVersion: 'returned-model' }));
  } });
  const gemini = await provider(service, 'gemini', { capabilities: { reasoningEfforts: ['low'] } });
  const result = await service.generate({ providerId: gemini.id, ...prompt, reasoningEffort: 'low' });
  assert.equal(result.text, 'Gemini answer'); assert.equal(result.model, 'returned-model');
  assert.equal(requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/explicit-model-id:streamGenerateContent?alt=sse');
  assert.equal(requests[0].headers['x-goog-api-key'], FAKE_KEY); assert.equal(requests[0].body.generationConfig.thinkingConfig.thinkingLevel, 'low');
  const ollama = await provider(service, 'ollama', { credentials: {}, capabilities: { temperature: true }, config: { temperature: 0.2 } });
  const local = await service.generate({ providerId: ollama.id, ...prompt });
  assert.equal(local.text, 'Local answer'); assert.equal(requests[1].body.options.temperature, 0.2);
  assert.equal(requests[1].headers.Authorization, undefined);
});

test('model discovery is explicit, preserves provider model IDs and does not claim inference testing', async t => {
  let requests = 0;
  const { service } = await serviceFixture(t, { fetch: async url => { requests++; return url.includes('cloudflare') ? Response.json({ result: [{ id: 'internal-uuid', name: '@cf/vendor/model' }] }) : Response.json({ data: [{ id: 'real-model-id', display_name: 'Actual model', capabilities: { image_input: { supported: true }, effort: { supported: true, high: { supported: true } } } }] }); } });
  const saved = await provider(service);
  assert.equal(requests, 0);
  const tested = await service.testProvider(saved.id);
  assert.equal(tested.ok, true); assert.equal(tested.inferenceTested, false); assert.equal(tested.models[0].id, 'real-model-id');
  assert.equal(tested.models[0].supportsImages, true); assert.deepEqual(tested.models[0].reasoningEfforts, ['high']);
  const cf = await provider(service, 'cloudflare', { config: { accountId: 'account123' } });
  assert.equal((await service.listModels(cf.id))[0].id, '@cf/vendor/model');
});

function awsFrame(type, payload, messageType = 'event') {
  const encodedHeader = (name, value) => { const key = Buffer.from(name), text = Buffer.from(value), size = Buffer.alloc(2); size.writeUInt16BE(text.length); return Buffer.concat([Buffer.from([key.length]), key, Buffer.from([7]), size, text]); };
  const headers = Buffer.concat([encodedHeader(':message-type', messageType), encodedHeader(':event-type', type)]);
  const data = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(16 + headers.length + data.length);
  frame.writeUInt32BE(frame.length); frame.writeUInt32BE(headers.length, 4); frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
  headers.copy(frame, 12); data.copy(frame, 12 + headers.length); frame.writeUInt32BE(crc32(frame.subarray(0, frame.length - 4)), frame.length - 4);
  return frame;
}

test('AWS SigV4 matches the Smithy published signing fixture and signs temporary tokens', () => {
  const signed = signAwsRequest({ url: 'https://foo.us-bar-1.amazonaws.com/', method: 'POST', service: 'foo', region: 'us-bar-1', body: '', credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' }, headers: {}, date: new Date('2000-01-01T00:00:00Z') });
  assert.equal(signed.authorization, 'AWS4-HMAC-SHA256 Credential=foo/20000101/us-bar-1/foo/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=1e3b24fcfd7655c0c245d99ba7b6b5ca6174eab903ebfbda09ce457af062ad30');
  const temporary = signAwsRequest({ url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/arn%3Aaws%3Abedrock%2Fmodel/converse-stream', region: 'us-east-1', credentials: { accessKeyId: 'foo', secretAccessKey: 'bar', sessionToken: 'test-session-token' }, date: new Date('2000-01-01T00:00:00Z') });
  assert.equal(temporary['x-amz-security-token'], 'test-session-token');
  assert.match(temporary.authorization, /x-amz-security-token/);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('Bedrock validates AWS event CRCs and streams text with actual usage metadata', async t => {
  let sent;
  const stream = Buffer.concat([awsFrame('contentBlockDelta', { delta: { text: 'Bedrock answer' }, contentBlockIndex: 0 }), awsFrame('messageStop', { stopReason: 'end_turn' }), awsFrame('metadata', { usage: { inputTokens: 12, outputTokens: 3 } })]);
  const { service } = await serviceFixture(t, { now: () => new Date('2026-10-25T12:00:00Z'), fetch: async (url, options) => { sent = { url, ...options, body: JSON.parse(options.body) }; return responseStream(stream, { contentType: 'application/vnd.amazon.eventstream', split: 3 }); } });
  const saved = await provider(service, 'bedrock', { config: { region: 'us-west-2' }, credentials: { accessKeyId: 'test-access-id', secretAccessKey: 'test-secret-key', sessionToken: 'test-session' } });
  const result = await service.generate({ providerId: saved.id, ...prompt });
  assert.equal(result.text, 'Bedrock answer'); assert.equal(result.usage.outputTokens, 3);
  assert.equal(sent.url, 'https://bedrock-runtime.us-west-2.amazonaws.com/model/explicit-model-id/converse-stream');
  assert.match(sent.headers.authorization, /20261025\/us-west-2\/bedrock\/aws4_request/);
  assert.equal(sent.headers['x-amz-security-token'], 'test-session');
  assert.equal(sent.body.messages[0].content[0].text, 'Summarize my notes.');
});

test('AWS default credential chain runs only after an explicit operation with allowlisted arguments', async t => {
  let executions = 0;
  const { service } = await serviceFixture(t, { execFile: async (command, args, options) => {
    executions++; assert.equal(command, 'aws'); assert.deepEqual(args, ['configure', 'export-credentials', '--format', 'process', '--profile', 'work']);
    assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
    return { stdout: JSON.stringify({ Version: 1, AccessKeyId: 'fake-aws-access', SecretAccessKey: 'fake-aws-secret', SessionToken: 'fake-aws-session' }) };
  }, fetch: async (url, options) => { assert.equal(url, 'https://bedrock.us-east-1.amazonaws.com/foundation-models'); assert.match(options.headers.authorization, /fake-aws-access/); return Response.json({ modelSummaries: [{ modelId: 'aws-real-model-id', modelName: 'A model' }] }); } });
  const saved = await provider(service, 'bedrock', { config: { useDefaultCredentials: true, profile: 'work' }, credentials: {} });
  assert.equal(executions, 0);
  const models = await service.listModels(saved.id);
  assert.equal(executions, 1); assert.equal(models[0].id, 'aws-real-model-id');
  assert.equal(JSON.stringify(await service.listProviders()).includes('fake-aws-secret'), false);
});

test('truncated streams, malformed events and late provider failures retain partial text without claiming completion', async t => {
  for (const ending of ['', 'data: not-json\n\n', sse({ error: { message: `Rejected ${FAKE_KEY}` } })]) {
    const { service } = await serviceFixture(t, { fetch: async () => responseStream(sse({ type: 'response.output_text.delta', delta: 'Partial answer' }) + ending) });
    const saved = await provider(service);
    await assert.rejects(service.generate({ providerId: saved.id, ...prompt }), error => {
      assert.equal(error.partialText, 'Partial answer'); assert.equal(error.aborted, false); assert.equal(error.message.includes(FAKE_KEY), false); return true;
    });
  }
  const corrupted = awsFrame('messageStop', { stopReason: 'end_turn' }); corrupted[corrupted.length - 1] ^= 1;
  const { service } = await serviceFixture(t, { fetch: async () => responseStream(corrupted) });
  const saved = await provider(service, 'bedrock', { credentials: { accessKeyId: 'test-id', secretAccessKey: 'test-secret' } });
  await assert.rejects(service.generate({ providerId: saved.id, ...prompt }), /checksum mismatch/);
});

test('abort stops live streaming and prevents a pre-aborted request from reaching a provider', async t => {
  let calls = 0;
  const { service } = await serviceFixture(t, { fetch: async () => { calls++; return responseStream(sse({ type: 'response.output_text.delta', delta: 'First' }, { type: 'response.output_text.delta', delta: 'Second' }, { type: 'response.completed', response: {} })); } });
  const saved = await provider(service);
  const controller = new AbortController();
  await assert.rejects(service.generate({ providerId: saved.id, ...prompt, signal: controller.signal, onDelta: () => controller.abort() }), error => error.aborted && error.partialText === 'First');
  const already = new AbortController(); already.abort();
  await assert.rejects(service.generate({ providerId: saved.id, ...prompt, signal: already.signal }), error => error.aborted);
  assert.equal(calls, 1);
});

test('HTTP redirects cannot forward credentials and HTTP errors are redacted without retry', async t => {
  let calls = 0;
  const server = createServer((request, response) => { calls++; response.writeHead(302, { Location: '/steal-credentials' }); response.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const { service } = await serviceFixture(t);
  const saved = await provider(service, 'openai-compatible', { baseUrl: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(service.generate({ providerId: saved.id, ...prompt }));
  assert.equal(calls, 1);
  let errors = 0;
  const redacted = await serviceFixture(t, { fetch: async () => { errors++; return Response.json({ error: { message: `Invalid credential ${FAKE_KEY}` } }, { status: 401 }); } });
  const api = await provider(redacted.service);
  await assert.rejects(redacted.service.generate({ providerId: api.id, ...prompt }), error => !error.message.includes(FAKE_KEY) && error.message.includes('[redacted]'));
  assert.equal(errors, 1);
});

test('unsupported effort, temperature and image input fail before provider invocation', async t => {
  let calls = 0;
  const { service } = await serviceFixture(t, { fetch: async () => { calls++; return chatStream(); } });
  const saved = await provider(service);
  await assert.rejects(service.generate({ providerId: saved.id, ...prompt, reasoningEffort: 'ultra' }), /not enabled/);
  await assert.rejects(service.generate({ providerId: saved.id, ...prompt, temperature: 0.7 }), /disabled/);
  await assert.rejects(service.generate({ providerId: saved.id, messages: [{ role: 'user', content: [{ type: 'image', dataUrl: 'data:image/png;base64,AA==' }] }] }), /Enable image input/);
  await assert.rejects(service.generate({ providerId: saved.id, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://remote.example/private.png' } }] }] }), /base64/);
  assert.equal(calls, 0);
});

test('an abort arriving after fetch but before body parsing cancels and releases the response reader', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readJson(response, { signal: controller.signal }), /abort/i);
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});
