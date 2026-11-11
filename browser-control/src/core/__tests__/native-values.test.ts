import { describe, expect, it } from 'vitest';
import { describeValidity, parseNumber, rangeLimits, validateNativeValue } from '../interaction/native-values';
import type { NativeLimits, NativeType } from '../interaction/native-values';

const none: NativeLimits = { min: '', max: '', step: '' };
const ok = (type: NativeType, value: string, limits = none) => validateNativeValue(type, value, limits);

describe('validateNativeValue', () => {
  it('accepts real dates and refuses other formats, naming the expected one', () => {
    expect(ok('date', '2026-10-04')).toEqual({ ok: true, value: '2026-10-04' });
    expect(ok('date', '2028-02-29').ok).toBe(true);
    for (const bad of ['06/12/2025', '2026-13-01', '2026-02-30', '2027-02-29', '2026-1-5', 'tomorrow', '']) {
      const r = ok('date', bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.expected).toContain('YYYY-MM-DD');
    }
  });

  it('checks time, with optional seconds and a 24-hour clock', () => {
    for (const good of ['00:00', '14:30', '23:59:59', '09:05:07.250']) expect(ok('time', good).ok, good).toBe(true);
    for (const bad of ['24:00', '9:30', '14:60', '14:30:61', '2:30 PM']) expect(ok('time', bad).ok, bad).toBe(false);
  });

  it('checks datetime-local', () => {
    expect(ok('datetime-local', '2026-10-04T14:30').ok).toBe(true);
    expect(ok('datetime-local', '2026-10-04T14:30:15').ok).toBe(true);
    for (const bad of ['2026-10-04', '2026-10-04 14:30', '2026-10-04T25:00', '2026-02-31T10:00']) {
      expect(ok('datetime-local', bad).ok, bad).toBe(false);
    }
  });

  it('checks month and ISO week, including the 53-week years', () => {
    expect(ok('month', '2026-10').ok).toBe(true);
    expect(ok('month', '2026-13').ok).toBe(false);
    expect(ok('month', '2026-1').ok).toBe(false);
    expect(ok('week', '2026-W41').ok).toBe(true);
    expect(ok('week', '2026-W53').ok).toBe(true); // 2026 begins on a Thursday
    expect(ok('week', '2025-W53').ok).toBe(false);
    expect(ok('week', '2026-W00').ok).toBe(false);
    expect(ok('week', '2026-41').ok).toBe(false);
  });

  it('checks colours and lowercases them, as the input holds them', () => {
    expect(ok('color', '#1A2B3C')).toEqual({ ok: true, value: '#1a2b3c' });
    for (const bad of ['red', '#fff', '1a2b3c', '#1a2b3g', 'rgb(1,2,3)']) expect(ok('color', bad).ok, bad).toBe(false);
  });

  it('checks a range value against min and max, with the browser defaults 0 and 100', () => {
    const limits = { min: '0', max: '10', step: '' };
    expect(ok('range', '8', limits)).toEqual({ ok: true, value: '8' });
    expect(ok('range', '7.5', limits)).toEqual({ ok: true, value: '7.5' });
    const high = ok('range', '11', limits);
    expect(high.ok).toBe(false);
    if (!high.ok) expect(high.expected).toBe('a number between 0 and 10');
    expect(ok('range', 'abc', limits).ok).toBe(false);
    expect(ok('range', '50').ok).toBe(true);
    expect(ok('range', '101').ok).toBe(false);
  });
});

describe('numbers and range limits', () => {
  it('parses only plain numbers', () => {
    expect(parseNumber('12')).toBe(12);
    expect(parseNumber(' -3.5 ')).toBe(-3.5);
    expect(parseNumber('1e2')).toBe(100);
    expect(parseNumber('12px')).toBeNull();
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('Infinity')).toBeNull();
  });

  it('defaults and sanitises the bounds', () => {
    expect(rangeLimits({ min: '', max: '', step: '' })).toEqual({ min: 0, max: 100, step: 1 });
    expect(rangeLimits({ min: '5', max: '2', step: 'any' })).toEqual({ min: 5, max: 5, step: 0 });
  });
});

describe('describeValidity', () => {
  it('reports validity and the constraint flags', () => {
    expect(describeValidity('date', '2026-10-04', '2026-10-04', { valid: true, flags: [], message: '' })).toBe('valid');
    expect(
      describeValidity('date', '2026-10-04', '2026-10-04', {
        valid: false,
        flags: ['rangeUnderflow'],
        message: 'Value must be 2027-01-01 or later.',
      }),
    ).toBe('invalid (rangeUnderflow: Value must be 2027-01-01 or later.)');
  });

  it('says where a range landed when it is not where it was asked', () => {
    const text = describeValidity('range', '7.5', '8', { valid: true, flags: [], message: '' });
    expect(text).toContain('snapped to 8');
    expect(describeValidity('range', '8', '8', null)).toBe('');
  });
});
