// Library glue shared by the Notes and Checklist widgets: serialized note writes, optimistic task state, opening notes
// from the dashboard, and small pieces of markup both widgets use.
import { html, cx } from '../../html.js';
import { icon, registerIcons } from '../../icons.js';
import { collectionIcon } from '../../components.js';
import { customIcon } from '../../item-media.js';
import { latestItem, rememberItem, openNote, createNoteItem, displayTitle } from '../../note-editor.js';
import { noteExcerpt, noteTitleFromContent, toggleTask, extractTasks } from '../../../lib/notes.js';
import { excerptSource } from './model.js';
import { updateWidgetConfig } from '../../../lib/dashboard-store.js';

// Lucide glyphs (ISC) these widgets use that ui/icons.js does not inline.
registerIcons({
  eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
});

/* ------------------------------------------------------------------ writes */

const queues = new Map();
/**
 * Rewrites a note's Markdown: transform(content, note) returns the next content, or null to leave it. Writes to one
 * note run one after another and each starts from the newest copy, so quick successive checks never conflict with
 * each other. A change made elsewhere in the meantime is reported instead of overwritten. Resolves to
 * { before, after, item } or null when nothing changed.
 */
export function editNoteContent(ctx, id, transform) {
  const run = (queues.get(id) || Promise.resolve()).then(async () => {
    const note = latestItem(ctx, id);
    if (!note || note.deletedAt) throw new Error('This note is no longer in your library.');
    const before = note.content || '';
    const after = transform(before, note);
    if (after == null || after === before) return null;
    try {
      const item = rememberItem(await ctx.store.updateItem(id, { content: after, excerpt: noteExcerpt(after) }, { expectedUpdatedAt: note.updatedAt }));
      return { before, after, item };
    } catch (error) {
      if (!/^Conflict/i.test(error?.message || '')) throw error;
      ctx.toast('This note just changed in another view. Try again.', { tone: 'warning' });
      ctx.render();
      return null;
    }
  });
  queues.set(id, run.catch(() => {}));
  return run;
}

/** An edit with an Undo toast that restores the previous text while nobody has changed the note since. */
export async function editWithUndo(ctx, id, transform, message) {
  const result = await editNoteContent(ctx, id, transform);
  if (!result) return null;
  ctx.toast(message, {
    action: { label: 'Undo', run: () => ctx.run(async () => {
      const restored = await editNoteContent(ctx, id, current => (current === result.after ? result.before : null));
      if (!restored) ctx.toast('This note changed since, so it was left as it is.', { tone: 'warning' });
    }) },
  });
  return result;
}

// Checkbox state shown while its write is in flight (a re-render must not flip the box back), and tasks that were
// just completed in a list that hides completed ones: they stay visible, struck through, for a few seconds.
const pending = new Map();
const lingering = new Map();
const LINGER_MS = 4000;
const taskKey = (noteId, index) => `${noteId}:${index}`;

export function shownDone(noteId, task) {
  const key = taskKey(noteId, task.index);
  return pending.has(key) ? pending.get(key) : task.done;
}
export const isLingering = (noteId, task) => (lingering.get(taskKey(noteId, task.index)) || 0) > Date.now();
/** The note's Markdown with in-flight checkbox writes applied, so rendered checkboxes never flip back mid-save. */
export function withPending(note) {
  let content = String(note?.content || '');
  if (!pending.size) return content;
  for (const [key, done] of pending) {
    const cut = key.lastIndexOf(':');
    if (key.slice(0, cut) === note.id) content = toggleTask(content, Number(key.slice(cut + 1)), done);
  }
  return content;
}

// The newest click per task: an earlier write that finishes later must not clear the optimistic state of a newer one
// (tick, untick quickly: the box would flip back to ticked until the second write lands).
const latestToggle = new Map();

/** Sets one task's checkbox (toggleTask semantics) with optimistic state; done tasks linger in filtered lists. */
export async function setTaskDone(ctx, noteId, index, done) {
  const key = taskKey(noteId, index);
  const token = {};
  latestToggle.set(key, token);
  pending.set(key, done);
  if (done) {
    lingering.set(key, Date.now() + LINGER_MS);
    setTimeout(() => { if ((lingering.get(key) || 0) <= Date.now()) { lingering.delete(key); renderKeepingFocus(ctx); } }, LINGER_MS + 50);
  } else lingering.delete(key);
  try { await editNoteContent(ctx, noteId, content => toggleTask(content, index, done)); } finally {
    if (latestToggle.get(key) === token) { latestToggle.delete(key); pending.delete(key); }
    ctx.render();
  }
}

/**
 * Re-renders after a completed task's linger ends. When the focused checkbox's row leaves the list (a list that hides
 * completed items), focus moves to the next item's checkbox (else the previous one, else the add field) instead of
 * dropping to the page.
 */
function renderKeepingFocus(ctx) {
  const active = globalThis.document?.activeElement;
  const root = active?.closest?.('.w-checklist[data-widget]');
  if (root && active.matches?.('.w-checklist-box')) {
    const boxes = [...root.querySelectorAll('.w-checklist-box')];
    const at = boxes.indexOf(active);
    const order = [...boxes.slice(at + 1), ...boxes.slice(0, at).reverse()].map(box => box.id);
    const widgetId = root.dataset.widget;
    ctx.nextFrame(() => {
      if (active.isConnected) return;
      const scope = document.querySelector(`.w-checklist[data-widget="${CSS.escape(widgetId)}"]`);
      const next = order.map(id => document.getElementById(id)).find(Boolean)
        || scope?.querySelector('.w-checklist-add-input, .w-checklist-box, button');
      next?.focus({ preventScroll: true });
    });
  }
  ctx.render();
}

/* ------------------------------------------------------------------ notes */

let notesStamp = null;
let notesCache = null;
/** Live (not archived, not deleted) notes, memoized on the library revision. */
export function liveNotes(ctx) {
  const stamp = ctx.library?.updatedAt ?? null;
  if (stamp !== notesStamp || !notesCache) { notesStamp = stamp; notesCache = ctx.select.live().filter(item => item.type === 'note'); }
  return notesCache;
}

/** A popover anchor for menu commands: the widget's own element, or the page centre when it is gone. */
export function anchorFor(selector) {
  const el = document.querySelector(selector);
  if (!el) return { x: innerWidth / 2, y: innerHeight / 3 };
  const rect = el.getBoundingClientRect();
  return { x: rect.left + 12, y: rect.top + 8 };
}

// Per-revision derived data, so a dashboard re-render never re-parses unchanged notes.
const derived = new Map();
function memo(key, compute) {
  if (derived.has(key)) return derived.get(key);
  const value = compute();
  derived.set(key, value);
  if (derived.size > 3000) derived.delete(derived.keys().next().value);
  return value;
}
const rev = note => `${note.id}:${note.updatedAt}`;
/** extractTasks for a note, memoized on its revision. */
export const noteTasks = note => memo(`tasks:${rev(note)}`, () => extractTasks(note.content || ''));
/** { done, total } for a note's tasks. */
export const noteProgress = note => memo(`progress:${rev(note)}`, () => {
  const tasks = noteTasks(note);
  return { done: tasks.filter(task => task.done).length, total: tasks.length };
});
/** One-line excerpt under a note's title in lists. */
export const noteSnippet = note => memo(`snippet:${rev(note)}:${note.title || ''}`, () => noteExcerpt(excerptSource(note), 140));

/** Shown title: the stored title, else the note's first line. */
export const noteLabel = note => memo(`label:${rev(note)}:${note.title || ''}`, () => displayTitle(note, noteTitleFromContent(note?.content || '')));

/** The widget's one note while it is still a live note in the library, else null. */
export function shownNote(ctx, noteId) {
  const note = noteId ? latestItem(ctx, noteId) : null;
  return note && !note.deletedAt && note.type === 'note' ? note : null;
}
/** True when the frame header already shows this name: the instance's own title, or the note name it falls back to (displayTitle). */
export const frameShowsName = (widget, name) => widget.style?.frame !== 'none' && !widget.style?.hideTitle
  && (widget.title || name).trim().toLowerCase() === String(name).trim().toLowerCase();

/** Opens a note in this surface's notes editor (full tab: the Notes view; side panel: the Notes tab). */
export function openNoteFromWidget(ctx, id, { focus } = {}) {
  if (!id) return;
  if (!ctx.select.byId(id)) { ctx.toast('That note is no longer in your library.', { tone: 'danger' }); return; }
  openNote(ctx, id, { focus });
}

/** The collection a new note from a widget lands in: the given one when it still exists, else the default collection. */
export function targetCollection(ctx, collectionId) {
  if (collectionId && collectionId !== '*' && ctx.select.collection(collectionId)) return collectionId;
  if (collectionId === '') return '';
  const fallback = ctx.library?.settings?.defaultCollectionId;
  return fallback && ctx.select.collection(fallback) ? fallback : '';
}

/** Saves a new note for a widget (title, content, collection, tags) without leaving the dashboard. */
export const createWidgetNote = (ctx, { title = '', content = '', collectionId = '*', tags = [] } = {}) =>
  createNoteItem(ctx, { title, content, collectionId: targetCollection(ctx, collectionId), tags });

/** Stores widget config; errors surface through ctx.run in the calling action. */
export const saveConfig = (widgetId, patch) => updateWidgetConfig(widgetId, patch);

/** Select options for a collection filter: All notes, Inbox, then the tree indented by depth. */
export function collectionOptions(ctx, { all = true, allLabel = 'All notes' } = {}) {
  const rows = ctx.select.tree().map(row => ({ value: row.id, label: `${' '.repeat(Math.min(row.depth, 6))}${row.name || 'Untitled collection'}` }));
  return [...(all ? [{ value: '*', label: allLabel }] : []), { value: '', label: 'Inbox' }, ...rows];
}

/** Collection or Inbox label for meta lines. */
export function collectionName(ctx, collectionId) {
  if (collectionId === '*') return 'All notes';
  if (!collectionId) return 'Inbox';
  return ctx.select.collection(collectionId)?.name || 'Inbox';
}

/** Small leading tile for a note row: the note's uploaded icon, else its collection's icon, or a note glyph for Inbox notes. */
export function noteTile(ctx, note, size = 20) {
  const own = customIcon(note, { size });
  if (own) return own;
  const collection = note.collectionId ? ctx.select.collection(note.collectionId) : null;
  return collection ? collectionIcon(collection, { size }) : html`<span class="w-note-tile" style="--size:${size}px" aria-hidden="true">${icon('sticky-note', { size: Math.round(size * 0.7) })}</span>`;
}

/** Progress meter: a thin bar and "3 of 5" text (screen readers get the full sentence). */
export function progressBar({ done, total }, { className, compact = false } = {}) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return html`<div class="${cx('w-progress', done === total && total > 0 && 'is-complete', compact && 'is-compact', className)}">
    <span class="w-progress-track" role="progressbar" aria-label="Completed items" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"
      aria-valuetext="${done} of ${total} done"><span class="w-progress-fill" style="width:${pct}%"></span></span>
    <span class="w-progress-label" aria-hidden="true">${done}<span class="w-progress-of">/${total}</span></span>
  </div>`;
}
