// Browser automation settings and the rule that decides what the assistant may change on a page on its own. Pure and
// dependency-free: lib/ai/connections.js merges these into the AI settings (`browser`) and keeps them out of backups,
// the service worker (lib/browser/host.js) applies them, and Settings and the assistant show them.
//
// What the person decides, and no model call can change:
//   - Reading and moving never ask.
//   - A detected write (submit, send, delete, upload) asks in Ask mode and runs in Auto mode. A site set to Allow lets
//     writes run in both modes; a site set to Ask asks in both; a site set to Block is closed to the assistant.
//   - A payment, an access grant, typing a secret and answering a page's prompt dialog are the person's own steps in
//     every mode. The layer hands them over; these settings have no say in it.

export const BROWSER_MODES = Object.freeze(['ask', 'auto']);
export const SITE_RULES = Object.freeze(['allow', 'ask', 'block']);
export const BROWSER_LIMITS = Object.freeze({ minSteps: 10, maxSteps: 200, maxSites: 500, maxSiteLength: 253 + 6 });

export const BROWSER_DEFAULTS = Object.freeze({
  // Off until the person turns it on in Settings, which is also when Chrome is asked for the tab permissions.
  enabled: false,
  mode: 'ask',
  sites: Object.freeze({}),
  // The most model steps one request may take while it works in the browser.
  maxSteps: 60,
});

/** The optional Chrome permissions the layer needs besides `debugger` (which the manifest requires). */
export const BROWSER_PERMISSIONS = Object.freeze(['tabs', 'webNavigation']);

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * What a site is: the host of an address as the address bar shows it, lower case, without a trailing dot or a leading
 * `www.`, with the port when it is not the default. The same key as the browser control layer's siteOf, so a rule
 * saved here matches the site the layer names (tests compare the two).
 */
export function siteOf(address) {
  try {
    const url = new URL(String(address));
    if (!url.hostname) return '';
    let host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (host.startsWith('www.')) host = host.slice(4);
    return url.port ? `${host}:${url.port}` : host;
  } catch {
    return '';
  }
}

/** A site as a person may type it ("Example.com", "https://www.example.com/x", "localhost:3000"), as siteOf keys it. */
export function siteKey(entry) {
  const text = typeof entry === 'string' ? entry.trim() : '';
  if (!text) return '';
  return siteOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
}

function normalizeSites(value) {
  const sites = {};
  if (!isObject(value)) return sites;
  for (const [entry, rule] of Object.entries(value)) {
    if (Object.keys(sites).length >= BROWSER_LIMITS.maxSites) break;
    const site = siteKey(entry);
    if (!site || site.length > BROWSER_LIMITS.maxSiteLength || !SITE_RULES.includes(rule)) continue;
    sites[site] = rule;
  }
  return sites;
}

/** Coerces anything into complete, valid settings; unknown or invalid values fall back to the defaults. */
export function normalizeBrowserSettings(value) {
  const input = isObject(value) ? value : {};
  const steps = typeof input.maxSteps === 'string' && input.maxSteps.trim() ? Number(input.maxSteps) : input.maxSteps;
  return {
    enabled: input.enabled === true,
    mode: BROWSER_MODES.includes(input.mode) ? input.mode : BROWSER_DEFAULTS.mode,
    sites: normalizeSites(input.sites),
    maxSteps: Number.isFinite(steps) ? Math.min(BROWSER_LIMITS.maxSteps, Math.max(BROWSER_LIMITS.minSteps, Math.round(steps))) : BROWSER_DEFAULTS.maxSteps,
  };
}

/** True when `value` is already what normalizeBrowserSettings would return for it: nothing to clamp, drop or rename. */
export function isNormalBrowserSettings(value) {
  if (!isObject(value)) return false;
  const normal = normalizeBrowserSettings(value);
  if (Object.keys(value).some(key => !Object.hasOwn(normal, key)) || Object.keys(normal).some(key => !Object.hasOwn(value, key))) return false;
  if (!isObject(value.sites)) return false;
  const [given, kept] = [Object.entries(value.sites), Object.entries(normal.sites)];
  if (given.length !== kept.length || given.some(([site, rule]) => normal.sites[site] !== rule)) return false;
  return ['enabled', 'mode', 'maxSteps'].every(key => Object.is(value[key], normal[key]));
}

/** The sites the assistant may not use at all. */
export function blockedSites(settings) {
  return Object.entries(isObject(settings?.sites) ? settings.sites : {}).filter(([, rule]) => rule === 'block').map(([site]) => site);
}

/**
 * The answer to the layer for a write it classified as submit, delete or upload on `site`: run it, or ask the person.
 * `canRemember` says whether the card may offer "Always allow on this site" (not on a site set to Ask, and not on a
 * page without a host, which cannot hold a rule).
 */
export function decideWrite(settings, question) {
  const site = typeof question?.site === 'string' ? question.site : '';
  if (!site) return { decision: 'ask', canRemember: false };
  const stored = isObject(settings?.sites) ? settings.sites[site] : undefined;
  const rule = stored === 'allow' || stored === 'ask' ? stored : undefined;
  if (rule) return { decision: rule === 'allow' ? 'run' : 'ask', by: 'site-rule', canRemember: rule !== 'ask' };
  return { decision: settings?.mode === 'auto' ? 'run' : 'ask', by: 'auto', canRemember: true };
}

/** The settings with one site's rule set, or removed when `rule` is not a rule. Returns a new object. */
export function withSiteRule(settings, entry, rule) {
  const current = normalizeBrowserSettings(settings);
  const site = siteKey(entry);
  if (!site) return current;
  const sites = { ...current.sites };
  if (SITE_RULES.includes(rule)) sites[site] = rule;
  else delete sites[site];
  return normalizeBrowserSettings({ ...current, sites });
}
