import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCacheEntries, readCache, writeCache, isStale, deleteCache, loadWidgetCache } from '../extension/lib/widget-cache.js';

test('merging keeps the newest entry per key and respects removals', () => {
  const target = { a: { value: 1, at: 10 }, b: { value: 2, at: 50 } };
  const changed = mergeCacheEntries(target, {
    a: { value: 'newer', at: 20 }, b: { value: 'older', at: 40 }, c: { value: 3, at: 5 }, d: { value: 4, at: 99 },
    broken: { at: 1 }, bad: 'x', ['__proto__']: { value: 'x', at: 1 },
  }, { removed: new Set(['d']) });
  assert.deepEqual(changed.sort(), ['a', 'c']);
  assert.deepEqual(target, { a: { value: 'newer', at: 20 }, b: { value: 2, at: 50 }, c: { value: 3, at: 5 } });
  assert.deepEqual(mergeCacheEntries(target, null), []);
});

test('merging prunes the oldest entries beyond the limit', () => {
  const target = {};
  mergeCacheEntries(target, Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, { value: i, at: i }])), { max: 4 });
  assert.deepEqual(Object.keys(target).sort(), ['k2', 'k3', 'k4', 'k5']);
});

test('read, write, staleness and prefix deletes work in memory', async () => {
  await loadWidgetCache();
  assert.equal(readCache('weather:1,2:c'), null);
  assert.equal(isStale('weather:1,2:c', 1000), true);
  writeCache('weather:1,2:c', { temp: 20 });
  writeCache('weather', { all: true });
  writeCache('weatherish', 1);
  assert.deepEqual(readCache('weather:1,2:c').value, { temp: 20 });
  assert.equal(isStale('weather:1,2:c', 60_000), false);
  deleteCache('weather');
  assert.equal(readCache('weather:1,2:c'), null);
  assert.equal(readCache('weather'), null);
  assert.equal(readCache('weatherish').value, 1, 'only the key and its children are removed');
});
