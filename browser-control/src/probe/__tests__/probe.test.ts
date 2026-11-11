import { describe, expect, it } from 'vitest';
import { PROBE_SOURCE } from '../index';

describe('probe string', () => {
  it('is self-contained: it runs with nothing from the module in scope', () => {
    const scope = {} as Record<string, unknown>;
    // Evaluate with a fresh global object, as the isolated world would; no DOM APIs are needed to install.
    new Function('globalThis', PROBE_SOURCE)(scope);
    const probe = scope.__nbProbe as { version: number; mutations(): number };
    expect(probe.version).toBe(1);
    expect(probe.mutations()).toBe(0);
  });

  it('installs once and cannot be replaced by later scripts in the same world', () => {
    const scope = {} as Record<string, unknown>;
    new Function('globalThis', PROBE_SOURCE)(scope);
    const first = scope.__nbProbe;
    new Function('globalThis', PROBE_SOURCE)(scope);
    expect(scope.__nbProbe).toBe(first);
    expect(() => {
      'use strict';
      (scope as { __nbProbe: unknown }).__nbProbe = 1;
    }).toThrow();
  });
});

describe('approximateName, the classifier’s fallback name', () => {
  const scope = {} as Record<string, unknown>;
  new Function('globalThis', PROBE_SOURCE)(scope);
  const probe = scope.__nbProbe as { approximateName(el: unknown): string };
  /** An element as approximateName reads it: tag, type, value, rendered text and attributes; no labels. */
  const element = (tagName: string, props: Record<string, unknown>, attrs: Record<string, string> = {}) => ({
    tagName,
    innerText: '',
    labels: [],
    getAttribute: (name: string) => attrs[name] ?? null,
    ...props,
  });

  it('never names a control that holds a value by what it holds', () => {
    expect(probe.approximateName(element('INPUT', { type: 'password', value: 'hunter2' }))).toBe('');
    expect(probe.approximateName(element('INPUT', { type: 'text', value: '4111111111111111' }))).toBe('');
    expect(probe.approximateName(element('SELECT', { innerText: '4111 1111 1111 1111', value: 'c1' }))).toBe('');
    expect(probe.approximateName(element('TEXTAREA', { innerText: '654321', value: '654321' }))).toBe('');
    expect(
      probe.approximateName(element('INPUT', { type: 'password', value: 'hunter2' }, { 'aria-label': 'Password' })),
    ).toBe('Password');
  });

  it('still names buttons by their text or caption', () => {
    expect(probe.approximateName(element('INPUT', { type: 'submit', value: 'Pay now' }))).toBe('Pay now');
    expect(probe.approximateName(element('BUTTON', { innerText: 'Delete', value: '' }))).toBe('Delete');
  });
});

describe('probe state, selectOption, selectContents, setNativeValue, and scrollInfo', () => {
  const scope = {
    ShadowRoot: class FakeShadowRoot {},
    document: {
      activeElement: null,
      execCommand: () => true,
      scrollingElement: {
        nodeType: 1,
        scrollTop: 240,
        scrollLeft: 0,
        scrollHeight: 2000,
        scrollWidth: 800,
        clientHeight: 600,
        clientWidth: 800,
      },
    },
  } as unknown as Record<string, unknown>;
  new Function('globalThis', 'document', 'ShadowRoot', PROBE_SOURCE)(scope, scope.document, scope.ShadowRoot);
  const probe = scope.__nbProbe as {
    state(el: unknown): { expanded: boolean | null };
    selectOption(el: unknown, values: string[]): { ok: boolean; error?: string; selected: string[] };
    selectContents(el: unknown): boolean;
    setNativeValue(el: unknown, value: string): string;
    scrollInfo(el: unknown): { top: number; height: number; clientHeight: number };
  };

  it('reports expanded state from <details open> and aria-expanded', () => {
    const base = (tagName: string, attrs: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
      tagName,
      isConnected: true,
      id: '',
      parentNode: null,
      getAttribute: (k: string) => attrs[k] ?? null,
      hasAttribute: (k: string) => k in attrs,
      getRootNode: () => ({ activeElement: null }),
      ...extra,
    });
    expect(probe.state(base('BUTTON', { 'aria-expanded': 'true' })).expanded).toBe(true);
    expect(probe.state(base('BUTTON', { 'aria-expanded': 'false' })).expanded).toBe(false);
    expect(probe.state(base('BUTTON')).expanded).toBeNull();
    expect(probe.state(base('DETAILS', {}, { open: true })).expanded).toBe(true);
    expect(probe.state(base('DETAILS', {}, { open: false })).expanded).toBe(false);
  });

  it('matches select options case-insensitively by value or label when exact matches miss', () => {
    const opts = [
      { index: 0, value: 'us-east-1', label: 'US East (N. Virginia)', text: '', selected: false },
      { index: 1, value: 'eu-west-1', label: 'Europe (Ireland)', text: '', selected: false },
    ];
    const select = {
      multiple: false,
      options: opts,
      get selectedOptions() {
        return opts.filter(o => o.selected);
      },
      dispatchEvent: () => true,
    };
    const res = probe.selectOption(select, ['US-EAST-1']);
    expect(res.ok).toBe(true);
    expect(res.selected).toEqual(['US East (N. Virginia)']);
    const byLabel = probe.selectOption(select, ['  europe (ireland) ']);
    expect(byLabel.ok).toBe(true);
    expect(byLabel.selected).toEqual(['Europe (Ireland)']);
    const missing = probe.selectOption(select, ['ap-south-1']);
    expect(missing).toMatchObject({ ok: false, error: 'NO_SUCH_OPTION' });
  });

  it('ensures full selection range in selectContents and tolerates inputs without selection ranges', () => {
    let rangeSet: [number, number] | null = null;
    const input = {
      tagName: 'INPUT',
      value: 'hello world',
      selectionStart: 0,
      selectionEnd: 5,
      select() {},
      setSelectionRange(s: number, e: number) {
        rangeSet = [s, e];
      },
    };
    expect(probe.selectContents(input)).toBe(true);
    expect(rangeSet).toEqual([0, 11]);

    const emailInput = {
      tagName: 'INPUT',
      value: 'a@b.co',
      selectionStart: 0,
      selectionEnd: 1,
      select() {},
      setSelectionRange() {
        throw new Error('InvalidStateError');
      },
    };
    expect(probe.selectContents(emailInput)).toBe(true);
  });

  it('updates React _valueTracker in setNativeValue before dispatching events', () => {
    const events: string[] = [];
    let tracked: string | null = null;
    const input = {
      value: '10',
      _valueTracker: {
        setValue(v: string) {
          tracked = v;
        },
      },
      dispatchEvent(e: Event) {
        events.push(e.type);
        return true;
      },
    };
    expect(probe.setNativeValue(input, '42')).toBe('42');
    expect(tracked).toBe('10');
    expect(events).toEqual(['input', 'change']);
  });

  it('walks to the nearest scrollable ancestor in scrollInfo when the target element itself is not scrollable', () => {
    const ancestor = {
      nodeType: 1,
      parentNode: null,
      scrollTop: 180,
      scrollLeft: 0,
      scrollHeight: 1200,
      scrollWidth: 400,
      clientHeight: 300,
      clientWidth: 400,
    };
    const item = {
      nodeType: 1,
      parentNode: ancestor,
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 40,
      scrollWidth: 400,
      clientHeight: 40,
      clientWidth: 400,
    };
    expect(probe.scrollInfo(item)).toMatchObject({ top: 180, height: 1200, clientHeight: 300 });
    expect(probe.scrollInfo(ancestor)).toMatchObject({ top: 180, height: 1200, clientHeight: 300 });
  });

  it('includes aria-invalid error messages and open menu/popover layers in pageFacts', () => {
    const hiddenHint = {
      tagName: 'SPAN',
      getAttribute: () => null,
      getClientRects: () => [],
    };
    const errNode = {
      tagName: 'SPAN',
      getAttribute: () => null,
      getClientRects: () => [{}],
    };
    const ariaField = {
      tagName: 'INPUT',
      type: 'text',
      labels: [],
      getClientRects: () => [{}],
      getAttribute: (k: string) =>
        k === 'aria-invalid'
          ? 'true'
          : k === 'aria-describedby'
            ? 'hidden-hint err-msg'
            : k === 'aria-label'
              ? 'Email'
              : null,
      hasAttribute: (k: string) => k === 'aria-invalid' || k === 'aria-describedby' || k === 'aria-label',
    };
    const editableField = {
      tagName: 'DIV',
      isContentEditable: true,
      innerText: 'My secret draft',
      getClientRects: () => [{}],
      getAttribute: (k: string) => (k === 'aria-invalid' ? 'true' : k === 'contenteditable' ? 'true' : null),
      hasAttribute: (k: string) => k === 'aria-invalid' || k === 'contenteditable',
    };
    const menuLayer = {
      tagName: 'DIV',
      getClientRects: () => [{}],
      getAttribute: (k: string) => (k === 'role' ? 'menu' : k === 'aria-label' ? 'Actions' : null),
      hasAttribute: (k: string) => k === 'role' || k === 'aria-label',
      matches: (sel: string) => sel.includes('[role=menu]'),
    };
    const closedPopover = {
      tagName: 'DIV',
      getClientRects: () => [{}],
      getAttribute: (k: string) => (k === 'popover' ? 'auto' : null),
      hasAttribute: (k: string) => k === 'popover',
      matches: () => false,
    };
    const doc = {
      querySelectorAll(sel: string) {
        if (sel.includes('[role=alert]')) return [];
        if (sel === ':invalid') return [];
        if (sel === '[aria-invalid=true]') return [ariaField, editableField];
        if (sel.includes('dialog[open]')) return [menuLayer, closedPopover];
        return [];
      },
      getElementById(id: string) {
        return id === 'hidden-hint' ? hiddenHint : id === 'err-msg' ? errNode : null;
      },
      createTreeWalker(root: unknown) {
        let done = false;
        return {
          nextNode() {
            if (done) return null;
            done = true;
            return root === errNode ? { nodeValue: 'Enter a valid email address' } : null;
          },
        };
      },
    };
    const factsScope = {
      ShadowRoot: class FakeShadowRoot {},
      NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
      Node: { ELEMENT_NODE: 1 },
      document: doc,
    } as unknown as Record<string, unknown>;
    new Function('globalThis', 'document', 'ShadowRoot', 'NodeFilter', 'Node', PROBE_SOURCE)(
      factsScope,
      factsScope.document,
      factsScope.ShadowRoot,
      factsScope.NodeFilter,
      factsScope.Node,
    );
    const factsProbe = factsScope.__nbProbe as {
      pageFacts(): { alerts: string[]; invalid: string[]; layers: string[] };
    };
    expect(factsProbe.pageFacts()).toEqual({
      alerts: [],
      invalid: ['Enter a valid email address', 'invalid field'],
      layers: ['menu "Actions"'],
    });
  });
});
