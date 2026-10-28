// Library tools for the assistant. Read tools run immediately. Write tools never run on their own: every write call in a
// model step is validated, staged into ONE proposal per assistant turn, shown to the user through onProposal(), and
// applied through the store only when the user answers 'apply'. Tool results tell the model exactly what happened.
import { getDescendantCollectionIds } from '../library-views.js';
import { plainText } from './search.js';

export const ITEM_TYPES = ['bookmark', 'article', 'image', 'video', 'file', 'note'];
export const MAX_ITEMS_PER_CHANGE = 500;
const MAX_TAGS = 20;
const NEW_PREFIX = 'new:';

const text = value => typeof value === 'string' ? value : '';
const uidDefault = prefix => `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const quote = value => `“${text(value).replace(/\s+/g, ' ').trim().slice(0, 80)}”`;
const clampInt = (value, min, max, fallback) => Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const ids = description => ({ type: 'array', items: { type: 'string' }, description });
const PROPOSE = 'Changes are applied only after the user approves them.';

export const LIBRARY_TOOLS = Object.freeze([
  { name: 'search_library', access: 'read', description: 'Search the user’s saved library (links, articles, notes, highlights and files) with combined keyword and semantic matching. The query understands tag:name, #name, type:note and "quoted phrases". Returns item ids, titles, collection paths, tags and a matching snippet. Read full text with get_items.',
    inputSchema: schema({
      query: { type: 'string', description: 'What to look for, in natural language or keywords.' },
      type: { type: 'string', enum: ITEM_TYPES, description: 'Only items of this type.' },
      collectionId: { type: 'string', description: 'Only items in this collection and its sub-collections. Use "inbox" for unsorted items.' },
      tag: { type: 'string', description: 'Only items with this tag.' },
      limit: { type: 'integer', description: 'Maximum results, 1 to 50. Default 12.' },
    }, ['query']) },
  { name: 'get_items', access: 'read', description: 'Read saved items in full by id: description, the user’s note, captured article text, highlights, tags, collection and linked item ids. Up to 20 ids per call.',
    inputSchema: schema({ ids: ids('Item ids from search results or earlier tool results.') }, ['ids']) },
  { name: 'list_collections', access: 'read', description: 'List the user’s collections with ids, nested paths (Parent › Child) and item counts.', inputSchema: schema({}) },
  { name: 'list_tags', access: 'read', description: 'List tags used in the library with item counts, most used first.', inputSchema: schema({}) },
  { name: 'get_page', access: 'read', description: 'Read the web page the user is viewing now: title, URL and readable text.', inputSchema: schema({}) },
  { name: 'create_collection', access: 'write', description: `Propose a new collection. parentId nests it under an existing collection id, or under "new:<name>" for a collection proposed in the same step. Returns the id it will have. ${PROPOSE}`,
    inputSchema: schema({
      name: { type: 'string', description: 'Collection name.' },
      parentId: { type: 'string', description: 'Parent collection id, "new:<name>", or "" for top level.' },
      icon: { type: 'string', description: 'Optional icon name such as folder, book, sparkles, globe, star.' },
      color: { type: 'string', description: 'Optional #hex color.' },
    }, ['name']) },
  { name: 'move_items', access: 'write', description: `Propose moving items into a collection. collectionId is an existing collection id, "" for Inbox, or "new:<name>" for a collection proposed in the same step. ${PROPOSE}`,
    inputSchema: schema({ ids: ids('Item ids to move (up to 500).'), collectionId: { type: 'string', description: 'Target collection id, "" for Inbox, or "new:<name>".' } }, ['ids', 'collectionId']) },
  { name: 'add_tags', access: 'write', description: `Propose adding tags to items. Prefer tags that already exist (list_tags). ${PROPOSE}`,
    inputSchema: schema({ ids: ids('Item ids (up to 500).'), tags: { type: 'array', items: { type: 'string' }, description: 'Tags to add, without #.' } }, ['ids', 'tags']) },
  { name: 'remove_tags', access: 'write', description: `Propose removing tags from items. ${PROPOSE}`,
    inputSchema: schema({ ids: ids('Item ids (up to 500).'), tags: { type: 'array', items: { type: 'string' }, description: 'Tags to remove, without #.' } }, ['ids', 'tags']) },
  { name: 'set_favorite', access: 'write', description: `Propose marking items as favorites, or removing them from favorites. ${PROPOSE}`,
    inputSchema: schema({ ids: ids('Item ids (up to 500).'), favorite: { type: 'boolean', description: 'true to add to favorites, false to remove.' } }, ['ids', 'favorite']) },
  { name: 'archive_items', access: 'write', description: `Propose archiving items. Only when the user asks to archive. ${PROPOSE}`,
    inputSchema: schema({ ids: ids('Item ids (up to 500).') }, ['ids']) },
  { name: 'trash_items', access: 'write', description: `Propose moving items to Trash (recoverable). Only when the user explicitly asks to delete or trash them. ${PROPOSE}`,
    inputSchema: schema({ ids: ids('Item ids (up to 500).') }, ['ids']) },
  { name: 'create_note', access: 'write', description: `Propose a new Markdown note. collectionId is an existing id, "" for Inbox, or "new:<name>"; relatedIds links items; url attaches it to a web page. ${PROPOSE}`,
    inputSchema: schema({
      title: { type: 'string', description: 'Note title.' },
      markdown: { type: 'string', description: 'Note body in Markdown. Cite saved items as [[item_id]].' },
      collectionId: { type: 'string', description: 'Collection id, "" for Inbox, or "new:<name>".' },
      relatedIds: ids('Item ids to link from the note.'),
      url: { type: 'string', description: 'Web page the note is about (http or https).' },
    }, ['title', 'markdown']) },
  { name: 'append_to_note', access: 'write', description: `Propose appending Markdown to the end of an existing note. ${PROPOSE}`,
    inputSchema: schema({ id: { type: 'string', description: 'Note id.' }, markdown: { type: 'string', description: 'Markdown to append.' } }, ['id', 'markdown']) },
  { name: 'update_item', access: 'write', description: `Propose a new title and/or description for an item. ${PROPOSE}`,
    inputSchema: schema({ id: { type: 'string', description: 'Item id.' }, title: { type: 'string', description: 'New title.' }, excerpt: { type: 'string', description: 'New description.' } }, ['id']) },
]);
const TOOL_BY_NAME = new Map(LIBRARY_TOOLS.map(tool => [tool.name, tool]));
export const isWriteTool = name => TOOL_BY_NAME.get(name)?.access === 'write';

/** Normalized tool definitions for streamChat: [{ name, description, inputSchema }]. */
export function toolDefinitions({ write = true, page = false } = {}) {
  return LIBRARY_TOOLS.filter(tool => (write || tool.access === 'read') && (page || tool.name !== 'get_page'))
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema: structuredClone(inputSchema) }));
}

export function collectionPath(library, id) {
  if (!id) return 'Inbox';
  const collections = new Map((library?.collections || []).map(collection => [collection.id, collection]));
  const names = [];
  const seen = new Set();
  for (let current = collections.get(id); current && !seen.has(current.id); current = collections.get(current.parentId)) {
    seen.add(current.id);
    names.unshift(text(current.name) || 'Untitled');
  }
  return names.length ? names.join(' › ') : 'Unknown collection';
}

export function normalizeTags(tags) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = text(raw).trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 100);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out.slice(0, MAX_TAGS);
}
const tagLabel = tags => {
  const names = tags.map(tag => `#${tag}`);
  return `${tags.length === 1 ? 'tag' : 'tags'} ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}`;
};
const safeWebUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; } };
export const noteExcerpt = markdown => { const plain = plainText(markdown); return plain.length > 180 ? `${plain.slice(0, 179).trimEnd()}…` : plain; };

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const lowerSet = tags => new Set((Array.isArray(tags) ? tags : []).map(tag => String(tag).toLowerCase()));

/**
 * Reverts an applied proposal: restores previous item fields, trashes created notes, removes created collections.
 * With getLibrary (the normal case) the undo is conflict-aware: a field the user changed again after Apply keeps the
 * user's value, tags added or removed since are kept, items deleted forever are skipped, and a created collection
 * that now holds other items or sub-collections is kept. Without it (the rollback of a failed Apply), every recorded
 * value is restored as is. Returns { reverted, kept } counts.
 */
export async function undoChanges(store, undo, { getLibrary } = {}) {
  if (!undo) return { reverted: 0, kept: 0 };
  const library = typeof getLibrary === 'function' ? await getLibrary() : null;
  if (!library) {
    if (undo.patches?.length) await store.bulkUpdateItems(undo.patches);
    // Rolling back a failed Apply removes the notes it had written outright rather than leaving them in Trash.
    for (const id of undo.createdNotes || []) await (typeof store.permanentlyDeleteItem === 'function' ? store.permanentlyDeleteItem(id) : store.deleteItem(id));
    for (const id of [...(undo.createdCollections || [])].reverse()) await store.deleteCollection(id);
    return { reverted: (undo.patches?.length || 0) + (undo.createdNotes?.length || 0) + (undo.createdCollections?.length || 0), kept: 0 };
  }
  const index = new Map((library.items || []).map(item => [item.id, item]));
  const applied = new Map((Array.isArray(undo.applied) ? undo.applied : []).map(entry => [entry.id, entry.patch || {}]));
  const patches = [];
  let kept = 0;
  for (const { id, patch: before = {} } of undo.patches || []) {
    const current = index.get(id);
    if (!current) { kept++; continue; } // deleted forever since
    const after = applied.get(id);
    const patch = {};
    let edited = false; // the user changed a field this proposal wrote
    for (const [key, value] of Object.entries(before)) {
      if (key === 'excerpt' && 'content' in before) continue; // follows content below
      if (!after || !(key in after)) { patch[key] = value; continue; } // records written before conflict-aware undo
      if (key === 'tags') {
        const afterTags = lowerSet(after.tags);
        const beforeTags = lowerSet(before.tags);
        const tags = (current.tags || []).filter(tag => { const lower = String(tag).toLowerCase(); return !afterTags.has(lower) || beforeTags.has(lower); });
        for (const tag of before.tags || []) if (!afterTags.has(String(tag).toLowerCase()) && !tags.some(t => String(t).toLowerCase() === String(tag).toLowerCase())) tags.push(tag);
        if (!sameValue([...lowerSet(current.tags)].sort(), [...afterTags].sort())) edited = true;
        if (!sameValue(tags, current.tags || [])) patch.tags = tags;
      } else if (sameValue(current[key], after[key])) {
        patch[key] = value;
        if (key === 'content' && 'excerpt' in before) patch.excerpt = before.excerpt;
      } else edited = true;
    }
    if (Object.keys(patch).length) patches.push({ id, patch });
    if (edited) kept++;
  }
  if (patches.length) await store.bulkUpdateItems(patches);
  const notes = new Set(undo.createdNotes || []);
  let reverted = patches.length;
  for (const id of notes) {
    const note = index.get(id);
    if (!note || note.deletedAt) continue;
    await store.deleteItem(id);
    reverted++;
  }
  // Where each item lives once the item patches above are reverted.
  const movedBack = new Map(patches.filter(entry => 'collectionId' in entry.patch).map(entry => [entry.id, entry.patch.collectionId]));
  const created = [...(undo.createdCollections || [])];
  const removing = new Set(created);
  for (const id of [...created].reverse()) {
    if (!(library.collections || []).some(collection => collection.id === id)) { removing.delete(id); continue; }
    const holdsItems = (library.items || []).some(item => !notes.has(item.id) && (movedBack.has(item.id) ? movedBack.get(item.id) : item.collectionId) === id);
    const holdsCollections = (library.collections || []).some(collection => collection.parentId === id && !removing.has(collection.id));
    if (holdsItems || holdsCollections) { removing.delete(id); kept++; continue; }
    await store.deleteCollection(id);
    reverted++;
  }
  return { reverted, kept };
}

/**
 * One assistant turn's tool session.
 * createToolSession({ getLibrary, searchLibrary, store, page, onProposal, onEvent, signal }) -> { definitions, execute(calls), sources, proposals }
 */
export function createToolSession({ getLibrary, searchLibrary, store, page = null, onProposal, onEvent = () => {}, signal, uid = uidDefault, now = () => new Date().toISOString() } = {}) {
  const sources = new Map();
  const proposals = [];
  let proposalUsed = false;
  const remember = (item, library) => { if (item?.id) sources.set(item.id, { id: item.id, title: text(item.title), url: text(item.url), type: text(item.type), collection: collectionPath(library, text(item.collectionId)) }); };
  const summaryOf = item => ({ id: item.id, title: text(item.title) });

  // ---- read tools ----
  const readers = {
    async search_library(input) {
      const query = text(input.query).trim();
      if (!query) throw new Error('Give search_library a query.');
      const filter = {};
      const library = await getLibrary();
      if (ITEM_TYPES.includes(input.type)) filter.type = input.type;
      const wantedCollection = text(input.collectionId).trim();
      if (wantedCollection) {
        // Models often pass a collection's name instead of its id; an unknown one is reported rather than silently empty.
        const collections = library?.collections || [];
        const byName = collections.filter(collection => text(collection.name).toLowerCase() === wantedCollection.toLowerCase());
        if (wantedCollection.toLowerCase() === 'inbox') filter.collectionId = '';
        else if (collections.some(collection => collection.id === wantedCollection)) filter.collectionId = wantedCollection;
        else if (byName.length === 1) filter.collectionId = byName[0].id;
        else throw new Error(`Unknown collection "${wantedCollection.slice(0, 80)}". Use list_collections for collection ids.`);
      }
      if (text(input.tag).trim()) filter.tag = text(input.tag).trim().replace(/^#/, '');
      const results = await searchLibrary(query, { limit: clampInt(input.limit, 1, 50, 12), mode: 'hybrid', filter, signal });
      const index = new Map((library?.items || []).map(item => [item.id, item]));
      // Pair each hit with its item before dropping ids that vanished, so snippets stay with the right item.
      const items = results.map(result => ({ result, item: index.get(result.id) })).filter(entry => entry.item).map(({ result, item }) => {
        remember(item, library);
        return { id: item.id, title: text(item.title), type: item.type, url: text(item.url), collection: collectionPath(library, text(item.collectionId)),
          tags: item.tags || [], updatedAt: text(item.updatedAt), snippet: text(result.snippet) };
      });
      return { summary: `Searched library · ${plural(items.length, 'match', 'matches')}`, data: { query, count: items.length, items }, result: { count: items.length, ids: items.map(item => item.id) } };
    },
    async get_items(input) {
      const wanted = [...new Set((Array.isArray(input.ids) ? input.ids : []).filter(id => typeof id === 'string'))];
      if (!wanted.length) throw new Error('Give get_items at least one item id.');
      const library = await getLibrary();
      const index = new Map((library?.items || []).map(item => [item.id, item]));
      const chosen = wanted.slice(0, 20);
      const budget = Math.max(4000, Math.floor(60000 / chosen.length));
      const items = [];
      const missing = [];
      for (const id of chosen) {
        const item = index.get(id);
        if (!item) { missing.push(id); continue; }
        remember(item, library);
        const note = text(item.content);
        const article = text(item.articleContent);
        const noteBudget = article ? Math.min(note.length, Math.floor(budget / 2)) : budget;
        const articleBudget = Math.max(0, budget - Math.min(note.length, noteBudget));
        items.push({ id: item.id, title: text(item.title), type: item.type, url: text(item.url), collection: collectionPath(library, text(item.collectionId)), collectionId: text(item.collectionId),
          tags: item.tags || [], favorite: !!item.favorite, archived: !!item.archived, inTrash: !!item.deletedAt, createdAt: text(item.createdAt), updatedAt: text(item.updatedAt),
          description: text(item.excerpt).slice(0, 2000), note: note.slice(0, noteBudget), article: article.slice(0, articleBudget),
          highlights: (Array.isArray(item.highlights) ? item.highlights : []).filter(h => h && typeof h === 'object').slice(0, 40).map(h => ({ text: text(h.text).slice(0, 800), note: text(h.note).slice(0, 400) })),
          relatedIds: (item.relatedIds || []).slice(0, 50), fileName: text(item.fileName) || undefined,
          truncated: note.length > noteBudget || article.length > articleBudget });
      }
      return { summary: `Read ${plural(items.length, 'item')}`, data: { items, missing, ...(wanted.length > 20 ? { note: 'Only the first 20 ids were read.' } : {}) }, result: { count: items.length } };
    },
    async list_collections() {
      const library = await getLibrary();
      const live = (library?.items || []).filter(item => item && !item.deletedAt && !item.archived);
      const direct = new Map();
      for (const item of live) direct.set(text(item.collectionId), (direct.get(text(item.collectionId)) || 0) + 1);
      const collections = (library?.collections || []).slice(0, 1000).map(collection => ({ id: collection.id, name: text(collection.name), path: collectionPath(library, collection.id), parentId: text(collection.parentId),
        items: getDescendantCollectionIds(library, collection.id).reduce((sum, id) => sum + (direct.get(id) || 0), 0),
        ...(text(collection.description) ? { description: text(collection.description).slice(0, 200) } : {}) }));
      return { summary: `Listed ${plural(collections.length, 'collection')}`, data: { inbox: { id: '', items: direct.get('') || 0 }, collections }, result: { count: collections.length } };
    },
    async list_tags() {
      const library = await getLibrary();
      const counts = new Map();
      for (const item of library?.items || []) {
        if (!item || item.deletedAt) continue;
        for (const tag of item.tags || []) {
          const key = String(tag).toLowerCase();
          const entry = counts.get(key) || { tag, count: 0 };
          entry.count++;
          counts.set(key, entry);
        }
      }
      const tags = [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, 300);
      return { summary: `Listed ${plural(tags.length, 'tag')}`, data: { tags }, result: { count: tags.length } };
    },
    async get_page() {
      if (!page?.url && !page?.text) throw new Error('No web page is attached to this conversation.');
      const body = text(page.text);
      sources.set('page:current', { id: 'page:current', title: text(page.title) || text(page.url), url: text(page.url), type: 'page' });
      return { summary: 'Read this page', data: { id: 'page:current', url: text(page.url), title: text(page.title), text: body.slice(0, 60000), truncated: body.length > 60000 }, result: { chars: Math.min(body.length, 60000) } };
    },
  };

  // ---- write staging ----
  function itemTargets(input, library, { allowTrashed = false } = {}) {
    const wanted = [...new Set((Array.isArray(input.ids) ? input.ids : []).filter(id => typeof id === 'string'))];
    if (!wanted.length) throw new Error('Give at least one item id.');
    if (wanted.length > MAX_ITEMS_PER_CHANGE) throw new Error(`Too many items in one change (${wanted.length}). The limit is ${MAX_ITEMS_PER_CHANGE}; narrow the selection.`);
    const index = new Map((library?.items || []).map(item => [item.id, item]));
    const found = [];
    const missing = [];
    const trashed = [];
    for (const id of wanted) {
      const item = index.get(id);
      if (!item) missing.push(id);
      else if (item.deletedAt && !allowTrashed) trashed.push(id);
      else found.push(item);
    }
    if (!found.length) throw new Error(missing.length ? `No such items: ${missing.slice(0, 10).join(', ')}. Use ids from search results.` : 'Those items are in Trash and were left alone.');
    return { found, missing, trashed };
  }
  function resolveCollection(value, draft, library, { allowInbox = true } = {}) {
    const raw = text(value).trim();
    if (!raw || raw.toLowerCase() === 'inbox') {
      if (!allowInbox) throw new Error('Choose a collection.');
      return '';
    }
    if (raw.toLowerCase().startsWith(NEW_PREFIX)) {
      const name = raw.slice(NEW_PREFIX.length).trim().toLowerCase();
      const staged = draft.collections.find(collection => collection.name.toLowerCase() === name);
      if (!staged) throw new Error(`"${raw}" does not match a collection proposed in this step. Call create_collection with that exact name in the same step.`);
      return staged.id;
    }
    if (draft.collections.some(collection => collection.id === raw)) return raw;
    const collections = library?.collections || [];
    if (collections.some(collection => collection.id === raw)) return raw;
    const byName = collections.filter(collection => text(collection.name).toLowerCase() === raw.toLowerCase());
    if (byName.length === 1) return byName[0].id;
    throw new Error(`Unknown collection id "${raw}". Use list_collections, or create_collection first.`);
  }
  const pathIn = (library, draft, id) => {
    const staged = draft.collections.find(collection => collection.id === id);
    if (!staged) return collectionPath(library, id);
    const parent = staged.parentId ? pathIn(library, draft, staged.parentId) : '';
    return parent ? `${parent} › ${staged.name}` : staged.name;
  };
  const skippedNote = ({ missing = [], trashed = [] }) => [missing.length ? `${plural(missing.length, 'unknown id')} skipped` : '', trashed.length ? `${plural(trashed.length, 'item')} in Trash left alone` : ''].filter(Boolean).join('; ');

  const stagers = {
    create_collection(input, draft, library) {
      const name = text(input.name).trim().replace(/\s+/g, ' ').slice(0, 200);
      if (!name) throw new Error('Give the collection a name.');
      const parentId = resolveCollection(input.parentId, draft, library);
      const existing = (library?.collections || []).find(collection => text(collection.name).toLowerCase() === name.toLowerCase() && text(collection.parentId) === parentId);
      if (existing) return { skip: true, data: { status: 'exists', collectionId: existing.id, path: collectionPath(library, existing.id), message: 'This collection already exists. Use its id.' } };
      if (draft.collections.some(collection => collection.name.toLowerCase() === name.toLowerCase() && collection.parentId === parentId)) throw new Error('This collection is already part of the proposal.');
      const id = uid('collection');
      const color = /^#[\da-f]{3,8}$/i.test(text(input.color)) ? input.color : '';
      draft.collections.push({ id, name, parentId, icon: text(input.icon).trim().slice(0, 40), color });
      return { op: { op: 'create_collection', collectionId: id }, data: { status: 'proposed', collectionId: id, path: pathIn(library, draft, id) } };
    },
    move_items(input, draft, library) {
      const targets = itemTargets(input, library);
      const collectionId = resolveCollection(input.collectionId, draft, library);
      const moving = targets.found.filter(item => text(item.collectionId) !== collectionId);
      if (!moving.length) return { skip: true, data: { status: 'unchanged', message: `Those items are already in ${pathIn(library, draft, collectionId)}.` } };
      return { op: { op: 'move_items', itemIds: moving.map(item => item.id), collectionId }, data: { status: 'proposed', count: moving.length, collection: pathIn(library, draft, collectionId), skipped: skippedNote(targets) || undefined } };
    },
    add_tags(input, draft, library) {
      const tags = normalizeTags(input.tags);
      if (!tags.length) throw new Error('Give at least one tag.');
      const targets = itemTargets(input, library);
      const changing = targets.found.filter(item => tags.some(tag => !(item.tags || []).some(t => String(t).toLowerCase() === tag.toLowerCase())));
      if (!changing.length) return { skip: true, data: { status: 'unchanged', message: 'Those items already have these tags.' } };
      return { op: { op: 'add_tags', itemIds: changing.map(item => item.id), tags }, data: { status: 'proposed', count: changing.length, tags, skipped: skippedNote(targets) || undefined } };
    },
    remove_tags(input, draft, library) {
      const tags = normalizeTags(input.tags);
      if (!tags.length) throw new Error('Give at least one tag.');
      const targets = itemTargets(input, library);
      const lower = tags.map(tag => tag.toLowerCase());
      const changing = targets.found.filter(item => (item.tags || []).some(t => lower.includes(String(t).toLowerCase())));
      if (!changing.length) return { skip: true, data: { status: 'unchanged', message: 'None of those items have these tags.' } };
      return { op: { op: 'remove_tags', itemIds: changing.map(item => item.id), tags }, data: { status: 'proposed', count: changing.length, tags } };
    },
    set_favorite(input, draft, library) {
      if (typeof input.favorite !== 'boolean') throw new Error('Set favorite to true or false.');
      const targets = itemTargets(input, library);
      const changing = targets.found.filter(item => !!item.favorite !== input.favorite);
      if (!changing.length) return { skip: true, data: { status: 'unchanged', message: input.favorite ? 'Those items are already favorites.' : 'Those items are not favorites.' } };
      return { op: { op: 'set_favorite', itemIds: changing.map(item => item.id), favorite: input.favorite }, data: { status: 'proposed', count: changing.length } };
    },
    archive_items(input, draft, library) {
      const targets = itemTargets(input, library);
      const changing = targets.found.filter(item => !item.archived);
      if (!changing.length) return { skip: true, data: { status: 'unchanged', message: 'Those items are already archived.' } };
      return { op: { op: 'archive_items', itemIds: changing.map(item => item.id) }, data: { status: 'proposed', count: changing.length } };
    },
    trash_items(input, draft, library) {
      const targets = itemTargets(input, library);
      return { op: { op: 'trash_items', itemIds: targets.found.map(item => item.id) }, data: { status: 'proposed', count: targets.found.length, skipped: skippedNote(targets) || undefined } };
    },
    create_note(input, draft, library) {
      const markdown = text(input.markdown).slice(0, 200000);
      if (!markdown.trim()) throw new Error('Give the note some Markdown content.');
      const title = text(input.title).trim().slice(0, 300) || plainText(markdown).slice(0, 80) || 'Untitled note';
      const collectionId = resolveCollection(input.collectionId, draft, library);
      const live = new Set((library?.items || []).filter(item => !item.deletedAt).map(item => item.id));
      const relatedIds = [...new Set((Array.isArray(input.relatedIds) ? input.relatedIds : []).filter(id => typeof id === 'string' && live.has(id)))].slice(0, 100);
      const url = text(input.url) ? safeWebUrl(input.url) : '';
      if (text(input.url) && !url) throw new Error('The note url must be an http or https address.');
      const id = uid('item');
      return { op: { op: 'create_note', noteId: id, title, markdown, collectionId, relatedIds, url }, data: { status: 'proposed', noteId: id, collection: pathIn(library, draft, collectionId) } };
    },
    append_to_note(input, draft, library) {
      const markdown = text(input.markdown).slice(0, 200000);
      if (!markdown.trim()) throw new Error('Give some Markdown to append.');
      const note = (library?.items || []).find(item => item.id === input.id);
      if (!note || note.deletedAt) throw new Error('That note does not exist or is in Trash.');
      if (note.type !== 'note') throw new Error('append_to_note only works on notes. Use create_note to write a new one.');
      return { op: { op: 'append_to_note', itemIds: [note.id], markdown }, data: { status: 'proposed', noteId: note.id } };
    },
    update_item(input, draft, library) {
      const item = (library?.items || []).find(entry => entry.id === input.id);
      if (!item || item.deletedAt) throw new Error('That item does not exist or is in Trash.');
      const patch = {};
      if (typeof input.title === 'string' && input.title.trim() && input.title.trim() !== item.title) patch.title = input.title.trim().slice(0, 500);
      if (typeof input.excerpt === 'string' && input.excerpt !== item.excerpt) patch.excerpt = input.excerpt.slice(0, 2000);
      if (!Object.keys(patch).length) return { skip: true, data: { status: 'unchanged', message: 'Nothing to change.' } };
      return { op: { op: 'update_item', itemIds: [item.id], patch }, data: { status: 'proposed' } };
    },
  };

  // links (optional Map) receives, per change id, the draft parts it covers: { callIds } or { collectionId }.
  function buildProposal(draft, library, { id = uid('proposal'), links = null } = {}) {
    const index = new Map((library?.items || []).map(item => [item.id, item]));
    const preview = itemIds => itemIds.slice(0, 50).map(id => summaryOf(index.get(id) || { id, title: id }));
    const groups = new Map();
    for (const entry of draft.ops) {
      const op = entry.op;
      const key = op.op === 'move_items' ? `move:${op.collectionId}`
        : op.op === 'add_tags' || op.op === 'remove_tags' ? `${op.op}:${op.tags.map(tag => tag.toLowerCase()).sort().join('\u0000')}`
          : op.op === 'set_favorite' ? `favorite:${op.favorite}`
            : op.op === 'archive_items' || op.op === 'trash_items' ? op.op : `${op.op}:${entry.callId}`;
      const group = groups.get(key);
      if (group) { for (const id of op.itemIds || []) if (!group.itemIds.includes(id)) group.itemIds.push(id); group.callIds.push(entry.callId); }
      else groups.set(key, { ...op, itemIds: [...(op.itemIds || [])], callIds: [entry.callId] });
    }
    const changes = [];
    for (const collection of draft.collections) {
      const path = pathIn(library, draft, collection.id);
      changes.push({ op: 'create_collection', label: `Create collection ${path}`, itemIds: [], count: 0, collectionId: collection.id, collectionName: path, parentId: collection.parentId });
    }
    for (const group of groups.values()) {
      if (group.op === 'create_collection') continue;
      const count = group.itemIds.length;
      const items = plural(count, 'item');
      const first = index.get(group.itemIds[0]);
      const base = { op: group.op, itemIds: group.itemIds, count, items: preview(group.itemIds) };
      if (group.op === 'move_items') { const path = pathIn(library, draft, group.collectionId); changes.push({ ...base, label: `Move ${items} to ${path}`, collectionId: group.collectionId, collectionName: path }); }
      else if (group.op === 'add_tags') changes.push({ ...base, label: `Add ${tagLabel(group.tags)} to ${items}`, tags: group.tags });
      else if (group.op === 'remove_tags') changes.push({ ...base, label: `Remove ${tagLabel(group.tags)} from ${items}`, tags: group.tags });
      else if (group.op === 'set_favorite') changes.push({ ...base, label: group.favorite ? `Add ${items} to favorites` : `Remove ${items} from favorites`, favorite: group.favorite });
      else if (group.op === 'archive_items') changes.push({ ...base, label: `Archive ${items}` });
      else if (group.op === 'trash_items') changes.push({ ...base, label: `Move ${items} to Trash` });
      else if (group.op === 'create_note') {
        const path = pathIn(library, draft, group.collectionId);
        changes.push({ op: 'create_note', label: `Create note ${quote(group.title)}${group.collectionId ? ` in ${path}` : ''}`, itemIds: [], count: 1, collectionId: group.collectionId, collectionName: path,
          note: { id: group.noteId, title: group.title, markdown: group.markdown, relatedIds: group.relatedIds, url: group.url } });
      } else if (group.op === 'append_to_note') changes.push({ ...base, label: `Append to ${quote(first?.title)}`, note: { id: group.itemIds[0], markdown: group.markdown } });
      else if (group.op === 'update_item') {
        const { title, excerpt } = group.patch;
        const label = title && excerpt !== undefined ? `Rename ${quote(first?.title)} to ${quote(title)} and update its description`
          : title ? `Rename ${quote(first?.title)} to ${quote(title)}` : `Update the description of ${quote(first?.title)}`;
        changes.push({ ...base, label, ...(title ? { title } : {}), ...(excerpt !== undefined ? { excerpt } : {}) });
      }
    }
    // Stable change ids let the Review step hand back a filtered proposal (see selectDraft).
    const groupList = [...groups.values()].filter(group => group.op !== 'create_collection');
    changes.forEach((change, n) => {
      change.id = `change_${n + 1}`;
      if (!links) return;
      if (change.op === 'create_collection') links.set(change.id, { collectionId: change.collectionId });
      else links.set(change.id, { callIds: groupList[n - draft.collections.length]?.callIds || [] });
    });
    const touched = new Set(changes.flatMap(change => change.itemIds));
    const title = changes.length === 1 ? changes[0].label : touched.size ? `${plural(changes.length, 'change')} to ${plural(touched.size, 'item')}` : plural(changes.length, 'change');
    return { id, title, summary: `${changes.map(change => change.label).join('. ')}.`, changes };
  }

  /**
   * Narrows a draft to what the user kept in Review. answer is 'apply', or a proposal-shaped object whose changes
   * (matched by change id, else by position and op) list the itemIds to keep; changes left out are dropped. It can only
   * remove work, never add it. A proposed collection that a kept change still needs is created anyway.
   * Returns { draft, filtered } (filtered is false when everything was kept).
   */
  function selectDraft(draft, proposal, links, answer) {
    const picked = answer && typeof answer === 'object' ? (Array.isArray(answer.changes) ? answer.changes : Array.isArray(answer.proposal?.changes) ? answer.proposal.changes : null) : null;
    if (!picked) return { draft, filtered: false };
    const keep = new Map(); // change id -> Set of kept item ids, or null for changes without items
    proposal.changes.forEach((change, position) => {
      const match = picked.find(entry => entry && entry.id === change.id)
        || (picked[position] && !picked[position].id && picked[position].op === change.op ? picked[position] : null);
      if (!match) return;
      if (!change.itemIds.length || !Array.isArray(match.itemIds)) { keep.set(change.id, change.itemIds.length ? new Set(change.itemIds) : null); return; }
      const wanted = new Set(match.itemIds.filter(itemId => typeof itemId === 'string'));
      const kept = change.itemIds.filter(itemId => wanted.has(itemId));
      if (kept.length) keep.set(change.id, new Set(kept));
    });
    const byCall = new Map();
    for (const [changeId, link] of links) for (const callId of link.callIds || []) byCall.set(callId, changeId);
    const ops = [];
    for (const entry of draft.ops) {
      const changeId = byCall.get(entry.callId);
      if (!keep.has(changeId)) continue;
      const items = keep.get(changeId);
      if (!entry.op.itemIds || !items) { ops.push(entry); continue; }
      const itemIds = entry.op.itemIds.filter(itemId => items.has(itemId));
      if (itemIds.length) ops.push({ ...entry, op: { ...entry.op, itemIds } });
    }
    const wantedCollections = new Set([...links].filter(([changeId, link]) => link.collectionId && keep.has(changeId)).map(([, link]) => link.collectionId));
    for (const { op } of ops) if (op.collectionId) wantedCollections.add(op.collectionId);
    for (const collection of [...draft.collections].reverse()) if (wantedCollections.has(collection.id) && collection.parentId) wantedCollections.add(collection.parentId);
    const collections = draft.collections.filter(collection => wantedCollections.has(collection.id));
    const filtered = ops.length !== draft.ops.length || collections.length !== draft.collections.length
      || ops.some((entry, n) => entry.op.itemIds?.length !== draft.ops[n].op.itemIds?.length);
    return { draft: { collections, ops }, filtered };
  }

  async function applyDraft(draft) {
    const library = await getLibrary();
    const index = new Map((library?.items || []).map(item => [item.id, item]));
    const undo = { patches: [], createdCollections: [], createdNotes: [] };
    const patches = new Map();
    const previous = new Map();
    const touch = (id, keys) => {
      const item = index.get(id);
      if (!item) return null;
      const patch = patches.get(id) || {};
      const before = previous.get(id) || {};
      for (const key of keys) if (!(key in before)) before[key] = structuredClone(item[key] ?? (key === 'tags' ? [] : key === 'deletedAt' ? null : key === 'favorite' || key === 'archived' ? false : ''));
      patches.set(id, patch);
      previous.set(id, before);
      return { item, patch };
    };
    const live = id => { const item = index.get(id); return item && !item.deletedAt; };
    try {
      for (const collection of draft.collections) {
        await store.createCollection({ id: collection.id, name: collection.name, parentId: collection.parentId, ...(collection.icon ? { icon: collection.icon } : {}), ...(collection.color ? { color: collection.color } : {}) });
        undo.createdCollections.push(collection.id);
      }
      for (const { op } of draft.ops) {
        const itemIds = (op.itemIds || []).filter(live);
        if (op.op === 'move_items') for (const id of itemIds) touch(id, ['collectionId']).patch.collectionId = op.collectionId;
        else if (op.op === 'add_tags' || op.op === 'remove_tags') {
          for (const id of itemIds) {
            const { item, patch } = touch(id, ['tags']);
            const tags = patch.tags || [...(item.tags || [])];
            const lower = op.tags.map(tag => tag.toLowerCase());
            patch.tags = op.op === 'add_tags' ? [...tags, ...op.tags.filter(tag => !tags.some(t => String(t).toLowerCase() === tag.toLowerCase()))]
              : tags.filter(tag => !lower.includes(String(tag).toLowerCase()));
          }
        } else if (op.op === 'set_favorite') for (const id of itemIds) touch(id, ['favorite']).patch.favorite = op.favorite;
        else if (op.op === 'archive_items') for (const id of itemIds) touch(id, ['archived']).patch.archived = true;
        else if (op.op === 'trash_items') for (const id of itemIds) touch(id, ['deletedAt']).patch.deletedAt = now();
        else if (op.op === 'update_item') for (const id of itemIds) Object.assign(touch(id, Object.keys(op.patch)).patch, op.patch);
        else if (op.op === 'append_to_note') {
          for (const id of itemIds) {
            const { item, patch } = touch(id, ['content', 'excerpt']);
            const current = text(patch.content ?? item.content).trimEnd();
            patch.content = current ? `${current}\n\n${op.markdown.trim()}\n` : `${op.markdown.trim()}\n`;
            patch.excerpt = noteExcerpt(patch.content);
          }
        }
      }
      if (patches.size) {
        await store.bulkUpdateItems([...patches].map(([id, patch]) => ({ id, patch })));
        undo.patches = [...previous].map(([id, patch]) => ({ id, patch }));
        // What Apply wrote, so a later Undo can tell which fields the user has changed since.
        undo.applied = [...patches].map(([id, patch]) => ({ id, patch: structuredClone(patch) }));
      }
      for (const { op } of draft.ops) {
        if (op.op !== 'create_note') continue;
        await store.saveItem({ id: op.noteId, type: 'note', title: op.title, content: op.markdown, excerpt: noteExcerpt(op.markdown), collectionId: op.collectionId,
          relatedIds: op.relatedIds.filter(live), url: op.url || '' });
        undo.createdNotes.push(op.noteId);
      }
    } catch (error) {
      // Leave the library as it was: revert whatever part of the proposal was already written.
      try { await undoChanges(store, undo); } catch {}
      throw error;
    }
    return undo;
  }

  const resultFor = (op, data) => {
    if (!op) return data;
    switch (op.op) {
      case 'create_collection': return { status: 'applied', collectionId: op.collectionId, ...(data?.path ? { path: data.path } : {}) };
      case 'create_note': return { status: 'applied', noteId: op.noteId, title: op.title, cite: `[[${op.noteId}]]` };
      case 'move_items': return { status: 'applied', moved: op.itemIds.length, collectionId: op.collectionId, collection: data?.collection };
      case 'add_tags': return { status: 'applied', tagged: op.itemIds.length, tags: op.tags };
      case 'remove_tags': return { status: 'applied', untagged: op.itemIds.length, tags: op.tags };
      case 'set_favorite': return { status: 'applied', updated: op.itemIds.length, favorite: op.favorite };
      case 'archive_items': return { status: 'applied', archived: op.itemIds.length };
      case 'trash_items': return { status: 'applied', trashed: op.itemIds.length };
      default: return { status: 'applied', itemId: op.itemIds?.[0] };
    }
  };

  // onProposal resolves 'apply', 'discard', or (after Review) a proposal-shaped object: { changes: [{ id, itemIds }], decision? }.
  // Anything else, a rejection, or no handler at all means discard: nothing is written without an explicit apply.
  const waitForDecision = proposal => new Promise((resolve, reject) => {
    if (typeof onProposal !== 'function') { resolve({ decision: 'discard' }); return; }
    if (signal?.aborted) { reject(signal.reason || new DOMException('Stopped', 'AbortError')); return; }
    const onAbort = () => reject(signal.reason || new DOMException('Stopped', 'AbortError'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve().then(() => onProposal(structuredClone(proposal))).then(answer => {
      const reviewed = answer && typeof answer === 'object'
        && (answer.decision === 'apply' || (answer.decision === undefined && (Array.isArray(answer.changes) || Array.isArray(answer.proposal?.changes))));
      resolve(answer === 'apply' || reviewed ? { decision: 'apply', answer } : { decision: 'discard' });
    }, () => resolve({ decision: 'discard' }))
      .finally(() => signal?.removeEventListener?.('abort', onAbort));
  });

  /** Runs one model step's tool calls; returns [{ toolUseId, content, isError }] in call order (paired by position). */
  async function execute(calls) {
    const results = new Map(); // call object -> result, so duplicate or missing ids still pair one result per call
    const done = (call, data, { isError = false, summary = '', result } = {}) => {
      results.set(call, { toolUseId: call.id, content: typeof data === 'string' ? data : JSON.stringify(data), isError });
      onEvent({ type: 'tool', id: call.id, name: call.name, summary: summary || (isError ? `${call.name} failed` : call.name), result, isError });
    };
    const writes = [];
    for (const call of calls) {
      const tool = TOOL_BY_NAME.get(call.name);
      const input = call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input : {};
      if (!tool || (call.name === 'get_page' && !page)) { done(call, { error: `Unknown tool ${call.name}.` }, { isError: true }); continue; }
      if (tool.access === 'write') { writes.push({ call, input }); continue; }
      if (signal?.aborted) throw signal.reason || new DOMException('Stopped', 'AbortError');
      try {
        const output = await readers[call.name](input);
        done(call, output.data, { summary: output.summary, result: output.result });
      } catch (error) {
        if (signal?.aborted) throw error;
        done(call, { error: error.message }, { isError: true, summary: `${tool.name.replace(/_/g, ' ')} failed` });
      }
    }
    if (writes.length) {
      if (proposalUsed) {
        for (const { call } of writes) done(call, { status: 'rejected', message: 'Changes were already reviewed in this turn. Do not propose more; tell the user what else you would change so they can ask for it.' }, { isError: true, summary: 'Extra changes not proposed' });
      } else {
        const library = await getLibrary();
        const draft = { collections: [], ops: [] };
        const staged = [];
        // Collections first so moves and notes in the same step can reference "new:<name>".
        const ordered = [...writes].sort((a, b) => (a.call.name === 'create_collection' ? 0 : 1) - (b.call.name === 'create_collection' ? 0 : 1));
        ordered.forEach((entry, n) => { entry.key = `call_${n + 1}`; }); // internal keys: provider call ids may repeat
        for (const { call, input, key } of ordered) {
          try {
            const outcome = stagers[call.name](input, draft, library);
            if (outcome.skip) done(call, outcome.data, { summary: outcome.data.message || 'No change needed' });
            else {
              if (outcome.op.op !== 'create_collection') draft.ops.push({ callId: key, op: outcome.op });
              staged.push({ call, key, op: outcome.op, data: outcome.data });
            }
          } catch (error) {
            done(call, { status: 'invalid', error: error.message }, { isError: true, summary: `${call.name.replace(/_/g, ' ')} not proposed` });
          }
        }
        if (staged.length) {
          proposalUsed = true;
          const links = new Map();
          const proposal = buildProposal(draft, library, { links });
          const record = { ...proposal, status: 'pending' };
          proposals.push(record);
          onEvent({ type: 'proposal', proposal });
          onEvent({ type: 'status', label: 'Waiting for your review' });
          let decision;
          try { decision = await waitForDecision(proposal); }
          catch (error) {
            // Stopped while the card was open: close it as discarded so the UI does not leave an Apply button behind.
            record.status = 'discarded';
            onEvent({ type: 'proposal_result', proposalId: proposal.id, status: 'discarded' });
            throw error;
          }
          const chosen = decision.decision === 'apply' ? selectDraft(draft, proposal, links, decision.answer) : null;
          if (chosen && (chosen.draft.ops.length || chosen.draft.collections.length)) {
            try {
              const undo = await applyDraft(chosen.draft);
              const applied = chosen.filtered ? buildProposal(chosen.draft, library, { id: proposal.id }) : proposal;
              record.status = 'applied';
              record.result = { summary: applied.summary };
              if (chosen.filtered) record.applied = applied.changes;
              record.undo = undo;
              onEvent({ type: 'proposal_result', proposalId: proposal.id, status: 'applied', summary: applied.summary, ...(chosen.filtered ? { applied: applied.changes } : {}),
                undo: () => undoChanges(store, undo, { getLibrary }) });
              const keptOps = new Map(chosen.draft.ops.map(entry => [entry.callId, entry.op]));
              const keptCollections = new Set(chosen.draft.collections.map(collection => collection.id));
              for (const { call, key, op, data } of staged) {
                const used = op.op === 'create_collection' ? (keptCollections.has(op.collectionId) ? op : null) : keptOps.get(key);
                if (!used) { done(call, { status: 'declined', message: 'The user left this change out when reviewing the proposal. Nothing was changed for it.' }, { summary: 'Left out' }); continue; }
                // Created notes are cited from what was written: the library snapshot may not show them yet.
                if (used.op === 'create_note') sources.set(used.noteId, { id: used.noteId, title: used.title, url: used.url || '', type: 'note', collection: data?.collection || collectionPath(library, used.collectionId) });
                const excluded = (op.itemIds?.length || 0) - (used.itemIds?.length || 0);
                done(call, { ...resultFor(used, data), ...(excluded > 0 ? { excludedByUser: excluded } : {}) }, { summary: labelFor(used, applied) });
              }
            } catch (error) {
              record.status = 'failed';
              record.error = error.message;
              onEvent({ type: 'proposal_result', proposalId: proposal.id, status: 'failed', error: error.message });
              for (const { call } of staged) done(call, { status: 'failed', message: `Nothing was changed: ${error.message}` }, { isError: true, summary: 'Changes failed' });
            }
          } else {
            record.status = 'discarded';
            onEvent({ type: 'proposal_result', proposalId: proposal.id, status: 'discarded' });
            for (const { call } of staged) done(call, { status: 'declined', message: 'The user declined the proposed changes. Nothing was changed. Do not propose them again unless asked.' }, { summary: 'Changes discarded' });
          }
        }
      }
    }
    return calls.map(call => results.get(call) || { toolUseId: call.id, content: JSON.stringify({ error: 'Tool did not run.' }), isError: true });
  }

  const labelFor = (op, proposal) => {
    const change = proposal.changes.find(entry => entry.op === op.op && (op.collectionId === undefined || entry.collectionId === op.collectionId) && (!op.itemIds?.length || op.itemIds.every(id => entry.itemIds.includes(id))));
    return change ? change.label.replace(/^Create /, 'Created ').replace(/^Move /, 'Moved ').replace(/^Add /, 'Added ').replace(/^Remove /, 'Removed ')
      .replace(/^Archive /, 'Archived ').replace(/^Append /, 'Appended ').replace(/^Rename /, 'Renamed ').replace(/^Update /, 'Updated ') : 'Applied';
  };

  return { definitions: options => toolDefinitions({ page: !!page, ...options }), execute, sources, proposals };
}
