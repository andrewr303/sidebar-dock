import test from 'node:test';
import assert from 'node:assert/strict';

const events = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); }, removeListener(listener) { this.listeners = this.listeners.filter(l => l !== listener); } });
const values = {};
const menus = [];
const tabs = [];
const notifications = [];
const alarmValues = new Map();
const screenshotCalls = [];
const screenshotDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=';
const chrome = {
  runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`, onMessage: events(), onInstalled: events(), onStartup: events() },
  storage: { local: { get: async key => ({ [key]: values[key] }), set: async patch => { Object.assign(values, structuredClone(patch)); } }, onChanged: events() },
  contextMenus: { removeAll: async () => { menus.length = 0; }, create: item => { menus.push(item); return item.id; }, onClicked: events() },
  tabs: { query: async () => [{ id: 7, windowId: 1, title: 'A page', url: 'https://example.com/post' }], create: async tab => { tabs.push(tab); return tab; },
    captureVisibleTab: async (windowId, options) => { screenshotCalls.push({ windowId, options }); return screenshotDataUrl; } },
  scripting: { executeScript: async () => [{ result: { title: 'Captured article', url: 'https://example.com/post', articleText: 'An article about linked thinking.', cover: '/cover.jpg' } }] },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  sidePanel: { open: async () => {}, setPanelBehavior: async () => {} },
  alarms: { getAll: async () => [...alarmValues.values()], create: async (name, options) => { alarmValues.set(name, { name, scheduledTime: options.when }); }, clear: async name => alarmValues.delete(name), onAlarm: events() },
  commands: { onCommand: events() },
  notifications: { create: async (id, options) => { notifications.push({ id, ...options }); }, clear: async () => {}, onClicked: events() },
  permissions: { contains: async () => false },
};
globalThis.chrome = chrome;
const { installMenus, captureTab, captureScreenshot, startFullPageCapture, handleMessage, handleAlarm } = await import('../extension/background.js');
const { buildCapture } = await import('../extension/lib/capture.js');

test('registers capture menus and captures selected text into source-linked highlights', async () => {
  await installMenus();
  assert.deepEqual(menus.map(menu => menu.id), ['still-save-page', 'still-save-link', 'still-save-selection', 'still-note-selection', 'still-save-image', 'still-screenshot', 'still-screenshot-full', 'still-open-library']);
  const item = await captureTab({ id: 7, title: 'Page', url: 'https://example.com/post' }, { menuItemId: 'still-save-selection', selectionText: 'A source passage', pageUrl: 'https://example.com/post' });
  assert.equal(item.type, 'article');
  assert.equal(item.content, '');
  assert.equal(item.articleContent, 'An article about linked thinking.');
  assert.equal(item.highlights[0].text, 'A source passage');
  assert.equal(item.highlights[0].url, 'https://example.com/post');
  assert.equal(item.cover, 'https://example.com/cover.jpg');
});

test('saves selection as a note linked to an already captured source', async () => {
  const note = await captureTab({ id: 7, title: 'Page', url: 'https://example.com/post' }, { menuItemId: 'still-note-selection', selectionText: 'My thought', pageUrl: 'https://example.com/post' });
  assert.equal(note.type, 'note');
  assert.equal(note.content, 'My thought');
  assert.equal(note.relatedIds.length, 1);
});

test('rejects untrusted messages and non-web links', async () => {
  await assert.rejects(handleMessage({ type: 'newNote' }, { id: 'other-extension' }), /Untrusted/);
  assert.throws(() => buildCapture({ linkUrl: 'javascript:alert(1)' }), /http or https/);
  const response = await handleMessage({ type: 'openLibrary', itemId: 'x y' }, { id: chrome.runtime.id });
  assert.equal(response.url, 'chrome-extension://test-extension/index.html?item=x%20y');
});

test('reminder alarm delivers one notification and records completion', async () => {
  const item = await handleMessage({ type: 'still:store', operation: 'saveItem', args: [{ type: 'note', title: 'Read this again', reminderAt: '2020-01-01T00:00:00Z' }] }, { id: chrome.runtime.id });
  await handleAlarm({ name: `still:reminder:${item.id}` });
  await handleAlarm({ name: `still:reminder:${item.id}` });
  assert.equal(notifications.filter(value => value.id === `still:item:${item.id}`).length, 1);
});

test('a stale alarm does not prematurely notify a reminder moved into the future', async () => {
  const item = await handleMessage({ type: 'still:store', operation: 'saveItem', args: [{ type: 'note', title: 'Later', reminderAt: '2040-01-01T00:00:00Z' }] }, { id: chrome.runtime.id });
  await handleAlarm({ name: `still:reminder:${item.id}` });
  assert.equal(notifications.filter(value => value.id === `still:item:${item.id}`).length, 0);
});

test('an external link does not inherit the source page article snapshot', () => {
  const item = buildCapture({ menuItemId: 'still-save-link', linkUrl: 'https://elsewhere.example/article', pageUrl: 'https://example.com/post' }, {},
    { title: 'Current page', articleText: 'Wrong page contents', excerpt: 'Wrong page description', cover: 'https://example.com/cover.png' });
  assert.equal(item.type, 'bookmark');
  assert.equal(item.url, 'https://elsewhere.example/article');
  assert.equal(item.articleContent, '');
  assert.equal(item.content, '');
  assert.equal(item.excerpt, '');
  assert.equal(item.cover, '');
});

test('screenshot captures the visible web tab into a local PNG attachment', async () => {
  let persisted;
  const item = await captureScreenshot({ id: 7, windowId: 1, url: 'https://example.com/post', title: 'Page' }, {
    persistAttachment: async file => { persisted = file; return { attachmentId: 'shot-1', fileName: file.name, mime: file.type, size: file.size }; },
  });
  assert.deepEqual(screenshotCalls.at(-1), { windowId: 1, options: { format: 'png' } });
  assert.ok(persisted instanceof Blob);
  assert.equal(persisted.type, 'image/png');
  assert.equal(item.type, 'image');
  assert.equal(item.url, '');
  assert.equal(item.sourceUrl, 'https://example.com/post');
  assert.equal(item.attachmentId, 'shot-1');
  assert.equal(item.cover, screenshotDataUrl);
});

test('screenshot rejects protected pages and cleans file storage if library persistence fails', async () => {
  const before = screenshotCalls.length;
  await assert.rejects(captureScreenshot({ id: 7, windowId: 1, url: 'chrome://settings' }), /http or https/);
  assert.equal(screenshotCalls.length, before);
  const removed = [];
  await assert.rejects(captureScreenshot({ id: 7, windowId: 1, url: 'https://example.com/post' }, {
    persistAttachment: async () => ({ attachmentId: 'orphan' }),
    persistItem: async () => { throw new Error('Storage failed'); },
    removeAttachment: async id => { removed.push(id); },
  }), /Storage failed/);
  assert.deepEqual(removed, ['orphan']);
});

test('screenshot detects a tab switch before persisting pixels against the wrong source', async () => {
  let persisted = false;
  await assert.rejects(captureScreenshot({ id: 99, windowId: 1, url: 'https://example.com' }, {
    persistAttachment: async () => { persisted = true; },
  }), /active tab changed/);
  assert.equal(persisted, false);
});

test('visible and full-page screenshots cannot overlap while page capture is owned', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const visible = captureScreenshot({ id: 7, windowId: 1, url: 'https://example.com/post' }, {
    limiter: async (capture, signal, before) => { await before(); entered(); await gate; return capture(); },
    persistAttachment: async () => ({ attachmentId: 'visible-owned' }), persistItem: async item => item,
  });
  await started;
  assert.throws(() => startFullPageCapture({ id: 7, windowId: 1, url: 'https://example.com/post' }), /visible screenshot to finish/);
  release(); await visible;
  let releaseFull, enteredFull;
  const fullGate = new Promise(resolve => { releaseFull = resolve; }), fullStarted = new Promise(resolve => { enteredFull = resolve; });
  const full = startFullPageCapture({ id: 7, windowId: 1, url: 'https://example.com/post' }, {
    jobId: 'background-owned-job', capturePixels: async () => { enteredFull(); await fullGate; throw new Error('stopped owned job'); },
  });
  const rejected = assert.rejects(full.promise, /stopped owned job/);
  await fullStarted;
  await assert.rejects(captureScreenshot({ id: 7, windowId: 1, url: 'https://example.com/post' }), /full-page screenshot to finish/);
  const listener = chrome.runtime.onMessage.listeners[0];
  let response;
  const responding = new Promise(resolve => {
    assert.equal(listener({ type: 'getFullPageCaptureJob', jobId: full.id }, { id: chrome.runtime.id }, value => { response = value; resolve(); }), true);
  });
  await responding;
  assert.equal(response.result.jobId, full.id);
  // A disappearing response view must not create an unhandled rejection.
  listener({ type: 'getFullPageCaptureJob', jobId: full.id }, { id: chrome.runtime.id }, () => { throw new Error('view closed'); });
  releaseFull(); await rejected;
});
