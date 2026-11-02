import test from 'node:test';
import assert from 'node:assert/strict';

const events = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); }, removeListener(listener) { this.listeners = this.listeners.filter(l => l !== listener); } });
const values = {};
const menus = [];
const opened = [];
const sent = [];
const badges = [];
const granted = new Set();
const pageWindow = 1;
let tabs = [];
let respond = () => undefined;
let pageScript = details => [{ result: { title: 'Metadata title', url: 'https://example.com/post', excerpt: 'About the post', articleText: 'Readable body' } }];
const chrome = {
  runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`, onMessage: events(), onInstalled: events(), onStartup: events(),
    sendMessage: async message => { sent.push(message); return respond(message); } },
  storage: { local: { get: async key => ({ [key]: structuredClone(values[key]) }), set: async patch => { Object.assign(values, structuredClone(patch)); } }, onChanged: events() },
  contextMenus: {
    removeAll: async () => { menus.length = 0; },
    create: item => { if (menus.some(menu => menu.id === item.id)) throw new Error(`duplicate ${item.id}`); menus.push(item); return item.id; },
    remove: async id => {
      if (!menus.some(menu => menu.id === id)) throw new Error(`Cannot find menu item with id ${id}`);
      const doomed = new Set([id]);
      for (const menu of menus) if (doomed.has(menu.parentId)) doomed.add(menu.id);
      for (let index = menus.length - 1; index >= 0; index--) if (doomed.has(menus[index].id)) menus.splice(index, 1);
    },
    onClicked: events(),
  },
  tabs: {
    query: async query => tabs.filter(tab => (query.active === undefined || tab.active === query.active)
      && (query.windowId === undefined || tab.windowId === query.windowId) && (!query.currentWindow || tab.windowId === pageWindow)),
    get: async id => { const tab = tabs.find(value => value.id === id); if (!tab) throw new Error('No tab'); return tab; },
    create: async tab => tab, onActivated: events(), onUpdated: events(),
  },
  windows: { onFocusChanged: events() },
  scripting: { executeScript: async details => pageScript(details) },
  action: { setBadgeText: async details => { badges.push(details); }, setBadgeBackgroundColor: async () => {} },
  sidePanel: { open: options => { opened.push(options); return Promise.resolve(); }, setPanelBehavior: async () => {} },
  alarms: { getAll: async () => [], create: async () => {}, clear: async () => true, onAlarm: events() },
  commands: { onCommand: events() },
  notifications: { create: async () => {}, clear: async () => {}, onClicked: events() },
  permissions: {
    contains: async ({ permissions = [], origins = [] }) => [...permissions, ...origins].every(value => granted.has(value)),
    onAdded: events(), onRemoved: events(),
  },
};
globalThis.chrome = chrome;
const background = await import('../extension/background.js');
const { installMenus, installCollectionMenus, captureTab, handleMessage, MESSAGE_TYPES } = background;

const self = { id: chrome.runtime.id };
const store = (operation, ...args) => handleMessage({ type: 'still:store', operation, args }, self);
const library = () => store('exportLibrary');
const byUrl = async url => (await library()).items.find(item => item.url === url && item.type !== 'note');
const waitFor = async (check, timeout = 3000) => {
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
const pageTab = (extra = {}) => ({ id: 7, windowId: pageWindow, active: true, title: 'A page', url: 'https://example.com/post', favIconUrl: 'https://example.com/icon.png', ...extra });

await store('createCollection', { id: 'design', name: 'Design', pinned: true });
await store('createCollection', { id: 'inspiration', name: 'Inspiration', parentId: 'design' });
await store('createCollection', { id: 'reading', name: 'Reading' });

test('the message allowlist covers every new request type', () => {
  for (const type of ['saveTabs', 'getActiveTab', 'getPageContext', 'listTabs', 'captureCurrent', 'saveCurrentTab', 'still:capture-current', 'openSidePanel',
    'still:capture-article', 'still:start-picker', 'still:picker-result']) {
    assert.ok(MESSAGE_TYPES.includes(type), type);
  }
  const [onMessage] = listener('runtime.onMessage#onMessage'.replace('.onMessage#', '#'));
  for (const type of ['saveTabs', 'getActiveTab', 'getPageContext', 'listTabs']) {
    assert.equal(onMessage({ type }, { id: 'other-extension' }, () => {}), true, type);
  }
  assert.equal(onMessage({ type: 'still:open-add' }, self, () => {}), false);
  assert.equal(onMessage({ type: 'unknown' }, self, () => {}), false);
});

test('collection menus list Inbox, ranked collections with paths, a separator and Choose collection for page, link and image', async () => {
  values['still.ui.recent.v1'] = { recentCollections: ['reading', 'missing', 'long'] };
  const at = minutes => new Date(Date.UTC(2026, 9, 1, 12, minutes)).toISOString();
  const snapshot = {
    collections: [
      { id: 'design', name: 'Design', parentId: '', pinned: true, updatedAt: at(1) },
      { id: 'inspiration', name: 'Inspiration', parentId: 'design', pinned: true, updatedAt: at(2) },
      { id: 'reading', name: 'Reading', parentId: '', updatedAt: at(3) },
      { id: 'long', name: 'A very long collection name that keeps going', parentId: 'design', updatedAt: at(4) },
      ...Array.from({ length: 10 }, (_, index) => ({ id: `p${index + 1}`, name: `Project ${index + 1}`, parentId: '', updatedAt: at(10 + index) })),
    ],
    items: [{ id: 'i1', collectionId: 'p3', updatedAt: at(30) }, { id: 'i2', collectionId: 'p7', updatedAt: at(40) }],
  };
  await installMenus();
  assert.equal(await installCollectionMenus(snapshot), true);
  const topLevel = menus.filter(menu => !menu.parentId).map(menu => menu.id);
  assert.deepEqual(topLevel.slice(-3), ['still-save-page-to', 'still-save-link-to', 'still-save-image-to']);
  assert.equal(topLevel.length, 14, 'eight original items, three capture items (contract §5) and the three parents');
  const children = parentId => menus.filter(menu => menu.parentId === parentId);
  const page = children('still-save-page-to');
  assert.deepEqual(page.map(menu => menu.id), ['__inbox', 'reading', 'long', 'design', 'inspiration', 'p7', 'p3', 'p10', 'p9', 'p8', 'p6', '__separator', '__choose']
    .map(id => `still-save-to:page:${id}`));
  assert.deepEqual(page.slice(0, 5).map(menu => menu.title), ['Inbox', 'Reading', '… › A very long collection name that ke…', 'Design', 'Design › Inspiration']);
  assert.ok(page.every(menu => !menu.title || [...menu.title].length <= 40));
  assert.equal(page.at(-2).type, 'separator');
  assert.equal(page.at(-1).title, 'Choose collection…');
  assert.ok(page.every(menu => menu.contexts.join() === 'page' && menu.documentUrlPatterns.length === 2));
  assert.ok(children('still-save-link-to').every(menu => menu.contexts.join() === 'link' && menu.targetUrlPatterns.length === 2));
  assert.equal(children('still-save-image-to').length, 13);
  assert.equal(await installCollectionMenus(snapshot), false, 'unchanged collections are not rebuilt');
  snapshot.collections[2].name = 'Reading list';
  assert.equal(await installCollectionMenus(snapshot), true);
  assert.equal(children('still-save-page-to')[1].title, 'Reading list');
  assert.equal(menus.length, 14 + 3 * 13);
});

test('a Save page to child saves into that collection, shows the check badge and records the collection as recent', async () => {
  values['still.ui.recent.v1'] = { recentCollections: ['reading'], other: true };
  opened.length = 0; badges.length = 0;
  const [onClicked] = listener('contextMenus#onClicked');
  onClicked({ menuItemId: 'still-save-to:page:inspiration', pageUrl: 'https://example.com/post' }, pageTab());
  assert.deepEqual(opened, [{ windowId: pageWindow }], 'side panel opens inside the gesture');
  const item = await waitFor(() => byUrl('https://example.com/post'));
  assert.equal(item.collectionId, 'inspiration');
  assert.equal(item.title, 'Metadata title');
  assert.equal(item.articleContent, 'Readable body');
  assert.ok(badges.some(badge => badge.text === '✓'));
  await waitFor(() => values['still.ui.recent.v1'].recentCollections[0] === 'inspiration');
  assert.deepEqual(values['still.ui.recent.v1'], { recentCollections: ['inspiration', 'reading'], other: true });

  onClicked({ menuItemId: 'still-save-to:link:__inbox', pageUrl: 'https://example.com/post', linkUrl: 'https://elsewhere.example/a', selectionText: 'Elsewhere A' }, pageTab());
  const link = await waitFor(() => byUrl('https://elsewhere.example/a'));
  assert.deepEqual([link.collectionId, link.title, link.type, link.articleContent], ['', 'Elsewhere A', 'bookmark', '']);

  onClicked({ menuItemId: 'still-save-to:image:design', pageUrl: 'https://example.com/post', srcUrl: 'https://cdn.example.com/photo.png', mediaType: 'image' }, pageTab());
  const image = await waitFor(() => byUrl('https://cdn.example.com/photo.png'));
  assert.deepEqual([image.type, image.collectionId, image.cover], ['image', 'design', 'https://cdn.example.com/photo.png']);
});

test('Choose collection opens the side panel synchronously and retries still:open-add until the panel answers', async () => {
  opened.length = 0; sent.length = 0;
  let calls = 0;
  respond = message => (message.type === 'still:open-add' && ++calls >= 3 ? { ok: true } : undefined);
  const [onClicked] = listener('contextMenus#onClicked');
  onClicked({ menuItemId: 'still-save-to:link:__choose', pageUrl: 'https://example.com/post', linkUrl: 'https://elsewhere.example/b', selectionText: ' Link  B ' }, pageTab());
  assert.deepEqual(opened, [{ windowId: pageWindow }]);
  await waitFor(() => calls >= 3);
  await new Promise(resolve => setTimeout(resolve, 400));
  const requests = sent.filter(message => message.type === 'still:open-add');
  assert.equal(requests.length, 3, 'stops once the panel confirms');
  assert.deepEqual(requests[0].payload, { url: 'https://elsewhere.example/b', title: 'Link B', kind: 'link', sourceUrl: 'https://example.com/post' });
  assert.equal(requests[0].windowId, pageWindow);
  assert.ok(requests.every(message => message.requestId === requests[0].requestId), 'one request id so the panel can ignore repeats');
  assert.equal(await byUrl('https://elsewhere.example/b'), undefined, 'choosing does not save by itself');
  respond = () => undefined;
});

test('captureCurrent accepts collection, tags, note and title, reports created and falls back to Inbox for a missing collection', async () => {
  tabs = [pageTab({ id: 21, url: 'https://example.com/notes-rule', title: 'Rule page' })];
  pageScript = () => [{ result: { title: 'Rule page', url: 'https://example.com/notes-rule', excerpt: 'Desc' } }];
  const first = await handleMessage({ type: 'captureCurrent', windowId: pageWindow, collectionId: 'gone', tags: ['a'], note: 'First thought' }, self);
  assert.equal(first.created, true);
  assert.equal(first.collectionFallback, true);
  assert.equal(first.collectionId, '');
  assert.equal(first.content, 'First thought');
  const second = await handleMessage({ type: 'saveCurrentTab', payload: { collectionId: 'reading', tags: ['b'], note: 'Second thought', windowId: pageWindow } }, self);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(second.collectionFallback, undefined);
  assert.equal(second.collectionId, 'reading');
  assert.equal(second.content, 'First thought', 'an existing note is never replaced');
  assert.deepEqual(second.tags, ['a', 'b']);
  await store('updateItem', first.id, { content: '' });
  const third = await handleMessage({ type: 'still:capture-current', note: 'Fills the empty note', title: 'Named in the dialog' }, self);
  assert.equal(third.content, 'Fills the empty note');
  assert.equal(third.title, 'Named in the dialog');
  assert.equal(third.collectionId, 'reading', 'a quick save leaves a saved item where it is');
});

test('quick saves without a collection use settings.defaultCollectionId for new items only', async () => {
  await store('updateSettings', { defaultCollectionId: 'design' });
  tabs = [pageTab({ id: 22, url: 'https://example.com/default-target', title: 'Default target' })];
  pageScript = () => { throw new Error('Cannot access contents of the page'); };
  const item = await handleMessage({ type: 'captureCurrent' }, self);
  assert.equal(item.collectionId, 'design');
  assert.equal(item.title, 'Default target');
  const inbox = await handleMessage({ type: 'captureCurrent', collectionId: '' }, self);
  assert.equal(inbox.collectionId, 'design', 'Inbox on an existing item keeps its collection (dedupe)');
  await store('updateSettings', { defaultCollectionId: '' });
});

test('saving a link onto an already saved page keeps the page title instead of the raw link URL', async () => {
  pageScript = () => [{ result: { title: 'The real title', url: 'https://example.com/keep-title', articleText: 'Text' } }];
  const page = await captureTab(pageTab({ id: 23, url: 'https://example.com/keep-title' }), { menuItemId: 'still-save-page', pageUrl: 'https://example.com/keep-title' });
  assert.equal(page.title, 'The real title');
  const relinked = await captureTab(pageTab({ id: 24, url: 'https://example.com/other' }),
    { menuItemId: 'still-save-link', pageUrl: 'https://example.com/other', linkUrl: 'https://example.com/keep-title?utm_source=feed' });
  assert.equal(relinked.id, page.id);
  assert.equal(relinked.created, false);
  assert.equal(relinked.title, 'The real title');
  assert.equal(relinked.articleContent, 'Text', 'the article snapshot stays');
});

test('captureCurrent asks for the tabs permission when the tab URL is unreadable', async () => {
  tabs = [{ id: 30, windowId: pageWindow, active: true }];
  assert.deepEqual(await handleMessage({ type: 'captureCurrent' }, self), { needsPermission: 'tabs', tabId: 30, windowId: pageWindow });
});

test('getActiveTab reports the tab only when its URL is readable', async () => {
  tabs = [{ id: 31, windowId: pageWindow, active: true }];
  assert.deepEqual(await handleMessage({ type: 'getActiveTab', windowId: pageWindow }, self), { granted: false, tabId: 31, windowId: pageWindow });
  tabs = [pageTab({ id: 32, url: 'https://example.com/keep-title#section' })];
  const tab = await handleMessage({ type: 'getActiveTab' }, self);
  assert.equal(tab.granted, true);
  assert.equal(tab.saved, true);
  assert.equal(tab.itemId, (await byUrl('https://example.com/keep-title')).id);
  assert.equal(tab.favIconUrl, 'https://example.com/icon.png');
  tabs = [pageTab({ id: 33, url: 'https://example.com/unsaved' })];
  assert.equal((await handleMessage({ type: 'getActiveTab' }, self)).saved, false);
});

test('getPageContext returns readable text or the host permission the UI must request', async () => {
  tabs = [pageTab({ id: 40, url: 'https://news.example.org:8443/story' })];
  pageScript = () => { throw new Error('Cannot access contents of url'); };
  assert.deepEqual(await handleMessage({ type: 'getPageContext' }, self), { needsPermission: 'https://news.example.org/*', tabId: 40, windowId: pageWindow });
  granted.add('https://news.example.org/*');
  await assert.rejects(handleMessage({ type: 'getPageContext', tabId: 40 }, self), /Cannot access/);
  let injected;
  pageScript = details => { injected = details; return [{ result: { url: 'https://news.example.org:8443/story', title: 'Story', excerpt: 'Lede', cover: '/img/c.jpg', selection: 'quote', text: 'x'.repeat(130000), truncated: true, lang: 'en' } }]; };
  const context = await handleMessage({ type: 'getPageContext', tabId: 40 }, self);
  assert.equal(injected.func.name, 'readPageContext');
  assert.deepEqual(injected.args, [120000]);
  assert.equal(context.text.length, 120000);
  assert.deepEqual([context.title, context.cover, context.selection, context.lang, context.truncated], ['Story', 'https://news.example.org:8443/img/c.jpg', 'quote', 'en', true]);
  tabs = [{ id: 41, windowId: pageWindow, active: true }];
  pageScript = () => { throw new Error('Cannot access'); };
  assert.deepEqual(await handleMessage({ type: 'getPageContext' }, self), { needsPermission: 'tabs', tabId: 41, windowId: pageWindow });
  tabs = [pageTab({ id: 42, url: 'chrome://settings' })];
  await assert.rejects(handleMessage({ type: 'getPageContext' }, self), /web pages only/);
});

test('saveTabs and listTabs need the tabs permission, then save every web tab once into a new collection', async () => {
  granted.delete('tabs');
  assert.deepEqual(await handleMessage({ type: 'saveTabs', newCollectionName: 'Session' }, self), { needsPermission: 'tabs' });
  assert.deepEqual(await handleMessage({ type: 'listTabs' }, self), { needsPermission: 'tabs' });
  assert.equal((await library()).collections.some(collection => collection.name === 'Session'), false, 'no collection before permission');
  granted.add('tabs');
  tabs = [
    pageTab({ id: 50, url: 'https://example.com/keep-title', title: 'Tab title must not replace it' }),
    pageTab({ id: 51, active: false, url: 'https://tabs.example/one', title: 'One' }),
    pageTab({ id: 52, active: false, url: 'https://tabs.example/one#again', title: 'One again' }),
    pageTab({ id: 53, active: false, url: 'chrome://extensions', title: 'Extensions' }),
    pageTab({ id: 54, active: false, url: 'https://www.youtube.com/watch?v=1', title: 'Video' }),
    pageTab({ id: 60, windowId: 2, url: 'https://other-window.example/', title: 'Elsewhere' }),
  ];
  const listed = await handleMessage({ type: 'listTabs', windowId: pageWindow }, self);
  assert.deepEqual(listed.map(tab => [tab.tabId, tab.saved]), [[50, true], [51, false], [52, false], [54, false]]);
  const result = await handleMessage({ type: 'saveTabs', windowId: pageWindow, newCollectionName: ' Session ', tags: ['session'] }, self);
  const session = (await library()).collections.find(collection => collection.name === 'Session');
  assert.deepEqual({ ...result, itemIds: result.itemIds.length }, { saved: 3, created: 2, skipped: 2, collectionId: session.id, itemIds: 3 });
  const state = await library();
  const saved = result.itemIds.map(id => state.items.find(item => item.id === id));
  assert.ok(saved.every(item => item.collectionId === session.id && item.tags.includes('session')));
  assert.deepEqual(saved.map(item => [item.title, item.type]), [['The real title', 'article'], ['One', 'bookmark'], ['Video', 'video']]);
  const picked = await handleMessage({ type: 'saveTabs', tabIds: [60], collectionId: 'reading' }, self);
  assert.deepEqual([picked.saved, picked.created, picked.collectionId], [1, 1, 'reading']);
});

test('openSidePanel opens the panel for the sender window', async () => {
  opened.length = 0;
  assert.deepEqual(await handleMessage({ type: 'openSidePanel' }, { ...self, tab: { id: 3, windowId: 9 } }), { opened: true, windowId: 9 });
  assert.deepEqual(await handleMessage({ type: 'still:open-sidepanel', windowId: 4 }, self), { opened: true, windowId: 4 });
  tabs = [pageTab({ id: 70, windowId: pageWindow })];
  await handleMessage({ type: 'openSidePanel' }, self);
  assert.deepEqual(opened, [{ windowId: 9 }, { windowId: 4 }, { windowId: pageWindow }]);
});

test('granting tabs starts the saved-page dot and live active-tab broadcasts without a reload', async () => {
  assert.equal(listener('tabs#onActivated').length, 0);
  listener('permissions#onAdded')[0]({ permissions: ['tabs'] });
  assert.equal(listener('tabs#onActivated').length, 1);
  assert.equal(listener('windows#onFocusChanged').length, 1);
  badges.length = 0; sent.length = 0;
  tabs = [pageTab({ id: 80, url: 'https://example.com/keep-title' }), pageTab({ id: 81, active: false, url: 'https://example.com/unsaved-tab' })];
  listener('tabs#onActivated')[0]({ tabId: 80, windowId: pageWindow });
  await waitFor(() => badges.some(badge => badge.tabId === 80));
  assert.deepEqual(badges.find(badge => badge.tabId === 80), { tabId: 80, text: '•' });
  const broadcast = await waitFor(() => sent.find(message => message.type === 'still:active-tab'));
  assert.deepEqual(broadcast.tab, { tabId: 80, windowId: pageWindow, url: 'https://example.com/keep-title', title: 'A page',
    favIconUrl: 'https://example.com/icon.png', saved: true, itemId: (await byUrl('https://example.com/keep-title')).id });
  listener('tabs#onUpdated')[0](81, { status: 'complete' }, tabs[1]);
  await waitFor(() => badges.some(badge => badge.tabId === 81));
  assert.deepEqual(badges.find(badge => badge.tabId === 81), { tabId: 81, text: null });
  assert.equal(sent.filter(message => message.type === 'still:active-tab').length, 1, 'background tabs update the badge without a broadcast');
  listener('permissions#onRemoved')[0]({ permissions: ['tabs'] });
  assert.equal(listener('tabs#onActivated').length, 0);
});

test('the new-note command opens the side panel and creates a note linked to the current page', async () => {
  opened.length = 0; sent.length = 0;
  respond = message => (message.type === 'still:open-note' ? { ok: true } : undefined);
  const source = await byUrl('https://example.com/keep-title');
  listener('commands#onCommand')[0]('new-note', pageTab({ id: 90, url: 'https://example.com/keep-title', title: 'Keep title page' }));
  assert.deepEqual(opened, [{ windowId: pageWindow }]);
  const message = await waitFor(() => sent.find(value => value.type === 'still:open-note'));
  const note = (await library()).items.find(item => item.id === message.id);
  assert.deepEqual([note.type, note.title, note.url, note.relatedIds, note.collectionId],
    ['note', 'Notes on Keep title page', 'https://example.com/keep-title', [source.id], source.collectionId]);
  respond = () => undefined;
});
