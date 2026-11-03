// "New Paperclip task" and "Send to Paperclip" dialog. From the widget it starts empty; from a saved item (library and
// detail menus) it is prefilled with lib/paperclip.js itemToIssue(), and the create request carries the item's
// idempotency key, so sending the same item twice returns the same task instead of a duplicate.
import { html } from '../../html.js';
import { icon } from '../../icons.js';
import { button, input, textarea, select, field, checkbox, dialogFrame } from '../../components.js';
import { registerActions } from '../../runtime.js';
import { registerDialog } from '../../overlay.js';
import { ISSUE_PRIORITIES, itemToIssue, issueUrl, PaperclipError } from '../../../lib/paperclip.js';
import { session, bindCtx, ensureAccount, connected, company, baseUrl, client, errorInfo, lists, ensureLists, refreshMounted } from './session.js';
import { openConnect } from './account.js';

const DIALOG = 'w.paperclip.create';
const blank = () => ({ itemId: '', title: '', description: '', projectId: '', assigneeAgentId: '', priority: 'medium', status: 'todo', tagItem: true, idempotencyKey: '', error: '', titleError: '', busy: false });
const draft = blank();

// Read the saved account early so the item menus know whether to offer "Send to Paperclip…".
if (globalThis.chrome?.storage?.local || globalThis.localStorage) ensureAccount()?.catch?.(() => {});

/** Opens a Paperclip page in a new tab (http is fine: Paperclip usually runs on localhost). */
export function openExternal(url) {
  if (!/^https?:\/\//.test(url || '')) return;
  if (globalThis.chrome?.tabs?.create) globalThis.chrome.tabs.create({ url });
  else globalThis.open?.(url, '_blank', 'noopener');
}

/** Opens the dialog. item: a saved Still item to send (prefills title and description). */
export function openCreateTask(ctx, { item = null, projectId = '' } = {}) {
  bindCtx(ctx);
  if (!connected()) { openConnect(ctx); return; }
  const prefill = item ? itemToIssue(item) : { title: '', description: '', idempotencyKey: '' };
  Object.assign(draft, blank(), { itemId: item?.id || '', title: prefill.title, description: prefill.description, idempotencyKey: prefill.idempotencyKey, projectId });
  ctx.openDialog(DIALOG, {});
  ensureLists().then(() => ctx.render());
}

/** Menu entry for the library and detail menus, or null when Paperclip is not connected. */
export function paperclipMenuItem(ctx, item) {
  if (!item || item.deletedAt) return null;
  ensureAccount();
  if (!connected()) return null;
  return { label: 'Send to Paperclip…', icon: 'paperclip', run: () => openCreateTask(ctx, { item }) };
}

function renderCreate(ctx) {
  bindCtx(ctx);
  const { projects, agents } = lists();
  const fromItem = !!draft.itemId;
  const body = html`
    ${field({ label: 'Title', id: 'paperclip-new-title', error: draft.titleError,
      control: input({ id: 'paperclip-new-title', name: 'title', value: draft.title, action: 'w.paperclip.create-field', placeholder: 'What should the company do?', autofocus: true,
        invalid: !!draft.titleError, describedBy: draft.titleError ? 'paperclip-new-title-error' : undefined, attrs: { 'data-name': 'title', maxlength: '500' } }) })}
    ${field({ label: 'Description', id: 'paperclip-new-description', hint: fromItem ? 'Prefilled from the saved item. Edit anything before sending.' : 'Optional. Markdown works.',
      control: textarea({ id: 'paperclip-new-description', name: 'description', value: draft.description, rows: fromItem ? 8 : 4, action: 'w.paperclip.create-field',
        placeholder: 'Context, links and what done looks like', describedBy: 'paperclip-new-description-hint', attrs: { 'data-name': 'description' } }) })}
    <div class="w-paperclip-create-grid">
      ${field({ label: 'Project', id: 'paperclip-new-project', control: select({ id: 'paperclip-new-project', name: 'projectId', value: draft.projectId, action: 'w.paperclip.create-select',
        options: [{ value: '', label: 'No project' }, ...projects.map(p => ({ value: p.id, label: p.name || p.id }))] }) })}
      ${field({ label: 'Priority', id: 'paperclip-new-priority', control: select({ id: 'paperclip-new-priority', name: 'priority', value: draft.priority, action: 'w.paperclip.create-select',
        options: ISSUE_PRIORITIES.map(p => ({ value: p.value, label: p.label })) }) })}
      ${field({ label: 'Status', id: 'paperclip-new-status', control: select({ id: 'paperclip-new-status', name: 'status', value: draft.status, action: 'w.paperclip.create-select',
        options: [{ value: 'todo', label: 'Todo' }, { value: 'backlog', label: 'Backlog' }] }) })}
      ${field({ label: 'Assign to agent', id: 'paperclip-new-agent', hint: draft.assigneeAgentId ? 'Assigning an agent may start work right away and spend its budget.' : 'Optional. Leave unassigned to triage it in Paperclip.',
        control: select({ id: 'paperclip-new-agent', name: 'assigneeAgentId', value: draft.assigneeAgentId, action: 'w.paperclip.create-select', describedBy: 'paperclip-new-agent-hint',
          options: [{ value: '', label: 'Nobody yet' }, ...agents.map(a => ({ value: a.id, label: a.title ? `${a.name} (${a.title})` : a.name || a.id }))] }) })}
    </div>
    ${fromItem ? html`<div class="w-paperclip-create-checks">${checkbox({ label: 'Tag this item “paperclip”', checked: draft.tagItem, action: 'w.paperclip.create-check', data: { name: 'tagItem' } })}</div>` : ''}
    ${draft.error ? html`<p class="w-paperclip-create-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${draft.error}</span></p>` : ''}`;
  return html`<form class="dialog-form" data-submit="w.paperclip.create-submit" data-keydown="w.paperclip.create-key" novalidate>${dialogFrame({
    name: DIALOG, title: fromItem ? 'Send to Paperclip' : 'New Paperclip task', subtitle: company().name ? `In ${company().name}` : '', body,
    footer: html`${button({ label: 'Cancel', variant: 'secondary', action: 'overlay.dismiss' })}${button({ label: 'Create task', type: 'submit', variant: 'primary', loading: draft.busy, kbd: 'mod+enter' })}`,
  })}</form>`;
}

registerDialog(DIALOG, renderCreate, { size: 'md', className: 'w-paperclip-create-dialog' });

async function tagItem(ctx, itemId) {
  const item = ctx.select?.byId?.(itemId);
  if (!item || !ctx.store?.updateItem || (item.tags || []).includes('paperclip')) return;
  try { await ctx.store.updateItem(itemId, { tags: [...(item.tags || []), 'paperclip'] }); } catch (error) { console.warn('[still] could not tag the item', error?.name || 'Error'); }
}

async function submit(ctx) {
  if (draft.busy) return;
  draft.titleError = draft.title.trim() ? '' : 'Give the task a title.';
  if (draft.titleError) { ctx.render(); ctx.nextFrame(() => document.getElementById('paperclip-new-title')?.focus()); return; }
  draft.busy = true;
  draft.error = '';
  ctx.render();
  try {
    if (!connected()) throw new PaperclipError('Connect Paperclip first.', { kind: 'auth' });
    const issue = await (await client()).createIssue(company().id, {
      title: draft.title, description: draft.description, status: draft.status, priority: draft.priority,
      assigneeAgentId: draft.assigneeAgentId, projectId: draft.projectId, idempotencyKey: draft.idempotencyKey,
    });
    const itemId = draft.itemId;
    const tag = draft.tagItem;
    draft.busy = false;
    ctx.closeDialog(DIALOG);
    if (itemId && tag) await tagItem(ctx, itemId);
    announceCreated(ctx, issue);
    refreshMounted();
  } catch (error) {
    draft.busy = false;
    if (error?.kind === 'auth') session.authFailed = true;
    draft.error = errorInfo(error, 'Paperclip did not create the task. Try again.').message;
    ctx.render();
  }
}

export function announceCreated(ctx, issue) {
  const url = issueUrl(baseUrl(), issue, company().prefix);
  const name = issue?.identifier || 'the task';
  ctx.toast(`Created ${name} in Paperclip`, { tone: 'success', action: url ? { label: `Open ${name}`, run: () => openExternal(url) } : null });
}

registerActions({
  'w.paperclip.new-task': ({ ctx }) => openCreateTask(ctx),
  'w.paperclip.create-field': ({ el }) => {
    draft[el.dataset.name] = el.value;
    if (el.dataset.name === 'title' && draft.titleError && el.value.trim()) draft.titleError = '';
  },
  'w.paperclip.create-select': ({ ctx, el }) => { draft[el.name] = el.value; ctx.render(); },
  'w.paperclip.create-check': ({ ctx, el, data }) => { draft[data.name] = el.checked; ctx.render(); },
  'w.paperclip.create-submit': ({ ctx }) => submit(ctx),
  'w.paperclip.create-key': ({ ctx, event }) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return undefined;
    event.preventDefault();
    return submit(ctx);
  },
});

