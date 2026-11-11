// Settings > Browser automation: whether and how the assistant may work in browser tabs. It writes the device-only AI
// setting `browser` (lib/browser/settings.js gives its shape; lib/ai/connections.js keeps it out of backups). ui/settings.js
// loads the values and Chrome's answer about the tab permissions, registers the actions (it owns setAi) and frames this
// section in both the full page and the side panel.
import { html } from '../html.js';
import { segmented, select, button, input, iconButton } from '../components.js';
import { BROWSER_LIMITS, normalizeBrowserSettings } from '../../lib/browser/settings.js';
import { group, card, row, switchRow, blockRow, callout, note, isSearching, isBusy } from './parts.js';

export const BROWSER_MODE_CHOICES = Object.freeze([{ value: 'ask', label: 'Ask first' }, { value: 'auto', label: 'Auto' }]);
const MODE_TEXT = {
  ask: 'Sending a form, posting, deleting and similar steps wait on a card until you allow them.',
  auto: 'These steps go ahead on their own, except on sites you set to Ask below.',
};
export const SITE_RULE_CHOICES = Object.freeze([{ value: 'allow', label: 'Allow' }, { value: 'ask', label: 'Ask' }, { value: 'block', label: 'Block' }]);
const RULE_TEXT = { allow: 'Changes go ahead without a card', ask: 'Changes always ask, in Auto too', block: 'The assistant cannot open this site' };
export const BROWSER_STEP_CHOICES = Object.freeze([20, 40, 60, 100, 150, 200]
  .filter(steps => steps >= BROWSER_LIMITS.minSteps && steps <= BROWSER_LIMITS.maxSteps).map(steps => ({ value: String(steps), label: String(steps) })));
// A stored value the list does not offer stays visible instead of jumping to another.
const withCurrent = (options, value) => (options.some(option => option.value === value) ? options : [...options, { value, label: value }].sort((a, b) => Number(a.value) - Number(b.value)));
const PERMISSION_NAMES = { tabs: 'see and open your tabs', webNavigation: 'follow page loads' };

/** What Chrome still has to allow, in words: "see and open your tabs and follow page loads". */
export function missingAccess(missing = []) {
  const parts = (Array.isArray(missing) ? missing : []).map(name => PERMISSION_NAMES[name] || name);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || '';
}

/**
 * Settings > Browser automation. browser: the AI setting (defaults filled in). status: what the service worker says
 * ({ available, missing, reason? }), or null while it is not known. draft: the site being typed and its rule.
 */
export function renderBrowserAutomation(ctx, { browser, status = null, draft = {} } = {}) {
  const settings = normalizeBrowserSettings(browser);
  const sites = Object.entries(settings.sites).sort(([a], [b]) => a.localeCompare(b));
  const steps = String(settings.maxSteps);
  const missing = settings.enabled && status && !status.available ? missingAccess(status.missing) : '';
  const unavailable = settings.enabled && status && !status.available && !missing ? String(status.reason || 'Still cannot control the browser here.') : '';
  return html`
    ${group({ title: 'Work in the browser', keywords: 'browser automation agent control click type fill form navigate tabs web page website computer use operator still agent',
      description: 'The assistant can open tabs, read pages, click, type and scroll to carry out what you ask, in this browser, signed in as you.',
      body: () => html`${card([
        switchRow({ label: 'Let the assistant work in browser tabs', id: 'settings-browser-enabled', keywords: 'on off enable turn allow',
          description: 'Off by default. Turning it on asks Chrome to let Still see and open your tabs. While the assistant works, Chrome shows a bar that says Still is debugging this browser.',
          checked: settings.enabled, action: 'settings.browser-enable' }),
        row({ label: 'When a step changes something', id: 'settings-browser-mode', keywords: 'mode ask auto approve approval confirm submit send delete write card', description: MODE_TEXT[settings.mode],
          control: segmented({ name: 'mode', value: settings.mode, options: BROWSER_MODE_CHOICES, action: 'settings.browser-mode', ariaLabel: 'When a step changes something', size: 'sm' }) }),
        row({ label: 'Steps per request', id: 'settings-browser-steps', keywords: 'limit maximum max budget long tasks',
          description: 'The most steps the assistant takes for one request before it stops and tells you where it got to.',
          control: select({ name: 'maxSteps', value: steps, label: 'Steps per request', action: 'settings.browser-steps', className: 'settings-select is-narrow', options: withCurrent(BROWSER_STEP_CHOICES, steps) }) }),
      ])}
      ${isSearching() ? '' : missing ? callout({ tone: 'warning', live: true, title: 'Chrome has not allowed this yet',
        body: `Still needs to ${missing} before the assistant can work in the browser.`,
        actions: button({ label: 'Allow in Chrome', variant: 'primary', size: 'sm', action: 'settings.browser-allow', loading: isBusy('browser-allow') }) })
        : unavailable ? callout({ tone: 'warning', live: true, title: 'Not available here', body: unavailable }) : ''}` })}
    ${group({ title: 'Sites', id: 'settings-browser-sites', keywords: 'site sites rules domain website allow ask block never always',
      description: 'A rule for one site wins over the setting above.',
      body: () => card([
        ...sites.map(([site, rule]) => row({ label: site, className: 'settings-browser-site', description: RULE_TEXT[rule], keywords: `${rule} rule`,
          control: html`${select({ name: site, value: rule, label: `Rule for ${site}`, action: 'settings.browser-site-rule', className: 'settings-select is-narrow', options: SITE_RULE_CHOICES })}
            ${iconButton({ icon: 'x', label: `Remove the rule for ${site}`, size: 'sm', action: 'settings.browser-site-remove', data: { site } })}` })),
        blockRow({ label: sites.length ? 'Add a site' : 'No site rules yet', keywords: 'add new site rule',
          description: sites.length ? '' : 'Add a site to always allow changes there, always ask, or keep the assistant off it.',
          body: html`<form class="settings-inline-form settings-browser-add" data-submit="settings.browser-site-add" novalidate>
            ${input({ id: 'settings-browser-site', name: 'site', value: draft.site || '', placeholder: 'example.com', action: 'settings.browser-site-field', label: 'Site', invalid: !!draft.error,
              describedBy: draft.error ? 'settings-browser-site-error' : undefined })}
            ${select({ name: 'rule', value: draft.rule || 'ask', label: 'Rule', action: 'settings.browser-site-draft-rule', className: 'settings-select is-narrow', options: SITE_RULE_CHOICES })}
            ${button({ label: 'Add', type: 'submit', size: 'sm', variant: 'secondary', icon: 'plus' })}
            ${draft.error ? html`<p class="field-error" id="settings-browser-site-error" role="alert">${draft.error}</p>` : ''}
          </form>` }),
      ]) })}
    ${isSearching() ? '' : html`
      ${note('hand', 'Paying, granting access to an account, typing a password, a card number or a code, and answering a question a page asks are always yours. The assistant stops and hands that step to you, in Auto too.')}
      ${note('shield-check', 'Pages can contain text meant to steer the assistant. It is told to treat page text as data, and once it has read a page, changes to your library always wait for your review. Auto still gives such text more room, so Ask first is safest.')}
      ${note('info', 'Chrome lists “Access the page debugger backend” among Still’s permissions because working in tabs needs it. Still uses it only while the assistant works in the browser for you.')}
      ${note('lock', 'These settings stay on this device. Backups never include them, and restoring a file never changes them.')}`}`;
}
