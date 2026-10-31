// File import for notes: converts a file into note Markdown on this device. Structured formats go through simple
// HTML and the block editor's htmlToMarkdown, so the result is escaped and nested like pasted content; Markdown is
// normalized to the syntax the editor understands. Scanned PDFs and images have no text to convert and come back with
// `needsAi`, for the AI importer (lib/ai/imports.js) to transcribe. Nothing here stores the original file.
import { readZip, ImportError } from './zip.js';
import { extractPdf } from './pdf.js';
import { docxToBlocks, odtToBlocks, pptxToBlocks, xlsxToBlocks, epubChapters, nestByIndent, MONO } from './office.js';
import { blocksToHtml, inline, esc, cp1252 } from './blocks.js';
import { decodeXml } from './xml.js';
import { htmlToMarkdown } from '../block-editor.js';
import { serializeNoteBlocks } from '../markdown.js';

export { ImportError };
export const MAX_IMPORT_FILES = 10;
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_CHARS = 400_000;
const MAX_TABLE_ROWS = 2000;

const CODE_LANGUAGES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash',
  zsh: 'bash', ps1: 'powershell', sql: 'sql', css: 'css', scss: 'scss', less: 'less', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
  ini: 'ini', conf: 'ini', cfg: 'ini', env: 'bash', lua: 'lua', r: 'r', dart: 'dart', scala: 'scala', vue: 'vue', svelte: 'svelte', graphql: 'graphql',
  proto: 'protobuf', tex: 'latex', diff: 'diff', patch: 'diff', dockerfile: 'dockerfile', makefile: 'makefile',
};
export const IMPORT_FORMATS = Object.freeze({
  pdf: { label: 'PDF', ext: ['pdf'] },
  docx: { label: 'Word', ext: ['docx', 'docm', 'dotx'] },
  odt: { label: 'OpenDocument', ext: ['odt'] },
  pptx: { label: 'PowerPoint', ext: ['pptx'] },
  xlsx: { label: 'Excel', ext: ['xlsx', 'xlsm'] },
  epub: { label: 'EPUB', ext: ['epub'] },
  html: { label: 'HTML', ext: ['html', 'htm', 'xhtml'] },
  markdown: { label: 'Markdown', ext: ['md', 'markdown', 'mdown', 'mkd', 'mdx'] },
  text: { label: 'Text', ext: ['txt', 'text', 'log'] },
  csv: { label: 'CSV', ext: ['csv'] },
  tsv: { label: 'TSV', ext: ['tsv', 'tab'] },
  json: { label: 'JSON', ext: ['json', 'jsonl', 'ndjson', 'geojson'] },
  rtf: { label: 'Rich Text', ext: ['rtf'] },
  code: { label: 'Code', ext: Object.keys(CODE_LANGUAGES) },
  image: { label: 'Image', ext: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
});
const LEGACY = {
  doc: 'Older .doc files cannot be read here. Save it as .docx and import that.', xls: 'Older .xls files cannot be read here. Save it as .xlsx and import that.',
  ppt: 'Older .ppt files cannot be read here. Save it as .pptx and import that.', pages: 'Export this Pages document as Word (.docx) or PDF first.',
  key: 'Export this Keynote file as PowerPoint (.pptx) or PDF first.', numbers: 'Export this Numbers file as Excel (.xlsx) or CSV first.',
  heic: 'HEIC photos cannot be read here. Export it as JPEG or PNG first.', zip: 'Unzip the archive and import the files inside.',
};
/** For <input accept>: every extension an import can read. */
export const IMPORT_ACCEPT = Object.values(IMPORT_FORMATS).flatMap(format => format.ext).map(ext => '.' + ext).join(',');

export const extensionOf = name => { const m = /\.([a-z0-9]+)$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : String(name || '').toLowerCase() === 'dockerfile' ? 'dockerfile' : ''; };
export const baseName = name => String(name || '').replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[_]+/g, ' ').trim() || 'Imported file';

const startsWith = (bytes, ...values) => values.every((value, i) => bytes[i] === value);
/** Picks a converter from the name, then the MIME type and the first bytes. Returns { format } or { error }. */
export function detectFormat({ name = '', type = '' } = {}, head = new Uint8Array(0)) {
  const ext = extensionOf(name);
  if (LEGACY[ext]) return { format: null, error: LEGACY[ext] };
  if (startsWith(head, 0x25, 0x50, 0x44, 0x46)) return { format: 'pdf' };
  for (const [format, spec] of Object.entries(IMPORT_FORMATS)) if (spec.ext.includes(ext)) return { format };
  if (startsWith(head, 0x89, 0x50, 0x4e, 0x47) || startsWith(head, 0xff, 0xd8, 0xff) || startsWith(head, 0x47, 0x49, 0x46) || (startsWith(head, 0x52, 0x49, 0x46, 0x46) && head[8] === 0x57)) return { format: 'image' };
  if (startsWith(head, 0x50, 0x4b, 0x03, 0x04)) return { format: 'zip' };
  if (startsWith(head, 0x7b, 0x5c, 0x72, 0x74, 0x66)) return { format: 'rtf' };
  const mime = String(type).toLowerCase();
  if (mime === 'application/pdf') return { format: 'pdf' };
  if (mime === 'text/markdown') return { format: 'markdown' };
  if (mime === 'text/html') return { format: 'html' };
  if (mime === 'text/csv') return { format: 'csv' };
  if (mime.startsWith('image/')) return { format: null, error: 'Only PNG, JPEG, WebP and GIF images can be read.' };
  if (mime.startsWith('text/') || mime === 'application/json') return { format: mime === 'application/json' ? 'json' : 'text' };
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return { format: null, error: 'Audio and video files have no text to import. Use /embed to show them in the note.' };
  return { format: null, error: 'This file type cannot be imported. Try PDF, Word, Markdown, text, HTML, CSV or an image.' };
}

/** Decodes text by BOM, then strict UTF-8, then Windows-1252. */
export function decodeText(bytes) {
  if (startsWith(bytes, 0xef, 0xbb, 0xbf)) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (startsWith(bytes, 0xff, 0xfe)) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (startsWith(bytes, 0xfe, 0xff)) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return cp1252(bytes); }
}

/* ---------------------------------------------------------------- Markdown */

const HTML_BLOCK = /^ {0,3}<(?:div|p|table|details|h[1-6]|ul|ol|blockquote|pre|center|section|article|figure|picture|img|a|dl|hr|br)\b/i;
const NOT_SETEXT = /^\s*(?:[-*+]\s|\d+[.)]\s|>|#|\||```|~~~)/;
/** Neutralizes embed syntax in imported or generated Markdown: a file or a model never adds live frames to a note. */
export function withoutEmbeds(line) {
  return line.replace(/^(\s*)::embed\[((?:\\.|[^\]\\])*)\]\(([^)\s]*)\)(?:\{[^}]*\})?\s*$/, (_, lead, label, url) => `${lead}[${label || url}](${url})`).replace(/^(\s*)!\[\[/, '$1[[');
}

/**
 * Rewrites Markdown into the subset the note editor reads: ATX headings deeper than ### become ###, setext headings
 * become ATX, "+" bullets become "-", "1)" becomes "1.", reference links become inline links, front matter becomes a
 * code block and HTML blocks are converted. Blank-line runs collapse to one. Code fences are left untouched.
 */
export function normalizeMarkdown(source) {
  let text = String(source ?? '').replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  const front = /^(---|\+\+\+)\n([\s\S]*?)\n\1[ \t]*(?:\n|$)/.exec(text);
  if (front) text = '```' + (front[1] === '---' ? 'yaml' : 'toml') + '\n' + front[2] + '\n```\n' + text.slice(front[0].length);
  const lines = text.split('\n');
  const refs = new Map();
  let fence = null;
  const kept = [];
  for (const line of lines) {
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length && !line.trim().slice(opener[1].length).trim()) fence = null; kept.push(line); continue; }
    if (opener) { fence = opener[1]; kept.push(line); continue; }
    const def = /^ {0,3}\[([^\]\n]+)\]:\s*<?([^\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/.exec(line);
    if (def && !/^\^/.test(def[1])) { refs.set(def[1].trim().toLowerCase(), def[2]); continue; }
    kept.push(line);
  }
  const out = [];
  fence = null;
  for (let k = 0; k < kept.length; k++) {
    const line = kept[k];
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length && !line.trim().slice(opener[1].length).trim()) fence = null; out.push(line); continue; }
    if (opener) { fence = opener[1]; out.push(line); continue; }
    if (HTML_BLOCK.test(line)) {
      let end = k;
      while (end + 1 < kept.length && kept[end + 1].trim()) end++;
      const converted = htmlToMarkdown(kept.slice(k, end + 1).join('\n'));
      if (converted.trim()) out.push(...converted.split('\n'));
      k = end;
      continue;
    }
    const next = kept[k + 1];
    if (line.trim() && next !== undefined && /^ {0,3}(=+|-+)[ \t]*$/.test(next) && !NOT_SETEXT.test(line) && (next.trim()[0] === '=' || next.trim().length >= 2)) {
      out.push(`${next.trim()[0] === '=' ? '#' : '##'} ${line.trim()}`);
      k++;
      continue;
    }
    let value = line;
    const atx = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(value);
    if (atx) value = `${'#'.repeat(Math.min(3, atx[1].length))} ${atx[2]}`;
    else if (/^ {0,3}#{1,6}[ \t]*$/.test(value)) value = '';
    value = value.replace(/^(\s*)\+(\s+)/, '$1-$2').replace(/^(\s*)(\d{1,9})\)(\s+)/, '$1$2.$3');
    if (refs.size) value = value.replace(/(!?)\[([^\]\n]+)\]\[([^\]\n]*)\]/g, (whole, bang, label, ref) => { const url = refs.get((ref || label).trim().toLowerCase()); return url ? `${bang}[${label}](${url})` : whole; });
    out.push(withoutEmbeds(value));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, '');
}

/* ---------------------------------------------------------------- simple formats */

/** RFC 4180 rows. The delimiter is guessed from the first line when not given. */
export function parseDelimited(text, delimiter) {
  const source = String(text ?? '').replace(/^\ufeff/, '');
  if (!delimiter) {
    const firstLine = source.split('\n', 1)[0].replace(/"[^"]*"/g, '');
    delimiter = [',', ';', '\t', '|'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  }
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') { if (source[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
      continue;
    }
    if (ch === '"' && !field) quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && source[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim()));
}
function delimitedBlocks(text, delimiter) {
  const rows = parseDelimited(text, delimiter);
  const warnings = rows.length > MAX_TABLE_ROWS ? [`Only the first ${MAX_TABLE_ROWS.toLocaleString('en-US')} rows were imported.`] : [];
  return { blocks: [{ type: 'table', rows: rows.slice(0, MAX_TABLE_ROWS).map(r => r.slice(0, 50).map(cell => esc(cell.trim()).replace(/\r?\n/g, '<br>'))) }], warnings };
}

const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
  'footnote', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'mmathPr', 'pgdsctbl', 'fldinst', 'shppict', 'nonshppict', 'bkmkstart', 'bkmkend', 'revtbl', 'filetbl']);
const RTF_CHARS = { emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ', qmspace: ' ', tab: ' ', line: '\n', cell: ' ' };
const CODEPAGES = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258', 10000: 'macintosh' };
/**
 * Rich Text: paragraphs with bold/italic/links, headings (\outlinelevel or a larger font size), tables (\intbl,
 * \cell, \row), monospace paragraphs as code and bullets written as text as list items, nested by left indent.
 */
export function rtfToBlocks(source) {
  const s = String(source ?? '');
  const page = CODEPAGES[Number(/\\ansicpg(\d+)/.exec(s)?.[1])];
  let decoder;
  try { decoder = page && page !== 'windows-1252' ? new TextDecoder(page) : { decode: cp1252 }; } catch { decoder = { decode: cp1252 }; }
  const mono = new Set();
  const fonts = /\{\\fonttbl([\s\S]*?)\}\s*(?:\{\\colortbl|\{\\\*|\{\\stylesheet|\\)/.exec(s)?.[1] || '';
  for (const m of fonts.matchAll(/\\f(\d+)[^;]*?([^;\\{}]*);/g)) if (MONO.test(m[2])) mono.add(Number(m[1]));
  const paragraphs = [];
  let runs = [], bytes = [], fallback = 0, table = null, row = [], cell = [];
  let state = { bold: false, italic: false, skip: false, uc: 1, font: 0, size: 24, href: '', field: null, inst: false };
  let para = { outline: null, indent: 0, intbl: false };
  const stack = [];
  const push = value => {
    if (!value) return;
    if (state.inst) { if (state.field) state.field.inst += value; return; }
    if (!state.skip) runs.push({ text: value, bold: state.bold, italic: state.italic, href: state.href, mono: mono.has(state.font), size: state.size });
  };
  const flushBytes = () => { if (bytes.length) { const value = decoder.decode(Uint8Array.from(bytes)); bytes = []; push(value); } };
  const endTable = () => { if (table) { paragraphs.push({ table }); table = null; } };
  const paragraph = () => {
    flushBytes();
    const text = runs.map(run => run.text).join('');
    if (para.intbl) { if (text.trim()) cell.push(inline(runs)); }
    else {
      endTable();
      if (text.trim()) paragraphs.push({ runs, text, outline: para.outline, indent: para.indent, mono: runs.every(run => run.mono || !run.text.trim()), size: Math.max(...runs.filter(run => run.text.trim()).map(run => run.size)) });
    }
    runs = [];
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') { flushBytes(); stack.push({ ...state }); continue; }
    if (ch === '}') { flushBytes(); state = stack.pop() || state; continue; }
    if (ch === '\r' || ch === '\n') continue;
    if (ch !== '\\') { if (fallback > 0) { fallback--; continue; } flushBytes(); push(ch); continue; }
    const next = s[i + 1];
    if (next === '\'') { const hex = s.slice(i + 2, i + 4); i += 3; if (fallback > 0) { fallback--; continue; } if (!state.skip || state.inst) bytes.push(parseInt(hex, 16) || 0); continue; }
    if (next === '\\' || next === '{' || next === '}') { i++; flushBytes(); push(next); continue; }
    if (next === '~') { i++; flushBytes(); push('\u00a0'); continue; }
    if (next === '_') { i++; flushBytes(); push('-'); continue; }
    if (next === '*') { i++; state.skip = true; continue; }
    if (next === '\n' || next === '\r') { i++; paragraph(); continue; }
    const m = /^([a-z]{1,32})(-?\d{1,10})? ?/i.exec(s.slice(i + 1, i + 48));
    if (!m) { i++; continue; }
    i += m[0].length;
    const word = m[1], param = m[2] === undefined ? null : Number(m[2]);
    if (word === 'field') { state.field = { inst: '' }; continue; }
    if (word === 'fldinst') { state.inst = true; state.skip = false; continue; }
    if (word === 'fldrslt') { state.inst = false; state.skip = false; state.href = /HYPERLINK\s+"([^"]+)"/.exec(state.field?.inst || '')?.[1] || ''; continue; }
    if (RTF_SKIP.has(word)) { state.skip = true; continue; }
    if (state.skip && !state.inst) continue;
    flushBytes();
    if (word === 'par' || word === 'sect') paragraph();
    else if (word === 'pard') para = { outline: null, indent: 0, intbl: false };
    else if (word === 'intbl') para.intbl = true;
    else if (word === 'cell') { paragraph(); row.push(cell.join('<br>')); cell = []; }
    else if (word === 'row') { if (runs.length || cell.length) { paragraph(); if (cell.length) { row.push(cell.join('<br>')); cell = []; } } if (row.length) (table ||= []).push(row); row = []; }
    else if (word === 'outlinelevel') para.outline = param;
    else if (word === 'li') para.indent = param || 0;
    else if (word === 'b') state.bold = param !== 0;
    else if (word === 'i') state.italic = param !== 0;
    else if (word === 'f') state.font = param || 0;
    else if (word === 'fs') state.size = param || 24;
    else if (word === 'plain') { state.bold = false; state.italic = false; state.size = 24; state.font = 0; }
    else if (word === 'uc') state.uc = param ?? 1;
    else if (word === 'u') { push(String.fromCharCode(param < 0 ? param + 65536 : param)); fallback = state.uc; }
    else if (RTF_CHARS[word]) push(RTF_CHARS[word]);
  }
  paragraph();
  endTable();
  // Headings: an explicit outline level, else a short paragraph set larger than the body text.
  const weights = new Map();
  for (const p of paragraphs) if (p.runs) weights.set(p.size, (weights.get(p.size) || 0) + p.text.length);
  const body = [...weights].sort((a, b) => b[1] - a[1])[0]?.[0] || 24;
  const larger = [...new Set(paragraphs.filter(p => p.runs && p.size >= body * 1.15 && p.text.length <= 200).map(p => p.size))].sort((a, b) => b - a);
  const blocks = [];
  for (const p of paragraphs) {
    if (p.table) { blocks.push({ type: 'table', rows: p.table }); continue; }
    const heading = p.outline !== null && p.outline < 9 ? p.outline + 1 : larger.includes(p.size) && p.text.length <= 200 ? larger.indexOf(p.size) + 1 : 0;
    if (heading) { blocks.push({ type: 'h', level: Math.min(3, heading), html: inline(p.runs.map(run => ({ ...run, bold: false, italic: false }))) }); continue; }
    if (p.mono) { const last = blocks.at(-1); if (last?.type === 'code') last.text += '\n' + p.text; else blocks.push({ type: 'code', text: p.text }); continue; }
    const marker = /^\s*([•·▪◦–\-])\s+|^\s*(\d{1,3})[.)]\s+/.exec(p.text);
    if (marker) {
      let skip = marker[0].length;
      const rest = p.runs.map(run => { const cut = Math.min(skip, run.text.length); skip -= cut; return { ...run, text: run.text.slice(cut) }; });
      blocks.push({ type: 'li', ordered: !!marker[2], start: marker[2] ? Number(marker[2]) : 0, level: 0, indent: p.indent, html: inline(rest) });
    } else blocks.push({ type: 'p', html: inline(p.runs) });
  }
  return nestByIndent(blocks);
}

function textBlocks(text) {
  return String(text).replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/).map(paragraph => paragraph.replace(/^\n+|\s+$/g, '')).filter(Boolean)
    .map(paragraph => ({ type: 'p', html: esc(paragraph).replace(/\n/g, '<br>') }));
}
function htmlDocument(source) {
  const title = decodeXml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  let body = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(source)?.[1] || /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(source)?.[1] || source;
  body = body.replace(/<(nav|aside|footer|form)\b[\s\S]*?<\/\1>/gi, '');
  return { title, markdown: htmlToMarkdown(body) };
}
const codeBlock = (text, language) => serializeNoteBlocks([{ id: 'code', type: 'code', text: String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, ''), language, checked: false }]);
const markdownOf = blocks => htmlToMarkdown(blocksToHtml(blocks));

/** Cuts Markdown over `limit` characters at the last line break before it. */
export function clampMarkdown(markdown, limit = MAX_IMPORT_CHARS) {
  if (markdown.length <= limit) return { markdown, truncated: false };
  const cut = markdown.lastIndexOf('\n', limit);
  return { markdown: markdown.slice(0, cut > limit * 0.5 ? cut : limit), truncated: true };
}

/**
 * convertFile(file) -> { name, format, label, markdown, title, warnings, needsAi, bytes, pages }
 * file: a File/Blob with name, type, size and arrayBuffer(). needsAi: null | { kind: 'pdf' | 'image', reason, mediaType }.
 * `bytes` is returned for PDFs and images so the AI importer can read the original when it is needed.
 */
export async function convertFile(file, { signal } = {}) {
  const name = String(file?.name || 'Untitled file');
  if (!file || typeof file.arrayBuffer !== 'function') throw new ImportError('Choose a file to import.', 'bad_request');
  if (file.size > MAX_IMPORT_BYTES) throw new ImportError(`${name} is over 50 MB. Choose a smaller file.`, 'too_large');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (signal?.aborted) throw new DOMException('Import stopped.', 'AbortError');
  let { format, error } = detectFormat(file, bytes.subarray(0, 16));
  if (!format) throw new ImportError(error, 'unsupported');
  let zip = null;
  if (['docx', 'odt', 'pptx', 'xlsx', 'epub', 'zip'].includes(format)) {
    zip = readZip(bytes);
    if (format === 'zip') {
      format = zip.has('word/document.xml') ? 'docx' : zip.has('ppt/presentation.xml') ? 'pptx' : zip.has('xl/workbook.xml') ? 'xlsx'
        : zip.has('META-INF/container.xml') && zip.has('mimetype') && /epub/.test(await zip.text('mimetype')) ? 'epub' : zip.has('content.xml') ? 'odt' : null;
      if (!format) throw new ImportError(LEGACY.zip, 'unsupported');
    }
  }
  const result = { name, format, label: IMPORT_FORMATS[format]?.label || 'File', markdown: '', title: '', warnings: [], needsAi: null, bytes: null, pages: 0 };
  const ext = extensionOf(name);
  switch (format) {
    case 'pdf': {
      const pdf = await extractPdf(bytes);
      result.pages = pdf.pages;
      result.bytes = bytes;
      if (pdf.needsAi) result.needsAi = { kind: 'pdf', reason: pdf.reason, mediaType: 'application/pdf' };
      else result.markdown = markdownOf(pdf.blocks.map(block => block.type === 'table' ? { type: 'table', rows: block.rows.map(row => row.map(inline)) } : { ...block, html: inline(block.parts) }));
      if (pdf.truncated) result.warnings.push('Only the first part of this PDF was imported.');
      break;
    }
    case 'image': {
      const mediaType = /^image\/(png|jpeg|webp|gif)$/.test(file.type) ? file.type : { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/png';
      result.bytes = bytes;
      result.needsAi = { kind: 'image', reason: 'image', mediaType };
      break;
    }
    case 'docx': case 'odt': case 'pptx': case 'xlsx': {
      const converted = await { docx: docxToBlocks, odt: odtToBlocks, pptx: pptxToBlocks, xlsx: xlsxToBlocks }[format](zip);
      result.markdown = markdownOf(converted.blocks);
      result.title = converted.title || '';
      result.warnings.push(...(converted.warnings || []));
      break;
    }
    case 'epub': {
      const book = await epubChapters(zip);
      result.title = book.title;
      result.markdown = book.chapters.map(chapter => htmlDocument(chapter).markdown).filter(Boolean).join('\n');
      break;
    }
    case 'html': { const doc = htmlDocument(decodeText(bytes)); result.title = doc.title; result.markdown = normalizeMarkdown(doc.markdown); break; }
    case 'markdown': result.markdown = normalizeMarkdown(decodeText(bytes)); break;
    case 'text': result.markdown = markdownOf(textBlocks(decodeText(bytes))); break;
    case 'csv': case 'tsv': { const table = delimitedBlocks(decodeText(bytes), format === 'tsv' ? '\t' : undefined); result.markdown = markdownOf(table.blocks); result.warnings.push(...table.warnings); break; }
    case 'rtf': result.markdown = markdownOf(rtfToBlocks(decodeText(bytes))); break;
    case 'json': {
      const raw = decodeText(bytes);
      let pretty = raw;
      if (raw.length < 300000 && ext !== 'jsonl' && ext !== 'ndjson') { try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* keep the original text */ } }
      result.markdown = codeBlock(pretty, 'json');
      break;
    }
    case 'code': result.markdown = codeBlock(decodeText(bytes), CODE_LANGUAGES[ext] || ''); break;
    default: throw new ImportError('This file type cannot be imported.', 'unsupported');
  }
  const clamped = clampMarkdown(result.markdown);
  result.markdown = clamped.markdown;
  if (clamped.truncated) result.warnings.push(`Only the first ${MAX_IMPORT_CHARS.toLocaleString('en-US')} characters were imported.`);
  if (!result.needsAi && !result.markdown.trim()) result.warnings.push('No text was found in this file.');
  return result;
}

/** The first "# Title" of imported Markdown, if the text starts with one. */
export function leadingTitle(markdown) {
  const m = /^# (.+)\n?/.exec(String(markdown || '').replace(/^\s+/, ''));
  return m ? m[1].replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1').replace(/[*_`~]/g, '').trim() : '';
}
