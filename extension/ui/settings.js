// Settings and help (SPEC.md §7.4, §13). A full page in the full tab (views 'settings' and 'settings:<section>') and a covering
// panel in the side panel (ctx.state.panel = { kind: 'settings' }); both use one layout that switches to a section list with
// drill-in below 760px (styles/settings.css container queries). A search field filters every section down to matching rows.
// Library settings go through ctx.store.updateSettings (app.js applies them to <html>); AI configuration through the ctx.ai
// facade; bridge, MCP and Raindrop through lib/integrations.js. Appearance, New tab & dashboard, Connected accounts, Assistant
// permissions, Research agent and the Threadkeeper card (AI chat threads) live in ui/settings/*.js; the building blocks and the search renderer in ui/settings/parts.js.
import { html, cx, plural, safeHref, safeSrc } from './html.js';
import { icon } from './icons.js';
import { button, iconButton, segmented, select, field, input, badge, spinner, emptyState, kbd, fileSize, relativeDate, shortDate } from './components.js';
import { registerDialog, focusOrigin, refocus } from './overlay.js';
import { registerActions, registerShortcuts, registerMount, listShortcuts } from './runtime.js';
import { renderCollectionPickerTrigger } from './pickers.js';
import { navToggle } from './sidebar.js';
import * as integrations from '../lib/integrations.js';
import { createFullBackup, serializeBackup, importPortableFile, exportBookmarkHtml, exportNotesMarkdown, exportItemsCsv, exportChatsMarkdown } from '../lib/portability.js';
import { listSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot } from '../lib/storage/snapshots.js';
import { REFERENCE_ASSETS } from '../lib/references.js';
import { SETTINGS_SECTIONS, normalizeSection, isSection, sectionById, sectionFromView, settingsView, groupSections, adjacentSections,
  searchTerms, matchSections } from './settings/catalog.js';
import { uiState, isBusy, withBusy, renderFiltered, isSearching, matches, searchable, resetIds, group, card, row, switchRow, blockRow, callout,
  codeBlock, progressBar, disclosure, disclosed, loadingBlock, linkButton, note, providerMark } from './settings/parts.js';
import { renderAppearance, ACCENTS } from './settings/appearance.js';
import { renderNewTab, attachNewTab, detachNewTab } from './settings/newtab.js';
import { renderAccounts, attachAccounts, detachAccounts } from './settings/accounts.js';
import { renderAssistantPermissions, renderResearch, researchPatch } from './settings/assistant.js';
import { renderBrowserAutomation } from './settings/browser.js';
import { renderThreadkeeper, attachThreadkeeper, detachThreadkeeper } from './settings/threadkeeper.js';
import { PERMISSION_CATEGORIES, PERMISSION_LEVELS, PERMISSION_PRESETS } from '../lib/ai/permissions.js';
import { BROWSER_LIMITS, BROWSER_MODES, BROWSER_PERMISSIONS, SITE_RULES, siteKey, withSiteRule } from '../lib/browser/settings.js';
import { MCP_TOOLS, MCP_SCOPES } from '../lib/mcp-tools.js';

export { SETTINGS_SECTIONS, normalizeSection, ACCENTS };

const CONNECT = 'settings.connect';
const REPO = 'https://github.com/AVRCORP/sidebar-dock';
const SHORTCUTS_PAGE = 'chrome://extensions/shortcuts';
const RAINDROP_ORIGIN = 'https://api.raindrop.io/*';
const HANDOFF_CHOICES = ['claude', 'chatgpt', 'grok'];

/* ------------------------------------------------------------------ static content */

export const MCP_CLIENTS = Object.freeze([
  { id: 'claude', name: 'Claude Code', mark: 'agent:claude-code', blurb: 'Anthropic’s coding agent for the terminal and IDEs.', docs: 'https://code.claude.com/docs/en/mcp',
    manual: setup => [{ label: 'Run once in a terminal', code: setup.claudeCommand },
      { label: 'Or connect over HTTP while the bridge runs. Claude Code then keeps the token in ~/.claude.json', code: setup.claudeHttpCommand },
      { label: 'Or keep the token out of ~/.claude.json: this entry asks bridge/auth-header.mjs for it at connect time', code: setup.claudeHeadersHelper }] },
  { id: 'codex', name: 'Codex', mark: 'agent:codex', blurb: 'OpenAI’s coding agent for the terminal and IDEs.', docs: 'https://developers.openai.com/codex/mcp/',
    manual: setup => [{ label: 'Run once in a terminal', code: setup.codexCommand }, { label: 'Or add this to ~/.codex/config.toml', code: setup.codex }] },
  { id: 'claude-desktop', name: 'Claude Desktop', mark: 'claude-desktop', blurb: 'The Claude app for macOS and Windows.', docs: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers',
    manual: setup => [{ label: 'In Claude Desktop, open Settings, choose Developer, then Edit config, and add', code: setup.claudeDesktop }],
    note: 'Quit and reopen Claude Desktop after the change.' },
  { id: 'cursor', name: 'Cursor', mark: 'cursor', blurb: 'The AI code editor.', docs: 'https://cursor.com/docs/mcp',
    manual: setup => [{ label: 'Add this to ~/.cursor/mcp.json', code: setup.cursor }] },
  { id: 'vscode', name: 'VS Code', mark: 'vscode', blurb: 'Agent mode in Visual Studio Code.', bridge: false, docs: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
    manual: setup => [{ label: 'Run “MCP: Open User Configuration” from the Command Palette and add', code: setup.vscode }] },
  { id: 'copilot', name: 'GitHub Copilot CLI', mark: 'copilot', blurb: 'GitHub’s coding agent for the terminal.', docs: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers',
    manual: setup => [{ label: 'Add this to ~/.copilot/mcp-config.json', code: setup.copilot }] },
  { id: 'kiro', name: 'Kiro', mark: 'kiro', blurb: 'The spec-driven agentic IDE.', docs: 'https://kiro.dev/docs/mcp/configuration/',
    manual: setup => [{ label: 'Add this to ~/.kiro/settings/mcp.json', code: setup.kiro }] },
  { id: 'factory', name: 'Factory Droid', mark: 'factory', blurb: 'Factory’s Droid coding agent.', docs: 'https://docs.factory.com/cli/configuration/mcp',
    manual: setup => [{ label: 'Add this to ~/.factory/mcp.json', code: setup.factory }] },
  { id: 'windsurf', name: 'Windsurf', mark: 'windsurf', blurb: 'The Windsurf editor and its Cascade agent.', docs: 'https://docs.windsurf.com/windsurf/cascade/mcp',
    manual: setup => [{ label: 'Add this to ~/.codeium/windsurf/mcp_config.json', code: setup.windsurf }] },
  { id: 'zed', name: 'Zed', mark: 'zed', blurb: 'The Zed editor’s agent panel.', bridge: false, docs: 'https://zed.dev/docs/ai/mcp',
    manual: setup => [{ label: 'Add this under context_servers in Zed’s settings.json, or use Settings → AI → MCP Servers', code: setup.zed }] },
  { id: 'goose', name: 'Goose', mark: 'goose', blurb: 'Block’s open-source agent.', bridge: false, docs: 'https://block.github.io/goose/docs/getting-started/using-extensions',
    manual: setup => [{ label: 'Merge this into the extensions block of Goose’s config.yaml, or run goose configure', code: setup.goose }] },
]);

// Copy for clients the bridge reports that the list above does not describe (its own blurb is only the config path).
export const MCP_CLIENT_BLURBS = Object.freeze({
  opencode: 'The open-source coding agent for the terminal.', gemini: 'Google’s Gemini CLI agent.', devin: 'Devin’s local agent.',
  qwen: 'Qwen Code, the terminal agent.', amp: 'Sourcegraph’s Amp coding agent.', crush: 'Charm’s terminal coding agent.', 'lm-studio': 'Local models with tools in LM Studio.',
});

// The bridge's MCP tools live in lib/mcp-tools.js (tests/mcp-tools-sync.test.mjs keeps them in step with bridge/protocol.mjs).
export { MCP_TOOLS };

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
  { icon: 'layout-dashboard', title: 'Make the new tab yours', text: 'New tabs open your dashboard. Add widgets, pick a theme and a wallpaper in Appearance and New tab & dashboard.' },
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
  if (!integration.bridgeEnabled) return { state: 'paused', tone: 'warning', label: 'Sync paused', detail: 'Paired. Agents see the library as of the last sync until you resume.' };
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
  // What the service worker says about working in browser tabs: { available, missing: [Chrome permission], reason? }.
  browserStatus: null,
  clients: null, clientsError: '',
  // Paperclip → Still: the scope picked here and the bridge's setup result (holds the client token; memory only, never stored).
  // scopeChosen: the scope is sent only after the user picks one, so Connect never changes an existing token's access.
  paperclip: { scope: 'write', scopeChosen: false, result: null, error: '' },
  importJob: null, raindrop: null, login: null,
  // snapshots: { list, error } once loaded; backupJob: { warnings } after a backup that left something out.
  snapshots: null, backupJob: null,
};
const drafts = { bridgeUrl: null, bridgeToken: '', raindropToken: '', browserSite: '', browserRule: 'ask', browserError: '' };
let connectDraft = { apiKey: '', baseUrl: '', label: '', workspaceId: '', defaultModel: '' };
// mounted: a Settings page is on screen. pausedHere: sync was paused in this window without a stored setting
// (integrations.setBridgeEnabled is missing). pending: work to do once the page has loaded (open a provider, scroll to a row).
// returnTo: what had focus when Settings opened over the side panel (the More button), focused again when it closes.
const live = { offAi: null, offIndex: null, tick: 0, loginTimer: 0, mounted: false, pausedHere: false, searchTimer: 0, engineSettled: false, pending: { providerId: '', anchor: '' }, returnTo: null };

const settingsOf = ctx => ctx.library?.settings || {};
const version = () => { try { return globalThis.chrome?.runtime?.getManifest?.()?.version || '0.4.0'; } catch { return '0.4.0'; } };
const topProps = (ctx, name) => ctx.state.dialogs.findLast(entry => entry.name === name)?.props || null;
const patchConnect = (ctx, patch) => { if (topProps(ctx, CONNECT)) ctx.updateDialog(CONNECT, patch); };
const aiSettings = ctx => data.aiSettings || ctx.ai?.DEFAULT_AI_SETTINGS || {};
const focusSoon = (ctx, selector) => ctx.nextFrame(() => document.querySelector(selector)?.focus({ preventScroll: false }));
const since = iso => relativeDate(iso).replace(/^Just now$/, 'just now');
const bridgeSettings = () => (data.integration && live.pausedHere ? { ...data.integration, bridgeEnabled: false } : data.integration);

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

async function loadAi(ctx, { refresh = false } = {}) {
  const ai = ctx.ai;
  // app.js loads the AI engine after the first render; init() below loads again once it has settled.
  if (!ai) { if (live.engineSettled) data.aiError = 'unavailable'; ctx.render(); return; }
  try { data.connections = await ai.listConnections({ refresh }); data.aiError = ''; } catch (error) { data.connections ||= []; data.aiError = error.message; }
  try { data.aiSettings = await ai.getAiSettings(); } catch (error) { data.aiError ||= error.message; }
  try { data.bridge = await ai.getBridgeStatus(); } catch { data.bridge = null; }
  try { data.index = ai.getIndexStatus(); } catch { /* the index reports through subscribeIndex */ }
  ctx.render();
  openPendingConnect(ctx);
  loadBrowserStatus(ctx);
}

// Asked apart from the rest: it wakes the service worker, and no other section waits for it.
async function loadBrowserStatus(ctx) {
  if (typeof ctx.ai?.browserStatus !== 'function') return;
  try { data.browserStatus = await ctx.ai.browserStatus(); } catch { data.browserStatus = null; }
  ctx.render();
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

/** Loads the automatic snapshot list (newest first) for Library & backup; re-renders when Settings is on screen. */
export async function loadSnapshots(ctx) {
  try { data.snapshots = { list: await listSnapshots(), error: '' }; }
  catch (error) { data.snapshots = { list: data.snapshots?.list || [], error: error.message || 'Snapshots could not load.' }; }
  if (ctx && live.mounted) ctx.render();
}

async function refresh(ctx, { bridge = false } = {}) {
  await Promise.allSettled([loadIntegration(ctx), loadStorage(), loadCommands(), loadSnapshots(), loadAi(ctx, { refresh: bridge })]);
  await loadClients(ctx);
  ctx.render();
}

// "Set up" buttons elsewhere (Ask's empty state) open Settings straight into a provider's connect dialog.
function openPendingConnect(ctx) {
  const providerId = live.pending.providerId;
  if (!providerId || !live.mounted || !ctx.ai?.getProvider?.(providerId)) return;
  live.pending.providerId = '';
  const existing = (data.connections || []).find(c => c.via === 'direct' && c.providerId === providerId && ctx.ai.getProvider(providerId)?.kind !== 'custom');
  ctx.run(() => openConnect(ctx, { providerId, id: existing?.id || '' }));
}

function attach(ctx) {
  detach();
  live.mounted = true;
  const ai = ctx.ai;
  try { live.offAi = ai?.onConnectionsChanged?.(() => loadAi(ctx)) || null; } catch { live.offAi = null; }
  try { live.offIndex = ai?.subscribeIndex?.(status => { data.index = status; if (live.mounted) ctx.render(); }) || null; } catch { live.offIndex = null; }
  // Relative times ("Synced 8 seconds ago") and the bridge sync status (app.js updates it without rendering).
  live.tick = setInterval(() => { if (live.mounted && !document.hidden) ctx.render(); }, 5000);
  if (data.login && ['pending', 'user_action_needed'].includes(data.login.status)) pollLogin(ctx);
  attachNewTab(ctx);
  attachAccounts(ctx);
  attachThreadkeeper(ctx);
  refresh(ctx, { bridge: true }).catch(error => console.error(error));
}

function detach() {
  if (typeof live.offAi === 'function') live.offAi();
  if (typeof live.offIndex === 'function') live.offIndex();
  clearInterval(live.tick);
  clearTimeout(live.loginTimer);
  Object.assign(live, { offAi: null, offIndex: null, tick: 0, loginTimer: 0, mounted: false });
  detachNewTab();
  detachAccounts();
  detachThreadkeeper();
}

// Mounted on an invisible marker inside the page, so loading starts when Settings appears and listeners stop when it leaves.
// Leaving Settings also forgets the search, so coming back (from any link) shows a section again.
registerMount('settings-live', (el, ctx) => {
  attach(ctx);
  return { update() {}, destroy() { detach(); clearTimeout(live.searchTimer); if (ctx.state.settings) ctx.state.settings.query = ''; } };
});

/* ------------------------------------------------------------------ public entry */

/**
 * Opens Settings at a section: appearance, newtab, general, library, ai, assistant, research, search, agents, accounts,
 * integrations, shortcuts, about, help. options: { anchor } scrolls to a row id (the Threadkeeper card is 'settings-threadkeeper'
 * in 'integrations'); { providerId } opens that AI provider's connect dialog (section 'ai').
 */
export function openSettings(ctx, section = 'general', options = {}) {
  const ui = uiState(ctx);
  const explicit = isSection(normalizeSection(section, ''));
  const id = normalizeSection(section);
  ui.query = '';
  live.pending = { providerId: options?.providerId || '', anchor: options?.anchor || '' };
  if (ctx.env?.isSidepanel) {
    if (ctx.state.panel?.kind !== 'settings') live.returnTo = focusOrigin();
    ui.section = id;
    // The side panel starts on the section list unless a specific section was asked for.
    ui.list = !explicit || id === 'general';
    ctx.closePopover?.({ restore: false });
    ctx.state.panel = { kind: 'settings' };
    ctx.render();
    afterOpen(ctx);
    return;
  }
  ui.section = id;
  // General is also the default: the bare 'settings' view shows it on wide pages and the section list on narrow ones.
  const view = id === 'general' ? 'settings' : settingsView(id);
  if (ctx.state.view === view) ctx.render(); else ctx.navigate(view);
  afterOpen(ctx);
}

// Closing Settings in the side panel puts focus back where it was before Settings opened, else on the panel's content.
function closeSidePanel(ctx) {
  const back = live.returnTo;
  live.returnTo = null;
  ctx.closePanel();
  ctx.nextFrame(() => { if (!refocus(back)) document.getElementById('main')?.focus({ preventScroll: true }); });
}

function afterOpen(ctx) {
  ctx.nextFrame(() => {
    if (live.pending.providerId && live.mounted && data.connections) openPendingConnect(ctx);
    const anchor = live.pending.anchor && document.getElementById(live.pending.anchor);
    live.pending.anchor = '';
    if (anchor) { reveal(anchor); return; }
    if (!ctx.state.dialogs.length) focusEntry(ctx);
  });
}

/** Scrolls a row into view, focuses it and flashes it once so the eye lands on it. */
function reveal(el) {
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches && document.documentElement.dataset.motion !== 'reduced';
  el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  el.focus({ preventScroll: true });
  el.classList.remove('is-flash');
  void el.offsetWidth;
  el.classList.add('is-flash');
  setTimeout(() => el.classList.remove('is-flash'), 1700);
}

// Focus after opening or changing section: the back button when drilled in (narrow), the current section link in the
// full tab's navigation column, else the section or page heading.
function focusEntry(ctx) {
  const page = document.querySelector('.settings-page');
  if (!page) return;
  const visible = el => (el?.getClientRects().length ? el : null);
  const target = visible(page.querySelector('.settings-back'))
    || (!ctx.env.isSidepanel && visible(page.querySelector('.settings-nav [aria-current="page"]')))
    || visible(page.querySelector('.settings-section-title'))
    || page.querySelector('.settings-title');
  target?.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ page frame */

const sectionHref = id => `index.html?libraryView=${encodeURIComponent(settingsView(id))}`;

/** Full-page settings for the 'settings' / 'settings:<section>' views (surface 'full') and the side panel's panel (surface 'side'). */
export function renderSettingsPage(ctx, { surface = ctx.env?.isSidepanel ? 'side' : 'full' } = {}) {
  resetIds();
  const ui = uiState(ctx);
  if (surface === 'full') {
    // A link elsewhere that opens another section ends the search started on this one.
    if (ui.query && ui.queryView !== ctx.state.view) ui.query = '';
    // The view is the source of truth in the full tab: 'settings' is the section list (narrow) or General (wide).
    const fromView = sectionFromView(ctx.state.view);
    ui.section = fromView || 'general';
    ui.list = !fromView;
  } else ui.section = normalizeSection(ui.section);
  const terms = searchTerms(ui.query);
  const results = terms.length ? searchResults(ctx, terms) : null;
  const state = results ? 'search' : ui.list ? 'list' : 'section';
  const section = sectionById(ui.section);
  return html`<div class="settings-page" data-surface="${surface}" data-state="${state}" data-key="settings-page" data-keydown="settings.key">
    <span data-mount="settings-live" data-morph="skip" data-key="settings-live" hidden></span>
    <div class="settings-frame">
      <div class="settings-side">
        ${renderHeader(ctx, { surface, state, section })}
        ${renderNav(ctx, { surface, state, section, results })}
      </div>
      <div class="settings-content" id="settings-content" data-key="settings-content-${state === 'search' ? 'search' : section.id}">
        ${results ? renderResults(ctx, results, ui.query) : renderSectionPage(ctx, section, surface)}
      </div>
    </div>
  </div>`;
}

function renderHeader(ctx, { surface, state, section }) {
  const ui = uiState(ctx);
  const drilled = state === 'section';
  return html`<header class="settings-head">
    <div class="settings-head-inner">
      <div class="settings-head-lead">${surface === 'full' ? navToggle(ctx) : ''}${drilled ? iconButton({ icon: 'arrow-left', label: 'All settings', action: 'settings.back', className: 'settings-back', id: 'settings-back' }) : ''}</div>
      <h1 class="settings-title" tabindex="-1">${drilled ? html`<span class="settings-title-section">${section.label}</span><span class="settings-title-root">Settings</span>` : 'Settings'}</h1>
      <div class="search-field settings-search" role="search">
        ${icon('search', { size: 16, className: 'search-field-icon' })}
        <input class="search-field-input" type="search" id="settings-search" data-focus-key="settings-search" value="${ui.query}" placeholder="Search settings"
          aria-label="Search settings" aria-controls="settings-content" aria-keyshortcuts="/" autocomplete="off" spellcheck="false" data-view-search
          data-input="settings.search" data-keydown="settings.search-key">
        ${ui.query ? iconButton({ icon: 'x', label: 'Clear search', action: 'settings.search-clear', size: 'sm', className: 'search-field-clear' }) : surface === 'full' ? kbd('/') : ''}
      </div>
      ${surface === 'side' ? iconButton({ icon: 'x', label: 'Close settings', action: 'settings.close', className: 'settings-close' }) : ''}
    </div>
  </header>`;
}

function navEntry(ctx, entry, { surface, current, count }) {
  const inner = html`<span class="settings-nav-icon" aria-hidden="true">${icon(entry.icon, { size: 16 })}</span>
    <span class="settings-nav-text"><span class="settings-nav-label">${entry.label}</span><span class="settings-nav-summary">${entry.summary}</span></span>
    ${count ? html`<span class="count settings-nav-count" aria-label="${plural(count, 'match', 'matches')}">${count}</span>` : ''}
    ${icon('chevron-right', { size: 16, className: 'settings-nav-chevron' })}`;
  const attrs = html`class="settings-nav-item" id="settings-nav-${entry.id}" data-action="settings.section" data-section="${entry.id}" ${current ? html`aria-current="page"` : ''}`;
  // Links in the full tab (Ctrl/⌘-click opens a section in a new tab); buttons in the side panel, which cannot navigate.
  return surface === 'full' ? html`<a ${attrs} href="${sectionHref(entry.id)}">${inner}</a>` : html`<button type="button" ${attrs}>${inner}</button>`;
}

function renderNav(ctx, { surface, state, section, results }) {
  const counts = new Map((results?.sections || []).map(entry => [entry.section.id, entry.hits || 0]));
  const include = results ? [...counts.keys()] : null;
  const groups = groupSections(include);
  return html`<nav class="settings-nav" aria-label="Settings sections">
    ${groups.length ? groups.map(entry => html`<div class="settings-nav-group" role="group" aria-labelledby="settings-nav-group-${entry.id}">
      <p class="settings-nav-heading" id="settings-nav-group-${entry.id}">${entry.label}</p>
      <ul class="settings-nav-list" role="list">${entry.sections.map(item => html`<li>${navEntry(ctx, item, { surface, current: !results && item.id === section.id, count: counts.get(item.id) })}</li>`)}</ul>
    </div>`) : html`<p class="settings-nav-empty">No sections match.</p>`}
    ${state === 'search' ? '' : html`<p class="settings-foot">Still ${version()}</p>`}
  </nav>`;
}

function renderSectionPage(ctx, section, surface) {
  const { previous, next } = adjacentSections(section.id);
  const step = (entry, dir) => {
    if (!entry) return html`<span class="settings-step is-empty"></span>`;
    const inner = html`${dir === 'previous' ? icon('arrow-left', { size: 14 }) : ''}<span class="settings-step-text"><span class="settings-step-dir">${dir === 'previous' ? 'Previous' : 'Next'}</span>
      <span class="settings-step-label">${entry.label}</span></span>${dir === 'next' ? icon('arrow-right', { size: 14 }) : ''}`;
    return surface === 'full'
      ? html`<a class="${cx('settings-step', `is-${dir}`)}" href="${sectionHref(entry.id)}" data-action="settings.section" data-section="${entry.id}">${inner}</a>`
      : html`<button type="button" class="${cx('settings-step', `is-${dir}`)}" data-action="settings.section" data-section="${entry.id}">${inner}</button>`;
  };
  return html`<article class="settings-section" data-section="${section.id}" aria-labelledby="settings-section-title">
    <header class="settings-section-head">
      <span class="settings-section-icon" aria-hidden="true">${icon(section.icon, { size: 18 })}</span>
      <h2 class="settings-section-title" id="settings-section-title" tabindex="-1">${section.label}</h2>
    </header>
    <p class="settings-section-desc">${section.description}</p>
    <div class="settings-section-body">${renderSection(ctx, section.id)}</div>
    <footer class="settings-section-foot">${step(previous, 'previous')}${step(next, 'next')}</footer>
  </article>`;
}

/** Every section rendered with the query applied: { sections: [{ section, content, hits }], total }. */
function searchResults(ctx, terms) {
  const sections = [];
  const catalog = new Set(matchSections(terms.join(' ')).map(section => section.id));
  for (const section of SETTINGS_SECTIONS) {
    const { content, hits } = renderFiltered(terms, [section.label], () => renderSection(ctx, section.id));
    if (content) sections.push({ section, content, hits });
    // Sections that match by name or keywords but have nothing loaded to filter yet (AI before it loads) still get a link.
    else if (catalog.has(section.id)) sections.push({ section, content: '', hits: 0 });
  }
  return { sections, total: sections.reduce((sum, entry) => sum + entry.hits, 0) };
}

function renderResults(ctx, results, query) {
  const found = results.sections.length;
  const announcement = found ? `${plural(results.total || found, 'setting')} match “${query.trim()}”` : `No settings match “${query.trim()}”`;
  return html`<div class="settings-results">
    <p class="sr-only" role="status" aria-live="polite">${announcement}</p>
    ${found ? results.sections.map(({ section, content }) => html`<section class="settings-result" aria-labelledby="settings-result-${section.id}">
      <header class="settings-result-head">
        <span class="settings-section-icon" aria-hidden="true">${icon(section.icon, { size: 16 })}</span>
        <h2 class="settings-result-title" id="settings-result-${section.id}">${section.label}</h2>
        ${button({ label: `Open ${section.label}`, iconRight: 'arrow-right', size: 'sm', variant: 'ghost', action: 'settings.section', data: { section: section.id }, className: 'settings-result-open' })}
      </header>
      ${content || html`<p class="settings-row-desc settings-result-summary">${section.summary}.</p>`}
    </section>`) : emptyState({ icon: 'search-x', title: 'No settings match', body: `Nothing matches “${query.trim()}”. Try a shorter word, such as theme, backup or token.`,
      actions: button({ label: 'Clear search', size: 'sm', action: 'settings.search-clear' }) })}
  </div>`;
}

function renderSection(ctx, id) {
  switch (id) {
    case 'appearance': return renderAppearance(ctx);
    case 'newtab': return renderNewTab(ctx);
    case 'library': return renderLibrary(ctx);
    case 'ai': return renderAi(ctx);
    case 'assistant': return renderAssistantSection(ctx);
    case 'research': return renderResearchSection(ctx);
    case 'browser': return renderBrowserSection(ctx);
    case 'search': return renderSearch(ctx);
    case 'agents': return renderAgents(ctx);
    case 'accounts': return renderAccounts(ctx);
    case 'integrations': return renderIntegrations(ctx);
    case 'shortcuts': return renderShortcuts(ctx);
    case 'about': return renderAbout(ctx);
    case 'help': return renderHelp(ctx);
    default: return renderGeneral(ctx);
  }
}

function aiUnavailable() {
  if (isSearching()) return '';
  return emptyState({ icon: 'circle-alert', tone: 'danger', title: 'AI settings could not load', body: 'Reload Still to try again. Your library is not affected.',
    actions: button({ label: 'Reload', icon: 'refresh-cw', variant: 'secondary', size: 'sm', action: 'app.retry-boot' }) });
}

/* ------------------------------------------------------------------ General */

function renderGeneral(ctx) {
  const s = settingsOf(ctx);
  return html`
    ${group({ title: 'Saving', body: () => card([
      row({ label: 'Default collection', keywords: 'inbox folder', description: 'Where Alt+Shift+S, the toolbar button and Save page to Still put new links. The Add dialog starts with the collection you used last.',
        control: renderCollectionPickerTrigger({ ctx, value: s.defaultCollectionId || '', action: 'settings.default-collection', id: 'settings-default-collection', label: 'Default collection', allowCreate: true }) }),
      switchRow({ label: 'Open the side panel after saving', description: 'Shows the saved page so you can add tags or a note. Applies to the page menu and Alt+Shift+S.',
        checked: s.openPanelOnSave !== false, action: 'settings.toggle', data: { key: 'openPanelOnSave' } }),
    ]) })}
    ${group({ title: 'Side panel', body: () => card([
      row({ lead: html`<span class="settings-row-icon" aria-hidden="true">${icon('panel-right', { size: 16 })}</span>`, label: 'Toolbar button', keywords: 'pin icon',
        description: 'Clicking the Still icon in the Chrome toolbar opens the side panel. Pin Still from the puzzle piece menu to keep it one click away.' }),
      switchRow({ label: 'Start on This page', description: 'Open the side panel on the page you are viewing. Turn off to start on your library.',
        checked: s.startOnPage !== false, action: 'settings.toggle', data: { key: 'startOnPage' } }),
    ]) })}
    ${group({ title: 'Deleting', body: () => card([
      switchRow({ label: 'Confirm before moving items to Trash', keywords: 'delete remove', description: 'Items in Trash can be restored until you empty it, so Still normally moves them without asking.',
        checked: s.confirmDelete === true, action: 'settings.toggle', data: { key: 'confirmDelete' } }),
    ]) })}`;
}

/* ------------------------------------------------------------------ Library & backup */

// Library & backup is exported for tests (tests/settings-ui.test.mjs renders it with a stub ctx).
export function renderLibrarySection(ctx) { return renderLibrary(ctx); }

function renderLibrary(ctx) {
  const library = ctx.library || { items: [] };
  const counts = ctx.select?.counts?.() || {};
  const trash = counts.trash || 0;
  const items = library.items.filter(item => !item.deletedAt).length;
  const files = library.items.filter(item => item.attachmentId && !item.deletedAt).length;
  const job = data.importJob;
  return html`
    ${group({ title: 'Backup', body: () => card([
      row({ label: 'Full backup', keywords: 'export download json everything settings dashboard wallpaper chats conversations ai connections',
        description: 'Everything in one JSON file: items, notes, highlights, collections and files, your settings and wallpaper, dashboards and widgets, assistant chats and AI connections, and AI chats from Threadkeeper with their summaries and transcripts. API keys, account tokens and passwords are never included.',
        control: button({ label: 'Download backup', icon: 'download', size: 'sm', action: 'settings.backup', loading: isBusy('backup') }) }),
      data.backupJob && !isSearching() ? backupStatus(data.backupJob) : '',
      row({ label: 'Restore or bring in a file', keywords: 'import upload html csv bookmarks restore', description: 'A Still backup, a bookmarks HTML file from any browser or Raindrop, or a CSV with a url column. Nothing on this device is deleted: where the file and this device have the same item, the newer copy is kept. Still saves a snapshot first, so you can go back.',
        control: button({ label: 'Choose file', icon: 'upload', size: 'sm', action: 'settings.import-choose', loading: !!job?.running }) }),
      job && !isSearching() ? importStatus(job) : '',
    ]) })}
    ${group({ title: 'Export', body: () => card([
      row({ label: 'Bookmarks', keywords: 'html export', description: 'An HTML bookmarks file that Chrome, Firefox, Safari and Raindrop can import.',
        control: button({ label: 'Export HTML', icon: 'file-down', size: 'sm', action: 'settings.export-html', loading: isBusy('export-html') }) }),
      row({ label: 'Notes and highlights', keywords: 'markdown export', description: 'Every note, personal note and highlight in one Markdown file.',
        control: button({ label: 'Export Markdown', icon: 'file-down', size: 'sm', action: 'settings.export-notes', loading: isBusy('export-notes') }) }),
      row({ label: 'Spreadsheet', keywords: 'csv excel sheets numbers export', description: 'Every item with its link, title, tags, note, type, collection and dates in a CSV file. Still can bring the file back in.',
        control: button({ label: 'Export CSV', icon: 'file-spreadsheet', size: 'sm', action: 'settings.export-csv', loading: isBusy('export-csv') }) }),
      row({ label: 'Assistant chats', keywords: 'ai conversations chat history markdown export', description: 'Every assistant conversation in one Markdown file.',
        control: button({ label: 'Export chats', icon: 'messages-square', size: 'sm', action: 'settings.export-chats', loading: isBusy('export-chats') }) }),
    ]) })}
    ${renderSnapshots(ctx)}
    ${group({ title: 'Bring in from other apps', keywords: 'import', body: () => card([
      row({ lead: providerMark('chrome', 32), label: 'Chrome bookmarks', keywords: 'import browser', description: ctx.env.isExtension
        ? 'Copies your Chrome bookmarks into Still and keeps folders as collections. Chrome asks for access first.'
        : 'Available when Still runs as the installed extension.',
        control: button({ label: 'Bring in from Chrome', icon: 'folder-input', size: 'sm', action: 'settings.import-chrome', disabled: !ctx.env.isExtension, loading: isBusy('chrome-bookmarks') }) }),
      searchable(['Raindrop.io', 'token', 'import', 'bookmarks', 'highlights', 'collections'], raindropBlock(ctx)),
    ]) })}
    ${group({ title: 'Storage', body: () => card([
      row({ label: 'On this device', keywords: 'storage space usage quota', description: html`${plural(items, 'item')}${files ? html`, ${plural(files, 'file')}` : ''}${data.storage?.usage != null
        ? html`. ${fileSize(data.storage.usage)} used by Still.` : '.'}`, control: data.storage?.usage != null && data.storage.quota
        ? html`<span class="settings-meter" role="img" aria-label="${Math.max(1, Math.round((data.storage.usage / data.storage.quota) * 100))}% of the space Chrome allows"><span style="--progress:${Math.min(1, Math.max(0.01, data.storage.usage / data.storage.quota))}"></span></span>` : '' }),
      row({ label: 'Trash', keywords: 'empty delete', description: trash ? `${plural(trash, 'item')} in Trash. Emptying deletes them forever.` : 'Trash is empty.',
        control: button({ label: 'Empty trash', icon: 'trash-2', size: 'sm', variant: 'secondary', className: 'settings-danger-btn', action: 'settings.empty-trash', disabled: !trash, loading: isBusy('empty-trash') }) }),
    ]) })}`;
}

/** What an import did, in words: { title, lines, notes, summary } for the status callout (lines, notes) and the toast. */
export function importReport(result = {}, name = 'the file') {
  const lines = [];
  const items = result.library?.items;
  if (items) {
    if (items.added) lines.push(`${plural(items.added, 'item')} added.`);
    if (items.updated) lines.push(`${plural(items.updated, 'item')} updated to the file’s newer copy.`);
    if (items.kept) lines.push(`${plural(items.kept, 'item')} already here kept as ${items.kept === 1 ? 'it is' : 'they are'}: this device’s copy is the same or newer.`);
    if (items.tombstoned) lines.push(`${plural(items.tombstoned, 'item')} you deleted forever stayed deleted.`);
  } else if (result.items) lines.push(`${plural(result.items, 'item')} added.`);
  if (result.files) lines.push(`${plural(result.files, 'file')} restored.`);
  if (result.settings) lines.push('Settings restored.');
  if (result.boards) lines.push(`${plural(result.boards, 'dashboard')} restored.`);
  const chats = (result.conversations?.added || 0) + (result.conversations?.updated || 0);
  if (chats) lines.push(`${plural(chats, 'assistant chat')} restored.`);
  if (result.aiConnections) lines.push(`${plural(result.aiConnections, 'AI connection')} added.`);
  if (!lines.length && !(result.warnings || []).length) lines.push('Nothing new: everything in the file is already here.');
  const notes = [...(result.notes || [])];
  if (result.snapshotId) notes.push('A snapshot of your data from just before is listed under Automatic snapshots, if you want to go back.');
  const parts = [plural(result.items || 0, 'item'), result.files && plural(result.files, 'file'), result.boards && plural(result.boards, 'dashboard'),
    chats && plural(chats, 'chat')].filter(Boolean);
  return { title: `Brought in ${name}`, lines, notes, summary: `Brought in ${parts.join(', ')}` };
}

const dismiss = action => button({ label: 'Dismiss', size: 'sm', variant: 'ghost', action });
const bulletList = lines => html`<ul class="settings-list">${lines.map(line => html`<li>${line}</li>`)}</ul>`;

function importStatus(job) {
  if (job.running) {
    return html`<div class="settings-row is-stacked settings-job" role="status">
      <span class="settings-row-label">Bringing in ${job.name}</span>${progressBar({ label: `Bringing in ${job.name}` })}</div>`;
  }
  if (job.error) {
    return html`<div class="settings-row is-stacked settings-job">${callout({ tone: 'danger', title: `${job.name} was not brought in`, body: job.error, live: true,
      actions: dismiss('settings.import-dismiss') })}</div>`;
  }
  const result = job.result || {};
  const report = importReport(result, job.name);
  return html`<div class="settings-row is-stacked settings-job">${callout({ tone: result.warnings?.length ? 'warning' : 'success', live: true,
    title: report.title, body: bulletList([...report.lines, ...(result.warnings || []), ...report.notes]), actions: dismiss('settings.import-dismiss') })}</div>`;
}

function backupStatus(job) {
  return html`<div class="settings-row is-stacked settings-job">${callout({ tone: 'warning', live: true, title: 'Backup downloaded, with these notes',
    body: bulletList(job.warnings), actions: dismiss('settings.backup-dismiss') })}</div>`;
}

// Automatic snapshots (lib/storage/snapshots.js): device-local copies the service worker keeps; listing never loads data.
const SNAPSHOT_PREVIEW = 5;
const SNAPSHOT_KINDS = { update: 'Update', daily: 'Daily', manual: 'Manual', 'before-restore': 'Before restore', 'before-import': 'Before import', 'before-migration': 'Before upgrade' };
const snapshotWhen = iso => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
/** One line about why a snapshot was taken and what it holds. */
export function snapshotDetails(snapshot = {}) {
  const c = snapshot.counts || {};
  const why = { update: `Still updated${snapshot.previousVersion ? ` from ${snapshot.previousVersion}` : ''}${snapshot.extensionVersion ? ` to ${snapshot.extensionVersion}` : ''}`,
    daily: 'Daily copy', manual: 'Taken by you', 'before-restore': 'Taken before a restore', 'before-import': 'Taken before an import',
    'before-migration': 'Taken before a data upgrade' }[snapshot.reason] || 'Snapshot';
  const version = snapshot.reason !== 'update' && snapshot.extensionVersion ? ` · Still ${snapshot.extensionVersion}` : '';
  return `${why}${version} · ${plural(c.items || 0, 'item')}, ${plural(c.collections || 0, 'collection')}, ${plural(c.boards || 0, 'dashboard')}, ${plural(c.conversations || 0, 'chat')}${snapshot.bytes ? ` · ${fileSize(snapshot.bytes)}` : ''}`;
}

function snapshotRow(snapshot) {
  const when = snapshotWhen(snapshot.createdAt);
  return row({ className: 'settings-snapshot', keywords: 'snapshot restore', description: snapshotDetails(snapshot),
    label: html`${when}${badge({ label: SNAPSHOT_KINDS[snapshot.reason] || 'Snapshot', tone: snapshot.reason === 'manual' ? 'accent' : 'neutral' })}`,
    control: html`${button({ label: 'Restore', icon: 'rotate-ccw', size: 'sm', action: 'settings.snapshot-restore', data: { id: snapshot.id }, loading: isBusy(`snapshot:${snapshot.id}`) })}
      ${iconButton({ icon: 'trash-2', label: `Delete the snapshot from ${when}`, size: 'sm', variant: 'danger', action: 'settings.snapshot-delete', data: { id: snapshot.id } })}` });
}

function renderSnapshots(ctx) {
  const state = data.snapshots;
  const list = state?.list || [];
  const open = disclosed(ctx, 'snapshots');
  // The newest few show; older ones open under a disclosure (search shows every match).
  const shown = isSearching() ? list : list.slice(0, SNAPSHOT_PREVIEW), older = isSearching() ? [] : list.slice(SNAPSHOT_PREVIEW);
  return group({ title: 'Automatic snapshots', keywords: 'snapshot restore undo history rollback version update copy',
    description: 'Still saves a copy of your data on this device when it updates, once a day when something changed, and before every restore or import. Snapshots stay on this device only: removing Still or clearing its data deletes them, so keep a downloaded full backup somewhere else too.',
    actions: button({ label: 'Take a snapshot now', icon: 'camera', size: 'sm', action: 'settings.snapshot-create', loading: isBusy('snapshot-create') }),
    body: () => card([
      state?.error && !isSearching() ? html`<div class="settings-row is-stacked">${callout({ tone: 'danger', title: 'Snapshots could not load', body: state.error })}</div>` : '',
      !state && !isSearching() ? html`<div class="settings-row settings-snapshot-loading" role="status">${spinner({ size: 14 })}<span class="settings-row-desc">Loading snapshots</span></div>` : '',
      state && !list.length && !state.error ? row({ label: 'No snapshots yet', keywords: 'snapshot', description: 'Still takes the first one at its next update or within a day. Take one now to start.' }) : '',
      ...shown.map(snapshotRow),
      older.length && open ? html`<div class="settings-snapshot-older" id="settings-more-snapshots">${older.map(snapshotRow)}</div>` : '',
      older.length ? html`<div class="settings-row settings-snapshot-more">${disclosure(ctx, 'snapshots',
        open ? 'Show fewer snapshots' : `Show ${plural(older.length, 'older snapshot')}`)}</div>` : '',
    ], 'settings-snapshots') });
}

function raindropStatus(info) {
  return info.raindropConnectedAt ? { label: 'Connected', tone: 'success', icon: 'circle-check' } : info.raindropConfigured ? { label: 'Token saved', tone: 'neutral' } : { label: 'Not connected', tone: 'neutral' };
}

function raindropBlock(ctx) {
  const info = data.integration || {};
  const job = data.raindrop;
  const configured = !!info.raindropConfigured;
  return html`<div class="settings-row is-stacked settings-raindrop" id="settings-raindrop" tabindex="-1">
    <div class="settings-row-split">
      ${providerMark('raindrop', 32)}
      <div class="settings-row-text"><span class="settings-row-label">Raindrop.io ${badge(raindropStatus(info))}</span>
        <span class="settings-row-desc">Brings in collections, bookmarks, notes and highlights with your Raindrop API token. The token stays on this device.${info.raindropConnectedAt
          ? ` Checked ${shortDate(info.raindropConnectedAt)}.` : ''}</span></div>
    </div>
    <form class="settings-inline-form" data-submit="settings.raindrop-connect">
      ${field({ label: 'API token', id: 'settings-raindrop-token', hint: html`Create a test token in <a class="link-inline" href="https://app.raindrop.io/settings/integrations" target="_blank" rel="noopener noreferrer">Raindrop’s integration settings</a>.`,
        control: input({ id: 'settings-raindrop-token', name: 'token', type: 'password', value: drafts.raindropToken, action: 'settings.raindrop-field',
          placeholder: configured ? 'Saved. Paste a new token to replace it.' : 'Paste your Raindrop test token', describedBy: 'settings-raindrop-token-hint' }) })}
      <div class="settings-actions">
        ${button({ label: configured ? 'Save and check' : 'Connect Raindrop', type: 'submit', size: 'sm', variant: configured ? 'secondary' : 'primary', loading: isBusy('raindrop-connect') })}
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
  if (!ai) return live.engineSettled ? aiUnavailable() : loadingBlock('Loading AI settings');
  if (!data.connections) return loadingBlock('Loading AI connections');
  const direct = data.connections.filter(c => c.via === 'direct');
  const chatReady = data.connections.some(c => c.enabled !== false && ai.getProvider(c.providerId)?.chat);
  return html`
    ${data.aiError && data.aiError !== 'unavailable' && !isSearching() ? callout({ tone: 'danger', title: 'Some AI settings could not load', body: data.aiError }) : ''}
    ${direct.length ? group({ title: 'Your connections', keywords: 'connected providers keys', body: () => card(direct.map(c => connectionRow(ctx, c))) })
      : isSearching() ? '' : callout({ tone: 'info', icon: 'sparkles', title: 'Connect a model to use Ask and the writing tools',
        body: 'Anthropic, OpenAI and Ollama are the quickest to set up. Keys stay on this device. Claude Code, Codex and a ChatGPT plan work through the local bridge below.' })}
    ${chatReady ? renderAiDefaults(ctx) : ''}
    ${providerGroups(ai.CATALOG).map(entry => group({ title: entry.title, keywords: 'add provider connect api key', body: () => {
      const tiles = entry.providers.map(provider => searchable([provider.name, provider.description], providerTile(provider, direct))).filter(tile => String(tile).trim());
      return tiles.length ? html`<div class="provider-grid">${tiles}</div>` : '';
    } }))}
    ${group({ title: 'Local bridge', keywords: 'companion pair token', description: 'A small companion that runs on this computer. It lets Still use Claude Code, Codex, your ChatGPT plan and keys you keep outside the browser.',
      body: () => bridgeBlock(ctx, { agents: true, where: 'ai' }) })}
    ${isSearching() ? '' : note('lock', 'API keys are stored on this device in Chrome’s extension storage. They are not included in backups, exports or bridge sync.')}`;
}

function connectionRow(ctx, connection) {
  const status = connectionStatus(connection);
  const isDefault = aiSettings(ctx).chat?.connectionId === connection.id;
  const modelName = (connection.models || []).find(model => model.id === connection.defaultModel)?.name || connection.defaultModel;
  const error = connection.status === 'error' && connection.lastError;
  const meta = [connection.label !== connection.providerName ? connection.providerName : '', modelName].filter(Boolean).join(' · ');
  return row({ className: 'connection-row', lead: providerMark(connection.providerId, 32), keywords: connection.providerName,
    label: html`${connection.label}${isDefault ? badge({ label: 'Default', tone: 'accent' }) : ''}`,
    description: error || meta || connection.baseUrl, descClass: error ? 'is-error' : '',
    control: html`${badge(status)}
      ${button({ label: 'Test', size: 'sm', variant: 'ghost', action: 'settings.connection-test', data: { id: connection.id }, loading: isBusy(`test:${connection.id}`) })}
      ${button({ label: 'Edit', size: 'sm', variant: 'secondary', action: 'settings.connect-open', data: { id: connection.id, provider: connection.providerId } })}` });
}

function providerTile(provider, connections) {
  const mine = connections.filter(c => c.providerId === provider.id);
  const best = mine.find(c => c.status === 'ok') || mine.find(c => c.status === 'error') || mine[0];
  // Custom servers can have several connections, so their tile always adds another one.
  const edit = best && provider.kind !== 'custom';
  return html`<button type="button" class="provider-tile" data-action="settings.connect-open" data-provider="${provider.id}" ${edit ? html`data-id="${best.id}"` : ''}
    aria-label="${edit ? `${provider.name}, ${connectionStatus(best).label}. Edit` : `Connect ${provider.name}`}">
    ${providerMark(provider.id, 32)}
    <span class="provider-tile-text"><span class="provider-tile-name">${provider.name}</span><span class="provider-tile-desc">${provider.description}</span></span>
    ${edit ? badge(connectionStatus(best)) : html`<span class="provider-tile-add">${icon('plus', { size: 14 })}<span>Add</span></span>`}
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
  return group({ title: 'Defaults', keywords: 'default model', body: () => card([
    row({ label: 'Chat model', keywords: 'ask assistant', description: chat.model?.description || 'Used by Ask, the AI assistant and note writing tools unless you pick another model there.',
      control: select({ name: 'chat', value: chatValue, label: 'Chat model', action: 'settings.ai-model', className: 'settings-select',
        options: withCurrent(modelSelectOptions(ctx), chatValue, chat.id) }) }),
    row({ label: 'Reasoning effort', keywords: 'thinking', description: efforts.length ? 'Higher effort thinks longer before answering. It is slower and uses more tokens.' : 'This model does not offer an effort setting.',
      control: select({ name: 'effort', value: efforts.length ? effortFor(chat.model, effort) : '', label: 'Reasoning effort', action: 'settings.ai-effort', className: 'settings-select is-narrow',
        disabled: !efforts.length, options: efforts.length ? efforts.map(level => ({ value: level, label: ai.EFFORT_LABELS?.[level] || level })) : [{ value: '', label: 'Not adjustable' }] }) }),
    row({ label: 'Fast model', keywords: 'quick suggestions', description: 'Used for quick jobs: title and tag suggestions, summaries in the Add dialog and short rewrites.',
      control: select({ name: 'quick', value: quickValue, label: 'Fast model', action: 'settings.ai-quick', className: 'settings-select',
        options: withCurrent(modelSelectOptions(ctx, { includeSame: true }), quickValue, quick.id) }) }),
    switchRow({ label: 'Suggest a title and tags when saving', description: 'Uses the fast model in the Add dialog. Nothing is sent until you open the dialog for a page.',
      checked: settings.autoSuggestOnSave !== false, action: 'settings.ai-flag', data: { key: 'autoSuggestOnSave' } }),
    switchRow({ label: 'Include page text when asking about a page', description: 'Sends the readable text of the page you are on with your question.',
      checked: settings.includePageText !== false, action: 'settings.ai-flag', data: { key: 'includePageText' } }),
    row({ label: 'Continue in', keywords: 'handoff open in claude chatgpt grok', description: 'Where “Open in” sends a question and its sources when you want to keep going in another app.',
      control: segmented({ name: 'handoff', value: handoff, action: 'settings.ai-handoff', ariaLabel: 'Continue in',
        options: targets.map(target => ({ value: target.id, label: target.name })) }) }),
  ]) });
}

/* ------------------------------------------------------------------ Assistant permissions and Research agent */

// Both wait for the stored AI settings: showing the defaults first would offer "Always ask" for a moment on a device that
// allows more, and a click in that moment would act on the wrong starting point. Null once the section can render, else
// what to show meanwhile (nothing while searching).
function aiSettingsPending(ctx, label) {
  if (!ctx.ai) return live.engineSettled ? aiUnavailable() : loadingBlock('Loading AI settings');
  if (!data.aiSettings) return data.aiError && data.aiError !== 'unavailable' ? aiUnavailable() : loadingBlock(label);
  return null;
}

function renderAssistantSection(ctx) {
  return aiSettingsPending(ctx, 'Loading assistant permissions') ?? renderAssistantPermissions(ctx, { permissions: aiSettings(ctx).assistantPermissions });
}

// Exported for tests (tests/settings-assistant.test.mjs renders both sections with a stub ctx).
export function renderAssistantSettingsSection(ctx, id = 'assistant') { return id === 'research' ? renderResearchSection(ctx) : renderAssistantSection(ctx); }

function renderResearchSection(ctx) {
  const pending = aiSettingsPending(ctx, 'Loading research settings') ?? (data.connections ? null : loadingBlock('Loading AI connections'));
  if (pending !== null) return pending;
  const research = { ...(ctx.ai.DEFAULT_AI_SETTINGS?.research || {}), ...(aiSettings(ctx).research || {}) };
  return renderResearch(ctx, { research, connections: data.connections, canReset: typeof ctx.ai.resetResearchProvisioning === 'function' });
}

function renderBrowserSection(ctx) {
  return aiSettingsPending(ctx, 'Loading browser automation settings')
    ?? renderBrowserAutomation(ctx, { browser: aiSettings(ctx).browser, status: data.browserStatus, draft: { site: drafts.browserSite, rule: drafts.browserRule, error: drafts.browserError } });
}

// Exported for tests (tests/settings-browser.test.mjs renders the section with a stub ctx).
export function renderBrowserSettingsSection(ctx) { return renderBrowserSection(ctx); }

/* ------------------------------------------------------------------ Local bridge (AI models and Agents & MCP) */

function bridgeBlock(ctx, { agents = false, where = 'ai' } = {}) {
  const info = bridgeSettings();
  if (!info) return loadingBlock('Checking the local bridge');
  if (!info.bridgeConfigured) return searchable(['Local bridge', 'pair', 'token', 'address', 'npm run bridge'], pairForm(info, where));
  const summary = bridgeSummary({ integration: info, live: ctx.state.bridge, bridge: data.bridge });
  const paused = summary.state === 'paused';
  const rows = [row({ className: 'bridge-row', lead: providerMark('bridge', 32), label: html`Local bridge ${badge({ label: summary.label, tone: summary.tone })}`, keywords: 'sync pair',
    description: html`${summary.detail} <span class="settings-mono">${info.bridgeUrl}</span>`,
    control: html`${paused ? button({ label: 'Resume sync', icon: 'refresh-cw', size: 'sm', action: 'settings.bridge-resume', loading: isBusy('bridge-sync') })
      : button({ label: 'Pause sync', size: 'sm', variant: 'secondary', action: 'settings.bridge-pause', loading: isBusy('bridge-sync') })}
      ${button({ label: 'Unpair', size: 'sm', variant: 'ghost', action: 'settings.bridge-unpair' })}` })];
  if (!agents) return card(rows);
  const bridge = data.bridge;
  const reachable = !!bridge?.reachable;
  const providers = bridge?.providers || [];
  return html`${card(rows)}
    ${group({ title: 'Coding agents and ChatGPT', className: 'settings-subgroup', keywords: 'claude code codex chatgpt plan sign in', description: reachable ? 'Chat with the agents you already use. They answer from their own sign-in; Still sends only the question and the context you choose.'
      : 'Start the bridge to see Claude Code, Codex and ChatGPT sign-in here.',
      actions: iconButton({ icon: 'refresh-cw', label: 'Check again', size: 'sm', action: 'settings.bridge-refresh' }),
      body: () => {
        if (!reachable) return '';
        const agentRows = ['claude', 'codex'].map(id => agentRow(ctx, id, bridge));
        const codex = bridge?.agents?.find(agent => agent.id === 'codex');
        if (codex?.capabilities?.oauthLogin) agentRows.push(chatGptRow(ctx, bridge));
        return card(agentRows);
      } })}
    ${reachable && providers.length ? group({ title: 'Providers on the bridge', className: 'settings-subgroup', description: 'Set up on the bridge with keys that never enter the browser.',
      body: () => card(providers.map(provider => bridgeProviderRow(ctx, provider))) }) : ''}`;
}

function pairForm(info, where) {
  const id = suffix => `settings-bridge-${suffix}-${where}`;
  return html`<form class="settings-card settings-pair" data-submit="settings.bridge-pair">
    <div class="settings-row has-lead">${providerMark('bridge', 32)}<div class="settings-row-text"><span class="settings-row-label">Local bridge ${badge({ label: 'Not paired', tone: 'neutral' })}</span>
      <span class="settings-row-desc">In the Still folder, run <code class="settings-code-inline">npm run bridge</code> and paste the address and token it prints.</span></div></div>
    <div class="settings-pair-fields">
      ${field({ label: 'Address', id: id('url'), control: input({ id: id('url'), name: 'url', type: 'url', value: drafts.bridgeUrl ?? info.bridgeUrl ?? integrations.DEFAULT_BRIDGE_URL,
        action: 'settings.bridge-field', attrs: { 'data-field': 'bridgeUrl' } }) })}
      ${field({ label: 'Pairing token', id: id('token'), hint: 'Also saved in ~/.still/bridge.json (npm run connect -- status shows the path).', control: input({ id: id('token'), name: 'token', type: 'password',
        value: drafts.bridgeToken, placeholder: 'Paste the token', action: 'settings.bridge-field', describedBy: `${id('token')}-hint`, attrs: { 'data-field': 'bridgeToken' } }) })}
      <div class="settings-pair-submit">${button({ label: 'Pair bridge', icon: 'plug', type: 'submit', variant: 'primary', size: 'sm', loading: isBusy('pair') })}</div>
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
  return row({ lead: providerMark(connectionId, 32), label: html`${name} ${badge(state)}`, keywords: name, description,
    control: html`${button({ label: current ? 'Used for chat' : 'Use for chat', icon: current ? 'check' : '', size: 'sm', pressed: current,
      disabled: !ready, action: 'settings.agent-use', data: { id: connectionId } })}
      ${button({ label: 'Check sign-in', size: 'sm', variant: 'ghost', disabled: !agent?.available, action: 'settings.agent-auth', loading: isBusy('agent-auth') })}` });
}

function chatGptRow(ctx, bridge) {
  const auth = bridge?.auth?.codex;
  const signedIn = auth?.status === 'authenticated' && auth.method === 'chatgpt';
  const current = aiSettings(ctx).chat?.connectionId === 'chatgpt-oauth';
  const job = data.login;
  const pending = job && ['pending', 'user_action_needed'].includes(job.status);
  const head = row({ lead: providerMark('chatgpt-oauth', 32), label: html`ChatGPT plan ${signedIn ? badge({ label: 'Signed in', tone: 'success' }) : ''}`, keywords: 'openai subscription',
    description: signedIn ? 'Codex is signed in with your ChatGPT account. Chats use your plan’s limits.' : 'Sign in through Codex to use your ChatGPT subscription instead of an API key.',
    control: signedIn ? button({ label: current ? 'Used for chat' : 'Use for chat', icon: current ? 'check' : '', size: 'sm', pressed: current, action: 'settings.agent-use', data: { id: 'chatgpt-oauth' } })
      : button({ label: 'Sign in with ChatGPT', size: 'sm', variant: 'primary', action: 'settings.chatgpt-signin', loading: isBusy('signin') || !!pending }) });
  return head ? html`${head}${job ? loginPanel(job) : ''}` : '';
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
  if (!ai) return live.engineSettled ? aiUnavailable() : loadingBlock('Loading AI settings');
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
  const noteText = embeddingNote({ providerName: provider?.name || status?.provider || '', local: !!provider?.local, tokens: status?.pendingTokens || 0,
    price: model?.pricePerMTok ?? EMBEDDING_PRICES[modelId] ?? null });
  return html`
    ${group({ title: 'Search by meaning', keywords: 'semantic embeddings', body: () => card([
      switchRow({ label: 'Semantic search', description: 'Builds an index of your library with an embedding model, so search, Related items, Ask and the MCP semantic_search tool can match ideas, not only words.',
        checked: enabled, disabled: !candidates.length, action: 'settings.search-enable' }),
      candidates.length ? row({ label: 'Embedding provider', keywords: 'voyage', description: current?.providerId === 'voyage' ? 'Voyage AI is Anthropic’s recommended embeddings partner.' : 'Voyage AI is recommended with Claude.',
        control: select({ name: 'connection', value: current?.id || '', label: 'Embedding provider', action: 'settings.search-connection', className: 'settings-select',
          options: [...(current ? [] : [{ value: '', label: 'Choose a provider' }]), ...candidates.map(c => ({ value: c.id, label: `${c.label}${c.providerId === 'voyage' ? ' (recommended)' : ''}` }))] }) }) : '',
      current && models.length ? row({ label: 'Model', keywords: 'embedding model', description: 'Changing the provider, model or size rebuilds the index.',
        control: html`${select({ name: 'model', value: modelId, label: 'Embedding model', action: 'settings.search-model', className: 'settings-select',
          options: withCurrent(models.map(entry => ({ value: entry.id, label: `${entry.name || entry.id}${entry.installed === false ? ' (not installed)' : ''}` })), modelId, modelId) })}
          ${current.providerId === 'ollama' || current.providerId === 'lmstudio' ? iconButton({ icon: 'refresh-cw', label: 'Refresh models', size: 'sm', action: 'settings.search-refresh-models', data: { id: current.id } }) : ''}` }) : '',
      current && dimsOptions.length > 1 ? row({ label: 'Vector size', keywords: 'dimensions', description: 'Smaller vectors use less space. Larger ones can be slightly more accurate.',
        control: select({ name: 'dims', value: String(dims || ''), label: 'Vector size', action: 'settings.search-dims', className: 'settings-select is-narrow',
          options: dimsOptions.map(value => ({ value: String(value), label: `${value} dimensions` })) }) }) : '',
    ]) })}
    ${candidates.length || isSearching() ? '' : callout({ tone: 'info', icon: 'brain', title: 'Connect an embedding model first',
      body: 'Voyage AI is recommended with Claude. OpenAI, Google Gemini, Mistral and Ollama (free, on this computer) work too.',
      actions: html`${button({ label: 'Connect Voyage AI', size: 'sm', variant: 'primary', action: 'settings.connect-open', data: { provider: 'voyage' } })}
        ${button({ label: 'Connect OpenAI', size: 'sm', action: 'settings.connect-open', data: { provider: 'openai' } })}
        ${button({ label: 'Use Ollama', size: 'sm', variant: 'ghost', action: 'settings.connect-open', data: { provider: 'ollama' } })}` })}
    ${enabled || (status?.indexed || 0) > 0 ? group({ title: 'Index', keywords: 'rebuild clear indexing', body: () => card([searchable(['index status', status?.model], indexRow(ctx, status, summary))]) }) : ''}
    ${noteText.length && !isSearching() ? note('info', noteText.join(' ')) : ''}`;
}

function indexRow(ctx, status, summary) {
  const enabled = !!status?.enabled;
  const working = isBusy('index');
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
  return { setup: integrations.getMcpSetup(root, { nodePath: runtime?.nodePath || '', bridgeUrl: data.integration?.bridgeUrl || '' }), runtime, root };
}

function renderAgents(ctx) {
  const { setup, runtime, root } = mcpSetup(ctx);
  const info = data.integration;
  const paired = !!info?.bridgeConfigured;
  const clients = data.clients;
  const byId = new Map((clients || []).map(client => [client.clientId || client.id, client]));
  // Paperclip has its own group below (it connects over HTTP with its own token).
  const extra = (clients || []).filter(client => (client.clientId || client.id) !== 'paperclip' && !MCP_CLIENTS.some(entry => entry.id === (client.clientId || client.id)));
  const listed = [...MCP_CLIENTS, ...extra.map(client => ({ id: client.clientId || client.id, name: client.name, mark: client.clientId || client.id,
    blurb: MCP_CLIENT_BLURBS[client.clientId || client.id] || client.configPath || '', docs: client.docs,
    manual: () => client.configSnippet ? [{ label: `Add this to ${client.configPath}`, code: client.configSnippet }] : [] }))];
  const configured = (clients || []).filter(client => (client.clientId || client.id) !== 'paperclip' && clientStatus(client)?.tone === 'success').length;
  const searching = isSearching();
  const tools = searching ? MCP_TOOLS.filter(tool => matches(tool.name, tool.text, tool.write ? 'change write' : 'read')) : MCP_TOOLS;
  return html`
    ${searching ? '' : html`<p class="settings-lead">Still includes an MCP server, so Claude Code, Codex, Claude Desktop and other agents can search, read and organize your library. The server runs from the Still folder on this computer and reaches this extension through the local bridge.</p>`}
    ${group({ title: 'Local bridge', keywords: 'pair sync companion', body: () => html`${bridgeBlock(ctx, { where: 'agents' })}${paired && data.clientsError && !searching ? callout({ tone: 'warning', title: 'Agent connections could not be checked', body: data.clientsError }) : ''}` })}
    ${runtime ? '' : group({ title: 'Still folder', keywords: 'path project root', body: () => card([row({ stacked: true, label: 'Where Still is on this computer', id: 'settings-mcp-root-row',
      description: 'Pairing the bridge fills this in. Until then, type the folder that contains bridge/ so the commands below are ready to paste.',
      control: input({ id: 'settings-mcp-root', value: root, placeholder: '/path/to/sidebar-dock', action: 'settings.mcp-root', label: 'Still folder' }) })]) })}
    ${group({ title: 'Connect an agent', keywords: 'mcp client', description: paired ? 'Connect adds Still to the agent’s own configuration, with a backup of the file it changes.' : 'Pair the bridge for one-click Connect. Until then, use the setup steps for each agent.',
      actions: clients ? html`<span class="settings-pill">${configured} of ${plural(clients.filter(c => (c.clientId || c.id) !== 'paperclip').length, 'agent')} connected</span>` : '',
      body: () => card(listed.map(entry => searchable([entry.name, entry.blurb, 'mcp agent client'], clientRow(ctx, entry, byId.get(entry.id), setup, paired)))) })}
    ${group({ title: 'Set up from a terminal', keywords: 'command line npm', body: () => card([blockRow({ label: 'One command per agent', keywords: 'npm run connect',
      description: 'From the Still folder, this connects an agent and prints the bridge address and pairing token. Use codex, desktop or cursor in place of claude.',
      body: html`${codeBlock('npm run connect -- claude', { label: 'Copy command' })}<span class="settings-row-desc">Then start the bridge and leave it running:</span>${codeBlock('npm run bridge', { label: 'Copy command' })}` })]) })}
    ${group({ title: 'Paperclip', keywords: 'paperclip ai company agents http token scope access read-only everyday full rotate revoke',
      description: 'Let the agents in your Paperclip company search, read and save to Still over the bridge’s HTTP endpoint, with their own token and access level.',
      body: () => paperclipBlock(ctx, setup, paired) })}
    ${group({ title: 'Tools agents can use', keywords: 'mcp tools', description: `${MCP_TOOLS.length} tools. Changes go through Still, so they appear here right away and respect Trash and Undo where they apply.`,
      body: () => {
        if (searching) return tools.length ? toolList(tools) : '';
        return html`${disclosure(ctx, 'tools', disclosed(ctx, 'tools') ? 'Hide the tool list' : 'Show the tool list')}${disclosed(ctx, 'tools') ? toolList(tools) : ''}`;
      } })}
    ${info?.bridgeUrl && !searching ? note('info', html`Clients that connect over HTTP can use <span class="settings-mono">${info.bridgeUrl}/mcp</span> with the pairing token as a bearer token. The commands above use stdio and keep the token out of client settings.`) : ''}`;
}

const toolList = tools => html`<div class="mcp-tools" id="settings-more-tools">
  ${[['Read', 'read'], ['Change', 'write'], ['Change in bulk or for good (Full access only)', 'destructive']].map(([label, access]) => {
    const list = tools.filter(tool => tool.access === access);
    return list.length ? html`<div class="mcp-tools-group"><h4 class="mcp-tools-title">${label}</h4><ul class="mcp-tools-list" role="list">
      ${list.map(tool => html`<li><code>${tool.name}</code><span>${tool.text}</span></li>`)}</ul></div>` : '';
  })}</div>`;

const paperclipError = error => /HTTP 404|not found/i.test(error?.message || '') ? 'This bridge does not offer Paperclip setup yet. Update Still, restart the bridge and try again.'
  : error?.message || 'The bridge could not set up Paperclip. Try again.';

async function paperclipSetup(ctx, { rotate = false } = {}) {
  try {
    const body = data.paperclip.scopeChosen ? { scope: data.paperclip.scope, rotate } : { rotate };
    const result = await integrations.requestBridge('/connections/paperclip/setup', { method: 'POST', body });
    if (!result || typeof result.pasteConfig !== 'string') throw new Error('The bridge answered without a Paperclip config. Update Still and restart the bridge.');
    data.paperclip.result = result;
    data.paperclip.error = '';
    if (MCP_SCOPES.some(entry => entry.value === result.scope)) { data.paperclip.scope = result.scope; data.paperclip.scopeChosen = false; }
    const changed = result.scopeChanged ? ` Access changed from ${MCP_SCOPES.find(entry => entry.value === result.previousScope)?.label || result.previousScope} to ${MCP_SCOPES.find(entry => entry.value === result.scope)?.label || result.scope}.` : '';
    ctx.toast(rotate ? `New Paperclip token ready. Paste the new config into Paperclip.${changed}` : `Paperclip config ready to paste.${changed}`, { tone: 'success' });
  } catch (error) { data.paperclip.error = paperclipError(error); }
}

/** Settings → Agents & MCP → Paperclip: a scoped token for Paperclip agents, and the config and instructions to paste. */
function paperclipBlock(ctx, setup, paired) {
  const state = data.paperclip;
  const result = state.result;
  const scope = MCP_SCOPES.find(entry => entry.value === (result?.scope || state.scope)) || MCP_SCOPES[1];
  const searching = isSearching();
  const head = row({ lead: providerMark('paperclip', 32), keywords: 'paperclip connect token scope',
    label: html`Paperclip agents ${result ? badge({ label: `${scope.label} token ready`, tone: 'success' }) : ''}`,
    description: paired ? html`${scope.description} Paperclip gets its own token, so you can rotate or revoke it without touching other agents.`
      : 'Pair the local bridge first, or run the command below in the Still folder.',
    control: paired ? html`<div class="paperclip-setup-scope">${select({ id: 'settings-paperclip-scope', name: 'scope', value: state.scope, action: 'settings.paperclip-scope', size: 'sm', label: 'Access for Paperclip agents',
        options: MCP_SCOPES.map(entry => ({ value: entry.value, label: entry.label })) })}
      ${button({ label: result ? 'Update access' : 'Connect Paperclip', icon: 'paperclip', size: 'sm', variant: result ? 'secondary' : 'primary', action: 'settings.paperclip-setup', loading: isBusy('paperclip') })}</div>` : '' });
  const rows = [head];
  if (state.error && !searching) rows.push(html`<div class="settings-row is-stacked">${callout({ tone: 'danger', live: true, title: 'Paperclip is not set up', body: state.error })}</div>`);
  if (paired && result) {
    rows.push(blockRow({ label: 'Paste config', keywords: 'json mcpServers http',
      description: 'In Paperclip, add an MCP server and choose Advanced → Paste a config. It contains the token, so treat it like a password.',
      body: codeBlock(result.pasteConfig || '', { label: 'Copy config', done: 'Config copied' }) }));
    if (result.authorizationHeader) rows.push(blockRow({ label: 'Authorization value', keywords: 'bearer header secret',
      description: 'Paperclip drops the pasted header value and asks for it again. Paste exactly this, including “Bearer ”, into its Authorization field.',
      body: codeBlock(result.authorizationHeader, { label: 'Copy value', done: 'Value copied' }) }));
    if (result.agentInstructions) rows.push(blockRow({ label: 'Agent instructions', keywords: 'prompt', description: 'Paste into the connection’s agent instructions so agents know how to use Still.',
      body: codeBlock(result.agentInstructions, { label: 'Copy instructions', done: 'Instructions copied' }) }));
    if (result.steps?.length) rows.push(blockRow({ label: 'Steps', body: html`<ol class="paperclip-setup-steps">${result.steps.map(step => html`<li>${step}</li>`)}</ol>` }));
    if (result.notes?.length && !searching) rows.push(html`<div class="settings-row is-stacked">${result.notes.map(text => note('info', text))}</div>`);
    rows.push(row({ label: 'Token', keywords: 'rotate revoke', description: `Named “${result.tokenName || 'paperclip'}” in the bridge config. Rotate it if it leaked; revoke it to stop Paperclip reaching Still.`,
      control: html`${button({ label: 'Rotate token', icon: 'rotate-cw', size: 'sm', variant: 'secondary', action: 'settings.paperclip-rotate', loading: isBusy('paperclip-rotate') })}
        ${button({ label: 'Revoke', size: 'sm', variant: 'ghost', action: 'settings.paperclip-revoke', loading: isBusy('paperclip-revoke') })}` }));
  } else if (paired) {
    rows.push(row({ label: 'Already connected Paperclip?', keywords: 'revoke', description: 'Revoke removes Paperclip’s token from the bridge. Connecting again shows the config with the same token and keeps its access unless you pick a different one first.',
      control: button({ label: 'Revoke', size: 'sm', variant: 'ghost', action: 'settings.paperclip-revoke', loading: isBusy('paperclip-revoke') }) }));
  } else {
    rows.push(blockRow({ label: 'From a terminal', keywords: 'npm run connect', description: 'In the Still folder, this creates Paperclip’s token and prints the config, agent instructions and steps.',
      body: html`${codeBlock(setup.paperclipCommand || 'npm run connect -- paperclip', { label: 'Copy command' })}<span class="settings-row-desc">The config looks like this, with the printed token in place of the placeholder:</span>${codeBlock(setup.paperclip || '')}` }));
  }
  return html`${card(rows)}${searching ? '' : note('info', html`This lets Paperclip read Still. To see Paperclip tasks on your dashboard and send saved items to Paperclip, connect it in ${button({ label: 'Connected accounts', size: 'sm', variant: 'ghost', action: 'settings.section', data: { section: 'accounts' } })}.`)}`;
}

function clientRow(ctx, entry, client, setup, paired) {
  const status = client ? clientStatus(client) : null;
  const key = `client:${entry.id}`;
  const manualOpen = disclosed(ctx, `manual-${entry.id}`);
  const steps = entry.manual(setup).filter(step => step.code);
  const connectable = paired && client && entry.bridge !== false;
  const actions = [];
  if (connectable && status?.tone === 'success') actions.push(button({ label: 'Disconnect', size: 'sm', variant: 'ghost', action: 'settings.client-disconnect', data: { id: entry.id, name: entry.name }, loading: isBusy(key) }));
  else if (connectable && client.canConnect) actions.push(button({ label: 'Connect', icon: 'plug', size: 'sm', variant: 'secondary', action: 'settings.client-connect', data: { id: entry.id, name: entry.name }, loading: isBusy(key) }));
  if (connectable && client.skillSupported !== false && client.skillPath) {
    actions.push(client.skillInstalled ? html`<span class="settings-inline-status">${icon('circle-check', { size: 14 })}Skill installed</span>`
      : button({ label: 'Install the Still skill', size: 'sm', variant: 'ghost', action: 'settings.client-skill', data: { id: entry.id, name: entry.name }, loading: isBusy(`skill:${entry.id}`) }));
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
  const info = data.integration || {};
  const others = integrations.INTEGRATION_CATALOG.filter(entry => !['claude', 'codex', 'raindrop'].includes(entry.id));
  return html`
    ${renderThreadkeeper(ctx, { where: 'integrations' })}
    ${group({ title: 'Built in', body: () => card([
      row({ lead: providerMark('raindrop', 32), label: html`Raindrop.io ${badge(raindropStatus(info))}`, keywords: 'import token bookmarks', description: 'Bring in collections, bookmarks, notes and highlights with your API token.',
        control: button({ label: 'Set up Raindrop', iconRight: 'arrow-right', size: 'sm', action: 'settings.section', data: { section: 'library', anchor: 'settings-raindrop' } }) }),
      row({ lead: providerMark('agent:claude-code', 32), label: 'Claude Code, Codex and Claude Desktop', keywords: 'mcp agents', description: 'Agents search and organize your library through MCP and the local bridge.',
        control: button({ label: 'Set up agents', iconRight: 'arrow-right', size: 'sm', action: 'settings.section', data: { section: 'agents' } }) }),
      row({ lead: providerMark('github', 32), label: 'GitHub, Linear and Product Hunt', keywords: 'accounts token pull requests issues', description: 'Dashboard widgets that show your pull requests, issues and launches.',
        control: button({ label: 'Connect accounts', iconRight: 'arrow-right', size: 'sm', action: 'settings.section', data: { section: 'accounts' } }) }),
    ]) })}
    ${group({ title: 'Other apps', description: 'Still does not sync with these services directly. Their guides show how to move links in and out, usually with a bookmarks file or a Still backup.',
      body: () => {
        const links = others.map(entry => searchable([entry.name, entry.category, entry.description], html`<li><a class="integration-link" href="${safeHref(entry.url)}" target="_blank" rel="noopener noreferrer">
          <span class="integration-link-head"><span class="integration-link-name">${entry.name}</span>${badge({ label: entry.category, tone: 'outline' })}${icon('arrow-up-right', { size: 14, className: 'integration-link-icon' })}</span>
          <span class="integration-link-desc">${entry.description}</span></a></li>`)).filter(entry => String(entry).trim());
        return links.length ? html`<ul class="integration-grid" role="list">${links}</ul>` : '';
      } })}`;
}

/* ------------------------------------------------------------------ Shortcuts */

const keyCaps = keys => String(keys).split(' ').map(chord => kbd(chord));
const chromeKeys = shortcut => html`<kbd class="kbd">${String(shortcut).split('+').filter(Boolean).map(part => html`<span>${part}</span>`)}</kbd>`;
const shortcutRow = (label, keys, words = '') => searchable([label, words], html`<div class="shortcut-row"><span class="shortcut-label">${label}</span><span class="shortcut-keys">${keys}</span></div>`);

function renderShortcuts(ctx) {
  const groups = groupShortcuts(listShortcuts());
  const commands = chromeCommandRows(data.commands);
  return html`
    ${groups.map(entry => group({ title: entry.group === 'General' ? 'In Still' : entry.group, keywords: 'keys',
      body: () => card(entry.rows.map(shortcut => shortcutRow(shortcut.label, keyCaps(shortcut.keys), shortcut.keys)), 'shortcut-card') }))}
    ${group({ title: 'Writing notes', keywords: 'editor keys', body: () => card(NOTE_KEYS.map(shortcut => shortcutRow(shortcut.label,
      shortcut.literal ? html`<kbd class="kbd"><span>${shortcut.keys}</span></kbd>` : kbd(shortcut.keys), shortcut.keys)), 'shortcut-card') })}
    ${group({ title: 'Anywhere in Chrome', keywords: 'global commands', description: 'These work on any page, even when Still is closed.', body: () => {
      const rows = card(commands.map(command => shortcutRow(command.label, command.shortcut ? chromeKeys(command.shortcut) : html`<span class="settings-row-desc">Not set</span>`, command.shortcut)), 'shortcut-card');
      if (!rows) return '';
      return html`${rows}${isSearching() ? '' : html`<div class="settings-actions settings-actions-below">
        ${button({ label: 'Change in Chrome', iconRight: 'external-link', size: 'sm', action: 'settings.shortcuts-page' })}
        ${button({ label: 'Copy page address', icon: 'copy', size: 'sm', variant: 'ghost', action: 'app.copy', data: { text: SHORTCUTS_PAGE, done: 'Copied. Paste it into the address bar.' } })}
        <span class="settings-row-desc settings-mono">${SHORTCUTS_PAGE}</span>
      </div>`}`;
    } })}`;
}

/* ------------------------------------------------------------------ About */

function renderAbout(ctx) {
  const usage = data.storage?.usage;
  const links = [{ label: 'Documentation', url: `${REPO}#readme`, icon: 'book-open' }, { label: 'Report a problem', url: `${REPO}/issues`, icon: 'flag' }, { label: 'Source code', url: REPO, icon: 'code' }];
  return html`
    ${group({ title: 'Still', keywords: 'version', body: () => card([
      row({ lead: html`<span class="settings-brand" aria-hidden="true">${icon('bookmark', { size: 18 })}</span>`, label: `Still ${version()}`, description: 'Bookmarks, notes, highlights, a dashboard and AI in one local-first library.',
        control: button({ label: 'Help', icon: 'circle-help', size: 'sm', variant: 'ghost', action: 'settings.section', data: { section: 'help' } }) }),
    ]) })}
    ${group({ title: 'Where your data lives', keywords: 'privacy storage', body: () => card([
      row({ label: 'Library', description: 'Items, collections, notes and highlights are kept in this Chrome profile’s extension storage. Files are kept in this browser’s database. Nothing is uploaded unless you connect something below.' }),
      row({ label: 'Storage used', description: usage != null ? `${fileSize(usage)} on this device.` : 'Chrome did not report storage use.' }),
      row({ label: 'AI keys', description: 'Stored on this device in Chrome’s extension storage. Not included in backups. Sent only to the provider they belong to.' }),
      row({ label: 'Connected accounts', keywords: 'github linear token', description: 'Tokens for dashboard widgets stay on this device and go only to the service they belong to.' }),
      row({ label: 'AI requests', description: 'When you ask a question, the question and the context you choose go to the provider you picked. The footnote under Ask names it.' }),
      row({ label: 'Local bridge', description: 'When paired, the library syncs to the bridge on this computer so agents can use it. Files and keys stay in the browser.' }),
      row({ label: 'AI chat threads', keywords: 'threadkeeper transcripts chats', description: 'Chats from Threadkeeper are copies kept on this device: their details in the library, summaries and transcripts in this browser’s database. Threadkeeper never sends threads you keep private, and the connection is never part of backups.',
        control: button({ label: 'Threadkeeper', iconRight: 'arrow-right', size: 'sm', action: 'settings.section', data: { section: 'integrations', anchor: 'settings-threadkeeper' } }) }),
      row({ label: 'Backups', description: 'Download a full backup now and then. Removing the extension deletes its storage.',
        control: button({ label: 'Library & backup', iconRight: 'arrow-right', size: 'sm', action: 'settings.section', data: { section: 'library' } }) }),
    ]) })}
    ${group({ title: 'Links', body: () => card(links.map(link => searchable([link.label], html`<a class="settings-link-row" href="${safeHref(link.url)}" target="_blank" rel="noopener noreferrer">
      ${icon(link.icon, { size: 16 })}<span>${link.label}</span>${icon('arrow-up-right', { size: 14, className: 'settings-link-row-icon' })}</a>`))) })}`;
}

/* ------------------------------------------------------------------ Help */

function renderHelp(ctx) {
  const shortcuts = [{ keys: 'mod+k', label: 'Search and commands' }, { keys: 'a', label: 'Add a link' }, { keys: 'n', label: 'New note' }, { keys: 'mod+shift+a', label: 'Ask AI' }, { keys: '?', label: 'All keyboard shortcuts' }];
  return html`
    ${group({ title: 'Getting started', keywords: 'guide tutorial', body: () => {
      const steps = GETTING_STARTED.map(step => searchable([step.title, step.text], html`<li class="help-step">
        <span class="help-step-icon" aria-hidden="true">${icon(step.icon, { size: 16 })}</span><span class="help-step-text"><span class="help-step-title">${step.title}</span><span class="help-step-body">${step.text}</span></span></li>`))
        .filter(step => String(step).trim());
      return steps.length ? html`<ol class="help-steps" role="list">${steps}</ol>` : '';
    } })}
    ${group({ title: 'Search syntax', keywords: 'operators filter', description: 'Type these in the search field. They work in every view.', body: () => card(SEARCH_SYNTAX.map(entry => searchable([entry.code, entry.text], html`<div class="syntax-row">
      <code class="syntax-code">${entry.code}</code><span class="syntax-text">${entry.text}</span></div>`)), 'syntax-card') })}
    ${group({ title: 'Keyboard', keywords: 'shortcuts keys', actions: isSearching() ? '' : button({ label: 'All shortcuts', iconRight: 'arrow-right', size: 'sm', variant: 'ghost', action: 'settings.section', data: { section: 'shortcuts' } }),
      body: () => card(shortcuts.map(shortcut => shortcutRow(shortcut.label, keyCaps(shortcut.keys), shortcut.keys)), 'shortcut-card') })}
    ${group({ title: 'Guides', keywords: 'docs documentation', body: () => card(GUIDES.map(guide => searchable([guide.label], html`<a class="settings-link-row" href="${safeHref(guide.url)}" target="_blank" rel="noopener noreferrer">
      ${icon('book-open', { size: 16 })}<span>${guide.label}</span>${icon('arrow-up-right', { size: 14, className: 'settings-link-row-icon' })}</a>`))) })}
    ${group({ title: 'The reference room', keywords: 'images screenshots references', description: `All ${REFERENCE_ASSETS.length} reference images that shaped Still: library layouts, notes, capture, collections, highlights, AI and agent connections. Open one to see it full size.`,
      body: () => {
        const figures = REFERENCE_ASSETS.map(asset => searchable([asset.description, asset.name], html`<li><figure class="reference-figure">
          <a class="reference-link" href="./${encodeURI(asset.path)}" target="_blank" rel="noopener noreferrer" aria-label="${asset.description}, open full size">
            <img src="${safeSrc(asset.path)}" alt="" loading="lazy" decoding="async" width="320" height="200"></a>
          <figcaption><span class="reference-title">${asset.description}</span><span class="reference-file">${asset.name}</span></figcaption></figure></li>`)).filter(entry => String(entry).trim());
        return figures.length ? html`<ul class="reference-grid" role="list">${figures}</ul>` : '';
      } })}`;
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

async function loadModels(ctx, id, { refresh: fresh = false } = {}) {
  patchConnect(ctx, { modelsLoading: true, modelsError: '' });
  try { patchConnect(ctx, { models: await ctx.ai.listModels(id, { refresh: fresh, kind: 'chat' }), modelsLoading: false }); }
  catch (error) { patchConnect(ctx, { modelsLoading: false, modelsError: error.message }); }
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
    <header class="dialog-header settings-connect-head">
      ${providerMark(provider.id, 36)}
      <div class="dialog-heading"><h2 class="dialog-title" id="dialog-title-settings.connect">${connection ? connection.label : `Connect ${provider.name}`}</h2>
        <p class="dialog-subtitle">${provider.description}</p></div>
      ${iconButton({ icon: 'x', label: 'Close', action: 'overlay.dismiss', size: 'sm', className: 'dialog-close' })}
    </header>
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
        hint: html`Stored on this device in Chrome’s extension storage. Not included in backups.${provider.keyUrl ? html` <a class="link-inline" href="${safeHref(provider.keyUrl)}" target="_blank" rel="noopener noreferrer">Get a key</a>` : ''}`,
        control: html`<span class="settings-secret">${input({ id: 'settings-connect-key', type: props.showKey ? 'text' : 'password', value: d.apiKey,
          placeholder: connection?.hasKey ? 'Saved. Paste a new key to replace it.' : provider.keyPlaceholder || 'Paste your key', action: 'settings.connect-field', invalid: keyInvalid,
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
    <footer class="dialog-footer">
      ${connection ? button({ label: 'Remove', size: 'md', variant: 'ghost', className: 'settings-danger-text', action: 'settings.connect-remove', disabled: working }) : ''}
      <span class="spacer"></span>
      ${props.id ? button({ label: 'Test', variant: 'secondary', action: 'settings.connect-test', loading: props.testing && !props.saving, disabled: working }) : ''}
      ${button({ label: primary, type: 'submit', variant: 'primary', loading: props.saving, disabled: props.testing })}
    </footer>
  </form>`;
}

async function finishConnectSave(ctx, pending, { test, closeOnSuccess }) {
  patchConnect(ctx, { saving: true, result: null });
  let connection;
  try { connection = await pending; } catch (error) {
    patchConnect(ctx, { saving: false, result: { ok: false, message: error.message || 'The connection could not be saved.', code: error.code || 'error' } });
    return;
  }
  connectDraft.apiKey = '';
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

/** Shows a section: the full tab navigates (so the view and history stay right), the side panel drills in. */
function goToSection(ctx, section, anchor) {
  const ui = uiState(ctx);
  const id = normalizeSection(section);
  ui.query = '';
  if (ctx.env.isSidepanel) {
    ui.section = id;
    ui.list = false;
    ctx.render();
  } else if (ctx.state.view !== settingsView(id)) ctx.navigate(settingsView(id));
  else ctx.render();
  ctx.nextFrame(() => {
    const target = anchor && document.getElementById(anchor);
    if (target) { reveal(target); return; }
    document.querySelector('#main')?.scrollTo?.({ top: 0 });
    focusEntry(ctx);
  });
}

function backToList(ctx) {
  const ui = uiState(ctx);
  const from = ui.section;
  ui.query = '';
  if (ctx.env.isSidepanel) { ui.list = true; ctx.render(); } else ctx.navigate('settings');
  focusSoon(ctx, `#settings-nav-${from}`);
}

function setQuery(ctx, value) {
  const ui = uiState(ctx);
  if (ui.query === value) return;
  ui.query = value;
  ui.queryView = ctx.state.view;
  ctx.render();
  if (!value) ctx.nextFrame(() => document.querySelector('#main')?.scrollTo?.({ top: 0 }));
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
  if (!job || !['pending', 'user_action_needed'].includes(job.status) || !live.mounted) return;
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

async function runImport(ctx, file) {
  if (!file) return;
  if (!live.mounted) openSettings(ctx, 'library');
  data.importJob = { name: file.name || 'the file', running: true };
  ctx.render();
  try {
    const result = await importPortableFile(file, ctx.store);
    data.importJob = { name: file.name || 'the file', result };
    ctx.toast(importReport(result, file.name || 'the file').summary, { tone: result.warnings?.length ? 'warning' : 'success' });
    // The 'before-import' snapshot joins the list; restored AI connections join AI models.
    loadSnapshots(ctx);
    if (result.aiConnections) loadAi(ctx).catch(() => {});
  } catch (error) {
    data.importJob = { name: file.name || 'the file', error: error.message || 'The file could not be read.' };
  }
  ctx.render();
}

// Arrow keys move between the options of a radio group (theme cards, swatches, segmented controls) and select them.
const ARROWS = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
function moveInRadioGroup(event) {
  const target = event.target;
  if (target?.getAttribute?.('role') !== 'radio' || !(event.key in ARROWS || event.key === 'Home' || event.key === 'End')) return false;
  const radios = [...(target.closest('[role="radiogroup"]')?.querySelectorAll('[role="radio"]') || [])].filter(radio => !radio.disabled);
  const index = radios.indexOf(target);
  if (index < 0) return false;
  const rtl = getComputedStyle(target).direction === 'rtl' && ['ArrowLeft', 'ArrowRight'].includes(event.key) ? -1 : 1;
  const next = event.key === 'Home' ? radios[0] : event.key === 'End' ? radios.at(-1) : radios[(index + ARROWS[event.key] * rtl + radios.length) % radios.length];
  event.preventDefault();
  next.focus();
  next.click();
  return true;
}

registerDialog(CONNECT, renderConnect, { size: 'md', className: 'settings-connect' });

registerActions({
  'settings.close': ({ ctx }) => {
    if (ctx.env.isSidepanel) { closeSidePanel(ctx); return; }
    ctx.navigate('dashboard');
  },
  'settings.section': ({ ctx, event, data: payload }) => {
    // Links keep their browser behavior with a modifier (new tab, new window); a plain click stays in this page.
    if (event?.type === 'click' && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0)) return;
    event?.preventDefault?.();
    goToSection(ctx, payload.section, payload.anchor);
  },
  'settings.back': ({ ctx }) => backToList(ctx),
  'settings.escape': ({ ctx }) => {
    const ui = uiState(ctx);
    if (ui.query) return setQuery(ctx, '');
    if (!ui.list) return backToList(ctx);
    closeSidePanel(ctx);
    return undefined;
  },
  'settings.key': ({ event }) => { moveInRadioGroup(event); },
  'settings.search': ({ ctx, el }) => {
    clearTimeout(live.searchTimer);
    const value = el.value;
    live.searchTimer = setTimeout(() => setQuery(ctx, value), 120);
  },
  'settings.search-key': ({ ctx, el, event }) => {
    if (event.key === 'Enter') {
      // Enter jumps to the first result.
      event.preventDefault();
      clearTimeout(live.searchTimer);
      setQuery(ctx, el.value);
      ctx.nextFrame(() => {
        const results = document.querySelector('.settings-results');
        const first = results?.querySelector(':is(.settings-group, .settings-result-summary) :is(a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), [tabindex="0"])')
          || results?.querySelector('a[href], button:not([disabled])');
        first?.focus();
        first?.scrollIntoView({ block: 'nearest' });
      });
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    clearTimeout(live.searchTimer);
    if (el.value) { el.value = ''; setQuery(ctx, ''); return; }
    el.blur();
  },
  'settings.search-clear': ({ ctx }) => {
    clearTimeout(live.searchTimer);
    setQuery(ctx, '');
    focusSoon(ctx, '#settings-search');
  },
  'settings.disclose': ({ ctx, data: payload }) => {
    const open = uiState(ctx).open;
    if (open.has(payload.id)) open.delete(payload.id); else open.add(payload.id);
    ctx.render();
  },
  'settings.refresh': ({ ctx }) => refresh(ctx, { bridge: true }),

  // General
  'settings.default-collection': ({ ctx, data: payload }) => updateLibrarySettings(ctx, { defaultCollectionId: payload.value || '' }),
  'settings.toggle': ({ ctx, el, data: payload }) => {
    if (!['openPanelOnSave', 'startOnPage', 'confirmDelete'].includes(payload.key)) return undefined;
    return updateLibrarySettings(ctx, { [payload.key]: !!el.checked });
  },

  // Library & backup
  'settings.backup': ({ ctx }) => withBusy(ctx, 'backup', async () => {
    data.backupJob = null;
    const backup = await createFullBackup(ctx.store);
    // The size limit is checked on exactly this text, so the downloaded file can always be restored.
    download(serializeBackup(backup).text, `still-backup-${today()}.json`, 'application/json');
    const { counts, warnings } = backup.manifest;
    data.backupJob = warnings.length ? { warnings } : null;
    const parts = [plural(counts.items, 'item'), counts.attachments && plural(counts.attachments, 'file'), counts.boards && plural(counts.boards, 'dashboard'),
      counts.conversations && plural(counts.conversations, 'chat'), counts.chats && plural(counts.chats, 'AI chat')].filter(Boolean);
    ctx.toast(`Backup downloaded: ${parts.join(', ')}`, { tone: warnings.length ? 'warning' : 'success' });
  }),
  'settings.backup-dismiss': ({ ctx }) => { data.backupJob = null; ctx.render(); },
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
  'settings.export-csv': ({ ctx }) => withBusy(ctx, 'export-csv', async () => {
    download(exportItemsCsv(await ctx.store.exportLibrary()), `still-items-${today()}.csv`, 'text/csv');
    ctx.toast('Items exported as CSV', { tone: 'success' });
  }),
  'settings.export-chats': ({ ctx }) => withBusy(ctx, 'export-chats', async () => {
    const { markdown, count } = await exportChatsMarkdown();
    if (!count) { ctx.toast('There are no assistant chats to export yet.'); return; }
    download(markdown, `still-assistant-chats-${today()}.md`, 'text/markdown');
    ctx.toast(`Exported ${plural(count, 'assistant chat')}`, { tone: 'success' });
  }),
  'settings.snapshot-create': ({ ctx }) => withBusy(ctx, 'snapshot-create', async () => {
    await createSnapshot('manual');
    await loadSnapshots(ctx);
    ctx.toast('Snapshot saved on this device', { tone: 'success' });
  }),
  'settings.snapshot-restore': async ({ ctx, data: payload }) => {
    const snapshot = data.snapshots?.list.find(entry => entry.id === payload.id);
    if (!snapshot) return;
    const ok = await ctx.confirm({ title: 'Restore this snapshot?', confirmLabel: 'Restore snapshot',
      body: `Your library, settings, dashboards, assistant chats and AI connections go back to how they were on ${snapshotWhen(snapshot.createdAt)}. Still first saves a snapshot of everything as it is now, so you can switch back from this list.` });
    if (!ok) return;
    await withBusy(ctx, `snapshot:${snapshot.id}`, async () => {
      await restoreSnapshot(snapshot.id);
      await loadSnapshots(ctx);
      ctx.toast('Snapshot restored. Reloading Still…', { tone: 'success' });
      // This page reloads to read the restored data fresh (in the preview build it does not see its own storage
      // writes); other open Still pages follow storage changes.
      setTimeout(() => globalThis.location?.reload?.(), 900);
    });
  },
  'settings.snapshot-delete': async ({ ctx, data: payload }) => {
    const snapshot = data.snapshots?.list.find(entry => entry.id === payload.id);
    if (!snapshot) return;
    const ok = await ctx.confirm({ title: 'Delete this snapshot?', confirmLabel: 'Delete snapshot', tone: 'danger',
      body: `The snapshot from ${snapshotWhen(snapshot.createdAt)} is removed from this device. This cannot be undone.` });
    if (!ok) return;
    await deleteSnapshot(snapshot.id);
    await loadSnapshots(ctx);
    ctx.toast('Snapshot deleted');
  },
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
      const result = await integrations.testRaindropConnection();
      drafts.raindropToken = '';
      await loadIntegration(ctx);
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
  'settings.connect-refresh-models': ({ ctx }) => { const props = topProps(ctx, CONNECT); if (props?.id) return loadModels(ctx, props.id, { refresh: true }); return undefined; },
  'settings.connect-save': ({ ctx }) => {
    const props = topProps(ctx, CONNECT);
    const ai = ctx.ai;
    if (!props || !ai || props.saving || props.testing) return undefined;
    const provider = ai.getProvider(props.providerId);
    const connection = props.id ? (data.connections || []).find(entry => entry.id === props.id) : null;
    const d = connectDraft;
    const request = { providerId: provider.id, ...(props.id ? { id: props.id } : {}) };
    if (d.apiKey.trim()) request.apiKey = d.apiKey.trim();
    if (provider.editableBaseUrl && d.baseUrl.trim()) request.baseUrl = d.baseUrl.trim();
    if (provider.kind === 'custom') request.label = d.label.trim();
    if (provider.transport === 'anthropic') request.workspaceId = d.workspaceId.trim();
    if (provider.chat && d.defaultModel) request.defaultModel = d.defaultModel;
    const credentialsChanged = !props.id || !!request.apiKey || (provider.editableBaseUrl && (request.baseUrl || '') !== (connection?.baseUrl || ''))
      || (provider.transport === 'anthropic' && request.workspaceId !== (connection?.workspaceId || '')) || connection?.status === 'error';
    // saveConnection asks Chrome for host access before its first await, so it must run inside this handler's gesture.
    const pending = ai.saveConnection(request);
    return finishConnectSave(ctx, pending, { test: credentialsChanged, closeOnSuccess: !!props.id && !props.justConnected });
  },
  'settings.connect-test': async ({ ctx }) => {
    const props = topProps(ctx, CONNECT);
    if (!props?.id) return;
    patchConnect(ctx, { testing: true, result: null });
    let result;
    try { result = await ctx.ai.testConnection(props.id); } catch (error) { result = { ok: false, message: error.message, code: error.code }; }
    patchConnect(ctx, { testing: false, result });
    await loadAi(ctx);
    if (result.ok && ctx.ai.getProvider(props.providerId)?.modelList) loadModels(ctx, props.id);
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
  'settings.connection-test': ({ ctx, data: payload }) => withBusy(ctx, `test:${payload.id}`, async () => {
    const result = await ctx.ai.testConnection(payload.id);
    await loadAi(ctx);
    if (result.ok) ctx.toast(`${result.message || 'Connected.'}${Number.isFinite(result.latencyMs) ? ` ${result.latencyMs.toLocaleString()} ms.` : ''}`, { tone: 'success' });
    else ctx.toast(`${result.message}${ERROR_HINTS[result.code] ? ` ${ERROR_HINTS[result.code]}` : ''}`, { tone: 'danger' });
  }),
  'settings.ai-model': ({ ctx, el }) => {
    const { connectionId, model } = parseChoice(el.value);
    const record = findModel(data.connections || [], { connectionId, model }).model;
    return setAi(ctx, { chat: { connectionId, model, effort: effortFor(record, aiSettings(ctx).chat?.effort || 'medium') } });
  },
  'settings.ai-effort': ({ ctx, el }) => (el.value ? setAi(ctx, { chat: { effort: el.value } }) : undefined),
  'settings.ai-quick': ({ ctx, el }) => setAi(ctx, { quick: parseChoice(el.value) }),
  'settings.ai-flag': ({ ctx, el, data: payload }) => setAi(ctx, { [payload.key]: !!el.checked }),
  'settings.ai-handoff': ({ ctx, data: payload }) => setAi(ctx, { handoffTarget: payload.value }),

  // Assistant permissions
  'settings.ai-permission': ({ ctx, data: payload }) => {
    if (!PERMISSION_CATEGORIES.some(category => category.id === payload.name) || !PERMISSION_LEVELS.includes(payload.value)) return undefined;
    return setAi(ctx, { assistantPermissions: { [payload.name]: payload.value } });
  },
  'settings.ai-permission-preset': ({ ctx, data: payload }) => {
    // Custom is whatever the rows below say: choosing it moves focus there instead of changing anything.
    if (payload.value === 'custom') { focusSoon(ctx, '#settings-permission-create [role="radio"][aria-checked="true"]'); return undefined; }
    if (!Object.hasOwn(PERMISSION_PRESETS, payload.value)) return undefined;
    return setAi(ctx, { assistantPermissions: { ...PERMISSION_PRESETS[payload.value] } });
  },

  // Browser automation
  'settings.browser-enable': ({ ctx, el }) => {
    if (!el.checked) return setAi(ctx, { browser: { enabled: false } });
    // Chrome asks only inside the click, so the request goes out before anything is awaited.
    const granted = requestAccess({ permissions: [...BROWSER_PERMISSIONS] });
    return withBusy(ctx, 'browser-allow', async () => {
      if (!(await granted)) {
        // The switch goes back to off: nothing was turned on.
        ctx.toast('Chrome did not allow Still to see your tabs, so browser automation stays off.', { tone: 'warning' });
        return;
      }
      await setAi(ctx, { browser: { enabled: true } });
      await loadBrowserStatus(ctx);
    });
  },
  'settings.browser-allow': ({ ctx }) => {
    const granted = requestAccess({ permissions: [...BROWSER_PERMISSIONS] });
    return withBusy(ctx, 'browser-allow', async () => {
      if (!(await granted)) ctx.toast('Chrome did not allow it. The assistant cannot work in the browser until it does.', { tone: 'warning' });
      await loadBrowserStatus(ctx);
    });
  },
  'settings.browser-mode': ({ ctx, data: payload }) => (BROWSER_MODES.includes(payload.value) ? setAi(ctx, { browser: { mode: payload.value } }) : undefined),
  'settings.browser-steps': ({ ctx, el }) => {
    const steps = Number(el.value);
    return Number.isInteger(steps) && steps >= BROWSER_LIMITS.minSteps && steps <= BROWSER_LIMITS.maxSteps ? setAi(ctx, { browser: { maxSteps: steps } }) : undefined;
  },
  'settings.browser-site-field': ({ ctx, el }) => {
    drafts.browserSite = el.value;
    if (drafts.browserError) { drafts.browserError = ''; ctx.render(); }
  },
  'settings.browser-site-draft-rule': ({ el }) => { if (SITE_RULES.includes(el.value)) drafts.browserRule = el.value; },
  'settings.browser-site-add': ({ ctx }) => {
    const site = siteKey(drafts.browserSite);
    if (!site) { drafts.browserError = 'Enter a site, such as example.com.'; ctx.render(); focusSoon(ctx, '#settings-browser-site'); return undefined; }
    const current = aiSettings(ctx).browser;
    if (!Object.hasOwn(current?.sites || {}, site) && Object.keys(current?.sites || {}).length >= BROWSER_LIMITS.maxSites) {
      drafts.browserError = `Still keeps up to ${BROWSER_LIMITS.maxSites} site rules. Remove one first.`;
      ctx.render();
      return undefined;
    }
    const next = withSiteRule(current, site, drafts.browserRule);
    drafts.browserSite = '';
    drafts.browserError = '';
    return setAi(ctx, { browser: { sites: next.sites } });
  },
  // The select's name is the site it belongs to.
  'settings.browser-site-rule': ({ ctx, el }) => (SITE_RULES.includes(el.value) && siteKey(el.name) ? setAi(ctx, { browser: { sites: withSiteRule(aiSettings(ctx).browser, el.name, el.value).sites } }) : undefined),
  'settings.browser-site-remove': ({ ctx, data: payload }) => (siteKey(payload.site) ? setAi(ctx, { browser: { sites: withSiteRule(aiSettings(ctx).browser, payload.site, null).sites } }) : undefined),

  // Research agent
  'settings.research': ({ ctx, el, data: payload }) => {
    // Segmented controls carry data-name and data-value; selects their own name and value.
    const patch = researchPatch(payload.name || el?.name, payload.value ?? el?.value);
    return patch ? setAi(ctx, { research: patch }) : undefined;
  },
  'settings.research-flag': ({ ctx, el, data: payload }) => (['enabled', 'allowOriginalEdits'].includes(payload.key) ? setAi(ctx, { research: { [payload.key]: !!el.checked } }) : undefined),
  'settings.research-reset': async ({ ctx }) => {
    if (typeof ctx.ai?.resetResearchProvisioning !== 'function') { ctx.toast('Research is not available in this version of Still.', { tone: 'warning' }); return; }
    const ok = await ctx.confirm({ title: 'Reset the research agent?', confirmLabel: 'Reset research agent',
      body: 'Still forgets the research agent and environment it set up in your Anthropic account and sets up new ones on the next run. Nothing is deleted from your account, and research already in your notes stays.' });
    if (!ok) return;
    await withBusy(ctx, 'research-reset', () => ctx.ai.resetResearchProvisioning());
    ctx.toast('Research agent reset', { tone: 'success' });
  },

  // Local bridge
  'settings.bridge-field': ({ el }) => { drafts[el.dataset.field] = el.value; },
  'settings.bridge-pair': ({ ctx, el }) => {
    const form = el.closest?.('form') || el;
    const url = String(form.querySelector?.('input[name="url"]')?.value ?? drafts.bridgeUrl ?? data.integration?.bridgeUrl ?? integrations.DEFAULT_BRIDGE_URL).trim();
    const token = String(form.querySelector?.('input[name="token"]')?.value ?? drafts.bridgeToken).trim();
    if (!token) throw new Error('Paste the pairing token the bridge printed.');
    let origin;
    try { const parsed = new URL(url); origin = `${parsed.protocol}//${parsed.hostname}/*`; } catch { throw new Error('Enter the bridge address it printed, such as http://127.0.0.1:47321.'); }
    // pairBridge requests loopback host access synchronously, inside this click or Enter.
    const pending = ctx.ai?.pairBridge ? ctx.ai.pairBridge({ url, token })
      : requestAccess({ origins: [origin] }).then(granted => {
        if (!granted) throw new Error('Chrome did not allow Still to reach the bridge. Try again and choose Allow.');
        return integrations.configureBridge({ url, token, enabled: true });
      });
    return withBusy(ctx, 'pair', async () => {
      await pending;
      drafts.bridgeToken = '';
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
    if (typeof integrations.setBridgeEnabled === 'function') await ctx.startBridgeSync?.();
    else ctx.stopBridgeSync = integrations.startBridgeSync({ onStatus: info => { ctx.state.bridge = info; }, onChange: () => ctx.render() });
    ctx.toast('Bridge sync resumed');
  }),
  'settings.bridge-unpair': async ({ ctx }) => {
    const ok = await ctx.confirm({ title: 'Unpair the local bridge?', body: 'Still forgets the pairing token. Agents and bridge connections stop working until you pair again. Your library is not changed.',
      confirmLabel: 'Unpair bridge', tone: 'danger' });
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
    ctx.toast(['claude', 'codex'].filter(id => agents?.[id]).map(id => `${id === 'claude' ? 'Claude Code' : 'Codex'}: ${authText(agents[id]).toLowerCase()}`).join('. ') || 'No agents answered.');
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
  'settings.search-refresh-models': ({ ctx, data: payload }) => withBusy(ctx, 'embedding-models', async () => {
    await ctx.ai.listModels(payload.id, { refresh: true, kind: 'embeddings' });
    await loadAi(ctx);
  }),
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
    const client = (data.clients || []).find(entry => (entry.clientId || entry.id) === payload.id);
    try {
      await integrations.requestBridge(`/connections/${encodeURIComponent(payload.id)}/connect`, { method: 'POST', body: { previewHash: client?.previewHash ?? client?.configHash ?? null } });
      ctx.toast(`Still added to ${payload.name}. Restart ${payload.name} to load it.`, { tone: 'success' });
    } finally { await loadClients(ctx); }
  }),
  'settings.client-disconnect': async ({ ctx, data: payload }) => {
    const ok = await ctx.confirm({ title: `Disconnect ${payload.name}?`, body: `Still’s entry is removed from ${payload.name}’s configuration. Other servers there are kept, and a backup is saved first.`, confirmLabel: 'Disconnect', tone: 'danger' });
    if (!ok) return;
    await withBusy(ctx, `client:${payload.id}`, async () => {
      const client = (data.clients || []).find(entry => (entry.clientId || entry.id) === payload.id);
      try {
        await integrations.requestBridge(`/connections/${encodeURIComponent(payload.id)}/disconnect`, { method: 'POST', body: { previewHash: client?.previewHash ?? client?.configHash ?? null } });
        ctx.toast(`Still removed from ${payload.name}`);
      } finally { await loadClients(ctx); }
    });
  },
  'settings.paperclip-scope': ({ ctx, el }) => { data.paperclip.scope = MCP_SCOPES.some(entry => entry.value === el.value) ? el.value : 'write'; data.paperclip.scopeChosen = true; ctx.render(); },
  'settings.paperclip-setup': ({ ctx }) => withBusy(ctx, 'paperclip', () => paperclipSetup(ctx)),
  'settings.paperclip-rotate': async ({ ctx }) => {
    const ok = await ctx.confirm({ title: 'Rotate the Paperclip token?', confirmLabel: 'Rotate token',
      body: 'The current token stops working at once. Paperclip agents cannot reach Still until you paste the new config into Paperclip.' });
    if (ok) await withBusy(ctx, 'paperclip-rotate', () => paperclipSetup(ctx, { rotate: true }));
  },
  'settings.paperclip-revoke': async ({ ctx }) => {
    const ok = await ctx.confirm({ title: 'Revoke Paperclip’s access?', confirmLabel: 'Revoke', tone: 'danger',
      body: 'Still removes Paperclip’s token from the bridge. Paperclip agents can no longer reach your library. Your library and other agents are not affected.' });
    if (!ok) return;
    await withBusy(ctx, 'paperclip-revoke', async () => {
      try {
        const receipt = await integrations.requestBridge('/connections/paperclip/revoke', { method: 'POST', body: {} });
        data.paperclip.result = null;
        data.paperclip.error = '';
        ctx.toast(receipt?.removed === false ? 'Paperclip had no token to revoke.' : 'Paperclip’s token is revoked.');
      } catch (error) { data.paperclip.error = paperclipError(error); }
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

// Escape steps back in the side panel: clears the search, leaves a section, then closes Settings.
registerShortcuts([
  { keys: 'escape', action: 'settings.escape', when: ctx => ctx.env.isSidepanel && ctx.state.panel?.kind === 'settings' && !ctx.state.dialogs.length && !ctx.state.popover },
]);

/** One-time wiring (after the AI engine has loaded): the hidden #import-input feeds Library & backup. */
export function init(ctx) {
  live.engineSettled = true;
  // A page opened straight onto Settings mounted before the AI engine existed: load its part now.
  if (live.mounted) {
    try { live.offAi ||= ctx.ai?.onConnectionsChanged?.(() => loadAi(ctx)) || null; } catch { live.offAi = null; }
    try { live.offIndex ||= ctx.ai?.subscribeIndex?.(status => { data.index = status; if (live.mounted) ctx.render(); }) || null; } catch { live.offIndex = null; }
    loadAi(ctx, { refresh: true }).then(() => loadClients(ctx)).catch(error => console.error(error));
  }
  const picker = document.getElementById('import-input');
  if (!picker || picker.dataset.settingsBound) return;
  picker.dataset.settingsBound = 'true';
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    ctx.run(() => runImport(ctx, file));
  });
}
