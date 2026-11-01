import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolSession, buildChanges, undoChanges, MAX_PROPOSALS_PER_TURN } from '../extension/lib/ai/tools.js';
import { createSearch } from '../extension/lib/ai/search.js';
import { createLibraryStore } from '../extension/lib/store.js';
import { folderLinks } from '../extension/ui/widgets/links/model.js';

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
    restoreItem: (id, options = {}) => call('restoreItem', id, options),
    permanentlyDeleteItem: (id, options = {}) => call('permanentlyDeleteItem', id, options),
    updateCollection: (id, patch, options = {}) => call('updateCollection', id, patch, options),
    moveCollection: (id, placement = {}) => call('moveCollection', id, placement),
    deleteCollection: (id, options = {}) => call('deleteCollection', id, options),
    mutateTags: input => call('mutateTags', input),
  };
}
const seed = () => ({
  schemaVersion: 1,
  collections: [
    { id: 'travel', name: 'Travel' },
    { id: 'japan', name: 'Japan', parentId: 'travel' },
    { id: 'design', name: 'Design', icon: 'sparkles', color: '#336699', pinned: true },
    { id: 'misc', name: 'Misc' },
  ],
  items: [
    { id: 'kyoto', type: 'bookmark', title: 'Kyoto temples', url: 'https://example.com/kyoto', collectionId: 'japan', tags: ['Japan', 'temples'], createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'tokyo', type: 'bookmark', title: 'Tokyo food map', url: 'https://example.com/tokyo?utm_source=x', tags: ['japan', 'food'], favorite: true, createdAt: '2026-02-01T00:00:00.000Z' },
    { id: 'osaka', type: 'bookmark', title: 'Osaka castle', url: 'https://example.com/osaka', collectionId: 'travel', pinned: true, createdAt: '2026-02-15T00:00:00.000Z' },
    { id: 'aws-note', type: 'note', title: 'AWS', url: 'https://aws.amazon.com/console/', content: 'https://aws.amazon.com/console/', collectionId: 'misc', createdAt: '2026-03-01T00:00:00.000Z' },
    { id: 'azure-note', type: 'note', title: 'Azure', url: 'https://portal.azure.com/', content: 'Azure portal', collectionId: 'misc', sticky: { color: 'pink', z: 4 }, createdAt: '2026-03-02T00:00:00.000Z' },
    { id: 'plain-note', type: 'note', title: 'Ideas', content: 'Some ideas', collectionId: 'misc', createdAt: '2026-03-03T00:00:00.000Z' },
    { id: 'old', type: 'article', title: 'Old essay', url: 'https://example.com/essay', archived: true, collectionId: 'design', createdAt: '2025-01-01T00:00:00.000Z' },
    { id: 'gone', type: 'bookmark', title: 'Gone link', url: 'https://example.com/gone', deletedAt: '2026-10-01T00:00:00.000Z', createdAt: '2025-06-01T00:00:00.000Z' },
    { id: 'linked', type: 'note', title: 'Linked note', content: 'See Kyoto', relatedIds: ['kyoto'], createdAt: '2026-04-01T00:00:00.000Z' },
  ],
});
const call = (name, input, id = `call_${name}`) => ({ id, name, input });
const parse = result => JSON.parse(result.content);
const byId = (library, id) => library.items.find(item => item.id === id);

function fakeDashboard(store, boards) {
  const state = { activeBoardId: 'main', boards: boards || [
    { id: 'main', name: 'Main', widgets: [{ id: 'w-clock', type: 'clock', title: 'Clock' }, { id: 'w-design', type: 'links-folder', title: '', collectionId: 'design' }] },
    { id: 'work', name: 'Work', widgets: [] },
  ] };
  const log = [];
  let counter = 0;
  return { state, log,
    async describe() { return structuredClone(state); },
    async addCollectionWidget({ collectionId, boardId }) {
      // Applied last: the collection (even a new one) must already exist.
      if (!(await store.loadLibrary()).collections.some(collection => collection.id === collectionId)) throw new Error('collection missing when the widget was added');
      const target = state.boards.find(board => board.id === (boardId || state.activeBoardId));
      const widgetId = `widget_${++counter}`;
      target.widgets.push({ id: widgetId, type: 'links-folder', title: '', collectionId });
      log.push(['add', collectionId, target.id]);
      return { widgetId, boardId: target.id };
    },
    async removeWidget(widgetId) { for (const board of state.boards) board.widgets = board.widgets.filter(widget => widget.id !== widgetId); log.push(['remove', widgetId]); },
  };
}

async function session(options = {}) {
  const store = memoryStore(seed());
  await store.ready;
  const getLibrary = options.stale ? (snapshot => () => snapshot)(await store.loadLibrary()) : () => store.loadLibrary();
  const search = createSearch({ getLibrary });
  const events = [];
  const proposals = [];
  let counter = 0;
  const dashboard = options.dashboard ? fakeDashboard(store, options.boards) : null;
  const decide = options.decision || 'apply';
  const tools = createToolSession({ getLibrary, searchLibrary: search.searchLibrary, store, dashboard, uid: prefix => `${prefix}_${++counter}`,
    onEvent: event => events.push(event), onProposal: async proposal => { proposals.push(proposal); return typeof decide === 'function' ? decide(proposal) : decide; }, ...options.session });
  return { store, tools, events, proposals, dashboard, getLibrary: () => store.loadLibrary() };
}
const outcome = events => events.filter(event => event.type === 'proposal_result').at(-1);
const summaries = events => events.filter(event => event.type === 'tool').map(event => event.summary);

test('save_links saves real links exactly as given, skips duplicates and saved links, reports notes with the same address; undo removes them', async () => {
  const { tools, proposals, events, getLibrary } = await session();
  const signIn = 'https://signin.aws.amazon.com/oauth?client_id=arn%3Aaws%3Asignin&redirect_uri=https%3A%2F%2Fconsole.aws.amazon.com%2F&code_challenge=abc_DEF-123&utm_source=mail#/login';
  const [created, saved] = await tools.execute([
    call('create_collection', { name: 'API Consoles' }, 'c1'),
    call('save_links', { collectionId: 'new:API Consoles', tags: ['cloud'], links: [
      { url: signIn, title: 'AWS sign-in  ' },
      { url: 'https://example.com/kyoto/?utm_source=news', title: 'Kyoto again' },
      { url: 'https://aws.amazon.com/console/', title: 'AWS console', tags: ['aws'] },
      { url: 'https://portal.azure.com' },
      { url: 'https://portal.azure.com/?utm_campaign=z' },
      { url: 'javascript:alert(1)' },
      { url: 'https://user:secret@example.com/private' },
    ] }, 's1'),
  ]);
  const proposal = proposals[0];
  assert.deepEqual(proposal.changes.map(change => change.label), ['Create collection API Consoles', 'Save 3 links to API Consoles', 'Move 1 item to API Consoles']);
  const save = proposal.changes[1];
  assert.equal(save.op, 'save_links');
  assert.equal(save.count, 3);
  assert.deepEqual(save.links.map(link => [link.url, link.title, link.tags]), [
    [signIn, 'AWS sign-in', ['cloud']],
    ['https://aws.amazon.com/console/', 'AWS console', ['cloud', 'aws']],
    ['https://portal.azure.com/', 'portal.azure.com', ['cloud']],
  ], 'urls are kept verbatim (only URL.href normalization) and titles fall back to the host');
  assert.deepEqual(save.items.map(item => item.url), save.links.map(link => link.url));
  assert.deepEqual(save.itemIds, save.links.map(link => link.id), 'ids are allocated up front so the card can review them');
  const collectionId = parse(created).collectionId;
  const result = parse(saved);
  assert.equal(result.status, 'applied');
  assert.equal(result.saved, 3);
  assert.deepEqual(result.items.map(item => item.id), save.itemIds);
  assert.deepEqual(result.alreadySaved, [{ url: 'https://example.com/kyoto/?utm_source=news', id: 'kyoto', title: 'Kyoto temples', collection: 'Travel › Japan', moved: true }]);
  assert.deepEqual(result.duplicates, ['https://portal.azure.com/?utm_campaign=z']);
  assert.deepEqual(result.invalid.map(entry => entry.url), ['javascript:alert(1)', 'https://user:secret@example.com/private']);
  assert.deepEqual(result.notesWithSameUrl, ['aws-note', 'azure-note']);
  assert.deepEqual(summaries(events), ['Created collection API Consoles', 'Saved 3 links to API Consoles; Moved 1 item to API Consoles']);
  const library = await getLibrary();
  const links = save.itemIds.map(id => byId(library, id));
  assert.ok(links.every(item => item.type === 'bookmark' && item.collectionId === collectionId));
  assert.equal(links[0].url, signIn);
  assert.equal(byId(library, 'kyoto').collectionId, collectionId, 'the saved copy moved instead of a duplicate');
  assert.equal(library.items.filter(item => item.url === 'https://example.com/kyoto').length, 1);
  assert.deepEqual(folderLinks(library.items, [collectionId]).map(item => item.id).sort(), [...save.itemIds, 'kyoto'].sort(), 'a links widget for the collection shows them');
  for (const id of save.itemIds) assert.equal(tools.sources.get(id).type, 'bookmark', 'new links are citable at once');
  await outcome(events).undo();
  const reverted = await getLibrary();
  assert.ok(save.itemIds.every(id => !byId(reverted, id)), 'links untouched since are removed for good');
  assert.equal(byId(reverted, 'kyoto').collectionId, 'japan');
  assert.ok(!reverted.collections.some(collection => collection.id === collectionId));
});

test('save_links reports already saved links without proposing and fails only when nothing can be saved', async () => {
  const { tools, proposals } = await session();
  const [same, broken, two] = await tools.execute([
    call('save_links', { links: [{ url: 'https://example.com/tokyo' }, 'https://example.com/osaka'] }, 'a'),
    call('save_links', { links: [{ url: 'mailto:me@example.com' }, { url: '' }] }, 'b'),
    call('save_links', { links: [] }, 'c'),
  ]);
  const unchanged = parse(same);
  assert.equal(unchanged.status, 'unchanged', 'no collection named: saved links stay where they are');
  assert.deepEqual(unchanged.alreadySaved.map(entry => [entry.id, entry.moved]), [['tokyo', undefined], ['osaka', undefined]]);
  assert.match(parse(broken).error, /None of these links can be saved/);
  assert.match(parse(two).error, /at least one link/);
  assert.equal(proposals.length, 0);
});

test('convert_items turns notes into links that show on the dashboard; items without a url are listed; undo restores type and sticky', async () => {
  const { tools, proposals, events, getLibrary } = await session();
  const [convert, trash] = await tools.execute([
    call('convert_items', { ids: ['aws-note', 'azure-note', 'plain-note'], type: 'bookmark' }, 'v'),
    call('trash_items', { ids: ['linked'] }, 't'),
  ]);
  assert.deepEqual(proposals[0].changes.map(change => change.label), ['Turn 2 notes into links', 'Move 1 item to Trash']);
  assert.equal(proposals[0].changes[0].type, 'bookmark');
  assert.deepEqual(parse(convert), { status: 'applied', converted: 2, type: 'bookmark', invalid: ['plain-note'] });
  assert.equal(parse(trash).trashed, 1);
  const library = await getLibrary();
  assert.equal(byId(library, 'aws-note').type, 'bookmark');
  assert.equal(byId(library, 'aws-note').content, 'https://aws.amazon.com/console/', 'the text stays as the item’s note');
  assert.equal(byId(library, 'azure-note').sticky, null, 'links are not sticky notes');
  assert.deepEqual(folderLinks(library.items, ['misc']).map(item => item.id).sort(), ['aws-note', 'azure-note']);
  assert.deepEqual(summaries(events), ['Turned 2 notes into links', 'Moved 1 item to Trash']);
  await outcome(events).undo();
  const reverted = await getLibrary();
  assert.equal(byId(reverted, 'aws-note').type, 'note');
  assert.equal(byId(reverted, 'azure-note').sticky.color, 'pink');
  assert.equal(byId(reverted, 'linked').deletedAt, null);

  const [none, back] = await tools.execute([call('convert_items', { ids: ['plain-note'], type: 'article' }, 'x'), call('convert_items', { ids: ['kyoto'], type: 'note' }, 'y')]);
  assert.match(parse(none).error, /cannot become links/);
  assert.equal(parse(back).status, 'applied');
  assert.equal(proposals.at(-1).changes[0].label, 'Change 1 item to a note');
});

test('update_item edits url, note body, pin, read and reminder, validates at staging, and undo restores every field', async () => {
  const { tools, proposals, events, getLibrary } = await session();
  const results = await tools.execute([
    call('update_item', { id: 'plain-note', note: '# New body\nWith text', pinned: true, reminderAt: '2026-11-02T09:00:00.000Z' }, 'a'),
    call('update_item', { id: 'tokyo', url: 'https://example.com/tokyo-guide?ref=a&utm_source=b', read: true, description: 'Where to eat' }, 'b'),
    call('update_item', { id: 'kyoto', url: 'ftp://example.com/x' }, 'c'),
    call('update_item', { id: 'kyoto', url: '' }, 'd'),
    call('update_item', { id: 'kyoto', reminderAt: 'next tuesday' }, 'e'),
    call('update_item', { id: 'osaka', pinned: true }, 'f'),
    call('update_item', { id: 'osaka', pinned: false }, 'g'),
    call('update_item', { id: 'old', excerpt: 'Older name still works' }, 'h'),
  ]);
  assert.deepEqual(proposals[0].changes.map(change => change.label), [
    'Update “Ideas”: text, pin and reminder',
    'Update “Tokyo food map”: description, link and read state',
    'Unpin “Osaka castle”',
    'Update the description of “Old essay”',
  ]);
  assert.deepEqual(proposals[0].changes[1].patch, { excerpt: 'Where to eat', url: 'https://example.com/tokyo-guide?ref=a&utm_source=b', read: true });
  assert.equal(proposals[0].changes[1].excerpt, 'Where to eat', 'title and excerpt stay top-level for the card');
  assert.match(parse(results[2]).error, /http or https/);
  assert.match(parse(results[3]).error, /needs a url/);
  assert.match(parse(results[4]).error, /reminderAt must be/);
  assert.equal(parse(results[5]).status, 'unchanged');
  assert.deepEqual(parse(results[0]).updated, ['content', 'pinned', 'reminderAt']);
  const library = await getLibrary();
  const note = byId(library, 'plain-note');
  assert.equal(note.content, '# New body\nWith text');
  assert.match(note.excerpt, /^New body/, 'a note’s excerpt follows its new body');
  assert.equal(note.pinned, true);
  assert.equal(note.reminderAt, '2026-11-02T09:00:00.000Z');
  const tokyo = byId(library, 'tokyo');
  assert.equal(tokyo.url, 'https://example.com/tokyo-guide?ref=a&utm_source=b', 'parameters are kept');
  assert.equal(tokyo.read, true);
  assert.equal(byId(library, 'osaka').pinned, false);
  await outcome(events).undo();
  const reverted = await getLibrary();
  assert.deepEqual([byId(reverted, 'plain-note').content, byId(reverted, 'plain-note').excerpt, byId(reverted, 'plain-note').pinned, byId(reverted, 'plain-note').reminderAt], ['Some ideas', '', false, null]);
  assert.deepEqual([byId(reverted, 'tokyo').url, byId(reverted, 'tokyo').read, byId(reverted, 'tokyo').excerpt], ['https://example.com/tokyo?utm_source=x', false, '']);
  assert.equal(byId(reverted, 'osaka').pinned, true);
});

test('restore, unarchive, link and unlink are proposed, applied and undone', async () => {
  const { tools, proposals, events, getLibrary } = await session();
  const results = await tools.execute([
    call('restore_items', { ids: ['gone', 'kyoto'] }, 'r'),
    call('unarchive_items', { ids: ['old'] }, 'u'),
    call('link_items', { id: 'tokyo', relatedIds: ['kyoto', 'old', 'gone', 'tokyo', 'nope'] }, 'l'),
    call('unlink_items', { id: 'kyoto', relatedIds: ['linked'] }, 'x'),
    call('restore_items', { ids: ['kyoto'] }, 'r2'),
  ]);
  assert.deepEqual(proposals[0].changes.map(change => change.label), ['Restore 1 item from Trash', 'Unarchive 1 item', 'Link “Tokyo food map” to 2 items', 'Unlink “Kyoto temples” from 1 item']);
  assert.deepEqual(proposals[0].changes[2].related, [{ id: 'kyoto', title: 'Kyoto temples' }, { id: 'old', title: 'Old essay' }]);
  assert.deepEqual(results.slice(0, 4).map(result => parse(result).status), ['applied', 'applied', 'applied', 'applied']);
  assert.equal(parse(results[4]).status, 'unchanged');
  const library = await getLibrary();
  assert.equal(byId(library, 'gone').deletedAt, null);
  assert.equal(byId(library, 'old').archived, false);
  assert.deepEqual(byId(library, 'tokyo').relatedIds, ['kyoto', 'old']);
  assert.deepEqual(byId(library, 'linked').relatedIds, [], 'unlinking removes the link from both sides');
  await outcome(events).undo();
  const reverted = await getLibrary();
  assert.equal(byId(reverted, 'gone').deletedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(byId(reverted, 'old').archived, true);
  assert.deepEqual(byId(reverted, 'tokyo').relatedIds, []);
  assert.deepEqual(byId(reverted, 'linked').relatedIds, ['kyoto']);
});

test('collections: update (rename, color, pin, move with a cycle check) and delete; undo brings the same collection back with its items and children', async () => {
  const { tools, proposals, events, getLibrary } = await session();
  const results = await tools.execute([
    call('update_collection', { id: 'design', name: 'Design ideas', color: '#ff0000', pinned: false, parentId: 'misc' }, 'u'),
    call('update_collection', { id: 'travel', parentId: 'japan' }, 'cycle'),
    call('update_collection', { id: 'misc', color: 'red' }, 'color'),
    call('update_collection', { id: 'misc', name: 'Misc' }, 'same'),
    call('delete_collection', { id: 'Travel' }, 'd'),
  ]);
  assert.deepEqual(proposals[0].changes.map(change => change.label), ['Update collection Design: name, color, pin and parent', 'Delete collection Travel (1 item moves to Inbox, 1 sub-collection moves up a level)']);
  assert.deepEqual(proposals[0].changes[0].patch, { name: 'Design ideas', color: '#ff0000', pinned: false, parentId: 'misc' });
  assert.match(parse(results[1]).error, /inside itself/);
  assert.match(parse(results[2]).error, /#hex/);
  assert.equal(parse(results[3]).status, 'unchanged');
  assert.deepEqual(parse(results[4]), { status: 'applied', deleted: 'travel', movedToInbox: 1 });
  assert.deepEqual(summaries(events).slice(-2), ['Updated collection Design: name, color, pin and parent', 'Deleted collection Travel (1 item moved to Inbox, 1 sub-collection moved up a level)']);
  const library = await getLibrary();
  const design = library.collections.find(collection => collection.id === 'design');
  assert.deepEqual([design.name, design.color, design.pinned, design.parentId], ['Design ideas', '#ff0000', false, 'misc']);
  assert.ok(!library.collections.some(collection => collection.id === 'travel'));
  assert.equal(library.collections.find(collection => collection.id === 'japan').parentId, '');
  assert.equal(byId(library, 'osaka').collectionId, '');
  await outcome(events).undo();
  const reverted = await getLibrary();
  const top = reverted.collections.filter(collection => !collection.parentId).map(collection => collection.id);
  assert.deepEqual(top, ['travel', 'design', 'misc'], 'top-level order is restored');
  const restored = reverted.collections.find(collection => collection.id === 'design');
  assert.deepEqual([restored.name, restored.color, restored.pinned, restored.icon], ['Design', '#336699', true, 'sparkles']);
  assert.equal(reverted.collections.find(collection => collection.id === 'japan').parentId, 'travel', 'children are re-parented');
  assert.equal(byId(reverted, 'osaka').collectionId, 'travel', 'items return to the recreated collection');
  assert.equal(byId(reverted, 'kyoto').collectionId, 'japan');
});

test('rename_tag merges case-insensitively and undo restores each item’s exact tags; delete_tag removes a tag everywhere', async () => {
  const { tools, proposals, events, getLibrary } = await session();
  const [rename] = await tools.execute([call('rename_tag', { from: '#JAPAN', to: 'food' }, 'r')]);
  assert.deepEqual(proposals[0].changes.map(change => [change.label, change.merge]), [['Rename tag #Japan to #food on 2 items', true]]);
  assert.deepEqual(parse(rename), { status: 'applied', renamed: 2, from: 'Japan', to: 'food' });
  let library = await getLibrary();
  assert.deepEqual(byId(library, 'kyoto').tags, ['food', 'temples']);
  assert.deepEqual(byId(library, 'tokyo').tags, ['food'], 'merged without a duplicate');
  await outcome(events).undo();
  library = await getLibrary();
  assert.deepEqual(byId(library, 'kyoto').tags, ['Japan', 'temples']);
  assert.deepEqual(byId(library, 'tokyo').tags, ['japan', 'food']);
  const [removed, missing, unknown] = await tools.execute([call('delete_tag', { tag: 'japan' }, 'd'), call('delete_tag', { tag: 'nothing' }, 'n'), call('rename_tag', { from: 'nothing', to: 'x' }, 'x')]);
  assert.equal(proposals.at(-1).changes[0].label, 'Remove tag #Japan from 2 items');
  assert.deepEqual(parse(removed), { status: 'applied', untagged: 2, tag: 'Japan' });
  assert.equal(parse(missing).status, 'unchanged');
  assert.match(parse(unknown).error, /No items have the tag/);
  library = await getLibrary();
  assert.ok(library.items.every(item => !item.tags.some(tag => tag.toLowerCase() === 'japan')));
});

test('create_note takes tags and a sticky color, and every created note gets its own label', async () => {
  const { tools, events, getLibrary } = await session();
  const results = await tools.execute([
    call('create_collection', { name: 'API Consoles', description: 'Where I sign in' }, 'c'),
    call('create_note', { title: 'AWS', markdown: 'aws', collectionId: 'new:API Consoles', tags: ['cloud', '#cloud'] }, 'n1'),
    call('create_note', { title: 'Azure', markdown: 'azure', collectionId: 'new:API Consoles', sticky: 'blue' }, 'n2'),
    call('create_note', { title: 'Bad', markdown: 'x', sticky: 'neon' }, 'n3'),
  ]);
  assert.deepEqual(summaries(events), ['create note not proposed', 'Created collection API Consoles', 'Created note “AWS” in API Consoles', 'Created note “Azure” in API Consoles']);
  assert.match(parse(results[3]).error, /sticky must be one of/);
  const library = await getLibrary();
  const aws = byId(library, parse(results[1]).noteId);
  const azure = byId(library, parse(results[2]).noteId);
  assert.deepEqual(aws.tags, ['cloud']);
  assert.equal(aws.sticky, null);
  assert.equal(azure.sticky.color, 'blue');
  assert.ok(azure.sticky.z > 4, 'a new sticky goes on top of the existing ones');
  assert.equal(parse(results[2]).sticky, 'blue');
  assert.equal(library.collections.find(collection => collection.name === 'API Consoles').description, 'Where I sign in');
});

test('list_items browses by state, collection, type and flags with paging; lookup_urls finds every saved copy of an address', async () => {
  const { tools } = await session();
  const results = await tools.execute([
    call('list_items', {}, 'all-active'),
    call('list_items', { state: 'trash' }, 'trash'),
    call('list_items', { state: 'archived' }, 'archived'),
    call('list_items', { state: 'all', sort: 'title', limit: 3 }, 'page1'),
    call('list_items', { state: 'all', sort: 'title', limit: 3, offset: 6 }, 'page3'),
    call('list_items', { collectionId: 'Travel', sort: 'oldest' }, 'travel'),
    call('list_items', { collectionId: 'inbox', type: 'note' }, 'inbox'),
    call('list_items', { favorite: true }, 'fav'),
    call('list_items', { pinned: false, tag: '#JAPAN' }, 'tag'),
    call('list_items', { collectionId: 'nowhere' }, 'bad'),
  ]);
  const ids = result => parse(result).items.map(item => item.id);
  assert.deepEqual(ids(results[0]), ['linked', 'plain-note', 'azure-note', 'aws-note', 'osaka', 'tokyo', 'kyoto'], 'active: newest first, no archive, no Trash');
  assert.equal(parse(results[0]).total, 7);
  assert.deepEqual(ids(results[1]), ['gone']);
  assert.equal(parse(results[1]).items[0].inTrash, true);
  assert.deepEqual(ids(results[2]), ['old']);
  assert.deepEqual(ids(results[3]), ['aws-note', 'azure-note', 'gone']);
  assert.equal(parse(results[3]).nextOffset, 3);
  assert.deepEqual([parse(results[4]).total, parse(results[4]).count, parse(results[4]).nextOffset], [9, 3, null]);
  assert.deepEqual(ids(results[5]), ['kyoto', 'osaka'], 'a collection includes its sub-collections');
  assert.deepEqual(ids(results[6]), ['linked']);
  assert.deepEqual(ids(results[7]), ['tokyo']);
  assert.deepEqual(ids(results[8]).sort(), ['kyoto', 'tokyo']);
  assert.match(parse(results[9]).error, /Unknown collection/);
  assert.deepEqual(Object.keys(parse(results[0]).items[0]).sort(), ['archived', 'collection', 'favorite', 'id', 'inTrash', 'pinned', 'tags', 'title', 'type', 'updatedAt', 'url']);

  const [lookup, tooMany] = await tools.execute([call('lookup_urls', { urls: ['https://example.com/kyoto?utm_medium=x#frag', 'https://portal.azure.com', 'https://example.com/gone', 'https://nothing.example/', 'not a url'] }, 'l'),
    call('lookup_urls', { urls: Array.from({ length: 201 }, (_, i) => `https://example.com/${i}`) }, 'm')]);
  const found = parse(lookup).results;
  assert.deepEqual(found.map(entry => entry.matches.map(match => match.id)), [['kyoto'], ['azure-note'], ['gone'], [], []]);
  assert.deepEqual(found[1].matches[0], { id: 'azure-note', title: 'Azure', type: 'note', collection: 'Misc', inTrash: false, archived: false, exact: true });
  assert.equal(found[0].matches[0].exact, false, 'same page, another #fragment: reported, flagged as not exact');
  assert.equal(found[2].matches[0].inTrash, true);
  assert.equal(found[4].valid, false);
  assert.match(parse(tooMany).error, /up to 200/);
});

test('get_items and list_collections report pinned, read and reminder state, icons, colors and pinned collections', async () => {
  const { tools, store } = await session();
  await store.updateItem('osaka', { read: true, reminderAt: '2026-12-01T10:00:00.000Z' });
  const [items, collections] = await tools.execute([call('get_items', { ids: ['osaka', 'azure-note'] }), call('list_collections', {})]);
  const [osaka, azure] = parse(items).items;
  assert.deepEqual([osaka.pinned, osaka.read, osaka.reminderAt], [true, true, '2026-12-01T10:00:00.000Z']);
  assert.deepEqual([azure.pinned, azure.reminderAt, azure.sticky], [false, null, 'pink']);
  const design = parse(collections).collections.find(collection => collection.id === 'design');
  assert.deepEqual([design.icon, design.color, design.pinned], ['sparkles', '#336699', true]);
});

test('items left out in review never reach the store; results and the applied summary count only what changed', async () => {
  const { tools, proposals, events, getLibrary } = await session({ decision: proposal => ({ decision: 'apply', exclude: [proposal.changes[0].itemIds[0], 'tokyo', 'not-in-this-proposal'] }) });
  const [links, move, tag] = await tools.execute([
    call('save_links', { collectionId: 'design', links: [{ url: 'https://a.example/one' }, { url: 'https://b.example/two' }] }, 's'),
    call('move_items', { ids: ['tokyo', 'kyoto'], collectionId: 'design' }, 'm'),
    call('add_tags', { ids: ['tokyo'], tags: ['later'] }, 't'),
  ]);
  const [left, kept] = proposals[0].changes[0].itemIds;
  assert.equal(parse(links).saved, 1);
  assert.equal(parse(links).leftOutByUser, 1);
  assert.deepEqual(parse(links).items.map(item => item.id), [kept]);
  assert.equal(parse(move).moved, 1);
  assert.equal(parse(tag).status, 'excluded');
  const result = outcome(events);
  assert.deepEqual(result.excluded, [left, 'tokyo'], 'only ids that were in the proposal are recorded');
  assert.equal(result.summary, 'Save 1 link to Design. Move 1 item to Design.');
  assert.deepEqual(tools.proposals[0].excluded, [left, 'tokyo']);
  assert.deepEqual(summaries(events), ['Saved 1 link to Design', 'Moved 1 item to Design', 'Left out']);
  const library = await getLibrary();
  assert.ok(!byId(library, left) && byId(library, kept));
  assert.deepEqual([byId(library, 'tokyo').collectionId, byId(library, 'tokyo').tags], ['', ['japan', 'food']]);
  assert.equal(byId(library, 'kyoto').collectionId, 'design');
});

test('leaving every item out discards the proposal and ends proposing for the turn', async () => {
  const { tools, events } = await session({ decision: proposal => ({ decision: 'apply', exclude: proposal.changes.flatMap(change => change.itemIds) }) });
  const [first] = await tools.execute([call('archive_items', { ids: ['kyoto'] }, 'a')]);
  assert.equal(parse(first).status, 'declined');
  assert.equal(outcome(events).status, 'discarded');
  const [second] = await tools.execute([call('archive_items', { ids: ['tokyo'] }, 'b')]);
  assert.equal(parse(second).status, 'rejected');
});

test('several proposals per turn: a later step builds on applied ids even when the app snapshot lags; a decline stops proposing; at most four', async () => {
  const { tools, proposals } = await session({ stale: true });
  const [saved] = await tools.execute([call('save_links', { links: [{ url: 'https://new.example/page', title: 'New page' }] }, 'p1')]);
  const linkId = parse(saved).items[0].id;
  const [read] = await tools.execute([call('get_items', { ids: [linkId] }, 'r')]);
  assert.equal(parse(read).items[0].title, 'New page', 'reads see the applied change through the store');
  const [tagged] = await tools.execute([call('add_tags', { ids: [linkId], tags: ['fresh'] }, 'p2')]);
  assert.equal(parse(tagged).status, 'applied', 'staging sees it too');
  const [third] = await tools.execute([call('set_favorite', { ids: [linkId], favorite: true }, 'p3')]);
  const [fourth] = await tools.execute([call('archive_items', { ids: [linkId] }, 'p4')]);
  assert.deepEqual([parse(third).status, parse(fourth).status], ['applied', 'applied']);
  const [fifth] = await tools.execute([call('trash_items', { ids: [linkId] }, 'p5')]);
  assert.equal(parse(fifth).status, 'rejected');
  assert.match(parse(fifth).message, new RegExp(`already had ${MAX_PROPOSALS_PER_TURN} proposals`));
  assert.equal(proposals.length, MAX_PROPOSALS_PER_TURN);

  const declined = await session({ decision: 'discard' });
  const [no] = await declined.tools.execute([call('archive_items', { ids: ['kyoto'] }, 'a')]);
  assert.equal(parse(no).status, 'declined');
  const [again] = await declined.tools.execute([call('add_tags', { ids: ['kyoto'], tags: ['x'] }, 'b'), call('list_tags', {}, 'c')]);
  assert.equal(again.isError, true);
  assert.equal(parse(again).status, 'rejected');
  assert.match(parse(again).message, /declined/);
  assert.equal(declined.proposals.length, 1);
});

test('dashboard tools: get_dashboard lists boards, show_collection_on_dashboard adds a links widget last, skips ones already shown, and undo removes it', async () => {
  const bare = await session();
  assert.ok(!bare.tools.definitions().some(tool => /dashboard/.test(tool.name)));
  const [hidden] = await bare.tools.execute([call('get_dashboard', {}, 'h')]);
  assert.match(parse(hidden).error, /Unknown tool/);

  const { tools, proposals, events, dashboard, getLibrary } = await session({ dashboard: true });
  assert.ok(tools.definitions().some(tool => tool.name === 'show_collection_on_dashboard'));
  const [described] = await tools.execute([call('get_dashboard', {}, 'g')]);
  const view = parse(described);
  assert.equal(view.activeBoardId, 'main');
  assert.deepEqual(view.boards[0].widgets[1], { id: 'w-design', type: 'links-folder', title: '', collectionId: 'design', collection: 'Design' });
  const results = await tools.execute([
    call('show_collection_on_dashboard', { collectionId: 'new:Reading' }, 's1'),
    call('save_links', { collectionId: 'new:Reading', links: [{ url: 'https://read.example/a' }] }, 's2'),
    call('create_collection', { name: 'Reading' }, 'c'),
    call('show_collection_on_dashboard', { collectionId: 'design' }, 's3'),
    call('show_collection_on_dashboard', { collectionId: 'misc', boardId: 'work' }, 's4'),
    call('show_collection_on_dashboard', { collectionId: 'misc', boardId: 'nope' }, 's5'),
    call('show_collection_on_dashboard', { collectionId: '' }, 's6'),
  ]);
  assert.deepEqual(proposals[0].changes.map(change => change.label), ['Create collection Reading', 'Show Reading on the dashboard', 'Save 1 link to Reading', 'Show Misc on the dashboard']);
  assert.deepEqual(proposals[0].changes.at(-1), { op: 'add_dashboard_widget', label: 'Show Misc on the dashboard', itemIds: [], count: 0, collectionId: 'misc', collectionName: 'Misc', boardId: 'work', boardName: 'Work' });
  assert.equal(parse(results[3]).status, 'unchanged');
  assert.match(parse(results[3]).message, /already shows on the dashboard/);
  assert.match(parse(results[5]).error, /Unknown dashboard board/);
  assert.match(parse(results[6]).error, /Choose a collection/);
  const reading = parse(results[2]).collectionId;
  assert.deepEqual(parse(results[0]), { status: 'applied', collectionId: reading, widgetId: 'widget_1', boardId: 'main' });
  assert.deepEqual(dashboard.log, [['add', reading, 'main'], ['add', 'misc', 'work']], 'widgets are added after the collection exists');
  assert.ok(summaries(events).includes('Added Reading to the dashboard'));
  await outcome(events).undo();
  assert.deepEqual(dashboard.log.slice(2), [['remove', 'widget_1'], ['remove', 'widget_2']]);
  assert.ok(!(await getLibrary()).collections.some(collection => collection.id === reading));

  const nested = await session({ dashboard: true, boards: [{ id: 'main', name: 'Main', widgets: [{ id: 'w', type: 'links-folder', title: '', collectionId: 'travel', includeSubcollections: true }] }] });
  const [covered] = await nested.tools.execute([call('show_collection_on_dashboard', { collectionId: 'japan' }, 'n')]);
  assert.equal(parse(covered).status, 'unchanged', 'a parent widget that includes sub-collections already shows it');
});

test('a failing apply puts back collection edits, deletions and new links before reporting failure', async () => {
  const { store, getLibrary } = await session();
  const before = await getLibrary();
  let counter = 0;
  const dashboard = { describe: async () => ({ activeBoardId: 'main', boards: [{ id: 'main', name: 'Main', widgets: [] }] }), addCollectionWidget: async () => { throw new Error('Dashboard is read-only'); }, removeWidget: async () => {} };
  const broken = createToolSession({ getLibrary, searchLibrary: async () => [], store, dashboard, uid: prefix => `${prefix}_f${++counter}`, onProposal: async () => 'apply' });
  const results = await broken.execute([
    call('update_collection', { id: 'design', name: 'Renamed' }, 'u'),
    call('delete_collection', { id: 'travel' }, 'd'),
    call('save_links', { collectionId: 'misc', links: [{ url: 'https://x.example/' }] }, 's'),
    call('show_collection_on_dashboard', { collectionId: 'misc' }, 'w'),
  ]);
  assert.ok(results.every(result => result.isError && /Nothing was changed: Dashboard is read-only/.test(parse(result).message)));
  const after = await getLibrary();
  assert.deepEqual(after.collections.map(collection => [collection.id, collection.name, collection.parentId]).sort(), before.collections.map(collection => [collection.id, collection.name, collection.parentId]).sort());
  assert.equal(byId(after, 'osaka').collectionId, 'travel');
  assert.equal(after.items.length, before.items.length, 'the new link was removed for good');
  assert.equal(broken.proposals[0].status, 'failed');
});

test('undo works from the saved plain record after a reload; items edited since go to Trash instead', async () => {
  const { tools, store, getLibrary } = await session();
  await tools.execute([
    call('save_links', { links: [{ url: 'https://keep.example/' }, { url: 'https://drop.example/' }] }, 's'),
    call('create_note', { title: 'Scratch', markdown: 'temp' }, 'n'),
    call('move_items', { ids: ['tokyo'], collectionId: 'misc' }, 'm'),
  ]);
  const record = JSON.parse(JSON.stringify(tools.proposals[0].undo));
  assert.deepEqual(Object.keys(record).sort(), ['collectionPatches', 'createdCollections', 'createdItems', 'createdNotes', 'deletedCollections', 'patches', 'revisions', 'widgets']);
  const [edited, untouched] = record.createdItems.map(entry => entry.id);
  await store.updateItem(edited, { title: 'I renamed this' });
  await undoChanges(store, record);
  const library = await getLibrary();
  assert.ok(byId(library, edited).deletedAt, 'edited since: kept, in Trash');
  assert.ok(!byId(library, untouched));
  assert.ok(!byId(library, record.createdNotes[0].id));
  assert.equal(byId(library, 'tokyo').collectionId, '');
  // Older records list created notes as plain ids: those still go to Trash.
  const legacy = await session();
  await legacy.store.saveItem({ id: 'legacy-note', type: 'note', title: 'Legacy', content: 'x' });
  await undoChanges(legacy.store, { patches: [], createdCollections: [], createdNotes: ['legacy-note'] });
  assert.ok(byId(await legacy.getLibrary(), 'legacy-note').deletedAt);
  // Undo keeps going when one step fails, and says so.
  await assert.rejects(undoChanges(legacy.store, { widgets: ['w1'], createdNotes: ['missing-note'] }), /Some changes could not be undone: The dashboard widget could not be removed/);
});

test('a later undo never wipes edits made after the apply, and keeps a created collection the user has filled since', async () => {
  const { tools, store, getLibrary } = await session();
  await tools.execute([
    call('create_collection', { name: 'Research' }, 'c'),
    call('append_to_note', { id: 'plain-note', markdown: 'Assistant line' }, 'a'),
    call('move_items', { ids: ['kyoto', 'osaka'], collectionId: 'new:Research' }, 'm'),
  ]);
  const record = JSON.parse(JSON.stringify(tools.proposals[0].undo));
  const research = record.createdCollections[0];
  const before = byId(await getLibrary(), 'plain-note').content;
  // After the apply the user keeps writing in the note, and files one of their own notes in the new collection.
  await store.updateItem('plain-note', { content: `${before}\nUSER: three pages of new work` });
  await store.saveItem({ id: 'mine', type: 'note', title: 'My thesis notes', content: 'x', collectionId: research });
  const result = await undoChanges(store, record);
  const library = await getLibrary();
  assert.match(byId(library, 'plain-note').content, /USER: three pages of new work/, 'the later edit survives');
  assert.equal(byId(library, 'kyoto').collectionId, 'japan', 'untouched items are restored');
  assert.equal(byId(library, 'osaka').collectionId, 'travel');
  assert.ok(library.collections.some(collection => collection.id === research), 'the filled collection stays');
  assert.equal(byId(library, 'mine').collectionId, research);
  assert.equal(result.kept, 2, 'the note and the collection were left as they are');
  // A second click changes nothing more: everything is now past the revision the record holds.
  const settled = JSON.stringify(await getLibrary());
  await undoChanges(store, record);
  assert.equal(JSON.stringify(await getLibrary()), settled);
});

test('save_links treats another #fragment as another link: hash-routed pages are saved, and a near match is never moved', async () => {
  const { tools, store, getLibrary } = await session();
  await store.saveItem({ id: 'gmail', type: 'bookmark', title: 'Gmail inbox', url: 'https://mail.google.com/mail/u/0/#inbox', collectionId: 'misc' });
  const [, saved] = await tools.execute([
    call('create_collection', { name: 'Admin' }, 'c'),
    call('save_links', { collectionId: 'new:Admin', links: [
      { url: 'https://console.example.com/#/billing' }, { url: 'https://console.example.com/#/users' }, { url: 'https://mail.google.com/mail/u/0/#settings/filters' },
    ] }, 's'),
  ]);
  const result = parse(saved);
  assert.equal(result.saved, 3, 'every hash route is its own link');
  assert.equal(result.duplicates, undefined);
  assert.equal(result.alreadySaved, undefined);
  assert.deepEqual(result.similar.map(entry => entry.id), ['gmail']);
  assert.equal(byId(await getLibrary(), 'gmail').collectionId, 'misc', 'the unrelated saved link stays where it was');
});

test('every staged operation shows a row on the card, including ones without wording', () => {
  const library = { collections: [{ id: 'c', name: 'C' }], items: [{ id: 'a', title: 'A' }] };
  const changes = buildChanges({ collections: [], ops: [{ callId: 'x', op: { op: 'frobnicate_items', itemIds: ['a'] } }, { callId: 'y', op: { op: 'pin_collection', collectionId: 'c' } }] }, library);
  assert.deepEqual(changes.map(change => change.label), ['Frobnicate items (1 item)', 'Pin collection']);
  assert.deepEqual(changes[0].items, [{ id: 'a', title: 'A' }]);
  assert.equal(changes[1].collectionName, 'C');
});

test('rename_tag unifies spellings that differ only in case; undo of a nested collection delete restores the hierarchy', async () => {
  const { tools, store, getLibrary } = await session();
  await store.updateItem('kyoto', { tags: ['JS'] });
  await store.updateItem('osaka', { tags: ['js'] });
  await store.updateItem('tokyo', { tags: ['js', 'food'] });
  const [renamed] = await tools.execute([call('rename_tag', { from: 'js', to: 'JS' }, 'r')]);
  assert.equal(parse(renamed).status, 'applied');
  const library = await getLibrary();
  assert.deepEqual(['kyoto', 'osaka', 'tokyo'].map(id => byId(library, id).tags.filter(tag => tag.toLowerCase() === 'js')), [['JS'], ['JS'], ['JS']]);

  // Travel > Japan > Kansai: delete Japan and Kansai in one proposal, then undo. Kansai must go back under Japan, not Travel.
  const second = await session();
  await second.store.createCollection({ id: 'kansai', name: 'Kansai', parentId: 'japan' });
  await second.tools.execute([call('delete_collection', { id: 'japan' }, 'a'), call('delete_collection', { id: 'kansai' }, 'b')]);
  await undoChanges(second.store, JSON.parse(JSON.stringify(second.tools.proposals[0].undo)));
  const after = await second.getLibrary();
  assert.equal(after.collections.find(c => c.id === 'japan').parentId, 'travel', 'Japan is back inside Travel');
  assert.equal(after.collections.find(c => c.id === 'kansai').parentId, 'japan', 'Kansai is back inside Japan');
  assert.equal(byId(after, 'kyoto').collectionId, 'japan');
});
