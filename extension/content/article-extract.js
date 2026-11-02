// Article extraction for "Save article" and the multi-select picker. This is a classic script (no import or export)
// injected with executeScript({ files: ['lib/vendor/readability.js', 'content/article-extract.js'] }) into the page's
// ISOLATED world, where it defines one global, globalThis.__stillArticle:
//   extract({ maxChars })               the main article (site readers, then Readability, then article/main/body)
//   fromElements(elements, { maxChars }) the parts a user picked, in document order
//   toMarkdown(root, { baseUrl })       one subtree as Markdown (tests and the picker)
//   metadata()                          title, site, author, date, language, excerpt, icon and cover
// Readability (Apache-2.0, assets/licenses/readability.txt) only picks and cleans the main content, and it runs on a
// clone because it rewrites the document it is given. Everything else here is original: metadata, icon choice, the
// X, GitHub and YouTube readers, and the HTML to Markdown converter, which emits the dialect lib/markdown.js renders
// and the block editor writes (one block per line, so lines are joined without blank-line spacers). The live page is
// only ever read. Page content is untrusted data: nothing from it runs, results are plain JSON, Markdown carries only
// text plus Still syntax, and every URL is made absolute and limited to http(s) (links may also be mailto).
(() => {
  'use strict';
  const VERSION = 1;
  if (globalThis.__stillArticle?.version === VERSION) return;

  const MAX_CHARS = 250000;                // the item's articleContent cap
  const MIN_ARTICLE_TEXT = 200;            // less text than this from one reader means "try the next one"
  const READABILITY_MAX_ELEMENTS = 30000;  // bigger documents skip Readability (slow there) and use the walker
  const NODE_BUDGET = 150000;              // nodes one conversion may visit before it stops (pathological DOMs)
  const TIME_BUDGET_MS = 4000;
  const MAX_DEPTH = 200;
  const MAX_IMAGES = 50;
  const MAX_TABLE_ROWS = 2000;
  const MIN_IMAGE_PX = 48;
  const EXCERPT_LIMIT = 300;
  const ICON_DATA_LIMIT = 16 * 1024;
  const JSON_LD_LIMIT = 200000;
  const MESSAGES = {
    empty: 'Still could not find any text to save on this page. Try selecting parts of the page instead.',
    unreadable: 'Still can’t read this kind of page. Save it as a link instead.',
    error: 'Something went wrong while reading this page. Reload it and try again, or save it as a link.',
    noSelection: 'Select at least one part of the page to save.',
  };

  const str = value => typeof value === 'string' ? value : value == null ? '' : String(value);
  const clean = (value, max = 2000) => str(value).replace(/[\s\u00a0\u200b]+/g, ' ').trim().slice(0, max);
  const collapse = value => str(value).replace(/[\u200b\u00ad]/g, '').replace(/[\t\n\r\f \u00a0]+/g, ' ');
  const attr = (el, name) => (el && typeof el.getAttribute === 'function' && el.getAttribute(name)) || '';
  const has = (el, name) => !!el && typeof el.hasAttribute === 'function' && el.hasAttribute(name);
  const tagOf = el => str(el && el.localName).toLowerCase();
  const childElements = el => Array.from(el?.children || []);
  const now = () => Date.now();
  const failure = (code, error = MESSAGES[code] || MESSAGES.error) => ({ ok: false, code, error });
  const charLimit = value => { const n = Math.floor(Number(value)); return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_CHARS) : MAX_CHARS; };
  const sameText = (a, b) => str(a).toLowerCase().replace(/\s+/g, '') === str(b).toLowerCase().replace(/\s+/g, '');
  const compareKey = value => clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  function shorten(value, max) {
    const text = clean(value, Infinity);
    if (text.length <= max) return text;
    const cut = text.slice(0, max - 1), space = cut.lastIndexOf(' ');
    return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, '') + '…';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // URLs. Item fields keep the address as given; Markdown destinations also encode parentheses so a plain (url) form
  // always parses, here and in other Markdown tools.

  function httpUrl(value, base) {
    const raw = str(value).trim();
    if (!raw || raw.length > 4096 || /^(?:javascript|vbscript|data|blob|file|about|chrome|chrome-extension|moz-extension):/i.test(raw)) return '';
    try {
      const url = new URL(raw, base || undefined);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password) return url.href;
    } catch { /* Not a usable address. */ }
    return '';
  }
  const encodeParens = url => url.replace(/[()]/g, c => c === '(' ? '%28' : '%29');
  const markdownUrl = (value, base) => encodeParens(httpUrl(value, base));
  function linkUrl(value, base) {
    const raw = str(value).trim();
    if (/^mailto:/i.test(raw)) {
      try { const url = new URL(raw); if (/^[^?\s()<>]+@[^?\s()<>]+$/.test(url.pathname)) return encodeParens(url.href); } catch { /* Malformed mailto. */ }
      return '';
    }
    return markdownUrl(raw, base);
  }
  function iconUrl(value, base) {
    const raw = str(value).trim();
    if (/^data:image\/(?:png|gif|jpeg|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)[;,]/i.test(raw)) return raw.length <= ICON_DATA_LIMIT && !/[\u0000-\u001f]/.test(raw) ? raw : '';
    return httpUrl(raw, base);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Inline Markdown. Literal text is escaped only where it could read back as formatting (the block editor's rules),
  // and bare URLs stay verbatim so they keep reading as links.

  const WORD = /[\p{L}\p{N}]/u, SPACE = /\s/u, PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/;
  function escapedAt(text, index) { let n = 0; while (index > 0 && text[--index] === '\\') n++; return n % 2 === 1; }
  function escapeSpan(text) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i], prev = text[i - 1], next = text[i + 1], edge = prev === undefined || next === undefined;
      if (c === '\\') out += next === undefined || next === '\n' || PUNCT.test(next) ? '\\\\' : '\\';
      else if (c === '`' || c === '[') out += '\\' + c;
      else if (c === '*') out += !edge && SPACE.test(prev) && SPACE.test(next) ? '*' : '\\*';
      else if (c === '_') out += !edge && ((WORD.test(prev) && WORD.test(next)) || (SPACE.test(prev) && SPACE.test(next))) ? '_' : '\\_';
      else if (c === '~') out += prev === '~' || next === '~' || edge ? '\\~' : '~';
      else if (c === '<') out += /[A-Za-z/!?]/.test(next || '') ? '\\<' : '<';
      else out += c;
    }
    return out;
  }
  function trimAutolink(url) {
    const count = (value, ch) => value.split(ch).length - 1;
    for (;;) {
      const last = url.at(-1);
      if (/[.,;:!?*_~'"]/.test(last)) url = url.slice(0, -1);
      else if (last === ')' && count(url, '(') < count(url, ')')) url = url.slice(0, -1);
      else if (last === ']' && count(url, '[') < count(url, ']')) url = url.slice(0, -1);
      else return url;
    }
  }
  function escapeText(value) {
    const text = str(value);
    let out = '', last = 0;
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
      if (match.index > 0 && WORD.test(text[match.index - 1])) continue;
      const url = trimAutolink(match[0]);
      if (!/^https?:\/\/./i.test(url)) continue;
      out += escapeSpan(text.slice(last, match.index)) + url;
      last = match.index + url.length;
    }
    return out + escapeSpan(text.slice(last));
  }
  function escapeLabel(label) { let out = ''; for (let i = 0; i < label.length; i++) { if (label[i] === ']' && !escapedAt(label, i)) out += '\\'; out += label[i]; } return out; }
  function codeSpan(value) {
    const text = str(value).replace(/\n/g, ' ');
    if (!text.trim()) return '';
    const longest = (text.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
    const fence = '`'.repeat(longest + 1);
    const pad = text.startsWith('`') || text.endsWith('`') || /^ .* $/.test(text) ? ' ' : '';
    return fence + pad + text + pad + fence;
  }
  function emphasize(text, marker) {
    const lead = /^\s*/.exec(text)[0], rest = text.slice(lead.length), trail = /\s*$/.exec(rest)[0];
    const core = rest.slice(0, rest.length - trail.length);
    return core ? lead + marker + core + marker + trail : text;
  }
  const oneLine = md => str(md).replace(/\s*\n\s*/g, ' ').replace(/ {2,}/g, ' ').trim();

  // Plain text of inline Markdown this file wrote (excerpts, word counts and the `text` field).
  function inlinePlain(md) {
    const text = str(md);
    let out = '';
    for (let i = 0; i < text.length;) {
      const c = text[i], prev = text[i - 1] || '';
      if (c === '\\' && i + 1 < text.length && PUNCT.test(text[i + 1])) { out += text[i + 1]; i += 2; continue; }
      if (c === '`') {
        const run = /^`+/.exec(text.slice(i))[0];
        const end = text.indexOf(run, i + run.length);
        if (end > 0 && text[end + run.length] !== '`') { out += text.slice(i + run.length, end).replace(/^ (.*) $/, '$1'); i = end + run.length; continue; }
        out += run; i += run.length; continue;
      }
      if (c === '[' || (c === '!' && text[i + 1] === '[')) {
        const start = c === '!' ? i + 1 : i;
        let depth = 0, end = -1;
        for (let k = start; k < text.length; k++) {
          if (escapedAt(text, k)) continue;
          if (text[k] === '[') depth++;
          else if (text[k] === ']' && !--depth) { end = k; break; }
        }
        const close = end > 0 && text[end + 1] === '(' ? text.indexOf(')', end + 2) : -1;
        if (close > 0) { if (c === '[') out += inlinePlain(text.slice(start + 1, end)); i = close + 1; continue; }
      }
      if ((c === 'h' || c === 'H') && !WORD.test(prev)) {
        const url = /^https?:\/\/[^\s<>"'`]+/i.exec(text.slice(i));
        if (url) { out += url[0]; i += url[0].length; continue; }
      }
      if (c === '*' || c === '~' || c === '_') {
        const run = new RegExp(`^\\${c}+`).exec(text.slice(i))[0], next = text[i + run.length] || '';
        const literal = c === '~' ? run.length === 1
          : c === '*' ? run.length === 1 && SPACE.test(prev) && SPACE.test(next)
            : (WORD.test(prev) && WORD.test(next)) || (SPACE.test(prev) && SPACE.test(next));
        if (literal) out += run;
        i += run.length;
        continue;
      }
      out += c; i++;
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The converter: DOM → Still blocks. Inline content accumulates in a paragraph buffer; block elements flush it.

  const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog', 'dir', 'div', 'dl',
    'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'legend', 'li',
    'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
    'picture', 'video', 'audio', 'iframe']);
  const INLINE_TAGS = new Set(['a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'kbd',
    'label', 'mark', 'math', 'nobr', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'img']);
  const SKIP_TAGS = new Set(['script', 'style', 'template', 'head', 'meta', 'link', 'title', 'base', 'button', 'input', 'select', 'textarea', 'option',
    'optgroup', 'datalist', 'canvas', 'svg', 'object', 'embed', 'map', 'area', 'dialog', 'param', 'track', 'source', 'frame', 'frameset', 'applet',
    'noscript', 'wbr']);
  const LIST_TAGS = new Set(['ul', 'ol', 'menu', 'dir']);
  const LIST_BLOCKS = new Set(['bullet', 'number', 'todo']);
  const CHROME_TAGS = new Set(['nav', 'footer', 'aside']);
  const CHROME_ROLES = new Set(['navigation', 'contentinfo', 'complementary', 'search', 'banner', 'dialog', 'alertdialog', 'menu', 'menubar', 'toolbar', 'tablist']);
  const JUNK_TAGS = new Set(['div', 'section', 'ul', 'ol', 'dl', 'aside']);
  const JUNK = /(?:^|[\s_-])(?:cookies?|consent|gdpr|newsletter|subscribe|signup|share|sharing|social|advert|advertisement|ads?|promo|sponsor(?:ed)?|related|recommended|comments?|disqus|breadcrumbs?|sidebar|popup|modal|paywall|outbrain|taboola)(?:$|[\s_-])/i;
  const KEEP = /(?:^|[\s_-])(?:article|body|content|main|post|entry|story|prose)(?:$|[\s_-])/i;
  const GUTTER = /(?:^|\s)(?:gutter|linenos|lineno|line-numbers-rows|line-number|hljs-ln-numbers|rouge-gutter|blob-num|code-line-number|lnt|ln)(?:\s|$)/i;
  const CALLOUT_TITLE = /(?:^|\s)(?:markdown-alert-title|admonition-title|callout-title)(?:\s|$)/i;
  // Wiki "[edit]" links, print-hidden chrome and screen-reader-only text. The edit links also make Readability drop
  // the section headings they sit next to, so they are removed from its clone first.
  const NOISE = /(?:^|\s)(?:mw-editsection|noprint|sr-only|visually-hidden|screen-reader-text)(?:\s|$)/i;
  // Wikipedia-style formula images: hidden from screen readers, their alt text holds the TeX source.
  const MATH_IMAGE = /(?:^|\s)mwe-math-fallback-image(?:-inline|-display)?(?:\s|$)/i;
  const CALLOUT_HOSTS = new Set(['div', 'aside', 'section']);
  const CALLOUT_KINDS = new Set(['note', 'tip', 'important', 'warning', 'caution']);
  const CALLOUT_MAP = { note: 'note', info: 'note', information: 'note', abstract: 'note', summary: 'note', todo: 'note', question: 'note', example: 'note',
    primary: 'note', secondary: 'note', tip: 'tip', hint: 'tip', success: 'tip', check: 'tip', done: 'tip', important: 'important', attention: 'important',
    warning: 'warning', warn: 'warning', caution: 'caution', danger: 'caution', error: 'caution', failure: 'caution', fail: 'caution', bug: 'caution' };
  const MARKS = { strong: 'bold', b: 'bold', em: 'italic', i: 'italic', cite: 'italic', dfn: 'italic', var: 'italic', del: 'strike', s: 'strike', strike: 'strike' };
  const LAZY_SOURCES = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url', 'data-hi-res-src', 'data-full-src', 'data-orig-file', 'data-actualsrc'];
  const LAZY_SRCSETS = ['data-srcset', 'data-lazy-srcset'];
  const PLACEHOLDER = /(?:^|[/_.-])(?:blank|spacer|pixel|transparent|placeholder|lazy[-_]?(?:load|placeholder)|loading|1x1|grey-placeholder|empty)\.(?:gif|png|svg|jpe?g|webp)(?:[?#]|$)/i;
  const TRACKER = /(?:\/\/|\.)(?:doubleclick\.net|google-analytics\.com|googletagmanager\.com|scorecardresearch\.com|quantserve\.com|bat\.bing\.com)\/|facebook\.com\/tr[/?]|\/(?:pixel|beacon)(?:\.gif|\.png)?(?:[/?#]|$)|\/(?:track|tracking|collect|impression)\.(?:gif|png)(?:[?#]|$)/i;

  function createState({ base = '', strip = false, live = false } = {}) {
    return { base, strip, live, budget: NODE_BUDGET, exhausted: false, clipped: false, ticks: 0, deadline: now() + TIME_BUDGET_MS, blockMemo: new WeakMap(), imageMemo: new WeakMap() };
  }
  function tick(state) {
    if (state.exhausted) return false;
    if (--state.budget < 0 || ((++state.ticks & 255) === 0 && now() > state.deadline)) { state.exhausted = true; return false; }
    return true;
  }
  const sink = (state, listIndent = 0) => ({ state, blocks: [], para: '', lastImage: false, listIndent });

  // Children as rendered: in the live page an open shadow root (and its slots) replaces the light DOM.
  function kids(node, state) {
    if (state.live && node.nodeType === 1) {
      const shadow = node.shadowRoot;
      if (shadow && shadow.childNodes) return Array.from(shadow.childNodes);
      if (tagOf(node) === 'slot' && typeof node.assignedNodes === 'function') {
        const assigned = node.assignedNodes({ flatten: true });
        if (assigned.length) return Array.from(assigned);
      }
    }
    return Array.from(node.childNodes || []);
  }

  function hiddenByStyle(el) {
    if (typeof getComputedStyle !== 'function') return false;
    try { const style = getComputedStyle(el); return style.display === 'none' || style.visibility === 'hidden'; } catch { return false; }
  }
  function blockDisplay(el) {
    if (typeof getComputedStyle !== 'function') return false;
    try { return /^(?:block|flex|grid|list-item|table|flow-root)$/.test(getComputedStyle(el).display); } catch { return false; }
  }

  // True when `el` sits inside something matching `selector`, looking through shadow roots to their hosts.
  function within(el, selector) {
    for (let node = el, hops = 0; node && typeof node.closest === 'function' && hops < 32; hops++) {
      if (node.closest(selector)) return true;
      const root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
      node = root && root !== node ? root.host : null;
    }
    return false;
  }

  // True when an element opens with a heading (empty id targets before it are skipped, as Sphinx writes them), directly
  // or inside one wrapping <header> or <div>.
  function startsWithHeading(el, depth = 0) {
    for (const child of Array.from(el.childNodes || [])) {
      if (child.nodeType === 3) { if (str(child.data).trim()) return false; continue; }
      if (child.nodeType !== 1) continue;
      const tag = tagOf(child);
      if (/^h[1-6]$|^hgroup$/.test(tag)) return true;
      if (Array.from(child.childNodes || []).every(node => node.nodeType === 8 || (node.nodeType === 3 && !str(node.data).trim()))) continue;
      return depth < 1 && (tag === 'header' || tag === 'div') && startsWithHeading(child, depth + 1);
    }
    return false;
  }

  function chrome(el, tag, state) {
    if (CHROME_TAGS.has(tag) || CHROME_ROLES.has(attr(el, 'role')) || attr(el, 'aria-modal') === 'true') return true;
    // A <header> is page chrome only where HTML makes it the page's banner: outside sectioning content and main. That
    // can only be judged on the live page; Readability's output is detached from those ancestors and its own pass has
    // already dropped site chrome, so a header it kept (standfirst, lead figure, section heading) is content.
    if (tag === 'header') return state.live && !within(el, 'article, aside, main, nav, section, [role="article"], [role="complementary"], [role="main"], [role="navigation"], [role="region"]');
    // Some sites wrap the whole page in one <form>; only a form that holds no article is page chrome.
    if (tag === 'form' && typeof el.querySelector === 'function' && !el.querySelector('article, main, [role="main"], h1')) return true;
    if (!JUNK_TAGS.has(tag)) return false;
    const cls = attr(el, 'class'), id = attr(el, 'id');
    if (KEEP.test(cls + ' ' + id)) return false;
    if (JUNK.test(cls)) return true;
    // Ids are weaker evidence: Sphinx, Pandoc, Quarto and Jupyter Book build section ids from heading text (#cookie-objects,
    // #sharing-state, #comments), so an id counts only on the live page and only for an element that does not open with
    // a heading. Readability strips classes from its output and keeps those section ids, so there this rule never fires.
    return state.live && JUNK.test(id) && !startsWithHeading(el);
  }

  function skipped(el, state) {
    const tag = tagOf(el);
    if (SKIP_TAGS.has(tag)) return true;
    const cls = attr(el, 'class'), math = has(el, 'data-still-math') || MATH_IMAGE.test(cls);
    if ((has(el, 'hidden') && attr(el, 'hidden') !== 'until-found') || (attr(el, 'aria-hidden') === 'true' && !math) || has(el, 'data-still-skip')) return true;
    const style = attr(el, 'style');
    if (style && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(style)) return true;
    if (cls && (CALLOUT_TITLE.test(cls) || NOISE.test(cls))) return true;
    if (state.strip && chrome(el, tag, state) && !calloutKind(el)) return true;
    return state.live && hiddenByStyle(el);
  }

  // True when an element holds anything the paragraph buffer cannot (blocks or full-size media). Memoized, so a
  // whole conversion stays linear in the number of nodes.
  function hasBlock(el, state, depth = 0) {
    const memo = state.blockMemo;
    if (memo.has(el)) return memo.get(el);
    let found = false;
    if (depth < MAX_DEPTH) {
      for (const child of kids(el, state)) {
        if (child.nodeType !== 1) continue;
        const tag = tagOf(child);
        if (SKIP_TAGS.has(tag)) continue;
        if (BLOCK_TAGS.has(tag) || (tag === 'img' && !smallImage(child, state)) || hasBlock(child, state, depth + 1)) { found = true; break; }
      }
    }
    memo.set(el, found);
    return found;
  }

  function addText(out, md) {
    if (!md) return;
    if (!out.para || /\s$/.test(out.para)) md = md.replace(/^ +/, '');
    if (!md) return;
    out.para += md;
    if (/\S/.test(md)) out.lastImage = false;
  }
  function push(out, block) { out.blocks.push(block); out.lastImage = block.type === 'image'; }
  function flush(out) {
    const text = out.para.replace(/ {2,}/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
    out.para = '';
    if (text) push(out, { type: 'paragraph', text });
  }

  // Consecutive inline siblings convert together, so marks see their neighbours (merging, intraword emphasis).
  function flow(node, out, depth) {
    const state = out.state;
    let run = [];
    const drain = () => { if (run.length) addText(out, inlineNodes(run, state, {}, depth)); run = []; };
    for (const child of kids(node, state)) {
      if (!tick(state)) break;
      if (inlineLevel(child, out, run)) { run.push(child); continue; }
      drain();
      visit(child, out, depth);
    }
    drain();
  }

  function inlineLevel(node, out, run) {
    if (node.nodeType === 3) return true;
    if (node.nodeType !== 1) return false;
    const tag = tagOf(node), state = out.state;
    if (tag === 'br') return true;
    if (HANDLERS[tag] || tag === 'noscript' || BLOCK_TAGS.has(tag)) return false;
    if (!INLINE_TAGS.has(tag) && state.live && blockDisplay(node)) return false;
    const starts = !out.para.trim() && run.every(item => item.nodeType === 3 && !item.data.trim());
    if (tag === 'code' && starts && str(node.textContent).trim().includes('\n')) return false;
    return !hasBlock(node, state);
  }

  function visit(node, out, depth, root = false) {
    const state = out.state;
    if (node.nodeType === 3) { addText(out, escapeText(collapse(node.data))); return; }
    if (node.nodeType !== 1) return;
    const tag = tagOf(node);
    if (tag === 'noscript') { noscriptImage(node, out); return; }
    if (root ? SKIP_TAGS.has(tag) : skipped(node, state)) return;
    if (depth > MAX_DEPTH) {
      // Absurdly deep markup keeps its words as one plain run instead of recursing further.
      if (typeof node.querySelector !== 'function' || !node.querySelector('script, style, template')) addText(out, ' ' + escapeText(collapse(str(node.textContent).slice(0, 100000))) + ' ');
      return;
    }
    if (tag === 'br') { out.para += '\n'; return; }
    const handler = HANDLERS[tag];
    if (handler) { handler(node, out, depth); return; }
    if (CALLOUT_HOSTS.has(tag)) {
      const kind = calloutKind(node);
      if (kind) { quote(node, out, depth, kind); return; }
    }
    // A multi-line <code> that starts a block is a code block even without <pre> (some docs sites).
    if (tag === 'code' && !out.para.trim() && str(node.textContent).trim().includes('\n') && !hasBlock(node, state)) { code(node, out); return; }
    const known = BLOCK_TAGS.has(tag) ? 'block' : INLINE_TAGS.has(tag) ? 'inline' : '';
    const block = known === 'block' || (!known && state.live && blockDisplay(node));
    if (!block && !hasBlock(node, state)) { addText(out, inlineNodes([node], state, {}, depth)); return; }
    if (block) flush(out);
    flow(node, out, depth + 1);
    if (block) flush(out);
  }

  function convertRoot(root, state) {
    const out = sink(state);
    if (root.nodeType === 1) visit(root, out, 0, true); else flow(root, out, 0);
    flush(out);
    return out.blocks;
  }

  // ---- inline elements

  function markOf(el, flags) {
    const tag = tagOf(el);
    let mark = MARKS[tag] || null;
    // Google Docs wraps whole documents in <b style="font-weight:normal">.
    if (tag === 'b' && /font-weight\s*:\s*(?:normal|[1-5]00)\b/i.test(attr(el, 'style'))) mark = null;
    return mark && !flags[mark] ? mark : null;
  }

  const inlineChildren = (el, state, flags, depth) => inlineNodes(kids(el, state), state, flags, depth);
  function inlineNodes(nodes, state, flags, depth) {
    const parts = [];
    for (const child of nodes) {
      if (!tick(state)) break;
      if (child.nodeType === 3) { parts.push({ md: escapeText(collapse(child.data)) }); continue; }
      if (child.nodeType !== 1 || skipped(child, state)) continue;
      if (depth > MAX_DEPTH) { parts.push({ md: escapeText(collapse(str(child.textContent).slice(0, 100000))) }); continue; }
      const mark = markOf(child, flags);
      if (!mark) { parts.push({ md: inlineElement(child, state, flags, depth + 1) }); continue; }
      const inner = inlineChildren(child, state, { ...flags, [mark]: true }, depth + 1), last = parts[parts.length - 1];
      // Adjacent runs with the same mark merge, since **a****b** would read back wrong.
      if (last && last.mark === mark) last.inner += inner; else parts.push({ mark, inner });
    }
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k];
      if (part.mark === 'bold') part.md = emphasize(part.inner, '**');
      else if (part.mark === 'strike') part.md = emphasize(part.inner, '~~');
      else if (part.mark === 'italic') {
        // "_" cannot open or close inside a word, so intraword emphasis uses "*".
        const before = str(parts[k - 1]?.md).slice(-1), after = str(parts[k + 1]?.md ?? parts[k + 1]?.inner).charAt(0);
        const intraword = (WORD.test(before) && !/^\s/.test(part.inner)) || (WORD.test(after) && !/\s$/.test(part.inner));
        part.md = emphasize(part.inner, intraword ? '*' : '_');
      }
    }
    return parts.map(part => part.md).join('');
  }

  function inlineElement(el, state, flags, depth) {
    const tag = tagOf(el);
    if (tag === 'br') return '\n';
    if (tag === 'a') return link(el, state, flags, depth);
    if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') return codeSpan(collapse(el.textContent));
    if (tag === 'img') { const image = imageInfo(el, state); return !image || !image.small || !image.alt || image.tracking ? '' : image.tex ? codeSpan(image.alt) : escapeText(image.alt); }
    if (tag === 'math') return mathText(el);
    if (tag === 'q') { const inner = inlineChildren(el, state, flags, depth); return inner.trim() ? `“${inner}”` : inner; }
    if (tag === 'video' || tag === 'audio' || tag === 'iframe' || tag === 'picture') return '';
    return inlineChildren(el, state, flags, depth);
  }

  function link(el, state, flags, depth) {
    const inner = inlineChildren(el, state, { ...flags, link: true }, depth);
    if (flags.link) return inner; // links never nest
    const href = linkUrl(attr(el, 'href'), state.base);
    if (!href) return inner;
    const lead = /^\s*/.exec(inner)[0], rest = inner.slice(lead.length), trail = /\s*$/.exec(rest)[0];
    const label = rest.slice(0, rest.length - trail.length).replace(/\s*\n\s*/g, ' ');
    return label ? `${lead}[${escapeLabel(label)}](${href})${trail}` : inner;
  }

  function mathText(el) {
    const annotation = typeof el.querySelector === 'function' ? el.querySelector('annotation[encoding="application/x-tex"]') : null;
    const tex = clean(annotation?.textContent || attr(el, 'alttext'), 500);
    return tex ? codeSpan(tex) : escapeText(collapse(el.textContent));
  }

  // ---- images and embeds

  function bestSrcset(value) {
    let best = '', score = -1;
    for (const match of str(value).matchAll(/(\S+)(?:\s+(\d+(?:\.\d+)?)([wx]))?\s*(?:,\s*|$)/g)) {
      const url = match[1].replace(/,+$/, ''), size = match[2] ? Number(match[2]) * (match[3] === 'x' ? 1000 : 1) : 0;
      if (url && size > score) { best = url; score = size; }
    }
    return best;
  }
  const dimension = value => /^\s*\d+(?:\.\d+)?\s*(?:px)?\s*$/i.test(str(value)) ? Math.round(parseFloat(value)) : null;
  const EMOJI_ALT = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u200d\ufe0f\u20e3#*0-9])+$/u;

  function imageInfo(img, state) {
    const memo = state.imageMemo;
    if (memo.has(img)) return memo.get(img);
    const base = state.base, picture = tagOf(img.parentNode) === 'picture' ? img.parentNode : null;
    const stamped = attr(img, 'data-still-src'), current = state.live ? str(img.currentSrc) : '';
    // The loaded image first, then the largest declared candidate, then what lazy loaders keep in data attributes.
    const candidates = [stamped, current, bestSrcset(attr(img, 'srcset')), ...LAZY_SOURCES.map(name => attr(img, name)),
      ...LAZY_SRCSETS.map(name => bestSrcset(attr(img, name))),
      ...(picture ? childElements(picture).filter(child => tagOf(child) === 'source').map(source => bestSrcset(attr(source, 'srcset') || attr(source, 'data-srcset'))) : []),
      attr(img, 'src')];
    let url = '';
    for (const candidate of candidates) {
      const value = markdownUrl(candidate, base);
      if (value && !PLACEHOLDER.test(value)) { url = value; break; }
    }
    let width = dimension(attr(img, 'width')), height = dimension(attr(img, 'height'));
    // Natural sizes describe the loaded file, so they count only when that file is the one being saved.
    const loaded = markdownUrl(stamped || current, base);
    if (url && loaded === url) {
      const size = /^(\d+)x(\d+)$/.exec(attr(img, 'data-still-size'));
      if (size) { width = Number(size[1]); height = Number(size[2]); }
      else if (img.naturalWidth > 0 && img.naturalHeight > 0) { width = img.naturalWidth; height = img.naturalHeight; }
    }
    const alt = clean(attr(img, 'alt') || attr(img, 'title') || attr(img, 'aria-label'), 200);
    if (has(img, 'data-still-math') || MATH_IMAGE.test(attr(img, 'class'))) {
      const tex = clean(attr(img, 'data-still-math') || attr(img, 'alt'), 2000).replace(/^\{\\displaystyle\s*([\s\S]*)\}$/, '$1').trim();
      const info = tex ? { url, alt: tex, small: true, tex: true, width, height, tracking: false } : null;
      memo.set(img, info);
      return info;
    }
    const emoji = (alt && alt.length <= 16 && EMOJI_ALT.test(alt)) || /\/emoji\/|twemoji|(?:^|\s)emoji(?:\s|$)/i.test(url + ' ' + attr(img, 'class'));
    const small = emoji || (width !== null && width < MIN_IMAGE_PX) || (height !== null && height < MIN_IMAGE_PX);
    const info = url || alt ? { url, alt, small, width, height, tracking: !!url && TRACKER.test(url) } : null;
    memo.set(img, info);
    return info;
  }
  function smallImage(img, state) { const info = imageInfo(img, state); return !info || info.small || info.tracking || !info.url; }

  function addImage(out, url, alt, width = null, height = null) {
    flush(out);
    const last = out.blocks[out.blocks.length - 1];
    if (out.lastImage && last && last.url === url) return;
    push(out, { type: 'image', url, alt: clean(alt, 200), width, height });
  }

  function image(el, out) {
    const state = out.state;
    const img = tagOf(el) === 'img' ? el : kids(el, state).find(child => tagOf(child) === 'img');
    const info = img ? imageInfo(img, state) : null;
    if (!info) { out.lastImage = false; return; }
    if (info.tracking) return;
    if (!info.url && !info.tex) { out.lastImage = false; return; } // a placeholder: a following <noscript> may hold the real image
    if (info.small) { if (info.alt) addText(out, info.tex ? codeSpan(info.alt) : escapeText(info.alt)); return; }
    addImage(out, info.url, info.alt, info.width, info.height);
  }

  // A lazy image whose placeholder gave nothing often keeps the real <img> in the next <noscript>. Its contents are
  // markup text (scripting is on), read here with a pattern; it is never parsed into DOM nodes.
  function noscriptImage(el, out) {
    if (out.lastImage) return;
    const tag = /<img\b[^>]*>/i.exec(str(el.textContent))?.[0];
    if (!tag) return;
    const read = name => {
      const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
      return str(m ? m[1] ?? m[2] ?? m[3] : '').replace(/&(amp|quot|#39|apos|lt|gt);/g, (all, e) => ({ amp: '&', quot: '"', '#39': "'", apos: "'", lt: '<', gt: '>' })[e]);
    };
    const url = markdownUrl(read('src') || read('data-src'), out.state.base);
    const width = dimension(read('width')), height = dimension(read('height'));
    if (!url || PLACEHOLDER.test(url) || TRACKER.test(url) || (width !== null && width < MIN_IMAGE_PX) || (height !== null && height < MIN_IMAGE_PX)) return;
    addImage(out, url, read('alt'), width, height);
  }

  // Player iframes become the share address lib/embeds.js recognizes, so ::embed lines open the right player.
  function knownEmbed(value) {
    let url;
    try { url = new URL(value); } catch { return null; }
    const host = url.hostname.replace(/^(?:www|m)\./, '').toLowerCase(), path = url.pathname;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
      const id = host === 'youtu.be' ? path.split('/')[1] : /^\/(?:embed|shorts|live|v)\/([\w-]+)/.exec(path)?.[1] || url.searchParams.get('v') || '';
      const list = url.searchParams.get('list');
      if (id === 'videoseries' && list && /^[\w-]+$/.test(list)) return { url: `https://www.youtube.com/playlist?list=${list}`, label: 'YouTube playlist' };
      if (!/^[\w-]{6,20}$/.test(id)) return null;
      const start = /^\d+$/.exec(url.searchParams.get('start') || url.searchParams.get('t') || '')?.[0];
      return { url: `https://www.youtube.com/watch?v=${id}${start ? `&t=${start}` : ''}`, label: 'YouTube video' };
    }
    if (host === 'player.vimeo.com' || host === 'vimeo.com') {
      const m = /^\/(?:video\/)?(\d{5,12})(?:\/([\da-f]{6,20}))?/.exec(path);
      if (!m) return null;
      const hash = m[2] || (/^[\da-f]{6,20}$/.test(url.searchParams.get('h') || '') ? url.searchParams.get('h') : '');
      return { url: `https://vimeo.com/${m[1]}${hash ? '/' + hash : ''}`, label: 'Vimeo video' };
    }
    if (host === 'loom.com') {
      const m = /^\/(?:embed|share)\/([\da-f]{16,64})/.exec(path);
      return m ? { url: `https://www.loom.com/share/${m[1]}`, label: 'Loom video' } : null;
    }
    if (host === 'platform.twitter.com' || host === 'platform.x.com') {
      const id = /^\d{5,25}$/.exec(url.searchParams.get('id') || '')?.[0];
      return id && /\/embed\/Tweet\.html$/i.test(path) ? { url: `https://x.com/i/status/${id}`, label: 'Post on X' } : null;
    }
    return null;
  }

  function media(el, out) {
    const state = out.state, tag = tagOf(el);
    if (tag === 'img' || tag === 'picture') { image(el, out); return; }
    if (tag === 'iframe') {
      const src = markdownUrl(attr(el, 'src') || attr(el, 'data-src'), state.base);
      if (!src) return;
      const title = clean(attr(el, 'title') || attr(el, 'aria-label'), 120), known = knownEmbed(src);
      const tiny = [attr(el, 'width'), attr(el, 'height')].some(value => { const n = dimension(value); return n !== null && n < MIN_IMAGE_PX; });
      flush(out);
      if (known) push(out, { type: 'embed', url: known.url, label: title || known.label });
      else if (title && !tiny) push(out, { type: 'paragraph', text: `[${escapeLabel(escapeText(title))}](${src})` });
      return;
    }
    // <video> and <audio>: a link to a real file, or the poster when the stream is a blob.
    const source = childElements(el).find(child => tagOf(child) === 'source' && attr(child, 'src'));
    const src = markdownUrl(attr(el, 'src') || attr(source, 'src'), state.base), label = tag === 'video' ? 'Video' : 'Audio';
    flush(out);
    const known = src && knownEmbed(src);
    if (known) push(out, { type: 'embed', url: known.url, label: known.label });
    else if (src) push(out, { type: 'paragraph', text: `[${label}](${src})` });
    else if (tag === 'video') { const poster = markdownUrl(attr(el, 'poster'), state.base); if (poster) addImage(out, poster, label); }
  }

  // ---- block elements

  function heading(el, out, depth) {
    flush(out);
    let text = oneLine(inlineChildren(el, out.state, {}, depth + 1));
    // A heading that is only a link to its own anchor on this page (docs sites) keeps just its words.
    const self = /^\[((?:\\[\s\S]|[^\]\\])*)\]\(([^()\s]+)\)$/.exec(text);
    if (self && self[2].includes('#') && self[2].split('#')[0] === str(out.state.base).split('#')[0]) text = self[1].replace(/\\\]/g, ']');
    if (text) push(out, { type: 'h' + Math.min(3, Number(tagOf(el)[1]) || 3), text });
  }

  function term(el, out, depth) {
    flush(out);
    const text = oneLine(inlineChildren(el, out.state, {}, depth + 1));
    if (text) push(out, { type: 'paragraph', text: emphasize(text, '**') });
  }

  function code(el, out) {
    flush(out);
    const text = codeText(el, out.state).replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
    if (text.trim()) push(out, { type: 'code', text, language: codeLanguage(el) });
  }

  function codeText(el, state) {
    let text = '';
    const lineTags = new Set(['div', 'p', 'li', 'tr']);
    const walk = (node, depth) => {
      for (const child of kids(node, state)) {
        if (!tick(state)) return;
        if (child.nodeType === 3) { text += child.data; continue; }
        if (child.nodeType !== 1 || depth > MAX_DEPTH) continue;
        const tag = tagOf(child);
        if (tag === 'br') { text += '\n'; continue; }
        if (skipped(child, state) || GUTTER.test(attr(child, 'class'))) continue;
        const line = lineTags.has(tag);
        if (line && text && !text.endsWith('\n')) text += '\n';
        walk(child, depth + 1);
        if (line && text && !text.endsWith('\n')) text += '\n';
      }
    };
    walk(el, 0);
    return text.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
  }

  const NO_LANGUAGE = new Set(['none', 'text', 'plaintext', 'plain', 'nohighlight', 'txt', 'undefined', 'null']);
  function normalizeLanguage(value) {
    const language = str(value).trim().toLowerCase();
    return /^[a-z0-9][\w+#.-]{0,29}$/.test(language) && !NO_LANGUAGE.has(language) ? language : '';
  }
  // language-js, highlight-source-js / highlight-text-html-basic (GitHub), and on the code element itself also lang-js
  // and SyntaxHighlighter's "brush: js" (MDN).
  function languageFromClass(value, own = true) {
    const text = str(value);
    const m = /(?:^|\s)language-([\w+#.-]+)/i.exec(text) || /(?:^|\s)highlight-(?:source|text)-([\w+#.]+)/i.exec(text)
      || (own ? /(?:^|\s)lang-([\w+#.-]+)/i.exec(text) || /(?:^|\s)brush:\s*([\w+#.-]+)/i.exec(text) : null);
    return m ? normalizeLanguage(m[1]) : '';
  }
  const LANGUAGE_NAMES = { js: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby', sh: 'shell', bash: 'shell', yml: 'yaml', md: 'markdown' };
  // Docs sites print the language above a code block ("js"); the fence already says it.
  const languageLabel = (block, language) => {
    if (block?.type !== 'paragraph' || !language) return false;
    const label = inlinePlain(block.text).trim().toLowerCase();
    return label === language || label === LANGUAGE_NAMES[language];
  };
  function codeLanguage(el) {
    const inner = typeof el.querySelector === 'function' ? el.querySelector('code') : null;
    const nodes = [[el, true], [inner, true], [el.parentNode, false], [el.parentNode?.parentNode, false]];
    for (const [node, own] of nodes) {
      if (!node || node.nodeType !== 1) continue;
      const language = normalizeLanguage(attr(node, 'data-still-lang') || attr(node, 'data-lang') || attr(node, 'data-language')) || languageFromClass(attr(node, 'class'), own);
      if (language) return language;
    }
    return '';
  }

  function calloutFromClass(value) {
    const classes = str(value).toLowerCase().split(/\s+/).filter(Boolean);
    for (const name of classes) { const m = /^markdown-alert-(note|tip|important|warning|caution)$/.exec(name); if (m) return m[1]; }
    const family = classes.some(name => ['admonition', 'callout', 'alert', 'notice'].includes(name));
    for (const name of classes) {
      const m = /^(?:callout|alert|admonition|notice)-([a-z]+)$/.exec(name);
      if (m && CALLOUT_MAP[m[1]]) return CALLOUT_MAP[m[1]];
      if (family && CALLOUT_MAP[name]) return CALLOUT_MAP[name];
    }
    return classes.includes('admonition') || classes.includes('callout') ? 'note' : '';
  }
  function calloutKind(el) {
    const stamped = attr(el, 'data-still-callout');
    if (CALLOUT_KINDS.has(stamped)) return stamped;
    const data = attr(el, 'data-callout').toLowerCase();
    if (data) return CALLOUT_MAP[data] || 'note';
    return calloutFromClass(attr(el, 'class'));
  }

  // Quote bodies render as inline text, so nested blocks become lines; what cannot be a line follows the quote.
  function quoteText(blocks) {
    const lines = [], extras = [];
    let previous = null;
    for (const block of blocks) {
      let text = null;
      if (block.type === 'paragraph' || block.type === 'quote' || block.type === 'callout') text = block.text;
      else if (/^h[1-3]$/.test(block.type)) text = emphasize(block.text, '**');
      else if (LIST_BLOCKS.has(block.type)) {
        const marker = block.type === 'todo' ? (block.checked ? '- [x] ' : '- [ ] ') : block.type === 'number' ? `${block.ordinal ?? 1}. ` : '- ';
        text = '  '.repeat(block.indent || 0) + marker + block.text.replace(/\n/g, ' ');
      } else if (block.type === 'code' && !block.text.includes('\n') && block.text.length <= 200) text = codeSpan(block.text);
      if (text === null) { if (block.type !== 'divider') extras.push(block); continue; }
      if (lines.length && !(LIST_BLOCKS.has(block.type) && LIST_BLOCKS.has(previous?.type))) lines.push('');
      lines.push(text);
      previous = block;
    }
    return { text: lines.join('\n'), extras };
  }

  function quote(el, out, depth, kind = calloutKind(el)) {
    flush(out);
    const box = sink(out.state);
    flow(el, box, depth + 1);
    flush(box);
    const { text, extras } = quoteText(box.blocks);
    if (kind) push(out, { type: 'callout', kind, text });
    else if (text.trim()) push(out, { type: 'quote', text });
    for (const block of extras) push(out, block);
  }

  function checkbox(li, state) {
    const stamped = attr(li, 'data-still-task');
    if (stamped) return { checked: stamped === 'checked' };
    const input = typeof li.querySelector === 'function' ? li.querySelector('input[type="checkbox" i]') : null;
    if (!input) return null;
    for (let node = input.parentNode; node && node !== li; node = node.parentNode) if (LIST_TAGS.has(tagOf(node)) || tagOf(node) === 'li') return null;
    return { checked: state.live ? input.checked === true : has(input, 'checked') };
  }

  // A list item's leading paragraphs become its text (joined with hard breaks); nested lists follow one level deeper;
  // blocks Still cannot nest in a list item (code, tables, images) follow at the top level.
  function item(li, out, depth, indent, ordinal, listStart) {
    const state = out.state, box = sink(state, indent + 1);
    flow(li, box, depth + 1);
    flush(box);
    const check = checkbox(li, state), texts = [], rest = [];
    for (const block of box.blocks) {
      if (!rest.length && block.type === 'paragraph') texts.push(block.text);
      else if (!rest.length && /^h[1-3]$/.test(block.type)) texts.push(emphasize(block.text, '**'));
      else rest.push(block);
    }
    const text = texts.join('\n');
    if (!text && !check) { for (const block of rest) push(out, block); return false; }
    const block = { type: check ? 'todo' : ordinal !== null ? 'number' : 'bullet', text, indent, listStart };
    if (check) block.checked = check.checked;
    if (ordinal !== null) block.ordinal = ordinal;
    push(out, block);
    for (const extra of rest) push(out, extra);
    return true;
  }

  function list(el, out, depth) {
    flush(out);
    const state = out.state, ordered = tagOf(el) === 'ol', indent = out.listIndent;
    const start = parseInt(attr(el, 'start'), 10);
    let number = Number.isFinite(start) ? start : 1, first = true;
    for (const child of kids(el, state)) {
      if (!tick(state)) break;
      if (child.nodeType !== 1 || skipped(child, state)) continue;
      const tag = tagOf(child);
      if (LIST_TAGS.has(tag)) {
        // A list directly inside a list (invalid but common) belongs one level deeper.
        out.listIndent = indent + 1; list(child, out, depth + 1); out.listIndent = indent;
        continue;
      }
      if (tag !== 'li' && childElements(child).some(grandchild => tagOf(grandchild) === 'li')) { list(child, out, depth + 1); continue; }
      const value = parseInt(attr(child, 'value'), 10);
      if (ordered && Number.isFinite(value)) number = value;
      if (item(child, out, depth + 1, indent, ordered ? number : null, first)) { first = false; if (ordered) number++; }
    }
  }

  function tableRows(el, state) {
    const rows = [];
    const add = (tr, head) => {
      if (skipped(tr, state)) return;
      if (rows.length >= MAX_TABLE_ROWS) { state.clipped = true; return; }
      const cells = childElements(tr).filter(cell => (tagOf(cell) === 'td' || tagOf(cell) === 'th') && !skipped(cell, state));
      if (cells.length) rows.push({ cells, head });
    };
    for (const child of childElements(el)) {
      const tag = tagOf(child);
      if (tag === 'tr') add(child, false);
      else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') for (const tr of childElements(child)) if (tagOf(tr) === 'tr') add(tr, tag === 'thead');
    }
    return rows;
  }
  const gutterCell = cell => has(cell, 'data-still-skip') || has(cell, 'data-line-number') || GUTTER.test(attr(cell, 'class'));

  function cellText(cell, state, depth) {
    const box = sink(state);
    flow(cell, box, depth + 1);
    flush(box);
    let simple = true;
    const lines = box.blocks.map(block => {
      if (block.type === 'paragraph') return block.text;
      if (/^h[1-3]$/.test(block.type)) return emphasize(block.text, '**');
      if (block.type === 'image') return `![${escapeLabel(escapeText(block.alt))}](${block.url})`;
      if (LIST_BLOCKS.has(block.type)) return '- ' + block.text;
      if (block.type === 'embed') return `[${escapeLabel(escapeText(block.label))}](${block.url})`;
      if (block.type === 'code' && !block.text.includes('\n')) return codeSpan(block.text);
      if (block.type === 'divider') return '';
      simple = false; // code blocks, quotes, tables and toggles do not fit in a GFM cell
      return block.type === 'code' ? codeSpan(block.text) : str(block.text);
    });
    return { text: lines.filter(Boolean).join('\n'), simple };
  }

  function table(el, out, depth) {
    flush(out);
    const state = out.state, rows = tableRows(el, state);
    if (!rows.length) return;
    // Highlighters that lay code out as a table with a line-number gutter.
    if (rows.some(row => row.cells.some(gutterCell))) {
      const text = rows.map(row => row.cells.filter(cell => !gutterCell(cell)).map(cell => codeText(cell, state).replace(/\n$/, '')).join('')).join('\n')
        .replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
      if (text.trim()) push(out, { type: 'code', text, language: codeLanguage(el.querySelector?.('pre, code') || el) || codeLanguage(el) });
      return;
    }
    // A layout table (old forums, email-style pages) is read as plain content: an explicit presentation role, nested
    // tables, a single column, or no header/caption signals together with a single row or block content in cells.
    const role = attr(el, 'role'), query = selector => typeof el.querySelector === 'function' ? el.querySelector(selector) : null;
    const dataSignals = !!(attr(el, 'summary') || query('th, thead, caption, col, colgroup, tfoot'));
    const blockCells = () => rows.some(row => row.cells.some(cell => typeof cell.querySelector === 'function' && cell.querySelector('div, p, ul, ol, pre, blockquote, h1, h2, h3, h4, h5, h6, section, article')));
    if (role === 'presentation' || role === 'none' || rows.every(row => row.cells.length <= 1) || query('table') || (!dataSignals && (rows.length === 1 || blockCells()))) {
      for (const row of rows) for (const cell of row.cells) { flow(cell, out, depth + 1); flush(out); }
      return;
    }
    const caption = childElements(el).find(child => tagOf(child) === 'caption');
    const captionText = caption && !skipped(caption, state) ? oneLine(inlineChildren(caption, state, {}, depth + 1)) : '';
    let complex = false;
    // Cells land in their real columns: a rowspan repeats its text into the rows below (and makes the table complex),
    // a colspan pads the row with empty cells.
    const carried = [];
    const grid = rows.map(row => {
      const cells = [];
      const fill = () => { while (carried[cells.length]?.rows > 0) { const carry = carried[cells.length]; carry.rows--; cells.push(carry.text); } };
      for (const cell of row.cells) {
        fill();
        const content = cellText(cell, state, depth), column = cells.length;
        const rowspan = Math.min(MAX_TABLE_ROWS, Math.max(1, parseInt(attr(cell, 'rowspan'), 10) || 1));
        if (!content.simple || rowspan > 1) complex = true;
        if (rowspan > 1) carried[column] = { text: content.text, rows: rowspan - 1 };
        cells.push(content.text);
        const span = Math.min(20, Math.max(1, parseInt(attr(cell, 'colspan'), 10) || 1));
        for (let k = 1; k < span; k++) cells.push('');
      }
      fill();
      return { cells, head: row.head || row.cells.every(cell => tagOf(cell) === 'th') };
    });
    if (captionText) push(out, { type: 'paragraph', text: emphasize(captionText, /(^|[^\\])_/.test(captionText) ? '*' : '_') });
    const [first, ...body] = grid;
    if (complex) {
      // Merged rows or block content do not survive a GFM table: one bullet per row, labelled by its header.
      const headers = first.head ? first.cells.map(oneLine) : null;
      let listStart = true;
      for (const row of headers ? body : grid) {
        const parts = row.cells.map((cell, i) => { const value = oneLine(cell); return value && headers?.[i] ? `${headers[i]}: ${value}` : value; }).filter(Boolean);
        if (parts.length) { push(out, { type: 'bullet', text: parts.join(' · '), indent: 0, listStart }); listStart = false; }
      }
      return;
    }
    const width = grid.reduce((max, row) => Math.max(max, row.cells.length), 1);
    const pad = cells => Array.from({ length: width }, (_, i) => cells[i] ?? '');
    push(out, { type: 'table', headers: pad(first.cells), rows: body.map(row => pad(row.cells)) });
  }

  function figure(el, out, depth) {
    flush(out);
    const state = out.state, children = kids(el, state);
    const caption = children.find(child => child.nodeType === 1 && tagOf(child) === 'figcaption');
    for (const child of children) {
      if (child === caption) continue;
      if (!tick(state)) break;
      visit(child, out, depth + 1);
    }
    flush(out);
    if (caption && !skipped(caption, state)) captionLine(caption, out, depth);
  }
  function captionLine(el, out, depth) {
    flush(out);
    const text = oneLine(inlineChildren(el, out.state, {}, depth + 1));
    if (text) push(out, { type: 'paragraph', text: emphasize(text, /(^|[^\\])_/.test(text) ? '*' : '_') });
  }

  function details(el, out, depth) {
    flush(out);
    const state = out.state, children = kids(el, state);
    const summary = children.find(child => child.nodeType === 1 && tagOf(child) === 'summary');
    const box = sink(state);
    for (const child of children) {
      if (child === summary) continue;
      if (!tick(state)) break;
      visit(child, box, depth + 1);
    }
    flush(box);
    const title = summary ? oneLine(inlineChildren(summary, state, {}, depth + 1)) : '';
    const body = serialize(box.blocks).markdown;
    if (!title && !body.trim()) return;
    push(out, { type: 'toggle', title: title || 'Details', open: has(el, 'open'), text: body, children: box.blocks });
  }

  const HANDLERS = {
    h1: heading, h2: heading, h3: heading, h4: heading, h5: heading, h6: heading,
    ul: list, ol: list, menu: list, dir: list,
    li: (el, out, depth) => { flush(out); item(el, out, depth, out.listIndent, null, !LIST_BLOCKS.has(out.blocks[out.blocks.length - 1]?.type)); },
    blockquote: (el, out, depth) => quote(el, out, depth),
    pre: (el, out) => code(el, out),
    table, figure, details, dt: term,
    figcaption: captionLine,
    hr: (el, out) => { flush(out); push(out, { type: 'divider' }); },
    img: (el, out) => media(el, out), picture: (el, out) => media(el, out), video: (el, out) => media(el, out),
    audio: (el, out) => media(el, out), iframe: (el, out) => media(el, out),
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Serialization in the canonical form lib/markdown.js writes, so a captured article reopens unchanged in the editor.

  const EMBED_WEB = /^::embed\[((?:\\[\s\S]|[^\]\\\n])*)\]\((?:<([^<>\n]+)>|([^()<>\s]+))\)(?:\{height=(\d{2,4})\})?[ \t]*\r?$/;
  const EMBED_ITEM = /^!\[\[([^[\]\n|]{1,200})(?:\|([^[\]\n]{1,200}))?\]\](?:\{height=(\d{2,4})\})?[ \t]*\r?$/;
  function escapeLineStart(line) {
    const [, ws, rest] = /^([ \t]*)([\s\S]*)$/.exec(line);
    if (/^[-*] /.test(rest)) return ws + '\\' + rest;
    const number = /^(\d+)\. /.exec(rest);
    if (number) return ws + number[1] + '\\' + rest.slice(number[1].length);
    if (!ws && (/^(?:#{1,6} |>|`{3,}|~{3,}|:{3,}|---\s*$)/.test(rest) || EMBED_WEB.test(rest) || EMBED_ITEM.test(rest))) return '\\' + rest;
    return line;
  }
  const hardBreak = line => { const value = line.replace(/\r$/, ''); return value.endsWith('\\') && !escapedAt(value, value.length - 1); };
  function hardLines(text, first, indent = '') {
    const lines = str(text).replace(/\n+$/, '').split('\n');
    let out = first(lines[0]);
    for (let k = 1; k < lines.length; k++) out += (hardBreak(lines[k - 1]) ? '\n' : '\\\n') + indent + escapeLineStart(lines[k]);
    return out;
  }
  const quoteLines = (text, first = '') => str(text).replace(/\n+$/, '').split('\n').map((line, k) => {
    const value = /^\[!/.test(line) ? '\\' + line : line;
    return value || (k === 0 && !first) ? '> ' + value : '>';
  });
  const endsTable = line => !str(line).trim() || /^\s*(?:>|#{1,6}\s|`{3,}|~{3,}|:{3,}|[-*+]\s|\d+\.\s)/.test(line) || /^\s*([-*_])\1\1+\s*$/.test(line);
  function escapeTableCell(value) {
    const text = str(value).replace(/\r\n?|\n/g, '<br>');
    let out = '';
    for (let i = 0; i < text.length; i++) { if (text[i] === '|' && !escapedAt(text, i)) out += '\\'; out += text[i]; }
    return out;
  }
  // The cells lib/markdown.js reads from a line (its splitTableRow): unescaped pipes outside code spans split, and a
  // leading or trailing pipe adds no cell.
  function codeEnd(text, marker, from) {
    for (let i = from; i < text.length; i++) { if (text[i] !== '`') continue; const run = /^`+/.exec(text.slice(i))[0]; if (run.length === marker.length) return i; i += run.length - 1; }
    return -1;
  }
  function tableCells(line) {
    const value = str(line).trim(), cells = [];
    let cell = '', code = '';
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      if (c === '`' && (code || !escapedAt(value, i))) {
        const run = /^`+/.exec(value.slice(i))[0];
        if (code === run) code = ''; else if (!code && codeEnd(value, run, i + run.length) >= 0) code = run;
        cell += run; i += run.length - 1; continue;
      }
      if (c === '|' && !escapedAt(value, i) && !code) { cells.push(cell.trim()); cell = ''; } else cell += c;
    }
    cells.push(cell.trim());
    if (value.startsWith('|')) cells.shift();
    if (value.endsWith('|') && !escapedAt(value, value.length - 1)) cells.pop();
    return cells;
  }
  // lib/markdown.js reads ANY line holding a '|' as a table header when the next line is a divider row with the same
  // number of cells. A '---' divider is one cell, so it turns a line like `a \| b` or `x |` (one cell) into a table and
  // every plain line after it into rows. serialize keeps such a pair apart with a blank line.
  const readsAsTable = (line, next) => {
    if (!str(line).includes('|')) return false;
    const divider = tableCells(next);
    return divider.length > 0 && divider.every(cell => /^:?-+:?$/.test(cell)) && tableCells(line).length === divider.length;
  };

  function listMarkdown(block, levels) {
    const indent = Math.max(0, Math.min(block.indent || 0, levels.length));
    levels.length = Math.min(levels.length, indent + 1);
    const previous = levels[indent];
    const number = block.type !== 'number' ? 0 : previous?.type === 'number' ? previous.number + 1 : Number.isSafeInteger(block.ordinal) ? block.ordinal : 1;
    const parent = indent ? levels[indent - 1].content : 0;
    const width = previous && previous.width >= parent ? previous.width : parent;
    const marker = block.type === 'number' ? `${number}. ` : block.type === 'todo' ? (block.checked ? '- [x] ' : '- [ ] ') : '- ';
    const content = width + (block.type === 'number' ? String(number).length + 1 : 1) + 1;
    levels[indent] = { type: block.type, number, width, content };
    return ' '.repeat(width) + marker + hardLines(block.text, line => block.type === 'bullet' && /^\[[ xX]\](?: |$)/.test(line) ? '\\' + line : line, ' '.repeat(content));
  }

  function blockMarkdown(block, levels) {
    switch (block.type) {
      case 'h1': case 'h2': case 'h3': return '#'.repeat(Number(block.type[1])) + ' ' + oneLine(block.text);
      case 'bullet': case 'number': case 'todo': return listMarkdown(block, levels);
      case 'quote': return quoteLines(block.text).join('\n');
      case 'callout': { const text = str(block.text).replace(/\n+$/, ''); return `> [!${block.kind.toUpperCase()}]` + (text ? '\n' + quoteLines(text, 'x').join('\n') : ''); }
      case 'code': {
        let count = 3;
        for (const line of block.text.split('\n')) { const m = /^(`+)/.exec(line); if (m) count = Math.max(count, m[1].length + 1); }
        const fence = '`'.repeat(count);
        return fence + (block.language || '') + '\n' + block.text + '\n' + fence;
      }
      case 'table': {
        const width = Math.max(1, block.headers.length, ...block.rows.map(row => row.length));
        const row = values => '| ' + Array.from({ length: width }, (_, i) => escapeTableCell(values[i] ?? '')).join(' | ') + ' |';
        return [row(block.headers), row(Array(width).fill('---')), ...block.rows.map(row)].join('\n');
      }
      case 'divider': return '---';
      case 'image': return `![${escapeLabel(escapeText(block.alt))}](${block.url})`;
      case 'embed': { const label = str(block.label).replace(/\r?\n/g, ' ').replace(/[\\\]]/g, '\\$&'); return `::embed[${label}](${/[()<>\s]/.test(block.url) ? `<${block.url}>` : block.url})`; }
      case 'toggle': {
        let longest = 2;
        for (const line of str(block.text).split('\n')) if (/^:{3,}$/.test(line)) longest = Math.max(longest, line.length);
        const fence = ':'.repeat(longest + 1);
        return `${fence}toggle [${block.open ? 'open' : 'closed'}] ${oneLine(block.title) || 'Toggle'}\n${block.text || ''}\n${fence}`;
      }
      default: return hardLines(block.text, escapeLineStart);
    }
  }

  // Joins blocks with single newlines. A blank line goes only where the parser needs one: between quotes, after a table
  // whose next line would read as a row, between two separate lists, and between a line with a '|' and a next line
  // that would read as its table divider (a '---' after a one-cell line). Stops before a block that would pass `limit`
  // (never inside a code fence or table) and reports `truncated`.
  function serialize(blocks, limit = Infinity) {
    const parts = [], emitted = [];
    let size = 0, previous = null, previousLine = '', levels = [], truncated = false;
    for (const block of blocks) {
      const list = LIST_BLOCKS.has(block.type);
      const separate = list && previous && LIST_BLOCKS.has(previous.type) && block.listStart && !block.indent;
      if (!list || separate) levels = [];
      const body = blockMarkdown(block, levels), first = body.split('\n')[0];
      // After a table its own row loop decides where it ends; anything else is checked as a would-be table header.
      const gap = separate || (previous && (((previous.type === 'quote' || previous.type === 'callout') && block.type === 'quote')
        || (previous.type === 'table' ? !endsTable(first) : readsAsTable(previousLine, first)))) ? '\n' : '';
      const piece = (parts.length ? '\n' : '') + gap + body;
      if (size + piece.length > limit) {
        truncated = true;
        // A first paragraph longer than the whole limit is cut on a word boundary rather than dropped.
        if (!parts.length && block.type === 'paragraph') {
          const text = escapeText(shorten(inlinePlain(block.text), Math.max(1, limit - 8)));
          const line = escapeLineStart(text);
          if (text && line.length <= limit) { parts.push(line); emitted.push({ type: 'paragraph', text }); }
        }
        break;
      }
      parts.push(piece);
      emitted.push(block);
      size += piece.length;
      previous = block;
      previousLine = body.slice(body.lastIndexOf('\n') + 1);
    }
    return { markdown: parts.join(''), truncated, emitted };
  }

  function blockPlain(block) {
    switch (block.type) {
      case 'code': return block.text;
      case 'table': return [block.headers, ...block.rows].map(row => row.map(cell => inlinePlain(str(cell).replace(/<br\s*\/?>/gi, ' '))).filter(Boolean).join(' ')).join('\n');
      case 'toggle': return [inlinePlain(block.title), ...(block.children || []).map(blockPlain)].filter(Boolean).join('\n');
      case 'image': case 'divider': case 'embed': return '';
      default: return inlinePlain(block.text);
    }
  }
  const plainLength = blocks => blocks.reduce((total, block) => total + blockPlain(block).trim().length, 0);

  // Empty paragraphs, repeated dividers and doubled images go; so does a leading heading that repeats the title.
  function tidy(blocks, title = '') {
    const out = [];
    for (const block of blocks) {
      const last = out[out.length - 1];
      if (block.type === 'paragraph' && !block.text.trim()) continue;
      if (block.type === 'divider' && (!last || last.type === 'divider')) continue;
      if (block.type === 'image' && last?.type === 'image' && last.url === block.url) continue;
      if (block.type === 'code' && languageLabel(last, block.language)) out.pop();
      out.push(block);
    }
    while (out.length && out[out.length - 1].type === 'divider') out.pop();
    const key = compareKey(title);
    if (key) {
      const index = out.slice(0, 3).findIndex(block => /^h[1-3]$/.test(block.type));
      if (index >= 0 && compareKey(inlinePlain(out[index].text)) === key) out.splice(index, 1);
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Metadata (read from the live document, never written).

  function readMeta(doc) {
    const values = new Map();
    for (const el of Array.from(doc.getElementsByTagName('meta'))) {
      const content = attr(el, 'content');
      if (!content) continue;
      const keys = [attr(el, 'property'), attr(el, 'name'), attr(el, 'itemprop'), attr(el, 'http-equiv') && 'http-equiv:' + attr(el, 'http-equiv')];
      for (const key of keys) { const name = str(key).trim().toLowerCase(); if (name && !values.has(name)) values.set(name, content); }
    }
    const get = (...names) => { for (const name of names) { const value = clean(values.get(name), 5000); if (value) return value; } return ''; };
    const all = (...names) => names.map(name => str(values.get(name)).trim()).filter(Boolean);
    return { get, all };
  }

  const STRICT_ARTICLE = /^(?:Article|AdvertiserContentArticle|NewsArticle|AnalysisNewsArticle|AskPublicNewsArticle|BackgroundNewsArticle|OpinionNewsArticle|ReportageNewsArticle|ReviewNewsArticle|Report|SatiricalArticle|ScholarlyArticle|MedicalScholarlyArticle|SocialMediaPosting|BlogPosting|LiveBlogPosting|DiscussionForumPosting|TechArticle|APIReference|Recipe|HowTo)$/;
  const LOOSE_ARTICLE = /^(?:WebPage|ItemPage|AboutPage|FAQPage|QAPage|VideoObject|CreativeWork)$/;
  function findLd(value, test, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 5) return null;
    if (Array.isArray(value)) { for (const entry of value.slice(0, 50)) { const hit = findLd(entry, test, depth + 1); if (hit) return hit; } return null; }
    const types = [].concat(value['@type'] || []).map(type => str(type).replace(/^.*[/#]/, ''));
    if (types.some(type => test.test(type))) return value;
    return value['@graph'] ? findLd(value['@graph'], test, depth + 1) : null;
  }
  const ldName = value => typeof value === 'string' ? value : Array.isArray(value) ? value.slice(0, 10).map(ldName).filter(Boolean).join(', ') : value && typeof value === 'object' ? str(value.name) : '';
  const ldImage = value => typeof value === 'string' ? value : Array.isArray(value) ? ldImage(value[0]) : value && typeof value === 'object' ? str(value.url || value.contentUrl) : '';
  // The first Article-family JSON-LD object (then a WebPage-like one). JSON.parse only: nothing in it runs.
  function readJsonLd(doc) {
    const parsed = [];
    for (const script of Array.from(doc.getElementsByTagName('script'))) {
      if (!/ld\+json/i.test(attr(script, 'type'))) continue;
      const source = str(script.textContent);
      if (source.length > JSON_LD_LIMIT) continue;
      try { parsed.push(JSON.parse(source.replace(/^\s*(?:<!\[CDATA\[|<!--)|(?:\]\]>|-->)\s*$/g, ''))); } catch { /* Malformed JSON-LD is common; skip it. */ }
    }
    const found = findLd(parsed, STRICT_ARTICLE) || findLd(parsed, LOOSE_ARTICLE);
    if (!found) return {};
    return { title: clean(found.headline || found.name, 500), author: clean(ldName(found.author || found.creator), 300), published: str(found.datePublished || found.uploadDate || found.dateCreated),
      siteName: clean(ldName(found.publisher), 200), description: clean(found.description, 5000), image: ldImage(found.image || found.thumbnailUrl) };
  }

  function toIso(value) {
    const text = clean(value, 100);
    if (!text) return '';
    const time = Date.parse(text);
    if (!Number.isFinite(time)) return '';
    const year = new Date(time).getUTCFullYear();
    return year >= 1970 && year <= 2200 ? new Date(time).toISOString() : '';
  }
  const langTag = value => { const tag = clean(value, 35).replace(/_/g, '-'); return /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i.test(tag) ? tag : ''; };
  const isUrl = value => /^https?:\/\//i.test(str(value).trim());
  const cleanAuthor = value => { const text = clean(value, 300).replace(/^by\s+/i, ''); return isUrl(text) ? '' : text; };
  const relTokens = el => attr(el, 'rel').toLowerCase().split(/\s+/).filter(Boolean);

  // Ranked page icon (no network): link rel icon and apple-touch-icon, never mask-icon (a monochrome stencil). Size 32+
  // first, then PNG/SVG/apple-touch over other rasters and ICO, then a size near 64-180 px. A declared /favicon.ico can
  // win only when nothing else is declared; an undeclared one is never guessed.
  function pickIcon(doc, base) {
    const formats = { svg: 3, png: 3, raster: 2, unknown: 1, ico: 0 };
    const candidates = [];
    for (const link of Array.from(doc.getElementsByTagName('link'))) {
      const rel = relTokens(link);
      if (rel.includes('mask-icon')) continue;
      const apple = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed');
      if (!apple && !rel.includes('icon')) continue;
      const url = iconUrl(attr(link, 'href'), base);
      if (!url) continue;
      const type = attr(link, 'type').toLowerCase(), target = url.toLowerCase().split(/[?#]/)[0];
      const format = /svg/.test(type) || /\.svg$/.test(target) || /^data:image\/svg/.test(target) ? 'svg'
        : /png/.test(type) || /\.png$/.test(target) || /^data:image\/png/.test(target) ? 'png'
          : /icon/.test(type) || /\.ico$/.test(target) || /^data:image\/(?:x-icon|vnd)/.test(target) ? 'ico'
            : /jpe?g|webp|gif/.test(type) || /\.(?:jpe?g|webp|gif)$/.test(target) ? 'raster' : apple ? 'png' : 'unknown';
      const sizes = attr(link, 'sizes').toLowerCase();
      let size = /\bany\b/.test(sizes) ? 512 : 0;
      for (const m of sizes.matchAll(/(\d+)x(\d+)/g)) size = Math.max(size, Math.min(Number(m[1]), Number(m[2])));
      if (!size && apple) size = 180;
      if (!size && format === 'svg') size = 512;
      const fit = size >= 64 && size <= 180 ? 3 : size > 180 ? 2 : size >= 32 ? 1 : 0;
      candidates.push({ url, rank: [size >= 32 ? 1 : 0, formats[format], fit, size], index: candidates.length });
    }
    candidates.sort((a, b) => { for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return b.rank[i] - a.rank[i]; return a.index - b.index; });
    return candidates[0]?.url || '';
  }

  function stripSiteSuffix(title, siteName) {
    if (!siteName) return title;
    const m = /^(.*\S)\s+[|\-–—·:»/]\s+(.+)$/.exec(title);
    return m && sameText(m[2], siteName) ? m[1] : title;
  }

  // PageMeta. `reader` is the Readability result when there is one: its title (unless it only names the site), byline,
  // site, date, excerpt, language and direction come before the page's own tags.
  function pageMeta(doc, reader = null) {
    const meta = readMeta(doc), ld = readJsonLd(doc);
    const url = str(doc.URL) || str(globalThis.location?.href);
    const base = str(doc.baseURI) || url;
    const siteName = clean(reader?.siteName || meta.get('og:site_name') || ld.siteName || meta.get('application-name', 'apple-mobile-web-app-title'), 200);
    const readerTitle = clean(reader?.title, 2000);
    const firstHeading = clean(doc.getElementsByTagName('h1')[0]?.textContent, 2000);
    const title = readerTitle && !sameText(readerTitle, siteName) ? readerTitle
      : meta.get('og:title') || stripSiteSuffix(clean(doc.title, 2000), siteName) || meta.get('twitter:title') || ld.title || firstHeading;
    const canonicalLink = Array.from(doc.getElementsByTagName('link')).find(link => relTokens(link).includes('canonical'));
    const relAuthor = typeof doc.querySelector === 'function' ? doc.querySelector('[rel~="author"], [itemprop="author"] [itemprop="name"], [itemprop="author"]') : null;
    const author = cleanAuthor(reader?.byline) || cleanAuthor(ld.author) || cleanAuthor(meta.get('author', 'dc.creator', 'dcterms.creator', 'parsely-author', 'sailthru.author'))
      || cleanAuthor(meta.get('article:author')) || cleanAuthor(clean(attr(relAuthor, 'content') || relAuthor?.textContent, 120));
    const published = [reader?.publishedTime, ld.published, ...meta.all('article:published_time', 'datepublished', 'datecreated', 'uploaddate',
      'parsely-pub-date', 'pubdate', 'publishdate', 'dc.date', 'dc.date.issued', 'dcterms.date', 'sailthru.date', 'date')].map(toIso).find(Boolean) || '';
    const lang = langTag(attr(doc.documentElement, 'lang')) || langTag(meta.get('og:locale')) || langTag(meta.get('http-equiv:content-language').split(',')[0]) || langTag(reader?.lang);
    const dir = [attr(doc.documentElement, 'dir'), attr(doc.body, 'dir'), str(reader?.dir)].map(value => value.toLowerCase()).find(value => value === 'ltr' || value === 'rtl') || '';
    const description = meta.get('description', 'og:description', 'twitter:description') || ld.description || clean(reader?.excerpt, 5000);
    const covers = [...meta.all('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'), ld.image,
      attr(Array.from(doc.getElementsByTagName('link')).find(link => relTokens(link).includes('image_src')), 'href')];
    return {
      url, canonicalUrl: httpUrl(attr(canonicalLink, 'href'), base) || httpUrl(meta.get('og:url'), base) || url,
      title, siteName, author, publishedAt: published, lang, dir, excerpt: shorten(description, EXCERPT_LIMIT),
      icon: pickIcon(doc, base), cover: covers.map(value => httpUrl(value, base)).find(Boolean) || '',
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Results

  // `state` is the conversion state; running out of budget or clipping a huge table counts as truncation.
  function finish({ source, meta, blocks, limit, state = null, title = '', extra = {} }) {
    const { markdown, truncated, emitted } = serialize(tidy(blocks, title), limit);
    const text = emitted.map(blockPlain).filter(part => part.trim()).join('\n');
    const images = [...new Set(emitted.filter(block => block.type === 'image').map(block => block.url))].slice(0, MAX_IMAGES);
    if (!text.trim() && !images.length && !emitted.some(block => block.type === 'embed')) return failure('empty');
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    // Cover: the page's own image, else the first content image that is not obviously small.
    const large = emitted.find(block => block.type === 'image' && (block.width === null || block.width >= 200) && (block.height === null || block.height >= 100));
    const firstParagraph = emitted.find(block => block.type === 'paragraph' && !block.caption && blockPlain(block).trim().length > 40);
    return {
      ok: true, source, url: meta.url, canonicalUrl: meta.canonicalUrl, title: meta.title, siteName: meta.siteName, author: meta.author,
      publishedAt: meta.publishedAt, lang: meta.lang, dir: meta.dir,
      // A selection is described by its own words; anything else by the page's description first.
      excerpt: (source !== 'selection' && meta.excerpt) || shorten(firstParagraph ? blockPlain(firstParagraph) : text, EXCERPT_LIMIT),
      icon: meta.icon, cover: meta.cover || (large ? httpUrl(large.url) : ''),
      markdown, text, wordCount: words, readingMinutes: words ? Math.max(1, Math.round(words / 230)) : 0,
      images, truncated: truncated || !!state?.exhausted || !!state?.clipped, ...extra,
    };
  }

  // ---- site readers (each returns null to fall through to the generic reader; extract also falls through on a failed
  // result, e.g. a GitHub page whose README is empty)

  const statusId = href => /\/status(?:es)?\/(\d{5,25})/.exec(str(href))?.[1] || '';

  function readX(doc, page, limit) {
    const host = page.hostname.replace(/^(?:www|mobile)\./, '');
    if (host !== 'x.com' && host !== 'twitter.com') return null;
    const match = /^\/(\w{1,30})\/status(?:es)?\/(\d{5,25})/.exec(page.pathname);
    if (!match) return null;
    const tweets = Array.from(doc.querySelectorAll('article[data-testid="tweet"]'));
    if (!tweets.length) return null;
    const id = match[2];
    const focal = tweets.find(tweet => Array.from(tweet.querySelectorAll('a[href*="/status/"]')).some(a => statusId(attr(a, 'href')) === id && a.querySelector('time'))) || tweets[0];
    // A quoted post sits inside the focal post in a role="link" box.
    const quoted = el => { for (let node = el.parentNode; node && node !== focal; node = node.parentNode) if (attr(node, 'role') === 'link') return true; return false; };
    const own = selector => Array.from(focal.querySelectorAll(selector)).filter(el => !quoted(el));
    const inQuote = selector => Array.from(focal.querySelectorAll(selector)).filter(quoted);
    const person = el => {
      if (!el) return { name: '', handle: '' };
      const all = clean(el.textContent, 300), handle = /@(\w{1,15})/.exec(all)?.[1] || '';
      let name = clean(el.querySelector('a[href]')?.textContent || all, 120);
      if (handle) name = clean(name.split('@' + handle)[0], 120);
      return { name: name.replace(/\s*·.*$/, ''), handle };
    };
    const byline = ({ name, handle }) => [name && `**${escapeText(name)}**`, handle && escapeText('@' + handle)].filter(Boolean).join(' ');
    const state = createState({ base: str(doc.baseURI) || page.href, live: true });
    const author = person(own('[data-testid="User-Name"]')[0]);
    if (!author.handle) author.handle = match[1];
    const textEl = own('[data-testid="tweetText"]')[0];
    const body = textEl ? convertRoot(textEl, state) : [];
    const blocks = [{ type: 'paragraph', text: byline(author) }, ...body];
    for (const img of own('[data-testid="tweetPhoto"] img')) {
      const info = imageInfo(img, state);
      if (info?.url) blocks.push({ type: 'image', url: info.url.replace(/([?&]name=)(?:small|medium|thumb|\d+x\d+)\b/, '$1large'), alt: info.alt === 'Image' ? '' : info.alt, width: null, height: null });
    }
    for (const video of own('[data-testid="videoPlayer"] video')) {
      const poster = markdownUrl(attr(video, 'poster'), page.href);
      if (poster) blocks.push({ type: 'image', url: poster, alt: 'Video', width: null, height: null });
    }
    const quotedText = inQuote('[data-testid="tweetText"]')[0];
    if (quotedText) {
      const quotedBy = byline(person(inQuote('[data-testid="User-Name"]')[0]));
      const { text } = quoteText([...(quotedBy ? [{ type: 'paragraph', text: quotedBy }] : []), ...convertRoot(quotedText, state)]);
      if (text) blocks.push({ type: 'quote', text });
    }
    if (!body.length && blocks.length === 1) return null;
    const plain = body.map(blockPlain).join(' ').trim(), who = author.name || '@' + author.handle;
    const time = own('time[datetime]')[0];
    const meta = pageMeta(doc, null);
    return finish({ source: 'site:x', blocks, limit, state, meta: { ...meta,
      title: plain ? `${who} on X: "${shorten(plain, 80)}"` : `${who} on X`, siteName: 'X', author: author.name ? `${author.name} (@${author.handle})` : '@' + author.handle,
      publishedAt: toIso(attr(time, 'datetime')) || meta.publishedAt, canonicalUrl: `https://x.com/${match[1]}/status/${id}`,
      excerpt: shorten(plain, EXCERPT_LIMIT) || meta.excerpt, cover: blocks.find(block => block.type === 'image')?.url || meta.cover } });
  }

  const GITHUB_RESERVED = new Set(['about', 'apps', 'codespaces', 'collections', 'contact', 'enterprise', 'events', 'explore', 'features', 'issues', 'login',
    'marketplace', 'new', 'notifications', 'orgs', 'pricing', 'pulls', 'search', 'settings', 'site', 'sponsors', 'topics', 'trending']);
  function readGitHub(doc, page, limit) {
    if (page.hostname !== 'github.com') return null;
    const parts = page.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || GITHUB_RESERVED.has(parts[0].toLowerCase())) return null;
    if (parts.length > 2 && parts[2] !== 'tree' && parts[2] !== 'blob') return null;
    const readme = doc.querySelector('article.markdown-body');
    if (!readme) return null;
    const [owner, repo] = parts, values = readMeta(doc);
    let description = '';
    for (const selector of ['[itemprop="about"]', '.BorderGrid p.f4', 'p.f4.my-3']) { description = clean(doc.querySelector(selector)?.textContent, 1000); if (description) break; }
    if (!description) {
      description = values.get('description', 'og:description').replace(/^GitHub - [^:]+:\s*/, '').replace(/\.?\s*Contribute to \S+ development by creating an account on GitHub\.?$/i, '');
    }
    const topics = [...new Set(Array.from(doc.querySelectorAll('a.topic-tag, a[href^="/topics/"]')).map(a => clean(a.textContent, 50)).filter(Boolean))].slice(0, 20);
    const state = createState({ base: str(doc.baseURI) || page.href, live: true });
    const blocks = [];
    if (description) blocks.push({ type: 'paragraph', text: escapeText(description) });
    if (topics.length) blocks.push({ type: 'paragraph', text: escapeText('Topics: ' + topics.join(', ')) });
    if (blocks.length) blocks.push({ type: 'divider' });
    blocks.push(...convertRoot(readme, state));
    const path = parts.slice(4).map(part => { try { return decodeURIComponent(part); } catch { return part; } }).join('/');
    const meta = pageMeta(doc, null);
    return finish({ source: 'site:github', blocks, limit, state, meta: { ...meta,
      title: path ? `${owner}/${repo}: ${path}` : `${owner}/${repo}`, siteName: 'GitHub', author: owner,
      canonicalUrl: parts.length === 2 ? `https://github.com/${owner}/${repo}` : page.origin + page.pathname,
      excerpt: shorten(description, EXCERPT_LIMIT) || meta.excerpt } });
  }

  function readYouTube(doc, page, limit) {
    const host = page.hostname.replace(/^(?:www|m|music)\./, '');
    if (host !== 'youtube.com' || page.pathname !== '/watch') return null;
    const id = page.searchParams.get('v') || '';
    if (!/^[\w-]{6,20}$/.test(id)) return null;
    const values = readMeta(doc);
    // YouTube is a single-page app: after in-app navigation its <meta> tags still describe the first video, so they
    // count only when they name this one.
    const canonical = attr(Array.from(doc.getElementsByTagName('link')).find(link => relTokens(link).includes('canonical')), 'href');
    const fresh = [values.get('videoid'), values.get('identifier'), values.get('og:url'), canonical].some(value => value && value.includes(id));
    const domText = selectors => { for (const selector of selectors) { const text = clean(doc.querySelector(selector)?.textContent, 500); if (text) return text; } return ''; };
    const title = domText(['h1.ytd-watch-metadata yt-formatted-string', 'ytd-watch-metadata h1', '#title h1', 'h1.title'])
      || (fresh ? values.get('og:title', 'title', 'name') : '') || clean(str(doc.title).replace(/^\(\d+\)\s*/, '').replace(/\s+-\s+YouTube$/, ''), 500) || 'YouTube video';
    const channelLink = doc.querySelector('ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a, ytd-video-owner-renderer #channel-name a, #upload-info #channel-name a');
    let channel = clean(channelLink?.textContent, 200), channelUrl = channelLink ? markdownUrl(attr(channelLink, 'href'), page.href) : '';
    if (!channel && fresh) {
      const box = doc.querySelector('[itemprop="author"]');
      channel = clean(attr(box?.querySelector('[itemprop="name"]'), 'content') || box?.querySelector('[itemprop="name"]')?.textContent, 200);
      channelUrl = markdownUrl(attr(box?.querySelector('[itemprop="url"]'), 'href'), page.href);
    }
    const descriptionEl = doc.querySelector('#description-inline-expander yt-attributed-string, ytd-text-inline-expander yt-attributed-string, #description yt-formatted-string, ytd-expandable-video-description-body-renderer');
    const description = str(descriptionEl?.textContent).trim() || (fresh ? values.get('description', 'og:description') : '');
    const watch = `https://www.youtube.com/watch?v=${id}`;
    const blocks = [{ type: 'embed', url: watch, label: title }];
    if (channel) blocks.push({ type: 'paragraph', text: 'Channel: ' + (channelUrl ? `[${escapeLabel(escapeText(channel))}](${channelUrl})` : escapeText(channel)) });
    for (const paragraph of description.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
      const lines = paragraph.split('\n').map(line => escapeText(collapse(line).trim())).filter(Boolean);
      if (lines.length) blocks.push({ type: 'paragraph', text: lines.join('\n') });
    }
    const meta = pageMeta(doc, null);
    return finish({ source: 'site:youtube', blocks, limit, meta: { ...meta, title, siteName: 'YouTube', author: channel,
      publishedAt: fresh ? toIso(values.get('datepublished', 'uploaddate')) : '', canonicalUrl: watch, excerpt: shorten(description, EXCERPT_LIMIT),
      cover: (fresh && meta.cover) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } });
  }

  // ---- generic reader

  // Readability strips classes, so what the converter needs from them is first recorded as data attributes on the
  // clone; the clone is never rendered, so the live page's loaded image and its natural size are copied across too.
  function prepareClone(clone, live) {
    // Images first, while the clone is still an exact copy: removing noise below may take images with it, and the two
    // lists only pair up by index while they hold the same elements.
    const liveImages = live.getElementsByTagName('img'), cloneImages = clone.getElementsByTagName('img');
    if (liveImages.length === cloneImages.length) {
      for (let i = 0; i < liveImages.length; i++) {
        const source = liveImages[i], src = str(source.currentSrc);
        if (!/^https?:/i.test(src)) continue;
        cloneImages[i].setAttribute('data-still-src', src);
        if (source.naturalWidth > 0 && source.naturalHeight > 0) cloneImages[i].setAttribute('data-still-size', `${source.naturalWidth}x${source.naturalHeight}`);
      }
    }
    for (const el of Array.from(clone.getElementsByTagName('*'))) {
      const tag = tagOf(el), cls = attr(el, 'class');
      if (cls && NOISE.test(cls)) { el.remove(); continue; }
      if (tag === 'img' && MATH_IMAGE.test(cls)) { el.setAttribute('data-still-math', attr(el, 'alt')); continue; }
      if (tag === 'input' && /^checkbox$/i.test(attr(el, 'type'))) {
        const li = typeof el.closest === 'function' ? el.closest('li') : null;
        if (li && !has(li, 'data-still-task')) li.setAttribute('data-still-task', has(el, 'checked') ? 'checked' : 'open');
        continue;
      }
      if (!cls) continue;
      const own = tag === 'pre' || tag === 'code', language = languageFromClass(cls, own);
      if (language) {
        const target = own ? el : el.querySelector('pre');
        if (target && !has(target, 'data-still-lang')) target.setAttribute('data-still-lang', language);
      }
      const kind = calloutFromClass(cls);
      if (kind && !has(el, 'data-still-callout')) el.setAttribute('data-still-callout', kind);
      if (CALLOUT_TITLE.test(cls) || (GUTTER.test(cls) && typeof el.closest === 'function' && el.closest('pre, table'))) el.setAttribute('data-still-skip', '');
    }
  }

  function runReadability(doc) {
    const Reader = globalThis.Readability;
    if (typeof Reader !== 'function' || doc.getElementsByTagName('*').length > READABILITY_MAX_ELEMENTS) return null;
    try {
      const clone = doc.cloneNode(true);
      prepareClone(clone, doc);
      const parsed = new Reader(clone, { charThreshold: 250, serializer: el => el }).parse();
      return parsed && parsed.content && parsed.content.nodeType === 1 ? parsed : null;
    } catch {
      return null; // Trusted Types, odd markup or a library bug: the walker below still reads the page.
    }
  }

  function fallbackRoots(doc) {
    const roots = [], articles = doc.getElementsByTagName('article');
    if (articles.length === 1) roots.push(articles[0]);
    const main = doc.querySelector('main, [role="main"]');
    if (main && !roots.includes(main)) roots.push(main);
    if (doc.body && !roots.includes(doc.body)) roots.push(doc.body);
    return roots;
  }

  function extract(options = {}) {
    try {
      const limit = charLimit(options?.maxChars);
      const doc = globalThis.document;
      if (!doc || !doc.documentElement || !doc.body) return failure('unreadable');
      if (/^(?:application\/pdf|image\/|video\/|audio\/)/i.test(str(doc.contentType))) return failure('unreadable');
      let page = null;
      try { page = new URL(str(doc.URL) || str(globalThis.location?.href)); } catch { page = null; }
      if (page) {
        for (const reader of [readX, readGitHub, readYouTube]) {
          let result = null;
          try { result = reader(doc, page, limit); } catch { result = null; }
          if (result?.ok) return result;
        }
      }
      const base = str(doc.baseURI) || str(doc.URL);
      const reader = runReadability(doc);
      const attempts = [];
      if (reader) {
        const state = createState({ base, strip: true });
        const blocks = convertRoot(reader.content, state);
        attempts.push({ source: 'readability', blocks, state, length: plainLength(blocks) });
      }
      if (!attempts.length || attempts[0].length < MIN_ARTICLE_TEXT) {
        for (const root of fallbackRoots(doc)) {
          const state = createState({ base, strip: true, live: true });
          const blocks = convertRoot(root, state);
          attempts.push({ source: 'fallback', blocks, state, length: plainLength(blocks) });
          if (attempts[attempts.length - 1].length >= MIN_ARTICLE_TEXT) break;
        }
      }
      const chosen = attempts.find(attempt => attempt.length >= MIN_ARTICLE_TEXT) || attempts.reduce((best, attempt) => (!best || attempt.length > best.length ? attempt : best), null);
      if (!chosen) return failure('empty');
      const meta = pageMeta(doc, reader);
      return finish({ source: chosen.source, meta, blocks: chosen.blocks, limit, state: chosen.state, title: meta.title });
    } catch {
      return failure('error');
    }
  }

  function fromElements(elements, options = {}) {
    try {
      const limit = charLimit(options?.maxChars);
      const input = elements && elements.nodeType === 1 ? [elements] : Array.from(elements || []);
      const unique = [];
      for (const el of input) if (el && el.nodeType === 1 && !unique.includes(el) && unique.length < 500) unique.push(el);
      // Never the same content twice: a selection inside another selection is dropped. Then document order.
      const roots = unique.filter(el => !unique.some(other => other !== el && typeof other.contains === 'function' && other.contains(el)));
      roots.sort((a, b) => typeof a.compareDocumentPosition === 'function' ? (a.compareDocumentPosition(b) & 2 ? 1 : -1) : 0);
      if (!roots.length) return failure('empty', MESSAGES.noSelection);
      const doc = roots[0].ownerDocument || globalThis.document;
      const meta = pageMeta(doc, null);
      const state = createState({ base: str(doc.baseURI) || meta.url, live: true });
      const blocks = [];
      for (const root of roots) { if (state.exhausted) break; blocks.push(...convertRoot(root, state)); }
      return finish({ source: 'selection', meta, blocks, limit, state, extra: { selectionCount: roots.length } });
    } catch {
      return failure('error');
    }
  }

  function toMarkdown(root, options = {}) {
    try {
      if (!root || ![1, 9, 11].includes(root.nodeType)) return '';
      const node = root.nodeType === 9 ? root.body || root.documentElement : root;
      const doc = node.ownerDocument || globalThis.document;
      const live = doc === globalThis.document && !!node.isConnected;
      const state = createState({ base: str(options?.baseUrl) || str(doc?.baseURI) || str(globalThis.location?.href), live });
      return serialize(tidy(convertRoot(node, state)), charLimit(options?.maxChars)).markdown;
    } catch {
      return '';
    }
  }

  function metadata() {
    try {
      return pageMeta(globalThis.document, null);
    } catch {
      return { url: str(globalThis.location?.href), canonicalUrl: str(globalThis.location?.href), title: '', siteName: '', author: '', publishedAt: '', lang: '', dir: '', excerpt: '', icon: '', cover: '' };
    }
  }

  // Configurable so a newer build injected into a page that still holds an older copy can replace it.
  Object.defineProperty(globalThis, '__stillArticle', {
    value: Object.freeze({ version: VERSION, extract, fromElements, toMarkdown, metadata }),
    configurable: true, enumerable: false, writable: false,
  });
})();
