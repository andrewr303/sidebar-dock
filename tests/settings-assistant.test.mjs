// Settings > Assistant permissions and Settings > Research agent (contracts §8): rows, controls, search, and both surfaces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFiltered, resetIds } from '../extension/ui/settings/parts.js';
import { searchTerms } from '../extension/ui/settings/catalog.js';
import {
  renderAssistantPermissions, renderResearch, researchConnections, researchPatch, PERMISSION_PRESET_CHOICES, RESEARCH_MODEL_LABEL,
  RESEARCH_SUBPAGE_CHOICES, RESEARCH_BUDGET_CHOICES, RESEARCH_GITHUB_CHOICES, RESEARCH_DEPTH_CHOICES,
} from '../extension/ui/settings/assistant.js';
import { PERMISSION_PRESETS } from '../extension/lib/ai/permissions.js';
import { RESEARCH_DEFAULTS, normalizeResearchSettings } from '../extension/lib/ai/research/settings.js';

const { renderSettingsPage, renderAssistantSettingsSection, openSettings } = await import('../extension/ui/settings.js');

const flat = value => String(value).replace(/\s+/g, ' ');
const ctx = (extra = {}) => ({ library: { items: [], collections: [], settings: {} }, env: { isExtension: true }, state: { settings: { section: 'assistant', list: false, query: '', open: new Set() } }, render() {}, ...extra });
// The radio a segmented control marks as chosen, for a control with the given data-name.
const checked = (out, name) => [...out.matchAll(/<button type="button" role="radio" class="segmented-option" aria-checked="true"[^>]*data-value="([^"]*)"[^>]*data-name="([^"]*)"/g)]
  .filter(match => match[2] === name).map(match => match[1]);

test('Assistant permissions shows the preset and an Ask or Allow control for each kind of change', () => {
  resetIds();
  const out = flat(renderAssistantPermissions(ctx(), { permissions: undefined }));
  assert.deepEqual(PERMISSION_PRESET_CHOICES.map(choice => choice.label), ['Always ask', 'Trusted', 'Full access', 'Custom']);
  for (const label of ['Always ask', 'Trusted', 'Full access', 'Custom']) assert.ok(out.includes(`<span>${label}</span>`), label);
  assert.deepEqual(checked(out, 'preset'), ['ask']);
  for (const [label, hint] of [['Create', 'New notes, saved links, imported chats and collections'], ['Organize', 'Move items, tags, favorites, archive, restore, links between items'],
    ['Edit', 'Change titles, notes and collection details'], ['Dashboard', 'Add widgets to your boards'], ['Delete', 'Move to Trash, delete collections and tags']]) {
    assert.ok(out.includes(`<span class="settings-row-label">${label}</span>`), label);
    assert.ok(out.includes(hint), hint);
  }
  for (const id of ['create', 'organize', 'edit', 'dashboard', 'delete']) {
    assert.deepEqual(checked(out, id), ['ask'], id);
    assert.ok(out.includes(`id="settings-permission-${id}"`), `${id} row can be linked to`);
  }
  assert.equal(out.match(/data-action="settings\.ai-permission"/g).length, 10, 'Ask and Allow for five kinds');
  assert.equal(out.match(/data-action="settings\.ai-permission-preset"/g).length, 4);
  assert.match(out, /Adding links to folders uses Create and Organize\./);
  assert.match(out, /stay on this device\. Backups never include them/);
  assert.match(out, /Changes made right away show in the chat with Undo/);
});

test('the preset follows the levels: Trusted, Full access and Custom', () => {
  const trusted = flat(renderAssistantPermissions(ctx(), { permissions: PERMISSION_PRESETS.trusted }));
  assert.deepEqual(checked(trusted, 'preset'), ['trusted']);
  assert.deepEqual(checked(trusted, 'delete'), ['ask']);
  assert.deepEqual(checked(trusted, 'create'), ['allow']);
  assert.match(trusted, /except deleting/);
  const full = flat(renderAssistantPermissions(ctx(), { permissions: PERMISSION_PRESETS.full }));
  assert.deepEqual(checked(full, 'preset'), ['full']);
  assert.match(full, /Items in Trash can be restored, and Undo brings deleted collections and tags back/, 'allowing deletes says how to get things back');
  const custom = flat(renderAssistantPermissions(ctx(), { permissions: { create: 'allow', delete: 'allow' } }));
  assert.deepEqual(checked(custom, 'preset'), ['custom']);
  assert.match(custom, /Your own mix/);
});

test('searching Settings finds the permission rows by kind and by preset', () => {
  const render = () => renderAssistantPermissions(ctx(), { permissions: undefined });
  const trash = flat(renderFiltered(searchTerms('trash'), ['Assistant permissions'], render).content);
  assert.ok(trash.includes('settings-permission-delete'));
  assert.ok(!trash.includes('settings-permission-create'));
  const preset = flat(renderFiltered(searchTerms('full access'), ['Assistant permissions'], render).content);
  assert.ok(preset.includes('settings-permission-level'));
  assert.ok(!preset.includes('Adding links to folders'), 'notes stay out of search results');
  assert.equal(renderFiltered(searchTerms('qqzz'), ['Assistant permissions'], render).content, '');
});

const connections = [
  { id: 'anthropic-work', providerId: 'anthropic', via: 'direct', hasKey: true, enabled: true, label: 'Work' },
  { id: 'anthropic-old', providerId: 'anthropic', via: 'direct', hasKey: true, enabled: false, label: 'Old key' },
  { id: 'anthropic-nokey', providerId: 'anthropic', via: 'direct', hasKey: false, enabled: true, label: 'No key' },
  { id: 'compatible', providerId: 'custom-anthropic', via: 'direct', hasKey: true, enabled: true, label: 'Compatible server' },
  { id: 'openai', providerId: 'openai', via: 'direct', hasKey: true, enabled: true, label: 'OpenAI' },
  { id: 'agent:claude-code', providerId: 'agent:claude-code', via: 'agent', hasKey: false, enabled: true, label: 'Claude Code' },
];

test('research connections are direct Anthropic API keys only', () => {
  assert.deepEqual(researchConnections(connections).map(c => c.id), ['anthropic-work'], 'a turned-off key is not offered');
  assert.deepEqual(researchConnections(connections, 'anthropic-old').map(c => c.id), ['anthropic-work', 'anthropic-old'], 'unless it is the one chosen');
  assert.deepEqual(researchConnections(connections, 'anthropic-nokey').map(c => c.id), ['anthropic-work'], 'a key is still required');
  assert.deepEqual(researchConnections(null), []);
});

test('Research agent shows every setting from the contract with the stored values', () => {
  resetIds();
  const research = { ...RESEARCH_DEFAULTS, connectionId: 'anthropic-work', depth: 'deep', github: 'off', maxSubpages: 3, budgetUsd: 10 };
  const out = flat(renderResearch(ctx(), { research, connections, canReset: true }));
  for (const label of ['Offer Research with AI', 'Connection', 'Model', 'Depth', 'GitHub research', 'Subpages per run', 'Spending cap per run', 'Allow editing the original', 'Reset research agent']) {
    assert.ok(out.includes(label), label);
  }
  assert.match(out, /role="switch" checked [^>]*data-change="settings\.research-flag" data-key="enabled"/);
  assert.match(out, /<select name="connectionId"[^>]*data-change="settings\.research"[^>]*>.*<option value="" >Automatic<\/option>.*<option value="anthropic-work" selected >Work<\/option> <\/select>/);
  assert.ok(!/value="openai"|value="compatible"|value="agent:claude-code"|value="anthropic-nokey"|value="anthropic-old"/.test(out), 'only enabled direct Anthropic keys are offered');
  // A turned-off key that is still the chosen one stays visible and says research uses the default instead.
  const off = flat(renderResearch(ctx(), { research: { ...research, connectionId: 'anthropic-old' }, connections, canReset: true }));
  assert.match(off, /<option value="" >Automatic<\/option><option value="anthropic-work" >Work<\/option><option value="anthropic-old" selected >Old key \(off — will use default\)<\/option>/);
  assert.ok(out.includes(RESEARCH_MODEL_LABEL) && /always uses Claude Sonnet 5\.5 with web search and web fetch/.test(out));
  assert.deepEqual(checked(out, 'depth'), ['deep']);
  assert.match(out, /About 25 web searches/);
  assert.match(out, /<select name="github"[^>]*>.*<option value="off" selected >Off<\/option>/);
  assert.match(out, /<option value="auto" >Automatic for tech topics<\/option>/);
  assert.match(out, /<select name="maxSubpages"[^>]*>.*<option value="3" selected >3<\/option>/);
  assert.match(out, /<select name="budgetUsd"[^>]*>.*<option value="10" selected >\$10<\/option>/);
  assert.match(out, /role="switch" (?!checked)[^>]*data-change="settings\.research-flag" data-key="allowOriginalEdits"/, 'editing the original is off');
  assert.match(out, /Anthropic Managed Agents session\. The session, with the page text and what the agent finds, is stored in your Anthropic account/);
  assert.match(out, /data-action="settings\.research-reset"(?![^>]*disabled)/);
  // Without a reset in this build the button is shown but cannot be used.
  assert.match(flat(renderResearch(ctx(), { research, connections, canReset: false })), /data-action="settings\.research-reset"[^>]*disabled/);
});

test('without an Anthropic key, research offers to add one instead of an empty list', () => {
  const out = flat(renderResearch(ctx(), { research: { ...RESEARCH_DEFAULTS }, connections: connections.slice(4) }));
  assert.match(out, /Research needs an Anthropic API key/);
  assert.match(out, /data-action="settings\.connect-open"[^>]*data-provider="anthropic"/);
  assert.ok(!out.includes('name="connectionId"'));
});

test('a stored value the lists do not offer stays visible', () => {
  const out = flat(renderResearch(ctx(), { research: { ...RESEARCH_DEFAULTS, connectionId: 'deleted', budgetUsd: 7.5 }, connections }));
  assert.match(out, /<option value="deleted" selected >Removed connection \(not available\)<\/option>/);
  assert.match(out, /<option value="7\.5" selected >\$7\.5<\/option>/);
});

test('every research choice the UI offers is a value the research settings accept as is', () => {
  const accepted = (key, value) => normalizeResearchSettings({ [key]: value })[key] === value;
  for (const choice of RESEARCH_DEPTH_CHOICES) assert.ok(accepted('depth', choice.value), choice.value);
  for (const choice of RESEARCH_GITHUB_CHOICES) assert.ok(accepted('github', choice.value), choice.value);
  for (const choice of RESEARCH_SUBPAGE_CHOICES) assert.ok(accepted('maxSubpages', Number(choice.value)), choice.value);
  for (const choice of RESEARCH_BUDGET_CHOICES) assert.ok(accepted('budgetUsd', Number(choice.value)), choice.value);
  assert.deepEqual(RESEARCH_SUBPAGE_CHOICES.map(choice => choice.value), Array.from({ length: 13 }, (_, n) => String(n)));
  assert.ok(RESEARCH_BUDGET_CHOICES.some(choice => Number(choice.value) === RESEARCH_DEFAULTS.budgetUsd), 'the default cap is offered');
});

test('researchPatch turns a control into a research settings patch, and nothing else', () => {
  assert.deepEqual(researchPatch('depth', 'quick'), { depth: 'quick' });
  assert.deepEqual(researchPatch('github', 'always'), { github: 'always' });
  assert.deepEqual(researchPatch('connectionId', ''), { connectionId: '' });
  assert.deepEqual(researchPatch('maxSubpages', '0'), { maxSubpages: 0 });
  assert.deepEqual(researchPatch('budgetUsd', '20'), { budgetUsd: 20 });
  for (const name of ['enabled', 'allowOriginalEdits', 'model', '__proto__', 'toString', undefined, 7]) assert.equal(researchPatch(name, 'x'), null, String(name));
});

test('searching research rows by what they control', () => {
  const render = () => renderResearch(ctx(), { research: { ...RESEARCH_DEFAULTS }, connections });
  const budget = flat(renderFiltered(searchTerms('budget'), ['Research agent'], render).content);
  assert.ok(budget.includes('Spending cap per run') && !budget.includes('GitHub research'));
  const github = flat(renderFiltered(searchTerms('github'), ['Research agent'], render).content);
  assert.ok(github.includes('GitHub research'));
});

test('both sections are in the navigation of the full page and the side panel, and wait for the AI engine', () => {
  for (const surface of ['full', 'side']) {
    const view = surface === 'full' ? 'settings:assistant' : 'dashboard';
    const page = flat(renderSettingsPage(ctx({ env: { isExtension: true, isSidepanel: surface === 'side' }, state: { view, shell: {}, settings: { section: 'assistant', list: false, query: '', open: new Set() } } }), { surface }));
    assert.match(page, /id="settings-nav-assistant"/, surface);
    assert.match(page, /id="settings-nav-research"/, surface);
    assert.match(page, /data-section="assistant"/, surface);
    assert.match(page, /<h2 class="settings-section-title"[^>]*>Assistant permissions<\/h2>/, surface);
    assert.match(page, /Loading AI settings/, `${surface}: the engine has not loaded yet`);
    const research = flat(renderSettingsPage(ctx({ env: { isExtension: true, isSidepanel: surface === 'side' }, state: { view: surface === 'full' ? 'settings:research' : 'dashboard', shell: {},
      settings: { section: 'research', list: false, query: '', open: new Set() } } }), { surface }));
    assert.match(research, /<h2 class="settings-section-title"[^>]*>Research agent<\/h2>/, surface);
  }
  // Settings search lists the sections even before the engine loads.
  const results = flat(renderSettingsPage(ctx({ env: { isExtension: true, isSidepanel: true }, prefs: { get: (key, fallback) => fallback }, select: { counts: () => ({}) },
    state: { view: 'dashboard', shell: {}, settings: { section: 'general', list: true, query: 'permissions', open: new Set() } } }), { surface: 'side' }));
  assert.match(results, /id="settings-result-assistant"/);
  assert.match(flat(renderAssistantSettingsSection(ctx({ ai: { DEFAULT_AI_SETTINGS: {} } }))), /Loading assistant permissions/, 'shows loading until the stored settings arrive');
  assert.match(flat(renderAssistantSettingsSection(ctx({ ai: { DEFAULT_AI_SETTINGS: {} } }), 'research')), /Loading research settings/);
  assert.equal(typeof openSettings, 'function');
});

/* ------------------------------------------------------------------ actions (ui/settings.js) */

const { dispatch } = await import('../extension/ui/runtime.js');
// A stub AI facade that records writes and answers like lib/ai/connections.js would.
function fakeAi({ reset = true } = {}) {
  const writes = [];
  let settings = { chat: { connectionId: '' }, assistantPermissions: { ...PERMISSION_PRESETS.ask }, research: { ...RESEARCH_DEFAULTS } };
  const ai = {
    writes, resets: 0, DEFAULT_AI_SETTINGS: { research: RESEARCH_DEFAULTS },
    async setAiSettings(patch) {
      writes.push(structuredClone(patch));
      for (const [key, value] of Object.entries(patch)) settings[key] = value && typeof value === 'object' ? { ...settings[key], ...value } : value;
      return structuredClone(settings);
    },
    async getAiSettings() { return structuredClone(settings); },
    async listConnections() { return connections; },
    async getBridgeStatus() { return null; },
    getIndexStatus() { return null; },
    getProvider: () => null,
  };
  if (reset) ai.resetResearchProvisioning = async () => { ai.resets++; };
  return ai;
}
const actionCtx = (ai, extra = {}) => {
  const toasts = [];
  return { ...ctx({ ai, toasts, toast: (message, options) => toasts.push([message, options?.tone]), nextFrame() {}, confirm: async () => true, prefs: { get: (key, fallback) => fallback }, ...extra }) };
};

test('permission actions write only known kinds and levels; presets write all five; Custom writes nothing', async () => {
  const ai = fakeAi();
  const c = actionCtx(ai);
  await dispatch('settings.ai-permission', { ctx: c, data: { name: 'delete', value: 'allow' } });
  await dispatch('settings.ai-permission', { ctx: c, data: { name: 'everything', value: 'allow' } });
  await dispatch('settings.ai-permission', { ctx: c, data: { name: 'create', value: 'auto' } });
  await dispatch('settings.ai-permission-preset', { ctx: c, data: { value: 'trusted' } });
  await dispatch('settings.ai-permission-preset', { ctx: c, data: { value: 'custom' } });
  await dispatch('settings.ai-permission-preset', { ctx: c, data: { value: 'constructor' } });
  assert.deepEqual(ai.writes, [{ assistantPermissions: { delete: 'allow' } }, { assistantPermissions: { ...PERMISSION_PRESETS.trusted } }]);
  // Once a write has brought the stored settings in, the section renders them.
  const out = flat(renderAssistantSettingsSection(c));
  assert.deepEqual(checked(out, 'preset'), ['trusted']);
});

test('research actions write the field the control names, as the right type; flags only their own keys', async () => {
  const ai = fakeAi();
  const c = actionCtx(ai);
  await dispatch('settings.research', { ctx: c, el: {}, data: { name: 'depth', value: 'quick' } });
  await dispatch('settings.research', { ctx: c, el: { name: 'budgetUsd', value: '20' }, data: { change: 'settings.research' } });
  await dispatch('settings.research', { ctx: c, el: { name: 'maxSubpages', value: '0' }, data: {} });
  await dispatch('settings.research', { ctx: c, el: { name: 'connectionId', value: 'anthropic-work' }, data: {} });
  await dispatch('settings.research', { ctx: c, el: { name: 'model', value: 'claude-opus-5-5' }, data: {} });
  await dispatch('settings.research-flag', { ctx: c, el: { checked: true }, data: { key: 'allowOriginalEdits' } });
  await dispatch('settings.research-flag', { ctx: c, el: { checked: false }, data: { key: 'enabled' } });
  await dispatch('settings.research-flag', { ctx: c, el: { checked: true }, data: { key: 'budgetUsd' } });
  assert.deepEqual(ai.writes, [{ research: { depth: 'quick' } }, { research: { budgetUsd: 20 } }, { research: { maxSubpages: 0 } }, { research: { connectionId: 'anthropic-work' } },
    { research: { allowOriginalEdits: true } }, { research: { enabled: false } }]);
});

test('the research section renders the loaded settings, and Reset asks first and is guarded when the build lacks it', async () => {
  const ai = fakeAi();
  const c = actionCtx(ai);
  await dispatch('settings.refresh', { ctx: c });
  await dispatch('settings.research', { ctx: c, el: {}, data: { name: 'depth', value: 'deep' } });
  const out = flat(renderAssistantSettingsSection(c, 'research'));
  assert.deepEqual(checked(out, 'depth'), ['deep']);
  assert.match(out, /<option value="anthropic-work" >Work<\/option>/);
  assert.match(out, /data-action="settings\.research-reset"(?![^>]*disabled)/);
  await dispatch('settings.research-reset', { ctx: c });
  assert.equal(ai.resets, 1);
  assert.deepEqual(c.toasts.at(-1), ['Research agent reset', 'success']);
  const declined = actionCtx(ai, { confirm: async () => false });
  await dispatch('settings.research-reset', { ctx: declined });
  assert.equal(ai.resets, 1, 'cancelling the confirm changes nothing');
  const older = fakeAi({ reset: false });
  const guarded = actionCtx(older);
  await dispatch('settings.research-reset', { ctx: guarded });
  assert.deepEqual(guarded.toasts, [['Research is not available in this version of Still.', 'warning']]);
  assert.match(flat(renderAssistantSettingsSection(guarded, 'research')), /data-action="settings\.research-reset"[^>]*disabled/);
});
