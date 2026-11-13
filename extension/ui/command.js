// Command palette (mod+K): one input over items, collections and commands, Raycast style. Works as a full-width
// sheet in the side panel. Commands dispatch registered actions so this module needs no feature imports.
import { html, cx } from './html.js';
import { icon } from './icons.js';
import { collectionIcon, favicon, kbd, domainOf, TYPE_ICONS, TYPE_LABELS } from './components.js';
import { pathOfItem, itemSource, chatGlyph } from './cards.js';
import { registerDialog } from './overlay.js';
import { registerActions, hasAction } from './runtime.js';

// Views open through the sidebar's navigation action, which also handles the side panel's Library stack and Notes tab.
const goToView = (ctx, view, { keep = false } = {}) => ctx.dispatch('sidebar.navigate', { data: { view, keep } });

const DIALOG = 'command.palette';
const WEB_URL = /^https?:\/\/\S+\.\S+$/i;
const ext = ctx => ctx.env.isExtension;
const full = ctx => !ctx.env.isSidepanel;
const currentCollection = ctx => (ctx.state.view?.startsWith('collection:') ? ctx.select.collection(ctx.state.view.slice(11)) : null);

/**
 * Every command: label (string or ctx => string), icon, keywords, action (+ data) and/or view (a view with an action
 * goes there first, then runs the action), shortcut, when(ctx), pinned (shown with an empty query).
 */
export const COMMANDS = [
  { id: 'add', label: 'Add link', icon: 'link', keywords: 'save bookmark url new paste', shortcut: 'a', action: 'shell.add', pinned: true },
  { id: 'note', label: 'New note', icon: 'square-pen', keywords: 'write create document', shortcut: 'n', action: 'shell.new-note', pinned: true },
  { id: 'today', label: 'Today’s note', icon: 'calendar', keywords: 'daily journal date', action: 'shell.today-note', pinned: true },
  { id: 'ask', label: 'Ask AI', icon: 'sparkles', keywords: 'assistant chat claude chatgpt grok question', shortcut: 'mod+shift+a', action: 'shell.ask', pinned: true },
  // In the full tab the active tab is Still itself, so saving "this page" only makes sense from the side panel.
  { id: 'save-page', label: 'Save this page', icon: 'bookmark-plus', keywords: 'current tab capture clip', action: 'shell.save-page', when: ctx => ext(ctx) && ctx.env.isSidepanel, pinned: true },
  { id: 'save-article', label: 'Save article', icon: 'newspaper', keywords: 'reader readable full text markdown clip capture page content',
    action: 'add.save-article', when: ctx => ext(ctx) && ctx.env.isSidepanel && hasAction('add.save-article') },
  { id: 'select-parts', label: 'Select parts of this page', icon: 'square-dashed-mouse-pointer', keywords: 'picker pick elements region selection clip capture',
    action: 'add.select-parts', when: ctx => ext(ctx) && ctx.env.isSidepanel && hasAction('add.select-parts') },
  { id: 'save-tabs', label: 'Save all tabs', icon: 'layers', keywords: 'window session collection', action: 'add.save-tabs', when: ctx => ext(ctx) && hasAction('add.save-tabs') },
  { id: 'upload', label: 'Upload files', icon: 'upload', keywords: 'pdf image attach', action: 'add.upload', when: () => hasAction('add.upload') },
  { id: 'autotag', label: 'Organize tags with AI', icon: 'tags', keywords: 'auto tag tagging label categorize clean up merge reorganize assistant',
    action: 'autotag.open', when: () => hasAction('autotag.open'), data: ctx => ({ collection: currentCollection(ctx)?.id || '' }) },
  { id: 'new-collection', label: 'New collection', icon: 'folder-plus', keywords: 'folder create group', action: 'collections.new', pinned: true },
  // Pin or unpin the collection on screen (the collection's own header and sidebar menu do the same).
  { id: 'pin-collection', label: 'Pin this collection to the sidebar', icon: 'pin', keywords: 'favorite keep top',
    action: 'collections.pin', when: ctx => !!currentCollection(ctx) && !currentCollection(ctx).pinned, data: ctx => ({ id: currentCollection(ctx).id }) },
  { id: 'unpin-collection', label: 'Unpin this collection', icon: 'pin-off', keywords: 'remove favorite top',
    action: 'collections.pin', when: ctx => !!currentCollection(ctx)?.pinned, data: ctx => ({ id: currentCollection(ctx).id }) },
  { id: 'go-dashboard', label: 'Go to Dashboard', icon: 'layout-dashboard', keywords: 'home start page new tab widgets', view: 'dashboard' },
  { id: 'assistant', label: 'Open AI Assistant', icon: 'bot-message-square', keywords: 'full screen chat conversations history', view: 'assistant' },
  { id: 'go-all', label: 'Go to All items', icon: 'book-open-text', keywords: 'everything library', view: 'all' },
  { id: 'go-inbox', label: 'Go to Inbox', icon: 'inbox', keywords: 'unsorted', view: 'inbox' },
  { id: 'go-favorites', label: 'Go to Favorites', icon: 'star', keywords: 'starred', view: 'favorites' },
  { id: 'go-notes', label: 'Go to Notes', icon: 'sticky-note', keywords: 'writing', view: 'notes' },
  { id: 'go-chats', label: 'Go to Chats', icon: 'messages-square', keywords: 'ai threads conversations threadkeeper chatgpt claude gemini coding agent sessions transcripts', view: 'chats' },
  { id: 'add-chats', label: 'Add AI chats from Threadkeeper', icon: 'messages-square', keywords: 'import threads conversations chatgpt claude gemini codex coding agent sessions pull collection',
    action: 'threadkeeper.picker-open', when: () => hasAction('threadkeeper.picker-open') },
  { id: 'go-stickies', label: 'Go to Sticky notes', icon: 'sticker', keywords: 'post-it memo board', view: 'stickies' },
  { id: 'new-sticky', label: 'New sticky note', icon: 'sticker', keywords: 'post-it memo quick jot', action: 'stickies.new', when: () => hasAction('stickies.new') },
  { id: 'add-widget', label: 'Add widget', icon: 'layout-grid', keywords: 'dashboard gallery clock weather github linear kanban', view: 'dashboard', action: 'dashboard.add-widget',
    when: ctx => full(ctx) && hasAction('dashboard.add-widget') },
  { id: 'edit-dashboard', label: 'Edit dashboard layout', icon: 'move-diagonal-2', keywords: 'arrange resize move widgets', view: 'dashboard', action: 'dashboard.edit',
    when: ctx => full(ctx) && hasAction('dashboard.edit') },
  { id: 'go-tasks', label: 'Go to Tasks', icon: 'list-checks', keywords: 'todo checklist', view: 'tasks', when: full },
  { id: 'go-highlights', label: 'Go to Highlights', icon: 'highlighter', keywords: 'quotes marks', view: 'highlights' },
  { id: 'go-map', label: 'Go to Knowledge map', icon: 'waypoints', keywords: 'graph links connections', view: 'map' },
  { id: 'go-archive', label: 'Go to Archive', icon: 'archive', view: 'archive' },
  { id: 'go-trash', label: 'Go to Trash', icon: 'trash-2', keywords: 'deleted restore', view: 'trash' },
  { id: 'open-full', label: 'Open in full tab', icon: 'external-link', keywords: 'window expand', action: 'app.open-full', when: ctx => ctx.env.isSidepanel },
  { id: 'sidebar', label: 'Show or hide the sidebar', icon: 'panel-left', keywords: 'toggle navigation', shortcut: 'mod+\\', action: 'shell.toggle-sidebar', when: full },
  { id: 'theme', label: ctx => (document.documentElement.dataset.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'), icon: 'sun-moon', keywords: 'appearance mode dark light', action: 'shell.toggle-theme' },
  { id: 'settings', label: 'Open settings', icon: 'settings', keywords: 'preferences options', action: 'shell.settings', data: { section: 'general' } },
  { id: 'appearance', label: 'Appearance & themes', icon: 'palette', keywords: 'skin liquid glass white midnight nord paper rose font size text corners density',
    action: 'shell.settings', data: { section: 'appearance' } },
  { id: 'newtab', label: 'New tab & dashboard', icon: 'app-window', keywords: 'start page wallpaper background search engine greeting',
    action: 'shell.settings', data: { section: 'newtab' } },
  { id: 'accounts', label: 'Connected accounts', icon: 'key-round', keywords: 'github linear product hunt token sign in oauth',
    action: 'shell.settings', data: { section: 'accounts' } },
  { id: 'ai-models', label: 'AI models', icon: 'bot', keywords: 'settings provider api key anthropic claude openai ollama', action: 'shell.settings', data: { section: 'ai' } },
  { id: 'assistant-permissions', label: 'Assistant permissions', icon: 'shield-check', keywords: 'settings ai trust level ask cautious standard trusted approval', action: 'shell.settings', data: { section: 'assistant' } },
  { id: 'research-settings', label: 'Research agent settings', icon: 'telescope', keywords: 'settings ai claude managed agents depth subpages budget spending cap github', action: 'shell.settings', data: { section: 'research' } },
  { id: 'semantic', label: 'Semantic search settings', icon: 'brain', keywords: 'embeddings index voyage', action: 'shell.settings', data: { section: 'search' } },
  { id: 'threadkeeper', label: 'AI chat threads (Threadkeeper)', icon: 'messages-square', keywords: 'threadkeeper threads chats transcripts sync connect chatgpt claude gemini coding agents', action: 'shell.settings', data: { section: 'integrations', anchor: 'settings-threadkeeper' } },
  { id: 'agents', label: 'Connect Claude Code or Codex', icon: 'terminal', keywords: 'mcp agents bridge desktop', action: 'shell.settings', data: { section: 'agents' } },
  { id: 'backup', label: 'Back up or bring in bookmarks', icon: 'folder-input', keywords: 'import export backup raindrop chrome html csv', action: 'shell.settings', data: { section: 'library' } },
  { id: 'daydock', label: 'Export for DayDock', icon: 'download', keywords: 'daydock move migrate export transfer', action: 'shell.settings', data: { section: 'library' } },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', keywords: 'keys hotkeys', shortcut: '?', action: 'shell.settings', data: { section: 'shortcuts' } },
  { id: 'help', label: 'Help', icon: 'circle-help', keywords: 'support docs guide search syntax', action: 'shell.settings', data: { section: 'help' } },
];

const normalize = text => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

function termScore(term, text, loose) {
  if (!term) return 1;
  if (!text) return 0;
  if (text === term) return 100;
  if (text.startsWith(term)) return 90 - Math.min(10, (text.length - term.length) / 4);
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.some(word => word.startsWith(term))) return 70;
  const at = text.indexOf(term);
  if (at >= 0) return 55 - Math.min(10, at / 4);
  if (!loose) return 0;
  if (term.length > 1 && words.length > 1 && words.map(word => word[0]).join('').startsWith(term)) return 50;
  // Tight subsequence: every letter in order with few skipped characters (typos like "nts" for "notes").
  let index = -1, gaps = 0;
  for (const char of term) {
    const next = text.indexOf(char, index + 1);
    if (next < 0) return 0;
    if (index >= 0) gaps += next - index - 1;
    index = next;
  }
  return gaps <= term.length ? Math.max(1, 30 - gaps * 4) : 0;
}

/**
 * Fuzzy-ish match score (0 = no match, higher is better). Every word of the query must match. loose: false limits
 * matching to prefixes and substrings (used for keyword lists, where subsequences find nonsense).
 */
export function fuzzyScore(query, text, { loose = true } = {}) {
  const target = normalize(text);
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return 1;
  let total = 0;
  for (const term of terms) {
    const score = termScore(term, target, loose);
    if (!score) return 0;
    total += score;
  }
  const phrase = normalize(query).trim();
  return total / terms.length + (terms.length > 1 && target.includes(phrase) ? 15 : 0);
}

/** Commands matching a query, best first. Labels count fully, keywords a little less. */
export function rankCommands(commands, query, label = command => command.label) {
  return commands
    .map((command, index) => ({ command, index,
      score: Math.max(fuzzyScore(query, label(command)), fuzzyScore(query, `${label(command)} ${command.keywords || ''}`, { loose: false }) * 0.8) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.command);
}

const palette = { query: '', active: 0, activeKey: '', moved: false, options: [], semantic: null, timer: 0, controller: null, focusListener: false };
let recent = { stamp: null, prefs: '', list: [] };
const labelOf = (ctx, command) => (typeof command.label === 'function' ? command.label(ctx) : command.label);

/** Opens the palette (or refocuses it). query prefills the input. */
export function openCommandPalette(ctx, { query = '' } = {}) {
  palette.query = query;
  palette.activeKey = '';
  palette.moved = false;
  palette.semantic = null;
  if (ctx.state.dialogs.some(d => d.name === DIALOG)) {
    ctx.render();
    ctx.nextFrame(() => { const input = document.getElementById('command-input'); input?.focus(); input?.select(); });
  } else ctx.openDialog(DIALOG, { size: 'lg' });
  if (query) scheduleSemantic(ctx);
  if (!palette.focusListener) {
    palette.focusListener = true;
    // Hovering an option makes it the active one, like a native list.
    document.addEventListener('pointermove', event => {
      const option = event.target?.closest?.('#command-listbox [role="option"]');
      if (!option || option.dataset.key === palette.activeKey) return;
      palette.activeKey = option.dataset.key;
      palette.moved = true;
      ctx.render();
    });
  }
}

function scheduleSemantic(ctx) {
  clearTimeout(palette.timer);
  palette.controller?.abort();
  const query = palette.query.trim();
  if (!ctx.ai?.searchLibrary || query.length < 2 || WEB_URL.test(query)) return;
  palette.timer = setTimeout(async () => {
    const controller = new AbortController();
    palette.controller = controller;
    try {
      const results = await ctx.ai.searchLibrary(query, { limit: 8, mode: 'hybrid', signal: controller.signal });
      if (controller.signal.aborted || palette.query.trim() !== query) return;
      palette.semantic = { query, results: Array.isArray(results) ? results : [] };
      ctx.render();
    } catch (error) {
      if (!controller.signal.aborted) console.info('[still] palette search fell back to text matching', error?.message);
    }
  }, 180);
}

function recentItems(ctx) {
  const ids = ctx.prefs.get('recentItems', []);
  const stamp = ctx.library?.updatedAt;
  if (recent.stamp === stamp && recent.prefs === ids.join()) return recent.list;
  const picked = ids.map(id => ctx.select.byId(id)).filter(item => item && !item.deletedAt && !item.archived);
  const seen = new Set(picked.map(item => item.id));
  const latest = ctx.select.itemsForView({ view: 'all', sort: 'updated' }).filter(item => !seen.has(item.id));
  recent = { stamp, prefs: ids.join(), list: [...picked, ...latest].slice(0, 5) };
  return recent.list;
}

export function itemOption(ctx, item, extra = {}) {
  const path = item.collectionId ? ctx.select.path(item.collectionId).map(c => c.name).join(' / ') : 'Inbox';
  const pagePath = pathOfItem(ctx, item);
  const where = item.type === 'note' ? ['Note', pagePath, path].filter(Boolean).join(' · ')
    : item.type === 'chat' ? [itemSource(item), item.chat?.project, path].filter(Boolean).join(' · ')
    : [domainOf(item.url), pagePath, path].filter(Boolean).join(' · ');
  return {
    kind: 'item', key: `item:${item.id}`, label: item.title || domainOf(item.url) || 'Untitled', hint: extra.snippet ? [pagePath, extra.snippet].filter(Boolean).join(' · ') : where,
    leading: item.type === 'chat' ? html`<span class="command-glyph">${icon(chatGlyph(item), { size: 16 })}</span>`
      : item.type === 'note' || !item.url ? html`<span class="command-glyph">${icon(TYPE_ICONS[item.type] || 'file', { size: 16 })}</span>` : favicon(item.url, { size: 18 }),
    meta: extra.semantic ? html`<span class="command-meta-semantic" title="Related by meaning">${icon('sparkles', { size: 12 })}</span>${TYPE_LABELS[item.type] || ''}` : TYPE_LABELS[item.type] || '',
    altLabel: item.url ? 'Open link' : null,
    run: (ctx, { alt }) => {
      ctx.prefs.set('recentItems', [item.id, ...ctx.prefs.get('recentItems', []).filter(id => id !== item.id)].slice(0, 20));
      if (alt && item.url) return ctx.dispatch('app.open-url', { data: { url: item.url } });
      ctx.openItem(item.id);
    },
  };
}

function collectionOption(ctx, collection) {
  const path = ctx.select.path(collection.id).slice(0, -1).map(c => c.name).join(' / ');
  return {
    kind: 'collection', key: `collection:${collection.id}`, label: collection.name, hint: path,
    leading: collectionIcon(collection, { size: 20 }), meta: (ctx.select.counts().byCollectionDeep[collection.id] || 0).toLocaleString(),
    altLabel: 'Open in new tab',
    run: (ctx, { alt }) => {
      if (alt) return openInNewTab(ctx, `collection:${collection.id}`);
      ctx.prefs.touchCollection(collection.id);
      ctx.navigate(`collection:${collection.id}`);
    },
  };
}

function commandOption(ctx, command) {
  return {
    kind: 'command', key: `command:${command.id}`, label: labelOf(ctx, command),
    leading: html`<span class="command-glyph">${icon(command.icon, { size: 16 })}</span>`,
    meta: command.shortcut ? kbd(command.shortcut) : '',
    run: ctx => {
      if (!command.action) return goToView(ctx, command.view);
      const data = typeof command.data === 'function' ? command.data(ctx) : command.data;
      const act = () => ctx.dispatch(command.action, { data: { ...(data || {}) } });
      if (!command.view || ctx.state.view === command.view) return act();
      // The action belongs to the view (e.g. Add widget on the dashboard): open the view, then run it once it renders.
      goToView(ctx, command.view);
      ctx.nextFrame(() => ctx.run(act));
    },
  };
}

function openInNewTab(ctx, view) {
  const base = ctx.env.isExtension ? globalThis.chrome.runtime.getURL('index.html') : new URL('index.html', location.href).href;
  const url = new URL(base);
  url.searchParams.set('libraryView', view);
  if (ctx.env.isExtension) return globalThis.chrome.tabs.create({ url: url.href });
  window.open(url.href, '_blank', 'noopener');
}

/** Builds the visible sections for the current query: [{ id, label, options }]. */
function buildSections(ctx) {
  const query = palette.query.trim();
  const commands = COMMANDS.filter(command => !command.when || command.when(ctx));
  const sections = [];
  if (!query) {
    sections.push({ id: 'recent', label: 'Recent', options: recentItems(ctx).map(item => itemOption(ctx, item)) });
    // Pinned collections lead the empty palette, then the recent ones that are not already listed.
    const pinned = ctx.select.pinnedCollections().slice(0, 6);
    const listed = new Set(pinned.map(c => c.id));
    if (pinned.length) sections.push({ id: 'pinned', label: 'Pinned', options: pinned.map(c => collectionOption(ctx, c)) });
    sections.push({ id: 'collections', label: 'Collections', options: ctx.select.recentCollections(4 + listed.size).filter(c => !listed.has(c.id)).slice(0, 4).map(c => collectionOption(ctx, c)) });
    sections.push({ id: 'commands', label: 'Commands', options: commands.filter(c => c.pinned).map(c => commandOption(ctx, c)) });
    return sections.filter(section => section.options.length);
  }
  if (WEB_URL.test(query)) {
    sections.push({ id: 'url', label: 'Link', options: [{
      kind: 'command', key: 'add-url', label: `Add ${domainOf(query) || 'this link'}`, hint: query,
      leading: html`<span class="command-glyph">${icon('bookmark-plus', { size: 16 })}</span>`,
      run: ctx => ctx.dispatch('shell.add', { data: { url: query } }),
    }] });
  }
  const matches = ctx.select.itemsForView({ view: 'all', query, sort: 'updated' });
  // Search engine hits (meaning first) lead; text matches fill the rest, so a narrower engine result never hides them.
  const semantic = palette.semantic?.query === query ? palette.semantic.results : [];
  const seen = new Set();
  const picked = [
    ...semantic.map(hit => ({ hit, item: ctx.select.byId(hit.id) })).filter(({ item }) => item && !item.deletedAt),
    ...matches.map(item => ({ hit: null, item })),
  ].filter(({ item }) => !seen.has(item.id) && seen.add(item.id)).slice(0, 8);
  const items = picked.map(({ hit, item }) => itemOption(ctx, item, { semantic: hit?.source === 'semantic' }));
  const shown = new Set(picked.map(({ item }) => item.id));
  if (matches.some(item => !shown.has(item.id))) {
    items.push({
      kind: 'command', key: 'all-results', label: `Show all ${matches.length.toLocaleString()} results`, hint: `for “${query}”`,
      leading: html`<span class="command-glyph">${icon('search', { size: 16 })}</span>`,
      run: ctx => { ctx.state.query = query; goToView(ctx, 'all', { keep: true }); },
    });
  }
  const results = [];
  // lead: how well the section's best entry matches by name, so "new note" or "settings" put Commands first.
  results.push({ id: 'items', label: 'Items', options: items, lead: Math.max(0, ...picked.map(({ item }) => fuzzyScore(query, item.title || ''))) });
  const collections = ctx.select.tree()
    .map(row => ({ row, score: Math.max(fuzzyScore(query, row.name), fuzzyScore(query, ctx.select.path(row.id).map(c => c.name).join(' ')) * 0.8) }))
    .filter(entry => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
  results.push({ id: 'collections', label: 'Collections', options: collections.map(entry => collectionOption(ctx, entry.row)), lead: collections[0]?.score || 0 });
  const matchedCommands = rankCommands(commands, query, command => labelOf(ctx, command)).slice(0, 8);
  const ranked = matchedCommands.map(command => commandOption(ctx, command));
  ranked.push({
    kind: 'command', key: 'ask-query', label: `Ask AI: ${query}`,
    leading: html`<span class="command-glyph is-accent">${icon('sparkles', { size: 16 })}</span>`,
    run: ctx => ctx.dispatch('shell.ask', { data: { prompt: query } }),
  });
  results.push({ id: 'commands', label: 'Commands', options: ranked, lead: Math.max(0, ...matchedCommands.map(command => fuzzyScore(query, labelOf(ctx, command)))) });
  return [...sections, ...orderSections(results)].filter(section => section.options.length);
}

/**
 * Orders result sections by their best name match (lead), keeping Items, Collections, Commands on ties. Weak leads
 * (content-only or keyword matches) never jump ahead, so a typed command name wins over items that merely mention it.
 */
export function orderSections(sections) {
  const strong = section => (section.lead >= 70 ? section.lead : 0);
  return sections.map((section, index) => ({ section, index }))
    .sort((a, b) => strong(b.section) - strong(a.section) || a.index - b.index)
    .map(({ section }) => section);
}

function renderPalette(ctx) {
  const sections = buildSections(ctx);
  const options = sections.flatMap(section => section.options);
  palette.options = options;
  // Late results (semantic search) keep the option the user moved to; otherwise the best match stays on top.
  palette.active = palette.moved ? Math.max(0, options.findIndex(option => option.key === palette.activeKey)) : 0;
  palette.activeKey = options[palette.active]?.key || '';
  const active = options[palette.active];
  let index = 0;
  const mod = kbd('mod+enter');
  return html`<h2 class="sr-only" id="dialog-title-${DIALOG}">Search and commands</h2>
    <div class="command-search">
      ${icon('search', { size: 18, className: 'command-search-icon' })}
      <input class="command-input" id="command-input" data-focus-key="command-input" type="text" value="${palette.query}" placeholder="Search items, collections and commands"
        role="combobox" aria-expanded="true" aria-controls="command-listbox" aria-autocomplete="list" aria-labelledby="dialog-title-${DIALOG}"
        ${active ? html`aria-activedescendant="command-option-${palette.active}"` : ''} autocomplete="off" spellcheck="false" data-autofocus
        data-input="command.query" data-keydown="command.key">
      ${kbd('esc')}
    </div>
    <div class="command-list" id="command-listbox" role="listbox" aria-label="Results">
      ${options.length ? sections.map(section => html`<div class="command-group" role="group" aria-label="${section.label}" data-key="group-${section.id}">
        <div class="command-heading" aria-hidden="true">${section.label}</div>
        ${section.options.map(option => {
          const i = index++;
          return html`<div class="${cx('command-option', i === palette.active && 'is-active')}" role="option" id="command-option-${i}" data-index="${i}"
            data-key="${option.key}" aria-selected="${i === palette.active ? 'true' : 'false'}" data-action="command.run">
            <span class="command-leading">${option.leading}</span>
            <span class="command-text"><span class="command-label">${option.label}</span>${option.hint ? html`<span class="command-hint">${option.hint}</span>` : ''}</span>
            <span class="command-meta">${option.meta || ''}</span>
          </div>`;
        })}</div>`)
        : html`<div class="command-empty"><p class="command-empty-title">No matches for “${palette.query}”</p><p>Try fewer words, or press Enter to ask AI.</p></div>`}
    </div>
    <footer class="command-footer" aria-hidden="true">
      <span>${kbd('↑')}${kbd('↓')} Move</span><span>${kbd('enter')} Open</span>
      ${active?.altLabel ? html`<span>${mod} ${active.altLabel}</span>` : ''}
      <span class="command-footer-end">${kbd('mod+k')} Close</span>
    </footer>
    <p class="sr-only" role="status">${options.length ? `${options.length} results` : 'No results'}</p>`;
}

registerDialog(DIALOG, renderPalette, { size: 'lg', className: 'command-palette' });

function runOption(ctx, index, { alt = false } = {}) {
  const option = palette.options[index];
  if (!option) {
    const query = palette.query.trim();
    if (!query) return;
    ctx.closeDialog(DIALOG);
    return ctx.dispatch('shell.ask', { data: { prompt: query } });
  }
  ctx.closeDialog(DIALOG);
  return option.run(ctx, { alt });
}

function moveActive(ctx, delta) {
  const count = palette.options.length;
  if (!count) return;
  palette.active = (palette.active + delta + count) % count;
  palette.activeKey = palette.options[palette.active].key;
  palette.moved = true;
  ctx.render();
  ctx.nextFrame(() => document.getElementById(`command-option-${palette.active}`)?.scrollIntoView({ block: 'nearest' }));
}

registerActions({
  'command.query': ({ ctx, el }) => {
    palette.query = el.value;
    palette.activeKey = '';
    palette.moved = false;
    ctx.render();
    scheduleSemantic(ctx);
  },
  'command.key': ({ ctx, event }) => {
    const mod = ctx.env.isMac ? event.metaKey : event.ctrlKey;
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) { event.preventDefault(); moveActive(ctx, 1); }
    else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) { event.preventDefault(); moveActive(ctx, -1); }
    else if (event.key === 'PageDown') { event.preventDefault(); moveActive(ctx, Math.min(5, palette.options.length - 1 - palette.active) || 0); }
    else if (event.key === 'PageUp') { event.preventDefault(); moveActive(ctx, -Math.min(5, palette.active) || 0); }
    else if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      ctx.renderNow(); // the options must reflect the latest keystroke before running one
      return runOption(ctx, palette.active, { alt: mod });
    }
    else if (mod && event.key.toLowerCase() === 'k') { event.preventDefault(); ctx.closeDialog(DIALOG); }
  },
  'command.run': ({ ctx, data, event }) => runOption(ctx, Number(data.index), { alt: ctx.env.isMac ? event?.metaKey : event?.ctrlKey }),
});
