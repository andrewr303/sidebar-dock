// Native date, time, colour and range inputs: a requested value is checked against the type's format before anything is
// dispatched. The browser would silently turn a value in another format into '' (or clamp it), and the read-back could
// then only say "unmet" without saying what the field takes.

export type NativeType = 'date' | 'time' | 'datetime-local' | 'month' | 'week' | 'color' | 'range';

/** The attributes of the input that limit its value, as the probe reads them (strings as written; '' when absent). */
export interface NativeLimits {
  min: string;
  max: string;
  step: string;
}

export type NativeCheck = { ok: true; value: string } | { ok: false; expected: string };

/** What each type takes, with an example, for the error that names the expected format. */
export const NATIVE_FORMAT: Record<NativeType, string> = {
  date: 'YYYY-MM-DD, for example 2026-10-04',
  time: 'HH:MM or HH:MM:SS in 24-hour time, for example 14:30',
  'datetime-local': 'YYYY-MM-DDTHH:MM, for example 2026-10-04T14:30',
  month: 'YYYY-MM, for example 2026-10',
  week: 'YYYY-Www, for example 2026-W41',
  color: '#rrggbb, for example #1a2b3c',
  range: 'a number',
};

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y: number, m: number) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

function validDate(text: string): boolean {
  const m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

function validTime(text: string): boolean {
  const m = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/.exec(text);
  return !!m && Number(m[1]) < 24 && Number(m[2]) < 60 && (m[3] === undefined || Number(m[3]) < 60);
}

/** ISO weeks: a year has 53 when 1 January is a Thursday, or a Wednesday in a leap year. */
function weeksInYear(y: number): number {
  const jan1 = new Date(Date.UTC(2000, 0, 1));
  jan1.setUTCFullYear(y);
  const day = jan1.getUTCDay();
  return day === 4 || (day === 3 && isLeap(y)) ? 53 : 52;
}

function validWeek(text: string): boolean {
  const m = /^(\d{4,})-W(\d{2})$/.exec(text);
  if (!m) return false;
  const [y, w] = [Number(m[1]), Number(m[2])];
  return y >= 1 && w >= 1 && w <= weeksInYear(y);
}

function validMonth(text: string): boolean {
  const m = /^(\d{4,})-(\d{2})$/.exec(text);
  return !!m && Number(m[1]) >= 1 && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

function validDateTime(text: string): boolean {
  const [date, time, ...rest] = text.split('T');
  return rest.length === 0 && time !== undefined && validDate(date) && validTime(time);
}

/** A number the way an input's attribute writes it: finite, no letters, no trailing garbage. */
export function parseNumber(text: string): number | null {
  if (!/^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** The bounds and step of a range input: the browser's defaults are 0, 100 and 1. */
export function rangeLimits(limits: NativeLimits): { min: number; max: number; step: number } {
  const min = parseNumber(limits.min) ?? 0;
  const max = parseNumber(limits.max) ?? 100;
  const step = limits.step === 'any' ? 0 : (parseNumber(limits.step) ?? 1);
  return { min, max: Math.max(min, max), step: step > 0 ? step : 0 };
}

/**
 * Checks a requested value against the format of an input type, before dispatch. A colour is lowercased (the input
 * holds lowercase); a range value must be a number between min and max. A value in range that does not fall on a step
 * is accepted: the browser snaps it, and the receipt reports where it landed.
 */
export function validateNativeValue(type: NativeType, value: string, limits: NativeLimits): NativeCheck {
  const bad = (expected: string): NativeCheck => ({ ok: false, expected });
  switch (type) {
    case 'date':
      return validDate(value) ? { ok: true, value } : bad(NATIVE_FORMAT.date);
    case 'time':
      return validTime(value) ? { ok: true, value } : bad(NATIVE_FORMAT.time);
    case 'datetime-local':
      return validDateTime(value) ? { ok: true, value } : bad(NATIVE_FORMAT['datetime-local']);
    case 'month':
      return validMonth(value) ? { ok: true, value } : bad(NATIVE_FORMAT.month);
    case 'week':
      return validWeek(value) ? { ok: true, value } : bad(NATIVE_FORMAT.week);
    case 'color':
      return /^#[0-9a-f]{6}$/i.test(value) ? { ok: true, value: value.toLowerCase() } : bad(NATIVE_FORMAT.color);
    case 'range': {
      const n = parseNumber(value);
      const { min, max } = rangeLimits(limits);
      if (n === null) return bad(`a number between ${min} and ${max}`);
      if (n < min || n > max) return bad(`a number between ${min} and ${max}`);
      return { ok: true, value: String(n) };
    }
  }
}

/** The element's constraint validity after the value was set, as the probe reports it. */
export interface NativeValidity {
  valid: boolean;
  /** Names of the constraint flags that are set (rangeUnderflow, rangeOverflow, stepMismatch, badInput, ...). */
  flags: string[];
  message: string;
}

/** A short phrase for the receipt: whether the field accepts the value and, for a range, where it landed. */
export function describeValidity(
  type: NativeType,
  requested: string,
  now: string,
  validity: NativeValidity | null,
): string {
  const parts: string[] = [];
  if (validity) {
    parts.push(
      validity.valid
        ? 'valid'
        : `invalid (${validity.flags.join(', ') || 'constraint'}${validity.message ? `: ${validity.message}` : ''})`,
    );
  }
  if (type === 'range') {
    const a = parseNumber(requested);
    const b = parseNumber(now);
    if (a !== null && b !== null && a !== b) parts.push(`clamped or snapped to ${now} (requested ${requested})`);
  }
  return parts.join('; ');
}
