// Assistant conversation history. The index key holds summaries for the history list; each conversation body lives
// under its own key so saving one turn rewrites only that conversation (the 0.2 store rewrote every chat each time).
export const CONVERSATIONS_KEY = 'still.ai.conversations.v2';
export const LEGACY_CHATS_KEY = 'still.ai.chats.v1';
const BODY_PREFIX = 'still.ai.conversation.v2:';
// bytes caps one conversation; totalBytes caps all of them together (oldest conversations go first).
export const CONVERSATION_LIMITS = Object.freeze({ conversations: 300, messages: 400, messageChars: 200000, bytes: 4 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 });
const ROLES = ['user', 'assistant'];
const SCOPES = ['page', 'item', 'items', 'collection', 'library'];

const text = (value, max = Infinity) => typeof value === 'string' ? value.slice(0, max) : '';
const stamp = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : '';
const uid = prefix => `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
// Drops functions (proposal undo handlers) and anything else that cannot be persisted.
const plain = value => { try { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); } catch { return undefined; } };

export function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  return {
    map,
    get: async key => map.has(key) ? structuredClone(map.get(key)) : undefined,
    set: async entries => { for (const [key, value] of Object.entries(entries)) map.set(key, structuredClone(value)); },
    remove: async keys => { for (const key of keys) map.delete(key); },
  };
}

export function defaultConversationStorage() {
  if (globalThis.chrome?.storage?.local) return {
    get: async key => (await chrome.storage.local.get(key))[key],
    set: entries => chrome.storage.local.set(entries),
    remove: keys => chrome.storage.local.remove(keys),
  };
  if (globalThis.localStorage) return {
    get: async key => { const raw = localStorage.getItem(key); if (raw === null) return undefined; try { return JSON.parse(raw); } catch { return undefined; } },
    set: async entries => { for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, JSON.stringify(value)); },
    remove: async keys => { for (const key of keys) localStorage.removeItem(key); },
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

export function normalizeMessage(input = {}, now = new Date().toISOString()) {
  const message = {
    id: text(input.id, 200) || uid('msg'),
    role: ROLES.includes(input.role) ? input.role : 'assistant',
    text: text(input.text, CONVERSATION_LIMITS.messageChars),
    thinking: text(input.thinking, 50000),
    citations: (Array.isArray(input.citations) ? input.citations : []).filter(c => c && typeof c.id === 'string')
      .slice(0, 100).map((c, index) => ({ n: Number.isSafeInteger(c.n) ? c.n : index + 1, id: c.id, title: text(c.title, 500), url: text(c.url, 8192) })),
    tools: (Array.isArray(input.tools) ? input.tools : []).filter(t => t && typeof t.name === 'string').slice(0, 50)
      .map(t => ({ name: t.name, summary: text(t.summary, 300), ...(t.isError ? { isError: true } : {}) })),
    proposals: (plain(Array.isArray(input.proposals) ? input.proposals : []) || []).slice(0, 10),
    error: text(input.error, 2000),
    createdAt: stamp(input.createdAt) || now,
  };
  for (const key of ['model', 'connectionId', 'stopReason', 'errorCode']) if (typeof input[key] === 'string' && input[key]) message[key] = input[key].slice(0, 200);
  if (Number.isFinite(input.thinkingMs) && input.thinkingMs >= 0) message.thinkingMs = Math.round(input.thinkingMs);
  if (input.usage && typeof input.usage === 'object') message.usage = plain(input.usage);
  if (input.context && typeof input.context === 'object') message.context = normalizeScope(input.context) || undefined;
  if (!message.context) delete message.context;
  return message;
}

export function normalizeConversation(input = {}, { now = new Date().toISOString() } = {}) {
  let messages = (Array.isArray(input.messages) ? input.messages : []).map(m => normalizeMessage(m, now)).slice(-CONVERSATION_LIMITS.messages);
  const firstQuestion = messages.find(m => m.role === 'user')?.text;
  const title = text(input.title, 200).trim();
  const conversation = {
    id: text(input.id, 200) || uid('conversation'),
    title: title && title !== 'New conversation' ? title : titleFromQuestion(firstQuestion),
    createdAt: stamp(input.createdAt) || now,
    updatedAt: stamp(input.updatedAt) || now,
    connectionId: text(input.connectionId, 200),
    model: text(input.model, 200),
    scope: normalizeScope(input.scope),
    messages,
  };
  // Oldest turns go first when one conversation grows past the byte cap; the latest exchange always stays.
  // Sizes are measured once per message so trimming stays linear for long conversations.
  let size = JSON.stringify(conversation).length;
  if (size > CONVERSATION_LIMITS.bytes && messages.length > 2) {
    const sizes = messages.map(m => JSON.stringify(m).length + 1);
    let drop = 0;
    while (messages.length - drop > 2 && size > CONVERSATION_LIMITS.bytes) size -= sizes[drop++];
    messages = messages.slice(drop);
    conversation.messages = messages;
  }
  return conversation;
}

const summarize = conversation => {
  const lastAnswer = [...conversation.messages].reverse().find(m => m.role === 'assistant' && m.text)?.text || '';
  return { id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
    connectionId: conversation.connectionId, model: conversation.model, scope: conversation.scope,
    messageCount: conversation.messages.length, preview: lastAnswer.replace(/\s+/g, ' ').trim().slice(0, 140), bytes: JSON.stringify(conversation).length };
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
  let migrated = null;
  // Writes from this view are serialized; Web Locks also serialize the side panel and the full tab when available.
  const exclusive = task => {
    const run = () => locks?.request ? locks.request('still.ai.conversations', task) : task();
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  };
  async function readIndex() {
    const value = await backend().get(CONVERSATIONS_KEY);
    return value && Array.isArray(value.items) ? { version: 2, items: value.items, migratedLegacy: value.migratedLegacy === true } : { version: 2, items: [], migratedLegacy: false };
  }
  async function migrate() {
    const index = await readIndex();
    if (index.migratedLegacy) return;
    const legacy = await backend().get(LEGACY_CHATS_KEY);
    const known = new Set(index.items.map(item => item.id));
    const conversations = migrateLegacyChats(legacy, { now: now() }).filter(c => !known.has(c.id));
    const entries = Object.fromEntries(conversations.map(c => [BODY_PREFIX + c.id, c]));
    // The legacy key is left in place as a read-only backup; the flag makes migration run once.
    await backend().set({ ...entries, [CONVERSATIONS_KEY]: { version: 2, migratedLegacy: true, items: [...index.items, ...conversations.map(summarize)] } });
  }
  const ready = () => migrated ||= exclusive(migrate).catch(error => { migrated = null; throw error; });

  async function listConversations() {
    await ready();
    const { items } = await readIndex();
    return [...items].sort((a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt)));
  }
  async function getConversation(id) {
    if (typeof id !== 'string' || !id) return null;
    await ready();
    const body = await backend().get(BODY_PREFIX + id);
    return body ? normalizeConversation(body, { now: now() }) : null;
  }
  async function saveConversation(input) {
    if (!input || typeof input !== 'object') throw new Error('Conversation must be an object.');
    await ready();
    return exclusive(async () => {
      const conversation = normalizeConversation({ ...input, updatedAt: input.updatedAt || now() }, { now: now() });
      const index = await readIndex();
      const saved = summarize(conversation);
      const others = index.items.filter(item => item.id !== conversation.id).sort((a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt)));
      // The conversation being saved always stays; the oldest others go past the count or total size caps.
      const items = [saved];
      const dropped = [];
      let total = saved.bytes;
      for (const item of others) {
        const bytes = Number.isFinite(item.bytes) ? item.bytes : 0;
        if (items.length >= CONVERSATION_LIMITS.conversations || total + bytes > CONVERSATION_LIMITS.totalBytes) dropped.push(BODY_PREFIX + item.id);
        else { items.push(item); total += bytes; }
      }
      items.sort((a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt)));
      await backend().set({ [BODY_PREFIX + conversation.id]: conversation, [CONVERSATIONS_KEY]: { version: 2, migratedLegacy: true, items } });
      if (dropped.length) await backend().remove(dropped);
      return conversation;
    });
  }
  async function deleteConversation(id) {
    await ready();
    return exclusive(async () => {
      const index = await readIndex();
      await backend().set({ [CONVERSATIONS_KEY]: { version: 2, migratedLegacy: true, items: index.items.filter(item => item.id !== id) } });
      await backend().remove([BODY_PREFIX + id]);
      return { id, deleted: true };
    });
  }
  return { listConversations, getConversation, saveConversation, deleteConversation };
}
