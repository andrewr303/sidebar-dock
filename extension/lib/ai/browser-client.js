// The assistant's side of the browser port. One client talks to the service worker's browser host
// (lib/browser/host.js) for one conversation's turn: it opens a session, runs the layer's tools in it, passes the
// host's prompts to the UI and returns the answers.
//
// The service worker can stop while no tab is attached (a model call can take longer than Chrome keeps an idle worker)
// and the port then closes. The client opens the session again before the next call and shares the tabs it knew, so the
// turn goes on; refs from before are gone, and the caller is told so (`reconnected`).
import { BROWSER_PORT } from '../browser/protocol.js';

/** How often an open session writes to the port, so the worker stays awake during a model call. */
const PING_MS = 20_000;

export class BrowserClientError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BrowserClientError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * createBrowserClient({ connect, pingMs }) ->
 *   { status(), open(params), call(tool, args, { signal }), state(), share(tabId), setPolicy(policy), close(),
 *     onPrompt(handler), onWithdrawn(handler), onTabs(handler), isOpen, connected }
 * connect(): a chrome.runtime port to the browser host. onPrompt(handler): handler({ promptId, type, request }) resolves
 * to the person's answer ('approve' | 'approve-remember' | 'decline' for a confirmation, { outcome: 'continue', data? } or
 * { outcome: 'cancel' } for a hand-over); a handler that throws, or no handler, declines.
 */
export function createBrowserClient({ connect = () => globalThis.chrome.runtime.connect({ name: BROWSER_PORT }), pingMs = PING_MS } = {}) {
  let port = null;
  let counter = 0;
  let timer = null;
  /** The open session: what it was opened with and the tabs it holds, for opening it again after a worker restart. */
  let session = null;
  const waiting = new Map();
  const handlers = { prompt: null, withdrawn: null, tabs: null };

  const stopPing = () => { if (timer) { clearInterval(timer); timer = null; } };
  const startPing = () => {
    stopPing();
    if (!(pingMs > 0)) return;
    timer = setInterval(() => { try { port?.postMessage({ kind: 'ping' }); } catch { /* The port is closing. */ } }, pingMs);
    timer?.unref?.();
  };

  const remember = state => {
    if (session && Array.isArray(state?.tabs)) session.tabIds = new Set(state.tabs.map(tab => tab.tabId).filter(Number.isInteger));
  };

  async function answerPrompt(source, message) {
    let answer = message.type === 'confirm' ? 'decline' : { outcome: 'cancel' };
    try {
      if (handlers.prompt) answer = await handlers.prompt({ promptId: message.promptId, type: message.type, request: message.request });
    } catch (error) { console.error(error); }
    // The port may have changed while the person decided: an answer to an old port has no card to reach.
    if (port === source) try { source.postMessage({ kind: 'answer', promptId: message.promptId, answer }); } catch { /* Closed. */ }
  }

  function onMessage(source, message) {
    if (!message || typeof message !== 'object' || port !== source) return;
    if (message.kind === 'response') {
      const entry = waiting.get(message.id);
      if (!entry) return;
      waiting.delete(message.id);
      entry.settle();
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new BrowserClientError(String(message.error?.code || 'internal'), String(message.error?.message || 'The browser could not be reached.'),
        Array.isArray(message.error?.permissions) ? { permissions: message.error.permissions } : {}));
    } else if (message.kind === 'prompt') {
      answerPrompt(source, message);
    } else if (message.kind === 'prompt-withdrawn') {
      try { handlers.withdrawn?.(message.promptId); } catch (error) { console.error(error); }
    } else if (message.kind === 'tabs') {
      remember(message.state);
      try { handlers.tabs?.(message.state); } catch (error) { console.error(error); }
    }
  }

  function attach() {
    if (port) return port;
    const next = connect();
    port = next;
    next.onMessage.addListener(message => onMessage(next, message));
    next.onDisconnect.addListener(() => {
      if (port !== next) return;
      port = null;
      stopPing();
      for (const [id, entry] of [...waiting]) {
        waiting.delete(id);
        entry.settle();
        entry.reject(new BrowserClientError('disconnected', 'The connection to the browser closed.'));
      }
    });
    return next;
  }

  function request(method, params, { signal } = {}) {
    const target = attach();
    const id = `q${++counter}`;
    return new Promise((resolve, reject) => {
      // Stop reaches the worker as a cancel: the layer ends the call and answers with what happened.
      const onAbort = () => { try { target.postMessage({ kind: 'cancel', id }); } catch { /* Closed. */ } };
      waiting.set(id, { resolve, reject, settle: () => signal?.removeEventListener?.('abort', onAbort) });
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        target.postMessage({ kind: 'request', id, method, params });
        if (signal?.aborted) onAbort();
      } catch (error) {
        waiting.delete(id);
        signal?.removeEventListener?.('abort', onAbort);
        reject(new BrowserClientError('disconnected', `The browser could not be reached: ${error?.message || error}`));
      }
    });
  }

  async function open(params = {}) {
    const result = await request('open', params);
    session = { params: { ...params, startTabId: undefined }, tabIds: new Set() };
    remember(result.state);
    startPing();
    return result;
  }

  /** Opens the session again after the port closed, with the tabs it held. */
  async function reopen() {
    const { params, tabIds } = session;
    const result = await request('open', params);
    session = { params, tabIds: new Set() };
    for (const tabId of tabIds) {
      // A tab that closed or moved to a blocked site meanwhile stays out; the model sees the tab list.
      await request('share', { tabId }).then(shared => remember(shared.state), () => undefined);
    }
    if (!tabIds.size) remember(result.state);
    startPing();
  }

  async function call(tool, args, { signal } = {}) {
    if (!session) throw new BrowserClientError('not_open', 'Open a browser session first.');
    let reconnected = false;
    if (!port) { await reopen(); reconnected = true; }
    try {
      const answer = await request('call', { tool, args }, { signal });
      remember(answer.state);
      return { result: answer.result, state: answer.state || null, reconnected };
    } catch (error) {
      if (error?.code !== 'disconnected') throw error;
      // The worker stopped while the call ran: whether its input reached the page is not known.
      throw new BrowserClientError('interrupted', 'The browser connection restarted during this call.');
    }
  }

  async function state() {
    if (!session) throw new BrowserClientError('not_open', 'Open a browser session first.');
    if (!port) await reopen();
    const value = await request('state');
    remember(value);
    return value;
  }

  async function share(tabId) {
    if (!session) throw new BrowserClientError('not_open', 'Open a browser session first.');
    if (!port) await reopen();
    const result = await request('share', { tabId });
    remember(result.state);
    return result;
  }

  async function setPolicy(policy) {
    if (session) session.params = { ...session.params, policy };
    if (!port || !session) return { ok: true };
    return request('policy', { policy });
  }

  async function close() {
    const current = port;
    session = null;
    stopPing();
    if (!current) return;
    // Ask first so the worker ends the session before the port goes; a worker that is gone has nothing to end.
    await Promise.race([request('close').catch(() => undefined), new Promise(resolve => { const wait = setTimeout(resolve, 1000); wait?.unref?.(); })]);
    port = null;
    for (const [id, entry] of [...waiting]) { waiting.delete(id); entry.settle(); entry.reject(new BrowserClientError('disconnected', 'The browser session was closed.')); }
    try { current.disconnect(); } catch { /* Already closed. */ }
  }

  return {
    status: () => request('status'),
    open, call, state, share, setPolicy, close,
    onPrompt(handler) { handlers.prompt = handler; },
    onWithdrawn(handler) { handlers.withdrawn = handler; },
    onTabs(handler) { handlers.tabs = handler; },
    get isOpen() { return !!session; },
    get connected() { return !!port; },
  };
}
