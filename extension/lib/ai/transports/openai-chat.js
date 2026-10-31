// OpenAI-compatible Chat Completions (xAI, OpenRouter, Mistral, Groq, DeepSeek, LM Studio, custom servers), SSE with [DONE].

import { clampEffort } from '../catalog.js';
import { authHeaders, providerFetch, readJsonBody, streamError } from '../http.js';
import { parseEventData, readSse } from '../stream.js';
import { STOP_NOTICES, compactUsage, dataUrlOf, documentSource, incompleteError, isStrictSchema, parseToolInput, partsOf, textOf, toolResultText, toolSchema, uniqueTag } from './shared.js';

export function toChatMessages(messages, system, options = {}) {
  const output = system ? [{ role: 'system', content: system }] : [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.native?.transport === 'openai-chat' && message.native.message) {
      output.push(message.native.message);
      continue;
    }
    if (message.role === 'assistant') {
      const text = textOf(message.content);
      const calls = partsOf(message.content).filter(part => part?.type === 'tool_use')
        .map(part => ({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input || {}) } }));
      if (!text && !calls.length) continue;
      output.push({ role: 'assistant', content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    if (typeof message.content === 'string') { output.push({ role: 'user', content: message.content }); continue; }
    const parts = [];
    let hasImage = false;
    for (const part of partsOf(message.content)) {
      if (part?.type === 'tool_result') output.push({ role: 'tool', tool_call_id: part.toolUseId, content: `${part.isError ? 'Error: ' : ''}${toolResultText(part.content)}` });
      else if (part?.type === 'text') { if (part.text) parts.push({ type: 'text', text: part.text }); }
      else if (part?.type === 'image') { hasImage = true; parts.push({ type: 'image_url', image_url: { url: dataUrlOf(part) } }); }
      else if (part?.type === 'document') { hasImage = true; const { mediaType, data, name } = documentSource(part); parts.push({ type: 'file', file: { filename: name, file_data: `data:${mediaType};base64,${data}` } }); }
    }
    if (!parts.length) continue;
    // Plain strings are the most widely accepted shape for text-only turns.
    output.push({ role: 'user', content: hasImage || options.alwaysParts ? parts : parts.map(part => part.text).join('\n\n') });
  }
  return output;
}

export function toChatTools(tools = []) {
  return tools.map(tool => {
    const schema = toolSchema(tool);
    return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: schema, ...(isStrictSchema(schema) ? { strict: true } : {}) } };
  });
}

export function buildRequest({ provider, baseUrl, apiKey, model, modelInfo, system, messages, tools, effort, maxTokens }) {
  const options = provider?.chatOptions || {};
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream', ...authHeaders({ provider, apiKey }), ...(options.headers || {}) };
  const body = { model, messages: toChatMessages(messages, system), stream: true };
  if (options.streamUsage) body.stream_options = { include_usage: true };
  if (Number.isInteger(maxTokens) && maxTokens > 0) {
    const ceiling = Number.isInteger(modelInfo?.maxOutput) && modelInfo.maxOutput > 0 ? modelInfo.maxOutput : Infinity;
    body.max_tokens = Math.min(maxTokens, ceiling);
  }
  // Effort is sent only when the model is known to accept it; unknown models would reject the field.
  const efforts = modelInfo?.efforts || [];
  if (options.effortParam && effort && efforts.length) {
    const level = clampEffort(effort, efforts);
    if (level) {
      if (options.effortParam === 'reasoning') body.reasoning = { effort: level };
      else body[options.effortParam] = level;
    }
  }
  if (tools?.length) { body.tools = toChatTools(tools); body.tool_choice = 'auto'; }
  return { url: `${baseUrl}/chat/completions`, method: 'POST', headers, body };
}

const usageOf = raw => compactUsage({
  inputTokens: raw?.prompt_tokens, outputTokens: raw?.completion_tokens,
  cacheReadTokens: raw?.prompt_tokens_details?.cached_tokens ?? raw?.prompt_cache_hit_tokens,
  reasoningTokens: raw?.completion_tokens_details?.reasoning_tokens,
});

const STOP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'content_filter', end_turn: 'end_turn' };

export async function stream(ctx) {
  const { provider, apiKey, model, signal, emit } = ctx;
  const options = provider?.chatOptions || {};
  const request = buildRequest(ctx);
  const response = await providerFetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal, provider, secrets: [apiKey], model, timeoutMs: 120000 });
  let text = '', thinking = '', finish = null, ended = false, rawUsage = null, actualModel = model;
  const calls = [];
  const reasoningKeys = [options.reasoningField, 'reasoning_content', 'reasoning'].filter(Boolean);
  for await (const { data } of readSse(response, { signal })) {
    if (data === '[DONE]') { ended = true; break; }
    const chunk = parseEventData(data);
    if (chunk.error) throw streamError({ type: chunk.error.type || chunk.error.code, message: chunk.error.message || String(chunk.error), provider, model, secrets: [apiKey] });
    if (chunk.model) actualModel = chunk.model;
    if (chunk.usage) rawUsage = chunk.usage;
    if (chunk.x_groq?.usage) rawUsage = chunk.x_groq.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) { text += delta.content; emit({ type: 'text', delta: delta.content }); }
    for (const key of reasoningKeys) {
      if (typeof delta[key] === 'string' && delta[key]) { thinking += delta[key]; emit({ type: 'thinking', delta: delta[key] }); break; }
    }
    for (const call of delta.tool_calls || []) {
      // OpenAI sends index on every fragment. Servers that omit it are matched by id; a fragment with neither
      // continues the call in progress.
      let index = Number.isInteger(call.index) ? call.index : call.id ? calls.findIndex(entry => entry?.id === call.id) : calls.length - 1;
      if (index < 0) index = calls.length;
      const entry = calls[index] ||= { id: '', name: '', arguments: '' };
      if (call.id && !entry.id) entry.id = call.id;
      // Names normally arrive whole in the first fragment; tolerate servers that split them, repeat them on every
      // fragment or resend the name so far.
      const name = call.function?.name;
      if (name) entry.name = !entry.name || name.startsWith(entry.name) ? name : entry.name.endsWith(name) ? entry.name : entry.name + name;
      if (typeof call.function?.arguments === 'string') entry.arguments += call.function.arguments;
      else if (call.function?.arguments && typeof call.function.arguments === 'object') entry.arguments = JSON.stringify(call.function.arguments);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  if (!ended && !finish) throw incompleteError(provider);
  const tag = calls.some(call => call && !call.id) ? uniqueTag() : '';
  const toolCalls = calls.filter(Boolean).map((call, index) => ({ id: call.id || `call_${tag}_${index + 1}`, name: call.name, input: parseToolInput(call.arguments, call.name) }));
  for (const call of toolCalls) emit({ type: 'tool_call', ...call });
  const stopReason = toolCalls.length ? 'tool_use' : STOP[finish] || (finish ? 'other' : 'end_turn');
  const native = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
  if (toolCalls.length) native.tool_calls = toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }));
  if (options.echoReasoning && thinking) native.reasoning_content = thinking;
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const call of toolCalls) content.push({ type: 'tool_use', ...call });
  return {
    text, thinking, toolCalls, usage: usageOf(rawUsage), model: actualModel, stopReason, rawStopReason: finish,
    notice: STOP_NOTICES[stopReason] || null,
    assistantMessage: { role: 'assistant', content, native: { transport: 'openai-chat', message: native } },
  };
}

const NOT_CHAT = /(embed|whisper|tts|transcribe|moderation|guard|rerank|dall-e|image-gen|playai|orpheus|sora)/i;

function mapListed(entry) {
  const id = String(entry.id);
  const architecture = entry.architecture || {};
  const inputs = architecture.input_modalities || [];
  const outputs = architecture.output_modalities || [];
  const params = entry.supported_parameters || [];
  const embeddings = /embed/i.test(id) || entry.capabilities?.completion_chat === false && entry.capabilities?.embeddings === true;
  const chat = !embeddings && !NOT_CHAT.test(id) && (outputs.length ? outputs.includes('text') : true) && entry.capabilities?.completion_chat !== false;
  const efforts = Array.isArray(entry.reasoning?.supported_efforts) ? entry.reasoning.supported_efforts : [];
  return {
    id, name: entry.name || id, description: '',
    contextWindow: entry.context_length ?? entry.max_context_length ?? entry.top_provider?.context_length ?? null,
    maxOutput: entry.top_provider?.max_completion_tokens ?? null,
    efforts, defaultEffort: entry.reasoning?.default_effort || null,
    chat,
    capabilities: {
      tools: params.length ? params.includes('tools') : entry.capabilities?.function_calling ?? true,
      images: inputs.length ? inputs.includes('image') : entry.capabilities?.vision ?? null,
      reasoning: params.length ? params.includes('reasoning') || params.includes('reasoning_effort') : null,
      embeddings,
    },
  };
}

export async function listModels({ provider, baseUrl, apiKey, signal }) {
  const response = await providerFetch(`${baseUrl}/models`, { headers: { ...authHeaders({ provider, apiKey }), ...(provider?.chatOptions?.headers || {}) }, signal, provider, secrets: [apiKey], timeoutMs: 20000 });
  const data = await readJsonBody(response, { signal });
  const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : Array.isArray(data) ? data : [];
  return list.filter(entry => entry && (typeof entry.id === 'string' || typeof entry.id === 'number')).map(mapListed);
}
