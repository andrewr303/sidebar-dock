// Settings > Assistant permissions and Settings > Research agent. Both write device-only AI settings (lib/ai/connections.js
// keeps them out of backups): assistantPermissions, the kinds of change the assistant applies without review
// (lib/ai/permissions.js), and research, how Research with AI runs. ui/settings.js loads the values, registers the actions
// (it owns setAi) and frames these sections in both the full page and the side panel.
import { html } from '../html.js';
import { segmented, select, button, badge } from '../components.js';
import { PERMISSION_CATEGORIES, normalizePermissions, presetOf } from '../../lib/ai/permissions.js';
import { RESEARCH_LIMITS } from '../../lib/ai/research/settings.js';
import { group, card, row, switchRow, note, isSearching, isBusy } from './parts.js';

/* ------------------------------------------------------------------ Assistant permissions */

export const PERMISSION_PRESET_CHOICES = Object.freeze([
  { value: 'ask', label: 'Always ask' }, { value: 'trusted', label: 'Trusted' }, { value: 'full', label: 'Full access' }, { value: 'custom', label: 'Custom' },
]);
const PRESET_TEXT = {
  ask: 'Every change waits on a card until you choose Apply or Discard.',
  trusted: 'Changes apply right away, except deleting: moving to Trash and deleting collections and tags still ask.',
  full: 'Every change applies right away, deleting included.',
  custom: 'Your own mix, set for each kind of change below.',
};
const LEVEL_CHOICES = [{ value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }];
// Words people search for that the rows do not say.
const CATEGORY_KEYWORDS = { create: 'add new save links bookmarks notes collections folders', organize: 'move tag tags favorite archive restore link folders',
  edit: 'rename change title note text description', dashboard: 'widget board new tab', delete: 'trash remove delete collection tag' };

/** Settings > Assistant permissions: the preset, then Ask or Allow for each kind of change. */
export function renderAssistantPermissions(ctx, { permissions } = {}) {
  const levels = normalizePermissions(permissions);
  const preset = presetOf(levels);
  return html`
    ${group({ title: 'Changes without asking', keywords: 'permissions approve approval review auto apply automatic undo',
      description: 'Choose which changes the assistant makes right away. Everything else waits on a card for you to apply or discard. Changes made right away show in the chat with Undo.',
      body: () => card([
        // Stacked: four choices fit better under the description than beside it.
        row({ label: 'Permission level', id: 'settings-permission-level', stacked: true, keywords: 'preset always ask trusted full access custom', description: PRESET_TEXT[preset],
          control: segmented({ name: 'preset', value: preset, options: PERMISSION_PRESET_CHOICES, action: 'settings.ai-permission-preset', ariaLabel: 'Permission level', size: 'sm' }) }),
        ...PERMISSION_CATEGORIES.map(category => row({ label: category.label, id: `settings-permission-${category.id}`, keywords: CATEGORY_KEYWORDS[category.id],
          description: category.id === 'delete' && levels.delete === 'allow' ? `${category.hint}. Items in Trash can be restored, and Undo brings deleted collections and tags back.` : category.hint,
          control: segmented({ name: category.id, value: levels[category.id], options: LEVEL_CHOICES, action: 'settings.ai-permission', ariaLabel: `${category.label} changes`, size: 'sm' }) })),
      ]) })}
    ${isSearching() ? '' : html`
      ${note('info', 'Adding links to folders uses Create and Organize. A request that mixes kinds you allow with kinds that ask waits for your review as a whole.')}
      ${note('shield-check', 'Pages and saved items can contain text meant to steer the assistant. It is told to ignore such text, but changes made without review give it more room, so keeping Delete on Ask is safest.')}
      ${note('lock', 'These permissions stay on this device. Backups never include them, and restoring a file never changes them.')}`}`;
}

/* ------------------------------------------------------------------ Research agent */

export const RESEARCH_MODEL_LABEL = 'Claude Sonnet 5.5';
export const RESEARCH_DEPTH_CHOICES = Object.freeze([{ value: 'quick', label: 'Quick' }, { value: 'standard', label: 'Standard' }, { value: 'deep', label: 'Deep' }]);
const DEPTH_TEXT = {
  quick: 'About 5 web searches. The fastest and cheapest run.',
  standard: 'About 12 web searches, reading the best sources.',
  deep: 'About 25 web searches and more sources read. Slower, and costs more.',
};
export const RESEARCH_GITHUB_CHOICES = Object.freeze([{ value: 'auto', label: 'Automatic for tech topics' }, { value: 'always', label: 'Always' }, { value: 'off', label: 'Off' }]);
// The ranges lib/ai/research/settings.js accepts (RESEARCH_LIMITS: subpages 0 to 12, cap $1 to $50); connections.js refuses others.
export const RESEARCH_SUBPAGE_CHOICES = Object.freeze(Array.from({ length: RESEARCH_LIMITS.maxSubpages + 1 }, (_, n) => ({ value: String(n), label: n ? String(n) : 'None' })));
export const RESEARCH_BUDGET_CHOICES = Object.freeze([1, 2, 3, 5, 10, 15, 20, 30, 50]
  .filter(usd => usd >= RESEARCH_LIMITS.minBudgetUsd && usd <= RESEARCH_LIMITS.maxBudgetUsd).map(usd => ({ value: String(usd), label: `$${usd}` })));
// Fields the research select and segmented controls may write, with how each value is read from the control.
const RESEARCH_FIELDS = { connectionId: String, depth: String, github: String, maxSubpages: Number, budgetUsd: Number };

/** Direct Anthropic connections with an API key: the only ones that can run Managed Agents sessions. */
export function researchConnections(connections = [], selectedId = '') {
  const chosen = typeof selectedId === 'string' ? selectedId : '';
  return (Array.isArray(connections) ? connections : [])
    .filter(c => c?.via === 'direct' && c.providerId === 'anthropic' && c.hasKey && (c.enabled !== false || (chosen && c.id === chosen)));
}

/** The research settings patch for one control ({ [field]: value }), or null for a field this section does not write. */
export function researchPatch(name, value) {
  if (typeof name !== 'string' || !Object.hasOwn(RESEARCH_FIELDS, name)) return null;
  return { [name]: RESEARCH_FIELDS[name](value ?? '') };
}

// A stored value the list no longer offers (a removed connection, a cap set elsewhere) stays visible instead of jumping.
const withCurrent = (options, value, label) => (options.some(option => option.value === value) ? options : [...options, { value, label }]);

/**
 * Settings > Research agent. research: the AI setting (defaults filled in); connections: listConnections();
 * canReset: whether this build exposes resetResearchProvisioning.
 */
export function renderResearch(ctx, { research = {}, connections = [], canReset = false } = {}) {
  const connectionId = String(research.connectionId || '');
  const anthropic = researchConnections(connections, connectionId);
  const budget = String(research.budgetUsd ?? '');
  const subpages = String(research.maxSubpages ?? '');
  const connectionOptions = withCurrent([{ value: '', label: 'Automatic' }, ...anthropic.map(c => ({ value: c.id, label: c.enabled === false ? `${c.label} (off — will use default)` : c.label }))],
    connectionId, 'Removed connection (not available)');
  return html`
    ${group({ title: 'Research with AI', keywords: 'research agent expand web search fetch github managed agents',
      description: 'Reads a saved page, searches the web and GitHub, and writes what it finds into the page with links to its sources.',
      body: () => card([
        switchRow({ label: 'Offer Research with AI', keywords: 'on off enable turn', description: 'Shows Research with AI on saved pages and notes.',
          checked: research.enabled !== false, action: 'settings.research-flag', data: { key: 'enabled' } }),
        row({ label: 'Connection', id: 'settings-research-connection', keywords: 'anthropic api key account billing',
          description: anthropic.length ? 'The Anthropic API key research runs on. Automatic uses your chat connection when it is an Anthropic key, else the first Anthropic key.'
            : 'Research needs an Anthropic API key. Keys from the local bridge, Claude Code or other providers cannot run it.',
          control: anthropic.length ? select({ name: 'connectionId', value: connectionId, label: 'Research connection', action: 'settings.research', className: 'settings-select', options: connectionOptions })
            : button({ label: 'Add Anthropic key', icon: 'plus', size: 'sm', action: 'settings.connect-open', data: { provider: 'anthropic' } }) }),
        row({ label: 'Model', keywords: 'claude sonnet', description: `Research always uses ${RESEARCH_MODEL_LABEL} with web search and web fetch.`,
          control: badge({ label: RESEARCH_MODEL_LABEL, icon: 'sparkles' }) }),
        row({ label: 'Depth', keywords: 'quick standard deep searches effort', description: DEPTH_TEXT[research.depth] || DEPTH_TEXT.standard,
          control: segmented({ name: 'depth', value: research.depth, options: RESEARCH_DEPTH_CHOICES, action: 'settings.research', ariaLabel: 'Research depth', size: 'sm' }) }),
        row({ label: 'GitHub research', keywords: 'github repositories code issues', description: 'Searches repositories, code and issues for software and tech topics. Uses your connected GitHub account when there is one, else GitHub’s public limits.',
          control: select({ name: 'github', value: research.github, label: 'GitHub research', action: 'settings.research', className: 'settings-select', options: RESEARCH_GITHUB_CHOICES }) }),
        row({ label: 'Subpages per run', keywords: 'maximum max pages child', description: 'Research keeps its findings in one section of the page and adds subpages only when there is a lot to cover.',
          control: select({ name: 'maxSubpages', value: subpages, label: 'Subpages per run', action: 'settings.research', className: 'settings-select is-narrow',
            options: withCurrent(RESEARCH_SUBPAGE_CHOICES, subpages, subpages) }) }),
        row({ label: 'Spending cap per run', keywords: 'budget cost price usd dollars limit', description: 'A run pauses when its cost reaches this amount, billed to your Anthropic account. You can raise the cap from the paused run to let it finish.',
          control: select({ name: 'budgetUsd', value: budget, label: 'Spending cap per run', action: 'settings.research', className: 'settings-select is-narrow',
            options: withCurrent(RESEARCH_BUDGET_CHOICES, budget, `$${budget}`) }) }),
        switchRow({ label: 'Allow editing the original', keywords: 'rewrite change saved text article note',
          description: 'Off keeps the text you saved exactly as it is: research only adds its own section and subpages. On lets research rewrite the original when you ask it to, and Undo research changes puts it back.',
          checked: research.allowOriginalEdits === true, action: 'settings.research-flag', data: { key: 'allowOriginalEdits' } }),
        row({ label: 'Reset research agent', keywords: 'reset provisioning environment',
          description: 'Still sets up a research agent and environment in your Anthropic account on the first run. Reset makes the next run set them up again. Nothing is deleted from your account.',
          control: button({ label: 'Reset', icon: 'rotate-ccw', size: 'sm', variant: 'secondary', action: 'settings.research-reset', disabled: !canReset, loading: isBusy('research-reset') }) }),
      ]) })}
    ${isSearching() ? '' : html`
      ${note('info', 'Research runs as an Anthropic Managed Agents session. The session, with the page text and what the agent finds, is stored in your Anthropic account, and its cost is billed to your API key.')}
      ${note('lock', 'These settings stay on this device. Backups never include them.')}`}`;
}
