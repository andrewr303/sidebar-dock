// Side-panel capture UI (build contracts §5): the article preview in the Add dialog, its pure helpers, the picker
// message check, the saved state with "Research with AI", the This page buttons and the command palette entries.
import test from 'node:test';
import assert from 'node:assert/strict';

// The overlay module needs a document and a window-level addEventListener; nothing here touches a real DOM. Document
// listeners are recorded, so a test can fire a click the way the browser would.
const documentListeners = [];
globalThis.document ??= { activeElement: null, body: {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener: (type, listener, options) => { documentListeners.push({ type, listener, options }); } };
globalThis.addEventListener ??= () => {};

const {
  applyCapture, applyMeta, linkSave, contentStats, contentSummary, previewSource, acceptPickerMessage, pickPanelDraft, renderPickerStatus,
  openAdd, openCaptureMenu, init, PREVIEW_CHARS,
} = await import('../extension/ui/quick-add.js');
const { renderCaptureActions } = await import('../extension/ui/page.js');
const { COMMANDS, rankCommands } = await import('../extension/ui/command.js');
const { initOverlays, openDialog, closeDialog, renderOverlays } = await import('../extension/ui/overlay.js');
const { registerActions, dispatch, hasAction } = await import('../extension/ui/runtime.js');
const { normalizeArticleResult } = await import('../extension/lib/capture.js');
const { parseNoteBlocks } = await import('../extension/lib/markdown.js');

const draftOf = (extra = {}) => ({ id: 1, type: 'link', itemType: '', url: 'https://example.com/a', title: '', excerpt: '', cover: '', note: '', collectionId: '',
  tags: [], favorite: false, reminderAt: null, sourceUrl: '', articleContent: '', icon: '', iconFailed: '', capture: null, replaceArticle: false,
  touched: new Set(), coverFailed: '', updateId: '', ...extra });
const article = (extra = {}) => normalizeArticleResult({ ok: true, source: 'readability', url: 'https://example.com/a', canonicalUrl: 'https://example.com/a',
  title: 'Captured title', siteName: 'Example', author: 'Ada', publishedAt: '2026-10-01T00:00:00.000Z', lang: 'en', excerpt: 'Captured excerpt',
  icon: 'https://example.com/icon.png', cover: 'https://example.com/cover.jpg', markdown: '# Heading\nBody text with words.', wordCount: 1240, truncated: false, ...extra });

test('a capture fills only what the user has not typed and marks the draft as an explicit article capture', () => {
  const d = draftOf({ title: 'Typed', touched: new Set(['title']) });
  applyCapture(d, article({ selectionCount: 3 }), { source: 'parts', tabId: 7 });
  assert.equal(d.title, 'Typed');
  assert.deepEqual([d.excerpt, d.cover, d.icon, d.itemType, d.replaceArticle, d.articleContent], ['Captured excerpt', 'https://example.com/cover.jpg',
    'https://example.com/icon.png', 'article', true, '# Heading\nBody text with words.']);
  assert.deepEqual(d.capture, { source: 'parts', wordCount: 1240, truncated: false, selectionCount: 3, siteName: 'Example', author: 'Ada',
    publishedAt: '2026-10-01T00:00:00.000Z', lang: 'en', icon: 'https://example.com/icon.png', pageUrl: 'https://example.com/a', tabId: 7 });
  assert.equal(applyCapture(draftOf(), { ok: false }).capture, null, 'a failed result changes nothing');
});

test('applyMeta never overwrites captured Markdown with plain page text', () => {
  const d = applyCapture(draftOf(), article());
  applyMeta(d, { title: 'Meta title', text: 'plain '.repeat(200) });
  assert.equal(d.articleContent, '# Heading\nBody text with words.');
  assert.equal(d.title, 'Captured title', 'details read later for the same page do not replace the captured ones');
  const plain = draftOf();
  applyMeta(plain, { text: 'plain '.repeat(200) });
  assert.match(plain.articleContent, /^plain/, 'a plain link still keeps long page text');
  applyMeta(plain, { text: 'short' });
  assert.match(plain.articleContent, /^plain/);
});

test('update mode replaces saved article text only for an explicit capture and fills missing metadata', () => {
  const existing = { id: 'i1', type: 'bookmark', title: 'Saved', url: 'https://example.com/a', articleContent: 'Old text', icon: '', author: 'Kept', updatedAt: 'stamp' };
  const captured = applyCapture(draftOf({ updateId: 'i1', title: 'Saved', touched: new Set(['title']) }), article());
  const write = linkSave(captured, 'https://example.com/a', existing);
  assert.deepEqual([write.id, write.expectedUpdatedAt], ['i1', 'stamp']);
  assert.deepEqual([write.patch.articleContent, write.patch.type, write.patch.icon, write.patch.author, write.patch.siteName, write.patch.lang],
    ['# Heading\nBody text with words.', 'article', 'https://example.com/icon.png', undefined, 'Example', 'en']);
  const fetched = linkSave(draftOf({ updateId: 'i1', title: 'Saved', articleContent: 'Fetched plain text' }), 'https://example.com/a', existing);
  assert.equal(fetched.patch.articleContent, undefined, 'page details fetched for an edit never replace saved text');
  const cleared = linkSave(applyCapture(draftOf({ updateId: 'i1', icon: '', touched: new Set(['icon']) }), article()), 'https://example.com/a', { ...existing, icon: 'https://old/icon.png' });
  assert.equal(cleared.patch.icon, '', 'choosing the site icon clears a stored page icon');
  const kept = linkSave(applyCapture(draftOf({ updateId: 'i1' }), article()), 'https://example.com/a', { ...existing, icon: 'https://old/icon.png' });
  assert.equal(kept.patch.icon, undefined);
});

test('a new article save carries the icon and page metadata', () => {
  const d = applyCapture(draftOf({ collectionId: 'reading', tags: ['a'], note: 'Mine' }), article());
  const { input } = linkSave(d, 'https://example.com/a', null);
  assert.deepEqual(input, { url: 'https://example.com/a', excerpt: 'Captured excerpt', cover: 'https://example.com/cover.jpg', content: 'Mine', collectionId: 'reading',
    tags: ['a'], articleContent: '# Heading\nBody text with words.', sourceUrl: '', icon: 'https://example.com/icon.png', siteName: 'Example', author: 'Ada',
    publishedAt: '2026-10-01T00:00:00.000Z', lang: 'en', title: 'Captured title', type: 'article' });
  d.iconFailed = d.icon;
  assert.equal(linkSave(d, 'https://example.com/a').input.icon, undefined, 'an icon that failed to load is not saved');
  assert.equal(linkSave(applyCapture(draftOf(), article()), 'https://www.youtube.com/watch?v=1').input.type, 'video');
});

test('word count, reading time and preview clipping', () => {
  assert.deepEqual(contentStats(applyCapture(draftOf(), article({ truncated: true }))), { words: 1240, minutes: 5, truncated: true, parts: 0 });
  assert.equal(contentSummary({ words: 1240, minutes: 5, truncated: true, parts: 3 }), '1,240 words · 5 min read · 3 parts · Shortened to fit');
  assert.equal(contentSummary({ words: 1, minutes: 1 }), '1 word · 1 min read');
  assert.equal(contentSummary({}), 'No text');
  assert.deepEqual(contentStats({ articleContent: 'three plain words' }), { words: 3, minutes: 1, truncated: false, parts: 0 });
  assert.deepEqual(previewSource('short'), { text: 'short', clipped: false });
  const long = `${'line of text\n'.repeat(3000)}`;
  const head = previewSource(long);
  assert.equal(head.clipped, true);
  assert.ok(head.text.length <= PREVIEW_CHARS && !head.text.endsWith('line of t'), 'cut at a line break');
  const fenced = previewSource(`intro\n\`\`\`js\n${'code();\n'.repeat(100)}\`\`\``, 200);
  assert.ok(fenced.text.endsWith('\n```'), 'an open code fence is closed');
  const tilde = previewSource(`~~~~\n${'x\n'.repeat(200)}~~~~`, 100);
  assert.ok(tilde.text.endsWith('\n~~~~'));
  // Fence rules match renderMarkdown: indented fences, shorter fences and closing fences with info text do not close an open fence.
  const trickyFence = previewSource(`\`\`\`\`ts\n  \`\`\`\`\n\`\`\`\n\`\`\`\` not-closed\n${'line();\n'.repeat(40)}\`\`\`\``, 140);
  assert.ok(trickyFence.text.endsWith('\n````'), 'only a column-0 fence of at least the opening length with optional trailing spaces closes');
  const closedWithSpaces = previewSource(`\`\`\`js\ncode();\n\`\`\`   \n${'plain text line\n'.repeat(40)}`, 120);
  assert.ok(!closedWithSpaces.text.endsWith('\n```'), 'a fence closed before the clip point is not closed a second time');
  const indentedOpen = previewSource(`  \`\`\`js\n${'not a column-0 fence\n'.repeat(40)}`, 120);
  assert.ok(!indentedOpen.text.endsWith('\n```'), 'an indented fence does not open a code block');
  // Each of these lines leaves the block open in renderMarkdown, so the clipped preview must still close it.
  for (const [opening, line, closing] of [['````', '```', '````'], ['```', '``` trailing words', '```'], ['```', '  ```', '```'], ['~~~', '```', '~~~']]) {
    const source = `${opening}\n${line}\n${'code line\n'.repeat(40)}${closing}`;
    const clipped = previewSource(source, 120);
    assert.ok(clipped.text.endsWith(`\n${closing}`), `${JSON.stringify(line)} does not close ${opening}`);
    assert.equal(parseNoteBlocks(clipped.text).filter(block => block.type === 'code').length, 1, 'one code block, closed at the clip');
  }
});

test('the side panel accepts only its own picker result from frame 0 of the picked tab', () => {
  const pending = { requestId: 'r1', tabId: 7 };
  const message = { type: 'still:picker-result', requestId: 'r1', from: 'panel', result: {} };
  const sender = { id: 'ext', url: 'https://example.com/a', tab: { id: 7 }, frameId: 0 };
  assert.equal(acceptPickerMessage(pending, message, sender, 'ext'), true);
  for (const [label, args] of Object.entries({
    'no request': [null, message, sender], 'other request': [pending, { ...message, requestId: 'r2' }, sender], 'menu result': [pending, { ...message, from: 'menu' }, sender],
    'other extension': [pending, message, { ...sender, id: 'evil' }], 'other tab': [pending, message, { ...sender, tab: { id: 8 } }],
    'subframe': [pending, message, { ...sender, frameId: 2 }], 'extension page': [pending, message, { ...sender, url: 'chrome-extension://ext/index.html' }],
    'other type': [pending, { ...message, type: 'still:open-add' }, sender],
  })) assert.equal(acceptPickerMessage(args[0], args[1], args[2], 'ext'), false, label);
});

test('a kept picker draft is picked per window, newest first, and expires', () => {
  const now = 10_000_000;
  const drafts = {
    a: { windowId: 1, createdAt: now - 1000, article: { ok: true, markdown: 'old' } },
    b: { windowId: 1, createdAt: now - 10, article: { ok: true, markdown: 'new' } },
    c: { windowId: 2, createdAt: now - 10, article: { ok: true } },
    d: { windowId: 1, createdAt: now - 31 * 60 * 1000, article: { ok: true } },
  };
  const { draft, rest } = pickPanelDraft(drafts, 1, now);
  assert.equal(draft.article.markdown, 'new');
  assert.deepEqual(Object.keys(rest), ['c'], "this window's drafts are consumed, expired ones dropped");
  assert.deepEqual(pickPanelDraft(undefined, 1, now), { draft: null, rest: {} });
});

/* ------------------------------------------------------------------ the dialog itself */

const saves = [];
const updates = [];
const items = new Map();
const ctx = {
  env: { isExtension: true, isSidepanel: true },
  state: { dialogs: [], popover: null, page: { url: 'https://example.com/a', tabId: 7 } },
  library: { settings: {}, collections: [{ id: 'reading', name: 'Reading' }] },
  prefs: { get: () => [], touchCollection() {} },
  select: {
    collection: id => (id === 'reading' ? { id: 'reading', name: 'Reading', color: 'blue', icon: 'folder' } : null),
    path: id => (id === 'reading' ? [{ id: 'reading', name: 'Reading' }] : []),
    byId: id => items.get(id) || null,
    savedForUrl: url => [...items.values()].find(item => item.url === url) || null,
    tags: () => [], live: () => [...items.values()],
  },
  store: {
    saveItem: async input => { saves.push(input); const item = { id: `new-${saves.length}`, collectionId: input.collectionId, title: input.title, url: input.url, updatedAt: 'x' }; items.set(item.id, item); return item; },
    updateItem: async (id, patch, options) => { updates.push({ id, patch, options }); return { ...items.get(id), ...patch }; },
  },
  render() {}, nextFrame() {}, toast() {}, openItem() {},
};
initOverlays(ctx, { onRendered() {}, nextFrame() {} });
Object.assign(ctx, { openDialog, closeDialog });
const dialogHtml = () => String(renderOverlays(ctx));

test('the article preview shows Name, Icon, a read-only rendered content preview with its word count, collection and tags', () => {
  openAdd(ctx, { capture: article(), url: 'https://example.com/a', source: 'article', tabId: 7, type: 'article' });
  const markup = dialogHtml();
  assert.match(markup, /<h2 class="dialog-title" id="dialog-title-add.item"><span>Save article<\/span><span class="add-source-chip">/);
  assert.match(markup, /aria-label="Name"/);
  assert.match(markup, /value="Captured title"/);
  assert.match(markup, /<span class="add-label">Icon<\/span>/);
  assert.match(markup, /src="https:\/\/example.com\/icon.png"/);
  assert.match(markup, /aria-label="Change icon \(Page icon\)"/);
  assert.match(markup, /<span class="add-label">Page content<\/span>/);
  assert.match(markup, /1,240 words · 5 min read/);
  assert.match(markup, /data-mount="add.content-preview" data-morph="skip"/);
  assert.match(markup, /role="region" tabindex="0" aria-label="Page content preview \(read only\)"/);
  assert.match(markup, /data-action="add.save-article"[\s\S]*Capture again/);
  assert.match(markup, /data-action="add.select-parts"/);
  assert.match(markup, /id="add-collection"/);
  assert.match(markup, /tag-input-add-tags/);
  assert.ok(!markup.includes('Body text with words'), 'the Markdown is rendered by the mount, not inlined on every keystroke');
  closeDialog('add.item');
});

test('saving an article keeps the dialog open on a saved state that offers Research with AI', async () => {
  // ui/research.js (another module) owns research.start; a stand-in keeps this test independent of it.
  if (!hasAction('research.start')) registerActions({ 'research.start': () => {} });
  openAdd(ctx, { capture: article({ url: 'https://example.com/new', canonicalUrl: 'https://example.com/new' }), url: 'https://example.com/new', source: 'parts', type: 'article' });
  await dispatch('add.save', { ctx, data: {}, el: {} });
  const input = saves.at(-1);
  assert.deepEqual([input.type, input.articleContent, input.icon, input.siteName], ['article', '# Heading\nBody text with words.', 'https://example.com/icon.png', 'Example']);
  const markup = dialogHtml();
  assert.match(markup, /Selection saved/);
  assert.match(markup, /role="status"/);
  assert.match(markup, /Saved to Inbox/);
  assert.match(markup, /data-action="research.start" data-id="new-\d+"[^>]*data-add-research/);
  assert.match(markup, /data-action="add.open-saved" data-id="new-\d+"/);
  await dispatch('add.save', { ctx, data: {}, el: {} });
  assert.equal(saves.filter(entry => entry.url === 'https://example.com/new').length, 1, 'the saved state ignores Mod+Enter');
  closeDialog('add.item');
});

test('capturing an already saved page edits that item and replaces its article text', async () => {
  items.set('old', { id: 'old', type: 'bookmark', title: 'My title', url: 'https://example.com/saved', content: 'My note', collectionId: 'reading', tags: ['x'],
    articleContent: 'Stale', excerpt: 'Mine', updatedAt: 'v1' });
  openAdd(ctx, { capture: article({ url: 'https://example.com/saved', canonicalUrl: 'https://example.com/saved', title: 'Page title' }), url: 'https://example.com/saved', source: 'article', existingId: 'old' });
  const markup = dialogHtml();
  assert.match(markup, /<span>Update article<\/span>/);
  assert.match(markup, /Updating the saved page in/);
  assert.match(markup, /value="My title"/);
  await dispatch('add.save', { ctx, data: {}, el: {} });
  const update = updates.at(-1);
  assert.equal(update.id, 'old');
  assert.deepEqual([update.patch.articleContent, update.patch.title, update.patch.content, update.patch.collectionId, update.patch.type],
    ['# Heading\nBody text with words.', 'My title', 'My note', 'reading', 'article']);
  assert.deepEqual(update.options, { expectedUpdatedAt: 'v1' });
  assert.match(dialogHtml(), /Article updated/);
  closeDialog('add.item');
});

test('a plain link draft for the current tab offers Capture article and Select parts', () => {
  openAdd(ctx, { url: 'https://example.com/a', title: 'Tab', source: 'tab' });
  const markup = dialogHtml();
  assert.match(markup, /<span>Add link<\/span>/);
  assert.match(markup, /Keep the readable text of this page with the link/);
  assert.match(markup, /Capture article/);
  assert.ok(!markup.includes('Change icon'));
  closeDialog('add.item');
  openAdd(ctx, { url: 'https://elsewhere.example/b' });
  assert.ok(!dialogHtml().includes('Page content'), 'another page cannot be captured from here');
  closeDialog('add.item');
});

test('picker status, capture menu, This page buttons and palette entries', () => {
  assert.equal(String(renderPickerStatus({ state: {} })), '');
  const status = String(renderPickerStatus({ state: { picker: { status: 'selecting' } } }));
  assert.match(status, /role="status" aria-live="polite"/);
  assert.match(status, /Selecting parts of the page/);
  assert.match(status, /data-action="add.picker-dismiss"/);

  let menu = [];
  openCaptureMenu({ ...ctx, openMenu: (_anchor, list) => { menu = list; } }, {});
  const byAction = Object.fromEntries(menu.filter(item => item.action).map(item => [item.action, item]));
  assert.equal(byAction['add.save-article'].label, 'Save article…');
  assert.equal(byAction['add.select-parts'].label, 'Select parts of page…');
  openCaptureMenu({ ...ctx, env: { isExtension: true, isSidepanel: false }, openMenu: (_anchor, list) => { menu = list; } }, {});
  assert.ok(menu.find(item => item.action === 'add.save-article').disabled, 'page capture needs the side panel');

  const unsaved = String(renderCaptureActions(ctx, { extension: true }));
  assert.match(unsaved, /data-action="add.save-article"[\s\S]*Save article/);
  assert.match(unsaved, /data-action="add.select-parts"[\s\S]*Select parts/);
  assert.ok(!unsaved.includes('research.start'));
  const saved = String(renderCaptureActions(ctx, { extension: true, item: { id: 'it1' } }));
  assert.match(saved, /Update article/);
  assert.match(saved, /data-action="research.start" data-id="it1"/);
  const preview = String(renderCaptureActions(ctx, { extension: false }));
  assert.equal((preview.match(/disabled/g) || []).length, 2);

  const byId = Object.fromEntries(COMMANDS.map(command => [command.id, command]));
  assert.deepEqual([byId['save-article'].action, byId['select-parts'].action], ['add.save-article', 'add.select-parts']);
  assert.equal(byId['save-article'].when({ env: { isExtension: true, isSidepanel: true } }), true);
  assert.equal(byId['save-article'].when({ env: { isExtension: true, isSidepanel: false } }), false, 'the full tab has no page to read');
  assert.equal(byId['select-parts'].when({ env: { isExtension: false, isSidepanel: true } }), false);
  const label = command => (typeof command.label === 'function' ? 'Switch theme' : command.label);
  assert.equal(rankCommands(COMMANDS, 'save article', label)[0].id, 'save-article');
  assert.equal(rankCommands(COMMANDS, 'select parts', label)[0].id, 'select-parts');
});

test('a capture made while the dialog is open joins it; a saved page switches it to update mode', () => {
  openAdd(ctx, { url: 'https://example.com/saved', title: 'Typed', source: 'tab' });
  openAdd(ctx, { capture: article({ url: 'https://example.com/saved', canonicalUrl: 'https://example.com/saved' }), url: 'https://example.com/saved', source: 'article' });
  const markup = dialogHtml();
  assert.equal((markup.match(/class="dialog-layer"/g) || []).length, 1, 'still one dialog');
  assert.match(markup, /<span>Update article<\/span>/);
  assert.match(markup, /1,240 words/);
  closeDialog('add.item');
});

test('the side panel takes its own picker result straight from the page and recovers one kept while it was closed', async () => {
  const listeners = [];
  const session = { 'still.capture.drafts.v1': {
    kept: { draftId: 'kept', windowId: 5, tabId: 9, createdAt: Date.now(), article: article({ url: 'https://example.com/kept', canonicalUrl: 'https://example.com/kept', selectionCount: 2, markdown: 'Kept parts' }) },
    other: { draftId: 'other', windowId: 6, tabId: 3, createdAt: Date.now(), article: article() },
  } };
  globalThis.chrome = {
    runtime: { id: 'ext', onMessage: { addListener: listener => listeners.push(listener) } },
    windows: { getCurrent: async () => ({ id: 5 }) },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} },
      session: { get: async key => ({ [key]: structuredClone(session[key]) }), set: async patch => { Object.assign(session, structuredClone(patch)); } } },
  };
  const requests = [];
  Object.assign(ctx, { chrome: async (type, payload) => { requests.push({ type, payload }); return { requestId: 'req-1', tabId: 9, windowId: 5 }; }, toast() {} });
  ctx.prefs.set = () => {};
  await init(ctx);
  await new Promise(resolve => setTimeout(resolve, 0));
  let markup = dialogHtml();
  assert.match(markup, /<span>Save selection<\/span><span class="add-source-chip">[\s\S]*2 parts selected/);
  assert.deepEqual(Object.keys(session['still.capture.drafts.v1']), ['other'], "this window's kept selection is consumed");
  closeDialog('add.item');

  await dispatch('add.select-parts', { ctx, data: {}, el: {} });
  assert.deepEqual(requests, [{ type: 'still:start-picker', payload: { windowId: 5, from: 'panel' } }]);
  assert.equal(ctx.state.picker.status, 'selecting');
  const deliver = (message, sender) => { for (const listener of listeners) listener(message, sender, () => {}); };
  const result = { ok: true, source: 'selection', selectionCount: 1, url: 'https://example.com/picked', canonicalUrl: 'https://example.com/picked', title: 'Picked page', markdown: 'One part', wordCount: 2 };
  const sender = { id: 'ext', url: 'https://example.com/picked', tab: { id: 9 }, frameId: 0 };
  deliver({ type: 'still:picker-result', requestId: 'req-1', from: 'panel', result }, { ...sender, tab: { id: 10 } });
  deliver({ type: 'still:picker-result', requestId: 'forged', from: 'panel', result }, sender);
  assert.equal(dialogHtml(), '', 'results from another tab or request are ignored');
  deliver({ type: 'still:picker-result', requestId: 'req-1', from: 'panel', result }, sender);
  markup = dialogHtml();
  assert.match(markup, /<span>Save selection<\/span>/);
  assert.match(markup, /value="Picked page"/);
  assert.equal(ctx.state.picker, null);
  closeDialog('add.item');
  deliver({ type: 'still:picker-result', requestId: 'req-1', from: 'panel', result }, sender);
  assert.equal(dialogHtml(), '', 'a result opens the preview once');
  delete globalThis.chrome;
});

test('research.start does not race-close add.item on a timer, and closing add.item resets the draft', async () => {
  // init() ran in the picker test above, so every document listener quick-add installs is recorded here.
  assert.ok(documentListeners.length > 0, 'quick-add installed its document listeners');
  openAdd(ctx, { capture: article({ url: 'https://example.com/research-stay', canonicalUrl: 'https://example.com/research-stay' }), url: 'https://example.com/research-stay', source: 'article', type: 'article' });
  await dispatch('add.save', { ctx, data: {}, el: {} });
  assert.match(dialogHtml(), /data-add-research/);
  // The click on "Research with AI", as the browser delivers it: document listeners (capture phase first), then the action.
  const button = { dataset: { action: 'research.start', addResearch: '' }, matches: selector => /data-add-research|research\.start|button|\[data-action\]/.test(selector) };
  button.closest = selector => (button.matches(selector) ? button : null);
  const click = { type: 'click', target: button, button: 0, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} };
  for (const { type, listener } of [...documentListeners].sort((a, b) => Number(!!b.options) - Number(!!a.options))) if (type === 'click') listener(click);
  await dispatch('research.start', { ctx, data: { id: 'x' }, el: button });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(ctx.state.dialogs.some(d => d.name === 'add.item'), 'add.item stays open until research.js (once research opened) or the user closes it');
  assert.match(dialogHtml(), /Article saved/, 'and it still shows its saved state');
  closeDialog('add.item');
  openAdd(ctx, { url: 'https://example.com/fresh-after-close', title: 'Fresh draft', source: 'tab' });
  assert.doesNotMatch(dialogHtml(), /Article saved|Selection saved/, 'closing add.item cleared the saved draft state');
  closeDialog('add.item');
});

test('a late close of an older Add dialog never drops the draft a newer one created', () => {
  openAdd(ctx, { url: 'https://example.com/first', title: 'First draft', source: 'tab' });
  const older = ctx.state.dialogs.at(-1);
  closeDialog('add.item');
  assert.equal(dialogHtml(), '', 'closing the dialog dropped its draft');
  openAdd(ctx, { url: 'https://example.com/second', title: 'Second draft', source: 'tab' });
  older.props.onClose();
  assert.match(dialogHtml(), /value="Second draft"/, 'the newer draft is still there');
  closeDialog('add.item');
  assert.equal(dialogHtml(), '');
});

test('a link saved from the context menu does not mark the page it was found on as saved, nor take that page\'s article', async () => {
  const menuLink = { url: 'https://other.example/linked', title: 'Linked page', kind: 'link', sourceUrl: 'https://example.com/listing', source: 'menu' };
  ctx.state.page = { url: 'https://example.com/listing', tabId: 7, saved: false, itemId: null };
  openAdd(ctx, menuLink);
  await dispatch('add.save', { ctx, data: {}, el: {} });
  assert.deepEqual([saves.at(-1).url, saves.at(-1).sourceUrl], ['https://other.example/linked', 'https://example.com/listing']);
  assert.deepEqual([ctx.state.page.saved, ctx.state.page.itemId], [false, null], 'the listing page itself is still unsaved');
  // "Save article" (command palette) on the listing page while the link's dialog is open opens the page's own preview.
  openAdd(ctx, menuLink);
  openAdd(ctx, { capture: article({ url: 'https://example.com/listing', canonicalUrl: 'https://example.com/listing', title: 'Listing' }), url: 'https://example.com/listing',
    source: 'article', type: 'article', sourceUrl: 'https://example.com/listing' });
  const markup = dialogHtml();
  assert.match(markup, /<span>Save article<\/span>/);
  assert.match(markup, /name="url" value="https:\/\/example.com\/listing"/);
  assert.doesNotMatch(markup, /other\.example/, 'the link draft did not absorb the page content');
  ctx.state.page = { url: 'https://example.com/a', tabId: 7 };
  closeDialog('add.item');
});

test('saving an article whose canonical URL differs from the tab URL marks ctx.state.page as saved via sourceUrl', async () => {
  ctx.state.page = { url: 'https://example.com/p/short-slug', tabId: 7, saved: false, itemId: null };
  openAdd(ctx, {
    capture: article({ url: 'https://example.com/p/short-slug', canonicalUrl: 'https://example.com/articles/canonical-slug' }),
    url: 'https://example.com/articles/canonical-slug',
    sourceUrl: 'https://example.com/p/short-slug',
    source: 'article',
    type: 'article',
  });
  await dispatch('add.save', { ctx, data: {}, el: {} });
  const saved = saves.at(-1);
  assert.equal(saved.url, 'https://example.com/articles/canonical-slug');
  assert.equal(saved.sourceUrl, 'https://example.com/p/short-slug');
  assert.equal(ctx.state.page.saved, true, 'current tab is recognized as saved even when canonical URL differs');
  assert.match(String(ctx.state.page.itemId), /^new-\d+$/);
  ctx.state.page = { url: 'https://example.com/a', tabId: 7 };
  closeDialog('add.item');
});

test('re-capturing content of the exact same length bumps data-key and updates add.content-preview', () => {
  openAdd(ctx, {
    capture: article({ url: 'https://example.com/same-len', canonicalUrl: 'https://example.com/same-len', markdown: 'Alpha beta gamma' }),
    url: 'https://example.com/same-len',
    source: 'article',
    type: 'article',
  });
  const firstKey = (dialogHtml().match(/data-mount="add\.content-preview"[^>]*data-key="([^"]+)"/) || [])[1];
  assert.ok(firstKey, 'content preview has a data-key');
  openAdd(ctx, {
    capture: article({ url: 'https://example.com/same-len', canonicalUrl: 'https://example.com/same-len', markdown: 'Delta zeta theta' }),
    url: 'https://example.com/same-len',
    source: 'article',
    type: 'article',
  });
  const secondKey = (dialogHtml().match(/data-mount="add\.content-preview"[^>]*data-key="([^"]+)"/) || [])[1];
  assert.notEqual(secondKey, firstKey, 'same-length re-capture increments the preview revision key');
  closeDialog('add.item');
});
