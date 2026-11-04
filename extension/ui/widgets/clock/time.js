// Pure time helpers for the clock widget: formatted clock parts, time zone offsets and day relations, zone names and
// the time zone search. Node-importable (no DOM).

const formats = new Map();
function format(locale, options) {
  const key = `${locale || ''}|${JSON.stringify(options)}`;
  if (!formats.has(key)) {
    let made;
    try { made = new Intl.DateTimeFormat(locale || undefined, options); } catch { made = new Intl.DateTimeFormat('en-US', { ...options, timeZone: options.timeZone && isZone(options.timeZone) ? options.timeZone : undefined }); }
    formats.set(key, made);
  }
  return formats.get(key);
}

const zoneCheck = new Map();
/** True when Intl knows the zone name. */
export function isZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  if (!zoneCheck.has(tz)) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); zoneCheck.set(tz, true); } catch { zoneCheck.set(tz, false); }
  }
  return zoneCheck.get(tz);
}
export const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

/** Whether the locale writes times with a 12-hour clock by default. */
export function localeUses12h(locale) {
  try { return /h1[12]/.test(new Intl.DateTimeFormat(locale || undefined, { hour: 'numeric' }).resolvedOptions().hourCycle || ''); } catch { return false; }
}

/**
 * Clock text in pieces so the time can be large and the seconds and AM/PM small:
 * { hm: '9:41', sec: '07', sep: ':', period: 'PM', hour: 21, minute: 41, label: '9:41 PM' } (sep is the locale's separator).
 * hour12: 'auto' (locale default) | true | false. 24-hour times keep a leading zero (09:41).
 */
export function clockParts(date = new Date(), { hour12 = 'auto', timeZone, locale } = {}) {
  const tz = timeZone && isZone(timeZone) ? timeZone : undefined;
  const twelve = hour12 === 'auto' ? localeUses12h(locale) : !!hour12;
  const parts = format(locale, { hour: twelve ? 'numeric' : '2-digit', minute: '2-digit', second: '2-digit', hourCycle: twelve ? 'h12' : 'h23', timeZone: tz })
    .formatToParts(date);
  let hm = '';
  let sec = '';
  let period = '';
  let sep = '';
  let seenMinute = false;
  for (const part of parts) {
    if (part.type === 'dayPeriod') period = part.value;
    else if (part.type === 'second') sec = part.value;
    else if (part.type === 'hour' || part.type === 'minute') { hm += part.value; if (part.type === 'minute') seenMinute = true; }
    else if (part.type === 'literal' && !seenMinute && hm) { hm += part.value; sep ||= part.value.trim(); }
  }
  hm = hm.trim();
  const h24 = Number(format('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).formatToParts(date).find(p => p.type === 'hour')?.value ?? date.getHours()) % 24;
  return { hm, sec, sep: sep || ':', period, hour: h24, minute: Number(parts.find(p => p.type === 'minute')?.value ?? 0), label: period ? `${hm} ${period}` : hm };
}

/** "Friday, October 30" (or with the year when it is not this year) in a zone. */
export function dateLine(date = new Date(), { timeZone, locale, weekday = 'long' } = {}) {
  return format(locale, { weekday, month: 'long', day: 'numeric', timeZone: timeZone && isZone(timeZone) ? timeZone : undefined }).format(date);
}

/** Offset of a zone from UTC at an instant, in minutes. */
export function zoneOffsetMinutes(date, tz) {
  if (!isZone(tz)) return -date.getTimezoneOffset();
  const parts = {};
  for (const part of format('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / 60_000) * 60_000) / 60_000);
}

/** Difference to local time: 'Same time', '+7h', '−3h', '+5h 30m', '−9h 30m' (real minus sign). */
export function formatOffset(minutes) {
  const n = Math.round(Number(minutes) || 0);
  if (!n) return 'Same time';
  const sign = n > 0 ? '+' : '−';
  const abs = Math.abs(n);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h ? `${h}h` : ''}${h && m ? ' ' : ''}${m ? `${m}m` : ''}`;
}

/** "+5 hours 30 minutes ahead" style text for screen readers. */
export function offsetSentence(minutes) {
  const n = Math.round(Number(minutes) || 0);
  if (!n) return 'same time as here';
  const abs = Math.abs(n);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const parts = [h ? `${h} ${h === 1 ? 'hour' : 'hours'}` : '', m ? `${m} ${m === 1 ? 'minute' : 'minutes'}` : ''].filter(Boolean).join(' ');
  return `${parts} ${n > 0 ? 'ahead' : 'behind'}`;
}

/** The difference in minutes between a zone and the local zone (or `base`) at an instant. */
export const relativeOffset = (date, tz, base) => zoneOffsetMinutes(date, tz) - (base ? zoneOffsetMinutes(date, base) : -date.getTimezoneOffset());

const dayStamp = (date, tz) => format('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz && isZone(tz) ? tz : undefined }).format(date);
/** -1, 0 or 1: the zone's calendar day compared with the local one (or `base`'s). */
export function dayRelation(date, tz, base) {
  const there = dayStamp(date, tz);
  const here = dayStamp(date, base);
  return there === here ? 0 : there > here ? 1 : -1;
}
export const relationLabel = relation => (relation > 0 ? 'Tomorrow' : relation < 0 ? 'Yesterday' : 'Today');

/** Daytime is 6:00 until 18:00 in that zone. */
export const isDaytime = hour => hour >= 6 && hour < 18;

// Legacy zone ids that Intl still reports, shown with today's city names.
const CITY_NAMES = { Calcutta: 'Kolkata', Saigon: 'Ho Chi Minh City', Kiev: 'Kyiv', Rangoon: 'Yangon', Katmandu: 'Kathmandu', Ho_Chi_Minh: 'Ho Chi Minh City' };
/** 'America/Argentina/Buenos_Aires' -> 'Buenos Aires'; 'Asia/Calcutta' -> 'Kolkata'; 'UTC' -> 'UTC'. */
export function zoneCity(tz) {
  const last = String(tz || '').split('/').pop() || '';
  return (CITY_NAMES[last] || last).replace(/_/g, ' ');
}
/** The label a zone gets when added from a search result (abbreviations like "PST" become the city). */
export const aliasLabel = (alias, tz) => (alias && !/^[A-Z]{2,5}$/.test(alias) && !/\btime$/i.test(alias) && alias !== 'Coordinated Universal Time' ? alias : zoneCity(tz));
/** 'Europe/Paris' -> 'Europe'; 'America/Argentina/Salta' -> 'America · Argentina'. */
export function zoneRegion(tz) {
  const parts = String(tz || '').split('/');
  return parts.length > 1 ? parts.slice(0, -1).join(' · ').replace(/_/g, ' ') : '';
}
/** "GMT+9", "GMT−3:30" at an instant. */
export function gmtLabel(date, tz) {
  const minutes = zoneOffsetMinutes(date, tz);
  if (!minutes) return 'GMT';
  const abs = Math.abs(minutes);
  return `GMT${minutes > 0 ? '+' : '−'}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
}

// Cities and abbreviations people search for that are not zone names themselves.
export const ZONE_ALIASES = Object.freeze({
  'San Francisco': 'America/Los_Angeles', 'Seattle': 'America/Los_Angeles', 'Portland': 'America/Los_Angeles', 'San Diego': 'America/Los_Angeles',
  'Las Vegas': 'America/Los_Angeles', 'Silicon Valley': 'America/Los_Angeles', 'Pacific Time': 'America/Los_Angeles', 'PST': 'America/Los_Angeles',
  'PDT': 'America/Los_Angeles', 'Salt Lake City': 'America/Denver', 'Mountain Time': 'America/Denver', 'MST': 'America/Denver', 'Aurora': 'America/Denver',
  'Austin': 'America/Chicago', 'Dallas': 'America/Chicago', 'Houston': 'America/Chicago', 'Minneapolis': 'America/Chicago', 'Central Time': 'America/Chicago',
  'CST': 'America/Chicago', 'Boston': 'America/New_York', 'Washington': 'America/New_York', 'Philadelphia': 'America/New_York', 'Miami': 'America/New_York',
  'Atlanta': 'America/New_York', 'Eastern Time': 'America/New_York', 'EST': 'America/New_York', 'EDT': 'America/New_York', 'Montreal': 'America/Toronto',
  'Ottawa': 'America/Toronto', 'Rio de Janeiro': 'America/Sao_Paulo', 'BST': 'Europe/London', 'Edinburgh': 'Europe/London',
  'Manchester': 'Europe/London', 'Munich': 'Europe/Berlin', 'Frankfurt': 'Europe/Berlin', 'Hamburg': 'Europe/Berlin', 'CET': 'Europe/Paris',
  'Barcelona': 'Europe/Madrid', 'Milan': 'Europe/Rome', 'Geneva': 'Europe/Zurich', 'Kyiv': 'Europe/Kiev', 'Tel Aviv': 'Asia/Jerusalem',
  'Abu Dhabi': 'Asia/Dubai', 'Mumbai': 'Asia/Kolkata', 'Delhi': 'Asia/Kolkata', 'New Delhi': 'Asia/Kolkata', 'Bangalore': 'Asia/Kolkata',
  'Bengaluru': 'Asia/Kolkata', 'IST': 'Asia/Kolkata', 'Beijing': 'Asia/Shanghai', 'Shenzhen': 'Asia/Shanghai', 'Hanoi': 'Asia/Bangkok',
  'Osaka': 'Asia/Tokyo', 'Kyoto': 'Asia/Tokyo', 'JST': 'Asia/Tokyo', 'Canberra': 'Australia/Sydney', 'AEST': 'Australia/Sydney',
  'Wellington': 'Pacific/Auckland', 'Cape Town': 'Africa/Johannesburg', 'UTC': 'UTC', 'GMT': 'UTC', 'Coordinated Universal Time': 'UTC',
});

// Zones most people add, preferred when several match equally well.
const POPULAR = new Set(['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Toronto', 'America/Mexico_City',
  'America/Sao_Paulo', 'America/Buenos_Aires', 'Europe/London', 'Europe/Dublin', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
  'Europe/Rome', 'Europe/Amsterdam', 'Europe/Stockholm', 'Europe/Zurich', 'Europe/Athens', 'Europe/Istanbul', 'Europe/Moscow', 'Africa/Cairo',
  'Africa/Lagos', 'Africa/Johannesburg', 'Africa/Nairobi', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Calcutta', 'Asia/Karachi', 'Asia/Dhaka', 'Asia/Bangkok',
  'Asia/Singapore', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Seoul', 'Asia/Tokyo', 'Asia/Jakarta', 'Asia/Manila', 'Australia/Sydney',
  'Australia/Melbourne', 'Australia/Perth', 'Pacific/Auckland', 'Pacific/Honolulu', 'America/Anchorage', 'America/Phoenix', 'UTC']);

let zoneList = null;
/** Every zone Intl supports, plus UTC. */
export function allZones() {
  if (zoneList) return zoneList;
  let list = [];
  try { list = Intl.supportedValuesOf?.('timeZone') || []; } catch { list = []; }
  if (!list.length) list = [...new Set(Object.values(ZONE_ALIASES))];
  zoneList = [...new Set(['UTC', ...list])];
  return zoneList;
}

const fold = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Zones matching a query by city, region, alias or offset ("tokyo", "europe", "pst", "+5:30", "gmt-3"):
 * [{ tz, label, region, gmt, alias }], best matches first (at most `limit`). An empty query lists popular zones.
 */
export function searchZones(query, { date = new Date(), limit = 30, zones = allZones() } = {}) {
  const q = fold(query).trim();
  const make = (tz, alias = '') => ({ tz, label: alias || zoneCity(tz), region: zoneRegion(tz), gmt: gmtLabel(date, tz), alias });
  if (!q) {
    return ['America/Los_Angeles', 'America/New_York', 'Europe/London', 'Europe/Paris', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'UTC']
      .filter(isZone).slice(0, limit).map(tz => make(tz));
  }
  const offset = /^(?:gmt|utc)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/.exec(q.replace('−', '-'));
  const results = [];
  const seen = new Set();
  const push = (score, tz, alias) => {
    const key = `${tz}|${alias || ''}`;
    if (seen.has(key) || !isZone(tz)) return;
    seen.add(key);
    results.push({ score, entry: make(tz, alias) });
  };
  if (offset) {
    const minutes = (offset[1] === '+' ? 1 : -1) * (Number(offset[2]) * 60 + Number(offset[3] || 0));
    for (const tz of zones) if (zoneOffsetMinutes(date, tz) === minutes) push(1, tz);
  }
  for (const [alias, tz] of Object.entries(ZONE_ALIASES)) {
    const name = fold(alias);
    if (name === q) push(0, tz, alias);
    else if (name.startsWith(q)) push(2, tz, alias);
  }
  for (const tz of zones) {
    const city = fold(zoneCity(tz));
    const full = fold(tz.replace(/_/g, ' '));
    if (city === q) push(0, tz);
    else if (city.startsWith(q)) push(2, tz);
    else if (city.includes(q)) push(3, tz);
    else if (full.includes(q)) push(4, tz);
  }
  // Within a score, well-known cities first, then shorter names ("Paris" before "Paramaribo").
  const known = tz => (POPULAR.has(tz) ? 0 : 1);
  return results.sort((a, b) => a.score - b.score || known(a.entry.tz) - known(b.entry.tz) || a.entry.label.length - b.entry.label.length
    || a.entry.label.localeCompare(b.entry.label)).slice(0, limit).map(r => r.entry);
}

/** Cleans stored zones: [{ id, label, tz }] with known zones only (max 12). */
export function normalizeZones(list) {
  const out = [];
  for (const zone of Array.isArray(list) ? list : []) {
    if (!zone || !isZone(zone.tz) || out.length >= 12) continue;
    out.push({ id: String(zone.id || `${zone.tz}-${out.length}`).slice(0, 40), label: String(zone.label || '').trim().slice(0, 40) || zoneCity(zone.tz), tz: zone.tz });
  }
  return out;
}

/**
 * Hand angles in degrees for an analog face at an instant in a zone: { hour, minute, second } (0 = 12 o'clock).
 * Fractions keep the hands moving smoothly between ticks.
 */
export function handAngles(date = new Date(), timeZone) {
  const offset = timeZone && isZone(timeZone) ? zoneOffsetMinutes(date, timeZone) : -date.getTimezoneOffset();
  const local = date.getTime() + offset * 60_000;
  const secondsOfDay = ((local / 1000) % 86_400 + 86_400) % 86_400;
  return {
    hour: ((secondsOfDay / 3600) % 12) * 30,
    minute: ((secondsOfDay / 60) % 60) * 6,
    second: (secondsOfDay % 60) * 6,
  };
}
