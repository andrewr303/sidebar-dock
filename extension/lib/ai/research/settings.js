// Research agent settings: the defaults and validation for AI settings `research` (lib/ai/connections.js merges them into
// DEFAULT_AI_SETTINGS and keeps them out of backups). Pure and dependency-free, because connections.js imports this file:
// importing anything from lib/ai here would create a cycle.

export const RESEARCH_DEPTHS = Object.freeze(['quick', 'standard', 'deep']);
export const RESEARCH_GITHUB_MODES = Object.freeze(['auto', 'always', 'off']);
export const RESEARCH_LIMITS = Object.freeze({ maxSubpages: 12, minBudgetUsd: 1, maxBudgetUsd: 50, maxRaiseUsd: 100 });
// A running research whose driving page has not saved a heartbeat for this long is stale: another view offers to Resume
// it (ui/research-view.js) and the engine lets that view take it over (run.js RESEARCH_TIMING.staleMs).
export const RESEARCH_STALE_MS = 30000;

export const RESEARCH_DEFAULTS = Object.freeze({
  enabled: true,
  connectionId: '',
  github: 'auto',
  depth: 'standard',
  maxSubpages: 6,
  budgetUsd: 5,
  allowOriginalEdits: false,
});

// Effort travels on the session's model override (agent_with_overrides): a quick run thinks less and costs less.
const EFFORT_BY_DEPTH = Object.freeze({ quick: 'low', standard: 'medium', deep: 'high' });
// Web tools have no max_uses in Managed Agents, so these caps live in the prompt (the session budget is the hard stop).
const SEARCHES_BY_DEPTH = Object.freeze({ quick: 5, standard: 12, deep: 25 });

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Coerces anything into a complete, valid research settings object; unknown or invalid values fall back to the defaults. */
export function normalizeResearchSettings(value) {
  const input = isObject(value) ? value : {};
  const number = (key, min, max, round) => {
    const raw = typeof input[key] === 'string' && input[key].trim() ? Number(input[key]) : input[key];
    return Number.isFinite(raw) ? clamp(round(raw), min, max) : RESEARCH_DEFAULTS[key];
  };
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : RESEARCH_DEFAULTS.enabled,
    connectionId: typeof input.connectionId === 'string' ? input.connectionId.trim().slice(0, 200) : RESEARCH_DEFAULTS.connectionId,
    github: RESEARCH_GITHUB_MODES.includes(input.github) ? input.github : RESEARCH_DEFAULTS.github,
    depth: RESEARCH_DEPTHS.includes(input.depth) ? input.depth : RESEARCH_DEFAULTS.depth,
    maxSubpages: number('maxSubpages', 0, RESEARCH_LIMITS.maxSubpages, Math.round),
    // Whole cents: the wire amount is an integer string.
    budgetUsd: number('budgetUsd', RESEARCH_LIMITS.minBudgetUsd, RESEARCH_LIMITS.maxBudgetUsd, v => Math.round(v * 100) / 100),
    allowOriginalEdits: input.allowOriginalEdits === true,
  };
}

/** The session budget on the wire: a hard spend cap in whole US cents, as an integer string. */
export function budgetFor(budgetUsd) {
  const usd = Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : RESEARCH_DEFAULTS.budgetUsd;
  return { type: 'limit', max_list_cost: { amount: String(Math.max(1, Math.round(usd * 100))), currency: 'USD' } };
}

export const effortFor = depth => EFFORT_BY_DEPTH[depth] || EFFORT_BY_DEPTH[RESEARCH_DEFAULTS.depth];
export const searchesFor = depth => SEARCHES_BY_DEPTH[depth] || SEARCHES_BY_DEPTH[RESEARCH_DEFAULTS.depth];
