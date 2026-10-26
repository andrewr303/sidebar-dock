const text = value => typeof value === 'string' ? value : '';
const active = item => item && typeof item === 'object' && !item.deletedAt && !item.archived;

/** Include the requested collection once and walk existing children without cycling. */
export function getDescendantCollectionIds(library, id) {
  if (typeof id !== 'string') return [];
  if (!id) return [''];
  const children = new Map();
  for (const collection of library?.collections || []) {
    if (!collection || collection.deletedAt || !text(collection.id)) continue;
    const parentId = text(collection.parentId);
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(collection.id);
  }
  const result = [id], seen = new Set(result);
  for (let index = 0; index < result.length; index++) {
    for (const childId of children.get(result[index]) || []) {
      if (seen.has(childId)) continue;
      seen.add(childId); result.push(childId);
    }
  }
  return result;
}

/** An exact context boundary; unresolved spaces never fall back to the whole library. */
export function buildSpaceContext(library, key) {
  let collection;
  if (key !== 'inbox') {
    if (typeof key !== 'string' || !key.startsWith('space:') || !key.slice(6)) return null;
    collection = (library?.collections || []).find(entry => entry && entry.id === key.slice(6) && !entry.deletedAt);
    if (!collection) return null;
  }
  const id = collection ? collection.id : '';
  const collectionIds = collection ? getDescendantCollectionIds(library, id) : [''];
  const admitted = new Set(collectionIds);
  let itemCount = 0, noteCount = 0, fileCount = 0, sourceCount = 0;
  for (const item of library?.items || []) {
    if (!active(item) || !admitted.has(text(item.collectionId))) continue;
    itemCount++;
    if (item.type === 'note') noteCount++;
    else if (['file', 'image', 'video'].includes(item.type)) fileCount++;
    else if (['bookmark', 'article'].includes(item.type)) sourceCount++;
  }
  return {
    key, id, kind: collection ? 'collection' : 'inbox', name: collection ? text(collection.name) : 'Inbox',
    description: text(collection?.description).slice(0, 12000), cover: text(collection?.cover),
    color: text(collection?.color), icon: text(collection?.icon) || 'folder',
    updatedAt: text(collection ? collection.updatedAt : library?.updatedAt),
    collectionIds, itemCount, noteCount, fileCount, sourceCount,
  };
}

/** Visualize explicit links only, using the caller's already scoped item set. */
export function buildRelationshipGraph(items, { limit = 60 } = {}) {
  const maximum = Number.isFinite(limit) ? Math.max(0, Math.min(1000, Math.floor(limit))) : 60;
  const byId = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (active(item) && text(item.id) && !byId.has(item.id)) byId.set(item.id, item);
  }
  const allEdges = new Map(), connected = new Set();
  for (const item of byId.values()) {
    for (const target of Array.isArray(item.relatedIds) ? item.relatedIds : []) {
      if (target === item.id || !byId.has(target)) continue;
      const pair = item.id < target ? [item.id, target] : [target, item.id];
      const key = JSON.stringify(pair), existing = allEdges.get(key);
      if (existing) {
        if (existing.source === target && existing.target === item.id) existing.bidirectional = true;
      } else allEdges.set(key, { source: item.id, target, bidirectional: false });
      connected.add(item.id); connected.add(target);
    }
  }
  // Stable linear partition keeps connected content ahead of unlinked records.
  const ordered = [], orphans = [];
  for (const item of byId.values()) (connected.has(item.id) ? ordered : orphans).push(item);
  const selected = ordered.concat(orphans).slice(0, maximum), admitted = new Set(selected.map(item => item.id));
  const edges = [], degrees = new Map(selected.map(item => [item.id, 0]));
  for (const edge of allEdges.values()) {
    if (!admitted.has(edge.source) || !admitted.has(edge.target)) continue;
    edges.push(edge); degrees.set(edge.source, degrees.get(edge.source) + 1); degrees.set(edge.target, degrees.get(edge.target) + 1);
  }
  const columns = Math.max(1, Math.ceil(Math.sqrt(selected.length * 920 / 580)));
  const rows = Math.max(1, Math.ceil(selected.length / columns));
  const nodes = selected.map((item, index) => ({
    id: item.id, title: text(item.title) || 'Untitled item', type: text(item.type), collectionId: text(item.collectionId), degree: degrees.get(item.id),
    x: columns === 1 ? 460 : Math.round(60 + (index % columns) * 800 / (columns - 1)),
    y: rows === 1 ? 290 : Math.round(50 + Math.floor(index / columns) * 480 / (rows - 1)),
  }));
  return { nodes, edges, totalItems: byId.size, truncated: selected.length < byId.size };
}
