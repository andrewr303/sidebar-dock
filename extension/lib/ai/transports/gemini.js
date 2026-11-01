// Google Gemini generateContent, streamed with streamGenerateContent?alt=sse. Each SSE chunk is a full response delta.

import { clampEffort } from '../catalog.js';
import { aiError, authHeaders, providerFetch, readJsonBody, streamError } from '../http.js';
import { parseEventData, readSse } from '../stream.js';
import { STOP_NOTICES, compactUsage, documentSource, imageSource, incompleteError, partsOf, refusalError, toolNameFor, toolResultText, toolSchema, uniqueTag } from './shared.js';

const SYNTHETIC_ID = 'gemini_call_';
const DEFAULT_LEVELS = ['low', 'medium', 'high'];

export const modelPath = model => /^(?:models|tunedModels)\//.test(model) ? model : `models/${model}`;

export function thinkingConfig(model, effort, modelInfo) {
  if (/^gemini-2\.5/.test(model)) return { thinkingBudget: effort === 'none' && !/pro/.test(model) ? 0 : -1, includeThoughts: true };
  if (!/^gemini-/.test(model)) return null;
  const levels = modelInfo?.efforts?.length ? modelInfo.efforts : DEFAULT_LEVELS;
  return { thinkingLevel: clampEffort(effort || 'medium', levels) || 'medium', includeThoughts: true };
}

// Gemini function declarations take an OpenAPI-style subset of JSON Schema.
const SCHEMA_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'maxItems', 'minItems', 'properties', 'required', 'items', 'minimum', 'maximum', 'anyOf', 'propertyOrdering', 'title', 'minLength', 'maxLength', 'pattern', 'minProperties', 'maxProperties']);
export function geminiSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const output = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'const') { output.enum = [value]; continue; }
    if (key === 'type' && Array.isArray(value)) {
      const types = value.filter(type => type !== 'null');
      output.type = types[0] || 'string';
      if (types.length < value.length) output.nullable = true;
      continue;
    }
    if (!SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties') output.properties = Object.fromEntries(Object.entries(value || {}).map(([name, entry]) => [name, geminiSchema(entry)]));
    else if (key === 'items') output.items = geminiSchema(value);
    else if (key === 'anyOf') output.anyOf = (value || []).map(geminiSchema);
    else output[key] = value;
  }
  return output;
}

export function toGeminiContents(messages) {
  const contents = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.native?.transport === 'gemini' && Array.isArray(message.native.parts)) {
      contents.push({ role: 'model', parts: message.native.parts });
      continue;
    }
    const parts = [];
    for (const part of partsOf(message.content)) {
      if (part?.type === 'text') { if (part.text) parts.push({ text: part.text }); }
      else if (part?.type === 'image') { const { mediaType, data } = imageSource(part); parts.push({ inlineData: { mimeType: mediaType, data } }); }
      else if (part?.type === 'document') { const { mediaType, data } = documentSource(part); parts.push({ inlineData: { mimeType: mediaType, data } }); }
      else if (part?.type === 'tool_use') parts.push({ functionCall: { name: part.name, args: part.input || {}, ...(part.id && !part.id.startsWith(SYNTHETIC_ID) ? { id: part.id } : {}) } });
      else if (part?.type === 'tool_result') {
        const text = toolResultText(part.content);
        parts.push({ functionResponse: {
          name: toolNameFor(messages, part.toolUseId) || 'tool',
          ...(part.toolUseId && !part.toolUseId.startsWith(SYNTHETIC_ID) ? { id: part.toolUseId } : {}),
          response: part.isError ? { error: text } : { result: text },
        } });
      }
    }
    if (!parts.length) continue;
    // Function responses lead the turn that answers a call.
    parts.sort((a, b) => Number(!a.functionResponse) - Number(!b.functionResponse));
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  return contents;
}

export function buildRequest({ provider, baseUrl, apiKey, model, modelInfo, system, messages, tools, effort, maxTokens }) {
  const generationConfig = {};
  if (Number.isInteger(maxTokens) && maxTokens > 0) generationConfig.maxOutputTokens = maxTokens;
  const thinking = thinkingConfig(model, effort, modelInfo);
  if (thinking) generationConfig.thinkingConfig = thinking;
  const body = { contents: toGeminiContents(messages) };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  if (tools?.length) {
    body.tools = [{ functionDeclarations: tools.map(tool => ({ name: tool.name, description: tool.description || '', parameters: geminiSchema(toolSchema(tool)) })) }];
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }
  return {
    url: `${baseUrl}/${modelPath(model)}:streamGenerateContent?alt=sse`, method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...authHeaders({ provider, apiKey }) }, body,
  };
}

const usageOf = raw => compactUsage({ inputTokens: raw?.promptTokenCount, outputTokens: raw?.candidatesTokenCount, reasoningTokens: raw?.thoughtsTokenCount, cacheReadTokens: raw?.cachedContentTokenCount });
const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE']);

export async function stream(ctx) {
  const { provider, apiKey, model, signal, emit } = ctx;
  const request = buildRequest(ctx);
  const response = await providerFetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal, provider, secrets: [apiKey], model, timeoutMs: 120000 });
  let text = '', thinking = '', finish = null, rawUsage = null, actualModel = model;
  const toolCalls = [];
  const nativeParts = [];
  // Gemini often sends calls without ids. Synthetic ids must stay unique across the steps of a tool loop, because
  // toolNameFor() matches each functionResponse to its call by id when the conversation is replayed.
  const syntheticPrefix = `${SYNTHETIC_ID}${uniqueTag()}_`;
  const keep = part => {
    const last = nativeParts.at(-1);
    const plain = value => typeof value?.text === 'string' && !value.functionCall;
    if (plain(part) && plain(last) && !!last.thought === !!part.thought && !last.thoughtSignature) {
      last.text += part.text;
      if (part.thoughtSignature) last.thoughtSignature = part.thoughtSignature;
      return;
    }
    nativeParts.push(structuredClone(part));
  };
  for await (const { data } of readSse(response, { signal })) {
    const chunk = parseEventData(data);
    if (chunk.error) throw streamError({ type: chunk.error.status, message: chunk.error.message, provider, model, secrets: [apiKey] });
    if (chunk.promptFeedback?.blockReason) {
      const error = refusalError({ provider, explanation: `Gemini blocked the prompt (${chunk.promptFeedback.blockReason.toLowerCase().replace(/_/g, ' ')}).` });
      error.partialText = text;
      throw error;
    }
    if (chunk.usageMetadata) rawUsage = chunk.usageMetadata;
    if (chunk.modelVersion) actualModel = chunk.modelVersion;
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts || []) {
      if (part.functionCall) {
        const call = { id: part.functionCall.id || `${syntheticPrefix}${toolCalls.length + 1}`, name: part.functionCall.name, input: part.functionCall.args || {} };
        toolCalls.push(call);
        emit({ type: 'tool_call', ...call });
        keep(part);
      } else if (typeof part.text === 'string') {
        if (part.thought) { if (part.text) { thinking += part.text; emit({ type: 'thinking', delta: part.text }); } if (part.thoughtSignature) keep(part); }
        else { if (part.text) { text += part.text; emit({ type: 'text', delta: part.text }); } keep(part); }
      } else if (part.thoughtSignature) keep(part);
    }
    if (candidate?.finishReason) finish = candidate.finishReason;
  }
  if (!finish) throw incompleteError(provider);
  if (BLOCKED.has(finish)) {
    const error = refusalError({ provider, explanation: `Gemini stopped for ${finish.toLowerCase().replace(/_/g, ' ')} reasons.`, category: finish });
    error.partialText = text;
    throw error;
  }
  if (finish === 'MALFORMED_FUNCTION_CALL') throw aiError('Gemini produced a malformed tool call. Try again.', { code: 'bad_tool_input', partialText: text });
  const stopReason = toolCalls.length ? 'tool_use' : finish === 'MAX_TOKENS' ? 'max_tokens' : finish === 'STOP' ? 'end_turn' : 'other';
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const call of toolCalls) content.push({ type: 'tool_use', ...call });
  return {
    text, thinking, toolCalls, usage: usageOf(rawUsage), model: actualModel, stopReason, rawStopReason: finish,
    notice: STOP_NOTICES[stopReason] || null,
    assistantMessage: { role: 'assistant', content, native: { transport: 'gemini', parts: nativeParts.filter(part => !(part.thought && !part.thoughtSignature)) } },
  };
}

const NOT_CHAT = /(embedding|imagen|veo|lyria|tts|aqa|native-audio|live|image-generation|-image)/i;

export async function listModels({ provider, baseUrl, apiKey, signal }) {
  const models = [];
  let token = '';
  for (let page = 0; page < 10; page++) {
    const response = await providerFetch(`${baseUrl}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, { headers: authHeaders({ provider, apiKey }), signal, provider, secrets: [apiKey], timeoutMs: 20000 });
    const data = await readJsonBody(response, { signal });
    for (const entry of Array.isArray(data.models) ? data.models : []) {
      const id = String(entry.name || '').replace(/^models\//, '');
      if (!id) continue;
      const methods = entry.supportedGenerationMethods || [];
      const embeddings = methods.includes('embedContent') || methods.includes('batchEmbedContents');
      models.push({
        id, name: entry.displayName || id, description: '',
        contextWindow: entry.inputTokenLimit ?? null, maxOutput: entry.outputTokenLimit ?? null,
        efforts: /^gemini-(?:[3-9]|\d{2})/.test(id) ? [...DEFAULT_LEVELS] : [], defaultEffort: null,
        chat: methods.includes('generateContent') && !NOT_CHAT.test(id),
        capabilities: { tools: !embeddings, images: !embeddings, reasoning: !!entry.thinking, embeddings },
      });
    }
    if (!data.nextPageToken || data.nextPageToken === token) break;
    token = data.nextPageToken;
  }
  return models;
}
