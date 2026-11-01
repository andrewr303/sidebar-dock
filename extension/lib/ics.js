// iCalendar (.ics) feed parsing and recurrence expansion for the calendar widget. Pure and Node-importable.
// Supports VEVENT with SUMMARY, LOCATION, URL, DESCRIPTION (only to find a meeting link), STATUS, DTSTART/DTEND/DURATION
// (all-day dates, UTC, TZID including Windows zone names, floating local time), RRULE (DAILY, WEEKLY with BYDAY,
// MONTHLY with BYMONTHDAY or nth BYDAY, YEARLY with BYMONTH; INTERVAL, COUNT, UNTIL), EXDATE and RECURRENCE-ID
// overrides. Recurrences keep their wall-clock time across daylight saving changes in their own time zone.
//
// Event: { uid, summary, location, url, meetingUrl, allDay, start, end, tzid, wall, durationMs, durationDays, rrule,
//          exdates: [ms], recurrenceId: ms | null }
// Occurrence (expandEvents): { key, uid, summary, location, url, meetingUrl, allDay, start, end }

const DAY_MS = 86_400_000;
export const MAX_ICS_BYTES = 8 * 1024 * 1024;

// ------------------------------------------------------------------ lines and properties

/** Joins folded lines (CRLF followed by a space or tab) and splits the text into content lines. */
export function unfoldLines(text) {
  return String(text ?? '').replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n').map(line => line.trimEnd()).filter(Boolean);
}

/** "DTSTART;TZID=\"Europe/Paris\":20260101T090000" -> { name, params, value }. Quoted parameter values may hold ; and :. */
export function parseProperty(line) {
  let quoted = false;
  let colon = -1;
  const cuts = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === ';') cuts.push(i);
    else if (!quoted && c === ':') { colon = i; break; }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const bounds = [-1, ...cuts.filter(i => i < colon), colon];
  const segments = bounds.slice(0, -1).map((start, index) => head.slice(start + 1, bounds[index + 1]));
  const params = {};
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf('=');
    if (eq > 0) params[segment.slice(0, eq).toUpperCase()] = segment.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: segments[0].toUpperCase(), params, value: line.slice(colon + 1) };
}

/** Undoes iCalendar text escaping (\n, \, , \; and \\). */
export const unescapeText = value => String(value ?? '').replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

// ------------------------------------------------------------------ time zones

const WINDOWS_ZONES = {
  'eastern standard time': 'America/New_York', 'central standard time': 'America/Chicago', 'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix', 'pacific standard time': 'America/Los_Angeles', 'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu', 'atlantic standard time': 'America/Halifax', 'canada central standard time': 'America/Regina',
  'sa pacific standard time': 'America/Bogota', 'e. south america standard time': 'America/Sao_Paulo', 'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik', 'w. europe standard time': 'Europe/Berlin', 'romance standard time': 'Europe/Paris',
  'central europe standard time': 'Europe/Budapest', 'central european standard time': 'Europe/Warsaw', 'gtb standard time': 'Europe/Bucharest',
  'fle standard time': 'Europe/Helsinki', 'russian standard time': 'Europe/Moscow', 'israel standard time': 'Asia/Jerusalem',
  'south africa standard time': 'Africa/Johannesburg', 'arabian standard time': 'Asia/Dubai', 'india standard time': 'Asia/Kolkata',
  'china standard time': 'Asia/Shanghai', 'singapore standard time': 'Asia/Singapore', 'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul', 'aus eastern standard time': 'Australia/Sydney', 'e. australia standard time': 'Australia/Brisbane',
  'new zealand standard time': 'Pacific/Auckland', 'utc': 'UTC', 'coordinated universal time': 'UTC',
};

const zoneFormats = new Map();
function zoneFormat(tz) {
  if (!zoneFormats.has(tz)) {
    let format = null;
    try {
      format = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } catch { format = null; }
    zoneFormats.set(tz, format);
  }
  return zoneFormats.get(tz);
}

/** An IANA zone Intl understands for a TZID ('/mozilla.org/…/Europe/Paris', Windows names), or '' when unknown. */
export function resolveZone(tzid) {
  let value = String(tzid || '').trim().replace(/^"|"$/g, '');
  if (!value) return '';
  value = WINDOWS_ZONES[value.toLowerCase()] || value;
  const iana = /([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(value)?.[1];
  for (const candidate of [value, iana]) if (candidate && zoneFormat(candidate)) return candidate;
  return '';
}

/** Offset of a zone from UTC at an instant, in ms (local minus UTC). */
function zoneOffset(ms, tz) {
  const parts = {};
  for (const part of zoneFormat(tz).formatToParts(new Date(ms))) if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second) - Math.floor(ms / 1000) * 1000;
}

/** Epoch ms for a wall-clock time in a zone (two passes settle daylight saving edges). */
export function zonedTimeToMs({ y, mo, d, h = 0, mi = 0, s = 0 }, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (!tz || tz === 'UTC') return guess;
  const first = zoneOffset(guess, tz);
  let ms = guess - first;
  const second = zoneOffset(ms, tz);
  if (second !== first) ms = guess - second;
  return ms;
}

// wall + how it maps to an instant: 'utc', a zone name, or '' (floating local time, all-day dates).
const wallToMs = (wall, zone) => (zone ? zonedTimeToMs(wall, zone) : new Date(wall.y, wall.mo - 1, wall.d, wall.h || 0, wall.mi || 0, wall.s || 0).getTime());

/**
 * Parses a DATE or DATE-TIME value: { ms, allDay, zone, wall } or null. zone is 'UTC', an IANA zone, or '' for
 * floating times and all-day dates (both read in the viewer's local time).
 */
export function parseDateValue(value, params = {}) {
  const text = String(value || '').trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (params.VALUE?.toUpperCase() === 'DATE' || date) {
    const m = date || /^(\d{4})(\d{2})(\d{2})/.exec(text);
    if (!m) return null;
    const wall = { y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, s: 0 };
    return validWall(wall) ? { ms: wallToMs(wall, ''), allDay: true, zone: '', wall } : null;
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(text);
  if (!m) return null;
  const wall = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
  if (!validWall(wall)) return null;
  const zone = m[7] ? 'UTC' : resolveZone(params.TZID);
  return { ms: wallToMs(wall, zone), allDay: false, zone, wall };
}
const validWall = w => w.mo >= 1 && w.mo <= 12 && w.d >= 1 && w.d <= 31 && w.h <= 24 && w.mi < 60 && w.s <= 60;

/** ISO 8601 duration ("PT1H30M", "P1D", "-P1W") in ms, or null. */
export function parseDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(value || '').trim());
  if (!m || m[0].length < 2) return null;
  const ms = ((+m[2] || 0) * 7 * DAY_MS) + ((+m[3] || 0) * DAY_MS) + ((+m[4] || 0) * 3_600_000) + ((+m[5] || 0) * 60_000) + ((+m[6] || 0) * 1000);
  return m[1] === '-' ? -ms : ms;
}

// ------------------------------------------------------------------ recurrence rules

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

/** RRULE text -> { freq, interval, count, until, byDay: [{ day, n }], byMonthDay: [], byMonth: [], wkst } or null when unsupported. */
export function parseRrule(value) {
  const parts = {};
  for (const piece of String(value || '').split(';')) {
    const eq = piece.indexOf('=');
    if (eq > 0) parts[piece.slice(0, eq).trim().toUpperCase()] = piece.slice(eq + 1).trim().toUpperCase();
  }
  if (!FREQS.has(parts.FREQ)) return null;
  const list = key => (parts[key] ? parts[key].split(',').filter(Boolean) : []);
  const byDay = list('BYDAY').map(token => {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token);
    return m ? { day: WEEKDAYS.indexOf(m[2]), n: m[1] ? Number(m[1]) : 0 } : null;
  }).filter(Boolean);
  const until = parts.UNTIL ? parseDateValue(parts.UNTIL, {}) : null;
  const count = parts.COUNT ? Math.max(0, Math.floor(Number(parts.COUNT))) : 0;
  return {
    freq: parts.FREQ,
    interval: Math.max(1, Math.min(1000, Math.floor(Number(parts.INTERVAL) || 1))),
    count: Number.isFinite(count) ? count : 0,
    // A date-only UNTIL includes that whole day.
    until: until ? (until.allDay ? until.ms + DAY_MS - 1 : until.ms) : null,
    byDay,
    byMonthDay: list('BYMONTHDAY').map(Number).filter(n => Number.isInteger(n) && n !== 0 && Math.abs(n) <= 31),
    byMonth: list('BYMONTH').map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 12),
    wkst: Math.max(0, WEEKDAYS.indexOf(parts.WKST || 'MO')),
  };
}

// Day numbers: whole days since 1970-01-01 on the proleptic calendar (no time zone involved).
const dayNum = (y, mo, d) => Math.round(Date.UTC(y, mo - 1, d) / DAY_MS);
const fromDayNum = n => { const date = new Date(n * DAY_MS); return { y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, d: date.getUTCDate() }; };
const weekdayOf = n => (((n + 4) % 7) + 7) % 7;
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

/** Day numbers of the nth weekday rules ({ day, n }) in a month; n = 0 means every such weekday. */
function weekdaysInMonth(y, mo, rules) {
  const first = dayNum(y, mo, 1);
  const length = daysInMonth(y, mo);
  const out = [];
  for (const { day, n } of rules) {
    const matches = [];
    for (let i = 0; i < length; i++) if (weekdayOf(first + i) === day) matches.push(first + i);
    if (!n) out.push(...matches);
    else { const pick = n > 0 ? matches[n - 1] : matches[matches.length + n]; if (pick !== undefined) out.push(pick); }
  }
  return out;
}
function monthDays(y, mo, list) {
  const length = daysInMonth(y, mo);
  return list.map(n => (n > 0 ? n : length + n + 1)).filter(n => n >= 1 && n <= length).map(n => dayNum(y, mo, n));
}

/** Candidate day numbers of a rule, in order, starting at the period that contains the first day. */
function* candidateDays(rule, startDay) {
  const start = fromDayNum(startDay);
  for (let period = 0; period < 100_000; period++) {
    let days = [];
    if (rule.freq === 'DAILY') {
      const day = startDay + period * rule.interval;
      if (!rule.byDay.length || rule.byDay.some(r => r.day === weekdayOf(day))) days = [day];
    } else if (rule.freq === 'WEEKLY') {
      const weekBegin = startDay - ((weekdayOf(startDay) - rule.wkst + 7) % 7) + period * 7 * rule.interval;
      const wanted = rule.byDay.length ? rule.byDay.map(r => r.day) : [weekdayOf(startDay)];
      days = [...new Set(wanted)].map(day => weekBegin + ((day - rule.wkst + 7) % 7));
    } else if (rule.freq === 'MONTHLY') {
      const index = start.mo - 1 + period * rule.interval;
      const y = start.y + Math.floor(index / 12);
      const mo = (index % 12) + 1;
      if (!rule.byMonth.length || rule.byMonth.includes(mo)) {
        days = rule.byDay.length ? weekdaysInMonth(y, mo, rule.byDay) : monthDays(y, mo, rule.byMonthDay.length ? rule.byMonthDay : [start.d]);
      }
    } else {
      const y = start.y + period * rule.interval;
      for (const mo of rule.byMonth.length ? rule.byMonth : [start.mo]) {
        days.push(...(rule.byDay.length ? weekdaysInMonth(y, mo, rule.byDay) : monthDays(y, mo, rule.byMonthDay.length ? rule.byMonthDay : [start.d])));
      }
    }
    for (const day of [...new Set(days)].sort((a, b) => a - b)) if (day >= startDay) yield day;
  }
}

// ------------------------------------------------------------------ parsing

const MEETING_LINKS = [
  /https:\/\/meet\.google\.com\/[a-z0-9-]+/i,
  /https:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/(?:j|my|w)\/[A-Za-z0-9?=&._-]+/i,
  /https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[A-Za-z0-9%/?=&._-]+/i,
  /https:\/\/[a-z0-9-]+\.webex\.com\/[A-Za-z0-9%/?=&._-]+/i,
];
/** The first video-call link in any of the given texts (Meet, Zoom, Teams, Webex), or ''. */
export function meetingLink(...texts) {
  for (const text of texts) {
    for (const pattern of MEETING_LINKS) {
      const match = String(text || '').match(pattern);
      if (match) return match[0].replace(/[).,;>\]]+$/, '');
    }
  }
  return '';
}

const httpUrl = value => { try { const url = new URL(String(value || '').trim()); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };

/**
 * Parses an iCalendar document: { name, events }. name is the calendar's X-WR-CALNAME (or ''). Cancelled events and
 * events without a start are left out. Nested components (alarms) never leak into their event.
 */
export function parseIcs(text) {
  const source = String(text ?? '');
  if (source.length > MAX_ICS_BYTES) throw new Error('This calendar is too large to show (over 8 MB).');
  if (!/BEGIN:VCALENDAR/i.test(source)) throw new Error('This address did not return a calendar. Check that it is an iCal (.ics) link.');
  const events = [];
  let name = '';
  let current = null;
  let depth = 0; // nesting inside the current VEVENT (VALARM and friends)
  for (const line of unfoldLines(source)) {
    const prop = parseProperty(line);
    if (!prop) continue;
    const upper = prop.value.trim().toUpperCase();
    if (prop.name === 'BEGIN') {
      if (upper === 'VEVENT' && !current) { current = { exdates: [] }; depth = 0; } else if (current) depth++;
      continue;
    }
    if (prop.name === 'END') {
      if (current && depth > 0) { depth--; continue; }
      if (upper === 'VEVENT' && current) { const event = finishEvent(current); if (event) events.push(event); current = null; }
      continue;
    }
    if (!current) { if (prop.name === 'X-WR-CALNAME' && !name) name = unescapeText(prop.value).trim().slice(0, 120); continue; }
    if (depth > 0) continue;
    switch (prop.name) {
      case 'UID': current.uid = prop.value.trim(); break;
      case 'SUMMARY': current.summary = unescapeText(prop.value).trim(); break;
      case 'LOCATION': current.location = unescapeText(prop.value).trim(); break;
      case 'DESCRIPTION': current.description = unescapeText(prop.value); break;
      case 'URL': current.url = httpUrl(prop.value); break;
      case 'STATUS': current.status = upper; break;
      case 'DTSTART': current.start = parseDateValue(prop.value, prop.params); break;
      case 'DTEND': current.end = parseDateValue(prop.value, prop.params); break;
      case 'DURATION': current.duration = parseDuration(prop.value); break;
      case 'RRULE': current.rrule = parseRrule(prop.value); break;
      case 'RECURRENCE-ID': current.recurrenceId = parseDateValue(prop.value, prop.params)?.ms ?? null; break;
      case 'EXDATE':
        for (const piece of prop.value.split(',')) { const parsed = parseDateValue(piece, prop.params); if (parsed) current.exdates.push(parsed.ms); }
        break;
      default: break;
    }
  }
  return { name, events: events.sort((a, b) => a.start - b.start) };
}

function finishEvent(raw) {
  if (!raw.start || raw.status === 'CANCELLED') return null;
  const { start } = raw;
  let durationMs = 0;
  let durationDays = 0;
  if (start.allDay) {
    const endDay = raw.end?.allDay ? dayNum(raw.end.wall.y, raw.end.wall.mo, raw.end.wall.d) : null;
    const startDay = dayNum(start.wall.y, start.wall.mo, start.wall.d);
    durationDays = endDay && endDay > startDay ? endDay - startDay : raw.duration > 0 ? Math.max(1, Math.round(raw.duration / DAY_MS)) : 1;
  } else {
    durationMs = raw.end && raw.end.ms >= start.ms ? raw.end.ms - start.ms : raw.duration > 0 ? raw.duration : 0;
  }
  const end = start.allDay ? endOfDays(start.wall, durationDays) : start.ms + durationMs;
  return {
    uid: raw.uid || `${start.ms}-${raw.summary || 'event'}`,
    summary: raw.summary || 'Untitled event',
    location: (raw.location || '').slice(0, 300),
    url: raw.url || '',
    meetingUrl: meetingLink(raw.url, raw.location, raw.description),
    allDay: start.allDay,
    start: start.ms,
    end,
    tzid: start.zone,
    wall: start.wall,
    durationMs,
    durationDays,
    rrule: raw.recurrenceId ? null : raw.rrule || null,
    exdates: raw.exdates,
    recurrenceId: raw.recurrenceId ?? null,
  };
}
const endOfDays = (wall, days) => { const { y, mo, d } = fromDayNum(dayNum(wall.y, wall.mo, wall.d) + days); return new Date(y, mo - 1, d).getTime(); };

// ------------------------------------------------------------------ expansion

const occurrence = (event, start, end, index) => ({
  key: index ? `${event.uid}#${start}` : event.recurrenceId ? `${event.uid}#${event.recurrenceId}` : event.uid,
  uid: event.uid, summary: event.summary, location: event.location, url: event.url, meetingUrl: event.meetingUrl, allDay: event.allDay, start, end,
});

/**
 * Occurrences overlapping [from, to) (end exclusive), sorted by start. Recurring events expand up to `limit` each;
 * RECURRENCE-ID overrides replace the occurrence they modify and EXDATEs remove theirs.
 */
export function expandEvents(events, from, to, { limit = 500 } = {}) {
  const out = [];
  const overridden = new Set();
  for (const event of events || []) if (event.recurrenceId != null) overridden.add(`${event.uid}|${event.recurrenceId}`);
  for (const event of events || []) {
    if (!event.rrule) {
      if (event.end > from && event.start < to) out.push(occurrence(event, event.start, Math.max(event.end, event.start + (event.allDay ? 0 : 1)), 0));
      continue;
    }
    const rule = event.rrule;
    const excluded = new Set(event.exdates || []);
    const zone = event.allDay ? '' : event.tzid;
    const startDay = dayNum(event.wall.y, event.wall.mo, event.wall.d);
    // Day bounds let the loop skip the time zone math for occurrences that cannot reach the window.
    const fromDay = Math.floor(from / DAY_MS) - 2 - Math.ceil(event.durationMs / DAY_MS) - (event.durationDays || 0);
    const lastDay = Math.min(Math.ceil(to / DAY_MS) + 2, rule.until != null ? Math.floor(rule.until / DAY_MS) + 2 : Infinity);
    let generated = 0;
    let emitted = 0;
    let steps = 0;
    for (const day of candidateDays(rule, startDay)) {
      if (++steps > 50_000 || day > lastDay) break;
      if (day < fromDay) {
        if (rule.count && ++generated >= rule.count) break;
        continue;
      }
      const { y, mo, d } = fromDayNum(day);
      const wall = { ...event.wall, y, mo, d };
      const start = wallToMs(wall, zone);
      if (start < event.start) continue;
      generated++;
      if (rule.count && generated > rule.count) break;
      if (rule.until != null && start > rule.until) break;
      if (start >= to) break;
      if (excluded.has(start) || overridden.has(`${event.uid}|${start}`)) continue;
      const end = event.allDay ? endOfDays(wall, event.durationDays) : start + event.durationMs;
      if (end > from || (end === start && start >= from)) {
        out.push(occurrence(event, start, Math.max(end, start + (event.allDay ? 0 : 1)), generated - 1));
        if (++emitted >= limit) break;
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay) || a.summary.localeCompare(b.summary));
}

/**
 * Keeps a parsed feed small enough to cache: drops events that ended long ago or start far ahead (recurring events stay
 * while their rule can still produce occurrences) and caps the count.
 */
export function trimEvents(events, now = Date.now(), { past = 400 * DAY_MS, future = 800 * DAY_MS, max = 3000 } = {}) {
  const kept = (events || []).filter(event => {
    if (event.rrule) return event.rrule.until == null || event.rrule.until >= now - past;
    return event.end >= now - past && event.start <= now + future;
  });
  return kept.length > max ? kept.slice(-max) : kept;
}

/** webcal:// links open as https://; anything that is not an http(s) URL is refused (''). */
export function normalizeFeedUrl(value) {
  const text = String(value || '').trim().replace(/^webcals?:\/\//i, 'https://');
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}
