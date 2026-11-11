// Web search by the model's provider: the setting, which connections can use it, the request each transport builds,
// what the streams give back (queries, sources, citations) and how a paused search turn is carried on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, catalogModel, modelFromCatalog } from '../extension/lib/ai/catalog.js';
import * as anthropic from '../extension/lib/ai/transports/anthropic.js';
import * as responses from '../extension/lib/ai/transports/openai-responses.js';
import {
  WEB_SEARCH_DEFAULTS, WEB_SEARCH_LIMITS, anthropicWebSearchTool, isNormalWebSearch, mergeWebSources, normalizeWebSearch, openAiWebSearchTool, webSearchKind, webSource,
} from '../extension/lib/ai/web-search.js';

const KEY = 'sk-test-SECRETKEY-0123456789abcdef';
const encoder = new TextEncoder();
const body = (text, size = 11) => { const bytes = encoder.encode(text); return new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.subarray(i, i + size)); controller.close(); } }); };
const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
function mockFetch(t, handler) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => { const call = { url: String(url), body: options.body ? JSON.parse(options.body) : null }; calls.push(call); return handler(call); };
  t.after(() => { globalThis.fetch = previous; });
  return calls;
}
function ctx(providerId, overrides = {}) {
  const provider = getProvider(providerId);
  const model = overrides.model || provider.chat?.recommended;
  const entry = catalogModel(providerId, model);
  const events = [];
  return { events, value: { provider, connection: { id: `${providerId}-test`, label: provider.name }, apiKey: KEY, baseUrl: provider.baseUrl, model, modelInfo: entry ? modelFromCatalog(entry) : null,
    system: 'You are Still.', messages: [{ role: 'user', content: 'Hello' }], tools: [], effort: 'medium', signal: undefined, emit: event => events.push(event), ...overrides } };
}
const TOOLS = [{ name: 'search_library', description: 'Search the library', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }];

// ------------------------------------------------------------------------------------------------- the setting
test('web search is off by default, and its setting is complete and in range or refused', () => {
  assert.deepEqual({ ...WEB_SEARCH_DEFAULTS }, { enabled: false, maxUses: 5 });
  assert.deepEqual(normalizeWebSearch(undefined), { enabled: false, maxUses: 5 });
  assert.deepEqual(normalizeWebSearch({ enabled: true, maxUses: '8', extra: 1 }), { enabled: true, maxUses: 8 });
  assert.equal(normalizeWebSearch({ enabled: 'yes' }).enabled, false, 'only true turns it on');
  assert.equal(normalizeWebSearch({ maxUses: 0 }).maxUses, WEB_SEARCH_LIMITS.minUses);
  assert.equal(normalizeWebSearch({ maxUses: 500 }).maxUses, WEB_SEARCH_LIMITS.maxUses);
  assert.equal(normalizeWebSearch({ maxUses: 'many' }).maxUses, 5);
  assert.equal(isNormalWebSearch({ enabled: true, maxUses: 5 }), true);
  for (const value of [null, [], { enabled: true }, { enabled: true, maxUses: 50 }, { enabled: 'true', maxUses: 5 }, { enabled: true, maxUses: 5, extra: 1 }, { enabled: true, maxUses: 2.5 }])
    assert.equal(isNormalWebSearch(value), false, JSON.stringify(value));
});

test('only the providers\' own hosts can search: a compatible server elsewhere is not offered the tool', () => {
  assert.equal(webSearchKind({ provider: getProvider('anthropic'), baseUrl: 'https://api.anthropic.com/v1' }), 'anthropic');
  assert.equal(webSearchKind({ provider: getProvider('openai'), baseUrl: 'https://api.openai.com/v1' }), 'openai');
  assert.equal(webSearchKind({ provider: getProvider('anthropic') }), 'anthropic', 'the provider\'s own address is the default');
  assert.equal(webSearchKind({ provider: getProvider('custom-anthropic'), baseUrl: 'https://api.anthropic.com/v1' }), '', 'a custom connection is not the provider');
  assert.equal(webSearchKind({ provider: getProvider('anthropic'), baseUrl: 'https://proxy.example/v1' }), '');
  assert.equal(webSearchKind({ provider: getProvider('openai'), baseUrl: 'https://api.openai.com.evil.example/v1' }), '');
  for (const id of ['google', 'ollama', 'lmstudio', 'openrouter', 'perplexity', 'custom-openai']) assert.equal(webSearchKind({ provider: getProvider(id), baseUrl: getProvider(id).baseUrl }), '', id);
  assert.equal(webSearchKind({}), '');
});

test('the Anthropic tool is the current version for the models that take it, and the basic one for the rest', () => {
  for (const model of ['claude-fable-5-2', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6'])
    assert.deepEqual(anthropicWebSearchTool(model, { maxUses: 3 }), { type: 'web_search_20260209', name: 'web_search', max_uses: 3 }, model);
  for (const model of ['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-opus-4-5', 'claude-sonnet-4-5', 'some-other-model', ''])
    assert.equal(anthropicWebSearchTool(model).type, 'web_search_20250305', model);
  assert.equal(anthropicWebSearchTool('claude-opus-5-5', { maxUses: 99 }).max_uses, 10, 'the cap is kept in range');
  assert.equal(anthropicWebSearchTool('claude-opus-5-5').max_uses, 5);
  assert.deepEqual(openAiWebSearchTool(), { type: 'web_search' });
});

test('a source is a web address with a title; anything else is dropped, and repeats are merged in order', () => {
  assert.deepEqual(webSource('https://example.com/a?utm_source=chatgpt.com&x=1', '  The   page  '), { url: 'https://example.com/a?x=1', title: 'The page' });
  assert.deepEqual(webSource('https://www.example.com/a'), { url: 'https://www.example.com/a', title: 'example.com' });
  for (const address of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'chrome://settings', 'not a url', '', null]) assert.equal(webSource(address, 'x'), null, String(address));
  assert.deepEqual(mergeWebSources([{ url: 'https://a.example/', title: 'A' }, { url: 'javascript:1' }, null], [{ url: 'https://b.example/' }, { url: 'https://a.example/', title: 'Again' }]),
    [{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/', title: 'b.example' }]);
  assert.equal(mergeWebSources(Array.from({ length: 80 }, (_, index) => ({ url: `https://e.example/${index}` }))).length, 40);
});

// ------------------------------------------------------------------------------------------------- Anthropic
test('Anthropic: the search tool follows the client tools, only on the official host, only when asked for', () => {
  const { value } = ctx('anthropic', { tools: TOOLS, model: 'claude-opus-5-5' });
  assert.equal(anthropic.buildRequest(value).body.tools.length, 1, 'no search tool unless the request asks for it');
  const request = anthropic.buildRequest({ ...value, webSearch: { maxUses: 4 } });
  assert.deepEqual(request.body.tools.map(tool => tool.name), ['search_library', 'web_search']);
  assert.deepEqual(request.body.tools[1], { type: 'web_search_20260209', name: 'web_search', max_uses: 4 });
  assert.deepEqual(request.body.tool_choice, { type: 'auto' });
  assert.ok(!('anthropic-beta' in request.headers) || !/web/.test(request.headers['anthropic-beta']), 'no beta header is needed for web search');
  const alone = anthropic.buildRequest({ ...value, tools: [], webSearch: { maxUses: 4 } });
  assert.deepEqual(alone.body.tools.map(tool => tool.name), ['web_search'], 'web search works without client tools');
  const elsewhere = anthropic.buildRequest({ ...value, baseUrl: 'https://proxy.example/v1', webSearch: { maxUses: 4 } });
  assert.deepEqual(elsewhere.body.tools.map(tool => tool.name), ['search_library']);
});

const ANTHROPIC_SEARCH = [
  { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 900, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"kettle shop ' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'opening hours"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [
    { type: 'web_search_result', url: 'https://kettle.example/hours', title: 'Opening hours', encrypted_content: 'enc1', page_age: 'March 2026' },
    { type: 'web_search_result', url: 'https://maps.example/kettle-(shop)', title: 'Kettle shop on the map', encrypted_content: 'enc2' },
    { type: 'web_search_result', url: 'javascript:alert(1)', title: 'bad', encrypted_content: 'enc3' },
  ] } },
  { type: 'content_block_stop', index: 2 },
  { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '', citations: [] } },
  { type: 'content_block_delta', index: 3, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://maps.example/kettle-(shop)', title: 'Kettle shop on the map', cited_text: 'Open 9 to 5', encrypted_index: 'idx' } } },
  { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: ' The shop is open from 9 to 5.' } },
  { type: 'content_block_stop', index: 3 },
  { type: 'content_block_start', index: 4, content_block: { type: 'text', text: '', citations: [] } },
  { type: 'content_block_delta', index: 4, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://maps.example/kettle-(shop)', title: 'Kettle shop on the map', cited_text: 'Closed Sundays', encrypted_index: 'idx2' } } },
  { type: 'content_block_delta', index: 4, delta: { type: 'text_delta', text: ' It is closed on Sundays.' } },
  { type: 'content_block_stop', index: 4 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 80, server_tool_use: { web_search_requests: 1 } } },
  { type: 'message_stop' },
];

test('Anthropic: a search gives the query as an event, its sources, and a link where the answer first cites one', async t => {
  mockFetch(t, () => new Response(body(sse(ANTHROPIC_SEARCH))));
  const { value, events } = ctx('anthropic', { model: 'claude-opus-5-5', webSearch: { maxUses: 5 } });
  const result = await anthropic.stream(value);
  assert.deepEqual(events.filter(event => event.type === 'web_search'), [{ type: 'web_search', started: true }, { type: 'web_search', query: 'kettle shop opening hours' }],
    'a search is announced when it starts, before its query is complete');
  assert.equal(result.webSearched, true);
  assert.equal(result.text, 'Let me check. The shop is open from 9 to 5. ([maps.example](https://maps.example/kettle-%28shop%29)) It is closed on Sundays.',
    'the address follows the first sentence that rests on it, with its parentheses escaped; a second citation of it adds nothing');
  assert.equal(events.filter(event => event.type === 'text').map(event => event.delta).join(''), result.text, 'what streamed is what was returned');
  assert.deepEqual(result.webSources, [{ url: 'https://maps.example/kettle-(shop)', title: 'Kettle shop on the map' }, { url: 'https://kettle.example/hours', title: 'Opening hours' }],
    'cited sources first, then the other results; an address that is not a web address is dropped');
  assert.equal(result.usage.webSearchRequests, 1);
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(result.toolCalls, [], 'a search the provider ran is not a tool call for Still to run');
  // The copy sent back keeps the provider's own blocks, so the next request is accepted and the citations stay valid.
  const native = result.assistantMessage.native.content;
  assert.deepEqual(native.map(block => block.type), ['text', 'server_tool_use', 'web_search_tool_result', 'text', 'text']);
  assert.equal(native[1].input.query, 'kettle shop opening hours');
  assert.equal(native[3].text, ' The shop is open from 9 to 5.', 'the link Still added for the person is not part of what the model said');
  assert.equal(native[3].citations.length, 1);
  const next = anthropic.buildRequest({ ...value, messages: [{ role: 'user', content: 'Hours?' }, result.assistantMessage, { role: 'user', content: 'And Mondays?' }] });
  assert.deepEqual(next.body.messages[1], { role: 'assistant', content: native });
});

test('Anthropic: a failed search is an event, not an error, and a paused turn is reported so the caller can carry on', async t => {
  mockFetch(t, () => new Response(body(sse([
    { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]))));
  const { value, events } = ctx('anthropic', { model: 'claude-opus-5-5', webSearch: { maxUses: 1 } });
  const result = await anthropic.stream(value);
  assert.deepEqual(events.filter(event => event.type === 'web_search'), [{ type: 'web_search', started: true }, { type: 'web_search', query: 'x' }, { type: 'web_search', error: 'max_uses_exceeded' }]);
  assert.equal(result.stopReason, 'pause_turn');
  assert.equal(result.webSources, undefined);
  assert.equal(result.webSearched, true, 'a search that started counts, whatever came of it');
  assert.equal(result.assistantMessage.native.content.at(-1).type, 'web_search_tool_result', 'the paused turn ends with the provider\'s block, which is how it is resumed');
});

// ---------------------------------------------------------------------------------------------------- OpenAI
test('OpenAI Responses: the search tool is added beside the function tools when asked for', () => {
  const { value } = ctx('openai', { tools: TOOLS });
  assert.deepEqual(responses.buildRequest(value).body.tools.map(tool => tool.type), ['function']);
  const request = responses.buildRequest({ ...value, webSearch: { maxUses: 5 } });
  assert.deepEqual(request.body.tools.map(tool => tool.type), ['function', 'web_search']);
  assert.equal(request.body.tool_choice, 'auto');
  assert.deepEqual(responses.buildRequest({ ...value, tools: [], webSearch: { maxUses: 5 } }).body.tools, [{ type: 'web_search' }]);
});

test('OpenAI Responses: searches are events, citations become sources, and the search items are replayed as given', async t => {
  const search = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'kettle shop opening hours' } };
  const message = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Open 9 to 5 ([kettle.example](https://kettle.example/hours)).',
    annotations: [{ type: 'url_citation', start_index: 12, end_index: 60, url: 'https://kettle.example/hours?utm_source=openai', title: 'Opening hours' }] }] };
  mockFetch(t, () => new Response(body(sse([
    { type: 'response.created', response: { model: 'gpt-6.1-sol' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 0, item: search },
    { type: 'response.output_text.delta', delta: 'Open 9 to 5 ' },
    { type: 'response.output_text.delta', delta: '([kettle.example](https://kettle.example/hours)).' },
    { type: 'response.output_text.annotation.added', annotation: message.content[0].annotations[0] },
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.completed', response: { model: 'gpt-6.1-sol', status: 'completed', output: [search, message], usage: { input_tokens: 300, output_tokens: 40 } } },
  ]))));
  const { value, events } = ctx('openai', { webSearch: { maxUses: 5 } });
  const result = await responses.stream(value);
  assert.deepEqual(events.filter(event => event.type === 'web_search'), [{ type: 'web_search', started: true }, { type: 'web_search', query: 'kettle shop opening hours' }]);
  assert.equal(result.webSearched, true);
  assert.equal(result.text, 'Open 9 to 5 ([kettle.example](https://kettle.example/hours)).');
  assert.deepEqual(result.webSources, [{ url: 'https://kettle.example/hours', title: 'Opening hours' }], 'one source, though the citation arrived twice');
  assert.deepEqual(result.toolCalls, []);
  const next = responses.buildRequest({ ...value, messages: [{ role: 'user', content: 'Hours?' }, result.assistantMessage, { role: 'user', content: 'And Mondays?' }] });
  assert.deepEqual(next.body.input.slice(1, 3), [search, message], 'the provider\'s items go back unchanged');
});

test('a search counts as soon as the provider starts it: results that are read but never cited, and a tool of another name', async t => {
  // Results arrive, the answer cites nothing.
  mockFetch(t, () => new Response(body(sse([
    ...ANTHROPIC_SEARCH.slice(0, 9),
    { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: ' Nothing useful.' } },
    { type: 'content_block_stop', index: 3 },
    ...ANTHROPIC_SEARCH.slice(-2),
  ]))));
  const uncited = await anthropic.stream(ctx('anthropic', { model: 'claude-opus-5-5', webSearch: { maxUses: 5 } }).value);
  assert.equal(uncited.webSearched, true);
  assert.deepEqual(uncited.webSources.map(source => source.url), ['https://kettle.example/hours', 'https://maps.example/kettle-(shop)'], 'what the search found is still listed');
  // The newer search tool filters results with code the provider runs: no result block of the search's own reaches Still.
  mockFetch(t, () => new Response(body(sse([
    { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_9', name: 'code_execution', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"code":"results = web_search(q)"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'code_execution_tool_result', tool_use_id: 'srvtoolu_9', content: { type: 'code_execution_result', stdout: 'Open 9 to 5', stderr: '', return_code: 0 } } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Open 9 to 5.' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ]))));
  const filtered = ctx('anthropic', { model: 'claude-opus-5-5', webSearch: { maxUses: 5 } });
  const other = await anthropic.stream(filtered.value);
  assert.equal(other.webSearched, true);
  assert.equal(other.webSources, undefined);
  assert.deepEqual(filtered.events.filter(event => event.type === 'web_search'), [{ type: 'web_search', started: true }], 'announced once, with nothing to show');
  assert.deepEqual(other.assistantMessage.native.content.map(block => block.type), ['server_tool_use', 'code_execution_tool_result', 'text'], 'the provider\'s blocks go back as they came');
  // An answer without any search says nothing of the kind.
  mockFetch(t, () => new Response(body(sse([ANTHROPIC_SEARCH[0], ...ANTHROPIC_SEARCH.slice(1, 4), { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }]))));
  const plain = ctx('anthropic', { model: 'claude-opus-5-5', webSearch: { maxUses: 5 } });
  const none = await anthropic.stream(plain.value);
  assert.equal(none.webSearched, undefined);
  assert.deepEqual(plain.events.filter(event => event.type === 'web_search'), []);
});

test('OpenAI Responses: a page the provider opened is a source, and a search without a single citation still counts', async t => {
  const opened = { type: 'web_search_call', id: 'ws_2', status: 'completed', action: { type: 'open_page', url: 'https://kettle.example/hours' } };
  const message = { type: 'message', id: 'msg_2', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Open 9 to 5.', annotations: [] }] };
  mockFetch(t, () => new Response(body(sse([
    { type: 'response.created', response: { model: 'gpt-6.1-sol' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'web_search_call', id: 'ws_2', status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 0, item: opened },
    { type: 'response.output_text.delta', delta: 'Open 9 to 5.' },
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.completed', response: { model: 'gpt-6.1-sol', status: 'completed', output: [opened, message], usage: { input_tokens: 30, output_tokens: 4 } } },
  ]))));
  const { value, events } = ctx('openai', { webSearch: { maxUses: 5 } });
  const result = await responses.stream(value);
  assert.equal(result.webSearched, true);
  assert.deepEqual(result.webSources, [{ url: 'https://kettle.example/hours', title: 'kettle.example' }]);
  assert.deepEqual(events.filter(event => event.type === 'web_search'), [{ type: 'web_search', started: true }], 'opening a page is not a search to list');
  // No search, no word about one.
  mockFetch(t, () => new Response(body(sse([
    { type: 'response.created', response: { model: 'gpt-6.1-sol' } },
    { type: 'response.output_text.delta', delta: 'Hello.' },
    { type: 'response.output_item.done', output_index: 0, item: { ...message, content: [{ type: 'output_text', text: 'Hello.', annotations: [] }] } },
    { type: 'response.completed', response: { model: 'gpt-6.1-sol', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1 } } },
  ]))));
  const none = await responses.stream(ctx('openai', { webSearch: { maxUses: 5 } }).value);
  assert.equal(none.webSearched, undefined);
  assert.equal(none.webSources, undefined);
});

// ------------------------------------------------------------------------------------------- in the assistant
const { createAssistant } = await import('../extension/lib/ai/assistant.js');
const { createSearch } = await import('../extension/lib/ai/search.js');
const { createConversationStore, createMemoryStorage, normalizeConversation } = await import('../extension/lib/ai/conversations.js');
const { createLibraryStore } = await import('../extension/lib/store.js');
const { assistantSystemPrompt } = await import('../extension/lib/ai-prompts.js');

function memoryStore(seed) {
  let state = null;
  const library = createLibraryStore({ read: async () => state, write: async next => { state = next; } });
  const call = (operation, ...args) => library.dispatch(operation, args);
  return { ready: call('loadLibrary', seed), loadLibrary: () => call('loadLibrary'), saveItem: input => call('saveItem', input), updateItem: (id, patch, options = {}) => call('updateItem', id, patch, options),
    bulkUpdateItems: (changes, options = {}) => call('bulkUpdateItems', changes, options), createCollection: input => call('createCollection', input),
    deleteItem: (id, options = {}) => call('deleteItem', id, options), permanentlyDeleteItem: (id, options = {}) => call('permanentlyDeleteItem', id, options),
    deleteCollection: (id, options = {}) => call('deleteCollection', id, options) };
}
async function harness({ model, webSearch = { enabled: true, maxUses: 4 }, providerId = 'anthropic', baseUrl, permissions } = {}) {
  const store = memoryStore({ schemaVersion: 1, collections: [], items: [{ id: 'kyoto', type: 'bookmark', title: 'Kyoto temples', url: 'https://example.com/kyoto', tags: [] }] });
  await store.ready;
  const getLibrary = () => store.loadLibrary();
  const provider = getProvider(providerId);
  const calls = [];
  let counter = 0;
  const assistant = createAssistant({ store, getLibrary, searchLibrary: createSearch({ getLibrary }).searchLibrary, conversations: createConversationStore({ storage: createMemoryStorage() }),
    uid: prefix => `${prefix}_${++counter}`, now: () => '2026-11-11T09:30:00.000Z', retry: { wait: async () => {} },
    getAiSettings: async () => ({ chat: { connectionId: 'conn', model: 'claude-opus-5-5' }, webSearch, ...(permissions ? { assistantPermissions: permissions } : {}) }),
    resolveConnection: async id => ({ connection: { id, label: provider.name }, provider, baseUrl: baseUrl || provider.baseUrl, apiKey: KEY, via: 'direct' }),
    streamChat: async request => { calls.push({ ...request, messages: structuredClone(request.messages), onEvent: undefined, signal: undefined }); return model(request, calls.length); } });
  return { assistant, getLibrary, calls };
}
const ask = (assistant, options = {}) => { const events = []; return assistant.runAssistant({ input: 'When is the kettle shop open?', context: { scope: 'library' }, onEvent: event => events.push(event), ...options }).then(result => ({ ...result, events })); };
const SOURCES = [{ url: 'https://kettle.example/hours', title: 'Opening hours' }];

test('with web search on and a connection that has it, the provider may search; the answer keeps its sources', async () => {
  const { assistant, calls } = await harness({ model: async ({ onEvent, webSearch, system }) => {
    assert.deepEqual(webSearch, { maxUses: 4 });
    assert.match(system, /Web search:\n- You can search the web with web_search/);
    assert.match(system, /Never put the user’s notes, saved items or other private data into a search query/);
    onEvent({ type: 'web_search', query: 'kettle shop opening hours' });
    onEvent({ type: 'text', delta: 'Open 9 to 5.' });
    return { text: 'Open 9 to 5.', toolCalls: [], stopReason: 'end_turn', webSources: [...SOURCES, { url: 'javascript:alert(1)', title: 'bad' }] };
  } });
  const { message, events, conversation } = await ask(assistant);
  assert.equal(message.error, '');
  assert.deepEqual(message.webSources, SOURCES, 'only web addresses are kept');
  assert.deepEqual(message.tools, [{ name: 'web_search', summary: 'Searched the web for “kettle shop opening hours”' }]);
  assert.deepEqual(events.find(event => event.type === 'web_sources'), { type: 'web_sources', items: SOURCES });
  assert.ok(events.some(event => event.type === 'tool' && event.name === 'web_search' && event.usedThreads === true));
  assert.ok(events.some(event => event.type === 'status' && event.label === 'Searching the web'));
  assert.equal(message.usedThreads, true, 'an answer built on web pages loads no remote images');
  assert.deepEqual(conversation.messages.at(-1).webSources, SOURCES, 'the sources are saved with the answer');
  assert.equal(calls.length, 1);
});

test('web search is off unless the person turned it on, and is never offered to a connection that cannot do it', async () => {
  const quiet = async ({ onEvent, webSearch, system }) => { assert.equal(webSearch, undefined); assert.doesNotMatch(system, /Web search:/); onEvent({ type: 'text', delta: 'ok' }); return { text: 'ok', toolCalls: [], stopReason: 'end_turn' }; };
  for (const options of [{ webSearch: null }, { webSearch: { enabled: false, maxUses: 5 } }, { webSearch: { enabled: 'yes' } },
    { providerId: 'anthropic', baseUrl: 'https://proxy.example/v1' }, { providerId: 'ollama' }, { providerId: 'google' }, { providerId: 'custom-openai', baseUrl: 'https://api.openai.com/v1' }]) {
    const { assistant } = await harness({ model: quiet, ...options });
    const { message } = await ask(assistant);
    assert.equal(message.error, '', JSON.stringify(options));
    assert.equal(message.webSources, undefined);
  }
  const openai = await harness({ providerId: 'openai', model: async ({ onEvent, webSearch }) => { assert.deepEqual(webSearch, { maxUses: 4 }); onEvent({ type: 'text', delta: 'ok' }); return { text: 'ok', toolCalls: [], stopReason: 'end_turn' }; } });
  assert.equal((await ask(openai.assistant)).message.error, '');
});

test('once web results are in the turn, a library change asks even where the person lets it apply without review', async () => {
  const proposals = [];
  const { assistant, getLibrary } = await harness({ permissions: { create: 'allow', organize: 'allow', edit: 'allow', dashboard: 'allow', delete: 'ask' },
    model: async ({ onEvent }, n) => {
      if (n === 1) { onEvent({ type: 'web_search', query: 'x' }); return { text: '', toolCalls: [{ id: 'w1', name: 'add_tags', input: { ids: ['kyoto'], tags: ['from-the-web'] } }], stopReason: 'tool_use', webSources: SOURCES }; }
      onEvent({ type: 'text', delta: 'Done.' });
      return { text: 'Done.', toolCalls: [], stopReason: 'end_turn' };
    } });
  const { message } = await ask(assistant, { onProposal: async proposal => { proposals.push(proposal); return 'discard'; } });
  assert.equal(proposals.length, 1, 'the change went to a card');
  assert.notEqual(proposals[0].autoApproved, true);
  assert.equal(message.proposals[0].status, 'discarded');
  assert.deepEqual((await getLibrary()).items.find(item => item.id === 'kyoto').tags, []);
});

test('the latch does not wait for a citation: a search the answer never cites, or one that only started, is enough', async () => {
  const permissions = { create: 'allow', organize: 'allow', edit: 'allow', dashboard: 'allow', delete: 'ask' };
  const tag = { id: 'w1', name: 'add_tags', input: { ids: ['kyoto'], tags: ['from-the-web'] } };
  const done = onEvent => { onEvent({ type: 'text', delta: 'Done.' }); return { text: 'Done.', toolCalls: [], stopReason: 'end_turn' }; };
  // The provider says it searched, names no page, and Still saw no event for it.
  for (const first of [
    () => ({ text: '', toolCalls: [tag], stopReason: 'tool_use', webSearched: true }),
    onEvent => { onEvent({ type: 'web_search', started: true }); return { text: '', toolCalls: [tag], stopReason: 'tool_use' }; },
  ]) {
    const proposals = [];
    const { assistant, getLibrary } = await harness({ permissions, model: async ({ onEvent }, n) => (n === 1 ? first(onEvent) : done(onEvent)) });
    const { message, events } = await ask(assistant, { onProposal: async proposal => { proposals.push(proposal); return 'discard'; } });
    assert.equal(proposals.length, 1, 'the change went to a card');
    assert.notEqual(proposals[0].autoApproved, true);
    assert.equal(message.usedThreads, true);
    assert.equal(message.webSources, undefined, 'no page was named, so none is listed');
    assert.deepEqual(message.tools.filter(tool => tool.name === 'web_search'), [], 'a search that only started is not a step to list');
    assert.ok(!events.some(event => event.type === 'web_sources'));
    assert.deepEqual((await getLibrary()).items.find(item => item.id === 'kyoto').tags, []);
  }
  // Without a search the same change applies at once: the latch is about the web, not about the setting.
  const quiet = await harness({ permissions, model: async ({ onEvent }, n) => (n === 1 ? { text: '', toolCalls: [tag], stopReason: 'tool_use' } : done(onEvent)) });
  const asked = [];
  const applied = await ask(quiet.assistant, { onProposal: async proposal => { asked.push(proposal); return 'discard'; } });
  assert.equal(asked.length, 0);
  assert.notEqual(applied.message.usedThreads, true);
  assert.deepEqual((await quiet.getLibrary()).items.find(item => item.id === 'kyoto').tags, ['from-the-web']);
});

test('an answer that breaks off after a search began is still kept as one that holds web text', async () => {
  const { assistant } = await harness({ model: async ({ onEvent }) => {
    onEvent({ type: 'web_search', started: true });
    onEvent({ type: 'text', delta: 'The shop ![x](https://tracker.example/?q=secret)' });
    throw Object.assign(new Error('The connection was lost.'), { code: 'network' });
  } });
  const { message, conversation } = await ask(assistant);
  assert.ok(message.error, 'the turn failed');
  assert.match(message.text, /The shop/);
  assert.equal(message.usedThreads, true, 'so what it wrote so far is shown without remote images');
  assert.equal(conversation.messages.at(-1).usedThreads, true, 'and stays that way after a reload');
});

test('a model that does not take the search tool is asked again without it, and the person is told', async () => {
  const { assistant, calls } = await harness({ model: async ({ onEvent, webSearch, system }, n) => {
    if (n === 1) { assert.ok(webSearch); throw Object.assign(new Error('Anthropic: tools.3.web_search_20260209 is not supported for this model'), { status: 400, code: 'bad_request' }); }
    assert.equal(webSearch, undefined);
    assert.doesNotMatch(system, /Web search:/);
    onEvent({ type: 'text', delta: 'From your library.' });
    return { text: 'From your library.', toolCalls: [], stopReason: 'end_turn' };
  } });
  const { message, events } = await ask(assistant);
  assert.equal(message.error, '');
  assert.equal(message.text, 'From your library.');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].tools.some(tool => tool.name === 'search_library'), 'the library tools stay');
  assert.ok(events.some(event => event.type === 'status' && event.label === 'This model cannot search the web, so it will answer without searching.'));
});

test('a search turn the provider paused is carried on from what it has, a bounded number of times', async () => {
  const paused = { role: 'assistant', content: [{ type: 'text', text: 'Searching. ' }], native: { transport: 'anthropic', content: [{ type: 'text', text: 'Searching. ' }, { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }] } };
  const { assistant, calls } = await harness({ model: async ({ onEvent, messages }, n) => {
    if (n === 1) { onEvent({ type: 'text', delta: 'Searching. ' }); return { text: 'Searching. ', toolCalls: [], stopReason: 'pause_turn', assistantMessage: paused }; }
    assert.deepEqual(messages.at(-1), paused, 'the paused turn goes back as the last message, with nothing added after it');
    onEvent({ type: 'text', delta: 'Open 9 to 5.' });
    return { text: 'Open 9 to 5.', toolCalls: [], stopReason: 'end_turn', webSources: SOURCES };
  } });
  const { message } = await ask(assistant);
  assert.equal(message.error, '');
  assert.equal(message.text, 'Searching. \n\nOpen 9 to 5.');
  assert.deepEqual(message.webSources, SOURCES);
  assert.equal(calls.length, 2);

  const forever = await harness({ model: async () => ({ text: '', toolCalls: [], stopReason: 'pause_turn', assistantMessage: paused }) });
  await ask(forever.assistant);
  assert.equal(forever.calls.length, 6, 'the first request and five continuations, then it stops');
});

test('the prompt mentions web search only when it is offered, and saved answers keep web addresses only', () => {
  assert.doesNotMatch(assistantSystemPrompt({ tools: true }), /web_search/);
  assert.match(assistantSystemPrompt({ tools: true, webSearch: true }), /web_search/);
  assert.doesNotMatch(assistantSystemPrompt({ tools: false, webSearch: true }), /web_search/, 'a turn without tools has no search either');
  const conversation = normalizeConversation({ id: 'c', messages: [{ id: 'a', role: 'assistant', text: 'x',
    webSources: [{ url: 'https://a.example/', title: 'A', extra: 1 }, { url: 'javascript:alert(1)', title: 'bad' }, null, 'https://b.example/', ...Array.from({ length: 60 }, (_, index) => ({ url: `https://e.example/${index}`, title: 'E' }))] }] });
  const sources = conversation.messages[0].webSources;
  assert.deepEqual(sources[0], { url: 'https://a.example/', title: 'A' });
  assert.equal(sources.length, 40);
  assert.ok(sources.every(source => /^https:\/\//.test(source.url)));
  assert.equal('webSources' in normalizeConversation({ id: 'c', messages: [{ id: 'a', role: 'assistant', text: 'x', webSources: [] }] }).messages[0], false);
});
