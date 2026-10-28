import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SETTINGS_SECTIONS, normalizeSection, ACCENTS, MCP_TOOLS, MCP_CLIENTS, CHROME_COMMANDS, connectionStatus, providerGroups, choiceValue, parseChoice,
  modelChoices, findModel, effortFor, embeddingConnections, indexSummary, embeddingNote, bridgeSummary, authText, verificationLink, groupShortcuts,
  chromeCommandRows, clientStatus, providerConnection, maskedKey, integrationGroups,
} from '../extension/ui/settings.js';
import { CATALOG, getProvider } from '../extension/lib/ai/catalog.js';
import { getMcpSetup, INTEGRATION_CATALOG } from '../extension/lib/integrations.js';
import { TOOLS } from '../bridge/protocol.mjs';

test('settings sections match the openSettings contract', () => {
  assert.deepEqual(SETTINGS_SECTIONS.map(section => section.id), ['general', 'appearance', 'library', 'ai', 'search', 'agents', 'integrations', 'shortcuts', 'about', 'help']);
  for (const section of SETTINGS_SECTIONS) assert.ok(section.label && section.icon && section.summary, section.id);
  assert.equal(normalizeSection('agents'), 'agents');
  assert.equal(normalizeSection('nope'), 'general');
  assert.equal(normalizeSection(undefined), 'general');
});

test('accent swatches are exactly the presets tokens.css defines (no violet)', async () => {
  const css = await readFile(new URL('../extension/styles/tokens.css', import.meta.url), 'utf8');
  const presets = new Set([...css.matchAll(/\[data-accent="([a-z]+)"\]/g)].map(match => match[1]));
  presets.delete('amber'); // alias of gold
  assert.deepEqual(new Set(ACCENTS.map(accent => accent.id)), presets);
  assert.deepEqual(ACCENTS.map(accent => accent.label), ['Blue', 'Teal', 'Green', 'Raindrop gold', 'Orange', 'Pink', 'Graphite']);
  assert.equal(ACCENTS.find(accent => accent.id === 'gold').label, 'Raindrop gold');
  assert.ok(!ACCENTS.some(accent => accent.id === 'violet'));
});

test('the MCP tool list in settings matches the bridge tools', () => {
  assert.deepEqual(MCP_TOOLS.map(tool => tool.name).sort(), TOOLS.map(tool => tool.name).sort());
  const readOnly = new Map(TOOLS.map(tool => [tool.name, tool.annotations?.readOnlyHint === true]));
  for (const tool of MCP_TOOLS) assert.equal(!tool.write, readOnly.get(tool.name), tool.name);
  assert.ok(MCP_TOOLS.some(tool => tool.name === 'semantic_search'));
});

test('connection status badges', () => {
  assert.deepEqual(connectionStatus(null), { label: 'Not connected', tone: 'neutral' });
  assert.deepEqual(connectionStatus({ status: 'ok' }), { label: 'Connected', tone: 'success' });
  assert.deepEqual(connectionStatus({ status: 'error' }), { label: 'Error', tone: 'danger' });
  assert.deepEqual(connectionStatus({ status: 'untested' }), { label: 'Not tested', tone: 'neutral' });
  assert.deepEqual(connectionStatus({ status: 'ok', enabled: false }), { label: 'Off', tone: 'neutral' });
});

test('provider groups cover every direct provider once and no bridged entries', () => {
  const groups = providerGroups(CATALOG);
  const ids = groups.flatMap(group => group.providers.map(provider => provider.id));
  const direct = CATALOG.filter(provider => provider.via === 'direct').map(provider => provider.id);
  assert.deepEqual([...ids].sort(), [...direct].sort());
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.some(id => id.startsWith('agent:') || id === 'bridge' || id === 'chatgpt-oauth'));
  assert.equal(groups[0].providers[0].id, 'anthropic');
  assert.ok(groups.find(group => group.id === 'embeddings').providers.some(provider => provider.id === 'voyage'));
});

test('model choices round-trip ids that contain colons and slashes', () => {
  for (const [connectionId, model] of [['agent:claude-code', 'default'], ['openrouter-1', 'anthropic/claude-opus-5.5'], ['perplexity-2', 'preset:fast'], ['bridge:abc', '']]) {
    assert.deepEqual(parseChoice(choiceValue(connectionId, model)), { connectionId, model });
  }
  assert.deepEqual(parseChoice(''), { connectionId: '', model: '' });
});

test('model choices skip disabled and embedding-only connections and fall back to the default model', () => {
  const connections = [
    { id: 'a', providerId: 'anthropic', label: 'Anthropic', models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }, { id: 'e', name: 'E', capabilities: { embeddings: true } }] },
    { id: 'v', providerId: 'voyage', label: 'Voyage', models: [] },
    { id: 'off', providerId: 'openai', label: 'Off', enabled: false, models: [{ id: 'x', name: 'X' }] },
    { id: 'b', providerId: 'bridge', label: 'Bridge', models: [], defaultModel: 'llama' },
  ];
  const groups = modelChoices(connections, getProvider);
  assert.deepEqual(groups.map(group => group.group), ['Anthropic', 'Bridge']);
  assert.deepEqual(groups[0].options, [{ value: 'a::claude-opus-5-5', label: 'Claude Opus 5.5' }]);
  assert.deepEqual(groups[1].options, [{ value: 'b::llama', label: 'llama' }]);
});

test('findModel and effortFor keep the effort valid for the chosen model', () => {
  const connections = [{ id: 'a', defaultModel: 'm1', models: [{ id: 'm1', efforts: ['low', 'medium', 'high'] }, { id: 'm2', efforts: ['low', 'high', 'max'], defaultEffort: 'high' }, { id: 'm3', efforts: [] }] }];
  assert.equal(findModel(connections, { connectionId: 'a' }).id, 'm1');
  assert.equal(findModel(connections, { connectionId: 'a', model: 'm2' }).model.id, 'm2');
  assert.equal(findModel(connections, { connectionId: 'missing' }).connection, null);
  assert.equal(effortFor(connections[0].models[0], 'high'), 'high');
  assert.equal(effortFor(connections[0].models[1], 'medium'), 'high');
  assert.equal(effortFor({ efforts: ['low', 'medium'] }, 'max'), 'medium');
  assert.equal(effortFor({ efforts: ['minimal', 'low'] }, 'max'), 'minimal');
  assert.equal(effortFor(connections[0].models[2], 'xhigh'), 'xhigh');
  assert.equal(effortFor(null, 'low'), 'low');
});

test('embedding connections put Voyage first and leave out bridged and disabled ones', () => {
  const list = embeddingConnections([
    { id: 'o', via: 'direct', providerId: 'openai', supports: { embeddings: true } },
    { id: 'a', via: 'direct', providerId: 'anthropic', supports: { embeddings: false } },
    { id: 'v', via: 'direct', providerId: 'voyage', supports: { embeddings: true } },
    { id: 'off', via: 'direct', providerId: 'mistral', enabled: false, supports: { embeddings: true } },
    { id: 'b', via: 'bridge', providerId: 'bridge', supports: { embeddings: true } },
  ]);
  assert.deepEqual(list.map(c => c.id), ['v', 'o']);
});

test('index summaries describe every indexer state in plain words', () => {
  assert.equal(indexSummary(null).state, 'loading');
  assert.equal(indexSummary({ enabled: false, indexed: 0 }).detail, 'Turn on semantic search to build the index.');
  assert.match(indexSummary({ enabled: false, indexed: 5, total: 9 }).detail, /^5 items indexed earlier/);
  assert.deepEqual(indexSummary({ enabled: true, error: 'Check the API key.', total: 4, indexed: 1 }), { state: 'error', tone: 'danger', label: 'Needs attention', detail: 'Check the API key.', percent: 25 });
  assert.deepEqual(indexSummary({ enabled: true, running: true, total: 1284, indexed: 412 }), { state: 'running', tone: 'info', label: 'Indexing', detail: '412 of 1,284 items indexed.', percent: 32 });
  assert.equal(indexSummary({ enabled: true, waiting: true, total: 2, indexed: 1 }).state, 'waiting');
  assert.equal(indexSummary({ enabled: true, paused: true, total: 2, indexed: 1 }).label, 'Paused');
  assert.equal(indexSummary({ enabled: true, pending: 3, total: 10, indexed: 7, failed: 1 }).detail, '7 of 10 items indexed. 3 items waiting. 1 item could not be indexed.');
  assert.deepEqual(indexSummary({ enabled: true, total: 3, indexed: 3 }), { state: 'ready', tone: 'success', label: 'Up to date', detail: '3 of 3 items indexed.', percent: 100 });
  assert.equal(indexSummary({ enabled: true, total: 0, indexed: 0 }).detail, 'Nothing to index yet.');
  // indexed never exceeds total (stale counts while items are deleted)
  assert.equal(indexSummary({ enabled: true, total: 2, indexed: 5 }).percent, 100);
});

test('embedding notes name where text goes and estimate cost only with a price', () => {
  assert.deepEqual(embeddingNote({}), []);
  const cloud = embeddingNote({ providerName: 'OpenAI', tokens: 1_500_000, price: 0.02 });
  assert.match(cloud[0], /sent to OpenAI to create embeddings/);
  assert.match(cloud[1], /roughly \$0\.03 at \$0\.02 per million tokens/);
  assert.match(embeddingNote({ providerName: 'OpenAI', tokens: 2000, price: 0.02 })[1], /less than \$0\.01/);
  assert.match(embeddingNote({ providerName: 'Voyage AI', tokens: 2000, price: null })[1], /Check Voyage AI’s pricing page/);
  const local = embeddingNote({ providerName: 'Ollama', local: true, tokens: 900 });
  assert.match(local[0], /stays on this computer/);
  assert.match(local[1], /no per-token cost/);
  assert.equal(embeddingNote({ providerName: 'OpenAI', tokens: 0, price: 0.02 }).length, 1);
});

test('bridge summary: unpaired, paused, connected, offline, connecting', () => {
  assert.equal(bridgeSummary({ integration: { bridgeConfigured: false } }).state, 'unpaired');
  assert.equal(bridgeSummary({ integration: { bridgeConfigured: true, bridgeEnabled: false } }).state, 'paused');
  assert.match(bridgeSummary({ integration: { bridgeConfigured: true, bridgeEnabled: false, pausedHere: true } }).detail, /^Paused in this window/);
  const connected = bridgeSummary({ integration: { bridgeConfigured: true, bridgeEnabled: true }, live: { connected: true, syncedAt: new Date().toISOString() } });
  assert.equal(connected.state, 'connected');
  assert.equal(connected.detail, 'Synced just now.');
  assert.equal(bridgeSummary({ integration: { bridgeConfigured: true, bridgeEnabled: true }, live: { connected: false, error: 'fetch failed' } }).state, 'offline');
  assert.equal(bridgeSummary({ integration: { bridgeConfigured: true, bridgeEnabled: true }, bridge: { paired: true, reachable: false } }).state, 'offline');
  assert.equal(bridgeSummary({ integration: { bridgeConfigured: true, bridgeEnabled: true } }).state, 'connecting');
});

test('CLI sign-in text and the ChatGPT verification link guard', () => {
  assert.equal(authText(undefined), 'Sign-in not checked');
  assert.equal(authText({ status: 'authenticated', method: 'chatgpt' }), 'Signed in with ChatGPT');
  assert.equal(authText({ status: 'authenticated', method: 'mystery' }), 'Signed in');
  assert.equal(authText({ status: 'unauthenticated' }), 'Not signed in');
  assert.equal(authText({ status: 'unknown' }), 'Sign-in status unknown');
  assert.equal(verificationLink('https://auth.openai.com/codex/device'), 'https://auth.openai.com/codex/device');
  for (const bad of ['http://auth.openai.com/x', 'https://auth.openai.com.evil.test/', 'https://example.com/', 'javascript:alert(1)', '', undefined]) assert.equal(verificationLink(bad), '', String(bad));
});

test('shortcuts are grouped by owning module, deduplicated, and unlabeled ones hidden', () => {
  const groups = groupShortcuts([
    { keys: 'a', label: 'Add a link', action: 'shell.add' },
    { keys: 'mod+enter', label: 'Save the note', action: 'notes.save' },
    { keys: 'mod+shift+s', label: 'Quick add', action: 'add.open' },
    { keys: 'a', label: 'Add a link', action: 'shell.add' },
    { keys: 'x', action: 'shell.hidden' },
    { keys: 'q', label: 'Mystery', action: 'zzz.thing' },
  ]);
  assert.deepEqual(groups.map(group => group.group), ['General', 'Saving', 'Notes', 'Other']);
  assert.equal(groups[0].rows.length, 1);
});

test('Chrome command rows use live keys when available and the manifest defaults otherwise', () => {
  assert.deepEqual(chromeCommandRows(null).map(row => row.shortcut), CHROME_COMMANDS.map(command => command.shortcut));
  const rows = chromeCommandRows([
    { name: '_execute_action', description: '', shortcut: '' },
    { name: '_execute_side_panel', description: '', shortcut: 'Alt+Shift+P' },
    { name: 'save-current', description: 'Save this page to Still', shortcut: '' },
  ]);
  assert.deepEqual(rows.map(row => row.name), ['_execute_side_panel', 'save-current']);
  assert.equal(rows[1].shortcut, '');
});

test('MCP client status and manual setup snippets', () => {
  assert.equal(clientStatus(null), null);
  assert.equal(clientStatus({ configurationStatus: 'configured' }).label, 'Connected');
  assert.equal(clientStatus({ configurationStatus: 'conflict' }).tone, 'warning');
  assert.equal(clientStatus({ configurationStatus: 'manual' }).label, 'Manual setup');
  assert.equal(clientStatus({ configurationStatus: 'not_configured' }).label, 'Not connected');
  assert.deepEqual(MCP_CLIENTS.map(client => client.id), ['claude', 'codex', 'claude-desktop', 'cursor', 'vscode']);
  for (const root of ['', '/Users/me/sidebar-dock']) {
    const setup = getMcpSetup(root, { nodePath: root ? '/usr/local/bin/node' : '' });
    for (const client of MCP_CLIENTS) {
      const steps = client.manual(setup);
      assert.ok(steps.length && steps.every(step => typeof step.code === 'string' && step.code.includes('mcp.mjs')), client.id);
    }
    assert.match(MCP_CLIENTS[0].manual(setup)[0].code, /--scope user/);
  }
  assert.ok(MCP_CLIENTS.find(client => client.id === 'vscode').bridge === false);
});

test('settings source and styles follow the copy and token rules', async () => {
  const source = await readFile(new URL('../extension/ui/settings.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('—'), 'no em dashes in UI strings');
  assert.ok(!/\bon[a-z]+\s*=\s*["']/.test(source.replace(/\/\/.*$/gm, '')), 'no inline event handlers');
  const css = await readFile(new URL('../extension/styles/settings.css', import.meta.url), 'utf8');
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i.test(code), 'no color literals outside tokens.css');
  assert.ok(!/backdrop-filter|transition:\s*all/.test(code));
});

test('provider tiles edit the working connection and custom servers always add one', () => {
  const connections = [
    { id: 'a1', via: 'direct', providerId: 'anthropic', status: 'error' },
    { id: 'a2', via: 'direct', providerId: 'anthropic', status: 'ok' },
    { id: 'o1', via: 'direct', providerId: 'openai', status: 'untested' },
    { id: 'c1', via: 'direct', providerId: 'custom-openai', status: 'ok' },
    { id: 'bridge:x', via: 'bridge', providerId: 'bridge', status: 'ok' },
  ];
  assert.equal(providerConnection(connections, getProvider('anthropic')).id, 'a2');
  assert.equal(providerConnection(connections, getProvider('openai')).id, 'o1');
  assert.equal(providerConnection(connections, getProvider('custom-openai')), null);
  assert.equal(providerConnection(connections, getProvider('voyage')), null);
  assert.equal(providerConnection(connections, null), null);
  assert.equal(providerConnection([{ id: 'e', via: 'direct', providerId: 'xai', status: 'error' }, { id: 'u', via: 'direct', providerId: 'xai' }], getProvider('xai')).id, 'e');
});

test('saved keys are masked and never show more than their last four characters', () => {
  assert.equal(maskedKey(''), '••••••••');
  assert.equal(maskedKey(undefined), '••••••••');
  assert.equal(maskedKey('a1b2'), '••••••••a1b2');
  assert.equal(maskedKey('sk-ant-api03-secret-value-WXYZ'), '••••••••WXYZ');
  assert.equal(maskedKey(' 9z '), '••••••••9z');
});

test('integration groups split catalog apps into Raindrop guides, backups and the rest', () => {
  const groups = integrationGroups(INTEGRATION_CATALOG);
  const ids = groups.flatMap(group => group.entries.map(entry => entry.id));
  assert.ok(!ids.some(id => ['claude', 'codex', 'raindrop'].includes(id)), 'built-in integrations have their own rows');
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, INTEGRATION_CATALOG.length - 3);
  const byId = Object.fromEntries(groups.map(group => [group.id, group.entries.map(entry => entry.id)]));
  assert.ok(byId.raindrop.includes('notion') && byId.raindrop.includes('zapier'));
  assert.deepEqual(byId.backup, ['drive', 'dropbox']);
  assert.deepEqual(integrationGroups([{ id: 'x', name: 'X', category: 'Misc', url: 'https://example.com/' }]).map(group => group.id), ['other']);
  assert.deepEqual(integrationGroups([]), []);
});
