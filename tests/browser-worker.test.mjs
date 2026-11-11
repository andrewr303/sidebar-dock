import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BROWSER_PORT } from '../extension/lib/browser/host.js';

// The worker as a whole: it registers for the assistant's port at start, and starting it evaluates nothing of the
// browser control layer.
const events = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); }, removeListener(listener) { this.listeners = this.listeners.filter(l => l !== listener); } });
const values = {};
const granted = new Set();
const chrome = {
  runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`, onMessage: events(), onConnect: events(), onInstalled: events(), onStartup: events() },
  storage: { local: { get: async key => ({ [key]: values[key] }), set: async patch => { Object.assign(values, structuredClone(patch)); } }, onChanged: events() },
  contextMenus: { removeAll: async () => {}, create: item => item.id, remove: async () => {}, onClicked: events() },
  tabs: { query: async () => [], create: async tab => tab, get: async id => ({ id, url: 'https://example.com/' }) },
  scripting: { executeScript: async () => [] },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  sidePanel: { open: async () => {}, setPanelBehavior: async () => {} },
  alarms: { getAll: async () => [], create: async () => {}, clear: async () => true, onAlarm: events() },
  commands: { onCommand: events() },
  notifications: { create: async () => {}, clear: async () => {}, onClicked: events() },
  permissions: { contains: async request => (request.permissions || []).every(permission => granted.has(permission)), onAdded: events(), onRemoved: events() },
  debugger: { sendCommand: async () => ({}), onEvent: events(), onDetach: events(), attach: async () => {}, detach: async () => {} },
};
globalThis.chrome = chrome;
const globalsBefore = new Set(Object.keys(globalThis));
const worker = await import('../extension/background.js');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function connect(sender, name = BROWSER_PORT) {
  const port = { name, sender, posted: [], disconnected: false, onMessage: events(), onDisconnect: events(),
    postMessage(message) { port.posted.push(structuredClone(message)); }, disconnect() { port.disconnected = true; },
    send(message) { for (const listener of port.onMessage.listeners) listener(message); } };
  for (const listener of chrome.runtime.onConnect.listeners) listener(port);
  return port;
}
async function ask(port, method, params) {
  const id = `${method}-${port.posted.length}`;
  port.send({ kind: 'request', id, method, params });
  for (let index = 0; index < 50; index++) {
    const response = port.posted.find(message => message.kind === 'response' && message.id === id);
    if (response) return response;
    await tick();
  }
  throw new Error(`No response to ${method}`);
}

const stillPage = { id: 'test-extension', url: 'chrome-extension://test-extension/index.html?view=sidepanel' };

test('starting the worker registers for the browser port and evaluates nothing of the layer', () => {
  assert.equal(chrome.runtime.onConnect.listeners.length, 1);
  assert.equal(typeof worker.browserHost.connect, 'function');
  // zod and Puppeteer set these when the layer is evaluated (tests/browser-control-build.test.mjs).
  const added = [...Object.keys(globalThis)].filter(key => !globalsBefore.has(key));
  assert.deepEqual(added.filter(key => key.startsWith('__zod') || key === 'URLPattern'), []);
  assert.equal(chrome.debugger.onEvent.listeners.length, 0, 'no debugger listener before a session opens');
});

test('a Still page gets an answer; a content script and another port do not', async () => {
  const page = connect(stillPage);
  const status = await ask(page, 'status');
  assert.deepEqual(status.result, { available: false, missing: ['tabs', 'webNavigation'] });
  const refused = await ask(page, 'open', { policy: { mode: 'auto' } });
  assert.equal(refused.error.code, 'needs_permission');
  assert.deepEqual(refused.error.permissions, ['tabs', 'webNavigation']);
  assert.deepEqual([...Object.keys(globalThis)].filter(key => key.startsWith('__zod')), [], 'a session that cannot start loads nothing');

  const script = connect({ id: 'test-extension', url: 'https://example.com/article', tab: { id: 4 }, frameId: 0 });
  assert.equal(script.disconnected, true);
  assert.equal(script.onMessage.listeners.length, 0);

  const other = connect(stillPage, 'still.something-else');
  assert.equal(other.disconnected, false);
  assert.equal(other.onMessage.listeners.length, 0, 'ports with another name are left alone');
});

test('a browser request sent as a one-off message is not a Still request', async () => {
  for (const type of ['open', 'call', 'still.browser.v1', 'browser']) {
    const answers = chrome.runtime.onMessage.listeners.map(listener => listener({ type, method: 'call', params: { tool: 'click' } }, stillPage, () => {}));
    assert.deepEqual(answers, [false], `${type} has no message handler`);
  }
  // importBrowserBookmarks is the bookmarks import; nothing in the list reaches the browser control layer.
  assert.equal(worker.MESSAGE_TYPES.some(type => /^(?:still[:.])?browser/i.test(type) || /debugger|automation/i.test(type)), false);
});

test('the manifest requires the debugger and keeps the tab permissions optional', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.permissions.includes('debugger'), 'Chrome does not allow debugger as an optional permission');
  for (const permission of ['tabs', 'webNavigation']) {
    assert.ok(manifest.optional_permissions.includes(permission), `${permission} is asked for when automation is turned on`);
    assert.equal(manifest.permissions.includes(permission), false, `${permission} is not required`);
  }
  assert.equal(manifest.host_permissions, undefined, 'the debugger needs no host permission');
  assert.equal(manifest.externally_connectable, undefined, 'no web page and no other extension can open the browser port');
  assert.equal(manifest.web_accessible_resources, undefined);
});
