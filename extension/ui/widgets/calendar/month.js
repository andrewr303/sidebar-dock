// Pure calendar helpers for the calendar widget: week start, month grids, day keys, week numbers and bucketing
// events onto days. Dates are local calendar days. Node-importable (no DOM).

const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' for a local date. */
export function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Local midnight Date for 'YYYY-MM-DD' (invalid keys give today). */
export function fromKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate()); }
  return new Date(+m[1], +m[2] - 1, +m[3]);
}
/** A local date moved by whole days (DST safe: it works on the calendar, not on milliseconds). */
export const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
/** { year, month } moved by whole months (month is 0-based). */
export function addMonths({ year, month }, delta) {
  const index = year * 12 + month + delta;
  return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 };
}

// Regions whose weeks start on Sunday (the rest of the world mostly starts on Monday; a few on Saturday).
const SUNDAY_REGIONS = new Set(['US', 'CA', 'MX', 'BR', 'JP', 'KR', 'TW', 'HK', 'IL', 'IN', 'PH', 'ZA', 'AU', 'SA', 'AR', 'CO', 'PE', 'VE', 'GT', 'PR', 'TH', 'ID']);
const SATURDAY_REGIONS = new Set(['AE', 'AF', 'BH', 'DJ', 'DZ', 'EG', 'IQ', 'IR', 'JO', 'KW', 'LY', 'OM', 'QA', 'SD', 'SY']);

/** 0 (Sunday), 1 (Monday) or 6 (Saturday). setting: 'auto' | 'sunday' | 'monday'. */
export function weekStartFor(setting = 'auto', locale = globalThis.navigator?.language) {
  if (setting === 'sunday') return 0;
  if (setting === 'monday') return 1;
  try {
    const parsed = new Intl.Locale(locale || 'en-US');
    const info = typeof parsed.getWeekInfo === 'function' ? parsed.getWeekInfo() : parsed.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
    const region = parsed.region || parsed.maximize?.().region || '';
    if (SUNDAY_REGIONS.has(region)) return 0;
    if (SATURDAY_REGIONS.has(region)) return 6;
  } catch { /* fall through */ }
  return 1;
}

/**
 * Six weeks of days around a month: [[{ date, key, day, inMonth, weekend, today }] x 7] x 6.
 * Six rows always, so the widget keeps its height while paging through months.
 */
export function monthGrid(year, month, weekStart = 1, today = new Date()) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const start = addDays(first, -lead);
  const todayKey = dayKey(today);
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(start, w * 7 + d);
      const key = dayKey(date);
      week.push({ date, key, day: date.getDate(), inMonth: date.getMonth() === month, weekend: date.getDay() === 0 || date.getDay() === 6, today: key === todayKey });
    }
    weeks.push(week);
  }
  return weeks;
}

/** ISO 8601 week number of a local date. */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
}

/** Weekday names in grid order: [{ short: 'M', long: 'Monday', abbr: 'Mon', weekend }]. */
export function weekdayNames(weekStart = 1, locale) {
  const long = new Intl.DateTimeFormat(locale || undefined, { weekday: 'long' });
  const abbr = new Intl.DateTimeFormat(locale || undefined, { weekday: 'short' });
  const narrow = new Intl.DateTimeFormat(locale || undefined, { weekday: 'narrow' });
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(2023, 0, 1 + ((weekStart + i) % 7));
    return { short: narrow.format(date), abbr: abbr.format(date), long: long.format(date), weekend: date.getDay() === 0 || date.getDay() === 6 };
  });
}

/**
 * Groups timed or all-day entries ({ start, end, allDay, ... } in ms) by the local days they touch within
 * [firstDay, lastDay] (Dates): Map(dayKey -> entries). An entry ending exactly at midnight does not spill into the
 * next day; multi-day entries appear on every day they cover (capped at 62 days).
 */
export function bucketByDay(entries, firstDay, lastDay) {
  const map = new Map();
  const lastKey = dayKey(lastDay);
  const firstKey = dayKey(firstDay);
  for (const entry of entries || []) {
    let day = new Date(entry.start);
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const endMs = Math.max(entry.start, (entry.end ?? entry.start) - 1);
    for (let i = 0; i < 62 && day.getTime() <= endMs; i++, day = addDays(day, 1)) {
      const key = dayKey(day);
      if (key > lastKey) break;
      if (key < firstKey) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(entry);
    }
  }
  for (const list of map.values()) list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start);
  return map;
}

/** Arrow-key movement inside the grid: { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } (RTL flips left/right). */
export function keyDelta(key, rtl = false) {
  const map = { ArrowLeft: rtl ? 1 : -1, ArrowRight: rtl ? -1 : 1, ArrowUp: -7, ArrowDown: 7 };
  return map[key] ?? 0;
}
