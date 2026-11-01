import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import {
  createGitHubClient, GitHubError, httpError, normalizePullRequest, normalizeCheck, summarizeRollup, mergeMethodsFor, chooseMergeMethod,
  prStatus, copilotState, ownersToSweep, ownerSearch, facetSearches, chunkedOwnerSearches, searchAll, fetchSnapshot, mergeInto,
  baseFilter, tabPullRequests, sortPullRequests, groupPullRequests, summarize, normalizeConfig, currentFailures, notificationUrl,
  normalizeNotification, deviceFlowStep, requestDeviceCode, pollDeviceFlow, parseScopes, missingScopes, tokenKind, validateToken,
  mergePullRequest, setAutoMerge, fetchBridgeToken, snapshotKey, cleanOwner, cleanRepo, ciRepositories, fetchNotifications, SEARCH_PRS_QUERY,
} from '../extension/lib/github.js';
import { createBridgeServer, createGitHubTokenSource } from '../bridge/server.mjs';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const headers = map => ({ get: name => map[name.toLowerCase()] ?? null });
const jsonResponse = (status, body, extra = {}) => ({ ok: status >= 200 && status < 300, status, headers: headers(extra), text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body });

function prNode(overrides = {}) {
  return {
    __typename: 'PullRequest', id: 'PR_1', number: 12, title: 'Add search', url: 'https://github.com/acme/web/pull/12', isDraft: false,
    createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-29T10:00:00Z', viewerDidAuthor: false, viewerCanUpdate: true,
    viewerCanEnableAutoMerge: true, viewerCanDisableAutoMerge: false, viewerCanUpdateBranch: true, viewerCanMergeAsAdmin: false,
    author: { login: 'octo', avatarUrl: 'https://avatars.githubusercontent.com/u/1', __typename: 'User' },
    repository: { nameWithOwner: 'acme/web', isPrivate: true, viewerPermission: 'WRITE', owner: { login: 'acme' }, mergeCommitAllowed: true,
      squashMergeAllowed: true, rebaseMergeAllowed: false, autoMergeAllowed: true, viewerDefaultMergeMethod: 'SQUASH' },
    headRefName: 'feature/search', baseRefName: 'main', headRefOid: 'abc123', additions: 120, deletions: 8, changedFiles: 5,
    comments: { totalCount: 3 }, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', autoMergeRequest: null,
    labels: { nodes: [{ name: 'feature', color: 'A2EEEF' }, { name: 'bad', color: 'not-a-color' }] },
    assignees: { nodes: [{ login: 'maddy', avatarUrl: '' }] },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'maddy', avatarUrl: '' } }, { requestedReviewer: { __typename: 'Team', name: 'Web', slug: 'web' } }] },
    latestReviews: { nodes: [{ state: 'COMMENTED', author: { login: 'kim', avatarUrl: '' } }] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { totalCount: 4, nodes: [
      { __typename: 'CheckRun', name: 'test', conclusion: 'FAILURE', status: 'COMPLETED', detailsUrl: 'https://github.com/acme/web/actions/runs/9/job/1', checkSuite: { workflowRun: { databaseId: 9, workflow: { name: 'CI' } } } },
      { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS', status: 'COMPLETED', detailsUrl: '', checkSuite: null },
      { __typename: 'CheckRun', name: 'e2e', conclusion: null, status: 'IN_PROGRESS', detailsUrl: '', checkSuite: null },
      { __typename: 'StatusContext', context: 'deploy/preview', state: 'SUCCESS', targetUrl: 'https://preview.example' },
    ] } } } }] },
    ...overrides,
  };
}

test('normalizePullRequest flattens the GraphQL node, labels, reviewers, checks and permissions', () => {
  const pr = normalizePullRequest(prNode(), { viewer: 'maddy' });
  assert.equal(pr.repo, 'acme/web');
  assert.equal(pr.owner, 'acme');
  assert.equal(pr.review, 'required');
  assert.deepEqual(pr.merge, { methods: ['squash', 'merge'], default: 'squash', autoAllowed: true });
  assert.deepEqual(pr.labels.map(l => l.color), ['a2eeef', '8b949e']);
  assert.deepEqual(pr.requested.map(r => r.login || r.team), ['maddy', 'Web']);
  assert.equal(pr.checks.state, 'failure');
  assert.equal(pr.checks.failing[0].runId, 9);
  assert.equal(pr.checks.failing[0].workflow, 'CI');
  assert.equal(pr.checks.pending.length, 1);
  assert.equal(pr.checks.passing, 2);
  assert.equal(pr.can.merge, true);
  assert.equal(pr.mine, false);
  assert.equal(normalizePullRequest(prNode({ author: { login: 'Maddy' } }), { viewer: 'maddy' }).mine, true);
  assert.equal(normalizePullRequest({ __typename: 'Issue', id: 'I_1', url: 'x' }), null);
  assert.equal(normalizePullRequest(null), null);
});

test('rollups and checks map to readable states', () => {
  assert.equal(normalizeCheck({ __typename: 'CheckRun', status: 'QUEUED' }).state, 'pending');
  assert.equal(normalizeCheck({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'TIMED_OUT' }).state, 'failure');
  assert.equal(normalizeCheck({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' }).state, 'skipped');
  assert.equal(normalizeCheck({ __typename: 'StatusContext', context: 'ci', state: 'ERROR' }).state, 'failure');
  assert.equal(normalizeCheck({ __typename: 'StatusContext', context: 'ci', state: 'EXPECTED' }).state, 'pending');
  assert.equal(summarizeRollup(null).state, null);
  assert.equal(summarizeRollup({ state: 'SUCCESS', contexts: { nodes: [] } }).state, 'success');
  assert.equal(summarizeRollup({ state: null, contexts: { nodes: [{ __typename: 'CheckRun', status: 'IN_PROGRESS' }] } }).state, 'pending');
});

test('status picks the most urgent signal and Copilot sessions read as working while marked WIP', () => {
  const base = normalizePullRequest(prNode());
  assert.equal(prStatus(base), 'failing');
  assert.equal(prStatus({ ...base, draft: true }), 'draft');
  assert.equal(prStatus({ ...base, checks: { state: 'success' }, mergeable: 'CONFLICTING' }), 'conflict');
  assert.equal(prStatus({ ...base, checks: { state: 'success' }, review: 'changes' }), 'changes');
  assert.equal(prStatus({ ...base, checks: { state: 'pending' }, review: 'approved', mergeState: 'BLOCKED' }), 'pending');
  assert.equal(prStatus({ ...base, checks: { state: 'success' }, review: 'approved', mergeState: 'CLEAN' }), 'ready');
  assert.equal(prStatus({ ...base, checks: { state: 'success' }, review: 'required' }), 'review');
  assert.equal(prStatus({ ...base, checks: { state: 'pending' }, autoMerge: { enabledAt: 'x' } }), 'queued');
  assert.equal(copilotState({ ...base, checks: { state: 'success' }, draft: true, title: '[WIP] Fix flaky test' }).label, 'Working');
  assert.equal(copilotState({ ...base, checks: { state: 'success' }, draft: false }).label, 'Ready for review');
});

test('merge methods are limited to what the repository allows', () => {
  assert.deepEqual(mergeMethodsFor({ mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true, viewerDefaultMergeMethod: 'REBASE' }), { methods: ['squash', 'rebase'], default: 'rebase' });
  assert.deepEqual(mergeMethodsFor({ mergeCommitAllowed: true, viewerDefaultMergeMethod: 'SQUASH' }), { methods: ['merge'], default: 'merge' });
  assert.deepEqual(mergeMethodsFor({}), { methods: ['merge'], default: 'merge' });
  const merge = { methods: ['squash', 'rebase'], default: 'squash' };
  assert.equal(chooseMergeMethod(merge, 'rebase'), 'rebase');
  assert.equal(chooseMergeMethod(merge, 'merge'), 'squash');
  assert.equal(chooseMergeMethod(null, 'squash'), 'merge');
});

test('owner sweep covers the viewer, every organization and extra owners minus exclusions', () => {
  const owners = ownersToSweep({ login: 'maddy', orgs: [{ login: 'acme' }, { login: 'Labs' }, { login: 'acme' }] }, { extraOwners: ['@friend', 'https://github.com/oss/x', 'bad name'], excludeOwners: ['labs'] });
  assert.deepEqual(owners, [{ login: 'maddy', type: 'user' }, { login: 'acme', type: 'org' }, { login: 'friend', type: 'user' }, { login: 'oss', type: 'user' }]);
  assert.equal(ownerSearch({ login: 'acme', type: 'org' }), 'is:pr is:open archived:false org:acme sort:updated-desc');
  assert.equal(ownerSearch({ login: 'maddy' }), 'is:pr is:open archived:false user:maddy sort:updated-desc');
  assert.match(facetSearches().review, /review-requested:@me/);
  assert.match(facetSearches().assigned, /assignee:@me/);
  assert.equal(cleanOwner('-bad'), '');
  assert.equal(cleanRepo('https://github.com/acme/web.git'), 'acme/web');
  assert.equal(cleanRepo('acme'), '');
});

test('owner qualifiers are chunked under the search length limit', () => {
  const owners = Array.from({ length: 30 }, (_, i) => ({ login: `organization-number-${i}`, type: i ? 'org' : 'user' }));
  const searches = chunkedOwnerSearches('is:pr is:open author:app/copilot-swe-agent', owners);
  assert.ok(searches.length > 1);
  for (const q of searches) assert.ok(q.length <= 240, q.length);
  assert.equal(searches.join(' ').match(/(org|user):organization-number-\d+/g).length, 30);
  assert.match(searches[0], /^is:pr is:open author:app\/copilot-swe-agent user:organization-number-0 org:/);
});

function fakeGitHub(routes) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const body = options.body && options.headers?.['Content-Type'] === 'application/json' ? JSON.parse(options.body) : options.body;
    calls.push({ url, method: options.method || 'GET', body, auth: options.headers?.Authorization });
    for (const route of routes) {
      const result = route(url, { ...options, body });
      if (result) return result;
    }
    return jsonResponse(404, { message: 'Not Found' });
  };
  return { fetch, calls };
}

test('searchAll paginates, caps results and halves the page size after a timeout', async () => {
  let timedOut = false;
  const pages = [];
  const { fetch } = fakeGitHub([(url, { body }) => {
    if (!url.endsWith('/graphql')) return null;
    const { first, after } = body.variables;
    if (first === 50 && !timedOut) { timedOut = true; return jsonResponse(502, { message: 'Server Error' }); }
    pages.push(first);
    const start = after ? Number(after) : 0;
    return jsonResponse(200, { data: { search: { issueCount: 70, pageInfo: { hasNextPage: start + first < 70, endCursor: String(start + first) },
      nodes: Array.from({ length: first }, (_, i) => prNode({ id: `PR_${start + i}` })) } } });
  }]);
  const client = createGitHubClient({ fetch, getToken: async () => TOKEN });
  const result = await searchAll(client, 'is:pr', { max: 60 });
  assert.equal(result.nodes.length, 60);
  assert.equal(result.total, 70);
  assert.deepEqual(pages, [25, 25, 10]);
  const map = new Map();
  assert.equal(mergeInto(map, [...result.nodes, prNode({ id: 'PR_1', updatedAt: '2020-01-01T00:00:00Z' })]), 60);
  assert.equal(map.get('PR_1').updatedAt, '2026-10-29T10:00:00Z');
});

test('client reports auth, rate-limit and validation failures without leaking the token', async () => {
  const fetch = async () => jsonResponse(403, { message: `API rate limit exceeded for ${TOKEN}` }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' });
  const client = createGitHubClient({ fetch, getToken: async () => TOKEN });
  await assert.rejects(client.request('/user'), error => error instanceof GitHubError && error.kind === 'rate' && error.resetAt === 1900000000000 && !error.message.includes(TOKEN));
  const leaky = httpError(422, { message: `Bad ${TOKEN}`, errors: [{ message: 'Merge method not allowed' }] }, null, { context: 'merge #1', token: TOKEN });
  assert.equal(leaky.kind, 'invalid');
  assert.ok(!leaky.message.includes(TOKEN));
  assert.match(leaky.message, /Merge method not allowed/);
  assert.equal(httpError(405, { message: 'Pull Request is not mergeable' }, null, { context: 'merge #4' }).kind, 'not_mergeable');
  assert.equal(httpError(409, {}).kind, 'conflict');
  assert.equal(httpError(401, {}).kind, 'auth');
  assert.equal(httpError(403, { message: 'Resource protected by organization SAML enforcement.' }).kind, 'forbidden');
});

test('a bridge token is refreshed once after a 401', async () => {
  let current = 'gho_oldtokenoldtokenoldtoken000';
  const { fetch, calls } = fakeGitHub([(url, options) => options.headers.Authorization === 'Bearer gho_newtokennewtokennewtoken111'
    ? jsonResponse(200, { login: 'maddy' }) : jsonResponse(401, { message: 'Bad credentials' })]);
  const client = createGitHubClient({ fetch, getToken: async () => current, refreshToken: async () => (current = 'gho_newtokennewtokennewtoken111') });
  assert.equal((await client.request('/user')).login, 'maddy');
  assert.equal(calls.length, 2);
  const stuck = createGitHubClient({ fetch, getToken: async () => 'gho_oldtokenoldtokenoldtoken000', refreshToken: async () => 'gho_oldtokenoldtokenoldtoken000' });
  await assert.rejects(stuck.request('/user'), { kind: 'auth' });
});

test('fetchSnapshot sweeps owners, merges facets, Copilot work, notifications and current CI failures', async () => {
  const copilotPr = prNode({ id: 'PR_COPILOT', number: 40, title: '[WIP] Fix flaky test', isDraft: true, author: { login: 'copilot-swe-agent', __typename: 'Bot' } });
  const { fetch, calls } = fakeGitHub([
    (url, { body }) => {
      if (!url.endsWith('/graphql')) return null;
      const q = body.query;
      if (q.includes('query Viewer')) return jsonResponse(200, { data: { viewer: { login: 'maddy', name: 'Maddy', avatarUrl: 'a', organizations: { nodes: [{ login: 'acme' }] } }, rateLimit: { cost: 1, remaining: 4999, limit: 5000, resetAt: '2026-10-30T12:00:00Z' } } });
      if (q.includes('query Facets')) return jsonResponse(200, { data: { review: { nodes: [prNode({ id: 'PR_REVIEW', repository: { ...prNode().repository, nameWithOwner: 'oss/lib', owner: { login: 'oss' } } })] }, assigned: { nodes: [] }, mine: { nodes: [prNode({ id: 'PR_MINE', viewerDidAuthor: true })] } } });
      if (q.includes('CopilotIssues')) return jsonResponse(200, { data: { search: { nodes: [{ __typename: 'Issue', id: 'I_1', number: 3, title: 'Flaky test', url: 'https://github.com/acme/web/issues/3', repository: { nameWithOwner: 'acme/web' }, closedByPullRequestsReferences: { nodes: [{ number: 40, url: 'https://github.com/acme/web/pull/40', isDraft: true }] } }] } } });
      const query = body.variables.q;
      if (query.includes('author:app/copilot-swe-agent')) return jsonResponse(200, { data: { search: { issueCount: 1, pageInfo: { hasNextPage: false }, nodes: [copilotPr] } } });
      if (query.includes('org:acme')) return jsonResponse(200, { data: { search: { issueCount: 2, pageInfo: { hasNextPage: false }, nodes: [prNode(), prNode({ id: 'PR_MINE', viewerDidAuthor: true })] } } });
      if (query.includes('user:maddy')) return jsonResponse(200, { data: { search: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } });
      return null;
    },
    url => url.includes('/notifications') ? jsonResponse(200, [{ id: '77', reason: 'review_requested', unread: true, updated_at: '2026-10-29T00:00:00Z', subject: { title: 'Add search', type: 'PullRequest', url: 'https://api.github.com/repos/acme/web/pulls/12' }, repository: { full_name: 'acme/web' } }], { link: '<https://api.github.com/notifications?page=2>; rel="next"' }) : null,
    url => url.includes('/actions/runs') ? jsonResponse(200, { workflow_runs: [
      { id: 501, workflow_id: 1, name: 'CI', head_branch: 'feature/search', head_sha: 'abc123', conclusion: 'failure', created_at: new Date().toISOString(), html_url: 'https://github.com/acme/web/actions/runs/501', run_attempt: 1 },
      { id: 400, workflow_id: 1, name: 'CI', head_branch: 'feature/search', head_sha: 'old', conclusion: 'success', created_at: new Date(Date.now() - 3600000).toISOString() },
      { id: 502, workflow_id: 2, name: 'Deploy', head_branch: 'main', head_sha: 'zzz', conclusion: 'success', created_at: new Date().toISOString() },
    ] }) : null,
  ]);
  const client = createGitHubClient({ fetch, getToken: async () => TOKEN });
  const snapshot = await fetchSnapshot(client, { ciRepos: 1 });
  assert.equal(snapshot.viewer.login, 'maddy');
  assert.deepEqual(snapshot.owners.map(o => o.login), ['maddy', 'acme']);
  assert.deepEqual(snapshot.prs.map(pr => pr.id).sort(), ['PR_1', 'PR_COPILOT', 'PR_MINE', 'PR_REVIEW']);
  assert.deepEqual(snapshot.facets.review, ['PR_REVIEW']);
  assert.equal(snapshot.copilot.issues[0].pr.number, 40);
  assert.equal(snapshot.notifications.items[0].url, 'https://github.com/acme/web/pull/12');
  assert.equal(snapshot.notifications.more, true);
  assert.deepEqual(snapshot.runs.map(r => r.id), [501]);
  assert.equal(snapshot.rate.graphql.remaining, 4999);
  assert.ok(calls.every(call => call.auth === `Bearer ${TOKEN}`));
  assert.ok(!JSON.stringify(snapshot).includes(TOKEN), 'snapshots never hold the token');

  const counts = summarize(snapshot, {});
  assert.equal(counts.reviews, 1);
  assert.equal(counts.mine, 1);
  assert.equal(counts.copilot, 1);
  assert.equal(counts.notifications, 1);
  assert.equal(counts.failing, 4);
});

test('notifications fail softly for tokens that cannot read them', async () => {
  const client = createGitHubClient({ fetch: async () => jsonResponse(403, { message: 'Resource not accessible by personal access token' }), getToken: async () => TOKEN });
  const result = await fetchNotifications(client);
  assert.deepEqual(result.items, []);
  assert.match(result.error, /classic token/);
});

test('filters, tabs, sorting and grouping', () => {
  const make = (id, patch) => ({ ...normalizePullRequest(prNode({ id })), ...patch });
  const prs = [
    make('a', { repo: 'acme/web', owner: 'acme', updatedAt: '2026-10-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z', mine: true }),
    make('b', { repo: 'acme/api', owner: 'acme', updatedAt: '2026-10-03T00:00:00Z', createdAt: '2026-08-01T00:00:00Z', draft: true, mine: true, checks: { state: 'success' } }),
    make('c', { repo: 'oss/lib', owner: 'oss', updatedAt: '2026-10-02T00:00:00Z', createdAt: '2026-10-02T00:00:00Z', author: { login: 'dependabot', bot: true, copilot: false }, checks: { state: 'success' }, review: 'approved', mergeState: 'CLEAN' }),
    make('d', { repo: 'oss/lib', owner: 'oss', author: { login: 'copilot-swe-agent', bot: true, copilot: true }, checks: { state: 'pending' } }),
  ];
  assert.deepEqual(baseFilter(prs, {}).map(p => p.id), ['a', 'b', 'd']);
  assert.deepEqual(baseFilter(prs, { hideBots: false, excludeOwners: ['OSS'] }).map(p => p.id), ['a', 'b']);
  assert.deepEqual(baseFilter(prs, { excludeRepos: ['acme/web'] }, { hidden: new Set(['b']) }).map(p => p.id), ['d']);
  const visible = baseFilter(prs, { hideBots: false });
  assert.deepEqual(tabPullRequests(visible, 'mine', { config: { hideDrafts: true } }).map(p => p.id), ['a']);
  assert.deepEqual(tabPullRequests(visible, 'drafts', { config: { hideDrafts: true } }).map(p => p.id), ['b']);
  assert.deepEqual(tabPullRequests(visible, 'reviews', { facets: { review: ['c'] } }).map(p => p.id), ['c']);
  assert.deepEqual(tabPullRequests(visible, 'copilot').map(p => p.id), ['d']);
  assert.deepEqual(tabPullRequests(visible, 'failing').map(p => p.id), ['a']);
  assert.deepEqual(sortPullRequests(visible, 'updated').map(p => p.id).slice(0, 3), ['d', 'b', 'c']);
  assert.deepEqual(sortPullRequests(visible, 'created').map(p => p.id), ['c', 'd', 'a', 'b']);
  assert.deepEqual(sortPullRequests(visible, 'repo').map(p => p.repo), ['acme/api', 'acme/web', 'oss/lib', 'oss/lib']);
  assert.deepEqual(sortPullRequests(visible, 'status').map(p => p.id), ['a', 'd', 'c', 'b']);
  assert.deepEqual(groupPullRequests(visible, 'owner').map(g => [g.key, g.items.length]), [['acme', 2], ['oss', 2]]);
  assert.deepEqual(groupPullRequests(visible, 'status').map(g => g.key), ['failing', 'pending', 'ready', 'draft']);
  assert.equal(groupPullRequests(visible, 'status')[0].label, 'Checks failing');
  assert.equal(groupPullRequests(visible, 'none')[0].items.length, 4);
});

test('config normalization keeps settings in range', () => {
  const c = normalizeConfig({ tabs: ['copilot', 'nope', 'all'], tab: 'zzz', refresh: 7, maxPerOwner: 5000, ciRepos: -3, groupBy: 'x', extraOwners: ['@a', 'a', ''] });
  assert.deepEqual(c.tabs, ['all', 'copilot']);
  assert.equal(c.tab, 'reviews');
  assert.equal(c.refresh, 5);
  assert.equal(c.maxPerOwner, 1000);
  assert.equal(c.ciRepos, 0);
  assert.equal(c.groupBy, 'none');
  assert.deepEqual(c.extraOwners, ['a']);
  assert.equal(normalizeConfig({ refresh: 0 }).refresh, 0);
  assert.equal(snapshotKey('Maddy', { extraOwners: ['b', 'a'] }), snapshotKey('maddy', { extraOwners: ['a', 'b'], groupBy: 'repo' }));
  assert.notEqual(snapshotKey('maddy', {}), snapshotKey('maddy', { excludeOwners: ['acme'] }));
});

test('CI failures keep only current red runs and pick the busiest repositories', () => {
  const now = Date.now();
  const iso = offset => new Date(now - offset).toISOString();
  const runs = [
    { id: 1, workflow_id: 1, name: 'CI', head_branch: 'main', head_sha: 'm1', conclusion: 'failure', created_at: iso(1000) },
    { id: 2, workflow_id: 1, name: 'CI', head_branch: 'main', head_sha: 'm0', conclusion: 'success', created_at: iso(5000) },
    { id: 3, workflow_id: 1, name: 'CI', head_branch: 'fix', head_sha: 'old', conclusion: 'failure', created_at: iso(2000) },
    { id: 4, workflow_id: 2, name: 'Lint', head_branch: 'x', head_sha: 'x', conclusion: 'failure', created_at: iso(30 * 86400000) },
    { id: 5, workflow_id: 3, name: 'E2E', head_branch: 'main', head_sha: 'm1', conclusion: 'success', created_at: iso(100) },
  ];
  const failures = currentFailures(runs, { repo: 'acme/web', heads: new Map([['fix', 'new']]) });
  assert.deepEqual(failures.map(f => f.id), [1]);
  assert.equal(failures[0].repo, 'acme/web');
  const prs = [{ repo: 'a/one', mine: false, author: {} }, { repo: 'a/two', mine: true, author: {} }, { repo: 'a/one', mine: false, author: {} }, { repo: 'a/three', mine: false, author: {} }];
  assert.deepEqual(ciRepositories(prs, { repos: 2 }), ['a/two', 'a/one']);
});

test('notification URLs point at the page on github.com', () => {
  assert.equal(notificationUrl('https://api.github.com/repos/acme/web/issues/5'), 'https://github.com/acme/web/issues/5');
  assert.equal(notificationUrl('https://api.github.com/repos/acme/web/commits/abc'), 'https://github.com/acme/web/commit/abc');
  assert.equal(notificationUrl('https://api.github.com/repos/acme/web/releases/1'), 'https://github.com/acme/web/releases');
  assert.equal(notificationUrl(null, 'acme/web'), 'https://github.com/acme/web');
  assert.equal(notificationUrl(null), 'https://github.com/notifications');
  assert.equal(normalizeNotification({ id: 9, subject: {}, unread: false }).unread, false);
});

test('device flow state machine honors pending, slow_down, expiry, denial and success', () => {
  assert.deepEqual(deviceFlowStep({ interval: 5 }, { error: 'authorization_pending' }), { status: 'pending', interval: 5 });
  assert.deepEqual(deviceFlowStep({ interval: 5 }, { error: 'slow_down', interval: 15 }), { status: 'pending', interval: 15 });
  assert.deepEqual(deviceFlowStep({ interval: 5 }, { error: 'slow_down' }), { status: 'pending', interval: 10 });
  assert.equal(deviceFlowStep({}, { error: 'expired_token' }).status, 'expired');
  assert.equal(deviceFlowStep({}, { error: 'access_denied' }).status, 'denied');
  assert.match(deviceFlowStep({}, { error: 'device_flow_disabled' }).message, /Enable Device Flow/);
  assert.deepEqual(deviceFlowStep({}, { access_token: 'gho_x', scope: 'repo,read:org' }), { status: 'token', token: 'gho_x', scopes: ['repo', 'read:org'] });
});

test('device flow requests a code and polls until approved', async () => {
  const responses = [{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { access_token: 'gho_approvedtokenapprovedtoken', scope: 'repo' }];
  const sleeps = [];
  const bodies = [];
  const fetch = async (url, options) => {
    bodies.push([url, Object.fromEntries(new URLSearchParams(options.body))]);
    if (url.endsWith('/login/device/code')) return jsonResponse(200, { device_code: 'dev', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 });
    return jsonResponse(200, responses.shift());
  };
  const code = await requestDeviceCode({ clientId: 'Ov23liAbCdEf123456', fetch, now: () => 0 });
  assert.equal(code.userCode, 'ABCD-1234');
  assert.equal(code.expiresAt, 900000);
  assert.equal(bodies[0][1].scope, 'repo read:org workflow notifications');
  const result = await pollDeviceFlow({ clientId: 'Ov23liAbCdEf123456', deviceCode: code.deviceCode, interval: code.interval, expiresAt: code.expiresAt, fetch, now: () => 1, sleep: async ms => { sleeps.push(ms); } });
  assert.equal(result.token, 'gho_approvedtokenapprovedtoken');
  assert.deepEqual(sleeps, [5000, 5000, 10000]);
  assert.equal(bodies[1][1].grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  await assert.rejects(requestDeviceCode({ clientId: 'no', fetch }), { kind: 'invalid' });
  await assert.rejects(pollDeviceFlow({ clientId: 'Ov23liAbCdEf123456', deviceCode: 'd', fetch: async () => jsonResponse(200, { error: 'access_denied' }), sleep: async () => {} }), { kind: 'denied' });
  await assert.rejects(pollDeviceFlow({ clientId: 'Ov23liAbCdEf123456', deviceCode: 'd', expiresAt: 10, now: () => 20, fetch, sleep: async () => {} }), { kind: 'expired' });
});

test('token validation reads the account and its scopes', async () => {
  const fetch = async () => jsonResponse(200, { login: 'maddy', name: 'Maddy', avatar_url: 'https://avatars.githubusercontent.com/u/2' }, { 'x-oauth-scopes': 'repo, read:org' });
  const info = await validateToken(TOKEN, { fetch });
  assert.deepEqual(info, { login: 'maddy', name: 'Maddy', avatarUrl: 'https://avatars.githubusercontent.com/u/2', scopes: ['repo', 'read:org'], kind: 'classic' });
  assert.deepEqual(missingScopes(info.scopes), ['workflow', 'notifications']);
  assert.deepEqual(missingScopes(['repo', 'admin:org', 'workflow', 'notifications']), []);
  assert.deepEqual(missingScopes(null), []);
  assert.equal(parseScopes(null), null);
  assert.equal(tokenKind('github_pat_123'), 'fine-grained');
  assert.equal(tokenKind('gho_123'), 'oauth');
});

test('merge uses an allowed method with the head SHA, and auto-merge sends the enum value', async () => {
  const { fetch, calls } = fakeGitHub([(url, { body }) => url.endsWith('/merge') ? jsonResponse(200, { merged: true, sha: 'def' })
    : url.endsWith('/graphql') ? jsonResponse(200, { data: { enablePullRequestAutoMerge: { pullRequest: { id: 'PR_1' } } } }) : null]);
  const client = createGitHubClient({ fetch, getToken: async () => TOKEN });
  const pr = normalizePullRequest(prNode());
  const result = await mergePullRequest(client, pr, { method: 'rebase', title: 'Add search (#12)' });
  assert.equal(result.method, 'squash');
  assert.equal(calls[0].method, 'PUT');
  assert.deepEqual(calls[0].body, { merge_method: 'squash', commit_title: 'Add search (#12)', sha: 'abc123' });
  assert.match(calls[0].url, /\/repos\/acme\/web\/pulls\/12\/merge$/);
  await setAutoMerge(client, pr, true, { method: 'merge' });
  assert.deepEqual(calls[1].body.variables, { id: 'PR_1', method: 'MERGE' });
  const refused = createGitHubClient({ fetch: async () => jsonResponse(405, { message: 'Required status check "test" is failing.' }), getToken: async () => TOKEN });
  await assert.rejects(mergePullRequest(refused, pr), error => error.kind === 'not_mergeable' && /Required status check/.test(error.message));
});

test('bridge token helper validates what the bridge returns', async () => {
  assert.deepEqual(await fetchBridgeToken(async path => { assert.equal(path, '/github/token'); return { token: 'gho_bridgetokenbridgetoken12', source: 'gh' }; }), { token: 'gho_bridgetokenbridgetoken12', source: 'gh' });
  await assert.rejects(fetchBridgeToken(async () => ({ token: 'nope' })), { kind: 'auth' });
});

test('the search query keeps the PR fragment and a rate limit probe', () => {
  assert.match(SEARCH_PRS_QUERY, /fragment PR on PullRequest/);
  assert.match(SEARCH_PRS_QUERY, /rateLimit \{ cost remaining limit resetAt \}/);
  assert.match(SEARCH_PRS_QUERY, /statusCheckRollup/);
});

// ------------------------------------------------------------------ bridge endpoint

const BRIDGE_TOKEN = 'a-test-token-longer-than-24-characters';
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
function get(port, path, { auth = BRIDGE_TOKEN, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: auth ? { Authorization: `Bearer ${auth}` } : {} }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GitHub token source prefers gh, then GITHUB_TOKEN/GH_TOKEN, and never uses a shell', async () => {
  const seen = [];
  const ok = createGitHubTokenSource({ env: {}, execFile: (file, args, options, done) => { seen.push([file, args, options.timeout, options.shell]); done(null, 'gho_fromtheclifromthecli1234\n'); } });
  assert.deepEqual(await ok(), { token: 'gho_fromtheclifromthecli1234', source: 'gh' });
  assert.deepEqual(seen[0].slice(0, 3), ['gh', ['auth', 'token'], 5000]);
  assert.equal(seen[0][3], undefined);
  const env = createGitHubTokenSource({ env: { GH_TOKEN: 'ghp_fromenvironmentfromenv12' }, execFile: (file, args, options, done) => done(new Error('not logged in'), '') });
  assert.deepEqual(await env(), { token: 'ghp_fromenvironmentfromenv12', source: 'GH_TOKEN' });
  const missing = createGitHubTokenSource({ env: { GITHUB_TOKEN: 'short' }, execFile: () => { throw new Error('ENOENT'); } });
  assert.equal(await missing(), null);
});

test('bridge serves /github/token only with the pairing token', async () => {
  const server = createBridgeServer({ token: BRIDGE_TOKEN, githubToken: async () => ({ token: 'gho_servedtokenservedtoken12', source: 'gh' }) });
  const port = await listen(server);
  try {
    assert.equal((await get(port, '/github/token', { auth: '' })).status, 401);
    assert.equal((await get(port, '/github/token', { auth: 'wrong-token-wrong-token-wrong' })).status, 401);
    const ok = await get(port, '/github/token');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { token: 'gho_servedtokenservedtoken12', source: 'gh' });
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.equal((await get(port, '/github/token', { method: 'POST' })).status, 405);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const empty = createBridgeServer({ token: BRIDGE_TOKEN, githubToken: async () => null });
  const emptyPort = await listen(empty);
  try {
    const missing = await get(emptyPort, '/github/token');
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /gh auth login/);
  } finally { empty.closeAllConnections(); await new Promise(resolve => empty.close(resolve)); }
});

test('fetchSnapshot reports a failure instead of an empty list when nothing loads', async () => {
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body || '{}');
    if (body.query?.includes('query Viewer')) return jsonResponse(200, { data: { viewer: { login: 'maddy', organizations: { nodes: [{ login: 'acme' }] } } } });
    return jsonResponse(502, { message: 'Bad gateway' });
  };
  const client = createGitHubClient({ fetch, getToken: async () => TOKEN });
  await assert.rejects(fetchSnapshot(client, {}), error => error.kind === 'server' && !error.message.includes(TOKEN));
});
