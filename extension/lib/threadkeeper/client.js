/*
 * The Threadkeeper link for extension pages (settings, chat pages, picker, assistant). Preview-safe: nothing touches
 * `chrome` at import time, and without the extension every call resolves to a calm "unavailable" state or throws
 * ThreadkeeperError('unavailable', 'Threadkeeper works when Still runs as an extension.').
 *
 * Everything except reading the state goes through the service worker (message type 'still:threadkeeper' { op, args }),
 * which owns pairing, the paired id check, validation and every write. Errors arrive as ThreadkeeperError with a `code`
 * (protocol codes plus 'unreachable' and 'unavailable') and a message written for the user.
 *
 *   getThreadkeeperState()                 → public state (a copy; `available` is false outside the extension)
 *   onThreadkeeperChange(fn)               → unsubscribe
 *   discoverThreadkeeper()                 → [{ id, name, version, enabled, installType }]  (needs the optional
 *                                            'management' grant requested in the click; removes it again afterwards)
 *   connectThreadkeeper(extensionId)       → { status: 'pending', code } | { status: 'paired' }
 *   cancelThreadkeeperPairing()            → { status }
 *   pingThreadkeeper()                     → { reachable, version?, tk?, code? }   (liveness; also warms Threadkeeper)
 *   disconnectThreadkeeper({ removeChats }) → { removed, kept }
 *   setThreadkeeperPrefs(patch)            → state
 *   startThreadkeeperSync(patch?)          → { queued, total, retrying }   ("Start syncing": configured, sync.configure)
 *   syncThreadkeeperNow()                  → { queued }
 *   threadkeeperRequest(type, fields, { timeoutMs, signal }) → response data (reads, thread.open, threads.analyze)
 *   importThreadkeeperThreads(threadKeys, { target, origin = 'manual', citeIds }) → { results, created, updated, unchanged, skipped }
 *   refreshChat(id)                        → { threadKey, status, ... }
 *   loadTranscriptWindow(id, from, count)  → { revision, totalMessages, messages, stored, stale, truncated }
 *   undoThreadkeeperImport(ids)            → { deleted }     (assistant undo: deletes without dismissing)
 *   threadkeeperImpact({ patch } | { disconnect: true }) → counts for confirmations
 *   replaceThreadkeeperChats()             → { moved }       (re-place untouched chats after a placement change)
 *   removeThreadkeeperTranscripts()        → { removed }
 *   isThreadkeeperReady(state)             → boolean (status 'paired')
 *   hasThreadkeeperCapability(state, cap)  → boolean
 */
import { ThreadkeeperError, errorText } from './protocol.js';
import { DEFAULT_PREFS, STATE_KEY, normalizeThreadkeeperState, publicState } from './state.js';

export const THREADKEEPER_MESSAGE = 'still:threadkeeper';
const chromeApi = () => globalThis.chrome;
const inExtension = () => !!chromeApi()?.runtime?.id && typeof chromeApi().runtime.sendMessage === 'function' && !!chromeApi().storage?.local;
const unavailable = () => new ThreadkeeperError('unavailable', errorText('unavailable'));
const OFF = () => ({ ...publicState(normalizeThreadkeeperState({ prefs: DEFAULT_PREFS }), { available: false }) });

async function call(op, args = {}, { signal } = {}) {
  if (!inExtension()) throw unavailable();
  if (signal?.aborted) throw new ThreadkeeperError('aborted', 'Stopped.');
  const sending = chromeApi().runtime.sendMessage({ type: THREADKEEPER_MESSAGE, op, args });
  const response = await (signal ? Promise.race([sending, new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new ThreadkeeperError('aborted', 'Stopped.')), { once: true });
  })]) : sending);
  if (!response?.ok) throw new ThreadkeeperError('internal', response?.error || 'Still could not reach its background worker. Reload the extension.');
  const result = response.result;
  if (!result?.ok) {
    const error = result?.error || {};
    throw new ThreadkeeperError(error.code || 'internal', error.message || errorText(error.code), { retryAfterMs: error.retryAfterMs });
  }
  return result.data;
}

/** The current link state, read straight from storage (no worker round trip). */
export async function getThreadkeeperState() {
  if (!inExtension()) return OFF();
  try {
    const stored = (await chromeApi().storage.local.get(STATE_KEY))?.[STATE_KEY];
    return publicState(stored, { available: true });
  } catch {
    return publicState({}, { available: true });
  }
}

export function onThreadkeeperChange(fn) {
  const events = inExtension() ? chromeApi().storage?.onChanged : null;
  if (!events?.addListener || typeof fn !== 'function') return () => {};
  const listener = (changes, area) => {
    if (area !== 'local' || !changes?.[STATE_KEY]) return;
    try { fn(publicState(changes[STATE_KEY].newValue, { available: true })); } catch (error) { console.warn('Still Threadkeeper listener:', error?.message); }
  };
  events.addListener(listener);
  return () => events.removeListener?.(listener);
}

/**
 * Installed extensions that look like Threadkeeper. The caller requests { permissions: ['management'] } synchronously in
 * the click handler first; this removes the grant again when it is done.
 */
export async function discoverThreadkeeper() {
  if (!inExtension()) throw unavailable();
  const chrome = chromeApi();
  if (typeof chrome.management?.getAll !== 'function') throw new ThreadkeeperError('no_permission', 'Allow Still to see your extensions, or paste Threadkeeper’s ID instead.');
  try {
    const all = await chrome.management.getAll();
    return (Array.isArray(all) ? all : [])
      .filter(entry => entry && entry.type === 'extension' && entry.id !== chrome.runtime.id && /^[a-p]{32}$/.test(entry.id) && /threadkeeper/i.test(entry.name || ''))
      .map(entry => ({ id: entry.id, name: String(entry.name).slice(0, 80), version: String(entry.version || '').slice(0, 40), enabled: entry.enabled === true,
        installType: String(entry.installType || '').slice(0, 20) }))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  } finally {
    try { await chrome.permissions?.remove?.({ permissions: ['management'] }); } catch { /* Already gone. */ }
  }
}

export const connectThreadkeeper = extensionId => call('connect', { extensionId });
export const cancelThreadkeeperPairing = () => call('cancel');
export const pingThreadkeeper = () => call('ping');
export const disconnectThreadkeeper = ({ removeChats = false } = {}) => call('disconnect', { removeChats: removeChats === true });
export const setThreadkeeperPrefs = patch => call('setPrefs', { patch });
export const startThreadkeeperSync = patch => call('startSync', patch === undefined ? {} : { patch });
export const syncThreadkeeperNow = () => call('syncNow');
export const threadkeeperRequest = (type, fields = {}, { timeoutMs, signal } = {}) => call('request', { type, fields, timeoutMs }, { signal });
export const importThreadkeeperThreads = (threadKeys, { target = null, origin = 'manual', citeIds = [] } = {}) =>
  call('importThreads', { threadKeys: Array.isArray(threadKeys) ? threadKeys : [], citeIds, target, origin });
export const refreshChat = id => call('refreshChat', { id });
export const loadTranscriptWindow = (id, from = 0, count = 200) => call('loadTranscriptWindow', { id, from, count });
export const undoThreadkeeperImport = ids => call('undoImport', { ids });
export const threadkeeperImpact = (options = {}) => call('impact', options);
export const replaceThreadkeeperChats = () => call('replaceChats');
export const removeThreadkeeperTranscripts = () => call('removeTranscripts');
export const isThreadkeeperReady = state => state?.status === 'paired';
export const hasThreadkeeperCapability = (state, capability) => isThreadkeeperReady(state) && Array.isArray(state?.tk?.capabilities) && state.tk.capabilities.includes(capability);
