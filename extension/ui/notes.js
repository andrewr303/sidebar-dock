// Notes surfaces (SPEC §6): the full-tab workspace (list column, editor, info rail), the side panel Notes tab
// (re:note style cards and the editor screen), notes on the current page for the This page tab, the Tasks view and
// note creation (blank, templates, daily note). The editor itself lives in note-editor.js.
import { html, raw, cx, safeHref } from './html.js';
import { icon } from './icons.js';
import { registerActions, registerMount } from './runtime.js';
import { registerPopover } from './overlay.js';
import { button, iconButton, segmented, searchField, emptyState, favicon, domainOf, relativeDate, shortDate, colorVar } from './components.js';
import { searchRows } from './selectors.js';
import * as pickers from './pickers.js';
import { renderNoteEditor, openNote, closeNote, createNoteItem, editorFor, latestItem, rememberItem, displayTitle, titleValue, noteResolver, openInFullTab } from './note-editor.js';
import { renderMarkdown, renderInline } from '../lib/markdown.js';
import { notePreviewSource as previewSource } from './cards.js';
import { extractTasks, toggleTask, taskProgress, noteExcerpt, noteTitleFromContent, outline, wordCount, dailyNoteTitle, noteTemplates } from '../lib/notes.js';

export const NO_COLLECTION = '__none';
export const NOTE_SORTS = [
  { value: 'updated', label: 'Last edited' },
  { value: 'created', label: 'Date created' },
  { value: 'title', label: 'Title' },
];
const PAGE_SIZE = 150;
const TEMPLATE_ICONS = { blank: 'file', daily: 'calendar-days', meeting: 'users', reading: 'book-open', project: 'target' };

/* ------------------------------------------------------------------ pure helpers (unit-tested) */

const titleKey = note => titleValue(note.title).trim() || String(note.content || '').trim();
const SORTERS = {
  updated: (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
  created: (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  title: (a, b) => titleKey(a).localeCompare(titleKey(b), undefined, { sensitivity: 'base', numeric: true }),
};

/** Notes for a list: collection filter ('' all, NO_COLLECTION, or an id), search syntax as in the library, pinned first. */
export function filterNotes(notes, { query = '', collectionId = '', sort = 'updated', collections } = {}) {
  let rows = notes || [];
  if (collectionId === NO_COLLECTION) rows = rows.filter(note => !note.collectionId);
  else if (collectionId) rows = rows.filter(note => note.collectionId === collectionId);
  if (String(query).trim()) rows = searchRows(rows, query, collections);
  const by = SORTERS[sort] || SORTERS.updated;
  return [...rows].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || by(a, b));
}

/** Note counts per collection: { total, none, byId: { [collectionId]: n } }. */
export function collectionCounts(notes) {
  const byId = {};
  let none = 0;
  for (const note of notes || []) {
    if (note.collectionId) byId[note.collectionId] = (byId[note.collectionId] || 0) + 1;
    else none++;
  }
  return { total: (notes || []).length, none, byId };
}

export { previewSource };

const TASK_HINT = /\[[ xX]\]/;
/** Tasks grouped by note for the Tasks view, newest edited note first. filter: 'open' | 'done' | 'all'. */
export function groupTasks(notes, filter = 'open') {
  const groups = [];
  for (const note of notes || []) {
    if (!note?.content || !TASK_HINT.test(note.content)) continue;
    const tasks = extractTasks(note.content);
    if (!tasks.length) continue;
    const done = tasks.filter(task => task.done).length;
    const shown = filter === 'all' ? tasks : tasks.filter(task => (filter === 'done' ? task.done : !task.done));
    if (shown.length) groups.push({ note, tasks: shown, done, total: tasks.length });
  }
  return groups.sort((a, b) => String(b.note.updatedAt || '').localeCompare(String(a.note.updatedAt || '')));
}

/** Task totals across notes: { open, done, all }. */
export function taskTotals(notes) {
  let open = 0, done = 0;
  for (const note of notes || []) {
    if (!note?.content || !TASK_HINT.test(note.content)) continue;
    const progress = taskProgress(note.content);
    done += progress.done;
    open += progress.total - progress.done;
  }
  return { open, done, all: open + done };
}

/** Compact age for list rows: Now, 5m, 3h, Yesterday, Mon, Oct 26. */
export function shortAgo(iso, now = Date.now()) {
  const time = Date.parse(iso);
  if (!time) return '';
  const minutes = Math.round((now - time) / 60000);
  if (minutes < 1) return 'Now';
  if (minutes < 60) return `${minutes}m`;
  const then = new Date(time), today = new Date(now);
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(then.getFullYear(), then.getMonth(), then.getDate())) / 86400000);
  if (days <= 0) return `${Math.max(1, Math.round(minutes / 60))}h`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return then.toLocaleDateString('en-US', { weekday: 'short' });
  return then.toLocaleDateString('en-US', then.getFullYear() === today.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Edited 2 hours ago", "Edited yesterday", "Edited Oct 26". */
export function editedLabel(iso) {
  const label = relativeDate(iso);
  if (!label) return '';
  return `Edited ${/^[A-Z][a-z]{2} \d/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1)}`;
}

/** What the one-line composer saves: the typed line starts the body; the title names the page. */
export function pageNoteDraft(page, text = '') {
  const pageTitle = String(page?.title || '').replace(/\s+/g, ' ').trim();
  const line = String(text).trim();
  return { title: `Notes on ${pageTitle || domainOf(page?.url) || 'this page'}`, content: line ? `${line}\n` : '', url: page?.url || '' };
}

/* ------------------------------------------------------------------ derived data (memoized) */

let memoStamp = null;
const memo = new Map();
function cached(ctx, key, compute) {
  const stamp = ctx.library?.updatedAt ?? null;
  if (stamp !== memoStamp) { memoStamp = stamp; memo.clear(); }
  if (!memo.has(key)) memo.set(key, compute());
  return memo.get(key);
}
const derived = new Map();
function derive(key, compute) {
  if (derived.has(key)) return derived.get(key);
  const value = compute();
  derived.set(key, value);
  if (derived.size > 900) derived.delete(derived.keys().next().value);
  return value;
}

const notesState = ctx => (ctx.state.notes ||= { scope: 'all', collectionId: '', noteId: null, query: '', sort: 'updated' });
const pageUrl = ctx => (/^https?:/i.test(ctx.state.page?.url || '') ? ctx.state.page.url : '');
const allNotes = ctx => cached(ctx, 'notes:all', () => ctx.select.live().filter(item => item.type === 'note'));
const scopeNotes = (ctx, scope) => (scope === 'page' ? (pageUrl(ctx) ? ctx.select.notesForUrl(pageUrl(ctx)) : []) : allNotes(ctx));
const collectionMap = ctx => cached(ctx, 'collections', () => new Map(ctx.select.tree().map(row => [row.id, row])));

function noteInfo(note) {
  return derive(`info:${note.id}:${note.updatedAt}`, () => {
    const source = previewSource(note.content, note.title);
    return { preview: noteExcerpt(source, 160), firstLine: noteTitleFromContent(note.content), progress: taskProgress(note.content || '') };
  });
}
const noteName = note => displayTitle(note, noteInfo(note).firstLine);

function cardHtml(ctx, note, expanded) {
  const links = String(note.content || '').includes('[[') ? ctx.library?.updatedAt : '';
  return derive(`card:${note.id}:${note.updatedAt}:${expanded}:${links}`,
    () => renderMarkdown(previewSource(note.content, note.title), { interactiveTasks: true, compact: !expanded, resolveLink: noteResolver(ctx) }));
}

/** Collections that hold notes in this scope, most notes first (the current filter always included). */
function collectionsWithNotes(ctx, counts, selected) {
  const rows = [];
  for (const [id, n] of Object.entries(counts.byId)) { const collection = ctx.select.collection(id); if (collection) rows.push({ collection, count: n }); }
  if (selected && selected !== NO_COLLECTION && !counts.byId[selected] && ctx.select.collection(selected)) rows.push({ collection: ctx.select.collection(selected), count: 0 });
  return rows.sort((a, b) => b.count - a.count || a.collection.name.localeCompare(b.collection.name));
}

function defaultCollection(ctx) {
  const notes = notesState(ctx);
  const inNotes = ctx.env.isSidepanel ? ctx.state.sideTab === 'notes' : ctx.state.view === 'notes';
  return inNotes && notes.collectionId && notes.collectionId !== NO_COLLECTION && ctx.select.collection(notes.collectionId) ? notes.collectionId : '';
}

/* ------------------------------------------------------------------ creation */

/** Creates a note (store.saveItem with an excerpt) and, with open, shows it in this surface's editor. */
export async function createNote(ctx, { title = '', content = '', url = '', collectionId, relatedIds = [], open = true, focus } = {}) {
  const item = await createNoteItem(ctx, { title, content, url, collectionId: collectionId ?? defaultCollection(ctx), relatedIds });
  if (open) openNote(ctx, item.id, { focus: focus || (titleValue(item.title).trim() ? 'body' : 'title') });
  return item;
}

function templatePage(ctx) {
  const url = pageUrl(ctx);
  return url ? { url, title: ctx.state.page?.title || '' } : null;
}

async function createFromTemplate(ctx, id) {
  const now = new Date();
  const template = noteTemplates(now, { page: templatePage(ctx) }).find(entry => entry.id === id);
  if (!template) return null;
  if (template.id === 'daily') return openToday(ctx);
  return createNote(ctx, { title: template.title, content: template.content, url: template.url || '', focus: template.title ? 'body' : 'title' });
}

/** Opens today's daily note, creating it from the daily template in the default collection when missing. */
export async function openToday(ctx) {
  const now = new Date();
  const title = dailyNoteTitle(now);
  const existing = ctx.select.live().find(item => item.type === 'note' && item.title === title);
  if (existing) { openNote(ctx, existing.id); return existing; }
  const template = noteTemplates(now).find(entry => entry.id === 'daily');
  const fallback = ctx.library?.settings?.defaultCollectionId;
  return createNote(ctx, { title, content: template?.content || '', collectionId: fallback && ctx.select.collection(fallback) ? fallback : '', focus: 'body' });
}

function templateMenu(ctx) {
  const page = templatePage(ctx);
  return noteTemplates(new Date(), { page }).map(template => ({
    label: template.id === 'reading' && page ? 'Reading notes from this page' : template.label,
    icon: TEMPLATE_ICONS[template.id] || 'file',
    hint: template.id === 'daily' ? dailyNoteTitle(new Date()) : '',
    run: () => createFromTemplate(ctx, template.id),
  }));
}

async function toggleTaskIn(ctx, id, index, done) {
  const editor = editorFor(id);
  if (editor && editor.toggleTask(index, done)) return;
  const note = latestItem(ctx, id);
  if (!note) return;
  const content = toggleTask(note.content || '', index, done);
  if (content === note.content) return;
  try {
    rememberItem(await ctx.store.updateItem(id, { content, excerpt: noteExcerpt(content) }, { expectedUpdatedAt: note.updatedAt }));
  } catch (error) {
    if (!/^Conflict/i.test(error?.message || '')) throw error;
    ctx.toast('This note just changed. Try again.', { tone: 'warning' });
    ctx.render();
  }
}

/* ------------------------------------------------------------------ shared pieces */

const dot = color => html`<span class="note-dot" style="--dot:${color ? colorVar(color) : 'var(--fg-faint)'}" aria-hidden="true"></span>`;

function progressMarkup({ done, total }, { label = true } = {}) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return html`<span class="${cx('note-progress', done === total && 'is-complete')}" title="${done} of ${total} tasks done">
    <span class="note-progress-bar" aria-hidden="true"><span style="width:${pct}%"></span></span>${label ? html`<span class="note-progress-num">${done}/${total}</span>` : ''}
    <span class="sr-only">${done} of ${total} tasks done</span></span>`;
}

function noteCard(ctx, note, { clamp = 8, showPage = true, from = '' } = {}) {
  const expanded = expandedCards.has(note.id);
  const info = noteInfo(note);
  const collection = note.collectionId ? ctx.select.collection(note.collectionId) : null;
  const name = noteName(note);
  const reminder = note.reminderAt && !note.reminderNotifiedAt;
  // A note whose only line is its title (a one-line sticky note) has no body to preview.
  const body = !String(note.content || '').trim() ? html`<p class="note-card-empty">Empty note</p>`
    : previewSource(note.content, note.title).trim() ? raw(cardHtml(ctx, note, expanded)) : '';
  return html`<article class="${cx('note-card', expanded && 'is-expanded')}" data-key="nc:${from || 'notes'}:${note.id}" data-id="${note.id}" style="--clamp:${clamp}" aria-labelledby="nc-${from || 'n'}-${note.id}">
    <header class="note-card-head">
      <h3 class="note-card-title"><button type="button" class="note-card-open" id="nc-${from || 'n'}-${note.id}" data-action="notes.open" data-id="${note.id}" data-from="${from}">${name}</button></h3>
      ${note.pinned ? html`<span class="note-card-pin" title="Pinned">${icon('pin', { size: 14 })}<span class="sr-only">Pinned</span></span>` : ''}
      ${info.progress.total ? progressMarkup(info.progress) : ''}
    </header>
    <div class="note-card-body markdown-body is-compact" data-action="notes.card-body" data-change="notes.task-toggle" data-id="${note.id}" data-from="${from}">${body}</div>
    <button type="button" class="note-card-more" data-action="notes.card-expand" data-id="${note.id}" aria-expanded="${expanded ? 'true' : 'false'}" ${expanded ? '' : raw('hidden')}>${expanded ? 'Show less' : 'Show more'}</button>
    <footer class="note-card-foot">
      ${showPage && note.url ? html`<a class="note-card-page" href="${safeHref(note.url)}" target="_blank" rel="noopener noreferrer" title="${note.url}">${favicon(note.url, { size: 14 })}<span class="note-card-page-name">${domainOf(note.url)}</span></a>` : ''}
      ${collection ? html`<span class="note-card-collection" title="${collection.name}">${dot(collection.color)}<span class="note-card-collection-name">${collection.name}</span></span>` : ''}
      <span class="note-card-spacer"></span>
      ${reminder ? html`<span class="note-card-bell" title="Reminder set">${icon('bell', { size: 14 })}<span class="sr-only">Reminder set</span></span>` : ''}
      <time class="note-card-time" datetime="${note.updatedAt}">${editedLabel(note.updatedAt)}</time>
      ${iconButton({ icon: 'ellipsis', label: `Actions for ${name}`, action: 'notes.card-menu', data: { id: note.id, from }, size: 'sm', className: 'note-card-menu' })}
    </footer>
  </article>`;
}
const expandedCards = new Set();

// Shows "Show more" only on cards whose rendered preview is taller than the clamp (one read pass, then writes).
registerMount('notes.clamp', el => {
  const measure = () => {
    const reads = [...el.querySelectorAll('.note-card')].map(card => {
      const body = card.querySelector('.note-card-body');
      return { card, more: card.querySelector('.note-card-more'), expanded: card.classList.contains('is-expanded'), overflow: !!body && body.scrollHeight > body.clientHeight + 2 };
    });
    for (const { card, more, expanded, overflow } of reads) {
      if (expanded) continue;
      card.classList.toggle('is-clamped', overflow);
      if (more) more.hidden = !overflow;
    }
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  observer?.observe(el);
  measure();
  return { update: measure, destroy: () => observer?.disconnect() };
});

/* ------------------------------------------------------------------ full tab workspace */

/** Full tab Notes view: list column, editor, collapsible info rail. */
export function renderNotesWorkspace(ctx) {
  const s = notesState(ctx);
  const panel = ctx.state.panel;
  if (panel?.kind === 'item' && ctx.select.byId(panel.id)?.type === 'note') {
    // An opened note belongs in the workspace editor rather than in a second editor in the detail panel.
    s.noteId = panel.id;
    ctx.state.panel = null;
    ctx.syncUrl?.();
    ctx.render();
  }
  const all = allNotes(ctx);
  const counts = cached(ctx, 'counts:all', () => collectionCounts(all));
  const list = cached(ctx, `list:${s.collectionId}|${s.query}|${s.sort}`, () => filterNotes(all, { query: s.query, collectionId: s.collectionId, sort: s.sort, collections: collectionMap(ctx) }));
  let selected = s.noteId ? latestItem(ctx, s.noteId) : null;
  if (selected && (selected.type !== 'note' || selected.deletedAt)) selected = null;
  if (!selected && list.length) {
    selected = list[0];
    s.noteId = selected.id;
  }
  const railOpen = ctx.prefs.get('notesRail', true) !== false;
  return html`<div class="${cx('notes-ws', railOpen && selected && 'has-rail')}" data-key="notes-ws">
    ${renderListPane(ctx, { all, counts, list, selectedId: selected?.id || '' })}
    <section class="notes-editor-pane" aria-label="${selected ? `Editing ${noteName(selected)}` : 'Editor'}" data-key="notes-editor-pane">
      ${selected ? renderNoteEditor(ctx, selected.id, { surface: 'full' }) : renderEditorEmpty(ctx, all.length)}
    </section>
    ${selected ? renderRail(ctx, selected, railOpen) : ''}
  </div>`;
}

function renderListPane(ctx, { all, counts, list, selectedId }) {
  const s = notesState(ctx);
  const sortLabel = NOTE_SORTS.find(option => option.value === s.sort)?.label || NOTE_SORTS[0].label;
  const limit = listLimit;
  const pinned = list.filter(note => note.pinned);
  const rest = list.filter(note => !note.pinned);
  const shownRest = rest.slice(0, Math.max(0, limit - pinned.length));
  const filterName = s.collectionId === NO_COLLECTION ? 'No collection' : ctx.select.collection(s.collectionId)?.name || '';
  let body;
  if (!all.length) body = emptyState({ icon: 'sticky-note', title: 'No notes yet', body: 'Write what you learn while you browse. Notes can link to pages and to each other.', compact: true });
  else if (!list.length && s.query.trim()) body = emptyState({ icon: 'search', title: `No notes match “${s.query.trim()}”`, compact: true, actions: button({ label: 'Clear search', variant: 'secondary', size: 'sm', action: 'notes.clear-query' }) });
  else if (!list.length) body = emptyState({ icon: 'folder', title: `No notes in ${filterName || 'this collection'}`, compact: true, actions: button({ label: 'Show all notes', variant: 'secondary', size: 'sm', action: 'notes.filter', data: { collection: '' } }) });
  else {
    body = html`${pinned.length && rest.length ? html`<h2 class="notes-group-title">Pinned</h2>` : ''}
      ${pinned.length ? html`<ul class="notes-list" aria-label="Pinned notes">${pinned.map(note => noteRow(ctx, note, selectedId))}</ul>` : ''}
      ${pinned.length && rest.length ? html`<h2 class="notes-group-title">Notes</h2>` : ''}
      ${shownRest.length ? html`<ul class="notes-list" aria-label="Notes">${shownRest.map(note => noteRow(ctx, note, selectedId))}</ul>` : ''}
      ${rest.length > shownRest.length ? html`<div class="notes-more">${button({ label: `Show ${Math.min(PAGE_SIZE, rest.length - shownRest.length)} more`, variant: 'ghost', size: 'sm', action: 'notes.list-more' })}</div>` : ''}`;
  }
  return html`<section class="notes-list-pane" aria-labelledby="notes-heading" data-key="notes-list-pane">
    <header class="notes-pane-head">
      <h1 class="notes-heading" id="notes-heading">Notes</h1><span class="notes-heading-count">${all.length.toLocaleString()}</span>
      <span class="notes-spacer"></span>
      ${iconButton({ icon: 'calendar-days', label: `Today’s note (${dailyNoteTitle(new Date())})`, action: 'notes.today', size: 'sm', variant: 'ghost' })}
      <div class="split-btn split-btn-primary split-btn-sm notes-new" role="group" aria-label="New note">
        <button type="button" class="btn btn-primary btn-sm split-btn-main" data-action="notes.new" aria-keyshortcuts="N" data-tooltip="New note (N)">${icon('square-pen', { size: 14 })}<span class="btn-label">New note</span></button>
        <button type="button" class="btn btn-primary btn-sm split-btn-menu" data-action="notes.templates" aria-label="New note from a template" aria-haspopup="menu" aria-expanded="false" data-tooltip="Templates">${icon('chevron-down', { size: 14 })}</button>
      </div>
    </header>
    <div class="notes-pane-tools">
      ${searchField({ value: s.query, placeholder: 'Search notes', action: 'notes.query', keydown: 'notes.search-key', id: 'notes-search', label: 'Search notes', clearAction: 'notes.clear-query' })}
      ${all.length ? renderChips(ctx, counts) : ''}
      ${all.length ? html`<div class="notes-sortbar"><span class="notes-sortbar-count">${list.length === all.length ? `${list.length.toLocaleString()} ${list.length === 1 ? 'note' : 'notes'}` : `${list.length.toLocaleString()} of ${all.length.toLocaleString()}`}</span>
        ${button({ label: sortLabel, icon: 'arrow-up-down', variant: 'ghost', size: 'sm', action: 'notes.sort-menu', className: 'notes-sort', attrs: { 'aria-haspopup': 'menu', 'aria-label': `Sort notes: ${sortLabel}` } })}</div>` : ''}
    </div>
    <div class="notes-scroll" data-keydown="notes.list-key">${body}</div>
  </section>`;
}

let listLimit = PAGE_SIZE;

function renderChips(ctx, counts) {
  const s = notesState(ctx);
  const rows = collectionsWithNotes(ctx, counts, s.collectionId);
  const visible = rows.slice(0, 4);
  const selectedHidden = s.collectionId && s.collectionId !== NO_COLLECTION && !visible.some(row => row.collection.id === s.collectionId);
  if (selectedHidden) visible.push(rows.find(row => row.collection.id === s.collectionId));
  const hidden = rows.length - visible.length;
  const chipButton = (value, label, n, color, selected) => html`<button type="button" class="${cx('notes-chip', selected && 'is-selected')}" data-action="notes.filter" data-collection="${value}" aria-pressed="${selected ? 'true' : 'false'}">
    ${color === undefined ? '' : color === null ? icon('inbox', { size: 12 }) : dot(color)}<span class="notes-chip-label">${label}</span><span class="notes-chip-count">${n}</span></button>`;
  return html`<div class="notes-chips" role="group" aria-label="Filter by collection">
    ${chipButton('', 'All', counts.total, undefined, !s.collectionId)}
    ${visible.filter(Boolean).map(({ collection, count: n }) => chipButton(collection.id, collection.name, n, collection.color, s.collectionId === collection.id))}
    ${counts.none && counts.none !== counts.total ? chipButton(NO_COLLECTION, 'No collection', counts.none, null, s.collectionId === NO_COLLECTION) : ''}
    ${hidden > 0 ? html`<button type="button" class="notes-chip is-more" data-action="notes.filter-menu" aria-haspopup="menu" aria-expanded="false">${hidden} more${icon('chevron-down', { size: 12 })}</button>` : ''}
  </div>`;
}

function noteRow(ctx, note, selectedId) {
  const info = noteInfo(note);
  const collection = note.collectionId ? ctx.select.collection(note.collectionId) : null;
  const selected = note.id === selectedId;
  const reminder = note.reminderAt && !note.reminderNotifiedAt;
  const meta = [
    collection ? html`<span class="notes-meta-item">${dot(collection.color)}<span class="notes-meta-text">${collection.name}</span></span>` : '',
    note.url ? html`<span class="notes-meta-item">${favicon(note.url, { size: 12 })}<span class="notes-meta-text">${domainOf(note.url)}</span></span>` : '',
    info.progress.total ? html`<span class="${cx('notes-meta-item', 'notes-meta-tasks', info.progress.done === info.progress.total && 'is-complete')}" title="${info.progress.done} of ${info.progress.total} tasks done">${icon('list-checks', { size: 12 })}${info.progress.done}/${info.progress.total}</span>` : '',
    reminder ? html`<span class="notes-meta-item" title="Reminder set">${icon('bell', { size: 12 })}<span class="sr-only">Reminder set</span></span>` : '',
    note.sticky ? html`<span class="notes-meta-item" title="Sticky note">${icon('sticker', { size: 12 })}<span class="sr-only">Sticky note</span></span>` : '',
  ].filter(part => String(part));
  return html`<li data-key="nr:${note.id}"><button type="button" class="${cx('notes-row', selected && 'is-selected')}" data-action="notes.open" data-id="${note.id}" aria-current="${selected ? 'true' : 'false'}">
    <span class="notes-row-top">${note.pinned ? icon('pin', { size: 12, className: 'notes-row-pin' }) : ''}<span class="notes-row-title">${noteName(note)}</span><time class="notes-row-time" datetime="${note.updatedAt}" title="${shortDate(note.updatedAt)}">${shortAgo(note.updatedAt)}</time></span>
    ${info.preview || !String(note.content || '').trim() ? html`<span class="${cx('notes-row-preview', !info.preview && 'is-empty')}">${info.preview || 'No text yet'}</span>` : ''}
    ${meta.length ? html`<span class="notes-row-meta">${meta}</span>` : ''}
  </button></li>`;
}

function renderEditorEmpty(ctx, total) {
  return html`<div class="notes-editor-empty">${emptyState({
    icon: 'notebook-pen',
    title: total ? 'Select a note' : 'Start your first note',
    body: total ? 'Pick a note from the list, or start a new one.' : 'Notes support headings, checklists, tables and [[links]] to other notes.',
    actions: html`${button({ label: 'New note', icon: 'square-pen', variant: 'primary', size: 'sm', action: 'notes.new' })}${button({ label: 'Today’s note', icon: 'calendar-days', variant: 'secondary', size: 'sm', action: 'notes.today' })}`,
  })}</div>`;
}

function railSection(id, title, content, countValue) {
  return html`<section class="notes-rail-section" aria-labelledby="rail-${id}"><h3 class="notes-rail-title" id="rail-${id}">${title}${countValue ? html`<span class="notes-rail-count">${countValue}</span>` : ''}</h3>${content}</section>`;
}

function renderRail(ctx, note, open) {
  if (!open) {
    return html`<aside class="notes-rail is-collapsed" aria-label="Note info" data-key="notes-rail">${iconButton({ icon: 'panel-right-open', label: 'Show note info', action: 'notes.rail', size: 'sm', tooltipPlacement: 'bottom end' })}</aside>`;
  }
  const content = note.content || '';
  const headings = derive(`outline:${note.id}:${note.updatedAt}`, () => outline(content));
  const tasks = derive(`tasks:${note.id}:${note.updatedAt}`, () => extractTasks(content));
  const done = tasks.filter(task => task.done).length;
  const backlinks = ctx.select.backlinks(note.id).filter(entry => !entry.deletedAt);
  const outgoing = (note.relatedIds || []).map(id => ctx.select.byId(id)).filter(entry => entry && !entry.deletedAt);
  const saved = note.url ? ctx.select.savedForUrl(note.url) : null;
  const words = derive(`words:${note.id}:${note.updatedAt}`, () => wordCount(content));
  const seen = new Map();
  const minLevel = headings.reduce((min, entry) => Math.min(min, entry.level), 3);
  const outlineList = headings.length
    ? html`<ol class="notes-outline">${headings.map(entry => {
      const nth = seen.get(entry.text) || 0;
      seen.set(entry.text, nth + 1);
      return html`<li><button type="button" class="notes-outline-item" style="--level:${entry.level - minLevel}" data-level="${entry.level - minLevel}" data-action="notes.outline" data-id="${note.id}" data-text="${entry.text}" data-nth="${nth}">${entry.text}</button></li>`;
    })}</ol>`
    : html`<p class="notes-rail-hint">Headings you add appear here.</p>`;
  const linkRow = entry => html`<li><button type="button" class="notes-rail-link" data-action="notes.open-linked" data-id="${entry.id}">
    ${entry.type === 'note' ? icon('sticky-note', { size: 14, className: 'notes-rail-link-icon' }) : favicon(entry.url, { size: 14 })}<span class="notes-rail-link-title">${noteName(entry)}</span></button></li>`;
  return html`<aside class="notes-rail" aria-label="Note info" data-key="notes-rail">
    <header class="notes-rail-head"><h2 class="notes-rail-heading">Info</h2>${iconButton({ icon: 'panel-right', label: 'Hide note info', action: 'notes.rail', size: 'sm', tooltipPlacement: 'bottom end' })}</header>
    <div class="notes-rail-scroll">
      ${note.url ? railSection('page', 'Linked page', html`<div class="notes-rail-page">
        ${favicon(note.url, { size: 16 })}<div class="notes-rail-page-text"><span class="notes-rail-page-title">${saved?.title || domainOf(note.url)}</span><span class="notes-rail-page-url">${domainOf(note.url)}</span></div></div>
        <div class="notes-rail-actions">${button({ label: 'Open page', icon: 'external-link', variant: 'ghost', size: 'sm', action: 'app.open-url', data: { url: note.url } })}
          ${saved ? button({ label: 'Saved item', icon: 'bookmark', variant: 'ghost', size: 'sm', action: 'app.open-item', data: { id: saved.id } }) : ''}</div>`) : ''}
      ${railSection('outline', 'Outline', outlineList)}
      ${tasks.length ? railSection('tasks', 'Tasks', html`<div class="notes-rail-progress">${progressMarkup({ done, total: tasks.length }, { label: false })}<span>${done} of ${tasks.length} done</span></div>
        <ul class="task-list is-rail">${tasks.filter(task => !task.done).slice(0, 8).map(task => taskRow(ctx, note, task))}</ul>
        ${tasks.length - done > 8 ? button({ label: `All ${tasks.length - done} open tasks`, variant: 'ghost', size: 'sm', action: 'app.navigate', data: { view: 'tasks' } }) : ''}`) : ''}
      ${railSection('backlinks', 'Linked from', backlinks.length ? html`<ul class="notes-rail-links">${backlinks.slice(0, 12).map(linkRow)}</ul>` : html`<p class="notes-rail-hint">Link this note from another with [[${noteName(note)}]].</p>`, backlinks.length)}
      ${outgoing.length ? railSection('outgoing', 'Links to', html`<ul class="notes-rail-links">${outgoing.slice(0, 12).map(linkRow)}</ul>`, outgoing.length) : ''}
      ${railSection('details', 'Details', html`<dl class="notes-rail-details">
        <div><dt>Created</dt><dd>${shortDate(note.createdAt)}</dd></div><div><dt>Edited</dt><dd>${relativeDate(note.updatedAt)}</dd></div><div><dt>Words</dt><dd>${words.toLocaleString()}</dd></div></dl>`)}
    </div>
  </aside>`;
}

/* ------------------------------------------------------------------ tasks view */

function taskRow(ctx, note, task) {
  return html`<li class="${cx('task-row', task.done && 'is-done')}" data-key="t:${note.id}:${task.index}" style="--indent:${task.indent || 0}">
    <label class="task-check"><input type="checkbox" data-change="notes.task-toggle" data-id="${note.id}" data-index="${task.index}" ${task.done ? raw('checked') : ''} aria-label="${task.plain || 'Task'}">
      <span class="task-box" aria-hidden="true">${icon('check', { size: 12, strokeWidth: 3 })}</span></label>
    <span class="task-text">${raw(renderInline(task.text, { resolveLink: noteResolver(ctx) }))}</span>
  </li>`;
}

/** Tasks across all notes, grouped by note (Open / Done / All). */
export function renderTasks(ctx) {
  const s = notesState(ctx);
  const filter = ['open', 'done', 'all'].includes(s.taskFilter) ? s.taskFilter : 'open';
  const notes = allNotes(ctx);
  const totals = cached(ctx, 'tasks:totals', () => taskTotals(notes));
  const groups = cached(ctx, `tasks:${filter}`, () => groupTasks(notes, filter));
  const shown = groups.slice(0, tasksLimit);
  let body;
  if (!totals.all) body = emptyState({ icon: 'list-todo', title: 'No tasks yet', body: 'Add a checklist to any note with [ ] or the Checklist button. Every task shows up here.', actions: button({ label: 'Open notes', icon: 'sticky-note', variant: 'secondary', size: 'sm', action: 'app.navigate', data: { view: 'notes' } }) });
  else if (!groups.length) body = emptyState({ icon: filter === 'open' ? 'circle-check' : 'list-todo', title: filter === 'open' ? 'All tasks are done' : 'Nothing done yet', body: filter === 'open' ? 'Completed tasks stay in their notes.' : 'Check off a task and it moves here.',
    actions: button({ label: filter === 'open' ? 'Show done' : 'Show open', variant: 'secondary', size: 'sm', action: 'notes.task-filter', data: { value: filter === 'open' ? 'done' : 'open' } }) });
  else body = html`${shown.map(group => taskGroup(ctx, group))}${groups.length > shown.length ? html`<div class="notes-more">${button({ label: `Show ${Math.min(50, groups.length - shown.length)} more notes`, variant: 'ghost', size: 'sm', action: 'notes.tasks-more' })}</div>` : ''}`;
  return html`<div class="tasks-view" data-key="tasks-view">
    <header class="tasks-head"><div class="tasks-head-inner">
      <div class="tasks-title-row"><h1 class="tasks-title">Tasks</h1><span class="tasks-subtitle">${totals.open.toLocaleString()} open · ${totals.done.toLocaleString()} done</span></div>
      ${segmented({ name: 'task-filter', value: filter, size: 'sm', action: 'notes.task-filter', ariaLabel: 'Show tasks',
        options: [{ value: 'open', label: 'Open', count: totals.open }, { value: 'done', label: 'Done', count: totals.done }, { value: 'all', label: 'All', count: totals.all }] })}
    </div></header>
    <div class="tasks-body">${body}</div>
  </div>`;
}
let tasksLimit = 50;

function taskGroup(ctx, { note, tasks, done, total }) {
  const collection = note.collectionId ? ctx.select.collection(note.collectionId) : null;
  return html`<section class="task-group" data-key="tg:${note.id}" aria-labelledby="tg-${note.id}">
    <header class="task-group-head">
      <h2 class="task-group-title"><button type="button" class="task-group-open" id="tg-${note.id}" data-action="notes.open" data-id="${note.id}">${noteName(note)}</button></h2>
      <span class="task-group-meta">${collection ? html`<span class="notes-meta-item">${dot(collection.color)}<span class="notes-meta-text">${collection.name}</span></span>` : ''}
        ${note.url ? html`<span class="notes-meta-item">${favicon(note.url, { size: 12 })}<span class="notes-meta-text">${domainOf(note.url)}</span></span>` : ''}
        <span class="notes-meta-item">${editedLabel(note.updatedAt)}</span></span>
      ${progressMarkup({ done, total })}
    </header>
    <ul class="task-list">${tasks.map(task => taskRow(ctx, note, task))}</ul>
  </section>`;
}

/* ------------------------------------------------------------------ side panel */

/** Side panel Notes tab: the card list (This page | All notes) or, with a note open, the editor screen. */
export function renderSideNotes(ctx) {
  const s = notesState(ctx);
  if (s.noteId) return renderSideEditor(ctx, s.noteId);
  return renderSideList(ctx);
}

function renderSideEditor(ctx, id) {
  const s = notesState(ctx);
  const note = latestItem(ctx, id);
  const collection = note?.collectionId ? ctx.select.collection(note.collectionId) : null;
  const back = s.returnTo === 'page' ? 'Back to This page' : 'Back to notes';
  return html`<div class="side-note" data-key="side-note:${id}">
    <header class="side-note-head">
      ${iconButton({ icon: 'arrow-left', label: back, action: 'notes.back', tooltipPlacement: 'bottom start' })}
      <span class="side-note-crumb">${collection ? html`${dot(collection.color)}<span class="side-note-crumb-text">${collection.name}</span>` : html`<span class="side-note-crumb-text">${s.returnTo === 'page' ? 'This page' : 'Notes'}</span>`}</span>
      <span class="notes-spacer"></span>
      ${iconButton({ icon: 'maximize-2', label: 'Open in full tab', action: 'notes.open-full', data: { id }, tooltipPlacement: 'bottom end' })}
    </header>
    ${renderNoteEditor(ctx, id, { surface: 'side' })}
  </div>`;
}

function renderSideList(ctx) {
  const s = notesState(ctx);
  const url = pageUrl(ctx);
  const scope = s.scope === 'page' ? 'page' : 'all';
  const all = allNotes(ctx);
  const pageNotes = url ? ctx.select.notesForUrl(url) : [];
  const notes = scope === 'page' ? pageNotes : all;
  const counts = collectionCounts(notes);
  const list = filterNotes(notes, { query: s.query, collectionId: s.collectionId, sort: s.sort, collections: collectionMap(ctx) });
  const shown = list.slice(0, listLimit);
  const filterName = !s.collectionId ? 'All collections' : s.collectionId === NO_COLLECTION ? 'No collection' : ctx.select.collection(s.collectionId)?.name || 'All collections';
  const filterColor = s.collectionId && s.collectionId !== NO_COLLECTION ? ctx.select.collection(s.collectionId)?.color : '';
  let body;
  if (scope === 'page' && !url) body = emptyState({ icon: 'globe', title: 'Open a web page', body: 'Notes you write about a page show up here whenever you visit it again.', compact: true });
  else if (scope === 'page' && !pageNotes.length) body = emptyState({ icon: 'notebook-pen', title: 'No notes on this page', body: 'Write down what you want to remember about it.', compact: true,
    actions: button({ label: 'Write a note about this page', icon: 'pen-line', variant: 'primary', size: 'sm', action: 'notes.write-page' }) });
  else if (!all.length) body = emptyState({ icon: 'sticky-note', title: 'No notes yet', body: 'Write what you learn while you browse. Notes can link to pages and to each other.', compact: true,
    actions: button({ label: 'New note', icon: 'square-pen', variant: 'primary', size: 'sm', action: 'notes.new' }) });
  else if (!list.length && s.query.trim()) body = emptyState({ icon: 'search', title: `No notes match “${s.query.trim()}”`, compact: true, actions: button({ label: 'Clear search', variant: 'secondary', size: 'sm', action: 'notes.clear-query' }) });
  else if (!list.length) body = emptyState({ icon: 'folder', title: `No notes in ${filterName}`, compact: true, actions: button({ label: 'Show all collections', variant: 'secondary', size: 'sm', action: 'notes.filter', data: { collection: '' } }) });
  else body = html`<div class="side-notes-list" data-mount="notes.clamp" data-key="side-notes-list">${shown.map(note => noteCard(ctx, note, { clamp: 8, showPage: scope !== 'page' }))}</div>
    ${list.length > shown.length ? html`<div class="notes-more">${button({ label: `Show ${Math.min(PAGE_SIZE, list.length - shown.length)} more`, variant: 'ghost', size: 'sm', action: 'notes.list-more' })}</div>` : ''}`;
  const popOpen = ctx.state.popover?.name === 'notes.collections';
  return html`<div class="side-notes" data-key="side-notes">
    <div class="side-notes-top">
      ${segmented({ name: 'notes-scope', value: scope, action: 'notes.scope', ariaLabel: 'Show notes', className: 'is-block side-notes-scope',
        options: [{ value: 'page', label: 'This page', icon: 'app-window', count: url ? pageNotes.length : undefined }, { value: 'all', label: 'All notes', icon: 'layers', count: all.length }] })}
      <div class="side-notes-tools">
        <button type="button" class="side-notes-filter" data-action="notes.filter-menu" aria-haspopup="menu" aria-expanded="${popOpen ? 'true' : 'false'}" aria-label="Collection: ${filterName}. Change">
          ${s.collectionId === NO_COLLECTION ? icon('inbox', { size: 14 }) : s.collectionId ? dot(filterColor) : icon('layers', { size: 14 })}<span class="side-notes-filter-label">${filterName}</span>${icon('chevron-down', { size: 14, className: 'side-notes-filter-chevron' })}</button>
        ${searchField({ value: s.query, placeholder: 'Search', action: 'notes.query', keydown: 'notes.search-key', id: 'notes-search', label: 'Search notes', clearAction: 'notes.clear-query', className: 'side-notes-search' })}
        ${iconButton({ icon: 'sticker', label: 'Sticky notes', action: 'app.open-view', data: { view: 'stickies' }, tooltipPlacement: 'bottom end' })}
      </div>
    </div>
    <div class="side-notes-body">${body}</div>
    ${scope === 'page' && !url ? '' : html`<div class="notes-fab-wrap"><button type="button" class="btn btn-primary notes-fab" data-action="notes.fab" aria-keyshortcuts="N">${icon('plus', { size: 16 })}<span class="btn-label">${scope === 'page' ? 'Note on this page' : 'New note'}</span></button></div>`}
  </div>`;
}

function renderCollectionMenu(ctx) {
  const s = notesState(ctx);
  const scope = s.scope === 'page' && !ctx.env.isSidepanel ? 'all' : s.scope;
  const counts = collectionCounts(scopeNotes(ctx, ctx.env.isSidepanel ? scope : 'all'));
  const rows = collectionsWithNotes(ctx, counts, s.collectionId);
  const item = (value, label, n, lead) => html`<button type="button" class="menu-item notes-menu-item" role="menuitemradio" aria-checked="${s.collectionId === value ? 'true' : 'false'}" tabindex="-1"
    data-action="notes.filter-pick" data-collection="${value}">${lead}<span class="menu-label">${label}</span><span class="menu-hint">${n}</span>${s.collectionId === value ? icon('check', { size: 14, className: 'notes-menu-check' }) : ''}</button>`;
  return html`<div class="menu notes-collection-menu" role="menu" aria-label="Filter by collection">
    ${item('', 'All collections', counts.total, icon('layers', { size: 16 }))}
    ${rows.length ? html`<div class="menu-separator" role="separator"></div>` : ''}
    ${rows.map(({ collection, count: n }) => item(collection.id, collection.name, n, html`<span class="notes-menu-dot">${dot(collection.color)}</span>`))}
    ${counts.none ? html`<div class="menu-separator" role="separator"></div>${item(NO_COLLECTION, 'No collection', counts.none, icon('inbox', { size: 16 }))}` : ''}
  </div>`;
}
registerPopover('notes.collections', renderCollectionMenu, { role: 'menu', className: 'popover-menu notes-collection-popover' });

/* ------------------------------------------------------------------ This page tab */

/** Notes about `url` for the side panel This page tab: compact cards and a one-line composer. */
export function renderPageNotes(ctx, url) {
  const notes = url ? ctx.select.notesForUrl(url) : [];
  return html`<div class="page-notes" data-key="page-notes">
    ${notes.length ? html`<div class="page-notes-list" data-mount="notes.clamp" data-key="page-notes-list">${notes.slice(0, 20).map(note => noteCard(ctx, note, { clamp: 6, showPage: false, from: 'page' }))}</div>` : ''}
    ${url ? html`<form class="note-composer" data-submit="notes.compose" data-url="${url}" data-key="note-composer">
      ${icon('pen-line', { size: 16, className: 'note-composer-icon' })}
      <input class="note-composer-input" name="text" type="text" id="note-composer-input" data-focus-key="note-composer-input" placeholder="Write a note about this page…"
        aria-label="Write a note about this page" autocomplete="off" enterkeyhint="send" maxlength="2000">
      <button type="submit" class="icon-btn icon-btn-sm note-composer-send" aria-label="Create note" data-tooltip="Create note (Enter)">${icon('arrow-up', { size: 16 })}</button>
    </form>` : ''}
  </div>`;
}

/* ------------------------------------------------------------------ card menu */

function openCardMenu(ctx, anchor, id, from) {
  const note = latestItem(ctx, id);
  if (!note) return;
  const page = pageUrl(ctx);
  ctx.openMenu(anchor, [
    { label: 'Open', icon: 'square-pen', run: () => openNote(ctx, id, { from }) },
    { label: note.pinned ? 'Unpin' : 'Pin to top', icon: note.pinned ? 'pin-off' : 'pin', run: async () => rememberItem(await ctx.store.updateItem(id, { pinned: !note.pinned })) },
    { label: 'Move to…', icon: 'folder-input', run: () => moveNote(ctx, anchor, note) },
    { label: note.reminderAt && !note.reminderNotifiedAt ? 'Change reminder' : 'Remind me', icon: 'bell', run: () => ctx.openPopover('pick.reminder', anchor, {
      value: note.reminderAt || null,
      onPick: async iso => { rememberItem(await ctx.store.updateItem(id, { reminderAt: iso || null })); if (iso) ctx.toast('Reminder set', { tone: 'success' }); },
    }, { placement: 'bottom-end' }) },
    ...(!note.url && page ? [{ label: 'Link to this page', icon: 'link', run: async () => rememberItem(await ctx.store.updateItem(id, { url: page })) }] : []),
    { label: 'Copy as Markdown', icon: 'copy', run: async () => { await navigator.clipboard.writeText(note.content || ''); ctx.toast('Copied as Markdown'); } },
    ...(ctx.env.isSidepanel ? [{ label: 'Open in full tab', icon: 'external-link', run: () => openInFullTab(ctx, id) }] : []),
    { separator: true },
    { label: 'Move to Trash', icon: 'trash-2', danger: true, run: async () => {
      // "Confirm before moving items to Trash" (Settings > General) asks first, as library.js trashItems does.
      if (ctx.library?.settings?.confirmDelete === true && !(await ctx.confirm({ title: `Move “${noteName(note)}” to Trash?`,
        body: 'You can restore items from Trash until you empty it.', confirmLabel: 'Move to Trash' }))) return;
      rememberItem(await ctx.store.deleteItem(id));
      ctx.toast('Moved to Trash', { action: { label: 'Undo', run: async () => rememberItem(await ctx.store.restoreItem(id)) } });
    } },
  ], { label: `Actions for ${noteName(note)}`, placement: 'bottom-end' });
}

function moveNote(ctx, anchor, note) {
  const onPick = async id => {
    const saved = rememberItem(await ctx.store.updateItem(note.id, { collectionId: id || '' }));
    if (id) ctx.prefs.touchCollection?.(id);
    ctx.toast(`Moved to ${ctx.select.collection(saved.collectionId)?.name || 'Inbox'}`, { tone: 'success' });
  };
  if (typeof pickers.openCollectionPicker === 'function') { pickers.openCollectionPicker(ctx, anchor, { value: note.collectionId || '', onPick, allowInbox: true, allowCreate: true }); return; }
  ctx.openMenu(anchor, [{ label: 'Inbox', icon: 'inbox', run: () => onPick('') }, ...ctx.select.tree().map(c => ({ label: `${'  '.repeat(c.depth)}${c.name}`, icon: 'folder', run: () => onPick(c.id) }))],
    { label: 'Move to', placement: 'bottom-end' });
}

/* ------------------------------------------------------------------ actions */

let queryTimer = 0;
function setQuery(ctx, value) {
  const s = notesState(ctx);
  s.query = value;
  listLimit = PAGE_SIZE;
  ctx.render();
}

registerActions({
  'notes.open': ({ ctx, data }) => openNote(ctx, data.id, { from: data.from || '' }),
  'notes.open-linked': ({ ctx, data }) => {
    const target = ctx.select.byId(data.id);
    if (target?.type === 'note') openNote(ctx, target.id); else if (target) ctx.openItem(target.id);
  },
  'notes.back': ({ ctx }) => closeNote(ctx),
  'notes.open-full': ({ ctx, data }) => openInFullTab(ctx, data.id),
  'notes.new': ({ ctx }) => createNote(ctx, {}),
  'notes.templates': ({ ctx, el }) => ctx.openMenu(el, templateMenu(ctx), { label: 'New from template', placement: 'bottom-end' }),
  'notes.today': ({ ctx }) => openToday(ctx),
  'notes.query': ({ ctx, el }) => {
    clearTimeout(queryTimer);
    const value = el.value;
    queryTimer = setTimeout(() => setQuery(ctx, value), 120);
  },
  'notes.clear-query': ({ ctx }) => {
    clearTimeout(queryTimer);
    setQuery(ctx, '');
    ctx.nextFrame(() => document.getElementById('notes-search')?.focus({ preventScroll: true }));
  },
  'notes.search-key': ({ ctx, el, event }) => {
    if (event.key !== 'Escape' || !el.value) return;
    event.preventDefault();
    event.stopPropagation();
    el.value = '';
    clearTimeout(queryTimer);
    setQuery(ctx, '');
  },
  'notes.filter': ({ ctx, data }) => { notesState(ctx).collectionId = data.collection || ''; listLimit = PAGE_SIZE; ctx.render(); },
  'notes.filter-menu': ({ ctx, el }) => ctx.openPopover('notes.collections', el, {}, { placement: ctx.env.isSidepanel ? 'bottom-start' : 'bottom-end' }),
  'notes.filter-pick': ({ ctx, data }) => {
    notesState(ctx).collectionId = data.collection || '';
    listLimit = PAGE_SIZE;
    ctx.closePopover();
  },
  'notes.sort-menu': ({ ctx, el }) => ctx.openMenu(el, NOTE_SORTS.map(option => ({
    label: option.label, checked: notesState(ctx).sort === option.value, run: () => { notesState(ctx).sort = option.value; ctx.render(); },
  })), { label: 'Sort notes', placement: 'bottom-end' }),
  'notes.scope': ({ ctx, data }) => {
    const s = notesState(ctx);
    s.scope = data.value === 'page' ? 'page' : 'all';
    listLimit = PAGE_SIZE;
    ctx.render();
  },
  'notes.list-more': ({ ctx }) => { listLimit += PAGE_SIZE; ctx.render(); },
  'notes.tasks-more': ({ ctx }) => { tasksLimit += 50; ctx.render(); },
  'notes.list-key': ({ ctx, el, event }) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.altKey || event.metaKey || event.ctrlKey) return;
    const rows = [...el.querySelectorAll('.notes-row')];
    const index = rows.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    rows[next].focus();
    rows[next].scrollIntoView({ block: 'nearest' });
    openNote(ctx, rows[next].dataset.id);
  },
  'notes.rail': ({ ctx }) => { ctx.prefs.set('notesRail', ctx.prefs.get('notesRail', true) === false); ctx.render(); },
  'notes.outline': ({ data }) => editorFor(data.id)?.scrollToHeading(data.text, Number(data.nth) || 0),
  'notes.card-body': ({ ctx, data, event }) => {
    const target = event?.target;
    const link = target?.closest?.('a.note-link[data-id]');
    if (link) { event.preventDefault(); const linked = ctx.select.byId(link.dataset.id); if (linked?.type === 'note') openNote(ctx, linked.id); else if (linked) ctx.openItem(linked.id); return; }
    if (target?.closest?.('a[href], input, button, summary, label, .note-link')) return;
    if (String(globalThis.getSelection?.() || '').trim()) return;
    openNote(ctx, data.id, { from: data.from || '' });
  },
  'notes.card-expand': ({ ctx, data }) => {
    if (expandedCards.has(data.id)) expandedCards.delete(data.id); else expandedCards.add(data.id);
    ctx.render();
  },
  'notes.card-menu': ({ ctx, el, data }) => openCardMenu(ctx, el, data.id, data.from || ''),
  'notes.task-toggle': ({ ctx, el, event }) => {
    const box = event?.target?.matches?.('input[type="checkbox"]') ? event.target : el;
    const id = box.dataset.id || el.dataset.id;
    const index = Number(box.dataset.taskIndex ?? box.dataset.index);
    if (!id || !Number.isInteger(index)) return undefined;
    return toggleTaskIn(ctx, id, index, box.checked);
  },
  'notes.task-filter': ({ ctx, data }) => { notesState(ctx).taskFilter = data.value; tasksLimit = 50; ctx.render(); },
  'notes.fab': ({ ctx }) => {
    const s = notesState(ctx);
    const url = pageUrl(ctx);
    if (s.scope === 'page' && url) return createPageNote(ctx, '');
    return createNote(ctx, {});
  },
  'notes.write-page': ({ ctx }) => createPageNote(ctx, ''),
  'notes.compose': async ({ ctx, el }) => {
    const input = el.querySelector('input[name="text"]');
    const text = input?.value || '';
    await createPageNote(ctx, text, el.dataset.url);
    if (input) input.value = '';
  },
});

/** A note linked to the current page (title "Notes on …"), in the saved item's collection, opened in the side editor. */
async function createPageNote(ctx, text, url = pageUrl(ctx)) {
  if (!url) return null;
  const page = ctx.state.page?.url === url ? ctx.state.page : { url, title: '' };
  const saved = ctx.select.savedForUrl(url);
  const draft = pageNoteDraft({ url, title: page.title || saved?.title || '' }, text);
  return createNote(ctx, { ...draft, collectionId: saved?.collectionId ?? defaultCollection(ctx), relatedIds: saved ? [saved.id] : [], focus: 'body' });
}

/* ------------------------------------------------------------------ init */

let initialized = false;
/** Side panel: Alt+Shift+N in the background creates a page note and asks this panel to open it. */
export async function init(ctx) {
  if (initialized || !ctx.env.isSidepanel || !ctx.env.isExtension) return;
  initialized = true;
  const api = globalThis.chrome;
  if (!api?.runtime?.onMessage) return;
  const seen = new Set();
  let windowId = Number.isInteger(ctx.state.windowId) ? ctx.state.windowId : null;
  if (windowId == null) { try { windowId = (await api.windows?.getCurrent?.())?.id ?? null; } catch { windowId = null; } }
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'still:open-note' || typeof message.id !== 'string') return undefined;
    if (sender?.id && sender.id !== api.runtime.id) return undefined;
    if (windowId != null && Number.isInteger(message.windowId) && message.windowId !== windowId) return undefined;
    if (message.requestId) {
      if (seen.has(message.requestId)) { sendResponse({ ok: true }); return undefined; }
      seen.add(message.requestId);
    }
    openNote(ctx, message.id, { focus: 'body' });
    sendResponse({ ok: true });
    return undefined;
  });
}

