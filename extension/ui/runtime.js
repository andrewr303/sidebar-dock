// UI runtime: action/input registries, mounted widgets, keyboard shortcuts and rAF-batched rendering.
// Feature modules call the register* functions at import time; app.js owns the single render loop.
import { morph } from './morph.js';

const actions = new Map();
const mounts = new Map();
const shortcuts = [];
const live = new Map(); // element -> { name, instance }

/**
 * Register click/input/change/submit/keydown handlers by name. Markup references them with
 * data-action="name" (click), data-input="name", data-change="name", data-submit="name" (form, default prevented)
 * or data-keydown="name". Handlers receive ({ el, event, ctx, data }) where data is el.dataset.
 */
export function registerActions(map) {
  for (const [name, handler] of Object.entries(map)) {
    if (actions.has(name)) console.warn(`[still] action "${name}" registered twice; the later one wins.`);
    actions.set(name, handler);
  }
}
export const hasAction = name => actions.has(name);
export async function dispatch(name, args = {}) {
  const handler = actions.get(name);
  if (!handler) throw new Error(`Unknown action: ${name}`);
  return handler(args);
}

/**
 * Register an imperative widget. Markup renders <div data-mount="name" data-morph="skip" data-key="unique">;
 * after each render the runtime calls mount(el, ctx) once per element and destroy() when the element leaves the DOM.
 * mount may return { update(ctx), destroy() }; update runs after every render while the element stays mounted.
 */
export function registerMount(name, mount) { mounts.set(name, mount); }

/**
 * Register keyboard shortcuts: { keys: 'mod+k' | 'n' | 'shift+?' | 'escape', action: 'name', label, when?(ctx),
 * allowInInputs?: boolean }. 'mod' is Cmd on macOS and Ctrl elsewhere.
 */
export function registerShortcuts(list) { shortcuts.push(...list); }
export const listShortcuts = () => shortcuts.filter(s => s.label);

const isMac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '');
export const modKey = isMac ? '⌘' : 'Ctrl';
function matches(event, keys) {
  const parts = keys.toLowerCase().split('+');
  const key = parts.pop();
  const want = { mod: parts.includes('mod'), shift: parts.includes('shift'), alt: parts.includes('alt') };
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (want.mod !== mod || want.alt !== event.altKey) return false;
  if (key.length === 1 && !/[a-z0-9]/.test(key)) return event.key === key; // symbols like '?' or '/' imply their own shift
  if (want.shift !== event.shiftKey) return false;
  return event.key.toLowerCase() === key;
}
const typingIn = target => target?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]');

export function createRuntime({ root, ctx, view }) {
  let frame = 0;
  let rendering = false;
  const afterRender = new Set();
  const everyRender = new Set();

  function renderNow() {
    frame = 0;
    rendering = true;
    try {
      morph(root, view(ctx));
      for (const [el, record] of live) {
        if (!el.isConnected) { live.delete(el); record.instance?.destroy?.(); }
      }
      for (const el of root.querySelectorAll('[data-mount]')) {
        const record = live.get(el);
        if (record) { record.instance?.update?.(ctx); continue; }
        const mount = mounts.get(el.dataset.mount);
        if (!mount) { console.warn(`[still] no mount registered for "${el.dataset.mount}"`); continue; }
        live.set(el, { name: el.dataset.mount, instance: mount(el, ctx) || null });
      }
    } finally { rendering = false; }
    for (const fn of everyRender) { try { fn(); } catch (error) { console.error(error); } }
    for (const fn of [...afterRender]) { afterRender.delete(fn); try { fn(); } catch (error) { console.error(error); } }
  }
  function render() {
    if (rendering) { queueMicrotask(render); return; }
    if (!frame) frame = requestAnimationFrame(renderNow);
  }
  /** Run fn after the next render commits (e.g. to focus an element that is about to appear). */
  const nextFrame = fn => { afterRender.add(fn); render(); };
  /** Run fn after every render (used by overlays to position popovers against their anchors). */
  const onRendered = fn => { everyRender.add(fn); return () => everyRender.delete(fn); };

  async function handle(name, el, event) {
    if (!name) return;
    if (!actions.has(name)) { console.warn(`[still] unknown action "${name}"`); return; }
    await ctx.run(() => dispatch(name, { el, event, ctx, data: el.dataset }));
  }
  const delegated = (type, attribute) => root.ownerDocument.addEventListener(type, event => {
    const el = event.target?.closest?.(`[${attribute}]`);
    if (!el || el.closest('[aria-disabled="true"], :disabled')) return;
    if (type === 'submit') event.preventDefault();
    if (type === 'click' && el.tagName === 'A' && el.getAttribute('href') === '#') event.preventDefault();
    handle(el.getAttribute(attribute), el, event);
  }, type === 'submit');
  delegated('click', 'data-action');
  delegated('input', 'data-input');
  delegated('change', 'data-change');
  delegated('submit', 'data-submit');
  delegated('keydown', 'data-keydown');

  root.ownerDocument.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing) return;
    for (const shortcut of shortcuts) {
      if (!matches(event, shortcut.keys)) continue;
      if (typingIn(event.target) && !shortcut.allowInInputs) continue;
      if (shortcut.when && !shortcut.when(ctx)) continue;
      event.preventDefault();
      handle(shortcut.action, event.target instanceof Element ? event.target : root, event);
      return;
    }
  });

  return { render, renderNow, nextFrame, onRendered };
}
