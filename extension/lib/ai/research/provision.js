// Which Anthropic connection research uses, and the device-local record of the agent and environment it created there.
//
// The record lives in chrome.storage.local['still.ai.research.v1'] (localStorage in the preview), keyed by connection
// and workspace, because agents and environments belong to a workspace: { version: 1, byConnection: { '<connectionId>|
// <workspaceId>': { agentId, agentVersion, specHash, environmentId, createdAt, updatedAt } } }. It is never part of a
// backup or export (it names resources in one person's Anthropic account); snapshots may hold it. Remote resources are
// never archived or deleted from here: "Reset research agent" only forgets the local record, and the next run creates
// fresh ones.

import { aiError } from '../http.js';
import { isOfficialHost } from '../transports/anthropic.js';
import { agentBody, environmentBody, specHash } from './agent-config.js';

export const RESEARCH_STORE_KEY = 'still.ai.research.v1';
export const RESEARCH_STORE_VERSION = 1;
const LOCK_NAME = 'still.ai.research.v1';

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const nowIso = () => new Date().toISOString();

/** chrome.storage.local when available, else localStorage (the preview), else memory: { get(key), set(key, value) }. */
export function defaultResearchStorage() {
  const local = globalThis.chrome?.storage?.local;
  if (local) return { get: async key => (await local.get(key))?.[key], set: (key, value) => local.set({ [key]: value }) };
  if (globalThis.localStorage) return {
    get: async key => { const raw = globalThis.localStorage.getItem(key); if (raw === null) return undefined; try { return JSON.parse(raw); } catch { return undefined; } },
    set: async (key, value) => globalThis.localStorage.setItem(key, JSON.stringify(value)),
  };
  const map = new Map();
  return { get: async key => structuredClone(map.get(key)), set: async (key, value) => { map.set(key, structuredClone(value)); } };
}

// One writer at a time across views (side panel, tabs); without Web Locks (tests, old browsers) this view's queue.
let queue = Promise.resolve();
function exclusive(locks, task) {
  const run = queue.then(() => typeof locks?.request === 'function' ? locks.request(LOCK_NAME, () => task()) : task());
  queue = run.catch(() => {});
  return run;
}

async function readState(storage) {
  const value = await storage.get(RESEARCH_STORE_KEY);
  if (value === undefined || value === null) return { version: RESEARCH_STORE_VERSION, byConnection: {} };
  // A newer build's record is left alone: provisioning again here would create duplicate agents it cannot see.
  if (!isObject(value) || Number(value.version) > RESEARCH_STORE_VERSION) {
    throw aiError('Research was set up by a newer version of Still. Update Still to run research here.', { code: 'newer_version' });
  }
  return { ...value, version: RESEARCH_STORE_VERSION, byConnection: isObject(value.byConnection) ? value.byConnection : {} };
}

/** The record key for a resolved connection: agents and environments are scoped to a workspace. */
export const provisionKey = resolved => `${resolved?.connection?.id || ''}|${resolved?.connection?.workspaceId || ''}`;

/** The stored record for a resolved connection, or null. */
export async function readProvisioning(resolved, { storage = defaultResearchStorage() } = {}) {
  const state = await readState(storage);
  const record = state.byConnection[provisionKey(resolved)];
  return isObject(record) ? structuredClone(record) : null;
}

const missing = error => error?.status === 404 || error?.code === 'not_found';
// An archived agent rejects updates and new sessions; it is replaced, never unarchived (that does not exist).
const archived = error => error?.status === 400 && /archiv/i.test(`${error?.detail || ''} ${error?.message || ''}`);

/**
 * Makes sure the research environment and agent exist for this connection and that the agent runs the current spec.
 * resolved: { connection, apiKey, baseUrl } from resolveConnection; client: createManagedClient(...). The first run
 * creates both; a changed spec updates the agent in place (POST /v1/agents/{id} with the stored version; a 409 re-reads
 * the version and retries once); a missing or archived agent is created again. verify: true (after a session create
 * failed with 404) re-reads both resources and recreates whichever is gone. Resolves the record.
 */
export function ensureProvisioned({ resolved, client, storage = defaultResearchStorage(), locks = globalThis.navigator?.locks, now = nowIso, verify = false }) {
  return exclusive(locks, async () => {
    const state = await readState(storage);
    const key = provisionKey(resolved);
    const record = isObject(state.byConnection[key]) ? { ...state.byConnection[key] } : {};
    const hash = specHash();
    // Saved after every creation, so a failure halfway never orphans a resource this device forgets.
    const save = async () => {
      record.createdAt ||= now();
      record.updatedAt = now();
      state.byConnection[key] = { ...record };
      await storage.set(RESEARCH_STORE_KEY, { ...state, version: RESEARCH_STORE_VERSION });
    };

    if (record.environmentId && verify) {
      try { const environment = await client.getEnvironment(record.environmentId); if (environment?.archived_at) delete record.environmentId; }
      catch (error) { if (missing(error)) delete record.environmentId; else throw error; }
    }
    if (!record.environmentId) {
      const environment = await client.createEnvironment(environmentBody());
      if (!environment?.id) throw aiError('Anthropic did not return a research environment.', { code: 'bad_response' });
      record.environmentId = environment.id;
      await save();
    }

    if (record.agentId && verify) {
      try {
        const agent = await client.getAgent(record.agentId);
        if (agent?.archived_at) delete record.agentId;
        else if (Number.isInteger(agent?.version)) record.agentVersion = agent.version;
      } catch (error) { if (missing(error)) delete record.agentId; else throw error; }
    }
    const create = async () => {
      const agent = await client.createAgent(agentBody());
      if (!agent?.id) throw aiError('Anthropic did not return a research agent.', { code: 'bad_response' });
      Object.assign(record, { agentId: agent.id, agentVersion: agent.version, specHash: hash });
      await save();
    };
    if (!record.agentId) await create();
    else if (record.specHash !== hash) {
      let agent = null;
      try {
        agent = await client.updateAgent(record.agentId, agentBody(), { version: record.agentVersion });
      } catch (error) {
        if (missing(error) || archived(error)) { await create(); return structuredClone(record); }
        if (error?.status !== 409) throw error;
        // Someone else (another device on the same key) updated it first: retry once against the current version.
        const current = await client.getAgent(record.agentId);
        agent = await client.updateAgent(record.agentId, agentBody(), { version: current?.version });
      }
      Object.assign(record, { agentVersion: Number.isInteger(agent?.version) ? agent.version : record.agentVersion, specHash: hash });
      await save();
    }
    return structuredClone(record);
  });
}

/** Forgets this device's research agent and environment ids (every connection). Remote resources stay untouched. */
export function resetResearchProvisioning({ storage = defaultResearchStorage(), locks = globalThis.navigator?.locks } = {}) {
  return exclusive(locks, async () => {
    const value = await storage.get(RESEARCH_STORE_KEY);
    if (isObject(value) && Number(value.version) > RESEARCH_STORE_VERSION) throw aiError('Research was set up by a newer version of Still. Update Still to reset it.', { code: 'newer_version' });
    await storage.set(RESEARCH_STORE_KEY, { version: RESEARCH_STORE_VERSION, byConnection: {} });
    return { reset: true };
  });
}

/**
 * True for a connection research can run on: a direct, enabled Anthropic connection to api.anthropic.com with a key.
 * Bridge, CLI and Anthropic-compatible connections cannot reach the Managed Agents API.
 */
export const isResearchConnection = connection => !!connection && connection.via === 'direct' && connection.providerId === 'anthropic'
  && connection.enabled !== false && connection.hasKey === true && isOfficialHost(connection.baseUrl || 'https://api.anthropic.com/v1');

/**
 * The connection research would use, from listConnections() output and the AI settings: settings.research.connectionId,
 * else the chat connection when it is a direct Anthropic one, else the first enabled direct Anthropic connection with a
 * key. null when there is none.
 */
export function pickResearchConnection(connections, settings = {}) {
  const list = (Array.isArray(connections) ? connections : []).filter(isObject);
  const byId = id => typeof id === 'string' && id ? list.find(entry => entry.id === id) : null;
  return [settings?.research?.connectionId, settings?.chat?.connectionId].map(byId).find(isResearchConnection) || list.find(isResearchConnection) || null;
}

/**
 * Resolves the connection research uses (pickResearchConnection) to resolveConnection's { connection, provider, apiKey,
 * baseUrl }. Rejects with code 'no_research_connection' when there is none.
 */
export async function resolveResearchConnection({ settings = {}, listConnections, resolveConnection }) {
  const chosen = pickResearchConnection(await listConnections(), settings);
  if (!chosen) throw aiError('Add an Anthropic API key in AI settings to use research. Research runs on Claude Managed Agents, which needs a direct Anthropic connection.', { code: 'no_research_connection' });
  return resolveConnection(chosen.id);
}
