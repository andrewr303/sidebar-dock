// Local bridge transport: bridge providers and CLI agents (Claude Code, Codex) through POST /ai/chat (NDJSON).
// The bridge rebuilds its own system prompt and runs agents without tools, so this path returns text only and passes
// Still's instructions and context along as reference sources.

import { EFFORT_LEVELS, clampEffort } from '../catalog.js';
import { aiError } from '../http.js';
import { compactUsage, dataUrlOf, partsOf, refusalError, STOP_NOTICES, textOf, toolResultText } from './shared.js';

const SOURCE_CHARS = 48000;
const QUERY_CHARS = 16000;

export function bridgeProviderId({ provider, connection }) {
  if (provider?.agentId) return `cli:${provider.agentId}`;
  const id = connection?.bridgeProviderId;
  if (!id) throw aiError('This bridge connection is missing its provider. Reconnect it in AI settings.', { code: 'no_connection' });
  return id;
}

const plain = content => textOf(content) || partsOf(content).filter(part => part?.type === 'tool_result').map(part => toolResultText(part.content)).join('\n\n');

// CLI agents take any standard effort (narrowed to the model's list when known). A bridge provider rejects an effort
// that is not enabled in its capabilities, so nothing is sent when none are enabled or they are unknown.
function bridgeEffort({ provider, connection, modelInfo, effort }) {
  if (!effort) return undefined;
  if (provider?.agentId) return clampEffort(effort, modelInfo?.efforts?.length ? modelInfo.efforts : EFFORT_LEVELS) || undefined;
  const enabled = connection?.capabilities?.reasoningEfforts || [];
  return enabled.length ? (enabled.includes(effort) ? effort : clampEffort(effort, enabled) || undefined) : undefined;
}

export function buildBody({ provider, connection, model, modelInfo, system, messages, effort, maxTokens }) {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index].role === 'user') { lastUser = index; break; }
  if (lastUser < 0) throw aiError('Write a message first.', { code: 'bad_request' });
  const sources = [];
  for (let offset = 0; system && offset < system.length && sources.length < 4; offset += SOURCE_CHARS) {
    sources.push({ id: `still-instructions-${sources.length + 1}`, title: 'Instructions and context from Still', type: 'note', text: system.slice(offset, offset + SOURCE_CHARS), truncated: offset + SOURCE_CHARS < system.length && sources.length === 3 });
  }
  let query = plain(messages[lastUser].content).trim() || 'Continue.';
  if (query.length > QUERY_CHARS) {
    sources.push({ id: 'still-request', title: 'Full request', type: 'note', text: query.slice(0, SOURCE_CHARS), truncated: query.length > SOURCE_CHARS });
    query = 'Answer the full request in the source titled Full request.';
  }
  const history = messages.slice(0, lastUser).map(message => ({ role: message.role, content: plain(message.content) })).filter(message => message.content).slice(-16);
  const context = { sources, scope: 'selected', inputBudgetChars: 400000 };
  const images = partsOf(messages[lastUser].content).filter(part => part?.type === 'image');
  // CLI agents and providers without image input reject attachments outright; say so in the request instead.
  if (images.length && !provider?.agentId && connection?.capabilities?.images !== false) context.imageAttachments = images.slice(0, 3).map(dataUrlOf);
  else if (images.length && query.length < QUERY_CHARS - 80) query += '\n\n[An image was attached, but this connection cannot read images.]';
  const body = { providerId: bridgeProviderId({ provider, connection }), query, intent: 'chat', context, history };
  if (model && model !== 'default') body.model = model;
  const reasoningEffort = bridgeEffort({ provider, connection, modelInfo, effort });
  if (reasoningEffort) body.reasoningEffort = reasoningEffort;
  if (Number.isInteger(maxTokens) && maxTokens > 0) body.maxOutputTokens = maxTokens;
  return body;
}

export function bridgeUsage(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return compactUsage({
    inputTokens: raw.input_tokens ?? raw.prompt_tokens ?? raw.promptTokenCount ?? raw.inputTokens,
    outputTokens: raw.output_tokens ?? raw.completion_tokens ?? raw.candidatesTokenCount ?? raw.outputTokens,
    cacheReadTokens: raw.cache_read_input_tokens ?? raw.cacheReadInputTokens,
  });
}

const STOPS = { end_turn: 'end_turn', stop: 'end_turn', STOP: 'end_turn', completed: 'end_turn', max_tokens: 'max_tokens', length: 'max_tokens', MAX_TOKENS: 'max_tokens', max_output_tokens: 'max_tokens' };

export async function stream(ctx) {
  const { provider, model, signal, emit, request } = ctx;
  if (typeof request !== 'function') throw aiError('Pair the local bridge first to use this connection.', { code: 'bridge_unavailable' });
  const body = buildBody(ctx);
  let text = '', thinking = '';
  const done = await request('/ai/chat', {
    method: 'POST', body, signal,
    onEvent: event => {
      if (event.type === 'delta' && event.text) { text += event.text; emit({ type: 'text', delta: event.text }); }
      else if (event.type === 'thinking' && event.text) { thinking += event.text; emit({ type: 'thinking', delta: event.text }); }
    },
  });
  const finalText = typeof done?.text === 'string' && done.text ? done.text : text;
  if (done?.stopReason === 'refusal') {
    const error = refusalError({ provider, explanation: done.stopDetails?.explanation || '' });
    error.partialText = finalText;
    throw error;
  }
  const stopReason = STOPS[done?.stopReason] || 'end_turn';
  return {
    text: finalText, thinking, toolCalls: [], usage: bridgeUsage(done?.usage), model: done?.model || model,
    stopReason, rawStopReason: done?.stopReason || null, notice: STOP_NOTICES[stopReason] || null,
    assistantMessage: { role: 'assistant', content: finalText ? [{ type: 'text', text: finalText }] : [] },
  };
}
