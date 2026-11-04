// Linear session for every Linear widget and the account card: who is connected (never the key), host access, teams,
// cached feeds and the requests that refresh or change them. Feeds live in lib/widget-cache.js so a new tab paints at
// once; optimistic edits sit in an in-memory overlay until Linear confirms them, then the cache takes the server copy.
import { getAccount, getAccountInfo, onAccountsChanged } from '../../../lib/accounts.js';
import { hasOrigins, onPermissionsChanged } from '../../../lib/permissions.js';
import { readCache, writeCache, isStale, deleteCache } from '../../../lib/widget-cache.js';
import { findWidget } from '../../../lib/dashboard-store.js';
import {
  ACCOUNT_ID, LINEAR_ORIGIN, LinearError, createLinearClient, normalizeConfig, feedKey, teamsKey, viewOf,
  applyIssuePatch, replaceIssues,
} from '../../../lib/linear.js';

const TEAMS_MAX_AGE = 6 * 3600000;

export const session = {
  loaded: false,       // account info read from storage
  info: null,          // getAccountInfo('linear'): { name, login, avatarUrl, meta: { viewerId, fullName, organization }, connected }
  access: null,        // host access to api.linear.app: null unknown, true, false
  authFailed: false,   // Linear rejected the stored key during a refresh
  teamsError: null,
  status: new Map(),   // feed key -> { loading, error: { kind, message } | null, manual }
};
const inflight = new Map();
let generation = 0;              // bumped after every confirmed change, so older in-flight snapshots are refetched
const issueOverlay = new Map();   // issue id -> optimistic issue
const readOverlay = new Set();    // notification ids marked read locally
export const mounted = new Set(); // widget ids whose sync mount is live

let lastCtx = null;
let loading = null;
/** Remembers the app ctx so background results can re-render. Every render path calls it. */
export function bindCtx(ctx) { if (ctx) lastCtx = ctx; }
export const rerender = () => lastCtx?.render?.();

export function ensureAccount() {
  if (session.loaded || loading) return loading;
  loading = reloadAccount().finally(() => { loading = null; });
  return loading;
}

async function reloadAccount() {
  const before = session.info?.meta?.viewerId;
  try { session.info = await getAccountInfo(ACCOUNT_ID); } catch { session.info = null; }
  session.loaded = true;
  if (session.info?.meta?.viewerId !== before) session.authFailed = false;
  await checkAccess();
  rerender();
}

export async function checkAccess() {
  session.access = await hasOrigins([LINEAR_ORIGIN]).catch(() => false);
  return session.access;
}

// Another Still view connected or disconnected Linear, or Chrome changed host access.
onAccountsChanged(() => { if (session.loaded) reloadAccount(); });
onPermissionsChanged(() => { checkAccess().then(ok => { rerender(); if (ok) refreshMounted(); }); });

export const connected = () => !!session.info?.connected && !!session.info?.meta?.viewerId;
export const viewer = () => {
  const info = session.info;
  if (!info?.meta?.viewerId) return null;
  return { id: info.meta.viewerId, name: info.name || info.meta.fullName || '', fullName: info.meta.fullName || info.name || '', email: info.login || '',
    avatarUrl: info.avatarUrl || '', organization: info.meta.organization || { name: '', urlKey: '' } };
};

export async function client() {
  const account = await getAccount(ACCOUNT_ID);
  if (!account?.token) throw new LinearError('Connect Linear with an API key first.', { kind: 'auth' });
  return createLinearClient({ token: account.token });
}

/** Plain error for the UI. Unknown failures get a calm generic message; nothing raw (or secret) reaches the screen. */
export function errorInfo(error, fallback = 'Unable to load Linear right now. Try again.') {
  if (error instanceof LinearError) return { kind: error.kind, message: error.message };
  console.warn('[still] Linear request failed', error?.name || 'Error');
  return { kind: 'error', message: fallback };
}

/** Forget everything tied to the current account (disconnect or a different account). */
export function resetSession() {
  generation++;   // requests still in flight belong to the old account: their results are dropped, not cached
  session.status.clear();
  inflight.clear();
  issueOverlay.clear();
  readOverlay.clear();
  session.authFailed = false;
  session.teamsError = null;
  teamsFailedAt = 0;
  deleteCache('linear');
}

// ------------------------------------------------------------------------------------------------ teams

let teamsRun = null;
let teamsFailedAt = 0;
export function teamsList() {
  const id = session.info?.meta?.viewerId;
  return (id && readCache(teamsKey(id))?.value) || [];
}
export const teamById = id => teamsList().find(team => team.id === id) || null;
export const statesFor = teamId => teamById(teamId)?.states || [];

export function ensureTeams({ force = false } = {}) {
  const viewerId = session.info?.meta?.viewerId;
  if (!connected() || session.access === false || !viewerId) return Promise.resolve(teamsList());
  const key = teamsKey(viewerId);
  if (!force && readCache(key) && !isStale(key, TEAMS_MAX_AGE)) return Promise.resolve(teamsList());
  if (teamsRun) return teamsRun;
  if (!force && (session.authFailed || Date.now() - teamsFailedAt < 120000)) return Promise.resolve(teamsList());
  teamsRun = (async () => {
    try {
      const teams = await (await client()).teams();
      writeCache(key, teams);
      session.teamsError = null;
      teamsFailedAt = 0;
    } catch (error) {
      teamsFailedAt = Date.now();
      session.teamsError = errorInfo(error, 'Unable to load your Linear teams.');
      if (error?.kind === 'auth') session.authFailed = true;
    } finally { teamsRun = null; rerender(); }
    return teamsList();
  })();
  return teamsRun;
}

/** The team a widget uses: its chosen team when it still exists, else your first team. */
export function resolveTeamId(config) {
  const teams = teamsList();
  if (config.teamId && (!teams.length || teams.some(team => team.id === config.teamId))) return config.teamId;
  return teams[0]?.id || '';
}

// ------------------------------------------------------------------------------------------------ feeds

/** Everything a widget needs to render one feed: { config, key, team, value, at, loading, error }. */
export function feedFor(rawConfig) {
  const config = normalizeConfig(rawConfig);
  const viewerId = session.info?.meta?.viewerId || '';
  const teamId = resolveTeamId(config);
  const needsTeam = viewOf(config.view).team;
  const key = needsTeam && !teamId ? '' : feedKey({ viewerId, view: config.view, teamId, showCompleted: config.showCompleted });
  const entry = key ? readCache(key) : null;
  const status = session.status.get(key) || {};
  const teamsKnown = !!readCache(teamsKey(viewerId));
  const noTeam = needsTeam && !teamId;
  const teamError = noTeam ? session.teamsError || (teamsKnown && !teamsRun ? { kind: 'team', message: 'No Linear team is available for this view.' } : null) : null;
  return { config, key, teamId, team: teamById(teamId), value: withOverlay(entry?.value || null), at: entry?.at || 0, loading: !!status.loading || (noTeam && !!teamsRun),
    error: status.error || teamError, manual: !!status.manual };
}

function withOverlay(value) {
  if (!value) return value;
  if (value.kind === 'inbox') return readOverlay.size ? { ...value, notifications: value.notifications.map(n => readOverlay.has(n.id) && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n) } : value;
  return issueOverlay.size ? replaceIssues(value, [...issueOverlay.values()]) : value;
}

/** Fetches a widget's feed when it is missing or older than the refresh interval (always when forced). */
export async function syncFeed(rawConfig, { force = false, manual = false } = {}) {
  if (!connected() || session.access !== true) return;
  const config = normalizeConfig(rawConfig);
  const teams = ensureTeams();
  // Until teams are known, issue views cannot name their cycle team (and team views their team): wait once.
  if (config.view !== 'inbox' && !resolveTeamId(config)) await teams;
  const { key, teamId } = feedFor(config);
  if (!key) return;   // a team view with no team to show; the widget already says so (re-rendering here would loop)
  if (inflight.has(key)) return inflight.get(key);
  const maxAge = config.refresh ? config.refresh * 60000 : Infinity;
  const last = session.status.get(key);
  if (!force) {
    if (readCache(key) && !isStale(key, maxAge)) return;
    // Background retries back off after a failure, and stop while Linear rejects the key.
    if (session.authFailed || (last?.error && Date.now() - last.errorAt < (last.error.kind === 'rate' ? 300000 : 90000))) return;
  }
  session.status.set(key, { loading: true, error: last?.error || null, errorAt: last?.errorAt || 0, manual });
  rerender();
  const started = generation;
  let again = false;
  const run = (async () => {
    try {
      const api = await client();
      const value = config.view === 'inbox' ? await api.inbox() : await api.issues({ view: config.view, teamId, showCompleted: config.showCompleted, withCycle: !!teamId });
      // A change landed while this request was in flight, so the snapshot may predate it: fetch again.
      if (started !== generation) { again = true; return; }
      writeCache(key, value);
      session.status.set(key, { loading: false, error: null, manual, doneAt: Date.now() });
      session.authFailed = false;
    } catch (error) {
      session.status.set(key, { loading: false, error: errorInfo(error), errorAt: Date.now(), manual });
      if (error?.kind === 'auth') session.authFailed = true;
    } finally {
      inflight.delete(key);
      if (!again) rerender();
    }
  })().then(() => (again ? syncFeed(config, { force: true, manual }) : undefined));
  inflight.set(key, run);
  return run;
}

/** Refreshes every Linear widget on screen; `kind` limits it to issue views ('issues') or inboxes ('inbox'). */
export function refreshMounted({ force = true, kind } = {}) {
  for (const id of mounted) {
    const widget = findWidget(id)?.widget;
    if (!widget || (kind && (normalizeConfig(widget.config).view === 'inbox') !== (kind === 'inbox'))) continue;
    syncFeed(widget.config, { force });
  }
}

/** Feed keys of the Linear widgets on screen, so a change reaches every widget showing that issue or notification. */
function mountedFeedKeys() {
  const keys = new Set();
  for (const id of mounted) {
    const widget = findWidget(id)?.widget;
    const key = widget && feedFor(widget.config).key;
    if (key) keys.add(key);
  }
  return [...keys];
}

/** Every visible copy of an issue (with pending edits applied), or null. */
export function findIssue(issueId) {
  if (issueOverlay.has(issueId)) return issueOverlay.get(issueId);
  for (const key of mountedFeedKeys()) {
    const found = readCache(key)?.value?.issues?.find?.(issue => issue.id === issueId);
    if (found) return found;
  }
  return null;
}

/**
 * Changes an issue optimistically, then in Linear. patch: { stateId?, priority?, assigneeId? }.
 * Resolves with the issue Linear returns; on failure the change is rolled back and the error rethrown.
 */
export async function updateIssue(issue, patch) {
  const optimistic = applyIssuePatch(issue, patch, { states: statesFor(issue.team?.id), viewer: viewer() });
  issueOverlay.set(issue.id, optimistic);
  rerender();
  try {
    const saved = await (await client()).updateIssue(issue.id, patch);
    for (const key of mountedFeedKeys()) {
      const entry = readCache(key);
      const next = replaceIssues(entry?.value, [saved]);
      if (next && next !== entry.value) writeCache(key, next);
    }
    if (issueOverlay.get(issue.id) === optimistic) issueOverlay.delete(issue.id);
    generation++;
    // The change can move the issue in or out of other views (unassigned, completed): reconcile the issue widgets.
    refreshMounted({ kind: 'issues' });
    return saved;
  } catch (error) {
    if (issueOverlay.get(issue.id) === optimistic) issueOverlay.delete(issue.id);
    if (error?.kind === 'auth') session.authFailed = true;
    throw error instanceof LinearError ? error : new LinearError(errorInfo(error, 'Linear did not save that change. Try again.').message);
  } finally { rerender(); }
}

/** Creates an issue, shows it at the top of the widget it came from right away, then refreshes every Linear widget. */
export async function createIssue(input, { widgetId } = {}) {
  const issue = await (await client()).createIssue(input);
  generation++;
  const widget = widgetId && findWidget(widgetId)?.widget;
  const key = widget && feedFor(widget.config).key;
  const entry = key && readCache(key);
  if (entry?.value?.kind === 'issues' && !entry.value.issues.some(i => i.id === issue.id)) writeCache(key, { ...entry.value, issues: [issue, ...entry.value.issues] });
  rerender();
  refreshMounted({ kind: 'issues' });
  return issue;
}

/** Marks notifications read locally at once and in Linear; rolls back on failure. */
export async function markRead(ids) {
  const list = ids.filter(id => !readOverlay.has(id));
  if (!list.length) return 0;
  for (const id of list) readOverlay.add(id);
  rerender();
  try {
    const count = await (await client()).markRead(list);
    const readAt = new Date().toISOString();
    for (const key of mountedFeedKeys()) {
      const entry = readCache(key);
      if (entry?.value?.kind !== 'inbox') continue;
      writeCache(key, { ...entry.value, notifications: entry.value.notifications.map(n => list.includes(n.id) && !n.readAt ? { ...n, readAt } : n) });
    }
    generation++;
    return count;
  } catch (error) {
    throw error instanceof LinearError ? error : new LinearError('Linear did not mark that as read. Try again.');
  } finally {
    for (const id of list) readOverlay.delete(id);
    rerender();
  }
}
