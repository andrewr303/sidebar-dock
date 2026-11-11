// streamChat: one streaming chat call against any connection. Emits normalized events and resolves with the
// final text, thinking, tool calls, usage and the provider-native assistant message for tool loops.

import { TRANSPORTS, getAiSettings, modelInfo, resolveConnection } from './connections.js';
import { aiError } from './http.js';
import { redactError } from './secrets.js';
import { abortError } from './stream.js';
import * as bridgeTransport from './transports/bridge.js';
import { normalizeWebSearch, webSearchKind } from './web-search.js';

const ROLES = new Set(['user', 'assistant']);
const PART_TYPES = new Set(['text', 'image', 'document', 'tool_use', 'tool_result']);
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const IMAGE_NOTE = '[An image was attached, but this model cannot read images.]';
const DOCUMENT_NOTE = '[A file was attached, but this connection cannot read files.]';

export function normalizeMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw aiError('Write a message first.', { code: 'bad_request' });
  if (messages.length > 2000) throw aiError('This conversation is too long. Start a new chat.', { code: 'too_large' });
  return messages.map(message => {
    if (!message || !ROLES.has(message.role)) throw aiError('Chat messages must come from the user or the assistant.', { code: 'bad_request' });
    let content = message.content;
    if (typeof content !== 'string') {
      if (!Array.isArray(content)) throw aiError('Chat message content must be text or a list of parts.', { code: 'bad_request' });
      content = content.filter(Boolean).map(part => typeof part === 'string' ? { type: 'text', text: part } : part);
      for (const part of content) if (!PART_TYPES.has(part.type)) throw aiError(`Unsupported message part: ${String(part.type).slice(0, 40)}.`, { code: 'bad_request' });
    }
    return { role: message.role, content, ...(message.native ? { native: message.native } : {}) };
  });
}

export function normalizeTools(tools) {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) throw aiError('Tools must be a list.', { code: 'bad_request' });
  const seen = new Set();
  return tools.map(tool => {
    if (!tool || !TOOL_NAME.test(tool.name || '')) throw aiError('Each tool needs a name of letters, numbers, dashes or underscores.', { code: 'bad_request' });
    if (seen.has(tool.name)) throw aiError(`The tool ${tool.name} is listed twice.`, { code: 'bad_request' });
    seen.add(tool.name);
    const inputSchema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
    return { name: tool.name, description: typeof tool.description === 'string' ? tool.description : '', inputSchema };
  });
}

// Models without image input get a short note instead of the image, so the rest of the request still works.
function withoutImages(messages) {
  return messages.map(message => typeof message.content === 'string' || message.native ? message
    : { ...message, content: message.content.map(part => part.type === 'image' ? { type: 'text', text: IMAGE_NOTE } : part) });
}

// File parts (PDFs) reach only the direct APIs that read them; anything else gets a note instead.
function withoutDocuments(messages) {
  return messages.map(message => typeof message.content === 'string' || message.native ? message
    : { ...message, content: message.content.map(part => part.type === 'document' ? { type: 'text', text: DOCUMENT_NOTE } : part) });
}

const systemText = system => Array.isArray(system) ? system.filter(entry => typeof entry === 'string' && entry).join('\n\n') : typeof system === 'string' ? system : '';

function finalizeError(caught, { text, thinking, secrets, signal }) {
  let error = caught instanceof Error ? caught : new Error(String(caught || 'The AI request failed.'));
  if (signal?.aborted && error.code !== 'aborted') {
    const stopped = abortError(signal);
    stopped.partialText = error.partialText;
    error = stopped;
  }
  redactError(error, secrets);
  if (typeof error.partialText !== 'string' || error.partialText.length < text.length) error.partialText = text;
  error.partialThinking = thinking;
  if (!error.code) error.code = 'error';
  return error;
}

/**
 * webSearch (optional): { maxUses } lets the provider search the web for this request, where the connection is one of
 * the providers that can (lib/ai/web-search.js); elsewhere it is ignored. The result then carries webSearched (the
 * provider ran a search, so text from the web was in the model's context) and webSources (the pages it used), and
 * `web_search` events say that a search started ({ started: true }) and what was searched for ({ query }).
 */
export function streamChat({ connectionId, model, system, messages, tools, effort, maxTokens, webSearch = null, signal, onEvent } = {}) {
  const emit = event => {
    if (typeof onEvent !== 'function') return;
    try { onEvent(event); } catch (error) { console.error(error); }
  };
  let text = '', thinking = '', secrets = [];
  const relay = event => {
    // Nothing reaches the caller after Stop, even if a transport still has buffered events in hand.
    if (signal?.aborted) return;
    if (event.type === 'text') text += event.delta;
    else if (event.type === 'thinking') thinking += event.delta;
    emit(event);
  };
  return (async () => {
    try {
      if (signal?.aborted) throw abortError(signal);
      const resolved = await resolveConnection(connectionId);
      secrets = resolved.apiKey ? [resolved.apiKey] : [];
      const { provider, connection, via } = resolved;
      if (!provider.chat) throw aiError(`${provider.name} only provides embeddings. Pick a chat connection in AI settings.`, { code: 'bad_request' });
      // With no explicit connection or model, the chat defaults from AI settings apply.
      const settings = await getAiSettings();
      const usesDefault = !connectionId || connectionId === settings.chat.connectionId;
      const chosen = (typeof model === 'string' && model.trim()) || (usesDefault && settings.chat.model) || connection.defaultModel || provider.chat.recommended || '';
      // A bridge provider without a model falls back to the model saved in the bridge.
      if (!chosen && via !== 'bridge') throw aiError(`Pick a model for ${connection.label} in AI settings.`, { code: 'no_model' });
      const info = await modelInfo(resolved, chosen);
      let list = normalizeMessages(messages);
      if (provider.supports.images === false || info?.capabilities?.images === false) list = withoutImages(list);
      if (!provider.supports.documents || via !== 'direct') list = withoutDocuments(list);
      const toolList = provider.supports.tools && info?.capabilities?.tools !== false ? normalizeTools(tools) : [];
      const transport = via === 'direct' ? TRANSPORTS[provider.transport] : bridgeTransport;
      if (!transport) throw aiError(`${provider.name} cannot be used for chat here.`, { code: 'bad_request' });
      emit({ type: 'start', connectionId: connection.id, providerId: provider.id, providerName: provider.name, label: connection.label, model: chosen, modelLabel: info?.name || chosen, via });
      const result = await transport.stream({
        ...resolved, model: chosen, modelInfo: info, system: systemText(system), messages: list, tools: toolList,
        effort: typeof effort === 'string' && effort ? effort : usesDefault ? settings.chat.effort : undefined, maxTokens: Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : undefined,
        ...(webSearch && via === 'direct' && webSearchKind(resolved) ? { webSearch: { maxUses: normalizeWebSearch({ ...webSearch, enabled: true }).maxUses } } : {}),
        signal, emit: relay,
      });
      const final = {
        text: result.text ?? text, thinking: result.thinking ?? thinking, toolCalls: result.toolCalls || [], usage: result.usage || {},
        stopReason: result.stopReason || 'end_turn', rawStopReason: result.rawStopReason ?? null, notice: result.notice || null, fallback: result.fallback || null,
        assistantMessage: result.assistantMessage, model: result.model || chosen, connectionId: connection.id, providerId: provider.id,
        ...(Array.isArray(result.webSources) && result.webSources.length ? { webSources: result.webSources } : {}),
        ...(result.webSearched ? { webSearched: true } : {}),
      };
      if (Object.keys(final.usage).length) emit({ type: 'usage', usage: final.usage });
      emit({ type: 'done', ...final });
      return final;
    } catch (caught) {
      const error = finalizeError(caught, { text, thinking, secrets, signal });
      emit({ type: 'error', message: error.message, code: error.code, partialText: error.partialText, aborted: error.code === 'aborted' });
      throw error;
    }
  })();
}
