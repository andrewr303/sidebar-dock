// "Organize tags with AI": a dialog that has the AI read the library (or one collection), design the fewest tags that
// still organize it and assign them, then shows the plan for review. Nothing is written until Apply, and Apply has Undo.
// The engine is lib/ai/autotag.js (reached through ctx.ai); the rules that keep the tag count small are enforced there.
import { html, cx, plural } from './html.js';
import { icon } from './icons.js';
import { registerActions, hasAction } from './runtime.js';
import { registerDialog } from './overlay.js';
import { dialogFrame, button, segmented, switchToggle, textarea, field, checkbox, emptyState, spinner } from './components.js';

const DIALOG = 'ai.autotag';
const LEVELS = [
  { value: 'general', label: 'General', description: 'A few broad tags, each on many items.' },
  { value: 'balanced', label: 'Balanced', description: 'Broad tags plus a few focused ones.' },
  { value: 'specific', label: 'Specific', description: 'More, narrower tags. Small groups are allowed.' },
];
let controller = null;   // the running analysis, aborted when the dialog closes

const current = ctx => ctx.state.dialogs.findLast(d => d.name === DIALOG);
const update = (ctx, patch) => ctx.updateDialog(DIALOG, patch);

/** Opens the dialog; collectionId limits it to one collection (and its subcollections). */
export function openAutoTag(ctx, { collectionId = '' } = {}) {
  ctx.openDialog(DIALOG, { step: 'setup', collectionId, level: 'general', keepExisting: false, instructions: '', progress: null, raw: null, exclude: [], error: '' });
}

function scopeIds(ctx, collectionId) {
  return collectionId ? ctx.select.descendants(collectionId) : null;
}

function planFor(ctx, props) {
  const { raw } = props;
  if (!raw || typeof ctx.ai?.finalizeAutoTags !== 'function') return null;
  // Re-read each item's tags now: the library may have changed while the plan was being made or reviewed.
  const items = raw.items.map(entry => ctx.select.byId(entry.id)).filter(item => item && !item.deletedAt)
    .map(item => ({ id: item.id, title: item.title, tags: Array.isArray(item.tags) ? item.tags : [] }));
  return ctx.ai.finalizeAutoTags(items, raw.taxonomy, raw.assignments, { keepExisting: props.keepExisting, minSupport: raw.budget.minSupport, exclude: new Set(props.exclude) });
}

/* ------------------------------------------------------------------ render */

function renderSetup(ctx, props) {
  const collection = props.collectionId ? ctx.select.collection(props.collectionId) : null;
  const count = props.collectionId
    ? ctx.select.live().filter(item => new Set(scopeIds(ctx, props.collectionId)).has(item.collectionId)).length
    : ctx.select.live().length;
  const tags = ctx.select.tags?.() || [];
  const level = LEVELS.find(l => l.value === props.level) || LEVELS[0];
  const body = html`<div class="autotag">
    <p class="autotag-lead">The AI reads ${plural(count, 'item')}${collection ? html` in <strong>${collection.name}</strong>` : ''}, their collections and your
      ${plural(tags.length, 'existing tag')}, then proposes the fewest tags that keep everything easy to find. Tags that would fit only one or two items are left out.
      You review the plan before anything changes.</p>
    ${field({ label: 'How specific', hint: level.description,
      control: segmented({ name: 'level', value: props.level, options: LEVELS, action: 'autotag.level', ariaLabel: 'How specific' }) })}
    ${switchToggle({ label: 'Keep the tags I already have', checked: props.keepExisting, action: 'autotag.keep',
      description: props.keepExisting ? 'New tags are added; your tags stay unless the AI merges one into a broader tag.' : 'The AI may replace, merge or remove existing tags. You see every removal before applying.' })}
    ${field({ label: 'Instructions (optional)', id: 'autotag-instructions', hint: 'For example: “Tag by project”, “Keep #reading”, or “Use specific tags for programming languages”.',
      control: textarea({ id: 'autotag-instructions', value: props.instructions, rows: 2, action: 'autotag.instructions', placeholder: 'Anything the AI should follow' }) })}
    ${props.error ? html`<p class="field-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${props.error}</span></p>` : ''}
  </div>`;
  const footer = html`${props.errorCode === 'setup' ? button({ label: 'AI settings', icon: 'settings-2', variant: 'ghost', action: 'autotag.settings' }) : ''}
    <span class="spacer"></span>${button({ label: 'Cancel', action: 'overlay.dismiss' })}
    ${button({ label: 'Analyze', icon: 'sparkles', variant: 'primary', action: 'autotag.run', disabled: !count })}`;
  return dialogFrame({ name: DIALOG, title: 'Organize tags with AI', subtitle: collection ? collection.name : 'Whole library', body, footer });
}

function renderRunning(props) {
  const p = props.progress || { stage: 'taxonomy', done: 0, total: 0 };
  const label = p.stage === 'taxonomy' ? `Reading ${plural(p.total, 'item')} and your tags…` : `Tagging items ${Math.min(p.done + 1, p.total).toLocaleString()} to ${Math.min(p.done + 50, p.total).toLocaleString()} of ${p.total.toLocaleString()}…`;
  const pct = p.total ? Math.round((p.stage === 'taxonomy' ? 0.08 : 0.1 + 0.9 * (p.done / p.total)) * 100) : 5;
  const body = html`<div class="autotag-running" role="status" aria-live="polite">
    ${spinner({ size: 18 })}<span>${label}</span>
    <span class="autotag-meter" aria-hidden="true"><span style="inline-size:${pct}%"></span></span>
  </div>`;
  return dialogFrame({ name: DIALOG, title: 'Organize tags with AI', body, footer: html`<span class="spacer"></span>${button({ label: 'Stop', action: 'overlay.dismiss' })}` });
}

function renderReview(ctx, props) {
  const plan = planFor(ctx, props);
  if (!plan) return dialogFrame({ name: DIALOG, title: 'Organize tags with AI', body: emptyState({ icon: 'tags', title: 'The plan is no longer available', compact: true }) });
  const before = new Set((props.raw.items || []).flatMap(item => item.tags.map(tag => tag.toLowerCase()))).size;
  const excluded = new Set(props.exclude);
  const offered = props.raw.taxonomy.filter(tag => !plan.dropped.includes(tag.name));
  const counts = new Map(plan.tags.map(tag => [tag.name, tag]));
  const body = html`<div class="autotag">
    <p class="autotag-lead"><strong>${plural(plan.tags.length, 'tag')}</strong> across ${plural(props.raw.items.length, 'item')} (you have ${before.toLocaleString()} now).
      ${plural(plan.changes.length, 'item')} change. Untick a tag to leave it out.${props.raw.model ? html` <span class="autotag-model">Planned by ${props.raw.model}.</span>` : ''}</p>
    <ul class="autotag-tags" role="list">
      ${offered.map(tag => {
        const final = counts.get(tag.name);
        const on = !excluded.has(tag.name);
        return html`<li class="${cx('autotag-tag', !on && 'is-off')}" data-key="${tag.name}">
          ${checkbox({ checked: on, label: `#${tag.name}`, action: 'autotag.toggle', data: { tag: tag.name } })}
          <span class="autotag-count">${on && final ? plural(final.count, 'item') : 'Left out'}</span>
          ${on && final?.isNew ? html`<span class="badge" data-tone="accent">New</span>` : ''}
          ${tag.description ? html`<span class="autotag-desc">${tag.description}</span>` : ''}
          ${on && final?.mergedFrom.length ? html`<span class="autotag-merge">Replaces ${final.mergedFrom.map(name => `#${name}`).join(', ')}</span>` : ''}
        </li>`;
      })}
    </ul>
    ${plan.tags.filter(tag => !props.raw.taxonomy.some(t => t.name === tag.name)).length
      ? html`<p class="autotag-note">${icon('tag', { size: 14 })}<span>Kept as they are: ${plan.tags.filter(tag => !props.raw.taxonomy.some(t => t.name === tag.name)).map(tag => `#${tag.name}`).join(', ')}</span></p>` : ''}
    ${plan.removed.length ? html`<p class="autotag-note is-warning">${icon('tag', { size: 14 })}<span>No longer used after this: ${plan.removed.map(name => `#${name}`).join(', ')}</span></p>` : ''}
    ${plan.dropped.length ? html`<p class="autotag-note">${icon('info', { size: 14 })}<span>Left out because they fit too few items: ${plan.dropped.map(name => `#${name}`).join(', ')}</span></p>` : ''}
    ${plan.untagged ? html`<p class="autotag-note">${icon('info', { size: 14 })}<span>${plural(plan.untagged, 'item')} will have no tags.</span></p>` : ''}
    ${props.error ? html`<p class="field-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${props.error}</span></p>` : ''}
  </div>`;
  const footer = html`${button({ label: 'Start over', icon: 'rotate-ccw', variant: 'ghost', action: 'autotag.back' })}<span class="spacer"></span>
    ${button({ label: 'Cancel', action: 'overlay.dismiss' })}
    ${button({ label: plan.changes.length ? `Apply to ${plural(plan.changes.length, 'item')}` : 'Nothing to change', variant: 'primary', action: 'autotag.apply', disabled: !plan.changes.length, loading: props.applying })}`;
  return dialogFrame({ name: DIALOG, title: 'Review the new tags', body, footer });
}

function renderDialog(ctx, props) {
  if (props.step === 'running') return renderRunning(props);
  if (props.step === 'review') return renderReview(ctx, props);
  return renderSetup(ctx, props);
}

/* ------------------------------------------------------------------ actions */

async function run(ctx) {
  const props = current(ctx)?.props;
  if (!props) return;
  if (typeof ctx.ai?.planAutoTags !== 'function') { update(ctx, { error: 'AI is still loading. Try again in a moment.' }); return; }
  controller?.abort();
  const own = controller = new AbortController();
  update(ctx, { step: 'running', error: '', errorCode: '', progress: null });
  try {
    const raw = await ctx.ai.planAutoTags({ collectionIds: scopeIds(ctx, props.collectionId), level: props.level, keepExisting: props.keepExisting,
      instructions: props.instructions, signal: own.signal, onProgress: progress => { if (controller === own && current(ctx)) update(ctx, { progress }); } });
    if (controller !== own || !current(ctx)) return;
    update(ctx, { step: 'review', raw, exclude: [] });
  } catch (error) {
    if (own.signal.aborted || !current(ctx)) return;
    const setup = ['no_connection', 'no_model', 'permission', 'auth'].includes(error?.code) || /connect|settings/i.test(error?.message || '');
    update(ctx, { step: 'setup', error: error?.message || 'The AI could not finish. Try again.', errorCode: setup ? 'setup' : '' });
  } finally { if (controller === own) controller = null; }
}

async function apply(ctx) {
  const props = current(ctx)?.props;
  const plan = props && planFor(ctx, props);
  if (!plan?.changes.length) return;
  update(ctx, { applying: true, error: '' });
  try {
    await ctx.store.bulkUpdateItems(plan.changes.map(change => ({ id: change.id, patch: { tags: change.after } })));
  } catch (error) {
    update(ctx, { applying: false, error: error?.message || 'The tags could not be saved. Try again.' });
    return;
  }
  const previous = plan.changes.map(change => ({ id: change.id, patch: { tags: change.before } }));
  ctx.closeDialog(DIALOG);
  ctx.toast(`Retagged ${plural(plan.changes.length, 'item')} with ${plural(plan.tags.length, 'tag')}`, { tone: 'success', duration: 12000,
    action: { label: 'Undo', run: () => ctx.store.bulkUpdateItems(previous.filter(entry => ctx.select.byId(entry.id))) } });
}

registerDialog(DIALOG, renderDialog, { size: 'md', className: 'autotag-dialog', beforeClose: () => { controller?.abort(); controller = null; return true; } });

registerActions({
  'autotag.open': ({ ctx, data }) => openAutoTag(ctx, { collectionId: data?.collection || '' }),
  'autotag.level': ({ ctx, data }) => update(ctx, { level: data.value }),
  'autotag.keep': ({ ctx, el }) => update(ctx, { keepExisting: !!el.checked }),
  'autotag.instructions': ({ ctx, el }) => { const entry = current(ctx); if (entry) entry.props.instructions = el.value; },
  'autotag.run': ({ ctx }) => run(ctx),
  'autotag.toggle': ({ ctx, el, data }) => {
    const props = current(ctx)?.props;
    if (!props) return;
    const exclude = new Set(props.exclude);
    if (el.checked) exclude.delete(data.tag); else exclude.add(data.tag);
    update(ctx, { exclude: [...exclude] });
  },
  'autotag.back': ({ ctx }) => update(ctx, { step: 'setup', raw: null, exclude: [], error: '' }),
  'autotag.apply': ({ ctx }) => apply(ctx),
  'autotag.settings': ({ ctx }) => {
    ctx.closeDialog(DIALOG);
    if (hasAction('shell.settings')) ctx.dispatch('shell.settings', { data: { section: 'ai' } });
    else import('./settings.js').then(module => module.openSettings?.(ctx, 'ai')).catch(() => {});
  },
});
