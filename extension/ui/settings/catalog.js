// Settings sections, their navigation groups and the search matcher. Pure (no DOM, no chrome.*) so tests can import it.
// Views: the full tab shows Settings at 'settings' (section list on narrow screens, General on wide ones) and
// 'settings:<section>'; the side panel keeps the section in ctx.state.settings and opens it as panel { kind: 'settings' }.

export const SETTINGS_GROUPS = Object.freeze([
  { id: 'personalize', label: 'Personalize' },
  { id: 'library', label: 'Library' },
  { id: 'ai', label: 'AI' },
  { id: 'connections', label: 'Connections' },
  { id: 'help', label: 'Help' },
]);

// keywords: words people search for that are not in the section's own rows (synonyms, old names, brand names).
export const SETTINGS_SECTIONS = Object.freeze([
  { id: 'appearance', group: 'personalize', label: 'Appearance', icon: 'palette', summary: 'Theme, colors, text size and layout',
    description: 'Theme, colors, text size and layout. Changes apply right away to every Still page.',
    keywords: 'theme skin look dark light mode accent color colour font text size zoom density compact radius corners rounded sidebar width transparency glass blur motion animation favicon website icons' },
  { id: 'newtab', group: 'personalize', label: 'New tab & dashboard', icon: 'layout-dashboard', summary: 'Start page, search, wallpaper and boards',
    description: 'What a new tab opens to, and how the dashboard looks: search, greeting, wallpaper and boards.',
    keywords: 'new tab start page home homepage search engine google duckduckgo bing kagi brave perplexity greeting name wallpaper background image photo dim blur widgets board dashboard sticky weather spacing' },
  { id: 'general', group: 'library', label: 'General', icon: 'settings-2', summary: 'Default collection, side panel, deleting',
    description: 'How saving and the side panel behave.', keywords: 'save default collection inbox side panel toolbar trash delete confirm' },
  { id: 'library', group: 'library', label: 'Library & backup', icon: 'hard-drive', summary: 'Backup, snapshots, import, export, storage',
    description: 'Back up everything, restore snapshots, bring in bookmarks and manage storage on this device.',
    keywords: 'backup restore import export bookmarks html csv markdown raindrop chrome storage trash files snapshot snapshots undo rollback history version chats conversations ai spreadsheet excel' },
  { id: 'ai', group: 'ai', label: 'AI models', icon: 'sparkles', summary: 'Providers, default models, local bridge',
    description: 'Connect the models Still uses for Ask, note writing tools and save suggestions.',
    keywords: 'ai model provider api key anthropic claude openai gpt chatgpt gemini ollama openrouter bridge assistant chat' },
  { id: 'assistant', group: 'ai', label: 'Assistant permissions', icon: 'shield-check', summary: 'Changes the assistant makes without asking',
    description: 'Choose which changes the assistant applies right away and which wait for your review. Every change can be undone.',
    keywords: 'permissions permission approve approval ask allow confirm review auto apply automatic trusted full access custom undo create organize edit delete dashboard collections links folders notes tags trash' },
  { id: 'research', group: 'ai', label: 'Research agent', icon: 'telescope', summary: 'Web and GitHub research for saved pages',
    description: 'How Research with AI reads a saved page, searches the web and GitHub, and writes what it finds into the page.',
    keywords: 'research agent expand deep dive web search fetch github managed agents claude sonnet anthropic subpages budget spending cost cap depth' },
  { id: 'search', group: 'ai', label: 'Semantic search', icon: 'brain', summary: 'Embeddings and the search index',
    description: 'Find items by meaning, not only by matching words.', keywords: 'semantic embeddings index vector voyage meaning' },
  { id: 'agents', group: 'ai', label: 'Agents & MCP', icon: 'terminal', summary: 'Claude Code, Codex, Claude Desktop',
    description: 'Let coding agents search and organize your library through MCP.', keywords: 'mcp agents claude code codex cursor vs code desktop bridge tools skill' },
  { id: 'accounts', group: 'connections', label: 'Connected accounts', icon: 'key-round', summary: 'GitHub, Linear and other services',
    description: 'Accounts that dashboard widgets use to show your pull requests, issues and more. Credentials stay on this device.',
    keywords: 'accounts sign in login oauth token api key github linear product hunt credentials' },
  { id: 'integrations', group: 'connections', label: 'Integrations', icon: 'plug', summary: 'AI chat threads, Raindrop.io and other apps',
    description: 'Bring in your AI chats from Threadkeeper, and move links between Still and the apps you already use.',
    keywords: 'integrations raindrop notion readwise zapier make n8n rss drive dropbox threadkeeper threads chats transcripts chatgpt claude gemini coding agent sessions paperclip' },
  { id: 'shortcuts', group: 'help', label: 'Keyboard shortcuts', icon: 'keyboard', summary: 'Keys in Still and in Chrome',
    description: 'Keys that work inside Still, and the Chrome keys that work on any page.', keywords: 'keyboard shortcuts keys hotkeys commands' },
  { id: 'about', group: 'help', label: 'About', icon: 'info', summary: 'Version and where your data lives',
    description: 'Version, where your data lives and how to get help.', keywords: 'about version privacy data storage' },
  { id: 'help', group: 'help', label: 'Help', icon: 'circle-help', summary: 'Getting started, search syntax, references',
    description: 'Getting started, search syntax and the reference room.', keywords: 'help guide getting started search syntax docs references' },
]);

const SECTION_IDS = new Set(SETTINGS_SECTIONS.map(section => section.id));
// Section ids from earlier versions and natural aliases, so old deep links keep working.
const ALIASES = { theme: 'appearance', themes: 'appearance', 'new-tab': 'newtab', dashboard: 'newtab', wallpaper: 'newtab', backup: 'library',
  models: 'ai', providers: 'ai', mcp: 'agents', account: 'accounts', keys: 'shortcuts', permissions: 'assistant', approvals: 'assistant', threadkeeper: 'integrations' };

export const isSection = id => SECTION_IDS.has(id);
export const sectionById = id => SETTINGS_SECTIONS.find(section => section.id === id) || null;
/** A known section id (aliases resolved) or the fallback ('general'). */
export function normalizeSection(id, fallback = 'general') {
  const value = String(id || '').toLowerCase();
  if (SECTION_IDS.has(value)) return value;
  if (ALIASES[value]) return ALIASES[value];
  return fallback;
}

/** The section named by a full-tab view ('settings:appearance' -> 'appearance'), or '' for the bare 'settings' view. */
export function sectionFromView(view) {
  const match = /^settings(?::([a-z-]+))?$/.exec(String(view || ''));
  if (!match) return '';
  return match[1] ? normalizeSection(match[1], '') : '';
}
export const settingsView = section => `settings:${normalizeSection(section)}`;

/** Sections grouped for the navigation: [{ id, label, sections }]. `include` limits which section ids appear. */
export function groupSections(include = null) {
  const keep = include ? new Set(include) : null;
  return SETTINGS_GROUPS.map(entry => ({ ...entry, sections: SETTINGS_SECTIONS.filter(s => s.group === entry.id && (!keep || keep.has(s.id))) }))
    .filter(entry => entry.sections.length);
}

/** Neighbouring sections in navigation order, for "previous / next" links. */
export function adjacentSections(id) {
  const index = SETTINGS_SECTIONS.findIndex(section => section.id === id);
  return { previous: index > 0 ? SETTINGS_SECTIONS[index - 1] : null, next: index >= 0 ? SETTINGS_SECTIONS[index + 1] || null : null };
}

/* ------------------------------------------------------------------ search */

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const fold = text => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'").toLowerCase();

/** Plain, lower-cased text of a string, html fragment or list of them (tags dropped, entities decoded, accents folded). */
export function textOf(value) {
  if (value == null || value === false || value === true) return '';
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(' ');
  const text = String(value).replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, entity => ENTITIES[entity]);
  return fold(text).replace(/\s+/g, ' ').trim();
}

/** Search words from a query: lower-cased, accents folded, at most 8, duplicates dropped. */
export function searchTerms(query) {
  return [...new Set(textOf(query).split(/[\s,]+/).filter(Boolean))].slice(0, 8);
}

/** True when every term appears somewhere in the given texts (strings, fragments or arrays of them). No terms match all. */
export function matchesTerms(terms, ...texts) {
  if (!terms?.length) return true;
  const haystack = textOf(texts);
  return terms.every(term => haystack.includes(term));
}

/** Sections whose own name, summary, description or keywords match the query (the catalog-level search). */
export function matchSections(query) {
  const terms = searchTerms(query);
  if (!terms.length) return SETTINGS_SECTIONS.slice();
  return SETTINGS_SECTIONS.filter(section => matchesTerms(terms, section.label, section.summary, section.description, section.keywords, groupLabel(section.group)));
}

const groupLabel = id => SETTINGS_GROUPS.find(entry => entry.id === id)?.label || '';
