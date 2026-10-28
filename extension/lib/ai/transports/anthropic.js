// Anthropic Messages API (api.anthropic.com and compatible servers), streamed over SSE.

import { ANTHROPIC_COMPAT_VERSION, ANTHROPIC_EFFORTS, ANTHROPIC_FALLBACK_BETA, ANTHROPIC_VERSION, DEFAULT_MAX_TOKENS, clampEffort, supportsFallbacks } from '../catalog.js';
import { providerFetch, readJsonBody, streamError } from '../http.js';
import { parseEventData, readSse } from '../stream.js';
import { STOP_NOTICES, compactUsage, imageSource, incompleteError, isStrictSchema, parseToolInput, partsOf, refusalError, toolResultText, toolSchema } from './shared.js';

export const isOfficialHost = baseUrl => { try { return new URL(baseUrl).hostname === 'api.anthropic.com'; } catch { return false; } };

export function headersFor({ baseUrl, apiKey, connection, model = '' }) {
  const official = isOfficialHost(baseUrl);
  const headers = { 'content-type': 'application/json', 'anthropic-version': official ? ANTHROPIC_VERSION : ANTHROPIC_COMPAT_VERSION };
  if (apiKey) headers['x-api-key'] = apiKey;
  if (official) headers['anthropic-dangerous-direct-browser-access'] = 'true';
  if (connection?.workspaceId) headers['anthropic-workspace-id'] = connection.workspaceId;
  if (official && model && supportsFallbacks(model)) headers['anthropic-beta'] = ANTHROPIC_FALLBACK_BETA;
  return headers;
}

function toolResultBlock(part) {
  const content = Array.isArray(part.content)
    ? part.content.map(entry => entry?.type === 'image' ? imageBlock(entry) : { type: 'text', text: typeof entry === 'string' ? entry : entry?.type === 'text' ? entry.text : JSON.stringify(entry) })
    : toolResultText(part.content);
  return { type: 'tool_result', tool_use_id: part.toolUseId, content, ...(part.isError ? { is_error: true } : {}) };
}

function imageBlock(part) {
  if (typeof part.url === 'string' && /^https:\/\//.test(part.url)) return { type: 'image', source: { type: 'url', url: part.url } };
  const { mediaType, data } = imageSource(part);
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

export function toAnthropicMessages(messages) {
  const output = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.native?.transport === 'anthropic' && Array.isArray(message.native.content)) {
      output.push({ role: 'assistant', content: message.native.content });
      continue;
    }
    if (typeof message.content === 'string') { if (message.content) output.push({ role: message.role, content: message.content }); continue; }
    const results = [], rest = [];
    for (const part of partsOf(message.content)) {
      if (part?.type === 'tool_result') results.push(toolResultBlock(part));
      else if (part?.type === 'text') { if (part.text) rest.push({ type: 'text', text: part.text }); }
      else if (part?.type === 'image') rest.push(imageBlock(part));
      else if (part?.type === 'tool_use') rest.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input || {} });
    }
    // Tool results must lead the user turn that answers a tool call.
    const content = [...results, ...rest];
    if (content.length) output.push({ role: message.role, content });
  }
  return output;
}

export function toAnthropicTools(tools = []) {
  return tools.map(tool => {
    const schema = toolSchema(tool);
    return { name: tool.name, description: tool.description || '', input_schema: schema, ...(isStrictSchema(schema) ? { strict: true } : {}) };
  });
}

export function buildRequest({ baseUrl, apiKey, connection, model, modelInfo, system, messages, tools, effort, maxTokens }) {
  const official = isOfficialHost(baseUrl);
  const limit = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS;
  const ceiling = Number.isInteger(modelInfo?.maxOutput) && modelInfo.maxOutput > 0 ? modelInfo.maxOutput : Infinity;
  const supported = modelInfo?.efforts?.length ? modelInfo.efforts.filter(level => ANTHROPIC_EFFORTS.includes(level)) : ANTHROPIC_EFFORTS;
  // Every current Claude model takes adaptive thinking and effort. Only a model the Models API lists without them
  // (an older model such as claude-haiku-4-5) leaves them out, since it rejects both with a 400.
  const adaptive = modelInfo?.capabilities?.reasoning !== false;
  const effortSupported = modelInfo?.capabilities?.effort !== false;
  const body = {
    model,
    max_tokens: Math.min(limit, ceiling),
    stream: true,
    ...(system ? { system } : {}),
    messages: toAnthropicMessages(messages),
    ...(adaptive ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
    ...(effortSupported ? { output_config: { effort: clampEffort(effort || 'medium', supported.length ? supported : ANTHROPIC_EFFORTS) } } : {}),
    cache_control: { type: 'ephemeral' },
  };
  if (tools?.length) { body.tools = toAnthropicTools(tools); body.tool_choice = { type: 'auto' }; }
  if (official && supportsFallbacks(model)) body.fallbacks = 'default';
  return { url: `${baseUrl}/messages`, method: 'POST', headers: { ...headersFor({ baseUrl, apiKey, connection, model }), accept: 'text/event-stream' }, body };
}

const usageOf = raw => compactUsage({ inputTokens: raw.input_tokens, outputTokens: raw.output_tokens, cacheReadTokens: raw.cache_read_input_tokens, cacheWriteTokens: raw.cache_creation_input_tokens });

// Server-side fallback marks each switch with a `fallback` content block. When the turn is echoed back, blocks the
// declined model produced before the last switch are dropped except text and paired server-tool blocks; the marker
// itself is an audit block and is dropped too. Everything after the switch is replayed unchanged.
export function replayableContent(blocks) {
  const list = blocks.filter(Boolean).filter(block => !(block.type === 'text' && !block.text));
  const boundary = list.findLastIndex(block => block.type === 'fallback');
  if (boundary < 0) return list;
  const before = list.slice(0, boundary);
  const serverUses = new Set(before.filter(block => block.type === 'server_tool_use').map(block => block.id));
  const answered = new Set(before.filter(block => /_tool_result$/.test(block.type || '') && block.tool_use_id).map(block => block.tool_use_id));
  const kept = before.filter(block => block.type === 'text'
    || (block.type === 'server_tool_use' && answered.has(block.id))
    || (/_tool_result$/.test(block.type || '') && serverUses.has(block.tool_use_id)));
  return [...kept, ...list.slice(boundary + 1)];
}

export async function stream(ctx) {
  const { provider, apiKey, model, signal, emit } = ctx;
  const request = buildRequest(ctx);
  const response = await providerFetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal, provider, secrets: [apiKey], model, timeoutMs: 120000 });
  const blocks = [];
  const rawUsage = {};
  let text = '', thinking = '', stopReason = null, stopDetails = null, completed = false, actualModel = model, fallback = null;
  let toolCalls = [];
  for await (const { data } of readSse(response, { signal })) {
    const event = parseEventData(data);
    switch (event.type) {
      case 'message_start':
        Object.assign(rawUsage, event.message?.usage || {});
        if (event.message?.model) actualModel = event.message.model;
        break;
      case 'content_block_start': {
        const block = structuredClone(event.content_block || {});
        if (block.type === 'text') block.text = block.text || '';
        if (block.type === 'thinking') { block.thinking = block.thinking || ''; block.signature = block.signature || ''; }
        if (block.type === 'tool_use' || block.type === 'server_tool_use') { block.partialJson = ''; block.input = block.input || {}; }
        blocks[event.index] = block;
        if (block.type === 'fallback') {
          // Tool calls the declined model made before the switch are not part of the answer and are not echoed back.
          toolCalls = [];
          fallback = { from: block.from?.model || actualModel, to: block.to?.model || null };
          if (fallback.to) actualModel = fallback.to;
        }
        if (block.type === 'text' && block.text) { text += block.text; emit({ type: 'text', delta: block.text }); }
        break;
      }
      case 'content_block_delta': {
        const block = blocks[event.index];
        const delta = event.delta || {};
        if (!block) break;
        if (delta.type === 'text_delta') { block.text += delta.text; text += delta.text; emit({ type: 'text', delta: delta.text }); }
        else if (delta.type === 'thinking_delta') { block.thinking += delta.thinking; thinking += delta.thinking; emit({ type: 'thinking', delta: delta.thinking }); }
        else if (delta.type === 'signature_delta') block.signature = (block.signature || '') + delta.signature;
        else if (delta.type === 'input_json_delta') block.partialJson += delta.partial_json || '';
        else if (delta.type === 'citations_delta' && delta.citation) (block.citations ||= []).push(delta.citation);
        break;
      }
      case 'content_block_stop': {
        const block = blocks[event.index];
        if (block && 'partialJson' in block) {
          if (block.partialJson) {
            // Input cut off by max_tokens is not valid JSON. Whether that is an error depends on the stop reason,
            // which only arrives later in message_delta, so the block is set aside instead of failing here.
            try { block.input = parseToolInput(block.partialJson, block.name); }
            catch (error) { block.invalidInput = error; }
          }
          delete block.partialJson;
          if (block.invalidInput) break;
          if (block.type === 'tool_use') {
            const call = { id: block.id, name: block.name, input: block.input };
            toolCalls.push(call);
            emit({ type: 'tool_call', ...call });
          }
        }
        break;
      }
      case 'message_delta':
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        stopDetails = event.delta?.stop_details || event.stop_details || stopDetails;
        for (const [key, value] of Object.entries(event.usage || {})) if (value !== null && value !== undefined) rawUsage[key] = value;
        break;
      case 'message_stop':
        completed = true;
        break;
      case 'error':
        throw streamError({ type: event.error?.type, message: event.error?.message, provider, model, secrets: [apiKey] });
      default:
        break;
    }
    if (completed) break;
  }
  if (!completed) throw incompleteError(provider);
  const usage = usageOf(rawUsage);
  if (stopReason === 'refusal') {
    const error = refusalError({ provider, explanation: stopDetails?.explanation || '', category: stopDetails?.category || '' });
    error.partialText = text;
    error.usage = usage;
    throw error;
  }
  // A full context window cuts the answer off just like the output limit, so it carries the same notice.
  const mapped = stopReason === 'model_context_window_exceeded' ? 'max_tokens'
    : ['tool_use', 'max_tokens', 'pause_turn', 'stop_sequence'].includes(stopReason) ? stopReason : 'end_turn';
  // A truncated tool call is dropped (and not replayed, since it would need a tool_result) when the answer hit the
  // output limit; anywhere else unreadable tool input is a real error.
  // A call a declined model left unfinished before a server-side fallback is never part of the answer either.
  const boundary = blocks.findLastIndex(block => block?.type === 'fallback');
  const broken = blocks.find((block, index) => block?.invalidInput && index > boundary);
  if (broken && mapped !== 'max_tokens') { broken.invalidInput.partialText = text; throw broken.invalidInput; }
  const native = replayableContent(blocks.filter(block => !block?.invalidInput));
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const call of toolCalls) content.push({ type: 'tool_use', ...call });
  return {
    text, thinking, toolCalls, usage, model: actualModel,
    stopReason: mapped,
    rawStopReason: stopReason,
    notice: STOP_NOTICES[mapped] || null, fallback,
    assistantMessage: { role: 'assistant', content, native: { transport: 'anthropic', content: native } },
  };
}

function mapModel(entry) {
  const listedEffort = entry.capabilities?.effort && typeof entry.capabilities.effort === 'object' ? entry.capabilities.effort : null;
  const efforts = listedEffort ? ANTHROPIC_EFFORTS.filter(level => listedEffort[level]?.supported) : [];
  return {
    id: entry.id, name: entry.display_name || entry.id, description: '',
    contextWindow: Number.isFinite(entry.max_input_tokens) ? entry.max_input_tokens : null,
    maxOutput: Number.isFinite(entry.max_tokens) ? entry.max_tokens : null,
    efforts, defaultEffort: null,
    deprecated: entry.lifecycle === 'deprecated' || undefined,
    // reasoning means adaptive thinking here. effort: false marks a model whose listing says it takes no effort at
    // all, which is different from a listing that says nothing (efforts [] then means unknown).
    capabilities: { tools: true, images: entry.capabilities?.image_input?.supported ?? true, reasoning: entry.capabilities?.thinking?.types?.adaptive?.supported ?? true, embeddings: false,
      ...(listedEffort && !efforts.length ? { effort: false } : {}) },
  };
}

export async function listModels({ provider, baseUrl, apiKey, connection, signal }) {
  const models = [];
  let after = '';
  for (let page = 0; page < 20; page++) {
    const url = `${baseUrl}/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    const response = await providerFetch(url, { headers: headersFor({ baseUrl, apiKey, connection }), signal, provider, secrets: [apiKey], timeoutMs: 20000 });
    const data = await readJsonBody(response, { signal });
    for (const entry of Array.isArray(data.data) ? data.data : []) if (entry?.id && entry.lifecycle !== 'retired') models.push(mapModel(entry));
    if (!data.has_more || !data.last_id || data.last_id === after) break;
    after = data.last_id;
  }
  return models;
}
