// Multi-select picker: the user picks several parts of a web page and Still converts them into one article draft.
// Original implementation of research/2026-11-01-capture-research-agent/outputs/build-contracts.md §4 (design notes in
// capture-decision.md, Decision 3); no code comes from other clippers.
//
// A classic script with no module syntax. background.js injects it with executeScript({ files }) into the ISOLATED
// world of frame 0, after content/article-extract.js, then calls __stillPicker.start() through a func injection. The
// isolated world keeps the picker's state and chrome.runtime out of reach of page scripts, and nothing here listens to
// page postMessage traffic, so a page cannot forge a result.
//
// The page is never styled or annotated: highlights are boxes drawn in a closed shadow root from
// getBoundingClientRect, so picking cannot move absolutely positioned or fixed page elements.
(() => {
  'use strict';
  // Every start-picker request injects this file again; keep the first instance (and any running session).
  if (globalThis.__stillPicker) return;

  const HOST_TAG = 'still-picker';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAX_CHARS = 250000;                 // the articleContent cap
  const DEFAULT_MAX_SELECTIONS = 30;
  const MAX_SELECTIONS_LIMIT = 100;
  const INTRO = 'Hover and click to select parts of the page. Press Esc to cancel.';
  const HINT_MS = 2600;
  const SWEEP_MS = 500;                     // catches layout moves that fire no scroll, resize or ResizeObserver event
  const MAX_SHIELDS = 40;
  const EDGE = 4;
  const BAR_SIZE = Object.freeze({ width: 106, height: 28 });  // number chip + three 24px buttons, 2px gaps and padding
  const ROOT_TAGS = new Set(['html', 'head', 'body']);
  const MEDIA_TAGS = new Set(['img', 'picture', 'video', 'audio', 'canvas', 'svg', 'iframe', 'frame', 'embed', 'object']);
  const FRAME_SELECTOR = 'iframe, frame, embed, object';
  const MEDIA_SELECTOR = 'img, picture, video, canvas, svg, iframe, embed, object';
  const SCROLLABLE = new Set(['auto', 'scroll', 'overlay']);
  const WHEEL_LINE_PX = 16;                 // deltaMode 1 (lines) in pixels
  const ICONS = { minus: ['M5 12h14'], plus: ['M5 12h14', 'M12 5v14'], x: ['M18 6 6 18', 'm6 6 12 12'] };

  // Inline !important on the host beats any page rule that targets it (display:none, transforms, filters).
  const HOST_STYLE = 'all: initial; display: block; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; margin: 0; padding: 0; border: 0; background: transparent';

  // Still's palette (styles/tokens.css: the inverse toast surface, its muted text and focus color, and the blue
  // accent), written out because page and extension tokens do not reach a shadow root. The surfaces are dark with a
  // light hairline and every box has white hairlines, so the UI stays high contrast on light and dark pages alike.
  // The keys are class names; each value is also applied inline when the page blocks the stylesheet (see adoptStyles).
  const STYLES = {
    layer: 'position: absolute; inset: 0; overflow: hidden; pointer-events: none; direction: ltr; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 13px; font-weight: 400; line-height: 1.54; letter-spacing: normal; text-align: left; text-transform: none; white-space: normal; color: #f1efec',
    hover: 'position: absolute; left: 0; top: 0; box-sizing: border-box; border: 2px dashed #1a66d6; border-radius: 4px; background: rgb(26 102 214 / 0.08); box-shadow: 0 0 0 1px rgb(255 255 255 / 0.85), inset 0 0 0 1px rgb(255 255 255 / 0.85); pointer-events: none',
    box: 'position: absolute; left: 0; top: 0; box-sizing: border-box; border: 2px solid #1a66d6; border-radius: 4px; background: rgb(26 102 214 / 0.14); box-shadow: 0 0 0 1px rgb(255 255 255 / 0.9), inset 0 0 0 1px rgb(255 255 255 / 0.9); pointer-events: none',
    shield: 'position: absolute; left: 0; top: 0; background: transparent; pointer-events: auto',
    bar: 'position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 2px; box-sizing: border-box; height: 28px; padding: 2px; border-radius: 8px; background: #26272b; color: #f1efec; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.16), 0 4px 10px -2px rgb(0 0 0 / 0.35); pointer-events: auto',
    num: 'display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; min-width: 24px; height: 24px; padding: 0 4px; border-radius: 6px; background: #1a66d6; color: #ffffff; font-size: 12px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums',
    btn: 'appearance: none; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; width: 24px; height: 24px; margin: 0; padding: 0; border: 0; border-radius: 6px; background: transparent; color: #f1efec; font: inherit; cursor: pointer',
    icon: 'display: block; pointer-events: none',
    toast: 'position: absolute; top: 16px; left: 50%; transform: translateX(-50%); box-sizing: border-box; width: max-content; max-width: calc(100% - 32px); padding: 8px 14px; border-radius: 8px; background: #26272b; color: #f1efec; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.16), 0 4px 10px -2px rgb(0 0 0 / 0.3), 0 12px 24px -6px rgb(0 0 0 / 0.3); text-align: center; pointer-events: none',
    panel: 'position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; box-sizing: border-box; max-width: calc(100% - 32px); padding: 6px 6px 6px 14px; border-radius: 12px; background: #26272b; color: #f1efec; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.16), 0 8px 20px -4px rgb(0 0 0 / 0.3), 0 28px 56px -12px rgb(0 0 0 / 0.35); white-space: nowrap; pointer-events: auto; outline: none',
    count: 'font-weight: 600; font-variant-numeric: tabular-nums',
    keys: 'margin-right: 4px; color: #c4c1bb; font-size: 12px',
    action: 'appearance: none; box-sizing: border-box; height: 32px; margin: 0; padding: 0 12px; border: 0; border-radius: 8px; font: inherit; font-weight: 500; cursor: pointer',
    primary: 'background: #1a66d6; color: #ffffff',
    secondary: 'background: transparent; color: #f1efec; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.24)',
    sr: 'position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap',
  };
  // Stylesheet-only refinements: states, motion and forced colors cannot be expressed as inline declarations.
  const EXTRA_CSS = `
.btn:hover, .secondary:hover { background: rgb(255 255 255 / 0.12); }
.btn:active, .secondary:active { background: rgb(255 255 255 / 0.2); }
.primary:hover:not(:disabled) { background: #1659c0; }
.primary:active:not(:disabled) { background: #134ea8; }
.action:disabled { cursor: default; }
.btn:focus-visible, .action:focus-visible { outline: 2px solid #9cc0fb; outline-offset: 1px; }
@media (max-width: 520px) { .keys { display: none; } }
@media (prefers-reduced-motion: no-preference) {
  .hover { transition: transform 90ms cubic-bezier(0.2, 0, 0, 1), width 90ms cubic-bezier(0.2, 0, 0, 1), height 90ms cubic-bezier(0.2, 0, 0, 1); }
  .toast, .panel { animation: still-picker-in 160ms cubic-bezier(0.2, 0, 0, 1); }
}
@keyframes still-picker-in { from { opacity: 0; } to { opacity: 1; } }
@media (forced-colors: active) {
  .hover, .box { border-color: Highlight; background: transparent; box-shadow: none; }
  .bar, .toast, .panel { border: 1px solid CanvasText; }
}`;

  // ---------------------------------------------------------------------------------------------------------------
  // Pure helpers (exposed on __stillPicker._test). DOM access goes through the node API or an injected env, so the
  // tests can drive them with small stub trees.
  // ---------------------------------------------------------------------------------------------------------------

  const countLabel = count => `${count} selection${count === 1 ? '' : 's'}`;
  const tagOf = node => String(node?.localName || node?.nodeName || '').toLowerCase();
  const isElement = node => !!node && node.nodeType === 1;
  const isConnected = node => !!node && node.isConnected !== false;
  const swallow = event => { event.preventDefault(); event.stopImmediatePropagation(); };

  function clampInt(value, min, max, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  }

  function normalizeStart(options) {
    const value = options && typeof options === 'object' ? options : {};
    const requestId = typeof value.requestId === 'string' ? value.requestId.trim() : '';
    if (!requestId || requestId.length > 200) throw new Error('The page picker needs a valid request id.');
    return { requestId, from: value.from === 'menu' ? 'menu' : 'panel', maxSelections: clampInt(value.maxSelections, 1, MAX_SELECTIONS_LIMIT, DEFAULT_MAX_SELECTIONS) };
  }

  function edges(rect) {
    if (!rect) return null;
    const left = Number(rect.left) || 0, top = Number(rect.top) || 0;
    const width = Math.max(0, Number(rect.width ?? (rect.right - left)) || 0), height = Math.max(0, Number(rect.height ?? (rect.bottom - top)) || 0);
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  const emptyRect = rect => !rect || !(rect.width > 0) || !(rect.height > 0);
  // Same box within a couple of pixels: wrappers that only add a border or rounding do not count as a step.
  function sameBox(a, b, tolerance = 2) {
    const x = edges(a), y = edges(b);
    return !!x && !!y && Math.abs(x.left - y.left) <= tolerance && Math.abs(x.top - y.top) <= tolerance
      && Math.abs(x.right - y.right) <= tolerance && Math.abs(x.bottom - y.bottom) <= tolerance;
  }
  function unionRect(rects) {
    let union = null;
    for (const rect of rects || []) {
      const r = edges(rect);
      if (!r || emptyRect(r)) continue;
      union = union ? { left: Math.min(union.left, r.left), top: Math.min(union.top, r.top), right: Math.max(union.right, r.right), bottom: Math.max(union.bottom, r.bottom) } : { ...r };
    }
    return union ? edges({ left: union.left, top: union.top, width: union.right - union.left, height: union.bottom - union.top }) : null;
  }
  // Icons, bullets and hairlines are never what someone means to clip: hover climbs past them to their container.
  function isTinyRect(rect) {
    const r = edges(rect);
    return !r || r.width < 8 || r.height < 8 || (r.width < 32 && r.height < 32);
  }
  function offscreen(rect, viewport) {
    const r = edges(rect);
    return !r || r.bottom <= 0 || r.right <= 0 || r.top >= viewport.height || r.left >= viewport.width;
  }
  // The area the overlay can draw in: its layer's client box, which is the viewport minus any classic scrollbars (the
  // host is fixed at inset 0, so it never covers them). Falls back to the window size, per side, while the layer has no
  // layout yet.
  function overlaySize(layer, win = globalThis) {
    const side = (client, fallback) => (Number.isFinite(client) && client > 0 ? client : Number.isFinite(fallback) && fallback > 0 ? fallback : 0);
    return { width: side(layer?.clientWidth, win?.innerWidth), height: side(layer?.clientHeight, win?.innerHeight) };
  }
  // Toolbar spot: just above the box's top-right corner, inside the top edge when there is no room above (or the
  // box starts above the viewport), always clamped inside the overlay (overlaySize).
  function barPosition(rect, viewport, size = BAR_SIZE) {
    const r = edges(rect);
    const maxX = Math.max(EDGE, viewport.width - size.width - EDGE), maxY = Math.max(EDGE, viewport.height - size.height - EDGE);
    let y = r.top - size.height - EDGE;
    if (y < EDGE) y = Math.max(EDGE, r.top + EDGE);
    return { x: Math.round(Math.min(maxX, Math.max(EDGE, r.right - size.width))), y: Math.round(Math.min(maxY, y)) };
  }

  // Parent across open shadow roots, so a part inside a web component can be widened to its host.
  function composedParent(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const parent = node.parentNode;
    return parent && parent.nodeType === 11 && parent.host ? parent.host : null;
  }
  function composedContains(ancestor, node) {
    for (let current = node, steps = 0; current && steps < 4096; current = composedParent(current), steps++) if (current === ancestor) return true;
    return false;
  }
  function composedChain(node) {
    const chain = [];
    for (let current = node; current && chain.length < 4096; current = composedParent(current)) chain.push(current);
    return chain.reverse();
  }
  // Document order, also across shadow roots: compare the first ancestors that differ (DOCUMENT_POSITION_FOLLOWING
  // is 4, PRECEDING is 2). Unordered pairs keep their relative order (the sort is stable).
  function compareDocumentOrder(a, b) {
    if (a === b) return 0;
    const chainA = composedChain(a), chainB = composedChain(b);
    let index = 0;
    while (index < chainA.length && index < chainB.length && chainA[index] === chainB[index]) index++;
    if (index === chainA.length) return -1;
    if (index === chainB.length) return 1;
    let position = 0;
    try { position = chainA[index].compareDocumentPosition(chainB[index]); } catch { position = 0; }
    return position & 4 ? -1 : position & 2 ? 1 : 0;
  }
  const documentOrder = elements => [...elements].sort(compareDocumentOrder);

  // A part worth selecting: rendered, block-level (or media), not tiny and not the page itself.
  function isCandidate(el, env) {
    if (!isElement(el) || env.isOwn?.(el)) return false;
    const tag = tagOf(el);
    if (ROOT_TAGS.has(tag) || (el.namespaceURI === SVG_NS && tag !== 'svg')) return false;
    const display = String(env.displayOf(el) || '');
    if (display === 'none' || display === 'contents') return false;
    if ((display === 'inline' || display.startsWith('ruby')) && !MEDIA_TAGS.has(tag)) return false;
    return !isTinyRect(env.rectOf(el));
  }
  function hasContent(el) {
    if (MEDIA_TAGS.has(tagOf(el))) return true;
    if (String(el.textContent || '').trim()) return true;
    try { return !!el.querySelector?.(MEDIA_SELECTOR); } catch { return false; }
  }
  // From the deepest element under the pointer up to the nearest meaningful block; null over the page background
  // or our own UI.
  function climbToBlock(node, env) {
    let current = node && node.nodeType === 3 ? composedParent(node) : node;
    for (let steps = 0; current && steps < 256; current = composedParent(current), steps++) {
      if (!isElement(current)) continue;
      if (env.isOwn?.(current) || ROOT_TAGS.has(tagOf(current))) return null;
      if (isCandidate(current, env)) return current;
    }
    return null;
  }
  // "+": the nearest ancestor with a different box, skipping same-size wrappers; never the page itself.
  function growTarget(el, env) {
    const base = env.rectOf(el);
    for (let parent = composedParent(el), steps = 0; parent && steps < 256; parent = composedParent(parent), steps++) {
      if (env.isOwn?.(parent) || ROOT_TAGS.has(tagOf(parent))) return null;
      if (!isCandidate(parent, env)) continue;
      if (!sameBox(env.rectOf(parent), base)) return parent;
    }
    return null;
  }
  // Rendered children: a shadow root's, a <slot>'s assigned elements (or its fallback content), else the light DOM's.
  function childElements(el) {
    if (tagOf(el) === 'slot') {
      let assigned = [];
      try { assigned = [...(el.assignedElements?.({ flatten: true }) || [])]; } catch { assigned = []; }
      return assigned.length ? assigned : [...(el.children || [])];
    }
    const shadow = el.shadowRoot ? [...(el.shadowRoot.children || [])] : [];
    return shadow.length ? shadow : [...(el.children || [])];
  }
  // Wrappers that draw no block box of their own, so "−" looks inside them: display: contents, inline elements (a link
  // around a card, or a custom element without styles) and <slot>s.
  function seeThrough(el, env) {
    if (!isElement(el) || env.isOwn?.(el) || MEDIA_TAGS.has(tagOf(el))) return false;
    if (tagOf(el) === 'slot') return true;
    const display = String(env.displayOf(el) || '');
    return display === 'contents' || display === 'inline';
  }
  // The meaningful children of a part in order: candidates with content, found through see-through wrappers (bounded).
  function meaningfulChildren(el, env) {
    const out = [], stack = [...childElements(el)].reverse();
    for (let steps = 0; stack.length && steps < 512; steps++) {
      const kid = stack.pop();
      if (!isElement(kid)) continue;
      // A slot is never the part itself (its own text is only fallback content): always look at what it shows.
      if (tagOf(kid) !== 'slot' && isCandidate(kid, env)) { if (hasContent(kid)) out.push(kid); } else if (seeThrough(kid, env)) stack.push(...[...childElements(kid)].reverse());
    }
    return out;
  }
  // "−": undo the last widen first; then step toward the element that was under the pointer; then the first
  // meaningful child (looking through same-size wrappers and see-through ones). Returns { el, history } or null when
  // nothing is narrower.
  function narrowTarget(state, env) {
    const history = [...(state.history || [])];
    while (history.length) {
      const previous = history.pop();
      if (previous && previous !== state.el && isConnected(previous) && composedContains(state.el, previous)) return { el: previous, history };
    }
    const base = env.rectOf(state.el);
    if (state.anchor && state.anchor !== state.el && composedContains(state.el, state.anchor)) {
      const chain = [];
      for (let node = state.anchor; node && node !== state.el; node = composedParent(node)) chain.unshift(node);
      for (const node of chain) if (isCandidate(node, env) && !sameBox(env.rectOf(node), base)) return { el: node, history: [] };
    }
    let parent = state.el;
    for (let depth = 0; parent && depth < 12; depth++) {
      const kids = meaningfulChildren(parent, env);
      const narrower = kids.find(kid => !sameBox(env.rectOf(kid), base));
      if (narrower) return { el: narrower, history: [] };
      parent = kids[0] || null;
    }
    return null;
  }
  // Selections never nest: a candidate inside (or equal to) a selection is refused, and one that contains
  // selections absorbs them. The limit counts what remains after absorbing.
  function planSelect(selected, candidate, maxSelections) {
    if (selected.some(el => composedContains(el, candidate))) return { action: 'inside', absorbed: [] };
    const absorbed = selected.filter(el => composedContains(candidate, el));
    if (selected.length - absorbed.length + 1 > maxSelections) return { action: 'limit', absorbed: [] };
    return { action: 'add', absorbed };
  }
  // A scroll container on the axis a wheel moves: overflow that scrolls and content larger than the box. Whether it
  // still has room in that direction is checked by trying (scrollLeft is negative in right-to-left boxes).
  function scrollsOn(el, dx, dy, overflow) {
    return (!!dy && SCROLLABLE.has(String(overflow?.y || '')) && el.scrollHeight > el.clientHeight + 1)
      || (!!dx && SCROLLABLE.has(String(overflow?.x || '')) && el.scrollWidth > el.clientWidth + 1);
  }

  function declarations(text) {
    const output = [];
    for (const part of String(text || '').split(';')) {
      const colon = part.indexOf(':');
      if (colon < 1) continue;
      const property = part.slice(0, colon).trim(), value = part.slice(colon + 1).trim();
      if (property && value) output.push([property, value]);
    }
    return output;
  }
  const stylesheetText = () => Object.entries(STYLES).map(([name, body]) => `.${name} { ${body}; }`).join('\n') + '\n' + EXTRA_CSS.trim() + '\n';

  // --- Plain-text reader, used only when content/article-extract.js is missing or fails --------------------------

  function normalizeText(text) {
    return String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t\f\v ]+/g, ' ')
      .split('\n').map(line => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  // Page text is data, not Markdown: escape what Still's renderer would treat as syntax.
  function escapeMarkdownLine(line) {
    const out = String(line ?? '').replace(/[\\`*_~[\]<|]/g, '\\$&');
    const ordered = /^(\d+)([.)])\s/.exec(out);
    if (ordered) return ordered[1] + '\\' + out.slice(ordered[1].length);
    return /^(?:#|>|[-+]\s|::|-{3}|={3})/.test(out) ? '\\' + out : out;
  }
  const escapeUrl = url => url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');
  function plainPart(el, toMarkdown, baseUrl) {
    if (typeof toMarkdown === 'function') {
      try { const markdown = String(toMarkdown(el, { baseUrl }) || '').trim(); if (markdown) return markdown; } catch { /* fall through to text */ }
    }
    const tag = tagOf(el);
    if (tag === 'img') {
      const src = String(el.currentSrc || el.src || '');
      return /^https?:\/\//i.test(src) ? `![${escapeMarkdownLine(String(el.alt || '').replace(/\s+/g, ' ').trim())}](${escapeUrl(src)})` : '';
    }
    const text = normalizeText(el.innerText ?? el.textContent);
    if (!text) return '';
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) return '#'.repeat(Math.min(3, Number(heading[1]))) + ' ' + escapeMarkdownLine(text.replace(/\s+/g, ' '));
    return text.split(/\n+/).filter(Boolean).map(escapeMarkdownLine).join('\n\n');
  }
  // Cut on a paragraph boundary when one exists in the second half, otherwise on a line, then a word, then hard.
  function cutAtBoundary(text, max) {
    if (text.length <= max) return text;
    const head = text.slice(0, max);
    const cut = [head.lastIndexOf('\n\n'), head.lastIndexOf('\n'), head.search(/\s\S*$/)].find(index => index > max / 2);
    return (cut === undefined ? head : head.slice(0, cut)).trim();
  }
  function pageMeta(doc, loc) {
    const url = String(loc?.href || '');
    const find = selector => { try { return doc?.querySelector?.(selector) || null; } catch { return null; } };
    const meta = name => String(find(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute?.('content') || '').trim();
    const canonical = String(find('link[rel~="canonical"]')?.href || meta('og:url'));
    let fallbackTitle = url;
    try { const parsed = new URL(url); fallbackTitle = parsed.host + parsed.pathname + parsed.search + parsed.hash; } catch { /* keep the raw address */ }
    return {
      url, canonicalUrl: /^https?:\/\//i.test(canonical) ? canonical : url,
      title: String(doc?.title || '').trim() || meta('og:title') || fallbackTitle,
      siteName: meta('og:site_name').slice(0, 200), author: meta('author').slice(0, 300), publishedAt: '',
      lang: String(doc?.documentElement?.lang || '').slice(0, 35), dir: String(doc?.documentElement?.dir || ''),
      icon: '', cover: '',
    };
  }
  function fallbackResult(elements, { toMarkdown = null, doc = null, loc = null, maxChars = MAX_CHARS } = {}) {
    const parts = [];
    let used = 0, truncated = false;
    for (const el of elements) {
      const markdown = plainPart(el, toMarkdown, String(loc?.href || ''));
      if (!markdown) continue;
      const cost = (parts.length ? 2 : 0) + markdown.length;
      if (used + cost > maxChars) {
        // Whole parts only, like the converter's block-boundary cut; a lone oversized first part is shortened.
        truncated = true;
        if (!parts.length) { const cut = cutAtBoundary(markdown, maxChars); if (cut) parts.push(cut); }
        break;
      }
      parts.push(markdown); used += cost;
    }
    const markdown = parts.join('\n\n');
    if (!markdown.trim()) return { ok: false, code: 'empty', error: 'The selected parts have no text to save.' };
    const text = cutAtBoundary(elements.map(el => normalizeText(el.innerText ?? el.textContent)).filter(Boolean).join('\n\n'), maxChars);
    const wordCount = (text.match(/\S+/g) || []).length;
    return {
      ok: true, source: 'selection', ...pageMeta(doc, loc),
      excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 300), markdown, text,
      wordCount, readingMinutes: wordCount ? Math.max(1, Math.round(wordCount / 230)) : 0,
      images: [], truncated, selectionCount: elements.length,
    };
  }
  function finalizeResult(result, count) {
    if (result.ok === false) {
      return { ok: false, code: ['empty', 'unreadable', 'error'].includes(result.code) ? result.code : 'error',
        error: typeof result.error === 'string' && result.error.trim() ? result.error : 'Still could not read the selected parts.' };
    }
    return { ...result, ok: true, source: 'selection', selectionCount: count };
  }
  // The shared converter (content/article-extract.js, contract §3) when it is loaded; otherwise a plain reader so a
  // missing or failing converter never loses the user's picks.
  function readSelection(elements, { article = null, doc = null, loc = null, maxChars = MAX_CHARS } = {}) {
    if (article && typeof article.fromElements === 'function') {
      let result = null;
      try { result = article.fromElements(elements, { maxChars }); } catch { result = null; }
      if (result && typeof result === 'object') return finalizeResult(result, elements.length);
    }
    const toMarkdown = article && typeof article.toMarkdown === 'function' ? (el, options) => article.toMarkdown(el, options) : null;
    return fallbackResult(elements, { toMarkdown, doc, loc, maxChars });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------------------------------------------

  let session = null;

  function send(message) {
    // The receiver may be gone (panel closed, extension reloaded): nothing useful can be done from the page then.
    try { globalThis.chrome?.runtime?.sendMessage?.(message)?.catch?.(() => {}); } catch { /* context invalidated */ }
  }

  // A key the picker consumed (Enter that finished, Esc that cancelled) is usually still down when the overlay goes
  // away, and its keyup and auto-repeats would land on the restored focus: a search box that submits on keyup Enter,
  // a dialog that closes on keyup Escape. This one-shot guard outlives the session only until those keys come up; it
  // also drops itself on any other key press, a pointer press or the window losing focus.
  function holdKeys(keys) {
    const pending = new Set(keys);
    if (!pending.size) return;
    const guard = new AbortController(), options = { capture: true, signal: guard.signal };
    globalThis.addEventListener('keyup', event => {
      if (!event.isTrusted || !pending.delete(event.key)) return;
      swallow(event);
      if (!pending.size) guard.abort();
    }, options);
    globalThis.addEventListener('keydown', event => {
      if (!event.isTrusted) return;
      if (event.repeat && pending.has(event.key)) swallow(event); else guard.abort();
    }, options);
    globalThis.addEventListener('pointerdown', event => { if (event.isTrusted) guard.abort(); }, options);
    globalThis.addEventListener('blur', event => { if (event.isTrusted && event.target === globalThis) guard.abort(); }, options);
  }

  // Constructed stylesheets are the first choice: page CSS cannot reach them and they need no inline <style>.
  // Whether a strict page CSP lets them apply is unverified (capture-decision.md, Unresolved), so start() probes the
  // result and falls back to per-element inline declarations; CSSOM writes are not governed by style-src.
  function adoptStyles(shadow, doc) {
    const css = stylesheetText();
    try {
      if (typeof globalThis.CSSStyleSheet === 'function' && 'adoptedStyleSheets' in shadow) {
        const sheet = new globalThis.CSSStyleSheet();
        sheet.replaceSync(css);
        shadow.adoptedStyleSheets = [sheet];
        return true;
      }
    } catch { /* try a style element */ }
    try { const style = doc.createElement('style'); style.textContent = css; shadow.appendChild(style); return true; } catch { return false; }
  }

  function openSession({ requestId, from, maxSelections }) {
    const doc = globalThis.document, root = doc?.documentElement;
    if (!root || !doc.body) throw new Error('This page cannot be selected from.');
    const controller = new AbortController(), signal = controller.signal;
    const selections = [], shields = [];
    const heldKeys = new Set();               // keys whose keydown the picker consumed and that are not up yet
    const timers = { frame: 0, toast: 0, sweep: 0 };
    const placed = new WeakMap();
    const previousFocus = doc.activeElement;
    let hover = null, pointerTarget = null, ended = false, nextId = 1, inline = false, attached = false, orderDirty = true;

    const host = doc.createElement(HOST_TAG);
    for (const [property, value] of declarations(HOST_STYLE)) host.style.setProperty(property, value, 'important');
    const shadow = host.attachShadow({ mode: 'closed' });
    const styled = adoptStyles(shadow, doc);
    const applyInline = (el, classes) => {
      for (const name of String(classes).split(/\s+/)) for (const [property, value] of declarations(STYLES[name])) el.style.setProperty(property, value);
    };
    // Until the host is attached and the stylesheet probed, classed nodes are remembered for the inline fallback.
    const unstyled = [];
    const make = (tag, classes = '', attributes = {}) => {
      const el = doc.createElement(tag);
      if (classes) { el.setAttribute('class', classes); if (inline) applyInline(el, classes); else if (!attached) unstyled.push([el, classes]); }
      for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
      return el;
    };
    const layer = shadow.appendChild(make('div', 'layer'));
    const shieldLayer = layer.appendChild(make('div'));
    const hoverBox = layer.appendChild(make('div', 'hover', { 'aria-hidden': 'true' }));
    const boxLayer = layer.appendChild(make('div', '', { 'aria-hidden': 'true' }));
    const barLayer = layer.appendChild(make('div'));
    const toast = layer.appendChild(make('div', 'toast', { role: 'status', 'aria-live': 'polite' }));
    const panel = layer.appendChild(make('div', 'panel', { role: 'group', 'aria-label': 'Select parts of the page', tabindex: '-1' }));
    const count = panel.appendChild(make('span', 'count'));
    const keys = panel.appendChild(make('span', 'keys'));
    const done = panel.appendChild(make('button', 'action primary', { type: 'button', title: 'Finish selecting (Enter)' }));
    const cancelButton = panel.appendChild(make('button', 'action secondary', { type: 'button', title: 'Stop selecting (Esc)' }));
    const status = layer.appendChild(make('div', 'sr', { role: 'status', 'aria-live': 'polite' }));
    keys.textContent = 'Use ↑ ↓ to widen or narrow';
    done.textContent = 'Done';
    cancelButton.textContent = 'Cancel';
    hoverBox.style.visibility = 'hidden';

    const env = {
      rectOf,
      displayOf: el => { try { return String(globalThis.getComputedStyle(el).display || ''); } catch { return ''; } },
      isOwn: el => el === host,
    };
    // Zero-size boxes (display: contents wrappers, collapsed floats) borrow the union of their children's boxes.
    function rectOf(el) {
      let rect = null;
      try { rect = edges(el.getBoundingClientRect()); } catch { return null; }
      if (!emptyRect(rect) || !el.children?.length) return rect;
      const kids = [];
      for (const kid of [...el.children].slice(0, 64)) { try { kids.push(kid.getBoundingClientRect()); } catch { /* skip */ } }
      return unionRect(kids) || rect;
    }
    const setVisible = (el, visible) => { if (el.style.visibility !== (visible ? 'visible' : 'hidden')) el.style.visibility = visible ? 'visible' : 'hidden'; };
    function place(el, rect, viewport) {
      if (!rect || emptyRect(rect) || offscreen(rect, viewport)) { setVisible(el, false); return false; }
      const key = `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
      if (placed.get(el) !== key) {
        placed.set(el, key);
        el.style.transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
        el.style.width = `${Math.round(rect.width)}px`;
        el.style.height = `${Math.round(rect.height)}px`;
      }
      setVisible(el, true);
      return true;
    }
    function placeBar(bar, rect, viewport) {
      if (!rect) { setVisible(bar, false); return; }
      const { x, y } = barPosition(rect, viewport);
      const key = `${x},${y}`;
      if (placed.get(bar) !== key) { placed.set(bar, key); bar.style.transform = `translate(${x}px, ${y}px)`; }
      setVisible(bar, true);
    }

    const resizeObserver = typeof globalThis.ResizeObserver === 'function' ? new globalThis.ResizeObserver(() => schedule()) : null;
    const observe = el => { try { resizeObserver?.observe(el); } catch { /* not observable */ } };
    const unobserve = el => { try { resizeObserver?.unobserve(el); } catch { /* already gone */ } };

    function schedule() {
      if (!ended && !timers.frame) timers.frame = globalThis.requestAnimationFrame(paint);
    }
    function showToast(text, duration = HINT_MS) {
      clearTimeout(timers.toast);
      toast.textContent = text;
      setVisible(toast, true);
      timers.toast = duration ? setTimeout(() => { timers.toast = 0; setVisible(toast, false); }, duration) : 0;
    }
    function hideIntro() {
      if (toast.textContent === INTRO) { clearTimeout(timers.toast); timers.toast = 0; setVisible(toast, false); }
    }
    function refreshCount() {
      const label = countLabel(selections.length);
      if (count.textContent === label) return;
      count.textContent = label;
      status.textContent = label;
      done.disabled = selections.length === 0;
      // Set directly so the disabled look survives the inline-style fallback, which has no :disabled rule.
      done.style.opacity = selections.length ? '1' : '0.45';
    }
    function changed() {
      orderDirty = true;
      refreshCount();
      schedule();
    }

    function iconButton(name, label, action) {
      const button = make('button', 'btn', { type: 'button', 'aria-label': label, title: label });
      const svg = doc.createElementNS(SVG_NS, 'svg');
      for (const [attribute, value] of Object.entries({ class: 'icon', viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor',
        'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(attribute, value);
      if (inline) applyInline(svg, 'icon');
      for (const d of ICONS[name]) { const path = doc.createElementNS(SVG_NS, 'path'); path.setAttribute('d', d); svg.appendChild(path); }
      button.appendChild(svg);
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (event.isTrusted && !ended) action(); }, { signal });
      return button;
    }
    function addSelection(el, anchor, history) {
      const record = { id: nextId++, el, anchor, history, label: '' };
      record.box = boxLayer.appendChild(make('div', 'box'));
      record.bar = barLayer.appendChild(make('div', 'bar', { role: 'group' }));
      setVisible(record.box, false);
      setVisible(record.bar, false);
      record.number = record.bar.appendChild(make('span', 'num', { 'aria-hidden': 'true' }));
      record.bar.appendChild(iconButton('minus', 'Narrow selection', () => narrowSelection(record)));
      record.bar.appendChild(iconButton('plus', 'Widen selection', () => widenSelection(record)));
      record.bar.appendChild(iconButton('x', 'Remove selection', () => removeSelection(record)));
      selections.push(record);
      observe(el);
      return record;
    }
    function removeSelection(record, notify = true) {
      const index = selections.indexOf(record);
      if (index < 0) return;
      selections.splice(index, 1);
      record.box.remove();
      record.bar.remove();
      unobserve(record.el);
      if (notify) changed();
    }
    function replaceElement(record, el, history) {
      unobserve(record.el);
      record.el = el;
      record.history = history;
      observe(el);
    }

    function setPointerTarget(target) {
      if (target === pointerTarget) return;
      pointerTarget = target;
      const el = target ? climbToBlock(target, env) : null;
      hover = el ? { el, anchor: target, history: [] } : null;
      schedule();
    }
    function selectAt(target) {
      if (!target) return;
      const candidate = hover && hover.anchor === target ? hover.el : climbToBlock(target, env);
      if (!candidate) { showToast('Click a block of content, such as a paragraph or an image.'); return; }
      const plan = planSelect(selections.map(record => record.el), candidate, maxSelections);
      if (plan.action === 'inside') { showToast('That part is already selected. Use − to narrow it or × to remove it.'); return; }
      if (plan.action === 'limit') { showToast(`You can select up to ${maxSelections} parts.`); return; }
      for (const record of selections.filter(record => plan.absorbed.includes(record.el))) removeSelection(record, false);
      addSelection(candidate, target, hover && hover.el === candidate ? [...hover.history] : []);
      hideIntro();
      if (plan.absorbed.length) showToast(`Merged ${countLabel(plan.absorbed.length)} into this one.`);
      changed();
    }
    function widenSelection(record) {
      const next = growTarget(record.el, env);
      if (!next) { showToast('This part cannot be widened any further.'); return; }
      const absorbed = selections.filter(other => other !== record && composedContains(next, other.el));
      for (const other of absorbed) removeSelection(other, false);
      replaceElement(record, next, [...record.history, record.el]);
      if (absorbed.length) showToast(`Merged with ${absorbed.length} other selection${absorbed.length === 1 ? '' : 's'}.`);
      changed();
    }
    function narrowSelection(record) {
      const next = narrowTarget(record, env);
      if (!next) { showToast('This part cannot be narrowed any further.'); return; }
      replaceElement(record, next.el, next.history);
      changed();
    }
    function widenHover() {
      const next = growTarget(hover.el, env);
      if (!next) { showToast('This part cannot be widened any further.'); return; }
      hover = { ...hover, el: next, history: [...hover.history, hover.el] };
      schedule();
    }
    function narrowHover() {
      const next = narrowTarget(hover, env);
      if (!next) { showToast('This part cannot be narrowed any further.'); return; }
      hover = { ...hover, el: next.el, history: next.history };
      schedule();
    }

    function finish() {
      if (ended) return;
      const elements = documentOrder(selections.map(record => record.el).filter(isConnected));
      if (!elements.length) { showToast('Select at least one part first, or press Esc to cancel.'); return; }
      let result;
      try { result = readSelection(elements, { article: globalThis.__stillArticle, doc, loc: globalThis.location, maxChars: MAX_CHARS }); }
      catch { result = { ok: false, code: 'error', error: 'Still could not read the selected parts.' }; }
      send({ type: 'still:picker-result', requestId, from, result });
      close();
    }
    function cancel() {
      if (ended) return;
      send({ type: 'still:picker-result', requestId, from, cancelled: true });
      close();
    }
    function close() {
      if (ended) return;
      ended = true;
      controller.abort();
      if (timers.frame) globalThis.cancelAnimationFrame(timers.frame);
      clearTimeout(timers.toast);
      clearInterval(timers.sweep);
      timers.frame = timers.toast = timers.sweep = 0;
      resizeObserver?.disconnect();
      host.remove();
      selections.length = 0;
      hover = pointerTarget = null;
      try {
        if (previousFocus && previousFocus !== doc.body && previousFocus !== host && isConnected(previousFocus) && typeof previousFocus.focus === 'function') previousFocus.focus({ preventScroll: true });
      } catch { /* the page moved focus elsewhere */ }
      // After the focus moves back, so its own focus and blur events cannot drop the guard.
      holdKeys(heldKeys);
      heldKeys.clear();
      if (session === handle) session = null;
    }

    function paint() {
      timers.frame = 0;
      if (ended) return;
      // Some pages prune foreign nodes; put the overlay back rather than leave the user without controls.
      if (!host.isConnected) (doc.documentElement || root).appendChild(host);
      const viewport = overlaySize(layer, globalThis);
      const gone = selections.filter(record => !isConnected(record.el));
      if (gone.length) { for (const record of gone) removeSelection(record, false); orderDirty = true; refreshCount(); }
      if (orderDirty) {
        orderDirty = false;
        const ordered = [...selections].sort((a, b) => compareDocumentOrder(a.el, b.el));
        ordered.forEach((record, index) => {
          const label = String(index + 1);
          if (record.label === label) return;
          record.label = label;
          record.number.textContent = label;
          record.bar.setAttribute('aria-label', `Selection ${label}`);
        });
      }
      const hovered = hover && isConnected(hover.el) && !selections.some(record => composedContains(record.el, hover.el)) ? hover.el : null;
      place(hoverBox, hovered ? rectOf(hovered) : null, viewport);
      for (const record of selections) {
        const rect = rectOf(record.el);
        placeBar(record.bar, place(record.box, rect, viewport) ? rect : null, viewport);
      }
      paintShields(viewport);
    }
    // Pointer events over an iframe go to the frame's own document, where the picker does not run. A transparent
    // shield over each frame that can take pointer input keeps hovering and clicking working there and stops clicks
    // reaching the frame. A shield only catches the event: pageAt() decides what is really under the pointer.
    function paintShields(viewport) {
      let frames = [], used = 0;
      try { frames = [...doc.querySelectorAll(FRAME_SELECTOR)]; } catch { frames = []; }
      for (const frame of frames) {
        if (used >= MAX_SHIELDS) break;
        let rect = null;
        try { rect = edges(frame.getBoundingClientRect()); } catch { continue; }
        if (emptyRect(rect) || offscreen(rect, viewport) || !takesPointer(frame)) continue;
        const shield = shields[used] || (shields[used] = shieldLayer.appendChild(make('div', 'shield', { 'aria-hidden': 'true' })));
        place(shield, rect, viewport);
        used++;
      }
      for (let index = used; index < shields.length; index++) setVisible(shields[index], false);
    }
    // Hidden, transparent and pointer-events: none frames never receive the pointer, so the page around them already
    // gets every event; a shield there would only hide the page content drawn over or under them.
    function takesPointer(frame) {
      try {
        if (typeof frame.checkVisibility === 'function'
          && !frame.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })) return false;
        const style = globalThis.getComputedStyle(frame);
        return style.pointerEvents !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
      } catch { return false; }
    }
    // The page element under a point: the topmost hit past our own host (whose shields are the only parts that take
    // hits), followed into open shadow roots the way a dispatched event's target is. Elements with
    // pointer-events: none or visibility: hidden are not hit, so a frame is the answer only where it is on top.
    function pageAt(x, y) {
      let found = null;
      for (let scope = doc, depth = 0; scope && depth < 32; depth++) {
        let stack = [];
        try { stack = [...(scope.elementsFromPoint(x, y) || [])]; } catch { break; }
        const top = stack.find(el => el !== host) || null;
        if (!top || top === found) break;
        found = top;
        scope = top.shadowRoot;
      }
      return found;
    }

    const ours = event => { try { return (event.composedPath?.() || [event.target]).includes(host); } catch { return event.target === host; } };
    function pageTarget(event) {
      let first = null;
      try { first = event.composedPath?.()[0] || event.target; } catch { first = event.target; }
      return isElement(first) ? first : composedParent(first);
    }
    // Handlers on window in the capture phase run before page handlers on the target. Only trusted input counts:
    // a page script cannot select, finish or cancel on the user's behalf.
    function onPointerMove(event) {
      if (!event.isTrusted || ours(event)) return;
      setPointerTarget(pageTarget(event));
    }
    function onPointerOut(event) {
      if (event.isTrusted && !event.relatedTarget) setPointerTarget(null);
    }
    // pointerdown/up are only stopped: cancelling them would also drop the mouse events cancelled below. Cancelling
    // mousedown is what keeps focus, text selection and drags from starting. Right-clicks keep the context menu.
    function onPointerPress(event) {
      if (!event.isTrusted || event.button === 2 || ours(event)) return;
      event.stopImmediatePropagation();
    }
    function onMousePress(event) {
      if (!event.isTrusted || event.button === 2 || ours(event)) return;
      swallow(event);
    }
    function onClick(event) {
      if (!event.isTrusted || ours(event)) return;
      swallow(event);
      if (event.button === 0) selectAt(pageTarget(event));
    }
    // A key the picker acts on is consumed whole: its keyup is swallowed too (see onKeyUp and holdKeys).
    function onKeyDown(event) {
      if (!event.isTrusted || event.isComposing) return;
      const inUi = ours(event);
      if (event.key === 'Escape' || event.key === 'Esc') { heldKeys.add(event.key); swallow(event); cancel(); return; }
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      if (plain && event.key === 'Enter') {
        heldKeys.add(event.key);
        // A focused picker button activates itself (its default action); the page still never sees the key.
        if (inUi && tagOf(shadow.activeElement) === 'button') { event.stopImmediatePropagation(); return; }
        swallow(event);
        finish();
        return;
      }
      if (plain && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && hover?.el && isConnected(hover.el)) {
        heldKeys.add(event.key);
        swallow(event);
        if (event.key === 'ArrowUp') widenHover(); else narrowHover();
        return;
      }
      if (plain && (event.key === ' ' || event.key === 'Spacebar') && !(inUi && tagOf(shadow.activeElement) === 'button')) {
        if (hover?.el && isConnected(hover.el)) {
          heldKeys.add(event.key);
          swallow(event);
          const existing = selections.find(record => record.el === hover.el);
          if (existing) removeSelection(existing); else selectAt(hover.el);
          return;
        }
        if (inUi) {
          const first = meaningfulChildren(doc.body, env)[0] || null;
          if (first) { heldKeys.add(event.key); swallow(event); hover = { el: first, anchor: first, history: [] }; schedule(); return; }
        }
      }
      // Page shortcuts never see keys typed while focus is on the picker's own controls.
      if (inUi) event.stopImmediatePropagation();
    }
    function onKeyUp(event) {
      if (!event.isTrusted) return;
      if (heldKeys.delete(event.key)) swallow(event);
      else if (ours(event)) event.stopImmediatePropagation();
    }
    // Inside our own shadow tree the target is visible: a shield stands for whatever page element is under the
    // pointer there (the frame, or content drawn over it); anything else is our UI.
    function onUiPointerMove(event) {
      if (!event.isTrusted) return;
      setPointerTarget(shields.includes(event.target) ? pageAt(event.clientX, event.clientY) : null);
    }
    function onUiClick(event) {
      if (!event.isTrusted || !shields.includes(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      selectAt(pageAt(event.clientX, event.clientY));
    }
    function onUiPress(event) {
      if (shields.includes(event.target)) event.preventDefault();
    }
    // The host is fixed, so a wheel over a shield would scroll the root even when the frame sits in a scroll
    // container. Scroll the nearest container under the pointer that can still move; otherwise the root scrolls as
    // usual. Ctrl+wheel stays the browser's zoom.
    function onUiWheel(event) {
      if (!event.isTrusted || event.ctrlKey || !shields.includes(event.target)) return;
      const scale = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? globalThis.innerHeight || 0 : 1;
      const dx = (Number(event.deltaX) || 0) * scale, dy = (Number(event.deltaY) || 0) * scale;
      if (!dx && !dy) return;
      const top = doc.scrollingElement || root;
      for (let el = pageAt(event.clientX, event.clientY), steps = 0; isElement(el) && el !== top && tagOf(el) !== 'html' && steps < 256; el = composedParent(el), steps++) {
        let overflow = null;
        try { const style = globalThis.getComputedStyle(el); overflow = { x: style.overflowX, y: style.overflowY }; } catch { continue; }
        if (!scrollsOn(el, dx, dy, overflow)) continue;
        const before = `${el.scrollLeft},${el.scrollTop}`;
        try { el.scrollBy({ left: dx, top: dy, behavior: 'instant' }); } catch { continue; }
        if (`${el.scrollLeft},${el.scrollTop}` !== before) { event.preventDefault(); return; }
      }
    }

    const handle = { requestId, cancel, close };
    try {
      root.appendChild(host);
      let probe = '';
      try { probe = String(globalThis.getComputedStyle(layer).position || ''); } catch { probe = ''; }
      inline = !styled || probe !== 'absolute';
      if (inline) for (const [el, classes] of unstyled) applyInline(el, classes);
      unstyled.length = 0;
      attached = true;

      const listen = (target, type, handler, passive = false) => target.addEventListener(type, handler, { capture: true, passive, signal });
      listen(globalThis, 'pointermove', onPointerMove, true);
      listen(globalThis, 'pointerout', onPointerOut, true);
      for (const type of ['pointerdown', 'pointerup']) listen(globalThis, type, onPointerPress);
      for (const type of ['mousedown', 'mouseup', 'dblclick', 'auxclick']) listen(globalThis, type, onMousePress);
      listen(globalThis, 'click', onClick);
      listen(globalThis, 'keydown', onKeyDown);
      listen(globalThis, 'keyup', onKeyUp);
      listen(globalThis, 'scroll', schedule, true);
      listen(globalThis, 'resize', schedule, true);
      listen(globalThis, 'pagehide', event => { if (event.isTrusted) cancel(); });
      listen(shadow, 'pointermove', onUiPointerMove, true);
      listen(shadow, 'click', onUiClick);
      listen(shadow, 'mousedown', onUiPress);
      listen(shadow, 'wheel', onUiWheel);
      const stopUiBubble = event => { event.stopPropagation(); };
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick']) {
        shadow.addEventListener(type, stopUiBubble, { signal });
      }
      done.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (event.isTrusted) finish(); }, { signal });
      cancelButton.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (event.isTrusted) cancel(); }, { signal });
      timers.sweep = setInterval(schedule, SWEEP_MS);

      showToast(INTRO, 0);
      changed();
      try { panel.focus({ preventScroll: true }); } catch { /* focus is optional */ }
    } catch (error) {
      close();
      throw error;
    }
    return handle;
  }

  function start(options = {}) {
    const settings = normalizeStart(options);
    if (session) {
      if (session.requestId === settings.requestId) return { started: true, requestId: settings.requestId };
      // A newer request replaces the running one; its requester hears that it was cancelled.
      session.cancel();
    }
    session = openSession(settings);
    return { started: true, requestId: settings.requestId };
  }
  // Teardown without a message: the caller (the service worker) already knows.
  function stop() {
    if (!session) return { stopped: false };
    session.close();
    session = null;
    return { stopped: true };
  }
  const isActive = () => !!session;

  globalThis.__stillPicker = Object.freeze({
    start, stop, isActive,
    _test: Object.freeze({
      INTRO, MAX_CHARS, BAR_SIZE, STYLES, countLabel, clampInt, normalizeStart, edges, emptyRect, sameBox, unionRect, isTinyRect,
      offscreen, overlaySize, barPosition, composedParent, composedContains, compareDocumentOrder, documentOrder, isCandidate, climbToBlock,
      growTarget, narrowTarget, meaningfulChildren, planSelect, scrollsOn, declarations, stylesheetText, normalizeText, escapeMarkdownLine, plainPart,
      cutAtBoundary, pageMeta, fallbackResult, finalizeResult, readSelection,
    }),
  });
})();
