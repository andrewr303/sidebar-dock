// Settings → Integrations → AI chat threads (design §6, review revisions R.1/R.6/R.7): the Threadkeeper card.
// It finds Threadkeeper (optional `management` permission, asked for in the click and dropped again by the client),
// connects only after the person picks one, shows the one-time code while Threadkeeper asks for consent, then walks
// through "Choose what to sync" before anything syncs. Once syncing it keeps every preference one click away, each
// saved at once through setThreadkeeperPrefs. Pairing state lives in still.threadkeeper.v1 (device only), owned by
// lib/threadkeeper/state.js; this card only reads it through the page client and re-renders on its changes.
// Pure helpers are exported for tests (tests/settings-threadkeeper.test.mjs).
import { html, cx, plural } from '../html.js';
import { icon } from '../icons.js';
import { button, segmented, input, field, badge, checkbox, relativeDate, shortDate, fileSize, dialogFrame, spinner } from '../components.js';
import { registerActions } from '../runtime.js';
import { registerDialog } from '../overlay.js';
import { renderCollectionPickerTrigger } from '../pickers.js';
import { chatDataStats } from '../../lib/chat-data.js';
import { isExtensionId } from '../../lib/threadkeeper/protocol.js';
import { threadkeeperClient, openThreadkeeperPicker, pickerFacets, CATEGORY_LABELS } from '../threadkeeper-picker.js';
import { group, card, row, switchRow, blockRow, callout, progressBar, disclosure, disclosed, note, providerMark, isSearching, isBusy, withBusy, searchable } from './parts.js';

export const ANCHOR = 'settings-threadkeeper';
const DISCONNECT = 'threadkeeper.disconnect';
const PENDING_MS = 10 * 60 * 1000; // protocol: a pending pairing request expires after 10 minutes
const PROBE_MS = 5000;
const STALE_PROBE_MS = 60 * 1000;

/* ------------------------------------------------------------------ preferences (pure, tested) */

export const PREF_DEFAULTS = Object.freeze({
  scope: 'all', projects: [], providers: [], transcripts: true, autoUpdate: true, placement: 'mirror', parentName: 'AI chats',
  singleCollectionId: '', matchExisting: true, topicsAsTags: false, onRemoved: 'keep', defaultView: 'summary',
  assistant: Object.freeze({ search: true, context: 'auto', decision: true }),
});

const ENUMS = {
  scope: ['all', 'projects', 'manual'], placement: ['mirror', 'single', 'inbox'], onRemoved: ['keep', 'trash'], defaultView: ['summary', 'transcript'],
  'assistant.context': ['auto', 'always', 'off'],
};
const BOOLEANS = new Set(['transcripts', 'autoUpdate', 'matchExisting', 'topicsAsTags', 'assistant.search', 'assistant.decision']);
const LIST_MAX = 200;
const cleanName = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Prefs with every field present and of the right type (missing or odd values fall back to the defaults). */
export function readPrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const pick = (key, list) => (list.includes(p[key]) ? p[key] : PREF_DEFAULTS[key]);
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const list = value => (Array.isArray(value) ? [...new Set(value.filter(entry => typeof entry === 'string' && entry.trim()).map(entry => entry.trim().slice(0, 200)))].slice(0, LIST_MAX) : []);
  const a = p.assistant && typeof p.assistant === 'object' ? p.assistant : {};
  return {
    scope: pick('scope', ENUMS.scope), projects: list(p.projects), providers: list(p.providers),
    transcripts: bool(p.transcripts, true), autoUpdate: bool(p.autoUpdate, true),
    placement: pick('placement', ENUMS.placement), parentName: cleanName(p.parentName).slice(0, 80) || PREF_DEFAULTS.parentName,
    singleCollectionId: typeof p.singleCollectionId === 'string' ? p.singleCollectionId : '', matchExisting: bool(p.matchExisting, true),
    topicsAsTags: bool(p.topicsAsTags, false), onRemoved: pick('onRemoved', ENUMS.onRemoved), defaultView: pick('defaultView', ENUMS.defaultView),
    assistant: { search: bool(a.search, true), context: ENUMS['assistant.context'].includes(a.context) ? a.context : 'auto', decision: bool(a.decision, true) },
  };
}

/**
 * The patch one control writes, or null when the control or value is not one the card offers (allowlist).
 * Throws a plain-language Error for a value the person typed that cannot be used. Nested assistant prefs are written whole.
 */
export function threadkeeperPrefPatch(name, value, prefs = PREF_DEFAULTS) {
  if (typeof name !== 'string' || !Object.hasOwn(ENUMS, name) && !BOOLEANS.has(name) && !['parentName', 'singleCollectionId', 'projects', 'providers'].includes(name)) return null;
  const current = readPrefs(prefs);
  let next;
  if (Object.hasOwn(ENUMS, name)) {
    if (!ENUMS[name].includes(value)) return null;
    next = value;
  } else if (BOOLEANS.has(name)) {
    if (typeof value !== 'boolean') return null;
    next = value;
  } else if (name === 'parentName') {
    next = cleanName(value);
    if (!next) throw new Error('Give the collection for AI chats a name.');
    if (next.length > 80) throw new Error('Keep the collection name under 80 characters.');
  } else if (name === 'singleCollectionId') {
    if (typeof value !== 'string' || value.length > 200) return null;
    next = value;
  } else {
    if (!Array.isArray(value)) return null;
    next = readPrefs({ [name]: value })[name];
  }
  if (name.startsWith('assistant.')) return { assistant: { ...current.assistant, [name.slice(10)]: next } };
  return { [name]: next };
}

/** The list a checkbox toggle leaves (projects, or providers where [] means every provider). */
export function toggleListPref(list = [], value, on, { everyone = null } = {}) {
  const base = everyone && !list.length ? [...everyone] : [...list];
  const next = on ? [...new Set([...base, value])] : base.filter(entry => entry !== value);
  if (everyone && everyone.length && everyone.every(entry => next.includes(entry))) return [];
  return next;
}

/** Applies a patch to prefs (assistant merged), for drafts and previews. */
export const mergePrefs = (prefs, patch) => readPrefs({ ...readPrefs(prefs), ...patch, assistant: { ...readPrefs(prefs).assistant, ...(patch?.assistant || {}) } });

/* ------------------------------------------------------------------ state readers (pure, tested) */

export const pendingExpired = (state, now = Date.now()) => {
  const at = Date.parse(state?.pending?.at || '');
  return state?.status === 'pending' && (!Number.isFinite(at) || now - at > PENDING_MS);
};
export const isConfigured = state => state?.status === 'paired' && state.configured !== false;
/** The one-time code shown while Threadkeeper asks for consent, as "123 456" ('' when there is none). */
export function pairingCode(state) {
  const code = String(state?.pending?.code ?? state?.code ?? '');
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : '';
}
export const tkVersion = state => (/^[\w.+-]{1,40}$/.test(state?.tk?.version || '') ? state.tk.version : '');
export const hasCapability = (state, name) => Array.isArray(state?.tk?.capabilities) && state.tk.capabilities.includes(name);

/**
 * Badge for the card: { label, tone, icon, detail }. probe: { looking, reachable } where reachable is true / false /
 * null (not checked yet).
 */
export function threadkeeperStatus(state, probe = {}) {
  if (probe.looking) return { label: 'Looking for Threadkeeper…', tone: 'neutral', icon: 'search', detail: 'Checking the extensions installed in this Chrome profile.' };
  switch (state?.status) {
    case 'pending':
      return pendingExpired(state, probe.now)
        ? { label: 'Request expired', tone: 'warning', icon: 'clock', detail: 'Threadkeeper did not answer in 10 minutes. Connect again to get a new code.' }
        : { label: 'Waiting for you to allow it in Threadkeeper', tone: 'info', icon: 'hourglass', detail: 'Type the code below in the Threadkeeper window, then choose Allow.' };
    case 'paired': {
      const version = tkVersion(state);
      if (probe.reachable === false) return { label: 'Not responding', tone: 'warning', icon: 'triangle-alert', detail: 'Threadkeeper is off, updating or not running. Your chats stay available in Still.' };
      return { label: 'Connected', tone: 'success', icon: 'circle-check', detail: version ? `Threadkeeper ${version}` : 'Threadkeeper' };
    }
    case 'denied': return { label: 'Denied in Threadkeeper', tone: 'danger', icon: 'circle-alert', detail: 'Threadkeeper turned the request down.' };
    case 'revoked': return { label: 'Disconnected', tone: 'neutral', icon: 'circle-alert', detail: 'Threadkeeper ended the connection. Chats already in Still stay here and stop updating.' };
    default: return { label: 'Not connected', tone: 'neutral', icon: undefined, detail: '' };
  }
}

const isChat = item => item?.type === 'chat' && !!item.chat;
const liveChats = items => (items || []).filter(item => isChat(item) && !item.deletedAt);

/**
 * True when the person has made a chat their own (review R.6): notes, live subpages, tags beyond what sync added,
 * favorite, or moved away from where sync put it. Renames are detected by the worker (title hash); this is the
 * conservative count for confirms.
 */
export function isUserTouchedChat(item, items = []) {
  if (!isChat(item)) return false;
  if (String(item.content || '').trim() || item.favorite) return true;
  const synced = new Set((item.chat.syncedTags || []).map(tag => String(tag).toLowerCase()));
  if ((item.tags || []).some(tag => !synced.has(String(tag).toLowerCase()))) return true;
  if ((item.collectionId || '') !== (item.chat.autoCollectionId || '')) return true;
  return items.some(other => other.parentId === item.id && !other.deletedAt);
}

/** Whether a synced thread falls inside prefs (scope, projects, providers). */
export function inScope(chat, prefs) {
  const p = readPrefs(prefs);
  if (p.scope === 'manual') return false;
  if (p.providers.length && !p.providers.includes(chat?.provider)) return false;
  if (p.scope === 'projects') return p.projects.some(name => name.toLowerCase() === String(chat?.project || '').toLowerCase());
  return true;
}

/**
 * Chats that sync brought in and that the new prefs leave out: { leaving, untouched } (untouched ones move to Trash when
 * "When a thread leaves Threadkeeper" is set to Trash). Chats added by hand stay tracked under every scope.
 */
export function chatsLeavingScope(items, before, after) {
  const all = items || [];
  const leaving = liveChats(all).filter(item => item.chat.origin === 'sync' && !item.chat.removed && inScope(item.chat, before) && !inScope(item.chat, after));
  return { leaving: leaving.length, untouched: leaving.filter(item => !isUserTouchedChat(item, all)).length };
}

/** Synced chats still where sync placed them: the ones a placement change moves. */
export const placedChats = items => liveChats(items).filter(item => !item.chat.removed && (item.collectionId || '') === (item.chat.autoCollectionId || ''));

const PLACEMENT_KEYS = ['placement', 'parentName', 'singleCollectionId', 'matchExisting'];
export const changesPlacement = (before, after) => PLACEMENT_KEYS.some(key => readPrefs(before)[key] !== readPrefs(after)[key]);

const NOT_A_FOLDER = /^(unfiled|uncertain)\b/i;
/**
 * What the chosen prefs will do, in words, before anything syncs (review R.1): { threads, lines }. facets come from
 * Threadkeeper (null while loading); collections are the library's.
 */
export function syncPreview(prefs, facets, collections = []) {
  const p = readPrefs(prefs);
  const f = facets ? pickerFacets(facets) : null;
  const lines = [];
  let threads = null;
  if (p.scope === 'manual') {
    lines.push('Nothing syncs by itself. Add the threads you want with Add chats, or with Send to Still in Threadkeeper.');
    return { threads: 0, lines };
  }
  const projects = f ? (p.scope === 'projects' ? f.projects.filter(entry => p.projects.some(name => name.toLowerCase() === entry.name.toLowerCase())) : f.projects) : [];
  if (f) {
    threads = p.scope === 'projects' ? projects.reduce((sum, entry) => sum + entry.count, 0) : f.total;
    if (p.providers.length) {
      const share = f.providers.filter(entry => p.providers.includes(entry.id)).reduce((sum, entry) => sum + entry.count, 0);
      threads = Math.min(threads, share);
    }
    lines.push(p.scope === 'projects' && !p.projects.length ? 'Choose at least one project.'
      : `${plural(threads, 'thread')}${p.providers.length ? ' from the apps you chose' : ''}${p.scope === 'projects' ? ` in ${plural(p.projects.length, 'project')}` : ''}.`);
  }
  const live = (collections || []).filter(collection => !collection.deletedAt);
  if (p.placement === 'inbox') lines.push('Chats go to your Inbox.');
  else if (p.placement === 'single') {
    const target = live.find(collection => collection.id === p.singleCollectionId);
    lines.push(target ? `Chats go to ${target.name}.` : 'Chats go to your Inbox until you choose a collection.');
  } else {
    const folders = projects.filter(entry => !NOT_A_FOLDER.test(entry.name));
    const top = new Map(live.filter(collection => !collection.parentId).map(collection => [collection.name.trim().toLowerCase(), collection.name]));
    const reused = p.matchExisting ? folders.filter(entry => top.has(entry.name.trim().toLowerCase())) : [];
    const created = folders.length - reused.length;
    const parentExists = top.has(p.parentName.toLowerCase());
    if (!f) lines.push(`Chats go into “${p.parentName}”, one collection per Threadkeeper project.`);
    else if (!folders.length) lines.push(`Chats go into “${p.parentName}”${parentExists ? '' : ', a new collection'}.`);
    else lines.push(`${parentExists ? 'Uses' : 'Creates'} “${p.parentName}”${created ? ` with ${plural(created, 'collection')} inside, one per project` : ''}.`);
    if (reused.length) {
      const names = reused.slice(0, 3).map(entry => top.get(entry.name.trim().toLowerCase()));
      lines.push(`Chats from ${plural(reused.length, 'project')} go to your existing ${reused.length === 1 ? 'collection' : 'collections'} ${names.join(', ')}${reused.length > 3 ? ' and more' : ''}.`);
    }
  }
  if (!p.transcripts) lines.push('Only summaries are kept, not full transcripts.');
  return { threads, lines };
}

/** First-sync progress (review R.1): { percent, label } or null when no backfill is running. */
export function backfillProgress(state, items, now = Date.now()) {
  const fill = state?.backfill;
  const total = Number.isFinite(fill?.total) ? Math.max(0, Math.floor(fill.total)) : 0;
  if (!fill || !total) return null;
  const synced = liveChats(items).filter(item => item.chat.origin === 'sync').length;
  const done = Math.min(total, synced);
  if (done >= total) return null;
  const started = Date.parse(fill.startedAt || '');
  return { percent: Math.round((done / total) * 100), done, total, paused: !!fill.paused,
    label: `${done.toLocaleString()} of ${plural(total, 'thread')} in Still${fill.paused ? ' · paused' : ''}${Number.isFinite(started) && now - started > 60000 && !fill.paused ? ` · started ${relativeDate(fill.startedAt).toLowerCase()}` : ''}` };
}

/* ------------------------------------------------------------------ module state */

const tk = {
  state: null, loaded: false, ctx: null, off: null,
  probe: { reachable: null, at: 0, sync: null, running: false },
  facets: null, facetsError: '', facetsLoading: false,
  stats: null,
  discovery: null, // { list: [{ id, name, version, enabled, installType }], error }
  looking: false, choice: '', manualId: '', manualError: '',
  draft: null, // prefs being chosen in "Choose what to sync"
  liveScope: '', // 'projects' while the person picks the first project (nothing is saved until one is checked)
  syncNote: '',
  removeChats: false,
};

const api = () => threadkeeperClient();
const prefsOf = () => readPrefs(tk.state?.prefs);
const libraryItems = ctx => ctx.library?.items || [];
const libraryCollections = ctx => ctx.library?.collections || [];

// Chrome shows a permission prompt only during a user gesture, so the Find click starts this before its first await.
// Without the permissions API (preview, tests) there is nothing to grant.
function requestAccess(request) {
  const permissions = globalThis.chrome?.permissions;
  if (typeof permissions?.request !== 'function') return Promise.resolve(true);
  try { return Promise.resolve(permissions.request(request)).then(Boolean, () => false); } catch { return Promise.resolve(false); }
}

async function loadState(ctx) {
  try { tk.state = await api().getThreadkeeperState(); } catch { tk.state = null; }
  tk.loaded = true;
  if (tk.state?.status === 'paired') {
    probe(ctx);
    if (!tk.facets && !tk.facetsLoading) loadFacets(ctx);
    loadStats(ctx);
  }
  ctx.render();
}

/** Asks Threadkeeper for its sync status: also the liveness check behind "Not responding". */
async function probe(ctx, { force = false } = {}) {
  if (tk.probe.running || (!force && Date.now() - tk.probe.at < STALE_PROBE_MS)) return;
  tk.probe.running = true;
  try {
    const sync = await api().threadkeeperRequest('sync.status', {}, { timeoutMs: PROBE_MS });
    tk.probe = { reachable: true, at: Date.now(), sync: sync && typeof sync === 'object' ? sync : null, running: false };
  } catch (error) {
    // Only silence means "not responding": any protocol answer (disabled, busy) shows Threadkeeper is there.
    tk.probe = { reachable: error?.code === 'unreachable' ? false : true, at: Date.now(), sync: null, running: false };
  }
  if (tk.ctx === ctx) ctx.render();
}

async function loadFacets(ctx) {
  tk.facetsLoading = true;
  try {
    tk.facets = pickerFacets(await api().threadkeeperRequest('facets', {}, { timeoutMs: 10000 }));
    tk.facetsError = '';
  } catch (error) { tk.facetsError = error?.code === 'unreachable' ? 'Threadkeeper is not responding, so the totals are missing.' : error?.message || 'Threadkeeper could not count its threads.'; }
  tk.facetsLoading = false;
  if (tk.ctx === ctx) ctx.render();
}

async function loadStats(ctx) {
  try { tk.stats = await chatDataStats(); } catch { tk.stats = null; }
  if (tk.ctx === ctx) ctx.render();
}

/** Starts listening while Settings is on screen (settings.js attach()). */
export function attachThreadkeeper(ctx) {
  detachThreadkeeper();
  tk.ctx = ctx;
  try {
    const off = api().onThreadkeeperChange(state => {
      const was = tk.state?.status;
      if (state && typeof state === 'object') tk.state = state;
      if (tk.state?.status === 'paired' && was !== 'paired') { tk.draft = null; tk.discovery = null; loadFacets(ctx); probe(ctx, { force: true }); }
      if (tk.state?.status === 'paired') loadStats(ctx);
      if (tk.ctx === ctx) ctx.render();
    });
    tk.off = typeof off === 'function' ? off : null;
  } catch { tk.off = null; }
  loadState(ctx);
}

export function detachThreadkeeper() {
  tk.off?.();
  Object.assign(tk, { off: null, ctx: null });
}

/* ------------------------------------------------------------------ rendering */

const ids = where => ({ card: where === 'integrations' ? ANCHOR : `${ANCHOR}-${where}`, manual: `settings-tk-id-${where}` });

function statusBadge(state) {
  const status = threadkeeperStatus(state, { looking: tk.looking, reachable: tk.probe.reachable });
  return badge({ label: status.label, tone: status.tone, icon: status.icon });
}

function candidateList(where) {
  const list = tk.discovery?.list || [];
  if (!list.length) {
    return callout({ tone: 'warning', title: 'Threadkeeper isn’t installed or is turned off', live: true,
      body: 'Install Threadkeeper, or turn it on in chrome://extensions, then look again. You can also paste its ID below.' });
  }
  const chosen = list.some(entry => entry.id === tk.choice) ? tk.choice : '';
  return html`<div class="tk-candidates">
    <p class="settings-row-desc" id="settings-tk-candidates-${where}">${list.length === 1 ? 'Found this extension. Check that its ID matches the one in Threadkeeper → Settings → Sidebar Dock.'
      : 'Found these extensions. Pick the one whose ID matches Threadkeeper → Settings → Sidebar Dock.'}</p>
    <div class="tk-candidate-list" role="radiogroup" aria-labelledby="settings-tk-candidates-${where}">
      ${list.map(entry => html`<button type="button" role="radio" class="${cx('tk-candidate', entry.id === chosen && 'is-chosen')}" aria-checked="${entry.id === chosen ? 'true' : 'false'}"
        tabindex="${entry.id === chosen || (!chosen && entry === list[0]) ? '0' : '-1'}" data-action="settings.threadkeeper-choose" data-id="${entry.id}">
        <span class="tk-candidate-dot" aria-hidden="true"></span>
        <span class="tk-candidate-text"><span class="tk-candidate-name">${entry.name}${entry.version ? html` <span class="tk-candidate-version">${entry.version}</span>` : ''}</span>
          <span class="tk-candidate-id settings-mono">${entry.id}</span>
          ${entry.installType ? html`<span class="tk-candidate-meta">${entry.installType === 'development' ? 'Loaded unpacked' : entry.installType === 'normal' ? 'From the Chrome Web Store' : entry.installType}</span>` : ''}</span>
      </button>`)}
    </div>
    <div class="settings-actions">${button({ label: 'Connect', variant: 'primary', size: 'sm', action: 'settings.threadkeeper-connect', data: { id: chosen }, disabled: !chosen,
      loading: isBusy('tk-connect') })}</div>
  </div>`;
}

function manualForm(ctx, where) {
  const id = ids(where).manual;
  return html`<form class="tk-manual" data-submit="settings.threadkeeper-manual" id="settings-more-tk-manual-${where}">
    ${field({ label: 'Threadkeeper’s ID', id, error: tk.manualError, hint: 'In Threadkeeper, open Settings → Sidebar Dock and copy “This Threadkeeper’s ID”. It is 32 letters from a to p.',
      control: input({ id, name: 'extensionId', value: tk.manualId, placeholder: 'abcdefghijklmnopabcdefghijklmnop', action: 'settings.threadkeeper-id', invalid: !!tk.manualError,
        describedBy: tk.manualError ? `${id}-error` : `${id}-hint`, attrs: { maxlength: '64', 'aria-required': 'true' } }) })}
    <div class="settings-actions">${button({ label: 'Connect', type: 'submit', size: 'sm', loading: isBusy('tk-connect') })}</div>
  </form>`;
}

function renderConnect(ctx, where, state) {
  const status = state?.status || 'off';
  const notes = [];
  if (status === 'denied') notes.push(callout({ tone: 'danger', title: 'Threadkeeper said no', body: 'To try again, unblock Still in Threadkeeper → Settings → Sidebar Dock, then connect again.' }));
  if (status === 'revoked') notes.push(callout({ tone: 'info', title: 'Threadkeeper is disconnected', body: 'Chats already in Still stay here and stop updating. Connect again to keep them up to date.' }));
  if (status === 'pending' && pendingExpired(state)) notes.push(callout({ tone: 'warning', title: 'The request expired — try again', body: 'Threadkeeper did not get an answer within 10 minutes.' }));
  if (state?.lastError && status !== 'paired') notes.push(html`<p class="settings-row-desc is-warning">${state.lastError}</p>`);
  const manualOpen = disclosed(ctx, `tk-manual-${where}`) || (tk.discovery && !tk.discovery.list.length);
  return html`<div class="tk-body">
    ${notes}
    <p class="settings-row-desc">Still looks for Threadkeeper among your extensions. Chrome asks once to let it see that list, and Still lets go of that access right after.</p>
    <div class="settings-actions">
      ${button({ label: tk.discovery ? 'Look again' : 'Find Threadkeeper', icon: 'search', variant: tk.discovery?.list.length ? 'secondary' : 'primary', size: 'sm',
        action: 'settings.threadkeeper-find', loading: tk.looking })}
      ${status === 'pending' && pendingExpired(state) && isExtensionId(state.pending?.extensionId || state.extensionId)
        ? button({ label: 'Connect again', size: 'sm', action: 'settings.threadkeeper-connect', data: { id: state.pending?.extensionId || state.extensionId }, loading: isBusy('tk-connect') }) : ''}
    </div>
    ${tk.discovery?.error ? html`<p class="settings-row-desc is-warning" role="alert">${tk.discovery.error}</p>` : ''}
    ${tk.discovery && !tk.discovery.error ? candidateList(where) : ''}
    ${disclosure(ctx, `tk-manual-${where}`, 'Enter its ID instead')}
    ${manualOpen ? manualForm(ctx, where) : ''}
  </div>`;
}

function renderPending(ctx, state) {
  const code = pairingCode(state);
  const at = Date.parse(state?.pending?.at || '');
  const until = Number.isFinite(at) ? new Date(at + PENDING_MS).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  return callout({ tone: 'info', icon: 'hourglass', live: true, title: 'Allow Still in Threadkeeper',
    body: html`<p>A Threadkeeper window opened. Check that it names Still, type this code there, and choose Allow.</p>
      ${code ? html`<p class="tk-code" aria-label="Code ${code.replace(/\s/g, '').split('').join(' ')}">${code}</p>` : ''}
      <p>${until ? `The request expires at ${until}. ` : ''}Did not open? It may be behind this window. Threadkeeper opens one window per request.</p>`,
    actions: html`${button({ label: 'Send again', icon: 'refresh-cw', size: 'sm', action: 'settings.threadkeeper-resend', loading: isBusy('tk-connect') })}
      ${button({ label: 'Cancel', size: 'sm', variant: 'ghost', action: 'settings.threadkeeper-cancel' })}` });
}

const SCOPE_OPTIONS = [{ value: 'all', label: 'Every thread' }, { value: 'projects', label: 'Projects I choose' }, { value: 'manual', label: 'Only threads I add' }];
const PLACEMENT_OPTIONS = [{ value: 'mirror', label: 'Mirror projects' }, { value: 'single', label: 'One collection' }, { value: 'inbox', label: 'Inbox' }];

/** The project checklist (from Threadkeeper's facets), for scope "Projects I choose". */
function projectList(ctx, prefs, mode, where) {
  if (!tk.facets) return tk.facetsLoading ? html`<p class="tk-inline-loading">${spinner({ size: 14 })}<span>Loading projects from Threadkeeper</span></p>`
    : html`<p class="settings-row-desc is-warning">${tk.facetsError || 'Projects appear here once Threadkeeper answers.'}</p>`;
  if (!tk.facets.projects.length) return html`<p class="settings-row-desc">Threadkeeper has no projects it can share yet.</p>`;
  const chosen = new Set(prefs.projects.map(name => name.toLowerCase()));
  const open = disclosed(ctx, `tk-projects-${where}`) || tk.facets.projects.length <= 8;
  return html`<div class="tk-checklist-wrap">
    ${tk.facets.projects.length > 8 ? disclosure(ctx, `tk-projects-${where}`, open ? 'Hide projects' : `Choose projects (${prefs.projects.length.toLocaleString()} chosen)`) : ''}
    ${open ? html`<ul class="tk-checklist" role="list" id="settings-more-tk-projects-${where}" aria-label="Projects">${tk.facets.projects.map(entry => html`<li>
      ${checkbox({ checked: chosen.has(entry.name.toLowerCase()), label: html`${entry.name} <span class="tk-count">${entry.count.toLocaleString()}</span>`,
        action: mode === 'draft' ? 'settings.threadkeeper-draft-project' : 'settings.threadkeeper-project', data: { project: entry.name } })}</li>`)}</ul>` : ''}
  </div>`;
}

function providerList(ctx, prefs, mode, where) {
  if (!tk.facets?.providers.length) return '';
  const all = !prefs.providers.length;
  const open = disclosed(ctx, `tk-providers-${where}`);
  return html`<div class="tk-checklist-wrap">
    ${disclosure(ctx, `tk-providers-${where}`, all ? 'Every app (choose…)' : `${plural(prefs.providers.length, 'app')} chosen`)}
    ${open ? html`<ul class="tk-checklist" role="list" id="settings-more-tk-providers-${where}" aria-label="Apps">${tk.facets.providers.map(entry => html`<li>
      ${checkbox({ checked: all || prefs.providers.includes(entry.id), label: html`${entry.label} <span class="tk-count">${entry.count.toLocaleString()}</span>${entry.category !== 'chat'
        ? html` <span class="tk-category">${CATEGORY_LABELS[entry.category]}</span>` : ''}`, action: mode === 'draft' ? 'settings.threadkeeper-draft-provider' : 'settings.threadkeeper-provider',
        data: { provider: entry.id } })}</li>`)}</ul>` : ''}
  </div>`;
}

/** "What to sync" and "Where chats go" rows; mode 'draft' edits the Choose step, 'live' saves at once. */
function syncRows(ctx, prefs, mode, where) {
  const prefAction = mode === 'draft' ? 'settings.threadkeeper-draft' : 'settings.threadkeeper-pref';
  const collectionAction = mode === 'draft' ? 'settings.threadkeeper-draft-collection' : 'settings.threadkeeper-collection';
  return [
    blockRow({ label: 'What to sync', keywords: 'scope projects threads every all manual', description: prefs.scope === 'manual'
      ? 'Only the threads you add here or send from Threadkeeper. They stay up to date.'
      : prefs.scope === 'projects' ? 'Threads from the Threadkeeper projects you check, plus any you add yourself.' : 'Every thread Threadkeeper may share. Private and local-only threads never leave Threadkeeper.',
    body: html`${segmented({ name: 'scope', value: prefs.scope, action: prefAction, size: 'sm', ariaLabel: 'What to sync', options: SCOPE_OPTIONS })}
      ${prefs.scope === 'projects' ? projectList(ctx, prefs, mode, where) : ''}
      ${prefs.scope !== 'manual' ? providerList(ctx, prefs, mode, where) : ''}` }),
    blockRow({ label: 'Where chats go', keywords: 'placement collection mirror inbox folder projects', description: prefs.placement === 'mirror'
      ? 'One collection per Threadkeeper project, inside a collection for AI chats.' : prefs.placement === 'single' ? 'Every chat in one collection you choose.' : 'Every chat in your Inbox.',
    body: html`${segmented({ name: 'placement', value: prefs.placement, action: prefAction, size: 'sm', ariaLabel: 'Where chats go', options: PLACEMENT_OPTIONS })}
      ${prefs.placement === 'mirror' ? html`<div class="tk-sub">
        ${field({ label: 'Collection for AI chats', id: `settings-tk-parent-${where}`, control: input({ id: `settings-tk-parent-${where}`, name: 'parentName', value: prefs.parentName,
          change: mode === 'draft' ? 'settings.threadkeeper-draft-parent' : 'settings.threadkeeper-parent', attrs: { maxlength: '80' } }) })}
        ${checkbox({ checked: prefs.matchExisting, label: 'Use my existing collection when its name matches a project', action: prefAction, data: { name: 'matchExisting' } })}
      </div>` : ''}
      ${prefs.placement === 'single' ? html`<div class="tk-sub">${renderCollectionPickerTrigger({ ctx, value: prefs.singleCollectionId, action: collectionAction,
        id: `settings-tk-collection-${where}`, label: 'Collection for AI chats', size: 'sm' })}</div>` : ''}` }),
    switchRow({ label: 'Include full transcripts', keywords: 'messages conversation transcript', description: 'Keeps every message on this device so chats open offline. Turn off to keep only summaries.',
      checked: prefs.transcripts, action: prefAction, data: { name: 'transcripts' } }),
  ];
}

function renderChooseStep(ctx, where) {
  const draft = tk.draft ||= readPrefs(tk.state?.prefs);
  const preview = syncPreview(draft, tk.facets, libraryCollections(ctx));
  const total = tk.facets ? `${plural(tk.facets.total, 'thread')} in ${plural(tk.facets.projects.length, 'project')}` : '';
  const blocked = draft.scope === 'projects' && !draft.projects.length;
  return html`<div class="tk-choose">
    <div class="tk-choose-head">
      <p class="tk-step-title">Choose what to sync</p>
      <p class="settings-row-desc">${tk.facets ? `Threadkeeper can share ${total}. ` : tk.facetsLoading ? 'Counting the threads Threadkeeper can share… ' : tk.facetsError ? `${tk.facetsError} ` : ''}Nothing comes over until you start.</p>
    </div>
    ${card(syncRows(ctx, draft, 'draft', where), 'tk-inner-card')}
    <div class="tk-preview" role="status" aria-live="polite">${icon('info', { size: 14 })}<div>${preview.lines.map(line => html`<p>${line}</p>`)}</div></div>
    <div class="settings-actions">
      ${button({ label: 'Start syncing', icon: 'play', variant: 'primary', size: 'sm', action: 'settings.threadkeeper-start', disabled: blocked, loading: isBusy('tk-start') })}
      ${button({ label: 'Disconnect', size: 'sm', variant: 'ghost', action: 'settings.threadkeeper-disconnect' })}
    </div>
  </div>`;
}

function statusLine(ctx, state) {
  const chats = liveChats(libraryItems(ctx)).length;
  const parts = [plural(chats, 'chat') + ' in Still'];
  if (state.lastSyncAt) parts.push(`last update ${relativeDate(state.lastSyncAt).toLowerCase()}`);
  if (tk.stats?.bytes) parts.push(`${fileSize(tk.stats.bytes)} stored on this device`);
  return parts.join(' · ');
}

function renderSyncing(ctx, where, state) {
  const progress = backfillProgress(state, libraryItems(ctx));
  const queued = Number.isFinite(tk.probe.sync?.queued) ? tk.probe.sync.queued : 0;
  return html`<div class="tk-body">
    <p class="settings-row-desc tk-status-line">${statusLine(ctx, state)}</p>
    ${progress ? html`<div class="settings-job tk-job" role="status">
      <span class="settings-row-desc">${progress.paused ? 'First sync paused.' : 'Bringing in your threads.'} ${progress.label}.</span>
      ${progressBar({ percent: progress.percent, label: 'First sync' })}
    </div>` : queued && !isSearching() ? html`<p class="settings-row-desc" role="status">${plural(queued, 'thread')} waiting in Threadkeeper to come over.</p>` : ''}
    ${state.configDirty ? html`<p class="settings-row-desc is-warning">Your latest choices reach Threadkeeper the next time it answers.</p>` : ''}
    ${state.lastError ? callout({ tone: 'warning', title: 'The last update did not finish', body: html`${state.lastError}${state.lastErrorAt ? ` (${relativeDate(state.lastErrorAt).toLowerCase()})` : ''}` }) : ''}
    ${tk.syncNote && !isSearching() ? html`<p class="settings-row-desc" role="status">${tk.syncNote}</p>` : ''}
    <div class="settings-actions">
      ${button({ label: 'Add chats…', icon: 'plus', variant: 'primary', size: 'sm', action: 'settings.threadkeeper-add' })}
      ${button({ label: 'Sync now', icon: 'refresh-cw', size: 'sm', action: 'settings.threadkeeper-sync', loading: isBusy('tk-sync') })}
      ${progress ? button({ label: progress.paused ? 'Resume' : 'Pause', icon: progress.paused ? 'play' : 'pause', size: 'sm', variant: 'ghost', action: 'settings.threadkeeper-pause',
        data: { paused: progress.paused ? 'false' : 'true' } }) : ''}
      ${button({ label: 'Disconnect', size: 'sm', variant: 'ghost', action: 'settings.threadkeeper-disconnect', className: 'settings-danger-text' })}
    </div>
  </div>`;
}

const CONTEXT_OPTIONS = [{ value: 'auto', label: 'Smart' }, { value: 'always', label: 'Always' }, { value: 'off', label: 'Off' }];

function preferenceRows(ctx, prefs, where) {
  return [
    ...syncRows(ctx, prefs, 'live', where),
    switchRow({ label: 'Keep chats up to date', keywords: 'auto update refresh', description: 'Chats change when the thread continues in its app or gets a new summary in Threadkeeper.',
      checked: prefs.autoUpdate, action: 'settings.threadkeeper-pref', data: { name: 'autoUpdate' } }),
    row({ label: 'When a thread leaves Threadkeeper', keywords: 'deleted removed trash keep', description: 'Chats you added notes to, tagged or moved always stay.',
      control: segmented({ name: 'onRemoved', value: prefs.onRemoved, action: 'settings.threadkeeper-pref', size: 'sm', ariaLabel: 'When a thread leaves Threadkeeper',
        options: [{ value: 'keep', label: 'Keep the chat' }, { value: 'trash', label: 'Move it to Trash' }] }) }),
    switchRow({ label: 'Add topics as tags', keywords: 'tags topics', description: 'New chats get Threadkeeper’s topics as tags. Your own tags are never changed.',
      checked: prefs.topicsAsTags, action: 'settings.threadkeeper-pref', data: { name: 'topicsAsTags' } }),
    row({ label: 'Open chats in', keywords: 'summary transcript default view', description: 'The view a chat shows first. Each chat remembers the view you switch to.',
      control: segmented({ name: 'defaultView', value: prefs.defaultView, action: 'settings.threadkeeper-pref', size: 'sm', ariaLabel: 'Open chats in',
        options: [{ value: 'summary', label: 'Summary' }, { value: 'transcript', label: 'Transcript' }] }) }),
  ];
}

function assistantRows(state, prefs) {
  const searchable = hasCapability(state, 'search') || hasCapability(state, 'context');
  return [
    switchRow({ label: 'Let the assistant search my AI threads', keywords: 'assistant ai ask tools search threads', description: searchable
      ? 'The assistant can find threads in Threadkeeper, read them and add them to collections when you ask.'
      : 'Threadkeeper does not let Still search right now. Turn on “Let Still search my threads” in Threadkeeper → Settings → Sidebar Dock.',
      checked: prefs.assistant.search, action: 'settings.threadkeeper-pref', data: { name: 'assistant.search' } }),
    row({ label: 'Automatic thread context', keywords: 'assistant context smart always off', description: 'Smart adds relevant threads to questions that seem to be about past chats. Always checks every question. Off waits for you to ask.',
      control: segmented({ name: 'assistant.context', value: prefs.assistant.context, action: 'settings.threadkeeper-pref', size: 'sm', ariaLabel: 'Automatic thread context', options: CONTEXT_OPTIONS }) }),
    switchRow({ label: 'Use a fast model to decide', keywords: 'decision routing model haiku', description: 'For Smart: a quick, low-cost call to your fast model decides when a question needs your threads. Off uses keywords only.',
      checked: prefs.assistant.decision, disabled: prefs.assistant.context !== 'auto', action: 'settings.threadkeeper-pref', data: { name: 'assistant.decision' } }),
  ];
}

/**
 * The AI chat threads group for Settings → Integrations. where: the section it renders in (suffixes element ids, since
 * search renders every section at once).
 */
export function renderThreadkeeper(ctx, { where = 'integrations' } = {}) {
  const state = tk.state;
  const status = state?.status || 'off';
  const paired = status === 'paired';
  const configured = isConfigured(state);
  const extension = !!ctx.env?.isExtension;
  const header = html`<div class="settings-row-split">
    ${providerMark('threadkeeper', 32)}
    <div class="settings-row-text"><span class="settings-row-label">Threadkeeper ${extension && tk.loaded ? statusBadge(state) : ''}</span>
      <span class="settings-row-desc">Brings your conversations from ChatGPT, Claude, Gemini, coding agents and other AI apps into Still as chats you can read, organize and ask about.${paired && tkVersion(state) ? ` Threadkeeper ${tkVersion(state)}.` : ''}</span></div>
  </div>`;
  const body = !extension ? html`<p class="settings-row-desc">Threadkeeper works when Still runs as an extension.</p>`
    : !tk.loaded ? html`<p class="tk-inline-loading">${spinner({ size: 14 })}<span>Checking the connection</span></p>`
    : paired ? (configured ? renderSyncing(ctx, where, state) : renderChooseStep(ctx, where))
    : status === 'pending' && !pendingExpired(state) ? renderPending(ctx, state)
    : renderConnect(ctx, where, state);
  const main = html`<div class="${cx('settings-row', 'is-stacked', 'tk-card')}" id="${ids(where).card}" tabindex="-1" data-key="tk-card-${where}">${header}${body}</div>`;
  const prefs = prefsOf();
  return group({ title: 'AI chat threads', id: `settings-threadkeeper-group${where === 'integrations' ? '' : `-${where}`}`,
    keywords: 'threadkeeper threads chats transcripts chatgpt claude gemini coding agent sessions paperclip',
    body: () => html`
      ${card([searchable(['Threadkeeper', 'connect pair find extension id code sync status', threadkeeperStatus(state).label], main)])}
      ${extension && configured ? card(preferenceRows(ctx, tk.liveScope ? { ...prefs, scope: tk.liveScope } : prefs, where)) : ''}
      ${extension && configured ? html`${isSearching() ? '' : html`<p class="tk-card-label">Assistant</p>`}${card(assistantRows(state, prefs))}` : ''}
      ${isSearching() ? '' : note('lock', 'Threadkeeper shares only threads it may send to other apps: never ones you marked private or local-only. Still keeps its own copy on this device, so chats stay readable when Threadkeeper is off. When you ask the assistant about them, thread text goes to the AI provider you chose in Still.')}` });
}

/* ------------------------------------------------------------------ disconnect dialog */

function renderDisconnect(ctx) {
  const all = libraryItems(ctx);
  const chats = liveChats(all).filter(item => !item.chat.removed);
  const untouched = chats.filter(item => !isUserTouchedChat(item, all)).length;
  const kept = chats.length - untouched;
  const body = html`<p class="dialog-text">Still stops receiving threads from Threadkeeper. ${chats.length ? `The ${plural(chats.length, 'chat')} already here stay unless you remove them.` : ''}</p>
    ${chats.length ? html`${checkbox({ checked: tk.removeChats, label: `Also move ${plural(untouched, 'synced chat')} to Trash`,
      action: 'settings.threadkeeper-remove-chats', id: 'settings-tk-remove-chats' })}
      ${kept ? html`<p class="settings-row-desc">${plural(kept, 'chat')} you added notes to, tagged or moved ${kept === 1 ? 'stays' : 'stay'} either way.</p>` : ''}` : ''}`;
  return dialogFrame({ name: DISCONNECT, title: 'Disconnect Threadkeeper?', body,
    footer: html`${button({ label: 'Cancel', action: 'overlay.dismiss', attrs: { 'data-autofocus': '' } })}
      ${button({ label: 'Disconnect', variant: 'danger', action: 'settings.threadkeeper-disconnect-confirm', loading: isBusy('tk-disconnect') })}` });
}
registerDialog(DISCONNECT, renderDisconnect, { size: 'sm', className: 'tk-disconnect-dialog' });
/** The disconnect dialog body, for tests. */
export const renderDisconnectDialog = ctx => renderDisconnect(ctx);

/* ------------------------------------------------------------------ actions */

async function connect(ctx, id) {
  if (!isExtensionId(id)) throw new Error('That is not a Threadkeeper ID. It has 32 letters from a to p.');
  return withBusy(ctx, 'tk-connect', async () => {
    const result = await api().connectThreadkeeper(id);
    tk.discovery = null;
    tk.manualId = '';
    tk.manualError = '';
    await loadState(ctx);
    if (result?.status === 'paired') ctx.toast('Threadkeeper is connected. Choose what to sync.', { tone: 'success' });
  });
}

/** Saves one preference, with the confirms R.6/R.7 ask for. */
async function savePrefs(ctx, patch) {
  const before = prefsOf();
  const after = mergePrefs(before, patch);
  const options = {};
  const items = libraryItems(ctx);
  const leaving = chatsLeavingScope(items, before, after);
  if (leaving.leaving) {
    const trash = after.onRemoved === 'trash';
    const ok = await ctx.confirm({ title: `Stop syncing ${plural(leaving.leaving, 'chat')}?`,
      body: trash ? `${plural(leaving.leaving, 'chat')} in Still ${leaving.leaving === 1 ? 'is' : 'are'} outside your new choice. Up to ${plural(leaving.untouched, 'chat')} move to Trash; chats you added notes to, tagged or moved stay.`
        : `${plural(leaving.leaving, 'chat')} in Still ${leaving.leaving === 1 ? 'is' : 'are'} outside your new choice. They stay in Still and stop updating.`,
      confirmLabel: 'Change what syncs', tone: trash ? 'danger' : 'default' });
    if (!ok) { ctx.render(); return; }
  }
  if (changesPlacement(before, after)) {
    const placed = placedChats(items).length;
    if (placed) {
      options.replace = await ctx.confirm({ title: `Move ${plural(placed, 'chat')} to the new place?`,
        body: `New chats go to the new place. ${plural(placed, 'chat')} ${placed === 1 ? 'is' : 'are'} still where sync put ${placed === 1 ? 'it' : 'them'}; chats you moved yourself stay where they are.`,
        confirmLabel: 'Move them', cancelLabel: 'Leave them' });
    }
  }
  if (before.transcripts && !after.transcripts && tk.stats?.transcripts) {
    options.removeTranscripts = await ctx.confirm({ title: `Remove ${plural(tk.stats.transcripts, 'stored transcript')}?`,
      body: 'Summaries and your notes stay. Turn transcripts back on to bring them in again.', confirmLabel: 'Remove transcripts', cancelLabel: 'Keep them', tone: 'danger' });
  }
  const next = await api().setThreadkeeperPrefs(patch, options);
  if (next && typeof next === 'object' && next.prefs) tk.state = next;
  else await loadState(ctx);
  if (options.removeTranscripts) loadStats(ctx);
  ctx.render();
}

function prefValue(name, el, payload) {
  if (BOOLEANS.has(name)) return !!el?.checked;
  return payload?.value ?? el?.value;
}

function patchDraft(ctx, patch) {
  if (!patch) return;
  tk.draft = mergePrefs(tk.draft || tk.state?.prefs, patch);
  ctx.render();
}

const everyProvider = () => (tk.facets?.providers || []).map(entry => entry.id);

registerActions({
  'settings.threadkeeper-find': ({ ctx }) => {
    // Asked for in the click itself: Chrome shows the prompt only during the gesture.
    const granted = requestAccess({ permissions: ['management'] });
    if (tk.looking) return undefined;
    tk.looking = true;
    tk.discovery = null;
    ctx.render();
    return (async () => {
      try {
        if (!(await granted)) { tk.discovery = { list: [], error: 'Chrome did not let Still look at your extensions. Paste Threadkeeper’s ID instead.' }; return; }
        const found = await api().discoverThreadkeeper();
        const list = (Array.isArray(found) ? found : []).filter(entry => isExtensionId(entry?.id) && entry.enabled !== false).slice(0, 10)
          .map(entry => ({ id: entry.id, name: String(entry.name || 'Threadkeeper').slice(0, 60), version: String(entry.version || '').slice(0, 30), installType: String(entry.installType || '').slice(0, 30) }));
        tk.discovery = { list, error: '' };
        tk.choice = list.length === 1 ? list[0].id : '';
      } catch (error) { tk.discovery = { list: [], error: error?.message || 'Still could not look for Threadkeeper.' }; }
      finally { tk.looking = false; ctx.render(); }
    })();
  },
  'settings.threadkeeper-choose': ({ ctx, data }) => { if (isExtensionId(data.id)) { tk.choice = data.id; ctx.render(); } },
  'settings.threadkeeper-connect': ({ ctx, data }) => connect(ctx, data.id || tk.choice),
  'settings.threadkeeper-id': ({ el }) => { tk.manualId = String(el.value || ''); },
  'settings.threadkeeper-manual': ({ ctx, el }) => {
    const value = String(el?.querySelector?.('input[name="extensionId"]')?.value ?? tk.manualId).trim().toLowerCase();
    tk.manualId = value;
    if (!isExtensionId(value)) {
      tk.manualError = value ? 'That is not a Threadkeeper ID. It has 32 letters from a to p.' : 'Paste Threadkeeper’s ID first.';
      ctx.render();
      return undefined;
    }
    tk.manualError = '';
    return connect(ctx, value);
  },
  'settings.threadkeeper-resend': ({ ctx }) => connect(ctx, tk.state?.pending?.extensionId || tk.state?.extensionId),
  'settings.threadkeeper-cancel': async ({ ctx }) => {
    await api().disconnectThreadkeeper({ removeChats: false });
    await loadState(ctx);
  },
  'settings.threadkeeper-start': ({ ctx }) => withBusy(ctx, 'tk-start', async () => {
    const prefs = readPrefs(tk.draft || tk.state?.prefs);
    if (prefs.scope === 'projects' && !prefs.projects.length) throw new Error('Choose at least one project, or pick another option.');
    const next = await api().setThreadkeeperPrefs(prefs, { start: true });
    if (next && typeof next === 'object' && next.prefs) tk.state = next; else await loadState(ctx);
    tk.draft = null;
    ctx.toast(prefs.scope === 'manual' ? 'Threadkeeper is connected. Add chats whenever you like.' : 'Syncing started. Chats appear as Threadkeeper sends them.', { tone: 'success' });
  }),
  // Choose step: edits a draft, saved by Start syncing.
  'settings.threadkeeper-draft': ({ ctx, el, data }) => patchDraft(ctx, threadkeeperPrefPatch(data.name, prefValue(data.name, el, data), tk.draft || tk.state?.prefs)),
  'settings.threadkeeper-draft-parent': ({ ctx, el }) => patchDraft(ctx, threadkeeperPrefPatch('parentName', el.value, tk.draft)),
  'settings.threadkeeper-draft-collection': ({ ctx, data }) => patchDraft(ctx, threadkeeperPrefPatch('singleCollectionId', data.value || '', tk.draft)),
  'settings.threadkeeper-draft-project': ({ ctx, el, data }) => {
    const draft = readPrefs(tk.draft || tk.state?.prefs);
    patchDraft(ctx, { projects: toggleListPref(draft.projects, data.project, !!el.checked) });
  },
  'settings.threadkeeper-draft-provider': ({ ctx, el, data }) => {
    const draft = readPrefs(tk.draft || tk.state?.prefs);
    const next = toggleListPref(draft.providers, data.provider, !!el.checked, { everyone: everyProvider() });
    if (!next.length && !el.checked) throw new Error('Keep at least one app, or choose “Only threads I add”.');
    patchDraft(ctx, { providers: next });
  },
  // Live preferences: each saves at once.
  'settings.threadkeeper-pref': ({ ctx, el, data }) => {
    const patch = threadkeeperPrefPatch(data.name, prefValue(data.name, el, data), prefsOf());
    if (!patch) return undefined;
    if (data.name === 'scope') {
      tk.liveScope = '';
      // No project is chosen yet: show the checklist first and save once one is checked.
      if (patch.scope === 'projects' && !prefsOf().projects.length) { tk.liveScope = 'projects'; ctx.render(); return undefined; }
    }
    return savePrefs(ctx, patch);
  },
  'settings.threadkeeper-parent': ({ ctx, el }) => {
    const patch = threadkeeperPrefPatch('parentName', el.value, prefsOf());
    return patch && patch.parentName !== prefsOf().parentName ? savePrefs(ctx, patch) : undefined;
  },
  'settings.threadkeeper-collection': ({ ctx, data }) => savePrefs(ctx, threadkeeperPrefPatch('singleCollectionId', data.value || '', prefsOf())),
  'settings.threadkeeper-project': ({ ctx, el, data }) => {
    const projects = toggleListPref(prefsOf().projects, data.project, !!el.checked);
    if (tk.liveScope === 'projects') {
      if (!projects.length) return undefined;
      tk.liveScope = '';
      return savePrefs(ctx, { scope: 'projects', projects });
    }
    if (!projects.length && prefsOf().scope === 'projects') { ctx.render(); throw new Error('Keep at least one project, or choose another option.'); }
    return savePrefs(ctx, { projects });
  },
  'settings.threadkeeper-provider': ({ ctx, el, data }) => {
    const next = toggleListPref(prefsOf().providers, data.provider, !!el.checked, { everyone: everyProvider() });
    if (!next.length && !el.checked) { ctx.render(); throw new Error('Keep at least one app, or choose “Only threads I add”.'); }
    return savePrefs(ctx, { providers: next });
  },
  'settings.threadkeeper-sync': ({ ctx }) => withBusy(ctx, 'tk-sync', async () => {
    const result = await api().syncThreadkeeperNow();
    const queued = Number.isFinite(result?.queued) ? result.queued : 0;
    tk.syncNote = queued ? `Threadkeeper is sending ${plural(queued, 'thread')}.` : 'Everything is up to date.';
    probe(ctx, { force: true });
  }),
  'settings.threadkeeper-pause': async ({ ctx, data }) => {
    const paused = data.paused === 'true';
    const next = await api().setThreadkeeperPrefs({}, { pause: paused });
    if (next && typeof next === 'object' && next.prefs) tk.state = next; else await loadState(ctx);
    ctx.render();
  },
  'settings.threadkeeper-add': ({ ctx }) => openThreadkeeperPicker(ctx),
  'settings.threadkeeper-disconnect': ({ ctx }) => { tk.removeChats = false; ctx.openDialog(DISCONNECT, {}); },
  'settings.threadkeeper-remove-chats': ({ ctx, el }) => { tk.removeChats = !!el.checked; ctx.render(); },
  'settings.threadkeeper-disconnect-confirm': ({ ctx }) => withBusy(ctx, 'tk-disconnect', async () => {
    const removeChats = tk.removeChats;
    await api().disconnectThreadkeeper({ removeChats });
    ctx.closeDialog(DISCONNECT);
    tk.removeChats = false;
    Object.assign(tk, { draft: null, liveScope: '', facets: null, discovery: null, syncNote: '', probe: { reachable: null, at: 0, sync: null, running: false } });
    await loadState(ctx);
    ctx.toast(removeChats ? 'Threadkeeper is disconnected. Synced chats you never changed moved to Trash.' : 'Threadkeeper is disconnected. Your chats stay in Still.', { tone: 'success' });
  }),
});

/** Module state, for tests. */
export const threadkeeperSettingsState = () => tk;
/** Forgets everything the card loaded (tests). */
export function resetThreadkeeperSettings() {
  detachThreadkeeper();
  Object.assign(tk, { state: null, loaded: false, probe: { reachable: null, at: 0, sync: null, running: false }, facets: null, facetsError: '', facetsLoading: false, stats: null,
    discovery: null, looking: false, choice: '', manualId: '', manualError: '', draft: null, liveScope: '', syncNote: '', removeChats: false });
}
