// Settings → Integrations → AI chat threads (design §6, review R.1/R.6/R.7): pure helpers, every connection state,
// the Choose-what-to-sync step, live preferences with their confirms, disconnect, search and catalog wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetIds, renderFiltered } from '../extension/ui/settings/parts.js';
import { searchTerms, normalizeSection, matchSections, sectionById } from '../extension/ui/settings/catalog.js';
import {
  threadkeeperStatus, pairingCode, pendingExpired, isConfigured, hasCapability, readPrefs, threadkeeperPrefPatch, toggleListPref, mergePrefs,
  isUserTouchedChat, inScope, chatsLeavingScope, placedChats, changesPlacement, syncPreview, backfillProgress, PREF_DEFAULTS, ANCHOR,
  renderThreadkeeper, attachThreadkeeper, detachThreadkeeper, resetThreadkeeperSettings, threadkeeperSettingsState, renderDisconnectDialog,
} from '../extension/ui/settings/threadkeeper.js';
import { useThreadkeeperClient } from '../extension/ui/threadkeeper-picker.js';
import { ThreadkeeperError } from '../extension/lib/threadkeeper/protocol.js';

const { renderSettingsPage } = await import('../extension/ui/settings.js');
const { dispatch } = await import('../extension/ui/runtime.js');

const flat = value => String(value).replace(/\s+/g, ' ');
const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
const TK_ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();

const baseState = (patch = {}) => ({
  version: 1, extensionId: '', status: 'off', pending: null, tk: { version: '', capabilities: [] }, pairedAt: '', lastSeenAt: '', lastSyncAt: '', lastError: '', lastErrorAt: '',
  counts: { created: 0, updated: 0, removed: 0 }, prefs: structuredClone({ ...PREF_DEFAULTS, assistant: { ...PREF_DEFAULTS.assistant } }), configured: false, configDirty: false, backfill: null, epoch: 'e1',
  ...patch,
});
const paired = (patch = {}) => baseState({ status: 'paired', extensionId: TK_ID, pairedAt: iso(-60000), tk: { version: '0.5.0', capabilities: ['sync', 'search', 'context', 'transcripts'] }, configured: true, ...patch });

const FACETS = {
  total: 120,
  providers: [{ id: 'chatgpt', label: 'ChatGPT', category: 'chat', count: 80 }, { id: 'claude_code', label: 'Claude Code', category: 'coding_agent', count: 40 }],
  projects: [{ name: 'Website', count: 50 }, { name: 'Research', count: 40 }, { name: 'Unfiled', count: 30 }],
  kinds: [{ id: 'coding', label: 'Building', count: 30 }], states: [],
};

/** A page client double that records every call and answers like lib/threadkeeper/client.js. */
function fakeClient(initial = baseState(), { discovered = [], facets = FACETS, failRequests = null } = {}) {
  let state = structuredClone(initial);
  const calls = [];
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) fn(structuredClone(state)); };
  return {
    calls,
    get state() { return state; },
    set(next) { state = structuredClone(next); emit(); },
    async getThreadkeeperState() { return structuredClone(state); },
    onThreadkeeperChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async discoverThreadkeeper() { calls.push(['discover']); return structuredClone(discovered); },
    async connectThreadkeeper(id) {
      calls.push(['connect', id]);
      state = { ...state, status: 'pending', extensionId: id, pending: { requestId: 'req1', extensionId: id, at: iso(), code: '042917' } };
      return { status: 'pending' };
    },
    async disconnectThreadkeeper(options) { calls.push(['disconnect', options]); state = { ...state, status: 'off', extensionId: '', pending: null }; return { status: 'off' }; },
    async setThreadkeeperPrefs(patch, options) {
      calls.push(['setPrefs', structuredClone(patch), options ? structuredClone(options) : undefined]);
      state = { ...state, prefs: { ...state.prefs, ...patch }, configured: options?.start ? true : state.configured,
        backfill: options?.pause !== undefined && state.backfill ? { ...state.backfill, paused: options.pause } : state.backfill };
      return structuredClone(state);
    },
    async syncThreadkeeperNow() { calls.push(['sync']); return { queued: 3 }; },
    async threadkeeperRequest(type, fields, options) {
      calls.push(['request', type, fields, options]);
      if (failRequests) throw failRequests;
      if (type === 'facets') return structuredClone(facets);
      if (type === 'sync.status') return { queued: 0, tracked: 2, lastPushAt: null, lastError: '' };
      return {};
    },
    isThreadkeeperReady: s => s?.status === 'paired',
  };
}

function makeCtx({ items = [], collections = [], extension = true, side = false, confirm = async () => true, query = '' } = {}) {
  const toasts = [];
  const dialogs = [];
  const confirms = [];
  const ctx = {
    library: { items, collections, settings: {} }, select: { counts: () => ({}), collection: id => collections.find(c => c.id === id) || null, byId: id => items.find(i => i.id === id) || null,
      path: id => collections.filter(c => c.id === id), tree: () => [] },
    env: { isExtension: extension, isSidepanel: side }, prefs: { get: (key, fallback) => fallback },
    state: { view: side ? 'dashboard' : 'settings:integrations', shell: {}, settings: { section: 'integrations', list: false, query, open: new Set() }, dialogs, popover: null },
    toasts, confirms, renders: 0,
    render() { ctx.renders++; }, nextFrame() {}, toast: (message, options) => toasts.push([message, options?.tone, options?.action]),
    confirm: async options => { confirms.push(options); return confirm(options); },
    openDialog: (name, props) => dialogs.push({ name, props }), closeDialog: name => { const at = dialogs.findLastIndex(d => !name || d.name === name); if (at >= 0) dialogs.splice(at, 1); },
    run: async fn => fn(),
  };
  return ctx;
}

async function mount(client, options) {
  resetThreadkeeperSettings();
  useThreadkeeperClient(client);
  const ctx = makeCtx(options);
  attachThreadkeeper(ctx);
  await settle();
  return ctx;
}
const card = ctx => { resetIds(); return flat(renderThreadkeeper(ctx)); };

const chat = (id, chatPatch = {}, patch = {}) => ({ id, type: 'chat', title: id, collectionId: 'c_auto', tags: [], content: '', favorite: false, createdAt: iso(), updatedAt: iso(),
  chat: { v: 1, source: 'threadkeeper', threadKey: `k:${id}`, provider: 'chatgpt', project: 'Website', origin: 'sync', removed: '', autoCollectionId: 'c_auto', syncedTags: [], ...chatPatch }, ...patch });

test.afterEach(() => { detachThreadkeeper(); useThreadkeeperClient(null); delete globalThis.chrome; });

/* ------------------------------------------------------------------ pure helpers */

test('threadkeeperStatus names every state the card can be in', () => {
  assert.equal(threadkeeperStatus(null).label, 'Not connected');
  assert.equal(threadkeeperStatus(baseState()).label, 'Not connected');
  assert.equal(threadkeeperStatus(baseState(), { looking: true }).label, 'Looking for Threadkeeper…');
  const pending = baseState({ status: 'pending', pending: { requestId: 'r', extensionId: TK_ID, at: iso(-1000), code: '123456' } });
  assert.equal(threadkeeperStatus(pending).label, 'Waiting for you to allow it in Threadkeeper');
  assert.equal(threadkeeperStatus({ ...pending, pending: { ...pending.pending, at: iso(-11 * 60000) } }).label, 'Request expired');
  const connected = threadkeeperStatus(paired());
  assert.deepEqual([connected.label, connected.tone, connected.detail], ['Connected', 'success', 'Threadkeeper 0.5.0']);
  const silent = threadkeeperStatus(paired(), { reachable: false });
  assert.equal(silent.label, 'Not responding');
  assert.match(silent.detail, /Your chats stay available/);
  assert.equal(threadkeeperStatus(baseState({ status: 'denied' })).label, 'Denied in Threadkeeper');
  assert.equal(threadkeeperStatus(baseState({ status: 'revoked' })).label, 'Disconnected');
});

test('pairing code, expiry, configured and capabilities read the state defensively', () => {
  assert.equal(pairingCode({ pending: { code: '042917' } }), '042 917');
  assert.equal(pairingCode({ pending: { code: '42917' } }), '');
  assert.equal(pairingCode({ pending: { code: '<b>12</b>' } }), '');
  assert.equal(pairingCode(null), '');
  assert.ok(pendingExpired({ status: 'pending', pending: { at: 'nonsense' } }));
  assert.ok(!pendingExpired({ status: 'pending', pending: { at: iso(-9 * 60000) } }));
  assert.ok(pendingExpired({ status: 'pending', pending: { at: iso(-10 * 60000 - 1000) } }));
  assert.ok(!pendingExpired({ status: 'paired', pending: null }));
  assert.ok(isConfigured(paired()));
  assert.ok(!isConfigured(paired({ configured: false })));
  assert.ok(!isConfigured(baseState({ configured: true })));
  assert.ok(hasCapability(paired(), 'search'));
  assert.ok(!hasCapability(paired(), 'remote_models'));
  assert.ok(!hasCapability({ tk: { capabilities: 'search' } }, 'search'));
});

test('readPrefs fills defaults and drops odd values', () => {
  assert.deepEqual(readPrefs(null), { ...PREF_DEFAULTS, projects: [], providers: [], assistant: { ...PREF_DEFAULTS.assistant } });
  const p = readPrefs({ scope: 'everything', projects: ['A', 'A', ' ', 7, 'B '], placement: 'single', parentName: '  ', transcripts: 'no', assistant: { context: 'loud', decision: false } });
  assert.equal(p.scope, 'all');
  assert.deepEqual(p.projects, ['A', 'B']);
  assert.equal(p.placement, 'single');
  assert.equal(p.parentName, 'AI chats');
  assert.equal(p.transcripts, true);
  assert.deepEqual(p.assistant, { search: true, context: 'auto', decision: false });
});

test('threadkeeperPrefPatch writes only the controls the card offers, as the right type', () => {
  assert.deepEqual(threadkeeperPrefPatch('scope', 'projects'), { scope: 'projects' });
  assert.equal(threadkeeperPrefPatch('scope', 'some'), null);
  assert.deepEqual(threadkeeperPrefPatch('transcripts', false), { transcripts: false });
  assert.equal(threadkeeperPrefPatch('transcripts', 'false'), null);
  assert.deepEqual(threadkeeperPrefPatch('parentName', '  My   AI\nchats '), { parentName: 'My AI chats' });
  assert.throws(() => threadkeeperPrefPatch('parentName', '   '), /Give the collection/);
  assert.throws(() => threadkeeperPrefPatch('parentName', 'x'.repeat(81)), /under 80/);
  assert.deepEqual(threadkeeperPrefPatch('assistant.context', 'off', { assistant: { search: false, context: 'auto', decision: true } }),
    { assistant: { search: false, context: 'off', decision: true } }, 'nested assistant prefs are written whole');
  assert.deepEqual(threadkeeperPrefPatch('assistant.search', true), { assistant: { search: true, context: 'auto', decision: true } });
  assert.deepEqual(threadkeeperPrefPatch('projects', ['Website', 'Website', 'Docs']), { projects: ['Website', 'Docs'] });
  for (const name of ['extensionId', 'status', 'configured', '__proto__', 'toString', 'assistant', 'assistant.model', undefined, 3]) assert.equal(threadkeeperPrefPatch(name, 'x'), null, String(name));
});

test('toggleListPref: projects add and remove; providers treat [] as every app', () => {
  assert.deepEqual(toggleListPref([], 'A', true), ['A']);
  assert.deepEqual(toggleListPref(['A', 'B'], 'A', false), ['B']);
  const every = ['chatgpt', 'claude_code', 'gemini'];
  assert.deepEqual(toggleListPref([], 'gemini', false, { everyone: every }), ['chatgpt', 'claude_code']);
  assert.deepEqual(toggleListPref(['chatgpt', 'claude_code'], 'gemini', true, { everyone: every }), [], 'checking the last one means every app again');
  assert.deepEqual(toggleListPref(['chatgpt'], 'chatgpt', false, { everyone: every }), []);
  assert.deepEqual(mergePrefs({ scope: 'all' }, { assistant: { context: 'off' } }).assistant, { search: true, context: 'off', decision: true });
});

test('user-touched chats, scope changes and placed chats are counted the way the confirms need', () => {
  const items = [
    chat('a'), chat('b', {}, { content: 'my notes' }), chat('c', {}, { tags: ['mine'] }), chat('d', { syncedTags: ['topic'] }, { tags: ['topic'] }),
    chat('e', {}, { collectionId: 'c_mine' }), chat('f', { project: 'Research' }), chat('g', { origin: 'manual' }), chat('h', {}, { deletedAt: iso() }),
    chat('i', { provider: 'claude_code' }), { id: 'n1', type: 'note', parentId: 'i', title: 'sub' },
  ];
  assert.deepEqual(items.filter(item => isUserTouchedChat(item, items)).map(item => item.id), ['b', 'c', 'e', 'i']);
  assert.ok(inScope({ project: 'website' }, { scope: 'projects', projects: ['Website'] }));
  assert.ok(!inScope({ project: 'Docs' }, { scope: 'projects', projects: ['Website'] }));
  assert.ok(!inScope({ provider: 'chatgpt' }, { scope: 'all', providers: ['gemini'] }));
  assert.ok(!inScope({}, { scope: 'manual' }));
  // Narrowing to Research only: a–e and i leave (f stays, g was added by hand, h is in Trash).
  assert.deepEqual(chatsLeavingScope(items, { scope: 'all' }, { scope: 'projects', projects: ['Research'] }), { leaving: 6, untouched: 2 });
  assert.deepEqual(chatsLeavingScope(items, { scope: 'all' }, { scope: 'all' }), { leaving: 0, untouched: 0 });
  assert.deepEqual(chatsLeavingScope(items, { scope: 'manual' }, { scope: 'all' }), { leaving: 0, untouched: 0 }, 'widening never confirms');
  assert.deepEqual(placedChats(items).map(item => item.id), ['a', 'b', 'c', 'd', 'f', 'g', 'i']);
  assert.ok(changesPlacement({ placement: 'mirror' }, { placement: 'inbox' }));
  assert.ok(changesPlacement({ parentName: 'AI chats' }, { parentName: 'Chats' }));
  assert.ok(!changesPlacement({ placement: 'mirror' }, { placement: 'mirror', transcripts: false }));
});

test('syncPreview says what will happen before anything syncs', () => {
  const collections = [{ id: 'c1', name: 'Website', parentId: '' }, { id: 'c2', name: 'Reading', parentId: '' }, { id: 'c3', name: 'Research', parentId: 'c2' }];
  const mirror = syncPreview({ scope: 'all' }, FACETS, collections);
  assert.equal(mirror.threads, 120);
  assert.deepEqual(mirror.lines, ['120 threads.', 'Creates “AI chats” with 1 collection inside, one per project.', 'Chats from 1 project go to your existing collection Website.']);
  const noMatch = syncPreview({ scope: 'all', matchExisting: false }, FACETS, collections);
  assert.equal(noMatch.lines[1], 'Creates “AI chats” with 2 collections inside, one per project.');
  const projects = syncPreview({ scope: 'projects', projects: ['Research'], placement: 'inbox', transcripts: false }, FACETS, collections);
  assert.deepEqual(projects.lines, ['40 threads in 1 project.', 'Chats go to your Inbox.', 'Only summaries are kept, not full transcripts.']);
  assert.equal(syncPreview({ scope: 'projects', projects: [] }, FACETS).lines[0], 'Choose at least one project.');
  assert.equal(syncPreview({ scope: 'all', providers: ['claude_code'] }, FACETS).threads, 40);
  assert.equal(syncPreview({ placement: 'single', singleCollectionId: 'c2' }, FACETS, collections).lines[1], 'Chats go to Reading.');
  assert.equal(syncPreview({ placement: 'single', singleCollectionId: 'gone' }, FACETS, collections).lines[1], 'Chats go to your Inbox until you choose a collection.');
  assert.deepEqual(syncPreview({ scope: 'manual' }, FACETS), { threads: 0, lines: ['Nothing syncs by itself. Add the threads you want with Add chats, or with Send to Still in Threadkeeper.'] });
  assert.equal(syncPreview({ scope: 'all' }, null).threads, null, 'unknown until Threadkeeper answers');
  assert.match(syncPreview({ scope: 'all', parentName: 'Website' }, FACETS, collections).lines[1], /^Uses “Website”/);
});

test('backfillProgress reports the first sync until every thread is in', () => {
  const items = [chat('a'), chat('b'), chat('c', { origin: 'manual' })];
  assert.equal(backfillProgress(paired(), items), null);
  const progress = backfillProgress(paired({ backfill: { total: 8, startedAt: iso(), paused: false } }), items);
  assert.deepEqual([progress.percent, progress.done, progress.total, progress.paused], [25, 2, 8, false]);
  assert.match(progress.label, /^2 of 8 threads in Still/);
  assert.match(backfillProgress(paired({ backfill: { total: 8, startedAt: iso(), paused: true } }), items).label, /paused/);
  assert.equal(backfillProgress(paired({ backfill: { total: 2, startedAt: iso() } }), items), null, 'done');
});

/* ------------------------------------------------------------------ connecting */

test('outside the extension the card says why and still carries its anchor', async () => {
  const ctx = await mount(fakeClient(), { extension: false });
  const out = card(ctx);
  assert.match(out, new RegExp(`id="${ANCHOR}"`));
  assert.match(out, /Threadkeeper works when Still runs as an extension/);
  assert.ok(!out.includes('settings.threadkeeper-find'));
});

test('the anchor renders while the state is still loading', () => {
  resetThreadkeeperSettings();
  useThreadkeeperClient(fakeClient());
  const out = card(makeCtx());
  assert.match(out, new RegExp(`id="${ANCHOR}"`));
  assert.match(out, /Checking the connection/);
});

test('not connected: Find Threadkeeper asks for management inside the click, then lists what it found', async () => {
  const requests = [];
  let removed = 0;
  globalThis.chrome = { permissions: { request: request => { requests.push(request); return Promise.resolve(true); }, remove: async () => { removed++; return true; } } };
  const client = fakeClient(baseState(), { discovered: [{ id: TK_ID, name: 'Threadkeeper', version: '0.5.0', enabled: true, installType: 'development' }, { id: OTHER_ID, name: 'Threadkeeper', version: '9', enabled: true },
    { id: 'not-an-id', name: 'Threadkeeper', enabled: true }, { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Threadkeeper', enabled: false }] });
  const ctx = await mount(client);
  let out = card(ctx);
  assert.match(out, /Not connected/);
  assert.match(out, /data-action="settings\.threadkeeper-find"/);
  assert.match(out, /Enter its ID instead/);
  const pending = dispatch('settings.threadkeeper-find', { ctx, el: {}, data: {} });
  assert.deepEqual(requests, [{ permissions: ['management'] }], 'requested before the first await');
  await pending;
  await settle();
  out = card(ctx);
  assert.equal((out.match(/class="tk-candidate[ "]/g) || []).length, 2, 'invalid and disabled extensions are left out');
  assert.match(out, /Loaded unpacked/);
  assert.match(out, /role="radiogroup"/);
  assert.match(out, /data-action="settings\.threadkeeper-connect"[^>]*disabled/, 'Connect waits for a choice when several are found');
  assert.ok(!client.calls.some(call => call[0] === 'connect'), 'never connects on its own');
  await dispatch('settings.threadkeeper-choose', { ctx, el: {}, data: { id: OTHER_ID } });
  await dispatch('settings.threadkeeper-connect', { ctx, el: {}, data: { id: OTHER_ID } });
  assert.deepEqual(client.calls.find(call => call[0] === 'connect'), ['connect', OTHER_ID]);
  assert.equal(removed, 0, 'the client drops the permission itself');
});

test('one extension found is preselected but still needs a Connect click; none found shows the callout and the ID form', async () => {
  const one = fakeClient(baseState(), { discovered: [{ id: TK_ID, name: 'Threadkeeper', version: '0.5.0', enabled: true }] });
  const ctx = await mount(one);
  await dispatch('settings.threadkeeper-find', { ctx, el: {}, data: {} });
  await settle();
  let out = card(ctx);
  assert.match(out, /aria-checked="true"[^>]*data-id="abcdefghijklmnopabcdefghijklmnop"/);
  assert.match(out, /data-action="settings\.threadkeeper-connect" data-id="abcdefghijklmnopabcdefghijklmnop"/);
  assert.ok(!one.calls.some(call => call[0] === 'connect'));

  const none = fakeClient(baseState(), { discovered: [] });
  const ctx2 = await mount(none);
  await dispatch('settings.threadkeeper-find', { ctx: ctx2, el: {}, data: {} });
  await settle();
  out = card(ctx2);
  assert.match(out, /Threadkeeper isn’t installed or is turned off/);
  assert.match(out, /data-submit="settings\.threadkeeper-manual"/);
});

test('a refused permission falls back to the ID form', async () => {
  globalThis.chrome = { permissions: { request: () => Promise.resolve(false) } };
  const client = fakeClient();
  const ctx = await mount(client);
  await dispatch('settings.threadkeeper-find', { ctx, el: {}, data: {} });
  await settle();
  assert.match(card(ctx), /Chrome did not let Still look at your extensions/);
  assert.ok(!client.calls.some(call => call[0] === 'discover'));
});

test('the manual ID form validates before connecting', async () => {
  const client = fakeClient();
  const ctx = await mount(client);
  ctx.state.settings.open.add('tk-manual-integrations');
  const form = value => ({ querySelector: () => ({ value }) });
  await dispatch('settings.threadkeeper-manual', { ctx, el: form(''), data: {} });
  assert.match(card(ctx), /Paste Threadkeeper’s ID first/);
  await dispatch('settings.threadkeeper-manual', { ctx, el: form('chrome-extension://abc'), data: {} });
  let out = card(ctx);
  assert.match(out, /That is not a Threadkeeper ID/);
  assert.match(out, /aria-invalid="true"/);
  assert.ok(!client.calls.some(call => call[0] === 'connect'));
  await dispatch('settings.threadkeeper-manual', { ctx, el: form(` ${TK_ID.toUpperCase()} `), data: {} });
  assert.deepEqual(client.calls.find(call => call[0] === 'connect'), ['connect', TK_ID]);
  await settle();
  out = card(ctx);
  assert.match(out, /Allow Still in Threadkeeper/);
  assert.match(out, /<p class="tk-code"[^>]*>042 917<\/p>/);
});

test('pending: shows the code, Send again re-sends to the same id, Cancel forgets the request; expired asks to try again', async () => {
  const state = baseState({ status: 'pending', extensionId: TK_ID, pending: { requestId: 'r1', extensionId: TK_ID, at: iso(-60000), code: '123456' } });
  const client = fakeClient(state);
  const ctx = await mount(client);
  let out = card(ctx);
  assert.match(out, /Waiting for you to allow it in Threadkeeper/);
  assert.match(out, /aria-label="Code 1 2 3 4 5 6"/);
  assert.match(out, /The request expires at/);
  await dispatch('settings.threadkeeper-resend', { ctx, el: {}, data: {} });
  assert.deepEqual(client.calls.at(-1), ['connect', TK_ID]);
  await dispatch('settings.threadkeeper-cancel', { ctx, el: {}, data: {} });
  assert.deepEqual(client.calls.at(-1), ['disconnect', { removeChats: false }]);

  const expired = await mount(fakeClient({ ...state, pending: { ...state.pending, at: iso(-11 * 60000) } }));
  out = card(expired);
  assert.match(out, /The request expired — try again/);
  assert.ok(!out.includes('tk-code'));
  assert.match(out, /Connect again/);
});

test('denied and revoked explain what happened and offer to connect again', async () => {
  let out = card(await mount(fakeClient(baseState({ status: 'denied', extensionId: TK_ID }))));
  assert.match(out, /Threadkeeper said no/);
  assert.match(out, /settings\.threadkeeper-find/);
  out = card(await mount(fakeClient(baseState({ status: 'revoked', lastError: 'Threadkeeper ended the pairing.' }))));
  assert.match(out, /Disconnected/);
  assert.match(out, /Chats already in Still stay here and stop updating/);
  assert.match(out, /Threadkeeper ended the pairing\./);
});

/* ------------------------------------------------------------------ choose what to sync */

test('after pairing nothing syncs until Start syncing; the step shows totals and a placement preview', async () => {
  const client = fakeClient(paired({ configured: false }));
  const ctx = await mount(client, { collections: [{ id: 'c1', name: 'Website', parentId: '' }] });
  let out = card(ctx);
  assert.match(out, /Choose what to sync/);
  assert.match(out, /Threadkeeper can share 120 threads in 3 projects/);
  assert.match(out, /Nothing comes over until you start/);
  assert.match(out, /Chats from 1 project go to your existing collection Website/);
  assert.match(out, /data-action="settings\.threadkeeper-start"/);
  assert.ok(!client.calls.some(call => call[0] === 'setPrefs'));
  // Draft edits change the preview, not Threadkeeper.
  await dispatch('settings.threadkeeper-draft', { ctx, el: {}, data: { name: 'scope', value: 'projects' } });
  out = card(ctx);
  assert.match(out, /Choose at least one project/);
  assert.match(out, /data-action="settings\.threadkeeper-start"[^>]*disabled/);
  await dispatch('settings.threadkeeper-draft-project', { ctx, el: { checked: true }, data: { project: 'Research' } });
  await dispatch('settings.threadkeeper-draft', { ctx, el: { checked: false }, data: { name: 'transcripts' } });
  await dispatch('settings.threadkeeper-draft', { ctx, el: {}, data: { name: 'placement', value: 'inbox' } });
  out = card(ctx);
  assert.match(out, /40 threads in 1 project/);
  assert.match(out, /Only summaries are kept/);
  assert.ok(!client.calls.some(call => call[0] === 'setPrefs'));
  await dispatch('settings.threadkeeper-start', { ctx, el: {}, data: {} });
  const [, patch, options] = client.calls.find(call => call[0] === 'setPrefs');
  assert.deepEqual(options, { start: true });
  assert.equal(patch.scope, 'projects');
  assert.deepEqual(patch.projects, ['Research']);
  assert.equal(patch.transcripts, false);
  assert.equal(patch.placement, 'inbox');
  assert.ok(ctx.toasts.some(([message]) => /Syncing started/.test(message)));
  out = card(ctx);
  assert.ok(!out.includes('Choose what to sync'));
  assert.match(out, /data-action="settings\.threadkeeper-sync"/);
});

/* ------------------------------------------------------------------ syncing */

test('when syncing the card shows status, progress, every preference and the assistant switches', async () => {
  const items = [chat('a'), chat('b')];
  const client = fakeClient(paired({ lastSyncAt: iso(-120000), backfill: { total: 8, startedAt: iso(-5000), paused: false }, lastError: 'Two threads were too large.', configDirty: true }));
  const ctx = await mount(client, { items });
  const out = card(ctx);
  assert.match(out, /Connected/);
  assert.match(out, /2 chats in Still · last update/);
  assert.match(out, /role="progressbar" aria-label="First sync"[^>]*aria-valuenow="25"/);
  assert.match(out, /data-action="settings\.threadkeeper-pause" data-paused="true"/);
  assert.match(out, /The last update did not finish/);
  assert.match(out, /Your latest choices reach Threadkeeper the next time it answers/);
  for (const label of ['What to sync', 'Where chats go', 'Include full transcripts', 'Keep chats up to date', 'When a thread leaves Threadkeeper', 'Add topics as tags', 'Open chats in',
    'Let the assistant search my AI threads', 'Automatic thread context', 'Use a fast model to decide']) assert.ok(out.includes(label), label);
  assert.match(out, /Smart/);
  assert.match(out, /data-action="settings\.threadkeeper-add"/);
  assert.match(out, /data-action="settings\.threadkeeper-disconnect"/);
  assert.match(out, /never ones you marked private or local-only/);
  assert.match(out, /thread text goes to the AI provider you chose in Still/);
  // The liveness probe and the facets went out once each.
  assert.equal(client.calls.filter(call => call[1] === 'sync.status').length, 1);
  assert.equal(client.calls.filter(call => call[1] === 'facets').length, 1);
});

test('an unreachable Threadkeeper reads as Not responding; other errors do not', async () => {
  let out = card(await mount(fakeClient(paired(), { failRequests: new ThreadkeeperError('unreachable', 'gone') })));
  assert.match(out, /Not responding/);
  assert.match(out, /Threadkeeper is not responding, so the totals are missing|What to sync/);
  out = card(await mount(fakeClient(paired(), { failRequests: new ThreadkeeperError('disabled', 'off') })));
  assert.match(out, />Connected</);
});

test('live preferences save at once through setThreadkeeperPrefs; assistant prefs go whole', async () => {
  const client = fakeClient(paired());
  const ctx = await mount(client);
  await dispatch('settings.threadkeeper-pref', { ctx, el: { checked: true }, data: { name: 'topicsAsTags' } });
  await dispatch('settings.threadkeeper-pref', { ctx, el: {}, data: { name: 'defaultView', value: 'transcript' } });
  await dispatch('settings.threadkeeper-pref', { ctx, el: {}, data: { name: 'assistant.context', value: 'always' } });
  await dispatch('settings.threadkeeper-pref', { ctx, el: { checked: false }, data: { name: 'assistant.search' } });
  await dispatch('settings.threadkeeper-pref', { ctx, el: {}, data: { name: 'status', value: 'paired' } });
  await dispatch('settings.threadkeeper-pref', { ctx, el: {}, data: { name: 'defaultView', value: 'raw' } });
  assert.deepEqual(client.calls.filter(call => call[0] === 'setPrefs').map(call => call[1]), [
    { topicsAsTags: true }, { defaultView: 'transcript' }, { assistant: { search: true, context: 'always', decision: true } }, { assistant: { search: false, context: 'always', decision: true } },
  ]);
  const out = card(ctx);
  assert.match(out, /<input type="checkbox" role="switch"[^>]*disabled[^>]*data-name="assistant\.decision"/, 'the decision switch applies to Smart only');
});

test('narrowing the scope confirms with counts; cancelling saves nothing', async () => {
  const items = [chat('a'), chat('b', {}, { content: 'notes' }), chat('c', { project: 'Research' })];
  const client = fakeClient(paired({ prefs: { ...paired().prefs, onRemoved: 'trash' } }));
  let answer = false;
  const ctx = await mount(client, { items, confirm: async () => answer });
  await dispatch('settings.threadkeeper-pref', { ctx, el: {}, data: { name: 'scope', value: 'manual' } });
  assert.equal(ctx.confirms.length, 1);
  assert.match(ctx.confirms[0].title, /Stop syncing 3 chats\?/);
  assert.match(ctx.confirms[0].body, /Up to 2 chats move to Trash; chats you added notes to, tagged or moved stay/);
  assert.equal(ctx.confirms[0].tone, 'danger');
  assert.ok(!client.calls.some(call => call[0] === 'setPrefs'));
  answer = true;
  await dispatch('settings.threadkeeper-pref', { ctx, el: {}, data: { name: 'scope', value: 'manual' } });
  assert.deepEqual(client.calls.filter(call => call[0] === 'setPrefs').map(call => call[1]), [{ scope: 'manual' }]);
});

test('choosing "Projects I choose" waits for the first project before saving', async () => {
  const client = fakeClient(paired());
  const ctx = await mount(client, { items: [chat('a', { project: 'Website' })] });
  await dispatch('settings.threadkeeper-pref', { ctx, el: {}, data: { name: 'scope', value: 'projects' } });
  assert.ok(!client.calls.some(call => call[0] === 'setPrefs'));
  const out = card(ctx);
  assert.match(out, /data-change="settings\.threadkeeper-project" data-project="Website"/);
  await dispatch('settings.threadkeeper-project', { ctx, el: { checked: true }, data: { project: 'Website' } });
  assert.deepEqual(client.calls.filter(call => call[0] === 'setPrefs').map(call => call[1]), [{ scope: 'projects', projects: ['Website'] }]);
  assert.equal(ctx.confirms.length, 0, 'the Website chat stays in scope');
  await assert.rejects(dispatch('settings.threadkeeper-project', { ctx, el: { checked: false }, data: { project: 'Website' } }), /Keep at least one project/);
});

test('providers: unchecking one keeps every other app; the last one cannot go', async () => {
  const client = fakeClient(paired());
  const ctx = await mount(client);
  await dispatch('settings.threadkeeper-provider', { ctx, el: { checked: false }, data: { provider: 'chatgpt' } });
  assert.deepEqual(client.calls.filter(call => call[0] === 'setPrefs').at(-1)[1], { providers: ['claude_code'] });
  await assert.rejects(dispatch('settings.threadkeeper-provider', { ctx, el: { checked: false }, data: { provider: 'claude_code' } }), /Keep at least one app/);
  await dispatch('settings.threadkeeper-provider', { ctx, el: { checked: true }, data: { provider: 'chatgpt' } });
  assert.deepEqual(client.calls.filter(call => call[0] === 'setPrefs').at(-1)[1], { providers: [] });
});

test('a placement change asks whether to move the chats sync placed; transcripts off offers to remove stored ones', async () => {
  const items = [chat('a'), chat('b', {}, { collectionId: 'c_mine' })];
  const answers = [false];
  const client = fakeClient(paired());
  const ctx = await mount(client, { items, confirm: async () => answers.shift() ?? true });
  await dispatch('settings.threadkeeper-pref', { ctx, el: {}, data: { name: 'placement', value: 'inbox' } });
  assert.match(ctx.confirms[0].title, /Move 1 chat to the new place\?/);
  assert.deepEqual(client.calls.filter(call => call[0] === 'setPrefs').at(-1).slice(1), [{ placement: 'inbox' }, { replace: false }]);
  await dispatch('settings.threadkeeper-parent', { ctx, el: { value: 'AI chats' }, data: {} });
  assert.equal(client.calls.filter(call => call[0] === 'setPrefs').length, 1, 'an unchanged name saves nothing');
  await dispatch('settings.threadkeeper-parent', { ctx, el: { value: 'Conversations' }, data: {} });
  assert.deepEqual(client.calls.filter(call => call[0] === 'setPrefs').at(-1).slice(1), [{ parentName: 'Conversations' }, { replace: true }]);
  threadkeeperSettingsState().stats = { chats: 2, transcripts: 2, bytes: 1000 };
  await dispatch('settings.threadkeeper-pref', { ctx, el: { checked: false }, data: { name: 'transcripts' } });
  assert.match(ctx.confirms.at(-1).title, /Remove 2 stored transcripts\?/);
  assert.deepEqual(client.calls.filter(call => call[0] === 'setPrefs').at(-1).slice(1), [{ transcripts: false }, { removeTranscripts: true }]);
});

test('Sync now, Pause and Add chats', async () => {
  const client = fakeClient(paired({ backfill: { total: 10, startedAt: iso(), paused: false } }));
  const ctx = await mount(client);
  await dispatch('settings.threadkeeper-sync', { ctx, el: {}, data: {} });
  assert.ok(client.calls.some(call => call[0] === 'sync'));
  assert.match(card(ctx), /Threadkeeper is sending 3 threads/);
  await dispatch('settings.threadkeeper-pause', { ctx, el: {}, data: { paused: 'true' } });
  assert.deepEqual(client.calls.filter(call => call[0] === 'setPrefs').at(-1).slice(1), [{}, { pause: true }]);
  assert.match(card(ctx), /First sync paused/);
  await dispatch('settings.threadkeeper-add', { ctx, el: {}, data: {} });
  await settle();
  assert.equal(ctx.state.dialogs.at(-1)?.name, 'threadkeeper.picker');
});

test('Disconnect opens a dialog; removing chats is opt-in and the counts spare chats the person changed', async () => {
  const items = [chat('a'), chat('b', {}, { favorite: true }), chat('c', { removed: 'deleted' })];
  const client = fakeClient(paired());
  const ctx = await mount(client, { items });
  await dispatch('settings.threadkeeper-disconnect', { ctx, el: {}, data: {} });
  assert.equal(ctx.state.dialogs.at(-1).name, 'threadkeeper.disconnect');
  let out = flat(renderDisconnectDialog(ctx));
  assert.match(out, /Disconnect Threadkeeper\?/);
  assert.match(out, /The 2 chats already here stay unless you remove them/);
  assert.match(out, /Also move 1 synced chat to Trash/);
  assert.match(out, /1 chat you added notes to, tagged or moved stays either way/);
  await dispatch('settings.threadkeeper-remove-chats', { ctx, el: { checked: true }, data: {} });
  await dispatch('settings.threadkeeper-disconnect-confirm', { ctx, el: {}, data: {} });
  assert.deepEqual(client.calls.filter(call => call[0] === 'disconnect').at(-1), ['disconnect', { removeChats: true }]);
  assert.ok(!ctx.state.dialogs.some(d => d.name === 'threadkeeper.disconnect'));
  assert.match(ctx.toasts.at(-1)[0], /moved to Trash/);
  out = card(ctx);
  assert.match(out, /Not connected/);
});

test('state changes from the worker re-render the card', async () => {
  const client = fakeClient(baseState({ status: 'pending', extensionId: TK_ID, pending: { requestId: 'r', extensionId: TK_ID, at: iso(), code: '111222' } }));
  const ctx = await mount(client);
  const before = ctx.renders;
  client.set(paired({ configured: false }));
  await settle();
  assert.ok(ctx.renders > before);
  assert.match(card(ctx), /Choose what to sync/);
  detachThreadkeeper();
  const after = ctx.renders;
  client.set(paired());
  await settle();
  assert.equal(ctx.renders, after, 'nothing listens once Settings closes');
});

test('thread text from Threadkeeper is escaped', async () => {
  const facets = { ...FACETS, projects: [{ name: '<img src=x onerror=alert(1)>', count: 3 }] };
  const ctx = await mount(fakeClient(paired({ prefs: { ...paired().prefs, scope: 'projects', projects: ['<img src=x onerror=alert(1)>'] } }), { facets }));
  const out = card(ctx);
  assert.ok(!out.includes('<img src=x'));
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

/* ------------------------------------------------------------------ settings wiring */

test('Integrations shows AI chat threads above Built in; About and the backup row mention AI chats', async () => {
  await mount(fakeClient());
  for (const surface of ['full', 'side']) {
    const ctx = makeCtx({ side: surface === 'side' });
    resetIds();
    const page = flat(renderSettingsPage(ctx, { surface }));
    const group = page.indexOf('id="settings-threadkeeper-group"');
    assert.ok(group > 0, surface);
    assert.ok(group < page.indexOf('Built in'), `${surface}: above Built in`);
    assert.match(page, /<h3 class="settings-group-title" id="settings-threadkeeper-group-title">AI chat threads<\/h3>/);
  }
  const ctx = makeCtx();
  ctx.state.view = 'settings:about';
  resetIds();
  const about = flat(renderSettingsPage(ctx, { surface: 'full' }));
  assert.match(about, /AI chat threads/);
  assert.match(about, /data-section="integrations" data-anchor="settings-threadkeeper"/);
  ctx.state.view = 'settings:library';
  resetIds();
  assert.match(flat(renderSettingsPage(ctx, { surface: 'full' })), /AI chats from Threadkeeper with their summaries and transcripts/);
});

test('Settings search finds the card by Threadkeeper words, and the catalog knows the alias', async () => {
  const ctx = await mount(fakeClient());
  for (const query of ['threadkeeper', 'transcripts', 'paperclip', 'coding agent']) {
    assert.ok(matchSections(query).some(section => section.id === 'integrations'), query);
    resetIds();
    const page = flat(renderSettingsPage({ ...ctx, state: { ...ctx.state, settings: { ...ctx.state.settings, query, queryView: ctx.state.view } } }, { surface: 'full' }));
    assert.match(page, /id="settings-result-integrations"/, query);
    assert.match(page, /id="settings-threadkeeper"/, query);
  }
  assert.deepEqual(matchSections('github').map(section => section.id), ['research', 'accounts']);
  assert.equal(normalizeSection('threadkeeper'), 'integrations');
  assert.match(sectionById('integrations').summary, /AI chat threads/);
  // While searching for something else, the card and its note are filtered out.
  const { content } = renderFiltered(searchTerms('wallpaper'), ['Integrations'], () => renderThreadkeeper(ctx));
  assert.equal(content, '');
});
