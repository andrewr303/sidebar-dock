import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// content/picker.js is a classic script for Chrome's ISOLATED world. These tests run it with node:vm against a small
// fake DOM written here (layout comes from fixed rects; there is no rendering), plus fake timers and chrome stubs.
const source = readFileSync(new URL('../extension/content/picker.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const HTML_NS = 'http://www.w3.org/1999/xhtml', SVG_NS = 'http://www.w3.org/2000/svg';
const INLINE_TAGS = new Set(['a', 'span', 'strong', 'em', 'b', 'i', 'code', 'img', 'svg', 'path', 'label']);
const rect = (left, top, width, height) => ({ left, top, width, height });
const kebab = name => String(name).replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());

function createDom({ width = 1000, height = 800, sheets = true, article = undefined } = {}) {
  const pageWrites = [], windowListeners = [], frames = new Map(), timers = new Map(), sent = [], observers = [], hitTests = [];
  let frameId = 0, timerId = 0;
  function addListener(list, type, fn, options) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    if (list.some(entry => entry.type === type && entry.fn === fn && entry.capture === capture)) return;
    const entry = { type, fn, capture };
    list.push(entry);
    options?.signal?.addEventListener('abort', () => { const index = list.indexOf(entry); if (index >= 0) list.splice(index, 1); }, { once: true });
  }
  function removeListener(list, type, fn, options) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    const index = list.findIndex(entry => entry.type === type && entry.fn === fn && entry.capture === capture);
    if (index >= 0) list.splice(index, 1);
  }
  const up = node => node.parentNode ?? (node.nodeType === 11 ? node.host : null);
  // pointer-events and visibility inherit; a fixture sets them on the element or an ancestor.
  function inherited(node, key, fallback) {
    for (let current = node; current && current.nodeType === 1; current = current.parentNode) if (current[key]) return current[key];
    return fallback;
  }
  // The box the picker drew from its own transform and size (overlay nodes have no fixture rect).
  function placedRect(node) {
    const [, x = 'NaN', y = 'NaN'] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(node.style.transform || '') || [];
    return rect(Number(x), Number(y), parseFloat(node.style.width) || 0, parseFloat(node.style.height) || 0);
  }
  const holds = (r, x, y) => r.width > 0 && r.height > 0 && x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
  function matches(node, selector) {
    if (node.nodeType !== 1) return false;
    return selector.split(',').some(part => {
      const match = /^\s*([a-z0-9-]+)(?:\[([a-z-]+)(~?=)"([^"]*)"\])?\s*$/i.exec(part);
      if (!match || node.localName !== match[1].toLowerCase()) return false;
      if (!match[2]) return true;
      const value = node.getAttribute(match[2]);
      return match[3] === '=' ? value === match[4] : String(value || '').split(/\s+/).includes(match[4]);
    });
  }
  function descendants(node, out = []) { for (const child of node.childNodes) { out.push(child); descendants(child, out); } return out; }

  class FakeNode {
    constructor(nodeType) { this.nodeType = nodeType; this.parentNode = null; this.childNodes = []; this.listeners = []; this.page = false; }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
    get children() { return this.childNodes.filter(node => node.nodeType === 1); }
    get isConnected() { for (let node = this; node; node = up(node)) if (node === document) return true; return false; }
    get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(node => node.textContent).join(''); }
    set textContent(value) {
      if (this.page) pageWrites.push('textContent');
      for (const child of this.childNodes) child.parentNode = null;
      this.childNodes = [];
      if (value !== '' && value != null) { const text = new FakeText(String(value)); text.parentNode = this; this.childNodes.push(text); }
    }
    appendChild(child) {
      if (child.nodeType === 11) throw new Error('fragments are not supported by the fake DOM');
      child.parentNode?.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    removeChild(child) { const index = this.childNodes.indexOf(child); if (index >= 0) this.childNodes.splice(index, 1); child.parentNode = null; return child; }
    remove() { this.parentNode?.removeChild(this); }
    contains(other) { for (let node = other; node; node = node.parentNode) if (node === this) return true; return false; }
    getRootNode() { let node = this; while (node.parentNode) node = node.parentNode; return node; }
    compareDocumentPosition(other) {
      const root = this.getRootNode();
      if (root !== other.getRootNode()) return 1;
      const order = [root, ...descendants(root)];
      return order.indexOf(other) > order.indexOf(this) ? 4 : 2;
    }
    addEventListener(type, fn, options) { addListener(this.listeners, type, fn, options); }
    removeEventListener(type, fn, options) { removeListener(this.listeners, type, fn, options); }
    querySelectorAll(selector) { return descendants(this).filter(node => matches(node, selector)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  class FakeText extends FakeNode { constructor(data) { super(3); this.data = data; } }
  class FakeShadowRoot extends FakeNode {
    constructor(host, mode) { super(11); this.host = host; this.mode = mode; this.adoptedStyleSheets = []; this.activeElement = null; }
  }
  function makeStyle(owner) {
    const values = new Map();
    const api = {
      setProperty(name, value, priority = '') { if (owner.page) pageWrites.push(`style ${name}`); values.set(name, { value: String(value), priority }); },
      getPropertyValue: name => values.get(name)?.value ?? '',
      getPropertyPriority: name => values.get(name)?.priority ?? '',
      removeProperty(name) { if (owner.page) pageWrites.push(`style ${name}`); values.delete(name); },
    };
    return new Proxy(api, {
      get: (target, key) => (key in target ? target[key] : values.get(kebab(key))?.value ?? ''),
      set: (target, key, value) => { if (owner.page) pageWrites.push(`style ${String(key)}`); values.set(kebab(key), { value: String(value), priority: '' }); return true; },
    });
  }
  class FakeElement extends FakeNode {
    constructor(tag, ns = HTML_NS) {
      super(1);
      this.localName = tag; this.namespaceURI = ns; this.attrs = new Map(); this.rect = null; this.display = INLINE_TAGS.has(tag) ? 'inline' : 'block';
      this.shadow = null; this.style = makeStyle(this); this.disabled = false;
      this.pointerEvents = ''; this.visibility = ''; this.opacity = 1; this.overflow = { x: 'visible', y: 'visible' };
      this.scrollTop = 0; this.scrollLeft = 0; this.scrollWidth = 0; this.scrollHeight = 0; this.clientWidth = 0; this.clientHeight = 0;
    }
    // Instant scrolling, clamped to the content like the platform.
    scrollBy({ left = 0, top = 0 } = {}) {
      this.scrollLeft = Math.min(Math.max(0, this.scrollWidth - this.clientWidth), Math.max(0, this.scrollLeft + left));
      this.scrollTop = Math.min(Math.max(0, this.scrollHeight - this.clientHeight), Math.max(0, this.scrollTop + top));
    }
    checkVisibility(options = {}) {
      for (let node = this; node && node.nodeType === 1; node = node.parentNode) {
        if (node.display === 'none') return false;
        if ((options.opacityProperty || options.checkOpacity) && node.opacity === 0) return false;
      }
      return !((options.visibilityProperty || options.checkVisibilityCSS) && inherited(this, 'visibility', 'visible') !== 'visible');
    }
    setAttribute(name, value) { if (this.page) pageWrites.push(`attr ${name}`); this.attrs.set(name, String(value)); }
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
    removeAttribute(name) { if (this.page) pageWrites.push(`attr ${name}`); this.attrs.delete(name); }
    get className() { return this.getAttribute('class') || ''; }
    get innerText() { return this.textContent; }
    get lang() { return this.getAttribute('lang') || ''; }
    get dir() { return this.getAttribute('dir') || ''; }
    attachShadow({ mode }) { this.shadow = new FakeShadowRoot(this, mode); return this.shadow; }
    get shadowRoot() { return this.shadow?.mode === 'open' ? this.shadow : null; }
    getBoundingClientRect() {
      const r = this.rect || rect(0, 0, 0, 0);
      return { x: r.left, y: r.top, left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height };
    }
    focus() {
      const root = this.getRootNode();
      if (root.nodeType === 11) { root.activeElement = this; document.activeElement = root.host; } else document.activeElement = this;
    }
  }
  class FakeDocument extends FakeNode {
    constructor() { super(9); this.activeElement = null; this.title = 'An example page'; }
    get documentElement() { return this.children[0] || null; }
    get body() { return this.documentElement?.children.find(node => node.localName === 'body') || null; }
    get scrollingElement() { return this.documentElement; }
    createElement(tag) { return new FakeElement(String(tag).toLowerCase()); }
    createElementNS(ns, tag) { return new FakeElement(tag, ns); }
    // Hit testing: page elements whose box holds the point, later ones on top (overlays come after what they cover
    // in these fixtures), minus pointer-events: none and hidden ones. A visible shield under the point puts the
    // picker host first, which is how the closed shadow root shows up from the document.
    elementsFromPoint(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('The provided double value is non-finite.');
      hitTests.push([x, y]);
      const hits = descendants(this).filter(node => node.nodeType === 1 && node.page && holds(node.getBoundingClientRect(), x, y)
        && inherited(node, 'pointerEvents', 'auto') !== 'none' && inherited(node, 'visibility', 'visible') === 'visible').reverse();
      const host = this.documentElement?.children.find(node => node.localName === 'still-picker');
      const shielded = !!host?.shadow && descendants(host.shadow).some(node => node.nodeType === 1 && node.className === 'shield'
        && node.style.visibility !== 'hidden' && holds(placedRect(node), x, y));
      return shielded ? [host, ...hits] : hits;
    }
  }
  const document = new FakeDocument();

  // Page nodes: built directly (no logging), then flagged so any later write by the picker is recorded.
  function h(tag, props = {}, children = []) {
    const el = new FakeElement(tag, props.ns || (tag === 'svg' || tag === 'path' ? SVG_NS : HTML_NS));
    if (props.rect) el.rect = props.rect;
    if (props.display) el.display = props.display;
    for (const key of ['pointerEvents', 'visibility', 'opacity', 'overflow']) if (props[key] !== undefined) el[key] = props[key];
    Object.assign(el, props.scroll || {});
    for (const [name, value] of Object.entries(props.attrs || {})) el.attrs.set(name, value);
    if (props.src) el.src = props.src;
    if (props.alt !== undefined) el.alt = props.alt;
    for (const child of children) {
      const node = typeof child === 'string' ? new FakeText(child) : child;
      node.parentNode = el;
      el.childNodes.push(node);
    }
    el.page = true;
    return el;
  }
  function mount(html) { html.parentNode = document; document.childNodes.push(html); return html; }

  const context = {
    document, location: { href: 'https://example.com/guide/start?ref=1#intro' }, innerWidth: width, innerHeight: height, URL, AbortController,
    addEventListener: (type, fn, options) => addListener(windowListeners, type, fn, options),
    removeEventListener: (type, fn, options) => removeListener(windowListeners, type, fn, options),
    getComputedStyle(el) {
      const root = el.getRootNode();
      const sheet = root.nodeType === 11 && root.adoptedStyleSheets.length > 0;
      const position = el.style.getPropertyValue('position') || (sheet && el.className.split(' ').includes('layer') ? 'absolute' : 'static');
      return { display: el.display || 'block', position, pointerEvents: inherited(el, 'pointerEvents', 'auto'),
        visibility: inherited(el, 'visibility', 'visible'), overflowX: el.overflow?.x || 'visible', overflowY: el.overflow?.y || 'visible' };
    },
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: id => { frames.delete(id); },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms, repeat: false }); return timerId; },
    clearTimeout: id => { timers.delete(id); },
    setInterval: (fn, ms) => { timers.set(++timerId, { fn, ms, repeat: true }); return timerId; },
    clearInterval: id => { timers.delete(id); },
    ResizeObserver: class { constructor(callback) { this.callback = callback; this.targets = new Set(); this.disconnected = false; observers.push(this); } observe(el) { this.targets.add(el); } unobserve(el) { this.targets.delete(el); } disconnect() { this.targets.clear(); this.disconnected = true; } },
    chrome: { runtime: { sendMessage: message => { sent.push(plain(message)); return Promise.resolve(); } } },
  };
  if (sheets) context.CSSStyleSheet = class { replaceSync(text) { this.text = text; } };
  if (article !== undefined) context.__stillArticle = article;
  vm.createContext(context);
  vm.runInContext(source, context);
  const global = vm.runInContext('globalThis', context);  // the script's own window, as event.target sees it

  function flush() { for (let round = 0; round < 10 && frames.size; round++) { const due = [...frames.values()]; frames.clear(); for (const fn of due) fn(); } }
  function runTimeouts() { for (const [id, timer] of [...timers]) if (!timer.repeat) { timers.delete(id); timer.fn(); } }
  // Window capture listeners first, then capture down the composed path, then bubbling back up (like the platform).
  function dispatch(type, target, init = {}) {
    const path = [];
    const atWindow = target === context || target === global;
    if (atWindow) target = global;
    else for (let node = target; node; node = up(node)) path.push(node);
    const event = {
      type, target, isTrusted: true, button: 0, relatedTarget: null, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...init,
      defaultPrevented: false, propagationStopped: false, immediateStopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; },
      stopImmediatePropagation() { this.propagationStopped = true; this.immediateStopped = true; },
      composedPath: () => [...path, context],
    };
    const run = (list, capture, current) => {
      for (const entry of [...list]) {
        if (entry.type !== type || entry.capture !== capture) continue;
        entry.fn.call(current, event);
        if (event.immediateStopped) return;
      }
    };
    run(windowListeners, true, context);
    for (const node of [...path].reverse()) { if (event.propagationStopped) return event; run(node.listeners, true, node); }
    for (const node of path) { if (event.propagationStopped) return event; run(node.listeners, false, node); }
    if (!event.propagationStopped) run(windowListeners, false, context);
    return event;
  }
  return { context, document, h, mount, dispatch, flush, runTimeouts, pageWrites, windowListeners, frames, timers, sent, observers, hitTests, picker: context.__stillPicker };
}

// The page used by most session tests. Rects are viewport coordinates.
function buildPage(dom) {
  const { h } = dom;
  const page = {};
  page.link = h('a', { rect: rect(140, 80, 40, 20), attrs: { href: '/next' } }, ['link']);
  page.p1 = h('p', { rect: rect(100, 80, 800, 60) }, ['First ', page.link, ' paragraph.']);
  page.deep = h('span', { rect: rect(120, 170, 60, 20) }, ['deep']);
  page.p2 = h('p', { rect: rect(100, 160, 800, 100) }, ['Second ', page.deep, ' paragraph.']);
  page.wrap = h('div', { rect: rect(100, 160, 800, 100) }, [page.p2]);
  page.h1 = h('h1', { rect: rect(100, 20, 800, 40) }, ['A *useful* title']);
  page.icon = h('img', { rect: rect(100, 300, 16, 16), src: 'https://example.com/icon.png' });
  page.photo = h('img', { rect: rect(100, 330, 800, 260), src: 'https://example.com/photo (1).jpg', alt: 'A photo' });
  page.caption = h('figcaption', { rect: rect(100, 600, 800, 20) }, ['Caption']);
  page.figure = h('figure', { rect: rect(100, 320, 800, 310) }, [page.photo, page.caption]);
  page.article = h('article', { rect: rect(100, 0, 800, 700) }, [page.h1, page.p1, page.wrap, page.icon, page.figure]);
  page.aside = h('aside', { rect: rect(100, 720, 800, 60) }, ['Related reading']);
  page.input = h('input', { rect: rect(100, 790, 200, 30), display: 'inline-block' });
  page.main = h('main', { rect: rect(100, 0, 800, 900) }, [page.article, page.aside, page.input]);
  page.body = h('body', { rect: rect(0, 0, 1000, 2000) }, [page.main]);
  page.html = dom.mount(h('html', { rect: rect(0, 0, 1000, 2000), attrs: { lang: 'en' } }, [page.body]));
  return page;
}

function startSession(options = {}) {
  const dom = createDom(options);
  const page = buildPage(dom);
  dom.document.activeElement = page.input;
  const reply = dom.picker.start({ requestId: 'req-1', from: 'panel', ...options.start });
  const host = page.html.children.find(node => node.localName === 'still-picker');
  const shadow = host?.shadow;
  const all = () => [shadow, ...(shadow ? descendantsOf(shadow) : [])];
  const byClass = name => all().filter(node => node.nodeType === 1 && node.className.split(' ').includes(name));
  const button = label => all().find(node => node.localName === 'button' && (node.getAttribute('aria-label') === label || node.textContent === label));
  const visible = node => node.style.visibility !== 'hidden';
  return { dom, page, reply, host, shadow, byClass, button, visible };
}
function descendantsOf(node, out = []) { for (const child of node.childNodes) { out.push(child); descendantsOf(child, out); } return out; }

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

const helpers = (() => { const context = vm.createContext({ URL }); vm.runInContext(source, context); return context.__stillPicker._test; })();
const env = { rectOf: el => el.getBoundingClientRect(), displayOf: el => el.display };

test('loads once as a classic script and exposes only start, stop, isActive and _test', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(source, context);
  const first = context.__stillPicker;
  vm.runInContext(source, context);
  assert.equal(context.__stillPicker, first, 'a second injection keeps the running instance');
  assert.deepEqual(Object.keys(first).sort(), ['_test', 'isActive', 'start', 'stop']);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first._test));
  assert.equal(first.isActive(), false);
  assert.deepEqual(plain(first.stop()), { stopped: false });
  assert.doesNotMatch(source, /^\s*(?:import|export)\b/m, 'no module syntax in an injected file');
});

test('start options are validated and clamped', () => {
  assert.deepEqual(plain(helpers.normalizeStart({ requestId: ' abc ', from: 'menu' })), { requestId: 'abc', from: 'menu', maxSelections: 30 });
  assert.equal(helpers.normalizeStart({ requestId: 'a', from: 'elsewhere' }).from, 'panel');
  assert.equal(helpers.normalizeStart({ requestId: 'a', maxSelections: 0 }).maxSelections, 1);
  assert.equal(helpers.normalizeStart({ requestId: 'a', maxSelections: 5000 }).maxSelections, 100);
  assert.equal(helpers.normalizeStart({ requestId: 'a', maxSelections: 'x' }).maxSelections, 30);
  assert.equal(helpers.normalizeStart({ requestId: 'a', maxSelections: null }).maxSelections, 30);
  assert.throws(() => helpers.normalizeStart({}), /request id/);
  assert.throws(() => helpers.normalizeStart({ requestId: 'x'.repeat(201) }), /request id/);
  assert.throws(() => helpers.normalizeStart(null), /request id/);
});

test('count label and plain-English copy', () => {
  assert.equal(helpers.countLabel(0), '0 selections');
  assert.equal(helpers.countLabel(1), '1 selection');
  assert.equal(helpers.countLabel(12), '12 selections');
  assert.equal(helpers.INTRO, 'Hover and click to select parts of the page. Press Esc to cancel.');
});

test('rect helpers: same-box tolerance, unions, tiny boxes and off-screen checks', () => {
  assert.ok(helpers.sameBox(rect(0, 0, 100, 50), rect(1, 2, 99, 49)));
  assert.ok(!helpers.sameBox(rect(0, 0, 100, 50), rect(0, 0, 100, 53)));
  assert.ok(helpers.emptyRect(rect(0, 0, 0, 10)) && helpers.emptyRect(null) && !helpers.emptyRect(rect(0, 0, 1, 1)));
  assert.deepEqual(plain(helpers.unionRect([rect(10, 10, 10, 10), rect(0, 0, 0, 0), rect(30, 5, 10, 30)])), { left: 10, top: 5, width: 30, height: 30, right: 40, bottom: 35 });
  assert.equal(helpers.unionRect([rect(0, 0, 0, 0)]), null);
  assert.ok(helpers.isTinyRect(rect(0, 0, 16, 16)), 'icons');
  assert.ok(helpers.isTinyRect(rect(0, 0, 800, 1)), 'hairlines');
  assert.ok(!helpers.isTinyRect(rect(0, 0, 40, 40)), 'avatars are selectable');
  assert.ok(!helpers.isTinyRect(rect(0, 0, 300, 20)), 'one line of text');
  const viewport = { width: 1000, height: 800 };
  assert.ok(helpers.offscreen(rect(0, -50, 100, 50), viewport) && helpers.offscreen(rect(0, 800, 100, 50), viewport) && helpers.offscreen(rect(1000, 0, 10, 10), viewport));
  assert.ok(!helpers.offscreen(rect(0, -50, 100, 51), viewport));
});

test('toolbar sits above the box, moves inside when there is no room and never leaves the viewport', () => {
  const viewport = { width: 1000, height: 800 }, size = helpers.BAR_SIZE;
  assert.deepEqual(plain(helpers.barPosition(rect(100, 200, 400, 100), viewport)), { x: 500 - size.width, y: 200 - size.height - 4 });
  assert.deepEqual(plain(helpers.barPosition(rect(100, 10, 400, 100), viewport)), { x: 500 - size.width, y: 14 }, 'inside the top edge');
  assert.deepEqual(plain(helpers.barPosition(rect(100, -300, 400, 900), viewport)), { x: 500 - size.width, y: 4 }, 'box starts above the viewport');
  assert.equal(helpers.barPosition(rect(0, 200, 40, 40), viewport).x, 4, 'clamped on the left');
  assert.equal(helpers.barPosition(rect(900, 200, 400, 40), viewport).x, 1000 - size.width - 4, 'clamped on the right');
  assert.equal(helpers.barPosition(rect(0, 900, 100, 100), viewport).y, 800 - size.height - 4, 'clamped at the bottom');
});

test('toolbars are clamped to the overlay layer, which leaves out classic scrollbars', () => {
  const win = { innerWidth: 1000, innerHeight: 800 };
  assert.deepEqual(plain(helpers.overlaySize({ clientWidth: 985, clientHeight: 785 }, win)), { width: 985, height: 785 });
  assert.deepEqual(plain(helpers.overlaySize({ clientWidth: 0, clientHeight: 785 }, win)), { width: 1000, height: 785 }, 'no layout yet: the window, side by side');
  assert.deepEqual(plain(helpers.overlaySize(null, win)), { width: 1000, height: 800 });
  assert.deepEqual(plain(helpers.overlaySize({ clientWidth: NaN }, {})), { width: 0, height: 0 });
  const { dom, page, byClass } = startSession();
  const layer = byClass('layer')[0];
  // A 15px classic scrollbar on the right and at the bottom: the layer is narrower than the window.
  layer.clientWidth = 985;
  layer.clientHeight = 785;
  page.aside.rect = rect(300, 700, 700, 60);
  dom.dispatch('click', page.aside);
  dom.flush();
  const size = helpers.BAR_SIZE;
  assert.equal(byClass('bar')[0].style.transform, `translate(${985 - size.width - 4}px, ${700 - size.height - 4}px)`, 'the whole toolbar stays left of the scrollbar');
  // A part that starts under the horizontal scrollbar is off-screen for the overlay.
  page.aside.rect = rect(300, 790, 700, 60);
  dom.dispatch('resize', page.html);
  dom.flush();
  assert.equal(byClass('bar')[0].style.visibility, 'hidden');
  dom.picker.stop();
});

test('hover climbs from inline and tiny elements to a meaningful block, never the page or our own UI', () => {
  const dom = createDom();
  const page = buildPage(dom);
  assert.equal(helpers.climbToBlock(page.link, env), page.p1, 'inline link → its paragraph');
  assert.equal(helpers.climbToBlock(page.link.childNodes[0], env), page.p1, 'text nodes climb too');
  assert.equal(helpers.climbToBlock(page.icon, env), page.article, 'a 16px image is not a part');
  assert.equal(helpers.climbToBlock(page.photo, env), page.photo, 'inline media is a part');
  assert.equal(helpers.climbToBlock(page.body, env), null);
  assert.equal(helpers.climbToBlock(page.html, env), null);
  const hidden = dom.h('div', { rect: rect(0, 0, 0, 0), display: 'contents' }, []);
  const inside = dom.h('section', { rect: rect(100, 0, 400, 400) }, [hidden]);
  page.main.childNodes.push(inside); inside.parentNode = page.main;
  assert.equal(helpers.climbToBlock(hidden, env), inside, 'display: contents wrappers are skipped');
  const path = dom.h('path', { rect: rect(10, 10, 40, 40), ns: SVG_NS });
  const svg = dom.h('svg', { rect: rect(10, 10, 200, 120), display: 'inline' }, [path]);
  page.main.childNodes.push(svg); svg.parentNode = page.main;
  assert.equal(helpers.climbToBlock(path, env), svg, 'SVG internals resolve to the drawing');
  assert.equal(helpers.climbToBlock(page.p1, { ...env, isOwn: el => el === page.p1 }), null, 'our host is never a part');
});

test('"+" widens to the nearest ancestor with a different box and stops below body', () => {
  const dom = createDom();
  const page = buildPage(dom);
  assert.equal(helpers.growTarget(page.p2, env), page.article, 'the same-size wrapper is skipped');
  assert.equal(helpers.growTarget(page.article, env), page.main);
  assert.equal(helpers.growTarget(page.main, env), null, 'never body or html');
});

test('"−" undoes the last widen, then steps toward the pointer, then into the first meaningful child', () => {
  const dom = createDom();
  const page = buildPage(dom);
  assert.deepEqual(helpers.narrowTarget({ el: page.main, anchor: page.deep, history: [page.p2, page.article] }, env).el, page.article, 'history first');
  const detached = dom.h('p', { rect: rect(0, 0, 100, 100) }, ['gone']);
  const viaHistory = helpers.narrowTarget({ el: page.article, anchor: null, history: [page.p2, detached] }, env);
  assert.equal(viaHistory.el, page.p2, 'stale history entries are skipped');
  assert.equal(viaHistory.history.length, 0);
  assert.equal(helpers.narrowTarget({ el: page.article, anchor: page.deep, history: [] }, env).el, page.wrap, 'toward the element under the pointer');
  assert.equal(helpers.narrowTarget({ el: page.article, anchor: null, history: [] }, env).el, page.h1, 'first meaningful child');
  assert.equal(helpers.narrowTarget({ el: page.figure, anchor: null, history: [] }, env).el, page.photo);
  assert.equal(helpers.narrowTarget({ el: page.wrap, anchor: page.deep, history: [] }, env), null, 'a same-size child and inline text are not narrower');
  const emptyKid = dom.h('div', { rect: rect(100, 720, 800, 30) }, []);
  const holder = dom.h('section', { rect: rect(100, 700, 800, 100) }, [emptyKid]);
  assert.equal(helpers.narrowTarget({ el: holder, anchor: null, history: [] }, env), null, 'children without text or media are skipped');
});

test('"−" looks through inline, display: contents and slot wrappers to the narrower blocks inside', () => {
  const dom = createDom();
  const { h } = dom;
  // A link around a card is inline; the blocks inside it are what "−" can step to.
  const title = h('h3', { rect: rect(100, 100, 400, 40) }, ['Card title']);
  const link = h('a', { rect: rect(100, 100, 400, 260), attrs: { href: '/card' } }, [title, h('p', { rect: rect(100, 150, 400, 200) }, ['Card body'])]);
  const card = h('div', { rect: rect(90, 90, 420, 280) }, [link]);
  assert.equal(helpers.narrowTarget({ el: card, anchor: null, history: [] }, env).el, title);
  // display: contents wrappers, nested, draw no box of their own.
  const first = h('p', { rect: rect(0, 0, 500, 50) }, ['One']);
  const inner = h('div', { rect: rect(0, 0, 0, 0), display: 'contents' }, [first, h('p', { rect: rect(0, 60, 500, 50) }, ['Two'])]);
  const section = h('section', { rect: rect(0, 0, 500, 120) }, [h('div', { rect: rect(0, 0, 0, 0), display: 'contents' }, [inner])]);
  assert.equal(helpers.narrowTarget({ el: section, anchor: null, history: [] }, env).el, first);
  // A web component shows its light-DOM children through a <slot> in its shadow root, behind a same-size frame.
  const heading = h('h2', { rect: rect(0, 200, 500, 40) }, ['Slotted heading']);
  const component = h('x-panel', { rect: rect(0, 190, 500, 170) }, [heading, h('p', { rect: rect(0, 250, 500, 100) }, ['Slotted text'])]);
  const slot = h('slot', { rect: rect(0, 190, 500, 170) }, ['Fallback text']);
  slot.assignedElements = () => [...component.children];
  component.attachShadow({ mode: 'open' }).appendChild(h('div', { rect: rect(0, 190, 500, 170) }, [slot]));
  assert.equal(helpers.narrowTarget({ el: component, anchor: null, history: [] }, env).el, heading, 'a slot is looked through, even with a box');
  // With nothing assigned, a slot shows its fallback content.
  const fallback = h('p', { rect: rect(0, 400, 500, 30) }, ['Nothing slotted']);
  const empty = h('x-empty', { rect: rect(0, 390, 500, 60) }, []);
  const emptySlot = h('slot', { display: 'contents' }, [fallback]);
  emptySlot.assignedElements = () => [];
  empty.attachShadow({ mode: 'open' }).appendChild(emptySlot);
  assert.equal(helpers.narrowTarget({ el: empty, anchor: null, history: [] }, env).el, fallback);
  // Inline wrappers holding only text are still not narrower, and media inside inline wrappers count.
  const words = h('div', { rect: rect(0, 500, 500, 40) }, [h('span', { rect: rect(0, 500, 200, 20) }, ['just ', h('em', { rect: rect(40, 500, 40, 20) }, ['words'])])]);
  assert.equal(helpers.narrowTarget({ el: words, anchor: null, history: [] }, env), null);
  const photo = h('img', { rect: rect(0, 600, 300, 200), src: 'https://example.com/p.jpg' });
  const figure = h('div', { rect: rect(0, 590, 500, 260) }, [h('a', { rect: rect(0, 600, 300, 200), attrs: { href: '/p' } }, [photo])]);
  assert.equal(helpers.narrowTarget({ el: figure, anchor: null, history: [] }, env).el, photo);
  assert.deepEqual([...helpers.meaningfulChildren(section, env)], [first, inner.children[1]]);
});

test('selections never nest: inside is refused, ancestors absorb, the limit counts after absorbing', () => {
  const dom = createDom();
  const page = buildPage(dom);
  assert.equal(helpers.planSelect([page.article], page.p1, 30).action, 'inside');
  assert.equal(helpers.planSelect([page.p1], page.p1, 30).action, 'inside', 'the same part again');
  const absorb = helpers.planSelect([page.p1, page.p2, page.aside], page.article, 30);
  assert.equal(absorb.action, 'add');
  assert.deepEqual(absorb.absorbed, [page.p1, page.p2]);
  assert.equal(helpers.planSelect([page.p1, page.p2], page.aside, 2).action, 'limit');
  assert.equal(helpers.planSelect([page.p1, page.p2], page.article, 2).action, 'add', 'absorbing frees room');
});

test('document order sorts by position, also across open shadow roots', () => {
  const dom = createDom();
  const page = buildPage(dom);
  assert.deepEqual([...helpers.documentOrder([page.aside, page.p2, page.h1, page.photo])], [page.h1, page.p2, page.photo, page.aside]);
  const component = dom.h('x-card', { rect: rect(100, 640, 800, 60) }, []);
  page.article.childNodes.push(component); component.parentNode = page.article;
  const root = component.attachShadow({ mode: 'open' });
  const inner = dom.h('p', { rect: rect(100, 640, 800, 30) }, ['Inside a component']);
  root.appendChild(inner);
  assert.equal(helpers.composedParent(inner), component);
  assert.ok(helpers.composedContains(page.article, inner));
  assert.ok(!helpers.composedContains(page.aside, inner));
  assert.deepEqual([...helpers.documentOrder([page.aside, inner, page.h1])], [page.h1, inner, page.aside]);
  assert.equal(helpers.growTarget(inner, env), component, 'widening leaves the shadow root through its host');
});

test('stylesheet text covers every class, motion and forced colors; declarations parse for the inline fallback', () => {
  const css = helpers.stylesheetText();
  for (const name of Object.keys(helpers.STYLES)) assert.match(css, new RegExp(`\\.${name} \\{`));
  assert.match(css, /prefers-reduced-motion: no-preference/);
  assert.match(css, /forced-colors: active/);
  assert.doesNotMatch(css, /url\(/, 'no external or data assets');
  assert.deepEqual(plain(helpers.declarations('position: absolute; inset: 0;; font-family: system-ui, "Segoe UI"; bad')),
    [['position', 'absolute'], ['inset', '0'], ['font-family', 'system-ui, "Segoe UI"']]);
  for (const body of Object.values(helpers.STYLES)) assert.ok(helpers.declarations(body).length > 0);
});

test('plain reader escapes page text as data and keeps headings and images', () => {
  assert.equal(helpers.escapeMarkdownLine('# not a heading'), '\\# not a heading');
  assert.equal(helpers.escapeMarkdownLine('- not a bullet'), '\\- not a bullet');
  assert.equal(helpers.escapeMarkdownLine('1. not a list'), '1\\. not a list');
  assert.equal(helpers.escapeMarkdownLine('> not a quote'), '\\> not a quote');
  assert.equal(helpers.escapeMarkdownLine('::embed[x](https://e.com)'), '\\::embed\\[x\\](https://e.com)');
  assert.equal(helpers.escapeMarkdownLine('a *b* _c_ `d` [[e]] <f> | g ~h~ \\'), 'a \\*b\\* \\_c\\_ \\`d\\` \\[\\[e\\]\\] \\<f> \\| g \\~h\\~ \\\\');
  assert.equal(helpers.normalizeText('  a  b \r\n\r\n\r\n\tc  '), 'a b\n\nc');
  const dom = createDom();
  const page = buildPage(dom);
  assert.equal(helpers.plainPart(page.h1, null, ''), '# A \\*useful\\* title');
  assert.equal(helpers.plainPart(page.p1, null, ''), 'First link paragraph.');
  assert.equal(helpers.plainPart(page.photo, null, ''), '![A photo](https://example.com/photo%20%281%29.jpg)');
  assert.equal(helpers.plainPart(dom.h('img', { src: 'data:image/png;base64,AA' }), null, ''), '', 'only http(s) images');
  const multi = dom.h('div', {}, ['Line one\n\n\nLine two\n- dash']);
  assert.equal(helpers.plainPart(multi, null, ''), 'Line one\n\nLine two\n\n\\- dash');
  assert.equal(helpers.plainPart(page.p1, () => '**converted**', 'https://e.com'), '**converted**', 'the shared converter wins when present');
  assert.equal(helpers.plainPart(page.p1, () => { throw new Error('boom'); }, ''), 'First link paragraph.');
  assert.equal(helpers.cutAtBoundary('aaaa\n\nbbbb\n\ncccc', 12), 'aaaa\n\nbbbb');
  assert.equal(helpers.cutAtBoundary('one two three four', 12), 'one two', 'never mid-word when a space is near');
  assert.equal(helpers.cutAtBoundary('abcdefghijkl', 5), 'abcde');
});

test('fallback result follows the ArticleResult shape, page metadata rules and the size cap', () => {
  const dom = createDom();
  const page = buildPage(dom);
  const meta = (property, content) => dom.h('meta', { attrs: { property, content } });
  const head = dom.h('head', {}, [meta('og:site_name', 'Example Docs'), dom.h('meta', { attrs: { name: 'author', content: 'Ada' } }),
    dom.h('link', { attrs: { rel: 'alternate canonical' } })]);
  head.childNodes[2].href = 'https://example.com/guide/start';
  page.html.childNodes.unshift(head); head.parentNode = page.html;
  const loc = { href: 'https://example.com/guide/start?ref=1#intro' };
  const result = helpers.fallbackResult([page.h1, page.p1, page.photo], { doc: dom.document, loc });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'selection');
  assert.equal(result.selectionCount, 3);
  assert.equal(result.markdown, '# A \\*useful\\* title\n\nFirst link paragraph.\n\n![A photo](https://example.com/photo%20%281%29.jpg)');
  assert.equal(result.text, 'A *useful* title\n\nFirst link paragraph.');
  assert.deepEqual([result.url, result.canonicalUrl, result.title, result.siteName, result.author, result.lang], [loc.href, 'https://example.com/guide/start', 'An example page', 'Example Docs', 'Ada', 'en']);
  assert.equal(result.wordCount, 6);
  assert.equal(result.readingMinutes, 1);
  assert.equal(result.truncated, false);
  assert.deepEqual(plain(result.images), []);
  for (const key of ['url', 'canonicalUrl', 'title', 'siteName', 'author', 'publishedAt', 'lang', 'dir', 'excerpt', 'icon', 'cover', 'markdown', 'text', 'wordCount', 'readingMinutes', 'images', 'truncated']) assert.ok(key in result, key);
  dom.document.title = '';
  assert.equal(helpers.pageMeta(dom.document, loc).title, 'example.com/guide/start?ref=1#intro', 'untitled pages use the address');
  const capped = helpers.fallbackResult([page.p1, page.p2, page.aside], { doc: dom.document, loc, maxChars: 30 });
  assert.equal(capped.truncated, true);
  assert.ok(capped.markdown.length <= 30);
  assert.equal(capped.markdown, 'First link paragraph.', 'whole parts only');
  const single = helpers.fallbackResult([page.p1], { doc: dom.document, loc, maxChars: 12 });
  assert.deepEqual([single.markdown, single.truncated], ['First link', true], 'a lone oversized part is shortened at a word');
  assert.deepEqual(plain(helpers.fallbackResult([dom.h('div', { rect: rect(0, 0, 100, 100) }, ['   '])], { doc: dom.document, loc })),
    { ok: false, code: 'empty', error: 'The selected parts have no text to save.' });
});

test('readSelection prefers __stillArticle.fromElements and falls back safely', () => {
  const dom = createDom();
  const page = buildPage(dom);
  const loc = { href: 'https://example.com/a' };
  const calls = [];
  const article = { fromElements: (elements, options) => { calls.push({ elements, options }); return { ok: true, source: 'readability', markdown: 'converted', selectionCount: 99 }; } };
  const result = helpers.readSelection([page.p1, page.aside], { article, doc: dom.document, loc });
  assert.deepEqual(plain(result), { ok: true, source: 'selection', markdown: 'converted', selectionCount: 2 });
  assert.deepEqual(calls[0].elements, [page.p1, page.aside]);
  assert.deepEqual(plain(calls[0].options), { maxChars: 250000 });
  assert.deepEqual(plain(helpers.readSelection([page.p1], { article: { fromElements: () => ({ ok: false, code: 'weird', error: '' }) }, doc: dom.document, loc })),
    { ok: false, code: 'error', error: 'Still could not read the selected parts.' });
  assert.deepEqual(plain(helpers.readSelection([page.p1], { article: { fromElements: () => ({ ok: false, code: 'empty', error: 'Nothing here.' }) }, doc: dom.document, loc })),
    { ok: false, code: 'empty', error: 'Nothing here.' });
  const thrown = helpers.readSelection([page.p1], { article: { fromElements: () => { throw new Error('boom'); } }, doc: dom.document, loc });
  assert.equal(thrown.markdown, 'First link paragraph.', 'a failing converter falls back to the plain reader');
  const markdownOnly = helpers.readSelection([page.p1, page.aside], { article: { toMarkdown: el => `md:${el.localName}` }, doc: dom.document, loc });
  assert.equal(markdownOnly.markdown, 'md:p\n\nmd:aside');
  assert.equal(helpers.readSelection([page.aside], { article: undefined, doc: dom.document, loc }).markdown, 'Related reading');
});

// ---------------------------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------------------------

test('start builds a closed shadow overlay without touching the page', () => {
  const { dom, page, reply, host, shadow, byClass, button, visible } = startSession();
  assert.deepEqual(plain(reply), { started: true, requestId: 'req-1' });
  assert.equal(dom.picker.isActive(), true);
  assert.ok(host, 'host appended to documentElement');
  assert.equal(shadow.mode, 'closed');
  assert.equal(host.shadowRoot, null);
  assert.equal(host.style.getPropertyValue('z-index'), '2147483647');
  assert.equal(host.style.getPropertyPriority('z-index'), 'important');
  assert.equal(host.style.getPropertyValue('pointer-events'), 'none');
  assert.equal(shadow.adoptedStyleSheets.length, 1);
  assert.match(shadow.adoptedStyleSheets[0].text, /\.panel \{/);
  assert.equal(byClass('layer')[0].style.getPropertyValue('position'), '', 'stylesheet applied, no inline fallback');
  assert.equal(byClass('toast')[0].textContent, 'Hover and click to select parts of the page. Press Esc to cancel.');
  assert.equal(byClass('count')[0].textContent, '0 selections');
  assert.equal(button('Done').disabled, true);
  assert.equal(button('Cancel').getAttribute('type'), 'button');
  assert.equal(visible(byClass('hover')[0]), false);
  assert.equal(shadow.activeElement, byClass('panel')[0], 'focus moves to the picker panel');
  assert.deepEqual(plain(dom.picker.start({ requestId: 'req-1' })), { started: true, requestId: 'req-1' }, 'same request is idempotent');
  assert.equal(page.html.children.filter(node => node.localName === 'still-picker').length, 1);
  assert.deepEqual(dom.pageWrites, []);
  dom.picker.stop();
});

test('hover draws a box over the meaningful block; click selects it and the page never sees the click', () => {
  const { dom, page, byClass, visible } = startSession();
  const pageClicks = [];
  page.link.addEventListener('click', () => pageClicks.push('link'));
  page.body.addEventListener('mousedown', () => pageClicks.push('mousedown'));
  dom.dispatch('pointermove', page.link);
  dom.flush();
  const hoverBox = byClass('hover')[0];
  assert.equal(visible(hoverBox), true);
  assert.equal(hoverBox.style.transform, 'translate(100px, 80px)');
  assert.deepEqual([hoverBox.style.width, hoverBox.style.height], ['800px', '60px']);
  const down = dom.dispatch('mousedown', page.link);
  const pointerDown = dom.dispatch('pointerdown', page.link);
  const click = dom.dispatch('click', page.link);
  assert.ok(down.defaultPrevented && down.immediateStopped, 'mousedown cancelled: no focus, text selection or drag');
  assert.ok(!pointerDown.defaultPrevented && pointerDown.immediateStopped, 'pointerdown only stopped');
  assert.ok(click.defaultPrevented && click.immediateStopped, 'navigation cancelled');
  assert.deepEqual(pageClicks, []);
  dom.flush();
  assert.equal(byClass('count')[0].textContent, '1 selection');
  assert.equal(byClass('box').length, 1);
  assert.equal(byClass('box')[0].style.transform, 'translate(100px, 80px)');
  assert.equal(visible(hoverBox), false, 'no hover box over a selected part');
  assert.equal(visible(byClass('toast')[0]), false, 'the intro hides after the first pick');
  const contextMenu = dom.dispatch('mousedown', page.link, { button: 2 });
  assert.ok(!contextMenu.defaultPrevented, 'right-click keeps the context menu');
  const synthetic = dom.dispatch('click', page.aside, { isTrusted: false });
  assert.ok(!synthetic.defaultPrevented);
  assert.equal(byClass('count')[0].textContent, '1 selection', 'untrusted clicks never select');
  assert.deepEqual(dom.pageWrites, []);
  dom.picker.stop();
});

test('clicking inside a selection is ignored with a hint; selecting an ancestor absorbs; numbers follow the document', () => {
  const { dom, page, byClass } = startSession();
  dom.dispatch('click', page.aside);
  dom.dispatch('click', page.p1);
  dom.flush();
  assert.deepEqual(byClass('num').map(node => node.textContent), ['2', '1'], 'badges follow document order, not click order');
  dom.dispatch('click', page.link);
  dom.flush();
  assert.equal(byClass('count')[0].textContent, '2 selections');
  assert.match(byClass('toast')[0].textContent, /already selected/);
  dom.runTimeouts();
  assert.equal(byClass('toast')[0].style.visibility, 'hidden', 'hints time out');
  dom.dispatch('click', page.h1);
  dom.dispatch('click', page.figure);
  dom.flush();
  assert.equal(byClass('count')[0].textContent, '4 selections');
  dom.dispatch('pointermove', page.p2);
  dom.dispatch('keydown', page.body, { key: 'ArrowUp' });
  dom.dispatch('click', page.p2);
  dom.flush();
  assert.equal(byClass('count')[0].textContent, '2 selections', 'the article absorbed three parts');
  assert.equal(byClass('toast')[0].textContent, 'Merged 3 selections into this one.');
  assert.equal(byClass('box').length, 2);
  dom.picker.stop();
});

test('toolbar buttons: + skips same-size wrappers and absorbs, − undoes the widen, × removes', () => {
  const { dom, page, byClass, button } = startSession();
  dom.dispatch('pointermove', page.deep);
  dom.dispatch('click', page.deep);
  dom.dispatch('click', page.h1);
  dom.flush();
  assert.equal(byClass('count')[0].textContent, '2 selections');
  const bars = byClass('bar');
  const p2Bar = bars.find(bar => bar.getAttribute('aria-label') === 'Selection 2');
  const widen = p2Bar.children.find(node => node.getAttribute('aria-label') === 'Widen selection');
  const narrow = p2Bar.children.find(node => node.getAttribute('aria-label') === 'Narrow selection');
  const remove = p2Bar.children.find(node => node.getAttribute('aria-label') === 'Remove selection');
  assert.ok(widen && narrow && remove);
  assert.equal(widen.localName, 'button');
  assert.equal(widen.children[0].localName, 'svg');
  const event = dom.dispatch('click', widen);
  assert.ok(event.defaultPrevented);
  dom.flush();
  assert.equal(byClass('count')[0].textContent, '1 selection', 'widening to the article absorbed the heading');
  assert.equal(byClass('box')[0].style.transform, 'translate(100px, 0px)');
  assert.equal(byClass('box')[0].style.height, '700px');
  assert.equal(byClass('toast')[0].textContent, 'Merged with 1 other selection.');
  dom.dispatch('click', narrow);
  dom.flush();
  assert.equal(byClass('box')[0].style.transform, 'translate(100px, 160px)', 'back to the paragraph');
  dom.dispatch('click', narrow);
  dom.flush();
  assert.equal(byClass('toast')[0].textContent, 'This part cannot be narrowed any further.');
  dom.dispatch('click', remove);
  dom.flush();
  assert.equal(byClass('count')[0].textContent, '0 selections');
  assert.equal(byClass('box').length, 0);
  assert.equal(button('Done').disabled, true);
  dom.picker.stop();
});

test('Enter finishes: one message in document order through the shared converter, then a clean teardown', () => {
  const calls = [];
  const article = { fromElements(elements, options) { calls.push([...elements].map(el => el.localName)); return { ok: true, source: 'selection', markdown: elements.map(el => el.textContent).join('\n\n'), selectionCount: elements.length, options }; } };
  const { dom, page, host, byClass } = startSession({ article });
  const before = dom.windowListeners.length;
  assert.ok(before >= 10);
  dom.dispatch('click', page.aside);
  dom.dispatch('click', page.h1);
  dom.flush();
  const observer = dom.observers[0];
  assert.equal(observer.targets.size, 2, 'selected parts are watched for size changes');
  page.aside.rect = rect(100, 740, 800, 60);
  observer.callback();
  dom.flush();
  assert.equal(byClass('box').find(box => box.style.transform.includes('740px')) !== undefined, true, 'boxes follow layout changes');
  dom.context.innerHeight = 500;
  dom.dispatch('resize', page.html);
  dom.flush();
  assert.equal(byClass('box').filter(box => box.style.visibility === 'hidden').length, 1, 'off-screen boxes are skipped');
  const enter = dom.dispatch('keydown', page.input, { key: 'Enter' });
  assert.ok(enter.defaultPrevented);
  assert.deepEqual(calls, [['h1', 'aside']]);
  assert.equal(dom.sent.length, 1);
  const [message] = dom.sent;
  assert.equal(message.type, 'still:picker-result');
  assert.equal(message.requestId, 'req-1');
  assert.equal(message.from, 'panel');
  assert.equal(message.result.source, 'selection');
  assert.equal(message.result.selectionCount, 2);
  assert.equal(message.result.markdown, 'A *useful* title\n\nRelated reading');
  assert.deepEqual(message.result.options, { maxChars: 250000 });
  assert.equal(host.isConnected, false, 'UI removed');
  assert.deepEqual(dom.windowListeners.map(entry => entry.type).sort(), ['blur', 'keydown', 'keyup', 'pointerdown'], 'only the one-shot guard for the Enter key is left');
  const pageKeys = [];
  page.input.addEventListener('keyup', event => pageKeys.push(event.key));
  const enterUp = dom.dispatch('keyup', page.input, { key: 'Enter' });
  assert.ok(enterUp.defaultPrevented && enterUp.immediateStopped, 'the restored focus never sees the keyup of the key that finished');
  assert.deepEqual(pageKeys, []);
  assert.equal(dom.windowListeners.length, 0, 'every window listener removed, the guard included');
  dom.dispatch('keyup', page.input, { key: 'Enter' });
  assert.deepEqual(pageKeys, ['Enter'], 'later keys reach the page again');
  assert.equal(dom.frames.size, 0, 'no pending frames');
  assert.equal(dom.timers.size, 0, 'no pending timers or intervals');
  assert.equal(observer.disconnected, true);
  assert.equal(dom.document.activeElement, page.input, 'focus returns to where it was');
  assert.equal(dom.picker.isActive(), false);
  dom.dispatch('keydown', page.input, { key: 'Enter' });
  dom.dispatch('click', page.p1);
  assert.equal(dom.sent.length, 1, 'nothing after teardown');
  assert.deepEqual(dom.pageWrites, []);
});

test('Done button works, Enter with nothing selected only hints, and a focused picker button keeps Enter', () => {
  const { dom, page, byClass, button, shadow } = startSession();
  const enter = dom.dispatch('keydown', page.body, { key: 'Enter' });
  assert.ok(enter.defaultPrevented);
  assert.equal(dom.sent.length, 0);
  assert.equal(byClass('toast')[0].textContent, 'Select at least one part first, or press Esc to cancel.');
  dom.dispatch('click', page.p1);
  button('Cancel').focus();
  const onButton = dom.dispatch('keydown', button('Cancel'), { key: 'Enter' });
  assert.ok(!onButton.defaultPrevented && onButton.immediateStopped, 'the button activates itself; the page never sees the key');
  assert.equal(shadow.activeElement, button('Cancel'));
  assert.equal(dom.sent.length, 0);
  dom.dispatch('click', button('Done'), { isTrusted: false });
  assert.equal(dom.sent.length, 0, 'a synthetic click cannot finish');
  dom.dispatch('click', button('Done'));
  assert.equal(dom.sent.length, 1);
  assert.equal(dom.sent[0].result.markdown, 'First link paragraph.', 'plain reader when article-extract.js is missing');
  assert.equal(dom.sent[0].result.selectionCount, 1);
  assert.equal(dom.picker.isActive(), false);
});

test('Esc, the Cancel button and pagehide cancel with one message each', () => {
  for (const how of ['escape', 'button', 'pagehide']) {
    const { dom, page, button, host } = startSession();
    dom.dispatch('click', page.p1);
    if (how === 'escape') assert.ok(dom.dispatch('keydown', page.body, { key: 'Escape' }).defaultPrevented);
    if (how === 'button') dom.dispatch('click', button('Cancel'));
    if (how === 'pagehide') dom.dispatch('pagehide', page.html);
    assert.deepEqual(dom.sent, [{ type: 'still:picker-result', requestId: 'req-1', from: 'panel', cancelled: true }], how);
    assert.equal(host.isConnected, false);
    if (how === 'escape') assert.ok(dom.dispatch('keyup', page.input, { key: 'Escape' }).defaultPrevented, 'the Esc keyup is swallowed too');
    assert.equal(dom.windowListeners.length, 0);
    assert.equal(dom.picker.isActive(), false);
  }
});

test('a page cannot cancel the picker with a synthetic pagehide', () => {
  const { dom, page, host } = startSession();
  dom.dispatch('click', page.p1);
  dom.dispatch('pagehide', page.html, { isTrusted: false });
  assert.equal(dom.picker.isActive(), true);
  assert.equal(host.isConnected, true);
  assert.deepEqual(dom.sent, []);
  dom.picker.stop();
});

test('the guard for a consumed key never lingers: another key, a pointer press or leaving the window drops it', () => {
  for (const [how, type, init] of [['other key', 'keydown', { key: 'a' }], ['pointer press', 'pointerdown', {}], ['window blur', 'blur', {}]]) {
    const { dom, page } = startSession();
    dom.dispatch('keydown', page.body, { key: 'Escape' });
    assert.equal(dom.windowListeners.length, 4, how);
    const repeat = dom.dispatch('keydown', page.input, { key: 'Escape', repeat: true });
    assert.ok(repeat.defaultPrevented, 'auto-repeats of the held key are swallowed');
    const blurOfAnElement = dom.dispatch('blur', page.input);
    assert.ok(!blurOfAnElement.defaultPrevented);
    assert.equal(dom.windowListeners.length, 4, 'an element losing focus is not the window losing focus');
    dom.dispatch(type, type === 'blur' ? dom.context : page.input, init);
    assert.equal(dom.windowListeners.length, 0, how);
    const late = dom.dispatch('keyup', page.input, { key: 'Escape' });
    assert.ok(!late.defaultPrevented, `${how}: the page gets its keys back`);
  }
});

test('keys the picker consumes during a session never reach the page on keyup either', () => {
  const { dom, page } = startSession();
  const pageKeys = [];
  page.body.addEventListener('keyup', event => pageKeys.push(event.key));
  dom.dispatch('keydown', page.input, { key: 'Enter' });
  assert.equal(dom.picker.isActive(), true, 'nothing selected: Enter only hints');
  assert.ok(dom.dispatch('keyup', page.input, { key: 'Enter' }).defaultPrevented);
  dom.dispatch('pointermove', page.deep);
  dom.dispatch('keydown', page.input, { key: 'ArrowUp' });
  dom.dispatch('keyup', page.input, { key: 'ArrowUp' });
  dom.dispatch('keyup', page.input, { key: 'x' });
  assert.deepEqual(pageKeys, ['x'], 'keys the picker did not act on pass through');
  dom.picker.stop();
  assert.equal(dom.windowListeners.length, 0, 'stop() with no key down leaves no guard');
});

test('↑/↓ widen and narrow the hovered candidate; plain arrows scroll when nothing is hovered', () => {
  const { dom, page, byClass } = startSession();
  const idle = dom.dispatch('keydown', page.body, { key: 'ArrowDown' });
  assert.ok(!idle.defaultPrevented, 'no candidate: the page scrolls as usual');
  dom.dispatch('pointermove', page.deep);
  dom.flush();
  const hoverBox = byClass('hover')[0];
  assert.equal(hoverBox.style.transform, 'translate(100px, 160px)');
  assert.ok(dom.dispatch('keydown', page.body, { key: 'ArrowUp' }).defaultPrevented);
  dom.flush();
  assert.equal(hoverBox.style.height, '700px', 'widened to the article');
  dom.dispatch('keydown', page.body, { key: 'ArrowUp' });
  dom.dispatch('keydown', page.body, { key: 'ArrowUp' });
  dom.flush();
  assert.equal(hoverBox.style.height, '900px', 'main, then no further');
  assert.equal(byClass('toast')[0].textContent, 'This part cannot be widened any further.');
  dom.dispatch('keydown', page.body, { key: 'ArrowDown' });
  dom.dispatch('keydown', page.body, { key: 'ArrowDown' });
  dom.flush();
  assert.equal(hoverBox.style.height, '100px', 'narrowing retraces the widen history');
  const withModifier = dom.dispatch('keydown', page.body, { key: 'ArrowUp', metaKey: true });
  assert.ok(!withModifier.defaultPrevented, 'browser shortcuts are left alone');
  dom.dispatch('click', page.deep);
  dom.flush();
  assert.equal(byClass('box')[0].style.height, '100px', 'click takes the adjusted candidate');
  dom.picker.stop();
});

test('limits, page clicks on the background and selections that leave the document', () => {
  const { dom, page, byClass } = startSession({ start: { maxSelections: 2 } });
  dom.dispatch('click', page.p1);
  dom.dispatch('click', page.h1);
  dom.dispatch('click', page.aside);
  dom.flush();
  assert.equal(byClass('count')[0].textContent, '2 selections');
  assert.equal(byClass('toast')[0].textContent, 'You can select up to 2 parts.');
  const background = dom.dispatch('click', page.body);
  assert.ok(background.defaultPrevented, 'still suppressed');
  assert.equal(byClass('toast')[0].textContent, 'Click a block of content, such as a paragraph or an image.');
  page.article.childNodes.splice(page.article.childNodes.indexOf(page.h1), 1);
  page.h1.parentNode = null;
  dom.flush();
  dom.context.setInterval && [...dom.timers.values()].find(timer => timer.repeat).fn();
  dom.flush();
  assert.equal(byClass('count')[0].textContent, '1 selection', 'removed parts drop out on the next sweep');
  dom.picker.stop();
  assert.equal(dom.sent.length, 0, 'stop() tears down silently');
});

test('a new request replaces a running one and tells the old requester it was cancelled', () => {
  const { dom, page } = startSession();
  dom.dispatch('click', page.p1);
  const reply = dom.picker.start({ requestId: 'req-2', from: 'menu' });
  assert.deepEqual(plain(reply), { started: true, requestId: 'req-2' });
  assert.deepEqual(dom.sent, [{ type: 'still:picker-result', requestId: 'req-1', from: 'panel', cancelled: true }]);
  assert.equal(page.html.children.filter(node => node.localName === 'still-picker').length, 1);
  dom.dispatch('click', page.aside);
  dom.dispatch('keydown', page.body, { key: 'Enter' });
  assert.equal(dom.sent[1].requestId, 'req-2');
  assert.equal(dom.sent[1].from, 'menu');
  assert.equal(dom.sent[1].result.selectionCount, 1);
});

test('when constructed stylesheets are unavailable every picker node gets inline styles instead', () => {
  const { dom, page, shadow, byClass } = startSession({ sheets: false });
  assert.equal(shadow.adoptedStyleSheets.length, 0);
  assert.equal(byClass('layer')[0].style.getPropertyValue('position'), 'absolute');
  assert.equal(byClass('panel')[0].style.getPropertyValue('background'), '#26272b');
  dom.dispatch('click', page.p1);
  dom.flush();
  assert.equal(byClass('box')[0].style.getPropertyValue('border'), '2px solid #1a66d6', 'nodes created later are styled too');
  assert.equal(byClass('box')[0].style.transform, 'translate(100px, 80px)');
  assert.deepEqual(dom.pageWrites, []);
  dom.picker.stop();
});

test('frames get a shield so hovering and clicking them selects the frame instead of reaching into it', () => {
  const dom = createDom();
  const page = buildPage(dom);
  const frame = dom.h('iframe', { rect: rect(100, 640, 800, 50), display: 'inline' });
  page.article.childNodes.push(frame); frame.parentNode = page.article;
  dom.picker.start({ requestId: 'req-1' });
  dom.flush();
  const shadow = page.html.children.find(node => node.localName === 'still-picker').shadow;
  const nodes = descendantsOf(shadow);
  const shield = nodes.find(node => node.nodeType === 1 && node.className === 'shield');
  assert.ok(shield);
  assert.equal(shield.style.transform, 'translate(100px, 640px)');
  dom.dispatch('pointermove', shield, { clientX: 500, clientY: 660 });
  dom.flush();
  const hover = nodes.find(node => node.nodeType === 1 && node.className === 'hover');
  assert.equal(hover.style.transform, 'translate(100px, 640px)');
  const click = dom.dispatch('click', shield, { clientX: 500, clientY: 660 });
  assert.ok(click.defaultPrevented);
  dom.dispatch('keydown', page.body, { key: 'Enter' });
  assert.equal(dom.sent[0].result.ok, false, 'an iframe alone has no readable text in the plain reader');
  assert.equal(dom.sent[0].result.code, 'empty');
});

// A page of frames and the content around them, mounted under html > body > main and picked from.
function startWithFrames(build) {
  const dom = createDom();
  const parts = build(dom.h);
  const main = dom.h('main', { rect: rect(0, 0, 1000, 2000) }, parts.children);
  const html = dom.mount(dom.h('html', { rect: rect(0, 0, 1000, 2000) }, [dom.h('body', { rect: rect(0, 0, 1000, 2000) }, [main])]));
  dom.picker.start({ requestId: 'req-1' });
  dom.flush();
  const shadow = html.children.find(node => node.localName === 'still-picker').shadow;
  const byClass = name => descendantsOf(shadow).filter(node => node.nodeType === 1 && node.className.split(' ').includes(name));
  const shields = () => byClass('shield').filter(node => node.style.visibility !== 'hidden');
  return { dom, ...parts, html, main, byClass, shields, hoverBox: byClass('hover')[0] };
}

test('content drawn over a frame stays hoverable and selectable through its shield', () => {
  const { dom, main, shields, hoverBox, byClass } = startWithFrames(h => {
    const video = h('iframe', { rect: rect(0, 100, 1000, 500), display: 'inline' });
    const headline = h('h1', { rect: rect(100, 200, 600, 60) }, ['Launch week']);
    const intro = h('p', { rect: rect(100, 280, 600, 40) }, ['Everything we shipped.']);
    return { children: [h('section', { rect: rect(0, 100, 1000, 500) }, [video, headline, intro])] };
  });
  assert.equal(shields().length, 1);
  const [shield] = shields();
  dom.dispatch('pointermove', shield, { clientX: 150, clientY: 220 });
  dom.flush();
  assert.equal(hoverBox.style.transform, 'translate(100px, 200px)', 'the headline drawn over the frame, not the frame');
  dom.dispatch('pointermove', shield, { clientX: 900, clientY: 550 });
  dom.flush();
  assert.equal(hoverBox.style.transform, 'translate(0px, 100px)', 'the frame where nothing covers it');
  const click = dom.dispatch('click', shield, { clientX: 150, clientY: 290 });
  assert.ok(click.defaultPrevented && click.propagationStopped);
  dom.dispatch('click', shield, { clientX: 150, clientY: 220 });
  dom.dispatch('click', shield, { clientX: 150, clientY: 290, isTrusted: false });
  dom.flush();
  assert.equal(byClass('count')[0].textContent, '2 selections', 'the headline and the paragraph, each on its own');
  dom.dispatch('pointermove', shield, { clientX: 900, clientY: 550, isTrusted: false });
  dom.dispatch('keydown', main, { key: 'Enter' });
  assert.equal(dom.sent[0].result.markdown, '# Launch week\n\nEverything we shipped.');
});

test('frames that cannot take the pointer get no shield, so the page over and under them works natively', () => {
  const { dom, headline, shields, hoverBox, legacy } = startWithFrames(h => {
    const background = h('iframe', { rect: rect(0, 100, 1000, 500), display: 'inline', pointerEvents: 'none' });
    const headline = h('h1', { rect: rect(100, 200, 600, 60) }, ['Launch week']);
    const chat = h('iframe', { rect: rect(0, 0, 1000, 800), display: 'inline', visibility: 'hidden' });
    const ad = h('iframe', { rect: rect(0, 600, 1000, 100), display: 'inline', opacity: 0 });
    const muted = h('div', { rect: rect(0, 700, 1000, 100), pointerEvents: 'none' }, [h('iframe', { rect: rect(0, 700, 1000, 100), display: 'inline' })]);
    const collapsed = h('div', { rect: rect(0, 0, 300, 300), display: 'none' }, [h('embed', { rect: rect(0, 0, 300, 300), display: 'inline' })]);
    const legacy = h('object', { rect: rect(0, 300, 300, 300), display: 'inline', visibility: 'hidden' });
    legacy.checkVisibility = undefined;
    return { children: [h('section', { rect: rect(0, 100, 1000, 500) }, [background, headline]), chat, ad, muted, collapsed, legacy], headline, legacy };
  });
  assert.equal(shields().length, 0, 'pointer-events: none (own or inherited), hidden, transparent and undisplayed frames');
  dom.dispatch('pointermove', headline);
  dom.flush();
  assert.equal(hoverBox.style.transform, 'translate(100px, 200px)');
  legacy.visibility = 'visible';
  [...dom.timers.values()].find(timer => timer.repeat).fn();
  dom.flush();
  assert.equal(shields().length, 1, 'without checkVisibility the computed style still decides');
  dom.picker.stop();
});

test('at most 40 frames get a shield; off-screen frames do not use one up and shields follow frames that go', () => {
  const { dom, main, shields } = startWithFrames(h => ({
    children: [
      ...Array.from({ length: 5 }, () => h('iframe', { rect: rect(0, 5000, 100, 100), display: 'inline' })),
      ...Array.from({ length: 45 }, (_, index) => h('iframe', { rect: rect((index % 9) * 110, Math.floor(index / 9) * 110, 100, 100), display: 'inline' })),
    ],
  }));
  assert.equal(shields().length, 40);
  assert.equal(shields()[0].style.transform, 'translate(0px, 0px)', 'the first on-screen frame');
  for (const frame of main.children.slice(5, 20)) frame.remove();
  [...dom.timers.values()].find(timer => timer.repeat).fn();
  dom.flush();
  assert.equal(shields().length, 30, 'shields of removed frames are hidden');
  dom.picker.stop();
});

test('the wheel over a shield scrolls the container under the pointer; the root and zoom keep their defaults', () => {
  const { dom, list, shields } = startWithFrames(h => {
    const embed = h('iframe', { rect: rect(100, 100, 600, 300), display: 'inline' });
    const list = h('div', { rect: rect(100, 0, 600, 600), overflow: { x: 'hidden', y: 'auto' },
      scroll: { scrollHeight: 1500, clientHeight: 600, scrollWidth: 900, clientWidth: 600 } }, [embed]);
    return { children: [list], list };
  });
  const [shield] = shields();
  const at = { clientX: 300, clientY: 200 };
  const down = dom.dispatch('wheel', shield, { ...at, deltaY: 120 });
  assert.ok(down.defaultPrevented);
  assert.equal(list.scrollTop, 120);
  dom.dispatch('wheel', shield, { ...at, deltaY: 3, deltaMode: 1 });
  assert.equal(list.scrollTop, 168, 'line deltas are converted to pixels');
  const sideways = dom.dispatch('wheel', shield, { ...at, deltaX: 50 });
  assert.ok(!sideways.defaultPrevented, 'overflow-x: hidden does not scroll with the wheel');
  assert.equal(list.scrollLeft, 0);
  list.scrollTop = 900;
  const atEnd = dom.dispatch('wheel', shield, { ...at, deltaY: 120 });
  assert.ok(!atEnd.defaultPrevented, 'a container at its end leaves the wheel to the root');
  assert.equal(list.scrollTop, 900);
  const zoom = dom.dispatch('wheel', shield, { ...at, deltaY: -120, ctrlKey: true });
  assert.ok(!zoom.defaultPrevented, 'ctrl+wheel stays the browser zoom');
  const synthetic = dom.dispatch('wheel', shield, { ...at, deltaY: -120, isTrusted: false });
  assert.ok(!synthetic.defaultPrevented);
  const back = dom.dispatch('wheel', shield, { ...at, deltaY: -120 });
  assert.ok(back.defaultPrevented);
  assert.equal(list.scrollTop, 780);
  dom.picker.stop();
});

test('scrollsOn needs scrolling overflow and content larger than the box on the wheel axis', () => {
  const box = { scrollHeight: 900, clientHeight: 300, scrollWidth: 300, clientWidth: 300 };
  assert.ok(helpers.scrollsOn(box, 0, 10, { x: 'visible', y: 'auto' }));
  assert.ok(helpers.scrollsOn(box, 0, -10, { x: 'visible', y: 'overlay' }));
  assert.ok(!helpers.scrollsOn(box, 0, 10, { x: 'visible', y: 'hidden' }), 'overflow: hidden is not wheel-scrollable');
  assert.ok(!helpers.scrollsOn(box, 10, 0, { x: 'scroll', y: 'auto' }), 'nothing to scroll sideways');
  assert.ok(!helpers.scrollsOn(box, 0, 0, { x: 'auto', y: 'auto' }));
  assert.ok(!helpers.scrollsOn(box, 0, 10, null));
});

test('an overlay removed by the page comes back on the next paint', () => {
  const { dom, page, host, byClass } = startSession();
  host.remove();
  assert.equal(host.isConnected, false);
  [...dom.timers.values()].find(timer => timer.repeat).fn();
  dom.flush();
  assert.equal(host.isConnected, true);
  assert.equal(page.html.children.filter(node => node.localName === 'still-picker').length, 1);
  dom.dispatch('click', page.p1);
  dom.flush();
  assert.equal(byClass('count')[0].textContent, '1 selection', 'and keeps working');
  dom.picker.stop();
  assert.equal(host.isConnected, false);
});

test('the hover box goes away when the pointer leaves the window, not when it moves between elements', () => {
  const { dom, page, byClass, visible } = startSession();
  dom.dispatch('pointermove', page.p1);
  dom.flush();
  const hoverBox = byClass('hover')[0];
  assert.equal(visible(hoverBox), true);
  dom.dispatch('pointerout', page.p1, { relatedTarget: page.p2 });
  dom.flush();
  assert.equal(visible(hoverBox), true, 'moving to another element keeps the box until the next move');
  dom.dispatch('pointerout', page.p1, { relatedTarget: null, isTrusted: false });
  dom.flush();
  assert.equal(visible(hoverBox), true, 'a synthetic pointerout is ignored');
  dom.dispatch('pointerout', page.p1, { relatedTarget: null });
  dom.flush();
  assert.equal(visible(hoverBox), false);
  dom.dispatch('pointermove', page.p1);
  dom.flush();
  assert.equal(visible(hoverBox), true, 'coming back shows it again');
  dom.picker.stop();
});

test('mouse button events never reach the page while picking, except the right button and synthetic events', () => {
  const { dom, page } = startSession();
  const seen = [];
  for (const type of ['pointerup', 'mouseup', 'dblclick', 'auxclick']) page.link.addEventListener(type, () => seen.push(type));
  for (const type of ['mouseup', 'dblclick']) {
    const event = dom.dispatch(type, page.link);
    assert.ok(event.defaultPrevented && event.immediateStopped, type);
  }
  const middle = dom.dispatch('auxclick', page.link, { button: 1 });
  assert.ok(middle.defaultPrevented && middle.immediateStopped, 'a middle click never opens the link in a new tab');
  assert.ok(dom.dispatch('mousedown', page.link, { button: 1 }).defaultPrevented, 'nor starts autoscroll');
  const pointerUp = dom.dispatch('pointerup', page.link);
  assert.ok(!pointerUp.defaultPrevented && pointerUp.immediateStopped, 'pointerup is only stopped');
  const rightUp = dom.dispatch('mouseup', page.link, { button: 2 });
  assert.ok(!rightUp.defaultPrevented && !rightUp.immediateStopped, 'the right button keeps the context menu');
  assert.ok(!dom.dispatch('dblclick', page.link, { isTrusted: false }).defaultPrevented);
  assert.deepEqual(seen, ['mouseup', 'dblclick'], 'only the right-button mouseup and the synthetic double click');
  assert.equal(dom.sent.length, 0);
  dom.picker.stop();
});

test('keys typed on the picker controls never reach page shortcuts; Tab still moves focus', () => {
  const { dom, page, button } = startSession();
  const pageKeys = [];
  for (const type of ['keydown', 'keyup']) page.html.addEventListener(type, event => pageKeys.push(`${type} ${event.key}`));
  button('Cancel').focus();
  for (const key of ['a', '/', 'Tab', ' ']) {
    const down = dom.dispatch('keydown', button('Cancel'), { key });
    assert.ok(down.immediateStopped && !down.defaultPrevented, `${JSON.stringify(key)} keeps its default action in the picker`);
    assert.ok(dom.dispatch('keyup', button('Cancel'), { key }).immediateStopped);
  }
  assert.deepEqual(pageKeys, []);
  dom.dispatch('keydown', page.input, { key: 'a' });
  dom.dispatch('keyup', page.input, { key: 'a' });
  assert.deepEqual(pageKeys, ['keydown a', 'keyup a'], 'keys outside the picker reach the page');
  assert.equal(dom.sent.length, 0);
  dom.picker.stop();
});

test('pointer and mouse events on picker toolbar buttons and Done/Cancel never bubble out to the page', () => {
  const { dom, page, button } = startSession();
  dom.dispatch('click', page.p1);
  dom.flush();
  const leaked = [];
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick']) {
    page.html.addEventListener(type, () => leaked.push(type));
  }
  const widen = button('Widen selection');
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    dom.dispatch(type, widen);
  }
  const doneBtn = button('Done');
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    dom.dispatch(type, doneBtn);
  }
  assert.deepEqual(leaked, [], 'no pointer or mouse event on picker UI controls reaches the page');
  assert.equal(dom.sent.length, 1);
  assert.equal(dom.picker.isActive(), false);
});

test('Space on the picker panel seeds hover on the first meaningful block and toggles selection for keyboard-only users', () => {
  const { dom, byClass, visible } = startSession();
  const panel = byClass('panel')[0];
  assert.equal(visible(byClass('hover')[0]), false);
  const firstSpace = dom.dispatch('keydown', panel, { key: ' ' });
  dom.flush();
  assert.ok(firstSpace.defaultPrevented && firstSpace.immediateStopped);
  assert.equal(visible(byClass('hover')[0]), true, 'first Space seeds hover on the first meaningful block');
  assert.equal(byClass('count')[0].textContent, '0 selections', 'first Space only seeds hover');
  const secondSpace = dom.dispatch('keydown', panel, { key: ' ' });
  dom.flush();
  assert.ok(secondSpace.defaultPrevented && secondSpace.immediateStopped);
  assert.equal(byClass('count')[0].textContent, '1 selection', 'second Space selects the hovered block');
  const thirdSpace = dom.dispatch('keydown', panel, { key: ' ' });
  dom.flush();
  assert.ok(thirdSpace.defaultPrevented && thirdSpace.immediateStopped);
  assert.equal(byClass('count')[0].textContent, '0 selections', 'third Space deselects the hovered block');
  dom.picker.stop();
});


