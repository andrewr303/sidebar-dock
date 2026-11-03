// The assistant's two views of AI threads (docs/threadkeeper-integration.md; design §5 and R13):
//
// - `chats`: the chats saved in Still. Always available in the extension and never needs Threadkeeper: it reads each
//   chat's stored summary and transcript (lib/chat-data.js), builds the summary Markdown (lib/threadkeeper/summary.js),
//   searches saved chats offline, and gives the semantic index a short digest of each chat.
// - `threads`: Threadkeeper itself, through the page client (lib/threadkeeper/client.js). It exists only while Still
//   is paired, Threadkeeper offers the `search` capability and the user lets the assistant search AI threads
//   (prefs.assistant.search). Every response is validated and capped again here (lib/ai/thread-context.js), calls carry
//   timeouts, and three failures in a row pause Threadkeeper for five minutes so a crashed or slow Threadkeeper never
//   slows every question.
//
// createThreadSources(deps) -> { chats, threads(), state(), warm(), dispose() }; threadSources() is the shared instance
// bound to the real modules (app.js passes it to lib/ai/index.js init()).
import * as realClient from '../threadkeeper/client.js';
import * as realChatData from '../chat-data.js';
import { buildChatSummaryMarkdown } from '../threadkeeper/summary.js';
import { chatItemId } from '../threadkeeper/protocol.js';
import {
  sanitizeSearchResponse, sanitizeContextResponse, sanitizeGetResponse, sanitizeFacets, createBreaker, matchesFilters, tokens, line, clean,
  CITE_ID, hiddenChat, visibleChat, chatRow,
} from './thread-context.js';

const READ_TIMEOUT_MS = 10000;
const SEARCH_TIMEOUT_MS = 15000;
const TRANSCRIPT_TIMEOUT_MS = 30000;
const STATE_TTL_MS = 30000;
const DIGEST_CHARS = 4000;
const unique = values => [...new Set(values)];
const text = value => typeof value === 'string' ? value : '';
const abortError = signal => signal?.reason || new DOMException('Stopped', 'AbortError');

/** A Threadkeeper error the assistant can show: { code, message }. */
export class ThreadsUnavailable extends Error {
  constructor(message = 'Threadkeeper is not responding. The chats saved in Still are still available.', code = 'unavailable') { super(message); this.name = 'ThreadsUnavailable'; this.code = code; }
}

export { hiddenChat, visibleChat, chatRow };

/** A short plain-text digest of a stored chat for the semantic index (≤ 4,000 characters). */
export function chatDigest(record, item = {}) {
  const thread = record?.thread || {};
  const analysis = thread.analysis || {};
  const parts = [];
  const add = (label, value) => { const body = Array.isArray(value) ? value.filter(Boolean).join('\n') : text(value).trim(); if (body) parts.push(label ? `${label}: ${body}` : body); };
  add('', analysis.gist || item.excerpt);
  add('', Array.isArray(analysis.overview) && analysis.overview.length ? analysis.overview.join('\n\n') : analysis.summary);
  add('Goal', analysis.userGoal);
  add('Outcome', analysis.outcome);
  const items = list => (Array.isArray(list) ? list : []).map(entry => `- ${text(entry?.text)}`).filter(entry => entry.length > 2);
  add('Key points', items(analysis.keyPoints));
  add('Decisions', items(analysis.decisions));
  add('Next steps', items(analysis.actionItems));
  add('Open questions', items(analysis.openQuestions));
  add('Where it was left', analysis.whereYouLeftOff?.text);
  add('Topics', (analysis.topics || []).join(', '));
  add('Mentions', (analysis.entities || []).join(', '));
  return parts.join('\n\n').slice(0, DIGEST_CHARS);
}

/**
 * createThreadSources({ client, chatData, buildSummary, getLibrary, now }) -> { chats, threads, state, warm, refresh, dispose }
 * client: lib/threadkeeper/client.js (or a fake); chatData: lib/chat-data.js (or a fake); getLibrary(): the library.
 */
export function createThreadSources({ client = realClient, chatData = realChatData, buildSummary = buildChatSummaryMarkdown, getLibrary = null, now = () => Date.now(),
  breaker = createBreaker({ now }) } = {}) {
  let state = null;
  let loadedAt = 0;
  let loading = null;
  let unsubscribe = null;

  const refresh = () => loading ||= Promise.resolve().then(() => client.getThreadkeeperState?.()).then(value => { state = value || null; loadedAt = now(); return state; },
    () => { state = null; loadedAt = now(); return null; }).finally(() => { loading = null; });
  try { unsubscribe = client.onThreadkeeperChange?.(next => { if (next && typeof next === 'object') { state = next; loadedAt = now(); } else refresh(); }) || null; } catch { unsubscribe = null; }

  const capabilities = () => Array.isArray(state?.tk?.capabilities) ? state.tk.capabilities.filter(entry => typeof entry === 'string') : [];
  const assistantPrefs = () => {
    const prefs = state?.prefs?.assistant || {};
    return { search: prefs.search !== false, context: ['auto', 'always', 'off'].includes(prefs.context) ? prefs.context : 'auto', decision: prefs.decision !== false };
  };
  const enabled = () => state?.status === 'paired' && capabilities().includes('search') && assistantPrefs().search;

  // ---- chats saved in Still ----
  const libraryNow = async library => library || (typeof getLibrary === 'function' ? await getLibrary() : null);
  const chats = {
    hidden: hiddenChat,
    visible: visibleChat,
    /** The live library chat for a thread key (null when absent, trashed or private). */
    localChatFor(threadKey, library) {
      if (typeof threadKey !== 'string' || !threadKey) return null;
      const id = chatItemId(threadKey);
      const item = (library?.items || []).find(entry => entry?.id === id);
      return visibleChat(item) && text(item.chat?.threadKey) === threadKey ? item : null;
    },
    /** The live library chat a `tk:` cite id points to, or null. */
    chatForCite(citeId, library) {
      if (!CITE_ID.test(text(citeId))) return null;
      const prefix = `chat_tk_${citeId.slice(3)}`;
      return (library?.items || []).find(item => visibleChat(item) && item.id.startsWith(prefix)) || null;
    },
    /** The stored summary record and transcript of a chat: { record, transcript } or null. Never throws. */
    async readLocal(itemId) {
      if (typeof itemId !== 'string' || !itemId) return null;
      const [record, transcript] = await Promise.all([
        Promise.resolve().then(() => chatData.getChatRecord?.(itemId)).catch(() => null),
        Promise.resolve().then(() => chatData.getChatTranscript?.(itemId)).catch(() => null),
      ]);
      return record || transcript ? { record: record || null, transcript: transcript || null } : null;
    },
    /** The summary Markdown for a stored record (the same text the chat's Summary view shows). */
    summaryMarkdown(record, item = {}) {
      try { return text(buildSummary(record || { thread: {} }, item)); } catch { return item?.excerpt ? `## What this thread is about\n\n${item.excerpt}` : ''; }
    },
    /**
     * Searches the chats saved in Still: [{ ...chatRow, score, snippet, messageIndex? }]. Uses lib/chat-data.js
     * searchChats (summaries and transcripts) when the build has it, else the chats' titles, gists and metadata.
     */
    async searchLocal(query, { filters = {}, limit = 12, library } = {}) {
      const lib = await libraryNow(library);
      const items = new Map((lib?.items || []).filter(visibleChat).map(item => [item.id, item]));
      const rows = [];
      if (typeof chatData.searchChats === 'function') {
        try {
          const found = await chatData.searchChats(text(query), { filters, limit: Math.min(100, limit * 3) });
          for (const hit of Array.isArray(found) ? found : Array.isArray(found?.results) ? found.results : []) {
            const item = items.get(text(hit?.id) || text(hit?.itemId));
            if (!item) continue;
            const row = chatRow(item);
            if (!matchesFilters(row, filters)) continue;
            rows.push({ ...row, score: Number.isFinite(hit.score) ? hit.score : 0, snippet: clean(hit.snippet ?? hit.text, 220).trim(),
              ...(Number.isInteger(hit.messageIndex) ? { messageIndex: hit.messageIndex } : {}) });
          }
          if (rows.length) return rows.slice(0, limit);
        } catch {}
      }
      const terms = unique(tokens(query));
      for (const item of items.values()) {
        const row = chatRow(item);
        if (!matchesFilters(row, filters)) continue;
        const hay = [row.title, row.gist, row.providerLabel, row.project, row.kind, row.kindLabel, row.agentLabel, row.topics.join(' '), (item.tags || []).join(' '), text(item.content)].join('\n').toLowerCase();
        const score = terms.length ? terms.filter(term => hay.includes(term)).length / terms.length : 0.5;
        if (terms.length && score === 0) continue;
        rows.push({ ...row, score, snippet: line(row.gist || text(item.content), 220) });
      }
      return rows.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
    },
    /** The index digest of a chat item (lib/ai/indexer.js extraText hook). */
    async digest(item) {
      if (!visibleChat(item)) return '';
      const stored = await chats.readLocal(item.id);
      return stored?.record ? chatDigest(stored.record, item) : '';
    },
    /**
     * Removes chats an assistant import created, without marking them as deleted by the user (which would stop
     * Threadkeeper from offering them again). Resolves to the number removed, or null when this build cannot.
     */
    async undoImport(ids) {
      const list = (Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id);
      if (!list.length) return 0;
      if (typeof client.undoThreadkeeperImport !== 'function') return null;
      const result = await client.undoThreadkeeperImport(list);
      return Number.isFinite(result?.removed) ? result.removed : Number.isFinite(result) ? result : list.length;
    },
  };

  // ---- Threadkeeper ----
  async function request(type, fields, { timeoutMs = READ_TIMEOUT_MS, signal } = {}) {
    if (signal?.aborted) throw abortError(signal);
    if (breaker.open()) throw new ThreadsUnavailable();
    try {
      const data = await client.threadkeeperRequest(type, fields, { timeoutMs, signal });
      breaker.success();
      return data && typeof data === 'object' ? data : {};
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      const code = text(error?.code);
      // Answers about this request or this user's choices are not outages; everything else counts toward the pause.
      if (!['bad_request', 'not_found', 'too_large', 'busy'].includes(code)) breaker.failure();
      if (['not_paired', 'disabled', 'denied'].includes(code)) refresh();
      if (code === 'busy') throw new ThreadsUnavailable('Threadkeeper is busy. Try again in a moment.', 'busy');
      if (code === 'disabled') throw new ThreadsUnavailable('Threadkeeper does not let Still search its threads right now (Threadkeeper › Settings › Sidebar Dock).', 'disabled');
      if (code === 'not_paired') throw new ThreadsUnavailable('Still is no longer connected to Threadkeeper.', 'not_paired');
      if (['unreachable', 'unavailable', 'internal', 'timeout'].includes(code) || !code) throw new ThreadsUnavailable();
      throw new ThreadsUnavailable(line(error?.message, 300) || 'Threadkeeper could not answer.', code);
    }
  }

  const adapter = {
    get capabilities() { return capabilities(); },
    prefs: () => assistantPrefs(),
    /** Threadkeeper's hybrid search. remote: whether its embedding/rerank providers may be used (explicit searches only). */
    async search({ query = '', filters = {}, limit = 12, cursor = null, remote = false, rerank = true, signal } = {}) {
      const semantic = remote && capabilities().includes('remote_models') ? 'auto' : 'local';
      const size = Math.max(1, Math.min(50, Math.floor(limit) || 12));
      const fields = { query: text(query).slice(0, 2000), filters, limit: size, ...(cursor ? { cursor } : {}), semantic,
        rerank: rerank && semantic === 'auto' ? 'auto' : 'off', excerpts: true, deadlineMs: semantic === 'auto' ? 12000 : 6000 };
      const data = await request('threads.search', fields, { timeoutMs: SEARCH_TIMEOUT_MS, signal });
      return sanitizeSearchResponse(data, { limit: size });
    },
    async list({ filters = {}, sort = 'recent', cursor = null, limit = 20, signal } = {}) {
      const size = Math.max(1, Math.min(100, Math.floor(limit) || 20));
      const data = await request('threads.list', { filters, sort, limit: size, ...(cursor ? { cursor } : {}) }, { signal });
      return sanitizeSearchResponse(data, { limit: size });
    },
    /**
     * Thread payloads by threadKeys, citeIds or hashes (any mix), in batches of 20, asking again for deferred ones.
     * Never tracks: an assistant read must not sign a thread up for syncing. -> { threads, missing }
     */
    async get({ threadKeys = [], citeIds = [], hashes = [], transcript = 'none', window = null, signal } = {}) {
      const groups = [['threadKeys', unique(threadKeys)], ['citeIds', unique(citeIds)], ['hashes', unique(hashes)]];
      const threads = [];
      const missing = [];
      const timeoutMs = transcript === 'none' ? READ_TIMEOUT_MS : TRANSCRIPT_TIMEOUT_MS;
      for (const [key, values] of groups) {
        let pending = values.filter(value => typeof value === 'string' && value);
        for (let round = 0; pending.length && round < 8; round++) {
          const batch = pending.slice(0, 20);
          const data = await request('threads.get', { [key]: batch, transcript, ...(window ? { window } : {}), track: false }, { timeoutMs, signal });
          const parsed = sanitizeGetResponse(data);
          threads.push(...parsed.threads);
          missing.push(...parsed.missing);
          const deferred = parsed.deferred.filter(value => batch.includes(value));
          // A requested key that came back neither as a thread nor deferred is missing.
          const answered = new Set([...parsed.threads.map(thread => thread.threadKey), ...parsed.missing, ...deferred]);
          if (key === 'threadKeys') for (const value of batch) if (!answered.has(value)) missing.push(value);
          pending = [...deferred, ...pending.slice(20)];
          // Threadkeeper always sends at least one thread per answer; an answer with none ends the loop.
          if (!parsed.threads.length && deferred.length) { missing.push(...deferred); break; }
        }
      }
      const seen = new Set();
      return { threads: threads.filter(thread => !seen.has(thread.threadKey) && seen.add(thread.threadKey)), missing: unique(missing) };
    },
    /** Ask-style retrieval. Automatic context uses semantic 'local' and rerank 'off' (never remote models). */
    async context({ question = '', filters = {}, limit = 5, budgetChars = 12000, semantic = 'local', rerank = 'off', deadlineMs = 2500, signal } = {}) {
      const remote = semantic === 'auto' && capabilities().includes('remote_models');
      const deadline = Math.max(500, Math.min(remote ? 9000 : 2500, Math.floor(deadlineMs) || 2500));
      const size = Math.max(1, Math.min(8, Math.floor(limit) || 5));
      const budget = Math.max(1000, Math.min(24000, Math.floor(budgetChars) || 12000));
      const data = await request('threads.context', { question: text(question).slice(0, 4000), filters, limit: size, budgetChars: budget, semantic: remote ? 'auto' : 'local',
        rerank: remote && ['auto', 'on'].includes(rerank) ? rerank : 'off', deadlineMs: deadline }, { timeoutMs: deadline + 1000, signal });
      return sanitizeContextResponse(data, { limit: size, budgetChars: budget });
    },
    async facets({ signal } = {}) { return sanitizeFacets(await request('facets', {}, { signal })); },
    /** Brings threads into Still (origin 'assistant': never revives chats the user deleted or trashed). -> { results } */
    async importThreads(threadKeys, { target = null, origin = 'assistant' } = {}) {
      if (breaker.open()) throw new ThreadsUnavailable();
      try {
        const result = await client.importThreadkeeperThreads(unique(threadKeys).slice(0, 200), { ...(target ? { target } : {}), origin });
        breaker.success();
        return { results: Array.isArray(result?.results) ? result.results.filter(entry => entry && typeof entry === 'object') : [] };
      } catch (error) {
        const code = text(error?.code);
        if (!['bad_request', 'too_large', 'busy'].includes(code)) breaker.failure();
        throw new ThreadsUnavailable(code && !['unreachable', 'unavailable', 'internal'].includes(code) ? line(error?.message, 300) || 'Threadkeeper could not send these threads.'
          : 'Threadkeeper is not responding, so these threads could not be imported. Try again in a moment.', code || 'unavailable');
      }
    },
    async open(threadKey) { await request('thread.open', { threadKey }, { timeoutMs: 5000 }); },
    get paused() { return breaker.open(); },
  };

  return {
    chats,
    /** The Threadkeeper adapter for this turn, or null. Re-reads the integration state when it is older than 30 s. */
    async threads() {
      if (!state || now() - loadedAt > STATE_TTL_MS) await refresh();
      return enabled() ? adapter : null;
    },
    /** Last known integration state (or null), plus whether thread search is on. */
    state: () => state ? { status: state.status, capabilities: capabilities(), prefs: assistantPrefs(), enabled: enabled(), paused: breaker.open() } : null,
    /** Wakes Threadkeeper (and refreshes the state) when the assistant opens, so the first question is not slowed. */
    async warm() {
      await refresh();
      if (!enabled() || breaker.open()) return false;
      try { await client.threadkeeperRequest('sync.status', {}, { timeoutMs: 4000 }); return true; } catch { return false; }
    },
    refresh,
    dispose() { try { unsubscribe?.(); } catch {} unsubscribe = null; },
  };
}

let shared = null;
/** The shared thread sources over the real client and chat store (created on first use). */
export function threadSources(options = {}) {
  return shared ||= createThreadSources(options);
}
