// Research with AI (build contract §7): the research.start action, the side panel's still:research message and the
// research actions (stop, resume, raise the cap, undo, try again). What ai-panel.js and assistant-page.js draw for a
// research conversation (kind 'research', lib/ai/research/run.js), the status model and the host-access request live
// in research-view.js; they are re-exported here, so this module stays the one place to import research from.
//
// A run is driven by the page that starts or resumes it and mirrored into its conversation, so every other view renders
// the stored copy; ai-panel.js follows both (live research events in the driving page, storage changes elsewhere).
// Nothing here imports lib/ai: the engine loads lazily in app.js and is reached through ctx.ai.
import { plural } from './html.js';
import { registerActions } from './runtime.js';
import { hasOrigins } from '../lib/permissions.js';
import { openSettings } from './settings.js';
import { openNote } from './note-editor.js';
import { ensureWindowId } from './quick-add.js';
import { openAiConversation } from './ai-panel.js';
import { aiState } from './ai-state.js';
import {
  ACCESS_COPY, ANTHROPIC_ORIGIN, researchBusy as pending, itemTitle, liveItem, isResearchConversation, researchState, researchSubject, raiseOptions, formatUsd,
  undoSummary, retryText, requestResearchAccess, openResearchTab, handleResearchError as handleViewError,
} from './research-view.js';

export {
  ANTHROPIC_ORIGIN, GITHUB_ORIGIN, RESEARCH_STALE_MS, LIVE_STEPS, isResearchConversation, isResearchRunning,
  latestResearchMessage, formatUsd, raiseOptions, stepIcon, stepCount, stepSummary, progressLabel, researchState,
  researchSources, researchSubject, researchProblem, undoSummary, retryText, researchOrigins, researchOffered,
  requestResearchAccess, openResearchTab, watchStale, renderResearchSteps, renderSubpageChips, renderResearchBar,
  renderResearchChip, renderResearchNotice,
} from './research-view.js';

const text = value => typeof value === 'string' ? value : '';
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** Explains a rejected research call (research-view.js handleResearchError), with Still's settings as the way to fix it. */
export const handleResearchError = (ctx, error, options = {}) => handleViewError(ctx, error, { openSettings, ...options });

// ------------------------------------------------------------------------------------------------ opening and starting

/** Shows the assistant: the side panel's Ask tab, else the full tab's assistant (where the Ask panel is not open). */
function showAssistant(ctx) {
  if (ctx.env.isSidepanel) {
    ctx.state.panel = null;
    ctx.state.sideTab = 'ask';
    return;
  }
  if (ctx.state.view === 'assistant' || ctx.state.panel?.kind === 'ai') return;
  ctx.navigate('assistant');
}

/**
 * Shows a research conversation: the side panel's Ask tab, or the full tab's assistant. A view that is answering a
 * question keeps answering: the research is offered in a toast instead (opened here once the answer is done, else in a
 * new tab). Resolves true when the conversation was opened here.
 */
export async function openResearch(ctx, conversationId, { title = '' } = {}) {
  if (!conversationId) return false;
  const s = aiState(ctx);
  if (s.run && s.run.conversationId !== conversationId) {
    ctx.toast(title ? `Researching “${title}”. It keeps going while this answer finishes.` : 'The research started. It keeps going while this answer finishes.', {
      action: { label: 'Open', run: () => aiState(ctx).run ? openResearchTab(ctx, conversationId) : openResearch(ctx, conversationId, { title }) } });
    return false;
  }
  showAssistant(ctx);
  await openAiConversation(ctx, conversationId);
  return true;
}

/**
 * The modal dialog a button sits in, as its entry in the overlay stack, or null. overlay.js gives every opened dialog
 * its own id (the element's id too), so this is that very dialog, never a later one of the same name.
 */
export function dialogOf(ctx, el) {
  const node = el?.closest?.('.dialog[aria-modal="true"]');
  if (!node) return null;
  const stack = Array.isArray(ctx.state?.dialogs) ? ctx.state.dialogs : [];
  if (node.id) return stack.find(entry => entry?.id === node.id) || null;
  return stack.at(-1) || null;
}

// True while that dialog is still the top one. updateDialog swaps an entry object but keeps its id.
function isTopDialog(ctx, entry) {
  const top = ctx.state?.dialogs?.at(-1);
  return !!entry && !!top && (top === entry || (!!entry.id && top.id === entry.id));
}

// Starts the run once access is known, then opens its conversation. `access` resolves true when the Anthropic API
// can be reached. fromDialog: the dialog entry the click came from (dialogOf), closed once the research is open.
async function runStart(ctx, itemId, access, { instructions = '', fromDialog = null } = {}) {
  const s = aiState(ctx);
  s.researchAccess = null;
  if (!(await access)) {
    ctx.toast(ACCESS_COPY, { tone: 'warning', action: { label: 'Allow access', run: () => beginResearch(ctx, itemId, { instructions, fromDialog }) } });
    return null;
  }
  let result;
  try {
    result = await ctx.ai.startResearch({ itemId, instructions });
  } catch (error) {
    handleResearchError(ctx, error, { allow: () => beginResearch(ctx, itemId, { instructions, fromDialog }) });
    return null;
  }
  if (!result?.conversationId) return null;
  const title = itemTitle(ctx, itemId);
  s.announce = title ? `Researching “${title}”` : 'Research started';
  if (result.existing) ctx.toast(title ? `“${title}” is already being researched.` : 'This page is already being researched.');
  // The history list follows on its own: saving the conversation changes storage, which ai-panel.js watches.
  // Started from a dialog (the Add dialog once a page is saved): it closes, so the research it opened is in view. Only
  // that same dialog, and only while it is on top: if it was closed and a new Add dialog opened while the research
  // started, the new one and its draft stay.
  if (await openResearch(ctx, result.conversationId, { title }) && isTopDialog(ctx, fromDialog)) ctx.closeDialog?.(fromDialog.name);
  return result;
}

/**
 * The research.start action: researches a saved item and opens its conversation. Call it synchronously from the
 * click: it asks Chrome for host access before anything is awaited. No research engine (still loading, or the preview
 * build without it) says so instead of failing silently.
 */
export function beginResearch(ctx, itemId, { instructions = '', fromDialog = null } = {}) {
  if (typeof itemId !== 'string' || !itemId) return null;
  if (typeof ctx.ai?.startResearch !== 'function') {
    ctx.toast(ctx.ai ? 'Research is not available in this version of Still.' : 'The assistant is still loading. Try again in a moment.');
    return null;
  }
  const access = requestResearchAccess(ctx);
  return runStart(ctx, itemId, access, { instructions, fromDialog });
}

// A still:research message has no user gesture, so Chrome cannot ask for access here: without it the Ask tab shows
// the Allow access notice (its button is a click) instead of a failed run.
async function researchFromMessage(ctx, itemId) {
  showAssistant(ctx);
  ctx.render();
  if (typeof ctx.ai?.startResearch !== 'function') {
    ctx.toast(ctx.ai ? 'Research is not available in this version of Still.' : 'The assistant could not load. Reload Still to research this page.', { tone: 'danger' });
    return null;
  }
  if (ctx.env.isExtension && !(await hasOrigins([ANTHROPIC_ORIGIN]))) {
    const s = aiState(ctx);
    s.researchAccess = { itemId };
    s.announce = 'Still needs access to api.anthropic.com to research this page.';
    ctx.render();
    return null;
  }
  return runStart(ctx, itemId, Promise.resolve(true));
}

// Answers { ok: true } and starts the research, once per requestId (a retried delivery is answered again).
function receiveResearchRequest(ctx, message, sendResponse, seen) {
  sendResponse?.({ ok: true });
  if (message.requestId) {
    if (seen.has(message.requestId)) return;
    seen.add(message.requestId);
  }
  researchFromMessage(ctx, message.itemId).catch(error => handleResearchError(ctx, error));
}

/**
 * The side panel's handler for { type: 'still:research', itemId, windowId, requestId } (background.js, "Save and
 * research with AI"). Only the extension's own worker may send it: never a tab (a content script or a Still page in a
 * tab), another extension or a sender outside the extension. This window only, each requestId once (the worker retries
 * while the panel loads). Replies { ok: true }. Before this panel knows its window, the reply waits for it (the listener
 * returns true); a request for another window is then closed without an answer, so the worker keeps trying the panels.
 */
export function handleResearchMessage(ctx, message, sender, sendResponse, seen = new Set()) {
  if (message?.type !== 'still:research' || !ctx.env?.isSidepanel) return undefined;
  if (sender?.tab) return undefined;
  const runtime = globalThis.chrome?.runtime;
  if (runtime?.id && sender?.id !== runtime.id) return undefined;
  const senderUrl = text(sender?.url || sender?.origin);
  if (senderUrl && typeof runtime?.getURL === 'function') {
    // sender.url is an address inside the extension; sender.origin has no trailing slash.
    const base = runtime.getURL('');
    if (!senderUrl.startsWith(base) && senderUrl !== base.replace(/\/$/, '')) return undefined;
  }
  if (typeof message.itemId !== 'string' || !message.itemId) return undefined;
  if (Number.isInteger(message.windowId)) {
    if (!Number.isInteger(ctx.state?.windowId)) {
      ensureWindowId(ctx).then(id => {
        const windowId = Number.isInteger(ctx.state?.windowId) ? ctx.state.windowId : id;
        if (message.windowId === windowId) receiveResearchRequest(ctx, message, sendResponse, seen);
        else sendResponse?.();
      }, () => sendResponse?.());
      return true;
    }
    if (message.windowId !== ctx.state.windowId) return undefined;
  }
  receiveResearchRequest(ctx, message, sendResponse, seen);
  return undefined;
}

let listening = false;
export async function init(ctx) {
  if (listening || !ctx.env.isSidepanel || !ctx.env.isExtension) return;
  const api = globalThis.chrome;
  if (!api?.runtime?.onMessage?.addListener) return;
  listening = true;
  await ensureWindowId(ctx);
  const seen = new Set();
  api.runtime.onMessage.addListener((message, sender, sendResponse) => handleResearchMessage(ctx, message, sender, sendResponse, seen));
}

// ------------------------------------------------------------------------------------------------ actions

/** The research conversation an action names: the open one when it matches, else the stored copy. */
async function researchConversation(ctx, id) {
  const open = aiState(ctx).conversation;
  if (open?.id === id && isResearchConversation(open)) return open;
  const stored = id ? await ctx.ai?.getConversation?.(id) : null;
  return isResearchConversation(stored) ? stored : null;
}

// Runs one research action with its button busy; rejections are explained (handleResearchError).
async function act(ctx, id, name, task, { allow } = {}) {
  if (!id || pending.has(id)) return undefined;
  pending.set(id, name);
  ctx.render();
  try { return await task(); } catch (error) { handleResearchError(ctx, error, { allow }); return undefined; } finally {
    pending.delete(id);
    ctx.render();
  }
}

/** Opens a researched page or subpage: notes in the notes editor, anything else in its detail panel. */
export function openResearchItem(ctx, id) {
  const item = liveItem(ctx, id);
  if (!item) { ctx.toast('That page is no longer in your library.'); return; }
  if (item.type === 'note') openNote(ctx, id);
  else ctx.openItem(id);
}

function continueAfterAccess(ctx, id, textValue, name, access = requestResearchAccess(ctx)) {
  if (typeof ctx.ai?.continueResearch !== 'function') return null;
  return act(ctx, id, name, async () => {
    if (!(await access)) { ctx.toast(ACCESS_COPY, { tone: 'warning', action: { label: 'Allow access', run: () => continueAfterAccess(ctx, id, textValue, name) } }); return; }
    await ctx.ai.continueResearch(id, textValue);
    aiState(ctx).announce = 'The research continues.';
  }, { allow: () => continueAfterAccess(ctx, id, textValue, name) });
}

function raiseTo(ctx, id, usd) {
  const access = requestResearchAccess(ctx);
  return act(ctx, id, 'raise', async () => {
    if (!(await access)) { ctx.toast(ACCESS_COPY, { tone: 'warning', action: { label: 'Allow access', run: () => raiseTo(ctx, id, usd) } }); return; }
    const result = await ctx.ai.raiseResearchBudget(id, usd);
    const cap = formatUsd(result?.budgetUsd ?? usd);
    ctx.toast(`Raised the spending cap to ${cap}. The research continues.`, { tone: 'success' });
    aiState(ctx).announce = `Raised the spending cap to ${cap}.`;
  });
}

registerActions({
  'research.start': ({ ctx, el, data }) => beginResearch(ctx, data.id, { fromDialog: dialogOf(ctx, el) }),
  'research.open-item': ({ ctx, data }) => openResearchItem(ctx, data.id),
  'research.stop': ({ ctx, data }) => act(ctx, data.id, 'stop', async () => {
    const result = await ctx.ai.stopResearch(data.id);
    aiState(ctx).announce = result?.stopping === false || result?.stopped === false ? 'The research had already ended.' : 'Stopping the research.';
  }),
  'research.resume': ({ ctx, data }) => {
    const access = requestResearchAccess(ctx);
    const retry = () => ctx.dispatch('research.resume', { data });
    return act(ctx, data.id, 'resume', async () => {
      if (!(await access)) { ctx.toast(ACCESS_COPY, { tone: 'warning', action: { label: 'Allow access', run: retry } }); return; }
      const result = await ctx.ai.resumeResearch(data.id);
      if (result?.resumed) { aiState(ctx).announce = 'Research resumed.'; return; }
      const reason = text(result?.reason);
      ctx.toast(reason === 'busy' ? 'Another Still window is running this research.' : reason === 'budget' ? 'The research is paused at its spending cap. Raise the cap to continue.'
        : 'This research already ended. Ask for more below to continue it.');
    }, { allow: retry });
  },
  'research.raise': async ({ ctx, el, data }) => {
    const conversation = await researchConversation(ctx, data.id);
    if (!conversation) return;
    const state = researchState(conversation);
    const options = raiseOptions(state.budgetUsd, state.costUsd);
    if (!options.length) { ctx.toast('The spending cap is already at its highest. Ask for more below to continue in a new session.'); return; }
    ctx.openMenu(el, [
      { heading: state.costUsd !== null ? `${formatUsd(state.costUsd)} spent so far` : 'New spending cap' },
      ...options.map(usd => ({ label: `Raise the cap to ${formatUsd(usd)}`, icon: 'circle-dollar-sign', run: () => raiseTo(ctx, data.id, usd) })),
    ], { placement: 'bottom-start', label: 'Raise the spending cap' });
  },
  'research.retry': async ({ ctx, data }) => {
    const access = requestResearchAccess(ctx);
    const open = aiState(ctx).conversation;
    // The request text comes from the open conversation when it is this one, so Chrome's prompt stays in the click.
    if (open?.id === data.id) return continueAfterAccess(ctx, data.id, retryText(open), 'retry', access);
    const conversation = await researchConversation(ctx, data.id);
    return conversation ? continueAfterAccess(ctx, data.id, retryText(conversation), 'retry', access) : null;
  },
  'research.settings': async ({ ctx, data }) => {
    const conversation = await researchConversation(ctx, data.id);
    const code = researchState(conversation).errorCode;
    if (code === 'disabled') openSettings(ctx, 'research');
    else openSettings(ctx, 'ai', code === 'no_research_connection' ? { providerId: 'anthropic' } : {});
  },
  'research.undo': async ({ ctx, data }) => {
    const conversation = await researchConversation(ctx, data.id);
    if (!conversation) return;
    const undo = isObject(conversation.research.undo) ? conversation.research.undo : {};
    const subject = researchSubject(conversation, liveItem(ctx, conversation.research.itemId));
    const subpages = Array.isArray(undo.subpageIds) ? undo.subpageIds.length : 0;
    const body = [`Still removes the research section from “${subject}”${subpages ? ` and moves ${plural(subpages, 'subpage')} it created to the Trash` : ''}.`,
      text(undo.originalField) ? 'The original text is put back.' : '', 'Anything you edited since stays as it is.'].filter(Boolean).join(' ');
    const ok = await ctx.confirm({ title: 'Undo the research changes?', body, confirmLabel: 'Undo changes', tone: 'danger' });
    if (!ok) return;
    await act(ctx, data.id, 'undo', async () => {
      const message = undoSummary(await ctx.ai.undoResearch(data.id));
      ctx.toast(message);
      aiState(ctx).announce = message;
    });
  },
  'research.allow': ({ ctx }) => {
    const notice = aiState(ctx).researchAccess;
    return notice?.itemId ? beginResearch(ctx, notice.itemId) : null;
  },
  'research.notice-dismiss': ({ ctx }) => { aiState(ctx).researchAccess = null; ctx.render(); },
});
