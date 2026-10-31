// Calendar feeds (iCal / .ics) for the calendar widget. A feed's address is often a secret link (Google Calendar's
// "secret address", Outlook's published ICS), so it is kept with the device's connected accounts (lib/accounts.js,
// never in backups or widget settings); widget.config.feeds only holds { id, name, color, host }.
// Parsed events are cached in lib/widget-cache.js for 30 minutes per feed and refreshed in the background.
import { getAccount, saveAccount } from '../../../lib/accounts.js';
import { readCache, writeCache, isStale, deleteCache } from '../../../lib/widget-cache.js';
import { hasOrigins } from '../../../lib/permissions.js';
import { parseIcs, trimEvents, normalizeFeedUrl, MAX_ICS_BYTES } from '../../../lib/ics.js';

export const FEED_ACCOUNT = 'calendar-feeds';
export const FEED_MAX_AGE = 30 * 60_000;
export const FEED_COLORS = Object.freeze(['blue', 'green', 'orange', 'violet', 'pink', 'teal', 'red', 'amber', 'indigo', 'gray']);
export const feedCacheKey = id => `calendar:ics:${id}`;
export const hostOf = url => { try { return new URL(url).host; } catch { return ''; } };

let urls = null;
async function allUrls() {
  if (urls) return urls;
  const account = await getAccount(FEED_ACCOUNT).catch(() => null);
  urls = account?.meta?.urls && typeof account.meta.urls === 'object' ? { ...account.meta.urls } : {};
  return urls;
}
/** The stored address of a feed, or ''. */
export async function feedUrl(id) { return (await allUrls())[id] || ''; }
/** Stores addresses for feed ids ({ id: url }) and forgets the ids in `remove`. */
export async function storeFeedUrls(add = {}, remove = []) {
  const next = { ...(await allUrls()) };
  for (const [id, url] of Object.entries(add)) if (normalizeFeedUrl(url)) next[id] = normalizeFeedUrl(url);
  for (const id of remove) delete next[id];
  urls = next;
  await saveAccount(FEED_ACCOUNT, { method: 'ics', name: 'Calendar feeds', meta: { urls: next } });
  for (const id of remove) deleteCache(feedCacheKey(id));
}
/** Drops the in-memory copy (another tab may have changed the stored addresses). */
export const forgetFeedUrls = () => { urls = null; };

// ------------------------------------------------------------------ fetching

function feedError(kind, message) { return Object.assign(new Error(message), { kind }); }

/** Fetches and parses one feed address: { name, events }. Errors carry kind: access | network | http | invalid. */
export async function fetchFeed(url, { fetch: fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const address = normalizeFeedUrl(url);
  const host = hostOf(address) || 'the calendar';
  if (!address) throw feedError('invalid', 'This calendar address is not a web link. Copy the iCal (.ics) address again.');
  let response;
  try {
    response = await fetchImpl(address, { credentials: 'omit', cache: 'no-store', redirect: 'follow', headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' } });
  } catch {
    throw feedError('network', `Unable to reach ${host}. Check your connection and the calendar address.`);
  }
  if (response.status === 401 || response.status === 403) throw feedError('http', `${host} refused this calendar. Check that the address is the current secret or public iCal link.`);
  if (response.status === 404 || response.status === 410) throw feedError('http', `This calendar address no longer works. Copy it again from your calendar app.`);
  if (!response.ok) throw feedError('http', `${host} could not send this calendar (error ${response.status}). Still will try again later.`);
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > MAX_ICS_BYTES) throw feedError('invalid', 'This calendar is too large to show (over 8 MB).');
  const text = await response.text();
  let parsed;
  try { parsed = parseIcs(text); } catch (error) { throw feedError('invalid', error.message); }
  return { name: parsed.name, events: trimEvents(parsed.events, now) };
}

// Per-feed refresh state: { promise, error, kind, failedAt }.
const sync = new Map();
export const feedState = id => sync.get(id) || {};
const RETRY_MS = { network: 5 * 60_000, http: 30 * 60_000, invalid: 60 * 60_000, access: 60 * 60_000, missing: 60 * 60_000 };

/** Cached { name, events } for a feed, or null. */
export const cachedFeed = id => readCache(feedCacheKey(id))?.value || null;
export const cachedAt = id => readCache(feedCacheKey(id))?.at || 0;

/** Refreshes a feed when its cache is stale (or `force`), calling onChange after each state change. */
export function refreshFeed(feed, { force = false, onChange = () => {} } = {}) {
  const state = feedState(feed.id);
  if (state.promise) return state.promise;
  if (!force && state.failedAt && Date.now() - state.failedAt < (RETRY_MS[state.kind] || 10 * 60_000)) return null;
  if (!force && !isStale(feedCacheKey(feed.id), FEED_MAX_AGE)) return null;
  const promise = (async () => {
    try {
      const url = await feedUrl(feed.id);
      if (!url) throw feedError('missing', 'This calendar’s address is not on this device. Remove it and add it again in the widget settings.');
      if (!(await hasOrigins([url]))) throw feedError('access', `Still needs access to ${hostOf(url)} to read this calendar.`);
      writeCache(feedCacheKey(feed.id), await fetchFeed(url));
      sync.set(feed.id, {});
    } catch (error) {
      sync.set(feed.id, { error: error?.message || 'Unable to load this calendar.', kind: error?.kind || 'http', failedAt: Date.now() });
    }
    onChange();
  })();
  sync.set(feed.id, { ...state, promise });
  onChange();
  return promise;
}
