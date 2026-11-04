import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderChatPage, renderChatDetail, renderChatsWorkspace, configureChats, setThreadkeeperSnapshot, threadkeeperSnapshot, isPaired, invalidateChat, openChat,
  filterChats, chatFacets, transcriptRows, findMessages, startFor, foldPoint, toolTitle, cleanMessages, messageMarkup, chatActivity, chatTabUrl, isAutoPlacedChat,
  TRANSCRIPT_PAGE, LONG_MESSAGE,
} from '../extension/ui/chats.js';
import { createSelectors, searchRows } from '../extension/ui/selectors.js';
import { renderItem } from '../extension/ui/cards.js';
import { filterMapItems } from '../extension/ui/map.js';
import { isMainView } from '../extension/ui/routes.js';
import { viewTitle } from '../extension/ui/shell.js';
import { COMMANDS, itemOption } from '../extension/ui/command.js';
import { TYPE_LABELS, TYPE_ICONS } from '../extension/ui/components.js';
import { hasAction, dispatch } from '../extension/ui/runtime.js';
import { buildSpaceContext } from '../extension/lib/library-views.js';
import { renderDetail } from '../extension/ui/detail.js';
import { parseHTML } from './helpers/fake-dom.mjs';

const flat = fragment => String(fragment).replace(/\s+/g, ' ');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const collections = [
  { id: 'ai', name: 'AI chats', parentId: '', color: 'violet', icon: 'sparkles' },
  { id: 'billing', name: 'Billing', parentId: 'ai', color: 'blue', icon: 'folder' },
  { id: 'mine', name: 'Research', parentId: '', color: 'green', icon: 'folder' },
];
const chatItem = (id, props = {}, chat = {}) => ({
  id, type: 'chat', title: `Chat ${id}`, url: '', sourceUrl: 'https://chatgpt.com/c/abc', excerpt: `Gist of ${id}`, siteName: 'ChatGPT', content: '', tags: [],
  collectionId: 'billing', favorite: false, archived: false, deletedAt: null, relatedIds: [], highlights: [],
  createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
  chat: { v: 1, source: 'threadkeeper', threadKey: `chatgpt:a:w:${id}:main`, provider: 'chatgpt', providerLabel: 'ChatGPT', category: 'chat', kind: 'coding', project: 'Billing',
    model: 'gpt-5', workflowState: 'active', messageCount: 12, lastActivityAt: '2026-10-02T10:00:00.000Z', topics: ['webhooks'], fingerprint: `fp-${id}`, revision: 3,
    hasTranscript: true, transcriptTruncated: false, origin: 'sync', syncedAt: '2026-10-02T11:00:00.000Z', autoCollectionId: 'billing', removed: '', analysisVersion: 2, ...chat },
  ...props,
});
const note = (id, props = {}) => ({ id, type: 'note', title: `Note ${id}`, url: '', excerpt: '', content: 'hello', tags: [], collectionId: '', favorite: false, archived: false,
  deletedAt: null, relatedIds: [], highlights: [], createdAt: '2026-10-05T10:00:00.000Z', updatedAt: '2026-10-05T10:00:00.000Z', ...props });
const link = (id, props = {}) => ({ ...note(id, props), type: 'bookmark', url: `https://example.com/${id}`, content: '', ...props });

const record = id => ({
  id, threadKey: `chatgpt:a:w:${id}:main`, fingerprint: `fp-${id}`, revision: 3, storedAt: '2026-10-02T11:00:00.000Z',
  thread: { provider: 'chatgpt', providerLabel: 'ChatGPT', project: 'Billing', workflowState: 'active', agentLabel: '', kindLabel: 'Building',
    analysis: { source: 'ai', modelLabel: 'Claude Sonnet 4.5', generatedAt: '2026-10-02T10:30:00.000Z', analysisVersion: 2, gist: 'Queue for <webhooks>',
      overview: ['You moved retries to a queue.'], keyPoints: [{ text: 'Keys from event ids', refs: [3] }], decisions: [], actionItems: [], openQuestions: [], artifacts: [], topics: ['webhooks'] } },
});
const transcript = (id, count = 5, { from = 0, total = count } = {}) => ({
  id, revision: 3, truncated: false, totalMessages: total, storedAt: '2026-10-02T11:00:00.000Z',
  messages: Array.from({ length: count }, (_, i) => ({ index: from + i, role: i % 2 ? 'assistant' : 'user', content: i % 2 ? `#### Answer ${from + i}\n+ point` : `Question <b>${from + i}</b>`, createdAt: '2026-10-02T10:00:00.000Z' })),
});

const reads = { records: [], transcripts: [] };
const calls = [];
const client = {
  isThreadkeeperReady: state => state?.status === 'paired',
  getThreadkeeperState: async () => threadkeeperSnapshot(),
  onThreadkeeperChange: () => () => {},
  threadkeeperRequest: async (type, fields) => { calls.push(['request', type, fields]); return type === 'threads.analyze' ? { queued: 1, skipped: [] } : {}; },
  refreshChat: async id => { calls.push(['refresh', id]); },
  loadTranscriptWindow: async (...args) => { calls.push(['window', ...args]); },
  syncThreadkeeperNow: async () => ({ queued: 3 }),
};
const store = { records: new Map(), transcripts: new Map() };
configureChats({
  getChatRecord: async id => { reads.records.push(id); return store.records.get(id) || null; },
  getChatTranscript: async id => { reads.transcripts.push(id); return store.transcripts.get(id) || null; },
  searchChats: async query => (query === 'stripe' ? [{ id: 'c2', score: 3 }] : []),
  client,
});
const paired = (capabilities = ['sync', 'search', 'open', 'analyze']) => setThreadkeeperSnapshot({ status: 'paired', tk: { version: '1.4.0', capabilities }, prefs: { defaultView: 'summary', transcripts: true, placement: 'mirror' } });
const unpaired = () => setThreadkeeperSnapshot({ status: 'off', tk: { version: '', capabilities: [] }, prefs: { defaultView: 'summary', transcripts: true } });

function fakeCtx(items, { prefs = {}, view = 'chats', sidepanel = false, panel = null } = {}) {
  const stored = new Map(Object.entries(prefs));
  let library = { updatedAt: '1', items, collections, settings: {} };
  const ctx = {
    state: { view, query: '', typeFilter: 'all', tagFilter: '', panel, popover: null, dialogs: [], selection: new Set(), chats: { chatId: null, query: '', category: '', provider: '', collectionId: '', deep: null } },
    env: { isSidepanel: sidepanel, isExtension: false, isNewtab: false, isMac: false, modKey: 'Ctrl' },
    prefs: { get: (key, fallback) => (stored.has(key) ? stored.get(key) : fallback), set: (key, value) => stored.set(key, value), all: () => Object.fromEntries(stored), touchCollection() {} },
    get library() { return library; },
    setLibrary(next) { library = { ...library, ...next, updatedAt: String(Number(library.updatedAt) + 1) }; },
    rendered: 0, toasts: [], navigated: [],
    render() { ctx.rendered++; }, nextFrame() {}, syncUrl() {}, toast(message) { ctx.toasts.push(message); },
    navigate(next, options) { ctx.navigated.push([next, options]); ctx.state.view = next; },
    openItem(id) { ctx.state.panel = { kind: 'item', id, tab: 'details' }; },
    run: async fn => fn(),
    store: { updateItem: async (id, changes) => { ctx.updates.push([id, changes]); return { id, ...changes }; } },
    updates: [],
  };
  ctx.select = createSelectors(() => library, () => ctx.prefs.all());
  return ctx;
}

/* ------------------------------------------------------------------ pure helpers */

test('chat list helpers: facets, filters, newest activity first, deep search ids', () => {
  const items = [
    chatItem('c1', {}, { lastActivityAt: '2026-10-01T00:00:00Z' }),
    chatItem('c2', { title: 'Stripe retries' }, { provider: 'claude_code', providerLabel: 'Claude Code', category: 'coding_agent', lastActivityAt: '2026-10-05T00:00:00Z', project: 'Still' }),
    chatItem('c3', { collectionId: '' }, { provider: 'gemini', providerLabel: 'Gemini', lastActivityAt: '2026-10-03T00:00:00Z', topics: ['travel'] }),
    note('n1'),
  ];
  assert.deepEqual(filterChats(items).map(i => i.id), ['c2', 'c3', 'c1']);
  assert.deepEqual(filterChats(items, { category: 'coding_agent' }).map(i => i.id), ['c2']);
  assert.deepEqual(filterChats(items, { provider: 'gemini' }).map(i => i.id), ['c3']);
  assert.deepEqual(filterChats(items, { collectionId: '__none' }).map(i => i.id), ['c3']);
  assert.deepEqual(filterChats(items, { collectionId: 'billing' }).map(i => i.id), ['c2', 'c1']);
  assert.deepEqual(filterChats(items, { query: 'travel' }).map(i => i.id), ['c3'], 'topics are searched');
  assert.deepEqual(filterChats(items, { query: 'still' }).map(i => i.id), ['c2'], 'the project is searched');
  assert.deepEqual(filterChats(items, { query: 'idempotency', deep: new Set(['c1']) }).map(i => i.id), ['c1'], 'full-text hits from the chat store count');
  const facets = chatFacets(items.filter(i => i.type === 'chat'));
  assert.deepEqual(facets.categories, [{ id: 'chat', label: 'Chats', count: 2 }, { id: 'coding_agent', label: 'Coding agents', count: 1 }]);
  assert.deepEqual(facets.providers.map(p => [p.id, p.label, p.count]), [['chatgpt', 'ChatGPT', 1], ['claude_code', 'Claude Code', 1], ['gemini', 'Gemini', 1]]);
  assert.equal(chatActivity(items[0]), '2026-10-01T00:00:00Z');
  assert.equal(chatActivity({ updatedAt: 'u' }), 'u');
});

test('transcript helpers: clean messages, gaps, pages from the end, find, folding', () => {
  const messages = cleanMessages([
    { index: 0, role: 'user', content: 'hi' }, { index: 0, role: 'assistant', content: 'dup' }, { index: 1, role: 'robot', content: 'x' },
    { index: -1, role: 'user', content: 'x' }, { index: 21, role: 'assistant', content: 'later', createdAt: null }, { index: 22, role: 'tool', content: 5 },
  ]);
  assert.deepEqual(messages.map(m => [m.index, m.role, m.content]), [[0, 'user', 'hi'], [21, 'assistant', 'later'], [22, 'tool', '5']]);
  assert.deepEqual(transcriptRows(messages, { start: 0, totalMessages: 40 }).map(r => (r.kind === 'gap' ? `gap ${r.from}-${r.to}` : r.message.index)),
    [0, 'gap 1-20', 21, 22, 'gap 23-39']);
  // A gap before the first drawn message sits behind "Show earlier messages".
  assert.deepEqual(transcriptRows(messages, { start: 1, totalMessages: 23 }).map(r => (r.kind === 'gap' ? 'gap' : r.message.index)), [21, 22]);
  assert.deepEqual(transcriptRows(cleanMessages([{ index: 5, role: 'user', content: 'x' }]), { totalMessages: 6 }).map(r => r.kind), ['gap', 'message']);
  assert.deepEqual(findMessages(cleanMessages([{ index: 0, role: 'user', content: 'Stripe' }, { index: 1, role: 'assistant', content: 'stripe!' }, { index: 2, role: 'user', content: 'no' }]), 'STRIPE'), [0, 1]);
  assert.deepEqual(findMessages(messages, '  '), []);
  assert.equal(startFor(120, 400, 250), 100, 'pages stay aligned to the end');
  assert.equal(startFor(10, 400, 250), 0);
  assert.equal(startFor(300, 400, 250), 250, 'already drawn');
  assert.equal(startFor(0, 400, 250), 0);
  assert.equal(TRANSCRIPT_PAGE, 150);
  const long = `${'a'.repeat(4500)}\n${'b'.repeat(3000)}`;
  assert.equal(foldPoint(long), 4500);
  assert.equal(foldPoint('x'.repeat(9000)), LONG_MESSAGE);
  assert.equal(foldPoint('short'), 5);
  assert.equal(toolTitle('\n\n  Read src/x.ts\nmore'), 'Read src/x.ts');
  assert.equal(toolTitle('x'.repeat(200)).length, 90);
  assert.equal(toolTitle('[tool] Edit: /src/a.ts'), 'Edit: /src/a.ts');
  assert.equal(toolTitle('[tool result] PASS 3 tests'), 'Result · PASS 3 tests');
  assert.equal(toolTitle('[tool error] \nboom'), 'Error');
});

test('messages: user text escaped, assistant Markdown normalized without images, tools folded, long messages shortened', () => {
  const user = messageMarkup({ index: 4, role: 'user', content: '<script>alert(1)</script>\n**not bold**', createdAt: '' });
  assert.match(user, /<article class="chat-msg" data-role="user" id="msg-4" data-index="4" aria-label="You, message 5">/);
  assert.match(user, /<div class="chat-bubble chat-msg-body">&lt;script&gt;alert\(1\)&lt;\/script&gt;\n\*\*not bold\*\*<\/div>/);
  assert.match(user, /href="#msg-4"[^>]*>m5<\/a>/);
  const doc = parseHTML(`<div>${user}</div>`);
  assert.equal(doc.querySelectorAll('script').length, 0);

  const answer = messageMarkup({ index: 5, role: 'assistant', content: '#### Plan\n+ one\n1) two\n![pixel](https://tracker.example/p.png)\n[[Secret]]', createdAt: '2026-10-02T10:00:00Z' },
    { who: 'Claude Code', category: 'coding_agent' });
  assert.match(answer, /<span class="chat-avatar" data-category="coding_agent" aria-hidden="true">/);
  assert.match(answer, /<span class="chat-msg-who">Claude Code<\/span>/);
  assert.match(answer, /<h3>Plan<\/h3><ul><li>one<\/li><\/ul><ol><li>two<\/li><\/ol>/);
  assert.doesNotMatch(answer, /<img/);
  assert.match(answer, /<a class="markdown-media-link" href="https:\/\/tracker\.example\/p\.png"/);
  assert.match(answer, /\[\[Secret\]\]/, 'wiki links stay text in a transcript');
  assert.match(answer, /<time class="chat-msg-time" datetime="2026-10-02T10:00:00Z">/);

  const tool = messageMarkup({ index: 6, role: 'tool', content: 'Read src/x.ts\n<b>contents</b>', createdAt: '' });
  assert.match(tool, /<details class="chat-tool"><summary class="chat-tool-summary">/);
  assert.match(tool, /<span class="chat-tool-title">Read src\/x\.ts<\/span>/);
  assert.match(tool, /<pre class="chat-tool-body chat-msg-body">Read src\/x\.ts\n&lt;b&gt;contents&lt;\/b&gt;<\/pre>/);
  const system = messageMarkup({ index: 0, role: 'system', content: 'Context compacted', createdAt: '' });
  assert.match(system, /<p class="chat-system chat-msg-body">Context compacted<\/p>/);
  assert.doesNotMatch(system, /chat-msg-meta/);

  const text = `${'x'.repeat(5000)}\n${'y'.repeat(4000)}`;
  const folded = messageMarkup({ index: 1, role: 'user', content: text, createdAt: '' });
  assert.match(folded, /aria-expanded="false">Show more \(4,001 more characters\)<\/button>/);
  assert.doesNotMatch(folded, /y{10}/);
  const open = messageMarkup({ index: 1, role: 'user', content: text, createdAt: '' }, { expanded: true });
  assert.match(open, /y{4000}/);
  assert.match(open, /aria-expanded="true">Show less<\/button>/);
});

/* ------------------------------------------------------------------ the chat page */

test('the summary view looks like a note page and loads the stored record once per synced version', async () => {
  paired();
  const items = [chatItem('c1', { content: '' }), note('sub1', { parentId: 'c1', collectionId: 'billing' })];
  store.records.set('c1', record('c1'));
  const ctx = fakeCtx(items);
  const item = ctx.select.byId('c1');
  const first = flat(renderChatPage(ctx, item, { surface: 'page' }));
  assert.match(first, /aria-label="Loading the summary"/);
  await tick();
  assert.ok(ctx.rendered > 0, 'the page re-renders when the record arrives');
  const page = flat(renderChatPage(ctx, item, { surface: 'page' }));
  assert.equal(reads.records.filter(id => id === 'c1').length, 1, 'one read per version');
  assert.match(page, /<div class="ne ne-full chat-page is-summary" data-surface="full" data-chat-id="c1"/);
  assert.match(page, /<div class="ne-toolbar chat-toolbar" role="toolbar" aria-label="Chat views and actions">/);
  assert.match(page, /role="radiogroup" aria-label="Show"/);
  assert.match(page, /role="radio" class="segmented-option" aria-checked="true"[^>]*data-value="summary"/);
  assert.match(page, /<h1 class="ne-title chat-title" id="chat-title-c1">Chat c1<\/h1>/);
  assert.match(page, /<nav class="ne-crumbs" aria-label="Collection">.*AI chats.*Billing/);
  assert.match(page, /class="ne-prop chat-provider" data-category="chat">.*ChatGPT/);
  assert.match(page, /Analyzed by Claude Sonnet 4\.5/);
  assert.match(page, /<div class="chat-summary markdown-body" data-action="chat.body" data-id="c1"><h2>What this thread is about<\/h2><p>Queue for &lt;webhooks&gt;<\/p>/);
  assert.match(page, /<a class="markdown-link" href="#msg-3">m4<\/a>/);
  assert.match(page, /<h2 class="ne-links-title" id="chat-notes-c1">Your notes<\/h2>/);
  assert.match(page, /data-mount="note-editor" data-morph="skip" data-key="inline-editor:c1:content" data-id="c1" data-variant="inline" data-field="content"/);
  assert.match(page, /Subpages<span class="ne-count-pill">1<\/span>.*data-action="chat.open-link" data-id="sub1"/);
  assert.match(page, /data-action="app.open-url" data-url="https:\/\/chatgpt.com\/c\/abc"/);
  assert.match(page, /data-action="chat.open-tk" data-id="c1"/, 'paired with capability open');
  assert.match(page, /data-action="chat.refresh" data-id="c1"/);
  assert.match(page, /<footer class="ne-foot chat-foot">.*12 messages/);
  assert.equal(parseHTML(`<div>${page}</div>`).querySelectorAll('script, img, iframe').length, 0);
});

test('without Threadkeeper the page still works from the stored copy, with no Threadkeeper actions', async () => {
  unpaired();
  const ctx = fakeCtx([chatItem('c9')]);
  const item = ctx.select.byId('c9');
  renderChatPage(ctx, item);
  await tick();
  const page = flat(renderChatPage(ctx, item));
  assert.doesNotMatch(page, /chat\.open-tk|chat\.refresh|chat\.improve/);
  assert.match(page, /The full summary of this chat is not on this device\. Connect Threadkeeper to bring it back\./);
  assert.match(page, /<h2>What this thread is about<\/h2><p>Gist of c9<\/p>/, 'the gist on the item stands in');
});

test('the transcript view mounts once per stored transcript and has calm empty states', async () => {
  paired();
  const ctx = fakeCtx([chatItem('c2'), chatItem('c3', {}, { hasTranscript: false })], { prefs: { chatView: 'transcript' } });
  store.transcripts.set('c2', transcript('c2', 6));
  renderChatPage(ctx, ctx.select.byId('c2'));
  await tick();
  const page = flat(renderChatPage(ctx, ctx.select.byId('c2')));
  assert.match(page, /chat-page is-transcript/);
  assert.match(page, /<div class="chat-transcript-host" data-mount="chat.transcript" data-morph="skip" data-key="chat:c2:3:c2:3:2026-10-02T11:00:00\.000Z:0" data-id="c2"/);
  assert.match(page, /data-paired="true"/);
  assert.doesNotMatch(page, /Your notes/, 'notes belong to the summary view');
  renderChatPage(ctx, ctx.select.byId('c3'));
  await tick();
  const empty = flat(renderChatPage(ctx, ctx.select.byId('c3')));
  assert.match(empty, /This chat’s transcript is not on this device/);
  assert.match(empty, /Refresh it from Threadkeeper/);
  // A refresh forgets the cached copy so the next render reads the store again.
  const before = reads.transcripts.filter(id => id === 'c2').length;
  invalidateChat('c2');
  renderChatPage(ctx, ctx.select.byId('c2'));
  await tick();
  assert.equal(reads.transcripts.filter(id => id === 'c2').length, before + 1);
});

test('banners: Trash, removed from Threadkeeper, and an older summary that can be improved', async () => {
  paired();
  const ctx = fakeCtx([
    chatItem('t1', { deletedAt: '2026-10-04T00:00:00Z' }),
    chatItem('p1', {}, { removed: 'local_only' }),
    chatItem('o1', {}, { analysisVersion: 1 }),
  ]);
  store.records.set('o1', { ...record('o1'), thread: { ...record('o1').thread, analysis: { ...record('o1').thread.analysis, analysisVersion: 1 } } });
  for (const id of ['t1', 'p1', 'o1']) renderChatPage(ctx, ctx.select.byId(id));
  await tick();
  const trash = flat(renderChatPage(ctx, ctx.select.byId('t1')));
  assert.match(trash, /This chat is in Trash\..*data-action="library.restore" data-id="t1".*data-action="library.delete-forever"/);
  assert.doesNotMatch(trash, /data-mount="note-editor"/, 'no editing in Trash');
  const priv = flat(renderChatPage(ctx, ctx.select.byId('p1')));
  assert.match(priv, /This thread is private in Threadkeeper now\./);
  assert.doesNotMatch(priv, /chat\.refresh|chat\.open-tk/, 'a private thread is not refreshed');
  const older = flat(renderChatPage(ctx, ctx.select.byId('o1')));
  assert.match(older, /<strong>Older summary\.<\/strong>.*data-action="chat.improve" data-id="o1"/);
  paired(['sync']);
  assert.doesNotMatch(flat(renderChatPage(ctx, ctx.select.byId('o1'))), /chat\.improve/, 'only with the analyze capability');
});

test('detail hosts: the side panel gets a back arrow and Open in full tab, the right panel Open as page and Close', () => {
  paired();
  const ctx = fakeCtx([chatItem('c1')], { view: 'all', panel: { kind: 'item', id: 'c1', tab: 'details' } });
  const side = flat(renderDetail(ctx, 'c1', { surface: 'side' }));
  assert.match(side, /^<div class="detail chat-detail" data-surface="side" data-key="detail:c1"><div class="chat-host is-side"/);
  assert.match(side, /data-action="app.close-panel"[^>]*>.*aria-label="Back"|aria-label="Back"[^>]*data-action="app.close-panel"/);
  assert.match(side, /data-action="chat.open-full" data-id="c1"/);
  assert.match(side, /class="ne ne-side chat-page/);
  const panel = flat(renderChatDetail(ctx, ctx.select.byId('c1'), { surface: 'full' }));
  assert.match(panel, /data-action="chat.open-page" data-id="c1"/);
  assert.match(panel, /aria-label="Close"/);
  assert.equal(chatTabUrl('chat_tk_1', 'chrome-extension://abc/index.html'), 'chrome-extension://abc/index.html?libraryView=chats&item=chat_tk_1');
});

test('the Chats workspace lists chats beside the open one and takes over a chat opened in the panel', () => {
  paired();
  const items = [chatItem('c1'), chatItem('c2', { title: 'Newer' }, { lastActivityAt: '2026-10-09T00:00:00Z', category: 'coding_agent', provider: 'codex', providerLabel: 'Codex' }), note('n1')];
  const ctx = fakeCtx(items, { panel: { kind: 'item', id: 'c1', tab: 'details' } });
  const ws = flat(renderChatsWorkspace(ctx));
  assert.equal(ctx.state.panel, null);
  assert.equal(ctx.state.chats.chatId, 'c1');
  assert.match(ws, /<div class="notes-ws chats-ws" data-key="chats-ws">/);
  assert.match(ws, /<h1 class="notes-heading" id="chats-heading">Chats<\/h1><span class="notes-heading-count">2<\/span>/);
  const rows = [...ws.matchAll(/data-action="chats.open" data-id="(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(rows, ['c2', 'c1'], 'newest activity first');
  assert.match(ws, /class="notes-row chat-row is-selected" data-action="chats.open" data-id="c1" aria-current="true"/);
  assert.match(ws, /data-action="chats.filter-category" data-value="coding_agent"/);
  assert.match(ws, /data-action="chats.filter-provider" data-value="codex"/);
  assert.match(ws, /data-action="chats.add"/);
  assert.match(ws, /data-chat-id="c1"/);
  // Empty library, not paired: points to Settings.
  unpaired();
  const empty = flat(renderChatsWorkspace(fakeCtx([note('n1')])));
  assert.match(empty, /Bring in your AI chats/);
  assert.match(empty, /data-action="chats.settings"/);
});

test('actions: switching views, #msg links, collection and tags, refresh, improve and opening', async () => {
  paired();
  const ctx = fakeCtx([chatItem('c1')], { view: 'all' });
  for (const name of ['chat.view', 'chat.body', 'chat.menu', 'chat.set-collection', 'chat.set-tags', 'chat.refresh', 'chat.improve', 'chat.open-tk', 'chats.open', 'chats.add', 'chats.query']) assert.ok(hasAction(name), name);
  await dispatch('chat.view', { ctx, el: null, data: { value: 'transcript' } });
  assert.equal(ctx.prefs.get('chatView'), 'transcript');
  await dispatch('chat.view', { ctx, el: null, data: { value: 'bogus' } });
  assert.equal(ctx.prefs.get('chatView'), 'transcript');
  ctx.prefs.set('chatView', 'summary');
  // A [m4](#msg-3) link in the summary switches to the transcript (and remembers where to scroll).
  let prevented = false;
  const anchor = { getAttribute: () => '#msg-3' };
  const wrapper = { dataset: { id: 'c1' }, contains: () => true };
  await dispatch('chat.body', { ctx, el: wrapper, data: wrapper.dataset, event: { target: { closest: () => anchor }, preventDefault() { prevented = true; } } });
  assert.ok(prevented);
  assert.equal(ctx.prefs.get('chatView'), 'transcript');
  const host = { closest: () => ({ dataset: { chatId: 'c1' } }) };
  await dispatch('chat.set-collection', { ctx, el: host, data: { value: 'mine' } });
  await dispatch('chat.set-tags', { ctx, el: host, data: { tags: ['stripe', 'ops'] } });
  assert.deepEqual(ctx.updates, [['c1', { collectionId: 'mine' }], ['c1', { tags: ['stripe', 'ops'] }]]);
  calls.length = 0;
  await dispatch('chat.refresh', { ctx, el: null, data: { id: 'c1' } });
  await dispatch('chat.improve', { ctx, el: null, data: { id: 'c1' } });
  await dispatch('chat.open-tk', { ctx, el: null, data: { id: 'c1' } });
  assert.deepEqual(calls, [['refresh', 'c1'], ['request', 'threads.analyze', { threadKeys: ['chatgpt:a:w:c1:main'] }], ['request', 'thread.open', { threadKey: 'chatgpt:a:w:c1:main' }]]);
  assert.match(ctx.toasts.join('|'), /Refreshed from Threadkeeper\|Threadkeeper is writing a new summary/);
  // Opening a chat in the full tab goes to the Chats workspace; in the side panel it is the item panel.
  openChat(ctx, 'c1');
  assert.deepEqual(ctx.navigated.at(-1), ['chats', { keep: true }]);
  assert.equal(ctx.state.chats.chatId, 'c1');
  const side = fakeCtx([chatItem('c1')], { sidepanel: true, view: 'all' });
  openChat(side, 'c1');
  assert.deepEqual(side.state.panel, { kind: 'item', id: 'c1', tab: 'details' });
});

/* ------------------------------------------------------------------ library integration */

test('All items and the Inbox leave out chats still where sync placed them; searches, Chats and their collections list them', () => {
  const items = [
    link('l1'), note('n1'),
    chatItem('auto', {}, {}),                                              // in its sync collection
    chatItem('inboxed', { collectionId: '' }, { autoCollectionId: '' }),   // sync put it in the Inbox
    chatItem('moved', { collectionId: 'mine' }, { autoCollectionId: 'billing' }), // the user moved it
  ];
  const ctx = fakeCtx(items);
  const ids = state => ctx.select.itemsForView(state).map(i => i.id).sort();
  assert.ok(isAutoPlacedChat(items[2]) && isAutoPlacedChat(items[3]) && !isAutoPlacedChat(items[4]));
  assert.deepEqual(ids({ view: 'all' }), ['l1', 'moved', 'n1']);
  assert.deepEqual(ids({ view: 'inbox' }), ['l1', 'n1']);
  assert.deepEqual(ids({ view: 'all', showChats: true }), ['auto', 'inboxed', 'l1', 'moved', 'n1']);
  assert.deepEqual(ids({ view: 'inbox', showChats: true }), ['inboxed', 'l1', 'n1']);
  assert.deepEqual(ids({ view: 'all', query: 'gist' }), ['auto', 'inboxed', 'moved'], 'a search includes every chat');
  assert.deepEqual(ids({ view: 'all', typeFilter: 'chat' }), ['auto', 'inboxed', 'moved']);
  assert.deepEqual(ids({ view: 'chats' }), ['auto', 'inboxed', 'moved']);
  assert.deepEqual(ids({ view: 'type:chat' }), ['auto', 'inboxed', 'moved']);
  assert.deepEqual(ids({ view: 'collection:ai' }), ['auto'], 'a collection lists its chats');
  assert.equal(ctx.select.hiddenChats('all'), 2);
  assert.equal(ctx.select.hiddenChats('inbox'), 1);
  assert.equal(ctx.select.hiddenChats('collection:ai'), 0);
  assert.equal(ctx.select.counts().byType.chat, 3);
  assert.equal(ctx.select.counts().byType.note, 1);
  // Synced chats do not make a collection "recent" (only chats live in collections here).
  assert.deepEqual(ctx.select.recentCollections().map(c => c.id), []);
});

test('search finds chats by provider, project, topics and agent', () => {
  const items = [chatItem('c1', {}, { providerLabel: 'Claude Code', project: 'Billing', topics: ['webhooks'], agentLabel: 'CEO · Grok Bot' }), link('l1')];
  assert.deepEqual(searchRows(items, 'claude').map(i => i.id), ['c1']);
  assert.deepEqual(searchRows(items, 'billing webhooks').map(i => i.id), ['c1']);
  assert.deepEqual(searchRows(items, 'grok').map(i => i.id), ['c1']);
  assert.deepEqual(searchRows(items, 'type:chat').map(i => i.id), ['c1']);
});

test('cards, palette, map, routes and labels know the chat type', () => {
  paired();
  const items = [chatItem('c1', {}, { category: 'coding_agent', providerLabel: 'Claude Code', messageCount: 42 }), link('l1')];
  const ctx = fakeCtx(items, { view: 'collection:billing' });
  const row = flat(renderItem(ctx, items[0], { layout: 'list' }));
  assert.match(row, /class="item item-row is-chat"/);
  assert.match(row, /<span class="item-source-text">Claude Code<\/span>/);
  assert.match(row, /title="42 messages"/);
  assert.match(row, /title="Coding agent session"/);
  const card = flat(renderItem(ctx, items[0], { layout: 'cards' }));
  assert.match(card, /item-notecard item-chatcard/);
  assert.match(card, /<span class="note-preview chat-card-gist">Gist of c1<\/span>/);
  assert.equal(TYPE_LABELS.chat, 'Chat');
  assert.equal(TYPE_ICONS.chat, 'messages-square');
  assert.ok(isMainView('chats'));
  assert.equal(viewTitle(ctx, 'chats'), 'Chats');
  assert.equal(viewTitle(ctx, 'type:chat'), 'Chats');
  assert.ok(COMMANDS.some(c => c.id === 'go-chats' && c.view === 'chats'));
  assert.ok(COMMANDS.some(c => c.id === 'add-chats' && c.action === 'threadkeeper.picker-open'));
  const option = itemOption(ctx, items[0]);
  assert.equal(option.hint, 'Claude Code · Billing · AI chats / Billing');
  assert.match(String(option.leading), /command-glyph/);
  assert.deepEqual(filterMapItems(items, { type: 'all' }).items.map(i => i.id), ['l1'], 'the map leaves chats out of All');
  assert.deepEqual(filterMapItems(items, { type: 'chat' }).items.map(i => i.id), ['c1']);
  const space = buildSpaceContext({ items, collections }, "space:billing");
  assert.equal(space.chatCount, 1);
});

test('Threadkeeper state: paired only when the client says so', () => {
  unpaired();
  assert.equal(isPaired(), false);
  paired();
  assert.equal(isPaired(), true);
  assert.equal(threadkeeperSnapshot().tk.version, '1.4.0');
});
