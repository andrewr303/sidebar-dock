import * as libraryStore from './store.js';

export const INTEGRATION_STORAGE_KEY = 'still.integrations.v1';
export const RAINDROP_MCP_URL = 'https://api.raindrop.io/rest/v2/ai/mcp';
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:43123';
export const INTEGRATION_CATALOG = [
  { id: 'claude', name: 'Claude', category: 'AI', description: 'Search your library and write connected notes through local MCP.', url: 'https://help.raindrop.io/integrations/claude', local: true },
  { id: 'codex', name: 'Codex', category: 'AI', description: 'Give your coding agent the context you have collected.', url: 'https://developers.openai.com/codex/mcp/', local: true },
  { id: 'raindrop', name: 'Raindrop.io', category: 'Library', description: 'Import collections, saved links, notes and highlights with your API token.', url: 'https://app.raindrop.io/settings/integrations', local: true },
  { id: 'notion', name: 'Notion', category: 'Knowledge', description: 'Explore Raindrop’s documented Notion integration.', url: 'https://help.raindrop.io/integrations/notion' },
  { id: 'readwise', name: 'Readwise', category: 'Reading', description: 'Explore Raindrop’s documented Readwise integration.', url: 'https://help.raindrop.io/integrations/readwise' },
  { id: 'zapier', name: 'Zapier', category: 'Automation', description: 'Explore Raindrop’s documented automation integration.', url: 'https://help.raindrop.io/integrations/zapier' },
  { id: 'make', name: 'Make', category: 'Automation', description: 'Explore Raindrop’s documented automation integration.', url: 'https://help.raindrop.io/integrations/make' },
  { id: 'n8n', name: 'n8n', category: 'Automation', description: 'Explore Raindrop’s documented automation integration.', url: 'https://help.raindrop.io/integrations/n8n' },
  { id: 'drive', name: 'Google Drive', category: 'Backup', description: 'Export a Still JSON backup and save it to your own Drive.', url: 'https://drive.google.com/' },
  { id: 'dropbox', name: 'Dropbox', category: 'Backup', description: 'Export a Still JSON backup and save it to your own Dropbox.', url: 'https://www.dropbox.com/' },
  { id: 'rss', name: 'RSS', category: 'Reading', description: 'Explore Raindrop’s documented RSS collection feeds.', url: 'https://help.raindrop.io/integrations/rss' },
];

const defaultStorage = {
  async read() {
    if (globalThis.chrome?.storage?.local) return (await chrome.storage.local.get(INTEGRATION_STORAGE_KEY))[INTEGRATION_STORAGE_KEY] || {};
    const value = globalThis.localStorage?.getItem(INTEGRATION_STORAGE_KEY);
    return value ? JSON.parse(value) : {};
  },
  async write(value) {
    if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({ [INTEGRATION_STORAGE_KEY]: value });
    else if (globalThis.localStorage) localStorage.setItem(INTEGRATION_STORAGE_KEY, JSON.stringify(value));
    else throw new Error('Persistent local storage is unavailable.');
  },
};

function bridgeUrl(value = DEFAULT_BRIDGE_URL) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a loopback bridge URL such as http://127.0.0.1:43123.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('The bridge must use an http loopback address with no path or credentials.');
  }
  return url.origin;
}

function publicSnapshot(state) {
  // Only the library is shared. Device credentials, preferences and file bytes stay local; inline images (data: covers
  // and page icons) stay out of the snapshot too, and so do chats whose thread became private in Threadkeeper.
  return { schemaVersion: 1, items: state.items.filter(item => !(item.type === 'chat' && item.chat?.removed === 'local_only')).map(({ attachmentId, ...item }) => ({ ...item, cover: /^data:/i.test(item.cover || '') ? '' : item.cover,
    ...(/^data:/i.test(item.icon || '') ? { icon: '' } : {}) })), collections: state.collections, updatedAt: state.updatedAt };
}

export function mapRaindropLibrary(collections, items) {
  const collectionIds = new Set(collections.map(collection => Number(collection._id)).filter(id => id > 0));
  return {
    schemaVersion: 1,
    collections: collections.filter(collection => Number(collection._id) > 0).map(collection => ({
      id: `raindrop-${collection._id}`, name: collection.title || 'Imported collection', color: collection.color || '#8fadd2', icon: 'folder',
      parentId: collectionIds.has(collection.parent?.$id) ? `raindrop-${collection.parent.$id}` : '',
    })),
    items: items.map(item => ({
      id: `raindrop-${item._id}`, type: ['article', 'image', 'video', 'file'].includes(item.type) ? item.type : 'bookmark',
      title: item.title || item.link, url: item.link, excerpt: item.excerpt || '', content: item.note || '',
      tags: item.tags || [], collectionId: collectionIds.has(item.collection?.$id) ? `raindrop-${item.collection.$id}` : '',
      favorite: item.important === true, createdAt: item.created, updatedAt: item.lastUpdate, cover: item.cover || '', relatedIds: [],
      highlights: (item.highlights || []).map(highlight => ({ id: String(highlight._id || crypto.randomUUID()), text: highlight.text, color: highlight.color || 'yellow', createdAt: highlight.created, url: item.link, note: highlight.note || '' })),
    })),
    settings: {},
  };
}

// search(query, { limit, type, collectionId, tag }) -> { results: [{ id, title, type, url, score, snippet }], index } answers MCP semantic_search
// from the extension's embedding index; searchAvailable() reports whether that index is enabled so the bridge can advertise it.
export function createIntegrationClient({ storage = defaultStorage, fetch: fetcher = globalThis.fetch?.bind(globalThis), store = libraryStore, search, searchAvailable } = {}) {
  let pendingAcks = [];
  let syncPromise;
  let searchHook = typeof search === 'function' ? search : null;
  let searchReady = typeof searchAvailable === 'function' ? searchAvailable : null;
  function setSearch(fn, { available } = {}) {
    searchHook = typeof fn === 'function' ? fn : null;
    searchReady = typeof available === 'function' ? available : null;
  }
  async function semanticSearchAdvertised() {
    if (!searchHook) return false;
    if (!searchReady) return true;
    try { return (await searchReady()) === true; } catch { return false; }
  }
  const request = async (url, options = {}) => {
    const response = await fetcher(url, { ...options, signal: options.signal || AbortSignal.timeout(15000), cache: 'no-store' });
    let data;
    try { data = await response.json(); } catch { throw new Error(`Integration returned an unreadable response (HTTP ${response.status}).`); }
    if (!response.ok || data.result === false || data.error) throw new Error(data.error?.message || data.error || `Integration request failed (HTTP ${response.status}).`);
    return data;
  };
  const getIntegrationSettings = async () => {
    const state = await storage.read();
    return { raindropConfigured: !!state.raindropToken, raindropConnectedAt: state.raindropConnectedAt || null, bridgeUrl: state.bridgeUrl || DEFAULT_BRIDGE_URL, bridgeConfigured: !!state.bridgeToken, bridgeEnabled: state.bridgeEnabled === true, lastBridgeSyncAt: state.lastBridgeSyncAt || null };
  };
  const update = async patch => { const next = { ...await storage.read(), ...patch }; await storage.write(next); return getIntegrationSettings(); };
  const raindropRequest = async (path, options = {}) => {
    const state = await storage.read();
    if (!state.raindropToken) throw new Error('Add your Raindrop API token first.');
    return request(`https://api.raindrop.io/rest/v1${path}`, { ...options, headers: { Authorization: `Bearer ${state.raindropToken}`, 'Content-Type': 'application/json', ...options.headers } });
  };
  async function setRaindropToken(token) {
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('Paste a valid Raindrop API token.');
    return update({ raindropToken: token.trim(), raindropConnectedAt: null });
  }
  async function testRaindropConnection() {
    const data = await raindropRequest('/collections');
    if (!Array.isArray(data.items)) throw new Error('Raindrop did not return a collection list.');
    await update({ raindropConnectedAt: new Date().toISOString() });
    return { ok: true, rootCollections: data.items.length };
  }
  async function importFromRaindrop({ onProgress = () => {} } = {}) {
    const [roots, children] = await Promise.all([raindropRequest('/collections'), raindropRequest('/collections/childrens')]);
    if (!Array.isArray(roots.items) || !Array.isArray(children.items)) throw new Error('Raindrop returned an invalid collection list.');
    const collections = [...new Map([...roots.items, ...children.items].map(c => [c._id, c])).values()];
    const items = [];
    for (let page = 0; ; page++) {
      const data = await raindropRequest(`/raindrops/0?perpage=50&page=${page}&sort=-created`);
      if (!Array.isArray(data.items)) throw new Error('Raindrop returned an invalid bookmark page. Your local library has not been changed.');
      items.push(...data.items); onProgress({ items: items.length, page });
      if (data.items.length < 50) break;
    }
    await store.importLibrary(mapRaindropLibrary(collections, items));
    await update({ raindropConnectedAt: new Date().toISOString() });
    return { items: items.length, collections: collections.length };
  }
  async function sendToRaindrop(item) {
    if (!item || !/^https?:\/\//i.test(item.url || '')) throw new Error('Only items with a web URL can be sent to Raindrop.');
    const collectionId = /^raindrop-(\d+)$/.exec(item.collectionId || '')?.[1];
    const payload = { link: item.url, title: item.title, excerpt: item.excerpt, note: item.content, tags: item.tags || [], important: !!item.favorite,
      collection: { $id: collectionId ? Number(collectionId) : -1 }, highlights: (item.highlights || []).map(({ text, color, note }) => ({ text, color, note })) };
    const remoteId = /^raindrop-(\d+)$/.exec(item.id || '')?.[1];
    const data = await raindropRequest(remoteId ? `/raindrop/${remoteId}` : '/raindrop', { method: remoteId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    return { ok: true, id: data.item?._id, item: data.item };
  }
  async function configureBridge({ url = DEFAULT_BRIDGE_URL, token, enabled = true }) {
    if (typeof token !== 'string' || token.trim().length < 24 || /[\r\n]/.test(token)) throw new Error('Paste the bridge token from bridge/.local/config.json.');
    return update({ bridgeUrl: bridgeUrl(url), bridgeToken: token.trim(), bridgeEnabled: !!enabled, lastBridgeSyncAt: null });
  }
  async function applyCommand(command) {
    const args = command.args || {};
    if (command.operation === 'saveItem') return store.saveItem(args);
    const revision = args.expectedUpdatedAt ? { expectedUpdatedAt: args.expectedUpdatedAt } : {};
    if (command.operation === 'updateItem') return store.updateItem(args.id, args.patch, revision);
    if (command.operation === 'deleteItem') return store.deleteItem(args.id, revision);
    if (command.operation === 'restoreItem') return store.restoreItem(args.id, revision);
    if (command.operation === 'permanentlyDeleteItem') {
      const before = await store.loadLibrary(), previous = before.items.find(i => i.id === args.id);
      // Deleting a page from Trash also deletes the subpages trashed with it, so a later command for one of them finds
      // it gone already: the outcome the agent asked for.
      if (!previous) return { id: args.id, ids: [], attachmentIds: [], alreadyDeleted: true };
      let result;
      try { result = await store.permanentlyDeleteItem(args.id, revision); }
      catch (error) { if (/no longer exists/i.test(error?.message || '')) return { id: args.id, ids: [], attachmentIds: [], alreadyDeleted: true }; throw error; }
      // The store names the file blobs nothing uses any more (this item's and those of subpages deleted with it).
      const files = Array.isArray(result?.attachmentIds) ? result.attachmentIds
        : previous.attachmentId && !(await store.loadLibrary()).items.some(i => i.attachmentId === previous.attachmentId) ? [previous.attachmentId] : [];
      if (!files.length) return result;
      const cleanup = await Promise.allSettled(files.map(id => store.deleteAttachment(id)));
      if (cleanup.every(outcome => outcome.status === 'fulfilled')) return { ...result, fileCleanup: 'complete' };
      return { ...result, fileCleanup: 'failed', warning: 'The item was permanently deleted, but its local file bytes could not be removed. Review device storage before claiming full file erasure.' };
    }
    if (command.operation === 'movePage') return store.movePage(args.id, { parentId: args.parentId, ...revision });
    if (command.operation === 'updateCollection') return store.updateCollection(args.id, args.patch, revision);
    if (command.operation === 'deleteCollection') return store.deleteCollection(args.id, revision);
    if (command.operation === 'mutateTags') return store.mutateTags(args);
    if (command.operation === 'readAttachment') {
      const library = await store.loadLibrary();
      const item = library.items.find(i => i.id === args.itemId && !i.deletedAt);
      if (!item?.attachmentId) throw new Error('This item has no original file on this device.');
      const file = await store.getAttachment(item.attachmentId);
      if (!file) throw new Error('Original file bytes are missing from this device.');
      const offset = args.offset ?? 0, length = args.length ?? 65536;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.blob.size || !Number.isSafeInteger(length) || length < 1 || length > 65536) throw new Error('Choose a valid file byte range of up to 65,536 bytes.');
      const bytes = new Uint8Array(await file.blob.slice(offset, offset + length).arrayBuffer());
      const base64 = btoa(String.fromCharCode(...bytes));
      return { base64, mime: file.mime, name: file.name, size: file.blob.size, offset, nextOffset: offset + bytes.length, complete: offset + bytes.length >= file.blob.size };
    }
    if (command.operation === 'createCollection') {
      const state = await store.loadLibrary();
      return state.collections.find(c => c.id === args.id) || store.createCollection(args);
    }
    if (command.operation === 'bulkUpdateItems') {
      const items = await store.bulkUpdateItems(args.updates, args.expectedLibraryUpdatedAt ? { expectedLibraryUpdatedAt: args.expectedLibraryUpdatedAt } : {});
      return { updated: items.length, items: items.map(({ id, updatedAt, collectionId, tags, favorite, archived, pinned, read, reminderAt }) => ({ id, updatedAt, collectionId, tags, favorite, archived, pinned, read, reminderAt })) };
    }
    if (command.operation === 'semanticSearch') {
      if (!searchHook) throw new Error('Semantic search is not enabled in Still.');
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 10;
      const output = await searchHook(String(args.query || ''), { limit, type: args.type, collectionId: args.collectionId, tag: args.tag });
      const results = (Array.isArray(output?.results) ? output.results : []).slice(0, limit).map(result => ({
        id: String(result.id), title: String(result.title || ''), type: String(result.type || ''), url: String(result.url || ''),
        score: Number.isFinite(result.score) ? result.score : null, snippet: String(result.snippet || '').slice(0, 1000),
      }));
      return { results, index: output?.index && typeof output.index === 'object' ? output.index : null };
    }
    throw new Error('Unsupported bridge command.');
  }
  async function performSync() {
    const settings = await storage.read();
    if (!settings.bridgeEnabled || !settings.bridgeToken) throw new Error('Configure and enable the local bridge first.');
    const url = bridgeUrl(settings.bridgeUrl);
    const post = async () => request(`${url}/sync`, { method: 'POST', headers: { Authorization: `Bearer ${settings.bridgeToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ library: publicSnapshot(await store.loadLibrary()), acknowledgements: pendingAcks, semanticSearch: await semanticSearchAdvertised() }) });
    const data = await post(); pendingAcks = [];
    let changed = false;
    for (const command of data.commands || []) {
      try { const result = await applyCommand(command); pendingAcks.push({ id: command.id, result }); changed = changed || !['readAttachment', 'semanticSearch'].includes(command.operation); }
      catch (error) { pendingAcks.push({ id: command.id, error: error.message }); }
    }
    if (pendingAcks.length) { await post(); pendingAcks = []; }
    // Avoid writing settings on every poll: live status belongs to the caller.
    return { connected: true, syncedAt: data.syncedAt, pending: data.pending || 0, changed };
  }
  async function syncBridgeOnce() {
    if (syncPromise) return syncPromise;
    const run = () => performSync();
    syncPromise = (globalThis.navigator?.locks ? navigator.locks.request('still.bridge.sync.v1', run) : run()).finally(() => { syncPromise = null; });
    return syncPromise;
  }
  function startBridgeSync({ onStatus = () => {}, onChange = () => {}, interval = 2000 } = {}) {
    let stopped = false;
    let timer;
    const tick = async () => {
      try { const status = await syncBridgeOnce(); if (!stopped) { onStatus(status); if (status.changed) onChange(); } }
      catch (error) { if (!stopped) onStatus({ connected: false, error: error.message }); }
      if (!stopped) timer = setTimeout(tick, Math.max(1000, interval));
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }
  return { getIntegrationSettings, setRaindropToken, testRaindropConnection, importFromRaindrop, sendToRaindrop, configureBridge, syncBridgeOnce, startBridgeSync, setSearch,
    disconnectRaindrop: () => update({ raindropToken: '', raindropConnectedAt: null }),
    disconnectBridge: () => update({ bridgeToken: '', bridgeEnabled: false, lastBridgeSyncAt: null }),
  };
}

const client = createIntegrationClient();
export const getIntegrationSettings = (...args) => client.getIntegrationSettings(...args);
export const setRaindropToken = (...args) => client.setRaindropToken(...args);
export const disconnectRaindrop = (...args) => client.disconnectRaindrop(...args);
export const testRaindropConnection = (...args) => client.testRaindropConnection(...args);
export const importFromRaindrop = (...args) => client.importFromRaindrop(...args);
export const sendToRaindrop = (...args) => client.sendToRaindrop(...args);
export const configureBridge = (...args) => client.configureBridge(...args);
export const disconnectBridge = (...args) => client.disconnectBridge(...args);
export const syncBridgeOnce = (...args) => client.syncBridgeOnce(...args);
export const startBridgeSync = (...args) => client.startBridgeSync(...args);
export const setBridgeSearch = (...args) => client.setSearch(...args);
export async function requestBridge(path, { method = 'GET', body, signal, onEvent } = {}) {
  if (typeof path !== 'string' || !/^\/(?:ai|connections|github)(?:\/|$)/.test(path) || path.includes('..') || /[\r\n#]/.test(path)) throw new Error('Unsupported bridge route.');
  const settings = await defaultStorage.read();
  if (!settings.bridgeToken) throw new Error('Pair the local bridge first to connect your AI tools.');
  const response = await fetch(bridgeUrl(settings.bridgeUrl) + path, { method, signal: signal || AbortSignal.timeout(300000), cache: 'no-store', redirect: 'error', headers: { Authorization: `Bearer ${settings.bridgeToken}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) { let data;try { data = await response.json(); } catch {} throw new Error(typeof data?.error === 'string' ? data.error : data?.error?.message || `Bridge returned HTTP ${response.status}.`); }
  if (!onEvent) return response.json();
  if (!response.body) throw new Error('The AI bridge returned no response stream.');
  const reader = response.body.getReader(), decoder = new TextDecoder();let buffer = '', completed = false, result, partialText = '';
  const consume = line => { if (!line.trim()) return;const event = JSON.parse(line);if (event.type === 'delta') partialText += event.text || '';onEvent(event);if (event.type === 'error') { const error = new Error(event.message || 'AI request failed.');error.partialText = event.partialText || partialText;error.aborted = !!event.aborted;if (event.stopReason) error.stopReason = event.stopReason;throw error; }if (event.type === 'done') { completed = true;result = event; } };
  try { for (;;) { const { value, done } = await reader.read();if (done) break;buffer += decoder.decode(value, { stream: true });if (buffer.length > 4 * 1024 * 1024) throw new Error('AI response exceeded the local stream limit.');let index;while ((index = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, index));buffer = buffer.slice(index + 1); } }buffer += decoder.decode();if (buffer.trim()) consume(buffer);if (!completed) { const error = new Error('The AI response ended before completion. The partial answer was kept.');error.partialText = partialText;throw error; }return result; }
  finally { await reader.cancel().catch(() => {});reader.releaseLock(); }
}
// Pass GET /ai/providers runtime.projectRoot and runtime.nodePath so these snippets match the entries the bridge
// writes itself (absolute node, OS path separators); otherwise a placeholder root and `node` from PATH are shown.
export function getMcpSetup(root = '', { nodePath = '' } = {}) {
  const known = typeof root === 'string' && !!root.trim();
  const base = known ? root.trim().replace(/[\\/]+$/, '') : '/path/to/sidebar-dock';
  const sep = /\\/.test(base) && !base.includes('/') ? '\\' : '/';
  const file = (...parts) => [base, ...parts].join(sep);
  const entry = file('bridge', 'mcp.mjs');
  const node = typeof nodePath === 'string' && nodePath.trim() ? nodePath.trim() : 'node';
  const nodeArg = node === 'node' ? 'node' : `"${node}"`;
  return {
    rootKnown: known,
    entry, node,
    start: `${nodeArg} "${file('bridge', 'server.mjs')}"`,
    configPath: file('bridge', '.local', 'config.json'),
    claudeCommand: `claude mcp add --transport stdio --scope user still -- ${nodeArg} "${entry}"`,
    codexCommand: `codex mcp add still -- ${nodeArg} "${entry}"`,
    claude: JSON.stringify({ mcpServers: { still: { command: node, args: [entry] } } }, null, 2),
    claudeDesktop: JSON.stringify({ mcpServers: { still: { command: node, args: [entry] } } }, null, 2),
    cursor: JSON.stringify({ mcpServers: { still: { type: 'stdio', command: node, args: [entry] } } }, null, 2),
    // VS Code's mcp.json uses a top-level `servers` key rather than `mcpServers`.
    vscode: JSON.stringify({ servers: { still: { type: 'stdio', command: node, args: [entry] } } }, null, 2),
    codex: `[mcp_servers.still]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(entry)}]\n`,
    connectCommand: 'npm run connect -- claude',
    raindropMcp: RAINDROP_MCP_URL,
  };
}
