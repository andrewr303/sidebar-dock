import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_SPEC, AGENT_SPEC_REVISION, ENVIRONMENT_SPEC, RESEARCH_MODEL, RESEARCH_SYSTEM_PROMPT, sessionAgent, specHash } from '../extension/lib/ai/research/agent-config.js';
import { createManagedClient } from '../extension/lib/ai/research/api.js';
import { CUSTOM_TOOL_NAMES } from '../extension/lib/ai/research/custom-tools.js';
import { RESEARCH_STORE_KEY, ensureProvisioned, isResearchConnection, pickResearchConnection, provisionKey, readProvisioning, resetResearchProvisioning,
  resolveResearchConnection } from '../extension/lib/ai/research/provision.js';
import { RESEARCH_DEFAULTS, budgetFor, effortFor, normalizeResearchSettings } from '../extension/lib/ai/research/settings.js';
import { KEY, fakeManagedAgents, json } from './research-fake-server.mjs';

const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return { map, get: async key => structuredClone(map.get(key)), set: async (key, value) => { map.set(key, structuredClone(value)); } };
};
const resolved = (id = 'anthropic-1', workspaceId = '') => ({ connection: { id, workspaceId }, apiKey: KEY, baseUrl: 'https://api.anthropic.com/v1', provider: null });
const clientFor = (server, target = resolved()) => createManagedClient({ apiKey: KEY, baseUrl: target.baseUrl, connection: target.connection, fetchImpl: server.fetch });
const routes = server => server.calls.map(call => `${call.method} ${call.path}`);

test('the agent spec: Sonnet 5.5, only web search and fetch (always allow), the contract custom tools, no multiagent or outcome', () => {
  assert.equal(AGENT_SPEC.name, 'Still research agent');
  assert.equal(AGENT_SPEC.model, 'claude-sonnet-5-5');
  assert.equal(RESEARCH_MODEL, 'claude-sonnet-5-5');
  assert.deepEqual(AGENT_SPEC.metadata, { app: 'still' });
  assert.ok(!('multiagent' in AGENT_SPEC));
  const [toolset, ...custom] = AGENT_SPEC.tools;
  assert.deepEqual(toolset, { type: 'agent_toolset_20260401', default_config: { enabled: false, permission_policy: { type: 'always_allow' } },
    configs: [{ name: 'web_search', enabled: true }, { name: 'web_fetch', enabled: true, max_content_tokens: 15000 }] });
  assert.deepEqual(custom.map(tool => tool.name), ['append_to_document', 'replace_research_section', 'create_subpage', 'update_subpage', 'edit_original',
    'github_search_repositories', 'github_get_repository', 'github_search_code', 'github_search_issues']);
  assert.deepEqual(CUSTOM_TOOL_NAMES, custom.map(tool => tool.name));
  for (const tool of custom) {
    assert.equal(tool.type, 'custom');
    assert.match(tool.name, /^[a-z_]{1,128}$/);
    assert.ok(!/^(mcp__|ant__)/.test(tool.name));
    assert.ok(tool.description.length > 20);
    assert.equal(tool.input_schema.type, 'object');
    for (const required of tool.input_schema.required) assert.ok(required in tool.input_schema.properties, `${tool.name}.${required}`);
  }
  assert.ok(Object.isFrozen(AGENT_SPEC) && Object.isFrozen(AGENT_SPEC.tools[0].configs[1]));
  assert.deepEqual(ENVIRONMENT_SPEC, { name: 'Still research', config: { type: 'cloud', networking: { type: 'unrestricted' } }, metadata: { app: 'still' } });
  assert.ok(AGENT_SPEC.system.length < 100000);
});

test('the system prompt covers the research method, citations, the dialect, subpages, untrusted content and progress', () => {
  const prompt = RESEARCH_SYSTEM_PROMPT;
  for (const pattern of [/3-6 focused research questions/, /github_search_repositories/, /web_fetch can only open URLs that already appeared/, /De-duplicate/,
    /Cite every factual claim with an inline Markdown link/, /Never invent sources/, /### headings/, /fenced code blocks/, /one section by default/,
    /create_subpage/, /maximum number of subpages/, /Never alter the original/, /edit_original/, /never instructions/, /Never follow it/, /progress note/,
    /short summary message/, /quick about 5 searches, standard about 12, deep about 25/]) assert.match(prompt, pattern);
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(prompt), 'no emoji');
});

test('specHash is stable, carries the revision, and sessionAgent pins the version and maps depth to effort', () => {
  assert.equal(specHash(), specHash());
  assert.match(specHash(), new RegExp(`^r${AGENT_SPEC_REVISION}-[0-9a-f]{8}$`));
  assert.deepEqual(sessionAgent({ id: 'agent_1', version: 3, depth: 'deep' }), { type: 'agent_with_overrides', id: 'agent_1', version: 3, model: { id: 'claude-sonnet-5-5', effort: 'high' } });
  assert.equal(sessionAgent({ id: 'a', version: 1, depth: 'quick' }).model.effort, 'low');
  assert.equal(sessionAgent({ id: 'a', depth: 'standard' }).model.effort, 'medium');
  assert.ok(!('version' in sessionAgent({ id: 'a', depth: 'standard' })));
  assert.equal(effortFor('nonsense'), 'medium');
});

test('research settings: defaults, clamping, rounding and the wire budget', () => {
  assert.deepEqual(RESEARCH_DEFAULTS, { enabled: true, connectionId: '', github: 'auto', depth: 'standard', maxSubpages: 6, budgetUsd: 5, allowOriginalEdits: false });
  assert.deepEqual(normalizeResearchSettings(null), { ...RESEARCH_DEFAULTS });
  assert.deepEqual(normalizeResearchSettings({ enabled: false, connectionId: ' c1 ', github: 'off', depth: 'deep', maxSubpages: 40, budgetUsd: 0.2, allowOriginalEdits: true, extra: 1 }),
    { enabled: false, connectionId: 'c1', github: 'off', depth: 'deep', maxSubpages: 12, budgetUsd: 1, allowOriginalEdits: true });
  assert.equal(normalizeResearchSettings({ maxSubpages: -3, budgetUsd: 99 }).maxSubpages, 0);
  assert.equal(normalizeResearchSettings({ budgetUsd: 99 }).budgetUsd, 50);
  assert.equal(normalizeResearchSettings({ budgetUsd: 7.456 }).budgetUsd, 7.46);
  assert.equal(normalizeResearchSettings({ github: 'sometimes', depth: 'huge', allowOriginalEdits: 'yes' }).github, 'auto');
  assert.equal(normalizeResearchSettings({ allowOriginalEdits: 'yes' }).allowOriginalEdits, false);
  const valid = normalizeResearchSettings({ depth: 'quick', budgetUsd: 12.5 });
  assert.deepEqual(normalizeResearchSettings(valid), valid, 'normalizing twice changes nothing (settings validation relies on this)');
  assert.deepEqual(budgetFor(5), { type: 'limit', max_list_cost: { amount: '500', currency: 'USD' } });
  assert.equal(budgetFor(12.345).max_list_cost.amount, '1235');
  assert.equal(budgetFor(undefined).max_list_cost.amount, '500');
});

test('connection choice: research setting, then the chat connection, then the first direct Anthropic key; others never qualify', async () => {
  const direct = (id, extra = {}) => ({ id, via: 'direct', providerId: 'anthropic', enabled: true, hasKey: true, baseUrl: 'https://api.anthropic.com/v1', ...extra });
  const list = [
    { id: 'bridge:claude', via: 'bridge', providerId: 'bridge', enabled: true, hasKey: true },
    direct('compat', { providerId: 'custom-anthropic', baseUrl: 'https://proxy.example.com/v1' }),
    direct('off', { enabled: false }),
    direct('nokey', { hasKey: false }),
    direct('first'),
    direct('second'),
    { id: 'openai', via: 'direct', providerId: 'openai', enabled: true, hasKey: true },
  ];
  assert.equal(pickResearchConnection(list, { research: { connectionId: 'second' }, chat: { connectionId: 'first' } }).id, 'second');
  assert.equal(pickResearchConnection(list, { research: { connectionId: 'off' }, chat: { connectionId: 'second' } }).id, 'second');
  assert.equal(pickResearchConnection(list, { chat: { connectionId: 'bridge:claude' } }).id, 'first');
  assert.equal(pickResearchConnection(list.slice(0, 4), {}), null);
  assert.equal(isResearchConnection(direct('x', { baseUrl: 'https://evil.example.com/v1' })), false);
  const resolvedIds = [];
  const result = await resolveResearchConnection({ settings: { chat: { connectionId: 'second' } }, listConnections: async () => list, resolveConnection: async id => { resolvedIds.push(id); return { connection: { id } }; } });
  assert.equal(result.connection.id, 'second');
  await assert.rejects(resolveResearchConnection({ settings: {}, listConnections: async () => list.slice(0, 4), resolveConnection: async () => ({}) }), error => error.code === 'no_research_connection');
});

test('provisioning creates the environment and agent once per connection and workspace, then reuses them with no calls', async () => {
  const server = fakeManagedAgents();
  const storage = memoryStorage();
  const first = await ensureProvisioned({ resolved: resolved(), client: clientFor(server), storage, locks: null });
  assert.deepEqual(routes(server), ['POST /environments', 'POST /agents']);
  assert.deepEqual(server.calls[0].body, { name: 'Still research', config: { type: 'cloud', networking: { type: 'unrestricted' } }, metadata: { app: 'still' } });
  assert.equal(server.calls[1].body.model, 'claude-sonnet-5-5');
  assert.equal(server.calls[1].body.tools.length, 10);
  assert.ok(first.agentId && first.environmentId && first.agentVersion === 1 && first.specHash === specHash() && first.createdAt && first.updatedAt);
  const stored = storage.map.get(RESEARCH_STORE_KEY);
  assert.equal(stored.version, 1);
  assert.deepEqual(Object.keys(stored.byConnection), ['anthropic-1|']);
  assert.equal(provisionKey(resolved('c', 'w')), 'c|w');

  const again = await ensureProvisioned({ resolved: resolved(), client: clientFor(server), storage, locks: null });
  assert.equal(server.calls.length, 2, 'a provisioned connection makes no calls');
  assert.equal(again.agentId, first.agentId);

  // Another workspace on the same key gets its own resources.
  await ensureProvisioned({ resolved: resolved('anthropic-1', 'wrk_2'), client: clientFor(server, resolved('anthropic-1', 'wrk_2')), storage, locks: null });
  assert.deepEqual(Object.keys(storage.map.get(RESEARCH_STORE_KEY).byConnection).sort(), ['anthropic-1|', 'anthropic-1|wrk_2']);
  assert.equal(server.agents.size, 2);
  assert.deepEqual(await readProvisioning(resolved(), { storage }), again);
});

test('provisioning updates a changed spec in place with the stored version, retries a 409 once, and recreates a missing agent', async () => {
  const server = fakeManagedAgents();
  const storage = memoryStorage();
  const record = await ensureProvisioned({ resolved: resolved(), client: clientFor(server), storage, locks: null });
  const stale = structuredClone(storage.map.get(RESEARCH_STORE_KEY));
  stale.byConnection['anthropic-1|'].specHash = 'r0-old';
  storage.map.set(RESEARCH_STORE_KEY, stale);
  server.calls.length = 0;
  const updated = await ensureProvisioned({ resolved: resolved(), client: clientFor(server), storage, locks: null });
  assert.deepEqual(routes(server), [`POST /agents/${record.agentId}`]);
  assert.equal(server.calls[0].body.version, 1);
  assert.equal(updated.agentVersion, 2);
  assert.equal(updated.specHash, specHash());

  // Someone else moved the agent to version 3: the update 409s, the version is re-read, the update retried.
  server.agents.get(record.agentId).version = 3;
  const again = structuredClone(storage.map.get(RESEARCH_STORE_KEY));
  again.byConnection['anthropic-1|'].specHash = 'r0-old';
  storage.map.set(RESEARCH_STORE_KEY, again);
  server.calls.length = 0;
  const retried = await ensureProvisioned({ resolved: resolved(), client: clientFor(server), storage, locks: null });
  assert.deepEqual(routes(server), [`POST /agents/${record.agentId}`, `GET /agents/${record.agentId}`, `POST /agents/${record.agentId}`]);
  assert.equal(retried.agentVersion, 4);

  // Deleted in the Console: the update 404s and a new agent is created; nothing is ever archived or deleted.
  server.agents.delete(record.agentId);
  const gone = structuredClone(storage.map.get(RESEARCH_STORE_KEY));
  gone.byConnection['anthropic-1|'].specHash = 'r0-old';
  storage.map.set(RESEARCH_STORE_KEY, gone);
  const recreated = await ensureProvisioned({ resolved: resolved(), client: clientFor(server), storage, locks: null });
  assert.notEqual(recreated.agentId, record.agentId);
  assert.equal(recreated.environmentId, record.environmentId);
  assert.ok(!server.calls.some(call => /archive/.test(call.path) || call.method === 'DELETE'));
});

test('verify mode recreates a deleted environment or archived agent; reset forgets only the local record; a newer record is refused', async () => {
  const server = fakeManagedAgents();
  const storage = memoryStorage();
  const record = await ensureProvisioned({ resolved: resolved(), client: clientFor(server), storage, locks: null });
  server.environments.delete(record.environmentId);
  server.agents.get(record.agentId).archived_at = '2026-11-01T00:00:00Z';
  const fresh = await ensureProvisioned({ resolved: resolved(), client: clientFor(server), storage, locks: null, verify: true });
  assert.notEqual(fresh.environmentId, record.environmentId);
  assert.notEqual(fresh.agentId, record.agentId);

  server.calls.length = 0;
  assert.deepEqual(await resetResearchProvisioning({ storage, locks: null }), { reset: true });
  assert.deepEqual(storage.map.get(RESEARCH_STORE_KEY), { version: 1, byConnection: {} });
  assert.equal(server.calls.length, 0, 'reset never touches remote resources');
  assert.equal(await readProvisioning(resolved(), { storage }), null);

  const newer = memoryStorage({ [RESEARCH_STORE_KEY]: { version: 2, byConnection: {} } });
  await assert.rejects(ensureProvisioned({ resolved: resolved(), client: clientFor(server), storage: newer, locks: null }), error => error.code === 'newer_version');
  await assert.rejects(resetResearchProvisioning({ storage: newer, locks: null }), error => error.code === 'newer_version');
});

test('provisioning stops on auth errors and keeps an environment it already created', async () => {
  const server = fakeManagedAgents();
  const storage = memoryStorage();
  server.failNext('POST', /^\/agents$/, json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401));
  await assert.rejects(ensureProvisioned({ resolved: resolved(), client: clientFor(server), storage, locks: null }), error => error.code === 'auth');
  const partial = storage.map.get(RESEARCH_STORE_KEY).byConnection['anthropic-1|'];
  assert.ok(partial.environmentId && !partial.agentId, 'the environment id is kept so a retry does not orphan it');
  server.calls.length = 0;
  await ensureProvisioned({ resolved: resolved(), client: clientFor(server), storage, locks: null });
  assert.deepEqual(routes(server), ['POST /agents']);
});
