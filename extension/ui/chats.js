// AI chats (library items of type "chat", synced from Threadkeeper): the chat page and the full-tab Chats workspace.
//
// A chat page looks like a note page (the .ne shell from notes.css: toolbar, crumbs, title, quiet meta row, footer)
// and has two views:
//   Summary     Threadkeeper's analysis as Markdown (lib/threadkeeper/summary.js), then "Your notes" (item.content,
//               the same inline editor as an item's personal note), Subpages and Linked from.
//   Transcript  the conversation as bubbles, rendered once into a mount (data-morph="skip") keyed by the stored
//               transcript, paged 150 messages from the end, with find-in-chat, long-message folding, tool calls in
//               <details>, copy buttons and "load the missing messages from Threadkeeper" rows for truncated copies.
// The page has three hosts: the detail branch (side panel and the full tab's right panel, detail.js) and the Chats
// workspace (view "chats": list | page, modelled on the Notes workspace).
//
// Everything a chat page shows beyond the library item lives in IndexedDB (lib/chat-data.js) and is read
// asynchronously, cached per chat (LRU: 50 records, 3 transcripts). Thread text is untrusted: it is escaped, rendered
// with renderMarkdown(…, { images: false }) (remote images become links) and never interpreted. Find-in-chat walks
// DOM text nodes; it never rewrites rendered HTML with a regex.
import { html, raw, cx, esc, plural } from './html.js';
import { icon } from './icons.js';
import { button, iconButton, segmented, searchField, emptyState, skeleton, badge, relativeDate, shortDate, colorVar } from './components.js';
import { registerActions, registerMount } from './runtime.js';
import * as pickers from './pickers.js';
import { renderInlineEditor, addSubpage, openNote, displayTitle, createNoteItem, rememberItem } from './note-editor.js';
import { moveItems, trashItems, restoreItems, deleteForever, setFavorite, menuOpenFor } from './library.js';
import { askAi } from './ai-panel.js';
import { openThreadkeeperPicker } from './threadkeeper-picker.js';
import { renderMarkdown } from '../lib/markdown.js';
import * as chatData from '../lib/chat-data.js';
import * as tkClient from '../lib/threadkeeper/client.js';
import { buildChatSummaryMarkdown, normalizeLlmMarkdown, safeResumeCommand, workflowLabel, categoryLabel, oneLine } from '../lib/threadkeeper/summary.js';

export const TRANSCRIPT_PAGE = 150;
export const LONG_MESSAGE = 6000;
const LIST_PAGE = 150;
const WINDOW_MAX = 500;
const CATEGORY_ICONS = { chat: 'messages-square', coding_agent: 'square-terminal', agent: 'bot', builder: 'hammer', search: 'search', companion: 'heart' };
const CATEGORY_PLURALS = { chat: 'Chats', coding_agent: 'Coding agents', agent: 'Agents', builder: 'Builders', search: 'Search', companion: 'Companions' };
const STATE_TONES = { active: 'accent', needs_review: 'warning', waiting: 'warning', paused: 'neutral', done: 'success', archived: 'neutral' };
const REMOVED = {
  deleted: { icon: 'trash-2', text: 'This thread was deleted in Threadkeeper. Your copy stays here and no longer updates.' },
  out_of_scope: { icon: 'circle-dot', text: 'This thread is no longer in what you sync from Threadkeeper, so it stopped updating.' },
  local_only: { icon: 'eye-off', text: 'This thread is private in Threadkeeper now. Its summary and transcript were removed; your notes and subpages stay.' },
  disconnected: { icon: 'circle-dot', text: 'Threadkeeper is disconnected, so this chat no longer updates.' },
};

/* ------------------------------------------------------------------ dependencies (replaceable in tests) */

const deps = {
  getChatRecord: id => chatData.getChatRecord(id),
  getChatTranscript: id => chatData.getChatTranscript(id),
  searchChats: (query, options) => (typeof chatData.searchChats === 'function' ? chatData.searchChats(query, options) : Promise.resolve([])),
  client: tkClient,
};
/** Tests swap the data store and the Threadkeeper client: configureChats({ getChatRecord, getChatTranscript, searchChats, client }). */
export function configureChats(overrides = {}) {
  Object.assign(deps, overrides);
  records.clear();
  transcripts.clear();
}

/* ------------------------------------------------------------------ Threadkeeper state (device-only, read through the client) */

let tk = { status: 'off', tk: { version: '', capabilities: [] }, prefs: {} };
const tkListeners = new Set();
/** The last Threadkeeper integration state this page read (a copy; never written here). */
export const threadkeeperSnapshot = () => tk;
export const isPaired = (state = tk) => !!deps.client.isThreadkeeperReady?.(state);
const hasCapability = (name, state = tk) => isPaired(state) && (state.tk?.capabilities || []).includes(name);
const tkPrefs = (state = tk) => state?.prefs || {};
/** Sets the cached state (init and tests); notifies the page so the sidebar's Chats row and the chat pages follow. */
export function setThreadkeeperSnapshot(next) {
  if (!next || typeof next !== 'object') return;
  tk = next;
  for (const fn of tkListeners) { try { fn(tk); } catch (error) { console.warn('[still] chats listener', error); } }
}
async function readThreadkeeperState() {
  try { setThreadkeeperSnapshot(await deps.client.getThreadkeeperState()); } catch (error) { console.warn('[still] Threadkeeper state unavailable', error?.message); }
}

/* ------------------------------------------------------------------ pure helpers (unit-tested) */

const str = value => (typeof value === 'string' ? value : value == null ? '' : String(value));
export const chatOf = item => (item?.chat && typeof item.chat === 'object' ? item.chat : {});
/** When the conversation last moved: the thread's last activity, else the item's update time. */
export const chatActivity = item => str(chatOf(item).lastActivityAt) || str(item?.updatedAt) || str(item?.createdAt);
export const categoryIcon = category => CATEGORY_ICONS[category] || CATEGORY_ICONS.chat;
/** True for a chat still where sync placed it (the user has not moved it): such chats stay out of All items and the Inbox. */
export { isAutoPlacedChat } from './selectors.js';

/** Category and provider chips for a set of chats: { categories: [{ id, label, count }], providers: [{ id, label, count }] }, most used first. */
export function chatFacets(items) {
  const categories = new Map(), providers = new Map();
  for (const item of items || []) {
    const chat = chatOf(item);
    const category = CATEGORY_ICONS[chat.category] ? chat.category : 'chat';
    categories.set(category, (categories.get(category) || 0) + 1);
    const provider = str(chat.provider) || 'unknown';
    const entry = providers.get(provider) || { id: provider, label: oneLine(chat.providerLabel || item.siteName) || provider, count: 0 };
    entry.count++;
    providers.set(provider, entry);
  }
  const order = (a, b) => b.count - a.count || a.label.localeCompare(b.label);
  return {
    categories: [...categories].map(([id, count]) => ({ id, label: CATEGORY_PLURALS[id], count })).sort(order),
    providers: [...providers.values()].sort(order),
  };
}

const haystackOf = item => {
  const chat = chatOf(item);
  return [item.title, item.excerpt, item.content, item.siteName, chat.providerLabel, chat.project, chat.agentLabel, chat.kindLabel, chat.model,
    ...(chat.topics || []), ...(item.tags || [])].map(str).join('\n').toLowerCase();
};

/**
 * Chats for the workspace list: category, provider and collection filters, then a search (every word must appear in
 * the title, gist, notes, provider, project, topics or tags, or the chat must be among `deep`, the ids the chat store's
 * full-text search returned), newest activity first. collectionId: '' for all, '__none' for the Inbox.
 */
export function filterChats(items, { query = '', category = '', provider = '', collectionId = '', deep = null } = {}) {
  let rows = (items || []).filter(item => item?.type === 'chat');
  if (category) rows = rows.filter(item => (CATEGORY_ICONS[chatOf(item).category] ? chatOf(item).category : 'chat') === category);
  if (provider) rows = rows.filter(item => (str(chatOf(item).provider) || 'unknown') === provider);
  if (collectionId === '__none') rows = rows.filter(item => !item.collectionId);
  else if (collectionId) rows = rows.filter(item => item.collectionId === collectionId);
  const words = str(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) rows = rows.filter(item => (deep && deep.has(item.id)) || words.every(word => haystackOf(item).includes(word)));
  return [...rows].sort((a, b) => chatActivity(b).localeCompare(chatActivity(a)) || str(a.title).localeCompare(str(b.title)));
}

/** "Tool · Read src/x.ts": the first non-empty line of a tool message, shortened. */
export function toolTitle(content) {
  let line = str(content).split('\n').map(part => part.trim()).find(Boolean) || '';
  // Threadkeeper marks CLI tool traffic "[tool] Edit: …", "[tool result] …", "[tool error] …"; the chip already says Tool.
  const marker = /^\[tool( result| error)?\]\s*/i.exec(line);
  if (marker) {
    const rest = line.slice(marker[0].length).trim();
    const kind = (marker[1] || '').trim().toLowerCase();
    line = kind === 'result' ? (rest ? `Result · ${rest}` : 'Result') : kind === 'error' ? (rest ? `Error · ${rest}` : 'Error') : rest;
  }
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/** Where a long message folds: the last line break between 4,000 and 6,000 characters, else 6,000. */
export function foldPoint(text, limit = LONG_MESSAGE) {
  const value = str(text);
  if (value.length <= limit) return value.length;
  const cut = value.lastIndexOf('\n', limit);
  return cut > limit * 0.66 ? cut : limit;
}

/** Usable transcript messages in order: valid 0-based indexes, known roles, string content, first copy of an index wins. */
export function cleanMessages(messages) {
  const seen = new Set(), out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const index = Number(m?.index);
    if (!Number.isInteger(index) || index < 0 || seen.has(index)) continue;
    const role = ['user', 'assistant', 'system', 'tool'].includes(m.role) ? m.role : null;
    if (!role) continue;
    seen.add(index);
    out.push({ index, role, content: str(m.content), createdAt: str(m.createdAt) });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * The rows a transcript draws from position `start` of the stored messages: { kind: 'message', message, position }
 * plus { kind: 'gap', from, to } wherever stored indexes skip (before the first, between two, and after the last when
 * totalMessages says more exist). Gaps before `start` are left out (they sit behind "Show earlier messages").
 */
export function transcriptRows(messages, { start = 0, totalMessages = 0 } = {}) {
  const rows = [];
  const first = Math.max(0, Math.min(start, messages.length));
  for (let i = first; i < messages.length; i++) {
    const message = messages[i];
    const previous = i > 0 ? messages[i - 1].index : -1;
    if (message.index > previous + 1 && (i > first || i === 0)) rows.push({ kind: 'gap', from: previous + 1, to: message.index - 1 });
    rows.push({ kind: 'message', message, position: i });
  }
  const last = messages.length ? messages[messages.length - 1].index : -1;
  if (totalMessages > last + 1) rows.push({ kind: 'gap', from: last + 1, to: totalMessages - 1 });
  return rows;
}

/** Positions (into the stored messages) of the messages whose text contains the query, ignoring case. */
export function findMessages(messages, query) {
  const needle = str(query).trim().toLowerCase();
  if (!needle) return [];
  const out = [];
  messages.forEach((m, i) => { if (m.content.toLowerCase().includes(needle)) out.push(i); });
  return out;
}

/** The first position to draw so that `position` is on screen, keeping whole pages counted from the end. */
export function startFor(position, length, current, page = TRANSCRIPT_PAGE) {
  if (position >= current) return current;
  const fromEnd = length - position;
  return Math.max(0, length - Math.ceil(fromEnd / page) * page);
}

const timeLabel = iso => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const assistantHtml = text => renderMarkdown(normalizeLlmMarkdown(text), { images: false });

/**
 * One transcript message as HTML. who: the assistant's label (provider or agent); category picks its avatar glyph;
 * expanded: show a long message whole. Message text is escaped (user, tool, system) or rendered as safe Markdown
 * without images (assistant).
 */
export function messageMarkup(message, { who = 'Assistant', category = 'chat', expanded = false } = {}) {
  const { index, role, content, createdAt } = message;
  const long = content.length > LONG_MESSAGE;
  const cut = long && !expanded ? foldPoint(content) : content.length;
  const shown = content.slice(0, cut);
  const label = role === 'user' ? 'You' : role === 'assistant' ? who : role === 'tool' ? 'Tool' : 'System';
  const time = createdAt ? timeLabel(createdAt) : '';
  const meta = html`<div class="chat-msg-meta"><span class="chat-msg-who">${label}</span>
    <a class="chat-msg-ref" href="#msg-${index}" aria-label="Message ${index + 1}">m${index + 1}</a>${time ? html`<time class="chat-msg-time" datetime="${createdAt}">${time}</time>` : ''}
    <button type="button" class="chat-msg-copy" data-tx="copy" data-index="${index}" aria-label="Copy message ${index + 1}" data-tooltip="Copy">${icon('copy', { size: 14 })}</button></div>`;
  const more = long ? html`<button type="button" class="chat-msg-more" data-tx="more" data-index="${index}" aria-expanded="${expanded ? 'true' : 'false'}">${expanded
    ? 'Show less' : `Show more (${(content.length - cut).toLocaleString()} more characters)`}</button>` : '';
  let body;
  if (role === 'user') body = html`<div class="chat-bubble chat-msg-body">${shown}</div>`;
  else if (role === 'assistant') body = html`<div class="chat-md markdown-body chat-msg-body">${raw(assistantHtml(shown))}</div>`;
  else if (role === 'tool') {
    return String(html`<article class="chat-msg" data-role="tool" id="msg-${index}" data-index="${index}" aria-label="Tool, message ${index + 1}">
      <details class="chat-tool"><summary class="chat-tool-summary">${icon('wrench', { size: 14 })}<span class="chat-tool-label">Tool</span><span class="chat-tool-title">${toolTitle(content) || 'No output'}</span><span class="chat-msg-ref is-quiet">m${index + 1}</span></summary>
        <pre class="chat-tool-body chat-msg-body">${shown}</pre>${more}</details></article>`);
  } else body = html`<p class="chat-system chat-msg-body">${shown}</p>`;
  const avatar = role === 'assistant' ? html`<span class="chat-avatar" data-category="${category}" aria-hidden="true">${icon(categoryIcon(category), { size: 14 })}</span>` : '';
  return String(html`<article class="chat-msg" data-role="${role}" id="msg-${index}" data-index="${index}" aria-label="${label}, message ${index + 1}">
    ${avatar}<div class="chat-msg-main">${role === 'system' ? '' : meta}${body}${more}</div></article>`);
}

/* ------------------------------------------------------------------ cached chat data (LRU) */

class Lru {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(key) { if (!this.map.has(key)) return undefined; const value = this.map.get(key); this.map.delete(key); this.map.set(key, value); return value; }
  set(key, value) { this.map.delete(key); this.map.set(key, value); while (this.map.size > this.max) this.map.delete(this.map.keys().next().value); return value; }
  clear() { this.map.clear(); }
  dropPrefix(prefix) { for (const key of [...this.map.keys()]) if (key.startsWith(prefix)) this.map.delete(key); }
}
const records = new Lru(50);
const transcripts = new Lru(3);
const bumps = new Map(); // chat id -> local revision of its stored data (refresh, loaded windows)
const recordKey = item => `${item.id}:${chatOf(item).fingerprint || ''}:${chatOf(item).syncedAt || ''}:${bumps.get(item.id) || 0}`;
const transcriptKey = item => `${item.id}:${chatOf(item).revision || 0}:${chatOf(item).syncedAt || ''}:${bumps.get(item.id) || 0}`;

function load(cache, key, read, ctx) {
  const hit = cache.get(key);
  if (hit) return hit;
  const entry = cache.set(key, { status: 'loading', value: null, error: '' });
  Promise.resolve().then(read).then(value => { entry.status = 'ready'; entry.value = value || null; },
    error => { entry.status = 'error'; entry.error = error?.message || 'Still could not read this chat on this device.'; })
    .finally(() => ctx?.render?.());
  return entry;
}
/** The stored record of a chat ({ status, value }), loading it once per synced version. */
export const chatRecord = (ctx, item) => load(records, recordKey(item), () => deps.getChatRecord(item.id), ctx);
/** The stored transcript of a chat ({ status, value }), loading it once per synced version. */
export const chatTranscript = (ctx, item) => load(transcripts, transcriptKey(item), () => deps.getChatTranscript(item.id), ctx);
/** Forgets what this page read for a chat (after a refresh or a loaded window), so the next render reads it again. */
export function invalidateChat(id) {
  bumps.set(id, (bumps.get(id) || 0) + 1);
  records.dropPrefix(`${id}:`);
  transcripts.dropPrefix(`${id}:`);
}

/* ------------------------------------------------------------------ page state */

const chatsState = ctx => (ctx.state.chats ||= { chatId: null, query: '', category: '', provider: '', collectionId: '', deep: null });
const viewFor = ctx => {
  const saved = ctx.prefs.get('chatView', '');
  if (saved === 'summary' || saved === 'transcript') return saved;
  return tkPrefs().defaultView === 'transcript' ? 'transcript' : 'summary';
};
const jumps = new Map(); // chat id -> message index to scroll to once the transcript shows
const liveChat = (ctx, id) => ctx.select.byId(id);
const chatTitle = item => oneLine(item?.title) || 'Untitled chat';

/** Opens a chat: the Chats workspace in the full tab, the chat page in the side panel. */
export function openChat(ctx, id, { view } = {}) {
  const item = liveChat(ctx, id);
  if (!item) { ctx.toast('That chat is no longer in your library.', { tone: 'danger' }); return; }
  if (view) ctx.prefs.set('chatView', view);
  if (ctx.env.isSidepanel) { ctx.state.panel = { kind: 'item', id, tab: 'details' }; ctx.syncUrl?.(); ctx.render(); return; }
  chatsState(ctx).chatId = id;
  if (ctx.state.panel?.kind === 'item') ctx.state.panel = null;
  if (ctx.state.view !== 'chats') ctx.navigate('chats', { keep: true }); else { ctx.syncUrl?.(); ctx.render(); }
}

/** index.html?libraryView=chats&item=<id> (the full-tab address of a chat). */
export function chatTabUrl(id, base) {
  const url = new URL(base);
  url.searchParams.set('libraryView', 'chats');
  url.searchParams.set('item', id);
  return url.href;
}
async function openInFullTab(ctx, id) {
  const base = ctx.env.isExtension ? chrome.runtime.getURL('index.html') : new URL('index.html', location.href).href;
  const url = chatTabUrl(id, base);
  if (ctx.env.isExtension) await chrome.tabs.create({ url }); else window.open(url, '_blank', 'noopener');
}

/* ------------------------------------------------------------------ chat page */

const removedOf = item => (REMOVED[chatOf(item).removed] ? chatOf(item).removed : '');
const canTalkToTk = item => isPaired() && !['deleted', 'local_only'].includes(removedOf(item));

function renderToolbar(ctx, item, view, surface) {
  const id = item.id;
  const url = /^https:\/\//i.test(item.sourceUrl || '') ? item.sourceUrl : '';
  const side = surface === 'side';
  const panel = surface === 'panel';
  const tkReady = canTalkToTk(item) && !item.deletedAt;
  return html`<div class="ne-toolbar chat-toolbar" role="toolbar" aria-label="Chat views and actions">
    ${side ? iconButton({ icon: 'arrow-left', label: 'Back', action: 'app.close-panel', size: 'sm', tooltipPlacement: 'bottom start' }) : ''}
    ${segmented({ name: 'chat-view', value: view, action: 'chat.view', size: 'sm', ariaLabel: 'Show', className: 'chat-views',
      options: [{ value: 'summary', label: 'Summary', icon: 'file-text' }, { value: 'transcript', label: 'Transcript', icon: 'messages-square' }] })}
    <span class="notes-spacer"></span>
    <div class="ne-tools-end chat-tools">
      ${item.deletedAt ? '' : button({ label: 'Ask', icon: 'sparkles', variant: 'ghost', size: 'sm', action: 'detail.ask', data: { id }, className: 'chat-ask', attrs: { 'aria-label': 'Ask about this chat', 'data-tooltip': 'Ask about this chat', 'data-tooltip-pos': 'bottom' } })}
      ${url ? iconButton({ icon: 'external-link', label: 'Open the original conversation', action: 'app.open-url', data: { url }, size: 'sm', tooltipPlacement: 'bottom' }) : ''}
      ${tkReady && hasCapability('open') ? iconButton({ icon: 'app-window', label: 'Open in Threadkeeper', action: 'chat.open-tk', data: { id }, size: 'sm', tooltipPlacement: 'bottom' }) : ''}
      ${tkReady ? iconButton({ icon: 'refresh-cw', label: 'Refresh from Threadkeeper', action: 'chat.refresh', data: { id }, size: 'sm', tooltipPlacement: 'bottom' }) : ''}
      ${iconButton({ icon: 'ellipsis', label: 'Chat actions', action: 'chat.menu', data: { id }, size: 'sm', expanded: menuOpenFor(ctx, 'chat.menu'), tooltipPlacement: 'bottom end' })}
      ${side ? iconButton({ icon: 'maximize-2', label: 'Open in full tab', action: 'chat.open-full', data: { id }, size: 'sm', tooltipPlacement: 'bottom end' }) : ''}
      ${panel ? iconButton({ icon: 'maximize-2', label: 'Open as page', action: 'chat.open-page', data: { id }, size: 'sm', tooltipPlacement: 'bottom end' }) : ''}
      ${panel ? iconButton({ icon: 'x', label: 'Close', action: 'app.close-panel', size: 'sm', tooltipPlacement: 'bottom end' }) : ''}
    </div>
  </div>`;
}

function renderBanners(ctx, item, record) {
  const bars = [];
  if (item.deletedAt) {
    bars.push(html`<div class="ne-bar" data-tone="warning">${icon('trash-2', { size: 16 })}<span class="ne-bar-text">This chat is in Trash.</span>
      <span class="ne-bar-actions">${button({ label: 'Restore', icon: 'rotate-ccw', variant: 'secondary', size: 'sm', action: 'library.restore', data: { id: item.id } })}
        ${button({ label: 'Delete forever', variant: 'ghost', size: 'sm', action: 'library.delete-forever', data: { id: item.id }, className: 'lib-danger' })}</span></div>`);
  }
  const removed = removedOf(item);
  if (removed) bars.push(html`<div class="ne-bar">${icon(REMOVED[removed].icon, { size: 16 })}<span class="ne-bar-text">${REMOVED[removed].text}</span></div>`);
  const analysis = record?.thread?.analysis;
  const version = Number(chatOf(item).analysisVersion ?? record?.thread?.analysisVersion ?? analysis?.analysisVersion ?? 0);
  if (!removed && !item.deletedAt && analysis && version < 2 && hasCapability('analyze')) {
    bars.push(html`<div class="ne-bar chat-improve">${icon('sparkles', { size: 16 })}<span class="ne-bar-text"><strong>Older summary.</strong> Threadkeeper can write a fuller one with key points, decisions and next steps.</span>
      <span class="ne-bar-actions">${button({ label: 'Improve', icon: 'wand-sparkles', variant: 'secondary', size: 'sm', action: 'chat.improve', data: { id: item.id } })}</span></div>`);
  }
  return bars.length ? html`<div class="ne-banner chat-banner">${bars}</div>` : '';
}

function renderCrumbs(ctx, item) {
  const path = item.collectionId ? ctx.select.path(item.collectionId) : [];
  const trail = path.length ? path : [null];
  return html`<nav class="ne-crumbs" aria-label="Collection"><ol class="ne-crumbs-list">${trail.map((collection, index) => html`<li class="ne-crumb-item" data-key="crumb:${collection?.id || 'inbox'}">
    ${index ? icon('chevron-right', { size: 12, className: 'ne-crumb-sep' }) : ''}
    <button type="button" class="ne-crumb" data-action="app.navigate" data-view="${collection ? `collection:${collection.id}` : 'inbox'}">${icon(collection ? 'folder' : 'inbox', { size: 14, className: 'ne-crumb-icon' })}<span class="ne-crumb-title">${collection ? collection.name : 'Inbox'}</span></button></li>`)}</ol></nav>`;
}

function renderMeta(ctx, item, record) {
  const chat = chatOf(item);
  const thread = record?.thread || {};
  const analysis = thread.analysis || {};
  const category = CATEGORY_ICONS[chat.category] ? chat.category : 'chat';
  const provider = oneLine(chat.providerLabel || thread.providerLabel || item.siteName) || 'AI chat';
  const agent = oneLine(thread.agentLabel || chat.agentLabel);
  const project = oneLine(chat.project || thread.project);
  const kind = oneLine(thread.kindLabel || analysis.kindLabel || chat.kindLabel);
  const state = chat.workflowState || thread.workflowState;
  const count = Number(chat.messageCount || thread.messageCount || 0);
  const activity = chatActivity(item);
  const source = analysis.source || chat.analysis?.source || '';
  const analyzed = source === 'ai'
    ? html`<span class="ne-prop" title="${analysis.generatedAt ? `Summary written ${shortDate(analysis.generatedAt)}` : 'Summary written by an AI model'}">${icon('sparkles', { size: 14 })}<span>Analyzed by ${oneLine(analysis.modelLabel || analysis.model) || 'AI'}${analysis.generatedAt ? ` · ${relativeDate(analysis.generatedAt)}` : ''}</span></span>`
    : source === 'local' ? html`<span class="ne-prop">${icon('cpu', { size: 14 })}<span>On-device analysis</span></span>` : '';
  const collectionPicker = typeof pickers.renderCollectionPickerTrigger === 'function'
    ? pickers.renderCollectionPickerTrigger({ ctx, value: item.collectionId || '', action: 'chat.set-collection', id: `chat-${item.id}-collection`, size: 'sm', label: 'Collection', className: 'ne-prop ne-collection' })
    : html`<button type="button" class="ne-prop" data-action="detail.collection" data-id="${item.id}">${icon('folder', { size: 14 })}<span>${item.collectionId ? ctx.select.collection(item.collectionId)?.name || 'Collection' : 'Inbox'}</span></button>`;
  const tags = typeof pickers.renderTagInput === 'function'
    ? pickers.renderTagInput({ ctx, tags: item.tags || [], action: 'chat.set-tags', id: `chat-${item.id}-tags`, placeholder: item.tags?.length ? 'Add tag' : 'Add tags', label: 'Tags', className: 'ne-tags' })
    : '';
  return html`<div class="ne-props chat-props">
      <span class="ne-prop chat-provider" data-category="${category}">${icon(categoryIcon(category), { size: 14 })}<span>${provider}</span></span>
      ${agent ? html`<span class="ne-prop">${icon('bot', { size: 14 })}<span>${agent}</span></span>` : ''}
      ${project && !/^unfiled\b/i.test(project) ? html`<span class="ne-prop" title="Threadkeeper project">${icon('layers', { size: 14 })}<span>${project}</span></span>` : ''}
      ${kind ? html`<span class="ne-prop">${kind}</span>` : ''}
      ${workflowLabel(state) ? html`<span class="ne-prop">${badge({ label: workflowLabel(state), tone: STATE_TONES[state] || 'neutral' })}</span>` : ''}
      ${count ? html`<span class="ne-prop">${icon('messages-square', { size: 14 })}<span>${plural(count, 'message')}</span></span>` : ''}
      ${activity ? html`<span class="ne-prop" title="Last activity ${shortDate(activity)}">${icon('clock', { size: 14 })}<span>${relativeDate(activity)}</span></span>` : ''}
      ${analyzed}
    </div>
    <div class="ne-props">${collectionPicker}
      ${iconButton({ icon: 'star', label: item.favorite ? 'Remove from favorites' : 'Add to favorites', action: 'library.favorite', data: { id: item.id }, pressed: !!item.favorite, size: 'sm', className: 'ne-pin' })}</div>
    ${tags}`;
}

const summaryMemo = new Lru(20);
function summaryHtml(item, record) {
  const key = `${item.id}:${record?.storedAt || ''}:${chatOf(item).fingerprint || ''}:${item.excerpt || ''}:${chatOf(item).workflowState || ''}`;
  const hit = summaryMemo.get(key);
  if (hit !== undefined) return hit;
  const markdown = buildChatSummaryMarkdown(record, item);
  return summaryMemo.set(key, markdown ? renderMarkdown(markdown, { images: false }) : '');
}

function renderSummary(ctx, item, entry) {
  const record = entry.status === 'ready' ? entry.value : null;
  if (entry.status === 'loading') return html`<div class="chat-loading" aria-busy="true" aria-label="Loading the summary">${skeleton({ rows: 4, variant: 'text' })}</div>`;
  const body = summaryHtml(item, record);
  const missing = entry.status === 'error'
    ? html`<p class="chat-note" role="alert">${icon('circle-alert', { size: 14 })}<span>${entry.error}</span></p>`
    : !record && !removedOf(item) ? html`<p class="chat-note">${icon('info', { size: 14 })}<span>The full summary of this chat is not on this device.${canTalkToTk(item) ? '' : ' Connect Threadkeeper to bring it back.'}</span>
        ${canTalkToTk(item) ? button({ label: 'Refresh from Threadkeeper', icon: 'refresh-cw', variant: 'ghost', size: 'sm', action: 'chat.refresh', data: { id: item.id } }) : ''}</p>` : '';
  return html`${missing}
    ${body ? html`<div class="chat-summary markdown-body" data-action="chat.body" data-id="${item.id}">${raw(body)}</div>`
      : html`<p class="chat-note">${icon('sparkles', { size: 14 })}<span>Threadkeeper has not summarized this thread yet.</span></p>`}`;
}

function renderNotes(ctx, item) {
  if (item.deletedAt) return item.content ? html`<section class="chat-notes" aria-labelledby="chat-notes-${item.id}"><h2 class="ne-links-title" id="chat-notes-${item.id}">Your notes</h2>
    <div class="markdown-body">${raw(renderMarkdown(item.content))}</div></section>` : '';
  return html`<section class="chat-notes" aria-labelledby="chat-notes-${item.id}">
    <h2 class="ne-links-title" id="chat-notes-${item.id}">Your notes</h2>
    ${renderInlineEditor(ctx, { itemId: item.id, field: 'content', placeholder: 'Add your notes about this chat' })}
  </section>`;
}

function renderSubpages(ctx, item) {
  const children = ctx.select.children(item.id);
  return html`<section class="ne-subpages chat-subpages" aria-label="Subpages">
    ${children.length ? html`<h2 class="ne-links-title">Subpages<span class="ne-count-pill">${children.length}</span></h2>
      <ul class="ne-links-list">${children.map(child => html`<li data-key="sp:${child.id}"><button type="button" class="ne-link-row" data-action="chat.open-link" data-id="${child.id}">
        ${icon('file-text', { size: 14, className: 'ne-link-icon' })}<span class="ne-link-title">${displayTitle(child)}</span><span class="ne-link-meta">${relativeDate(child.updatedAt)}</span></button></li>`)}</ul>` : ''}
    ${item.deletedAt ? '' : html`<div class="ne-subpages-foot">${button({ label: 'New subpage', icon: 'plus', variant: 'ghost', size: 'sm', action: 'chat.new-subpage', data: { id: item.id } })}</div>`}
  </section>`;
}

function renderLinks(ctx, item) {
  const back = ctx.select.backlinks(item.id).filter(entry => !entry.deletedAt && ctx.select.parentOf(entry.id)?.id !== item.id);
  if (!back.length) return '';
  return html`<section class="ne-links" aria-label="Linked from"><h2 class="ne-links-title">Linked from<span class="ne-count-pill">${back.length}</span></h2>
    <ul class="ne-links-list">${back.slice(0, 20).map(entry => html`<li data-key="bl:${entry.id}"><button type="button" class="ne-link-row" data-action="chat.open-link" data-id="${entry.id}">
      ${icon(entry.type === 'note' ? 'sticky-note' : entry.type === 'chat' ? 'messages-square' : 'link', { size: 14, className: 'ne-link-icon' })}<span class="ne-link-title">${displayTitle(entry)}</span></button></li>`)}</ul></section>`;
}

function renderTranscript(ctx, item, entry) {
  const chat = chatOf(item);
  const paired = canTalkToTk(item);
  if (entry.status === 'loading') return html`<div class="chat-loading" aria-busy="true" aria-label="Loading the transcript">${skeleton({ rows: 5, variant: 'row' })}</div>`;
  if (entry.status === 'error') return html`<div class="chat-empty">${emptyState({ icon: 'circle-alert', title: 'The transcript could not be read', body: entry.error, compact: true, tone: 'danger' })}</div>`;
  const transcript = entry.value;
  if (!transcript || !Array.isArray(transcript.messages) || !transcript.messages.length) {
    const off = tkPrefs().transcripts === false;
    return html`<div class="chat-empty">${emptyState({ icon: 'messages-square', compact: true, title: 'This chat’s transcript is not on this device',
      body: removedOf(item) === 'local_only' ? 'The thread is private in Threadkeeper, so Still no longer keeps its messages.'
        : off ? 'Full transcripts are turned off in Settings › Integrations › AI chat threads.'
        : paired ? 'Refresh it from Threadkeeper to read the whole conversation here.' : 'Connect Threadkeeper to bring the conversation here.',
      actions: paired && !off ? button({ label: 'Refresh from Threadkeeper', icon: 'refresh-cw', variant: 'secondary', size: 'sm', action: 'chat.refresh', data: { id: item.id } }) : '' })}</div>`;
  }
  const key = `chat:${item.id}:${transcript.revision ?? chat.revision ?? 0}:${transcriptKey(item)}`;
  return html`<div class="chat-transcript-host" data-mount="chat.transcript" data-morph="skip" data-key="${key}" data-id="${item.id}" data-cache="${transcriptKey(item)}"
    data-paired="${paired ? 'true' : 'false'}"></div>`;
}

function renderFooter(ctx, item) {
  const chat = chatOf(item);
  const count = Number(chat.messageCount || 0);
  const parts = [
    count ? ['count', plural(count, 'message')] : null,
    chat.startedAt || item.createdAt ? ['started', `Started ${shortDate(chat.startedAt || item.createdAt)}`] : null,
    chat.syncedAt ? ['synced', `Synced ${relativeDate(chat.syncedAt).replace(/^Just now$/, 'just now')}`] : null,
  ].filter(Boolean);
  return html`<footer class="ne-foot chat-foot">${parts.map(([kind, part], i) => html`${i ? html`<span class="is-${kind}-sep" aria-hidden="true">·</span>` : ''}<span class="ne-count is-${kind}">${part}</span>`)}
    <span class="ne-foot-spacer"></span>
    ${chat.transcriptTruncated ? html`<span class="ne-status" title="Some messages of a long conversation are not stored on this device">${icon('scissors', { size: 12 })}Partial transcript</span>` : ''}</footer>`;
}

/**
 * The chat page. surface: 'page' (the Chats workspace), 'panel' (the full tab's right panel) or 'side' (side panel
 * screen with a back arrow).
 */
export function renderChatPage(ctx, item, { surface = 'page' } = {}) {
  if (!item) return '';
  const variant = surface === 'page' ? 'full' : 'side';
  const view = viewFor(ctx);
  const recordEntry = chatRecord(ctx, item);
  const record = recordEntry.status === 'ready' ? recordEntry.value : null;
  const body = view === 'transcript'
    ? html`<div class="chat-body is-transcript">${renderTranscript(ctx, item, chatTranscript(ctx, item))}</div>`
    : html`<div class="chat-body is-summary">${renderSummary(ctx, item, recordEntry)}</div>
      ${renderNotes(ctx, item)}${renderSubpages(ctx, item)}${renderLinks(ctx, item)}`;
  return html`<div class="${cx('chat-host', `is-${surface}`)}" data-key="chat-host:${item.id}">
    <div class="${cx('ne', `ne-${variant}`, 'chat-page', `is-${view}`)}" data-surface="${variant}" data-chat-id="${item.id}" data-key="chat-page:${item.id}">
      ${renderToolbar(ctx, item, view, surface)}
      ${renderBanners(ctx, item, record)}
      <div class="ne-scroll chat-scroll" data-chat-scroll>
        <div class="ne-doc">
          <div class="ne-head">
            ${renderCrumbs(ctx, item)}
            <h1 class="ne-title chat-title" id="chat-title-${item.id}">${chatTitle(item)}</h1>
            <div class="ne-meta">${renderMeta(ctx, item, record)}</div>
          </div>
          ${body}
        </div>
      </div>
      ${renderFooter(ctx, item)}
    </div>
  </div>`;
}

/** The detail-panel host for a chat (side panel screen or the full tab's right panel). */
export function renderChatDetail(ctx, item, { surface = 'full' } = {}) {
  return html`<div class="detail chat-detail" data-surface="${surface}" data-key="detail:${item.id}">${renderChatPage(ctx, item, { surface: surface === 'side' ? 'side' : 'panel' })}</div>`;
}

/* ------------------------------------------------------------------ transcript mount */

const htmlMemo = new Lru(1500);

registerMount('chat.transcript', (el, ctx) => {
  // The transcript is normally read before the mount appears; if the cache let it go meanwhile, build on a later render.
  let instance = null;
  const build = () => {
    if (instance) return instance.update();
    instance = createTranscript(el, ctx);
    if (!instance) {
      const item = liveChat(ctx, el.dataset.id);
      if (item && !transcripts.get(el.dataset.cache)) chatTranscript(ctx, item);
    }
  };
  build();
  return { update: build, destroy: () => instance?.destroy() };
});

function createTranscript(el, ctx) {
  const id = el.dataset.id;
  const item = liveChat(ctx, id);
  const entry = item && transcripts.get(el.dataset.cache);
  if (!item || entry?.status !== 'ready' || !entry.value) return null;
  const chat = chatOf(item);
  const messages = cleanMessages(entry.value.messages);
  const total = Math.max(Number(entry.value.totalMessages) || 0, Number(chat.messageCount) || 0, messages.length ? messages.at(-1).index + 1 : 0);
  const record = records.get(recordKey(item))?.value;
  const who = oneLine(record?.thread?.agentLabel) || oneLine(chat.providerLabel || item.siteName) || 'Assistant';
  const category = CATEGORY_ICONS[chat.category] ? chat.category : 'chat';
  const memoKey = `${id}:${entry.value.revision ?? 0}:${el.dataset.cache}`;
  const st = { start: Math.max(0, messages.length - TRANSCRIPT_PAGE), expanded: new Set(), query: '', hits: [], current: -1, destroyed: false, timer: 0, flash: 0 };

  el.innerHTML = `<div class="chat-find" role="search">
      <span class="chat-find-field">${icon('search', { size: 14, className: 'chat-find-icon' })}<input class="chat-find-input" type="search" placeholder="Find in chat" aria-label="Find in this chat" autocomplete="off" spellcheck="false"></span>
      <span class="chat-find-count" aria-live="polite"></span>
      <button type="button" class="icon-btn icon-btn-sm" data-tx="prev" aria-label="Previous match" data-tooltip="Previous (Shift Enter)" disabled>${icon('chevron-up', { size: 14 })}</button>
      <button type="button" class="icon-btn icon-btn-sm" data-tx="next" aria-label="Next match" data-tooltip="Next (Enter)" disabled>${icon('chevron-down', { size: 14 })}</button>
    </div>
    <div class="chat-transcript" role="log" aria-label="Conversation" aria-live="off"></div>`;
  const list = el.querySelector('.chat-transcript');
  const input = el.querySelector('.chat-find-input');
  const countEl = el.querySelector('.chat-find-count');
  const [prevBtn, nextBtn] = el.querySelectorAll('[data-tx="prev"], [data-tx="next"]');

  const messageHtml = m => {
    const expanded = st.expanded.has(m.index);
    const key = `${memoKey}:${m.index}:${expanded}`;
    let out = htmlMemo.get(key);
    if (out === undefined) out = htmlMemo.set(key, messageMarkup(m, { who, category, expanded }));
    return out;
  };
  const gapHtml = gap => {
    const count = gap.to - gap.from + 1;
    const label = count === 1 ? `Message m${gap.from + 1} isn’t on this device` : `Messages m${gap.from + 1}–m${gap.to + 1} aren’t on this device`;
    const take = Math.min(WINDOW_MAX, count);
    return `<div class="chat-gap" role="note">${icon('scissors', { size: 14 })}<span class="chat-gap-text">${esc(label)}</span>${el.dataset.paired === 'true'
      ? `<button type="button" class="btn btn-ghost btn-sm" data-tx="load" data-from="${gap.from}" data-count="${take}">${icon('download', { size: 14 })}<span class="btn-label">${count > take ? `Load m${gap.from + 1}–m${gap.from + take}` : 'Load from Threadkeeper'}</span></button>` : ''}</div>`;
  };
  function draw() {
    const rows = transcriptRows(messages, { start: st.start, totalMessages: total });
    const earlier = st.start > 0 ? `<div class="chat-earlier"><button type="button" class="btn btn-secondary btn-sm" data-tx="earlier">${icon('chevron-up', { size: 14 })}<span class="btn-label">Show earlier messages (${Math.min(TRANSCRIPT_PAGE, st.start).toLocaleString()} of ${st.start.toLocaleString()})</span></button></div>` : '';
    list.innerHTML = earlier + rows.map(row => (row.kind === 'gap' ? gapHtml(row) : messageHtml(row.message))).join('');
    if (st.query) highlight();
  }
  function highlight() {
    for (const mark of [...list.querySelectorAll('mark.chat-find-hit')]) {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent));
      parent?.normalize?.();
    }
    const needle = st.query.toLowerCase();
    if (!needle) return;
    let budget = 3000;
    for (const body of list.querySelectorAll('.chat-msg-body')) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
      for (const node of nodes) {
        const value = node.nodeValue;
        const lower = value.toLowerCase();
        if (lower.length !== value.length || !lower.includes(needle)) continue;
        let cursor = node;
        let offset = 0;
        for (let at = lower.indexOf(needle); at >= 0 && budget > 0; at = lower.indexOf(needle, at + needle.length)) {
          const hit = cursor.splitText(at - offset);
          cursor = hit.splitText(needle.length);
          offset = at + needle.length;
          const mark = document.createElement('mark');
          mark.className = 'chat-find-hit';
          hit.replaceWith(mark);
          mark.append(hit);
          budget--;
        }
      }
    }
  }
  function updateCount() {
    const n = st.hits.length;
    countEl.textContent = !st.query ? '' : n ? `${st.current + 1} of ${plural(n, 'message')}` : 'No matches';
    prevBtn.disabled = nextBtn.disabled = n === 0;
  }
  function reveal(position, { mark = false } = {}) {
    const message = messages[position];
    if (!message) return;
    const start = startFor(position, messages.length, st.start);
    let redraw = start !== st.start;
    st.start = start;
    if (st.query && message.content.length > LONG_MESSAGE && message.content.toLowerCase().indexOf(st.query.toLowerCase()) >= foldPoint(message.content) && !st.expanded.has(message.index)) {
      st.expanded.add(message.index);
      redraw = true;
    }
    if (redraw) draw();
    const node = list.querySelector(`#msg-${message.index}`);
    if (!node) return;
    if (message.role === 'tool') node.querySelector('details')?.setAttribute('open', '');
    for (const current of list.querySelectorAll('.chat-find-hit.is-current, .chat-msg.is-flash')) current.classList.remove('is-current', 'is-flash');
    const hit = mark ? node.querySelector('.chat-find-hit') : null;
    if (hit) hit.classList.add('is-current');
    else {
      node.classList.remove('is-flash');
      void node.offsetWidth;
      node.classList.add('is-flash');
      clearTimeout(st.flash);
      st.flash = setTimeout(() => node.classList.remove('is-flash'), 1700);
    }
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    (hit || node).scrollIntoView({ block: hit ? 'center' : 'start', behavior: reduce ? 'auto' : 'smooth' });
  }
  /** Scrolls to message `index` (0-based), drawing its page first; offers to load it when it is not stored. */
  function jumpTo(index) {
    const position = messages.findIndex(m => m.index === index);
    if (position >= 0) { reveal(position); return true; }
    const notice = index >= 0 && index < total
      ? `Message m${index + 1} isn’t on this device.${el.dataset.paired === 'true' ? ' Load it from the gap in the transcript.' : ''}` : `This chat has no message m${index + 1}.`;
    ctx.toast(notice);
    const loads = [...list.querySelectorAll('[data-tx="load"]')].filter(b => Number(b.dataset.from) <= index);
    loads.at(-1)?.closest('.chat-gap')?.scrollIntoView({ block: 'center' });
    return false;
  }
  function step(delta) {
    if (!st.hits.length) return;
    st.current = (st.current + delta + st.hits.length) % st.hits.length;
    updateCount();
    reveal(st.hits[st.current], { mark: true });
  }
  function setQuery(value) {
    st.query = String(value || '').trim();
    st.hits = findMessages(messages, st.query);
    // Start at the newest match: the transcript opens at its end.
    st.current = st.hits.length ? st.hits.length - 1 : -1;
    highlight();
    updateCount();
    if (st.hits.length) reveal(st.hits[st.current], { mark: true });
  }

  const onInput = () => { clearTimeout(st.timer); st.timer = setTimeout(() => setQuery(input.value), 160); };
  const onKey = event => {
    if (event.key === 'Enter' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      clearTimeout(st.timer);
      if (input.value.trim() !== st.query) { setQuery(input.value); return; }
      step(event.key === 'ArrowUp' || (event.key === 'Enter' && event.shiftKey) ? -1 : 1);
    } else if (event.key === 'Escape' && input.value) {
      event.preventDefault();
      event.stopPropagation();
      input.value = '';
      setQuery('');
    }
  };
  const onClick = async event => {
    const link = event.target.closest?.('a[href^="#"]');
    if (link && el.contains(link)) {
      event.preventDefault();
      const match = /^#msg-(\d{1,7})$/.exec(link.getAttribute('href') || '');
      if (match) jumpTo(Number(match[1]));
      return;
    }
    const control = event.target.closest?.('[data-tx]');
    if (!control || !el.contains(control)) return;
    const kind = control.dataset.tx;
    if (kind === 'earlier') {
      const anchor = list.querySelector('.chat-msg');
      st.start = Math.max(0, st.start - TRANSCRIPT_PAGE);
      draw();
      anchor && list.querySelector(`#${anchor.id}`)?.scrollIntoView({ block: 'start' });
    } else if (kind === 'more') {
      const index = Number(control.dataset.index);
      if (st.expanded.has(index)) st.expanded.delete(index); else st.expanded.add(index);
      draw();
      list.querySelector(`#msg-${index} [data-tx="more"]`)?.focus({ preventScroll: true });
    } else if (kind === 'copy') {
      const message = messages.find(m => m.index === Number(control.dataset.index));
      if (!message) return;
      try { await navigator.clipboard.writeText(message.content); ctx.toast('Message copied'); } catch { ctx.toast('Copying was blocked by the browser.', { tone: 'danger' }); }
    } else if (kind === 'prev' || kind === 'next') step(kind === 'prev' ? -1 : 1);
    else if (kind === 'load') {
      control.disabled = true;
      const from = Number(control.dataset.from), count = Number(control.dataset.count);
      await ctx.run(async () => {
        await deps.client.loadTranscriptWindow(id, from, count);
        jumps.set(id, from);
        invalidateChat(id);
        ctx.toast(`Loaded ${plural(count, 'message')} from Threadkeeper`, { tone: 'success' });
        ctx.render();
      });
      control.disabled = false;
    }
  };
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  el.addEventListener('click', onClick);
  draw();
  const takeJump = () => {
    if (!jumps.has(id)) return;
    const index = jumps.get(id);
    jumps.delete(id);
    requestAnimationFrame(() => { if (!st.destroyed) jumpTo(index); });
  };
  if (jumps.has(id)) takeJump();
  else requestAnimationFrame(() => { if (!st.destroyed) list.lastElementChild?.scrollIntoView({ block: 'end' }); });
  return {
    jumpTo, setQuery,
    update: takeJump,
    destroy() { st.destroyed = true; clearTimeout(st.timer); clearTimeout(st.flash); input.removeEventListener('input', onInput); input.removeEventListener('keydown', onKey); el.removeEventListener('click', onClick); },
  };
}

/* ------------------------------------------------------------------ Chats workspace (full tab) */

let listLimit = LIST_PAGE;
let deepTimer = 0;
const deepRun = { query: '', token: 0 };

function allChats(ctx) {
  return ctx.select.live().filter(item => item.type === 'chat');
}

function scheduleDeepSearch(ctx, query) {
  clearTimeout(deepTimer);
  const s = chatsState(ctx);
  const text = str(query).trim();
  if (!text) { s.deep = null; deepRun.query = ''; return; }
  if (deepRun.query === text) return;
  deepTimer = setTimeout(() => {
    const token = ++deepRun.token;
    deepRun.query = text;
    Promise.resolve().then(() => deps.searchChats(text, { limit: 200 })).then(result => {
      if (token !== deepRun.token) return;
      const rows = Array.isArray(result) ? result : Array.isArray(result?.results) ? result.results : [];
      s.deep = new Set(rows.map(row => (typeof row === 'string' ? row : row?.id)).filter(Boolean));
      ctx.render();
    }, () => { if (token === deepRun.token) s.deep = null; });
  }, 220);
}

const dot = color => html`<span class="note-dot" style="--dot:${colorVar(color)}" aria-hidden="true"></span>`;

function chatRow(ctx, item, selectedId) {
  const chat = chatOf(item);
  const category = CATEGORY_ICONS[chat.category] ? chat.category : 'chat';
  const selected = item.id === selectedId;
  const collection = item.collectionId ? ctx.select.collection(item.collectionId) : null;
  const activity = chatActivity(item);
  const count = Number(chat.messageCount || 0);
  const removed = removedOf(item);
  const meta = [
    html`<span class="notes-meta-item chat-row-provider" data-category="${category}">${icon(categoryIcon(category), { size: 12 })}<span class="notes-meta-text">${oneLine(chat.providerLabel || item.siteName) || 'AI chat'}</span></span>`,
    chat.project && !/^unfiled\b/i.test(chat.project) && chat.project.toLowerCase() !== str(collection?.name).toLowerCase()
      ? html`<span class="notes-meta-item">${icon('layers', { size: 12 })}<span class="notes-meta-text">${chat.project}</span></span>` : '',
    collection ? html`<span class="notes-meta-item">${dot(collection.color)}<span class="notes-meta-text">${collection.name}</span></span>` : '',
    count ? html`<span class="notes-meta-item" title="${plural(count, 'message')}">${icon('messages-square', { size: 12 })}${count.toLocaleString()}</span>` : '',
    item.content ? html`<span class="notes-meta-item" title="Has your notes">${icon('notebook-pen', { size: 12 })}<span class="sr-only">Has your notes</span></span>` : '',
    removed ? html`<span class="notes-meta-item chat-row-removed">${icon(REMOVED[removed].icon, { size: 12 })}<span class="notes-meta-text">${removed === 'local_only' ? 'Private' : removed === 'deleted' ? 'Deleted in Threadkeeper' : 'Not syncing'}</span></span>` : '',
  ].filter(part => String(part));
  return html`<li data-key="cr:${item.id}" class="notes-item"><button type="button" class="${cx('notes-row', 'chat-row', selected && 'is-selected')}" data-action="chats.open" data-id="${item.id}" aria-current="${selected ? 'true' : 'false'}">
    <span class="notes-row-top">${item.favorite ? icon('star', { size: 12, className: 'notes-row-pin' }) : ''}<span class="notes-row-title">${chatTitle(item)}</span><time class="notes-row-time" datetime="${activity}" title="${shortDate(activity)}">${relativeDate(activity)}</time></span>
    ${item.excerpt ? html`<span class="notes-row-preview">${item.excerpt}</span>` : ''}
    <span class="notes-row-meta">${meta}</span>
  </button></li>`;
}

function chip(action, value, label, n, selected, glyph) {
  return html`<button type="button" class="${cx('notes-chip', selected && 'is-selected')}" data-action="${action}" data-value="${value}" aria-pressed="${selected ? 'true' : 'false'}">
    ${glyph ? icon(glyph, { size: 12 }) : ''}<span class="notes-chip-label">${label}</span>${n != null ? html`<span class="notes-chip-count">${n.toLocaleString()}</span>` : ''}</button>`;
}

function renderChatsList(ctx, { all, rows, selectedId }) {
  const s = chatsState(ctx);
  const facets = chatFacets(all);
  const shown = rows.slice(0, listLimit);
  const collection = s.collectionId && s.collectionId !== '__none' ? ctx.select.collection(s.collectionId) : null;
  const filtered = s.category || s.provider || s.collectionId || s.query.trim();
  let body;
  if (!all.length) {
    body = emptyState({ icon: 'messages-square', compact: true, title: isPaired() ? 'No AI chats yet' : 'Bring in your AI chats',
      body: isPaired() ? 'Chats you sync or add from Threadkeeper show up here.' : 'Connect Threadkeeper in Settings to keep your ChatGPT, Claude, Gemini and coding-agent threads here.',
      actions: isPaired() ? button({ label: 'Add chats…', icon: 'plus', variant: 'primary', size: 'sm', action: 'chats.add' })
        : button({ label: 'Open settings', icon: 'settings', variant: 'secondary', size: 'sm', action: 'chats.settings' }) });
  } else if (!rows.length) {
    body = emptyState({ icon: s.query.trim() ? 'search' : 'filter-x', compact: true, title: s.query.trim() ? `No chats match “${s.query.trim()}”` : 'No chats match these filters',
      actions: button({ label: 'Clear filters', variant: 'secondary', size: 'sm', action: 'chats.clear' }) });
  } else {
    body = html`<ul class="notes-list chats-list" aria-label="Chats" data-keydown="chats.list-key">${shown.map(item => chatRow(ctx, item, selectedId))}</ul>
      ${rows.length > shown.length ? html`<div class="notes-more">${button({ label: `Show ${Math.min(LIST_PAGE, rows.length - shown.length)} more`, variant: 'ghost', size: 'sm', action: 'chats.more' })}</div>` : ''}`;
  }
  const categories = facets.categories.length > 1 ? facets.categories : [];
  const providers = facets.providers.length > 1 ? facets.providers.slice(0, 4) : [];
  if (s.provider && !providers.some(p => p.id === s.provider)) { const extra = facets.providers.find(p => p.id === s.provider); if (extra) providers.push(extra); }
  return html`<section class="notes-list-pane chats-list-pane" aria-labelledby="chats-heading" data-key="chats-list-pane">
    <header class="notes-pane-head">
      <h1 class="notes-heading" id="chats-heading">Chats</h1><span class="notes-heading-count">${all.length.toLocaleString()}</span>
      <span class="notes-spacer"></span>
      ${isPaired() && hasCapability('sync') ? iconButton({ icon: 'refresh-cw', label: 'Sync with Threadkeeper now', action: 'chats.sync', size: 'sm', tooltipPlacement: 'bottom end' }) : ''}
      ${button({ label: 'Add chats', icon: 'plus', variant: 'primary', size: 'sm', action: 'chats.add', attrs: { 'aria-label': 'Add AI chats from Threadkeeper', 'data-tooltip': 'Add AI chats from Threadkeeper' } })}
    </header>
    <div class="notes-pane-tools">
      ${searchField({ value: s.query, placeholder: 'Search chats', action: 'chats.query', keydown: 'chats.search-key', id: 'chats-search', label: 'Search chats', clearAction: 'chats.clear-query' })}
      ${all.length && (categories.length || providers.length || collection) ? html`<div class="notes-chips" role="group" aria-label="Filter chats">
        ${chip('chats.filter-category', '', 'All', all.length, !s.category && !s.provider && !s.collectionId)}
        ${categories.map(c => chip('chats.filter-category', c.id, c.label, c.count, s.category === c.id, categoryIcon(c.id)))}
        ${providers.map(p => chip('chats.filter-provider', p.id, p.label, p.count, s.provider === p.id))}
        ${collection ? chip('chats.filter-collection', '', collection.name, null, true, 'folder') : ''}
        ${chip('chats.collection-menu', s.collectionId, collection ? 'Change collection' : 'Collection', null, false, 'folder')}
      </div>` : ''}
      ${all.length ? html`<div class="notes-sortbar"><span class="notes-sortbar-count">${filtered ? `${rows.length.toLocaleString()} of ${all.length.toLocaleString()}` : plural(all.length, 'chat')} · newest activity first</span></div>` : ''}
    </div>
    <div class="notes-scroll">${body}</div>
  </section>`;
}

/** Full tab Chats view: the chat list beside the open chat. */
export function renderChatsWorkspace(ctx) {
  const s = chatsState(ctx);
  const panel = ctx.state.panel;
  if (panel?.kind === 'item' && ctx.select.byId(panel.id)?.type === 'chat') {
    // A chat opened from anywhere (a deep link, a search result) shows in the workspace, not in a second copy beside it.
    s.chatId = panel.id;
    ctx.state.panel = null;
    ctx.syncUrl?.();
    ctx.render?.();
  }
  const all = allChats(ctx);
  const rows = filterChats(all, { query: s.query, category: s.category, provider: s.provider, collectionId: s.collectionId, deep: s.deep });
  let selected = s.chatId ? ctx.select.byId(s.chatId) : null;
  if (selected && (selected.type !== 'chat' || selected.deletedAt)) selected = null;
  if (!selected && rows.length) { selected = rows[0]; s.chatId = selected.id; }
  return html`<div class="notes-ws chats-ws" data-key="chats-ws">
    ${renderChatsList(ctx, { all, rows, selectedId: selected?.id || '' })}
    <section class="notes-editor-pane chats-page-pane" aria-label="${selected ? chatTitle(selected) : 'Chat'}" data-key="chats-page-pane">
      ${selected ? renderChatPage(ctx, selected, { surface: 'page' }) : html`<div class="notes-editor-empty">${emptyState({ icon: 'messages-square',
        title: all.length ? 'Select a chat' : 'Your AI chats will show here', body: all.length ? 'Pick a chat from the list to read its summary or the whole conversation.' : 'Each chat has a summary page like a note, and the full transcript.' })}</div>`}
    </section>
  </div>`;
}

/* ------------------------------------------------------------------ actions */

const itemOf = (ctx, id) => ctx.select.byId(id);
const chatIdOf = el => el?.closest?.('[data-chat-id]')?.dataset.chatId || '';

async function patch(ctx, id, changes) {
  const item = itemOf(ctx, id);
  if (!item) return null;
  return ctx.store.updateItem(id, changes, { expectedUpdatedAt: item.updatedAt });
}

async function readRecord(ctx, item) {
  const entry = chatRecord(ctx, item);
  if (entry.status === 'ready') return entry.value;
  try { return await deps.getChatRecord(item.id); } catch { return null; }
}

function chatMenu(ctx, item, anchor) {
  const id = item.id;
  const resume = safeResumeCommand(records.get(recordKey(item))?.value?.thread);
  const url = /^https:\/\//i.test(item.sourceUrl || '') ? item.sourceUrl : '';
  if (item.deletedAt) {
    return ctx.openMenu(anchor, [
      { label: 'Restore', icon: 'rotate-ccw', run: () => ctx.run(() => restoreItems(ctx, [id])) },
      { separator: true },
      { label: 'Delete forever', icon: 'trash-2', danger: true, run: () => ctx.run(() => deleteForever(ctx, [id])) },
    ], { label: `Actions for ${chatTitle(item)}`, placement: 'bottom-end' });
  }
  ctx.openMenu(anchor, [
    { label: 'Move to collection…', icon: 'folder-input', run: () => moveItems(ctx, [id], anchor) },
    { label: 'Rename…', icon: 'pencil', run: () => ctx.run(() => renameChat(ctx, id)) },
    { label: 'Edit tags', icon: 'tag', run: () => ctx.nextFrame(() => document.querySelector(`[data-chat-id="${CSS.escape(id)}"] .ne-tags input:not([type="hidden"])`)?.focus()) },
    { label: item.favorite ? 'Remove from favorites' : 'Add to favorites', icon: 'star', run: () => ctx.run(() => setFavorite(ctx, [id], !item.favorite, { quiet: true })) },
    { separator: true },
    { label: 'Add a subpage note', icon: 'file-plus', run: () => ctx.run(() => addSubpage(ctx, id)) },
    { label: 'Copy summary as Markdown', icon: 'copy', run: () => ctx.run(() => copySummary(ctx, id)) },
    { label: 'Save summary as a note', icon: 'notebook-pen', run: () => ctx.run(() => saveSummaryNote(ctx, id)) },
    resume && { label: 'Copy resume command', icon: 'square-terminal', action: 'app.copy', data: { text: resume, done: 'Resume command copied' } },
    url && { label: 'Copy link to the original', icon: 'link', action: 'app.copy', data: { text: url, done: 'Link copied' } },
    { label: 'Ask AI about this chat', icon: 'sparkles', run: () => askAi(ctx, { scope: 'item', ids: [id] }) },
    { separator: true },
    { label: 'Move to Trash', icon: 'trash-2', danger: true, hint: 'Your notes go with it', run: () => ctx.run(() => trashItems(ctx, [id])) },
  ].filter(Boolean), { label: `Actions for ${chatTitle(item)}`, placement: 'bottom-end' });
}

async function renameChat(ctx, id) {
  const item = itemOf(ctx, id);
  if (!item) return;
  const value = await ctx.prompt({ title: 'Rename chat', label: 'Title', value: item.title || '', confirmLabel: 'Rename' });
  const title = oneLine(value);
  if (value == null || !title || title === item.title) return;
  await patch(ctx, id, { title: title.slice(0, 300) });
}

async function copySummary(ctx, id) {
  const item = itemOf(ctx, id);
  if (!item) return;
  const record = await readRecord(ctx, item);
  const markdown = `# ${chatTitle(item)}\n${buildChatSummaryMarkdown(record, item)}`;
  await navigator.clipboard.writeText(markdown);
  ctx.toast('Summary copied as Markdown');
}

async function saveSummaryNote(ctx, id) {
  const item = itemOf(ctx, id);
  if (!item) return;
  const record = await readRecord(ctx, item);
  const summary = buildChatSummaryMarkdown(record, item);
  if (!summary) throw new Error('This chat has no summary to save yet.');
  // The refs (#msg-N) only work on the chat page; in a note they read as plain labels.
  const content = summary.replace(/\[(m\d+)\]\(#msg-\d+\)/g, '$1');
  const note = rememberItem(await createNoteItem(ctx, { title: `Summary of ${chatTitle(item)}`.slice(0, 300), content, parentId: id }));
  ctx.toast('Saved the summary as a note', { tone: 'success' });
  openNote(ctx, note.id);
}

function setView(ctx, view, id) {
  if (view !== 'summary' && view !== 'transcript') return;
  ctx.prefs.set('chatView', view);
  ctx.render();
  if (id) ctx.nextFrame(() => document.querySelector(`[data-chat-id="${CSS.escape(id)}"] .chat-views [aria-checked="true"]`)?.focus({ preventScroll: true }));
}

let queryTimer = 0;
registerActions({
  'chat.view': ({ ctx, el, data }) => setView(ctx, data.value, chatIdOf(el)),
  'chat.body': ({ ctx, el, event }) => {
    const link = event?.target?.closest?.('a[href]');
    if (!link || !el.contains(link)) return;
    const href = link.getAttribute('href') || '';
    const match = /^#msg-(\d{1,7})$/.exec(href);
    if (match) {
      event.preventDefault();
      jumps.set(el.dataset.id, Number(match[1]));
      setView(ctx, 'transcript');
      return;
    }
    if (href.startsWith('#')) event.preventDefault();
  },
  'chat.menu': ({ ctx, el, data }) => { const item = itemOf(ctx, data.id); if (item) chatMenu(ctx, item, el); },
  'chat.set-collection': async ({ ctx, el, data }) => {
    const id = chatIdOf(el);
    const item = itemOf(ctx, id);
    const collectionId = data.value || '';
    if (!item || (item.collectionId || '') === collectionId) return;
    await patch(ctx, id, { collectionId });
    if (collectionId) ctx.prefs.touchCollection?.(collectionId);
  },
  'chat.set-tags': async ({ ctx, el, data }) => {
    const id = chatIdOf(el);
    const item = itemOf(ctx, id);
    const tags = Array.isArray(data.tags) ? data.tags : String(data.value || '').split(',').map(t => t.trim()).filter(Boolean);
    if (!item || tags.join('\u0000') === (item.tags || []).join('\u0000')) return;
    await patch(ctx, id, { tags });
  },
  'chat.open-link': ({ ctx, data }) => {
    const target = itemOf(ctx, data.id);
    if (!target || target.deletedAt) throw new Error('That page is no longer in your library.');
    if (target.type === 'note') openNote(ctx, target.id);
    else if (target.type === 'chat') openChat(ctx, target.id);
    else ctx.openItem(target.id);
  },
  'chat.new-subpage': ({ ctx, data }) => addSubpage(ctx, data.id),
  'chat.open-full': ({ ctx, data }) => openInFullTab(ctx, data.id),
  'chat.open-page': ({ ctx, data }) => openChat(ctx, data.id),
  'chat.open-tk': async ({ ctx, data }) => {
    const item = itemOf(ctx, data.id);
    if (!item) return;
    await deps.client.threadkeeperRequest('thread.open', { threadKey: chatOf(item).threadKey });
  },
  'chat.refresh': async ({ ctx, el, data }) => {
    const item = itemOf(ctx, data.id);
    if (!item) return;
    if (el) el.disabled = true;
    try {
      await deps.client.refreshChat(item.id);
      invalidateChat(item.id);
      ctx.toast('Refreshed from Threadkeeper', { tone: 'success' });
      ctx.render();
    } finally { if (el) el.disabled = false; }
  },
  'chat.improve': async ({ ctx, data }) => {
    const item = itemOf(ctx, data.id);
    if (!item) return;
    const result = await deps.client.threadkeeperRequest('threads.analyze', { threadKeys: [chatOf(item).threadKey] });
    const skipped = Array.isArray(result?.skipped) ? result.skipped[0] : null;
    if (result?.queued) ctx.toast('Threadkeeper is writing a new summary. This chat updates when it is ready.', { tone: 'success' });
    else ctx.toast(skipped?.reason === 'no_ai' ? 'Threadkeeper has no AI model set up for summaries.'
      : skipped?.reason === 'fresh' ? 'This summary is already current.' : skipped?.reason === 'limit' ? 'Threadkeeper is at its analysis limit. Try again later.'
      : 'Threadkeeper could not improve this summary.');
  },
  'chats.open': ({ ctx, data }) => {
    chatsState(ctx).chatId = data.id;
    ctx.syncUrl?.();
    ctx.render();
  },
  'chats.query': ({ ctx, el }) => {
    clearTimeout(queryTimer);
    const value = el.value;
    queryTimer = setTimeout(() => {
      chatsState(ctx).query = value;
      listLimit = LIST_PAGE;
      scheduleDeepSearch(ctx, value);
      ctx.render();
    }, 120);
  },
  'chats.search-key': ({ ctx, el, event }) => {
    if (event.key === 'Escape' && el.value) { event.preventDefault(); el.value = ''; chatsState(ctx).query = ''; scheduleDeepSearch(ctx, ''); ctx.render(); }
    if (event.key === 'ArrowDown') { event.preventDefault(); document.querySelector('.chats-list .notes-row')?.focus(); }
  },
  'chats.clear-query': ({ ctx }) => { Object.assign(chatsState(ctx), { query: '', deep: null }); deepRun.query = ''; ctx.render(); ctx.nextFrame(() => document.getElementById('chats-search')?.focus()); },
  'chats.clear': ({ ctx }) => { Object.assign(chatsState(ctx), { query: '', category: '', provider: '', collectionId: '', deep: null }); deepRun.query = ''; ctx.render(); },
  'chats.filter-category': ({ ctx, data }) => {
    const s = chatsState(ctx);
    if (!data.value) Object.assign(s, { category: '', provider: '', collectionId: '' });
    else s.category = s.category === data.value ? '' : data.value;
    listLimit = LIST_PAGE;
    ctx.render();
  },
  'chats.filter-provider': ({ ctx, data }) => { const s = chatsState(ctx); s.provider = s.provider === data.value ? '' : data.value; listLimit = LIST_PAGE; ctx.render(); },
  'chats.filter-collection': ({ ctx }) => { chatsState(ctx).collectionId = ''; ctx.render(); },
  'chats.collection-menu': ({ ctx, el }) => {
    const s = chatsState(ctx);
    const used = new Map();
    for (const item of allChats(ctx)) used.set(item.collectionId || '', (used.get(item.collectionId || '') || 0) + 1);
    const rows = [...used].filter(([id]) => id).map(([id, n]) => ({ collection: ctx.select.collection(id), n })).filter(row => row.collection)
      .sort((a, b) => b.n - a.n || a.collection.name.localeCompare(b.collection.name));
    ctx.openMenu(el, [
      { label: 'Any collection', checked: !s.collectionId, run: () => { s.collectionId = ''; ctx.render(); } },
      used.get('') ? { label: 'Inbox', icon: 'inbox', hint: String(used.get('')), checked: s.collectionId === '__none', run: () => { s.collectionId = '__none'; ctx.render(); } } : null,
      rows.length ? { separator: true } : null,
      ...rows.map(({ collection, n }) => ({ label: ctx.select.path(collection.id).map(c => c.name).join(' / '), icon: 'folder', hint: String(n), checked: s.collectionId === collection.id,
        run: () => { s.collectionId = collection.id; ctx.render(); } })),
    ].filter(Boolean), { label: 'Show chats in', placement: 'bottom-start' });
  },
  'chats.more': ({ ctx }) => { listLimit += LIST_PAGE; ctx.render(); },
  'chats.add': ({ ctx }) => {
    const s = chatsState(ctx);
    openThreadkeeperPicker(ctx, s.collectionId && s.collectionId !== '__none' ? { collectionId: s.collectionId } : {});
  },
  'chats.sync': async ({ ctx }) => {
    const result = await deps.client.syncThreadkeeperNow();
    ctx.toast(result?.queued ? `Threadkeeper is sending ${plural(result.queued, 'thread')}` : 'Asked Threadkeeper for updates');
  },
  'chats.settings': ({ ctx }) => ctx.dispatch('shell.settings', { data: { section: 'integrations' } }),
  'chats.list-key': ({ event }) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = [...document.querySelectorAll('.chats-list .notes-row')];
    const index = rows.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? rows[0] : event.key === 'End' ? rows.at(-1) : rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    next?.focus();
    next?.click();
  },
});

/** Reads the Threadkeeper state once and follows its changes (the sidebar's Chats row and the chat pages depend on it). */
export function init(ctx) {
  tkListeners.add(() => ctx.render());
  readThreadkeeperState();
  try { deps.client.onThreadkeeperChange?.(() => readThreadkeeperState()); } catch (error) { console.warn('[still] Threadkeeper changes not followed', error?.message); }
}
