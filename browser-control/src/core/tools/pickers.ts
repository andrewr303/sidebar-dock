// Custom pickers for `set`: ARIA comboboxes and listboxes (open, find the popup, pick the option by its name, click it,
// read the control back) and ARIA sliders (keys planned from aria-valuemin, aria-valuemax and aria-valuenow).
// Both choose their mechanism by rule before anything is sent and name each choice in the receipt's `how`.
import { LayerError } from '../../protocol/errors';
import type { SetArgs } from '../../protocol/schemas';
import type { ActionReceipt } from '../../protocol/results';
import type { ComboFacts, PopupFacts, ProbeState, SliderAria } from '../../probe';
import type { ToolContext, ToolOutcome } from '../controller';
import { checkCancelled } from '../controller';
import type { RefRecord } from '../refs';
import type { ResolvedTarget } from '../interaction/resolve';
import { waitForActionable } from '../interaction/actionability';
import { dispatchClick } from '../interaction/pointer';
import type { DialogInfo } from '../interaction/pointer';
import { KeyGuard } from '../interaction/key-guard';
import type { KeyGuardOptions } from '../interaction/key-guard';
import { extraEvidence, withEvidence } from '../interaction/evidence';
import { preflightNavigation } from '../interaction/preflight';
import { gateTarget } from '../interaction/gate';
import type { GateResult } from '../interaction/gate';
import { listOptions, matchOption, planSlider } from '../interaction/options';
import type { PopupOption } from '../interaction/options';
import { parseNumber } from '../interaction/native-values';
import { quote } from '../text';
import { withPageState } from './navigate';
import {
  gateOn,
  guardedOf,
  postcondition,
  receiptOf,
  sensitive,
  sensitiveRequest,
  stateOf,
  withHow,
  withKeyGuard,
  withReleased,
} from './text';

/** How long a popup has to appear after the control was opened. */
const POPUP_WAIT_MS = 2_000;
const POLL_MS = 100;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const norm = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** Polls for the popup until it shows options or the wait is over. Reads only. */
async function waitForPopup(ctx: ToolContext, target: ResolvedTarget): Promise<PopupFacts> {
  const probe = ctx.tab().probe!;
  const deadline = performance.now() + POPUP_WAIT_MS;
  let facts: PopupFacts = { found: false, via: 'none', options: [], total: 0 };
  for (;;) {
    checkCancelled(ctx);
    facts = await probe.call<PopupFacts>(target.frame, target.objectId, 'popupFacts');
    if ((facts.found && facts.total > 0) || performance.now() >= deadline) return facts;
    await sleep(POLL_MS);
  }
}

/**
 * Sets a custom combobox or listbox to the option with the requested name. The way it is opened is chosen before
 * anything is sent: already open (a listbox, aria-expanded=true, or a popup in view) needs no input; a text input
 * opens with ArrowDown; anything else with a trusted click. The popup is found through aria-controls, aria-owns,
 * aria-activedescendant or a listbox layer that appeared; the option by its accessible name, exactly then
 * case-insensitively. No match or several matches are errors that list the options and select nothing.
 */
export async function setCombobox(
  ctx: ToolContext,
  target: ResolvedTarget,
  facts: ComboFacts,
  args: SetArgs,
): Promise<ToolOutcome> {
  if (typeof args.value !== 'string' || !args.value.trim()) {
    throw new LayerError('INVALID_ARGUMENT', `${target.description} takes the name of one option as text`);
  }
  if (args.submit) {
    throw new LayerError(
      'INVALID_ARGUMENT',
      `submit is not supported on ${target.description}. Pick the option, then activate the form's submit control.`,
    );
  }
  const wanted = args.value;
  const probe = ctx.tab().probe!;
  const hide = sensitive(target, await stateOf(ctx, target)) || sensitiveRequest(wanted);
  // Listboxes that are in view now are noted, so a layer that appears after opening can be told from them.
  await probe.callGlobal(target.frame, 'markListboxes');
  const already = await probe.call<PopupFacts>(target.frame, target.objectId, 'popupFacts');
  const open: 'already-open' | 'arrow-down' | 'click' =
    facts.kind === 'listbox' || facts.expanded === true || (already.found && already.total > 0)
      ? 'already-open'
      : facts.typed
        ? 'arrow-down'
        : 'click';
  const gated = await gateOn(
    ctx,
    target,
    'set',
    open === 'click' ? 'activate' : 'none',
    args.intent,
    { pointer: open === 'click', budgetMs: args.timeoutMs },
    facts.typed,
  );
  return withReleased(
    ctx,
    target,
    gated.target,
    () => pickOption(ctx, gated.target, gated.gate, wanted, open, hide, facts.typed, args),
    gated.gate,
  );
}

async function pickOption(
  ctx: ToolContext,
  target: ResolvedTarget,
  gate: GateResult,
  wanted: string,
  open: 'already-open' | 'arrow-down' | 'click',
  hide: boolean,
  typed: boolean,
  args: SetArgs,
): Promise<ToolOutcome> {
  const probe = ctx.tab().probe!;
  const { cdp } = await ctx.attach();
  const how: string[] = [
    open === 'click'
      ? 'opened by a click'
      : open === 'arrow-down'
        ? 'opened by ArrowDown'
        : 'already open, no opening input',
  ];
  let chosen: PopupOption | undefined;
  let tier = '';
  let picked: { dispatched: boolean | 'unknown'; reachedTarget?: boolean } = { dispatched: false };
  const delivered = open !== 'already-open';
  const quoteName = (name: string) => (hide ? '«masked»' : quote(name));
  const { evidence } = await withEvidence(ctx, target, args.expect, { masked: hide }, async () => {
    ctx.tab().actionSeq++;
    if (open === 'click') {
      const actionable = await waitForActionable(ctx, target, { pointer: true, budgetMs: args.timeoutMs });
      const click = await dispatchClick(ctx, target, actionable.point, { gate });
      if (click.dialog) return { dialog: click.dialog as DialogInfo | undefined };
    } else if (open === 'arrow-down') {
      const state = await stateOf(ctx, target);
      if (!state.focused)
        await cdp.send(target.frame.sessionId, 'DOM.focus', { backendNodeId: target.record.backendNodeId });
      const options: KeyGuardOptions = {
        delivered: false,
        progress: arrived => (arrived ? 'ArrowDown reached it.' : 'ArrowDown did not reach it.'),
      };
      const dialog = await withKeyGuard(
        ctx,
        () => KeyGuard.arm(ctx, guardedOf(target), options),
        null,
        keys => keys.press('ArrowDown'),
      );
      if (dialog) return { dialog: dialog as DialogInfo | undefined };
    }
    const popup = await waitForPopup(ctx, target);
    if (!popup.found || popup.total === 0) {
      throw new LayerError(
        'STATE_UNCHANGED',
        `No list of options appeared for ${target.description} (looked through aria-controls, aria-owns, aria-activedescendant and new listbox layers for ${POPUP_WAIT_MS / 1000} s).`,
        {
          delivered,
          hint: 'Take a snapshot to see what the control opened, then click the option by its ref.',
        },
      );
    }
    how.push(`popup found by ${popup.via}`);
    const match = matchOption(popup.options, wanted);
    const asked = hide ? 'the value given (masked)' : quote(wanted);
    // A text input can also take free text, which set does not do for a combobox: type does.
    const freeText = typed ? ' To enter free text instead, use type on this target with replace: true.' : '';
    const listing = hide
      ? 'The options are not listed (sensitive control).'
      : `Options: ${listOptions(popup.options, quote)}.`;
    if (match.kind === 'none') {
      throw new LayerError(
        'NO_SUCH_OPTION',
        `No option of ${target.description} has the name ${asked}. ${listing} The list was left open; nothing was selected.${freeText}`,
        { delivered },
      );
    }
    if (match.kind === 'ambiguous') {
      const candidates = hide
        ? `${match.candidates.length} options`
        : match.candidates.map(o => `#${o.index + 1} ${quote(o.name)}`).join('; ');
      throw new LayerError(
        'AMBIGUOUS_OPTION',
        `More than one option of ${target.description} matches ${asked}: ${candidates}. ${listing} The list was left open; nothing was selected.`,
        { delivered },
      );
    }
    chosen = match.option;
    tier = match.tier;
    if (chosen.disabled) {
      throw new LayerError('DISABLED', `The option ${quoteName(chosen.name)} of ${target.description} is disabled.`, {
        delivered,
      });
    }
    how.push(`option ${quoteName(chosen.name)} matched by ${tier === 'value' ? 'value attribute' : `${tier} name`}`);
    const outcome = await clickOption(ctx, target, chosen, args);
    picked = outcome;
    return { dialog: outcome.dialog as DialogInfo | undefined };
  });
  // Read back after settle: the control's own value, then the option's aria-selected if the popup is still there.
  const state = await stateOf(ctx, target).catch(() => null);
  const now = state
    ? await probe.call<ComboFacts>(target.frame, target.objectId, 'comboFacts').catch(() => null)
    : null;
  const popup = state
    ? await probe.call<PopupFacts>(target.frame, target.objectId, 'popupFacts').catch(() => null)
    : null;
  let built: ActionReceipt['postcondition'];
  if (!chosen) {
    built = { status: 'not_checked', detail: 'no option was picked' };
  } else if (hide) {
    built = { status: 'not_checked', detail: 'value is masked' };
  } else if (!now) {
    built = { status: 'not_checked', detail: 'the control could not be read back' };
  } else {
    const name = chosen.name;
    const selected = popup?.options.some(o => norm(o.name) === norm(name) && o.selected) ?? false;
    if (norm(now.text) === norm(name) || (now.text && norm(now.text).includes(norm(name)))) {
      built = { status: 'met', detail: `the control shows ${quote(now.text)}` };
    } else if (selected) {
      built = { status: 'met', detail: `option ${quote(name)} is marked aria-selected` };
    } else {
      built = {
        status: 'unmet',
        detail: `the control shows ${now.text ? quote(now.text) : 'nothing'} and option ${quote(name)} is not marked selected`,
      };
    }
  }
  const receipt = receiptOf('set', target, 'select-option-aria', {
    dispatched: open === 'already-open' ? picked.dispatched : true,
    reachedTarget: picked.reachedTarget,
    effect: evidence.effect,
    navigation: evidence.navigation,
    newTab: evidence.newTab,
    ...extraEvidence(evidence),
    how,
    ...(evidence.downloads ? { downloads: evidence.downloads } : {}),
    postcondition: withHow(postcondition(built, evidence.postcondition, !!args.expect), how),
  });
  return withPageState(ctx, args.observe, { receipt });
}

/**
 * Clicks the option the match chose. The option is a node of the popup that no ref names, so it is identified here: by
 * its position and name in the popup (the probe returns it only if both still hold), and then by the same
 * layout identity a layout ref has (tag, text, the sources of its name), which every check before and after a press
 * compares. The click goes through the usual actionability, gate and pointer guard.
 */
async function clickOption(
  ctx: ToolContext,
  control: ResolvedTarget,
  option: PopupOption,
  args: SetArgs,
): Promise<{ dispatched: boolean | 'unknown'; reachedTarget?: boolean; dialog?: DialogInfo }> {
  const probe = ctx.tab().probe!;
  const backendNodeId = await probe.callForNode(
    control.frame,
    control.objectId,
    'optionNode',
    option.index,
    option.name,
  );
  if (backendNodeId === null) {
    throw new LayerError(
      'TARGET_CHANGED',
      `The list of ${control.description} changed before the option was clicked. Nothing was selected.`,
      {
        delivered: true,
      },
    );
  }
  const objectId = await probe.resolve(control.frame, backendNodeId);
  let current: ResolvedTarget | undefined;
  try {
    const [state, text, names] = await Promise.all([
      probe.call<ProbeState>(control.frame, objectId, 'state'),
      probe.call<string>(control.frame, objectId, 'textDigest'),
      probe.call<string>(control.frame, objectId, 'nameSources'),
    ]);
    const record: RefRecord = {
      ...control.record,
      ref: `${control.record.ref}/option`,
      backendNodeId,
      source: 'layout',
      print: { role: 'option', name: option.name, tag: state.tag, text, names, nth: null, context: null },
      stale: null,
    };
    const optionTarget: ResolvedTarget = {
      record,
      frame: control.frame,
      frames: control.frames,
      objectId,
      description: `option ${quote(option.name)} of ${control.description}`,
      via: control.via,
    };
    current = optionTarget;
    const prepare = async (t: ResolvedTarget) => {
      const actionable = await waitForActionable(ctx, t, { pointer: true, budgetMs: args.timeoutMs });
      // Policy layer 2: an option that is a link to a disallowed destination is refused before dispatch.
      await preflightNavigation(ctx, t.frame, t.objectId, 'activate', t.description);
      return { target: t, actionable };
    };
    const prepared = await prepare(optionTarget);
    const { state: ready, gate } = await gateTarget(
      ctx,
      prepared,
      { action: 'set', mode: 'activate', intent: args.intent },
      prepare,
    );
    current = ready.target;
    checkCancelled(ctx);
    ctx.tab().actionSeq++;
    const click = await dispatchClick(ctx, ready.target, ready.actionable.point, { gate });
    return { dispatched: click.dispatched, reachedTarget: click.reachedTarget, dialog: click.dialog };
  } finally {
    if (current) await probe.release(current.frame, current.objectId).catch(() => undefined);
  }
}

/** Reads aria-valuenow, giving a page that updates it a moment after the key. Null when it never shows a number. */
async function settledNow(read: () => Promise<SliderAria>, from: number | null): Promise<number | null> {
  let now = (await read()).now;
  for (let i = 0; i < 3 && now === from; i++) {
    await sleep(40);
    now = (await read()).now;
  }
  return now;
}

/**
 * Sets an ARIA slider with the keyboard. The keys are planned from aria-valuemin, aria-valuemax and aria-valuenow
 * before any is sent (Home or End when a bound is the target or the shorter way, arrow keys otherwise, at most 100).
 * A slider that declares no step is measured: after its first arrow key the real step is read, and the rest is
 * planned again from it. The result is read back from aria-valuenow.
 */
export async function setSlider(ctx: ToolContext, target: ResolvedTarget, args: SetArgs): Promise<ToolOutcome> {
  const wanted = typeof args.value === 'string' ? parseNumber(args.value) : null;
  if (wanted === null) {
    throw new LayerError('INVALID_ARGUMENT', `${target.description} is a slider and takes a number`);
  }
  if (args.submit) {
    throw new LayerError(
      'INVALID_ARGUMENT',
      `submit is not supported on ${target.description}. Set the slider, then activate the form's submit control.`,
    );
  }
  const probe = ctx.tab().probe!;
  const read = () => probe.call<SliderAria>(target.frame, target.objectId, 'sliderAria');
  const facts = await read();
  if (facts.readOnly) throw new LayerError('NOT_EDITABLE', `${target.description} is read-only`);
  const plan = planSlider(facts, wanted);
  if ('error' in plan) {
    throw new LayerError(
      'INVALID_ARGUMENT',
      `${target.description} is a slider from ${facts.min} to ${facts.max}; ${wanted} cannot be set: ${plan.error}. Nothing was dispatched.`,
      { delivered: false },
    );
  }
  if (plan.keys.length === 0) {
    const receipt = receiptOf('set', target, 'slider-keys', {
      dispatched: false,
      how: [plan.how],
      postcondition: { status: 'met', detail: `aria-valuenow is already ${wanted}` },
    });
    return withPageState(ctx, args.observe, { receipt });
  }
  const gated = await gateOn(ctx, target, 'set', 'none', args.intent, { pointer: false, budgetMs: args.timeoutMs });
  return withReleased(
    ctx,
    target,
    gated.target,
    () => pressSlider(ctx, gated.target, facts, plan, wanted, args),
    gated.gate,
  );
}

async function pressSlider(
  ctx: ToolContext,
  target: ResolvedTarget,
  facts: SliderAria,
  plan: { keys: string[]; arrows: number; how: string },
  wanted: number,
  args: SetArgs,
): Promise<ToolOutcome> {
  const probe = ctx.tab().probe!;
  const { cdp } = await ctx.attach();
  const read = () => probe.call<SliderAria>(target.frame, target.objectId, 'sliderAria');
  const how = [plan.how];
  // Focus without a click: a click on a slider moves its thumb.
  await waitForActionable(ctx, target, { pointer: false, budgetMs: args.timeoutMs });
  if (!(await stateOf(ctx, target)).focused) {
    await cdp.send(target.frame.sessionId, 'DOM.focus', { backendNodeId: target.record.backendNodeId });
  }
  checkCancelled(ctx);
  const options: KeyGuardOptions = {
    delivered: false,
    progress: arrived => `${arrived} key presses reached the slider; the rest were not sent.`,
  };
  // A step the page does not declare is measured once, after the first arrow key.
  let measure = facts.step === null && plan.arrows >= 2;
  const { evidence } = await withEvidence(ctx, target, args.expect, {}, () =>
    withKeyGuard(
      ctx,
      () => KeyGuard.arm(ctx, guardedOf(target), options),
      null,
      async keys => {
        ctx.tab().actionSeq++;
        let list = plan.keys;
        for (let i = 0; i < list.length; i++) {
          const arrow = list[i].startsWith('Arrow');
          const from = measure && arrow ? (await read()).now : null;
          const dialog = await keys.press(list[i]);
          if (dialog) return { dialog };
          if (!measure || !arrow) continue;
          measure = false;
          const now = await settledNow(read, from);
          const step = now === null || from === null ? 0 : Math.abs(now - from);
          if (step === 0) {
            how.push('the first arrow key did not move the slider');
            break;
          }
          const again = planSlider({ ...facts, now: now!, step }, wanted);
          if ('error' in again) {
            how.push(`step measured as ${step}; ${again.error}`);
            break;
          }
          how.push(`step measured as ${step} after the first arrow key; then ${again.how}`);
          list = again.keys;
          i = -1;
        }
        return {};
      },
    ),
  );
  const after = await read().catch(() => null);
  const built: ActionReceipt['postcondition'] =
    after === null || after.now === null
      ? { status: 'not_checked', detail: 'aria-valuenow could not be read back' }
      : Math.abs(after.now - wanted) < 1e-9
        ? { status: 'met', detail: `aria-valuenow is ${after.now}${after.text ? ` (${quote(after.text)})` : ''}` }
        : { status: 'unmet', detail: `aria-valuenow is ${after.now}, requested ${wanted}` };
  const receipt = receiptOf('set', target, 'slider-keys', {
    effect: evidence.effect,
    navigation: evidence.navigation,
    newTab: evidence.newTab,
    ...extraEvidence(evidence),
    how,
    ...(evidence.downloads ? { downloads: evidence.downloads } : {}),
    postcondition: withHow(postcondition(built, evidence.postcondition, !!args.expect), how),
  });
  return withPageState(ctx, args.observe, { receipt });
}
