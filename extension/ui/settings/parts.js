// Building blocks shared by every Settings section (and by account cards that integrations register): groups, cards, rows,
// callouts, code blocks and progress bars, styled by styles/settings.css. They also implement Settings search: while
// renderFiltered() runs, rows and groups that do not match the query render nothing, so the same section renderers draw both
// the normal page and the filtered results. A group's body may be a function so its rows see the group title as context
// (searching "saving" keeps every row of the Saving group).
import { html, cx, safeHref } from '../html.js';
import { icon, registerIcons } from '../icons.js';
import { iconButton, switchToggle, spinner } from '../components.js';
import { matchesTerms } from './catalog.js';

// Lucide glyphs Settings needs that the shared set does not ship.
registerIcons({
  server: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  'search-x': '<path d="m13.5 8.5-5 5"/><path d="m8.5 8.5 5 5"/><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  'image-up': '<path d="M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21"/><path d="m14 19.5 3-3 3 3"/><path d="M17 22v-5.5"/><circle cx="9" cy="9" r="2"/>',
  'image-off': '<line x1="2" x2="22" y1="2" y2="22"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><line x1="13.5" x2="6" y1="13.5" y2="21"/><line x1="18" x2="21" y1="12" y2="15"/><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/>',
  pipette: '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>',
});

/* ------------------------------------------------------------------ shared UI state */

/** Per-view Settings state: section, side-panel list mode, search query, open disclosures. */
export const uiState = ctx => (ctx.state.settings ||= { section: 'general', list: true, query: '', open: new Set() });

const busy = new Set();
export const isBusy = key => busy.has(key);
/** Runs fn once at a time per key, re-rendering so buttons can show their loading state. */
export async function withBusy(ctx, key, fn) {
  if (busy.has(key)) return undefined;
  busy.add(key);
  ctx.render();
  try { return await fn(); } finally { busy.delete(key); ctx.render(); }
}

/* ------------------------------------------------------------------ search rendering */

let search = null; // { terms, context: [], hits } while renderFiltered() runs

/** Renders fn() with the query applied; returns { content, hits } (hits = rows that matched). */
export function renderFiltered(terms, context, fn) {
  const previous = search;
  search = { terms, context: [context].flat(), hits: 0 };
  try {
    const content = fn();
    return { content: isBlank(content) ? '' : content, hits: search.hits };
  } finally { search = previous; }
}
export const isSearching = () => !!search;
const isBlank = value => !String(value ?? '').replace(/<!--.*?-->/g, '').trim();

/** True outside search, or when the texts (plus the enclosing section and group) match every search term. */
export function matches(...texts) {
  if (!search) return true;
  const ok = matchesTerms(search.terms, ...search.context, ...texts);
  if (ok) search.hits += 1;
  return ok;
}
/** A custom block (not a row) that takes part in search as one unit. */
export const searchable = (texts, fragment) => (matches(texts) ? fragment : '');
/** Runs fn with extra search context (a group title, a provider name). */
function withContext(texts, fn) {
  if (!search) return fn();
  const size = search.context.length;
  search.context.push(...texts);
  try { return fn(); } finally { search.context.length = size; }
}

/* ------------------------------------------------------------------ layout blocks */

// Group heading ids come from their titles; resetIds() at the start of each page render keeps them stable and unique.
const usedIds = new Map();
export const resetIds = () => usedIds.clear();
function headingIdFor(title) {
  const slug = String(title ?? '').toLowerCase().replace(/<[^>]*>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group';
  const n = (usedIds.get(slug) || 0) + 1;
  usedIds.set(slug, n);
  return `settings-group-${slug}${n > 1 ? `-${n}` : ''}`;
}

/** A titled group of rows. body: fragment or () => fragment (lazy, so search sees the title as context). */
export function group({ title, description, actions, body, id, className, keywords } = {}) {
  const content = withContext([title, description, keywords], () => (typeof body === 'function' ? body() : body));
  if (search && isBlank(content)) return '';
  const headingId = id ? `${id}-title` : headingIdFor(title);
  return html`<section class="${cx('settings-group', className)}" ${id ? html`id="${id}"` : ''} ${title ? html`aria-labelledby="${headingId}"` : ''}>
    ${title ? html`<header class="settings-group-head"><div class="settings-group-heading"><h3 class="settings-group-title" id="${headingId}">${title}</h3>
      ${description ? html`<p class="settings-group-desc">${description}</p>` : ''}</div>${actions ? html`<div class="settings-group-actions">${actions}</div>` : ''}</header>` : ''}
    ${content}
  </section>`;
}

/** A card of rows; empty rows (filtered out by search) are dropped, and an empty card renders nothing while searching. */
export function card(rows, className) {
  const list = [rows].flat().filter(entry => !isBlank(entry));
  if (search && !list.length) return '';
  return html`<div class="${cx('settings-card', className)}">${list}</div>`;
}

/** Label and description on the leading side, control on the trailing side (stacked below on narrow widths). */
export function row({ label, description, control, lead, className, stacked, id, descClass, keywords } = {}) {
  if (!matches(label, description, keywords)) return '';
  return html`<div class="${cx('settings-row', stacked && 'is-stacked', lead && 'has-lead', className)}" ${id ? html`id="${id}" tabindex="-1"` : ''}>
    ${lead || ''}
    <div class="settings-row-text"><span class="settings-row-label">${label}</span>${description ? html`<span class="${cx('settings-row-desc', descClass)}">${description}</span>` : ''}</div>
    ${control ? html`<div class="settings-row-control">${control}</div>` : ''}
  </div>`;
}

/** A row whose whole surface is a labelled switch. options: switchToggle options plus keywords and id. */
export function switchRow({ keywords, id, ...options } = {}) {
  if (!matches(options.label, options.description, keywords)) return '';
  return html`<div class="settings-row is-switch" ${id ? html`id="${id}" tabindex="-1"` : ''}>${switchToggle(options)}</div>`;
}

/** A row with free-form content under its heading (forms, lists, pickers). */
export function blockRow({ label, description, body, id, className, keywords, lead } = {}) {
  if (!matches(label, description, keywords)) return '';
  return html`<div class="${cx('settings-row', 'is-stacked', 'is-block', className)}" ${id ? html`id="${id}" tabindex="-1"` : ''}>
    ${label || description ? html`<div class="settings-row-split">${lead || ''}<div class="settings-row-text">${label ? html`<span class="settings-row-label">${label}</span>` : ''}
      ${description ? html`<span class="settings-row-desc">${description}</span>` : ''}</div></div>` : ''}
    ${body}
  </div>`;
}

export function callout({ tone = 'info', icon: ico, title, body, actions, live: announce, className } = {}) {
  const glyph = ico || { success: 'circle-check', danger: 'circle-alert', warning: 'triangle-alert', info: 'info' }[tone] || 'info';
  return html`<div class="${cx('settings-callout', className)}" data-tone="${tone}" ${announce ? html`role="${tone === 'danger' ? 'alert' : 'status'}"` : ''}>
    ${icon(glyph, { size: 16, className: 'settings-callout-icon' })}
    <div class="settings-callout-text">${title ? html`<p class="settings-callout-title">${title}</p>` : ''}${body ? html`<div class="settings-callout-body">${body}</div>` : ''}
      ${actions ? html`<div class="settings-callout-actions">${actions}</div>` : ''}</div>
  </div>`;
}

export function codeBlock(code, { label = 'Copy', done = 'Copied' } = {}) {
  return html`<div class="settings-code"><pre><code>${code}</code></pre>
    ${iconButton({ icon: 'copy', label, action: 'app.copy', data: { text: code, done }, size: 'sm', className: 'settings-code-copy', tooltipPlacement: 'top end' })}</div>`;
}

export function progressBar({ percent = null, label, tone } = {}) {
  const indeterminate = percent === null || percent === undefined;
  return html`<div class="${cx('settings-progress', indeterminate && 'is-indeterminate')}" ${tone ? html`data-tone="${tone}"` : ''} role="progressbar" aria-label="${label}"
    ${indeterminate ? '' : html`aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" style="--progress:${percent / 100}"`}><span class="settings-progress-bar"></span></div>`;
}

export const disclosed = (ctx, id) => uiState(ctx).open.has(id);
export function disclosure(ctx, id, label, { count } = {}) {
  const open = disclosed(ctx, id);
  return html`<button type="button" class="settings-disclosure" aria-expanded="${open ? 'true' : 'false'}" aria-controls="settings-more-${id}"
    data-action="settings.disclose" data-id="${id}">${icon('chevron-right', { size: 14, className: 'settings-disclosure-icon' })}<span>${label}</span>${count != null ? html`<span class="count">${count}</span>` : ''}</button>`;
}

export const loadingBlock = label => (search ? '' : html`<div class="settings-loading" role="status">${spinner({ size: 16 })}<span>${label}</span></div>`);

export const linkButton = ({ label, href, icon: ico = 'external-link', variant = 'secondary', size = 'sm' }) => html`<a class="${cx('btn', `btn-${variant}`, size !== 'md' && `btn-${size}`)}"
  href="${safeHref(href)}" target="_blank" rel="noopener noreferrer"><span class="btn-label">${label}</span>${icon(ico, { size: 14, className: 'btn-icon-right' })}</a>`;

/** A muted paragraph under the cards (privacy notes, hints). */
export const note = (glyph, body) => html`<p class="settings-note">${icon(glyph, { size: 14 })}<span>${body}</span></p>`;

// Letter or icon tiles for providers and clients (no brand artwork ships with the extension).
const MARKS = {
  anthropic: { text: 'A', color: 'orange' }, openai: { text: 'O', color: 'green' }, xai: { text: 'x', color: 'gray' }, google: { text: 'G', color: 'blue' },
  openrouter: { text: 'OR', color: 'indigo' }, mistral: { text: 'M', color: 'amber' }, groq: { text: 'G', color: 'red' }, deepseek: { text: 'D', color: 'cyan' },
  perplexity: { text: 'P', color: 'teal' }, voyage: { text: 'V', color: 'violet' }, cohere: { text: 'C', color: 'pink' },
  ollama: { icon: 'cpu', color: 'gray' }, lmstudio: { text: 'LM', color: 'gray' }, 'custom-openai': { icon: 'server', color: 'gray' }, 'custom-anthropic': { icon: 'server', color: 'gray' },
  bridge: { icon: 'plug-zap', color: 'blue' }, 'agent:claude-code': { icon: 'terminal', color: 'orange' }, 'agent:codex': { icon: 'terminal', color: 'gray' },
  'chatgpt-oauth': { icon: 'message-circle', color: 'green' }, raindrop: { icon: 'cloud', color: 'blue' }, cursor: { text: 'Cu', color: 'gray' },
  vscode: { icon: 'code-xml', color: 'blue' }, chrome: { icon: 'globe', color: 'blue' }, opencode: { text: 'OC', color: 'gray' }, gemini: { text: 'G', color: 'blue' }, 'claude-desktop': { text: 'A', color: 'orange' },
  github: { icon: 'github', color: 'gray' }, linear: { text: 'L', color: 'indigo' }, producthunt: { text: 'P', color: 'orange' },
  paperclip: { icon: 'paperclip', color: 'violet' }, copilot: { icon: 'github', color: 'gray' }, kiro: { text: 'K', color: 'violet' }, factory: { text: 'F', color: 'gray' },
  windsurf: { text: 'W', color: 'teal' }, zed: { text: 'Z', color: 'blue' }, goose: { text: 'Go', color: 'gray' }, qwen: { text: 'Q', color: 'violet' }, amp: { text: 'A', color: 'red' },
  crush: { text: 'Cr', color: 'pink' }, 'lm-studio': { text: 'LM', color: 'gray' }, devin: { text: 'D', color: 'teal' },
};

/** Provider tile; pass { icon } or { text } with a palette color for providers that are not in the table. */
export function providerMark(id, size = 32, fallback = {}) {
  const mark = MARKS[id] || { icon: fallback.icon || 'circle', text: fallback.text, color: fallback.color || 'gray' };
  return html`<span class="avatar-tile settings-mark" data-color="${mark.color}" style="--size:${size}px" aria-hidden="true">${mark.icon && !mark.text
    ? icon(mark.icon, { size: Math.round(size * 0.5) }) : mark.text || icon(mark.icon || 'circle', { size: Math.round(size * 0.5) })}</span>`;
}
