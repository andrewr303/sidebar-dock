// Research UI (build contract §7): the status model and render helpers for research conversations, the research.start
// action and its host-access request, the side panel's still:research message gating, the research actions against a
// stubbed run API, follow-ups from the composer, and auto-approved proposals from the regular assistant.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  researchState, stepSummary, stepCount, progressLabel, raiseOptions, formatUsd, undoSummary, researchProblem, retryText, researchOrigins, researchSources,
  renderResearchSteps, renderResearchBar, renderSubpageChips, handleResearchMessage, ANTHROPIC_ORIGIN, GITHUB_ORIGIN, LIVE_STEPS, RESEARCH_STALE_MS,
} from '../extension/ui/research.js';
import { aiState, renderAiPanel, renderResearchMessage, renderProposalCard, historyGlyph, approvalNote, renameAiConversation, init as initPanel } from '../extension/ui/ai-panel.js';
import { renderAssistantPage } from '../extension/ui/assistant-page.js';
import { dispatch, createRuntime } from '../extension/ui/runtime.js';
import { initOverlays, openDialog, closeDialog, renderOverlays } from '../extension/ui/overlay.js';
import { openAdd } from '../extension/ui/quick-add.js';
import { researchOffered } from '../extension/ui/research.js';
import { researchMenuItem } from '../extension/ui/library.js';
import { renderCaptureActions } from '../extension/ui/page.js';

const flat = fragment => String(fragment).replace(/\s+/g, ' ');
const plainText = fragment => String(fragment).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const ticks = async (until, max = 200) => { for (let i = 0; i < max && !until(); i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(until(), 'timed out'); };
const ago = ms => new Date(Date.now() - ms).toISOString();

globalThis.document ??= { getElementById: () => null, activeElement: null, body: null, querySelector: () => null };

function useChrome({ granted = true, ask = true } = {}) {
  const calls = { requests: [], contains: [], tabs: [] };
  const previous = globalThis.chrome;
  globalThis.chrome = {
    runtime: { id: 'still', getURL: path => `chrome-extension://still/${path}` },
    permissions: {
      request: request => { calls.requests.push(request); return Promise.resolve(ask); },
      contains: request => { calls.contains.push(request); return Promise.resolve(granted); },
    },
    tabs: { create: async options => { calls.tabs.push(options); return {}; } },
  };
  return { calls, restore: () => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; } };
}

// The modal dialogs open in a fake ctx (names, bottom to top); closeDialog(name) records the name and closes that dialog.
function useDialogs(ctx, names) {
  const closed = [];
  ctx.state.dialogs = names.map(name => ({ name, props: {} }));
  ctx.closeDialog = name => { closed.push(name); const at = ctx.state.dialogs.map(entry => entry.name).lastIndexOf(name); if (at >= 0) ctx.state.dialogs.splice(at, 1); return true; };
  return closed;
}
const IN_DIALOG = { closest: selector => selector.includes('aria-modal') ? {} : null };

const ITEMS = [
  { id: 'item_1', type: 'article', title: 'Building effective agents', url: 'https://example.com/agents', updatedAt: '2026-11-01T09:00:00.000Z' },
  { id: 'page_1', type: 'note', title: 'Frameworks compared', parentId: 'item_1', updatedAt: '2026-11-01T09:05:00.000Z' },
  { id: 'page_gone', type: 'note', title: 'Old notes', deletedAt: '2026-11-01T09:06:00.000Z', updatedAt: '2026-11-01T09:06:00.000Z' },
];

function researchConversation({ status = 'running', heartbeatAt = new Date().toISOString(), reason, errorCode, error = '', steps = [], text = '', preview, subpages = [],
  undo, writes = 0, usage, undoneAt, live, request = { kind: 'kickoff', text: '' }, id = 'conversation_r', messageError, sent } = {}) {
  return {
    id, title: 'Research: Building effective agents', kind: 'research', createdAt: '2026-11-01T09:00:00.000Z', updatedAt: '2026-11-01T09:01:00.000Z',
    model: 'claude-sonnet-5-5', connectionId: 'anthropic_1', scope: { scope: 'item', ids: ['item_1'], collectionId: '' },
    research: {
      itemId: 'item_1', status, heartbeatAt, error, ...(reason ? { reason } : {}), ...(errorCode ? { errorCode } : {}), ...(usage ? { usage } : {}), ...(undoneAt ? { undoneAt } : {}),
      settings: { depth: 'standard', maxSubpages: 6, github: 'auto', budgetUsd: 5 }, undo: undo || { itemId: 'item_1', sectionText: '', subpageIds: [] },
      pages: subpages.map(page => ({ ...page, parent: 'document' })), writes,
    },
    messages: [
      { id: 'q1', role: 'user', text: 'Research “Building effective agents”', context: { scope: 'item', ids: ['item_1'] } },
      { id: 'a1', role: 'assistant', text, error: messageError ?? (status === 'stopped' ? 'Stopped' : status === 'failed' ? error : ''),
        research: { live: live ?? ['starting', 'running'].includes(status), steps, subpages, writes, request, ...(preview ? { preview } : {}), ...(sent !== undefined ? { sent } : {}) } },
    ],
  };
}

const step = (id, kind, label, state = 'done', extra = {}) => ({ id, kind, label, state, at: '2026-11-01T09:00:30.000Z', ...extra });
const STEPS = [
  step('s1', 'search', 'Searched the web for “agent frameworks”', 'done', { detail: 'agent frameworks' }),
  step('s2', 'fetch', 'Read anthropic.com', 'done', { url: 'https://www.anthropic.com/research/building-effective-agents' }),
  step('s3', 'github', 'Searched GitHub for “agent framework”', 'done', { detail: 'agent framework' }),
  step('s4', 'fetch', 'Read blocked.example', 'error', { url: 'https://blocked.example/page', detail: 'Could not open the page' }),
  step('s5', 'write', 'Added to the research section'),
  step('s6', 'subpage', 'Created subpage “Frameworks compared”'),
  step('s7', 'search', 'Searched the web for “agent evals”', 'running', { detail: 'agent evals' }),
];

function fakeCtx({ side = true, extension = true, conversation = null, ai = {}, view = 'all', panel = null, confirmAnswer = true, target } = {}) {
  const calls = { toasts: [], navigate: [], openItem: [], menus: [], confirms: [], renders: 0 };
  const byId = new Map(ITEMS.map(item => [item.id, item]));
  const ctx = {
    state: { view, panel, sideTab: 'page', selection: new Set(), popover: null, dialogs: [], notes: {}, shell: { docked: true }, assistant: { layout: 'wide', sheet: null, query: '' }, windowId: 7 },
    env: { isSidepanel: side, isNewtab: false, isExtension: extension, isMac: false, modKey: 'Ctrl' },
    prefs: { get: (key, fallback) => fallback, set() {} },
    library: { items: ITEMS, collections: [], settings: {} },
    select: { byId: id => byId.get(id) || null, live: () => ITEMS.filter(item => !item.deletedAt), path: () => [], collection: () => null, recentCollections: () => [], tree: () => [],
      descendants: id => [id], counts: () => ({ all: 2 }), savedForUrl: () => null },
    ai: {
      listConversations: async () => [],
      getConversation: async id => (ctx.stored.get(id) ? structuredClone(ctx.stored.get(id)) : null),
      saveConversation: async value => value,
      EFFORT_LABELS: {},
      ...ai,
    },
    stored: new Map(conversation ? [[conversation.id, conversation]] : []),
    toast: (message, options = {}) => calls.toasts.push({ message, ...options }),
    navigate: next => { calls.navigate.push(next); ctx.state.view = next; },
    openItem: id => calls.openItem.push(id),
    openMenu: (el, items, options) => calls.menus.push({ el, items, options }),
    confirm: async options => { calls.confirms.push(options); return confirmAnswer; },
    render() { calls.renders++; }, renderNow() {}, nextFrame() {}, syncUrl() {}, closePopover() {},
    dispatch: (name, args = {}) => dispatch(name, { ctx, el: null, data: {}, ...args }),
  };
  const s = aiState(ctx);
  s.target = target === undefined ? { providerName: 'Anthropic', model: 'claude-sonnet-5-5', modelLabel: 'Claude Sonnet 5.5', via: 'direct', efforts: [] } : target;
  s.settings = { research: { github: 'auto' }, assistantPermissions: {} };
  s.history = [];
  s.conversation = conversation ? structuredClone(conversation) : null;
  return { ctx, calls };
}

// ------------------------------------------------------------------------------------------------ pure helpers

test('the research state names the run’s status and the actions it allows', () => {
  const at = Date.parse('2026-11-01T10:00:00.000Z');
  const state = (options, now = at) => researchState(researchConversation(options), { now });
  const fresh = state({ status: 'running', heartbeatAt: new Date(at - 4000).toISOString() });
  assert.deepEqual([fresh.label, fresh.tone, fresh.running, fresh.stale, fresh.actions], ['Researching', 'accent', true, false, ['stop']]);
  assert.deepEqual(state({ status: 'starting', heartbeatAt: new Date(at).toISOString() }).label, 'Starting');

  const stale = state({ status: 'running', heartbeatAt: new Date(at - RESEARCH_STALE_MS).toISOString() });
  assert.deepEqual([stale.label, stale.tone, stale.stale, stale.running, stale.actions], ['Paused', 'warning', true, false, ['resume']], 'no heartbeat for 30 s: Resume');
  assert.deepEqual(state({ status: 'running', heartbeatAt: '' }).actions, ['resume'], 'a run without a heartbeat is stale');

  const budget = state({ status: 'waiting', reason: 'budget', usage: { costUsd: 5.02 } });
  assert.deepEqual([budget.label, budget.actions, budget.costUsd, budget.budgetUsd], ['Paused at the spending cap', ['raise'], 5.02, 5]);
  assert.deepEqual(state({ status: 'waiting', reason: 'connection' }).actions, ['resume']);

  assert.deepEqual(state({ status: 'failed', error: 'Claude is overloaded right now.' }).actions, ['retry']);
  assert.deepEqual(state({ status: 'failed', errorCode: 'permission' }).actions, ['allow'], 'missing host access: Allow access');
  assert.deepEqual(state({ status: 'failed', errorCode: 'auth' }).actions, ['settings']);
  assert.deepEqual(state({ status: 'failed', errorCode: 'no_research_connection', writes: 1 }).actions, ['settings', 'undo']);

  const wrote = { itemId: 'item_1', sectionText: '## Research\n\n_From 1 November_\n\nFindings', subpageIds: ['page_1'] };
  const done = state({ status: 'done', undo: wrote });
  assert.deepEqual([done.label, done.tone, done.actions, done.wrote], ['Done', 'success', ['undo'], true]);
  assert.deepEqual(state({ status: 'done' }).actions, [], 'nothing written, nothing to undo');
  assert.deepEqual(state({ status: 'done', undo: wrote, undoneAt: '2026-11-01T10:00:00.000Z' }).actions, [], 'undone once');
  assert.deepEqual(state({ status: 'stopped', undo: wrote }).actions, ['undo']);
  assert.deepEqual(state({ status: 'waiting', reason: 'budget', undo: wrote }).actions, ['raise'], 'a paused run is undone only once it is over');
  assert.equal(researchState({ kind: 'research', research: { status: 'odd' } }).status, 'stopped', 'an unknown status reads as stopped');
});

test('step summaries, counts and progress labels', () => {
  assert.equal(stepSummary(STEPS), '7 steps · 2 searches · 2 pages read · 1 GitHub lookup');
  const folded = [{ id: 'collapsed', kind: 'note', label: '40 earlier steps', state: 'done', count: 40 }, ...STEPS,
    step('status:retry', 'status', 'A temporary problem; retrying')];
  assert.equal(stepCount(folded), 47, 'folded steps count, status rows do not');
  assert.equal(stepSummary([]), '0 steps');
  assert.equal(progressLabel({ research: { steps: STEPS } }), 'Searched the web for “agent evals”', 'the running step');
  assert.equal(progressLabel({ research: { steps: STEPS.slice(0, 2) } }), 'Read anthropic.com', 'else the latest one');
  assert.equal(progressLabel(null), '');
});

test('spending caps, problems, undo summaries and retry text', () => {
  assert.equal(formatUsd(5), '$5');
  assert.equal(formatUsd(0.4234), '$0.42');
  assert.equal(formatUsd('x'), '');
  assert.deepEqual(raiseOptions(5, 5.02), [10, 15, 20, 30]);
  assert.deepEqual(raiseOptions(5, 12), [15, 20, 30, 50], 'above what was already spent');
  assert.deepEqual(raiseOptions(100, 99), [], 'the highest cap cannot be raised');

  assert.equal(researchProblem({ code: 'no_research_connection', message: 'x' }).kind, 'setup');
  assert.equal(researchProblem({ code: 'disabled' }).kind, 'research-settings');
  assert.equal(researchProblem({ code: 'permission' }).kind, 'permission');
  assert.equal(researchProblem({ code: 'auth', message: 'Check the API key.' }).message, 'Check the API key.');
  assert.equal(researchProblem({ code: 'busy', message: 'Still running.' }).kind, 'info');
  assert.equal(researchProblem(new Error('Boom')).kind, 'error');

  assert.equal(undoSummary({ section: 'removed', original: 'none', trashed: ['a', 'b'], kept: [] }),
    'Research changes undone: removed the research section and moved 2 subpages to the Trash.');
  assert.equal(undoSummary({ section: 'changed', original: 'restored', trashed: [], kept: ['section'] }),
    'Research changes undone: restored the original. Kept the research section, because it was edited.');
  assert.equal(undoSummary({ alreadyUndone: true }), 'These research changes were already undone.');
  assert.equal(undoSummary({ section: 'none', original: 'none', trashed: [] }), 'Nothing was undone.');

  assert.equal(retryText(researchConversation({ request: { kind: 'followup', text: 'Compare pricing' } })), 'Compare pricing');
  assert.equal(retryText(researchConversation({ sent: true })), 'Pick up where the research stopped and finish it.', 'a kickoff that reached the session is finished');
  // A kickoff that never reached the session is retried as itself, so the research gets its full kickoff again.
  assert.equal(retryText(researchConversation()), '', 'no focus was given');
  assert.equal(retryText(researchConversation({ sent: false, request: { kind: 'kickoff', text: 'Focus on pricing.' } })), 'Focus on pricing.');
  assert.deepEqual(researchOrigins({ research: { github: 'auto' } }), [ANTHROPIC_ORIGIN, GITHUB_ORIGIN]);
  assert.deepEqual(researchOrigins({ research: { github: 'off' } }), [ANTHROPIC_ORIGIN], 'no GitHub access when GitHub research is off');
  assert.deepEqual(researchOrigins(null), [ANTHROPIC_ORIGIN, GITHUB_ORIGIN]);
});

// ------------------------------------------------------------------------------------------------ rendering

test('the live timeline shows the latest steps with icons, links and states; a finished one folds into a summary', () => {
  const { ctx } = fakeCtx();
  const many = [...Array.from({ length: 5 }, (_, index) => step(`e${index}`, 'search', `Searched the web for “q${index}”`)), ...STEPS];
  const message = { id: 'a1', research: { steps: many } };
  const live = flat(renderResearchSteps(ctx, message, { live: true }));
  assert.equal((live.match(/class="ai-step"/g) || []).length, LIVE_STEPS, 'only the latest steps while it runs');
  assert.match(live, /Show 6 earlier steps/);
  assert.match(live, /data-action="ai.toggle" data-open="steps-all:a1" aria-expanded="false" aria-controls="ai-steps-a1"/);
  assert.match(live, /data-state="running"[^]*class="spinner"[^]*Searched the web for “agent evals”<\/span><span class="sr-only">, in progress<\/span>/);
  assert.match(live, /data-kind="fetch" data-state="error">[^]*?class="icon ai-step-error"/, 'a failed read is marked');
  assert.match(live, /<span class="ai-step-detail">Could not open the page<\/span>/);
  assert.match(live, /<button type="button" class="ai-step-row is-link" data-action="app.open-url" data-url="https:\/\/blocked.example\/page"/);
  assert.doesNotMatch(live, /Searched the web for “q0”/);

  aiState(ctx).open.add('steps-all:a1');
  const all = flat(renderResearchSteps(ctx, message, { live: true }));
  assert.equal((all.match(/class="ai-step"/g) || []).length, many.length);
  assert.match(all, /Show fewer steps/);

  const done = flat(renderResearchSteps(ctx, { id: 'a1', research: { steps: STEPS.map(entry => ({ ...entry, state: entry.state === 'running' ? 'done' : entry.state })) } }));
  assert.match(done, /class="ai-tool-row ai-steps-toggle" data-action="ai.toggle" data-open="steps:a1" aria-expanded="false" aria-controls="ai-steps-a1"/);
  assert.match(done, /<span>7 steps · 2 searches · 2 pages read · 1 GitHub lookup<\/span>/);
  assert.match(done, /<ol class="ai-step-list" id="ai-steps-a1" role="list" aria-label="Research steps" hidden>/, 'folded until opened');
  aiState(ctx).open.add('steps:a1');
  assert.doesNotMatch(flat(renderResearchSteps(ctx, { id: 'a1', research: { steps: STEPS } })), /aria-label="Research steps" hidden/);
  assert.equal(String(renderResearchSteps(ctx, { id: 'a1', research: { steps: [] } })), '');
});

test('subpage chips open live pages and show deleted ones as such', () => {
  const { ctx } = fakeCtx();
  const out = flat(renderSubpageChips(ctx, { research: { subpages: [{ id: 'page_1', title: 'Old title' }, { id: 'page_gone', title: 'Old notes' }, { id: '' }] } }));
  assert.match(out, /<button type="button" class="ai-page-chip" data-action="research.open-item" data-id="page_1">[^]*Frameworks compared/, 'the page’s current title');
  assert.match(out, /class="ai-page-chip is-gone"[^]*Old notes[^]*Deleted/);
  assert.equal((out.match(/<li>/g) || []).length, 2);
  assert.equal(String(renderSubpageChips(ctx, { research: {} })), '');
});

test('the research bar names the page, announces progress and offers the actions the run allows', () => {
  const { ctx } = fakeCtx();
  const running = flat(renderResearchBar(ctx, researchConversation({ steps: STEPS, usage: { costUsd: 0.42 }, subpages: [{ id: 'page_1', title: 'Frameworks compared' }] })));
  assert.match(running, /<h2 class="ai-research-title" id="ai-research-title">Researching “Building effective agents”<\/h2>/);
  assert.match(running, /<p class="ai-research-status" role="status">[^]*Researching · Searched the web for “agent evals”/, 'progress in a polite live region');
  assert.match(running, /7 steps · 1 subpage · \$0.42 of \$5 cap/);
  assert.match(running, /data-action="research.stop" data-id="conversation_r"/);
  assert.match(running, /data-action="research.open-item" data-id="item_1"/);
  assert.match(running, /class="ai-research-dot is-running"/);
  assert.doesNotMatch(running, /research.undo|research.resume/);

  const stale = flat(renderResearchBar(ctx, researchConversation({ heartbeatAt: ago(RESEARCH_STALE_MS + 1000) })));
  assert.match(stale, /data-action="research.resume"/);
  assert.match(stale, /No open Still window is running it/);
  assert.doesNotMatch(stale, /research.stop/);

  const budget = flat(renderResearchBar(ctx, researchConversation({ status: 'waiting', reason: 'budget', usage: { costUsd: 5.01 } })));
  assert.match(budget, /data-action="research.raise"[^>]*aria-haspopup="menu"/);
  assert.match(budget, /Raise cap and continue/);
  assert.match(budget, /It reached its \$5 spending cap/);

  const failed = flat(renderResearchBar(ctx, researchConversation({ status: 'failed', error: 'Claude is overloaded right now.' })));
  assert.match(failed, /Research on “Building effective agents”/);
  assert.match(failed, /data-action="research.retry"[^>]*>[^]*Try again/);
  const access = flat(renderResearchBar(ctx, researchConversation({ status: 'failed', errorCode: 'permission' })));
  assert.match(access, /data-action="research.retry"[^>]*>[^]*Allow access/);

  const done = flat(renderResearchBar(ctx, researchConversation({ status: 'done', undo: { itemId: 'item_1', sectionText: '## Research', subpageIds: [] } })));
  assert.match(done, /data-action="research.undo"[^>]*>[^]*Undo research changes/);
  assert.match(done, /data-status="done" data-tone="success"/);
  assert.match(flat(renderResearchBar(ctx, researchConversation({ status: 'done', undo: { sectionText: 'x' }, undoneAt: ago(0) }))), /Its changes to your library were undone/);
  assert.equal(String(renderResearchBar(ctx, { id: 'chat', messages: [] })), '', 'only for research conversations');
});

test('a research turn paints its text with keys that change as it grows, and the live message as it is written', () => {
  const { ctx } = fakeCtx();
  const first = flat(renderResearchMessage(ctx, researchConversation({ status: 'done', text: 'Findings so far.' }).messages[1], researchConversation({ status: 'done' })));
  assert.match(first, /data-key="rmd:a1:16"/);
  const grown = researchConversation({ status: 'done', text: 'Findings so far. And more.' });
  assert.match(flat(renderResearchMessage(ctx, grown.messages[1], grown)), /data-key="rmd:a1:26"/, 'a longer stored text repaints');

  const live = researchConversation({ steps: STEPS, text: 'First message.', preview: { id: 'ev_9', text: 'Now reading' } });
  const out = flat(renderResearchMessage(ctx, live.messages[1], live));
  assert.match(out, /class="ai-a is-research is-live" data-key="a:a1" aria-busy="true"/);
  assert.match(out, /data-key="rpv:a1:ev_9:11"/);
  assert.match(out, /class="ai-md markdown-body is-compact is-typing"/);
  assert.doesNotMatch(out, /aria-label="Copy"/, 'no answer actions while it is written');

  const stale = researchConversation({ heartbeatAt: ago(RESEARCH_STALE_MS + 1), text: 'First message.', preview: { id: 'ev_9', text: 'Now reading' } });
  assert.doesNotMatch(flat(renderResearchMessage(ctx, stale.messages[1], stale)), /rpv:/, 'a run nobody drives is not live');

  const starting = researchConversation({ status: 'starting' });
  assert.match(flat(renderResearchMessage(ctx, starting.messages[1], starting)), /Starting the research…/);
  const stopped = researchConversation({ status: 'stopped', text: 'Partial.' });
  assert.match(flat(renderResearchMessage(ctx, stopped.messages[1], stopped)), /class="ai-stopped"[^]*Stopped/);
  const failed = researchConversation({ status: 'failed', error: 'Claude is overloaded right now.' });
  assert.match(flat(renderResearchMessage(ctx, failed.messages[1], failed)), /class="ai-error" role="alert"[^]*Claude is overloaded right now\./);
});

test('a research conversation draws the bar and a composer that asks the research agent, even without a chat model', () => {
  const done = researchConversation({ status: 'done', text: 'Findings.' });
  const { ctx } = fakeCtx({ conversation: done, target: null });
  aiState(ctx).draft = 'Compare it with LangGraph';
  const out = flat(renderAiPanel(ctx, { surface: 'side' }));
  assert.match(out, /data-key="ai.research"/);
  assert.match(out, /aria-label="Ask the research agent"/);
  assert.match(out, /class="ai-chip is-research"[^]*Building effective agents/);
  assert.match(out, /Research agent/);
  assert.match(out, /Follow-ups continue this research with Claude Sonnet 5.5/);
  assert.doesNotMatch(out, /data-action="ai.add-context"|data-action="ai.model"/);
  assert.match(out, /<button type="submit" class="ai-send" aria-label="Send"[^>]*>/);
  assert.doesNotMatch(out, /<button type="submit" class="ai-send"[^>]*disabled/, 'sendable without a chat model');

  aiState(ctx).conversation = researchConversation({ steps: STEPS });
  const running = flat(renderAiPanel(ctx, { surface: 'side' }));
  assert.match(running, /data-action="ai.stop" aria-label="Stop the research"/);
  assert.match(running, /placeholder="The research is running\. Ask for more once it ends\."/);
});

test('history lists mark research conversations with a telescope', () => {
  assert.match(String(historyGlyph({ kind: 'research', title: 'Research: Agents' })), /class="icon ai-history-kind"[^>]*aria-hidden="true"/);
  assert.match(String(historyGlyph({ kind: 'research', title: 'My agents notes' })), /role="img" aria-label="Research:"/, 'named when a rename dropped the word');
  assert.equal(String(historyGlyph({ title: 'Chat' })), '');
  const { ctx } = fakeCtx({ side: false, view: 'assistant' });
  aiState(ctx).history = [{ id: 'conversation_r', kind: 'research', title: 'Research: Agents', updatedAt: new Date().toISOString(), research: { status: 'done' } },
    { id: 'chat', title: 'Plain chat', updatedAt: new Date().toISOString() }];
  const page = flat(renderAssistantPage(ctx));
  assert.equal((page.match(/ai-history-kind/g) || []).length, 1);
});

test('the empty state promises approval only while every change asks first', () => {
  assert.match(approvalNote({ assistantPermissions: { create: 'ask' } }), /always wait for your approval/);
  assert.match(approvalNote({ assistantPermissions: { create: 'allow' } }), /apply right away, and you can undo them/);
  assert.match(approvalNote(null), /always wait for your approval/);
});

// ------------------------------------------------------------------------------------------------ research.start and the message

test('research.start asks for host access inside the click, starts the run and opens it in the Ask tab', async () => {
  const chrome = useChrome();
  try {
    const started = [];
    const conversation = researchConversation({ status: 'starting' });
    const { ctx } = fakeCtx({ ai: { startResearch: async options => { started.push(options); ctx.stored.set(conversation.id, conversation); return { conversationId: conversation.id, done: Promise.resolve('done') }; } } });
    const pending = dispatch('research.start', { ctx, data: { id: 'item_1' } });
    assert.equal(chrome.calls.requests.length, 1, 'asked before anything is awaited');
    assert.deepEqual(chrome.calls.requests[0], { origins: [ANTHROPIC_ORIGIN, GITHUB_ORIGIN] });
    await pending;
    assert.deepEqual(started, [{ itemId: 'item_1', instructions: '' }]);
    assert.equal(ctx.state.sideTab, 'ask');
    assert.equal(aiState(ctx).conversation?.id, 'conversation_r');
    assert.equal(aiState(ctx).announce, 'Researching “Building effective agents”');

    // GitHub research off: only Anthropic is asked for. A full tab opens the assistant view.
    const full = fakeCtx({ side: false, view: 'all', ai: { startResearch: async () => { full.ctx.stored.set(conversation.id, conversation); return { conversationId: conversation.id }; } } });
    aiState(full.ctx).settings = { research: { github: 'off' } };
    await dispatch('research.start', { ctx: full.ctx, data: { id: 'item_1' } });
    assert.deepEqual(chrome.calls.requests.at(-1), { origins: [ANTHROPIC_ORIGIN] });
    assert.deepEqual(full.calls.navigate, ['assistant']);
    assert.equal(aiState(full.ctx).conversation?.id, 'conversation_r');

    // From the Add dialog's success state: that dialog closes once the research is open behind it.
    const added = fakeCtx({ ai: { startResearch: async () => { added.ctx.stored.set(conversation.id, conversation); return { conversationId: conversation.id }; } } });
    const closed = useDialogs(added.ctx, ['add.item']);
    await dispatch('research.start', { ctx: added.ctx, el: IN_DIALOG, data: { id: 'item_1' } });
    assert.deepEqual(closed, ['add.item']);
    added.ctx.state.dialogs = [{ name: 'add.item', props: {} }];
    await dispatch('research.start', { ctx: added.ctx, el: { closest: () => null }, data: { id: 'item_1' } });
    assert.deepEqual(closed, ['add.item'], 'a button outside a dialog closes nothing');
  } finally { chrome.restore(); }
});

test('research.start closes only the dialog it was clicked in, and only once the research is open', async () => {
  const chrome = useChrome();
  try {
    const conversation = researchConversation({ status: 'starting' });
    // Another dialog opened over the Add dialog while the research was starting: neither closes.
    const covered = fakeCtx({ ai: { startResearch: async () => {
      covered.ctx.state.dialogs.push({ name: 'confirm', props: {} });
      covered.ctx.stored.set(conversation.id, conversation);
      return { conversationId: conversation.id };
    } } });
    const coveredClosed = useDialogs(covered.ctx, ['add.item']);
    await dispatch('research.start', { ctx: covered.ctx, el: IN_DIALOG, data: { id: 'item_1' } });
    assert.equal(aiState(covered.ctx).conversation?.id, 'conversation_r', 'the research opened');
    assert.deepEqual(coveredClosed, [], 'the dialog on top is not the one the button was in');
    assert.deepEqual(covered.ctx.state.dialogs.map(entry => entry.name), ['add.item', 'confirm']);

    // The Add dialog was closed meanwhile: nothing else closes in its place.
    const gone = fakeCtx({ ai: { startResearch: async () => { gone.ctx.state.dialogs = [{ name: 'settings', props: {} }]; gone.ctx.stored.set(conversation.id, conversation); return { conversationId: conversation.id }; } } });
    const goneClosed = useDialogs(gone.ctx, ['add.item']);
    await dispatch('research.start', { ctx: gone.ctx, el: IN_DIALOG, data: { id: 'item_1' } });
    assert.deepEqual(goneClosed, []);

    // A chat answer is being written here: the research is only offered in a toast, so the dialog stays.
    const busy = fakeCtx({ ai: { startResearch: async () => { busy.ctx.stored.set(conversation.id, conversation); return { conversationId: conversation.id }; } } });
    const busyClosed = useDialogs(busy.ctx, ['add.item']);
    aiState(busy.ctx).run = { id: 'run-x', controller: new AbortController(), conversationId: 'conversation_chat', user: { id: 'u', role: 'user', text: 'Hi' }, message: { id: 'm', role: 'assistant', text: '', proposals: [], tools: [] } };
    await dispatch('research.start', { ctx: busy.ctx, el: IN_DIALOG, data: { id: 'item_1' } });
    assert.equal(busy.calls.toasts.at(-1).action.label, 'Open');
    assert.deepEqual(busyClosed, [], 'not opened here, so the dialog stays');
  } finally { chrome.restore(); }
});

test('research.start never closes a new Add dialog that was opened while the research started (real overlay and draft)', async () => {
  // initOverlays installs document and window listeners; nothing here fires them.
  globalThis.document.addEventListener ??= () => {};
  globalThis.addEventListener ??= () => {};
  const chrome = useChrome();
  const conversation = researchConversation({ status: 'starting' });
  let meanwhile = () => {};
  const { ctx } = fakeCtx({ ai: { startResearch: async () => { meanwhile(); ctx.stored.set(conversation.id, conversation); return { conversationId: conversation.id }; } } });
  try {
    ctx.select.collection = () => null;
    ctx.select.tags = () => [];
    Object.assign(ctx, { openDialog, closeDialog });
    initOverlays(ctx, { onRendered() {}, nextFrame() {} });
    // A button inside a dialog: the dialog element's id is its overlay entry's id, as renderOverlays draws it.
    const inDialog = entry => ({ closest: selector => (selector.includes('aria-modal') ? { id: entry.id } : null) });

    openAdd(ctx, { type: 'note', title: 'Saved draft' });
    const first = ctx.state.dialogs.at(-1);
    // While the research starts, the user closes that Add dialog and opens a new one with a new draft.
    meanwhile = () => { closeDialog('add.item'); openAdd(ctx, { type: 'note', title: 'Newer draft' }); };
    await dispatch('research.start', { ctx, el: inDialog(first), data: { id: 'item_1' } });
    assert.equal(aiState(ctx).conversation?.id, 'conversation_r', 'the research opened');
    const second = ctx.state.dialogs.at(-1);
    assert.equal(second?.name, 'add.item', 'the newer Add dialog is still open');
    assert.notEqual(second.id, first.id, 'a reopened dialog of the same name has its own id');
    assert.match(String(renderOverlays(ctx)), /value="Newer draft"/, 'and its draft is intact');

    // The same dialog, still on top once the research is open: that one closes.
    meanwhile = () => {};
    await dispatch('research.start', { ctx, el: inDialog(second), data: { id: 'item_1' } });
    assert.deepEqual(ctx.state.dialogs, [], 'the dialog the button was in closed');
  } finally {
    while (ctx.state.dialogs?.length) closeDialog();
    chrome.restore();
  }
});

test('Research with AI is offered only while "Offer Research with AI" is on in AI settings', () => {
  const { ctx } = fakeCtx();
  const article = ITEMS[0];
  const offered = () => [researchOffered(ctx), researchMenuItem(article, ctx)?.action ?? null, /data-action="research\.start"/.test(String(renderCaptureActions(ctx, { item: article })))];
  aiState(ctx).settings = null;
  assert.deepEqual(offered(), [true, 'research.start', true], 'before the AI settings are read, research is offered');
  aiState(ctx).settings = { research: { enabled: true } };
  assert.deepEqual(offered(), [true, 'research.start', true]);
  aiState(ctx).settings = { research: { enabled: false } };
  assert.deepEqual(offered(), [false, null, false], 'turned off: no button and no menu entry');
  assert.equal(researchMenuItem(article)?.action, 'research.start', 'without ctx the menu entry only needs the action');
});

test('research.start without an Anthropic key takes the AI setup path; other refusals are explained', async () => {
  const chrome = useChrome();
  try {
    const refuse = code => async () => { throw Object.assign(new Error(`Refused: ${code}`), { code }); };
    const { ctx, calls } = fakeCtx({ ai: { startResearch: refuse('no_research_connection') } });
    await dispatch('research.start', { ctx, data: { id: 'item_1' } });
    assert.equal(ctx.state.panel?.kind, 'settings', 'AI settings open in the side panel');
    assert.equal(ctx.state.settings?.section, 'ai');
    assert.match(calls.toasts.at(-1).message, /needs an Anthropic API key/);

    const off = fakeCtx({ ai: { startResearch: refuse('disabled') } });
    await dispatch('research.start', { ctx: off.ctx, data: { id: 'item_1' } });
    assert.equal(off.calls.toasts.at(-1).action.label, 'Open settings');

    const denied = useChrome({ granted: false, ask: false });
    try {
      const started = [];
      const blocked = fakeCtx({ ai: { startResearch: async options => { started.push(options); return {}; } } });
      await dispatch('research.start', { ctx: blocked.ctx, data: { id: 'item_1' } });
      assert.deepEqual(started, [], 'nothing starts without access');
      assert.equal(blocked.calls.toasts.at(-1).action.label, 'Allow access');
    } finally { denied.restore(); }

    const none = fakeCtx({ ai: { startResearch: undefined } });
    none.ctx.ai = undefined;
    await dispatch('research.start', { ctx: none.ctx, data: { id: 'item_1' } });
    assert.match(none.calls.toasts.at(-1).message, /still loading/);
  } finally { chrome.restore(); }
});

test('research started while a chat answer is being written leaves that answer running', async () => {
  const chrome = useChrome();
  try {
    const conversation = researchConversation({ status: 'starting' });
    const { ctx, calls } = fakeCtx({ ai: { startResearch: async () => { ctx.stored.set(conversation.id, conversation); return { conversationId: conversation.id }; } } });
    const controller = new AbortController();
    const s = aiState(ctx);
    s.run = { id: 'run-x', controller, conversationId: 'conversation_chat', user: { id: 'u', role: 'user', text: 'Hi' }, message: { id: 'm', role: 'assistant', text: '', proposals: [], tools: [] } };
    await dispatch('research.start', { ctx, data: { id: 'item_1' } });
    assert.equal(controller.signal.aborted, false, 'the answer keeps going');
    assert.equal(s.run.conversationId, 'conversation_chat');
    assert.notEqual(s.conversation?.id, 'conversation_r');
    const offer = calls.toasts.at(-1);
    assert.equal(offer.action.label, 'Open');
    await offer.action.run();
    assert.equal(chrome.calls.tabs.length, 1, 'still answering: the research opens in a new tab');
    assert.match(chrome.calls.tabs[0].url, /libraryView=assistant&conversation=conversation_r/);

    // Picking the research from the history while the answer runs does not abort it either.
    await dispatch('ai.history-open', { ctx, data: { id: 'conversation_r' } });
    assert.equal(controller.signal.aborted, false);
    assert.equal(calls.toasts.at(-1).action.label, 'Open in new tab');
  } finally { chrome.restore(); }
});

test('the still:research message is handled once, in this window’s side panel, from Still itself', async () => {
  const chrome = useChrome();
  try {
    const started = [];
    const conversation = researchConversation({ status: 'starting' });
    const { ctx } = fakeCtx({ ai: { startResearch: async options => { started.push(options); ctx.stored.set(conversation.id, conversation); return { conversationId: conversation.id }; } } });
    const worker = { id: 'still', url: 'chrome-extension://still/background.js' };
    const message = { type: 'still:research', itemId: 'item_1', windowId: 7, requestId: 'req_1' };
    const replies = [];
    const reply = value => replies.push(value);
    const seen = new Set();

    handleResearchMessage(ctx, { ...message, type: 'still:open-add' }, worker, reply, seen);
    handleResearchMessage(ctx, message, { id: 'another-extension' }, reply, seen);
    handleResearchMessage(ctx, message, { id: 'still', url: 'https://example.com/', tab: { id: 3 } }, reply, seen);
    handleResearchMessage(ctx, { ...message, windowId: 8 }, worker, reply, seen);
    handleResearchMessage(ctx, { ...message, itemId: '' }, worker, reply, seen);
    const full = fakeCtx({ side: false });
    handleResearchMessage(full.ctx, message, worker, reply, seen);
    assert.deepEqual(replies, [], 'other messages, senders, windows and the full tab are ignored');

    handleResearchMessage(ctx, message, worker, reply, seen);
    handleResearchMessage(ctx, message, worker, reply, seen);
    assert.deepEqual(replies, [{ ok: true }, { ok: true }], 'a retried delivery is answered again');
    await ticks(() => aiState(ctx).conversation?.id === 'conversation_r');
    assert.deepEqual(started, [{ itemId: 'item_1', instructions: '' }], 'but starts once');
    assert.equal(ctx.state.sideTab, 'ask');
    assert.equal(chrome.calls.requests.length, 0, 'no prompt outside a user gesture');
  } finally { chrome.restore(); }
});

test('the still:research message comes only from the extension’s worker, never a tab or another origin', async () => {
  const chrome = useChrome();
  try {
    const started = [];
    const conversation = researchConversation({ status: 'starting' });
    const { ctx } = fakeCtx({ ai: { startResearch: async options => { started.push(options); ctx.stored.set(conversation.id, conversation); return { conversationId: conversation.id }; } } });
    const message = { type: 'still:research', itemId: 'item_1', windowId: 7, requestId: 'req_gate' };
    const replies = [];
    const reply = value => replies.push(value);
    for (const sender of [
      { id: 'still', url: 'chrome-extension://still/index.html', tab: { id: 4 } },
      { id: 'still', tab: { id: 4 } },
      { id: 'still', url: 'https://example.com/page' },
      { id: 'still', origin: 'https://example.com' },
      { id: 'still', origin: 'chrome-extension://stillness' },
    ]) assert.equal(handleResearchMessage(ctx, message, sender, reply), undefined, JSON.stringify(sender));
    assert.deepEqual(replies, [], 'a Still page in a tab, a tab without an address and senders outside the extension are ignored');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, []);
    handleResearchMessage(ctx, message, { id: 'still', origin: 'chrome-extension://still' }, reply);
    assert.deepEqual(replies, [{ ok: true }], 'the worker itself is answered');
    await ticks(() => started.length === 1);
  } finally { chrome.restore(); }
});

test('before the panel knows its window, the still:research reply waits for it and answers only for this window', async () => {
  const chrome = useChrome();
  try {
    let windows = 0;
    globalThis.chrome.windows = { getCurrent: async () => { windows++; return { id: 7 }; } };
    const started = [];
    const conversation = researchConversation({ status: 'starting' });
    const make = () => {
      const made = fakeCtx({ ai: { startResearch: async options => { started.push(options); made.ctx.stored.set(conversation.id, conversation); return { conversationId: conversation.id }; } } });
      delete made.ctx.state.windowId;
      return made;
    };
    const worker = { id: 'still', url: 'chrome-extension://still/background.js' };

    // Another window's request: the channel is held open, then closed without { ok: true }, and nothing starts.
    const other = make();
    const otherReplies = [];
    assert.equal(handleResearchMessage(other.ctx, { type: 'still:research', itemId: 'item_1', windowId: 8, requestId: 'req_w8' }, worker, value => otherReplies.push(value)), true);
    await ticks(() => otherReplies.length === 1);
    assert.deepEqual(otherReplies, [undefined]);
    assert.equal(windows, 1, 'the window was looked up');

    // This window's request: answered once the window is known, and the research starts.
    const mine = make();
    const replies = [];
    assert.equal(handleResearchMessage(mine.ctx, { type: 'still:research', itemId: 'item_1', windowId: 7, requestId: 'req_w7' }, worker, value => replies.push(value)), true);
    assert.deepEqual(replies, [], 'no answer before the window is known');
    await ticks(() => replies.length === 1 && aiState(mine.ctx).conversation?.id === 'conversation_r');
    assert.deepEqual(replies, [{ ok: true }]);
    assert.deepEqual(started, [{ itemId: 'item_1', instructions: '' }]);
  } finally { chrome.restore(); }
});

test('without host access the message shows Allow access, whose click starts the research', async () => {
  const chrome = useChrome({ granted: false });
  try {
    const started = [];
    const conversation = researchConversation({ status: 'starting' });
    const { ctx } = fakeCtx({ ai: { startResearch: async options => { started.push(options); ctx.stored.set(conversation.id, conversation); return { conversationId: conversation.id }; } } });
    handleResearchMessage(ctx, { type: 'still:research', itemId: 'item_1', windowId: 7, requestId: 'req_2' }, { id: 'still' }, () => {});
    await ticks(() => !!aiState(ctx).researchAccess);
    assert.deepEqual(started, []);
    const panel = flat(renderAiPanel(ctx, { surface: 'side' }));
    assert.match(panel, /data-key="ai.research-notice"/);
    assert.match(panel, /Allow Still to reach api.anthropic.com to research “Building effective agents”\./);
    assert.match(panel, /data-action="research.allow"/);

    const pending = dispatch('research.allow', { ctx });
    assert.equal(chrome.calls.requests.length, 1, 'the click asks Chrome');
    await pending;
    assert.deepEqual(started, [{ itemId: 'item_1', instructions: '' }]);
    assert.equal(aiState(ctx).researchAccess, null);
  } finally { chrome.restore(); }
});

// ------------------------------------------------------------------------------------------------ actions

test('Stop, Resume, Raise cap, Try again and Undo call the run API', async () => {
  const chrome = useChrome();
  try {
    const log = [];
    const api = {
      stopResearch: async id => { log.push(['stop', id]); return { stopping: true }; },
      resumeResearch: async id => { log.push(['resume', id]); return { resumed: false, conversationId: id, reason: 'busy' }; },
      raiseResearchBudget: async (id, usd) => { log.push(['raise', id, usd]); return { raised: true, budgetUsd: usd }; },
      continueResearch: async (id, text) => { log.push(['continue', id, text]); return { conversationId: id }; },
      undoResearch: async id => { log.push(['undo', id]); return { section: 'removed', original: 'none', trashed: ['page_1'], kept: [] }; },
    };
    const { ctx, calls } = fakeCtx({ conversation: researchConversation({ steps: STEPS }), ai: api });
    await dispatch('research.stop', { ctx, data: { id: 'conversation_r' } });
    await dispatch('ai.stop', { ctx });
    assert.deepEqual(log.splice(0), [['stop', 'conversation_r'], ['stop', 'conversation_r']], 'the composer’s Stop stops the research too');

    aiState(ctx).conversation = researchConversation({ heartbeatAt: ago(RESEARCH_STALE_MS + 5000) });
    await dispatch('research.resume', { ctx, data: { id: 'conversation_r' } });
    assert.deepEqual(log.splice(0), [['resume', 'conversation_r']]);
    assert.equal(calls.toasts.at(-1).message, 'Another Still window is running this research.');

    aiState(ctx).conversation = researchConversation({ status: 'waiting', reason: 'budget', usage: { costUsd: 5.01 } });
    await dispatch('research.raise', { ctx, el: { dataset: {} }, data: { id: 'conversation_r' } });
    const menu = calls.menus.at(-1);
    assert.deepEqual(menu.items.map(item => item.label || item.heading), ['$5.01 spent so far', 'Raise the cap to $10', 'Raise the cap to $15', 'Raise the cap to $20', 'Raise the cap to $30']);
    const requests = chrome.calls.requests.length;
    await menu.items[1].run();
    assert.equal(chrome.calls.requests.length, requests + 1, 'the menu click asks for access');
    assert.deepEqual(log.splice(0), [['raise', 'conversation_r', 10]]);
    assert.match(calls.toasts.at(-1).message, /Raised the spending cap to \$10\. The research continues\./);

    aiState(ctx).conversation = researchConversation({ status: 'failed', error: 'Claude is overloaded right now.', request: { kind: 'followup', text: 'Compare pricing' } });
    const retry = dispatch('research.retry', { ctx, data: { id: 'conversation_r' } });
    assert.equal(chrome.calls.requests.length, requests + 2, 'Try again asks inside the click');
    await retry;
    assert.deepEqual(log.splice(0), [['continue', 'conversation_r', 'Compare pricing']]);

    const wrote = { itemId: 'item_1', sectionText: '## Research', subpageIds: ['page_1', 'page_2'] };
    aiState(ctx).conversation = researchConversation({ status: 'done', undo: wrote });
    await dispatch('research.undo', { ctx, data: { id: 'conversation_r' } });
    assert.match(calls.confirms.at(-1).body, /removes the research section from “Building effective agents” and moves 2 subpages it created to the Trash/);
    assert.deepEqual(log.splice(0), [['undo', 'conversation_r']]);
    assert.equal(calls.toasts.at(-1).message, 'Research changes undone: removed the research section and moved 1 subpage to the Trash.');

    const cautious = fakeCtx({ conversation: researchConversation({ status: 'done', undo: wrote }), ai: api, confirmAnswer: false });
    await dispatch('research.undo', { ctx: cautious.ctx, data: { id: 'conversation_r' } });
    assert.deepEqual(log, [], 'cancelled: nothing is undone');
  } finally { chrome.restore(); }
});

test('Try again asks for access inside the click even when the conversation is not open, and retries an unsent kickoff as itself', async () => {
  const chrome = useChrome();
  try {
    const log = [];
    const api = { continueResearch: async (id, text) => { log.push([id, text]); return { conversationId: id }; } };
    const failed = researchConversation({ status: 'failed', error: 'Claude is overloaded right now.', request: { kind: 'followup', text: 'Compare pricing' }, sent: true });
    const { ctx } = fakeCtx({ conversation: failed, ai: api });
    aiState(ctx).conversation = null;
    const retry = dispatch('research.retry', { ctx, data: { id: 'conversation_r' } });
    assert.equal(chrome.calls.requests.length, 1, 'asked before the stored conversation is read');
    await retry;
    assert.deepEqual(log.splice(0), [['conversation_r', 'Compare pricing']]);

    // A kickoff that never reached the session: no "pick up where it stopped" for a session that knows nothing yet.
    const unsent = fakeCtx({ conversation: researchConversation({ status: 'failed', error: 'Bad event.', sent: false }), ai: api });
    await dispatch('research.retry', { ctx: unsent.ctx, data: { id: 'conversation_r' } });
    const focused = fakeCtx({ conversation: researchConversation({ status: 'failed', error: 'Bad event.', sent: false, request: { kind: 'kickoff', text: 'Focus on pricing.' } }), ai: api });
    await dispatch('research.retry', { ctx: focused.ctx, data: { id: 'conversation_r' } });
    // A kickoff that did reach the session and failed mid-run picks up where it stopped.
    const midRun = fakeCtx({ conversation: researchConversation({ status: 'failed', error: 'Claude is overloaded right now.', sent: true }), ai: api });
    await dispatch('research.retry', { ctx: midRun.ctx, data: { id: 'conversation_r' } });
    assert.deepEqual(log, [['conversation_r', ''], ['conversation_r', 'Focus on pricing.'], ['conversation_r', 'Pick up where the research stopped and finish it.']]);
  } finally { chrome.restore(); }
});

test('Resume without host access offers Allow access, whose click asks again and resumes', async () => {
  const denied = useChrome({ granted: false, ask: false });
  let granted = null;
  try {
    const resumed = [];
    let refuse = null;
    const { ctx, calls } = fakeCtx({ conversation: researchConversation({ heartbeatAt: ago(RESEARCH_STALE_MS + 5000) }), ai: {
      resumeResearch: async id => { if (refuse) { const error = refuse; refuse = null; throw error; } resumed.push(id); return { resumed: true, conversationId: id }; },
    } });
    await dispatch('research.resume', { ctx, data: { id: 'conversation_r' } });
    assert.deepEqual(resumed, [], 'nothing resumes without access');
    const toast = calls.toasts.at(-1);
    assert.equal(toast.message, 'Research needs access to api.anthropic.com. Allow it to start.');
    assert.equal(toast.action?.label, 'Allow access');
    denied.restore();
    granted = useChrome();
    await toast.action.run();
    assert.equal(granted.calls.requests.length, 1, 'Allow access is a new click that asks Chrome again');
    assert.deepEqual(resumed, ['conversation_r']);

    // A run refused for host access by the engine offers the same way back.
    refuse = Object.assign(new Error('No access.'), { code: 'permission' });
    await dispatch('research.resume', { ctx, data: { id: 'conversation_r' } });
    const again = calls.toasts.at(-1);
    assert.equal(again.action?.label, 'Allow access');
    await again.action.run();
    assert.deepEqual(resumed, ['conversation_r', 'conversation_r']);
  } finally { (granted || denied).restore(); }
});

test('Open note and subpage chips open notes in the editor and other items in their panel', async () => {
  const { ctx, calls } = fakeCtx();
  await dispatch('research.open-item', { ctx, data: { id: 'page_1' } });
  assert.equal(ctx.state.sideTab, 'notes');
  assert.equal(ctx.state.notes.noteId, 'page_1');
  await dispatch('research.open-item', { ctx, data: { id: 'item_1' } });
  assert.deepEqual(calls.openItem, ['item_1']);
  await dispatch('research.open-item', { ctx, data: { id: 'page_gone' } });
  assert.match(calls.toasts.at(-1).message, /no longer in your library/);
});

test('a follow-up in a research conversation goes to continueResearch, not the chat model', async () => {
  const chrome = useChrome();
  try {
    const sent = [];
    let refuse = null;
    const { ctx, calls } = fakeCtx({ conversation: researchConversation({ status: 'done', text: 'Findings.' }), target: null, ai: {
      runAssistant: async () => { throw new Error('the chat model must not answer'); },
      continueResearch: async (id, text) => { if (refuse) throw refuse; sent.push([id, text]); return { conversationId: id }; },
    } });
    const s = aiState(ctx);
    s.draft = 'Compare it with LangGraph';
    const pending = dispatch('ai.send', { ctx });
    assert.equal(chrome.calls.requests.length, 1, 'host access is asked inside the key press');
    assert.equal(s.draft, '', 'the composer clears at once');
    await pending;
    await ticks(() => sent.length === 1 && !s.researchSending);
    assert.deepEqual(sent, [['conversation_r', 'Compare it with LangGraph']]);

    refuse = Object.assign(new Error('This research is still running. Stop it first, or wait for it to finish.'), { code: 'busy' });
    s.draft = 'And CrewAI?';
    await dispatch('ai.send', { ctx });
    await ticks(() => !s.researchSending);
    assert.equal(s.draft, 'And CrewAI?', 'a refused follow-up stays in the composer');
    assert.match(calls.toasts.at(-1).message, /still running/);

    // While the research runs, Enter does not send (the Stop button shows instead).
    s.conversation = researchConversation({ steps: STEPS });
    s.draft = 'More';
    await dispatch('ai.send', { ctx });
    assert.equal(sent.length, 1);
  } finally { chrome.restore(); }
});

test('the page that drives a run follows its live events; only visible changes redraw the page', async () => {
  let listener = null;
  const stored = researchConversation({ steps: STEPS.slice(0, 2) });
  const { ctx, calls } = fakeCtx({ conversation: stored, ai: {
    subscribeResearch: fn => { listener = fn; return () => {}; },
    getAiSettings: async () => ({}), listConnections: async () => [], resolveChatTarget: async () => { throw new Error('none'); },
  } });
  await initPanel(ctx);
  assert.equal(typeof listener, 'function', 'the panel subscribes to research events');
  const live = researchConversation({ steps: STEPS.slice(0, 3) });
  const s = aiState(ctx);
  let renders = calls.renders;
  listener({ type: 'research', conversationId: 'conversation_r', status: 'running', conversation: live, message: live.messages[1] });
  assert.equal(s.conversation, live, 'the run’s own copy');
  assert.ok(calls.renders > renders, 'a new step redraws');
  renders = calls.renders;
  const version = s.version;
  live.messages[1].research.preview = { id: 'ev_1', text: 'Reading the docs' };
  listener({ type: 'research', conversationId: 'conversation_r', status: 'running', conversation: live, message: live.messages[1] });
  assert.equal(calls.renders, renders, 'streamed text repaints the transcript only');
  assert.ok(s.version > version);
  listener({ type: 'research', conversationId: 'another', status: 'running', conversation: researchConversation({ id: 'another' }) });
  assert.equal(s.conversation, live, 'another run’s events are ignored');
});

test('a run this page drives redraws for any step’s state or label and for writes, not only the last step', async () => {
  let listener = null;
  const { ctx, calls } = fakeCtx({ conversation: researchConversation({ steps: STEPS.slice(0, 3) }), ai: {
    subscribeResearch: fn => { listener = fn; return () => {}; },
    getAiSettings: async () => ({}), listConnections: async () => [], resolveChatTarget: async () => { throw new Error('none'); },
  } });
  await initPanel(ctx);
  const live = researchConversation({ steps: structuredClone(STEPS) });
  const send = () => listener({ type: 'research', conversationId: 'conversation_r', status: 'running', conversation: live, message: live.messages[1] });
  send();
  const redraws = change => { const before = calls.renders; change(); send(); return calls.renders > before; };
  assert.equal(redraws(() => { live.messages[1].research.preview = { id: 'ev_2', text: 'More text' }; }), false, 'streamed text alone does not redraw the page');
  assert.equal(redraws(() => { live.messages[1].research.steps[1].state = 'error'; }), true, 'an earlier step that failed');
  assert.equal(redraws(() => { live.messages[1].research.steps[2].label = 'Read 3 GitHub results'; }), true, 'a step whose label changed');
  assert.equal(redraws(() => { live.messages[1].research.writes = 2; }), true, 'a write (Undo depends on it)');
  assert.equal(redraws(() => { live.research.writes = 2; }), true);
});

test('a new turn in the run’s own copy scrolls the transcript to it; streamed text leaves a scrolled-up reader alone', async () => {
  const saved = { Node: globalThis.Node, CSS: globalThis.CSS, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame, createElement: globalThis.document.createElement };
  globalThis.Node ??= class {};
  globalThis.CSS ??= { escape: value => String(value) };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.document.createElement = () => ({ innerHTML: '', content: { firstChild: null } });
  try {
    let listener = null;
    const { ctx } = fakeCtx({ conversation: researchConversation({ steps: STEPS.slice(0, 2) }), ai: {
      subscribeResearch: fn => { listener = fn; return () => {}; },
      getAiSettings: async () => ({}), listConnections: async () => [], resolveChatTarget: async () => { throw new Error('none'); },
    } });
    await initPanel(ctx);
    const live = researchConversation({ steps: STEPS.slice(0, 3) });
    const send = () => listener({ type: 'research', conversationId: 'conversation_r', status: 'running', conversation: live, message: live.messages.at(-1) });
    send();
    // The transcript mount (ui/runtime.js) on a stand-in element: enough of the DOM for its scroll position.
    const scroll = {};
    const el = { dataset: { mount: 'ai.transcript' }, isConnected: true, firstChild: null, scrollTop: 0, scrollHeight: 0, clientHeight: 200,
      addEventListener: (type, fn) => { scroll[type] = fn; }, removeEventListener() {}, querySelector: () => null };
    const root = { firstChild: null, ownerDocument: { addEventListener() {} }, querySelectorAll: () => (el.isConnected ? [el] : []) };
    const runtime = createRuntime({ root, ctx, view: () => '' });
    runtime.renderNow();
    assert.equal(typeof scroll.scroll, 'function', 'the transcript is mounted');
    // The reader scrolls up to read an earlier part.
    Object.assign(el, { scrollHeight: 1000, scrollTop: 100 });
    scroll.scroll();
    live.messages.at(-1).research.preview = { id: 'ev_3', text: 'Reading more' };
    send();
    runtime.renderNow();
    assert.equal(el.scrollTop, 100, 'streamed text does not pull the reader to the end');
    // A follow-up turn arrives in the same object the run keeps changing.
    live.messages.push({ id: 'q2', role: 'user', text: 'Compare it with LangGraph' },
      { id: 'a2', role: 'assistant', text: '', error: '', research: { live: true, steps: [], subpages: [], writes: 0, request: { kind: 'followup', text: 'Compare it with LangGraph' } } });
    send();
    assert.equal(aiState(ctx).conversation, live);
    runtime.renderNow();
    assert.equal(el.scrollTop, 1000, 'the new turn scrolls into view');
    el.isConnected = false;
    runtime.renderNow();
  } finally {
    for (const [key, value] of [['Node', saved.Node], ['CSS', saved.CSS], ['requestAnimationFrame', saved.raf], ['cancelAnimationFrame', saved.caf]]) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
    if (saved.createElement === undefined) delete globalThis.document.createElement; else globalThis.document.createElement = saved.createElement;
  }
});

test('while research runs, the full-screen header cannot rename, export or delete the chat', () => {
  const { ctx } = fakeCtx({ side: false, view: 'assistant', conversation: researchConversation({ steps: STEPS }) });
  const running = flat(renderAssistantPage(ctx));
  assert.doesNotMatch(running, /class="asst-title-input"/, 'the title is plain text');
  assert.match(running, /<span class="asst-title-text"[^>]*>Research: Building effective agents<\/span>/);
  assert.match(running, /<button[^>]*data-action="assistant\.export"[^>]*disabled/);
  assert.match(running, /<button[^>]*data-action="assistant\.more"[^>]*disabled/);
  aiState(ctx).conversation = researchConversation({ status: 'done', text: 'Findings.' });
  const done = flat(renderAssistantPage(ctx));
  assert.match(done, /class="asst-title-input"/);
  assert.doesNotMatch(done, /<button[^>]*data-action="assistant\.(?:export|more)"[^>]*disabled/);
  // Paused with no window driving it, the chat can be renamed again.
  aiState(ctx).conversation = researchConversation({ heartbeatAt: ago(RESEARCH_STALE_MS + 1000) });
  assert.match(flat(renderAssistantPage(ctx)), /class="asst-title-input"/);
});

test('renaming a running research renames the stored copy; deleting it stops the run first', async () => {
  const stored = researchConversation({ steps: STEPS.slice(0, 2) });
  const live = researchConversation({ steps: STEPS });
  const log = [];
  const { ctx } = fakeCtx({ conversation: stored, ai: {
    saveConversation: async value => { log.push(['save', value]); return value; },
    stopResearch: async id => { log.push(['stop', id]); return { stopping: true }; },
    deleteConversation: async id => { log.push(['delete', id]); },
  } });
  const s = aiState(ctx);
  s.conversation = live;
  assert.equal(await renameAiConversation(ctx, 'conversation_r', 'Agents, compared'), 'Agents, compared');
  const [[, saved]] = log.splice(0);
  assert.equal(saved.title, 'Agents, compared');
  assert.equal(saved.messages[1].research.steps.length, 2, 'the stored copy, not the one the run is still writing');
  assert.equal(s.conversation, live, 'the run’s copy stays open');
  assert.equal(live.title, 'Agents, compared', 'and shows the new name until the run adopts it');

  await dispatch('ai.history-delete', { ctx, data: { id: 'conversation_r' } });
  assert.deepEqual(log.splice(0), [['stop', 'conversation_r'], ['delete', 'conversation_r']]);
  // Paused at its cap in the history list (not open): stopped first too. A finished research is just deleted.
  s.history = [{ id: 'paused', kind: 'research', title: 'Research: Paused', research: { status: 'waiting' } }, { id: 'finished', kind: 'research', title: 'Research: Done', research: { status: 'done' } }];
  await dispatch('ai.history-delete', { ctx, data: { id: 'paused' } });
  await dispatch('ai.history-delete', { ctx, data: { id: 'finished' } });
  assert.deepEqual(log, [['stop', 'paused'], ['delete', 'paused'], ['delete', 'finished']]);
});

test('a new chat or another conversation drops the research Allow access notice', async () => {
  const chat = { id: 'chat_1', title: 'Plain chat', messages: [{ id: 'u1', role: 'user', text: 'Hi' }, { id: 'a1', role: 'assistant', text: 'Hello.' }] };
  const { ctx } = fakeCtx();
  ctx.stored.set(chat.id, chat);
  const s = aiState(ctx);
  s.researchAccess = { itemId: 'item_1' };
  await dispatch('ai.new', { ctx });
  assert.equal(s.researchAccess, null);
  s.researchAccess = { itemId: 'item_1' };
  await dispatch('ai.history-open', { ctx, data: { id: 'chat_1' } });
  assert.equal(s.conversation?.id, 'chat_1');
  assert.equal(s.researchAccess, null);
  assert.doesNotMatch(flat(renderAiPanel(ctx, { surface: 'side' })), /ai\.research-notice/);
});

test('the context rail of a research chat shows the page and its subpages, and the pages the research read as sources', () => {
  const second = [step('t1', 'fetch', 'Read langchain.com', 'done', { url: 'https://www.langchain.com/langgraph/' }), step('t2', 'fetch', 'Read anthropic.com', 'done', { url: 'https://www.anthropic.com/research/building-effective-agents' })];
  const conversation = researchConversation({ status: 'done', steps: STEPS, text: 'Findings.', subpages: [{ id: 'page_1', title: 'Frameworks compared' }] });
  conversation.messages.push({ id: 'q2', role: 'user', text: 'Compare it with LangGraph' },
    { id: 'a2', role: 'assistant', text: 'LangGraph.', error: '', research: { live: false, steps: second, subpages: [], writes: 0, request: { kind: 'followup', text: 'Compare it with LangGraph' }, sent: true } });
  assert.deepEqual(researchSources(conversation), [
    { n: 1, url: 'https://www.anthropic.com/research/building-effective-agents', title: 'anthropic.com/research/building-effective-agents' },
    { n: 2, url: 'https://www.langchain.com/langgraph/', title: 'langchain.com/langgraph' },
  ], 'every turn, each address once, without the page that could not be read');
  const { ctx } = fakeCtx({ side: false, view: 'assistant', conversation });
  const page = flat(renderAssistantPage(ctx));
  const rail = page.slice(page.indexOf('id="asst-context"'));
  assert.ok(rail.length < page.length, 'the context rail is docked');
  assert.doesNotMatch(rail, /id="asst-scope"|data-action="ai\.add-context"|Asking about/, 'no scope controls: research is about one page');
  assert.match(rail, /<h3 class="asst-section-title" id="asst-scope-title">Research on<\/h3>/);
  assert.match(rail, /<span class="asst-scope-name">Building effective agents<\/span><span class="asst-scope-meta">Article · 1 subpage<\/span>/);
  assert.match(rail, /data-action="research\.open-item" data-id="item_1"/);
  assert.match(rail, /class="ai-page-chip" data-action="research\.open-item" data-id="page_1"/);
  assert.match(rail, /Sources<span class="asst-count">2<\/span>/);
  assert.match(rail, /data-action="app\.open-url" data-url="https:\/\/www\.anthropic\.com\/research\/building-effective-agents"[^]*<span class="ai-source-title">anthropic\.com\/research\/building-effective-agents<\/span>/);
  assert.doesNotMatch(rail, /blocked\.example/);

  // While it runs, before any page is read, the rail says where sources will appear.
  aiState(ctx).conversation = researchConversation({ steps: STEPS.slice(0, 1) });
  const starting = flat(renderAssistantPage(ctx));
  assert.match(starting, /id="asst-scope-title">Researching</);
  assert.match(starting, /Pages the research reads appear here/);
  // A plain chat keeps its scope controls.
  aiState(ctx).conversation = { id: 'chat', title: 'Chat', messages: [{ id: 'u', role: 'user', text: 'Hi' }, { id: 'a', role: 'assistant', text: 'Hello.' }] };
  assert.match(flat(renderAssistantPage(ctx)), /id="asst-scope" data-change="assistant\.scope"/);
});

// ------------------------------------------------------------------------------------------------ auto-approved proposals

test('a proposal the assistant permissions allow shows as applying, then "Applied automatically" with Undo', async () => {
  const { ctx } = fakeCtx({ side: false, view: 'assistant' });
  const proposal = { id: 'proposal_auto', title: '1 change', summary: 'Create collection API Consoles.', autoApproved: true,
    changes: [{ op: 'create_collection', label: 'Create collection API Consoles', itemIds: [], count: 0, collectionId: 'collection_api', collectionName: 'API Consoles', tools: ['create_collection'] }] };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = { undone: 0 };
  ctx.ai.runAssistant = async ({ onEvent, conversationId }) => {
    onEvent({ type: 'proposal', proposal });
    await gate;
    const undo = { createdCollections: ['collection_api'] };
    onEvent({ type: 'proposal_result', proposalId: proposal.id, status: 'applied', summary: proposal.summary, autoApproved: true, undo: async () => { seen.undone++; } });
    const message = { id: 'msg_auto', role: 'assistant', text: 'Done.', proposals: [{ ...proposal, status: 'applied', undo }], tools: [], citations: [] };
    return { conversation: { id: conversationId, title: 'Consoles', messages: [{ id: 'q_auto', role: 'user', text: 'Make a collection' }, message] }, message };
  };
  ctx.ai.undoProposal = async () => { seen.undone++; };
  const s = aiState(ctx);
  s.draft = 'Make a collection for API consoles';
  await dispatch('ai.send', { ctx });
  await ticks(() => s.run?.message.proposals.length === 1);
  const applying = flat(renderProposalCard(ctx, s.run.message.proposals[0]));
  assert.match(applying, /data-status="applying" data-auto="true"/);
  assert.match(applying, /Applying changes automatically…/);
  assert.doesNotMatch(applying, /ai.proposal-apply|Needs approval/, 'no card waits for a decision');
  assert.equal(s.announce, 'Applying changes your assistant permissions allow.');

  release();
  await ticks(() => !s.run);
  const saved = s.conversation.messages[1].proposals[0];
  const receipt = flat(renderProposalCard(ctx, saved));
  assert.match(receipt, /data-status="applied" data-auto="true"/);
  assert.match(plainText(receipt), /Applied automatically: created collection API Consoles/);
  assert.match(receipt, /Your assistant permissions allow these changes without review\./);
  assert.match(receipt, /data-action="ai.permissions"/);
  assert.match(receipt, /data-action="ai.proposal-undo"/);
  await dispatch('ai.proposal-undo', { ctx, data: { id: 'proposal_auto' } });
  assert.equal(seen.undone, 1, 'Undo reverts what was applied automatically');

  // After a reload the saved record still says so and still offers Undo.
  const reloaded = fakeCtx();
  reloaded.ctx.ai.undoProposal = async () => { seen.undone++; };
  const again = flat(renderProposalCard(reloaded.ctx, { ...saved, id: 'proposal_saved_auto' }));
  assert.match(plainText(again), /Applied automatically: created collection API Consoles/);
  assert.match(again, /data-action="ai.proposal-undo"/, 'the saved undo record still reverts it');
  const several = flat(renderProposalCard(reloaded.ctx, { ...saved, id: 'proposal_multi', appliedLines: ['Created collection A', 'Moved 2 items to A'] }));
  assert.match(plainText(several), /Applied 2 changes automatically/);
});
