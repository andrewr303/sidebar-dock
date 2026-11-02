// Research with AI, the view half (build contract §7): the status model of a research conversation (kind 'research',
// lib/ai/research/run.js) and the pieces ai-panel.js and assistant-page.js draw for it: the status bar, the progress
// timeline, the subpage chips, the context chip and the Allow access notice, plus the host-access request and the error
// handling the composer shares with the research actions.
//
// research.js (the research.start action, the still:research message and the research actions) builds on this module.
// Nothing here imports ai-panel.js, settings.js or research.js: ai-panel.js imports this view, so they never form an
// import cycle (the shared assistant state comes from ai-state.js). Nothing here imports lib/ai either: the engine loads
// lazily in app.js and is reached through ctx.ai.
import { html, raw, cx, plural } from './html.js';
import { icon } from './icons.js';
import { button, iconButton, spinner, TYPE_ICONS } from './components.js';
import { hasAction } from './runtime.js';
import { hasOrigins, requestOrigins } from '../lib/permissions.js';
import { aiState, assistantUrl } from './ai-state.js';
// Pure and dependency-free (no engine code): the limits and timing the engine enforces, shared with this view.
import { RESEARCH_LIMITS, RESEARCH_STALE_MS } from '../lib/ai/research/settings.js';

// Research talks to the Anthropic API (Managed Agents) and, unless GitHub research is off, to the GitHub API.
export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com/*';
export const GITHUB_ORIGIN = 'https://api.github.com/*';
// A running research whose owner has not saved a heartbeat for RESEARCH_STALE_MS is offered to Resume here (the same
// threshold the engine uses, from lib/ai/research/settings.js).
export { RESEARCH_STALE_MS };
// While research runs, the timeline shows its latest steps; the rest are one click away.
export const LIVE_STEPS = 6;
export const ACCESS_COPY = 'Research needs access to api.anthropic.com. Allow it to start.';
const RETRY_TEXT = 'Pick up where the research stopped and finish it.';

const STATUSES = ['starting', 'running', 'waiting', 'done', 'stopped', 'failed'];
const ACTIVE = new Set(['starting', 'running']);
const TERMINAL = new Set(['done', 'stopped', 'failed']);
// Failures the AI settings fix (a key, a workspace, the research connection); 'permission' has its own Allow access.
const SETTINGS_CODES = new Set(['auth', 'no_connection', 'no_research_connection', 'workspace_required', 'disabled']);
const STEP_ICONS = { search: 'search', fetch: 'globe', github: 'github', write: 'pen-line', subpage: 'file-plus', note: 'info', tool: 'wrench', status: 'info' };
// New spending caps to offer, up to the highest cap the engine accepts for a raise.
const RAISE_STEPS = [2, 3, 5, 10, 15, 20, 30, 50, 75, 100].filter(usd => usd <= RESEARCH_LIMITS.maxRaiseUsd);

const text = value => typeof value === 'string' ? value : '';
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const webUrl = value => /^https?:\/\/[^/\s]/i.test(text(value)) ? text(value) : '';
/** The saved item with this id while it is live (not in the Trash), else null. */
export const liveItem = (ctx, id) => { const item = id ? ctx.select?.byId?.(id) : null; return item && !item.deletedAt ? item : null; };
const listJoin = list => list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] || '';
// Actions in flight per conversation ('stop', 'resume', ...), so their button shows a spinner and cannot be pressed twice
// (research.js sets them, the research bar reads them).
export const researchBusy = new Map();

// ------------------------------------------------------------------------------------------------ pure helpers

/** True for a research conversation (kind 'research' with its run record). */
export const isResearchConversation = conversation => conversation?.kind === 'research' && isObject(conversation.research);
/** True when a research conversation is actively running (not stale, waiting, or finished). */
export const isResearchRunning = conversation => isResearchConversation(conversation) && researchState(conversation).running;

/** The latest assistant message of a research conversation (the one the current or last run writes into). */
export function latestResearchMessage(conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index]?.role === 'assistant' && isObject(messages[index].research)) return messages[index];
  return null;
}

/** "$5", "$0.42": a dollar amount for the spending cap and the cost so far. */
export function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return '';
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/** New spending caps to offer: the next few steps above both the current cap and what was already spent. */
export function raiseOptions(cap, spent) {
  const floor = Math.max(Number(cap) || 0, Number(spent) || 0);
  return RAISE_STEPS.filter(value => value > floor).slice(0, 4);
}

/** The icon of a progress step by its kind (search, fetch, github, write, subpage, note, tool, status). */
export const stepIcon = step => STEP_ICONS[step?.kind] || 'circle';

const validSteps = steps => (Array.isArray(steps) ? steps : []).filter(step => isObject(step) && text(step.label));

// Status rows (retrying, reconnecting) are not work the agent did; the engine's "N earlier steps" row stands for N.
const workSteps = steps => validSteps(steps).filter(step => step.kind !== 'status');
const foldedCount = steps => steps.filter(step => step.id === 'collapsed').reduce((sum, step) => sum + (Number.isInteger(step.count) ? step.count : 0), 0);

/** How many steps a run took (searches, pages read, lookups, writes), counting the ones the engine folded away. */
export function stepCount(steps) {
  const list = workSteps(steps);
  return list.filter(step => step.id !== 'collapsed').length + foldedCount(list);
}

/** One line that sums up a run's steps: "24 steps · 9 searches · 11 pages read · 2 GitHub lookups". */
export function stepSummary(steps) {
  const real = workSteps(steps).filter(step => step.id !== 'collapsed');
  const count = kind => real.filter(step => step.kind === kind).length;
  const searches = count('search'), reads = count('fetch'), github = count('github');
  return [plural(stepCount(steps), 'step'), searches && plural(searches, 'search', 'searches'), reads && `${plural(reads, 'page')} read`,
    github && plural(github, 'GitHub lookup')].filter(Boolean).join(' · ');
}

/** What the research is doing now: the latest running step's label, else the latest step's. */
export function progressLabel(message) {
  const steps = validSteps(message?.research?.steps).filter(step => step.id !== 'collapsed');
  const running = steps.findLast(step => step.state === 'running');
  return text((running || steps.at(-1))?.label);
}

/**
 * Everything the UI needs to know about a research run, from its conversation: { status, active, stale, running,
 * reason, error, errorCode, itemId, costUsd, budgetUsd, wrote, undone, label, tone, actions }. A run is stale when it
 * is starting or running but no view has saved a heartbeat for RESEARCH_STALE_MS (its page closed): it is offered to
 * Resume. actions, in order: 'stop' | 'resume' | 'raise' | 'retry' | 'allow' | 'settings', then 'undo'.
 */
export function researchState(conversation, { now = Date.now(), staleMs = RESEARCH_STALE_MS } = {}) {
  const research = isObject(conversation?.research) ? conversation.research : {};
  const status = STATUSES.includes(research.status) ? research.status : 'stopped';
  const active = ACTIVE.has(status);
  const beat = Date.parse(research.heartbeatAt);
  const stale = active && (!Number.isFinite(beat) || now - beat >= staleMs);
  const reason = text(research.reason);
  const errorCode = text(research.errorCode);
  const cost = Number(research.usage?.costUsd);
  const cap = Number(research.settings?.budgetUsd);
  const undo = isObject(research.undo) ? research.undo : {};
  const wrote = !!(text(undo.sectionText) || (Array.isArray(undo.subpageIds) && undo.subpageIds.length) || text(undo.originalField) || Number(research.writes) > 0);
  const undone = !!research.undoneAt;
  const actions = [];
  if (active && !stale) actions.push('stop');
  if (stale || (status === 'waiting' && reason === 'connection')) actions.push('resume');
  if (status === 'waiting' && reason === 'budget') actions.push('raise');
  if (status === 'failed') actions.push(errorCode === 'permission' ? 'allow' : SETTINGS_CODES.has(errorCode) ? 'settings' : 'retry');
  // Undo only once the run is over: a paused run that is undone and then continued would write past its undo record.
  if (TERMINAL.has(status) && wrote && !undone) actions.push('undo');
  const label = stale ? 'Paused' : status === 'starting' ? 'Starting' : status === 'running' ? 'Researching'
    : status === 'waiting' ? reason === 'budget' ? 'Paused at the spending cap' : reason === 'connection' ? 'Paused, connection lost' : 'Paused'
      : status === 'done' ? 'Done' : status === 'failed' ? 'Failed' : 'Stopped';
  const tone = active && !stale ? 'accent' : stale || status === 'waiting' ? 'warning' : status === 'done' ? 'success' : status === 'failed' ? 'danger' : 'neutral';
  return { status, active, stale, running: active && !stale, reason, error: text(research.error), errorCode, itemId: text(research.itemId),
    costUsd: Number.isFinite(cost) ? cost : null, budgetUsd: Number.isFinite(cap) && cap > 0 ? cap : null, wrote, undone, label, tone, actions };
}

// A web address as a short readable title: host (without www.) and path, without the trailing slash.
function addressTitle(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}` || url;
  } catch { return url; }
}

/**
 * The web pages a research conversation read (its steps' addresses, every turn), for the sources of the chat:
 * [{ n, url, title }] numbered in the order they were first opened, each address once. A page that could not be read
 * is not a source.
 */
export function researchSources(conversation) {
  const seen = new Map();
  for (const message of Array.isArray(conversation?.messages) ? conversation.messages : []) {
    if (message?.role !== 'assistant' || !isObject(message.research)) continue;
    for (const step of validSteps(message.research.steps)) {
      const url = webUrl(step.url);
      if (url && step.state !== 'error' && !seen.has(url)) seen.set(url, { n: seen.size + 1, url, title: addressTitle(url) });
    }
  }
  return [...seen.values()];
}

/** The saved page a research conversation is about: its current title, else the conversation's. */
export function researchSubject(conversation, item = null) {
  return text(item?.title).trim() || text(conversation?.title).replace(/^Research:\s*/i, '').trim() || 'this page';
}

/**
 * How a rejected research call is handled: { kind, message }. kind 'setup' (no Anthropic key: the AI setup path),
 * 'research-settings' (research is off), 'settings' (a key or workspace problem), 'permission' (host access),
 * 'info' (a plain notice) or 'error'.
 */
export function researchProblem(error) {
  const code = text(error?.code);
  const message = text(error?.message).trim();
  if (code === 'no_research_connection') return { kind: 'setup', message: 'Research needs an Anthropic API key. Add one in AI settings to start.' };
  if (code === 'disabled') return { kind: 'research-settings', message: message || 'Research is turned off. Turn it on in AI settings.' };
  if (code === 'permission') return { kind: 'permission', message: ACCESS_COPY };
  if (SETTINGS_CODES.has(code)) return { kind: 'settings', message: message || 'Check the Anthropic connection in AI settings.' };
  if (['extension_only', 'busy', 'budget', 'bad_request', 'not_found'].includes(code)) return { kind: 'info', message: message || 'The research could not continue.' };
  return { kind: 'error', message: message || 'The research could not start.' };
}

/** A sentence for the toast after undoResearch: what was removed, trashed or restored, and what was kept. */
export function undoSummary(result) {
  if (!isObject(result)) return 'Research changes undone.';
  if (result.alreadyUndone) return 'These research changes were already undone.';
  const done = [], kept = [];
  if (result.section === 'removed') done.push('removed the research section');
  if (result.section === 'changed') kept.push('the research section, because it was edited');
  const trashed = Array.isArray(result.trashed) ? result.trashed.length : 0;
  if (trashed) done.push(`moved ${plural(trashed, 'subpage')} to the Trash`);
  if (result.original === 'restored') done.push('restored the original');
  if (result.original === 'changed') kept.push('the original, because it was edited since');
  const first = done.length ? `Research changes undone: ${listJoin(done)}.` : 'Nothing was undone.';
  return kept.length ? `${first} Kept ${listJoin(kept)}.` : first;
}

/**
 * The request a failed run is retried with: the last turn's own request, else a plain "finish it". A kickoff that never
 * reached the session is retried as itself (its focus, or '' when there was none), so continueResearch sends the full
 * kickoff again without a second request in the transcript.
 */
export function retryText(conversation) {
  const message = latestResearchMessage(conversation);
  const request = message?.research?.request;
  const everSent = (Array.isArray(conversation?.messages) ? conversation.messages : [])
    .some(entry => entry?.role === 'assistant' && entry?.research?.sent === true);
  if (!everSent && (request?.kind || 'kickoff') === 'kickoff') return text(request?.text).trim();
  return text(request?.text).trim() || RETRY_TEXT;
}

/** Host access research asks for: Anthropic always, GitHub unless GitHub research is off (AI settings). */
export const researchOrigins = settings => settings?.research?.github === 'off' ? [ANTHROPIC_ORIGIN] : [ANTHROPIC_ORIGIN, GITHUB_ORIGIN];

/**
 * True when Still offers "Research with AI" here: the research actions are loaded (research.js registers research.start)
 * and the AI settings' "Offer Research with AI" is on. Until the AI settings have been read (they load with the
 * engine), research counts as offered. Every Research with AI button and menu entry checks this, so turning research
 * off hides them instead of leaving buttons that only say it is off.
 */
export function researchOffered(ctx) {
  if (!hasAction('research.start')) return false;
  return (ctx?.state ? aiState(ctx).settings : null)?.research?.enabled !== false;
}

// ------------------------------------------------------------------------------------------------ access and errors

/**
 * Asks Chrome for the hosts research needs. Call it synchronously from the click or key press, before any await:
 * Chrome shows its prompt only inside a user gesture, and answers at once when access was granted earlier. Resolves
 * true when api.anthropic.com can be reached (GitHub access is optional: its tools say so when they cannot run).
 */
export function requestResearchAccess(ctx) {
  if (!ctx.env?.isExtension || typeof globalThis.chrome?.permissions?.request !== 'function') return Promise.resolve(true);
  return requestOrigins(researchOrigins(aiState(ctx).settings)).then(granted => granted || hasOrigins([ANTHROPIC_ORIGIN]));
}

/** Opens a research conversation in the full-screen assistant of a new tab (the open chat here keeps running). */
export async function openResearchTab(ctx, conversationId) {
  const url = assistantUrl(conversationId);
  if (ctx.env.isExtension && globalThis.chrome?.tabs?.create) await globalThis.chrome.tabs.create({ url, active: true });
  else globalThis.open?.(url, '_blank', 'noopener');
}

// Rejections keep the engine's error codes (lib/ai/http.js), so each one leads somewhere useful instead of failing
// silently. allow: what Allow access runs (it is a new click, so Chrome can ask). openSettings: settings.js's opener,
// passed in by the caller (this module does not import settings.js; see the top of the file).
export function handleResearchError(ctx, error, { allow, openSettings } = {}) {
  if (error?.name === 'AbortError') return;
  const problem = researchProblem(error);
  if (problem.kind === 'error') console.error(error);
  if (problem.kind === 'setup') {
    // The AI setup path: AI settings with an Anthropic key ready to add.
    ctx.toast(problem.message, { tone: 'warning' });
    openSettings?.(ctx, 'ai', { providerId: 'anthropic' });
    return;
  }
  if (problem.kind === 'research-settings') { ctx.toast(problem.message, openSettings ? { action: { label: 'Open settings', run: () => openSettings(ctx, 'research') } } : {}); return; }
  if (problem.kind === 'permission') {
    ctx.toast(problem.message, { tone: 'warning', ...(allow ? { action: { label: 'Allow access', run: allow } } : {}) });
    return;
  }
  if (problem.kind === 'settings') { ctx.toast(problem.message, { tone: 'danger', ...(openSettings ? { action: { label: 'Open AI settings', run: () => openSettings(ctx, 'ai') } } : {}) }); return; }
  ctx.toast(problem.message, { tone: problem.kind === 'info' ? 'default' : 'danger' });
}

/** The current title of a saved item, '' when it is gone. */
export const itemTitle = (ctx, itemId) => text(ctx.select?.byId?.(itemId)?.title).trim();

// ------------------------------------------------------------------------------------------------ rendering

// Re-renders when a running research would turn stale, so Resume appears even though nothing else changes.
let staleTimer = 0;
export function watchStale(ctx, conversation, now = Date.now()) {
  clearTimeout(staleTimer);
  staleTimer = 0;
  const research = conversation?.research;
  if (!isResearchConversation(conversation) || !ACTIVE.has(research.status) || typeof ctx.render !== 'function') return;
  const beat = Date.parse(research.heartbeatAt);
  if (!Number.isFinite(beat) || now - beat >= RESEARCH_STALE_MS) return;
  staleTimer = setTimeout(() => { staleTimer = 0; ctx.render(); }, beat + RESEARCH_STALE_MS - now + 250);
  staleTimer.unref?.();
}

function stepRow(step) {
  const state = ['running', 'done', 'error'].includes(step.state) ? step.state : 'done';
  const url = webUrl(step.url);
  const glyph = state === 'running' ? spinner({ size: 14 })
    : state === 'error' ? icon('circle-alert', { size: 14, className: 'ai-step-error' }) : icon(stepIcon(step), { size: 14, className: 'ai-step-icon' });
  const said = state === 'running' ? html`<span class="sr-only">, in progress</span>` : state === 'error' ? html`<span class="sr-only">, did not work</span>` : '';
  const label = html`<span class="ai-step-label">${step.label}</span>${said}`;
  const detail = state === 'error' && text(step.detail) && step.detail !== step.label ? html`<span class="ai-step-detail">${step.detail}</span>` : '';
  return html`<li class="ai-step" data-kind="${text(step.kind) || 'tool'}" data-state="${state}">
    ${url ? html`<button type="button" class="ai-step-row is-link" data-action="app.open-url" data-url="${url}" title="${url}">${glyph}${label}${icon('arrow-up-right', { size: 12, className: 'ai-step-go' })}</button>`
      : html`<p class="ai-step-row">${glyph}${label}</p>`}
    ${detail}
  </li>`;
}

/**
 * The progress timeline of one research turn. While it runs: its latest LIVE_STEPS steps (searches, pages read,
 * GitHub lookups, writes, subpages) with "Show N earlier steps". After it ends: one summary row that expands to every
 * step. Rows with an address open it in a tab.
 */
export function renderResearchSteps(ctx, message, { live = false } = {}) {
  const steps = validSteps(message?.research?.steps);
  if (!steps.length || !message?.id) return '';
  const open = aiState(ctx).open || new Set();
  const listId = `ai-steps-${message.id}`;
  if (live) {
    const all = open.has(`steps-all:${message.id}`);
    const hidden = all ? 0 : Math.max(0, steps.length - LIVE_STEPS);
    return html`<div class="ai-steps is-live" data-key="steps:${message.id}">
      ${steps.length > LIVE_STEPS ? html`<button type="button" class="ai-tool-more" data-action="ai.toggle" data-open="steps-all:${message.id}"
        aria-expanded="${all ? 'true' : 'false'}" aria-controls="${listId}">${all ? 'Show fewer steps' : `Show ${plural(hidden, 'earlier step')}`}</button>` : ''}
      <ol class="ai-step-list" id="${listId}" role="list" aria-label="Research progress">${steps.slice(hidden).map(stepRow)}</ol>
    </div>`;
  }
  const expanded = open.has(`steps:${message.id}`);
  return html`<div class="ai-steps" data-key="steps:${message.id}">
    <button type="button" class="ai-tool-row ai-steps-toggle" data-action="ai.toggle" data-open="steps:${message.id}" aria-expanded="${expanded ? 'true' : 'false'}"
      aria-controls="${listId}">${icon('telescope', { size: 14 })}<span>${stepSummary(steps)}</span>${icon('chevron-right', { size: 12, className: 'ai-chevron' })}</button>
    <ol class="ai-step-list" id="${listId}" role="list" aria-label="Research steps" ${expanded ? '' : raw('hidden')}>${steps.map(stepRow)}</ol>
  </div>`;
}

/** The subpages a research turn created, as chips that open them (a subpage moved to the Trash shows as deleted). */
export function renderSubpageChips(ctx, message) {
  const pages = (Array.isArray(message?.research?.subpages) ? message.research.subpages : []).filter(page => isObject(page) && text(page.id));
  if (!pages.length) return '';
  return html`<ul class="ai-research-pages" role="list" aria-label="Subpages">${pages.map(page => {
    const item = liveItem(ctx, page.id);
    const title = text(item?.title).trim() || text(page.title).trim() || 'Untitled page';
    return html`<li>${item
      ? html`<button type="button" class="ai-page-chip" data-action="research.open-item" data-id="${page.id}">${icon('file-text', { size: 14 })}<span class="ai-page-chip-label">${title}</span></button>`
      : html`<span class="ai-page-chip is-gone">${icon('file', { size: 14 })}<span class="ai-page-chip-label">${title}</span><span class="ai-page-chip-note">Deleted</span></span>`}</li>`;
  })}</ul>`;
}

function stateButton(name, { id, busy, state }) {
  const loading = busy === name;
  switch (name) {
    case 'stop': return button({ label: 'Stop', icon: 'square', size: 'sm', action: 'research.stop', data: { id }, loading });
    case 'resume': return button({ label: 'Resume', icon: 'play', variant: 'primary', size: 'sm', action: 'research.resume', data: { id }, loading });
    case 'raise': return raiseOptions(state.budgetUsd, state.costUsd).length
      ? button({ label: 'Raise cap and continue', icon: 'circle-dollar-sign', variant: 'primary', size: 'sm', action: 'research.raise', data: { id }, loading,
        attrs: { 'aria-haspopup': 'menu' } }) : '';
    case 'retry': return button({ label: 'Try again', icon: 'refresh-cw', variant: 'primary', size: 'sm', action: 'research.retry', data: { id }, loading });
    case 'allow': return button({ label: 'Allow access', icon: 'shield-check', variant: 'primary', size: 'sm', action: 'research.retry', data: { id }, loading: busy === 'retry' });
    case 'settings': return button({ label: 'Open AI settings', icon: 'settings', size: 'sm', action: 'research.settings', data: { id } });
    default: return '';
  }
}

function statusDetail(state) {
  if (state.stale) return 'No open Still window is running it. Resume to continue it here.';
  if (state.status === 'waiting' && state.reason === 'budget') {
    if (!raiseOptions(state.budgetUsd, state.costUsd).length) return 'It reached the highest spending cap. Ask for more below to continue in a new session.';
    const cap = formatUsd(state.budgetUsd);
    return `It reached ${cap ? `its ${cap}` : 'its'} spending cap. Raise the cap to continue.`;
  }
  if (state.status === 'waiting' && state.reason === 'connection') return state.error || 'Still lost the connection to the research. Resume when you are back online.';
  if (state.undone) return 'Its changes to your library were undone.';
  return '';
}

/**
 * The research bar above a research conversation: "Researching “Title”", a live status line (role status, so progress
 * is announced), steps, subpages and cost, and the actions the run's state allows: Stop, Resume (no window runs it),
 * Raise cap and continue (paused at its cap), Try again / Allow access / Open AI settings (failed), Open note and Undo
 * research changes (asks first).
 */
export function renderResearchBar(ctx, conversation, { now = Date.now() } = {}) {
  if (!isResearchConversation(conversation)) return '';
  const state = researchState(conversation, { now });
  const item = liveItem(ctx, state.itemId);
  const subject = researchSubject(conversation, item);
  const message = latestResearchMessage(conversation);
  const steps = validSteps(message?.research?.steps);
  const id = conversation.id;
  const busy = researchBusy.get(id) || '';
  const status = [state.label, state.running ? progressLabel(message) : ''].filter(Boolean).join(' · ');
  const pages = (Array.isArray(conversation.research.pages) ? conversation.research.pages : []).length;
  const cost = state.costUsd !== null ? state.budgetUsd ? `${formatUsd(state.costUsd)} of ${formatUsd(state.budgetUsd)} cap` : `${formatUsd(state.costUsd)} spent`
    : state.budgetUsd ? `${formatUsd(state.budgetUsd)} cap` : '';
  const count = stepCount(steps);
  const meta = [count ? plural(count, 'step') : '', pages ? plural(pages, 'subpage') : '', cost].filter(Boolean).join(' · ');
  const detail = statusDetail(state);
  const buttons = state.actions.filter(name => name !== 'undo').map(name => stateButton(name, { id, busy, state }));
  if (item) buttons.push(button({ label: 'Open note', icon: item.type === 'note' ? 'notebook-pen' : TYPE_ICONS[item.type] || 'file-text', size: 'sm', action: 'research.open-item', data: { id: item.id } }));
  if (state.actions.includes('undo')) buttons.push(button({ label: 'Undo research changes', icon: 'undo-2', variant: 'ghost', size: 'sm', action: 'research.undo', data: { id }, loading: busy === 'undo' }));
  const shown = buttons.filter(entry => String(entry));
  return html`<section class="ai-research" data-key="ai.research" data-status="${state.status}" data-tone="${state.tone}" aria-labelledby="ai-research-title">
    <span class="ai-research-mark" aria-hidden="true">${icon('telescope', { size: 16 })}</span>
    <div class="ai-research-text">
      <h2 class="ai-research-title" id="ai-research-title">${state.active ? 'Researching' : 'Research on'} “${subject}”</h2>
      <p class="ai-research-status" role="status"><span class="${cx('ai-research-dot', state.running && 'is-running')}" aria-hidden="true"></span><span class="ai-research-now">${status}</span>${detail ? html`<span class="sr-only"> · ${detail}</span>` : ''}</p>
      ${meta ? html`<p class="ai-research-meta">${meta}</p>` : ''}
      ${detail ? html`<p class="ai-research-detail" aria-hidden="true">${detail}</p>` : ''}
    </div>
    ${shown.length ? html`<div class="ai-research-actions" role="group" aria-label="Research actions">${shown}</div>` : ''}
  </section>`;
}

/** The composer's one context chip in a research conversation: the page being researched (not removable). */
export function renderResearchChip(ctx, conversation) {
  const item = liveItem(ctx, conversation?.research?.itemId);
  return html`<span class="ai-chip is-research" role="listitem" title="${researchSubject(conversation, item)}">${icon('telescope', { size: 12 })}<span class="ai-chip-label">${researchSubject(conversation, item)}</span></span>`;
}

/** The notice above the composer when a research request (from the context menu) arrived without host access. */
export function renderResearchNotice(ctx) {
  const notice = aiState(ctx).researchAccess;
  if (!notice?.itemId) return '';
  const title = itemTitle(ctx, notice.itemId);
  return html`<div class="ai-notice" role="alert" data-key="ai.research-notice">
    ${icon('shield-check', { size: 16 })}
    <div class="ai-notice-text"><p>Allow Still to reach api.anthropic.com to research ${title ? `“${title}”` : 'this page'}.</p>
      <div class="ai-notice-actions">${button({ label: 'Allow access', icon: 'shield-check', variant: 'primary', size: 'sm', action: 'research.allow' })}</div></div>
    ${iconButton({ icon: 'x', label: 'Dismiss', size: 'sm', action: 'research.notice-dismiss' })}
  </div>`;
}
