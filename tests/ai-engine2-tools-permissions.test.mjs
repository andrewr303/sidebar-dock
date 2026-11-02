// Assistant permission levels in the tool session (contracts §8): allowed proposals apply at once through the same apply
// and undo path, everything else still waits for review; create_note subpages; AI undo order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolSession, undoChanges, MAX_PROPOSALS_PER_TURN, MAX_AUTO_PROPOSALS_PER_TURN, LIBRARY_TOOLS } from '../extension/lib/ai/tools.js';
import { PERMISSION_PRESETS, autoApproves, MAX_AUTO_ITEMS } from '../extension/lib/ai/permissions.js';
import { assistantSystemPrompt } from '../extension/lib/ai-prompts.js';
import { createAssistant } from '../extension/lib/ai/assistant.js';
import { createSearch } from '../extension/lib/ai/search.js';
import { createConversationStore, createMemoryStorage } from '../extension/lib/ai/conversations.js';
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
    restoreItem: (id, options = {}) => call('restoreItem', id, options),
    permanentlyDeleteItem: (id, options = {}) => call('permanentlyDeleteItem', id, options),
    updateCollection: (id, patch, options = {}) => call('updateCollection', id, patch, options),
    moveCollection: (id, placement = {}) => call('moveCollection', id, placement),
    deleteCollection: (id, options = {}) => call('deleteCollection', id, options),
  };
}
const seed = () => ({
  schemaVersion: 1,
  collections: [{ id: 'travel', name: 'Travel' }, { id: 'design', name: 'Design' }],
  items: [
    { id: 'kyoto', type: 'article', title: 'Kyoto temples', url: 'https://example.com/kyoto', articleContent: 'Temples.', tags: ['Japan'] },
    { id: 'tokyo', type: 'bookmark', title: 'Tokyo food map', url: 'https://example.com/tokyo', tags: ['food', 'Japan'] },
    { id: 'osaka', type: 'bookmark', title: 'Osaka castle', url: 'https://example.com/osaka', collectionId: 'travel' },
    { id: 'plan', type: 'note', title: 'Trip plan', content: '# Trip plan', collectionId: 'travel' },
    { id: 'gone', type: 'bookmark', title: 'Old link', url: 'https://example.com/old', deletedAt: '2026-10-01T00:00:00.000Z' },
  ],
});
const call = (name, input, id = `call_${name}`) => ({ id, name, input });
const parse = result => JSON.parse(result.content);
const byId = (library, id) => library.items.find(item => item.id === id);
const ALL = PERMISSION_PRESETS.full;

async function session({ permissions, decision = 'apply', store: wrap, ...options } = {}) {
  const base = memoryStore(seed());
  await base.ready;
  const store = wrap ? wrap(base) : base;
  const getLibrary = () => base.loadLibrary();
  const search = createSearch({ getLibrary });
  const events = [];
  const asked = [];
  let counter = 0;
  const tools = createToolSession({ getLibrary, searchLibrary: search.searchLibrary, store, uid: prefix => `${prefix}_${++counter}`, permissions,
    onEvent: event => events.push(event), onProposal: async proposal => { asked.push(proposal); return decision; }, ...options });
  return { store, base, tools, events, asked, getLibrary };
}
const statuses = events => events.filter(event => event.type === 'status').map(event => event.label);

test('with every kind allowed a proposal applies at once, without onProposal, and keeps its undo', async () => {
  const { tools, events, asked, getLibrary, base } = await session({ permissions: ALL });
  const results = await tools.execute([
    call('create_collection', { name: 'Japan 2027', parentId: 'travel' }, 'c1'),
    call('move_items', { ids: ['kyoto', 'tokyo'], collectionId: 'new:Japan 2027' }, 'c2'),
    call('create_note', { title: 'Reading list', markdown: 'See [[kyoto]].', collectionId: 'new:Japan 2027' }, 'c3'),
  ]);
  assert.equal(asked.length, 0, 'nobody was asked');
  const proposed = events.find(event => event.type === 'proposal');
  assert.equal(proposed.proposal.autoApproved, true);
  assert.deepEqual(proposed.proposal.changes.map(change => change.label), ['Create collection Travel › Japan 2027', 'Move 2 items to Travel › Japan 2027', 'Create note “Reading list” in Travel › Japan 2027']);
  assert.ok(!statuses(events).includes('Waiting for your review'));
  // The usual result follows the proposal, marked as applied without review, with a working undo.
  const outcome = events.find(event => event.type === 'proposal_result');
  assert.equal(events.indexOf(outcome) > events.indexOf(proposed), true);
  assert.equal(outcome.status, 'applied');
  assert.equal(outcome.autoApproved, true);
  assert.equal(typeof outcome.undo, 'function');
  assert.deepEqual(results.map(result => [parse(result).status, parse(result).appliedWithoutReview]), [['applied', true], ['applied', true], ['applied', true]]);
  const record = tools.proposals[0];
  assert.equal(record.status, 'applied');
  assert.equal(record.autoApproved, true);
  assert.ok(record.undo.createdNotes.length === 1 && record.undo.createdCollections.length === 1);
  const collectionId = parse(results[0]).collectionId;
  assert.equal(byId(await getLibrary(), 'kyoto').collectionId, collectionId);
  // Undo from the plain record (as after a reload) puts everything back.
  await undoChanges(base, JSON.parse(JSON.stringify(record.undo)));
  const reverted = await getLibrary();
  assert.equal(byId(reverted, 'kyoto').collectionId, '');
  assert.equal(byId(reverted, 'tokyo').collectionId, '');
  assert.ok(!reverted.collections.some(collection => collection.id === collectionId));
  assert.ok(!byId(reverted, parse(results[2]).noteId));
});

test('the live undo of an automatic proposal reverts it too', async () => {
  const { tools, events, getLibrary } = await session({ permissions: PERMISSION_PRESETS.trusted });
  await tools.execute([call('add_tags', { ids: ['osaka'], tags: ['castle'] }, 'a'), call('update_item', { id: 'plan', title: 'Trip plan 2027' }, 'b')]);
  assert.deepEqual(byId(await getLibrary(), 'osaka').tags, ['castle']);
  await events.find(event => event.type === 'proposal_result').undo();
  const library = await getLibrary();
  assert.deepEqual(byId(library, 'osaka').tags, []);
  assert.equal(byId(library, 'plan').title, 'Trip plan');
});

test('a proposal that mixes allowed and asking kinds waits for review as a whole', async () => {
  const { tools, events, asked, getLibrary } = await session({ permissions: { create: 'allow' } });
  const results = await tools.execute([call('create_note', { title: 'Summary', markdown: 'Text' }, 'n'), call('add_tags', { ids: ['kyoto'], tags: ['read'] }, 't')]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].autoApproved, undefined);
  assert.equal(events.find(event => event.type === 'proposal').proposal.autoApproved, undefined);
  assert.ok(statuses(events).includes('Waiting for your review'));
  assert.equal(tools.proposals[0].autoApproved, undefined);
  assert.equal(events.find(event => event.type === 'proposal_result').autoApproved, undefined);
  assert.ok(results.every(result => parse(result).status === 'applied' && !('appliedWithoutReview' in parse(result))));
  assert.deepEqual(byId(await getLibrary(), 'kyoto').tags, ['Japan', 'read']);
  // The allowed kind alone applies by itself.
  const [alone] = await tools.execute([call('create_note', { title: 'Second', markdown: 'More' }, 'n2')]);
  assert.equal(parse(alone).appliedWithoutReview, true);
  assert.equal(asked.length, 1);
});

test('adding links to a folder needs Create and Organize when a link is already saved elsewhere', async () => {
  const links = { links: [{ url: 'https://new.example/a' }, { url: 'https://example.com/tokyo' }], collectionId: 'design' };
  const createOnly = await session({ permissions: { create: 'allow' } });
  await createOnly.tools.execute([call('save_links', links, 's')]);
  assert.equal(createOnly.asked.length, 1, 'moving the saved Tokyo link is organizing');
  const both = await session({ permissions: { create: 'allow', organize: 'allow' } });
  const [saved] = await both.tools.execute([call('save_links', links, 's')]);
  assert.equal(both.asked.length, 0);
  assert.equal(parse(saved).appliedWithoutReview, true);
  assert.equal(byId(await both.getLibrary(), 'tokyo').collectionId, 'design');
  const fresh = await session({ permissions: { create: 'allow' } });
  await fresh.tools.execute([call('save_links', { links: [{ url: 'https://new.example/b' }] }, 's')]);
  assert.equal(fresh.asked.length, 0, 'only new links: Create is enough');
});

test('under Trusted, deleting still asks: Trash, collection deletes and delete_tag (which stages remove_tags)', async () => {
  for (const [name, input] of [['trash_items', { ids: ['tokyo'] }], ['delete_collection', { id: 'design' }], ['delete_tag', { tag: 'japan' }]]) {
    const { tools, asked, events } = await session({ permissions: PERMISSION_PRESETS.trusted, decision: 'discard' });
    const [result] = await tools.execute([call(name, input, 'd')]);
    assert.equal(asked.length, 1, `${name} asks`);
    assert.equal(parse(result).status, 'declined', name);
    assert.ok(statuses(events).includes('Waiting for your review'), name);
  }
  // Removing a tag from a few items is organizing, so Trusted applies it; under Full access delete_tag applies too.
  const trusted = await session({ permissions: PERMISSION_PRESETS.trusted });
  await trusted.tools.execute([call('remove_tags', { ids: ['tokyo'], tags: ['food'] }, 'r')]);
  assert.equal(trusted.asked.length, 0);
  const full = await session({ permissions: ALL });
  const [deleted] = await full.tools.execute([call('delete_tag', { tag: 'japan' }, 'd')]);
  assert.equal(full.asked.length, 0);
  assert.equal(parse(deleted).status, 'applied');
  assert.ok((await full.getLibrary()).items.every(item => !(item.tags || []).includes('Japan')));
});

test('every card row names the tools behind it, so a check on the rows agrees with the engine (delete_tag stays a deletion)', async () => {
  // delete_tag stages remove_tags. Under Trusted the engine asks, and its row says delete_tag, so the row asks too.
  const deleting = await session({ permissions: PERMISSION_PRESETS.trusted, decision: 'discard' });
  await deleting.tools.execute([call('delete_tag', { tag: 'japan' }, 'd')]);
  assert.equal(deleting.asked.length, 1);
  assert.deepEqual(deleting.asked[0].changes.map(change => [change.op, change.tools]), [['remove_tags', ['delete_tag']]]);
  assert.equal(autoApproves(deleting.asked[0].changes, PERMISSION_PRESETS.trusted), false);
  // A plain remove_tags and a delete_tag of the same tag share one row, which names both.
  const mixed = await session({ permissions: PERMISSION_PRESETS.trusted, decision: 'discard' });
  await mixed.tools.execute([call('remove_tags', { ids: ['tokyo'], tags: ['Japan'] }, 'r'), call('delete_tag', { tag: 'japan' }, 'd')]);
  assert.deepEqual(mixed.asked[0].changes.map(change => [change.op, change.tools]), [['remove_tags', ['remove_tags', 'delete_tag']]]);
  assert.equal(autoApproves(mixed.asked[0].changes, PERMISSION_PRESETS.trusted), false);
  // An automatic proposal's rows say the same as the engine did, including a new collection and a save that moves a link.
  const trusted = await session({ permissions: PERMISSION_PRESETS.trusted });
  await trusted.tools.execute([
    call('create_collection', { name: 'Japan 2027', parentId: 'travel' }, 'c'),
    call('move_items', { ids: ['kyoto'], collectionId: 'new:Japan 2027' }, 'm'),
    call('save_links', { links: [{ url: 'https://new.example/a' }, { url: 'https://example.com/tokyo' }], collectionId: 'design' }, 's'),
  ]);
  assert.equal(trusted.asked.length, 0);
  const { proposal } = trusted.events.find(event => event.type === 'proposal');
  assert.equal(proposal.autoApproved, true);
  assert.deepEqual(proposal.changes.map(change => [change.op, change.tools]), [['create_collection', ['create_collection']], ['move_items', ['move_items']], ['save_links', ['save_links']], ['move_items', ['save_links']]]);
  assert.equal(autoApproves(proposal.changes, PERMISSION_PRESETS.trusted), true);
  assert.equal(autoApproves(proposal.changes, { create: 'allow' }), false, 'the move a save stages needs Organize on the rows too');
  // Proposal rows survive a save and reload with their tools.
  assert.equal(autoApproves(JSON.parse(JSON.stringify(proposal.changes)), PERMISSION_PRESETS.trusted), true);
});

test('no setting, a malformed setting or an unknown tool never applies anything unreviewed', async () => {
  for (const permissions of [undefined, null, 'allow', true, ['allow'], { create: 'yes', organize: 'auto', edit: true }]) {
    const { tools, asked } = await session({ permissions, decision: 'discard' });
    await tools.execute([call('create_note', { title: 'X', markdown: 'Y' }, 'n')]);
    assert.equal(asked.length, 1, JSON.stringify(permissions ?? null));
  }
  const { tools, asked, events } = await session({ permissions: ALL });
  const [unknown] = await tools.execute([call('wipe_library', {}, 'w')]);
  assert.equal(unknown.isError, true);
  assert.match(parse(unknown).error, /Unknown tool/);
  assert.equal(asked.length, 0);
  assert.ok(!events.some(event => event.type === 'proposal'), 'nothing was proposed or applied');
});

test('automatic proposals have their own cap; past it they go to review, and the review cap still holds', async () => {
  const { tools, asked } = await session({ permissions: { create: 'allow' } });
  const note = n => call('create_note', { title: `Note ${n}`, markdown: 'x' }, `n${n}`);
  for (let n = 1; n <= MAX_AUTO_PROPOSALS_PER_TURN; n++) {
    const [result] = await tools.execute([note(n)]);
    assert.equal(parse(result).appliedWithoutReview, true, `note ${n}`);
  }
  assert.ok(MAX_AUTO_PROPOSALS_PER_TURN > MAX_PROPOSALS_PER_TURN, 'allowed turns are not cut short at the review cap');
  assert.equal(asked.length, 0);
  // The next allowed change falls back to review instead of applying unseen.
  const [next] = await tools.execute([note(99)]);
  assert.equal(asked.length, 1);
  assert.equal(parse(next).status, 'applied');
  assert.ok(!('appliedWithoutReview' in parse(next)));
  for (let n = 1; n < MAX_PROPOSALS_PER_TURN; n++) await tools.execute([call('add_tags', { ids: ['kyoto'], tags: [`t${n}`] }, `t${n}`)]);
  assert.equal(asked.length, MAX_PROPOSALS_PER_TURN);
  const [over] = await tools.execute([note(100)]);
  assert.equal(parse(over).status, 'rejected');
  assert.match(parse(over).message, new RegExp(`already had ${MAX_PROPOSALS_PER_TURN} proposals, the most allowed`));
  assert.equal(asked.length, MAX_PROPOSALS_PER_TURN);
});

test('a proposal over MAX_AUTO_ITEMS items asks even when its kind is allowed; the per-turn caps still hold', async () => {
  // A library with many links, and a page with subpages: enough to cross the size limit.
  const many = Array.from({ length: MAX_AUTO_ITEMS + 5 }, (_, k) => ({ id: `l${k}`, type: 'bookmark', title: `Link ${k}`, url: `https://example.com/l${k}` }));
  const subpages = Array.from({ length: MAX_AUTO_ITEMS }, (_, k) => ({ id: `s${k}`, type: 'note', title: `Sub ${k}`, parentId: 'root' }));
  const big = () => ({ ...seed(), items: [...seed().items, ...many, { id: 'root', type: 'note', title: 'Root' }, ...subpages] });
  const sized = async (permissions, decision = 'apply') => {
    const base = memoryStore(big());
    await base.ready;
    const events = [], asked = [];
    let counter = 0;
    const tools = createToolSession({ getLibrary: () => base.loadLibrary(), searchLibrary: async () => [], store: base, uid: prefix => `${prefix}_${++counter}`, permissions,
      onEvent: event => events.push(event), onProposal: async proposal => { asked.push(proposal); return decision; } });
    return { base, tools, events, asked };
  };
  const ids = n => many.slice(0, n).map(item => item.id);
  const at = await sized(PERMISSION_PRESETS.trusted);
  const [small] = await at.tools.execute([call('add_tags', { ids: ids(MAX_AUTO_ITEMS), tags: ['bulk'] }, 'a')]);
  assert.equal(parse(small).appliedWithoutReview, true, 'exactly at the limit still applies by itself');
  assert.equal(at.asked.length, 0);
  const over = await sized(PERMISSION_PRESETS.trusted);
  const [large] = await over.tools.execute([call('add_tags', { ids: ids(MAX_AUTO_ITEMS + 1), tags: ['bulk'] }, 'a')]);
  assert.equal(over.asked.length, 1, 'one item over the limit goes to review');
  assert.equal(over.asked[0].autoApproved, undefined);
  assert.ok(statuses(over.events).includes('Waiting for your review'));
  assert.equal(parse(large).status, 'applied');
  assert.ok(!('appliedWithoutReview' in parse(large)));
  // Moving one page carries its subpages to the new collection, so they count toward the limit too.
  const tree = await sized(PERMISSION_PRESETS.trusted, 'discard');
  await tree.tools.execute([call('move_items', { ids: ['root'], collectionId: 'design' }, 'm')]);
  assert.equal(tree.asked.length, 1, 'a page with many subpages is a large move');
  const leaf = await sized(PERMISSION_PRESETS.trusted);
  const [moved] = await leaf.tools.execute([call('move_items', { ids: ['s0'], collectionId: 'design' }, 'm')]);
  assert.equal(parse(moved).appliedWithoutReview, true, 'a subpage with no subpages of its own is a small move');
  // Under Full access, trashing the page asks for the same reason.
  const full = await sized(ALL, 'discard');
  await full.tools.execute([call('trash_items', { ids: ['root'] }, 't')]);
  assert.equal(full.asked.length, 1);
  // A large allowed proposal when the review slots are used up is refused, and the model hears why.
  const capped = await sized({ create: 'allow', organize: 'allow' });
  for (let n = 1; n <= MAX_PROPOSALS_PER_TURN; n++) await capped.tools.execute([call('add_tags', { ids: ids(MAX_AUTO_ITEMS + 1), tags: [`t${n}`] }, `t${n}`)]);
  assert.equal(capped.asked.length, MAX_PROPOSALS_PER_TURN);
  const [refused] = await capped.tools.execute([call('add_tags', { ids: ids(MAX_AUTO_ITEMS + 1), tags: ['last'] }, 'last')]);
  assert.equal(parse(refused).status, 'rejected');
  assert.match(parse(refused).message, new RegExp(`more than ${MAX_AUTO_ITEMS} items always needs review`));
  const [still] = await capped.tools.execute([call('add_tags', { ids: ['kyoto'], tags: ['small'] }, 'small')]);
  assert.equal(parse(still).appliedWithoutReview, true, 'small allowed changes still apply');
});

test('unlinking an item from more than MAX_AUTO_ITEMS items that link to it asks, even though unlinking is allowed', async () => {
  const backlinks = Array.from({ length: MAX_AUTO_ITEMS }, (_, k) => ({ id: `b${k}`, type: 'bookmark', title: `Backlink ${k}`, url: `https://example.com/b${k}`, relatedIds: ['hub'] }));
  const linked = async (count, decision = 'discard') => {
    const base = memoryStore({ ...seed(), items: [...seed().items, { id: 'hub', type: 'note', title: 'Hub', content: 'Hub.' }, ...backlinks.slice(0, count)] });
    await base.ready;
    const asked = [];
    let counter = 0;
    const tools = createToolSession({ getLibrary: () => base.loadLibrary(), searchLibrary: async () => [], store: base, uid: prefix => `${prefix}_${++counter}`,
      permissions: PERMISSION_PRESETS.trusted, onEvent: () => {}, onProposal: async proposal => { asked.push(proposal); return decision; } });
    const [result] = await tools.execute([call('unlink_items', { id: 'hub', relatedIds: backlinks.slice(0, count).map(item => item.id) }, 'u')]);
    return { base, asked, result: parse(result) };
  };
  // The hub and 50 items that link to it: 51 items change.
  const over = await linked(MAX_AUTO_ITEMS);
  assert.equal(over.asked.length, 1, 'it waits for review');
  assert.ok(!('appliedWithoutReview' in over.result));
  assert.ok((await over.base.loadLibrary()).items.filter(item => item.id.startsWith('b')).every(item => item.relatedIds.includes('hub')), 'nothing changed before the review');
  // The hub and 49 of them: 50 items, at the limit, apply by themselves from both sides.
  const at = await linked(MAX_AUTO_ITEMS - 1, 'apply');
  assert.equal(at.asked.length, 0);
  assert.equal(at.result.appliedWithoutReview, true);
  assert.ok((await at.base.loadLibrary()).items.filter(item => item.id.startsWith('b')).every(item => !item.relatedIds.includes('hub')));
});

test('when the review slots are used up, allowed changes still apply and others are refused', async () => {
  const { tools, asked } = await session({ permissions: { create: 'allow' } });
  for (let n = 1; n <= MAX_PROPOSALS_PER_TURN; n++) await tools.execute([call('add_tags', { ids: ['kyoto'], tags: [`t${n}`] }, `t${n}`)]);
  assert.equal(asked.length, MAX_PROPOSALS_PER_TURN);
  const [refused, invalid] = await tools.execute([call('archive_items', { ids: ['kyoto'] }, 'a'), call('move_items', { ids: ['kyoto'], collectionId: 'nowhere' }, 'm')]);
  assert.equal(parse(refused).status, 'rejected');
  assert.match(parse(refused).message, /proposals for review, the most allowed\. Only changes the user allows without review can still apply/);
  assert.match(parse(invalid).error, /Unknown collection id/, 'invalid calls still hear why');
  const [note] = await tools.execute([call('create_note', { title: 'Still allowed', markdown: 'x' }, 'n')]);
  assert.equal(parse(note).appliedWithoutReview, true);
  assert.equal(asked.length, MAX_PROPOSALS_PER_TURN);
});

test('after the user declines a proposal, nothing more applies in that turn, allowed or not', async () => {
  const { tools, asked } = await session({ permissions: { create: 'allow' }, decision: 'discard' });
  await tools.execute([call('trash_items', { ids: ['tokyo'] }, 't')]);
  const [after] = await tools.execute([call('create_note', { title: 'Sneaky', markdown: 'x' }, 'n')]);
  assert.equal(parse(after).status, 'rejected');
  assert.match(parse(after).message, /declined/);
  assert.equal(asked.length, 1);
});

test('stopping before an automatic proposal applies changes nothing', async () => {
  const controller = new AbortController();
  controller.abort();
  const { tools, events, getLibrary } = await session({ permissions: ALL, signal: controller.signal });
  const before = JSON.stringify((await getLibrary()).items);
  await assert.rejects(tools.execute([call('archive_items', { ids: ['tokyo'] }, 'a')]), error => error.name === 'AbortError');
  assert.equal(events.find(event => event.type === 'proposal_result').status, 'discarded');
  assert.equal(tools.proposals[0].status, 'discarded');
  assert.equal(JSON.stringify((await getLibrary()).items), before);
});

test('tool descriptions say which changes apply without review, so they stay truthful under each setting', async () => {
  const PROPOSE = /Changes are applied only after the user approves them\./;
  const AUTO = /The user lets this kind of change apply without review: when every change in the step is of a kind they allow and the step changes at most 50 items/;
  const describe = async permissions => new Map((await session({ permissions })).tools.definitions().map(tool => [tool.name, tool.description]));
  const asking = await describe(undefined);
  for (const tool of LIBRARY_TOOLS.filter(entry => entry.access === 'write')) assert.match(asking.get(tool.name) || 'Changes are applied only after the user approves them.', PROPOSE, tool.name);
  const trusted = await describe(PERMISSION_PRESETS.trusted);
  for (const name of ['create_note', 'save_links', 'move_items', 'update_item', 'append_to_note', 'remove_tags']) {
    assert.match(trusted.get(name), AUTO, name);
    assert.doesNotMatch(trusted.get(name), PROPOSE, name);
  }
  for (const name of ['trash_items', 'delete_collection', 'delete_tag']) assert.match(trusted.get(name), PROPOSE, name);
  const createOnly = await describe({ create: 'allow' });
  assert.match(createOnly.get('create_note'), AUTO);
  assert.match(createOnly.get('save_links'), PROPOSE, 'save_links can also move links, which is organizing');
  for (const [name, description] of trusted) if (!LIBRARY_TOOLS.find(tool => tool.name === name && tool.access === 'write')) assert.doesNotMatch(description, AUTO, `${name} is a read`);
});

test('the system prompt says which kinds apply without review, and keeps the review rules otherwise', () => {
  const plain = assistantSystemPrompt({ tools: true, today: '2026-11-01' });
  assert.equal(assistantSystemPrompt({ tools: true, today: '2026-11-01', permissions: PERMISSION_PRESETS.ask }), plain, 'Always ask keeps the prompt as it was');
  assert.match(plain, /Write tools only propose changes\. The user reviews each proposal/);
  const trusted = assistantSystemPrompt({ tools: true, today: '2026-11-01', permissions: PERMISSION_PRESETS.trusted });
  assert.doesNotMatch(trusted, /Write tools only propose changes/);
  assert.match(trusted, /apply without review: Create \(new notes, saved links and collections\); Organize \(.+\); Edit \(.+\); Dashboard \(add widgets to your boards\)\./);
  assert.doesNotMatch(trusted, /Delete \(/, 'Delete still asks under Trusted');
  assert.match(trusted, /appliedWithoutReview; mention briefly that the user can undo it/);
  assert.match(trusted, new RegExp(`A step whose changes are all of those kinds and that changes at most ${MAX_AUTO_ITEMS} items is applied at once`), 'the size limit is stated too');
  assert.match(trusted, /Any other step becomes a proposal the user reviews/);
  assert.match(trusted, /call every write tool for the request together in one step, so it becomes one proposal/);
  assert.match(trusted, /Never say you saved/);
  // Every snake_case word in the prompt is still a real tool.
  const names = new Set(LIBRARY_TOOLS.map(tool => tool.name));
  for (const [name] of trusted.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) if (name !== 'item_id') assert.ok(names.has(name), name);
  assert.equal(assistantSystemPrompt({ tools: false, permissions: PERMISSION_PRESETS.full }), assistantSystemPrompt({ tools: false }), 'without tools nothing changes');
});

test('the assistant reads assistantPermissions once per turn and passes it to the tools and the prompt', async () => {
  const store = memoryStore(seed());
  await store.ready;
  const getLibrary = () => store.loadLibrary();
  const search = createSearch({ getLibrary });
  let reads = 0;
  const requests = [];
  const assistant = createAssistant({
    store, getLibrary, searchLibrary: search.searchLibrary, conversations: createConversationStore({ storage: createMemoryStorage() }), uid: (() => { let n = 0; return prefix => `${prefix}_${++n}`; })(),
    now: () => '2026-11-01T12:00:00.000Z',
    getAiSettings: async () => { reads++; return { chat: { connectionId: 'conn', model: 'claude-opus-5-5' }, assistantPermissions: { create: 'allow' } }; },
    resolveConnection: async id => ({ connection: { id, label: 'Anthropic' }, provider: { id: 'anthropic', name: 'Anthropic', supports: { tools: true } }, via: 'direct' }),
    streamChat: async request => {
      requests.push(request);
      if (requests.length === 1) return { text: '', toolCalls: [{ id: 't1', name: 'create_note', input: { title: 'Summary', markdown: 'Done.' } }], stopReason: 'tool_use' };
      return { text: 'Created the note. You can undo it from the chat.', toolCalls: [], stopReason: 'end_turn' };
    },
  });
  const events = [];
  const { message } = await assistant.runAssistant({ input: 'Write a summary note', onEvent: event => events.push(event), onProposal: async () => { throw new Error('must not ask'); } });
  assert.equal(reads, 1);
  assert.match(requests[0].system, /apply without review: Create \(new notes, saved links and collections\)\./);
  assert.match(requests[0].tools.find(tool => tool.name === 'create_note').description, /apply without review/);
  assert.match(requests[0].tools.find(tool => tool.name === 'trash_items').description, /only after the user approves/);
  assert.equal(message.proposals.length, 1);
  assert.equal(message.proposals[0].status, 'applied');
  assert.equal(message.proposals[0].autoApproved, true, 'the saved proposal says it was applied automatically');
  assert.deepEqual(message.proposals[0].changes.map(change => change.tools), [['create_note']], 'its rows keep the tools behind them');
  assert.ok(message.proposals[0].undo?.createdNotes?.length, 'and keeps its undo record');
  assert.ok(events.some(event => event.type === 'proposal' && event.proposal.autoApproved));
  assert.equal(JSON.parse(requests[1].messages.at(-1).content[0].content).appliedWithoutReview, true);
});

test('create_note takes an optional parent_id: a subpage of any live item, in its collection unless another is named', async () => {
  const saved = [];
  const { tools, asked, getLibrary } = await session({ store: base => ({ ...base, saveItem: input => { saved.push(input); return base.saveItem(input); } }) });
  const results = await tools.execute([
    call('create_note', { title: 'Castle notes', markdown: 'Moat.', parent_id: 'osaka' }, 'a'),
    call('create_note', { title: 'Temple notes', markdown: 'Gardens.', parent_id: 'kyoto', collectionId: 'design' }, 'b'),
  ]);
  const labels = asked[0].changes.map(change => change.label);
  assert.deepEqual(labels, ['Create subpage “Castle notes” in “Osaka castle”', 'Create subpage “Temple notes” in “Kyoto temples”']);
  assert.equal(asked[0].changes[0].note.parentId, 'osaka');
  assert.deepEqual(results.map(result => [parse(result).status, parse(result).parentId]), [['applied', 'osaka'], ['applied', 'kyoto']]);
  assert.deepEqual(saved.map(input => [input.parentId, input.collectionId]), [['osaka', 'travel'], ['kyoto', 'design']], 'a subpage joins its parent’s collection unless one is named');
  const library = await getLibrary();
  assert.equal(byId(library, parse(results[0]).noteId).parentId, 'osaka');
  assert.equal(byId(library, parse(results[0]).noteId).collectionId, 'travel');
  // The parent must be a saved item that is not in Trash.
  const [trashed, missing, plain] = await tools.execute([
    call('create_note', { title: 'X', markdown: 'x', parent_id: 'gone' }, 'c'),
    call('create_note', { title: 'Y', markdown: 'y', parent_id: 'nope' }, 'd'),
    call('create_note', { title: 'Z', markdown: 'z', parent_id: '' }, 'e'),
  ]);
  assert.match(parse(trashed).error, /parent item does not exist or is in Trash/);
  assert.match(parse(missing).error, /parent item does not exist or is in Trash/);
  assert.equal(parse(plain).status, 'applied');
  assert.equal(saved.at(-1).parentId, undefined, 'no parent_id, no parentId field');
  // get_items reports the parent so the model can see the page tree.
  const [read] = await tools.execute([call('get_items', { ids: [parse(results[0]).noteId, 'osaka'] }, 'r')]);
  assert.deepEqual(parse(read).items.map(item => item.parentId), ['osaka', undefined]);
});

test('a proposal that trashes a page and tags its subpage trashes the whole tree, and undo brings it all back', async () => {
  const { tools, base, getLibrary } = await session({ permissions: ALL });
  const page = await base.saveItem({ type: 'note', title: 'Page', content: 'Top.' });
  const sub = await base.saveItem({ type: 'note', title: 'Subpage', content: 'Middle.', parentId: page.id });
  const leaf = await base.saveItem({ type: 'note', title: 'Leaf', content: 'Bottom.', parentId: sub.id });
  const results = await tools.execute([call('trash_items', { ids: [page.id] }, 't'), call('add_tags', { ids: [sub.id], tags: ['keep'] }, 'a')]);
  assert.deepEqual(results.map(result => parse(result).status), ['applied', 'applied']);
  const library = await getLibrary();
  const stamp = byId(library, page.id).deletedAt;
  assert.ok(stamp);
  for (const id of [sub.id, leaf.id]) assert.equal(byId(library, id).deletedAt, stamp, id);
  assert.deepEqual(byId(library, sub.id).tags, ['keep']);
  await undoChanges(base, JSON.parse(JSON.stringify(tools.proposals[0].undo)));
  const reverted = await getLibrary();
  for (const id of [page.id, sub.id, leaf.id]) assert.equal(byId(reverted, id).deletedAt, null, id);
  assert.deepEqual(byId(reverted, sub.id).tags, []);
  assert.equal(byId(reverted, sub.id).parentId, page.id);
});

test('AI undo removes created notes newest first and skips ids already removed', async () => {
  const { tools, base, getLibrary } = await session();
  const results = await tools.execute([
    call('create_note', { title: 'First', markdown: 'one' }, 'a'),
    call('create_note', { title: 'Second', markdown: 'two' }, 'b'),
    call('create_note', { title: 'Third', markdown: 'three' }, 'c'),
    call('save_links', { links: [{ url: 'https://new.example/x' }] }, 'd'),
  ]);
  const [first, second, third] = results.slice(0, 3).map(result => parse(result).noteId);
  const link = parse(results[3]).items[0].id;
  const record = JSON.parse(JSON.stringify(tools.proposals[0].undo));
  assert.deepEqual(record.createdNotes.map(entry => entry.id), [first, second, third]);
  // The user already deleted the second note for good; undo must not stumble over it.
  await base.permanentlyDeleteItem(second);
  const removed = [];
  const spy = { ...base, permanentlyDeleteItem: (id, options) => { removed.push(id); return base.permanentlyDeleteItem(id, options); } };
  await undoChanges(spy, record);
  assert.deepEqual(removed, [third, first, link], 'notes newest first, then links; the removed one is skipped');
  const library = await getLibrary();
  for (const id of [first, second, third, link]) assert.ok(!byId(library, id), id);
  // Running the same undo again finds everything gone and reports no failure.
  await undoChanges(spy, record);
  assert.deepEqual(removed, [third, first, link]);
});
