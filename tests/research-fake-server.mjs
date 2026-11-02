// A scripted stand-in for the Claude Managed Agents API (agents, environments, sessions, events, the SSE stream) for the
// research engine tests. Events are persisted with sevt_ ids, echoed on open streams and served by the paginated history
// endpoint; streams are written in small byte chunks so frames split across reads. `script(context)` runs after every
// batch of user events and emits the agent's side of the session (asynchronously, like the real service).

export const KEY = 'sk-ant-api03-RESEARCHKEY-0123456789';
const encoder = new TextEncoder();
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

export function sseFrame(event, { named = true } = {}) {
  return `${named ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`;
}

/** A Response whose body is the given text, delivered in `size`-byte chunks; hold keeps it open. */
export function chunkedResponse(text, { size = 7, hold = false, status = 200, headers = {} } = {}) {
  const bytes = encoder.encode(text);
  const body = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.subarray(i, i + size)); if (!hold) controller.close(); } });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream', ...headers } });
}

export const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

export function fakeManagedAgents({ chunkSize = 5, pageSize = 4, script = null } = {}) {
  let counter = 0;
  const nextId = prefix => `${prefix}_${String(++counter).padStart(4, '0')}`;
  const server = {
    calls: [], agents: new Map(), environments: new Map(), sessions: new Map(), failures: [], script, chunkSize, pageSize,
    streamOpens: 0, events: [],
  };
  const stamp = () => new Date().toISOString();

  function sessionOf(id) {
    const session = server.sessions.get(id);
    if (!session) throw Object.assign(new Error('missing'), { status: 404 });
    return session;
  }

  // Persists (unless stream-only) and broadcasts one event.
  function emit(sessionId, event, { persist = true } = {}) {
    const session = sessionOf(sessionId);
    const full = persist ? { id: nextId('sevt'), processed_at: stamp(), ...event } : event;
    if (persist) session.events.push(full);
    if (full.type === 'session.status_running') session.status = 'running';
    if (full.type === 'session.status_idle') session.status = 'idle';
    if (full.type === 'session.status_terminated') session.status = 'terminated';
    for (const stream of [...session.streams]) stream.push(full);
    return full;
  }

  function openStream(session) {
    let controller;
    const handle = {
      push(event) {
        const bytes = encoder.encode(sseFrame(event));
        for (let i = 0; i < bytes.length; i += server.chunkSize) { try { controller.enqueue(bytes.subarray(i, i + server.chunkSize)); } catch {} }
      },
      raw(text) { try { controller.enqueue(encoder.encode(text)); } catch {} },
      close() { session.streams.delete(handle); try { controller.close(); } catch {} },
    };
    const body = new ReadableStream({ start(c) { controller = c; }, cancel() { session.streams.delete(handle); } });
    session.streams.add(handle);
    server.streamOpens++;
    // A heartbeat comment and a ping frame first: both must be skipped.
    handle.raw(': heartbeat\n\nevent: ping\ndata: {"type":"ping"}\n\n');
    return { handle, response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }) };
  }

  // The agent's side: runs after the client posted events (and after a budget change).
  async function react(session, posted) {
    if (typeof server.script !== 'function') return;
    await tick();
    await server.script({ session, posted, emit: (event, options) => emit(session.id, event, options), server, tick });
  }

  function failure(call) {
    const index = server.failures.findIndex(entry => entry.method === call.method && entry.match.test(call.path));
    if (index < 0) return null;
    const entry = server.failures[index];
    if (--entry.times <= 0) server.failures.splice(index, 1);
    return typeof entry.response === 'function' ? entry.response(call) : entry.response;
  }

  server.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const call = { url: String(url), method: options.method || 'GET', path: parsed.pathname.replace(/^\/v1/, ''), query: parsed.searchParams, headers: { ...(options.headers || {}) },
      body: typeof options.body === 'string' && options.body ? JSON.parse(options.body) : null, signal: options.signal };
    server.calls.push(call);
    if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const injected = failure(call);
    if (injected) { if (injected instanceof Error) throw injected; return injected.clone ? injected.clone() : injected; }
    const { method, path, body } = call;
    let match;
    if (method === 'POST' && path === '/environments') {
      const environment = { type: 'environment', id: nextId('env'), ...body, created_at: stamp(), archived_at: null };
      server.environments.set(environment.id, environment);
      return json(environment);
    }
    if ((match = /^\/environments\/([^/]+)$/.exec(path)) && method === 'GET') {
      const environment = server.environments.get(match[1]);
      return environment ? json(environment) : json({ type: 'error', error: { type: 'not_found_error', message: 'Environment not found' } }, 404);
    }
    if (method === 'POST' && path === '/agents') {
      const agent = { type: 'agent', id: nextId('agent'), version: 1, ...body, model: { id: body.model, effort: { type: 'high' }, speed: 'standard' }, multiagent: null, archived_at: null };
      server.agents.set(agent.id, agent);
      return json(agent);
    }
    if ((match = /^\/agents\/([^/]+)$/.exec(path))) {
      const agent = server.agents.get(match[1]);
      if (!agent) return json({ type: 'error', error: { type: 'not_found_error', message: 'Agent not found' } }, 404);
      if (method === 'GET') return json(agent);
      if (body.version !== undefined && body.version !== agent.version) return json({ type: 'error', error: { type: 'invalid_request_error', message: 'Version mismatch' } }, 409);
      const { version, ...rest } = body;
      Object.assign(agent, rest, { version: agent.version + 1, model: { id: rest.model || agent.model.id, effort: { type: 'high' }, speed: 'standard' } });
      return json(agent);
    }
    if (method === 'POST' && path === '/sessions') {
      const agentId = typeof body.agent === 'string' ? body.agent : body.agent?.id;
      if (!server.agents.has(agentId) || !server.environments.has(body.environment_id)) return json({ type: 'error', error: { type: 'not_found_error', message: 'Agent or environment not found' } }, 404);
      const session = { type: 'session', id: nextId('sesn'), status: 'idle', title: body.title, metadata: body.metadata, budget: body.budget, agentRef: body.agent,
        environment_id: body.environment_id, events: [], streams: new Set(), usage: { input_tokens: 10, output_tokens: 20, list_cost: { amount: '37', currency: 'USD' }, server_tool_use: { web_search_requests: 2 } } };
      server.sessions.set(session.id, session);
      const { events, streams, agentRef, ...visible } = session;
      return json(visible);
    }
    if ((match = /^\/sessions\/([^/]+)$/.exec(path))) {
      const session = server.sessions.get(match[1]);
      if (!session) return json({ type: 'error', error: { type: 'not_found_error', message: 'Session not found' } }, 404);
      if (method === 'GET') { const { events, streams, agentRef, ...visible } = session; return json(visible); }
      if ('budget' in body) {
        session.budget = body.budget;
        emit(session.id, { type: 'session.updated', budget: body.budget });
        react(session, [{ type: 'budget', budget: body.budget }]);
      }
      const { events, streams, agentRef, ...visible } = session;
      return json(visible);
    }
    if ((match = /^\/sessions\/([^/]+)\/events\/stream$/.exec(path)) && method === 'GET') {
      const session = server.sessions.get(match[1]);
      if (!session) return json({ type: 'error', error: { type: 'not_found_error', message: 'Session not found' } }, 404);
      const { handle, response } = openStream(session);
      options.signal?.addEventListener('abort', () => handle.close(), { once: true });
      return response;
    }
    if ((match = /^\/sessions\/([^/]+)\/events$/.exec(path))) {
      const session = server.sessions.get(match[1]);
      if (!session) return json({ type: 'error', error: { type: 'not_found_error', message: 'Session not found' } }, 404);
      if (method === 'GET') {
        const start = Number(call.query.get('page') || 0);
        const size = server.pageSize;
        const data = session.events.slice(start, start + size);
        return json({ data, next_page: start + size < session.events.length ? String(start + size) : null });
      }
      const posted = [];
      for (const event of body.events || []) {
        const persisted = event.type === 'user.interrupt' && session.atBudget ? null : emit(session.id, { ...event });
        if (persisted) posted.push(persisted);
        server.events.push(event);
      }
      react(session, posted);
      return json({ data: posted });
    }
    return json({ type: 'error', error: { type: 'not_found_error', message: `No route ${method} ${path}` } }, 404);
  };

  /** Fails the next `times` calls matching method + path regex with `response` (a Response, a function, or an Error to throw). */
  server.failNext = (method, match, response, times = 1) => { server.failures.push({ method, match, response, times }); };
  /** Ends every open stream for a session (EOF): the client must reconnect and consolidate. */
  server.dropStreams = sessionId => { for (const stream of [...sessionOf(sessionId).streams]) stream.close(); };
  server.emit = emit;
  server.session = sessionOf;
  server.posted = (type, sessionId) => server.calls.filter(call => call.method === 'POST' && /\/events$/.test(call.path) && (!sessionId || call.path.includes(sessionId)))
    .flatMap(call => call.body.events).filter(event => !type || event.type === type);
  return server;
}

/** A turn: emits events one by one with a macrotask between, like a live session. */
export async function play(emit, events, tickFn = tick) {
  const emitted = [];
  for (const event of events) { await tickFn(); emitted.push(emit(event.event || event, event.options)); }
  return emitted;
}
