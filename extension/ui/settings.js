// Settings and help (SPEC.md §7.4, §13). One dialog: a section nav beside the content in the full tab, a section list
// with drill-in in the side panel. Sections: general, appearance, library, ai, search, agents, integrations, shortcuts,
// about, help. Library settings go through ctx.store.updateSettings (app.js applies theme, accent and density); AI
// configuration goes through the ctx.ai facade; bridge, MCP and Raindrop through lib/integrations.js.
import { html, cx, plural, safeHref, safeSrc } from './html.js';
import { icon } from './icons.js';
import { button, iconButton, segmented, select, switchToggle, field, input, badge, spinner, emptyState, kbd, collectionIcon, chip, fileSize, relativeDate, shortDate } from './components.js';
import { registerDialog } from './overlay.js';
import { registerActions, listShortcuts } from './runtime.js';
import { renderCollectionPickerTrigger } from './pickers.js';
import { brandMark } from './sidebar.js';
import * as integrations from '../lib/integrations.js';
import { createFullBackup, importPortableFile, exportBookmarkHtml, exportNotesMarkdown } from '../lib/portability.js';
import { REFERENCE_ASSETS } from '../lib/references.js';

const DIALOG = 'settings';
const CONNECT = 'settings.connect';
const REPO = 'https://github.com/AVRCORP/sidebar-dock';
const SHORTCUTS_PAGE = 'chrome://extensions/shortcuts';
const RAINDROP_ORIGIN = 'https://api.raindrop.io/*';

/* ------------------------------------------------------------------ static content */

export const SETTINGS_SECTIONS = Object.freeze([
  { id: 'general', label: 'General', icon: 'settings-2', summary: 'Default collection, side panel, deleting', description: 'How saving and the side panel behave.' },
  { id: 'appearance', label: 'Appearance', icon: 'palette', summary: 'Theme, accent color, density', description: 'Theme, accent color and density. Changes apply right away.' },
  { id: 'library', label: 'Library & backup', icon: 'hard-drive', summary: 'Backup, import, export, storage', description: 'Back up your library, bring in bookmarks and manage storage on this device.' },
  { id: 'ai', label: 'AI models', icon: 'sparkles', groupStart: true, summary: 'Providers, default models, local bridge', description: 'Connect the models Still uses for Ask, note writing tools and save suggestions.' },
  { id: 'search', label: 'Semantic search', icon: 'brain', summary: 'Embeddings and the search index', description: 'Find items by meaning, not only by matching words.' },
  { id: 'agents', label: 'Agents & MCP', icon: 'terminal', summary: 'Claude Code, Codex, Claude Desktop', description: 'Let coding agents search and organize your library through MCP.' },
  { id: 'integrations', label: 'Integrations', icon: 'plug', groupStart: true, summary: 'Raindrop.io and other apps', description: 'Move links between Still and the apps you already use.' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', summary: 'Keys in Still and in Chrome', description: 'Keys that work inside Still, and the Chrome keys that work on any page.' },
  { id: 'about', label: 'About', icon: 'info', summary: 'Version and where your data lives', description: 'Version, where your data lives and how to get help.' },
  { id: 'help', label: 'Help', icon: 'circle-help', summary: 'Getting started, search syntax, references', description: 'Getting started, search syntax and the reference room.' },
]);
const SECTION_IDS = new Set(SETTINGS_SECTIONS.map(section => section.id));
export const normalizeSection = section => (SECTION_IDS.has(section) ? section : 'general');

// Order and labels follow tokens.css (Settings > Appearance). "amber" is an alias of gold and is not offered.
export const ACCENTS = Object.freeze([
  { id: 'blue', label: 'Blue' }, { id: 'teal', label: 'Teal' }, { id: 'green', label: 'Green' }, { id: 'gold', label: 'Raindrop gold' },
  { id: 'orange', label: 'Orange' }, { id: 'pink', label: 'Pink' }, { id: 'graphite', label: 'Graphite' },
]);
const THEMES = [{ value: 'system', label: 'System', icon: 'sun-moon' }, { value: 'light', label: 'Light', icon: 'sun' }, { value: 'dark', label: 'Dark', icon: 'moon' }];
const DENSITIES = [{ value: 'comfortable', label: 'Comfortable', icon: 'rows-3' }, { value: 'compact', label: 'Compact', icon: 'list' }];
const HANDOFF_CHOICES = ['claude', 'chatgpt', 'grok'];

// Letter or icon tiles for providers and clients (no brand artwork ships with the extension).
const MARKS = {
  anthropic: { text: 'A', color: 'orange' }, openai: { text: 'O', color: 'green' }, xai: { text: 'x', color: 'gray' }, google: { text: 'G', color: 'blue' },
  openrouter: { text: 'OR', color: 'indigo' }, mistral: { text: 'M', color: 'amber' }, groq: { text: 'G', color: 'red' }, deepseek: { text: 'D', color: 'cyan' },
  perplexity: { text: 'P', color: 'teal' }, voyage: { text: 'V', color: 'violet' }, cohere: { text: 'C', color: 'pink' },
  ollama: { icon: 'cpu', color: 'gray' }, lmstudio: { text: 'LM', color: 'gray' }, 'custom-openai': { icon: 'network', color: 'gray' }, 'custom-anthropic': { icon: 'network', color: 'gray' },
  bridge: { icon: 'plug-zap', color: 'blue' }, 'agent:claude-code': { icon: 'terminal', color: 'orange' }, 'agent:codex': { icon: 'terminal', color: 'gray' },
  'chatgpt-oauth': { icon: 'message-circle', color: 'green' }, raindrop: { icon: 'cloud', color: 'blue' }, cursor: { text: 'Cu', color: 'gray' },
  vscode: { icon: 'code-xml', color: 'blue' }, chrome: { icon: 'globe', color: 'blue' }, opencode: { text: 'OC', color: 'gray' }, gemini: { text: 'G', color: 'blue' }, 'claude-desktop': { text: 'A', color: 'orange' },
};

export const MCP_CLIENTS = Object.freeze([
  { id: 'claude', name: 'Claude Code', mark: 'agent:claude-code', blurb: 'Anthropic’s coding agent for the terminal and IDEs.', docs: 'https://code.claude.com/docs/en/mcp',
    manual: setup => [{ label: 'Run once in a terminal', code: setup.claudeCommand }] },
  { id: 'codex', name: 'Codex', mark: 'agent:codex', blurb: 'OpenAI’s coding agent for the terminal and IDEs.', docs: 'https://developers.openai.com/codex/mcp/',
    manual: setup => [{ label: 'Run once in a terminal', code: setup.codexCommand }, { label: 'Or add this to ~/.codex/config.toml', code: setup.codex }] },
  { id: 'claude-desktop', name: 'Claude Desktop', mark: 'claude-desktop', blurb: 'The Claude app for macOS and Windows.', docs: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers',
    manual: setup => [{ label: 'In Claude Desktop, open Settings, choose Developer, then Edit config, and add', code: setup.claudeDesktop }],
    note: 'Quit and reopen Claude Desktop after the change.' },
  { id: 'cursor', name: 'Cursor', mark: 'cursor', blurb: 'The AI code editor.', docs: 'https://cursor.com/docs/mcp',
    manual: setup => [{ label: 'Add this to ~/.cursor/mcp.json', code: setup.cursor }] },
  { id: 'vscode', name: 'VS Code', mark: 'vscode', blurb: 'Agent mode in Visual Studio Code.', bridge: false, docs: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
    manual: setup => [{ label: 'Run “MCP: Open User Configuration” from the Command Palette and add', code: setup.vscode }] },
]);

// Agents the bridge can connect beyond MCP_CLIENTS (GET /connections); they have no snippet in getMcpSetup.
const EXTRA_CLIENT_BLURBS = { opencode: 'The open source coding agent for the terminal.', gemini: 'Google’s Gemini agent for the terminal.' };

// The bridge's MCP tools (bridge/protocol.mjs TOOLS; tests keep the two lists in step).
export const MCP_TOOLS = Object.freeze([
  { name: 'bridge_status', write: false, text: 'Check that Still is open and in sync' },
  { name: 'library_capabilities', write: false, text: 'Describe what agents can read and change' },
  { name: 'search_library', write: false, text: 'Search by keyword' },
  { name: 'semantic_search', write: false, text: 'Search by meaning (needs Semantic search)' },
  { name: 'list_items', write: false, text: 'List items, including archived and trashed ones' },
  { name: 'get_item', write: false, text: 'Read an item with its notes and highlights' },
  { name: 'get_related_items', write: false, text: 'Read links and backlinks' },
  { name: 'list_collections', write: false, text: 'List collections' },
  { name: 'get_collection', write: false, text: 'Read one collection' },
  { name: 'list_tags', write: false, text: 'List tags with counts' },
  { name: 'export_item', write: false, text: 'Export one item as JSON or Markdown' },
  { name: 'export_library', write: false, text: 'Export the library page by page' },
  { name: 'read_file', write: false, text: 'Read an attached file in chunks' },
  { name: 'get_operation', write: false, text: 'Check whether a change was saved' },
  { name: 'create_item', write: true, text: 'Save a page into a collection or write a note' },
  { name: 'update_item', write: true, text: 'Edit titles, notes, tags and other details' },
  { name: 'update_article_content', write: true, text: 'Replace saved article text' },
  { name: 'create_collection', write: true, text: 'Create a collection' },
  { name: 'update_collection', write: true, text: 'Rename, recolor or move a collection' },
  { name: 'delete_collection', write: true, text: 'Delete a collection (its items move to Inbox)' },
  { name: 'trash_item', write: true, text: 'Move an item to Trash' },
  { name: 'restore_item', write: true, text: 'Restore an item from Trash' },
  { name: 'permanently_delete_item', write: true, text: 'Delete a trashed item forever, after confirming' },
  { name: 'add_highlight', write: true, text: 'Add a highlight' },
  { name: 'update_highlight', write: true, text: 'Edit a highlight or its note' },
  { name: 'remove_highlight', write: true, text: 'Remove a highlight' },
  { name: 'link_items', write: true, text: 'Link one item to another' },
  { name: 'unlink_items', write: true, text: 'Remove a link between items' },
  { name: 'set_item_tags', write: true, text: 'Set an item’s tags' },
  { name: 'bulk_update_items', write: true, text: 'Move, tag or favorite up to 100 items at once' },
  { name: 'rename_tag', write: true, text: 'Rename a tag everywhere' },
  { name: 'remove_tag', write: true, text: 'Remove a tag everywhere' },
]);

// Chrome's own keys (manifest "commands"); chrome.commands.getAll() replaces these with the person's current keys.
export const CHROME_COMMANDS = Object.freeze([
  { name: 'save-current', description: 'Save this page to Still', shortcut: 'Alt+Shift+S' },
  { name: 'new-note', description: 'Write a note about this page', shortcut: 'Alt+Shift+N' },
  { name: 'open-library', description: 'Open Still in a new tab', shortcut: 'Alt+Shift+L' },
]);

const NOTE_KEYS = [
  { keys: '/', label: 'Insert a block (heading, list, table, callout…)' }, { keys: '[[', label: 'Link to a note or item', literal: true },
  { keys: 'mod+b', label: 'Bold' }, { keys: 'mod+i', label: 'Italic' }, { keys: 'mod+shift+x', label: 'Strikethrough' }, { keys: 'mod+e', label: 'Inline code' },
  { keys: 'mod+k', label: 'Link' }, { keys: 'mod+d', label: 'Duplicate the block' }, { keys: 'mod+/', label: 'Block menu' }, { keys: 'mod+z', label: 'Undo' },
];

const SEARCH_SYNTAX = [
  { code: 'design tokens', text: 'Items that contain every word' },
  { code: '"exact phrase"', text: 'Items that contain the phrase as written' },
  { code: 'tag:design  or  #design', text: 'Items with that tag. Several tags must all match.' },
  { code: 'type:note', text: 'One kind of item: link, article, note, image, video or file' },
  { code: 'site:github.com', text: 'Items from a site, including its subdomains' },
  { code: '#ai type:article agents', text: 'Mix them to narrow a search' },
];

const GETTING_STARTED = [
  { icon: 'bookmark-plus', title: 'Save a page', text: 'Open the side panel and choose Save, press Alt+Shift+S, or right-click a page and choose Save page to Still.' },
  { icon: 'folder-tree', title: 'Organize', text: 'Drag items onto collections, add tags, and use the + beside a collection to save straight into it.' },
  { icon: 'sticky-note', title: 'Write notes', text: 'Notes can belong to the page you are on. Type / for blocks and [[ to link notes and items.' },
  { icon: 'highlighter', title: 'Highlight', text: 'Select text on a page, right-click and choose Highlight selection. Highlights show up on the saved item.' },
  { icon: 'sparkles', title: 'Ask', text: 'Ask about this page, a collection or your whole library once a model is connected in AI models.' },
  { icon: 'terminal', title: 'Work with agents', text: 'Claude Code, Codex and Claude Desktop can search and organize your library through MCP.' },
];

const GUIDES = [
  { label: 'Install and first steps', url: `${REPO}/blob/HEAD/docs/INSTALL.md` },
  { label: 'AI providers and keys', url: `${REPO}/blob/HEAD/docs/ai-providers.md` },
  { label: 'Coding agents and MCP', url: `${REPO}/blob/HEAD/docs/mcp-agents.md` },
  { label: 'Bridge, Raindrop and backups', url: `${REPO}/blob/HEAD/docs/integrations.md` },
];

// Embedding list prices in USD per million input tokens, for the cost note when the catalog has none.
export const EMBEDDING_PRICES = Object.freeze({ 'text-embedding-3-small': 0.02, 'text-embedding-3-large': 0.13, 'mistral-embed': 0.1, 'gemini-embedding-001': 0.15 });

/* ------------------------------------------------------------------ pure helpers (tested) */

/** Badge for an AI connection: { label, tone } for components.badge. */
export function connectionStatus(connection) {
  if (!connection) return { label: 'Not connected', tone: 'neutral' };
  if (connection.enabled === false) return { label: 'Off', tone: 'neutral' };
  if (connection.status === 'ok') return { label: 'Connected', tone: 'success' };
  if (connection.status === 'error') return { label: 'Error', tone: 'danger' };
  return { label: 'Not tested', tone: 'neutral' };
}

/** The connection a provider tile edits: the working one first. Custom servers always add a new connection. */
export function providerConnection(connections = [], provider) {
  if (!provider || provider.kind === 'custom') return null;
  const mine = connections.filter(c => c.via === 'direct' && c.providerId === provider.id);
  return mine.find(c => c.status === 'ok') || mine.find(c => c.status === 'error') || mine[0] || null;
}

/** A saved key is never shown again: only its last four characters, when known, follow the mask. */
export function maskedKey(hint) {
  const tail = String(hint || '').replace(/\s+/g, '').slice(-4);
  return `••••••••${tail}`;
}

/** Catalog apps Still reaches through Raindrop.io or a backup file, grouped for Integrations. */
export function integrationGroups(catalog = []) {
  const others = catalog.filter(entry => !['claude', 'codex', 'raindrop'].includes(entry.id));
  const viaRaindrop = others.filter(entry => /^https:\/\/help\.raindrop\.io\//.test(entry.url || ''));
  const backup = others.filter(entry => !viaRaindrop.includes(entry) && entry.category === 'Backup');
  const rest = others.filter(entry => !viaRaindrop.includes(entry) && !backup.includes(entry));
  return [
    { id: 'raindrop', title: 'Through Raindrop.io', entries: viaRaindrop,
      description: 'Raindrop.io connects to these apps. Export your bookmarks as HTML from Library & backup, bring the file into Raindrop, then follow its guide.' },
    { id: 'backup', title: 'Keep a copy in the cloud', entries: backup,
      description: 'Download a full backup from Library & backup and keep the file in your own storage.' },
    { id: 'other', title: 'Other apps', entries: rest, description: 'Guides for moving links in and out of these apps.' },
  ].filter(entry => entry.entries.length);
}

/** Direct providers grouped for the "add a provider" grid. */
export function providerGroups(catalog = []) {
  const direct = catalog.filter(provider => provider.via === 'direct');
  return [
    { id: 'keys', title: 'Bring your own API key', providers: direct.filter(p => p.kind === 'cloud' && p.chat) },
    { id: 'embeddings', title: 'Embeddings for semantic search', providers: direct.filter(p => p.kind === 'cloud' && !p.chat && p.embeddings) },
    { id: 'local', title: 'Runs on this computer', providers: direct.filter(p => p.kind === 'local') },
    { id: 'custom', title: 'Your own server', providers: direct.filter(p => p.kind === 'custom') },
  ].filter(group => group.providers.length);
}

export const choiceValue = (connectionId, model) => `${connectionId}::${model}`;
export function parseChoice(value) {
  const text = String(value || '');
  const at = text.indexOf('::');
  return at < 0 ? { connectionId: '', model: '' } : { connectionId: text.slice(0, at), model: text.slice(at + 2) };
}

/** Chat models for the default-model selects, grouped by connection: [{ group, options: [{ value, label }] }]. */
export function modelChoices(connections = [], getProvider = () => null) {
  return connections.filter(c => c.enabled !== false && getProvider(c.providerId)?.chat).map(c => {
    const models = (c.models || []).filter(m => !m.capabilities?.embeddings);
    const list = models.length ? models : c.defaultModel ? [{ id: c.defaultModel, name: c.defaultModel }] : [];
    return { group: c.label || c.providerName || c.id, options: list.map(m => ({ value: choiceValue(c.id, m.id), label: m.name || m.id })) };
  }).filter(group => group.options.length);
}

/** The model record behind a { connectionId, model } setting, falling back to the connection's default model. */
export function findModel(connections = [], { connectionId = '', model = '' } = {}) {
  const connection = connections.find(c => c.id === connectionId);
  if (!connection) return { connection: null, model: null, id: '' };
  const id = model || connection.defaultModel || '';
  return { connection, model: (connection.models || []).find(m => m.id === id) || null, id };
}

/** Effort that stays valid when the model changes: the current one if supported, else the model default, else medium. */
export function effortFor(model, current = 'medium') {
  const efforts = model?.efforts || [];
  if (!efforts.length) return current;
  if (efforts.includes(current)) return current;
  if (model.defaultEffort && efforts.includes(model.defaultEffort)) return model.defaultEffort;
  return efforts.includes('medium') ? 'medium' : efforts[0];
}

/** Connections that can create embeddings, Voyage first (recommended with Claude). */
export function embeddingConnections(connections = []) {
  return connections.filter(c => c.via === 'direct' && c.enabled !== false && c.supports?.embeddings)
    .sort((a, b) => (b.providerId === 'voyage') - (a.providerId === 'voyage'));
}

/** Plain-language summary of the semantic index: { state, tone, label, detail, percent }. */
export function indexSummary(status) {
  if (!status) return { state: 'loading', tone: 'neutral', label: 'Checking', detail: 'Reading the index on this device.', percent: null };
  const total = Math.max(0, status.total || 0);
  const indexed = Math.min(Math.max(0, status.indexed || 0), total || Infinity);
  const percent = total ? Math.round((indexed / total) * 100) : 0;
  const counts = `${indexed.toLocaleString()} of ${plural(total, 'item')} indexed`;
  const failed = status.failed > 0 ? ` ${plural(status.failed, 'item')} could not be indexed.` : '';
  if (!status.enabled) {
    return { state: 'off', tone: 'neutral', label: 'Off', percent: null,
      detail: indexed ? `${plural(indexed, 'item')} indexed earlier. Turn on semantic search to keep the index up to date.` : 'Turn on semantic search to build the index.' };
  }
  if (status.error) return { state: 'error', tone: 'danger', label: 'Needs attention', detail: status.error, percent };
  if (status.running) return { state: 'running', tone: 'info', label: 'Indexing', detail: `${counts}.`, percent };
  if (status.waiting) return { state: 'waiting', tone: 'neutral', label: 'Waiting', detail: 'Another Still window is indexing. This one takes over when that window closes.', percent };
  if (status.paused) return { state: 'paused', tone: 'warning', label: 'Paused', detail: `${counts}. New and changed items wait until you resume.`, percent };
  if (status.pending > 0) return { state: 'pending', tone: 'neutral', label: 'Up next', detail: `${counts}. ${plural(status.pending, 'item')} waiting.${failed}`, percent };
  return { state: 'ready', tone: 'success', label: 'Up to date', detail: total ? `${counts}.${failed}` : 'Nothing to index yet.', percent: total ? percent : null };
}

const compactNumber = value => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);

/** Privacy and cost sentences for the semantic search section. price is USD per million tokens. */
export function embeddingNote({ providerName = '', local = false, tokens = 0, price = null } = {}) {
  const sentences = [];
  if (!providerName) return sentences;
  sentences.push(local
    ? `Item text stays on this computer: ${providerName} creates the embeddings locally.`
    : `Item text (titles, notes, highlights and saved article text) is sent to ${providerName} to create embeddings. The vectors are stored only on this device.`);
  if (tokens > 0) {
    const amount = `About ${compactNumber(tokens)} tokens left to index`;
    if (local) sentences.push(`${amount}. Local models have no per-token cost.`);
    else if (Number.isFinite(price) && price > 0) {
      const cost = (tokens / 1e6) * price;
      sentences.push(`${amount}, roughly ${cost < 0.01 ? 'less than $0.01' : `$${cost.toFixed(2)}`} at $${price} per million tokens.`);
    } else sentences.push(`${amount}. Check ${providerName}’s pricing page for the rate.`);
  }
  return sentences;
}

/** Live bridge state for badges: { state, tone, label, detail }. live is ctx.state.bridge from app.js's sync loop. */
export function bridgeSummary({ integration, live, bridge } = {}) {
  if (!integration?.bridgeConfigured) return { state: 'unpaired', tone: 'neutral', label: 'Not paired', detail: 'Pair the bridge to use Claude Code, Codex, your ChatGPT plan and MCP.' };
  if (!integration.bridgeEnabled) {
    return { state: 'paused', tone: 'warning', label: 'Sync paused', detail: integration.pausedHere
      ? 'Paused in this window until you resume or reload. Other open Still views keep syncing.' : 'Paired. Agents see the library as of the last sync until you resume.' };
  }
  if (live?.connected) return { state: 'connected', tone: 'success', label: 'Connected', detail: live.syncedAt ? `Synced ${since(live.syncedAt)}.` : 'Syncing.' };
  if (live && !live.connected) return { state: 'offline', tone: 'danger', label: 'Not running', detail: 'Start it with npm run bridge in the Still folder.' };
  if (bridge?.paired && !bridge.reachable) return { state: 'offline', tone: 'danger', label: 'Not running', detail: 'Start it with npm run bridge in the Still folder.' };
  return { state: 'connecting', tone: 'neutral', label: 'Connecting', detail: 'Checking the bridge on this computer.' };
}

const AUTH_METHODS = { chatgpt: 'ChatGPT', api_key: 'an API key', 'claude.ai': 'a Claude account', oauth_token: 'a token', api_key_helper: 'a key helper', third_party: 'a cloud provider' };
export function authText(auth) {
  if (!auth) return 'Sign-in not checked';
  if (auth.status === 'authenticated') return `Signed in${AUTH_METHODS[auth.method] ? ` with ${AUTH_METHODS[auth.method]}` : ''}`;
  if (auth.status === 'unauthenticated') return 'Not signed in';
  return 'Sign-in status unknown';
}

/** Codex device sign-in links are shown only when they point at OpenAI's sign-in page. */
export function verificationLink(uri) {
  try { const url = new URL(uri); return url.protocol === 'https:' && url.hostname === 'auth.openai.com' ? url.href : ''; } catch { return ''; }
}

const SHORTCUT_GROUPS = { shell: 'General', command: 'General', sidebar: 'General', add: 'Saving', page: 'Saving', library: 'Library', item: 'Library',
  detail: 'Library', collections: 'Library', notes: 'Notes', editor: 'Notes', ai: 'Assistant' };
const GROUP_ORDER = ['General', 'Saving', 'Library', 'Notes', 'Assistant', 'Other'];
/** Registered in-app shortcuts grouped by the module that owns them, deduplicated by label and keys. */
export function groupShortcuts(list = []) {
  const groups = new Map();
  const seen = new Set();
  for (const shortcut of list) {
    if (!shortcut?.label || !shortcut.keys) continue;
    const id = `${shortcut.label}\u0000${shortcut.keys}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = SHORTCUT_GROUPS[String(shortcut.action || '').split('.')[0]] || 'Other';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ keys: shortcut.keys, label: shortcut.label });
  }
  return GROUP_ORDER.filter(name => groups.has(name)).map(name => ({ group: name, rows: groups.get(name) }));
}

/** Chrome command rows from chrome.commands.getAll(), or the manifest defaults when that API is not available. */
export function chromeCommandRows(commands) {
  const list = Array.isArray(commands) && commands.length ? commands : CHROME_COMMANDS;
  return list.filter(command => command?.name && (!command.name.startsWith('_') || command.shortcut)).map(command => ({
    name: command.name, shortcut: command.shortcut || '',
    label: command.description || (command.name === '_execute_action' ? 'Open the Still side panel' : command.name),
  }));
}

/** Status badge for a bridge-managed MCP client (GET /connections). */
export function clientStatus(client) {
  if (!client) return null;
  if (client.configurationStatus === 'configured' || client.configured) return { label: 'Connected', tone: 'success' };
  if (client.configurationStatus === 'conflict') return { label: 'Conflict', tone: 'warning' };
  if (client.configurationStatus === 'manual') return { label: 'Manual setup', tone: 'warning' };
  return { label: 'Not connected', tone: 'neutral' };
}

/* ------------------------------------------------------------------ module state */

const data = {
  integration: null, storage: null, commands: null,
  connections: null, aiSettings: null, bridge: null, aiError: '', index: null,
  clients: null, clientsError: '',
  importJob: null, raindrop: null, login: null,
};
const busy = new Set();
const drafts = { bridgeUrl: null, bridgeToken: '', raindropToken: '' };
let connectDraft = { apiKey: '', baseUrl: '', label: '', workspaceId: '', defaultModel: '' };
// Last four characters of keys saved in this window, for the mask when the engine does not report a keyHint. Memory only.
const keyTails = new Map();
// pausedHere: sync was paused in this window without a stored setting (integrations.setBridgeEnabled is missing).
// aiLoad: the loadAi call in flight, so openSettings can wait for it instead of starting another.
const live = { offAi: null, offIndex: null, tick: 0, loginTimer: 0, forceClose: false, pausedHere: false, aiLoad: null };

const uiState = ctx => (ctx.state.settings ||= { section: 'general', list: false, open: new Set() });
const isOpen = ctx => ctx.state.dialogs.some(entry => entry.name === DIALOG);
const settingsOf = ctx => ctx.library?.settings || {};
const version = () => { try { return globalThis.chrome?.runtime?.getManifest?.()?.version || '0.3.0'; } catch { return '0.3.0'; } };
const topProps = (ctx, name) => ctx.state.dialogs.findLast(entry => entry.name === name)?.props || null;
const patchConnect = (ctx, patch) => { if (topProps(ctx, CONNECT)) ctx.updateDialog(CONNECT, patch); };
const aiSettings = ctx => data.aiSettings || ctx.ai?.DEFAULT_AI_SETTINGS || {};
const focusSoon = (ctx, selector) => ctx.nextFrame(() => document.querySelector(selector)?.focus({ preventScroll: false }));
const since = iso => relativeDate(iso).replace(/^Just now$/, 'just now');
const bridgeSettings = () => (data.integration && live.pausedHere ? { ...data.integration, bridgeEnabled: false, pausedHere: true } : data.integration);

async function withBusy(ctx, key, fn) {
  if (busy.has(key)) return undefined;
  busy.add(key);
  ctx.render();
  try { return await fn(); } finally { busy.delete(key); ctx.render(); }
}

// Chrome shows a permission prompt only during a user gesture, so callers start this before their first await.
// Without the permissions API (preview mode) there is nothing to grant.
function requestAccess(request) {
  const api = globalThis.chrome?.permissions;
  if (typeof api?.request !== 'function') return Promise.resolve(true);
  try { return Promise.resolve(api.request(request)).then(Boolean, () => false); } catch { return Promise.resolve(false); }
}

function download(content, filename, type) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ loading */

async function loadIntegration(ctx) {
  try { data.integration = await integrations.getIntegrationSettings(); } catch (error) { data.integration = { error: error.message }; }
  ctx.render();
}

async function loadStorage() {
  try { data.storage = await globalThis.navigator?.storage?.estimate?.() || null; } catch { data.storage = null; }
}

async function loadCommands() {
  const api = globalThis.chrome?.commands;
  try { data.commands = typeof api?.getAll === 'function' ? await api.getAll() : null; } catch { data.commands = null; }
}

function loadAi(ctx, { refresh = false } = {}) {
  const run = (async () => {
    const ai = ctx.ai;
    if (!ai) { data.aiError = 'unavailable'; ctx.render(); return; }
    try { data.connections = await ai.listConnections({ refresh }); data.aiError = ''; } catch (error) { data.connections ||= []; data.aiError = error.message; }
    try { data.aiSettings = await ai.getAiSettings(); } catch (error) { data.aiError ||= error.message; }
    try { data.bridge = await ai.getBridgeStatus(); } catch { data.bridge = null; }
    try { data.index = ai.getIndexStatus(); } catch { /* the index reports through subscribeIndex */ }
    ctx.render();
  })();
  live.aiLoad = run;
  run.finally(() => { if (live.aiLoad === run) live.aiLoad = null; });
  return run;
}

// A focused input keeps its typed value through re-renders (ui/morph.js), so secrets are cleared from the element itself.
function clearSecretField(id) {
  const el = globalThis.document?.getElementById(id);
  if (el) el.value = '';
}

const findConnection = id => (data.connections || []).find(entry => entry.id === id) || null;
const keyHintOf = connection => (connection?.hasKey ? connection.keyHint || keyTails.get(connection.id) || '' : '');

// Chrome asks for host access only during a user gesture, so action handlers call this before their first await.
// Bridged connections need no host access (the bridge makes the request).
// The returned promise is marked handled so a request that nobody awaits (a busy button) cannot raise an unhandled rejection.
function hostAccess(ctx, connection) {
  if (!connection || connection.via !== 'direct' || typeof ctx.ai?.ensureHostPermission !== 'function') return Promise.resolve(true);
  let request;
  try { request = Promise.resolve(ctx.ai.ensureHostPermission({ providerId: connection.providerId, baseUrl: connection.baseUrl })); }
  catch (error) { request = Promise.reject(error); }
  request.catch(() => {});
  return request;
}

async function loadClients(ctx) {
  if (!data.integration?.bridgeConfigured || data.bridge?.reachable === false) { data.clients = null; data.clientsError = ''; return; }
  try {
    const result = await integrations.requestBridge('/connections', { signal: AbortSignal.timeout(8000) });
    data.clients = Array.isArray(result?.clients) ? result.clients : [];
    data.clientsError = '';
  } catch (error) { data.clients = null; data.clientsError = error.message; }
  ctx.render();
}

async function refresh(ctx, { bridge = false } = {}) {
  await Promise.allSettled([loadIntegration(ctx), loadStorage(), loadCommands(), loadAi(ctx, { refresh: bridge })]);
  await loadClients(ctx);
  ctx.render();
}

function attach(ctx) {
  detach();
  const ai = ctx.ai;
  try { live.offAi = ai?.onConnectionsChanged?.(() => loadAi(ctx)) || null; } catch { live.offAi = null; }
  try { live.offIndex = ai?.subscribeIndex?.(status => { data.index = status; if (isOpen(ctx)) ctx.render(); }) || null; } catch { live.offIndex = null; }
  // Relative times ("Synced 8 seconds ago") and the bridge sync status (app.js updates it without rendering).
  live.tick = setInterval(() => { if (isOpen(ctx)) ctx.render(); }, 5000);
  if (data.login && ['pending', 'user_action_needed'].includes(data.login.status)) pollLogin(ctx);
}

function detach() {
  if (typeof live.offAi === 'function') live.offAi();
  if (typeof live.offIndex === 'function') live.offIndex();
  clearInterval(live.tick);
  clearTimeout(live.loginTimer);
  Object.assign(live, { offAi: null, offIndex: null, tick: 0, loginTimer: 0 });
}

/* ------------------------------------------------------------------ public entry */

/**
 * Opens Settings at a section: general, appearance, library, ai, search, agents, integrations, shortcuts, about, help.
 * options.providerId (AI setup paths) also opens that provider's connect dialog, editing its connection when one exists.
 */
export function openSettings(ctx, section = 'general', { providerId = '' } = {}) {
  const ui = uiState(ctx);
  const known = SECTION_IDS.has(section);
  ui.section = known ? section : 'general';
  // The side panel starts on the section list unless a specific section was asked for.
  ui.list = !!ctx.env?.isSidepanel && (!known || section === 'general');
  if (isOpen(ctx)) ctx.render();
  else {
    ctx.openDialog(DIALOG, { ...(ctx.env?.isSidepanel ? { size: 'full' } : {}), onClose: detach });
    attach(ctx);
    refresh(ctx, { bridge: true }).catch(error => console.error(error));
  }
  if (!providerId) return;
  const ready = data.connections ? Promise.resolve() : live.aiLoad || loadAi(ctx);
  ready.then(() => {
    if (!isOpen(ctx) || topProps(ctx, CONNECT)) return;
    const provider = ctx.ai?.getProvider(providerId);
    openConnect(ctx, { providerId, id: providerConnection(data.connections || [], provider)?.id || '' });
  }).catch(error => ctx.toast(error.message, { tone: 'danger' }));
}

/* ------------------------------------------------------------------ building blocks */

function providerMark(id, size = 32) {
  const mark = MARKS[id] || { icon: 'circle', color: 'gray' };
  return html`<span class="avatar-tile settings-mark" data-color="${mark.color}" style="--size:${size}px" aria-hidden="true">${mark.icon
    ? icon(mark.icon, { size: Math.round(size * 0.5) }) : mark.text}</span>`;
}

const group = ({ title, description, actions, body, id, className }) => html`<section class="${cx('settings-group', className)}" ${id ? html`id="${id}"` : ''}>
  ${title ? html`<header class="settings-group-head"><div class="settings-group-heading"><h4 class="settings-group-title">${title}</h4>
    ${description ? html`<p class="settings-group-desc">${description}</p>` : ''}</div>${actions || ''}</header>` : ''}
  ${body}
</section>`;

const card = (rows, className) => html`<div class="${cx('settings-card', className)}">${rows}</div>`;

function row({ label, description, control, lead, className, stacked, id, descClass } = {}) {
  return html`<div class="${cx('settings-row', stacked && 'is-stacked', className)}" ${id ? html`id="${id}"` : ''}>
    ${lead || ''}
    <div class="settings-row-text"><span class="settings-row-label">${label}</span>${description ? html`<span class="${cx('settings-row-desc', descClass)}">${description}</span>` : ''}</div>
    ${control ? html`<div class="settings-row-control">${control}</div>` : ''}
  </div>`;
}

const switchRow = options => html`<div class="settings-row is-switch">${switchToggle(options)}</div>`;

function callout({ tone = 'info', icon: ico, title, body, actions, live: announce } = {}) {
  const glyph = ico || { success: 'circle-check', danger: 'circle-alert', warning: 'triangle-alert', info: 'info' }[tone] || 'info';
  return html`<div class="settings-callout" data-tone="${tone}" ${announce ? html`role="${tone === 'danger' ? 'alert' : 'status'}"` : ''}>
    ${icon(glyph, { size: 16, className: 'settings-callout-icon' })}
    <div class="settings-callout-text">${title ? html`<p class="settings-callout-title">${title}</p>` : ''}${body ? html`<p class="settings-callout-body">${body}</p>` : ''}
      ${actions ? html`<div class="settings-callout-actions">${actions}</div>` : ''}</div>
  </div>`;
}

function codeBlock(code, { label = 'Copy', done = 'Copied' } = {}) {
  return html`<div class="settings-code"><pre><code>${code}</code></pre>
    ${iconButton({ icon: 'copy', label, action: 'app.copy', data: { text: code, done }, size: 'sm', className: 'settings-code-copy', tooltipPlacement: 'top end' })}</div>`;
}

function progressBar({ percent = null, label, tone } = {}) {
  const indeterminate = percent === null || percent === undefined;
  return html`<div class="${cx('settings-progress', indeterminate && 'is-indeterminate')}" ${tone ? html`data-tone="${tone}"` : ''} role="progressbar" aria-label="${label}"
    ${indeterminate ? '' : html`aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" style="--progress:${percent / 100}"`}><span class="settings-progress-bar"></span></div>`;
}

const disclosure = (ctx, id, label, { count } = {}) => {
  const open = uiState(ctx).open.has(id);
  return html`<button type="button" class="settings-disclosure" aria-expanded="${open ? 'true' : 'false'}" aria-controls="settings-more-${id}"
    data-action="settings.disclose" data-id="${id}">${icon(open ? 'chevron-down' : 'chevron-right', { size: 14 })}<span>${label}</span>${count != null ? html`<span class="count">${count}</span>` : ''}</button>`;
};
const disclosed = (ctx, id) => uiState(ctx).open.has(id);

const loadingBlock = label => html`<div class="settings-loading" role="status">${spinner({ size: 16 })}<span>${label}</span></div>`;

const linkButton = ({ label, href, icon: ico = 'external-link', variant = 'secondary', size = 'sm' }) => html`<a class="${cx('btn', `btn-${variant}`, size !== 'md' && `btn-${size}`)}"
  href="${safeHref(href)}" target="_blank" rel="noopener noreferrer"><span class="btn-label">${label}</span>${icon(ico, { size: 14, className: 'btn-icon-right' })}</a>`;

function aiUnavailable() {
  return emptyState({ icon: 'circle-alert', tone: 'danger', title: 'AI settings could not load', body: 'Reload Still to try again. Your library is not affected.',
    actions: button({ label: 'Reload', icon: 'refresh-cw', variant: 'secondary', size: 'sm', action: 'app.retry-boot' }) });
}

/* ------------------------------------------------------------------ frame */

function navItem(section, active) {
  return html`<button type="button" role="tab" class="${cx('settings-nav-item', section.groupStart && 'is-group-start')}" id="settings-tab-${section.id}"
    aria-selected="${active ? 'true' : 'false'}" aria-controls="settings-panel" tabindex="${active ? '0' : '-1'}" ${active ? html`data-autofocus` : ''}
    data-action="settings.section" data-section="${section.id}">${icon(section.icon, { size: 16 })}<span>${section.label}</span></button>`;
}

function renderSettings(ctx) {
  const ui = uiState(ctx);
  const section = SETTINGS_SECTIONS.find(entry => entry.id === ui.section) || SETTINGS_SECTIONS[0];
  const close = iconButton({ icon: 'x', label: 'Close settings', action: 'settings.close', size: 'sm' });
  if (ctx.env.isSidepanel) {
    if (ui.list) {
      return html`<div class="settings is-side">
        <div class="settings-side-head"><h2 class="settings-side-title" id="dialog-title-settings">Settings</h2>${close}</div>
        <div class="settings-scroll" data-key="settings-index">
          <ul class="settings-index" role="list">${SETTINGS_SECTIONS.map((entry, index) => html`<li class="${cx(entry.groupStart && 'is-group-start')}">
            <button type="button" class="settings-index-row" id="settings-row-${entry.id}" data-action="settings.section" data-section="${entry.id}" ${index === 0 ? html`data-autofocus` : ''}>
              <span class="settings-index-icon" aria-hidden="true">${icon(entry.icon, { size: 16 })}</span>
              <span class="settings-index-text"><span class="settings-index-label">${entry.label}</span><span class="settings-index-desc">${entry.summary}</span></span>
              ${icon('chevron-right', { size: 16, className: 'settings-index-chevron' })}
            </button></li>`)}</ul>
          <p class="settings-foot">Still ${version()}</p>
        </div>
      </div>`;
    }
    return html`<div class="settings is-side is-drilled">
      <div class="settings-side-head">
        ${iconButton({ icon: 'arrow-left', label: 'All settings', action: 'settings.back', size: 'sm', className: 'settings-back', attrs: { 'data-autofocus': true } })}
        <h2 class="settings-side-title" id="dialog-title-settings">${section.label}</h2>${close}
      </div>
      <div class="settings-scroll" data-key="settings-panel-${section.id}" id="settings-panel">
        ${section.description ? html`<p class="settings-intro">${section.description}</p>` : ''}
        ${renderSection(ctx, section.id)}
      </div>
    </div>`;
  }
  return html`<div class="settings">
    <div class="settings-nav">
      <h2 class="settings-nav-title" id="dialog-title-settings">Settings</h2>
      <div class="settings-nav-list" role="tablist" aria-orientation="vertical" aria-label="Settings sections">${SETTINGS_SECTIONS.map(entry => navItem(entry, entry.id === section.id))}</div>
      <p class="settings-foot">Still ${version()}</p>
    </div>
    <div class="settings-main">
      <div class="settings-main-head">
        <div class="settings-main-heading"><h3 class="settings-main-title">${section.label}</h3>${section.description ? html`<p class="settings-main-desc">${section.description}</p>` : ''}</div>
        ${close}
      </div>
      <div class="settings-scroll" role="tabpanel" id="settings-panel" aria-labelledby="settings-tab-${section.id}" tabindex="-1" data-key="settings-panel-${section.id}">
        ${renderSection(ctx, section.id)}
      </div>
    </div>
  </div>`;
}

function renderSection(ctx, id) {
  switch (id) {
    case 'appearance': return renderAppearance(ctx);
    case 'library': return renderLibrary(ctx);
    case 'ai': return renderAi(ctx);
    case 'search': return renderSearch(ctx);
    case 'agents': return renderAgents(ctx);
    case 'integrations': return renderIntegrations(ctx);
    case 'shortcuts': return renderShortcuts(ctx);
    case 'about': return renderAbout(ctx);
    case 'help': return renderHelp(ctx);
    default: return renderGeneral(ctx);
  }
}

/* ------------------------------------------------------------------ General */

function renderGeneral(ctx) {
  const s = settingsOf(ctx);
  return html`
    ${group({ title: 'Saving', body: card([
      row({ label: 'Default collection', description: 'Where quick saves go until you save into a collection. After that, Save, Alt+Shift+S and Save page to Still use the collection you saved to last.',
        control: renderCollectionPickerTrigger({ ctx, value: s.defaultCollectionId || '', action: 'settings.default-collection', id: 'settings-default-collection', label: 'Default collection', size: 'sm', allowCreate: true }) }),
      switchRow({ label: 'Open the side panel after saving from the page menu', description: 'After Save page to Still and the other right-click saves, the side panel shows the saved page so you can add tags or a note.',
        checked: s.openPanelOnSave !== false, action: 'settings.toggle', data: { key: 'openPanelOnSave' } }),
    ]) })}
    ${group({ title: 'Side panel', body: card([
      row({ lead: html`<span class="settings-row-icon" aria-hidden="true">${icon('panel-right', { size: 16 })}</span>`, label: 'Toolbar button',
        description: 'Clicking the Still icon in the Chrome toolbar opens the side panel. Pin Still from the puzzle piece menu to keep it one click away.' }),
      switchRow({ label: 'Start on This page', description: 'Open the side panel on the page you are viewing. Turn off to start on your library.',
        checked: s.startOnPage !== false, action: 'settings.toggle', data: { key: 'startOnPage' } }),
    ]) })}
    ${group({ title: 'Deleting', body: card([
      switchRow({ label: 'Confirm before moving items to Trash', description: 'Items in Trash can be restored until you empty it, so Still normally moves them without asking.',
        checked: s.confirmDelete === true, action: 'settings.toggle', data: { key: 'confirmDelete' } }),
    ]) })}`;
}

/* ------------------------------------------------------------------ Appearance */

function renderAppearance(ctx) {
  const s = settingsOf(ctx);
  const theme = ['light', 'dark'].includes(s.theme) ? s.theme : 'system';
  const accent = ACCENTS.some(entry => entry.id === s.accent) ? s.accent : s.accent === 'amber' ? 'gold' : 'blue';
  const density = s.density === 'compact' ? 'compact' : 'comfortable';
  const resolved = globalThis.document?.documentElement?.dataset?.theme === 'dark' ? 'dark' : 'light';
  const accentLabel = ACCENTS.find(entry => entry.id === accent)?.label || 'Blue';
  return html`
    ${group({ title: 'Look', body: card([
      row({ label: 'Theme', description: theme === 'system' ? `Follows your system setting. Now ${resolved}.` : `Always ${theme}.`,
        control: segmented({ name: 'theme', value: theme, options: THEMES, action: 'settings.appearance', size: 'sm', ariaLabel: 'Theme' }) }),
      row({ label: 'Accent color', description: `${accentLabel}. Used for buttons, selection and links.`,
        control: html`<div class="accent-swatches" role="radiogroup" aria-label="Accent color">${ACCENTS.map(entry => html`<button type="button" role="radio"
          class="accent-swatch" data-accent="${entry.id}" data-theme="${resolved}" aria-checked="${entry.id === accent ? 'true' : 'false'}" tabindex="${entry.id === accent ? '0' : '-1'}"
          aria-label="${entry.label}" data-tooltip="${entry.label}" data-action="settings.appearance" data-name="accent" data-value="${entry.id}">${icon('check', { size: 14, className: 'accent-swatch-check' })}</button>`)}</div>` }),
      row({ label: 'Density', description: density === 'compact' ? 'Compact rows fit more on screen.' : 'Comfortable rows are easier to scan.',
        control: segmented({ name: 'density', value: density, options: DENSITIES, action: 'settings.appearance', size: 'sm', ariaLabel: 'Density' }) }),
    ]) })}
    ${group({ title: 'Preview', description: 'This is how lists, collections and buttons look with these settings.', body: appearancePreview() })}`;
}

function appearancePreview() {
  const rows = [
    { name: 'Inbox', icon: null, count: 23 },
    { name: 'Design', icon: 'palette', color: 'pink', count: 24, selected: true },
    { name: 'Reading list', icon: 'book-open', color: 'orange', count: 9 },
  ];
  return html`<div class="appearance-preview" aria-hidden="true" inert>
    <div class="appearance-preview-side">${rows.map(entry => html`<span class="${cx('ap-row', entry.selected && 'is-selected')}">
      ${collectionIcon(entry.icon ? { icon: entry.icon, color: entry.color } : null, { size: 18 })}<span class="ap-name">${entry.name}</span><span class="count">${entry.count}</span></span>`)}</div>
    <div class="appearance-preview-main">
      ${[{ title: 'Refactoring UI: Design tips for developers', site: 'refactoringui.com', tag: 'ui', letter: 'R', color: 'blue' },
        { title: 'Inter typeface family', site: 'rsms.me', tag: 'typography', letter: 'A', color: 'gray' }].map(item => html`<span class="ap-item">
        <span class="ap-thumb" data-color="${item.color}">${item.letter}</span>
        <span class="ap-lines"><span class="ap-title">${item.title}</span><span class="ap-meta">${item.site} · <span class="ap-tag">#${item.tag}</span></span></span></span>`)}
      <span class="ap-actions">${button({ label: 'Save', variant: 'primary', size: 'sm' })}${button({ label: 'Cancel', variant: 'secondary', size: 'sm' })}
        ${chip({ label: 'Selected', selected: true })}<span class="ap-switch">${switchToggle({ checked: true, label: 'On' })}</span></span>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ Library & backup */

function renderLibrary(ctx) {
  const library = ctx.library || { items: [] };
  const counts = ctx.select?.counts?.() || {};
  const trash = counts.trash || 0;
  const items = library.items.filter(item => !item.deletedAt).length;
  const files = library.items.filter(item => item.attachmentId && !item.deletedAt).length;
  const job = data.importJob;
  return html`
    ${group({ title: 'Backup', body: card([
      row({ label: 'Full backup', description: 'Items, collections, notes, highlights and files in one JSON file. AI keys and device settings are not included.',
        control: button({ label: 'Download backup', icon: 'download', size: 'sm', action: 'settings.backup', loading: busy.has('backup') }) }),
      row({ label: 'Restore or bring in a file', description: 'A Still backup, a bookmarks HTML file from any browser or Raindrop, or a CSV with a url column. Items in the file are added; items that already exist are replaced by the file’s copy.',
        control: button({ label: 'Choose file', icon: 'upload', size: 'sm', action: 'settings.import-choose', loading: !!job?.running }) }),
      job ? importStatus(job) : '',
    ]) })}
    ${group({ title: 'Export', body: card([
      row({ label: 'Bookmarks', description: 'An HTML bookmarks file that Chrome, Firefox, Safari and Raindrop can import.',
        control: button({ label: 'Export HTML', icon: 'file-down', size: 'sm', action: 'settings.export-html', loading: busy.has('export-html') }) }),
      row({ label: 'Notes and highlights', description: 'Every note, personal note and highlight in one Markdown file.',
        control: button({ label: 'Export Markdown', icon: 'file-down', size: 'sm', action: 'settings.export-notes', loading: busy.has('export-notes') }) }),
    ]) })}
    ${group({ title: 'Bring in from other apps', body: card([
      row({ lead: providerMark('chrome', 32), label: 'Chrome bookmarks', description: ctx.env.isExtension
        ? 'Copies your Chrome bookmarks into Still and keeps folders as collections. Chrome asks for access first.'
        : 'Available when Still runs as the installed extension.',
        control: button({ label: 'Bring in from Chrome', icon: 'folder-input', size: 'sm', action: 'settings.import-chrome', disabled: !ctx.env.isExtension, loading: busy.has('chrome-bookmarks') }) }),
      raindropBlock(ctx),
    ]) })}
    ${group({ title: 'Storage', body: card([
      row({ label: 'On this device', description: html`${plural(items, 'item')}${files ? html`, ${plural(files, 'file')}` : ''}${data.storage?.usage != null
        ? html`. ${fileSize(data.storage.usage)} used by Still.` : '.'}`, control: data.storage?.usage != null && data.storage.quota
        ? html`<span class="settings-meter" aria-hidden="true"><span style="--progress:${Math.min(1, data.storage.usage / data.storage.quota)}"></span></span>` : '' }),
      row({ label: 'Trash', description: trash ? `${plural(trash, 'item')} in Trash. Emptying deletes them forever.` : 'Trash is empty.',
        control: button({ label: 'Empty trash', icon: 'trash-2', size: 'sm', variant: 'secondary', className: 'settings-danger-btn', action: 'settings.empty-trash', disabled: !trash, loading: busy.has('empty-trash') }) }),
    ]) })}`;
}

function importStatus(job) {
  if (job.running) {
    return html`<div class="settings-row is-stacked settings-job" role="status">
      <span class="settings-row-label">Bringing in ${job.name}</span>${progressBar({ label: `Bringing in ${job.name}` })}</div>`;
  }
  if (job.error) {
    return html`<div class="settings-row is-stacked settings-job">${callout({ tone: 'danger', title: `${job.name} was not brought in`, body: job.error, live: true,
      actions: button({ label: 'Dismiss', size: 'sm', variant: 'ghost', action: 'settings.import-dismiss' }) })}</div>`;
  }
  const result = job.result || {};
  return html`<div class="settings-row is-stacked settings-job">${callout({ tone: result.warnings?.length ? 'warning' : 'success', live: true,
    title: `Added ${plural(result.items || 0, 'item')}${result.files ? ` and ${plural(result.files, 'file')}` : ''} from ${job.name}`,
    body: result.warnings?.length ? html`<ul class="settings-list">${result.warnings.map(warning => html`<li>${warning}</li>`)}</ul>` : '',
    actions: button({ label: 'Dismiss', size: 'sm', variant: 'ghost', action: 'settings.import-dismiss' }) })}</div>`;
}

function raindropBlock(ctx) {
  const info = data.integration || {};
  const job = data.raindrop;
  const status = info.raindropConnectedAt ? { label: 'Connected', tone: 'success' } : info.raindropConfigured ? { label: 'Token saved', tone: 'neutral' } : { label: 'Not connected', tone: 'neutral' };
  const configured = !!info.raindropConfigured;
  return html`<div class="settings-row is-stacked settings-raindrop" id="settings-raindrop" tabindex="-1">
    <div class="settings-row-split">
      ${providerMark('raindrop', 32)}
      <div class="settings-row-text"><span class="settings-row-label">Raindrop.io ${badge(status)}</span>
        <span class="settings-row-desc">Brings in collections, bookmarks, notes and highlights with your Raindrop API token. The token stays on this device.${info.raindropConnectedAt
          ? ` Checked ${shortDate(info.raindropConnectedAt)}.` : ''}</span></div>
    </div>
    <form class="settings-inline-form" data-submit="settings.raindrop-connect">
      ${field({ label: 'API token', id: 'settings-raindrop-token', hint: html`Create a test token in <a class="link-inline" href="https://app.raindrop.io/settings/integrations" target="_blank" rel="noopener noreferrer">Raindrop’s integration settings</a>.`,
        control: input({ id: 'settings-raindrop-token', name: 'token', type: 'password', value: drafts.raindropToken, action: 'settings.raindrop-field',
          placeholder: configured ? 'Saved. Paste a new token to replace it.' : 'Paste your Raindrop test token', describedBy: 'settings-raindrop-token-hint' }) })}
      <div class="settings-actions">
        ${button({ label: configured ? 'Save and check' : 'Connect', type: 'submit', size: 'sm', variant: configured ? 'secondary' : 'primary', loading: busy.has('raindrop-connect') })}
        ${configured ? button({ label: 'Bring in library', icon: 'download', size: 'sm', variant: 'primary', action: 'settings.raindrop-import', loading: !!job?.running }) : ''}
        ${configured ? button({ label: 'Disconnect', size: 'sm', variant: 'ghost', action: 'settings.raindrop-disconnect' }) : ''}
      </div>
    </form>
    ${job?.running ? html`<div class="settings-job" role="status"><span class="settings-row-desc">${job.items ? `Fetched ${plural(job.items, 'bookmark')} so far.` : 'Reading your Raindrop collections.'}</span>
      ${progressBar({ label: 'Bringing in from Raindrop' })}</div>` : ''}
  </div>`;
}

/* ------------------------------------------------------------------ AI models */

function renderAi(ctx) {
  const ai = ctx.ai;
  if (!ai) return aiUnavailable();
  if (!data.connections) return loadingBlock('Loading AI connections');
  const direct = data.connections.filter(c => c.via === 'direct');
  const chatReady = data.connections.some(c => c.enabled !== false && ai.getProvider(c.providerId)?.chat);
  return html`
    ${data.aiError && data.aiError !== 'unavailable' ? callout({ tone: 'danger', title: 'Some AI settings could not load', body: data.aiError }) : ''}
    ${direct.length ? group({ title: 'Your connections', body: card(direct.map(c => connectionRow(ctx, c))) })
      : callout({ tone: 'info', icon: 'sparkles', title: 'Connect a model to use Ask and the writing tools',
        body: 'Anthropic, OpenAI and Ollama are the quickest to set up. Keys stay on this device. Claude Code, Codex and a ChatGPT plan work through the local bridge below.' })}
    ${chatReady ? renderAiDefaults(ctx) : ''}
    ${providerGroups(ai.CATALOG).map(entry => group({ title: entry.title, body: html`<div class="provider-grid">${entry.providers.map(provider => providerTile(provider, direct))}</div>` }))}
    ${group({ title: 'Local bridge', description: 'A small companion that runs on this computer. It lets Still use Claude Code, Codex, your ChatGPT plan and keys you keep outside the browser.',
      body: bridgeBlock(ctx, { agents: true }) })}
    <p class="settings-note">${icon('lock', { size: 14 })}<span>API keys are stored on this device in Chrome’s extension storage. They are not included in backups, exports or bridge sync.</span></p>`;
}

function connectionRow(ctx, connection) {
  const status = connectionStatus(connection);
  const isDefault = aiSettings(ctx).chat?.connectionId === connection.id;
  const modelName = (connection.models || []).find(model => model.id === connection.defaultModel)?.name || connection.defaultModel;
  const error = connection.status === 'error' && connection.lastError;
  const hint = keyHintOf(connection);
  const meta = [connection.label !== connection.providerName ? connection.providerName : '', modelName, hint ? `Key ${maskedKey(hint)}` : ''].filter(Boolean).join(' · ');
  return row({ className: 'connection-row', lead: providerMark(connection.providerId, 32),
    label: html`${connection.label}${isDefault ? badge({ label: 'Default', tone: 'accent' }) : ''}`,
    description: error || meta || connection.baseUrl, descClass: error ? 'is-error' : '',
    control: html`${badge(status)}
      ${button({ label: 'Test', size: 'sm', variant: 'ghost', action: 'settings.connection-test', data: { id: connection.id }, loading: busy.has(`test:${connection.id}`) })}
      ${button({ label: 'Edit', size: 'sm', variant: 'secondary', action: 'settings.connect-open', data: { id: connection.id, provider: connection.providerId } })}` });
}

function providerTile(provider, connections) {
  const edit = providerConnection(connections, provider);
  return html`<button type="button" class="provider-tile" data-action="settings.connect-open" data-provider="${provider.id}" ${edit ? html`data-id="${edit.id}"` : ''}
    aria-label="${edit ? `${provider.name}, ${connectionStatus(edit).label}. Edit` : `Connect ${provider.name}`}">
    ${providerMark(provider.id, 32)}
    <span class="provider-tile-text"><span class="provider-tile-name">${provider.name}</span><span class="provider-tile-desc">${provider.description}</span></span>
    ${edit ? badge(connectionStatus(edit)) : html`<span class="provider-tile-add">${icon('plus', { size: 14 })}<span>Add</span></span>`}
  </button>`;
}

function modelSelectOptions(ctx, { includeSame = false } = {}) {
  const groups = modelChoices(data.connections || [], id => ctx.ai.getProvider(id));
  return [{ value: '', label: includeSame ? 'Same as chat model' : 'Automatic (first connected model)' },
    ...groups.map(entry => ({ group: entry.group, options: entry.options }))];
}

function withCurrent(options, value, label) {
  if (!value || options.some(option => option.value === value || option.options?.some(inner => inner.value === value))) return options;
  return [...options, { value, label: `${label} (not available)` }];
}

function renderAiDefaults(ctx) {
  const ai = ctx.ai;
  const settings = aiSettings(ctx);
  const connections = data.connections || [];
  const chat = findModel(connections, settings.chat || {});
  const chatValue = chat.connection ? choiceValue(chat.connection.id, chat.id) : '';
  const quick = findModel(connections, settings.quick || {});
  const quickValue = quick.connection ? choiceValue(quick.connection.id, quick.id) : '';
  const efforts = chat.model?.efforts || [];
  const effort = settings.chat?.effort || 'medium';
  const handoff = settings.handoffTarget || 'claude';
  const targets = (ai.HANDOFF_TARGETS || []).filter(target => HANDOFF_CHOICES.includes(target.id) || target.id === handoff);
  return group({ title: 'Defaults', body: card([
    row({ label: 'Chat model', description: chat.model?.description || 'Used by Ask and by note writing tools unless you pick another model there.',
      control: select({ name: 'chat', value: chatValue, label: 'Chat model', action: 'settings.ai-model', size: 'sm', className: 'settings-select',
        options: withCurrent(modelSelectOptions(ctx), chatValue, chat.id) }) }),
    row({ label: 'Reasoning effort', description: efforts.length ? 'Higher effort thinks longer before answering. It is slower and uses more tokens.' : 'This model does not offer an effort setting.',
      control: select({ name: 'effort', value: efforts.length ? effortFor(chat.model, effort) : '', label: 'Reasoning effort', action: 'settings.ai-effort', size: 'sm', className: 'settings-select is-narrow',
        disabled: !efforts.length, options: efforts.length ? efforts.map(level => ({ value: level, label: ai.EFFORT_LABELS?.[level] || level })) : [{ value: '', label: 'Not adjustable' }] }) }),
    row({ label: 'Fast model', description: 'Used for quick jobs: title and tag suggestions, summaries in the Add dialog and short rewrites.',
      control: select({ name: 'quick', value: quickValue, label: 'Fast model', action: 'settings.ai-quick', size: 'sm', className: 'settings-select',
        options: withCurrent(modelSelectOptions(ctx, { includeSame: true }), quickValue, quick.id) }) }),
    switchRow({ label: 'Suggest a title and tags when saving', description: 'Uses the fast model in the Add dialog. Nothing is sent until you open the dialog for a page.',
      checked: settings.autoSuggestOnSave !== false, action: 'settings.ai-flag', data: { key: 'autoSuggestOnSave' } }),
    switchRow({ label: 'Include page text when asking about a page', description: 'Sends the readable text of the page you are on with your question.',
      checked: settings.includePageText !== false, action: 'settings.ai-flag', data: { key: 'includePageText' } }),
    row({ label: 'Continue in', description: 'Where “Open in” sends a question and its sources when you want to keep going in another app.',
      control: segmented({ name: 'handoff', value: handoff, size: 'sm', action: 'settings.ai-handoff', ariaLabel: 'Continue in',
        options: targets.map(target => ({ value: target.id, label: target.name })) }) }),
  ]) });
}

/* ------------------------------------------------------------------ Local bridge (AI models and Agents & MCP) */

function bridgeBlock(ctx, { agents = false } = {}) {
  const info = bridgeSettings();
  if (!info) return loadingBlock('Checking the local bridge');
  if (!info.bridgeConfigured) return pairForm(info);
  const summary = bridgeSummary({ integration: info, live: ctx.state.bridge, bridge: data.bridge });
  const paused = summary.state === 'paused';
  const rows = [row({ className: 'bridge-row', lead: providerMark('bridge', 32), label: html`Local bridge ${badge({ label: summary.label, tone: summary.tone })}`,
    description: html`${summary.detail} <span class="settings-mono">${info.bridgeUrl}</span>`,
    control: html`${paused ? button({ label: 'Resume sync', icon: 'refresh-cw', size: 'sm', action: 'settings.bridge-resume', loading: busy.has('bridge-sync') })
      : button({ label: 'Pause sync', size: 'sm', variant: 'secondary', action: 'settings.bridge-pause', loading: busy.has('bridge-sync') })}
      ${button({ label: 'Unpair', size: 'sm', variant: 'ghost', action: 'settings.bridge-unpair' })}` })];
  if (!agents) return card(rows);
  const bridge = data.bridge;
  const reachable = !!bridge?.reachable;
  const agentRows = ['claude', 'codex'].map(id => agentRow(ctx, id, bridge));
  const codex = bridge?.agents?.find(agent => agent.id === 'codex');
  if (codex?.capabilities?.oauthLogin) agentRows.push(chatGptRow(ctx, bridge));
  const providers = bridge?.providers || [];
  return html`${card(rows)}
    ${group({ title: 'Coding agents and ChatGPT', className: 'settings-subgroup', description: reachable ? 'Chat with the agents you already use. They answer from their own sign-in; Still sends only the question and the context you choose.'
      : 'Start the bridge to see Claude Code, Codex and ChatGPT sign-in here.',
      actions: iconButton({ icon: 'refresh-cw', label: 'Check again', size: 'sm', action: 'settings.bridge-refresh' }),
      body: reachable ? card(agentRows) : '' })}
    ${reachable && providers.length ? group({ title: 'Providers on the bridge', className: 'settings-subgroup', description: 'Set up on the bridge with keys that never enter the browser.',
      body: card(providers.map(provider => bridgeProviderRow(ctx, provider))) }) : ''}`;
}

function pairForm(info) {
  return html`<form class="settings-card settings-pair" data-submit="settings.bridge-pair">
    ${row({ lead: providerMark('bridge', 32), label: html`Local bridge ${badge({ label: 'Not paired', tone: 'neutral' })}`,
      description: html`In the Still folder, run <code class="settings-code-inline">npm run bridge</code> and paste the address and token it prints.` })}
    <div class="settings-pair-fields">
      ${field({ label: 'Address', id: 'settings-bridge-url', control: input({ id: 'settings-bridge-url', name: 'url', type: 'url', value: drafts.bridgeUrl ?? info.bridgeUrl ?? integrations.DEFAULT_BRIDGE_URL,
        action: 'settings.bridge-field', attrs: { 'data-field': 'bridgeUrl' } }) })}
      ${field({ label: 'Pairing token', id: 'settings-bridge-token', hint: 'Also saved in bridge/.local/config.json.', control: input({ id: 'settings-bridge-token', name: 'token', type: 'password',
        value: drafts.bridgeToken, placeholder: 'Paste the token', action: 'settings.bridge-field', describedBy: 'settings-bridge-token-hint', attrs: { 'data-field': 'bridgeToken' } }) })}
      <div class="settings-pair-submit">${button({ label: 'Pair', icon: 'plug', type: 'submit', variant: 'primary', size: 'sm', loading: busy.has('pair') })}</div>
    </div>
  </form>`;
}

function agentRow(ctx, id, bridge) {
  const agent = bridge?.agents?.find(entry => entry.id === id);
  const connectionId = id === 'claude' ? 'agent:claude-code' : 'agent:codex';
  const name = id === 'claude' ? 'Claude Code' : 'Codex CLI';
  const ready = agent?.available && agent.status === 'ready' && agent.capabilities?.generate;
  const state = !agent?.available ? { label: 'Not found', tone: 'neutral' } : ready ? { label: 'Ready', tone: 'success' } : { label: 'Needs an update', tone: 'warning' };
  const current = aiSettings(ctx).chat?.connectionId === connectionId;
  const description = !agent?.available ? (id === 'claude' ? 'Install Claude Code, then check again.' : 'Install the Codex CLI, then check again.')
    : agent.reason && !ready ? agent.reason : authText(bridge?.auth?.[id]);
  return row({ lead: providerMark(connectionId, 32), label: html`${name} ${badge(state)}`, description,
    control: html`${button({ label: current ? 'Used for chat' : 'Use for chat', icon: current ? 'check' : '', size: 'sm', pressed: current,
      disabled: !ready, action: 'settings.agent-use', data: { id: connectionId } })}
      ${button({ label: 'Check sign-in', size: 'sm', variant: 'ghost', disabled: !agent?.available, action: 'settings.agent-auth', loading: busy.has('agent-auth') })}` });
}

function chatGptRow(ctx, bridge) {
  const auth = bridge?.auth?.codex;
  const signedIn = auth?.status === 'authenticated' && auth.method === 'chatgpt';
  const current = aiSettings(ctx).chat?.connectionId === 'chatgpt-oauth';
  const job = data.login;
  const pending = job && ['pending', 'user_action_needed'].includes(job.status);
  return html`${row({ lead: providerMark('chatgpt-oauth', 32), label: html`ChatGPT plan ${signedIn ? badge({ label: 'Signed in', tone: 'success' }) : ''}`,
    description: signedIn ? 'Codex is signed in with your ChatGPT account. Chats use your plan’s limits.' : 'Sign in through Codex to use your ChatGPT subscription instead of an API key.',
    control: signedIn ? button({ label: current ? 'Used for chat' : 'Use for chat', icon: current ? 'check' : '', size: 'sm', pressed: current, action: 'settings.agent-use', data: { id: 'chatgpt-oauth' } })
      : button({ label: 'Sign in with ChatGPT', size: 'sm', variant: 'primary', action: 'settings.chatgpt-signin', loading: busy.has('signin') || !!pending }) })}
    ${job ? loginPanel(job) : ''}`;
}

function loginPanel(job) {
  const link = verificationLink(job.verificationUri);
  if (job.status === 'authenticated') return html`<div class="settings-row is-stacked">${callout({ tone: 'success', live: true, title: 'Signed in with ChatGPT', body: 'Choose Use for chat to use your plan in Ask.' })}</div>`;
  if (['failed', 'cancelled'].includes(job.status)) {
    return html`<div class="settings-row is-stacked">${callout({ tone: job.status === 'failed' ? 'danger' : 'info', live: true, title: job.status === 'failed' ? 'Sign-in did not finish' : 'Sign-in cancelled',
      body: job.error || 'Start again when you are ready.', actions: button({ label: 'Dismiss', size: 'sm', variant: 'ghost', action: 'settings.chatgpt-dismiss' }) })}</div>`;
  }
  if (job.userCode && link) {
    return html`<div class="settings-row is-stacked settings-login" role="status">
      <p class="settings-row-desc">Open OpenAI’s sign-in page and enter this code. Codex keeps the sign-in; no account tokens enter Still.</p>
      <div class="settings-login-code">${codeBlock(job.userCode, { label: 'Copy code', done: 'Code copied' })}</div>
      <div class="settings-actions">${linkButton({ label: 'Open sign-in page', href: link, variant: 'primary' })}${button({ label: 'Cancel', size: 'sm', variant: 'ghost', action: 'settings.chatgpt-cancel' })}</div>
    </div>`;
  }
  return html`<div class="settings-row is-stacked settings-login" role="status"><div class="settings-loading">${spinner({ size: 16 })}<span>Starting Codex sign-in.</span></div>
    <div class="settings-actions">${button({ label: 'Cancel', size: 'sm', variant: 'ghost', action: 'settings.chatgpt-cancel' })}</div></div>`;
}

function bridgeProviderRow(ctx, provider) {
  const id = `bridge:${provider.id}`;
  const current = aiSettings(ctx).chat?.connectionId === id;
  return row({ lead: providerMark('bridge', 32), label: provider.name, description: [provider.type, provider.model, provider.hasCredentials ? '' : 'No key saved'].filter(Boolean).join(' · '),
    control: html`${button({ label: current ? 'Used for chat' : 'Use for chat', icon: current ? 'check' : '', size: 'sm', pressed: current, action: 'settings.agent-use', data: { id } })}
      ${button({ label: 'Remove', size: 'sm', variant: 'ghost', action: 'settings.bridge-provider-remove', data: { id, name: provider.name } })}` });
}

/* ------------------------------------------------------------------ Semantic search */

function renderSearch(ctx) {
  const ai = ctx.ai;
  if (!ai) return aiUnavailable();
  if (!data.connections) return loadingBlock('Loading embedding providers');
  const embeddings = aiSettings(ctx).embeddings || { enabled: false };
  const candidates = embeddingConnections(data.connections);
  const current = candidates.find(c => c.id === embeddings.connectionId) || null;
  const provider = current ? ai.getProvider(current.providerId) : null;
  const models = current?.embeddingModels || [];
  const modelId = embeddings.model || provider?.embeddings?.default || models[0]?.id || '';
  const model = models.find(entry => entry.id === modelId) || null;
  const dimsOptions = (model?.dimsOptions || []).filter(Boolean);
  const dims = embeddings.dims || model?.dims || dimsOptions[0] || null;
  const status = data.index;
  const summary = indexSummary(status);
  const enabled = embeddings.enabled === true;
  const note = embeddingNote({ providerName: provider?.name || status?.provider || '', local: !!provider?.local, tokens: status?.pendingTokens || 0,
    price: model?.pricePerMTok ?? EMBEDDING_PRICES[modelId] ?? null });
  return html`
    ${group({ title: 'Search by meaning', body: card([
      switchRow({ label: 'Semantic search', description: 'Builds an index of your library with an embedding model, so search, Related items, Ask and the MCP semantic_search tool can match ideas, not only words.',
        checked: enabled, disabled: !candidates.length, action: 'settings.search-enable' }),
      candidates.length ? row({ label: 'Embedding provider', description: current?.providerId === 'voyage' ? 'Voyage AI is Anthropic’s recommended embeddings partner.' : 'Voyage AI is recommended with Claude.',
        control: select({ name: 'connection', value: current?.id || '', label: 'Embedding provider', action: 'settings.search-connection', size: 'sm', className: 'settings-select',
          options: [...(current ? [] : [{ value: '', label: 'Choose a provider' }]), ...candidates.map(c => ({ value: c.id, label: `${c.label}${c.providerId === 'voyage' ? ' (recommended)' : ''}` }))] }) }) : '',
      current && models.length ? row({ label: 'Model', description: 'Changing the provider, model or size rebuilds the index.',
        control: html`${select({ name: 'model', value: modelId, label: 'Embedding model', action: 'settings.search-model', size: 'sm', className: 'settings-select',
          options: withCurrent(models.map(entry => ({ value: entry.id, label: `${entry.name || entry.id}${entry.installed === false ? ' (not installed)' : ''}` })), modelId, modelId) })}
          ${current.providerId === 'ollama' || current.providerId === 'lmstudio' ? iconButton({ icon: 'refresh-cw', label: 'Refresh models', size: 'sm', action: 'settings.search-refresh-models', data: { id: current.id } }) : ''}` }) : '',
      current && dimsOptions.length > 1 ? row({ label: 'Vector size', description: 'Smaller vectors use less space. Larger ones can be slightly more accurate.',
        control: select({ name: 'dims', value: String(dims || ''), label: 'Vector size', action: 'settings.search-dims', size: 'sm', className: 'settings-select is-narrow',
          options: dimsOptions.map(value => ({ value: String(value), label: `${value} dimensions` })) }) }) : '',
    ]) })}
    ${candidates.length ? '' : callout({ tone: 'info', icon: 'brain', title: 'Connect an embedding model first',
      body: 'Voyage AI is recommended with Claude. OpenAI, Google Gemini, Mistral and Ollama (free, on this computer) work too.',
      actions: html`${button({ label: 'Connect Voyage AI', size: 'sm', variant: 'primary', action: 'settings.connect-open', data: { provider: 'voyage' } })}
        ${button({ label: 'Connect OpenAI', size: 'sm', action: 'settings.connect-open', data: { provider: 'openai' } })}
        ${button({ label: 'Use Ollama', size: 'sm', variant: 'ghost', action: 'settings.connect-open', data: { provider: 'ollama' } })}` })}
    ${enabled || (status?.indexed || 0) > 0 ? group({ title: 'Index', body: card([indexRow(ctx, status, summary)]) }) : ''}
    ${note.length ? html`<p class="settings-note">${icon('info', { size: 14 })}<span>${note.join(' ')}</span></p>` : ''}`;
}

function indexRow(ctx, status, summary) {
  const enabled = !!status?.enabled;
  const working = busy.has('index');
  const actions = [];
  if (enabled && status.running) actions.push(button({ label: 'Pause', icon: 'circle-stop', size: 'sm', action: 'settings.index-pause', loading: working }));
  else if (enabled && (status.paused || status.pending > 0 || status.error)) actions.push(button({ label: status.paused ? 'Resume' : 'Index now', icon: 'refresh-cw', size: 'sm', variant: 'primary', action: 'settings.index-resume', loading: working }));
  if (enabled) actions.push(button({ label: 'Rebuild', size: 'sm', variant: 'secondary', action: 'settings.index-rebuild' }));
  if ((status?.indexed || 0) > 0 || enabled) actions.push(button({ label: 'Clear', size: 'sm', variant: 'ghost', className: 'settings-danger-text', action: 'settings.index-clear' }));
  return html`<div class="settings-row is-stacked index-status" role="status" aria-live="polite">
    <div class="index-status-head"><span class="settings-row-label">${status?.model || 'Index'} ${badge({ label: summary.label, tone: summary.tone })}</span>
      ${status?.lastRunAt ? html`<span class="settings-row-desc">Last run ${since(status.lastRunAt)}</span>` : ''}</div>
    ${summary.percent !== null ? progressBar({ percent: summary.state === 'running' && !status.total ? null : summary.percent, label: 'Indexed items', tone: summary.tone }) : ''}
    <p class="${cx('settings-row-desc', summary.state === 'error' && 'is-error')}">${summary.detail}</p>
    ${actions.length ? html`<div class="settings-actions">${actions}</div>` : ''}
  </div>`;
}

/* ------------------------------------------------------------------ Agents & MCP */

function mcpSetup(ctx) {
  const runtime = data.bridge?.runtime;
  const root = runtime?.projectRoot || ctx.prefs.get('settings.mcpRoot', '');
  return { setup: integrations.getMcpSetup(root, { nodePath: runtime?.nodePath || '' }), runtime, root };
}

function renderAgents(ctx) {
  const { setup, runtime, root } = mcpSetup(ctx);
  const info = data.integration;
  const paired = !!info?.bridgeConfigured;
  const clients = data.clients;
  const byId = new Map((clients || []).map(client => [client.clientId || client.id, client]));
  const extra = (clients || []).filter(client => !MCP_CLIENTS.some(entry => entry.id === (client.clientId || client.id)));
  const listed = [...MCP_CLIENTS, ...extra.map(client => ({ id: client.clientId || client.id, name: client.name, mark: client.clientId || client.id,
    blurb: EXTRA_CLIENT_BLURBS[client.clientId || client.id] || 'Another agent the bridge can set up.', docs: client.docs,
    manual: () => client.configSnippet ? [{ label: `Add this to ${client.configPath}`, code: client.configSnippet }] : [] }))];
  const configured = (clients || []).filter(client => clientStatus(client)?.tone === 'success').length;
  return html`
    <p class="settings-lead">Still includes an MCP server, so Claude Code, Codex, Claude Desktop and other agents can search, read and organize your library. The server runs from the Still folder on this computer and reaches this extension through the local bridge.</p>
    ${group({ title: 'Local bridge', body: html`${bridgeBlock(ctx)}${paired && data.clientsError ? callout({ tone: 'warning', title: 'Agent connections could not be checked', body: data.clientsError }) : ''}` })}
    ${runtime ? '' : group({ title: 'Still folder', body: card([row({ stacked: true, label: 'Where Still is on this computer',
      description: 'Pairing the bridge fills this in. Until then, type the folder that contains bridge/ so the commands below are ready to paste.',
      control: input({ id: 'settings-mcp-root', value: root, placeholder: '/path/to/sidebar-dock', action: 'settings.mcp-root', label: 'Still folder' }) })]) })}
    ${group({ title: 'Connect an agent', description: paired ? 'Connect adds Still to the agent’s own configuration, with a backup of the file it changes.' : 'Pair the bridge for one-click Connect. Until then, use the setup steps for each agent.',
      actions: clients ? html`<span class="settings-pill">${configured} of ${plural(clients.length, 'agent')} connected</span>` : '',
      body: card(listed.map(entry => clientRow(ctx, entry, byId.get(entry.id), setup, paired))) })}
    ${group({ title: 'Set up from a terminal', body: card([row({ stacked: true, label: 'One command per agent',
      description: 'From the Still folder, this connects an agent and prints the bridge address and pairing token. Use codex, desktop or cursor in place of claude.',
      control: html`${codeBlock('npm run connect -- claude', { label: 'Copy command' })}<span class="settings-row-desc">Then start the bridge and leave it running:</span>${codeBlock('npm run bridge', { label: 'Copy command' })}` })]) })}
    ${group({ title: 'Tools agents can use', description: `${MCP_TOOLS.length} tools. Changes go through Still, so they appear here right away and respect Trash and Undo where they apply.`,
      body: html`${disclosure(ctx, 'tools', disclosed(ctx, 'tools') ? 'Hide the tool list' : 'Show the tool list')}${disclosed(ctx, 'tools') ? html`<div class="mcp-tools" id="settings-more-tools">
        ${[['Read', false], ['Change', true]].map(([label, write]) => html`<div class="mcp-tools-group"><h5 class="mcp-tools-title">${label}</h5><ul class="mcp-tools-list" role="list">
          ${MCP_TOOLS.filter(tool => tool.write === write).map(tool => html`<li><code>${tool.name}</code><span>${tool.text}</span></li>`)}</ul></div>`)}</div>` : ''}` })}
    ${info?.bridgeUrl ? html`<p class="settings-note">${icon('info', { size: 14 })}<span>Clients that connect over HTTP can use <span class="settings-mono">${info.bridgeUrl}/mcp</span> with the pairing token as a bearer token. The commands above use stdio and keep the token out of client settings.</span></p>` : ''}`;
}

function clientRow(ctx, entry, client, setup, paired) {
  const status = client ? clientStatus(client) : null;
  const key = `client:${entry.id}`;
  const manualOpen = disclosed(ctx, `manual-${entry.id}`);
  const steps = entry.manual(setup).filter(step => step.code);
  const connectable = paired && client && entry.bridge !== false;
  const actions = [];
  if (connectable && status?.tone === 'success') actions.push(button({ label: 'Disconnect', size: 'sm', variant: 'ghost', action: 'settings.client-disconnect', data: { id: entry.id, name: entry.name }, loading: busy.has(key) }));
  else if (connectable && client.canConnect) actions.push(button({ label: 'Connect', icon: 'plug', size: 'sm', variant: 'secondary', action: 'settings.client-connect', data: { id: entry.id, name: entry.name }, loading: busy.has(key) }));
  // Skills go into the client's own folder, so offer them only for clients that are installed or already connected.
  if (connectable && client.skillSupported !== false && client.skillPath && (client.installed || status?.tone === 'success')) {
    actions.push(client.skillInstalled ? html`<span class="settings-inline-status">${icon('circle-check', { size: 14 })}Skill installed</span>`
      : button({ label: 'Install the Still skill', size: 'sm', variant: 'ghost', action: 'settings.client-skill', data: { id: entry.id, name: entry.name }, loading: busy.has(`skill:${entry.id}`) }));
  }
  const reason = client?.reason && status?.tone === 'warning' ? client.reason : '';
  return html`<div class="settings-row is-stacked client-row" data-key="client-${entry.id}">
    <div class="settings-row-split">
      ${providerMark(entry.mark, 32)}
      <div class="settings-row-text"><span class="settings-row-label">${entry.name} ${status ? badge(status) : ''}</span>
        <span class="${cx('settings-row-desc', reason && 'is-warning')}">${reason || entry.blurb}</span></div>
      ${actions.length ? html`<div class="settings-row-control">${actions}</div>` : ''}
    </div>
    ${steps.length ? html`${disclosure(ctx, `manual-${entry.id}`, manualOpen ? 'Hide setup steps' : connectable ? 'Set up by hand' : 'Setup steps')}
      ${manualOpen ? html`<div class="client-manual" id="settings-more-manual-${entry.id}">
        ${steps.map(step => html`<p class="settings-row-desc">${step.label}</p>${codeBlock(step.code)}`)}
        ${entry.note ? html`<p class="settings-row-desc">${entry.note}</p>` : ''}
        ${!setup.rootKnown ? html`<p class="settings-row-desc is-warning">Replace /path/to/sidebar-dock with the folder where Still lives on this computer.</p>` : ''}
        ${entry.docs || client?.docs ? html`<a class="link-inline settings-docs" href="${safeHref(client?.docs || entry.docs)}" target="_blank" rel="noopener noreferrer">${entry.name} MCP guide</a>` : ''}
      </div>` : ''}` : ''}
  </div>`;
}

/* ------------------------------------------------------------------ Integrations */

function renderIntegrations(ctx) {
  const info = bridgeSettings() || {};
  const raindrop = info.raindropConnectedAt ? { label: 'Connected', tone: 'success' } : info.raindropConfigured ? { label: 'Token saved', tone: 'neutral' } : { label: 'Not connected', tone: 'neutral' };
  const bridge = data.integration ? bridgeSummary({ integration: info, live: ctx.state.bridge, bridge: data.bridge }) : null;
  const setUp = (section, anchor) => button({ label: 'Set up', iconRight: 'arrow-right', size: 'sm', action: 'settings.section', data: { section, anchor } });
  return html`
    ${group({ title: 'Built in', body: card([
      row({ lead: providerMark('raindrop', 32), label: html`Raindrop.io ${badge(raindrop)}`, description: 'Bring in collections, bookmarks, notes and highlights with your API token.',
        control: setUp('library', 'settings-raindrop') }),
      row({ lead: providerMark('bridge', 32), label: html`Local bridge ${bridge ? badge({ label: bridge.label, tone: bridge.tone }) : ''}`,
        description: bridge?.state === 'unpaired' ? 'Runs on this computer so agents, your ChatGPT plan and keys kept outside the browser can reach Still.' : bridge?.detail || 'Checking the local bridge.',
        control: setUp('agents') }),
      row({ lead: providerMark('agent:claude-code', 32), label: 'Claude Code, Codex and Claude Desktop', description: 'Agents search and organize your library through MCP and the local bridge.',
        control: setUp('agents') }),
    ]) })}
    ${integrationGroups(integrations.INTEGRATION_CATALOG).map(entry => group({ title: entry.title, description: entry.description,
      actions: entry.id === 'other' ? '' : button({ label: 'Library & backup', iconRight: 'arrow-right', size: 'sm', variant: 'ghost', action: 'settings.section', data: { section: 'library' } }),
      body: html`<ul class="integration-grid" role="list">${entry.entries.map(app => html`<li><a class="integration-link" href="${safeHref(app.url)}" target="_blank" rel="noopener noreferrer">
        <span class="integration-link-head"><span class="integration-link-name">${app.name}</span>${badge({ label: app.category, tone: 'outline' })}${icon('arrow-up-right', { size: 14, className: 'integration-link-icon' })}</span>
        <span class="integration-link-desc">${app.description}</span></a></li>`)}</ul>` }))}`;
}

/* ------------------------------------------------------------------ Shortcuts */

const keyCaps = keys => String(keys).split(' ').map(chord => kbd(chord));
const chromeKeys = shortcut => html`<kbd class="kbd">${String(shortcut).split('+').filter(Boolean).map(part => html`<span>${part}</span>`)}</kbd>`;

function renderShortcuts(ctx) {
  const groups = groupShortcuts(listShortcuts());
  const commands = chromeCommandRows(data.commands);
  return html`
    ${groups.map(entry => group({ title: entry.group === 'General' ? 'In Still' : entry.group, body: card(entry.rows.map(shortcut => html`<div class="shortcut-row">
      <span class="shortcut-label">${shortcut.label}</span><span class="shortcut-keys">${keyCaps(shortcut.keys)}</span></div>`), 'shortcut-card') }))}
    ${group({ title: 'Writing notes', body: card(NOTE_KEYS.map(shortcut => html`<div class="shortcut-row"><span class="shortcut-label">${shortcut.label}</span>
      <span class="shortcut-keys">${shortcut.literal ? html`<kbd class="kbd"><span>${shortcut.keys}</span></kbd>` : kbd(shortcut.keys)}</span></div>`), 'shortcut-card') })}
    ${group({ title: 'Anywhere in Chrome', description: 'These work on any page, even when Still is closed.', body: html`${card(commands.map(command => html`<div class="shortcut-row">
      <span class="shortcut-label">${command.label}</span><span class="shortcut-keys">${command.shortcut ? chromeKeys(command.shortcut) : html`<span class="settings-row-desc">Not set</span>`}</span></div>`), 'shortcut-card')}
      <div class="settings-actions settings-actions-below">
        ${button({ label: 'Change in Chrome', iconRight: 'external-link', size: 'sm', action: 'settings.shortcuts-page' })}
        ${button({ label: 'Copy page address', icon: 'copy', size: 'sm', variant: 'ghost', action: 'app.copy', data: { text: SHORTCUTS_PAGE, done: 'Copied. Paste it into the address bar.' } })}
        <span class="settings-row-desc">${SHORTCUTS_PAGE}</span>
      </div>` })}`;
}

/* ------------------------------------------------------------------ About */

function renderAbout(ctx) {
  const usage = data.storage?.usage;
  const links = [{ label: 'Documentation', url: `${REPO}#readme`, icon: 'book-open' }, { label: 'Report a problem', url: `${REPO}/issues`, icon: 'flag' }, { label: 'Source code', url: REPO, icon: 'code' }];
  return html`
    ${group({ title: 'Still', body: card([
      row({ lead: brandMark({ size: 32, className: 'settings-brand' }), label: `Still ${version()}`, description: 'Bookmarks, notes, highlights and AI in one local-first library.',
        control: button({ label: 'Help', icon: 'circle-help', size: 'sm', variant: 'ghost', action: 'settings.section', data: { section: 'help' } }) }),
    ]) })}
    ${group({ title: 'Where your data lives', body: card([
      row({ label: 'Library', description: 'Items, collections, notes and highlights are kept in this Chrome profile’s extension storage. Files are kept in this browser’s database. Nothing is uploaded unless you connect something below.' }),
      row({ label: 'Storage used', description: usage != null ? `${fileSize(usage)} on this device.` : 'Chrome did not report storage use.' }),
      row({ label: 'AI keys', description: 'Stored on this device in Chrome’s extension storage. Not included in backups. Sent only to the provider they belong to.' }),
      row({ label: 'AI requests', description: 'When you ask a question, the question and the context you choose go to the provider you picked. The footnote under Ask names it.' }),
      row({ label: 'Local bridge', description: 'When paired, the library syncs to the bridge on this computer so agents can use it. Files and keys stay in the browser.' }),
      row({ label: 'Backups', description: 'Download a full backup now and then. Removing the extension deletes its storage.',
        control: button({ label: 'Library & backup', iconRight: 'arrow-right', size: 'sm', action: 'settings.section', data: { section: 'library' } }) }),
    ]) })}
    ${group({ title: 'Links', body: card(links.map(link => html`<a class="settings-link-row" href="${safeHref(link.url)}" target="_blank" rel="noopener noreferrer">
      ${icon(link.icon, { size: 16 })}<span>${link.label}</span>${icon('arrow-up-right', { size: 14, className: 'settings-link-row-icon' })}</a>`)) })}`;
}

/* ------------------------------------------------------------------ Help */

function renderHelp(ctx) {
  const shortcuts = [{ keys: 'mod+k', label: 'Search and commands' }, { keys: 'a', label: 'Add a link' }, { keys: 'n', label: 'New note' }, { keys: 'mod+shift+a', label: 'Ask AI' }, { keys: '?', label: 'All keyboard shortcuts' }];
  return html`
    ${group({ title: 'Getting started', body: html`<ol class="help-steps" role="list">${GETTING_STARTED.map(step => html`<li class="help-step">
      <span class="help-step-icon" aria-hidden="true">${icon(step.icon, { size: 16 })}</span><span class="help-step-text"><span class="help-step-title">${step.title}</span><span class="help-step-body">${step.text}</span></span></li>`)}</ol>` })}
    ${group({ title: 'Search syntax', description: 'Type these in the search field. They work in every view.', body: card(SEARCH_SYNTAX.map(entry => html`<div class="syntax-row">
      <code class="syntax-code">${entry.code}</code><span class="syntax-text">${entry.text}</span></div>`), 'syntax-card') })}
    ${group({ title: 'Keyboard', actions: button({ label: 'All shortcuts', iconRight: 'arrow-right', size: 'sm', variant: 'ghost', action: 'settings.section', data: { section: 'shortcuts' } }),
      body: card(shortcuts.map(shortcut => html`<div class="shortcut-row"><span class="shortcut-label">${shortcut.label}</span><span class="shortcut-keys">${keyCaps(shortcut.keys)}</span></div>`), 'shortcut-card') })}
    ${group({ title: 'Guides', body: card(GUIDES.map(guide => html`<a class="settings-link-row" href="${safeHref(guide.url)}" target="_blank" rel="noopener noreferrer">
      ${icon('book-open', { size: 16 })}<span>${guide.label}</span>${icon('arrow-up-right', { size: 14, className: 'settings-link-row-icon' })}</a>`)) })}
    ${group({ title: 'The reference room', description: `All ${REFERENCE_ASSETS.length} reference images that shaped Still: library layouts, notes, capture, collections, highlights, AI and agent connections. Open one to see it full size.`,
      body: html`<ul class="reference-grid" role="list">${REFERENCE_ASSETS.map(asset => html`<li><figure class="reference-figure">
        <a class="reference-link" href="./${encodeURI(asset.path)}" target="_blank" rel="noopener noreferrer" aria-label="${asset.description}, open full size">
          <img src="${safeSrc(asset.path)}" alt="${asset.description}" loading="lazy" decoding="async" width="320" height="200"></a>
        <figcaption><span class="reference-title">${asset.description}</span><span class="reference-file">${asset.name}</span></figcaption></figure></li>`)}</ul>` })}`;
}

/* ------------------------------------------------------------------ Connect dialog */

function openConnect(ctx, { providerId = '', id = '' } = {}) {
  const ai = ctx.ai;
  if (!ai) throw new Error('AI settings could not load. Reload Still and try again.');
  const connection = id ? (data.connections || []).find(entry => entry.id === id) : null;
  const provider = ai.getProvider(connection?.providerId || providerId);
  if (!provider) throw new Error('Choose a supported AI provider.');
  connectDraft = { apiKey: '', baseUrl: connection?.baseUrl || provider.baseUrl || '', label: connection && connection.label !== provider.name ? connection.label : '',
    workspaceId: connection?.workspaceId || '', defaultModel: connection?.defaultModel || provider.chat?.recommended || '' };
  ctx.openDialog(CONNECT, { providerId: provider.id, id: connection?.id || '', showKey: false, saving: false, testing: false, result: null, justConnected: false,
    models: null, modelsLoading: false, modelsError: '', advanced: !!connection?.workspaceId });
  if (connection && provider.chat && provider.modelList) loadModels(ctx, connection.id);
}

async function loadModels(ctx, id, { refresh: fresh = false, access } = {}) {
  patchConnect(ctx, { modelsLoading: true, modelsError: '' });
  try {
    await access;
    patchConnect(ctx, { models: await ctx.ai.listModels(id, { refresh: fresh, kind: 'chat' }), modelsLoading: false });
  } catch (error) { patchConnect(ctx, { modelsLoading: false, modelsError: error.message }); }
}

// access: the hostAccess request started in the click. A refusal reads as a failed test, like any other.
async function testWithAccess(ctx, id, access) {
  try {
    await access;
    return await ctx.ai.testConnection(id);
  } catch (error) { return { ok: false, message: error.message, code: error.code }; }
}

const ERROR_HINTS = {
  auth: 'Check that the key is complete and still active.',
  permission: 'Chrome needs your permission to reach this provider. Try again and choose Allow.',
  rate_limit: 'The provider is limiting requests for this key. Wait a minute and try again.',
  provider_down: 'The provider is having trouble right now. Try again in a few minutes.',
  not_found: 'Check the base URL and the model name.',
  no_model: 'Choose a model, then test again.',
  workspace_required: 'Add the workspace ID under More options, or create a key that belongs to a workspace.',
};

function renderConnect(ctx, props) {
  const ai = ctx.ai;
  const provider = ai?.getProvider(props.providerId);
  if (!provider) return html`<header class="dialog-header"><h2 class="dialog-title" id="dialog-title-settings.connect">Provider unavailable</h2></header>`;
  const connection = props.id ? (data.connections || []).find(entry => entry.id === props.id) : null;
  const d = connectDraft;
  const keyOptional = !provider.needsKey;
  const showKeyField = provider.needsKey || provider.kind === 'custom' || provider.id === 'lmstudio';
  const result = props.result;
  const keyInvalid = result && !result.ok && result.code === 'auth';
  const models = props.models || connection?.models || (provider.chat?.defaults || []).map(entry => ({ id: entry.id, name: entry.label, description: entry.description }));
  const modelId = d.defaultModel || connection?.defaultModel || provider.chat?.recommended || '';
  const model = models.find(entry => entry.id === modelId);
  const working = props.saving || props.testing;
  const primary = !props.id ? 'Connect' : props.justConnected ? 'Done' : 'Save';
  const advancedOpen = props.advanced || result?.code === 'workspace_required';
  return html`<form class="dialog-form settings-connect-form" data-submit="settings.connect-save" novalidate>
    <div class="dialog-header settings-connect-head">
      ${providerMark(provider.id, 36)}
      <div class="dialog-heading"><h2 class="dialog-title" id="dialog-title-settings.connect">${connection ? connection.label : `Connect ${provider.name}`}</h2>
        <p class="dialog-subtitle">${provider.description}</p></div>
      ${iconButton({ icon: 'x', label: 'Close', action: 'overlay.dismiss', size: 'sm', className: 'dialog-close' })}
    </div>
    <div class="dialog-body settings-connect-body">
      ${provider.setupHint ? callout({ tone: 'info', body: provider.setupHint }) : ''}
      ${provider.kind === 'custom' ? field({ label: 'Name', id: 'settings-connect-label', control: input({ id: 'settings-connect-label', value: d.label, placeholder: provider.name,
        action: 'settings.connect-field', attrs: { 'data-field': 'label' } }) }) : ''}
      ${provider.editableBaseUrl ? field({ label: 'Base URL', id: 'settings-connect-base', hint: provider.local ? 'The address of the server on this computer or your network.' : '',
        control: provider.baseUrlOptions?.length
          ? select({ id: 'settings-connect-base', name: 'baseUrl', value: d.baseUrl, action: 'settings.connect-base', label: 'Base URL', options: provider.baseUrlOptions.map(option => ({ value: option.url, label: `${option.label} (${option.url})` })) })
          : input({ id: 'settings-connect-base', type: 'url', value: d.baseUrl, placeholder: provider.baseUrlPlaceholder || provider.baseUrl || 'https://example.com/v1',
            action: 'settings.connect-field', invalid: result && !result.ok && result.code === 'not_found', attrs: { 'data-field': 'baseUrl' } }) }) : ''}
      ${showKeyField ? field({ label: keyOptional ? 'API key (optional)' : 'API key', id: 'settings-connect-key',
        error: keyInvalid ? result.message : '',
        hint: html`${connection?.hasKey ? 'Paste a new key to replace the saved one. ' : ''}Stored on this device in Chrome’s extension storage. Not included in backups.${provider.keyUrl
          ? html` <a class="link-inline" href="${safeHref(provider.keyUrl)}" target="_blank" rel="noopener noreferrer">Get a key</a>` : ''}`,
        control: html`<span class="settings-secret">${input({ id: 'settings-connect-key', type: props.showKey ? 'text' : 'password', value: d.apiKey,
          placeholder: connection?.hasKey ? `Saved key ${maskedKey(keyHintOf(connection))}` : provider.keyPlaceholder || 'Paste your key', action: 'settings.connect-field', invalid: keyInvalid,
          describedBy: keyInvalid ? 'settings-connect-key-error' : 'settings-connect-key-hint', attrs: { 'data-field': 'apiKey', 'data-autofocus': !connection } })}
          ${iconButton({ icon: props.showKey ? 'eye-off' : 'eye', label: props.showKey ? 'Hide key' : 'Show key', action: 'settings.connect-toggle-key', size: 'sm', pressed: !!props.showKey })}</span>` }) : ''}
      ${provider.transport === 'anthropic' ? html`${button({ label: 'More options', iconRight: advancedOpen ? 'chevron-down' : 'chevron-right', size: 'sm', variant: 'ghost',
        action: 'settings.connect-advanced', className: 'settings-connect-more', attrs: { 'aria-expanded': advancedOpen ? 'true' : 'false', 'aria-controls': 'settings-connect-advanced' } })}
        ${advancedOpen ? html`<div id="settings-connect-advanced">${field({ label: 'Workspace ID (optional)', id: 'settings-connect-workspace', hint: 'Only needed for keys that are not tied to a workspace.',
          control: input({ id: 'settings-connect-workspace', value: d.workspaceId, placeholder: 'wrkspc_…', action: 'settings.connect-field', attrs: { 'data-field': 'workspaceId' } }) })}</div>` : ''}` : ''}
      ${provider.chat ? field({ label: 'Default model', id: 'settings-connect-model', hint: props.modelsError || model?.description || (props.id ? '' : 'You can change this later.'),
        control: html`<span class="settings-model-pick">${select({ id: 'settings-connect-model', name: 'defaultModel', value: modelId, label: 'Default model', action: 'settings.connect-model',
          disabled: !models.length && !modelId, options: withCurrent(models.length ? models.map(entry => ({ value: entry.id, label: `${entry.name || entry.id}${entry.recommended ? ' (recommended)' : ''}` }))
            : [{ value: '', label: provider.local ? 'Models appear after connecting' : 'Choose after connecting' }], modelId, modelId) })}
          ${props.id && provider.modelList ? iconButton({ icon: 'refresh-cw', label: 'Refresh the model list', action: 'settings.connect-refresh-models', size: 'sm', className: cx(props.modelsLoading && 'is-spinning') }) : ''}</span>` })
        : callout({ tone: 'info', icon: 'brain', body: `${provider.name} creates embeddings for semantic search. It does not answer chat questions.`,
          actions: props.id ? button({ label: 'Set up semantic search', iconRight: 'arrow-right', size: 'sm', action: 'settings.connect-to-search' }) : '' })}
      ${props.testing ? html`<div class="settings-loading" role="status">${spinner({ size: 16 })}<span>Testing the connection.</span></div>` : ''}
      ${result && !keyInvalid ? callout({ tone: result.ok ? 'success' : 'danger', live: true,
        title: result.ok ? `Connected${Number.isFinite(result.latencyMs) ? ` in ${result.latencyMs.toLocaleString()} ms` : ''}` : 'Could not connect',
        body: result.ok ? html`${result.message || ''}${result.model ? html` <span class="settings-mono">${result.model}</span>` : ''}` : html`${result.message}${ERROR_HINTS[result.code] ? html` ${ERROR_HINTS[result.code]}` : ''}` }) : ''}
    </div>
    <div class="dialog-footer">
      ${connection ? button({ label: 'Remove', size: 'md', variant: 'ghost', className: 'settings-danger-text', action: 'settings.connect-remove', disabled: working }) : ''}
      <span class="spacer"></span>
      ${props.id ? button({ label: 'Test', variant: 'secondary', action: 'settings.connect-test', loading: props.testing && !props.saving, disabled: working }) : ''}
      ${button({ label: primary, type: 'submit', variant: 'primary', loading: props.saving, disabled: props.testing })}
    </div>
  </form>`;
}

async function finishConnectSave(ctx, pending, { test, closeOnSuccess, keyTail }) {
  patchConnect(ctx, { saving: true, result: null });
  let connection;
  try { connection = await pending; } catch (error) {
    patchConnect(ctx, { saving: false, result: { ok: false, message: error.message || 'The connection could not be saved.', code: error.code || 'error' } });
    return;
  }
  if (keyTail) keyTails.set(connection.id, keyTail);
  connectDraft.apiKey = '';
  clearSecretField('settings-connect-key');
  patchConnect(ctx, { id: connection.id, saving: false, testing: test, showKey: false });
  if (!test) { ctx.closeDialog(CONNECT); ctx.toast(`${connection.label} saved`, { tone: 'success' }); await loadAi(ctx); return; }
  let result;
  try { result = await ctx.ai.testConnection(connection.id); } catch (error) { result = { ok: false, message: error.message, code: error.code }; }
  await loadAi(ctx);
  if (result.ok && closeOnSuccess) { ctx.closeDialog(CONNECT); ctx.toast(`${connection.label} connected`, { tone: 'success' }); return; }
  patchConnect(ctx, { testing: false, result, justConnected: result.ok });
  const provider = ctx.ai.getProvider(connection.providerId);
  if (result.ok && provider?.chat && provider.modelList) loadModels(ctx, connection.id);
}

/* ------------------------------------------------------------------ actions */

function goToSection(ctx, section, anchor) {
  const ui = uiState(ctx);
  ui.section = normalizeSection(section);
  ui.list = false;
  ctx.render();
  ctx.nextFrame(() => {
    const target = anchor && document.getElementById(anchor);
    if (target) { target.scrollIntoView({ block: 'start', behavior: 'smooth' }); target.focus({ preventScroll: true }); }
    else if (ctx.env.isSidepanel) document.querySelector('.settings-back')?.focus();
  });
}

const updateLibrarySettings = (ctx, patch) => ctx.store.updateSettings(patch);

async function setAi(ctx, patch) {
  if (!ctx.ai) throw new Error('AI settings could not load. Reload Still and try again.');
  data.aiSettings = await ctx.ai.setAiSettings(patch);
  ctx.render();
}

function pollLogin(ctx) {
  clearTimeout(live.loginTimer);
  const job = data.login;
  if (!job || !['pending', 'user_action_needed'].includes(job.status) || !isOpen(ctx)) return;
  live.loginTimer = setTimeout(async () => {
    try {
      const next = await ctx.ai.chatGptSignInStatus(job.id);
      if (data.login?.id !== job.id) return;
      data.login = next || { ...job, status: 'failed', error: 'The bridge lost track of this sign-in. Start again.' };
      if (data.login.status === 'authenticated') { ctx.toast('Signed in with ChatGPT', { tone: 'success' }); await loadAi(ctx); }
    } catch (error) { data.login = { ...job, status: 'failed', error: error.message }; }
    ctx.render();
    pollLogin(ctx);
  }, 2000);
}

// The bridge applies a client change only against the configuration it previewed, so take a fresh preview first.
async function applyClientChange(id, action) {
  const path = `/connections/${encodeURIComponent(id)}`;
  const preview = await integrations.requestBridge(`${path}/preview`, { method: 'POST', body: {} });
  if (action === 'connect' && !preview?.canConnect) throw new Error(preview?.reason || 'This agent needs manual setup. Use the setup steps instead.');
  return integrations.requestBridge(`${path}/${action}`, { method: 'POST', body: { previewHash: preview?.previewHash ?? preview?.configHash ?? null } });
}

async function runImport(ctx, file) {
  if (!file) return;
  if (!isOpen(ctx)) openSettings(ctx, 'library');
  data.importJob = { name: file.name || 'the file', running: true };
  ctx.render();
  try {
    const result = await importPortableFile(file, ctx.store);
    data.importJob = { name: file.name || 'the file', result };
    ctx.toast(`Added ${plural(result.items, 'item')}${result.files ? ` and ${plural(result.files, 'file')}` : ''}`, { tone: 'success' });
  } catch (error) {
    data.importJob = { name: file.name || 'the file', error: error.message || 'The file could not be read.' };
  }
  ctx.render();
}

registerDialog(DIALOG, renderSettings, {
  size: 'xl', className: 'settings-dialog',
  // In the side panel, Escape inside a section goes back to the section list first.
  beforeClose: ctx => {
    if (live.forceClose || !ctx.env.isSidepanel) return true;
    const ui = uiState(ctx);
    if (ui.list) return true;
    const from = ui.section;
    ui.list = true;
    ctx.render();
    focusSoon(ctx, `#settings-row-${from}`);
    return false;
  },
});
registerDialog(CONNECT, renderConnect, { size: 'md', className: 'settings-connect' });

registerActions({
  'settings.close': ({ ctx }) => { live.forceClose = true; try { ctx.closeDialog(DIALOG); } finally { live.forceClose = false; } },
  'settings.section': ({ ctx, data: payload }) => goToSection(ctx, payload.section, payload.anchor),
  'settings.back': ({ ctx }) => {
    const ui = uiState(ctx);
    const from = ui.section;
    ui.list = true;
    ctx.render();
    focusSoon(ctx, `#settings-row-${from}`);
  },
  'settings.disclose': ({ ctx, data: payload }) => {
    const open = uiState(ctx).open;
    if (open.has(payload.id)) open.delete(payload.id); else open.add(payload.id);
    ctx.render();
  },

  // General and Appearance
  'settings.default-collection': ({ ctx, data: payload }) => updateLibrarySettings(ctx, { defaultCollectionId: payload.value || '' }),
  'settings.toggle': ({ ctx, el, data: payload }) => updateLibrarySettings(ctx, { [payload.key]: !!el.checked }),
  'settings.appearance': ({ ctx, data: payload }) => {
    if (!['theme', 'accent', 'density'].includes(payload.name)) return undefined;
    return updateLibrarySettings(ctx, { [payload.name]: payload.value });
  },

  // Library & backup
  'settings.backup': ({ ctx }) => withBusy(ctx, 'backup', async () => {
    const snapshot = await createFullBackup(ctx.store);
    download(JSON.stringify(snapshot, null, 2), `still-backup-${today()}.json`, 'application/json');
    ctx.toast(`Backup downloaded: ${plural(snapshot.items.length, 'item')}${snapshot.attachments.length ? `, ${plural(snapshot.attachments.length, 'file')}` : ''}`, { tone: 'success' });
  }),
  'settings.import-choose': () => {
    const picker = document.getElementById('import-input');
    if (!picker) throw new Error('The file picker is not available here.');
    picker.click();
  },
  'settings.import-dismiss': ({ ctx }) => { data.importJob = null; ctx.render(); },
  'settings.export-html': ({ ctx }) => withBusy(ctx, 'export-html', async () => {
    download(exportBookmarkHtml(await ctx.store.exportLibrary()), `still-bookmarks-${today()}.html`, 'text/html');
    ctx.toast('Bookmarks exported', { tone: 'success' });
  }),
  'settings.export-notes': ({ ctx }) => withBusy(ctx, 'export-notes', async () => {
    download(exportNotesMarkdown(await ctx.store.exportLibrary()), `still-notes-${today()}.md`, 'text/markdown');
    ctx.toast('Notes exported', { tone: 'success' });
  }),
  'settings.import-chrome': ({ ctx }) => {
    if (!ctx.env.isExtension) throw new Error('Bringing in Chrome bookmarks needs Still installed as an extension.');
    const granted = requestAccess({ permissions: ['bookmarks'] });
    return withBusy(ctx, 'chrome-bookmarks', async () => {
      if (!(await granted)) throw new Error('Chrome did not allow access to your bookmarks. Try again and choose Allow.');
      const result = await ctx.chrome('importBrowserBookmarks');
      ctx.toast(`Added ${plural(result?.imported || 0, 'bookmark')} from Chrome`, { tone: 'success' });
    });
  },
  'settings.raindrop-field': ({ el }) => { drafts.raindropToken = el.value; },
  'settings.raindrop-connect': ({ ctx }) => {
    const granted = requestAccess({ origins: [RAINDROP_ORIGIN] });
    const token = drafts.raindropToken.trim();
    return withBusy(ctx, 'raindrop-connect', async () => {
      if (!(await granted)) throw new Error('Chrome did not allow Still to reach api.raindrop.io. Try again and choose Allow.');
      if (token) await integrations.setRaindropToken(token);
      else if (!data.integration?.raindropConfigured) throw new Error('Paste your Raindrop API token first.');
      if (token) { drafts.raindropToken = ''; clearSecretField('settings-raindrop-token'); }
      let result;
      try { result = await integrations.testRaindropConnection(); } finally { await loadIntegration(ctx); }
      ctx.toast(`Connected to Raindrop. ${plural(result.rootCollections || 0, 'collection')} found.`, { tone: 'success' });
    });
  },
  'settings.raindrop-import': ({ ctx }) => {
    const granted = requestAccess({ origins: [RAINDROP_ORIGIN] });
    if (data.raindrop?.running) return undefined;
    data.raindrop = { running: true, items: 0 };
    ctx.render();
    return (async () => {
      try {
        if (!(await granted)) throw new Error('Chrome did not allow Still to reach api.raindrop.io. Try again and choose Allow.');
        const result = await integrations.importFromRaindrop({ onProgress: progress => { data.raindrop = { running: true, items: progress?.items || 0 }; ctx.render(); } });
        ctx.toast(`Brought in ${plural(result.items, 'bookmark')} and ${plural(result.collections, 'collection')} from Raindrop`, { tone: 'success' });
        await loadIntegration(ctx);
      } finally { data.raindrop = null; ctx.render(); }
    })();
  },
  'settings.raindrop-disconnect': async ({ ctx }) => {
    await integrations.disconnectRaindrop();
    drafts.raindropToken = '';
    clearSecretField('settings-raindrop-token');
    await loadIntegration(ctx);
    ctx.toast('Raindrop disconnected. Items you brought in stay in Still.');
  },
  'settings.empty-trash': async ({ ctx }) => {
    const total = ctx.select.counts().trash;
    if (!total) return;
    const ok = await ctx.confirm({ title: 'Empty the trash?', body: `${plural(total, 'item')} will be deleted forever. This cannot be undone.`, confirmLabel: 'Empty trash', tone: 'danger' });
    if (!ok) return;
    await withBusy(ctx, 'empty-trash', async () => {
      const { ids = [], attachmentIds = [] } = await ctx.store.emptyTrash() || {};
      await Promise.allSettled(attachmentIds.map(id => ctx.store.deleteAttachment(id)));
      await loadStorage();
      ctx.toast(`Deleted ${plural(ids.length, 'item')}`);
    });
  },

  // AI models
  'settings.connect-open': ({ ctx, data: payload }) => openConnect(ctx, { providerId: payload.provider, id: payload.id }),
  'settings.connect-field': ({ el }) => { if (el.dataset.field in connectDraft) connectDraft[el.dataset.field] = el.value; },
  'settings.connect-base': ({ ctx, el }) => { connectDraft.baseUrl = el.value; ctx.render(); },
  'settings.connect-toggle-key': ({ ctx }) => { const props = topProps(ctx, CONNECT); if (props) ctx.updateDialog(CONNECT, { showKey: !props.showKey }); },
  'settings.connect-advanced': ({ ctx }) => { const props = topProps(ctx, CONNECT); if (props) ctx.updateDialog(CONNECT, { advanced: !props.advanced }); },
  'settings.connect-model': ({ ctx, el }) => { connectDraft.defaultModel = el.value; ctx.render(); },
  'settings.connect-refresh-models': ({ ctx }) => {
    const props = topProps(ctx, CONNECT);
    if (!props?.id || props.modelsLoading) return undefined;
    const access = hostAccess(ctx, findConnection(props.id));
    return loadModels(ctx, props.id, { refresh: true, access });
  },
  'settings.connect-save': ({ ctx }) => {
    const props = topProps(ctx, CONNECT);
    const ai = ctx.ai;
    if (!props || !ai || props.saving || props.testing) return undefined;
    const provider = ai.getProvider(props.providerId);
    const connection = props.id ? (data.connections || []).find(entry => entry.id === props.id) : null;
    const d = connectDraft;
    const input = { providerId: provider.id, ...(props.id ? { id: props.id } : {}) };
    if (d.apiKey.trim()) input.apiKey = d.apiKey.trim();
    if (provider.editableBaseUrl && d.baseUrl.trim()) input.baseUrl = d.baseUrl.trim();
    if (provider.kind === 'custom') input.label = d.label.trim();
    if (provider.transport === 'anthropic') input.workspaceId = d.workspaceId.trim();
    if (provider.chat && d.defaultModel) input.defaultModel = d.defaultModel;
    const credentialsChanged = !props.id || !!input.apiKey || (provider.editableBaseUrl && (input.baseUrl || '') !== (connection?.baseUrl || ''))
      || (provider.transport === 'anthropic' && input.workspaceId !== (connection?.workspaceId || '')) || connection?.status === 'error';
    // saveConnection asks Chrome for host access before its first await, so it must run inside this handler's gesture.
    const pending = ai.saveConnection(input);
    return finishConnectSave(ctx, pending, { test: credentialsChanged, closeOnSuccess: !!props.id && !props.justConnected, keyTail: input.apiKey?.slice(-4) });
  },
  'settings.connect-test': ({ ctx }) => {
    const props = topProps(ctx, CONNECT);
    if (!props?.id || props.saving || props.testing) return undefined;
    const access = hostAccess(ctx, findConnection(props.id));
    patchConnect(ctx, { testing: true, result: null });
    return (async () => {
      const result = await testWithAccess(ctx, props.id, access);
      patchConnect(ctx, { testing: false, result });
      await loadAi(ctx);
      if (result.ok && ctx.ai.getProvider(props.providerId)?.modelList) loadModels(ctx, props.id);
    })();
  },
  'settings.connect-remove': async ({ ctx }) => {
    const props = topProps(ctx, CONNECT);
    const connection = props?.id ? (data.connections || []).find(entry => entry.id === props.id) : null;
    if (!connection) return;
    const ok = await ctx.confirm({ title: `Remove ${connection.label}?`, body: 'Its key is deleted from this device. Defaults that used it go back to automatic.', confirmLabel: 'Remove connection', tone: 'danger' });
    if (!ok) return;
    await ctx.ai.deleteConnection(connection.id);
    ctx.closeDialog(CONNECT);
    await loadAi(ctx);
    ctx.toast(`${connection.label} removed`);
  },
  'settings.connect-to-search': ({ ctx }) => {
    const props = topProps(ctx, CONNECT);
    ctx.closeDialog(CONNECT);
    goToSection(ctx, 'search');
    if (props?.id && !aiSettings(ctx).embeddings?.connectionId) return setAi(ctx, { embeddings: { connectionId: props.id } });
    return undefined;
  },
  'settings.connection-test': ({ ctx, data: payload }) => {
    const access = hostAccess(ctx, findConnection(payload.id));
    return withBusy(ctx, `test:${payload.id}`, async () => {
      const result = await testWithAccess(ctx, payload.id, access);
      await loadAi(ctx);
      if (result.ok) ctx.toast(`${result.message || 'Connected.'}${Number.isFinite(result.latencyMs) ? ` ${result.latencyMs.toLocaleString()} ms.` : ''}`, { tone: 'success' });
      else ctx.toast(`${result.message}${ERROR_HINTS[result.code] ? ` ${ERROR_HINTS[result.code]}` : ''}`, { tone: 'danger' });
    });
  },
  'settings.ai-model': ({ ctx, el }) => {
    const { connectionId, model } = parseChoice(el.value);
    const record = findModel(data.connections || [], { connectionId, model }).model;
    return setAi(ctx, { chat: { connectionId, model, effort: effortFor(record, aiSettings(ctx).chat?.effort || 'medium') } });
  },
  'settings.ai-effort': ({ ctx, el }) => (el.value ? setAi(ctx, { chat: { effort: el.value } }) : undefined),
  'settings.ai-quick': ({ ctx, el }) => setAi(ctx, { quick: parseChoice(el.value) }),
  'settings.ai-flag': ({ ctx, el, data: payload }) => setAi(ctx, { [payload.key]: !!el.checked }),
  'settings.ai-handoff': ({ ctx, data: payload }) => setAi(ctx, { handoffTarget: payload.value }),

  // Local bridge
  'settings.bridge-field': ({ el }) => { drafts[el.dataset.field] = el.value; },
  'settings.bridge-pair': ({ ctx }) => {
    if (busy.has('pair')) return undefined;
    const url = String(drafts.bridgeUrl ?? data.integration?.bridgeUrl ?? integrations.DEFAULT_BRIDGE_URL).trim();
    const token = drafts.bridgeToken.trim();
    if (!token) throw new Error('Paste the pairing token the bridge printed.');
    // pairBridge requests loopback host access synchronously, inside this click or Enter.
    const pending = ctx.ai?.pairBridge ? ctx.ai.pairBridge({ url, token })
      : requestAccess({ origins: [`${new URL(url).protocol}//${new URL(url).hostname}/*`] }).then(granted => {
        if (!granted) throw new Error('Chrome did not allow Still to reach the bridge. Try again and choose Allow.');
        return integrations.configureBridge({ url, token, enabled: true });
      });
    return withBusy(ctx, 'pair', async () => {
      await pending;
      drafts.bridgeToken = '';
      clearSecretField('settings-bridge-token');
      drafts.bridgeUrl = null;
      await ctx.startBridgeSync?.();
      await refresh(ctx, { bridge: true });
      ctx.toast('Paired with the local bridge', { tone: 'success' });
    });
  },
  'settings.bridge-pause': ({ ctx }) => withBusy(ctx, 'bridge-sync', async () => {
    ctx.stopBridgeSync?.();
    ctx.stopBridgeSync = null;
    ctx.state.bridge = null;
    // Pausing keeps the pairing token (the old Stop sync deleted it); Unpair is the separate, explicit way to forget it.
    if (typeof integrations.setBridgeEnabled === 'function') {
      await integrations.setBridgeEnabled(false);
      await loadIntegration(ctx);
      ctx.toast('Bridge sync paused. Pairing is kept.');
    } else {
      live.pausedHere = true;
      ctx.toast('Bridge sync paused in this window. Pairing is kept.');
    }
  }),
  'settings.bridge-resume': ({ ctx }) => withBusy(ctx, 'bridge-sync', async () => {
    live.pausedHere = false;
    if (typeof integrations.setBridgeEnabled === 'function') await integrations.setBridgeEnabled(true);
    await loadIntegration(ctx);
    ctx.stopBridgeSync?.();
    await ctx.startBridgeSync?.();
    ctx.toast('Bridge sync resumed');
  }),
  'settings.bridge-unpair': async ({ ctx }) => {
    const ok = await ctx.confirm({ title: 'Unpair the local bridge?', body: 'Still forgets the pairing token. Agents and bridge connections stop working until you pair again. Your library is not changed.',
      confirmLabel: 'Unpair', tone: 'danger' });
    if (!ok) return;
    ctx.stopBridgeSync?.();
    ctx.stopBridgeSync = null;
    ctx.state.bridge = null;
    live.pausedHere = false;
    await integrations.disconnectBridge();
    data.clients = null;
    data.login = null;
    await refresh(ctx, { bridge: true });
    ctx.toast('Bridge unpaired');
  },
  'settings.bridge-refresh': ({ ctx }) => withBusy(ctx, 'bridge-refresh', () => refresh(ctx, { bridge: true })),
  'settings.agent-use': ({ ctx, data: payload }) => setAi(ctx, { chat: { connectionId: payload.id, model: '' } }).then(() => ctx.toast('Chat model updated', { tone: 'success' })),
  'settings.agent-auth': ({ ctx }) => withBusy(ctx, 'agent-auth', async () => {
    const agents = await ctx.ai.cliSignInStatus();
    await loadAi(ctx);
    ctx.toast(['claude', 'codex'].filter(id => agents?.[id]).map(id => `${id === 'claude' ? 'Claude Code' : 'Codex'}: ${authText(agents[id])}`).join('. ') || 'No agents answered.');
  }),
  'settings.chatgpt-signin': ({ ctx }) => withBusy(ctx, 'signin', async () => {
    data.login = await ctx.ai.startChatGptSignIn() || { status: 'failed', error: 'The bridge did not start a sign-in.' };
    ctx.render();
    pollLogin(ctx);
  }),
  'settings.chatgpt-cancel': async ({ ctx }) => {
    const job = data.login;
    clearTimeout(live.loginTimer);
    if (job?.id) data.login = await ctx.ai.cancelChatGptSignIn(job.id).catch(() => null) || { ...job, status: 'cancelled' };
    else data.login = null;
    ctx.render();
  },
  'settings.chatgpt-dismiss': ({ ctx }) => { data.login = null; ctx.render(); },
  'settings.bridge-provider-remove': async ({ ctx, data: payload }) => {
    const ok = await ctx.confirm({ title: `Remove ${payload.name} from the bridge?`, body: 'The provider and its key are deleted from the bridge on this computer.', confirmLabel: 'Remove provider', tone: 'danger' });
    if (!ok) return;
    await ctx.ai.deleteConnection(payload.id);
    await loadAi(ctx, { refresh: true });
    ctx.toast(`${payload.name} removed`);
  },

  // Semantic search
  'settings.search-enable': ({ ctx, el }) => {
    const embeddings = aiSettings(ctx).embeddings || {};
    const candidates = embeddingConnections(data.connections || []);
    const connection = candidates.find(c => c.id === embeddings.connectionId) || candidates[0];
    if (el.checked && !connection) throw new Error('Connect an embedding provider first.');
    const provider = connection ? ctx.ai.getProvider(connection.providerId) : null;
    const model = embeddings.connectionId === connection?.id && embeddings.model ? embeddings.model : provider?.embeddings?.default || connection?.embeddingModels?.[0]?.id || '';
    return setAi(ctx, { embeddings: { enabled: !!el.checked, ...(connection ? { connectionId: connection.id, model } : {}) } });
  },
  'settings.search-connection': ({ ctx, el }) => {
    const connection = (data.connections || []).find(c => c.id === el.value);
    if (!connection) return undefined;
    const provider = ctx.ai.getProvider(connection.providerId);
    const model = provider?.embeddings?.default || connection.embeddingModels?.[0]?.id || '';
    const entry = (connection.embeddingModels || []).find(m => m.id === model);
    return setAi(ctx, { embeddings: { connectionId: connection.id, model, dims: entry?.dims ?? null } });
  },
  'settings.search-model': ({ ctx, el }) => {
    const connection = (data.connections || []).find(c => c.id === aiSettings(ctx).embeddings?.connectionId);
    const entry = (connection?.embeddingModels || []).find(m => m.id === el.value);
    return setAi(ctx, { embeddings: { model: el.value, dims: entry?.dims ?? null } });
  },
  'settings.search-dims': ({ ctx, el }) => setAi(ctx, { embeddings: { dims: Number(el.value) || null } }),
  'settings.search-refresh-models': ({ ctx, data: payload }) => {
    const access = hostAccess(ctx, findConnection(payload.id));
    return withBusy(ctx, 'embedding-models', async () => {
      await access;
      await ctx.ai.listModels(payload.id, { refresh: true, kind: 'embeddings' });
      await loadAi(ctx);
    });
  },
  'settings.index-pause': ({ ctx }) => withBusy(ctx, 'index', () => ctx.ai.pauseIndexing()),
  'settings.index-resume': ({ ctx }) => withBusy(ctx, 'index', () => ctx.ai.startIndexing()),
  'settings.index-rebuild': async ({ ctx }) => {
    const status = data.index || {};
    const ok = await ctx.confirm({ title: 'Rebuild the index?', confirmLabel: 'Rebuild index',
      body: `Every item is embedded again${status.model ? ` with ${status.model}` : ''}${status.provider ? ` by ${status.provider}` : ''}. Search keeps working while it runs.` });
    if (ok) await withBusy(ctx, 'index', () => ctx.ai.rebuildIndex());
  },
  'settings.index-clear': async ({ ctx }) => {
    const ok = await ctx.confirm({ title: 'Clear the index?', confirmLabel: 'Clear index', tone: 'danger',
      body: 'Stored embeddings are deleted from this device. Indexing stays stopped until you choose Rebuild or Resume.' });
    if (ok) await withBusy(ctx, 'index', () => ctx.ai.clearIndex());
  },

  // Agents & MCP
  'settings.mcp-root': ({ ctx, el }) => { ctx.prefs.set('settings.mcpRoot', el.value.trim()); ctx.render(); },
  'settings.client-connect': ({ ctx, data: payload }) => withBusy(ctx, `client:${payload.id}`, async () => {
    try { await applyClientChange(payload.id, 'connect'); ctx.toast(`Still added to ${payload.name}. Restart ${payload.name} to load it.`, { tone: 'success' }); }
    finally { await loadClients(ctx); }
  }),
  'settings.client-disconnect': async ({ ctx, data: payload }) => {
    const ok = await ctx.confirm({ title: `Disconnect ${payload.name}?`, body: `Still’s entry is removed from ${payload.name}’s configuration. Other servers there are kept, and a backup is saved first.`, confirmLabel: 'Disconnect', tone: 'danger' });
    if (!ok) return;
    await withBusy(ctx, `client:${payload.id}`, async () => {
      try { await applyClientChange(payload.id, 'disconnect'); ctx.toast(`Still removed from ${payload.name}`); }
      finally { await loadClients(ctx); }
    });
  },
  'settings.client-skill': ({ ctx, data: payload }) => withBusy(ctx, `skill:${payload.id}`, async () => {
    const receipt = await integrations.requestBridge(`/connections/${encodeURIComponent(payload.id)}/skills`, { method: 'POST', body: {} });
    await loadClients(ctx);
    ctx.toast(receipt?.unchanged ? `The Still skill is already installed for ${payload.name}.` : `Skill installed. Restart ${payload.name} to load it.`, { tone: 'success' });
  }),

  // Shortcuts
  'settings.shortcuts-page': async ({ ctx }) => {
    try {
      if (!ctx.env.isExtension) throw new Error('not an extension page');
      await chrome.tabs.create({ url: SHORTCUTS_PAGE });
    } catch {
      await navigator.clipboard.writeText(SHORTCUTS_PAGE);
      ctx.toast('Chrome opens this page only from the address bar. The address is copied: paste it there.');
    }
  },
});

/** One-time wiring: the hidden #import-input in index.html feeds Library & backup. */
export function init(ctx) {
  const picker = document.getElementById('import-input');
  if (!picker || picker.dataset.settingsBound) return;
  picker.dataset.settingsBound = 'true';
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    ctx.run(() => runImport(ctx, file));
  });
}
