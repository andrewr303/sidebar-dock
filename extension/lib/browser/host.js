// The browser automation host: the one place in the extension that holds the browser control layer
// (lib/browser-control/layer.js). It lives in the service worker, which has chrome.debugger and timers that are not
// slowed down when a page is hidden, and it answers the assistant's pages over a port. The assistant's loop stays in the
// page (lib/ai/assistant.js); only observing and acting happen here.
//
// Who may connect: this extension's own pages. A content script carries the extension's id too, so the sender's address
// is checked. There is no message from outside the extension that reaches this file: the bridge and its MCP server have
// no path to the layer, and the manifest declares no externally connectable page.
//
// One port is one session of the layer: a set of tabs, the refs shown to the model, and the person's rules.
//
// Page to worker, on a port named BROWSER_PORT:
//   { kind: 'request', id, method, params }      answered by { kind: 'response', id, ok: true, result }
//                                                 or { kind: 'response', id, ok: false, error: { code, message, permissions? } }
//   { kind: 'cancel', id }                        stops the request with that id (a running tool call is aborted)
//   { kind: 'answer', promptId, answer }          the person's answer to a prompt
//   { kind: 'ping' }                              keeps the worker awake while a model call is in flight
// Worker to page:
//   { kind: 'prompt', promptId, type: 'confirm' | 'ask', request }   a card to show; see ConfirmRequest and AskRequest
//   { kind: 'prompt-withdrawn', promptId }                           the wait ended; a late answer has no effect
//   { kind: 'tabs', state }                                          the session's tabs changed
//
// Methods:
//   status()                                -> { available, missing: [permission], reason? }   never loads the layer
//   open({ policy, reveal, startTabId })    -> { sessionId, epoch, state, startTab? }
//   call({ tool, args })                    -> { result, state }     result is the layer's Result, as plain data
//   state()                                 -> { tabs: [{ tabId, url, title, active, rev, pending }], activeTabId }
//   share({ tabId })                        -> { state }
//   policy({ policy })                      -> { ok: true }
//   close()                                 -> { ok: true }
// Closing the port closes the session: calls are aborted, open prompts are withdrawn and the debugger leaves the tabs.
import { BROWSER_PERMISSIONS, blockedSites, decideWrite, normalizeBrowserSettings, withSiteRule } from './settings.js';

export const BROWSER_PORT = 'still.browser.v1';
/** The layer tools a page may call. `upload` and `watch_download` are left out: the assistant has no file attachments yet. */
export const HOST_TOOLS = Object.freeze(['snapshot', 'find', 'read', 'screenshot', 'click', 'set', 'fill_form', 'type', 'press', 'hover', 'scroll', 'wait',
  'navigate', 'tabs', 'handle_dialog', 'ask_user']);
/** What the layer is told to keep an outline or a read to, so it cuts a long result itself and says so. */
export const RESULT_BUDGET = 7000;
/** A step handed to the person waits this long: they may be in another window. */
export const ASK_TIMEOUT_MS = 15 * 60_000;
/** The assistant's own labels. Page text that imitates them is defused by the layer before the model reads it. */
export const NOTE_LABELS = Object.freeze(['[Still note', 'browser-state', 'assistant-notes']);

const CONFIRM_ANSWERS = ['approve', 'approve-remember', 'decline'];
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

class HostError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * createBrowserHost({ api, loadLayer, isContentSender }) -> { connect(port), status() }
 * api: chrome. loadLayer(): the layer module (loadBrowserControl of the generated bundle). isContentSender(sender): true
 * for a content script, which may not connect.
 */
export function createBrowserHost({ api = globalThis.chrome, loadLayer, isContentSender = () => false } = {}) {
  /** One controller for the worker's lifetime, made when a page first opens a session. */
  let ready = null;
  const sessions = new Set();
  let promptCount = 0;

  async function missingPermissions() {
    const missing = [];
    for (const permission of BROWSER_PERMISSIONS) {
      let granted = false;
      try { granted = (await api.permissions?.contains?.({ permissions: [permission] })) === true; } catch { granted = false; }
      if (!granted) missing.push(permission);
    }
    return missing;
  }

  async function status() {
    if (!api?.debugger?.sendCommand) return { available: false, missing: [], reason: 'This build of Still cannot control the browser.' };
    const missing = await missingPermissions();
    return { available: missing.length === 0, missing };
  }

  function controller() {
    ready ||= (async () => {
      const layer = await loadLayer();
      return { layer, controller: await layer.createChromeController({ prompt }) };
    })();
    // A failed start is tried again by the next session.
    ready.catch(() => { ready = null; });
    return ready;
  }

  const post = (state, message) => {
    if (state.closed) return;
    try { state.port.postMessage(message); } catch { /* The page went away; its disconnect cleans up. */ }
  };

  // ---------------------------------------------------------------------------------------------------- prompts
  // The layer asks through one object for every session. The card goes to the page whose session holds the tab; while
  // a call is running on that tab it is that call's session.
  function holderOf(tabId) {
    const holders = [...sessions].filter(state => state.session?.hasTab(tabId));
    return holders.find(state => state.calls.size) || holders[0] || null;
  }

  function openPrompt(type, request, signal, fallback, shape) {
    const state = holderOf(request.tabId);
    if (!state || signal?.aborted) return Promise.resolve(fallback);
    return new Promise(resolve => {
      const promptId = `p${++promptCount}`;
      const finish = answer => {
        if (!state.prompts.delete(promptId)) return;
        signal?.removeEventListener?.('abort', withdraw);
        resolve(answer);
      };
      // The wait ended without an answer (Stop, a timeout, the tab or the page closed): the card goes away.
      const withdraw = () => {
        if (!state.prompts.has(promptId)) return;
        post(state, { kind: 'prompt-withdrawn', promptId });
        finish(fallback);
      };
      state.prompts.set(promptId, { type, request, finish, withdraw });
      signal?.addEventListener?.('abort', withdraw, { once: true });
      Promise.resolve(shape(request)).then(shown => {
        if (state.prompts.has(promptId)) post(state, { kind: 'prompt', promptId, type, request: shown });
      }, withdraw);
    });
  }

  const prompt = {
    confirm: (request, signal) => openPrompt('confirm', request, signal, 'decline', value => ({
      id: value.id, tabId: value.tabId, category: value.category, action: value.action, target: value.target, origin: value.origin, site: value.site,
      ...(value.frameHost ? { frameHost: value.frameHost } : {}), ...(value.destinationHost ? { destinationHost: value.destinationHost } : {}),
      ...(value.intent ? { intent: value.intent } : {}), reason: value.reason, canRemember: value.canRemember === true,
    })),
    ask: (request, signal) => openPrompt('ask', request, signal, { outcome: 'cancel' }, async value => {
      // The site a hand-over card names is read from the tab by the extension, never taken from page text.
      let site = '';
      try { site = (await ready)?.layer?.siteOf?.((await api.tabs.get(value.tabId))?.url || '') || ''; } catch { site = ''; }
      return { id: value.id, tabId: value.tabId, kind: value.kind === 'input' ? 'input' : 'takeover', message: String(value.message || ''), site };
    }),
  };

  function answerPrompt(state, message) {
    const waiting = state.prompts.get(message.promptId);
    if (!waiting) return;
    if (waiting.type === 'confirm') {
      let answer = CONFIRM_ANSWERS.includes(message.answer) ? message.answer : 'decline';
      if (answer === 'approve-remember') {
        if (!waiting.request.canRemember || !waiting.request.site) answer = 'approve';
        // The rule holds for the rest of this session at once; the page saves it to Settings and sends the full rules.
        else state.policy = withSiteRule(state.policy, waiting.request.site, 'allow');
      }
      waiting.finish(answer);
      return;
    }
    const answer = isObject(message.answer) && message.answer.outcome === 'continue'
      ? { outcome: 'continue', ...(typeof message.answer.data === 'string' && message.answer.data ? { data: message.answer.data.slice(0, 2000) } : {}) }
      : { outcome: 'cancel' };
    waiting.finish(answer);
  }

  // ---------------------------------------------------------------------------------------------------- sessions
  function requireSession(state) {
    if (!state.session) throw new HostError('not_open', 'Open a browser session first.');
    return state.session;
  }

  async function sessionState(state) {
    const session = requireSession(state);
    const listed = await session.call('tabs', { action: 'list' });
    const data = isObject(listed?.data) ? listed.data : {};
    const tabs = (Array.isArray(data.tabs) ? data.tabs : []).map(tab => {
      const info = session.hasTab(tab.tabId) ? state.controller.tabState(tab.tabId) : null;
      return { tabId: tab.tabId, url: String(tab.url || ''), title: String(tab.title || ''), active: tab.active === true,
        rev: Number.isInteger(info?.rev) ? info.rev : 0, pending: (info?.pending || []).map(modal => ({ kind: modal.kind, detail: String(modal.detail || '') })) };
    });
    return { tabs, activeTabId: Number.isInteger(data.activeTabId) ? data.activeTabId : null };
  }

  async function closeSession(state) {
    for (const call of state.calls.values()) call.abort();
    state.calls.clear();
    for (const waiting of [...state.prompts.values()]) waiting.withdraw();
    const session = state.session;
    state.session = null;
    if (session && state.controller) await state.controller.closeSession(session).catch(() => undefined);
  }

  const applyPolicy = async state => {
    await state.session?.setUrlPolicy?.({ allow: [], deny: [], blocked: blockedSites(state.policy) });
  };

  const methods = {
    status: () => status(),

    async open(state, params) {
      const check = await status();
      if (!check.available) {
        if (check.missing.length) throw new HostError('needs_permission', 'Still needs to see your tabs to work in them.', { permissions: check.missing });
        throw new HostError('unavailable', check.reason);
      }
      await closeSession(state);
      let loaded;
      try { loaded = await controller(); } catch (error) { throw new HostError('unavailable', `The browser control layer did not start: ${error?.message || error}`); }
      state.controller = loaded.controller;
      state.policy = normalizeBrowserSettings(params?.policy);
      state.reveal = params?.reveal === true;
      state.session = loaded.controller.createSession({
        // ask_user is the only extra capability: no page script, no devtools, no files.
        capabilities: ['human'],
        // Payments, access grants, secrets and prompt dialogs are handed to the person in every mode.
        handover: true,
        budget: RESULT_BUDGET,
        // A write card has no clock; it ends with the answer, Stop, or the page closing.
        confirmTimeoutMs: Infinity,
        askTimeoutMs: ASK_TIMEOUT_MS,
        boundary: { labels: [...NOTE_LABELS] },
        decideWrite: question => decideWrite(state.policy, question),
        urlPolicy: { allow: [], deny: [], blocked: blockedSites(state.policy) },
        // The view follows the assistant only where the person watches beside the page (the side panel).
        reveal: () => state.reveal,
        onTabJoined: () => { sessionState(state).then(value => post(state, { kind: 'tabs', state: value }), () => undefined); },
      });
      const result = { sessionId: state.session.id, epoch: loaded.controller.epoch?.prefix || '' };
      if (Number.isInteger(params?.startTabId)) {
        // The tab the person is on joins the session, unless its site is blocked or the tab is gone.
        try { await state.session.share(params.startTabId); result.startTab = { ok: true }; }
        catch (error) { result.startTab = { ok: false, code: String(error?.code || 'INTERNAL'), message: String(error?.message || error) }; }
      }
      result.state = await sessionState(state);
      return result;
    },

    async call(state, params, signal) {
      const session = requireSession(state);
      const tool = typeof params?.tool === 'string' ? params.tool : '';
      if (!HOST_TOOLS.includes(tool)) throw new HostError('bad_request', `The assistant has no browser tool named ${tool || '(none)'}.`);
      const result = await session.call(tool, isObject(params.args) ? params.args : {}, { signal });
      // The session may have ended while the call ran (Stop, the page closed).
      const snapshot = state.session === session ? await sessionState(state).catch(() => null) : null;
      return { result, state: snapshot };
    },

    state: state => sessionState(state),

    async share(state, params) {
      const session = requireSession(state);
      if (!Number.isInteger(params?.tabId)) throw new HostError('bad_request', 'Name the tab to share.');
      try { await session.share(params.tabId); }
      catch (error) { throw new HostError(String(error?.code || 'internal').toLowerCase(), String(error?.message || error)); }
      return { state: await sessionState(state) };
    },

    async policy(state, params) {
      state.policy = normalizeBrowserSettings(params?.policy);
      await applyPolicy(state);
      return { ok: true };
    },

    async close(state) {
      await closeSession(state);
      return { ok: true };
    },
  };

  function handle(state, message) {
    if (!isObject(message) || state.closed) return;
    if (message.kind === 'ping') return;
    if (message.kind === 'cancel') { state.calls.get(message.id)?.abort(); return; }
    if (message.kind === 'answer') { answerPrompt(state, message); return; }
    if (message.kind !== 'request' || !['string', 'number'].includes(typeof message.id)) return;
    const id = message.id;
    const method = Object.hasOwn(methods, message.method) ? methods[message.method] : null;
    const abort = new AbortController();
    state.calls.set(id, abort);
    Promise.resolve()
      .then(() => { if (!method) throw new HostError('bad_request', 'Unknown browser request.'); return method(state, message.params, abort.signal); })
      .then(result => post(state, { kind: 'response', id, ok: true, result }),
        error => post(state, { kind: 'response', id, ok: false, error: {
          code: typeof error?.code === 'string' ? error.code : 'internal', message: String(error?.message || error),
          ...(Array.isArray(error?.permissions) ? { permissions: error.permissions } : {}),
        } }))
      .finally(() => { if (state.calls.get(id) === abort) state.calls.delete(id); });
  }

  /** Takes a port from runtime.onConnect. Returns false for a port that is not the assistant's. */
  function connect(port) {
    if (port?.name !== BROWSER_PORT) return false;
    const sender = port.sender;
    if (!sender || sender.id !== api.runtime.id || isContentSender(sender)) {
      try { port.disconnect(); } catch { /* Already gone. */ }
      return true;
    }
    const state = { port, session: null, controller: null, policy: normalizeBrowserSettings(null), reveal: false, calls: new Map(), prompts: new Map(), closed: false };
    sessions.add(state);
    port.onMessage.addListener(message => handle(state, message));
    port.onDisconnect.addListener(() => {
      state.closed = true;
      sessions.delete(state);
      closeSession(state).catch(() => undefined);
    });
    return true;
  }

  return { connect, status, get sessionCount() { return sessions.size; } };
}
