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

test('Anthropic Messages uses API version 2026-10-21 with summarized adaptive thinking, effort, caching and images, and never sends sampling controls', async t => {
  let sent, calls = 0; const thoughts = [];
  const { service } = await serviceFixture(t, { fetch: async (url, options) => {
    calls++; sent = { url, ...options, body: JSON.parse(options.body) };
    return responseStream(sse({ type: 'message_start', message: { model: 'anthropic-model', usage: { input_tokens: 8 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Looking at the image.' } }, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque' } }, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'A visual note' } }, { type: 'message_delta', usage: { output_tokens: 3 }, delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }));
  } });
  // Temperature is ignored as a capability and rejected as a stored setting for Anthropic types.
  const saved = await provider(service, 'anthropic', { capabilities: { images: true, temperature: true, reasoningEfforts: ['high'] } });
  assert.equal(saved.capabilities.temperature, false);
  await assert.rejects(provider(service, 'anthropic', { config: { temperature: 0.3 } }), /temperature/);
  const result = await service.generate({ providerId: saved.id, system: prompt.system, messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe' }, { type: 'image', dataUrl: 'data:image/png;base64,AA==' }] }], reasoningEffort: 'high', onThinking: text => { thoughts.push(text); } });
  assert.equal(result.text, 'A visual note'); assert.deepEqual(result.usage, { input_tokens: 8, output_tokens: 3 });
  assert.deepEqual(thoughts, ['Looking at the image.']); assert.equal(result.thinking, 'Looking at the image.');
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages'); assert.equal(sent.headers['x-api-key'], FAKE_KEY); assert.equal(sent.headers['anthropic-version'], '2026-10-21');
  assert.equal(sent.headers['anthropic-beta'], undefined); assert.equal(sent.body.fallbacks, undefined);
  assert.deepEqual(sent.body.thinking, { type: 'adaptive', display: 'summarized' }); assert.equal(sent.body.output_config.effort, 'high');
  assert.deepEqual(sent.body.cache_control, { type: 'ephemeral' }); assert.equal(sent.body.max_tokens, 32000);
  for (const field of ['temperature', 'top_p', 'top_k']) assert.equal(field in sent.body, false);
  assert.equal(sent.body.messages[0].content[1].source.media_type, 'image/png');
  await assert.rejects(service.generate({ providerId: saved.id, ...prompt, temperature: 0.5 }), /Temperature is disabled/);
  assert.equal(calls, 1);
  const defaults = await provider(service, 'anthropic');
  assert.equal(defaults.capabilities.images, true); assert.deepEqual(defaults.capabilities.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('Claude 5.5-generation models opt into server-side fallback; Haiku, older models and compatible endpoints do not', async t => {
  const requests = [];
  const { service } = await serviceFixture(t, { fetch: async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    return responseStream(sse({ type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 4 } } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial ' } }, { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } } }, { type: 'content_block_stop', index: 1 }, { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'answer' } }, { type: 'message_delta', usage: { output_tokens: 2 }, delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }));
  } });
  const opus = await provider(service, 'anthropic', { model: 'claude-opus-5-5', config: { workspaceId: 'wrkspc_test01' } });
  const result = await service.generate({ providerId: opus.id, ...prompt });
  assert.equal(result.text, 'Partial answer'); assert.equal(result.model, 'claude-opus-5'); assert.deepEqual(result.fallback, { from: 'claude-opus-5-5', to: 'claude-opus-5' });
  let sent = requests.at(-1);
  assert.equal(sent.headers['anthropic-beta'], 'server-side-fallback-2026-07-01'); assert.equal(sent.body.fallbacks, 'default'); assert.equal(sent.headers['anthropic-workspace-id'], 'wrkspc_test01');
  assert.deepEqual(sent.body.thinking, { type: 'adaptive', display: 'summarized' }); assert.equal(sent.body.output_config, undefined);
  for (const model of ['claude-sonnet-5-5', 'claude-fable-5-1']) { await service.generate({ providerId: opus.id, ...prompt, model }); assert.equal(requests.at(-1).body.fallbacks, 'default'); }
  await service.generate({ providerId: opus.id, ...prompt, model: 'claude-haiku-5-5' });
  sent = requests.at(-1); assert.equal(sent.headers['anthropic-beta'], undefined); assert.equal(sent.body.fallbacks, undefined); assert.equal(sent.body.thinking.type, 'adaptive');
  await service.generate({ providerId: opus.id, ...prompt, model: 'claude-haiku-4-5' });
  assert.equal(requests.at(-1).body.thinking, undefined);
  // Only the three models SPEC §7.1 names opt into fallback; Claude Opus 5 and dated older IDs do not.
  for (const model of ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-opus-5-5-preview']) {
    await service.generate({ providerId: opus.id, ...prompt, model });
    sent = requests.at(-1); assert.equal(sent.body.fallbacks, undefined, model); assert.equal(sent.headers['anthropic-beta'], undefined, model);
  }
  assert.equal(sent.body.thinking.type, 'adaptive');
  // A Claude model before 4.6 rejects adaptive thinking, so a chosen effort travels alone.
  const efforts = await provider(service, 'anthropic', { model: 'claude-opus-4-5' });
  await service.generate({ providerId: efforts.id, ...prompt, reasoningEffort: 'high' });
  sent = requests.at(-1); assert.equal(sent.body.thinking, undefined); assert.deepEqual(sent.body.output_config, { effort: 'high' });
  const compatible = await provider(service, 'anthropic-compatible', { model: 'claude-opus-5-5' });
  await service.generate({ providerId: compatible.id, ...prompt });
  sent = requests.at(-1);
  assert.equal(sent.url, 'https://compatible.example/v1/messages'); assert.equal(sent.headers['anthropic-version'], '2023-06-01'); assert.equal(sent.headers['anthropic-beta'], undefined);
  assert.equal(sent.body.fallbacks, undefined); assert.equal(sent.body.cache_control, undefined); assert.equal(sent.body.thinking, undefined); assert.equal(sent.body.max_tokens, 4096);
  await service.saveProvider({ id: compatible.id, config: { anthropicVersion: '2026-10-21' } });
  await service.generate({ providerId: compatible.id, ...prompt });
  assert.equal(requests.at(-1).headers['anthropic-version'], '2026-10-21');
  await assert.rejects(service.saveProvider({ id: compatible.id, config: { anthropicVersion: 'latest' } }), /Anthropic version/);
});

test('refusals and exhausted output budgets end as explicit failures that keep partial text', async t => {
  let stream;
  const { service } = await serviceFixture(t, { fetch: async () => responseStream(stream) });
  const saved = await provider(service, 'anthropic', { model: 'claude-opus-5-5' });
  stream = sse({ type: 'message_start', message: { model: 'claude-opus-5-5' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial' } }, { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'This touches exploit development.' } } }, { type: 'message_stop' });
  await assert.rejects(service.generate({ providerId: saved.id, ...prompt }), error => {
    assert.match(error.message, /declined this request \(cyber\)\. This touches exploit development\./); assert.equal(error.partialText, 'Partial'); assert.equal(error.stopReason, 'refusal'); assert.equal(error.aborted, false); return true;
  });
  stream = sse({ type: 'message_start', message: {} }, { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Long deliberation' } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' });
  await assert.rejects(service.generate({ providerId: saved.id, ...prompt }), error => /whole output budget/.test(error.message) && error.stopReason === 'max_tokens');
  stream = sse({ type: 'message_start', message: {} }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Cut off' } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' });
  assert.equal((await service.generate({ providerId: saved.id, ...prompt })).stopReason, 'max_tokens');
  const openai = await provider(service);
  stream = sse({ type: 'response.output_text.delta', delta: 'Truncated answer' }, { type: 'response.incomplete', response: { model: 'gpt-model', incomplete_details: { reason: 'max_output_tokens' } } });
  const truncated = await service.generate({ providerId: openai.id, ...prompt });
  assert.equal(truncated.text, 'Truncated answer'); assert.equal(truncated.stopReason, 'max_tokens');
  stream = sse({ type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } });
  await assert.rejects(service.generate({ providerId: openai.id, ...prompt }), /content_filter/);
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
    // Cloudflare's endpoint keeps a bounded default and no stream_options; the others ask for streamed usage.
    assert.deepEqual(requests.at(-1).body.stream_options, type === 'cloudflare' ? undefined : { include_usage: true });
    assert.equal(requests.at(-1).body.max_tokens, type === 'cloudflare' ? 4096 : undefined);
  }
});

test('xAI, Mistral, Groq and DeepSeek stream Chat Completions with Bearer keys, reasoning summaries and usage', async t => {
  const requests = [];
  const { service } = await serviceFixture(t, { fetch: async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    return responseStream(sse({ choices: [{ delta: { reasoning_content: 'Weighing sources. ' }, finish_reason: null }] }, { choices: [{ delta: { content: 'Grounded answer' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: null, x_groq: { usage: { prompt_tokens: 7, completion_tokens: 2 } } }, '[DONE]'));
  } });
  for (const [type, endpoint, streamUsage] of [['xai', 'https://api.x.ai/v1/chat/completions', true], ['mistral', 'https://api.mistral.ai/v1/chat/completions', false], ['groq', 'https://api.groq.com/openai/v1/chat/completions', true], ['deepseek', 'https://api.deepseek.com/chat/completions', true]]) {
    const thoughts = [];
    const saved = await provider(service, type, { capabilities: { reasoningEfforts: ['high'] } });
    const result = await service.generate({ providerId: saved.id, ...prompt, reasoningEffort: 'high', onThinking: text => thoughts.push(text) });
    const sent = requests.at(-1);
    assert.equal(sent.url, endpoint); assert.equal(sent.headers.Authorization, `Bearer ${FAKE_KEY}`); assert.equal(sent.headers['x-api-key'], undefined);
    assert.equal(result.text, 'Grounded answer'); assert.deepEqual(thoughts, ['Weighing sources. ']); assert.equal(result.usage.completion_tokens, 2);
    assert.equal(sent.body.reasoning_effort, 'high'); assert.equal(sent.body.max_tokens, undefined); assert.equal(sent.body.temperature, undefined);
    assert.deepEqual(sent.body.stream_options, streamUsage ? { include_usage: true } : undefined);
  }
  await assert.rejects(service.saveProvider({ type: 'xai', name: 'No key', model: 'grok-4.7' }).then(saved => service.generate({ providerId: saved.id, ...prompt })), /API key/);
});

test('model discovery follows Anthropic and Gemini pagination and labels chat and embedding models', async t => {
  const urls = [];
  const { service } = await serviceFixture(t, { fetch: async (url, options) => {
    urls.push({ url, headers: options.headers });
    if (url.startsWith('https://api.anthropic.com')) return Response.json(url.includes('after_id') ? { data: [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }], has_more: false, last_id: 'claude-haiku-5-5' } : { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { image_input: { supported: true }, effort: { supported: true, low: { supported: true }, max: { supported: true } } } }], has_more: true, last_id: 'claude-opus-5-5' });
    return Response.json(url.includes('pageToken') ? { models: [{ name: 'models/gemini-4-argon', supportedGenerationMethods: ['generateContent'], outputTokenLimit: 65536 }] } : { models: [{ name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent', 'countTokens'] }, { name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] }, { name: 'models/imagen-5', supportedGenerationMethods: ['predict'] }], nextPageToken: 'next page' });
  } });
  const anthropic = await provider(service, 'anthropic');
  const models = await service.listModels(anthropic.id);
  assert.deepEqual(urls.map(entry => entry.url), ['https://api.anthropic.com/v1/models?limit=1000', 'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-5-5']);
  assert.equal(urls[0].headers['anthropic-version'], '2026-10-21');
  assert.deepEqual(models.map(model => model.id), ['claude-opus-5-5', 'claude-haiku-5-5']);
  assert.equal(models[0].maxOutputTokens, 128000); assert.equal(models[0].contextWindow, 1000000); assert.equal(models[0].kind, 'chat'); assert.deepEqual(models[0].reasoningEfforts, ['low', 'max']);
  urls.length = 0;
  const gemini = await provider(service, 'gemini');
  const listed = await service.listModels(gemini.id);
  assert.deepEqual(urls.map(entry => entry.url), ['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=next+page']);
  assert.deepEqual(listed.map(model => [model.id, model.kind]), [['gemini-3.8-flash', 'chat'], ['gemini-embedding-2', 'embedding'], ['gemini-4-argon', 'chat']]);
  assert.equal(listed[2].maxOutputTokens, 65536);
});

test('embeddings map OpenAI, Voyage, Gemini, Ollama, Mistral and LM Studio requests to ordered plain vectors', async t => {
  const requests = [];
  const vector = (seed, size = 4) => Array.from({ length: size }, (_, index) => seed + index);
  const { service } = await serviceFixture(t, { fetch: async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, headers: options.headers, body });
    if (url.includes(':batchEmbedContents')) return Response.json({ embeddings: body.requests.map((_, index) => ({ values: [3 * (index + 1), 4 * (index + 1)] })) });
    if (url.endsWith('/api/embed')) return Response.json({ model: 'embeddinggemma', embeddings: body.input.map((_, index) => vector(index)), prompt_eval_count: 6 });
    const data = body.input.map((_, index) => ({ object: 'embedding', index, embedding: vector(index * 10) })).reverse();
    return Response.json({ object: 'list', data, model: `${body.model}-served`, usage: { prompt_tokens: 5, total_tokens: 5 } });
  } });
  const openai = await provider(service);
  const result = await service.embed({ providerId: openai.id, inputs: ['First note', 'Second note'], dimensions: 4 });
  assert.equal(requests.at(-1).url, 'https://api.openai.com/v1/embeddings'); assert.equal(requests.at(-1).headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.deepEqual(requests.at(-1).body, { model: 'text-embedding-3-small', input: ['First note', 'Second note'], encoding_format: 'float', dimensions: 4 });
  assert.deepEqual(result, { vectors: [vector(0), vector(10)], model: 'text-embedding-3-small-served', dimensions: 4, usage: { inputTokens: 5 } });
  const voyage = await provider(service, 'voyage', { model: '' });
  await service.embed({ providerId: voyage.id, inputs: ['what did I save about motion'], inputType: 'query', dimensions: 4 });
  assert.equal(requests.at(-1).url, 'https://api.voyageai.com/v1/embeddings');
  assert.deepEqual(requests.at(-1).body, { input: ['what did I save about motion'], model: 'voyage-4', input_type: 'query', truncation: true, output_dimension: 4 });
  const gemini = await provider(service, 'gemini', { config: { embeddingModel: 'gemini-embedding-001' } });
  const many = Array.from({ length: 150 }, (_, index) => `Chunk ${index}`);
  const batched = await service.embed({ providerId: gemini.id, inputs: many, dimensions: 2 });
  const geminiCalls = requests.filter(entry => entry.url.includes(':batchEmbedContents'));
  assert.deepEqual(geminiCalls.map(entry => entry.body.requests.length), [100, 50]);
  assert.equal(geminiCalls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents'); assert.equal(geminiCalls[0].headers['x-goog-api-key'], FAKE_KEY);
  assert.deepEqual(geminiCalls[0].body.requests[0], { model: 'models/gemini-embedding-001', content: { parts: [{ text: 'Chunk 0' }] }, taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 2 });
  assert.equal(batched.vectors.length, 150); assert.deepEqual(batched.vectors[0], [0.6, 0.8]);
  await service.embed({ providerId: gemini.id, inputs: ['motion'], inputType: 'query', model: 'gemini-embedding-2' });
  assert.deepEqual(requests.at(-1).body.requests[0], { model: 'models/gemini-embedding-2', content: { parts: [{ text: 'task: search result | query: motion' }] } });
  const ollama = await provider(service, 'ollama', { credentials: {} });
  const local = await service.embed({ providerId: ollama.id, inputs: ['Local text'] });
  assert.equal(requests.at(-1).url, 'http://127.0.0.1:11434/api/embed'); assert.equal(requests.at(-1).headers.Authorization, undefined);
  assert.deepEqual(requests.at(-1).body, { model: 'embeddinggemma', input: ['Local text'], truncate: true }); assert.deepEqual(local.usage, { inputTokens: 6 });
  const mistral = await provider(service, 'mistral');
  await service.embed({ providerId: mistral.id, inputs: ['Bonjour'] });
  assert.equal(requests.at(-1).url, 'https://api.mistral.ai/v1/embeddings'); assert.deepEqual(requests.at(-1).body, { model: 'mistral-embed', input: ['Bonjour'] });
  const lmstudio = await provider(service, 'lmstudio', { credentials: {}, config: { embeddingModel: 'text-embedding-nomic-embed-text-v1.5' } });
  await service.embed({ providerId: lmstudio.id, inputs: ['Offline'] });
  assert.equal(requests.at(-1).url, 'http://127.0.0.1:1234/v1/embeddings'); assert.equal(requests.at(-1).body.model, 'text-embedding-nomic-embed-text-v1.5');
});

test('embedding requests are validated before any network call and never reach chat-only providers', async t => {
  let calls = 0, reply = () => Response.json({ data: [{ index: 0, embedding: [1, 2] }] });
  const { service } = await serviceFixture(t, { fetch: async () => { calls++; return reply(); } });
  const anthropic = await provider(service, 'anthropic'), groq = await provider(service, 'groq'), openai = await provider(service), voyage = await provider(service, 'voyage');
  await assert.rejects(service.embed({ providerId: anthropic.id, inputs: ['x'] }), /Voyage AI/);
  await assert.rejects(service.embed({ providerId: groq.id, inputs: ['x'] }), /does not offer embeddings/);
  for (const inputs of [[], Array(257).fill('x'), ['   '], [42], 'text']) await assert.rejects(service.embed({ providerId: openai.id, inputs }));
  await assert.rejects(service.embed({ providerId: openai.id, inputs: ['x'], inputType: 'passage' }), /input type/);
  await assert.rejects(service.embed({ providerId: openai.id, inputs: ['x'], dimensions: 0 }), /dimensions/);
  await assert.rejects(service.generate({ providerId: voyage.id, ...prompt }), /embeddings only/);
  await assert.rejects(provider(service, 'openai', { config: { embeddingDimensions: 9000 } }), /dimensions/);
  assert.equal(calls, 0);
  await assert.rejects(service.embed({ providerId: openai.id, inputs: ['a', 'b'] }), /unexpected embedding response/);
  reply = () => Response.json({ error: { message: `Invalid key ${FAKE_KEY}` } }, { status: 401 });
  await assert.rejects(service.embed({ providerId: openai.id, inputs: ['a'] }), error => error.message.includes('[redacted]') && !error.message.includes(FAKE_KEY));
});

test('Voyage lists its documented models offline and tests the key with one explicit query embedding', async t => {
  const requests = [];
  const { service } = await serviceFixture(t, { fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return Response.json({ data: [{ index: 0, embedding: [0.6, 0.8] }], model: 'voyage-4', usage: { total_tokens: 3 } }); } });
  const saved = await provider(service, 'voyage', { model: '' });
  assert.ok((await service.listModels(saved.id)).every(model => model.kind === 'embedding'));
  assert.equal(requests.length, 0);
  const tested = await service.testProvider(saved.id);
  assert.equal(tested.inferenceTested, true); assert.equal(tested.dimensions, 2); assert.equal(requests.length, 1); assert.equal(requests[0].body.input_type, 'query');
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
