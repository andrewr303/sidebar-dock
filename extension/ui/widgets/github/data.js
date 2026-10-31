// GitHub widget data: one snapshot per account and fetch scope, painted from lib/widget-cache.js and refreshed in the
// background while a widget showing it is mounted and the page is visible. Mutations update the snapshot optimistically
// (merged or closed pull requests stay hidden while GitHub's search index catches up) and refresh afterwards.
import { readCache, writeCache, WIDGET_CACHE_KEY } from '../../../lib/widget-cache.js';
import {
  fetchSnapshot, snapshotKey, normalizeConfig, mergePullRequest, approvePullRequest, updateBranch, closePullRequest, rerunFailedJobs,
  markNotificationRead, markAllNotificationsRead, setAutoMerge, markReadyForReview, convertToDraft,
} from '../../../lib/github.js';
import { authState, getClient, onAuthChange } from './connection.js';

const HIDE_MS = 3 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;
const entries = new Map(); // key -> { key, snapshot, fetchedAt, loading, error, attemptAt, resetAt, promise, stage }
const hidden = new Map();  // pull request or notification id -> expiry
let render = () => {};

export const setRenderer = fn => { render = fn; };

function entryFor(key) {
  let entry = entries.get(key);
  if (!entry) {
    const cached = readCache(key);
    // fetchedAt comes from the snapshot: local patches (merged, marked read) rewrite the cache entry without new data.
    entry = { key, snapshot: cached?.value || null, fetchedAt: cached?.value?.fetchedAt || cached?.at || 0, loading: false, error: null, attemptAt: 0, resetAt: 0, promise: null, stage: '' };
    entries.set(key, entry);
  }
  return entry;
}

/** The dataset a widget shows (sync; may hold a cached snapshot while a refresh runs). Null when GitHub is not connected. */
export function datasetFor(config) {
  const info = authState().info;
  if (!info?.connected) return null;
  return entryFor(snapshotKey(info.login, config));
}

/** Ids hidden after a merge, close or mark-as-read, until the next refresh confirms (or the hold expires). */
export function hiddenIds() {
  const now = Date.now();
  for (const [id, until] of hidden) if (until < now) hidden.delete(id);
  return new Set(hidden.keys());
}
const hide = id => hidden.set(id, Date.now() + HIDE_MS);
const unhide = id => hidden.delete(id);

/** True when the widget should fetch now: no data yet, or older than its refresh interval (0 = manual). */
export function isDue(entry, minutes) {
  if (!entry || entry.loading) return false;
  const now = Date.now();
  if (entry.resetAt && now < entry.resetAt) return false;
  if (!entry.snapshot) return !entry.attemptAt || now - entry.attemptAt > RETRY_MS;
  if (!minutes) return false;
  const last = Math.max(entry.fetchedAt, entry.error ? entry.attemptAt : 0);
  return now - last >= Math.max(minutes * 60000, entry.error ? RETRY_MS : 0);
}

export function refresh(entry, config) {
  if (!entry) return Promise.resolve();
  if (entry.promise) return entry.promise;
  entry.loading = true;
  entry.attemptAt = Date.now();
  entry.stage = '';
  render();
  entry.promise = (async () => {
    try {
      const snapshot = await fetchSnapshot(getClient(), normalizeConfig(config), { onProgress: ({ stage, owner }) => { entry.stage = owner ? `Loading ${owner}` : stage; } });
      entry.snapshot = snapshot;
      entry.fetchedAt = snapshot.fetchedAt;
      entry.error = null;
      entry.resetAt = 0;
      const present = new Set([...snapshot.prs.map(pr => pr.id), ...(snapshot.notifications?.items || []).map(n => n.id)]);
      for (const id of hidden.keys()) if (!present.has(id)) hidden.delete(id);
      writeCache(entry.key, snapshot);
    } catch (error) {
      entry.error = { message: error?.message || 'GitHub did not answer. Try again.', kind: error?.kind || 'http' };
      entry.resetAt = error?.kind === 'rate' && error.resetAt ? error.resetAt : 0;
      if (error?.kind !== 'rate' && error?.kind !== 'network' && error?.kind !== 'timeout') console.warn('[still] GitHub refresh failed:', error?.kind, error?.message);
    } finally {
      entry.loading = false;
      entry.promise = null;
      entry.stage = '';
      render();
    }
  })();
  return entry.promise;
}

/** Re-fetches every mounted dataset soon (after a mutation GitHub's search needs a moment). */
let soon = 0;
export function refreshSoon(config, delay = 3000) {
  clearTimeout(soon);
  soon = setTimeout(() => { const entry = datasetFor(config); if (entry) refresh(entry, config); }, delay);
}

// Credentials changed: forget in-flight state so the next render fetches with the new account.
onAuthChange(info => {
  if (!info?.connected) { entries.clear(); hidden.clear(); }
  for (const entry of entries.values()) { entry.error = null; entry.attemptAt = 0; entry.resetAt = 0; }
  render();
});

// Another tab refreshed the same dataset: adopt its newer snapshot instead of fetching again.
globalThis.chrome?.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local' || !changes[WIDGET_CACHE_KEY]) return;
  const next = changes[WIDGET_CACHE_KEY].newValue || {};
  let changed = false;
  for (const entry of entries.values()) {
    const incoming = next[entry.key]?.value;
    if (incoming?.fetchedAt > entry.fetchedAt) { entry.snapshot = incoming; entry.fetchedAt = incoming.fetchedAt; entry.error = null; changed = true; }
  }
  if (changed) render();
});

// ------------------------------------------------------------------ lookups and local patches

export function findPullRequest(id) {
  for (const entry of entries.values()) {
    const pr = entry.snapshot?.prs?.find(p => p.id === id);
    if (pr) return pr;
  }
  return null;
}

function patchPullRequest(id, patch) {
  for (const entry of entries.values()) {
    const list = entry.snapshot?.prs;
    const index = list?.findIndex(p => p.id === id) ?? -1;
    if (index >= 0) { list[index] = { ...list[index], ...(typeof patch === 'function' ? patch(list[index]) : patch) }; writeCache(entry.key, entry.snapshot); }
  }
  render();
}

function patchRun(repo, runId, patch) {
  for (const entry of entries.values()) {
    for (const run of entry.snapshot?.runs || []) if (run.repo === repo && run.id === runId) Object.assign(run, patch);
    for (const pr of entry.snapshot?.prs || []) for (const check of pr.checks?.failing || []) if (pr.repo === repo && check.runId === runId) Object.assign(check, { rerun: true });
  }
  render();
}

function dropNotification(id) {
  for (const entry of entries.values()) {
    const items = entry.snapshot?.notifications?.items;
    const item = items?.find(n => n.id === id);
    if (item) { item.unread = false; writeCache(entry.key, entry.snapshot); }
  }
}

// ------------------------------------------------------------------ mutations

/** Each resolves after GitHub confirms; the snapshot is patched first and restored if GitHub refuses. */
export const actions = {
  async merge(pr, options, config) {
    hide(pr.id); render();
    try { const result = await mergePullRequest(getClient(), pr, options); refreshSoon(config); return result; }
    catch (error) { unhide(pr.id); render(); throw error; }
  },
  async close(pr, config) {
    hide(pr.id); render();
    try { await closePullRequest(getClient(), pr); refreshSoon(config); }
    catch (error) { unhide(pr.id); render(); throw error; }
  },
  async approve(pr, config) {
    const before = { review: pr.review, approving: false };
    patchPullRequest(pr.id, { approving: true });
    try { await approvePullRequest(getClient(), pr); patchPullRequest(pr.id, p => ({ approving: false, approvedByViewer: true, review: p.review === 'required' ? 'approved' : p.review })); refreshSoon(config); }
    catch (error) { patchPullRequest(pr.id, before); throw error; }
  },
  async autoMerge(pr, enabled, method, config) {
    const before = { autoMerge: pr.autoMerge };
    patchPullRequest(pr.id, { autoMerge: enabled ? { enabledAt: new Date().toISOString(), method } : null });
    try { await setAutoMerge(getClient(), pr, enabled, { method }); refreshSoon(config); }
    catch (error) { patchPullRequest(pr.id, before); throw error; }
  },
  async ready(pr, config) {
    patchPullRequest(pr.id, { draft: false });
    try { await markReadyForReview(getClient(), pr); refreshSoon(config); }
    catch (error) { patchPullRequest(pr.id, { draft: true }); throw error; }
  },
  async draft(pr, config) {
    patchPullRequest(pr.id, { draft: true });
    try { await convertToDraft(getClient(), pr); refreshSoon(config); }
    catch (error) { patchPullRequest(pr.id, { draft: false }); throw error; }
  },
  async updateBranch(pr, config) {
    patchPullRequest(pr.id, { updating: true });
    try { await updateBranch(getClient(), pr); patchPullRequest(pr.id, { updating: false, mergeState: 'UNKNOWN', checks: { ...pr.checks, state: pr.checks?.state ? 'pending' : null } }); refreshSoon(config, 8000); }
    catch (error) { patchPullRequest(pr.id, { updating: false }); throw error; }
  },
  async rerun(repo, runId, config) {
    await rerunFailedJobs(getClient(), { repo, runId });
    patchRun(repo, runId, { rerun: true });
    refreshSoon(config, 15000);
  },
  async markRead(id) {
    hide(id); render();
    try { await markNotificationRead(getClient(), id); dropNotification(id); }
    catch (error) { unhide(id); render(); throw error; }
  },
  async markAllRead(ids) {
    for (const id of ids) hide(id);
    render();
    try { await markAllNotificationsRead(getClient()); for (const id of ids) dropNotification(id); }
    catch (error) { for (const id of ids) unhide(id); render(); throw error; }
  },
};
