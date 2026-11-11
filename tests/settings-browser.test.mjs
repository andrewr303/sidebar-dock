// Settings > Browser automation: the switch, the mode, the step limit, site rules, the Chrome permission notice and search.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFiltered, resetIds } from '../extension/ui/settings/parts.js';
import { searchTerms } from '../extension/ui/settings/catalog.js';
import { BROWSER_MODE_CHOICES, BROWSER_STEP_CHOICES, SITE_RULE_CHOICES, missingAccess, renderBrowserAutomation } from '../extension/ui/settings/browser.js';
import { BROWSER_LIMITS, normalizeBrowserSettings } from '../extension/lib/browser/settings.js';

const { renderSettingsPage, renderBrowserSettingsSection } = await import('../extension/ui/settings.js');

const flat = value => String(value).replace(/\s+/g, ' ');
const ctx = (extra = {}) => ({ library: { items: [], collections: [], settings: {} }, env: { isExtension: true }, state: { settings: { section: 'browser', list: false, query: '', open: new Set() } }, render() {}, ...extra });
const checked = (out, name) => [...out.matchAll(/<button type="button" role="radio" class="segmented-option" aria-checked="true"[^>]*data-value="([^"]*)"[^>]*data-name="([^"]*)"/g)]
  .filter(match => match[2] === name).map(match => match[1]);
const selected = (out, name) => new RegExp(`<select name="${name}"[^>]*>(.*?)</select>`).exec(out)?.[1].match(/<option value="([^"]*)" selected/)?.[1];
const render = (browser, extra = {}) => { resetIds(); return flat(renderBrowserAutomation(ctx(), { browser, ...extra })); };

test('by default browser automation is off, asks first and has no site rules', () => {
  const out = render(undefined);
  assert.match(out, /<input type="checkbox" role="switch" data-change="settings\.browser-enable"/, 'the switch is off');
  assert.ok(!/role="switch" checked/.test(out));
  assert.deepEqual(checked(out, 'mode'), ['ask']);
  assert.deepEqual(BROWSER_MODE_CHOICES.map(choice => choice.label), ['Ask first', 'Auto']);
  assert.match(out, /wait on a card until you allow them/);
  assert.equal(selected(out, 'maxSteps'), '60');
  assert.match(out, /No site rules yet/);
  assert.match(out, /data-submit="settings\.browser-site-add"/);
  assert.equal(selected(out, 'rule'), 'ask', 'a new rule starts as Ask');
  // What the person is told before turning it on.
  assert.match(out, /Off by default\. Turning it on asks Chrome to let Still see your tabs and work on the pages in them/);
  assert.deepEqual(checked(out, 'engine'), ['quiet']);
  assert.match(out, /Chrome shows nothing while it does/, 'the quiet engine is the default, and says what it is');
  assert.doesNotMatch(out, /Still started debugging this browser/);
  assert.match(render({ enabled: true, engine: 'precise' }), /Chrome shows a bar that says Still started debugging this browser/);
  assert.match(out, /Paying, granting access to an account, typing a password, a card number or a code, and answering a question a page asks are always yours/);
  assert.match(out, /once it has read a page, changes to your library always wait for your review/);
  assert.match(out, /Access the page debugger backend/);
  assert.match(out, /stay on this device\. Backups never include them/);
  assert.ok(!out.includes('settings-callout'), 'no permission notice while it is off');
});

test('the section shows the saved mode, step limit and each site with its rule', () => {
  const out = render({ enabled: true, mode: 'auto', maxSteps: 150, sites: { 'shop.example': 'allow', 'bank.example': 'ask', 'localhost:3000': 'block' } }, { status: { available: true, missing: [] } });
  assert.match(out, /role="switch" checked data-change="settings\.browser-enable"/);
  assert.deepEqual(checked(out, 'mode'), ['auto']);
  assert.match(out, /go ahead on their own, except on sites you set to Ask below/);
  assert.equal(selected(out, 'maxSteps'), '150');
  assert.deepEqual(SITE_RULE_CHOICES.map(choice => choice.value), ['allow', 'ask', 'block']);
  // Sites in alphabetical order, each with its own select (named by the site) and a remove button.
  assert.deepEqual([...out.matchAll(/<span class="settings-row-label">([^<]+)<\/span><span class="settings-row-desc">([^<]+)<\/span>/g)].map(match => match.slice(1, 3))
    .filter(([label]) => /example|localhost/.test(label)), [['bank.example', 'Changes always ask, in Auto too'], ['localhost:3000', 'The assistant cannot open this site'], ['shop.example', 'Changes go ahead without a card']]);
  assert.equal(selected(out, 'shop\\.example'), 'allow');
  assert.equal(selected(out, 'bank\\.example'), 'ask');
  assert.equal(selected(out, 'localhost:3000'), 'block');
  assert.equal(out.match(/data-action="settings\.browser-site-remove"/g).length, 3);
  assert.match(out, /aria-label="Remove the rule for shop\.example"[^>]*|data-site="shop\.example"/);
  assert.match(out, /Add a site/);
  assert.ok(!out.includes('settings-callout'), 'nothing is missing');
});

test('a step limit the list does not offer stays visible, and the offered limits are inside the allowed range', () => {
  assert.equal(selected(render({ enabled: true, maxSteps: 75 }), 'maxSteps'), '75');
  for (const choice of BROWSER_STEP_CHOICES) assert.ok(Number(choice.value) >= BROWSER_LIMITS.minSteps && Number(choice.value) <= BROWSER_LIMITS.maxSteps, choice.value);
  for (const choice of BROWSER_STEP_CHOICES) assert.equal(normalizeBrowserSettings({ maxSteps: Number(choice.value) }).maxSteps, Number(choice.value));
});

test('when Chrome has not allowed the tab permissions, the section says what is missing and offers to ask', () => {
  const out = render({ enabled: true }, { status: { available: false, missing: ['tabs', 'webNavigation'] } });
  assert.match(out, /settings-callout" data-tone="warning"/);
  assert.match(out, /Chrome has not allowed this yet/);
  assert.match(out, /Still needs to see and open your tabs and follow page loads before the assistant can work in the browser\./);
  assert.match(out, /data-action="settings\.browser-allow"/);
  assert.equal(missingAccess(['tabs']), 'see and open your tabs');
  assert.equal(missingAccess([]), '');
  // Off: the same answer from Chrome is no reason for a notice.
  assert.ok(!render({ enabled: false }, { status: { available: false, missing: ['tabs'] } }).includes('settings-callout'));
  // A build that cannot control the browser says so in the worker's words.
  const none = render({ enabled: true }, { status: { available: false, missing: [], reason: 'This build of Still cannot control the browser.' } });
  assert.match(none, /Not available here/);
  assert.match(none, /This build of Still cannot control the browser\./);
  assert.ok(!none.includes('settings.browser-allow'));
});

test('a site that could not be added says why next to the field', () => {
  const out = render({ enabled: true }, { draft: { site: 'not a site', rule: 'block', error: 'Enter a site, such as example.com.' } });
  assert.match(out, /name="site" value="not a site"/);
  assert.match(out, /aria-invalid="true"/);
  assert.match(out, /<p class="field-error" id="settings-browser-site-error" role="alert">Enter a site, such as example\.com\.<\/p>/);
  assert.equal(selected(out, 'rule'), 'block');
});

test('a site name is shown as text, never as markup', () => {
  // normalizeBrowserSettings only keeps real hosts, so the stored key itself cannot carry markup; a draft can.
  const out = render({ enabled: true }, { draft: { site: '"><img src=x onerror=alert(1)>', error: '' } });
  assert.ok(!out.includes('<img'), 'the draft is escaped');
  assert.ok(out.includes('&lt;img') || out.includes('&quot;&gt;'));
});

test('searching Settings finds browser automation rows by what they do', () => {
  const run = query => { resetIds(); return renderFiltered(searchTerms(query), ['Browser automation'], () => renderBrowserAutomation(ctx(), { browser: { enabled: true, sites: { 'shop.example': 'block' } } })); };
  const steps = run('maximum');
  assert.ok(flat(steps.content).includes('settings-browser-steps'));
  assert.ok(!flat(steps.content).includes('settings-browser-mode'), 'only the matching row');
  assert.ok(flat(run('approve').content).includes('settings-browser-mode'));
  assert.ok(flat(run('shop.example').content).includes('shop.example'));
  assert.ok(flat(run('block').content).includes('shop.example'), 'a rule is found by its name');
  // While searching, the notes under the cards are left out.
  assert.ok(!flat(run('maximum').content).includes('settings-note'));
});

test('the page and the section wait for the stored settings, then draw them', () => {
  const pending = flat(renderBrowserSettingsSection(ctx()));
  assert.match(pending, /settings-loading|could not load|not available|Loading/i, 'nothing is offered before the settings are known');
  assert.ok(!pending.includes('settings.browser-enable'));
  const page = flat(renderSettingsPage(ctx()));
  assert.match(page, /Browser automation/);
});
