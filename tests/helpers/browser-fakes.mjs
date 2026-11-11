// Stand-ins for the browser automation tests: a chrome.runtime port (one end, or a connected pair), the browser control
// layer as the host uses it, and the parts of `chrome` the host reads. No test here starts a browser.
import { BROWSER_PORT } from '../../extension/lib/browser/protocol.js';

export const EXTENSION_ID = 'stillextensionidstillextensionid';
export const PAGE = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/index.html?view=sidepanel`, origin: `chrome-extension://${EXTENSION_ID}` };
export const tick = () => new Promise(resolve => setTimeout(resolve, 0));
export const settle = async (turns = 5) => { for (let index = 0; index < turns; index++) await tick(); };
export const events = () => { const listeners = []; return { listeners, addListener: listener => listeners.push(listener), removeListener: listener => listeners.splice(listeners.indexOf(listener), 1) }; };

/** The worker's end of a port, driven by the test: send(message) delivers to the host, posted holds what the host sent. */
export function fakePort(sender = PAGE, name = BROWSER_PORT) {
  const port = { name, sender, posted: [], disconnected: false, onMessage: events(), onDisconnect: events(),
    postMessage(message) { port.posted.push(structuredClone(message)); },
    disconnect() { port.disconnected = true; },
    send(message) { for (const listener of port.onMessage.listeners) listener(message); },
    close() { for (const listener of port.onDisconnect.listeners) listener(port); } };
  return port;
}

/**
 * Two connected ends, as chrome.runtime.connect gives a page and onConnect gives the worker. Messages are copied and
 * delivered on a later microtask, as Chrome does; disconnect() on one end fires onDisconnect on the other.
 * cut(): the worker stopped, so the page's end disconnects (and the worker's end is told too, as a closing page would).
 */
export function portPair({ sender = PAGE, name = BROWSER_PORT } = {}) {
  let open = true;
  const end = () => ({ name, sender, sent: [], onMessage: events(), onDisconnect: events() });
  const page = end();
  const worker = end();
  const wire = (from, to) => {
    from.postMessage = message => {
      if (!open) throw new Error('Attempting to use a disconnected port object');
      const copy = structuredClone(message);
      from.sent.push(copy);
      queueMicrotask(() => { if (open) for (const listener of [...to.onMessage.listeners]) listener(structuredClone(copy)); });
    };
    from.disconnect = () => {
      if (!open) return;
      open = false;
      queueMicrotask(() => { for (const listener of [...to.onDisconnect.listeners]) listener(to); });
    };
  };
  wire(page, worker);
  wire(worker, page);
  const cut = () => {
    if (!open) return;
    open = false;
    for (const listener of [...page.onDisconnect.listeners]) listener(page);
    for (const listener of [...worker.onDisconnect.listeners]) listener(worker);
  };
  return { page, worker, cut, get open() { return open; } };
}

/** A stand-in for the browser control layer: one controller, sessions that record what they were asked. */
export function fakeLayer({ failStart = 0 } = {}) {
  const layer = { loads: 0, starts: 0, sessions: [], closed: [], prompt: null, tabStates: new Map(),
    siteOf: address => { try { return new URL(address).hostname.replace(/^www\./, ''); } catch { return ''; } } };
  const controller = {
    epoch: { prefix: 'a', persisted: true },
    tabState(tabId) { if (!layer.tabStates.has(tabId)) layer.tabStates.set(tabId, { rev: 0, pending: [] }); return layer.tabStates.get(tabId); },
    createSession(config) {
      const session = { id: `s${layer.sessions.length + 1}`, config, tabs: new Map(), activeTabId: null, calls: [], policies: [], handler: null,
        hasTab: tabId => session.tabs.has(tabId),
        async share(tabId) {
          if (tabId === 404) throw Object.assign(new Error('Tab 404 does not exist'), { code: 'TAB_NOT_IN_SESSION' });
          session.tabs.set(tabId, { tabId, url: `https://site${tabId}.example/`, title: `Tab ${tabId}`, active: true });
          session.activeTabId = tabId;
          config.onTabJoined?.(tabId, 'shared');
        },
        async setUrlPolicy(policy) { session.policies.push(policy); },
        async call(tool, args, options = {}) {
          session.calls.push({ tool, args, signal: options.signal });
          if (tool === 'tabs' && args.action === 'list') return { ok: true, text: '', data: { tabs: [...session.tabs.values()], activeTabId: session.activeTabId } };
          return session.handler ? session.handler(tool, args, options) : { ok: true, text: `${tool}: ok` };
        } };
      layer.sessions.push(session);
      return session;
    },
    async closeSession(session) { layer.closed.push(session.id); },
  };
  layer.createChromeController = async ({ prompt }) => {
    layer.starts++;
    if (layer.starts <= failStart) throw new Error('no debugger');
    layer.prompt = prompt;
    return controller;
  };
  layer.load = async () => { layer.loads++; return layer; };
  return layer;
}


/** The parts of `chrome` the host reads. `granted`: the optional permissions Chrome has given. */
export function fakeChrome({ granted = ['tabs', 'webNavigation'], debuggerApi = { sendCommand() {} } } = {}) {
  return {
    runtime: { id: EXTENSION_ID, getURL: path => `chrome-extension://${EXTENSION_ID}/${path}` },
    permissions: { contains: async request => request.permissions.every(permission => granted.includes(permission)) },
    tabs: { get: async tabId => ({ id: tabId, url: `https://www.site${tabId}.example/path` }) },
    debugger: debuggerApi,
  };
}
