// Full-screen AI assistant: the 'assistant' view of the full tab and the new tab. A chats rail (new chat, search, history
// by day, rename and delete), the conversation from ai-panel.js with a wide transcript and a docked composer, and a
// "Context & sources" rail (what the next question is about, the sources of the latest answer, this chat's details).
// It shares ctx.state.ai with the full tab's Ask panel and the side panel's Ask tab, so a chat moves between them as is.
// The rails dock beside the conversation when the main column is wide enough and open as sheets over it otherwise.
import { html, cx, plural } from './html.js';
import { icon } from './icons.js';
import { button, iconButton, collectionIcon, relativeDate, shortDate, skeleton } from './components.js';
import { registerActions, registerMount, registerShortcuts } from './runtime.js';
import { navToggle } from './sidebar.js';
import { greetingFor } from './dashboard/state.js';
import { settingsGroup } from '../lib/settings-schema.js';
import {
  renderAiPanel, aiState, aiContext, contextChipView, renderContextChip, citationsOf, renderSourceRows, suggestionsFor, historyGroups,
  filterConversations, plainPreview, latestAnswer, conversationIdOf, shortModelLabel, newAiChat, openAiConversation, ensureAiHistory, refreshAiHistory,
  setAiScope, renameAiConversation, exportConversation,
} from './ai-panel.js';

/** Main-column widths where the rails dock: both from 1120px, the chats rail alone from 760px. */
export const ASSISTANT_LAYOUT = Object.freeze({ wide: 1120, medium: 760 });
export const assistantLayout = width => width >= ASSISTANT_LAYOUT.wide ? 'wide' : width >= ASSISTANT_LAYOUT.medium ? 'medium' : 'narrow';

/**
 * Where each rail shows for a layout: 'docked' beside the conversation, 'sheet' over it, or 'hidden'.
 * prefs: { chats, context } are the docked rails the person chose to show; sheet: the open sheet ('chats' | 'context' | null).
 */
export function railPlacement(layout, { chats = true, context = true } = {}, sheet = null) {
  const docks = { chats: layout !== 'narrow', context: layout === 'wide' };
  const place = name => docks[name] ? (({ chats, context })[name] ? 'docked' : 'hidden') : sheet === name ? 'sheet' : 'hidden';
  return { chats: place('chats'), context: place('context') };
}

/** Scope options for the "Ask about" select: the whole library, Inbox and every collection, nested by indentation. */
export function scopeOptions(tree = [], { kind = 'library', collectionId = null, itemCount = 0 } = {}) {
  const options = [{ value: 'library', label: 'Whole library' }, { value: 'inbox', label: 'Inbox' }];
  for (const collection of tree) options.push({ value: `collection:${collection.id}`, label: `${'\u2003'.repeat(Math.min(6, collection.depth || 0))}${collection.name}` });
  if (kind === 'items') options.unshift({ value: 'items', label: itemCount === 1 ? 'The chosen item' : `${itemCount} chosen items` });
  const value = kind === 'items' ? 'items' : kind === 'collection' ? (collectionId ? `collection:${collectionId}` : 'inbox') : 'library';
  return { value, options };
}

const PREF_CHATS = 'assistantChats';
const PREF_CONTEXT = 'assistantContext';
const pageUi = ctx => (ctx.state.assistant ||= { layout: '', sheet: null, query: '' });
const menuOpenFor = (ctx, action) => ctx.state.popover?.anchorEl?.dataset?.action === action;
const threadOf = s => [...(s.conversation?.messages || []), ...(s.run ? [s.run.user, s.run.message] : [])];

// Before the first measurement the layout is guessed from the main column (or the window less the docked sidebar).
function guessLayout(ctx) {
  const main = typeof document === 'undefined' ? null : document.getElementById('main');
  const width = main?.clientWidth || (globalThis.innerWidth || 1280) - (ctx.state.shell?.docked === false ? 0 : 248);
  return assistantLayout(width);
}

function placement(ctx) {
  const ui = pageUi(ctx);
  ui.layout ||= guessLayout(ctx);
  const prefs = { chats: ctx.prefs.get(PREF_CHATS, true) !== false, context: ctx.prefs.get(PREF_CONTEXT, true) !== false };
  return railPlacement(ui.layout, prefs, ui.sheet);
}

// ------------------------------------------------------------------------------------------------ page

/** Main-area renderer for the 'assistant' view. */
export function renderAssistantPage(ctx) {
  // The page is the assistant: the full tab's Ask panel never opens beside it (it would be a second copy of the chat).
  // The frame around this view was already drawn for a panel, so draw once more without it.
  if (ctx.state.panel?.kind === 'ai') { ctx.state.panel = null; ctx.render(); }
  const ui = pageUi(ctx);
  const place = placement(ctx);
  if (ui.sheet && place[ui.sheet] !== 'sheet') ui.sheet = null;
  ensureAiHistory(ctx);
  const covered = !!ui.sheet;
  return html`<div class="assistant-page" data-key="assistant-page" data-layout="${ui.layout}">
    <div class="asst-size" data-mount="assistant.size" data-morph="skip" data-key="asst-size" aria-hidden="true"></div>
    ${place.chats === 'docked' ? renderChats(ctx, { sheet: false, covered }) : ''}
    <div class="asst-center" data-key="asst-center" ${covered ? html`inert` : ''}>
      ${renderHeader(ctx, place)}
      ${renderAiPanel(ctx, { surface: 'page', head: '', empty: renderPageEmpty })}
    </div>
    ${place.context === 'docked' ? renderContext(ctx, { sheet: false, covered }) : ''}
    ${covered ? html`<div class="asst-scrim" data-key="asst-scrim" data-action="assistant.close-sheet" aria-hidden="true"></div>
      ${ui.sheet === 'chats' ? renderChats(ctx, { sheet: true }) : renderContext(ctx, { sheet: true })}` : ''}
  </div>`;
}

// ------------------------------------------------------------------------------------------------ header

function renderHeader(ctx, place) {
  const s = aiState(ctx);
  const conversation = s.conversation;
  const hasThread = !!(conversation?.messages?.length || s.run);
  const title = conversation?.title || (s.run ? s.run.question : 'New chat');
  const chatsOpen = place.chats !== 'hidden';
  const contextOpen = place.context !== 'hidden';
  const editable = !!conversation && !s.run;
  return html`<header class="asst-head" data-key="asst-head">
    <div class="asst-head-lead">
      ${navToggle(ctx)}
      ${iconButton({ icon: chatsOpen ? 'panel-left-close' : 'panel-left-open', label: chatsOpen ? 'Hide chats' : 'Show chats', action: 'assistant.toggle-chats',
        controls: 'asst-chats', id: 'asst-chats-toggle', attrs: { 'aria-expanded': chatsOpen ? 'true' : 'false' } })}
    </div>
    <div class="asst-heading">
      <h1 class="asst-title">${editable
        ? html`<input class="asst-title-input" id="asst-title" data-focus-key="asst-title" value="${title}" aria-label="Chat name" maxlength="200"
            data-change="assistant.rename" data-keydown="assistant.rename-key" autocomplete="off" spellcheck="false" title="Rename this chat">`
        : html`<span class="asst-title-text" title="${title}">${title}</span>`}</h1>
      ${renderModelBadge(ctx)}
    </div>
    <div class="asst-head-actions" role="group" aria-label="Chat actions">
      ${iconButton({ icon: 'square-pen', label: 'New chat', action: 'assistant.new', disabled: !ctx.ai || (!hasThread && !s.draft) })}
      ${pageUi(ctx).layout === 'narrow' ? '' : iconButton({ icon: 'download', label: 'Export chat', action: 'assistant.export', disabled: !conversation?.messages?.length || !!s.run,
        expanded: menuOpenFor(ctx, 'assistant.export') })}
      ${iconButton({ icon: 'ellipsis', label: 'More chat actions', action: 'assistant.more', disabled: !conversation || !!s.run,
        expanded: menuOpenFor(ctx, 'assistant.more'), tooltipPlacement: contextOpen ? undefined : 'bottom end' })}
      ${iconButton({ icon: 'panel-right', label: contextOpen ? 'Hide context and sources' : 'Show context and sources', action: 'assistant.toggle-context',
        controls: 'asst-context', id: 'asst-context-toggle', tooltipPlacement: 'bottom end', attrs: { 'aria-expanded': contextOpen ? 'true' : 'false' } })}
    </div>
  </header>`;
}

function renderModelBadge(ctx) {
  const t = aiState(ctx).target;
  if (!ctx.ai || t === undefined) return '';
  if (t === null) return html`<button type="button" class="asst-model is-missing" data-action="ai.settings">${icon('plug', { size: 14 })}<span class="asst-model-label">Connect a model</span></button>`;
  const where = t.via === 'agent' || t.via === 'bridge' ? 'plug' : t.local ? 'cpu' : 'cloud';
  const open = ctx.state.popover?.name === 'ai.model' && !!ctx.state.popover?.anchorEl?.classList?.contains('asst-model');
  const name = t.modelLabel || t.model;
  return html`<button type="button" class="asst-model" data-action="ai.model" data-placement="bottom-start" aria-haspopup="menu" aria-expanded="${open ? 'true' : 'false'}"
    aria-label="Model: ${name}. Change model" data-tooltip="${t.providerName} · ${name}">${icon(where, { size: 14 })}<span class="asst-model-label">${shortModelLabel(name)}</span>${icon('chevron-down', { size: 12 })}</button>`;
}

// ------------------------------------------------------------------------------------------------ empty state

function renderPageEmpty(ctx, resolved) {
  const s = aiState(ctx);
  const chip = resolved.chips[0];
  const count = resolved.scope.ids?.length || 0;
  const collectionName = resolved.kind === 'collection' ? contextChipView(ctx, chip).label : '';
  s.suggestions = suggestionsFor(resolved.kind, { collectionName, count });
  const name = String(settingsGroup(ctx.library?.settings, 'newTab').name || '').trim();
  const lede = resolved.kind === 'collection' ? `Answers use what is in ${collectionName} and cite the items they come from.`
    : resolved.kind === 'items' ? `Answers use ${count === 1 ? 'the item you chose' : `the ${count} items you chose`} and cite them.`
      : 'Answers cite the items they come from. Changes to your library always wait for your approval.';
  return html`<div class="asst-empty">
    <span class="asst-mark" aria-hidden="true">${icon('sparkles', { size: 22 })}</span>
    <h2 class="asst-greeting">${greetingFor()}${name ? `, ${name}` : ''}</h2>
    <p class="asst-lede">${lede}</p>
    ${renderQuickScopes(ctx, resolved)}
    <ul class="asst-suggestions" role="list" aria-label="Suggestions">
      ${s.suggestions.map((suggestion, index) => html`<li><button type="button" class="asst-suggestion" data-action="ai.suggest" data-index="${index}">
        <span class="asst-suggestion-icon" aria-hidden="true">${icon(suggestion.icon, { size: 16 })}</span>
        <span class="asst-suggestion-label">${suggestion.label}</span>
        ${icon(suggestion.prompt?.includes('…') ? 'pencil' : 'arrow-up-right', { size: 14, className: 'asst-suggestion-go' })}</button></li>`)}
    </ul>
  </div>`;
}

function renderQuickScopes(ctx, resolved) {
  const current = resolved.kind === 'collection' ? resolved.scope.collectionId : null;
  const recent = (ctx.select?.recentCollections?.(3) || []).filter(Boolean);
  const chosen = current ? ctx.select?.collection?.(current) : null;
  const collections = chosen && !recent.some(entry => entry.id === chosen.id) ? [chosen, ...recent.slice(0, 2)] : recent;
  const scope = ({ key, label, glyph, pressed, data }) => html`<button type="button" class="asst-scope" data-action="assistant.scope-pick" data-key="${key}"
    aria-pressed="${pressed ? 'true' : 'false'}" ${data}>${glyph}<span class="asst-scope-label">${label}</span></button>`;
  return html`<div class="asst-scopes" role="group" aria-labelledby="asst-scopes-label">
    <span class="asst-scopes-label" id="asst-scopes-label">Ask about</span>
    ${scope({ key: 'scope:library', label: 'Whole library', glyph: icon('library', { size: 14 }), pressed: resolved.kind === 'library', data: html`data-scope="library"` })}
    ${scope({ key: 'scope:inbox', label: 'Inbox', glyph: collectionIcon(null, { size: 16 }), pressed: current === '', data: html`data-scope="collection" data-collection=""` })}
    ${collections.map(collection => scope({ key: `scope:${collection.id}`, label: collection.name, glyph: collectionIcon(collection, { size: 16 }),
      pressed: current === collection.id, data: html`data-scope="collection" data-collection="${collection.id}"` }))}
    ${resolved.kind === 'items' ? html`<button type="button" class="asst-scope is-selected" data-action="ai.add-context" data-placement="bottom-start" data-key="scope:items"
      aria-haspopup="dialog" aria-description="Selected. Choose items to add or remove">${icon('layers', { size: 14 })}<span class="asst-scope-label">${contextChipView(ctx, resolved.chips[0]).label}</span></button>` : ''}
    <button type="button" class="asst-scope is-more" data-action="ai.add-context" data-placement="bottom-start" aria-haspopup="dialog"
      aria-expanded="${ctx.state.popover?.name === 'ai.context' ? 'true' : 'false'}">${icon('plus', { size: 14 })}<span class="asst-scope-label">Choose…</span></button>
  </div>`;
}

// ------------------------------------------------------------------------------------------------ chats rail

function renderChats(ctx, { sheet, covered = false }) {
  const s = aiState(ctx);
  const ui = pageUi(ctx);
  const query = ui.query.trim();
  const list = filterConversations(s.history, query);
  const currentId = conversationIdOf(s);
  const row = entry => {
    const current = entry.id === currentId;
    const title = entry.title || 'New conversation';
    return html`<li class="${cx('asst-chat', current && 'is-current')}" data-key="chat:${entry.id}">
      <button type="button" class="asst-chat-main" data-action="assistant.open" data-id="${entry.id}" ${current ? html`aria-current="page"` : ''} title="${title}">
        <span class="asst-chat-title">${title}</span>
        <span class="asst-chat-meta">${plainPreview(entry.preview) || relativeDate(entry.updatedAt)}</span>
      </button>
      ${iconButton({ icon: 'ellipsis', label: 'Chat actions', size: 'sm', action: 'assistant.chat-menu', data: { id: entry.id }, className: 'asst-chat-more',
        expanded: menuOpenFor(ctx, 'assistant.chat-menu') && ctx.state.popover?.anchorEl?.dataset?.id === entry.id, tooltipPlacement: 'bottom end' })}
    </li>`;
  };
  let body;
  if (!ctx.ai || s.history === null) body = html`<div class="asst-chats-loading" role="status" aria-label="Loading chats">${skeleton({ rows: 6, variant: 'text' })}</div>`;
  else if (!list.length) {
    body = query ? html`<div class="asst-chats-empty"><p>No chats match “${query}”.</p>${button({ label: 'Clear search', size: 'sm', variant: 'ghost', action: 'assistant.clear-query' })}</div>`
      : s.historyError ? html`<div class="asst-chats-empty" role="alert"><p>Your chats could not be read. Try again in a moment.</p>${button({ label: 'Try again', icon: 'refresh-cw', size: 'sm', action: 'assistant.reload-chats' })}</div>`
        : html`<div class="asst-chats-empty"><p class="asst-chats-empty-title">No chats yet</p><p>Questions you ask are kept on this device and listed here.</p></div>`;
  } else {
    body = historyGroups(list).map((group, index) => html`<section class="asst-group" aria-labelledby="asst-group-${index}" data-key="group:${group.label}">
      <h2 class="asst-group-label" id="asst-group-${index}">${group.label}</h2>
      <ul class="asst-group-list" role="list">${group.items.map(row)}</ul>
    </section>`);
  }
  // A sheet covers the page (the conversation and a docked rail go inert behind it).
  return html`<aside class="${cx('asst-chats', sheet && 'is-sheet')}" id="asst-chats" data-key="asst-chats" aria-label="Chats"
    ${sheet ? html`role="dialog"` : ''} ${covered ? html`inert` : ''} data-keydown="assistant.chats-key">
    <div class="asst-chats-head">
      ${button({ label: 'New chat', icon: 'square-pen', action: 'assistant.new', className: 'asst-new', disabled: !ctx.ai })}
      ${sheet ? iconButton({ icon: 'x', label: 'Close chats', action: 'assistant.close-sheet' }) : ''}
    </div>
    <div class="asst-search" role="search">
      ${icon('search', { size: 14, className: 'asst-search-icon' })}
      <input type="search" class="asst-search-input" id="asst-chat-search" data-focus-key="asst-chat-search" value="${ui.query}" placeholder="Search chats"
        aria-label="Search chats" data-input="assistant.query" data-keydown="assistant.query-key" autocomplete="off" spellcheck="false">
      ${ui.query ? iconButton({ icon: 'x', label: 'Clear search', action: 'assistant.clear-query', size: 'sm', className: 'asst-search-clear' }) : ''}
    </div>
    <nav class="asst-chat-list" aria-label="Chat history">${body}</nav>
  </aside>`;
}

// ------------------------------------------------------------------------------------------------ context rail

function scopeSummary(ctx, resolved) {
  const counts = ctx.select?.counts?.() || {};
  if (resolved.kind === 'collection') {
    const id = resolved.scope.collectionId;
    const collection = id ? ctx.select?.collection?.(id) : null;
    const total = id ? counts.byCollectionDeep?.[id] ?? counts.byCollection?.[id] ?? 0 : counts.inbox ?? 0;
    return { glyph: collectionIcon(collection, { size: 28 }), title: id ? collection?.name || 'Collection' : 'Inbox', meta: plural(total, 'item') };
  }
  if (resolved.kind === 'items') {
    const view = contextChipView(ctx, { kind: 'items', ids: resolved.scope.ids });
    return { glyph: html`<span class="asst-scope-tile">${icon('layers', { size: 16 })}</span>`, title: view.label, meta: resolved.scope.ids.length === 1 ? 'Chosen item' : 'Chosen items' };
  }
  return { glyph: html`<span class="asst-scope-tile">${icon('library', { size: 16 })}</span>`, title: 'Whole library', meta: plural(counts.all ?? 0, 'item') };
}

function modelName(s, id) {
  if (!id) return '';
  for (const connection of s.connections || []) {
    const model = (connection.models || []).find(entry => entry.id === id);
    if (model) return model.name || id;
  }
  return id;
}

function renderContext(ctx, { sheet, covered = false }) {
  const s = aiState(ctx);
  const resolved = aiContext(ctx);
  const summary = scopeSummary(ctx, resolved);
  const { value, options } = scopeOptions(ctx.select?.tree?.() || [], { kind: resolved.kind, collectionId: resolved.scope.collectionId ?? null, itemCount: resolved.scope.ids?.length || 0 });
  const added = resolved.chips.filter(chip => chip.kind === 'items' && chip.removable);
  const answer = latestAnswer(threadOf(s));
  const sources = answer ? citationsOf(ctx, answer) : [];
  const rows = renderSourceRows(ctx, sources);
  const conversation = s.conversation;
  const writing = !!answer?.live;
  const sourcesHint = !answer ? 'Sources cited in the latest answer appear here. Select one to open it.'
    : writing ? 'Sources appear here as the answer cites them.' : 'The latest answer does not cite any saved items.';
  return html`<aside class="${cx('asst-context', sheet && 'is-sheet')}" id="asst-context" data-key="asst-context" aria-labelledby="asst-context-title"
    ${sheet ? html`role="dialog"` : ''} ${covered ? html`inert` : ''}>
    <div class="asst-pane-head">
      <h2 class="asst-pane-title" id="asst-context-title">Context & sources</h2>
      ${iconButton({ icon: 'x', label: sheet ? 'Close context and sources' : 'Hide context and sources', action: sheet ? 'assistant.close-sheet' : 'assistant.toggle-context', tooltipPlacement: 'bottom end' })}
    </div>
    <div class="asst-pane-scroll">
      <section class="asst-section" aria-labelledby="asst-scope-title">
        <h3 class="asst-section-title" id="asst-scope-title">Asking about</h3>
        <div class="asst-scope-card">${summary.glyph}<span class="asst-scope-text"><span class="asst-scope-name">${summary.title}</span><span class="asst-scope-meta">${summary.meta}</span></span></div>
        <label class="asst-field">
          <span class="asst-field-label">Change what the next question is about</span>
          <span class="select select-sm"><select id="asst-scope" data-change="assistant.scope">
            ${options.map(option => html`<option value="${option.value}" ${option.value === value ? html`selected` : ''}>${option.label}</option>`)}
          </select>${icon('chevrons-up-down', { size: 14, className: 'select-icon' })}</span>
        </label>
        ${added.length ? html`<div class="asst-added" role="list" aria-label="Added items">${added.map(chip => renderContextChip(ctx, chip))}</div>` : ''}
        ${button({ label: 'Add items', icon: 'plus', size: 'sm', variant: 'ghost', action: 'ai.add-context', className: 'asst-add-items',
          attrs: { 'data-placement': sheet ? 'bottom-start' : 'bottom-end', 'aria-haspopup': 'dialog' } })}
      </section>
      <section class="asst-section" aria-labelledby="asst-sources-title">
        <h3 class="asst-section-title" id="asst-sources-title">Sources${rows.length ? html`<span class="asst-count">${rows.length}</span>` : ''}</h3>
        ${rows.length ? html`<ol class="ai-sources asst-sources" role="list">${rows}</ol>` : html`<p class="asst-hint">${sourcesHint}</p>`}
      </section>
      ${conversation ? html`<section class="asst-section" aria-labelledby="asst-chat-title">
        <h3 class="asst-section-title" id="asst-chat-title">This chat</h3>
        <dl class="asst-facts">
          <div><dt>Started</dt><dd>${shortDate(conversation.createdAt)}</dd></div>
          <div><dt>Messages</dt><dd>${(conversation.messages || []).length.toLocaleString()}</dd></div>
          ${conversation.model ? html`<div><dt>Model</dt><dd>${modelName(s, conversation.model)}</dd></div>` : ''}
        </dl>
      </section>` : ''}
    </div>
  </aside>`;
}

// ------------------------------------------------------------------------------------------------ layout, sheets, URL

registerMount('assistant.size', (el, ctx) => {
  let current = ctx;
  const page = el.parentElement;
  if (!page || typeof ResizeObserver !== 'function') return null;
  const observer = new ResizeObserver(entries => {
    const width = entries[0]?.contentRect?.width;
    if (!width) return;
    const ui = pageUi(current);
    const layout = assistantLayout(width);
    if (layout === ui.layout) return;
    ui.layout = layout;
    current.render();
  });
  observer.observe(page);
  return { update(next) { current = next; }, destroy() { observer.disconnect(); } };
});

function openSheet(ctx, name) {
  const ui = pageUi(ctx);
  ui.sheet = name;
  ctx.render();
  ctx.nextFrame(() => document.querySelector(name === 'chats' ? '#asst-chats .asst-search-input' : '#asst-context .asst-pane-head .icon-btn')?.focus({ preventScroll: true }));
}

function closeSheet(ctx, { restore = true } = {}) {
  const ui = pageUi(ctx);
  const was = ui.sheet;
  if (!was) return;
  ui.sheet = null;
  ctx.render();
  if (restore) ctx.nextFrame(() => document.getElementById(was === 'chats' ? 'asst-chats-toggle' : 'asst-context-toggle')?.focus({ preventScroll: true }));
}

function toggleRail(ctx, name) {
  const place = placement(ctx);
  if (place[name] === 'sheet') return closeSheet(ctx);
  const docks = name === 'chats' ? pageUi(ctx).layout !== 'narrow' : pageUi(ctx).layout === 'wide';
  if (!docks) return openSheet(ctx, name);
  const key = name === 'chats' ? PREF_CHATS : PREF_CONTEXT;
  ctx.prefs.set(key, place[name] === 'hidden');
  ctx.render();
}

// The full tab keeps the open conversation in its address, so a reload or a copied link opens it again. The new tab and
// the side panel never write their address.
function syncConversationParam(ctx) {
  if (ctx.env.isSidepanel || ctx.env.isNewtab || ctx.state.view !== 'assistant' || typeof history === 'undefined') return;
  const id = conversationIdOf(aiState(ctx));
  const url = new URL(location.href);
  if ((url.searchParams.get('conversation') || '') === id) return;
  if (id) url.searchParams.set('conversation', id); else url.searchParams.delete('conversation');
  history.replaceState(history.state, '', url);
}

const focusComposer = ctx => ctx.nextFrame(() => document.getElementById('ai-input')?.focus({ preventScroll: true }));

// ------------------------------------------------------------------------------------------------ actions

const exportItems = ctx => [
  { label: 'Copy as Markdown', icon: 'copy', run: () => ctx.run(() => exportConversation(ctx, 'copy')) },
  { label: 'Download Markdown file', icon: 'file-down', run: () => ctx.run(() => exportConversation(ctx, 'download')) },
  { label: 'Save as note', icon: 'notebook-pen', run: () => ctx.run(() => exportConversation(ctx, 'note')) },
];

registerActions({
  'assistant.toggle-chats': ({ ctx }) => toggleRail(ctx, 'chats'),
  'assistant.toggle-context': ({ ctx }) => toggleRail(ctx, 'context'),
  'assistant.close-sheet': ({ ctx }) => closeSheet(ctx),
  'assistant.new': ({ ctx }) => {
    closeSheet(ctx, { restore: false });
    newAiChat(ctx);
  },
  'assistant.open': async ({ ctx, data }) => {
    closeSheet(ctx, { restore: false });
    const s = aiState(ctx);
    if (conversationIdOf(s) === data.id) { focusComposer(ctx); return; }
    await openAiConversation(ctx, data.id);
  },
  'assistant.query': ({ ctx, el }) => { pageUi(ctx).query = el.value; ctx.render(); },
  'assistant.query-key': ({ ctx, el, event }) => {
    if (event.key === 'Escape' && el.value) {
      event.preventDefault();
      el.value = '';
      pageUi(ctx).query = '';
      ctx.render();
    } else if (event.key === 'ArrowDown') {
      const first = document.querySelector('#asst-chats .asst-chat-main');
      if (first) { event.preventDefault(); first.focus(); }
    }
  },
  'assistant.clear-query': ({ ctx }) => {
    pageUi(ctx).query = '';
    ctx.render();
    ctx.nextFrame(() => document.getElementById('asst-chat-search')?.focus({ preventScroll: true }));
  },
  'assistant.reload-chats': ({ ctx }) => refreshAiHistory(ctx),
  // Arrow keys move between chats in the history list; Home and End jump to the ends.
  'assistant.chats-key': ({ event }) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !event.target?.closest?.('.asst-chat-list')) return;
    const rows = [...document.querySelectorAll('#asst-chats .asst-chat-main')];
    const index = rows.indexOf(document.activeElement);
    if (!rows.length || index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : event.key === 'ArrowDown' ? Math.min(rows.length - 1, index + 1) : index - 1;
    if (next < 0) document.getElementById('asst-chat-search')?.focus();
    else rows[next].focus();
  },
  'assistant.chat-menu': ({ ctx, el, data }) => ctx.openMenu(el, [
    { label: 'Rename…', icon: 'pencil', run: () => ctx.dispatch('ai.history-rename', { data: { id: data.id } }) },
    { label: 'Delete…', icon: 'trash-2', danger: true, run: () => ctx.dispatch('ai.history-delete', { data: { id: data.id } }) },
  ], { placement: 'bottom-end', label: 'Chat actions' }),
  'assistant.rename': async ({ ctx, el }) => {
    const s = aiState(ctx);
    const id = s.conversation?.id;
    if (!id) return;
    const name = el.value.replace(/\s+/g, ' ').trim();
    // A blank name puts the saved one back.
    if (!name) { el.value = s.conversation.title; return; }
    const saved = await renameAiConversation(ctx, id, name);
    if (saved) el.value = saved;
  },
  'assistant.rename-key': ({ ctx, el, event }) => {
    if (event.key === 'Enter') { event.preventDefault(); el.blur(); focusComposer(ctx); }
    else if (event.key === 'Escape') {
      event.preventDefault();
      el.value = aiState(ctx).conversation?.title || el.value;
      el.blur();
    }
  },
  'assistant.export': ({ ctx, el }) => ctx.openMenu(el, exportItems(ctx), { placement: 'bottom-end', label: 'Export chat' }),
  'assistant.more': ({ ctx, el }) => {
    const id = aiState(ctx).conversation?.id;
    if (!id) return;
    // The narrow header has no Export button, so its items join this menu.
    const exports = pageUi(ctx).layout === 'narrow' ? [{ separator: true }, ...exportItems(ctx)] : [];
    ctx.openMenu(el, [
      { label: 'Rename…', icon: 'pencil', run: () => ctx.nextFrame(() => { const input = document.getElementById('asst-title'); input?.focus(); input?.select(); }) },
      ...exports,
      { separator: true },
      { label: 'Delete chat…', icon: 'trash-2', danger: true, run: () => ctx.dispatch('ai.history-delete', { data: { id } }) },
    ], { placement: 'bottom-end', label: 'More chat actions' });
  },
  'assistant.scope-pick': ({ ctx, data }) => {
    setAiScope(ctx, data.scope === 'collection' ? { scope: 'collection', collectionId: data.collection || '' } : { scope: 'library' });
    focusComposer(ctx);
  },
  'assistant.scope': ({ ctx, el }) => {
    const value = el.value;
    if (value === 'items') return;
    setAiScope(ctx, value === 'inbox' ? { scope: 'collection', collectionId: '' }
      : value.startsWith('collection:') ? { scope: 'collection', collectionId: value.slice(11) } : { scope: 'library' });
  },
});

registerShortcuts([
  { keys: 'escape', action: 'assistant.close-sheet', allowInInputs: true,
    when: ctx => !ctx.env.isSidepanel && ctx.state.view === 'assistant' && !!ctx.state.assistant?.sheet && !ctx.state.dialogs?.length && !ctx.state.popover },
]);

/** Opens the conversation named by the full tab's address (?conversation=id) and keeps the address in step. */
export async function init(ctx) {
  if (ctx.env.isSidepanel || ctx.env.isNewtab) return;
  const id = new URLSearchParams(location.search).get('conversation');
  // Load first: renders while it loads must not drop the parameter of a conversation that is about to open.
  if (id && ctx.ai) {
    try { await openAiConversation(ctx, id); } catch (error) { console.error(error); ctx.toast('That conversation could not be opened.', { tone: 'danger' }); }
  }
  ctx.onRendered?.(() => { try { syncConversationParam(ctx); } catch (error) { console.error(error); } });
  ctx.render();
}
