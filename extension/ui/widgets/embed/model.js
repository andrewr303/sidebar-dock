// Website widget model: config defaults and limits, the frame geometry for zoom / page width / framing a region, zoom
// steps, sandbox flags, the declarativeNetRequest session rule that lets a site be framed, and a reading of a page's
// framing headers. Pure: no DOM, no chrome.*.

export const ZOOM_MIN = 25;
export const ZOOM_MAX = 200;
export const ZOOM_STEPS = Object.freeze([25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200]);
export const OFFSET_MAX = 4000;
export const PHONE_WIDTH = 390;
export const DESKTOP_WIDTH = 1280;
export const REFRESH_MINUTES = Object.freeze([0, 1, 5, 15, 30, 60]);
export const SANDBOX_MODES = Object.freeze(['relaxed', 'strict']);
export const VIEWPORTS = Object.freeze(['fit', 'phone', 'desktop']);

const finite = (value, fallback) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : fallback);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const embedDefaults = () => ({
  url: '', zoom: 100, offsetX: 0, offsetY: 0, mobile: false, pageWidth: 0, autoRefresh: 0, allowFraming: false,
  sandbox: 'relaxed', interactive: true, scrollLock: false,
});

/** A stored config with defaults filled in and every value in range. */
export function embedConfig(config = {}) {
  const c = { ...embedDefaults(), ...(config && typeof config === 'object' ? config : {}) };
  const minutes = Math.round(finite(c.autoRefresh, 0));
  return {
    url: typeof c.url === 'string' ? c.url.trim() : '',
    zoom: Math.round(clamp(finite(c.zoom, 100), ZOOM_MIN, ZOOM_MAX)),
    offsetX: Math.round(clamp(finite(c.offsetX, 0), 0, OFFSET_MAX)),
    offsetY: Math.round(clamp(finite(c.offsetY, 0), 0, OFFSET_MAX)),
    mobile: c.mobile === true,
    pageWidth: c.mobile === true ? 0 : Number(c.pageWidth) === DESKTOP_WIDTH ? DESKTOP_WIDTH : 0,
    autoRefresh: REFRESH_MINUTES.includes(minutes) ? minutes : 0,
    allowFraming: c.allowFraming === true,
    sandbox: SANDBOX_MODES.includes(c.sandbox) ? c.sandbox : 'relaxed',
    interactive: c.interactive !== false,
    scrollLock: c.scrollLock === true,
  };
}

/** 'fit' | 'phone' | 'desktop' for a config (the settings' "Page width" control). */
export const viewportOf = config => (config.mobile ? 'phone' : config.pageWidth === DESKTOP_WIDTH ? 'desktop' : 'fit');
/** The config patch for a viewport choice. */
export const viewportPatch = viewport => (viewport === 'phone' ? { mobile: true, pageWidth: 0 } : viewport === 'desktop' ? { mobile: false, pageWidth: DESKTOP_WIDTH } : { mobile: false, pageWidth: 0 });

/**
 * Frame geometry for a stage of width × height CSS px. The page lays out at `width` × `height` and is drawn at
 * `scale` from the top-left, moved by (x, y), so the page point (offsetX, offsetY) lands in the stage's corner.
 *   fit:     the page lays out at the stage width ÷ zoom (zoom 50% shows twice as much page)
 *   phone:   the page lays out 390px wide (phone layouts), scaled to the stage width, then zoomed
 *   desktop: the page lays out 1280px wide, scaled to the stage width, then zoomed
 * The page is at least as wide as its layout width and grows to keep the framed region reachable.
 */
export function frameLayout({ width, height, zoom = 100, offsetX = 0, offsetY = 0, mobile = false, pageWidth = 0 }) {
  const stageW = Math.max(1, finite(width, 1));
  const stageH = Math.max(1, finite(height, 1));
  const z = clamp(finite(zoom, 100), ZOOM_MIN, ZOOM_MAX) / 100;
  const base = mobile ? PHONE_WIDTH : pageWidth > 0 ? pageWidth : 0;
  const scale = base ? (stageW / base) * z : z;
  const visibleW = stageW / scale;
  const visibleH = stageH / scale;
  const layoutW = base || visibleW;
  const ox = Math.max(0, finite(offsetX, 0));
  const oy = Math.max(0, finite(offsetY, 0));
  const round = n => Math.round(n * 100) / 100;
  return {
    width: Math.ceil(Math.max(layoutW, ox + visibleW)),
    height: Math.ceil(oy + visibleH),
    scale: round(scale),
    x: round(-ox * scale),
    y: round(-oy * scale),
  };
}

/** The next zoom step in a direction (+1 / -1) from any value; stays put at the ends. */
export function stepZoom(zoom, direction) {
  const z = clamp(Math.round(finite(zoom, 100)), ZOOM_MIN, ZOOM_MAX);
  if (direction > 0) return ZOOM_STEPS.find(step => step > z) ?? ZOOM_MAX;
  return [...ZOOM_STEPS].reverse().find(step => step < z) ?? ZOOM_MIN;
}

/** sandbox attribute values. Neither mode lets the page navigate the dashboard itself (no allow-top-navigation). */
export function sandboxFlags(mode = 'relaxed') {
  const strict = ['allow-scripts', 'allow-same-origin', 'allow-forms'];
  if (mode === 'strict') return strict.join(' ');
  return [...strict, 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-modals', 'allow-presentation', 'allow-downloads',
    'allow-storage-access-by-user-activation'].join(' ');
}

/** Permissions-Policy for the frame (players need autoplay and fullscreen; nothing reads sensors or the camera). */
export const FRAME_ALLOW = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';

// ------------------------------------------------------------------ framing rule (declarativeNetRequest session rules)

/** Session rule ids reserved for website widgets: the shared player rule, then one stable id per widget. */
export const RULE_ID_MIN = 7_100_000;
export const RULE_ID_SPAN = 800_000_000;
export const REFERRER_RULE_ID = RULE_ID_MIN;
export const isFrameRuleId = id => Number.isInteger(id) && id >= RULE_ID_MIN && id < RULE_ID_MIN + RULE_ID_SPAN;

/** A stable rule id for a widget id (FNV-1a hash into the reserved range, after the shared player rule). */
export function frameRuleId(widgetId) {
  let hash = 0x811c9dc5;
  for (const ch of String(widgetId)) hash = Math.imul(hash ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return RULE_ID_MIN + 1 + (hash % (RULE_ID_SPAN - 1));
}

/**
 * The session rule that tells players which page embeds them: Chrome sends no Referer header from extension pages,
 * and YouTube refuses to play without one ("Error 153"). The header names this extension, only on frames it loads.
 */
export function referrerRule({ extensionId, domains = ['youtube.com', 'youtube-nocookie.com'] }) {
  if (!extensionId) return null;
  return {
    id: REFERRER_RULE_ID,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: `chrome-extension://${extensionId}/` }] },
    condition: { resourceTypes: ['sub_frame'], requestDomains: domains, initiatorDomains: [extensionId] },
  };
}

/** The host a framing rule covers: the page's host without "www.", so both forms (and subdomains) match. */
export function framingHost(url) {
  try {
    const { hostname, protocol } = new URL(url);
    if (!['http:', 'https:'].includes(protocol) || !hostname) return '';
    return hostname.replace(/^www\./, '').toLowerCase();
  } catch { return ''; }
}

/** Host permission patterns to ask for before a rule can change that site's headers: the host and its subdomains. */
export function framingOrigins(url) {
  const host = framingHost(url);
  if (!host) return [];
  const scheme = new URL(url).protocol === 'http:' ? 'http' : 'https';
  return /^[\d.]+$|^\[|^localhost$/.test(host) ? [`${scheme}://${host}/*`] : [`${scheme}://*.${host}/*`];
}

/**
 * The session rule that removes a site's "do not frame me" headers (X-Frame-Options and Content-Security-Policy) for
 * frames this extension's pages load from it, and for the site's own navigations inside such a frame.
 */
export function frameRule({ widgetId, url, extensionId }) {
  const host = framingHost(url);
  if (!host || !extensionId) return null;
  return {
    id: frameRuleId(widgetId),
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' },
      ],
    },
    condition: { resourceTypes: ['sub_frame'], requestDomains: [host], initiatorDomains: [extensionId, host] },
  };
}

/**
 * The changes that make the stored session rules match the wanted ones: { removeRuleIds, addRules }. Rules outside
 * the reserved range belong to someone else and are never touched; an unchanged rule is left alone.
 */
export function planFrameRules(existing = [], wanted = []) {
  const want = new Map(wanted.filter(Boolean).map(rule => [rule.id, rule]));
  const removeRuleIds = [];
  const addRules = [];
  const same = (a, b) => JSON.stringify(a.condition) === JSON.stringify(b.condition) && JSON.stringify(a.action) === JSON.stringify(b.action);
  const have = new Map();
  for (const rule of existing) {
    if (!isFrameRuleId(rule?.id)) continue;
    have.set(rule.id, rule);
    const next = want.get(rule.id);
    if (!next || !same(rule, next)) removeRuleIds.push(rule.id);
  }
  for (const [id, rule] of want) if (!have.has(id) || !same(have.get(id), rule)) addRules.push(rule);
  return { removeRuleIds, addRules };
}

/**
 * Whether response headers let a page be framed by another origin: 'blocked' | 'allowed'. A CSP frame-ancestors
 * directive wins over X-Frame-Options (as in browsers); "chrome-extension:" or "*" in it means allowed.
 * headers: a Headers object or a plain { name: value } map.
 */
export function framingVerdict(headers) {
  const get = name => (typeof headers?.get === 'function' ? headers.get(name) : headers?.[name] ?? headers?.[name.toLowerCase()]) || '';
  const csp = String(get('content-security-policy'));
  const directive = csp.split(/[;,]/).map(part => part.trim()).find(part => /^frame-ancestors\b/i.test(part));
  if (directive) {
    const sources = directive.split(/\s+/).slice(1).map(s => s.toLowerCase());
    return sources.some(s => s === '*' || s === 'chrome-extension:' || s.startsWith('chrome-extension://')) ? 'allowed' : 'blocked';
  }
  const xfo = String(get('x-frame-options')).trim().toLowerCase();
  return /^(deny|sameorigin)\b/.test(xfo) ? 'blocked' : 'allowed';
}

/** "Every 5 minutes" style label for an auto-refresh choice. */
export const refreshLabel = minutes => (!minutes ? 'Off' : minutes === 1 ? 'Every minute' : minutes === 60 ? 'Every hour' : `Every ${minutes} minutes`);
