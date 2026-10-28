// Ollama native chat API (/api/chat), streamed as newline-delimited JSON.

import { clampEffort } from '../catalog.js';
import { authHeaders, providerFetch, readJsonBody, streamError } from '../http.js';
import { readNdjson } from '../stream.js';
import { STOP_NOTICES, compactUsage, imageSource, incompleteError, parseToolInput, partsOf, textOf, toolNameFor, toolResultText, toolSchema } from './shared.js';

const showCache = new Map();

// /api/show reports what a local model can do; sending think or tools to a model without them is a 400.
export async function modelCapabilities({ provider, baseUrl, apiKey, model, signal }) {
  const key = `${baseUrl}|${model}`;
  if (!showCache.has(key)) {
    const lookup = (async () => {
      try {
        const response = await providerFetch(`${baseUrl}/api/show`, { method: 'POST', headers: authHeaders({ provider, apiKey }), body: { model }, signal, provider, secrets: [apiKey], timeoutMs: 8000 });
        const data = await readJsonBody(response, { signal });
        return Array.isArray(data.capabilities) ? data.capabilities : null;
      } catch { return null; }
    })();
    showCache.set(key, lookup);
    lookup.then(value => { if (!value) showCache.delete(key); });
  }
  return showCache.get(key);
}

export function toOllamaMessages(messages, system, capabilities = null) {
  const output = system ? [{ role: 'system', content: system }] : [];
  const vision = !capabilities || capabilities.includes('vision');
  for (const message of messages) {
    if (message.role === 'assistant' && message.native?.transport === 'ollama' && message.native.message) { output.push(message.native.message); continue; }
    if (message.role === 'assistant') {
      const calls = partsOf(message.content).filter(part => part?.type === 'tool_use').map(part => ({ function: { name: part.name, arguments: part.input || {} } }));
      output.push({ role: 'assistant', content: textOf(message.content), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const texts = [], images = [];
    for (const part of partsOf(message.content)) {
      if (part?.type === 'tool_result') output.push({ role: 'tool', tool_name: toolNameFor(messages, part.toolUseId), content: `${part.isError ? 'Error: ' : ''}${toolResultText(part.content)}` });
      else if (part?.type === 'text') { if (part.text) texts.push(part.text); }
      else if (part?.type === 'image') { if (vision) images.push(imageSource(part).data); else texts.push('[An image was attached, but this model cannot read images.]'); }
    }
    if (texts.length || images.length) output.push({ role: 'user', content: texts.join('\n\n'), ...(images.length ? { images } : {}) });
  }
  return output;
}

export function buildRequest({ provider, baseUrl, apiKey, model, system, messages, tools, effort, maxTokens, capabilities = null }) {
  const body = { model, messages: toOllamaMessages(messages, system, capabilities), stream: true };
  if (capabilities?.includes('thinking')) body.think = /gpt-oss/i.test(model) ? clampEffort(effort || 'medium', ['low', 'medium', 'high']) : effort !== 'none';
  if (tools?.length && (!capabilities || capabilities.includes('tools'))) {
    body.tools = tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description || '', parameters: toolSchema(tool) } }));
  }
  if (Number.isInteger(maxTokens) && maxTokens > 0) body.options = { num_predict: maxTokens };
  return { url: `${baseUrl}/api/chat`, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson', ...authHeaders({ provider, apiKey }) }, body };
}

export async function stream(ctx) {
  const { provider, apiKey, model, signal, emit } = ctx;
  const capabilities = await modelCapabilities(ctx);
  const request = buildRequest({ ...ctx, capabilities });
  const response = await providerFetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal, provider, secrets: [apiKey], model, timeoutMs: 300000 });
  let text = '', thinking = '', done = false, finish = null, usage = {}, actualModel = model;
  const toolCalls = [], rawCalls = [];
  for await (const event of readNdjson(response, { signal })) {
    if (event.error) throw streamError({ message: typeof event.error === 'string' ? event.error : event.error.message, provider, model, secrets: [apiKey] });
    if (event.model) actualModel = event.model;
    const message = event.message || {};
    if (message.thinking) { thinking += message.thinking; emit({ type: 'thinking', delta: message.thinking }); }
    if (message.content) { text += message.content; emit({ type: 'text', delta: message.content }); }
    for (const call of message.tool_calls || []) {
      const args = call.function?.arguments;
      const entry = { id: call.id || `ollama_call_${toolCalls.length + 1}`, name: call.function?.name || '', input: typeof args === 'string' ? parseToolInput(args, call.function?.name) : args || {} };
      rawCalls.push(call);
      toolCalls.push(entry);
      emit({ type: 'tool_call', ...entry });
    }
    if (event.done) {
      done = true; finish = event.done_reason || 'stop';
      usage = compactUsage({ inputTokens: event.prompt_eval_count, outputTokens: event.eval_count });
      break;
    }
  }
  if (!done) throw incompleteError(provider);
  const stopReason = toolCalls.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn';
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const call of toolCalls) content.push({ type: 'tool_use', ...call });
  const native = { role: 'assistant', content: text, ...(thinking ? { thinking } : {}), ...(rawCalls.length ? { tool_calls: rawCalls } : {}) };
  return {
    text, thinking, toolCalls, usage, model: actualModel, stopReason, rawStopReason: finish,
    notice: STOP_NOTICES[stopReason] || null,
    assistantMessage: { role: 'assistant', content, native: { transport: 'ollama', message: native } },
  };
}

const EMBEDDING = /(embed|bge-|e5-|minilm|gte-|arctic-embed|mxbai)/i;

export async function listModels({ provider, baseUrl, apiKey, signal }) {
  const response = await providerFetch(`${baseUrl}/api/tags`, { headers: authHeaders({ provider, apiKey }), signal, provider, secrets: [apiKey], timeoutMs: 8000 });
  const data = await readJsonBody(response, { signal });
  return (Array.isArray(data.models) ? data.models : []).filter(entry => entry?.name || entry?.model).map(entry => {
    const id = entry.model || entry.name;
    const families = entry.details?.families || [entry.details?.family].filter(Boolean);
    const embeddings = EMBEDDING.test(id) || families.some(family => /bert/i.test(family));
    return {
      id, name: entry.name || id, description: entry.details?.parameter_size ? `${entry.details.parameter_size} parameters` : '',
      contextWindow: null, maxOutput: null, efforts: [], defaultEffort: null, chat: !embeddings,
      capabilities: { tools: null, images: null, reasoning: null, embeddings },
    };
  });
}
