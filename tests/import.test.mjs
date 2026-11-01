import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { convertFile, detectFormat, normalizeMarkdown, parseDelimited, rtfToBlocks, withoutEmbeds, decodeText, clampMarkdown, leadingTitle, baseName, IMPORT_ACCEPT, MAX_IMPORT_BYTES } from '../extension/lib/import/index.js';
import { readZip, inflate } from '../extension/lib/import/zip.js';
import { parseXml, children, textOf, attr } from '../extension/lib/import/xml.js';
import { extractPdf, parseCMap, glyphToUnicode, parseValue } from '../extension/lib/import/pdf.js';
import { blocksToHtml, inline, cp1252 } from '../extension/lib/import/blocks.js';
import { parseNoteBlocks } from '../extension/lib/markdown.js';

const fixture = async name => new File([await readFile(new URL(`./fixtures/import/${name}`, import.meta.url))], name);
const convert = async (name, data, type = '') => convertFile(new File([data], name, { type }));
const lines = markdown => markdown.split('\n');

/* ---------------------------------------------------------------- builders */

function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, text, method = 8] of entries) {
    const raw = Buffer.from(text), data = method === 8 ? zlib.deflateRawSync(raw) : raw, nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(method, 10); head.writeUInt32LE(data.length, 20); head.writeUInt32LE(raw.length, 24); head.writeUInt16LE(nameBytes.length, 28); head.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(head, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// Catalog, pages and fonts live in a compressed object stream (PDF 1.5+); the heading font is Type0/Identity-H with a
// ToUnicode CMap, the body font a simple font whose /Differences name its glyphs, and TJ kerning stands in for spaces.
function objectStreamPdf() {
  const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange '
    + '2 beginbfrange <0001> <0003> <0048> <0004> <0004> [<0020>] endbfrange 1 beginbfchar <0005> <00660069> endbfchar endcmap end end';
  const content = [
    'BT /F1 24 Tf 72 720 Td <00010002000300040005> Tj ET',
    'BT /F2 10 Tf 72 690 Td [(\\001\\002\\003\\004) -300 (\\001\\002\\003\\004\\005\\006)] TJ ET',
    'BT /F2 10 Tf 72 678 Td (\\001\\002\\003\\004) Tj ET',
    'BT /F2 10 Tf 72 640 Td (\\001\\002) Tj ET',
  ].join('\n');
  const members = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>'],
    [5, '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Sans-Bold /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 8 0 R >>'],
    [6, '<< /Type /Font /Subtype /Type1 /BaseFont /Serif /FirstChar 1 /LastChar 6 /Widths [900 500 330 500 390 330] /Encoding << /Type /Encoding /Differences [1 /W /o /r /d /s /quoteright] >> >>'],
    [7, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Sans-Bold /DW 600 /W [1 [700 700 300]] >>'],
  ];
  let body = '', header = '';
  for (const [num, text] of members) { header += `${num} ${body.length} `; body += text + '\n'; }
  const objStm = zlib.deflateSync(Buffer.from(header + body));
  const parts = ['%PDF-1.7\n%\xe2\xe3\n'];
  const stream = (num, dict, data) => parts.push(Buffer.concat([Buffer.from(`${num} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream\nendobj\n')]));
  stream(4, '/Filter /FlateDecode', zlib.deflateSync(Buffer.from(content)));
  stream(8, '/Filter /FlateDecode', zlib.deflateSync(Buffer.from(cmap)));
  stream(9, `/Type /ObjStm /N ${members.length} /First ${header.length} /Filter /FlateDecode`, objStm);
  parts.push('10 0 obj\n<< /Type /XRef /Size 11 /Root 1 0 R /Length 0 >>\nstream\n\nendstream\nendobj\nstartxref\n0\n%%EOF\n');
  return Buffer.concat(parts.map(part => typeof part === 'string' ? Buffer.from(part, 'latin1') : part));
}
const plainPdf = (pageContent, trailer = '') => Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> endobj
5 0 obj << /Length ${pageContent.length} >>
stream
${pageContent}
endstream
endobj
trailer << /Root 1 0 R ${trailer} >>
%%EOF`, 'latin1');

/* ---------------------------------------------------------------- detection and plain formats */

test('formats are detected by extension, then by the first bytes and the MIME type', () => {
  assert.equal(detectFormat({ name: 'Report.PDF' }).format, 'pdf');
  assert.equal(detectFormat({ name: 'scan' }, Buffer.from('%PDF-1.7')).format, 'pdf', 'magic bytes win over a missing extension');
  assert.equal(detectFormat({ name: 'paper.docx' }, Buffer.from('%PDF-1.7')).format, 'pdf', 'a PDF saved with the wrong extension still reads as PDF');
  assert.equal(detectFormat({ name: 'a.docx' }).format, 'docx');
  assert.equal(detectFormat({ name: 'notes.markdown' }).format, 'markdown');
  assert.equal(detectFormat({ name: 'main.py' }).format, 'code');
  assert.equal(detectFormat({ name: 'Dockerfile' }).format, 'code');
  assert.equal(detectFormat({ name: 'photo' }, Uint8Array.of(0x89, 0x50, 0x4e, 0x47)).format, 'image');
  assert.equal(detectFormat({ name: 'unknown.bin' }, Buffer.from('PK\x03\x04')).format, 'zip');
  assert.equal(detectFormat({ name: 'x', type: 'text/plain' }).format, 'text');
  assert.match(detectFormat({ name: 'old.doc' }).error, /\.docx/);
  assert.match(detectFormat({ name: 'clip.mp4', type: 'video/mp4' }).error, /\/embed/);
  assert.match(detectFormat({ name: 'a.exe', type: 'application/octet-stream' }).error, /cannot be imported/);
  for (const ext of ['.pdf', '.docx', '.md', '.csv', '.pptx', '.xlsx', '.epub', '.png']) assert.ok(IMPORT_ACCEPT.split(',').includes(ext), ext);
});

test('Markdown is normalized to the syntax the note editor reads, leaving code fences alone', () => {
  const md = normalizeMarkdown('\ufeff---\ntitle: Plan\n---\nTitle\n=====\n\nIntro\n---\n\n#### Deep ####\n+ one\n  + two\n1) first\n\n\n\nSee [docs][d] and [spec][].\n\n[d]: https://example.com/d "Docs"\n[spec]: <https://example.com/s>\n```\n#### kept\n+ kept\n```\n<p align="center"><b>HTML</b> block</p>');
  assert.deepEqual(lines(md), ['```yaml', 'title: Plan', '```', '# Title', '', '## Intro', '', '### Deep', '- one', '  - two', '1. first', '',
    'See [docs](https://example.com/d) and [spec](https://example.com/s).', '', '```', '#### kept', '+ kept', '```', '**HTML** block']);
  assert.equal(normalizeMarkdown('- item\n---'), '- item\n---', 'a rule after a list item is not a setext heading');
});

test('imported and generated Markdown never brings embeds into a note', () => {
  assert.equal(withoutEmbeds('::embed[Site](https://evil.example)'), '[Site](https://evil.example)');
  assert.equal(withoutEmbeds('  ::embed[](https://x.example){height=900}'), '  [https://x.example](https://x.example)');
  assert.equal(withoutEmbeds('![[item-1|Report]]'), '[[item-1|Report]]');
  const md = normalizeMarkdown('::embed[Site](https://evil.example)\n![[secret]]\n```\n::embed[kept](https://code.example)\n```');
  assert.deepEqual(parseNoteBlocks(md).map(b => b.type), ['paragraph', 'paragraph', 'code']);
});

test('text files keep their wording literally; CSV, JSON and code become tables and code blocks', async () => {
  const text = await convert('notes.txt', '# not a heading\n- not a list *or emphasis*\n\nSecond paragraph\nwith a kept line break');
  assert.deepEqual(parseNoteBlocks(text.markdown).map(b => b.type), ['paragraph', 'paragraph']);
  assert.match(text.markdown, /^\\# not a heading\\\n\\- not a list \\\*or emphasis\\\*/);
  const csv = await convert('data.csv', 'name;qty;note\n"Widget; large";3;"two\nlines"\nGadget;5;"say ""hi"""\n');
  assert.equal(csv.markdown, '| name | qty | note |\n| --- | --- | --- |\n| Widget; large | 3 | two<br>lines |\n| Gadget | 5 | say "hi" |');
  assert.deepEqual(parseDelimited('a\tb\n1\t2\n', '\t'), [['a', 'b'], ['1', '2']]);
  const json = await convert('data.json', '{"a":[1,2]}');
  assert.equal(json.markdown, '```json\n{\n  "a": [\n    1,\n    2\n  ]\n}\n```');
  const code = await convert('app.ts', 'const a = "```";\n');
  assert.equal(code.markdown, '```typescript\nconst a = "```";\n```', 'only a line starting with backticks needs a longer fence');
  assert.equal((await convert('a.sh', '```\necho\n')).markdown, '````bash\n```\necho\n````');
});

test('text decoding honours BOMs and falls back to Windows-1252 with curly quotes intact', () => {
  assert.equal(decodeText(Uint8Array.of(0xef, 0xbb, 0xbf, 0x68, 0x69)), 'hi');
  assert.equal(decodeText(Uint8Array.of(0xff, 0xfe, 0x68, 0, 0x69, 0)), 'hi');
  assert.equal(decodeText(Uint8Array.of(0x93, 0x51, 0x94, 0x20, 0x96, 0x20, 0xe9)), '“Q” – é');
  assert.equal(cp1252(Uint8Array.of(0x80, 0x95, 0x41)), '€•A');
});

test('RTF keeps paragraphs, inline marks, links, bullets, headings, tables and code', async () => {
  const blocks = rtfToBlocks('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}{\\f1 Courier New;}}\\f0\\fs24 Hello {\\b bold} {\\field{\\*\\fldinst HYPERLINK "https://example.com"}{\\fldrslt site}} caf\\\'e9 \\u8364? end\\par\\bullet  Item\\par{\\f1 let x = 1;}\\par}');
  assert.deepEqual(blocks.map(b => b.type), ['p', 'li', 'code']);
  assert.equal(blocks[0].html, 'Hello <strong>bold</strong> <a href="https://example.com">site</a> café € end');
  const rich = await fixture('rich.rtf').then(convertFile);
  assert.ok(rich.markdown.includes('## Goals\n- Ship the import feature\n- Embed live sites\n  - Including PDFs\n1. First step'), rich.markdown);
  assert.ok(rich.markdown.includes('| Revenue | 10 | 12 |'));
  assert.ok(rich.markdown.includes('```\nconst x = 1; // code stays as-is\n#### not a heading\n```'));
});

/* ---------------------------------------------------------------- archives */

test('the ZIP reader handles stored and deflated entries and refuses damaged archives', async () => {
  const archive = readZip(zip([['a.txt', 'stored text', 0], ['dir/b.xml', '<b>deflated</b>'.repeat(50)]]));
  assert.deepEqual(archive.names, ['a.txt', 'dir/b.xml']);
  assert.equal(await archive.text('a.txt'), 'stored text');
  assert.equal(await archive.text('DIR/B.XML'), '<b>deflated</b>'.repeat(50), 'names also match case-insensitively');
  assert.equal(await archive.text('missing'), null);
  assert.throws(() => readZip(Buffer.from('not a zip at all, not even close')), /not a valid document archive/);
  await assert.rejects(inflate(Buffer.from('garbage'), 'deflate-raw'), /damaged/);
  await assert.rejects(inflate(zlib.deflateRawSync(Buffer.alloc(5000)), 'deflate-raw', 1000), /too large/);
});

test('the XML parser keeps prefixes, decodes entities and reads CDATA', () => {
  const root = parseXml('<?xml version="1.0"?><w:doc xmlns:w="x"><w:p w:val="a&amp;b"><w:t>1 &lt; 2 &#x263A;</w:t><![CDATA[<raw>]]></w:p><w:br/></w:doc>');
  const doc = children(root, 'w:doc')[0];
  assert.equal(attr(children(doc, 'p')[0], 'val'), 'a&b');
  assert.equal(textOf(doc), '1 < 2 ☺<raw>');
});

test('Word documents keep headings, nested lists, links, marks, tables and quotes', async () => {
  const result = await convertFile(await fixture('word.docx'));
  assert.equal(result.title, 'Import test document');
  assert.equal(result.markdown, [
    '# Import test document', '# Overview',
    'This paragraph has **bold**, *italic* and ~~struck~~ text, plus \\*asterisks\\* and # hashes that must stay literal.',
    'Read the [import guide](<https://example.com/guide>) for details.',
    '## Lists', '- First bullet', '  - Nested bullet', '- Second bullet', '1. Step one', '2. Step two', '### Data',
    '| Name | Role | Score |', '| --- | --- | --- |', '| Ada | Engineer | 98 |', '| Lin | Designer | 91 |',
    '> A memorable quotation.', 'Final paragraph after the table. Line one\\', 'Line two after a break.',
  ].join('\n'));
});

test('OpenDocument, PowerPoint, Excel and EPUB files convert to structured notes', async () => {
  const odt = await convertFile(await fixture('writer.odt'));
  assert.ok(odt.markdown.includes('# Quarterly planning notes\nIntro paragraph with **bold**, *italic*, ~~strike~~ and a [link](<https://example.com/docs>).'), odt.markdown);
  assert.ok(odt.markdown.includes('## Goals\n- Ship the import feature'), 'headings drop the italic their style adds');
  const deck = await convertFile(await fixture('deck.pptx'));
  assert.equal(deck.markdown, '## Roadmap\n- Import files\n  - PDF and Word\n- Embed sites\n> *Speaker notes:* Mention the AI tidy option.\n## Thanks\nQuestions?');
  const sheet = await convertFile(await fixture('budget.xlsx'));
  assert.equal(sheet.markdown, '## Budget\n| Item | Cost | Due |\n| --- | --- | --- |\n| Laptop | 1299.5 | 2026-11-03 |\n| Desk | 350 | 2026-12-01 |\n## Notes\n| Remember |  |\n| --- | --- |\n|  | Sparse cell |');
  const book = await convertFile(await fixture('book.epub'));
  assert.equal(book.title, 'Pandoc book');
  assert.ok(book.markdown.includes('| Revenue | 10 | 12 |'));
  assert.ok(parseNoteBlocks(book.markdown).every(b => b.type !== 'embed'), 'embed syntax in a document stays text');
  const lure = await convert('lure.html', '<p>::embed[x](https://evil.example)</p><p>![[item-1]]</p>');
  assert.deepEqual(parseNoteBlocks(lure.markdown).map(b => b.type), ['paragraph', 'paragraph']);
  assert.equal(lure.markdown, '::embed\\[x](https://evil.example)\n!\\[\\[item-1]]', 'inline escaping already keeps the syntax from matching');
  const html = await convert('page.html', '<html><head><title>A &amp; B</title></head><body><nav>Menu</nav><h1>Hi</h1><p>Text <a href="javascript:x">bad</a></p><footer>c</footer></body></html>');
  assert.equal(html.title, 'A & B');
  assert.equal(html.markdown, '# Hi\nText bad');
});

/* ---------------------------------------------------------------- PDF */

test('PDF objects parse references, names, strings and nested containers', () => {
  const [value] = parseValue('<< /A 12 0 R /B [1 (x\\) \\101) <4142>] /C#20D /N >>', 0);
  assert.deepEqual(value.get('A'), { ref: 12, gen: 0 });
  assert.deepEqual(value.get('B'), [1, { s: 'x) A' }, { s: 'AB' }]);
  assert.equal(value.get('C D'), '/N');
  assert.deepEqual(parseValue('0 0 RG', 0, { refs: true })[0], 0, 'an RG operator is not a reference');
  const cmap = parseCMap('1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <41> <43> <0061> endbfrange 1 beginbfchar <44> <D83DDE00> endbfchar');
  assert.equal(cmap.map.get('B'), 'b');
  assert.equal(cmap.map.get('D'), '😀');
  assert.equal(glyphToUnicode('eacute'), 'é');
  assert.equal(glyphToUnicode('uni20AC'), '€');
  assert.equal(glyphToUnicode('f_f_i'), 'ffi');
  assert.equal(glyphToUnicode('a.sc'), 'a');
});

test('PDFs with object streams, CID fonts and kerned spacing become headings and paragraphs', async () => {
  const result = await convert('built.pdf', objectStreamPdf());
  assert.equal(result.needsAi, null);
  assert.equal(result.pages, 1);
  assert.equal(result.markdown, '## HIJ fi\nWord Words’ Word\nWo');
});

test('real PDFs keep reading order, headings, lists, tables and typography', async () => {
  const office = await convertFile(await fixture('libreoffice.pdf'));
  assert.equal(office.markdown, [
    '# Import test document', '## Overview',
    'This paragraph has **bold**, *italic* and struck text, plus \\*asterisks\\* and # hashes that must stay literal.', 'Read the import guide for details.',
    '### Lists', '- First bullet', '  - Nested bullet', '- Second bullet', '1. Step one', '2. Step two', '### Data',
    '| Name | Role | Score |', '| --- | --- | --- |', '| Ada | Engineer | 98 |', '| Lin | Designer | 91 |', '',
    '*A memorable quotation.*', 'Final paragraph after the table. Line one Line two after a break.',
  ].join('\n'));
  const report = await convertFile(await fixture('reportlab.pdf'));
  assert.equal(report.pages, 2);
  assert.deepEqual(parseNoteBlocks(report.markdown).map(b => b.type), ['h1', 'h1', 'paragraph', 'paragraph', 'paragraph', 'h2', 'bullet', 'bullet', 'h1', 'paragraph']);
  assert.match(report.markdown, /“smart quotes” – dashes too\.\n/);
  const chrome = await convertFile(await fixture('chromium.pdf'));
  assert.match(chrome.markdown, /^# Printed from Chromium$/m);
  assert.match(chrome.markdown, /A paragraph with \*\*bold\*\* and a link\. It is long enough/);
  assert.match(chrome.markdown, /Ligatures: office, efficient, affluent\. Unicode: café, naïve, 日本語\./);
  assert.match(chrome.markdown, /^1\. One\n2\. Two$/m);
});

test('PDFs without a text layer or with encryption ask for AI instead of guessing', async () => {
  const scanned = await convert('scan.pdf', plainPdf('q 100 0 0 100 0 0 cm 0 0 1 1 re f Q'));
  assert.deepEqual(scanned.needsAi, { kind: 'pdf', reason: 'scanned', mediaType: 'application/pdf' });
  assert.ok(scanned.bytes?.length, 'the original bytes come back for the AI reader');
  const locked = await convert('locked.pdf', plainPdf('BT /F1 12 Tf 72 700 Td (Secret) Tj ET', '/Encrypt 9 0 R'));
  assert.equal(locked.needsAi.reason, 'encrypted');
  const ok = await convert('ok.pdf', plainPdf('BT /F1 12 Tf 72 700 Td (Fine text that is long enough to count as a page of text.) Tj ET'));
  assert.equal(ok.markdown, 'Fine text that is long enough to count as a page of text.');
  await assert.rejects(convert('fake.pdf', 'hello'), /not a PDF/);
  const pdf = await extractPdf(objectStreamPdf());
  assert.equal(pdf.blocks[0].type, 'h');
});

/* ---------------------------------------------------------------- limits and helpers */

test('images need AI, oversized and unsupported files are refused with guidance', async () => {
  const image = await convert('photo.jpg', Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg');
  assert.deepEqual(image.needsAi, { kind: 'image', reason: 'image', mediaType: 'image/jpeg' });
  await assert.rejects(convertFile({ name: 'big.pdf', size: MAX_IMPORT_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) }), /over 50 MB/);
  await assert.rejects(convert('legacy.doc', 'x'), /Save it as \.docx/);
  await assert.rejects(convert('archive.zip', zip([['readme.txt', 'x']])), /Unzip/);
  const empty = await convert('empty.md', '   ');
  assert.deepEqual(empty.warnings, ['No text was found in this file.']);
});

test('long imports are cut at a line break with a warning; titles come from a leading heading', () => {
  const long = 'line\n'.repeat(10);
  assert.deepEqual(clampMarkdown(long, 12), { markdown: 'line\nline', truncated: true });
  assert.equal(clampMarkdown('short', 12).truncated, false);
  assert.equal(leadingTitle('\n# My \\*Plan\\*\nBody'), 'My Plan');
  assert.equal(leadingTitle('Body\n# Later'), '');
  assert.equal(baseName('Q3_report.final.pdf'), 'Q3 report.final');
});

test('import blocks build list nesting, tasks and tables as HTML the editor converts', () => {
  const html = blocksToHtml([
    { type: 'li', ordered: false, level: 0, html: 'a' }, { type: 'li', ordered: true, level: 1, html: 'b', start: 3 }, { type: 'li', ordered: false, level: 0, html: 'c', checked: true },
    { type: 'table', rows: [['h1', 'h2'], ['x']] }, { type: 'p', html: '' },
  ]);
  assert.equal(html, '<ul><li>a</li><ol start="3"><li>b</li></ol><li><input type="checkbox" checked>c</li></ul><table><tr><th>h1</th><th>h2</th></tr><tr><td>x</td><td></td></tr></table>');
  assert.equal(inline([{ text: 'a', bold: true }, { text: 'b', bold: true, href: 'https://x.example' }, { text: '<c>', href: 'javascript:alert(1)' }]), '<strong>a</strong><a href="https://x.example"><strong>b</strong></a>&lt;c&gt;');
});
