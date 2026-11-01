# Importing files and embedding pages in notes

Two slash commands in the note editor bring outside material into a note: `/import` turns a file into editable blocks, and `/embed` shows a live page, video, design or PDF inside the note. Both are also in the note's **⋯** menu, and dropping files onto a note opens the import dialog with them.

## /import: files become blocks

Choose or drop up to **10 files at a time, 50 MB each**. Each file is converted into the note's own Markdown and inserted at the caret; nothing is attached and the original file is not stored. Importing into an empty, untitled note also gives the note the document's title.

| Format | Converted on this device |
| --- | --- |
| PDF | Text with headings (by font size, or short bold lines), paragraphs rejoined across lines and pages, bullets and numbered lists with nesting, tables from column-aligned rows, bold and italic, curly quotes and ligatures. Running headers, footers and page numbers are dropped. |
| Word (.docx), OpenDocument (.odt) | Headings, nested bullet and numbered lists, links, bold/italic/strikethrough, tables, quotes and code paragraphs. Images, comments, tracked deletions, headers and footers are left out. |
| PowerPoint (.pptx) | A heading per slide, its bullets and tables, and speaker notes as a quote. |
| Excel (.xlsx), CSV, TSV | A table per sheet (first 1,000 rows of a sheet, 2,000 rows of a CSV, 50 columns), with dates shown as dates. |
| Markdown, HTML, EPUB, RTF | Normalized to what the editor reads: deeper headings become `###`, setext headings and reference links are rewritten, front matter becomes a code block, HTML blocks and EPUB chapters go through the editor's HTML converter. |
| Text, JSON, code | Text keeps its exact wording and line breaks; JSON and source files become code blocks with their language. |
| Images (PNG, JPEG, WebP, GIF) | No text layer: read by AI (see below). |

Older `.doc`, `.xls` and `.ppt` files, Apple iWork files and archives are refused with a note on what to export instead.

### Keep the original or tidy with AI

- **Keep the original** converts on this device exactly as written. No AI is involved for files that have text.
- **Tidy with AI** sends the converted Markdown to a model with instructions to fix structure only: real headings, rebuilt lists and tables, rejoined lines, removed page artifacts. It must keep every piece of content and the author's wording; it may not summarize, translate, reorder or add anything. Structured data (CSV, TSV, Excel, JSON, code) is never sent for tidying.

Tidying uses the provider's **fast model at low effort**: the model set for quick tasks in AI settings, otherwise the provider's fastest model (Claude Haiku 5.5 for Anthropic, GPT-6 Luna for OpenAI, Gemini 3.5 Flash-Lite for Gemini, and so on). The dialog names the model before anything is sent.

Long documents are tidied in parts of about 12,000 characters, three at a time, and reassembled in order. A part that fails twice, or that comes back with less than half of its words, keeps its converted text and the import reports how many parts that affected. When every part fails the error is shown and nothing is inserted. A refused API key stops the import at once.

Small text PDFs (up to 20 pages and 10 MB) are tidied from the PDF itself when the provider reads PDF files, since tables and layout survive better that way; a thin answer falls back to tidying the extracted text.

### Scanned PDFs and images

A PDF without a text layer (or one whose fonts cannot be decoded) and an image have nothing to convert locally, so the model reads them in both modes: **Keep the original** asks for a faithful transcription, **Tidy with AI** for a structured note. PDFs are sent as files to Anthropic, OpenAI, Google Gemini and OpenRouter connections (at most 100 pages and 20 MB); images go to any image-capable connection. Encrypted PDFs are refused.

### What leaves the device

Nothing, for **Keep the original** on files with text. Tidying sends the converted text of that file to the connected provider; reading a scan or image sends the file itself. File content is marked as data in the prompt, and the model is told never to follow instructions inside it. Model output and imported Markdown both pass through the same normalization, which turns any embed syntax into plain links, so neither a file nor a model can add a live frame to a note.

## /embed: live content in a note

Paste an address, or upload a PDF, image, video or audio file.

- **Links** are stored as `::embed[Label](https://…)`, optionally followed by `{height=480}`. Share links from YouTube, Vimeo, Loom, Figma, Google Docs, Sheets, Slides, Forms, Drive and Maps, CodePen, CodeSandbox, Spotify, X, Miro and Airtable are switched to each provider's embed player. Addresses ending in `.pdf` open in the browser's PDF viewer. Anything else is framed as a web page.
- **Uploads** are saved to the library (in the note's collection, up to 100 MB), linked to the note and shown in place from this device. They are stored as Obsidian-style `![[item-id|Name]]`, so the file appears under the note's linked items and in backups.

Each embed has a header with its title and source, a height control (small, medium, large), **Show as a link** and **Open**. Click the header to select the block; Backspace or Delete removes it and Enter starts a new line below. Outside the editor, in previews, cards, exports and for AI and MCP clients, an embed reads as an ordinary link, and other Markdown tools show it as a link too.

### Limits

- Sites can refuse to appear inside other pages (`X-Frame-Options` or a CSP `frame-ancestors` rule); the browser then shows its own error inside the frame. Still does not strip those headers. Use **Open** for such sites.
- Web pages are framed in a sandbox (scripts, forms, popups and same-origin storage for that site, but no navigation of the note). PDFs are not sandboxed because Chrome runs its PDF viewer only in unsandboxed frames; uploaded PDFs are verified as PDFs before they are shown. Only `https` pages can be framed.
- Frames load only in the editor. Embedded pages are live: they show what the site serves now, not a copy.

## Code

- Converters: [`lib/import`](../extension/lib/import/) (`index.js` detects formats and normalizes Markdown; `pdf.js`, `office.js`, `zip.js` and `xml.js` need no dependencies). Tests: [`tests/import.test.mjs`](../tests/import.test.mjs) with real files from LibreOffice, Chromium, pandoc, python-docx, python-pptx, openpyxl and reportlab in [`tests/fixtures/import`](../tests/fixtures/import/).
- AI: [`lib/ai/imports.js`](../extension/lib/ai/imports.js), exposed as `importTarget()` and `importDocument()` on the AI facade. File parts (`{ type: 'document' }`) reach the Anthropic, OpenAI Responses, Gemini and OpenRouter transports.
- Embeds: [`lib/embeds.js`](../extension/lib/embeds.js) (provider rules), the `embed` block in [`lib/markdown.js`](../extension/lib/markdown.js) and [`lib/block-editor.js`](../extension/lib/block-editor.js), and the dialogs in [`ui/note-import.js`](../extension/ui/note-import.js).
