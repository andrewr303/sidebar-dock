// Kanban board model: the widget's config shape, its repair (normalizeBoard) and pure reducers. Every reducer takes a
// normalized board and returns a new one (the input is never mutated); a reducer that has nothing to change returns
// its input, so callers can skip the write. No DOM, no storage: the widget module persists results with env.update.
//
// Board (widget.config):
// {
//   columns: [{ id, title, color, limit, done }]       color: a palette name or ''; limit: 0 = no WIP limit;
//                                                       done: cards here count as finished (summary, due badges)
//   cards:   [{ id, columnId, title, description, labels: [labelId], priority, due: 'YYYY-MM-DD' | '', itemId,
//              checklist: [{ id, text, done }], createdAt, updatedAt }]   order within a column = order in this array
//   labels:  [{ id, name, color }]
//   filter:  { label: '', query: '' }
//   layout:  'auto' | 'board' | 'summary'
//   showDescriptions: false
// }

export const COLORS = Object.freeze(['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'pink', 'gray']);
export const COLOR_LABELS = Object.freeze({
  red: 'Red', orange: 'Orange', amber: 'Amber', yellow: 'Yellow', lime: 'Lime', green: 'Green', teal: 'Teal', cyan: 'Cyan',
  blue: 'Blue', indigo: 'Indigo', violet: 'Violet', pink: 'Pink', gray: 'Gray',
});
export const PRIORITIES = Object.freeze([
  { value: 'none', label: 'No priority', rank: 0 },
  { value: 'low', label: 'Low', rank: 1 },
  { value: 'medium', label: 'Medium', rank: 2 },
  { value: 'high', label: 'High', rank: 3 },
  { value: 'urgent', label: 'Urgent', rank: 4 },
]);
export const LAYOUTS = Object.freeze(['auto', 'board', 'summary']);
export const LIMITS = Object.freeze({ columns: 20, cards: 1000, labels: 40, checklist: 100, title: 300, description: 20000, label: 40, column: 60, item: 500, wip: 999 });

const PRIORITY_VALUES = new Set(PRIORITIES.map(p => p.value));
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const longText = (value, max) => String(value ?? '').replace(/\r\n?/g, '\n').slice(0, max);
const colorOf = value => (COLORS.includes(String(value)) ? String(value) : '');
const isoOr = (value, fallback) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback);
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Random id with a readable prefix: uid('card') -> 'card_1f3a9c0b2d'. */
export function uid(prefix = 'k') {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 10) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return `${prefix}_${random}`;
}

/** 'YYYY-MM-DD' when value is a real calendar date, else ''. */
export function normalizeDue(value) {
  const match = DATE.exec(String(value ?? '').trim());
  if (!match) return '';
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? match[0] : '';
}

/** Local calendar date for a Date: toDateKey(new Date(2026, 9, 30)) -> '2026-10-30'. */
export const toDateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
/** The date `days` days after `from` (local calendar), as 'YYYY-MM-DD'. */
export const addDays = (from, days) => toDateKey(new Date(from.getFullYear(), from.getMonth(), from.getDate() + days));

function normalizeCard(input, { columnIds, labelIds, now }) {
  const checklist = [];
  const seen = new Set();
  for (const entry of Array.isArray(input.checklist) ? input.checklist : []) {
    if (!isObject(entry) || checklist.length >= LIMITS.checklist) continue;
    const id = typeof entry.id === 'string' && entry.id && !seen.has(entry.id) ? entry.id : uid('ci');
    seen.add(id);
    checklist.push({ id, text: text(entry.text, LIMITS.item), done: entry.done === true });
  }
  const labels = [...new Set((Array.isArray(input.labels) ? input.labels : []).map(String))].filter(id => labelIds.has(id));
  return {
    id: input.id,
    columnId: columnIds.has(input.columnId) ? input.columnId : [...columnIds][0],
    title: text(input.title, LIMITS.title) || 'Untitled card',
    description: longText(input.description, LIMITS.description),
    labels,
    priority: PRIORITY_VALUES.has(input.priority) ? input.priority : 'none',
    due: normalizeDue(input.due),
    itemId: typeof input.itemId === 'string' ? input.itemId : '',
    checklist,
    createdAt: isoOr(input.createdAt, now),
    updatedAt: isoOr(input.updatedAt, isoOr(input.createdAt, now)),
  };
}

/**
 * Repairs a stored config into a board: at least one column, unique ids, known colors and priorities, cards in an
 * unknown column moved to the first one, label references that point nowhere dropped, text trimmed to limits.
 * Unknown keys are dropped too. An empty or missing config becomes an empty three-column board (not the samples).
 */
export function normalizeBoard(input, { now = new Date().toISOString() } = {}) {
  const source = isObject(input) ? input : {};
  const columns = [];
  const columnIds = new Set();
  for (const entry of Array.isArray(source.columns) ? source.columns : []) {
    if (!isObject(entry) || columns.length >= LIMITS.columns) continue;
    const id = typeof entry.id === 'string' && entry.id && !columnIds.has(entry.id) ? entry.id : uid('col');
    columnIds.add(id);
    const limit = Math.round(Number(entry.limit));
    columns.push({ id, title: text(entry.title, LIMITS.column) || 'Untitled column', color: colorOf(entry.color),
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, LIMITS.wip) : 0, done: entry.done === true });
  }
  if (!columns.length) for (const column of emptyColumns()) { columns.push(column); columnIds.add(column.id); }

  const labels = [];
  const labelIds = new Set();
  for (const entry of Array.isArray(source.labels) ? source.labels : []) {
    if (!isObject(entry) || labels.length >= LIMITS.labels) continue;
    const name = text(entry.name, LIMITS.label);
    if (!name) continue;
    const id = typeof entry.id === 'string' && entry.id && !labelIds.has(entry.id) ? entry.id : uid('lbl');
    labelIds.add(id);
    labels.push({ id, name, color: colorOf(entry.color) || 'gray' });
  }

  const cards = [];
  const cardIds = new Set();
  for (const entry of Array.isArray(source.cards) ? source.cards : []) {
    if (!isObject(entry) || cards.length >= LIMITS.cards) continue;
    const id = typeof entry.id === 'string' && entry.id && !cardIds.has(entry.id) ? entry.id : uid('card');
    cardIds.add(id);
    cards.push(normalizeCard({ ...entry, id }, { columnIds, labelIds, now }));
  }

  const filter = isObject(source.filter) ? source.filter : {};
  return {
    columns,
    cards,
    labels,
    filter: { label: labelIds.has(filter.label) ? filter.label : '', query: String(filter.query ?? '').slice(0, 200) },
    layout: LAYOUTS.includes(source.layout) ? source.layout : 'auto',
    showDescriptions: source.showDescriptions === true,
  };
}

const emptyColumns = () => [
  { id: 'todo', title: 'To do', color: '', limit: 0, done: false },
  { id: 'doing', title: 'In progress', color: 'blue', limit: 0, done: false },
  { id: 'done', title: 'Done', color: 'green', limit: 0, done: true },
];

/** The board a new widget starts with: To do / In progress / Done, a few labels and example cards that teach the board. */
export function defaultBoard(today = new Date()) {
  const now = today.toISOString();
  const card = (id, columnId, fields) => ({ id, columnId, title: '', description: '', labels: [], priority: 'none', due: '', itemId: '',
    checklist: [], createdAt: now, updatedAt: now, ...fields });
  return normalizeBoard({
    columns: emptyColumns().map(column => (column.id === 'doing' ? { ...column, limit: 3 } : column)),
    labels: [
      { id: 'lbl_work', name: 'Work', color: 'blue' },
      { id: 'lbl_personal', name: 'Personal', color: 'green' },
      { id: 'lbl_idea', name: 'Idea', color: 'violet' },
      { id: 'lbl_waiting', name: 'Waiting', color: 'amber' },
    ],
    cards: [
      card('card_plan', 'todo', { title: 'Plan the week', labels: ['lbl_personal'], priority: 'medium', due: addDays(today, 2),
        checklist: [{ id: 'ci_1', text: 'Review the calendar', done: true }, { id: 'ci_2', text: 'Pick three priorities', done: false }, { id: 'ci_3', text: 'Block time to focus', done: false }] }),
      card('card_drag', 'todo', { title: 'Drag a card to another column',
        description: 'Or focus a card and press ] to move it right and [ to move it left. Alt with ↑ or ↓ changes its order.' }),
      card('card_open', 'doing', { title: 'Open a card to add details', labels: ['lbl_idea'], priority: 'low',
        description: 'Cards hold a description, labels, a due date, a checklist and a link to anything in your library.' }),
      card('card_done', 'done', { title: 'Add a board to the dashboard', labels: ['lbl_work'] }),
    ],
    filter: { label: '', query: '' },
    layout: 'auto',
    showDescriptions: false,
  }, { now });
}

/* ------------------------------------------------------------------ queries */

export const findCard = (board, id) => board.cards.find(card => card.id === id) || null;
export const findColumn = (board, id) => board.columns.find(column => column.id === id) || null;
export const columnIndex = (board, id) => board.columns.findIndex(column => column.id === id);
export const columnCards = (board, columnId) => board.cards.filter(card => card.columnId === columnId);
export const isDoneColumn = (board, columnId) => findColumn(board, columnId)?.done === true;
export const priorityOf = value => PRIORITIES.find(p => p.value === value) || PRIORITIES[0];
export const labelMap = board => new Map(board.labels.map(label => [label.id, label]));

/** { done, total } for a card's checklist. */
export function checklistProgress(card) {
  const total = card?.checklist?.length || 0;
  return { done: total ? card.checklist.filter(item => item.done).length : 0, total };
}

/** WIP state of a column holding `count` cards: 'none' (no limit) | 'under' | 'at' | 'over'. */
export function wipState(column, count) {
  if (!column?.limit) return 'none';
  return count > column.limit ? 'over' : count === column.limit ? 'at' : 'under';
}

/** True when a filter would hide anything. */
export const isFiltered = filter => !!(filter?.label || String(filter?.query || '').trim());

/** Cards matching a filter: every query word must appear in the title, description, checklist or a label name. */
export function filterCards(board, cards = board.cards, filter = board.filter) {
  const words = String(filter?.query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const label = filter?.label || '';
  if (!words.length && !label) return cards;
  const labels = labelMap(board);
  return cards.filter(card => {
    if (label && !card.labels.includes(label)) return false;
    if (!words.length) return true;
    const haystack = [card.title, card.description, ...card.checklist.map(item => item.text), ...card.labels.map(id => labels.get(id)?.name || '')].join('\n').toLowerCase();
    return words.every(word => haystack.includes(word));
  });
}

const DAY = 86_400_000;
const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
/**
 * Due date relative to today: { state, days, date } where state is 'none' | 'overdue' | 'today' | 'tomorrow' | 'soon'
 * (within a week) | 'later', days the whole calendar days from today (negative when overdue) and date a local Date.
 */
export function dueInfo(due, today = new Date()) {
  const key = normalizeDue(due);
  if (!key) return { state: 'none', days: null, date: null };
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const days = Math.round((date - startOfDay(today)) / DAY);
  const state = days < 0 ? 'overdue' : days === 0 ? 'today' : days === 1 ? 'tomorrow' : days <= 7 ? 'soon' : 'later';
  return { state, days, date };
}

/** Short label for a due date: Today, Tomorrow, Yesterday, a weekday within the week, else "Nov 2" (with the year when it differs). */
export function dueLabel(due, today = new Date(), locale) {
  const info = dueInfo(due, today);
  if (!info.date) return '';
  if (info.days === 0) return 'Today';
  if (info.days === 1) return 'Tomorrow';
  if (info.days === -1) return 'Yesterday';
  if (info.days > 1 && info.days < 7) return info.date.toLocaleDateString(locale, { weekday: 'short' });
  const sameYear = info.date.getFullYear() === today.getFullYear();
  return info.date.toLocaleDateString(locale, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Per-column counts for summaries: [{ column, count, wip }]. */
export const columnStats = board => board.columns.map(column => {
  const count = board.cards.reduce((n, card) => n + (card.columnId === column.id), 0);
  return { column, count, wip: wipState(column, count) };
});

/**
 * Open cards to look at next: unfinished cards with a due date (soonest first, then by priority), then, when there is
 * room, unfinished cards by priority. Done columns are left out.
 */
export function upNext(board, { limit = 5 } = {}) {
  const open = board.cards.filter(card => !isDoneColumn(board, card.columnId));
  const rank = card => priorityOf(card.priority).rank;
  const dated = open.filter(card => card.due).sort((a, b) => a.due.localeCompare(b.due) || rank(b) - rank(a));
  const rest = open.filter(card => !card.due && rank(card) > 0).sort((a, b) => rank(b) - rank(a));
  return [...dated, ...rest].slice(0, limit);
}

/** Markdown for a note made from a card: description, checklist as tasks, then labels, priority and due date. */
export function cardToMarkdown(card, board) {
  const labels = labelMap(board);
  const parts = [];
  if (card.description.trim()) parts.push(card.description.trim());
  if (card.checklist.length) parts.push(card.checklist.map(item => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n'));
  const facts = [];
  const names = card.labels.map(id => labels.get(id)?.name).filter(Boolean);
  if (names.length) facts.push(`Labels: ${names.join(', ')}`);
  if (card.priority !== 'none') facts.push(`Priority: ${priorityOf(card.priority).label}`);
  if (card.due) facts.push(`Due: ${card.due}`);
  const column = findColumn(board, card.columnId);
  if (column) facts.push(`Column: ${column.title}`);
  if (facts.length) parts.push(facts.join(' · '));
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ card reducers */

const stamp = now => (now instanceof Date ? now.toISOString() : typeof now === 'string' ? now : new Date().toISOString());
const withCards = (board, cards) => ({ ...board, cards });
const withColumns = (board, columns) => ({ ...board, columns });

/** Places `card` into `cards` before the card `beforeId` of the same column, else after that column's last card. */
function place(cards, card, beforeId) {
  const out = cards.filter(c => c.id !== card.id);
  let at = beforeId ? out.findIndex(c => c.id === beforeId && c.columnId === card.columnId) : -1;
  if (at < 0) {
    const last = out.reduce((index, c, i) => (c.columnId === card.columnId ? i : index), -1);
    at = last < 0 ? out.length : last + 1;
  }
  out.splice(at, 0, card);
  return out;
}

/**
 * Adds a card to a column: fields { id?, title, description, labels, priority, due, itemId, checklist }. atStart puts
 * it first in the column, else last. A blank title or an unknown column leaves the board unchanged.
 */
export function addCard(board, columnId, fields = {}, { atStart = false, now } = {}) {
  if (!findColumn(board, columnId) || board.cards.length >= LIMITS.cards) return board;
  const title = text(fields.title, LIMITS.title);
  if (!title) return board;
  const at = stamp(now);
  const labelIds = new Set(board.labels.map(l => l.id));
  const card = normalizeCard({ ...fields, id: fields.id && !findCard(board, fields.id) ? fields.id : uid('card'), columnId, title, createdAt: at, updatedAt: at },
    { columnIds: new Set(board.columns.map(c => c.id)), labelIds, now: at });
  const first = atStart ? board.cards.find(c => c.columnId === columnId)?.id : null;
  return withCards(board, place(board.cards, card, first));
}

/** Patches a card's fields (title, description, labels, priority, due, itemId, checklist); a blank title is ignored. */
export function updateCard(board, cardId, patch = {}, { now } = {}) {
  const card = findCard(board, cardId);
  if (!card) return board;
  const next = { ...card };
  if ('title' in patch && text(patch.title, LIMITS.title)) next.title = text(patch.title, LIMITS.title);
  if ('description' in patch) next.description = longText(patch.description, LIMITS.description);
  if ('labels' in patch && Array.isArray(patch.labels)) next.labels = [...new Set(patch.labels.map(String))].filter(id => board.labels.some(l => l.id === id));
  if ('priority' in patch && PRIORITY_VALUES.has(patch.priority)) next.priority = patch.priority;
  if ('due' in patch) next.due = normalizeDue(patch.due);
  if ('itemId' in patch) next.itemId = typeof patch.itemId === 'string' ? patch.itemId : '';
  if ('checklist' in patch && Array.isArray(patch.checklist)) next.checklist = normalizeCard({ ...card, checklist: patch.checklist }, { columnIds: new Set([card.columnId]), labelIds: new Set(card.labels), now: card.createdAt }).checklist;
  const changed = ['title', 'description', 'priority', 'due', 'itemId'].some(key => next[key] !== card[key])
    || JSON.stringify(next.labels) !== JSON.stringify(card.labels) || JSON.stringify(next.checklist) !== JSON.stringify(card.checklist);
  if (!changed) return board;
  next.updatedAt = stamp(now);
  return withCards(board, board.cards.map(c => (c.id === cardId ? next : c)));
}

export function deleteCard(board, cardId) {
  return findCard(board, cardId) ? withCards(board, board.cards.filter(c => c.id !== cardId)) : board;
}

/** The card that follows `cardId` in its column (for Undo), or null when it is the last one. */
export function nextInColumn(board, cardId) {
  const card = findCard(board, cardId);
  if (!card) return null;
  const list = columnCards(board, card.columnId);
  return list[list.findIndex(c => c.id === cardId) + 1]?.id || null;
}

/** Puts a removed card back (Undo): before `beforeId` when that card is still in the column, else at the column's end. */
export function insertCard(board, card, { columnId = card?.columnId, beforeId = null } = {}) {
  if (!card?.id || findCard(board, card.id)) return board;
  const column = findColumn(board, columnId) ? columnId : board.columns[0].id;
  const labelIds = new Set(board.labels.map(l => l.id));
  const restored = normalizeCard({ ...card, columnId: column }, { columnIds: new Set(board.columns.map(c => c.id)), labelIds, now: stamp() });
  return withCards(board, place(board.cards, restored, beforeId));
}

/** Moves a card into `columnId`, before the card `beforeId` (null = the end of the column). */
export function moveCard(board, cardId, columnId, beforeId = null, { now } = {}) {
  const card = findCard(board, cardId);
  if (!card || !findColumn(board, columnId) || beforeId === cardId) return board;
  if (card.columnId === columnId) {
    // Same column: only the order among that column's cards matters.
    const ids = columnCards(board, columnId).map(c => c.id);
    const rest = ids.filter(id => id !== cardId);
    const at = beforeId && rest.includes(beforeId) ? rest.indexOf(beforeId) : rest.length;
    if (ids.indexOf(cardId) === at) return board;
  }
  const moved = card.columnId === columnId ? card : { ...card, columnId, updatedAt: stamp(now) };
  return withCards(board, place(board.cards, moved, beforeId));
}

/** Moves a card to position `index` among `columnId`'s cards (other than itself). */
export function moveCardToIndex(board, cardId, columnId, index, options) {
  const others = columnCards(board, columnId).filter(c => c.id !== cardId);
  const at = Math.max(0, Math.min(others.length, Math.round(Number(index)) || 0));
  return moveCard(board, cardId, columnId, others[at]?.id || null, options);
}

/**
 * Reorders a card by `delta` steps within its column. `visible` (ids shown, in order) limits the steps to cards the
 * person can see, so a filtered list moves past what it shows.
 */
export function stepCard(board, cardId, delta, visible = null) {
  const card = findCard(board, cardId);
  if (!card || !delta) return board;
  const list = columnCards(board, card.columnId).filter(c => c.id === cardId || !visible || visible.includes(c.id));
  const from = list.findIndex(c => c.id === cardId);
  const to = Math.max(0, Math.min(list.length - 1, from + Math.round(delta)));
  if (to === from) return board;
  // Up: in front of the card it passes. Down: right after the card it passes (hidden cards between them stay put).
  const target = list[to];
  return moveCard(board, cardId, card.columnId, delta < 0 ? target.id : nextInColumn(board, target.id));
}

/** Moves a card to the column `delta` steps away (−1 left, +1 right), keeping its position in the list where it can. */
export function shiftCard(board, cardId, delta, options) {
  const card = findCard(board, cardId);
  if (!card) return board;
  const from = columnIndex(board, card.columnId);
  const to = from + Math.sign(delta);
  if (!delta || to < 0 || to >= board.columns.length) return board;
  const index = columnCards(board, card.columnId).findIndex(c => c.id === cardId);
  return moveCardToIndex(board, cardId, board.columns[to].id, index, options);
}

/** Copies a card right below itself with a new id (and new checklist item ids). */
export function duplicateCard(board, cardId, { id = uid('card'), now } = {}) {
  const card = findCard(board, cardId);
  if (!card || board.cards.length >= LIMITS.cards || findCard(board, id)) return board;
  const at = stamp(now);
  const copy = { ...structuredClone(card), id, createdAt: at, updatedAt: at, checklist: card.checklist.map(item => ({ ...item, id: uid('ci') })) };
  const cards = [...board.cards];
  cards.splice(cards.findIndex(c => c.id === cardId) + 1, 0, copy);
  return withCards(board, cards);
}

/* ------------------------------------------------------------------ checklist reducers */

function editChecklist(board, cardId, edit, options) {
  const card = findCard(board, cardId);
  if (!card) return board;
  const checklist = edit(card.checklist.map(item => ({ ...item })));
  return checklist ? updateCard(board, cardId, { checklist }, options) : board;
}

export const addChecklistItem = (board, cardId, value, { id = uid('ci'), ...options } = {}) => editChecklist(board, cardId, list => {
  const item = text(value, LIMITS.item);
  return item && list.length < LIMITS.checklist ? [...list, { id, text: item, done: false }] : null;
}, options);

/** Sets an item's done state (omit `done` to flip it). */
export const toggleChecklist = (board, cardId, itemId, done, options) => editChecklist(board, cardId, list => {
  const item = list.find(entry => entry.id === itemId);
  if (!item) return null;
  item.done = typeof done === 'boolean' ? done : !item.done;
  return list;
}, options);

/** Renames an item; a blank text removes it. */
export const updateChecklistItem = (board, cardId, itemId, value, options) => editChecklist(board, cardId, list => {
  const item = list.find(entry => entry.id === itemId);
  if (!item) return null;
  const next = text(value, LIMITS.item);
  if (!next) return list.filter(entry => entry.id !== itemId);
  item.text = next;
  return list;
}, options);

export const removeChecklistItem = (board, cardId, itemId, options) => editChecklist(board, cardId, list => (list.some(entry => entry.id === itemId) ? list.filter(entry => entry.id !== itemId) : null), options);

/* ------------------------------------------------------------------ labels */

/** Adds a label ({ id?, name, color }); a blank name or a name already on the board (any case) changes nothing. */
export function createLabel(board, { id = uid('lbl'), name, color } = {}) {
  const value = text(name, LIMITS.label);
  if (!value || board.labels.length >= LIMITS.labels || board.labels.some(l => l.name.toLowerCase() === value.toLowerCase() || l.id === id)) return board;
  return { ...board, labels: [...board.labels, { id, name: value, color: colorOf(color) || 'gray' }] };
}

/** The label named `name` on the board (any case), or null. */
export const labelByName = (board, name) => board.labels.find(l => l.name.toLowerCase() === text(name, LIMITS.label).toLowerCase()) || null;

export function updateLabel(board, labelId, patch = {}) {
  const label = board.labels.find(l => l.id === labelId);
  if (!label) return board;
  const name = 'name' in patch ? text(patch.name, LIMITS.label) : label.name;
  const color = 'color' in patch ? colorOf(patch.color) || label.color : label.color;
  if (!name || (name === label.name && color === label.color)) return board;
  return { ...board, labels: board.labels.map(l => (l.id === labelId ? { ...l, name, color } : l)) };
}

/** Removes a label from the board and from every card (and clears it as the filter). */
export function deleteLabel(board, labelId) {
  if (!board.labels.some(l => l.id === labelId)) return board;
  return {
    ...board,
    labels: board.labels.filter(l => l.id !== labelId),
    cards: board.cards.map(card => (card.labels.includes(labelId) ? { ...card, labels: card.labels.filter(id => id !== labelId) } : card)),
    filter: board.filter.label === labelId ? { ...board.filter, label: '' } : board.filter,
  };
}

export function toggleLabel(board, cardId, labelId, options) {
  const card = findCard(board, cardId);
  if (!card || !board.labels.some(l => l.id === labelId)) return board;
  const labels = card.labels.includes(labelId) ? card.labels.filter(id => id !== labelId) : [...card.labels, labelId];
  return updateCard(board, cardId, { labels }, options);
}

/* ------------------------------------------------------------------ columns */

/** Adds a column ({ id?, title, color, limit, done }) at `index` (default: the end). A blank title changes nothing. */
export function addColumn(board, fields = {}, index = board.columns.length) {
  const title = text(fields.title, LIMITS.column);
  if (!title || board.columns.length >= LIMITS.columns) return board;
  const id = fields.id && !findColumn(board, fields.id) ? fields.id : uid('col');
  const limit = Math.round(Number(fields.limit));
  const column = { id, title, color: colorOf(fields.color), limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, LIMITS.wip) : 0, done: fields.done === true };
  const columns = [...board.columns];
  columns.splice(Math.max(0, Math.min(columns.length, index)), 0, column);
  return withColumns(board, columns);
}

/** Patches title, color, limit or done; a blank title is ignored. */
export function updateColumn(board, columnId, patch = {}) {
  const column = findColumn(board, columnId);
  if (!column) return board;
  const next = { ...column };
  if ('title' in patch && text(patch.title, LIMITS.column)) next.title = text(patch.title, LIMITS.column);
  if ('color' in patch) next.color = colorOf(patch.color);
  if ('limit' in patch) { const n = Math.round(Number(patch.limit)); next.limit = Number.isFinite(n) && n > 0 ? Math.min(n, LIMITS.wip) : 0; }
  if ('done' in patch) next.done = patch.done === true;
  if (Object.keys(next).every(key => next[key] === column[key])) return board;
  return withColumns(board, board.columns.map(c => (c.id === columnId ? next : c)));
}

export const renameColumn = (board, columnId, title) => updateColumn(board, columnId, { title });
export const setLimit = (board, columnId, limit) => updateColumn(board, columnId, { limit });
export const setColumnColor = (board, columnId, color) => updateColumn(board, columnId, { color });

/** Moves a column to `index` (clamped). */
export function moveColumn(board, columnId, index) {
  const from = columnIndex(board, columnId);
  if (from < 0) return board;
  const to = Math.max(0, Math.min(board.columns.length - 1, Math.round(Number(index)) || 0));
  if (to === from) return board;
  const columns = [...board.columns];
  const [column] = columns.splice(from, 1);
  columns.splice(to, 0, column);
  return withColumns(board, columns);
}

/** Moves a column before the column `beforeId` (null = to the end). */
export function moveColumnBefore(board, columnId, beforeId = null) {
  if (!findColumn(board, columnId) || beforeId === columnId) return board;
  const rest = board.columns.filter(c => c.id !== columnId);
  const at = beforeId ? rest.findIndex(c => c.id === beforeId) : rest.length;
  return moveColumn(board, columnId, at < 0 ? rest.length : at);
}

/** Deletes a column and its cards. The last column cannot be deleted. */
export function deleteColumn(board, columnId) {
  if (!findColumn(board, columnId) || board.columns.length < 2) return board;
  return { ...board, columns: board.columns.filter(c => c.id !== columnId), cards: board.cards.filter(card => card.columnId !== columnId) };
}

/** Puts back a deleted column at `index` with its cards (Undo). */
export function restoreColumn(board, column, index, cards = []) {
  if (!column?.id || findColumn(board, column.id) || board.columns.length >= LIMITS.columns) return board;
  const columns = [...board.columns];
  columns.splice(Math.max(0, Math.min(columns.length, index)), 0, column);
  const restored = cards.filter(card => !findCard(board, card.id)).map(card => ({ ...card, columnId: column.id }));
  return normalizeBoard({ ...board, columns, cards: [...board.cards, ...restored] });
}

/** Removes every card in a column (the "Clear done cards" command). */
export function clearDone(board, columnId) {
  return board.cards.some(card => card.columnId === columnId) ? withCards(board, board.cards.filter(card => card.columnId !== columnId)) : board;
}

/** Puts cleared cards back at the end of their column (Undo). */
export function restoreCards(board, cards = []) {
  let next = board;
  for (const card of cards) next = insertCard(next, card);
  return next;
}

/* ------------------------------------------------------------------ view settings */

export function setFilter(board, patch = {}) {
  const filter = {
    label: 'label' in patch ? (board.labels.some(l => l.id === patch.label) ? patch.label : '') : board.filter.label,
    query: 'query' in patch ? String(patch.query ?? '').slice(0, 200) : board.filter.query,
  };
  return filter.label === board.filter.label && filter.query === board.filter.query ? board : { ...board, filter };
}

export const clearFilter = board => setFilter(board, { label: '', query: '' });

/* ------------------------------------------------------------------ settings dialog */

/**
 * Inline errors for the settings dialog's draft ({ columns, labels }): { 'columns.0.title': 'message', ... }, or null.
 * Columns need a name and a whole-number limit; labels need a name that no other label on the board uses.
 */
export function settingsErrors(draft = {}) {
  const errors = {};
  const columns = Array.isArray(draft.columns) ? draft.columns : [];
  if (!columns.length) errors.columns = 'Add at least one column.';
  columns.forEach((column, index) => {
    if (!text(column?.title, LIMITS.column)) errors[`columns.${index}.title`] = 'Name this column.';
    const raw = column?.limit;
    if (raw !== '' && raw != null) {
      const limit = Number(raw);
      if (!Number.isInteger(limit) || limit < 0 || limit > LIMITS.wip) errors[`columns.${index}.limit`] = `Enter a whole number from 0 to ${LIMITS.wip}.`;
    }
  });
  const names = new Set();
  (Array.isArray(draft.labels) ? draft.labels : []).forEach((label, index) => {
    const name = text(label?.name, LIMITS.label).toLowerCase();
    if (!name) errors[`labels.${index}.name`] = 'Name this label, or remove it.';
    else if (names.has(name)) errors[`labels.${index}.name`] = 'Another label already has this name.';
    names.add(name);
  });
  return Object.keys(errors).length ? errors : null;
}

/**
 * Applies the settings dialog's draft (layout, showDescriptions, columns, labels) to the live board. Cards are kept:
 * cards in a removed column move to the first column, and removed labels come off every card.
 */
export function applySettings(board, draft = {}) {
  const columns = (Array.isArray(draft.columns) ? draft.columns : board.columns).filter(isObject).map(column => {
    const previous = findColumn(board, column.id) || {};
    return { ...previous, ...column, limit: Number(column.limit) || 0, done: column.done === true };
  });
  return normalizeBoard({
    ...board,
    layout: LAYOUTS.includes(draft.layout) ? draft.layout : board.layout,
    showDescriptions: 'showDescriptions' in draft ? draft.showDescriptions === true : board.showDescriptions,
    columns,
    labels: Array.isArray(draft.labels) ? draft.labels : board.labels,
  });
}

/** The stored config for a board (what env.update receives). */
export const toConfig = board => ({
  columns: board.columns, cards: board.cards, labels: board.labels, filter: board.filter, layout: board.layout, showDescriptions: board.showDescriptions,
});
