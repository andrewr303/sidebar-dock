import test from 'node:test';
import assert from 'node:assert/strict';
import {
  unfoldLines, parseProperty, unescapeText, parseDateValue, parseDuration, parseRrule, parseIcs, expandEvents, trimEvents, zonedTimeToMs,
  resolveZone, meetingLink, normalizeFeedUrl,
} from '../extension/lib/ics.js';
import { dayKey, fromKey, addDays, addMonths, weekStartFor, monthGrid, isoWeek, weekdayNames, bucketByDay, keyDelta } from '../extension/ui/widgets/calendar/month.js';
import { fetchFeed } from '../extension/ui/widgets/calendar/feeds.js';

const ics = body => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Team\r\n${body.trim().split('\n').map(l => l.trim()).join('\r\n')}\r\nEND:VCALENDAR\r\n`;
const iso = ms => new Date(ms).toISOString();

test('content lines unfold and properties keep quoted parameters', () => {
  assert.deepEqual(unfoldLines('SUMMARY:Long\r\n  title here\r\nDTSTART:20260101'), ['SUMMARY:Long title here', 'DTSTART:20260101']);
  assert.deepEqual(parseProperty('DTSTART;TZID="America/New_York":20260302T090000'), { name: 'DTSTART', params: { TZID: 'America/New_York' }, value: '20260302T090000' });
  assert.deepEqual(parseProperty('ATTENDEE;CN="Doe, John: PM";ROLE=REQ:mailto:j@x.com').params, { CN: 'Doe, John: PM', ROLE: 'REQ' });
  assert.equal(parseProperty('ATTENDEE;CN="Doe, John: PM";ROLE=REQ:mailto:j@x.com').value, 'mailto:j@x.com');
  assert.equal(parseProperty('no colon here'), null);
  assert.equal(unescapeText('a\\, b\\; c\\nd\\\\e'), 'a, b; c\nd\\e');
});

test('dates parse as all-day, UTC, zoned (including Windows names) and floating', () => {
  const day = parseDateValue('20261104', { VALUE: 'DATE' });
  assert.equal(day.allDay, true);
  assert.equal(day.ms, new Date(2026, 10, 4).getTime());
  assert.equal(iso(parseDateValue('20260302T140000Z').ms), '2026-03-02T14:00:00.000Z');
  assert.equal(iso(parseDateValue('20260302T090000', { TZID: 'America/New_York' }).ms), '2026-03-02T14:00:00.000Z');
  assert.equal(iso(parseDateValue('20260702T090000', { TZID: 'America/New_York' }).ms), '2026-07-02T13:00:00.000Z');
  assert.equal(iso(parseDateValue('20260302T090000', { TZID: 'Eastern Standard Time' }).ms), '2026-03-02T14:00:00.000Z');
  assert.equal(parseDateValue('20260302T090000', { TZID: '/mozilla.org/20050126_1/Europe/Paris' }).zone, 'Europe/Paris');
  const floating = parseDateValue('20260302T090000', { TZID: 'Not/AZone' });
  assert.equal(floating.zone, '');
  assert.equal(floating.ms, new Date(2026, 2, 2, 9).getTime());
  assert.equal(parseDateValue('garbage'), null);
  assert.equal(parseDateValue('20261340'), null);
  assert.equal(resolveZone('UTC'), 'UTC');
  assert.equal(resolveZone(''), '');
  assert.equal(iso(zonedTimeToMs({ y: 2026, mo: 11, d: 1, h: 1, mi: 30 }, 'America/New_York')).slice(0, 13), '2026-11-01T05');
  assert.equal(parseDuration('PT1H30M'), 5_400_000);
  assert.equal(parseDuration('P1W'), 7 * 86_400_000);
  assert.equal(parseDuration('-P1D'), -86_400_000);
  assert.equal(parseDuration('nope'), null);
});

test('events parse summary, place, links and skip cancelled ones and alarms', () => {
  const { name, events } = parseIcs(ics(`
    BEGIN:VEVENT
    UID:one
    SUMMARY:Design review\\, round 2
    DTSTART:20261030T150000Z
    DTEND:20261030T160000Z
    LOCATION:Studio 4
    DESCRIPTION:Join at https://meet.google.com/abc-defg-hij.
    URL:https://example.com/review
    BEGIN:VALARM
    DESCRIPTION:Alarm text must not leak
    SUMMARY:Alarm summary
    TRIGGER:-PT10M
    END:VALARM
    END:VEVENT
    BEGIN:VEVENT
    UID:two
    SUMMARY:Cancelled
    STATUS:CANCELLED
    DTSTART:20261030T150000Z
    END:VEVENT
    BEGIN:VEVENT
    UID:three
    DTSTART;VALUE=DATE:20261112
    DTEND;VALUE=DATE:20261115
    END:VEVENT
    BEGIN:VEVENT
    UID:four
    SUMMARY:No start
    END:VEVENT
    BEGIN:VEVENT
    UID:five
    SUMMARY:Duration only
    DTSTART:20261031T100000Z
    DURATION:PT45M
    URL:javascript:alert(1)
    END:VEVENT
  `));
  assert.equal(name, 'Team');
  assert.equal(events.length, 3);
  const review = events.find(e => e.uid === 'one');
  assert.equal(review.summary, 'Design review, round 2');
  assert.equal(review.location, 'Studio 4');
  assert.equal(review.url, 'https://example.com/review');
  assert.equal(review.meetingUrl, 'https://meet.google.com/abc-defg-hij');
  assert.equal(review.end - review.start, 3_600_000);
  const offsite = events.find(e => e.uid === 'three');
  assert.equal(offsite.summary, 'Untitled event');
  assert.equal(offsite.allDay, true);
  assert.equal(offsite.durationDays, 3);
  assert.equal(offsite.end, new Date(2026, 10, 15).getTime());
  const short = events.find(e => e.uid === 'five');
  assert.equal(short.end - short.start, 45 * 60_000);
  assert.equal(short.url, '');
  assert.throws(() => parseIcs('<html>Sign in</html>'), /did not return a calendar/);
  assert.equal(meetingLink('call https://us02web.zoom.us/j/123456?pwd=x).'), 'https://us02web.zoom.us/j/123456?pwd=x');
});

test('weekly recurrences keep their local time across daylight saving, with EXDATE and overrides', () => {
  const { events } = parseIcs(ics(`
    BEGIN:VEVENT
    UID:standup
    SUMMARY:Standup
    DTSTART;TZID=America/New_York:20260302T090000
    DTEND;TZID=America/New_York:20260302T091500
    RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=10
    EXDATE;TZID=America/New_York:20260304T090000
    END:VEVENT
    BEGIN:VEVENT
    UID:standup
    RECURRENCE-ID;TZID=America/New_York:20260306T090000
    SUMMARY:Standup (moved)
    DTSTART;TZID=America/New_York:20260306T100000
    DTEND;TZID=America/New_York:20260306T101500
    END:VEVENT
  `));
  const list = expandEvents(events, Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 1));
  assert.deepEqual(list.map(o => `${iso(o.start).slice(5, 16)} ${o.summary}`), [
    '03-02T14:00 Standup',
    '03-06T15:00 Standup (moved)',
    '03-09T13:00 Standup', // daylight saving began on March 8: still 9:00 in New York
    '03-11T13:00 Standup',
    '03-13T13:00 Standup',
    '03-16T13:00 Standup',
    '03-18T13:00 Standup',
    '03-20T13:00 Standup',
    '03-23T13:00 Standup', // COUNT=10 includes the excluded and overridden dates
  ]);
  assert.ok(list.every(o => o.end - o.start === 15 * 60_000));
  assert.equal(new Set(list.map(o => o.key)).size, list.length);
});

test('daily, monthly and yearly rules honour INTERVAL, UNTIL, BYMONTHDAY and nth weekdays', () => {
  const { events } = parseIcs(ics(`
    BEGIN:VEVENT
    UID:d
    SUMMARY:Every other day
    DTSTART:20260101T120000Z
    RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20260109T235959Z
    END:VEVENT
    BEGIN:VEVENT
    UID:m
    SUMMARY:Rent
    DTSTART;VALUE=DATE:20260131
    RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3
    END:VEVENT
    BEGIN:VEVENT
    UID:t
    SUMMARY:Thanksgiving
    DTSTART;VALUE=DATE:20241128
    RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH
    END:VEVENT
    BEGIN:VEVENT
    UID:p
    SUMMARY:Last Friday
    DTSTART:20260130T170000Z
    RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3
    END:VEVENT
  `));
  const days = uid => expandEvents(events.filter(e => e.uid === uid), Date.UTC(2025, 0, 1), Date.UTC(2027, 0, 1)).map(o => dayKey(new Date(o.start)));
  assert.deepEqual(days('d'), ['2026-01-01', '2026-01-03', '2026-01-05', '2026-01-07', '2026-01-09']);
  assert.deepEqual(days('m'), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.deepEqual(days('t'), ['2025-11-27', '2026-11-26']);
  assert.deepEqual(expandEvents(events.filter(e => e.uid === 'p'), 0, Date.UTC(2027, 0, 1)).map(o => iso(o.start).slice(0, 10)), ['2026-01-30', '2026-02-27', '2026-03-27']);
  assert.equal(parseRrule('FREQ=HOURLY'), null);
  assert.deepEqual(parseRrule('FREQ=WEEKLY;BYDAY=MO,2TU,-1FR').byDay, [{ day: 1, n: 0 }, { day: 2, n: 2 }, { day: 5, n: -1 }]);
});

test('expansion only returns occurrences in the window, and trimming drops stale events', () => {
  const { events } = parseIcs(ics(`
    BEGIN:VEVENT
    UID:old
    SUMMARY:Old
    DTSTART:20200101T100000Z
    END:VEVENT
    BEGIN:VEVENT
    UID:daily
    SUMMARY:Daily since 2018
    DTSTART:20180101T080000Z
    RRULE:FREQ=DAILY
    END:VEVENT
  `));
  const from = Date.UTC(2026, 9, 1);
  const to = Date.UTC(2026, 9, 8);
  const list = expandEvents(events, from, to);
  assert.equal(list.length, 7);
  assert.ok(list.every(o => o.start >= from && o.start < to));
  const kept = trimEvents(events, Date.UTC(2026, 9, 30));
  assert.deepEqual(kept.map(e => e.uid), ['daily']);
  assert.equal(normalizeFeedUrl('webcal://calendar.google.com/x.ics'), 'https://calendar.google.com/x.ics');
  assert.equal(normalizeFeedUrl('https://user:pw@example.com/x.ics'), '');
  assert.equal(normalizeFeedUrl('javascript:alert(1)'), '');
  assert.equal(normalizeFeedUrl('not a url'), '');
});

test('feed fetching explains failures and parses calendars', async () => {
  const reply = (status, text) => async () => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => text });
  const ok = await fetchFeed('webcal://example.com/cal.ics', { fetch: reply(200, ics('BEGIN:VEVENT\nUID:x\nSUMMARY:Hi\nDTSTART:20991010T100000Z\nEND:VEVENT')), now: Date.UTC(2099, 9, 1) });
  assert.equal(ok.name, 'Team');
  assert.equal(ok.events.length, 1);
  await assert.rejects(fetchFeed('https://example.com/x.ics', { fetch: reply(404, '') }), e => e.kind === 'http' && /no longer works/.test(e.message));
  await assert.rejects(fetchFeed('https://example.com/x.ics', { fetch: reply(403, '') }), /refused/);
  await assert.rejects(fetchFeed('https://example.com/x.ics', { fetch: reply(200, '<html></html>') }), e => e.kind === 'invalid');
  await assert.rejects(fetchFeed('https://example.com/x.ics', { fetch: async () => { throw new TypeError('Failed to fetch'); } }), e => e.kind === 'network');
  await assert.rejects(fetchFeed('ftp://example.com/x.ics'), e => e.kind === 'invalid');
});

test('month grids have six weeks starting on the chosen weekday', () => {
  const sunday = monthGrid(2026, 9, 0, new Date(2026, 9, 30));
  assert.equal(sunday.length, 6);
  assert.ok(sunday.every(week => week.length === 7));
  assert.equal(sunday[0][0].key, '2026-09-27');
  assert.equal(sunday[0][4].key, '2026-10-01');
  assert.equal(sunday[0][0].inMonth, false);
  assert.equal(sunday[4][5].key, '2026-10-30');
  assert.equal(sunday[4][5].today, true);
  assert.equal(sunday[4][5].weekend, false);
  assert.equal(sunday[4][6].weekend, true);
  const monday = monthGrid(2026, 9, 1);
  assert.equal(monday[0][0].key, '2026-09-28');
  assert.equal(monday[0][3].key, '2026-10-01');
  const feb = monthGrid(2027, 1, 1);
  assert.equal(feb[0][0].key, '2027-02-01');
  assert.equal(feb[5][6].key, '2027-03-14');
  assert.equal(weekStartFor('sunday', 'de-DE'), 0);
  assert.equal(weekStartFor('monday', 'en-US'), 1);
  assert.equal(weekStartFor('auto', 'en-US'), 0);
  assert.equal(weekStartFor('auto', 'en-GB'), 1);
  assert.equal(weekStartFor('auto', 'de-DE'), 1);
  assert.deepEqual(weekdayNames(1, 'en-US').map(d => d.abbr), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(weekdayNames(0, 'en-US')[0].long, 'Sunday');
  assert.equal(weekdayNames(0, 'en-US')[0].weekend, true);
});

test('day keys, month moves, week numbers and arrow keys', () => {
  assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(dayKey(fromKey('2026-03-08')), '2026-03-08');
  assert.equal(dayKey(addDays(new Date(2026, 2, 7), 2)), '2026-03-09');
  assert.equal(dayKey(fromKey('garbage')), dayKey(new Date()));
  assert.deepEqual(addMonths({ year: 2026, month: 11 }, 1), { year: 2027, month: 0 });
  assert.deepEqual(addMonths({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 });
  assert.deepEqual(addMonths({ year: 2026, month: 5 }, -18), { year: 2024, month: 11 });
  assert.equal(isoWeek(new Date(2026, 0, 1)), 1);
  assert.equal(isoWeek(new Date(2027, 0, 1)), 53);
  assert.equal(isoWeek(new Date(2026, 9, 30)), 44);
  assert.equal(keyDelta('ArrowLeft'), -1);
  assert.equal(keyDelta('ArrowLeft', true), 1);
  assert.equal(keyDelta('ArrowDown'), 7);
  assert.equal(keyDelta('Enter'), 0);
});

test('entries land on every local day they cover', () => {
  const first = new Date(2026, 9, 25);
  const last = new Date(2026, 10, 7);
  const at = (d, h = 0) => new Date(2026, 9, d, h).getTime();
  const map = bucketByDay([
    { title: 'Meeting', start: at(30, 15), end: at(30, 16), allDay: false },
    { title: 'Offsite', start: at(31), end: at(33), allDay: true },
    { title: 'Reminder', start: at(30, 9), end: at(30, 9), allDay: false },
    { title: 'Before', start: at(1), end: at(2), allDay: true },
  ], first, last);
  assert.deepEqual(map.get('2026-10-30').map(e => e.title), ['Reminder', 'Meeting']);
  assert.deepEqual(map.get('2026-10-31').map(e => e.title), ['Offsite']);
  assert.deepEqual(map.get('2026-11-01').map(e => e.title), ['Offsite']);
  assert.equal(map.has('2026-11-02'), false); // ends at midnight
  assert.equal(map.has('2026-10-01'), false);
});
