// Research runs: a Claude Managed Agents session that researches one saved item, driven from an extension page and
// mirrored into an assistant conversation (kind 'research') that every Still view renders from storage.
//
// Lifecycle. startResearch saves the conversation ('starting'), then, holding the Web Lock still.research.<id>, makes
// sure the agent and environment exist (provision.js), creates the session with the run's budget, opens the event
// stream FIRST, replays history, sends the kickoff, and follows the stream until the done gate fires. Custom tool calls
// run here (custom-tools.js); each result is saved in conversation.research.handled BEFORE it is posted, so a replay
// re-posts the stored text and never applies a write twice. A dropped stream reconnects with the consolidation pattern:
// open the stream, page the full history, dedupe by event id, settle calls the session still waits on, tail.
//
// Done gate (wire map §9): idle + requires_action -> answer stop_reason.event_ids; idle + end_turn -> 'done' ('stopped'
// after our interrupt); idle + budget_reached -> 'waiting' (reason 'budget'); retries_exhausted, refusal, terminated
// and deleted -> 'failed'. History is gated only on its last status event, and not while a turn we started is still
// pending (a user.message or budget change after that status), so an earlier turn's idle never ends a new one.
//
// The run lives in the page that drives it: the lock gives exclusivity across views, and { ownerId, heartbeatAt } (every
// 5 s) lets other views show a stale run (no heartbeat for 30 s) with a Resume action. If every Still page closes, the
// session simply waits at its next custom tool call, which costs nothing, until a view resumes it.

import { aiError } from '../http.js';
import { abortError } from '../stream.js';
import { RESEARCH_MODEL, sessionAgent } from './agent-config.js';
import { createManagedClient } from './api.js';
import { WRITE_TOOL_NAMES, createGitHubResearch, createToolRunner, describeToolUse, isErrorResult, readItem } from './custom-tools.js';
import { buildFollowUp, buildKickoff } from './prompt.js';
import { defaultResearchStorage, ensureProvisioned, isResearchConnection, pickResearchConnection, resetResearchProvisioning as forgetProvisioning, resolveResearchConnection } from './provision.js';
import { RESEARCH_LIMITS, RESEARCH_STALE_MS, budgetFor, normalizeResearchSettings } from './settings.js';

export const RESEARCH_STATUSES = Object.freeze(['starting', 'running', 'waiting', 'done', 'stopped', 'failed']);
export const RESEARCH_TIMING = Object.freeze({ heartbeatMs: 5000, staleMs: RESEARCH_STALE_MS, persistMs: 1000, idleMs: 90000, stopGraceMs: 30000, maxReconnects: 8 });
export const MAX_STEPS = 200;
export const HANDLED_LIMIT = 300;
const HANDLED_CHARS = 1000000;
const MESSAGE_IDS_LIMIT = 1000;
const PREVIEW_CHARS = 200000;
const ACTIVE = new Set(['starting', 'running']);
const STATUS_EVENTS = new Set(['session.status_running', 'session.status_idle', 'session.status_rescheduled', 'session.status_terminated', 'session.deleted']);
const RECONNECT_CODES = new Set(['network', 'timeout', 'rate_limit', 'provider_down', 'provider_error', 'stream_idle', 'stream_eof', 'bad_response']);
const SKIPPED = JSON.stringify({ ok: false, error: 'skipped', message: 'This call came from an earlier turn that was stopped, so it was not run.' });

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const oneLine = (value, max = 200) => (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim().slice(0, max);
const httpUrl = value => { try { const url = new URL(String(value || '')); return /^https?:$/.test(url.protocol) ? url.href : ''; } catch { return ''; } };
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const joinText = (...parts) => parts.map(part => String(part || '').trim()).filter(Boolean).join('\n\n');
const defaultUid = prefix => `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`}`;
const defaultIsExtension = () => !!globalThis.chrome?.runtime?.id;
const reconnectable = error => !!error && (error.reconnect === true || RECONNECT_CODES.has(error.code));
const missing = error => error?.status === 404 || error?.code === 'not_found';

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Session usage in the shape research records keep: cost in US dollars, token and search counts. */
export function compactUsage(usage) {
  if (!isObject(usage)) return null;
  const cents = Number(usage.list_cost?.amount);
  const count = value => Number.isFinite(value) ? value : null;
  return { costUsd: Number.isFinite(cents) ? cents / 100 : null, currency: oneLine(usage.list_cost?.currency, 8) || 'USD',
    inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens), cacheReadTokens: count(usage.cache_read_input_tokens),
    webSearches: count(usage.server_tool_use?.web_search_requests), activeSeconds: count(usage.active_seconds) };
}

// The progress step for a built-in tool call (web_search / web_fetch arrive as agent.tool_use events).
function builtinStep(event) {
  const input = isObject(event.input) ? event.input : {};
  if (event.name === 'web_search') {
    const query = oneLine(input.query, 160);
    return query ? { kind: 'search', label: `Searched the web for “${query}”`, detail: query } : { kind: 'search', label: 'Searched the web' };
  }
  if (event.name === 'web_fetch') {
    const url = httpUrl(input.url);
    return url ? { kind: 'fetch', label: `Read ${hostOf(url) || 'a page'}`, url } : { kind: 'fetch', label: 'Read a page' };
  }
  return { kind: 'tool', label: `Used ${oneLine(event.name, 60) || 'a tool'}` };
}

const resultText = event => (Array.isArray(event?.content) ? event.content : []).map(block => block?.type === 'text' && typeof block.text === 'string' ? block.text : '').join(' ');
const FETCH_ERRORS = { url_not_allowed: 'Blocked by the site or by research rules', url_not_accessible: 'Could not open the page', url_not_in_prior_context: 'That address had not come up yet',
  too_many_requests: 'The site was rate limiting requests', unsupported_content_type: 'Not a readable page type', content_too_large: 'The page was too large', url_too_long: 'The address was too long' };
function errorDetail(event) {
  const text = resultText(event);
  const code = Object.keys(FETCH_ERRORS).find(key => text.includes(key));
  return code ? FETCH_ERRORS[code] : oneLine(text, 160);
}

const ERROR_TYPES = {
  billing_error: 'Your Anthropic account has a billing problem. Check its plan and credits, then try again.',
  model_overloaded_error: 'Claude is overloaded right now.',
  model_rate_limited_error: 'Your Anthropic account hit a rate limit.',
  model_request_failed_error: 'A request to Claude failed.',
};

function findAssistant(conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index]?.role === 'assistant' && isObject(messages[index].research)) return messages[index];
  return null;
}

/**
 * The research engine for one page. deps: conversations (createConversationStore instance), store ({ loadLibrary,
 * saveItem, updateItem, deleteItem, upsertContentSection? }), getAiSettings, listConnections, resolveConnection, and
 * optionally fetch, githubToken() -> token, storage (provisioning record), locks (navigator.locks), now() -> ISO
 * string, uid(prefix), isExtension(), timing (RESEARCH_TIMING overrides), sleep(ms, signal).
 */
export function createResearch({ conversations, store, getAiSettings, listConnections, resolveConnection, fetch: fetchImpl, githubToken,
  storage = defaultResearchStorage(), locks = globalThis.navigator?.locks, now = () => new Date().toISOString(), uid = defaultUid,
  isExtension = defaultIsExtension, timing = {}, sleep = defaultSleep } = {}) {
  const T = { ...RESEARCH_TIMING, ...timing };
  const ownerId = uid('view');
  const runs = new Map();
  const listeners = new Set();
  const heldHere = new Set();
  const nowMs = () => Date.parse(now()) || Date.now();
  const backoff = (attempt, error) => Number.isFinite(error?.retryAfter) && error.retryAfter > 0 ? Math.min(30000, error.retryAfter * 1000) : Math.min(30000, 500 * 2 ** Math.max(0, attempt - 1));
  const clientFor = resolved => createManagedClient({ apiKey: resolved.apiKey, baseUrl: resolved.baseUrl, connection: resolved.connection, provider: resolved.provider, fetchImpl });
  const fresh = research => Number.isFinite(Date.parse(research?.heartbeatAt)) && nowMs() - Date.parse(research.heartbeatAt) < T.staleMs;

  async function aiSettings() {
    let all = {};
    try { all = (await getAiSettings()) || {}; } catch (error) { console.warn('[still] could not read AI settings for research', error); }
    return { all, research: normalizeResearchSettings(all.research) };
  }

  async function loadConversation(id) {
    const conversation = typeof id === 'string' && id ? await conversations.getConversation(id) : null;
    if (!conversation || conversation.kind !== 'research' || !isObject(conversation.research)) throw aiError('That research conversation no longer exists.', { code: 'not_found' });
    return conversation;
  }

  // ---------- exclusivity ----------

  // Runs task while holding still.research.<id>; resolves { acquired, done }. `acquired` is false when another view (or
  // this one) already drives the run.
  function lockRun(conversationId, task) {
    const name = `still.research.${conversationId}`;
    let settle;
    const acquired = new Promise(resolve => { settle = resolve; });
    const guarded = () => { settle(true); return task(); };
    let done;
    if (typeof locks?.request === 'function') done = locks.request(name, { ifAvailable: true }, lock => lock ? guarded() : null);
    else if (heldHere.has(name)) done = Promise.resolve(null);
    else { heldHere.add(name); done = Promise.resolve().then(guarded).finally(() => heldHere.delete(name)); }
    done = done.then(result => { settle(false); return result; }, error => { settle(false); throw error; });
    return { acquired, done };
  }

  // ---------- events to the page ----------

  function emit(run) {
    const event = { type: 'research', conversationId: run.id, status: run.research.status, conversation: run.conversation, message: run.message };
    for (const listener of [...listeners]) { try { listener(event); } catch (error) { console.error(error); } }
  }

  // ---------- persistence ----------

  // Saves the run's conversation (serialized per run). Reads the stored copy first: a deleted conversation stops the run,
  // and a stop requested from another view or a renamed title is adopted. An earlier turn's stop that this run cleared
  // (run.staleStop) is still stored until the first save and is not a new request. Never throws.
  function persist(run) {
    clearTimeout(run.persistTimer);
    run.persistTimer = null;
    run.saving = run.saving.then(async () => {
      if (run.deleted) return;
      try {
        const stored = await conversations.getConversation(run.id);
        if (!stored) { onDeleted(run); return; }
        const stopAt = stored.research?.stopRequestedAt;
        if (stopAt && stopAt !== run.staleStop && !run.research.stopRequestedAt) { run.research.stopRequestedAt = stopAt; requestStop(run).catch(() => {}); }
        if (typeof stored.title === 'string' && stored.title && stored.title !== run.savedTitle) run.conversation.title = stored.title;
        run.conversation.updatedAt = now();
        const saved = await conversations.saveConversation(run.conversation);
        run.savedTitle = saved?.title || run.conversation.title;
        run.staleStop = '';
      } catch (error) { console.warn('[still] could not save research progress', error); }
    });
    return run.saving;
  }
  function schedulePersist(run) {
    if (run.persistTimer || run.deleted) return;
    run.persistTimer = setTimeout(() => { run.persistTimer = null; persist(run); }, T.persistMs);
  }
  // Keeps the newest results (at most HANDLED_LIMIT and about 1M characters); the one just added always stays.
  function remember(run, eventId, text) {
    const handled = isObject(run.research.handled) ? run.research.handled : {};
    delete handled[eventId];
    handled[eventId] = text;
    const keys = Object.keys(handled);
    let total = keys.reduce((sum, key) => sum + (typeof handled[key] === 'string' ? handled[key].length : 0), 0);
    while (keys.length > 1 && (keys.length > HANDLED_LIMIT || total > HANDLED_CHARS)) {
      const key = keys.shift();
      total -= typeof handled[key] === 'string' ? handled[key].length : 0;
      delete handled[key];
    }
    run.research.handled = handled;
  }

  function onDeleted(run) {
    if (run.deleted) return;
    run.deleted = true;
    // The user deleted the conversation mid-run: stop the agent too, so it does not keep spending.
    const sessionId = run.message?.research?.sessionId;
    if (sessionId) run.client.interrupt(sessionId).catch(() => {});
    run.controller.abort(new Error('The research conversation was deleted.'));
  }

  // ---------- rendering events into the conversation ----------

  function addStep(run, step) {
    const steps = run.message.research.steps;
    if (steps.some(entry => entry.id === step.id)) return null;
    // Repeated searches and re-reads of a page share one row.
    if ((step.kind === 'search' && step.detail) || (step.kind === 'fetch' && step.url)) {
      const same = steps.find(entry => entry.kind === step.kind && (step.kind === 'search' ? entry.detail === step.detail : entry.url === step.url));
      if (same) { run.alias.set(step.id, same.id); same.state = step.state; same.at = now(); return same; }
    }
    const entry = { ...step, at: now() };
    if (steps.length >= MAX_STEPS) {
      let summary = steps.find(item => item.id === 'collapsed');
      const need = steps.length - MAX_STEPS + 1 + (summary ? 0 : 1);
      const indices = [];
      for (let i = 0; i < steps.length && indices.length < need; i++) {
        const item = steps[i];
        if (item.id !== 'collapsed' && item.state !== 'running' && item.kind !== 'write' && item.kind !== 'subpage') indices.push(i);
      }
      if (indices.length < need) return null;
      for (let i = indices.length - 1; i >= 0; i--) steps.splice(indices[i], 1);
      if (!summary) { summary = { id: 'collapsed', kind: 'note', label: '', state: 'done', at: entry.at, count: 0 }; steps.unshift(summary); }
      summary.count = (summary.count || 0) + indices.length;
      summary.label = `${summary.count} earlier step${summary.count === 1 ? '' : 's'}`;
    }
    steps.push(entry);
    return entry;
  }
  function finishStep(run, id, isError, detail = '') {
    const step = run.message.research.steps.find(entry => entry.id === (run.alias.get(id) || id));
    if (!step) return;
    step.state = isError ? 'error' : 'done';
    if (isError && detail) step.detail = detail;
  }
  function statusStep(run, key, label, state = 'done') {
    const id = `status:${key}`;
    const steps = run.message.research.steps;
    const existing = steps.find(entry => entry.id === id);
    if (existing) { existing.label = label; existing.state = state; existing.at = now(); return; }
    addStep(run, { id, kind: 'status', label, state });
  }

  function render(run, event) {
    const meta = run.message.research;
    switch (event.type) {
      case 'agent.message': {
        if (meta.messageIds.includes(event.id)) return;
        meta.messageIds.push(event.id);
        if (meta.messageIds.length > MESSAGE_IDS_LIMIT) meta.messageIds.splice(0, meta.messageIds.length - MESSAGE_IDS_LIMIT);
        const body = (Array.isArray(event.content) ? event.content : []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
        if (body.trim()) run.message.text = joinText(run.message.text, body);
        if (meta.preview?.id === event.id) delete meta.preview;
        return;
      }
      case 'agent.tool_use': case 'agent.mcp_tool_use':
        addStep(run, { id: event.id, ...builtinStep(event), state: 'running' });
        return;
      case 'agent.tool_result': finishStep(run, event.tool_use_id, event.is_error === true, event.is_error ? errorDetail(event) : ''); return;
      case 'agent.mcp_tool_result': finishStep(run, event.mcp_tool_use_id, event.is_error === true, event.is_error ? errorDetail(event) : ''); return;
      case 'agent.custom_tool_use': addStep(run, { id: event.id, ...describeToolUse(event.name, event.input), state: 'running' }); return;
      case 'user.custom_tool_result': {
        const step = meta.steps.find(entry => entry.id === event.custom_tool_use_id);
        if (step?.state === 'running') step.state = event.is_error ? 'error' : 'done';
        return;
      }
      case 'agent.thread_context_compacted': addStep(run, { id: event.id, kind: 'note', label: 'Condensed earlier context to keep going', state: 'done' }); return;
      case 'session.status_rescheduled': statusStep(run, 'retry', 'A temporary problem; retrying'); return;
      case 'session.error': {
        const error = isObject(event.error) ? event.error : {};
        const retry = error.retry_status?.type;
        const message = ERROR_TYPES[error.type] || oneLine(error.message, 300) || 'The research agent hit an error.';
        if (!retry || retry === 'retrying') statusStep(run, 'retry', `${message.replace(/[.!]$/, '')}; retrying`);
        else { run.lastError = message; statusStep(run, 'error', message, 'error'); }
        return;
      }
      case 'span.model_request_end':
        // A preview whose buffered message never came (an interrupted request) is closed here.
        if (meta.preview && !meta.preview.text) delete meta.preview;
        return;
      default:
    }
  }

  function previewEvent(run, event) {
    const meta = run.message.research;
    if (event.type === 'event_start') {
      const id = event.event?.type === 'agent.message' && typeof event.event.id === 'string' ? event.event.id : '';
      if (id && !meta.messageIds.includes(id)) meta.preview = { id, text: '' };
      return;
    }
    const id = typeof event.event_id === 'string' ? event.event_id : '';
    const piece = event.delta?.content?.type === 'text' && typeof event.delta.content.text === 'string' ? event.delta.content.text : '';
    if (!id || !piece || meta.messageIds.includes(id)) return;
    if (meta.preview?.id !== id) meta.preview = { id, text: '' };
    if (meta.preview.text.length < PREVIEW_CHARS) meta.preview.text += piece;
    emit(run);
    schedulePersist(run);
  }

  // Records one persisted event (history or live). Returns true the first time an id is seen. Running events are counted
  // in session order, so events of an earlier turn (before this message's baseline) are never rendered into it.
  function ingest(run, event, history) {
    if (typeof event?.id !== 'string' || !event.id) return false;
    const meta = run.message.research;
    run.byId.set(event.id, event);
    if (event.type === 'user.custom_tool_result' && typeof event.custom_tool_use_id === 'string') run.answered.add(event.custom_tool_use_id);
    if (event.type === 'user.tool_confirmation' && typeof event.tool_use_id === 'string') run.answered.add(event.tool_use_id);
    const first = !run.seen.has(event.id);
    if (event.type === 'session.status_running' && (history || first)) run.runningCount++;
    if (history && event.type === 'user.message' && Number.isInteger(meta.baseline) && run.runningCount >= meta.baseline) run.userAfter++;
    if (!first) return false;
    run.seen.add(event.id);
    if (event.type === 'session.usage' && isObject(event.usage)) run.research.usage = compactUsage(event.usage);
    if (Number.isInteger(meta.baseline) && run.runningCount > meta.baseline) render(run, event);
    schedulePersist(run);
    emit(run);
    return true;
  }

  // ---------- custom tools ----------

  async function post(run, send) {
    for (let attempt = 1; ; attempt++) {
      try { return await send(); } catch (error) {
        if (run.controller.signal.aborted) throw abortError(run.controller.signal);
        if (!reconnectable(error) || attempt >= 4) throw error;
        await sleep(backoff(attempt, error), run.controller.signal);
      }
    }
  }

  async function answer(run, event, { execute = true } = {}) {
    if (run.answered.has(event.id)) return;
    const sessionId = run.message.research.sessionId;
    let text = isObject(run.research.handled) ? run.research.handled[event.id] : undefined;
    if (typeof text !== 'string') {
      if (!execute) text = SKIPPED;
      else {
        const result = await run.tools.run(event.name, event.input);
        text = result.text;
        const step = run.message.research.steps.find(entry => entry.id === event.id) || addStep(run, { id: event.id, ...result.step, state: 'running' });
        if (step) Object.assign(step, result.step, { state: result.isError ? 'error' : 'done' });
        if (!result.isError && WRITE_TOOL_NAMES.includes(event.name)) run.message.research.writes++;
        if (!result.isError && event.name === 'create_subpage') {
          try { const page = JSON.parse(text); run.message.research.subpages.push({ id: page.id, title: page.title }); } catch {}
        }
      }
      // Saved BEFORE the result is posted: a replay re-posts this text instead of applying the write again.
      remember(run, event.id, text);
      await persist(run);
    } else {
      const step = run.message.research.steps.find(entry => entry.id === event.id);
      if (step?.state === 'running') step.state = isErrorResult(text) ? 'error' : 'done';
    }
    await post(run, () => run.client.sendEvents(sessionId, [{ type: 'user.custom_tool_result', custom_tool_use_id: event.id, content: [{ type: 'text', text }], is_error: isErrorResult(text) }]));
    run.answered.add(event.id);
    emit(run);
    // An interrupt that reached the session while it waited on this call was a no-op: send it again now.
    if (run.interrupted) run.client.interrupt(sessionId).catch(() => {});
  }

  // Answers every call a requires_action idle waits on. Built-in calls that ask for confirmation cannot happen with
  // always_allow; one that does is denied, never allowed, since nobody reviewed it.
  async function settle(run, idle, { execute = true } = {}) {
    for (const id of Array.isArray(idle?.stop_reason?.event_ids) ? idle.stop_reason.event_ids : []) {
      if (typeof id !== 'string' || run.answered.has(id)) continue;
      const event = run.byId.get(id);
      if (event?.type === 'agent.custom_tool_use') await answer(run, event, { execute });
      else if ((event?.type === 'agent.tool_use' || event?.type === 'agent.mcp_tool_use') && event.evaluated_permission === 'ask') {
        await post(run, () => run.client.sendEvents(run.message.research.sessionId, [{ type: 'user.tool_confirmation', tool_use_id: id, result: 'deny', deny_message: 'Still runs research without approval prompts, so this tool is not available.' }]));
        run.answered.add(id);
      }
    }
  }

  // ---------- the done gate and the stream loop ----------

  function gate(run, event) {
    if (event.type === 'session.status_terminated') return { status: 'failed', errorCode: 'terminated', error: run.lastError || 'The research session ended unexpectedly in your Anthropic account.' };
    if (event.type === 'session.deleted') return { status: 'failed', errorCode: 'deleted', error: 'The research session was deleted from your Anthropic account.' };
    if (event.type !== 'session.status_idle') return null;
    const type = event.stop_reason?.type;
    if (type === 'requires_action') return null;
    if (type === 'end_turn') return { status: run.interrupted ? 'stopped' : 'done' };
    if (type === 'budget_reached') return { status: 'waiting', reason: 'budget', error: 'The research reached its spending cap.' };
    if (type === 'retries_exhausted') return { status: 'failed', reason: 'retries_exhausted', error: run.lastError || 'The research agent kept hitting errors and stopped. Try again in a few minutes.' };
    if (type === 'refusal') {
      const why = oneLine(event.stop_details?.explanation, 500);
      return { status: 'failed', reason: 'refusal', error: why ? `Claude stopped this research: ${why}` : 'Claude declined to continue this research.' };
    }
    // A stop reason this build does not know: treat the turn as over, and say so.
    return { status: 'stopped', reason: oneLine(type, 60) || 'unknown', error: 'The research stopped for a reason this version of Still does not recognize.' };
  }

  async function replayHistory(run, signal) {
    const meta = run.message.research;
    const baselineKnown = Number.isInteger(meta.baseline);
    run.runningCount = 0;
    run.userAfter = 0;
    let last = null, turnPending = false;
    for await (const event of run.client.listAllEvents(meta.sessionId, { signal })) {
      ingest(run, event, true);
      if (STATUS_EVENTS.has(event.type)) { last = event; turnPending = false; }
      else if (event.type === 'user.message' || event.type === 'user.define_outcome' || (event.type === 'session.updated' && 'budget' in event)) {
        turnPending = true;
        if (event.type === 'session.updated' && 'budget' in event) run.expectResume = false;
      }
    }
    if (!baselineKnown) {
      // A follow-up turn: everything in the history so far belongs to earlier turns.
      meta.baseline = run.runningCount;
      await persist(run);
    } else if (run.pendingSend && !run.sendDone && run.sendKind === 'message' && run.userAfter > 0) {
      // Sent before a reload or a dropped connection: it is already queued in the session.
      run.sendDone = true;
      meta.sent = true;
    }
    const sending = !!run.pendingSend && !run.sendDone;
    if (last?.type === 'session.status_idle' && last.stop_reason?.type === 'requires_action') await settle(run, last, { execute: !sending });
    const expectingResume = run.expectResume && last?.type === 'session.status_idle' && last.stop_reason?.type === 'budget_reached';
    run.expectResume = false;
    if (!last || sending || turnPending || expectingResume) return null;
    return gate(run, last);
  }

  async function follow(run) {
    let failures = 0;
    for (;;) {
      if (run.controller.signal.aborted) throw abortError(run.controller.signal);
      const attempt = new AbortController();
      const signal = AbortSignal.any([run.controller.signal, attempt.signal]);
      try {
        const sessionId = run.message.research.sessionId;
        const stream = run.client.streamEvents(sessionId, { signal, deltas: ['agent.message'], idleMs: T.idleMs });
        await stream.opened;
        const outcome = await replayHistory(run, signal);
        if (outcome) return outcome;
        run.message.research.steps = run.message.research.steps.filter(step => step.id !== 'status:reconnect');
        if (run.pendingSend && !run.sendDone) {
          // Stopped before this turn's message went out: sending it now would start the very turn the stop was for.
          if (run.interrupted) return { status: 'stopped' };
          await run.pendingSend();
          run.sendDone = true;
        }
        for await (const event of stream) {
          failures = 0;
          if (event.type === 'event_start' || event.type === 'event_delta') { previewEvent(run, event); continue; }
          if (!ingest(run, event, false)) continue;
          if (event.type === 'agent.custom_tool_use') await answer(run, event);
          if (event.type === 'session.status_idle' && event.stop_reason?.type === 'requires_action') await settle(run, event);
          const done = gate(run, event);
          if (done) return done;
        }
        throw aiError('The research stream closed. Reconnecting.', { code: 'stream_eof', reconnect: true });
      } catch (error) {
        if (run.controller.signal.aborted) throw abortError(run.controller.signal);
        if (!reconnectable(error)) throw error;
        failures++;
        if (failures > T.maxReconnects) throw aiError('Still lost the connection to the research session. Resume it when you are back online.', { code: error.code || 'network', offline: true });
        statusStep(run, 'reconnect', 'Reconnecting to the research session', 'running');
        await sleep(backoff(failures, error), run.controller.signal);
      } finally {
        attempt.abort();
      }
    }
  }

  // ---------- run lifecycle ----------

  // staleStop: an earlier turn's stopRequestedAt this run dropped (see clearStop), so persist() does not adopt it again.
  function createRun(conversation, { resolved, settings, staleStop = '' }) {
    const research = conversation.research;
    const run = {
      id: conversation.id, conversation, research, message: findAssistant(conversation), resolved, client: clientFor(resolved), settings,
      controller: new AbortController(), interrupted: !!research.stopRequestedAt, staleStop, savedTitle: conversation.title,
      seen: new Set(), byId: new Map(), answered: new Set(), alias: new Map(), runningCount: 0, userAfter: 0,
      pendingSend: null, sendKind: '', sendDone: false, expectResume: false, lastError: '',
      saving: Promise.resolve(), persistTimer: null, heartbeat: null, stopTimer: null, deleted: false, stopForced: false, done: null,
    };
    const meta = run.message.research;
    for (const key of ['steps', 'subpages', 'messageIds']) if (!Array.isArray(meta[key])) meta[key] = [];
    if (!Number.isInteger(meta.writes)) meta.writes = 0;
    run.github = createGitHubResearch({ fetchImpl, ...(githubToken ? { getToken: githubToken } : {}), mode: settings.github, sleep: ms => sleep(ms, run.controller.signal) });
    run.tools = createToolRunner({ store, itemId: research.itemId, state: research, maxSubpages: settings.maxSubpages, allowOriginalEdits: research.allowOriginalEdits === true,
      github: run.github, now, isStopped: () => run.interrupted });
    return run;
  }

  // A new turn (a follow-up, or a raised cap) is not stopped by an earlier turn's stop. The record is saved only once the
  // run holds its lock, so the stored copy keeps that stop until then; the returned value lets persist() tell it apart
  // from a stop requested for the new turn.
  function clearStop(research) {
    const stale = typeof research.stopRequestedAt === 'string' ? research.stopRequestedAt : '';
    delete research.stopRequestedAt;
    return stale;
  }

  function setStatus(run, status) {
    run.research.status = status;
    if (ACTIVE.has(status)) { delete run.research.reason; run.research.error = ''; delete run.research.errorCode; run.message.research.live = true; run.message.error = ''; }
    emit(run);
    return persist(run);
  }

  async function finish(run, outcome) {
    const research = run.research, meta = run.message.research;
    research.status = outcome.status;
    if (outcome.reason) research.reason = outcome.reason; else delete research.reason;
    research.error = outcome.error || '';
    if (outcome.errorCode) research.errorCode = outcome.errorCode; else delete research.errorCode;
    if (outcome.status !== 'waiting') research.finishedAt = now();
    meta.live = false;
    // An interrupted request's partial text is kept rather than lost.
    if (meta.preview?.text) run.message.text = joinText(run.message.text, meta.preview.text);
    delete meta.preview;
    for (const step of meta.steps) if (step.state === 'running') step.state = outcome.status === 'done' ? 'done' : 'error';
    meta.steps = meta.steps.filter(step => step.id !== 'status:reconnect');
    run.message.error = outcome.status === 'failed' ? research.error : outcome.status === 'stopped' ? 'Stopped' : '';
    if (meta.sessionId) {
      // The final cost: session.usage before an idle is not guaranteed for every stop reason.
      try { const session = await run.client.getSession(meta.sessionId); if (isObject(session?.usage)) research.usage = compactUsage(session.usage); } catch {}
    }
    emit(run);
    await persist(run);
  }

  function friendly(error) {
    const message = oneLine(error?.message, 500) || 'The research could not continue.';
    return /[.!?]$/.test(message) ? message : `${message}.`;
  }

  // Drives a run to its done gate. prepare(run) (optional) creates the session first.
  async function drive(run, prepare) {
    runs.set(run.id, run);
    run.research.ownerId = ownerId;
    run.research.heartbeatAt = now();
    run.heartbeat = setInterval(() => { run.research.ownerId = ownerId; run.research.heartbeatAt = now(); schedulePersist(run); }, T.heartbeatMs);
    try {
      // The first save happens under the lock, so a follow-up another view is already driving changes nothing.
      await persist(run);
      if (run.deleted) return 'deleted';
      if (prepare) await prepare(run);
      if (run.interrupted && !run.message.research.sessionId) { await finish(run, { status: 'stopped' }); return run.research.status; }
      await setStatus(run, 'running');
      const outcome = await follow(run);
      await finish(run, outcome);
    } catch (error) {
      if (run.deleted) return 'deleted';
      if (run.stopForced) await finish(run, { status: 'stopped' });
      else if (run.controller.signal.aborted) return 'detached';
      else if (error?.offline) await finish(run, { status: 'waiting', reason: 'connection', error: friendly(error), errorCode: error.code });
      else await finish(run, { status: 'failed', error: friendly(error), errorCode: typeof error?.code === 'string' ? error.code : undefined });
    } finally {
      clearInterval(run.heartbeat);
      clearTimeout(run.persistTimer);
      clearTimeout(run.stopTimer);
      run.persistTimer = null;
      if (runs.get(run.id) === run) runs.delete(run.id);
      await run.saving;
    }
    return run.research.status;
  }

  function start(run, prepare) {
    runs.set(run.id, run);
    const { acquired, done } = lockRun(run.id, () => drive(run, prepare));
    run.done = done.then(status => status ?? 'busy', error => { console.error(error); return 'failed'; });
    acquired.then(got => { if (!got && runs.get(run.id) === run) runs.delete(run.id); });
    return { acquired, done: run.done };
  }

  // Creates the session for a run that has none yet (a new run, or a follow-up whose session is gone or at its cap).
  async function prepareSession(run) {
    const research = run.research, settings = run.settings;
    let record = await ensureProvisioned({ resolved: run.resolved, client: run.client, storage, locks, now });
    const body = (current, override = true) => ({
      agent: override ? sessionAgent({ id: current.agentId, version: current.agentVersion, depth: settings.depth })
        : { type: 'agent', id: current.agentId, ...(Number.isInteger(current.agentVersion) ? { version: current.agentVersion } : {}) },
      environment_id: current.environmentId,
      title: oneLine(run.conversation.title, 500) || 'Still research',
      // At most 8 keys (the bundled docs' limit is lower than the live one).
      metadata: { app: 'still', item_id: String(research.itemId).slice(0, 512), conversation_id: run.id.slice(0, 512) },
      budget: budgetFor(settings.budgetUsd),
    });
    let session;
    try {
      session = await run.client.createSession(body(record));
    } catch (error) {
      if (missing(error)) {
        // The agent or the environment was archived or deleted in the Console: recreate what is gone, once.
        record = await ensureProvisioned({ resolved: run.resolved, client: run.client, storage, locks, now, verify: true });
        session = await run.client.createSession(body(record));
      } else if (error?.status === 400 && /effort|override|model/i.test(error.detail || '')) {
        // An effort this workspace cannot override: run at the agent's own model settings instead.
        session = await run.client.createSession(body(record, false));
      } else throw error;
    }
    if (typeof session?.id !== 'string' || !session.id) throw aiError('Anthropic did not return a research session.', { code: 'bad_response' });
    Object.assign(research, { sessionId: session.id, agentId: record.agentId, agentVersion: record.agentVersion ?? null });
    run.message.research.sessionId = session.id;
    run.message.research.baseline = 0;
    await persist(run);
  }

  // The first message of a session: the kickoff, rebuilt from the item as it is now.
  async function kickoffText(run, { continuation = null } = {}) {
    const library = await store.loadLibrary();
    const item = (library?.items || []).find(entry => entry?.id === run.research.itemId) || { id: run.research.itemId, title: run.conversation.title };
    return buildKickoff({ item, library, settings: run.settings, instructions: run.message.research.request?.text || '', allowOriginalEdits: run.research.allowOriginalEdits === true,
      today: now(), continuation });
  }
  function continuationOf(conversation, message) {
    const earlier = conversation.messages.filter(entry => entry.role === 'assistant' && entry !== message).map(entry => entry.text).filter(Boolean).join('\n\n');
    return { summary: earlier, subpages: (conversation.research.pages || []).map(page => ({ id: page.id, title: page.title })) };
  }
  // What a message still has to send (kickoff, follow-up or continuation), or null once it was sent.
  function pendingFor(run) {
    const meta = run.message.research;
    if (meta.sent === true) return null;
    const kind = meta.request?.kind || 'kickoff';
    run.sendKind = 'message';
    return async () => {
      const text = kind === 'followup' ? buildFollowUp({ text: meta.request?.text || '', today: now() })
        : await kickoffText(run, kind === 'continuation' ? { continuation: continuationOf(run.conversation, run.message) } : {});
      await run.client.sendEvents(meta.sessionId, [{ type: 'user.message', content: [{ type: 'text', text }] }]);
      meta.sent = true;
      await persist(run);
    };
  }

  function newAssistantMessage({ connectionId, sessionId = '', baseline = 0, request }) {
    return { id: uid('msg'), role: 'assistant', text: '', createdAt: now(), model: RESEARCH_MODEL, connectionId,
      research: { live: true, steps: [], subpages: [], writes: 0, sessionId, baseline, sent: false, messageIds: [], request } };
  }

  async function connectionFor(research) {
    try {
      const resolved = await resolveConnection(research.connectionId);
      if (isResearchConnection({ ...resolved.connection, hasKey: !!resolved.apiKey })) return resolved;
    } catch (error) { if (!['no_connection', 'disabled'].includes(error?.code)) throw error; }
    const { all } = await aiSettings();
    return resolveResearchConnection({ settings: all, listConnections, resolveConnection });
  }

  async function activeFor(itemId) {
    for (const summary of await conversations.listConversations()) {
      if (summary?.kind !== 'research' || summary.research?.itemId !== itemId || !ACTIVE.has(summary.research?.status)) continue;
      if (runs.has(summary.id)) return summary.id;
      const conversation = await conversations.getConversation(summary.id);
      if (conversation && fresh(conversation.research)) return summary.id;
    }
    return '';
  }

  // ---------- public API ----------

  /** { available, code?, reason?, connectionId? }: whether research can start here and with which connection. */
  async function researchAvailability() {
    if (!isExtension()) return { available: false, code: 'extension_only', reason: 'Research runs in the Still extension. It is not available in this preview.' };
    const { all, research } = await aiSettings();
    if (!research.enabled) return { available: false, code: 'disabled', reason: 'Research is turned off in AI settings.' };
    try {
      const chosen = pickResearchConnection(await listConnections(), all);
      if (!chosen) return { available: false, code: 'no_research_connection', reason: 'Add an Anthropic API key in AI settings to use research.' };
      return { available: true, connectionId: chosen.id };
    } catch (error) {
      return { available: false, code: typeof error?.code === 'string' ? error.code : 'error', reason: friendly(error) };
    }
  }

  /**
   * Starts researching a saved item. Resolves { conversationId, done } as soon as the conversation is saved; `done`
   * resolves with the final status. An item already being researched resolves { conversationId, existing: true }.
   * allowOriginalEdits: the user asked for the original to be changed (the setting of the same name also allows it).
   */
  async function startResearch({ itemId, instructions = '', allowOriginalEdits = false } = {}) {
    if (!isExtension()) throw aiError('Research runs in the Still extension. It is not available in this preview.', { code: 'extension_only' });
    const { all, research: settings } = await aiSettings();
    if (!settings.enabled) throw aiError('Research is turned off. Turn it on in AI settings.', { code: 'disabled' });
    if (typeof itemId !== 'string' || !itemId) throw aiError('Choose a saved page to research.', { code: 'bad_request' });
    let item;
    try { item = await readItem(store, itemId); } catch (error) { throw aiError(error.message, { code: 'not_found' }); }
    const existing = await activeFor(itemId);
    if (existing) return { conversationId: existing, existing: true, done: runs.get(existing)?.done || Promise.resolve('running') };
    const resolved = await resolveResearchConnection({ settings: all, listConnections, resolveConnection });
    const focus = typeof instructions === 'string' ? instructions.trim().slice(0, 4000) : '';
    const at = now();
    const title = oneLine(item.title, 180) || 'Untitled';
    const draft = {
      id: uid('conversation'), title: `Research: ${title}`, kind: 'research', createdAt: at, updatedAt: at,
      connectionId: resolved.connection.id, model: RESEARCH_MODEL, scope: { scope: 'item', ids: [itemId] },
      research: {
        itemId, sessionId: '', agentId: '', agentVersion: null, connectionId: resolved.connection.id, status: 'starting', startedAt: at, finishedAt: '',
        ownerId, heartbeatAt: at, error: '', allowOriginalEdits: allowOriginalEdits === true || settings.allowOriginalEdits === true,
        settings: { depth: settings.depth, maxSubpages: settings.maxSubpages, github: settings.github, budgetUsd: settings.budgetUsd },
        handled: {}, undo: { itemId, sectionText: '', subpageIds: [] }, pages: [], writes: 0,
      },
      messages: [
        { id: uid('msg'), role: 'user', text: focus ? `Research “${title}”\n\n${focus}` : `Research “${title}”`, createdAt: at, context: { scope: 'item', ids: [itemId] } },
        newAssistantMessage({ connectionId: resolved.connection.id, request: { kind: 'kickoff', text: focus } }),
      ],
    };
    const conversation = await conversations.saveConversation(draft);
    const run = createRun(conversation, { resolved, settings });
    run.pendingSend = pendingFor(run);
    const { done } = start(run, prepareSession);
    return { conversationId: conversation.id, done };
  }

  /**
   * A follow-up request in a research conversation. Uses the same session when it can; when the session is gone, was
   * ended, or is paused at its spending cap, starts a new one with a summary of the earlier work. Resolves
   * { conversationId, done }. Rejects with code 'busy' while the research is still running.
   */
  async function continueResearch(conversationId, text) {
    const request = typeof text === 'string' ? text.trim().slice(0, 4000) : '';
    if (runs.has(conversationId)) throw aiError('This research is still running. Stop it first, or wait for it to finish.', { code: 'busy' });
    const conversation = await loadConversation(conversationId);
    const research = conversation.research;
    if (ACTIVE.has(research.status) && fresh(research)) throw aiError('This research is still running in another Still window.', { code: 'busy' });
    // A bare follow-up only goes to a session that already got a message. A run stopped or failed before its kickoff
    // went out leaves a session that knows nothing about the page, so it gets the full kickoff instead (as a
    // continuation when an earlier session did work).
    const sentTo = sessionId => conversation.messages.some(entry => entry.role === 'assistant' && entry.research?.sent === true && (!sessionId || entry.research.sessionId === sessionId));
    const everSent = sentTo('');
    if (everSent && !request) throw aiError('Write what you want the research to look into next.', { code: 'bad_request' });
    const { research: current } = await aiSettings();
    if (!current.enabled) throw aiError('Research is turned off. Turn it on in AI settings.', { code: 'disabled' });
    const settings = normalizeResearchSettings({ ...current, ...(isObject(research.settings) ? research.settings : {}) });
    const resolved = await connectionFor(research);
    const client = clientFor(resolved);
    let reuse = !!research.sessionId && !research.budgetStopped && resolved.connection.id === research.connectionId
      && !(research.status === 'waiting' && research.reason === 'budget');
    if (reuse) {
      try { const session = await client.getSession(research.sessionId); if (!session || session.status === 'terminated' || session.archived_at) reuse = false; }
      catch (error) { if (missing(error)) reuse = false; else throw error; }
    }
    const kind = reuse && sentTo(research.sessionId) ? 'followup' : everSent ? 'continuation' : 'kickoff';
    // Retrying a kickoff that never went out (Try again, with no text or the same focus) keeps its focus and adds no
    // second request to the transcript: the request the user made is already there.
    const prevRequest = findAssistant(conversation)?.research?.request;
    const prevFocus = typeof prevRequest?.text === 'string' ? prevRequest.text.trim().slice(0, 4000) : '';
    const focus = kind === 'kickoff' ? (request || prevFocus) : request;
    const hasUserMessage = conversation.messages.some(entry => entry?.role === 'user');
    const at = now();
    if (!(kind === 'kickoff' && hasUserMessage && (!request || request === prevFocus))) {
      conversation.messages.push({ id: uid('msg'), role: 'user', text: focus, createdAt: at });
    }
    conversation.messages.push(newAssistantMessage({ connectionId: resolved.connection.id, sessionId: reuse ? research.sessionId : '', baseline: reuse ? null : 0,
      request: { kind, text: focus } }));
    Object.assign(research, { status: 'starting', error: '', finishedAt: '', connectionId: resolved.connection.id, ownerId, heartbeatAt: at, settings: { ...settings } });
    delete research.reason; delete research.errorCode; delete research.undoneAt; delete research.budgetStopped;
    const staleStop = clearStop(research);
    if (!reuse) research.sessionId = '';
    conversation.connectionId = resolved.connection.id;
    conversation.updatedAt = at;
    // Saved by drive() once it holds the run's lock.
    const run = createRun(conversation, { resolved, settings, staleStop });
    run.pendingSend = pendingFor(run);
    const { acquired, done } = start(run, reuse ? null : prepareSession);
    if (!(await acquired)) throw aiError('This research is already running in another Still window.', { code: 'busy' });
    return { conversationId, done };
  }

  /**
   * Picks up a research run this view is not driving (after a reload, or a stale owner): replays the session's history,
   * answers tool calls it still waits on (re-posting stored results, never re-applying writes) and follows it to the end.
   * Resolves { resumed, conversationId, reason?, done? }; reason is 'busy' (another view drives it), 'finished' or
   * 'budget' (use raiseResearchBudget).
   */
  async function resumeResearch(conversationId) {
    const active = runs.get(conversationId);
    if (active) return { resumed: true, conversationId, done: active.done };
    const conversation = await loadConversation(conversationId);
    const research = conversation.research;
    const message = findAssistant(conversation);
    const resumable = ACTIVE.has(research.status) || (research.status === 'waiting' && research.reason === 'connection');
    if (!resumable || !message) return { resumed: false, conversationId, reason: research.status === 'waiting' ? research.reason || 'waiting' : 'finished' };
    const resolved = await connectionFor(research);
    if (resolved.connection.id !== research.connectionId && message.research.sessionId) throw aiError('The Anthropic connection this research used is gone. Start the research again.', { code: 'no_research_connection' });
    delete research.undoneAt;
    const settings = normalizeResearchSettings(research.settings);
    const run = createRun(conversation, { resolved, settings });
    run.pendingSend = pendingFor(run);
    const { acquired, done } = start(run, message.research.sessionId ? null : prepareSession);
    if (!(await acquired)) return { resumed: false, conversationId, reason: 'busy' };
    return { resumed: true, conversationId, done };
  }

  async function requestStop(run) {
    if (run.stopSent) return;
    run.interrupted = true;
    run.stopSent = true;
    run.research.stopRequestedAt ||= now();
    const sessionId = run.message.research.sessionId;
    // A safety net: if the session never confirms the stop, the run ends here anyway.
    clearTimeout(run.stopTimer);
    run.stopTimer = setTimeout(() => { run.stopForced = true; run.controller.abort(new Error('Stopped.')); }, T.stopGraceMs);
    if (!sessionId || run.research.status === 'starting') { run.stopForced = true; run.controller.abort(new Error('Stopped.')); return; }
    try { await run.client.interrupt(sessionId); }
    catch (error) { if (missing(error)) { run.stopForced = true; run.controller.abort(new Error('Stopped.')); } }
  }

  /** Stops a research run (user.interrupt); its status becomes 'stopped'. Resolves { stopping } or { stopped: false, status }. */
  async function stopResearch(conversationId) {
    const run = runs.get(conversationId);
    if (run) { await requestStop(run); schedulePersist(run); return { stopping: true }; }
    const conversation = await loadConversation(conversationId);
    const research = conversation.research;
    if (!ACTIVE.has(research.status) && research.status !== 'waiting') return { stopped: false, status: research.status };
    research.stopRequestedAt = now();
    const owned = ACTIVE.has(research.status) && fresh(research);
    const atBudget = research.status === 'waiting' && research.reason === 'budget';
    if (atBudget) research.budgetStopped = true;
    if (research.sessionId && !atBudget) {
      try { await clientFor(await connectionFor(research)).interrupt(research.sessionId); } catch (error) { console.warn('[still] could not stop the research session', error); }
    }
    if (!owned) {
      // Nobody drives it (or it waits at its cap, where an interrupt is ignored): it simply ends here.
      research.status = 'stopped';
      research.finishedAt = now();
      delete research.reason;
      const message = findAssistant(conversation);
      if (message) { message.research.live = false; delete message.research.preview; message.error = 'Stopped'; }
    }
    conversation.updatedAt = now();
    await conversations.saveConversation(conversation);
    return { stopping: true };
  }

  /**
   * Raises (or lowers) the session's spending cap; a run paused at its cap continues. budgetUsd: 1 to 100, and above
   * what the session already spent (else code 'budget'). Resolves { raised: true, budgetUsd, done? }.
   */
  async function raiseResearchBudget(conversationId, budgetUsd) {
    const usd = Number(budgetUsd);
    if (!Number.isFinite(usd) || usd <= 0) throw aiError('Enter a spending cap in US dollars.', { code: 'bad_request' });
    const cap = Math.min(RESEARCH_LIMITS.maxRaiseUsd, Math.max(RESEARCH_LIMITS.minBudgetUsd, Math.round(usd * 100) / 100));
    const running = runs.get(conversationId);
    if (running) {
      await running.client.updateSession(running.message.research.sessionId, { budget: budgetFor(cap) });
      running.research.settings = { ...running.research.settings, budgetUsd: cap };
      delete running.research.undoneAt;
      schedulePersist(running);
      return { raised: true, budgetUsd: cap, done: running.done };
    }
    const conversation = await loadConversation(conversationId);
    const research = conversation.research;
    const message = findAssistant(conversation);
    if (!research.sessionId || !message?.research?.sessionId) throw aiError('This research has no session to continue. Start it again.', { code: 'bad_request' });
    const resolved = await connectionFor(research);
    if (resolved.connection.id !== research.connectionId) throw aiError('The Anthropic connection this research used is gone. Start the research again.', { code: 'no_research_connection' });
    // The cap changes first, so a refusal (below what was already spent) leaves the research exactly as it was.
    await clientFor(resolved).updateSession(research.sessionId, { budget: budgetFor(cap) });
    research.settings = { ...(isObject(research.settings) ? research.settings : {}), budgetUsd: cap };
    if (research.status !== 'waiting' || research.reason !== 'budget') { conversation.updatedAt = now(); await conversations.saveConversation(conversation); return { raised: true, budgetUsd: cap }; }
    // The run continues and may write again: an earlier undo no longer covers everything, so Undo is offered again.
    delete research.undoneAt;
    const settings = normalizeResearchSettings(research.settings);
    // Raising the cap continues the research, even when a stop request is what ran into the cap.
    const run = createRun(conversation, { resolved, settings, staleStop: clearStop(research) });
    run.expectResume = true;
    run.pendingSend = pendingFor(run);
    const { acquired, done } = start(run, null);
    if (!(await acquired)) return { raised: true, budgetUsd: cap };
    return { raised: true, budgetUsd: cap, done };
  }

  /**
   * Reverses what a research run wrote: removes its research section when it is still unchanged, moves its subpages to
   * the Trash (never deletes them), and restores the original when edit_original changed it and nobody edited it since.
   * Resolves { section: 'removed'|'changed'|'none', original: 'restored'|'changed'|'none', trashed: [ids], kept: [what] }.
   */
  async function undoResearch(conversationId) {
    if (runs.has(conversationId)) throw aiError('Stop the research before undoing its changes.', { code: 'busy' });
    const conversation = await loadConversation(conversationId);
    const research = conversation.research;
    if (ACTIVE.has(research.status) && fresh(research)) throw aiError('Stop the research before undoing its changes.', { code: 'busy' });
    if (research.undoneAt) return { section: 'none', original: 'none', trashed: [], kept: [], alreadyUndone: true };
    const undo = isObject(research.undo) ? research.undo : {};
    const itemId = undo.itemId || research.itemId;
    const result = { section: 'none', original: 'none', trashed: [], kept: [] };
    for (let attempt = 0; attempt < 2; attempt++) {
      let item = null;
      try { item = await readItem(store, itemId); } catch { break; }
      const patch = {};
      let content = typeof item.content === 'string' ? item.content : '';
      result.section = 'none'; result.original = 'none'; result.kept = [];
      if (undo.sectionText) {
        if (content.includes(undo.sectionText)) {
          const at = content.lastIndexOf(undo.sectionText);
          const before = content.slice(0, at).replace(/\s+$/, ''), after = content.slice(at + undo.sectionText.length).replace(/^\s+/, '');
          content = before && after ? `${before}\n\n${after}` : before || after;
          result.section = 'removed';
        } else { result.section = 'changed'; result.kept.push('section'); }
      }
      const written = typeof undo.originalWritten === 'string' ? undo.originalWritten.trim() : '';
      if ((undo.originalField === 'content' || undo.originalField === 'articleContent') && written) {
        const value = undo.originalField === 'content' ? content : typeof item.articleContent === 'string' ? item.articleContent : '';
        if (value.trim() === written) {
          if (undo.originalField === 'content') content = String(undo.originalText || '');
          else patch.articleContent = String(undo.originalText || '');
          result.original = 'restored';
        } else { result.original = 'changed'; result.kept.push('original'); }
      }
      if (content !== item.content) patch.content = content;
      if (!Object.keys(patch).length) break;
      try { await store.updateItem(itemId, patch, { expectedUpdatedAt: item.updatedAt }); break; }
      catch (error) { if (attempt === 0 && /^Conflict/.test(String(error?.message))) continue; throw error; }
    }
    // Subpages: the run's top-level pages first (the store moves their subpages to the Trash with them), then any left.
    const ids = Array.isArray(undo.subpageIds) ? undo.subpageIds.filter(id => typeof id === 'string') : [];
    const pages = Array.isArray(research.pages) ? research.pages : [];
    const roots = ids.filter(id => { const page = pages.find(entry => entry.id === id); return !page || page.parent === 'document' || !ids.includes(page.parent); });
    for (const group of [roots, ids]) {
      const library = await store.loadLibrary();
      for (const id of group) {
        const page = (library?.items || []).find(entry => entry?.id === id);
        if (!page || page.deletedAt || result.trashed.includes(id)) continue;
        try { await store.deleteItem(id); result.trashed.push(id); } catch (error) { console.warn('[still] could not move a research subpage to the Trash', error); }
      }
    }
    if (result.section === 'removed') undo.sectionText = '';
    if (result.original === 'restored') { delete undo.originalField; delete undo.originalText; delete undo.originalWritten; }
    if (result.trashed.length) {
      const removed = new Set(result.trashed);
      for (let added = true; added;) {
        added = false;
        for (const page of pages) if (page?.id && !removed.has(page.id) && removed.has(page.parent)) { removed.add(page.id); added = true; }
      }
      if (Array.isArray(undo.subpageIds)) undo.subpageIds = undo.subpageIds.filter(id => !removed.has(id));
      if (Array.isArray(research.pages)) research.pages = research.pages.filter(page => !removed.has(page?.id));
    }
    research.undoneAt = now();
    research.undoResult = { ...result };
    conversation.updatedAt = now();
    await conversations.saveConversation(conversation);
    return result;
  }

  /** Live in-page events for runs this view drives: listener({ type: 'research', conversationId, status, conversation, message }). */
  function subscribeResearch(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Forgets this device's research agent and environment ids; the next run creates new ones. Remote resources stay. */
  const resetResearchProvisioning = () => forgetProvisioning({ storage, locks });

  /** Stops driving every run in this view without changing them (tests, page teardown); sessions keep their state. */
  function dispose() {
    for (const run of runs.values()) run.controller.abort(new Error('Detached.'));
  }

  return { researchAvailability, startResearch, continueResearch, resumeResearch, stopResearch, raiseResearchBudget, undoResearch, subscribeResearch,
    resetResearchProvisioning, dispose, ownerId, isDriving: id => runs.has(id) };
}
