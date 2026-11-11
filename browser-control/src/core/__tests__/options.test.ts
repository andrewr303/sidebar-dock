import { describe, expect, it } from 'vitest';
import { listOptions, matchOption, MAX_SLIDER_KEYS, planSlider } from '../interaction/options';
import type { PopupOption, SliderFacts } from '../interaction/options';

const option = (index: number, name: string, extra: Partial<PopupOption> = {}): PopupOption => ({
  index,
  name,
  value: '',
  selected: false,
  disabled: false,
  ...extra,
});

describe('matchOption', () => {
  const list = [option(0, 'France'), option(1, 'Germany'), option(2, 'United  Kingdom'), option(3, 'Spain')];

  it('matches the accessible name exactly, ignoring runs of whitespace', () => {
    expect(matchOption(list, 'France')).toMatchObject({ kind: 'one', tier: 'exact', option: { index: 0 } });
    expect(matchOption(list, ' United Kingdom ')).toMatchObject({ kind: 'one', tier: 'exact', option: { index: 2 } });
  });

  it('falls back to a case-insensitive match', () => {
    expect(matchOption(list, 'germany')).toMatchObject({ kind: 'one', tier: 'case-insensitive', option: { index: 1 } });
  });

  it('prefers the exact match when a case-insensitive one would be ambiguous', () => {
    const both = [option(0, 'Apple'), option(1, 'apple')];
    expect(matchOption(both, 'Apple')).toMatchObject({ kind: 'one', tier: 'exact', option: { index: 0 } });
    const same = matchOption(both, 'APPLE');
    expect(same.kind).toBe('ambiguous');
  });

  it('is ambiguous with the candidates when several options share the name', () => {
    const dup = [option(0, 'Standard'), option(1, 'Premium'), option(2, 'Standard')];
    const r = matchOption(dup, 'Standard');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates.map(c => c.index)).toEqual([0, 2]);
  });

  it('matches a value attribute last', () => {
    const coded = [option(0, 'United Kingdom', { value: 'gb' }), option(1, 'France', { value: 'fr' })];
    expect(matchOption(coded, 'fr')).toMatchObject({ kind: 'one', tier: 'value', option: { index: 1 } });
    expect(matchOption(coded, 'Atlantis')).toEqual({ kind: 'none' });
  });

  it('still finds a disabled option, so the error can say it is disabled', () => {
    const r = matchOption([option(0, 'Sold out', { disabled: true })], 'Sold out');
    expect(r).toMatchObject({ kind: 'one', option: { disabled: true } });
  });
});

describe('listOptions', () => {
  it('lists names and marks disabled ones', () => {
    expect(listOptions([option(0, 'A'), option(1, 'B', { disabled: true })], n => `«${n}»`)).toBe(
      '«A»; «B» (disabled)',
    );
  });

  it('cuts a long list and says so', () => {
    const many = Array.from({ length: 45 }, (_, i) => option(i, `Item ${i}`));
    const text = listOptions(many, n => n);
    expect(text).toContain('Item 29');
    expect(text).not.toContain('Item 30;');
    expect(text).toContain('and 15 more');
  });
});

describe('planSlider', () => {
  const base: SliderFacts = { min: 0, max: 100, now: 50, step: null, vertical: false, readOnly: false };
  const plan = (facts: Partial<SliderFacts>, wanted: number) => planSlider({ ...base, ...facts }, wanted);

  it('does nothing when the slider is already at the value', () => {
    expect(plan({}, 50)).toEqual({ keys: [], arrows: 0, how: 'already at the value' });
  });

  it('uses Home and End for the bounds', () => {
    expect(plan({}, 0)).toMatchObject({ keys: ['Home'] });
    expect(plan({}, 100)).toMatchObject({ keys: ['End'] });
  });

  it('uses arrow keys for a short move, in the direction of the value', () => {
    expect(plan({}, 53)).toMatchObject({ keys: ['ArrowRight', 'ArrowRight', 'ArrowRight'], arrows: 3 });
    expect(plan({}, 48)).toMatchObject({ keys: ['ArrowLeft', 'ArrowLeft'], arrows: 2 });
    expect(plan({ vertical: true }, 52)).toMatchObject({ keys: ['ArrowUp', 'ArrowUp'] });
  });

  it('goes through a bound when that is shorter', () => {
    const r = plan({ now: 10 }, 97);
    expect(r).toMatchObject({ arrows: 3 });
    if ('keys' in r) expect(r.keys).toEqual(['End', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft']);
    const low = plan({ now: 90 }, 2);
    if ('keys' in low) expect(low.keys).toEqual(['Home', 'ArrowRight', 'ArrowRight']);
  });

  it('uses the declared step', () => {
    const r = plan({ step: 10, now: 20 }, 50);
    expect(r).toMatchObject({ arrows: 3 });
    expect(plan({ step: 10, now: 20 }, 55)).toHaveProperty('error');
  });

  it('refuses a value out of range, an unknown start, and a move longer than the bound', () => {
    expect(plan({}, 101)).toHaveProperty('error');
    expect(plan({}, -1)).toHaveProperty('error');
    expect(plan({ now: null }, 20)).toHaveProperty('error');
    const wide = plan({ min: 0, max: 1000, now: 500 }, 250);
    expect(wide).toHaveProperty('error');
    if ('error' in wide) expect(wide.error).toContain(String(MAX_SLIDER_KEYS));
  });
});
