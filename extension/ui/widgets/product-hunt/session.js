// Product Hunt session shared by every Product Hunt widget and the account card: whether a developer token is saved
// (never the token itself), host access for the public feed, and the cached lists with the requests that refresh them.
// Lists live in lib/widget-cache.js so a new tab paints at once; they refresh in the background every 30 minutes by default.
import { getAccount, getAccountInfo, onAccountsChanged } from '../../../lib/accounts.js';
import { hasOrigins, onPermissionsChanged } from '../../../lib/permissions.js';
import { readCache, writeCache, isStale, deleteCache } from '../../../lib/widget-cache.js';
import { findWidget } from '../../../lib/dashboard-store.js';
import {
  ACCOUNT_ID, FEED_ORIGIN, ProductHuntError, createProductHuntClient, fetchFeed, normalizeConfig, feedKey, modeFor,
} from '../../../lib/producthunt.js';

export const session = {
  loaded: false,       // account info read from storage
  info: null,          // getAccountInfo('producthunt'): { name, login, avatarUrl, meta: { userId }, connected }
  access: null,        // host access to www.producthunt.com (the feed): null unknown, true, false
  authFailed: false,   // Product Hunt rejected the saved token during a refresh; widgets fall back to the feed
  status: new Map(),   // cache key -> { loading, error: { kind, message, retryAt } | null, errorAt, manual }
};
const inflight = new Map();
export const mounted = new Set();   // widget ids whose sync mount is live

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
  const before = session.info?.updatedAt;
  try { session.info = await getAccountInfo(ACCOUNT_ID); } catch { session.info = null; }
  session.loaded = true;
  if (session.info?.updatedAt !== before) session.authFailed = false;
  await checkAccess();
  rerender();
}

export async function checkAccess() {
  session.access = await hasOrigins([FEED_ORIGIN]).catch(() => false);
  return session.access;
}

// Another Still view connected or disconnected Product Hunt, or Chrome changed host access.
onAccountsChanged(() => { if (session.loaded) reloadAccount().then(() => refreshMounted({ force: false })); });
onPermissionsChanged(() => { checkAccess().then(ok => { rerender(); if (ok) refreshMounted({ force: false }); }); });

export const connected = () => !!session.info?.connected;
/** Where a widget's list comes from right now: the API with a working token (unless the feed is chosen), else the feed. */
export const modeOf = config => modeFor(config, { connected: connected() && !session.authFailed });

export async function client() {
  const account = await getAccount(ACCOUNT_ID);
  if (!account?.token) throw new ProductHuntError('Add a Product Hunt developer token first.', { kind: 'auth' });
  return createProductHuntClient({ token: account.token });
}

/** Plain error for the UI. Unknown failures get a calm generic message; nothing raw (or secret) reaches the screen. */
export function errorInfo(error, fallback = 'Unable to load Product Hunt right now. Try again.') {
  if (error instanceof ProductHuntError) return { kind: error.kind, message: error.message, retryAt: error.retryAt || 0 };
  console.warn('[still] Product Hunt request failed', error?.name || 'Error');
  return { kind: 'error', message: fallback, retryAt: 0 };
}

/** Forget what belongs to the token (disconnect or a new token). The public feed stays cached. */
export function resetSession() {
  session.status.clear();
  inflight.clear();
  session.authFailed = false;
  deleteCache('producthunt:posts');
}

/** How many posts to ask the API for: the widget's limit plus room for hidden ones, within the API's page size. */
const wanted = config => Math.min(50, Math.max(20, config.limit + Math.min(config.hidden.length, 20)));

/** Everything a widget needs to render its list: { config, mode, key, value, at, loading, error, manual }. */
export function feedFor(rawConfig) {
  const config = normalizeConfig(rawConfig);
  const mode = modeOf(config);
  const key = feedKey(config, { mode });
  const entry = readCache(key);
  const status = session.status.get(key) || {};
  return { config, mode, key, value: entry?.value || null, at: entry?.at || 0, loading: !!status.loading, error: status.error || null, manual: !!status.manual };
}

/** Fetches a widget's list when it is missing or older than the refresh interval (always when forced). */
export async function syncFeed(rawConfig, { force = false, manual = false } = {}) {
  if (!session.loaded) await ensureAccount();
  const config = normalizeConfig(rawConfig);
  const mode = modeOf(config);
  if (mode === 'feed' && session.access !== true) return;
  const key = feedKey(config, { mode });
  if (inflight.has(key)) return inflight.get(key);
  const maxAge = config.refresh ? config.refresh * 60000 : Infinity;
  const entry = readCache(key);
  const last = session.status.get(key);
  if (!force) {
    const short = mode === 'api' && (entry?.value?.requested || 0) < wanted(config);
    if (entry && !short && !isStale(key, maxAge)) return;
    // Background retries back off after a failure: until a rate limit resets, else a few minutes.
    if (last?.error) {
      const wait = last.error.kind === 'rate' ? Math.max(300000, (last.error.retryAt || 0) - last.errorAt) : 120000;
      if (Date.now() - last.errorAt < wait) return;
    }
  }
  session.status.set(key, { loading: true, error: last?.error || null, errorAt: last?.errorAt || 0, manual });
  rerender();
  const run = (async () => {
    try {
      let value;
      if (mode === 'api') {
        const count = wanted(config);
        const result = await (await client()).posts({ range: config.range, sort: config.sort, topic: config.topic, featured: config.featured, first: count });
        value = { ...result, requested: count };
      } else {
        const result = await fetchFeed();
        value = { kind: 'feed', posts: result.posts, title: result.title, updated: result.updated, requested: result.posts.length };
      }
      writeCache(key, value);
      session.status.set(key, { loading: false, error: null, errorAt: 0, manual, doneAt: Date.now() });
      if (mode === 'api') session.authFailed = false;
    } catch (error) {
      const info = errorInfo(error);
      session.status.set(key, { loading: false, error: info, errorAt: Date.now(), manual });
      if (mode === 'api' && info.kind === 'auth') session.authFailed = true;
      // The feed may have lost its host access since the last check.
      if (mode === 'feed' && info.kind === 'network') await checkAccess();
    } finally {
      inflight.delete(key);
      rerender();
    }
  })();
  inflight.set(key, run);
  return run;
}

/** Refreshes every Product Hunt widget on screen. */
export function refreshMounted({ force = true } = {}) {
  for (const id of mounted) {
    const widget = findWidget(id)?.widget;
    if (widget) syncFeed(widget.config, { force });
  }
}

/** A product from any list this widget can show (its current list first). */
export function findPost(widgetId, postId) {
  const widget = findWidget(widgetId)?.widget;
  const own = widget ? feedFor(widget.config).value?.posts?.find(post => post.id === postId) : null;
  if (own) return own;
  for (const id of mounted) {
    const other = findWidget(id)?.widget;
    const found = other && feedFor(other.config).value?.posts?.find(post => post.id === postId);
    if (found) return found;
  }
  return null;
}
