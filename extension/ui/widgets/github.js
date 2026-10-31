// GitHub widget: every open pull request across the viewer's account and organizations, review requests, failing checks,
// Copilot coding agent work and the notifications inbox, with merge, approve, auto-merge and re-run actions.
// Sizes: xs/s summary tiles (each opens a short list), m one list with tabs, l/xl list plus a detail pane with a merge box.
// Data and auth live in ./github/ (data.js, connection.js); pure GitHub logic in lib/github.js.
import { html, cx } from '../html.js';
import { icon } from '../icons.js';
import { registerActions, registerMount } from '../runtime.js';
import { registerDialog, registerPopover } from '../overlay.js';
import { button, iconButton, segmented, field, input, textarea, dialogFrame } from '../components.js';
import { defineWidget } from '../dashboard/registry.js';
import { findWidget, updateWidgetConfig } from '../../lib/dashboard-store.js';
import {
  normalizeConfig, baseFilter, summarize, prStatus, MERGE_METHOD_LABELS, chooseMergeMethod, API_ORIGINS, WEB, TABS,
} from '../../lib/github.js';
import { bindConnection, authState, openConnect } from './github/connection.js';
import { datasetFor, hiddenIds, isDue, refresh, setRenderer, findPullRequest, actions as gh } from './github/data.js';
import {
  tabBar, tabContent, summaryTiles, peekBody, detailPane, setupState, accessState, loadingState, errorState, banners, footer, TAB_URLS,
} from './github/views.js';
import { renderGitHubSettings, saveGitHubSettings } from './github/settings.js';

const views = new Map(); // widget id -> { selected, open, method }
const viewOf = id => { if (!views.has(id)) views.set(id, { selected: null, open: false, method: null }); return views.get(id); };
const configOf = widgetId => normalizeConfig(findWidget(widgetId)?.widget?.config);
const isSmall = size => size === 'xs' || size === 's';
const TAB_LABELS = { ...Object.fromEntries(TABS.map(t => [t.id, t.label])), all: 'Open pull requests', notifications: 'Notifications' };

function liveMount(widget) {
  return html`<span class="w-github-live" data-mount="w.github.live" data-morph="skip" data-key="gh-live-${widget.id}" data-widget="${widget.id}" hidden></span>`;
}

function render(ctx, widget, env) {
  bindConnection(ctx);
  setRenderer(() => ctx.render());
  const auth = authState();
  if (!auth.loaded) return loadingState(env.size);
  if (!auth.info?.connected) return html`<div class="w-github is-setup" data-size="${env.size}">${setupState(widget, env.size)}</div>`;
  if (auth.access === false) return html`<div class="w-github is-setup" data-size="${env.size}">${accessState(widget, env.size)}</div>`;
  const config = normalizeConfig(widget.config);
  const entry = datasetFor(config);
  const snapshot = entry?.snapshot;
  const shell = body => html`<div class="${cx('w-github', entry?.loading && 'is-loading')}" data-size="${env.size}" data-density="${config.density}">${liveMount(widget)}${body}</div>`;
  if (!snapshot) return shell(entry?.error && !entry.loading ? errorState(widget, entry.error) : loadingState(env.size));

  const hidden = hiddenIds();
  const prs = baseFilter(snapshot.prs, config, { hidden });
  const counts = summarize(snapshot, config, { hidden });
  if (isSmall(env.size)) {
    return shell(html`${entry.error ? html`<p class="w-github-mini-error" role="status" data-tooltip="${entry.error.message}">${icon('triangle-alert', { size: 12 })}<span>${entry.error.kind === 'rate' ? 'Rate limited' : 'Not refreshed'}</span></p>` : ''}
      ${summaryTiles(widget, counts, config)}`);
  }

  const tab = config.tabs.includes(config.tab) ? config.tab : config.tabs[0];
  const view = viewOf(widget.id);
  const split = env.size === 'l' || env.size === 'xl';
  let { markup, prs: listed } = tabContent(widget, tab, prs, snapshot, config, hidden, { selectable: split, selectedId: split ? view.selected : null });
  // Wide layouts always show a pull request in the detail pane; mark the one shown when nothing was chosen yet.
  if (split && listed.length && !listed.some(pr => pr.id === view.selected)) ({ markup } = tabContent(widget, tab, prs, snapshot, config, hidden, { selectable: true, selectedId: listed[0].id, implicit: true }));
  const tabs = config.tabs.length > 1 ? tabBar(widget, config.tabs, tab, counts) : '';
  const panel = html`<div class="w-github-panel" ${tabs ? html`role="tabpanel" aria-labelledby="gh-${widget.id}-tab-${tab}"` : html`role="region" aria-label="${TAB_LABELS[tab]}"`} id="gh-${widget.id}-panel" tabindex="-1">
    ${banners(widget, entry)}${markup}</div>`;
  if (!split) return shell(html`${tabs}${panel}${footer(entry, env.size)}`);

  // Large: the list beside a detail pane. The chosen pull request stays selected across refreshes while it is listed;
  // otherwise the first one shows (and a narrow widget returns to its list).
  const chosen = listed.find(pr => pr.id === view.selected) || null;
  if (!chosen) view.open = false;
  const shown = chosen || listed[0] || null;
  return shell(html`${tabs}<div class="w-github-split" data-open="${view.open && shown ? 'true' : 'false'}" data-has-detail="${shown && tab !== 'notifications' ? 'true' : 'false'}">
      ${panel}${tab === 'notifications' ? '' : detailPane(widget, shown, { open: view.open, method: view.method })}
    </div>${footer(entry, env.size)}`);
}

defineWidget({
  type: 'github',
  title: 'GitHub',
  description: 'Every open pull request across your organizations, with reviews, checks, merge, Copilot work and your inbox.',
  icon: 'github',
  category: 'developer',
  keywords: ['pull requests', 'pr', 'code review', 'ci', 'actions', 'copilot', 'notifications', 'merge', 'git'],
  size: { w: 5, h: 5, minW: 2, minH: 2, maxW: 12, maxH: 12 },
  presets: { S: { w: 3, h: 2 }, M: { w: 5, h: 5 }, L: { w: 8, h: 6 }, XL: { w: 12, h: 7 } },
  permissions: { origins: API_ORIGINS },
  defaults: () => normalizeConfig({}),
  needsSetup: () => !authState().info?.connected,
  init: ctx => { bindConnection(ctx); setRenderer(() => ctx.render()); },
  render,
  headerActions: (ctx, widget) => {
    const auth = authState();
    if (!auth.info?.connected || auth.access === false) return '';
    const entry = datasetFor(normalizeConfig(widget.config));
    return html`${iconButton({ icon: 'refresh-cw', label: entry?.loading ? 'Refreshing pull requests' : 'Refresh pull requests', size: 'sm', action: 'w.github.refresh',
      data: { widget: widget.id }, className: cx('w-github-refresh', entry?.loading && 'is-spinning'), disabled: !!entry?.loading, tooltipPlacement: 'bottom' })}`;
  },
  menu: (ctx, widget) => {
    const auth = authState();
    const config = normalizeConfig(widget.config);
    return [
      ...(auth.info?.connected ? [
        { label: 'Refresh now', icon: 'refresh-cw', run: () => ctx.dispatch('w.github.refresh', { data: { widget: widget.id } }) },
        { label: 'Open pull requests on GitHub', icon: 'external-link', run: () => openUrl(TAB_URLS[config.tab] || `${WEB}/pulls`) },
      ] : []),
      { label: auth.info?.connected ? 'GitHub account…' : 'Connect GitHub…', icon: 'github', run: () => openConnect(ctx) },
    ];
  },
  renderSettings: (ctx, widget, draft) => renderGitHubSettings(ctx, widget, draft),
  onSettingsSave: (ctx, widget, draft) => saveGitHubSettings(draft),
  validateSettings: draft => (Array.isArray(draft.tabs) && draft.tabs.length ? null : { tabs: 'Choose at least one list to show.' }),
});

// ------------------------------------------------------------------ background refresh

// One hidden element per widget instance: refreshes when due and while the page is visible, stops when the widget goes.
registerMount('w.github.live', (el, ctx) => {
  const widgetId = el.dataset.widget;
  const tick = () => {
    if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
    const config = configOf(widgetId);
    const entry = datasetFor(config);
    if (entry && isDue(entry, config.refresh)) refresh(entry, config);
  };
  const timer = setInterval(tick, 30000);
  const onVisible = () => tick();
  document.addEventListener('visibilitychange', onVisible);
  addEventListener('online', onVisible);
  queueMicrotask(tick);
  return {
    update: () => {},
    destroy: () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); removeEventListener('online', onVisible); },
  };
});

// ------------------------------------------------------------------ helpers

async function openUrl(url, background = false) {
  if (!/^https:\/\//.test(url || '')) return;
  if (globalThis.chrome?.tabs?.create) await chrome.tabs.create({ url, active: !background });
  else window.open(url, '_blank', 'noopener');
}

/** The pull request an action targets, with a readable error when it is gone. */
function prFor(data) {
  const pr = findPullRequest(data.pr);
  if (!pr) throw new Error('That pull request is no longer in the list. Refresh and try again.');
  return pr;
}

async function confirmClose(ctx, pr, widgetId) {
  const ok = await ctx.confirm({ title: `Close pull request #${pr.number}?`, body: `“${pr.title}” in ${pr.repo} closes without merging. You can reopen it on GitHub.`, confirmLabel: 'Close pull request', tone: 'danger' });
  if (!ok) return;
  await gh.close(pr, configOf(widgetId));
  ctx.toast(`Closed #${pr.number} in ${pr.repo}.`, { action: { label: 'Open on GitHub', run: () => openUrl(pr.url) } });
}

async function saveToStill(ctx, pr) {
  await ctx.store.saveItem({ type: 'bookmark', url: pr.url, title: `${pr.title} · ${pr.repo}#${pr.number}`,
    excerpt: `Pull request by @${pr.author.login} in ${pr.repo}: ${pr.head} into ${pr.base}.`, tags: ['github', 'pull-request'] });
  ctx.toast('Saved to Still.', { tone: 'success' });
}

function rerunAll(ctx, pr, widgetId) {
  const runs = [...new Set((pr.checks?.failing || []).map(c => c.runId).filter(Boolean))];
  return Promise.all(runs.map(id => gh.rerun(pr.repo, id, configOf(widgetId)))).then(() => ctx.toast(runs.length > 1 ? `Re-running ${runs.length} workflows.` : 'Re-running the failed jobs.'));
}

function prMenu(ctx, pr, widgetId, { detail = false } = {}) {
  const config = configOf(widgetId);
  const status = prStatus(pr);
  const failingRuns = (pr.checks?.failing || []).some(c => c.runId);
  const items = [
    ...(detail ? [] : [{ label: 'Open on GitHub', icon: 'external-link', run: () => openUrl(pr.url) }]),
    { label: 'Copy branch name', icon: 'git-branch', run: async () => { await navigator.clipboard.writeText(pr.head); ctx.toast(`Copied ${pr.head}`); } },
    { label: 'Copy link', icon: 'link', run: async () => { await navigator.clipboard.writeText(pr.url); ctx.toast('Link copied'); } },
    { label: 'Save to Still', icon: 'bookmark-plus', run: () => ctx.run(() => saveToStill(ctx, pr)) },
    { separator: true },
  ];
  if (!detail) {
    if (pr.can.merge && !pr.draft && status !== 'conflict') items.push({ label: 'Merge…', icon: 'git-merge', run: () => openMerge(ctx, pr, widgetId) });
    if (!pr.mine && !pr.draft && !pr.approvedByViewer) items.push({ label: 'Approve', icon: 'check', run: () => ctx.run(() => approve(ctx, pr, widgetId)) });
    if (pr.draft && pr.can.update) items.push({ label: 'Ready for review', icon: 'eye', run: () => ctx.run(() => gh.ready(pr, config).then(() => ctx.toast(`#${pr.number} is ready for review.`))) });
    if (pr.can.updateBranch && pr.mergeState === 'BEHIND') items.push({ label: 'Update branch', icon: 'git-compare', run: () => ctx.run(() => gh.updateBranch(pr, config).then(() => ctx.toast(`Updating ${pr.head} with ${pr.base}.`))) });
    if (pr.merge.autoAllowed && !pr.draft && (pr.autoMerge ? pr.can.disableAutoMerge || pr.can.merge : pr.can.autoMerge)) {
      items.push({ label: pr.autoMerge ? 'Turn off auto-merge' : 'Merge automatically when ready', icon: 'zap',
        run: () => ctx.run(() => toggleAutoMerge(ctx, pr, !pr.autoMerge, chooseMergeMethod(pr.merge), widgetId)) });
    }
  }
  if (failingRuns) items.push({ label: 'Re-run failed jobs', icon: 'rotate-ccw', run: () => ctx.run(() => rerunAll(ctx, pr, widgetId)) });
  if (pr.mine && !pr.draft && pr.can.update) items.push({ label: 'Convert to draft', icon: 'git-pull-request-draft', run: () => ctx.run(() => gh.draft(pr, config).then(() => ctx.toast(`#${pr.number} is a draft again.`))) });
  if (pr.can.update) items.push({ separator: true }, { label: 'Close pull request…', icon: 'git-pull-request-closed', danger: true, run: () => ctx.run(() => confirmClose(ctx, pr, widgetId)) });
  return items.filter((item, i, list) => !(item.separator && (i === list.length - 1 || list[i + 1]?.separator)));
}

async function approve(ctx, pr, widgetId) {
  await gh.approve(pr, configOf(widgetId));
  ctx.toast(`Approved #${pr.number}.`, { tone: 'success' });
}

async function toggleAutoMerge(ctx, pr, enabled, method, widgetId) {
  await gh.autoMerge(pr, enabled, method, configOf(widgetId));
  ctx.toast(enabled ? `#${pr.number} merges automatically when it is ready.` : `Auto-merge is off for #${pr.number}.`);
}

// ------------------------------------------------------------------ merge dialog

let mergeDraft = null; // { prId, widgetId, method, title, message, busy, error }

function openMerge(ctx, pr, widgetId, method) {
  mergeDraft = { prId: pr.id, widgetId, method: chooseMergeMethod(pr.merge, method || viewOf(widgetId).method), title: `${pr.title} (#${pr.number})`, message: '', busy: false, error: '' };
  ctx.openDialog('github.merge', { size: 'md' });
}

function readiness(pr) {
  const c = pr.checks || {};
  const rows = [];
  rows.push(c.state === 'failure' ? ['circle-x', 'danger', `${c.failing.length || 'Some'} ${c.failing.length === 1 ? 'check is' : 'checks are'} failing`]
    : c.state === 'pending' ? ['loader-circle', 'pending', 'Checks are still running']
    : c.state === 'success' ? ['circle-check', 'success', 'All checks passed'] : ['circle-dashed', 'neutral', 'No checks reported']);
  rows.push(pr.review === 'approved' ? ['check', 'success', 'Approved'] : pr.review === 'changes' ? ['circle-alert', 'warning', 'Changes were requested']
    : pr.review === 'required' ? ['eye', 'neutral', 'Review required'] : ['eye', 'neutral', 'No review required']);
  if (pr.mergeState === 'BEHIND') rows.push(['git-compare', 'warning', `Behind ${pr.base}`]);
  if (pr.mergeState === 'BLOCKED' && pr.review !== 'required') rows.push(['lock', 'neutral', 'Blocked by branch protection']);
  return rows;
}

registerDialog('github.merge', ctx => {
  const pr = mergeDraft && findPullRequest(mergeDraft.prId);
  if (!pr) return dialogFrame({ name: 'github.merge', title: 'Merge pull request', body: html`<p>This pull request is no longer in the list.</p>` });
  const method = chooseMergeMethod(pr.merge, mergeDraft.method);
  const status = prStatus(pr);
  const blocked = ['failing', 'changes', 'review', 'pending'].includes(status) || pr.mergeState === 'BLOCKED' || pr.mergeState === 'BEHIND';
  return html`<form class="dialog-form" data-submit="w.github.merge-confirm" novalidate>${dialogFrame({
    name: 'github.merge', title: `Merge pull request #${pr.number}`, subtitle: `${pr.repo} · ${pr.head} into ${pr.base}`,
    body: html`<div class="w-github-merge-dialog">
      <p class="w-github-merge-pr">${pr.title}</p>
      <ul class="w-github-readiness" role="list">${readiness(pr).map(([ico, tone, text]) => html`<li data-tone="${tone}">${icon(ico, { size: 14 })}<span>${text}</span></li>`)}</ul>
      ${blocked ? html`<p class="w-github-account-note is-warning">${icon('info', { size: 14 })}<span>${pr.can.adminMerge ? 'Requirements are not met yet. As an admin you can still merge; GitHub records it as a bypass.' : 'GitHub may refuse the merge until the requirements pass. Auto-merge can merge it for you when they do.'}</span></p>` : ''}
      ${pr.merge.methods.length > 1 ? field({ label: 'Merge method', control: segmented({ name: 'method', value: method, action: 'w.github.merge-method', size: 'sm', ariaLabel: 'Merge method',
        options: pr.merge.methods.map(m => ({ value: m, label: { squash: 'Squash', merge: 'Merge commit', rebase: 'Rebase' }[m] })) }) }) : ''}
      ${method !== 'rebase' ? html`${field({ label: 'Commit title', id: 'gh-merge-title', control: input({ id: 'gh-merge-title', name: 'title', value: mergeDraft.title, action: 'w.github.merge-field', attrs: { 'data-field': 'title' } }) })}
        ${field({ label: 'Commit message', id: 'gh-merge-message', hint: method === 'squash' ? 'Optional. GitHub uses the pull request’s commits when this is empty.' : 'Optional.',
          control: textarea({ id: 'gh-merge-message', name: 'message', value: mergeDraft.message, rows: 3, action: 'w.github.merge-field', attrs: { 'data-field': 'message' }, describedBy: 'gh-merge-message-hint' }) })}`
        : html`<p class="w-github-muted">Each commit is added to ${pr.base} on its own, so there is no merge commit to name.</p>`}
      ${mergeDraft.error ? html`<p class="field-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${mergeDraft.error}</span></p>` : ''}
    </div>`,
    footer: html`${button({ label: 'Cancel', variant: 'ghost', action: 'overlay.dismiss' })}
      ${blocked && pr.merge.autoAllowed && !pr.autoMerge && pr.can.autoMerge ? button({ label: 'Merge when ready', icon: 'zap', action: 'w.github.merge-auto' }) : ''}
      ${button({ label: MERGE_METHOD_LABELS[method], icon: 'git-merge', variant: 'primary', type: 'submit', loading: mergeDraft.busy })}`,
  })}</form>`;
}, { size: 'md' });

// ------------------------------------------------------------------ peek popover (summary tiles)

registerPopover('github.peek', (ctx, props) => {
  const found = findWidget(props.widgetId);
  const config = normalizeConfig(found?.widget?.config);
  const entry = datasetFor(config);
  if (!found || !entry?.snapshot) return html`<p class="w-github-peek-empty">Nothing to show yet.</p>`;
  const hidden = hiddenIds();
  return peekBody(found.widget, props.tab, baseFilter(entry.snapshot.prs, config, { hidden }), entry.snapshot, config, hidden);
}, { role: 'dialog', className: 'w-github-peek-popover' });

// ------------------------------------------------------------------ actions

registerActions({
  'w.github.refresh': ({ data }) => {
    const config = configOf(data.widget);
    const entry = datasetFor(config);
    if (entry) return refresh(entry, config);
  },
  'w.github.tab': ({ data }) => {
    const view = viewOf(data.widget);
    Object.assign(view, { open: false, selected: view.selected });
    return updateWidgetConfig(data.widget, { tab: data.value });
  },
  'w.github.select': ({ ctx, data }) => {
    const view = viewOf(data.widget);
    Object.assign(view, { selected: data.pr, open: true, method: null });
    ctx.render();
    // When the detail pane replaces the list (narrow widgets), focus moves into it; beside the list, focus stays put.
    ctx.nextFrame(() => {
      const root = document.querySelector(`[data-widget-id="${CSS.escape(data.widget)}"]`);
      const panel = root?.querySelector('.w-github-split > .w-github-panel');
      if (panel && getComputedStyle(panel).display === 'none') root.querySelector('.w-github-detail-title a')?.focus({ preventScroll: true });
    });
  },
  'w.github.back': ({ ctx, data }) => {
    const view = viewOf(data.widget);
    const selected = view.selected;
    view.open = false;
    ctx.render();
    ctx.nextFrame(() => document.querySelector(`[data-widget-id="${CSS.escape(data.widget)}"] [data-pr="${CSS.escape(selected || '')}"]`)?.focus({ preventScroll: true }));
  },
  'w.github.list-key': ({ event }) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const current = event.target.closest('.w-github-row-title');
    const panel = event.target.closest('.w-github-panel');
    if (!current || !panel) return;
    const titles = [...panel.querySelectorAll('.w-github-row-title')];
    const index = titles.indexOf(current);
    const next = event.key === 'Home' ? titles[0] : event.key === 'End' ? titles.at(-1) : titles[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  },
  'w.github.peek': ({ ctx, el, data }) => ctx.openPopover('github.peek', el, { widgetId: data.widget, tab: el.dataset.tab }, { placement: 'bottom-start' }),
  'w.github.pr-menu': ({ ctx, el, data }) => {
    const pr = prFor(data);
    ctx.openMenu(el, prMenu(ctx, pr, data.widget, { detail: data.detail === 'true' }), { placement: 'bottom-end', label: `Actions for #${pr.number}` });
  },
  'w.github.method-pick': ({ el }) => {
    const widgetId = el.closest('[data-widget-id]')?.dataset.widgetId;
    if (widgetId) viewOf(widgetId).method = el.value;
  },
  'w.github.merge': ({ ctx, data }) => openMerge(ctx, prFor(data), data.widget, viewOf(data.widget).method || data.method),
  'w.github.merge-method': ({ ctx, data }) => { if (mergeDraft) { mergeDraft.method = data.value; ctx.render(); } },
  'w.github.merge-field': ({ el }) => { if (mergeDraft) mergeDraft[el.dataset.field] = el.value; },
  'w.github.merge-confirm': async ({ ctx, el }) => {
    if (!mergeDraft || mergeDraft.busy) return;
    const pr = findPullRequest(mergeDraft.prId);
    if (!pr) return;
    const form = new FormData(el);
    const method = chooseMergeMethod(pr.merge, mergeDraft.method);
    Object.assign(mergeDraft, { busy: true, error: '', title: String(form.get('title') ?? mergeDraft.title), message: String(form.get('message') ?? mergeDraft.message) });
    ctx.render();
    try {
      await gh.merge(pr, { method, title: method === 'rebase' ? '' : mergeDraft.title.trim(), message: method === 'rebase' ? '' : mergeDraft.message.trim() }, configOf(mergeDraft.widgetId));
      ctx.closeDialog('github.merge');
      mergeDraft = null;
      ctx.toast(`Merged #${pr.number} into ${pr.base}.`, { tone: 'success', action: { label: 'Open on GitHub', run: () => openUrl(pr.url) } });
    } catch (error) {
      if (mergeDraft) Object.assign(mergeDraft, { busy: false, error: error.message });
      ctx.render();
    }
  },
  'w.github.merge-auto': async ({ ctx }) => {
    const pr = mergeDraft && findPullRequest(mergeDraft.prId);
    if (!pr) return;
    const { widgetId, method } = mergeDraft;
    try {
      await toggleAutoMerge(ctx, pr, true, chooseMergeMethod(pr.merge, method), widgetId);
      ctx.closeDialog('github.merge');
    } catch (error) { mergeDraft.error = error.message; ctx.render(); }
  },
  'w.github.auto-merge': ({ ctx, el, data }) => {
    const pr = prFor(data);
    const method = viewOf(data.widget).method || data.method;
    return toggleAutoMerge(ctx, pr, !!el.checked, chooseMergeMethod(pr.merge, method), data.widget).catch(error => { el.checked = !el.checked; throw error; });
  },
  'w.github.approve': ({ ctx, data }) => approve(ctx, prFor(data), data.widget),
  'w.github.ready': ({ ctx, data }) => { const pr = prFor(data); return gh.ready(pr, configOf(data.widget)).then(() => ctx.toast(`#${pr.number} is ready for review.`)); },
  'w.github.update-branch': ({ ctx, data }) => { const pr = prFor(data); return gh.updateBranch(pr, configOf(data.widget)).then(() => ctx.toast(`Updating ${pr.head} with ${pr.base}.`)); },
  'w.github.rerun': ({ ctx, data }) => gh.rerun(data.repo, Number(data.run), configOf(data.widget)).then(() => ctx.toast('Re-running the failed jobs.')),
  'w.github.mark-read': ({ data }) => gh.markRead(data.id),
  'w.github.mark-all-read': ({ ctx, data }) => {
    const entry = datasetFor(configOf(data.widget));
    const ids = (entry?.snapshot?.notifications?.items || []).filter(n => n.unread).map(n => n.id);
    if (ids.length) return gh.markAllRead(ids).then(() => ctx.toast('All notifications marked as read.'));
  },
});

