import test from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, catalogModel, modelFromCatalog } from '../extension/lib/ai/catalog.js';
import * as anthropic from '../extension/lib/ai/transports/anthropic.js';
import * as responses from '../extension/lib/ai/transports/openai-responses.js';
import * as chat from '../extension/lib/ai/transports/openai-chat.js';
import * as gemini from '../extension/lib/ai/transports/gemini.js';
import * as ollama from '../extension/lib/ai/transports/ollama.js';
import { streamChat } from '../extension/lib/ai/chat.js';
import { configureConnections, saveConnection } from '../extension/lib/ai/connections.js';

const KEY = 'sk-test-SECRETKEY-0123456789abcdef';
const encoder = new TextEncoder();

function memoryStorage() {
  const map = new Map();
  return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), clear: () => map.clear() };
}
globalThis.localStorage = memoryStorage();

function body(text, { size = 7, hold = false } = {}) {
  const bytes = encoder.encode(text);
  return new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.subarray(i, i + size)); if (!hold) controller.close(); } });
}
const sse = (events, { named = true } = {}) => events.map(event => typeof event === 'string' ? `data: ${event}\n\n` : `${named ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('');
const ndjson = events => events.map(event => JSON.stringify(event)).join('\n') + '\n';

function mockFetch(t, handler) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null, signal: options.signal };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  t.after(() => { globalThis.fetch = previous; });
  return calls;
}

function ctx(providerId, overrides = {}) {
  const provider = getProvider(providerId);
  const model = overrides.model || provider.chat?.recommended;
  const entry = catalogModel(providerId, model);
  const events = [];
  return {
    events,
    value: { provider, connection: { id: `${providerId}-test`, label: provider.name }, apiKey: KEY, baseUrl: provider.baseUrl, model, modelInfo: entry ? modelFromCatalog(entry) : null,
      system: 'You are Still.', messages: [{ role: 'user', content: 'Hello' }], tools: [], effort: 'medium', signal: undefined, emit: event => events.push(event), ...overrides },
  };
}

const TOOLS = [
  { name: 'search_library', description: 'Search saved items', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'list_items', description: 'List items', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1 } } } },
];

// ---------- Anthropic ----------

test('Anthropic request: 2026-10-21 headers, adaptive summarized thinking, effort, caching, no sampling params', () => {
  const { value } = ctx('anthropic', { tools: TOOLS, effort: 'max' });
  const request = anthropic.buildRequest(value);
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['anthropic-version'], '2026-10-21');
  assert.equal(request.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(request.headers['x-api-key'], KEY);
  assert.equal(request.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  const sent = request.body;
  for (const forbidden of ['temperature', 'top_p', 'top_k']) assert.ok(!(forbidden in sent), forbidden);
  assert.deepEqual(sent.thinking, { type: 'adaptive', display: 'summarized' });
  assert.ok(!('budget_tokens' in sent.thinking));
  assert.deepEqual(sent.output_config, { effort: 'max' });
  assert.equal(sent.max_tokens, 32000);
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.cache_control, { type: 'ephemeral' });
  assert.equal(sent.fallbacks, 'default');
  assert.equal(sent.system, 'You are Still.');
  assert.deepEqual(sent.tool_choice, { type: 'auto' });
  assert.equal(sent.tools[0].strict, true);
  assert.equal(sent.tools[1].strict, undefined, 'optional properties and numeric bounds are not strict-compatible');
  assert.equal(sent.tools[0].input_schema.properties.query.type, 'string');
  assert.deepEqual(anthropic.buildRequest({ ...value, effort: 'none' }).body.output_config, { effort: 'low' });
  assert.deepEqual(anthropic.buildRequest({ ...value, effort: undefined }).body.output_config, { effort: 'medium' });
});

test('Anthropic fallbacks only for Opus 5.5, Sonnet 5.5 and Fable 5.1 on api.anthropic.com', () => {
  for (const [model, expected] of [['claude-opus-5-5', true], ['claude-sonnet-5-5', true], ['claude-fable-5-1', true], ['claude-haiku-5-5', false], ['claude-opus-5-5-20261001', true]]) {
    const { value } = ctx('anthropic', { model });
    const request = anthropic.buildRequest(value);
    assert.equal(request.body.fallbacks === 'default', expected, model);
    assert.equal(request.headers['anthropic-beta'] === 'server-side-fallback-2026-07-01', expected, model);
  }
  const { value } = ctx('custom-anthropic', { baseUrl: 'https://proxy.example.com/v1', model: 'claude-opus-5-5' });
  const custom = anthropic.buildRequest(value);
  assert.equal(custom.body.fallbacks, undefined);
  assert.equal(custom.headers['anthropic-beta'], undefined);
  assert.equal(custom.headers['anthropic-dangerous-direct-browser-access'], undefined);
  assert.equal(custom.headers['anthropic-version'], '2023-06-01');
  for (const forbidden of ['temperature', 'top_p', 'top_k']) assert.ok(!(forbidden in custom.body));
});

const ANTHROPIC_TOOL_STREAM = [
  { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 30 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need to ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'search.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Let me look ' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'that up — café.' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search_library', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"que' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'ry": "japan ' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'travel"}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 55 } },
  { type: 'message_stop' },
];

test('Anthropic stream accumulates thinking, text and tool input JSON and returns the native message verbatim', async t => {
  mockFetch(t, () => new Response(body(sse(ANTHROPIC_TOOL_STREAM), { size: 5 })));
  const { value, events } = ctx('anthropic', { tools: TOOLS });
  const result = await anthropic.stream(value);
  assert.equal(result.text, 'Let me look that up — café.');
  assert.equal(result.thinking, 'Need to search.');
  assert.deepEqual(result.toolCalls, [{ id: 'toolu_1', name: 'search_library', input: { query: 'japan travel' } }]);
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 55, cacheReadTokens: 30 });
  assert.deepEqual(events.filter(event => event.type === 'tool_call'), [{ type: 'tool_call', id: 'toolu_1', name: 'search_library', input: { query: 'japan travel' } }]);
  assert.equal(events.filter(event => event.type === 'text').map(event => event.delta).join(''), result.text);
  const native = result.assistantMessage.native.content;
  assert.deepEqual(native[0], { type: 'thinking', thinking: 'Need to search.', signature: 'sig-abc' });
  assert.deepEqual(native[2], { type: 'tool_use', id: 'toolu_1', name: 'search_library', input: { query: 'japan travel' } });

  const followUp = anthropic.buildRequest({ ...value, messages: [
    { role: 'user', content: 'Find Japan' }, result.assistantMessage,
    { role: 'user', content: [{ type: 'text', text: 'Here you go' }, { type: 'tool_result', toolUseId: 'toolu_1', content: '[{"id":"a"}]' }] },
  ] });
  assert.deepEqual(followUp.body.messages[1], { role: 'assistant', content: native });
  assert.deepEqual(followUp.body.messages[2].content[0], { type: 'tool_result', tool_use_id: 'toolu_1', content: '[{"id":"a"}]' });
  assert.equal(followUp.body.messages[2].content[1].type, 'text');
});

test('Anthropic refusal rejects with the stop_details explanation and keeps partial text', async t => {
  mockFetch(t, () => new Response(body(sse([
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I can' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'This request asks for malware.' } }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]))));
  const { value } = ctx('anthropic');
  const error = await anthropic.stream(value).catch(caught => caught);
  assert.equal(error.code, 'refusal');
  assert.match(error.message, /Claude declined this request\. This request asks for malware\./);
  assert.equal(error.partialText, 'I can');
  assert.deepEqual(error.refusal, { category: 'cyber', explanation: 'This request asks for malware.' });
});

test('Anthropic stream errors and truncated streams are reported, not treated as success', async t => {
  mockFetch(t, (call, index) => new Response(body(index === 0
    ? sse([{ type: 'message_start', message: {} }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])
    : sse([{ type: 'message_start', message: {} }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Half' } }]))));
  const overloaded = await anthropic.stream(ctx('anthropic').value).catch(caught => caught);
  assert.equal(overloaded.code, 'provider_down');
  const cut = await anthropic.stream(ctx('anthropic').value).catch(caught => caught);
  assert.equal(cut.code, 'incomplete');
});

test('Anthropic model discovery follows after_id pagination', async t => {
  const calls = mockFetch(t, call => {
    const after = new URL(call.url).searchParams.get('after_id');
    const page = after ? { data: [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', max_input_tokens: 200000, max_tokens: 64000, capabilities: { image_input: { supported: true }, effort: { low: { supported: true }, medium: { supported: true }, high: { supported: false } } } }], has_more: false }
      : { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000, max_tokens: 128000 }], has_more: true, last_id: 'claude-opus-5-5' };
    return new Response(JSON.stringify(page));
  });
  const models = await anthropic.listModels({ provider: getProvider('anthropic'), baseUrl: 'https://api.anthropic.com/v1', apiKey: KEY });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/v1\/models\?limit=1000$/);
  assert.match(calls[1].url, /after_id=claude-opus-5-5/);
  assert.equal(calls[0].headers['anthropic-version'], '2026-10-21');
  assert.deepEqual(models.map(model => model.id), ['claude-opus-5-5', 'claude-haiku-5-5']);
  assert.equal(models[0].contextWindow, 1000000);
  assert.equal(models[0].maxOutput, 128000);
  assert.deepEqual(models[1].efforts, ['low', 'medium']);
});

// ---------- OpenAI Responses ----------

test('OpenAI Responses request: reasoning effort clamped per model, encrypted reasoning, store false, function tools', () => {
  const { value } = ctx('openai', { model: 'gpt-6-luna', effort: 'max', tools: TOOLS, messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }] }] });
  const request = responses.buildRequest(value);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(request.body.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(request.body.include, ['reasoning.encrypted_content']);
  assert.equal(request.body.store, false);
  assert.equal(request.body.instructions, 'You are Still.');
  assert.equal(request.body.max_output_tokens, 32000);
  assert.deepEqual(request.body.input[0].content[1], { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.deepEqual(request.body.tools[0], { type: 'function', name: 'search_library', description: 'Search saved items', parameters: TOOLS[0].inputSchema, strict: true });
  assert.equal(request.body.tools[1].strict, false);
  assert.equal(request.body.tool_choice, 'auto');
  assert.ok(!('temperature' in request.body));
  assert.deepEqual(responses.buildRequest({ ...value, model: 'gpt-6-astra', modelInfo: modelFromCatalog(catalogModel('openai', 'gpt-6-astra')), effort: 'none' }).body.reasoning, { effort: 'low', summary: 'auto' });
  const preset = responses.buildRequest(ctx('perplexity').value).body;
  assert.equal(preset.effort, 'fast');
  assert.equal(preset.model, undefined);
});

test('OpenAI Responses stream: reasoning summaries, text, function-call argument deltas and native output replay', async t => {
  const output = [
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan.' }], encrypted_content: 'enc-xyz' },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search_library', arguments: '{"query":"tea"}' },
  ];
  mockFetch(t, () => new Response(body(sse([
    { type: 'response.created', response: { model: 'gpt-6.1-sol' } },
    { type: 'response.reasoning_summary_part.added', summary_index: 0 },
    { type: 'response.reasoning_summary_text.delta', delta: 'Plan', summary_index: 0 },
    { type: 'response.reasoning_summary_text.delta', delta: '.', summary_index: 0 },
    { type: 'response.output_text.delta', delta: 'Checking ' },
    { type: 'response.output_text.delta', delta: 'now.' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search_library', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"que' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: 'ry":"tea"}' },
    { type: 'response.output_item.done', output_index: 1, item: output[1] },
    { type: 'response.completed', response: { model: 'gpt-6.1-sol', status: 'completed', output, usage: { input_tokens: 12, output_tokens: 30, output_tokens_details: { reasoning_tokens: 20 } } } },
  ]), { size: 9 })));
  const { value, events } = ctx('openai', { tools: TOOLS });
  const result = await responses.stream(value);
  assert.equal(result.thinking, 'Plan.');
  assert.equal(result.text, 'Checking now.');
  assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'search_library', input: { query: 'tea' } }]);
  assert.equal(events.filter(event => event.type === 'tool_call').length, 1);
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 30, reasoningTokens: 20 });
  const followUp = responses.buildRequest({ ...value, messages: [{ role: 'user', content: 'Tea?' }, result.assistantMessage, { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'none found' }] }] });
  assert.deepEqual(followUp.body.input.slice(1, 3), output);
  assert.deepEqual(followUp.body.input[3], { type: 'function_call_output', call_id: 'call_1', output: 'none found' });
});

test('OpenAI Responses incomplete output resolves with max_tokens; failures reject', async t => {
  mockFetch(t, (call, index) => new Response(body(index === 0
    ? sse([{ type: 'response.output_text.delta', delta: 'Long' }, { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } }])
    : sse([{ type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } }]))));
  const result = await responses.stream(ctx('openai').value);
  assert.equal(result.stopReason, 'max_tokens');
  assert.match(result.notice, /output limit/);
  const failed = await responses.stream(ctx('openai').value).catch(caught => caught);
  assert.equal(failed.code, 'provider_down');
});

// ---------- Chat Completions ----------

test('OpenRouter chat request sends attribution headers, usage opt-in and reasoning effort for known models', () => {
  const request = chat.buildRequest(ctx('openrouter', { tools: TOOLS, effort: 'high' }).value);
  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.headers['HTTP-Referer'], 'https://github.com/AVRCORP/sidebar-dock');
  assert.equal(request.headers['X-Title'], 'Still');
  assert.deepEqual(request.body.stream_options, { include_usage: true });
  assert.deepEqual(request.body.reasoning, { effort: 'high' });
  assert.deepEqual(request.body.messages[0], { role: 'system', content: 'You are Still.' });
  assert.equal(request.body.tools[0].function.strict, true);
  assert.equal(request.body.max_tokens, undefined);
  const xai = chat.buildRequest(ctx('xai').value);
  assert.equal(xai.url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(xai.body.reasoning_effort, undefined);
  assert.equal(xai.body.stream_options, undefined);
  const deepseek = chat.buildRequest(ctx('deepseek', { effort: 'medium' }).value);
  assert.equal(deepseek.body.reasoning_effort, 'low');
  const groq = chat.buildRequest(ctx('groq', { model: 'llama-3.1-8b-instant' }).value);
  assert.equal(groq.body.reasoning_effort, undefined);
});

test('Chat Completions stream accumulates fragmented tool calls, ignores comments and reads usage before [DONE]', async t => {
  const stream = ': OPENROUTER PROCESSING\n\n' + sse([
    { model: 'deepseek-v4-pro', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Think' } }] },
    { choices: [{ index: 0, delta: { content: 'Sure' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'search_', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'library', arguments: '{"query":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ramen"}' } }, { index: 1, id: 'call_b', function: { name: 'list_items', arguments: '{}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } },
    '[DONE]',
  ], { named: false });
  mockFetch(t, () => new Response(body(stream, { size: 11 })));
  const { value, events } = ctx('deepseek', { tools: TOOLS });
  const result = await chat.stream(value);
  assert.equal(result.text, 'Sure');
  assert.equal(result.thinking, 'Think');
  assert.deepEqual(result.toolCalls, [{ id: 'call_a', name: 'search_library', input: { query: 'ramen' } }, { id: 'call_b', name: 'list_items', input: {} }]);
  assert.equal(events.filter(event => event.type === 'tool_call').length, 2);
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 4 });
  assert.equal(result.assistantMessage.native.message.reasoning_content, 'Think', 'DeepSeek needs reasoning_content echoed in tool loops');
  const followUp = chat.buildRequest({ ...value, messages: [{ role: 'user', content: 'Ramen' }, result.assistantMessage, { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_a', content: 'two items' }, { type: 'tool_result', toolUseId: 'call_b', content: '[]' }] }] });
  assert.deepEqual(followUp.body.messages.slice(2).map(message => message.role), ['assistant', 'tool', 'tool']);
  assert.equal(followUp.body.messages[3].tool_call_id, 'call_a');
  assert.equal(followUp.body.messages[2].tool_calls[0].function.arguments, '{"query":"ramen"}');
});

test('Chat Completions stream without a finish or [DONE] is incomplete; mid-stream errors reject', async t => {
  mockFetch(t, (call, index) => new Response(body(index === 0 ? sse([{ choices: [{ delta: { content: 'Par' } }] }], { named: false })
    : sse([{ error: { message: 'Upstream provider error', code: 502 } }], { named: false }))));
  const cut = await chat.stream(ctx('openrouter').value).catch(caught => caught);
  assert.equal(cut.code, 'incomplete');
  const failed = await chat.stream(ctx('openrouter').value).catch(caught => caught);
  assert.match(failed.message, /Upstream provider error/);
});

// ---------- Gemini ----------

test('Gemini request uses alt=sse, the key header, thinking levels and sanitized function declarations', () => {
  const { value } = ctx('google', { model: 'gemini-3.5-flash-lite', effort: 'none', tools: TOOLS });
  const request = gemini.buildRequest(value);
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse');
  assert.equal(request.headers['x-goog-api-key'], KEY);
  assert.equal(request.headers.Authorization, undefined);
  assert.deepEqual(request.body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal', includeThoughts: true });
  assert.deepEqual(request.body.systemInstruction, { parts: [{ text: 'You are Still.' }] });
  const declaration = request.body.tools[0].functionDeclarations[0];
  assert.equal(declaration.name, 'search_library');
  assert.equal(declaration.parameters.additionalProperties, undefined);
  for (const forbidden of ['temperature', 'topP', 'topK']) assert.ok(!(forbidden in request.body.generationConfig));
  assert.deepEqual(gemini.buildRequest({ ...value, model: 'gemini-4-argon', modelInfo: modelFromCatalog(catalogModel('google', 'gemini-4-argon')), effort: 'max' }).body.generationConfig.thinkingConfig, { thinkingLevel: 'high', includeThoughts: true });
  assert.deepEqual(gemini.thinkingConfig('gemini-2.5-flash', 'medium'), { thinkingBudget: -1, includeThoughts: true });
});

test('Gemini stream separates thoughts, keeps thought signatures and maps function calls and responses', async t => {
  mockFetch(t, () => new Response(body(sse([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Considering', thought: true }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'One ' }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'moment.', thoughtSignature: 'sig-1' }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'search_library', args: { query: 'bikes' } }, thoughtSignature: 'sig-2' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 5, thoughtsTokenCount: 3 }, modelVersion: 'gemini-3.8-flash' },
  ], { named: false }), { size: 6 })));
  const { value } = ctx('google', { tools: TOOLS });
  const result = await gemini.stream(value);
  assert.equal(result.thinking, 'Considering');
  assert.equal(result.text, 'One moment.');
  assert.equal(result.toolCalls[0].name, 'search_library');
  assert.deepEqual(result.toolCalls[0].input, { query: 'bikes' });
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 5, reasoningTokens: 3 });
  assert.deepEqual(result.assistantMessage.native.parts, [{ text: 'One moment.', thoughtSignature: 'sig-1' }, { functionCall: { name: 'search_library', args: { query: 'bikes' } }, thoughtSignature: 'sig-2' }]);
  const followUp = gemini.buildRequest({ ...value, messages: [{ role: 'user', content: 'Bikes' }, result.assistantMessage, { role: 'user', content: [{ type: 'tool_result', toolUseId: result.toolCalls[0].id, content: 'three items' }] }] });
  assert.deepEqual(followUp.body.contents[1], { role: 'model', parts: result.assistantMessage.native.parts });
  assert.deepEqual(followUp.body.contents[2], { role: 'user', parts: [{ functionResponse: { name: 'search_library', response: { result: 'three items' } } }] });
});

test('Gemini safety stops and blocked prompts reject as refusals', async t => {
  mockFetch(t, (call, index) => new Response(body(index === 0
    ? sse([{ candidates: [{ content: { parts: [{ text: 'Part' }] }, finishReason: 'SAFETY' }] }], { named: false })
    : sse([{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }], { named: false }))));
  const safety = await gemini.stream(ctx('google').value).catch(caught => caught);
  assert.equal(safety.code, 'refusal');
  assert.equal(safety.partialText, 'Part');
  const blocked = await gemini.stream(ctx('google').value).catch(caught => caught);
  assert.match(blocked.message, /prohibited content/);
});

// ---------- Ollama ----------

test('Ollama checks model capabilities, streams NDJSON and returns tool calls', async t => {
  const calls = mockFetch(t, call => {
    if (call.url.endsWith('/api/show')) return new Response(JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'] }));
    return new Response(body(ndjson([
      { model: 'qwen3', message: { role: 'assistant', content: '', thinking: 'Hmm' }, done: false },
      { model: 'qwen3', message: { role: 'assistant', content: 'Hel' }, done: false },
      { model: 'qwen3', message: { role: 'assistant', content: 'lo', tool_calls: [{ function: { name: 'search_library', arguments: { query: 'x' } } }] }, done: false },
      { model: 'qwen3', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 11, eval_count: 6 },
    ]), { size: 4 }));
  });
  const { value } = ctx('ollama', { baseUrl: 'http://localhost:11434', model: 'qwen3', apiKey: '', tools: TOOLS });
  const result = await ollama.stream(value);
  const chatCall = calls.find(call => call.url.endsWith('/api/chat'));
  assert.equal(chatCall.body.think, true);
  assert.equal(chatCall.body.tools.length, 2);
  assert.equal(chatCall.body.stream, true);
  assert.equal(chatCall.headers.Authorization, undefined);
  assert.equal(result.text, 'Hello');
  assert.equal(result.thinking, 'Hmm');
  assert.deepEqual(result.toolCalls.map(call => [call.name, call.input]), [['search_library', { query: 'x' }]]);
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 6 });
  const followUp = ollama.buildRequest({ ...value, messages: [{ role: 'user', content: 'x' }, result.assistantMessage, { role: 'user', content: [{ type: 'tool_result', toolUseId: result.toolCalls[0].id, content: 'ok' }] }] });
  assert.deepEqual(followUp.body.messages.at(-1), { role: 'tool', tool_name: 'search_library', content: 'ok' });
});

test('Ollama leaves out think and tools for models without them, and explains a 403', async t => {
  const calls = mockFetch(t, call => {
    if (call.url.endsWith('/api/show')) return new Response(JSON.stringify({ capabilities: ['completion'] }));
    if (call.body?.model === 'blocked') return new Response('', { status: 403 });
    return new Response(body(ndjson([{ message: { content: 'ok' }, done: true }])));
  });
  await ollama.stream(ctx('ollama', { baseUrl: 'http://localhost:11434', model: 'gemma-small', apiKey: '', tools: TOOLS }).value);
  const chatCall = calls.find(call => call.url.endsWith('/api/chat'));
  assert.equal(chatCall.body.think, undefined);
  assert.equal(chatCall.body.tools, undefined);
  const error = await ollama.stream(ctx('ollama', { baseUrl: 'http://localhost:11434', model: 'blocked', apiKey: '' }).value).catch(caught => caught);
  assert.equal(error.code, 'origin_blocked');
});

// ---------- streamChat end to end ----------

test('streamChat resolves a saved connection, emits start/text/usage/done and keeps the key out of errors', async t => {
  localStorage.clear();
  configureConnections({ integrations: { getIntegrationSettings: async () => ({ bridgeConfigured: false }) } });
  const saved = await saveConnection({ providerId: 'anthropic', apiKey: KEY });
  let mode = 'ok';
  const calls = mockFetch(t, () => {
    if (mode === 'error') return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: `bad header x-api-key: ${KEY}` } }), { status: 400 });
    return new Response(body(sse([
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi there' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ])));
  });
  const events = [];
  const result = await streamChat({ connectionId: saved.id, system: 'Be brief.', messages: [{ role: 'user', content: 'Hello' }], effort: 'low', onEvent: event => events.push(event) });
  assert.equal(result.text, 'Hi there');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(calls[0].body.model, 'claude-opus-5-5');
  assert.deepEqual(calls[0].body.output_config, { effort: 'low' });
  assert.deepEqual(events.map(event => event.type), ['start', 'text', 'usage', 'done']);
  assert.equal(events[0].modelLabel, 'Claude Opus 5.5');
  mode = 'error';
  const errors = [];
  const error = await streamChat({ connectionId: saved.id, messages: [{ role: 'user', content: 'Hello' }], onEvent: event => { if (event.type === 'error') errors.push(event); } }).catch(caught => caught);
  assert.ok(!error.message.includes(KEY));
  assert.ok(!JSON.stringify(errors).includes(KEY));
  assert.equal(errors.length, 1);
});

test('streamChat abort stops the network read promptly and keeps the partial answer', async t => {
  localStorage.clear();
  configureConnections({ integrations: { getIntegrationSettings: async () => ({ bridgeConfigured: false }) } });
  const saved = await saveConnection({ providerId: 'openai', apiKey: KEY });
  let cancelled = false;
  mockFetch(t, () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(sse([{ type: 'response.output_text.delta', delta: 'Partial ans' }]))); },
    cancel() { cancelled = true; },
  })));
  const controller = new AbortController();
  const started = Date.now();
  const events = [];
  const error = await streamChat({ connectionId: saved.id, messages: [{ role: 'user', content: 'Go' }], signal: controller.signal, onEvent: event => { events.push(event); if (event.type === 'text') setTimeout(() => controller.abort(), 5); } }).catch(caught => caught);
  assert.equal(error.code, 'aborted');
  assert.equal(error.partialText, 'Partial ans');
  assert.ok(Date.now() - started < 1000);
  assert.equal(cancelled, true);
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).aborted, true);
});

test('streamChat through a CLI agent uses the bridge, maps events and returns text only', async t => {
  localStorage.clear();
  const requests = [];
  configureConnections({ integrations: {
    getIntegrationSettings: async () => ({ bridgeConfigured: true }),
    requestBridge: async (path, options = {}) => {
      requests.push({ path, body: options.body });
      if (path === '/ai/providers') return { providers: [], agents: [{ id: 'codex', name: 'Codex CLI', available: true, status: 'ready', capabilities: { generate: true } }] };
      options.onEvent?.({ type: 'start', sources: [] });
      options.onEvent?.({ type: 'delta', text: 'From ' });
      options.onEvent?.({ type: 'delta', text: 'Codex' });
      const done = { type: 'done', text: 'From Codex', model: 'gpt-6.1-sol', usage: { input_tokens: 4, output_tokens: 2 }, stopReason: 'completed' };
      options.onEvent?.(done);
      return done;
    },
  } });
  const events = [];
  const result = await streamChat({ connectionId: 'agent:codex', model: 'default', system: 'Use the library.', messages: [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Reply' }, { role: 'user', content: 'Summarize' }], tools: TOOLS, effort: 'high', onEvent: event => events.push(event) });
  const chatRequest = requests.find(request => request.path === '/ai/chat');
  assert.equal(chatRequest.body.providerId, 'cli:codex');
  assert.equal(chatRequest.body.model, undefined);
  assert.equal(chatRequest.body.reasoningEffort, 'high');
  assert.equal(chatRequest.body.query, 'Summarize');
  assert.deepEqual(chatRequest.body.history, [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Reply' }]);
  assert.equal(chatRequest.body.context.sources[0].text, 'Use the library.');
  assert.equal(result.text, 'From Codex');
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 2 });
  assert.deepEqual(events.map(event => event.type), ['start', 'text', 'text', 'usage', 'done']);
});
