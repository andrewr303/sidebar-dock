// File import and embeds for the note editor (/import and /embed in the slash menu).
//
// Import turns files into note blocks: lib/import converts on this device, and ctx.ai.importDocument either tidies the
// result with the provider's fast model at low effort ('tidy') or leaves it as converted ('exact'); scanned PDFs and
// images are read by the model in both modes. Nothing is attached: only the converted text reaches the note.
//
// Embed shows a live page, video, design or PDF inside the note (::embed[Label](url)), or an uploaded file saved to the
// library (![[id|Name]]). itemEmbedMount(ctx) renders those library files inside the block editor.
import { html, raw, cx, plural } from './html.js';
import { icon } from './icons.js';
import { registerDialog } from './overlay.js';
import { registerActions, hasAction } from './runtime.js';
import { button, iconButton, dialogFrame, spinner, fileSize, segmented } from './components.js';
import { convertFile, detectFormat, extensionOf, baseName, leadingTitle, IMPORT_ACCEPT, IMPORT_FORMATS, MAX_IMPORT_FILES, MAX_IMPORT_BYTES } from '../lib/import/index.js';
import { htmlToMarkdown } from '../lib/block-editor.js';
import { describeEmbed, embedKindLabel } from '../lib/embeds.js';

const MODE_KEY = 'still.import.mode.v1';
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const megabytes = bytes => `${Math.round(bytes / 1048576)} MB`;
const UPLOAD_ACCEPT = 'application/pdf,.pdf,image/*,video/*,audio/*';
const storage = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let job = null;     // the open import: { files, mode, target, running, controller, dragging, host }
let embed = null;   // the open embed dialog: { tab, url, label, error, saving, dragging, host }
let seq = 0;
let frame = 0;

/* ------------------------------------------------------------------ pure helpers (unit-tested) */

/**
 * The editor Markdown for finished imports: one file as is; several one after another, each under a heading named after
 * the file unless it already opens with a title of its own.
 */
export function combineImports(results) {
  const done = (results || []).filter(entry => entry && String(entry.markdown || '').trim());
  if (done.length <= 1) return done[0]?.markdown.trim() || '';
  return done.map(entry => {
    const markdown = entry.markdown.trim();
    return leadingTitle(markdown) ? markdown : `${htmlToMarkdown(`<h2>${esc(entry.heading || baseName(entry.name))}</h2>`)}\n${markdown}`;
  }).join('\n');
}

/** A note title for a single import into an untitled note: the document's own leading heading, its metadata title or the file name. */
export function importTitle({ markdown = '', title = '', name = '' } = {}) {
  return leadingTitle(markdown) || String(title || '').trim() || baseName(name);
}

/** What one file row says while it waits, works or finishes. */
export function fileStatus(entry, target) {
  const model = target?.modelLabel || 'AI';
  if (entry.status === 'reading') return 'Converting…';
  if (entry.status === 'ai') {
    const p = entry.progress || {};
    if (p.phase === 'read') return `Reading with ${model}${p.chars ? ` · ${plural(p.chars, 'character')}` : ''}…`;
    return `Tidying with ${model}${p.total > 1 ? ` · part ${Math.min(p.done + 1, p.total)} of ${p.total}` : ''}…`;
  }
  if (entry.status === 'done') return [entry.warnings?.[0], `${plural(entry.words || 0, 'word')} ready`].filter(Boolean).join(' · ');
  if (entry.status === 'error') return entry.message || 'This file could not be imported.';
  return [entry.label, fileSize(entry.size), entry.needsAi ? 'read by AI' : ''].filter(Boolean).join(' · ');
}

const PDF_IMAGE_TOKEN = /^!\[([^\n]*)\]\(pdf-image:\/\/(\d+)\)\s*$/gm;
const words = text => (String(text || '').replace(PDF_IMAGE_TOKEN, '').replace(/^!\[\[[^\n]+\]\]\s*$/gm, '').match(/[\p{L}\p{N}]+/gu) || []).length;
const isEmbeddable = file => /^(image|video|audio)\//.test(file?.type || '') || file?.type === 'application/pdf' || extensionOf(file?.name) === 'pdf';

/**
 * Saves extracted PDF images to the library as image items and replaces `![Label](pdf-image://k)` placeholders
 * in `markdown` with `![[itemId|Label]]` library embeds.
 */
export async function attachImportImages(ctx, converted, markdown, { collectionId = '', rememberItem, signal } = {}) {
  const list = converted?.images;
  const source = String(markdown ?? '');
  if (!Array.isArray(list) || !list.length || !source.includes('pdf-image://') || !ctx?.store?.saveAttachment) return source;
  const savedByIndex = new Map();
  const needed = new Set();
  for (const m of source.matchAll(PDF_IMAGE_TOKEN)) needed.add(Number(m[2]));
  const base = (baseName(converted?.name || '') || 'image').replace(/\s+/g, '-');
  for (const index of needed) {
    if (signal?.aborted) break;
    const img = list[index];
    const bytes = img?.data || img?.bytes;
    if (!bytes?.length) continue;
    try {
      const mime = img.mime || 'image/png';
      const name = img.name || `${base}-image-${index + 1}.${img.ext || (mime === 'image/jpeg' ? 'jpg' : 'png')}`;
      const file = typeof File === 'function' ? new File([bytes], name, { type: mime }) : Object.assign(new Blob([bytes], { type: mime }), { name });
      const item = await saveFileItem(ctx, file, collectionId);
      rememberItem?.(item);
      savedByIndex.set(index, { item, label: img.label || item.title || name });
    } catch { /* keep the rest of the import if an image cannot be saved */ }
  }
  return source.replace(PDF_IMAGE_TOKEN, (_, label, idx) => {
    const entry = savedByIndex.get(Number(idx));
    if (!entry) return '';
    const text = (label || entry.label || entry.item.title || '').replace(/[\[\]|]/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? `![[${entry.item.id}|${text}]]` : `![[${entry.item.id}]]`;
  }).replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------------ import dialog */

/**
 * openImport(ctx, { files, noteTitle, collectionId, rememberItem, insert(markdown, { title }), embedFile(file) })
 * insert receives the combined Markdown and, for a single file, a suggested note title.
 */
export function openImport(ctx, { files = [], noteTitle = '', collectionId = '', rememberItem, insert, embedFile } = {}) {
  if (job?.running) return;
  ensureDropListeners(ctx);
  const saved = storage()?.getItem(MODE_KEY);
  job = { files: [], mode: saved === 'exact' ? 'exact' : 'tidy', modeChosen: saved === 'exact' || saved === 'tidy', target: undefined, running: false, controller: null, dragging: false, notice: '',
    host: { noteTitle, collectionId, rememberItem, insert, embedFile } };
  addFiles(ctx, files);
  ctx.openDialog('note.import', { size: 'md', onClose: () => { job?.controller?.abort(); job = null; } });
  loadTarget(ctx);
}

async function loadTarget(ctx) {
  const current = job;
  let target = null;
  try { target = typeof ctx.ai?.importTarget === 'function' ? await ctx.ai.importTarget() : null; } catch { target = null; }
  if (job !== current) return;
  job.target = target;
  if (!target && !job.modeChosen) job.mode = 'exact';
  ctx.render();
}

function addFiles(ctx, list) {
  if (!job || job.running) return;
  const incoming = [...(list || [])].filter(file => file && typeof file === 'object');
  const room = MAX_IMPORT_FILES - job.files.length;
  if (incoming.length > room) job.notice = `You can import up to ${MAX_IMPORT_FILES} files at a time.`;
  for (const file of incoming.slice(0, Math.max(0, room))) {
    const { format, error } = detectFormat(file);
    const tooBig = file.size > MAX_IMPORT_BYTES;
    job.files.push({
      key: `f${++seq}`, file, name: file.name || 'Untitled file', size: file.size || 0, format,
      label: IMPORT_FORMATS[format]?.label || (format === 'zip' ? 'Archive' : extensionOf(file.name).toUpperCase() || 'File'),
      needsAi: format === 'image', status: error || tooBig ? 'error' : 'ready',
      message: tooBig ? `Over ${megabytes(MAX_IMPORT_BYTES)}. Choose a smaller file.` : error || '',
    });
  }
  ctx.render();
}

function scheduleRender(ctx) {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; ctx.render(); });
}

const importable = j => j.files.filter(entry => entry.status === 'ready' || (entry.status === 'error' && !entry.blocked));

function renderImport(ctx) {
  const j = job;
  if (!j) return '';
  const target = j.target;
  const ready = importable(j);
  const done = j.files.filter(entry => entry.status === 'done');
  const finished = !j.running && done.length > 0 && j.files.some(entry => entry.status === 'error');
  const needsSettings = !target && target !== undefined && (j.files.some(entry => entry.needsAi || entry.code === 'needs_ai'));
  const single = j.files.length === 1 && !j.running && j.files[0].status === 'ready' && isEmbeddable(j.files[0].file) && typeof j.host.embedFile === 'function';
  const modeCard = (value, iconName, title, desc, disabled) => html`<button type="button" role="radio" class="${cx('import-mode', j.mode === value && 'is-selected')}" aria-checked="${j.mode === value ? 'true' : 'false'}"
      tabindex="${j.mode === value ? '0' : '-1'}" data-action="import.mode" data-value="${value}" ${disabled ? raw('aria-disabled="true"') : ''}>
      <span class="import-mode-icon" aria-hidden="true">${icon(iconName, { size: 16 })}</span>
      <span class="import-mode-text"><span class="import-mode-title">${title}</span><span class="import-mode-desc">${desc}</span></span>
      <span class="import-mode-check" aria-hidden="true">${icon('check', { size: 14 })}</span></button>`;
  const model = target === undefined ? html`<p class="import-model">${spinner({ size: 12 })}<span>Checking your AI connection…</span></p>`
    : target ? html`<p class="import-model">${icon('sparkles', { size: 14 })}<span>AI steps use <strong>${target.modelLabel}</strong>${target.providerName ? html` from ${target.providerName}` : ''} at low effort.</span>
        <button type="button" class="import-link" data-action="import.settings">Change</button></p>`
      : html`<p class="import-model is-off">${icon('plug', { size: 14 })}<span>Connect an AI model to tidy imports and to read scanned PDFs and images.</span>
        <button type="button" class="import-link" data-action="import.settings">AI settings</button></p>`;
  const rows = j.files.length ? html`<ul class="import-files" aria-label="Files to import" aria-live="polite">${j.files.map(entry => html`<li class="import-file" data-status="${entry.status}" data-key="${entry.key}">
      <span class="import-file-icon" aria-hidden="true">${icon(entry.format === 'image' ? 'image' : entry.format === 'pdf' ? 'file-text' : ['xlsx', 'csv', 'tsv'].includes(entry.format) ? 'table' : entry.format === 'pptx' ? 'presentation' : entry.format === 'code' || entry.format === 'json' ? 'code' : 'file', { size: 16 })}</span>
      <span class="import-file-text"><span class="import-file-name">${entry.name}</span><span class="import-file-meta">${fileStatus(entry, target)}</span></span>
      <span class="import-file-state">${entry.status === 'reading' || entry.status === 'ai' ? spinner({ size: 14 }) : entry.status === 'done' ? icon('circle-check', { size: 16 }) : entry.status === 'error' ? icon('circle-alert', { size: 16 }) : ''}</span>
      ${j.running || entry.status === 'done' ? '' : iconButton({ icon: 'x', label: `Remove ${entry.name}`, action: 'import.remove', data: { key: entry.key }, size: 'sm', className: 'import-file-remove' })}
    </li>`)}</ul>` : '';
  let footer;
  if (j.running) footer = html`<span class="import-foot-note">${spinner({ size: 14 })}<span>Importing… you can keep this open or stop.</span></span>${button({ label: 'Stop', icon: 'circle-stop', variant: 'secondary', action: 'import.stop' })}`;
  else if (finished) footer = html`${button({ label: 'Close', variant: 'secondary', action: 'overlay.dismiss' })}${ready.length ? button({ label: 'Try again', icon: 'refresh-cw', variant: 'secondary', action: 'import.run' }) : ''}
      ${button({ label: `Insert ${plural(done.length, 'file')}`, variant: 'primary', action: 'import.insert' })}`;
  else footer = html`${single ? button({ label: 'Embed the file instead', icon: 'app-window', variant: 'ghost', action: 'import.embed-instead', className: 'import-foot-start' }) : ''}
      ${button({ label: 'Cancel', variant: 'secondary', action: 'overlay.dismiss' })}
      ${button({ label: ready.length > 1 ? `Import ${ready.length} files` : 'Import', variant: 'primary', action: 'import.run', disabled: !ready.length })}`;
  return html`<div class="import-dialog-inner">
    ${iconButton({ icon: 'x', label: 'Close', action: 'overlay.dismiss', size: 'sm', className: 'dialog-close import-close' })}
    <header class="import-head">
      <span class="import-head-icon" aria-hidden="true">${icon('file-down', { size: 22 })}</span>
      <h2 class="dialog-title" id="dialog-title-note.import">Import files</h2>
      <p class="import-head-sub">Bring PDFs, Word documents, Markdown and more into ${j.host.noteTitle ? html`<strong>${j.host.noteTitle}</strong>` : 'this note'} as editable blocks. The original file is not attached.</p>
    </header>
    <div class="dialog-body import-body">
      ${j.running ? '' : html`<div class="${cx('import-drop', j.dragging && 'is-dragging')}" data-import-drop>
        <input type="file" multiple class="sr-only" id="import-file-input" tabindex="-1" aria-hidden="true" accept="${IMPORT_ACCEPT}" data-change="import.picked">
        <span class="import-drop-icon" aria-hidden="true">${icon('cloud-upload', { size: 26 })}</span>
        <p class="import-drop-title">Import into this note</p>
        <p class="import-drop-line">Drag and drop files or <button type="button" class="import-link" data-action="import.choose" ${j.files.length ? '' : raw('data-autofocus')}>choose files</button></p>
        <p class="import-drop-limits">PDF, Word, PowerPoint, Excel, Markdown, text, HTML, CSV, EPUB, RTF and images<br>Up to ${megabytes(MAX_IMPORT_BYTES)} each · ${MAX_IMPORT_FILES} files at a time</p>
      </div>`}
      ${j.notice ? html`<p class="import-notice" role="status">${j.notice}</p>` : ''}
      ${rows}
      <div class="import-modes" role="radiogroup" aria-label="How to format the import">
        ${modeCard('tidy', 'wand-sparkles', 'Tidy with AI', 'Fixes headings, lists, tables and broken lines. Keeps your wording.', !target || j.running)}
        ${modeCard('exact', 'file-text', 'Keep the original', 'Converted on this device, exactly as written.', j.running)}
      </div>
      ${model}
      ${needsSettings ? html`<p class="import-notice">${icon('circle-alert', { size: 14 })}<span>Images and scanned PDFs have no text to convert, so they need an AI model.</span></p>` : ''}
    </div>
    <div class="dialog-footer import-foot">${footer}</div>
  </div>`;
}

async function runImport(ctx) {
  const j = job;
  if (!j || j.running) return;
  const queue = importable(j);
  if (!queue.length) return;
  // Chrome asks for access to the provider only inside a user gesture, so this runs before the first await.
  if (j.target?.via === 'direct' && typeof ctx.ai?.ensureHostPermission === 'function' && (j.mode === 'tidy' || queue.some(entry => entry.needsAi))) {
    try { ctx.ai.ensureHostPermission({ providerId: j.target.providerId, baseUrl: j.target.baseUrl })?.catch?.(() => {}); } catch { /* reported by the request itself */ }
  }
  j.running = true;
  j.notice = '';
  j.controller = new AbortController();
  const { signal } = j.controller;
  for (const entry of queue) Object.assign(entry, { status: 'ready', message: '', code: '', progress: null });
  ctx.render();
  for (const entry of queue) {
    if (signal.aborted || job !== j) break;
    entry.status = 'reading';
    ctx.render();
    try {
      const converted = await convertFile(entry.file, { signal });
      entry.needsAi = !!converted.needsAi;
      const finish = typeof ctx.ai?.importDocument === 'function'
        ? ctx.ai.importDocument(converted, { mode: j.mode, signal, onProgress: progress => { if (job !== j) return; entry.status = 'ai'; entry.progress = progress; scheduleRender(ctx); } })
        : converted.needsAi ? Promise.reject(new Error('Reading this file needs an AI model. Connect one in Settings.')) : Promise.resolve({ markdown: converted.markdown, warnings: [], ai: null });
      const result = await finish;
      if (signal.aborted) break;
      const markdown = (await attachImportImages(ctx, converted, result.markdown, { collectionId: j.host.collectionId, rememberItem: j.host.rememberItem, signal })).trim();
      if (signal.aborted) break;
      Object.assign(entry, { result: { markdown, title: converted.title }, warnings: [...converted.warnings, ...(result.warnings || [])], words: words(markdown) });
      if (markdown) entry.status = 'done';
      else Object.assign(entry, { status: 'error', message: entry.warnings[0] || 'No text was found in this file.' });
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError' || error?.code === 'aborted') { entry.status = 'ready'; break; }
      Object.assign(entry, { status: 'error', message: error?.message || 'This file could not be imported.', code: error?.code || '', blocked: ['unsupported', 'too_large', 'encrypted', 'unreadable', 'damaged', 'needs_ai'].includes(error?.code) });
    }
    ctx.render();
  }
  if (job !== j) return;
  j.running = false;
  j.controller = null;
  if (signal.aborted) { for (const entry of j.files) if (entry.status === 'reading' || entry.status === 'ai') entry.status = 'ready'; ctx.render(); return; }
  if (j.files.some(entry => entry.status === 'done') && !j.files.some(entry => entry.status === 'error' || entry.status === 'ready')) insertResults(ctx);
  else ctx.render();
}

function insertResults(ctx) {
  const j = job;
  if (!j) return;
  const done = j.files.filter(entry => entry.status === 'done');
  if (!done.length) return;
  const markdown = combineImports(done.map(entry => ({ name: entry.name, markdown: entry.result.markdown, heading: entry.result.title })));
  const title = done.length === 1 ? importTitle({ markdown: done[0].result.markdown, title: done[0].result.title, name: done[0].name }) : '';
  const warnings = done.flatMap(entry => (entry.warnings || []).map(text => done.length > 1 ? `${entry.name}: ${text}` : text));
  const insert = j.host.insert;
  ctx.closeDialog('note.import');
  insert?.(markdown, { title });
  ctx.toast(warnings.length ? `Imported ${plural(done.length, 'file')}. ${warnings[0]}` : `Imported ${plural(done.length, 'file')}`, { tone: warnings.length ? 'default' : 'success', duration: warnings.length ? 7000 : 4000 });
}

function openAiSettings(ctx) {
  ctx.closeDialog('note.import');
  if (hasAction('shell.settings')) { ctx.dispatch('shell.settings', { data: { section: 'ai' } }); return; }
  import('./settings.js').then(module => module.openSettings?.(ctx, 'ai')).catch(() => {});
}

registerDialog('note.import', ctx => renderImport(ctx), {
  size: 'md', className: 'import-dialog',
  beforeClose: () => { if (job?.running) { job.controller?.abort(); } return true; },
});

/* ------------------------------------------------------------------ embed dialog */

/** openEmbed(ctx, { embed(spec), collectionId, tab }) — spec is { url, label } or { target, label, item } (item: the saved upload). */
export function openEmbed(ctx, { embed: insert, collectionId = '', tab = 'link' } = {}) {
  ensureDropListeners(ctx);
  embed = { tab: tab === 'upload' ? 'upload' : 'link', url: '', label: '', error: '', saving: false, dragging: false, host: { insert, collectionId } };
  ctx.openDialog('note.embed', { size: 'sm', onClose: () => { embed = null; } });
}

function renderEmbed(ctx) {
  const e = embed;
  if (!e) return '';
  const info = e.url.trim() ? describeEmbed(e.url) : null;
  const preview = !e.url.trim() ? html`<p class="embed-hint">Works with YouTube, Vimeo, Loom, Figma, Google Docs, Sheets, Slides and Maps, CodePen, Spotify, Miro, PDFs and most web pages.</p>`
    : !info ? html`<p class="embed-preview is-error" role="alert">${icon('circle-alert', { size: 14 })}<span>Enter a web address, such as https://example.com.</span></p>`
      : html`<div class="embed-preview" role="status">${icon(info.kind === 'video' ? 'video' : info.kind === 'pdf' ? 'file-text' : 'globe', { size: 16 })}
        <span><strong>${info.kind === 'site' ? info.host : `${info.provider} ${embedKindLabel(info.kind).toLowerCase()}`}</strong>
        <span class="embed-preview-meta">${!info.src ? 'Only secure (https) pages can be shown inside a note; it will be saved as an embed you can open.'
          : info.kind === 'site' ? 'Shows the live page. Some sites refuse to appear inside other pages; you can always open it from the note.'
            : info.kind === 'pdf' ? 'Opens in the browser’s PDF viewer inside the note.' : 'Plays inside the note.'}</span></span></div>`;
  const body = html`${segmented({ value: e.tab, options: [{ value: 'link', label: 'Link', icon: 'link' }, { value: 'upload', label: 'Upload', icon: 'upload' }], action: 'embed.tab', ariaLabel: 'Embed from', className: 'embed-tabs' })}
    ${e.tab === 'link' ? html`<form class="embed-form" data-submit="embed.submit" id="embed-form">
        <label class="field"><span class="field-label">Address</span>
          <input class="input" name="url" type="url" inputmode="url" value="${e.url}" placeholder="Paste a link to a page, video, design or PDF" autocomplete="off" spellcheck="false" data-input="embed.url" data-autofocus></label>
        ${preview}
      </form>`
      : html`<div class="${cx('import-drop', 'embed-drop', e.dragging && 'is-dragging')}" data-embed-drop aria-busy="${e.saving ? 'true' : 'false'}">
        <input type="file" class="sr-only" id="embed-file-input" tabindex="-1" aria-hidden="true" accept="${UPLOAD_ACCEPT}" data-change="embed.picked">
        <span class="import-drop-icon" aria-hidden="true">${e.saving ? spinner({ size: 22 }) : icon('cloud-upload', { size: 26 })}</span>
        <p class="import-drop-title">${e.saving ? 'Saving to your library…' : 'Embed a PDF, image or video'}</p>
        ${e.saving ? '' : html`<p class="import-drop-line">Drag and drop a file or <button type="button" class="import-link" data-action="embed.choose" data-autofocus>choose a file</button></p>`}
        <p class="import-drop-limits">The file is saved to your library, linked to this note and shown in place. Up to ${megabytes(MAX_UPLOAD_BYTES)}.</p>
      </div>`}
    ${e.error ? html`<p class="embed-preview is-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${e.error}</span></p>` : ''}`;
  const footer = html`${button({ label: 'Cancel', variant: 'secondary', action: 'overlay.dismiss' })}
    ${e.tab === 'link' ? button({ label: 'Embed link', variant: 'primary', type: 'submit', attrs: { form: 'embed-form' }, disabled: !info }) : ''}`;
  return dialogFrame({ name: 'note.embed', title: 'Embed', subtitle: 'Show a live page, video, design or PDF inside this note.', body, footer, className: 'embed-head' });
}

async function uploadEmbed(ctx, file) {
  const e = embed;
  if (!e || e.saving || !file) return;
  e.error = '';
  if (!isEmbeddable(file)) { e.error = 'Choose a PDF, image, video or audio file. To turn a document into text, use Import instead.'; ctx.render(); return; }
  if (file.size > MAX_UPLOAD_BYTES) { e.error = `This file is over ${megabytes(MAX_UPLOAD_BYTES)}.`; ctx.render(); return; }
  e.saving = true;
  ctx.render();
  try {
    const item = await saveFileItem(ctx, file, e.host.collectionId);
    if (embed !== e) return;
    const insert = e.host.insert;
    ctx.closeDialog('note.embed');
    insert?.({ target: item.id, label: item.title, item });
    ctx.toast(`Saved ${item.title} to your library and embedded it`, { tone: 'success' });
  } catch (error) {
    if (embed !== e) return;
    e.saving = false;
    e.error = error?.message || 'The file could not be saved.';
    ctx.render();
  }
}

/** Saves a file to the library as an image, video or file item with its bytes; returns the item. */
export async function saveFileItem(ctx, file, collectionId = '') {
  const attachment = await ctx.store.saveAttachment(file);
  try {
    const type = /^image\//.test(file.type) ? 'image' : /^video\//.test(file.type) ? 'video' : 'file';
    const target = collectionId && ctx.select.collection?.(collectionId) ? collectionId : '';
    return await ctx.store.saveItem({ type, title: file.name || 'Embedded file', ...attachment, collectionId: target });
  } catch (error) {
    await ctx.store.deleteAttachment(attachment.attachmentId).catch(() => {});
    throw error;
  }
}

registerDialog('note.embed', ctx => renderEmbed(ctx), { size: 'sm', className: 'embed-dialog' });

/* ------------------------------------------------------------------ library files inside embed blocks */

const isPdfBlob = async blob => (await blob.slice(0, 5).text()) === '%PDF-';

/**
 * mountEmbed for mountBlockEditor: shows a library item's file (PDF, image, video or audio) from this device.
 * lookup(id) finds the item, including one just saved that the library snapshot does not list yet.
 */
export function itemEmbedMount(ctx, { lookup = id => ctx.select.byId(id) } = {}) {
  return (box, { item }) => {
    const record = item?.id != null ? lookup(String(item.id)) : null;
    if (!record || record.deletedAt || !record.attachmentId) return null;
    const mime = record.mime || '';
    const media = mime === 'application/pdf' || /\.pdf$/i.test(record.fileName || '') ? 'pdf' : /^image\//.test(mime) ? 'image' : /^video\//.test(mime) ? 'video' : /^audio\//.test(mime) ? 'audio' : 'file';
    let url = '', gone = false;
    const say = text => { box.dataset.media = 'missing'; box.innerHTML = String(html`<p class="rich-embed-note">${text}</p>`); };
    box.dataset.media = media;
    box.innerHTML = String(html`<p class="rich-embed-note">${spinner({ size: 14 })}<span>Loading ${record.title}…</span></p>`);
    (async () => {
      if (media === 'file') { say('There is no preview for this kind of file. Open the item to download it.'); return; }
      const stored = await ctx.store.getAttachment(record.attachmentId);
      if (gone) return;
      if (!stored?.blob) { say('The original file is not on this device.'); return; }
      let element;
      if (media === 'pdf') {
        // Chrome shows PDFs only in unsandboxed frames, so the frame only ever gets a verified PDF blob.
        if (!(await isPdfBlob(stored.blob))) { say('This file is not a readable PDF. Open the item to download it.'); return; }
        element = Object.assign(document.createElement('iframe'), { title: record.title || 'PDF' });
        url = URL.createObjectURL(new Blob([stored.blob], { type: 'application/pdf' }));
      } else {
        element = document.createElement(media === 'image' ? 'img' : media);
        if (media === 'image') Object.assign(element, { alt: record.title || '', decoding: 'async' });
        else Object.assign(element, { controls: true, preload: 'metadata' });
        url = URL.createObjectURL(stored.blob);
      }
      if (gone) { URL.revokeObjectURL(url); url = ''; return; }
      element.src = url;
      box.replaceChildren(element);
    })().catch(() => { if (!gone) say('The file could not be shown.'); });
    return { destroy() { gone = true; if (url) URL.revokeObjectURL(url); url = ''; box.replaceChildren(); } };
  };
}

/* ------------------------------------------------------------------ actions and drops */

registerActions({
  'import.choose': () => document.getElementById('import-file-input')?.click(),
  'import.picked': ({ ctx, el }) => { const files = [...(el.files || [])]; el.value = ''; addFiles(ctx, files); },
  'import.remove': ({ ctx, data }) => {
    if (!job || job.running) return;
    job.files = job.files.filter(entry => entry.key !== data.key);
    job.notice = '';
    ctx.render();
    ctx.nextFrame?.(() => document.querySelector('.import-dialog [data-action="import.choose"]')?.focus());
  },
  'import.mode': ({ ctx, data }) => {
    if (!job || job.running || (data.value === 'tidy' && !job.target)) return;
    job.mode = data.value === 'exact' ? 'exact' : 'tidy';
    job.modeChosen = true;
    try { storage()?.setItem(MODE_KEY, job.mode); } catch { /* preference only */ }
    ctx.render();
  },
  'import.run': ({ ctx }) => runImport(ctx),
  'import.stop': ({ ctx }) => { job?.controller?.abort(); ctx.render(); },
  'import.insert': ({ ctx }) => insertResults(ctx),
  'import.settings': ({ ctx }) => openAiSettings(ctx),
  'import.embed-instead': ({ ctx }) => {
    const file = job?.files[0]?.file;
    const embedFile = job?.host.embedFile;
    if (!file || typeof embedFile !== 'function') return;
    ctx.closeDialog('note.import');
    embedFile(file);
  },
  'embed.tab': ({ ctx, data }) => { if (!embed || embed.saving) return; embed.tab = data.value === 'upload' ? 'upload' : 'link'; embed.error = ''; ctx.render(); },
  'embed.url': ({ ctx, el }) => { if (!embed) return; embed.url = el.value; embed.error = ''; ctx.render(); },
  'embed.submit': ({ ctx, el }) => {
    if (!embed) return;
    const url = String(new FormData(el).get('url') || embed.url).trim();
    const info = describeEmbed(url);
    if (!info) { embed.error = 'Enter a web address, such as https://example.com.'; ctx.render(); return; }
    const insert = embed.host.insert;
    ctx.closeDialog('note.embed');
    insert?.({ url: info.url, label: info.label });
  },
  'embed.choose': () => document.getElementById('embed-file-input')?.click(),
  'embed.picked': ({ ctx, el }) => { const file = el.files?.[0]; el.value = ''; uploadEmbed(ctx, file); },
});

let listening = false;
function ensureDropListeners(ctx) {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  const zone = event => event.target?.closest?.('[data-import-drop], [data-embed-drop]');
  const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  const state = el => el?.hasAttribute('data-import-drop') ? job : embed;
  document.addEventListener('dragover', event => {
    const el = zone(event);
    if (!el || !hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    const s = state(el);
    if (s && !s.dragging) { s.dragging = true; ctx.render(); }
  }, true);
  document.addEventListener('dragleave', event => {
    if (event.relatedTarget?.closest?.('[data-import-drop], [data-embed-drop]')) return;
    for (const s of [job, embed]) if (s?.dragging) { s.dragging = false; ctx.render(); }
  }, true);
  document.addEventListener('drop', event => {
    const el = zone(event);
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    const files = [...(event.dataTransfer?.files || [])];
    const s = state(el);
    if (s) s.dragging = false;
    if (el.hasAttribute('data-import-drop')) addFiles(ctx, files);
    else uploadEmbed(ctx, files[0]);
    ctx.render();
  }, true);
}
