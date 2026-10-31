// Pure Markdown and list helpers for the Notes and Checklist dashboard widgets. Node-importable (no DOM, no chrome.*).
//
// Task addressing follows lib/notes.js: a task is named by its lexical index (every line matching TASK_LINE counts,
// in document order, even inside code fences), so an index from extractTasks() or a rendered data-task-index is the
// line these helpers rewrite. Lines are located with the shared block parser, so hard-break continuations, toggles
// and nested lists are handled the same way the editor and the renderer see them. Every helper changes only the lines
// it targets and keeps the rest of the note byte for byte (including CRLF line endings).
import { parseNoteBlocks, taskLineIndices, inlineText } from '../../../lib/markdown.js';

const LIST_TYPES = new Set(['bullet', 'number', 'todo']);
const TASK_HEAD = /^([ \t]*)([-*]) \[([ xX])\]/;
const LIST_LINE = /^[ \t]*(?:[-*] \[[ xX]\](?: |\r?$)|[-*] |\d+\. )/;

const sourceOf = markdown => String(markdown ?? '');
const crOf = line => (String(line).endsWith('\r') ? '\r' : '');

/** One line of task text: newlines and runs of spaces collapse, and a trailing backslash cannot become a hard break. */
export function taskText(text) {
  const line = String(text ?? '').replace(/\r\n?|\n/g, ' ').replace(/[ \t]+/g, ' ').trim();
  return line.replace(/\\+$/, run => (run.length % 2 ? `${run}\\` : run));
}

/**
 * Real to-do blocks with their source lines: { index, start, end, subtreeEnd, indent, lead, marker, done, text, plain }.
 * start/end are 0-based lines of the item itself (end > start for hard-break continuations); subtreeEnd also covers
 * nested non-task list items that belong to it. lead is the leading whitespace of the list's first item.
 */
export function taskBlocks(markdown) {
  const source = sourceOf(markdown);
  const lines = source.split('\n');
  const indices = taskLineIndices(source);
  const out = [];
  const walk = (text, offset, depth) => {
    if (depth > 16) return;
    const blocks = parseNoteBlocks(text);
    let runLead = '';
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[k];
      if (b.type === 'toggle') { walk(b.text, offset + b._lineStart + 1, depth + 1); continue; }
      if (!LIST_TYPES.has(b.type)) continue;
      if (!(b.indent || 0)) runLead = b._lead || '';
      if (b.type !== 'todo') continue;
      const start = offset + b._lineStart;
      const index = indices[start];
      if (index === null || index === undefined) continue;
      let subtreeEnd = offset + b._lineEnd;
      for (let j = k + 1; j < blocks.length && blocks[j].type !== 'todo' && LIST_TYPES.has(blocks[j].type) && (blocks[j].indent || 0) > (b.indent || 0); j++) {
        subtreeEnd = offset + blocks[j]._lineEnd;
      }
      const head = TASK_HEAD.exec(lines[start]) || [];
      out.push({ index, start, end: offset + b._lineEnd, subtreeEnd, indent: b.indent || 0, lead: runLead, marker: head[2] || '-',
        done: !!b.checked, text: b.text, plain: inlineText(b.text) });
    }
  };
  walk(source, 0, 0);
  return out;
}

const findTask = (markdown, index) => taskBlocks(markdown).find(task => task.index === Number(index)) || null;

/** Replaces the text of the task at `index`, keeping its indentation, marker and checkbox. Empty text keeps an empty task. */
export function editTask(markdown, index, text) {
  const source = sourceOf(markdown);
  const task = findTask(source, index);
  if (!task) return source;
  const lines = source.split('\n');
  const head = TASK_HEAD.exec(lines[task.start]);
  if (!head) return source;
  const value = taskText(text);
  const cr = crOf(lines[task.end]);
  lines.splice(task.start, task.end - task.start + 1, `${head[0]}${value ? ` ${value}` : ' '}${cr}`);
  return lines.join('\n');
}

/** Removes the task lines at these indices (continuation lines included). Nested items stay, one level up. */
export function removeTasks(markdown, indexList) {
  const source = sourceOf(markdown);
  const wanted = new Set([].concat(indexList ?? []).map(Number));
  const targets = taskBlocks(source).filter(task => wanted.has(task.index)).sort((a, b) => b.start - a.start);
  if (!targets.length) return source;
  const lines = source.split('\n');
  for (const task of targets) lines.splice(task.start, task.end - task.start + 1);
  return lines.join('\n');
}
export const removeTask = (markdown, index) => removeTasks(markdown, [index]);

/**
 * Adds "- [ ] text" right after the note's last task (and its nested items), in that list's marker and indentation, so
 * new items join the checklist instead of landing under later sections. Without tasks it goes at the end, separated by
 * a blank line unless the note already ends in a list. fillEmpty: reuse a trailing empty, unchecked task instead.
 */
export function appendTask(markdown, text, { fillEmpty = false } = {}) {
  const source = sourceOf(markdown);
  const value = taskText(text);
  const tasks = taskBlocks(source);
  const last = tasks.at(-1);
  if (fillEmpty && last && !last.done && !last.plain.trim() && value) return editTask(source, last.index, value);
  const lineFor = (lead, marker) => `${lead}${marker} [ ]${value ? ` ${value}` : ' '}`;
  if (last) {
    const lines = source.split('\n');
    lines.splice(last.subtreeEnd + 1, 0, lineFor(last.lead, last.marker) + crOf(lines[last.subtreeEnd]));
    return lines.join('\n');
  }
  return appendBlock(source, lineFor('', '-'));
}

/** Appends Markdown text at the end of a note: one newline between list items, a blank line otherwise. */
export function appendBlock(markdown, text) {
  const source = sourceOf(markdown);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const addition = String(text ?? '').replace(/\r\n?/g, '\n').replace(/^\s*\n/, '').replace(/\s+$/, '').split('\n').join(eol);
  if (!addition) return source;
  if (!source.trim()) return addition;
  const trailing = /(?:\r?\n)$/.test(source);
  const body = source.replace(/(?:\r?\n[ \t]*)+$/, '');
  const lastLine = body.slice(body.lastIndexOf('\n') + 1);
  const joiner = LIST_LINE.test(lastLine) && LIST_LINE.test(addition) ? eol : eol + eol;
  return body + joiner + addition + (trailing ? eol : '');
}

/** Quick-append text for the single-note widget: "[] x" or "[ ] x" become a task, anything else a paragraph. */
export function quickAppend(markdown, text) {
  const value = String(text ?? '').trim();
  if (!value) return sourceOf(markdown);
  const task = /^(?:[-*] )?\[ ?\][ \t]*(.*)$/s.exec(value);
  return appendBlock(markdown, task ? `- [ ] ${taskText(task[1])}` : value);
}

/** Checks or unchecks every real task (code-fence lines are left alone). */
export function setAllTasks(markdown, done) {
  const source = sourceOf(markdown);
  const starts = new Set(taskBlocks(source).filter(task => task.done !== !!done).map(task => task.start));
  if (!starts.size) return source;
  return source.split('\n').map((line, i) => (starts.has(i) ? line.replace(TASK_HEAD, (_, lead, marker) => `${lead}${marker} [${done ? 'x' : ' '}]`) : line)).join('\n');
}

/**
 * What quick capture saves: the first line becomes the title when it reads like one (not a list item, quote or code,
 * at most 80 characters); the rest is the body. Otherwise the whole text is the body and the title stays empty, so
 * lists show the note's first line. Returns null for blank text.
 */
export function captureDraft(text) {
  const value = String(text ?? '').replace(/\r\n?/g, '\n').replace(/^\s*\n/, '').trimEnd();
  if (!value.trim()) return null;
  const [first, ...rest] = value.split('\n');
  const structural = LIST_LINE.test(first) || /^\s*(?:>|```|~~~|:::|\||---\s*$)/.test(first);
  const title = structural ? '' : inlineText(first.replace(/^\s*#{1,6}\s+/, '')).replace(/\s+/g, ' ').trim();
  if (!title || title.length > 80) return { title: '', content: value.trim() };
  return { title, content: rest.join('\n').replace(/^\s*\n/, '').trimEnd() };
}

/* ------------------------------------------------------------------ note lists */

/**
 * The part of a note to excerpt under its title in lists: without a stored title the first line already is the shown
 * title, so it is skipped; with one, a leading heading that only repeats it is skipped.
 */
export function excerptSource(note) {
  const content = String(note?.content || '');
  const title = String(note?.title || '').trim();
  if (!title || title === 'Untitled note') return content.replace(/^\s*[^\n]*\n?/, '');
  const heading = /^\s*#{1,3}[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/.exec(content);
  return heading && heading[1].trim().toLowerCase() === title.toLowerCase() ? content.slice(heading[0].length) : content;
}

const titleKey = note => String(note.title || '').trim() || String(note.content || '').trim();
const SORTERS = {
  updated: (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
  created: (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  title: (a, b) => titleKey(a).localeCompare(titleKey(b), undefined, { sensitivity: 'base', numeric: true }),
};
const usable = item => item && item.type === 'note' && !item.deletedAt && !item.archived;

/**
 * Notes in a widget's scope. collectionId: '*' all notes, '' Inbox (no collection), or an id; `within` is that id's
 * subtree (a Set or array from ctx.select.descendants) so nested collections count. Sticky notes are left out unless
 * includeStickies.
 */
export function scopeNotes(notes, { collectionId = '*', within = null, tag = '', includeStickies = true } = {}) {
  const ids = collectionId && collectionId !== '*' ? new Set(within ? [...within] : [collectionId]) : null;
  const wantTag = String(tag || '').trim().toLowerCase().replace(/^#/, '');
  return (Array.isArray(notes) ? notes : []).filter(note => {
    if (!usable(note)) return false;
    if (!includeStickies && note.sticky) return false;
    if (collectionId === '' && note.collectionId) return false;
    if (ids && !ids.has(note.collectionId)) return false;
    if (wantTag && !(note.tags || []).some(t => String(t).toLowerCase() === wantTag)) return false;
    return true;
  });
}

/** Recent-notes list for the widget: { rows, total } with pinned notes first, then the chosen order, capped at limit. */
export function recentNotes(notes, { sort = 'updated', limit = 8, ...scope } = {}) {
  const rows = scopeNotes(notes, { includeStickies: false, ...scope });
  const by = SORTERS[sort] || SORTERS.updated;
  rows.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || by(a, b));
  return { rows: rows.slice(0, clampLimit(limit)), total: rows.length };
}
export const clampLimit = value => Math.max(1, Math.min(50, Math.round(Number(value)) || 8));

/**
 * Notes for the note picker. Every query word must appear in the title or text; titles that start with the query rank
 * first, then other title matches, then text-only matches. Within a rank, notes with tasks come first when
 * preferTasks, then the most recently edited.
 */
export function pickerNotes(notes, { query = '', preferTasks = false, limit = 60 } = {}) {
  const phrase = String(query || '').trim().toLowerCase();
  const words = phrase.split(/\s+/).filter(Boolean);
  const hasTasks = note => /\[[ xX]\]/.test(note.content || '');
  const rank = note => {
    if (!words.length) return 0;
    const title = String(note.title || '').toLowerCase();
    return title.startsWith(phrase) ? 0 : words.every(word => title.includes(word)) ? 1 : 2;
  };
  return (Array.isArray(notes) ? notes : [])
    .filter(note => usable(note) && words.every(word => `${note.title || ''}\n${note.content || ''}`.toLowerCase().includes(word)))
    .map(note => ({ note, rank: rank(note), tasks: preferTasks && hasTasks(note) }))
    .sort((a, b) => a.rank - b.rank || Number(b.tasks) - Number(a.tasks) || SORTERS.updated(a.note, b.note))
    .slice(0, limit)
    .map(entry => entry.note);
}
