import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_DEFAULTS, BROWSER_LIMITS, BROWSER_MODES, BROWSER_PERMISSIONS, SITE_RULES, blockedSites, decideWrite, isNormalBrowserSettings, normalizeBrowserSettings,
  siteKey, siteOf, withSiteRule,
} from '../extension/lib/browser/settings.js';

test('browser automation is off by default and asks before it changes anything', () => {
  assert.deepEqual(normalizeBrowserSettings(undefined), { enabled: false, mode: 'ask', sites: {}, maxSteps: 60 });
  assert.deepEqual(normalizeBrowserSettings(null), normalizeBrowserSettings({}));
  assert.deepEqual({ ...BROWSER_DEFAULTS, sites: {} }, normalizeBrowserSettings('nonsense'));
  assert.deepEqual([...BROWSER_MODES], ['ask', 'auto']);
  assert.deepEqual([...SITE_RULES], ['allow', 'ask', 'block']);
  assert.deepEqual([...BROWSER_PERMISSIONS], ['tabs', 'webNavigation']);
});

test('normalizing keeps valid values and replaces the rest', () => {
  const settings = normalizeBrowserSettings({ enabled: true, mode: 'auto', maxSteps: '120', extra: 1,
    sites: { 'https://www.Shop.example/cart': 'allow', 'bank.example.': 'ask', 'localhost:3000': 'block', 'bad rule.example': 'maybe', '': 'allow', 'not a host !!': 'allow' } });
  assert.deepEqual(settings, { enabled: true, mode: 'auto', maxSteps: 120, sites: { 'shop.example': 'allow', 'bank.example': 'ask', 'localhost:3000': 'block' } });
  assert.equal(normalizeBrowserSettings({ enabled: 'yes' }).enabled, false, 'only true turns it on');
  assert.equal(normalizeBrowserSettings({ mode: 'AUTO' }).mode, 'ask');
  assert.equal(normalizeBrowserSettings({ maxSteps: 3 }).maxSteps, BROWSER_LIMITS.minSteps);
  assert.equal(normalizeBrowserSettings({ maxSteps: 10000 }).maxSteps, BROWSER_LIMITS.maxSteps);
  assert.equal(normalizeBrowserSettings({ maxSteps: 59.6 }).maxSteps, 60);
  assert.equal(normalizeBrowserSettings({ maxSteps: 'many' }).maxSteps, 60);
  assert.deepEqual(normalizeBrowserSettings({ sites: ['a.example'] }).sites, {});
  const many = Object.fromEntries(Array.from({ length: 700 }, (_, index) => [`site${index}.example`, 'ask']));
  assert.equal(Object.keys(normalizeBrowserSettings({ sites: many }).sites).length, BROWSER_LIMITS.maxSites);
});

test('a value is normal only when nothing would be changed', () => {
  assert.equal(isNormalBrowserSettings(normalizeBrowserSettings({})), true);
  assert.equal(isNormalBrowserSettings({ enabled: true, mode: 'auto', sites: { 'shop.example': 'allow' }, maxSteps: 80 }), true);
  for (const value of [null, [], { enabled: true }, { ...normalizeBrowserSettings({}), extra: true }, { ...normalizeBrowserSettings({}), mode: 'always' },
    { ...normalizeBrowserSettings({}), maxSteps: 9999 }, { ...normalizeBrowserSettings({}), sites: { 'www.shop.example': 'allow' } },
    { ...normalizeBrowserSettings({}), sites: { 'shop.example': 'yes' } }, { ...normalizeBrowserSettings({}), sites: [] }, { ...normalizeBrowserSettings({}), enabled: 'true' }]) {
    assert.equal(isNormalBrowserSettings(value), false, JSON.stringify(value));
  }
});

test('a site is the host as the address bar shows it', () => {
  assert.equal(siteOf('https://www.Example.com/a?b#c'), 'example.com');
  assert.equal(siteOf('http://example.com.:80/'), 'example.com');
  assert.equal(siteOf('https://example.com:8443/'), 'example.com:8443');
  assert.equal(siteOf('http://127.0.0.1:4173/pages/shop.html'), '127.0.0.1:4173');
  assert.equal(siteOf('http://[::1]:8787/'), '[::1]:8787');
  assert.equal(siteOf('chrome://settings'), 'settings');
  for (const address of ['', 'not a url', 'about:blank', 'data:text/html,hi', undefined, null, 42]) assert.equal(siteOf(address), '', String(address));
  assert.equal(siteKey('Example.com'), 'example.com');
  assert.equal(siteKey('  https://WWW.example.com/x  '), 'example.com');
  assert.equal(siteKey('localhost:3000'), 'localhost:3000');
  assert.equal(siteKey(''), '');
  assert.equal(siteKey(undefined), '');
});

test('a rule can only name a web site: what a URL parser happens to accept is not enough', () => {
  // Chrome escapes a space in a host where other parsers refuse it, so the shape of the host is checked.
  for (const entry of ['not a site !!', 'not%20a%20site%20!!', 'exa mple.com', 'foo!!', '!!', '*.example.com', '-bad.example', 'bad-.example', 'a..b', 'example.com:99999999',
    'http://', 'javascript:alert(1)', 'data:text/html,hi', 'x'.repeat(3000)]) assert.equal(siteKey(entry), '', entry.slice(0, 40));
  // Other schemes are not web sites, even though they have a host of sorts.
  for (const entry of ['chrome://settings', 'chrome-extension://abcdefghijklmnop/index.html', 'file:///etc/passwd', 'ftp://files.example', 'about://blank']) assert.equal(siteKey(entry), '', entry);
  assert.equal(siteKey('user:secret@host.example/path?x=1'), 'host.example', 'only the host is kept');
  assert.equal(siteKey('bücher.example'), 'xn--bcher-kva.example', 'an international name is stored as the address bar writes it');
  assert.equal(siteKey('a_b.example'), 'a_b.example');
  assert.equal(siteKey('192.168.1.5:3000'), '192.168.1.5:3000');
  assert.equal(siteKey('[::1]:8080'), '[::1]:8080');
  assert.equal(siteKey('intranet'), 'intranet');
  assert.deepEqual(normalizeBrowserSettings({ sites: { 'not%20a%20site': 'allow', 'chrome://settings': 'allow', 'ok.example': 'block' } }).sites, { 'ok.example': 'block' });
  assert.equal(isNormalBrowserSettings({ ...normalizeBrowserSettings({}), sites: { 'not%20a%20site': 'allow' } }), false);
  assert.deepEqual(withSiteRule({}, 'not a site', 'allow').sites, {}, 'nothing is added for a name that is not a site');
});

test('the site key is the browser control layer\'s own', async () => {
  globalThis.chrome ??= {};
  const { loadBrowserControl } = await import('../extension/lib/browser-control/layer.js');
  const layer = await loadBrowserControl();
  for (const address of ['https://www.Example.com/a', 'http://example.com.:80/', 'https://example.com:8443/', 'http://127.0.0.1:4173/x', 'http://[::1]:8787/', 'https://sub.www.example.co.uk/',
    'https://xn--bcher-kva.example/', 'https://Bücher.example/', 'ftp://files.example/', 'chrome://settings', 'about:blank', 'data:text/html,hi', 'blob:https://a.example/1', '', 'nonsense']) {
    assert.equal(siteOf(address), layer.siteOf(address), address);
  }
  for (const entry of ['Example.com', 'https://www.example.com/x', 'localhost:3000', '  a.example  ', '']) assert.equal(siteKey(entry), layer.siteKey(entry), entry);
});

test('writes ask in Ask mode, run in Auto mode, and a site rule decides over both', () => {
  const ask = normalizeBrowserSettings({ mode: 'ask', sites: { 'shop.example': 'allow', 'bank.example': 'ask', 'bad.example': 'block' } });
  const auto = { ...ask, mode: 'auto' };
  const write = site => ({ category: 'submit', site, tabId: 1 });
  assert.deepEqual(decideWrite(ask, write('news.example')), { decision: 'ask', by: 'auto', canRemember: true });
  assert.deepEqual(decideWrite(auto, write('news.example')), { decision: 'run', by: 'auto', canRemember: true });
  for (const settings of [ask, auto]) {
    assert.deepEqual(decideWrite(settings, write('shop.example')), { decision: 'run', by: 'site-rule', canRemember: true });
    assert.deepEqual(decideWrite(settings, write('bank.example')), { decision: 'ask', by: 'site-rule', canRemember: false });
    assert.deepEqual(decideWrite(settings, write('')), { decision: 'ask', canRemember: false }, 'a page without a host cannot hold a rule');
    assert.deepEqual(decideWrite(settings, {}), { decision: 'ask', canRemember: false });
  }
  // A blocked site never gets this far (the layer refuses it); if it did, the block is not an allow.
  assert.equal(decideWrite(ask, write('bad.example')).decision, 'ask');
  assert.equal(decideWrite(null, write('a.example')).decision, 'ask');
  assert.equal(decideWrite({ mode: 'AUTO' }, write('a.example')).decision, 'ask');
  assert.deepEqual(blockedSites(ask), ['bad.example']);
  assert.deepEqual(blockedSites(null), []);
});

test('setting and removing a site rule returns new settings', () => {
  const start = normalizeBrowserSettings({ sites: { 'a.example': 'ask' } });
  const allowed = withSiteRule(start, 'https://www.B.example/page', 'allow');
  assert.deepEqual(allowed.sites, { 'a.example': 'ask', 'b.example': 'allow' });
  assert.deepEqual(start.sites, { 'a.example': 'ask' }, 'the input is not changed');
  assert.deepEqual(withSiteRule(allowed, 'a.example', null).sites, { 'b.example': 'allow' });
  assert.deepEqual(withSiteRule(allowed, 'a.example', 'nonsense').sites, { 'b.example': 'allow' });
  assert.deepEqual(withSiteRule(allowed, '', 'allow').sites, allowed.sites);
  assert.equal(isNormalBrowserSettings(allowed), true);
});
