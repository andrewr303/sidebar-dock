import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, catalogModel, getProvider, modelFromCatalog } from '../extension/lib/ai/catalog.js';
import * as anthropic from '../extension/lib/ai/transports/anthropic.js';
import * as responses from '../extension/lib/ai/transports/openai-responses.js';
import * as chat from '../extension/lib/ai/transports/openai-chat.js';
import * as gemini from '../extension/lib/ai/transports/gemini.js';
import * as ollama from '../extension/lib/ai/transports/ollama.js';
import { nativeResponseFormat, normalizeResponseFormat, streamChat } from '../extension/lib/ai/chat.js';
import { configureConnections, saveConnection } from '../extension/lib/ai/connections.js';
import { SUGGESTION_SCHEMA, createTransforms } from '../extension/lib/ai/transforms.js';

const KEY = 'sk-test-SECRETKEY-0123456789abcdef';
const encoder = new TextEncoder();
const FORMAT = Object.freeze({ type: 'json_schema', name: 'save_suggestion', schema: SUGGESTION_SCHEMA });
const TOOLS = [{ name: 'search_library', description: 'Search saved items', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }];
const REPLY = '{"title":"Inter typeface","tags":["fonts"],"collectionId":"","summary":"A UI font."}';

function memoryStorage() {
  const map = new Map();
  return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), clear: () => map.clear() };
}
globalThis.localStorage = memoryStorage();

const body = text => new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); } });
const sse = (events, { named = true } = {}) => events.map(event => typeof event === 'string' ? `data: ${event}\n\n` : `${named ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('');

function mockFetch(t, handler) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null };
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
  return { provider, connection: { id: `${providerId}-test`, label: provider.name }, apiKey: KEY, baseUrl: provider.baseUrl, model, modelInfo: entry ? modelFromCatalog(entry) : null,
    system: 'You file pages.', messages: [{ role: 'user', content: 'Page' }], tools: [], effort: 'low', signal: undefined, emit: () => {}, ...overrides };
}

const anthropicReply = (text, { thinking = '' } = {}) => sse([
  { type: 'message_start', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 9 } } },
  ...(thinking ? [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
    { type: 'content_block_stop', index: 0 },
  ] : []),
  { type: 'content_block_start', index: thinking ? 1 : 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: thinking ? 1 : 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: thinking ? 1 : 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
  { type: 'message_stop' },
]);
const chatReply = text => sse([{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'], { named: false });

// ---------- request bodies per transport ----------

test('Anthropic: output_config.format sits beside effort; thinking, fallbacks and the 2026-10-21 headers are unchanged', () => {
  const request = anthropic.buildRequest(ctx('anthropic', { model: 'claude-opus-5-5', responseFormat: FORMAT }));
  assert.equal(request.headers['anthropic-version'], '2026-10-21');
  assert.equal(request.headers['anthropic-beta'], 'server-side-fallback-2026-07-01', 'no structured-outputs beta header');
  const sent = request.body;
  assert.deepEqual(sent.output_config, { effort: 'low', format: { type: 'json_schema', schema: SUGGESTION_SCHEMA } });
  assert.ok(!('output_format' in sent), 'the deprecated top-level output_format is never sent');
  assert.deepEqual(sent.thinking, { type: 'adaptive', display: 'summarized' }, 'adaptive thinking stays on; the grammar covers only the reply');
  assert.equal(sent.fallbacks, 'default');
  assert.equal(sent.tools, undefined);
  assert.equal(sent.stream, true);

  const plain = anthropic.buildRequest(ctx('anthropic', { model: 'claude-opus-5-5' })).body;
  assert.deepEqual(plain.output_config, { effort: 'low' });

  // Docs: JSON outputs and strict tools combine in one request; Claude may call a tool or answer with the JSON.
  const withTools = anthropic.buildRequest(ctx('anthropic', { model: 'claude-opus-5-5', tools: TOOLS, responseFormat: FORMAT })).body;
  assert.deepEqual(withTools.output_config.format, { type: 'json_schema', schema: SUGGESTION_SCHEMA });
  assert.equal(withTools.tools[0].strict, true);
  assert.deepEqual(withTools.tool_choice, { type: 'auto' });
});

test('Anthropic: a listed model without effort still gets the format, and the Models API flag is read', async t => {
  const effortOff = { low: { supported: false }, medium: { supported: false }, high: { supported: false }, xhigh: { supported: false }, max: { supported: false } };
  mockFetch(t, () => new Response(JSON.stringify({ has_more: false, data: [
    { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', capabilities: { effort: effortOff, structured_outputs: { supported: true }, thinking: { types: { adaptive: { supported: false } } } } },
    { id: 'claude-old', display_name: 'Claude Old', capabilities: { structured_outputs: { supported: false } } },
    { id: 'claude-next', display_name: 'Claude Next' },
  ] })));
  const [haiku, old, next] = await anthropic.listModels({ provider: getProvider('anthropic'), baseUrl: 'https://api.anthropic.com/v1', apiKey: KEY });
  assert.equal(haiku.capabilities.structuredOutputs, true);
  assert.equal(old.capabilities.structuredOutputs, false);
  assert.ok(!('structuredOutputs' in next.capabilities), 'no listing flag means unknown');
  const sent = anthropic.buildRequest(ctx('anthropic', { model: 'claude-haiku-4-5', modelInfo: haiku, responseFormat: FORMAT })).body;
  assert.deepEqual(sent.output_config, { format: { type: 'json_schema', schema: SUGGESTION_SCHEMA } });
  assert.equal(sent.thinking, undefined);
});

test('OpenAI Responses: text.format json_schema with name and strict, beside function tools; nothing when absent', () => {
  const sent = responses.buildRequest(ctx('openai', { model: 'gpt-6-luna', responseFormat: FORMAT })).body;
  assert.deepEqual(sent.text, { format: { type: 'json_schema', name: 'save_suggestion', schema: SUGGESTION_SCHEMA, strict: true } });
  assert.ok(!('response_format' in sent));
  assert.ok(sent.reasoning, 'reasoning effort is still sent');
  const withTools = responses.buildRequest(ctx('openai', { model: 'gpt-6-luna', tools: TOOLS, responseFormat: FORMAT })).body;
  assert.equal(withTools.tools[0].name, 'search_library');
  assert.equal(withTools.tool_choice, 'auto');
  assert.equal(withTools.text.format.type, 'json_schema');
  assert.ok(!('text' in responses.buildRequest(ctx('openai', { model: 'gpt-6-luna' })).body));
  // Perplexity's preset requests never take it.
  assert.ok(!('text' in responses.buildRequest(ctx('perplexity', { responseFormat: FORMAT })).body));
});

test('Chat Completions: one json_schema response_format shape for xAI, OpenRouter, Mistral and LM Studio', () => {
  const expected = { type: 'json_schema', json_schema: { name: 'save_suggestion', schema: SUGGESTION_SCHEMA, strict: true } };
  for (const [providerId, overrides] of [['xai', {}], ['openrouter', {}], ['mistral', {}], ['lmstudio', { baseUrl: 'http://localhost:1234/v1', model: 'qwen3-8b', apiKey: '' }]]) {
    const sent = chat.buildRequest(ctx(providerId, { ...overrides, responseFormat: FORMAT })).body;
    assert.deepEqual(sent.response_format, expected, providerId);
    assert.equal(sent.stream, true, providerId);
    assert.ok(!('response_format' in chat.buildRequest(ctx(providerId, overrides)).body), `${providerId} without a format`);
  }
  const withTools = chat.buildRequest(ctx('xai', { tools: TOOLS, responseFormat: FORMAT })).body;
  assert.equal(withTools.tools[0].function.strict, true);
  assert.deepEqual(withTools.response_format, expected);
});

test('Gemini: responseMimeType + responseJsonSchema with the schema as is; with function tools only on Gemini 3 and later', () => {
  const config = gemini.buildRequest(ctx('google', { model: 'gemini-3.8-flash', responseFormat: FORMAT })).body.generationConfig;
  assert.equal(config.responseMimeType, 'application/json');
  assert.deepEqual(config.responseJsonSchema, SUGGESTION_SCHEMA, 'additionalProperties and required pass through unchanged');
  assert.ok(!('responseSchema' in config));
  assert.ok(config.thinkingConfig, 'thinking stays configured');

  const toolsOn3 = gemini.buildRequest(ctx('google', { model: 'gemini-3.8-flash', tools: TOOLS, responseFormat: FORMAT })).body;
  assert.equal(toolsOn3.tools[0].functionDeclarations[0].name, 'search_library');
  assert.equal(toolsOn3.generationConfig.responseMimeType, 'application/json');

  const toolsOn25 = gemini.buildRequest(ctx('google', { model: 'gemini-2.5-flash', tools: TOOLS, responseFormat: FORMAT })).body;
  assert.equal(toolsOn25.tools[0].functionDeclarations[0].name, 'search_library');
  assert.ok(!('responseMimeType' in toolsOn25.generationConfig) && !('responseJsonSchema' in toolsOn25.generationConfig));
  assert.equal(gemini.buildRequest(ctx('google', { model: 'gemini-2.5-flash', responseFormat: FORMAT })).body.generationConfig.responseMimeType, 'application/json');

  const plain = gemini.buildRequest(ctx('google', { model: 'gemini-3.8-flash' })).body.generationConfig;
  assert.ok(!('responseMimeType' in plain) && !('responseJsonSchema' in plain));
});

test('Ollama: format carries the schema on a local server, never on Ollama cloud', () => {
  const local = { baseUrl: 'http://localhost:11434', model: 'qwen3', apiKey: '', capabilities: ['completion', 'thinking'] };
  const sent = ollama.buildRequest(ctx('ollama', { ...local, responseFormat: FORMAT })).body;
  assert.deepEqual(sent.format, SUGGESTION_SCHEMA);
  assert.equal(sent.think, true);
  assert.ok(!('format' in ollama.buildRequest(ctx('ollama', local)).body));
  assert.ok(!('format' in ollama.buildRequest(ctx('ollama', { ...local, model: 'gpt-oss:120b-cloud', responseFormat: FORMAT })).body));
  assert.ok(!('format' in ollama.buildRequest(ctx('ollama', { ...local, baseUrl: 'https://ollama.com', responseFormat: FORMAT })).body));
});

// ---------- which providers and models get it ----------

test('responseFormat is validated: JSON schema only, an object schema and a safe name', () => {
  assert.equal(normalizeResponseFormat(undefined), null);
  assert.equal(normalizeResponseFormat(null), null);
  assert.deepEqual(normalizeResponseFormat({ type: 'json_schema', schema: SUGGESTION_SCHEMA }), { type: 'json_schema', name: 'response', schema: SUGGESTION_SCHEMA });
  for (const bad of [{ type: 'json_object' }, 'json', { type: 'json_schema' }, { type: 'json_schema', schema: [] }, { type: 'json_schema', name: 'has space', schema: {} }, { type: 'json_schema', name: 'x'.repeat(65), schema: {} }]) {
    assert.throws(() => normalizeResponseFormat(bad), error => error.code === 'bad_request', JSON.stringify(bad));
  }
});

test('native structured output per catalog entry: sent only where the provider and model accept it', () => {
  const decide = (providerId, model, extra = {}) => {
    const provider = getProvider(providerId);
    const entry = catalogModel(providerId, model);
    return nativeResponseFormat({ provider, via: provider.via === 'direct' ? 'direct' : provider.via, model, modelInfo: entry ? modelFromCatalog(entry) : null, format: FORMAT, ...extra });
  };
  const expected = {
    anthropic: ['claude-haiku-5-5', true], openai: ['gpt-6-luna', true], xai: ['grok-4.3', true], google: ['gemini-3.5-flash-lite', true],
    openrouter: ['anthropic/claude-haiku-5.5', true], mistral: ['mistral-small-latest', true], ollama: ['qwen3', true], lmstudio: ['qwen3-8b', true],
    // Groq's json_schema mode cannot stream; DeepSeek only has json_object; Perplexity presets and custom servers are unknown.
    groq: ['openai/gpt-oss-120b', false], deepseek: ['deepseek-flash', false], perplexity: ['preset:fast', false],
    'custom-openai': ['any-model', false], 'custom-anthropic': ['claude-opus-5-5', false],
    // The bridge and CLI agents have no structured-output path; the bridge router ignores it.
    bridge: ['claude-opus-5-5', false], 'agent:claude-code': ['claude-opus-5-5', false], 'agent:codex': ['default', false], 'chatgpt-oauth': ['default', false],
  };
  for (const provider of CATALOG.filter(entry => entry.chat)) assert.ok(provider.id in expected, `${provider.id} has a decision`);
  for (const [providerId, [model, sent]] of Object.entries(expected)) assert.equal(decide(providerId, model) === FORMAT, sent, providerId);

  // Per-model providers: a model the catalog does not know is left out unless its listing says yes; a listing says no wins.
  const listed = flag => ({ capabilities: { tools: true, ...(flag === undefined ? {} : { structuredOutputs: flag }) } });
  assert.equal(decide('anthropic', 'claude-next', { modelInfo: listed() }), null);
  assert.equal(decide('anthropic', 'claude-next', { modelInfo: listed(true) }), FORMAT);
  assert.equal(decide('anthropic', 'claude-opus-5-5', { modelInfo: listed(false) }), null);
  assert.equal(decide('openai', 'gpt-4-turbo', { modelInfo: listed() }), null);
  assert.equal(decide('mistral', 'mistral-large-2411', { modelInfo: listed() }), null);
  assert.equal(decide('openrouter', 'meta-llama/llama-3-8b-instruct', { modelInfo: listed(false) }), null);
  assert.equal(decide('openrouter', 'qwen/qwen3-235b', { modelInfo: listed(true) }), FORMAT);
  // All-model providers: only an explicit no turns it off.
  assert.equal(decide('ollama', 'tiny', { modelInfo: listed(false) }), null);
  assert.equal(decide('ollama', 'llama3.2', { modelInfo: listed() }), FORMAT);
  // A direct-provider entry reached through the bridge never gets it.
  assert.equal(decide('anthropic', 'claude-opus-5-5', { via: 'bridge' }), null);
});

test('native structured output with tools follows each provider’s docs, and non-strict schemas fall back to free text', () => {
  const decide = (providerId, model, extra = {}) => nativeResponseFormat({ provider: getProvider(providerId), via: 'direct', model, modelInfo: null, format: FORMAT, ...extra });
  for (const [providerId, model] of [['anthropic', 'claude-opus-5-5'], ['openai', 'gpt-6.1-sol'], ['xai', 'grok-4.7'], ['google', 'gemini-4-argon']]) {
    assert.equal(decide(providerId, model, { tools: TOOLS }), FORMAT, `${providerId} documents the format together with tools`);
  }
  for (const [providerId, model] of [['openrouter', 'openai/gpt-6.1-sol'], ['mistral', 'mistral-large-latest'], ['ollama', 'qwen3'], ['lmstudio', 'qwen3-8b']]) {
    assert.equal(decide(providerId, model, { tools: TOOLS }), null, `${providerId} leaves the format out when tools are sent`);
    assert.equal(decide(providerId, model), FORMAT);
  }
  const loose = [
    { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    { type: 'object', properties: { title: { type: 'string' }, note: { type: 'string' } }, required: ['title'], additionalProperties: false },
    { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'], additionalProperties: false },
    { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' }, minItems: 2 } }, required: ['tags'], additionalProperties: false },
    { type: 'object', properties: { self: { $ref: '#' } }, required: ['self'], additionalProperties: false },
  ];
  for (const schema of loose) {
    for (const [providerId, model] of [['anthropic', 'claude-opus-5-5'], ['openai', 'gpt-6.1-sol'], ['google', 'gemini-4-argon'], ['ollama', 'qwen3']]) {
      assert.equal(decide(providerId, model, { format: { ...FORMAT, schema } }), null, `${providerId}: ${JSON.stringify(schema)}`);
    }
  }
});

test('model lists mark structured-output support where the provider says so', async t => {
  let reply = null;
  mockFetch(t, () => new Response(JSON.stringify(reply)));
  reply = { data: ['gpt-6.1-sol', 'gpt-5.5', 'o4-mini', 'gpt-5-chat-latest', 'gpt-4o', 'text-embedding-3-small'].map(id => ({ id })) };
  const openai = Object.fromEntries((await responses.listModels({ provider: getProvider('openai'), baseUrl: 'https://api.openai.com/v1', apiKey: KEY })).map(entry => [entry.id, entry.capabilities.structuredOutputs]));
  assert.deepEqual(openai, { 'gpt-6.1-sol': true, 'gpt-5.5': true, 'o4-mini': true, 'gpt-5-chat-latest': undefined, 'gpt-4o': undefined, 'text-embedding-3-small': undefined });

  reply = { data: [
    { id: 'qwen/qwen3-235b', supported_parameters: ['tools', 'response_format', 'structured_outputs'] },
    { id: 'meta-llama/llama-3-8b-instruct', supported_parameters: ['tools', 'response_format'] },
    { id: 'plain-model' },
  ] };
  const routed = Object.fromEntries((await chat.listModels({ provider: getProvider('openrouter'), baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY })).map(entry => [entry.id, entry.capabilities.structuredOutputs]));
  assert.deepEqual(routed, { 'qwen/qwen3-235b': true, 'meta-llama/llama-3-8b-instruct': false, 'plain-model': undefined });

  reply = { models: [
    { name: 'models/gemini-4-argon', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemma-3-27b-it', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
  ] };
  const google = Object.fromEntries((await gemini.listModels({ provider: getProvider('google'), baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: KEY })).map(entry => [entry.id, entry.capabilities.structuredOutputs]));
  assert.deepEqual(google, { 'gemini-4-argon': true, 'gemini-2.5-flash': true, 'gemini-2.0-flash': undefined, 'gemma-3-27b-it': undefined, 'gemini-embedding-001': undefined });
});

// ---------- streamChat end to end ----------

test('streamChat sends the native format to Claude and omits it for Groq, DeepSeek and custom servers', async t => {
  localStorage.clear();
  configureConnections({ integrations: { getIntegrationSettings: async () => ({ bridgeConfigured: false }) } });
  const claude = await saveConnection({ providerId: 'anthropic', apiKey: KEY });
  const groq = await saveConnection({ providerId: 'groq', apiKey: KEY });
  const deepseek = await saveConnection({ providerId: 'deepseek', apiKey: KEY });
  const custom = await saveConnection({ providerId: 'custom-openai', baseUrl: 'https://llm.example.com/v1', defaultModel: 'house-model' });
  const calls = mockFetch(t, call => new Response(body(call.url.endsWith('/messages') ? anthropicReply(REPLY) : chatReply(REPLY))));
  const request = { system: 'File the page.', messages: [{ role: 'user', content: 'Page' }], responseFormat: FORMAT, effort: 'low' };

  const result = await streamChat({ ...request, connectionId: claude.id, model: 'claude-haiku-5-5' });
  assert.equal(result.text, REPLY);
  assert.deepEqual(calls[0].body.output_config, { effort: 'low', format: { type: 'json_schema', schema: SUGGESTION_SCHEMA } });

  for (const saved of [groq, deepseek, custom]) {
    const before = calls.length;
    const reply = await streamChat({ ...request, connectionId: saved.id });
    assert.equal(reply.text, REPLY);
    const sent = calls[before].body;
    assert.ok(!('response_format' in sent) && !('text' in sent), `${saved.providerId} gets no structured-output parameter`);
    assert.equal(sent.stream, true);
  }
});

test('streamChat with tools: Claude keeps both; OpenRouter keeps the tools and leaves the format out', async t => {
  localStorage.clear();
  configureConnections({ integrations: { getIntegrationSettings: async () => ({ bridgeConfigured: false }) } });
  const claude = await saveConnection({ providerId: 'anthropic', apiKey: KEY });
  const router = await saveConnection({ providerId: 'openrouter', apiKey: KEY });
  const calls = mockFetch(t, call => new Response(body(call.url.endsWith('/messages') ? anthropicReply(REPLY) : chatReply(REPLY))));
  const request = { messages: [{ role: 'user', content: 'Page' }], tools: TOOLS, responseFormat: FORMAT };
  await streamChat({ ...request, connectionId: claude.id, model: 'claude-opus-5-5' });
  assert.equal(calls[0].body.tools[0].name, 'search_library');
  assert.deepEqual(calls[0].body.output_config.format, { type: 'json_schema', schema: SUGGESTION_SCHEMA });
  await streamChat({ ...request, connectionId: router.id, model: 'anthropic/claude-opus-5.5' });
  assert.equal(calls[1].body.tools[0].function.name, 'search_library');
  assert.ok(!('response_format' in calls[1].body));
  await streamChat({ ...request, tools: [], connectionId: router.id, model: 'anthropic/claude-opus-5.5' });
  assert.equal(calls[2].body.response_format.type, 'json_schema');
});

test('streamChat drops the format on the bridge and rejects a malformed one before any request', async t => {
  localStorage.clear();
  const bridged = [];
  configureConnections({ integrations: {
    getIntegrationSettings: async () => ({ bridgeConfigured: true }),
    requestBridge: async (path, options = {}) => {
      if (path === '/ai/providers') return { providers: [], agents: [{ id: 'codex', name: 'Codex CLI', available: true, status: 'ready', capabilities: { generate: true } }] };
      bridged.push(options.body);
      options.onEvent?.({ type: 'delta', text: REPLY });
      return { type: 'done', text: REPLY, stopReason: 'completed' };
    },
  } });
  const result = await streamChat({ connectionId: 'agent:codex', model: 'default', messages: [{ role: 'user', content: 'Page' }], responseFormat: FORMAT });
  assert.equal(result.text, REPLY);
  assert.ok(!JSON.stringify(bridged[0]).includes('save_suggestion'), 'nothing about the format reaches the bridge');

  localStorage.clear();
  configureConnections({ integrations: { getIntegrationSettings: async () => ({ bridgeConfigured: false }) } });
  const claude = await saveConnection({ providerId: 'anthropic', apiKey: KEY });
  const calls = mockFetch(t, () => new Response(body(anthropicReply(REPLY))));
  const error = await streamChat({ connectionId: claude.id, messages: [{ role: 'user', content: 'Page' }], responseFormat: { type: 'json_object' } }).catch(caught => caught);
  assert.equal(error.code, 'bad_request');
  assert.equal(calls.length, 0);
});

test('suggestForSave: Claude answers through output_config.format after thinking; Groq answers as free text that is still parsed', async t => {
  localStorage.clear();
  configureConnections({ integrations: { getIntegrationSettings: async () => ({ bridgeConfigured: false }) } });
  const claude = await saveConnection({ providerId: 'anthropic', apiKey: KEY });
  const groq = await saveConnection({ providerId: 'groq', apiKey: KEY });
  const calls = mockFetch(t, call => new Response(body(call.url.endsWith('/messages')
    ? anthropicReply(REPLY, { thinking: 'Fonts, so typography.' })
    : chatReply(`Here you go:\n\`\`\`json\n${REPLY}\n\`\`\``))));
  const page = { url: 'https://fonts.example.com/inter', title: 'Inter | Fonts', excerpt: 'Typeface.', content: 'A typeface for screens.', collections: [], tags: [] };
  for (const [saved, model] of [[claude, 'claude-haiku-5-5'], [groq, 'llama-3.1-8b-instant']]) {
    const transforms = createTransforms({ streamChat, resolveChatTarget: async () => ({ connectionId: saved.id, model, effort: 'low', via: 'direct' }) });
    const suggestion = await transforms.suggestForSave(page);
    assert.equal(suggestion.source, 'ai', saved.providerId);
    assert.equal(suggestion.title, 'Inter typeface');
  }
  assert.deepEqual(calls[0].body.output_config, { effort: 'low', format: { type: 'json_schema', schema: SUGGESTION_SCHEMA } });
  assert.equal(calls[0].body.max_tokens, 8000);
  assert.ok(!('response_format' in calls[1].body));
});
