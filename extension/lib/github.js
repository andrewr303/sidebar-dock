// GitHub for the dashboard: a small REST + GraphQL client, the open pull request sweep across every owner the token can see,
// pull request mutations, the OAuth device flow and the pure helpers the widget renders with (status, filters, grouping).
// fetch is injectable for tests. Tokens never reach error messages, logs or the widget cache (snapshots hold no secrets).
import { redactToken } from './accounts.js';

export const API = 'https://api.github.com';
export const WEB = 'https://github.com';
/** Host access the client needs. Device sign-in also talks to github.com. */
export const API_ORIGINS = ['https://api.github.com/*'];
export const DEVICE_ORIGINS = ['https://github.com/*', 'https://api.github.com/*'];
export const RECOMMENDED_SCOPES = Object.freeze(['repo', 'read:org', 'workflow', 'notifications']);
export const DEVICE_SCOPE = RECOMMENDED_SCOPES.join(' ');
export const CLASSIC_TOKEN_URL = `${WEB}/settings/tokens/new?scopes=${RECOMMENDED_SCOPES.join(',')}&description=Still%20dashboard`;
export const FINE_GRAINED_TOKEN_URL = `${WEB}/settings/personal-access-tokens/new`;
export const OAUTH_APPS_URL = `${WEB}/settings/developers`;
export const COPILOT_URL = `${WEB}/copilot`;
export const COPILOT_AGENTS_URL = `${WEB}/copilot/agents`;
/** The Copilot coding agent's app slug (search: author:app/copilot-swe-agent, assignee:app/copilot-swe-agent). */
export const COPILOT_APP = 'copilot-swe-agent';

// ------------------------------------------------------------------ errors

/** kind: auth | forbidden | rate | not_found | not_mergeable | conflict | invalid | server | network | timeout | graphql */
export class GitHubError extends Error {
  constructor(message, { kind = 'http', status = 0, resetAt = null, details = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    Object.assign(this, { kind, status, resetAt, details });
  }
}

const clockTime = ms => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Turns an HTTP failure into a readable GitHubError. `context` names what was attempted ("merge this pull request"). */
export function httpError(status, body = {}, headers = null, { context = '', token = '' } = {}) {
  const raw = typeof body?.message === 'string' ? body.message : '';
  const detail = Array.isArray(body?.errors) ? body.errors.map(e => (typeof e === 'string' ? e : e?.message)).filter(Boolean).join(' ') : '';
  const said = redactToken([raw, detail].filter(Boolean).join(' ').trim(), token);
  const header = name => headers?.get?.(name) ?? null;
  const reset = Number(header('x-ratelimit-reset'));
  const retryAfter = Number(header('retry-after'));
  const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Number.isFinite(retryAfter) && retryAfter > 0 ? Date.now() + retryAfter * 1000 : null;
  const what = context ? ` to ${context}` : '';
  if (status === 401) return new GitHubError('GitHub did not accept the saved credentials. Reconnect GitHub and try again.', { kind: 'auth', status });
  if ((status === 403 || status === 429) && (header('x-ratelimit-remaining') === '0' || /rate limit/i.test(raw) || status === 429)) {
    return new GitHubError(resetAt ? `GitHub’s rate limit is used up until ${clockTime(resetAt)}. Showing saved results until then.`
      : 'GitHub is limiting requests right now. Try again in a few minutes.', { kind: 'rate', status, resetAt });
  }
  if (status === 403) {
    if (/SAML/i.test(raw)) return new GitHubError(`${said} Authorize the token for this organization on GitHub, then try again.`.trim(), { kind: 'forbidden', status });
    return new GitHubError(said ? `GitHub refused${what}: ${said}` : `Your token does not have permission${what}. Check its scopes on GitHub.`, { kind: 'forbidden', status });
  }
  if (status === 404) return new GitHubError(`GitHub could not find that${context ? ` (${context})` : ''}. It may be private to a token without access.`, { kind: 'not_found', status });
  if (status === 405) return new GitHubError(said ? `GitHub cannot ${context || 'do that'} yet: ${said}` : `This pull request cannot be merged yet. Check its required reviews and checks.`, { kind: 'not_mergeable', status });
  if (status === 409) return new GitHubError(said ? `GitHub reported a conflict: ${said}` : 'The pull request changed on GitHub. Refresh and try again.', { kind: 'conflict', status });
  if (status === 422) return new GitHubError(said ? `GitHub could not ${context || 'complete that'}: ${said}` : `GitHub could not ${context || 'complete that'}.`, { kind: 'invalid', status });
  if (status >= 500) return new GitHubError(`GitHub is having trouble right now (HTTP ${status}). Try again in a minute.`, { kind: 'server', status });
  return new GitHubError(said || `GitHub returned HTTP ${status}${what}.`, { kind: 'http', status });
}

// ------------------------------------------------------------------ client

const RATE_RESOURCES = new Set(['core', 'graphql', 'search']);
const isTimeoutText = text => /timeout|timed out|couldn't respond to your request in time|took too long/i.test(String(text || ''));

/**
 * A GitHub client. getToken() resolves the current token; refreshToken() (optional) returns a fresh one after a 401
 * (the local bridge re-reads `gh auth token`), the request is retried once with it. rate() reports the last limits seen.
 */
export function createGitHubClient({ fetch: fetcher = globalThis.fetch?.bind(globalThis), getToken, refreshToken = null, timeout = 25000 } = {}) {
  if (typeof fetcher !== 'function') throw new Error('fetch is unavailable.');
  if (typeof getToken !== 'function') throw new Error('A token source is required.');
  const rate = {};

  function track(headers) {
    const remaining = Number(headers?.get?.('x-ratelimit-remaining'));
    if (!Number.isFinite(remaining)) return;
    const resource = headers.get('x-ratelimit-resource') || 'core';
    if (!RATE_RESOURCES.has(resource)) return;
    rate[resource] = { remaining, limit: Number(headers.get('x-ratelimit-limit')) || null, resetAt: (Number(headers.get('x-ratelimit-reset')) || 0) * 1000 || null };
  }

  async function request(path, { method = 'GET', body, accept = 'application/vnd.github+json', context = '', signal, retried = false, raw = false } = {}) {
    const token = await getToken();
    if (!token) throw new GitHubError('Connect GitHub first.', { kind: 'auth' });
    const url = /^https:\/\//.test(path) ? path : `${API}${path}`;
    let response;
    try {
      response = await fetcher(url, {
        method, cache: 'no-store', redirect: 'follow', signal: signal || AbortSignal.timeout(timeout),
        headers: { Accept: accept, Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new GitHubError('GitHub took too long to answer. Try again in a moment.', { kind: 'timeout' });
      throw new GitHubError('Still could not reach GitHub. Check your connection and that Still is allowed to reach api.github.com.', { kind: 'network' });
    }
    track(response.headers);
    if (response.status === 401 && !retried && typeof refreshToken === 'function') {
      const next = await refreshToken().catch(() => null);
      if (next && next !== token) return request(path, { method, body, accept, context, signal, retried: true, raw });
    }
    let data = null;
    if (response.status !== 204 && response.status !== 205) {
      const text = await response.text().catch(() => '');
      if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 200) }; } }
    }
    if (!response.ok) throw httpError(response.status, data || {}, response.headers, { context, token });
    return raw ? { data, headers: response.headers, status: response.status } : data;
  }

  /** GraphQL with partial results: resolves { data, errors }. Throws when nothing came back. */
  async function graphql(query, variables = {}, { context = '' } = {}) {
    const result = await request('/graphql', { method: 'POST', body: { query, variables }, context });
    const errors = Array.isArray(result?.errors) ? result.errors : [];
    if (!result?.data || Object.values(result.data).every(v => v == null) && errors.length) {
      const first = errors[0] || {};
      const message = redactToken(String(first.message || 'GitHub returned no data.'), '');
      if (first.type === 'RATE_LIMITED' || /rate limit/i.test(message)) throw new GitHubError('GitHub’s GraphQL rate limit is used up. Showing saved results until it resets.', { kind: 'rate' });
      if (isTimeoutText(message)) throw new GitHubError('GitHub took too long to answer that query.', { kind: 'timeout' });
      if (first.type === 'FORBIDDEN' || /SAML/i.test(message)) throw new GitHubError(message, { kind: 'forbidden' });
      if (first.type === 'NOT_FOUND') throw new GitHubError(message, { kind: 'not_found' });
      throw new GitHubError(context ? `GitHub could not ${context}: ${message}` : message, { kind: 'graphql' });
    }
    if (result.data.rateLimit) {
      const r = result.data.rateLimit;
      rate.graphql = { remaining: r.remaining, limit: r.limit, resetAt: Date.parse(r.resetAt) || null, cost: r.cost };
    }
    return { data: result.data, errors };
  }

  return { request, graphql, rate: () => structuredClone(rate) };
}

// ------------------------------------------------------------------ queries

export const PR_FIELDS = `fragment PR on PullRequest {
  id number title url isDraft createdAt updatedAt viewerDidAuthor viewerCanUpdate
  viewerCanEnableAutoMerge viewerCanDisableAutoMerge viewerCanUpdateBranch viewerCanMergeAsAdmin
  author { login avatarUrl(size: 64) __typename }
  repository { nameWithOwner isPrivate viewerPermission owner { login }
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed viewerDefaultMergeMethod }
  headRefName baseRefName headRefOid additions deletions changedFiles
  comments { totalCount }
  reviewDecision mergeable mergeStateStatus
  autoMergeRequest { enabledAt mergeMethod }
  labels(first: 6) { nodes { name color } }
  assignees(first: 4) { nodes { login avatarUrl(size: 64) } }
  reviewRequests(first: 6) { nodes { requestedReviewer { __typename ... on User { login avatarUrl(size: 64) } ... on Team { name slug } ... on Bot { login avatarUrl(size: 64) } } } }
  latestReviews(first: 6) { nodes { state author { login avatarUrl(size: 64) } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 60) { totalCount nodes { __typename
    ... on CheckRun { name conclusion status detailsUrl checkSuite { workflowRun { databaseId workflow { name } } } }
    ... on StatusContext { context state targetUrl } } } } } } }
}`;

export const VIEWER_QUERY = `query Viewer { viewer { login name avatarUrl(size: 96) organizations(first: 100) { nodes { login avatarUrl(size: 64) } } } rateLimit { cost remaining limit resetAt } }`;

export const SEARCH_PRS_QUERY = `query Search($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) { issueCount pageInfo { hasNextPage endCursor } nodes { __typename ...PR } }
  rateLimit { cost remaining limit resetAt }
}
${PR_FIELDS}`;

/** The viewer's own lists in one round trip: review requests, assigned and authored pull requests anywhere on GitHub. */
export const FACETS_QUERY = `query Facets($review: String!, $assigned: String!, $mine: String!, $first: Int!) {
  review: search(query: $review, type: ISSUE, first: $first) { issueCount nodes { __typename ...PR } }
  assigned: search(query: $assigned, type: ISSUE, first: $first) { issueCount nodes { __typename ...PR } }
  mine: search(query: $mine, type: ISSUE, first: $first) { issueCount nodes { __typename ...PR } }
  rateLimit { cost remaining limit resetAt }
}
${PR_FIELDS}`;

export const COPILOT_ISSUES_QUERY = `query CopilotIssues($q: String!, $first: Int!) {
  search(query: $q, type: ISSUE, first: $first) { issueCount nodes { __typename ... on Issue {
    id number title url createdAt updatedAt repository { nameWithOwner } author { login avatarUrl(size: 64) }
    closedByPullRequestsReferences(first: 1, includeClosedPrs: false) { nodes { number url isDraft title } } } } }
  rateLimit { cost remaining limit resetAt }
}`;

export const MUTATIONS = Object.freeze({
  enableAutoMerge: `mutation($id: ID!, $method: PullRequestMergeMethod) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { pullRequest { id autoMergeRequest { enabledAt mergeMethod } } } }`,
  disableAutoMerge: `mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { id autoMergeRequest { enabledAt } } } }`,
  readyForReview: `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id isDraft } } }`,
  convertToDraft: `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id isDraft } } }`,
});

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** Normalizes a GitHub owner name ('@acme', 'https://github.com/acme' -> 'acme'); '' when invalid. */
export function cleanOwner(value) {
  const text = String(value || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\/.*$/, '');
  return OWNER_RE.test(text) ? text : '';
}
export function cleanRepo(value) {
  const text = String(value || '').trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\/+$/, '').replace(/\.git$/, '');
  return REPO_RE.test(text) ? text : '';
}
const unique = list => [...new Set(list)];
const lowerSet = list => new Set((list || []).map(v => String(v).toLowerCase()));

/** Search string for every open pull request of one owner (org: for organizations, user: for people and extra owners). */
export function ownerSearch({ login, type = 'user' }, extra = '') {
  return `is:pr is:open archived:false ${type === 'org' ? 'org' : 'user'}:${login} ${extra}`.trim() + ' sort:updated-desc';
}

/** The facet searches (review requests include team requests). */
export function facetSearches() {
  const base = 'is:pr is:open archived:false';
  return { review: `${base} review-requested:@me sort:updated-desc`, assigned: `${base} assignee:@me sort:updated-desc`, mine: `${base} author:@me sort:updated-desc` };
}

/**
 * Splits owner qualifiers into searches that stay under GitHub's 256-character query limit. Several user:/org: qualifiers in
 * one search are OR'ed. prefix e.g. 'is:pr is:open author:app/copilot-swe-agent'.
 */
export function chunkedOwnerSearches(prefix, owners, { limit = 240 } = {}) {
  const out = [];
  let current = [];
  const build = parts => `${prefix} ${parts.join(' ')}`.trim();
  for (const owner of owners) {
    const part = `${owner.type === 'org' ? 'org' : 'user'}:${owner.login}`;
    if (current.length && build([...current, part]).length > limit) { out.push(build(current)); current = []; }
    current.push(part);
  }
  if (current.length) out.push(build(current));
  return out;
}

/** Owners to sweep: the viewer, their organizations and extra owners, minus excluded ones. */
export function ownersToSweep({ login, orgs = [] }, { extraOwners = [], excludeOwners = [] } = {}) {
  const excluded = lowerSet(excludeOwners);
  const seen = new Set();
  const out = [];
  const add = (name, type) => {
    const clean = cleanOwner(name);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key) || excluded.has(key)) return;
    seen.add(key);
    out.push({ login: clean, type });
  };
  if (login) add(login, 'user');
  for (const org of orgs) add(org.login || org, 'org');
  for (const owner of extraOwners) add(owner, 'user');
  return out;
}

// ------------------------------------------------------------------ normalization

const CHECK_FAILURES = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'ERROR', 'CANCELLED']);
const BOT_RE = /(\[bot\]$|^dependabot|^renovate|^github-actions|^snyk-bot|^greenkeeper|^codecov|^netlify|^vercel|^imgbot|^allcontributors|^mergify|^pre-commit-ci)/i;
export const COPILOT_LOGINS = new Set(['copilot', 'copilot-swe-agent', 'copilot-swe-agent[bot]']);

export const isCopilotLogin = login => COPILOT_LOGINS.has(String(login || '').toLowerCase());
export const isBotLogin = (login, typename = '') => typename === 'Bot' || BOT_RE.test(String(login || ''));

/** One rollup context -> { name, state: failure|pending|success|neutral|skipped, url, runId, workflow, kind }. */
export function normalizeCheck(node) {
  if (!node) return null;
  if (node.__typename === 'StatusContext' || 'context' in node) {
    const state = String(node.state || '').toUpperCase();
    return { name: String(node.context || 'Status'), kind: 'status', url: node.targetUrl || '', runId: null, workflow: '',
      state: state === 'SUCCESS' ? 'success' : state === 'PENDING' || state === 'EXPECTED' ? 'pending' : 'failure' };
  }
  const status = String(node.status || '').toUpperCase();
  const conclusion = String(node.conclusion || '').toUpperCase();
  const run = node.checkSuite?.workflowRun;
  const state = status && status !== 'COMPLETED' ? 'pending'
    : CHECK_FAILURES.has(conclusion) ? 'failure'
    : conclusion === 'SUCCESS' ? 'success'
    : conclusion === 'SKIPPED' ? 'skipped'
    : conclusion === 'NEUTRAL' || conclusion === 'STALE' ? 'neutral' : 'pending';
  return { name: String(node.name || 'Check'), kind: 'check', url: node.detailsUrl || '', runId: Number(run?.databaseId) || null, workflow: run?.workflow?.name || '',
    state, conclusion: conclusion.toLowerCase() || null };
}

/**
 * Commit status rollup -> { state: success|failure|pending|null, total, passing, skipped, failing: [], pending: [] }.
 * Failing and pending contexts are kept (capped) so the widget can show them without another request.
 */
export function summarizeRollup(rollup, { keep = 12 } = {}) {
  if (!rollup) return { state: null, total: 0, passing: 0, skipped: 0, failing: [], pending: [] };
  const contexts = (rollup.contexts?.nodes || []).map(normalizeCheck).filter(Boolean);
  const failing = contexts.filter(c => c.state === 'failure');
  const pending = contexts.filter(c => c.state === 'pending');
  const passing = contexts.filter(c => c.state === 'success' || c.state === 'neutral').length;
  const skipped = contexts.filter(c => c.state === 'skipped').length;
  const rolled = String(rollup.state || '').toUpperCase();
  const state = rolled === 'SUCCESS' ? 'success' : rolled === 'FAILURE' || rolled === 'ERROR' ? 'failure'
    : rolled === 'PENDING' || rolled === 'EXPECTED' ? 'pending'
    : failing.length ? 'failure' : pending.length ? 'pending' : contexts.length ? 'success' : null;
  return { state, total: Number(rollup.contexts?.totalCount) || contexts.length, passing, skipped, failing: failing.slice(0, keep), pending: pending.slice(0, keep) };
}

const METHOD_ORDER = ['squash', 'merge', 'rebase'];
/** Merge methods a repository allows, in GitHub's order, and the one to preselect. */
export function mergeMethodsFor(repo = {}) {
  const allowed = [];
  if (repo.squashMergeAllowed ?? repo.squash) allowed.push('squash');
  if (repo.mergeCommitAllowed ?? repo.merge) allowed.push('merge');
  if (repo.rebaseMergeAllowed ?? repo.rebase) allowed.push('rebase');
  const preferred = String(repo.viewerDefaultMergeMethod || repo.default || '').toLowerCase();
  const methods = allowed.length ? allowed.sort((a, b) => METHOD_ORDER.indexOf(a) - METHOD_ORDER.indexOf(b)) : ['merge'];
  return { methods, default: methods.includes(preferred) ? preferred : methods[0] };
}
/** Picks the method to use: the requested one when allowed, else the repository default. */
export function chooseMergeMethod(merge, requested) {
  const methods = merge?.methods?.length ? merge.methods : ['merge'];
  return methods.includes(requested) ? requested : methods.includes(merge?.default) ? merge.default : methods[0];
}
export const MERGE_METHOD_LABELS = Object.freeze({ squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' });

const person = node => node?.login ? { login: String(node.login), avatarUrl: node.avatarUrl || '' } : null;
const reviewDecision = value => ({ APPROVED: 'approved', CHANGES_REQUESTED: 'changes', REVIEW_REQUIRED: 'required' })[value] || null;

/** GraphQL PullRequest node -> the compact record the widget stores and renders. Returns null for anything else. */
export function normalizePullRequest(node, { viewer = '' } = {}) {
  if (!node || typeof node.id !== 'string' || typeof node.url !== 'string' || (node.__typename && node.__typename !== 'PullRequest')) return null;
  const repo = node.repository || {};
  const [owner, name] = String(repo.nameWithOwner || '/').split('/');
  const authorLogin = node.author?.login || 'ghost';
  const requested = (node.reviewRequests?.nodes || []).map(n => n?.requestedReviewer).filter(Boolean).map(r => r.__typename === 'Team'
    ? { team: r.name || r.slug, login: '', avatarUrl: '' } : { login: r.login || '', avatarUrl: r.avatarUrl || '' }).filter(r => r.login || r.team);
  return {
    id: node.id, number: Number(node.number) || 0, title: String(node.title || ''), url: node.url,
    draft: !!node.isDraft, createdAt: node.createdAt || null, updatedAt: node.updatedAt || node.createdAt || null,
    author: { login: authorLogin, avatarUrl: node.author?.avatarUrl || '', bot: isBotLogin(authorLogin, node.author?.__typename), copilot: isCopilotLogin(authorLogin) },
    repo: repo.nameWithOwner || '', owner: repo.owner?.login || owner || '', name: name || '', private: !!repo.isPrivate,
    permission: repo.viewerPermission || null,
    merge: { ...mergeMethodsFor(repo), autoAllowed: !!repo.autoMergeAllowed },
    head: node.headRefName || '', base: node.baseRefName || '', headOid: node.headRefOid || '',
    additions: Number(node.additions) || 0, deletions: Number(node.deletions) || 0, files: Number(node.changedFiles) || 0,
    comments: Number(node.comments?.totalCount) || 0,
    review: reviewDecision(node.reviewDecision),
    mergeable: node.mergeable || 'UNKNOWN', mergeState: node.mergeStateStatus || 'UNKNOWN',
    autoMerge: node.autoMergeRequest ? { enabledAt: node.autoMergeRequest.enabledAt || null, method: String(node.autoMergeRequest.mergeMethod || '').toLowerCase() || null } : null,
    labels: (node.labels?.nodes || []).filter(Boolean).map(l => ({ name: String(l.name || ''), color: /^[0-9a-f]{6}$/i.test(l.color || '') ? l.color.toLowerCase() : '8b949e' })),
    assignees: (node.assignees?.nodes || []).map(person).filter(Boolean),
    requested,
    reviews: (node.latestReviews?.nodes || []).filter(r => r?.author?.login).map(r => ({ login: r.author.login, avatarUrl: r.author.avatarUrl || '', state: String(r.state || '').toLowerCase() })),
    checks: summarizeRollup(node.commits?.nodes?.[0]?.commit?.statusCheckRollup),
    can: {
      update: !!node.viewerCanUpdate, autoMerge: !!node.viewerCanEnableAutoMerge, disableAutoMerge: !!node.viewerCanDisableAutoMerge,
      updateBranch: !!node.viewerCanUpdateBranch, adminMerge: !!node.viewerCanMergeAsAdmin,
      merge: ['ADMIN', 'MAINTAIN', 'WRITE'].includes(repo.viewerPermission),
    },
    mine: !!node.viewerDidAuthor || (!!viewer && authorLogin.toLowerCase() === String(viewer).toLowerCase()),
  };
}

/** Adds PR nodes into a Map by id (later copies win only when they are newer). Returns the number of new entries. */
export function mergeInto(map, nodes, options) {
  let added = 0;
  for (const node of nodes || []) {
    const pr = node?.number !== undefined && node?.checks ? node : normalizePullRequest(node, options);
    if (!pr) continue;
    const previous = map.get(pr.id);
    if (!previous) added++;
    if (!previous || Date.parse(pr.updatedAt || 0) >= Date.parse(previous.updatedAt || 0)) map.set(pr.id, pr);
  }
  return added;
}

export function normalizeCopilotIssue(node) {
  if (!node?.id || !node.url) return null;
  const pr = node.closedByPullRequestsReferences?.nodes?.[0] || null;
  return { id: node.id, number: Number(node.number) || 0, title: String(node.title || ''), url: node.url, repo: node.repository?.nameWithOwner || '',
    createdAt: node.createdAt || null, updatedAt: node.updatedAt || null, author: person(node.author),
    pr: pr ? { number: Number(pr.number) || 0, url: pr.url, draft: !!pr.isDraft, title: String(pr.title || '') } : null };
}

/** REST API URL of a notification subject -> its page on github.com. */
export function notificationUrl(subjectUrl, repo = '') {
  const match = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(pulls|issues|commits|releases|discussions)\/([^/?#]+)/.exec(String(subjectUrl || ''));
  if (match) {
    const [, full, kind, id] = match;
    if (kind === 'pulls') return `${WEB}/${full}/pull/${id}`;
    if (kind === 'releases') return `${WEB}/${full}/releases`;
    return `${WEB}/${full}/${kind === 'commits' ? 'commit' : kind}/${id}`;
  }
  return repo ? `${WEB}/${repo}` : `${WEB}/notifications`;
}

export function normalizeNotification(entry) {
  if (!entry?.id) return null;
  const repo = entry.repository?.full_name || '';
  return { id: String(entry.id), reason: String(entry.reason || ''), unread: entry.unread !== false, updatedAt: entry.updated_at || null,
    title: String(entry.subject?.title || 'Notification'), type: String(entry.subject?.type || ''), repo, url: notificationUrl(entry.subject?.url, repo) };
}

const FAILED_RUN = new Set(['failure', 'timed_out', 'startup_failure']);
/**
 * Recent workflow runs of one repository -> failures still current: the newest run of each workflow on each branch failed,
 * and for pull request branches the run is for the head commit still under review.
 */
export function currentFailures(runs, { repo, heads = new Map(), since = Date.now() - 7 * 86400000 } = {}) {
  const latest = new Map();
  for (const run of runs || []) {
    if (!run?.id) continue;
    const key = `${run.workflow_id}:${run.head_branch}`;
    const existing = latest.get(key);
    if (!existing || Date.parse(run.created_at) > Date.parse(existing.created_at)) latest.set(key, run);
  }
  const out = [];
  for (const run of latest.values()) {
    if (!FAILED_RUN.has(run.conclusion) || Date.parse(run.created_at) < since) continue;
    const head = heads.get(run.head_branch);
    if (head && run.head_sha && head !== run.head_sha) continue;
    out.push({ id: Number(run.id), repo: repo || run.repository?.full_name || '', workflow: String(run.name || 'Workflow'), title: String(run.display_title || run.head_commit?.message || '').split('\n')[0],
      branch: run.head_branch || '', event: run.event || '', url: run.html_url || '', createdAt: run.created_at || null, attempt: Number(run.run_attempt) || 1,
      conclusion: run.conclusion, actor: run.actor?.login || '', pr: !!head });
  }
  return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

// ------------------------------------------------------------------ status, filters, grouping

export const STATUS_META = Object.freeze({
  failing: { label: 'Checks failing', short: 'Failing', icon: 'circle-x', tone: 'danger', rank: 0 },
  conflict: { label: 'Has conflicts', short: 'Conflicts', icon: 'triangle-alert', tone: 'danger', rank: 1 },
  changes: { label: 'Changes requested', short: 'Changes', icon: 'circle-alert', tone: 'warning', rank: 2 },
  review: { label: 'Review required', short: 'Review', icon: 'eye', tone: 'neutral', rank: 3 },
  pending: { label: 'Checks running', short: 'Running', icon: 'loader-circle', tone: 'neutral', rank: 4 },
  ready: { label: 'Ready to merge', short: 'Ready', icon: 'git-merge', tone: 'success', rank: 5 },
  queued: { label: 'Auto-merge on', short: 'Auto-merge', icon: 'zap', tone: 'success', rank: 6 },
  draft: { label: 'Draft', short: 'Draft', icon: 'git-pull-request-draft', tone: 'neutral', rank: 7 },
});

/** One status per pull request, most urgent first. */
export function prStatus(pr) {
  if (!pr) return 'review';
  if (pr.draft) return 'draft';
  if (pr.checks?.state === 'failure') return 'failing';
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') return 'conflict';
  if (pr.review === 'changes') return 'changes';
  if (pr.autoMerge) return 'queued';
  if (pr.checks?.state === 'pending') return 'pending';
  if (pr.review === 'required' || pr.mergeState === 'BLOCKED') return 'review';
  return 'ready';
}

/** Copilot coding agent pull requests: "Working" while the agent's draft is marked [WIP]. */
export function copilotState(pr) {
  if (pr.checks?.state === 'failure') return { label: 'Checks failing', tone: 'danger', icon: 'circle-x' };
  if (pr.draft && /^\s*\[wip\]/i.test(pr.title)) return { label: 'Working', tone: 'info', icon: 'loader-circle' };
  if (pr.draft) return { label: 'Draft', tone: 'neutral', icon: 'git-pull-request-draft' };
  return { label: 'Ready for review', tone: 'success', icon: 'eye' };
}

export const TABS = Object.freeze([
  { id: 'all', label: 'All', icon: 'git-pull-request' },
  { id: 'mine', label: 'Mine', icon: 'user' },
  { id: 'reviews', label: 'Reviews', icon: 'eye' },
  { id: 'assigned', label: 'Assigned', icon: 'user-round' },
  { id: 'drafts', label: 'Drafts', icon: 'git-pull-request-draft' },
  { id: 'failing', label: 'Failing', icon: 'circle-x' },
  { id: 'copilot', label: 'Copilot', icon: 'bot' },
  { id: 'notifications', label: 'Inbox', icon: 'bell' },
]);
export const TAB_IDS = TABS.map(t => t.id);
export const DEFAULT_TABS = Object.freeze(['all', 'mine', 'reviews', 'assigned', 'failing', 'copilot', 'notifications']);

export const DEFAULT_CONFIG = Object.freeze({
  tab: 'reviews', tabs: [...DEFAULT_TABS], extraOwners: [], excludeOwners: [], excludeRepos: [], hideDrafts: false, hideBots: true,
  groupBy: 'none', sort: 'updated', density: 'comfortable', refresh: 5, maxPerOwner: 300, ciRepos: 6, showCi: true,
});

/** Config with defaults and sane ranges (widget config is user-editable). */
export function normalizeConfig(config = {}) {
  const c = { ...DEFAULT_CONFIG, ...(config || {}) };
  const tabs = unique((Array.isArray(c.tabs) ? c.tabs : DEFAULT_TABS).filter(t => TAB_IDS.includes(t)));
  return {
    ...c,
    tabs: tabs.length ? TAB_IDS.filter(t => tabs.includes(t)) : [...DEFAULT_TABS],
    tab: TAB_IDS.includes(c.tab) ? c.tab : 'reviews',
    extraOwners: unique((c.extraOwners || []).map(cleanOwner).filter(Boolean)).slice(0, 20),
    excludeOwners: unique((c.excludeOwners || []).map(cleanOwner).filter(Boolean)),
    excludeRepos: unique((c.excludeRepos || []).map(cleanRepo).filter(Boolean)),
    groupBy: ['none', 'repo', 'owner', 'status'].includes(c.groupBy) ? c.groupBy : 'none',
    sort: ['updated', 'created', 'repo', 'status'].includes(c.sort) ? c.sort : 'updated',
    density: c.density === 'compact' ? 'compact' : 'comfortable',
    refresh: [0, 2, 5, 10, 30].includes(Number(c.refresh)) ? Number(c.refresh) : 5,
    maxPerOwner: Math.max(50, Math.min(1000, Math.round(Number(c.maxPerOwner) / 50) * 50 || 300)),
    ciRepos: Math.max(0, Math.min(12, Math.round(Number(c.ciRepos)) || 0)),
    hideDrafts: !!c.hideDrafts, hideBots: c.hideBots !== false, showCi: c.showCi !== false,
  };
}

/** Pull requests visible under the widget's owner/repo/draft/bot filters (before the tab). */
export function baseFilter(prs, config, { hidden = new Set() } = {}) {
  const c = normalizeConfig(config);
  const owners = lowerSet(c.excludeOwners);
  const repos = lowerSet(c.excludeRepos);
  return (prs || []).filter(pr => !hidden.has(pr.id)
    && !owners.has(pr.owner.toLowerCase()) && !repos.has(pr.repo.toLowerCase())
    && !(c.hideBots && pr.author.bot && !pr.author.copilot));
}

/** Pull requests for one tab. facets: { review: [ids], assigned: [ids] }. */
export function tabPullRequests(prs, tab, { facets = {}, config = {} } = {}) {
  const c = normalizeConfig(config);
  const review = new Set(facets.review || []);
  const assigned = new Set(facets.assigned || []);
  const visible = tab === 'drafts' || !c.hideDrafts ? prs : prs.filter(pr => !pr.draft);
  switch (tab) {
    case 'mine': return visible.filter(pr => pr.mine);
    case 'reviews': return visible.filter(pr => review.has(pr.id));
    case 'assigned': return visible.filter(pr => assigned.has(pr.id));
    case 'drafts': return visible.filter(pr => pr.draft && (pr.mine || assigned.has(pr.id)));
    case 'failing': return visible.filter(pr => pr.checks?.state === 'failure');
    case 'copilot': return prs.filter(pr => pr.author.copilot);
    case 'all': return visible;
    default: return [];
  }
}

export function sortPullRequests(prs, sort = 'updated') {
  const time = (pr, key) => Date.parse(pr[key] || 0) || 0;
  const byUpdated = (a, b) => time(b, 'updatedAt') - time(a, 'updatedAt');
  const list = [...prs];
  if (sort === 'created') return list.sort((a, b) => time(b, 'createdAt') - time(a, 'createdAt'));
  if (sort === 'repo') return list.sort((a, b) => a.repo.localeCompare(b.repo) || byUpdated(a, b));
  if (sort === 'status') return list.sort((a, b) => STATUS_META[prStatus(a)].rank - STATUS_META[prStatus(b)].rank || byUpdated(a, b));
  return list.sort(byUpdated);
}

/** [{ key, label, items }] in display order; groupBy 'none' gives one unlabeled group. */
export function groupPullRequests(prs, groupBy = 'none') {
  if (groupBy === 'none') return [{ key: 'all', label: '', items: prs }];
  const groups = new Map();
  for (const pr of prs) {
    const key = groupBy === 'repo' ? pr.repo : groupBy === 'owner' ? pr.owner : prStatus(pr);
    if (!groups.has(key)) groups.set(key, { key, label: groupBy === 'status' ? STATUS_META[key]?.label || key : key, items: [] });
    groups.get(key).items.push(pr);
  }
  const list = [...groups.values()];
  if (groupBy === 'status') return list.sort((a, b) => STATUS_META[a.key].rank - STATUS_META[b.key].rank);
  return list.sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key));
}

/** Counts for the summary tiles and tab badges. */
export function summarize(snapshot, config, { hidden } = {}) {
  const prs = baseFilter(snapshot?.prs || [], config, { hidden });
  const facets = snapshot?.facets || {};
  const counts = {};
  for (const tab of TAB_IDS) counts[tab] = tab === 'notifications' ? (snapshot?.notifications?.items || []).filter(n => n.unread && !hidden?.has(n.id)).length
    : tabPullRequests(prs, tab, { facets, config }).length;
  return counts;
}

// ------------------------------------------------------------------ fetching

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await fn(items[index], index); }
  }));
  return results;
}
const settled = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
const warningText = (error, label) => `${label}: ${error?.message || 'GitHub did not answer.'}`;

/**
 * Pages through one search. Halves the page size when GitHub times out (large rollups make big pages slow).
 * Returns { nodes, total, errors }.
 */
export async function searchAll(client, q, { max = 300, pageSize = 50, minPageSize = 10 } = {}) {
  const nodes = [];
  const errors = [];
  let after = null;
  let total = 0;
  let size = pageSize;
  while (nodes.length < max) {
    const first = Math.max(1, Math.min(size, 100, max - nodes.length));
    let result;
    try { result = await client.graphql(SEARCH_PRS_QUERY, { q, first, after }); }
    catch (error) {
      if ((error.kind === 'timeout' || error.kind === 'server') && size > minPageSize) { size = Math.max(minPageSize, Math.floor(size / 2)); continue; }
      throw error;
    }
    errors.push(...result.errors);
    const search = result.data?.search;
    if (!search) break;
    total = Number(search.issueCount) || total;
    nodes.push(...(search.nodes || []).filter(Boolean));
    if (!search.pageInfo?.hasNextPage || !search.pageInfo.endCursor) break;
    after = search.pageInfo.endCursor;
  }
  return { nodes, total, errors };
}

/**
 * Everything the widget shows, as one cacheable snapshot (no secrets):
 * { viewer, owners, prs, facets: { review, assigned }, totals, copilot: { issues, error }, notifications: { items, more, error },
 *   runs, runsError, warnings, rate, fetchedAt }.
 */
export async function fetchSnapshot(client, config = {}, { onProgress = () => {} } = {}) {
  const c = normalizeConfig(config);
  const viewerResult = await client.graphql(VIEWER_QUERY, {}, { context: 'read your GitHub profile' });
  const v = viewerResult.data.viewer || {};
  const viewer = { login: v.login || '', name: v.name || '', avatarUrl: v.avatarUrl || '', orgs: (v.organizations?.nodes || []).filter(Boolean).map(o => ({ login: o.login, avatarUrl: o.avatarUrl || '' })) };
  const owners = ownersToSweep(viewer, c);
  const map = new Map();
  const warnings = [];
  const normalize = { viewer: viewer.login };
  onProgress({ stage: 'facets' });
  const facetQueries = facetSearches();
  const facets = { review: [], assigned: [], mine: [] };
  const facetResult = await settled(client.graphql(FACETS_QUERY, { ...facetQueries, first: 50 }));
  if (facetResult.ok) {
    for (const key of Object.keys(facets)) {
      const nodes = facetResult.value.data?.[key]?.nodes || [];
      mergeInto(map, nodes, normalize);
      facets[key] = nodes.map(n => n?.id).filter(Boolean);
    }
  } else if (facetResult.error.kind === 'auth' || facetResult.error.kind === 'rate') throw facetResult.error;
  else warnings.push(warningText(facetResult.error, 'Your review requests'));

  const totals = {};
  let lastError = facetResult.ok ? null : facetResult.error;
  const sweeps = await pool(owners, 3, async owner => {
    onProgress({ stage: 'owner', owner: owner.login });
    return settled(searchAll(client, ownerSearch(owner), { max: c.maxPerOwner }));
  });
  sweeps.forEach((result, i) => {
    const owner = owners[i];
    if (!result.ok) {
      if (result.error.kind === 'auth' || result.error.kind === 'rate') throw result.error;
      warnings.push(warningText(result.error, owner.login));
      lastError = result.error;
      return;
    }
    lastError = null;
    mergeInto(map, result.value.nodes, normalize);
    totals[owner.login] = { total: result.value.total, loaded: result.value.nodes.length };
    if (result.value.errors.some(e => /SAML/i.test(e?.message || ''))) warnings.push(`${owner.login}: authorize your token for this organization’s SAML single sign-on to see all of its pull requests.`);
  });

  // Nothing loaded at all: report the failure instead of an empty list that looks like "no pull requests".
  if (!facetResult.ok && sweeps.length && sweeps.every(r => !r.ok)) throw lastError || facetResult.error;

  // Copilot coding agent: its open pull requests (beyond the per-owner cap) and the issues assigned to it.
  onProgress({ stage: 'copilot' });
  const copilot = { issues: [], error: '' };
  const copilotPrSearches = chunkedOwnerSearches(`is:pr is:open archived:false author:app/${COPILOT_APP}`, owners);
  const copilotIssueSearches = chunkedOwnerSearches(`is:issue is:open archived:false assignee:app/${COPILOT_APP}`, owners);
  const [copilotPrs, copilotIssues] = await Promise.all([
    Promise.all(copilotPrSearches.slice(0, 4).map(q => settled(searchAll(client, q, { max: 50 })))),
    Promise.all(copilotIssueSearches.slice(0, 4).map(q => settled(client.graphql(COPILOT_ISSUES_QUERY, { q, first: 30 })))),
  ]);
  for (const result of copilotPrs) if (result.ok) mergeInto(map, result.value.nodes, normalize);
  const issueMap = new Map();
  for (const result of copilotIssues) {
    if (!result.ok) { copilot.error = result.error.message; continue; }
    for (const node of result.value.data?.search?.nodes || []) { const issue = normalizeCopilotIssue(node); if (issue) issueMap.set(issue.id, issue); }
  }
  copilot.issues = [...issueMap.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const prs = [...map.values()];
  onProgress({ stage: 'extras' });
  const [notifications, ci] = await Promise.all([fetchNotifications(client), c.showCi && c.ciRepos ? fetchFailedRuns(client, prs, { repos: c.ciRepos, viewer: viewer.login }) : { runs: [], error: '' }]);
  return {
    viewer, owners, prs, facets: { review: facets.review, assigned: facets.assigned, mine: facets.mine }, totals, copilot, notifications,
    runs: ci.runs, runsError: ci.error, warnings: unique(warnings).slice(0, 4), rate: client.rate(), fetchedAt: Date.now(),
  };
}

export async function fetchNotifications(client, { perPage = 50 } = {}) {
  try {
    const { data, headers } = await client.request(`/notifications?per_page=${perPage}`, { raw: true, context: 'read your notifications' });
    const items = (Array.isArray(data) ? data : []).map(normalizeNotification).filter(Boolean);
    return { items, more: /rel="next"/.test(headers?.get?.('link') || ''), error: '' };
  } catch (error) {
    if (error.kind === 'auth') throw error;
    const message = error.kind === 'forbidden' || error.kind === 'not_found'
      ? 'Notifications need a classic token or GitHub sign-in with the notifications scope. Fine-grained tokens cannot read them.'
      : error.message;
    return { items: [], more: false, error: message };
  }
}

/** Repositories worth checking for red workflows: the viewer's pull requests first, then the busiest repositories. */
export function ciRepositories(prs, { repos = 6, viewer = '' } = {}) {
  const score = new Map();
  for (const pr of prs) {
    const entry = score.get(pr.repo) || { repo: pr.repo, mine: 0, count: 0, updated: 0 };
    entry.count++;
    if (pr.mine || pr.author.login === viewer) entry.mine++;
    entry.updated = Math.max(entry.updated, Date.parse(pr.updatedAt || 0) || 0);
    score.set(pr.repo, entry);
  }
  return [...score.values()].filter(e => e.repo).sort((a, b) => b.mine - a.mine || b.count - a.count || b.updated - a.updated).slice(0, repos).map(e => e.repo);
}

export async function fetchFailedRuns(client, prs, { repos = 6, viewer = '' } = {}) {
  const list = ciRepositories(prs, { repos, viewer });
  const errors = [];
  const results = await pool(list, 3, async repo => {
    const heads = new Map(prs.filter(pr => pr.repo === repo).map(pr => [pr.head, pr.headOid]));
    try {
      const data = await client.request(`/repos/${repo}/actions/runs?per_page=30`, { context: `read workflow runs for ${repo}` });
      return currentFailures(data?.workflow_runs || [], { repo, heads });
    } catch (error) {
      if (error.kind === 'auth' || error.kind === 'rate') throw error;
      if (error.kind !== 'not_found' && error.kind !== 'forbidden') errors.push(error.message);
      return [];
    }
  });
  return { runs: results.flat().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 30), error: errors[0] || '' };
}

// ------------------------------------------------------------------ mutations

const prPath = pr => `/repos/${pr.repo}/pulls/${pr.number}`;

export async function mergePullRequest(client, pr, { method, title, message, sha } = {}) {
  const merge_method = chooseMergeMethod(pr.merge, method);
  const body = { merge_method };
  if (title) body.commit_title = String(title).slice(0, 250);
  if (message) body.commit_message = String(message).slice(0, 65000);
  if (sha || pr.headOid) body.sha = sha || pr.headOid;
  const data = await client.request(`${prPath(pr)}/merge`, { method: 'PUT', body, context: `merge #${pr.number}` });
  if (data && data.merged === false) throw new GitHubError(data.message || 'GitHub did not merge the pull request.', { kind: 'not_mergeable' });
  return { merged: true, sha: data?.sha || '', method: merge_method };
}

export const approvePullRequest = (client, pr, { body = '' } = {}) =>
  client.request(`${prPath(pr)}/reviews`, { method: 'POST', body: { event: 'APPROVE', ...(body ? { body } : {}) }, context: `approve #${pr.number}` });

export const updateBranch = (client, pr) =>
  client.request(`${prPath(pr)}/update-branch`, { method: 'PUT', body: pr.headOid ? { expected_head_sha: pr.headOid } : {}, context: `update the branch of #${pr.number}` });

export const closePullRequest = (client, pr) =>
  client.request(prPath(pr), { method: 'PATCH', body: { state: 'closed' }, context: `close #${pr.number}` });

export const rerunFailedJobs = (client, { repo, runId }) =>
  client.request(`/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`, { method: 'POST', body: {}, context: 're-run the failed jobs' });

export const markNotificationRead = (client, id) =>
  client.request(`/notifications/threads/${encodeURIComponent(id)}`, { method: 'PATCH', context: 'mark the notification as read' });

export const markAllNotificationsRead = client =>
  client.request('/notifications', { method: 'PUT', body: { last_read_at: new Date().toISOString(), read: true }, context: 'mark notifications as read' });

export async function setAutoMerge(client, pr, enabled, { method } = {}) {
  if (enabled) {
    const merge = chooseMergeMethod(pr.merge, method).toUpperCase();
    await client.graphql(MUTATIONS.enableAutoMerge, { id: pr.id, method: merge }, { context: 'turn on auto-merge' });
  } else await client.graphql(MUTATIONS.disableAutoMerge, { id: pr.id }, { context: 'turn off auto-merge' });
  return { enabled };
}

export const markReadyForReview = (client, pr) => client.graphql(MUTATIONS.readyForReview, { id: pr.id }, { context: 'mark it ready for review' });
export const convertToDraft = (client, pr) => client.graphql(MUTATIONS.convertToDraft, { id: pr.id }, { context: 'convert it to a draft' });

// ------------------------------------------------------------------ token checks

/** Token kind from its prefix (display only). */
export function tokenKind(token = '') {
  if (/^github_pat_/.test(token)) return 'fine-grained';
  if (/^ghp_/.test(token)) return 'classic';
  if (/^gho_/.test(token)) return 'oauth';
  if (/^ghu_/.test(token)) return 'app';
  if (/^ghs_/.test(token)) return 'installation';
  return 'unknown';
}

/** Scopes from X-OAuth-Scopes; null when GitHub sends none (fine-grained and app tokens). */
export function parseScopes(header) {
  if (header == null) return null;
  return String(header).split(',').map(s => s.trim()).filter(Boolean);
}

/** Recommended scopes a classic or OAuth token lacks (repo covers repo:status etc.; write:org and admin:org cover read:org). */
export function missingScopes(scopes) {
  if (!Array.isArray(scopes)) return [];
  const have = new Set(scopes);
  const covers = { 'read:org': ['write:org', 'admin:org'], workflow: [], notifications: [], repo: [] };
  return RECOMMENDED_SCOPES.filter(scope => !have.has(scope) && !(covers[scope] || []).some(alt => have.has(alt)));
}

/** GET /user with a candidate token. Resolves { login, name, avatarUrl, scopes, kind }. */
export async function validateToken(token, { fetch: fetcher = globalThis.fetch?.bind(globalThis) } = {}) {
  const client = createGitHubClient({ fetch: fetcher, getToken: async () => token });
  const { data, headers } = await client.request('/user', { raw: true, context: 'check the token' }).catch(error => {
    if (error.kind === 'auth') throw new GitHubError('GitHub did not accept that token. Check that you copied all of it and that it has not expired or been revoked.', { kind: 'auth', status: 401 });
    throw error;
  });
  if (!data?.login) throw new GitHubError('GitHub did not return an account for that token.', { kind: 'auth' });
  return { login: String(data.login), name: String(data.name || ''), avatarUrl: String(data.avatar_url || ''), scopes: parseScopes(headers.get('x-oauth-scopes')), kind: tokenKind(token) };
}

// ------------------------------------------------------------------ OAuth device flow

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{8,80}$/;
export const validClientId = value => CLIENT_ID_RE.test(String(value || '').trim());

async function postForm(fetcher, url, params) {
  let response;
  try {
    response = await fetcher(url, { method: 'POST', cache: 'no-store', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(20000) });
  } catch { throw new GitHubError('Still could not reach github.com. Check your connection and allow access to github.com.', { kind: 'network' }); }
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, ok: response.ok, data: data || {} };
}

/** Starts device sign-in. Resolves { deviceCode, userCode, verificationUri, interval, expiresAt }. */
export async function requestDeviceCode({ clientId, scope = DEVICE_SCOPE, fetch: fetcher = globalThis.fetch?.bind(globalThis), now = Date.now } = {}) {
  const id = String(clientId || '').trim();
  if (!validClientId(id)) throw new GitHubError('Paste the client ID of your GitHub OAuth app. It looks like Ov23li… or Iv1.…', { kind: 'invalid' });
  const { ok, status, data } = await postForm(fetcher, `${WEB}/login/device/code`, { client_id: id, scope });
  if (!ok || !data.device_code) {
    if (data.error === 'device_flow_disabled') throw new GitHubError('Device sign-in is turned off for this OAuth app. Turn on “Enable Device Flow” in its settings on GitHub.', { kind: 'invalid' });
    throw new GitHubError(status === 404 || data.error === 'Not Found' || data.error === 'incorrect_client_credentials'
      ? 'GitHub does not recognise that client ID. Copy it again from your OAuth app’s settings.'
      : `GitHub could not start sign-in${data.error_description ? `: ${data.error_description}` : '.'}`, { kind: 'invalid', status });
  }
  return { deviceCode: data.device_code, userCode: data.user_code, verificationUri: data.verification_uri || `${WEB}/login/device`,
    interval: Math.max(5, Number(data.interval) || 5), expiresAt: now() + (Number(data.expires_in) || 900) * 1000 };
}

/**
 * Pure step of the device flow: given the current { interval } and one token response, says what to do next:
 * { status: 'token', token, scopes } | { status: 'pending', interval } | { status: 'expired'|'denied'|'error', message }.
 */
export function deviceFlowStep(state, data = {}) {
  const interval = Math.max(5, Number(state?.interval) || 5);
  if (typeof data.access_token === 'string' && data.access_token) return { status: 'token', token: data.access_token, scopes: parseScopes(data.scope ?? null) };
  switch (data.error) {
    case 'authorization_pending': return { status: 'pending', interval };
    case 'slow_down': return { status: 'pending', interval: Math.max(interval + 5, Number(data.interval) || 0) };
    case 'expired_token': return { status: 'expired', message: 'The sign-in code expired. Start again to get a new one.' };
    case 'access_denied': return { status: 'denied', message: 'Sign-in was cancelled on GitHub. Start again when you are ready.' };
    case 'device_flow_disabled': return { status: 'error', message: 'Device sign-in is turned off for this OAuth app. Turn on “Enable Device Flow” in its settings on GitHub.' };
    case 'incorrect_client_credentials': return { status: 'error', message: 'GitHub does not recognise that client ID. Copy it again from your OAuth app’s settings.' };
    case 'incorrect_device_code': case 'unsupported_grant_type': return { status: 'error', message: 'GitHub rejected the sign-in request. Start again.' };
    default: return { status: 'error', message: data.error_description || 'GitHub sign-in did not finish. Start again.' };
  }
}

/**
 * Polls until the user approves, honoring interval and slow_down. Resolves { token, scopes } or throws a GitHubError
 * (kind 'expired' | 'denied' | 'cancelled' | 'invalid'). sleep and now are injectable for tests.
 */
export async function pollDeviceFlow({ clientId, deviceCode, interval = 5, expiresAt, fetch: fetcher = globalThis.fetch?.bind(globalThis),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, signal } = {}) {
  let state = { interval };
  for (;;) {
    await sleep(state.interval * 1000);
    if (signal?.aborted) throw new GitHubError('Sign-in was cancelled.', { kind: 'cancelled' });
    if (expiresAt && now() > expiresAt) throw new GitHubError('The sign-in code expired. Start again to get a new one.', { kind: 'expired' });
    const { data } = await postForm(fetcher, `${WEB}/login/oauth/access_token`, { client_id: clientId, device_code: deviceCode, grant_type: DEVICE_GRANT });
    if (signal?.aborted) throw new GitHubError('Sign-in was cancelled.', { kind: 'cancelled' });
    const step = deviceFlowStep(state, data);
    if (step.status === 'token') return { token: step.token, scopes: step.scopes };
    if (step.status === 'pending') { state = { interval: step.interval }; continue; }
    throw new GitHubError(step.message, { kind: step.status === 'error' ? 'invalid' : step.status });
  }
}

// ------------------------------------------------------------------ local bridge

const TOKEN_RE = /^[A-Za-z0-9_.-]{20,255}$/;
export const looksLikeToken = value => TOKEN_RE.test(String(value || '').trim());

/** Asks the paired local bridge for the GitHub CLI token (GET /github/token). request = integrations.requestBridge. */
export async function fetchBridgeToken(request) {
  const data = await request('/github/token');
  const token = String(data?.token || '').trim();
  if (!looksLikeToken(token)) throw new GitHubError('The bridge did not return a GitHub token. Run gh auth login on this computer, or set GITHUB_TOKEN, then try again.', { kind: 'auth' });
  return { token, source: ['gh', 'GITHUB_TOKEN', 'GH_TOKEN'].includes(data.source) ? data.source : 'gh' };
}

// ------------------------------------------------------------------ cache

/** Widget-cache key for one account and fetch scope. Pull request filters that do not change the fetch share a snapshot. */
export function snapshotKey(login, config = {}) {
  const c = normalizeConfig(config);
  const scope = [c.extraOwners.map(s => s.toLowerCase()).sort().join(','), c.excludeOwners.map(s => s.toLowerCase()).sort().join(','), c.maxPerOwner, c.showCi ? c.ciRepos : 0].join('|');
  return `github:${String(login || 'anonymous').toLowerCase()}:${scope}`;
}
