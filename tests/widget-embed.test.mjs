import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmbed, coerceUrl, parseStart, isLocalHost, PROVIDERS } from '../extension/ui/widgets/embed/providers.js';
import {
  embedConfig, embedDefaults, frameLayout, stepZoom, sandboxFlags, frameRuleId, frameRule, framingHost, framingOrigins, planFrameRules, isFrameRuleId,
  framingVerdict, viewportOf, viewportPatch, refreshLabel, referrerRule, RULE_ID_MIN, RULE_ID_SPAN, REFERRER_RULE_ID, ZOOM_STEPS,
} from '../extension/ui/widgets/embed/model.js';
import { wantedRules } from '../extension/ui/widgets/embed/rules.js';

test('typed addresses become http(s) URLs; other schemes and words are refused', () => {
  assert.equal(coerceUrl('example.com/a?b=1').href, 'https://example.com/a?b=1');
  assert.equal(coerceUrl('localhost:3000/app').href, 'http://localhost:3000/app');
  assert.equal(coerceUrl('127.0.0.1:8080').href, 'http://127.0.0.1:8080/');
  assert.equal(coerceUrl('//cdn.example.com/x').href, 'https://cdn.example.com/x');
  assert.equal(coerceUrl('grafana.internal:3000/d/abc').href, 'https://grafana.internal:3000/d/abc');
  for (const bad of ['', '  ', 'hello', 'hello world', 'javascript:alert(1)', 'mailto:a@b.com', 'data:text/html,hi', 'chrome://settings',
    'file:///etc/passwd', 'https://user:pw@example.com', 'ftp://example.com', null, undefined]) {
    assert.equal(coerceUrl(bad), null, String(bad));
  }
  assert.ok(isLocalHost('localhost') && isLocalHost('127.0.0.1') && isLocalHost('app.localhost'));
  assert.ok(!isLocalHost('example.com'));
});

test('YouTube watch, short, live, playlist and timestamp links become the player', () => {
  const watch = resolveEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s');
  assert.equal(watch.provider, 'youtube');
  assert.equal(watch.embedUrl, 'https://www.youtube.com/embed/dQw4w9WgXcQ?start=90&rel=0');
  assert.equal(watch.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s');
  assert.equal(watch.aspect, '16:9');
  assert.equal(watch.poster, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(watch.known, true);
  assert.equal(watch.referrer, true);
  assert.deepEqual(watch.access, ['https://*.youtube.com/*']);
  assert.equal(resolveEmbed('https://vimeo.com/1').referrer, false);
  assert.equal(resolveEmbed('youtu.be/dQw4w9WgXcQ').embedUrl, 'https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0');
  assert.equal(resolveEmbed('https://youtube.com/shorts/dQw4w9WgXcQ').aspect, '9:16');
  assert.match(resolveEmbed('https://m.youtube.com/live/dQw4w9WgXcQ').embedUrl, /embed\/dQw4w9WgXcQ/);
  assert.equal(resolveEmbed('https://www.youtube.com/playlist?list=PL123').embedUrl, 'https://www.youtube.com/embed/videoseries?list=PL123');
  assert.equal(resolveEmbed('https://www.youtube.com/@channel').provider, 'web');
  assert.equal(parseStart('1h2m3s'), 3723);
  assert.equal(parseStart('45'), 45);
  assert.equal(parseStart('nope'), 0);
});

test('video, audio and design services use their official embeds', () => {
  assert.equal(resolveEmbed('https://vimeo.com/76979871').embedUrl, 'https://player.vimeo.com/video/76979871');
  assert.equal(resolveEmbed('https://vimeo.com/76979871/abc123').embedUrl, 'https://player.vimeo.com/video/76979871?h=abc123');
  assert.equal(resolveEmbed('https://www.loom.com/share/0123456789abcdef0123456789abcdef').embedUrl, 'https://www.loom.com/embed/0123456789abcdef0123456789abcdef');
  assert.equal(resolveEmbed('https://open.spotify.com/intl-de/playlist/37i9dQZF1DXcBWIGoYBM5M').embedUrl, 'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(resolveEmbed('https://music.apple.com/us/album/x/123').embedUrl, 'https://embed.music.apple.com/us/album/x/123');
  assert.match(resolveEmbed('https://soundcloud.com/artist/track').embedUrl, /^https:\/\/w\.soundcloud\.com\/player\/\?url=https%3A%2F%2Fsoundcloud\.com%2Fartist%2Ftrack/);
  const figma = resolveEmbed('https://www.figma.com/design/AbC/My-file?node-id=1-2');
  assert.equal(figma.provider, 'figma');
  assert.match(figma.embedUrl, /^https:\/\/www\.figma\.com\/embed\?embed_host=still&url=/);
  assert.equal(resolveEmbed('https://www.twitch.tv/somechannel', { parent: 'abcdef' }).embedUrl, 'https://player.twitch.tv/?channel=somechannel&parent=abcdef');
  assert.equal(resolveEmbed('https://www.twitch.tv/videos/12345', { parent: 'abcdef' }).embedUrl, 'https://player.twitch.tv/?video=v12345&parent=abcdef');
  assert.equal(resolveEmbed('https://codepen.io/someone/pen/AbCdE').embedUrl, 'https://codepen.io/someone/embed/AbCdE?default-tab=result');
  assert.equal(resolveEmbed('https://codesandbox.io/s/xyz-123').embedUrl, 'https://codesandbox.io/embed/xyz-123');
  assert.equal(resolveEmbed('https://miro.com/app/board/uXjVabc=/').embedUrl, 'https://miro.com/app/live-embed/uXjVabc=/');
  assert.equal(resolveEmbed('https://airtable.com/appX/shrY').embedUrl, 'https://airtable.com/embed/appX/shrY');
});

test('Google Docs, Sheets, Slides, Forms, Drive, Calendar and Maps links become embeddable pages', () => {
  assert.equal(resolveEmbed('https://docs.google.com/document/d/abc/edit#heading=h.1').embedUrl, 'https://docs.google.com/document/d/abc/preview');
  assert.equal(resolveEmbed('https://docs.google.com/spreadsheets/d/abc/edit?gid=0').provider, 'google-sheets');
  assert.equal(resolveEmbed('https://docs.google.com/presentation/d/abc/edit').aspect, '16:9');
  assert.equal(resolveEmbed('https://docs.google.com/presentation/d/e/2PACX/pub?start=false').embedUrl, 'https://docs.google.com/presentation/d/e/2PACX/embed?start=false');
  assert.equal(resolveEmbed('https://docs.google.com/document/d/e/2PACX/pub').embedUrl, 'https://docs.google.com/document/d/e/2PACX/pub?embedded=true');
  assert.equal(resolveEmbed('https://docs.google.com/spreadsheets/d/e/2PACX/pubhtml').embedUrl, 'https://docs.google.com/spreadsheets/d/e/2PACX/pubhtml?widget=true&headers=false');
  assert.equal(resolveEmbed('https://docs.google.com/forms/d/e/1FAI/viewform').embedUrl, 'https://docs.google.com/forms/d/e/1FAI/viewform?embedded=true');
  assert.equal(resolveEmbed('https://drive.google.com/file/d/FILE/view?usp=sharing').embedUrl, 'https://drive.google.com/file/d/FILE/preview');
  const cid = Buffer.from('team@example.com').toString('base64');
  assert.equal(resolveEmbed(`https://calendar.google.com/calendar/u/0?cid=${cid}`).embedUrl, 'https://calendar.google.com/calendar/embed?src=team%40example.com');
  assert.equal(resolveEmbed('https://calendar.google.com/calendar/u/0/r').provider, 'web');
  assert.equal(resolveEmbed('https://www.google.com/maps/place/Eiffel+Tower/@48.85,2.29,17z').embedUrl, 'https://maps.google.com/maps?q=Eiffel+Tower&z=17&output=embed');
  assert.equal(resolveEmbed('https://www.google.com/maps/@40.7,-74.0,12z').embedUrl, 'https://maps.google.com/maps?ll=40.7%2C-74.0&z=12&output=embed');
  // A stray "%" in a place name must not throw (that would break the widget, its settings and the framing rules).
  assert.equal(resolveEmbed('https://www.google.com/maps/place/50%off+Store').embedUrl, 'https://maps.google.com/maps?q=50%25off+Store&output=embed');
});

test('other pages embed as they are; http is upgraded except on this computer', () => {
  const page = resolveEmbed('https://news.ycombinator.com/');
  assert.deepEqual([page.provider, page.known, page.embedUrl, page.host], ['web', false, 'https://news.ycombinator.com/', 'news.ycombinator.com']);
  assert.equal(page.label, PROVIDERS.web.label);
  const upgraded = resolveEmbed('http://example.com/x');
  assert.equal(upgraded.embedUrl, 'https://example.com/x');
  assert.equal(upgraded.upgraded, true);
  const local = resolveEmbed('http://localhost:3000');
  assert.equal(local.embedUrl, 'http://localhost:3000/');
  assert.equal(local.upgraded, false);
  assert.equal(resolveEmbed('not a url'), null);
});

test('config is clamped and filled; page width choices map to config', () => {
  assert.deepEqual(embedConfig({}), embedDefaults());
  const c = embedConfig({ url: ' x.com ', zoom: 900, offsetX: -5, offsetY: 99999, autoRefresh: 7, sandbox: 'none', interactive: 0, pageWidth: 1280, mobile: true });
  assert.deepEqual([c.url, c.zoom, c.offsetX, c.offsetY, c.autoRefresh, c.sandbox, c.interactive, c.mobile, c.pageWidth], ['x.com', 200, 0, 4000, 0, 'relaxed', true, true, 0]);
  assert.equal(embedConfig({ zoom: 'abc' }).zoom, 100);
  assert.equal(viewportOf(embedConfig({ pageWidth: 1280 })), 'desktop');
  assert.equal(viewportOf(embedConfig({ mobile: true })), 'phone');
  assert.equal(viewportOf(embedConfig({})), 'fit');
  assert.deepEqual(viewportPatch('phone'), { mobile: true, pageWidth: 0 });
  assert.deepEqual(viewportPatch('desktop'), { mobile: false, pageWidth: 1280 });
  assert.equal(refreshLabel(0), 'Off');
  assert.equal(refreshLabel(1), 'Every minute');
  assert.equal(refreshLabel(15), 'Every 15 minutes');
});

test('frame geometry: zoom, phone and desktop widths, and a framed region', () => {
  assert.deepEqual(frameLayout({ width: 400, height: 300 }), { width: 400, height: 300, scale: 1, x: -0, y: -0 });
  // Zoomed out the page lays out wider and is drawn smaller.
  assert.deepEqual(frameLayout({ width: 400, height: 300, zoom: 50 }), { width: 800, height: 600, scale: 0.5, x: -0, y: -0 });
  // Phone: 390px layout scaled to the stage width.
  const phone = frameLayout({ width: 195, height: 400, mobile: true });
  assert.deepEqual([phone.width, phone.height, phone.scale], [390, 800, 0.5]);
  // Desktop at 640px wide: half size.
  const desk = frameLayout({ width: 640, height: 360, pageWidth: 1280 });
  assert.deepEqual([desk.width, desk.height, desk.scale], [1280, 720, 0.5]);
  // Framing a region: the page point (300, 200) lands in the corner.
  const region = frameLayout({ width: 400, height: 300, zoom: 200, offsetX: 300, offsetY: 200 });
  assert.equal(region.scale, 2);
  assert.deepEqual([region.x, region.y], [-600, -400]);
  assert.equal(region.width, 500); // 300 offset + 200 visible page px
  assert.equal(region.height, 350);
  // Zoom is clamped.
  assert.equal(frameLayout({ width: 100, height: 100, zoom: 1000 }).scale, 2);
});

test('zoom steps move to the next stop and stay at the ends', () => {
  assert.equal(stepZoom(100, 1), 110);
  assert.equal(stepZoom(100, -1), 90);
  assert.equal(stepZoom(104, -1), 100);
  assert.equal(stepZoom(200, 1), 200);
  assert.equal(stepZoom(25, -1), 25);
  assert.ok(ZOOM_STEPS.includes(100));
});

test('sandbox modes never allow navigating the dashboard', () => {
  for (const mode of ['relaxed', 'strict']) assert.doesNotMatch(sandboxFlags(mode), /allow-top-navigation/);
  assert.match(sandboxFlags('relaxed'), /allow-popups/);
  assert.doesNotMatch(sandboxFlags('strict'), /allow-popups/);
  assert.match(sandboxFlags('strict'), /allow-scripts allow-same-origin/);
});

test('framing rules are stable per widget, scoped to the site and this extension', () => {
  const id = frameRuleId('w_abc');
  assert.equal(id, frameRuleId('w_abc'));
  assert.notEqual(id, frameRuleId('w_abd'));
  assert.ok(isFrameRuleId(id) && id >= RULE_ID_MIN && id < RULE_ID_MIN + RULE_ID_SPAN);
  assert.ok(!isFrameRuleId(5) && !isFrameRuleId('7100001'));
  assert.equal(framingHost('https://www.Example.com/a'), 'example.com');
  assert.equal(framingHost('ftp://x.com'), '');
  assert.deepEqual(framingOrigins('https://www.example.com/a'), ['https://*.example.com/*']);
  assert.deepEqual(framingOrigins('http://localhost:3000/'), ['http://localhost/*']);
  const rule = frameRule({ widgetId: 'w_abc', url: 'https://www.example.com/dash', extensionId: 'extid' });
  assert.equal(rule.id, id);
  assert.deepEqual(rule.condition, { resourceTypes: ['sub_frame'], requestDomains: ['example.com'], initiatorDomains: ['extid'] }, 'only frames Still loads, never the site\'s own requests');
  assert.deepEqual(rule.action.responseHeaders.map(h => [h.header, h.operation]), [['x-frame-options', 'remove'], ['content-security-policy', 'remove']]);
  assert.equal(frameRule({ widgetId: 'w', url: 'nope', extensionId: 'x' }), null);
});

test('rule plans add, replace and remove only the widget rules', () => {
  const a = frameRule({ widgetId: 'a', url: 'https://a.com', extensionId: 'x' });
  const b = frameRule({ widgetId: 'b', url: 'https://b.com', extensionId: 'x' });
  const bMoved = frameRule({ widgetId: 'b', url: 'https://c.com', extensionId: 'x' });
  const foreign = { id: 42, action: {}, condition: {} };
  assert.deepEqual(planFrameRules([a, foreign], [a, b]), { removeRuleIds: [], addRules: [b] });
  assert.deepEqual(planFrameRules([a, b, foreign], [a]), { removeRuleIds: [b.id], addRules: [] });
  assert.deepEqual(planFrameRules([b], [bMoved]), { removeRuleIds: [b.id], addRules: [bMoved] });
  assert.deepEqual(planFrameRules([], [null]), { removeRuleIds: [], addRules: [] });
});

test('framing headers: frame-ancestors wins over X-Frame-Options', () => {
  assert.equal(framingVerdict({}), 'allowed');
  assert.equal(framingVerdict({ 'x-frame-options': 'DENY' }), 'blocked');
  assert.equal(framingVerdict({ 'x-frame-options': 'SAMEORIGIN' }), 'blocked');
  assert.equal(framingVerdict({ 'x-frame-options': 'ALLOW-FROM https://a.com' }), 'allowed');
  assert.equal(framingVerdict({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" }), 'blocked');
  assert.equal(framingVerdict({ 'content-security-policy': 'frame-ancestors *', 'x-frame-options': 'DENY' }), 'allowed');
  assert.equal(framingVerdict({ 'content-security-policy': "frame-ancestors 'self' chrome-extension:" }), 'allowed');
  assert.equal(framingVerdict(new Headers({ 'X-Frame-Options': 'deny' })), 'blocked');
});

test('the player rule names this extension as the embedding page, only for its own YouTube frames', () => {
  const rule = referrerRule({ extensionId: 'extid' });
  assert.equal(rule.id, REFERRER_RULE_ID);
  assert.ok(isFrameRuleId(rule.id));
  assert.notEqual(frameRuleId('anything'), REFERRER_RULE_ID);
  assert.deepEqual(rule.action.requestHeaders, [{ header: 'referer', operation: 'set', value: 'chrome-extension://extid/' }]);
  assert.deepEqual(rule.condition, { resourceTypes: ['sub_frame'], requestDomains: ['youtube.com', 'youtube-nocookie.com'], initiatorDomains: ['extid'] });
  assert.equal(referrerRule({}), null);
});

test('wanted rules: framing for allowed sites on any board, one player rule while a YouTube widget exists', () => {
  globalThis.chrome = { runtime: { id: 'extid' } };
  try {
    const embed = (id, config) => ({ id, type: 'embed', config });
    const dashboard = { boards: [
      { id: 'a', widgets: [embed('w1', { url: 'https://grafana.example.com/d/1', allowFraming: true }), embed('w2', { url: 'https://example.com' }), { id: 'n', type: 'notes', config: {} }] },
      { id: 'b', widgets: [embed('w3', { url: 'https://youtu.be/dQw4w9WgXcQ', allowFraming: true }), embed('w4', { url: 'nope', allowFraming: true })] },
    ] };
    const rules = wantedRules(dashboard);
    assert.deepEqual(rules.map(r => r.id), [REFERRER_RULE_ID, frameRuleId('w1')]);
    assert.deepEqual(rules[1].condition.requestDomains, ['grafana.example.com']);
    assert.deepEqual(wantedRules({ boards: [{ widgets: [embed('w2', { url: 'https://example.com' })] }] }), []);
    assert.deepEqual(wantedRules(null), []);
  } finally { delete globalThis.chrome; }
});
