import test from 'node:test';
import assert from 'node:assert/strict';
import { LIBRARY_TOOLS, toolDefinitions, createToolSession, collectionPath, normalizeTags, undoChanges, MAX_ITEMS_PER_CHANGE } from '../extension/lib/ai/tools.js';
import { createSearch } from '../extension/lib/ai/search.js';
import { createLibraryStore } from '../extension/lib/store.js';

function memoryStore(seed) {
  let state = null;
  const library = createLibraryStore({ read: async () => state, write: async next => { state = next; } });
  const call = (operation, ...args) => library.dispatch(operation, args);
  return {
    ready: call('loadLibrary', seed),
    loadLibrary: () => call('loadLibrary'),
    saveItem: input => call('saveItem', input),
    updateItem: (id, patch, options = {}) => call('updateItem', id, patch, options),
    bulkUpdateItems: (changes, options = {}) => call('bulkUpdateItems', changes, options),
    createCollection: input => call('createCollection', input),
    deleteItem: (id, options = {}) => call('deleteItem', id, options),
    deleteCollection: (id, options = {}) => call('deleteCollection', id, options),
    restoreItem: (id, options = {}) => call('restoreItem', id, options),
    permanentlyDeleteItem: (id, options = {}) => call('permanentlyDeleteItem', id, options),
    updateCollection: (id, patch, options = {}) => call('updateCollection', id, patch, options),
    moveCollection: (id, placement = {}) => call('moveCollection', id, placement),
    mutateTags: input => call('mutateTags', input),
  };
}
const seed = () => ({
  schemaVersion: 1,
  collections: [{ id: 'travel', name: 'Travel', color: '#336699' }, { id: 'design', name: 'Design' }],
  items: [
    { id: 'kyoto', type: 'article', title: 'Kyoto temples', url: 'https://example.com/kyoto', articleContent: 'Temples in Kyoto.', tags: ['Japan'] },
    { id: 'tokyo', type: 'bookmark', title: 'Tokyo food map', url: 'https://example.com/tokyo', tags: ['food'] },
    { id: 'osaka', type: 'bookmark', title: 'Osaka castle', url: 'https://example.com/osaka', collectionId: 'travel' },
    { id: 'plan', type: 'note', title: 'Trip plan', content: '# Trip plan\n- [ ] Book flights' },
    { id: 'gone', type: 'bookmark', title: 'Old Japan link', url: 'https://example.com/old', deletedAt: '2026-10-01T00:00:00.000Z' },
  ],
});
const call = (name, input, id = `call_${name}`) => ({ id, name, input });
const parse = result => JSON.parse(result.content);

// A closed object schema whose properties are simple types; arrays hold strings or (one level down) closed objects.
function assertSimpleSchema(schema, where, nested = false) {
  assert.equal(schema.type, 'object', where);
  assert.equal(schema.additionalProperties, false, `${where} is closed`);
  assert.ok(Array.isArray(schema.required), where);
  for (const key of schema.required) assert.ok(Object.hasOwn(schema.properties, key), `${where}.${key} is declared`);
  for (const [key, property] of Object.entries(schema.properties)) {
    assert.ok(['string', 'integer', 'boolean', 'array'].includes(property.type), `${where}.${key} has a simple type`);
    if (property.type === 'array' && property.items.type === 'object' && !nested) assertSimpleSchema(property.items, `${where}.${key}[]`, true);
    else if (property.type === 'array') assert.equal(property.items.type, 'string', `${where}.${key} holds strings`);
    for (const unsupported of ['minimum', 'maximum', 'maxItems', 'maxLength', 'minLength', 'pattern', 'format']) assert.ok(!(unsupported in property), `${where}.${key} avoids ${unsupported}`);
  }
}

test('every tool schema is strict-compatible: an object with properties, additionalProperties false and required ⊆ properties', () => {
  assert.equal(LIBRARY_TOOLS.length, 29);
  const names = new Set();
  for (const tool of LIBRARY_TOOLS) {
    assert.match(tool.name, /^[a-z_]{3,40}$/);
    assert.ok(!names.has(tool.name));
    names.add(tool.name);
    assert.ok(tool.description.length > 20);
    assert.ok(['read', 'write'].includes(tool.access));
    assertSimpleSchema(tool.inputSchema, tool.name);
    if (tool.access === 'write') assert.match(tool.description, /only after the user approves/);
  }
  const reads = ['search_library', 'get_items', 'list_items', 'lookup_urls', 'list_collections', 'list_tags', 'get_page', 'get_dashboard'];
  const writes = ['create_collection', 'update_collection', 'delete_collection', 'save_links', 'move_items', 'add_tags', 'remove_tags', 'rename_tag', 'delete_tag', 'set_favorite',
    'archive_items', 'unarchive_items', 'trash_items', 'restore_items', 'convert_items', 'create_note', 'append_to_note', 'update_item', 'link_items', 'unlink_items', 'show_collection_on_dashboard'];
  assert.deepEqual([...names].sort(), [...reads, ...writes].sort());
  for (const name of reads) assert.equal(LIBRARY_TOOLS.find(tool => tool.name === name).access, 'read', name);
  for (const name of writes) assert.equal(LIBRARY_TOOLS.find(tool => tool.name === name).access, 'write', name);
  // save_links takes a list of closed { url, title?, description?, tags? } objects.
  const links = LIBRARY_TOOLS.find(tool => tool.name === 'save_links').inputSchema.properties.links.items;
  assert.deepEqual([Object.keys(links.properties), links.required], [['url', 'title', 'description', 'tags'], ['url']]);
  assert.ok(!toolDefinitions().some(tool => tool.name === 'get_page'), 'get_page is offered only with a page');
  assert.ok(toolDefinitions({ page: true }).some(tool => tool.name === 'get_page'));
  assert.ok(!toolDefinitions().some(tool => ['get_dashboard', 'show_collection_on_dashboard'].includes(tool.name)), 'dashboard tools need a dashboard adapter');
  assert.deepEqual(toolDefinitions({ dashboard: true }).filter(tool => /dashboard/.test(tool.name)).map(tool => tool.name), ['get_dashboard', 'show_collection_on_dashboard']);
  assert.ok(toolDefinitions({ write: false }).every(tool => LIBRARY_TOOLS.find(entry => entry.name === tool.name).access === 'read'));
  assert.deepEqual(Object.keys(toolDefinitions()[0]).sort(), ['description', 'inputSchema', 'name']);
});

test('nested link objects survive the Gemini schema conversion and count as closed for strict transports', async () => {
  const { geminiSchema } = await import('../extension/lib/ai/transports/gemini.js');
  const { isStrictSchema } = await import('../extension/lib/ai/transports/shared.js');
  const schema = LIBRARY_TOOLS.find(tool => tool.name === 'save_links').inputSchema;
  const converted = geminiSchema(schema);
  assert.equal(converted.properties.links.type, 'array');
  assert.deepEqual(Object.keys(converted.properties.links.items.properties), ['url', 'title', 'description', 'tags']);
  assert.deepEqual(converted.properties.links.items.required, ['url']);
  assert.equal(converted.properties.links.items.properties.tags.items.type, 'string');
  // Optional properties keep every tool out of strict mode, the nested object included; closing it is still required.
  assert.equal(isStrictSchema(schema.properties.links.items), false);
  assert.equal(isStrictSchema({ ...schema.properties.links.items, required: ['url', 'title', 'description', 'tags'] }), true);
});

async function session(options = {}) {
  const store = memoryStore(seed());
  await store.ready;
  const getLibrary = () => store.loadLibrary();
  const search = createSearch({ getLibrary });
  const events = [];
  const proposals = [];
  let counter = 0;
  const tools = createToolSession({ getLibrary, searchLibrary: search.searchLibrary, store, uid: prefix => `${prefix}_${++counter}`,
    onEvent: event => events.push(event), onProposal: async proposal => { proposals.push(proposal); return options.decision || 'apply'; }, ...options.session });
  return { store, tools, events, proposals, getLibrary };
}

test('read tools search, read, and list the library and remember sources for citations', async () => {
  const { tools, events } = await session();
  const [search, items, collections, tags] = await tools.execute([
    call('search_library', { query: 'kyoto temples', limit: 5 }),
    call('get_items', { ids: ['plan', 'missing'] }),
    call('list_collections', {}),
    call('list_tags', {}),
  ]);
  const found = parse(search);
  assert.equal(found.items[0].id, 'kyoto');
  assert.equal(found.items[0].collection, 'Inbox');
  assert.ok(!found.items.some(item => item.id === 'gone'));
  const read = parse(items);
  assert.equal(read.items[0].note, '# Trip plan\n- [ ] Book flights');
  assert.deepEqual(read.missing, ['missing']);
  const listed = parse(collections);
  assert.deepEqual(listed.collections.map(c => [c.id, c.path, c.items]), [['travel', 'Travel', 1], ['design', 'Design', 0]]);
  assert.equal(listed.inbox.items, 3);
  assert.deepEqual(parse(tags).tags.map(t => t.tag), ['food', 'Japan']);
  assert.ok(tools.sources.has('kyoto') && tools.sources.has('plan'));
  assert.deepEqual(events.filter(e => e.type === 'tool').map(e => e.summary), ['Searched library · 1 match', 'Read 1 item', 'Listed 2 collections', 'Listed 2 tags']);
  const unknown = await tools.execute([call('get_page', {}), call('drop_table', {})]);
  assert.ok(unknown.every(result => result.isError));
});

test('write calls in one step become a single proposal with readable labels and are applied atomically on apply', async () => {
  const { tools, events, proposals, getLibrary } = await session();
  const results = await tools.execute([
    call('move_items', { ids: ['kyoto', 'tokyo', 'gone', 'nope'], collectionId: 'new:Japan 2027' }, 'c1'),
    call('create_collection', { name: 'Japan 2027', parentId: 'travel', color: 'red' }, 'c2'),
    call('add_tags', { ids: ['kyoto', 'tokyo'], tags: ['#japan', 'trip', 'Trip'] }, 'c3'),
    call('create_note', { title: 'Japan reading list', markdown: 'See [[kyoto]] and [[tokyo]].', collectionId: 'new:Japan 2027', relatedIds: ['kyoto', 'tokyo', 'gone'] }, 'c4'),
    call('set_favorite', { ids: ['kyoto'], favorite: true }, 'c5'),
  ]);
  assert.equal(proposals.length, 1);
  const proposal = proposals[0];
  assert.deepEqual(proposal.changes.map(change => change.label), [
    'Create collection Travel › Japan 2027',
    'Move 2 items to Travel › Japan 2027',
    'Add tags #japan and #trip to 2 items',
    'Create note “Japan reading list” in Travel › Japan 2027',
    'Add 1 item to favorites',
  ]);
  assert.equal(proposal.title, '5 changes to 2 items');
  assert.match(proposal.summary, /^Create collection Travel › Japan 2027\. Move 2 items/);
  const move = proposal.changes[1];
  assert.deepEqual(move.itemIds, ['kyoto', 'tokyo']);
  assert.equal(move.count, 2);
  assert.equal(move.collectionName, 'Travel › Japan 2027');
  assert.deepEqual(move.items, [{ id: 'kyoto', title: 'Kyoto temples' }, { id: 'tokyo', title: 'Tokyo food map' }]);
  // Results come back in call order and confirm what was applied.
  assert.deepEqual(results.map(r => r.toolUseId), ['c1', 'c2', 'c3', 'c4', 'c5']);
  const created = parse(results[1]);
  assert.equal(created.status, 'applied');
  assert.equal(parse(results[0]).moved, 2);
  assert.equal(parse(results[0]).collectionId, created.collectionId);
  assert.equal(parse(results[3]).cite, `[[${parse(results[3]).noteId}]]`);
  const library = await getLibrary();
  const collection = library.collections.find(c => c.id === created.collectionId);
  assert.equal(collection.parentId, 'travel');
  assert.equal(collection.color, '#a99eea', 'invalid colors fall back to the default');
  const kyoto = library.items.find(i => i.id === 'kyoto');
  assert.equal(kyoto.collectionId, created.collectionId);
  assert.deepEqual(kyoto.tags, ['Japan', 'trip'], 'tag matching is case-insensitive and keeps existing casing');
  assert.equal(kyoto.favorite, true);
  assert.equal(library.items.find(i => i.id === 'gone').collectionId, '', 'trashed items are never touched');
  const note = library.items.find(i => i.id === parse(results[3]).noteId);
  assert.equal(note.type, 'note');
  assert.equal(note.collectionId, created.collectionId);
  assert.deepEqual(note.relatedIds, ['kyoto', 'tokyo']);
  assert.equal(note.excerpt, 'See kyoto and tokyo.');
  const outcome = events.find(event => event.type === 'proposal_result');
  assert.equal(outcome.status, 'applied');
  assert.equal(tools.proposals[0].status, 'applied');
  // Undo restores the library.
  await outcome.undo();
  const reverted = await getLibrary();
  assert.ok(!reverted.collections.some(c => c.id === created.collectionId));
  assert.equal(reverted.items.find(i => i.id === 'kyoto').collectionId, '');
  assert.deepEqual(reverted.items.find(i => i.id === 'kyoto').tags, ['Japan']);
  assert.equal(reverted.items.find(i => i.id === 'kyoto').favorite, false);
  assert.ok(!reverted.items.some(i => i.id === note.id), 'a created note untouched since is removed for good');
  // After an applied proposal a later step may propose again (it can build on what was applied).
  const [late] = await tools.execute([call('archive_items', { ids: ['osaka'] }, 'c6')]);
  assert.equal(parse(late).status, 'applied');
  assert.equal(proposals.length, 2);
});

test('discarded proposals change nothing and tell the model the user declined', async () => {
  const { tools, proposals, getLibrary, events } = await session({ decision: 'discard' });
  const before = JSON.stringify((await getLibrary()).items);
  const results = await tools.execute([call('trash_items', { ids: ['tokyo'] }), call('search_library', { query: 'osaka' }, 'read')]);
  assert.equal(proposals[0].changes[0].label, 'Move 1 item to Trash');
  assert.equal(parse(results[0]).status, 'declined');
  assert.equal(results[0].isError, false);
  assert.equal(parse(results[1]).items[0].id, 'osaka', 'read calls in the same step still run');
  assert.equal(JSON.stringify((await getLibrary()).items), before);
  assert.equal(events.find(event => event.type === 'proposal_result').status, 'discarded');
  assert.equal(tools.proposals[0].status, 'discarded');
});

test('invalid write calls are reported without a proposal; unchanged ones are no-ops; batch size is capped', async () => {
  const { tools, proposals } = await session();
  const tooMany = Array.from({ length: MAX_ITEMS_PER_CHANGE + 1 }, (_, i) => `id${i}`);
  const results = await tools.execute([
    call('move_items', { ids: ['kyoto'], collectionId: 'nowhere' }, 'a'),
    call('move_items', { ids: ['osaka'], collectionId: 'Travel' }, 'b'),
    call('add_tags', { ids: tooMany, tags: ['x'] }, 'c'),
    call('append_to_note', { id: 'kyoto', markdown: 'x' }, 'd'),
    call('create_collection', { name: 'travel' }, 'e'),
    call('remove_tags', { ids: ['tokyo'], tags: ['missing'] }, 'f'),
    call('trash_items', { ids: ['gone'] }, 'g'),
  ]);
  assert.match(parse(results[0]).error, /Unknown collection id/);
  assert.equal(parse(results[1]).status, 'unchanged', 'a collection name resolves to its id; osaka is already there');
  assert.match(parse(results[2]).error, /Too many items/);
  assert.match(parse(results[3]).error, /only works on notes/);
  assert.equal(parse(results[4]).status, 'exists');
  assert.equal(parse(results[4]).collectionId, 'travel');
  assert.equal(parse(results[5]).status, 'unchanged');
  assert.match(parse(results[6]).error, /in Trash/);
  assert.equal(proposals.length, 0);
});

test('a failing apply rolls back the parts already written', async () => {
  const { store, getLibrary } = await session();
  const failing = { ...store, saveItem: async () => { throw new Error('Disk full'); } };
  let counter = 0;
  const broken = createToolSession({ getLibrary, searchLibrary: async () => [], store: failing, uid: prefix => `${prefix}_x${++counter}`, onProposal: async () => 'apply' });
  const results = await broken.execute([
    call('create_collection', { name: 'Archive 2026' }, 'a'),
    call('move_items', { ids: ['tokyo'], collectionId: 'new:Archive 2026' }, 'b'),
    call('create_note', { title: 'Summary', markdown: 'Text' }, 'c'),
  ]);
  assert.ok(results.every(result => result.isError && /Nothing was changed: Disk full/.test(parse(result).message)));
  const library = await getLibrary();
  assert.ok(!library.collections.some(c => c.name === 'Archive 2026'));
  assert.equal(library.items.find(i => i.id === 'tokyo').collectionId, '');
  assert.equal(broken.proposals[0].status, 'failed');
});

test('helpers: collection paths, tag normalization and undo of append/update', async () => {
  const library = { collections: [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }, { id: 'c', name: 'C', parentId: '' }] };
  assert.equal(collectionPath(library, ''), 'Inbox');
  assert.equal(collectionPath(library, 'c'), 'C');
  assert.equal(collectionPath(library, 'a'), 'B › A', 'cycles terminate');
  assert.deepEqual(normalizeTags(['#One', ' one ', 'Two words ', '', 3]), ['One', 'Two words']);
  const { tools, getLibrary, store } = await session();
  const [append, update] = await tools.execute([call('append_to_note', { id: 'plan', markdown: '- [ ] Book hotel' }, 'a'), call('update_item', { id: 'tokyo', title: 'Tokyo food guide', excerpt: 'Where to eat' }, 'b')]);
  assert.equal(parse(append).status, 'applied');
  assert.equal(parse(update).status, 'applied');
  const library2 = await getLibrary();
  assert.equal(library2.items.find(i => i.id === 'plan').content, '# Trip plan\n- [ ] Book flights\n\n- [ ] Book hotel\n');
  assert.equal(library2.items.find(i => i.id === 'tokyo').title, 'Tokyo food guide');
  assert.match(tools.proposals[0].changes.map(c => c.label).join(' | '), /Append to “Trip plan” \| Rename “Tokyo food map” to “Tokyo food guide” and update its description/);
  await undoChanges(store, tools.proposals[0].undo);
  const restored = await getLibrary();
  assert.equal(restored.items.find(i => i.id === 'plan').content, '# Trip plan\n- [ ] Book flights');
  assert.equal(restored.items.find(i => i.id === 'tokyo').title, 'Tokyo food map');
  assert.equal(restored.items.find(i => i.id === 'tokyo').excerpt, '');
});

test('search_library keeps each snippet with its own item when a hit no longer exists', async () => {
  const { tools } = await session({ session: { searchLibrary: async () => [
    { id: 'vanished', score: 3, snippet: 'vanished snippet' },
    { id: 'kyoto', score: 2, snippet: 'kyoto snippet' },
    { id: 'osaka', score: 1, snippet: 'osaka snippet' },
  ] } });
  const [result] = await tools.execute([call('search_library', { query: 'anything' })]);
  assert.deepEqual(parse(result).items.map(item => [item.id, item.snippet]), [['kyoto', 'kyoto snippet'], ['osaka', 'osaka snippet']]);
});

test('stopping while a proposal waits for review closes it as discarded and changes nothing', async () => {
  const controller = new AbortController();
  const { tools, events, getLibrary } = await session({ session: { signal: controller.signal, onProposal: () => new Promise(() => {}) } });
  const pending = tools.execute([call('trash_items', { ids: ['tokyo'] })]);
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, error => error.name === 'AbortError');
  const closed = events.find(event => event.type === 'proposal_result');
  assert.equal(closed.status, 'discarded');
  assert.equal(closed.proposalId, events.find(event => event.type === 'proposal').proposal.id);
  assert.equal(tools.proposals[0].status, 'discarded');
  assert.equal((await getLibrary()).items.find(item => item.id === 'tokyo').deletedAt, null);
});
