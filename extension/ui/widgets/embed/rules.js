// Website widget: keeps Chrome's declarativeNetRequest session rules in step with the dashboard. Every website widget
// with "Allow this site to be embedded" on gets one rule (embed/model.js frameRule) that removes the site's framing
// headers for frames this extension loads; widgets that are removed, switched off or pointed elsewhere lose theirs.
// While a YouTube player is on the dashboard, one shared rule (referrerRule) names Still as the embedding page.
// Session rules end with the browser session, so each dashboard re-applies them when it opens. Rules only take
// effect on sites the person granted host access to (declarativeNetRequestWithHostAccess).
import { getDashboard, subscribeDashboard } from '../../../lib/dashboard-store.js';
import { frameRule, referrerRule, planFrameRules, embedConfig } from './model.js';
import { resolveEmbed } from './providers.js';

const dnr = () => globalThis.chrome?.declarativeNetRequest?.updateSessionRules ? globalThis.chrome.declarativeNetRequest : null;
const extensionId = () => globalThis.chrome?.runtime?.id || '';

/**
 * The rules the dashboard wants now: one per website widget (on any board) that allows framing, plus the shared
 * player rule while any widget shows a player that needs a Referer (YouTube).
 */
export function wantedRules(dashboard = getDashboard()) {
  const rules = [];
  let players = false;
  for (const board of dashboard?.boards || []) {
    for (const widget of board.widgets || []) {
      if (widget.type !== 'embed') continue;
      const config = embedConfig(widget.config);
      const target = resolveEmbed(config.url, { parent: extensionId() });
      if (!target) continue;
      if (target.referrer) players = true;
      if (!config.allowFraming || target.known) continue;
      const rule = frameRule({ widgetId: widget.id, url: target.embedUrl, extensionId: extensionId() });
      if (rule) rules.push(rule);
    }
  }
  if (players) rules.unshift(referrerRule({ extensionId: extensionId() }));
  return rules.filter(Boolean);
}

let queue = Promise.resolve();
let timer = 0;
let waiters = [];

async function apply() {
  const api = dnr();
  if (!api || !getDashboard()) return;
  const plan = planFrameRules(await api.getSessionRules(), wantedRules());
  if (!plan.removeRuleIds.length && !plan.addRules.length) return;
  // Removing an id before adding it again makes the update safe when another tab applied the same rule meanwhile.
  await api.updateSessionRules({ removeRuleIds: [...new Set([...plan.removeRuleIds, ...plan.addRules.map(rule => rule.id)])], addRules: plan.addRules });
}

/** Brings the session rules in line with the dashboard. Resolves when they are applied (never rejects). */
export function syncFrameRules() {
  clearTimeout(timer);
  timer = 0;
  const settle = waiters;
  waiters = [];
  queue = queue.then(apply).catch(error => console.warn('[still] website embedding rules not applied', error));
  return queue.then(() => { for (const resolve of settle) resolve(); });
}

/** Debounced syncFrameRules for bursts of dashboard changes; resolves after the sync that follows. */
export function scheduleFrameRules() {
  if (!dnr()) return Promise.resolve();
  clearTimeout(timer);
  timer = setTimeout(syncFrameRules, 60);
  return new Promise(resolve => waiters.push(resolve));
}

let watching = false;
/** Starts following the dashboard (once per page) and applies the rules now. */
export function watchFrameRules() {
  if (watching || !dnr()) return;
  watching = true;
  subscribeDashboard(() => { scheduleFrameRules(); });
  syncFrameRules();
}
