import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantLayout, railPlacement, scopeOptions, renderAssistantPage, ASSISTANT_LAYOUT } from '../extension/ui/assistant-page.js';
import { aiState, setAiScope, renderAiPanel } from '../extension/ui/ai-panel.js';
import { dispatch } from '../extension/ui/runtime.js';

const flat = fragment => String(fragment).replace(/\s+/g, ' ');
const count = (markup, pattern) => (String(markup).match(pattern) || []).length;

const collections = [
  { id: 'design', name: 'Design', parentId: '', depth: 0, icon: 'palette', color: 'pink' },
  { id: 'type', name: 'Typography', parentId: 'design', depth: 1, icon: 'type', color: 'indigo' },
  { id: 'travel', name: 'Travel', parentId: '', depth: 0, icon: 'plane', color: 'teal' },
];

function fakeCtx({ layout = 'wide', sheet = null, prefs = {}, conversation = null, target, history = [], view = 'assistant', panel = null } = {}) {
  const stored = new Map(Object.entries(prefs));
  const ctx = {
    state: { view, panel, selection: new Set(), popover: null, dialogs: [], shell: { docked: true }, assistant: { layout, sheet, query: '' } },
    env: { isSidepanel: false, isNewtab: false, isExtension: false, isMac: false, modKey: 'Ctrl' },
    prefs: { get: (key, fallback) => (stored.has(key) ? stored.get(key) : fallback), set: (key, value) => stored.set(key, value) },
    library: { items: [], collections, settings: { newTab: { name: 'Maddy' } } },
    select: {
      tree: () => collections, collection: id => collections.find(entry => entry.id === id) || null, recentCollections: () => collections.slice(0, 2),
      counts: () => ({ all: 12, inbox: 3, byCollection: { design: 4 }, byCollectionDeep: { design: 6, type: 2, travel: 1 } }),
      byId: () => null, live: () => [], path: () => [], descendants: id => [id],
    },
    ai: { listConversations: async () => history, EFFORT_LABELS: {} },
    rendered: 0,
    render() { ctx.rendered++; }, nextFrame() {}, toast() {}, syncUrl() {},
  };
  const s = aiState(ctx);
  s.history = history;
  s.target = target === undefined ? { providerName: 'Anthropic', model: 'claude-sonnet-5-5', modelLabel: 'Claude Sonnet 5.5', via: 'direct', efforts: [] } : target;
  s.conversation = conversation;
  return ctx;
}

const conversation = {
  id: 'conversation_1', title: 'What did I save about agents?', createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:01:00.000Z', model: 'claude-sonnet-5-5',
  messages: [{ id: 'q', role: 'user', text: 'What did I save about agents?' }, { id: 'a', role: 'assistant', text: 'Start with the essay.', citations: [] }],
};

test('the layout follows the main column width', () => {
  assert.equal(assistantLayout(1440), 'wide');
  assert.equal(assistantLayout(ASSISTANT_LAYOUT.wide), 'wide');
  assert.equal(assistantLayout(ASSISTANT_LAYOUT.wide - 1), 'medium');
  assert.equal(assistantLayout(ASSISTANT_LAYOUT.medium), 'medium');
  assert.equal(assistantLayout(ASSISTANT_LAYOUT.medium - 1), 'narrow');
  assert.equal(assistantLayout(320), 'narrow');
});

test('rails dock where they fit, follow the saved choice, and otherwise open only as sheets', () => {
  assert.deepEqual(railPlacement('wide', { chats: true, context: true }), { chats: 'docked', context: 'docked' });
  assert.deepEqual(railPlacement('wide', { chats: false, context: true }), { chats: 'hidden', context: 'docked' });
  assert.deepEqual(railPlacement('medium', { chats: true, context: true }), { chats: 'docked', context: 'hidden' });
  assert.deepEqual(railPlacement('medium', { chats: true, context: true }, 'context'), { chats: 'docked', context: 'sheet' });
  assert.deepEqual(railPlacement('narrow', { chats: true, context: true }), { chats: 'hidden', context: 'hidden' });
  assert.deepEqual(railPlacement('narrow', {}, 'chats'), { chats: 'sheet', context: 'hidden' });
  assert.deepEqual(railPlacement('wide', {}, 'chats'), { chats: 'docked', context: 'docked' }, 'a docked rail is never a sheet');
});

test('the scope select lists the library, Inbox and nested collections, with the current scope selected', () => {
  const library = scopeOptions(collections);
  assert.equal(library.value, 'library');
  assert.deepEqual(library.options.map(option => option.value), ['library', 'inbox', 'collection:design', 'collection:type', 'collection:travel']);
  assert.equal(library.options[3].label, '\u2003Typography', 'children are indented');
  assert.equal(scopeOptions(collections, { kind: 'collection', collectionId: '' }).value, 'inbox');
  assert.equal(scopeOptions(collections, { kind: 'collection', collectionId: 'travel' }).value, 'collection:travel');
  const items = scopeOptions(collections, { kind: 'items', itemCount: 3 });
  assert.equal(items.value, 'items');
  assert.equal(items.options[0].label, '3 chosen items');
  assert.equal(scopeOptions([], { kind: 'items', itemCount: 1 }).options[0].label, 'The chosen item');
});

test('the wide page docks both rails beside one conversation with a single h1', () => {
  const ctx = fakeCtx({ conversation, history: [{ id: 'conversation_1', title: conversation.title, updatedAt: new Date().toISOString(), preview: 'Start with **the essay** [[x]].' }] });
  const out = flat(renderAssistantPage(ctx));
  assert.equal(count(out, /<h1\b/g), 1, 'one h1 per view');
  assert.match(out, /<aside class="asst-chats" id="asst-chats"/);
  assert.match(out, /<aside class="asst-context" id="asst-context"/);
  assert.ok(!out.includes('role="dialog"'), 'docked rails are not dialogs');
  assert.ok(!/class="asst-center"[^>]*inert/.test(out), 'the conversation is not inert');
  assert.match(out, /aria-label="Hide chats"/);
  assert.match(out, /aria-label="Hide context and sources"/);
  assert.match(out, /<input class="asst-title-input" id="asst-title"[^>]*value="What did I save about agents\?"/, 'a saved chat has an editable title');
  assert.match(out, /aria-current="page"/, 'the open chat is marked current in the history');
  assert.match(out, /Start with the essay\./, 'history previews are plain text');
  assert.match(out, /data-surface="page"/);
  assert.match(out, /aria-label="Export chat"/);
  assert.match(out, /Messages<\/dt><dd>2<\/dd>/);
});

test('a narrow page opens a rail as a modal sheet and makes the conversation inert', () => {
  const closed = flat(renderAssistantPage(fakeCtx({ layout: 'narrow', conversation })));
  assert.ok(!closed.includes('<aside'), 'no rails until a sheet is opened');
  assert.match(closed, /aria-label="Show chats"[^>]*aria-controls="asst-chats"[^>]*aria-expanded="false"|aria-controls="asst-chats"[^>]*aria-expanded="false"/);
  assert.ok(!closed.includes('aria-label="Export chat"'), 'export moves into the More menu');
  const open = flat(renderAssistantPage(fakeCtx({ layout: 'narrow', sheet: 'chats', conversation })));
  assert.match(open, /class="asst-chats is-sheet"[^>]*role="dialog"/);
  assert.match(open, /class="asst-center"[^>]*inert/);
  assert.match(open, /class="asst-scrim"/);
  assert.match(open, /aria-label="Close chats"/);
});

test('a docked rail goes inert behind the other rail’s sheet', () => {
  const out = flat(renderAssistantPage(fakeCtx({ layout: 'medium', sheet: 'context', conversation })));
  assert.match(out, /<aside class="asst-chats" id="asst-chats"[^>]*inert/);
  assert.match(out, /<aside class="asst-context is-sheet"[^>]*role="dialog"/);
  assert.ok(!/class="asst-context is-sheet"[^>]*inert/.test(out), 'the open sheet stays interactive');
});

test('a sheet that no longer fits the layout is dropped', () => {
  const ctx = fakeCtx({ layout: 'wide', sheet: 'context' });
  renderAssistantPage(ctx);
  assert.equal(ctx.state.assistant.sheet, null);
});

test('the empty page greets by name and offers suggestions and quick scopes', () => {
  const ctx = fakeCtx();
  const out = flat(renderAssistantPage(ctx));
  assert.match(out, /<h2 class="asst-greeting">Good (morning|afternoon|evening|night), Maddy<\/h2>/);
  assert.equal(count(out, /class="asst-suggestion"/g), 5);
  assert.match(out, /Save these links into a collection/, 'the empty page shows that the assistant can save links');
  assert.match(out, /aria-pressed="true" data-scope="library"/);
  assert.match(out, /aria-pressed="false" data-scope="collection" data-collection=""/, 'Inbox is offered');
  assert.match(out, /<span class="asst-title-text" title="New chat">New chat<\/span>/);
  setAiScope(ctx, { scope: 'collection', collectionId: 'design' });
  const scoped = flat(renderAssistantPage(ctx));
  assert.match(scoped, /aria-pressed="true" data-scope="collection" data-collection="design"/);
  assert.match(scoped, /aria-pressed="false" data-scope="library"/);
  assert.match(scoped, /Digest of Design/, 'suggestions follow the scope');
  assert.match(scoped, /<option value="collection:design" selected>/);
});

test('without a model the page shows the setup and a badge to connect one', () => {
  const out = flat(renderAssistantPage(fakeCtx({ target: null })));
  assert.match(out, /Connect a model to ask here/);
  assert.match(out, /class="asst-model is-missing"/);
  // A narrow header shows the badge as its plug icon only, so the button names itself.
  assert.match(out, /class="asst-model is-missing" data-action="ai.settings" aria-label="Connect a model" data-tooltip="Connect a model"/);
});

test('sending without a model says so next to the composer, not in a toast over it', async () => {
  const ctx = fakeCtx({ target: null });
  const toasts = [];
  ctx.toast = message => toasts.push(message);
  aiState(ctx).draft = 'What did I save about agents?';
  await dispatch('ai.send', { ctx });
  assert.deepEqual(toasts, []);
  const out = flat(renderAiPanel(ctx, { surface: 'page', head: '' }));
  assert.match(out, /data-key="ai.model-notice"/);
  assert.match(out, /Connect a model to ask here, or open your question in another app\./);
  assert.match(out, /data-action="ai.settings"/);
  assert.doesNotMatch(out, /Ask ChatGPT/, 'the setup on screen already lists the other apps');
  assert.equal(aiState(ctx).draft, 'What did I save about agents?', 'the question stays in the composer');
  // Each send is announced: the live region's text changes every time, even when the notice is already showing.
  const first = aiState(ctx).announce;
  assert.match(first, /^Connect a model to ask here/);
  await dispatch('ai.send', { ctx });
  assert.notEqual(aiState(ctx).announce, first);
  assert.equal(aiState(ctx).announce.trim(), first.trim());
  // With a chat open the setup is gone, so the notice offers the other apps itself.
  aiState(ctx).conversation = conversation;
  assert.match(flat(renderAiPanel(ctx, { surface: 'page', head: '' })), /data-action="ai.handoff" data-target="chatgpt"/);
  await dispatch('ai.model-notice-dismiss', { ctx });
  assert.doesNotMatch(flat(renderAiPanel(ctx, { surface: 'page', head: '' })), /ai.model-notice/);
});

test('the page closes the full tab Ask panel instead of showing the chat twice', () => {
  const ctx = fakeCtx({ panel: { kind: 'ai' } });
  renderAssistantPage(ctx);
  assert.equal(ctx.state.panel, null);
  const item = fakeCtx({ panel: { kind: 'item', id: 'x' } });
  renderAssistantPage(item);
  assert.deepEqual(item.state.panel, { kind: 'item', id: 'x' }, 'an open item stays open');
});

test('the side panel and the full tab panel offer the full-screen assistant', () => {
  const side = fakeCtx({ view: 'all' });
  side.env.isSidepanel = true;
  assert.match(flat(renderAiPanel(side, { surface: 'side' })), /aria-label="Open full screen"[^>]*data-action="ai.open-page"/);
  const full = fakeCtx({ view: 'all' });
  const out = flat(renderAiPanel(full, { surface: 'full' }));
  assert.match(out, /data-action="ai.open-page"/);
  assert.match(out, /aria-label="Widen the panel"/);
});
