// The AI facade: the only module the UI imports. Connections, chat streaming and hand-off come from their own modules;
// the knowledge half (semantic index, search, assistant, writing tools, history) is wired here on first use, and
// init() connects it to the app's store and library so indexing follows library changes.
import * as libraryStore from '../store.js';
import { requestBridge } from '../integrations.js';
import * as connections from './connections.js';
import { streamChat as chatStream } from './chat.js';
import { providerFetch } from './http.js';
import { createEmbedder } from './embeddings.js';
import { createVectorStore } from './vector-store.js';
import { createIndexer } from './indexer.js';
import { createSearch } from './search.js';
import { createAssistant } from './assistant.js';
import { createPaperclipToolProvider } from './paperclip-tools.js';
import { undoChanges } from './tools.js';
import { createTransforms } from './transforms.js';
import { createAutotag } from './autotag.js';
import { createConversationStore } from './conversations.js';
import { createImports } from './imports.js';
import { getProvider as catalogProvider } from './catalog.js';
import { createResearch } from './research/run.js';
import { detectLocalWindow } from './local-context.js';
import { createBrowserClient } from './browser-client.js';
import { createBrowserTools } from './browser-tools.js';
import { normalizeBrowserSettings } from '../browser/settings.js';

export { CATALOG, EFFORT_LEVELS, ANTHROPIC_EFFORTS, EFFORT_LABELS, getProvider, chatProviders, embeddingProviders } from './catalog.js';
export { listConnections, saveConnection, deleteConnection, testConnection, listModels, getAiSettings, onConnectionsChanged, ensureHostPermission,
  hostPermissionOrigins, resolveChatTarget, getBridgeStatus, pairBridge, cliSignInStatus, startChatGptSignIn, chatGptSignInStatus, cancelChatGptSignIn,
  DEFAULT_AI_SETTINGS } from './connections.js';
export { streamChat } from './chat.js';
export { handoffUrl, buildHandoffPrompt, handoffPlan, HANDOFF_TARGETS } from './handoff.js';

// external: the assistant's read-only external tool providers; undefined means the default (Paperclip), built on first use.
const runtime = { store: libraryStore, getLibrary: null, snapshot: null, requestBridge, dispose: null, dashboard: null, threadSources: null, external: undefined, browserClient: null };
const externalProviders = () => runtime.external === undefined ? (runtime.external = [createPaperclipToolProvider()]) : runtime.external;
let services = null;

async function currentLibrary() {
  if (runtime.getLibrary) return runtime.getLibrary();
  return runtime.snapshot ||= await runtime.store.loadLibrary();
}
// Resolved at call time so init() can swap in the app's store (ctx.store) after the engine was created. These are the
// lib/store.js operations the assistant's proposals apply and undo with; loadLibrary is the worker's authoritative copy,
// read while the app's snapshot still lags behind a change the assistant just applied.
const STORE_METHODS = ['bulkUpdateItems', 'createCollection', 'saveItem', 'deleteItem', 'deleteCollection', 'updateItem', 'restoreItem', 'permanentlyDeleteItem',
  'updateCollection', 'moveCollection', 'movePage', 'upsertContentSection', 'mutateTags', 'loadLibrary'];
const store = Object.fromEntries(STORE_METHODS.map(name => [name, (...args) => runtime.store[name](...args)]));
// The research agent writes through these (lib/ai/research/custom-tools.js), resolved at call time like `store` above.
// upsertContentSection is optional: without it the research tools fall back to a revision-checked updateItem.
const researchStore = {
  loadLibrary: (...args) => runtime.store.loadLibrary(...args),
  saveItem: input => runtime.store.saveItem(input),
  updateItem: (id, patch, options) => runtime.store.updateItem(id, patch, options),
  deleteItem: (id, options) => runtime.store.deleteItem(id, options),
  get upsertContentSection() { return typeof runtime.store?.upsertContentSection === 'function' ? (id, section) => runtime.store.upsertContentSection(id, section) : undefined; },
};
const dashboardAdapter = value => value && typeof value.describe === 'function' && typeof value.addCollectionWidget === 'function' ? value : null;
// AI threads (lib/ai/threads.js createThreadSources): { chats, threads() }; chats are the chats saved in Still, threads()
// resolves to the Threadkeeper adapter for a turn, or null.
const threadSourcesAdapter = value => value && typeof value.threads === 'function' && value.chats && typeof value.chats.readLocal === 'function' ? value : null;
const chatsNow = () => runtime.threadSources?.chats || null;
const threadsNow = async () => { try { return (await runtime.threadSources?.threads()) || null; } catch { return null; } };
const aiSettings = () => connections.getAiSettings();

// Browser automation (lib/browser/host.js in the service worker). A client is one port; tests swap the factory in init().
const browserClient = () => (typeof runtime.browserClient === 'function' ? runtime.browserClient() : createBrowserClient());
const insideExtension = () => typeof globalThis.chrome?.runtime?.connect === 'function' || typeof runtime.browserClient === 'function';
/**
 * Whether the assistant can work in browser tabs now: { available, missing: [Chrome permission], reason? }. Asks the
 * service worker, which does not load the browser control layer for this.
 */
export async function browserStatus() {
  if (!insideExtension()) return { available: false, missing: [], reason: 'Browser automation works in the installed extension.' };
  const client = browserClient();
  // What Chrome has to allow depends on the engine the person chose (lib/browser/settings.js browserAccess).
  let chosen = 'quiet';
  try { chosen = normalizeBrowserSettings((await aiSettings())?.browser).engine; } catch { chosen = 'quiet'; }
  try { return await client.status(chosen); }
  catch (error) { return { available: false, missing: [], reason: String(error?.message || error) }; }
  finally { await client.close().catch(() => undefined); }
}
// The turn's browser tools, or null: automation is off, this page is not inside the extension, or Chrome has not been
// given the tab permissions (the UI is told, so it can ask in a click).
async function browserFor({ settings, vision, hint, onPrompt, onWithdrawn, emit }) {
  const policy = normalizeBrowserSettings(settings);
  if (!policy.enabled || !insideExtension()) return null;
  const client = browserClient();
  let status = null;
  try { status = await client.status(policy.engine); } catch { status = null; }
  if (!status?.available) {
    await client.close().catch(() => undefined);
    if (status?.missing?.length) emit({ type: 'browser_permission', permissions: status.missing });
    return null;
  }
  return createBrowserTools({ client, policy, vision, reveal: hint?.reveal === true, startTabId: Number.isInteger(hint?.tabId) ? hint.tabId : null, onPrompt, onWithdrawn, emit });
}

function engine() {
  if (services) return services;
  const conversations = createConversationStore();
  const embedder = createEmbedder({ resolveConnection: connections.resolveConnection, providerFetch, requestBridge: (...args) => runtime.requestBridge(...args) });
  const vectorStore = createVectorStore();
  // Chats are indexed with a digest of their stored summary (the library item itself holds only a gist).
  const indexer = createIndexer({ vectorStore, embedder, getLibrary: currentLibrary, getSettings: aiSettings, extraText: item => chatsNow()?.digest?.(item) || '' });
  const search = createSearch({ getLibrary: currentLibrary, vectorStore, isSemanticReady: () => indexer.isReady(), embedQuery: (query, options) => indexer.embedQuery(query, options) });
  const assistant = createAssistant({ streamChat: chatStream, resolveConnection: connections.resolveConnection, resolveChatTarget: connections.resolveChatTarget, modelInfo: connections.modelInfo,
    getAiSettings: aiSettings, getLibrary: currentLibrary, store, searchLibrary: search.searchLibrary, conversations, dashboard: () => runtime.dashboard, threads: threadsNow, chats: chatsNow,
    external: externalProviders, browser: browserFor, detectWindow: detectLocalWindow });
  const transforms = createTransforms({ streamChat: chatStream, resolveConnection: connections.resolveConnection, resolveChatTarget: connections.resolveChatTarget,
    getAiSettings: aiSettings, getLibrary: currentLibrary });
  const imports = createImports({ streamChat: chatStream, resolveChatTarget: connections.resolveChatTarget, resolveConnection: connections.resolveConnection, getProvider: catalogProvider });
  const autotag = createAutotag({ streamChat: chatStream, resolveChatTarget: connections.resolveChatTarget, getLibrary: currentLibrary });
  services = { conversations, indexer, search, assistant, transforms, imports, autotag };
  return services;
}

// Research runs outlive init()/dispose(): a run keeps going while its page is open, so its engine is not part of the
// knowledge services that dispose() resets.
let research = null;
const researchEngine = () => research ||= createResearch({ conversations: createConversationStore(), store: researchStore, getAiSettings: aiSettings,
  listConnections: (...args) => connections.listConnections(...args), resolveConnection: (...args) => connections.resolveConnection(...args) });

/** Saves AI settings; a change to `embeddings` re-reads the index configuration (and starts indexing when enabled). */
export async function setAiSettings(patch) {
  const result = await connections.setAiSettings(patch);
  if (services && patch && typeof patch === 'object' && 'embeddings' in patch) services.indexer.refresh().catch(error => console.error(error));
  return result;
}

export const runAssistant = options => engine().assistant.runAssistant(options);
/** Undoes an applied proposal from its saved plain-data record (proposal.undo), e.g. after a reload lost the live undo. */
export const undoProposal = undo => undoChanges(store, undo, { dashboard: runtime.dashboard, chats: chatsNow() });

/**
 * AI threads for the assistant panel. threadStatus() -> { status, enabled, paused, capabilities, prefs } | null.
 * warmThreads(): wakes Threadkeeper when the assistant opens (best effort). resolveThreadCitation({ id, threadKey }) ->
 * { itemId } when the cited thread is saved in Still, else { threadKey, canImport, canOpen } (or null when unknown).
 * importThreadCitation({ id, threadKey }) imports one cited thread (origin 'manual': the user clicked Import) ->
 * { itemId } ; openThreadInThreadkeeper(threadKey) opens it in Threadkeeper.
 */
export const threadStatus = () => runtime.threadSources?.state?.() || null;
export const warmThreads = () => Promise.resolve(runtime.threadSources?.warm?.()).catch(() => false);
export async function resolveThreadCitation({ id = '', threadKey = '' } = {}) {
  const chats = chatsNow();
  const library = await currentLibrary().catch(() => null);
  const chat = (threadKey && chats?.localChatFor(threadKey, library)) || chats?.chatForCite(id, library) || null;
  if (chat) return { itemId: chat.id };
  const tk = await threadsNow();
  let key = threadKey;
  if (!key && tk && /^tk:[0-9a-f]{16}$/.test(id)) key = (await tk.get({ citeIds: [id] }).catch(() => null))?.threads?.[0]?.threadKey || '';
  if (!key) return tk ? null : { threadKey: '', canImport: false, canOpen: false };
  return { threadKey: key, canImport: !!tk, canOpen: !!tk && tk.capabilities.includes('open') };
}
export async function importThreadCitation({ id = '', threadKey = '' } = {}) {
  const resolved = await resolveThreadCitation({ id, threadKey });
  if (resolved?.itemId) return resolved;
  const tk = await threadsNow();
  if (!tk || !resolved?.threadKey) throw new Error('Threadkeeper is not connected, so this thread cannot be imported now.');
  const { results } = await tk.importThreads([resolved.threadKey], { origin: 'manual' });
  const entry = results.find(result => result.threadKey === resolved.threadKey) || results[0];
  const itemId = typeof entry?.id === 'string' ? entry.id : typeof entry?.itemId === 'string' ? entry.itemId : '';
  if (!itemId || entry?.status === 'skipped') throw new Error(entry?.reason === 'invalid' ? 'Threadkeeper would not send this thread.' : 'This thread could not be imported.');
  return { itemId };
}
export async function openThreadInThreadkeeper(threadKey) {
  const tk = await threadsNow();
  if (!tk) throw new Error('Threadkeeper is not connected.');
  await tk.open(threadKey);
}
export const transformText = options => engine().transforms.transformText(options);
export const suggestForSave = input => engine().transforms.suggestForSave(input);
/** AI auto-tagging plan for review (lib/ai/autotag.js); apply it with finalizePlan + store.bulkUpdateItems. */
export const planAutoTags = options => engine().autotag.planAutoTags(options);
export { finalizePlan as finalizeAutoTags } from './autotag.js';
export const searchLibrary = (query, options) => engine().search.searchLibrary(query, options);
/** The fast model file imports use (or null when no AI is connected), and the import itself; see imports.js. */
export const importTarget = () => engine().imports.importTarget();
export const importDocument = (converted, options) => engine().imports.importDocument(converted, options);
export const relatedItems = (itemId, options) => engine().search.relatedItems(itemId, options);

export const getIndexStatus = () => engine().indexer.getIndexStatus();
export const subscribeIndex = listener => engine().indexer.subscribeIndex(listener);
export const startIndexing = () => engine().indexer.startIndexing();
export const rebuildIndex = () => engine().indexer.rebuildIndex();
export const clearIndex = () => engine().indexer.clearIndex();
export const pauseIndexing = () => engine().indexer.pauseIndexing();

/**
 * The research agent (Claude Managed Agents), see lib/ai/research/run.js. Runs are driven by the page that starts or
 * resumes them and mirrored into an assistant conversation (kind 'research') that every view renders from storage.
 * researchAvailability() -> { available, code?, reason?, connectionId? }
 * startResearch({ itemId, instructions, allowOriginalEdits }) -> { conversationId, done, existing? }
 * continueResearch(conversationId, text) -> { conversationId, done }      resumeResearch(conversationId) -> { resumed, reason?, done? }
 * stopResearch(conversationId)      raiseResearchBudget(conversationId, budgetUsd)      undoResearch(conversationId)
 * subscribeResearch(listener) -> unsubscribe (live events for runs this page drives)      resetResearchProvisioning()
 */
export const researchAvailability = () => researchEngine().researchAvailability();
export const startResearch = options => researchEngine().startResearch(options);
export const continueResearch = (conversationId, text) => researchEngine().continueResearch(conversationId, text);
export const resumeResearch = conversationId => researchEngine().resumeResearch(conversationId);
export const stopResearch = conversationId => researchEngine().stopResearch(conversationId);
export const raiseResearchBudget = (conversationId, budgetUsd) => researchEngine().raiseResearchBudget(conversationId, budgetUsd);
export const undoResearch = conversationId => researchEngine().undoResearch(conversationId);
export const subscribeResearch = listener => researchEngine().subscribeResearch(listener);
export const resetResearchProvisioning = () => researchEngine().resetResearchProvisioning();

export const listConversations = () => engine().conversations.listConversations();
export const getConversation = id => engine().conversations.getConversation(id);
export const saveConversation = conversation => engine().conversations.saveConversation(conversation);
export const deleteConversation = id => engine().conversations.deleteConversation(id);

/**
 * Search adapter for integrations.createIntegrationClient({ search }) (the bridge's MCP semantic_search tool).
 * opts: { limit, mode, collectionId, type, tag, favorite, archived, filter } -> { results: [{ id, title, type, url, score, snippet, source }], index }
 */
export async function semanticSearch(query, opts = {}) {
  const filter = { ...(opts.filter && typeof opts.filter === 'object' ? opts.filter : {}) };
  for (const key of ['collectionId', 'type', 'tag', 'favorite', 'archived']) if (opts[key] !== undefined && filter[key] === undefined) filter[key] = opts[key];
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(50, Math.floor(opts.limit))) : 10;
  const mode = ['hybrid', 'semantic', 'lexical'].includes(opts.mode) ? opts.mode : 'hybrid';
  const results = await searchLibrary(typeof query === 'string' ? query : '', { limit, mode, filter });
  return { results: results.map(({ id, title, type, url, score, snippet, source }) => ({ id, title, type, url, score, snippet, source })), index: getIndexStatus() };
}

/** Companion for createIntegrationClient({ searchAvailable }): true when the semantic index can answer MCP semantic_search. */
export async function semanticSearchAvailable() {
  if (!services) return false;
  return getIndexStatus().enabled && (await services.indexer.isReady());
}

/**
 * Called once from app.js: init({ store, getLibrary, integrations, onLibraryChange, dashboard, threads, external, browser }).
 * threads (optional): lib/ai/threads.js threadSources(); it gives the assistant the chats saved in Still and, while Still is
 * paired with Threadkeeper, the thread tools and automatic thread context.
 * onLibraryChange(listener) -> unsubscribe defaults to store.subscribe. Indexing starts shortly after boot when enabled.
 * dashboard (optional): { describe(), addCollectionWidget({ collectionId, boardId }), removeWidget(widgetId) }; it lets the
 * assistant see the dashboard and show a collection on it. Without it those tools are not offered.
 * external (optional): the assistant's read-only external tool providers (see tools.js createToolSession); the default is
 * Paperclip (paperclip-tools.js), offered only while Paperclip is connected. Pass [] or null to offer none.
 * browser (optional): () -> a browser client (browser-client.js createBrowserClient) for one turn; the default connects
 * to the service worker's browser host. Pass null to go back to the default.
 */
export function init({ store: appStore, getLibrary, integrations, onLibraryChange, dashboard, threads, external, browser } = {}) {
  runtime.dispose?.();
  if (external !== undefined) runtime.external = Array.isArray(external) ? external.filter(Boolean) : [];
  if (browser !== undefined) runtime.browserClient = typeof browser === 'function' ? browser : null;
  if (appStore) runtime.store = appStore;
  if (dashboard !== undefined) runtime.dashboard = dashboardAdapter(dashboard);
  if (threads !== undefined) runtime.threadSources = threadSourcesAdapter(threads);
  if (typeof getLibrary === 'function') runtime.getLibrary = getLibrary;
  if (typeof integrations?.requestBridge === 'function') runtime.requestBridge = integrations.requestBridge;
  if (integrations) connections.configureConnections({ integrations });
  // The bridge's MCP semantic_search is answered from this view's index (integrations.setBridgeSearch from app.js's namespace).
  const bridgeSearch = typeof integrations?.setBridgeSearch === 'function' ? integrations.setBridgeSearch : null;
  bridgeSearch?.(semanticSearch, { available: semanticSearchAvailable });
  const { indexer } = engine();
  const subscribe = typeof onLibraryChange === 'function' ? onLibraryChange : typeof runtime.store?.subscribe === 'function' ? runtime.store.subscribe : null;
  const unsubscribe = subscribe?.(library => {
    if (!runtime.getLibrary && library) runtime.snapshot = library;
    indexer.onLibraryChange(library);
  });
  const offConnections = typeof connections.onConnectionsChanged === 'function' ? connections.onConnectionsChanged(() => indexer.refresh().catch(error => console.error(error))) : null;
  let timer = null;
  const warmTimer = setTimeout(() => services?.search.warm().catch(error => console.error(error)), 3000);
  const ready = indexer.refresh({ start: false }).catch(error => { console.error(error); return indexer.getIndexStatus(); })
    .then(status => { if (status.enabled) timer = setTimeout(() => indexer.refresh().catch(error => console.error(error)), 1500); return status; });
  runtime.dispose = () => { clearTimeout(timer); clearTimeout(warmTimer); bridgeSearch?.(null); if (typeof unsubscribe === 'function') unsubscribe(); if (typeof offConnections === 'function') offConnections(); indexer.dispose(); services = null; };
  return { ready, dispose: () => { runtime.dispose?.(); runtime.dispose = null; } };
}
