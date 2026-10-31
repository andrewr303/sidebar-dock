// Sticky notes. A sticky note is a library note with a `sticky` placement (lib/store.js normalizeSticky): it floats on
// the dashboard (renderStickyLayer), sits on the Sticky notes corkboard (renderStickiesView) and stays an ordinary note
// everywhere else (search, Notes, backups, the assistant and MCP clients).
//
// Each note's editor is owned by a mount ('stickies.editor', data-morph="skip"): rendered Markdown over a plain textarea,
// so typing never loses focus or caret on re-render; text saves after a short pause, on blur and when the page hides.
// Floating notes move by their top bar and resize from the corner with pointer events (arrow keys on the grip do the
// same); while a change is being saved the note shows a local override, so a re-render never snaps it back. Focus
// raises a note for the session; the raised order is saved with that note's next change, so clicking a note never
// marks it as edited. Narrow dashboards (4 columns or fewer) show the notes in a strip below the widgets instead.
//
// Exports: renderStickiesView(ctx), renderStickyLayer(ctx, { boardId }), createSticky(ctx, options), focusSticky(ctx, id),
// revealSticky(ctx, id), stickiesShown(ctx), setStickiesShown(ctx, on), boardStickyNotes(ctx, boardId), init(ctx) and
// the pure helpers below (unit-tested in tests/stickies-ui.test.mjs).
// Actions: 'stickies.new' (options in data-color / data-board) and the other 'stickies.*' actions at the end of the file.
import { html, cx, plural } from './html.js';
import { icon } from './icons.js';
import { registerActions, registerMount } from './runtime.js';
import { registerPopover } from './overlay.js';
import { button, iconButton, searchField, segmented, emptyState } from './components.js';
import { latestItem, rememberItem, openNote, titleValue } from './note-editor.js';
import { STICKY_COLORS, STICKY_DEFAULTS, STICKY_LIMITS } from '../lib/store.js';
import { noteExcerpt, noteTitleFromContent, toggleTask } from '../lib/notes.js';
import { renderMarkdown, inlineText } from '../lib/markdown.js';
import { settingsGroup, patchGroup } from '../lib/settings-schema.js';
import { getDashboard, activeBoard, setDashboardPrefs } from '../lib/dashboard-store.js';

export { STICKY_COLORS, STICKY_DEFAULTS, STICKY_LIMITS };
export const STICKY_COLOR_LABELS = Object.freeze({
  yellow: 'Yellow', orange: 'Orange', pink: 'Pink', purple: 'Purple', blue: 'Blue', green: 'Green', gray: 'Gray',
});
const SAVE_DELAY = 500;
const DEFAULT_STAGE_WIDTH = 1100;
const KEY_STEP = 8;          // arrow keys move or resize by this many pixels (Alt: 1px for fine placement)
const DOCK_COLUMNS = 4;      // dashboards this narrow line the notes up in a strip instead of floating them
const DRAG_SLOP = 3;

/* ------------------------------------------------------------------ pure helpers (unit-tested) */

const isLive = item => !!item && !item.deletedAt && !item.archived;
export const isSticky = item => isLive(item) && item.type === 'note' && !!item.sticky && typeof item.sticky === 'object';
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round4 = value => Math.round(value * 10000) / 10000;

/** Live sticky notes in a stable order (oldest first), so typing in one never reorders the others. */
export function liveStickies(items = []) {
  return items.filter(isSticky).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
}

/** True when a sticky's board is this board, or '' (every board). */
export const onBoard = (sticky, boardId) => !sticky?.board || sticky.board === boardId;

/** Sticky notes that float on a board: on that board (or every board) and not hidden. */
export function boardStickies(items = [], boardId = '') {
  return liveStickies(items).filter(note => !note.sticky.hidden && onBoard(note.sticky, boardId));
}

/** Width actually drawn: the stored width, never wider than the stage. */
export const shownWidth = (w, stageWidth) => Math.max(0, Math.min(Number(w) || STICKY_DEFAULTS.w, Math.max(0, Number(stageWidth) || 0)));

/** Left edge in pixels for a 0..1 x on a stage this wide, kept inside the stage (mirrors the CSS clamp). */
export function leftFor(x, w, stageWidth) {
  const width = Math.max(0, Number(stageWidth) || 0);
  const max = Math.max(0, width - shownWidth(w, width));
  return clamp((Number(x) || 0) * width, 0, max);
}

/** The 0..1 x stored for a left edge on a stage this wide. */
export function fractionFor(left, stageWidth) {
  const width = Number(stageWidth) || 0;
  return width > 0 ? round4(clamp((Number(left) || 0) / width, 0, 1)) : 0;
}

/**
 * Clamps a placement being dragged or resized on a stage `stageWidth` pixels wide. Takes and returns pixel values
 * { left, y, w, h }: the note stays inside the stage horizontally, never above the top, and within the size limits.
 */
export function clampPlacement({ left = 0, y = 0, w = STICKY_DEFAULTS.w, h = STICKY_DEFAULTS.h } = {}, stageWidth = DEFAULT_STAGE_WIDTH) {
  const L = STICKY_LIMITS;
  const stage = Math.max(0, Number(stageWidth) || 0);
  const width = Math.round(clamp(Number(w) || L.minW, L.minW, L.maxW));
  const height = Math.round(clamp(Number(h) || L.minH, L.minH, L.maxH));
  const drawn = Math.min(width, stage);
  return {
    left: Math.round(clamp(Number(left) || 0, 0, Math.max(0, stage - drawn))),
    y: Math.round(clamp(Number(y) || 0, 0, L.maxY)),
    w: width,
    h: height,
  };
}

/** Resize clamp: the width also stops at the stage's inline end, so the corner never leaves the stage. */
export function clampResize({ left = 0, w, h }, stageWidth = DEFAULT_STAGE_WIDTH) {
  const L = STICKY_LIMITS;
  const room = Math.max(L.minW, (Number(stageWidth) || 0) - (Number(left) || 0));
  return { w: Math.round(clamp(Number(w) || L.minW, L.minW, Math.min(L.maxW, room))), h: Math.round(clamp(Number(h) || L.minH, L.minH, L.maxH)) };
}

/** The z for a note brought to the front: one above every other note (0 when there are no others). */
export function nextZ(stickies = [], exceptId = '') {
  let max = -1;
  for (const note of stickies) if (note && note.id !== exceptId) max = Math.max(max, Number(note.sticky?.z ?? note.z) || 0);
  return Math.min(STICKY_LIMITS.maxZ, max + 1);
}

/**
 * Where a new note goes: near the top inline-end corner of the visible part of the stage, stepping down and inward
 * past notes already sitting there so a run of new notes fans out instead of stacking exactly. Returns { x, y }.
 */
export function placeNewSticky(existing = [], { stageWidth = DEFAULT_STAGE_WIDTH, top = STICKY_DEFAULTS.y, w = STICKY_DEFAULTS.w, margin = 24, step = 28 } = {}) {
  const stage = Math.max(1, Number(stageWidth) || DEFAULT_STAGE_WIDTH);
  const width = shownWidth(w, stage);
  const spots = existing.map(note => {
    const s = note.sticky || note;
    return { left: leftFor(s.x, s.w, stage), y: Number(s.y) || 0 };
  });
  let left = Math.max(0, stage - width - margin);
  let y = Math.max(0, Math.round(Number(top) || 0));
  for (let i = 0; i < 24 && spots.some(spot => Math.abs(spot.left - left) < step / 2 && Math.abs(spot.y - y) < step / 2); i++) {
    left = Math.max(0, left - step);
    y += step;
  }
  return { x: fractionFor(left, stage), y };
}

/** The saveItem input for a new sticky note (createSticky's defaults). */
export function newStickyInput({ board = '', color = STICKY_DEFAULTS.color, content = '', x = STICKY_DEFAULTS.x, y = STICKY_DEFAULTS.y,
  w = STICKY_DEFAULTS.w, h = STICKY_DEFAULTS.h, z = 0 } = {}) {
  const text = String(content || '');
  return {
    type: 'note', title: noteTitleFromContent(text), content: text, excerpt: noteExcerpt(text), collectionId: '',
    sticky: { color: STICKY_COLORS.includes(color) ? color : STICKY_DEFAULTS.color, board: String(board || ''), x, y, w, h, z, hidden: false },
  };
}

/** The title a sticky keeps after an edit: its first line, unless someone gave the note a title of its own. */
export function stickyTitleAfterEdit(note, content) {
  const current = titleValue(note?.title).trim();
  const derived = noteTitleFromContent(content);
  if (!current || current === noteTitleFromContent(note?.content || '')) return derived;
  return null;
}

/** Display name: the note's title, else its first line, else "Empty sticky note". */
export function stickyName(note) {
  return titleValue(note?.title).trim() || noteTitleFromContent(note?.content || '') || 'Empty sticky note';
}

const TASK_PREFIX = /^\s*[-*+]\s+\[( |x|X)\](?:\s+|$)/;
const BULLET_PREFIX = /^\s*(?:[-*+]|\d+[.)])\s+/;
/** Plain text for small previews (the widget's mini notes): Markdown markers dropped, tasks as ☐ / ☑, lines kept. */
export function stickyPlainText(content = '', max = 160) {
  const lines = String(content).split('\n').map(line => {
    const task = TASK_PREFIX.exec(line);
    if (task) return `${task[1] === ' ' ? '☐' : '☑'} ${inlineText(line.slice(task[0].length))}`;
    if (BULLET_PREFIX.test(line)) return `• ${inlineText(line.replace(BULLET_PREFIX, ''))}`;
    return inlineText(line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>\s?/, ''));
  });
  const text = lines.filter((line, i) => line.trim() || (i > 0 && lines[i - 1].trim())).join('\n').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Corkboard filter: free text over title and content, a color, and where it shows ('all' | 'shown' | 'hidden'). */
export function filterStickies(notes = [], { query = '', color = '', show = 'all' } = {}) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return notes.filter(note => {
    if (color && note.sticky.color !== color) return false;
    if (show === 'shown' && note.sticky.hidden) return false;
    if (show === 'hidden' && !note.sticky.hidden) return false;
    if (!terms.length) return true;
    const haystack = `${note.title || ''}\n${note.content || ''}`.toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}

/* ------------------------------------------------------------------ shared state */

// Placement shown while a change is in flight or a gesture is under way: id -> { patch, seq }.
const overrides = new Map();
// Session-only stacking (focus raises a note without writing): id -> z.
const raised = new Map();
// Ids whose editor should take focus as soon as it mounts.
const pendingFocus = new Set();
// Mounted editors (to flush on page hide).
const editors = new Set();
let overrideSeq = 0;

/** The newest copy of a sticky note with its pending placement applied (null when it is not a live sticky). */
function stickyOf(ctx, id) {
  const note = latestItem(ctx, id);
  if (!isSticky(note)) return null;
  const patch = overrides.get(id)?.patch;
  const z = raised.get(id);
  if (!patch && z === undefined) return note;
  return { ...note, sticky: { ...note.sticky, ...(patch || {}), ...(z === undefined ? {} : { z }) } };
}

// Notes created here that the library may not have delivered yet (so a new note shows, and takes focus, at once).
const created = new Set();

// The library's sticky notes, recomputed only when the library changes (selectors return the same live array until then).
let memo = { live: null, list: [] };
function libraryStickies(live) {
  if (memo.live !== live) memo = { live, list: liveStickies(live) };
  return memo.list;
}

/** Every live sticky note, freshest copies with overrides applied, in stable order. */
function allStickies(ctx) {
  const live = ctx.select.live();
  const stored = libraryStickies(live);
  const notes = stored.map(note => stickyOf(ctx, note.id)).filter(Boolean);
  if (created.size) {
    for (const id of created) {
      if (live.some(item => item.id === id)) { created.delete(id); continue; }
      const note = stickyOf(ctx, id);
      if (note) notes.push(note);
    }
  }
  return notes;
}

/** Visible floating notes for a dashboard board (also used by the sticky notes widget). */
export function boardStickyNotes(ctx, boardId, { includeHidden = false } = {}) {
  return allStickies(ctx).filter(note => onBoard(note.sticky, boardId) && (includeHidden || !note.sticky.hidden));
}

const boardsList = () => getDashboard()?.boards || [];
const boardName = id => boardsList().find(board => board.id === id)?.name || '';

/** True when the dashboard shows its floating sticky notes (Settings → New tab, the Customize menu and the widget). */
export function stickiesShown(ctx) {
  return settingsGroup(ctx.library?.settings || {}, 'dashboard').stickies !== false && !getDashboard()?.prefs?.stickiesHidden;
}

/** Shows or hides the floating layer on every board. One switch, shared with Settings and the dashboard's Customize menu. */
export async function setStickiesShown(ctx, on) {
  const dash = settingsGroup(ctx.library?.settings || {}, 'dashboard');
  const writes = [];
  if ((dash.stickies !== false) !== on) writes.push(patchGroup(ctx.store, ctx.library?.settings || {}, 'dashboard', { stickies: on }));
  // An older per-device switch (dashboard prefs) also hid the layer; clear it so "show" always shows.
  if (on && getDashboard()?.prefs?.stickiesHidden) writes.push(setDashboardPrefs({ stickiesHidden: false }));
  await Promise.all(writes);
}

/** Saves a sticky placement patch, showing it at once. Pending raises ride along with it. */
async function patchSticky(ctx, id, patch, { render = true } = {}) {
  const entry = { patch: { ...(overrides.get(id)?.patch || {}), ...patch }, seq: ++overrideSeq };
  overrides.set(id, entry);
  if (render) ctx.render();
  const z = raised.get(id);
  try {
    const item = await ctx.store.updateItem(id, { sticky: { ...patch, ...(z === undefined ? {} : { z }) } });
    rememberItem(item);
    if (z !== undefined && raised.get(id) === z) raised.delete(id);
    return item;
  } finally {
    if (overrides.get(id)?.seq === entry.seq) overrides.delete(id);
    ctx.render();
  }
}

/** Keeps a gesture's placement in the override map without saving or re-rendering (the element is styled directly). */
function setLivePlacement(id, patch) {
  overrides.set(id, { patch: { ...(overrides.get(id)?.patch || {}), ...patch }, seq: ++overrideSeq });
}

/** Raises a note above the others on its board for this session (saved with its next change). */
function bringToFront(ctx, id) {
  const note = stickyOf(ctx, id);
  if (!note || note.sticky.hidden) return;
  // A floating note is on the active board (its own board, or every board).
  const others = boardStickyNotes(ctx, activeBoard()?.id || '').filter(other => other.id !== id);
  if (!others.length || others.every(other => other.sticky.z < note.sticky.z)) return;
  raised.set(id, nextZ(others));
  // Restyle in place: re-rendering the layer for a z-index change is not worth a frame.
  for (const el of document.querySelectorAll(`.sticky.is-floating[data-sticky="${CSS.escape(id)}"]`)) el.style.zIndex = String(raised.get(id) + 1);
}

/* ------------------------------------------------------------------ creating and saving */

function stageGeometry() {
  const stage = typeof document !== 'undefined' ? document.querySelector('.dashboard .dash-stage') : null;
  if (!stage) return { stageWidth: DEFAULT_STAGE_WIDTH, top: STICKY_DEFAULTS.y };
  const rect = stage.getBoundingClientRect();
  return { stageWidth: stage.clientWidth || DEFAULT_STAGE_WIDTH, top: Math.max(STICKY_DEFAULTS.y, Math.round(STICKY_DEFAULTS.y - rect.top + 8)) };
}

const onDashboard = ctx => !ctx.env?.isSidepanel && ctx.state?.view === 'dashboard';

/**
 * Creates a sticky note and focuses its editor. On the dashboard it lands on the active board near the top of the
 * visible area; from anywhere else it shows on every board. Options: boardId, color, content, x, y, focus.
 * Returns the saved item.
 */
export async function createSticky(ctx, { boardId, color, content = '', x, y, focus = true } = {}) {
  const board = typeof boardId === 'string' ? boardId : onDashboard(ctx) ? activeBoard()?.id || '' : '';
  const everyNote = liveStickies(ctx.select?.live?.() || []);
  const neighbours = everyNote.filter(note => !note.sticky.hidden && (!board || onBoard(note.sticky, board)));
  const spot = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : placeNewSticky(neighbours, onDashboard(ctx) ? stageGeometry() : {});
  const view = ctx.state?.stickies;
  const pick = STICKY_COLORS.includes(color) ? color : STICKY_COLORS.includes(view?.color) && ctx.state?.view === 'stickies' ? view.color : STICKY_DEFAULTS.color;
  const item = rememberItem(await ctx.store.saveItem(newStickyInput({ board, color: pick, content, ...spot, z: nextZ(everyNote) })));
  created.add(item.id);
  // The new note must be visible where it was made: clear corkboard filters that would hide it, and show the layer.
  if (view && ctx.state?.view === 'stickies') Object.assign(view, { query: '', show: view.show === 'hidden' ? 'all' : view.show });
  if (onDashboard(ctx) && !stickiesShown(ctx)) await setStickiesShown(ctx, true);
  if (focus) {
    if (ctx.env?.isSidepanel) openNote(ctx, item.id, { focus: 'body' });
    else pendingFocus.add(item.id);
  }
  // The side panel has no dashboard: say where the note went (its editor opens here).
  if (ctx.env?.isSidepanel) ctx.toast?.('Sticky note added. It floats on your dashboard and stays in Notes.');
  ctx.render?.();
  return item;
}

async function saveContent(ctx, id, content) {
  const note = latestItem(ctx, id);
  if (!note || note.type !== 'note' || (note.content || '') === content) return;
  const patch = { content, excerpt: noteExcerpt(content) };
  const title = stickyTitleAfterEdit(note, content);
  if (title !== null) patch.title = title;
  const z = raised.get(id);
  if (z !== undefined && note.sticky) patch.sticky = { z };
  rememberItem(await ctx.store.updateItem(id, patch));
  if (z !== undefined && raised.get(id) === z) raised.delete(id);
}

/** Focuses a sticky note's editor (now, or as soon as it mounts). */
export function focusSticky(ctx, id, { scroll = true } = {}) {
  const area = typeof document !== 'undefined' ? [...document.querySelectorAll(`[data-sticky-text="${CSS.escape(id)}"]`)].find(el => el.offsetParent !== null) : null;
  if (!area) { pendingFocus.add(id); ctx.render(); return; }
  focusArea(area, { scroll });
}

/** Brings a sticky note into view on the dashboard: shows it (and the layer) if hidden, then focuses its editor. */
export async function revealSticky(ctx, id) {
  const note = stickyOf(ctx, id);
  if (!note) return;
  const writes = [];
  if (note.sticky.hidden) writes.push(patchSticky(ctx, id, { hidden: false }));
  if (!stickiesShown(ctx)) writes.push(setStickiesShown(ctx, true));
  await Promise.all(writes);
  bringToFront(ctx, id);
  focusSticky(ctx, id);
}

const reducedMotion = () => document.documentElement.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;
// enter: a new note fades and scales in; lift: an existing note pulses once to say "this one". Reduced motion skips
// both (the focus ring already shows where the caret is).
function focusArea(area, { scroll = true, enter = false, lift = !enter } = {}) {
  const card = area.closest('.sticky');
  if (scroll) card?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  area.focus({ preventScroll: true });
  const end = area.value.length;
  try { area.setSelectionRange(end, end); } catch {}
  if (!card || reducedMotion() || typeof card.animate !== 'function') return;
  const easing = 'cubic-bezier(0.2, 0, 0, 1)';
  if (enter) card.animate([{ opacity: 0, transform: 'scale(0.96) translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing });
  else if (lift) card.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.03)' }, { transform: 'scale(1)' }], { duration: 320, easing });
}

// The editor, owned by this mount: a rendered preview (Markdown, with tickable tasks and working links) over a plain
// textarea. Clicking the preview, or tabbing to the textarea, switches to editing; the textarea stays in the tab order
// while the preview shows (it is transparent, not hidden), and the preview's checkboxes and links come before it.
// Saves 500 ms after typing stops, on blur and when the page hides.
registerMount('stickies.editor', (el, ctx) => {
  const id = el.dataset.id;
  const preview = document.createElement('div');
  preview.className = 'sticky-preview markdown-body is-compact';
  const area = document.createElement('textarea');
  area.className = 'sticky-text';
  area.id = `sticky-text-${el.dataset.surface || 'x'}-${id}`;
  area.placeholder = 'Write something…';
  area.spellcheck = true;
  area.dataset.stickyText = id;
  area.setAttribute('aria-label', el.dataset.label || 'Sticky note');
  // Each note follows its own text direction (a Hebrew note in an English UI, and the other way round).
  area.dir = 'auto';
  preview.dir = 'auto';
  area.value = latestItem(ctx, id)?.content || '';
  el.replaceChildren(preview, area);
  let shown = null;
  const paint = () => {
    const content = area.value;
    el.classList.toggle('is-empty', !content.trim());
    if (content === shown) return;
    shown = content;
    preview.innerHTML = content.trim() ? renderMarkdown(content, { interactiveTasks: true }) : '';
  };
  paint();
  let timer = 0;
  let dirty = false;
  let saving = Promise.resolve();
  const flush = () => {
    clearTimeout(timer);
    timer = 0;
    if (!dirty) return saving;
    dirty = false;
    const value = area.value;
    saving = saving.then(() => ctx.run(() => saveContent(ctx, id, value)));
    return saving;
  };
  const onInput = () => { dirty = true; clearTimeout(timer); timer = setTimeout(flush, SAVE_DELAY); };
  const onFocus = () => el.classList.add('is-editing');
  const onBlur = () => { el.classList.remove('is-editing'); paint(); flush(); };
  const onKey = event => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    const card = el.closest('.sticky');
    (card?.querySelector('.sticky-grip') || card?.querySelector('.sticky-dot'))?.focus();
  };
  // A click on the text (not on a checkbox, link or toggle) starts editing with the caret at the end.
  const onPreviewClick = event => {
    if (event.target instanceof Element && event.target.closest('a, input, label, summary, button')) return;
    if (String(globalThis.getSelection?.() || '')) return;
    focusArea(area, { scroll: false, lift: false });
  };
  const onPreviewChange = event => {
    const box = event.target;
    if (!(box instanceof HTMLInputElement) || box.type !== 'checkbox') return;
    const index = Number(box.dataset.taskIndex);
    if (!Number.isInteger(index)) return;
    const next = toggleTask(area.value, index, box.checked);
    if (next === area.value) return;
    area.value = next;
    dirty = true;
    paint();
    flush();
  };
  area.addEventListener('input', onInput);
  area.addEventListener('focus', onFocus);
  area.addEventListener('blur', onBlur);
  area.addEventListener('keydown', onKey);
  preview.addEventListener('click', onPreviewClick);
  preview.addEventListener('change', onPreviewChange);
  const instance = { id, flush };
  editors.add(instance);
  if (pendingFocus.has(id)) {
    pendingFocus.delete(id);
    requestAnimationFrame(() => { if (area.isConnected) focusArea(area, { enter: true }); });
  }
  return {
    update(next) {
      const note = latestItem(next, id);
      if (!note || dirty || document.activeElement === area) return;
      const content = note.content || '';
      if (area.value !== content) area.value = content;
      const label = `Sticky note: ${stickyName(note)}`;
      if (area.getAttribute('aria-label') !== label) area.setAttribute('aria-label', label);
      paint();
    },
    destroy() {
      flush();
      editors.delete(instance);
      area.removeEventListener('input', onInput);
      area.removeEventListener('focus', onFocus);
      area.removeEventListener('blur', onBlur);
      area.removeEventListener('keydown', onKey);
      preview.removeEventListener('click', onPreviewClick);
      preview.removeEventListener('change', onPreviewChange);
    },
  };
});

/* ------------------------------------------------------------------ shared markup */

const colorLabel = color => STICKY_COLOR_LABELS[color] || STICKY_COLOR_LABELS.yellow;

function colorButton(ctx, note, surface) {
  const color = note.sticky.color;
  const open = ctx.state.popover?.name === 'stickies.colors' && ctx.state.popover.props?.id === note.id && ctx.state.popover.props?.surface === surface;
  return html`<button type="button" class="sticky-dot" data-action="stickies.colors" data-id="${note.id}" data-surface="${surface}"
    aria-label="Color: ${colorLabel(color)}. Change color" data-tooltip="Change color" aria-haspopup="menu" aria-expanded="${open ? 'true' : 'false'}">
    <span class="sticky-swatch" data-color="${color}" aria-hidden="true"></span></button>`;
}

function menuButton(ctx, note, surface) {
  const open = ctx.state.popover?.anchorEl?.dataset?.action === 'stickies.menu' && ctx.state.popover.anchorEl.dataset.id === note.id;
  return iconButton({ icon: 'ellipsis', label: `Actions for ${stickyName(note)}`, action: 'stickies.menu', data: { id: note.id, surface }, size: 'sm',
    className: 'sticky-btn', expanded: open, tooltipPlacement: 'bottom end' });
}

/** Where a note shows, for its card: hidden, a board name, or nothing when there is only one board to show it on. */
function placeLabel(note) {
  if (note.sticky.hidden) return { icon: 'eye-off', text: 'Hidden', tone: 'hidden' };
  const boards = boardsList();
  if (!note.sticky.board) return boards.length > 1 ? { icon: 'layout-dashboard', text: 'All boards' } : null;
  const name = boardName(note.sticky.board);
  if (!name) return { icon: 'circle-alert', text: 'Board removed', tone: 'warning' };
  return boards.length > 1 ? { icon: 'layout-dashboard', text: name } : null;
}

function editor(note, surface) {
  return html`<div class="sticky-editor" data-mount="stickies.editor" data-morph="skip" data-key="sticky-ed-${surface}-${note.id}"
    data-id="${note.id}" data-surface="${surface}" data-label="Sticky note: ${stickyName(note)}"></div>`;
}

/** A corkboard card (the Sticky notes view, and the strip a narrow dashboard shows instead of floating notes). */
function stickyCard(ctx, note, surface) {
  const place = placeLabel(note);
  return html`<article class="${cx('sticky', 'is-card', note.sticky.hidden && 'is-hidden')}" data-key="sticky-${surface}-${note.id}" data-sticky="${note.id}"
    data-color="${note.sticky.color}" aria-label="Sticky note: ${stickyName(note)}">
    <div class="sticky-bar">
      ${colorButton(ctx, note, surface)}
      ${place ? html`<span class="${cx('sticky-place', place.tone && `is-${place.tone}`)}" title="${place.text}">${icon(place.icon, { size: 12 })}<span class="sticky-place-text">${place.text}</span></span>` : ''}
      <span class="sticky-bar-spacer"></span>
      ${menuButton(ctx, note, surface)}
    </div>
    ${editor(note, surface)}
    <footer class="sticky-foot"><time datetime="${note.updatedAt}">${editedText(note.updatedAt)}</time></footer>
  </article>`;
}

function editedText(iso) {
  const time = Date.parse(iso);
  if (!time) return '';
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return 'Edited just now';
  if (minutes < 60) return `Edited ${plural(minutes, 'minute')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Edited ${plural(hours, 'hour')} ago`;
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return `Edited ${date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

const moveHelp = () => html`<p id="stickies-move-help" class="sr-only" data-key="stickies-move-help">Arrow keys move the note. Shift and arrow keys resize it. Hold Alt for 1-pixel steps.</p>`;

/** A floating note on the dashboard. */
function floatingSticky(ctx, note) {
  const s = note.sticky;
  const name = stickyName(note);
  return html`<article class="${cx('sticky', 'is-floating', gesture?.id === note.id && (gesture.kind === 'move' ? 'is-dragging' : 'is-resizing'))}" data-key="sticky-float-${note.id}" data-sticky="${note.id}" data-color="${s.color}"
    style="--sx:${s.x};--sy:${s.y}px;--sw:${s.w}px;--sh:${s.h}px;z-index:${s.z + 1}" aria-label="Sticky note: ${name}">
    <div class="sticky-bar" data-sticky-drag>
      ${colorButton(ctx, note, 'float')}
      <button type="button" class="sticky-grip" data-sticky-grip data-keydown="stickies.grip-key" data-id="${note.id}" aria-label="Move or resize ${name}"
        aria-describedby="stickies-move-help" data-tooltip="Drag to move">${icon('grip-horizontal', { size: 16 })}</button>
      ${menuButton(ctx, note, 'float')}
      ${iconButton({ icon: 'x', label: `Hide ${name}`, action: 'stickies.hide', data: { id: note.id }, size: 'sm', className: 'sticky-btn', tooltipPlacement: 'bottom end' })}
    </div>
    ${editor(note, 'float')}
    <span class="sticky-resize" data-sticky-resize data-id="${note.id}" aria-hidden="true"></span>
  </article>`;
}

/* ------------------------------------------------------------------ dashboard layer */

/**
 * Floating sticky notes for a dashboard board (and the notes shown on every board), absolutely positioned inside the
 * dashboard stage. On narrow dashboards (4 columns or fewer) the notes line up in a scrollable strip instead, so they
 * never cover widgets that cannot be scrolled out from under them. Returns '' when the board has none.
 */
export function renderStickyLayer(ctx, { boardId = '' } = {}) {
  const notes = boardStickyNotes(ctx, boardId);
  if (!notes.length) return '';
  const editing = !!ctx.state.dash?.editing;
  const docked = (ctx.state.dash?.cols || 12) <= DOCK_COLUMNS;
  if (docked) {
    const newest = [...notes].reverse();
    return html`<section class="stickies-layer is-docked" data-key="stickies-layer-docked" aria-labelledby="stickies-strip-title" ${editing ? html`inert` : ''}>
      <header class="stickies-strip-head">
        <h2 class="stickies-strip-title" id="stickies-strip-title">${icon('sticker', { size: 16 })}<span>Sticky notes</span><span class="stickies-strip-count">${notes.length}</span></h2>
        ${iconButton({ icon: 'plus', label: 'New sticky note', action: 'stickies.new', data: { board: boardId }, size: 'sm' })}
      </header>
      <ul class="stickies-strip" role="list">${newest.map(note => html`<li class="stickies-strip-cell" data-key="strip-${note.id}">${stickyCard(ctx, note, 'strip')}</li>`)}</ul>
    </section>`;
  }
  return html`<div class="${cx('stickies-layer', editing && 'is-muted')}" data-key="stickies-layer" ${editing ? html`inert` : ''}>
    ${moveHelp()}
    ${notes.map(note => floatingSticky(ctx, note))}
  </div>`;
}

/* ------------------------------------------------------------------ the Sticky notes view */

const SHOW_OPTIONS = [{ value: 'all', label: 'All' }, { value: 'shown', label: 'On dashboard' }, { value: 'hidden', label: 'Hidden' }];
const viewState = ctx => (ctx.state.stickies ||= { query: '', color: '', show: 'all' });

function colorFilter(ctx, notes, current) {
  const counts = {};
  for (const note of notes) counts[note.sticky.color] = (counts[note.sticky.color] || 0) + 1;
  const option = (value, label, count, swatch) => html`<button type="button" role="radio" class="${cx('stickies-filter', swatch && 'is-swatch')}"
    aria-checked="${current === value ? 'true' : 'false'}" tabindex="${current === value ? '0' : '-1'}" data-action="stickies.filter-color" data-value="${value}"
    ${swatch ? html`aria-label="${label}, ${count}" data-tooltip="${label}"` : ''}>
    ${swatch ? html`<span class="sticky-swatch" data-color="${value}" aria-hidden="true"></span>` : html`<span>${label}</span>`}</button>`;
  return html`<div class="stickies-filters" role="radiogroup" aria-label="Filter by color">
    ${option('', 'All colors', notes.length, false)}
    ${STICKY_COLORS.filter(color => counts[color] || current === color).map(color => option(color, colorLabel(color), counts[color] || 0, true))}
  </div>`;
}

/** Main-area renderer for the 'stickies' view: header with filters, then the corkboard. */
export function renderStickiesView(ctx) {
  const s = viewState(ctx);
  const all = allStickies(ctx).reverse();
  const shown = filterStickies(all, s);
  const filtered = !!(s.query.trim() || s.color || s.show !== 'all');
  let body;
  if (!all.length) {
    body = emptyState({ icon: 'sticker', title: 'No sticky notes yet',
      body: 'Jot quick thoughts on sticky notes. They float on your dashboard and stay in Notes and search like any note.',
      actions: button({ label: 'New sticky note', icon: 'plus', variant: 'primary', action: 'stickies.new' }) });
  } else if (!shown.length) {
    body = emptyState({ icon: 'search', title: s.query.trim() ? `No sticky notes match “${s.query.trim()}”` : 'No sticky notes match these filters',
      body: 'Try another color or clear the filters to see every note.',
      actions: button({ label: 'Clear filters', icon: 'filter-x', action: 'stickies.clear-filters' }) });
  } else {
    body = html`<ul class="stickies-board" role="list" aria-label="Sticky notes">${shown.map(note => html`<li class="stickies-cell" data-key="cell-${note.id}">${stickyCard(ctx, note, 'board')}</li>`)}</ul>`;
  }
  const hidden = all.filter(note => note.sticky.hidden).length;
  return html`<div class="stickies-view" data-key="stickies-view">
    <header class="stickies-head">
      <div class="stickies-head-inner">
        <div class="stickies-title-row">
          <h1 class="stickies-title" id="stickies-title" tabindex="-1">Sticky notes</h1>
          <span class="stickies-count">${all.length.toLocaleString()}<span class="sr-only"> ${all.length === 1 ? 'note' : 'notes'}</span></span>
          <span class="stickies-spacer"></span>
          ${all.length && !stickiesShown(ctx) ? button({ label: 'Show on dashboard', icon: 'eye', variant: 'ghost', size: 'sm', action: 'stickies.show-layer' }) : ''}
          ${button({ label: 'New sticky note', icon: 'plus', variant: 'primary', size: 'sm', action: 'stickies.new' })}
        </div>
        <p class="stickies-lede">${all.length && !stickiesShown(ctx)
          ? 'Sticky notes are hidden on the dashboard right now. They are still here, in Notes and in search.'
          : 'Quick notes that float on your dashboard. Each one is also a note, so Notes, search and the assistant can find it.'}</p>
        ${all.length ? html`<div class="stickies-tools">
          ${searchField({ value: s.query, placeholder: 'Search sticky notes', action: 'stickies.query', id: 'stickies-search', label: 'Search sticky notes', clearAction: 'stickies.clear-query', className: 'stickies-search' })}
          ${colorFilter(ctx, all, s.color)}
          ${segmented({ name: 'show', value: s.show, action: 'stickies.filter-show', size: 'sm', ariaLabel: 'Show', className: 'stickies-show',
            options: SHOW_OPTIONS.map(option => ({ ...option, count: option.value === 'hidden' ? hidden : undefined })) })}
        </div>` : ''}
        ${filtered && shown.length ? html`<p class="sr-only" role="status">${plural(shown.length, 'sticky note')} shown</p>` : ''}
      </div>
    </header>
    <div class="stickies-body">${body}</div>
  </div>`;
}

/* ------------------------------------------------------------------ menus */

function stickyMenu(ctx, note, surface) {
  const s = note.sticky;
  const boards = boardsList();
  const orphan = s.board && !boards.some(board => board.id === s.board);
  const setBoard = board => patchSticky(ctx, note.id, { board, ...(s.hidden ? { hidden: false } : {}) });
  return [
    { label: 'Change color', icon: 'palette', run: () => openColors(ctx, note.id, surface) },
    s.hidden
      ? { label: 'Show on dashboard', icon: 'eye', run: () => patchSticky(ctx, note.id, { hidden: false }) }
      : { label: 'Hide from dashboard', icon: 'eye-off', run: () => hideSticky(ctx, note.id) },
    ...(boards.length > 1 || orphan ? [
      { heading: 'Show on' },
      { label: 'All boards', checked: !s.board, run: () => setBoard('') },
      ...boards.map(board => ({ label: board.name, checked: s.board === board.id, run: () => setBoard(board.id) })),
    ] : []),
    { separator: true },
    { label: 'Open in Notes', icon: 'notebook-pen', run: () => openInNotes(ctx, note.id) },
    { label: 'Turn into a regular note', icon: 'sticky-note', run: () => convertSticky(ctx, note.id) },
    { separator: true },
    { label: 'Move to Trash', icon: 'trash-2', danger: true, run: () => trashSticky(ctx, note.id) },
  ];
}

function openColors(ctx, id, surface) {
  const anchor = document.querySelector(`.sticky-dot[data-id="${CSS.escape(id)}"][data-surface="${CSS.escape(surface)}"]`);
  if (!anchor) return;
  ctx.openPopover('stickies.colors', anchor, { id, surface }, { placement: 'bottom-start' });
}

registerPopover('stickies.colors', (ctx, { id }) => {
  const current = stickyOf(ctx, id)?.sticky.color || STICKY_DEFAULTS.color;
  return html`<div class="menu sticky-colors" role="menu" aria-label="Sticky note color">
    ${STICKY_COLORS.map(color => html`<button type="button" class="menu-item sticky-color-item" role="menuitemradio" aria-checked="${color === current ? 'true' : 'false'}"
      data-action="stickies.set-color" data-id="${id}" data-color="${color}" tabindex="-1" ${color === current ? html`data-autofocus` : ''}>
      <span class="sticky-swatch" data-color="${color}" aria-hidden="true"></span><span class="menu-label">${colorLabel(color)}</span>
      ${color === current ? icon('check', { size: 16, className: 'sticky-color-check' }) : ''}</button>`)}
  </div>`;
}, { role: 'menu', className: 'popover-menu' });

async function hideSticky(ctx, id) {
  await patchSticky(ctx, id, { hidden: true });
  ctx.toast('Sticky note hidden from the dashboard. It stays in Sticky notes.', { action: { label: 'Undo', run: () => patchSticky(ctx, id, { hidden: false }) } });
}

async function trashSticky(ctx, id) {
  const note = latestItem(ctx, id);
  if (!note) return;
  rememberItem(await ctx.store.deleteItem(id));
  ctx.toast('Sticky note moved to Trash.', { action: { label: 'Undo', run: async () => rememberItem(await ctx.store.restoreItem(id)) } });
}

async function convertSticky(ctx, id) {
  rememberItem(await ctx.store.updateItem(id, { sticky: null }));
  ctx.toast('This is a regular note now. Find it in Notes.', { action: { label: 'Open in Notes', run: () => openInNotes(ctx, id) } });
}

function openInNotes(ctx, id) {
  // The side panel has no dashboard, so its Notes tab opens the note; full tabs switch to the Notes workspace.
  openNote(ctx, id, { focus: 'body' });
}

/* ------------------------------------------------------------------ pointer gestures (drag and resize) */

let gesture = null;

function startGesture(event) {
  if (event.button !== 0 || event.isPrimary === false) return;
  const target = event.target instanceof Element ? event.target : null;
  const resize = target?.closest('[data-sticky-resize]');
  const bar = resize ? null : target?.closest('[data-sticky-drag]');
  if (!resize && !bar) return;
  if (bar && target.closest('button:not([data-sticky-grip]), a, input, textarea, select')) return;
  const card = target.closest('.sticky.is-floating');
  const layer = card?.offsetParent;
  if (!card || !layer) return;
  const id = card.dataset.sticky;
  const ctx = gestureCtx;
  if (!ctx) return;
  event.preventDefault();
  bringToFront(ctx, id);
  gesture = {
    id, card, kind: resize ? 'resize' : 'move', pointerId: event.pointerId,
    startX: event.clientX, startY: event.clientY,
    left: card.offsetLeft, top: card.offsetTop, w: card.offsetWidth, h: card.offsetHeight,
    stageWidth: layer.clientWidth, moved: false, handle: resize || bar,
  };
  try { gesture.handle.setPointerCapture(event.pointerId); } catch {}
  card.classList.add(resize ? 'is-resizing' : 'is-dragging');
}

function moveGesture(event) {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const dx = event.clientX - gesture.startX;
  const dy = event.clientY - gesture.startY;
  if (!gesture.moved && Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
  gesture.moved = true;
  const { card } = gesture;
  if (gesture.kind === 'move') {
    const next = clampPlacement({ left: gesture.left + dx, y: gesture.top + dy, w: gesture.w, h: gesture.h }, gesture.stageWidth);
    const x = fractionFor(next.left, gesture.stageWidth);
    gesture.patch = { x, y: next.y };
    card.style.setProperty('--sx', String(x));
    card.style.setProperty('--sy', `${next.y}px`);
  } else {
    const size = clampResize({ left: gesture.left, w: gesture.w + dx, h: gesture.h + dy }, gesture.stageWidth);
    gesture.patch = size;
    card.style.setProperty('--sw', `${size.w}px`);
    card.style.setProperty('--sh', `${size.h}px`);
  }
  setLivePlacement(gesture.id, gesture.patch);
}

function endGesture(event) {
  if (!gesture || (event && event.pointerId !== gesture.pointerId)) return;
  const done = gesture;
  gesture = null;
  done.card.classList.remove('is-dragging', 'is-resizing');
  try { done.handle.releasePointerCapture(done.pointerId); } catch {}
  if (!done.moved || !done.patch || !gestureCtx) return;
  if (event?.type === 'pointercancel') { overrides.delete(done.id); gestureCtx.render(); return; }
  gestureCtx.run(() => patchSticky(gestureCtx, done.id, done.patch));
}

// Arrow keys on the grip: move (or Shift: resize) by 8px, Alt for 1px; Enter starts editing. Saved once the keys rest.
// Steps start from the note's current placement (not its laid-out box), so held-down keys never lag behind a frame.
const keyTimers = new Map();
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
function nudge(ctx, el, event) {
  const card = el.closest('.sticky.is-floating');
  const layer = card?.offsetParent;
  const note = card && stickyOf(ctx, card.dataset.sticky);
  if (!card || !layer || !note) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    const area = card.querySelector('.sticky-text');
    if (area) focusArea(area, { scroll: false, lift: false });
    return;
  }
  const dir = ARROWS[event.key];
  if (!dir) return;
  event.preventDefault();
  const step = event.altKey ? 1 : KEY_STEP;
  const stage = layer.clientWidth;
  const s = note.sticky;
  const left = leftFor(s.x, s.w, stage);
  let patch;
  if (event.shiftKey) {
    patch = clampResize({ left, w: s.w + dir[0] * step, h: s.h + dir[1] * step }, stage);
    card.style.setProperty('--sw', `${patch.w}px`);
    card.style.setProperty('--sh', `${patch.h}px`);
  } else {
    const next = clampPlacement({ left: left + dir[0] * step, y: s.y + dir[1] * step, w: s.w, h: s.h }, stage);
    patch = { x: fractionFor(next.left, stage), y: next.y };
    card.style.setProperty('--sx', String(patch.x));
    card.style.setProperty('--sy', `${patch.y}px`);
  }
  bringToFront(ctx, note.id);
  setLivePlacement(note.id, patch);
  card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  clearTimeout(keyTimers.get(note.id));
  keyTimers.set(note.id, setTimeout(() => {
    keyTimers.delete(note.id);
    const pending = overrides.get(note.id)?.patch;
    if (pending) ctx.run(() => patchSticky(ctx, note.id, pending, { render: false }));
  }, 450));
}

/* ------------------------------------------------------------------ actions */

registerActions({
  'stickies.new': ({ ctx, data }) => createSticky(ctx, {
    color: STICKY_COLORS.includes(data?.color) ? data.color : undefined,
    boardId: typeof data?.board === 'string' ? data.board : undefined,
  }),
  'stickies.menu': ({ ctx, el, data }) => {
    const note = stickyOf(ctx, data.id);
    if (!note) return;
    ctx.openMenu(el, stickyMenu(ctx, note, data.surface || 'board'), { placement: 'bottom-end', label: `Actions for ${stickyName(note)}` });
  },
  'stickies.colors': ({ ctx, el, data }) => ctx.openPopover('stickies.colors', el, { id: data.id, surface: data.surface }, { placement: 'bottom-start' }),
  'stickies.set-color': async ({ ctx, data }) => {
    ctx.closePopover();
    if (!STICKY_COLORS.includes(data.color)) return;
    await patchSticky(ctx, data.id, { color: data.color });
  },
  'stickies.hide': ({ ctx, data }) => hideSticky(ctx, data.id),
  'stickies.grip-key': ({ ctx, el, event }) => nudge(ctx, el, event),
  'stickies.query': ({ ctx, el }) => {
    clearTimeout(queryTimer);
    const value = el.value;
    queryTimer = setTimeout(() => { viewState(ctx).query = value; ctx.render(); }, 120);
  },
  'stickies.clear-query': ({ ctx }) => {
    viewState(ctx).query = '';
    ctx.render();
    ctx.nextFrame(() => document.getElementById('stickies-search')?.focus());
  },
  'stickies.clear-filters': ({ ctx }) => {
    Object.assign(viewState(ctx), { query: '', color: '', show: 'all' });
    ctx.render();
  },
  'stickies.filter-color': ({ ctx, data }) => {
    const value = STICKY_COLORS.includes(data.value) ? data.value : '';
    viewState(ctx).color = value;
    ctx.render();
  },
  'stickies.filter-show': ({ ctx, data }) => {
    viewState(ctx).show = SHOW_OPTIONS.some(option => option.value === data.value) ? data.value : 'all';
    ctx.render();
  },
  'stickies.show-layer': ({ ctx }) => setStickiesShown(ctx, true),
});
let queryTimer = 0;

/* ------------------------------------------------------------------ init */

let gestureCtx = null;
let initialized = false;
export function init(ctx) {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;
  gestureCtx = ctx;
  if (ctx.env.isSidepanel) return;
  document.addEventListener('pointerdown', startGesture);
  document.addEventListener('pointermove', moveGesture);
  document.addEventListener('pointerup', endGesture);
  document.addEventListener('pointercancel', endGesture);
  document.addEventListener('lostpointercapture', event => { if (gesture && event.pointerId === gesture.pointerId) endGesture(event); });
  // Focus (a click or Tab into a note) brings it to the front.
  document.addEventListener('focusin', event => {
    const card = event.target instanceof Element ? event.target.closest('.sticky.is-floating') : null;
    if (card) bringToFront(ctx, card.dataset.sticky);
  });
  // Unsaved text is written before the page goes away (closing the tab, switching away on the new tab page).
  const flushAll = () => { for (const instance of editors) instance.flush(); };
  addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });
}
