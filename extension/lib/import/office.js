// Office Open XML (DOCX, PPTX, XLSX), OpenDocument text (ODT) and EPUB to import blocks. Each reader keeps
// structure the note editor can show (headings, lists, tasks, quotes, code, tables, links, bold/italic/strike) and
// drops what it cannot (images, drawings, comments, tracked deletions, headers and footers).
import { parseXml, children, child, descendants, first, elements, textOf, attr, localName } from './xml.js';
import { inline, esc } from './blocks.js';
import { ImportError } from './zip.js';

const on = element => !!element && !['0', 'false', 'off', 'none'].includes(String(attr(element, 'val') ?? 'true').toLowerCase());
export const MONO = /courier|consolas|menlo|monaco|mono|source code|fira code|inconsolata|lucida console/i;
const dirOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
export function joinPath(base, target) {
  if (/^[a-z][a-z\d+.-]*:/i.test(target)) return target;
  const parts = (target.startsWith('/') ? target.slice(1) : base + target).split('/');
  const out = [];
  for (const part of parts) { if (part === '..') out.pop(); else if (part && part !== '.') out.push(part); }
  return out.join('/');
}
async function relationships(zip, path) {
  const map = new Map();
  const xml = await zip.text(path);
  if (!xml) return map;
  for (const rel of descendants(parseXml(xml), 'Relationship')) map.set(attr(rel, 'Id'), { target: attr(rel, 'Target') || '', external: attr(rel, 'TargetMode') === 'External', type: attr(rel, 'Type') || '' });
  return map;
}
const cellHtml = paragraphs => paragraphs.filter(Boolean).join('<br>');

/* ---------------------------------------------------------------- DOCX */

function docxStyles(xml) {
  const styles = new Map();
  if (!xml) return styles;
  for (const style of descendants(parseXml(xml), 'w:style')) {
    const id = attr(style, 'w:styleId');
    const pPr = child(style, 'w:pPr'), rPr = child(style, 'w:rPr'), numPr = child(pPr, 'w:numPr');
    styles.set(id, {
      type: attr(style, 'w:type'), name: String(attr(child(style, 'w:name'), 'w:val') || id || '').toLowerCase(), basedOn: attr(child(style, 'w:basedOn'), 'w:val'),
      outline: attr(child(pPr, 'w:outlineLvl'), 'w:val'), numId: attr(child(numPr, 'w:numId'), 'w:val'), ilvl: attr(child(numPr, 'w:ilvl'), 'w:val'),
      bold: rPr ? on(child(rPr, 'w:b')) : undefined, italic: rPr ? on(child(rPr, 'w:i')) : undefined, mono: MONO.test(attr(child(rPr, 'w:rFonts'), 'w:ascii') || ''),
    });
  }
  // Fold inherited properties down the basedOn chain.
  const resolved = new Map();
  const resolve = (id, depth = 0) => {
    if (resolved.has(id)) return resolved.get(id);
    const own = styles.get(id);
    if (!own) return null;
    const parent = own.basedOn && depth < 16 ? resolve(own.basedOn, depth + 1) : null;
    const value = { ...own };
    for (const key of ['outline', 'numId', 'ilvl', 'bold', 'italic']) if (value[key] == null && parent) value[key] = parent[key];
    value.mono = own.mono || !!parent?.mono;
    value.family = [own.name, ...(parent?.family || [])];
    resolved.set(id, value);
    return value;
  };
  for (const id of styles.keys()) resolve(id);
  return resolved;
}

function docxNumbering(xml) {
  const abstract = new Map(), nums = new Map();
  if (!xml) return { kind: () => 'bullet', indent: () => null };
  const root = parseXml(xml);
  for (const node of descendants(root, 'w:abstractNum')) {
    const levels = new Map();
    for (const level of children(node, 'w:lvl')) {
      const ind = child(child(level, 'w:pPr'), 'w:ind');
      levels.set(String(attr(level, 'w:ilvl')), { format: String(attr(child(level, 'w:numFmt'), 'w:val') || 'bullet'), indent: Number(attr(ind, 'w:left') ?? attr(ind, 'w:start')) || null });
    }
    abstract.set(attr(node, 'w:abstractNumId'), levels);
  }
  for (const node of descendants(root, 'w:num')) {
    const levels = new Map(abstract.get(attr(child(node, 'w:abstractNumId'), 'w:val')) || []);
    for (const override of children(node, 'w:lvlOverride')) {
      const format = attr(child(child(override, 'w:lvl'), 'w:numFmt'), 'w:val');
      const key = String(attr(override, 'w:ilvl'));
      if (format) levels.set(key, { ...levels.get(key), format });
    }
    nums.set(attr(node, 'w:numId'), levels);
  }
  const level = (numId, ilvl) => nums.get(String(numId))?.get(String(ilvl || 0));
  return { kind: (numId, ilvl) => level(numId, ilvl)?.format || 'bullet', indent: (numId, ilvl) => level(numId, ilvl)?.indent ?? null };
}

function docxRuns(nodes, ctx, state, out) {
  for (const node of nodes) {
    if (!node.name) continue;
    switch (node.name) {
      case 'w:r': docxRun(node, ctx, state, out); break;
      case 'w:hyperlink': {
        const rel = ctx.rels.get(attr(node, 'r:id'));
        const previous = state.href;
        state.href = rel?.external || /^https?:|^mailto:/i.test(rel?.target || '') ? rel.target : previous;
        docxRuns(node.children, ctx, state, out);
        state.href = previous;
        break;
      }
      case 'w:fldSimple': {
        const link = /HYPERLINK\s+"([^"]+)"/.exec(attr(node, 'w:instr') || '');
        const previous = state.href;
        if (link) state.href = link[1];
        docxRuns(node.children, ctx, state, out);
        state.href = previous;
        break;
      }
      case 'w:sdt': docxRuns(child(node, 'w:sdtContent')?.children || [], ctx, state, out); break;
      case 'w:ins': case 'w:smartTag': case 'w:customXml': case 'w:moveTo': case 'w:dir': case 'w:bdo': docxRuns(node.children, ctx, state, out); break;
      default: break;
    }
  }
}
function docxRun(run, ctx, state, out) {
  const rPr = child(run, 'w:rPr');
  const charStyle = ctx.styles.get(attr(child(rPr, 'w:rStyle'), 'w:val'));
  if (on(child(rPr, 'w:vanish'))) return;
  const marks = {
    bold: child(rPr, 'w:b') ? on(child(rPr, 'w:b')) : !!charStyle?.bold,
    italic: child(rPr, 'w:i') ? on(child(rPr, 'w:i')) : !!charStyle?.italic,
    strike: on(child(rPr, 'w:strike')) || on(child(rPr, 'w:dstrike')),
    code: MONO.test(attr(child(rPr, 'w:rFonts'), 'w:ascii') || '') || !!charStyle?.mono,
  };
  for (const node of elements(run)) {
    const field = state.fields.at(-1);
    switch (node.name) {
      case 'w:fldChar': {
        const type = attr(node, 'w:fldCharType');
        if (type === 'begin') state.fields.push({ phase: 'instr', instr: '', href: '' });
        else if (type === 'separate' && field) { field.phase = 'result'; field.href = /HYPERLINK\s+"([^"]+)"/.exec(field.instr)?.[1] || ''; }
        else if (type === 'end') state.fields.pop();
        break;
      }
      case 'w:instrText': if (field) field.instr += textOf(node); break;
      case 'w:t': if (!field || field.phase === 'result') out.push({ text: textOf(node), ...marks, href: [...state.fields].reverse().find(f => f.href)?.href || state.href || '' }); break;
      case 'w:tab': case 'w:ptab': out.push({ text: ' ' }); break;
      case 'w:br': if (!['page', 'column'].includes(attr(node, 'w:type'))) out.push({ text: '\n' }); break;
      case 'w:cr': out.push({ text: '\n' }); break;
      case 'w:noBreakHyphen': out.push({ text: '-', ...marks }); break;
      default: break;
    }
  }
}

function docxParagraph(p, ctx, inTable) {
  const pPr = child(p, 'w:pPr');
  const style = ctx.styles.get(attr(child(pPr, 'w:pStyle'), 'w:val')) || ctx.styles.get(ctx.defaultStyle) || {};
  const family = style.family || [style.name || ''];
  const runs = [];
  docxRuns(p.children, ctx, { href: '', fields: [] }, runs);
  const text = runs.map(run => run.text).join('');
  if (!text.trim()) return null;
  const outline = attr(child(pPr, 'w:outlineLvl'), 'w:val') ?? style.outline;
  const heading = family.map(name => /^heading\s*([1-9])$/.exec(name)?.[1]).find(Boolean);
  let level = heading ? Number(heading) : family.includes('title') ? 1 : outline != null && Number(outline) < 9 ? Number(outline) + 1 : 0;
  if (inTable) level = 0;
  if (level) return { type: 'h', level: Math.min(3, level), html: inline(runs.map(run => ({ ...run, bold: false }))) };
  if (!inTable && family.some(name => /code|preformatted|source|verbatim|monospace/.test(name))) return { type: 'code', text };
  if (!inTable && family.some(name => /quote|block text/.test(name))) return { type: 'quote', html: inline(runs) };
  const numPr = child(pPr, 'w:numPr');
  const numId = attr(child(numPr, 'w:numId'), 'w:val') ?? style.numId;
  if (!inTable && numId && numId !== '0') {
    const ilvl = Number(attr(child(numPr, 'w:ilvl'), 'w:val') ?? style.ilvl ?? 0) || 0;
    const kind = ctx.numbering.kind(numId, ilvl);
    const ind = child(pPr, 'w:ind');
    const indent = Number(attr(ind, 'w:left') ?? attr(ind, 'w:start')) || ctx.numbering.indent(numId, ilvl);
    return { type: 'li', ordered: !['bullet', 'none'].includes(kind), level: ilvl, indent, html: inline(runs) };
  }
  return { type: 'p', html: inline(runs) };
}

function docxBlocks(nodes, ctx, out) {
  for (const node of nodes) {
    if (node.name === 'w:p') { const block = docxParagraph(node, ctx, false); if (block) out.push(block); continue; }
    if (node.name === 'w:tbl') { out.push(...docxTable(node, ctx)); continue; }
    if (node.name === 'w:sdt') { docxBlocks(child(node, 'w:sdtContent')?.children || [], ctx, out); continue; }
    if (['w:customXml', 'w:ins', 'w:moveTo'].includes(node.name)) docxBlocks(node.children, ctx, out);
  }
  return out;
}
function docxTable(table, ctx) {
  const rows = [];
  for (const tr of children(table, 'w:tr')) {
    const row = [];
    for (const tc of [...children(tr, 'w:tc'), ...children(tr, 'w:sdt').flatMap(sdt => children(child(sdt, 'w:sdtContent'), 'w:tc'))]) {
      const tcPr = child(tc, 'w:tcPr');
      const merged = child(tcPr, 'w:vMerge');
      const paragraphs = descendants(tc, 'w:p').map(p => docxParagraph(p, ctx, true)?.html || '');
      row.push(merged && attr(merged, 'w:val') !== 'restart' ? '' : cellHtml(paragraphs));
      for (let span = Number(attr(child(tcPr, 'w:gridSpan'), 'w:val')) || 1; span > 1; span--) row.push('');
    }
    rows.push(row);
  }
  // One-cell tables are layout boxes: keep their paragraphs instead of a table.
  if (rows.length === 1 && rows[0].length === 1) return docxBlocks(first(table, 'w:tc')?.children || [], ctx, []);
  return [{ type: 'table', rows }];
}

/** Word nests lists by indentation as often as by level ("List Bullet 2"): deeper indents in a run nest further. */
export function nestByIndent(blocks) {
  let stack = [];
  for (const block of blocks) {
    if (block.type !== 'li') { stack = []; continue; }
    if (!Number.isFinite(block.indent)) { stack = []; continue; }
    while (stack.length && block.indent < stack.at(-1) - 90) stack.pop();
    if (!stack.length || block.indent > stack.at(-1) + 90) stack.push(block.indent);
    block.level = Math.max(block.level || 0, stack.length - 1);
  }
  return blocks;
}

export async function docxToBlocks(zip) {
  const body = await zip.text('word/document.xml');
  if (!body) throw new ImportError('This Word file has no document body.', 'damaged');
  const styles = docxStyles(await zip.text('word/styles.xml'));
  const defaultStyle = [...styles].find(([, style]) => style.type === 'paragraph' && style.name === 'normal')?.[0] || 'Normal';
  const ctx = { rels: await relationships(zip, 'word/_rels/document.xml.rels'), styles, defaultStyle, numbering: docxNumbering(await zip.text('word/numbering.xml')) };
  const root = first(parseXml(body), 'w:body');
  const title = textOf(first(parseXml(await zip.text('docProps/core.xml') || ''), 'dc:title')).trim();
  // Consecutive code paragraphs form one code block.
  const blocks = [];
  for (const block of docxBlocks(root?.children || [], ctx, [])) {
    const last = blocks.at(-1);
    if (block.type === 'code' && last?.type === 'code') last.text += '\n' + block.text; else blocks.push(block);
  }
  return { blocks: nestByIndent(blocks), title };
}

/* ---------------------------------------------------------------- ODT */

function odtStyles(roots) {
  const text = new Map(), paragraph = new Map(), lists = new Map();
  for (const root of roots) {
    for (const style of descendants(root, 'style:style')) {
      const name = attr(style, 'style:name');
      const props = child(style, 'style:text-properties');
      const entry = {
        parent: attr(style, 'style:parent-style-name'), display: String(attr(style, 'style:display-name') || name || '').toLowerCase(),
        bold: /bold|[6-9]00/.test(attr(props, 'fo:font-weight') || ''), italic: attr(props, 'fo:font-style') === 'italic',
        strike: !!attr(props, 'style:text-line-through-style') && attr(props, 'style:text-line-through-style') !== 'none',
        mono: MONO.test(attr(props, 'style:font-name') || ''), outline: attr(style, 'style:default-outline-level'),
      };
      (attr(style, 'style:family') === 'paragraph' ? paragraph : text).set(name, entry);
      if (attr(style, 'style:family') === 'paragraph') text.set(name, entry);
    }
    for (const list of descendants(root, 'text:list-style')) {
      const levels = new Map();
      for (const level of elements(list)) levels.set(Number(attr(level, 'text:level')) || 1, localName(level.name) === 'list-level-style-number' && attr(level, 'style:num-format') ? 'number' : 'bullet');
      lists.set(attr(list, 'style:name'), levels);
    }
  }
  const chain = (map, name) => { const out = []; for (let n = name, k = 0; n && map.has(n) && k < 16; n = map.get(n).parent, k++) out.push(map.get(n)); return out; };
  return { text: name => chain(text, name), paragraph: name => chain(paragraph, name), list: (name, level) => lists.get(name)?.get(level) || 'bullet' };
}
function odtRuns(nodes, styles, marks, out) {
  for (const node of nodes) {
    if (typeof node.text === 'string') { out.push({ text: node.text.replace(/\s+/g, ' '), ...marks }); continue; }
    switch (localName(node.name)) {
      case 's': out.push({ text: ' '.repeat(Math.min(16, Number(attr(node, 'text:c')) || 1)) }); break;
      case 'tab': out.push({ text: ' ' }); break;
      case 'line-break': out.push({ text: '\n' }); break;
      case 'span': {
        const chain = styles.text(attr(node, 'text:style-name'));
        odtRuns(node.children, styles, { ...marks, bold: marks.bold || chain.some(s => s.bold), italic: marks.italic || chain.some(s => s.italic), strike: marks.strike || chain.some(s => s.strike), code: marks.code || chain.some(s => s.mono) }, out);
        break;
      }
      case 'a': odtRuns(node.children, styles, { ...marks, href: attr(node, 'xlink:href') || '' }, out); break;
      case 'note': case 'annotation': case 'frame': case 'bookmark': case 'bookmark-start': case 'bookmark-end': case 'soft-page-break': break;
      default: if (node.children) odtRuns(node.children, styles, marks, out);
    }
  }
}
function odtBlocks(nodes, styles, out, list = null) {
  for (const node of nodes) {
    const name = localName(node.name || '');
    if (name === 'h' || name === 'p') {
      const runs = [];
      const chain = styles.paragraph(attr(node, 'text:style-name'));
      const display = chain.map(s => s.display).join(' ');
      const level = name === 'h' ? Number(attr(node, 'text:outline-level')) || Number(chain.find(s => s.outline)?.outline) || 1 : chain.some(s => s.display === 'title') ? 1 : 0;
      odtRuns(node.children, styles, level ? {} : { italic: chain.some(s => s.italic), code: chain.some(s => s.mono) }, runs);
      const html = inline(runs);
      if (!html.trim()) continue;
      if (list) out.push({ type: 'li', ordered: list.kind === 'number', level: list.level, html });
      else if (level) out.push({ type: 'h', level: Math.min(3, level), html: inline(runs.map(run => ({ ...run, bold: false }))) });
      else if (/preformatted|source|code/.test(display)) out.push({ type: 'code', text: runs.map(run => run.text).join('') });
      else if (/quotation|quote|block text/.test(display)) out.push({ type: 'quote', html });
      else out.push({ type: 'p', html });
      continue;
    }
    if (name === 'list') {
      const level = list ? list.level + 1 : 0;
      const styleName = attr(node, 'text:style-name') || list?.styleName || '';
      for (const item of children(node, 'list-item').concat(children(node, 'list-header'))) odtBlocks(item.children, styles, out, { level, styleName, kind: styles.list(styleName, level + 1) });
      continue;
    }
    if (name === 'table') {
      const rows = descendants(node, 'table-row').map(row => children(row, 'table-cell').concat(children(row, 'covered-table-cell')).flatMap(cell => {
        const inner = [];
        odtBlocks(cell.children, styles, inner);
        return [cellHtml(inner.map(b => b.html ?? esc(b.text || ''))), ...Array(Math.max(0, (Number(attr(cell, 'table:number-columns-spanned')) || 1) - 1)).fill('')];
      }));
      out.push({ type: 'table', rows });
      continue;
    }
    if (['section', 'table-of-content', 'index-body', 'text', 'body'].includes(name)) odtBlocks(node.children, styles, out, list);
  }
  return out;
}
export async function odtToBlocks(zip) {
  const content = await zip.text('content.xml');
  if (!content) throw new ImportError('This OpenDocument file has no content.', 'damaged');
  const root = parseXml(content);
  const styles = odtStyles([root, parseXml(await zip.text('styles.xml') || '')]);
  const body = first(root, 'office:text');
  const title = textOf(first(parseXml(await zip.text('meta.xml') || ''), 'dc:title')).trim();
  return { blocks: odtBlocks(body?.children || [], styles, []), title };
}

/* ---------------------------------------------------------------- PPTX */

function pptxParagraphs(txBody, rels, { bullets }) {
  const out = [];
  for (const p of children(txBody, 'a:p')) {
    const runs = [];
    for (const node of elements(p)) {
      if (node.name === 'a:r' || node.name === 'a:fld') {
        const rPr = child(node, 'a:rPr');
        const link = rels.get(attr(child(rPr, 'a:hlinkClick'), 'r:id'));
        runs.push({ text: textOf(child(node, 'a:t')), bold: attr(rPr, 'b') === '1', italic: attr(rPr, 'i') === '1', strike: !!attr(rPr, 'strike') && attr(rPr, 'strike') !== 'noStrike', href: link?.external ? link.target : '' });
      } else if (node.name === 'a:br') runs.push({ text: '\n' });
    }
    const html = inline(runs);
    if (!html.trim()) continue;
    const pPr = child(p, 'a:pPr');
    const level = Number(attr(pPr, 'lvl')) || 0;
    const listed = child(pPr, 'a:buNone') ? false : child(pPr, 'a:buAutoNum') ? 'number' : child(pPr, 'a:buChar') ? 'bullet' : bullets ? 'bullet' : false;
    out.push(listed ? { type: 'li', ordered: listed === 'number', level, html } : { type: 'p', html });
  }
  return out;
}
function pptxShapes(nodes, rels, out) {
  for (const node of nodes) {
    if (node.name === 'p:grpSp') { pptxShapes(elements(node), rels, out); continue; }
    if (node.name === 'p:graphicFrame') {
      const table = first(node, 'a:tbl');
      if (table) out.body.push({ type: 'table', rows: children(table, 'a:tr').map(tr => children(tr, 'a:tc').map(tc => cellHtml(pptxParagraphs(child(tc, 'a:txBody'), rels, { bullets: false }).map(b => b.html)))) });
      continue;
    }
    if (node.name !== 'p:sp') continue;
    const ph = first(child(node, 'p:nvSpPr'), 'p:ph');
    const type = attr(ph, 'type');
    const txBody = child(node, 'p:txBody');
    if (!txBody) continue;
    if (type === 'title' || type === 'ctrTitle') { out.title ||= textOf(txBody).replace(/\s+/g, ' ').trim(); continue; }
    if (['sldNum', 'dt', 'ftr', 'hdr'].includes(type)) continue;
    out.body.push(...pptxParagraphs(txBody, rels, { bullets: !!ph && type !== 'subTitle' }));
  }
}
export async function pptxToBlocks(zip) {
  const presentation = await zip.text('ppt/presentation.xml');
  if (!presentation) throw new ImportError('This PowerPoint file has no slides.', 'damaged');
  const rels = await relationships(zip, 'ppt/_rels/presentation.xml.rels');
  let slides = descendants(parseXml(presentation), 'p:sldId').map(id => rels.get(attr(id, 'r:id'))?.target).filter(Boolean).map(target => joinPath('ppt/', target));
  if (!slides.length) slides = zip.names.filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/g).at(-1)) - Number(b.match(/\d+/g).at(-1)));
  const blocks = [];
  for (const [index, path] of slides.entries()) {
    const xml = await zip.text(path);
    if (!xml) continue;
    const slideRels = await relationships(zip, `${dirOf(path)}_rels/${path.split('/').pop()}.rels`);
    const shapes = { title: '', body: [] };
    pptxShapes(elements(first(parseXml(xml), 'p:spTree')), slideRels, shapes);
    blocks.push({ type: 'h', level: 2, html: esc(shapes.title ? shapes.title : `Slide ${index + 1}`) }, ...shapes.body);
    const notes = [...slideRels.values()].find(rel => /notesSlide$/.test(rel.type));
    if (notes) {
      const notesXml = await zip.text(joinPath(dirOf(path), notes.target));
      const body = notesXml ? descendants(parseXml(notesXml), 'p:sp').find(sp => attr(first(sp, 'p:ph'), 'type') === 'body') : null;
      const text = body ? pptxParagraphs(child(body, 'p:txBody'), slideRels, { bullets: false }).map(b => b.html).join('<br>') : '';
      if (text) blocks.push({ type: 'quote', html: `<em>Speaker notes:</em> ${text}` });
    }
  }
  const title = textOf(first(parseXml(await zip.text('docProps/core.xml') || ''), 'dc:title')).trim();
  return { blocks, title };
}

/* ---------------------------------------------------------------- XLSX */

export const MAX_SHEET_ROWS = 1000;
const MAX_SHEET_COLUMNS = 50;
const columnIndex = ref => { let n = 0; for (const ch of String(ref).replace(/\d+$/, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
function isDateFormat(id, code) {
  if (DATE_IDS.has(id)) return true;
  const clean = String(code || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  return /[dy]/i.test(clean) || (/m/i.test(clean) && /[hs]/i.test(clean));
}
function serialDate(value, date1904) {
  const days = Number(value) + (date1904 ? 1462 : 0);
  if (!Number.isFinite(days)) return String(value);
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(days * 86400000));
  const iso = date.toISOString();
  return days % 1 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}
export async function xlsxToBlocks(zip) {
  const workbookXml = await zip.text('xl/workbook.xml');
  if (!workbookXml) throw new ImportError('This Excel file has no workbook.', 'damaged');
  const workbook = parseXml(workbookXml);
  const date1904 = ['1', 'true'].includes(attr(first(workbook, 'workbookPr'), 'date1904') || '');
  const rels = await relationships(zip, 'xl/_rels/workbook.xml.rels');
  const shared = descendants(parseXml(await zip.text('xl/sharedStrings.xml') || ''), 'si').map(si => children(si, 't').length ? children(si, 't').map(textOf).join('') : children(si, 'r').map(r => textOf(child(r, 't'))).join(''));
  const stylesRoot = parseXml(await zip.text('xl/styles.xml') || '');
  const formats = new Map(descendants(stylesRoot, 'numFmt').map(f => [Number(attr(f, 'numFmtId')), attr(f, 'formatCode')]));
  const dateStyles = children(first(stylesRoot, 'cellXfs'), 'xf').map(xf => { const id = Number(attr(xf, 'numFmtId')) || 0; return isDateFormat(id, formats.get(id)); });
  const sheets = descendants(workbook, 'sheet').map(sheet => ({ name: attr(sheet, 'name') || 'Sheet', path: joinPath('xl/', rels.get(attr(sheet, 'r:id'))?.target || ''), hidden: attr(sheet, 'state') === 'hidden' }));
  const blocks = [];
  const notes = [];
  for (const sheet of sheets.filter(s => !s.hidden)) {
    const xml = await zip.text(sheet.path);
    if (!xml) continue;
    const grid = [];
    let truncated = false;
    for (const row of descendants(parseXml(xml), 'row')) {
      const r = (Number(attr(row, 'r')) || grid.length + 1) - 1;
      if (r >= MAX_SHEET_ROWS) { truncated = true; break; }
      let next = 0;
      for (const cell of children(row, 'c')) {
        const c = attr(cell, 'r') ? columnIndex(attr(cell, 'r')) : next;
        next = c + 1;
        if (c >= MAX_SHEET_COLUMNS) continue;
        const type = attr(cell, 't'), raw = textOf(child(cell, 'v'));
        let value = type === 's' ? shared[Number(raw)] ?? '' : type === 'inlineStr' ? textOf(child(cell, 'is')) : type === 'b' ? (raw === '1' ? 'TRUE' : 'FALSE') : raw;
        if ((!type || type === 'n') && raw && dateStyles[Number(attr(cell, 's')) || 0]) value = serialDate(raw, date1904);
        (grid[r] ||= [])[c] = esc(value).replace(/\r?\n/g, '<br>');
      }
    }
    const rows = grid.filter(row => row?.some(cell => cell && cell.trim()));
    if (!rows.length) continue;
    const width = Math.max(...rows.map(row => row.length));
    let used = 0;
    for (let c = 0; c < width; c++) if (rows.some(row => row[c]?.trim())) used = c + 1;
    if (sheets.length > 1) blocks.push({ type: 'h', level: 2, html: esc(sheet.name) });
    blocks.push({ type: 'table', rows: rows.map(row => Array.from({ length: used }, (_, c) => row[c] || '')) });
    if (truncated) notes.push(`${sheet.name}: only the first ${MAX_SHEET_ROWS.toLocaleString('en-US')} rows were imported.`);
  }
  return { blocks, title: '', warnings: notes };
}

/* ---------------------------------------------------------------- EPUB */

export async function epubChapters(zip) {
  const container = await zip.text('META-INF/container.xml');
  const opfPath = attr(first(parseXml(container || ''), 'rootfile'), 'full-path');
  if (!opfPath) throw new ImportError('This EPUB has no package file.', 'damaged');
  const opf = parseXml(await zip.text(opfPath) || '');
  const manifest = new Map(descendants(opf, 'item').map(item => [attr(item, 'id'), { href: attr(item, 'href') || '', type: attr(item, 'media-type') || '' }]));
  const base = dirOf(opfPath);
  const chapters = [];
  for (const ref of descendants(opf, 'itemref')) {
    if (attr(ref, 'linear') === 'no') continue;
    const item = manifest.get(attr(ref, 'idref'));
    if (!item || !/x?html/.test(item.type)) continue;
    const html = await zip.text(joinPath(base, decodeURIComponent(item.href.split('#')[0])));
    if (html) chapters.push(html);
  }
  return { chapters, title: textOf(first(opf, 'dc:title')).trim() };
}
