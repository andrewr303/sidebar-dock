// Claude Managed Agents (beta) over plain fetch, for the research agent. Extension pages only: these endpoints send no
// CORS headers, so a call works only from a page holding host access to https://api.anthropic.com/* (content scripts and
// the localhost preview cannot use them). Wire format: research/2026-11-01-capture-research-agent/maps/managed-agents-wire.md.
//
// Errors are the same friendly, redacted errors providerFetch raises for chat (codes auth, rate_limit, provider_down,
// workspace_required, permission, not_found, bad_request, network, timeout), so the assistant's error handling and its
// "Open AI settings" action keep working. Two additions: `budget` (a 400 about the session's spending cap) and
// `stream_idle` (the event stream went quiet; reconnect).

import { getProvider } from '../catalog.js';
import { aiError, providerFetch, readJsonBody, streamError } from '../http.js';
import { abortError, readSse } from '../stream.js';
import { headersFor } from '../transports/anthropic.js';

export const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';
// No bytes at all (heartbeats included) for this long means the connection is dead even if the socket is not.
export const STREAM_IDLE_MS = 90000;
const STREAM_HEADERS_MS = 30000;
const MAX_HISTORY_PAGES = 200;

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const segment = value => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 200) throw aiError('That research session reference is not valid.', { code: 'bad_request' });
  return encodeURIComponent(text);
};

/**
 * Headers for every Managed Agents call: the Anthropic transport's headers WITHOUT a model (so no fallback beta is
 * added), plus the managed-agents beta. The key, version, browser-access and workspace headers come from headersFor.
 */
export function managedHeaders({ baseUrl, apiKey, connection }, { stream = false } = {}) {
  const headers = { ...headersFor({ baseUrl, apiKey, connection }), 'anthropic-beta': MANAGED_AGENTS_BETA, 'content-type': 'application/json' };
  if (stream) headers.accept = 'text/event-stream';
  return headers;
}

const NOT_FOUND = {
  agent: 'The research agent is missing from your Anthropic workspace.',
  environment: 'The research environment is missing from your Anthropic workspace.',
  session: 'This research session no longer exists in your Anthropic account.',
};

// Rewrites a provider error for Managed Agents: a 404 names the missing resource instead of "check the base URL", and a
// 400 about the spending cap gets its own code so the UI can offer to raise it. A 409 (agent version mismatch) keeps
// code bad_request; callers check error.status.
function managedError(error, what) {
  if (!error || typeof error !== 'object' || error.code === 'aborted') return error;
  if (error.status === 404 && NOT_FOUND[what]) { error.message = NOT_FOUND[what]; error.resource = what; }
  else if (error.status === 400 && /budget/i.test(error.detail || '')) {
    error.code = 'budget';
    error.message = /greater than/i.test(error.detail) ? 'Choose a spending cap above what this research has already spent.' : 'This research reached its spending cap.';
  }
  return error;
}

/**
 * A Managed Agents client for one resolved direct Anthropic connection ({ apiKey, baseUrl, connection, provider } from
 * resolveConnection). fetchImpl is injectable for tests. Every method rejects with a friendly error (see above).
 */
export function createManagedClient({ apiKey, baseUrl, connection = null, provider = getProvider('anthropic'), fetchImpl } = {}) {
  if (!apiKey) throw aiError('Add your Anthropic API key in AI settings to use research.', { code: 'auth' });
  const root = String(baseUrl || provider?.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
  const secrets = [apiKey];
  const base = { provider, secrets, fetch: fetchImpl };

  async function call(method, path, { body, signal, what = '', query = null } = {}) {
    const search = query ? `?${query}` : '';
    try {
      const response = await providerFetch(`${root}${path}${search}`, { ...base, method, body, signal, headers: managedHeaders({ baseUrl: root, apiKey, connection }) });
      if (response.status === 204) return null;
      return await readJsonBody(response, { signal });
    } catch (error) { throw managedError(error, what); }
  }

  const createAgent = (body, options = {}) => call('POST', '/agents', { ...options, body, what: 'agent' });
  // `version` (optional) is optimistic concurrency: a mismatch is a 409 (error.status); re-read and retry.
  const updateAgent = (id, body, { version, signal } = {}) => call('POST', `/agents/${segment(id)}`, { signal, what: 'agent', body: Number.isInteger(version) && version >= 1 ? { ...body, version } : body });
  const getAgent = (id, options = {}) => call('GET', `/agents/${segment(id)}`, { ...options, what: 'agent' });
  const createEnvironment = (body, options = {}) => call('POST', '/environments', { ...options, body, what: 'environment' });
  const getEnvironment = (id, options = {}) => call('GET', `/environments/${segment(id)}`, { ...options, what: 'environment' });
  const createSession = (body, options = {}) => call('POST', '/sessions', { ...options, body, what: 'session' });
  const getSession = (id, options = {}) => call('GET', `/sessions/${segment(id)}`, { ...options, what: 'session' });
  // title, metadata and budget ({ budget } changes or removes the cap; an accepted change resumes a session paused at it).
  const updateSession = (id, body, options = {}) => call('POST', `/sessions/${segment(id)}`, { ...options, body, what: 'session' });
  const sendEvents = (id, events, options = {}) => call('POST', `/sessions/${segment(id)}/events`, { ...options, body: { events }, what: 'session' });
  // Jumps the queue and forces the session idle; the interrupted turn still ends with stop_reason end_turn.
  const interrupt = (id, options = {}) => sendEvents(id, [{ type: 'user.interrupt' }], options);

  /** One page of history: { data: [events], next_page }. order 'asc' is chronological. */
  async function listEvents(id, { page = '', limit = 1000, order = 'asc', signal } = {}) {
    const query = new URLSearchParams({ limit: String(limit), order });
    if (page) query.set('page', page);
    const result = await call('GET', `/sessions/${segment(id)}/events`, { signal, what: 'session', query: query.toString() });
    return { data: Array.isArray(result?.data) ? result.data.filter(isObject) : [], next_page: typeof result?.next_page === 'string' && result.next_page ? result.next_page : null };
  }

  // Every event in the session, oldest first, following next_page.
  async function* listAllEvents(id, { signal, limit = 1000 } = {}) {
    let page = '';
    const pages = new Set();
    for (let count = 0; count < MAX_HISTORY_PAGES; count++) {
      const result = await listEvents(id, { page, limit, signal });
      for (const event of result.data) yield event;
      if (!result.next_page || pages.has(result.next_page)) return;
      pages.add(result.next_page);
      page = result.next_page;
    }
  }

  /**
   * Live events from GET /sessions/{id}/events/stream as parsed objects: `for await (const event of stream)`. The
   * returned object's `opened` promise settles once the response headers arrive, so a caller can open the stream FIRST,
   * then read history, then send (the stream never replays). Skips pings and frames that are not typed JSON, throws on
   * an in-band `error` frame, throws a reconnectable `stream_idle` error when no bytes arrive for idleMs, and ends
   * normally at EOF (the caller reconnects). deltas: event types to preview (`agent.message`, `agent.thinking`), which
   * arrive as event_start / event_delta frames without an id of their own.
   */
  function streamEvents(id, { signal, deltas = ['agent.message'], idleMs = STREAM_IDLE_MS } = {}) {
    const query = new URLSearchParams();
    for (const type of deltas) if (type === 'agent.message' || type === 'agent.thinking') query.append('event_deltas[]', type);
    const search = query.toString();
    const url = `${root}/sessions/${segment(id)}/events/stream${search ? `?${search}` : ''}`;
    const watchdog = new AbortController();
    const linked = signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal;
    let timer = null, finished = false;
    const kick = () => { if (finished) return; clearTimeout(timer); timer = setTimeout(() => watchdog.abort(new Error('idle stream')), idleMs); };
    const stop = () => { finished = true; clearTimeout(timer); };
    // A stream that is opened but never read (the history already ended the run) must not keep its watchdog alive.
    signal?.addEventListener('abort', stop, { once: true });
    const translate = error => {
      if (watchdog.signal.aborted && !signal?.aborted) return aiError('The research stream went quiet. Reconnecting.', { code: 'stream_idle', reconnect: true });
      if (signal?.aborted) return abortError(signal);
      return error;
    };
    const response = (async () => {
      try {
        const opened = await providerFetch(url, { ...base, signal: linked, timeoutMs: STREAM_HEADERS_MS, headers: managedHeaders({ baseUrl: root, apiKey, connection }, { stream: true }) });
        if (!opened.body?.getReader) throw aiError('Anthropic returned no event stream.', { code: 'network', reconnect: true });
        kick();
        return opened;
      } catch (error) { stop(); throw translate(managedError(error, 'session')); }
    })();
    const opened = response.then(() => true);
    // Marked handled here; whoever awaits `opened` or iterates still sees the rejection.
    response.catch(() => {});
    opened.catch(() => {});

    async function* frames() {
      try {
        const body = await response;
        // Any bytes (comments and heartbeats included) prove the connection is alive, so the watchdog is fed per chunk.
        const reader = body.body.getReader();
        const tapped = { body: { getReader: () => ({ read: async () => { const step = await reader.read(); kick(); return step; },
          cancel: reason => reader.cancel(reason), releaseLock: () => reader.releaseLock() }) } };
        for await (const frame of readSse(tapped, { signal: linked })) {
          if (frame.event === 'ping') continue;
          let event = null;
          try { event = JSON.parse(frame.data); } catch { event = null; }
          if (frame.event === 'error' || event?.type === 'error') {
            throw streamError({ type: event?.error?.type || '', message: event?.error?.message || '', provider, secrets });
          }
          if (!isObject(event) || typeof event.type !== 'string' || event.type === 'ping') continue;
          // The bundled docs once printed `status_idle`; the real type is `session.status_idle`.
          if (event.type === 'status_idle') event.type = 'session.status_idle';
          yield event;
        }
      } catch (error) {
        throw translate(error);
      } finally {
        stop();
      }
    }
    const iterator = frames();
    return { opened, [Symbol.asyncIterator]: () => iterator, next: value => iterator.next(value), return: value => iterator.return(value) };
  }

  return { createAgent, updateAgent, getAgent, createEnvironment, getEnvironment, createSession, getSession, updateSession, sendEvents, interrupt,
    listEvents, listAllEvents, streamEvents };
}
