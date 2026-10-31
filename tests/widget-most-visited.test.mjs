import test from 'node:test';
import assert from 'node:assert/strict';
import { siteKey, mostVisitedConfig, mostVisitedDefaults, siteLabel, cleanSites, visibleSites } from '../extension/ui/widgets/most-visited/model.js';

test('site keys ignore www, fragments and trailing slashes', () => {
  assert.equal(siteKey('https://www.Example.com/a/#x'), 'example.com/a');
  assert.equal(siteKey('http://example.com:8080/?q=1'), 'example.com:8080?q=1');
  assert.equal(siteKey('chrome://newtab'), '');
  assert.equal(siteKey('nope'), '');
});

test('config is filled and clamped; hidden entries are normalized and unique', () => {
  assert.deepEqual(mostVisitedConfig(), mostVisitedDefaults());
  const c = mostVisitedConfig({ view: 'grid', count: 99, hidden: ['https://a.com/', 'https://www.a.com', 'bad', 3], openIn: 'tab' });
  assert.deepEqual(c, { view: 'tiles', count: 20, hidden: ['a.com'], openIn: 'current' });
  assert.equal(mostVisitedConfig({ count: 'x' }).count, 8);
});

test('labels fall back to the host when Chrome stored the address as the title', () => {
  assert.equal(siteLabel({ url: 'https://www.github.com/', title: 'GitHub' }), 'GitHub');
  assert.equal(siteLabel({ url: 'https://www.github.com/', title: 'https://github.com/' }), 'github.com');
  assert.equal(siteLabel({ url: 'https://news.example/', title: '  ' }), 'news.example');
});

test('visible sites skip hidden and non-web pages, keep order and respect the count', () => {
  const list = [
    { url: 'https://a.com/', title: 'A' }, { url: 'chrome://settings', title: 'Settings' }, { url: 'https://b.com', title: 'B' },
    { url: 'https://www.b.com/', title: 'B again' }, { url: 'https://c.com', title: 'C' }, { url: 'https://d.com', title: 'D' },
  ];
  assert.deepEqual(cleanSites(list).map(s => s.title), ['A', 'B', 'C', 'D']);
  const config = mostVisitedConfig({ count: 2, hidden: ['https://a.com'] });
  assert.deepEqual(visibleSites(list, config), { sites: [{ url: 'https://b.com', title: 'B' }, { url: 'https://c.com', title: 'C' }], hiddenCount: 1 });
  assert.deepEqual(visibleSites(null, config), { sites: [], hiddenCount: 0 });
});
