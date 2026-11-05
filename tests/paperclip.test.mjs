import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAPERCLIP_ACCOUNT_ID, DEFAULT_PAPERCLIP_URL, LOCAL_TOKEN, PaperclipError, normalizePaperclipUrl, createPaperclipClient, checkPaperclip, classifyError, redact,
  issueUrl, normalizeIssue, issueToMarkdown, itemToIssue, createIssueBody, getPaperclipConnection, paperclipClientFromAccount, feedKey, ISSUE_DESCRIPTION_MAX,
} from '../extension/lib/paperclip.js';
import { getMcpSetup } from '../extension/lib/integrations.js';

const KEY = 'pcp_board_secret_key_1234567890';

/** A reply with a status (plain route values answer 200). */
const reply = (status, body) => ({ reply: true, status, body });
/** A fetch that records requests and answers from a route table: { 'GET /api/companies': body | reply(status, body) | (req) => reply(...) | Error }. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    const call = { url, path: pathname, search, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined, init };
    calls.push(call);
    const route = routes[`${call.method} ${pathname}`];
    if (route === undefined) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    if (route instanceof Error) throw route;
    const answer = typeof route === 'function' ? route(call) : route;
    const { status, body } = answer?.reply ? answer : { status: 200, body: answer };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

test('normalizePaperclipUrl keeps only the origin and explains bad input calmly', () => {
  assert.equal(normalizePaperclipUrl('http://localhost:3100'), 'http://localhost:3100');
  assert.equal(normalizePaperclipUrl(' http://localhost:3100/api/ '), 'http://localhost:3100');
  assert.equal(normalizePaperclipUrl('localhost:3100'), 'http://localhost:3100');
  assert.equal(normalizePaperclipUrl('https://paperclip.example.com///'), 'https://paperclip.example.com');
  assert.equal(normalizePaperclipUrl('paperclip.tailnet.ts.net'), 'https://paperclip.tailnet.ts.net');
  assert.throws(() => normalizePaperclipUrl(''), /Enter the address/);
  assert.throws(() => normalizePaperclipUrl('ftp://host'), /http/);
  assert.throws(() => normalizePaperclipUrl('http://user:pw@localhost:3100'), /user name and password/);
  assert.throws(() => normalizePaperclipUrl('http://localhost:3100/?token=x'), /without \? or #/);
  assert.throws(() => normalizePaperclipUrl('http://localhost:3100/PAP/issues'), /without a page path/);
  assert.throws(() => normalizePaperclipUrl('http://exa mple'), /web address/);
});

test('the client builds REST URLs, sends the key only when there is one and never sends cookies', async () => {
  const { fetch, calls } = fakeFetch({
    'GET /api/companies': [{ id: 'c1', name: 'Acme', issuePrefix: 'PAP' }],
    'GET /api/companies/c1/issues': [{ id: 'i1', identifier: 'PAP-1', title: 'One', status: 'todo', priority: 'high', companyId: 'c1', updatedAt: '2026-01-02T00:00:00Z' }],
    'GET /api/issues/i1/comments': { items: [{ id: 'm1', body: 'Looks good', authorAgentId: 'a1', createdAt: '2026-01-03T00:00:00Z' }] },
    'GET /api/issues/i1/documents': [{ key: 'plan', title: 'Plan', body: 'Step one' }],
    'GET /api/issues/i1/documents/plan': { key: 'plan', title: 'Plan', body: 'Step one' },
    'GET /api/companies/c1/projects': [{ id: 'p1', name: 'Site' }],
    'GET /api/companies/c1/agents': [{ id: 'a1', name: 'CEO', title: 'Chief', companyId: 'c1' }],
    'GET /api/companies/c1/goals': [{ id: 'g1', title: 'Grow' }],
    'POST /api/companies/c1/issues': call => reply(201, { id: 'i2', identifier: 'PAP-2', ...call.body }),
    'POST /api/issues/i1/comments': call => reply(201, { id: 'm2', body: call.body.body }),
  });
  const local = createPaperclipClient({ baseUrl: 'http://localhost:3100/api', fetch });
  assert.equal(local.baseUrl, 'http://localhost:3100');
  assert.deepEqual(await local.companies(), [{ id: 'c1', name: 'Acme', prefix: 'PAP' }]);
  assert.equal(calls[0].url, 'http://localhost:3100/api/companies');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.cache, 'no-store');

  const keyed = createPaperclipClient({ baseUrl: DEFAULT_PAPERCLIP_URL, token: KEY, fetch });
  const issues = await keyed.issues('c1', { status: 'todo,in_progress', assigneeAgentId: 'a1', projectId: 'p1', q: '', limit: 500 });
  const last = calls.at(-1);
  assert.equal(last.headers.Authorization, `Bearer ${KEY}`);
  const params = new URLSearchParams(last.search);
  assert.equal(params.get('status'), 'todo,in_progress');
  assert.equal(params.get('assigneeAgentId'), 'a1');
  assert.equal(params.get('projectId'), 'p1');
  assert.equal(params.get('limit'), '100', 'limit is capped');
  assert.equal(params.get('offset'), '0');
  assert.equal(params.has('q'), false, 'empty filters are left out');
  assert.equal(issues[0].identifier, 'PAP-1');

  assert.equal((await keyed.comments('i1'))[0].body, 'Looks good', 'wrapped { items } lists work too');
  assert.equal(new URLSearchParams(calls.at(-1).search).get('limit'), '30');
  assert.equal((await keyed.documents('i1'))[0].key, 'plan');
  assert.equal((await keyed.document('i1', 'plan')).body, 'Step one');
  assert.equal((await keyed.projects('c1'))[0].name, 'Site');
  assert.equal((await keyed.agents('c1'))[0].title, 'Chief');
  assert.equal((await keyed.goals('c1'))[0].name, 'Grow');

  const created = await keyed.createIssue('c1', { title: '  Read this  ', description: 'Body', priority: 'urgent', status: 'weird', assigneeAgentId: 'a1', idempotencyKey: 'still:item:x' });
  assert.deepEqual(calls.at(-1).body, { title: 'Read this', status: 'todo', description: 'Body', assigneeAgentId: 'a1', idempotencyKey: 'still:item:x' });
  assert.equal(calls.at(-1).headers['Content-Type'], 'application/json');
  assert.equal(created.identifier, 'PAP-2');
  assert.equal((await keyed.addComment('i1', ' Thanks ')).body, 'Thanks');
  await assert.rejects(keyed.addComment('i1', '  '), /Write a comment/);
  await assert.rejects(keyed.issues(''), /Choose a Paperclip company/);

  // The stored placeholder for local trusted mode is never sent as a key.
  createPaperclipClient({ baseUrl: DEFAULT_PAPERCLIP_URL, token: LOCAL_TOKEN, fetch }).companies();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.at(-1).headers.Authorization, undefined);
});

test('errors are classified, calm and never contain the key', async () => {
  const cases = [[401, 'auth'], [403, 'forbidden'], [404, 'not_found'], [429, 'rate'], [422, 'invalid'], [409, 'invalid'], [500, 'server'], [503, 'server']];
  for (const [status, kind] of cases) {
    const { fetch } = fakeFetch({ 'GET /api/companies': reply(status, { error: `bad key ${KEY} here` }) });
    const error = await createPaperclipClient({ baseUrl: DEFAULT_PAPERCLIP_URL, token: KEY, fetch }).companies().catch(e => e);
    assert.ok(error instanceof PaperclipError, `${status}`);
    assert.equal(error.kind, kind);
    assert.equal(error.status, status);
    assert.ok(!error.message.includes(KEY), `${status} message is redacted`);
    assert.ok(!error.message.includes('pcp_board'), `${status} message hides key-like text`);
  }
  const network = await createPaperclipClient({ baseUrl: DEFAULT_PAPERCLIP_URL, token: KEY, fetch: fakeFetch({ 'GET /api/companies': new TypeError('Failed to fetch') }).fetch }).companies().catch(e => e);
  assert.equal(network.kind, 'network');
  assert.match(network.message, /could not reach Paperclip at http:\/\/localhost:3100/);
  const slow = createPaperclipClient({ baseUrl: DEFAULT_PAPERCLIP_URL, timeoutMs: 5, fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  assert.equal((await slow.companies().catch(e => e)).kind, 'timeout');
  const html = await createPaperclipClient({ baseUrl: DEFAULT_PAPERCLIP_URL, fetch: fakeFetch({ 'GET /api/companies': reply(200, '<html>') }).fetch }).companies().catch(e => e);
  assert.match(html.message, /could not read/);
  assert.match(classifyError(422, { error: 'Invalid status transition' }).message, /Paperclip said: Invalid status transition\./);
  assert.equal(redact(`Bearer ${KEY} and ${KEY}`, KEY), 'Bearer [key] and [key]');
  assert.equal(redact('token pcp_agent_abcdef123456'), 'token [key]');
  assert.throws(() => createPaperclipClient({ baseUrl: 'ftp://x', fetch: () => {} }), PaperclipError);
});

test('checkPaperclip tells local, board and agent connections apart', async () => {
  const board = fakeFetch({ 'GET /api/agents/me': reply(401, { error: 'Agent authentication required' }), 'GET /api/companies': [{ id: 'c1', name: 'Acme', issuePrefix: 'PAP' }, { id: 'c2', name: 'Beta' }] });
  const boardResult = await checkPaperclip(createPaperclipClient({ baseUrl: DEFAULT_PAPERCLIP_URL, token: KEY, fetch: board.fetch }));
  assert.equal(boardResult.mode, 'authenticated');
  assert.equal(boardResult.companies.length, 2);
  assert.equal(boardResult.agent, null);

  const agent = fakeFetch({ 'GET /api/agents/me': { id: 'a1', name: 'Researcher', companyId: 'c9' } });
  const agentResult = await checkPaperclip(createPaperclipClient({ baseUrl: DEFAULT_PAPERCLIP_URL, token: KEY, fetch: agent.fetch }));
  assert.deepEqual(agentResult.companies, [{ id: 'c9', name: '', prefix: '' }]);
  assert.equal(agentResult.agent.id, 'a1');

  const local = fakeFetch({ 'GET /api/companies': [{ id: 'c1', name: 'Acme', issuePrefix: 'PAP' }] });
  const localResult = await checkPaperclip(createPaperclipClient({ baseUrl: DEFAULT_PAPERCLIP_URL, fetch: local.fetch }));
  assert.equal(localResult.mode, 'local_trusted');
  assert.equal(local.calls.length, 1, 'no agents/me call without a key');

  const rejected = fakeFetch({ 'GET /api/agents/me': reply(401, {}), 'GET /api/companies': reply(401, {}) });
  assert.equal((await checkPaperclip(createPaperclipClient({ baseUrl: DEFAULT_PAPERCLIP_URL, token: KEY, fetch: rejected.fetch })).catch(e => e)).kind, 'auth');
});

test('issue normalizer, URLs and feed keys', () => {
  const issue = normalizeIssue({ id: 'i1', identifier: 'PAP-12', title: 'Ship', status: 'in_review', priority: 'critical', project: { id: 'p1' }, assigneeAgentId: null, extra: 'x' });
  assert.deepEqual(Object.keys(issue), ['id', 'identifier', 'title', 'status', 'priority', 'assigneeAgentId', 'assigneeUserId', 'projectId', 'goalId', 'companyId', 'description', 'updatedAt', 'createdAt']);
  assert.equal(issue.projectId, 'p1');
  assert.equal(issue.assigneeAgentId, '');
  assert.equal(normalizeIssue(null), null);
  assert.equal(normalizeIssue({ title: 'no id' }), null);
  assert.equal(issueUrl('http://localhost:3100/', issue, 'PAP'), 'http://localhost:3100/PAP/issues/PAP-12');
  assert.equal(issueUrl('http://localhost:3100', issue), 'http://localhost:3100/issues/PAP-12');
  assert.equal(issueUrl('http://localhost:3100', { id: 'uuid-1' }, 'PAP'), 'http://localhost:3100/issues/uuid-1');
  assert.equal(issueUrl('not a url', issue), '');
  assert.equal(feedKey({ baseUrl: 'http://localhost:3100', companyId: 'c1', view: 'open' }), 'paperclip:http://localhost:3100:c1:open:all');
});

test('issueToMarkdown includes status, link, description, documents and comments', () => {
  const md = issueToMarkdown({ id: 'i1', identifier: 'PAP-12', title: 'Ship it', status: 'in_progress', priority: 'high', description: 'Do the thing', updatedAt: '2026-02-03T04:05:06Z' },
    { url: 'http://localhost:3100/PAP/issues/PAP-12', documents: [{ key: 'plan', title: 'Plan', body: '1. Build' }, { key: 'empty', body: ' ' }],
      comments: [{ body: 'On it', authorAgentId: 'a1', createdAt: '2026-02-03T00:00:00Z' }, { body: 'Thanks', authorUserId: 'u1' }] });
  assert.match(md, /^# PAP-12 · Ship it\n/);
  assert.match(md, /Status: In progress · Priority: High · Updated: 2026-02-03/);
  assert.match(md, /\[Open in Paperclip\]\(http:\/\/localhost:3100\/PAP\/issues\/PAP-12\)/);
  assert.match(md, /## Description\n\nDo the thing/);
  assert.match(md, /## Plan\n\n1\. Build/);
  assert.ok(!md.includes('## empty'));
  assert.match(md, /\*\*Agent · 2026-02-03\*\*\n\nOn it/);
  assert.match(md, /\*\*Board\*\*\n\nThanks/);
  assert.equal(issueToMarkdown({}), '# Paperclip task\n');
});

test('itemToIssue builds a capped description with the source, note and up to 20 highlights', () => {
  const item = { id: 'item_1', type: 'article', title: '  A   long\ntitle ', url: 'https://example.com/a', excerpt: 'Summary text', content: 'My own note',
    highlights: Array.from({ length: 25 }, (_, i) => ({ text: `Highlight ${i + 1}` })) };
  const issue = itemToIssue(item, { extraNote: 'Please review' });
  assert.equal(issue.title, 'A long title');
  assert.equal(issue.idempotencyKey, 'still:item:item_1');
  assert.ok(issue.description.startsWith('Please review\n\nSource: https://example.com/a\n\n> Summary text'));
  assert.match(issue.description, /## Note\n\nMy own note/);
  assert.match(issue.description, /> Highlight 20/);
  assert.ok(!issue.description.includes('Highlight 21'));
  assert.ok(issue.description.endsWith('Saved in Still (item item_1)'));

  const huge = itemToIssue({ id: 'big', title: 'Big', content: 'x'.repeat(9000), excerpt: 'y'.repeat(5000), highlights: Array.from({ length: 20 }, () => ({ text: 'z'.repeat(2000) })) });
  assert.ok(huge.description.length <= ISSUE_DESCRIPTION_MAX);
  assert.ok(huge.description.endsWith('Saved in Still (item big)'));
  assert.equal(itemToIssue({ id: 'n', url: 'https://x.dev' }).title, 'https://x.dev');
  assert.equal(itemToIssue(null).title, 'Saved item');
});

test('createIssueBody keeps known fields and needs a title or description', () => {
  assert.deepEqual(createIssueBody({ title: 'T', status: 'backlog', priority: 'low', projectId: 'p', goalId: 'g' }), { title: 'T', status: 'backlog', priority: 'low', projectId: 'p', goalId: 'g' });
  assert.equal(createIssueBody({ description: 'First line\nmore' }).title, 'First line');
  assert.throws(() => createIssueBody({ title: ' ' }), /Give the task a title/);
});

test('getPaperclipConnection reads the stored account and hides the local placeholder', async () => {
  const accounts = {};
  const getAccount = async id => accounts[id] || null;
  assert.equal(await getPaperclipConnection({ getAccount }), null);
  accounts[PAPERCLIP_ACCOUNT_ID] = { token: LOCAL_TOKEN, method: 'local', meta: { baseUrl: 'http://localhost:3100', companyId: 'c1', companyPrefix: 'PAP', companyName: 'Acme', mode: 'local_trusted' } };
  assert.deepEqual(await getPaperclipConnection({ getAccount }), { baseUrl: 'http://localhost:3100', token: '', companyId: 'c1', companyPrefix: 'PAP', companyName: 'Acme', mode: 'local_trusted', agentId: '' });
  accounts[PAPERCLIP_ACCOUNT_ID] = { token: KEY, method: 'token', meta: { baseUrl: 'https://pc.example.com', companyId: 'c2', agentId: 'a1', mode: 'authenticated' } };
  const keyed = await getPaperclipConnection({ getAccount });
  assert.equal(keyed.token, KEY);
  assert.equal(keyed.agentId, 'a1');
  accounts[PAPERCLIP_ACCOUNT_ID] = { token: KEY, meta: { baseUrl: 'ftp://bad' } };
  assert.equal(await getPaperclipConnection({ getAccount }), null);

  accounts[PAPERCLIP_ACCOUNT_ID] = { token: KEY, method: 'token', meta: { baseUrl: 'http://localhost:3100', companyId: 'c1' } };
  const { fetch, calls } = fakeFetch({ 'GET /api/companies': [] });
  const client = await paperclipClientFromAccount({ getAccount, fetch });
  await client.companies();
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  delete accounts[PAPERCLIP_ACCOUNT_ID];
  assert.equal(await paperclipClientFromAccount({ getAccount }), null);
});

test('MCP setup adds HTTP, Paperclip and newer client snippets without any token', () => {
  const setup = getMcpSetup('/home/me/sidebar-dock', { nodePath: '/usr/bin/node', bridgeUrl: 'http://127.0.0.1:43123/' });
  assert.equal(setup.httpUrl, 'http://127.0.0.1:43123/mcp');
  assert.equal(setup.claudeHttpCommand, 'claude mcp add --transport http --scope user still http://127.0.0.1:43123/mcp --header "Authorization: Bearer <pairing token>"');
  assert.deepEqual(JSON.parse(setup.claudeHeadersHelper).mcpServers.still, { type: 'http', url: 'http://127.0.0.1:43123/mcp', headersHelper: '"/usr/bin/node" "/home/me/sidebar-dock/bridge/auth-header.mjs"' });
  assert.deepEqual(JSON.parse(setup.paperclip).mcpServers.still, { type: 'http', url: 'http://127.0.0.1:43123/mcp', headers: { Authorization: 'Bearer <run npm run connect -- paperclip>' } });
  assert.deepEqual(JSON.parse(setup.copilot).mcpServers.still, { type: 'local', command: '/usr/bin/node', args: ['/home/me/sidebar-dock/bridge/mcp.mjs'], tools: ['*'] });
  for (const key of ['kiro', 'factory', 'windsurf']) assert.equal(JSON.parse(setup[key]).mcpServers.still.args[0], '/home/me/sidebar-dock/bridge/mcp.mjs', key);
  assert.ok(JSON.parse(setup.zed).context_servers.still);
  assert.match(setup.goose, /^extensions:\n  still:\n    name: still\n    type: stdio\n    cmd: "\/usr\/bin\/node"/);
  assert.equal(getMcpSetup().httpUrl, 'http://127.0.0.1:43123/mcp', 'the default bridge address without a paired one');
  assert.equal(getMcpSetup('', { bridgeUrl: 'javascript:alert(1)' }).httpUrl, 'http://127.0.0.1:43123/mcp');
});

// The widget's session and render run in Node against an in-memory localStorage (accounts) and the in-memory widget cache.
async function paperclipWidget() {
  if (!globalThis.localStorage) {
    const store = new Map();
    globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  }
  const sessionModule = await import('../extension/ui/widgets/paperclip/session.js');
  await import('../extension/ui/widgets/paperclip.js');
  const { getWidget } = await import('../extension/ui/dashboard/registry.js');
  const { saveAccount } = await import('../extension/lib/accounts.js');
  const { writeCache } = await import('../extension/lib/widget-cache.js');
  return { ...sessionModule, def: getWidget('paperclip'), saveAccount, writeCache };
}
const PAPERCLIP_INFO = { connected: true, method: 'local', meta: { baseUrl: 'http://localhost:3100', companyId: 'c1', companyPrefix: 'PAP' } };

test('a request still running when Paperclip is disconnected never refills the cache', async () => {
  const { session, syncFeed, feedFor, resetSession, saveAccount } = await paperclipWidget();
  session.loaded = false;
  await saveAccount(PAPERCLIP_ACCOUNT_ID, { token: LOCAL_TOKEN, method: 'local', meta: PAPERCLIP_INFO.meta });
  Object.assign(session, { loaded: true, info: PAPERCLIP_INFO, access: true, authFailed: false });
  const realFetch = globalThis.fetch;
  const pending = [];
  globalThis.fetch = () => new Promise(resolve => pending.push(resolve));
  const reply = () => new Response(JSON.stringify([{ id: 'i1', identifier: 'PAP-1', title: 'Private task', status: 'todo' }]), { status: 200 });
  const until = async () => { while (!pending.length) await new Promise(resolve => setImmediate(resolve)); return pending.shift(); };
  try {
    const config = { view: 'open' };
    const kept = syncFeed(config, { force: true });
    (await until())(reply());
    await kept;
    assert.equal(feedFor(config).value.issues[0].title, 'Private task', 'a normal refresh is cached');
    resetSession();
    const dropped = syncFeed(config, { force: true });
    const answer = await until();
    resetSession();   // disconnect while the request runs
    answer(reply());
    await dropped;
    assert.equal(feedFor(config).value, null);
  } finally {
    globalThis.fetch = realFetch;
    resetSession();
    Object.assign(session, { info: null, access: null });
  }
});

test('cached tasks say why they stopped refreshing and offer the fix', async () => {
  const { session, feedFor, def, writeCache } = await paperclipWidget();
  Object.assign(session, { loaded: true, info: PAPERCLIP_INFO, access: false, authFailed: false });
  const config = { view: 'open', projectId: '', refresh: 5 };
  writeCache(feedFor(config).key, { issues: [{ id: 'i1', identifier: 'PAP-1', title: 'Ship it', status: 'todo' }] });
  const view = () => String(def.render({ render() {} }, { id: 'w1', config }, { w: 4, h: 4, size: 'm' }));
  try {
    assert.match(view(), /Ship it/);
    assert.match(view(), /data-action="w\.paperclip\.allow-access"/, 'host access was revoked');
    session.access = true;
    session.authFailed = true;
    assert.match(view(), /data-action="w\.paperclip\.open-connect"/, 'the key was rejected');
    session.authFailed = false;
    assert.doesNotMatch(view(), /w-paperclip-notice/, 'nothing to report');
  } finally {
    session.status.clear();
    Object.assign(session, { info: null, access: null, authFailed: false });
  }
});
