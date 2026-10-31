// Small XML parser for document imports. Element names keep their prefixes ("w:p"), attributes keep theirs
// ("r:id"), text is entity-decoded. Tolerant of what Office, LibreOffice and EPUB tools write; not a validator.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'', nbsp: '\u00a0' };
export const decodeXml = value => String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});

/** parseXml(source) -> { name: '#document', attrs: {}, children: [element | { text }] } */
export function parseXml(source) {
  const xml = String(source ?? '');
  const root = { name: '#document', attrs: {}, children: [] };
  const stack = [root];
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0, m;
  const text = value => { if (value) stack.at(-1).children.push({ text: decodeXml(value) }); };
  while ((m = tokens.exec(xml))) {
    text(xml.slice(last, m.index));
    last = tokens.lastIndex;
    if (m[1] !== undefined) { stack.at(-1).children.push({ text: m[1] }); continue; }
    if (m[2]) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === m[2]) { stack.length = i; break; }
      continue;
    }
    if (!m[3]) continue;
    const attrs = {};
    for (const a of (m[4] || '').matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decodeXml(a[2] ?? a[3] ?? '');
    const element = { name: m[3], attrs, children: [] };
    stack.at(-1).children.push(element);
    if (!m[5]) stack.push(element);
  }
  text(xml.slice(last));
  return root;
}

const local = name => String(name).replace(/^[^:]*:/, '');
/** Matches a prefixed name ("w:p") exactly, or a bare local name ("p") against any prefix. */
const named = (element, name) => !!element?.name && (element.name === name || (!name.includes(':') && local(element.name) === name));
export const elements = element => (element?.children || []).filter(child => child.name);
export const children = (element, name) => elements(element).filter(child => named(child, name));
export const child = (element, name) => elements(element).find(child => named(child, name)) || null;
export function descendants(element, name, out = []) {
  for (const node of elements(element)) { if (named(node, name)) out.push(node); descendants(node, name, out); }
  return out;
}
export const first = (element, name) => descendants(element, name)[0] || null;
/** All text below an element, in document order. */
export function textOf(element) {
  if (!element) return '';
  if (typeof element.text === 'string') return element.text;
  return (element.children || []).map(textOf).join('');
}
/** Attribute by exact name, or by local name when the prefix differs between producers. */
export function attr(element, name) {
  if (!element?.attrs) return null;
  if (name in element.attrs) return element.attrs[name];
  const want = local(name);
  for (const [key, value] of Object.entries(element.attrs)) if (local(key) === want) return value;
  return null;
}
export { local as localName };
