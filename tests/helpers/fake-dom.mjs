// A small, dependency-free HTML parser and DOM subset for tests of scripts that run inside web pages
// (content/article-extract.js and the vendored Readability). It covers what those scripts touch: the node tree and
// its mutation methods, attributes, innerHTML/outerHTML, textContent, tag and selector queries, a document with
// URL/baseURI/title, document.cloneNode and an inline-style-only getComputedStyle. It is not a browser: there is no
// layout, no CSS cascade, no events and no script execution, and the parser applies only the implied-end-tag rules
// that ordinary article markup needs. Unsupported selectors throw, so a test never passes by accident.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes', 'textarea', 'title']);
const ESCAPABLE_RAW = new Set(['textarea', 'title']);
const HEAD_TAGS = new Set(['title', 'meta', 'link', 'base', 'style', 'script', 'noscript', 'template']);
// Start tags that close an open <p> (HTML's "close a p element" rule, simplified).
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
  'li', 'dd', 'dt', 'summary']);
const BLOCK_DISPLAY = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'details', 'dialog', 'dd', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'main', 'menu', 'nav', 'ol', 'p',
  'pre', 'section', 'summary', 'ul']);
const HIDDEN_DISPLAY = new Set(['head', 'script', 'style', 'template', 'title', 'meta', 'link', 'base', 'noscript']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—',
  ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•', times: '×', eacute: 'é', shy: '\u00ad',
  zwj: '\u200d', zwnj: '\u200c' };

export function decodeEntities(text) {
  return String(text).replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]*);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : whole;
  });
}
const escapeText = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
const escapeAttribute = text => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;');
const camel = name => name.replace(/-([a-z])/g, (m, c) => c.toUpperCase());

class Attr {
  constructor(name, value) { this.name = name; this.localName = name; this.value = String(value); }
  get nodeValue() { return this.value; }
  cloneNode() { return new Attr(this.name, this.value); }
}

export class Node {
  constructor(document) { this.ownerDocument = document; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get nextSibling() { const list = this.parentNode?.childNodes; return list ? list[list.indexOf(this) + 1] || null : null; }
  get previousSibling() { const list = this.parentNode?.childNodes; return list ? list[list.indexOf(this) - 1] || null : null; }
  get nextElementSibling() { const list = this.parentNode?.childNodes || []; for (let i = list.indexOf(this) + 1; i > 0 && i < list.length; i++) if (list[i].nodeType === 1) return list[i]; return null; }
  get previousElementSibling() { const list = this.parentNode?.childNodes || []; for (let i = list.indexOf(this) - 1; i >= 0; i--) if (list[i].nodeType === 1) return list[i]; return null; }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get firstElementChild() { return this.childNodes.find(node => node.nodeType === 1) || null; }
  get lastElementChild() { return this.childNodes.findLast(node => node.nodeType === 1) || null; }
  get childElementCount() { return this.children.length; }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node.nodeType === 9; }
  hasChildNodes() { return this.childNodes.length > 0; }
  // Iterative, like browsers, so very deep test documents do not overflow the stack.
  get textContent() {
    let text = '';
    const stack = [...this.childNodes].reverse();
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === 3) text += node.data;
      else if (node.nodeType === 1 || node.nodeType === 11) for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
    return text;
  }
  set textContent(value) { this.replaceChildren(); if (value !== '' && value != null) this.appendChild(this.ownerDocument.createTextNode(String(value))); }
  appendChild(node) { return this.insertBefore(node, null); }
  append(...nodes) { for (const node of nodes) this.appendChild(typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node); }
  insertBefore(node, reference) {
    if (node.nodeType === 11) { for (const child of [...node.childNodes]) this.insertBefore(child, reference); return node; }
    for (let ancestor = this; ancestor; ancestor = ancestor.parentNode) if (ancestor === node) throw new Error('HierarchyRequestError: a node cannot contain itself.');
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = reference ? this.childNodes.indexOf(reference) : -1;
    if (reference && index < 0) throw new Error('NotFoundError: the reference node is not a child.');
    if (index < 0) this.childNodes.push(node); else this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    adopt(node, this.ownerDocument || this);
    return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error('NotFoundError: not a child of this node.');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  replaceChild(node, old) { this.insertBefore(node, old); return this.removeChild(old); }
  replaceChildren(...nodes) { for (const child of [...this.childNodes]) this.removeChild(child); this.append(...nodes); }
  remove() { this.parentNode?.removeChild(this); }
  contains(other) { for (let node = other; node; node = node.parentNode) if (node === this) return true; return false; }
  getRootNode() { let node = this; while (node.parentNode) node = node.parentNode; return node; }
  // Only the bits a document-order sort needs: PRECEDING (2), FOLLOWING (4), CONTAINS (8), CONTAINED_BY (16).
  compareDocumentPosition(other) {
    if (other === this) return 0;
    if (this.contains(other)) return 4 | 16;
    if (other.contains(this)) return 2 | 8;
    const path = node => { const list = []; for (; node; node = node.parentNode) list.unshift(node); return list; };
    const a = path(this), b = path(other);
    if (a[0] !== b[0]) return 1;
    let i = 0; while (a[i] === b[i]) i++;
    const siblings = a[i - 1].childNodes;
    return siblings.indexOf(a[i]) < siblings.indexOf(b[i]) ? 4 : 2;
  }
}
Object.assign(Node, { ELEMENT_NODE: 1, TEXT_NODE: 3, COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_TYPE_NODE: 10, DOCUMENT_FRAGMENT_NODE: 11 });
Object.assign(Node.prototype, { ELEMENT_NODE: 1, TEXT_NODE: 3, COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_TYPE_NODE: 10, DOCUMENT_FRAGMENT_NODE: 11 });

function adopt(node, document) {
  if (node.ownerDocument === document) return;
  node.ownerDocument = document;
  for (const child of node.childNodes) adopt(child, document);
}

export class Text extends Node {
  constructor(document, data) { super(document); this.data = String(data); }
  get nodeType() { return 3; }
  get nodeName() { return '#text'; }
  get nodeValue() { return this.data; }
  set nodeValue(value) { this.data = String(value); }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
  get wholeText() { return this.data; }
  get length() { return this.data.length; }
  cloneNode() { return new Text(this.ownerDocument, this.data); }
}

export class Comment extends Node {
  constructor(document, data) { super(document); this.data = String(data); }
  get nodeType() { return 8; }
  get nodeName() { return '#comment'; }
  get nodeValue() { return this.data; }
  get textContent() { return this.data; }
  cloneNode() { return new Comment(this.ownerDocument, this.data); }
}

class DocumentType extends Node {
  constructor(document, name) { super(document); this.name = name; }
  get nodeType() { return 10; }
  get nodeName() { return this.name; }
  get textContent() { return ''; }
  cloneNode() { return new DocumentType(this.ownerDocument, this.name); }
}

export class DocumentFragment extends Node {
  get nodeType() { return 11; }
  get nodeName() { return '#document-fragment'; }
  cloneNode(deep = false) { const copy = new DocumentFragment(this.ownerDocument); if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true)); return copy; }
  getElementsByTagName(name) { return descendants(this, element => name === '*' || element.localName === String(name).toLowerCase()); }
  querySelectorAll(selector) { return select(this, selector); }
  querySelector(selector) { return select(this, selector, true)[0] || null; }
}

function styleDeclaration(element) {
  const values = new Map();
  for (const part of String(element.getAttribute('style') || '').split(';')) {
    const colon = part.indexOf(':');
    if (colon > 0) values.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).replace(/!important/i, '').trim());
  }
  const style = { getPropertyValue: name => values.get(String(name).toLowerCase()) || '' };
  for (const [name, value] of values) style[camel(name)] = value;
  for (const name of ['display', 'visibility', 'whiteSpace']) style[name] ??= '';
  return style;
}

export class Element extends Node {
  constructor(document, name) { super(document); this.localName = String(name).toLowerCase(); this.attributes = []; }
  get nodeType() { return 1; }
  get tagName() { return this.localName.toUpperCase(); }
  get nodeName() { return this.tagName; }
  get namespaceURI() { return 'http://www.w3.org/1999/xhtml'; }
  getAttributeNode(name) { name = String(name).toLowerCase(); return this.attributes.find(attribute => attribute.name === name) || null; }
  getAttribute(name) { return this.getAttributeNode(name)?.value ?? null; }
  hasAttribute(name) { return !!this.getAttributeNode(name); }
  hasAttributes() { return this.attributes.length > 0; }
  getAttributeNames() { return this.attributes.map(attribute => attribute.name); }
  setAttribute(name, value) {
    name = String(name).toLowerCase();
    const existing = this.getAttributeNode(name);
    if (existing) existing.value = String(value); else this.attributes.push(new Attr(name, value));
  }
  setAttributeNode(attribute) { this.setAttribute(attribute.name, attribute.value); }
  removeAttribute(name) { name = String(name).toLowerCase(); const index = this.attributes.findIndex(attribute => attribute.name === name); if (index >= 0) this.attributes.splice(index, 1); }
  toggleAttribute(name, force) { const on = force ?? !this.hasAttribute(name); if (on) this.setAttribute(name, ''); else this.removeAttribute(name); return on; }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get classList() {
    const tokens = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: token => tokens().includes(token),
      add: (...names) => { this.className = [...new Set([...tokens(), ...names])].join(' '); },
      remove: (...names) => { this.className = tokens().filter(token => !names.includes(token)).join(' '); },
      get length() { return tokens().length; },
      [Symbol.iterator]: () => tokens()[Symbol.iterator](),
    };
  }
  get style() { return styleDeclaration(this); }
  get hidden() { return this.hasAttribute('hidden'); }
  get lang() { return this.getAttribute('lang') || ''; }
  get dir() { return this.getAttribute('dir') || ''; }
  get title() { return this.getAttribute('title') || ''; }
  get open() { return this.hasAttribute('open'); }
  get checked() { return this.hasAttribute('checked'); }
  get srcset() { return this.getAttribute('srcset') || ''; }
  get src() { return this.resolvedAttribute('src'); }
  get href() { return this.resolvedAttribute('href'); }
  get currentSrc() { return ''; }
  get naturalWidth() { return 0; }
  get naturalHeight() { return 0; }
  get complete() { return true; }
  get shadowRoot() { return null; }
  resolvedAttribute(name) {
    const value = this.getAttribute(name);
    if (value === null) return '';
    try { return new URL(value.trim(), this.ownerDocument?.baseURI).href; } catch { return value; }
  }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html) { this.replaceChildren(); for (const node of parseFragment(String(html), this.ownerDocument, this.localName)) this.appendChild(node); }
  get outerHTML() { return serialize(this); }
  get innerText() { return this.textContent; }
  cloneNode(deep = false) {
    const copy = this.ownerDocument.createElement(this.localName);
    for (const attribute of this.attributes) copy.attributes.push(attribute.cloneNode());
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
    return copy;
  }
  getElementsByTagName(name) { return descendants(this, element => name === '*' || element.localName === String(name).toLowerCase()); }
  getElementsByClassName(names) { const wanted = String(names).split(/\s+/).filter(Boolean); return descendants(this, element => wanted.every(name => element.classList.contains(name))); }
  querySelectorAll(selector) { return select(this, selector); }
  querySelector(selector) { return select(this, selector, true)[0] || null; }
  matches(selector) { return parseSelector(selector).some(complex => matchComplex(this, complex)); }
  closest(selector) { const list = parseSelector(selector); for (let node = this; node && node.nodeType === 1; node = node.parentNode) if (list.some(complex => matchComplex(node, complex))) return node; return null; }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

export class Document extends Node {
  constructor(url = 'about:blank') { super(null); this.URL = String(url); this.contentType = 'text/html'; }
  get nodeType() { return 9; }
  get nodeName() { return '#document'; }
  get documentURI() { return this.URL; }
  get baseURI() {
    const base = this.querySelector('base[href]');
    if (base) try { return new URL(base.getAttribute('href').trim(), this.URL).href; } catch { /* An unusable <base> falls back to the URL. */ }
    return this.URL;
  }
  get documentElement() { return this.childNodes.find(node => node.nodeType === 1) || null; }
  get head() { return this.documentElement?.children.find(node => node.localName === 'head') || null; }
  get body() { return this.documentElement?.children.find(node => node.localName === 'body') || null; }
  get title() { const title = this.getElementsByTagName('title')[0]; return title ? title.textContent.replace(/\s+/g, ' ').trim() : ''; }
  set title(value) { let title = this.getElementsByTagName('title')[0]; if (!title) { title = this.createElement('title'); this.head?.appendChild(title); } title.textContent = value; }
  get textContent() { return null; }
  createElement(name) { return new Element(this, name); }
  createTextNode(data) { return new Text(this, data); }
  createComment(data) { return new Comment(this, data); }
  createDocumentFragment() { return new DocumentFragment(this); }
  getElementById(id) { return descendants(this, element => element.id === id)[0] || null; }
  getElementsByTagName(name) { return descendants(this, element => name === '*' || element.localName === String(name).toLowerCase()); }
  getElementsByClassName(names) { return Element.prototype.getElementsByClassName.call(this, names); }
  querySelectorAll(selector) { return select(this, selector); }
  querySelector(selector) { return select(this, selector, true)[0] || null; }
  cloneNode(deep = false) {
    const copy = new Document(this.URL);
    copy.contentType = this.contentType;
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
    return copy;
  }
}

function descendants(root, test) {
  const out = [], stack = [...root.childNodes].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (node.nodeType !== 1) continue;
    if (test(node)) out.push(node);
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Serializer

function serialize(node) {
  if (node.nodeType === 3) {
    const parent = node.parentNode?.localName;
    return parent && RAW_TEXT.has(parent) && !ESCAPABLE_RAW.has(parent) ? node.data : escapeText(node.data);
  }
  if (node.nodeType === 8) return `<!--${node.data}-->`;
  if (node.nodeType === 10) return `<!DOCTYPE ${node.name}>`;
  if (node.nodeType !== 1) return node.childNodes.map(serialize).join('');
  const attributes = node.attributes.map(attribute => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`).join('');
  if (VOID.has(node.localName)) return `<${node.localName}${attributes}>`;
  return `<${node.localName}${attributes}>${node.childNodes.map(serialize).join('')}</${node.localName}>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Parser

const ATTRIBUTE = /\s*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/y;

function* tokenize(html) {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { yield { type: 'text', value: html.slice(i) }; return; }
    if (lt > i) yield { type: 'text', value: html.slice(i, lt) };
    i = lt;
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      yield { type: 'comment', value: html.slice(i + 4, end < 0 ? html.length : end) };
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i);
      const body = html.slice(i + 2, end < 0 ? html.length : end);
      if (/^doctype\s/i.test(body)) yield { type: 'doctype', value: body.slice(8).trim() || 'html' };
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const close = /^<\/([a-zA-Z][\w:-]*)[^>]*>/.exec(html.slice(i, i + 200));
    if (close) { yield { type: 'end', name: close[1].toLowerCase() }; i += close[0].length; continue; }
    const open = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(i, i + 100));
    if (!open) { yield { type: 'text', value: '<' }; i++; continue; }
    const name = open[1].toLowerCase(), attributes = [];
    let j = i + open[0].length, selfClosing = false;
    for (;;) {
      while (/\s/.test(html[j] || '')) j++;
      if (j >= html.length) break;
      if (html[j] === '>') { j++; break; }
      if (html[j] === '/') { selfClosing = html[j + 1] === '>'; j++; continue; }
      ATTRIBUTE.lastIndex = j;
      const match = ATTRIBUTE.exec(html);
      if (!match || match[0].length === 0) { j++; continue; }
      const attributeName = match[1].toLowerCase();
      if (!attributes.some(([existing]) => existing === attributeName)) attributes.push([attributeName, decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')]);
      j = ATTRIBUTE.lastIndex;
    }
    yield { type: 'start', name, attributes, selfClosing };
    i = j;
    if (RAW_TEXT.has(name) && !selfClosing) {
      const closing = new RegExp(`</${name}`, 'ig');
      closing.lastIndex = i;
      const end = closing.exec(html)?.index ?? -1;
      const raw = html.slice(i, end < 0 ? html.length : end);
      if (raw) yield { type: 'text', value: raw, raw: !ESCAPABLE_RAW.has(name) };
      i = end < 0 ? html.length : end;
    }
  }
}

// Builds nodes under `container` (a fragment-like holder). The stack holds open elements; implied end tags cover the
// cases article markup relies on (p, li, dt/dd, table sections, rows and cells, options).
function build(html, document, container, contextTag = '') {
  const stack = [container];
  const current = () => stack[stack.length - 1];
  const openIndex = (names, stopAt = []) => {
    for (let k = stack.length - 1; k > 0; k--) {
      const name = stack[k].localName;
      if (names.includes(name)) return k;
      if (stopAt.includes(name)) return -1;
    }
    return -1;
  };
  const closeTo = index => { if (index > 0) stack.length = index; };
  for (const token of tokenize(html)) {
    if (token.type === 'text') {
      const value = token.raw ? token.value : decodeEntities(token.value);
      if (value) current().appendChild(document.createTextNode(value));
    } else if (token.type === 'comment') current().appendChild(document.createComment(token.value));
    else if (token.type === 'doctype') { if (container.nodeType === 9) container.appendChild(new DocumentType(document, token.value)); }
    else if (token.type === 'start') {
      const name = token.name;
      if (CLOSES_P.has(name)) closeTo(openIndex(['p'], ['table', 'td', 'th', 'button', 'li', 'blockquote', 'div', 'section', 'article']));
      if (name === 'li') closeTo(openIndex(['li'], ['ul', 'ol', 'menu']));
      if (name === 'dt' || name === 'dd') closeTo(openIndex(['dt', 'dd'], ['dl']));
      if (name === 'tr') closeTo(openIndex(['tr'], ['table', 'thead', 'tbody', 'tfoot']));
      if (name === 'td' || name === 'th') closeTo(openIndex(['td', 'th'], ['tr', 'table']));
      if (['thead', 'tbody', 'tfoot'].includes(name)) closeTo(openIndex(['thead', 'tbody', 'tfoot'], ['table']));
      if (name === 'option') closeTo(openIndex(['option'], ['select', 'datalist']));
      if ((name === 'html' || name === 'head' || name === 'body') && contextTag) continue;
      if (name === 'body' || name === 'head') {
        // A second <head>/<body> (or one after content) merges into the existing element, as browsers do.
        const existing = stack.find(node => node.localName === name);
        if (existing) { for (const [key, value] of token.attributes) if (!existing.hasAttribute(key)) existing.setAttribute(key, value); continue; }
        if (name === 'body') closeTo(openIndex(['head']));
      }
      if (name === 'html' && stack.some(node => node.localName === 'html')) continue;
      if (name === 'tr' && current().localName === 'table') { const body = document.createElement('tbody'); current().appendChild(body); stack.push(body); }
      const element = document.createElement(name);
      for (const [key, value] of token.attributes) element.attributes.push(new Attr(key, value));
      current().appendChild(element);
      if (!VOID.has(name) && !token.selfClosing) stack.push(element);
    } else if (token.type === 'end') {
      if (token.name === 'br') { current().appendChild(document.createElement('br')); continue; }
      const index = openIndex([token.name]);
      if (index > 0) closeTo(index);
    }
  }
}

function parseFragment(html, document, contextTag = 'div') {
  const holder = document.createElement('template');
  build(html, document, holder, contextTag);
  return [...holder.childNodes];
}

// Puts head-level nodes in <head> and everything else in <body>, creating <html>, <head> and <body> when the markup
// leaves them out, so every document has the shape scripts expect.
function normalizeDocument(document) {
  let html = document.childNodes.find(node => node.nodeType === 1 && node.localName === 'html');
  const strays = document.childNodes.filter(node => node !== html && node.nodeType !== 10 && !(node.nodeType === 3 && !node.data.trim()));
  if (!html) { html = document.createElement('html'); document.appendChild(html); }
  for (const node of document.childNodes.filter(node => node.nodeType === 3)) document.removeChild(node);
  let head = html.children.find(node => node.localName === 'head');
  let body = html.children.find(node => node.localName === 'body');
  if (!head) { head = document.createElement('head'); html.insertBefore(head, html.firstChild); }
  if (!body) { body = document.createElement('body'); html.appendChild(body); }
  let inBody = body.childNodes.length > 0;
  for (const node of [...strays, ...html.childNodes.filter(node => node !== head && node !== body)]) {
    if (node.nodeType === 3 && !node.data.trim() && !inBody) { node.remove(); continue; }
    if (!inBody && node.nodeType === 1 && HEAD_TAGS.has(node.localName)) { head.appendChild(node); continue; }
    if (node.nodeType === 8 && !inBody) { head.appendChild(node); continue; }
    inBody = true;
    body.appendChild(node);
  }
  if (html.lastChild !== body) html.appendChild(body);
}

export function parseHTML(html, { url = 'https://example.com/' } = {}) {
  const document = new Document(url);
  build(String(html), document, document);
  normalizeDocument(document);
  return document;
}

// ---------------------------------------------------------------------------------------------------------------
// Selectors: compound selectors (tag, *, #id, .class, [attr], [attr=v], [attr~=v], [attr|=v], [attr^=v], [attr$=v],
// [attr*=v], with an optional " i" flag) joined by descendant or child combinators, in comma-separated lists.

const selectorCache = new Map();

function parseSelector(source) {
  const text = String(source).trim();
  if (selectorCache.has(text)) return selectorCache.get(text);
  const list = [];
  let complex = [], compound = null, combinator = ' ', i = 0;
  const fail = () => { throw new SyntaxError(`fake-dom does not support the selector "${source}"`); };
  const startCompound = () => { if (!compound) { compound = { tag: '*', ids: [], classes: [], attributes: [], combinator }; complex.push(compound); combinator = ' '; } return compound; };
  const name = () => { const m = /^(?:\\.|[\w-])+/.exec(text.slice(i)); if (!m) fail(); i += m[0].length; return m[0].replace(/\\(.)/g, '$1'); };
  while (i < text.length) {
    const c = text[i];
    if (c === ',') { if (!complex.length) fail(); list.push(complex); complex = []; compound = null; combinator = ' '; i++; continue; }
    if (/\s/.test(c) || c === '>') {
      while (/\s/.test(text[i] || '')) i++;
      if (text[i] === '>') { combinator = '>'; i++; while (/\s/.test(text[i] || '')) i++; }
      else if (text[i] !== ',' && i < text.length) combinator = compound ? ' ' : combinator;
      compound = null;
      continue;
    }
    if (c === '*') { startCompound().tag = '*'; i++; continue; }
    if (c === '#') { i++; startCompound().ids.push(name()); continue; }
    if (c === '.') { i++; startCompound().classes.push(name()); continue; }
    if (c === '[') {
      const m = /^\[\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*(i)?\s*)?\]/i.exec(text.slice(i));
      if (!m) fail();
      startCompound().attributes.push({ name: m[1].toLowerCase(), operator: m[2] || '', value: m[3] ?? m[4] ?? m[5] ?? '', insensitive: !!m[6] });
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) { if (compound) fail(); startCompound().tag = name().toLowerCase(); continue; }
    fail();
  }
  if (!complex.length) fail();
  list.push(complex);
  selectorCache.set(text, list);
  return list;
}

function matchAttribute(element, { name, operator, value, insensitive }) {
  let actual = element.getAttribute(name);
  if (actual === null) return false;
  if (!operator) return true;
  if (insensitive) { actual = actual.toLowerCase(); value = value.toLowerCase(); }
  if (operator === '=') return actual === value;
  if (operator === '~=') return actual.split(/\s+/).includes(value);
  if (operator === '|=') return actual === value || actual.startsWith(value + '-');
  if (operator === '^=') return !!value && actual.startsWith(value);
  if (operator === '$=') return !!value && actual.endsWith(value);
  if (operator === '*=') return !!value && actual.includes(value);
  return false;
}

function matchCompound(element, compound) {
  if (compound.tag !== '*' && element.localName !== compound.tag) return false;
  if (compound.ids.some(id => element.id !== id)) return false;
  if (compound.classes.length) { const classes = element.className.split(/\s+/); if (compound.classes.some(name => !classes.includes(name))) return false; }
  return compound.attributes.every(attribute => matchAttribute(element, attribute));
}

function matchComplex(element, complex, index = complex.length - 1) {
  if (!matchCompound(element, complex[index])) return false;
  if (index === 0) return true;
  const combinator = complex[index].combinator;
  for (let parent = element.parentNode; parent && parent.nodeType === 1; parent = parent.parentNode) {
    if (matchComplex(parent, complex, index - 1)) return true;
    if (combinator === '>') return false;
  }
  return false;
}

function select(root, selector, first = false) {
  const list = parseSelector(selector), out = [];
  for (const element of descendants(root, element => list.some(complex => matchComplex(element, complex)))) {
    out.push(element);
    if (first) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Window

function locationOf(url) {
  const parsed = new URL(url);
  return { href: parsed.href, origin: parsed.origin, protocol: parsed.protocol, host: parsed.host, hostname: parsed.hostname, port: parsed.port,
    pathname: parsed.pathname, search: parsed.search, hash: parsed.hash, toString: () => parsed.href };
}

/** Computed style from inline style, the `hidden` attribute and tag defaults only (there is no stylesheet cascade). */
export function computedStyle(element) {
  const inline = element.style;
  let display = inline.display || (HIDDEN_DISPLAY.has(element.localName) ? 'none' : BLOCK_DISPLAY.has(element.localName) ? 'block'
    : element.localName === 'li' ? 'list-item' : element.localName === 'table' ? 'table' : 'inline');
  if (element.hasAttribute('hidden') && !inline.display) display = 'none';
  return { display, visibility: inline.visibility || 'visible', whiteSpace: inline.whiteSpace || (element.localName === 'pre' ? 'pre' : 'normal'),
    getPropertyValue: name => ({ display, visibility: inline.visibility || 'visible' })[name] || inline.getPropertyValue(name) };
}

/** { window, document } for `html` at `url`; `window` carries location, getComputedStyle and URL for vm contexts. */
export function createWindow(html, { url = 'https://example.com/' } = {}) {
  const document = parseHTML(html, { url });
  const window = { document, location: locationOf(url), getComputedStyle: computedStyle, URL, Node, navigator: { language: 'en-US' } };
  window.window = window;
  document.defaultView = window;
  return { window, document };
}
