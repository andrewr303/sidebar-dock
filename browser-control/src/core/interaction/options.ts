// Custom comboboxes, listboxes and sliders: the rules that choose the option and the keys before anything is sent.
// The probe reads the popup's options and the slider's bounds; the choice is made here, over plain data.

/** An option of an open popup, as the probe reads it. */
export interface PopupOption {
  index: number;
  /** The accessible name: aria-label, aria-labelledby or the text, whitespace collapsed. */
  name: string;
  /** A data-value or value attribute, for a list whose visible text is not what a model would ask for. */
  value: string;
  selected: boolean;
  disabled: boolean;
}

export type OptionMatch =
  | { kind: 'one'; option: PopupOption; tier: 'exact' | 'case-insensitive' | 'value' }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: PopupOption[] };

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The option a requested value names: its accessible name exactly, then case-insensitively, then its value attribute.
 * A tier with one match decides; a tier with several is ambiguous (the candidates are listed and nothing is picked);
 * a tier with none passes to the next. A disabled option still matches, so the error can say it is disabled instead of
 * claiming it does not exist.
 */
export function matchOption(options: PopupOption[], requested: string): OptionMatch {
  const wanted = collapse(requested);
  const tiers: Array<['exact' | 'case-insensitive' | 'value', (o: PopupOption) => boolean]> = [
    ['exact', o => collapse(o.name) === wanted],
    ['case-insensitive', o => collapse(o.name).toLowerCase() === wanted.toLowerCase()],
    ['value', o => o.value !== '' && collapse(o.value) === wanted],
  ];
  for (const [tier, test] of tiers) {
    const found = options.filter(test);
    if (found.length === 1) return { kind: 'one', option: found[0], tier };
    if (found.length > 1) return { kind: 'ambiguous', candidates: found };
  }
  return { kind: 'none' };
}

/** The most options an error lists. */
export const LISTED_OPTIONS = 30;

/** Options as an error lists them: a name each, the first LISTED_OPTIONS, with the count when more were cut. */
export function listOptions(options: PopupOption[], quoteName: (name: string) => string): string {
  const shown = options.slice(0, LISTED_OPTIONS).map(o => `${quoteName(o.name)}${o.disabled ? ' (disabled)' : ''}`);
  const more = options.length - shown.length;
  return `${shown.join('; ')}${more > 0 ? `; … and ${more} more (the list was cut)` : ''}`;
}

/** An ARIA slider's bounds and value, as the probe reads them. */
export interface SliderFacts {
  min: number;
  max: number;
  now: number | null;
  /** The step the page declares (aria-valuestep or data-step), or null: the arrow key's step is then taken to be 1. */
  step: number | null;
  vertical: boolean;
  readOnly: boolean;
}

/** The most key presses one slider set sends. */
export const MAX_SLIDER_KEYS = 100;

export interface SliderPlan {
  /** The keys in order: an optional Home or End, then the arrow key `count` times. */
  keys: string[];
  /** Presses of the arrow key (the Home or End is not counted). */
  arrows: number;
  /** How the keys were chosen, for the receipt. */
  how: string;
}

/**
 * The keys that bring a slider from its value to the wanted one, worked out before any key is sent: Home or End when
 * the wanted value is a bound or when going through a bound is shorter, otherwise the arrow keys. The arrow's step is
 * the declared one, else 1. Returns an error text when the value is out of range, off the step, or too far for the
 * bounded count.
 */
export function planSlider(facts: SliderFacts, wanted: number): SliderPlan | { error: string } {
  const { min, max, now } = facts;
  if (now === null) return { error: 'it has no aria-valuenow to start from' };
  if (wanted < min || wanted > max) return { error: `the value must be between ${min} and ${max}` };
  const step = facts.step && facts.step > 0 ? facts.step : 1;
  const onStep = (v: number) => Math.abs((v - min) / step - Math.round((v - min) / step)) < 1e-9;
  if (wanted !== max && !onStep(wanted)) return { error: `the value must be ${min} plus a multiple of ${step}` };
  const up = facts.vertical ? 'ArrowUp' : 'ArrowRight';
  const down = facts.vertical ? 'ArrowDown' : 'ArrowLeft';
  const count = (from: number, to: number) => Math.round(Math.abs(to - from) / step);
  if (wanted === now) return { keys: [], arrows: 0, how: 'already at the value' };
  if (wanted === min) return { keys: ['Home'], arrows: 0, how: 'Home' };
  if (wanted === max) return { keys: ['End'], arrows: 0, how: 'End' };
  const direct = count(now, wanted);
  const viaMin = count(min, wanted);
  const viaMax = count(max, wanted);
  const best = Math.min(direct, viaMin, viaMax);
  if (best > MAX_SLIDER_KEYS) {
    return { error: `it would take ${best} key presses, more than the ${MAX_SLIDER_KEYS} allowed` };
  }
  if (best === direct) {
    const key = wanted > now ? up : down;
    return { keys: Array<string>(direct).fill(key), arrows: direct, how: `${direct} × ${key}` };
  }
  if (best === viaMin) {
    return { keys: ['Home', ...Array<string>(viaMin).fill(up)], arrows: viaMin, how: `Home, then ${viaMin} × ${up}` };
  }
  return { keys: ['End', ...Array<string>(viaMax).fill(down)], arrows: viaMax, how: `End, then ${viaMax} × ${down}` };
}
