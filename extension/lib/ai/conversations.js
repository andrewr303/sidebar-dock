// Assistant conversation history. The index key holds summaries for the history list; each conversation body lives
// under its own key so saving one turn rewrites only that conversation (the 0.2 store rewrote every chat each time).
//
// Durability rules: messages and conversations keep fields this build does not know (plain data only), so a newer
// build's additions survive an edit here. An index saved by a newer build (version > CONVERSATIONS_VERSION) is read but
// never rewritten: saves, deletes and imports throw a "newer version" error. Bodies are the source of truth: when the
// index is missing or corrupt, or lacks a body, the index entry is rebuilt from the body instead of the chat being lost.
export const CONVERSATIONS_KEY = 'still.ai.conversations.v2';
export const LEGACY_CHATS_KEY = 'still.ai.chats.v1';
export const BODY_PREFIX = 'still.ai.conversation.v2:';
export const CONVERSATIONS_VERSION = 2;
export const CONVERSATION_LIMITS = Object.freeze({ conversations: 300, messages: 400, messageChars: 200000, bytes: 4 * 1024 * 1024 });
const ROLES = ['user', 'assistant'];
const SCOPES = ['page', 'item', 'items', 'collection', 'library'];
const MESSAGE_KEYS = ['id', 'role', 'text', 'thinking', 'citations', 'tools', 'proposals', 'error', 'createdAt', 'model', 'connectionId', 'stopReason', 'thinkingMs', 'usage', 'context', 'browser', 'webSources'];
const CONVERSATION_KEYS = ['id', 'title', 'createdAt', 'updatedAt', 'connectionId', 'model', 'scope', 'messages'];
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Research conversations (kind 'research', lib/ai/research/run.js) keep a run record on the conversation and progress on
// each assistant message. Both are plain data that survive as unknown fields; these caps keep them bounded.
export const RESEARCH_RECORD_LIMITS = Object.freeze({ handled: 300, steps: 200 });
// What an answer did in browser tabs (lib/ai/browser-tools.js): the ledger the next turn reads, and the steps the
// assistant could not confirm. Bounded, and plain text only.
export const BROWSER_RECORD_LIMITS = Object.freeze({ activity: 60, line: 400, unverified: 20 });
// Bodies written per storage call when importing many conversations; an interrupted import leaves bodies the index
// lacks, which the next load recovers.
const IMPORT_BATCH = 20;

const text = (value, max = Infinity) => typeof value === 'string' ? value.slice(0, max) : '';
const stamp = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : '';
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const uid = prefix => `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
// Drops functions (proposal undo handlers) and anything else that cannot be persisted.
const plain = value => { try { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); } catch { return undefined; } };
const newestFirst = (a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt));
const time = value => Date.parse(value) || 0;

// Plain-data fields outside `known` (a newer build's additions), so they survive this build's edits.
function unknownFields(input, known) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (known.includes(key) || UNSAFE_KEYS.has(key)) continue;
    const copy = plain(value);
    if (copy !== undefined) output[key] = copy;
  }
  return output;
}

function newerVersionError() {
  const error = new Error('Your assistant conversations were saved by a newer version of Still. Update Still to keep saving them; nothing was changed.');
  error.code = 'newer_version';
  return error;
}

/**
 * In-memory storage with the same shape as the extension backend: get(key), set(entries), remove(keys) and keys().
 * keys() is optional on custom backends; without it orphaned bodies cannot be found.
 */
export function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  return {
    map,
    get: async key => map.has(key) ? structuredClone(map.get(key)) : undefined,
    set: async entries => { for (const [key, value] of Object.entries(entries)) map.set(key, structuredClone(value)); },
    remove: async keys => { for (const key of keys) map.delete(key); },
    keys: async () => [...map.keys()],
  };
}

export function defaultConversationStorage() {
  if (globalThis.chrome?.storage?.local) return {
    get: async key => (await chrome.storage.local.get(key))[key],
    set: entries => chrome.storage.local.set(entries),
    remove: keys => chrome.storage.local.remove(keys),
    // getKeys (Chrome 130+) lists keys without loading the library blob; older Chrome reads everything once.
    keys: async () => typeof chrome.storage.local.getKeys === 'function' ? chrome.storage.local.getKeys() : Object.keys(await chrome.storage.local.get(null)),
  };
  if (globalThis.localStorage) return {
    get: async key => { const raw = localStorage.getItem(key); if (raw === null) return undefined; try { return JSON.parse(raw); } catch { return undefined; } },
    set: async entries => { for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, JSON.stringify(value)); },
    remove: async keys => { for (const key of keys) localStorage.removeItem(key); },
    keys: async () => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(key => typeof key === 'string'),
  };
  return createMemoryStorage();
}

/** A short history title from the first question: first line, Markdown stripped, at most ~60 characters. */
export function titleFromQuestion(question, max = 60) {
  const line = text(question).split('\n').map(part => part.trim()).find(Boolean) || '';
  const clean = line.replace(/[`*_#>[\]]+/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New conversation';
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut.slice(0, max)).replace(/[\s,.;:!?-]+$/, '')}…`;
}

function normalizeScope(scope) {
  if (typeof scope === 'string') return SCOPES.includes(scope) ? { scope, ids: [], collectionId: '' } : null;
  if (!scope || typeof scope !== 'object' || !SCOPES.includes(scope.scope)) return null;
  const page = scope.page && typeof scope.page === 'object' ? { url: text(scope.page.url, 8192), title: text(scope.page.title, 1000) } : null;
  return { scope: scope.scope, ids: (Array.isArray(scope.ids) ? scope.ids : []).filter(id => typeof id === 'string').slice(0, 200),
    collectionId: text(scope.collectionId, 200), ...(page ? { page } : {}) };
}

/** Repairs one message. `now` is the timestamp used when the message has none (a conversation passes its own). */
// A message's browser record as stored: { activity: [{ step, kind, text }], unverified?: [label] }, or null without one.
function browserRecord(value) {
  if (!isObject(value)) return null;
  const activity = (Array.isArray(value.activity) ? value.activity : []).filter(line => isObject(line) && typeof line.text === 'string' && line.text)
    .slice(-BROWSER_RECORD_LIMITS.activity).map(line => ({ step: Number.isSafeInteger(line.step) && line.step >= 0 ? line.step : 0, kind: text(line.kind, 20) || 'action', text: text(line.text, BROWSER_RECORD_LIMITS.line) }));
  const unverified = (Array.isArray(value.unverified) ? value.unverified : []).filter(label => typeof label === 'string' && label).slice(0, BROWSER_RECORD_LIMITS.unverified)
    .map(label => text(label, BROWSER_RECORD_LIMITS.line));
  return activity.length || unverified.length ? { activity, ...(unverified.length ? { unverified } : {}) } : null;
}

export function normalizeMessage(input = {}, now = new Date().toISOString()) {
  const message = {
    ...unknownFields(input, MESSAGE_KEYS),
    id: text(input.id, 200) || uid('msg'),
    role: ROLES.includes(input.role) ? input.role : 'assistant',
    text: text(input.text, CONVERSATION_LIMITS.messageChars),
    thinking: text(input.thinking, 50000),
    citations: (Array.isArray(input.citations) ? input.citations : []).filter(c => c && typeof c.id === 'string')
      .slice(0, 100).map((c, index) => ({ n: Number.isSafeInteger(c.n) ? c.n : index + 1, id: c.id, title: text(c.title, 500), url: text(c.url, 8192),
        // An AI thread keeps its Threadkeeper key, so the citation can still be opened or imported after a reload.
        ...(c.kind === 'ai_thread' && typeof c.threadKey === 'string' && c.threadKey && c.threadKey.length <= 600 ? { kind: 'ai_thread', threadKey: c.threadKey } : {}) })),
    tools: (Array.isArray(input.tools) ? input.tools : []).filter(t => t && typeof t.name === 'string').slice(0, 50)
      .map(t => ({ name: t.name, summary: text(t.summary, 300), ...(t.isError ? { isError: true } : {}) })),
    proposals: (plain(Array.isArray(input.proposals) ? input.proposals : []) || []).slice(0, 10),
    error: text(input.error, 2000),
    createdAt: stamp(input.createdAt) || now,
  };
  for (const key of ['model', 'connectionId', 'stopReason']) if (typeof input[key] === 'string' && input[key]) message[key] = input[key].slice(0, 200);
  if (Number.isFinite(input.thinkingMs) && input.thinkingMs >= 0) message.thinkingMs = Math.round(input.thinkingMs);
  if (input.usage && typeof input.usage === 'object') message.usage = plain(input.usage);
  if (input.context && typeof input.context === 'object') message.context = normalizeScope(input.context) || undefined;
  if (!message.context) delete message.context;
  const browser = browserRecord(input.browser);
  if (browser) message.browser = browser;
  // The web pages an answer used (lib/ai/web-search.js): web addresses and titles only.
  const webSources = (Array.isArray(input.webSources) ? input.webSources : []).filter(source => isObject(source) && /^https?:\/\//i.test(text(source.url))).slice(0, 40)
    .map(source => ({ url: text(source.url, 2048), title: text(source.title, 300) }));
  if (webSources.length) message.webSources = webSources;
  if ('research' in message) {
    if (!isObject(message.research)) delete message.research;
    else if (Array.isArray(message.research.steps) && message.research.steps.length > RESEARCH_RECORD_LIMITS.steps) message.research.steps = message.research.steps.slice(-RESEARCH_RECORD_LIMITS.steps);
  }
  return message;
}

// The conversation-level research record: plain data (unknown fields kept); `handled` (custom tool results by event id,
// insertion order) keeps its newest entries.
function normalizeResearchRecord(record) {
  if (!isObject(record)) return undefined;
  if (!('handled' in record)) return record;
  const entries = isObject(record.handled) ? Object.entries(record.handled).filter(([key, value]) => !UNSAFE_KEYS.has(key) && typeof value === 'string') : [];
  return { ...record, handled: Object.fromEntries(entries.slice(-RESEARCH_RECORD_LIMITS.handled)) };
}

export function normalizeConversation(input = {}, { now = new Date().toISOString() } = {}) {
  // Valid timestamps are kept as written; a missing one falls back to the conversation's own times, so reading an old
  // record twice gives the same answer (and an untouched chat never jumps to the top of the history).
  const raw = (Array.isArray(input.messages) ? input.messages : []).filter(m => m && typeof m === 'object');
  const created = stamp(input.createdAt), updated = stamp(input.updatedAt);
  const fallback = updated || created || raw.map(m => stamp(m.createdAt)).filter(Boolean).at(-1) || now;
  let messages = raw.map(m => normalizeMessage(m, fallback)).slice(-CONVERSATION_LIMITS.messages);
  const firstQuestion = messages.find(m => m.role === 'user')?.text;
  const title = text(input.title, 200).trim();
  const createdAt = created || messages[0]?.createdAt || now;
  const conversation = {
    ...unknownFields(input, CONVERSATION_KEYS),
    id: text(input.id, 200) || uid('conversation'),
    title: title && title !== 'New conversation' ? title : titleFromQuestion(firstQuestion),
    createdAt,
    updatedAt: updated || messages.at(-1)?.createdAt || createdAt,
    connectionId: text(input.connectionId, 200),
    model: text(input.model, 200),
    scope: normalizeScope(input.scope),
    messages,
  };
  if ('kind' in conversation && (typeof conversation.kind !== 'string' || !conversation.kind)) delete conversation.kind;
  else if (typeof conversation.kind === 'string') conversation.kind = conversation.kind.slice(0, 40);
  if ('research' in conversation) {
    const research = normalizeResearchRecord(conversation.research);
    if (research) conversation.research = research; else delete conversation.research;
  }
  // Oldest turns go first when one conversation grows past the byte cap; the latest exchange always stays.
  while (messages.length > 2 && JSON.stringify(conversation).length > CONVERSATION_LIMITS.bytes) {
    messages = messages.slice(1);
    conversation.messages = messages;
  }
  return conversation;
}

// The history list's entry. A research conversation also carries its kind and { status, itemId }, so the list can badge
// it and a new run can find one already researching the same item without loading every body.
const summarize = conversation => {
  const lastAnswer = [...conversation.messages].reverse().find(m => m.role === 'assistant' && m.text)?.text || '';
  const summary = { id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
    connectionId: conversation.connectionId, model: conversation.model, scope: conversation.scope,
    messageCount: conversation.messages.length, preview: lastAnswer.replace(/\s+/g, ' ').trim().slice(0, 140) };
  if (typeof conversation.kind === 'string' && conversation.kind) summary.kind = conversation.kind;
  if (isObject(conversation.research)) summary.research = { status: text(conversation.research.status, 20), itemId: text(conversation.research.itemId, 200) };
  return summary;
};

/** Converts the 0.2 `still.ai.chats.v1` array into v2 conversations. Interrupted answers keep their text and get an error. */
export function migrateLegacyChats(chats, { now = new Date().toISOString() } = {}) {
  if (!Array.isArray(chats)) return [];
  return chats.filter(chat => chat && typeof chat === 'object' && Array.isArray(chat.messages)).map(chat => {
    const spaceKey = text(chat.spaceKey);
    const scope = spaceKey === 'inbox' ? { scope: 'collection', ids: [], collectionId: '' }
      : spaceKey.startsWith('space:') ? { scope: 'collection', ids: [], collectionId: spaceKey.slice(6) }
        : { scope: 'library', ids: [], collectionId: '' };
    const messages = chat.messages.filter(m => m && ROLES.includes(m.role)).map(m => {
      const status = text(m.status);
      const error = status === 'error' ? text(m.error) || 'The answer did not finish.'
        : status === 'stopped' ? 'Stopped' : status === 'streaming' ? 'Interrupted before the answer finished.' : '';
      return { id: text(m.id), role: m.role, text: text(m.content), createdAt: text(m.createdAt), error, model: text(m.model),
        usage: m.usage, citations: (Array.isArray(m.sources) ? m.sources : []).filter(s => s && typeof s.id === 'string')
          .map((s, index) => ({ n: index + 1, id: s.id, title: text(s.title), url: text(s.url) })) };
    });
    const model = [...messages].reverse().find(m => m.role === 'assistant' && m.model)?.model || '';
    return normalizeConversation({ id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt || chat.createdAt,
      model, scope, messages }, { now });
  });
}

export function createConversationStore({ storage, now = () => new Date().toISOString(), locks = globalThis.navigator?.locks } = {}) {
  const backend = () => storage ||= defaultConversationStorage();
  let queue = Promise.resolve();
  let prepared = null;
  // Writes from this view are serialized; Web Locks also serialize the side panel and the full tab when available.
  const exclusive = task => {
    const run = () => locks?.request ? locks.request('still.ai.conversations', task) : task();
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  };

  // { items, migratedLegacy, extra, missing, readOnly }. `missing` covers an absent or corrupt index (rebuilt from the
  // bodies); `readOnly` an index a newer build saved (listed, never rewritten). `extra` keeps unknown index fields.
  async function readIndex() {
    const value = await backend().get(CONVERSATIONS_KEY);
    const valid = isObject(value) && Array.isArray(value.items);
    return {
      items: valid ? value.items.filter(item => isObject(item) && typeof item.id === 'string' && item.id) : [],
      migratedLegacy: valid && value.migratedLegacy === true,
      extra: valid ? unknownFields(value, ['version', 'migratedLegacy', 'items']) : {},
      missing: !valid,
      readOnly: isObject(value) && Number(value.version) > CONVERSATIONS_VERSION,
    };
  }
  const indexValue = (index, items) => ({ ...index.extra, version: CONVERSATIONS_VERSION, migratedLegacy: true, items });

  // Every stored body id, or null when the backend cannot list keys.
  async function bodyIds() {
    if (typeof backend().keys !== 'function') return null;
    try {
      const keys = await backend().keys();
      return Array.isArray(keys) ? keys.filter(key => typeof key === 'string' && key.startsWith(BODY_PREFIX)).map(key => key.slice(BODY_PREFIX.length)).filter(Boolean) : null;
    } catch (error) { console.warn('[still] could not list saved conversations', error); return null; }
  }

  // Adds index entries for bodies the index lacks (lost or corrupt index, interrupted write) and drops entries whose
  // body is gone. Returns true when the item list changed. Never deletes a body.
  async function recover(index) {
    const ids = await bodyIds();
    if (!ids) return false;
    const present = new Set(ids);
    const known = new Set(index.items.map(item => item.id));
    let changed = false;
    const kept = index.items.filter(item => present.has(item.id));
    if (kept.length !== index.items.length) { index.items = kept; changed = true; }
    for (const id of ids) {
      if (known.has(id)) continue;
      const body = await backend().get(BODY_PREFIX + id);
      if (!isObject(body)) continue;
      index.items.push(summarize(normalizeConversation({ ...body, id }, { now: now() })));
      changed = true;
    }
    return changed;
  }

  // Runs once per store: recovers orphaned bodies, then migrates 0.2 chats once. Nothing is written for an index a newer
  // build saved.
  async function prepare() {
    const index = await readIndex();
    if (index.readOnly) return;
    let changed = await recover(index) || index.missing;
    const entries = {};
    if (!index.migratedLegacy) {
      const legacy = await backend().get(LEGACY_CHATS_KEY);
      const known = new Set(index.items.map(item => item.id));
      const conversations = migrateLegacyChats(legacy, { now: now() }).filter(c => !known.has(c.id));
      for (const conversation of conversations) entries[BODY_PREFIX + conversation.id] = conversation;
      index.items.push(...conversations.map(summarize));
      // The legacy key is left in place as a read-only backup; the flag makes migration run once.
      changed = true;
    }
    if (changed) await backend().set({ ...entries, [CONVERSATIONS_KEY]: indexValue(index, index.items.sort(newestFirst)) });
  }
  const ready = () => prepared ||= exclusive(prepare).catch(error => { prepared = null; throw error; });

  // The index a write builds on (call inside the lock): refuses a newer build's index and rebuilds a lost one.
  async function writableIndex() {
    const index = await readIndex();
    if (index.readOnly) throw newerVersionError();
    if (index.missing) await recover(index);
    return index;
  }

  async function listConversations() {
    await ready();
    const { items } = await readIndex();
    return [...items].sort(newestFirst);
  }
  async function getConversation(id) {
    if (typeof id !== 'string' || !id) return null;
    await ready();
    const body = await backend().get(BODY_PREFIX + id);
    return isObject(body) ? normalizeConversation(body, { now: now() }) : null;
  }
  async function saveConversation(input) {
    if (!input || typeof input !== 'object') throw new Error('Conversation must be an object.');
    await ready();
    return exclusive(async () => {
      const index = await writableIndex();
      const conversation = normalizeConversation({ ...input, updatedAt: input.updatedAt || now() }, { now: now() });
      const items = [summarize(conversation), ...index.items.filter(item => item.id !== conversation.id)].sort(newestFirst);
      const dropped = items.splice(CONVERSATION_LIMITS.conversations).map(item => BODY_PREFIX + item.id);
      await backend().set({ [BODY_PREFIX + conversation.id]: conversation, [CONVERSATIONS_KEY]: indexValue(index, items) });
      if (dropped.length) await backend().remove(dropped);
      return conversation;
    });
  }
  async function deleteConversation(id) {
    await ready();
    return exclusive(async () => {
      const index = await writableIndex();
      // Body first: if the page closes in between, the leftover index entry has no body and recovery drops it. The other
      // order would leave an orphaned body that recovery brings back, so a deleted chat would reappear.
      await backend().remove([BODY_PREFIX + id]);
      await backend().set({ [CONVERSATIONS_KEY]: indexValue(index, index.items.filter(item => item.id !== id)) });
      return { id, deleted: true };
    });
  }

  /** Every saved conversation in full, newest first: { version: 2, conversations } (for backups). */
  async function exportAll() {
    await ready();
    const { items } = await readIndex();
    const bodies = await Promise.all([...items].sort(newestFirst).map(item => backend().get(BODY_PREFIX + item.id)));
    return { version: CONVERSATIONS_VERSION, conversations: bodies.filter(isObject).map(body => normalizeConversation(body, { now: now() })) };
  }

  /**
   * Restores conversations from exportAll() output. A conversation already here is replaced only when the incoming copy
   * is newer (updatedAt); new ones are added while there is room under the conversation limit (newest first), so an
   * import never evicts a conversation saved on this device. Returns { added, updated, skipped }.
   */
  async function importAll(data) {
    if (!isObject(data) || !Array.isArray(data.conversations)) throw new Error('This file has no assistant conversations to restore.');
    if (Number(data.version) > CONVERSATIONS_VERSION) {
      const error = new Error('These assistant conversations come from a newer version of Still. Update Still to restore them; nothing was changed.');
      error.code = 'newer_version';
      throw error;
    }
    await ready();
    return exclusive(async () => {
      const index = await writableIndex();
      let skipped = 0;
      // One copy per id: the newest.
      const incoming = new Map();
      for (const raw of data.conversations) {
        if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 200 || !Array.isArray(raw.messages)) { skipped++; continue; }
        const conversation = normalizeConversation(plain(raw) || {}, { now: now() });
        const other = incoming.get(conversation.id);
        if (other) skipped++;
        if (!other || time(conversation.updatedAt) > time(other.updatedAt)) incoming.set(conversation.id, conversation);
      }
      const local = new Map(index.items.map(item => [item.id, item]));
      const updates = [], additions = [];
      for (const conversation of incoming.values()) {
        const existing = local.get(conversation.id);
        if (!existing) additions.push(conversation);
        else if (time(conversation.updatedAt) > time(existing.updatedAt)) updates.push(conversation);
        else skipped++;
      }
      additions.sort(newestFirst);
      const room = Math.max(0, CONVERSATION_LIMITS.conversations - index.items.length);
      // Left out only because this device already holds the most chats it keeps: reported apart, so it is not mistaken
      // for "already here".
      const full = Math.max(0, additions.length - room);
      skipped += full;
      const written = [...updates, ...additions.slice(0, room)];
      if (!written.length) return { added: 0, updated: 0, skipped, full };
      for (let start = 0; start < written.length; start += IMPORT_BATCH) {
        await backend().set(Object.fromEntries(written.slice(start, start + IMPORT_BATCH).map(c => [BODY_PREFIX + c.id, c])));
      }
      const replaced = new Set(written.map(c => c.id));
      const items = [...index.items.filter(item => !replaced.has(item.id)), ...written.map(summarize)].sort(newestFirst);
      await backend().set({ [CONVERSATIONS_KEY]: indexValue(index, items) });
      return { added: written.length - updates.length, updated: updates.length, skipped, full };
    });
  }

  return { listConversations, getConversation, saveConversation, deleteConversation, exportAll, importAll };
}
