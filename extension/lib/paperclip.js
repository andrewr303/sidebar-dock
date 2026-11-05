// Paperclip REST client and the pure helpers behind the Paperclip widget, the "Send to Paperclip" dialog and the
// assistant's Paperclip tools: URL normalization, error classification, issue normalization and Markdown. No DOM here.
// Paperclip (https://docs.paperclip.ing) runs on this computer or a private network. In local_trusted mode it needs no
// key; otherwise a board key (pcp_board_…) or an agent key is sent as a Bearer token. A key never appears in an error
// message or a return value, and requests omit cookies so a browser session is never borrowed.
import { getAccount as defaultGetAccount } from './accounts.js';

export const PAPERCLIP_ACCOUNT_ID = 'paperclip';
export const DEFAULT_PAPERCLIP_URL = 'http://localhost:3100';
export const PAPERCLIP_DOCS = 'https://docs.paperclip.ing';
/** Stored in place of a key in local_trusted mode, because accounts.js requires a non-empty token. Never sent. */
export const LOCAL_TOKEN = 'local';

export const ISSUE_STATUSES = Object.freeze([
  { value: 'backlog', label: 'Backlog', tone: 'gray' },
  { value: 'todo', label: 'Todo', tone: 'gray' },
  { value: 'in_progress', label: 'In progress', tone: 'amber' },
  { value: 'in_review', label: 'In review', tone: 'violet' },
  { value: 'blocked', label: 'Blocked', tone: 'red' },
  { value: 'done', label: 'Done', tone: 'green' },
  { value: 'cancelled', label: 'Cancelled', tone: 'gray' },
]);
export const statusOf = value => ISSUE_STATUSES.find(entry => entry.value === value) || { value: String(value || ''), label: humanize(value) || 'Unknown', tone: 'gray' };
export const ISSUE_PRIORITIES = Object.freeze([
  { value: 'critical', label: 'Critical', rank: 1 },
  { value: 'high', label: 'High', rank: 2 },
  { value: 'medium', label: 'Medium', rank: 3 },
  { value: 'low', label: 'Low', rank: 4 },
]);
export const priorityOf = value => ISSUE_PRIORITIES.find(entry => entry.value === value) || null;
const humanize = value => String(value || '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

/** Widget views: which statuses each one asks Paperclip for. */
export const VIEWS = Object.freeze([
  { id: 'mine', label: 'Assigned to me', status: 'todo,in_progress,blocked,in_review' },
  { id: 'open', label: 'Open', status: 'todo,in_progress,blocked' },
  { id: 'review', label: 'In review', status: 'in_review' },
]);
export const viewOf = id => VIEWS.find(view => view.id === id) || VIEWS[1];

// ------------------------------------------------------------------------------------------------ URLs

/** The origin of a Paperclip address ("localhost:3100/api/" -> "http://localhost:3100"). Throws a calm Error. */
export function normalizePaperclipUrl(value) {
  let text = String(value ?? '').trim();
  if (!text) throw new Error('Enter the address where Paperclip runs, for example http://localhost:3100.');
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) text = `${/^(localhost|127\.|\[::1\])/i.test(text) ? 'http' : 'https'}://${text}`;
  let url;
  try { url = new URL(text); } catch { throw new Error('That does not look like a web address. Use one like http://localhost:3100.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Paperclip addresses start with http:// or https://.');
  if (url.username || url.password) throw new Error('Leave the user name and password out of the address. Paste a key in the API key field instead.');
  if (url.search || url.hash) throw new Error('Use only the address, without ? or # parts.');
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api$/i, '').replace(/\/+$/, '');
  if (path) throw new Error('Use only the server address, like http://localhost:3100, without a page path.');
  return url.origin;
}

/** Link to an issue in Paperclip's UI: '<base>/<PREFIX>/issues/<PAP-12>' when the company prefix is known. */
export function issueUrl(baseUrl, issue, companyPrefix = '') {
  let base;
  try { base = normalizePaperclipUrl(baseUrl); } catch { return ''; }
  const ref = issue?.identifier || issue?.id || '';
  if (!ref) return base;
  const prefix = String(companyPrefix || '').trim();
  return prefix && issue?.identifier ? `${base}/${encodeURIComponent(prefix)}/issues/${encodeURIComponent(issue.identifier)}` : `${base}/issues/${encodeURIComponent(ref)}`;
}

// ------------------------------------------------------------------------------------------------ errors

export class PaperclipError extends Error {
  constructor(message, { kind = 'server', status = 0 } = {}) {
    super(message);
    this.name = 'PaperclipError';
    this.kind = kind;     // auth | forbidden | not_found | rate | network | server | timeout | invalid
    this.status = status;
  }
}

/** Replaces the key (and anything that looks like a Paperclip key) with a placeholder. */
export function redact(text, token = '') {
  let value = String(text ?? '');
  if (token && token.length > 3) value = value.split(token).join('[key]');
  return value.replace(/\bpcp_[A-Za-z0-9_-]{6,}/g, '[key]').replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [key]');
}

/** PaperclipError for an HTTP status and the server's { error } body. Server text is shortened and redacted. */
export function classifyError(status, body, token = '') {
  const detail = redact(typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : '', token).slice(0, 200).trim();
  const tail = detail ? ` Paperclip said: ${detail.replace(/\.?$/, '.')}` : '';
  if (status === 401) return new PaperclipError('Paperclip did not accept the key. Check it, or leave it empty if Paperclip runs in local trusted mode.', { kind: 'auth', status });
  if (status === 403) return new PaperclipError(`This key is not allowed to do that in Paperclip.${tail}`, { kind: 'forbidden', status });
  if (status === 404) return new PaperclipError('Paperclip could not find that. It may have been deleted or moved.', { kind: 'not_found', status });
  if (status === 429) return new PaperclipError('Paperclip is busy. Wait a moment and try again.', { kind: 'rate', status });
  if (status === 400 || status === 409 || status === 422) return new PaperclipError(`Paperclip did not accept the request.${tail}`, { kind: 'invalid', status });
  return new PaperclipError('Paperclip had a problem answering. Try again in a moment.', { kind: 'server', status });
}

// ------------------------------------------------------------------------------------------------ client

const listOf = (value, ...keys) => {
  if (Array.isArray(value)) return value;
  for (const key of ['items', 'data', 'results', ...keys]) if (Array.isArray(value?.[key])) return value[key];
  return [];
};

/**
 * REST client for <baseUrl>/api. token '' (or LOCAL_TOKEN) sends no Authorization header (local_trusted mode).
 * Every method resolves with plain JSON shaped by the normalizers below, or rejects with a PaperclipError.
 */
export function createPaperclipClient({ baseUrl, token = '', fetch: fetcher = globalThis.fetch?.bind(globalThis), timeoutMs = 15000 } = {}) {
  let base;
  try { base = normalizePaperclipUrl(baseUrl || DEFAULT_PAPERCLIP_URL); } catch (error) { throw new PaperclipError(error.message, { kind: 'invalid' }); }
  const key = token && token !== LOCAL_TOKEN ? String(token) : '';
  if (typeof fetcher !== 'function') throw new PaperclipError('This browser cannot reach Paperclip.', { kind: 'network' });

  async function request(path, { method = 'GET', query, body } = {}) {
    const url = new URL(`${base}/api${path}`);
    for (const [name, value] of Object.entries(query || {})) if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
    const headers = { Accept: 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetcher(url.href, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', cache: 'no-store', signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw new PaperclipError('Paperclip took too long to answer. Try again.', { kind: 'timeout' });
      throw new PaperclipError(`Still could not reach Paperclip at ${base}. Check that it is running and that Still may access it.`, { kind: 'network' });
    } finally { clearTimeout(timer); }
    let data = null;
    const text = await response.text().catch(() => '');
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    if (!response.ok) throw classifyError(response.status, data, key);
    if (text && data === null) throw new PaperclipError('Paperclip answered with something Still could not read. Check the address.', { kind: 'server', status: response.status });
    return data;
  }

  const company = id => { if (!id) throw new PaperclipError('Choose a Paperclip company first.', { kind: 'invalid' }); return encodeURIComponent(id); };
  const issuePath = id => { if (!id) throw new PaperclipError('That Paperclip task has no id.', { kind: 'invalid' }); return `/issues/${encodeURIComponent(id)}`; };

  return {
    baseUrl: base,
    hasKey: !!key,
    companies: async () => listOf(await request('/companies'), 'companies').map(normalizeCompany).filter(Boolean),
    /** The identity behind the key: { kind: 'agent', agent } for agent keys, else { kind: 'board' }. */
    me: async () => {
      if (!key) return { kind: 'board', local: true };
      try { return { kind: 'agent', agent: normalizeAgent(await request('/agents/me')) }; } catch (error) {
        if (error.kind === 'auth' || error.kind === 'forbidden' || error.kind === 'not_found') {
          await request('/companies');   // board keys can list companies; a bad key rejects here
          return { kind: 'board', local: false };
        }
        throw error;
      }
    },
    agentMe: async () => normalizeAgent(await request('/agents/me')),
    issues: async (companyId, { q, status, assigneeAgentId, assigneeUserId, projectId, limit = 25, offset = 0 } = {}) => listOf(await request(`/companies/${company(companyId)}/issues`, {
      query: { q, status, assigneeAgentId, assigneeUserId, projectId, limit: Math.max(1, Math.min(100, Number(limit) || 25)), offset: Math.max(0, Number(offset) || 0) },
    }), 'issues').map(normalizeIssue).filter(Boolean),
    issue: async id => normalizeIssue(await request(issuePath(id))),
    // Paperclip returns comments newest first; callers get them oldest first so the latest are at the end.
    comments: async (id, { limit = 30 } = {}) => listOf(await request(`${issuePath(id)}/comments`, { query: { limit } }), 'comments').map(normalizeComment).filter(Boolean)
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))),
    documents: async id => listOf(await request(`${issuePath(id)}/documents`), 'documents').map(normalizeDocument).filter(Boolean),
    document: async (id, docKey) => normalizeDocument(await request(`${issuePath(id)}/documents/${encodeURIComponent(docKey)}`)),
    goals: async companyId => listOf(await request(`/companies/${company(companyId)}/goals`), 'goals').map(entry => named(entry, 'title')).filter(Boolean),
    projects: async companyId => listOf(await request(`/companies/${company(companyId)}/projects`), 'projects').map(entry => named(entry, 'name')).filter(Boolean),
    agents: async companyId => listOf(await request(`/companies/${company(companyId)}/agents`), 'agents').map(normalizeAgent).filter(Boolean),
    createIssue: async (companyId, body) => normalizeIssue(await request(`/companies/${company(companyId)}/issues`, { method: 'POST', body: createIssueBody(body) })),
    addComment: async (id, body) => {
      const text = String(typeof body === 'string' ? body : body?.body ?? '').trim();
      if (!text) throw new PaperclipError('Write a comment first.', { kind: 'invalid' });
      return normalizeComment(await request(`${issuePath(id)}/comments`, { method: 'POST', body: { body: text.slice(0, 50000) } }));
    },
  };
}

/** Checks a connection for the account card: { mode, companies, agent }. Agent keys see their own company only. */
export async function checkPaperclip(client) {
  const me = await client.me();
  if (me.kind === 'agent') {
    const agent = me.agent;
    return { mode: 'authenticated', agent, companies: agent?.companyId ? [{ id: agent.companyId, name: '', prefix: '' }] : [] };
  }
  const companies = await client.companies();
  return { mode: client.hasKey ? 'authenticated' : 'local_trusted', agent: null, companies };
}

/** Only the fields Paperclip's create-issue route takes from Still, trimmed and typed. */
export function createIssueBody({ title, description, status = 'todo', priority, assigneeAgentId, projectId, goalId, idempotencyKey } = {}) {
  const text = String(title ?? '').trim().slice(0, 500);
  const details = String(description ?? '').trim();
  if (!text && !details) throw new PaperclipError('Give the task a title.', { kind: 'invalid' });
  const body = { title: text || details.split('\n')[0].slice(0, 120), status: ISSUE_STATUSES.some(s => s.value === status) ? status : 'todo' };
  if (details) body.description = details.slice(0, 100000);
  if (priorityOf(priority)) body.priority = priority;
  if (assigneeAgentId) body.assigneeAgentId = String(assigneeAgentId);
  if (projectId) body.projectId = String(projectId);
  if (goalId) body.goalId = String(goalId);
  if (idempotencyKey) body.idempotencyKey = String(idempotencyKey).slice(0, 200);
  return body;
}

// ------------------------------------------------------------------------------------------------ normalizers

const str = value => (typeof value === 'string' ? value : value == null ? '' : String(value));
const named = (entry, field) => entry && typeof entry === 'object' && entry.id ? { id: str(entry.id), name: str(entry[field] || entry.name || entry.title), status: str(entry.status) } : null;

export function normalizeCompany(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  return { id: str(raw.id), name: str(raw.name), prefix: str(raw.issuePrefix || raw.prefix || raw.urlKey) };
}

export function normalizeAgent(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  return { id: str(raw.id), name: str(raw.name), title: str(raw.title), role: str(raw.role), status: str(raw.status), companyId: str(raw.companyId) };
}

export function normalizeIssue(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  return {
    id: str(raw.id), identifier: str(raw.identifier), title: str(raw.title), status: str(raw.status), priority: str(raw.priority),
    assigneeAgentId: str(raw.assigneeAgentId), assigneeUserId: str(raw.assigneeUserId), projectId: str(raw.projectId || raw.project?.id), goalId: str(raw.goalId || raw.goal?.id),
    companyId: str(raw.companyId), description: str(raw.description), updatedAt: str(raw.updatedAt), createdAt: str(raw.createdAt),
  };
}

export function normalizeComment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return { id: str(raw.id), body: str(raw.body), authorAgentId: str(raw.authorAgentId), authorUserId: str(raw.authorUserId), createdAt: str(raw.createdAt) };
}

export function normalizeDocument(raw) {
  if (!raw || typeof raw !== 'object' || !(raw.key || raw.id)) return null;
  return { key: str(raw.key || raw.id), title: str(raw.title), body: str(raw.body ?? raw.latestBody ?? raw.content ?? ''), updatedAt: str(raw.updatedAt) };
}

/** Newest first; ties keep Paperclip's order. */
export const sortByUpdated = (issues = []) => [...issues].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

// ------------------------------------------------------------------------------------------------ Markdown

const quote = text => String(text).trim().split('\n').map(line => `> ${line}`).join('\n');

/** An issue as a Markdown note: title, status line, description, documents and the latest comments. */
export function issueToMarkdown(issue, { comments = [], documents = [], url = '' } = {}) {
  const it = normalizeIssue(issue) || { title: '', identifier: '', status: '', priority: '', description: '', updatedAt: '' };
  const lines = [`# ${[it.identifier, it.title].filter(Boolean).join(' · ') || 'Paperclip task'}`, ''];
  const facts = [it.status && `Status: ${statusOf(it.status).label}`, priorityOf(it.priority) && `Priority: ${priorityOf(it.priority).label}`, it.updatedAt && `Updated: ${it.updatedAt.slice(0, 10)}`].filter(Boolean);
  if (facts.length) lines.push(facts.join(' · '), '');
  if (url) lines.push(`[Open in Paperclip](${url})`, '');
  if (it.description.trim()) lines.push('## Description', '', it.description.trim(), '');
  const docs = (documents || []).map(normalizeDocument).filter(doc => doc && doc.body.trim());
  for (const doc of docs.slice(0, 10)) lines.push(`## ${doc.title || doc.key}`, '', doc.body.trim().slice(0, 20000), '');
  const notes = (comments || []).map(normalizeComment).filter(c => c && c.body.trim());
  if (notes.length) {
    lines.push('## Comments', '');
    for (const comment of notes.slice(-30)) lines.push(`**${comment.authorAgentId ? 'Agent' : 'Board'}${comment.createdAt ? ` · ${comment.createdAt.slice(0, 10)}` : ''}**`, '', comment.body.trim().slice(0, 5000), '');
  }
  return `${lines.join('\n').trim()}\n`;
}

export const ISSUE_DESCRIPTION_MAX = 20000;

/** A saved Still item as a new Paperclip task: { title, description, idempotencyKey }. */
export function itemToIssue(item, { extraNote = '' } = {}) {
  const it = item && typeof item === 'object' ? item : {};
  const title = String(it.title || it.url || 'Saved item').replace(/\s+/g, ' ').trim().slice(0, 200);
  const parts = [];
  if (extraNote && String(extraNote).trim()) parts.push(String(extraNote).trim());
  if (it.url) parts.push(`Source: ${it.url}`);
  const excerpt = String(it.excerpt || '').trim();
  if (excerpt) parts.push(quote(excerpt.slice(0, 1500)));
  // `content` holds the personal note (for a note item, the note itself).
  const note = String(it.content || it.note || '').trim();
  if (note) parts.push(`## Note\n\n${note.slice(0, 8000)}`);
  const highlights = (Array.isArray(it.highlights) ? it.highlights : []).map(h => String(h?.text || '').trim()).filter(Boolean);
  if (highlights.length) parts.push(`## Highlights\n\n${highlights.slice(0, 20).map(text => quote(text.slice(0, 600))).join('\n\n')}`);
  const footer = `Saved in Still (item ${it.id || 'unknown'})`;
  let description = parts.join('\n\n');
  const room = ISSUE_DESCRIPTION_MAX - footer.length - 4;
  if (description.length > room) description = `${description.slice(0, room - 1).trimEnd()}…`;
  return { title, description: `${description ? `${description}\n\n` : ''}${footer}`, idempotencyKey: `still:item:${it.id || ''}` };
}

// ------------------------------------------------------------------------------------------------ connection

/** The stored connection, or null: { baseUrl, token ('' in local mode), companyId, companyPrefix, companyName, mode, agentId }. */
export async function getPaperclipConnection({ getAccount = defaultGetAccount } = {}) {
  const account = await getAccount(PAPERCLIP_ACCOUNT_ID);
  if (!account || typeof account !== 'object' || !account.token) return null;
  const meta = account.meta && typeof account.meta === 'object' ? account.meta : {};
  let baseUrl;
  try { baseUrl = normalizePaperclipUrl(meta.baseUrl || DEFAULT_PAPERCLIP_URL); } catch { return null; }
  const local = account.method === 'local' || account.token === LOCAL_TOKEN;
  return { baseUrl, token: local ? '' : String(account.token), companyId: str(meta.companyId), companyPrefix: str(meta.companyPrefix), companyName: str(meta.companyName),
    mode: local ? 'local_trusted' : str(meta.mode || 'authenticated'), agentId: str(meta.agentId) };
}

/** A client for the stored connection, or null when Paperclip is not connected. */
export async function paperclipClientFromAccount(opts = {}) {
  const connection = await getPaperclipConnection(opts);
  if (!connection) return null;
  return createPaperclipClient({ baseUrl: connection.baseUrl, token: connection.token, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
}

/** Widget cache key for one feed (never contains the key). */
export const feedKey = ({ baseUrl = '', companyId = '', view = 'open', projectId = '' } = {}) => `paperclip:${baseUrl}:${companyId}:${view}:${projectId || 'all'}`;
