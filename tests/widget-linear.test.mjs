import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig, buildIssuesQuery, buildInboxQuery, buildMarkReadMutation, issueFilter, createIssueInput, classifyError, redact,
  createLinearClient, authorizationFor, normalizeIssue, normalizeTeams, normalizeIssuesResult, normalizeNotification, normalizeNotifications, normalizeViewer, notificationVerb,
  sortIssues, groupIssues, visibleIssues, countByStateType, cycleProgress, dueStatus, applyIssuePatch, replaceIssues, viewUrl, feedKey,
  layoutFor, safeColor, safeLinearUrl, unreadCount, LINEAR_API, COMPLETED_WINDOW_DAYS,
} from '../extension/lib/linear.js';

const KEY = 'lin_api_0123456789abcdefghijklmnopqrstuvwxyz';
const NOW = Date.parse('2026-10-30T12:00:00Z');

const state = (id, name, type, position = 0, color = '#5e6ad2') => ({ id, name, type, position, color });
const STATES = {
  backlog: state('s-backlog', 'Backlog', 'backlog', 0, '#bec2c8'),
  todo: state('s-todo', 'Todo', 'unstarted', 1, '#e2e2e2'),
  progress: state('s-progress', 'In Progress', 'started', 2, '#f2c94c'),
  review: state('s-review', 'In Review', 'started', 3, '#0f783c'),
  done: state('s-done', 'Done', 'completed', 4, '#5e6ad2'),
  canceled: state('s-canceled', 'Canceled', 'canceled', 5, '#95a2b3'),
};
const rawIssue = (n, overrides = {}) => ({
  id: `issue-${n}`, identifier: `ENG-${n}`, title: `Issue ${n}`, url: `https://linear.app/acme/issue/ENG-${n}/issue-${n}`,
  priority: 3, priorityLabel: 'Medium', estimate: 2, dueDate: null, branchName: `maddy/eng-${n}-issue-${n}`,
  updatedAt: new Date(NOW - n * 60000).toISOString(), createdAt: '2026-10-01T00:00:00Z', completedAt: null,
  state: STATES.todo, team: { id: 'team-eng', key: 'ENG', name: 'Engineering' }, project: null,
  labels: { nodes: [{ id: 'l1', name: 'Bug', color: '#EB5757' }] }, cycle: null, assignee: { id: 'me', name: 'Maddy Fox', displayName: 'maddy', avatarUrl: '' },
  ...overrides,
});
const issue = (n, overrides = {}) => normalizeIssue(rawIssue(n, overrides));

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const result = await handler(body, init);
    if (result instanceof Error) throw result;
    const { status = 200, json } = result;
    return { ok: status >= 200 && status < 300, status, json: async () => { if (json === undefined) throw new SyntaxError('bad json'); return json; } };
  };
  fn.calls = calls;
  return fn;
}

test('config normalization coerces select strings and fills defaults', () => {
  const config = normalizeConfig({ view: 'cycle', refresh: '15', showCompleted: 'true', showCycle: 'false', density: 'compact', groupBy: 'bogus', collapsed: ['a', 3] });
  assert.equal(config.view, 'cycle');
  assert.equal(config.refresh, 15);
  assert.equal(config.showCompleted, true);
  assert.equal(config.showCycle, false);
  assert.equal(config.density, 'compact');
  assert.equal(config.groupBy, 'status');
  assert.deepEqual(config.collapsed, ['a']);
  assert.deepEqual(normalizeConfig({ view: 'nope', refresh: 7 }), { ...normalizeConfig({}), view: 'mine', refresh: 5 });
});

test('issue queries target the right connection with open-work filters', () => {
  const mine = buildIssuesQuery({ view: 'mine', now: NOW });
  assert.match(mine.query, /assignedIssues\(first: \$first, filter: \$filter, orderBy: updatedAt\)/);
  assert.match(mine.query, /fragment StillIssue on Issue/);
  assert.doesNotMatch(mine.query, /\$teamId/);
  assert.deepEqual(mine.variables.filter, { state: { type: { nin: ['completed', 'canceled'] } } });
  assert.equal(mine.variables.first, 50);

  const created = buildIssuesQuery({ view: 'created', teamId: 'team-eng', withCycle: true, showCompleted: true, now: NOW });
  assert.match(created.query, /createdIssues/);
  assert.match(created.query, /cycleTeam: team\(id: \$teamId\)/);
  assert.match(created.query, /\$teamId: String!/);
  assert.equal(created.variables.teamId, 'team-eng');
  const since = new Date(NOW - COMPLETED_WINDOW_DAYS * 86400000).toISOString();
  assert.deepEqual(created.variables.filter, { or: [{ state: { type: { nin: ['completed', 'canceled'] } } }, { completedAt: { gt: since } }] });

  const team = buildIssuesQuery({ view: 'team', teamId: 'team-eng' });
  assert.match(team.query, /team\(id: \$teamId\) \{ id key name issues/);
  assert.match(team.query, /activeCycle/);

  const cycle = buildIssuesQuery({ view: 'cycle', teamId: 'team-eng' });
  assert.match(cycle.query, /activeCycle \{[^}]*issueCountHistory/);
  assert.deepEqual(cycle.variables, { teamId: 'team-eng' });
  assert.throws(() => buildIssuesQuery({ view: 'team' }), /Choose a Linear team/);
  assert.equal(buildIssuesQuery({ view: 'inbox' }).query, buildInboxQuery().query);
  assert.deepEqual(issueFilter({ showCompleted: false }), { state: { type: { nin: ['completed', 'canceled'] } } });
});

test('mark-read mutation aliases each notification and dedupes ids', () => {
  assert.equal(buildMarkReadMutation([]), null);
  const m = buildMarkReadMutation(['a', 'b', 'a', '', null], '2026-10-30T00:00:00.000Z');
  assert.match(m.query, /mutation StillLinearMarkRead\(\$readAt: DateTime!, \$id0: String!, \$id1: String!\)/);
  assert.match(m.query, /n1: notificationUpdate\(id: \$id1, input: \{ readAt: \$readAt \}\) \{ success \}/);
  assert.deepEqual(m.variables, { readAt: '2026-10-30T00:00:00.000Z', id0: 'a', id1: 'b' });
});

test('create input keeps only accepted fields and validates title and team', () => {
  assert.deepEqual(createIssueInput({ teamId: 't', title: '  Fix login  ', description: ' ', priority: '2', stateId: 's', assigneeId: '', cycleId: 'c', extra: 1 }),
    { teamId: 't', title: 'Fix login', priority: 2, stateId: 's', cycleId: 'c' });
  assert.deepEqual(createIssueInput({ teamId: 't', title: 'x', priority: '' }), { teamId: 't', title: 'x' });
  assert.equal(createIssueInput({ teamId: 't', title: 'x', priority: 0 }).priority, 0);
  assert.throws(() => createIssueInput({ teamId: 't', title: '   ' }), /title/);
  assert.throws(() => createIssueInput({ title: 'x' }), /team/);
});

test('errors are classified and never carry the key', () => {
  assert.equal(classifyError(400, { errors: [{ message: 'Authentication required, not authenticated', extensions: { type: 'authentication error' } }] }).kind, 'auth');
  assert.equal(classifyError(401, null).kind, 'auth');
  assert.equal(classifyError(400, { errors: [{ message: 'Rate limit', extensions: { code: 'RATELIMITED' } }] }).kind, 'rate');
  assert.equal(classifyError(429, null).kind, 'rate');
  assert.equal(classifyError(403, { errors: [{ message: 'no', extensions: { code: 'FORBIDDEN', userPresentableMessage: 'You cannot edit this team.' } }] }).message, 'You cannot edit this team.');
  assert.equal(classifyError(502, null).kind, 'server');
  const leaky = classifyError(400, { errors: [{ message: `Invalid key ${KEY} and lin_oauth_abc123` }] }, KEY);
  assert.equal(leaky.kind, 'graphql');
  assert.doesNotMatch(leaky.message, /lin_api_|lin_oauth_/);
  assert.equal(redact(`x ${KEY} y`, KEY), 'x [key] y');
});

test('client sends personal keys without Bearer and OAuth tokens with it', async () => {
  assert.equal(authorizationFor(KEY), KEY);
  assert.equal(authorizationFor('lin_oauth_abc'), 'Bearer lin_oauth_abc');
  const fetch = fakeFetch(() => ({ json: { data: { viewer: { id: 'me', name: 'Maddy Fox', displayName: 'maddy', email: 'maddy@example.com', avatarUrl: null, organization: { id: 'o', name: 'Acme', urlKey: 'acme' } } } } }));
  const viewer = await createLinearClient({ token: KEY, fetch }).viewer();
  assert.equal(fetch.calls[0].url, LINEAR_API);
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.equal(fetch.calls[0].init.headers.Authorization, KEY);
  assert.equal(fetch.calls[0].init.credentials, 'omit');
  assert.match(fetch.calls[0].body.query, /viewer \{ id name displayName email avatarUrl organization/);
  assert.deepEqual(viewer, { id: 'me', name: 'maddy', fullName: 'Maddy Fox', email: 'maddy@example.com', avatarUrl: '', organization: { id: 'o', name: 'Acme', urlKey: 'acme' } });
  assert.throws(() => createLinearClient({ token: '' }), /Connect Linear/);
  assert.throws(() => normalizeViewer(null), /did not return your account/);
});

test('client maps HTTP, GraphQL and network failures to calm errors', async () => {
  const auth = createLinearClient({ token: KEY, fetch: fakeFetch(() => ({ status: 400, json: { errors: [{ message: `bad ${KEY}`, extensions: { type: 'authentication error' } }] } })) });
  await assert.rejects(auth.viewer(), error => error.kind === 'auth' && !error.message.includes(KEY));
  const offline = createLinearClient({ token: KEY, fetch: fakeFetch(() => new TypeError('Failed to fetch')) });
  await assert.rejects(offline.teams(), error => error.kind === 'network' && /Unable to reach Linear/.test(error.message));
  const garbled = createLinearClient({ token: KEY, fetch: fakeFetch(() => ({ status: 200, json: undefined })) });
  await assert.rejects(garbled.teams(), /could not read/);
  const partial = createLinearClient({ token: KEY, fetch: fakeFetch(() => ({ json: { data: { viewer: { id: 'me', assignedIssues: { nodes: [rawIssue(1)] } } }, errors: [{ message: 'label failed' }] } })) });
  assert.equal((await partial.issues({ view: 'mine' })).issues.length, 1);
  const failedSave = createLinearClient({ token: KEY, fetch: fakeFetch(() => ({ json: { data: { issueUpdate: { success: false, issue: null } } } })) });
  await assert.rejects(failedSave.updateIssue('issue-1', { priority: 1 }), /did not save/);
});

test('client mutations send typed inputs and return normalized issues', async () => {
  const fetch = fakeFetch(body => body.query.includes('issueCreate')
    ? { json: { data: { issueCreate: { success: true, issue: rawIssue(9, { title: body.variables.input.title }) } } } }
    : body.query.includes('notificationUpdate') ? { json: { data: { n0: { success: true }, n1: { success: true } } } }
    : { json: { data: { issueUpdate: { success: true, issue: rawIssue(1, { state: STATES.done }) } } } });
  const client = createLinearClient({ token: KEY, fetch });
  const created = await client.createIssue({ teamId: 'team-eng', title: ' Ship it ', priority: '1' });
  assert.equal(created.title, 'Ship it');
  assert.deepEqual(fetch.calls[0].body.variables.input, { teamId: 'team-eng', title: 'Ship it', priority: 1 });
  const updated = await client.updateIssue('issue-1', { stateId: 's-done' });
  assert.equal(updated.state.type, 'completed');
  assert.deepEqual(fetch.calls[1].body.variables, { id: 'issue-1', input: { stateId: 's-done' } });
  assert.equal(await client.markRead(['n-1', 'n-2']), 2);
  assert.equal(await client.markRead([]), 0);
});

test('issues normalize defensively: colors, links, priority and labels', () => {
  const normal = issue(1, { priority: 9, dueDate: 'tomorrow', url: 'javascript:alert(1)', state: { id: 's', name: 'Odd', type: 'weird', color: 'red;background:url(x)', position: 1 },
    labels: { nodes: [{ id: 'l', name: 'UI', color: '#26B5CE' }, { name: 'no id' }] } });
  assert.equal(normal.priority, 4);
  assert.equal(normal.dueDate, '');
  assert.equal(normal.url, '');
  assert.equal(normal.state.type, 'unstarted');
  assert.equal(normal.state.color, '');
  assert.deepEqual(normal.labels, [{ id: 'l', name: 'UI', color: '#26b5ce' }]);
  assert.equal(issue(2).url, 'https://linear.app/acme/issue/ENG-2/issue-2');
  assert.equal(issue(3).assignee.name, 'maddy');
  assert.equal(normalizeIssue(null), null);
  assert.equal(safeColor('#ABC'), '#abc');
  assert.equal(safeColor('blue'), '');
  assert.equal(safeLinearUrl('https://evil.example/linear.app'), '');
  assert.equal(safeLinearUrl('https://linear.app/x'), 'https://linear.app/x');
});

test('teams put your own teams first and order states by type', () => {
  const teams = normalizeTeams({
    viewer: { teams: { nodes: [{ id: 'b' }] } },
    teams: { nodes: [
      { id: 'a', key: 'APP', name: 'Apps', states: { nodes: [STATES.done, STATES.todo] } },
      { id: 'b', key: 'ENG', name: 'Engineering', defaultIssueState: { id: 's-todo' }, states: { nodes: [STATES.canceled, STATES.backlog, STATES.review, STATES.progress, STATES.todo] } },
    ] },
  });
  assert.deepEqual(teams.map(t => t.key), ['ENG', 'APP']);
  assert.equal(teams[0].member, true);
  assert.equal(teams[0].defaultStateId, 's-todo');
  assert.deepEqual(teams[0].states.map(s => s.name), ['In Progress', 'In Review', 'Todo', 'Backlog', 'Canceled']);
});

test('issue results normalize per view, including cycle summaries', () => {
  const cycle = { id: 'c', number: 42, name: '', startsAt: '2026-10-26T00:00:00Z', endsAt: '2026-11-02T00:00:00Z', progress: 0.4, issueCountHistory: [10, 12], completedIssueCountHistory: [2, 5] };
  const mine = normalizeIssuesResult({ viewer: { assignedIssues: { nodes: [rawIssue(1)] } }, cycleTeam: { id: 't', key: 'ENG', name: 'Engineering', activeCycle: cycle } }, { view: 'mine' });
  assert.equal(mine.issues.length, 1);
  assert.deepEqual(mine.cycle, { id: 'c', number: 42, name: '', startsAt: cycle.startsAt, endsAt: cycle.endsAt, progress: 0.4, scope: 12, done: 5 });
  assert.equal(mine.team.key, 'ENG');
  const cycleView = normalizeIssuesResult({ team: { id: 't', key: 'ENG', name: 'Engineering', activeCycle: { ...cycle, issues: { nodes: [rawIssue(2), rawIssue(3)] } } } }, { view: 'cycle' });
  assert.equal(cycleView.issues.length, 2);
  assert.equal(normalizeIssuesResult({ team: { id: 't', activeCycle: null } }, { view: 'cycle' }).cycle, null);
  assert.equal(normalizeIssuesResult({ viewer: { createdIssues: { nodes: [rawIssue(4)] } } }, { view: 'created' }).issues[0].identifier, 'ENG-4');
});

test('notifications keep issue and project entries and hide snoozed ones', () => {
  const base = { id: 'n1', type: 'issueNewComment', readAt: null, createdAt: '2026-10-30T10:00:00Z', actor: { id: 'u', name: 'Ana Ruiz', displayName: 'ana' },
    comment: { body: 'Looks good\n\nship it' }, issue: { id: 'i', identifier: 'ENG-1', title: 'Fix', url: 'https://linear.app/acme/issue/ENG-1', priority: 2, state: STATES.progress } };
  const note = normalizeNotification(base, NOW);
  assert.equal(note.verb, 'commented');
  assert.equal(note.comment, 'Looks good ship it');
  assert.equal(note.url, 'https://linear.app/acme/issue/ENG-1');
  assert.equal(note.actor.name, 'Ana Ruiz');
  assert.equal(normalizeNotification({ ...base, snoozedUntilAt: '2026-11-01T00:00:00Z' }, NOW), null);
  assert.equal(normalizeNotification({ id: 'x', type: 'oauthClientApproval' }, NOW), null);
  assert.equal(normalizeNotification({ id: 'p', type: 'projectUpdateCreated', project: { id: 'p', name: 'Launch', url: 'https://linear.app/acme/project/launch' } }, NOW).verb, 'posted a project update');
  assert.equal(unreadCount([note, { ...note, readAt: '2026-10-30T11:00:00Z' }]), 1);
  const ordered = normalizeNotifications([{ ...base, id: 'old', createdAt: '2026-10-01T00:00:00Z' }, base, { ...base, id: 'later', snoozedUntilAt: '2026-10-29T00:00:00Z', createdAt: '2026-10-30T11:00:00Z' }], NOW);
  assert.deepEqual(ordered.map(n => n.id), ['later', 'n1', 'old']);
  assert.equal(notificationVerb('somethingNew'), 'updated');
  assert.equal(notificationVerb('issueCommentSomething'), 'commented');
});

test('sorting by updated, priority (no priority last) and due date', () => {
  const a = issue(1, { priority: 0, dueDate: '2026-11-03' });
  const b = issue(2, { priority: 1 });
  const c = issue(3, { priority: 3, dueDate: '2026-10-31' });
  assert.deepEqual(sortIssues([c, b, a], 'updated').map(i => i.identifier), ['ENG-1', 'ENG-2', 'ENG-3']);
  assert.deepEqual(sortIssues([a, b, c], 'priority').map(i => i.identifier), ['ENG-2', 'ENG-3', 'ENG-1']);
  assert.deepEqual(sortIssues([a, b, c], 'due').map(i => i.identifier), ['ENG-3', 'ENG-1', 'ENG-2']);
});

test('grouping merges same-named statuses and orders groups for action', () => {
  const list = [
    issue(1, { state: STATES.todo }), issue(2, { state: STATES.progress }),
    issue(3, { state: { ...STATES.progress, id: 'other-team-progress' }, team: { id: 'team-app', key: 'APP', name: 'Apps' } }),
    issue(4, { state: STATES.backlog, priority: 1, project: { id: 'p1', name: 'Launch', color: '#f00' } }), issue(5, { state: STATES.done, priority: 0 }),
  ];
  const byStatus = groupIssues(list, 'status');
  assert.deepEqual(byStatus.map(g => [g.label, g.count]), [['In Progress', 2], ['Todo', 1], ['Backlog', 1], ['Done', 1]]);
  assert.deepEqual(groupIssues(list, 'priority').map(g => g.label), ['Urgent', 'Medium', 'No priority']);
  assert.deepEqual(groupIssues(list, 'project').map(g => g.label), ['Launch', 'No project']);
  assert.deepEqual(groupIssues(list, 'none').map(g => g.count), [5]);
  assert.deepEqual(groupIssues([], 'none'), []);
  assert.equal(visibleIssues(list).length, 4);
  assert.equal(visibleIssues(list, { showCompleted: true }).length, 5);
  assert.deepEqual(countByStateType(list).map(c => [c.type, c.count]), [['started', 2], ['unstarted', 1], ['backlog', 1], ['completed', 1]]);
});

test('cycle progress counts from issues or from the summary history', () => {
  const cycle = { id: 'c', number: 7, name: 'Polish', startsAt: '2026-10-26T00:00:00Z', endsAt: '2026-11-02T12:00:00Z', progress: 0.3, scope: 12, done: 6 };
  const fromSummary = cycleProgress(cycle, null, NOW);
  assert.deepEqual([fromSummary.total, fromSummary.done, fromSummary.ratio, fromSummary.daysLeft], [12, 6, 0.5, 3]);
  const fromIssues = cycleProgress(cycle, [issue(1, { state: STATES.done }), issue(2, { state: STATES.progress }), issue(3), issue(4, { state: STATES.canceled })], NOW);
  assert.deepEqual([fromIssues.total, fromIssues.done, fromIssues.started], [3, 1, 1]);
  assert.equal(cycleProgress(null), null);
  assert.equal(cycleProgress({ ...cycle, scope: 0, done: 0 }, null, NOW).ratio, 0.3);
});

test('due status for overdue, today, soon and closed issues', () => {
  const now = new Date(2026, 9, 30, 15).getTime();
  assert.equal(dueStatus('2026-10-29', { now }), 'overdue');
  assert.equal(dueStatus('2026-10-30', { now }), 'today');
  assert.equal(dueStatus('2026-11-02', { now }), 'soon');
  assert.equal(dueStatus('2026-11-20', { now }), 'later');
  assert.equal(dueStatus('2026-10-01', { now, closed: true }), 'later');
  assert.equal(dueStatus('', { now }), '');
});

test('optimistic patches change state, priority and assignee without mutating input', () => {
  const original = issue(1);
  const viewer = { id: 'me2', name: 'maddy', fullName: 'Maddy Fox', avatarUrl: '' };
  const done = applyIssuePatch(original, { stateId: 's-done', priority: 1, assigneeId: 'me2' }, { states: Object.values(STATES), viewer });
  assert.equal(done.state.type, 'completed');
  assert.ok(done.completedAt);
  assert.equal(done.priorityLabel, 'Urgent');
  assert.equal(done.assignee.name, 'maddy');
  assert.equal(original.state.type, 'unstarted');
  assert.equal(applyIssuePatch(original, { assigneeId: null }).assignee, null);
  assert.equal(applyIssuePatch(original, { stateId: 'missing' }, { states: [] }).state.id, 's-todo');
  const feed = { kind: 'issues', issues: [original, issue(2)] };
  const next = replaceIssues(feed, [done]);
  assert.notEqual(next, feed);
  assert.equal(next.issues[0].state.type, 'completed');
  assert.equal(replaceIssues(feed, [issue(99)]), feed);
});

test('links, cache keys and layouts', () => {
  assert.equal(viewUrl({ view: 'mine', org: 'acme' }), 'https://linear.app/acme/my-issues/assigned');
  assert.equal(viewUrl({ view: 'team', org: 'acme', teamKey: 'ENG' }), 'https://linear.app/acme/team/ENG/active');
  assert.equal(viewUrl({ view: 'inbox', org: 'acme' }), 'https://linear.app/acme/inbox');
  assert.equal(viewUrl({ view: 'team', org: '' }), 'https://linear.app');
  assert.equal(feedKey({ viewerId: 'me', view: 'mine' }), 'linear:me:mine:-:open');
  assert.equal(feedKey({ viewerId: 'me', view: 'team', teamId: 't', showCompleted: true }), 'linear:me:team:t:all');
  assert.equal(feedKey({ viewerId: 'me', view: 'cycle', teamId: 't' }), 'linear:me:cycle:t:all');
  assert.equal(feedKey({ viewerId: 'me', view: 'inbox', teamId: 't' }), 'linear:me:inbox');
  assert.equal(layoutFor({ size: 'xs', w: 2, h: 2 }), 'counts');
  assert.equal(layoutFor({ size: 's', w: 6, h: 2 }), 'counts');
  assert.equal(layoutFor({ size: 's', w: 3, h: 3 }), 'counts');
  assert.equal(layoutFor({ size: 's', w: 3, h: 6 }), 'list');
  assert.equal(layoutFor({ size: 'm', w: 4, h: 5 }), 'list');
  assert.equal(layoutFor({ size: 'l', w: 6, h: 6 }), 'grouped');
  assert.equal(layoutFor({ size: 'xl', w: 9, h: 8 }), 'grouped');
});

test('a refresh still running when Linear is disconnected never refills the cache', async () => {
  if (!globalThis.localStorage) {
    const store = new Map();
    globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  }
  const { session, syncFeed, feedFor, resetSession } = await import('../extension/ui/widgets/linear/session.js');
  const { saveAccount } = await import('../extension/lib/accounts.js');
  session.loaded = false;
  await saveAccount('linear', { token: KEY, method: 'token', meta: { viewerId: 'me' } });
  Object.assign(session, { loaded: true, info: { connected: true, meta: { viewerId: 'me' } }, access: true, authFailed: false });
  const realFetch = globalThis.fetch;
  const pending = [];
  globalThis.fetch = async (url, init) => {
    if (!JSON.parse(init.body).query.includes('notifications')) return new Response('{}', { status: 500 });   // teams
    return new Promise(resolve => pending.push(resolve));
  };
  const reply = () => new Response(JSON.stringify({ data: { notifications: { nodes: [] } } }), { status: 200 });
  const until = async () => { while (!pending.length) await new Promise(resolve => setImmediate(resolve)); return pending.shift(); };
  try {
    const config = { view: 'inbox' };
    const kept = syncFeed(config, { force: true });
    (await until())(reply());
    await kept;
    assert.equal(feedFor(config).value.kind, 'inbox', 'a normal refresh is cached');
    resetSession();
    const dropped = syncFeed(config, { force: true });
    const answer = await until();
    resetSession();   // disconnect while the request runs
    session.info = null;
    answer(reply());
    await dropped;
    session.info = { connected: true, meta: { viewerId: 'me' } };
    assert.equal(feedFor(config).value, null);
  } finally {
    globalThis.fetch = realFetch;
    resetSession();
    Object.assign(session, { info: null, access: null });
  }
});
