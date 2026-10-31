// Helpers shared by the provider transports. Pure; no network or storage access.

import { aiError } from '../http.js';

export const partsOf = content => typeof content === 'string' ? (content ? [{ type: 'text', text: content }] : []) : Array.isArray(content) ? content : [];

export function textOf(content) {
  return partsOf(content).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
}

export function imageSource(part) {
  if (typeof part?.data === 'string' && part.data) return { mediaType: part.mediaType || 'image/png', data: part.data };
  const match = typeof part?.dataUrl === 'string' && /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/s.exec(part.dataUrl);
  if (match) return { mediaType: match[1], data: match[2] };
  throw aiError('An image in this message could not be read.', { code: 'bad_image' });
}

export const dataUrlOf = part => { const { mediaType, data } = imageSource(part); return `data:${mediaType};base64,${data}`; };

/** A file part: { type: 'document', mediaType: 'application/pdf', data: base64, name }. */
export function documentSource(part) {
  if (typeof part?.data === 'string' && part.data) return { mediaType: part.mediaType || 'application/pdf', data: part.data, name: String(part.name || 'document.pdf').slice(0, 200) };
  throw aiError('A file in this message could not be read.', { code: 'bad_document' });
}

export function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : part?.type === 'text' ? part.text : JSON.stringify(part)).join('\n');
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

export function parseToolInput(json, name = 'tool') {
  const source = String(json ?? '').trim();
  if (!source) return {};
  try {
    const value = JSON.parse(source);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
  } catch {
    throw aiError(`The model sent input for ${name} that is not valid JSON. Try again.`, { code: 'bad_tool_input' });
  }
}

// Strict tool schemas need closed objects with every property required and none of the constraint keywords that
// strict decoding does not support. Anything else is sent without strict.
const STRICT_UNSUPPORTED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
  'maxItems', 'uniqueItems', 'patternProperties', 'propertyNames', 'not', 'if', 'then', 'else', 'dependentSchemas', 'dependentRequired',
  '$ref', '$defs', 'definitions', 'minProperties', 'maxProperties', 'contains'];
export function isStrictSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 12) return false;
  if (STRICT_UNSUPPORTED.some(key => key in schema)) return false;
  if (schema.minItems !== undefined && schema.minItems > 1) return false;
  for (const key of ['anyOf', 'allOf', 'oneOf']) if (schema[key] && !(Array.isArray(schema[key]) && schema[key].every(entry => isStrictSchema(entry, depth + 1)))) return false;
  const types = [].concat(schema.type || []);
  if (types.includes('object') || schema.properties) {
    if (schema.additionalProperties !== false) return false;
    const properties = Object.keys(schema.properties || {});
    const required = new Set(schema.required || []);
    if (properties.some(name => !required.has(name))) return false;
    if (!properties.every(name => isStrictSchema(schema.properties[name], depth + 1))) return false;
  }
  if (types.includes('array') || schema.items) { if (schema.items && !isStrictSchema(schema.items, depth + 1)) return false; }
  return true;
}

export const toolSchema = tool => tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} };

// Looks back through the conversation for the tool_use that a tool_result answers (Gemini and Ollama need its name).
export function toolNameFor(messages, toolUseId) {
  for (let index = messages.length - 1; index >= 0; index--) {
    for (const part of partsOf(messages[index].content)) if (part?.type === 'tool_use' && part.id === toolUseId) return part.name;
  }
  return '';
}

export function incompleteError(provider) {
  return aiError(`${provider?.name || 'The provider'} stopped before finishing the answer. The partial answer was kept.`, { code: 'incomplete' });
}

export function refusalError({ provider, explanation = '', category = '', stopReason = 'refusal' }) {
  const who = provider?.transport === 'anthropic' ? 'Claude' : provider?.name || 'The model';
  const message = explanation ? `${who} declined this request. ${explanation.trim()}` : `${who} declined this request. Try rephrasing it.`;
  return aiError(message, { code: 'refusal', stopReason, refusal: { category: category || null, explanation: explanation || null } });
}

// Short random tag for synthetic tool-call ids, so ids made in different steps of one tool loop never collide.
export const uniqueTag = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 8);

export const compactUsage = usage => Object.fromEntries(Object.entries(usage).filter(([, value]) => Number.isFinite(value)));

export const STOP_NOTICES = { max_tokens: 'The answer reached the output limit and may be cut off.' };
