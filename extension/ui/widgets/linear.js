// Linear widget: your issues, a team's issues, the current cycle or your inbox, with status, priority and assignment
// changed in place. Small sizes show counts by status; medium a list; large a grouped list with cycle progress and a
// quick-create row. Data and credentials live in ./linear/session.js; pure logic in lib/linear.js.
import { html, cx, safeHref, plural } from '../html.js';
import { icon } from '../icons.js';
import { button, iconButton, emptyState, skeleton, relativeDate } from '../components.js';
import { registerActions, registerMount } from '../runtime.js';
import { defineWidget } from '../dashboard/registry.js';
import { findWidget, updateWidgetConfig } from '../../lib/dashboard-store.js';
import {
  VIEWS, PRIORITIES, GROUP_BYS, SORTS, REFRESH_OPTIONS, COMPLETED_WINDOW_DAYS, LINEAR_ORIGIN, viewOf, priorityOf, isClosedType,
  normalizeConfig, layoutFor, visibleIssues, sortIssues, groupIssues, countByStateType, cycleProgress, dueStatus, unreadCount, viewUrl,
} from '../../lib/linear.js';
import {
  session, bindCtx, ensureAccount, connected, viewer, feedFor, syncFeed, ensureTeams, teamsList, statesFor, resolveTeamId, findIssue,
  updateIssue, markRead, mounted,
} from './linear/session.js';
import { statusGlyph, priorityGlyph, personAvatar, statusIconName, priorityIconName } from './linear/glyphs.js';
import { openConnect } from './linear/account.js';
import { openCreateIssue, renderQuickCreate, openExternal } from './linear/create.js';

const roving = new Map();    // widget id -> row id that holds the list's tab stop
const announce = new Map();  // widget id -> polite status text after a manual refresh

const widgetOf = id => findWidget(id)?.widget || null;
const configOf = id => normalizeConfig(widgetOf(id)?.config);
const setConfig = (id, patch) => updateWidgetConfig(id, patch);

function viewLabel(config, team) {
  if (config.view === 'team') return team ? `${team.key} issues` : 'Team issues';
  if (config.view === 'cycle') return team ? `${team.key} cycle` : 'Current cycle';
  return config.view === 'created' ? 'Created' : viewOf(config.view).label;
}
/** Full view name for labels and announcements ("Created by me" where the header says "Created"). */
const viewName = (config, team) => config.view === 'created' ? viewOf('created').label : viewLabel(config, team);
const orgKey = () => viewer()?.organization?.urlKey || '';

function dueText(date) {
  const [y, m, d] = date.split('-').map(Number);
  const value = new Date(y, m - 1, d);
  const sameYear = value.getFullYear() === new Date().getFullYear();
  return value.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
const DUE_WORDS = { overdue: 'overdue', today: 'due today', soon: 'due soon', later: '' };

// ------------------------------------------------------------------------------------------------ render

function render(ctx, widget, env) {
  bindCtx(ctx);
  ensureAccount();
  const config = normalizeConfig(widget.config);
  const layout = layoutFor(env);
  const wrap = content => html`<div class="w-linear" data-layout="${layout}" data-density="${config.density}" data-view="${config.view}">${content}
    <p class="sr-only" role="status">${announce.get(widget.id) || ''}</p></div>`;
  if (!session.loaded) return wrap(skeleton({ rows: layout === 'counts' ? 2 : 4, variant: 'text', className: 'w-linear-skeleton' }));
  if (!connected()) return wrap(setupState(layout));
  const feed = feedFor(config);
  const sync = html`<span class="w-linear-sync" data-mount="w.linear.sync" data-morph="skip" data-key="linear-sync-${widget.id}" data-widget="${widget.id}" hidden></span>`;
  if (!feed.value) {
    if (session.authFailed) return wrap(blockedState(layout, 'auth'));
    if (session.access === false) return wrap(blockedState(layout, 'access'));
    if (feed.error && !feed.loading) return wrap(html`${sync}${errorState(widget, feed, layout)}`);
    return wrap(html`${sync}${loadingState(layout)}`);
  }
  const body = feed.value.kind === 'inbox' ? renderInbox(ctx, widget, feed, layout, env) : renderIssues(ctx, widget, feed, layout, env);
  return wrap(html`${sync}${notice(widget, feed, layout)}${body}`);
}

function setupState(layout) {
  if (layout === 'counts') {
    return html`<div class="w-linear-setup is-compact">${icon('linear', { size: 20, className: 'w-linear-setup-mark' })}
      ${button({ label: 'Connect Linear', variant: 'primary', size: 'sm', action: 'w.linear.open-connect' })}</div>`;
  }
  return emptyState({ icon: 'linear', compact: true, className: 'w-linear-empty', title: 'Connect Linear',
    body: 'See your issues, the current cycle and your inbox here, and update them without leaving the dashboard.',
    actions: button({ label: 'Connect Linear', variant: 'primary', size: 'sm', action: 'w.linear.open-connect' }) });
}

function blockedState(layout, reason) {
  const auth = reason === 'auth';
  const action = auth ? button({ label: 'Reconnect Linear', variant: 'primary', size: 'sm', action: 'w.linear.open-connect' })
    : button({ label: 'Allow access to api.linear.app', variant: 'primary', size: 'sm', action: 'w.linear.allow-access' });
  if (layout === 'counts') return html`<div class="w-linear-setup is-compact">${icon(auth ? 'key-round' : 'lock', { size: 18, className: 'w-linear-setup-mark' })}${action}</div>`;
  return emptyState({ icon: auth ? 'key-round' : 'lock', compact: true, className: 'w-linear-empty', title: auth ? 'Reconnect Linear' : 'Allow access to Linear',
    body: auth ? 'Linear no longer accepts the saved API key. Paste a new key to see your issues again.'
      : 'Chrome needs your permission before Still can load issues from api.linear.app.', actions: action });
}

function errorState(widget, feed, layout) {
  const retry = button({ label: 'Try again', size: 'sm', variant: 'secondary', action: 'w.linear.refresh', data: { widget: widget.id } });
  if (layout === 'counts') return html`<div class="w-linear-setup is-compact" role="alert"><p class="w-linear-setup-text">${feed.error.message}</p>${retry}</div>`;
  const noTeam = viewOf(feed.config.view).team && !feed.teamId;
  return emptyState({ icon: noTeam ? 'users' : 'triangle-alert', tone: noTeam ? undefined : 'danger', compact: true, className: 'w-linear-empty',
    title: noTeam ? 'Choose a team' : 'Unable to load Linear', body: noTeam ? 'This view shows one team. Pick it in the widget settings.' : feed.error.message,
    actions: noTeam ? button({ label: 'Choose team', size: 'sm', variant: 'secondary', action: 'dashboard.widget-settings', data: { widget: widget.id } }) : retry });
}

function loadingState(layout) {
  if (layout === 'counts') return html`<div class="w-linear-counts is-loading" aria-busy="true"><span class="w-linear-total-num is-bone"></span>${skeleton({ rows: 1, variant: 'text' })}</div>`;
  return html`<div class="w-linear-loading" aria-busy="true">${skeleton({ rows: 5, variant: 'text', className: 'w-linear-skeleton' })}</div>`;
}

/** What is keeping fresh data from this widget, if anything: { text, label, action, kind }. */
function problem(feed) {
  if (session.authFailed) return { kind: 'auth', text: 'Linear rejected your API key.', label: 'Reconnect', title: 'Reconnect Linear', action: 'w.linear.open-connect' };
  if (session.access === false) return { kind: 'access', text: 'Linear can’t refresh without access.', label: 'Allow access', title: 'Allow access to api.linear.app', action: 'w.linear.allow-access' };
  if (feed.error && !feed.loading) return { kind: feed.error.kind, text: feed.error.message, label: 'Try again', title: 'Try loading Linear again', action: 'w.linear.refresh' };
  return null;
}

function notice(widget, feed, layout) {
  const issue = problem(feed);
  if (!issue || layout === 'counts') return '';   // small widgets show the problem as a header button instead
  return html`<div class="w-linear-notice" role="${issue.kind === 'rate' ? 'status' : 'alert'}">${icon('triangle-alert', { size: 14 })}<span class="w-linear-notice-text" title="${issue.text}">${issue.text}</span>
    <button type="button" class="w-linear-notice-action" data-action="${issue.action}" data-widget="${widget.id}" aria-label="${issue.title}">${issue.label}</button></div>`;
}

function footer(widget, feed, text) {
  const when = feed.at ? relativeDate(new Date(feed.at).toISOString()) : '';
  const status = feed.loading ? 'Refreshing…' : when ? `Updated ${when === 'Just now' ? 'just now' : when}` : '';
  return html`<footer class="w-linear-foot"><span class="w-linear-foot-count">${text}</span><span class="w-linear-foot-status">${status}</span></footer>`;
}

// ------------------------------------------------------------------------------------------------ issues

function renderIssues(ctx, widget, feed, layout, env) {
  const { config, value, team } = feed;
  const issues = visibleIssues(value.issues, { showCompleted: config.showCompleted });
  const progress = value.cycle && (config.view === 'cycle' || config.showCycle) ? cycleProgress(value.cycle, config.view === 'cycle' ? value.issues : null) : null;
  const href = viewUrl({ view: config.view, org: orgKey(), teamKey: team?.key || value.team?.key || '' });
  const openCount = value.issues.filter(issue => !isClosedType(issue.state.type)).length;
  if (layout === 'counts') return renderCounts(config, issues, progress, href, openCount);

  if (config.view === 'cycle' && !value.cycle) {
    return emptyState({ icon: 'calendar-range', compact: true, className: 'w-linear-empty', title: `${team?.name || 'This team'} has no active cycle`,
      body: 'Start a cycle in Linear, or show the team’s issues here instead.',
      actions: button({ label: 'Show team issues', size: 'sm', variant: 'secondary', action: 'w.linear.set-view', data: { widget: widget.id, view: 'team' } }) });
  }
  const showCycle = !!progress && (config.view === 'cycle' || (layout === 'grouped' && env.h >= 5));
  const showQuick = layout === 'grouped' && env.h >= 5 && config.view !== 'inbox';
  const showAssignee = config.view !== 'mine';
  let list;
  if (!issues.length) list = emptyIssues(widget, config, team);
  else if (layout === 'grouped' && config.groupBy !== 'none') list = renderGroups(widget, issues, config, showAssignee);
  else {
    const sorted = sortIssues(issues, config.sort);
    list = html`<ul class="w-linear-list" role="list" data-keydown="w.linear.list-key" data-widget="${widget.id}">${rows(widget, sorted, { showAssignee, tabId: tabStop(widget.id, sorted.map(i => i.id)) })}</ul>`;
  }
  const closedCount = issues.length - issues.filter(issue => !isClosedType(issue.state.type)).length;
  const summary = config.view === 'cycle' && progress ? `${progress.done} of ${plural(progress.total, 'issue')} done`
    : closedCount ? `${plural(openCount, 'open issue')} · ${closedCount.toLocaleString()} closed` : plural(openCount, 'open issue');
  return html`${showCycle ? cycleBar(progress, href) : ''}
    <div class="w-linear-scroll">${list}</div>
    ${showQuick ? renderQuickCreate(widget, team) : ''}
    ${footer(widget, feed, issues.length ? summary : '')}`;
}

function emptyIssues(widget, config, team) {
  const open = config.showCompleted ? 'recent' : 'open';
  const copy = {
    mine: [`No ${open} issues assigned to you`, 'Issues assigned to you in Linear show up here.'],
    created: [`No ${open} issues created by you`, 'Issues you create in Linear show up here.'],
    team: [`No active issues in ${team?.name || 'this team'}`, 'New and in-progress issues for the team show up here.'],
    cycle: ['Nothing left in this cycle', config.showCompleted ? 'The cycle has no issues yet.' : 'Every issue in the cycle is done. Turn on “Show completed issues” to see them.'],
  }[config.view] || ['No issues', ''];
  return emptyState({ icon: 'circle-check', compact: true, className: 'w-linear-empty', title: copy[0], body: copy[1],
    actions: button({ label: 'New issue', icon: 'plus', size: 'sm', variant: 'secondary', action: 'w.linear.new-issue', data: { widget: widget.id } }) });
}

function renderCounts(config, issues, progress, href, openCount) {
  if (config.view === 'cycle') {
    if (!progress) return html`<div class="w-linear-setup is-compact">${icon('calendar-range', { size: 18, className: 'w-linear-setup-mark' })}<p class="w-linear-setup-text">No active cycle</p></div>`;
    const percent = Math.round(progress.ratio * 100);
    return html`<div class="w-linear-counts is-cycle">
      <a class="w-linear-total" href="${safeHref(href)}" target="_blank" rel="noopener noreferrer">
        <span class="w-linear-total-num">${percent}<span class="w-linear-total-unit">%</span></span>
        <span class="w-linear-total-label">done in Cycle ${progress.number}</span>
      </a>
      ${progressTrack(progress)}
      <p class="w-linear-counts-meta">${progress.done} of ${plural(progress.total, 'issue')}${progress.daysLeft != null ? html` · ${plural(progress.daysLeft, 'day')} left` : ''}</p>
    </div>`;
  }
  const counts = countByStateType(issues);
  const next = sortIssues(issues.filter(issue => !isClosedType(issue.state.type)), config.sort === 'updated' ? 'priority' : config.sort).slice(0, 3);
  const total = config.showCompleted ? issues.length : openCount;
  const one = new Intl.PluralRules().select(total) === 'one';
  const label = config.showCompleted ? (one ? 'issue' : 'issues') : one ? 'open issue' : 'open issues';
  return html`<div class="w-linear-counts">
    <a class="w-linear-total" href="${safeHref(href)}" target="_blank" rel="noopener noreferrer" aria-label="${total} ${label}, ${viewOf(config.view).label}. Open in Linear">
      <span class="w-linear-total-num">${total}</span>
      <span class="w-linear-total-label">${label}</span>
    </a>
    ${next.length ? html`<ul class="w-linear-next" role="list" aria-label="Next up">${next.map(issue => html`<li><a class="w-linear-next-link" href="${safeHref(issue.url)}" target="_blank" rel="noopener noreferrer"
      title="${issue.identifier} ${issue.title}">${priorityGlyph(issue.priority)}<span class="sr-only">${issue.identifier}, ${priorityOf(issue.priority).label} priority: </span><span class="w-linear-next-title">${issue.title}</span></a></li>`)}</ul>` : ''}
    ${counts.length ? html`<ul class="w-linear-tally" role="list" aria-label="By status">${counts.map(c => html`<li class="w-linear-tally-item">
      ${statusGlyph({ type: c.type, color: c.color, name: c.label })}<span class="w-linear-tally-label">${c.label}</span><span class="w-linear-tally-n">${c.count}</span></li>`)}</ul>`
      : html`<p class="w-linear-counts-meta">${icon('circle-check', { size: 14 })}All clear</p>`}
  </div>`;
}

function progressTrack(progress) {
  const done = Math.round(progress.ratio * 100);
  const started = progress.total ? Math.round((progress.started / progress.total) * 100) : 0;
  return html`<div class="w-linear-cycle-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${done}" aria-label="Cycle ${progress.number}: ${done}% done">
    <span class="w-linear-cycle-done" style="inline-size:${done}%"></span>${started ? html`<span class="w-linear-cycle-started" style="inline-size:${Math.min(started, 100 - done)}%"></span>` : ''}</div>`;
}

function cycleBar(progress, href) {
  const percent = Math.round(progress.ratio * 100);
  return html`<div class="w-linear-cycle">
    <div class="w-linear-cycle-head">
      <a class="w-linear-cycle-name" href="${safeHref(href)}" target="_blank" rel="noopener noreferrer">${icon('calendar-range', { size: 13 })}<span>Cycle ${progress.number}${progress.name ? html` · ${progress.name}` : ''}</span></a>
      <span class="w-linear-cycle-meta"><span class="w-linear-num">${percent}%</span> · ${progress.done} of ${progress.total} done${progress.daysLeft != null ? html` · ${plural(progress.daysLeft, 'day')} left` : ''}</span>
    </div>
    ${progressTrack(progress)}
  </div>`;
}

function renderGroups(widget, issues, config, showAssignee) {
  const groups = groupIssues(issues, config.groupBy, { sort: config.sort });
  const collapsed = new Set(config.collapsed);
  const tabId = tabStop(widget.id, groups.filter(g => !collapsed.has(g.key)).flatMap(g => g.issues.map(i => i.id)));
  return html`<div class="w-linear-groups" data-keydown="w.linear.list-key" data-widget="${widget.id}">${groups.map((group, index) => {
    const open = !collapsed.has(group.key);
    const listId = `linear-${widget.id}-g${index}`;
    const glyph = group.state ? statusGlyph(group.state) : group.priority !== undefined ? priorityGlyph(group.priority) : icon('layers-2', { size: 14, className: 'w-linear-project-glyph' });
    return html`<section class="w-linear-group" data-key="group-${group.key}">
      <h3 class="w-linear-group-head"><button type="button" class="w-linear-group-toggle" aria-expanded="${open ? 'true' : 'false'}" aria-controls="${listId}"
        data-action="w.linear.toggle-group" data-widget="${widget.id}" data-group="${group.key}">
        ${icon('chevron-right', { size: 14, className: 'w-linear-group-chevron' })}${glyph}<span class="w-linear-group-name">${group.label}</span><span class="w-linear-group-count">${group.count}</span></button></h3>
      ${open ? html`<ul class="w-linear-list" id="${listId}" role="list">${rows(widget, group.issues, { showAssignee, showProject: config.groupBy !== 'project', tabId })}</ul>` : ''}
    </section>`;
  })}</div>`;
}

/** The one row in a list that takes the tab stop: the last row focused with the arrows, else the first row. */
function tabStop(widgetId, ids) {
  const current = roving.get(widgetId);
  return current && ids.includes(current) ? current : ids[0];
}

const rows = (widget, issues, { showAssignee, showProject = true, tabId }) => issues.map(issue => issueRow(widget, issue, { showAssignee, showProject, tabbable: issue.id === tabId }));

function issueRow(widget, issue, { showAssignee, showProject, tabbable }) {
  const closed = isClosedType(issue.state.type);
  const due = dueStatus(issue.dueDate, { closed });
  const prio = priorityOf(issue.priority);
  const labels = issue.labels.slice(0, 2);
  const more = issue.labels.length - labels.length;
  const assignee = issue.assignee ? issue.assignee.fullName || issue.assignee.name : '';
  const extra = [due && `${DUE_WORDS[due] ? `${DUE_WORDS[due]}, ` : 'due '}${dueText(issue.dueDate)}`, showAssignee && (assignee ? `assigned to ${assignee}` : 'unassigned'),
    issue.labels.length && `labels ${issue.labels.map(l => l.name).join(', ')}`].filter(Boolean).join('; ');
  const data = html`data-widget="${widget.id}" data-issue="${issue.id}"`;
  return html`<li class="${cx('w-linear-row', closed && 'is-closed')}" data-key="issue-${issue.id}" data-row="${issue.id}">
    <button type="button" class="w-linear-prio" data-action="w.linear.priority-menu" ${data} tabindex="-1" aria-haspopup="menu" aria-label="Priority: ${prio.label}. Change priority" title="Priority: ${prio.label}">${priorityGlyph(issue.priority)}</button>
    <span class="w-linear-id" aria-hidden="true">${issue.identifier}</span>
    <button type="button" class="w-linear-status" data-action="w.linear.status-menu" ${data} tabindex="-1" aria-haspopup="menu" aria-label="Status: ${issue.state.name}. Change status" title="${issue.state.name}">${statusGlyph(issue.state)}</button>
    <a class="w-linear-link" href="${safeHref(issue.url)}" target="_blank" rel="noopener noreferrer" tabindex="${tabbable ? '0' : '-1'}" title="${issue.title}" aria-keyshortcuts="S P I C B Shift+F10">
      <span class="sr-only">${issue.identifier}, ${issue.state.name}, ${prio.label} priority: </span><span class="w-linear-title">${issue.title}</span>${extra ? html`<span class="sr-only">. ${extra}</span>` : ''}</a>
    <button type="button" class="w-linear-more" data-action="w.linear.issue-menu" ${data} tabindex="-1" aria-haspopup="menu" aria-label="Actions for ${issue.identifier}" title="Actions">${icon('ellipsis', { size: 16 })}</button>
    <span class="w-linear-meta" aria-hidden="true">
      ${labels.length ? html`<span class="w-linear-labels">${labels.map(label => html`<span class="w-linear-label" ${label.color ? html`style="--lc:${label.color}"` : ''}><span class="w-linear-label-dot"></span><span class="w-linear-label-name">${label.name}</span></span>`)}${more > 0 ? html`<span class="w-linear-label is-more">+${more}</span>` : ''}</span>` : ''}
      ${issue.project && showProject ? html`<span class="w-linear-project">${icon('layers-2', { size: 12 })}<span>${issue.project.name}</span></span>` : ''}
      ${due ? html`<span class="w-linear-due" data-due="${due}">${icon(due === 'overdue' ? 'calendar-clock' : 'calendar', { size: 12 })}<span>${dueText(issue.dueDate)}</span></span>` : ''}
      ${showAssignee ? personAvatar(issue.assignee, { size: 18, className: 'w-linear-assignee' }) : ''}
    </span>
  </li>`;
}

// ------------------------------------------------------------------------------------------------ inbox

function renderInbox(ctx, widget, feed, layout) {
  const notes = feed.value.notifications;
  const unread = unreadCount(notes);
  const href = viewUrl({ view: 'inbox', org: orgKey() });
  if (layout === 'counts') {
    const latest = notes.find(n => !n.readAt) || notes[0];
    return html`<div class="w-linear-counts is-inbox">
      <a class="w-linear-total" href="${safeHref(href)}" target="_blank" rel="noopener noreferrer" aria-label="${plural(unread, 'unread notification')}. Open Linear inbox">
        <span class="w-linear-total-num">${unread}</span><span class="w-linear-total-label">unread</span></a>
      ${latest ? html`<p class="w-linear-counts-meta w-linear-latest">${latest.actor?.name || 'Linear'} ${latest.verb}${latest.issue ? html` <span class="w-linear-id">${latest.issue.identifier}</span>` : ''}</p>` : html`<p class="w-linear-counts-meta">${icon('circle-check', { size: 14 })}All caught up</p>`}
    </div>`;
  }
  if (!notes.length) {
    return html`<div class="w-linear-scroll">${emptyState({ icon: 'inbox', compact: true, className: 'w-linear-empty', title: 'You’re all caught up', body: 'New Linear notifications show up here.' })}</div>${footer(widget, feed, 'Inbox')}`;
  }
  const tabId = tabStop(widget.id, notes.map(n => n.id));
  return html`<div class="w-linear-scroll"><ul class="w-linear-list is-inbox" role="list" data-keydown="w.linear.list-key" data-widget="${widget.id}">${notes.map(note => {
    const tabbable = note.id === tabId;
    const isUnread = !note.readAt;
    const target = note.issue ? html`<span class="w-linear-id">${note.issue.identifier}</span> ${note.issue.title}` : note.project?.name || '';
    return html`<li class="${cx('w-linear-row', 'w-linear-note', isUnread && 'is-unread')}" data-key="note-${note.id}" data-row="${note.id}">
      ${personAvatar(note.actor, { size: 22, className: 'w-linear-note-avatar' })}
      <a class="w-linear-link" href="${safeHref(note.url)}" target="_blank" rel="noopener noreferrer" tabindex="${tabbable ? '0' : '-1'}" data-action="w.linear.open-note" data-widget="${widget.id}" data-note="${note.id}">
        <span class="w-linear-note-line"><span class="w-linear-note-what"><span class="w-linear-note-actor">${note.actor?.name || 'Linear'}</span> ${note.verb}</span><span class="sr-only">, </span><span class="w-linear-note-time">${relativeDate(note.createdAt)}</span>${isUnread ? html`<span class="sr-only">, unread</span>` : ''}</span>
        <span class="w-linear-note-target">${target}</span>
        ${note.comment ? html`<span class="w-linear-note-comment">${note.comment}</span>` : ''}
      </a>
      ${isUnread ? html`<span class="w-linear-unread-dot" aria-hidden="true"></span>
        <button type="button" class="w-linear-more" data-action="w.linear.mark-read" data-widget="${widget.id}" data-note="${note.id}" tabindex="-1" aria-label="Mark as read" title="Mark as read">${icon('check', { size: 16 })}</button>` : ''}
    </li>`;
  })}</ul></div>${footer(widget, feed, unread ? plural(unread, 'unread notification') : 'No unread notifications')}`;
}

// ------------------------------------------------------------------------------------------------ menus and changes

const copy = async (ctx, text, done) => { await navigator.clipboard.writeText(text); ctx.toast(done); };

async function openStatusMenu(ctx, anchor, issue) {
  if (!statesFor(issue.team?.id).length) await ensureTeams({ force: true });
  const states = statesFor(issue.team?.id);
  if (!states.length) { ctx.toast('Unable to load this team’s statuses. Try again in a moment.', { tone: 'danger' }); return; }
  if (!anchor?.isConnected) return;
  ctx.openMenu(anchor, [{ heading: `Status of ${issue.identifier}` }, ...states.map(state => ({
    label: state.name, icon: statusIconName(state.type), checked: state.id === issue.state.id, run: () => setStatus(ctx, issue.id, state),
  }))], { label: `Change status of ${issue.identifier}` });
}

function openPriorityMenu(ctx, anchor, issue) {
  ctx.openMenu(anchor, [{ heading: `Priority of ${issue.identifier}` }, ...PRIORITIES.map(p => ({
    label: p.label, icon: priorityIconName(p.value), checked: p.value === issue.priority, run: () => setPriority(ctx, issue.id, p),
  }))], { label: `Change priority of ${issue.identifier}` });
}

function openIssueMenu(ctx, anchor, issue) {
  const me = viewer();
  const mine = issue.assignee?.id && issue.assignee.id === me?.id;
  const saved = issue.url ? ctx.select?.savedForUrl?.(issue.url) : null;
  const row = anchor.closest('.w-linear-row');
  ctx.openMenu(anchor, [
    { label: 'Open in Linear', icon: 'external-link', shortcut: 'enter', run: () => openExternal(issue.url), disabled: !issue.url },
    { separator: true },
    { label: 'Change status…', icon: 'circle-dot', shortcut: 's', run: () => openStatusMenu(ctx, row?.querySelector('.w-linear-status') || anchor, issue) },
    { label: 'Change priority…', icon: 'signal-high', shortcut: 'p', run: () => openPriorityMenu(ctx, row?.querySelector('.w-linear-prio') || anchor, issue) },
    mine ? { label: 'Unassign', icon: 'user-round', run: () => assign(ctx, issue.id, null) } : { label: 'Assign to me', icon: 'user-round', shortcut: 'i', run: () => assign(ctx, issue.id, me?.id), disabled: !me },
    { separator: true },
    { label: 'Copy ID', icon: 'hash', shortcut: 'c', hint: issue.identifier, run: () => copy(ctx, issue.identifier, `Copied ${issue.identifier}`) },
    { label: 'Copy git branch name', icon: 'git-branch', shortcut: 'b', run: () => copy(ctx, issue.branchName, 'Copied the branch name'), disabled: !issue.branchName },
    { label: 'Copy link', icon: 'link', run: () => copy(ctx, issue.url, 'Copied the link'), disabled: !issue.url },
    { separator: true },
    saved ? { label: 'Open in Still', icon: 'bookmark-check', run: () => ctx.openItem(saved.id) } : { label: 'Save to Still', icon: 'bookmark-plus', run: () => saveToStill(ctx, issue), disabled: !issue.url },
  ], { label: `Actions for ${issue.identifier}`, placement: 'bottom-end' });
}

/** After a change hides a row (done, unassigned), keep keyboard focus in the list on its neighbour instead of the page. */
function keepListFocus(ctx, issueId) {
  const row = [...document.querySelectorAll('.w-linear-row')].find(el => el.dataset.row === issueId);
  const list = row?.closest('[data-keydown="w.linear.list-key"]');
  if (!list) return;
  const index = [...list.querySelectorAll('.w-linear-row')].indexOf(row);
  ctx.nextFrame(() => {
    if (row.isConnected || !list.isConnected || (document.activeElement && document.activeElement !== document.body)) return;
    const rowsNow = [...list.querySelectorAll('.w-linear-row')];
    const next = rowsNow[Math.min(index, rowsNow.length - 1)]?.querySelector('.w-linear-link');
    if (next) { for (const link of list.querySelectorAll('.w-linear-link')) link.tabIndex = -1; next.tabIndex = 0; next.focus(); }
  });
}

async function change(ctx, issueId, patch, message, undoPatch) {
  const issue = findIssue(issueId);
  if (!issue) { ctx.toast('That issue is no longer in this widget. Refresh and try again.', { tone: 'danger' }); return; }
  keepListFocus(ctx, issueId);
  try {
    await updateIssue(issue, patch);
    ctx.toast(message(issue), undoPatch ? { action: { label: 'Undo', run: () => updateIssue(findIssue(issueId) || issue, undoPatch(issue)) } } : {});
  } catch (error) {
    ctx.toast(error.message, { tone: 'danger' });
  }
}

const setStatus = (ctx, issueId, state) => {
  const issue = findIssue(issueId);
  if (!issue || issue.state.id === state.id) return;
  const before = issue.state.id;
  return change(ctx, issueId, { stateId: state.id }, i => `Moved ${i.identifier} to ${state.name}`, () => ({ stateId: before }));
};
const setPriority = (ctx, issueId, p) => {
  const issue = findIssue(issueId);
  if (!issue || issue.priority === p.value) return;
  const before = issue.priority;
  return change(ctx, issueId, { priority: p.value }, i => p.value ? `Set ${i.identifier} to ${p.label.toLowerCase()} priority` : `Removed the priority from ${i.identifier}`, () => ({ priority: before }));
};
const assign = (ctx, issueId, assigneeId) => {
  const issue = findIssue(issueId);
  if (!issue) return;
  const before = issue.assignee?.id || null;
  return change(ctx, issueId, { assigneeId }, i => assigneeId ? `Assigned ${i.identifier} to you` : `Unassigned ${i.identifier}`, () => ({ assigneeId: before }));
};

async function saveToStill(ctx, issue) {
  const existing = ctx.select?.savedForUrl?.(issue.url);
  if (existing) { ctx.toast('This issue is already in your library.', { action: { label: 'Open', run: () => ctx.openItem(existing.id) } }); return; }
  const item = await ctx.store.saveItem({
    type: 'bookmark', url: issue.url, title: `${issue.identifier}: ${issue.title}`, tags: ['linear'],
    excerpt: [issue.team?.name, issue.state.name, issue.priority ? `${issue.priorityLabel} priority` : '', issue.project?.name].filter(Boolean).join(' · '),
  });
  ctx.toast(`Saved ${issue.identifier} to your Inbox`, { tone: 'success', action: item?.id ? { label: 'Open', run: () => ctx.openItem(item.id) } : null });
}

function openViewMenu(ctx, anchor, widget) {
  const config = normalizeConfig(widget.config);
  const teams = teamsList();
  const teamId = resolveTeamId(config);
  const items = [{ heading: 'Show' }, ...VIEWS.map(view => ({ label: view.label, icon: view.icon, checked: view.id === config.view, run: () => setConfig(widget.id, { view: view.id }) }))];
  if (teams.length > 1) {
    items.push({ separator: true }, { heading: 'Team' }, ...teams.map(team => ({ label: team.name, hint: team.key, checked: team.id === teamId, run: () => setConfig(widget.id, { teamId: team.id }) })));
  }
  ctx.openMenu(anchor, items, { label: 'Choose what this widget shows', placement: 'bottom-end' });
}

async function manualRefresh(ctx, widgetId) {
  const widget = widgetOf(widgetId);
  if (!widget) return;
  announce.set(widgetId, '');
  await ensureTeams({ force: !teamsList().length });
  await syncFeed(widget.config, { force: true, manual: true });
  const feed = feedFor(widget.config);
  const message = feed.error ? `Linear did not refresh. ${feed.error.message}`
    : feed.value?.kind === 'inbox' ? `Linear refreshed. ${plural(unreadCount(feed.value.notifications), 'unread notification')}.`
    : feed.value ? `Linear refreshed. ${plural(visibleIssues(feed.value.issues, { showCompleted: feed.config.showCompleted }).length, 'issue')}.` : '';
  announce.set(widgetId, message);
  ctx.render();
}

// Roving focus inside a list: arrows move between rows, Right/Left between the row's link and its action button.
function handleListKey({ event, el, ctx, data }) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const row = event.target.closest('.w-linear-row');
  if (!row || !el.contains(row)) return;
  const rowsInList = [...el.querySelectorAll('.w-linear-row')];
  const index = rowsInList.indexOf(row);
  const focusRow = target => {
    const link = target?.querySelector('.w-linear-link');
    if (!link) return;
    for (const other of el.querySelectorAll('.w-linear-link')) other.tabIndex = -1;
    link.tabIndex = 0;
    link.focus();
    link.scrollIntoView({ block: 'nearest' });
    roving.set(data.widget, target.dataset.row);
  };
  const key = event.key;
  const issue = row.querySelector('.w-linear-status') ? findIssue(row.dataset.row) : null;
  const run = fn => { event.preventDefault(); fn(); };
  if (key === 'ArrowDown') return run(() => focusRow(rowsInList[Math.min(rowsInList.length - 1, index + 1)]));
  if (key === 'ArrowUp') return run(() => focusRow(rowsInList[Math.max(0, index - 1)]));
  if (key === 'Home') return run(() => focusRow(rowsInList[0]));
  if (key === 'End') return run(() => focusRow(rowsInList.at(-1)));
  if (key === 'ArrowRight' && event.target.classList.contains('w-linear-link')) return run(() => row.querySelector('.w-linear-more')?.focus());
  if (key === 'ArrowLeft' && !event.target.classList.contains('w-linear-link')) return run(() => focusRow(row));
  if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey)) {
    const more = row.querySelector('.w-linear-more');
    return run(() => (issue ? openIssueMenu(ctx, more, issue) : more?.click()));
  }
  if (!issue || event.shiftKey) return;
  const lower = key.toLowerCase();
  if (lower === 's') return run(() => openStatusMenu(ctx, row.querySelector('.w-linear-status'), issue));
  if (lower === 'p') return run(() => openPriorityMenu(ctx, row.querySelector('.w-linear-prio'), issue));
  if (lower === 'i') return run(() => assign(ctx, issue.id, viewer()?.id));
  if (lower === 'c') return run(() => copy(ctx, issue.identifier, `Copied ${issue.identifier}`));
  if (lower === 'b' && issue.branchName) return run(() => copy(ctx, issue.branchName, 'Copied the branch name'));
}

registerActions({
  'w.linear.open-connect': ({ ctx }) => openConnect(ctx),
  'w.linear.refresh': ({ ctx, data }) => manualRefresh(ctx, data.widget),
  'w.linear.view-menu': ({ ctx, el, data }) => { const widget = widgetOf(data.widget); if (widget) openViewMenu(ctx, el, widget); },
  'w.linear.set-view': ({ data }) => setConfig(data.widget, { view: data.view }),
  'w.linear.status-menu': ({ ctx, el, data }) => { const issue = findIssue(data.issue); if (issue) return openStatusMenu(ctx, el, issue); },
  'w.linear.priority-menu': ({ ctx, el, data }) => { const issue = findIssue(data.issue); if (issue) openPriorityMenu(ctx, el, issue); },
  'w.linear.issue-menu': ({ ctx, el, data }) => { const issue = findIssue(data.issue); if (issue) openIssueMenu(ctx, el, issue); },
  'w.linear.toggle-group': ({ data }) => {
    const collapsed = new Set(configOf(data.widget).collapsed);
    if (collapsed.has(data.group)) collapsed.delete(data.group); else collapsed.add(data.group);
    return setConfig(data.widget, { collapsed: [...collapsed].slice(-40) });
  },
  'w.linear.list-key': handleListKey,
  'w.linear.open-note': ({ data }) => { markRead([data.note]).catch(() => {}); },
  'w.linear.mark-read': ({ ctx, data }) => markRead([data.note]).catch(error => ctx.toast(error.message, { tone: 'danger' })),
  'w.linear.mark-all-read': ({ ctx, data }) => {
    const value = feedFor(configOf(data.widget)).value;
    const ids = value?.kind === 'inbox' ? value.notifications.filter(n => !n.readAt).map(n => n.id) : [];
    if (!ids.length) return;
    return markRead(ids).then(() => ctx.toast(`Marked ${plural(ids.length, 'notification')} as read`), error => ctx.toast(error.message, { tone: 'danger' }));
  },
  'w.linear.open-view': ({ data }) => {
    const config = configOf(data.widget);
    openExternal(viewUrl({ view: config.view, org: orgKey(), teamKey: feedFor(config).team?.key || '' }));
  },
});

// Keeps a widget's feed fresh while it is on screen: on mount, after every render (cheap when fresh), every 30 seconds
// (fetching only once the refresh interval has passed) and when the tab becomes visible again.
registerMount('w.linear.sync', el => {
  const id = el.dataset.widget;
  const sync = () => { const widget = widgetOf(id); if (widget && !document.hidden) syncFeed(widget.config); };
  const onVisible = () => sync();
  mounted.add(id);
  sync();
  const timer = setInterval(sync, 30000);
  document.addEventListener('visibilitychange', onVisible);
  return {
    update: sync,
    destroy() { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); mounted.delete(id); },
  };
});

// ------------------------------------------------------------------------------------------------ definition

defineWidget({
  type: 'linear',
  title: 'Linear',
  description: 'Your issues, current cycle or inbox. Update status and priority in place.',
  icon: 'linear',
  category: 'developer',
  keywords: ['linear', 'issues', 'tickets', 'cycle', 'sprint', 'inbox', 'triage', 'project', 'bugs'],
  size: { w: 4, h: 5, minW: 2, minH: 2, maxW: 12, maxH: 12 },
  presets: { S: { w: 3, h: 2 }, M: { w: 4, h: 5 }, L: { w: 6, h: 6 }, XL: { w: 9, h: 8 } },
  permissions: { origins: [LINEAR_ORIGIN] },
  preview: 'Issues by status',
  defaults: () => ({ view: 'mine', teamId: '', groupBy: 'status', sort: 'updated', showCompleted: false, showCycle: true, density: 'comfortable', refresh: 5, collapsed: [] }),
  init(ctx) { bindCtx(ctx); ensureAccount(); },
  render,
  headerActions(ctx, widget, env) {
    if (!session.loaded || !connected()) return '';
    const config = normalizeConfig(widget.config);
    const feed = feedFor(config);
    const data = { widget: widget.id };
    const unread = feed.value?.kind === 'inbox' ? unreadCount(feed.value.notifications) : 0;
    const issue = feed.value && layoutFor(env) === 'counts' ? problem(feed) : null;
    return html`${issue ? html`<span role="${issue.kind === 'rate' ? 'status' : 'alert'}" class="w-linear-alert">${iconButton({ icon: 'triangle-alert', label: `${issue.text} ${issue.title}`, action: issue.action, data, size: 'sm', className: 'w-linear-alert-btn' })}</span>` : ''}${env.w >= 4 ? button({ label: viewLabel(config, feed.team), iconRight: 'chevron-down', variant: 'ghost', size: 'sm', action: 'w.linear.view-menu', data, expanded: false, className: 'w-linear-view-btn', attrs: { 'aria-label': `Showing ${viewName(config, feed.team)}. Change view` } })
        : env.w === 3 ? iconButton({ icon: viewOf(config.view).icon, label: `Showing ${viewName(config, feed.team)}. Change view`, action: 'w.linear.view-menu', data, size: 'sm', expanded: false }) : ''}
      ${config.view === 'inbox' && unread && env.w >= 3 ? iconButton({ icon: 'check-check', label: 'Mark all as read', action: 'w.linear.mark-all-read', data, size: 'sm' }) : ''}
      ${config.view !== 'inbox' && env.w >= 4 && env.h >= 3 ? iconButton({ icon: 'plus', label: 'New issue', action: 'w.linear.new-issue', data, size: 'sm' }) : ''}
      ${env.w >= 3 ? iconButton({ icon: 'refresh-cw', label: feed.loading ? 'Refreshing' : 'Refresh', action: 'w.linear.refresh', data, size: 'sm', className: cx('w-linear-refresh', feed.loading && 'is-spinning') }) : ''}`;
  },
  menu(ctx, widget) {
    if (!connected()) return [{ label: 'Connect Linear…', icon: 'plug', run: () => openConnect(ctx) }];
    const config = normalizeConfig(widget.config);
    return [
      ...(config.view !== 'inbox' ? [{ label: 'New issue…', icon: 'plus', run: () => openCreateIssue(ctx, { widgetId: widget.id }) }] : []),
      { label: 'Refresh now', icon: 'refresh-cw', run: () => manualRefresh(ctx, widget.id) },
      { label: 'Open in Linear', icon: 'external-link', run: () => ctx.dispatch('w.linear.open-view', { data: { widget: widget.id } }) },
      { label: 'Linear account…', icon: 'key-round', run: () => ctx.navigate('settings:accounts') },
    ];
  },
  fields(ctx, widget) {
    bindCtx(ctx);
    ensureTeams();
    const teams = teamsList();
    const notInbox = draft => draft.view !== 'inbox';
    return [
      { name: 'view', label: 'Show', type: 'select', options: VIEWS.map(view => ({ value: view.id, label: view.label })) },
      { name: 'teamId', label: 'Team', type: 'select', hint: 'Used by the team and cycle views, for cycle progress and as the team for new issues.',
        options: [{ value: '', label: teams[0] ? `Your first team (${teams[0].name})` : 'Your first team' }, ...teams.map(team => ({ value: team.id, label: `${team.name} (${team.key})` }))] },
      { name: 'groupBy', label: 'Group by', type: 'select', options: GROUP_BYS.map(g => ({ value: g.value, label: g.label })), hint: 'Groups show when the widget is large.', when: notInbox },
      { name: 'sort', label: 'Sort by', type: 'segmented', options: SORTS.map(s => ({ value: s.value, label: s.value === 'updated' ? 'Updated' : s.label })), when: notInbox },
      { name: 'showCompleted', label: 'Show completed issues', type: 'toggle', hint: `Includes issues finished in the last ${COMPLETED_WINDOW_DAYS} days.`, when: notInbox },
      { name: 'showCycle', label: 'Show cycle progress', type: 'toggle', hint: 'Shows the team’s active cycle above large lists.', when: draft => draft.view !== 'inbox' && draft.view !== 'cycle' },
      { name: 'density', label: 'Density', type: 'segmented', options: [{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }] },
      { name: 'refresh', label: 'Refresh', type: 'select', options: REFRESH_OPTIONS.map(o => ({ value: String(o.value), label: o.label })) },
    ];
  },
  onSettingsSave: (ctx, widget, draft) => normalizeConfig(draft),
});
