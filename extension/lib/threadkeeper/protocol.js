/*
 * Still ⇄ Threadkeeper protocol (docs/threadkeeper-integration.md): constants, envelopes, ids and validators.
 * Pure and shared by the service worker, extension pages and tests. Everything that arrives from Threadkeeper is
 * untrusted: these helpers coerce, cap and drop, and never let a malformed value through as-is.
 *
 * threadHash / chatItemId / threadCiteId are part of the cross-repository contract: Threadkeeper computes the same values
 * (shared test vectors in both repositories). Never change them.
 */
export const PROTO = 'still-threadkeeper/1';
export const APP_NAME = 'Still';
export const MAX_MESSAGE_CHARS = 4 * 1024 * 1024;
export const PENDING_TTL_MS = 10 * 60 * 1000;

// Messages Threadkeeper sends to Still, and the ones Still sends to Threadkeeper.
export const MESSAGE_TYPES_IN = Object.freeze(['hello', 'pair.granted', 'pair.denied', 'pair.revoke', 'threads.upsert',
  'threads.remove', 'collections.list', 'chats.status']);
export const MESSAGE_TYPES_OUT = Object.freeze(['hello', 'pair.request', 'pair.revoke', 'sync.configure', 'sync.resync',
  'sync.status', 'threads.search', 'threads.list', 'threads.get', 'threads.context', 'threads.related', 'threads.untrack',
  'threads.analyze', 'facets', 'thread.open']);
// Requests extension pages may send through the worker (reads, plus asking Threadkeeper to open or re-analyze a thread).
export const READ_TYPES = Object.freeze(['threads.search', 'threads.list', 'threads.get', 'threads.context', 'threads.related',
  'facets', 'thread.open', 'sync.status', 'threads.analyze']);
// An unpaired (or not yet paired) sender may only say hello or answer the pairing request Still sent it.
export const UNPAIRED_TYPES = Object.freeze(['hello', 'pair.granted', 'pair.denied']);
export const ERROR_CODES = Object.freeze(['not_paired', 'pending_approval', 'denied', 'bad_request', 'unsupported',
  'version_mismatch', 'too_large', 'busy', 'disabled', 'not_found', 'internal']);
export const CAPABILITIES = Object.freeze(['sync', 'search', 'context', 'transcripts', 'open', 'remote_models', 'analyze']);
export const CATEGORIES = Object.freeze(['chat', 'coding_agent', 'agent', 'builder', 'search', 'companion']);
export const WORKFLOW_STATES = Object.freeze(['active', 'needs_review', 'waiting', 'paused', 'done', 'archived']);
export const COVERAGES = Object.freeze(['full', 'partial', 'title_only', 'metadata_only', 'stale']);
export const ROLES = Object.freeze(['user', 'assistant', 'system', 'tool']);
export const SPEAKERS = Object.freeze(['user_committed', 'assistant_suggested']);
export const REMOVE_REASONS = Object.freeze(['deleted', 'local_only', 'out_of_scope']);
export const UPSERT_ORIGINS = Object.freeze(['sync', 'manual']);
export const LIMITS = Object.freeze({
  threadKey: 600, upsertThreads: 50, removeKeys: 200, statusKeys: 500, getKeys: 20, untrackHashes: 500, analyzeKeys: 50,
  importKeys: 200, messages: 4000, messageChars: 120000, transcriptChars: 3 * 1024 * 1024, windowCount: 500,
  searchLimit: 50, listLimit: 100, contextLimit: 8, contextBudget: 24000, relatedLimit: 20, searchDeadline: 12000,
  contextDeadline: 9000, query: 2000, cursor: 500,
});
// Sender-side timeouts (protocol "Envelope").
export const TIMEOUTS = Object.freeze({ default: 10000, search: 15000, transcript: 30000 });

const MASK = 0xffffffffffffffffn;
function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(String(text))) { hash ^= BigInt(byte); hash = (hash * 0x100000001b3n) & MASK; }
  return hash.toString(16).padStart(16, '0');
}
/** 32 lowercase hex chars; identical to Threadkeeper's threadHash. */
export const threadHash = threadKey => fnv1a64(threadKey) + fnv1a64(`still:${threadKey}`);
export const chatItemId = threadKey => `chat_tk_${threadHash(threadKey)}`;
export const threadCiteId = threadKey => `tk:${threadHash(threadKey).slice(0, 16)}`;
export const CHAT_ID_PREFIX = 'chat_tk_';
export const isChatItemId = value => typeof value === 'string' && /^chat_tk_[0-9a-f]{32}$/.test(value);
export const hashOfChatId = id => (isChatItemId(id) ? id.slice(CHAT_ID_PREFIX.length) : '');
export const isCiteId = value => typeof value === 'string' && /^tk:[0-9a-f]{16}$/.test(value);
export const isThreadHash = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
export const isExtensionId = value => typeof value === 'string' && /^[a-p]{32}$/.test(value);
/** 8 hex chars of a normalized one-line text: how a chat remembers what sync last wrote (title/excerpt) without a copy. */
export const syncedHash = value => fnv1a64(oneLine(value)).slice(0, 8);

export class ThreadkeeperError extends Error {
  constructor(code, message, { retryAfterMs } = {}) {
    super(message || code);
    this.name = 'ThreadkeeperError';
    this.code = code;
    if (Number.isFinite(retryAfterMs)) this.retryAfterMs = retryAfterMs;
  }
}

// What the user reads when a request fails; specific codes keep their own wording.
const ERROR_TEXT = {
  unreachable: 'Threadkeeper is not responding. It may be turned off, updating or uninstalled; your chats in Still stay available.',
  not_paired: 'Threadkeeper is not connected to Still any more. Connect it again in Settings.',
  pending_approval: 'Threadkeeper is still waiting for you to allow Still.',
  denied: 'Threadkeeper refused the connection. Allow Still again in Threadkeeper’s settings.',
  bad_request: 'Threadkeeper could not read that request.',
  unsupported: 'This version of Threadkeeper does not support that. Update Threadkeeper and try again.',
  version_mismatch: 'Still and Threadkeeper speak different versions of the link. Update both and try again.',
  too_large: 'That was too large to send in one go.',
  busy: 'Threadkeeper is busy. Try again in a moment.',
  disabled: 'Searching threads is turned off in Threadkeeper (Settings → Sidebar Dock).',
  not_found: 'Threadkeeper does not have that thread any more.',
  internal: 'Threadkeeper ran into a problem. Try again in a moment.',
  unavailable: 'Threadkeeper works when Still runs as an extension.',
};
export const errorText = code => ERROR_TEXT[code] || ERROR_TEXT.internal;

/** A ThreadkeeperError for a failed response ({ ok: false, error }) or anything unreadable. */
export function errorFromResponse(response) {
  const error = isObject(response?.error) ? response.error : {};
  const code = typeof error.code === 'string' && /^[a-z_]{1,40}$/.test(error.code) ? error.code : 'internal';
  // Threadkeeper's own message is shown only for codes without a fixed text, and only as one clean line.
  const message = ERROR_TEXT[code] || oneLine(error.message, 300) || ERROR_TEXT.internal;
  const retryAfterMs = Number.isFinite(error.retryAfterMs) ? clampInt(error.retryAfterMs, 0, 600000) : undefined;
  return new ThreadkeeperError(code, message, { retryAfterMs });
}

const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
export const newRequestId = uuid;
/** An outgoing message from Still. */
export const envelope = (type, fields = {}, requestId = uuid()) => ({ ...fields, proto: PROTO, from: 'still', type, requestId });
export const isEnvelope = message => isObject(message) && typeof message.type === 'string' && typeof message.proto === 'string';
/** Flat protocol responses (never wrapped in { ok, result }). */
export const okResponse = (data = {}) => ({ ...data, ok: true, proto: PROTO });
export function errorResponse(code, message, retryAfterMs) {
  const error = { code, message: message || errorText(code) };
  if (Number.isFinite(retryAfterMs)) error.retryAfterMs = Math.max(0, Math.round(retryAfterMs));
  return { ok: false, proto: PROTO, error };
}
/** JSON size of a value in characters, or Infinity when it cannot be serialized. */
export function jsonSize(value) {
  try { return JSON.stringify(value)?.length ?? 0; } catch { return Infinity; }
}

/**
 * True only for an extension page of `id` (never one of its content scripts): sender.id is the id, there is no tab, and
 * the page URL starts with chrome-extension://<id>/ or the origin is exactly chrome-extension://<id>.
 */
export function isTrustedSender(sender, id) {
  if (!isObject(sender) || !isExtensionId(id) || sender.id !== id || sender.tab) return false;
  const base = `chrome-extension://${id}`;
  return (typeof sender.url === 'string' && sender.url.startsWith(`${base}/`)) || sender.origin === base;
}

// ---------------------------------------------------------------------------------------------------------------
// Coercion helpers (untrusted input → bounded values).
function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
// C0/C1 controls except tab and newline, plus bidi overrides/isolates and other invisible format characters.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const cap = (value, max) => (value.length > max ? value.slice(0, max) : value);
/** One clean line: controls removed, whitespace collapsed, capped. */
export function oneLine(value, max = 300) {
  if (typeof value !== 'string') return '';
  return cap(value.replace(CONTROL, '').replace(/\s+/g, ' ').trim(), max);
}
/** Multi-line text: controls removed (newlines and tabs kept), CRLF normalized, capped. */
export function multiLine(value, max = 4000) {
  if (typeof value !== 'string') return '';
  return cap(value.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim(), max);
}
export function clampInt(value, min, max, fallback = min) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}
const bool = value => value === true;
const oneOf = (value, allowed, fallback = '') => (allowed.includes(value) ? value : fallback);
/** ISO 8601 string or null. */
export function isoOrNull(value) {
  if (typeof value !== 'string' || !value || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
/** A list of unique one-line strings, capped in count and length. */
export function stringList(value, maxCount, maxLength) {
  const out = [], seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    const clean = oneLine(entry, maxLength);
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase()); out.push(clean);
    if (out.length >= maxCount) break;
  }
  return out;
}
const idList = (value, maxCount, test) => [...new Set((Array.isArray(value) ? value : []).filter(test))].slice(0, maxCount);
const providerId = value => (typeof value === 'string' && /^[a-z0-9_]{1,40}$/.test(value) ? value : '');
/** An https (or http) address without credentials, else ''. */
export function webUrl(value, { httpsOnly = true } = {}) {
  if (typeof value !== 'string' || !value || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (!(url.protocol === 'https:' || (!httpsOnly && url.protocol === 'http:')) || url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}
export const isThreadKey = value => typeof value === 'string' && value.length > 0 && value.length <= LIMITS.threadKey
  && !/[\u0000-\u001F\u007F]/.test(value);

// ---------------------------------------------------------------------------------------------------------------
// Resume commands: only `claude --resume '<id>'` / `codex resume '<id>'`, optionally after `cd '<path>' &&`.
const RESUME = /^(?:cd '((?:[^'\u0000-\u001F]|'\\'')*)' && )?(claude --resume|codex resume) '([\w-]{1,128})'$/;
const shellQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;
/** { tool: 'claude'|'codex', id, path } from a command Threadkeeper sent, or null when it is anything else. */
export function parseResumeCommand(value) {
  if (typeof value !== 'string' || value.length > 1000) return null;
  const match = RESUME.exec(value.trim());
  if (!match) return null;
  const path = match[1] === undefined ? '' : match[1].replace(/'\\''/g, "'");
  if (path.length > 400) return null;
  return { tool: match[2].startsWith('claude') ? 'claude' : 'codex', id: match[3], path };
}
/** The command rebuilt from validated parts (always re-quoted), or '' when the parts are not valid. */
export function buildResumeCommand({ tool, id, path = '' } = {}) {
  if (!['claude', 'codex'].includes(tool) || typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) return '';
  if (typeof path !== 'string' || path.length > 400 || /[\u0000-\u001F\u007F]/.test(path)) return '';
  const command = tool === 'claude' ? `claude --resume ${shellQuote(id)}` : `codex resume ${shellQuote(id)}`;
  return path ? `cd ${shellQuote(path)} && ${command}` : command;
}
/** A resume command from Threadkeeper, re-validated and rebuilt, or ''. */
export const safeResumeCommand = value => { const parts = parseResumeCommand(value); return parts ? buildResumeCommand(parts) : ''; };

// ---------------------------------------------------------------------------------------------------------------
// Thread shapes.
const refs = value => idList(value, 12, ref => Number.isInteger(ref) && ref >= 0 && ref < 1e6);
const refOrNull = value => (Number.isInteger(value) && value >= 0 && value < 1e6 ? value : null);
function evidence(value, max = 20) {
  const out = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (!isObject(entry)) continue;
    const text = multiLine(entry.text, 1200);
    if (!text) continue;
    out.push({ text, rationale: multiLine(entry.rationale, 800), speaker: oneOf(entry.speaker, SPEAKERS, 'assistant_suggested'),
      refs: refs(entry.refs), quote: multiLine(entry.quote, 500) });
    if (out.length >= max) break;
  }
  return out;
}

/** A ThreadSummary from Threadkeeper, coerced and capped. Throws when it has no usable threadKey. */
export function sanitizeThreadSummary(raw) {
  if (!isObject(raw) || !isThreadKey(raw.threadKey)) throw new ThreadkeeperError('bad_request', 'A thread is missing its key.');
  const { threadKey } = raw;
  const summary = {
    threadKey, hash: threadHash(threadKey),
    title: oneLine(raw.title, 300) || 'Untitled chat', gist: oneLine(raw.gist, 400),
    provider: providerId(raw.provider) || 'unknown', providerLabel: oneLine(raw.providerLabel, 80),
    category: oneOf(raw.category, CATEGORIES, 'chat'), agentLabel: oneLine(raw.agentLabel, 120),
    kind: oneLine(raw.kind, 40), kindLabel: oneLine(raw.kindLabel, 60), project: oneLine(raw.project, 200),
    workflowState: oneOf(raw.workflowState, WORKFLOW_STATES), createdAt: isoOrNull(raw.createdAt), updatedAt: isoOrNull(raw.updatedAt),
    messageCount: clampInt(raw.messageCount, 0, 1e6, 0), url: webUrl(raw.url), model: oneLine(raw.model, 120),
    workspacePath: oneLine(raw.workspacePath, 400), branchId: oneLine(raw.branchId, 200),
    siblingThreadKeys: idList(raw.siblingThreadKeys, 20, isThreadKey).filter(key => key !== threadKey),
    analysisVersion: clampInt(raw.analysisVersion, 0, 99, 0),
  };
  if (!summary.providerLabel) summary.providerLabel = summary.provider === 'unknown' ? 'AI chat' : summary.provider;
  if (raw.score !== undefined) summary.score = Number.isFinite(raw.score) ? Math.min(1, Math.max(0, raw.score)) : 0;
  if (raw.match !== undefined) summary.match = oneOf(raw.match, ['strong', 'weak'], 'weak');
  if (raw.matchReasons !== undefined) summary.matchReasons = stringList(raw.matchReasons, 5, 120);
  if (raw.excerpt !== undefined) {
    summary.excerpt = isObject(raw.excerpt) && multiLine(raw.excerpt.text, 600)
      ? { text: multiLine(raw.excerpt.text, 600), messageIndex: refOrNull(raw.excerpt.messageIndex), role: oneOf(raw.excerpt.role, ROLES, '') }
      : null;
  }
  return summary;
}

function sanitizeAnalysis(raw) {
  if (!isObject(raw)) return null;
  const analysis = {
    source: oneOf(raw.source, ['ai', 'local'], 'local'), model: oneLine(raw.model, 120), modelLabel: oneLine(raw.modelLabel, 80),
    generatedAt: isoOrNull(raw.generatedAt) || '', stale: bool(raw.stale), analysisVersion: clampInt(raw.analysisVersion, 0, 99, 0),
    gist: oneLine(raw.gist, 400), overview: [], summary: multiLine(raw.summary, 4000),
    userGoal: multiLine(raw.userGoal, 1200), outcome: multiLine(raw.outcome, 1200), statusReason: multiLine(raw.statusReason, 1200),
    kind: oneLine(raw.kind, 40), kindLabel: oneLine(raw.kindLabel, 60),
    topics: stringList(raw.topics, 12, 60), entities: stringList(raw.entities, 24, 100), languages: stringList(raw.languages, 12, 40),
    keyPoints: [], artifacts: [], whereYouLeftOff: null, nextStep: multiLine(raw.nextStep, 600),
    decisions: evidence(raw.decisions), actionItems: evidence(raw.actionItems), openQuestions: evidence(raw.openQuestions),
    constraints: evidence(raw.constraints),
  };
  for (const paragraph of Array.isArray(raw.overview) ? raw.overview : []) {
    const clean = multiLine(paragraph, 2400);
    if (clean) analysis.overview.push(clean);
    if (analysis.overview.length >= 4) break;
  }
  for (const point of Array.isArray(raw.keyPoints) ? raw.keyPoints : []) {
    const text = isObject(point) ? multiLine(point.text, 1200) : '';
    if (text) analysis.keyPoints.push({ text, refs: refs(point.refs) });
    if (analysis.keyPoints.length >= 20) break;
  }
  for (const artifact of Array.isArray(raw.artifacts) ? raw.artifacts : []) {
    const label = isObject(artifact) ? oneLine(artifact.label, 200) : '';
    if (label) analysis.artifacts.push({ label, kind: oneLine(artifact.kind, 40), description: multiLine(artifact.description, 800), ref: refOrNull(artifact.ref) });
    if (analysis.artifacts.length >= 20) break;
  }
  if (isObject(raw.whereYouLeftOff) && multiLine(raw.whereYouLeftOff.text, 1600)) {
    analysis.whereYouLeftOff = { text: multiLine(raw.whereYouLeftOff.text, 1600), refs: refs(raw.whereYouLeftOff.refs) };
  }
  return analysis;
}

const CUT_NOTE = more => `\n\n[… cut: ${more} more characters]`;
/** Transcript messages: role allowlist, 0-based unique indexes in order, content capped (with a cut note), ≤ 4000. */
export function sanitizeMessages(value, { maxChars = LIMITS.transcriptChars } = {}) {
  const out = [], seen = new Set();
  let total = 0;
  for (const message of Array.isArray(value) ? value : []) {
    if (!isObject(message) || !ROLES.includes(message.role) || typeof message.content !== 'string') continue;
    const index = clampInt(message.index, -1, 1e6, -1);
    if (index < 0 || seen.has(index)) continue;
    let content = message.content.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    if (content.length > LIMITS.messageChars) content = content.slice(0, LIMITS.messageChars) + CUT_NOTE(content.length - LIMITS.messageChars);
    if (total + content.length > maxChars) break;
    total += content.length;
    seen.add(index);
    out.push({ index, role: message.role, content, createdAt: isoOrNull(message.createdAt) });
    if (out.length >= LIMITS.messages) break;
  }
  return out.sort((a, b) => a.index - b.index);
}

function sanitizeTranscript(raw, revision) {
  if (!isObject(raw) || raw.included !== true) return { included: false, revision: clampInt(raw?.revision, 0, 1e12, revision), truncated: false, totalMessages: clampInt(raw?.totalMessages, 0, 1e6, 0), from: 0, messages: [] };
  const messages = sanitizeMessages(raw.messages);
  const totalMessages = Math.max(clampInt(raw.totalMessages, 0, 1e6, 0), messages.length ? messages[messages.length - 1].index + 1 : 0);
  return { included: true, revision: clampInt(raw.revision, 0, 1e12, revision), truncated: bool(raw.truncated) || !isContiguous(messages, totalMessages),
    totalMessages, from: clampInt(raw.from, 0, 1e6, messages[0]?.index ?? 0), messages };
}
/** True when the messages are exactly indexes 0..total-1. */
export const isContiguous = (messages, total) => messages.length === total && messages.every((message, index) => message.index === index);

/** A ThreadPayload from Threadkeeper (push or threads.get), coerced and capped. Throws without a usable threadKey. */
export function sanitizeThreadPayload(raw) {
  const summary = sanitizeThreadSummary(raw);
  delete summary.score; delete summary.match; delete summary.matchReasons; delete summary.excerpt;
  const revision = clampInt(raw.revision, 0, 1e12, 0);
  return {
    ...summary,
    seq: clampInt(raw.seq, 0, Number.MAX_SAFE_INTEGER, 0), revision,
    contentHash: oneLine(raw.contentHash, 128), fingerprint: oneLine(raw.fingerprint, 128),
    coverage: oneOf(raw.coverage, COVERAGES, 'full'), projectSource: oneLine(raw.projectSource, 40),
    tags: stringList(raw.tags, 30, 60), pinned: bool(raw.pinned), gitBranch: oneLine(raw.gitBranch, 160),
    resumeCommand: safeResumeCommand(raw.resumeCommand),
    analysis: sanitizeAnalysis(raw.analysis),
    transcript: sanitizeTranscript(raw.transcript, revision),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Request fields Still sends (pages ask through the worker) and responses Threadkeeper sends back.
/** filters for search/list/context/facets. */
export function sanitizeFilters(raw) {
  if (!isObject(raw)) return {};
  const filters = {};
  const providers = idList(raw.providers, 50, value => !!providerId(value));
  const categories = idList(raw.categories, 6, value => CATEGORIES.includes(value));
  const kinds = stringList(raw.kinds, 20, 40);
  const projects = stringList(raw.projects, 50, 200);
  const states = idList(raw.states, 6, value => WORKFLOW_STATES.includes(value));
  const threadKeys = idList(raw.threadKeys, 200, isThreadKey);
  const hashes = idList(raw.hashes, 200, isThreadHash);
  for (const [key, value] of Object.entries({ providers, categories, kinds, projects, states, threadKeys, hashes })) if (value.length) filters[key] = value;
  for (const key of ['since', 'until']) { const date = isoOrNull(raw[key]); if (date) filters[key] = date; }
  return filters;
}

/** The fields of a page request for `type`, validated (throws ThreadkeeperError bad_request). */
export function sanitizeRequestFields(type, raw = {}) {
  const fields = isObject(raw) ? raw : {};
  const semantic = value => oneOf(value, ['local', 'auto'], 'local');
  const rerank = value => oneOf(value, ['auto', 'on', 'off'], 'off');
  switch (type) {
    case 'threads.search': {
      const out = { query: multiLine(fields.query, LIMITS.query), filters: sanitizeFilters(fields.filters),
        limit: clampInt(fields.limit, 1, LIMITS.searchLimit, 20), semantic: semantic(fields.semantic), rerank: rerank(fields.rerank),
        excerpts: fields.excerpts !== false };
      if (typeof fields.cursor === 'string' && fields.cursor) out.cursor = fields.cursor.slice(0, LIMITS.cursor);
      if (fields.deadlineMs !== undefined) out.deadlineMs = clampInt(fields.deadlineMs, 500, LIMITS.searchDeadline, 8000);
      return out;
    }
    case 'threads.list': {
      const out = { filters: sanitizeFilters(fields.filters), sort: oneOf(fields.sort, ['recent', 'oldest', 'title'], 'recent'),
        limit: clampInt(fields.limit, 1, LIMITS.listLimit, 50) };
      if (typeof fields.cursor === 'string' && fields.cursor) out.cursor = fields.cursor.slice(0, LIMITS.cursor);
      return out;
    }
    case 'threads.get': {
      const out = { transcript: oneOf(fields.transcript, ['none', 'full', 'window'], 'none'), track: bool(fields.track) };
      const threadKeys = idList(fields.threadKeys, LIMITS.getKeys, isThreadKey);
      const citeIds = idList(fields.citeIds, LIMITS.getKeys, isCiteId);
      const hashes = idList(fields.hashes, LIMITS.getKeys, isThreadHash);
      if (threadKeys.length) out.threadKeys = threadKeys;
      if (citeIds.length) out.citeIds = citeIds;
      if (hashes.length) out.hashes = hashes;
      if (!threadKeys.length && !citeIds.length && !hashes.length) throw new ThreadkeeperError('bad_request', 'Choose at least one thread.');
      if (out.transcript === 'window') {
        const window = isObject(fields.window) ? fields.window : {};
        out.window = { from: clampInt(window.from, 0, 1e6, 0), count: clampInt(window.count, 1, LIMITS.windowCount, 200) };
      }
      return out;
    }
    case 'threads.context': {
      const question = multiLine(fields.question, LIMITS.query);
      if (!question) throw new ThreadkeeperError('bad_request', 'Ask a question first.');
      return { question, filters: sanitizeFilters(fields.filters), limit: clampInt(fields.limit, 1, LIMITS.contextLimit, 5),
        budgetChars: clampInt(fields.budgetChars, 500, LIMITS.contextBudget, 12000), semantic: semantic(fields.semantic),
        rerank: rerank(fields.rerank), deadlineMs: clampInt(fields.deadlineMs, 300, LIMITS.contextDeadline, 2500) };
    }
    case 'threads.related': {
      if (!isThreadKey(fields.threadKey)) throw new ThreadkeeperError('bad_request', 'Choose a thread.');
      return { threadKey: fields.threadKey, limit: clampInt(fields.limit, 1, LIMITS.relatedLimit, 8) };
    }
    case 'thread.open': {
      if (!isThreadKey(fields.threadKey)) throw new ThreadkeeperError('bad_request', 'Choose a thread.');
      return { threadKey: fields.threadKey };
    }
    case 'threads.analyze': {
      const threadKeys = idList(fields.threadKeys, LIMITS.analyzeKeys, isThreadKey);
      if (!threadKeys.length) throw new ThreadkeeperError('bad_request', 'Choose at least one thread.');
      return { threadKeys };
    }
    case 'threads.untrack': return { hashes: idList(fields.hashes, LIMITS.untrackHashes, isThreadHash) };
    case 'facets': case 'sync.status': return {};
    default: throw new ThreadkeeperError('unsupported', 'Still cannot ask Threadkeeper for that.');
  }
}

/** The send timeout for a request (protocol "Envelope"). */
export function timeoutFor(type, fields = {}) {
  if (type === 'threads.search') return TIMEOUTS.search;
  if (type === 'threads.context') return clampInt(fields.deadlineMs, 300, LIMITS.contextDeadline, 2500) + 1000;
  if (type === 'threads.get' && fields.transcript && fields.transcript !== 'none') return TIMEOUTS.transcript;
  return TIMEOUTS.default;
}

const summaries = (value, max) => {
  const out = [];
  for (const entry of Array.isArray(value) ? value : []) {
    try { out.push(sanitizeThreadSummary(entry)); } catch { /* A malformed row is dropped; the rest still count. */ }
    if (out.length >= max) break;
  }
  return out;
};
const tkInfo = value => ({ version: oneLine(isObject(value) ? value.version : '', 40),
  capabilities: idList(isObject(value) ? value.capabilities : [], CAPABILITIES.length, cap => CAPABILITIES.includes(cap)) });
const counted = (value, max, map) => (Array.isArray(value) ? value : []).filter(isObject).map(map).filter(Boolean).slice(0, max);

/**
 * Response data from Threadkeeper for a request of `type`, validated and capped (malformed list entries are dropped).
 * `fields` are the request fields (budgets and limits the answer must respect).
 */
export function sanitizeResponse(type, raw, fields = {}) {
  const data = isObject(raw) ? raw : {};
  switch (type) {
    case 'hello': {
      const out = { app: oneLine(data.app, 40), version: oneLine(data.version, 40), paired: bool(data.paired) };
      if (data.tk !== undefined) out.tk = tkInfo(data.tk);
      return out;
    }
    case 'pair.request': {
      const out = { status: oneOf(data.status, ['pending', 'paired'], 'pending') };
      if (data.tk !== undefined) out.tk = tkInfo(data.tk);
      return out;
    }
    case 'sync.configure': return { queued: clampInt(data.queued, 0, 1e7, 0), total: clampInt(data.total, 0, 1e7, 0) };
    case 'sync.resync': return { queued: clampInt(data.queued, 0, 1e7, 0) };
    case 'sync.status': return { queued: clampInt(data.queued, 0, 1e7, 0), tracked: clampInt(data.tracked, 0, 1e7, 0),
      lastPushAt: isoOrNull(data.lastPushAt), lastError: oneLine(data.lastError, 300) };
    case 'threads.search': case 'threads.list': {
      const max = type === 'threads.search' ? LIMITS.searchLimit : LIMITS.listLimit;
      const results = summaries(data.results, Math.min(max, clampInt(fields.limit, 1, max, max)));
      const out = { results, total: clampInt(data.total, 0, 1e7, results.length),
        nextCursor: typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor.slice(0, LIMITS.cursor) : null };
      if (type === 'threads.search') { out.semantic = bool(data.semantic); out.reranked = bool(data.reranked); }
      return out;
    }
    case 'threads.get': {
      const threads = [];
      for (const entry of Array.isArray(data.threads) ? data.threads : []) {
        try { threads.push(sanitizeThreadPayload(entry)); } catch { /* dropped */ }
        if (threads.length >= LIMITS.getKeys) break;
      }
      const keyish = value => typeof value === 'string' && value.length <= LIMITS.threadKey;
      return { threads, missing: idList(data.missing, 60, keyish), deferred: idList(data.deferred, 60, keyish) };
    }
    case 'threads.context': {
      const budget = clampInt(fields.budgetChars, 500, LIMITS.contextBudget, 12000);
      const limit = clampInt(fields.limit, 1, LIMITS.contextLimit, LIMITS.contextLimit);
      let left = budget;
      const threads = [];
      for (const entry of Array.isArray(data.threads) ? data.threads : []) {
        if (!isObject(entry)) continue;
        let thread;
        try { thread = sanitizeThreadSummary(entry.thread); } catch { continue; }
        const passages = [];
        for (const passage of Array.isArray(entry.passages) ? entry.passages : []) {
          if (!isObject(passage) || !['user', 'assistant'].includes(passage.role)) continue;
          const text = multiLine(passage.text, left);
          if (!text) continue;
          left -= text.length;
          passages.push({ messageIndex: refOrNull(passage.messageIndex), role: passage.role, text });
          if (left <= 0) break;
        }
        threads.push({ thread, passages });
        if (threads.length >= limit) break;
      }
      return { threads, semantic: bool(data.semantic), reranked: bool(data.reranked) };
    }
    case 'threads.related': return { results: summaries(data.results, LIMITS.relatedLimit) };
    case 'threads.untrack': return { untracked: clampInt(data.untracked, 0, 1e6, 0) };
    case 'threads.analyze': return {
      queued: clampInt(data.queued, 0, 1e6, 0),
      skipped: counted(data.skipped, LIMITS.analyzeKeys, entry => (isThreadKey(entry.threadKey)
        ? { threadKey: entry.threadKey, reason: oneOf(entry.reason, ['no_ai', 'local_only', 'fresh', 'limit'], 'limit') } : null)),
      estimateUsd: Number.isFinite(data.estimateUsd) ? Math.max(0, Math.min(1e4, data.estimateUsd)) : 0,
    };
    case 'facets': return {
      total: clampInt(data.total, 0, 1e7, 0),
      providers: counted(data.providers, 300, entry => (providerId(entry.id) ? { id: entry.id, label: oneLine(entry.label, 80) || entry.id,
        category: oneOf(entry.category, CATEGORIES, 'chat'), count: clampInt(entry.count, 0, 1e7, 0) } : null)),
      projects: counted(data.projects, 1000, entry => (oneLine(entry.name, 200) ? { name: oneLine(entry.name, 200), count: clampInt(entry.count, 0, 1e7, 0) } : null)),
      kinds: counted(data.kinds, 100, entry => (oneLine(entry.id, 40) ? { id: oneLine(entry.id, 40), label: oneLine(entry.label, 60) || oneLine(entry.id, 40),
        count: clampInt(entry.count, 0, 1e7, 0) } : null)),
      states: counted(data.states, WORKFLOW_STATES.length, entry => (WORKFLOW_STATES.includes(entry.id) ? { id: entry.id, count: clampInt(entry.count, 0, 1e7, 0) } : null)),
    };
    default: return {};
  }
}
