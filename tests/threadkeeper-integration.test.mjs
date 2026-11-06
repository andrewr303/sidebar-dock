// End to end: the REAL Still modules together against a fake Threadkeeper that speaks the protocol
// (docs/threadkeeper-integration.md). Real service worker (background.js: onMessageExternal + still:threadkeeper), real
// library store (lib/store.js over a chrome.storage mock), real chat data (lib/chat-data.js memory backend, the same
// instance the worker writes), the real page client (lib/threadkeeper/client.js through runtime.sendMessage), the real
// assistant adapter and tools (lib/ai/threads.js, lib/ai/tools.js) and the real chat page (ui/chats.js).
import test from 'node:test';
import assert from 'node:assert/strict';

const SELF = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TK = 'abcdefghijklmnopabcdefghijklmnop';
const PROTO = 'still-threadkeeper/1';
const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const events = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); }, removeListener(listener) { this.listeners = this.listeners.filter(l => l !== listener); } });

/* ------------------------------------------------------------------ chrome mock */

const values = {};
const storageEvents = events();
const alarms = new Map();
const clone = value => (value === undefined ? undefined : structuredClone(value));
const keysOf = keys => (keys === null || keys === undefined ? Object.keys(values) : typeof keys === 'object' && !Array.isArray(keys) ? Object.keys(keys) : [keys].flat());
const change = mutate => {
  const before = clone(values);
  mutate();
  const changes = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(values)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(values[key])) changes[key] = { oldValue: before[key], newValue: clone(values[key]) };
  }
  if (Object.keys(changes).length) for (const listener of storageEvents.listeners) listener(changes, 'local');
};
const page = { id: SELF, url: `chrome-extension://${SELF}/index.html` };
const runtime = {
  id: SELF, getManifest: () => ({ version: '0.4.0' }), getURL: path => `chrome-extension://${SELF}/${path}`,
  onMessage: events(), onMessageExternal: events(), onInstalled: events(), onStartup: events(), lastError: undefined,
  sendMessage(...args) {
    if (typeof args[0] === 'string') {
      // Still → another extension: only the fake Threadkeeper answers.
      const [to, message, callback] = args;
      Promise.resolve().then(() => (to === TK ? threadkeeper.receive(message) : undefined)).then(response => {
        if (response === undefined) { runtime.lastError = { message: 'Receiving end does not exist.' }; callback(undefined); runtime.lastError = undefined; }
        else callback(structuredClone(response));
      });
      return undefined;
    }
    // A page → the service worker (the page client's 'still:threadkeeper' requests, library operations).
    const [message] = args;
    return new Promise(resolve => {
      const listener = runtime.onMessage.listeners[0];
      if (!listener || listener(message, page, resolve) !== true) resolve(undefined);
    });
  },
};
globalThis.chrome = {
  runtime,
  storage: {
    local: {
      get: async keys => Object.fromEntries(keysOf(keys).filter(key => key in values).map(key => [key, clone(values[key])])),
      set: async patch => change(() => Object.assign(values, structuredClone(patch))),
      remove: async keys => change(() => { for (const key of [keys].flat()) delete values[key]; }),
    },
    onChanged: storageEvents,
  },
  contextMenus: { removeAll: async () => {}, create: () => {}, remove: async () => {}, onClicked: events() },
  tabs: { query: async () => [], create: async tab => tab },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  sidePanel: { open: async () => {}, setPanelBehavior: async () => {} },
  alarms: { getAll: async () => [...alarms.values()], create: async (name, options) => { alarms.set(name, { name, ...options }); }, clear: async name => alarms.delete(name), onAlarm: events() },
  commands: { onCommand: events() },
  notifications: { create: async () => {}, clear: async () => {}, onClicked: events() },
  permissions: { contains: async () => false, request: async () => true, remove: async () => true, onAdded: events(), onRemoved: events() },
  management: { getAll: async () => [
    { id: TK, name: 'Threadkeeper', version: '2.0.0', enabled: true, type: 'extension', installType: 'development' },
    { id: 'ponmlkjihgfedcbaponmlkjihgfedcba', name: 'Some other extension', version: '1', enabled: true, type: 'extension' },
  ] },
};

/* ------------------------------------------------------------------ the fake Threadkeeper */

const KEYS = {
  billing: 'chatgpt:acct_chatgpt_primary:ws_personal:billing:main',
  refactor: 'claude_code:acct_claude_code_primary:ws_personal:5f0c-ü/x y:main',
  trip: 'gemini:acct_gemini_primary:ws_personal:trip:main',
  ledger: 'chatgpt:acct_chatgpt_primary:ws_personal:ledger:main',
  queue: 'codex:acct_codex_primary:ws_personal:queue:main',
  inbox: 'chatgpt:acct_chatgpt_primary:ws_personal:inbox:main',
  webhooks: 'claude_code:acct_claude_code_primary:ws_personal:webhooks:main',
};
const PROVIDERS = { chatgpt: ['ChatGPT', 'chat'], claude_code: ['Claude Code', 'coding_agent'], gemini: ['Gemini', 'chat'], codex: ['Codex', 'coding_agent'] };
const messages = (n, about) => Array.from({ length: n }, (_, index) => ({ index, role: index % 2 ? 'assistant' : 'user',
  content: index === 3 ? `We decided to keep a ledger table for ${about}.` : `Message ${index} about ${about}.`, createdAt: '2026-10-01T10:00:00.000Z' }));

function createThreadkeeper() {
  let seq = 0;
  const threads = new Map();
  const tk = {
    paired: false, pending: null, prefs: null, epoch: '', received: [], untracked: [], analyzed: [], opened: [], tracked: new Set(),
    capabilities: ['sync', 'search', 'context', 'transcripts', 'open', 'analyze'],
    add(name, { title, gist, project = 'Billing', revision = 1, count = 6, analysisVersion = 2 } = {}) {
      const threadKey = KEYS[name];
      const provider = threadKey.split(':')[0];
      threads.set(threadKey, { threadKey, title, gist, provider, project, revision, count, analysisVersion, about: name });
      return threadKey;
    },
    edit(name, patch) { Object.assign(threads.get(KEYS[name]), patch); },
    payloadOf(name, options) { return tk.payload(threads.get(KEYS[name]), options); },
    remove(name) { threads.delete(KEYS[name]); },
    summary(thread) {
      const [providerLabel, category] = PROVIDERS[thread.provider];
      return { threadKey: thread.threadKey, title: thread.title, gist: thread.gist, provider: thread.provider, providerLabel, category, agentLabel: '', kind: 'coding',
        kindLabel: 'Building', project: thread.project, workflowState: 'active', createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-20T09:00:00.000Z',
        messageCount: thread.count, url: `https://example.com/c/${thread.about}`, model: 'gpt-5', workspacePath: '', branchId: '', siblingThreadKeys: [],
        analysisVersion: thread.analysisVersion };
    },
    payload(thread, { transcript = false } = {}) {
      const all = messages(thread.count, thread.about);
      return { ...tk.summary(thread), seq: ++seq, revision: thread.revision, contentHash: `h${thread.revision}`,
        fingerprint: `${thread.threadKey}|${thread.revision}|${thread.title}|${thread.gist}|${thread.analysisVersion}`, coverage: 'full', projectSource: 'manual', tags: [],
        pinned: false, gitBranch: '', resumeCommand: thread.provider === 'claude_code' ? "claude --resume 'abc-123'" : '',
        analysis: { source: 'ai', model: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', generatedAt: '2026-10-20T09:00:00.000Z', stale: false, analysisVersion: thread.analysisVersion,
          gist: thread.gist, overview: [`An in-depth look at ${thread.about}.`], summary: '', userGoal: `Sort out ${thread.about}`, outcome: 'A plan everyone agreed on',
          statusReason: 'Waiting on review', kind: 'coding', kindLabel: 'Building', topics: [thread.about, 'planning'], entities: ['Stripe'], languages: [],
          keyPoints: [{ text: `The ${thread.about} work needs a ledger`, refs: [3] }], artifacts: [{ label: 'schema.sql', kind: 'file', description: 'The ledger table', ref: 3 }],
          whereYouLeftOff: { text: 'The migration was drafted', refs: [4] }, nextStep: 'Run the migration on staging',
          decisions: [{ text: `Keep a ledger table for ${thread.about}`, rationale: 'Refunds need an audit trail', speaker: 'user_committed', refs: [3], quote: '' }],
          actionItems: [{ text: 'Write the backfill script', rationale: '', speaker: 'assistant_suggested', refs: [5], quote: '' }],
          openQuestions: [{ text: 'Who owns the reconciliation job?', rationale: '', speaker: 'assistant_suggested', refs: [], quote: '' }], constraints: [] },
        transcript: transcript ? { included: true, revision: thread.revision, truncated: false, totalMessages: all.length, from: 0, messages: all }
          : { included: false, revision: thread.revision, truncated: false, totalMessages: all.length, from: 0, messages: [] } };
    },
    /** Still → Threadkeeper: one protocol message in, a flat envelope out. */
    async receive(message) {
      tk.received.push(structuredClone(message));
      const ok = data => ({ ok: true, proto: PROTO, ...data });
      if (message.proto !== PROTO) return { ok: false, proto: PROTO, error: { code: 'version_mismatch' } };
      if (!['hello', 'pair.request'].includes(message.type) && !tk.paired) return { ok: false, proto: PROTO, error: { code: 'not_paired' } };
      const keysOf = list => (Array.isArray(list) ? list : []);
      switch (message.type) {
        case 'hello': return ok({ app: 'threadkeeper', version: '2.0.0', paired: tk.paired, ...(tk.paired ? { tk: { version: '2.0.0', capabilities: tk.capabilities } } : {}) });
        case 'pair.request':
          tk.pending = { requestId: message.requestId, code: message.code, epoch: message.epoch, appName: message.appName };
          return ok({ status: 'pending' });
        case 'pair.revoke': tk.paired = false; return ok({});
        case 'sync.configure': tk.prefs = message.prefs; tk.epoch = message.epoch; return ok({ queued: tk.inScope().length, total: tk.inScope().length });
        case 'sync.resync': return ok({ queued: tk.inScope().length });
        case 'sync.status': return ok({ queued: 0, tracked: tk.tracked.size, lastPushAt: null, lastError: '' });
        case 'facets': return ok({ total: threads.size, providers: [], projects: [], kinds: [], states: [] });
        case 'threads.untrack': tk.untracked.push(...message.hashes); return ok({ untracked: message.hashes.length });
        case 'threads.analyze': tk.analyzed.push(...message.threadKeys); return ok({ queued: message.threadKeys.length, skipped: [], estimateUsd: 0.01 });
        case 'thread.open': tk.opened.push(message.threadKey); return ok({});
        case 'threads.get': {
          const found = [], missing = [];
          for (const key of keysOf(message.threadKeys)) { const thread = threads.get(key); if (thread) found.push(thread); else missing.push(key); }
          for (const cite of keysOf(message.citeIds)) {
            const thread = [...threads.values()].find(entry => `tk:${threadHashOf(entry.threadKey).slice(0, 16)}` === cite);
            if (thread) found.push(thread); else missing.push(cite);
          }
          if (message.track) for (const thread of found) tk.tracked.add(thread.threadKey);
          return ok({ threads: found.map(thread => tk.payload(thread, { transcript: message.transcript !== 'none' })), missing, deferred: [] });
        }
        case 'threads.search': case 'threads.list': {
          const words = String(message.query || '').toLowerCase().split(/\s+/).filter(Boolean);
          const rows = [...threads.values()].filter(thread => !words.length || words.some(word => `${thread.title} ${thread.gist} ${thread.about}`.toLowerCase().includes(word)));
          return ok({ results: rows.map((thread, n) => ({ ...tk.summary(thread), ...(message.type === 'threads.search' ? { score: 0.9 - n / 10, match: 'strong',
            excerpt: { text: `We decided to keep a ledger table for ${thread.about}.`, messageIndex: 3, role: 'assistant' } } : {}) })),
          total: rows.length, nextCursor: null, semantic: false, reranked: false });
        }
        case 'threads.context': return ok({ threads: [], semantic: false, reranked: false });
        default: return { ok: false, proto: PROTO, error: { code: 'unsupported' } };
      }
    },
    inScope() { return tk.prefs?.scope === 'all' ? [...threads.values()] : []; },
    /** Threadkeeper → Still through the real external listener. */
    send(type, fields = {}) {
      return new Promise(resolve => {
        const [listener] = runtime.onMessageExternal.listeners;
        const kept = listener({ proto: PROTO, from: 'threadkeeper', type, requestId: `tk-${Math.random()}`, ...fields }, { id: TK, url: `chrome-extension://${TK}/background.js` }, resolve);
        assert.equal(kept, true);
      });
    },
    /** A sync push for these threads, metadata first; then the transcripts Still asks for (protocol "Delivery"). */
    async push(names, { origin = 'sync', target, transcript = false } = {}) {
      const list = names.map(name => threads.get(KEYS[name]));
      const first = await tk.send('threads.upsert', { threads: list.map(thread => tk.payload(thread, { transcript })), origin, ...(target ? { target } : {}) });
      assert.equal(first.ok, true, JSON.stringify(first.error));
      const needs = first.results.filter(row => row.needsTranscript).map(row => threads.get(row.threadKey));
      if (!needs.length) return { first, second: null };
      const second = await tk.send('threads.upsert', { threads: needs.map(thread => tk.payload(thread, { transcript: true })), origin });
      return { first, second };
    },
  };
  return tk;
}
let threadHashOf;
const threadkeeper = createThreadkeeper();

/* ------------------------------------------------------------------ the real modules */

const background = await import('../extension/background.js');
const store = await import('../extension/lib/store.js');
const chatData = await import('../extension/lib/chat-data.js');
const client = await import('../extension/lib/threadkeeper/client.js');
const protocol = await import('../extension/lib/threadkeeper/protocol.js');
const { buildChatSummaryMarkdown } = await import('../extension/lib/threadkeeper/summary.js');
const { renderMarkdown } = await import('../extension/lib/markdown.js');
const { createThreadSources } = await import('../extension/lib/ai/threads.js');
const { createToolSession } = await import('../extension/lib/ai/tools.js');
const { createSearch } = await import('../extension/lib/ai/search.js');
const chatsUi = await import('../extension/ui/chats.js');
const { createSelectors } = await import('../extension/ui/selectors.js');
threadHashOf = protocol.threadHash;
const id = name => protocol.chatItemId(KEYS[name]);
const library = () => store.loadLibrary();
const itemOf = async name => (await library()).items.find(item => item.id === id(name)) || null;
const state = () => client.getThreadkeeperState();

for (const [name, title, gist, project] of [
  ['billing', 'Billing refunds', 'Refunds get a ledger table', 'Billing'],
  ['refactor', 'Refactor the sync worker', 'The worker now coalesces writes', 'Still'],
  ['trip', 'Lisbon trip', 'Flights booked for May', 'Unfiled / Uncertain'],
  ['ledger', 'Ledger reconciliation', 'Nightly reconciliation job planned', 'Billing'],
  ['queue', 'Queue retries', 'Retries move to a dead-letter queue', 'Still'],
  ['inbox', 'Inbox zero rules', 'Filters for newsletters', 'Personal'],
  ['webhooks', 'Webhook signatures', 'Signatures verified with a shared secret', 'Billing'],
]) threadkeeper.add(name, { title, gist, project });

/* ------------------------------------------------------------------ the journey */

test('pairing: Still finds Threadkeeper, shows the code, and pairs only on the matching pair.granted', async () => {
  await library();   // the UI seeds the library on first open
  const found = await client.discoverThreadkeeper();
  assert.deepEqual(found.map(entry => entry.id), [TK]);
  const pending = await client.connectThreadkeeper(TK);
  assert.equal(pending.status, 'pending');
  assert.match(pending.code, /^\d{6}$/);
  assert.equal(threadkeeper.pending.code, pending.code, 'Threadkeeper received the code Still shows');
  const waiting = await state();
  assert.equal(waiting.status, 'pending');
  assert.equal(waiting.pending.code, pending.code);
  // Threadkeeper's consent window: the user typed the code and chose Allow.
  const wrong = await threadkeeper.send('pair.granted', { requestId: 'not-the-request', tk: { version: '2.0.0', capabilities: threadkeeper.capabilities } });
  assert.equal(wrong.error.code, 'not_paired');
  const granted = await threadkeeper.send('pair.granted', { requestId: threadkeeper.pending.requestId, tk: { version: '2.0.0', capabilities: threadkeeper.capabilities } });
  assert.equal(granted.ok, true, JSON.stringify(granted));
  threadkeeper.paired = true;
  const paired = await state();
  assert.deepEqual([paired.status, paired.configured, paired.tk.version], ['paired', false, '2.0.0']);
  // Nothing syncs before Start syncing.
  const early = await threadkeeper.send('threads.upsert', { threads: [threadkeeper.payloadOf('billing')], origin: 'sync' });
  assert.equal(early.results[0].reason, 'out_of_scope');
  assert.equal(await itemOf('billing'), null);
});

test('Start syncing configures Threadkeeper; pushes arrive metadata first, then the transcripts Still asks for', async () => {
  const started = await client.startThreadkeeperSync({ scope: 'all', placement: 'mirror' });
  assert.deepEqual(started, { queued: 7, total: 7, retrying: false });
  assert.deepEqual(threadkeeper.prefs, { scope: 'all', projects: [], providers: [], transcripts: true, autoUpdate: true });
  assert.equal(threadkeeper.epoch, (await state()).epoch);
  const { first, second } = await threadkeeper.push(['billing', 'refactor', 'trip']);
  assert.deepEqual(first.results.map(row => [row.status, row.needsTranscript]), [['created', true], ['created', true], ['created', true]]);
  assert.deepEqual(second.results.map(row => [row.status, row.needsTranscript]), [['updated', undefined], ['updated', undefined], ['updated', undefined]]);
  const billing = await itemOf('billing');
  assert.equal(billing.type, 'chat');
  assert.equal(billing.url, '', 'chats never carry the provider URL as their own');
  assert.equal(billing.sourceUrl, 'https://example.com/c/billing');
  assert.equal(billing.excerpt, 'Refunds get a ledger table');
  assert.equal(billing.createdAt, '2026-10-01T09:00:00.000Z', 'a new chat is dated by its thread');
  assert.deepEqual([billing.chat.hasTranscript, billing.chat.transcriptTruncated, billing.chat.origin], [true, false, 'sync']);
  const { collections } = await library();
  const parent = collections.find(c => c.name === 'AI chats');
  const billingCollection = collections.find(c => c.name === 'Billing');
  assert.equal(billingCollection.parentId, parent.id, 'mirror: one collection per project inside "AI chats"');
  assert.equal(billing.collectionId, billingCollection.id);
  assert.equal((await itemOf('trip')).collectionId, parent.id, 'unfiled threads land in the parent');
  const record = await chatData.getChatRecord(id('billing'));
  assert.equal(record.thread.analysis.decisions[0].text, 'Keep a ledger table for billing');
  assert.deepEqual([record.transcript.revision, record.transcript.stored, record.transcript.truncated], [1, 6, false]);
  assert.equal((await chatData.getChatTranscript(id('billing'))).messages.length, 6);
  // The same thread again, metadata only: unchanged, and Still does not ask for the transcript it holds.
  const again = await threadkeeper.push(['billing']);
  assert.deepEqual([again.first.results[0].status, again.first.results[0].needsTranscript, again.second], ['unchanged', undefined, null]);
  // Threadkeeper's chats.status reports what Still holds.
  const status = await threadkeeper.send('chats.status', { threadKeys: [KEYS.billing, KEYS.inbox] });
  assert.deepEqual(status.chats[KEYS.billing], { itemId: id('billing'), collectionId: billingCollection.id, collectionName: 'Billing', trashed: false, hasTranscript: true, transcriptRevision: 1 });
  assert.equal(status.chats[KEYS.inbox], undefined);
});

test('an update keeps the user’s rename and move; a new revision replaces the transcript', async () => {
  const { collections } = await library();
  const mine = await store.createCollection({ name: 'Mine' });
  await store.updateItem(id('refactor'), { title: 'My refactor notes', collectionId: mine.id });
  threadkeeper.edit('billing', { title: 'Billing refunds, v2', gist: 'Refunds use a ledger and a nightly job', revision: 2, count: 8 });
  threadkeeper.edit('refactor', { title: 'Refactor the sync worker (done)', gist: 'Shipped the coalescing worker', revision: 2, count: 8 });
  const { first, second } = await threadkeeper.push(['billing', 'refactor']);
  assert.deepEqual(first.results.map(row => [row.status, row.needsTranscript]), [['updated', true], ['updated', true]]);
  assert.equal(second.results.length, 2);
  const billing = await itemOf('billing');
  assert.deepEqual([billing.title, billing.excerpt], ['Billing refunds, v2', 'Refunds use a ledger and a nightly job'], 'untouched fields follow the thread');
  const refactor = await itemOf('refactor');
  assert.equal(refactor.title, 'My refactor notes', 'the user’s rename stays');
  assert.equal(refactor.collectionId, mine.id, 'the user’s move stays');
  assert.equal(refactor.excerpt, 'Shipped the coalescing worker');
  assert.equal((await chatData.getChatTranscript(id('billing'))).messages.length, 8);
  assert.equal((await chatData.getChatRecord(id('billing'))).transcript.revision, 2);
  assert.ok(collections.length >= 3);
});

test('local_only: untouched chats are deleted outright, touched ones keep only the user’s work; neither is a dismissal', async () => {
  await store.updateItem(id('trip'), { content: '' });   // still untouched
  const removed = await threadkeeper.send('threads.remove', { threadKeys: [KEYS.trip, KEYS.refactor], reason: 'local_only' });
  assert.deepEqual(removed.results.map(row => row.status), ['removed', 'removed']);
  await settle(5);
  assert.equal(await itemOf('trip'), null, 'untouched: gone');
  const refactor = await itemOf('refactor');
  assert.equal(refactor.title, 'My refactor notes', 'renamed by the user: the name stays');
  assert.equal(refactor.excerpt, '', 'the thread’s gist goes');
  assert.equal(refactor.sourceUrl, '');
  assert.deepEqual(Object.keys(refactor.chat).sort(), Object.keys(store.normalizeChat({ threadKey: KEYS.refactor })).sort());
  assert.equal(refactor.chat.removed, 'local_only');
  assert.equal(refactor.chat.project, '', 'nothing from the thread stays on the item');
  assert.equal(await chatData.getChatRecord(id('refactor')), null);
  assert.equal(await chatData.getChatRecord(id('trip')), null);
  assert.deepEqual(await chatData.dismissedChatIds([id('trip'), id('refactor')]), [], 'Still’s own deletions are not the user’s');
  assert.ok(!threadkeeper.untracked.includes(protocol.threadHash(KEYS.trip)));
  // The private chat is hidden from Threadkeeper's status answers.
  const status = await threadkeeper.send('chats.status', { threadKeys: [KEYS.refactor] });
  assert.deepEqual(status.chats, {});
});

test('deleted forever by the user: chat data goes, Threadkeeper stops tracking, sync skips it, a manual import revives it', async () => {
  await threadkeeper.push(['ledger']);
  assert.ok(await itemOf('ledger'));
  await store.deleteItem(id('ledger'));
  await store.emptyTrash();
  await settle(10);
  assert.equal(await itemOf('ledger'), null);
  assert.equal(await chatData.getChatRecord(id('ledger')), null);
  assert.deepEqual(await chatData.dismissedChatIds([id('ledger')]), [id('ledger')]);
  assert.ok(threadkeeper.untracked.includes(protocol.threadHash(KEYS.ledger)), 'threads.untrack with the hash');
  const synced = await threadkeeper.push(['ledger']);
  assert.deepEqual([synced.first.results[0].status, synced.first.results[0].reason], ['skipped', 'dismissed']);
  assert.equal(await chatData.getChatRecord(id('ledger')), null, 'nothing stored for a dismissed chat');
  // The assistant never brings it back; a manual import from the picker does.
  const assistant = await client.importThreadkeeperThreads([KEYS.ledger], { origin: 'assistant' });
  assert.deepEqual([assistant.results[0].status, assistant.results[0].reason], ['skipped', 'dismissed']);
  const manual = await client.importThreadkeeperThreads([KEYS.ledger], { target: null });
  assert.deepEqual([manual.results[0].status, manual.results[0].itemId], ['created', id('ledger')]);
  assert.deepEqual(await chatData.dismissedChatIds([id('ledger')]), []);
  assert.equal((await itemOf('ledger')).chat.origin, 'manual');
  assert.equal((await chatData.getChatTranscript(id('ledger'))).messages.length, 6, 'imports bring the transcript');
});

test('the Add chats picker imports into a chosen collection or the Inbox', async () => {
  const target = await store.createCollection({ name: 'Queues' });
  const picked = await client.importThreadkeeperThreads([KEYS.queue], { target: { collectionId: target.id }, origin: 'manual' });
  assert.deepEqual(picked.results.map(row => row.status), ['created']);
  assert.equal(picked.created, 1);
  const queue = await itemOf('queue');
  assert.equal(queue.collectionId, target.id);
  assert.equal(queue.chat.autoCollectionId, target.id, 'a place Still chose is not a user move');
  assert.equal(store.isChatTouched(queue, (await library()).items), false);
  const inbox = await client.importThreadkeeperThreads([KEYS.inbox], { target: { collectionId: '' } });
  assert.equal(inbox.results[0].status, 'created');
  assert.equal((await itemOf('inbox')).collectionId, '');
  // Asking for a thread that is already here moves it on a manual send.
  const moved = await client.importThreadkeeperThreads([KEYS.inbox], { target: { collectionId: target.id } });
  assert.equal(moved.results[0].status, 'updated');
  assert.equal((await itemOf('inbox')).collectionId, target.id);
  assert.deepEqual([...threadkeeper.tracked].includes(KEYS.queue), true, 'imports ask Threadkeeper to keep them up to date');
});

test('a paused first sync answers busy to sync pushes; resuming says hello', async () => {
  await client.pauseThreadkeeperSync(true);
  assert.equal((await state()).backfill.paused, true);
  const paused = await threadkeeper.send('threads.upsert', { threads: [threadkeeper.payloadOf('webhooks')], origin: 'sync' });
  assert.equal(paused.error.code, 'busy');
  assert.ok(paused.error.retryAfterMs > 0);
  const hellos = threadkeeper.received.filter(message => message.type === 'hello').length;
  await client.pauseThreadkeeperSync(false);
  assert.equal((await state()).backfill.paused, false);
  assert.equal(threadkeeper.received.filter(message => message.type === 'hello').length, hellos + 1);
  const resumed = await threadkeeper.push(['webhooks']);
  assert.equal(resumed.first.results[0].status, 'created');
});

test('the assistant searches, reads and imports threads through the real client, and undo does not dismiss', async () => {
  const sources = createThreadSources({ getLibrary: library });
  const threads = await sources.threads();
  assert.ok(threads, 'paired with search and assistant search on');
  const proposals = [];
  let counter = 0;
  const toolEvents = [];
  const tools = createToolSession({ getLibrary: library, searchLibrary: createSearch({ getLibrary: library }).searchLibrary, store, threads, chats: sources.chats,
    uid: prefix => `${prefix}_${++counter}`, onEvent: event => toolEvents.push(event), onProposal: async proposal => { proposals.push(proposal); return 'apply'; } });
  const call = (name, input, callId = `call_${name}`) => ({ id: callId, name, input });
  const parse = result => JSON.parse(result.content);
  const [searched] = await tools.execute([call('search_ai_threads', { query: 'ledger reconciliation' })]);
  const rows = parse(searched).items;
  const ledger = rows.find(row => row.threadKey === KEYS.ledger);
  assert.equal(ledger.inLibrary, id('ledger'), 'a thread already in Still is cited by its chat id');
  const trip = rows.find(row => row.threadKey === KEYS.trip);
  assert.ok(!trip || trip.inLibrary === null);
  const [read] = await tools.execute([call('get_ai_threads', { ids: [id('ledger')], detail: 'both', query: 'ledger' })]);
  const thread = parse(read).threads?.[0] || parse(read).items?.[0];
  assert.ok(thread, read.content);
  assert.match(JSON.stringify(thread), /What this thread is about/);
  assert.match(JSON.stringify(thread), /ledger table for ledger/);
  // Import a thread that is not in Still yet into a collection the assistant proposes in the same step.
  const cite = protocol.threadCiteId(KEYS.trip);
  const results = await tools.execute([
    call('create_collection', { name: 'Travel' }, 'c1'),
    call('import_ai_threads', { ids: [cite], collectionId: 'new:Travel', tags: ['travel'] }, 'i1'),
  ]);
  const applied = parse(results[1]);
  assert.equal(applied.status, 'applied', results[1].content);
  assert.equal(applied.imported, 1);
  const tripItem = await itemOf('trip');
  const travel = (await library()).collections.find(c => c.name === 'Travel');
  assert.deepEqual([tripItem.collectionId, tripItem.tags, tripItem.chat.origin], [travel.id, ['travel'], 'assistant']);
  assert.equal((await chatData.getChatTranscript(id('trip'))).messages.length, 6);
  await toolEvents.find(event => event.type === 'proposal_result').undo();
  await settle(10);
  assert.equal(await itemOf('trip'), null, 'undo removes the imported chat');
  assert.equal(await chatData.getChatRecord(id('trip')), null);
  assert.deepEqual(await chatData.dismissedChatIds([id('trip')]), [], 'an undone import is not a dismissal');
  const again = await threadkeeper.push(['trip']);
  assert.equal(again.first.results[0].status, 'created', 'sync may bring it back');
  // Offline search over the stored chats (the assistant's fallback and the Chats view search).
  const offline = await chatData.searchChats('reconciliation job', { limit: 5 });
  assert.equal(offline.results[0].id, id('ledger'));
  const local = await sources.chats.searchLocal('reconciliation', { limit: 3 });
  assert.equal(local[0].id ?? local[0].itemId, id('ledger'));
  sources.dispose();
});

test('the chat page renders the stored record as a note-like summary; Improve asks threads.analyze', async () => {
  const item = await itemOf('billing');
  const record = await chatData.getChatRecord(item.id);
  const markdown = buildChatSummaryMarkdown(record, item);
  for (const heading of ['## What this thread is about', '## Key points', '## Where you left off', '## Decisions', '## Next steps', '## Open questions', '## What was produced']) {
    assert.ok(markdown.includes(heading), heading);
  }
  assert.match(markdown, /\[m4\]\(#msg-3\)/);
  const htmlOut = renderMarkdown(markdown, { images: false });
  assert.match(htmlOut, /<h2>What this thread is about<\/h2>/);
  assert.doesNotMatch(htmlOut, /<img|<script/);
  // The real chat page over the real library and chat store.
  let lib = await library();
  chatsUi.setThreadkeeperSnapshot(await state());
  const stored = new Map();
  const ctx = {
    state: { view: 'chats', query: '', typeFilter: 'all', tagFilter: '', panel: null, popover: null, dialogs: [], selection: new Set(), chats: { chatId: null, query: '', category: '', provider: '', collectionId: '', deep: null } },
    env: { isSidepanel: false, isExtension: true, isNewtab: false, isMac: false, modKey: 'Ctrl' },
    prefs: { get: (key, fallback) => (stored.has(key) ? stored.get(key) : fallback), set: (key, value) => stored.set(key, value), all: () => Object.fromEntries(stored), touchCollection() {} },
    get library() { return lib; },
    rendered: 0, toasts: [],
    render() { ctx.rendered++; }, nextFrame() {}, syncUrl() {}, toast(message, options) { ctx.toasts.push([message, options]); },
    navigate() {}, openItem() {}, run: async fn => fn(), store,
  };
  ctx.select = createSelectors(() => lib, () => ctx.prefs.all());
  chatsUi.renderChatPage(ctx, ctx.select.byId(item.id));
  await settle(10);
  const pageHtml = chatsUi.renderChatPage(ctx, ctx.select.byId(item.id)).toString().replace(/\s+/g, ' ');
  assert.match(pageHtml, /<h1 class="ne-title chat-title"[^>]*>Billing refunds, v2<\/h1>/);
  assert.match(pageHtml, /<h2>What this thread is about<\/h2>/);
  assert.match(pageHtml, /Keep a ledger table for billing/);
  assert.match(pageHtml, /Analyzed by Claude Sonnet 4\.5/);
  // An older analysis offers "Improve", which asks Threadkeeper to re-analyze.
  threadkeeper.edit('billing', { analysisVersion: 1, revision: 3 });
  await threadkeeper.push(['billing']);
  lib = await library();
  const older = ctx.select.byId(item.id);
  assert.equal(older.chat.analysisVersion, 1);
  chatsUi.invalidateChat(item.id);
  chatsUi.renderChatPage(ctx, older);
  await settle(10);
  const olderHtml = chatsUi.renderChatPage(ctx, older).toString();
  assert.match(olderHtml, /data-action="chat\.improve"/);
  const { dispatch } = await import('../extension/ui/runtime.js');
  await dispatch('chat.improve', { ctx, el: {}, data: { id: item.id } });
  assert.deepEqual(threadkeeper.analyzed, [KEYS.billing]);
  assert.match(ctx.toasts.at(-1)[0], /writing a new summary/);
});

test('disconnect with removal trashes untouched chats; a new pairing brings them back', async () => {
  await store.updateItem(id('queue'), { content: 'My notes on the queue' });
  await client.disconnectThreadkeeper({ removeChats: true });
  assert.equal((await state()).status, 'off');
  assert.ok(threadkeeper.received.some(message => message.type === 'pair.revoke'));
  const billing = await itemOf('billing');
  assert.ok(billing.deletedAt, 'untouched: in Trash');
  assert.equal(billing.chat.removed, 'disconnected');
  assert.equal((await itemOf('queue')).deletedAt, null, 'touched chats stay');
  assert.ok(await chatData.getChatRecord(id('billing')), 'a trashed chat keeps its data');
  await client.connectThreadkeeper(TK);
  const granted = await threadkeeper.send('pair.granted', { requestId: threadkeeper.pending.requestId, tk: { version: '2.0.0', capabilities: threadkeeper.capabilities } });
  assert.equal(granted.ok, true);
  await settle(20);
  const back = await itemOf('billing');
  assert.equal(back.deletedAt, null);
  assert.equal(back.chat.removed, '');
});
