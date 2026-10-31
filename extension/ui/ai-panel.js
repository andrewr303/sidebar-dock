// Assistant panel (SPEC §7.3) on the lib/ai facade: conversation header with history, a transcript painted by the
// 'ai.transcript' mount (streamed tokens repaint only that mount, never the app), proposal cards that gate every library
// change, context chips, the model picker, the composer, and a no-provider setup with keyless hand-off.
import { html, raw, cx, plural } from './html.js';
import { icon } from './icons.js';
import { button, iconButton, collectionIcon, favicon, domainOf, relativeDate, emptyState, spinner, badge, avatarTile, TYPE_ICONS } from './components.js';
import { registerActions, registerMount, registerShortcuts, hasAction } from './runtime.js';
import { registerPopover } from './overlay.js';
import { morph } from './morph.js';
import { renderMarkdown } from '../lib/markdown.js';
import { openSettings } from './settings.js';
import { createNote } from './notes.js';
import { openAddForPage } from './quick-add.js';

export const MAX_QUESTION = 32000;
const COUNT_FROM = 28000;
const EXPANDED_WIDTH = 640;
const STICK_PX = 48;
const TOOL_ROWS = 3;
const WRITE_TOOLS = new Set(['create_collection', 'move_items', 'add_tags', 'remove_tags', 'set_favorite', 'archive_items', 'trash_items', 'create_note', 'append_to_note', 'update_item']);
const ITEM_CHANGES = new Set(['move_items', 'add_tags', 'remove_tags', 'set_favorite', 'archive_items', 'trash_items', 'update_item']);
const CHANGE_ICONS = { create_collection: 'folder-plus', move_items: 'folder-input', add_tags: 'hash', remove_tags: 'hash', set_favorite: 'star', archive_items: 'archive',
  trash_items: 'trash-2', create_note: 'sticky-note', append_to_note: 'notebook-pen', update_item: 'pencil' };
const EFFORT_HINTS = { none: 'No extra reasoning', minimal: 'Fastest', low: 'Quick answers', medium: 'Balanced', high: 'More thorough', xhigh: 'Deep reasoning', max: 'Most thorough' };
const HANDOFFS = [{ id: 'claude', label: 'Claude' }, { id: 'chatgpt', label: 'ChatGPT' }, { id: 'grok', label: 'Grok' }];
const SETUP_PATHS = [
  { providerId: 'anthropic', title: 'Add an Anthropic key', body: 'Claude Opus, Sonnet and Haiku', letter: 'A', color: 'orange' },
  { providerId: 'openai', title: 'Add an OpenAI key', body: 'GPT models, plus embeddings for search', letter: 'O', color: 'green' },
  { providerId: 'ollama', title: 'Use Ollama on this computer', body: 'Free and private, runs locally', icon: 'cpu', color: 'gray' },
];
const SETTINGS_ERRORS = new Set(['auth', 'no_connection', 'no_model', 'not_found', 'disabled', 'workspace_required', 'origin_blocked']);
const CITATION = /\[\[([\w:.-]+)\]\]/g;

const isWebUrl = url => /^https?:\/\/[^/\s]/i.test(String(url || ''));
const unique = list => [...new Set((list || []).filter(id => typeof id === 'string' && id))];
const text = value => typeof value === 'string' ? value : '';
const lowerFirst = value => value ? value[0].toLowerCase() + value.slice(1) : value;

// ------------------------------------------------------------------------------------------------ pure helpers

/**
 * The context the next question is asked with, as removable chips plus the runAssistant scope. One primary context wins,
 * in this order: items (named by askAi, added with "+", or the full-tab selection), the side panel's page, a collection
 * (named by askAi or the open full-tab view), then the whole library, which is the fallback and cannot be removed.
 */
export function resolveContext({ explicit = null, added = [], selectionIds = [], page = null, viewCollectionId = null, dismissed = new Set() } = {}) {
  const chips = [];
  const auto = !explicit;
  const explicitItems = explicit && ['item', 'items'].includes(explicit.scope) ? unique(explicit.ids) : [];
  if (explicitItems.length) chips.push({ key: 'explicit', kind: 'items', ids: explicitItems, removable: true });
  for (const id of unique(added)) if (!explicitItems.includes(id)) chips.push({ key: `added:${id}`, kind: 'items', ids: [id], removable: true });
  const selection = unique(selectionIds);
  if (auto && selection.length && !dismissed.has(`selection:${selection.join(',')}`)) {
    chips.push({ key: `selection:${selection.join(',')}`, kind: 'items', ids: selection, selection: true, removable: true });
  }
  if (chips.length) {
    const ids = unique(chips.flatMap(chip => chip.ids));
    return { kind: 'items', chips, scope: { scope: ids.length === 1 ? 'item' : 'items', ids } };
  }
  if (page && isWebUrl(page.url) && (explicit?.scope === 'page' || (auto && !dismissed.has(`page:${page.url}`)))) {
    return { kind: 'page', chips: [{ key: explicit ? 'explicit' : `page:${page.url}`, kind: 'page', page, removable: true }],
      scope: { scope: 'page', page: { url: page.url, title: text(page.title) } } };
  }
  const collectionId = explicit?.scope === 'collection' ? text(explicit.collectionId)
    : auto && typeof viewCollectionId === 'string' && !dismissed.has(`collection:${viewCollectionId}`) ? viewCollectionId : null;
  if (collectionId !== null) {
    return { kind: 'collection', chips: [{ key: explicit ? 'explicit' : `collection:${collectionId}`, kind: 'collection', collectionId, removable: true }],
      scope: { scope: 'collection', collectionId } };
  }
  return { kind: 'library', chips: [{ key: 'library', kind: 'library', removable: false }], scope: { scope: 'library' } };
}

/** Starting points for an empty conversation, adapted to the primary context. Prompts with "…" are templates to finish. */
export function suggestionsFor(kind, { collectionName = 'this collection', count = 0 } = {}) {
  if (kind === 'page') return [
    { icon: 'file-text', label: 'Summarize this page', prompt: 'Summarize this page in a few short paragraphs.' },
    { icon: 'list', label: 'Key points', prompt: 'List the key points of this page.' },
    { icon: 'search', label: 'Find related in my library', prompt: 'Find items in my library related to this page and say how each one connects.' },
    { icon: 'bookmark-plus', label: 'Save this with tags', run: 'save-page' },
  ];
  if (kind === 'collection') return [
    { icon: 'book-open', label: `Digest of ${collectionName}`, prompt: `Write a short digest of ${collectionName}: the main themes, standout items and anything that looks outdated.` },
    { icon: 'hash', label: 'Suggest tags', prompt: `Suggest tags for the items in ${collectionName} that need them.` },
    { icon: 'copy', label: 'Find duplicates', prompt: `Find duplicate or near-duplicate items in ${collectionName}.` },
  ];
  if (kind === 'items') {
    const one = count === 1;
    return [
      { icon: 'file-text', label: one ? 'Summarize this item' : `Summarize these ${count} items`, prompt: one ? 'Summarize this item.' : 'Summarize these items and what they have in common.' },
      { icon: 'layers', label: one ? 'Find related items' : 'Find what connects them', prompt: one ? 'Find items in my library related to this one.' : 'What connects these items? Point out overlaps and differences.' },
      { icon: 'hash', label: 'Suggest tags', prompt: one ? 'Suggest tags for this item.' : 'Suggest tags for these items.' },
    ];
  }
  return [
    { icon: 'search', label: 'What did I save about …', prompt: 'What did I save about …' },
    { icon: 'folder-input', label: 'Find everything about … and move it to …', prompt: 'Find everything about … and move it to …' },
    { icon: 'inbox', label: 'Suggest tags for Inbox', prompt: 'Suggest tags for the items in my Inbox.' },
    { icon: 'tags', label: 'Tag untagged items', prompt: 'Find items without tags and propose tags for them.' },
  ];
}

/** Cited ids in order of first appearance, as the engine numbers them: [{ n, id, title, url }] for ids that resolve. */
export function streamingCitations(answer, resolve) {
  const seen = new Map();
  for (const [, id] of text(answer).matchAll(CITATION)) {
    if (seen.has(id)) continue;
    const source = resolve(id);
    if (source) seen.set(id, { n: seen.size + 1, id, title: text(source.title) || id, url: text(source.url) });
  }
  return [...seen.values()];
}

/** Turns markdown.js source chips into compact numbered chips (title in a tooltip) that open their source. */
export function numberCitations(markup, citations = []) {
  const numbers = new Map(citations.map((source, index) => [String(source.id), source.n || index + 1]));
  return String(markup).replace(/<button([^>]*)class="ai-citation"([^>]*)>[\s\S]*?<\/button>/g, (match, before, after) => {
    const attributes = `${before} ${after}`;
    const id = attributes.match(/data-id="([^"]*)"/)?.[1];
    if (!id || !numbers.has(id)) return match;
    const title = attributes.match(/title="([^"]*)"/)?.[1] || 'Source';
    const n = numbers.get(id);
    return `<span class="ai-cite" data-tooltip="${title}"><button type="button" class="ai-citation is-numbered" data-action="ai.cite" data-id="${id}" aria-label="Source ${n}: ${title}">${n}</button></span>`;
  });
}

const cleanTitle = value => text(value).replace(/[[\]|]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Answer text for use outside the panel. links 'markdown': [[id]] becomes [Title](url) (or the title); links 'wiki': saved
 * items become [[Title]] note links and the attached page a Markdown link. Citations that cannot be resolved are dropped.
 */
export function exportAnswer(answer, citations = [], { links = 'markdown', isItem = () => true } = {}) {
  const byId = new Map(citations.map(source => [String(source.id), source]));
  return text(answer).replace(CITATION, (match, id) => {
    const source = byId.get(id);
    if (!source) return '';
    const title = cleanTitle(source.title) || cleanTitle(source.url) || 'Source';
    if (links === 'wiki' && id !== 'page:current' && isItem(id)) return `[[${title}]]`;
    return isWebUrl(source.url) ? `[${title}](${source.url})` : title;
  }).replace(/[ \t]+([.,;:!?])/g, '$1');
}

/** Error kind for the inline error row: the engine's error.code when present, else recognized from its message. */
export function classifyError({ code = '', message = '', aborted = false } = {}) {
  if (aborted || code === 'aborted' || message === 'Stopped') return 'aborted';
  if (code) return code;
  const value = text(message);
  if (/^Allow Still to reach/i.test(value)) return 'permission';
  if (/OLLAMA_ORIGINS/.test(value)) return 'origin_blocked';
  if (/Connect an AI provider|connection no longer exists/i.test(value)) return 'no_connection';
  if (/Check the API key|API key in AI settings|not signed in|Sign in with ChatGPT/i.test(value)) return 'auth';
  if (/workspace/i.test(value)) return 'workspace_required';
  if (/could not find the model|Pick (a|another) model/i.test(value)) return 'not_found';
  if (/is turned off/i.test(value)) return 'disabled';
  if (/^Rate limited/i.test(value)) return 'rate_limit';
  if (/having trouble right now|did not respond in time|took too long/i.test(value)) return 'provider_down';
  if (/declined to answer/i.test(value)) return 'refusal';
  if (/^Could not reach/i.test(value)) return 'network';
  return 'other';
}

const PAST = [[/^Create /, 'Created '], [/^Move /, 'Moved '], [/^Add /, 'Added '], [/^Remove /, 'Removed '], [/^Archive /, 'Archived '],
  [/^Append /, 'Appended '], [/^Rename /, 'Renamed '], [/^Update /, 'Updated ']];
const pastTense = label => PAST.reduce((value, [from, to]) => value.replace(from, to), text(label));
const changeCount = change => Number.isFinite(change?.count) ? change.count : (change?.itemIds || []).length;

/** One line per change that was applied, in the past tense, with counts that leave out excluded items. */
export function appliedLines(proposal, excluded = new Map()) {
  const lines = [];
  (proposal?.changes || []).forEach((change, index) => {
    const out = excluded.get(index)?.size || 0;
    let label = pastTense(change.label);
    if (out && ITEM_CHANGES.has(change.op)) {
      const total = changeCount(change);
      const left = total - out;
      if (left <= 0) return;
      label = label.replace(new RegExp(`\\b${total} items?\\b`), plural(left, 'item'));
    }
    lines.push(label);
  });
  return lines;
}

const FIELDS = { move_items: ['collectionId'], add_tags: ['tags'], remove_tags: ['tags'], set_favorite: ['favorite'], archive_items: ['archived'], trash_items: ['deletedAt'] };
const touchedFields = change => change.op === 'update_item' ? ['title', 'excerpt'].filter(key => key in change) : FIELDS[change.op] || [];
function applyChange(state, change) {
  if (change.op === 'move_items') state.collectionId = text(change.collectionId);
  else if (change.op === 'add_tags') for (const tag of change.tags || []) { if (!state.tags.some(t => String(t).toLowerCase() === String(tag).toLowerCase())) state.tags.push(tag); }
  else if (change.op === 'remove_tags') { const drop = (change.tags || []).map(tag => String(tag).toLowerCase()); state.tags = state.tags.filter(tag => !drop.includes(String(tag).toLowerCase())); }
  else if (change.op === 'set_favorite') state.favorite = !!change.favorite;
  else if (change.op === 'archive_items') state.archived = true;
  else if (change.op === 'update_item') { if ('title' in change) state.title = change.title; if ('excerpt' in change) state.excerpt = change.excerpt; }
}

/**
 * Patches that put items excluded during Review back after the whole proposal was applied: each excluded item gets the
 * fields its excluded changes touched, recomputed from its state before Apply plus the changes it stayed in.
 * excluded: Map<changeIndex, Set<itemId>>; before: Map<itemId, item> captured when Apply was clicked.
 */
export function exclusionPatches(proposal, excluded, before) {
  const ids = unique([...excluded.values()].flatMap(set => [...set]));
  const patches = [];
  for (const id of ids) {
    const item = before.get(id);
    if (!item) continue;
    const state = { collectionId: text(item.collectionId), tags: [...(item.tags || [])], favorite: !!item.favorite, archived: !!item.archived,
      deletedAt: item.deletedAt ?? null, title: text(item.title), excerpt: text(item.excerpt) };
    const fields = new Set();
    (proposal?.changes || []).forEach((change, index) => {
      if (!ITEM_CHANGES.has(change.op) || !(change.itemIds || []).includes(id)) return;
      if (excluded.get(index)?.has(id)) touchedFields(change).forEach(field => fields.add(field));
      else applyChange(state, change);
    });
    if (fields.size) patches.push({ id, patch: Object.fromEntries([...fields].map(field => [field, state[field]])) });
  }
  return patches;
}

/** History list sections by last activity: Today, Yesterday, Previous 7 days, Previous 30 days, Older. */
export function historyGroups(list, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86400000;
  const bounds = [['Today', start], ['Yesterday', start - day], ['Previous 7 days', start - 7 * day], ['Previous 30 days', start - 30 * day], ['Older', -Infinity]];
  const groups = bounds.map(([label]) => ({ label, items: [] }));
  for (const entry of list || []) {
    const at = Date.parse(entry.updatedAt) || 0;
    groups[bounds.findIndex(([, from]) => at >= from)].items.push(entry);
  }
  return groups.filter(group => group.items.length);
}

export const shortModelLabel = label => text(label).replace(/^Claude\s+/i, '').trim() || 'Model';

export function formatDuration(ms) {
  const seconds = Math.max(1, Math.round((Number(ms) || 0) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// ------------------------------------------------------------------------------------------------ state

// Live per-proposal UI state (resolver, Review exclusions, receipt, undo); proposal ids are unique across conversations.
const proposalUi = new Map();
let transcript = null;
let runSeq = 0;

function st(ctx) {
  const s = ctx.state.ai ||= {};
  if (!s.init) {
    Object.assign(s, { init: true, conversation: null, draft: '', editing: null, run: null, explicit: null, added: [], dismissed: new Set(),
      target: undefined, connections: [], settings: null, history: null, historyQuery: '', ctxQuery: '', ctxActive: 0, ctxOptions: [],
      modelView: 'models', open: new Set(), pagePermission: null, suggestions: [], version: 0, announce: '' });
  }
  return s;
}

function bump(ctx, { render = false } = {}) {
  st(ctx).version++;
  if (render) ctx.render();
  else if (transcript && !transcript.frame) transcript.frame = requestAnimationFrame(() => { if (!transcript) return; transcript.frame = 0; paint(transcript); });
}

const announce = (ctx, message) => { st(ctx).announce = message; };
const popoverOpen = (ctx, name) => ctx.state.popover?.name === name;
const threadMessages = s => [...(s.conversation?.messages || []), ...(s.run ? [s.run.user, s.run.message] : [])];
const findMessage = (s, id) => threadMessages(s).find(message => message.id === id) || null;
const liveItem = (ctx, id) => { const item = ctx.select?.byId?.(id); return item && !item.deletedAt ? item : null; };
const aiVisible = ctx => ctx.env.isSidepanel ? ctx.state.panel?.kind === 'ai' || (!ctx.state.panel && ctx.state.sideTab === 'ask') : ctx.state.panel?.kind === 'ai';
const composer = () => document.getElementById('ai-input');

function contextFor(ctx) {
  const s = st(ctx);
  const side = !!ctx.env.isSidepanel;
  const view = String(ctx.state.view || '');
  let viewCollectionId = null;
  if (!side && view === 'inbox') viewCollectionId = '';
  else if (!side && view.startsWith('collection:') && ctx.select?.collection?.(view.slice(11))) viewCollectionId = view.slice(11);
  const exists = id => !!liveItem(ctx, id);
  return resolveContext({ explicit: s.explicit, added: s.added.filter(exists), selectionIds: side ? [] : [...(ctx.state.selection || [])].filter(exists),
    page: side && isWebUrl(ctx.state.page?.url) ? ctx.state.page : null, viewCollectionId, dismissed: s.dismissed });
}

const collectionName = (ctx, id) => id ? ctx.select?.collection?.(id)?.name || 'this collection' : 'Inbox';

function chipView(ctx, chip) {
  if (chip.kind === 'page') return { label: 'This page', title: chip.page.title || chip.page.url, glyph: icon('app-window', { size: 12 }) };
  if (chip.kind === 'collection') {
    const collection = chip.collectionId ? ctx.select?.collection?.(chip.collectionId) : null;
    return { label: collectionName(ctx, chip.collectionId), glyph: collectionIcon(collection, { size: 14 }) };
  }
  if (chip.kind === 'items') {
    if (chip.ids.length === 1) {
      const item = liveItem(ctx, chip.ids[0]);
      return { label: item?.title || domainOf(item?.url) || 'Item', title: item?.title || '', glyph: icon(TYPE_ICONS[item?.type] || 'file-text', { size: 12 }) };
    }
    return { label: chip.selection ? `${chip.ids.length} selected` : plural(chip.ids.length, 'item'), glyph: icon('layers', { size: 12 }) };
  }
  return { label: 'Library', title: 'Your whole library', glyph: icon('book-open-text', { size: 12 }) };
}

function placeholderFor(ctx, resolved) {
  if (st(ctx).target === null) return 'Write a question to open in another app';
  if (resolved.kind === 'page') return 'Ask about this page';
  if (resolved.kind === 'collection') return `Ask about ${collectionName(ctx, resolved.scope.collectionId)}`;
  if (resolved.kind === 'items') return resolved.scope.ids.length === 1 ? 'Ask about this item' : 'Ask about these items';
  return 'Ask about your library';
}

// ------------------------------------------------------------------------------------------------ connections

const usable = connection => connection && connection.enabled !== false && (connection.via !== 'direct' || !connection.needsKey || connection.hasKey)
  && !(connection.via !== 'direct' && connection.status === 'error') && (connection.models || []).length > 0;

async function refreshTarget(ctx) {
  const s = st(ctx);
  if (!ctx.ai) return;
  const [settings, connections] = await Promise.all([
    Promise.resolve().then(() => ctx.ai.getAiSettings?.()).catch(() => null),
    Promise.resolve().then(() => ctx.ai.listConnections?.()).catch(() => []),
  ]);
  s.settings = settings || null;
  s.connections = Array.isArray(connections) ? connections : [];
  try {
    const target = await ctx.ai.resolveChatTarget({});
    const connection = s.connections.find(entry => entry.id === target.connectionId) || null;
    const model = (connection?.models || []).find(entry => entry.id === target.model) || null;
    const efforts = model?.efforts?.length ? model.efforts : [];
    s.target = { ...target, efforts, effort: efforts.includes(target.effort) ? target.effort : model?.defaultEffort || efforts[0] || target.effort,
      baseUrl: connection?.baseUrl || '', local: !!connection?.local, connection };
  } catch (error) {
    s.target = null;
    s.targetError = error?.message || '';
  }
  ctx.render();
}

// Chrome asks for host access only inside a user gesture, so this runs synchronously from the click or key handler.
function requestModelAccess(ctx) {
  const target = st(ctx).target;
  if (!target || target.via !== 'direct' || typeof ctx.ai?.ensureHostPermission !== 'function') return Promise.resolve(true);
  try { return Promise.resolve(ctx.ai.ensureHostPermission({ providerId: target.providerId, baseUrl: target.baseUrl })).catch(() => false); }
  catch { return Promise.resolve(false); }
}

// ------------------------------------------------------------------------------------------------ sending

async function pageContext(ctx, scope) {
  const page = scope.page || {};
  if ('text' in page) return { context: scope };
  const s = st(ctx);
  const current = ctx.state.page;
  if (s.settings?.includePageText === false || !current || current.url !== page.url) return { context: { ...scope, page: { ...page, text: '' } } };
  if (current.demo || !ctx.env.isExtension) {
    const saved = ctx.select?.savedForUrl?.(page.url);
    return { context: { ...scope, page: { ...page, text: text(saved?.articleContent || saved?.content || saved?.excerpt) } } };
  }
  const result = await ctx.chrome('getPageContext', { tabId: current.tabId, windowId: current.windowId });
  if (result?.needsPermission) return { needsPermission: result.needsPermission };
  return { context: { ...scope, page: { url: text(result?.url) || page.url, title: text(result?.title) || page.title, text: text(result?.text) } } };
}

/**
 * Sends a question. Call it synchronously from the user's click or key press: it asks Chrome for access to the model's
 * host before anything is awaited. replace: id of a user message to answer again (it and everything after it go).
 */
function submit(ctx, { question, scope, replace } = {}) {
  const s = st(ctx);
  if (!ctx.ai || s.run) return null;
  const value = String(question ?? s.draft).trim();
  if (!value) return null;
  if (value.length > MAX_QUESTION) { ctx.toast(`Shorten the question to ${MAX_QUESTION.toLocaleString()} characters or less.`, { tone: 'danger' }); return null; }
  if (s.target === null) { ctx.toast('Connect a model in Settings to ask here, or open the question in another app.'); return null; }
  const access = requestModelAccess(ctx);
  const replaceFrom = replace ?? s.editing?.messageId ?? null;
  const fromDraft = question === undefined;
  if (fromDraft) { s.draft = ''; const input = composer(); if (input) input.value = ''; }
  s.editing = null;
  s.pagePermission = null;
  return startRun(ctx, { question: value, scope: scope || contextFor(ctx).scope, replaceFrom, access, fromDraft });
}

async function startRun(ctx, { question, scope, replaceFrom, access, fromDraft }) {
  const s = st(ctx);
  const id = `run-${++runSeq}`;
  const run = { id, controller: new AbortController(), question, scope, lastEvent: '', thinkingStartedAt: 0, thinkingMs: 0, notes: [], startedAt: Date.now(),
    user: { id: `${id}-q`, role: 'user', text: question, context: { scope: scope.scope, ids: scope.ids || [], collectionId: scope.collectionId || '', ...(scope.page ? { page: { url: scope.page.url, title: scope.page.title } } : {}) }, live: true },
    message: { id: `${id}-a`, role: 'assistant', text: '', thinking: '', tools: [], proposals: [], citations: [], error: '', status: '', live: true } };
  if (replaceFrom && s.conversation) {
    const index = s.conversation.messages.findIndex(message => message.id === replaceFrom);
    if (index >= 0) s.conversation = { ...s.conversation, messages: s.conversation.messages.slice(0, index) };
  }
  s.run = run;
  if (transcript) transcript.stick = true;
  announce(ctx, 'Asking the assistant');
  bump(ctx, { render: true });
  try {
    await access;
    const prepared = scope.scope === 'page' ? await pageContext(ctx, scope) : { context: scope };
    if (s.run !== run) return;
    if (prepared.needsPermission) {
      s.run = null;
      s.pagePermission = { origin: prepared.needsPermission, question, scope, replaceFrom };
      if (fromDraft) s.draft = question;
      announce(ctx, 'Still needs access to this page.');
      return;
    }
    if (replaceFrom && s.conversation?.id) s.conversation = await ctx.ai.saveConversation(s.conversation);
    const t = s.target || {};
    const result = await ctx.ai.runAssistant({
      conversationId: s.conversation?.id, input: question, context: prepared.context, signal: run.controller.signal,
      connectionId: t.connectionId, model: t.model, effort: t.efforts?.length ? t.effort : undefined,
      onEvent: event => onEvent(ctx, run, event), onProposal: proposal => onProposal(ctx, run, proposal),
    });
    for (const proposal of result?.message?.proposals || []) { const ui = proposalUi.get(proposal.id); if (ui) ui.resolve = null; }
    if (s.run !== run) return;
    s.conversation = await finalize(ctx, result);
    announce(ctx, result.message?.error ? (result.message.error === 'Stopped' ? 'Stopped' : result.message.error) : 'Answer ready');
    refreshHistory(ctx, { quiet: true });
  } catch (error) {
    console.error(error);
    if (s.run === run) {
      if (fromDraft && !s.draft) s.draft = question;
      ctx.toast(error?.message || 'The assistant could not answer.', { tone: 'danger' });
    }
  } finally {
    if (s.run === run) s.run = null;
    bump(ctx, { render: true });
  }
}

// Keeps what only this view knows (where each card sat in the answer, Review exclusions, undo) on the saved message.
async function finalize(ctx, result) {
  const { conversation, message } = result || {};
  if (!conversation || !message) return conversation || null;
  let changed = false;
  const proposals = (message.proposals || []).map(proposal => {
    const ui = proposalUi.get(proposal.id);
    if (!ui) return proposal;
    const next = { ...proposal, ...(Number.isFinite(ui.at) ? { at: ui.at } : {}) };
    if (ui.undone) next.status = 'undone';
    if (ui.lines) next.appliedLines = ui.lines;
    if (JSON.stringify(next) !== JSON.stringify(proposal)) changed = true;
    return next;
  });
  if (!changed) return conversation;
  const next = { ...conversation, messages: conversation.messages.map(entry => entry.id === message.id ? { ...entry, proposals } : entry) };
  try { return await ctx.ai.saveConversation(next); } catch (error) { console.error(error); return next; }
}

function onEvent(ctx, run, event) {
  const m = run.message;
  let render = false;
  switch (event?.type) {
    case 'status': {
      const label = text(event.label);
      if (/[.!?]$/.test(label)) { if (!run.notes.includes(label)) run.notes.push(label); }
      else m.status = label;
      break;
    }
    case 'thinking':
      run.thinkingStartedAt ||= Date.now();
      m.thinking += text(event.delta ?? event.text);
      break;
    case 'text':
      if (run.thinkingStartedAt && !run.thinkingMs) run.thinkingMs = Date.now() - run.thinkingStartedAt;
      m.text += text(event.delta ?? event.text);
      break;
    case 'tool':
      m.tools.push({ id: event.id, name: event.name, summary: text(event.summary), result: event.result, isError: !!event.isError });
      break;
    case 'proposal':
      registerProposal(run, event.proposal);
      announce(ctx, 'Proposed changes are waiting for your review.');
      render = true;
      break;
    case 'proposal_result':
      proposalResult(ctx, run, event);
      render = true;
      break;
    case 'citations':
      m.citations = Array.isArray(event.items) ? event.items : [];
      break;
    case 'error':
      m.error = text(event.message) || 'The assistant could not answer.';
      m.errorCode = text(event.code) || (event.aborted ? 'aborted' : '');
      if (!m.text && event.partialText) m.text = text(event.partialText);
      render = true;
      break;
    default: return;
  }
  run.lastEvent = event.type;
  bump(ctx, { render });
}

function registerProposal(run, proposal) {
  if (!proposal?.id) return;
  const ui = proposalUi.get(proposal.id) || { open: false, excluded: new Map() };
  if (!Number.isFinite(ui.at)) ui.at = run.message.text.length;
  ui.status ||= 'pending';
  proposalUi.set(proposal.id, ui);
  if (!run.message.proposals.some(entry => entry.id === proposal.id)) run.message.proposals.push({ ...proposal, status: 'pending' });
}

function onProposal(ctx, run, proposal) {
  return new Promise(resolve => {
    registerProposal(run, proposal);
    const ui = proposalUi.get(proposal.id);
    if (!ui || ui.status !== 'pending') { resolve('discard'); return; }
    ui.resolve = resolve;
    bump(ctx, { render: true });
  });
}

function proposalResult(ctx, run, event) {
  const ui = proposalUi.get(event.proposalId) || { open: false, excluded: new Map() };
  proposalUi.set(event.proposalId, ui);
  ui.resolve = null;
  ui.status = event.status;
  ui.error = text(event.error);
  const record = run.message.proposals.find(entry => entry.id === event.proposalId);
  if (record) record.status = event.status;
  if (event.status === 'applied') {
    ui.undo = typeof event.undo === 'function' ? event.undo : null;
    if (ui.restore?.length) {
      // The engine applies whole proposals; items left out in Review are put back right after.
      Promise.resolve(ctx.store.bulkUpdateItems(ui.restore)).catch(error => {
        console.error(error);
        ctx.toast('Some items you left out were changed anyway. Use Undo to revert everything.', { tone: 'danger' });
      });
    }
    announce(ctx, 'Changes applied.');
  } else if (event.status === 'failed') announce(ctx, `Changes failed: ${ui.error || 'nothing was changed.'}`);
}

function stopRun(ctx) {
  const run = st(ctx).run;
  if (!run) return;
  run.controller.abort();
  announce(ctx, 'Stopped');
}

function newChat(ctx, { focus = true } = {}) {
  const s = st(ctx);
  if (s.run) { stopRun(ctx); s.run = null; }
  Object.assign(s, { conversation: null, editing: null, pagePermission: null, added: [] });
  ctx.closePopover?.({ restore: false });
  bump(ctx, { render: true });
  if (focus) ctx.nextFrame(() => composer()?.focus({ preventScroll: true }));
}

async function openConversation(ctx, id) {
  const s = st(ctx);
  ctx.closePopover?.({ restore: false });
  if (s.conversation?.id === id && !s.run) return;
  const conversation = await ctx.ai.getConversation(id);
  if (!conversation) { ctx.toast('That conversation is no longer on this device.'); refreshHistory(ctx); return; }
  if (s.run) { stopRun(ctx); s.run = null; }
  const scope = conversation.scope;
  let explicit = null;
  if (scope?.scope === 'page') explicit = scope.page?.url && scope.page.url === ctx.state.page?.url ? { scope: 'page' } : null;
  else if (scope && scope.scope !== 'library') explicit = { scope: scope.scope, ids: scope.ids || [], collectionId: scope.collectionId || '' };
  Object.assign(s, { conversation, editing: null, pagePermission: null, added: [], explicit });
  if (transcript) transcript.stick = true;
  bump(ctx, { render: true });
  ctx.nextFrame(() => composer()?.focus({ preventScroll: true }));
}

async function refreshHistory(ctx, { quiet = false } = {}) {
  const s = st(ctx);
  if (!ctx.ai?.listConversations) return;
  try { s.history = await ctx.ai.listConversations(); }
  catch (error) { console.error(error); s.history = s.history || []; if (!quiet) ctx.toast('Your chat history could not be read.', { tone: 'danger' }); }
  if (popoverOpen(ctx, 'ai.history') || !quiet) ctx.render();
}

function retry(ctx, assistantId) {
  const s = st(ctx);
  const messages = s.conversation?.messages || [];
  const index = messages.findIndex(message => message.id === assistantId);
  const question = index > 0 ? messages.slice(0, index).reverse().find(message => message.role === 'user') : null;
  if (!question) return null;
  const record = question.context || { scope: 'library' };
  const scope = record.scope === 'page'
    ? { scope: 'page', page: { url: text(record.page?.url), title: text(record.page?.title) } }
    : { scope: record.scope || 'library', ...(record.ids?.length ? { ids: record.ids } : {}), ...(record.scope === 'collection' ? { collectionId: text(record.collectionId) } : {}) };
  return submit(ctx, { question: question.text, scope, replace: question.id });
}

// ------------------------------------------------------------------------------------------------ public API

/**
 * Opens the assistant: full tab right panel, or the side panel's Ask tab. scope ('page' | 'item' | 'items' | 'collection' |
 * 'library') with ids / collectionId sets the context chips (a conversation about something else starts a new chat);
 * prompt fills the composer and send asks it at once. Call it from a click handler so a send can ask for host access.
 */
export function askAi(ctx, { prompt = '', scope, ids, collectionId, send = false } = {}) {
  const s = st(ctx);
  if (ctx.env.isSidepanel) { ctx.state.panel = null; ctx.state.sideTab = 'ask'; }
  else { ctx.state.panel = { kind: 'ai' }; ctx.syncUrl?.(); }
  if (scope) {
    const kind = scope === 'item' && unique(ids).length > 1 ? 'items' : scope;
    const explicit = { scope: kind, ids: unique(ids).slice(0, 200), collectionId: text(collectionId) };
    const current = s.conversation?.scope;
    const same = current && current.scope === kind && (current.collectionId || '') === explicit.collectionId && unique(current.ids).join() === explicit.ids.join();
    if (!s.run && s.conversation?.messages?.length && !same) newChat(ctx, { focus: false });
    s.explicit = explicit;
    s.added = [];
    if (kind === 'page' && ctx.state.page?.url) s.dismissed.delete(`page:${ctx.state.page.url}`);
  }
  if (prompt) s.draft = String(prompt);
  bump(ctx, { render: true });
  if (send && prompt && !s.run) {
    if (submit(ctx)) return;
  }
  ctx.nextFrame(() => {
    const input = composer();
    if (!input) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

export async function init(ctx) {
  const s = st(ctx);
  if (!ctx.ai) { ctx.render(); return; }
  try { ctx.ai.onConnectionsChanged?.(() => refreshTarget(ctx)); } catch (error) { console.error(error); }
  await refreshTarget(ctx);
  if (s.target === undefined) s.target = null;
}

// ------------------------------------------------------------------------------------------------ rendering: panel

export function renderAiPanel(ctx, { surface = ctx.env?.isSidepanel ? 'side' : 'full' } = {}) {
  const s = st(ctx);
  const ready = !!ctx.ai;
  const hasThread = !!(s.conversation?.messages?.length || s.run);
  const resolved = contextFor(ctx);
  return html`<section class="ai-panel" data-surface="${surface}" aria-label="Assistant">
    ${renderHead(ctx, surface, hasThread)}
    ${!ready ? html`<div class="ai-scroll ai-start" data-key="ai.unavailable">${emptyState({ icon: 'sparkles', title: 'The assistant is not available',
      body: 'Still could not load its AI engine. Reload Still to try again.', actions: button({ label: 'Reload', icon: 'refresh-cw', action: 'app.retry-boot', size: 'sm' }) })}</div>`
      : hasThread ? html`<div class="ai-scroll ai-thread" data-mount="ai.transcript" data-morph="skip" data-key="ai.transcript" role="region" aria-label="Conversation" tabindex="-1"></div>`
        : html`<div class="ai-scroll ai-start" data-key="ai.start">${s.target === null ? renderSetup(ctx, resolved) : renderEmpty(ctx, resolved)}</div>`}
    ${ready ? renderDock(ctx, resolved) : ''}
    <div class="sr-only" role="status" aria-live="polite" data-key="ai.announce">${s.announce}</div>
  </section>`;
}

function renderHead(ctx, surface, hasThread) {
  const s = st(ctx);
  const width = Number(ctx.prefs?.get?.('panelWidth', 400)) || 400;
  const expanded = width >= EXPANDED_WIDTH - 40;
  const title = s.conversation?.title || (s.run ? s.run.question : 'New chat');
  return html`<header class="ai-head">
    <button type="button" class="ai-title" data-action="ai.history" aria-haspopup="dialog" aria-expanded="${popoverOpen(ctx, 'ai.history') ? 'true' : 'false'}"
      ${ctx.ai ? '' : raw('disabled')}><span class="ai-title-text">${title}</span><span class="sr-only">, chat history</span>${icon('chevron-down', { size: 14 })}</button>
    <span class="spacer"></span>
    ${iconButton({ icon: 'square-pen', label: 'New chat', action: 'ai.new', disabled: !ctx.ai || (!hasThread && !s.draft) })}
    ${surface === 'full' ? html`${iconButton({ icon: expanded ? 'minimize-2' : 'maximize-2', label: expanded ? 'Narrow the panel' : 'Widen the panel', action: 'ai.expand', pressed: expanded, tooltipPlacement: 'bottom end' })}
      ${iconButton({ icon: 'x', label: 'Close', action: 'app.close-panel', tooltipPlacement: 'bottom end' })}` : ''}
  </header>`;
}

function renderEmpty(ctx, resolved) {
  const s = st(ctx);
  const count = resolved.scope.ids?.length || 0;
  s.suggestions = suggestionsFor(resolved.kind, { collectionName: collectionName(ctx, resolved.scope.collectionId), count });
  const body = resolved.kind === 'page' ? 'Answers use this page and what you saved, with sources you can open.'
    : resolved.kind === 'collection' ? `Answers use what is in ${collectionName(ctx, resolved.scope.collectionId)}, with sources you can open.`
      : resolved.kind === 'items' ? `Answers use ${count === 1 ? 'this item' : 'these items'}, with sources you can open.`
        : 'Answers cite the items they come from. Changes to your library always wait for your approval.';
  return html`<div class="ai-empty">
    <span class="ai-mark" aria-hidden="true">${icon('sparkles', { size: 18 })}</span>
    <h2 class="ai-empty-title">Ask about your library</h2>
    <p class="ai-empty-body">${body}</p>
    <ul class="ai-suggestions" role="list" aria-label="Suggestions">
      ${s.suggestions.map((suggestion, index) => html`<li><button type="button" class="ai-suggestion" data-action="ai.suggest" data-index="${index}">
        ${icon(suggestion.icon, { size: 16 })}<span>${suggestion.label}</span></button></li>`)}
    </ul>
  </div>`;
}

function renderSetup(ctx) {
  return html`<div class="ai-empty ai-setup">
    <span class="ai-mark" aria-hidden="true">${icon('sparkles', { size: 18 })}</span>
    <h2 class="ai-empty-title">Connect a model to ask here</h2>
    <p class="ai-empty-body">Use your own API key or a model on this computer. Keys stay on this device.</p>
    <ul class="ai-setup-paths" role="list">
      ${SETUP_PATHS.map(path => html`<li><button type="button" class="ai-setup-path" data-action="ai.setup" data-provider="${path.providerId}">
        ${avatarTile({ label: path.letter || '', icon: path.icon, color: path.color, size: 28 })}
        <span class="ai-setup-text"><span class="ai-setup-title">${path.title}</span><span class="ai-setup-body">${path.body}</span></span>
        ${icon('chevron-right', { size: 16, className: 'ai-setup-chevron' })}</button></li>`)}
    </ul>
    <div class="ai-handoff">
      <p class="ai-handoff-label">Or ask without a key</p>
      <div class="ai-handoff-actions">${HANDOFFS.map(target => button({ label: target.label, iconRight: 'external-link', size: 'sm', action: 'ai.handoff', data: { target: target.id } }))}</div>
    </div>
  </div>`;
}

function renderDock(ctx, resolved) {
  const s = st(ctx);
  const running = !!s.run;
  const length = s.draft.length;
  const over = length > MAX_QUESTION;
  const canSend = !running && !!s.draft.trim() && !over && s.target !== null;
  return html`<div class="ai-dock">
    ${s.pagePermission ? renderPageNotice(ctx) : ''}
    <form class="${cx('ai-composer', running && 'is-running')}" data-submit="ai.send" aria-label="Ask the assistant">
      <div class="ai-chips" role="list" aria-label="Context">${resolved.chips.map(chip => renderChip(ctx, chip))}</div>
      ${s.editing ? html`<div class="ai-editing">${icon('pencil', { size: 12 })}<span>Editing your last question</span>
        <button type="button" class="ai-editing-cancel" data-action="ai.edit-cancel">Cancel</button></div>` : ''}
      <textarea class="ai-input" id="ai-input" data-focus-key="ai-input" name="prompt" rows="1" aria-label="Message" aria-describedby="ai-footnote"
        placeholder="${placeholderFor(ctx, resolved)}" data-input="ai.draft" data-keydown="ai.key" spellcheck="true">${s.draft}</textarea>
      <div class="ai-composer-foot">
        ${iconButton({ icon: 'plus', label: 'Add context', action: 'ai.add-context', size: 'sm', expanded: popoverOpen(ctx, 'ai.context') })}
        ${renderModelButton(ctx)}
        <span class="spacer"></span>
        ${length >= COUNT_FROM ? html`<span class="${cx('ai-count', over && 'is-over')}">${length.toLocaleString()} / ${MAX_QUESTION.toLocaleString()}</span>` : ''}
        ${running
          ? html`<button type="button" class="ai-send is-stop" data-action="ai.stop" aria-label="Stop" data-tooltip="Stop (Esc)" aria-keyshortcuts="Escape">${icon('square', { size: 12 })}</button>`
          : html`<button type="submit" class="ai-send" aria-label="Send" data-tooltip="Send" aria-keyshortcuts="Enter" ${canSend ? '' : raw('disabled')}>${icon('arrow-up', { size: 16, strokeWidth: 2 })}</button>`}
      </div>
    </form>
    <p class="ai-footnote" id="ai-footnote">${icon('info', { size: 12 })}${footnote(ctx)}</p>
  </div>`;
}

function footnote(ctx) {
  const t = st(ctx).target;
  if (t === null) return 'Connect a model to ask here. Another app opens your question in a new tab.';
  if (!t) return 'Retrieved items are included as context.';
  const model = t.modelLabel || t.model;
  if (t.via === 'agent' || t.via === 'bridge') return `Sent to ${t.label || t.providerName} through the local bridge${model ? ` · ${model}` : ''}. Retrieved items are included as context.`;
  if (t.local) return `Runs on this computer with ${t.providerName}${model ? ` · ${model}` : ''}. Retrieved items are included as context.`;
  return `Sent to ${t.providerName}${model ? ` · ${model}` : ''}. Retrieved items are included as context.`;
}

function renderModelButton(ctx) {
  const t = st(ctx).target;
  const label = t === undefined ? 'Model' : t === null ? 'No model' : shortModelLabel(t.modelLabel || t.model);
  const effort = t?.efforts?.length && t.effort ? ` · ${ctx.ai?.EFFORT_LABELS?.[t.effort] || t.effort} effort` : '';
  const tip = t ? `${t.providerName} · ${t.modelLabel || t.model}${effort}` : 'Choose a model';
  return html`<button type="button" class="ai-model-btn" data-action="ai.model" aria-haspopup="menu" aria-expanded="${popoverOpen(ctx, 'ai.model') ? 'true' : 'false'}"
    data-tooltip="${tip}"><span class="ai-model-label">${label}</span>${icon('chevron-down', { size: 12 })}</button>`;
}

function renderChip(ctx, chip) {
  const view = chipView(ctx, chip);
  return html`<span class="${cx('ai-chip', `is-${chip.kind}`)}" role="listitem" ${view.title ? html`title="${view.title}"` : ''}>
    ${view.glyph}<span class="ai-chip-label">${view.label}</span>
    ${chip.removable ? html`<button type="button" class="ai-chip-x" aria-label="Remove ${view.label} from context" data-action="ai.chip-remove" data-chip="${chip.key}">${icon('x', { size: 12 })}</button>` : ''}
  </span>`;
}

function renderPageNotice(ctx) {
  const notice = st(ctx).pagePermission;
  const where = notice.origin === 'tabs' ? 'your tabs' : domainOf(ctx.state.page?.url) || 'this site';
  return html`<div class="ai-notice" role="alert">
    ${icon('shield-check', { size: 16 })}
    <div class="ai-notice-text"><p>Allow Still to read ${where} to answer about this page.</p>
      <div class="ai-notice-actions">${button({ label: 'Allow and ask', variant: 'primary', size: 'sm', action: 'ai.page-allow' })}
        ${button({ label: 'Ask without the page', variant: 'ghost', size: 'sm', action: 'ai.page-skip' })}</div></div>
    ${iconButton({ icon: 'x', label: 'Dismiss', size: 'sm', action: 'ai.page-dismiss' })}
  </div>`;
}

// ------------------------------------------------------------------------------------------------ rendering: transcript

registerMount('ai.transcript', (el, ctx) => {
  const view = { el, ctx, painted: -1, stick: true, frame: 0 };
  const onScroll = () => { view.stick = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX; };
  el.addEventListener('scroll', onScroll, { passive: true });
  transcript = view;
  paint(view);
  return {
    update(next) { view.ctx = next; if (st(next).version !== view.painted) paint(view); },
    destroy() {
      el.removeEventListener('scroll', onScroll);
      if (view.frame) cancelAnimationFrame(view.frame);
      if (transcript === view) transcript = null;
    },
  };
});

function paint(view) {
  const { el, ctx } = view;
  const s = st(ctx);
  view.painted = s.version;
  const stick = view.stick;
  const messages = threadMessages(s);
  const lastUser = messages.findLast(message => message.role === 'user');
  const lastAnswer = messages.findLast(message => message.role === 'assistant');
  morph(el, html`${messages.map(message => message.role === 'user'
    ? renderQuestion(ctx, message, { last: message === lastUser })
    : renderAnswer(ctx, view, message, { last: message === lastAnswer }))}`);
  if (stick) el.scrollTop = el.scrollHeight;
}

// Finished Markdown is painted once: later paints send an empty placeholder with the same key and morph keeps the node.
function skipBlock(view, key, className, render) {
  const exists = view.el.querySelector(`[data-key="${CSS.escape(key)}"]`);
  return html`<div class="${className}" data-key="${key}" data-morph="skip">${exists ? '' : render()}</div>`;
}

function scopeLabel(ctx, record) {
  if (!record || record.scope === 'library') return null;
  if (record.scope === 'page') return { glyph: icon('app-window', { size: 12 }), label: record.page?.title || domainOf(record.page?.url) || 'This page' };
  if (record.scope === 'collection') return { glyph: icon('folder', { size: 12 }), label: collectionName(ctx, record.collectionId) };
  const ids = record.ids || [];
  if (ids.length === 1) return { glyph: icon('file-text', { size: 12 }), label: liveItem(ctx, ids[0])?.title || 'One item' };
  return { glyph: icon('layers', { size: 12 }), label: plural(ids.length, 'item') };
}

function renderQuestion(ctx, message, { last }) {
  const s = st(ctx);
  const about = scopeLabel(ctx, message.context);
  return html`<div class="ai-q" data-key="q:${message.id}">
    ${about ? html`<p class="ai-q-about">${about.glyph}<span>${about.label}</span></p>` : ''}
    <div class="ai-bubble">${message.text}</div>
    ${message.live ? '' : html`<div class="ai-q-actions">
      ${iconButton({ icon: 'copy', label: 'Copy', size: 'sm', action: 'ai.copy', data: { id: message.id } })}
      ${last && !s.run ? iconButton({ icon: 'pencil', label: 'Edit', size: 'sm', action: 'ai.edit', data: { id: message.id } }) : ''}
    </div>`}
  </div>`;
}

function citationsFor(ctx, message) {
  if (message.citations?.length) return message.citations;
  const page = st(ctx).run?.scope?.page;
  return streamingCitations(message.text, id => id === 'page:current' ? page || null : liveItem(ctx, id));
}

function renderMd(ctx, value, citations) {
  return raw(numberCitations(renderMarkdown(value, { citations }), citations));
}

function renderAnswer(ctx, view, message, { last }) {
  const s = st(ctx);
  const live = !!message.live;
  const run = live ? s.run : null;
  const body = live ? text(message.text).replace(/\[\[[\w:.-]*\]?$/, '') : text(message.text);
  const citations = citationsFor(ctx, message);
  const signature = citations.map(source => source.id).join(',');
  const cards = (message.proposals || []).map(proposal => ({ proposal, at: Math.min(body.length, proposalUi.get(proposal.id)?.at ?? proposal.at ?? body.length) }))
    .sort((a, b) => a.at - b.at);
  const blocks = [];
  let cursor = 0;
  const typing = live && run?.lastEvent === 'text';
  const pushText = (part, from, tail = false) => {
    if (!part.trim()) return;
    const key = live ? `md:${message.id}:${from}:${part.length}${tail ? ':tail' : ''}` : `md:${message.id}:${from}:${signature}`;
    blocks.push(skipBlock(view, key, cx('ai-md markdown-body is-compact', tail && 'is-typing'), () => renderMd(ctx, part, citations)));
  };
  for (const { proposal, at } of cards) {
    pushText(body.slice(cursor, at), cursor);
    blocks.push(renderProposal(ctx, proposal));
    cursor = Math.max(cursor, at);
  }
  pushText(body.slice(cursor), cursor, typing);
  const busy = live && !message.error;
  const showStatus = busy && (!body || run?.lastEvent !== 'text');
  return html`<article class="${cx('ai-a', live && 'is-live')}" data-key="a:${message.id}" aria-busy="${busy ? 'true' : 'false'}">
    ${renderThought(ctx, message, run)}
    ${renderTools(ctx, message)}
    ${blocks}
    ${(run?.notes || []).map(note => html`<p class="ai-note">${icon('info', { size: 14 })}<span>${note}</span></p>`)}
    ${showStatus ? html`<p class="ai-status"><span class="ai-shimmer">${statusLabel(message, run)}</span></p>` : ''}
    ${renderError(ctx, message, { last })}
    ${renderActions(ctx, message, { last, citations })}
  </article>`;
}

function statusLabel(message, run) {
  const label = text(message.status);
  if (!label || label === 'Thinking') return message.thinking && !message.text ? 'Thinking…' : run?.lastEvent === 'tool' ? 'Working…' : 'Thinking…';
  return `${label}…`;
}

function renderThought(ctx, message, run) {
  const thinking = text(message.thinking);
  const ms = run ? run.thinkingMs || (run.thinkingStartedAt ? Date.now() - run.thinkingStartedAt : 0) : message.thinkingMs;
  if (!thinking && !ms) return '';
  const key = `thought:${message.id}`;
  const open = st(ctx).open.has(key) && !!thinking;
  const thinkingNow = !!run && !message.text && !message.error;
  const label = thinkingNow ? 'Thinking…' : `Thought for ${formatDuration(ms)}`;
  return html`<div class="ai-thought" data-key="th:${message.id}">
    <button type="button" class="${cx('ai-thought-toggle', thinkingNow && 'is-busy')}" data-action="ai.toggle" data-open="${key}"
      aria-expanded="${open ? 'true' : 'false'}" ${thinking ? '' : raw('disabled')}>
      ${icon('brain', { size: 14 })}<span class="${cx(thinkingNow && 'ai-shimmer')}">${label}</span>${thinking ? icon('chevron-right', { size: 14, className: 'ai-chevron' }) : ''}</button>
    ${open ? html`<div class="ai-thought-body">${thinking}</div>` : ''}
  </div>`;
}

function toolLabel(tool) {
  const query = text(tool.result?.query || tool.query);
  const count = tool.result?.count;
  if (tool.name === 'search_library' && query) return `Searched library for “${query}”${Number.isFinite(count) ? ` · ${plural(count, 'result')}` : ''}`;
  return tool.summary || tool.name.replace(/_/g, ' ');
}

function renderTools(ctx, message) {
  const s = st(ctx);
  const tools = (message.tools || []).filter(tool => !WRITE_TOOLS.has(tool.name));
  if (!tools.length) return '';
  const all = s.open.has(`tools:${message.id}`);
  const shown = all ? tools : tools.slice(0, TOOL_ROWS);
  return html`<div class="ai-tools" data-key="tools:${message.id}">
    ${shown.map((tool, index) => {
      const ids = (tool.result?.ids || []).filter(id => liveItem(ctx, id));
      const key = `tool:${message.id}:${index}`;
      const open = ids.length > 0 && s.open.has(key);
      const glyph = tool.isError ? icon('circle-alert', { size: 14, className: 'ai-tool-error' }) : icon('circle-check', { size: 14, className: 'ai-tool-ok' });
      return html`<div class="ai-tool" data-key="${key}">
        ${ids.length ? html`<button type="button" class="ai-tool-row" data-action="ai.toggle" data-open="${key}" aria-expanded="${open ? 'true' : 'false'}">${glyph}<span>${toolLabel(tool)}</span>${icon('chevron-right', { size: 12, className: 'ai-chevron' })}</button>`
          : html`<p class="ai-tool-row">${glyph}<span>${toolLabel(tool)}</span></p>`}
        ${open ? html`<ul class="ai-tool-items" role="list">${ids.slice(0, 20).map(id => sourceRow(ctx, liveItem(ctx, id)))}</ul>` : ''}
      </div>`;
    })}
    ${tools.length > TOOL_ROWS ? html`<button type="button" class="ai-tool-more" data-action="ai.toggle" data-open="tools:${message.id}" aria-expanded="${all ? 'true' : 'false'}">
      ${all ? 'Show fewer steps' : `${plural(tools.length - TOOL_ROWS, 'more step')}`}</button>` : ''}
  </div>`;
}

function sourceRow(ctx, item, n) {
  if (!item) return '';
  return html`<li><button type="button" class="ai-source" data-action="ai.cite" data-id="${item.id}">
    ${n ? html`<span class="ai-source-n">${n}</span>` : ''}${isWebUrl(item.url) ? favicon(item.url, { size: 16 }) : html`<span class="ai-source-icon">${icon(TYPE_ICONS[item.type] || 'file-text', { size: 14 })}</span>`}
    <span class="ai-source-title">${item.title || item.url || 'Untitled'}</span>${domainOf(item.url) ? html`<span class="ai-source-meta">${domainOf(item.url)}</span>` : ''}</button></li>`;
}

function renderError(ctx, message, { last }) {
  if (!message.error) return '';
  const kind = classifyError({ code: message.errorCode, message: message.error });
  const canRetry = !message.live && last;
  const retryButton = canRetry ? button({ label: 'Retry', icon: 'refresh-cw', size: 'sm', action: 'ai.retry', data: { id: message.id } }) : '';
  if (kind === 'aborted') return html`<p class="ai-stopped">${icon('circle-stop', { size: 14 })}<span>Stopped</span>${retryButton}</p>`;
  const connectionId = message.connectionId || st(ctx).target?.connectionId || '';
  const fix = kind === 'permission' && canRetry
    ? button({ label: 'Allow access', icon: 'shield-check', variant: 'primary', size: 'sm', action: 'ai.allow-host', data: { id: message.id, connection: connectionId } })
    : SETTINGS_ERRORS.has(kind) ? button({ label: 'Open AI settings', icon: 'settings', size: 'sm', action: 'ai.settings' }) : '';
  return html`<div class="ai-error" role="alert">
    ${icon('circle-alert', { size: 16 })}
    <div class="ai-error-text"><p>${message.error}</p>
      ${fix || retryButton ? html`<div class="ai-error-actions">${fix}${retryButton}${SETTINGS_ERRORS.has(kind) ? '' : html`<button type="button" class="ai-link" data-action="ai.settings">AI settings</button>`}</div>` : ''}</div>
  </div>`;
}

function openNote(ctx) {
  const note = liveItem(ctx, ctx.state.notes?.noteId);
  return note?.type === 'note' ? note : null;
}

function renderActions(ctx, message, { last, citations }) {
  if (message.live || !message.text) return '';
  const s = st(ctx);
  const note = openNote(ctx);
  const sourcesKey = `sources:${message.id}`;
  const showSources = s.open.has(sourcesKey);
  const sources = citations.filter(source => source.id === 'page:current' || liveItem(ctx, source.id));
  return html`<div class="${cx('ai-actions', last && 'is-last')}" role="toolbar" aria-label="Answer actions">
    ${iconButton({ icon: 'copy', label: 'Copy', size: 'sm', action: 'ai.copy', data: { id: message.id } })}
    ${iconButton({ icon: 'notebook-pen', label: 'Save as note', size: 'sm', action: 'ai.save-note', data: { id: message.id } })}
    ${note ? iconButton({ icon: 'file-plus', label: `Insert into “${note.title || 'Untitled note'}”`, size: 'sm', action: 'ai.insert-note', data: { id: message.id } }) : ''}
    ${last && !s.run ? iconButton({ icon: 'refresh-cw', label: 'Retry', size: 'sm', action: 'ai.retry', data: { id: message.id } }) : ''}
    ${iconButton({ icon: 'external-link', label: 'Open in another app', size: 'sm', action: 'ai.handoff-menu', data: { id: message.id } })}
    <span class="spacer"></span>
    ${sources.length ? html`<button type="button" class="ai-sources-toggle" data-action="ai.toggle" data-open="${sourcesKey}" aria-expanded="${showSources ? 'true' : 'false'}">
      ${icon('link', { size: 12 })}<span>${plural(sources.length, 'source')}</span></button>` : ''}
  </div>
  ${showSources ? html`<ol class="ai-sources" role="list" data-key="src:${message.id}">${sources.map(source => source.id === 'page:current'
    ? html`<li><button type="button" class="ai-source" data-action="ai.cite" data-id="page:current" data-url="${source.url}"><span class="ai-source-n">${source.n}</span>${favicon(source.url, { size: 16 })}
      <span class="ai-source-title">${source.title || 'This page'}</span><span class="ai-source-meta">${domainOf(source.url)}</span></button></li>`
    : sourceRow(ctx, liveItem(ctx, source.id), source.n))}</ol>` : ''}`;
}

// ------------------------------------------------------------------------------------------------ rendering: proposals

function proposalStatus(proposal) {
  const ui = proposalUi.get(proposal.id);
  if (ui?.undone) return 'undone';
  return ui?.status || proposal.status || 'pending';
}

function collectionPill(ctx, change, created) {
  if (!change.collectionId) return html`<span class="ai-pill">${collectionIcon(null, { size: 16 })}<span>Inbox</span></span>`;
  const path = ctx.select?.path?.(change.collectionId) || [];
  if (path.length) {
    return html`${path.map((collection, index) => html`${index ? icon('chevron-right', { size: 12, className: 'ai-pill-sep' }) : ''}<span class="ai-pill">${collectionIcon(collection, { size: 16 })}<span>${collection.name}</span></span>`)}`;
  }
  return html`<span class="ai-pill">${collectionIcon({ icon: 'folder-plus', color: 'gray' }, { size: 16 })}<span>${change.collectionName || 'New collection'}</span>${created ? html`<span class="ai-pill-new">New</span>` : ''}</span>`;
}

function tagList(tags) {
  return html`${(tags || []).map(tag => html`<span class="ai-tag"><span class="ai-tag-hash">#</span>${tag}</span>`)}`;
}

function changeSub(ctx, change, out = new Set()) {
  if (change.op === 'move_items') {
    const counts = new Map();
    for (const id of (change.itemIds || []).filter(entry => !out.has(entry))) {
      const item = liveItem(ctx, id);
      if (!item) continue;
      const name = collectionName(ctx, item.collectionId || '');
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    return counts.size ? `From ${[...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} (${n})`).join(', ')}` : '';
  }
  if (ITEM_CHANGES.has(change.op) && change.op !== 'update_item') {
    const titles = (change.items || []).filter(item => !out.has(item.id)).slice(0, 3).map(item => item.title).filter(Boolean);
    const rest = changeCount(change) - out.size - titles.length;
    return titles.length ? `${titles.join(', ')}${rest > 0 ? ` and ${plural(rest, 'more')}` : ''}` : '';
  }
  if (change.op === 'create_note' && change.note?.markdown) return text(change.note.markdown).replace(/[#>*_`[\]]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return '';
}

function changeLabel(ctx, change, included, createdIds) {
  const items = plural(included, 'item');
  switch (change.op) {
    case 'move_items': return html`Move ${items} to ${collectionPill(ctx, change, createdIds.has(change.collectionId))}`;
    case 'add_tags': return html`Add ${tagList(change.tags)} to ${items}`;
    case 'remove_tags': return html`Remove ${tagList(change.tags)} from ${items}`;
    case 'create_collection': return html`Create collection ${collectionPill(ctx, change, true)}`;
    case 'set_favorite': return change.favorite ? `Add ${items} to favorites` : `Remove ${items} from favorites`;
    case 'archive_items': return `Archive ${items}`;
    case 'trash_items': return `Move ${items} to Trash`;
    default: return change.label;
  }
}

function renderProposal(ctx, proposal) {
  const status = proposalStatus(proposal);
  if (!['pending', 'applying'].includes(status)) return renderReceipt(ctx, proposal, status);
  const ui = proposalUi.get(proposal.id) || { open: false, excluded: new Map() };
  const changes = proposal.changes || [];
  const createdIds = new Set(changes.filter(change => change.op === 'create_collection').map(change => change.collectionId));
  const reviewable = changes.some(change => ITEM_CHANGES.has(change.op) && change.items?.length);
  const left = changes.filter((change, index) => !ITEM_CHANGES.has(change.op) || changeCount(change) - (ui.excluded.get(index)?.size || 0) > 0).length;
  const excludedTotal = [...ui.excluded.values()].reduce((sum, set) => sum + set.size, 0);
  const titleId = `ai-pr-${proposal.id}`;
  return html`<section class="ai-proposal" data-key="pr:${proposal.id}" aria-labelledby="${titleId}">
    <header class="ai-proposal-head">${icon('list-checks', { size: 16 })}<h3 class="ai-proposal-title" id="${titleId}">Proposed changes</h3>
      ${badge({ label: 'Needs approval', tone: 'warning', className: 'ai-proposal-badge' })}</header>
    <ul class="ai-changes" role="list">${changes.map((change, index) => {
      const out = ui.excluded.get(index) || new Set();
      const included = changeCount(change) - out.size;
      const sub = changeSub(ctx, change, out);
      return html`<li class="${cx('ai-change', ITEM_CHANGES.has(change.op) && included <= 0 && 'is-skipped')}">
        <span class="ai-change-icon">${icon(CHANGE_ICONS[change.op] || 'circle', { size: 16 })}</span>
        <div class="ai-change-body"><p class="ai-change-label">${changeLabel(ctx, change, Math.max(0, included), createdIds)}</p>
          ${sub ? html`<p class="ai-change-sub">${sub}</p>` : ''}
          ${ui.open && ITEM_CHANGES.has(change.op) && change.items?.length ? renderReview(ctx, proposal, change, index, ui) : ''}</div>
      </li>`;
    })}</ul>
    <footer class="ai-proposal-foot">
      ${button({ label: excludedTotal && left ? `Apply ${plural(left, 'change')}` : 'Apply', variant: 'primary', size: 'sm', action: 'ai.proposal-apply',
        data: { id: proposal.id }, loading: status === 'applying', disabled: !ui.resolve || !left })}
      ${reviewable ? button({ label: ui.open ? 'Hide review' : 'Review', variant: 'secondary', size: 'sm', action: 'ai.proposal-review', data: { id: proposal.id },
        attrs: { 'aria-expanded': ui.open ? 'true' : 'false' } }) : ''}
      <span class="spacer"></span>
      ${button({ label: 'Discard', variant: 'ghost', size: 'sm', action: 'ai.proposal-discard', data: { id: proposal.id }, disabled: !ui.resolve })}
    </footer>
  </section>`;
}

function renderReview(ctx, proposal, change, index, ui) {
  const out = ui.excluded.get(index) || new Set();
  const listed = change.items || [];
  const included = listed.filter(item => !out.has(item.id)).length;
  const all = included === listed.length;
  return html`<div class="ai-review">
    <label class="checkbox ai-review-all"><input type="checkbox" ${all ? raw('checked') : ''} ${!all && included ? raw('data-indeterminate') : ''}
      data-change="ai.review-all" data-proposal="${proposal.id}" data-change-index="${index}"><span class="checkbox-box" aria-hidden="true">${icon('check', { size: 12, strokeWidth: 3 })}</span>
      <span class="checkbox-label">${included} of ${plural(listed.length, 'item')} selected</span></label>
    <ul class="ai-review-list" role="list">${listed.map(entry => {
      const item = liveItem(ctx, entry.id);
      return html`<li><label class="checkbox ai-review-item"><input type="checkbox" ${out.has(entry.id) ? '' : raw('checked')} data-change="ai.review-item"
        data-proposal="${proposal.id}" data-change-index="${index}" data-item="${entry.id}"><span class="checkbox-box" aria-hidden="true">${icon('check', { size: 12, strokeWidth: 3 })}</span>
        <span class="checkbox-label"><span class="ai-review-title">${entry.title || item?.title || 'Untitled'}</span>${item ? html`<span class="ai-review-meta">${domainOf(item.url) || collectionName(ctx, item.collectionId || '')}</span>` : ''}</span></label></li>`;
    })}</ul>
    ${changeCount(change) > listed.length ? html`<p class="ai-review-more">${plural(changeCount(change) - listed.length, 'more item')} cannot be reviewed here and will be included.</p>` : ''}
  </div>`;
}

function renderReceipt(ctx, proposal, status) {
  const ui = proposalUi.get(proposal.id);
  const lines = ui?.lines || proposal.appliedLines || appliedLines(proposal);
  const undoing = !!ui?.undoing;
  if (status === 'applied') {
    const title = lines.length === 1 ? `Applied: ${lowerFirst(lines[0])}` : `Applied ${plural(lines.length, 'change')}`;
    return html`<div class="ai-receipt" data-status="applied" data-key="pr:${proposal.id}">
      ${icon('circle-check', { size: 16, className: 'ai-receipt-icon' })}
      <div class="ai-receipt-text"><p class="ai-receipt-title">${title}</p>
        ${lines.length > 1 ? html`<ul class="ai-receipt-lines" role="list">${lines.map(line => html`<li>${line}</li>`)}</ul>` : ''}</div>
      ${ui?.undo ? button({ label: 'Undo', icon: 'undo-2', variant: 'ghost', size: 'sm', action: 'ai.proposal-undo', data: { id: proposal.id }, loading: undoing }) : ''}
    </div>`;
  }
  const copy = { discarded: ['circle-x', 'Discarded the proposed changes. Nothing was changed.'], undone: ['undo-2', 'Undone. Your library is back as it was.'],
    failed: ['circle-alert', `Changes failed. Nothing was changed.${ui?.error || proposal.error ? ` ${ui?.error || proposal.error}` : ''}`] }[status]
    || ['circle-x', 'These changes were not applied.'];
  return html`<div class="ai-receipt" data-status="${status}" data-key="pr:${proposal.id}">${icon(copy[0], { size: 16, className: 'ai-receipt-icon' })}
    <div class="ai-receipt-text"><p class="ai-receipt-title">${copy[1]}</p></div></div>`;
}

// ------------------------------------------------------------------------------------------------ popovers

function renderHistoryPopover(ctx) {
  const s = st(ctx);
  const query = s.historyQuery.trim().toLowerCase();
  const list = (s.history || []).filter(entry => !query || `${entry.title} ${entry.preview || ''}`.toLowerCase().includes(query));
  const row = entry => {
    const current = entry.id === s.conversation?.id;
    return html`<li class="${cx('ai-history-row', current && 'is-current')}" data-key="h:${entry.id}">
      <button type="button" class="ai-history-main" data-action="ai.history-open" data-id="${entry.id}" ${current ? raw('aria-current="true"') : ''}>
        <span class="ai-history-title">${entry.title || 'New conversation'}</span>
        <span class="ai-history-meta">${relativeDate(entry.updatedAt)}${entry.preview ? html` · ${entry.preview}` : ''}</span></button>
      <span class="ai-history-tools">
        ${iconButton({ icon: 'pencil', label: 'Rename', size: 'sm', action: 'ai.history-rename', data: { id: entry.id } })}
        ${iconButton({ icon: 'trash-2', label: 'Delete', size: 'sm', action: 'ai.history-delete', data: { id: entry.id } })}
      </span>
    </li>`;
  };
  return html`<div class="ai-history" data-key="ai-history" data-keydown="ai.history-key">
    <div class="ai-pop-search">${icon('search', { size: 16 })}<input class="ai-pop-input" id="ai-history-search" data-focus-key="ai-history-search" type="search"
      placeholder="Search chats" aria-label="Search chats" value="${s.historyQuery}" data-input="ai.history-query" data-autofocus autocomplete="off" spellcheck="false"></div>
    <div class="ai-history-list">
      ${s.history === null ? html`<div class="ai-pop-empty">${spinner({ size: 16, label: 'Loading chats' })}</div>`
        : !list.length ? html`<p class="ai-pop-empty">${query ? 'No chats match.' : 'No chats yet. Questions you ask are kept on this device.'}</p>`
          : historyGroups(list).map(group => html`<section class="ai-history-group" aria-label="${group.label}"><h4 class="ai-history-label">${group.label}</h4>
            <ul role="list">${group.items.map(row)}</ul></section>`)}
    </div>
    <div class="ai-pop-foot">${button({ label: 'New chat', icon: 'square-pen', variant: 'ghost', size: 'sm', action: 'ai.new' })}</div>
  </div>`;
}

function chatModels(connection, current) {
  const models = (connection.models || []).filter(model => !model.capabilities?.embeddings);
  const shown = models.slice(0, 8);
  const extra = models.find(model => model.id === current && !shown.includes(model));
  return extra ? [...shown, extra] : shown;
}

function renderModelPopover(ctx) {
  const s = st(ctx);
  const t = s.target;
  const labels = ctx.ai?.EFFORT_LABELS || {};
  if (s.modelView === 'effort' && t?.efforts?.length) {
    return html`<div class="menu ai-model-menu" role="menu" aria-label="Reasoning effort">
      <button type="button" class="menu-item ai-menu-back" role="menuitem" data-action="ai.effort-back" tabindex="-1">${icon('chevron-left', { size: 16 })}<span class="menu-label">Reasoning effort</span></button>
      <div class="menu-separator" role="separator"></div>
      ${t.efforts.map(level => html`<button type="button" class="menu-item" role="menuitemradio" aria-checked="${level === t.effort ? 'true' : 'false'}" data-action="ai.pick-effort"
        data-effort="${level}" tabindex="-1">${icon(level === t.effort ? 'check' : 'blank', { size: 16 })}<span class="menu-label">${labels[level] || level}</span>
        <span class="menu-hint">${EFFORT_HINTS[level] || ''}</span></button>`)}
    </div>`;
  }
  const connections = (s.connections || []).filter(usable);
  return html`<div class="menu ai-model-menu" role="menu" aria-label="Model">
    ${connections.length ? connections.map((connection, index) => html`${index ? html`<div class="menu-separator" role="separator"></div>` : ''}
      <div class="menu-heading" role="presentation">${connection.label || connection.providerName}</div>
      ${chatModels(connection, t?.model).map(model => {
        const checked = t?.connectionId === connection.id && t?.model === model.id;
        return html`<button type="button" class="menu-item" role="menuitemradio" aria-checked="${checked ? 'true' : 'false'}" data-action="ai.pick-model"
          data-connection="${connection.id}" data-model="${model.id}" tabindex="-1">${icon(checked ? 'check' : 'blank', { size: 16 })}
          <span class="menu-label">${model.name || model.id}</span>${model.description ? html`<span class="menu-hint">${model.description}</span>` : ''}</button>`;
      })}`)
      : html`<p class="ai-pop-empty">No models are connected yet.</p>`}
    <div class="menu-separator" role="separator"></div>
    ${t?.efforts?.length ? html`<button type="button" class="menu-item" role="menuitem" aria-haspopup="menu" data-action="ai.effort-menu" tabindex="-1">${icon('brain', { size: 16 })}
      <span class="menu-label">Reasoning effort</span><span class="menu-hint">${labels[t.effort] || t.effort}</span>${icon('chevron-right', { size: 14 })}</button>` : ''}
    <button type="button" class="menu-item" role="menuitem" data-action="ai.settings" tabindex="-1">${icon('settings', { size: 16 })}<span class="menu-label">Manage models…</span></button>
  </div>`;
}

function itemMatches(ctx, query, limit) {
  const live = ctx.select?.live?.() || [];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...live].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
  const scored = [];
  for (const item of live) {
    const title = text(item.title).toLowerCase();
    const hay = `${title} ${text(item.url).toLowerCase()} ${(item.tags || []).join(' ').toLowerCase()}`;
    if (!words.every(word => hay.includes(word))) continue;
    scored.push([item, title.startsWith(words[0]) ? 0 : title.includes(words[0]) ? 1 : 2]);
  }
  return scored.sort((a, b) => a[1] - b[1] || String(b[0].updatedAt).localeCompare(String(a[0].updatedAt))).slice(0, limit).map(([item]) => item);
}

function contextOptions(ctx) {
  const s = st(ctx);
  const query = s.ctxQuery.trim();
  const resolved = contextFor(ctx);
  const options = [];
  if (!query) {
    const page = ctx.env.isSidepanel && isWebUrl(ctx.state.page?.url) ? ctx.state.page : null;
    if (page && resolved.kind !== 'page') options.push({ kind: 'scope', scope: 'page', label: 'This page', hint: domainOf(page.url), glyph: icon('app-window', { size: 16 }) });
    const view = String(ctx.state.view || '');
    const viewCollection = !ctx.env.isSidepanel && view.startsWith('collection:') ? ctx.select?.collection?.(view.slice(11)) : null;
    if (viewCollection && !(resolved.kind === 'collection' && resolved.scope.collectionId === viewCollection.id)) {
      options.push({ kind: 'scope', scope: 'collection', collectionId: viewCollection.id, label: viewCollection.name, hint: 'Collection', glyph: collectionIcon(viewCollection, { size: 16 }) });
    }
    if (resolved.kind !== 'library') options.push({ kind: 'scope', scope: 'library', label: 'Whole library', hint: 'Search everything', glyph: icon('book-open-text', { size: 16 }) });
  }
  for (const item of itemMatches(ctx, query, 8)) options.push({ kind: 'item', id: item.id, item });
  return options;
}

function renderContextPopover(ctx) {
  const s = st(ctx);
  const options = s.ctxOptions = contextOptions(ctx);
  const active = Math.min(s.ctxActive, Math.max(0, options.length - 1));
  const added = new Set(contextFor(ctx).scope.ids || []);
  const option = (entry, index) => entry.kind === 'scope'
    ? html`<div role="option" id="ai-ctx-${index}" class="${cx('ai-ctx-option', index === active && 'is-active')}" aria-selected="false" data-action="ai.ctx-pick" data-index="${index}">
        ${entry.glyph}<span class="ai-ctx-label">${entry.label}</span><span class="ai-ctx-hint">${entry.hint}</span></div>`
    : html`<div role="option" id="ai-ctx-${index}" class="${cx('ai-ctx-option', index === active && 'is-active')}" aria-selected="${added.has(entry.id) ? 'true' : 'false'}" data-action="ai.ctx-pick" data-index="${index}">
        ${isWebUrl(entry.item.url) ? favicon(entry.item.url, { size: 16 }) : icon(TYPE_ICONS[entry.item.type] || 'file-text', { size: 16 })}
        <span class="ai-ctx-label">${entry.item.title || entry.item.url || 'Untitled'}</span>
        ${added.has(entry.id) ? icon('check', { size: 14, className: 'ai-ctx-check' }) : html`<span class="ai-ctx-hint">${domainOf(entry.item.url)}</span>`}</div>`;
  const scopes = options.map((entry, index) => [entry, index]).filter(([entry]) => entry.kind === 'scope');
  const items = options.map((entry, index) => [entry, index]).filter(([entry]) => entry.kind === 'item');
  return html`<div class="ai-context" data-key="ai-context">
    <div class="ai-pop-search">${icon('search', { size: 16 })}<input class="ai-pop-input" id="ai-ctx-search" data-focus-key="ai-ctx-search" type="text" role="combobox"
      aria-expanded="true" aria-controls="ai-ctx-list" aria-autocomplete="list" aria-activedescendant="${options.length ? `ai-ctx-${active}` : ''}" aria-label="Add items to the context"
      placeholder="Add items to the context" value="${s.ctxQuery}" data-input="ai.ctx-query" data-keydown="ai.ctx-key" data-autofocus autocomplete="off" spellcheck="false"></div>
    <div class="ai-ctx-list" id="ai-ctx-list" role="listbox" aria-label="Context" aria-multiselectable="true">
      ${scopes.length ? html`<div class="ai-ctx-group" role="group" aria-label="Ask about"><div class="ai-ctx-heading" aria-hidden="true">Ask about</div>${scopes.map(([entry, index]) => option(entry, index))}</div>` : ''}
      ${items.length ? html`<div class="ai-ctx-group" role="group" aria-label="${s.ctxQuery.trim() ? 'Items' : 'Recent items'}"><div class="ai-ctx-heading" aria-hidden="true">${s.ctxQuery.trim() ? 'Items' : 'Recent items'}</div>
        ${items.map(([entry, index]) => option(entry, index))}</div>` : html`<p class="ai-pop-empty">No items match.</p>`}
    </div>
  </div>`;
}

registerPopover('ai.history', renderHistoryPopover, { role: 'dialog', className: 'ai-pop ai-history-pop' });
registerPopover('ai.model', renderModelPopover, { role: 'menu', className: 'popover-menu ai-model-pop' });
registerPopover('ai.context', renderContextPopover, { role: 'dialog', className: 'ai-pop ai-context-pop' });

// ------------------------------------------------------------------------------------------------ export, notes, hand-off

function answerContext(ctx, message) {
  const s = st(ctx);
  const messages = s.conversation?.messages || [];
  const index = messages.findIndex(entry => entry.id === message.id);
  const question = index > 0 ? messages.slice(0, index).reverse().find(entry => entry.role === 'user') : null;
  const citations = citationsFor(ctx, message);
  return { question, citations };
}

async function saveAsNote(ctx, message) {
  const { question, citations } = answerContext(ctx, message);
  const content = `${exportAnswer(message.text, citations, { links: 'wiki', isItem: id => !!liveItem(ctx, id) }).trim()}\n`;
  const title = (st(ctx).conversation?.title || text(question?.text).split('\n')[0] || 'Assistant answer').slice(0, 120);
  const relatedIds = citations.map(source => source.id).filter(id => liveItem(ctx, id));
  const url = question?.context?.scope === 'page' && isWebUrl(question.context.page?.url) ? question.context.page.url : '';
  let note = await createNote(ctx, { title, content, url, relatedIds, open: false });
  if (!note) note = await ctx.store.saveItem({ type: 'note', title, content, url, relatedIds, tags: [] });
  if (note?.id) ctx.toast('Saved as a note', { tone: 'success', action: { label: 'Open', run: () => ctx.openItem(note.id) } });
}

async function insertIntoNote(ctx, message) {
  const note = openNote(ctx);
  if (!note) { ctx.toast('Open a note first.'); return; }
  const { citations } = answerContext(ctx, message);
  const markdown = exportAnswer(message.text, citations, { links: 'wiki', isItem: id => !!liveItem(ctx, id) }).trim();
  if (hasAction('editor.insert-markdown')) {
    await ctx.dispatch('editor.insert-markdown', { data: { noteId: note.id, markdown } });
    return;
  }
  const current = text(note.content).trimEnd();
  await ctx.store.updateItem(note.id, { content: `${current ? `${current}\n\n` : ''}${markdown}\n` }, { expectedUpdatedAt: note.updatedAt });
  ctx.toast(`Added to “${note.title || 'Untitled note'}”`, { tone: 'success' });
}

function sourcesForScope(ctx, scope) {
  const itemSource = item => ({ title: item.title, url: item.url, excerpt: text(item.excerpt) || text(item.content).slice(0, 600) });
  if (scope.scope === 'page' && scope.page) return [{ title: scope.page.title, url: scope.page.url, excerpt: text(scope.page.excerpt) }];
  if (scope.ids?.length) return scope.ids.map(id => liveItem(ctx, id)).filter(Boolean).slice(0, 12).map(itemSource);
  if (scope.scope === 'collection') {
    const ids = new Set(scope.collectionId ? ctx.select?.descendants?.(scope.collectionId) || [scope.collectionId] : ['']);
    return (ctx.select?.live?.() || []).filter(item => ids.has(item.collectionId || '')).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, 12).map(itemSource);
  }
  return [];
}

function defaultQuestion(ctx, scope) {
  if (scope.scope === 'page') return 'Summarize this page and tell me what is worth remembering.';
  if (scope.ids?.length) return scope.ids.length === 1 ? 'Help me understand this item.' : 'Help me make sense of these items from my library.';
  if (scope.scope === 'collection') return `Help me make sense of my ${collectionName(ctx, scope.collectionId)} collection.`;
  return '';
}

async function handoff(ctx, target, prompt) {
  if (typeof ctx.ai?.handoffPlan !== 'function') return;
  const plan = ctx.ai.handoffPlan(target, prompt);
  if (plan.copyFirst) {
    try { await navigator.clipboard.writeText(plan.fullPrompt); ctx.toast(`Prompt copied. Paste it into ${plan.name} if it is not filled in.`); }
    catch (error) { console.warn('[still] clipboard unavailable', error); }
  }
  await ctx.dispatch('app.open-url', { data: { url: plan.url } });
}

// ------------------------------------------------------------------------------------------------ actions

function setOpen(ctx, key) {
  const open = st(ctx).open;
  if (open.has(key)) open.delete(key); else open.add(key);
  bump(ctx);
}

function moveCaretTo(input, index, length = 0) {
  input.focus({ preventScroll: true });
  input.setSelectionRange(index, index + length);
}

function excludedFor(ui, data) {
  const index = Number(data.changeIndex);
  if (!ui.excluded.has(index)) ui.excluded.set(index, new Set());
  return { index, set: ui.excluded.get(index) };
}

registerActions({
  'ai.draft': ({ ctx, el }) => {
    const s = st(ctx);
    const before = s.draft;
    s.draft = el.value;
    const send = el.form?.querySelector('.ai-send[type="submit"]');
    if (send) send.disabled = !s.draft.trim() || s.draft.length > MAX_QUESTION || s.target === null;
    if ((before.length >= COUNT_FROM) !== (s.draft.length >= COUNT_FROM) || !before !== !s.draft) ctx.render();
  },
  'ai.key': ({ ctx, el, event }) => {
    const s = st(ctx);
    if (event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      if (!s.run) submit(ctx);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (s.run) stopRun(ctx);
      else if (s.editing) { s.editing = null; s.draft = ''; el.value = ''; ctx.render(); }
      else if (!ctx.env.isSidepanel && ctx.state.panel?.kind === 'ai') ctx.closePanel();
      else el.blur();
      return;
    }
    if (event.key === 'ArrowUp' && !el.value && !s.run && !event.shiftKey) {
      const question = (s.conversation?.messages || []).findLast(message => message.role === 'user');
      if (!question) return;
      event.preventDefault();
      s.editing = { messageId: question.id };
      s.draft = question.text;
      el.value = question.text;
      moveCaretTo(el, el.value.length);
      ctx.render();
    }
  },
  'ai.send': ({ ctx }) => { submit(ctx); },
  'ai.stop': ({ ctx }) => { stopRun(ctx); bump(ctx, { render: true }); },
  'ai.escape': ({ ctx }) => {
    if (st(ctx).run) { stopRun(ctx); bump(ctx, { render: true }); }
    else if (!ctx.env.isSidepanel && ctx.state.panel?.kind === 'ai') ctx.closePanel();
  },
  'ai.new': ({ ctx }) => newChat(ctx),
  'ai.expand': ({ ctx }) => {
    const width = Number(ctx.prefs.get('panelWidth', 400)) || 400;
    if (width >= EXPANDED_WIDTH - 40) ctx.prefs.set('panelWidth', Number(ctx.prefs.get('aiNarrowWidth', 400)) || 400);
    else { ctx.prefs.set('aiNarrowWidth', width); ctx.prefs.set('panelWidth', EXPANDED_WIDTH); }
    ctx.render();
  },
  'ai.edit': ({ ctx, data }) => {
    const s = st(ctx);
    const message = findMessage(s, data.id);
    if (!message || s.run) return;
    s.editing = { messageId: message.id };
    s.draft = message.text;
    ctx.render();
    ctx.nextFrame(() => { const input = composer(); if (input) { input.value = message.text; moveCaretTo(input, input.value.length); } });
  },
  'ai.edit-cancel': ({ ctx }) => {
    const s = st(ctx);
    s.editing = null;
    s.draft = '';
    const input = composer();
    if (input) { input.value = ''; input.focus(); }
    ctx.render();
  },
  'ai.suggest': ({ ctx, data }) => {
    const s = st(ctx);
    const suggestion = s.suggestions[Number(data.index)];
    if (!suggestion) return;
    if (suggestion.run === 'save-page') { openAddForPage(ctx); return; }
    const gap = suggestion.prompt.indexOf('…');
    if (gap < 0 && s.target) { submit(ctx, { question: suggestion.prompt }); return; }
    s.draft = suggestion.prompt;
    ctx.render();
    ctx.nextFrame(() => { const input = composer(); if (input) { input.value = suggestion.prompt; moveCaretTo(input, Math.max(0, gap), gap < 0 ? 0 : 1); } });
  },
  'ai.setup': ({ ctx, data }) => openSettings(ctx, 'ai', { providerId: data.provider }),
  'ai.settings': ({ ctx }) => { ctx.closePopover?.({ restore: false }); openSettings(ctx, 'ai'); },
  'ai.chip-remove': ({ ctx, data }) => {
    const s = st(ctx);
    const resolved = contextFor(ctx);
    const chip = resolved.chips.find(entry => entry.key === data.chip);
    if (!chip) return;
    if (chip.key === 'explicit') {
      if (chip.kind === 'page') s.dismissed.add(`page:${chip.page.url}`);
      if (chip.kind === 'collection') s.dismissed.add(`collection:${chip.collectionId}`);
      s.explicit = null;
    } else if (chip.key.startsWith('added:')) s.added = s.added.filter(id => id !== chip.ids[0]);
    else s.dismissed.add(chip.key);
    ctx.render();
    ctx.nextFrame(() => composer()?.focus({ preventScroll: true }));
  },
  'ai.add-context': ({ ctx, el }) => {
    const s = st(ctx);
    s.ctxQuery = '';
    s.ctxActive = 0;
    ctx.openPopover('ai.context', el, {}, { placement: 'top-start' });
  },
  'ai.ctx-query': ({ ctx, el }) => { const s = st(ctx); s.ctxQuery = el.value; s.ctxActive = 0; ctx.render(); },
  'ai.ctx-key': ({ ctx, event }) => {
    const s = st(ctx);
    const count = s.ctxOptions.length;
    if (!count) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      s.ctxActive = (Math.min(s.ctxActive, count - 1) + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      ctx.render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      ctx.dispatch('ai.ctx-pick', { data: { index: String(Math.min(s.ctxActive, count - 1)) } });
    }
  },
  'ai.ctx-pick': ({ ctx, data }) => {
    const s = st(ctx);
    const index = Number(data.index);
    const entry = s.ctxOptions[index];
    if (!entry) return;
    s.ctxActive = index;
    if (entry.kind === 'scope') {
      s.added = [];
      s.explicit = entry.scope === 'collection' ? { scope: 'collection', ids: [], collectionId: entry.collectionId } : { scope: entry.scope, ids: [], collectionId: '' };
      if (entry.scope === 'page' && ctx.state.page?.url) s.dismissed.delete(`page:${ctx.state.page.url}`);
      ctx.closePopover();
      ctx.render();
      return;
    }
    const current = contextFor(ctx).scope.ids || [];
    if (current.includes(entry.id)) {
      s.added = s.added.filter(id => id !== entry.id);
      if (s.explicit?.ids?.includes(entry.id)) {
        const ids = s.explicit.ids.filter(id => id !== entry.id);
        s.explicit = ids.length ? { ...s.explicit, ids, scope: ids.length === 1 ? 'item' : 'items' } : null;
      }
    } else s.added = [...s.added, entry.id].slice(-24);
    ctx.render();
  },
  'ai.model': ({ ctx, el }) => {
    const s = st(ctx);
    s.modelView = 'models';
    ctx.openPopover('ai.model', el, {}, { placement: 'top-start' });
    const id = s.target?.connectionId;
    const connection = s.connections.find(entry => entry.id === id);
    if (id && connection?.via === 'direct' && connection.hasKey && typeof ctx.ai?.listModels === 'function') {
      ctx.ai.listModels(id).then(models => {
        if (!Array.isArray(models) || !models.length) return;
        connection.models = models;
        if (popoverOpen(ctx, 'ai.model')) ctx.render();
      }, () => {});
    }
  },
  'ai.effort-menu': ({ ctx }) => {
    st(ctx).modelView = 'effort';
    ctx.render();
    ctx.nextFrame(() => document.querySelector('#still-popover [role="menuitemradio"][aria-checked="true"], #still-popover [role^="menuitem"]')?.focus());
  },
  'ai.effort-back': ({ ctx }) => {
    st(ctx).modelView = 'models';
    ctx.render();
    ctx.nextFrame(() => document.querySelector('#still-popover [data-action="ai.effort-menu"]')?.focus());
  },
  'ai.pick-model': async ({ ctx, data }) => {
    const s = st(ctx);
    const connection = s.connections.find(entry => entry.id === data.connection);
    const model = (connection?.models || []).find(entry => entry.id === data.model);
    ctx.closePopover();
    if (!connection || !model) return;
    const efforts = model.efforts || [];
    const effort = efforts.includes(s.target?.effort) ? s.target.effort : model.defaultEffort || (efforts.includes('medium') ? 'medium' : efforts[0]);
    await ctx.ai.setAiSettings({ chat: { connectionId: connection.id, model: model.id, ...(effort ? { effort } : {}) } });
    await refreshTarget(ctx);
  },
  'ai.pick-effort': async ({ ctx, data }) => {
    const s = st(ctx);
    ctx.closePopover();
    if (!s.target) return;
    s.target = { ...s.target, effort: data.effort };
    ctx.render();
    await ctx.ai.setAiSettings({ chat: { connectionId: s.target.connectionId, model: s.target.model, effort: data.effort } });
  },
  'ai.history': ({ ctx, el }) => {
    const s = st(ctx);
    s.historyQuery = '';
    ctx.openPopover('ai.history', el, {}, { placement: 'bottom-start' });
    refreshHistory(ctx, { quiet: true });
  },
  'ai.history-query': ({ ctx, el }) => { st(ctx).historyQuery = el.value; ctx.render(); },
  'ai.history-key': ({ event }) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const rows = [...document.querySelectorAll('#still-popover .ai-history-main')];
    if (!rows.length) return;
    event.preventDefault();
    const index = rows.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % rows.length : index <= 0 ? (index < 0 ? 0 : rows.length - 1) : index - 1;
    rows[next].focus();
  },
  'ai.history-open': ({ ctx, data }) => openConversation(ctx, data.id),
  'ai.history-rename': async ({ ctx, data }) => {
    const s = st(ctx);
    const entry = (s.history || []).find(item => item.id === data.id);
    const name = await ctx.prompt({ title: 'Rename chat', label: 'Name', value: entry?.title || '', confirmLabel: 'Rename' });
    if (name === null || !name.trim()) return;
    const conversation = await ctx.ai.getConversation(data.id);
    if (!conversation) return;
    const saved = await ctx.ai.saveConversation({ ...conversation, title: name.trim().slice(0, 200) });
    if (s.conversation?.id === data.id) s.conversation = { ...s.conversation, title: saved.title };
    await refreshHistory(ctx, { quiet: true });
    ctx.render();
  },
  'ai.history-delete': async ({ ctx, data }) => {
    const s = st(ctx);
    const entry = (s.history || []).find(item => item.id === data.id);
    const ok = await ctx.confirm({ title: 'Delete this chat?', body: `“${entry?.title || 'This chat'}” is removed from this device. Saved notes and items stay.`, confirmLabel: 'Delete', tone: 'danger' });
    if (!ok) return;
    await ctx.ai.deleteConversation(data.id);
    if (s.conversation?.id === data.id) newChat(ctx, { focus: false });
    await refreshHistory(ctx, { quiet: true });
    ctx.toast('Chat deleted');
  },
  'ai.toggle': ({ ctx, data }) => setOpen(ctx, data.open),
  'ai.cite': ({ ctx, data, el }) => {
    if (data.id === 'page:current') {
      const url = data.url || st(ctx).run?.scope?.page?.url || st(ctx).conversation?.scope?.page?.url || ctx.state.page?.url;
      if (isWebUrl(url)) ctx.dispatch('app.open-url', { el, data: { url } });
      return;
    }
    ctx.openItem(data.id);
  },
  'ai.copy': async ({ ctx, data }) => {
    const message = findMessage(st(ctx), data.id);
    if (!message) return;
    const value = message.role === 'assistant' ? exportAnswer(message.text, citationsFor(ctx, message)) : message.text;
    await navigator.clipboard.writeText(value);
    ctx.toast('Copied');
  },
  'ai.save-note': async ({ ctx, data }) => { const message = findMessage(st(ctx), data.id); if (message?.text) await saveAsNote(ctx, message); },
  'ai.insert-note': async ({ ctx, data }) => { const message = findMessage(st(ctx), data.id); if (message?.text) await insertIntoNote(ctx, message); },
  'ai.retry': ({ ctx, data }) => { retry(ctx, data.id); },
  'ai.allow-host': ({ ctx, data }) => {
    const s = st(ctx);
    const connection = s.connections.find(entry => entry.id === data.connection);
    const target = connection ? { providerId: connection.providerId, baseUrl: connection.baseUrl } : s.target ? { providerId: s.target.providerId, baseUrl: s.target.baseUrl } : null;
    if (!target || typeof ctx.ai?.ensureHostPermission !== 'function') { retry(ctx, data.id); return; }
    // Called before any await so Chrome treats it as part of the click.
    return ctx.ai.ensureHostPermission(target).then(() => retry(ctx, data.id), error => ctx.toast(error?.message || 'Still was not allowed to reach the model.', { tone: 'danger' }));
  },
  'ai.page-allow': ({ ctx }) => {
    const s = st(ctx);
    const notice = s.pagePermission;
    if (!notice) return;
    const request = notice.origin === 'tabs' ? { permissions: ['tabs'] } : { origins: [notice.origin] };
    let pending;
    try { pending = globalThis.chrome?.permissions?.request?.(request); } catch { pending = false; }
    return Promise.resolve(pending).then(granted => {
      if (!granted) { ctx.toast('Still cannot read this page without access.'); return; }
      s.pagePermission = null;
      if (s.draft === notice.question) { s.draft = ''; const input = composer(); if (input) input.value = ''; }
      submit(ctx, { question: notice.question, scope: notice.scope, replace: notice.replaceFrom });
    }, () => ctx.toast('Still cannot read this page without access.'));
  },
  'ai.page-skip': ({ ctx }) => {
    const s = st(ctx);
    const notice = s.pagePermission;
    if (!notice) return;
    s.pagePermission = null;
    if (s.draft === notice.question) { s.draft = ''; const input = composer(); if (input) input.value = ''; }
    submit(ctx, { question: notice.question, scope: { ...notice.scope, page: { ...notice.scope.page, text: '' } }, replace: notice.replaceFrom });
  },
  'ai.page-dismiss': ({ ctx }) => { st(ctx).pagePermission = null; ctx.render(); },
  'ai.proposal-review': ({ ctx, data }) => {
    const ui = proposalUi.get(data.id);
    if (!ui) return;
    ui.open = !ui.open;
    bump(ctx);
  },
  'ai.review-item': ({ ctx, el, data }) => {
    const ui = proposalUi.get(data.proposal);
    if (!ui?.resolve) return;
    const { set } = excludedFor(ui, data);
    if (el.checked) set.delete(data.item); else set.add(data.item);
    bump(ctx);
  },
  'ai.review-all': ({ ctx, el, data }) => {
    const ui = proposalUi.get(data.proposal);
    const proposal = findProposal(ctx, data.proposal);
    if (!ui?.resolve || !proposal) return;
    const { index, set } = excludedFor(ui, data);
    set.clear();
    if (!el.checked) for (const item of proposal.changes[index]?.items || []) set.add(item.id);
    bump(ctx);
  },
  'ai.proposal-apply': ({ ctx, data }) => {
    const ui = proposalUi.get(data.id);
    const proposal = findProposal(ctx, data.id);
    if (!ui?.resolve || !proposal) return;
    const resolve = ui.resolve;
    ui.resolve = null;
    const excluded = new Map([...ui.excluded].filter(([, set]) => set.size));
    const left = (proposal.changes || []).filter((change, index) => !ITEM_CHANGES.has(change.op) || changeCount(change) - (excluded.get(index)?.size || 0) > 0);
    if (!left.length) { ui.status = 'discarded'; resolve('discard'); bump(ctx, { render: true }); return; }
    if (excluded.size) {
      const before = new Map();
      for (const set of excluded.values()) for (const id of set) { const item = ctx.select.byId(id); if (item) before.set(id, structuredClone(item)); }
      ui.restore = exclusionPatches(proposal, excluded, before);
      ui.lines = appliedLines(proposal, excluded);
    }
    ui.status = 'applying';
    ui.open = false;
    resolve('apply');
    bump(ctx, { render: true });
  },
  'ai.proposal-discard': ({ ctx, data }) => {
    const ui = proposalUi.get(data.id);
    if (!ui?.resolve) return;
    const resolve = ui.resolve;
    ui.resolve = null;
    ui.status = 'discarded';
    resolve('discard');
    bump(ctx, { render: true });
  },
  'ai.proposal-undo': async ({ ctx, data }) => {
    const ui = proposalUi.get(data.id);
    if (!ui?.undo || ui.undone || ui.undoing) return;
    ui.undoing = true;
    bump(ctx);
    try {
      await ui.undo();
      ui.undone = true;
      ui.undo = null;
      announce(ctx, 'Changes undone.');
      ctx.toast('Changes undone');
      await persistProposal(ctx, data.id, { status: 'undone' });
    } finally {
      ui.undoing = false;
      bump(ctx, { render: true });
    }
  },
  'ai.handoff': ({ ctx, data }) => {
    const s = st(ctx);
    const scope = contextFor(ctx).scope;
    const question = s.draft.trim() || defaultQuestion(ctx, scope);
    if (!question) { ctx.toast('Write a question first.'); composer()?.focus(); return; }
    return handoff(ctx, data.target, { question, sources: sourcesForScope(ctx, scope.scope === 'page' ? { ...scope, page: ctx.state.page } : scope) });
  },
  'ai.handoff-menu': ({ ctx, el, data }) => {
    const s = st(ctx);
    const message = findMessage(s, data.id);
    if (!message) return;
    const { question, citations } = answerContext(ctx, message);
    const sources = citations.map(source => {
      if (source.id === 'page:current') return { title: source.title, url: source.url };
      const item = liveItem(ctx, source.id);
      return item ? { title: item.title, url: item.url, excerpt: text(item.excerpt) } : null;
    }).filter(Boolean);
    const prompt = { question: text(question?.text) || 'Continue from this answer.', sources };
    ctx.openMenu(el, [
      ...HANDOFFS.map(target => ({ label: `Open in ${target.label}`, icon: 'external-link', run: () => handoff(ctx, target.id, prompt) })),
      { separator: true },
      { label: 'Copy prompt with sources', icon: 'clipboard', run: async () => { await navigator.clipboard.writeText(ctx.ai.buildHandoffPrompt(prompt)); ctx.toast('Prompt copied'); } },
    ], { placement: 'bottom-end', label: 'Open in another app' });
  },
});

function findProposal(ctx, id) {
  for (const message of threadMessages(st(ctx))) {
    const proposal = (message.proposals || []).find(entry => entry.id === id);
    if (proposal) return proposal;
  }
  return null;
}

async function persistProposal(ctx, proposalId, patch) {
  const s = st(ctx);
  const conversation = s.conversation;
  if (!conversation?.messages?.some(message => (message.proposals || []).some(entry => entry.id === proposalId))) return;
  const next = { ...conversation, messages: conversation.messages.map(message => (message.proposals || []).some(entry => entry.id === proposalId)
    ? { ...message, proposals: message.proposals.map(entry => entry.id === proposalId ? { ...entry, ...patch } : entry) } : message) };
  s.conversation = next;
  try { s.conversation = await ctx.ai.saveConversation(next); } catch (error) { console.error(error); }
}

// Esc stops an answer from anywhere in the app; inside the composer the composer's own key handler takes it first.
registerShortcuts([
  { keys: 'escape', action: 'ai.escape', allowInInputs: true,
    when: ctx => !ctx.state.dialogs?.length && !ctx.state.popover && !!ctx.state.ai?.run && aiVisible(ctx) },
]);
