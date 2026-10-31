// Product Hunt widget: the day's launches ranked by upvotes (with a developer token) or the latest launches from the public
// feed (no account needed). Small sizes show the top three with big rank numbers, medium and large a list, extra large
// cards. Each launch opens on Product Hunt (or its own site), saves to Still or hides. Data and the token live in
// ./product-hunt/session.js and ./product-hunt/account.js; pure logic in lib/producthunt.js.
import { html, cx, safeHref, plural } from '../html.js';
import { icon } from '../icons.js';
import { button, iconButton, emptyState, skeleton, relativeDate, segmented } from '../components.js';
import { registerActions, registerMount } from '../runtime.js';
import { defineWidget } from '../dashboard/registry.js';
import { findWidget, updateWidgetConfig } from '../../lib/dashboard-store.js';
import { requestOrigins } from '../../lib/permissions.js';
import {
  RANGES, SORTS, TOPICS, LAYOUTS, SOURCES, OPEN_TARGETS, REFRESH_OPTIONS, LIMITS, DEFAULT_CONFIG, FEED_ORIGIN, PH_SITE,
  rangeOf, sortOf, topicLabel, normalizeConfig, visiblePosts, layoutFor, leaderboardUrl, openUrl, hideId, thumbnailUrl,
} from '../../lib/producthunt.js';
import { session, bindCtx, ensureAccount, connected, checkAccess, feedFor, syncFeed, refreshMounted, findPost, mounted, rerender } from './product-hunt/session.js';
import { openConnect } from './product-hunt/account.js';
import { thumb, countText, brandMark } from './product-hunt/glyphs.js';

const roving = new Map();    // widget id -> post id that holds the list's tab stop
const announce = new Map();  // widget id -> polite status text after a manual refresh
const RANGE_SHORT = { today: 'Today', yesterday: 'Yesterday', week: 'Week', month: 'Month' };

const widgetOf = id => findWidget(id)?.widget || null;
const configOf = id => normalizeConfig(widgetOf(id)?.config);
const setConfig = (id, patch) => updateWidgetConfig(id, patch);
/** The widget an element belongs to (controls built by shared components carry no data-widget). */
const widgetIdOf = (el, data) => data?.widget || el?.closest?.('[data-widget-id]')?.dataset.widgetId || '';
/** The sort the list really uses: the feed has no votes or comments, so those fall back to its own order. */
const effectiveSort = feed => (feed.mode === 'feed' && !sortOf(feed.config.sort).feed ? 'ranking' : feed.config.sort);
const scopeLabel = feed => (feed.mode === 'api' ? rangeOf(feed.config.range).label : 'Latest launches');

function openExternal(url) {
  const href = safeHref(url);
  if (href !== '#') globalThis.open?.(href, '_blank', 'noopener,noreferrer');
}

// ------------------------------------------------------------------------------------------------ render

function render(ctx, widget, env) {
  bindCtx(ctx);
  ensureAccount();
  const config = normalizeConfig(widget.config);
  const layout = layoutFor(env, config);
  const wrap = content => html`<div class="w-ph" data-layout="${layout}" data-thumbs="${config.showThumbs ? 'on' : 'off'}">${content}
    <p class="sr-only" role="status">${announce.get(widget.id) || ''}</p></div>`;
  if (!session.loaded) return wrap(loadingState(layout, config));
  const feed = feedFor(config);
  const sync = html`<span class="w-ph-sync" data-mount="w.product-hunt.sync" data-morph="skip" data-key="ph-sync-${widget.id}" data-widget="${widget.id}" hidden></span>`;
  if (!feed.value) {
    if (feed.mode === 'feed' && session.access === false) return wrap(html`${sync}${accessState(layout)}`);
    if (feed.error && !feed.loading) return wrap(html`${sync}${errorState(widget, feed, layout)}`);
    return wrap(html`${sync}${loadingState(layout, config)}`);
  }
  const all = feed.value.posts || [];
  const posts = visiblePosts(all, { sort: effectiveSort(feed), hidden: config.hidden, limit: layout === 'top' ? 3 : config.limit });
  const hiddenHere = all.filter(post => config.hidden.includes(post.id)).length;
  const saved = post => !!ctx.select?.savedForUrl?.(post.url);
  const tabId = tabStop(widget.id, posts.map(post => post.id));
  const opts = { config, mode: feed.mode, tabId, saved };
  if (layout === 'top') {
    return wrap(html`${sync}${posts.length ? renderTop(widget, posts, opts) : emptyList(widget, feed, { compact: true, allHidden: all.length > 0 })}`);
  }
  const list = !posts.length ? emptyList(widget, feed, { allHidden: all.length > 0 })
    : layout === 'cards' ? renderCards(widget, posts, opts) : renderList(widget, posts, opts);
  return wrap(html`${sync}${toolbar(widget, feed)}${notice(widget, feed)}
    <div class="w-ph-scroll">${list}</div>
    ${footer(widget, feed, posts.length, hiddenHere)}`);
}

function loadingState(layout, config) {
  if (layout === 'top') {
    return html`<div class="w-ph-loading is-top" aria-busy="true">${[1, 2, 3].map(n => html`<div class="w-ph-bone-row"><span class="w-ph-top-rank is-bone">${n}</span>${skeleton({ rows: 1, variant: 'text' })}</div>`)}</div>`;
  }
  return html`<div class="w-ph-loading" aria-busy="true">
    <div class="w-ph-bone-bar"><span class="skeleton-bone"></span><span class="skeleton-bone"></span></div>
    ${Array.from({ length: 6 }, () => html`<div class="w-ph-bone-row">${config.showThumbs ? html`<span class="skeleton-bone w-ph-bone-thumb"></span>` : ''}${skeleton({ rows: 2, variant: 'text' })}</div>`)}
  </div>`;
}

function accessState(layout) {
  const allow = button({ label: 'Allow access to producthunt.com', variant: 'primary', size: 'sm', action: 'w.product-hunt.allow-access' });
  if (layout === 'top') {
    return html`<div class="w-ph-setup is-compact">${brandMark(28)}<p class="w-ph-setup-text">Allow access to load the latest launches.</p>
      ${button({ label: 'Allow access', variant: 'primary', size: 'sm', action: 'w.product-hunt.allow-access', attrs: { 'aria-label': 'Allow access to producthunt.com' } })}</div>`;
  }
  return html`<div class="w-ph-setup">${brandMark(36)}
    <p class="w-ph-setup-title">See the latest launches</p>
    <p class="w-ph-setup-text">Chrome needs your permission before Still can read the public Product Hunt feed. For daily rankings with upvotes and topics, connect a developer token instead.</p>
    <div class="w-ph-setup-actions">${allow}${button({ label: 'Connect a token', variant: 'ghost', size: 'sm', action: 'w.product-hunt.open-connect' })}</div>
  </div>`;
}

function errorState(widget, feed, layout) {
  const retry = button({ label: 'Try again', icon: 'refresh-cw', size: 'sm', variant: 'secondary', action: 'w.product-hunt.refresh', data: { widget: widget.id } });
  if (layout === 'top') return html`<div class="w-ph-setup is-compact" role="alert">${icon('triangle-alert', { size: 18, className: 'w-ph-setup-icon' })}<p class="w-ph-setup-text">${feed.error.message}</p>${retry}</div>`;
  const auth = feed.error.kind === 'auth';
  return emptyState({ icon: auth ? 'key-round' : 'triangle-alert', tone: 'danger', compact: true, className: 'w-ph-empty', title: auth ? 'Reconnect Product Hunt' : 'Unable to load Product Hunt',
    body: feed.error.message, actions: auth ? button({ label: 'Reconnect', size: 'sm', variant: 'secondary', action: 'w.product-hunt.open-connect' }) : retry });
}

function emptyList(widget, feed, { compact = false, allHidden = false } = {}) {
  const data = { widget: widget.id };
  const { config } = feed;
  if (allHidden) {
    return emptyState({ icon: 'eye-off', compact: true, className: 'w-ph-empty', title: 'You’ve hidden every launch here',
      body: compact ? '' : 'Hidden launches stay off this widget. Bring them back any time.',
      actions: button({ label: 'Show hidden launches', size: 'sm', variant: 'secondary', action: 'w.product-hunt.unhide-all', data }) });
  }
  if (feed.mode === 'feed') {
    return emptyState({ icon: 'rocket', compact: true, className: 'w-ph-empty', title: 'The feed is empty right now', body: compact ? '' : 'Product Hunt sent no launches. Try again in a few minutes.',
      actions: button({ label: 'Try again', size: 'sm', variant: 'secondary', action: 'w.product-hunt.refresh', data }) });
  }
  const range = rangeOf(config.range);
  const when = range.id === 'today' ? 'yet today' : range.label.toLowerCase();
  const title = config.topic ? `No ${topicLabel(config.topic)} launches ${when}` : `No launches ${when}`;
  const body = range.id === 'today' && !config.topic ? 'Product Hunt’s day starts at midnight Pacific time. Yesterday’s top launches are one click away.'
    : config.topic ? 'Try all topics or another day.' : config.featured ? 'Turn off “Featured launches only” to include every launch.' : 'Try another day.';
  const action = config.topic ? button({ label: 'Show all topics', size: 'sm', variant: 'secondary', action: 'w.product-hunt.set-topic', data: { ...data, topic: '' } })
    : range.id === 'today' ? button({ label: 'Show yesterday', size: 'sm', variant: 'secondary', action: 'w.product-hunt.set-range', data: { ...data, value: 'yesterday' } }) : '';
  return emptyState({ icon: 'calendar', compact: true, className: 'w-ph-empty', title, body: compact ? '' : body, actions: action });
}

/** What keeps fresh data from this widget, if anything: { kind, text, label, title, action }. */
function problem(feed) {
  if (connected() && session.authFailed && feed.config.source !== 'feed') {
    return { kind: 'auth', text: 'Product Hunt rejected your token, so this shows the public feed.', label: 'Reconnect', title: 'Reconnect Product Hunt', action: 'w.product-hunt.open-connect' };
  }
  if (feed.mode === 'feed' && session.access === false) {
    return { kind: 'access', text: 'Still can’t refresh this without access to producthunt.com.', label: 'Allow access', title: 'Allow access to producthunt.com', action: 'w.product-hunt.allow-access' };
  }
  if (feed.error && !feed.loading) return { kind: feed.error.kind, text: feed.error.message, label: 'Try again', title: 'Try loading Product Hunt again', action: 'w.product-hunt.refresh' };
  return null;
}

function notice(widget, feed) {
  const issue = problem(feed);
  if (!issue) return '';
  return html`<div class="w-ph-notice" role="${issue.kind === 'rate' ? 'status' : 'alert'}">${icon('triangle-alert', { size: 14 })}<span class="w-ph-notice-text" title="${issue.text}">${issue.text}</span>
    <button type="button" class="w-ph-notice-action" data-action="${issue.action}" data-widget="${widget.id}" aria-label="${issue.title}">${issue.label}</button></div>`;
}

function toolbar(widget, feed) {
  const { config, mode } = feed;
  const data = { widget: widget.id };
  const scope = mode === 'api'
    ? html`<div class="w-ph-ranges">
        ${segmented({ name: 'range', value: config.range, options: RANGES.map(r => ({ value: r.id, label: RANGE_SHORT[r.id] })), action: 'w.product-hunt.set-range', size: 'sm', ariaLabel: 'Launch day', className: 'w-ph-range-seg' })}
        ${button({ label: rangeOf(config.range).label, iconRight: 'chevron-down', variant: 'ghost', size: 'sm', action: 'w.product-hunt.range-menu', data, expanded: false, className: 'w-ph-range-btn',
          attrs: { 'aria-label': `Showing ${rangeOf(config.range).label.toLowerCase()}. Change launch day` } })}
      </div>`
    : html`<span class="w-ph-scope">${icon('rocket', { size: 14 })}<span>Latest launches</span></span>`;
  const topic = mode === 'api' && config.topic
    ? button({ label: topicLabel(config.topic), icon: 'tag', iconRight: 'chevron-down', variant: 'ghost', size: 'sm', action: 'w.product-hunt.topic-menu', data, expanded: false, className: 'w-ph-topic-btn',
      attrs: { 'aria-label': `Topic: ${topicLabel(config.topic)}. Change topic` } }) : '';
  const rankings = mode === 'feed' && !connected() && config.source !== 'feed'
    ? button({ label: 'Get rankings', icon: 'trophy', variant: 'ghost', size: 'sm', action: 'w.product-hunt.open-connect', className: 'w-ph-rankings-btn',
      attrs: { 'aria-label': 'Get daily rankings: connect a Product Hunt token' } }) : '';
  return html`<div class="w-ph-toolbar">${scope}<span class="w-ph-toolbar-end">${topic}${rankings}
    ${iconButton({ icon: 'list-filter', label: 'Sort and filter', action: 'w.product-hunt.options-menu', data, size: 'sm', expanded: false, className: 'w-ph-options-btn' })}</span></div>`;
}

function footer(widget, feed, shown, hiddenHere) {
  const when = feed.at ? relativeDate(new Date(feed.at).toISOString()) : '';
  const status = feed.loading ? 'Refreshing…' : when ? `Updated ${when === 'Just now' ? 'just now' : when}` : '';
  return html`<footer class="w-ph-foot">
    <span class="w-ph-foot-count">${shown ? plural(shown, 'launch', 'launches') : ''}${hiddenHere ? html`${shown ? ' · ' : ''}<button type="button" class="w-ph-foot-btn" data-action="w.product-hunt.unhide-all" data-widget="${widget.id}"
      aria-label="Show ${plural(hiddenHere, 'hidden launch', 'hidden launches')}">${hiddenHere.toLocaleString()} hidden</button>` : ''}</span>
    <span class="w-ph-foot-status">${status}</span>
  </footer>`;
}

// ------------------------------------------------------------------------------------------------ lists

/** The one row in a list that takes the tab stop: the last row focused with the arrows, else the first row. */
function tabStop(widgetId, ids) {
  const current = roving.get(widgetId);
  return current && ids.includes(current) ? current : ids[0];
}

const linkAttrs = (post, { config, tabId }) => html`href="${safeHref(openUrl(post, config.open))}" target="_blank" rel="noopener noreferrer" tabindex="${post.id === tabId ? '0' : '-1'}"
  aria-keyshortcuts="S H Shift+F10"`;

/** Screen-reader details that the visual row shows as numbers and icons. */
function srDetails(post) {
  const parts = [post.votes != null && plural(post.votes, 'upvote'), post.comments != null && plural(post.comments, 'comment')].filter(Boolean);
  return parts.length ? html`<span class="sr-only">, ${parts.join(', ')}</span>` : '';
}

function actions(widget, post, { saved, compact = false }) {
  const data = html`data-widget="${widget.id}" data-post="${post.id}"`;
  const isSaved = saved(post);
  return html`<span class="w-ph-actions">
    ${compact ? '' : html`<button type="button" class="${cx('w-ph-act', isSaved && 'is-saved')}" data-action="w.product-hunt.save" ${data} tabindex="-1"
      aria-label="${isSaved ? `Open ${post.name} in Still` : `Save ${post.name} to Still`}" data-tooltip="${isSaved ? 'Saved. Open in Still' : 'Save to Still'}">${icon(isSaved ? 'bookmark-check' : 'bookmark-plus', { size: 16 })}</button>
    <button type="button" class="w-ph-act" data-action="w.product-hunt.hide" ${data} tabindex="-1" aria-label="Hide ${post.name}" data-tooltip="Hide">${icon('eye-off', { size: 16 })}</button>`}
    <button type="button" class="w-ph-act w-ph-more" data-action="w.product-hunt.post-menu" ${data} tabindex="-1" aria-haspopup="menu" aria-expanded="false" aria-label="Actions for ${post.name}" data-tooltip="More">${icon('ellipsis', { size: 16 })}</button>
  </span>`;
}

const votes = post => (post.votes == null ? '' : html`<span class="w-ph-votes" aria-hidden="true">${icon('ph-upvote', { size: 12, strokeWidth: 2 })}<span class="w-ph-votes-n">${countText(post.votes)}</span></span>`);

function meta(post, { config, mode }) {
  const parts = [];
  if (mode === 'api' && config.showTopics && post.topics.length) parts.push(html`<span class="w-ph-topics">${post.topics.slice(0, 2).map(t => t.name).join(', ')}</span>`);
  if (post.comments) parts.push(html`<span class="w-ph-meta-item">${icon('message-circle', { size: 12 })}${countText(post.comments)}</span>`);
  const when = mode === 'api' ? relativeDate(post.featuredAt || post.createdAt) : '';
  if (when) parts.push(html`<span class="w-ph-meta-item w-ph-when">${when}</span>`);
  return parts.length ? html`<span class="w-ph-meta" aria-hidden="true">${parts}</span>` : '';
}

function renderList(widget, posts, opts) {
  const { config } = opts;
  return html`<ol class="w-ph-list" role="list" data-keydown="w.product-hunt.list-key" data-widget="${widget.id}">${posts.map(post => html`<li class="w-ph-row" data-key="ph-${post.id}" data-row="${post.id}">
    <span class="w-ph-rank" aria-hidden="true">${post.position}</span>
    ${config.showThumbs ? thumb(post, 40) : ''}
    <a class="w-ph-link" ${linkAttrs(post, opts)} title="${post.tagline ? `${post.name}: ${post.tagline}` : post.name}">
      <span class="sr-only">${post.position}. </span><span class="w-ph-name">${post.name}</span>
      ${config.showTaglines && post.tagline ? html`<span class="w-ph-tagline"><span class="sr-only">: </span>${post.tagline}</span>` : ''}
      ${meta(post, opts)}${srDetails(post)}
    </a>
    ${actions(widget, post, opts)}
    ${votes(post)}
  </li>`)}</ol>`;
}

function renderTop(widget, posts, opts) {
  const { config } = opts;
  return html`<ol class="w-ph-top" role="list" data-keydown="w.product-hunt.list-key" data-widget="${widget.id}">${posts.map(post => html`<li class="w-ph-row w-ph-top-item" data-key="ph-${post.id}" data-row="${post.id}">
    <span class="w-ph-top-rank" aria-hidden="true">${post.position}</span>
    ${config.showThumbs ? thumb(post, 28, { className: 'w-ph-top-thumb' }) : ''}
    <a class="w-ph-link" ${linkAttrs(post, opts)} title="${post.tagline ? `${post.name}: ${post.tagline}` : post.name}">
      <span class="sr-only">${post.position}. </span><span class="w-ph-name">${post.name}</span>
      ${config.showTaglines && post.tagline ? html`<span class="w-ph-tagline"><span class="sr-only">: </span>${post.tagline}</span>` : ''}${srDetails(post)}
    </a>
    ${post.votes != null ? html`<span class="w-ph-top-votes" aria-hidden="true">${icon('ph-upvote', { size: 10, strokeWidth: 2.25 })}${countText(post.votes)}</span>` : ''}
    ${actions(widget, post, { ...opts, compact: true })}
  </li>`)}</ol>`;
}

function renderCards(widget, posts, opts) {
  const { config, mode } = opts;
  return html`<ol class="w-ph-cards" role="list" data-keydown="w.product-hunt.list-key" data-widget="${widget.id}" data-layout="cards">${posts.map(post => html`<li class="w-ph-row w-ph-card" data-key="ph-${post.id}" data-row="${post.id}">
    <div class="w-ph-card-head">
      ${config.showThumbs ? thumb(post, 48) : ''}
      <span class="w-ph-card-rank" aria-hidden="true">${post.position}</span>
      ${votes(post)}
    </div>
    <a class="w-ph-link w-ph-card-link" ${linkAttrs(post, opts)} title="${post.name}"><span class="sr-only">${post.position}. </span><span class="w-ph-name">${post.name}</span>
      ${config.showTaglines && post.tagline ? html`<span class="w-ph-tagline"><span class="sr-only">: </span>${post.tagline}</span>` : ''}${srDetails(post)}</a>
    ${mode === 'api' && config.showTopics && post.topics.length ? html`<ul class="w-ph-chips" role="list" aria-label="Topics">${post.topics.map(t => html`<li class="w-ph-chip">${t.name}</li>`)}</ul>` : ''}
    <div class="w-ph-card-foot">${meta(post, { ...opts, config: { ...config, showTopics: false } })}${actions(widget, post, opts)}</div>
  </li>`)}</ol>`;
}

// ------------------------------------------------------------------------------------------------ menus and changes

function rangeMenu(ctx, anchor, widgetId) {
  const config = configOf(widgetId);
  ctx.openMenu(anchor, [{ heading: 'Launch day' }, ...RANGES.map(r => ({ label: r.label, checked: r.id === config.range, run: () => setConfig(widgetId, { range: r.id }) }))],
    { label: 'Choose the launch day', placement: 'bottom-start' });
}

function topicMenu(ctx, anchor, widgetId) {
  const config = configOf(widgetId);
  const custom = config.topic && !TOPICS.some(t => t.slug === config.topic) ? [{ slug: config.topic, label: topicLabel(config.topic) }] : [];
  ctx.openMenu(anchor, [
    { label: 'All topics', checked: !config.topic, run: () => setConfig(widgetId, { topic: '' }) },
    { separator: true },
    { heading: 'Topic' },
    ...[...custom, ...TOPICS].map(t => ({ label: t.label, checked: t.slug === config.topic, run: () => setConfig(widgetId, { topic: t.slug }) })),
  ], { label: 'Choose a topic', placement: 'bottom-end' });
}

function optionsMenu(ctx, anchor, widgetId) {
  const widget = widgetOf(widgetId);
  if (!widget) return;
  const feed = feedFor(widget.config);
  const { config, mode } = feed;
  const sort = effectiveSort(feed);
  const sorts = SORTS.filter(s => mode === 'api' || s.feed);
  ctx.openMenu(anchor, [
    { heading: 'Sort by' },
    ...sorts.map(s => ({ label: mode === 'api' ? s.label : s.feedLabel, checked: s.value === sort, run: () => setConfig(widgetId, { sort: s.value }) })),
    ...(mode === 'api' ? [
      { separator: true },
      { heading: 'Filter' },
      { label: 'Topic…', icon: 'tag', hint: config.topic ? topicLabel(config.topic) : 'All', keepFocus: true, run: () => anchor.isConnected && topicMenu(ctx, anchor, widgetId) },
      { label: 'Featured launches only', checked: config.featured, run: () => setConfig(widgetId, { featured: !config.featured }) },
    ] : []),
    { separator: true },
    { heading: 'Layout' },
    ...LAYOUTS.map(l => ({ label: l.label, checked: l.value === config.layout, run: () => setConfig(widgetId, { layout: l.value }) })),
  ], { label: 'Sort and filter launches', placement: 'bottom-end' });
}

function postMenu(ctx, anchor, widgetId, post) {
  const config = configOf(widgetId);
  const feed = feedFor(config);
  const saved = ctx.select?.savedForUrl?.(post.url);
  const collection = config.collectionId ? ctx.select?.collection?.(config.collectionId) : null;
  const row = anchor.closest('.w-ph-row');
  ctx.openMenu(anchor, [
    { label: 'Open on Product Hunt', icon: 'external-link', run: () => openExternal(post.url) },
    ...(post.website ? [{ label: 'Visit the product’s website', icon: 'globe', run: () => openExternal(post.website) }] : []),
    { separator: true },
    saved ? { label: 'Open in Still', icon: 'bookmark-check', shortcut: 's', run: () => ctx.openItem(saved.id) }
      : { label: `Save to ${collection?.name || 'Inbox'}`, icon: 'bookmark-plus', shortcut: 's', run: () => savePost(ctx, widgetId, post.id) },
    { label: 'Copy link', icon: 'link', run: () => copyLink(ctx, post) },
    ...(feed.mode === 'api' && post.topics.length ? [{ separator: true }, { heading: 'Show only' },
      ...post.topics.map(t => ({ label: t.name, icon: 'tag', run: () => setConfig(widgetId, { topic: t.slug }) }))] : []),
    { separator: true },
    { label: 'Hide', icon: 'eye-off', shortcut: 'h', run: () => hidePost(ctx, widgetId, post.id, row) },
  ], { label: `Actions for ${post.name}`, placement: 'bottom-end' });
}

async function copyLink(ctx, post) {
  try { await navigator.clipboard.writeText(post.url); ctx.toast('Copied the link'); } catch { ctx.toast('Unable to copy the link. Try again.', { tone: 'danger' }); }
}

async function savePost(ctx, widgetId, postId) {
  const post = findPost(widgetId, postId);
  if (!post) { ctx.toast('That launch is no longer in this widget. Refresh and try again.', { tone: 'danger' }); return; }
  const existing = ctx.select?.savedForUrl?.(post.url);
  if (existing) { ctx.openItem(existing.id); return; }
  const config = configOf(widgetId);
  const collection = config.collectionId ? ctx.select?.collection?.(config.collectionId) : null;
  const item = await ctx.store.saveItem({
    type: 'bookmark', url: post.url, title: post.name, excerpt: post.tagline, cover: thumbnailUrl(post.thumbnail, 320),
    collectionId: collection?.id || '', tags: ['product-hunt'],
  });
  ctx.toast(`Saved ${post.name} to ${collection?.name || 'your Inbox'}`, { tone: 'success', action: item?.id ? { label: 'Open', run: () => ctx.openItem(item.id) } : null });
}

/** After a row disappears (hidden), keep keyboard focus in the list on its neighbour instead of the page. */
function keepListFocus(ctx, row) {
  const list = row?.closest('[data-keydown="w.product-hunt.list-key"]');
  if (!list) return;
  const index = [...list.querySelectorAll('.w-ph-row')].indexOf(row);
  const hadFocus = row.contains(document.activeElement) || document.activeElement === document.body;
  ctx.nextFrame(() => {
    if (!hadFocus || !list.isConnected || (document.activeElement && document.activeElement !== document.body && !row.contains(document.activeElement))) return;
    const rows = [...list.querySelectorAll('.w-ph-row')].filter(el => el !== row && el.isConnected);
    const next = rows[Math.min(index, rows.length - 1)]?.querySelector('.w-ph-link');
    if (next) { for (const link of list.querySelectorAll('.w-ph-link')) link.tabIndex = -1; next.tabIndex = 0; next.focus(); }
  });
}

async function hidePost(ctx, widgetId, postId, row) {
  const post = findPost(widgetId, postId);
  const before = configOf(widgetId).hidden;
  keepListFocus(ctx, row);
  await setConfig(widgetId, { hidden: hideId(before, postId) });
  ctx.toast(`Hid ${post?.name || 'that launch'}`, { action: { label: 'Undo', run: () => setConfig(widgetId, { hidden: configOf(widgetId).hidden.filter(id => id !== postId) }) } });
}

async function unhideAll(ctx, widgetId) {
  const widget = widgetOf(widgetId);
  if (!widget) return;
  const before = configOf(widgetId).hidden;
  const here = new Set((feedFor(widget.config).value?.posts || []).map(post => post.id));
  const restored = before.filter(id => here.has(id));
  if (!restored.length) return;
  await setConfig(widgetId, { hidden: before.filter(id => !here.has(id)) });
  ctx.toast(`Showing ${plural(restored.length, 'hidden launch', 'hidden launches')} again`, { action: { label: 'Undo', run: () => setConfig(widgetId, { hidden: before }) } });
}

async function manualRefresh(ctx, widgetId) {
  const widget = widgetOf(widgetId);
  if (!widget) return;
  announce.set(widgetId, '');
  if (feedFor(widget.config).mode === 'feed') await checkAccess();
  await syncFeed(widget.config, { force: true, manual: true });
  const feed = feedFor(widget.config);
  const shown = feed.value ? visiblePosts(feed.value.posts, { sort: effectiveSort(feed), hidden: feed.config.hidden, limit: feed.config.limit }).length : 0;
  announce.set(widgetId, feed.error ? `Product Hunt did not refresh. ${feed.error.message}` : feed.value ? `Product Hunt refreshed. ${plural(shown, 'launch', 'launches')}.` : '');
  ctx.render();
}

// Roving focus inside a list: arrows move between rows (cards move by column too), Right/Left between the row's link and
// its action buttons, S saves, H hides, Shift+F10 or the menu key opens the row's actions.
function handleListKey({ event, el, ctx, data }) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const row = event.target.closest('.w-ph-row');
  if (!row || !el.contains(row)) return;
  const rows = [...el.querySelectorAll('.w-ph-row')];
  const index = rows.indexOf(row);
  const cards = el.dataset.layout === 'cards';
  const columns = cards ? Math.max(1, getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length) : 1;
  const focusRow = target => {
    const link = target?.querySelector('.w-ph-link');
    if (!link) return;
    for (const other of el.querySelectorAll('.w-ph-link')) other.tabIndex = -1;
    link.tabIndex = 0;
    link.focus();
    link.scrollIntoView({ block: 'nearest' });
    roving.set(data.widget, target.dataset.row);
  };
  const onLink = event.target.classList.contains('w-ph-link');
  const run = fn => { event.preventDefault(); fn(); };
  const rtl = getComputedStyle(el).direction === 'rtl';
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
  const back = rtl ? 'ArrowRight' : 'ArrowLeft';
  const key = event.key;
  if (key === 'ArrowDown') return run(() => focusRow(rows[Math.min(rows.length - 1, index + columns)]));
  if (key === 'ArrowUp') return run(() => focusRow(rows[Math.max(0, index - columns)]));
  if (key === 'Home') return run(() => focusRow(rows[0]));
  if (key === 'End') return run(() => focusRow(rows.at(-1)));
  if (key === forward || key === back) {
    const buttons = [...row.querySelectorAll('.w-ph-act')];
    const at = buttons.indexOf(event.target);
    if (at >= 0) return run(() => (key === forward ? buttons[Math.min(buttons.length - 1, at + 1)].focus() : at > 0 ? buttons[at - 1].focus() : focusRow(row)));
    // Cards move between cards sideways (their actions are on S, H and the menu); list rows step into their actions.
    if (onLink && cards) return run(() => focusRow(rows[Math.max(0, Math.min(rows.length - 1, index + (key === forward ? 1 : -1)))]));
    if (onLink && key === forward) return run(() => buttons[0]?.focus());
    return;
  }
  if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey)) return run(() => row.querySelector('.w-ph-more')?.click());
  if (event.shiftKey) return;
  const lower = key.toLowerCase();
  if (lower === 's') return run(() => ctx.run(() => savePost(ctx, data.widget, row.dataset.row)));
  if (lower === 'h') return run(() => ctx.run(() => hidePost(ctx, data.widget, row.dataset.row, row)));
}

registerActions({
  'w.product-hunt.refresh': ({ ctx, el, data }) => manualRefresh(ctx, widgetIdOf(el, data)),
  'w.product-hunt.set-range': ({ el, data }) => {
    const id = widgetIdOf(el, data);
    if (id && RANGES.some(r => r.id === data.value)) return setConfig(id, { range: data.value });
  },
  'w.product-hunt.set-topic': ({ el, data }) => { const id = widgetIdOf(el, data); if (id) return setConfig(id, { topic: data.topic || '' }); },
  'w.product-hunt.range-menu': ({ ctx, el, data }) => rangeMenu(ctx, el, widgetIdOf(el, data)),
  'w.product-hunt.topic-menu': ({ ctx, el, data }) => topicMenu(ctx, el, widgetIdOf(el, data)),
  'w.product-hunt.options-menu': ({ ctx, el, data }) => optionsMenu(ctx, el, widgetIdOf(el, data)),
  'w.product-hunt.post-menu': ({ ctx, el, data }) => { const post = findPost(data.widget, data.post); if (post) postMenu(ctx, el, data.widget, post); },
  'w.product-hunt.save': ({ ctx, data }) => savePost(ctx, data.widget, data.post),
  'w.product-hunt.hide': ({ ctx, el, data }) => hidePost(ctx, data.widget, data.post, el.closest('.w-ph-row')),
  'w.product-hunt.unhide-all': ({ ctx, el, data }) => unhideAll(ctx, widgetIdOf(el, data)),
  'w.product-hunt.list-key': handleListKey,
  // Chrome only shows the host-access prompt inside the user's gesture, so ask before the first await.
  'w.product-hunt.allow-access': ({ ctx }) => requestOrigins([FEED_ORIGIN]).then(async ok => {
    await checkAccess();
    if (!ok) ctx.toast('Chrome did not allow access to producthunt.com. Choose Allow to load the latest launches.', { tone: 'warning' });
    else refreshMounted({ force: false });
    rerender();
  }),
});

// Keeps a widget's list fresh while it is on screen: on mount, after every render (cheap when fresh), every minute
// (fetching only once the refresh interval has passed) and when the tab becomes visible again.
registerMount('w.product-hunt.sync', el => {
  const id = el.dataset.widget;
  const sync = () => { const widget = widgetOf(id); if (widget && !document.hidden) syncFeed(widget.config); };
  mounted.add(id);
  sync();
  const timer = setInterval(sync, 60000);
  document.addEventListener('visibilitychange', sync);
  return {
    update: sync,
    destroy() { clearInterval(timer); document.removeEventListener('visibilitychange', sync); mounted.delete(id); },
  };
});

// ------------------------------------------------------------------------------------------------ definition

defineWidget({
  type: 'product-hunt',
  title: 'Product Hunt',
  description: 'The day’s top launches with upvotes and topics, or the latest launches without an account. Save the good ones to Still.',
  icon: 'product-hunt',
  category: 'web',
  keywords: ['product hunt', 'launches', 'startups', 'products', 'tech', 'news', 'upvotes', 'ranking', 'leaderboard', 'ph'],
  size: { w: 4, h: 5, minW: 2, minH: 2, maxW: 12, maxH: 12 },
  presets: { S: { w: 3, h: 3 }, M: { w: 4, h: 5 }, L: { w: 6, h: 6 }, XL: { w: 9, h: 7 } },
  permissions: { origins: [FEED_ORIGIN] },
  preview: 'Top launches today',
  displayTitle(ctx, widget) {
    const config = normalizeConfig(widget.config);
    return config.topic ? `Product Hunt · ${topicLabel(config.topic)}` : 'Product Hunt';
  },
  defaults: () => ({ ...DEFAULT_CONFIG, hidden: [] }),
  init(ctx) { bindCtx(ctx); ensureAccount(); },
  render,
  headerActions(ctx, widget, env) {
    if (!session.loaded) return '';
    const config = normalizeConfig(widget.config);
    const feed = feedFor(config);
    const layout = layoutFor(env, config);
    const data = { widget: widget.id };
    const issue = layout === 'top' && feed.value ? problem(feed) : null;
    const canLoad = feed.mode === 'api' || session.access === true;
    const board = leaderboardUrl(feed.mode === 'api' ? config.range : 'latest');
    return html`${issue ? html`<span class="w-ph-alert" role="${issue.kind === 'rate' ? 'status' : 'alert'}">${iconButton({ icon: 'triangle-alert', label: `${issue.text} ${issue.title}`, action: issue.action, data, size: 'sm', className: 'w-ph-alert-btn' })}</span>` : ''}
      ${layout === 'top' && feed.mode === 'api' && env.w >= 3 ? button({ label: RANGE_SHORT[config.range], iconRight: 'chevron-down', variant: 'ghost', size: 'sm', action: 'w.product-hunt.range-menu', data, expanded: false,
        className: 'w-ph-head-range', attrs: { 'aria-label': `Showing ${rangeOf(config.range).label.toLowerCase()}. Change launch day` } }) : ''}
      ${env.w >= 3 ? html`<a class="icon-btn icon-btn-sm" href="${board}" target="_blank" rel="noopener noreferrer" aria-label="${feed.mode === 'api' ? 'Open this leaderboard on Product Hunt' : 'Open Product Hunt'}"
        data-tooltip="${feed.mode === 'api' ? 'Open leaderboard' : 'Open Product Hunt'}">${icon('external-link', { size: 14 })}</a>` : ''}
      ${canLoad ? iconButton({ icon: 'refresh-cw', label: feed.loading ? 'Refreshing' : 'Refresh', action: 'w.product-hunt.refresh', data, size: 'sm', className: cx('w-ph-refresh', feed.loading && 'is-spinning') }) : ''}`;
  },
  menu(ctx, widget) {
    const config = normalizeConfig(widget.config);
    const feed = feedFor(config);
    const hiddenHere = (feed.value?.posts || []).filter(post => config.hidden.includes(post.id)).length;
    return [
      { label: 'Refresh now', icon: 'refresh-cw', run: () => manualRefresh(ctx, widget.id) },
      { label: feed.mode === 'api' ? 'Open leaderboard' : 'Open Product Hunt', icon: 'external-link', run: () => openExternal(feed.mode === 'api' ? leaderboardUrl(config.range) : `${PH_SITE}/`) },
      ...(hiddenHere ? [{ label: `Show ${plural(hiddenHere, 'hidden launch', 'hidden launches')}`, icon: 'eye', run: () => unhideAll(ctx, widget.id) }] : []),
      connected() ? { label: 'Product Hunt account…', icon: 'key-round', run: () => ctx.navigate('settings:accounts') }
        : { label: 'Connect Product Hunt…', icon: 'plug', run: () => openConnect(ctx) },
    ];
  },
  fields(ctx, widget) {
    bindCtx(ctx);
    ensureAccount();
    const isConnected = connected();
    const api = draft => isConnected && draft.source !== 'feed';
    const feedOnly = draft => !api(draft);
    const current = normalizeConfig(widget?.config).topic;
    const topics = [{ value: '', label: 'All topics' }, ...(current && !TOPICS.some(t => t.slug === current) ? [{ value: current, label: topicLabel(current) }] : []),
      ...TOPICS.map(t => ({ value: t.slug, label: t.label }))];
    return [
      { name: 'source', label: 'Launches from', type: 'select', options: SOURCES.map(s => ({ value: s.value, label: s.label })),
        hint: isConnected ? 'Rankings use your Product Hunt token. The public feed needs no account and shows the latest launches.'
          : html`Rankings, upvotes and topics need a Product Hunt token. <button type="button" class="link-inline" data-action="w.product-hunt.open-connect">Connect Product Hunt</button>` },
      { name: 'range', label: 'Launch day', type: 'segmented', options: RANGES.map(r => ({ value: r.id, label: RANGE_SHORT[r.id] })), when: api,
        hint: 'Product Hunt’s day starts at midnight Pacific time. Weeks start on Monday.' },
      { name: 'sort', label: 'Sort by', type: 'select', options: SORTS.map(s => ({ value: s.value, label: s.label })), when: api },
      { name: 'sort', label: 'Sort by', type: 'select', options: SORTS.filter(s => s.feed).map(s => ({ value: s.value, label: s.feedLabel })), when: feedOnly },
      { name: 'topic', label: 'Topic', type: 'select', options: topics, when: api },
      { name: 'featured', label: 'Featured launches only', type: 'toggle', hint: 'Matches the Product Hunt home page. Turn off to include every launch.', when: api },
      { name: 'layout', label: 'Layout', type: 'segmented', options: LAYOUTS.map(l => ({ value: l.value, label: l.label })),
        hint: 'Automatic shows the top three on small widgets, a list on medium and large ones and cards on extra large ones.' },
      { name: 'limit', label: 'Launches to show', type: 'select', options: LIMITS.map(n => ({ value: String(n), label: String(n) })), hint: 'Small widgets always show the top three.' },
      { name: 'showThumbs', label: 'Show product images', type: 'toggle' },
      { name: 'showTaglines', label: 'Show taglines', type: 'toggle' },
      { name: 'showTopics', label: 'Show topics', type: 'toggle', when: api },
      { name: 'open', label: 'Open launches on', type: 'segmented', options: OPEN_TARGETS.map(o => ({ value: o.value, label: o.label })) },
      { name: 'collectionId', label: 'Save launches to', type: 'collection', hint: 'Where “Save to Still” puts a launch.' },
      { name: 'refresh', label: 'Refresh', type: 'select', options: REFRESH_OPTIONS.map(o => ({ value: String(o.value), label: o.label })) },
    // Widgets saved before a setting existed show its default instead of an empty control.
    ].map(f => ({ default: typeof DEFAULT_CONFIG[f.name] === 'number' ? String(DEFAULT_CONFIG[f.name]) : DEFAULT_CONFIG[f.name], ...f }));
  },
  onSettingsSave: (ctx, widget, draft) => ({ ...normalizeConfig(draft), hidden: normalizeConfig(widget.config).hidden }),
});
