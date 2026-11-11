import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROBE_SOURCE } from '../index';
import type { Obstruction } from '../index';

// The probe reads hand-made elements here: what each matches, its box and its attributes. How the signal appears on a
// real page (frames, layout, stacking) is covered by the autorun scenario on fixtures/pages/c-obstructions.html.

interface Fake {
  /** The selector fragments this element matches (`iframe`, `.g-recaptcha`, `dialog[open]`...). */
  sel?: string[];
  src?: string;
  rect?: { left: number; top: number; right: number; bottom: number };
  attrs?: Record<string, string>;
  text?: string;
  fixed?: boolean;
  hidden?: boolean;
  /** An ancestor the element sits in (`.grecaptcha-badge`). */
  inside?: string;
  inner?: Fake[];
  shadow?: Fake[];
}

const BOX = { left: 100, top: 100, right: 400, bottom: 178 };
const FULL = { left: 0, top: 0, right: 1000, bottom: 800 };

function build(f: Fake, parent: Record<string, unknown> | null = null): Record<string, unknown> {
  const rect = f.rect ?? BOX;
  const el: Record<string, unknown> = {
    src: f.src,
    parentElement: parent,
    innerText: f.text ?? '',
    textContent: f.text ?? '',
    hidden: f.hidden ?? false,
    fixed: f.fixed ?? false,
    getAttribute: (k: string) => f.attrs?.[k] ?? null,
    matches: (selector: string) => selector.split(',').some(t => (f.sel ?? []).includes(t.trim())),
    closest: (selector: string) => (f.inside && selector === f.inside ? {} : null),
    getBoundingClientRect: () => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top }),
    getClientRects: () => (rect.right > rect.left ? [{}] : []),
  };
  const inner = (f.inner ?? []).map(c => build(c, el));
  el.querySelectorAll = (selector: string) =>
    selector === '*' ? inner : inner.filter(i => (i.matches as (s: string) => boolean)(selector));
  el.shadowRoot = f.shadow ? { querySelectorAll: () => f.shadow!.map(c => build(c, null)) } : null;
  return el;
}

function run(page: Fake[]): Obstruction[] {
  const body = page.map(f => build(f));
  const scope = {
    ShadowRoot: class FakeShadowRoot {},
    document: {
      activeElement: null,
      querySelectorAll: (s: string) => (s === '*' ? body : []),
      body: { children: body },
    },
  } as unknown as Record<string, unknown>;
  new Function('globalThis', 'document', 'ShadowRoot', PROBE_SOURCE)(scope, scope.document, scope.ShadowRoot);
  return (scope.__nbProbe as { obstructions(): Obstruction[] }).obstructions();
}

beforeEach(() => {
  vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 });
  vi.stubGlobal('getComputedStyle', (e: { hidden: boolean; fixed: boolean }) => ({
    visibility: e.hidden ? 'hidden' : 'visible',
    display: 'block',
    opacity: '1',
    position: e.fixed ? 'fixed' : 'static',
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('obstructions: CAPTCHA widgets', () => {
  it('finds reCAPTCHA, hCaptcha and Turnstile frames by their address', () => {
    const found = run([
      { sel: ['iframe'], src: 'https://www.google.com/recaptcha/api2/anchor?k=1' },
      { sel: ['iframe'], src: 'https://newassets.hcaptcha.com/captcha/v1/hcaptcha.html' },
      { sel: ['iframe'], src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile' },
    ]);
    expect(found).toEqual([
      { kind: 'captcha', detail: 'reCAPTCHA' },
      { kind: 'captcha', detail: 'hCaptcha' },
      { kind: 'captcha', detail: 'Cloudflare Turnstile' },
    ]);
  });

  it('does not count the reCAPTCHA v3 badge, a hidden frame or an unrelated frame', () => {
    expect(
      run([
        { sel: ['iframe'], src: 'https://www.google.com/recaptcha/api2/anchor', inside: '.grecaptcha-badge' },
        { sel: ['iframe'], src: 'https://challenges.cloudflare.com/x', hidden: true },
        { sel: ['iframe'], src: 'https://challenges.cloudflare.com/y', rect: { left: 0, top: 0, right: 0, bottom: 0 } },
        { sel: ['iframe'], src: 'https://www.youtube.com/embed/1' },
      ]),
    ).toEqual([]);
  });

  it('finds a widget by its container, and a Cloudflare challenge page', () => {
    expect(run([{ sel: ['.h-captcha'] }, { sel: ['#challenge-running'] }])).toEqual([
      { kind: 'captcha', detail: 'hCaptcha' },
      { kind: 'captcha', detail: 'Cloudflare challenge' },
    ]);
  });

  it('searches open shadow roots', () => {
    expect(
      run([
        { sel: ['div'], shadow: [{ sel: ['iframe'], src: 'https://www.recaptcha.net/recaptcha/enterprise/anchor' }] },
      ]),
    ).toEqual([{ kind: 'captcha', detail: 'reCAPTCHA' }]);
  });
});

describe('obstructions: blocking layers and login walls', () => {
  it('calls a modal dialog with a password field a login wall', () => {
    const found = run([
      {
        sel: ['[aria-modal=true]'],
        attrs: { 'aria-modal': 'true', 'aria-label': 'Sign in' },
        inner: [{ sel: ['input[type=password]'] }],
      },
    ]);
    expect(found).toEqual([{ kind: 'login-wall', detail: 'Sign in' }]);
  });

  it('calls a full-viewport fixed overlay that asks to sign in with an email field a login wall', () => {
    const found = run([
      {
        fixed: true,
        rect: FULL,
        attrs: { 'aria-label': 'Join to read more' },
        text: 'Log in to continue reading',
        inner: [{ sel: ['input[type=email]'] }],
      },
    ]);
    expect(found).toEqual([{ kind: 'login-wall', detail: 'Join to read more' }]);
  });

  it('reports another modal dialog as a blocking modal, with its name', () => {
    const found = run([{ sel: ['dialog[open]', 'dialog:modal'], attrs: { 'aria-label': 'Delete project?' } }]);
    expect(found).toEqual([{ kind: 'modal', detail: 'Delete project?' }]);
  });

  it('leaves out a dialog that is not modal, a small fixed banner and a plain page', () => {
    expect(
      run([
        { sel: ['[role=dialog]'], attrs: { 'aria-label': 'Help' } },
        { fixed: true, rect: { left: 0, top: 700, right: 1000, bottom: 800 }, text: 'We use cookies' },
        { sel: ['main'], text: 'Hello' },
      ]),
    ).toEqual([]);
  });
});
