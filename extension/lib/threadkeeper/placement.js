/*
 * Where synced chats go (pure). planPlacement(payloads, prefs, library, memory, { origin, target }) →
 *   { ensureCollections: [{ key, name, parentKey?, parentId? }],      // passed to upsertChats({ ensureCollections })
 *     byThreadKey: { [threadKey]: { collectionId } | { collectionKey } },
 *     remember: { [memoryKey]: collectionId },                       // existing collections the plan matched
 *     memoryKeys: { [ensureKey]: memoryKey } }                        // what to remember once an ensured key has an id
 *
 * - mirror (default): a top-level parent named prefs.parentName (the remembered id while it is live, else a live top-level
 *   collection with that name, else created), and inside it one collection per Threadkeeper project (remembered id,
 *   else — with matchExisting — a live top-level collection with the project's name, else a live child of the parent
 *   with that name, else created). Unfiled threads go to the parent itself.
 * - single: prefs.singleCollectionId while it is live, else the Inbox.  - inbox: the Inbox ('').
 * - A manual target ({ collectionId } or { collectionName }) wins for origins 'manual' and 'assistant'.
 * memory = state.collections: { [projectNameLower]: collectionId, __parent: collectionId }.
 */
export const PARENT_MEMORY = '__parent';
const UNFILED = new Set(['', 'unfiled', 'unfiled / uncertain', 'uncertain', 'inbox']);
const fold = value => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '');
export const isUnfiledProject = name => UNFILED.has(fold(name));
const projectKey = name => `project:${fold(name)}`;

/** Live collections of a library. */
const liveCollections = library => (Array.isArray(library?.collections) ? library.collections : [])
  .filter(collection => collection && typeof collection.id === 'string' && !collection.deletedAt);

function index(library) {
  const live = liveCollections(library);
  const byId = new Map(live.map(collection => [collection.id, collection]));
  const named = (name, parentId = '') => live.find(collection => (collection.parentId || '') === parentId && fold(collection.name) === fold(name)) || null;
  return { byId, named };
}

/** A target from a manual send or import, resolved against the library: { collectionId } or an ensure entry. */
export function resolveTarget(target, library) {
  if (!target || typeof target !== 'object') return null;
  const { byId, named } = index(library);
  if (typeof target.collectionId === 'string') return { collectionId: byId.has(target.collectionId) ? target.collectionId : '' };
  const name = typeof target.collectionName === 'string' ? target.collectionName.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
  if (!name) return null;
  const found = named(name);
  return found ? { collectionId: found.id } : { ensure: { key: `target:${fold(name)}`, name } };
}

export function planPlacement(payloads, prefs = {}, library = {}, memory = {}, { origin = 'sync', target = null } = {}) {
  const ensureCollections = [], byThreadKey = {}, remember = {}, memoryKeys = {};
  const ensured = new Set();
  const ensure = (entry, memoryKey) => {
    if (!ensured.has(entry.key)) { ensured.add(entry.key); ensureCollections.push(entry); }
    if (memoryKey) memoryKeys[entry.key] = memoryKey;
    return { collectionKey: entry.key };
  };
  const threads = (Array.isArray(payloads) ? payloads : []).filter(payload => typeof payload?.threadKey === 'string');

  if (['manual', 'assistant'].includes(origin)) {
    const resolved = resolveTarget(target, library);
    if (resolved) {
      const place = resolved.ensure ? ensure(resolved.ensure) : { collectionId: resolved.collectionId };
      for (const payload of threads) byThreadKey[payload.threadKey] = place;
      return { ensureCollections, byThreadKey, remember, memoryKeys };
    }
  }
  const { byId, named } = index(library);
  const placement = prefs.placement || 'mirror';
  if (placement === 'inbox' || placement === 'single') {
    const collectionId = placement === 'single' && byId.has(prefs.singleCollectionId) ? prefs.singleCollectionId : '';
    for (const payload of threads) byThreadKey[payload.threadKey] = { collectionId };
    return { ensureCollections, byThreadKey, remember, memoryKeys };
  }

  // mirror
  let parent = null;
  const parentPlace = () => {
    if (parent) return parent;
    const remembered = memory?.[PARENT_MEMORY];
    const live = remembered && byId.get(remembered);
    if (live && !live.parentId) parent = { collectionId: live.id };
    else {
      const found = named(prefs.parentName || 'AI chats');
      if (found) { parent = { collectionId: found.id }; remember[PARENT_MEMORY] = found.id; }
      else parent = ensure({ key: 'parent', name: prefs.parentName || 'AI chats' }, PARENT_MEMORY);
    }
    return parent;
  };
  const projects = new Map();
  for (const payload of threads) {
    const project = typeof payload.project === 'string' ? payload.project.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
    if (isUnfiledProject(project)) { byThreadKey[payload.threadKey] = parentPlace(); continue; }
    const key = fold(project);
    if (!projects.has(key)) {
      const remembered = memory?.[key];
      let place = null;
      if (remembered && byId.has(remembered)) place = { collectionId: remembered };
      if (!place && prefs.matchExisting !== false) {
        const top = named(project);
        if (top) { place = { collectionId: top.id }; remember[key] = top.id; }
      }
      if (!place) {
        const outer = parentPlace();
        const child = outer.collectionId ? named(project, outer.collectionId) : null;
        if (child) { place = { collectionId: child.id }; remember[key] = child.id; }
        else place = ensure({ key: projectKey(project), name: project, ...(outer.collectionId ? { parentId: outer.collectionId } : { parentKey: outer.collectionKey }) }, key);
      }
      projects.set(key, place);
    }
    byThreadKey[payload.threadKey] = projects.get(key);
  }
  return { ensureCollections, byThreadKey, remember, memoryKeys };
}
