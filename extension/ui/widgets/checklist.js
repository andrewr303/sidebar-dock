// Checklist widget: the tasks of one note (tick, add, edit, delete, clear completed) or every open task across the
// library or one collection, grouped by note. Items are plain "- [ ]" lines in Still notes, so they also appear in
// Tasks, search, backups and AI context; the widget stores only which note or collection it shows.
import { html, raw, cx, plural } from '../html.js';
import { icon } from '../icons.js';
import { registerActions, registerMount } from '../runtime.js';
import { defineWidget } from '../dashboard/registry.js';
import { findWidget } from '../../lib/dashboard-store.js';
import { button, emptyState } from '../components.js';
import { latestItem, noteResolver } from '../note-editor.js';
import { openCollectionPicker } from '../pickers.js';
import { renderInline } from '../../lib/markdown.js';
import { extractTasks } from '../../lib/notes.js';
import { appendTask, editTask, removeTask, removeTasks, setAllTasks, scopeNotes } from './notes-kit/model.js';
import {
  editNoteContent, editWithUndo, setTaskDone, shownDone, isLingering, liveNotes, noteLabel, noteTile, noteTasks, noteProgress,
  openNoteFromWidget, createWidgetNote, saveConfig, collectionName, progressBar, anchorFor, shownNote, frameShowsName,
} from './notes-kit/shared.js';
import { openNotePicker } from './notes-kit/picker.js';

const SOURCES = [
  { value: 'note', label: 'One note' },
  { value: 'all', label: 'All notes' },
  { value: 'collection', label: 'A collection' },
];
const defaults = () => ({ source: 'note', noteId: '', collectionId: '', hideDone: false, showProgress: true });
const configOf = widget => ({ ...defaults(), ...(widget?.config || {}) });
const configById = id => configOf(findWidget(id)?.widget);
const MAX_GROUPS = 30;
const MAX_TASKS = 150;

// The item being edited in each widget ("noteId:index"); only one at a time per widget.
const editing = new Map();
// Widgets that hide completed items but have them shown for now (until the page reloads or they are hidden again).
const revealed = new Set();
const boxId = (widgetId, noteId, index) => `wcl-${widgetId}-${noteId}-${index}`;
const addId = widgetId => `w-checklist-add-${widgetId}`;

/* ------------------------------------------------------------------ rendering */

function taskRow(ctx, widget, noteId, task) {
  const done = shownDone(noteId, task);
  const id = boxId(widget.id, noteId, task.index);
  const isEditing = editing.get(widget.id) === `${noteId}:${task.index}`;
  const label = task.plain.trim() || 'Empty item';
  const data = { widget: widget.id, note: noteId, index: task.index };
  return html`<li class="${cx('w-checklist-item', done && 'is-done', isEditing && 'is-editing', !task.plain.trim() && 'is-blank')}"
    data-key="${noteId}:${task.index}" data-note="${noteId}" data-index="${task.index}" style="--indent:${Math.min(task.indent, 4)}">
    <input type="checkbox" class="w-checklist-box" id="${id}" ${done ? raw('checked') : ''} aria-label="${label}"
      data-change="w.checklist.toggle" data-widget="${widget.id}" data-note="${noteId}" data-index="${task.index}">
    ${isEditing
      ? html`<input type="text" class="w-checklist-edit" value="${task.text.replace(/\n/g, ' ')}" aria-label="Edit item" data-mount="w.checklist.edit"
          data-key="edit" data-widget="${widget.id}" data-note="${noteId}" data-index="${task.index}" autocomplete="off" spellcheck="true" enterkeyhint="done">`
      : html`<span class="w-checklist-text" data-key="text">${task.plain.trim() ? raw(renderInline(task.text, { resolveLink: noteResolver(ctx) })) : html`<span class="w-checklist-blank">Empty item</span>`}</span>
        <span class="w-checklist-actions" data-key="actions">
          ${rowButton('pencil', `Edit “${label}”`, 'Edit', 'w.checklist.edit', data)}${rowButton('x', `Delete “${label}”`, 'Delete', 'w.checklist.delete', data)}
        </span>`}
  </li>`;
}

// Row buttons use a native title: the styled tooltip would be clipped by the scrolling list.
const rowButton = (name, label, title, action, data) => html`<button type="button" class="icon-btn icon-btn-sm" aria-label="${label}" title="${title}"
  data-action="${action}" data-widget="${data.widget}" data-note="${data.note}" data-index="${data.index}">${icon(name, { size: 14 })}</button>`;

function addForm(widget, noteId, label, { first = false } = {}) {
  return html`<form class="w-checklist-add" data-submit="w.checklist.add" data-widget="${widget.id}" data-note="${noteId}" autocomplete="off" data-key="add">
    <span class="w-checklist-add-icon" aria-hidden="true">${icon('plus', { size: 16 })}</span>
    <label class="sr-only" for="${addId(widget.id)}">Add an item to ${label}</label>
    <input class="w-checklist-add-input" id="${addId(widget.id)}" name="text" type="text" placeholder="${first ? 'Add the first item' : 'Add an item'}"
      enterkeyhint="enter" spellcheck="true">
  </form>`;
}

function render(ctx, widget, env) {
  const config = configOf(widget);
  if (config.source === 'all' || config.source === 'collection') return renderScope(ctx, widget, config, env);
  return renderNote(ctx, widget, config, env);
}

function renderNote(ctx, widget, config) {
  const note = config.noteId ? latestItem(ctx, config.noteId) : null;
  if (!note || note.deletedAt || note.type !== 'note') {
    const missing = !!config.noteId;
    return html`<div class="w-checklist is-setup" data-widget="${widget.id}">${emptyState({
      icon: missing ? 'circle-slash' : 'list-checks', compact: true,
      title: missing ? 'This checklist is no longer in your library' : 'Start a checklist',
      body: missing ? 'Its note may have been deleted. Create a new one or choose another note.' : 'Items are saved as tasks in a note, so they also show up in Tasks and search.',
      actions: html`${button({ label: 'Create checklist', icon: 'plus', size: 'sm', action: 'w.checklist.create', data: { widget: widget.id } })}
        ${button({ label: 'Choose a note', icon: 'search', size: 'sm', variant: 'ghost', action: 'w.checklist.choose', data: { widget: widget.id } })}`,
    })}</div>`;
  }
  const tasks = noteTasks(note);
  const done = tasks.filter(task => shownDone(note.id, task)).length;
  const hiding = config.hideDone && !revealed.has(widget.id);
  const visible = hiding ? tasks.filter(task => !shownDone(note.id, task) || isLingering(note.id, task)) : tasks;
  const hidden = tasks.length - visible.length;
  const edited = editing.get(widget.id);
  if (edited && !visible.some(task => edited === `${note.id}:${task.index}`)) editing.delete(widget.id);
  const label = noteLabel(note);
  // The frame header names the note (displayTitle) unless the widget was renamed or its title is hidden.
  const showName = !frameShowsName(widget, label);
  return html`<div class="w-checklist" data-source="note" data-widget="${widget.id}">
    ${showName || (config.showProgress && tasks.length) ? html`<div class="w-checklist-top">
      ${showName ? html`<button type="button" class="w-checklist-note" data-action="w.checklist.open" data-note="${note.id}" title="Open in Notes">
        <span class="w-checklist-note-name">${label}</span>${icon('arrow-up-right', { size: 12 })}</button>` : ''}
      ${config.showProgress && tasks.length ? progressBar({ done, total: tasks.length }) : ''}
    </div>` : ''}
    <div class="w-checklist-scroll w-scroll-fade">
      ${visible.length
        ? html`<ul class="w-checklist-list" role="list" data-mount="w.checklist.list" data-key="list" data-widget="${widget.id}">${visible.map(task => taskRow(ctx, widget, note.id, task))}</ul>`
        : html`<p class="w-checklist-note-empty">${tasks.length ? html`${icon('circle-check-big', { size: 16 })}<span>Everything here is done.</span>` : 'No items yet.'}</p>`}
      ${hidden ? html`<button type="button" class="w-checklist-reveal" data-action="w.checklist.reveal" data-widget="${widget.id}" aria-expanded="false">
        ${icon('eye', { size: 14 })}Show ${plural(hidden, 'completed item')}</button>`
      : config.hideDone && done ? html`<button type="button" class="w-checklist-reveal" data-action="w.checklist.reveal" data-widget="${widget.id}" aria-expanded="true">
        ${icon('eye-off', { size: 14 })}Hide completed items</button>` : ''}
    </div>
    ${addForm(widget, note.id, label, { first: !tasks.length })}
  </div>`;
}

function renderScope(ctx, widget, config) {
  const inCollection = config.source === 'collection';
  const id = config.collectionId || '';
  if (inCollection && id && !ctx.select.collection(id)) {
    return html`<div class="w-checklist is-setup" data-widget="${widget.id}">${emptyState({
      icon: 'circle-slash', compact: true, title: 'This collection is no longer in your library',
      body: 'Choose another collection to list its open tasks.',
      actions: button({ label: 'Choose a collection', icon: 'folder', size: 'sm', action: 'w.checklist.pick-collection', data: { widget: widget.id } }),
    })}</div>`;
  }
  const notes = scopeNotes(liveNotes(ctx), inCollection ? { collectionId: id, within: id ? ctx.select.descendants(id) : null } : { collectionId: '*' });
  let open = 0, done = 0, shown = 0;
  const groups = [];
  for (const note of notes) {
    const tasks = noteTasks(note);
    if (!tasks.length) continue;
    const finished = tasks.filter(task => shownDone(note.id, task)).length;
    open += tasks.length - finished;
    done += finished;
    const visible = tasks.filter(task => !shownDone(note.id, task) || isLingering(note.id, task));
    if (visible.length) groups.push({ note, tasks: visible, done: finished, total: tasks.length });
  }
  groups.sort((a, b) => String(b.note.updatedAt || '').localeCompare(String(a.note.updatedAt || '')));
  const where = inCollection ? collectionName(ctx, id) : '';
  if (!groups.length) {
    return html`<div class="w-checklist is-setup" data-widget="${widget.id}">${emptyState({
      icon: 'circle-check-big', compact: true,
      title: done ? 'No open tasks' : where ? `No tasks in ${where}` : 'No tasks yet',
      body: done ? `All ${plural(done, 'task')} ${inCollection ? `in ${where} ` : ''}are done.` : 'Add “- [ ]” items to a note and they show up here.',
      actions: button({ label: 'Create checklist', icon: 'plus', size: 'sm', action: 'w.checklist.create', data: { widget: widget.id } }),
    })}</div>`;
  }
  const blocks = [];
  for (const group of groups.slice(0, MAX_GROUPS)) {
    if (shown >= MAX_TASKS) break;
    const tasks = group.tasks.slice(0, MAX_TASKS - shown);
    shown += tasks.length;
    blocks.push(html`<section class="w-checklist-group" data-key="${group.note.id}" aria-labelledby="wclg-${widget.id}-${group.note.id}">
      <h3 class="w-checklist-group-head">
        <button type="button" class="w-checklist-group-title" id="wclg-${widget.id}-${group.note.id}" data-action="w.checklist.open" data-note="${group.note.id}" title="Open in Notes">
          ${noteTile(ctx, group.note, 16)}<span class="w-checklist-group-name">${noteLabel(group.note)}</span></button>
        <span class="w-checklist-group-count"><span aria-hidden="true">${group.done}/${group.total}</span><span class="sr-only">${group.done} of ${group.total} done</span></span>
      </h3>
      <ul class="w-checklist-list" role="list" data-mount="w.checklist.list" data-key="list" data-widget="${widget.id}">${tasks.map(task => taskRow(ctx, widget, group.note.id, task))}</ul>
    </section>`);
  }
  const more = open - Math.min(open, shown);
  return html`<div class="w-checklist" data-source="${config.source}" data-widget="${widget.id}">
    <div class="w-checklist-top">
      <p class="w-checklist-count" role="status"><span class="w-checklist-count-num">${open.toLocaleString()}</span> open<span class="w-checklist-count-sep" aria-hidden="true">·</span>${done.toLocaleString()} done</p>
      ${config.showProgress ? progressBar({ done, total: open + done }, { className: 'is-bare' }) : ''}
    </div>
    <div class="w-checklist-scroll w-scroll-fade">${blocks}
      ${more > 0 ? html`<button type="button" class="w-checklist-reveal" data-action="w.checklist.all-tasks">${icon('arrow-right', { size: 14 })}View all open tasks</button>` : ''}
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ frame menu and settings */

function menu(ctx, widget) {
  const config = configOf(widget);
  const items = [];
  const note = config.source === 'note' && config.noteId ? latestItem(ctx, config.noteId) : null;
  if (note && !note.deletedAt) {
    const { done } = noteProgress(note);
    items.push(
      { label: 'Open note', icon: 'square-pen', run: () => openNoteFromWidget(ctx, note.id) },
      { label: config.hideDone ? 'Always show completed items' : 'Hide completed items', icon: config.hideDone ? 'eye' : 'eye-off',
        run: () => { revealed.delete(widget.id); return ctx.run(() => saveConfig(widget.id, { hideDone: !config.hideDone })); } },
      { label: 'Uncheck all items', icon: 'rotate-ccw', disabled: !done, run: () => ctx.run(() => editWithUndo(ctx, note.id, content => setAllTasks(content, false), 'All items unchecked')) },
      { label: 'Clear completed items', icon: 'eraser', disabled: !done, run: () => ctx.run(() => clearCompleted(ctx, note.id)) },
      { separator: true },
    );
  }
  items.push(
    { heading: 'Show tasks from' },
    { label: 'A note…', checked: config.source === 'note', run: () => chooseNote(ctx, widget.id) },
    { label: 'All notes', checked: config.source === 'all', run: () => ctx.run(() => saveConfig(widget.id, { source: 'all' })) },
    { label: 'A collection…', checked: config.source === 'collection', run: () => pickCollection(ctx, widget.id) },
  );
  if (config.source !== 'note') items.push({ separator: true }, { label: 'Open Tasks', icon: 'arrow-up-right', run: () => ctx.navigate('tasks') });
  return items;
}

function fields() {
  return [
    { name: 'source', label: 'Show tasks from', type: 'segmented', options: SOURCES, default: 'note' },
    { name: 'noteId', label: 'Checklist note', type: 'note', hint: 'Leave empty to start a new checklist from the widget.', when: draft => (draft.source || 'note') === 'note' },
    { name: 'collectionId', label: 'Collection', type: 'collection', hint: 'Open tasks in nested collections are included.', when: draft => draft.source === 'collection' },
    { name: 'hideDone', label: 'Hide completed items', type: 'toggle', default: false, when: draft => (draft.source || 'note') === 'note' },
    { name: 'showProgress', label: 'Show progress', type: 'toggle', default: true },
  ];
}

defineWidget({
  type: 'checklist',
  title: 'Checklist',
  description: 'Tick off a note’s tasks, or every open task in your library or a collection.',
  icon: 'list-checks',
  category: 'library',
  keywords: ['tasks', 'todo', 'to-do', 'checklist', 'checkbox', 'list', 'progress'],
  size: { w: 3, h: 4, minW: 2, minH: 2, maxW: 8, maxH: 12 },
  presets: { S: { w: 3, h: 3 }, M: { w: 3, h: 4 }, L: { w: 4, h: 6 }, XL: { w: 6, h: 7 } },
  defaults,
  // Showing one note, an untitled widget is named after it.
  displayTitle: (ctx, widget) => {
    const config = configOf(widget);
    const note = config.source === 'note' ? shownNote(ctx, config.noteId) : null;
    return note ? noteLabel(note) : '';
  },
  render,
  menu,
  fields,
  preview: 'Tasks from your notes',
});

/* ------------------------------------------------------------------ actions */

async function createChecklist(ctx, widgetId) {
  const widget = findWidget(widgetId)?.widget;
  const title = (widget?.title || '').trim() || 'Checklist';
  const item = await createWidgetNote(ctx, { title, content: '- [ ] ', collectionId: '*' });
  await saveConfig(widgetId, { source: 'note', noteId: item.id });
  ctx.nextFrame(() => document.getElementById(addId(widgetId))?.focus());
  ctx.toast(`“${title}” added to your notes`, { tone: 'success' });
}

function chooseNote(ctx, widgetId, anchor) {
  const config = configById(widgetId);
  openNotePicker(ctx, anchor || anchorFor(`.w-checklist[data-widget="${widgetId}"]`), {
    label: 'Search notes for a checklist', preferTasks: true, selectedId: config.source === 'note' ? config.noteId : '',
    onPick: note => ctx.run(() => saveConfig(widgetId, { source: 'note', noteId: note.id })),
    create: { label: 'Create a new checklist', run: () => ctx.run(() => createChecklist(ctx, widgetId)) },
  });
}

function pickCollection(ctx, widgetId, anchor) {
  const config = configById(widgetId);
  openCollectionPicker(ctx, anchor || anchorFor(`.w-checklist[data-widget="${widgetId}"]`), {
    value: config.collectionId || '', title: 'Show open tasks from', allowCreate: false,
    onPick: id => ctx.run(() => saveConfig(widgetId, { source: 'collection', collectionId: id || '' })),
  });
}

function clearCompleted(ctx, noteId) {
  return editWithUndo(ctx, noteId, content => {
    const done = extractTasks(content).filter(task => task.done).map(task => task.index);
    return done.length ? removeTasks(content, done) : null;
  }, 'Completed items cleared');
}

function startEdit(ctx, widgetId, noteId, index) {
  editing.set(widgetId, `${noteId}:${index}`);
  ctx.render();
}

/** Ends editing; Enter and Escape return focus to the item's checkbox, a click elsewhere leaves focus where it went. */
async function finishEdit(ctx, el, { save, refocus }) {
  const { widget, note, index } = el.dataset;
  if (editing.get(widget) !== `${note}:${index}`) return;
  editing.delete(widget);
  const value = el.value.trim();
  const original = extractTasks(latestItem(ctx, note)?.content || '').find(task => task.index === Number(index))?.text || '';
  ctx.render();
  if (refocus) ctx.nextFrame(() => document.getElementById(boxId(widget, note, index))?.focus());
  if (!save || value === original.replace(/\n/g, ' ').trim()) return;
  await ctx.run(() => (value
    ? editNoteContent(ctx, note, content => editTask(content, Number(index), value))
    : editWithUndo(ctx, note, content => removeTask(content, Number(index)), 'Item deleted')));
}

registerMount('w.checklist.edit', (el, ctx) => {
  el.focus({ preventScroll: true });
  el.setSelectionRange(el.value.length, el.value.length);
  let closing = false;
  const close = options => { if (closing) return; closing = true; finishEdit(ctx, el, options); };
  const onKey = event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); close({ save: true, refocus: true }); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close({ save: false, refocus: true }); }
  };
  const onBlur = () => close({ save: true, refocus: false });
  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', onBlur);
  // A re-render can remove the field without a blur (another view changed the note): keep what was typed.
  return { destroy() { el.removeEventListener('keydown', onKey); el.removeEventListener('blur', onBlur); close({ save: true, refocus: false }); } };
});

// Double-click an item's text to edit it (the pencil button is the keyboard path).
registerMount('w.checklist.list', (el, ctx) => {
  const onDouble = event => {
    if (event.target.closest('a, input, button')) return;
    const row = event.target.closest('.w-checklist-item');
    if (!row || !el.contains(row) || !row.querySelector('.w-checklist-text')) return;
    event.preventDefault();
    globalThis.getSelection?.()?.removeAllRanges();
    startEdit(ctx, el.dataset.widget, row.dataset.note, Number(row.dataset.index));
  };
  el.addEventListener('dblclick', onDouble);
  return { destroy: () => el.removeEventListener('dblclick', onDouble) };
});

registerActions({
  'w.checklist.toggle': ({ ctx, el, data }) => setTaskDone(ctx, data.note, Number(data.index), el.checked),
  'w.checklist.add': async ({ ctx, el, data }) => {
    const input = el.querySelector('input[name="text"]');
    const text = input?.value.trim();
    if (!text) { input?.focus(); return; }
    input.value = '';
    const result = await editNoteContent(ctx, data.note, content => appendTask(content, text, { fillEmpty: true }));
    if (!result && input && !input.value) input.value = text;
    ctx.nextFrame(() => el.closest('.w-checklist')?.querySelector('.w-checklist-scroll')?.scrollTo({ top: 1e6 }));
  },
  'w.checklist.edit': ({ ctx, data }) => startEdit(ctx, data.widget, data.note, Number(data.index)),
  'w.checklist.delete': async ({ ctx, el, data }) => {
    const row = el.closest('.w-checklist-item');
    const next = row?.nextElementSibling || row?.previousElementSibling;
    const nextBox = next?.querySelector('.w-checklist-box')?.id;
    await editWithUndo(ctx, data.note, content => removeTask(content, Number(data.index)), 'Item deleted');
    ctx.nextFrame(() => (document.getElementById(nextBox) || document.getElementById(addId(data.widget)))?.focus({ preventScroll: true }));
  },
  'w.checklist.open': ({ ctx, data }) => openNoteFromWidget(ctx, data.note),
  'w.checklist.create': ({ ctx, data }) => createChecklist(ctx, data.widget),
  'w.checklist.choose': ({ ctx, el, data }) => chooseNote(ctx, data.widget, el),
  'w.checklist.pick-collection': ({ ctx, el, data }) => pickCollection(ctx, data.widget, el),
  'w.checklist.reveal': ({ ctx, data }) => {
    if (revealed.has(data.widget)) revealed.delete(data.widget); else revealed.add(data.widget);
    ctx.render();
  },
  'w.checklist.all-tasks': ({ ctx }) => ctx.navigate('tasks'),
});
