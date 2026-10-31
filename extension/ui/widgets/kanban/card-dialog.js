// Card dialog for the kanban widget: title, column, priority, due date, labels (toggle or create), description,
// checklist, a link to any library item (search picker), "Create note from card" and delete. Every field saves as it
// changes (text fields when they lose focus, and on close), so there is no separate Save step.
import { html, cx, plural } from '../../html.js';
import { icon } from '../../icons.js';
import { registerActions } from '../../runtime.js';
import { registerDialog } from '../../overlay.js';
import { button, iconButton, select, checkbox, field, dialogFrame, emptyState, siteIcon, colorVar, relativeDate, shortDate, domainOf, TYPE_ICONS, TYPE_LABELS } from '../../components.js';
import { searchRows } from '../../selectors.js';
import { createNote } from '../../notes.js';
import { openNote } from '../../note-editor.js';
import * as M from './model.js';
import { save, cardIn, ui, ids, announce, focusAfterRender } from './store.js';

const DIALOG = 'w.kanban.card';
const RESULTS = 6;
const fieldId = name => `wkd-${name}`;
const optionId = index => `wkd-link-opt-${index}`;
const entry = ctx => ctx.state.dialogs.findLast(d => d.name === DIALOG);

/** Label color choices for selects: [{ value, label }]. */
export const colorOptions = () => M.COLORS.map(value => ({ value, label: M.COLOR_LABELS[value] }));

/** Opens the dialog for a card. Typed title and description are kept in `draft` until they are saved. */
export function openCardDialog(ctx, widgetId, cardId) {
  if (!cardIn(widgetId, cardId)) { ctx.toast('That card is no longer on the board.', { tone: 'danger' }); return; }
  const draft = {};
  ctx.openDialog(DIALOG, {
    widgetId, cardId, draft, linkQuery: '', linkActive: 0, labelForm: null, titleError: '', busy: '',
    onClose: () => { flushDraft(ctx, widgetId, cardId, draft); },
  });
}

// Saves typed text that has not been committed yet (the dialog closed while a field still had focus).
function flushDraft(ctx, widgetId, cardId, draft) {
  const found = cardIn(widgetId, cardId);
  if (!found) return;
  const patch = {};
  if (typeof draft.title === 'string' && draft.title.trim() && draft.title.trim() !== found.card.title) patch.title = draft.title;
  if (typeof draft.description === 'string' && draft.description !== found.card.description) patch.description = draft.description;
  if (Object.keys(patch).length) ctx.run(() => save(ctx, widgetId, b => M.updateCard(b, cardId, patch)));
  ui.roving.set(widgetId, cardId);
}

/* ------------------------------------------------------------------ rendering */

function swatches(name, value, action) {
  return html`<div class="w-kanban-swatches" role="radiogroup" aria-label="Label color">
    ${M.COLORS.map(color => html`<button type="button" role="radio" class="w-kanban-swatch" style="--swatch:${colorVar(color)}" aria-checked="${color === value ? 'true' : 'false'}"
      tabindex="${color === value ? '0' : '-1'}" aria-label="${M.COLOR_LABELS[color]}" title="${M.COLOR_LABELS[color]}" data-action="${action}" data-value="${color}" data-name="${name}">
      ${color === value ? icon('check', { size: 12, strokeWidth: 3 }) : ''}</button>`)}
  </div>`;
}

function labelsSection(board, card, props) {
  const form = props.labelForm;
  return html`<section class="w-kanban-dlg-section" aria-labelledby="wkd-labels-h">
    <h3 class="w-kanban-dlg-heading" id="wkd-labels-h">${icon('tag', { size: 14 })}Labels</h3>
    <div class="w-kanban-dlg-labels" role="group" aria-labelledby="wkd-labels-h">
      ${board.labels.map(label => {
        const on = card.labels.includes(label.id);
        return html`<button type="button" class="${cx('w-kanban-dlg-label', on && 'is-on')}" style="--label:${colorVar(label.color)}" aria-pressed="${on ? 'true' : 'false'}"
          data-action="w.kanban.dlg-label" data-label="${label.id}">
          <span class="w-kanban-label-dot" aria-hidden="true"></span><span>${label.name}</span>${on ? icon('check', { size: 12, strokeWidth: 2.5, className: 'w-kanban-dlg-label-check' }) : ''}</button>`;
      })}
      ${form ? '' : button({ label: board.labels.length ? 'New label' : 'Create a label', icon: 'plus', size: 'sm', variant: 'ghost', action: 'w.kanban.dlg-label-new',
        disabled: board.labels.length >= M.LIMITS.labels, className: 'w-kanban-dlg-label-new' })}
    </div>
    ${form ? html`<form class="w-kanban-dlg-label-form" data-submit="w.kanban.dlg-label-create" autocomplete="off" novalidate>
      ${field({ label: 'Label name', id: fieldId('label-name'), error: form.error,
        control: html`<input class="input input-sm" id="${fieldId('label-name')}" name="name" value="${form.name}" maxlength="${M.LIMITS.label}" placeholder="Design, Waiting…"
          data-input="w.kanban.dlg-label-name" data-keydown="w.kanban.dlg-label-key" ${form.error ? html`aria-invalid="true" aria-describedby="${fieldId('label-name')}-error"` : ''} data-autofocus>` })}
      ${swatches('labelColor', form.color, 'w.kanban.dlg-label-color')}
      <div class="w-kanban-dlg-inline-actions">
        ${button({ label: 'Add label', type: 'submit', variant: 'secondary', size: 'sm' })}
        ${button({ label: 'Cancel', variant: 'ghost', size: 'sm', action: 'w.kanban.dlg-label-cancel' })}
      </div>
    </form>` : ''}
  </section>`;
}

function checklistSection(card) {
  const progress = M.checklistProgress(card);
  return html`<section class="w-kanban-dlg-section" aria-labelledby="wkd-check-h">
    <div class="w-kanban-dlg-heading-row">
      <h3 class="w-kanban-dlg-heading" id="wkd-check-h">${icon('list-checks', { size: 14 })}Checklist</h3>
      ${progress.total ? html`<span class="w-kanban-dlg-progress" role="progressbar" aria-label="Checklist progress" aria-valuemin="0" aria-valuemax="${progress.total}" aria-valuenow="${progress.done}"
        aria-valuetext="${progress.done} of ${progress.total} done"><span class="w-kanban-dlg-progress-track"><span class="w-kanban-dlg-progress-fill" style="inline-size:${Math.round(progress.done / progress.total * 100)}%"></span></span>
        <span class="w-kanban-dlg-progress-text" aria-hidden="true">${progress.done}/${progress.total}</span></span>` : ''}
    </div>
    ${card.checklist.length ? html`<ul class="w-kanban-dlg-checks" role="list">${card.checklist.map(item => html`<li class="${cx('w-kanban-dlg-check', item.done && 'is-done')}" data-key="${item.id}">
      ${checkbox({ checked: item.done, label: `Done: ${item.text}`, hideLabel: true, action: 'w.kanban.dlg-check', data: { item: item.id } })}
      <input class="w-kanban-dlg-check-text" id="wkd-ci-${item.id}" value="${item.text}" maxlength="${M.LIMITS.item}" aria-label="Checklist item" autocomplete="off"
        data-change="w.kanban.dlg-check-text" data-keydown="w.kanban.dlg-check-key" data-item="${item.id}">
      ${iconButton({ icon: 'x', label: `Remove “${item.text}”`, size: 'sm', action: 'w.kanban.dlg-check-remove', data: { item: item.id }, className: 'w-kanban-dlg-check-remove' })}
    </li>`)}</ul>` : ''}
    ${card.checklist.length < M.LIMITS.checklist ? html`<form class="w-kanban-dlg-check-add" data-submit="w.kanban.dlg-check-add" autocomplete="off">
      ${icon('plus', { size: 14, className: 'w-kanban-dlg-check-add-icon' })}
      <label class="sr-only" for="${fieldId('check-new')}">Add a checklist item</label>
      <input class="w-kanban-dlg-check-new" id="${fieldId('check-new')}" name="text" maxlength="${M.LIMITS.item}" placeholder="${card.checklist.length ? 'Add an item' : 'Add the first item'}" enterkeyhint="enter">
    </form>` : ''}
  </section>`;
}

function itemRow(item, { meta, actions }) {
  const art = item.url && item.type !== 'note' ? siteIcon(item.url, { size: 20 }) : html`<span class="w-kanban-dlg-item-tile" aria-hidden="true">${icon(TYPE_ICONS[item.type] || 'file', { size: 14 })}</span>`;
  return html`${art}<span class="w-kanban-dlg-item-text"><span class="w-kanban-dlg-item-title">${item.title || item.url || 'Untitled'}</span><span class="w-kanban-dlg-item-meta">${meta}</span></span>${actions || ''}`;
}
const itemMeta = (ctx, item) => [TYPE_LABELS[item.type] || 'Item', item.type !== 'note' && domainOf(item.url), item.collectionId ? ctx.select.collection(item.collectionId)?.name : 'Inbox'].filter(Boolean).join(' · ');

function linkResults(ctx, query) {
  const text = String(query || '').trim();
  if (!text) return [];
  const collections = new Map(ctx.select.tree().map(c => [c.id, c]));
  return searchRows(ctx.select.live(), text, collections)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, RESULTS);
}

function linkSection(ctx, card, props) {
  const item = card.itemId ? ctx.select.byId(card.itemId) : null;
  let body;
  if (card.itemId && item && !item.deletedAt) {
    body = html`<div class="w-kanban-dlg-item">${itemRow(item, { meta: itemMeta(ctx, item), actions: html`<span class="w-kanban-dlg-item-actions">
      ${button({ label: 'Open', icon: 'arrow-up-right', size: 'sm', action: 'w.kanban.dlg-link-open' })}
      ${iconButton({ icon: 'unlink', label: 'Remove the link', size: 'sm', action: 'w.kanban.dlg-unlink' })}</span>` })}</div>`;
  } else if (card.itemId) {
    body = html`<div class="w-kanban-dlg-item is-missing"><span class="w-kanban-dlg-item-tile" aria-hidden="true">${icon('unlink', { size: 14 })}</span>
      <span class="w-kanban-dlg-item-text"><span class="w-kanban-dlg-item-title">The linked item is no longer in your library</span><span class="w-kanban-dlg-item-meta">It may have been deleted. Remove the link or choose another item.</span></span>
      ${button({ label: 'Remove link', size: 'sm', action: 'w.kanban.dlg-unlink' })}</div>`;
  } else {
    const results = linkResults(ctx, props.linkQuery);
    const active = Math.min(props.linkActive || 0, Math.max(0, results.length - 1));
    const open = !!String(props.linkQuery || '').trim();
    body = html`<div class="w-kanban-dlg-link">
      <span class="w-kanban-dlg-link-search">${icon('search', { size: 14, className: 'w-kanban-dlg-link-icon' })}
        <input class="input input-sm" id="${fieldId('link')}" type="text" role="combobox" aria-autocomplete="list" aria-expanded="${open ? 'true' : 'false'}" aria-controls="wkd-link-list"
          ${open && results.length ? html`aria-activedescendant="${optionId(active)}"` : ''} aria-label="Search your library for an item to link" placeholder="Search your library"
          value="${props.linkQuery}" data-input="w.kanban.dlg-link-query" data-keydown="w.kanban.dlg-link-key" autocomplete="off" spellcheck="false"></span>
      <ul class="w-kanban-dlg-results" id="wkd-link-list" role="listbox" aria-label="Library items" ${open ? '' : html`hidden`}>
        ${results.map((result, index) => html`<li class="${cx('w-kanban-dlg-result', index === active && 'is-active')}" role="option" id="${optionId(index)}"
          aria-selected="${index === active ? 'true' : 'false'}" data-action="w.kanban.dlg-link" data-item="${result.id}">${itemRow(result, { meta: itemMeta(ctx, result) })}</li>`)}
      </ul>
      ${open && !results.length ? html`<p class="w-kanban-dlg-hint" role="status">Nothing in your library matches “${props.linkQuery.trim()}”.</p>`
        : open ? '' : html`<p class="w-kanban-dlg-hint">Link a note, page or file this card is about. Or create a note from the card below.</p>`}
    </div>`;
  }
  return html`<section class="w-kanban-dlg-section" aria-labelledby="wkd-link-h">
    <h3 class="w-kanban-dlg-heading" id="wkd-link-h">${icon('link-2', { size: 14 })}Linked item</h3>${body}
  </section>`;
}

function renderDialog(ctx, props) {
  const found = cardIn(props.widgetId, props.cardId);
  if (!found) {
    return dialogFrame({ name: DIALOG, title: 'Card removed',
      body: emptyState({ icon: 'square-kanban', compact: true, title: 'This card is no longer on the board', body: 'It was deleted, or its board was removed from the dashboard.' }),
      footer: button({ label: 'Close', action: 'overlay.dismiss' }) });
  }
  const { board, card } = found;
  const column = M.findColumn(board, card.columnId);
  const title = typeof props.draft.title === 'string' ? props.draft.title : card.title;
  const description = typeof props.draft.description === 'string' ? props.draft.description : card.description;
  const due = M.dueInfo(card.due);
  const body = html`<div class="w-kanban-dlg" data-keydown="w.kanban.dlg-key">
    ${field({ label: 'Title', id: fieldId('title'), error: props.titleError,
      control: html`<textarea class="textarea w-kanban-dlg-title" id="${fieldId('title')}" rows="2" maxlength="${M.LIMITS.title}" data-input="w.kanban.dlg-draft" data-name="title"
        data-change="w.kanban.dlg-commit" data-keydown="w.kanban.dlg-title-key" spellcheck="true" ${props.titleError ? html`aria-invalid="true" aria-describedby="${fieldId('title')}-error"` : ''}>${title}</textarea>` })}
    <div class="w-kanban-dlg-grid">
      ${field({ label: 'Column', id: fieldId('column'), control: select({ id: fieldId('column'), value: card.columnId, action: 'w.kanban.dlg-column', className: 'is-block',
        options: board.columns.map(c => ({ value: c.id, label: c.title })) }) })}
      ${field({ label: 'Priority', id: fieldId('priority'), control: select({ id: fieldId('priority'), value: card.priority, action: 'w.kanban.dlg-priority', className: 'is-block',
        options: M.PRIORITIES.map(p => ({ value: p.value, label: p.label })) }) })}
      ${field({ label: 'Due date', id: fieldId('due'), hint: card.due && !column?.done && due.state === 'overdue' ? `Overdue by ${plural(-due.days, 'day')}` : '',
        className: cx('w-kanban-dlg-due', due.state === 'overdue' && !column?.done && 'is-overdue'),
        control: html`<span class="w-kanban-dlg-date"><input class="input" type="date" id="${fieldId('due')}" value="${card.due}" data-change="w.kanban.dlg-due"
          ${card.due && due.state === 'overdue' && !column?.done ? html`aria-describedby="${fieldId('due')}-hint"` : ''}>
          ${card.due ? iconButton({ icon: 'x', label: 'Clear the due date', size: 'sm', action: 'w.kanban.dlg-due-clear', className: 'w-kanban-dlg-date-clear' }) : ''}</span>` })}
    </div>
    ${labelsSection(board, card, props)}
    <section class="w-kanban-dlg-section" aria-labelledby="${fieldId('description')}-label">
      <label class="w-kanban-dlg-heading" id="${fieldId('description')}-label" for="${fieldId('description')}">${icon('text', { size: 14 })}Description</label>
      <textarea class="textarea w-kanban-dlg-desc" id="${fieldId('description')}" rows="4" maxlength="${M.LIMITS.description}" placeholder="Add notes, links or next steps. Markdown works."
        data-input="w.kanban.dlg-draft" data-name="description" data-change="w.kanban.dlg-commit" spellcheck="true">${description}</textarea>
    </section>
    ${checklistSection(card)}
    ${linkSection(ctx, card, props)}
    <p class="w-kanban-dlg-stamp">Created ${shortDate(card.createdAt)}${card.updatedAt !== card.createdAt ? html` · Updated ${relativeDate(card.updatedAt).replace(/^Just now$/, 'just now')}` : ''}</p>
  </div>`;
  const footer = html`${button({ label: 'Delete card', icon: 'trash-2', variant: 'ghost', action: 'w.kanban.dlg-delete', className: 'w-kanban-dlg-delete' })}
    <span class="spacer"></span>
    ${card.itemId ? '' : button({ label: 'Create note from card', icon: 'notebook-pen', action: 'w.kanban.dlg-note', loading: props.busy === 'note' })}
    ${button({ label: 'Done', variant: 'primary', action: 'overlay.dismiss', kbd: 'mod+enter' })}`;
  return dialogFrame({ name: DIALOG, title: 'Edit card', subtitle: column ? `In ${column.title}` : '', body, footer });
}

registerDialog(DIALOG, renderDialog, { size: 'md', className: 'w-kanban-dialog' });

/* ------------------------------------------------------------------ actions */

const current = ctx => {
  const top = entry(ctx);
  return top ? { props: top.props, found: cardIn(top.props.widgetId, top.props.cardId) } : null;
};
const update = (ctx, fn, options) => {
  const open = entry(ctx);
  if (!open) return null;
  return ctx.run(() => save(ctx, open.props.widgetId, board => fn(board, open.props.cardId), options));
};

function commitTitle(ctx) {
  const open = current(ctx);
  if (!open?.found) return null;
  const value = open.props.draft.title;
  if (typeof value !== 'string') return null;
  if (!value.trim()) {
    ctx.updateDialog(DIALOG, { titleError: 'Give the card a title.' });
    return null;
  }
  delete open.props.draft.title;
  if (open.props.titleError) ctx.updateDialog(DIALOG, { titleError: '' });
  return update(ctx, (board, cardId) => M.updateCard(board, cardId, { title: value }));
}

function commitDescription(ctx) {
  const open = current(ctx);
  if (!open?.found || typeof open.props.draft.description !== 'string') return null;
  const value = open.props.draft.description;
  delete open.props.draft.description;
  return update(ctx, (board, cardId) => M.updateCard(board, cardId, { description: value }));
}

async function linkItem(ctx, itemId) {
  const item = ctx.select.byId(itemId);
  if (!item) return;
  ctx.updateDialog(DIALOG, { linkQuery: '', linkActive: 0 });
  await update(ctx, (board, cardId) => M.updateCard(board, cardId, { itemId }));
  ctx.nextFrame(() => document.querySelector('.w-kanban-dialog .w-kanban-dlg-item-actions .btn')?.focus());
}

async function createNoteFromCard(ctx) {
  const open = current(ctx);
  if (!open?.found || open.props.busy) return;
  // Text still being typed belongs in the note too.
  await Promise.all([commitTitle(ctx), commitDescription(ctx)]);
  const found = cardIn(open.props.widgetId, open.props.cardId);
  if (!found) return;
  const { board, card } = found;
  ctx.updateDialog(DIALOG, { busy: 'note' });
  try {
    const note = await createNote(ctx, { title: card.title, content: M.cardToMarkdown(card, board), open: false });
    await save(ctx, open.props.widgetId, b => M.updateCard(b, card.id, { itemId: note.id }));
    ctx.toast(`Created the note “${card.title}”`, { tone: 'success', action: { label: 'Open note', run: () => { ctx.closeDialog(DIALOG); openNote(ctx, note.id); } } });
  } finally {
    if (entry(ctx)) ctx.updateDialog(DIALOG, { busy: '' });
  }
}

registerActions({
  'w.kanban.dlg-draft': ({ ctx, el }) => {
    const open = entry(ctx);
    if (!open) return;
    open.props.draft[el.dataset.name] = el.value;
    if (el.dataset.name === 'title' && open.props.titleError && el.value.trim()) ctx.updateDialog(DIALOG, { titleError: '' });
  },
  'w.kanban.dlg-commit': ({ ctx, el }) => (el.dataset.name === 'title' ? commitTitle(ctx) : commitDescription(ctx)),
  'w.kanban.dlg-title-key': ({ ctx, event }) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.metaKey || event.ctrlKey) return undefined;
    event.preventDefault(); // titles are one paragraph; Enter saves
    return commitTitle(ctx);
  },
  // Mod+Enter saves and closes from any field.
  'w.kanban.dlg-key': ({ ctx, event }) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.isComposing) return;
    event.preventDefault();
    ctx.closeDialog(DIALOG);
  },
  'w.kanban.dlg-column': async ({ ctx, el }) => {
    const open = current(ctx);
    if (!open?.found) return;
    const next = await update(ctx, (board, cardId) => M.moveCard(board, cardId, el.value, null));
    if (next) announce(ctx, open.props.widgetId, `Moved “${open.found.card.title}” to ${M.findColumn(next, el.value)?.title}.`);
  },
  'w.kanban.dlg-priority': ({ ctx, el }) => update(ctx, (board, cardId) => M.updateCard(board, cardId, { priority: el.value })),
  'w.kanban.dlg-due': ({ ctx, el }) => update(ctx, (board, cardId) => M.updateCard(board, cardId, { due: el.value })),
  'w.kanban.dlg-due-clear': async ({ ctx }) => {
    await update(ctx, (board, cardId) => M.updateCard(board, cardId, { due: '' }));
    focusAfterRender(ctx, fieldId('due'));
  },
  'w.kanban.dlg-label': ({ ctx, data }) => update(ctx, (board, cardId) => M.toggleLabel(board, cardId, data.label)),
  'w.kanban.dlg-label-new': ({ ctx }) => {
    const open = current(ctx);
    if (!open?.found) return;
    const used = new Set(open.found.board.labels.map(l => l.color));
    ctx.updateDialog(DIALOG, { labelForm: { name: '', color: M.COLORS.find(c => !used.has(c) && c !== 'gray') || 'blue', error: '' } });
    focusAfterRender(ctx, fieldId('label-name'));
  },
  'w.kanban.dlg-label-name': ({ ctx, el }) => {
    const open = entry(ctx);
    if (!open?.props.labelForm) return;
    const hadError = !!open.props.labelForm.error;
    open.props.labelForm = { ...open.props.labelForm, name: el.value, error: hadError && el.value.trim() ? '' : open.props.labelForm.error };
    if (hadError && el.value.trim()) ctx.render();
  },
  'w.kanban.dlg-label-color': ({ ctx, data }) => {
    const open = entry(ctx);
    if (open?.props.labelForm) ctx.updateDialog(DIALOG, { labelForm: { ...open.props.labelForm, color: data.value } });
  },
  'w.kanban.dlg-label-cancel': ({ ctx }) => {
    ctx.updateDialog(DIALOG, { labelForm: null });
    ctx.nextFrame(() => document.querySelector('.w-kanban-dialog .w-kanban-dlg-label-new')?.focus());
  },
  'w.kanban.dlg-label-key': ({ ctx, event }) => {
    if (event.key !== 'Escape') return;
    // Escape closes the small label form first, not the whole dialog.
    event.preventDefault();
    event.stopPropagation();
    ctx.updateDialog(DIALOG, { labelForm: null });
    ctx.nextFrame(() => document.querySelector('.w-kanban-dialog .w-kanban-dlg-label-new')?.focus());
  },
  'w.kanban.dlg-label-create': async ({ ctx, el }) => {
    const open = current(ctx);
    if (!open?.found || !open.props.labelForm) return;
    const name = String(new FormData(el).get('name') || '').replace(/\s+/g, ' ').trim();
    if (!name) {
      ctx.updateDialog(DIALOG, { labelForm: { ...open.props.labelForm, name: '', error: 'Give the label a name.' } });
      focusAfterRender(ctx, fieldId('label-name'));
      return;
    }
    const existing = M.labelByName(open.found.board, name);
    const id = existing?.id || M.uid('lbl');
    await update(ctx, (board, cardId) => {
      const withLabel = existing ? board : M.createLabel(board, { id, name, color: open.props.labelForm.color });
      const card = M.findCard(withLabel, cardId);
      return card && !card.labels.includes(id) ? M.toggleLabel(withLabel, cardId, id) : withLabel;
    });
    ctx.updateDialog(DIALOG, { labelForm: null });
    ctx.nextFrame(() => document.querySelector(`.w-kanban-dialog .w-kanban-dlg-label[data-label="${CSS.escape(id)}"]`)?.focus());
  },
  'w.kanban.dlg-check': ({ ctx, el, data }) => update(ctx, (board, cardId) => M.toggleChecklist(board, cardId, data.item, el.checked)),
  'w.kanban.dlg-check-text': async ({ ctx, el, data }) => {
    const removing = !el.value.trim();
    await update(ctx, (board, cardId) => M.updateChecklistItem(board, cardId, data.item, el.value));
    if (removing) focusAfterRender(ctx, fieldId('check-new'));
  },
  'w.kanban.dlg-check-key': ({ event }) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    // Enter commits the item and moves on to the next one (or the add field).
    const row = event.target.closest('li');
    const next = row?.nextElementSibling?.querySelector('.w-kanban-dlg-check-text') || document.getElementById(fieldId('check-new'));
    next?.focus();
  },
  'w.kanban.dlg-check-remove': async ({ ctx, el, data }) => {
    const row = el.closest('li');
    const neighbour = (row?.nextElementSibling || row?.previousElementSibling)?.querySelector('.w-kanban-dlg-check-text')?.id;
    await update(ctx, (board, cardId) => M.removeChecklistItem(board, cardId, data.item));
    focusAfterRender(ctx, neighbour || fieldId('check-new'));
  },
  'w.kanban.dlg-check-add': async ({ ctx, el }) => {
    const input = el.querySelector('[name="text"]');
    const value = input?.value.trim();
    if (!value) return;
    input.value = '';
    const next = await update(ctx, (board, cardId) => M.addChecklistItem(board, cardId, value));
    if (!next && input && !input.value) input.value = value;
    focusAfterRender(ctx, fieldId('check-new'));
  },
  'w.kanban.dlg-link-query': ({ ctx, el }) => ctx.updateDialog(DIALOG, { linkQuery: el.value, linkActive: 0 }),
  'w.kanban.dlg-link-key': ({ ctx, event }) => {
    const open = entry(ctx);
    if (!open || event.isComposing) return undefined;
    const results = linkResults(ctx, open.props.linkQuery);
    if (!results.length) return undefined;
    const moves = { ArrowDown: 1, ArrowUp: -1 };
    if (event.key in moves) {
      event.preventDefault();
      const active = (Math.min(open.props.linkActive || 0, results.length - 1) + moves[event.key] + results.length) % results.length;
      ctx.updateDialog(DIALOG, { linkActive: active });
      ctx.nextFrame(() => document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' }));
      return undefined;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      return linkItem(ctx, results[Math.min(open.props.linkActive || 0, results.length - 1)].id);
    }
    return undefined;
  },
  'w.kanban.dlg-link': ({ ctx, data }) => linkItem(ctx, data.item),
  'w.kanban.dlg-unlink': async ({ ctx }) => {
    await update(ctx, (board, cardId) => M.updateCard(board, cardId, { itemId: '' }));
    focusAfterRender(ctx, fieldId('link'));
  },
  'w.kanban.dlg-link-open': ({ ctx }) => {
    const open = current(ctx);
    const id = open?.found?.card.itemId;
    if (!id) return;
    ctx.closeDialog(DIALOG);
    ctx.openItem(id);
  },
  'w.kanban.dlg-note': ({ ctx }) => createNoteFromCard(ctx),
  'w.kanban.dlg-delete': async ({ ctx }) => {
    const open = current(ctx);
    if (!open?.found) return;
    const { widgetId, cardId } = open.props;
    const { board, card } = open.found;
    const beforeId = M.nextInColumn(board, cardId);
    open.props.draft = {}; // nothing to flush for a deleted card
    open.props.onClose = null;
    ctx.closeDialog(DIALOG);
    await save(ctx, widgetId, b => M.deleteCard(b, cardId));
    focusAfterRender(ctx, ids.addCard(widgetId, card.columnId));
    ctx.toast(`Deleted “${card.title}”`, { action: { label: 'Undo', run: () => save(ctx, widgetId, b => M.insertCard(b, card, { beforeId })) } });
  },
});
