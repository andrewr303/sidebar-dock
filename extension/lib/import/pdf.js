// PDF text extraction for imports, without dependencies. Finds objects by scanning (robust to broken cross-reference
// tables), expands object streams, decodes Flate/ASCIIHex/ASCII85 content, maps character codes through ToUnicode
// CMaps or simple-font encodings, and interprets text operators with enough geometry to rebuild lines, paragraphs,
// headings and list items. Scanned pages (no text layer) and encrypted files report `needsAi` instead of guessing.
import { ImportError, inflate } from './zip.js';
import { cp1252 } from './blocks.js';

export const MAX_PDF_PAGES = 2000;
const MAX_CHARS = 1_500_000;

export function latin1(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return out;
}
const bytesOf = str => { const out = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 255; return out; };

/* ---------------------------------------------------------------- object syntax */

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const isWs = c => WS.has(c);
const isRegular = c => !WS.has(c) && !DELIM.has(c) && !Number.isNaN(c);

function skipSpace(s, i) {
  for (;;) {
    const c = s.charCodeAt(i);
    if (isWs(c)) { i++; continue; }
    if (c === 37) { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    return i;
  }
}
function literal(s, i) {
  let depth = 1, out = '';
  for (i++; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      const next = s[++i];
      if (next === 'n') out += '\n'; else if (next === 'r') out += '\r'; else if (next === 't') out += '\t';
      else if (next === 'b') out += '\b'; else if (next === 'f') out += '\f';
      else if (next === '\r') { if (s[i + 1] === '\n') i++; }
      else if (next === '\n') { /* line continuation */ }
      else if (next >= '0' && next <= '7') {
        let digits = next;
        while (digits.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') digits += s[++i];
        out += String.fromCharCode(parseInt(digits, 8) & 255);
      } else if (next !== undefined) out += next;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return [{ s: out }, i + 1];
    out += ch;
  }
  return [{ s: out }, i];
}
function hexString(s, i) {
  const end = s.indexOf('>', i);
  const hex = s.slice(i + 1, end < 0 ? s.length : end).replace(/[^0-9a-f]/gi, '');
  let out = '';
  for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt((hex.slice(k, k + 2) + '0').slice(0, 2), 16));
  return [{ s: out }, end < 0 ? s.length : end + 1];
}
function nameToken(s, i) {
  let j = i + 1;
  while (j < s.length && isRegular(s.charCodeAt(j))) j++;
  return ['/' + s.slice(i + 1, j).replace(/#([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), j];
}
function wordToken(s, i) {
  let j = i;
  while (j < s.length && isRegular(s.charCodeAt(j))) j++;
  return [s.slice(i, j), j];
}
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/** Parses one value at `i`: numbers, names ('/Name'), strings ({ s }), arrays, dicts (Map), refs ({ ref }), operators ({ op }). */
export function parseValue(s, i, { refs = true } = {}) {
  i = skipSpace(s, i);
  const c = s[i];
  if (c === undefined) return [undefined, i];
  if (c === '/') return nameToken(s, i);
  if (c === '(') return literal(s, i);
  if (c === '<') {
    if (s[i + 1] !== '<') return hexString(s, i);
    const dict = new Map();
    i += 2;
    for (;;) {
      i = skipSpace(s, i);
      if (i >= s.length) return [dict, i];
      if (s[i] === '>' && s[i + 1] === '>') return [dict, i + 2];
      const [key, after] = parseValue(s, i, { refs });
      if (typeof key !== 'string' || key[0] !== '/') { i = after > i ? after : i + 1; continue; }
      const [value, next] = parseValue(s, after, { refs });
      dict.set(key.slice(1), value);
      i = next;
    }
  }
  if (c === '[') {
    const list = [];
    i++;
    for (;;) {
      i = skipSpace(s, i);
      if (i >= s.length) return [list, i];
      if (s[i] === ']') return [list, i + 1];
      const [value, next] = parseValue(s, i, { refs });
      if (next <= i) { i++; continue; }
      list.push(value);
      i = next;
    }
  }
  if (c === ')' || c === '>' || c === ']' || c === '{' || c === '}') return [{ op: c }, i + 1];
  const [word, next] = wordToken(s, i);
  if (!word) return [{ op: c }, i + 1];
  if (NUMBER.test(word)) {
    const value = Number(word);
    if (refs && /^\d+$/.test(word)) {
      const m = /\s+(\d+)\s+R(?![^\s\[\]<>()\/%])/y;
      m.lastIndex = next;
      const hit = m.exec(s);
      if (hit) return [{ ref: value, gen: Number(hit[1]) }, m.lastIndex];
    }
    return [value, next];
  }
  if (word === 'true') return [true, next];
  if (word === 'false') return [false, next];
  if (word === 'null') return [null, next];
  return [{ op: word }, next];
}

/* ---------------------------------------------------------------- document structure */

class PdfDocument {
  constructor(bytes) {
    this.bytes = bytes;
    this.src = latin1(bytes);
    this.objects = new Map();
    this.decoded = new Map();
    this.fonts = new Map();
  }
  scan() {
    const { src } = this;
    const header = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = header.exec(src))) {
      const before = m.index ? src.charCodeAt(m.index - 1) : 10;
      if (!isWs(before) && before !== 62 && before !== 93 && before !== 41) continue;
      const num = Number(m[1]);
      let value, at;
      try { [value, at] = parseValue(src, header.lastIndex); } catch { continue; }
      const entry = { num, offset: m.index, value, stream: null };
      at = skipSpace(src, at);
      if (value instanceof Map && src.startsWith('stream', at)) {
        let start = at + 6;
        if (src[start] === '\r') start++;
        if (src[start] === '\n') start++;
        const length = value.get('Length');
        let end = -1;
        if (typeof length === 'number' && length >= 0 && start + length <= src.length && /^\s*endstream/.test(src.slice(start + length, start + length + 40))) end = start + length;
        if (end < 0) {
          const found = src.indexOf('endstream', start);
          end = found < 0 ? src.length : found;
          if (src[end - 1] === '\n') end--;
          if (src[end - 1] === '\r') end--;
        }
        entry.stream = { start, end };
        header.lastIndex = Math.max(header.lastIndex, end);
      }
      this.objects.set(num, entry);
    }
  }
  async expandObjectStreams() {
    for (const entry of [...this.objects.values()]) {
      if (!(entry.value instanceof Map) || entry.value.get('Type') !== '/ObjStm' || !entry.stream) continue;
      let data;
      try { data = latin1(await this.streamBytes(entry)); } catch { continue; }
      const count = this.resolve(entry.value.get('N')), first = this.resolve(entry.value.get('First'));
      if (!Number.isInteger(count) || !Number.isInteger(first)) continue;
      const pairs = data.slice(0, first).trim().split(/\s+/).map(Number);
      for (let k = 0; k + 1 < pairs.length && k / 2 < count; k += 2) {
        const num = pairs[k], at = first + pairs[k + 1];
        const known = this.objects.get(num);
        if (known && known.offset > entry.offset) continue;
        try { this.objects.set(num, { num, offset: entry.offset, value: parseValue(data, at)[0], stream: null }); } catch { /* skip a damaged member */ }
      }
    }
  }
  resolve(value, depth = 0) {
    while (value && typeof value === 'object' && 'ref' in value && depth++ < 32) value = this.objects.get(value.ref)?.value;
    return value;
  }
  entryOf(value) { return value && typeof value === 'object' && 'ref' in value ? this.objects.get(value.ref) || null : null; }
  get(dict, key) { return dict instanceof Map ? this.resolve(dict.get(key)) : undefined; }
  async streamBytes(entry) {
    if (!entry?.stream) return new Uint8Array(0);
    if (this.decoded.has(entry)) return this.decoded.get(entry);
    let data = this.bytes.subarray(entry.stream.start, entry.stream.end);
    const filter = this.get(entry.value, 'Filter');
    const filters = (Array.isArray(filter) ? filter : filter ? [filter] : []).map(f => this.resolve(f));
    const params = this.get(entry.value, 'DecodeParms');
    for (const [k, name] of filters.entries()) {
      const param = this.resolve(Array.isArray(params) ? params[k] : params);
      if (name === '/FlateDecode' || name === '/Fl') {
        try { data = await inflate(data, 'deflate', 256 * 1024 * 1024); } catch { data = await inflate(data, 'deflate-raw', 256 * 1024 * 1024); }
        const predictor = this.get(param, 'Predictor');
        if (predictor >= 10) data = unpredictPng(data, this.get(param, 'Columns') || 1, this.get(param, 'Colors') || 1, this.get(param, 'BitsPerComponent') || 8);
      } else if (name === '/ASCIIHexDecode' || name === '/AHx') data = bytesOf(hexString('<' + latin1(data), 0)[0].s);
      else if (name === '/ASCII85Decode' || name === '/A85') data = ascii85(data);
      else throw new ImportError('This PDF uses an encoding that cannot be read here.', 'unsupported');
    }
    this.decoded.set(entry, data);
    return data;
  }
  trailerRoot() {
    const refs = [...this.src.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)];
    for (let k = refs.length - 1; k >= 0; k--) { const root = this.objects.get(Number(refs[k][1]))?.value; if (root instanceof Map) return root; }
    for (const entry of this.objects.values()) if (entry.value instanceof Map && entry.value.get('Type') === '/Catalog') return entry.value;
    return null;
  }
  encrypted() { return /\/Encrypt\s+(?:\d+\s+\d+\s+R|<<)/.test(this.src.slice(-262144)) || /trailer[\s\S]{0,2000}?\/Encrypt\b/.test(this.src); }
  pages() {
    const out = [];
    const seen = new Set();
    const walk = (node, inherited, depth) => {
      const dict = this.resolve(node);
      if (!(dict instanceof Map) || seen.has(dict) || depth > 64 || out.length >= MAX_PDF_PAGES) return;
      seen.add(dict);
      const resources = dict.has('Resources') ? this.get(dict, 'Resources') : inherited;
      const kids = this.get(dict, 'Kids');
      if (dict.get('Type') === '/Page' || (!Array.isArray(kids) && dict.has('Contents'))) { out.push({ dict, resources }); return; }
      if (Array.isArray(kids)) for (const kid of kids) walk(kid, resources, depth + 1);
    };
    const root = this.trailerRoot();
    if (root) walk(root.get('Pages'), null, 0);
    if (!out.length) {
      for (const entry of [...this.objects.values()].sort((a, b) => a.offset - b.offset)) {
        if (entry.value instanceof Map && entry.value.get('Type') === '/Page') out.push({ dict: entry.value, resources: this.get(entry.value, 'Resources') });
        if (out.length >= MAX_PDF_PAGES) break;
      }
    }
    return out;
  }
}

function unpredictPng(data, columns, colors, bits) {
  const bpp = Math.max(1, Math.ceil(colors * bits / 8)), row = Math.ceil(columns * colors * bits / 8);
  const rows = Math.floor(data.length / (row + 1)), out = new Uint8Array(rows * row);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (row + 1)], src = r * (row + 1) + 1, dst = r * row;
    for (let k = 0; k < row; k++) {
      const left = k >= bpp ? out[dst + k - bpp] : 0, up = r ? out[dst - row + k] : 0, corner = r && k >= bpp ? out[dst - row + k - bpp] : 0;
      let value = data[src + k];
      if (type === 1) value += left;
      else if (type === 2) value += up;
      else if (type === 3) value += (left + up) >> 1;
      else if (type === 4) { const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner); value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner; }
      out[dst + k] = value & 255;
    }
  }
  return out;
}
function ascii85(data) {
  const text = latin1(data).replace(/\s+/g, '').replace(/^<~/, '').replace(/~>.*$/, '');
  const out = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === 'z') { out.push(0, 0, 0, 0); i++; continue; }
    const chunk = text.slice(i, i + 5);
    i += 5;
    const padded = chunk.padEnd(5, 'u');
    let value = 0;
    for (const ch of padded) value = value * 85 + (ch.charCodeAt(0) - 33);
    const group = [value >>> 24 & 255, value >>> 16 & 255, value >>> 8 & 255, value & 255];
    out.push(...group.slice(0, chunk.length - 1));
  }
  return Uint8Array.from(out);
}

/* ---------------------------------------------------------------- fonts */

const ACCENTS = { acute: '\u0301', grave: '\u0300', circumflex: '\u0302', dieresis: '\u0308', tilde: '\u0303', ring: '\u030a', cedilla: '\u0327', caron: '\u030c', macron: '\u0304', breve: '\u0306', ogonek: '\u0328', dotaccent: '\u0307', hungarumlaut: '\u030b' };
const GLYPHS = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: '\'', parenleft: '(', parenright: ')',
  asterisk: '*', plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[',
  backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  quoteleft: '‘', quoteright: '’', quotedblleft: '“', quotedblright: '”', quotesinglbase: '‚', quotedblbase: '„', bullet: '•', endash: '–', emdash: '—',
  ellipsis: '…', dagger: '†', daggerdbl: '‡', trademark: '™', copyright: '©', registered: '®', degree: '°', minus: '−', multiply: '×', divide: '÷',
  section: '§', paragraph: '¶', periodcentered: '·', nbspace: ' ', uni00A0: ' ', Euro: '€', sterling: '£', yen: '¥', cent: '¢', currency: '¤',
  guillemotleft: '«', guillemotright: '»', guilsinglleft: '‹', guilsinglright: '›', exclamdown: '¡', questiondown: '¿', germandbls: 'ß', ae: 'æ', AE: 'Æ',
  oe: 'œ', OE: 'Œ', oslash: 'ø', Oslash: 'Ø', eth: 'ð', Eth: 'Ð', thorn: 'þ', Thorn: 'Þ', dotlessi: 'ı', lslash: 'ł', Lslash: 'Ł', fi: 'fi', fl: 'fl',
  ff: 'ff', ffi: 'ffi', ffl: 'ffl', florin: 'ƒ', perthousand: '‰', plusminus: '±', mu: 'µ', onehalf: '½', onequarter: '¼', threequarters: '¾',
  ordfeminine: 'ª', ordmasculine: 'º', logicalnot: '¬', brokenbar: '¦', dieresis: '¨', acute: '´', cedilla: '¸', macron: '¯', circumflex: 'ˆ', tilde: '˜',
  arrowright: '→', arrowleft: '←', arrowup: '↑', arrowdown: '↓', checkmark: '✓', lozenge: '◊', notequal: '≠', lessequal: '≤', greaterequal: '≥',
  infinity: '∞', summation: '∑', product: '∏', radical: '√', integral: '∫', partialdiff: '∂', Delta: 'Δ', Omega: 'Ω', pi: 'π', approxequal: '≈',
  fraction: '⁄', twosuperior: '²', threesuperior: '³', onesuperior: '¹',
};
export function glyphToUnicode(name) {
  const clean = String(name || '').replace(/^\//, '');
  if (!clean) return '';
  if (GLYPHS[clean] !== undefined) return GLYPHS[clean];
  let m = /^uni((?:[0-9A-F]{4})+)$/i.exec(clean);
  if (m) return m[1].match(/.{4}/g).map(h => String.fromCharCode(parseInt(h, 16))).join('');
  m = /^u([0-9A-F]{4,6})$/i.exec(clean);
  if (m) { const code = parseInt(m[1], 16); return code < 0x110000 ? String.fromCodePoint(code) : ''; }
  if (clean.includes('.')) return glyphToUnicode(clean.split('.')[0]);
  if (clean.includes('_')) return clean.split('_').map(glyphToUnicode).join('');
  if (/^[A-Za-z]$/.test(clean)) return clean;
  for (const [suffix, mark] of Object.entries(ACCENTS)) {
    if (clean.length > suffix.length && clean.endsWith(suffix) && /^[A-Za-z]$/.test(clean.slice(0, -suffix.length))) return (clean.slice(0, -suffix.length) + mark).normalize('NFC');
  }
  return '';
}

const MAC_ROMAN = (() => { try { return new TextDecoder('macintosh'); } catch { return null; } })();
const STANDARD = { 0x27: '’', 0x60: '‘', 0xa1: '¡', 0xa2: '¢', 0xa3: '£', 0xa4: '⁄', 0xa5: '¥', 0xa6: 'ƒ', 0xa7: '§', 0xa8: '¤', 0xa9: '\'', 0xaa: '“', 0xab: '«', 0xac: '‹', 0xad: '›', 0xae: 'fi', 0xaf: 'fl', 0xb1: '–', 0xb2: '†', 0xb3: '‡', 0xb4: '·', 0xb6: '¶', 0xb7: '•', 0xb8: '‚', 0xb9: '„', 0xba: '”', 0xbb: '»', 0xbc: '…', 0xbd: '‰', 0xbf: '¿', 0xd0: '—', 0xe1: 'Æ', 0xe8: 'Ł', 0xe9: 'Ø', 0xea: 'Œ', 0xf1: 'æ', 0xf5: 'ı', 0xf8: 'ł', 0xf9: 'ø', 0xfa: 'œ', 0xfb: 'ß' };
function baseEncoding(name) {
  const table = new Array(256);
  for (let code = 0; code < 256; code++) {
    if (name === '/MacRomanEncoding' && MAC_ROMAN) table[code] = MAC_ROMAN.decode(Uint8Array.of(code));
    else if (name === '/StandardEncoding') table[code] = STANDARD[code] ?? (code >= 32 && code < 127 ? String.fromCharCode(code) : '');
    // Unused WinAnsi codes above 0x40 show the bullet glyph (PDF reference, WinAnsiEncoding note).
    else table[code] = [0x7f, 0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(code) ? '\u2022' : cp1252(Uint8Array.of(code));
  }
  return table;
}

/** Parses a ToUnicode CMap: { ranges: [{ length, lo, hi }], map: Map<code, string> }. Codes are byte strings. */
export function parseCMap(text) {
  const map = new Map(), ranges = [];
  const utf16 = hex => { const units = (hex.match(/.{1,4}/g) || []).map(h => parseInt(h.padEnd(4, '0'), 16)); return String.fromCharCode(...units); };
  const bytes = hex => String.fromCharCode(...(hex.match(/../g) || []).map(h => parseInt(h, 16)));
  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) ranges.push({ length: m[1].length / 2, lo: bytes(m[1]), hi: bytes(m[2]) });
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) map.set(bytes(m[1]), utf16(m[2]));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(?:<([0-9a-f]*)>|\[([^\]]*)\])/gi)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), width = m[1].length;
      if (!(hi >= lo) || hi - lo > 65535) continue;
      const list = m[4] !== undefined ? [...m[4].matchAll(/<([0-9a-f]*)>/gi)].map(x => x[1]) : null;
      for (let code = lo; code <= hi; code++) {
        const key = bytes(code.toString(16).padStart(width, '0'));
        if (list) { if (list[code - lo] !== undefined) map.set(key, utf16(list[code - lo])); continue; }
        const start = utf16(m[3] || '');
        if (!start) continue;
        map.set(key, start.slice(0, -1) + String.fromCharCode(start.charCodeAt(start.length - 1) + (code - lo)));
      }
    }
  }
  return { ranges, map };
}

const BOLD = /bold|black|heavy|semibold|demi/i, ITALIC = /italic|oblique/i;
const FALLBACK_FONT = { twoByte: false, bold: false, italic: false, codes: s => [...s].map(ch => ch), text: code => code, width: () => 500, spaceCode: code => code === ' ', bad: () => false };

async function loadFont(pdf, ref) {
  const key = ref && typeof ref === 'object' && 'ref' in ref ? ref.ref : ref;
  if (pdf.fonts.has(key) && key !== undefined) return pdf.fonts.get(key);
  const dict = pdf.resolve(ref);
  if (!(dict instanceof Map)) return FALLBACK_FONT;
  const subtype = dict.get('Subtype');
  const baseFont = String(pdf.get(dict, 'BaseFont') || '');
  let cmap = null;
  const unicodeEntry = pdf.entryOf(dict.get('ToUnicode'));
  if (unicodeEntry?.stream) { try { cmap = parseCMap(latin1(await pdf.streamBytes(unicodeEntry))); } catch { cmap = null; } }
  let font;
  if (subtype === '/Type0') {
    const encoding = pdf.get(dict, 'Encoding');
    const ucs2 = typeof encoding === 'string' && /UCS2|UTF16/.test(encoding);
    const descendant = pdf.resolve((pdf.get(dict, 'DescendantFonts') || [])[0]);
    const widths = new Map(), dw = pdf.get(descendant, 'DW') ?? 1000;
    const w = pdf.get(descendant, 'W');
    if (Array.isArray(w)) {
      for (let k = 0; k < w.length;) {
        const first = pdf.resolve(w[k]), next = pdf.resolve(w[k + 1]);
        if (Array.isArray(next)) { next.forEach((value, n) => widths.set(first + n, pdf.resolve(value))); k += 2; }
        else { const width = pdf.resolve(w[k + 2]); for (let c = first; c <= next && c - first < 65536; c++) widths.set(c, width); k += 3; }
      }
    }
    const ranges = cmap?.ranges?.length ? cmap.ranges : [{ length: 2, lo: '\0\0', hi: '\xff\xff' }];
    font = {
      twoByte: true, bold: BOLD.test(baseFont), italic: ITALIC.test(baseFont),
      codes: s => splitCodes(s, ranges),
      text: code => cmap?.map.get(code) ?? (ucs2 ? code.length === 2 ? String.fromCharCode(code.charCodeAt(0) << 8 | code.charCodeAt(1)) : '' : '\ufffd'),
      width: code => widths.get(codeNumber(code)) ?? dw,
      spaceCode: () => false,
      bad: code => !cmap?.map.has(code) && !ucs2,
    };
  } else {
    const encoding = pdf.get(dict, 'Encoding');
    const base = encoding instanceof Map ? pdf.get(encoding, 'BaseEncoding') : encoding;
    const table = baseEncoding(typeof base === 'string' ? base : subtype === '/Type1' && !encoding ? '/StandardEncoding' : '/WinAnsiEncoding');
    const differences = encoding instanceof Map ? pdf.get(encoding, 'Differences') : null;
    const named = new Set();
    if (Array.isArray(differences)) {
      let code = 0;
      for (const entry of differences.map(value => pdf.resolve(value))) {
        if (typeof entry === 'number') { code = entry; continue; }
        if (typeof entry === 'string' && code < 256) { table[code] = glyphToUnicode(entry); named.add(code); code++; }
      }
    }
    const first = pdf.get(dict, 'FirstChar') ?? 0;
    const widths = (pdf.get(dict, 'Widths') || []).map(value => pdf.resolve(value));
    const missing = pdf.get(pdf.get(dict, 'FontDescriptor'), 'MissingWidth') || 0;
    const matrix = subtype === '/Type3' ? pdf.get(dict, 'FontMatrix') : null;
    const scale = Array.isArray(matrix) ? Math.abs(Number(matrix[0]) || 0.001) * 1000 : 1;
    font = {
      twoByte: false, bold: BOLD.test(baseFont), italic: ITALIC.test(baseFont),
      codes: s => cmap?.ranges?.some(range => range.length > 1) ? splitCodes(s, cmap.ranges) : [...s],
      text: code => cmap?.map.get(code) ?? table[code.charCodeAt(0)] ?? '',
      width: code => { const value = widths[code.charCodeAt(0) - first]; return (typeof value === 'number' ? value : missing || 500) * scale; },
      spaceCode: code => code === ' ',
      bad: code => !cmap?.map.has(code) && !table[code.charCodeAt(0)] && !named.has(code.charCodeAt(0)),
    };
  }
  if (key !== undefined) pdf.fonts.set(key, font);
  return font;
}
const codeNumber = code => { let n = 0; for (const ch of code) n = n * 256 + ch.charCodeAt(0); return n; };
function splitCodes(s, ranges) {
  const sorted = [...ranges].sort((a, b) => a.length - b.length);
  const out = [];
  for (let i = 0; i < s.length;) {
    const hit = sorted.find(range => { const code = s.slice(i, i + range.length); return code.length === range.length && code >= range.lo && code <= range.hi; });
    const length = hit?.length || sorted.at(-1)?.length || 1;
    out.push(s.slice(i, i + length));
    i += length;
  }
  return out;
}

/* ---------------------------------------------------------------- content streams */

const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const ID = [1, 0, 0, 1, 0, 0];
const LIGATURES = { '\ufb00': 'ff', '\ufb01': 'fi', '\ufb02': 'fl', '\ufb03': 'ffi', '\ufb04': 'ffl', '\ufb05': 'st', '\ufb06': 'st' };

async function readContent(pdf, source, resources, ctm0, runs, stats, depth = 0) {
  if (depth > 8) return;
  const fontsDict = pdf.get(resources, 'Font');
  const xobjects = pdf.get(resources, 'XObject');
  let ctm = ctm0, stack = [], tm = ID, tlm = ID;
  let font = FALLBACK_FONT, fontSize = 0, leading = 0, charSpace = 0, wordSpace = 0, scale = 1, rise = 0;
  const operands = [];
  const show = str => {
    const m0 = mul(tm, ctm);
    const size = Math.abs(fontSize) * Math.hypot(m0[2], m0[3]) || Math.abs(fontSize) || 1;
    const trm = mul([fontSize * scale, 0, 0, fontSize, 0, rise], m0);
    let text = '', advance = 0;
    for (const code of font.codes(str.s)) {
      const value = font.text(code);
      stats.chars++;
      if (font.bad(code)) stats.bad++;
      text += value;
      advance += ((font.width(code) / 1000) * fontSize + charSpace + (font.spaceCode(code) ? wordSpace : 0)) * scale;
    }
    tm = mul([1, 0, 0, 1, advance, 0], tm);
    const end = mul(tm, ctm);
    if (text) runs.push({ text: text.replace(/[\ufb00-\ufb06]/g, ch => LIGATURES[ch]), x: trm[4], y: trm[5], endX: end[4], size, bold: font.bold, italic: font.italic, vertical: Math.abs(m0[1]) > Math.abs(m0[0]) });
  };
  const nextLine = () => { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; };
  const s = source;
  let i = 0;
  while (i < s.length) {
    let value, next;
    try { [value, next] = parseValue(s, i, { refs: false }); } catch { break; }
    if (next <= i) { i++; continue; }
    i = next;
    if (value === undefined) break;
    if (!value || typeof value !== 'object' || !('op' in value)) { operands.push(value); if (operands.length > 64) operands.shift(); continue; }
    const op = value.op;
    const num = k => Number(operands[operands.length - k]) || 0;
    switch (op) {
      case 'q': stack.push({ ctm, font, fontSize, leading, charSpace, wordSpace, scale, rise }); if (stack.length > 64) stack.shift(); break;
      case 'Q': { const saved = stack.pop(); if (saved) ({ ctm, font, fontSize, leading, charSpace, wordSpace, scale, rise } = saved); else ctm = ctm0; break; }
      case 'cm': if (operands.length >= 6) ctm = mul(operands.slice(-6).map(Number), ctm); break;
      case 'BT': tm = tlm = ID; break;
      case 'Tf': {
        fontSize = num(1);
        const name = operands[operands.length - 2];
        font = typeof name === 'string' && fontsDict instanceof Map ? await loadFont(pdf, fontsDict.get(name.slice(1))) : FALLBACK_FONT;
        break;
      }
      case 'TL': leading = num(1); break;
      case 'Tc': charSpace = num(1); break;
      case 'Tw': wordSpace = num(1); break;
      case 'Tz': scale = num(1) / 100; break;
      case 'Ts': rise = num(1); break;
      case 'Td': tlm = mul([1, 0, 0, 1, num(2), num(1)], tlm); tm = tlm; break;
      case 'TD': leading = -num(1); tlm = mul([1, 0, 0, 1, num(2), num(1)], tlm); tm = tlm; break;
      case 'Tm': if (operands.length >= 6) { tlm = tm = operands.slice(-6).map(Number); } break;
      case 'T*': nextLine(); break;
      case 'Tj': if (operands.at(-1)?.s !== undefined) show(operands.at(-1)); break;
      case '\'': nextLine(); if (operands.at(-1)?.s !== undefined) show(operands.at(-1)); break;
      case '"': wordSpace = num(3); charSpace = num(2); nextLine(); if (operands.at(-1)?.s !== undefined) show(operands.at(-1)); break;
      case 'TJ': {
        const list = operands.at(-1);
        if (!Array.isArray(list)) break;
        for (const part of list) {
          if (part?.s !== undefined) show(part);
          else if (typeof part === 'number') {
            const shift = (-part / 1000) * fontSize * scale;
            tm = mul([1, 0, 0, 1, shift, 0], tm);
            // A wide negative kern stands in for a space (pdfTeX and many typesetters never draw space glyphs).
            if (part < -180 && runs.length) runs.push({ text: ' ', space: true });
          }
        }
        break;
      }
      case 'Do': {
        const name = operands.at(-1);
        const entry = typeof name === 'string' && xobjects instanceof Map ? pdf.entryOf(xobjects.get(name.slice(1))) : null;
        if (entry?.value instanceof Map && entry.value.get('Subtype') === '/Image') stats.images++;
        if (entry?.value instanceof Map && entry.value.get('Subtype') === '/Form' && entry.stream) {
          const matrix = pdf.get(entry.value, 'Matrix');
          const inner = latin1(await pdf.streamBytes(entry).catch(() => new Uint8Array(0)));
          await readContent(pdf, inner, pdf.get(entry.value, 'Resources') || resources, Array.isArray(matrix) && matrix.length === 6 ? mul(matrix.map(Number), ctm) : ctm, runs, stats, depth + 1);
        }
        break;
      }
      case 'BI': {
        stats.images++;
        const data = s.indexOf('ID', i);
        const end = data < 0 ? -1 : s.slice(data).search(/\sEI(?=[\s]|$)/);
        i = end < 0 ? s.length : data + end + 3;
        break;
      }
      default: break;
    }
    operands.length = 0;
  }
}

/* ---------------------------------------------------------------- layout */

function linesOf(runs) {
  const lines = [];
  let line = null, pendingSpace = false;
  const append = (text, run) => {
    const cell = line.cells.at(-1), last = cell.at(-1);
    if (last && last.bold === !!run.bold && last.italic === !!run.italic) last.text += text;
    else cell.push({ text, bold: !!run.bold, italic: !!run.italic });
  };
  for (const run of runs) {
    if (run.space) { pendingSpace = true; continue; }
    const text = run.text.replace(/[\u0000-\u0008\u000b-\u001f\u0080-\u009f]/g, '');
    if (!text) continue;
    const tolerance = Math.max(line?.size || 0, run.size) * 0.5;
    const same = line && run.vertical === line.vertical && Math.abs(run.y - line.y) <= tolerance && run.x > line.endX - Math.max(line.size, run.size) * 1.5;
    if (same) {
      if (text === line.lastText && Math.abs(run.x - line.lastX) < run.size * 0.3) continue;
      const gap = run.x - line.endX;
      // A wide gap separates table cells; a narrow one is a word space.
      if (gap > Math.max(line.size, run.size) * 1.6) line.cells.push([]);
      else if ((pendingSpace || gap > run.size * 0.16) && !/\s$/.test(line.cells.at(-1).at(-1)?.text || '') && !/^\s/.test(text)) append(' ', line.cells.at(-1).at(-1) || run);
      append(text, run);
      line.endX = Math.max(line.endX, run.endX);
      line.weight += text.length;
      line.sizeSum += run.size * text.length;
    } else {
      line = { cells: [[]], x: run.x, y: run.y, endX: run.endX, size: run.size, vertical: run.vertical, weight: text.length, sizeSum: run.size * text.length };
      append(text, run);
      lines.push(line);
    }
    line.lastText = text;
    line.lastX = run.x;
    line.size = line.sizeSum / Math.max(1, line.weight);
    pendingSpace = false;
  }
  return lines.map(l => {
    const cells = l.cells.map(trimParts).filter(cell => cell.length);
    const parts = trimParts(cells.flatMap((cell, k) => k ? [{ text: ' ', bold: false, italic: false }, ...cell] : cell));
    const visible = parts.filter(p => p.text.trim());
    return { text: textOfParts(parts), parts, cells: cells.length > 1 ? cells : null, x: l.x, y: l.y, size: l.size, bold: !!visible.length && visible.every(p => p.bold) };
  }).filter(l => l.text);
}
const textOfParts = parts => parts.map(p => p.text).join('');
function trimParts(parts) {
  const out = parts.map(p => ({ ...p, text: p.text.replace(/\s+/g, ' ') })).filter(p => p.text);
  while (out.length && !out[0].text.trim()) out.shift();
  while (out.length && !out.at(-1).text.trim()) out.pop();
  if (out.length) { out[0].text = out[0].text.replace(/^\s+/, ''); out.at(-1).text = out.at(-1).text.replace(/\s+$/, ''); }
  return out;
}
/** Drops the first `count` characters (a list marker) from inline parts. */
function sliceParts(parts, count) {
  const out = [];
  for (const part of parts) {
    if (count >= part.text.length) { count -= part.text.length; continue; }
    out.push({ ...part, text: part.text.slice(count) });
    count = 0;
  }
  return trimParts(out);
}

const PAGE_NUMBER = /^(?:page\s+)?[-–—]?\s*\d{1,4}\s*[-–—]?(?:\s*(?:of|\/)\s*\d{1,4})?$/i;
function dropRunningLines(pages) {
  const key = text => text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const counts = new Map();
  const edges = lines => [...lines.slice(0, 2), ...lines.slice(-2)];
  for (const lines of pages) for (const k of new Set(edges(lines).map(l => key(l.text)))) counts.set(k, (counts.get(k) || 0) + 1);
  const repeated = new Set([...counts].filter(([k, n]) => pages.length >= 3 && n >= Math.max(2, pages.length * 0.5) && k.length <= 120).map(([k]) => k));
  return pages.map(lines => {
    const edge = new Set(edges(lines));
    return lines.filter(l => !(edge.has(l) && (repeated.has(key(l.text)) || PAGE_NUMBER.test(l.text))));
  });
}

// List markers: common bullet glyphs, dashes, and private-use symbols (symbol fonts map their bullets there).
const BULLET = /^([•●▪◦‣∙○■□➢➤►▶✓✔\-–*·\ue000-\uf8ff])\s+(?=\S)/u;
const NUMBERED = /^(\d{1,3})[.)]\s+(?=\S)/;
const ENDS_SENTENCE = /[.!?:;"”’)\]]$/;
function joinParts(a, b) {
  const last = a.at(-1), head = b[0];
  if (last && head && /[A-Za-zÀ-ɏ]-$/.test(last.text) && /^[a-zß-ÿ]/.test(head.text)) last.text = last.text.slice(0, -1);
  else if (last) last.text += ' ';
  for (const part of b) {
    const tail = a.at(-1);
    if (tail && tail.bold === part.bold && tail.italic === part.italic) tail.text += part.text; else a.push({ ...part });
  }
  return a;
}
const quantile = (values, q) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : 0; };
const median = values => quantile(values, 0.5);

/**
 * Turns page lines into blocks: { type: 'h', level, parts } | { type: 'p', parts } | { type: 'li', ordered, start, level, parts }
 * | { type: 'table', rows: [[parts]] }. Parts are inline runs: { text, bold, italic }.
 */
export function layoutBlocks(pages) {
  const all = pages.flat();
  if (!all.length) return [];
  const bySize = new Map();
  for (const line of all) { const k = Math.round(line.size * 2) / 2; bySize.set(k, (bySize.get(k) || 0) + line.text.length); }
  const body = [...bySize].sort((a, b) => b[1] - a[1])[0][0];
  const gaps = [];
  for (const lines of pages) for (let k = 1; k < lines.length; k++) if (Math.abs(lines[k].size - body) < body * 0.1 && Math.abs(lines[k - 1].size - body) < body * 0.1) gaps.push(lines[k - 1].y - lines[k].y);
  // Line spacing is the common small gap; the median would land on paragraph gaps in documents of short paragraphs.
  const leading = quantile(gaps.filter(g => g > body * 0.5 && g < body * 3), 0.25) || body * 1.2;
  const left = median(all.filter(l => Math.abs(l.size - body) < body * 0.1).map(l => l.x));
  const headingSizes = [...new Set(all.filter(l => l.size >= body * 1.15 && l.text.length <= 200).map(l => Math.round(l.size)))].sort((a, b) => b - a);
  const levelOf = size => { const rank = headingSizes.indexOf(Math.round(size)); return headingSizes.length === 1 ? 2 : Math.min(3, rank + 1); };
  const blocks = [];
  let current = null, listBase = 0;
  const flush = () => {
    // A single row with wide gaps is a spaced-out line, not a table.
    if (current?.type === 'table' && current.rows.length < 2) current = { type: 'p', parts: current.rows[0].flatMap((cell, k) => k ? [{ text: ' ', bold: false, italic: false }, ...cell] : cell), bold: false, lines: 1 };
    if (current) blocks.push(current);
    current = null;
  };
  for (const [pageIndex, lines] of pages.entries()) {
    let previous = null;
    for (const line of lines) {
      const big = line.size >= body * 1.15 && line.text.length <= 200;
      const bullet = BULLET.exec(line.text), numbered = !big && NUMBERED.exec(line.text);
      const gap = previous ? previous.y - line.y : 0;
      const continuesPage = !previous && pageIndex > 0 && current?.type === 'p' && !ENDS_SENTENCE.test(textOfParts(current.parts)) && /^[a-z]/.test(line.text) && !big;
      const sizeChange = previous && Math.abs(line.size - previous.size) > Math.max(previous.size, line.size) * 0.12;
      const indented = previous && current?.type === 'p' && line.x > left + body * 1.2 && ENDS_SENTENCE.test(previous.text) && Math.abs(line.x - previous.x) > body;
      // A list item only takes lines indented past its marker.
      const outdented = current?.type === 'li' && line.x < current.x + body * 0.3;
      const boldChange = previous && previous.bold !== line.bold;
      const breaks = !previous ? !continuesPage : gap < -body || gap > leading * 1.3 || sizeChange || indented || outdented || boldChange || (current?.type === 'h') !== big;
      if (line.cells && (current?.type === 'table' || !(bullet || numbered)) && !big) {
        if (current?.type !== 'table' || gap > leading * 2.5) { flush(); current = { type: 'table', rows: [] }; }
        current.rows.push(line.cells);
      } else if (bullet || numbered) {
        const previousItem = current?.type === 'li' ? current : null;
        flush();
        if (!previousItem) listBase = line.x;
        const level = Math.max(0, Math.min((previousItem?.level ?? -1) + 1, 3, Math.round((line.x - listBase) / (body * 1.2))));
        current = { type: 'li', ordered: !!numbered, start: numbered ? Number(numbered[1]) : 0, level, x: line.x, parts: sliceParts(line.parts, (bullet || numbered)[0].length) };
      } else if (current && current.type !== 'table' && !breaks && (current.type !== 'h' || big)) {
        joinParts(current.parts, line.parts);
        if (current.type === 'h' && textOfParts(current.parts).length > 200) current.type = 'p';
        if (current.type === 'p') { current.lines++; current.bold = current.bold && line.bold; }
      } else {
        flush();
        current = big ? { type: 'h', level: levelOf(line.size), parts: line.parts.map(p => ({ ...p })) } : { type: 'p', parts: line.parts.map(p => ({ ...p })), bold: line.bold, lines: 1 };
      }
      previous = line;
    }
  }
  flush();
  // A lone short bold line at body size reads as a minor heading.
  for (const [k, block] of blocks.entries()) {
    const text = block.type === 'p' ? textOfParts(block.parts) : '';
    if (block.type === 'p' && block.bold && block.lines === 1 && text.length <= 80 && !/[.,;]$/.test(text) && blocks[k + 1]) blocks[k] = { type: 'h', level: 3, parts: block.parts };
  }
  return blocks.map(block => block.type === 'h' ? { ...block, parts: block.parts.map(p => ({ ...p, bold: false, italic: false })) } : block);
}

/**
 * extractPdf(bytes) -> { pages, blocks, chars, needsAi, reason, encrypted }
 * needsAi is set for pages without a text layer (scans), encrypted files and fonts whose text cannot be mapped.
 */
export async function extractPdf(input, { maxPages = MAX_PDF_PAGES } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (latin1(bytes.subarray(0, 1024)).indexOf('%PDF-') < 0) throw new ImportError('This file is not a PDF.', 'damaged');
  const pdf = new PdfDocument(bytes);
  pdf.scan();
  await pdf.expandObjectStreams();
  const encrypted = pdf.encrypted();
  const pageList = pdf.pages().slice(0, maxPages);
  if (encrypted) return { pages: pageList.length, blocks: [], chars: 0, needsAi: true, reason: 'encrypted', encrypted: true };
  const stats = { chars: 0, bad: 0, images: 0 };
  const pageLines = [];
  let total = 0;
  for (const page of pageList) {
    const contents = page.dict.get('Contents');
    const parts = (Array.isArray(pdf.resolve(contents)) ? pdf.resolve(contents) : [contents]).map(ref => pdf.entryOf(ref)).filter(Boolean);
    let source = '';
    for (const part of parts) { try { source += latin1(await pdf.streamBytes(part)) + '\n'; } catch { /* unreadable part */ } }
    const runs = [];
    await readContent(pdf, source, page.resources, ID, runs, stats);
    const lines = linesOf(runs);
    pageLines.push(lines);
    total += lines.reduce((sum, line) => sum + line.text.length, 0);
    if (total > MAX_CHARS) break;
  }
  const cleaned = dropRunningLines(pageLines);
  const chars = cleaned.flat().reduce((sum, line) => sum + line.text.replace(/\s/g, '').length, 0);
  const pages = pageList.length;
  // Scans are pages of pictures: no text at all, or a few stray characters beside drawn images.
  const scanned = pages > 0 && (chars === 0 || (chars / pages < 25 && stats.images >= pages));
  const garbled = stats.chars > 50 && stats.bad / stats.chars > 0.3;
  return { pages, blocks: scanned || garbled ? [] : layoutBlocks(cleaned), chars, needsAi: scanned || garbled || !pages, reason: !pages ? 'empty' : scanned ? 'scanned' : garbled ? 'fonts' : '', encrypted: false, truncated: total > MAX_CHARS || pdf.pages().length > maxPages };
}
