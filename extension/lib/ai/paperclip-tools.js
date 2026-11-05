// Paperclip as read-only context for the library assistant: an external tool provider for createToolSession (tools.js)
// that searches and reads the connected Paperclip company's tasks (issues), goals and projects through lib/paperclip.js.
// It never creates, comments on or changes anything in Paperclip.
//
// Readiness: tool definitions are read synchronously when a turn's tool session is built, but knowing whether Paperclip is
// connected needs storage I/O. So the assistant awaits provider.ready() (alias refresh()) before each turn; it re-reads the
// connection and caches it, and definitions() returns [] until a connection is cached, so a disconnected user's model
// never sees Paperclip tools. lib/paperclip.js is imported on first use, keeping it out of the assistant's startup path.

export const PAPERCLIP_TOOL_NAMES = Object.freeze(['paperclip_search_tasks', 'paperclip_read_task', 'paperclip_list_goals', 'paperclip_list_projects']);
const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'];
const MAX_SEARCH = 25;
const MAX_COMMENTS = 20;
const MAX_DOCUMENT_BODIES = 2;
const MAX_TASK_CHARS = 30000;
const MAX_LIST = 100;
const ISSUE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9})$/i;

const text = value => typeof value === 'string' ? value : '';
const clip = (value, limit) => { const plain = text(value); return plain.length > limit ? `${plain.slice(0, limit - 1).trimEnd()}…` : plain; };
const clampInt = (value, min, max, fallback) => Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const listOf = (value, ...keys) => Array.isArray(value) ? value : keys.map(key => value?.[key]).find(Array.isArray) || [];
const loadPaperclip = () => import('../paperclip.js');

const DEFINITIONS = [
  { name: 'paperclip_search_tasks', description: 'Search the user’s Paperclip tasks (issues of the connected Paperclip company, an app that orchestrates AI agents). Read-only. Without a query, lists recent tasks. Returns identifiers such as PAP-12, titles, status, priority and links; cite a task as [[paperclip:PAP-12]].',
    inputSchema: schema({ query: { type: 'string', description: 'Words to search for in task titles and descriptions.' },
      status: { type: 'string', enum: STATUSES, description: 'Only tasks with this status.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH, description: `Maximum tasks to return (1-${MAX_SEARCH}, default 10).` } }) },
  { name: 'paperclip_read_task', description: 'Read one Paperclip task in full: description, recent comments and its documents (such as the plan). Read-only. Cite it as [[paperclip:<identifier>]].',
    inputSchema: schema({ id: { type: 'string', description: 'Task identifier such as PAP-12, or its id.' } }, ['id']) },
  { name: 'paperclip_list_goals', description: 'List the goals of the connected Paperclip company. Read-only.', inputSchema: schema({}) },
  { name: 'paperclip_list_projects', description: 'List the projects of the connected Paperclip company. Read-only.', inputSchema: schema({}) },
];

// ---- formatting fallbacks, used when lib/paperclip.js lacks a helper ----
function fallbackNormalizeIssue(raw = {}) {
  const pick = key => text(raw?.[key]);
  return { id: pick('id'), identifier: pick('identifier'), title: pick('title'), status: pick('status'), priority: pick('priority'), assigneeAgentId: pick('assigneeAgentId'),
    assigneeUserId: pick('assigneeUserId'), projectId: pick('projectId'), goalId: pick('goalId'), companyId: pick('companyId'), description: pick('description'),
    updatedAt: pick('updatedAt'), createdAt: pick('createdAt') };
}
function fallbackIssueUrl(baseUrl, issue, prefix = '') {
  const base = text(baseUrl).replace(/\/+$/, '');
  const ref = encodeURIComponent(text(issue?.identifier) || text(issue?.id));
  return prefix && issue?.identifier ? `${base}/${encodeURIComponent(prefix)}/issues/${ref}` : `${base}/issues/${ref}`;
}
function fallbackIssueToMarkdown(issue, { comments = [], documents = [], url = '' } = {}) {
  const lines = [`# ${[text(issue.identifier), text(issue.title)].filter(Boolean).join(' ')}`.trim()];
  const facts = [issue.status && `Status: ${issue.status}`, issue.priority && `Priority: ${issue.priority}`, url && `Link: ${url}`].filter(Boolean);
  if (facts.length) lines.push(facts.join(' · '));
  if (text(issue.description).trim()) lines.push(text(issue.description).trim());
  for (const doc of documents) if (text(doc?.body).trim()) lines.push(`## Document: ${text(doc.title) || text(doc.key)}\n\n${text(doc.body).trim()}`);
  if (comments.length) lines.push(`## Comments\n\n${comments.map(comment => `- ${text(comment.createdAt).slice(0, 10)}${comment.author ? ` ${comment.author}` : ''}: ${text(comment.body).trim().replace(/\n+/g, ' ')}`).join('\n')}`);
  return lines.join('\n\n');
}

// Calm, token-free sentences for PaperclipError kinds (lib/paperclip.js); anything else keeps its first line, redacted.
const KIND_MESSAGES = {
  auth: 'Paperclip did not accept the saved sign-in. Reconnect Paperclip in Settings.',
  forbidden: 'Paperclip does not allow this connection to read that.',
  not_found: 'Paperclip has no such task, or it is not in the connected company.',
  rate: 'Paperclip is busy right now. Try again in a moment.',
  network: 'Paperclip could not be reached. Check that it is running.',
  timeout: 'Paperclip took too long to answer.',
  server: 'Paperclip had a problem answering. Try again later.',
  invalid: 'Paperclip did not accept that request.',
};
function calmError(error, token) {
  let message = KIND_MESSAGES[error?.kind] || text(error?.message).split('\n')[0].slice(0, 240) || 'Paperclip could not be read.';
  if (token && token.length >= 4) message = message.split(token).join('[redacted]');
  return new Error(message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'));
}

/**
 * createPaperclipToolProvider({ getConnection, createClient, helpers }) -> { id, label, ready(), refresh(), connected(), definitions(), call(name, input, { signal }) }
 * getConnection() -> null | { baseUrl, token, companyId, companyPrefix, companyName } (default lib/paperclip.js getPaperclipConnection).
 * createClient({ baseUrl, token }) -> Paperclip client (default lib/paperclip.js createPaperclipClient).
 * helpers (optional): { normalizeIssue, issueUrl, issueToMarkdown }; by default those of lib/paperclip.js, with local fallbacks.
 */
export function createPaperclipToolProvider({ getConnection, createClient, helpers } = {}) {
  let connection = null;
  let client = null;
  let tools = null;

  async function resolveTools() {
    if (tools) return tools;
    let module = {};
    if (!helpers || !getConnection || !createClient) { try { module = await loadPaperclip(); } catch { module = {}; } }
    const pick = (name, fallback) => typeof helpers?.[name] === 'function' ? helpers[name] : typeof module[name] === 'function' ? module[name] : fallback;
    tools = { getConnection: getConnection || module.getPaperclipConnection || (async () => null), createClient: createClient || module.createPaperclipClient || null,
      normalizeIssue: pick('normalizeIssue', fallbackNormalizeIssue), issueUrl: pick('issueUrl', fallbackIssueUrl), issueToMarkdown: pick('issueToMarkdown', fallbackIssueToMarkdown) };
    return tools;
  }

  /** Re-reads the Paperclip connection; resolves true when connected. Never throws. */
  async function ready() {
    try {
      const { getConnection: read, createClient: make } = await resolveTools();
      const next = await read();
      const valid = next && text(next.baseUrl) && text(next.companyId) && typeof make === 'function';
      if (!valid) { connection = null; client = null; return false; }
      if (!connection || connection.baseUrl !== next.baseUrl || connection.token !== text(next.token)) client = make({ baseUrl: next.baseUrl, token: text(next.token) });
      connection = { baseUrl: text(next.baseUrl), token: text(next.token), companyId: text(next.companyId), companyPrefix: text(next.companyPrefix), companyName: text(next.companyName) };
      return true;
    } catch {
      connection = null;
      client = null;
      return false;
    }
  }

  const source = (issue, url) => ({ id: `paperclip:${issue.identifier || issue.id}`, title: [issue.identifier, issue.title].filter(Boolean).join(' ') || 'Paperclip task', url });

  const handlers = {
    async paperclip_search_tasks(input, h) {
      const query = clip(text(input.query).trim(), 200);
      const status = STATUSES.includes(input.status) ? input.status : undefined;
      const limit = clampInt(input.limit, 1, MAX_SEARCH, 10);
      const raw = await client.issues(connection.companyId, { ...(query ? { q: query } : {}), ...(status ? { status } : {}), limit });
      const issues = listOf(raw, 'issues', 'items', 'data').slice(0, limit).map(entry => h.normalizeIssue(entry)).filter(issue => issue.id || issue.identifier);
      const tasks = issues.map(issue => {
        const url = h.issueUrl(connection.baseUrl, issue, connection.companyPrefix);
        return { id: issue.id, identifier: issue.identifier, title: issue.title, status: issue.status, priority: issue.priority, ...(issue.assigneeAgentId ? { assigneeAgentId: issue.assigneeAgentId } : {}),
          updatedAt: issue.updatedAt, ...(issue.description ? { description: clip(issue.description, 400) } : {}), cite: `paperclip:${issue.identifier || issue.id}`, url };
      });
      return { summary: `Searched Paperclip tasks · ${tasks.length} ${tasks.length === 1 ? 'match' : 'matches'}`, data: { company: connection.companyName, query, ...(status ? { status } : {}), count: tasks.length, tasks },
        sources: tasks.map(task => source(task, task.url)) };
    },
    async paperclip_read_task(input, h) {
      const ref = text(input.id).trim();
      if (!ISSUE_ID.test(ref)) throw new Error('Give paperclip_read_task a task identifier such as PAP-12.');
      const issue = h.normalizeIssue(await client.issue(ref));
      const key = issue.id || ref;
      const quiet = promise => Promise.resolve(promise).catch(() => null);
      const [rawComments, rawDocuments] = await Promise.all([quiet(client.comments(key, { limit: MAX_COMMENTS })), quiet(client.documents(key))]);
      const comments = listOf(rawComments, 'comments', 'items', 'data').slice(-MAX_COMMENTS)
        .map(comment => ({ ...(comment && typeof comment === 'object' ? comment : {}), body: clip(comment?.body, 2000), createdAt: text(comment?.createdAt), author: text(comment?.authorName) || text(comment?.author?.name) || (comment?.authorAgentId ? 'agent' : comment?.authorUserId ? 'user' : '') }));
      const listed = listOf(rawDocuments, 'documents', 'items', 'data').filter(doc => text(doc?.key));
      // The plan first, then the most recent others; at most two bodies are fetched.
      const chosen = [...listed].sort((a, b) => (b.key === 'plan') - (a.key === 'plan') || text(b.updatedAt).localeCompare(text(a.updatedAt))).slice(0, MAX_DOCUMENT_BODIES);
      const bodies = await Promise.all(chosen.map(doc => quiet(client.document(key, doc.key)).then(full => ({ key: doc.key, title: text(full?.title) || text(doc.title), body: clip(text(full?.body) || text(doc.body), 12000) }))));
      const url = h.issueUrl(connection.baseUrl, issue, connection.companyPrefix);
      let markdown = text(h.issueToMarkdown({ ...issue, description: clip(issue.description, 12000) }, { comments, documents: bodies, url }));
      const truncated = markdown.length > MAX_TASK_CHARS;
      if (truncated) markdown = `${markdown.slice(0, MAX_TASK_CHARS - 1).trimEnd()}…`;
      return { summary: `Read Paperclip task ${issue.identifier || ref}`,
        data: { id: issue.id, identifier: issue.identifier, title: issue.title, status: issue.status, priority: issue.priority, cite: `paperclip:${issue.identifier || issue.id || ref}`, url,
          documents: listed.map(doc => ({ key: text(doc.key), title: text(doc.title) })), markdown, ...(truncated ? { truncated: true } : {}) },
        sources: [source({ ...issue, identifier: issue.identifier || (issue.id ? '' : ref) }, url)] };
    },
    async paperclip_list_goals() {
      const goals = listOf(await client.goals(connection.companyId), 'goals', 'items', 'data').slice(0, MAX_LIST)
        .map(goal => ({ id: text(goal?.id), title: clip(goal?.title || goal?.name, 300), status: text(goal?.status), level: text(goal?.level), ...(goal?.description ? { description: clip(goal.description, 600) } : {}) }));
      return { summary: `Listed Paperclip goals · ${goals.length}`, data: { company: connection.companyName, count: goals.length, goals } };
    },
    async paperclip_list_projects() {
      const projects = listOf(await client.projects(connection.companyId), 'projects', 'items', 'data').slice(0, MAX_LIST)
        .map(project => ({ id: text(project?.id), name: clip(project?.name || project?.title, 300), status: text(project?.status), ...(project?.description ? { description: clip(project.description, 600) } : {}) }));
      return { summary: `Listed Paperclip projects · ${projects.length}`, data: { company: connection.companyName, count: projects.length, projects } };
    },
  };

  async function call(name, input = {}, { signal } = {}) {
    if (!Object.hasOwn(handlers, name)) throw new Error(`Unknown Paperclip tool ${name}.`);
    if (!connection || !client) throw new Error('Paperclip is not connected. Connect it in Settings.');
    if (signal?.aborted) throw signal.reason || new DOMException('Stopped', 'AbortError');
    const h = await resolveTools();
    try {
      return await handlers[name](input && typeof input === 'object' ? input : {}, h);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw calmError(error, connection?.token);
    }
  }

  return {
    id: 'paperclip',
    label: 'Paperclip',
    ready,
    refresh: ready,
    connected: () => !!connection,
    definitions: () => connection ? DEFINITIONS.map(definition => ({ ...definition, inputSchema: structuredClone(definition.inputSchema) })) : [],
    call,
  };
}
