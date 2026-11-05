// Paperclip session shared by the widget, the account card and the "Send to Paperclip" dialog: who is connected (never
// the key), host access to the Paperclip address, cached feeds and the project and agent lists. Feeds live in
// lib/widget-cache.js so a new tab paints at once. No dashboard imports here, so the library and detail menus can use it.
import { getAccountInfo, onAccountsChanged } from '../../../lib/accounts.js';
import { hasOrigins, onPermissionsChanged } from '../../../lib/permissions.js';
import { readCache, writeCache, isStale, deleteCache } from '../../../lib/widget-cache.js';
import {
  PAPERCLIP_ACCOUNT_ID, PaperclipError, paperclipClientFromAccount, feedKey, viewOf, sortByUpdated,
} from '../../../lib/paperclip.js';

const LISTS_MAX_AGE = 30 * 60000;
export const REFRESH_OPTIONS = Object.freeze([
  { value: 2, label: 'Every 2 minutes' }, { value: 5, label: 'Every 5 minutes' }, { value: 15, label: 'Every 15 minutes' },
  { value: 60, label: 'Every hour' }, { value: 0, label: 'Only when I refresh' },
]);
export const DEFAULT_CONFIG = Object.freeze({ view: 'mine', projectId: '', refresh: 5 });

/** Config with every key valid (select fields arrive as strings). */
export function normalizeConfig(config = {}) {
  const c = { ...DEFAULT_CONFIG, ...(config && typeof config === 'object' ? config : {}) };
  const refresh = Number(c.refresh);
  return {
    view: ['mine', 'open', 'review'].includes(c.view) ? c.view : DEFAULT_CONFIG.view,
    projectId: typeof c.projectId === 'string' ? c.projectId.slice(0, 80) : '',
    refresh: REFRESH_OPTIONS.some(o => o.value === refresh) ? refresh : DEFAULT_CONFIG.refresh,
  };
}

export const session = {
  loaded: false,
  info: null,          // getAccountInfo('paperclip') without the key: { name, method, meta: { baseUrl, companyId, companyPrefix, companyName, mode, agentId }, connected }
  access: null,        // host access to the Paperclip origin: null unknown, true, false
  authFailed: false,
  status: new Map(),   // feed key -> { loading, error, errorAt }
};
export const mounted = new Map(); // widget id -> latest config
const inflight = new Map();
let epoch = 0;   // bumped by resetSession so requests still in flight for the old account never refill the cache
let listsRun = null;
let lastCtx = null;
let loading = null;

export function bindCtx(ctx) { if (ctx) lastCtx = ctx; }
export const rerender = () => lastCtx?.render?.();

export function ensureAccount() {
  if (session.loaded || loading) return loading;
  loading = reloadAccount().finally(() => { loading = null; });
  return loading;
}

async function reloadAccount() {
  const before = identity();
  try { session.info = await getAccountInfo(PAPERCLIP_ACCOUNT_ID); } catch { session.info = null; }
  session.loaded = true;
  if (identity() !== before) session.authFailed = false;
  await checkAccess();
  rerender();
}

const identity = () => { const m = session.info?.meta; return m ? `${m.baseUrl}|${m.companyId}|${session.info.method}` : ''; };

export const baseUrl = () => session.info?.meta?.baseUrl || '';
export const originFor = url => (url ? `${url}/*` : '');
export async function checkAccess() {
  const url = baseUrl();
  session.access = url ? await hasOrigins([originFor(url)]).catch(() => false) : null;
  return session.access;
}

onAccountsChanged(() => { if (session.loaded) reloadAccount(); });
onPermissionsChanged(() => { checkAccess().then(ok => { rerender(); if (ok) refreshMounted(); }); });

/** True when a Paperclip account with a company is saved. Synchronous for menus: false until the account has loaded. */
export const connected = () => !!session.info?.connected && !!session.info?.meta?.baseUrl && !!session.info?.meta?.companyId;
export const company = () => {
  const m = session.info?.meta || {};
  return { id: m.companyId || '', prefix: m.companyPrefix || '', name: m.companyName || '' };
};
/** Whose tasks "Assigned to me" shows: the agent behind an agent key, else the board user. */
export const assignee = () => {
  const m = session.info?.meta || {};
  if (m.agentId) return { assigneeAgentId: m.agentId };
  return { assigneeUserId: 'me' };
};

export async function client() {
  const api = await paperclipClientFromAccount();
  if (!api) throw new PaperclipError('Connect Paperclip in Settings → Connected accounts first.', { kind: 'auth' });
  return api;
}

/** Plain error for the UI. Unknown failures get a calm generic message; nothing raw (or secret) reaches the screen. */
export function errorInfo(error, fallback = 'Unable to load Paperclip right now. Try again.') {
  if (error instanceof PaperclipError) return { kind: error.kind, message: error.message };
  console.warn('[still] Paperclip request failed', error?.name || 'Error');
  return { kind: 'error', message: fallback };
}

export function resetSession() {
  epoch++;
  session.status.clear();
  inflight.clear();
  session.authFailed = false;
  deleteCache('paperclip');
}

// ------------------------------------------------------------------------------------------------ projects and agents

const listsKey = () => `paperclip:${baseUrl()}:${company().id}:lists`;
export const lists = () => readCache(listsKey())?.value || { projects: [], agents: [] };

export function ensureLists({ force = false } = {}) {
  if (!connected() || session.access === false) return Promise.resolve(lists());
  const key = listsKey();
  if (!force && readCache(key) && !isStale(key, LISTS_MAX_AGE)) return Promise.resolve(lists());
  if (listsRun) return listsRun;
  listsRun = (async () => {
    try {
      const api = await client();
      const id = company().id;
      const [projects, agents] = await Promise.allSettled([api.projects(id), api.agents(id)]);
      writeCache(key, { projects: projects.status === 'fulfilled' ? projects.value : [], agents: agents.status === 'fulfilled' ? agents.value : [] });
    } catch (error) {
      if (error?.kind === 'auth') session.authFailed = true;
    } finally { listsRun = null; rerender(); }
    return lists();
  })();
  return listsRun;
}

// ------------------------------------------------------------------------------------------------ feeds

/** Statuses and filters a widget config asks for. "Assigned to me" falls back to open tasks without an identity. */
export function queryFor(config) {
  const c = normalizeConfig(config);
  const view = viewOf(c.view);
  const query = { status: view.status, limit: 25 };
  if (c.view === 'mine') Object.assign(query, assignee());
  if (c.projectId) query.projectId = c.projectId;
  return query;
}

export function feedFor(rawConfig) {
  const config = normalizeConfig(rawConfig);
  const key = connected() ? feedKey({ baseUrl: baseUrl(), companyId: company().id, view: config.view, projectId: config.projectId }) : '';
  const entry = key ? readCache(key) : null;
  const status = session.status.get(key) || {};
  return { config, key, value: entry?.value || null, at: entry?.at || 0, loading: !!status.loading, error: status.error || null };
}

export async function syncFeed(rawConfig, { force = false } = {}) {
  if (!connected() || session.access !== true) return;
  const config = normalizeConfig(rawConfig);
  const { key } = feedFor(config);
  if (!key) return;
  if (inflight.has(key)) return inflight.get(key);
  const last = session.status.get(key);
  if (!force) {
    const maxAge = config.refresh ? config.refresh * 60000 : Infinity;
    if (readCache(key) && !isStale(key, maxAge)) return;
    if (session.authFailed || (last?.error && Date.now() - last.errorAt < (last.error.kind === 'rate' ? 300000 : 90000))) return;
  }
  session.status.set(key, { loading: true, error: last?.error || null, errorAt: last?.errorAt || 0 });
  rerender();
  const started = epoch;
  const run = (async () => {
    try {
      const issues = await (await client()).issues(company().id, queryFor(config));
      if (started !== epoch) return;
      writeCache(key, { issues: sortByUpdated(issues) });
      session.status.set(key, { loading: false, error: null });
      session.authFailed = false;
    } catch (error) {
      session.status.set(key, { loading: false, error: errorInfo(error), errorAt: Date.now() });
      if (error?.kind === 'auth') session.authFailed = true;
    } finally { inflight.delete(key); rerender(); }
  })();
  inflight.set(key, run);
  return run;
}

export function refreshMounted({ force = true } = {}) {
  for (const config of mounted.values()) syncFeed(config, { force });
}

/** Finds an issue in any feed on screen. */
export function findIssue(issueId) {
  for (const config of mounted.values()) {
    const found = feedFor(config).value?.issues?.find(issue => issue.id === issueId);
    if (found) return found;
  }
  return null;
}
