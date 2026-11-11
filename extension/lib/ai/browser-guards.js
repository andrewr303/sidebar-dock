// What the assistant tracks while it works in a browser, as pure functions over the browser control layer's results.
// They come from Still Agent's loop: an action whose outcome was not seen must not be reported as done, a model that
// repeats itself is told so and then stopped, and the rest of a batch is not run on a page that has changed.
// Tool names here are the layer's own (click, not browser_click).

/** Page actions: a result that does not show what they did leaves something to verify. */
export const PAGE_ACTIONS = new Set(['click', 'set', 'fill_form', 'type', 'press', 'hover', 'scroll', 'navigate', 'handle_dialog']);
const READS = new Set(['snapshot', 'find', 'read', 'screenshot']);
const NO_EFFECT_TOOLS = new Set(['click', 'set', 'type', 'press', 'fill_form']);

export const REPEAT_WINDOW = 6;
export const REPEAT_LIMIT = 3;
export const NO_EFFECT_NUDGE = 2;
export const NO_EFFECT_STOP = 3;
export const ERROR_STOP = 5;

/** The kind of a call: 'read', 'wait', 'control' (ask_user) or 'mutate'. `tabs list` reads; any other tabs action changes. */
export function kindOf(tool, args = {}) {
  if (tool === 'ask_user') return 'control';
  if (tool === 'wait') return 'wait';
  if (tool === 'tabs') return args?.action === 'list' ? 'read' : 'mutate';
  return READS.has(tool) ? 'read' : 'mutate';
}

/**
 * The receipt the assistant's rules read. Most actions have one. fill_form has one per field and one for the control
 * that submitted the form (data.receipts); the one that counts is the consequential one (a submit the layer
 * classified), else the last, which is where a navigation or a missing effect shows.
 */
export function receiptOf(tool, result) {
  if (result?.receipt) return result.receipt;
  const list = tool === 'fill_form' && Array.isArray(result?.data?.receipts) ? result.data.receipts.filter(entry => entry && typeof entry === 'object') : [];
  return list.find(entry => entry.sensitive) || list.at(-1);
}

/** `result` with `receipt` set as receiptOf gives it, so every rule below reads one shape. */
export function withReceipt(tool, result) {
  if (!result || typeof result !== 'object' || result.receipt) return result;
  const receipt = receiptOf(tool, result);
  return receipt ? { ...result, receipt } : result;
}

// The person's own decisions. What they declined or took over is not something left to verify.
const DECIDED = new Set(['USER_DECLINED', 'USER_STEP', 'CANCELLED']);

/**
 * Why a page action's result leaves its outcome unseen, in a few words for the person, or '' when it shows what
 * happened.
 */
export function debtReason(tool, result) {
  if (!PAGE_ACTIONS.has(tool) || !result) return '';
  if (!result.ok) {
    if (DECIDED.has(result.error?.code)) return '';
    return result.error?.delivered === true || result.error?.delivered === 'unknown' ? 'it failed after input may have reached the page' : '';
  }
  const receipt = result.receipt;
  if (receipt?.dispatched === 'unknown') return 'it is not known whether the input reached the page';
  if (result.pageError) return 'the page could not be read afterwards';
  if (result.pending?.length) return 'a dialog opened and was not answered';
  if (receipt?.postcondition?.status === 'unmet') return 'the expected result was not seen';
  if (receipt && ['none', 'unattributable'].includes(receipt.effect?.verdict) && receipt.postcondition?.status !== 'met') return 'the page showed no effect';
  return '';
}

/** Whether a page action's result leaves its outcome unseen. */
export const createsDebt = (tool, result) => debtReason(tool, result) !== '';

// What each action did, in words for the person; `target` is the element as the layer names it, without its ref.
const DID = {
  click: target => `Clicked ${target || 'an element'}`, set: target => `Filled in ${target || 'a field'}`, fill_form: () => 'Filled in a form',
  type: target => (target ? `Typed into ${target}` : 'Typed'), press: target => (target ? `Pressed a key in ${target}` : 'Pressed a key'),
  hover: target => `Pointed at ${target || 'an element'}`, scroll: () => 'Scrolled', navigate: () => 'Opened a page', handle_dialog: () => 'Answered a dialog',
};

/**
 * A label for an unverified action, for the person: "Clicked button «Send» on shop.example: the page showed no
 * effect". `where` is the page's site, or what stands for it when the address is not known.
 */
export function debtLabel(tool, result, where = '') {
  // The ref is the model's handle, not something a person reads.
  const target = String(result?.receipt?.target ?? '').replace(/^\[\w+\]\s*/, '');
  const reason = debtReason(tool, result);
  return `${(DID[tool] || (() => tool))(target)}${where ? ` on ${where}` : ''}${reason ? `: ${reason}` : ''}`;
}

/** Whether a later result is evidence of the tab's state after the action in `item` ({ tabId, rev }). */
export function clearsDebt(tool, result, item) {
  if (!result?.ok || result.pageError) return false;
  const page = result.page;
  // A read of the same tab that succeeds takes a new capture after any dispatched action.
  if (READS.has(tool)) return (page?.tabId ?? item.tabId) === item.tabId;
  if (tool === 'wait' && result.data?.met && result.data.met !== 'time') return (page?.tabId ?? item.tabId) === item.tabId;
  if (page && page.tabId === item.tabId && ['diff', 'full'].includes(page.changed) && page.rev > item.rev) return true;
  return result.receipt?.postcondition?.status === 'met' && page?.tabId === item.tabId;
}

/** Refs a mutation's diff removed: a later call in the same batch that targets one of them is not run. */
export function removedRefs(result) {
  const refs = new Set();
  for (const op of result?.page?.diff?.ops ?? []) {
    if (op && typeof op === 'object' && typeof op.remove === 'string') {
      const ref = /\[(\w+)\]/.exec(op.remove)?.[1];
      if (ref) refs.add(ref);
    }
  }
  return refs;
}

/** Whether a call's outcome ends the batch: { tool, result, isError, handover }. */
export function stopsBatch({ tool, result, isError = false, handover = false }) {
  if (isError || handover) return true;
  if (!result) return false;
  if (!result.ok) return true;
  const receipt = result.receipt;
  if (receipt?.navigation || receipt?.newTab) return true;
  if (result.pending?.length) return true;
  // A call that waited on a card, whatever the answer: the page may have moved meanwhile.
  if (receipt?.allowedBy === 'user' || receipt?.confirmedByUser) return true;
  return !!receipt && NO_EFFECT_TOOLS.has(tool) && receipt.effect?.verdict === 'none' && receipt.postcondition?.status !== 'met';
}

// A short, stable fingerprint of what a result showed (FNV-1a). Not a security hash: it only tells two outcomes apart.
function fingerprint(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(36);
}

// What a successful call showed of the page: the outline of a look, the picture of a screenshot, the changes after an
// action. The layer counts a revision on every capture, so the revision itself says nothing about whether the page
// differs; the text does.
function shown(tool, result) {
  if (!result?.ok) return '';
  if (READS.has(tool)) {
    if (typeof result.data?.base64 === 'string') return fingerprint(`${result.data.base64.length}:${result.data.base64.slice(0, 20_000)}`);
    const text = typeof result.page?.snapshot === 'string' ? result.page.snapshot : String(result.text || '');
    return fingerprint(text.replace(/\brev \d+(?: → \d+)?/g, 'rev'));
  }
  const ops = result.page?.diff?.ops;
  return Array.isArray(ops) && ops.length ? fingerprint(JSON.stringify(ops)) : '';
}

/**
 * The signature of a call: tool, arguments (without the stated purpose), what came of it and what the page showed.
 * Looking again at a page that has changed, or clicking Next on a new page of results, is therefore not a repeat;
 * the same look at the same page, or the same click with the same change, is.
 */
export function signature(tool, args, result, isError) {
  const rest = Object.fromEntries(Object.entries(args || {}).filter(([key]) => key !== 'intent'));
  const outcome = result ? (result.ok ? result.receipt?.effect?.verdict ?? 'ok' : result.error?.code ?? 'error') : isError ? 'error' : 'ok';
  const seen = shown(tool, result);
  return `${tool} ${JSON.stringify(rest)} → ${outcome}${seen ? ` ${seen}` : ''}`;
}

/**
 * Guards against loops. record() returns { nudge } (a note for the model on the result that caused it) or { stop, guard }
 * (the run should end with what it has). Counters belong to the run and are not reset by navigation.
 */
export function createGuards() {
  const state = { recent: [], noEffect: {}, errorsInRow: 0 };
  return {
    state,
    record(tool, args, result, isError) {
      const sig = signature(tool, args, result, isError);
      state.recent = [...state.recent, sig].slice(-REPEAT_WINDOW);
      state.errorsInRow = isError ? state.errorsInRow + 1 : 0;
      if (state.errorsInRow >= ERROR_STOP) return { stop: `${ERROR_STOP} calls in a row failed.`, guard: 'errors' };
      const target = NO_EFFECT_TOOLS.has(tool) ? args?.target ?? args?.submit : null;
      const key = target ? JSON.stringify(target) : null;
      if (key && result?.ok && result.receipt?.effect?.verdict === 'none' && result.receipt.postcondition?.status !== 'met') {
        const count = (state.noEffect[key] ?? 0) + 1;
        state.noEffect[key] = count;
        if (count >= NO_EFFECT_STOP) return { stop: `${tool} on the same target had no effect ${count} times.`, guard: 'no_effect' };
        if (count >= NO_EFFECT_NUDGE) {
          const signals = (result.receipt.effect.signals || []).join(' · ') || 'no signal';
          return { nudge: `${tool} on this target had no effect ${count} times (${signals}). Try another way, or ask the user.` };
        }
      }
      const repeats = state.recent.filter(entry => entry === sig).length;
      if (repeats >= REPEAT_LIMIT) return { nudge: `you made the same call with the same outcome ${repeats} times in your last ${REPEAT_WINDOW} calls. Try something else, or ask the user.` };
      return {};
    },
  };
}
