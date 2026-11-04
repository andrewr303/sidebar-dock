// Note editor host (SPEC §6.1, §12.2). renderNoteEditor and renderInlineEditor return an empty mount point; the
// 'note-editor' mount builds the editor once (toolbar, page path, title, meta row, block editor, AI preview card,
// subpages, backlinks, footer) and refreshes its declarative regions with morph() after every app render, so typing
// never re-renders the app. Saves are debounced, serialized per editor and revision-checked: a change made elsewhere
// reloads an editor without unsaved edits and raises a non-destructive conflict bar over unsaved ones. Unsaved text is
// mirrored to localStorage so a closed side panel never loses it. Subpages (lib/pages.js): "/page" and "Add subpage"
// create a note inside this one, the page path above the title leads back up, and "Move to page…" re-parents a note.
import { html, raw, cx, plural, safeSrc } from './html.js';
import { uploadItemImage, removeItemImage, iconMenuItems, customIcon } from './item-media.js';
import { morph } from './morph.js';
import { icon } from './icons.js';
import { registerMount, registerActions, registerShortcuts, hasAction } from './runtime.js';
import { researchOffered } from './research-view.js';
import { registerPopover } from './overlay.js';
import { button, iconButton, favicon, domainOf, relativeDate, colorVar, spinner, keyshortcuts, shortcutLabel, kbd, TYPE_ICONS, TYPE_LABELS } from './components.js';
import * as pickers from './pickers.js';
import { mountBlockEditor } from '../lib/block-editor.js';
import { renderMarkdown } from '../lib/markdown.js';
import { noteExcerpt, wordCount, linkResolver, resolveWikiLinks, toggleTask } from '../lib/notes.js';
import { leadingTitle } from '../lib/import/index.js';
import { openImport, openEmbed, itemEmbedMount, saveFileItem } from './note-import.js';
import { pageIndex, parentIdOf, descendantIds } from '../lib/pages.js';

export const UNTITLED = 'Untitled note';
const SAVE_DELAY = 600;
const DRAFT_KEY = 'still.notes.drafts.v1';
const DRAFT_TTL = 30 * 86400000;

/* ------------------------------------------------------------------ pure helpers (unit-tested) */

/** The title field shows the store's fallback title as empty, so the placeholder reads "Untitled". */
export const titleValue = title => (String(title ?? '').trim() === UNTITLED ? '' : String(title ?? ''));
/** What the store will keep for a typed title. */
export const normalizeTitle = title => String(title ?? '').replace(/\s+/g, ' ').trim() || UNTITLED;

/** Union of explicit links and resolved [[wiki link]] ids, without the note itself or duplicates, in first-seen order. */
export function mergeRelatedIds(existing = [], linked = [], selfId = '') {
  const out = [];
  for (const id of [...(existing || []), ...(linked || [])]) if (id && id !== selfId && !out.includes(id)) out.push(id);
  return out;
}

/** Minutes to read `words` at 230 words per minute (0 for an empty note). */
export const readingMinutes = words => (words > 0 ? Math.max(1, Math.round(words / 230)) : 0);

/**
 * How an editor reacts when the stored item differs from its base ({ title, text, updatedAt }):
 * 'same' (nothing new), 'rebase' (only other fields changed), 'own' (this editor's in-flight save landed),
 * 'reload' (changed elsewhere, no local edits), 'conflict' (changed elsewhere over local edits) or 'gone'.
 */
export function reconcile(base, latest, { dirty = false, pending = null, field = 'content', title = true } = {}) {
  if (!latest) return 'gone';
  if (!base || latest.updatedAt === base.updatedAt) return 'same';
  const matches = snap => !!snap && (latest[field] ?? '') === (snap.text ?? '') && (!title || (latest.title ?? '') === (snap.title ?? ''));
  if (matches(base)) return 'rebase';
  if (matches(pending)) return 'own';
  return dirty ? 'conflict' : 'reload';
}

/**
 * Applies an AI result to the note's Markdown. 'replace' swaps the selected range; 'below' adds the result as its own
 * paragraph after the line where the selection ends (or at the end of the note without a selection).
 */
export function applyAiResult(markdown, selection, result, mode = 'below') {
  const md = String(markdown ?? '');
  const text = String(result ?? '').trim();
  if (!text) return md;
  const start = Number(selection?.start), end = Number(selection?.end);
  const ranged = selection && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= md.length && start <= end;
  if (mode === 'replace' && ranged && end > start) return md.slice(0, start) + text + md.slice(end);
  let at = md.length;
  if (ranged) { const lineEnd = md.indexOf('\n', end); at = lineEnd < 0 ? md.length : lineEnd; }
  const before = md.slice(0, at).replace(/\s+$/, '');
  const after = md.slice(at).replace(/^\s*\n/, '').replace(/^\n+/, '');
  return `${before ? `${before}\n\n` : ''}${text}${after ? `\n\n${after}` : '\n'}`;
}

/** Candidates for the [[ link picker: title matches (prefix first), notes before other items, newest first. */
export function searchLinkCandidates(items, query, { exclude = '', limit = 8, collectionName = () => '' } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  const rows = [];
  for (const item of items || []) {
    if (!item || item.deletedAt || item.id === exclude || !String(item.title || '').trim()) continue;
    const at = q ? String(item.title).toLowerCase().indexOf(q) : 0;
    if (at < 0) continue;
    rows.push({ item, score: (at === 0 ? 0 : 1) + (item.type === 'note' ? 0 : 2) });
  }
  rows.sort((a, b) => a.score - b.score || String(b.item.updatedAt || '').localeCompare(String(a.item.updatedAt || '')));
  return rows.slice(0, limit).map(({ item }) => ({
    id: item.id, title: item.title, type: item.type,
    subtitle: item.type === 'note' ? collectionName(item.collectionId) || 'Note' : domainOf(item.url) || collectionName(item.collectionId) || '',
  }));
}

/**
 * The page path above a title: every ancestor while they fit, else the first one, an ellipsis standing for the
 * middle and the last `max - 1` (with room for fewer than three, only the ellipsis and the last `max`).
 * Returns [{ item } | { more: [items] }].
 */
export function crumbTrail(ancestors = [], max = 3) {
  const list = (ancestors || []).filter(Boolean);
  const limit = Math.max(1, Math.floor(max) || 1);
  if (list.length <= limit) return list.map(item => ({ item }));
  if (limit < 3) return [{ more: list.slice(0, list.length - limit) }, ...list.slice(-limit).map(item => ({ item }))];
  const tail = list.slice(-(limit - 1));
  return [{ item: list[0] }, { more: list.slice(1, list.length - tail.length) }, ...tail.map(item => ({ item }))];
}

/**
 * Items a note can move into ("Move to page…"): live items other than the note and its subpages (trashed ones too:
 * the store refuses loops through them), matched by title, prefix matches and notes first, then newest first.
 */
export function pageMoveCandidates(items, { id = '', query = '', limit = 30 } = {}) {
  const index = pageIndex(items || []);
  const blocked = new Set([id, ...descendantIds(index, id, { includeDeleted: true })]);
  const q = String(query ?? '').trim().toLowerCase();
  const rows = [];
  for (const item of index.byId.values()) {
    if (item.deletedAt || blocked.has(item.id) || !String(item.title || '').trim()) continue;
    const at = q ? String(item.title).toLowerCase().indexOf(q) : 0;
    if (at < 0) continue;
    rows.push({ item, score: (at === 0 ? 0 : 1) + (item.type === 'note' ? 0 : 2) });
  }
  rows.sort((a, b) => a.score - b.score || String(b.item.updatedAt || '').localeCompare(String(a.item.updatedAt || '')));
  return rows.slice(0, limit).map(row => row.item);
}

/** Live subpages (all levels) below these items, not counting the items themselves: Trash takes them along. */
export function subpagesMoving(library, ids = []) {
  const index = pageIndex(library || { items: [] });
  const chosen = new Set(ids), out = new Set();
  for (const id of ids) for (const sub of descendantIds(index, id)) if (!chosen.has(sub)) out.add(sub);
  return out.size;
}

/** What to do with a stored draft when an editor opens: 'none' | 'discard' (already saved) | 'restore' | 'conflict'. */
export function draftDecision(draft, item, { field = 'content', title = true } = {}) {
  if (!draft || !item) return 'none';
  const same = (draft.text ?? '') === (item[field] ?? '') && (!title || draft.title == null || normalizeTitle(draft.title) === (item.title ?? ''));
  if (same) return 'discard';
  return draft.base === item.updatedAt ? 'restore' : 'conflict';
}

/** Lowercase, deduplicated tags from an AI "a, b, c" answer merged after the current ones. */
export function mergeTagList(current = [], answer = '') {
  const out = [...(current || [])];
  const seen = new Set(out.map(tag => String(tag).toLowerCase()));
  for (const raw of String(answer).split(/[,\n]/)) {
    const tag = raw.replace(/^[\s#*-]+|[\s.]+$/g, '').toLowerCase();
    if (tag && tag.length <= 40 && !seen.has(tag)) { seen.add(tag); out.push(tag); }
  }
  return out;
}

export const AI_ACTIONS = [
  { id: 'continue', label: 'Continue writing', icon: 'pen-line', needsText: false, apply: 'insert', noSelection: true },
  { id: 'summarize', label: 'Summarize', icon: 'text', apply: 'insert' },
  { id: 'improve', label: 'Improve writing', icon: 'wand-sparkles', apply: 'replace' },
  { id: 'fix', label: 'Fix spelling and grammar', icon: 'check', apply: 'replace' },
  { id: 'shorter', label: 'Make shorter', icon: 'minimize-2', apply: 'replace' },
  { id: 'longer', label: 'Make longer', icon: 'maximize-2', apply: 'replace' },
  { id: 'extract-tasks', label: 'Extract tasks', icon: 'list-todo', apply: 'insert' },
  { id: 'explain', label: 'Explain', icon: 'lightbulb', apply: 'insert' },
  { id: 'translate', label: 'Translate', icon: 'languages', apply: 'replace' },
  { id: 'title', label: 'Suggest a title', icon: 'heading', apply: 'title' },
  { id: 'tags', label: 'Suggest tags', icon: 'tags', apply: 'tags' },
];
export const LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Japanese', 'Chinese (Simplified)', 'Korean', 'Hindi', 'Arabic', 'Russian'];

/* ------------------------------------------------------------------ shared state */

const hosts = new WeakMap();          // host element -> editor instance
const live = new Set();               // mounted instances
const fresh = new Map();              // id -> newest item returned by a write from this page (the library copy can lag)
const pendingFocus = new Map();       // id -> 'title' | 'body'
let active = null;                    // the editor that last had focus
let seq = 0;

/** Keeps a written item until the library snapshot catches up with it. */
export function rememberItem(item) {
  if (!item?.id) return item;
  const previous = fresh.get(item.id);
  if (!previous || String(item.updatedAt) >= String(previous.updatedAt)) fresh.set(item.id, item);
  return item;
}
/** The newest copy of an item: the library's, or a just-written one the library has not delivered yet. */
/** Asks before items move to Trash when Settings > General > "Confirm before moving items to Trash" is on. */
export async function confirmTrash(ctx, items) {
  if (ctx.library?.settings?.confirmDelete !== true || !items.length) return true;
  const title = items.length > 1 ? `Move ${plural(items.length, 'item')} to Trash?` : items[0].title ? `Move “${items[0].title}” to Trash?` : 'Move this item to Trash?';
  const subpages = subpagesMoving(ctx.library, items.map(item => item.id));
  const along = !subpages ? '' : subpages === 1 ? `${items.length > 1 ? 'One subpage' : 'Its subpage'} moves to Trash too. `
    : `${items.length > 1 ? 'Their' : 'Its'} ${plural(subpages, 'subpage')} move to Trash too. `;
  return ctx.confirm({ title, body: `${along}You can restore items from Trash until you empty it.`, confirmLabel: 'Move to Trash' });
}

export function latestItem(ctx, id) {
  const known = ctx.select.byId(id);
  const mine = fresh.get(id);
  if (!mine) return known;
  if (known && String(known.updatedAt) >= String(mine.updatedAt)) { fresh.delete(id); return known; }
  return mine;
}

/** Display title for lists: the stored title, else the first line of the note. */
export function displayTitle(note, firstLine = '') {
  const title = titleValue(note?.title).trim();
  return title || firstLine || UNTITLED;
}

let resolverStamp = null;
let resolver = () => null;
export function noteResolver(ctx) {
  const library = ctx.library;
  if (library?.updatedAt !== resolverStamp) { resolverStamp = library?.updatedAt; resolver = linkResolver(library?.items || []); }
  return resolver;
}

/** Opens a note in the notes editor of this surface. focus: 'title' | 'body' moves the caret there once it mounts. */
export function openNote(ctx, id, { focus, from } = {}) {
  if (!id) return;
  if (focus) pendingFocus.set(id, focus);
  const notes = ctx.state.notes || {};
  ctx.state.notes = { ...notes, noteId: id, returnTo: from || (ctx.env.isSidepanel && ctx.state.sideTab !== 'notes' ? ctx.state.sideTab : '') };
  if (ctx.env.isSidepanel) {
    ctx.state.panel = null;
    ctx.state.sideTab = 'notes';
    ctx.render();
    return;
  }
  const note = latestItem(ctx, id);
  const filter = ctx.state.notes.collectionId;
  if (note && filter && (filter === '__none' ? note.collectionId : note.collectionId !== filter)) ctx.state.notes.collectionId = '';
  if (ctx.state.panel?.kind === 'item') ctx.state.panel = null;
  if (ctx.state.view !== 'notes') ctx.navigate('notes', { keep: true }); else ctx.render();
}

/** Leaves the editor for `id` (after delete or archive, or the side panel back button). */
export function closeNote(ctx, id) {
  const notes = ctx.state.notes || {};
  if (id && notes.noteId !== id) return;
  const back = notes.returnTo;
  ctx.state.notes = { ...notes, noteId: null, returnTo: '' };
  if (ctx.env.isSidepanel && back && back !== 'notes') ctx.state.sideTab = back;
  ctx.render();
}

/**
 * Saves a new note item and remembers it so an editor can open before the library update arrives. With parentId the
 * note is a subpage of that item; without a collection of its own it joins the parent's (the store's rule).
 */
export async function createNoteItem(ctx, { title = '', content = '', url = '', collectionId = '', relatedIds = [], tags = [], parentId = '' } = {}) {
  const target = collectionId && ctx.select.collection(collectionId) ? collectionId : '';
  const item = await ctx.store.saveItem({ type: 'note', title: String(title || '').trim(), content, url, collectionId: target,
    relatedIds: relatedIds.filter(Boolean), tags, excerpt: noteExcerpt(content), ...(parentId ? { parentId } : {}) });
  return rememberItem(item);
}

/** Creates an empty subpage inside `parent` (any live item). Returns the saved note. */
export function createSubpage(ctx, parent) {
  if (!parent?.id || parent.deletedAt) return Promise.reject(new Error('That page no longer exists.'));
  return createNoteItem(ctx, { parentId: parent.id });
}

/** "New subpage" from any surface: creates it inside `parentId` and opens it with the title selected. */
export async function addSubpage(ctx, parentId) {
  const child = await createSubpage(ctx, latestItem(ctx, parentId));
  openNote(ctx, child.id, { focus: 'title' });
  return child;
}

/**
 * Moves a note into another item (parentId) or to the top level (''), with an Undo that puts it back where it was
 * when that place still exists. The store refuses loops, Trash and the depth cap with a clear message.
 */
export async function movePageTo(ctx, id, parentId) {
  const note = latestItem(ctx, id);
  if (!note) throw new Error('This note no longer exists.');
  const from = parentIdOf(note);
  if (from === (parentId || '')) return note;
  const saved = rememberItem(await ctx.store.movePage(id, { parentId: parentId || '' }));
  const parent = parentId ? latestItem(ctx, parentId) : null;
  const undo = { label: 'Undo', run: async () => {
    const back = from && latestItem(ctx, from);
    rememberItem(await ctx.store.movePage(id, { parentId: back && !back.deletedAt ? from : '' }));
  } };
  ctx.toast(parent ? `Moved into “${displayTitle(parent)}”` : 'Moved to the top level', { tone: 'success', action: undo });
  return saved;
}

/** The editor instance showing note `id` (full or side surface), if one is mounted. */
export function editorFor(id) {
  for (const instance of live) if (instance.id === id && !instance.inline) return instance;
  return null;
}
/** The editor that last had focus: { id, getMarkdown(), insertMarkdown(md) } (for "Insert into open note"). */
export function getActiveEditor() {
  return active && live.has(active) ? active : [...live].find(instance => !instance.inline) || null;
}
/** Saves every editor with unsaved edits now (page hide, before export). */
export function flushAllEditors() {
  return Promise.all([...live].map(instance => instance.flush()));
}

/* ------------------------------------------------------------------ drafts (device-local) */

const storage = () => { try { return globalThis.localStorage || null; } catch { return null; } };
function readDrafts() { try { return JSON.parse(storage()?.getItem(DRAFT_KEY) || '{}') || {}; } catch { return {}; } }
function writeDrafts(all) { try { storage()?.setItem(DRAFT_KEY, JSON.stringify(all)); } catch { /* storage full or blocked: the save path still runs */ } }
function putDraft(key, draft) {
  const all = readDrafts();
  const now = Date.now();
  for (const [k, value] of Object.entries(all)) if (!value?.at || now - value.at > DRAFT_TTL) delete all[k];
  all[key] = { ...draft, at: now };
  writeDrafts(all);
}
function dropDraft(key) { const all = readDrafts(); if (key in all) { delete all[key]; writeDrafts(all); } }

/* ------------------------------------------------------------------ markup */

/** Mount point for the note editor. surface: 'full' (notes workspace) | 'side' (side panel editor screen). */
export function renderNoteEditor(ctx, noteId, { surface = ctx.env.isSidepanel ? 'side' : 'full' } = {}) {
  return html`<div class="${cx('note-editor-host', `is-${surface}`)}" data-mount="note-editor" data-morph="skip" data-key="note-editor:${noteId}" data-id="${noteId}" data-surface="${surface}"></div>`;
}

/** Compact editor for an item's personal note (detail panel): no title or meta row, same autosave. */
export function renderInlineEditor(ctx, { itemId, field = 'content', placeholder = 'Add a note' } = {}) {
  if (!itemId) return '';
  return html`<div class="note-editor-host is-inline" data-mount="note-editor" data-morph="skip" data-key="inline-editor:${itemId}:${field}" data-id="${itemId}"
    data-variant="inline" data-field="${field}" data-placeholder="${placeholder}"></div>`;
}

const TOOLS = [
  { id: 'h1', label: 'Heading 1', icon: 'heading-1', group: 'headings', block: 'h1' },
  { id: 'h2', label: 'Heading 2', icon: 'heading-2', group: 'headings', block: 'h2' },
  { id: 'bold', label: 'Bold', icon: 'bold', group: 'inline', mark: 'bold', keys: 'mod+b' },
  { id: 'italic', label: 'Italic', icon: 'italic', group: 'inline', mark: 'italic', keys: 'mod+i' },
  { id: 'strike', label: 'Strikethrough', icon: 'strikethrough', group: 'inline', mark: 'strike', keys: 'mod+shift+x' },
  { id: 'code', label: 'Inline code', icon: 'code', group: 'inline', mark: 'code', keys: 'mod+e' },
  { id: 'link', label: 'Link', icon: 'link', group: 'inline', mark: 'link', keys: 'mod+k' },
  { id: 'bullet', label: 'Bulleted list', icon: 'list', group: 'lists', block: 'bullet' },
  { id: 'number', label: 'Numbered list', icon: 'list-ordered', group: 'lists', block: 'number' },
  { id: 'todo', label: 'Checklist', icon: 'list-todo', group: 'lists', block: 'todo' },
  { id: 'quote', label: 'Quote', icon: 'text-quote', group: 'blocks', block: 'quote' },
  { id: 'codeblock', label: 'Code block', icon: 'code-xml', group: 'blocks', block: 'code', command: 'code' },
  { id: 'callout', label: 'Callout', icon: 'info', group: 'blocks', block: 'callout' },
  { id: 'toggle', label: 'Toggle', icon: 'list-collapse', group: 'blocks', block: 'toggle' },
  { id: 'table', label: 'Table', icon: 'table', group: 'blocks', insert: true },
  { id: 'divider', label: 'Divider', icon: 'separator-horizontal', group: 'blocks', insert: true },
];
const TOOL_INDEX = Object.fromEntries(TOOLS.map(tool => [tool.id, tool]));

function toolbarMarkup(surface) {
  let previous = '';
  const tools = TOOLS.map((tool, index) => {
    const sep = previous && previous !== tool.group ? html`<span class="ne-tool-sep" data-group="${tool.group}" aria-hidden="true"></span>` : '';
    previous = tool.group;
    const tip = tool.keys ? `${tool.label} (${shortcutLabel(tool.keys)})` : tool.label;
    return html`${sep}<button type="button" class="ne-tool" data-tool="${tool.id}" data-group="${tool.group}" aria-label="${tool.label}" data-tooltip="${tip}" data-tooltip-pos="bottom"
      ${tool.mark || tool.block ? raw('aria-pressed="false"') : ''} ${tool.keys ? html`aria-keyshortcuts="${keyshortcuts(tool.keys)}"` : ''} tabindex="${index === 0 ? '0' : '-1'}">${icon(tool.icon, { size: 16 })}</button>`;
  });
  return html`<div class="ne-tools">${tools}
      <button type="button" class="ne-tool ne-tool-more" data-tool="more" aria-label="More formatting" data-tooltip="More formatting" data-tooltip-pos="bottom" aria-haspopup="true" aria-expanded="false" tabindex="-1">${icon('chevron-down', { size: 16 })}</button>
    </div>
    <div class="ne-tools-end">
      <button type="button" class="btn btn-ghost btn-sm ne-ai-btn" data-tool="ai" aria-haspopup="true" aria-expanded="false" aria-label="Ask AI" data-tooltip="Write or edit with AI" data-tooltip-pos="bottom end" tabindex="-1">${icon('sparkles', { size: 16 })}<span class="btn-label">Ask AI</span></button>
      <button type="button" class="ne-tool" data-tool="menu" aria-label="Note actions" data-tooltip="Note actions" data-tooltip-pos="bottom end" aria-haspopup="true" aria-expanded="false" tabindex="-1">${icon('ellipsis', { size: 16 })}</button>
    </div>`;
}

function shell(variant, surface) {
  if (variant === 'inline') {
    return html`<div class="ne ne-inline" data-surface="inline">
      <div class="ne-banner" data-region="banner" hidden></div>
      <div class="ne-doc"><div class="ne-body"><textarea name="content" aria-label="Note"></textarea></div><div class="ne-ai" data-region="ai" hidden></div></div>
      <div class="ne-foot is-quiet" data-region="foot"></div>
    </div>`;
  }
  return html`<div class="${cx('ne', `ne-${surface}`)}" data-surface="${surface}">
    <div class="ne-toolbar" role="toolbar" aria-label="Formatting and note actions">${toolbarMarkup(surface)}</div>
    <div class="ne-banner" data-region="banner" hidden></div>
    <div class="ne-scroll">
      <div class="ne-cover" data-region="cover" hidden></div>
      <div class="ne-doc">
        <div class="ne-head">
          <nav class="ne-crumbs" data-region="crumbs" aria-label="Page path" hidden></nav>
          <div class="ne-decor" data-region="decor"></div>
          <textarea class="ne-title" rows="1" placeholder="Untitled" aria-label="Title" maxlength="300" spellcheck="true" enterkeyhint="next"></textarea>
          <div class="ne-meta" data-region="meta"></div>
        </div>
        <div class="ne-body"><textarea name="content" aria-label="Note"></textarea></div>
        <div class="ne-ai" data-region="ai" hidden></div>
        <section class="ne-subpages" data-region="subpages" aria-label="Subpages" hidden></section>
        <section class="ne-links" data-region="links" aria-label="Linked from"></section>
      </div>
    </div>
    <footer class="ne-foot" data-region="foot"></footer>
  </div>`;
}

/* ------------------------------------------------------------------ the mount */

registerMount('note-editor', (host, ctx) => {
  const instance = createEditor(host, ctx);
  hosts.set(host, instance);
  return { update: () => instance.update(), destroy: () => instance.destroy() };
});

const instanceOf = el => hosts.get(el?.closest?.('[data-mount="note-editor"]'));

function createEditor(host, ctx) {
  const id = host.dataset.id;
  const inline = host.dataset.variant === 'inline';
  const field = inline ? host.dataset.field || 'content' : 'content';
  const surface = inline ? 'inline' : host.dataset.surface === 'side' ? 'side' : 'full';
  const key = `ne${++seq}`;
  const draftKey = `${id}:${field}`;
  const els = {};
  const st = {
    base: null, dirty: false, saving: false, pending: null, timer: 0, retry: 0, draftTimer: 0, footTimer: 0,
    status: 'idle', error: '', conflict: null, marks: new Set(), block: 'paragraph', text: '', words: 0, savedAt: 0,
    ai: null, aiSel: null, aiFrame: 0, queue: Promise.resolve(), destroyed: false, built: false, missingSince: Date.now(),
  };
  let editor = null;
  let observer = null;
  const listeners = [];
  const on = (target, type, fn, options) => { target.addEventListener(type, fn, options); listeners.push([target, type, fn, options]); };

  const instance = {
    id, inline, key,
    update, destroy, flush: () => save(), save: () => save(),
    getMarkdown: () => (editor ? editor.getMarkdown() : st.text),
    insertMarkdown: (md, options) => { editor?.insertMarkdown(md, options); },
    focus: (at = 'end') => editor?.focus({ at }),
    toggleTask(index, done) {
      if (!editor) return false;
      const current = editor.getMarkdown();
      const next = toggleTask(current, index, done);
      if (next !== current) editor.setMarkdown(next, { emit: true });
      return true;
    },
    scrollToHeading(text, nth = 0) {
      if (!editor) return;
      const wanted = String(text).trim().toLowerCase();
      const matches = [...editor.root.querySelectorAll('.note-block.block-h1, .note-block.block-h2, .note-block.block-h3')]
        .filter(el => el.textContent.trim().toLowerCase() === wanted);
      const target = matches[Math.min(nth, matches.length - 1)];
      if (!target) return;
      target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      target.querySelector('[data-block-edit]')?.focus({ preventScroll: true });
    },
    metaWrite, openAiMenu, runAi, applyAi, closeAi, resolveBanner, setMode: mode => { editor?.setMode(mode); renderFoot(); },
    newSubpage: () => newSubpage(),
    openImport: files => openImportDialog(files), openEmbed: () => openEmbedDialog(),
    retry: () => { st.retry = 0; save(); },
  };
  live.add(instance);

  const item = () => latestItem(ctx, id);
  const snapshot = record => ({ title: record.title ?? '', text: record[field] ?? '', updatedAt: record.updatedAt });
  const titleText = () => (inline ? st.base?.title ?? '' : normalizeTitle(els.title?.value));
  const currentText = () => (editor ? editor.getMarkdown() : st.text);
  const enqueue = task => { const run = st.queue.then(task); st.queue = run.catch(() => {}); return run; };

  build();

  /* ---------- build ---------- */

  function build() {
    const record = item();
    if (!record) {
      host.innerHTML = String(html`<div class="ne-missing" role="status">${spinner({ size: 16 })}<span>Opening note</span></div>`);
      return;
    }
    host.innerHTML = String(shell(inline ? 'inline' : 'note', surface));
    for (const region of host.querySelectorAll('[data-region]')) els[region.dataset.region] = region;
    els.root = host.firstElementChild;
    els.toolbar = host.querySelector('.ne-toolbar');
    els.doc = host.querySelector('.ne-doc');
    els.title = host.querySelector('.ne-title');
    els.source = host.querySelector('.ne-body textarea');
    st.base = snapshot(record);
    st.text = record[field] || '';
    els.source.value = st.text;
    if (els.title) els.title.value = titleValue(record.title);

    const draft = readDrafts()[draftKey];
    const decision = draftDecision(draft, record, { field, title: !inline });
    if (decision === 'discard') dropDraft(draftKey);
    if (decision === 'restore' || decision === 'conflict') {
      els.source.value = st.text = draft.text ?? st.text;
      if (els.title && draft.title != null) els.title.value = titleValue(draft.title);
    }

    editor = mountBlockEditor(els.source, {
      compact: surface !== 'full', showModeSwitch: false, mode: 'blocks',
      placeholder: inline ? host.dataset.placeholder || 'Add a note' : surface === 'side' ? 'Write, or press / for blocks' : 'Write, or press / for blocks and [[ to link a note',
      onChange: markdown => changed(markdown),
      onAskAi: () => openAiMenu(selectionPoint() || els.toolbar?.querySelector('[data-tool="ai"]') || host),
      searchLinks: async query => searchLinkCandidates(ctx.select.live(), query, { exclude: id, collectionName: cid => ctx.select.collection(cid)?.name || '' }),
      resolveLink: target => withPageMeta(ctx, noteResolver(ctx)(target) || justSaved(target)),
      onOpenLink: linkId => openLinked(ctx, linkId),
      onImport: ({ files } = {}) => openImportDialog(files),
      onEmbed: () => openEmbedDialog(),
      ...(field === 'content' ? { onCreatePage: () => createPageFromSlash() } : {}),
      mountEmbed: itemEmbedMount(ctx, { lookup: itemId => latestItem(ctx, itemId) }),
      onSelectionChange: info => { st.marks = info.marks || new Set(); st.block = info.block || 'paragraph'; active = instance; syncToolbar(); },
    });
    st.built = true;
    st.words = wordCount(st.text);

    if (decision === 'restore') { st.dirty = true; setStatus('restored'); st.timer = setTimeout(save, SAVE_DELAY); }
    if (decision === 'conflict') { st.dirty = true; st.conflict = { latest: record }; setStatus('conflict'); }

    wireDom();
    renderRegions();
    autosizeTitle();
    const focus = pendingFocus.get(id);
    if (focus) {
      pendingFocus.delete(id);
      requestAnimationFrame(() => {
        if (focus === 'title' && els.title) { els.title.focus(); els.title.select(); } else editor?.focus({ at: 'end' });
      });
    }
  }

  function wireDom() {
    on(host, 'focusin', () => { active = instance; });
    on(host, 'keydown', event => {
      const mod = ctx.env.isMac ? event.metaKey : event.ctrlKey;
      if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); save(); }
    }, true);
    if (els.title) {
      on(els.title, 'input', () => {
        if (els.title.value.includes('\n')) els.title.value = els.title.value.replace(/\s*\n\s*/g, ' ');
        autosizeTitle();
        changed();
      });
      on(els.title, 'keydown', event => {
        if (event.isComposing) return;
        const atEnd = els.title.selectionStart === els.title.value.length && els.title.selectionEnd === els.title.value.length;
        if (event.key === 'Enter' || (event.key === 'ArrowDown' && atEnd)) { event.preventDefault(); editor?.focus({ at: 'start' }); }
      });
    }
    if (els.toolbar) {
      on(els.toolbar, 'pointerdown', event => { if (event.target.closest('[data-tool]')) event.preventDefault(); });
      on(els.toolbar, 'click', event => { const btn = event.target.closest('[data-tool]'); if (btn) runTool(btn.dataset.tool, btn); });
      on(els.toolbar, 'keydown', toolbarKeys);
    }
    on(els.ai, 'keydown', event => { if (event.key === 'Escape' && st.ai) { event.preventDefault(); event.stopPropagation(); closeAi(); editor?.focus({ at: 'end' }); } });
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => { autosizeTitle(); rovingStop(); });
      observer.observe(host);
    }
  }

  /* ---------- subpages ---------- */

  // "/page": the subpage is saved first, its block goes where "/page" was typed, and this note is saved before the new
  // page opens, so the block is never lost when the editor closes for the navigation.
  async function createPageFromSlash() {
    const parent = item();
    if (!parent || parent.deletedAt) { ctx.toast('Restore this note from Trash before adding pages to it.', { tone: 'warning' }); return; }
    try {
      const child = await createSubpage(ctx, parent);
      if (st.destroyed || !editor) return;
      editor.command('page', { target: child.id, label: titleValue(child.title) });
      await save();
      openNote(ctx, child.id, { focus: 'title' });
    } catch (error) {
      ctx.toast(error?.message || 'The page could not be created.', { tone: 'danger' });
    }
  }

  /* ---------- import and embeds ---------- */

  // A file saved for an embed a moment ago may not be in the library snapshot yet.
  function justSaved(target) {
    const record = latestItem(ctx, String(target ?? ''));
    return record && !record.deletedAt ? { id: record.id, title: record.title || 'Untitled', type: record.type } : null;
  }

  function openImportDialog(files = []) {
    if (!editor) return;
    openImport(ctx, { files, noteTitle: inline ? '' : titleValue(els.title?.value ?? item()?.title).trim(), collectionId: item()?.collectionId || '', rememberItem, insert: insertImport, embedFile });
  }

  /** Imported Markdown goes in at the caret. An untitled, empty note also takes the document's title. */
  function insertImport(markdown, { title = '' } = {}) {
    if (!editor || st.destroyed) return;
    let body = String(markdown || '');
    const empty = !editor.getMarkdown().trim();
    if (!inline && els.title && !els.title.value.trim() && title.trim()) {
      els.title.value = normalizeTitle(title).slice(0, 300);
      autosizeTitle();
      if (empty && leadingTitle(body) === title.trim()) body = body.replace(/^(\s*(?:!\[\[[^\n]+\]\]\s*\n)*)\s*# [^\n]*\n?/, '$1');
      changed();
    }
    if (body.trim()) editor.insertMarkdown(body, { at: empty ? 'end' : 'cursor' });
  }

  function openEmbedDialog(tab = 'link') {
    if (!editor) return;
    openEmbed(ctx, { tab, collectionId: item()?.collectionId || '', embed: spec => {
      if (spec?.item) rememberItem(spec.item);
      editor?.command('embed', { url: spec?.url, target: spec?.target, label: spec?.label });
    } });
  }

  async function embedFile(file) {
    try {
      const saved = rememberItem(await saveFileItem(ctx, file, item()?.collectionId || ''));
      editor?.command('embed', { target: saved.id, label: saved.title });
      ctx.toast(`Saved ${saved.title} to your library and embedded it`, { tone: 'success' });
    } catch (error) {
      ctx.toast(error?.message || 'The file could not be saved.', { tone: 'danger' });
    }
  }

  /* ---------- editing and autosave ---------- */

  function changed(markdown) {
    if (st.destroyed) return;
    if (typeof markdown === 'string') st.text = markdown;
    active = instance;
    st.dirty = true;
    clearTimeout(st.draftTimer);
    st.draftTimer = setTimeout(() => putDraft(draftKey, { text: st.text, title: inline ? null : els.title?.value ?? null, base: st.base?.updatedAt }), 300);
    if (st.conflict) return;
    if (st.status !== 'saving') setStatus('dirty');
    clearTimeout(st.timer);
    st.timer = setTimeout(save, SAVE_DELAY);
    clearTimeout(st.footTimer);
    st.footTimer = setTimeout(() => { st.words = wordCount(st.text); renderFoot(); }, 250);
  }

  function save({ force = false } = {}) {
    clearTimeout(st.timer);
    return enqueue(async () => {
      if (!st.built || (!st.dirty && !force) || (st.conflict && !force)) return;
      const record = item();
      if (!record) { setStatus('error', 'This note no longer exists.'); return; }
      const text = currentText();
      const title = titleText();
      const patch = inline ? { [field]: text } : { title, content: text };
      if (record.type === 'note' && field === 'content') patch.excerpt = noteExcerpt(text);
      const linked = resolveWikiLinks(text, [...(ctx.library?.items || []), ...fresh.values()]).map(link => link.id).filter(Boolean);
      const related = mergeRelatedIds(record.relatedIds, linked, id);
      if (related.length !== (record.relatedIds || []).length) patch.relatedIds = related;
      if (!force && text === st.base.text && (inline || title === st.base.title) && !patch.relatedIds) {
        st.dirty = false; dropDraft(draftKey); setStatus(st.savedAt ? 'saved' : 'idle'); return;
      }
      st.dirty = false;
      st.saving = true;
      st.pending = { text, title: inline ? st.base.title : title };
      setStatus('saving');
      try {
        const saved = rememberItem(await ctx.store.updateItem(id, patch, force ? {} : { expectedUpdatedAt: st.base.updatedAt }));
        st.base = snapshot(saved);
        st.retry = 0;
        st.conflict = null;
        st.savedAt = Date.now();
        if (!st.dirty) dropDraft(draftKey);
        setStatus(st.dirty ? 'dirty' : 'saved');
      } catch (error) {
        st.dirty = true;
        const message = String(error?.message || '');
        if (/^Conflict/i.test(message)) await settleConflict();
        else if (/no longer exists/i.test(message)) setStatus('error', 'This note was deleted.');
        else {
          setStatus('error', /unavailable|context invalidated|establish connection|receiving end/i.test(message) ? 'Still is not reachable. Your changes are kept on this device.' : 'Not saved');
          st.retry++;
          st.timer = setTimeout(save, Math.min(30000, 2000 * 2 ** (st.retry - 1)));
        }
      } finally {
        st.saving = false;
        st.pending = null;
        if (!st.destroyed) { renderRegions(); renderBanner(); }
      }
    });
  }

  async function settleConflict() {
    let latest = null;
    try { latest = (await ctx.store.loadLibrary())?.items?.find(entry => entry.id === id) || null; } catch { latest = item(); }
    if (latest && reconcile(st.base, latest, { dirty: true, field, title: !inline }) === 'rebase') {
      st.base.updatedAt = latest.updatedAt;
      st.timer = setTimeout(save, 0);
      return;
    }
    if (!latest) { setStatus('error', 'This note was deleted.'); return; }
    st.conflict = { latest };
    setStatus('conflict');
  }

  /** Field-level writes from the meta row (collection, tags, pin, reminder, page link) go through the same queue. */
  function metaWrite(patch) {
    return enqueue(async () => {
      const saved = rememberItem(await ctx.store.updateItem(id, patch));
      if (st.base && reconcile(st.base, saved, { dirty: true, field, title: !inline }) === 'rebase') st.base.updatedAt = saved.updatedAt;
      ctx.render();
      return saved;
    });
  }

  function applyRemote(record) {
    const text = record[field] ?? '';
    if (editor && text !== editor.getMarkdown()) editor.setMarkdown(text);
    st.text = text;
    if (els.title) {
      const next = titleValue(record.title);
      if (els.title.value !== next && document.activeElement !== els.title) { els.title.value = next; autosizeTitle(); }
    }
    st.base = snapshot(record);
    st.conflict = null;
    st.dirty = false;
    st.words = wordCount(text);
    dropDraft(draftKey);
  }

  function resolveBanner(op) {
    const conflict = st.conflict;
    if (op === 'reload' && conflict) { applyRemote(item() || conflict.latest); setStatus('saved'); }
    else if (op === 'keep') { st.conflict = null; st.dirty = true; save({ force: true }); }
    else if (op === 'copy') {
      navigator.clipboard?.writeText(currentText()).then(() => ctx.toast('Copied your version'), () => ctx.toast('Could not copy. Select the text and copy it instead.', { tone: 'danger' }));
      return;
    } else if (op === 'restore') {
      return ctx.run(async () => {
        const before = item();
        const restored = rememberItem(await ctx.store.restoreItem(id));
        ctx.toast(parentIdOf(before) && !parentIdOf(restored) ? 'Restored from Trash. Its parent page is still in Trash, so it is now at the top level.' : 'Restored from Trash');
      });
    }
    renderBanner();
    renderFoot();
  }

  /* ---------- render loop ---------- */

  function update() {
    if (st.destroyed) return;
    if (!st.built) {
      build();
      if (!st.built && Date.now() - st.missingSince > 4000) host.innerHTML = String(html`<div class="ne-missing" role="status">${icon('circle-alert', { size: 16 })}<span>This note is no longer available.</span></div>`);
      return;
    }
    const record = item();
    if (!record) { setStatus('error', 'This note no longer exists.'); renderBanner(); return; }
    if (!st.saving) {
      const verdict = reconcile(st.base, record, { dirty: st.dirty, pending: st.pending, field, title: !inline });
      if (verdict === 'rebase') st.base.updatedAt = record.updatedAt;
      else if (verdict === 'own') st.base = snapshot(record);
      else if (verdict === 'reload') applyRemote(record);
      else if (verdict === 'conflict' && st.conflict?.latest?.updatedAt !== record.updatedAt) { st.conflict = { latest: record }; clearTimeout(st.timer); setStatus('conflict'); }
    }
    renderRegions(record);
    editor?.refresh?.();
  }

  function renderRegions(record = item()) {
    if (!st.built || !record) return;
    if (els.crumbs) {
      const markup = renderCrumbs(ctx, record, surface);
      els.crumbs.hidden = !String(markup).trim();
      morph(els.crumbs, markup);
    }
    if (els.cover) {
      const markup = renderPageCover(record);
      els.cover.hidden = !String(markup).trim();
      morph(els.cover, markup);
    }
    if (els.decor) morph(els.decor, renderDecor(record));
    if (els.meta) morph(els.meta, renderMeta(ctx, instance, record, surface));
    if (els.subpages) {
      const markup = renderSubpages(ctx, record);
      els.subpages.hidden = !String(markup).trim();
      morph(els.subpages, markup);
    }
    if (els.links) {
      const markup = renderLinks(ctx, record, surface);
      els.links.hidden = !String(markup).trim();
      morph(els.links, markup);
    }
    renderBanner(record);
    renderFoot();
  }

  function setStatus(status, error = '') {
    st.status = status;
    st.error = error;
    renderFoot();
    if (status === 'conflict' || status === 'error') renderBanner();
  }

  function renderFoot() {
    if (!els.foot || st.destroyed) return;
    morph(els.foot, footMarkup());
  }

  function footMarkup() {
    const words = st.words;
    const minutes = readingMinutes(words);
    const status = { idle: '', dirty: 'Saving…', saving: 'Saving…', saved: 'Saved', restored: 'Restored unsaved changes', conflict: 'Not saved', error: 'Not saved' }[st.status] ?? '';
    const tone = st.status === 'error' || st.status === 'conflict' ? 'danger' : st.status === 'saved' ? 'ok' : 'muted';
    const statusMarkup = status ? html`<span class="ne-status" data-tone="${tone}" title="${st.savedAt && st.status === 'saved' ? `Saved ${new Date(st.savedAt).toLocaleTimeString()}` : ''}">
      ${st.status === 'saving' || st.status === 'dirty' ? spinner({ size: 12 }) : icon(tone === 'danger' ? 'circle-alert' : st.status === 'saved' ? 'check' : 'history', { size: 14 })}<span>${status}</span>
      ${st.status === 'error' ? html`<button type="button" class="ne-link-btn" data-action="editor.retry">Retry</button>` : ''}</span>` : '';
    if (inline) return html`${statusMarkup}`;
    const mode = editor?.getMode?.() || 'blocks';
    return html`<span class="ne-count">${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}${minutes ? html`<span aria-hidden="true"> · </span>${minutes} min read` : ''}</span>
      <span class="ne-foot-spacer"></span>${statusMarkup}
      ${surface === 'full' ? html`<div class="segmented segmented-sm ne-modes" role="radiogroup" aria-label="Editor view">${[['blocks', 'Write'], ['markdown', 'Markdown'], ['preview', 'Preview']].map(([value, label]) => html`<button type="button" role="radio" class="segmented-option"
        aria-checked="${mode === value ? 'true' : 'false'}" tabindex="${mode === value ? '0' : '-1'}" data-action="editor.mode" data-mode="${value}"><span>${label}</span></button>`)}</div>` : ''}`;
  }

  function renderBanner(record = item()) {
    if (!els.banner || st.destroyed) return;
    let markup = '';
    if (st.conflict) {
      markup = html`<div class="ne-bar" data-tone="warning" role="alert">${icon('triangle-alert', { size: 16 })}
        <span class="ne-bar-text"><strong>This note changed in another view.</strong> Your edits are not saved yet.</span>
        <span class="ne-bar-actions">
          ${button({ label: 'Reload', variant: 'secondary', size: 'sm', action: 'editor.banner', data: { op: 'reload' }, title: 'Discard my edits and load the other version' })}
          ${button({ label: 'Keep mine', variant: 'primary', size: 'sm', action: 'editor.banner', data: { op: 'keep' } })}
          ${button({ label: 'Copy mine', variant: 'ghost', size: 'sm', action: 'editor.banner', data: { op: 'copy' } })}
        </span></div>`;
    } else if (st.status === 'error' && st.error && st.error !== 'Not saved') {
      markup = html`<div class="ne-bar" data-tone="danger" role="alert">${icon('circle-alert', { size: 16 })}<span class="ne-bar-text">${st.error}</span>
        ${/deleted|no longer exists/.test(st.error) ? '' : html`<span class="ne-bar-actions">${button({ label: 'Retry', variant: 'secondary', size: 'sm', action: 'editor.retry' })}</span>`}</div>`;
    } else if (record?.deletedAt) {
      markup = html`<div class="ne-bar" data-tone="muted">${icon('trash-2', { size: 16 })}<span class="ne-bar-text">This note is in Trash.</span>
        <span class="ne-bar-actions">${button({ label: 'Restore', variant: 'secondary', size: 'sm', action: 'editor.banner', data: { op: 'restore' } })}</span></div>`;
    } else if (record?.archived && !inline) {
      markup = html`<div class="ne-bar" data-tone="muted">${icon('archive', { size: 16 })}<span class="ne-bar-text">This note is archived.</span>
        <span class="ne-bar-actions">${button({ label: 'Unarchive', variant: 'secondary', size: 'sm', action: 'editor.unarchive' })}</span></div>`;
    }
    els.banner.hidden = !String(markup).trim();
    morph(els.banner, markup);
  }

  function autosizeTitle() {
    const el = els.title;
    if (!el || !el.isConnected) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  /* ---------- toolbar ---------- */

  function syncToolbar() {
    if (!els.toolbar) return;
    for (const btn of els.toolbar.querySelectorAll('[data-tool][aria-pressed]')) {
      const tool = TOOL_INDEX[btn.dataset.tool];
      if (!tool) continue;
      const on = tool.mark ? st.marks.has(tool.mark) : st.block === tool.block;
      if (btn.getAttribute('aria-pressed') !== String(on)) btn.setAttribute('aria-pressed', String(on));
    }
  }

  function runTool(name, btn) {
    if (!editor) return;
    if (name === 'more') { openOverflow(btn); return; }
    if (name === 'ai') { openAiMenu(btn); return; }
    if (name === 'menu') { openNoteMenu(btn); return; }
    applyTool(TOOL_INDEX[name]);
  }

  function applyTool(tool) {
    if (!tool || !editor) return;
    if (editor.getMode() !== 'blocks') editor.setMode('blocks');
    if (tool.mark === 'link') {
      const selection = editor.getSelection();
      if (selection?.text) editor.format('link'); else editor.command('link');
      return;
    }
    if (tool.mark) editor.format(tool.mark);
    else editor.command(tool.command || tool.block || tool.id);
    renderFoot();
  }

  const visible = el => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.offsetParent !== null);

  /** Keeps exactly one visible toolbar button in the tab order when narrow widths hide some of them. */
  function rovingStop() {
    if (!els.toolbar) return;
    const buttons = [...els.toolbar.querySelectorAll('[data-tool]')];
    const current = buttons.find(btn => btn.tabIndex === 0);
    if (current && visible(current)) return;
    const first = buttons.find(visible);
    for (const btn of buttons) btn.tabIndex = btn === first ? 0 : -1;
  }

  function openOverflow(anchor) {
    const hidden = [...els.toolbar.querySelectorAll('.ne-tool[data-group]')].filter(btn => !visible(btn)).map(btn => TOOL_INDEX[btn.dataset.tool]).filter(Boolean);
    const items = hidden.map(tool => ({ label: tool.label, icon: tool.icon, keepFocus: true, run: () => applyTool(tool),
      ...(tool.keys ? { hint: shortcutLabel(tool.keys) } : {}) }));
    if (!items.length) return;
    ctx.openMenu(anchor, items, { label: 'More formatting', placement: 'bottom-start' });
  }

  function toolbarKeys(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...els.toolbar.querySelectorAll('[data-tool]')].filter(visible);
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    for (const btn of buttons) btn.tabIndex = -1;
    buttons[next].tabIndex = 0;
    buttons[next].focus();
  }

  /* ---------- note menu ---------- */

  function openNoteMenu(anchor) {
    const record = item();
    if (!record) return;
    const page = ctx.state.page;
    const pageLinkable = !record.url && /^https?:/i.test(page?.url || '');
    const mode = editor?.getMode?.() || 'blocks';
    const nested = !!parentIdOf(record);
    const research = !record.deletedAt && researchOffered(ctx);
    ctx.openMenu(anchor, [
      { label: record.pinned ? 'Unpin' : 'Pin to top', icon: record.pinned ? 'pin-off' : 'pin', run: () => metaWrite({ pinned: !record.pinned }) },
      { label: 'Add subpage', icon: 'file-plus', run: () => newSubpage() },
      { label: 'Move to page…', icon: 'folder-tree', run: () => openPagePicker(ctx, anchor, id) },
      ...(nested ? [{ label: 'Move to top level', icon: 'arrow-up-from-line', run: () => ctx.run(async () => { await save(); await movePageTo(ctx, id, ''); }) }] : []),
      { label: 'Duplicate', icon: 'files', run: () => duplicate(record) },
      { label: 'Copy as Markdown', icon: 'copy', run: () => copyMarkdown(record) },
      { label: 'Download as Markdown', icon: 'download', run: () => downloadMarkdown(record) },
      ...(pageLinkable ? [{ label: 'Link to this page', icon: 'link', run: () => metaWrite({ url: page.url }) }] : []),
      ...(surface === 'side' ? [{ label: 'Open in full tab', icon: 'external-link', run: () => openInFullTab(ctx, id) }] : []),
      { separator: true },
      { label: 'Import file…', icon: 'file-down', run: () => openImportDialog() },
      { label: 'Embed…', icon: 'app-window', run: () => openEmbedDialog() },
      ...(research ? [{ label: 'Research more with AI', icon: 'telescope', action: 'research.start', data: { id } }] : []),
      ...(surface === 'side' ? [
        { separator: true }, { heading: 'View' },
        { label: 'Write', checked: mode === 'blocks', keepFocus: true, run: () => instance.setMode('blocks') },
        { label: 'Markdown source', checked: mode === 'markdown', keepFocus: true, run: () => instance.setMode('markdown') },
        { label: 'Preview', checked: mode === 'preview', run: () => instance.setMode('preview') },
      ] : []),
      { separator: true },
      { label: record.archived ? 'Unarchive' : 'Archive', icon: 'archive', run: () => archive(record) },
      { label: 'Move to Trash', icon: 'trash-2', danger: true, run: () => trash(record) },
    ], { label: 'Note actions', placement: 'bottom-end' });
  }

  async function newSubpage() {
    await save();
    return ctx.run(() => addSubpage(ctx, id));
  }

  async function duplicate(record) {
    await save();
    // The copy is a sibling: it sits in the same page as the original (its subpages stay with the original).
    const parentId = parentIdOf(record);
    const parent = parentId ? latestItem(ctx, parentId) : null;
    const copy = await createNoteItem(ctx, { title: `${titleValue(record.title) || 'Untitled'} copy`, content: currentText(), url: record.url,
      collectionId: record.collectionId, relatedIds: record.relatedIds, tags: record.tags, parentId: parent && !parent.deletedAt ? parentId : '' });
    ctx.toast('Duplicated', { tone: 'success' });
    openNote(ctx, copy.id);
  }

  async function copyMarkdown(record) {
    const title = titleValue(els.title?.value ?? record.title).trim();
    const body = currentText();
    await navigator.clipboard.writeText(title && !body.trimStart().startsWith('# ') ? `# ${title}\n\n${body}` : body);
    ctx.toast('Copied as Markdown');
  }

  function downloadMarkdown(record) {
    const title = titleValue(els.title?.value ?? record.title).trim() || 'Untitled note';
    const body = currentText();
    const text = title && !body.trimStart().startsWith('# ') ? `# ${title}\n\n${body}` : body;
    const blob = new Blob([text.endsWith('\n') ? text : `${text}\n`], { type: 'text/markdown' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'note'}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  }

  async function archive(record) {
    await save();
    const next = !record.archived;
    await metaWrite({ archived: next });
    if (next) {
      closeNote(ctx, id);
      ctx.toast('Archived', { action: { label: 'Undo', run: () => ctx.store.updateItem(id, { archived: false }) } });
    } else ctx.toast('Moved out of Archive');
  }

  async function trash(record) {
    if (!(await confirmTrash(ctx, [latestItem(ctx, id) || record].filter(Boolean)))) return record;
    await save();
    // The store trashes the subpages with the page (same stamp); Undo restores them together.
    const subpages = subpagesMoving(ctx.library, [id]);
    await enqueue(async () => rememberItem(await ctx.store.deleteItem(id)));
    closeNote(ctx, id);
    ctx.toast(subpages ? `Moved to Trash with ${plural(subpages, 'subpage')}` : 'Moved to Trash',
      { action: { label: 'Undo', run: async () => { rememberItem(await ctx.store.restoreItem(id)); openNote(ctx, id); } } });
    return record;
  }

  /* ---------- AI ---------- */

  function selectionPoint() {
    const rect = selectionRect();
    return rect ? { x: Math.round(rect.left), y: Math.round(rect.bottom) } : null;
  }

  function selectionRect() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editor) return null;
    const range = selection.getRangeAt(0);
    if (!editor.root.contains(range.commonAncestorContainer)) return null;
    const rect = range.getBoundingClientRect();
    if (rect.width || rect.height) return rect;
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    return node?.closest?.('.note-block')?.getBoundingClientRect() || null;
  }

  function captureSelection() {
    const markdown = editor ? editor.getMarkdown() : st.text;
    const sel = editor?.getSelection?.() || { text: '', start: 0, end: 0 };
    const known = Number.isInteger(sel.start) && Number.isInteger(sel.end) && sel.end <= markdown.length;
    const rect = selectionRect();
    const doc = els.doc?.getBoundingClientRect();
    st.aiSel = {
      markdown, top: rect && doc ? Math.max(0, Math.round(rect.bottom - doc.top + 8)) : null,
      start: known ? sel.start : markdown.length, end: known ? sel.end : markdown.length,
      hasSelection: known && sel.end > sel.start && !!String(sel.text || '').trim(),
      caret: known && (sel.start || sel.end) ? sel.end : markdown.length,
    };
    return st.aiSel;
  }

  function openAiMenu(anchor) {
    if (!editor) return;
    const sel = captureSelection();
    const scope = sel.hasSelection ? 'selection' : 'note';
    const pick = action => ({ label: labelFor(action, scope), icon: action.icon, keepFocus: true, run: () => runAi(action.id) });
    const actions = AI_ACTIONS.filter(action => !(sel.hasSelection && action.noSelection) && !(inline && action.id === 'title'));
    const writing = actions.filter(action => !['title', 'tags', 'translate'].includes(action.id));
    ctx.openMenu(anchor, [
      { heading: sel.hasSelection ? 'Edit selection' : 'Write with AI' },
      ...writing.map(pick),
      { label: 'Translate to…', icon: 'languages', keepFocus: true, run: () => openTranslateMenu(anchor) },
      { separator: true },
      ...actions.filter(action => action.id === 'title' || action.id === 'tags').map(pick),
      ...(inline ? [] : [{ label: 'Ask about this note', icon: 'messages-square', run: () => askAboutNote() }]),
    ], { label: 'Ask AI', placement: anchor instanceof Element ? 'bottom-end' : 'bottom-start' });
  }

  function labelFor(action, scope) {
    if (action.id === 'summarize') return scope === 'selection' ? 'Summarize selection' : 'Summarize note';
    if (action.id === 'explain') return scope === 'selection' ? 'Explain selection' : 'Explain note';
    return action.label;
  }

  function openTranslateMenu(anchor) {
    ctx.openMenu(anchor, [
      { heading: 'Translate to' },
      ...LANGUAGES.map(language => ({ label: language, keepFocus: true, run: () => runAi('translate', { language }) })),
      { separator: true },
      { label: 'Other language…', icon: 'languages', run: async () => {
        const language = await ctx.prompt({ title: 'Translate to', label: 'Language', placeholder: 'For example: Swedish', confirmLabel: 'Translate' });
        if (language?.trim()) runAi('translate', { language: language.trim() });
      } },
    ], { label: 'Translate to', placement: anchor instanceof Element ? 'bottom-end' : 'bottom-start' });
  }

  async function askAboutNote() {
    await save();
    const module = await import('./ai-panel.js');
    if (typeof module.askAi === 'function') module.askAi(ctx, { scope: 'item', ids: [id] });
    else if (hasAction('shell.ask')) ctx.dispatch('shell.ask', { data: {} });
  }

  async function runAi(actionId, { language } = {}) {
    const action = AI_ACTIONS.find(entry => entry.id === actionId);
    if (!action || !editor) return;
    st.ai?.controller?.abort();
    const sel = st.aiSel || captureSelection();
    const title = inline ? titleValue(item()?.title) : els.title.value.trim();
    const selected = sel.hasSelection ? sel.markdown.slice(sel.start, sel.end) : '';
    const text = action.id === 'continue' ? sel.markdown.slice(0, sel.caret) : selected || sel.markdown;
    const context = sel.hasSelection ? { title, markdown: sel.markdown } : title ? { title } : undefined;
    const label = action.id === 'translate' ? `Translate to ${language}` : labelFor(action, sel.hasSelection ? 'selection' : 'note');
    st.ai = { action: action.id, apply: action.apply, language, label, text: '', status: 'streaming', error: '', code: '', sel, controller: new AbortController() };
    renderAi();
    const ai = st.ai;
    if (typeof ctx.ai?.transformText !== 'function') { Object.assign(ai, { status: 'error', code: 'no_connection' }); renderAi(); return; }
    try {
      const result = await ctx.ai.transformText({ action: action.id, text, context, language, signal: ai.controller.signal,
        onDelta: (_delta, full) => { if (st.ai !== ai) return; ai.text = full; scheduleAiRender(); } });
      if (st.ai !== ai) return;
      ai.text = String(result ?? ai.text);
      ai.status = ai.text.trim() ? 'done' : 'error';
      if (!ai.text.trim()) ai.error = 'The model returned nothing. Try again.';
    } catch (error) {
      if (st.ai !== ai) return;
      if (error?.name === 'AbortError' || ai.controller.signal.aborted) { if (ai.text.trim()) ai.status = 'done'; else { closeAi(); return; } }
      else {
        ai.status = 'error';
        ai.code = error?.code === 'no_connection' || /connect an ai provider/i.test(error?.message || '') ? 'no_connection' : error?.code || '';
        ai.error = error?.message || 'The AI request failed.';
      }
    }
    renderAi();
  }

  function scheduleAiRender() {
    if (st.aiFrame) return;
    st.aiFrame = requestAnimationFrame(() => { st.aiFrame = 0; renderAi(); });
  }

  function renderAi() {
    if (!els.ai || st.destroyed) return;
    const ai = st.ai;
    els.ai.hidden = !ai;
    morph(els.ai, ai ? aiCard(ai) : '');
    placeAi();
  }

  function placeAi() {
    const ai = st.ai;
    if (!ai || !els.ai || !els.doc) return;
    const top = ai.sel?.top;
    els.ai.classList.toggle('is-static', top == null);
    if (top == null) els.ai.style.removeProperty('--ai-top'); else els.ai.style.setProperty('--ai-top', `${top}px`);
  }

  function aiCard(ai) {
    const streaming = ai.status === 'streaming';
    const result = ai.text.trim();
    let body;
    if (ai.status === 'error' && ai.code === 'no_connection') {
      body = html`<div class="ne-ai-empty">${icon('plug', { size: 16 })}<p>Connect a model in Settings &gt; AI models to use AI writing tools.</p></div>`;
    } else if (ai.status === 'error') {
      body = html`<p class="ne-ai-error">${icon('circle-alert', { size: 14 })}<span>${ai.error}</span></p>`;
    } else if (!result) {
      body = html`<div class="ne-ai-wait" aria-hidden="true"><span></span><span></span><span></span></div>`;
    } else if (ai.apply === 'tags') {
      body = html`<p class="ne-ai-tags">${mergeTagList([], result).map(tag => html`<span class="ne-ai-tag">#${tag}</span>`)}</p>`;
    } else if (ai.apply === 'title') {
      body = html`<p class="ne-ai-title">${result.replace(/^#+\s*/, '').replace(/^["“']|["”']$/g, '')}</p>`;
    } else {
      body = html`<div class="ne-ai-text markdown-body is-compact">${raw(renderMarkdown(result, { resolveLink: noteResolver(ctx) }))}</div>`;
    }
    const replaceLabel = ai.sel?.hasSelection ? 'Replace selection' : 'Replace note';
    let actions;
    if (streaming) actions = html`${button({ label: 'Stop', icon: 'circle-stop', variant: 'secondary', size: 'sm', action: 'editor.ai', data: { op: 'stop' } })}`;
    else if (ai.status === 'error' && ai.code === 'no_connection') actions = html`${button({ label: 'Open AI settings', variant: 'primary', size: 'sm', action: 'editor.ai', data: { op: 'settings' } })}`;
    else if (ai.status === 'error') actions = html`${button({ label: 'Try again', icon: 'refresh-cw', variant: 'secondary', size: 'sm', action: 'editor.ai', data: { op: 'retry' } })}`;
    else if (ai.apply === 'title') actions = html`${button({ label: 'Use as title', variant: 'primary', size: 'sm', action: 'editor.ai', data: { op: 'title' } })}`;
    else if (ai.apply === 'tags') actions = html`${button({ label: 'Add tags', variant: 'primary', size: 'sm', action: 'editor.ai', data: { op: 'tags' } })}`;
    else if (ai.apply === 'replace') actions = html`${button({ label: replaceLabel, variant: 'primary', size: 'sm', action: 'editor.ai', data: { op: 'replace' } })}
      ${button({ label: 'Insert below', variant: 'secondary', size: 'sm', action: 'editor.ai', data: { op: 'below' } })}`;
    else actions = html`${button({ label: ai.action === 'continue' ? 'Insert' : 'Insert below', variant: 'primary', size: 'sm', action: 'editor.ai', data: { op: 'below' } })}`;
    const extras = !streaming && ai.status !== 'error' ? html`${iconButton({ icon: 'copy', label: 'Copy', action: 'editor.ai', data: { op: 'copy' }, size: 'sm' })}
      ${iconButton({ icon: 'refresh-cw', label: 'Try again', action: 'editor.ai', data: { op: 'retry' }, size: 'sm' })}` : '';
    return html`<div class="ne-ai-card" role="region" aria-label="AI result" data-status="${ai.status}" aria-busy="${streaming ? 'true' : 'false'}">
      <div class="ne-ai-head">${icon('sparkles', { size: 14, className: 'ne-ai-mark' })}<span class="ne-ai-label">${ai.label}</span>
        ${streaming ? html`<span class="ne-ai-state">${spinner({ size: 12 })}<span>Writing</span></span>` : ''}
        <span class="ne-foot-spacer"></span>${iconButton({ icon: 'x', label: 'Discard', action: 'editor.ai', data: { op: 'discard' }, size: 'xs' })}</div>
      <div class="ne-ai-body">${body}</div>
      <div class="ne-ai-actions">${actions}${extras}<span class="ne-foot-spacer"></span>
        ${streaming ? '' : button({ label: 'Discard', variant: 'ghost', size: 'sm', action: 'editor.ai', data: { op: 'discard' } })}</div>
      <span class="sr-only" role="status">${streaming ? '' : ai.status === 'done' ? 'AI result ready' : ''}</span>
    </div>`;
  }

  function closeAi() {
    st.ai?.controller?.abort();
    st.ai = null;
    st.aiSel = null;
    renderAi();
  }

  function applyAi(op) {
    const ai = st.ai;
    if (!ai || !editor) return;
    if (op === 'stop') { ai.controller.abort(); return; }
    if (op === 'discard') { closeAi(); editor.focus({ at: 'end' }); return; }
    if (op === 'retry') { st.aiSel = ai.sel; runAi(ai.action, { language: ai.language }); return; }
    if (op === 'settings') { closeAi(); openAiSettings(ctx); return; }
    const result = ai.text.trim();
    if (!result) return;
    if (op === 'copy') { navigator.clipboard?.writeText(result).then(() => ctx.toast('Copied')); return; }
    if (op === 'title' && els.title) {
      els.title.value = result.replace(/^#+\s*/, '').replace(/^["“']|["”']$/g, '').split('\n')[0].trim();
      autosizeTitle();
      changed();
      closeAi();
      return;
    }
    if (op === 'tags') { const record = item(); metaWrite({ tags: mergeTagList(record?.tags, result) }); closeAi(); return; }
    const current = editor.getMarkdown();
    const sel = ai.sel;
    const unchanged = current === sel.markdown;
    let next;
    if (op === 'replace') {
      if (!sel.hasSelection) next = result;
      else if (unchanged || current.slice(sel.start, sel.end) === sel.markdown.slice(sel.start, sel.end)) next = applyAiResult(current, sel, result, 'replace');
      else { ctx.toast('The note changed, so the result was added at the end.'); next = applyAiResult(current, null, result, 'below'); }
    } else {
      const at = ai.action === 'continue' ? { start: sel.caret, end: sel.caret } : sel.hasSelection ? sel : null;
      next = applyAiResult(current, unchanged || (at && current.slice(0, at.end) === sel.markdown.slice(0, at.end)) ? at : null, result, 'below');
    }
    editor.setMarkdown(next, { emit: true });
    closeAi();
    editor.focus({ at: 'end' });
  }

  /* ---------- teardown ---------- */

  function destroy() {
    if (st.destroyed) return;
    if (st.dirty && st.built && !st.conflict) save();
    st.destroyed = true;
    clearTimeout(st.footTimer);
    clearTimeout(st.draftTimer);
    if (st.dirty) putDraft(draftKey, { text: currentText(), title: inline ? null : els.title?.value ?? null, base: st.base?.updatedAt });
    st.ai?.controller?.abort();
    if (st.aiFrame) cancelAnimationFrame(st.aiFrame);
    observer?.disconnect();
    for (const [target, type, fn, options] of listeners) target.removeEventListener(type, fn, options);
    st.queue.then(() => { clearTimeout(st.timer); editor?.destroy(); editor = null; });
    live.delete(instance);
    if (active === instance) active = null;
  }

  return instance;
}

/* ------------------------------------------------------------------ meta row and backlinks */

function renderMeta(ctx, instance, record, surface) {
  const collection = record.collectionId ? ctx.select.collection(record.collectionId) : null;
  const picker = typeof pickers.renderCollectionPickerTrigger === 'function'
    ? pickers.renderCollectionPickerTrigger({ ctx, value: record.collectionId || '', action: 'editor.set-collection', id: `${instance.key}-collection`, size: 'sm', label: 'Collection', className: 'ne-prop ne-collection' })
    : html`<span class="ne-prop"><span class="ne-dot" style="--dot:${collection ? colorVar(collection.color) : 'var(--fg-faint)'}" aria-hidden="true"></span>${collection?.name || 'Inbox'}</span>`;
  const page = record.url
    ? html`<span class="ne-prop ne-page"><button type="button" class="ne-page-open" data-action="app.open-url" data-url="${record.url}" title="${record.url}" aria-label="Open ${domainOf(record.url) || 'linked page'}">
        ${favicon(record.url, { size: 14 })}<span class="ne-page-domain">${domainOf(record.url) || record.url}</span>${icon('arrow-up-right', { size: 12, className: 'ne-page-arrow' })}</button>
        ${iconButton({ icon: 'x', label: 'Unlink page', action: 'editor.unlink-page', size: 'xs', className: 'ne-page-unlink' })}</span>`
    : surface === 'side' && /^https?:/i.test(ctx.state.page?.url || '')
      ? button({ label: 'Link this page', icon: 'link', variant: 'ghost', size: 'sm', action: 'editor.link-page', className: 'ne-prop-add' }) : '';
  const reminderText = record.reminderAt ? (typeof pickers.formatReminder === 'function' ? pickers.formatReminder(record.reminderAt) : relativeDate(record.reminderAt)) : '';
  const reminder = record.reminderAt
    ? html`<button type="button" class="${cx('ne-prop', 'ne-reminder', record.reminderNotifiedAt && 'is-past')}" data-action="editor.reminder" aria-haspopup="menu" aria-label="Reminder: ${reminderText}. Change">
        ${icon(record.reminderNotifiedAt ? 'bell-off' : 'bell-ring', { size: 14 })}<span>${reminderText}</span></button>`
    : button({ label: 'Remind', icon: 'bell', variant: 'ghost', size: 'sm', action: 'editor.reminder', className: 'ne-prop-add', attrs: { 'aria-haspopup': 'menu' } });
  // The side panel keeps Pin in the note menu so the property row stays on one line.
  const pin = surface === 'side' ? '' : iconButton({ icon: 'pin', label: record.pinned ? 'Unpin note' : 'Pin note', pressed: !!record.pinned, action: 'editor.pin', size: 'sm', className: 'ne-pin' });
  const tags = typeof pickers.renderTagInput === 'function'
    ? pickers.renderTagInput({ ctx, tags: record.tags || [], action: 'editor.set-tags', id: `${instance.key}-tags`, placeholder: record.tags?.length ? 'Add tag' : 'Add tags', label: 'Tags', className: 'ne-tags' })
    : (record.tags || []).length ? html`<span class="ne-prop">${record.tags.map(tag => `#${tag}`).join(' ')}</span>` : '';
  return html`<div class="ne-props">${picker}${page}${reminder}${pin}</div>${tags}`;
}

/* ------------------------------------------------------------------ uploaded cover and icon */

/** The page's uploaded (or linked) cover as a banner with change and remove buttons; '' when it has none. */
function renderPageCover(record) {
  const src = safeSrc(record.cover);
  if (!src) return '';
  return html`<figure class="ne-cover-figure"><img src="${src}" alt="" decoding="async" referrerpolicy="no-referrer" draggable="false">
    <span class="ne-cover-actions">
      ${button({ label: 'Change cover', icon: 'image', variant: 'secondary', size: 'sm', action: 'editor.cover-upload' })}
      ${iconButton({ icon: 'x', label: 'Remove cover', action: 'editor.cover-remove', size: 'sm', variant: 'secondary' })}
    </span></figure>`;
}

/** The page icon above the title (a button with change and remove), and Add icon / Add cover while either is missing. */
function renderDecor(record) {
  const own = customIcon(record, { size: 56, className: 'ne-page-icon' });
  return html`${own ? html`<button type="button" class="ne-page-icon-btn" data-action="editor.icon-menu" aria-haspopup="menu" aria-label="Page icon. Change or remove">${own}</button>` : ''}
    ${!own || !record.cover ? html`<span class="ne-decor-add">
      ${own ? '' : button({ label: 'Add icon', icon: 'smile-plus', variant: 'ghost', size: 'sm', action: 'editor.icon-upload' })}
      ${record.cover ? '' : button({ label: 'Add cover', icon: 'image', variant: 'ghost', size: 'sm', action: 'editor.cover-upload' })}
    </span>` : ''}`;
}

/* ------------------------------------------------------------------ page path and subpages */

const pageGlyph = (entry, size = 14, className = 'ne-link-icon') => entry.type === 'note' ? icon('file-text', { size, className })
  : entry.url ? favicon(entry.url, { size }) : icon(TYPE_ICONS[entry.type] || 'file', { size, className });

/** The page path above the title: the ancestors of a subpage, each one a button that opens it. */
function renderCrumbs(ctx, record, surface) {
  const parentId = parentIdOf(record);
  const parent = parentId ? latestItem(ctx, parentId) : null;
  if (!parent || parent.deletedAt) return '';
  const ancestors = [...ctx.select.pagePath(parent.id), parent].filter(entry => entry.id !== record.id);
  const trail = crumbTrail(ancestors, surface === 'side' ? 2 : 3);
  return html`<ol class="ne-crumbs-list">${trail.map((entry, index) => html`<li class="ne-crumb-item" data-key="crumb:${entry.item?.id || 'more'}">
    ${index ? icon('chevron-right', { size: 12, className: 'ne-crumb-sep' }) : ''}
    ${entry.more
      ? html`<button type="button" class="ne-crumb is-more" data-action="editor.crumbs-more" data-ids="${entry.more.map(item => item.id).join(',')}" aria-haspopup="menu"
          aria-label="${plural(entry.more.length, 'more page')} in the path" data-tooltip="${entry.more.map(item => displayTitle(item)).join(' / ')}">…</button>`
      : html`<button type="button" class="ne-crumb" data-action="editor.open-link" data-id="${entry.item.id}">${pageGlyph(entry.item, 14, 'ne-crumb-icon')}<span class="ne-crumb-title">${displayTitle(entry.item)}</span></button>`}
  </li>`)}</ol>`;
}

/** Subpages of this note, oldest first, each opening in the editor; hidden while there are none. */
function renderSubpages(ctx, record) {
  const children = ctx.select.children(record.id);
  if (!children.length) return '';
  return html`<h2 class="ne-links-title">Subpages<span class="ne-count-pill">${children.length}</span></h2>
    <ul class="ne-links-list">${children.map(child => {
      const inner = ctx.select.subpageCount(child.id);
      return html`<li data-key="sp:${child.id}"><button type="button" class="ne-link-row" data-action="editor.open-link" data-id="${child.id}">
        ${icon('file-text', { size: 14, className: 'ne-link-icon' })}<span class="ne-link-title">${displayTitle(child)}</span>
        <span class="ne-link-meta">${inner ? `${plural(inner, 'subpage')} · ` : ''}${relativeDate(child.updatedAt)}</span></button></li>`;
    })}</ul>
    <div class="ne-subpages-foot">${button({ label: 'New subpage', icon: 'plus', variant: 'ghost', size: 'sm', action: 'editor.new-subpage' })}</div>`;
}

/** A resolved link with the meta line page blocks show ("3 subpages"). */
function withPageMeta(ctx, hit) {
  if (!hit?.id) return hit;
  const count = ctx.select.subpageCount?.(hit.id) || 0;
  return count ? { ...hit, meta: plural(count, 'subpage') } : hit;
}

/* ------------------------------------------------------------------ "Move to page…" picker */

function pagePickerOptions(ctx, props) {
  const record = latestItem(ctx, props.id);
  const query = String(props.query || '').trim().toLowerCase();
  const options = [];
  if (parentIdOf(record) && (!query || 'top level'.includes(query))) options.push({ kind: 'top', id: '' });
  for (const item of pageMoveCandidates(ctx.library?.items || [], { id: props.id, query })) options.push({ kind: 'item', id: item.id, item });
  return options;
}
const activeOption = (options, props) => (Number.isInteger(props.active) && props.active >= 0 && props.active < options.length ? props.active : 0);

function renderPagePicker(ctx, props) {
  const options = pagePickerOptions(ctx, props);
  const active = activeOption(options, props);
  const current = parentIdOf(latestItem(ctx, props.id));
  const query = String(props.query || '');
  const option = (o, index) => {
    const selected = o.kind === 'item' && o.id === current;
    return html`<div role="option" id="pick-page-${index}" class="${cx('pick-option', index === active && 'is-active')}" aria-selected="${selected ? 'true' : 'false'}"
      data-action="pick.page-choose" data-index="${index}">
      ${o.kind === 'top' ? icon('arrow-up-from-line', { size: 16 }) : pageGlyph(o.item, 16, '')}
      <span class="pick-option-label">${o.kind === 'top' ? 'Top level' : displayTitle(o.item)}</span>
      ${o.kind === 'item' ? html`<span class="pick-option-count">${TYPE_LABELS[o.item.type] || 'Item'}</span>` : ''}${selected ? icon('check', { size: 14, className: 'pick-option-check' }) : ''}</div>`;
  };
  return html`<div class="pick-collection pick-page" data-key="pick-page">
    <div class="pick-title">Move to page</div>
    <div class="pick-search">${icon('search', { size: 16 })}
      <input class="pick-search-input" id="pick-page-search" data-focus-key="pick-page-search" type="text" role="combobox" aria-expanded="true"
        aria-controls="pick-page-list" aria-autocomplete="list" aria-activedescendant="${options.length ? `pick-page-${active}` : ''}"
        aria-label="Find a page to move this note into" placeholder="Find a page" value="${query}"
        data-input="pick.page-query" data-keydown="pick.page-key" data-autofocus autocomplete="off" spellcheck="false">
      ${kbd('Esc')}
    </div>
    <div class="pick-list" role="listbox" id="pick-page-list" aria-label="Pages">
      ${options.map(option)}
      ${options.length ? '' : html`<p class="pick-empty" role="presentation">${query.trim() ? `No pages match “${query.trim()}”` : 'No other pages yet'}</p>`}
    </div>
    <p class="sr-only" role="status" aria-live="polite">${query.trim() ? plural(options.length, 'match', 'matches') : ''}</p>
  </div>`;
}
registerPopover('pick.page', renderPagePicker, { role: 'none', className: 'pick-popover pick-collection-popover' });

/** "Move to page…": pick any item (not this note or one of its subpages), or the top level. */
export function openPagePicker(ctx, anchor, id) {
  ctx.openPopover('pick.page', anchor, { id, query: '', active: null, onPick: parentId => ctx.run(async () => {
    await editorFor(id)?.save();
    await movePageTo(ctx, id, parentId);
  }) }, { placement: 'bottom-end' });
}

async function choosePage(ctx, index) {
  const props = ctx.state.popover?.name === 'pick.page' ? ctx.state.popover.props : null;
  const option = props && pagePickerOptions(ctx, props)[index];
  if (!option) return;
  ctx.closePopover();
  await props.onPick?.(option.id);
}

function renderLinks(ctx, record, surface) {
  // The parent page links here through its page block; the page path above the title already shows it.
  const parentId = parentIdOf(record);
  const back = ctx.select.backlinks(record.id).filter(entry => !entry.deletedAt && entry.id !== parentId);
  if (!back.length) return '';
  return html`<h2 class="ne-links-title">Linked from<span class="ne-count-pill">${back.length}</span></h2>
    <ul class="ne-links-list">${back.slice(0, 20).map(entry => html`<li data-key="bl:${entry.id}"><button type="button" class="ne-link-row" data-action="editor.open-link" data-id="${entry.id}">
      ${entry.type === 'note' ? icon('sticky-note', { size: 14, className: 'ne-link-icon' }) : entry.url ? favicon(entry.url, { size: 14 }) : icon(TYPE_ICONS[entry.type] || 'file', { size: 14, className: 'ne-link-icon' })}
      <span class="ne-link-title">${displayTitle(entry)}</span><span class="ne-link-meta">${entry.type === 'note' ? relativeDate(entry.updatedAt) : domainOf(entry.url)}</span></button></li>`)}</ul>`;
}

/* ------------------------------------------------------------------ navigation helpers */

function openLinked(ctx, linkId) {
  const target = ctx.select.byId(linkId);
  if (!target || target.deletedAt) { ctx.toast('That item is no longer in your library.', { tone: 'danger' }); return; }
  if (target.type === 'note') openNote(ctx, target.id);
  else ctx.openItem(target.id);
}

export async function openInFullTab(ctx, id) {
  await flushAllEditors();
  const base = ctx.env.isExtension ? chrome.runtime.getURL('index.html') : new URL('index.html', location.href).href;
  const url = new URL(base);
  url.searchParams.set('libraryView', 'notes');
  url.searchParams.set('item', id);
  if (ctx.env.isExtension) await chrome.tabs.create({ url: url.href }); else window.open(url.href, '_blank', 'noopener');
}

function openAiSettings(ctx) {
  if (hasAction('shell.settings')) { ctx.dispatch('shell.settings', { data: { section: 'ai' } }); return; }
  import('./settings.js').then(module => module.openSettings?.(ctx, 'ai')).catch(() => {});
}

/* ------------------------------------------------------------------ actions and shortcuts */

const withInstance = handler => args => { const instance = instanceOf(args.el); return instance ? handler(instance, args) : undefined; };

registerActions({
  'editor.set-collection': withInstance((instance, { ctx, data }) => {
    const id = data.value || '';
    if (id) ctx.prefs?.touchCollection?.(id);
    return instance.metaWrite({ collectionId: id });
  }),
  'editor.set-tags': withInstance((instance, { data }) => instance.metaWrite({ tags: Array.isArray(data.tags) ? data.tags : String(data.value || '').split(',').map(t => t.trim()).filter(Boolean) })),
  'editor.pin': withInstance((instance, { ctx }) => {
    const record = latestItem(ctx, instance.id);
    return instance.metaWrite({ pinned: !record?.pinned });
  }),
  'editor.reminder': withInstance((instance, { ctx, el }) => {
    const record = latestItem(ctx, instance.id);
    ctx.openPopover('pick.reminder', el, { value: record?.reminderAt || null, onPick: iso => instance.metaWrite({ reminderAt: iso || null }) }, { placement: 'bottom-start' });
  }),
  'editor.unlink-page': withInstance(async (instance, { ctx }) => {
    const record = latestItem(ctx, instance.id);
    const url = record?.url;
    if (!url) return;
    await instance.metaWrite({ url: '' });
    ctx.toast(`Unlinked from ${domainOf(url) || 'the page'}`, { action: { label: 'Undo', run: () => instance.metaWrite({ url }) } });
  }),
  'editor.link-page': withInstance((instance, { ctx }) => {
    const url = ctx.state.page?.url;
    if (/^https?:/i.test(url || '')) return instance.metaWrite({ url });
    return undefined;
  }),
  'editor.unarchive': withInstance(instance => instance.metaWrite({ archived: false })),
  'editor.cover-upload': withInstance((instance, { ctx }) => uploadItemImage(ctx, instance.id, 'cover', { write: instance.metaWrite })),
  'editor.cover-remove': withInstance((instance, { ctx }) => removeItemImage(ctx, instance.id, 'cover', { write: instance.metaWrite })),
  'editor.icon-upload': withInstance((instance, { ctx }) => uploadItemImage(ctx, instance.id, 'icon', { write: instance.metaWrite })),
  'editor.icon-menu': withInstance((instance, { ctx, el }) => {
    ctx.openMenu(el, iconMenuItems(ctx, latestItem(ctx, instance.id), { write: instance.metaWrite }), { label: 'Page icon' });
  }),
  'editor.open-link': ({ ctx, data }) => openLinked(ctx, data.id),
  'editor.new-subpage': withInstance(instance => instance.newSubpage()),
  'editor.crumbs-more': ({ ctx, el, data }) => {
    const entries = String(data.ids || '').split(',').map(id => ctx.select.byId(id)).filter(entry => entry && !entry.deletedAt);
    if (entries.length) ctx.openMenu(el, entries.map(entry => ({ label: displayTitle(entry), icon: entry.type === 'note' ? 'file-text' : TYPE_ICONS[entry.type] || 'file', run: () => openLinked(ctx, entry.id) })), { label: 'Page path' });
  },
  'pick.page-query': ({ ctx, el }) => {
    const props = ctx.state.popover?.name === 'pick.page' ? ctx.state.popover.props : null;
    if (!props) return;
    props.query = el.value;
    props.active = null;
    ctx.render();
  },
  'pick.page-key': async ({ ctx, event }) => {
    const props = ctx.state.popover?.name === 'pick.page' ? ctx.state.popover.props : null;
    if (!props || event.metaKey || event.ctrlKey || event.altKey) return;
    const options = pagePickerOptions(ctx, props);
    const active = activeOption(options, props);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!options.length) return;
      props.active = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      ctx.render();
      ctx.nextFrame(() => document.getElementById(`pick-page-${props.active}`)?.scrollIntoView({ block: 'nearest' }));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      await choosePage(ctx, active);
    }
  },
  'pick.page-choose': ({ ctx, data }) => choosePage(ctx, Number(data.index)),
  'editor.ai': withInstance((instance, { data }) => instance.applyAi(data.op)),
  'editor.banner': withInstance((instance, { data }) => instance.resolveBanner(data.op)),
  'editor.retry': withInstance(instance => instance.retry()),
  'editor.mode': withInstance((instance, { data }) => instance.setMode(data.mode)),
  'editor.save': () => getActiveEditor()?.save(),
  'editor.done': async ({ ctx }) => {
    const instance = getActiveEditor();
    if (!instance) return;
    await instance.save();
    if (ctx.env.isSidepanel && !instance.inline) closeNote(ctx, instance.id);
  },
});

const editorFocused = () => !!document.activeElement?.closest?.('[data-mount="note-editor"]');
registerShortcuts([
  { keys: 'mod+s', action: 'editor.save', label: 'Save the open note', allowInInputs: true, when: ctx => !ctx.state.dialogs.length && live.size > 0 },
  { keys: 'mod+enter', action: 'editor.done', label: 'Save and close the note', allowInInputs: true, when: ctx => !ctx.state.dialogs.length && !ctx.state.popover && editorFocused() },
]);

let initialized = false;
export function init() {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;
  addEventListener('pagehide', () => { flushAllEditors(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAllEditors(); });
}
