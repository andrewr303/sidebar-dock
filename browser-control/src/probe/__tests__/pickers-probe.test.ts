import { describe, expect, it } from 'vitest';
import { PROBE_SOURCE } from '../index';
import type { ComboFacts, EditorFacts, NativeFacts, PopupFacts, SliderAria } from '../index';

// The probe runs against hand-made elements here; what needs a real DOM (focus, selection, layout) is covered by the
// autorun scenarios on the fixture pages.
const scope = {
  ShadowRoot: class FakeShadowRoot {},
  document: { activeElement: null, querySelectorAll: () => [] },
} as unknown as Record<string, unknown>;
new Function('globalThis', 'document', 'ShadowRoot', PROBE_SOURCE)(scope, scope.document, scope.ShadowRoot);
const probe = scope.__nbProbe as {
  sliderAria(el: unknown): SliderAria;
  nativeFacts(el: unknown): NativeFacts;
  comboFacts(el: unknown): ComboFacts;
  popupFacts(el: unknown): PopupFacts;
  editorFacts(el: unknown): EditorFacts;
  editorInput(el: unknown): unknown;
};

interface FakeOptions {
  tagName?: string;
  attrs?: Record<string, string>;
  props?: Record<string, unknown>;
  ids?: Record<string, unknown>;
  closest?: Record<string, unknown>;
  query?: Record<string, unknown>;
}

/** An element as the probe reads it: attributes, a few properties, the ids of its root and what closest and querySelector find. */
function fake(o: FakeOptions = {}) {
  const attrs = o.attrs ?? {};
  const el: Record<string, unknown> = {
    tagName: o.tagName ?? 'DIV',
    innerText: '',
    textContent: '',
    getAttribute: (k: string) => attrs[k] ?? null,
    hasAttribute: (k: string) => k in attrs,
    getRootNode: () => ({ getElementById: (id: string) => o.ids?.[id] ?? null }),
    closest: (selector: string) =>
      Object.entries(o.closest ?? {}).find(([key]) => selector.split(', ').includes(key))?.[1] ?? null,
    querySelector: (selector: string) => {
      const hit = Object.entries(o.query ?? {}).find(([key]) => selector.split(', ').includes(key));
      return hit ? hit[1] : null;
    },
    matches: () => false,
    getClientRects: () => [{}],
    ...o.props,
  };
  return el;
}

describe('sliderAria', () => {
  it('reads the bounds, value, step and orientation, with the ARIA defaults', () => {
    const slider = fake({
      attrs: { role: 'slider', 'aria-valuemin': '10', 'aria-valuemax': '50', 'aria-valuenow': '20', 'data-step': '5' },
    });
    expect(probe.sliderAria(slider)).toMatchObject({ min: 10, max: 50, now: 20, step: 5, vertical: false });
    const bare = probe.sliderAria(fake({ attrs: { role: 'slider', 'aria-orientation': 'vertical' } }));
    expect(bare).toMatchObject({ min: 0, max: 100, now: null, step: null, vertical: true });
  });

  it('reports read-only and the value text', () => {
    const s = probe.sliderAria(
      fake({ attrs: { 'aria-readonly': 'true', 'aria-valuenow': 'abc', 'aria-valuetext': 'medium' } }),
    );
    expect(s).toMatchObject({ readOnly: true, now: null, text: 'medium' });
  });
});

describe('nativeFacts', () => {
  it('reports the limits and the constraint flags that are set', () => {
    const input = fake({
      tagName: 'INPUT',
      attrs: { min: '2027-01-01' },
      props: {
        type: 'date',
        value: '2026-10-04',
        validationMessage: 'Value must be 2027-01-01 or later.',
        validity: { valid: false, rangeUnderflow: true, badInput: false },
      },
    });
    expect(probe.nativeFacts(input)).toMatchObject({
      type: 'date',
      min: '2027-01-01',
      max: '',
      value: '2026-10-04',
      valid: false,
      flags: ['rangeUnderflow'],
    });
  });
});

describe('comboFacts', () => {
  it('knows role=combobox, aria-haspopup=listbox and a listbox role', () => {
    expect(probe.comboFacts(fake({ attrs: { role: 'combobox' } })).kind).toBe('combobox');
    expect(probe.comboFacts(fake({ tagName: 'BUTTON', attrs: { 'aria-haspopup': 'listbox' } })).kind).toBe('combobox');
    expect(probe.comboFacts(fake({ attrs: { role: 'listbox' } })).kind).toBe('listbox');
    expect(probe.comboFacts(fake({ tagName: 'BUTTON', attrs: { 'aria-haspopup': 'menu' } })).kind).toBeNull();
  });

  it('knows a control whose aria-controls names a listbox, and an input that declares a popup state', () => {
    const list = fake({ attrs: { role: 'listbox' } });
    expect(probe.comboFacts(fake({ tagName: 'BUTTON', attrs: { 'aria-controls': 'l' }, ids: { l: list } })).kind).toBe(
      'combobox',
    );
    expect(
      probe.comboFacts(
        fake({ tagName: 'INPUT', attrs: { 'aria-controls': 'x', 'aria-expanded': 'false' }, props: { value: '' } }),
      ).kind,
    ).toBe('combobox');
    expect(
      probe.comboFacts(fake({ tagName: 'INPUT', attrs: { 'aria-controls': 'x' }, props: { value: '' } })).kind,
    ).toBeNull();
    expect(probe.comboFacts(fake({ tagName: 'BUTTON', attrs: { 'aria-controls': 'x' } })).kind).toBeNull();
  });

  it('says whether it takes typing and whether it is expanded', () => {
    const input = probe.comboFacts(
      fake({
        tagName: 'INPUT',
        attrs: { role: 'combobox', 'aria-expanded': 'true' },
        props: { value: ' Fra  nce ', readOnly: false, disabled: false },
      }),
    );
    expect(input).toMatchObject({ kind: 'combobox', typed: true, expanded: true, text: 'Fra nce' });
    const readonly = probe.comboFacts(
      fake({ tagName: 'INPUT', attrs: { role: 'combobox' }, props: { value: 'x', readOnly: true } }),
    );
    expect(readonly.typed).toBe(false);
  });

  it('leaves a native select to the native path', () => {
    expect(probe.comboFacts(fake({ tagName: 'SELECT', attrs: { role: 'combobox' } })).kind).toBeNull();
  });
});

describe('popupFacts', () => {
  const option = (name: string, extra: Record<string, string> = {}) =>
    fake({ attrs: { role: 'option', ...extra }, props: { innerText: name, textContent: name } });

  it('finds the popup by aria-controls and reads the options with their selected and disabled state', () => {
    const options = [option('France', { 'aria-selected': 'true' }), option('Spain', { 'aria-disabled': 'true' })];
    const popup = fake({ attrs: { role: 'listbox' }, props: { querySelectorAll: () => options } });
    const control = fake({ attrs: { role: 'combobox', 'aria-controls': 'p' }, ids: { p: popup } });
    const facts = probe.popupFacts(control);
    expect(facts).toMatchObject({ found: true, via: 'aria-controls', total: 2 });
    expect(facts.options.map(o => [o.name, o.selected, o.disabled])).toEqual([
      ['France', true, false],
      ['Spain', false, true],
    ]);
  });

  it('is not found while the popup is hidden', () => {
    const popup = fake({
      attrs: { role: 'listbox' },
      props: { getClientRects: () => [], querySelectorAll: () => [] },
    });
    const control = fake({ attrs: { role: 'combobox', 'aria-controls': 'p' }, ids: { p: popup } });
    expect(probe.popupFacts(control)).toMatchObject({ found: false, via: 'none', total: 0 });
  });

  it('uses the control itself when it is a visible listbox, and aria-activedescendant otherwise', () => {
    const own = fake({ attrs: { role: 'listbox' }, props: { querySelectorAll: () => [option('One')] } });
    expect(probe.popupFacts(own)).toMatchObject({ found: true, via: 'self', total: 1 });
    const owner = fake({ attrs: { role: 'listbox' }, props: { querySelectorAll: () => [option('Two')] } });
    const active = fake({ closest: { '[role=listbox]': owner } });
    const control = fake({ attrs: { role: 'combobox', 'aria-activedescendant': 'a' }, ids: { a: active } });
    expect(probe.popupFacts(control)).toMatchObject({ found: true, via: 'aria-activedescendant', total: 1 });
  });
});

describe('editorFacts', () => {
  it('finds no editor around a plain input or textarea', () => {
    const input = fake({ tagName: 'INPUT' });
    expect(probe.editorFacts(input)).toEqual({ family: null, isInput: true, hiddenInput: false });
    expect(probe.editorInput(input)).toBe(input);
  });

  it('names the family from the markup and resolves the real input', () => {
    const pm = fake({ attrs: { contenteditable: 'true' } });
    (pm.matches as unknown) = (s: string) => s === '.ProseMirror';
    const inside = fake({ closest: { '.ProseMirror': pm } });
    expect(probe.editorFacts(pm)).toMatchObject({ family: null });
    // The closest match is the editor root; the probe resolves it as the input.
    const found = fake({ closest: { '.ProseMirror': pm } });
    expect(probe.editorFacts(found)).toMatchObject({ family: 'prosemirror', isInput: false, hiddenInput: false });
    expect(probe.editorInput(inside)).toBe(pm);
  });

  it('resolves Monaco to its hidden textarea and CodeMirror to its content element', () => {
    const textarea = fake({ tagName: 'TEXTAREA' });
    const monaco = fake();
    (monaco.matches as unknown) = (s: string) => s === '.monaco-editor';
    (monaco.querySelector as unknown) = (s: string) => (s.includes('textarea') ? textarea : null);
    const viaWrapper = fake({ closest: { '.monaco-editor': monaco } });
    expect(probe.editorFacts(viaWrapper)).toMatchObject({ family: 'monaco', isInput: false, hiddenInput: true });
    expect(probe.editorInput(viaWrapper)).toBe(textarea);

    const content = fake();
    (content.matches as unknown) = (s: string) => s.split(', ').includes('.cm-content');
    const cm = fake({ closest: { '.cm-content': content } });
    expect(probe.editorFacts(cm)).toMatchObject({ family: 'codemirror', isInput: false });
    expect(probe.editorInput(cm)).toBe(content);
  });
});
