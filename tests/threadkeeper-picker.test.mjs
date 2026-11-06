// "Add AI chats from Threadkeeper" picker (design §6): validated rows, the reads it sends, selection, target and import.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickerRow, pickerFacets, pickerFilters, pickerRequest, libraryStatus, importSummary, importMessage, openThreadkeeperPicker, renderThreadkeeperPicker,
  pickerState, useThreadkeeperClient, PICKER_DIALOG, CATEGORY_LABELS,
} from '../extension/ui/threadkeeper-picker.js';
import { chatItemId } from '../extension/lib/threadkeeper/protocol.js';
import { ThreadkeeperError } from '../extension/lib/threadkeeper/protocol.js';

const { dispatch } = await import('../extension/ui/runtime.js');
const flat = value => String(value).replace(/\s+/g, ' ');
const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };

const summary = (n, patch = {}) => ({ threadKey: `chatgpt:acct:ws:t${n}:main`, hash: 'x', title: `Thread ${n}`, gist: `Gist ${n}`, provider: 'chatgpt', providerLabel: 'ChatGPT',
  category: 'chat', agentLabel: '', kind: 'coding', kindLabel: 'Building', project: 'Website', workflowState: 'active', createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-02T10:00:00Z', messageCount: 12, url: '', ...patch });

function fakeClient({ status = 'paired', pages = null, facets = { total: 3, providers: [{ id: 'chatgpt', label: 'ChatGPT', category: 'chat', count: 2 }, { id: 'codex', label: 'Codex', category: 'coding_agent', count: 1 }],
  projects: [{ name: 'Website', count: 3 }], kinds: [{ id: 'coding', label: 'Building', count: 3 }] }, importResults = null, failWith = null } = {}) {
  const calls = [];
  return {
    calls,
    async getThreadkeeperState() { return { status, prefs: {} }; },
    isThreadkeeperReady: state => state?.status === 'paired',
    async threadkeeperRequest(type, fields, options) {
      calls.push(['request', type, structuredClone(fields), options?.timeoutMs]);
      if (failWith) throw failWith;
      if (type === 'facets') return facets;
      if (pages) return pages(type, fields);
      return { results: [summary(1), summary(2), summary(3)], total: 3, nextCursor: null };
    },
    async importThreadkeeperThreads(keys, options) {
      calls.push(['import', [...keys], structuredClone(options)]);
      if (importResults) return importResults(keys);
      return { results: keys.map(threadKey => ({ threadKey, id: chatItemId(threadKey), status: 'created' })) };
    },
  };
}

function makeCtx({ items = [], collections = [], extension = true } = {}) {
  const toasts = [];
  const navigated = [];
  const opened = [];
  const ctx = {
    library: { items, collections, settings: {} }, env: { isExtension: extension, isSidepanel: false },
    select: { byId: id => items.find(item => item.id === id) || null, collection: id => collections.find(c => c.id === id) || null, path: id => collections.filter(c => c.id === id), tree: () => [] },
    state: { dialogs: [], popover: null }, toasts, navigated, opened,
    render() {}, nextFrame() {}, toast: (message, options) => toasts.push({ message, tone: options?.tone, action: options?.action }),
    openDialog(name, props) { ctx.state.dialogs.push({ name, props }); },
    closeDialog(name) { const entry = ctx.state.dialogs.find(d => d.name === name); ctx.state.dialogs = ctx.state.dialogs.filter(d => d !== entry); entry?.props?.onClose?.(); },
    navigate: view => navigated.push(view), openItem: id => opened.push(id),
  };
  return ctx;
}

test.afterEach(() => {
  const open = pickerState();
  if (open) open.seq++; // drop answers still in flight
  useThreadkeeperClient(null);
});

/* ------------------------------------------------------------------ pure helpers */

test('pickerRow validates and caps everything Threadkeeper sends', () => {
  const row = pickerRow(summary(1, { title: `  A\u0000title‮ with\ncontrols ${'x'.repeat(400)}`, provider: 'Not An Id', category: 'spaceship', workflowState: 'exploded',
    updatedAt: 'yesterday', createdAt: '2026-10-01T10:00:00Z', messageCount: -4, excerpt: { text: 'snippet', messageIndex: 3, role: 'user' }, match: 'strong' }));
  assert.equal(row.title.length, 300);
  assert.ok(row.title.startsWith('A title with controls'));
  assert.equal(row.provider, '');
  assert.equal(row.category, 'chat');
  assert.equal(row.workflowState, '');
  assert.equal(row.updatedAt, '2026-10-01T10:00:00Z', 'falls back to createdAt');
  assert.equal(row.messageCount, 0);
  assert.equal(row.snippet, 'snippet');
  assert.equal(row.match, 'strong');
  for (const bad of [null, 'x', {}, { threadKey: '' }, { threadKey: 'k'.repeat(601) }, { threadKey: 7 }]) assert.equal(pickerRow(bad), null);
  assert.equal(pickerRow({ threadKey: 'k' }).title, 'Untitled thread');
});

test('pickerFacets keeps well-formed entries only', () => {
  const facets = pickerFacets({ total: 9.7, providers: [{ id: 'chatgpt', label: 'ChatGPT', category: 'chat', count: 3 }, { id: 'BAD ID', count: 1 }, null],
    projects: [{ name: ' Web ', count: 2 }, { name: '', count: 1 }], kinds: [{ id: 'coding', label: '', count: 1 }] });
  assert.equal(facets.total, 9);
  assert.deepEqual(facets.providers.map(p => p.id), ['chatgpt']);
  assert.deepEqual(facets.projects, [{ name: 'Web', count: 2 }]);
  assert.deepEqual(facets.kinds, [{ id: 'coding', label: 'coding', count: 1 }]);
  assert.deepEqual(pickerFacets(null), { total: 0, providers: [], projects: [], kinds: [] });
});

test('pickerRequest: words search (explicit, may use remote models), no words lists recent threads', () => {
  assert.deepEqual(pickerRequest({ query: '  stripe webhooks ', filters: { categories: ['coding_agent', 'nonsense'], providers: [], projects: ['Website'] } }), {
    type: 'threads.search', timeoutMs: 15000,
    fields: { query: 'stripe webhooks', filters: { categories: ['coding_agent'], projects: ['Website'] }, limit: 30, semantic: 'auto', rerank: 'auto', excerpts: true } });
  assert.deepEqual(pickerRequest({}), { type: 'threads.list', timeoutMs: 10000, fields: { filters: {}, sort: 'recent', limit: 30 } });
  assert.equal(pickerRequest({ query: '', cursor: 'c2' }).fields.cursor, 'c2');
  assert.deepEqual(pickerFilters({ kinds: ['coding'] }), { kinds: ['coding'] });
  assert.deepEqual(Object.keys(CATEGORY_LABELS), ['chat', 'coding_agent', 'agent', 'builder', 'search', 'companion']);
});

test('libraryStatus, importSummary and importMessage', () => {
  assert.equal(libraryStatus(null), '');
  assert.equal(libraryStatus({ type: 'note' }), '');
  assert.equal(libraryStatus({ type: 'chat' }), 'library');
  assert.equal(libraryStatus({ type: 'chat', deletedAt: '2026-01-01T00:00:00Z' }), 'trash');
  const results = [{ threadKey: 'a', id: 'chat_tk_a', status: 'created' }, { threadKey: 'b', itemId: 'chat_tk_b', status: 'created' }, { threadKey: 'c', id: 'chat_tk_c', status: 'unchanged' },
    { threadKey: 'd', status: 'skipped', reason: 'missing' }, { threadKey: 'e', status: 'skipped', reason: 'local_only' }];
  const counts = importSummary(results);
  assert.deepEqual(counts, { added: 2, updated: 0, unchanged: 1, skipped: 2, reasons: { missing: 1, local_only: 1 }, ids: ['chat_tk_a', 'chat_tk_b', 'chat_tk_c'] });
  assert.equal(importMessage(counts, 'Research'), 'Added 2 chats to Research. 1 chat was already in Still. 2 threads skipped (1 no longer in Threadkeeper, 1 private in Threadkeeper).');
  assert.equal(importMessage(importSummary([]), 'Inbox'), 'Nothing was added.');
});

/* ------------------------------------------------------------------ opening */

test('without a paired Threadkeeper the picker points to Settings instead of opening', async () => {
  useThreadkeeperClient(fakeClient({ status: 'off' }));
  const ctx = makeCtx();
  await openThreadkeeperPicker(ctx);
  assert.equal(ctx.state.dialogs.length, 0);
  assert.match(ctx.toasts[0].message, /Connect Threadkeeper/);
  assert.equal(ctx.toasts[0].action.label, 'Open settings');
  useThreadkeeperClient(fakeClient({ status: 'pending' }));
  await openThreadkeeperPicker(ctx);
  assert.match(ctx.toasts[1].message, /Finish connecting/);
  const preview = makeCtx({ extension: false });
  await openThreadkeeperPicker(preview);
  assert.match(preview.toasts[0].message, /works when Still runs as an extension/);
});

test('opens with recent threads, filters from facets, and marks threads already in Still or in Trash', async () => {
  const client = fakeClient();
  const items = [{ id: chatItemId(summary(1).threadKey), type: 'chat', chat: {} }, { id: chatItemId(summary(2).threadKey), type: 'chat', chat: {}, deletedAt: '2026-10-03T00:00:00Z' }];
  useThreadkeeperClient(client);
  const ctx = makeCtx({ items });
  await dispatch('threadkeeper.picker-open', { ctx, el: {}, data: {} });
  await settle();
  assert.equal(ctx.state.dialogs[0].name, PICKER_DIALOG);
  assert.deepEqual(client.calls.map(call => call[1]).sort(), ['facets', 'threads.list']);
  const out = flat(renderThreadkeeperPicker(ctx));
  assert.match(out, /<h2 class="dialog-title" id="dialog-title-threadkeeper\.picker">Add AI chats<\/h2>/);
  assert.equal((out.match(/class="tkp-row/g) || []).length, 3);
  assert.equal((out.match(/>In Still</g) || []).length, 1);
  assert.equal((out.match(/>In Trash</g) || []).length, 1);
  assert.match(out, /ChatGPT<\/span><span class="tkp-sep" aria-hidden="true">·<\/span><span>Website/);
  assert.match(out, /12 messages/);
  assert.match(out, /data-value="coding_agent" aria-pressed="false"/, 'category chips come from the providers Threadkeeper has');
  assert.match(out, /<span class="chip-label">Coding agents<\/span>/);
  assert.ok(!out.includes('>Companions<'));
  assert.match(out, /aria-label="App"/);
  assert.match(out, /aria-label="Project"/);
  assert.match(out, /data-action="threadkeeper\.picker-import"[^>]*disabled/, 'nothing selected yet');
  assert.match(out, /Where synced chats go/);
});

test('thread text is escaped, never markup', async () => {
  useThreadkeeperClient(fakeClient({ pages: () => ({ results: [summary(1, { title: '<img src=x onerror=alert(1)>', gist: '<script>alert(1)</script>', project: '"><b>p</b>' })], total: 1 }) }));
  const ctx = makeCtx();
  await openThreadkeeperPicker(ctx);
  await settle();
  const out = flat(renderThreadkeeperPicker(ctx));
  assert.ok(!out.includes('<img src=x') && !out.includes('<script>') && !out.includes('<b>p</b>'));
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('typing searches after a pause; Enter searches at once; older answers never overwrite newer ones', async () => {
  const resolvers = [];
  const client = fakeClient({ pages: (type, fields) => new Promise(resolve => resolvers.push(() => resolve({ results: [summary(fields.query === 'new' ? 9 : 8)], total: 1 }))) });
  useThreadkeeperClient(client);
  const ctx = makeCtx();
  const opening = openThreadkeeperPicker(ctx);
  await settle();
  resolvers.shift()();
  await opening;
  await dispatch('threadkeeper.picker-key', { ctx, el: { value: 'old' }, event: { key: 'Enter', preventDefault() {} }, data: {} });
  await dispatch('threadkeeper.picker-key', { ctx, el: { value: 'new' }, event: { key: 'Enter', preventDefault() {} }, data: {} });
  const searches = client.calls.filter(call => call[1] === 'threads.search');
  assert.deepEqual(searches.map(call => call[2].query), ['old', 'new']);
  assert.equal(searches[0][3], 15000);
  resolvers.at(-1)(); // "new" answers first
  await settle();
  resolvers.at(-2)(); // then the stale "old"
  await settle();
  assert.deepEqual(pickerState().results.map(row => row.title), ['Thread 9']);
  // The debounced input path.
  await dispatch('threadkeeper.picker-query', { ctx, el: { value: 'later' }, data: {} });
  assert.equal(client.calls.filter(call => call[1] === 'threads.search').length, 2, 'waits for the pause');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(client.calls.filter(call => call[1] === 'threads.search').at(-1)[2].query, 'later');
});

test('filters re-run the read; Show more appends the next page without duplicates', async () => {
  const client = fakeClient({ pages: (type, fields) => (fields.cursor ? { results: [summary(3), summary(4)], total: 4, nextCursor: null } : { results: [summary(1), summary(2), summary(3)], total: 4, nextCursor: 'p2' }) });
  useThreadkeeperClient(client);
  const ctx = makeCtx();
  await openThreadkeeperPicker(ctx);
  await settle();
  assert.match(flat(renderThreadkeeperPicker(ctx)), /3 of 4 threads/);
  await dispatch('threadkeeper.picker-more', { ctx, el: {}, data: {} });
  await settle();
  assert.deepEqual(pickerState().results.map(row => row.title), ['Thread 1', 'Thread 2', 'Thread 3', 'Thread 4']);
  assert.ok(!flat(renderThreadkeeperPicker(ctx)).includes('threadkeeper.picker-more'));
  await dispatch('threadkeeper.picker-filter', { ctx, el: {}, data: { field: 'categories', value: 'coding_agent' } });
  await dispatch('threadkeeper.picker-select', { ctx, el: { name: 'projects', value: 'Website' }, data: {} });
  await dispatch('threadkeeper.picker-select', { ctx, el: { name: 'evil', value: 'x' }, data: {} });
  await settle();
  const last = client.calls.filter(call => call[1] === 'threads.list').at(-1);
  assert.deepEqual(last[2].filters, { categories: ['coding_agent'], projects: ['Website'] });
});

test('errors show a calm message with Try again', async () => {
  useThreadkeeperClient(fakeClient({ failWith: new ThreadkeeperError('disabled', 'off') }));
  const ctx = makeCtx();
  await openThreadkeeperPicker(ctx);
  await settle();
  const out = flat(renderThreadkeeperPicker(ctx));
  assert.match(out, /Threadkeeper could not answer/);
  assert.match(out, /Let Still search my threads/);
  assert.match(out, /data-action="threadkeeper\.picker-retry"/);
});

test('select, select all and import into Still’s usual place or a chosen collection', async () => {
  const client = fakeClient();
  useThreadkeeperClient(client);
  const ctx = makeCtx({ collections: [{ id: 'c1', name: 'Research' }] });
  await openThreadkeeperPicker(ctx);
  await settle();
  await dispatch('threadkeeper.picker-toggle', { ctx, el: {}, data: { key: summary(2).threadKey } });
  await dispatch('threadkeeper.picker-toggle', { ctx, el: {}, data: { key: 'not-shown' } });
  assert.deepEqual([...pickerState().selected.keys()], [summary(2).threadKey]);
  let out = flat(renderThreadkeeperPicker(ctx));
  assert.match(out, /Add 1 chat/);
  assert.match(out, /1 thread selected/);
  await dispatch('threadkeeper.picker-all', { ctx, el: {}, data: {} });
  assert.equal(pickerState().selected.size, 3);
  assert.match(flat(renderThreadkeeperPicker(ctx)), /Select none/);
  await dispatch('threadkeeper.picker-target-mode', { ctx, el: {}, data: { value: 'pick' } });
  await dispatch('threadkeeper.picker-target', { ctx, el: {}, data: { value: 'c1' } });
  out = flat(renderThreadkeeperPicker(ctx));
  assert.match(out, /pick\.collection-open/);
  await dispatch('threadkeeper.picker-import', { ctx, el: {}, data: {} });
  const [, keys, options] = client.calls.find(call => call[0] === 'import');
  assert.equal(keys.length, 3);
  assert.deepEqual(options, { target: { collectionId: 'c1' }, origin: 'manual' });
  assert.equal(ctx.state.dialogs.length, 0, 'closes after importing');
  assert.equal(pickerState(), null);
  assert.equal(ctx.toasts.at(-1).message, 'Added 3 chats to Research.');
  ctx.toasts.at(-1).action.run();
  assert.deepEqual(ctx.navigated, ['collection:c1']);

  await openThreadkeeperPicker(ctx);
  await settle();
  await dispatch('threadkeeper.picker-toggle', { ctx, el: {}, data: { key: summary(1).threadKey } });
  await dispatch('threadkeeper.picker-dialog-key', { ctx, el: {}, event: { key: 'Enter', ctrlKey: true, preventDefault() {} }, data: {} });
  assert.deepEqual(client.calls.filter(call => call[0] === 'import').at(-1)[2], { origin: 'manual' }, 'no target: Still’s usual placement');
  ctx.toasts.at(-1).action.run();
  assert.deepEqual(ctx.opened, [chatItemId(summary(1).threadKey)], 'one chat opens directly');
});

test('large selections import in batches of 200 with progress; a failure keeps the dialog open', async () => {
  const many = Array.from({ length: 450 }, (_, n) => summary(n));
  let fail = false;
  const client = fakeClient({ pages: () => ({ results: many.slice(0, 100), total: 450 }),
    importResults: keys => { if (fail) throw new ThreadkeeperError('unreachable', 'gone'); return { results: keys.map(threadKey => ({ threadKey, id: chatItemId(threadKey), status: 'created' })) }; } });
  useThreadkeeperClient(client);
  const ctx = makeCtx();
  await openThreadkeeperPicker(ctx);
  await settle();
  for (const row of many) pickerState().selected.set(row.threadKey, pickerRow(row));
  await dispatch('threadkeeper.picker-import', { ctx, el: {}, data: {} });
  assert.deepEqual(client.calls.filter(call => call[0] === 'import').map(call => call[1].length), [200, 200, 50]);
  assert.equal(ctx.toasts.at(-1).message, 'Added 450 chats to Still.');
  ctx.toasts.at(-1).action.run();
  assert.deepEqual(ctx.navigated, ['chats']);

  await openThreadkeeperPicker(ctx);
  await settle();
  pickerState().selected.set(many[0].threadKey, pickerRow(many[0]));
  fail = true;
  await assert.rejects(dispatch('threadkeeper.picker-import', { ctx, el: {}, data: {} }), /not responding/);
  assert.equal(ctx.state.dialogs.length, 1);
  assert.equal(pickerState().importing, null);
});
