import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clockParts, dateLine, zoneOffsetMinutes, formatOffset, offsetSentence, relativeOffset, dayRelation, relationLabel, isDaytime, zoneCity, zoneRegion,
  gmtLabel, searchZones, normalizeZones, handAngles, isZone, aliasLabel, allZones,
} from '../extension/ui/widgets/clock/time.js';

// 21:41:07 in Denver (UTC−6 on this date).
const AT = new Date(Date.UTC(2026, 9, 31, 3, 41, 7));

test('clock parts split the time so seconds and AM/PM can be smaller', () => {
  assert.deepEqual(clockParts(AT, { hour12: true, timeZone: 'America/Denver', locale: 'en-US' }),
    { hm: '9:41', sec: '07', sep: ':', period: 'PM', hour: 21, minute: 41, label: '9:41 PM' });
  const h24 = clockParts(AT, { hour12: false, timeZone: 'America/Denver', locale: 'en-US' });
  assert.equal(h24.hm, '21:41');
  assert.equal(h24.period, '');
  assert.equal(clockParts(new Date(Date.UTC(2026, 0, 1, 7, 5)), { hour12: false, timeZone: 'UTC' }).hm, '07:05');
  assert.equal(clockParts(AT, { hour12: 'auto', timeZone: 'America/Denver', locale: 'en-US' }).period, 'PM');
  assert.equal(clockParts(AT, { hour12: 'auto', timeZone: 'America/Denver', locale: 'de-DE' }).hm, '21:41');
  assert.equal(clockParts(AT, { hour12: true, timeZone: 'Asia/Tokyo', locale: 'en-US' }).label, '12:41 PM');
  // An unknown zone falls back to local time instead of throwing.
  assert.equal(typeof clockParts(AT, { timeZone: 'Mars/Olympus' }).hm, 'string');
  assert.equal(dateLine(AT, { timeZone: 'America/Denver', locale: 'en-US' }), 'Friday, October 30');
});

test('zone offsets are formatted relative to local time', () => {
  assert.equal(zoneOffsetMinutes(AT, 'Asia/Kolkata'), 330);
  assert.equal(zoneOffsetMinutes(AT, 'UTC'), 0);
  assert.equal(zoneOffsetMinutes(AT, 'America/New_York'), -240);
  assert.equal(formatOffset(0), 'Same time');
  assert.equal(formatOffset(420), '+7h');
  assert.equal(formatOffset(-180), '−3h');
  assert.equal(formatOffset(330), '+5h 30m');
  assert.equal(formatOffset(-570), '−9h 30m');
  assert.equal(formatOffset(45), '+45m');
  assert.equal(offsetSentence(-90), '1 hour 30 minutes behind');
  assert.equal(offsetSentence(60), '1 hour ahead');
  assert.equal(offsetSentence(0), 'same time as here');
  assert.equal(relativeOffset(AT, 'Asia/Kolkata', 'America/Denver'), 330 + 360);
  assert.equal(relativeOffset(AT, 'America/Denver', 'America/Denver'), 0);
  assert.equal(gmtLabel(AT, 'Asia/Kolkata'), 'GMT+5:30');
  assert.equal(gmtLabel(AT, 'America/Denver'), 'GMT−6');
  assert.equal(gmtLabel(AT, 'UTC'), 'GMT');
});

test('day relations, day and night, and zone names', () => {
  assert.equal(dayRelation(AT, 'Asia/Tokyo', 'America/Denver'), 1);
  assert.equal(dayRelation(AT, 'Pacific/Honolulu', 'America/Denver'), 0);
  assert.equal(dayRelation(new Date(Date.UTC(2026, 9, 31, 7)), 'Pacific/Honolulu', 'Asia/Tokyo'), -1);
  assert.equal(relationLabel(1), 'Tomorrow');
  assert.equal(relationLabel(-1), 'Yesterday');
  assert.equal(relationLabel(0), 'Today');
  assert.equal(isDaytime(6), true);
  assert.equal(isDaytime(17), true);
  assert.equal(isDaytime(18), false);
  assert.equal(isDaytime(2), false);
  assert.equal(zoneCity('America/Argentina/Buenos_Aires'), 'Buenos Aires');
  assert.equal(zoneCity('Asia/Calcutta'), 'Kolkata');
  assert.equal(zoneCity('UTC'), 'UTC');
  assert.equal(zoneRegion('America/Argentina/Salta'), 'America · Argentina');
  assert.equal(zoneRegion('UTC'), '');
  assert.equal(aliasLabel('PST', 'America/Los_Angeles'), 'Los Angeles');
  assert.equal(aliasLabel('Pacific Time', 'America/Los_Angeles'), 'Los Angeles');
  assert.equal(aliasLabel('Osaka', 'Asia/Tokyo'), 'Osaka');
  assert.equal(aliasLabel('', 'Europe/Paris'), 'Paris');
});

test('time zone search finds cities, aliases, abbreviations and offsets', () => {
  assert.ok(allZones().length > 300);
  assert.ok(allZones().includes('UTC'));
  assert.equal(searchZones('tokyo', { date: AT })[0].tz, 'Asia/Tokyo');
  assert.equal(searchZones('São', { date: AT })[0].tz, 'America/Sao_Paulo');
  const pst = searchZones('pst', { date: AT })[0];
  assert.equal(pst.tz, 'America/Los_Angeles');
  assert.equal(pst.alias, 'PST');
  assert.equal(searchZones('bengaluru', { date: AT })[0].tz, 'Asia/Kolkata');
  assert.ok(searchZones('+5:30', { date: AT }).every(r => zoneOffsetMinutes(AT, r.tz) === 330));
  assert.ok(searchZones('GMT-3', { date: AT }).length > 0);
  assert.ok(searchZones('europe', { date: AT, limit: 5 }).length === 5);
  assert.deepEqual(searchZones('zzzz-nothing', { date: AT }), []);
  assert.ok(searchZones('', { date: AT }).length > 3);
});

test('stored zones are cleaned and capped', () => {
  const zones = normalizeZones([
    { id: 'a', label: '  Home ', tz: 'Europe/London' },
    { id: 'b', label: '', tz: 'Asia/Tokyo' },
    { id: 'c', label: 'Mars', tz: 'Mars/Olympus' },
    null,
    ...Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, label: '', tz: 'UTC' })),
  ]);
  assert.equal(zones.length, 12);
  assert.deepEqual(zones[0], { id: 'a', label: 'Home', tz: 'Europe/London' });
  assert.equal(zones[1].label, 'Tokyo');
  assert.ok(!zones.some(z => z.tz === 'Mars/Olympus'));
  assert.equal(isZone('Europe/Paris'), true);
  assert.equal(isZone('Nope/Nope'), false);
  assert.deepEqual(normalizeZones('nope'), []);
});

test('analog hand angles follow the zone time, with smooth fractions', () => {
  const angles = handAngles(new Date(Date.UTC(2026, 0, 1, 3, 30, 15)), 'UTC');
  assert.equal(Math.round(angles.hour * 100) / 100, 105.13);
  assert.equal(Math.round(angles.minute * 100) / 100, 181.5);
  assert.equal(angles.second, 90);
  const tokyo = handAngles(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)), 'Asia/Tokyo');
  assert.equal(tokyo.hour, 270);
  assert.equal(tokyo.minute, 0);
});
