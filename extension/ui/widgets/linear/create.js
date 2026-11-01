// "New Linear issue" dialog and the inline quick-create row. Both go through session.createIssue, which shows the new
// issue in its widget at once and then refreshes every Linear widget.
import { html } from '../../html.js';
import { icon } from '../../icons.js';
import { button, input, textarea, select, field, checkbox, dialogFrame } from '../../components.js';
import { registerActions } from '../../runtime.js';
import { registerDialog } from '../../overlay.js';
import { findWidget } from '../../../lib/dashboard-store.js';
import { normalizeConfig, createIssueInput, PRIORITIES } from '../../../lib/linear.js';
import { session, bindCtx, teamsList, teamById, ensureTeams, resolveTeamId, viewer, createIssue, feedFor, errorInfo } from './session.js';

const DIALOG = 'w.linear.create';
const draft = { widgetId: '', teamId: '', stateId: '', priority: '0', title: '', description: '', assignToMe: false, inCycle: false, cycleId: '', error: '', titleError: '', busy: false };
const quick = new Map(); // widget id -> { title, busy }

const defaultStateId = teamId => { const team = teamById(teamId); return team?.defaultStateId || team?.states.find(s => s.type === 'unstarted')?.id || team?.states[0]?.id || ''; };

/** Opens the dialog, prefilled from the widget it was opened from. */
export function openCreateIssue(ctx, { widgetId = '', title = '' } = {}) {
  const config = normalizeConfig(findWidget(widgetId)?.widget?.config);
  const feed = widgetId ? feedFor(config) : null;
  const teamId = resolveTeamId(config) || teamsList()[0]?.id || '';
  const cycle = config.view === 'cycle' ? feed?.value?.cycle : null;
  Object.assign(draft, {
    widgetId, teamId, stateId: defaultStateId(teamId), priority: '0', title, description: '',
    assignToMe: config.view === 'mine' || config.view === 'inbox', inCycle: !!cycle, cycleId: cycle?.id || '', error: '', titleError: '', busy: false,
  });
  ctx.openDialog(DIALOG, {});
  ensureTeams().then(() => {
    if (!draft.teamId) { draft.teamId = teamsList()[0]?.id || ''; draft.stateId = defaultStateId(draft.teamId); }
    else if (!draft.stateId) draft.stateId = defaultStateId(draft.teamId);
    ctx.render();
  });
}

function renderCreate(ctx) {
  bindCtx(ctx);
  const teams = teamsList();
  const team = teamById(draft.teamId);
  const states = team?.states || [];
  const body = html`
    ${field({ label: 'Title', id: 'linear-new-title', error: draft.titleError,
      control: input({ id: 'linear-new-title', name: 'title', value: draft.title, action: 'w.linear.create-field', placeholder: 'What needs to happen?', autofocus: true,
        invalid: !!draft.titleError, describedBy: draft.titleError ? 'linear-new-title-error' : undefined, attrs: { 'data-name': 'title', maxlength: '255' } }) })}
    ${field({ label: 'Description', id: 'linear-new-description', hint: 'Optional. Markdown works.',
      control: textarea({ id: 'linear-new-description', name: 'description', value: draft.description, rows: 4, action: 'w.linear.create-field', placeholder: 'Add details, links or acceptance criteria',
        describedBy: 'linear-new-description-hint', attrs: { 'data-name': 'description' } }) })}
    <div class="w-linear-create-grid">
      ${field({ label: 'Team', id: 'linear-new-team', control: select({ id: 'linear-new-team', name: 'teamId', value: draft.teamId, action: 'w.linear.create-select',
        options: teams.length ? teams.map(t => ({ value: t.id, label: `${t.name} (${t.key})` })) : [{ value: '', label: session.teamsError ? 'Teams unavailable' : 'Loading teams…' }], disabled: !teams.length }) })}
      ${field({ label: 'Status', id: 'linear-new-state', control: select({ id: 'linear-new-state', name: 'stateId', value: draft.stateId, action: 'w.linear.create-select',
        options: states.length ? states.filter(s => s.type !== 'canceled').map(s => ({ value: s.id, label: s.name })) : [{ value: '', label: 'Team default' }], disabled: !states.length }) })}
      ${field({ label: 'Priority', id: 'linear-new-priority', control: select({ id: 'linear-new-priority', name: 'priority', value: draft.priority, action: 'w.linear.create-select',
        options: PRIORITIES.map(p => ({ value: String(p.value), label: p.label })) }) })}
    </div>
    <div class="w-linear-create-checks">
      ${viewer() ? checkbox({ label: 'Assign to me', checked: draft.assignToMe, action: 'w.linear.create-check', data: { name: 'assignToMe' } }) : ''}
      ${draft.cycleId && team?.id === feedTeamId() ? checkbox({ label: 'Add to the current cycle', checked: draft.inCycle, action: 'w.linear.create-check', data: { name: 'inCycle' } }) : ''}
    </div>
    ${draft.error ? html`<p class="w-linear-create-error" role="alert">${draft.error}</p>` : ''}`;
  return html`<form class="dialog-form" data-submit="w.linear.create-submit" data-keydown="w.linear.create-key" novalidate>${dialogFrame({
    name: DIALOG, title: 'New Linear issue', subtitle: team ? `In ${team.name}` : '', body,
    footer: html`${button({ label: 'Cancel', variant: 'secondary', action: 'overlay.dismiss' })}${button({ label: 'Create issue', type: 'submit', variant: 'primary', loading: draft.busy, kbd: 'mod+enter' })}`,
  })}</form>`;
}

const feedTeamId = () => { const widget = findWidget(draft.widgetId)?.widget; return widget ? resolveTeamId(normalizeConfig(widget.config)) : ''; };

registerDialog(DIALOG, renderCreate, { size: 'md', className: 'w-linear-create-dialog' });

async function submitDialog(ctx) {
  if (draft.busy) return;
  draft.titleError = draft.title.trim() ? '' : 'Give the issue a title.';
  draft.error = !draft.teamId ? 'Choose a team for the new issue.' : '';
  if (draft.titleError || draft.error) {
    ctx.render();
    if (draft.titleError) ctx.nextFrame(() => document.getElementById('linear-new-title')?.focus());
    return;
  }
  draft.busy = true;
  ctx.render();
  try {
    const issue = await createIssue(createIssueInput({
      teamId: draft.teamId, title: draft.title, description: draft.description, priority: draft.priority, stateId: draft.stateId,
      assigneeId: draft.assignToMe ? viewer()?.id : '', cycleId: draft.inCycle && draft.teamId === feedTeamId() ? draft.cycleId : '',
    }), { widgetId: draft.widgetId });
    draft.busy = false;
    ctx.closeDialog(DIALOG);
    announceCreated(ctx, issue);
  } catch (error) {
    draft.busy = false;
    draft.error = errorInfo(error, 'Linear did not create the issue. Try again.').message;
    ctx.render();
  }
}

export function announceCreated(ctx, issue) {
  ctx.toast(`Created ${issue.identifier}`, { tone: 'success', action: issue.url ? { label: 'Open in Linear', run: () => openExternal(issue.url) } : null });
}

export function openExternal(url) {
  if (!/^https:\/\//.test(url || '')) return;
  if (globalThis.chrome?.tabs?.create) globalThis.chrome.tabs.create({ url });
  else globalThis.open?.(url, '_blank', 'noopener');
}

// ------------------------------------------------------------------------------------------------ quick create row

export const quickDraft = widgetId => quick.get(widgetId) || { title: '', busy: false };

export function renderQuickCreate(widget, team) {
  const q = quickDraft(widget.id);
  const id = `linear-quick-${widget.id}`;
  return html`<form class="w-linear-quick" data-submit="w.linear.quick-create" data-widget="${widget.id}" novalidate>
    <label class="sr-only" for="${id}">New issue title${team ? ` in ${team.name}` : ''}</label>
    ${icon('plus', { size: 14, className: 'w-linear-quick-icon' })}
    <input class="w-linear-quick-input" id="${id}" data-focus-key="${id}" name="title" value="${q.title}" autocomplete="off" spellcheck="false" maxlength="255"
      placeholder="${team ? `New issue in ${team.key}…` : 'New issue…'}" data-input="w.linear.quick-input" data-widget="${widget.id}" ${q.busy ? html`aria-busy="true"` : ''}>
    <button type="button" class="w-linear-quick-more" data-action="w.linear.quick-more" data-widget="${widget.id}" aria-label="Open the full new issue form" title="More options">${icon('maximize-2', { size: 14 })}</button>
  </form>`;
}

async function submitQuick(ctx, widgetId, form) {
  const widget = findWidget(widgetId)?.widget;
  if (!widget) return;
  const q = { ...quickDraft(widgetId) };
  q.title = String(new FormData(form).get('title') ?? q.title).trim();
  if (!q.title || q.busy) return;
  const config = normalizeConfig(widget.config);
  const teamId = resolveTeamId(config);
  if (!teamId) { openCreateIssue(ctx, { widgetId, title: q.title }); return; }
  quick.set(widgetId, { title: q.title, busy: true });
  ctx.render();
  try {
    const cycle = config.view === 'cycle' ? feedFor(config).value?.cycle : null;
    const issue = await createIssue(createIssueInput({ teamId, title: q.title, stateId: defaultStateId(teamId), assigneeId: config.view === 'mine' ? viewer()?.id : '', cycleId: cycle?.id || '' }), { widgetId });
    quick.delete(widgetId);
    announceCreated(ctx, issue);
    ctx.render();
    ctx.nextFrame(() => document.getElementById(`linear-quick-${widgetId}`)?.focus());
  } catch (error) {
    quick.set(widgetId, { title: q.title, busy: false });
    ctx.toast(errorInfo(error, 'Linear did not create the issue. Try again.').message, { tone: 'danger' });
    ctx.render();
  }
}

registerActions({
  'w.linear.new-issue': ({ ctx, data }) => openCreateIssue(ctx, { widgetId: data.widget || '' }),
  'w.linear.create-field': ({ el }) => {
    draft[el.dataset.name] = el.value;
    if (el.dataset.name === 'title' && draft.titleError && el.value.trim()) { draft.titleError = ''; }
  },
  'w.linear.create-select': ({ ctx, el }) => {
    draft[el.name] = el.value;
    if (el.name === 'teamId') draft.stateId = defaultStateId(el.value);
    ctx.render();
  },
  'w.linear.create-check': ({ ctx, el, data }) => { draft[data.name] = el.checked; ctx.render(); },
  'w.linear.create-submit': ({ ctx }) => submitDialog(ctx),
  // Mod+Enter creates from anywhere in the form, including the description.
  'w.linear.create-key': ({ ctx, event }) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    return submitDialog(ctx);
  },
  'w.linear.quick-input': ({ el, data }) => { quick.set(data.widget, { ...quickDraft(data.widget), title: el.value }); },
  'w.linear.quick-create': ({ ctx, el, data }) => submitQuick(ctx, data.widget, el),
  'w.linear.quick-more': ({ ctx, data }) => {
    const title = quickDraft(data.widget).title;
    quick.delete(data.widget);
    openCreateIssue(ctx, { widgetId: data.widget, title });
  },
});
