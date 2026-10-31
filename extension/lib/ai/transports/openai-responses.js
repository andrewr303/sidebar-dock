// OpenAI Responses API (also Perplexity's Agent API, which aliases /responses), streamed over SSE with named events.

import { DEFAULT_MAX_TOKENS, clampEffort } from '../catalog.js';
import { authHeaders, providerFetch, readJsonBody, streamError } from '../http.js';
import { parseEventData, readSse } from '../stream.js';
import { STOP_NOTICES, compactUsage, dataUrlOf, documentSource, incompleteError, isStrictSchema, parseToolInput, partsOf, textOf, toolResultText, toolSchema } from './shared.js';

// Reasoning models accept reasoning.effort; older chat models reject it.
const REASONING_MODEL = /^(?:gpt-(?:[5-9]|\d{2})|o\d)/;
const SAFE_EFFORTS = ['low', 'medium', 'high'];

export function toResponsesInput(messages) {
  const items = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.native?.transport === 'openai-responses' && Array.isArray(message.native.output)) {
      // Stateless tool loops replay every output item, including encrypted reasoning, exactly as returned.
      items.push(...message.native.output);
      continue;
    }
    if (message.role === 'assistant') {
      const text = textOf(message.content);
      if (text) items.push({ role: 'assistant', content: text });
      for (const part of partsOf(message.content)) {
        if (part?.type === 'tool_use') items.push({ type: 'function_call', call_id: part.id, name: part.name, arguments: JSON.stringify(part.input || {}) });
      }
      continue;
    }
    const content = [];
    for (const part of partsOf(message.content)) {
      if (part?.type === 'tool_result') items.push({ type: 'function_call_output', call_id: part.toolUseId, output: `${part.isError ? 'Error: ' : ''}${toolResultText(part.content)}` });
      else if (part?.type === 'text') { if (part.text) content.push({ type: 'input_text', text: part.text }); }
      else if (part?.type === 'image') content.push({ type: 'input_image', image_url: dataUrlOf(part) });
      else if (part?.type === 'document') { const { mediaType, data, name } = documentSource(part); content.push({ type: 'input_file', filename: name, file_data: `data:${mediaType};base64,${data}` }); }
    }
    if (content.length) items.push({ role: 'user', content });
  }
  return items;
}

export function toResponsesTools(tools = []) {
  return tools.map(tool => {
    const schema = toolSchema(tool);
    return { type: 'function', name: tool.name, description: tool.description || '', parameters: schema, strict: isStrictSchema(schema) };
  });
}

export function buildRequest({ provider, baseUrl, apiKey, model, modelInfo, system, messages, tools, effort, maxTokens }) {
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream', ...authHeaders({ provider, apiKey }) };
  const input = toResponsesInput(messages);
  if (provider?.responsesOptions?.presets && model.startsWith('preset:')) {
    return { url: `${baseUrl}/responses`, method: 'POST', headers, body: { effort: model.slice('preset:'.length), input, ...(system ? { instructions: system } : {}), stream: true } };
  }
  const reasoningModel = modelInfo ? modelInfo.capabilities?.reasoning !== false && (modelInfo.efforts?.length > 0 || REASONING_MODEL.test(model)) : REASONING_MODEL.test(model);
  const body = { model, input, ...(system ? { instructions: system } : {}), stream: true, store: false };
  if (reasoningModel) {
    const level = clampEffort(effort || 'medium', modelInfo?.efforts?.length ? modelInfo.efforts : SAFE_EFFORTS);
    body.reasoning = level === 'none' ? { effort: 'none' } : { effort: level, summary: 'auto' };
    body.include = ['reasoning.encrypted_content'];
  }
  const ceiling = Number.isInteger(modelInfo?.maxOutput) && modelInfo.maxOutput > 0 ? modelInfo.maxOutput : Infinity;
  if (Number.isInteger(maxTokens) && maxTokens > 0) body.max_output_tokens = Math.min(maxTokens, ceiling);
  else if (reasoningModel) body.max_output_tokens = Math.min(DEFAULT_MAX_TOKENS, ceiling);
  if (tools?.length) { body.tools = toResponsesTools(tools); body.tool_choice = 'auto'; }
  return { url: `${baseUrl}/responses`, method: 'POST', headers, body };
}

const usageOf = raw => compactUsage({ inputTokens: raw?.input_tokens, outputTokens: raw?.output_tokens, cacheReadTokens: raw?.input_tokens_details?.cached_tokens, reasoningTokens: raw?.output_tokens_details?.reasoning_tokens });

export async function stream(ctx) {
  const { provider, apiKey, model, signal, emit } = ctx;
  const request = buildRequest(ctx);
  const response = await providerFetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal, provider, secrets: [apiKey], model, timeoutMs: 120000 });
  let text = '', thinking = '', completed = false, ended = false, finalResponse = null, incomplete = null, actualModel = model, refused = false;
  const calls = new Map();
  const outputs = [];
  const toolCalls = [];
  const finishCall = call => {
    if (call.emitted) return;
    call.emitted = true;
    const entry = { id: call.callId, name: call.name, input: parseToolInput(call.arguments, call.name) };
    toolCalls.push(entry);
    emit({ type: 'tool_call', ...entry });
  };
  const callFor = event => calls.get(event.item_id) || calls.get(`#${event.output_index}`);
  for await (const { data } of readSse(response, { signal })) {
    if (data === '[DONE]') { ended = true; break; }
    const event = parseEventData(data);
    switch (event.type) {
      case 'response.created':
      case 'response.in_progress':
        if (event.response?.model) actualModel = event.response.model;
        break;
      case 'response.output_item.added':
        if (event.item?.type === 'function_call') {
          const call = { callId: event.item.call_id, name: event.item.name, arguments: event.item.arguments || '' };
          calls.set(event.item.id || `#${event.output_index}`, call);
        }
        break;
      case 'response.output_text.delta':
        if (event.delta) { text += event.delta; emit({ type: 'text', delta: event.delta }); }
        break;
      case 'response.refusal.delta':
        refused = true;
        if (event.delta) { text += event.delta; emit({ type: 'text', delta: event.delta }); }
        break;
      case 'response.reasoning_summary_part.added':
        if (thinking && event.summary_index > 0) { thinking += '\n\n'; emit({ type: 'thinking', delta: '\n\n' }); }
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (event.delta) { thinking += event.delta; emit({ type: 'thinking', delta: event.delta }); }
        break;
      case 'response.function_call_arguments.delta': {
        const call = callFor(event);
        if (call) call.arguments += event.delta || '';
        break;
      }
      case 'response.function_call_arguments.done': {
        const call = callFor(event);
        if (call && typeof event.arguments === 'string') call.arguments = event.arguments;
        break;
      }
      case 'response.output_item.done':
        if (event.item) outputs[event.output_index ?? outputs.length] = event.item;
        if (event.item?.type === 'function_call') {
          const call = calls.get(event.item.id) || calls.get(`#${event.output_index}`) || { callId: event.item.call_id, name: event.item.name, arguments: '' };
          call.callId = event.item.call_id || call.callId;
          call.name = event.item.name || call.name;
          if (typeof event.item.arguments === 'string') call.arguments = event.item.arguments;
          finishCall(call);
        }
        break;
      case 'response.completed':
        completed = true; finalResponse = event.response || null;
        break;
      case 'response.incomplete':
        completed = true; finalResponse = event.response || null; incomplete = event.response?.incomplete_details?.reason || 'incomplete';
        break;
      case 'response.failed':
        throw streamError({ type: event.response?.error?.code, message: event.response?.error?.message, provider, model, secrets: [apiKey] });
      case 'error':
        throw streamError({ type: event.code || event.error?.code || event.error?.type, message: event.message || event.error?.message, provider, model, secrets: [apiKey] });
      default:
        break;
    }
    if (completed) break;
  }
  if (!completed && !ended) throw incompleteError(provider);
  for (const call of calls.values()) finishCall(call);
  if (finalResponse?.model) actualModel = finalResponse.model;
  const output = Array.isArray(finalResponse?.output) && finalResponse.output.length ? finalResponse.output : outputs.filter(Boolean);
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const call of toolCalls) content.push({ type: 'tool_use', ...call });
  const stopReason = incomplete === 'max_output_tokens' ? 'max_tokens' : incomplete === 'content_filter' ? 'content_filter' : incomplete ? 'incomplete'
    : toolCalls.length ? 'tool_use' : refused ? 'refusal' : 'end_turn';
  return {
    text, thinking, toolCalls, usage: usageOf(finalResponse?.usage), model: actualModel, stopReason, rawStopReason: incomplete || finalResponse?.status || null,
    notice: STOP_NOTICES[stopReason] || null,
    assistantMessage: { role: 'assistant', content, native: { transport: 'openai-responses', output } },
  };
}

const NOT_CHAT = /(embedding|tts|whisper|dall-e|image|audio|realtime|transcribe|moderation|search|computer-use|davinci|babbage|sora)/i;

export async function listModels({ provider, baseUrl, apiKey, signal }) {
  const response = await providerFetch(`${baseUrl}/models`, { headers: authHeaders({ provider, apiKey }), signal, provider, secrets: [apiKey], timeoutMs: 20000 });
  const data = await readJsonBody(response, { signal });
  const list = Array.isArray(data.data) ? data.data : [];
  return list.filter(entry => typeof entry?.id === 'string').map(entry => {
    const embeddings = /embedding/i.test(entry.id);
    return {
      id: entry.id, name: entry.id, description: '', contextWindow: null, maxOutput: null, efforts: [], defaultEffort: null,
      created: entry.created || null,
      chat: !embeddings && /^(?:gpt-|o\d|chatgpt-)/i.test(entry.id) && !NOT_CHAT.test(entry.id),
      capabilities: { tools: !embeddings, images: !embeddings, reasoning: REASONING_MODEL.test(entry.id), embeddings },
    };
  });
}
