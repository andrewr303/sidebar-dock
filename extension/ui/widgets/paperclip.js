// Paperclip widget: tasks from your Paperclip company (assigned to you, open, or in review), optionally one project.
// Rows open the task in Paperclip; "Save to Still" keeps a Markdown copy (with comments and documents) as a note in the
// library. Data and credentials live in ./paperclip/session.js; pure logic in lib/paperclip.js.
import { html, cx, safeHref, plural } from '../html.js';
import { icon } from '../icons.js';
import { button, iconButton, emptyState, skeleton, relativeDate } from '../components.js';
import { registerActions, registerMount } from '../runtime.js';
import { defineWidget } from '../dashboard/registry.js';
import { findWidget, updateWidgetConfig } from '../../lib/dashboard-store.js';
import { VIEWS, viewOf, statusOf, priorityOf, issueUrl, issueToMarkdown, DEFAULT_PAPERCLIP_URL } from '../../lib/paperclip.js';
import {
  session, bindCtx, ensureAccount, connected, company, baseUrl, feedFor, syncFeed, mounted, findIssue, client, errorInfo, lists, ensureLists,
  normalizeConfig, REFRESH_OPTIONS,
} from './paperclip/session.js';
import { openConnect } from './paperclip/account.js';
import { openCreateTask, openExternal } from './paperclip/create.js';

const saving = new Set();   // issue ids being saved to Still
const widgetOf = id => findWidget(id)?.widget || null;
const urlFor = issue => issueUrl(baseUrl(), issue, company().prefix);

function render(ctx, widget, env) {
  bindCtx(ctx);
  ensureAccount();
  const config = normalizeConfig(widget.config);
  const wrap = content => html`<div class="w-paperclip" data-view="${config.view}">${content}</div>`;
  if (!session.loaded) return wrap(skeleton({ rows: 4, variant: 'text' }));
  if (!connected()) {
    return wrap(emptyState({ icon: 'paperclip', compact: true, title: 'Connect Paperclip',
      body: env.h >= 3 ? 'See your AI company’s tasks here, save them to your library and send saved items as new tasks.' : '',
      actions: button({ label: 'Connect Paperclip', variant: 'primary', size: 'sm', action: 'w.paperclip.open-connect' }) }));
  }
  mounted.set(widget.id, config);
  const feed = feedFor(config);
  const sync = html`<span data-mount="w.paperclip.sync" data-morph="skip" data-key="paperclip-sync-${widget.id}" data-widget="${widget.id}" hidden></span>`;
  const host = baseUrl().replace(/^https?:\/\//, '');
  if (session.authFailed && !feed.value) {
    return wrap(emptyState({ icon: 'key-round', compact: true, title: 'Reconnect Paperclip', body: 'Paperclip no longer accepts the saved key.',
      actions: button({ label: 'Reconnect', variant: 'primary', size: 'sm', action: 'w.paperclip.open-connect' }) }));
  }
  if (session.access === false && !feed.value) {
    return wrap(emptyState({ icon: 'lock', compact: true, title: 'Allow access to Paperclip', body: `Chrome needs your permission before Still can load tasks from ${host}.`,
      actions: button({ label: 'Allow access', variant: 'primary', size: 'sm', action: 'w.paperclip.allow-access' }) }));
  }
  if (!feed.value) {
    if (feed.error && !feed.loading) {
      return wrap(html`${sync}${emptyState({ icon: 'triangle-alert', tone: 'danger', compact: true, title: 'Unable to load Paperclip', body: feed.error.message,
        actions: button({ label: 'Try again', size: 'sm', variant: 'secondary', action: 'w.paperclip.refresh', data: { widget: widget.id } }) })}`);
    }
    return wrap(html`${sync}<div aria-busy="true">${skeleton({ rows: 5, variant: 'text' })}</div>`);
  }
  const issues = feed.value.issues || [];
  const problem = feed.error && !feed.loading ? feed.error.message : '';
  const when = feed.at ? relativeDate(new Date(feed.at).toISOString()) : '';
  return wrap(html`${sync}
    ${problem ? html`<p class="w-paperclip-notice" role="alert">${icon('triangle-alert', { size: 14 })}<span>${problem}</span></p>` : ''}
    <div class="w-paperclip-scroll">${issues.length ? html`<ul class="w-paperclip-list" role="list">${issues.map(issue => row(widget, issue, env))}</ul>` : emptyIssues(config)}</div>
    <footer class="w-paperclip-foot"><span>${issues.length ? plural(issues.length, 'task') : ''}</span><span>${feed.loading ? 'Refreshing…' : when ? `Updated ${when === 'Just now' ? 'just now' : when}` : ''}</span></footer>`);
}

function emptyIssues(config) {
  const copy = { mine: ['Nothing assigned to you', 'Tasks assigned to you in Paperclip show up here.'], open: ['No open tasks', 'New, in-progress and blocked tasks show up here.'],
    review: ['Nothing waiting for review', 'Tasks that agents hand back for review show up here.'] }[config.view];
  return emptyState({ icon: 'circle-check', compact: true, title: copy[0], body: config.projectId ? `${copy[1]} Only one project is shown.` : copy[1] });
}

function row(widget, issue, env) {
  const status = statusOf(issue.status);
  const priority = priorityOf(issue.priority);
  const url = urlFor(issue);
  const updated = issue.updatedAt ? relativeDate(issue.updatedAt) : '';
  return html`<li class="w-paperclip-row" data-status="${issue.status}">
    <a class="w-paperclip-link" href="${safeHref(url)}" target="_blank" rel="noopener noreferrer" title="Open ${issue.identifier || 'task'} in Paperclip">
      <span class="w-paperclip-id">${issue.identifier}</span>
      <span class="w-paperclip-title">${issue.title || 'Untitled task'}</span>
      <span class="w-paperclip-meta">
        <span class="w-paperclip-pill" data-tone="${status.tone}">${status.label}</span>
        ${priority && env.w >= 3 ? html`<span class="w-paperclip-priority" data-priority="${priority.value}">${priority.label}</span>` : ''}
        ${updated && env.w >= 4 ? html`<span class="w-paperclip-updated">${updated}</span>` : ''}
      </span>
    </a>
    ${iconButton({ icon: 'bookmark-plus', label: `Save ${issue.identifier || 'task'} to Still`, action: 'w.paperclip.save', data: { widget: widget.id, issue: issue.id }, size: 'sm',
      className: cx('w-paperclip-save', saving.has(issue.id) && 'is-busy'), disabled: saving.has(issue.id) })}
  </li>`;
}

/** Saves a task as a note: Markdown with its documents and latest comments, linked back to Paperclip and tagged. */
async function saveToStill(ctx, issueId) {
  const listed = findIssue(issueId);
  if (!listed || saving.has(issueId)) return;
  saving.add(issueId);
  ctx.render();
  try {
    const api = await client();
    const [issue, comments, documents] = await Promise.all([
      api.issue(issueId).catch(() => listed), api.comments(issueId, { limit: 30 }).catch(() => []), api.documents(issueId).catch(() => []),
    ]);
    const url = urlFor(issue || listed);
    const content = issueToMarkdown(issue || listed, { comments, documents, url });
    const existing = ctx.select?.live?.().find(item => item.type === 'note' && item.url === url);
    const title = [listed.identifier, (issue || listed).title].filter(Boolean).join(' · ');
    const item = existing ? await ctx.store.updateItem(existing.id, { content }) : await ctx.store.saveItem({ type: 'note', title, content, url, tags: ['paperclip'] });
    ctx.toast(existing ? `Updated ${title} in your library` : `Saved ${title} to your library`, { tone: 'success', action: item?.id ? { label: 'Open', run: () => ctx.openItem(item.id) } : null });
  } catch (error) {
    ctx.toast(errorInfo(error, 'Still could not save that task. Try again.').message, { tone: 'danger' });
  } finally { saving.delete(issueId); ctx.render(); }
}

function manualRefresh(widgetId) {
  const widget = widgetOf(widgetId);
  if (widget) syncFeed(widget.config, { force: true });
}

registerActions({
  'w.paperclip.open-connect': ({ ctx }) => openConnect(ctx),
  'w.paperclip.refresh': ({ data }) => manualRefresh(data.widget),
  'w.paperclip.save': ({ ctx, data }) => saveToStill(ctx, data.issue),
  'w.paperclip.view-menu': ({ ctx, el, data }) => {
    const config = normalizeConfig(widgetOf(data.widget)?.config);
    ctx.openMenu(el, VIEWS.map(view => ({ label: view.label, icon: config.view === view.id ? 'check' : 'blank', run: () => updateWidgetConfig(data.widget, { view: view.id }) })), { label: 'Show' });
  },
  'w.paperclip.new': ({ ctx, data }) => openCreateTask(ctx, { projectId: normalizeConfig(widgetOf(data.widget)?.config).projectId }),
});

// Keeps a widget's feed fresh while it is on screen: on mount, after every render (cheap when fresh), every 30 seconds
// (fetching only once the refresh interval has passed) and when the tab becomes visible again.
registerMount('w.paperclip.sync', el => {
  const id = el.dataset.widget;
  const sync = () => { const widget = widgetOf(id); if (widget && !document.hidden) syncFeed(widget.config); };
  sync();
  const timer = setInterval(sync, 30000);
  document.addEventListener('visibilitychange', sync);
  return { update: sync, destroy() { clearInterval(timer); document.removeEventListener('visibilitychange', sync); mounted.delete(id); } };
});

defineWidget({
  type: 'paperclip',
  title: 'Paperclip',
  description: 'Tasks from your Paperclip AI company: assigned to you, open or in review. Save them to your library.',
  icon: 'paperclip',
  category: 'developer',
  keywords: ['paperclip', 'tasks', 'issues', 'agents', 'company', 'review', 'ai'],
  size: { w: 4, h: 4, minW: 2, minH: 2, maxW: 12, maxH: 12 },
  presets: { S: { w: 3, h: 3 }, M: { w: 4, h: 4 }, L: { w: 6, h: 6 } },
  permissions: { origins: [`${DEFAULT_PAPERCLIP_URL}/*`] },
  preview: 'Tasks by status',
  defaults: () => ({ view: 'mine', projectId: '', refresh: 5 }),
  needsSetup: () => session.loaded && !connected(),
  init(ctx) { bindCtx(ctx); ensureAccount(); },
  render,
  headerActions(ctx, widget, env) {
    if (!session.loaded || !connected()) return '';
    const config = normalizeConfig(widget.config);
    const feed = feedFor(config);
    const data = { widget: widget.id };
    return html`${env.w >= 4 ? button({ label: viewOf(config.view).label, iconRight: 'chevron-down', variant: 'ghost', size: 'sm', action: 'w.paperclip.view-menu', data, expanded: false,
        attrs: { 'aria-label': `Showing ${viewOf(config.view).label}. Change view` } }) : ''}
      ${env.w >= 3 ? iconButton({ icon: 'plus', label: 'New task', action: 'w.paperclip.new', data, size: 'sm' }) : ''}
      ${env.w >= 3 ? iconButton({ icon: 'refresh-cw', label: feed.loading ? 'Refreshing' : 'Refresh', action: 'w.paperclip.refresh', data, size: 'sm', className: cx(feed.loading && 'is-spinning') }) : ''}`;
  },
  menu(ctx, widget) {
    if (!connected()) return [{ label: 'Connect Paperclip…', icon: 'plug', run: () => openConnect(ctx) }];
    return [
      { label: 'New task…', icon: 'plus', run: () => openCreateTask(ctx, { projectId: normalizeConfig(widget.config).projectId }) },
      { label: 'Refresh now', icon: 'refresh-cw', run: () => manualRefresh(widget.id) },
      { label: 'Open Paperclip', icon: 'external-link', run: () => openExternal(company().prefix ? `${baseUrl()}/${company().prefix}/issues` : baseUrl()) },
      { label: 'Paperclip account…', icon: 'key-round', run: () => ctx.navigate('settings:accounts') },
    ];
  },
  fields(ctx) {
    bindCtx(ctx);
    ensureLists();
    const { projects } = lists();
    return [
      { name: 'view', label: 'Show', type: 'select', options: VIEWS.map(view => ({ value: view.id, label: view.label })),
        hint: 'Assigned to me uses the agent behind an agent key, or you as the board user.' },
      { name: 'projectId', label: 'Project', type: 'select', options: [{ value: '', label: 'All projects' }, ...projects.map(p => ({ value: p.id, label: p.name || p.id }))] },
      { name: 'refresh', label: 'Refresh', type: 'select', options: REFRESH_OPTIONS.map(o => ({ value: String(o.value), label: o.label })) },
    ];
  },
  onSettingsSave: (ctx, widget, draft) => normalizeConfig(draft),
});
