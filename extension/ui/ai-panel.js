// Assistant panel (SPEC §7.3) on the lib/ai facade: conversation header with history, a transcript painted by the
// 'ai.transcript' mount (streamed tokens repaint only that mount, never the app), proposal cards that gate every library
// change, context chips, the model picker, the composer, and a no-provider setup with keyless hand-off.
// Three surfaces share one conversation state (ctx.state.ai): the side panel's Ask tab ('side'), the full tab's right
// panel ('full') and the full-screen assistant view ('page', drawn by assistant-page.js around renderAiPanel).
import { html, raw, cx, plural } from './html.js';
import { icon, registerIcons } from './icons.js';
import { button, iconButton, collectionIcon, siteIcon, favicon, domainOf, relativeDate, emptyState, spinner, badge, avatarTile, TYPE_ICONS } from './components.js';
import { registerActions, registerMount, registerShortcuts, hasAction } from './runtime.js';
import { registerPopover } from './overlay.js';
import { morph } from './morph.js';
import { renderMarkdown } from '../lib/markdown.js';
import { openSettings } from './settings.js';
import { createNote } from './notes.js';
import { openAddForPage } from './quick-add.js';
import { CONVERSATIONS_KEY } from '../lib/ai/conversations.js';
import { allowedCategories } from '../lib/ai/permissions.js';
import { aiState, assistantUrl } from './ai-state.js';
import { browserLine, renderBrowserCard, renderBrowserModeButton, renderBrowserModeMenu, renderBrowserNotice, renderUnverified } from './ai-browser.js';
import { BROWSER_MODES, BROWSER_PERMISSIONS, BROWSER_SITE_ORIGINS, browserAccess, withSiteRule } from '../lib/browser/settings.js';
import { mergeWebSources, webSearchKind } from '../lib/ai/web-search.js';
// The research view, not research.js: research.js (the research actions) imports this module.
import {
  isResearchConversation, isResearchRunning, researchState, requestResearchAccess, handleResearchError, renderResearchBar, renderResearchSteps,
  renderSubpageChips, renderResearchChip, renderResearchNotice, watchStale, openResearchTab, latestResearchMessage,
} from './research-view.js';

registerIcons({
  'chevrons-left-right': '<path d="m9 7-5 5 5 5"/><path d="m15 7 5 5-5 5"/>',
  'chevrons-right-left': '<path d="m20 17-5-5 5-5"/><path d="m4 17 5-5-5-5"/>',
});

export const MAX_QUESTION = 32000;
const COUNT_FROM = 28000;
const EXPANDED_WIDTH = 640;
const STICK_PX = 48;
const TOOL_ROWS = 3;
// Write tools (lib/ai/tools.js): their calls are shown as proposal cards, never as tool-step rows.
export const WRITE_TOOLS = new Set(['create_collection', 'move_items', 'add_tags', 'remove_tags', 'set_favorite', 'archive_items', 'trash_items', 'create_note',
  'append_to_note', 'update_item', 'save_links', 'convert_items', 'restore_items', 'unarchive_items', 'update_collection', 'delete_collection', 'rename_tag',
  'delete_tag', 'link_items', 'unlink_items', 'show_collection_on_dashboard', 'import_ai_threads']);
// Proposal ops whose items can be left out in Review (their itemIds are existing items, or links still to be saved).
const ITEM_CHANGES = new Set(['move_items', 'add_tags', 'remove_tags', 'set_favorite', 'archive_items', 'trash_items', 'update_item', 'save_links', 'convert_items',
  'restore_items', 'unarchive_items', 'rename_tag', 'link_items', 'unlink_items', 'import_ai_threads']);
const CHANGE_ICONS = { create_collection: 'folder-plus', move_items: 'folder-input', add_tags: 'hash', remove_tags: 'hash', set_favorite: 'star', archive_items: 'archive',
  trash_items: 'trash-2', create_note: 'sticky-note', append_to_note: 'notebook-pen', update_item: 'pencil', save_links: 'bookmark-plus', convert_items: 'repeat',
  restore_items: 'rotate-ccw', unarchive_items: 'archive-restore', update_collection: 'folder-open', delete_collection: 'trash-2', rename_tag: 'tag', link_items: 'link',
  unlink_items: 'unlink', add_dashboard_widget: 'layout-dashboard', import_ai_threads: 'messages-square' };
const DESTRUCTIVE = new Set(['trash_items', 'delete_collection']);
/** The icon a proposal row shows for an op (a plain circle for an op this version does not know). */
export const changeIcon = op => CHANGE_ICONS[op] || 'circle';
const EFFORT_HINTS = { none: 'No extra reasoning', minimal: 'Fastest', low: 'Quick answers', medium: 'Balanced', high: 'More thorough', xhigh: 'Deep reasoning', max: 'Most thorough' };
const HANDOFFS = [{ id: 'claude', label: 'Claude' }, { id: 'chatgpt', label: 'ChatGPT' }, { id: 'grok', label: 'Grok' }];
const SETUP_PATHS = [
  { providerId: 'anthropic', title: 'Add an Anthropic key', body: 'Claude Opus, Sonnet and Haiku', letter: 'A', color: 'orange' },
  { providerId: 'openai', title: 'Add an OpenAI key', body: 'GPT models, plus embeddings for search', letter: 'O', color: 'green' },
  { providerId: 'ollama', title: 'Use Ollama on this computer', body: 'Free and private, runs locally', icon: 'cpu', color: 'gray' },
];
const SETTINGS_ERRORS = new Set(['auth', 'no_connection', 'no_model', 'not_found', 'disabled', 'workspace_required', 'origin_blocked']);
const CITATION = /\[\[([\w:.-]+)\]\]/g;
// Where lib/ai/conversations.js keeps each conversation body (the index lives under CONVERSATIONS_KEY). Pages watch these
// keys so the side panel, full tabs and the new tab show the same conversations as they change.
export const CONVERSATION_BODY_PREFIX = 'still.ai.conversation.v2:';

const isWebUrl = url => /^https?:\/\/[^/\s]/i.test(String(url || ''));
// Research statuses whose session may still run or continue (lib/ai/research/run.js).
const OPEN_RESEARCH = new Set(['starting', 'running', 'waiting']);
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
    // A template: name the collection, then paste the links on the next line.
    { icon: 'bookmark-plus', label: 'Save these links into a collection', prompt: 'Save these links as separate links in a collection called …:\n' },
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

// Past tense for receipts; lib/ai/tools.js (labelFor) words its tool results the same way. Unknown verbs stay as they are.
const PAST_VERBS = { Create: 'Created', Move: 'Moved', Add: 'Added', Remove: 'Removed', Archive: 'Archived', Unarchive: 'Unarchived', Append: 'Appended',
  Rename: 'Renamed', Update: 'Updated', Save: 'Saved', Turn: 'Turned', Change: 'Changed', Convert: 'Converted', Restore: 'Restored', Delete: 'Deleted',
  Link: 'Linked', Unlink: 'Unlinked', Replace: 'Replaced', Clear: 'Cleared', Mark: 'Marked', Pin: 'Pinned', Unpin: 'Unpinned', Merge: 'Merged', Import: 'Imported' };
const PAST_PHRASES = [[/^Show (.+) on the dashboard$/, 'Added $1 to the dashboard'], [/\bmoves? (to Inbox|up a level)\b/g, 'moved $1']];
const pastTense = label => PAST_PHRASES.reduce((value, [from, to]) => value.replace(from, to), text(label))
  .replace(/^([A-Z][a-z]+) /, (match, verb) => PAST_VERBS[verb] ? `${PAST_VERBS[verb]} ` : match);
const changeCount = change => Number.isFinite(change?.count) ? change.count : (change?.itemIds || []).length;
// "Save 17 links to …" with 2 left out reads "Save 15 links to …": the first count of what the change acts on is rewritten.
const recount = (label, total, left) => text(label).replace(new RegExp(`\\b${total} (item|link|note|bookmark|article|image|video|file|chat)s?\\b`), (match, noun) => plural(left, noun));
const isSkipped = (change, out) => !!out?.size && changeCount(change) - out.size <= 0;

/**
 * Review exclusions as the engine applies them (lib/ai/tools.js): an excluded item id leaves every change it is part of,
 * and a change left without items is dropped. excluded: item ids (array or Set) -> Map<changeIndex, Set<itemId>>.
 */
export function excludedByChange(proposal, excluded) {
  const ids = excluded instanceof Set ? excluded : new Set(unique(excluded));
  const byChange = new Map();
  (proposal?.changes || []).forEach((change, index) => {
    const out = new Set((change.itemIds || []).filter(id => ids.has(id)));
    if (out.size) byChange.set(index, out);
  });
  return byChange;
}

/**
 * What Apply answers the engine's onProposal: 'apply', { decision: 'apply', exclude: [ids] } when items were left out in
 * Review, or 'discard' when nothing would be left to apply. excluded: item ids unchecked in Review (array or Set).
 */
export function proposalDecision(proposal, excluded = []) {
  const changes = proposal?.changes || [];
  const exclude = unique([...(excluded || [])]).filter(id => changes.some(change => (change.itemIds || []).includes(id)));
  const byChange = excludedByChange(proposal, exclude);
  if (!changes.some((change, index) => !isSkipped(change, byChange.get(index)))) return 'discard';
  return exclude.length ? { decision: 'apply', exclude } : 'apply';
}

/**
 * One line per change that was applied, in the past tense, with counts that leave out excluded items.
 * excluded: the excluded item ids (array or Set), or a Map<changeIndex, Set<itemId>>.
 */
export function appliedLines(proposal, excluded = new Map()) {
  const byChange = excluded instanceof Map ? excluded : excludedByChange(proposal, excluded);
  const lines = [];
  (proposal?.changes || []).forEach((change, index) => {
    const out = byChange.get(index);
    if (isSkipped(change, out)) return;
    const label = pastTense(change.label);
    lines.push(out?.size ? recount(label, changeCount(change), changeCount(change) - out.size) : label);
  });
  return lines;
}

// Web addresses in a preview are kept exactly as written; trailing sentence punctuation (and a closing bracket the
// address did not open) is left outside them.
function splitUrl(raw) {
  let url = raw;
  let tail = '';
  for (;;) {
    const last = url.at(-1);
    const unbalanced = last === ')' && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length;
    if (!last || !(/[.,;:!?*~`'"]/.test(last) || unbalanced)) break;
    tail = last + tail;
    url = url.slice(0, -1);
  }
  return [url, tail];
}

/**
 * A short plain-text preview of Markdown for a proposal row: headings, quotes, list marks, emphasis and citations are
 * removed, links show their text, and web addresses stay whole and unchanged (never cut, never stripped of _ or #).
 */
export function noteSnippet(markdown, max = 160) {
  const urls = [];
  const keep = url => `\u0000${urls.push(url) - 1}\u0000`;
  const plain = text(markdown)
    .replace(/\[\[[\w:.-]+\]\]/g, '')
    .replace(/!?\[([^\]\n]*)\]\(\s*<?((?:[^\s()<>]|\([^\s()]*\))+)>?(?:\s+"[^"\n]*")?\s*\)/g, (match, label, url) => label.trim() || (/^https?:\/\//i.test(url) ? keep(url) : ''))
    .replace(/<(https?:\/\/[^\s>]+)>/gi, (match, url) => keep(url))
    .replace(/https?:\/\/[^\s<>]+/gi, match => { const [url, tail] = splitUrl(match); return keep(url) + tail; })
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/gm, '')
    .replace(/(^|[\s(])[*_~`]+(?=\S)/gm, '$1')
    .replace(/(\S)[*_~`]+(?=$|[\s).,;:!?])/gm, '$1')
    .replace(/\s+/g, ' ').trim()
    .replace(/\u0000(\d+)\u0000/g, (match, index) => urls[Number(index)]);
  if (plain.length <= max) return plain;
  let out = '';
  for (const word of plain.split(' ')) {
    if (out && out.length + 1 + word.length > max) return `${out}…`;
    out = out ? `${out} ${word}` : word;
  }
  return out;
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

// Case- and accent-insensitive text for matching ("Café" finds "cafe").
const fold = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** History entries whose title or last answer contain every word of the query (all of them when it is blank). */
export function filterConversations(list, query = '') {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const entries = Array.isArray(list) ? list : [];
  if (!words.length) return entries;
  return entries.filter(entry => {
    const hay = fold(`${entry?.title || ''} ${entry?.preview || ''}`);
    return words.every(word => hay.includes(word));
  });
}

/** A one-line preview of an answer for lists: citations, links and Markdown marks removed. */
export function plainPreview(value) {
  return text(value).replace(CITATION, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>~|]+/g, '')
    .replace(/\s+/g, ' ').replace(/ ([.,;:!?])/g, '$1').trim();
}

/** The answer the sources pane describes: the latest assistant message that has text or is still being written. */
export function latestAnswer(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index--) {
    const message = list[index];
    if (message?.role === 'assistant' && (message.text || message.live)) return message;
  }
  return null;
}

/** The question still waiting for an answer: the last message, when it is a question (an answer elsewhere, or none yet). */
export function unansweredQuestion(messages) {
  const last = Array.isArray(messages) ? messages.at(-1) : null;
  return last?.role === 'user' ? last : null;
}

/**
 * A whole conversation as Markdown for copying, downloading or saving as a note. Questions are quoted with "You", answers
 * follow as written with their citations turned into links (exportAnswer); answers that failed say so in italics.
 */
export function conversationMarkdown(conversation, { links = 'markdown', isItem = () => true, title = true } = {}) {
  const parts = [];
  const name = cleanTitle(conversation?.title);
  if (title) parts.push(`# ${name || 'Assistant chat'}`);
  for (const message of conversation?.messages || []) {
    if (message?.role === 'user') {
      const lines = text(message.text).trim().split('\n');
      parts.push([`> **You:** ${lines[0]}`, ...lines.slice(1).map(line => line.trim() ? `> ${line}` : '>')].join('\n'));
    } else if (message?.role === 'assistant') {
      const answer = exportAnswer(message.text, message.citations || [], { links, isItem }).trim();
      if (answer) parts.push(answer);
      else if (message.error && message.error !== 'Stopped') parts.push(`_The answer did not finish: ${text(message.error).trim()}_`);
    }
  }
  return `${parts.join('\n\n')}\n`;
}

/** A safe file name for a downloaded chat: the title in lowercase words joined by hyphens, at most 60 characters. */
export function markdownFileName(title) {
  const base = fold(cleanTitle(title)).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return `${base || 'assistant-chat'}.md`;
}

/** The id of the open conversation, or of the one the running answer is creating. */
export const conversationIdOf = s => s?.conversation?.id || s?.run?.conversationId || '';
/** The open conversation when it is a research run (its composer asks the research agent, not the chat model). */
export const researchOf = s => !s?.run && isResearchConversation(s?.conversation) ? s.conversation : null;

/**
 * The empty state's promise about library changes, true to the assistant permissions (Settings > Assistant
 * permissions): changes wait for approval unless some kinds are allowed to apply at once.
 */
export function approvalNote(settings) {
  return allowedCategories(settings?.assistantPermissions).length ? 'Answers cite the items they come from. Changes your assistant permissions allow apply right away, and you can undo them.'
    : 'Answers cite the items they come from. Changes to your library always wait for your approval.';
}
const newConversationId = () => `conversation_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;

// ------------------------------------------------------------------------------------------------ state

// Live per-proposal UI state (resolver, Review exclusions, receipt, undo); proposal ids are unique across conversations.
const proposalUi = new Map();
let transcript = null;
let runSeq = 0;

// The shared state lives in ai-state.js, so the research view reads it without importing this module.
const st = aiState;

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
// An AI thread an answer cites that is not a live saved item: from the engine's early 'sources' event while the answer
// streams, then from the saved citation (which keeps its thread key).
const threadSourceOf = (message, id) => (message?.citations || []).find(source => source?.id === id && source.kind === 'ai_thread')
  || (message?.threadSources || []).find(source => source?.id === id && source.kind === 'ai_thread') || null;
const isThreadCitation = source => source?.kind === 'ai_thread' && typeof source.threadKey === 'string' && !!source.threadKey;
// A cited AI thread: opens the chat when it is saved in Still; otherwise a menu offers to import it (the user's own
// click, so a chat they deleted earlier can come back) or to open it in Threadkeeper.
async function openThreadCitation(ctx, el, { id, threadKey }) {
  const key = threadKey || threadMessages(st(ctx)).flatMap(message => message.citations || []).find(source => source?.id === id && source.threadKey)?.threadKey || '';
  let resolved = null;
  try { resolved = await ctx.ai?.resolveThreadCitation?.({ id, threadKey: key }); } catch { resolved = null; }
  if (resolved?.itemId) { ctx.openItem(resolved.itemId); return; }
  if (!resolved?.canImport && !resolved?.canOpen) { ctx.toast('This AI thread is not saved in Still, and Threadkeeper is not connected right now.'); return; }
  const target = { id, threadKey: resolved.threadKey || key };
  ctx.openMenu(el, [
    ...(resolved.canImport ? [{ label: 'Import to Still', icon: 'download', run: async () => {
      try {
        const { itemId } = await ctx.ai.importThreadCitation(target);
        ctx.toast('Chat imported', { action: { label: 'Open', run: () => ctx.openItem(itemId) } });
      } catch (error) { ctx.toast(text(error?.message) || 'This thread could not be imported.'); }
    } }] : []),
    ...(resolved.canOpen ? [{ label: 'Open in Threadkeeper', icon: 'external-link', run: async () => {
      try { await ctx.ai.openThreadInThreadkeeper(target.threadKey); } catch (error) { ctx.toast(text(error?.message) || 'Threadkeeper could not open this thread.'); }
    } }] : []),
  ]);
}
let warmedAt = 0;
// Wakes Threadkeeper when the assistant shows (at most every two minutes), so the first question does not wait for it.
function warmThreads(ctx) {
  if (typeof ctx.ai?.warmThreads !== 'function' || Date.now() - warmedAt < 120000) return;
  warmedAt = Date.now();
  ctx.ai.warmThreads().catch?.(() => {});
}
// The full-screen assistant: the 'assistant' view of a full tab or the new tab (the side panel shows the Ask tab instead).
const onPage = ctx => !ctx.env.isSidepanel && ctx.state.view === 'assistant';
const aiVisible = ctx => ctx.env.isSidepanel ? ctx.state.panel?.kind === 'ai' || (!ctx.state.panel && ctx.state.sideTab === 'ask')
  : ctx.state.panel?.kind === 'ai' || onPage(ctx);
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
    s.modelNotice = false;
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
  const research = researchOf(s);
  if (research) return submitResearch(ctx, research, value, { fromDraft: question === undefined });
  // Said next to the composer, not in a toast: a toast sits over the composer's end and its Send button.
  // A trailing no-break space on every other send changes the live region's text, so each Enter is announced again.
  if (s.target === null) { s.modelNotice = true; announce(ctx, s.announce === MODEL_NOTICE ? `${MODEL_NOTICE}\u00a0` : MODEL_NOTICE); ctx.render(); return null; }
  const access = requestModelAccess(ctx);
  const replaceFrom = replace ?? s.editing?.messageId ?? null;
  const fromDraft = question === undefined;
  if (fromDraft) { s.draft = ''; const input = composer(); if (input) input.value = ''; }
  s.editing = null;
  s.pagePermission = null;
  s.browserNotice = null;
  return startRun(ctx, { question: value, scope: scope || contextFor(ctx).scope, replaceFrom, access, fromDraft });
}

/**
 * A follow-up in a research conversation goes to the research agent (continueResearch), never to the chat model, so
 * no chat model is needed. Like submit, call it from the click or key press: host access is asked for first.
 */
function submitResearch(ctx, conversation, value, { fromDraft = true } = {}) {
  const s = st(ctx);
  if (s.researchSending || researchState(conversation).running) return null;
  if (typeof ctx.ai.continueResearch !== 'function') { ctx.toast('Research is not available in this version of Still.'); return null; }
  const access = requestResearchAccess(ctx);
  const restore = () => {
    if (!fromDraft || s.draft) return;
    s.draft = value;
    const input = composer();
    if (input) input.value = value;
  };
  if (fromDraft) { s.draft = ''; const input = composer(); if (input) input.value = ''; }
  s.researchSending = true;
  if (transcript) transcript.stick = true;
  announce(ctx, 'Sending to the research agent');
  bump(ctx, { render: true });
  // Allow access is a new click: the question waiting in the composer is sent from there.
  const retry = () => submitResearch(ctx, conversation, value, { fromDraft: s.draft.trim() === value });
  return (async () => {
    try {
      if (!(await access)) {
        restore();
        handleResearchError(ctx, { code: 'permission' }, { allow: retry, openSettings });
        return;
      }
      await ctx.ai.continueResearch(conversation.id, value);
      announce(ctx, 'The research continues.');
    } catch (error) {
      restore();
      handleResearchError(ctx, error, { allow: retry, openSettings });
    } finally {
      s.researchSending = false;
      bump(ctx, { render: true });
    }
  })();
}

async function startRun(ctx, { question, scope, replaceFrom, access, fromDraft }) {
  const s = st(ctx);
  const id = `run-${++runSeq}`;
  // A new chat gets its id now, so the conversation (saved with the question before the answer starts) can be opened
  // elsewhere while the answer is still being written.
  const run = { id, controller: new AbortController(), question, scope, lastEvent: '', thinkingStartedAt: 0, thinkingMs: 0, notes: [], startedAt: Date.now(),
    conversationId: s.conversation?.id || newConversationId(),
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
      conversationId: run.conversationId, input: question, context: prepared.context, signal: run.controller.signal,
      connectionId: t.connectionId, model: t.model, effort: t.efforts?.length ? t.effort : undefined,
      onEvent: event => onEvent(ctx, run, event), onProposal: proposal => onProposal(ctx, run, proposal),
      browser: browserHint(ctx), onBrowserPrompt: prompt => onBrowserPrompt(ctx, run, prompt), onBrowserWithdrawn: id => onBrowserWithdrawn(ctx, run, id),
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
      // Any tool that read thread text (get_items or search_library on a chat, the AI thread tools) says so on its event.
      if (event.usedThreads === true || /_ai_threads$/.test(text(event.name))) m.usedThreads = true;
      break;
    case 'proposal':
      registerProposal(run, event.proposal);
      // Changes the assistant permissions allow apply at once (lib/ai/tools.js): no card waits for a decision.
      if (event.proposal?.autoApproved) {
        const ui = proposalUi.get(event.proposal.id);
        if (ui?.status === 'pending') ui.status = 'applying';
        announce(ctx, 'Applying changes your assistant permissions allow.');
      } else announce(ctx, 'Proposed changes are waiting for your review.');
      render = true;
      break;
    case 'proposal_result':
      proposalResult(ctx, run, event);
      render = true;
      break;
    case 'citations':
      m.citations = Array.isArray(event.items) ? event.items : [];
      break;
    case 'sources':
      // AI threads in this answer's context: their [[tk:…]] citations render while the answer streams.
      m.threadSources = (Array.isArray(event.items) ? event.items : []).filter(source => source && typeof source.id === 'string');
      m.usedThreads = true;
      break;
    case 'browser':
      // What the assistant did in browser tabs, and the steps it could not confirm (lib/ai/browser-tools.js).
      m.browser = { activity: Array.isArray(event.activity) ? event.activity : [], ...(Array.isArray(event.unverified) && event.unverified.length ? { unverified: event.unverified } : {}) };
      render = true;
      break;
    case 'web_seen':
      // The provider started a web search: text from the web may be in the answer from here on, so the part still
      // being written is shown without remote images, like the finished answer.
      m.usedThreads = true;
      render = true;
      break;
    case 'web_sources':
      // The web pages a provider-side search used for this answer (lib/ai/web-search.js).
      m.webSources = mergeWebSources(event.items);
      m.usedThreads = true;
      render = true;
      break;
    case 'browser_permission':
      // Browser automation is on, but Chrome has not given Still the tab permissions: the composer offers to ask.
      st(ctx).browserNotice = { permissions: (Array.isArray(event.permissions) ? event.permissions : []).filter(name => BROWSER_PERMISSIONS.includes(name)) };
      render = true;
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

// excluded: the item ids unchecked in Review. One id leaves every change it is in, as the engine applies it.
const newProposalUi = () => ({ open: false, excluded: new Set() });

function registerProposal(run, proposal) {
  if (!proposal?.id) return;
  const ui = proposalUi.get(proposal.id) || newProposalUi();
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
  const ui = proposalUi.get(event.proposalId) || newProposalUi();
  proposalUi.set(event.proposalId, ui);
  ui.resolve = null;
  ui.status = event.status;
  ui.error = text(event.error);
  const record = run.message.proposals.find(entry => entry.id === event.proposalId);
  if (record) record.status = event.status;
  if (event.status === 'applied') {
    ui.undo = typeof event.undo === 'function' ? event.undo : null;
    // The engine left the excluded items out before applying; the ids it reports are what the receipt counts.
    if (Array.isArray(event.excluded)) {
      const excluded = unique(event.excluded);
      if (record) record.excluded = excluded;
      ui.lines = excluded.length && record ? appliedLines(record, excluded) : null;
    }
    announce(ctx, event.autoApproved || record?.autoApproved ? 'Changes applied automatically. You can undo them.' : 'Changes applied.');
  } else if (event.status === 'failed') announce(ctx, `Changes failed: ${ui.error || 'nothing was changed.'}`);
}

// ---- browser cards (ui/ai-browser.js draws them) ----

/**
 * The tab the assistant starts from and whether the view follows it. Beside a web page (the side panel) the assistant
 * works in that tab and the browser shows what it does; in a full tab it opens its own tabs behind this one.
 */
function browserHint(ctx) {
  const page = ctx.state.page;
  const beside = !!ctx.env?.isSidepanel && !!ctx.env?.isExtension;
  const web = /^https?:\/\//i.test(text(page?.url));
  return { tabId: beside && web && Number.isInteger(page?.tabId) ? page.tabId : null, reveal: beside };
}

// The answers each kind of card takes, and what each leaves on the card.
const CARD_ANSWERS = { confirm: ['approve', 'approve-remember', 'decline'], handover: ['given-back', 'cancelled'], ask: ['continue', 'cancel'] };
const CARD_STATUS = { approve: 'approved', 'approve-remember': 'remembered', decline: 'declined', continue: 'continued', cancel: 'cancelled', 'given-back': 'done', cancelled: 'cancelled' };

/** A card the browser tools wait on. Resolves with the person's answer; a card nobody answers is withdrawn by the engine. */
function onBrowserPrompt(ctx, run, prompt) {
  return new Promise(resolve => {
    const type = ['confirm', 'ask', 'handover'].includes(prompt?.type) ? prompt.type : 'confirm';
    const card = { id: text(prompt?.id) || `card-${Date.now()}`, type, request: prompt?.request && typeof prompt.request === 'object' ? prompt.request : {}, status: 'pending', resolve };
    run.message.browserCards = [...(run.message.browserCards || []).filter(entry => entry.id !== card.id), card];
    if (transcript) transcript.stick = true;
    announce(ctx, type === 'confirm' ? 'The assistant is waiting for your approval.' : 'The assistant is waiting for you.');
    bump(ctx, { render: true });
  });
}

function onBrowserWithdrawn(ctx, run, id) {
  const card = (run.message.browserCards || []).find(entry => entry.id === id);
  if (!card || card.status !== 'pending') return;
  card.status = 'withdrawn';
  card.resolve = null;
  bump(ctx, { render: true });
}

/** Answers a waiting card. "Always allow on this site" also saves the rule: the running session already has it. */
function answerBrowserCard(ctx, id, answer) {
  const s = st(ctx);
  const card = (s.run?.message?.browserCards || []).find(entry => entry.id === id);
  if (!card?.resolve) return;
  let value = card.type === 'ask' ? (answer && typeof answer === 'object' ? answer : { outcome: answer === 'continue' ? 'continue' : 'cancel' }) : answer;
  // "Always allow" is only an answer where the card offered it.
  if (value === 'approve-remember' && !(card.request?.canRemember === true && text(card.request?.site))) value = 'approve';
  const key = card.type === 'ask' ? value.outcome : value;
  if (!CARD_ANSWERS[card.type]?.includes(key)) return;
  const resolve = card.resolve;
  card.resolve = null;
  card.status = CARD_STATUS[key];
  resolve(value);
  if (card.type === 'confirm' && value === 'approve-remember') rememberSite(ctx, text(card.request?.site));
  announce(ctx, { approved: 'Allowed.', remembered: 'Allowed, and remembered for this site.', declined: 'Not allowed.', continued: 'Continuing.', done: 'Continuing.', cancelled: 'Cancelled.' }[card.status] || '');
  bump(ctx, { render: true });
}

async function rememberSite(ctx, site) {
  const s = st(ctx);
  if (!site || typeof ctx.ai?.setAiSettings !== 'function') return;
  try {
    const current = (await ctx.ai.getAiSettings())?.browser;
    s.settings = await ctx.ai.setAiSettings({ browser: { sites: withSiteRule(current, site, 'allow').sites } });
  } catch (error) {
    console.error(error);
    ctx.toast('The rule for this site could not be saved, so it will ask again next time.', { tone: 'warning' });
  }
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
  // A research request's Allow access notice belongs to the chat it was shown in.
  Object.assign(s, { conversation: null, editing: null, pagePermission: null, researchAccess: null, added: [] });
  ctx.closePopover?.({ restore: false });
  bump(ctx, { render: true });
  if (focus) ctx.nextFrame(() => composer()?.focus({ preventScroll: true }));
}

async function openConversation(ctx, id) {
  const s = st(ctx);
  ctx.closePopover?.({ restore: false });
  if (s.conversation?.id === id && !s.run) return;
  // The answer being written is this conversation's: it is already open.
  if (s.run && conversationIdOf(s) === id) return;
  const conversation = await ctx.ai.getConversation(id);
  if (!conversation) { ctx.toast('That conversation is no longer on this device.'); refreshHistory(ctx); return; }
  if (s.run && isResearchConversation(conversation)) {
    // Research runs on its own, so opening it never aborts the answer this view is writing: it is offered in a new tab
    // instead (and opens here from the history once the answer is done).
    ctx.toast('This answer is still being written. Open the research in a new tab?', { action: { label: 'Open in new tab', run: () => openResearchTab(ctx, id) } });
    return;
  }
  if (s.run) { stopRun(ctx); s.run = null; }
  const scope = conversation.scope;
  let explicit = null;
  if (scope?.scope === 'page') explicit = scope.page?.url && scope.page.url === ctx.state.page?.url ? { scope: 'page' } : null;
  else if (scope && scope.scope !== 'library') explicit = { scope: scope.scope, ids: scope.ids || [], collectionId: scope.collectionId || '' };
  Object.assign(s, { conversation, editing: null, pagePermission: null, researchAccess: null, added: [], explicit });
  if (transcript) transcript.stick = true;
  bump(ctx, { render: true });
  ctx.nextFrame(() => composer()?.focus({ preventScroll: true }));
}

async function refreshHistory(ctx, { quiet = false } = {}) {
  const s = st(ctx);
  if (!ctx.ai?.listConversations) return;
  try { s.history = await ctx.ai.listConversations(); s.historyError = false; }
  catch (error) { console.error(error); s.history = s.history || []; s.historyError = true; if (!quiet) ctx.toast('Your chat history could not be read.', { tone: 'danger' }); }
  if (popoverOpen(ctx, 'ai.history') || !quiet || onPage(ctx)) ctx.render();
}

function retry(ctx, assistantId) {
  const s = st(ctx);
  const messages = s.conversation?.messages || [];
  const index = messages.findIndex(message => message.id === assistantId);
  const question = index > 0 ? messages.slice(0, index).reverse().find(message => message.role === 'user') : null;
  return question ? askAgain(ctx, question) : null;
}

/** Asks a saved question again with the context it was asked with; the question and everything after it are replaced. */
function askAgain(ctx, question) {
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
  // On the full-screen assistant the page is the assistant: focus its composer instead of opening the panel beside it.
  else if (!onPage(ctx)) { ctx.state.panel = { kind: 'ai' }; ctx.syncUrl?.(); }
  if (scope) {
    const kind = scope === 'item' && unique(ids).length > 1 ? 'items' : scope;
    const explicit = { scope: kind, ids: unique(ids).slice(0, 200), collectionId: text(collectionId) };
    const current = s.conversation?.scope;
    const same = current && current.scope === kind && (current.collectionId || '') === explicit.collectionId && unique(current.ids).join() === explicit.ids.join();
    // A research conversation about the same item is not a chat: questions about the item start one.
    if (!s.run && s.conversation?.messages?.length && (!same || researchOf(s))) newChat(ctx, { focus: false });
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

/** Starts a new chat (the composer takes focus unless focus is false). */
export const newAiChat = (ctx, options) => newChat(ctx, options);
/** Opens a saved conversation by id. */
export const openAiConversation = (ctx, id) => openConversation(ctx, id);
/** Re-reads the chat history list (quiet: no toast when it cannot be read). */
export const refreshAiHistory = (ctx, options) => refreshHistory(ctx, options);
/** The shared assistant state (conversation, run, draft, history, context, model target); see ai-state.js. */
export { aiState, assistantUrl };
/** The context the next question is asked with: { kind, chips, scope } (see resolveContext). */
export const aiContext = ctx => contextFor(ctx);
/** Label, tooltip and glyph for a context chip. */
export const contextChipView = (ctx, chip) => chipView(ctx, chip);
/** A removable context chip, as the composer shows it. */
export const renderContextChip = (ctx, chip) => renderChip(ctx, chip);
/** Sources cited by a message, numbered as in the answer ([{ n, id, title, url }]). */
export const citationsOf = (ctx, message) => citationsFor(ctx, message);

/** Loads the chat history once (the full-screen assistant lists it beside the conversation). */
export function ensureAiHistory(ctx) {
  const s = st(ctx);
  if (s.history !== null || s.historyLoading || !ctx.ai?.listConversations) return;
  s.historyLoading = true;
  refreshHistory(ctx, { quiet: true }).finally(() => { s.historyLoading = false; });
}

/**
 * Sets what the next question is about without starting a new chat: { scope: 'library' } | { scope: 'collection',
 * collectionId } ('' is Inbox) | { scope: 'items', ids }. Items added with "+" are cleared.
 */
export function setAiScope(ctx, scope = { scope: 'library' }) {
  const s = st(ctx);
  s.added = [];
  if (scope.scope === 'collection') s.explicit = { scope: 'collection', ids: [], collectionId: text(scope.collectionId) };
  else if (['item', 'items'].includes(scope.scope) && unique(scope.ids).length) {
    const ids = unique(scope.ids).slice(0, 200);
    s.explicit = { scope: ids.length === 1 ? 'item' : 'items', ids, collectionId: '' };
  } else s.explicit = null; // the whole library is what is left without explicit context on the full-screen assistant
  ctx.render();
}

/**
 * Renames a saved conversation; returns the saved title, or null when the name is blank or the chat is gone. While an
 * answer or a research run is writing the open conversation, the stored copy is renamed (the run adopts the new title
 * when it next saves), never the copy the run is still changing.
 */
export async function renameAiConversation(ctx, id, name) {
  const s = st(ctx);
  const title = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!title || !ctx.ai?.getConversation) return null;
  const busy = !!s.run || isResearchRunning(s.conversation);
  const conversation = s.conversation?.id === id && !busy ? s.conversation : await ctx.ai.getConversation(id);
  if (!conversation) return null;
  if (conversation.title === title) return title;
  const saved = await ctx.ai.saveConversation({ ...conversation, title });
  // A research run this page drives hands out its own copy with every event: renamed in place, the header keeps the new
  // name until the run's next save adopts it.
  if (s.conversation?.id === id) s.conversation = isResearchRunning(s.conversation) ? Object.assign(s.conversation, { title: saved.title }) : { ...s.conversation, title: saved.title };
  await refreshHistory(ctx, { quiet: true });
  ctx.render();
  return saved.title;
}

/** Copies, downloads or saves the open conversation as Markdown: how = 'copy' | 'download' | 'note'. */
export async function exportConversation(ctx, how) {
  const s = st(ctx);
  const conversation = s.conversation;
  if (!conversation?.messages?.length) { ctx.toast('Ask a question first. There is nothing to export yet.'); return; }
  const isItem = id => !!liveItem(ctx, id);
  if (how === 'note') {
    const content = conversationMarkdown(conversation, { links: 'wiki', isItem, title: false });
    const title = cleanTitle(conversation.title).slice(0, 120) || 'Assistant chat';
    const relatedIds = unique(conversation.messages.flatMap(message => (message.citations || []).map(source => source.id))).filter(isItem);
    let note = await createNote(ctx, { title, content, relatedIds, open: false });
    if (!note) note = await ctx.store.saveItem({ type: 'note', title, content, relatedIds, tags: [] });
    if (note?.id) ctx.toast('Saved the chat as a note', { tone: 'success', action: { label: 'Open', run: () => ctx.openItem(note.id) } });
    return;
  }
  const markdown = conversationMarkdown(conversation, { isItem });
  if (how === 'download') {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: markdownFileName(conversation.title) });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ctx.toast('Downloaded the chat as a Markdown file');
    return;
  }
  await navigator.clipboard.writeText(markdown);
  ctx.toast('Copied the chat as Markdown');
}

/**
 * Opens the full-screen assistant on the same conversation: in place from the full tab's panel, in a new tab from the side
 * panel (the conversation is saved first; an answer still being written there appears in the tab when it finishes).
 */
async function openFullScreen(ctx) {
  const s = st(ctx);
  if (!ctx.env.isSidepanel) {
    ctx.state.panel = null;
    ctx.navigate('assistant');
    ctx.nextFrame(() => composer()?.focus({ preventScroll: true }));
    return;
  }
  const id = conversationIdOf(s);
  if (s.conversation?.id && !s.run && ctx.ai?.saveConversation) {
    try { s.conversation = await ctx.ai.saveConversation(s.conversation); } catch (error) { console.error(error); }
  }
  const url = assistantUrl(id);
  if (ctx.env.isExtension && globalThis.chrome?.tabs?.create) await chrome.tabs.create({ url, active: true });
  else window.open(url, '_blank', 'noopener');
}

// ------------------------------------------------------------------------------------------------ cross-page sync

// Conversations are shared by every Still page (the side panel, full tabs, new tabs): when another page saves the open
// conversation or the history list, this page follows, unless it is writing an answer itself.
let historyTimer = 0;
function onConversationsChanged(ctx, changes) {
  const s = st(ctx);
  if (CONVERSATIONS_KEY in changes && s.history !== null) {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => refreshHistory(ctx, { quiet: true }), 150);
  }
  const id = s.conversation?.id;
  const change = id ? changes[CONVERSATION_BODY_PREFIX + id] : null;
  if (change && !s.run) followConversation(ctx, id, change.newValue);
}

async function followConversation(ctx, id, value) {
  const s = st(ctx);
  if (value === undefined || value === null) {
    if (s.conversation?.id !== id || s.run) return;
    newChat(ctx, { focus: false });
    announce(ctx, 'This chat was deleted in another window.');
    ctx.render();
    return;
  }
  const current = s.conversation;
  if (!current || current.id !== id) return;
  if (value.updatedAt === current.updatedAt && value.title === current.title && (value.messages || []).length === current.messages.length) return;
  const conversation = await ctx.ai?.getConversation?.(id);
  if (!conversation || s.run || s.conversation?.id !== id) return;
  // A research run saves its progress about once a second: only a new message scrolls to the end, so the conversation
  // can be read while it grows (the transcript still follows the end while it is scrolled there).
  const grew = (conversation.messages || []).length > (s.conversation.messages || []).length;
  s.conversation = conversation;
  if (transcript && grew) transcript.stick = true;
  bump(ctx, { render: true });
}

// The page that drives a research run hears every event (live text included) before it reaches storage: the open
// conversation follows the run's own copy. Only a change the bar or header shows (status, any step's state or label,
// writes, cost, a message) redraws the page; streamed text repaints the transcript alone.
const researchSignature = conversation => {
  const research = conversation?.research || {};
  const meta = latestResearchMessage(conversation)?.research || {};
  const steps = (Array.isArray(meta.steps) ? meta.steps : []).map(step => `${step?.id}:${step?.state}:${step?.label}`).join('|');
  return [research.status, research.reason, research.error, research.undoneAt, research.writes, meta.writes, conversation?.title, conversation?.messages?.length,
    research.usage?.costUsd, (research.pages || []).length, steps].join('|');
};

function followResearch(ctx, event) {
  const s = st(ctx);
  const conversation = event?.conversation;
  if (event?.type !== 'research' || !isResearchConversation(conversation) || s.run || s.conversation?.id !== event.conversationId) return;
  const signature = researchSignature(conversation);
  const count = (conversation.messages || []).length;
  // The run changes its copy in place, so the open conversation can be the event's very object: the message count seen
  // last is kept apart, and a new turn still scrolls into view.
  const known = s.conversation === conversation && Number.isInteger(s.researchMessageCount) ? s.researchMessageCount : (s.conversation.messages || []).length;
  const redraw = s.conversation !== conversation || signature !== s.researchSignature;
  if (count > known && transcript) transcript.stick = true;
  s.conversation = conversation;
  s.researchSignature = signature;
  s.researchMessageCount = count;
  bump(ctx, { render: redraw });
}

function watchConversations(ctx) {
  const storage = globalThis.chrome?.storage;
  if (storage?.onChanged) {
    storage.onChanged.addListener((changes, area) => { if (area === 'local') onConversationsChanged(ctx, changes); });
    return;
  }
  // Preview (no chrome.*): conversations live in localStorage, whose 'storage' event reaches the other open pages.
  globalThis.addEventListener?.('storage', event => {
    if (!event.key || !(event.key === CONVERSATIONS_KEY || event.key.startsWith(CONVERSATION_BODY_PREFIX))) return;
    let newValue;
    try { newValue = event.newValue === null ? undefined : JSON.parse(event.newValue); } catch { return; }
    onConversationsChanged(ctx, { [event.key]: { newValue } });
  });
}

export async function init(ctx) {
  const s = st(ctx);
  // Module init runs once the engine import has settled: from here a missing ctx.ai means it failed to load.
  s.engineSettled = true;
  if (!ctx.ai) { ctx.render(); return; }
  try { ctx.ai.onConnectionsChanged?.(() => refreshTarget(ctx)); } catch (error) { console.error(error); }
  try { watchConversations(ctx); } catch (error) { console.error(error); }
  try { ctx.ai.subscribeResearch?.(event => followResearch(ctx, event)); } catch (error) { console.error(error); }
  await refreshTarget(ctx);
  if (s.target === undefined) s.target = null;
}

// ------------------------------------------------------------------------------------------------ rendering: panel

/**
 * The assistant: header, transcript (or the empty / setup state) and the composer. surface: 'side' | 'full' | 'page'.
 * The full-screen page draws its own header (head: markup or '') and empty state (empty: (ctx, resolved) => markup).
 */
export function renderAiPanel(ctx, { surface = ctx.env?.isSidepanel ? 'side' : 'full', head, empty = renderEmpty } = {}) {
  const s = st(ctx);
  const ready = !!ctx.ai;
  const hasThread = !!(s.conversation?.messages?.length || s.run);
  const resolved = contextFor(ctx);
  const research = ready ? researchOf(s) : null;
  watchStale(ctx, research);
  if (ready) warmThreads(ctx);
  return html`<section class="ai-panel" data-surface="${surface}" aria-label="Assistant">
    ${head === undefined ? renderHead(ctx, surface, hasThread) : head}
    ${research ? renderResearchBar(ctx, research) : ''}
    ${!ready ? s.engineSettled ? html`<div class="ai-scroll ai-start" data-key="ai.unavailable">${emptyState({ icon: 'sparkles', title: 'The assistant is not available',
      body: 'Still could not load its AI engine. Reload Still to try again.', actions: button({ label: 'Reload', icon: 'refresh-cw', action: 'app.retry-boot', size: 'sm' }) })}</div>`
      : html`<div class="ai-scroll ai-start" data-key="ai.loading" aria-busy="true"></div>`
      : hasThread ? html`<div class="ai-scroll ai-thread" data-mount="ai.transcript" data-morph="skip" data-key="ai.transcript" role="region" aria-label="Conversation" tabindex="-1"></div>`
        // While the model connection is still being read, show nothing rather than suggestions that may turn into the setup.
        : html`<div class="ai-scroll ai-start" data-key="ai.start" ${s.target === undefined ? raw('aria-busy="true"') : ''}>${s.target === null ? renderSetup(ctx, resolved)
          : s.target === undefined ? '' : empty(ctx, resolved)}</div>`}
    ${ready || !s.engineSettled ? renderDock(ctx, resolved) : ''}
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
    ${iconButton({ icon: 'maximize', label: 'Open full screen', action: 'ai.open-page', disabled: !ctx.ai, tooltipPlacement: surface === 'side' ? 'bottom end' : undefined })}
    ${surface === 'full' ? html`${iconButton({ icon: expanded ? 'chevrons-right-left' : 'chevrons-left-right', label: expanded ? 'Narrow the panel' : 'Widen the panel', action: 'ai.expand', pressed: expanded, tooltipPlacement: 'bottom end' })}
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
        : approvalNote(s.settings);
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
  const research = ctx.ai ? researchOf(s) : null;
  const researching = !!research && researchState(research).running;
  const running = !!s.run || researching;
  const length = s.draft.length;
  const over = length > MAX_QUESTION;
  // A research follow-up goes to the research agent, so it needs no chat model.
  const canSend = !running && !s.researchSending && !!s.draft.trim() && !over && (!!research || s.target !== null);
  const stop = research ? html`<button type="button" class="ai-send is-stop" data-action="ai.stop" aria-label="Stop the research" data-tooltip="Stop the research">${icon('square', { size: 12 })}</button>`
    : html`<button type="button" class="ai-send is-stop" data-action="ai.stop" aria-label="Stop" data-tooltip="Stop (Esc)" aria-keyshortcuts="Escape">${icon('square', { size: 12 })}</button>`;
  return html`<div class="ai-dock">
    ${s.researchAccess ? renderResearchNotice(ctx) : ''}
    ${s.pagePermission ? renderPageNotice(ctx) : ''}
    ${s.browserNotice && !research ? renderBrowserNotice(s.browserNotice) : ''}
    ${s.modelNotice && s.target === null && !research ? renderModelNotice({ handoffs: !!(s.conversation?.messages?.length || s.run) }) : ''}
    <form class="${cx('ai-composer', running && 'is-running', research && 'is-research')}" data-submit="ai.send" aria-label="${research ? 'Ask the research agent' : 'Ask the assistant'}">
      <div class="ai-chips" role="list" aria-label="Context">${research ? renderResearchChip(ctx, research) : resolved.chips.map(chip => renderChip(ctx, chip))}</div>
      ${s.editing ? html`<div class="ai-editing">${icon('pencil', { size: 12 })}<span>Editing your last question</span>
        <button type="button" class="ai-editing-cancel" data-action="ai.edit-cancel">Cancel</button></div>` : ''}
      <textarea class="ai-input" id="ai-input" data-focus-key="ai-input" name="prompt" rows="1" aria-label="Message" aria-describedby="ai-footnote"
        placeholder="${research ? researching ? 'The research is running. Ask for more once it ends.' : 'Ask the research agent for more' : placeholderFor(ctx, resolved)}"
        data-input="ai.draft" data-keydown="ai.key" spellcheck="true">${s.draft}</textarea>
      <div class="ai-composer-foot">
        ${research ? html`<span class="ai-model-btn is-static" data-tooltip="Claude Sonnet 5.5 with web search">${icon('telescope', { size: 12 })}<span class="ai-model-label">Research agent</span></span>`
          : html`${iconButton({ icon: 'plus', label: 'Add context', action: 'ai.add-context', size: 'sm', expanded: popoverOpen(ctx, 'ai.context') })}${renderModelButton(ctx)}${renderBrowserMode(ctx)}`}
        <span class="spacer"></span>
        ${length >= COUNT_FROM ? html`<span class="${cx('ai-count', over && 'is-over')}">${length.toLocaleString()} / ${MAX_QUESTION.toLocaleString()}</span>` : ''}
        ${running ? stop
          : html`<button type="submit" class="ai-send" aria-label="Send" data-tooltip="Send" aria-keyshortcuts="Enter" ${canSend ? '' : raw('disabled')} ${s.researchSending ? raw('aria-busy="true"') : ''}>${icon('arrow-up', { size: 16, strokeWidth: 2 })}</button>`}
      </div>
    </form>
    <p class="ai-footnote" id="ai-footnote">${icon('info', { size: 12 })}${research ? 'Follow-ups continue this research with Claude Sonnet 5.5 in your Anthropic account.' : footnote(ctx)}</p>
  </div>`;
}

function footnote(ctx) {
  const s = st(ctx);
  const t = s.target;
  if (t === null) return 'Connect a model to ask here. Another app opens your question in a new tab.';
  if (!t) return 'Retrieved items are included as context.';
  const model = t.modelLabel || t.model;
  if (t.via === 'agent' || t.via === 'bridge') return `Sent to ${t.label || t.providerName} through the local bridge${model ? ` · ${model}` : ''}. Retrieved items are included as context.`;
  if (t.local) return `Runs on this computer with ${t.providerName}${model ? ` · ${model}` : ''}. Retrieved items are included as context.`;
  // Web search is the person's own switch (Settings > AI models); it only does anything on a connection that has it.
  const web = s.settings?.webSearch?.enabled === true && t.via === 'direct' && webSearchKind({ provider: { id: t.providerId }, baseUrl: t.baseUrl }) ? ' It can search the web.' : '';
  return `Sent to ${t.providerName}${model ? ` · ${model}` : ''}. Retrieved items are included as context.${web}`;
}

// Shown only while browser automation is on (Settings > Browser automation) and the chosen model can use tools.
function renderBrowserMode(ctx) {
  const s = st(ctx);
  const browser = s.settings?.browser;
  if (!browser?.enabled || !s.target || (s.target.via && s.target.via !== 'direct')) return '';
  return renderBrowserModeButton({ mode: browser.mode, open: popoverOpen(ctx, 'ai.browser-mode'), disabled: !!s.run });
}

function renderModelButton(ctx) {
  const t = st(ctx).target;
  const label = t === undefined ? 'Model' : t === null ? 'No model' : shortModelLabel(t.modelLabel || t.model);
  const effort = t?.efforts?.length && t.effort ? ` · ${ctx.ai?.EFFORT_LABELS?.[t.effort] || t.effort} effort` : '';
  const tip = t ? `${t.providerName} · ${t.modelLabel || t.model}${effort}` : 'Choose a model';
  const open = popoverOpen(ctx, 'ai.model') && !!ctx.state.popover?.anchorEl?.classList?.contains('ai-model-btn');
  return html`<button type="button" class="ai-model-btn" data-action="ai.model" aria-haspopup="menu" aria-expanded="${open ? 'true' : 'false'}"
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

// A question sent with no model connected: where to connect one, or which app can take the question instead. handoffs:
// the app buttons, when the setup (which lists them) is not on screen because a chat is open.
const MODEL_NOTICE = 'Connect a model to ask here, or open your question in another app.';
function renderModelNotice({ handoffs = true } = {}) {
  return html`<div class="ai-notice" data-key="ai.model-notice">
    ${icon('plug', { size: 16 })}
    <div class="ai-notice-text"><p>${MODEL_NOTICE}</p>
      <div class="ai-notice-actions">${button({ label: 'Connect a model', variant: 'primary', size: 'sm', action: 'ai.settings' })}
        ${handoffs ? HANDOFFS.map(target => button({ label: `Ask ${target.label}`, iconRight: 'external-link', variant: 'ghost', size: 'sm', action: 'ai.handoff', data: { target: target.id } })) : ''}</div></div>
    ${iconButton({ icon: 'x', label: 'Dismiss', size: 'sm', action: 'ai.model-notice-dismiss' })}
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
  const waiting = s.run ? null : unansweredQuestion(messages);
  const research = researchOf(s);
  morph(el, html`${messages.map(message => message.role === 'user'
    ? renderQuestion(ctx, message, { last: message === lastUser })
    : research && message.research ? renderResearchAnswer(ctx, view, message, research, { last: message === lastAnswer })
      : renderAnswer(ctx, view, message, { last: message === lastAnswer }))}
    ${waiting ? renderUnanswered(ctx, waiting) : ''}`);
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

// A saved question without an answer: another window is still answering it, or that answer never finished.
function renderUnanswered(ctx, question) {
  return html`<div class="ai-unanswered" data-key="wait:${question.id}">
    <p class="ai-note">${icon('clock', { size: 14 })}<span>No answer here yet. If another window is answering, it appears when it finishes.</span></p>
    ${button({ label: 'Ask again', icon: 'refresh-cw', size: 'sm', action: 'ai.ask-again', data: { id: question.id } })}
  </div>`;
}

function renderQuestion(ctx, message, { last }) {
  const s = st(ctx);
  const about = scopeLabel(ctx, message.context);
  return html`<div class="ai-q" data-key="q:${message.id}">
    ${about ? html`<p class="ai-q-about">${about.glyph}<span>${about.label}</span></p>` : ''}
    <div class="ai-bubble">${message.text}</div>
    ${message.live ? '' : html`<div class="ai-q-actions">
      ${iconButton({ icon: 'copy', label: 'Copy', size: 'sm', action: 'ai.copy', data: { id: message.id } })}
      ${last && !s.run && !researchOf(s) ? iconButton({ icon: 'pencil', label: 'Edit', size: 'sm', action: 'ai.edit', data: { id: message.id } }) : ''}
    </div>`}
  </div>`;
}

function citationsFor(ctx, message) {
  if (message.citations?.length) return message.citations;
  const page = st(ctx).run?.scope?.page;
  return streamingCitations(message.text, id => id === 'page:current' ? page || null : liveItem(ctx, id) || threadSourceOf(message, id))
    .map(source => { const thread = threadSourceOf(message, source.id); return thread && !liveItem(ctx, source.id) ? { ...source, kind: 'ai_thread', threadKey: text(thread.threadKey) } : source; });
}

// Answers built on AI thread text show remote images as links (the thread text is untrusted and may point at trackers).
function renderMd(ctx, value, citations, { images = true } = {}) {
  return raw(numberCitations(renderMarkdown(value, { citations, ...(images ? {} : { images: false }) }), citations));
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
    // The key changes whenever the text does, so a stored answer that grows (followed from another window) repaints.
    const key = live ? `md:${message.id}:${from}:${part.length}${tail ? ':tail' : ''}` : `md:${message.id}:${from}:${part.length}:${signature}`;
    blocks.push(skipBlock(view, key, cx('ai-md markdown-body is-compact', tail && 'is-typing'), () => renderMd(ctx, part, citations, { images: !message.usedThreads })));
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
    ${(message.browserCards || []).map(card => renderBrowserCard(card))}
    ${live ? '' : renderUnverified(message.browser?.unverified)}
    ${live ? '' : renderWebSources(ctx, message)}
    ${(run?.notes || []).map(note => html`<p class="ai-note">${icon('info', { size: 14 })}<span>${note}</span></p>`)}
    ${showStatus ? html`<p class="ai-status"><span class="ai-shimmer">${statusLabel(message, run)}</span></p>` : ''}
    ${renderError(ctx, message, { last })}
    ${renderActions(ctx, message, { last, citations })}
  </article>`;
}

/**
 * One research turn (lib/ai/research/run.js): its progress timeline, the agent's Markdown (the finished messages, then
 * the message being written while the run is live), the subpages it created and how the turn ended. The stored message
 * grows while the run saves progress, so every Markdown key carries its text length (a new length repaints it). The
 * run's actions live in the research bar above the conversation. view: the transcript mount (null renders in full).
 */
function renderResearchAnswer(ctx, view, message, conversation, { last }) {
  const meta = message.research && typeof message.research === 'object' ? message.research : {};
  const live = !!meta.live && last && researchState(conversation).running;
  const finished = text(message.text);
  const preview = live && meta.preview && typeof meta.preview === 'object' ? text(meta.preview.text) : '';
  const block = (key, className, value) => view ? skipBlock(view, key, className, () => renderMd(ctx, value, []))
    : html`<div class="${className}" data-key="${key}">${renderMd(ctx, value, [])}</div>`;
  const error = text(message.error);
  return html`<article class="${cx('ai-a', 'is-research', live && 'is-live')}" data-key="a:${message.id}" aria-busy="${live ? 'true' : 'false'}">
    ${renderResearchSteps(ctx, message, { live })}
    ${finished.trim() ? block(`rmd:${message.id}:${finished.length}`, 'ai-md markdown-body is-compact', finished) : ''}
    ${preview.trim() ? block(`rpv:${message.id}:${text(meta.preview.id)}:${preview.length}`, 'ai-md markdown-body is-compact is-typing', preview) : ''}
    ${live && !finished.trim() && !preview.trim() ? html`<p class="ai-status"><span class="ai-shimmer">${(meta.steps || []).length ? 'Researching…' : 'Starting the research…'}</span></p>` : ''}
    ${renderSubpageChips(ctx, message)}
    ${error === 'Stopped' ? html`<p class="ai-stopped">${icon('circle-stop', { size: 14 })}<span>Stopped</span></p>`
      : error ? html`<div class="ai-error" role="alert">${icon('circle-alert', { size: 16 })}<div class="ai-error-text"><p>${error}</p></div></div>` : ''}
    ${!live && finished.trim() ? html`<div class="${cx('ai-actions', last && 'is-last')}" role="toolbar" aria-label="Answer actions">
      ${iconButton({ icon: 'copy', label: 'Copy', size: 'sm', action: 'ai.copy', data: { id: message.id } })}</div>` : ''}
  </article>`;
}

/** A research turn as the transcript draws it, outside the transcript mount (tests, previews). */
export const renderResearchMessage = (ctx, message, conversation, { last = true } = {}) => renderResearchAnswer(ctx, null, message, conversation, { last });

function statusLabel(message, run) {
  // A browser card is open: the answer goes on when the person has chosen.
  if ((message.browserCards || []).some(card => card.status === 'pending')) return 'Waiting for you…';
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
  if (tool.name === 'search_ai_threads' && query) return `Searched AI threads for “${query}”${Number.isFinite(count) ? ` · ${plural(count, 'result')}` : ''}`;
  // A browser step names page elements; they read as quotations.
  if (/^browser_/.test(tool.name) || tool.name === 'ask_user') return browserLine(tool.summary) || tool.name.replace(/_/g, ' ');
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

/**
 * The web pages an answer used, as links that open in a new tab. Addresses and titles come from the provider's search:
 * they are shown as text, and only web addresses are linked (mergeWebSources drops the rest). Each has the site's letter
 * tile, not its icon: these are pages the person has mostly never opened, and Chrome answers with a grey globe for those.
 */
function renderWebSources(ctx, message) {
  const sources = mergeWebSources(message.webSources);
  if (!sources.length) return '';
  const key = `web:${message.id}`;
  const all = st(ctx).open.has(key);
  const shown = all ? sources : sources.slice(0, 4);
  return html`<div class="ai-web-sources" data-key="${key}">
    <p class="ai-web-sources-title">${icon('globe', { size: 14 })}<span>From the web</span></p>
    <ul class="ai-web-sources-list" role="list">${shown.map(source => html`<li><a class="ai-web-source" href="${source.url}" target="_blank" rel="noopener noreferrer">
      ${favicon(source.url, { size: 16 })}<span class="ai-source-title">${source.title}</span><span class="ai-source-meta">${domainOf(source.url)}</span></a></li>`)}</ul>
    ${sources.length > 4 ? html`<button type="button" class="ai-tool-more" data-action="ai.toggle" data-open="${key}" aria-expanded="${all ? 'true' : 'false'}">
      ${all ? 'Show fewer' : `${plural(sources.length - 4, 'more source')}`}</button>` : ''}
  </div>`;
}

function sourceRow(ctx, item, n) {
  if (!item) return '';
  return html`<li><button type="button" class="ai-source" data-action="ai.cite" data-id="${item.id}">
    ${n ? html`<span class="ai-source-n">${n}</span>` : ''}${isWebUrl(item.url) ? siteIcon(item.url, { size: 16 }) : html`<span class="ai-source-icon">${icon(TYPE_ICONS[item.type] || 'file-text', { size: 14 })}</span>`}
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
  const sources = citations.filter(source => source.id === 'page:current' || liveItem(ctx, source.id) || isThreadCitation(source));
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
  ${showSources ? html`<ol class="ai-sources" role="list" data-key="src:${message.id}">${renderSourceRows(ctx, sources)}</ol>` : ''}`;
}

/**
 * Numbered rows for the sources that can still be opened: saved items, the page an answer read, and AI threads (which
 * open the saved chat, or offer to import the thread or open it in Threadkeeper).
 */
export function renderSourceRows(ctx, citations = []) {
  return citations.filter(source => source.id === 'page:current' || liveItem(ctx, source.id) || isThreadCitation(source)).map(source => source.id === 'page:current'
    ? html`<li><button type="button" class="ai-source" data-action="ai.cite" data-id="page:current" data-url="${source.url}"><span class="ai-source-n">${source.n}</span>${siteIcon(source.url, { size: 16 })}
      <span class="ai-source-title">${source.title || 'This page'}</span><span class="ai-source-meta">${domainOf(source.url)}</span></button></li>`
    : liveItem(ctx, source.id) ? sourceRow(ctx, liveItem(ctx, source.id), source.n)
      : html`<li><button type="button" class="ai-source" data-action="ai.cite" data-id="${source.id}" data-thread="${source.threadKey}"><span class="ai-source-n">${source.n}</span>
        <span class="ai-source-icon">${icon('messages-square', { size: 14 })}</span><span class="ai-source-title">${source.title || 'AI thread'}</span><span class="ai-source-meta">AI thread</span></button></li>`);
}

// ------------------------------------------------------------------------------------------------ rendering: proposals

function proposalStatus(proposal) {
  const ui = proposalUi.get(proposal.id);
  // Undone here or in another window (its saved conversation says so): that Undo is never offered again.
  if (ui?.undone || proposal.status === 'undone') return 'undone';
  return ui?.status || proposal.status || 'pending';
}

// After a reload, or in another window, the live undo is gone; the undo record saved with the proposal still reverts it.
const savedUndo = (ctx, proposal) => proposal?.status === 'applied' && !!proposal.undo && typeof proposal.undo === 'object'
  && typeof ctx.ai?.undoProposal === 'function';

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

const listJoin = list => list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] || '';
const andMore = (shown, total) => shown.length ? `${shown.join(', ')}${total > shown.length ? ` and ${(total - shown.length).toLocaleString()} more` : ''}` : '';
const capitalized = value => value ? value[0].toUpperCase() + value.slice(1) : value;

function uniqueTags(lists) {
  const seen = new Set();
  const out = [];
  for (const tag of lists.flat()) {
    const key = text(tag).toLowerCase();
    if (key && !seen.has(key)) { seen.add(key); out.push(text(tag)); }
  }
  return out;
}
const taggedWith = tags => tags.length ? `Tagged ${tags.slice(0, 6).map(tag => `#${tag}`).join(' ')}${tags.length > 6 ? ` and ${tags.length - 6} more` : ''}` : '';

// "Title (domain)" for a link to save; the domain alone when the title is missing or is just the domain.
function linkLine(entry) {
  const domain = domainOf(entry?.url);
  const title = text(entry?.title).replace(/\s+/g, ' ').trim();
  if (!title || title === domain) return domain || text(entry?.url);
  return domain ? `${title} (${domain})` : title;
}

function collectionPathName(ctx, id, created) {
  if (!id) return 'Inbox';
  const path = ctx.select?.path?.(id) || [];
  return path.length ? path.map(collection => collection.name).join(' › ') : created.get(id) || 'a new collection';
}

function reminderText(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? text(value) : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// The engine's label names the fields an edit changes ("Update “A”: link and note"); this line adds the new values that
// label leaves out: the address in full, exactly as it will be saved, a reminder's date, the new text.
function itemPatchSub(change) {
  const patch = change.patch && typeof change.patch === 'object' ? change.patch
    : Object.fromEntries(['title', 'excerpt'].filter(key => key in change).map(key => [key, change[key]]));
  const keys = Object.keys(patch);
  const several = keys.length > 1 && !(keys.length === 2 && 'title' in patch && 'excerpt' in patch);
  const parts = [];
  if (several && typeof patch.title === 'string') parts.push(`Title “${patch.title}”`);
  if (text(patch.url)) parts.push(patch.url);
  if (several && 'pinned' in patch) parts.push(patch.pinned ? 'Pinned' : 'Not pinned');
  if (several && 'read' in patch) parts.push(patch.read ? 'Read' : 'Unread');
  if ('reminderAt' in patch && (patch.reminderAt || several)) parts.push(patch.reminderAt ? `Reminder ${reminderText(patch.reminderAt)}` : 'No reminder');
  if (typeof patch.content === 'string') parts.push(noteSnippet(patch.content, 120));
  return parts.filter(Boolean).join(' · ');
}

// Likewise for a collection: the label names the fields (or says the one change); this line gives the new values.
function collectionPatchSub(ctx, change, created) {
  const patch = change.patch && typeof change.patch === 'object' ? change.patch : {};
  const several = Object.keys(patch).length > 1;
  const parts = [];
  if (several && typeof patch.name === 'string') parts.push(`Name “${patch.name}”`);
  if (several && 'parentId' in patch) parts.push(patch.parentId ? `Moves into ${collectionPathName(ctx, patch.parentId, created)}` : 'Moves to the top level');
  if (text(patch.icon)) parts.push(`Icon ${patch.icon}`);
  if (text(patch.color)) parts.push(`Color ${patch.color}`);
  if (several && 'pinned' in patch) parts.push(patch.pinned ? 'Pinned' : 'Not pinned');
  if (typeof patch.description === 'string') parts.push(patch.description.trim() ? `Description “${noteSnippet(patch.description, 80)}”` : 'No description');
  return parts.join(' · ');
}

// What deleting a collection does to what it holds (lib/store.js deleteCollection): its items go to the Inbox and its
// sub-collections move up one level.
function deleteCollectionSub(ctx, change) {
  const id = text(change.collectionId);
  const counted = Number.isFinite(change.itemCount) && Number.isFinite(change.childCount);
  if (!id || (!counted && !ctx.library)) return '';
  // The engine counts when it stages the change; an older record is counted from the library as it is now.
  const items = counted ? change.itemCount : (ctx.library.items || []).filter(item => item.collectionId === id && !item.deletedAt).length;
  const children = counted ? change.childCount : (ctx.library.collections || []).filter(collection => collection.parentId === id).length;
  const verb = count => count === 1 ? 'moves' : 'move';
  return [items ? `${plural(items, 'item')} ${verb(items)} to Inbox` : 'It holds no items',
    children ? `${plural(children, 'sub-collection')} ${verb(children)} up a level` : ''].filter(Boolean).join(' · ');
}

/**
 * The second line of a proposal row: the items, links or fields a change touches. Web addresses are shown whole.
 * out: item ids left out in Review; created: ids of collections this proposal creates -> their names.
 */
export function changeSub(ctx, change, out = new Set(), { created = new Map() } = {}) {
  const kept = list => (Array.isArray(list) ? list : []).filter(entry => entry && !out.has(entry.id));
  switch (change.op) {
    case 'move_items': {
      const counts = new Map();
      for (const id of (change.itemIds || []).filter(entry => !out.has(entry))) {
        const item = liveItem(ctx, id);
        if (!item) continue;
        const name = collectionName(ctx, item.collectionId || '');
        counts.set(name, (counts.get(name) || 0) + 1);
      }
      return counts.size ? `From ${[...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} (${n})`).join(', ')}` : '';
    }
    case 'save_links': {
      const links = kept(change.items?.length ? change.items : change.links);
      const tags = uniqueTags([change.tags || [], ...kept(change.links).map(link => link.tags || [])]);
      return [andMore(links.slice(0, 3).map(linkLine).filter(Boolean), changeCount(change) - out.size), taggedWith(tags)].filter(Boolean).join(' · ');
    }
    case 'update_item': return itemPatchSub(change);
    case 'link_items':
    case 'unlink_items': {
      const related = change.relatedIds || [];
      const titles = new Map((change.related || []).map(entry => [entry.id, text(entry.title)]));
      return andMore(related.slice(0, 3).map(id => text(liveItem(ctx, id)?.title) || titles.get(id) || '').filter(Boolean), related.length);
    }
    case 'update_collection': return collectionPatchSub(ctx, change, created);
    case 'delete_collection': return deleteCollectionSub(ctx, change);
    case 'add_dashboard_widget': return `Adds a links widget to ${text(change.boardName) ? `the ${change.boardName} board` : 'your dashboard'}`;
    case 'create_note': {
      const note = change.note || {};
      const sticky = note.sticky || change.sticky;
      const color = typeof sticky === 'string' ? sticky : text(sticky?.color);
      return [sticky ? `${color ? `${capitalized(color)} sticky` : 'Sticky'} note on the dashboard` : '', taggedWith(uniqueTags([note.tags || change.tags || []])),
        noteSnippet(note.markdown)].filter(Boolean).join(' · ');
    }
    case 'append_to_note': return noteSnippet(change.note?.markdown);
    case 'import_ai_threads': {
      const chats = kept(change.items?.length ? change.items : change.chats);
      return [andMore(chats.slice(0, 3).map(chat => [text(chat.title), text(chat.provider)].filter(Boolean).join(' · ')).filter(Boolean), changeCount(change) - out.size),
        taggedWith(uniqueTags([change.tags || []]))].filter(Boolean).join(' · ');
    }
    default:
      if (!ITEM_CHANGES.has(change.op)) return '';
      return andMore(kept(change.items).slice(0, 3).map(item => text(item.title)).filter(Boolean), changeCount(change) - out.size);
  }
}

/**
 * The first line of a proposal row, with collection pills and tag chips. included: the items left after Review (counts
 * in the engine's wording are rewritten to it); createdIds / created: collections this proposal creates (id -> name).
 */
export function changeLabel(ctx, change, included, createdIds = new Set(), created = new Map()) {
  const items = plural(included, 'item');
  const pill = () => collectionPill(ctx, change, createdIds.has(change.collectionId));
  switch (change.op) {
    case 'move_items': return html`Move ${items} to ${pill()}`;
    case 'add_tags': return html`Add ${tagList(change.tags)} to ${items}`;
    case 'remove_tags': return html`Remove ${tagList(change.tags)} from ${items}`;
    case 'create_collection': return html`Create collection ${collectionPill(ctx, change, true)}`;
    case 'set_favorite': return change.favorite ? `Add ${items} to favorites` : `Remove ${items} from favorites`;
    case 'archive_items': return `Archive ${items}`;
    case 'trash_items': return `Move ${items} to Trash`;
    case 'save_links': return html`Save ${plural(included, 'link')} to ${pill()}`;
    case 'import_ai_threads': return typeof change.collectionId === 'string' ? html`Import ${plural(included, 'chat')} to ${pill()}` : `Import ${plural(included, 'chat')} into Still`;
    case 'update_collection': {
      const patch = change.patch || {};
      const only = Object.keys(patch).length === 1 ? Object.keys(patch)[0] : '';
      if (only === 'name') return html`Rename ${pill()} to “${patch.name}”`;
      if (only === 'parentId') return patch.parentId ? html`Move ${pill()} into ${collectionPill(ctx, { collectionId: patch.parentId, collectionName: created.get(patch.parentId) || '' }, createdIds.has(patch.parentId))}` : html`Move ${pill()} to the top level`;
      if (only === 'pinned') return html`${patch.pinned ? 'Pin' : 'Unpin'} ${pill()}`;
      const fields = text(change.label).match(/: (.+)$/)?.[1];
      return fields ? html`Update ${pill()}: ${fields}` : html`Update ${pill()}`;
    }
    case 'delete_collection': return html`Delete collection ${pill()}`;
    case 'add_dashboard_widget': return html`Show ${pill()} on the dashboard`;
    case 'rename_tag':
      if (text(change.from) && text(change.to)) return html`Rename ${tagList([change.from])} to ${tagList([change.to])} on ${items}`;
    // falls through: without both tag names the engine's label says it
    default:
      if (ITEM_CHANGES.has(change.op)) return recount(change.label, changeCount(change), included);
      return text(change.label) || text(change.op).replace(/_/g, ' ') || 'Change';
  }
}

function renderProposal(ctx, proposal) {
  const status = proposalStatus(proposal);
  if (!['pending', 'applying'].includes(status)) return renderReceipt(ctx, proposal, status);
  // Allowed by the assistant permissions: it applies without a decision, so no card with Apply is shown meanwhile.
  if (proposal.autoApproved) {
    return html`<div class="ai-receipt" data-status="applying" data-auto="true" data-key="pr:${proposal.id}" aria-busy="true">
      ${spinner({ size: 16 })}<div class="ai-receipt-text"><p class="ai-receipt-title">Applying changes automatically…</p></div></div>`;
  }
  const ui = proposalUi.get(proposal.id) || newProposalUi();
  const changes = proposal.changes || [];
  const createdIds = new Set(changes.filter(change => change.op === 'create_collection').map(change => change.collectionId));
  const created = new Map(changes.filter(change => change.op === 'create_collection').map(change => [change.collectionId, text(change.collectionName)]));
  const byChange = excludedByChange(proposal, ui.excluded);
  const reviewable = changes.some(change => ITEM_CHANGES.has(change.op) && change.items?.length);
  const left = changes.filter((change, index) => !isSkipped(change, byChange.get(index))).length;
  const titleId = `ai-pr-${proposal.id}`;
  return html`<section class="ai-proposal" data-key="pr:${proposal.id}" aria-labelledby="${titleId}">
    <header class="ai-proposal-head">${icon('list-checks', { size: 16 })}<h3 class="ai-proposal-title" id="${titleId}">Proposed changes</h3>
      ${badge({ label: 'Needs approval', tone: 'warning', className: 'ai-proposal-badge' })}</header>
    <ul class="ai-changes" role="list">${changes.map((change, index) => {
      const out = byChange.get(index) || new Set();
      const sub = changeSub(ctx, change, out, { created });
      return html`<li class="${cx('ai-change', isSkipped(change, out) && 'is-skipped', DESTRUCTIVE.has(change.op) && 'is-destructive')}">
        <span class="ai-change-icon">${icon(changeIcon(change.op), { size: 16 })}</span>
        <div class="ai-change-body"><p class="ai-change-label">${changeLabel(ctx, change, Math.max(0, changeCount(change) - out.size), createdIds, created)}</p>
          ${sub ? html`<p class="ai-change-sub">${sub}</p>` : ''}
          ${ui.open && ITEM_CHANGES.has(change.op) && change.items?.length ? renderReview(ctx, proposal, change, index, ui) : ''}</div>
      </li>`;
    })}</ul>
    <footer class="ai-proposal-foot">
      ${button({ label: byChange.size && left ? `Apply ${plural(left, 'change')}` : 'Apply', variant: 'primary', size: 'sm', action: 'ai.proposal-apply',
        data: { id: proposal.id }, loading: status === 'applying', disabled: !ui.resolve || !left })}
      ${reviewable ? button({ label: ui.open ? 'Hide review' : 'Review', variant: 'secondary', size: 'sm', action: 'ai.proposal-review', data: { id: proposal.id },
        attrs: { 'aria-expanded': ui.open ? 'true' : 'false' } }) : ''}
      <span class="spacer"></span>
      ${button({ label: 'Discard', variant: 'ghost', size: 'sm', action: 'ai.proposal-discard', data: { id: proposal.id }, disabled: !ui.resolve })}
    </footer>
  </section>`;
}

// Per-item checkboxes. Unchecking an item leaves it out of every change it is in (the engine's exclusion rule), so a
// second list that shows it follows. Links still to be saved show their domain, with the full address on hover.
function renderReview(ctx, proposal, change, index, ui) {
  const out = ui.excluded;
  const listed = change.items || [];
  const noun = change.op === 'save_links' ? 'link' : change.op === 'import_ai_threads' ? 'chat' : 'item';
  const included = listed.filter(item => !out.has(item.id)).length;
  const all = included === listed.length;
  return html`<div class="ai-review">
    <label class="checkbox ai-review-all"><input type="checkbox" ${all ? raw('checked') : ''} ${!all && included ? raw('data-indeterminate') : ''}
      data-change="ai.review-all" data-proposal="${proposal.id}" data-change-index="${index}"><span class="checkbox-box" aria-hidden="true">${icon('check', { size: 12, strokeWidth: 3 })}</span>
      <span class="checkbox-label">${included} of ${plural(listed.length, noun)} selected</span></label>
    <ul class="ai-review-list" role="list">${listed.map(entry => {
      const item = liveItem(ctx, entry.id);
      const url = text(entry.url) || text(item?.url);
      const meta = domainOf(url) || (item ? collectionName(ctx, item.collectionId || '') : '');
      return html`<li><label class="checkbox ai-review-item"><input type="checkbox" ${out.has(entry.id) ? '' : raw('checked')} data-change="ai.review-item"
        data-proposal="${proposal.id}" data-change-index="${index}" data-item="${entry.id}"><span class="checkbox-box" aria-hidden="true">${icon('check', { size: 12, strokeWidth: 3 })}</span>
        <span class="checkbox-label"><span class="ai-review-title">${entry.title || item?.title || domainOf(url) || 'Untitled'}</span>${meta ? html`<span class="ai-review-meta" ${url ? html`title="${url}"` : ''}>${meta}</span>` : ''}</span></label></li>`;
    })}</ul>
    ${changeCount(change) > listed.length ? html`<p class="ai-review-more">${plural(changeCount(change) - listed.length, `more ${noun}`)} cannot be reviewed here and will be included.</p>` : ''}
  </div>`;
}

function renderReceipt(ctx, proposal, status) {
  const ui = proposalUi.get(proposal.id);
  const lines = ui?.lines || proposal.appliedLines || appliedLines(proposal, proposal.excluded || []);
  const undoing = !!ui?.undoing;
  if (status === 'applied') {
    // Applied without review because the assistant permissions allow it: the receipt says so and keeps Undo.
    const auto = !!proposal.autoApproved;
    const title = auto ? lines.length === 1 ? `Applied automatically: ${lowerFirst(lines[0])}` : `Applied ${plural(lines.length, 'change')} automatically`
      : lines.length === 1 ? `Applied: ${lowerFirst(lines[0])}` : `Applied ${plural(lines.length, 'change')}`;
    const undoable = typeof ui?.undo === 'function' || savedUndo(ctx, proposal);
    return html`<div class="ai-receipt" data-status="applied" ${auto ? raw('data-auto="true"') : ''} data-key="pr:${proposal.id}">
      ${icon('circle-check', { size: 16, className: 'ai-receipt-icon' })}
      <div class="ai-receipt-text"><p class="ai-receipt-title">${title}</p>
        ${lines.length > 1 ? html`<ul class="ai-receipt-lines" role="list">${lines.map(line => html`<li>${line}</li>`)}</ul>` : ''}
        ${auto ? html`<p class="ai-receipt-note">Your assistant permissions allow these changes without review.
          <button type="button" class="ai-link" data-action="ai.permissions">Change permissions</button></p>` : ''}</div>
      ${undoable ? button({ label: 'Undo', icon: 'undo-2', variant: 'ghost', size: 'sm', action: 'ai.proposal-undo', data: { id: proposal.id }, loading: undoing }) : ''}
    </div>`;
  }
  const copy = { discarded: ['circle-x', 'Discarded the proposed changes. Nothing was changed.'], undone: ['undo-2', 'Undone. Your library is back as it was.'],
    failed: ['circle-alert', `Changes failed. Nothing was changed.${ui?.error || proposal.error ? ` ${ui?.error || proposal.error}` : ''}`] }[status]
    || ['circle-x', 'These changes were not applied.'];
  return html`<div class="ai-receipt" data-status="${status}" data-key="pr:${proposal.id}">${icon(copy[0], { size: 16, className: 'ai-receipt-icon' })}
    <div class="ai-receipt-text"><p class="ai-receipt-title">${copy[1]}</p></div></div>`;
}

/** A proposal as the transcript shows it: the card while it waits for a decision, the receipt after. */
export const renderProposalCard = (ctx, proposal) => renderProposal(ctx, proposal);
/** The web pages an answer used, as the transcript lists them under it. */
export const renderWebSourceList = (ctx, message) => renderWebSources(ctx, message);

// ------------------------------------------------------------------------------------------------ popovers

/** The telescope a research conversation carries in the history lists; named for screen readers unless its title says Research. */
export const historyGlyph = entry => entry?.kind !== 'research' ? ''
  : icon('telescope', { size: 12, className: 'ai-history-kind', label: /^research\b/i.test(text(entry.title)) ? undefined : 'Research:' });

function renderHistoryPopover(ctx) {
  const s = st(ctx);
  const query = s.historyQuery.trim();
  const list = filterConversations(s.history, query);
  const row = entry => {
    const current = entry.id === s.conversation?.id;
    return html`<li class="${cx('ai-history-row', current && 'is-current')}" data-key="h:${entry.id}">
      <button type="button" class="ai-history-main" data-action="ai.history-open" data-id="${entry.id}" ${current ? raw('aria-current="true"') : ''}>
        <span class="ai-history-title">${historyGlyph(entry)}${entry.title || 'New conversation'}</span>
        <span class="ai-history-meta">${relativeDate(entry.updatedAt)}${entry.preview ? html` · ${plainPreview(entry.preview)}` : ''}</span></button>
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
  // Inbox and collections: recent ones without a query, matching names with one.
  const current = resolved.kind === 'collection' ? resolved.scope.collectionId : null;
  const taken = new Set(options.map(option => option.collectionId).filter(id => id !== undefined));
  const words = fold(query).split(/\s+/).filter(Boolean);
  const named = name => words.every(word => fold(name).includes(word));
  if (current !== '' && !taken.has('') && named('Inbox')) options.push({ kind: 'scope', scope: 'collection', collectionId: '', label: 'Inbox', hint: 'Not in a collection', glyph: collectionIcon(null, { size: 16 }) });
  const collections = words.length ? (ctx.select?.tree?.() || []).filter(collection => named(collection.name)) : ctx.select?.recentCollections?.(6) || [];
  for (const collection of collections.filter(entry => entry.id !== current && !taken.has(entry.id)).slice(0, words.length ? 4 : 5)) {
    options.push({ kind: 'scope', scope: 'collection', collectionId: collection.id, label: collection.name, hint: 'Collection', glyph: collectionIcon(collection, { size: 16 }) });
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
        ${isWebUrl(entry.item.url) ? siteIcon(entry.item.url, { size: 16 }) : icon(TYPE_ICONS[entry.item.type] || 'file-text', { size: 16 })}
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
registerPopover('ai.browser-mode', ctx => renderBrowserModeMenu({ mode: st(ctx).settings?.browser?.mode }), { role: 'menu', className: 'popover-menu ai-model-pop ai-mode-pop' });
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

registerActions({
  'ai.draft': ({ ctx, el }) => {
    const s = st(ctx);
    const before = s.draft;
    s.draft = el.value;
    const send = el.form?.querySelector('.ai-send[type="submit"]');
    if (send) send.disabled = !s.draft.trim() || s.draft.length > MAX_QUESTION || !!s.researchSending || (s.target === null && !researchOf(s));
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
    // A research request cannot be edited and asked again; its follow-ups continue the run.
    if (event.key === 'ArrowUp' && !el.value && !s.run && !event.shiftKey && !researchOf(s)) {
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
  'ai.stop': ({ ctx }) => {
    const research = researchOf(st(ctx));
    if (research) return ctx.dispatch('research.stop', { data: { id: research.id } });
    stopRun(ctx);
    bump(ctx, { render: true });
    return undefined;
  },
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
  'ai.permissions': ({ ctx }) => { ctx.closePopover?.({ restore: false }); openSettings(ctx, 'assistant'); },
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
    ctx.openPopover('ai.context', el, {}, { placement: el?.dataset?.placement || 'top-start' });
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
    ctx.openPopover('ai.model', el, {}, { placement: el.dataset.placement || 'top-start' });
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
    const entry = (s.history || []).find(item => item.id === data.id) || (s.conversation?.id === data.id ? s.conversation : null);
    const name = await ctx.prompt({ title: 'Rename chat', label: 'Name', value: entry?.title || '', confirmLabel: 'Rename' });
    if (name === null || !name.trim()) return;
    await renameAiConversation(ctx, data.id, name);
  },
  'ai.history-delete': async ({ ctx, data }) => {
    const s = st(ctx);
    const entry = (s.history || []).find(item => item.id === data.id) || (s.conversation?.id === data.id ? s.conversation : null);
    const ok = await ctx.confirm({ title: 'Delete this chat?', body: `“${entry?.title || 'This chat'}” is removed from this device. Saved notes and items stay.`, confirmLabel: 'Delete', tone: 'danger' });
    if (!ok) return;
    // A research run that is still going (or paused) is stopped first, so its session stops spending.
    const record = s.conversation?.id === data.id ? s.conversation : entry;
    if (record?.kind === 'research' && OPEN_RESEARCH.has(record.research?.status) && typeof ctx.ai.stopResearch === 'function') {
      try { await ctx.ai.stopResearch(data.id); } catch (error) { console.warn('[still] could not stop the research before deleting it', error); }
    }
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
    if (liveItem(ctx, data.id)) { ctx.openItem(data.id); return; }
    if (data.thread || /^tk:/.test(text(data.id))) { openThreadCitation(ctx, el, { id: text(data.id), threadKey: text(data.thread) }); return; }
    // External sources (such as paperclip:PAP-12 from the assistant's Paperclip tools) are not library items: open
    // the URL their tool reported instead.
    if (/^[a-z][a-z0-9-]*:/.test(data.id || '')) {
      const messages = st(ctx).conversation?.messages || [];
      const source = messages.flatMap(message => message.citations || []).find(citation => citation?.id === data.id);
      const url = data.url || source?.url;
      if (isWebUrl(url)) ctx.dispatch('app.open-url', { el, data: { url } });
      else ctx.toast('This source is outside your library.');
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
  'ai.ask-again': ({ ctx, data }) => {
    const question = (st(ctx).conversation?.messages || []).find(message => message.id === data.id && message.role === 'user');
    if (question) askAgain(ctx, question);
  },
  'ai.open-page': ({ ctx }) => openFullScreen(ctx),
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
  // Browser cards and the composer's Ask first / Auto control.
  'ai.browser-answer': ({ ctx, data }) => answerBrowserCard(ctx, data.id, data.answer),
  'ai.browser-input': ({ ctx, el, data }) => {
    const value = text(el.elements?.answer?.value).trim().slice(0, 2000);
    answerBrowserCard(ctx, data.id, { outcome: 'continue', ...(value ? { data: value } : {}) });
  },
  'ai.browser-show': ({ data }) => {
    const tabId = Number(data.tab);
    const tabs = globalThis.chrome?.tabs;
    if (!Number.isInteger(tabId) || typeof tabs?.update !== 'function') return undefined;
    // The tab comes to the front in its own window; the card stays here for the answer.
    return Promise.resolve(tabs.update(tabId, { active: true }))
      .then(tab => (Number.isInteger(tab?.windowId) ? globalThis.chrome?.windows?.update?.(tab.windowId, { focused: true }) : undefined)).catch(() => undefined);
  },
  'ai.browser-mode': ({ ctx, el }) => {
    if (popoverOpen(ctx, 'ai.browser-mode')) { ctx.closePopover(); return; }
    ctx.openPopover('ai.browser-mode', el, {}, { placement: el.dataset.placement || 'top-start' });
  },
  'ai.browser-pick-mode': async ({ ctx, data }) => {
    const s = st(ctx);
    ctx.closePopover?.();
    if (!BROWSER_MODES.includes(data.mode) || typeof ctx.ai?.setAiSettings !== 'function') return;
    try {
      s.settings = await ctx.ai.setAiSettings({ browser: { mode: data.mode } });
      announce(ctx, data.mode === 'auto' ? 'Auto: changes on pages go ahead without a card.' : 'Ask first: changes on pages wait for you.');
    } catch (error) { ctx.toast(error?.message || 'The setting could not be saved.', { tone: 'danger' }); }
    ctx.render();
  },
  'ai.browser-settings': ({ ctx }) => { ctx.closePopover?.({ restore: false }); openSettings(ctx, 'browser'); },
  'ai.browser-allow': ({ ctx }) => {
    const s = st(ctx);
    const names = s.browserNotice?.permissions?.length ? s.browserNotice.permissions : browserAccess(s.settings?.browser?.engine).names;
    // "sites" stands for access to web pages, which Chrome takes as origins.
    const permissions = names.filter(name => name !== 'sites');
    const request = { ...(permissions.length ? { permissions } : {}), ...(names.includes('sites') ? { origins: [...BROWSER_SITE_ORIGINS] } : {}) };
    // Called before any await so Chrome treats it as part of the click.
    let pending;
    try { pending = globalThis.chrome?.permissions?.request?.(request); } catch { pending = false; }
    return Promise.resolve(pending).then(granted => {
      if (!granted) { ctx.toast('Chrome did not allow it. The assistant cannot work in the browser until it does.', { tone: 'warning' }); return; }
      s.browserNotice = null;
      ctx.toast('Allowed. Ask again and the assistant can work in the browser.', { tone: 'success' });
      ctx.render();
    }, () => ctx.toast('Chrome did not allow it. The assistant cannot work in the browser until it does.', { tone: 'warning' }));
  },
  'ai.browser-notice-dismiss': ({ ctx }) => { st(ctx).browserNotice = null; ctx.render(); },
  'ai.model-notice-dismiss': ({ ctx }) => { st(ctx).modelNotice = false; ctx.render(); ctx.nextFrame(() => composer()?.focus({ preventScroll: true })); },
  'ai.proposal-review': ({ ctx, data }) => {
    const ui = proposalUi.get(data.id);
    if (!ui) return;
    ui.open = !ui.open;
    bump(ctx);
  },
  'ai.review-item': ({ ctx, el, data }) => {
    const ui = proposalUi.get(data.proposal);
    if (!ui?.resolve || !data.item) return;
    if (el.checked) ui.excluded.delete(data.item); else ui.excluded.add(data.item);
    bump(ctx);
  },
  'ai.review-all': ({ ctx, el, data }) => {
    const ui = proposalUi.get(data.proposal);
    const proposal = findProposal(ctx, data.proposal);
    if (!ui?.resolve || !proposal) return;
    for (const item of proposal.changes?.[Number(data.changeIndex)]?.items || []) {
      if (el.checked) ui.excluded.delete(item.id); else ui.excluded.add(item.id);
    }
    bump(ctx);
  },
  // The engine leaves the unchecked items out before it applies anything ({ decision: 'apply', exclude }), so its tool
  // results, the saved proposal and this receipt all count the same items.
  'ai.proposal-apply': ({ ctx, data }) => {
    const ui = proposalUi.get(data.id);
    const proposal = findProposal(ctx, data.id);
    if (!ui?.resolve || !proposal) return;
    const resolve = ui.resolve;
    ui.resolve = null;
    const decision = proposalDecision(proposal, ui.excluded);
    if (decision === 'discard') { ui.status = 'discarded'; resolve('discard'); bump(ctx, { render: true }); return; }
    ui.lines = decision.exclude ? appliedLines(proposal, decision.exclude) : null;
    ui.status = 'applying';
    ui.open = false;
    resolve(decision);
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
  // Undo with the live undo from this run, or after a reload (or in another window) with the undo record saved with the
  // proposal (ai.undoProposal). Errors reach ctx.run, which says what went wrong; the receipt then still offers Undo.
  'ai.proposal-undo': async ({ ctx, data }) => {
    const proposal = findProposal(ctx, data.id);
    let ui = proposalUi.get(data.id);
    if (ui?.undone || ui?.undoing || proposal?.status === 'undone') return;
    const undo = typeof ui?.undo === 'function' ? ui.undo : savedUndo(ctx, proposal) ? () => ctx.ai.undoProposal(proposal.undo) : null;
    if (!undo) return;
    if (!ui) { ui = { ...newProposalUi(), status: 'applied' }; proposalUi.set(data.id, ui); }
    ui.undoing = true;
    bump(ctx);
    try {
      const result = await undo();
      ui.undone = true;
      ui.undo = null;
      // Undo leaves alone anything changed after the apply, so later edits are never wiped.
      const kept = Number(result?.kept) || 0;
      const message = kept ? `Changes undone. ${kept === 1 ? '1 thing you changed since was' : `${kept} things you changed since were`} left as is.` : 'Changes undone.';
      announce(ctx, message);
      ctx.toast(kept ? message : 'Changes undone');
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
