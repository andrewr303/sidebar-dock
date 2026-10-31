// Linear GraphQL client and the pure helpers behind the dashboard's Linear widget: query builders, response
// normalization, grouping, sorting and optimistic patches. No DOM and no storage here; the widget (ui/widgets/linear.js)
// owns caching and credentials. Personal API keys are sent as-is in Authorization (Linear does not want "Bearer" for
// them); OAuth access tokens (lin_oauth_…) use Bearer. A key never appears in an error message or a return value.

export const ACCOUNT_ID = 'linear';
export const LINEAR_API = 'https://api.linear.app/graphql';
export const LINEAR_ORIGIN = 'https://api.linear.app/*';
export const LINEAR_KEYS_URL = 'https://linear.app/settings/account/security';
export const LINEAR_APP = 'https://linear.app';
export const PAGE_SIZE = 50;
/** "Show completed" reaches back this far, so a long-lived team never floods the list with old work. */
export const COMPLETED_WINDOW_DAYS = 14;

export const VIEWS = Object.freeze([
  { id: 'mine', label: 'My issues', short: 'Assigned to you', icon: 'user-round', team: false },
  { id: 'created', label: 'Created by me', short: 'Created by you', icon: 'square-pen', team: false },
  { id: 'team', label: 'Team issues', short: 'Team', icon: 'users', team: true },
  { id: 'cycle', label: 'Current cycle', short: 'Cycle', icon: 'calendar-range', team: true },
  { id: 'inbox', label: 'Inbox', short: 'Inbox', icon: 'inbox', team: false },
]);
export const viewOf = id => VIEWS.find(view => view.id === id) || VIEWS[0];

/** Linear priorities: 0 none, 1 urgent … 4 low. `rank` puts "No priority" last when sorting. */
export const PRIORITIES = Object.freeze([
  { value: 1, label: 'Urgent', rank: 1 },
  { value: 2, label: 'High', rank: 2 },
  { value: 3, label: 'Medium', rank: 3 },
  { value: 4, label: 'Low', rank: 4 },
  { value: 0, label: 'No priority', rank: 5 },
]);
export const priorityOf = value => PRIORITIES.find(p => p.value === Number(value)) || PRIORITIES[4];

/** Workflow state types in the order people act on them (in progress first, finished last). */
export const STATE_TYPES = Object.freeze([
  { type: 'started', label: 'In progress', tone: 'amber' },
  { type: 'unstarted', label: 'Todo', tone: 'gray' },
  { type: 'triage', label: 'Triage', tone: 'orange' },
  { type: 'backlog', label: 'Backlog', tone: 'gray' },
  { type: 'completed', label: 'Done', tone: 'indigo' },
  { type: 'canceled', label: 'Canceled', tone: 'gray' },
]);
const TYPE_RANK = Object.fromEntries(STATE_TYPES.map((entry, index) => [entry.type, index]));
export const stateTypeOf = type => STATE_TYPES.find(entry => entry.type === type) || STATE_TYPES[1];
export const isClosedType = type => type === 'completed' || type === 'canceled';

export const GROUP_BYS = Object.freeze([
  { value: 'status', label: 'Status' }, { value: 'priority', label: 'Priority' },
  { value: 'project', label: 'Project' }, { value: 'none', label: 'No grouping' },
]);
export const SORTS = Object.freeze([
  { value: 'updated', label: 'Last updated' }, { value: 'priority', label: 'Priority' }, { value: 'due', label: 'Due date' },
]);
export const REFRESH_OPTIONS = Object.freeze([
  { value: 2, label: 'Every 2 minutes' }, { value: 5, label: 'Every 5 minutes' }, { value: 15, label: 'Every 15 minutes' },
  { value: 30, label: 'Every 30 minutes' }, { value: 60, label: 'Every hour' }, { value: 0, label: 'Only when I refresh' },
]);

export const DEFAULT_CONFIG = Object.freeze({
  view: 'mine', teamId: '', groupBy: 'status', sort: 'updated', showCompleted: false, showCycle: true,
  density: 'comfortable', refresh: 5, collapsed: [],
});

/** Config with every key valid (select fields arrive as strings; older widgets miss newer keys). */
export function normalizeConfig(config = {}) {
  const c = { ...DEFAULT_CONFIG, ...(config && typeof config === 'object' ? config : {}) };
  const refresh = Number(c.refresh);
  return {
    view: VIEWS.some(v => v.id === c.view) ? c.view : DEFAULT_CONFIG.view,
    teamId: typeof c.teamId === 'string' ? c.teamId : '',
    groupBy: GROUP_BYS.some(g => g.value === c.groupBy) ? c.groupBy : DEFAULT_CONFIG.groupBy,
    sort: SORTS.some(s => s.value === c.sort) ? c.sort : DEFAULT_CONFIG.sort,
    showCompleted: c.showCompleted === true || c.showCompleted === 'true',
    showCycle: !(c.showCycle === false || c.showCycle === 'false'),
    density: c.density === 'compact' ? 'compact' : 'comfortable',
    refresh: REFRESH_OPTIONS.some(o => o.value === refresh) ? refresh : DEFAULT_CONFIG.refresh,
    collapsed: Array.isArray(c.collapsed) ? c.collapsed.filter(k => typeof k === 'string').slice(0, 40) : [],
  };
}

// ------------------------------------------------------------------------------------------------ queries

export const ISSUE_FIELDS = `fragment StillIssue on Issue {
  id identifier title url priority priorityLabel estimate dueDate branchName updatedAt createdAt completedAt
  state { id name type color position }
  team { id key name }
  project { id name color }
  labels(first: 8) { nodes { id name color } }
  cycle { id number }
  assignee { id name displayName avatarUrl }
}`;

const CYCLE_SUMMARY = 'id number name startsAt endsAt progress issueCountHistory completedIssueCountHistory';

export const VIEWER_QUERY = `query StillLinearViewer {
  viewer { id name displayName email avatarUrl organization { id name urlKey } }
}`;

export const TEAMS_QUERY = `query StillLinearTeams {
  viewer { teams(first: 100) { nodes { id } } }
  teams(first: 100) { nodes {
    id key name color cyclesEnabled
    defaultIssueState { id }
    states(first: 100) { nodes { id name type color position } }
  } }
}`;

/** Issue filter for a list: open work only, or open work plus what was completed in the last two weeks. */
export function issueFilter({ showCompleted = false, now = Date.now() } = {}) {
  const open = { state: { type: { nin: ['completed', 'canceled'] } } };
  if (!showCompleted) return open;
  const since = new Date(now - COMPLETED_WINDOW_DAYS * 86400000).toISOString();
  return { or: [open, { completedAt: { gt: since } }] };
}

/**
 * GraphQL request for an issue view. Returns { query, variables }. `teamId` is required for team and cycle views; for
 * the other views it adds the team's active cycle summary (for the progress bar) when `withCycle` is set.
 */
export function buildIssuesQuery({ view = 'mine', teamId = '', showCompleted = false, withCycle = false, first = PAGE_SIZE, now = Date.now() } = {}) {
  const v = viewOf(view).id;
  if (v === 'inbox') return buildInboxQuery({ first });
  if ((v === 'team' || v === 'cycle') && !teamId) throw new Error('Choose a Linear team for this view.');
  if (v === 'cycle') {
    // The whole cycle, finished work included, so progress can be counted; the widget hides closed issues itself.
    const body = `team(id: $teamId) { id key name activeCycle { ${CYCLE_SUMMARY} issues(first: 100) { nodes { ...StillIssue } } } }`;
    return { query: `query StillLinearCycle($teamId: String!) { ${body} }\n${ISSUE_FIELDS}`, variables: { teamId } };
  }
  const variables = { first, filter: issueFilter({ showCompleted, now }) };
  const args = '(first: $first, filter: $filter, orderBy: updatedAt)';
  let body;
  const cycle = withCycle && teamId ? `cycleTeam: team(id: $teamId) { id key name activeCycle { ${CYCLE_SUMMARY} } }` : '';
  if (v === 'team') {
    body = `team(id: $teamId) { id key name issues${args} { nodes { ...StillIssue } } activeCycle { ${CYCLE_SUMMARY} } }`;
    variables.teamId = teamId;
  } else {
    body = `viewer { id ${v === 'created' ? 'createdIssues' : 'assignedIssues'}${args} { nodes { ...StillIssue } } } ${cycle}`;
    if (cycle) variables.teamId = teamId;
  }
  const params = ['$first: Int!', '$filter: IssueFilter', variables.teamId ? '$teamId: String!' : ''].filter(Boolean).join(', ');
  return { query: `query StillLinearIssues(${params}) { ${body} }\n${ISSUE_FIELDS}`, variables };
}

export function buildInboxQuery({ first = 40 } = {}) {
  return {
    query: `query StillLinearInbox($first: Int!) {
  notifications(first: $first) { nodes {
    id type readAt createdAt snoozedUntilAt
    actor { id name displayName avatarUrl }
    ... on IssueNotification { comment { body } issue { id identifier title url priority state { id name type color position } team { id key name } } }
    ... on ProjectNotification { project { id name url } }
  } }
}`,
    variables: { first },
  };
}

export const UPDATE_ISSUE_MUTATION = `mutation StillLinearUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { ...StillIssue } }
}\n${ISSUE_FIELDS}`;

export const CREATE_ISSUE_MUTATION = `mutation StillLinearCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ...StillIssue } }
}\n${ISSUE_FIELDS}`;

/** One request that marks several notifications read (aliased notificationUpdate calls). */
export function buildMarkReadMutation(ids = [], readAt = new Date().toISOString()) {
  const list = [...new Set(ids.filter(id => typeof id === 'string' && id))].slice(0, 50);
  if (!list.length) return null;
  const params = ['$readAt: DateTime!', ...list.map((_, i) => `$id${i}: String!`)].join(', ');
  const fields = list.map((_, i) => `n${i}: notificationUpdate(id: $id${i}, input: { readAt: $readAt }) { success }`).join('\n  ');
  const variables = { readAt };
  list.forEach((id, i) => { variables[`id${i}`] = id; });
  return { query: `mutation StillLinearMarkRead(${params}) {\n  ${fields}\n}`, variables };
}

/** Only the fields Linear's issueCreate accepts from the widget, trimmed and typed. */
export function createIssueInput({ teamId, title, description, priority, stateId, assigneeId, cycleId } = {}) {
  const text = String(title ?? '').trim();
  if (!teamId) throw new Error('Choose a team for the new issue.');
  if (!text) throw new Error('Give the issue a title.');
  const input = { teamId, title: text.slice(0, 255) };
  const body = String(description ?? '').trim();
  if (body) input.description = body;
  if (priority !== undefined && priority !== '' && PRIORITIES.some(p => p.value === Number(priority))) input.priority = Number(priority);
  if (stateId) input.stateId = stateId;
  if (assigneeId) input.assigneeId = assigneeId;
  if (cycleId) input.cycleId = cycleId;
  return input;
}

// ------------------------------------------------------------------------------------------------ errors

export class LinearError extends Error {
  constructor(message, { kind = 'error', status = 0, code = '' } = {}) {
    super(message);
    this.name = 'LinearError';
    this.kind = kind;     // auth | forbidden | rate | network | server | timeout | graphql | access
    this.status = status;
    this.code = code;
  }
}

/** Replaces the credential (and anything that looks like a Linear key) before text reaches the UI. */
export function redact(text, token) {
  let value = String(text ?? '');
  if (token && token.length > 3) value = value.split(token).join('[key]');
  return value.replace(/lin_(?:api|oauth)_[A-Za-z0-9]+/g, '[key]');
}

export function classifyError(status, body, token) {
  const first = Array.isArray(body?.errors) ? body.errors[0] || {} : {};
  const ext = first.extensions || {};
  const code = String(ext.code || ext.type || '').toUpperCase();
  const said = redact(ext.userPresentableMessage || first.message || '', token).trim();
  if (status === 401 || /AUTHENTICAT/.test(code) || /not authenticated|authentication required/i.test(first.message || '')) {
    return new LinearError('Linear did not accept your API key. Connect again with a new key.', { kind: 'auth', status, code });
  }
  if (status === 429 || /RATELIMIT/.test(code)) {
    return new LinearError('Linear is limiting requests right now. Still will try again in a few minutes.', { kind: 'rate', status, code });
  }
  if (status === 403 || /FORBIDDEN/.test(code)) {
    return new LinearError(said || 'Your Linear account is not allowed to do that.', { kind: 'forbidden', status, code });
  }
  if (status >= 500) return new LinearError('Linear is not responding right now. Try again in a moment.', { kind: 'server', status, code });
  return new LinearError(said || `Linear returned an error (HTTP ${status}).`, { kind: 'graphql', status, code });
}

// ------------------------------------------------------------------------------------------------ client

export const authorizationFor = token => /^lin_oauth_/.test(token) ? `Bearer ${token}` : token;

export function createLinearClient({ token, fetch: fetcher = globalThis.fetch?.bind(globalThis), endpoint = LINEAR_API, timeoutMs = 15000 } = {}) {
  if (!token) throw new LinearError('Connect Linear with an API key first.', { kind: 'auth' });
  if (typeof fetcher !== 'function') throw new LinearError('This browser cannot reach Linear.', { kind: 'network' });

  async function request(query, variables = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetcher(endpoint, {
        method: 'POST', cache: 'no-store', credentials: 'omit', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: authorizationFor(token) },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new LinearError('Linear took too long to answer. Try again.', { kind: 'timeout' });
      throw new LinearError('Unable to reach Linear. Check your connection and try again.', { kind: 'network' });
    } finally { clearTimeout(timer); }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok || (Array.isArray(body?.errors) && body.errors.length && !body?.data)) throw classifyError(response.status, body, token);
    if (!body || typeof body !== 'object' || !body.data) throw new LinearError(`Linear sent a response Still could not read (HTTP ${response.status}).`, { kind: 'graphql', status: response.status });
    return body.data;
  }

  return {
    request,
    async viewer() { return normalizeViewer((await request(VIEWER_QUERY)).viewer); },
    async teams() { return normalizeTeams(await request(TEAMS_QUERY)); },
    async issues(options = {}) {
      const { query, variables } = buildIssuesQuery(options);
      return normalizeIssuesResult(await request(query, variables), options);
    },
    async inbox(options = {}) {
      const { query, variables } = buildInboxQuery(options);
      return { kind: 'inbox', notifications: normalizeNotifications((await request(query, variables)).notifications?.nodes) };
    },
    async updateIssue(id, input) {
      const result = (await request(UPDATE_ISSUE_MUTATION, { id, input })).issueUpdate;
      if (!result?.success) throw new LinearError('Linear did not save that change. Try again.', { kind: 'graphql' });
      return normalizeIssue(result.issue);
    },
    async createIssue(input) {
      const result = (await request(CREATE_ISSUE_MUTATION, { input: createIssueInput(input) })).issueCreate;
      if (!result?.success || !result.issue) throw new LinearError('Linear did not create the issue. Try again.', { kind: 'graphql' });
      return normalizeIssue(result.issue);
    },
    async markRead(ids, readAt) {
      const mutation = buildMarkReadMutation(ids, readAt);
      if (!mutation) return 0;
      const data = await request(mutation.query, mutation.variables);
      return Object.values(data || {}).filter(entry => entry?.success).length;
    },
  };
}

// ------------------------------------------------------------------------------------------------ normalization

const str = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : '';
const num = (value, fallback = 0) => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : fallback;
/** Linear colors are #hex; anything else is dropped so it can never reach a style attribute. */
export const safeColor = value => /^#[\da-f]{3,8}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';
/** Issue and notification links must point at linear.app. */
export const safeLinearUrl = value => {
  try { const url = new URL(String(value || '')); return url.protocol === 'https:' && /(^|\.)linear\.app$/.test(url.hostname) ? url.href : ''; } catch { return ''; }
};
const nodes = connection => Array.isArray(connection?.nodes) ? connection.nodes : Array.isArray(connection) ? connection : [];

export function normalizeViewer(viewer) {
  if (!viewer?.id) throw new LinearError('Linear did not return your account. Check the key and try again.', { kind: 'auth' });
  const org = viewer.organization || {};
  return {
    id: str(viewer.id, 80), name: str(viewer.displayName || viewer.name, 200) || str(viewer.name, 200), fullName: str(viewer.name, 200),
    email: str(viewer.email, 320), avatarUrl: str(viewer.avatarUrl, 1000),
    organization: { id: str(org.id, 80), name: str(org.name, 200), urlKey: str(org.urlKey, 120) },
  };
}

export function normalizeState(state) {
  if (!state?.id) return null;
  const type = STATE_TYPES.some(t => t.type === state.type) ? state.type : 'unstarted';
  return { id: str(state.id, 80), name: str(state.name, 120) || stateTypeOf(type).label, type, color: safeColor(state.color), position: num(state.position) };
}

const sortStates = states => states.sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || a.position - b.position || a.name.localeCompare(b.name));

export function normalizeTeams(data) {
  const member = new Set(nodes(data?.viewer?.teams).map(team => team?.id));
  return nodes(data?.teams).filter(team => team?.id).map(team => ({
    id: str(team.id, 80), key: str(team.key, 20), name: str(team.name, 200), color: safeColor(team.color),
    cyclesEnabled: team.cyclesEnabled !== false, member: member.size ? member.has(team.id) : true,
    defaultStateId: str(team.defaultIssueState?.id, 80),
    states: sortStates(nodes(team.states).map(normalizeState).filter(Boolean)),
  })).sort((a, b) => Number(b.member) - Number(a.member) || a.name.localeCompare(b.name));
}

export function normalizeIssue(issue) {
  if (!issue?.id) return null;
  const state = normalizeState(issue.state) || { id: '', name: 'Todo', type: 'unstarted', color: '', position: 0 };
  const priority = Math.max(0, Math.min(4, Math.round(num(issue.priority))));
  const assignee = issue.assignee?.id ? { id: str(issue.assignee.id, 80), name: str(issue.assignee.displayName || issue.assignee.name, 200), fullName: str(issue.assignee.name, 200), avatarUrl: str(issue.assignee.avatarUrl, 1000) } : null;
  return {
    id: str(issue.id, 80), identifier: str(issue.identifier, 40), title: str(issue.title, 500) || 'Untitled issue', url: safeLinearUrl(issue.url),
    priority, priorityLabel: str(issue.priorityLabel, 40) || priorityOf(priority).label,
    estimate: issue.estimate == null ? null : num(issue.estimate, null), dueDate: /^\d{4}-\d{2}-\d{2}$/.test(issue.dueDate || '') ? issue.dueDate : '',
    branchName: str(issue.branchName, 300), updatedAt: str(issue.updatedAt, 40), createdAt: str(issue.createdAt, 40), completedAt: str(issue.completedAt, 40),
    state,
    team: issue.team?.id ? { id: str(issue.team.id, 80), key: str(issue.team.key, 20), name: str(issue.team.name, 200) } : null,
    project: issue.project?.id ? { id: str(issue.project.id, 80), name: str(issue.project.name, 200), color: safeColor(issue.project.color) } : null,
    labels: nodes(issue.labels).filter(l => l?.id).slice(0, 8).map(l => ({ id: str(l.id, 80), name: str(l.name, 80), color: safeColor(l.color) })),
    cycle: issue.cycle?.id ? { id: str(issue.cycle.id, 80), number: num(issue.cycle.number) } : null,
    assignee,
  };
}

export function normalizeCycle(cycle) {
  if (!cycle?.id) return null;
  const last = list => Array.isArray(list) && list.length ? num(list.at(-1)) : null;
  return {
    id: str(cycle.id, 80), number: num(cycle.number), name: str(cycle.name, 200), startsAt: str(cycle.startsAt, 40), endsAt: str(cycle.endsAt, 40),
    progress: Math.max(0, Math.min(1, num(cycle.progress))), scope: last(cycle.issueCountHistory), done: last(cycle.completedIssueCountHistory),
  };
}

const teamRef = team => team?.id ? { id: str(team.id, 80), key: str(team.key, 20), name: str(team.name, 200) } : null;

/** Turns any issue-view response into { kind: 'issues', issues, cycle, team }. */
export function normalizeIssuesResult(data, { view = 'mine' } = {}) {
  const v = viewOf(view).id;
  if (v === 'cycle') {
    const cycle = data?.team?.activeCycle;
    return { kind: 'issues', team: teamRef(data?.team), cycle: normalizeCycle(cycle), issues: nodes(cycle?.issues).map(normalizeIssue).filter(Boolean) };
  }
  if (v === 'team') {
    return { kind: 'issues', team: teamRef(data?.team), cycle: normalizeCycle(data?.team?.activeCycle), issues: nodes(data?.team?.issues).map(normalizeIssue).filter(Boolean) };
  }
  const connection = v === 'created' ? data?.viewer?.createdIssues : data?.viewer?.assignedIssues;
  return { kind: 'issues', team: teamRef(data?.cycleTeam), cycle: normalizeCycle(data?.cycleTeam?.activeCycle), issues: nodes(connection).map(normalizeIssue).filter(Boolean) };
}

const NOTIFICATION_VERBS = {
  issueAssignedToYou: 'assigned you', issueUnassignedFromYou: 'unassigned you', issueMention: 'mentioned you',
  issueCommentMention: 'mentioned you in a comment', issueNewComment: 'commented', issueCommentReaction: 'reacted to your comment',
  issueEmojiReaction: 'reacted', issueReaction: 'reacted', issueStatusChanged: 'changed the status', issueStatusChangedAll: 'changed the status',
  issueCreated: 'created', issuePriorityUrgent: 'marked as urgent', issueDue: 'is due soon', issueSubscribed: 'subscribed you',
  issueBlocking: 'marked as blocking', issueUnblocked: 'unblocked', issueSlaBreached: 'breached its SLA', issueSlaHighRisk: 'is at risk of breaching its SLA',
  projectUpdateCreated: 'posted a project update', projectUpdateMentionPrompt: 'asked for a project update', projectAddedAsMember: 'added you to a project',
};
export const notificationVerb = type => NOTIFICATION_VERBS[type] || (/comment/i.test(type || '') ? 'commented' : /mention/i.test(type || '') ? 'mentioned you' : 'updated');

export function normalizeNotification(entry, now = Date.now()) {
  if (!entry?.id) return null;
  if (entry.snoozedUntilAt && Date.parse(entry.snoozedUntilAt) > now) return null;
  const issue = entry.issue?.id ? {
    id: str(entry.issue.id, 80), identifier: str(entry.issue.identifier, 40), title: str(entry.issue.title, 500), url: safeLinearUrl(entry.issue.url),
    priority: Math.max(0, Math.min(4, Math.round(num(entry.issue.priority)))), state: normalizeState(entry.issue.state),
    team: teamRef(entry.issue.team),
  } : null;
  const project = entry.project?.id ? { id: str(entry.project.id, 80), name: str(entry.project.name, 200), url: safeLinearUrl(entry.project.url) } : null;
  if (!issue && !project) return null;
  return {
    id: str(entry.id, 80), type: str(entry.type, 80), verb: notificationVerb(entry.type), readAt: str(entry.readAt, 40), createdAt: str(entry.createdAt, 40),
    // Full names read better in a sentence ("Ana Ruiz commented") than handles.
    actor: entry.actor?.id ? { id: str(entry.actor.id, 80), name: str(entry.actor.name || entry.actor.displayName, 200), avatarUrl: str(entry.actor.avatarUrl, 1000) } : null,
    comment: str(entry.comment?.body, 280).replace(/\s+/g, ' ').trim(),
    issue, project, url: issue?.url || project?.url || '',
  };
}

/** Newest first, whatever order the API used. */
export const normalizeNotifications = (list, now = Date.now()) => (Array.isArray(list) ? list : []).map(entry => normalizeNotification(entry, now)).filter(Boolean)
  .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
export const unreadCount = notifications => (notifications || []).filter(n => !n.readAt).length;

// ------------------------------------------------------------------------------------------------ sorting and grouping

const time = iso => Date.parse(iso || '') || 0;
const byUpdated = (a, b) => time(b.updatedAt) - time(a.updatedAt);
const byPriority = (a, b) => priorityOf(a.priority).rank - priorityOf(b.priority).rank;
const byDue = (a, b) => (a.dueDate ? 0 : 1) - (b.dueDate ? 0 : 1) || (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0);

export function sortIssues(issues = [], sort = 'updated') {
  const list = [...issues];
  if (sort === 'priority') return list.sort((a, b) => byPriority(a, b) || byUpdated(a, b));
  if (sort === 'due') return list.sort((a, b) => byDue(a, b) || byPriority(a, b) || byUpdated(a, b));
  return list.sort(byUpdated);
}

/** Drops closed issues unless "Show completed" is on (cycle views always fetch the whole cycle). */
export const visibleIssues = (issues = [], { showCompleted = false } = {}) => showCompleted ? issues : issues.filter(issue => !isClosedType(issue.state?.type));

/**
 * Groups issues for the list. Returns [{ key, label, count, issues, state?, priority?, project? }] in display order.
 * Status groups merge same-named states across teams ("In Progress" in two teams is one group).
 */
export function groupIssues(issues = [], by = 'status', { sort = 'updated' } = {}) {
  const sorted = sortIssues(issues, sort);
  if (by === 'none' || !GROUP_BYS.some(g => g.value === by)) return sorted.length ? [{ key: 'all', label: 'Issues', count: sorted.length, issues: sorted }] : [];
  const groups = new Map();
  for (const issue of sorted) {
    let key, seed;
    if (by === 'priority') { key = `priority:${issue.priority}`; seed = { label: priorityOf(issue.priority).label, priority: issue.priority, rank: priorityOf(issue.priority).rank }; }
    else if (by === 'project') {
      key = issue.project ? `project:${issue.project.id}` : 'project:none';
      seed = { label: issue.project?.name || 'No project', project: issue.project, rank: issue.project ? 0 : 1 };
    } else {
      const state = issue.state;
      key = `status:${state.type}:${state.name.toLowerCase()}`;
      seed = { label: state.name, state, rank: TYPE_RANK[state.type] * 1000 + Math.min(999, Math.max(0, Math.round(state.position))) };
    }
    if (!groups.has(key)) groups.set(key, { key, ...seed, issues: [] });
    groups.get(key).issues.push(issue);
  }
  const list = [...groups.values()].map(group => ({ ...group, count: group.issues.length }));
  return list.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

/** Counts per state type in STATE_TYPES order, skipping empty types: [{ type, label, tone, color, count }]. */
export function countByStateType(issues = []) {
  const counts = new Map();
  for (const issue of issues) {
    const type = issue.state?.type || 'unstarted';
    const entry = counts.get(type) || { ...stateTypeOf(type), color: issue.state?.color || '', count: 0 };
    entry.count++;
    counts.set(type, entry);
  }
  return STATE_TYPES.filter(t => counts.has(t.type)).map(t => counts.get(t.type));
}

/**
 * Progress for a cycle: counts from the cycle's own issues when the view has them, else the summary history.
 * Returns { number, name, total, done, started, ratio, startsAt, endsAt, daysLeft } or null.
 */
export function cycleProgress(cycle, issues = null, now = Date.now()) {
  if (!cycle) return null;
  let total, done, started = 0;
  if (Array.isArray(issues)) {
    const counted = issues.filter(issue => issue.state?.type !== 'canceled');
    total = counted.length;
    done = counted.filter(issue => issue.state?.type === 'completed').length;
    started = counted.filter(issue => issue.state?.type === 'started').length;
  } else {
    total = Math.max(0, Math.round(cycle.scope ?? 0));
    done = Math.max(0, Math.min(total, Math.round(cycle.done ?? 0)));
  }
  const end = time(cycle.endsAt);
  const daysLeft = end ? Math.max(0, Math.ceil((end - now) / 86400000)) : null;
  const ratio = total ? done / total : cycle.progress || 0;
  return { number: cycle.number, name: cycle.name, total, done, started, ratio: Math.max(0, Math.min(1, ratio)), startsAt: cycle.startsAt, endsAt: cycle.endsAt, daysLeft };
}

/** Due-date status for a YYYY-MM-DD date: 'overdue' | 'today' | 'soon' (≤ 3 days) | 'later' | ''. Closed issues are never overdue. */
export function dueStatus(dueDate, { now = Date.now(), closed = false } = {}) {
  if (!dueDate || closed) return dueDate ? 'later' : '';
  const today = new Date(now);
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, m, d] = dueDate.split('-').map(Number);
  const days = Math.round((Date.UTC(y, m - 1, d) - start) / 86400000);
  return days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 3 ? 'soon' : 'later';
}

/**
 * Optimistic copy of an issue after a local change. patch: { stateId, priority, assigneeId } (assigneeId null unassigns).
 * `states` are the team's workflow states; `viewer` supplies the name and avatar when assigning to yourself.
 */
export function applyIssuePatch(issue, patch = {}, { states = [], viewer = null } = {}) {
  if (!issue) return issue;
  const next = { ...issue, updatedAt: new Date().toISOString() };
  if (patch.stateId) {
    const state = states.find(s => s.id === patch.stateId);
    if (state) {
      next.state = { ...state };
      next.completedAt = state.type === 'completed' ? next.updatedAt : '';
    }
  }
  if (patch.priority !== undefined) {
    const p = priorityOf(patch.priority);
    next.priority = p.value;
    next.priorityLabel = p.label;
  }
  if (Object.hasOwn(patch, 'assigneeId')) {
    next.assignee = !patch.assigneeId ? null
      : viewer && viewer.id === patch.assigneeId ? { id: viewer.id, name: viewer.name, fullName: viewer.fullName || viewer.name, avatarUrl: viewer.avatarUrl || '' }
      : issue.assignee?.id === patch.assigneeId ? issue.assignee : { id: patch.assigneeId, name: '', fullName: '', avatarUrl: '' };
  }
  return next;
}

/** Replaces issues by id in a cached feed value; returns a new value (or the same one when nothing matched). */
export function replaceIssues(value, updated = []) {
  if (!value || value.kind !== 'issues' || !updated.length) return value;
  const byId = new Map(updated.filter(Boolean).map(issue => [issue.id, issue]));
  let changed = false;
  const issues = value.issues.map(issue => {
    if (!byId.has(issue.id)) return issue;
    changed = true;
    return byId.get(issue.id);
  });
  return changed ? { ...value, issues } : value;
}

// ------------------------------------------------------------------------------------------------ links and keys

/** Linear web address for a widget view (falls back to the workspace home). */
export function viewUrl({ view = 'mine', org = '', teamKey = '' } = {}) {
  const base = org ? `${LINEAR_APP}/${encodeURIComponent(org)}` : LINEAR_APP;
  if (!org) return base;
  const key = encodeURIComponent(teamKey || '');
  switch (viewOf(view).id) {
    case 'mine': return `${base}/my-issues/assigned`;
    case 'created': return `${base}/my-issues/created`;
    case 'team': return key ? `${base}/team/${key}/active` : base;
    case 'cycle': return key ? `${base}/team/${key}/cycles` : base;
    case 'inbox': return `${base}/inbox`;
    default: return base;
  }
}

/** Widget-cache key for a feed. Includes the viewer so a different account never sees another's cached issues. */
export function feedKey({ viewerId = '', view = 'mine', teamId = '', showCompleted = false } = {}) {
  const v = viewOf(view).id;
  if (v === 'inbox') return `linear:${viewerId}:inbox`;
  const team = v === 'mine' || v === 'created' ? teamId || '-' : teamId;
  return `linear:${viewerId}:${v}:${team}:${v === 'cycle' ? 'all' : showCompleted ? 'all' : 'open'}`;
}
export const teamsKey = viewerId => `linear:${viewerId}:teams`;

/**
 * Layout for a widget size: 'counts' (state-type tallies), 'list' (flat list) or 'grouped' (grouped list with the cycle bar
 * and quick create). Narrow-but-tall widgets get a list rather than wasting their height on three numbers.
 */
export function layoutFor({ size, w = 3, h = 3 } = {}) {
  if (size === 'xs' || h <= 2 || w <= 2) return 'counts';
  if (size === 'l' || size === 'xl') return 'grouped';
  if (size === 's' && h < 4) return 'counts';
  return 'list';
}
