// "Add AI chats from Threadkeeper" (design §6): a dialog that searches the threads Threadkeeper keeps and copies the ones
// the person picks into the library as chats. Opened from Settings → Integrations → AI chat threads ("Add chats…"), the
// Chats view header, the command palette and Quick add's menu, in the side panel and the full tab alike.
// Every read goes through lib/threadkeeper/client.js (the worker talks to Threadkeeper); the import uses
// importThreadkeeperThreads(keys, { target, origin: 'manual' }), so it revives chats in Trash or deleted forever.
// Thread text is untrusted: it is shown only as escaped text (html``), never as markup, and no image is loaded from it.
// The client is reached through threadkeeperClient() so tests (and the settings card) can swap in a fake.
import { html, cx, plural } from './html.js';
import { icon } from './icons.js';
import { button, iconButton, input, checkbox, chip, select, segmented, badge, spinner, emptyState, relativeDate, avatarTile, keyshortcuts, shortcutLabel } from './components.js';
import { registerDialog } from './overlay.js';
import { registerActions } from './runtime.js';
import { renderCollectionPickerTrigger } from './pickers.js';
import * as threadkeeper from '../lib/threadkeeper/client.js';
import { chatItemId } from '../lib/threadkeeper/protocol.js';

export const PICKER_DIALOG = 'threadkeeper.picker';
const PAGE = 30;
const IMPORT_BATCH = 200; // importThreadkeeperThreads takes at most 200 thread keys per call
const SEARCH_TIMEOUT = 15000; // protocol: threads.search 15 s
const READ_TIMEOUT = 10000;
const DEBOUNCE = 250;

/* ------------------------------------------------------------------ client indirection */

let client = threadkeeper;
/** The Threadkeeper page client in use (lib/threadkeeper/client.js unless a test swapped it). */
export const threadkeeperClient = () => client;
/** Swaps the page client (tests); pass nothing to go back to the real one. */
export function useThreadkeeperClient(next) { client = next ? { ...threadkeeper, ...next } : threadkeeper; }

/* ------------------------------------------------------------------ pure helpers (tested) */

export const CATEGORY_LABELS = Object.freeze({ chat: 'Chats', coding_agent: 'Coding agents', agent: 'Agents', builder: 'App builders', search: 'Search', companion: 'Companions' });
const CATEGORIES = Object.keys(CATEGORY_LABELS);
const STATES = ['active', 'needs_review', 'waiting', 'paused', 'done', 'archived'];
const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const iso = value => (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : '');
const count = value => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/**
 * One result row from a ThreadSummary, every field coerced and capped (Threadkeeper is another extension: its answers are
 * validated like any other input). null when the summary has no usable thread key.
 */
export function pickerRow(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const threadKey = typeof summary.threadKey === 'string' ? summary.threadKey.trim() : '';
  if (!threadKey || threadKey.length > 600) return null;
  const category = CATEGORIES.includes(summary.category) ? summary.category : 'chat';
  const provider = /^[a-z0-9_]{1,40}$/.test(summary.provider || '') ? summary.provider : '';
  const excerpt = summary.excerpt && typeof summary.excerpt === 'object' ? text(summary.excerpt.text, 220) : '';
  return {
    threadKey,
    title: text(summary.title, 300) || 'Untitled thread',
    gist: text(summary.gist, 300),
    snippet: excerpt,
    provider,
    providerLabel: text(summary.providerLabel, 80) || provider || 'AI chat',
    category,
    agentLabel: text(summary.agentLabel, 120),
    kindLabel: text(summary.kindLabel, 60),
    project: text(summary.project, 200),
    workflowState: STATES.includes(summary.workflowState) ? summary.workflowState : '',
    updatedAt: iso(summary.updatedAt) || iso(summary.createdAt),
    messageCount: count(summary.messageCount),
    match: summary.match === 'strong' || summary.match === 'weak' ? summary.match : '',
  };
}

/** Facets for the filter controls, validated and capped: { total, providers, projects, kinds }. */
export function pickerFacets(raw) {
  const list = (value, map, max = 200) => (Array.isArray(value) ? value.slice(0, max).map(map).filter(Boolean) : []);
  return {
    total: count(raw?.total),
    providers: list(raw?.providers, entry => (/^[a-z0-9_]{1,40}$/.test(entry?.id || '') ? { id: entry.id, label: text(entry.label, 80) || entry.id,
      category: CATEGORIES.includes(entry.category) ? entry.category : 'chat', count: count(entry.count) } : null)),
    projects: list(raw?.projects, entry => (text(entry?.name, 200) ? { name: text(entry.name, 200), count: count(entry.count) } : null), 500),
    kinds: list(raw?.kinds, entry => (/^[a-z0-9_-]{1,40}$/.test(entry?.id || '') ? { id: entry.id, label: text(entry.label, 60) || entry.id, count: count(entry.count) } : null)),
  };
}

/** Protocol filters from the picker's choices; empty fields are left out. */
export function pickerFilters({ categories = [], providers = [], projects = [], kinds = [] } = {}) {
  const out = {};
  if (categories.length) out.categories = categories.filter(value => CATEGORIES.includes(value));
  if (providers.length) out.providers = providers.slice(0, 50);
  if (projects.length) out.projects = projects.slice(0, 50);
  if (kinds.length) out.kinds = kinds.slice(0, 50);
  return out;
}

/**
 * The Threadkeeper read for the picker's current query: an explicit search (Threadkeeper may use its embedding and rerank
 * providers when the person allowed that) or, with an empty query, the most recent threads.
 */
export function pickerRequest({ query = '', filters = {}, cursor = null } = {}) {
  const words = String(query).trim().slice(0, 500);
  const scope = pickerFilters(filters);
  if (words) {
    return { type: 'threads.search', fields: { query: words, filters: scope, limit: PAGE, semantic: 'auto', rerank: 'auto', excerpts: true, ...(cursor ? { cursor } : {}) },
      timeoutMs: SEARCH_TIMEOUT };
  }
  return { type: 'threads.list', fields: { filters: scope, sort: 'recent', limit: PAGE, ...(cursor ? { cursor } : {}) }, timeoutMs: READ_TIMEOUT };
}

/** Where a thread already is in the library: 'library', 'trash' or ''. */
export function libraryStatus(item) {
  if (!item || item.type !== 'chat') return '';
  return item.deletedAt ? 'trash' : 'library';
}

/** Counts from importThreadkeeperThreads results: { added, updated, unchanged, restored, skipped, reasons, ids }. */
export function importSummary(results = []) {
  const out = { added: 0, updated: 0, unchanged: 0, skipped: 0, reasons: {}, ids: [] };
  for (const result of Array.isArray(results) ? results : []) {
    const status = result?.status;
    const id = typeof result?.id === 'string' ? result.id : typeof result?.itemId === 'string' ? result.itemId : '';
    if (status === 'created') out.added++;
    else if (status === 'updated') out.updated++;
    else if (status === 'unchanged') out.unchanged++;
    else { out.skipped++; const reason = typeof result?.reason === 'string' ? result.reason : 'other'; out.reasons[reason] = (out.reasons[reason] || 0) + 1; }
    if (id && status !== 'skipped') out.ids.push(id);
  }
  return out;
}

const SKIP_REASONS = { dismissed: 'you removed earlier', trashed: 'in Trash', invalid: 'could not be read', stale: 'already newer in Still', out_of_scope: 'outside what you sync',
  too_large: 'too large', missing: 'no longer in Threadkeeper', local_only: 'private in Threadkeeper' };
/** One sentence for the toast after an import. */
export function importMessage(summary, where) {
  const brought = summary.added + summary.updated + summary.unchanged;
  const parts = [];
  if (summary.added) parts.push(`Added ${plural(summary.added, 'chat')} to ${where}`);
  const present = summary.updated + summary.unchanged;
  if (present) parts.push(`${plural(present, 'chat')} ${present === 1 ? 'was' : 'were'} already in Still`);
  if (summary.skipped) {
    const why = Object.entries(summary.reasons).map(([reason, n]) => `${n} ${SKIP_REASONS[reason] || 'skipped'}`).join(', ');
    parts.push(`${plural(summary.skipped, 'thread')} skipped (${why})`);
  }
  if (!brought && !summary.skipped) return 'Nothing was added.';
  return `${parts.join('. ')}.`;
}

/* ------------------------------------------------------------------ dialog state */

// { query, filters, results: [], total, nextCursor, status: 'loading'|'ready'|'error', error, selected: Map(threadKey → row),
//   targetMode: 'auto'|'pick', collectionId, facets, importing: null|{ done, total }, seq, controller, timer, more }
let picker = null;

const emptyFilters = () => ({ categories: [], providers: [], projects: [], kinds: [] });

/**
 * Opens the picker. options: { collectionId } preselects a target collection (the Chats view of a collection, a
 * collection's menu). Without a paired Threadkeeper it says so and offers Settings.
 */
export async function openThreadkeeperPicker(ctx, { collectionId } = {}) {
  let state = null;
  try { state = await client.getThreadkeeperState(); } catch { state = null; }
  if (!ctx.env?.isExtension) { ctx.toast('Threadkeeper works when Still runs as an extension.', { tone: 'warning' }); return; }
  if (!client.isThreadkeeperReady(state)) {
    ctx.toast(state?.status === 'pending' ? 'Finish connecting Threadkeeper first.' : 'Connect Threadkeeper to add your AI chats.', {
      tone: 'warning', action: { label: 'Open settings', run: () => openTkSettings(ctx) } });
    return;
  }
  if ((ctx.state?.dialogs || []).some(dialog => dialog.name === PICKER_DIALOG)) return;
  const current = { query: '', filters: emptyFilters(), results: [], total: 0, nextCursor: null, status: 'loading', error: '', selected: new Map(),
    targetMode: typeof collectionId === 'string' ? 'pick' : 'auto', collectionId: typeof collectionId === 'string' ? collectionId : '',
    facets: null, importing: null, seq: 0, controller: null, timer: 0, more: false };
  picker = current;
  ctx.openDialog(PICKER_DIALOG, { onClose: () => { if (picker === current) { cancelPending(current); picker = null; } } });
  loadFacets(ctx, current);
  await runQuery(ctx, current);
}

async function openTkSettings(ctx) {
  const { openSettings } = await import('./settings.js');
  openSettings(ctx, 'integrations', { anchor: 'settings-threadkeeper' });
}

function cancelPending(p) {
  clearTimeout(p.timer);
  p.controller?.abort();
  p.controller = null;
}

async function loadFacets(ctx, p) {
  try {
    const raw = await client.threadkeeperRequest('facets', {}, { timeoutMs: READ_TIMEOUT });
    if (picker !== p) return;
    p.facets = pickerFacets(raw);
  } catch { if (picker === p) p.facets = pickerFacets(null); }
  ctx.render();
}

/** Runs the current query (append: load the next page of the same query). Answers to older queries are dropped. */
async function runQuery(ctx, p, { append = false } = {}) {
  cancelPending(p);
  const seq = ++p.seq;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  p.controller = controller;
  if (append) p.more = true; else { p.status = 'loading'; p.error = ''; }
  ctx.render();
  const request = pickerRequest({ query: p.query, filters: p.filters, cursor: append ? p.nextCursor : null });
  try {
    const data = await client.threadkeeperRequest(request.type, request.fields, { timeoutMs: request.timeoutMs, signal: controller?.signal });
    if (picker !== p || seq !== p.seq) return;
    const rows = (Array.isArray(data?.results) ? data.results : []).slice(0, 100).map(pickerRow).filter(Boolean);
    const seen = new Set(append ? p.results.map(row => row.threadKey) : []);
    p.results = [...(append ? p.results : []), ...rows.filter(row => !seen.has(row.threadKey) && seen.add(row.threadKey))];
    p.total = Math.max(count(data?.total), p.results.length);
    p.nextCursor = typeof data?.nextCursor === 'string' && data.nextCursor.length <= 2000 ? data.nextCursor : null;
    p.status = 'ready';
  } catch (error) {
    if (picker !== p || seq !== p.seq || error?.name === 'AbortError') return;
    p.status = append ? 'ready' : 'error';
    p.error = errorText(error);
    if (append) ctx.toast(p.error, { tone: 'danger' });
  } finally {
    if (picker === p && seq === p.seq) { p.more = false; p.controller = null; ctx.render(); }
  }
}

function errorText(error) {
  switch (error?.code) {
    case 'unreachable': return 'Threadkeeper is not responding. Check that it is turned on in chrome://extensions, then try again.';
    case 'disabled': return 'Threadkeeper does not let Still search its threads. Turn on “Let Still search my threads” in Threadkeeper → Settings → Sidebar Dock.';
    case 'not_paired': return 'Threadkeeper is no longer connected. Connect it again in Settings → Integrations.';
    case 'busy': return 'Threadkeeper is busy. Try again in a moment.';
    default: return error?.message || 'Threadkeeper could not answer.';
  }
}

/* ------------------------------------------------------------------ rendering */

function providerTile(row) {
  const coding = row.category === 'coding_agent';
  return avatarTile({ label: row.providerLabel, icon: coding ? 'terminal' : undefined, size: 28, color: coding ? 'gray' : 'indigo', className: 'tkp-mark' });
}

function resultRow(ctx, p, row) {
  const item = ctx.select?.byId?.(chatItemId(row.threadKey)) || null;
  const where = libraryStatus(item);
  const selected = p.selected.has(row.threadKey);
  const meta = [row.agentLabel || row.providerLabel, row.project, row.kindLabel, row.messageCount ? plural(row.messageCount, 'message') : '', row.updatedAt ? relativeDate(row.updatedAt) : '']
    .filter(Boolean);
  return html`<li class="${cx('tkp-row', selected && 'is-selected')}" data-key="tkp:${row.threadKey}">
    ${checkbox({ checked: selected, label: `Select ${row.title}`, hideLabel: true, action: 'threadkeeper.picker-toggle', data: { key: row.threadKey }, className: 'tkp-check',
      disabled: !!p.importing })}
    ${providerTile(row)}
    <div class="tkp-text">
      <p class="tkp-title"><span class="tkp-title-text">${row.title}</span>${where === 'library' ? badge({ label: 'In Still', tone: 'success', icon: 'circle-check', className: 'tkp-badge' })
        : where === 'trash' ? badge({ label: 'In Trash', tone: 'neutral', icon: 'trash-2', className: 'tkp-badge' }) : ''}</p>
      ${row.gist || row.snippet ? html`<p class="tkp-gist">${row.gist || row.snippet}</p>` : ''}
      <p class="tkp-meta">${meta.map((part, index) => html`${index ? html`<span class="tkp-sep" aria-hidden="true">·</span>` : ''}<span>${part}</span>`)}</p>
    </div>
  </li>`;
}

function renderFilters(p) {
  const f = p.filters;
  const facets = p.facets;
  const categories = facets ? CATEGORIES.filter(id => facets.providers.some(provider => provider.category === id)) : CATEGORIES;
  const chips = (categories.length > 1 ? categories : []).map(id => chip({ label: CATEGORY_LABELS[id], selected: f.categories.includes(id), action: 'threadkeeper.picker-filter',
    data: { field: 'categories', value: id }, icon: id === 'coding_agent' ? 'terminal' : undefined }));
  const providerOptions = [{ value: '', label: 'Every app' }, ...(facets?.providers || []).map(provider => ({ value: provider.id, label: `${provider.label} (${provider.count.toLocaleString()})` }))];
  const projectOptions = [{ value: '', label: 'Every project' }, ...(facets?.projects || []).map(project => ({ value: project.name, label: `${project.name} (${project.count.toLocaleString()})` }))];
  const kindOptions = [{ value: '', label: 'Every kind' }, ...(facets?.kinds || []).map(kind => ({ value: kind.id, label: kind.label }))];
  return html`<div class="tkp-filters" role="group" aria-label="Filters">
    ${chips.length ? html`<div class="tkp-chips">${chips}</div>` : ''}
    <div class="tkp-selects">
      ${facets?.providers.length ? select({ name: 'providers', value: f.providers[0] || '', options: providerOptions, action: 'threadkeeper.picker-select', label: 'App', size: 'sm', id: 'tkp-provider' }) : ''}
      ${facets?.projects.length ? select({ name: 'projects', value: f.projects[0] || '', options: projectOptions, action: 'threadkeeper.picker-select', label: 'Project', size: 'sm', id: 'tkp-project' }) : ''}
      ${facets?.kinds.length ? select({ name: 'kinds', value: f.kinds[0] || '', options: kindOptions, action: 'threadkeeper.picker-select', label: 'Kind', size: 'sm', id: 'tkp-kind' }) : ''}
    </div>
  </div>`;
}

function renderResults(ctx, p) {
  if (p.status === 'loading' && !p.results.length) {
    return html`<div class="tkp-loading" role="status">${spinner({ size: 16 })}<span>${p.query.trim() ? 'Searching your AI threads' : 'Loading recent threads'}</span></div>`;
  }
  if (p.status === 'error') {
    return emptyState({ icon: 'circle-alert', title: 'Threadkeeper could not answer', body: p.error, compact: true, tone: 'danger',
      actions: button({ label: 'Try again', icon: 'refresh-cw', size: 'sm', action: 'threadkeeper.picker-retry' }) });
  }
  if (!p.results.length) {
    return emptyState({ icon: 'search-x', compact: true, title: p.query.trim() ? 'No threads match' : 'No threads to show',
      body: p.query.trim() ? 'Try other words, or clear a filter.' : 'Threadkeeper has no threads that match these filters, or keeps them private.' });
  }
  const shown = p.results.length;
  const allSelected = p.results.every(row => p.selected.has(row.threadKey));
  return html`<div class="tkp-list-head">
      <span class="tkp-count">${p.total > shown ? `${shown.toLocaleString()} of ${plural(p.total, 'thread')}` : plural(shown, 'thread')}</span>
      ${button({ label: allSelected ? 'Select none' : 'Select all shown', variant: 'link', size: 'sm', action: 'threadkeeper.picker-all', disabled: !!p.importing })}
    </div>
    <ul class="tkp-list" role="list" aria-busy="${p.status === 'loading' ? 'true' : 'false'}">${p.results.map(row => resultRow(ctx, p, row))}</ul>
    ${p.nextCursor ? html`<div class="tkp-more">${button({ label: 'Show more', size: 'sm', variant: 'ghost', action: 'threadkeeper.picker-more', loading: p.more })}</div>` : ''}`;
}

function renderTarget(ctx, p) {
  return html`<div class="tkp-target">
    <span class="tkp-label" id="tkp-target-label">Put them in</span>
    <div class="tkp-target-control">
      ${segmented({ name: 'tkp-target', value: p.targetMode, action: 'threadkeeper.picker-target-mode', size: 'sm', ariaLabel: 'Put them in',
        options: [{ value: 'auto', label: 'Where synced chats go', icon: 'folder-tree' }, { value: 'pick', label: 'A collection', icon: 'folder' }] })}
      ${p.targetMode === 'pick' ? renderCollectionPickerTrigger({ ctx, value: p.collectionId, action: 'threadkeeper.picker-target', id: 'tkp-collection', label: 'Put them in', size: 'sm' }) : ''}
    </div>
  </div>`;
}

function renderPicker(ctx) {
  const p = picker;
  if (!p) return '';
  const n = p.selected.size;
  const job = p.importing;
  const body = html`<div class="tkp-search">
      ${input({ id: 'tkp-query', type: 'search', value: p.query, placeholder: 'Search threads: a topic, a file, a decision…', icon: 'search', action: 'threadkeeper.picker-query',
        keydown: 'threadkeeper.picker-key', label: 'Search your AI threads', autofocus: true })}
    </div>
    ${renderFilters(p)}
    <div class="tkp-results">${renderResults(ctx, p)}</div>
    ${renderTarget(ctx, p)}
    ${job ? html`<p class="tkp-progress" role="status">${spinner({ size: 14 })}<span>Adding ${job.done.toLocaleString()} of ${plural(job.total, 'chat')}…</span></p>` : ''}`;
  const footer = html`<p class="tkp-foot-note">${n ? `${plural(n, 'thread')} selected` : 'Select the threads to add.'}</p>
    ${button({ label: 'Cancel', variant: 'ghost', action: 'overlay.dismiss' })}
    ${button({ label: n ? `Add ${plural(n, 'chat')}` : 'Add chats', variant: 'primary', icon: 'plus', action: 'threadkeeper.picker-import', disabled: !n || !!job, loading: !!job,
      tooltip: `Add (${shortcutLabel('mod+enter')})`, attrs: { 'aria-keyshortcuts': keyshortcuts('mod+enter') } })}`;
  return html`<header class="dialog-header"><div class="dialog-heading"><h2 class="dialog-title" id="dialog-title-${PICKER_DIALOG}">Add AI chats</h2>
      <p class="dialog-subtitle">Copy threads from Threadkeeper into Still. They keep updating while Threadkeeper is connected.</p></div>
      ${iconButton({ icon: 'x', label: 'Close', action: 'overlay.dismiss', size: 'sm', className: 'dialog-close' })}</header>
    <div class="dialog-body tkp-body" data-keydown="threadkeeper.picker-dialog-key">${body}</div>
    <footer class="dialog-footer tkp-footer">${footer}</footer>`;
}

registerDialog(PICKER_DIALOG, renderPicker, { size: 'lg', className: 'tkp-dialog' });
/** The dialog body, for tests. */
export const renderThreadkeeperPicker = ctx => renderPicker(ctx);

/* ------------------------------------------------------------------ import */

async function importSelected(ctx) {
  const p = picker;
  if (!p || p.importing || !p.selected.size) return;
  const keys = [...p.selected.keys()];
  const target = p.targetMode === 'pick' ? { collectionId: p.collectionId || '' } : undefined;
  p.importing = { done: 0, total: keys.length };
  ctx.render();
  const results = [];
  try {
    for (let index = 0; index < keys.length; index += IMPORT_BATCH) {
      const batch = keys.slice(index, index + IMPORT_BATCH);
      const answer = await client.importThreadkeeperThreads(batch, { ...(target ? { target } : {}), origin: 'manual' });
      results.push(...(Array.isArray(answer?.results) ? answer.results : []));
      if (picker === p) { p.importing = { done: Math.min(keys.length, index + batch.length), total: keys.length }; ctx.render(); }
    }
  } catch (error) {
    if (picker === p) { p.importing = null; ctx.render(); }
    const summary = importSummary(results);
    throw new Error(summary.added ? `${importMessage(summary, 'Still')} The rest stopped: ${errorText(error)}` : errorText(error));
  }
  const summary = importSummary(results);
  const where = target ? collectionName(ctx, target.collectionId) : 'Still';
  if (picker === p) { picker = null; ctx.closeDialog(PICKER_DIALOG); }
  const single = summary.ids.length === 1 ? summary.ids[0] : '';
  const open = single ? { label: 'Open', run: () => ctx.openItem(single) }
    : target?.collectionId ? { label: 'Open', run: () => ctx.navigate(`collection:${target.collectionId}`) }
    : summary.ids.length ? { label: 'Open', run: () => ctx.navigate('chats') } : null;
  ctx.toast(importMessage(summary, where), { tone: summary.skipped && !summary.ids.length ? 'warning' : 'success', action: open });
}

function collectionName(ctx, id) {
  if (!id) return 'Inbox';
  return ctx.select?.collection?.(id)?.name || 'the collection';
}

/* ------------------------------------------------------------------ actions */

function toggleFilter(p, field, value) {
  const list = p.filters[field];
  if (!Array.isArray(list)) return;
  p.filters[field] = list.includes(value) ? list.filter(entry => entry !== value) : [...list, value];
}

registerActions({
  'threadkeeper.picker-open': ({ ctx, data }) => openThreadkeeperPicker(ctx, typeof data?.collectionId === 'string' ? { collectionId: data.collectionId } : {}),
  'threadkeeper.picker-query': ({ ctx, el }) => {
    const p = picker;
    if (!p) return;
    p.query = String(el.value || '');
    clearTimeout(p.timer);
    p.timer = setTimeout(() => runQuery(ctx, p), DEBOUNCE);
  },
  'threadkeeper.picker-key': ({ ctx, el, event }) => {
    const p = picker;
    if (!p || event?.key !== 'Enter' || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    p.query = String(el.value || '');
    runQuery(ctx, p);
  },
  'threadkeeper.picker-dialog-key': ({ ctx, event }) => {
    if (event?.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); return importSelected(ctx); }
    return undefined;
  },
  'threadkeeper.picker-filter': ({ ctx, data }) => {
    const p = picker;
    if (!p) return;
    toggleFilter(p, data.field, data.value);
    runQuery(ctx, p);
  },
  'threadkeeper.picker-select': ({ ctx, el }) => {
    const p = picker;
    if (!p || !['providers', 'projects', 'kinds'].includes(el?.name)) return;
    p.filters[el.name] = el.value ? [String(el.value)] : [];
    runQuery(ctx, p);
  },
  'threadkeeper.picker-retry': ({ ctx }) => { if (picker) runQuery(ctx, picker); },
  'threadkeeper.picker-more': ({ ctx }) => { if (picker?.nextCursor && !picker.more) runQuery(ctx, picker, { append: true }); },
  'threadkeeper.picker-toggle': ({ ctx, data }) => {
    const p = picker;
    if (!p || p.importing) return;
    if (p.selected.has(data.key)) p.selected.delete(data.key);
    else { const row = p.results.find(entry => entry.threadKey === data.key); if (row) p.selected.set(row.threadKey, row); }
    ctx.render();
  },
  'threadkeeper.picker-all': ({ ctx }) => {
    const p = picker;
    if (!p || p.importing) return;
    const all = p.results.every(row => p.selected.has(row.threadKey));
    for (const row of p.results) { if (all) p.selected.delete(row.threadKey); else p.selected.set(row.threadKey, row); }
    ctx.render();
  },
  'threadkeeper.picker-target-mode': ({ ctx, data }) => {
    if (!picker || !['auto', 'pick'].includes(data.value)) return;
    picker.targetMode = data.value;
    ctx.render();
  },
  'threadkeeper.picker-target': ({ ctx, data }) => {
    if (!picker) return;
    picker.collectionId = typeof data.value === 'string' ? data.value : '';
    ctx.render();
  },
  'threadkeeper.picker-import': ({ ctx }) => importSelected(ctx),
});

/** The open picker's state, for tests. */
export const pickerState = () => picker;
