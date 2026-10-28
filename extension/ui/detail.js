// Item detail panel (full-tab right panel, side-panel screen): Details (cover, inline title and description, property
// rows for collection / tags / saved / reminder, personal note, highlights, linked notes, related and similar items,
// attached file with preview), Reader (saved page text with highlights painted in and a selection highlighter),
// Notes (notes about this item) and Ask (hands the item to the assistant).
import { html, raw, cx, safeHref, plural } from './html.js';
import { icon } from './icons.js';
import { button, iconButton, collectionIcon, favicon, relativeDate, shortDate, fileSize, emptyState, TYPE_LABELS, TYPE_ICONS } from './components.js';
import { registerActions, registerMount } from './runtime.js';
import { renderItem, renderItemLink, generatedArt, coverOf, readingMinutes, itemSource } from './cards.js';
import { pickCollection, parseTags, trashItems, setArchived, moveItems, addNoteFor, menuOpenFor } from './library.js';
import { renderInlineEditor } from './note-editor.js';
import { renderTagInput } from './pickers.js';
import { createNote, openNote } from './notes.js';
import { askAi } from './ai-panel.js';
import { renderMarkdown } from '../lib/markdown.js';
import { canonicalUrl } from '../lib/store.js';

const TABS = [
  { value: 'details', label: 'Details' },
  { value: 'reader', label: 'Reader' },
  { value: 'notes', label: 'Notes' },
];
const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'];
const COLOR_NAMES = { yellow: 'Yellow', green: 'Green', blue: 'Blue', pink: 'Pink', purple: 'Purple', amber: 'Amber', orange: 'Orange', red: 'Red', teal: 'Teal', gray: 'Gray' };
const READER_SIZES = [14, 15, 16, 18, 20];
const PREVIEW_IMAGE = /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/i;

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)

/** Highlight colors stored by older captures and Raindrop map onto the marker palette. */
export const highlightColor = color => COLOR_NAMES[color] ? color : 'yellow';

/**
 * Finds each highlight in a text, ignoring case and runs of whitespace (captured text and the page rarely agree on
 * line breaks). Returns [{ id, color, start, end }] in text order without overlaps; highlights that do not occur are skipped.
 */
export function findHighlightRanges(text, highlights = []) {
  const source = String(text || '');
  const chars = [];
  const index = [];
  let space = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      if (space) continue;
      chars.push(' '); index.push(i); space = true;
    } else {
      const lower = ch.toLowerCase();
      chars.push(lower.length === 1 ? lower : ch); index.push(i); space = false;
    }
  }
  const hay = chars.join('');
  const found = [];
  for (const highlight of highlights) {
    const needle = String(highlight?.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (needle.length < 2) continue;
    const at = hay.indexOf(needle);
    if (at < 0) continue;
    found.push({ id: highlight.id, color: highlightColor(highlight.color), start: index[at], end: index[at + needle.length - 1] + 1 });
  }
  found.sort((a, b) => a.start - b.start);
  const out = [];
  for (const range of found) if (!out.length || range.start >= out.at(-1).end) out.push(range);
  return out;
}

/** Captured page text is plain: one paragraph per line, blank lines dropped. Markdown files keep their markup. */
export function readerSource(text) {
  const source = String(text || '').replace(/\r\n?/g, '\n');
  if (/^(#{1,6} |\s*[-*+] |\s*\d+[.)] |>|```)|\*\*|\]\(/m.test(source)) return source;
  return source.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}

/** Quick reminder choices relative to now: later today (3 hours, on the hour), tomorrow 9:00, next Monday 9:00. */
export function reminderPresets(now = new Date()) {
  const later = new Date(now);
  later.setMinutes(0, 0, 0);
  later.setHours(later.getHours() + 3);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((8 - now.getDay()) % 7 || 7), 9, 0, 0, 0);
  const out = [];
  if (later.getDate() === now.getDate()) out.push({ id: 'later', label: 'Later today', iso: later.toISOString() });
  out.push({ id: 'tomorrow', label: 'Tomorrow morning', iso: tomorrow.toISOString() });
  out.push({ id: 'next-week', label: 'Next week', iso: monday.toISOString() });
  return out;
}

/** "Today, 9:00 AM", "Tomorrow, 9:00 AM" or "Mon, Nov 2, 9:00 AM". */
export function reminderLabel(iso, now = new Date(), locale) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(date) - day(now)) / 86400000);
  if (diff === 0) return `Today, ${time}`;
  if (diff === 1) return `Tomorrow, ${time}`;
  if (diff === -1) return `Yesterday, ${time}`;
  return `${date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })}, ${time}`;
}

// ---------------------------------------------------------------------------------------------------------------
// State and data

const detailState = ctx => ctx.state.detail ||= { addingTag: null, similar: {}, readerSize: 1 };
const safe = fn => { try { return fn(); } catch { return undefined; } };
const canonical = url => safe(() => canonicalUrl(url)) || '';
const fullDate = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const sentence = text => text === 'Just now' ? 'just now' : text;
const prettyUrl = url => { try { const u = new URL(url); return u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : decodeURI(u.pathname)); } catch { return url; } };

function linkedNotes(ctx, item) {
  const out = new Map();
  if (item.url) for (const note of ctx.select.notesForUrl(item.url)) if (note.id !== item.id) out.set(note.id, note);
  for (const back of ctx.select.backlinks(item.id)) if (back.type === 'note' && !back.archived) out.set(back.id, back);
  for (const id of item.relatedIds || []) { const note = ctx.select.byId(id); if (note?.type === 'note' && !note.deletedAt) out.set(note.id, note); }
  return [...out.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function similarFor(ctx, item) {
  const ai = ctx.ai;
  if (typeof ai?.relatedItems !== 'function' || !safe(() => ai.getIndexStatus?.())?.enabled) return null;
  const d = detailState(ctx);
  const entry = d.similar[item.id];
  if (!entry || entry.stamp !== item.updatedAt) {
    const next = { stamp: item.updatedAt, status: 'loading', items: [] };
    d.similar[item.id] = next;
    Promise.resolve().then(() => ai.relatedItems(item.id, { limit: 6 })).then(results => {
      next.items = Array.isArray(results) ? results : [];
      next.status = 'done';
    }, () => { next.status = 'error'; }).finally(() => ctx.render());
    return next;
  }
  return entry;
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

function renderTabs(ctx, item, tab, notesCount) {
  const tabs = TABS.filter(t => t.value !== 'reader' || item.type !== 'note' || item.articleContent);
  return html`<div class="detail-tabs" role="tablist" aria-label="Item views" data-keydown="detail.tabs-key">
    ${tabs.map(t => html`<button type="button" role="tab" class="detail-tab" id="detail-tab-${t.value}" aria-selected="${t.value === tab ? 'true' : 'false'}" aria-controls="detail-panel"
      tabindex="${t.value === tab ? '0' : '-1'}" data-action="detail.tab" data-tab="${t.value}">${t.label}${t.value === 'notes' && notesCount ? html`<span class="detail-tab-count">${notesCount}</span>` : ''}</button>`)}
    <button type="button" role="tab" class="detail-tab is-ask" id="detail-tab-ask" aria-selected="false" tabindex="-1" data-action="detail.ask" data-id="${item.id}">${icon('sparkles', { size: 14 })}Ask</button>
  </div>`;
}

function renderCover(ctx, item) {
  if (item.type === 'note') return '';
  const src = coverOf(item);
  const isImage = ['image', 'video'].includes(item.type);
  const actions = html`<span class="detail-cover-actions">
      ${iconButton({ icon: 'image', label: src ? 'Change cover' : 'Add a cover image', action: 'detail.cover', data: { id: item.id }, size: 'sm', variant: 'secondary' })}
      ${src ? iconButton({ icon: 'x', label: 'Remove cover', action: 'detail.cover-remove', data: { id: item.id }, size: 'sm', variant: 'secondary' }) : ''}
    </span>`;
  if (!src && item.attachmentId && PREVIEW_IMAGE.test(item.mime || '')) return html`<figure class="detail-cover is-image">${previewMount(item)}</figure>`;
  return src
    ? html`<figure class="${cx('detail-cover', isImage && 'is-image')}" data-cover><img src="${src}" alt="${isImage ? item.title : ''}" decoding="async" referrerpolicy="no-referrer">${actions}</figure>`
    : html`<figure class="detail-cover is-generated">${generatedArt(ctx, item, { size: 'lg' })}${itemSource(item) ? html`<figcaption class="detail-cover-caption">${itemSource(item)}</figcaption>` : ''}${actions}</figure>`;
}

function renderSource(ctx, item) {
  const url = item.url || item.sourceUrl;
  const bits = [];
  if (item.articleContent) bits.push(html`<span>${TYPE_LABELS[item.type] || 'Item'}</span><span aria-hidden="true">·</span><span>${readingMinutes(item.articleContent)} min read</span>`);
  else bits.push(html`<span>${TYPE_LABELS[item.type] || 'Item'}</span>`);
  if (item.attachmentId && item.size) bits.push(html`<span aria-hidden="true">·</span><span>${fileSize(item.size)}</span>`);
  return html`<p class="detail-source">
    ${url ? html`${favicon(url, { size: 14 })}<a class="detail-url" href="${safeHref(url)}" target="_blank" rel="noopener noreferrer" title="${url}">${prettyUrl(url)}</a>
      ${iconButton({ icon: 'copy', label: 'Copy link', action: 'app.copy', data: { text: url, done: 'Link copied' }, size: 'sm', className: 'detail-copy' })}<span aria-hidden="true">·</span>` : ''}
    ${bits}
  </p>`;
}

function renderTagsProp(ctx, item) {
  if (detailState(ctx).addingTag === item.id) {
    const field = renderTagInput({ ctx, tags: item.tags || [], action: 'detail.tags-change', id: `detail-tags-${item.id}`, placeholder: 'Add tag', label: 'Tags', className: 'detail-tag-field' });
    return html`<div class="detail-tags is-editing" data-id="${item.id}">${field}${button({ label: 'Done', variant: 'ghost', size: 'sm', action: 'detail.tags-done', className: 'detail-tags-done' })}</div>`;
  }
  return html`<div class="detail-tags" data-id="${item.id}">
    ${(item.tags || []).map(tag => html`<span class="detail-tag" data-key="tag:${tag}">
      <button type="button" class="detail-tag-name" data-action="app.navigate" data-view="tag:${tag}" title="Show items tagged ${tag}"><span class="lib-hash" aria-hidden="true">#</span>${tag}</button>
      <button type="button" class="detail-tag-x" aria-label="Remove tag ${tag}" data-action="detail.remove-tag" data-id="${item.id}" data-tag="${tag}">${icon('x', { size: 12 })}</button></span>`)}
    <button type="button" class="detail-add" data-action="detail.add-tag-open" data-id="${item.id}" aria-label="Add a tag">${icon('plus', { size: 14 })}${item.tags?.length ? '' : html`<span>Add tag</span>`}</button>
  </div>`;
}

function renderProps(ctx, item) {
  const path = item.collectionId ? ctx.select.path(item.collectionId) : [];
  const collection = path.at(-1) || null;
  const reminder = item.reminderAt ? reminderLabel(item.reminderAt) : '';
  const prop = (glyph, labelText, value) => html`<div class="detail-prop"><dt>${icon(glyph, { size: 14 })}<span>${labelText}</span></dt><dd>${value}</dd></div>`;
  return html`<dl class="detail-props">
    ${prop('folder', 'Collection', html`<button type="button" class="detail-prop-value" data-action="detail.collection" data-id="${item.id}" aria-haspopup="dialog" aria-label="Collection: ${path.map(c => c.name).join(' / ') || 'Inbox'}. Change">
      ${collectionIcon(collection, { size: 16 })}<span class="detail-path">${path.length ? path.map((c, i) => html`${i ? html`<span class="detail-path-sep" aria-hidden="true">/</span>` : ''}<span class="${cx(i === path.length - 1 && 'is-last')}">${c.name}</span>`) : html`<span class="is-last">Inbox</span>`}</span>${icon('chevron-down', { size: 14, className: 'detail-prop-chevron' })}</button>`)}
    ${prop('hash', 'Tags', renderTagsProp(ctx, item))}
    ${prop('clock', 'Saved', html`<span class="detail-prop-text" title="Updated ${fullDate(item.updatedAt)}">${fullDate(item.createdAt)}</span>`)}
    ${prop('bell', 'Reminder', reminder
      ? html`<span class="detail-reminder"><button type="button" class="detail-prop-value" data-action="detail.reminder" data-id="${item.id}" aria-haspopup="dialog">
          <span class="${cx(item.reminderNotifiedAt && 'is-past')}">${item.reminderNotifiedAt ? `Reminded ${reminder}` : reminder}</span></button>
          ${iconButton({ icon: 'x', label: 'Remove reminder', action: 'detail.reminder-clear', data: { id: item.id }, size: 'sm' })}</span>`
      : html`<button type="button" class="detail-add" data-action="detail.reminder" data-id="${item.id}" aria-haspopup="dialog">${icon('plus', { size: 14 })}<span>Add reminder</span></button>`)}
  </dl>`;
}

function renderPersonalNote(ctx, item) {
  const editor = renderInlineEditor(ctx, { itemId: item.id, field: 'content', placeholder: item.type === 'note' ? 'Write your note' : 'Add a note' });
  if (String(editor || '').trim()) return html`<div class="detail-note">${editor}</div>`;
  if (!item.content) return html`<button type="button" class="detail-note-empty" data-action="detail.edit-note" data-id="${item.id}">${icon('notebook-pen', { size: 16 })}<span>${item.type === 'note' ? 'Write your note' : 'Add a note'}</span></button>`;
  return html`<div class="detail-note is-preview">
    <div class="markdown-body is-compact">${raw(renderMarkdown(item.content))}</div>
    ${button({ label: 'Edit', icon: 'pencil', variant: 'ghost', size: 'sm', action: 'detail.edit-note', data: { id: item.id } })}
  </div>`;
}

function renderHighlights(ctx, item) {
  const list = item.highlights || [];
  if (!list.length) return '';
  return html`<section class="detail-section" aria-labelledby="detail-hl-head">
    <h2 class="detail-section-head" id="detail-hl-head">Highlights<span class="detail-count">${list.length}</span></h2>
    <ul class="detail-highlights">${list.map(h => {
      const color = highlightColor(h.color);
      return html`<li class="detail-hl" data-key="hl:${h.id}">
        <button type="button" class="detail-hl-dot" data-color="${color}" aria-label="Highlight color: ${COLOR_NAMES[color]}. Change" data-action="detail.hl-color" data-id="${item.id}" data-hid="${h.id}"></button>
        <div class="detail-hl-body">
          <p class="detail-hl-text markdown-body"><mark data-color="${color}">${h.text}</mark></p>
          <textarea class="detail-hl-note" rows="1" placeholder="Add a note" aria-label="Note on this highlight" data-change="detail.hl-note" data-keydown="detail.field-key"
            data-id="${item.id}" data-hid="${h.id}">${h.note || ''}</textarea>
          <span class="detail-hl-meta">${h.createdAt ? html`<span>${shortDate(h.createdAt)}</span>` : ''}${item.articleContent ? html`<button type="button" class="detail-link-btn" data-action="detail.hl-open" data-id="${item.id}" data-hid="${h.id}">Show in reader</button>` : ''}</span>
        </div>
        ${iconButton({ icon: 'trash-2', label: 'Delete highlight', action: 'detail.hl-delete', data: { id: item.id, hid: h.id }, size: 'sm', className: 'detail-hl-x' })}
      </li>`;
    })}</ul>
  </section>`;
}

function renderConnections(ctx, item, notes) {
  const noteIds = new Set(notes.map(note => note.id));
  const related = ctx.select.related(item.id).filter(other => !noteIds.has(other.id));
  const explicit = new Set(item.relatedIds || []);
  const similar = similarFor(ctx, item);
  const shown = new Set([item.id, ...noteIds, ...related.map(other => other.id)]);
  const similarItems = (similar?.items || []).map(entry => ctx.select.byId(entry.id)).filter(other => other && !other.deletedAt && !shown.has(other.id)).slice(0, 5);
  const unlink = other => iconButton({ icon: 'unlink', label: `Remove link to ${other.title}`, action: 'detail.unlink', data: { id: item.id, other: other.id, way: explicit.has(other.id) ? 'out' : 'in' }, size: 'sm', className: 'item-link-act' });
  const newNote = item.type === 'note' ? '' : button({ label: item.url ? 'New note on this page' : 'New note', icon: 'plus', variant: 'ghost', size: 'sm', action: 'detail.new-note', data: { id: item.id }, className: 'detail-section-action' });
  return html`
    ${item.type !== 'note' ? html`<section class="detail-section" aria-labelledby="detail-notes-head">
      <h2 class="detail-section-head" id="detail-notes-head">Notes${notes.length ? html`<span class="detail-count">${notes.length}</span>` : ''}${notes.length ? newNote : ''}</h2>
      ${notes.length ? html`<div class="detail-links">${notes.slice(0, 5).map(note => renderItemLink(ctx, note, { meta: `Edited ${sentence(relativeDate(note.updatedAt))}` }))}</div>
        ${notes.length > 5 ? button({ label: `Show all ${notes.length} notes`, variant: 'ghost', size: 'sm', action: 'detail.tab', data: { tab: 'notes' } }) : ''}`
        : html`<button type="button" class="detail-note-empty" data-action="detail.new-note" data-id="${item.id}">${icon('sticky-note', { size: 16 })}<span>${item.url ? 'Write a note about this page' : 'Write a note about this item'}</span></button>`}
    </section>` : ''}
    ${related.length ? html`<section class="detail-section" aria-labelledby="detail-related-head">
      <h2 class="detail-section-head" id="detail-related-head">${item.type === 'note' ? 'Linked items' : 'Related'}<span class="detail-count">${related.length}</span></h2>
      <div class="detail-links">${related.map(other => renderItemLink(ctx, other, { actions: unlink(other) }))}</div>
    </section>` : ''}
    ${similar && (similar.status === 'loading' || similarItems.length) ? html`<section class="detail-section" aria-labelledby="detail-similar-head" aria-busy="${similar.status === 'loading' ? 'true' : 'false'}">
      <h2 class="detail-section-head" id="detail-similar-head">Similar${similarItems.length ? html`<span class="detail-count">${similarItems.length}</span>` : ''}</h2>
      ${similar.status === 'loading' && !similarItems.length ? html`<div class="detail-skeleton" aria-hidden="true"><span></span><span></span></div>`
        : html`<div class="detail-links">${similarItems.map(other => renderItemLink(ctx, other, { actions: iconButton({ icon: 'link-2', label: `Link ${other.title}`, action: 'detail.link', data: { id: item.id, other: other.id }, size: 'sm', className: 'item-link-act' }) }))}</div>`}
    </section>` : ''}`;
}

/** Attachment preview: images, video and PDF load from IndexedDB into a blob URL inside a mount. */
const previewMount = item => html`<div class="detail-preview" data-mount="detail.preview" data-morph="skip" data-key="preview:${item.attachmentId}" data-attachment="${item.attachmentId}" data-mime="${item.mime || ''}" data-title="${item.title}"></div>`;

function renderFile(ctx, item) {
  if (!item.attachmentId) return '';
  const mime = item.mime || '';
  const showPreview = /^video\//i.test(mime) || mime === 'application/pdf';
  return html`<section class="detail-section" aria-labelledby="detail-file-head">
    <h2 class="detail-section-head" id="detail-file-head">File</h2>
    <div class="detail-file">
      <span class="detail-file-icon" aria-hidden="true">${icon(TYPE_ICONS[item.type] || 'file', { size: 18 })}</span>
      <span class="detail-file-text"><span class="detail-file-name">${item.fileName || 'Attached file'}</span><span class="detail-file-meta">${[mime || 'File', item.size ? fileSize(item.size) : ''].filter(Boolean).join(' · ')}</span></span>
      ${mime === 'application/pdf' ? button({ label: 'Open', icon: 'external-link', variant: 'ghost', size: 'sm', action: 'detail.open-file', data: { id: item.id } }) : ''}
      ${button({ label: 'Download', icon: 'download', variant: 'secondary', size: 'sm', action: 'detail.download', data: { id: item.id } })}
    </div>
    ${showPreview ? previewMount(item) : ''}
  </section>`;
}

function renderDetails(ctx, item, notes) {
  return html`
    ${renderCover(ctx, item)}
    <div class="detail-intro">
      <textarea class="detail-title" id="detail-title" data-focus-key="detail-title" rows="1" aria-label="Title" spellcheck="true"
        data-change="detail.save-field" data-keydown="detail.field-key" data-field="title" data-id="${item.id}" data-rev="${item.updatedAt}">${item.title}</textarea>
      ${renderSource(ctx, item)}
      ${item.type !== 'note' ? html`<textarea class="detail-desc" id="detail-desc" data-focus-key="detail-desc" rows="1" placeholder="Add a description" aria-label="Description"
        data-change="detail.save-field" data-keydown="detail.field-key" data-field="excerpt" data-id="${item.id}" data-rev="${item.updatedAt}">${item.excerpt || ''}</textarea>` : ''}
    </div>
    ${renderProps(ctx, item)}
    <section class="detail-section" aria-labelledby="detail-note-head">
      <h2 class="detail-section-head" id="detail-note-head">${item.type === 'note' ? 'Note' : 'Your note'}${item.type === 'note' && !ctx.env.isSidepanel ? button({ label: 'Open in notes', icon: 'arrow-up-right', variant: 'ghost', size: 'sm', action: 'detail.open-note', data: { id: item.id }, className: 'detail-section-action' }) : ''}</h2>
      ${renderPersonalNote(ctx, item)}
    </section>
    ${renderHighlights(ctx, item)}
    ${renderConnections(ctx, item, notes)}
    ${renderFile(ctx, item)}
    <p class="detail-meta">${TYPE_LABELS[item.type] || 'Item'} · Added ${shortDate(item.createdAt)} · Updated ${sentence(relativeDate(item.updatedAt))}</p>`;
}

function renderReader(ctx, item) {
  const d = detailState(ctx);
  if (!item.articleContent) {
    const page = ctx.state.page?.url;
    const canCapture = ctx.env.isExtension && item.url && page && canonical(page) === canonical(item.url);
    return html`<div class="lib-empty">${emptyState({ icon: 'book-open', title: 'No saved text',
      body: canCapture ? 'Save the readable text of this page to read and highlight it here.'
        : item.url ? 'Still keeps the readable text of a page when you save it from the page itself. Open the page, then save it again from the side panel or with Alt+Shift+S.'
        : 'This item has no page text to read.',
      actions: canCapture ? button({ label: 'Capture page text', icon: 'scan-text', variant: 'primary', size: 'sm', action: 'detail.capture', data: { id: item.id } })
        : item.url ? button({ label: 'Open page', icon: 'external-link', variant: 'secondary', size: 'sm', action: 'app.open-url', data: { url: item.url } }) : '' })}</div>`;
  }
  const size = READER_SIZES[d.readerSize] || READER_SIZES[1];
  return html`<div class="reader" style="--reader-size:${size}px">
    <div class="reader-tools">
      <span class="reader-time">${readingMinutes(item.articleContent)} min read</span>
      ${item.highlights?.length ? html`<span class="reader-time">${plural(item.highlights.length, 'highlight')}</span>` : ''}
      <span class="reader-tools-end">
        ${iconButton({ icon: 'minus', label: 'Smaller text', action: 'detail.reader-size', data: { step: '-1' }, size: 'sm', disabled: d.readerSize <= 0 })}
        ${iconButton({ icon: 'plus', label: 'Larger text', action: 'detail.reader-size', data: { step: '1' }, size: 'sm', disabled: d.readerSize >= READER_SIZES.length - 1 })}
      </span>
    </div>
    <h2 class="reader-title">${item.title}</h2>
    <p class="reader-hint">Select text to highlight it.</p>
    <div class="reader-mount" data-mount="detail.reader" data-morph="skip" data-key="reader:${item.id}:${item.updatedAt}" data-id="${item.id}"></div>
  </div>`;
}

function renderNotesTab(ctx, item, notes) {
  const add = button({ label: 'New note', icon: 'plus', variant: 'secondary', size: 'sm', action: 'detail.new-note', data: { id: item.id } });
  if (!notes.length) {
    return html`<div class="lib-empty">${emptyState({ icon: 'sticky-note', title: 'No notes yet', body: item.type === 'note' ? 'Notes that link to this one with [[Title]] show up here.' : 'Write down what you think about this page. Notes stay linked to it.', actions: item.type === 'note' ? '' : add })}</div>`;
  }
  return html`<div class="detail-notes">
    <div class="detail-notes-head"><span>${plural(notes.length, 'note')}</span>${item.type === 'note' ? '' : add}</div>
    <div class="detail-notes-list" role="list">${notes.map((note, index) => renderItem(ctx, note, { layout: 'cards', surface: 'side', index, tabStop: true, view: 'notes' }))}</div>
  </div>`;
}

function renderFooter(ctx, item) {
  if (item.deletedAt) {
    return html`<footer class="detail-foot">
      <span class="detail-foot-note">${icon('trash-2', { size: 14 })}In Trash</span><span class="detail-foot-spacer"></span>
      ${button({ label: 'Restore', icon: 'rotate-ccw', variant: 'secondary', size: 'sm', action: 'library.restore', data: { id: item.id } })}
      ${button({ label: 'Delete forever', variant: 'ghost', size: 'sm', action: 'library.delete-forever', data: { id: item.id }, className: 'lib-danger' })}
    </footer>`;
  }
  return html`<footer class="detail-foot">
    ${button({ label: 'Ask about this', icon: 'sparkles', variant: 'ghost', size: 'sm', action: 'detail.ask', data: { id: item.id } })}
    <span class="detail-foot-spacer"></span>
    ${iconButton({ icon: 'star', label: item.favorite ? 'Remove from favorites' : 'Add to favorites', action: 'library.favorite', data: { id: item.id }, pressed: !!item.favorite, size: 'sm', className: 'detail-fav' })}
    ${item.url ? button({ label: 'Open', icon: 'external-link', variant: 'secondary', size: 'sm', action: 'app.open-url', data: { url: item.url } }) : ''}
    ${iconButton({ icon: 'ellipsis', label: 'More actions', action: 'detail.menu', data: { id: item.id }, size: 'sm', expanded: menuOpenFor(ctx, 'detail.menu') })}
  </footer>`;
}

/** The detail panel for one item. Side surface: full-screen with a back arrow. */
export function renderDetail(ctx, id, { surface = 'full' } = {}) {
  const item = ctx.select.byId(id);
  const side = surface === 'side';
  if (!item) {
    return html`<div class="detail" data-surface="${surface}" data-key="detail:missing">
      <header class="detail-head">${iconButton({ icon: side ? 'arrow-left' : 'x', label: side ? 'Back' : 'Close details', action: 'app.close-panel', size: 'sm' })}</header>
      <div class="lib-empty">${emptyState({ icon: 'circle-help', title: 'This item is gone', body: 'It was deleted or moved out of your library.' })}</div></div>`;
  }
  const requested = ctx.state.panel?.tab || 'details';
  const tab = ['details', 'reader', 'notes'].includes(requested) ? requested : 'details';
  const notes = linkedNotes(ctx, item);
  const body = tab === 'reader' ? renderReader(ctx, item) : tab === 'notes' ? renderNotesTab(ctx, item, notes) : renderDetails(ctx, item, notes);
  return html`<div class="${cx('detail', `is-${tab}`)}" data-surface="${surface}" data-key="detail:${item.id}">
    <header class="detail-head">
      ${side ? iconButton({ icon: 'arrow-left', label: 'Back', action: 'app.close-panel', size: 'sm', className: 'detail-back' }) : ''}
      ${renderTabs(ctx, item, tab, notes.length)}
      <span class="detail-head-actions">
        ${item.url ? iconButton({ icon: 'external-link', label: 'Open page in a new tab', action: 'app.open-url', data: { url: item.url }, size: 'sm' }) : ''}
        ${side ? '' : iconButton({ icon: 'x', label: 'Close details', action: 'app.close-panel', size: 'sm' })}
      </span>
    </header>
    <div class="detail-body" role="tabpanel" id="detail-panel" aria-labelledby="detail-tab-${tab}" data-key="detail-body:${item.id}:${tab}">${body}</div>
    ${renderFooter(ctx, item)}
  </div>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Mounts

function paintHighlights(root, highlights) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const pieces = [];
  let text = '';
  let lastBlock = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const block = node.parentElement?.closest('p, li, blockquote, h1, h2, h3, h4, td, th, pre, div');
    if (lastBlock && block !== lastBlock) text += ' ';
    lastBlock = block;
    pieces.push({ node, start: text.length });
    text += node.nodeValue;
  }
  const ranges = findHighlightRanges(text, highlights);
  for (const range of ranges.reverse()) {
    const hits = pieces.filter(p => p.start < range.end && p.start + p.node.nodeValue.length > range.start).reverse();
    hits.forEach((piece, i) => {
      const from = Math.max(0, range.start - piece.start);
      const to = Math.min(piece.node.nodeValue.length, range.end - piece.start);
      if (to <= from) return;
      let target = piece.node;
      if (to < target.nodeValue.length) target.splitText(to);
      if (from > 0) target = target.splitText(from);
      const mark = document.createElement('mark');
      mark.dataset.color = range.color;
      if (i === hits.length - 1) mark.id = `reader-hl-${range.id}`;
      target.replaceWith(mark);
      mark.append(target);
    });
  }
}

registerMount('detail.reader', (el, ctx) => {
  const item = ctx.select.byId(el.dataset.id);
  if (!item) return null;
  el.innerHTML = `<div class="reader-text markdown-body">${renderMarkdown(readerSource(item.articleContent))}</div><div class="reader-pop" role="toolbar" aria-label="Highlight selection" hidden></div>`;
  const textEl = el.querySelector('.reader-text');
  const pop = el.querySelector('.reader-pop');
  paintHighlights(textEl, item.highlights || []);
  pop.innerHTML = HIGHLIGHT_COLORS.slice(0, 4).map(color => `<button type="button" class="reader-pop-color" data-color="${color}" aria-label="Highlight in ${COLOR_NAMES[color].toLowerCase()}"></button>`).join('');
  let selected = '';
  const hide = () => { pop.hidden = true; selected = ''; };
  const show = () => {
    const selection = getSelection();
    const text = selection && !selection.isCollapsed ? selection.toString().replace(/\s+/g, ' ').trim() : '';
    if (text.length < 2 || !textEl.contains(selection.anchorNode) || !textEl.contains(selection.focusNode)) { hide(); return; }
    selected = text.slice(0, 5000);
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const box = el.getBoundingClientRect();
    pop.hidden = false;
    pop.style.left = `${Math.max(0, Math.min(rect.left - box.left + rect.width / 2 - pop.offsetWidth / 2, box.width - pop.offsetWidth))}px`;
    pop.style.top = `${rect.top - box.top - pop.offsetHeight - 8}px`;
  };
  const onUp = () => setTimeout(show, 0);
  const onKey = event => { if (event.key === 'Escape' && !pop.hidden) { event.stopPropagation(); hide(); } else if (event.shiftKey) setTimeout(show, 0); };
  const onPick = event => {
    const swatch = event.target.closest('.reader-pop-color');
    if (!swatch || !selected) return;
    event.preventDefault();
    const text = selected;
    hide();
    getSelection()?.removeAllRanges();
    ctx.run(async () => {
      const current = ctx.select.byId(item.id);
      const highlight = { id: `highlight_${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`, text, color: swatch.dataset.color, note: '', createdAt: new Date().toISOString(), url: current.url || current.sourceUrl || '' };
      await ctx.store.updateItem(current.id, { highlights: [...(current.highlights || []), highlight] }, { expectedUpdatedAt: current.updatedAt });
      ctx.toast('Highlight saved');
    });
  };
  const stopDown = event => { if (event.target.closest('.reader-pop-color')) event.preventDefault(); };
  el.addEventListener('mouseup', onUp);
  el.addEventListener('keyup', onKey);
  pop.addEventListener('mousedown', stopDown);
  pop.addEventListener('click', onPick);
  const focusId = detailState(ctx).scrollTo;
  if (focusId) {
    detailState(ctx).scrollTo = null;
    const mark = el.querySelector(`#reader-hl-${CSS.escape(focusId)}`);
    if (mark) requestAnimationFrame(() => { mark.scrollIntoView({ block: 'center' }); mark.classList.add('is-flash'); });
  }
  return { destroy() { el.removeEventListener('mouseup', onUp); el.removeEventListener('keyup', onKey); } };
});

const isPdf = async blob => (await blob.slice(0, 5).text()) === '%PDF-';

registerMount('detail.preview', (el, ctx) => {
  let url = '';
  let gone = false;
  const mime = el.dataset.mime || '';
  const say = text => { el.textContent = text; el.classList.add('is-missing'); };
  (async () => {
    const record = await ctx.store.getAttachment(el.dataset.attachment);
    if (gone) return;
    if (!record?.blob) return say('The original file is not on this device.');
    let media;
    if (PREVIEW_IMAGE.test(mime)) {
      media = Object.assign(document.createElement('img'), { alt: el.dataset.title || '', decoding: 'async' });
    } else if (/^video\//i.test(mime)) {
      media = Object.assign(document.createElement('video'), { controls: true, preload: 'metadata' });
    } else {
      // Chrome will not show PDFs inside sandboxed frames, so the frame is only used for a verified PDF
      // served as application/pdf: its only content is the browser's own PDF viewer.
      if (!(await isPdf(record.blob))) return say('No preview for this file. Download it to open it.');
      media = Object.assign(document.createElement('iframe'), { title: `Preview of ${el.dataset.title || 'the file'}` });
    }
    if (gone) return;
    url = URL.createObjectURL(media.tagName === 'IFRAME' ? new Blob([record.blob], { type: 'application/pdf' }) : record.blob);
    media.src = url;
    el.replaceChildren(media);
  })().catch(() => { if (!gone) say('The preview could not be loaded.'); });
  return { destroy() { gone = true; if (url) URL.revokeObjectURL(url); } };
});

// ---------------------------------------------------------------------------------------------------------------
// Actions

const itemOf = (ctx, id) => ctx.select.byId(id);
/**
 * Inline fields remember the stored value when editing starts. The morph refreshes data-rev while a field has focus,
 * so the attribute alone cannot tell that the same field was changed in another view in the meantime.
 */
const editBase = new WeakMap();

async function patch(ctx, id, changes, message, undo) {
  const item = itemOf(ctx, id);
  if (!item) return null;
  const updated = await ctx.store.updateItem(id, changes, { expectedUpdatedAt: item.updatedAt });
  if (message) ctx.toast(message, undo ? { action: { label: 'Undo', run: () => ctx.store.updateItem(id, undo) } } : {});
  return updated;
}

function pickReminder(ctx, anchor, id) {
  const item = itemOf(ctx, id);
  if (!item) return;
  const save = async iso => {
    await patch(ctx, id, { reminderAt: iso || null });
    if (iso) ctx.toast(`Reminder set for ${reminderLabel(iso)}`);
  };
  try {
    ctx.openPopover('pick.reminder', anchor, { value: item.reminderAt || null, onPick: iso => ctx.run(() => save(iso)) });
  } catch {
    ctx.openMenu(anchor, [
      ...reminderPresets().map(preset => ({ label: preset.label, hint: reminderLabel(preset.iso), icon: 'bell', run: () => ctx.run(() => save(preset.iso)) })),
      ...(item.reminderAt ? [{ separator: true }, { label: 'Remove reminder', icon: 'bell-off', run: () => ctx.run(() => save(null)) }] : []),
    ], { label: 'Remind me' });
  }
}

function closeTagEditor(ctx) {
  const d = detailState(ctx);
  if (!d.addingTag) return;
  const id = d.addingTag;
  d.addingTag = null;
  ctx.render();
  ctx.nextFrame(() => document.querySelector(`.detail-add[data-id="${CSS.escape(id)}"][data-action="detail.add-tag-open"]`)?.focus());
}

registerActions({
  'detail.tab': ({ ctx, data }) => {
    if (!ctx.state.panel) return;
    ctx.state.panel = { ...ctx.state.panel, tab: data.tab };
    ctx.render();
    ctx.nextFrame(() => document.getElementById(`detail-tab-${data.tab}`)?.focus({ preventScroll: true }));
  },
  'detail.tabs-key': ({ ctx, event }) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...event.target.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    next.focus();
    if (next.dataset.tab) { ctx.state.panel = { ...ctx.state.panel, tab: next.dataset.tab }; ctx.render(); }
  },
  'detail.ask': ({ ctx, data }) => askAi(ctx, { scope: 'item', ids: [data.id] }),
  'detail.save-field': async ({ ctx, el }) => {
    const { id, field, rev } = el.dataset;
    const item = itemOf(ctx, id);
    const base = editBase.get(el);
    editBase.delete(el);
    if (!item || !['title', 'excerpt'].includes(field)) return;
    const value = field === 'title' ? el.value.replace(/\s+/g, ' ').trim() : el.value.trim();
    if (field === 'title' && !value) { el.value = item.title; return; }
    const current = item[field] || '';
    if (current === value) return;
    if (base && current !== base.value) {
      // Someone changed this same field elsewhere while it was being edited here: show theirs, offer to keep ours.
      el.value = current;
      const name = field === 'title' ? 'title' : 'description';
      ctx.toast(`The ${name} changed in another view while you were editing.`, { tone: 'warning', duration: 10000,
        action: { label: 'Use mine', run: () => ctx.store.updateItem(id, { [field]: value }) } });
      return;
    }
    // Other fields may have changed since editing began (tags, a highlight); this patch only touches its own field.
    await ctx.store.updateItem(id, { [field]: value }, { expectedUpdatedAt: base ? item.updatedAt : rev });
  },
  'detail.field-key': ({ ctx, el, event }) => {
    if (event.key === 'Escape') {
      const item = itemOf(ctx, el.dataset.id);
      const highlight = el.dataset.hid ? item?.highlights?.find(h => h.id === el.dataset.hid) : null;
      if (item) el.value = el.dataset.hid ? highlight?.note || '' : item[el.dataset.field] || '';
      event.preventDefault();
      event.stopPropagation();
      el.blur();
      return;
    }
    const single = el.dataset.field === 'title';
    if (event.key === 'Enter' && (single ? !event.shiftKey : (event.metaKey || event.ctrlKey))) { event.preventDefault(); el.blur(); }
  },
  'detail.cover': async ({ ctx, data }) => {
    const item = itemOf(ctx, data.id);
    if (!item) return;
    const value = await ctx.prompt({ title: item.cover ? 'Change cover' : 'Add a cover image', label: 'Image address', placeholder: 'https://example.com/image.jpg', value: /^https?:/i.test(item.cover) ? item.cover : '', confirmLabel: 'Save cover' });
    if (value == null) return;
    const url = value.trim();
    if (!url) return patch(ctx, data.id, { cover: '' }, 'Cover removed', { cover: item.cover });
    if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('Enter an image address that starts with http:// or https://.');
    await patch(ctx, data.id, { cover: url }, 'Cover updated', { cover: item.cover });
  },
  'detail.cover-remove': ({ ctx, data }) => {
    const item = itemOf(ctx, data.id);
    return item && patch(ctx, data.id, { cover: '' }, 'Cover removed', { cover: item.cover });
  },
  'detail.collection': ({ ctx, el, data }) => {
    const item = itemOf(ctx, data.id);
    if (!item) return;
    pickCollection(ctx, el, { value: item.collectionId || '', title: 'Move to', onPick: async collectionId => {
      if ((item.collectionId || '') === collectionId) return;
      await patch(ctx, data.id, { collectionId }, `Moved to ${collectionId ? ctx.select.collection(collectionId)?.name || 'collection' : 'Inbox'}`, { collectionId: item.collectionId || '' });
      if (collectionId) ctx.prefs.touchCollection?.(collectionId);
    } });
  },
  'detail.add-tag-open': ({ ctx, data }) => {
    detailState(ctx).addingTag = data.id;
    ctx.render();
    ctx.nextFrame(() => document.querySelector('.detail-tags.is-editing input:not([type="hidden"])')?.focus());
  },
  'detail.tags-change': async ({ ctx, data }) => {
    const id = detailState(ctx).addingTag;
    const item = itemOf(ctx, id);
    const next = Array.isArray(data.tags) ? data.tags : parseTags(data.value);
    if (!item || next.join('\u0000') === (item.tags || []).join('\u0000')) return;
    await patch(ctx, id, { tags: next });
  },
  'detail.tags-done': ({ ctx }) => closeTagEditor(ctx),
  'detail.remove-tag': ({ ctx, data }) => {
    const item = itemOf(ctx, data.id);
    if (!item) return;
    return patch(ctx, data.id, { tags: item.tags.filter(tag => tag !== data.tag) }, `Removed #${data.tag}`, { tags: item.tags });
  },
  'detail.reminder': ({ ctx, el, data }) => pickReminder(ctx, el, data.id),
  'detail.reminder-clear': ({ ctx, data }) => {
    const item = itemOf(ctx, data.id);
    return item && patch(ctx, data.id, { reminderAt: null }, 'Reminder removed', { reminderAt: item.reminderAt });
  },
  'detail.edit-note': async ({ ctx, data }) => {
    const item = itemOf(ctx, data.id);
    if (!item) return;
    const value = await ctx.prompt({ title: item.type === 'note' ? 'Edit note' : 'Your note', label: 'Markdown', value: item.content || '', multiline: true, confirmLabel: 'Save note' });
    if (value != null && value !== (item.content || '')) await patch(ctx, data.id, { content: value });
  },
  // The notes editor of this surface takes over from the detail panel (notes.js clears the panel and shows Notes).
  'detail.open-note': ({ ctx, data }) => openNote(ctx, data.id),
  'detail.hl-color': ({ ctx, el, data }) => {
    const item = itemOf(ctx, data.id);
    const current = item?.highlights?.find(h => h.id === data.hid);
    if (!current) return;
    ctx.openMenu(el, HIGHLIGHT_COLORS.map(color => ({ label: COLOR_NAMES[color], checked: highlightColor(current.color) === color,
      run: () => ctx.run(() => patch(ctx, data.id, { highlights: itemOf(ctx, data.id).highlights.map(h => h.id === data.hid ? { ...h, color } : h) })) })), { label: 'Highlight color' });
  },
  'detail.hl-note': ({ ctx, el, data }) => {
    const item = itemOf(ctx, data.id);
    const current = item?.highlights?.find(h => h.id === data.hid);
    if (!current || (current.note || '') === el.value.trim()) return;
    return patch(ctx, data.id, { highlights: item.highlights.map(h => h.id === data.hid ? { ...h, note: el.value.trim() } : h) });
  },
  'detail.hl-delete': ({ ctx, data }) => {
    const item = itemOf(ctx, data.id);
    if (!item) return;
    return patch(ctx, data.id, { highlights: item.highlights.filter(h => h.id !== data.hid) }, 'Highlight deleted', { highlights: item.highlights });
  },
  'detail.hl-open': ({ ctx, data }) => {
    detailState(ctx).scrollTo = data.hid;
    ctx.state.panel = { ...ctx.state.panel, tab: 'reader' };
    ctx.render();
  },
  'detail.reader-size': ({ ctx, data }) => {
    const d = detailState(ctx);
    d.readerSize = Math.max(0, Math.min(READER_SIZES.length - 1, d.readerSize + Number(data.step)));
    ctx.render();
  },
  'detail.capture': async ({ ctx, data }) => {
    const item = itemOf(ctx, data.id);
    if (!item) return;
    // captureCurrent reads whatever tab is active now; the tab may have changed since the button was drawn.
    const page = ctx.state.page?.url;
    if (!page || !item.url || canonical(page) !== canonical(item.url)) throw new Error('Open this page in the current tab, then try again.');
    await ctx.chrome('captureCurrent', { collectionId: item.collectionId || '' });
    ctx.toast('Saved the page text', { tone: 'success' });
  },
  'detail.new-note': ({ ctx, data }) => {
    const item = itemOf(ctx, data.id);
    return item && addNoteFor(ctx, item);
  },
  'detail.unlink': async ({ ctx, data }) => {
    const item = itemOf(ctx, data.id);
    const other = itemOf(ctx, data.other);
    if (!item || !other) return;
    const changes = [];
    if ((item.relatedIds || []).includes(other.id)) changes.push({ id: item.id, patch: { relatedIds: item.relatedIds.filter(x => x !== other.id) } });
    if ((other.relatedIds || []).includes(item.id)) changes.push({ id: other.id, patch: { relatedIds: other.relatedIds.filter(x => x !== item.id) } });
    if (!changes.length) return;
    const undo = changes.map(change => ({ id: change.id, patch: { relatedIds: itemOf(ctx, change.id).relatedIds } }));
    await ctx.store.bulkUpdateItems(changes);
    ctx.toast(`Removed the link to ${other.title}`, { action: { label: 'Undo', run: () => ctx.store.bulkUpdateItems(undo) } });
  },
  'detail.link': async ({ ctx, data }) => {
    const item = itemOf(ctx, data.id);
    if (!item || (item.relatedIds || []).includes(data.other)) return;
    await patch(ctx, item.id, { relatedIds: [...(item.relatedIds || []), data.other] }, 'Linked');
  },
  'detail.open-file': async ({ ctx, data }) => {
    const item = itemOf(ctx, data.id);
    const record = item?.attachmentId ? await ctx.store.getAttachment(item.attachmentId) : null;
    if (!record?.blob) throw new Error('The original file is not on this device. Restore a full backup to get it back.');
    if (!(await isPdf(record.blob))) throw new Error('This file cannot be opened here. Download it instead.');
    const url = URL.createObjectURL(new Blob([record.blob], { type: 'application/pdf' }));
    if (ctx.env.isExtension) await chrome.tabs.create({ url }); else window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
  'detail.download': async ({ ctx, data }) => {
    const item = itemOf(ctx, data.id);
    const record = item?.attachmentId ? await ctx.store.getAttachment(item.attachmentId) : null;
    if (!record?.blob) throw new Error('The original file is not on this device. Restore a full backup to get it back.');
    const url = URL.createObjectURL(record.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.fileName || record.name || 'file';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  },
  'detail.menu': ({ ctx, el, data }) => {
    const item = itemOf(ctx, data.id);
    if (!item) return;
    const ids = [item.id];
    ctx.openMenu(el, [
      item.url && { label: 'Copy link', icon: 'link', action: 'app.copy', data: { text: item.url, done: 'Link copied' } },
      { label: 'Move to…', icon: 'folder-input', run: () => moveItems(ctx, ids, el) },
      item.type !== 'note' && { label: 'Add note', icon: 'notebook-pen', run: () => ctx.run(() => addNoteFor(ctx, item)) },
      item.type !== 'note' && { label: item.cover ? 'Change cover…' : 'Add cover…', icon: 'image', run: () => ctx.run(() => ctx.dispatch('detail.cover', { data: { id: item.id } })) },
      { label: 'Ask AI about this', icon: 'sparkles', run: () => askAi(ctx, { scope: 'item', ids }) },
      { separator: true },
      { label: item.archived ? 'Unarchive' : 'Archive', icon: item.archived ? 'archive-restore' : 'archive', run: () => ctx.run(() => setArchived(ctx, ids, !item.archived)) },
      { label: 'Delete', icon: 'trash-2', danger: true, hint: 'Moves to Trash', run: () => ctx.run(() => trashItems(ctx, ids)) },
    ].filter(Boolean), { label: `Actions for ${item.title}`, placement: 'top-end' });
  },
});

/** Leaves tag editing on Escape (after any suggestion popover has closed) or when focus moves elsewhere. */
export function init(ctx) {
  document.addEventListener('focusin', event => {
    const el = event.target;
    if (!el?.matches?.('.detail textarea[data-field][data-id]')) return;
    const item = itemOf(ctx, el.dataset.id);
    if (!item) return;
    const stored = item[el.dataset.field] || '';
    // Refocusing with unsaved text (e.g. back from another window) keeps the original starting point.
    if (!editBase.has(el) || el.value === stored) editBase.set(el, { value: stored });
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || !detailState(ctx).addingTag) return;
    if (!event.target.closest?.('.detail-tags.is-editing')) return;
    event.preventDefault();
    closeTagEditor(ctx);
  });
  document.addEventListener('focusout', event => {
    if (!event.target.closest?.('.detail-tags.is-editing')) return;
    setTimeout(() => {
      const active = document.activeElement;
      if (active?.closest?.('.detail-tags.is-editing, #still-popover') || ctx.state.popover?.name === 'pick.tag-suggest') return;
      closeTagEditor(ctx);
    }, 120);
  });
}
