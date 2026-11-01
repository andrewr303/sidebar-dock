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
import { undoChanges } from './tools.js';
import { createTransforms } from './transforms.js';
import { createConversationStore } from './conversations.js';
import { createImports } from './imports.js';
import { getProvider as catalogProvider } from './catalog.js';

export { CATALOG, EFFORT_LEVELS, ANTHROPIC_EFFORTS, EFFORT_LABELS, getProvider, chatProviders, embeddingProviders } from './catalog.js';
export { listConnections, saveConnection, deleteConnection, testConnection, listModels, getAiSettings, onConnectionsChanged, ensureHostPermission,
  hostPermissionOrigins, resolveChatTarget, getBridgeStatus, pairBridge, cliSignInStatus, startChatGptSignIn, chatGptSignInStatus, cancelChatGptSignIn,
  DEFAULT_AI_SETTINGS } from './connections.js';
export { streamChat } from './chat.js';
export { handoffUrl, buildHandoffPrompt, handoffPlan, HANDOFF_TARGETS } from './handoff.js';

const runtime = { store: libraryStore, getLibrary: null, snapshot: null, requestBridge, dispose: null, dashboard: null };
let services = null;

async function currentLibrary() {
  if (runtime.getLibrary) return runtime.getLibrary();
  return runtime.snapshot ||= await runtime.store.loadLibrary();
}
// Resolved at call time so init() can swap in the app's store (ctx.store) after the engine was created. These are the
// lib/store.js operations the assistant's proposals apply and undo with; loadLibrary is the worker's authoritative copy,
// read while the app's snapshot still lags behind a change the assistant just applied.
const STORE_METHODS = ['bulkUpdateItems', 'createCollection', 'saveItem', 'deleteItem', 'deleteCollection', 'updateItem', 'restoreItem', 'permanentlyDeleteItem',
  'updateCollection', 'moveCollection', 'mutateTags', 'loadLibrary'];
const store = Object.fromEntries(STORE_METHODS.map(name => [name, (...args) => runtime.store[name](...args)]));
const dashboardAdapter = value => value && typeof value.describe === 'function' && typeof value.addCollectionWidget === 'function' ? value : null;
const aiSettings = () => connections.getAiSettings();

function engine() {
  if (services) return services;
  const conversations = createConversationStore();
  const embedder = createEmbedder({ resolveConnection: connections.resolveConnection, providerFetch, requestBridge: (...args) => runtime.requestBridge(...args) });
  const vectorStore = createVectorStore();
  const indexer = createIndexer({ vectorStore, embedder, getLibrary: currentLibrary, getSettings: aiSettings });
  const search = createSearch({ getLibrary: currentLibrary, vectorStore, isSemanticReady: () => indexer.isReady(), embedQuery: (query, options) => indexer.embedQuery(query, options) });
  const assistant = createAssistant({ streamChat: chatStream, resolveConnection: connections.resolveConnection, modelInfo: connections.modelInfo, getAiSettings: aiSettings,
    getLibrary: currentLibrary, store, searchLibrary: search.searchLibrary, conversations, dashboard: () => runtime.dashboard });
  const transforms = createTransforms({ streamChat: chatStream, resolveConnection: connections.resolveConnection, resolveChatTarget: connections.resolveChatTarget,
    getAiSettings: aiSettings, getLibrary: currentLibrary });
  const imports = createImports({ streamChat: chatStream, resolveChatTarget: connections.resolveChatTarget, resolveConnection: connections.resolveConnection, getProvider: catalogProvider });
  services = { conversations, indexer, search, assistant, transforms, imports };
  return services;
}

/** Saves AI settings; a change to `embeddings` re-reads the index configuration (and starts indexing when enabled). */
export async function setAiSettings(patch) {
  const result = await connections.setAiSettings(patch);
  if (services && patch && typeof patch === 'object' && 'embeddings' in patch) services.indexer.refresh().catch(error => console.error(error));
  return result;
}

export const runAssistant = options => engine().assistant.runAssistant(options);
/** Undoes an applied proposal from its saved plain-data record (proposal.undo), e.g. after a reload lost the live undo. */
export const undoProposal = undo => undoChanges(store, undo, { dashboard: runtime.dashboard });
export const transformText = options => engine().transforms.transformText(options);
export const suggestForSave = input => engine().transforms.suggestForSave(input);
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
 * Called once from app.js: init({ store, getLibrary, integrations, onLibraryChange, dashboard }).
 * onLibraryChange(listener) -> unsubscribe defaults to store.subscribe. Indexing starts shortly after boot when enabled.
 * dashboard (optional): { describe(), addCollectionWidget({ collectionId, boardId }), removeWidget(widgetId) }; it lets the
 * assistant see the dashboard and show a collection on it. Without it those tools are not offered.
 */
export function init({ store: appStore, getLibrary, integrations, onLibraryChange, dashboard } = {}) {
  runtime.dispose?.();
  if (appStore) runtime.store = appStore;
  if (dashboard !== undefined) runtime.dashboard = dashboardAdapter(dashboard);
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
