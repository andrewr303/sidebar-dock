// Website widget: a live page, video, doc or map inside the dashboard. Share links of known services become their
// official players (embed/providers.js). The frame is drawn at any zoom, at a phone or desktop page width, or cropped
// to a region of the page, all without reloading it (an oversized iframe under a CSS transform, embed/model.js
// frameLayout). It reloads only when its address or security settings change, on Reload, or on auto-refresh.
// Sites that refuse to be framed can be allowed per widget: Still asks for access to that site and adds a session
// rule that removes its framing headers inside the dashboard only (embed/rules.js).
import { html, cx, safeHref } from '../html.js';
import { icon, registerIcons } from '../icons.js';
import { button, iconButton, input, select, segmented, switchToggle, field, siteIcon } from '../components.js';
import { registerActions, registerMount } from '../runtime.js';
import { defineWidget, getSettingsDraft } from '../dashboard/registry.js';
import { resizeTo } from '../dashboard/frame.js';
import { findWidget, updateWidgetConfig } from '../../lib/dashboard-store.js';
import { hasOrigins, requestOrigins, onPermissionsChanged } from '../../lib/permissions.js';
import { openLink, copyLink, tidyMenu } from './links/shared.js';
import { resolveEmbed, coerceUrl } from './embed/providers.js';
import {
  embedConfig, embedDefaults, frameLayout, stepZoom, sandboxFlags, FRAME_ALLOW, framingOrigins, framingHost, framingVerdict, viewportOf, viewportPatch,
  REFRESH_MINUTES, refreshLabel, ZOOM_MIN, ZOOM_MAX, OFFSET_MAX,
} from './embed/model.js';
import { watchFrameRules, scheduleFrameRules } from './embed/rules.js';

// Brand and tool glyphs (Lucide geometry, ISC License) not in the shared set.
registerIcons({
  youtube: '<path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17"/><path d="m10 15 5-3-5-3z"/>',
  figma: '<path d="M5 5.5A3.5 3.5 0 0 1 8.5 2H12v7H8.5A3.5 3.5 0 0 1 5 5.5z"/><path d="M12 2h3.5a3.5 3.5 0 1 1 0 7H12V2z"/><path d="M12 12.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 1 1-7 0z"/><path d="M5 19.5A3.5 3.5 0 0 1 8.5 16H12v3.5a3.5 3.5 0 1 1-7 0z"/><path d="M5 12.5A3.5 3.5 0 0 1 8.5 9H12v7H8.5A3.5 3.5 0 0 1 5 12.5z"/>',
  twitch: '<path d="M21 2H3v16h5v4l4-4h5l4-4V2zm-10 9V7m5 4V7"/>',
  codepen: '<polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/><line x1="12" x2="12" y1="22" y2="15.5"/><polyline points="22 8.5 12 15.5 2 8.5"/><polyline points="2 15.5 12 8.5 22 15.5"/><line x1="12" x2="12" y1="2" y2="8.5"/>',
  'move-horizontal': '<path d="m18 8 4 4-4 4"/><path d="M2 12h20"/><path d="m6 8-4 4 4 4"/>',
  'move-vertical': '<path d="M12 2v20"/><path d="m8 18 4 4 4-4"/><path d="m8 6 4-4 4 4"/>',
});

const TYPE = 'embed';
const URL_HINT = 'Enter a web address, like example.com or youtube.com/watch?v=…';
const MAYBE_BLOCKED_AFTER_LOAD = 2500;  // ms after load before offering help with a blank page
const MAYBE_BLOCKED_NO_LOAD = 8000;     // ms without any load event
const HINT_RECEDES_AFTER = 9000;        // ms the "Page not showing?" pill stays in view over a page that did load
const HINTS_KEY = 'still.embed.hints.v1';
const parent = () => globalThis.chrome?.runtime?.id || globalThis.location?.hostname || '';
const canFrameRules = () => !!globalThis.chrome?.declarativeNetRequest?.updateSessionRules;
const targetOf = url => resolveEmbed(url, { parent: parent() });
const hostLabel = target => (target ? target.sourceHost.replace(/^www\./, '') : '');

const controllers = new Map();  // widget id -> mounted frame controller
const setupErrors = new Map();  // widget id -> inline error of the empty-state address form

// "Page not showing?" hints the person closed, per widget and address (this device only).
function hintDismissed(widgetId, url) {
  try { return JSON.parse(globalThis.localStorage?.getItem(HINTS_KEY) || '{}')[widgetId] === url; } catch { return false; }
}
function dismissHint(widgetId, url) {
  try {
    const map = JSON.parse(globalThis.localStorage?.getItem(HINTS_KEY) || '{}');
    map[widgetId] = url;
    const keys = Object.keys(map);
    for (const key of keys.slice(0, Math.max(0, keys.length - 100))) delete map[key];
    globalThis.localStorage?.setItem(HINTS_KEY, JSON.stringify(map));
  } catch { /* storage unavailable: the hint just comes back next time */ }
}

/** The config the frame should draw: the stored one, with the open settings dialog's geometry previewed live. */
function liveConfig(widgetId) {
  const found = findWidget(widgetId);
  if (!found) return null;
  const config = embedConfig(found.widget.config);
  const holder = getSettingsDraft();
  if (holder?.widget?.id === widgetId) {
    const draft = embedConfig(holder.draft);
    for (const key of ['zoom', 'offsetX', 'offsetY', 'mobile', 'pageWidth', 'interactive']) config[key] = draft[key];
  }
  return config;
}

// ------------------------------------------------------------------ the mounted frame

class EmbedFrame {
  constructor(el, ctx) {
    this.el = el;
    this.ctx = ctx;
    this.widgetId = el.dataset.widget;
    this.signature = '';
    this.nonce = 0;
    this.token = 0;
    this.frame = null;
    this.loaded = false;
    this.notice = '';      // '' | 'maybe' | 'maybe-open' | 'blocked' | 'access' | 'player'
    this.quiet = false;    // the pill has receded: it shows on hover and focus only
    this.probe = '';       // '' | 'allowed' | 'blocked' (from the site's headers, when Still may read them)
    this.size = { w: el.clientWidth, h: el.clientHeight };
    this.geometry = '';
    this.layerMarkup = null;
    this.refreshEvery = 0;
    this.refreshDue = false;
    this.timers = { hint: 0, refresh: 0, quiet: 0 };
    el.innerHTML = '<div class="w-embed-viewport"></div><div class="w-embed-layer"></div>';
    this.viewport = el.firstElementChild;
    this.layer = el.lastElementChild;
    this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.measure()) : null;
    this.observer?.observe(el);
    this.onVisibility = () => { if (document.visibilityState === 'visible' && this.refreshDue) this.reload(); };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.update();
  }

  get editing() { return !!this.el.closest('.dashboard.is-editing'); }

  measure() {
    const size = { w: this.el.clientWidth, h: this.el.clientHeight };
    if (size.w === this.size.w && size.h === this.size.h) return;
    const wasSmall = this.tooSmall;
    this.size = size;
    if (this.tooSmallNow() !== wasSmall) this.update(); else this.applyLayout();
  }

  tooSmallNow() {
    const t = this.target;
    return !!(t?.minWidth && this.size.w > 0 && (this.size.w < t.minWidth || this.size.h < t.minHeight));
  }

  update() {
    const config = liveConfig(this.widgetId);
    const target = config && targetOf(config.url);
    if (!config || !target) return;
    this.config = config;
    this.target = target;
    this.tooSmall = this.tooSmallNow();
    this.el.classList.toggle('is-editing', this.editing);
    this.el.classList.toggle('is-static', !config.interactive);
    const signature = [target.embedUrl, config.sandbox, config.scrollLock, config.allowFraming, this.nonce].join('|');
    if (this.tooSmall) this.unload();
    else if (signature !== this.signature) this.load(signature);
    this.applyLayout();
    if (this.frame) this.frame.inert = !config.interactive || this.editing;
    this.syncRefresh(config.autoRefresh);
    this.paint();
  }

  unload() {
    if (!this.frame && !this.signature) return;
    this.token++;
    this.signature = '';
    this.frame = null;
    this.loaded = false;
    this.notice = '';
    clearTimeout(this.timers.hint);
    this.viewport.replaceChildren();
  }

  load(signature) {
    const { target, config } = this;
    const token = ++this.token;
    this.signature = signature;
    this.loaded = false;
    this.notice = '';
    this.quiet = false;
    this.probe = '';
    this.geometry = '';
    clearTimeout(this.timers.hint);
    clearTimeout(this.timers.quiet);
    this.viewport.replaceChildren();
    this.frame = null;
    const framing = config.allowFraming && !target.known;
    if (framing || target.referrer) {
      // Rules must be in place before the first request, or this load would still be refused.
      Promise.all([framing ? hasOrigins(framingOrigins(target.embedUrl)) : true, target.access.length ? hasOrigins(target.access) : true, scheduleFrameRules()])
        .then(([frameAccess, playerAccess]) => {
          if (token !== this.token) return;
          if (!playerAccess) { this.notice = 'player'; this.paint(); return; }
          if (!frameAccess) this.notice = 'access';
          this.createFrame(token);
        });
      this.paint();
      return;
    }
    this.createFrame(token);
    if (!target.known && !hintDismissed(this.widgetId, target.embedUrl)) this.probeHeaders(token);
  }

  createFrame(token) {
    const { target, config } = this;
    const frame = document.createElement('iframe');
    frame.className = 'w-embed-frame';
    frame.title = target.known ? `${target.label}: ${hostLabel(target)}` : hostLabel(target);
    frame.setAttribute('sandbox', sandboxFlags(config.sandbox));
    frame.setAttribute('allow', FRAME_ALLOW);
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    if (config.scrollLock) frame.setAttribute('scrolling', 'no');
    frame.addEventListener('load', () => this.onLoad(token));
    frame.src = target.embedUrl;
    this.viewport.replaceChildren(frame);
    this.frame = frame;
    this.applyLayout();
    if (!target.known && !config.allowFraming) {
      clearTimeout(this.timers.hint);
      this.timers.hint = setTimeout(() => this.offerHelp(token), MAYBE_BLOCKED_NO_LOAD);
    }
    this.paint();
  }

  onLoad(token) {
    if (token !== this.token) return;
    this.loaded = true;
    if (!this.target.known && !this.config.allowFraming) {
      clearTimeout(this.timers.hint);
      this.timers.hint = setTimeout(() => this.offerHelp(token), MAYBE_BLOCKED_AFTER_LOAD);
    }
    this.paint();
  }

  /** A blank frame cannot be told apart from a refused one across origins, so help is offered rather than asserted. */
  offerHelp(token) {
    if (token !== this.token || this.notice || this.probe === 'allowed' || hintDismissed(this.widgetId, this.target.embedUrl)) return;
    this.notice = 'maybe';
    this.quiet = false;
    this.paint();
    // Over a page that loaded (most likely fine), the offer steps back after a while instead of nagging.
    clearTimeout(this.timers.quiet);
    if (this.loaded) {
      this.timers.quiet = setTimeout(() => {
        if (token !== this.token || this.notice !== 'maybe') return;
        this.quiet = true;
        this.paint();
      }, HINT_RECEDES_AFTER);
    }
  }

  /** With host access already granted, the site's own headers say for sure whether it can be framed. */
  async probeHeaders(token) {
    const url = this.target.embedUrl;
    if (!globalThis.chrome?.runtime?.id || !(await hasOrigins([url]))) return;
    const abort = new AbortController();
    try {
      const response = await fetch(url, { credentials: 'include', redirect: 'follow', signal: abort.signal, cache: 'no-store' });
      abort.abort();
      if (token !== this.token) return;
      this.probe = framingVerdict(response.headers);
      if (this.probe === 'blocked') this.notice = 'blocked';
      else if (this.notice === 'maybe') this.notice = '';
      this.paint();
    } catch { /* unreachable or refused: keep the gentle hint */ }
  }

  applyLayout() {
    if (!this.frame || !this.size.w || !this.size.h) return;
    const g = frameLayout({ width: this.size.w, height: this.size.h, ...this.config });
    const key = `${g.width}|${g.height}|${g.scale}|${g.x}|${g.y}`;
    if (key === this.geometry) return;
    this.geometry = key;
    const style = this.frame.style;
    style.width = `${g.width}px`;
    style.height = `${g.height}px`;
    style.transform = g.scale === 1 && !g.x && !g.y ? '' : `translate(${g.x}px, ${g.y}px) scale(${g.scale})`;
  }

  syncRefresh(minutes) {
    if (minutes === this.refreshEvery) return;
    clearInterval(this.timers.refresh);
    this.refreshEvery = minutes;
    this.refreshDue = false;
    if (!minutes) return;
    this.timers.refresh = setInterval(() => {
      // Never yank a page out from under someone using it; catch up when the tab is visible again.
      if (document.visibilityState !== 'visible' || this.editing || document.activeElement === this.frame) { this.refreshDue = true; return; }
      this.reload();
    }, minutes * 60_000);
  }

  reload() {
    this.refreshDue = false;
    this.nonce++;
    this.update();
  }

  paint() {
    const markup = String(this.layerHtml());
    if (markup === this.layerMarkup) return;
    // Keep keyboard focus on a notice button that survives the repaint.
    const focusKey = this.layer.contains(document.activeElement) ? document.activeElement.dataset.focusKey : '';
    this.layerMarkup = markup;
    this.layer.innerHTML = markup;
    if (focusKey) this.layer.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }

  layerHtml() {
    const { target, config, widgetId } = this;
    if (!target) return '';
    const host = hostLabel(target);
    const open = html`<a class="btn btn-ghost btn-sm w-embed-open" href="${safeHref(target.url)}" target="_blank" rel="noopener" data-focus-key="embed-open-${widgetId}">
      ${icon('square-arrow-out-up-right', { size: 14 })}<span class="btn-label">Open in new tab</span></a>`;
    if (this.tooSmall) {
      return html`<div class="w-embed-poster">
        ${target.poster ? html`<img class="w-embed-poster-img" src="${target.poster}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
        <a class="w-embed-poster-play" href="${safeHref(target.url)}" target="_blank" rel="noopener" aria-label="Watch on ${target.label} (opens a new tab)">${icon('circle-play', { size: 28, strokeWidth: 1.5 })}</a>
        <p class="w-embed-poster-note">Make the widget larger to play here</p>
      </div>`;
    }
    if (this.notice === 'player') {
      return html`<div class="w-embed-player">
        ${target.poster ? html`<img class="w-embed-poster-img" src="${target.poster}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
        <div class="w-embed-player-card" role="status">
          <span class="w-embed-player-icon" aria-hidden="true">${icon(target.icon, { size: 20 })}</span>
          <p class="w-embed-blocked-title">Play ${target.label} videos here</p>
          <p class="w-embed-blocked-body">${target.label} only plays inside a page that says where it is shown. Allow Still to tell it, on ${target.host.replace(/^www\./, '')} only.</p>
          <div class="w-embed-actions">
            ${button({ label: `Allow on ${target.host.replace(/^www\./, '')}`, icon: 'lock-open', size: 'sm', action: 'w.embed.allow-player', data: { widget: widgetId, focusKey: `embed-player-${widgetId}` } })}
            <a class="btn btn-ghost btn-sm w-embed-open" href="${safeHref(target.url)}" target="_blank" rel="noopener" data-focus-key="embed-watch-${widgetId}">
              ${icon('square-arrow-out-up-right', { size: 14 })}<span class="btn-label">Watch on ${target.label}</span></a>
          </div>
        </div>
      </div>`;
    }
    if (this.notice === 'blocked') {
      return html`<div class="w-embed-blocked" role="status">
        <span class="w-embed-blocked-icon" aria-hidden="true">${icon('globe-lock', { size: 22 })}</span>
        <p class="w-embed-blocked-title">${host} doesn’t allow embedding</p>
        <p class="w-embed-blocked-body">Still can lift that protection on your dashboard only, so do it just for sites you trust.</p>
        <div class="w-embed-actions">
          ${canFrameRules() ? button({ label: 'Allow embedding', icon: 'lock-open', size: 'sm', action: 'w.embed.allow', data: { widget: widgetId, focusKey: `embed-allow-${widgetId}` } }) : ''}
          ${open}
        </div>
      </div>`;
    }
    const loading = this.frame && !this.loaded ? html`<div class="w-embed-loading" aria-hidden="true">${siteIcon(target.url, { size: 24 })}<span class="w-embed-loading-text">Loading ${host}…</span></div>` : '';
    let notice = '';
    if (this.notice === 'maybe') {
      notice = html`<button type="button" class="${cx('w-embed-pill', this.quiet && 'is-quiet')}" data-action="w.embed.hint-open" data-widget="${widgetId}" data-focus-key="embed-pill-${widgetId}" aria-expanded="false">
        ${icon('circle-help', { size: 14 })}<span>Page not showing?</span></button>`;
    } else if (this.notice === 'maybe-open') {
      notice = html`<div class="w-embed-bar" role="status" data-keydown="w.embed.bar-key" data-widget="${widgetId}">
        <p class="w-embed-bar-text">This site may refuse to be embedded. Still can allow it for your dashboard only.</p>
        <div class="w-embed-actions">
          ${canFrameRules() ? button({ label: 'Allow embedding', icon: 'lock-open', size: 'sm', action: 'w.embed.allow', data: { widget: widgetId, focusKey: `embed-allow-${widgetId}` } }) : ''}
          ${open}
        </div>
        ${iconButton({ icon: 'x', label: 'Dismiss', size: 'sm', action: 'w.embed.hint-dismiss', data: { widget: widgetId }, className: 'w-embed-bar-close' })}
      </div>`;
    } else if (this.notice === 'access') {
      notice = html`<div class="w-embed-bar" role="status">
        <p class="w-embed-bar-text">Allow access to ${host} so Still can show this site here.</p>
        <div class="w-embed-actions">${button({ label: `Allow access to ${host}`, icon: 'lock-open', size: 'sm', action: 'w.embed.allow-access', data: { widget: widgetId, focusKey: `embed-access-${widgetId}` } })}</div>
      </div>`;
    }
    const cover = !config.interactive ? html`<a class="w-embed-cover" href="${safeHref(target.url)}" target="_blank" rel="noopener" aria-label="Open ${host} in a new tab">
      <span class="w-embed-cover-chip">${icon('square-arrow-out-up-right', { size: 12 })}${host}</span></a>` : '';
    return html`${loading}${cover}${notice}`;
  }

  destroy() {
    this.token++;
    this.observer?.disconnect();
    clearTimeout(this.timers.hint);
    clearTimeout(this.timers.quiet);
    clearInterval(this.timers.refresh);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (controllers.get(this.widgetId) === this) controllers.delete(this.widgetId);
  }
}

registerMount('w.embed.frame', (el, ctx) => {
  const frame = new EmbedFrame(el, ctx);
  controllers.set(frame.widgetId, frame);
  return { update: () => frame.update(), destroy: () => frame.destroy() };
});

let watchingAccess = false;
function init() {
  watchFrameRules();
  if (watchingAccess) return;
  watchingAccess = true;
  // Access granted or removed elsewhere (another tab, Chrome's settings): reload frames waiting for it.
  onPermissionsChanged(() => {
    for (const frame of controllers.values()) if (['access', 'player'].includes(frame.notice) || frame.config?.allowFraming) frame.reload();
  });
}

// ------------------------------------------------------------------ rendering

function renderSetup(widget, env) {
  const error = setupErrors.get(widget.id) || (widget.config?.url ? 'That address can’t be shown here. Check it and try again.' : '');
  const id = `embed-url-${widget.id}`;
  return html`<div class="w-embed-setup" data-key="embed-setup-${widget.id}">
    <span class="w-embed-setup-icon" aria-hidden="true">${icon('app-window', { size: 20 })}</span>
    <p class="w-embed-setup-title">Embed a website</p>
    <p class="w-embed-setup-body">Paste a link to a page, video, doc or map. YouTube, Google Docs, Figma and others use their official player.</p>
    <form class="w-embed-setup-form" data-submit="w.embed.set-url" data-widget="${widget.id}" novalidate>
      <label class="sr-only" for="${id}">Website address</label>
      ${input({ id, name: 'url', value: widget.config?.url || '', placeholder: 'example.com', type: 'url', size: 'sm', invalid: !!error,
        describedBy: error ? `${id}-error` : '', attrs: { inputmode: 'url', enterkeyhint: 'go' } })}
      ${button({ label: 'Embed', size: 'sm', type: 'submit', variant: 'secondary' })}
    </form>
    ${error ? html`<p class="w-embed-setup-error" id="${id}-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${error}</span></p>` : ''}
    ${button({ label: 'Set up', icon: 'settings-2', size: 'sm', action: 'dashboard.widget-settings', data: { widget: widget.id }, className: 'w-embed-setup-short' })}
  </div>`;
}

function render(ctx, widget, env) {
  const config = embedConfig(widget.config);
  const target = targetOf(config.url);
  if (!target) return renderSetup(widget, env);
  // The mount comes first and the edit shield after it, so the frame's node never moves (a moved iframe reloads).
  return html`<div class="w-embed" data-key="embed-${widget.id}">
    <div class="w-embed-stage" data-mount="w.embed.frame" data-morph="skip" data-key="embed-stage-${widget.id}" data-widget="${widget.id}"></div>
    ${env.editing ? html`<div class="w-embed-shield" data-key="embed-shield" aria-hidden="true"></div>` : ''}
  </div>`;
}

function headerActions(_ctx, widget) {
  const config = embedConfig(widget.config);
  const target = targetOf(config.url);
  if (!target) return '';
  return html`<span class="w-embed-zoom" role="group" aria-label="Zoom">
      ${iconButton({ icon: 'zoom-out', label: 'Zoom out', size: 'sm', action: 'w.embed.zoom', data: { widget: widget.id, dir: -1 }, disabled: config.zoom <= ZOOM_MIN })}
      ${config.zoom !== 100 ? html`<button type="button" class="w-embed-zoom-value" data-action="w.embed.zoom" data-widget="${widget.id}" data-dir="0"
        aria-label="Reset zoom to 100% (now ${config.zoom}%)" data-tooltip="Reset zoom">${config.zoom}%</button>` : ''}
      ${iconButton({ icon: 'zoom-in', label: 'Zoom in', size: 'sm', action: 'w.embed.zoom', data: { widget: widget.id, dir: 1 }, disabled: config.zoom >= ZOOM_MAX })}
    </span>
    ${iconButton({ icon: 'refresh-cw', label: 'Reload page', size: 'sm', action: 'w.embed.reload', data: { widget: widget.id } })}
    <a class="icon-btn icon-btn-sm w-embed-head-open" href="${safeHref(target.url)}" target="_blank" rel="noopener" aria-label="Open ${hostLabel(target)} in a new tab"
      data-tooltip="Open in new tab">${icon('square-arrow-out-up-right', { size: 14 })}</a>`;
}

// ------------------------------------------------------------------ actions

const configOf = widgetId => {
  const found = findWidget(widgetId);
  return found ? embedConfig(found.widget.config) : null;
};

/** Grows or shrinks the widget's height so its body matches an aspect ratio ('16:9') at its current width. */
async function fitAspect(ctx, widgetId, aspect) {
  const found = findWidget(widgetId);
  const section = document.querySelector(`[data-widget-id="${CSS.escape(widgetId)}"]`);
  const body = section?.querySelector('.widget-body');
  if (!found || !body) return;
  const styles = getComputedStyle(section.closest('.dashboard') || section);
  const row = parseFloat(styles.getPropertyValue('--dash-row')) || 72;
  const gap = parseFloat(styles.getPropertyValue('--dash-gap')) || 16;
  const [aw, ah] = aspect.split(':').map(Number);
  const chrome = section.offsetHeight - body.offsetHeight;
  const wanted = (body.clientWidth * ah) / aw + chrome;
  await resizeTo(ctx, found.widget, { w: found.widget.w, h: Math.max(2, Math.round((wanted + gap) / (row + gap))) });
}

/** Turns on "allow embedding" for a widget's site. Call from a click: the access prompt needs the gesture. */
function allowEmbedding(ctx, widgetId) {
  const config = configOf(widgetId);
  const target = config && targetOf(config.url);
  if (!target) return undefined;
  const host = framingHost(target.embedUrl);
  const asked = requestOrigins(framingOrigins(target.embedUrl)); // during the gesture
  return asked.then(async granted => {
    if (!granted) { ctx.toast(`Chrome did not allow access to ${host}. Try again and choose Allow.`, { tone: 'danger' }); return; }
    await updateWidgetConfig(widgetId, { allowFraming: true });
    ctx.toast(`${host} can now be embedded on your dashboard`, { tone: 'success' });
  });
}

function menu(ctx, widget) {
  const config = embedConfig(widget.config);
  const target = targetOf(config.url);
  if (!target) return [{ label: 'Set the website…', icon: 'link', run: () => ctx.dispatch('dashboard.widget-settings', { data: { widget: widget.id } }) }];
  const set = patch => updateWidgetConfig(widget.id, patch);
  const viewport = viewportOf(config);
  return tidyMenu([
    { label: 'Reload page', icon: 'refresh-cw', run: () => controllers.get(widget.id)?.reload() },
    { label: 'Open in new tab', icon: 'square-arrow-out-up-right', run: () => openLink(ctx, target.url, 'new') },
    { label: 'Copy link', icon: 'copy', run: () => copyLink(ctx, target.url) },
    { separator: true },
    { label: 'Zoom in', icon: 'zoom-in', hint: `${config.zoom}%`, disabled: config.zoom >= ZOOM_MAX, run: () => set({ zoom: stepZoom(config.zoom, 1) }) },
    { label: 'Zoom out', icon: 'zoom-out', disabled: config.zoom <= ZOOM_MIN, run: () => set({ zoom: stepZoom(config.zoom, -1) }) },
    config.zoom !== 100 && { label: 'Reset zoom', icon: 'rotate-ccw', run: () => set({ zoom: 100 }) },
    { separator: true },
    { heading: 'Page width' },
    { label: 'Fit the widget', checked: viewport === 'fit', run: () => set(viewportPatch('fit')) },
    { label: 'Phone', checked: viewport === 'phone', run: () => set(viewportPatch('phone')) },
    { label: 'Desktop', checked: viewport === 'desktop', run: () => set(viewportPatch('desktop')) },
    { separator: true },
    target.aspect && { label: target.aspect === '9:16' ? 'Fit the video (portrait)' : 'Fit the video (16:9)', icon: 'scaling', run: () => fitAspect(ctx, widget.id, target.aspect) },
    viewport === 'phone' && !target.aspect && { label: 'Fit a phone screen', icon: 'smartphone', run: () => fitAspect(ctx, widget.id, '9:19') },
    !target.known && canFrameRules() && (config.allowFraming
      ? { label: 'Stop allowing embedding', icon: 'lock', run: () => set({ allowFraming: false }) }
      : { label: 'Allow embedding…', icon: 'lock-open', run: () => allowEmbedding(ctx, widget.id) }),
  ]);
}

registerActions({
  'w.embed.set-url': async ({ el, ctx, data }) => {
    const value = String(new FormData(el).get('url') || '').trim();
    const url = coerceUrl(value);
    if (!url) {
      setupErrors.set(data.widget, value ? URL_HINT : 'Enter the address of the page to show.');
      ctx.render();
      ctx.nextFrame(() => document.getElementById(`embed-url-${data.widget}`)?.focus());
      return;
    }
    setupErrors.delete(data.widget);
    await updateWidgetConfig(data.widget, { url: url.href });
  },
  'w.embed.reload': ({ data }) => controllers.get(data.widget)?.reload(),
  'w.embed.zoom': ({ data }) => {
    const config = configOf(data.widget);
    if (!config) return undefined;
    const dir = Number(data.dir);
    return updateWidgetConfig(data.widget, { zoom: dir ? stepZoom(config.zoom, dir) : 100 });
  },
  'w.embed.allow': ({ ctx, data }) => allowEmbedding(ctx, data.widget),
  'w.embed.allow-access': ({ ctx, data }) => {
    const config = configOf(data.widget);
    const target = config && targetOf(config.url);
    if (!target) return undefined;
    return requestOrigins(framingOrigins(target.embedUrl)).then(granted => {
      if (granted) controllers.get(data.widget)?.reload();
      else ctx.toast(`Chrome did not allow access to ${framingHost(target.embedUrl)}. Try again and choose Allow.`, { tone: 'danger' });
    });
  },
  'w.embed.allow-player': ({ ctx, data }) => {
    const config = configOf(data.widget);
    const target = config && targetOf(config.url);
    if (!target?.access.length) return undefined;
    return requestOrigins(target.access).then(granted => {
      if (granted) controllers.get(data.widget)?.reload();
      else ctx.toast(`Chrome did not allow access to ${target.host.replace(/^www\./, '')}. Try again and choose Allow.`, { tone: 'danger' });
    });
  },
  'w.embed.hint-open': ({ ctx, data }) => {
    const frame = controllers.get(data.widget);
    if (!frame) return;
    frame.notice = 'maybe-open';
    frame.paint();
    ctx.nextFrame(() => frame.layer.querySelector('.w-embed-bar .btn')?.focus({ preventScroll: true }));
  },
  'w.embed.hint-dismiss': ({ data }) => {
    const frame = controllers.get(data.widget);
    if (!frame) return;
    dismissHint(data.widget, frame.target.embedUrl);
    frame.notice = '';
    frame.paint();
    frame.el.closest('.widget')?.querySelector('.widget-menu-btn')?.focus({ preventScroll: true });
  },
  'w.embed.bar-key': ({ event, ctx, data }) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    ctx.dispatch('w.embed.hint-dismiss', { data });
  },

  // Settings dialog
  'w.embed.draft-url': ({ el }) => getSettingsDraft()?.set({ url: el.value, _framingError: '' }),
  'w.embed.draft-viewport': ({ data }) => getSettingsDraft()?.set(viewportPatch(data.value)),
  'w.embed.draft-reset': ({ data }) => getSettingsDraft()?.set(data.name === 'offset' ? { offsetX: 0, offsetY: 0 } : { zoom: 100 }),
  'w.embed.draft-framing': ({ el }) => {
    const holder = getSettingsDraft();
    if (!holder) return undefined;
    if (!el.checked) { holder.set({ allowFraming: false, _framingError: '' }); return undefined; }
    const target = targetOf(holder.draft.url);
    if (!target) { holder.set({ allowFraming: false, _framingError: 'Enter the page’s address first.' }); return undefined; }
    const host = framingHost(target.embedUrl);
    const asked = requestOrigins(framingOrigins(target.embedUrl)); // during the gesture
    holder.set({ allowFraming: true, _framingError: '' }, { render: false });
    return asked.then(granted => holder.set(granted ? { _framingFor: host }
      : { allowFraming: false, _framingError: `Chrome did not allow access to ${host}. Try again and choose Allow.` }));
  },
});

// ------------------------------------------------------------------ settings

const VIEWPORT_OPTIONS = [
  { value: 'fit', label: 'Fit widget', icon: 'scaling' },
  { value: 'phone', label: 'Phone', icon: 'smartphone' },
  { value: 'desktop', label: 'Desktop', icon: 'monitor' },
];
const SANDBOX_OPTIONS = [{ value: 'relaxed', label: 'Standard' }, { value: 'strict', label: 'Strict' }];

/** A labelled slider; every row keeps a column for its Reset button so the sliders line up. */
function rangeRow({ id, name, label, value, min, max, step, unit, icon: glyph, valueText, reset = '' }) {
  return html`<div class="w-embed-range">
    <label class="w-embed-range-label" for="${id}">${glyph ? icon(glyph, { size: 14 }) : ''}<span>${label}</span></label>
    <input type="range" class="dash-range w-embed-range-input" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}"
      data-input="dashboard.draft" data-name="${name}" data-type="number" data-render="true" aria-valuetext="${valueText || `${value}${unit}`}">
    <output class="w-embed-range-value" for="${id}">${value}${unit}</output>
    <span class="w-embed-range-reset">${reset}</span>
  </div>`;
}

function providerPreview(target, raw) {
  if (!String(raw || '').trim()) return html`<p class="w-embed-detect is-empty">${icon('info', { size: 14 })}<span>Links to YouTube, Vimeo, Spotify, Loom, Figma, Google Docs, Sheets, Slides, Calendar and Maps become their official players.</span></p>`;
  if (!target) return '';
  return html`<div class="w-embed-detect" role="status">
    <span class="w-embed-detect-icon" aria-hidden="true">${target.known ? icon(target.icon, { size: 16 }) : siteIcon(target.url, { size: 16 })}</span>
    <span class="w-embed-detect-text">
      <span class="w-embed-detect-title">${target.known ? `${target.label} player` : hostLabel(target)}</span>
      <span class="w-embed-detect-meta">${target.known ? `Embeds ${target.host}` : 'Embeds the page as it is'}${target.upgraded ? ' over https (Chrome blocks http pages here)' : ''}</span>
    </span>
  </div>`;
}

function renderSettings(_ctx, widget, draft, env) {
  const d = embedConfig(draft);
  const raw = draft.url ?? '';
  const target = targetOf(raw);
  const urlError = env.errors?.url;
  const id = `wset-embed-${widget.id}`;
  const viewport = viewportOf(d);
  const framingError = draft._framingError || '';
  return html`<div class="w-embed-settings" data-key="embed-settings-${widget.id}">
    ${field({ label: 'Website address', id: `${id}-url`, error: urlError, control: html`${input({ id: `${id}-url`, value: raw, type: 'url', placeholder: 'example.com',
      action: 'w.embed.draft-url', invalid: !!urlError, describedBy: urlError ? `${id}-url-error` : '', attrs: { inputmode: 'url' } })}
      ${providerPreview(target, raw)}` })}

    <fieldset class="w-embed-group">
      <legend class="w-embed-group-title">Display</legend>
      ${field({ label: 'Page width', control: segmented({ name: 'viewport', value: viewport, options: VIEWPORT_OPTIONS, action: 'w.embed.draft-viewport', ariaLabel: 'Page width' }),
        hint: viewport === 'phone' ? 'Lays the page out like a phone, 390 pixels wide, scaled to the widget.' : viewport === 'desktop'
          ? 'Lays the page out like a laptop, 1280 pixels wide, scaled to the widget.' : 'Lays the page out at the widget’s own width.' })}
      ${rangeRow({ id: `${id}-zoom`, name: 'zoom', label: 'Zoom', value: d.zoom, min: ZOOM_MIN, max: ZOOM_MAX, step: 5, unit: '%', icon: 'zoom-in',
        reset: d.zoom !== 100 ? button({ label: 'Reset', size: 'sm', variant: 'ghost', action: 'w.embed.draft-reset', data: { name: 'zoom' }, attrs: { 'aria-label': 'Reset zoom to 100%' } }) : '' })}
      <div class="w-embed-region" role="group" aria-labelledby="${id}-region">
        <div class="w-embed-region-head">
          <span class="w-embed-region-title" id="${id}-region">Frame a region</span>
          ${d.offsetX || d.offsetY ? button({ label: 'Reset', size: 'sm', variant: 'ghost', action: 'w.embed.draft-reset', data: { name: 'offset' } }) : ''}
        </div>
        <p class="w-embed-hint">Skip part of the page to show only what matters, like a chart or a table. Changes preview in the widget behind this dialog.</p>
        ${rangeRow({ id: `${id}-x`, name: 'offsetX', label: 'From the left', value: d.offsetX, min: 0, max: OFFSET_MAX, step: 10, unit: ' px', icon: 'move-horizontal' })}
        ${rangeRow({ id: `${id}-y`, name: 'offsetY', label: 'From the top', value: d.offsetY, min: 0, max: OFFSET_MAX, step: 10, unit: ' px', icon: 'move-vertical' })}
      </div>
    </fieldset>

    <fieldset class="w-embed-group">
      <legend class="w-embed-group-title">Behavior</legend>
      <div class="w-embed-switches">
        ${switchToggle({ checked: d.interactive, label: 'Let me click and scroll inside the page', description: 'When off, the page is a live preview and a click opens it in a new tab.',
          action: 'dashboard.draft', data: { name: 'interactive', type: 'boolean' } })}
        ${switchToggle({ checked: d.scrollLock, label: 'Lock scrolling', description: 'Keeps the page still at the framed region.', action: 'dashboard.draft', data: { name: 'scrollLock', type: 'boolean' } })}
      </div>
      ${field({ label: 'Refresh automatically', id: `${id}-refresh`, hint: 'Only while this tab is visible, and never while you are using the page.',
        control: select({ id: `${id}-refresh`, name: 'autoRefresh', value: String(d.autoRefresh), action: 'dashboard.draft', className: 'is-block',
          options: REFRESH_MINUTES.map(minutes => ({ value: String(minutes), label: refreshLabel(minutes) })) }) })}
    </fieldset>

    <fieldset class="w-embed-group">
      <legend class="w-embed-group-title">Security</legend>
      ${field({ label: 'Page permissions', control: segmented({ name: 'sandbox', value: d.sandbox, options: SANDBOX_OPTIONS, action: 'dashboard.draft-set', ariaLabel: 'Page permissions' }),
        hint: d.sandbox === 'strict' ? 'The page can’t open pop-ups, downloads or dialogs.' : 'The page can open links in new tabs, play full screen and download files.' })}
      ${target && !target.known ? html`<div class="w-embed-framing">
        ${switchToggle({ checked: d.allowFraming, label: `Allow ${hostLabel(target)} to be embedded`, disabled: !canFrameRules(),
          description: canFrameRules() ? 'Still lifts this site’s protection against being shown inside other pages, on your dashboard only, so turn it on just for sites you trust.'
            : 'Needs Still installed as a Chrome extension.', action: 'w.embed.draft-framing', id: `${id}-framing` })}
        ${framingError ? html`<p class="field-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${framingError}</span></p>` : ''}
      </div>` : ''}
    </fieldset>
  </div>`;
}

function validateSettings(draft) {
  const value = String(draft?.url || '').trim();
  return value && !targetOf(value) ? { url: URL_HINT } : null;
}

function onSettingsSave(_ctx, widget, draft) {
  const next = embedConfig(draft);
  const url = coerceUrl(next.url);
  next.url = url ? url.href : '';
  // Access was granted for the old site: a different site needs its own grant.
  const before = framingHost(targetOf(widget.config?.url)?.embedUrl || '');
  const after = framingHost(targetOf(next.url)?.embedUrl || '');
  if (next.allowFraming && before !== after && draft._framingFor !== after) next.allowFraming = false;
  // Official players allow framing already.
  const target = targetOf(next.url);
  if (!target || target.known) next.allowFraming = false;
  return next;
}

defineWidget({
  type: TYPE,
  title: 'Website',
  description: 'Any page, video, doc or map, live. Zoom, frame a region or show the phone layout.',
  icon: 'app-window',
  category: 'web',
  keywords: ['iframe', 'embed', 'web', 'page', 'site', 'video', 'youtube', 'docs', 'sheets', 'figma', 'map', 'dashboard', 'grafana'],
  size: { w: 4, h: 4, minW: 2, minH: 2, maxW: 12, maxH: 16 },
  presets: { S: { w: 3, h: 3 }, M: { w: 4, h: 4 }, L: { w: 6, h: 5 }, XL: { w: 8, h: 8 } },
  permissions: { origins: ['<all_urls>'] },
  displayTitle: (_ctx, widget) => {
    const target = targetOf(widget.config?.url);
    return target ? (target.known ? target.label : hostLabel(target)) : '';
  },
  defaults: embedDefaults,
  needsSetup: config => !targetOf(config?.url),
  init,
  render,
  headerActions,
  menu,
  renderSettings,
  validateSettings,
  onSettingsSave,
  settingsSize: 'md',
});
