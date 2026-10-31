// Note picker popover for the Notes and Checklist widgets: a search field driving a listbox of notes (combobox
// pattern: focus stays in the field, arrows move the active option, Enter picks), plus an optional "create" row.
import { html, cx } from '../../html.js';
import { icon } from '../../icons.js';
import { registerActions } from '../../runtime.js';
import { registerPopover } from '../../overlay.js';
import { shortAgo } from '../../notes.js';
import { pickerNotes } from './model.js';
import { noteLabel, noteTile, noteProgress, collectionName } from './shared.js';

const LIST_ID = 'w-note-picker-list';
const optionId = i => `w-note-picker-opt-${i}`;

/**
 * Opens the picker under `anchor`. options: { label, preferTasks, selectedId, onPick(note), create: { label, run() } }.
 * onPick and create.run may be async; errors surface as toasts.
 */
export function openNotePicker(ctx, anchor, options = {}) {
  ctx.openPopover('w.note-picker', anchor, { query: '', active: 0, ...options }, { placement: 'bottom-start' });
}

function results(ctx, props) {
  const notes = pickerNotes(ctx.select.live(), { query: props.query, preferTasks: props.preferTasks });
  const rows = notes.map(note => ({ kind: 'note', note }));
  if (props.create) rows.push({ kind: 'create' });
  return rows;
}

registerPopover('w.note-picker', (ctx, props) => {
  const rows = results(ctx, props);
  const active = Math.min(Math.max(0, props.active || 0), Math.max(0, rows.length - 1));
  const noteRows = rows.filter(row => row.kind === 'note');
  return html`<div class="w-note-picker-box" role="presentation">
    <div class="w-note-picker-search">${icon('search', { size: 16, className: 'w-note-picker-search-icon' })}
      <input class="input input-sm has-icon" type="text" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="${LIST_ID}"
        ${rows.length ? html`aria-activedescendant="${optionId(active)}"` : ''} aria-label="${props.label || 'Search notes'}" placeholder="Search notes"
        value="${props.query}" data-input="w.note-picker.query" data-keydown="w.note-picker.key" data-autofocus autocomplete="off" spellcheck="false">
    </div>
    <div class="w-note-picker-list" id="${LIST_ID}" role="listbox" aria-label="Notes">
      ${noteRows.length ? '' : html`<p class="w-note-picker-empty">${props.query ? 'No notes match your search.' : 'Your notes will show up here.'}</p>`}
      ${rows.map((row, i) => row.kind === 'note' ? pickerOption(ctx, row.note, i, i === active, props.selectedId === row.note.id) : html`
        <button type="button" class="${cx('w-note-picker-option', 'is-create', i === active && 'is-active')}" role="option" id="${optionId(i)}"
          aria-selected="${i === active ? 'true' : 'false'}" tabindex="-1" data-action="w.note-picker.pick" data-index="${i}">
          <span class="w-note-picker-create-icon" aria-hidden="true">${icon('plus', { size: 14 })}</span>
          <span class="w-note-picker-title">${props.create.label}</span>
        </button>`)}
    </div>
  </div>`;
}, { role: 'dialog', className: 'w-note-picker' });

function pickerOption(ctx, note, i, active, current) {
  const progress = noteProgress(note);
  const meta = [collectionName(ctx, note.collectionId || ''), shortAgo(note.updatedAt)].filter(Boolean).join(' · ');
  return html`<button type="button" class="${cx('w-note-picker-option', active && 'is-active')}" role="option" id="${optionId(i)}"
    aria-selected="${active ? 'true' : 'false'}" tabindex="-1" data-action="w.note-picker.pick" data-index="${i}">
    ${noteTile(ctx, note, 20)}
    <span class="w-note-picker-text"><span class="w-note-picker-title">${noteLabel(note)}</span><span class="w-note-picker-meta">${meta}</span></span>
    ${progress.total ? html`<span class="w-note-picker-count" title="${progress.done} of ${progress.total} tasks done">${progress.done}/${progress.total}</span>` : ''}
    ${current ? html`<span class="w-note-picker-current">${icon('check', { size: 14, label: 'Current note' })}</span>` : ''}
  </button>`;
}

async function choose(ctx, index) {
  const pop = ctx.state.popover;
  if (pop?.name !== 'w.note-picker') return;
  const props = pop.props;
  const row = results(ctx, props)[index];
  if (!row) return;
  ctx.closePopover({ restore: row.kind !== 'note' });
  if (row.kind === 'create') await props.create.run();
  else await props.onPick?.(row.note);
}

registerActions({
  'w.note-picker.query': ({ ctx, el }) => {
    const pop = ctx.state.popover;
    if (pop?.name !== 'w.note-picker') return;
    pop.props.query = el.value;
    pop.props.active = 0;
    ctx.render();
  },
  'w.note-picker.key': ({ ctx, event }) => {
    const pop = ctx.state.popover;
    if (pop?.name !== 'w.note-picker' || event.isComposing) return undefined;
    const count = results(ctx, pop.props).length;
    const moves = { ArrowDown: 1, ArrowUp: -1 };
    if (event.key in moves && count) {
      event.preventDefault();
      pop.props.active = (Math.min(pop.props.active || 0, count - 1) + moves[event.key] + count) % count;
      ctx.render();
      ctx.nextFrame(() => document.getElementById(optionId(pop.props.active))?.scrollIntoView({ block: 'nearest' }));
      return undefined;
    }
    if (event.key === 'Enter' && count) { event.preventDefault(); return choose(ctx, Math.min(pop.props.active || 0, count - 1)); }
    return undefined;
  },
  'w.note-picker.pick': ({ ctx, data }) => choose(ctx, Number(data.index)),
});
