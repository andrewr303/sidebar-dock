// Notes widget: recent notes from the library (with a live preview at large sizes), one pinned note rendered with
// tickable tasks and a quick-append line, or a quick-capture scratchpad that saves new notes. Notes stay ordinary
// library items; the widget keeps only references and its draft in widget.config.
import { html, raw, cx, plural } from '../html.js';
import { icon } from '../icons.js';
import { registerActions } from '../runtime.js';
import { defineWidget } from '../dashboard/registry.js';
import { findWidget } from '../../lib/dashboard-store.js';
import { button, iconButton, emptyState, kbd, collectionIcon } from '../components.js';
import { NOTE_SORTS, previewSource, editedLabel, shortAgo } from '../notes.js';
import { latestItem, noteResolver } from '../note-editor.js';
import { openCollectionPicker } from '../pickers.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { taskProgress } from '../../lib/notes.js';
import { recentNotes, captureDraft, quickAppend } from './notes-kit/model.js';
import {
  editNoteContent, setTaskDone, withPending, liveNotes, noteLabel, noteTile, noteProgress, noteSnippet, openNoteFromWidget, createWidgetNote,
  saveConfig, collectionOptions, collectionName, targetCollection, progressBar, anchorFor,
} from './notes-kit/shared.js';
import { openNotePicker } from './notes-kit/picker.js';

const MODES = [
  { value: 'recent', label: 'Recent notes', icon: 'clock' },
  { value: 'note', label: 'One note', icon: 'sticky-note' },
  { value: 'capture', label: 'Quick capture', icon: 'square-pen' },
];
const defaults = () => ({ mode: 'recent', collectionId: '*', tag: '', noteId: '', limit: 8, sort: 'updated', includeStickies: false, draft: '', captures: [] });
const configOf = widget => ({ ...defaults(), ...(widget?.config || {}) });

// Per-instance UI state that does not belong in storage: the previewed note, and the capture draft between saves.
const previewed = new Map();
const drafts = new Map();
const draftTimers = new Map();

/* ------------------------------------------------------------------ rendering */

const rendered = new Map();
/**
 * The whole note as Markdown HTML, memoized on its revision, pending checkbox writes and wiki-link targets. Note
 * headings become h4 (with their level kept in data-level) so they nest under the widget (h2) and note title (h3).
 * The renderer escapes all note text, so the only heading tags in its output are its own.
 */
function noteHtml(ctx, note) {
  const content = withPending(note);
  const links = content.includes('[[') ? ctx.library?.updatedAt : '';
  const key = `${note.id}|${note.updatedAt}|${content.length}|${content === note.content ? '' : content}|${links}`;
  if (!rendered.has(key)) {
    const markup = renderMarkdown(previewSource(content, note.title), { interactiveTasks: true, resolveLink: noteResolver(ctx) })
      .replace(/<h([1-3])>/g, '<h4 data-level="$1">').replace(/<\/h[1-3]>/g, '</h4>');
    rendered.set(key, markup);
    if (rendered.size > 60) rendered.delete(rendered.keys().next().value);
  }
  return rendered.get(key);
}

function render(ctx, widget, env) {
  const config = configOf(widget);
  if (config.mode === 'note') return renderPinned(ctx, widget, config, env);
  if (config.mode === 'capture') return renderCapture(ctx, widget, config, env);
  return renderRecent(ctx, widget, config, env);
}

function scopeFor(ctx, config) {
  const id = config.collectionId;
  const within = id && id !== '*' && ctx.select.collection(id) ? ctx.select.descendants(id) : null;
  return { collectionId: id === '*' || id === '' || within ? id : '*', within, tag: config.tag, includeStickies: !!config.includeStickies };
}

function renderRecent(ctx, widget, config, env) {
  const { rows, total } = recentNotes(liveNotes(ctx), { ...scopeFor(ctx, config), sort: config.sort, limit: config.limit });
  if (!rows.length) {
    const where = config.collectionId === '*' ? '' : collectionName(ctx, config.collectionId);
    return html`<div class="w-notes is-empty" data-widget="${widget.id}">${emptyState({
      icon: 'sticky-note', compact: true,
      title: config.tag ? `No notes tagged #${config.tag}` : where ? `No notes in ${where}` : 'No notes yet',
      body: 'Notes you write in Still show up here, newest first.',
      actions: button({ label: 'New note', icon: 'plus', size: 'sm', action: 'w.notes.new', data: { widget: widget.id } }),
    })}</div>`;
  }
  const split = env.w >= 6 && env.h >= 4;
  const current = rows.find(note => note.id === previewed.get(widget.id)) || rows[0];
  return html`<div class="w-notes" data-mode="recent" data-layout="${split ? 'split' : 'list'}" data-size="${env.size}" data-widget="${widget.id}">
    <div class="w-notes-pane">
      <ul class="w-notes-list w-scroll-fade" role="list" data-keydown="w.notes.list-key" data-widget="${widget.id}">
        ${rows.map(note => noteRow(ctx, widget, note, split && note.id === current.id))}
      </ul>
      ${total > rows.length ? html`<button type="button" class="w-notes-more" data-action="w.notes.view-all" data-widget="${widget.id}">
        View all ${plural(total, 'note')}${icon('arrow-right', { size: 14 })}</button>` : ''}
    </div>
    ${split ? notePreview(ctx, widget, current) : ''}
  </div>`;
}

function noteRow(ctx, widget, note, selected) {
  const progress = noteProgress(note);
  const excerpt = noteSnippet(note);
  return html`<li class="w-notes-item" data-key="${note.id}">
    <button type="button" class="${cx('w-notes-row', selected && 'is-selected')}" data-action="w.notes.row" data-widget="${widget.id}" data-id="${note.id}"
      ${selected ? raw('aria-current="true"') : ''} title="${editedLabel(note.updatedAt)}">
      ${noteTile(ctx, note, 20)}
      <span class="w-notes-row-main">
        <span class="w-notes-row-title">${note.pinned ? html`<span class="w-notes-row-pin">${icon('pin', { size: 12, label: 'Pinned' })}</span>` : ''}${noteLabel(note)}</span>
        ${excerpt ? html`<span class="w-notes-row-excerpt">${excerpt}</span>` : ''}
      </span>
      <span class="w-notes-row-meta">
        <time datetime="${note.updatedAt}">${shortAgo(note.updatedAt)}</time>
        ${progress.total ? html`<span class="${cx('w-notes-row-tasks', progress.done === progress.total && 'is-complete')}">${icon('list-checks', { size: 12 })}<span aria-hidden="true">${progress.done}/${progress.total}</span><span class="sr-only">, ${progress.done} of ${progress.total} tasks done</span></span>` : ''}
      </span>
    </button>
  </li>`;
}

function noteMeta(ctx, note) {
  const collection = note.collectionId ? ctx.select.collection(note.collectionId) : null;
  return html`<p class="w-notes-meta">
    <span class="w-notes-meta-place">${collectionIcon(collection, { size: 14 })}<span>${collection?.name || 'Inbox'}</span></span>
    <time datetime="${note.updatedAt}">${editedLabel(note.updatedAt)}</time>
  </p>`;
}

function noteBody(ctx, note, className) {
  const empty = !String(note.content || '').trim();
  return html`<div class="${cx('w-notes-body', 'markdown-body', 'is-compact', 'w-scroll-fade', className)}" data-action="w.notes.body-click" data-change="w.notes.task" data-id="${note.id}">
    ${empty ? html`<p class="w-notes-blank">This note is empty.</p>` : raw(noteHtml(ctx, note))}</div>`;
}

function notePreview(ctx, widget, note) {
  return html`<article class="w-notes-preview" aria-labelledby="w-notes-pv-${widget.id}" data-key="preview">
    <header class="w-notes-preview-head">
      <h3 class="w-notes-preview-title" id="w-notes-pv-${widget.id}">${noteLabel(note)}</h3>
      ${iconButton({ icon: 'square-pen', label: 'Edit note', action: 'w.notes.open', data: { widget: widget.id, id: note.id }, size: 'sm', tooltipPlacement: 'bottom end' })}
    </header>
    ${noteMeta(ctx, note)}
    ${noteBody(ctx, note, 'w-notes-preview-body')}
  </article>`;
}

function renderPinned(ctx, widget, config, env) {
  const note = config.noteId ? latestItem(ctx, config.noteId) : null;
  if (!note || note.deletedAt || note.type !== 'note') {
    const missing = !!config.noteId;
    return html`<div class="w-notes is-empty" data-widget="${widget.id}">${emptyState({
      icon: missing ? 'pin-off' : 'pin', compact: true,
      title: missing ? 'This note is no longer in your library' : 'Pin a note here',
      body: missing ? 'It may have been deleted. Choose another note to show here.' : 'Keep one note in view and tick its tasks without opening it.',
      actions: html`${button({ label: missing ? 'Choose another note' : 'Choose a note', icon: 'search', size: 'sm', action: 'w.notes.choose', data: { widget: widget.id } })}
        ${button({ label: 'New note', icon: 'plus', size: 'sm', variant: 'ghost', action: 'w.notes.new-pinned', data: { widget: widget.id } })}`,
    })}</div>`;
  }
  const progress = taskProgress(withPending(note));
  const label = noteLabel(note);
  return html`<div class="w-notes" data-mode="note" data-widget="${widget.id}">
    <header class="w-notes-note-head">
      <h3 class="w-notes-note-title"><button type="button" class="w-notes-note-open" data-action="w.notes.open" data-widget="${widget.id}" data-id="${note.id}"
        title="Open in Notes">${label}</button></h3>
      ${progress.total ? progressBar(progress, { compact: true }) : ''}
    </header>
    ${noteMeta(ctx, note)}
    ${noteBody(ctx, note, 'w-notes-note-body')}
    ${env.h >= 3 ? html`<form class="w-notes-append" data-submit="w.notes.append" data-widget="${widget.id}" data-id="${note.id}" autocomplete="off">
      <label class="sr-only" for="w-notes-append-${widget.id}">Add to ${label}</label>
      <input class="w-notes-append-input" id="w-notes-append-${widget.id}" name="text" type="text" placeholder="Add a line, or start with [ ] for a task"
        enterkeyhint="send" spellcheck="true">
      <button type="submit" class="icon-btn icon-btn-sm w-notes-append-send" aria-label="Add to note" data-tooltip="Add to note">${icon('corner-down-left', { size: 14 })}</button>
    </form>` : ''}
  </div>`;
}

function renderCapture(ctx, widget, config, env) {
  const draft = drafts.has(widget.id) ? drafts.get(widget.id) : String(config.draft || '');
  const target = targetCollection(ctx, config.collectionId);
  const collection = target ? ctx.select.collection(target) : null;
  const captures = (Array.isArray(config.captures) ? config.captures : []).map(id => ctx.select.byId(id))
    .filter(note => note && note.type === 'note' && !note.deletedAt).slice(0, env.h >= 6 ? 5 : 3);
  const showRecent = env.h >= 4 && captures.length;
  return html`<div class="w-notes" data-mode="capture" data-widget="${widget.id}">
    <form class="w-notes-capture" data-submit="w.notes.capture" data-widget="${widget.id}" autocomplete="off">
      <label class="sr-only" for="w-notes-capture-${widget.id}">Quick note</label>
      <textarea class="w-notes-capture-input" id="w-notes-capture-${widget.id}" name="text" placeholder="Write something…" spellcheck="true"
        data-input="w.notes.draft" data-keydown="w.notes.capture-key" data-widget="${widget.id}" aria-describedby="w-notes-capture-hint-${widget.id}">${draft}</textarea>
      <div class="w-notes-capture-bar">
        <button type="button" class="w-notes-capture-target" data-action="w.notes.capture-target" data-widget="${widget.id}"
          aria-label="Save to ${collection?.name || 'Inbox'}. Change collection" data-tooltip="Choose where notes are saved">
          ${collectionIcon(collection, { size: 16 })}<span class="w-notes-capture-target-name">${collection?.name || 'Inbox'}</span>${icon('chevron-down', { size: 12 })}
        </button>
        <span class="w-notes-capture-hint" id="w-notes-capture-hint-${widget.id}">${kbd('mod+enter')}<span class="sr-only">saves the note</span></span>
        ${button({ label: 'Save', size: 'sm', type: 'submit', className: 'w-notes-capture-save' })}
      </div>
    </form>
    ${showRecent ? html`<section class="w-notes-captures" aria-labelledby="w-notes-cap-${widget.id}">
      <h3 class="w-notes-captures-title" id="w-notes-cap-${widget.id}">Recently captured</h3>
      <ul class="w-notes-captures-list" role="list">${captures.map(note => html`<li data-key="${note.id}">
        <button type="button" class="w-notes-capture-row" data-action="w.notes.open" data-widget="${widget.id}" data-id="${note.id}">
          <span class="w-notes-capture-row-title">${noteLabel(note)}</span><time datetime="${note.createdAt}">${shortAgo(note.createdAt)}</time>
        </button></li>`)}</ul>
    </section>` : ''}
  </div>`;
}

/* ------------------------------------------------------------------ frame header and menu */

function headerActions(ctx, widget) {
  const config = configOf(widget);
  if (config.mode === 'recent') return iconButton({ icon: 'plus', label: 'New note', action: 'w.notes.new', data: { widget: widget.id }, size: 'sm', tooltipPlacement: 'bottom end' });
  if (config.mode === 'note' && config.noteId && ctx.select.byId(config.noteId)) {
    return iconButton({ icon: 'square-pen', label: 'Edit note', action: 'w.notes.open', data: { widget: widget.id, id: config.noteId }, size: 'sm', tooltipPlacement: 'bottom end' });
  }
  return '';
}

function menu(ctx, widget) {
  const config = configOf(widget);
  const items = [{ heading: 'Show' }, ...MODES.map(mode => ({
    label: mode.label, checked: config.mode === mode.value,
    run: () => ctx.run(() => (mode.value === 'note' && !config.noteId ? chooseNote(ctx, widget.id) : saveConfig(widget.id, { mode: mode.value }))),
  })), { separator: true }];
  if (config.mode === 'note') {
    items.push({ label: config.noteId ? 'Choose another note…' : 'Choose a note…', icon: 'search', run: () => chooseNote(ctx, widget.id) });
    if (config.noteId && ctx.select.byId(config.noteId)) items.push({ label: 'Edit note', icon: 'square-pen', run: () => openNoteFromWidget(ctx, config.noteId) });
  } else if (config.mode === 'recent') {
    items.push({ label: 'New note', icon: 'plus', run: () => ctx.run(() => newNote(ctx, widget.id)) });
  }
  items.push({ label: 'Open Notes', icon: 'arrow-up-right', run: () => openNotesView(ctx, config) });
  return items;
}

function fields(ctx) {
  const tags = ctx.select.tags().slice(0, 60).map(tag => ({ value: tag.name, label: `#${tag.name}` }));
  const recent = draft => (draft.mode || 'recent') === 'recent';
  return [
    { name: 'mode', label: 'Show', type: 'segmented', options: MODES.map(({ value, label }) => ({ value, label })), default: 'recent' },
    { name: 'noteId', label: 'Note', type: 'note', hint: 'The note shown in this widget.', when: draft => draft.mode === 'note' },
    { name: 'collectionId', label: 'Collection', type: 'select', options: collectionOptions(ctx), default: '*', hint: 'Notes in nested collections are included.', when: recent },
    { name: 'tag', label: 'Tag', type: 'select', options: [{ value: '', label: 'Any tag' }, ...tags], when: recent },
    { name: 'sort', label: 'Order', type: 'select', options: NOTE_SORTS, default: 'updated', when: recent },
    { name: 'limit', label: 'Notes to show', type: 'number', min: 1, max: 50, step: 1, default: 8, when: recent },
    { name: 'includeStickies', label: 'Include sticky notes', type: 'toggle', when: recent },
    { name: 'collectionId', label: 'Save notes to', type: 'select', options: collectionOptions(ctx, { allLabel: 'Default collection' }), default: '*', when: draft => draft.mode === 'capture' },
  ];
}

defineWidget({
  type: 'notes',
  title: 'Notes',
  description: 'Recent notes, one pinned note with tickable tasks, or a quick-capture pad.',
  icon: 'sticky-note',
  category: 'library',
  keywords: ['notes', 'write', 'capture', 'scratchpad', 'memo', 'pinned note', 'markdown'],
  size: { w: 4, h: 4, minW: 2, minH: 2, maxW: 12, maxH: 12 },
  presets: { S: { w: 3, h: 3 }, M: { w: 4, h: 4 }, L: { w: 6, h: 5 }, XL: { w: 8, h: 6 } },
  defaults,
  render,
  headerActions,
  menu,
  fields,
  preview: 'Recent notes',
});

/* ------------------------------------------------------------------ actions */

const configById = id => configOf(findWidget(id)?.widget);

async function newNote(ctx, widgetId) {
  const config = configById(widgetId);
  const item = await createWidgetNote(ctx, { collectionId: config.collectionId, tags: config.tag ? [config.tag] : [] });
  openNoteFromWidget(ctx, item.id, { focus: 'title' });
}

function chooseNote(ctx, widgetId, anchor) {
  const config = configById(widgetId);
  openNotePicker(ctx, anchor || anchorFor(`.w-notes[data-widget="${widgetId}"]`), {
    label: 'Search notes to show', selectedId: config.noteId,
    onPick: note => ctx.run(() => saveConfig(widgetId, { mode: 'note', noteId: note.id })),
  });
}

function openNotesView(ctx, config) {
  const id = config.collectionId;
  ctx.state.notes = { ...(ctx.state.notes || {}), noteId: null, query: config.tag ? `#${config.tag}` : '',
    collectionId: id === '' ? '__none' : id && id !== '*' && ctx.select.collection(id) ? id : '' };
  ctx.navigate('notes', { keep: true });
}

function saveDraftSoon(widgetId) {
  clearTimeout(draftTimers.get(widgetId));
  draftTimers.set(widgetId, setTimeout(() => {
    draftTimers.delete(widgetId);
    if (!drafts.has(widgetId) || !findWidget(widgetId)) return;
    saveConfig(widgetId, { draft: drafts.get(widgetId) }).catch(error => console.warn('[still] draft not saved', error));
  }, 500));
}

async function capture(ctx, widgetId, field) {
  const text = field ? field.value : drafts.get(widgetId) || '';
  const draft = captureDraft(text);
  if (!draft) { field?.focus(); ctx.toast('Write something first.'); return; }
  const config = configById(widgetId);
  const item = await createWidgetNote(ctx, { ...draft, collectionId: config.collectionId });
  drafts.set(widgetId, '');
  clearTimeout(draftTimers.get(widgetId));
  if (field) field.value = '';
  await saveConfig(widgetId, { draft: '', captures: [item.id, ...(config.captures || []).filter(id => id !== item.id)].slice(0, 8) });
  const where = item.collectionId ? ctx.select.collection(item.collectionId)?.name || 'your library' : 'Inbox';
  ctx.toast(`Saved to ${where}`, { tone: 'success', action: { label: 'Open', run: () => openNoteFromWidget(ctx, item.id) } });
}

registerActions({
  'w.notes.new': ({ ctx, data }) => newNote(ctx, data.widget),
  'w.notes.new-pinned': async ({ ctx, data }) => {
    const item = await createWidgetNote(ctx, { collectionId: '*' });
    await saveConfig(data.widget, { mode: 'note', noteId: item.id });
    openNoteFromWidget(ctx, item.id, { focus: 'title' });
  },
  'w.notes.choose': ({ ctx, el, data }) => chooseNote(ctx, data.widget, el),
  'w.notes.open': ({ ctx, data }) => openNoteFromWidget(ctx, data.id),
  'w.notes.view-all': ({ ctx, data }) => openNotesView(ctx, configById(data.widget)),
  // In the split layout a click previews the note and a second click (or Enter on the previewed row) opens it.
  'w.notes.row': ({ ctx, el, data }) => {
    const root = el.closest('.w-notes');
    const preview = root?.querySelector('.w-notes-preview');
    const split = root?.dataset.layout === 'split' && preview && preview.getClientRects().length > 0;
    if (split && !el.classList.contains('is-selected')) { previewed.set(data.widget, data.id); ctx.render(); return; }
    openNoteFromWidget(ctx, data.id);
  },
  'w.notes.list-key': ({ ctx, el, event }) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.altKey || event.metaKey || event.ctrlKey) return;
    const rows = [...el.querySelectorAll('.w-notes-row')];
    const index = rows.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = rows[event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
    if (el.closest('.w-notes')?.dataset.layout === 'split') { previewed.set(el.dataset.widget, next.dataset.id); ctx.render(); }
  },
  'w.notes.body-click': ({ ctx, event }) => {
    const link = event?.target?.closest?.('a.note-link[data-id]');
    if (!link) return;
    event.preventDefault();
    const target = ctx.select.byId(link.dataset.id);
    if (target?.type === 'note') openNoteFromWidget(ctx, target.id); else if (target) ctx.openItem(target.id);
  },
  'w.notes.task': ({ ctx, el, event }) => {
    const box = event?.target;
    const index = Number(box?.dataset?.taskIndex);
    if (!box?.matches?.('input[type="checkbox"]') || !Number.isInteger(index)) return undefined;
    return setTaskDone(ctx, el.dataset.id, index, box.checked);
  },
  'w.notes.append': async ({ ctx, el, data }) => {
    const input = el.querySelector('input[name="text"]');
    const text = input?.value.trim();
    if (!text) { input?.focus(); return; }
    input.value = '';
    const result = await editNoteContent(ctx, data.id, content => quickAppend(content, text));
    if (!result && input && !input.value) input.value = text;
  },
  'w.notes.draft': ({ el, data }) => { drafts.set(data.widget, el.value); saveDraftSoon(data.widget); },
  'w.notes.capture-key': ({ ctx, el, data, event }) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.isComposing) return undefined;
    event.preventDefault();
    return capture(ctx, data.widget, el);
  },
  'w.notes.capture': ({ ctx, el, data }) => capture(ctx, data.widget, el.querySelector('textarea[name="text"]')),
  'w.notes.capture-target': ({ ctx, el, data }) => {
    const config = configById(data.widget);
    openCollectionPicker(ctx, el, {
      value: targetCollection(ctx, config.collectionId), title: 'Save notes to', allowCreate: true,
      onPick: id => saveConfig(data.widget, { collectionId: id || '' }),
    });
  },
});

// Saves a pending capture draft at once when the tab is hidden or closed, before the debounce would have fired.
function flushDrafts() {
  for (const [id, timer] of draftTimers) {
    clearTimeout(timer);
    draftTimers.delete(id);
    if (findWidget(id)) saveConfig(id, { draft: drafts.get(id) || '' }).catch(() => {});
  }
}
if (typeof document !== 'undefined') {
  globalThis.addEventListener('pagehide', flushDrafts);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDrafts(); });
}
