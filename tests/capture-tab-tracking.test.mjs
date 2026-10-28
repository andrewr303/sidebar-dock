import test from 'node:test';
import assert from 'node:assert/strict';

// A stopped MV3 worker is started by the event itself and Chrome dispatches that event right after the script's
// first synchronous run. Listeners added only after an async permission check miss it.
const events = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); }, removeListener(listener) { this.listeners = this.listeners.filter(l => l !== listener); } });
const library = { schemaVersion: 1, collections: [], settings: {}, updatedAt: '2026-10-01T00:00:00.000Z',
  items: [{ id: 'saved-item', type: 'bookmark', url: 'https://example.com/saved', title: 'Saved', tags: [], highlights: [], relatedIds: [] }] };

function mockChrome(permission) {
  const values = { 'still.library.v1': structuredClone(library) };
  const record = { badges: [], sent: [] };
  const tabs = [{ id: 5, windowId: 1, active: true, url: 'https://example.com/saved', title: 'Saved page', favIconUrl: '' }];
  const chrome = {
    runtime: { id: 'tracking-test', onMessage: events(), onInstalled: events(), onStartup: events(), sendMessage: async message => { record.sent.push(message); } },
    storage: { local: { get: async key => ({ [key]: structuredClone(values[key]) }), set: async patch => { Object.assign(values, structuredClone(patch)); } }, onChanged: events() },
    tabs: { onActivated: events(), onUpdated: events(), get: async id => tabs.find(tab => tab.id === id), query: async query => tabs.filter(tab => query.active === undefined || tab.active === query.active) },
    windows: { onFocusChanged: events() },
    action: { setBadgeText: async details => { record.badges.push(details); }, setBadgeBackgroundColor: async () => {} },
    alarms: { getAll: async () => [], create: async () => {}, clear: async () => true, onAlarm: events() },
    contextMenus: { onClicked: events() }, commands: { onCommand: events() }, notifications: { onClicked: events() },
    permissions: { contains: () => permission, onAdded: events(), onRemoved: events() },
  };
  return { chrome, record };
}

// A fresh worker instance per test (the query string makes a new module record, like a restarted worker).
const startWorker = tag => import(new URL(`../extension/background.js?${tag}`, import.meta.url).href);

// The granted worker instance, reused by the badge test that follows it.
let granted;

const waitFor = async (check, timeout = 3000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for background work.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test('with tabs granted, the activation that woke the worker still reaches the saved-page dot and the side panel', async () => {
  let grant;
  const { chrome, record } = mockChrome(new Promise(resolve => { grant = resolve; }));
  globalThis.chrome = chrome;
  await startWorker('granted');
  assert.equal(chrome.tabs.onActivated.listeners.length, 1, 'registered in the first synchronous run');
  assert.equal(chrome.tabs.onUpdated.listeners.length, 1);
  assert.equal(chrome.windows.onFocusChanged.listeners.length, 1);
  for (const listener of chrome.tabs.onActivated.listeners) listener({ tabId: 5, windowId: 1 });
  grant(true);
  const broadcast = await waitFor(() => record.sent.find(message => message.type === 'still:active-tab'));
  assert.deepEqual([broadcast.tab.tabId, broadcast.tab.saved, broadcast.tab.itemId], [5, true, 'saved-item']);
  assert.ok(record.badges.some(badge => badge.tabId === 5 && badge.text === '•'));
  granted = { chrome, record };
});

test('a save shows the check on its tab, and clearing the check brings the saved-page dot back', async () => {
  const { chrome, record } = granted;
  const background = await startWorker('granted');
  record.badges.length = 0;
  // No scripting API in this mock: the capture falls back to the tab's URL and title.
  const item = await background.captureTab({ id: 5, windowId: 1, active: true, url: 'https://example.com/saved', title: 'Saved page' });
  assert.equal(item.id, 'saved-item');
  assert.ok(record.badges.some(badge => badge.tabId === 5 && badge.text === '✓'));
  assert.ok(record.badges.some(badge => badge.tabId === undefined && badge.text === '✓'));
  record.badges.length = 0;
  await background.handleAlarm({ name: 'still:clear-badge' });
  assert.deepEqual(record.badges.filter(badge => badge.tabId === undefined).map(badge => badge.text), ['']);
  assert.deepEqual(record.badges.filter(badge => badge.tabId === 5).map(badge => badge.text), ['•']);
  assert.equal(chrome.tabs.onActivated.listeners.length, 1);
});

test('without tabs, an early event is ignored and the listeners are removed so tab events stop waking the worker', async () => {
  let answer;
  const { chrome, record } = mockChrome(new Promise(resolve => { answer = resolve; }));
  globalThis.chrome = chrome;
  await startWorker('denied');
  for (const listener of chrome.tabs.onActivated.listeners) listener({ tabId: 5, windowId: 1 });
  answer(false);
  await waitFor(() => chrome.tabs.onActivated.listeners.length === 0);
  assert.equal(chrome.tabs.onUpdated.listeners.length, 0);
  assert.equal(chrome.windows.onFocusChanged.listeners.length, 0);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(record.sent.filter(message => message.type === 'still:active-tab').length, 0);
  assert.equal(record.badges.filter(badge => badge.tabId === 5).length, 0);
  chrome.permissions.onAdded.listeners[0]({ permissions: ['tabs'] });
  assert.equal(chrome.tabs.onActivated.listeners.length, 1, 'granting later starts tracking without a reload');
});

test('the worker loads when optional chrome APIs are missing (tests and odd builds mock a subset)', async () => {
  // storage.onChanged stays: the store's subscribe() needs it whenever storage.local exists.
  globalThis.chrome = { runtime: { id: 'minimal', onMessage: events() }, storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: events() } };
  const background = await startWorker('minimal');
  assert.equal(typeof background.handleMessage, 'function');
  assert.equal(globalThis.chrome.runtime.onMessage.listeners.length, 1);
});
