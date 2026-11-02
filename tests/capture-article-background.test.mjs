// Worker side of "Save article", "Select parts of page…" and "Save and research with AI" (build contracts §5):
// the three runtime messages, sender classification, the picker request checks, the canonical-URL rule and the
// re-capture merge, storage.session records, notifications and the context-menu entry points.
import test from 'node:test';
import assert from 'node:assert/strict';

const events = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); }, removeListener(listener) { this.listeners = this.listeners.filter(l => l !== listener); } });
const values = {};
const sessionValues = {};
const menus = [];
const opened = [];
const sent = [];
const badges = [];
const notifications = [];
const injections = [];
const createdTabs = [];
const granted = new Set();
const pageWindow = 1;
let tabs = [];
let respond = () => undefined;
let sidePanels = [];
let article = {};
let pickerReply = { started: true };
let failInjection = null;

const chrome = {
  runtime: {
    id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`, onMessage: events(), onInstalled: events(), onStartup: events(),
    sendMessage: async message => { sent.push(message); return respond(message); },
    getContexts: async filter => sidePanels.filter(panel => !filter.windowIds || filter.windowIds.includes(panel.windowId)),
  },
  storage: {
    local: { get: async key => ({ [key]: structuredClone(values[key]) }), set: async patch => { Object.assign(values, structuredClone(patch)); } },
    session: { get: async key => ({ [key]: structuredClone(sessionValues[key]) }), set: async patch => { Object.assign(sessionValues, structuredClone(patch)); } },
    onChanged: events(),
  },
  contextMenus: {
    removeAll: async () => { menus.length = 0; },
    create: item => { if (menus.some(menu => menu.id === item.id)) throw new Error(`duplicate ${item.id}`); menus.push(item); return item.id; },
    remove: async id => {
      const doomed = new Set([id]);
      for (const menu of menus) if (doomed.has(menu.parentId)) doomed.add(menu.id);
      for (let index = menus.length - 1; index >= 0; index--) if (doomed.has(menus[index].id)) menus.splice(index, 1);
    },
    onClicked: events(),
  },
  tabs: {
    query: async query => tabs.filter(tab => (query.active === undefined || tab.active === query.active) && (query.windowId === undefined || tab.windowId === query.windowId)),
    get: async id => { const tab = tabs.find(value => value.id === id); if (!tab) throw new Error('No tab'); return tab; },
    create: async tab => { createdTabs.push(tab); return tab; }, onActivated: events(), onUpdated: events(),
  },
  windows: { onFocusChanged: events() },
  scripting: {
    executeScript: async details => {
      injections.push(structuredClone({ ...details, func: details.func?.name }));
      if (failInjection) throw failInjection;
      if (details.files) return [{ frameId: 0, documentId: `doc-${details.target.tabId}`, result: undefined }];
      if (details.func?.name === 'runArticleExtract') return [{ frameId: 0, documentId: `doc-${details.target.tabId}`, result: structuredClone(article) }];
      if (details.func?.name === 'startPagePicker') return [{ frameId: 0, result: { ...pickerReply, requestId: details.args[0].requestId } }];
      // The page-metadata fallback of a plain "Save page" capture.
      return [{ result: { title: 'Fallback title', url: details.target.url, excerpt: 'Fallback excerpt', articleText: '' } }];
    },
  },
  action: { setBadgeText: async details => { badges.push(details); }, setBadgeBackgroundColor: async () => {} },
  sidePanel: { open: options => { opened.push(options); return Promise.resolve(); }, setPanelBehavior: async () => {} },
  alarms: { getAll: async () => [], create: async () => {}, clear: async () => true, onAlarm: events() },
  commands: { onCommand: events() },
  notifications: { create: async (id, options) => { notifications.push({ id, ...options }); }, clear: async () => {}, onClicked: events() },
  permissions: { contains: async ({ permissions = [], origins = [] }) => [...permissions, ...origins].every(value => granted.has(value)), onAdded: events(), onRemoved: events() },
};
globalThis.chrome = chrome;
const background = await import('../extension/background.js');
const { installMenus, installCollectionMenus, handleMessage, captureTab, MESSAGE_TYPES, MENU_ITEMS, PANEL_DRAFTS_KEY } = background;
const { ARTICLE_SCRIPT_FILES, PICKER_SCRIPT_FILES } = await import('../extension/lib/capture.js');

const self = { id: chrome.runtime.id, url: 'chrome-extension://test-extension/index.html?view=sidepanel' };
const pageSender = (tabId, extra = {}) => ({ id: chrome.runtime.id, url: 'https://example.com/post', origin: 'https://example.com', tab: { id: tabId, windowId: pageWindow }, frameId: 0, documentId: `doc-${tabId}`, ...extra });
const store = (operation, ...args) => handleMessage({ type: 'still:store', operation, args }, self);
const library = () => store('exportLibrary');
const byUrl = async url => (await library()).items.filter(item => item.url === url && item.type !== 'note');
const waitFor = async (check, timeout = 4000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for background work.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const listener = name => {
  const [path, event] = name.split('#');
  return path.split('.').reduce((value, key) => value[key], chrome)[event].listeners;
};
const pageTab = (extra = {}) => ({ id: 7, windowId: pageWindow, active: true, title: 'A page', url: 'https://example.com/post', ...extra });
const articleResult = (extra = {}) => ({
  ok: true, source: 'readability', url: 'https://example.com/post', canonicalUrl: 'https://example.com/post', title: 'Linked thinking',
  siteName: 'Example Journal', author: 'Ada Writer', publishedAt: '2026-10-01T09:00:00.000Z', lang: 'en', dir: 'ltr', excerpt: 'Why links matter.',
  icon: 'https://example.com/icon-64.png', cover: 'https://example.com/cover.jpg', markdown: '# Linked thinking\nFirst paragraph.\n- one\n- two',
  text: 'Linked thinking First paragraph. one two', wordCount: 7, readingMinutes: 1, images: [], truncated: false, ...extra,
});
const reset = () => { injections.length = 0; opened.length = 0; sent.length = 0; badges.length = 0; notifications.length = 0; createdTabs.length = 0; failInjection = null; respond = () => undefined; };

await store('createCollection', { id: 'reading', name: 'Reading' });

test('three page menu items sit right before the Save … to parents and survive a collection rebuild', async () => {
  await installMenus();
  await installCollectionMenus({ collections: [], items: [] }, { recent: [], force: true });
  const topLevel = menus.filter(menu => !menu.parentId);
  const ids = topLevel.map(menu => menu.id);
  assert.deepEqual(ids.slice(-6), ['still-save-article', 'still-select-parts', 'still-save-research', 'still-save-page-to', 'still-save-link-to', 'still-save-image-to']);
  const added = MENU_ITEMS.filter(item => ['still-save-article', 'still-select-parts', 'still-save-research'].includes(item.id));
  assert.deepEqual(added.map(item => item.title), ['Save article to Still', 'Select parts of page…', 'Save and research with AI']);
  assert.ok(added.every(item => item.contexts.join() === 'page' && item.documentUrlPatterns.join() === 'http://*/*,https://*/*'));
  for (const type of ['still:capture-article', 'still:start-picker', 'still:picker-result']) assert.ok(MESSAGE_TYPES.includes(type), type);
});

test('still:capture-article previews: two injections pinned to one document, a cleaned article and no broadcast', async () => {
  reset();
  tabs = [pageTab({ id: 11, url: 'https://example.com/preview?utm_source=feed' })];
  article = articleResult({ url: 'https://example.com/preview?utm_source=feed', canonicalUrl: 'https://www.example.com/preview', cover: 'javascript:alert(1)', markdown: 'Body\u0000 text', extra: 'dropped' });
  const reply = await handleMessage({ type: 'still:capture-article', windowId: pageWindow }, self);
  assert.deepEqual(injections.map(entry => entry.files || entry.func), [ARTICLE_SCRIPT_FILES, 'runArticleExtract']);
  assert.deepEqual(injections[0].target, { tabId: 11, frameIds: [0] });
  assert.deepEqual(injections[1].target, { tabId: 11, documentIds: ['doc-11'] }, 'the extractor runs in the document the files loaded into');
  assert.deepEqual(injections[1].args, [{ maxChars: 250000 }]);
  assert.equal(reply.article.ok, true);
  assert.equal(reply.article.markdown, 'Body text');
  assert.equal(reply.article.cover, '');
  assert.equal(reply.article.text, undefined, 'the plain-text copy is not sent');
  assert.equal(reply.article.extra, undefined);
  assert.equal(reply.url, 'https://www.example.com/preview', 'a canonical URL on the same site is used');
  assert.deepEqual([reply.existing, reply.tabId, reply.windowId], [null, 11, pageWindow]);
  assert.equal(sent.length, 0, 'the preview travels in the reply only');
  assert.deepEqual(await byUrl('https://www.example.com/preview'), [], 'a preview saves nothing');
});

test('a canonical URL on another site never becomes the saved address', async () => {
  reset();
  const victim = await store('saveItem', { type: 'article', url: 'https://bank.example.org/statement', title: 'Mine', articleContent: 'Original' });
  tabs = [pageTab({ id: 12, url: 'https://attacker.example.net/page' })];
  article = articleResult({ url: 'https://attacker.example.net/page', canonicalUrl: 'https://bank.example.org/statement', markdown: 'Injected text' });
  const preview = await handleMessage({ type: 'still:capture-article', windowId: pageWindow }, self);
  assert.equal(preview.url, 'https://attacker.example.net/page');
  assert.equal(preview.existing, null);
  const saved = await handleMessage({ type: 'still:capture-article', windowId: pageWindow, save: true }, self);
  assert.equal(saved.url, 'https://attacker.example.net/page');
  assert.equal(saved.created, true);
  const untouched = (await library()).items.find(item => item.id === victim.id);
  assert.equal(untouched.articleContent, 'Original');
});

test('save: true creates an article item with the captured metadata and Markdown', async () => {
  reset();
  tabs = [pageTab({ id: 13, url: 'https://example.com/fresh', title: 'Tab title' })];
  article = articleResult({ url: 'https://example.com/fresh', canonicalUrl: 'https://example.com/fresh' });
  const item = await handleMessage({ type: 'still:capture-article', windowId: pageWindow, save: true, collectionId: 'reading', tags: ['ideas'] }, self);
  assert.deepEqual([item.created, item.updated, item.type, item.url, item.collectionId], [true, false, 'article', 'https://example.com/fresh', 'reading']);
  assert.deepEqual([item.title, item.siteName, item.author, item.publishedAt, item.lang, item.icon, item.cover, item.excerpt],
    ['Linked thinking', 'Example Journal', 'Ada Writer', '2026-10-01T09:00:00.000Z', 'en', 'https://example.com/icon-64.png', 'https://example.com/cover.jpg', 'Why links matter.']);
  assert.equal(item.articleContent, article.markdown);
  assert.equal(item.content, '');
  assert.deepEqual(item.tags, ['ideas']);
  assert.ok(badges.some(badge => badge.text === '✓'));
});

test('re-capturing a saved page refreshes the article text and fills missing metadata only', async () => {
  reset();
  const saved = await store('saveItem', { type: 'bookmark', url: 'https://example.com/again', title: 'My own title', content: 'My note', tags: ['mine'],
    collectionId: 'reading', author: 'Kept Author', excerpt: 'My description' });
  tabs = [pageTab({ id: 14, url: 'https://example.com/again#top' })];
  article = articleResult({ url: 'https://example.com/again', canonicalUrl: 'https://example.com/again', title: 'Page title', author: 'Page Author', markdown: 'Fresh text' });
  const preview = await handleMessage({ type: 'still:capture-article', windowId: pageWindow }, self);
  assert.deepEqual(preview.existing, { id: saved.id, type: 'bookmark', title: 'My own title', url: 'https://example.com/again', collectionId: 'reading', updatedAt: saved.updatedAt });
  const item = await handleMessage({ type: 'still:capture-article', windowId: pageWindow, save: true, collectionId: '', tags: ['new'], title: 'Ignored' }, self);
  assert.equal(item.id, saved.id);
  assert.deepEqual([item.created, item.updated, item.type], [false, true, 'article']);
  assert.deepEqual([item.title, item.content, item.tags, item.collectionId], ['My own title', 'My note', ['mine'], 'reading']);
  assert.deepEqual([item.author, item.excerpt, item.siteName, item.icon], ['Kept Author', 'My description', 'Example Journal', 'https://example.com/icon-64.png']);
  assert.equal(item.articleContent, 'Fresh text');
});

test('a page saved under its tab address is refreshed, not duplicated, when it later declares a canonical URL', async () => {
  reset();
  const saved = await store('saveItem', { type: 'bookmark', url: 'https://example.com/story?id=5', title: 'Story' });
  tabs = [pageTab({ id: 15, url: 'https://example.com/story?id=5' })];
  article = articleResult({ url: 'https://example.com/story?id=5', canonicalUrl: 'https://example.com/stories/5', markdown: 'Story text' });
  const item = await handleMessage({ type: 'still:capture-article', windowId: pageWindow, save: true }, self);
  assert.equal(item.id, saved.id);
  assert.equal(item.url, 'https://example.com/story?id=5');
  assert.deepEqual(await byUrl('https://example.com/stories/5'), []);
});

test('capture-article asks for host access like getPageContext and reports unreadable pages', async () => {
  reset();
  tabs = [pageTab({ id: 16, url: 'https://news.example.org/a' })];
  failInjection = new Error('Cannot access contents of url');
  assert.deepEqual(await handleMessage({ type: 'still:capture-article', windowId: pageWindow }, self), { needsPermission: 'https://news.example.org/*', tabId: 16, windowId: pageWindow });
  granted.add('https://news.example.org/*');
  await assert.rejects(handleMessage({ type: 'still:capture-article', windowId: pageWindow }, self), /Cannot access/);
  tabs = [{ id: 17, windowId: pageWindow, active: true }];
  assert.deepEqual(await handleMessage({ type: 'still:capture-article', windowId: pageWindow }, self), { needsPermission: 'tabs', tabId: 17, windowId: pageWindow });
  failInjection = null;
  tabs = [pageTab({ id: 18, url: 'chrome://extensions' })];
  await assert.rejects(handleMessage({ type: 'still:capture-article' }, self), /web pages only/);
  tabs = [pageTab({ id: 19, url: 'https://example.com/empty' })];
  article = { ok: false, code: 'empty', error: 'This page has no article text.', text: 'x' };
  const reply = await handleMessage({ type: 'still:capture-article', windowId: pageWindow }, self);
  assert.deepEqual(reply.article, { ok: false, code: 'empty', error: 'This page has no article text.' });
  await assert.rejects(handleMessage({ type: 'still:capture-article', windowId: pageWindow, save: true }, self), /no article text/);
  article = 'not an object';
  assert.deepEqual((await handleMessage({ type: 'still:capture-article', windowId: pageWindow }, self)).article, { ok: false, code: 'error', error: 'Still could not read this page.' });
});

test('content-script senders may only report a picker result; never still:store or any other request', async () => {
  reset();
  const page = pageSender(7);
  await assert.rejects(handleMessage({ type: 'still:store', operation: 'exportLibrary', args: [] }, page), /Untrusted/);
  await assert.rejects(handleMessage({ type: 'still:capture-article' }, page), /Untrusted/);
  await assert.rejects(handleMessage({ type: 'openLibrary' }, { ...page, tab: undefined }), /Untrusted/, 'sender.tab is not what makes a content script');
  await assert.rejects(handleMessage({ type: 'still:store', operation: 'exportLibrary', args: [] }, { id: chrome.runtime.id, origin: 'https://example.com' }), /Untrusted/);
  // A full-tab Still page has sender.tab but an extension URL: it stays trusted.
  assert.ok((await handleMessage({ type: 'still:store', operation: 'exportLibrary', args: [] }, { ...self, tab: { id: 3, windowId: 9 } })).items);
  await assert.rejects(handleMessage({ type: 'still:picker-result', requestId: 'x', from: 'panel' }, self), /Only the page picker/);
  const [onMessage] = listener('runtime.onMessage#onMessage'.replace('.onMessage#', '#'));
  const replies = [];
  assert.equal(onMessage({ type: 'still:store', operation: 'exportLibrary', args: [] }, page, response => replies.push(response)), true);
  await waitFor(() => replies.length);
  assert.deepEqual(replies[0], { ok: false, error: 'Untrusted extension message.' });
});

test('still:start-picker injects the picker files, then starts it in the same document with a remembered request id', async () => {
  reset();
  tabs = [pageTab({ id: 21 })];
  const reply = await handleMessage({ type: 'still:start-picker', windowId: pageWindow, from: 'panel' }, self);
  assert.match(reply.requestId, /\S{8,}/);
  assert.deepEqual([reply.tabId, reply.windowId], [21, pageWindow]);
  assert.deepEqual(injections.map(entry => entry.files || entry.func), [PICKER_SCRIPT_FILES, 'startPagePicker']);
  assert.deepEqual(injections[1].target, { tabId: 21, documentIds: ['doc-21'] });
  assert.deepEqual(injections[1].args, [{ requestId: reply.requestId, from: 'panel' }]);
  const record = sessionValues['still.capture.pickers.v1'][reply.requestId];
  assert.deepEqual({ ...record, startedAt: typeof record.startedAt }, { tabId: 21, windowId: pageWindow, from: 'panel', documentId: 'doc-21', startedAt: 'number' });

  pickerReply = { started: false, error: 'This page cannot be selected from.' };
  await assert.rejects(handleMessage({ type: 'still:start-picker', windowId: pageWindow, from: 'menu' }, self), /cannot be selected/);
  assert.equal(Object.keys(sessionValues['still.capture.pickers.v1']).length, 1, 'a picker that did not start is forgotten');
  pickerReply = { started: true };
  failInjection = new Error('Cannot access contents of the page');
  assert.deepEqual(await handleMessage({ type: 'still:start-picker', windowId: pageWindow }, self), { needsPermission: 'https://example.com/*', tabId: 21, windowId: pageWindow });
  failInjection = null;
});

test('picker results are accepted only from the requested tab, frame 0 and document, once', async () => {
  reset();
  tabs = [pageTab({ id: 22, url: 'https://example.com/parts', title: 'Parts page' })];
  const { requestId } = await handleMessage({ type: 'still:start-picker', windowId: pageWindow, from: 'menu' }, self);
  const result = articleResult({ source: 'selection', selectionCount: 2, url: 'https://example.com/parts', canonicalUrl: 'https://example.com/parts', siteName: '', markdown: 'Part one\n\nPart two' });
  const message = { type: 'still:picker-result', requestId, from: 'menu', result };
  const sender = pageSender(22, { url: 'https://example.com/parts' });
  await assert.rejects(handleMessage(message, { ...sender, tab: { id: 99, windowId: pageWindow } }), /did not ask/);
  await assert.rejects(handleMessage(message, { ...sender, frameId: 3 }), /did not ask/);
  await assert.rejects(handleMessage(message, { ...sender, documentId: 'doc-other' }), /did not ask/);
  await assert.rejects(handleMessage({ ...message, requestId: 'made-up' }, sender), /did not ask/);
  const saved = await handleMessage({ ...message, from: 'panel' }, sender);
  assert.equal(saved.saved, true, 'the worker trusts the from it recorded, not the one in the message');
  const [item] = await byUrl('https://example.com/parts');
  assert.deepEqual([item.type, item.articleContent, item.title], ['article', 'Part one\n\nPart two', 'Linked thinking']);
  assert.deepEqual(notifications.at(-1), { id: `still:item:${item.id}`, type: 'basic', iconUrl: 'icons/icon128.png', title: 'Linked thinking', message: 'Saved 2 selections from example.com', priority: 0 });
  assert.ok(badges.some(badge => badge.text === '✓'));
  await assert.rejects(handleMessage(message, sender), /did not ask/, 'a result is accepted once');
  assert.equal(sessionValues['still.capture.pickers.v1'][requestId], undefined);
});

test('a cancelled or empty menu selection saves nothing; a failure notifies', async () => {
  reset();
  tabs = [pageTab({ id: 23, url: 'https://example.com/cancel' })];
  const first = await handleMessage({ type: 'still:start-picker', windowId: pageWindow, from: 'menu' }, self);
  assert.deepEqual(await handleMessage({ type: 'still:picker-result', requestId: first.requestId, from: 'menu', cancelled: true }, pageSender(23)), { cancelled: true });
  const second = await handleMessage({ type: 'still:start-picker', windowId: pageWindow, from: 'menu' }, self);
  const reply = await handleMessage({ type: 'still:picker-result', requestId: second.requestId, from: 'menu', result: { ok: false, code: 'empty', error: 'The selected parts have no text to save.' } }, pageSender(23));
  assert.deepEqual(reply, { saved: false, error: 'The selected parts have no text to save.' });
  assert.equal(notifications.at(-1).id, `still:capture:${second.requestId}`);
  assert.match(notifications.at(-1).message, /no text to save/);
  assert.deepEqual(await byUrl('https://example.com/cancel'), []);
});

test('panel results are left to the side panel; with no panel open they wait in storage.session', async () => {
  reset();
  tabs = [pageTab({ id: 24, url: 'https://example.com/panel-parts' })];
  const result = articleResult({ source: 'selection', selectionCount: 1, url: 'https://example.com/panel-parts', markdown: 'Picked' });
  sidePanels = [{ contextType: 'SIDE_PANEL', windowId: pageWindow }];
  const open = await handleMessage({ type: 'still:start-picker', windowId: pageWindow, from: 'panel' }, self);
  assert.deepEqual(await handleMessage({ type: 'still:picker-result', requestId: open.requestId, from: 'panel', result }, pageSender(24)), { received: true, stashed: false });
  sidePanels = [];
  const closed = await handleMessage({ type: 'still:start-picker', windowId: pageWindow, from: 'panel' }, self);
  assert.deepEqual(await handleMessage({ type: 'still:picker-result', requestId: closed.requestId, from: 'panel', result }, pageSender(24)), { received: true, stashed: true });
  const draft = sessionValues[PANEL_DRAFTS_KEY][closed.requestId];
  assert.deepEqual([draft.windowId, draft.tabId, draft.article.markdown, draft.article.text], [pageWindow, 24, 'Picked', undefined]);
  assert.deepEqual(await byUrl('https://example.com/panel-parts'), [], 'the worker never saves a panel selection');
});

test('Save article to Still opens the panel in the click and saves; without an article it saves the page as before', async () => {
  reset();
  await store('updateSettings', { openPanelOnSave: true });
  const [onClicked] = listener('contextMenus#onClicked');
  article = articleResult({ url: 'https://example.com/menu-article', canonicalUrl: 'https://example.com/menu-article', markdown: 'From the menu' });
  onClicked({ menuItemId: 'still-save-article', pageUrl: 'https://example.com/menu-article' }, pageTab({ id: 31, url: 'https://example.com/menu-article' }));
  assert.deepEqual(opened, [{ windowId: pageWindow }], 'side panel opens inside the gesture');
  const [item] = await waitFor(() => byUrl('https://example.com/menu-article').then(list => list.length && list));
  assert.deepEqual([item.type, item.articleContent], ['article', 'From the menu']);

  article = { ok: false, code: 'empty', error: 'Nothing here' };
  onClicked({ menuItemId: 'still-save-article', pageUrl: 'https://example.com/no-article' }, pageTab({ id: 32, url: 'https://example.com/no-article' }));
  const [page] = await waitFor(() => byUrl('https://example.com/no-article').then(list => list.length && list));
  assert.deepEqual([page.type, page.title], ['bookmark', 'Fallback title']);
});

test('Save and research with AI opens the panel even when saves are quiet, then delivers still:research', async () => {
  reset();
  await store('updateSettings', { openPanelOnSave: false });
  await waitFor(async () => (await library()).settings.openPanelOnSave === false);
  respond = message => (message.type === 'still:research' ? { ok: true } : undefined);
  const [onClicked] = listener('contextMenus#onClicked');
  article = articleResult({ url: 'https://example.com/research-me', canonicalUrl: 'https://example.com/research-me', markdown: 'Research text' });
  onClicked({ menuItemId: 'still-save-research', pageUrl: 'https://example.com/research-me' }, pageTab({ id: 33, url: 'https://example.com/research-me' }));
  assert.deepEqual(opened, [{ windowId: pageWindow }]);
  const message = await waitFor(() => sent.find(value => value.type === 'still:research'));
  const [item] = await byUrl('https://example.com/research-me');
  assert.deepEqual(Object.keys(message).sort(), ['itemId', 'requestId', 'type', 'windowId']);
  assert.deepEqual([message.itemId, message.windowId, item.articleContent], [item.id, pageWindow, 'Research text']);
  assert.equal(createdTabs.length, 0);
  await store('updateSettings', { openPanelOnSave: true });
});

test('Save and research falls back to opening the item when no side panel answers', async () => {
  reset();
  const [onClicked] = listener('contextMenus#onClicked');
  article = articleResult({ url: 'https://example.com/research-tab', canonicalUrl: 'https://example.com/research-tab', markdown: 'Text' });
  onClicked({ menuItemId: 'still-save-research', pageUrl: 'https://example.com/research-tab' }, pageTab({ id: 34, url: 'https://example.com/research-tab' }));
  const [tab] = await waitFor(() => createdTabs.length && createdTabs, 5000);
  const [item] = await byUrl('https://example.com/research-tab');
  assert.equal(tab.url, `chrome-extension://test-extension/index.html?item=${item.id}`);
  assert.equal(sent.filter(value => value.type === 'still:research').length, 9);
});

test('Select parts of page… starts the picker for the menu without opening the side panel', async () => {
  reset();
  const [onClicked] = listener('contextMenus#onClicked');
  onClicked({ menuItemId: 'still-select-parts', pageUrl: 'https://example.com/pick' }, pageTab({ id: 35, url: 'https://example.com/pick' }));
  await waitFor(() => injections.length === 2);
  assert.deepEqual(opened, []);
  assert.equal(injections[1].args[0].from, 'menu');
  const record = sessionValues['still.capture.pickers.v1'][injections[1].args[0].requestId];
  assert.deepEqual([record.tabId, record.from], [35, 'menu']);
});

test('clicking a saved-selection notification opens the item; an error notification only closes', async () => {
  reset();
  const [onNotification] = listener('notifications#onClicked');
  onNotification('still:item:abc');
  await waitFor(() => createdTabs.length);
  assert.equal(createdTabs[0].url, 'chrome-extension://test-extension/index.html?item=abc');
  onNotification('still:capture:xyz');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(createdTabs.length, 1);
});

test('an article saved under a canonical URL is still recognized as saved on its original tab sourceUrl', async () => {
  reset();
  granted.add('tabs');
  tabs = [pageTab({ id: 40, url: 'https://example.com/p/short-link', title: 'Short link' })];
  article = articleResult({ url: 'https://example.com/p/short-link', canonicalUrl: 'https://example.com/posts/full-canonical', markdown: 'First capture' });
  const saved = await handleMessage({ type: 'still:capture-article', windowId: pageWindow, save: true }, self);
  assert.equal(saved.created, true);
  assert.equal(saved.url, 'https://example.com/posts/full-canonical');
  assert.equal(saved.sourceUrl, 'https://example.com/p/short-link');

  const activeTab = await handleMessage({ type: 'getActiveTab', windowId: pageWindow }, self);
  assert.equal(activeTab.saved, true, 'getActiveTab matches item.sourceUrl');
  assert.equal(activeTab.itemId, saved.id);

  const listed = await handleMessage({ type: 'listTabs', windowId: pageWindow }, self);
  assert.equal(listed[0].saved, true, 'listTabs matches item.sourceUrl');

  article = articleResult({ url: 'https://example.com/p/short-link', canonicalUrl: 'https://example.com/posts/full-canonical', markdown: 'Updated capture' });
  const preview = await handleMessage({ type: 'still:capture-article', windowId: pageWindow }, self);
  assert.equal(preview.existing?.id, saved.id, 'still:capture-article finds the saved item by sourceUrl too');

  // "Save page" and "Save all tabs" on that tab update the article at its canonical address instead of adding a copy.
  const resaved = await handleMessage({ type: 'captureCurrent', windowId: pageWindow }, self);
  assert.deepEqual([resaved.id, resaved.created, resaved.type, resaved.url], [saved.id, false, 'article', 'https://example.com/posts/full-canonical']);
  assert.equal(resaved.articleContent, 'First capture', 'the saved article text stays');
  const tabSave = await handleMessage({ type: 'saveTabs', windowId: pageWindow, tabIds: [40] }, self);
  assert.deepEqual([tabSave.created, tabSave.itemIds], [0, [saved.id]]);
  const copies = (await library()).items.filter(item => !item.deletedAt && /short-link|full-canonical/.test(item.url));
  assert.deepEqual(copies.map(item => item.id), [saved.id], 'one item for the page');
});

test('a link or image saved from a page does not count as saving that page', async () => {
  reset();
  granted.add('tabs');
  const listing = pageTab({ id: 41, url: 'https://example.com/listing', title: 'Listing' });
  tabs = [listing];
  const link = await captureTab(listing, { menuItemId: 'still-save-link', pageUrl: 'https://example.com/listing', linkUrl: 'https://elsewhere.example/story' });
  const image = await captureTab(listing, { menuItemId: 'still-save-image', pageUrl: 'https://example.com/listing', srcUrl: 'https://cdn.example/photo.png', mediaType: 'image' });
  assert.deepEqual([link.sourceUrl, image.sourceUrl], ['https://example.com/listing', 'https://example.com/listing']);
  const active = await handleMessage({ type: 'getActiveTab', windowId: pageWindow }, self);
  assert.deepEqual([active.saved, active.itemId], [false, '']);
  assert.equal((await handleMessage({ type: 'listTabs', windowId: pageWindow }, self))[0].saved, false);
  const page = await handleMessage({ type: 'captureCurrent', windowId: pageWindow }, self);
  assert.equal(page.created, true, 'saving the page adds the page');
  assert.ok(![link.id, image.id].includes(page.id), 'and leaves the link and the image as they were');
  assert.equal(page.url, 'https://example.com/listing');
  assert.equal((await handleMessage({ type: 'getActiveTab', windowId: pageWindow }, self)).itemId, page.id);
});
