import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createChatDataStore, validateChatBackup, chatSearchTokens, isChatId, setChatDataStore, putChatData, getChatRecord, getChatTranscript,
  deleteChatData, listChatDataIds, chatDataStats, sweepChatData, searchChats, CHAT_DB, CHAT_DATA_STORES, CHAT_DATA_LIMITS,
} from '../extension/lib/chat-data.js';
import { chatItemId } from '../extension/lib/threadkeeper/protocol.js';

// An IndexedDB stand-in that behaves like the real one where this module depends on it: upgrades, versionchange,
// transactions that complete only after every request (including chained ones) has finished, getAllKeys and clear.
function fakeIndexedDB() {
  const databases = new Map();
  const later = fn => setTimeout(fn, 0);
  let opens = 0, transactions = 0;
  function connect(name) {
    const record = databases.get(name);
    const db = {
      onversionchange: null, onclose: null, closed: false,
      objectStoreNames: { contains: store => record.stores.has(store) },
      createObjectStore(store, { keyPath }) {
        if (record.stores.has(store)) throw Object.assign(new Error(`exists ${store}`), { name: 'ConstraintError' });
        record.stores.set(store, { keyPath, rows: new Map() });
      },
      close() { db.closed = true; record.connections.delete(db); },
      transaction(names, mode) {
        if (db.closed) throw Object.assign(new Error('closing'), { name: 'InvalidStateError' });
        transactions++;
        const tx = { oncomplete: null, onerror: null, onabort: null, error: null, mode };
        let pending = 0;
        const settle = () => later(() => { if (!pending) tx.oncomplete?.(); });
        settle();
        tx.objectStore = storeName => {
          if (![names].flat().includes(storeName)) throw Object.assign(new Error(storeName), { name: 'NotFoundError' });
          const { keyPath, rows } = record.stores.get(storeName);
          const op = (run, write) => {
            if (write && mode !== 'readwrite') throw Object.assign(new Error('read only'), { name: 'ReadOnlyError' });
            pending++;
            const req = { onsuccess: null };
            later(() => { req.result = run(); req.onsuccess?.(); pending--; settle(); });
            return req;
          };
          return {
            put: value => op(() => { rows.set(value[keyPath], structuredClone(value)); return value[keyPath]; }, true),
            get: key => op(() => (rows.has(key) ? structuredClone(rows.get(key)) : undefined)),
            getAll: () => op(() => [...rows.values()].map(value => structuredClone(value))),
            getAllKeys: () => op(() => [...rows.keys()]),
            delete: key => op(() => { rows.delete(key); }, true),
            clear: () => op(() => { rows.clear(); }, true),
          };
        };
        return tx;
      },
    };
    record.connections.add(db);
    return db;
  }
  return {
    databases, get opens() { return opens; }, get transactions() { return transactions; },
    open(name, version = 1) {
      opens++;
      const request = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => {
        if (!databases.has(name)) databases.set(name, { version: 0, stores: new Map(), connections: new Set() });
        const record = databases.get(name);
        if (version < record.version) { request.error = Object.assign(new Error('lower'), { name: 'VersionError' }); request.onerror?.(); return; }
        request.result = connect(name);
        if (version > record.version) { record.version = version; request.onupgradeneeded?.(); }
        request.onsuccess?.();
      });
      return request;
    },
  };
}

const KEY = 'chatgpt:acct_chatgpt_primary:ws_personal:abc:main';
const KEY2 = 'claude_code:acct_claude_code_primary:ws_personal:5f0c-ü/x y:main';
const ID = chatItemId(KEY), ID2 = chatItemId(KEY2);
const thread = (overrides = {}) => ({
  threadKey: KEY, hash: ID.slice(8), title: 'Planning the Lisbon trip', gist: 'Booked flights to Lisbon for May.', provider: 'chatgpt', providerLabel: 'ChatGPT',
  category: 'chat', agentLabel: '', kind: 'planning', kindLabel: 'Planning', project: 'Travel', workflowState: 'done',
  createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z', messageCount: 4, url: 'https://chatgpt.com/c/abc',
  seq: 5, revision: 3, fingerprint: 'fp1', coverage: 'full', tags: [],
  analysis: { source: 'ai', gist: 'Booked flights to Lisbon for May.', overview: ['You compared fares and settled on TAP.'], topics: ['lisbon', 'flights'],
    entities: ['TAP Air Portugal'], keyPoints: [{ text: 'Direct flights are cheaper on Tuesdays', refs: [1] }], decisions: [{ text: 'Fly TAP', rationale: 'Direct', speaker: 'user_committed', refs: [2], quote: '' }] },
  transcript: { included: true, revision: 3, truncated: false, totalMessages: 4, from: 0, messages: [
    { index: 0, role: 'user', content: 'Find me flights to Lisbon in May', createdAt: '2026-10-01T10:00:00.000Z' },
    { index: 1, role: 'assistant', content: 'Direct flights on Tuesdays are about 20% cheaper. The hotel near Alfama is a good base.', createdAt: null },
    { index: 2, role: 'user', content: 'Book TAP then', createdAt: null },
    { index: 3, role: 'tool', content: 'booking(TAP 123)', createdAt: null },
  ] },
  ...overrides,
});

for (const [label, make] of [['memory', () => createChatDataStore({ indexedDB: null })], ['IndexedDB', () => createChatDataStore({ indexedDB: fakeIndexedDB() })]]) {
  test(`${label}: put stores the record and transcript; get/getTranscript read them back`, async () => {
    const store = make();
    const out = await store.put(ID, { thread: thread(), transcript: thread().transcript });
    assert.equal(out.stored, true);
    assert.deepEqual(out.transcript, { revision: 3, totalMessages: 4, stored: 4, truncated: false, bytes: out.transcript.bytes, storedAt: out.transcript.storedAt });
    const record = await store.get(ID);
    assert.equal(record.threadKey, KEY);
    assert.equal(record.fingerprint, 'fp1');
    assert.equal(record.revision, 3);
    assert.equal(record.seq, 5);
    assert.equal(record.thread.transcript, undefined, 'the summary record never carries the messages');
    assert.equal(record.thread.analysis.topics[1], 'flights');
    assert.ok(record.storedAt);
    const transcript = await store.getTranscript(ID);
    assert.equal(transcript.messages.length, 4);
    assert.equal(transcript.truncated, false);
    assert.deepEqual((await store.getTranscript(ID, { from: 1, count: 2 })).messages.map(m => m.index), [1, 2]);
    assert.equal(await store.get('chat_tk_00000000000000000000000000000000'), null);
    assert.equal(await store.getTranscript(ID2), null);
    assert.deepEqual(await store.ids(), [ID]);
    const stats = await store.stats();
    assert.equal(stats.chats, 1);
    assert.equal(stats.transcripts, 1);
    assert.ok(stats.bytes > 100);
  });

  test(`${label}: a put without a transcript keeps it only for the same revision; stale seq is refused`, async () => {
    const store = make();
    await store.put(ID, { thread: thread(), transcript: thread().transcript });
    await store.put(ID, { thread: thread({ seq: 6, fingerprint: 'fp2', title: 'Renamed' }), transcript: null });
    assert.equal((await store.getTranscript(ID)).revision, 3, 'same revision: the transcript stays');
    assert.equal((await store.get(ID)).transcript.revision, 3);
    const stale = await store.put(ID, { thread: thread({ seq: 4, fingerprint: 'old' }) });
    assert.deepEqual([stale.stored, stale.reason], [false, 'stale']);
    assert.equal((await store.get(ID)).fingerprint, 'fp2');
    await store.put(ID, { thread: thread({ seq: 7, revision: 4, fingerprint: 'fp3' }), transcript: { included: false, revision: 4, messages: [] } });
    assert.equal(await store.getTranscript(ID), null, 'a newer revision drops the stale transcript');
    assert.equal((await store.get(ID)).transcript, null);
    // A transcript for another revision than the record is not stored.
    await store.put(ID, { thread: thread({ seq: 8, revision: 5 }), transcript: { ...thread().transcript, revision: 4 } });
    assert.equal(await store.getTranscript(ID), null);
  });

  test(`${label}: transcript windows merge into the same revision and clear truncated when contiguous`, async () => {
    const store = make();
    const messages = thread().transcript.messages;
    await store.put(ID, { thread: thread(), transcript: { included: true, revision: 3, truncated: true, totalMessages: 4, from: 0, messages: [messages[0], messages[3]] } });
    let transcript = await store.getTranscript(ID);
    assert.equal(transcript.truncated, true);
    assert.equal((await store.mergeTranscriptWindow(ID, { revision: 2, totalMessages: 4, messages: [messages[1]] })).reason, 'revision');
    const merged = await store.mergeTranscriptWindow(ID, { revision: 3, totalMessages: 4, messages: [messages[1], messages[2], { index: 'x', role: 'user', content: 'bad' }] });
    assert.equal(merged.merged, true);
    assert.equal(merged.transcript.truncated, false);
    transcript = await store.getTranscript(ID);
    assert.deepEqual(transcript.messages.map(m => m.index), [0, 1, 2, 3]);
    assert.equal((await store.get(ID)).transcript.stored, 4);
    // A window for a record without a transcript yet creates it.
    await store.put(ID2, { thread: thread({ threadKey: KEY2 }) });
    const created = await store.mergeTranscriptWindow(ID2, { revision: 3, totalMessages: 10, messages: [messages[0]] });
    assert.equal(created.transcript.truncated, true);
    assert.equal(created.transcript.totalMessages, 10);
  });

  test(`${label}: messages are validated and bounded`, async () => {
    const store = make();
    const long = 'x'.repeat(CHAT_DATA_LIMITS.messageChars + 500);
    await store.put(ID, { thread: thread(), transcript: { included: true, revision: 3, totalMessages: 3, messages: [
      { index: 0, role: 'user', content: long }, { index: 1, role: 'hacker', content: 'no' }, { index: -1, role: 'user', content: 'no' },
      { index: 2, role: 'assistant', content: 7 }, { index: 2, role: 'assistant', content: 'last wins' }, { index: 2, role: 'assistant', content: 'later' }, 'junk',
    ] } });
    const transcript = await store.getTranscript(ID);
    assert.deepEqual(transcript.messages.map(m => [m.index, m.role]), [[0, 'user'], [2, 'assistant']]);
    assert.equal(transcript.messages[0].content.length, CHAT_DATA_LIMITS.messageChars);
    assert.equal(transcript.messages[1].content, 'later');
    assert.equal(transcript.truncated, true, 'a gap counts as truncated');
    await assert.rejects(async () => store.put('chat_tk_0123', { thread: thread() }), /invalid ID/);
    await assert.rejects(async () => store.put(ID2, { thread: thread() }), /does not match/);
    await assert.rejects(async () => store.put(ID, { thread: thread({ blob: 'x'.repeat(CHAT_DATA_LIMITS.recordBytes) }) }), /too large/);
  });

  test(`${label}: delete, dismissed list, store id and clear`, async () => {
    const store = make();
    await store.put(ID, { thread: thread(), transcript: thread().transcript });
    assert.equal(await store.delete([ID, ID2, 'nope']), 1);
    assert.equal(await store.get(ID), null);
    assert.equal(await store.getTranscript(ID), null);
    assert.equal(await store.delete([]), 0);
    assert.equal(await store.dismiss([ID, 'not-a-chat-id']), 1);
    assert.deepEqual(await store.dismissed([ID, ID2]), [ID]);
    assert.deepEqual(await store.dismissed(), [ID]);
    await store.undismiss([ID]);
    assert.deepEqual(await store.dismissed([ID]), []);
    const first = await store.storeId();
    assert.equal(await store.storeId(), first, 'stable');
    await store.put(ID, { thread: thread(), transcript: thread().transcript });
    assert.equal(await store.deleteTranscripts([ID, ID2]), 1);
    assert.equal(await store.getTranscript(ID), null);
    assert.equal((await store.get(ID)).transcript, null, 'the summary stays');
    await store.dismiss([ID2]);
    await store.clear();
    assert.deepEqual(await store.ids(), []);
    assert.deepEqual(await store.dismissed(), []);
    assert.equal(await store.storeId(), first, 'clear keeps the store identity');
  });

  test(`${label}: the orphan sweep deletes old rows of non-items and private chats, never young ones`, async () => {
    let clock = Date.parse('2026-10-10T10:00:00.000Z');
    const store = label === 'memory' ? createChatDataStore({ indexedDB: null, now: () => clock }) : createChatDataStore({ indexedDB: fakeIndexedDB(), now: () => clock });
    await store.put(ID, { thread: thread(), transcript: thread().transcript });
    await store.put(ID2, { thread: thread({ threadKey: KEY2 }), transcript: thread().transcript });
    const items = [{ id: 'note_1', type: 'note' }];
    assert.deepEqual(await store.sweep({ items }), { records: 0, transcripts: 0 }, 'an apply may be in flight: young rows stay');
    clock += CHAT_DATA_LIMITS.sweepAgeMs + 1;
    const trashed = { id: ID, type: 'chat', deletedAt: '2026-10-09T00:00:00.000Z', chat: { removed: '' } };
    assert.deepEqual(await store.sweep({ items: [...items, trashed] }), { records: 1, transcripts: 1 }, 'Trash counts as present');
    assert.ok(await store.get(ID));
    assert.equal(await store.get(ID2), null);
    // A chat stripped as private loses its data at once.
    clock = Date.parse('2026-10-10T10:00:00.000Z');
    await store.put(ID2, { thread: thread({ threadKey: KEY2 }), transcript: thread().transcript });
    assert.deepEqual(await store.sweep([{ id: ID2, type: 'chat', chat: { removed: 'local_only' } }, trashed]), { records: 1, transcripts: 1 });
    await assert.rejects(store.sweep(null), /needs the library/);
  });

  test(`${label}: offline search scores summaries and transcripts`, async () => {
    const store = make();
    await store.put(ID, { thread: thread(), transcript: thread().transcript });
    await store.put(ID2, { thread: thread({ threadKey: KEY2, title: 'Refactor the store module', gist: 'Split store.js into ops.', provider: 'claude_code', providerLabel: 'Claude Code',
      category: 'coding_agent', project: 'Still', updatedAt: '2026-10-05T00:00:00.000Z', analysis: { gist: 'Split store.js into ops.', topics: ['refactoring'] } }),
    transcript: { included: true, revision: 3, totalMessages: 1, messages: [{ index: 0, role: 'assistant', content: 'I moved the IndexedDB helpers out of store.js.' }] } });
    let found = await store.search('lisbon flights');
    assert.equal(found.total, 1);
    assert.equal(found.results[0].id, ID);
    assert.equal(found.results[0].match, 'strong');
    assert.ok(found.results[0].score > 0.7);
    found = await store.search('Alfama hotel');
    assert.equal(found.results[0].id, ID, 'transcript text is searched');
    assert.deepEqual(found.results[0].passage.messageIndex, 1);
    assert.match(found.results[0].snippet, /Alfama/);
    found = await store.search('refactoring indexeddb');
    assert.equal(found.results[0].id, ID2);
    assert.equal(found.results[0].match, 'strong');
    found = await store.search('lisbon refactoring');
    assert.deepEqual(found.results.map(r => r.match), ['weak', 'weak']);
    found = await store.search('', { filters: { categories: ['coding_agent'] } });
    assert.deepEqual(found.results.map(r => r.id), [ID2]);
    found = await store.search('');
    assert.deepEqual(found.results.map(r => r.id), [ID2, ID], 'empty query: newest first');
    assert.equal((await store.search('lisbon', { filters: { since: '2026-10-03T00:00:00.000Z' } })).total, 0);
    assert.equal((await store.search('alfama', { transcripts: false })).total, 0);
    assert.equal((await store.search('lisbon', { filters: { ids: [ID2] } })).total, 0);
  });
}

test('IndexedDB: guarded upgrade, one connection, reopen after versionchange', async () => {
  const idb = fakeIndexedDB();
  const store = createChatDataStore({ indexedDB: idb });
  await store.put(ID, { thread: thread() });
  await store.get(ID);
  assert.equal(idb.opens, 1);
  const db = idb.databases.get(CHAT_DB);
  assert.deepEqual([...db.stores.keys()].sort(), [...CHAT_DATA_STORES].sort());
  for (const connection of [...db.connections]) connection.onversionchange();
  assert.ok(await store.get(ID));
  assert.equal(idb.opens, 2);
  // A second store over the same database (another view) reads the same data without re-creating stores.
  assert.equal((await createChatDataStore({ indexedDB: idb }).get(ID)).threadKey, KEY);
});

test('backup part validation is strict', () => {
  const record = { id: ID, threadKey: KEY, revision: 3, seq: 5, thread: { threadKey: KEY, title: 't' } };
  const transcript = { id: ID, threadKey: KEY, revision: 3, messages: [{ index: 0, role: 'user', content: 'hi' }] };
  assert.equal(validateChatBackup(null), null);
  assert.ok(validateChatBackup({ version: 1, records: [record], transcripts: [transcript] }, { chatIds: [ID] }));
  const bad = [
    [{ version: 2, records: [], transcripts: [] }, /not in a form/],
    [{ version: 1, records: [{ ...record, id: ID2 }], transcripts: [] }, /does not match/],
    [{ version: 1, records: [{ ...record, id: 'chat_tk_x' }], transcripts: [] }, /invalid ID/],
    [{ version: 1, records: [record, record], transcripts: [] }, /duplicate/],
    [{ version: 1, records: [{ ...record, thread: null }], transcripts: [] }, /thread data/],
    [{ version: 1, records: [], transcripts: [transcript] }, /no AI chat/],
    [{ version: 1, records: [record], transcripts: [{ ...transcript, messages: [{ index: 0, role: 'root', content: 'x' }] }] }, /invalid message/],
    [{ version: 1, records: [record], transcripts: [{ ...transcript, messages: [{ index: 1.5, role: 'user', content: 'x' }] }] }, /invalid message/],
  ];
  for (const [part, error] of bad) assert.throws(() => validateChatBackup(part), error);
  assert.throws(() => validateChatBackup({ version: 1, records: [record], transcripts: [] }, { chatIds: [] }), /no saved chat/);
});

test('backup restore writes only taken chats and never downgrades', async () => {
  const store = createChatDataStore({ indexedDB: null });
  await store.put(ID2, { thread: thread({ threadKey: KEY2, seq: 50, fingerprint: 'local' }), transcript: thread().transcript });
  const part = { version: 1, records: [
    { id: ID, threadKey: KEY, revision: 3, seq: 5, fingerprint: 'fp1', thread: thread() },
    { id: ID2, threadKey: KEY2, revision: 3, seq: 9, fingerprint: 'older', thread: thread({ threadKey: KEY2, seq: 9 }) },
  ], transcripts: [{ id: ID, threadKey: KEY, revision: 3, truncated: false, totalMessages: 4, messages: thread().transcript.messages }] };
  assert.deepEqual(await store.importBackup(part, { ids: [ID, ID2] }), { records: 1, transcripts: 1 });
  assert.equal((await store.get(ID)).fingerprint, 'fp1');
  assert.equal((await store.getTranscript(ID)).messages.length, 4);
  assert.equal((await store.get(ID2)).fingerprint, 'local', 'a newer local record wins');
  const other = createChatDataStore({ indexedDB: null });
  assert.deepEqual(await other.importBackup(part, { ids: [] }), { records: 0, transcripts: 0 });
});

test('module helpers use the shared store; tokens and ids', async () => {
  const previous = setChatDataStore(createChatDataStore({ indexedDB: null }));
  try {
    await putChatData(ID, { thread: thread(), transcript: thread().transcript });
    assert.equal((await getChatRecord(ID)).threadKey, KEY);
    assert.equal((await getChatTranscript(ID)).messages.length, 4);
    assert.deepEqual(await listChatDataIds(), [ID]);
    assert.equal((await chatDataStats()).chats, 1);
    assert.equal((await searchChats('lisbon')).total, 1);
    assert.deepEqual(await sweepChatData({ items: [{ id: ID }] }), { records: 0, transcripts: 0 });
    assert.equal(await deleteChatData(ID), 1);
  } finally { setChatDataStore(previous); }
  assert.deepEqual(chatSearchTokens('What did we decide about the Store.js refactor? store.js'), ['decide', 'store.js', 'refactor']);
  assert.ok(isChatId(ID));
  assert.ok(!isChatId('chat_tk_ABC'));
});

test('chatEntryFromThread maps a payload onto an upsertChats entry the store accepts', async () => {
  const { chatEntryFromThread } = await import('../extension/lib/chat-data.js');
  const { createLibraryStore } = await import('../extension/lib/store.js');
  const store = createChatDataStore({ indexedDB: null });
  const { transcript } = await store.put(ID, { thread: thread(), transcript: thread().transcript });
  const entry = chatEntryFromThread(thread(), { origin: 'manual', placement: { collectionId: '' }, tags: ['lisbon'], revive: true, transcript });
  assert.equal(entry.id, ID);
  assert.deepEqual(entry.item, { title: 'Planning the Lisbon trip', excerpt: 'Booked flights to Lisbon for May.', sourceUrl: 'https://chatgpt.com/c/abc', siteName: 'ChatGPT', createdAt: '2026-10-01T10:00:00.000Z' });
  assert.equal(entry.chat.hasTranscript, true);
  assert.equal(entry.chat.lastActivityAt, '2026-10-02T10:00:00.000Z');
  assert.deepEqual(entry.chat.topics, ['lisbon', 'flights']);
  assert.equal(chatEntryFromThread(thread({ revision: 9 }), { transcript }).chat.hasTranscript, false, 'a transcript of another revision does not count');
  let value = null;
  const library = createLibraryStore({ read: async () => value, write: async next => { value = next; } });
  const out = await library.dispatch('upsertChats', [[entry]]);
  assert.equal(out.results[0].status, 'created');
  assert.deepEqual(value.items[0].tags, ['lisbon']);
  assert.equal(value.items[0].chat.origin, 'manual');
  assert.throws(() => chatEntryFromThread(null), /needs its Threadkeeper thread/);
});
