// GitHub widget markup: summary tiles (xs/s), tabbed lists (m), list + detail pane (l/xl), Copilot, CI and inbox panels.
// Pure render helpers over a snapshot from lib/github.js; actions are registered in ../github.js.
import { html, cx, plural, safeHref } from '../../html.js';
import { icon } from '../../icons.js';
import { button, iconButton, badge, emptyState, skeleton, select, switchToggle, spinner, shortDate } from '../../components.js';
import {
  TABS, STATUS_META, MERGE_METHOD_LABELS, prStatus, copilotState, tabPullRequests, sortPullRequests, groupPullRequests, chooseMergeMethod,
  COPILOT_URL, COPILOT_AGENTS_URL, WEB,
} from '../../../lib/github.js';
import { githubAvatar as avatar } from './connection.js';

const TAB_BY_ID = Object.fromEntries(TABS.map(t => [t.id, t]));
export const TAB_URLS = {
  all: `${WEB}/pulls`, mine: `${WEB}/pulls`, reviews: `${WEB}/pulls/review-requested`, assigned: `${WEB}/pulls/assigned`,
  drafts: `${WEB}/pulls`, failing: `${WEB}/pulls`, copilot: COPILOT_AGENTS_URL, notifications: `${WEB}/notifications`,
};
const REASONS = {
  review_requested: 'Review requested', mention: 'Mentioned', team_mention: 'Team mentioned', assign: 'Assigned', author: 'Your thread',
  comment: 'New comment', ci_activity: 'CI activity', state_change: 'State changed', subscribed: 'Watching', manual: 'Subscribed',
  security_alert: 'Security alert', approval_requested: 'Approval requested', invitation: 'Invitation', member_feature_requested: 'Feature request',
};
const NOTIFICATION_ICONS = { PullRequest: 'git-pull-request', Issue: 'circle-dot', Release: 'tag', Discussion: 'messages-square', Commit: 'git-commit-horizontal', CheckSuite: 'circle-x' };

// ------------------------------------------------------------------ small pieces

/** Compact relative time ("now", "5m", "3h", "2d", "Oct 3") with the full date in a tooltip. */
export function ago(iso, now = Date.now()) {
  const time = Date.parse(iso || '');
  if (!time) return '';
  const minutes = Math.round((now - time) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / 1440)}d`;
  return shortDate(iso);
}
const fullDate = iso => { const d = new Date(iso || ''); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };
const timeEl = (iso, prefix = '') => iso ? html`<time datetime="${iso}" title="${prefix}${fullDate(iso)}">${ago(iso)}</time>` : '';
export const updatedLabel = at => {
  if (!at) return '';
  const minutes = Math.round((Date.now() - at) / 60000);
  return minutes < 1 ? 'Updated just now' : minutes < 60 ? `Updated ${plural(minutes, 'minute')} ago` : `Updated ${new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
};
const external = (href, content, className = '') => html`<a class="${className}" href="${safeHref(href)}" target="_blank" rel="noopener noreferrer">${content}</a>`;

function stateIcon(pr, status) {
  if (pr.draft) return 'git-pull-request-draft';
  if (status === 'ready' || status === 'queued') return 'git-pull-request-arrow';
  return 'git-pull-request';
}

/** CI indicator: icon plus count, with words for assistive tech. */
function ciSignal(pr) {
  const c = pr.checks || {};
  if (!c.state) return '';
  if (c.state === 'failure') {
    const n = c.failing?.length || 1;
    return html`<span class="w-github-signal" data-tone="danger" data-tooltip="${plural(n, 'check')} failing">${icon('circle-x', { size: 14 })}<span class="w-github-signal-n">${n}</span><span class="sr-only">${plural(n, 'check')} failing</span></span>`;
  }
  if (c.state === 'pending') return html`<span class="w-github-signal" data-tone="pending" data-tooltip="Checks running">${icon('loader-circle', { size: 14, className: 'w-github-spin' })}<span class="sr-only">Checks running</span></span>`;
  return html`<span class="w-github-signal" data-tone="success" data-tooltip="Checks passed">${icon('circle-check', { size: 14 })}<span class="sr-only">Checks passed</span></span>`;
}
const REVIEW_TEXT = { approved: ['Approved', 'success', 'check'], changes: ['Changes requested', 'warning', 'circle-alert'], required: ['Review required', 'neutral', 'eye'] };
function reviewText(pr) {
  const entry = REVIEW_TEXT[pr.review];
  if (!entry) return '';
  return html`<span class="w-github-review" data-tone="${entry[1]}">${icon(entry[2], { size: 12 })}<span>${entry[0]}</span></span>`;
}
function reviewSignal(pr) {
  const entry = pr.review === 'required' ? null : REVIEW_TEXT[pr.review];
  if (!entry) return '';
  return html`<span class="w-github-signal" data-tone="${entry[1]}" data-tooltip="${entry[0]}">${icon(pr.review === 'approved' ? 'check-check' : entry[2], { size: 14 })}<span class="sr-only">${entry[0]}</span></span>`;
}
const sep = html`<span class="w-github-sep" aria-hidden="true">·</span>`;
const authorName = author => (author.copilot ? 'Copilot' : author.login.replace(/\[bot\]$/, ''));

// ------------------------------------------------------------------ rows

export function prRow(widget, pr, { selectable = false, selected = false, implicit = false, copilot = false, hideRepo = false } = {}) {
  const status = prStatus(pr);
  const meta = STATUS_META[status];
  const agent = copilot ? copilotState(pr) : null;
  const title = selectable
    ? html`<button type="button" class="w-github-row-title" data-action="w.github.select" data-widget="${widget.id}" data-pr="${pr.id}" aria-current="${selected && !implicit ? 'true' : 'false'}" title="${pr.title}">${pr.title}</button>`
    : html`<a class="w-github-row-title" href="${safeHref(pr.url)}" target="_blank" rel="noopener noreferrer" title="${pr.title}">${pr.title}</a>`;
  return html`<li class="${cx('w-github-row', selected && 'is-selected', selected && implicit && 'is-implicit', pr.approving && 'is-busy')}" data-status="${status}" data-key="ghr-${widget.id}-${pr.id}">
    <span class="w-github-state" data-tone="${agent ? agent.tone : meta.tone}" data-tooltip="${agent ? agent.label : meta.label}">${icon(agent ? agent.icon : stateIcon(pr, status), { size: 16 })}<span class="sr-only">${agent ? agent.label : meta.label}.</span></span>
    <div class="w-github-row-main">
      ${title}
      <div class="w-github-row-line">
        <p class="w-github-row-meta"><span class="w-github-ref">${hideRepo ? '' : html`<span class="w-github-repo">${pr.repo}</span>`}<span class="w-github-num">#${pr.number}</span></span>${sep}<span class="w-github-by">${avatar(pr.author.avatarUrl, 14, '')}<span class="w-github-author">${authorName(pr.author)}</span></span>${sep}${timeEl(pr.updatedAt, 'Updated ')}${pr.labels.length ? html`<span class="w-github-row-labels">${pr.labels.slice(0, 2).map(labelChip)}</span>` : ''}</p>
        <span class="w-github-row-signals">
          ${pr.autoMerge ? html`<span class="w-github-signal" data-tone="success" data-tooltip="Auto-merge is on">${icon('zap', { size: 14 })}<span class="sr-only">Auto-merge is on</span></span>` : ''}
          ${reviewSignal(pr)}${ciSignal(pr)}
          ${pr.comments ? html`<span class="w-github-signal is-comments" data-tooltip="${plural(pr.comments, 'comment')}">${icon('message-square', { size: 14 })}<span class="w-github-signal-n">${pr.comments}</span><span class="sr-only">${plural(pr.comments, 'comment')}</span></span>` : ''}
        </span>
      </div>
    </div>
    ${iconButton({ icon: 'ellipsis', label: `More actions for #${pr.number}`, size: 'sm', action: 'w.github.pr-menu', data: { widget: widget.id, pr: pr.id }, className: 'w-github-row-more', tooltipPlacement: 'bottom end' })}
  </li>`;
}

export function labelChip(label) {
  return html`<span class="w-github-label" style="--label:#${label.color}" title="${label.name}"><span class="w-github-label-dot" aria-hidden="true"></span><span class="w-github-label-text">${label.name}</span></span>`;
}

function issueRow(issue) {
  return html`<li class="w-github-row is-issue" data-key="ghi-${issue.id}">
    <span class="w-github-state" data-tone="${issue.pr ? 'info' : 'neutral'}" data-tooltip="${issue.pr ? 'Copilot is working on it' : 'Assigned to Copilot'}">${icon('circle-dot', { size: 16 })}<span class="sr-only">${issue.pr ? 'Copilot is working on it.' : 'Assigned to Copilot.'}</span></span>
    <div class="w-github-row-main">
      ${external(issue.url, issue.title, 'w-github-row-title')}
      <p class="w-github-row-meta"><span class="w-github-ref"><span class="w-github-repo">${issue.repo}</span><span class="w-github-num">#${issue.number}</span></span>${sep}${timeEl(issue.updatedAt, 'Updated ')}
        ${issue.pr ? html`${sep}${external(issue.pr.url, html`${icon('git-pull-request-draft', { size: 12 })}<span>${issue.pr.draft ? 'Working in' : 'Opened'} #${issue.pr.number}</span>`, 'w-github-inline-link')}` : ''}</p>
    </div>
  </li>`;
}

function notificationRow(widget, item) {
  return html`<li class="${cx('w-github-row is-notification', !item.unread && 'is-read')}" data-key="ghn-${item.id}">
    <span class="w-github-state" data-tone="${item.unread ? 'info' : 'neutral'}">${icon(NOTIFICATION_ICONS[item.type] || 'bell', { size: 16 })}<span class="sr-only">${item.type || 'Notification'}${item.unread ? ', unread' : ''}.</span></span>
    <div class="w-github-row-main">
      ${external(item.url, item.title, 'w-github-row-title')}
      <p class="w-github-row-meta"><span class="w-github-ref">${item.repo}</span>${sep}<span>${REASONS[item.reason] || item.reason.replace(/_/g, ' ')}</span>${sep}${timeEl(item.updatedAt)}</p>
    </div>
    ${item.unread ? iconButton({ icon: 'check', label: 'Mark as read', size: 'sm', action: 'w.github.mark-read', data: { widget: widget.id, id: item.id }, className: 'w-github-row-action', tooltipPlacement: 'bottom end' }) : ''}
  </li>`;
}

function runRow(widget, run) {
  return html`<li class="${cx('w-github-row is-run', run.rerun && 'is-busy')}" data-key="ghrun-${run.repo}-${run.id}">
    <span class="w-github-state" data-tone="${run.rerun ? 'pending' : 'danger'}" data-tooltip="${run.rerun ? 'Re-run requested' : 'Workflow failed'}">${icon(run.rerun ? 'loader-circle' : 'circle-x', { size: 16, className: run.rerun ? 'w-github-spin' : '' })}<span class="sr-only">${run.rerun ? 'Re-run requested.' : 'Workflow failed.'}</span></span>
    <div class="w-github-row-main">
      ${external(run.url, html`${run.workflow}${run.title ? html`<span class="w-github-run-title"> · ${run.title}</span>` : ''}`, 'w-github-row-title')}
      <p class="w-github-row-meta"><span class="w-github-ref">${run.repo}</span>${sep}<span class="w-github-branch-name">${run.branch}</span>${sep}${timeEl(run.createdAt, 'Started ')}${run.attempt > 1 ? html`${sep}<span>Attempt ${run.attempt}</span>` : ''}</p>
    </div>
    ${run.rerun ? '' : button({ label: 'Re-run', icon: 'rotate-ccw', size: 'sm', variant: 'ghost', action: 'w.github.rerun', data: { widget: widget.id, repo: run.repo, run: run.id }, className: 'w-github-row-action', tooltip: 'Re-run failed jobs' })}
  </li>`;
}

// ------------------------------------------------------------------ tabs, lists, panels

export function tabBar(widget, tabs, active, counts) {
  return html`<div class="w-github-tabs" role="tablist" aria-label="GitHub lists">${tabs.map(id => {
    const tab = TAB_BY_ID[id];
    const n = counts[id] ?? 0;
    const on = id === active;
    return html`<button type="button" role="tab" class="w-github-tab" id="gh-${widget.id}-tab-${id}" aria-selected="${on ? 'true' : 'false'}" tabindex="${on ? '0' : '-1'}"
      aria-controls="gh-${widget.id}-panel" data-action="w.github.tab" data-widget="${widget.id}" data-value="${id}">
      <span>${tab.label}</span>${n ? html`<span class="${cx('w-github-count', (id === 'failing' || id === 'reviews' || id === 'notifications') && 'is-attention')}" data-tab="${id}">${n > 999 ? '999+' : n}</span>` : ''}
    </button>`;
  })}</div>`;
}

function prList(widget, prs, config, { selectable, selectedId, implicit = false, copilot = false }) {
  const groups = groupPullRequests(sortPullRequests(prs, config.sort), config.groupBy);
  const list = items => html`<ul class="w-github-list" role="list" data-keydown="w.github.list-key">${items.map(pr => prRow(widget, pr, { selectable, selected: pr.id === selectedId, implicit, copilot, hideRepo: config.groupBy === 'repo' }))}</ul>`;
  if (groups.length === 1 && !groups[0].label) return list(groups[0].items);
  return groups.map(group => html`<section class="w-github-group" aria-label="${group.label}">
    <h3 class="w-github-group-head"><span>${group.label}</span><span class="w-github-group-n">${group.items.length}</span></h3>
    ${list(group.items)}
  </section>`);
}

const EMPTY = {
  all: ['git-pull-request', 'No open pull requests', 'Pull requests you can see on GitHub appear here.'],
  mine: ['git-pull-request-create', 'You have no open pull requests', 'Pull requests you open show up here with their checks and reviews.'],
  reviews: ['circle-check-big', 'No reviews waiting', 'When someone asks for your review, it lands here.'],
  assigned: ['user-round', 'Nothing assigned to you', 'Pull requests assigned to you show up here.'],
  drafts: ['git-pull-request-draft', 'No drafts', 'Your draft pull requests show up here until they are ready for review.'],
  failing: ['circle-check-big', 'All checks are passing', 'Pull requests with failing checks and red workflow runs show up here.'],
  copilot: ['bot', 'No Copilot work in progress', 'Assign an issue to Copilot on GitHub and its pull request shows up here.'],
  notifications: ['bell', 'You’re all caught up', 'Unread GitHub notifications show up here.'],
};
const emptyFor = tab => { const [ico, title, body] = EMPTY[tab] || EMPTY.all; return emptyState({ icon: ico, title, body, compact: true }); };

function notificationsPanel(widget, snapshot, hidden) {
  const n = snapshot.notifications || {};
  const items = (n.items || []).filter(item => !hidden.has(item.id) && item.unread);
  if (n.error) return emptyState({ icon: 'bell-off', title: 'Notifications are not available', body: n.error, compact: true,
    actions: external(`${WEB}/notifications`, html`<span>Open notifications on GitHub</span>${icon('external-link', { size: 14 })}`, 'btn btn-secondary btn-sm') });
  if (!items.length) return emptyFor('notifications');
  return html`<div class="w-github-panel-bar"><span>${plural(items.length, 'unread notification')}${n.more ? ' (showing the latest 50)' : ''}</span>
      ${button({ label: 'Mark all as read', icon: 'check-check', size: 'sm', variant: 'ghost', action: 'w.github.mark-all-read', data: { widget: widget.id } })}</div>
    <ul class="w-github-list" role="list">${items.map(item => notificationRow(widget, item))}</ul>`;
}

function copilotPanel(widget, prs, snapshot, config, { selectable, selectedId, implicit }) {
  const issues = snapshot.copilot?.issues || [];
  const note = html`<p class="w-github-note">${icon('bot', { size: 16 })}<span>GitHub does not share Copilot Chat conversations through its API. ${external(COPILOT_URL, 'Open Copilot Chat', 'w-github-inline-link')} or see ${external(COPILOT_AGENTS_URL, 'agent sessions', 'w-github-inline-link')} on GitHub.</span></p>`;
  if (!prs.length && !issues.length) return html`${emptyFor('copilot')}${note}`;
  return html`${prs.length ? html`<section class="w-github-group" aria-labelledby="gh-${widget.id}-cp-prs"><h3 class="w-github-group-head" id="gh-${widget.id}-cp-prs"><span>Coding agent pull requests</span><span class="w-github-group-n">${prs.length}</span></h3>
      ${prList(widget, prs, { ...config, groupBy: 'none' }, { selectable, selectedId, implicit, copilot: true })}</section>` : ''}
    ${issues.length ? html`<section class="w-github-group" aria-labelledby="gh-${widget.id}-cp-issues"><h3 class="w-github-group-head" id="gh-${widget.id}-cp-issues"><span>Issues assigned to Copilot</span><span class="w-github-group-n">${issues.length}</span></h3>
      <ul class="w-github-list" role="list">${issues.map(issueRow)}</ul></section>` : ''}
    ${snapshot.copilot?.error ? html`<p class="w-github-note is-warning">${icon('triangle-alert', { size: 14 })}<span>${snapshot.copilot.error}</span></p>` : ''}
    ${note}`;
}

function failingPanel(widget, prs, snapshot, config, { selectable, selectedId, implicit }) {
  const runs = snapshot.runs || [];
  if (!prs.length && !runs.length) return html`${emptyFor('failing')}${snapshot.runsError ? html`<p class="w-github-note is-warning">${icon('triangle-alert', { size: 14 })}<span>${snapshot.runsError}</span></p>` : ''}`;
  return html`${prs.length ? html`<section class="w-github-group" aria-labelledby="gh-${widget.id}-f-prs"><h3 class="w-github-group-head" id="gh-${widget.id}-f-prs"><span>Pull requests</span><span class="w-github-group-n">${prs.length}</span></h3>
      ${prList(widget, prs, { ...config, groupBy: 'none' }, { selectable, selectedId, implicit })}</section>` : ''}
    ${runs.length ? html`<section class="w-github-group" aria-labelledby="gh-${widget.id}-f-runs"><h3 class="w-github-group-head" id="gh-${widget.id}-f-runs"><span>Workflow runs</span><span class="w-github-group-n">${runs.length}</span></h3>
      <ul class="w-github-list" role="list">${runs.map(run => runRow(widget, run))}</ul></section>` : ''}`;
}

/** The list for the active tab, plus the pull requests it shows (for detail selection). */
export function tabContent(widget, tab, prs, snapshot, config, hidden, { selectable = false, selectedId = null, implicit = false } = {}) {
  const facets = snapshot.facets || {};
  if (tab === 'notifications') return { markup: notificationsPanel(widget, snapshot, hidden), prs: [] };
  const list = sortPullRequests(tabPullRequests(prs, tab, { facets, config }), config.sort);
  if (tab === 'copilot') return { markup: copilotPanel(widget, list, snapshot, config, { selectable, selectedId, implicit }), prs: list };
  if (tab === 'failing') return { markup: failingPanel(widget, list, snapshot, config, { selectable, selectedId, implicit }), prs: list };
  return { markup: list.length ? prList(widget, list, config, { selectable, selectedId, implicit }) : emptyFor(tab), prs: list };
}

// ------------------------------------------------------------------ summary (xs / s)

const TILES = [
  { tab: 'all', label: 'Open', icon: 'git-pull-request' },
  { tab: 'reviews', label: 'Reviews', icon: 'eye' },
  { tab: 'failing', label: 'Failing', icon: 'circle-x', tone: 'danger' },
  { tab: 'notifications', label: 'Inbox', icon: 'bell' },
];
export function summaryTiles(widget, counts, config) {
  const shown = TILES.filter(t => t.tab === 'all' || config.tabs.includes(t.tab));
  return html`<div class="w-github-summary" data-count="${shown.length}">${shown.map(t => {
    const n = counts[t.tab] || 0;
    return html`<button type="button" class="w-github-tile" data-tab="${t.tab}" data-tone="${n && t.tone ? t.tone : ''}" data-action="w.github.peek" data-widget="${widget.id}"
      aria-haspopup="dialog" aria-label="${plural(n, t.tab === 'notifications' ? 'unread notification' : t.tab === 'reviews' ? 'review request' : t.tab === 'failing' ? 'pull request with failing checks' : 'open pull request')}">
      <span class="w-github-tile-top">${icon(t.icon, { size: 14 })}<span class="w-github-tile-label">${t.label}</span></span>
      <span class="w-github-tile-n">${n > 999 ? '999+' : n}</span>
    </button>`;
  })}</div>`;
}

/** Popover body for a summary tile: the first few entries of that list. */
export function peekBody(widget, tab, prs, snapshot, config, hidden) {
  const { markup } = tabContent(widget, tab, prs, snapshot, { ...config, groupBy: 'none' }, hidden);
  const label = TAB_BY_ID[tab]?.label || 'Pull requests';
  return html`<div class="w-github-peek" data-widget="${widget.id}">
    <header class="w-github-peek-head"><h3 class="w-github-peek-title">${tab === 'all' ? 'Open pull requests' : tab === 'notifications' ? 'Unread notifications' : label}</h3>
      ${external(TAB_URLS[tab] || `${WEB}/pulls`, html`<span>GitHub</span>${icon('external-link', { size: 12 })}`, 'w-github-inline-link')}</header>
    <div class="w-github-peek-body">${markup}</div>
  </div>`;
}

// ------------------------------------------------------------------ detail pane (l / xl)

function checkRow(widget, pr, check) {
  const tone = check.state === 'failure' ? 'danger' : check.state === 'pending' ? 'pending' : 'success';
  const ico = check.state === 'failure' ? 'circle-x' : check.state === 'pending' ? 'loader-circle' : 'circle-check';
  return html`<li class="w-github-check" data-tone="${tone}">
    ${icon(ico, { size: 14, className: check.state === 'pending' ? 'w-github-spin' : '' })}
    <span class="w-github-check-name" title="${check.workflow ? `${check.workflow} / ${check.name}` : check.name}">${check.workflow ? html`<span class="w-github-check-wf">${check.workflow} /</span> ` : ''}${check.name}</span>
    <span class="sr-only">${check.state === 'failure' ? 'failed' : check.state === 'pending' ? 'running' : 'passed'}</span>
    <span class="w-github-check-actions">
      ${check.url ? external(check.url, html`${icon('file-text', { size: 12 })}<span>Logs</span>`, 'w-github-mini-link') : ''}
      ${check.state === 'failure' && check.runId && !check.rerun ? html`<button type="button" class="w-github-mini-link" data-action="w.github.rerun" data-widget="${widget.id}" data-repo="${pr.repo}" data-run="${check.runId}">${icon('rotate-ccw', { size: 12 })}<span>Re-run</span></button>` : ''}
      ${check.rerun ? html`<span class="w-github-mini-note">Re-run requested</span>` : ''}
    </span>
  </li>`;
}

function checksSection(widget, pr) {
  const c = pr.checks || {};
  if (!c.state) return html`<section class="w-github-section"><h4 class="w-github-section-head">Checks</h4><p class="w-github-muted">No checks reported for the latest commit.</p></section>`;
  const parts = [c.failing.length && `${c.failing.length} failing`, c.pending.length && `${c.pending.length} running`, c.passing && `${c.passing} passing`, c.skipped && `${c.skipped} skipped`].filter(Boolean);
  return html`<section class="w-github-section" aria-labelledby="ghd-${widget.id}-checks">
    <h4 class="w-github-section-head" id="ghd-${widget.id}-checks"><span>Checks</span><span class="w-github-section-sum">${parts.join(' · ') || plural(c.total, 'check')}</span></h4>
    ${c.failing.length || c.pending.length ? html`<ul class="w-github-checks" role="list">${[...c.failing, ...c.pending].map(check => checkRow(widget, pr, check))}</ul>`
      : html`<p class="w-github-muted is-success">${icon('circle-check', { size: 14 })}<span>All checks passed</span></p>`}
  </section>`;
}

const REVIEW_STATES = { approved: ['Approved', 'success', 'check'], changes_requested: ['Requested changes', 'warning', 'circle-alert'], commented: ['Commented', 'neutral', 'message-square'], dismissed: ['Dismissed', 'neutral', 'circle-slash'], pending: ['Pending', 'neutral', 'clock'] };
function reviewersSection(widget, pr) {
  const reviewed = new Set(pr.reviews.map(r => r.login));
  const rows = [
    ...pr.reviews.map(r => ({ login: r.login, avatarUrl: r.avatarUrl, state: REVIEW_STATES[r.state] || ['Reviewed', 'neutral', 'eye'] })),
    ...pr.requested.filter(r => !reviewed.has(r.login)).map(r => ({ login: r.login, team: r.team, avatarUrl: r.avatarUrl, state: ['Requested', 'neutral', 'clock'] })),
  ];
  return html`<section class="w-github-section" aria-labelledby="ghd-${widget.id}-reviews">
    <h4 class="w-github-section-head" id="ghd-${widget.id}-reviews"><span>Reviews</span>${reviewText(pr) ? html`<span class="w-github-section-sum">${reviewText(pr)}</span>` : ''}</h4>
    ${rows.length ? html`<ul class="w-github-people" role="list">${rows.map(r => html`<li class="w-github-person">
        ${r.team ? html`<span class="w-github-avatar is-team" style="--size:20px" aria-hidden="true">${icon('users', { size: 12 })}</span>` : avatar(r.avatarUrl, 20, '')}
        <span class="w-github-person-name">${r.team || r.login}</span>
        <span class="w-github-review" data-tone="${r.state[1]}">${icon(r.state[2], { size: 12 })}<span>${r.state[0]}</span></span>
      </li>`)}</ul>` : html`<p class="w-github-muted">No reviewers yet.</p>`}
  </section>`;
}

function mergeBox(widget, pr, draftMethod) {
  const status = prStatus(pr);
  const method = chooseMergeMethod(pr.merge, draftMethod);
  let line;
  if (pr.draft) line = ['git-pull-request-draft', 'neutral', 'This pull request is still a draft.'];
  else if (status === 'conflict') line = ['triangle-alert', 'danger', 'This branch has conflicts. Resolve them on GitHub before merging.'];
  else if (pr.mergeState === 'BEHIND') line = ['git-compare', 'warning', `This branch is behind ${pr.base}. Update it before merging.`];
  else if (status === 'failing') line = ['circle-x', 'danger', 'Some checks are failing.'];
  else if (status === 'changes') line = ['circle-alert', 'warning', 'Changes were requested.'];
  else if (status === 'queued') line = ['zap', 'success', `Auto-merge is on. GitHub merges with “${MERGE_METHOD_LABELS[pr.autoMerge?.method] || 'the chosen method'}” when requirements pass.`];
  else if (status === 'pending') line = ['loader-circle', 'pending', 'Checks are still running.'];
  else if (status === 'review' || pr.mergeState === 'BLOCKED') line = ['eye', 'neutral', 'Merging is blocked until the required reviews and checks pass.'];
  else line = ['git-merge', 'success', 'Ready to merge.'];
  const canMerge = pr.can.merge && !pr.draft && status !== 'conflict';
  const autoToggle = pr.merge.autoAllowed && (pr.autoMerge ? pr.can.disableAutoMerge || pr.can.merge : pr.can.autoMerge) && !pr.draft;
  return html`<section class="w-github-section w-github-mergebox" aria-labelledby="ghd-${widget.id}-merge">
    <h4 class="sr-only" id="ghd-${widget.id}-merge">Merge</h4>
    <p class="w-github-merge-line" data-tone="${line[1]}">${icon(line[0], { size: 16, className: line[0] === 'loader-circle' ? 'w-github-spin' : '' })}<span>${line[2]}</span></p>
    ${pr.draft ? '' : pr.can.merge ? html`<div class="w-github-merge-row">
      ${pr.merge.methods.length > 1 ? select({ value: method, options: pr.merge.methods.map(m => ({ value: m, label: MERGE_METHOD_LABELS[m] })), action: 'w.github.method-pick', label: 'Merge method', size: 'sm', className: 'w-github-method-select', id: `ghd-${widget.id}-method` }) : ''}
      ${button({ label: pr.merge.methods.length > 1 ? 'Merge' : MERGE_METHOD_LABELS[method], icon: 'git-merge', variant: canMerge ? 'primary' : 'secondary', size: 'sm', action: 'w.github.merge', data: { widget: widget.id, pr: pr.id, method }, disabled: !canMerge })}
    </div>` : html`<p class="w-github-muted">You can’t merge in ${pr.repo}. Someone with write access can.</p>`}
    ${autoToggle ? switchToggle({ checked: !!pr.autoMerge, label: 'Merge automatically when ready', description: 'Uses the method above once reviews and checks pass.', action: 'w.github.auto-merge', data: { widget: widget.id, pr: pr.id, method } }) : ''}
    <div class="w-github-merge-more">
      ${pr.draft && pr.can.update ? button({ label: 'Ready for review', icon: 'eye', size: 'sm', variant: 'primary', action: 'w.github.ready', data: { widget: widget.id, pr: pr.id } }) : ''}
      ${!pr.mine && !pr.draft && !pr.approvedByViewer ? button({ label: 'Approve', icon: 'check', size: 'sm', action: 'w.github.approve', data: { widget: widget.id, pr: pr.id }, loading: !!pr.approving }) : ''}
      ${pr.can.updateBranch && pr.mergeState === 'BEHIND' ? button({ label: 'Update branch', icon: 'git-compare', size: 'sm', action: 'w.github.update-branch', data: { widget: widget.id, pr: pr.id }, loading: !!pr.updating }) : ''}
      ${iconButton({ icon: 'ellipsis', label: 'More actions', size: 'sm', action: 'w.github.pr-menu', data: { widget: widget.id, pr: pr.id, detail: 'true' }, variant: 'secondary' })}
    </div>
  </section>`;
}

export function detailPane(widget, pr, { open = false, method } = {}) {
  if (!pr) return html`<div class="w-github-detail is-empty">${emptyState({ icon: 'git-pull-request', title: 'Choose a pull request', body: 'Its checks, reviews and merge options show here.', compact: true })}</div>`;
  const status = prStatus(pr);
  const meta = STATUS_META[status];
  const id = `ghd-${widget.id}-title`;
  return html`<article class="w-github-detail" aria-labelledby="${id}" data-key="ghd-${widget.id}-${pr.id}">
    <div class="w-github-detail-scroll">
      <header class="w-github-detail-head">
        ${open ? html`<button type="button" class="btn btn-ghost btn-sm w-github-back" data-action="w.github.back" data-widget="${widget.id}">${icon('arrow-left', { size: 14 })}<span>All pull requests</span></button>` : ''}
        <p class="w-github-detail-ref">${external(`${WEB}/${pr.repo}`, pr.repo, 'w-github-inline-link w-github-repo')}<span class="w-github-num">#${pr.number}</span>${pr.private ? html`<span class="w-github-private">${icon('lock', { size: 12 })}<span>Private</span></span>` : ''}</p>
        <h3 class="w-github-detail-title" id="${id}">${external(pr.url, pr.title)}</h3>
        <p class="w-github-detail-by">${avatar(pr.author.avatarUrl, 18, '')}<span><strong>${authorName(pr.author)}</strong> opened ${timeEl(pr.createdAt, 'Opened ')} · updated ${timeEl(pr.updatedAt, 'Updated ')}</span></p>
        <div class="w-github-detail-badges">${badge({ label: meta.label, tone: meta.tone === 'pending' ? 'neutral' : meta.tone, icon: meta.icon })}${pr.author.copilot ? badge({ label: copilotState(pr).label, tone: 'info', icon: 'bot' }) : ''}</div>
      </header>
      <div class="w-github-branchline">
        <code class="w-github-branch-name" title="${pr.head}">${pr.head}</code>${icon('arrow-right', { size: 12 })}<code class="w-github-branch-name" title="${pr.base}">${pr.base}</code>
        ${iconButton({ icon: 'copy', label: 'Copy branch name', size: 'sm', action: 'app.copy', data: { text: pr.head, done: `Copied ${pr.head}` } })}
      </div>
      <dl class="w-github-stats">
        <div><dt>Changes</dt><dd><span class="w-github-add">+${pr.additions.toLocaleString()}</span> <span class="w-github-del">−${pr.deletions.toLocaleString()}</span></dd></div>
        <div><dt>Files</dt><dd>${pr.files.toLocaleString()}</dd></div>
        <div><dt>Comments</dt><dd>${pr.comments.toLocaleString()}</dd></div>
      </dl>
      ${pr.labels.length ? html`<div class="w-github-labels" aria-label="Labels">${pr.labels.map(labelChip)}</div>` : ''}
      ${checksSection(widget, pr)}
      ${reviewersSection(widget, pr)}
    </div>
    ${mergeBox(widget, pr, method)}
  </article>`;
}

// ------------------------------------------------------------------ states

export function setupState(widget, size) {
  if (size === 'xs' || size === 's') {
    return html`<div class="w-github-setup is-small">${icon('github', { size: 22 })}<p class="w-github-setup-title">GitHub</p>
      ${button({ label: 'Connect', size: 'sm', variant: 'primary', action: 'w.github.open-connect', data: { widget: widget.id } })}</div>`;
  }
  return emptyState({ icon: 'github', title: 'See every open pull request', compact: size === 'm',
    body: 'Connect GitHub to follow reviews, checks, notifications and Copilot work across all your organizations.',
    actions: html`${button({ label: 'Connect GitHub', icon: 'github', variant: 'primary', size: 'sm', action: 'w.github.open-connect', data: { widget: widget.id } })}
      ${button({ label: 'Use the GitHub CLI', icon: 'terminal', size: 'sm', action: 'w.github.open-connect', data: { widget: widget.id, method: 'bridge' } })}` });
}

export function accessState(widget, size) {
  if (size === 'xs' || size === 's') {
    return html`<div class="w-github-setup is-small">${icon('lock', { size: 20 })}<p class="w-github-setup-title">GitHub needs access</p>
      ${button({ label: 'Allow access', size: 'sm', variant: 'primary', action: 'w.github.allow', tooltip: 'Allow Still to reach api.github.com' })}</div>`;
  }
  return emptyState({ icon: 'lock', title: 'Allow access to GitHub', compact: true,
    body: 'Still needs permission to reach api.github.com to load your pull requests.',
    actions: button({ label: 'Allow access to api.github.com', size: 'sm', variant: 'primary', action: 'w.github.allow' }) });
}

export const loadingState = size => html`<div class="w-github-loading" aria-busy="true">${size === 'xs' || size === 's'
  ? html`<div class="w-github-summary is-loading">${[0, 1, 2, 3].map(() => html`<span class="w-github-tile is-skeleton"></span>`)}</div>`
  : skeleton({ rows: 4, variant: 'row' })}<span class="sr-only" role="status">Loading pull requests</span></div>`;

export function errorState(widget, error) {
  const auth = error.kind === 'auth';
  return emptyState({ icon: auth ? 'key-round' : error.kind === 'rate' ? 'hourglass' : 'triangle-alert', tone: auth ? 'danger' : undefined, compact: true,
    title: auth ? 'GitHub needs you to sign in again' : 'Pull requests could not load', body: error.message,
    actions: auth ? button({ label: 'Reconnect GitHub', size: 'sm', variant: 'primary', action: 'w.github.open-connect', data: { widget: widget.id } })
      : button({ label: 'Try again', icon: 'refresh-cw', size: 'sm', action: 'w.github.refresh', data: { widget: widget.id } }) });
}

/** Problems that leave the snapshot usable: a stale-data banner and partial warnings. */
export function banners(widget, entry) {
  const out = [];
  if (entry.error) {
    out.push(html`<p class="w-github-banner" data-tone="${entry.error.kind === 'auth' ? 'danger' : 'warning'}" role="${entry.error.kind === 'auth' ? 'alert' : 'status'}">
      ${icon(entry.error.kind === 'auth' ? 'key-round' : 'triangle-alert', { size: 14 })}<span>${entry.error.message}</span>
      ${entry.error.kind === 'auth' ? html`<button type="button" class="w-github-mini-link" data-action="w.github.open-connect" data-widget="${widget.id}">Reconnect</button>`
        : entry.error.kind !== 'rate' ? html`<button type="button" class="w-github-mini-link" data-action="w.github.refresh" data-widget="${widget.id}">Try again</button>` : ''}</p>`);
  }
  const warnings = entry.snapshot?.warnings || [];
  if (warnings.length) {
    out.push(html`<details class="w-github-warnings"><summary>${icon('info', { size: 14 })}<span>${plural(warnings.length, 'source', 'sources')} could not be loaded fully</span></summary>
      <ul role="list">${warnings.map(w => html`<li>${w}</li>`)}</ul></details>`);
  }
  return out;
}

export function footer(entry, size) {
  const snap = entry.snapshot;
  const rate = snap?.rate?.graphql;
  return html`<footer class="w-github-foot">
    <span class="w-github-foot-status" role="status">${entry.loading ? html`${spinner({ size: 12 })}<span>${entry.stage && size !== 's' ? `${entry.stage}…` : 'Refreshing…'}</span>` : html`<span>${updatedLabel(entry.fetchedAt)}</span>`}</span>
    ${rate && size !== 's' ? html`<span class="w-github-foot-rate" data-low="${rate.remaining < 500 ? 'true' : 'false'}" data-tooltip="GitHub API requests left this hour${rate.resetAt ? `, resets ${new Date(rate.resetAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}">${rate.remaining.toLocaleString()} left</span>` : ''}
  </footer>`;
}
