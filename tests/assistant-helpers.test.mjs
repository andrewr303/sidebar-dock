import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterConversations, plainPreview, latestAnswer, unansweredQuestion, conversationMarkdown, markdownFileName, conversationIdOf,
  historyGroups, CONVERSATION_BODY_PREFIX, appliedLines, excludedByChange, proposalDecision, noteSnippet, changeSub, changeLabel, changeIcon,
  WRITE_TOOLS, suggestionsFor,
} from '../extension/ui/ai-panel.js';
import { createConversationStore, createMemoryStorage, CONVERSATIONS_KEY } from '../extension/lib/ai/conversations.js';
import { LIBRARY_TOOLS } from '../extension/lib/ai/tools.js';
import { hasIcon } from '../extension/ui/icons.js';

const history = [
  { id: 'a', title: 'Café recommendations in Kyoto', preview: 'Three quiet places near the river.' },
  { id: 'b', title: 'Digest of Design', preview: 'Minimalism and practical typography lead the collection.' },
  { id: 'c', title: 'Suggest tags for Inbox', preview: '' },
];

test('chat search matches every word in the title or the last answer, ignoring case and accents', () => {
  assert.deepEqual(filterConversations(history, '').map(entry => entry.id), ['a', 'b', 'c']);
  assert.deepEqual(filterConversations(history, '   ').map(entry => entry.id), ['a', 'b', 'c']);
  assert.deepEqual(filterConversations(history, 'cafe').map(entry => entry.id), ['a']);
  assert.deepEqual(filterConversations(history, 'KYOTO river').map(entry => entry.id), ['a']);
  assert.deepEqual(filterConversations(history, 'typography design').map(entry => entry.id), ['b']);
  assert.deepEqual(filterConversations(history, 'design tokyo'), []);
  assert.deepEqual(filterConversations(null, 'x'), []);
  assert.deepEqual(filterConversations([{ id: 'x' }], 'x'), [], 'entries without text never match a query');
});

test('previews drop citations, links and Markdown marks', () => {
  assert.equal(plainPreview('Start with **Building effective agents** [[effective-agents]]. It is short.'), 'Start with Building effective agents. It is short.');
  assert.equal(plainPreview('See [the guide](https://example.com/a) and `code`'), 'See the guide and code');
  assert.equal(plainPreview('## Heading\n\n> quoted   text'), 'Heading quoted text');
  assert.equal(plainPreview(undefined), '');
});

test('the latest answer is the last assistant message with text or still being written', () => {
  const messages = [
    { id: 'q1', role: 'user', text: 'one' }, { id: 'a1', role: 'assistant', text: 'first' },
    { id: 'q2', role: 'user', text: 'two' }, { id: 'a2', role: 'assistant', text: '', error: 'Stopped' },
  ];
  assert.equal(latestAnswer(messages)?.id, 'a1', 'an empty stopped answer is skipped');
  assert.equal(latestAnswer([...messages, { id: 'a3', role: 'assistant', text: '', live: true }])?.id, 'a3');
  assert.equal(latestAnswer([]), null);
  assert.equal(latestAnswer(undefined), null);
});

test('a question at the end of a conversation is unanswered', () => {
  assert.equal(unansweredQuestion([{ id: 'q', role: 'user', text: 'x' }])?.id, 'q');
  assert.equal(unansweredQuestion([{ id: 'q', role: 'user' }, { id: 'a', role: 'assistant' }]), null);
  assert.equal(unansweredQuestion([]), null);
});

test('a conversation exports as Markdown with quoted questions and linked citations', () => {
  const conversation = {
    title: 'Agents [draft]',
    messages: [
      { role: 'user', text: 'What did I save about agents?\n\nKeep it short.' },
      { role: 'assistant', text: 'Start with the essay [[effective-agents]] and your notes [[note-agents]] .', citations: [
        { n: 1, id: 'effective-agents', title: 'Building effective agents', url: 'https://www.anthropic.com/engineering/building-effective-agents' },
        { n: 2, id: 'note-agents', title: 'Notes on agent patterns', url: '' },
      ] },
      { role: 'user', text: 'And then?' },
      { role: 'assistant', text: '', error: 'Rate limited. Try again in a minute.' },
      { role: 'user', text: 'Stop' },
      { role: 'assistant', text: '', error: 'Stopped' },
    ],
  };
  const markdown = conversationMarkdown(conversation);
  assert.equal(markdown, [
    '# Agents draft',
    '',
    '> **You:** What did I save about agents?\n>\n> Keep it short.',
    '',
    'Start with the essay [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) and your notes Notes on agent patterns.',
    '',
    '> **You:** And then?',
    '',
    '_The answer did not finish: Rate limited. Try again in a minute._',
    '',
    '> **You:** Stop',
    '',
  ].join('\n'));
  const note = conversationMarkdown(conversation, { links: 'wiki', title: false, isItem: id => id === 'note-agents' });
  assert.ok(note.startsWith('> **You:**'), 'notes keep their own title');
  assert.ok(note.includes('your notes [[Notes on agent patterns]].'), 'saved items become note links');
  assert.equal(conversationMarkdown({ messages: [] }), '# Assistant chat\n');
});

test('downloaded chats get a short, safe file name', () => {
  assert.equal(markdownFileName('What did I save about building agents?'), 'what-did-i-save-about-building-agents.md');
  assert.equal(markdownFileName('Café / Kyoto: day 1'), 'cafe-kyoto-day-1.md');
  assert.equal(markdownFileName(''), 'assistant-chat.md');
  assert.equal(markdownFileName('???'), 'assistant-chat.md');
  const long = markdownFileName('word '.repeat(40));
  assert.ok(long.length <= 63 && !long.includes('-.md'), long);
});

test('the open conversation id falls back to the id a running answer is creating', () => {
  assert.equal(conversationIdOf({ conversation: { id: 'c1' }, run: { conversationId: 'c2' } }), 'c1');
  assert.equal(conversationIdOf({ conversation: null, run: { conversationId: 'c2' } }), 'c2');
  assert.equal(conversationIdOf({ conversation: null, run: null }), '');
  assert.equal(conversationIdOf(undefined), '');
});

test('history groups put conversations under the day they were last active', () => {
  const now = new Date(2026, 9, 30, 15, 0, 0);
  const at = (days, hours = 0) => new Date(now.getTime() - days * 86400000 - hours * 3600000).toISOString();
  const groups = historyGroups([{ id: 'a', updatedAt: at(0, 1) }, { id: 'b', updatedAt: at(1) }, { id: 'c', updatedAt: at(3) }, { id: 'd', updatedAt: at(20) }, { id: 'e', updatedAt: at(90) }], now);
  assert.deepEqual(groups.map(group => [group.label, group.items.map(entry => entry.id)]),
    [['Today', ['a']], ['Yesterday', ['b']], ['Previous 7 days', ['c']], ['Previous 30 days', ['d']], ['Older', ['e']]]);
});

test('pages watch the keys the conversation store writes', async () => {
  const storage = createMemoryStorage();
  const store = createConversationStore({ storage, locks: null });
  const saved = await store.saveConversation({ id: 'conversation_x', messages: [{ role: 'user', text: 'Hello' }] });
  assert.ok(storage.map.has(CONVERSATIONS_KEY));
  assert.ok(storage.map.has(CONVERSATION_BODY_PREFIX + saved.id), 'the body key the assistant pages follow');
  // A conversation saved under an id chosen before the answer starts keeps that id.
  assert.equal(saved.id, 'conversation_x');
});

// ------------------------------------------------------------------------------------------------ proposal cards

const flatText = fragment => String(fragment).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const linksProposal = () => ({
  id: 'proposal_links',
  changes: [
    { op: 'create_collection', label: 'Create collection API Consoles', itemIds: [], count: 0, collectionId: 'collection_new', collectionName: 'API Consoles' },
    { op: 'save_links', label: 'Save 3 links to API Consoles', itemIds: ['item_aws', 'item_azure', 'item_gcp'], count: 3, collectionId: 'collection_new', collectionName: 'API Consoles',
      items: [{ id: 'item_aws', title: 'AWS Console', url: 'https://console.aws.amazon.com/console/home?region=us-east-1#/dash_board' },
        { id: 'item_azure', title: '', url: 'https://portal.azure.com/#home' }, { id: 'item_gcp', title: 'GCP', url: 'https://console.cloud.google.com/?authuser=0' }],
      links: [{ id: 'item_aws', url: 'https://console.aws.amazon.com/console/home?region=us-east-1#/dash_board', title: 'AWS Console', tags: ['cloud'] },
        { id: 'item_azure', url: 'https://portal.azure.com/#home', title: '', tags: ['Cloud', 'azure'] }, { id: 'item_gcp', url: 'https://console.cloud.google.com/?authuser=0', title: 'GCP', tags: [] }] },
    { op: 'convert_items', label: 'Turn 2 notes into links', itemIds: ['note_a', 'note_b'], count: 2, items: [{ id: 'note_a', title: 'AWS' }, { id: 'note_b', title: 'Azure' }], type: 'bookmark' },
    { op: 'trash_items', label: 'Move 2 items to Trash', itemIds: ['note_b', 'note_c'], count: 2, items: [{ id: 'note_b', title: 'Azure' }, { id: 'note_c', title: 'Old list' }] },
    { op: 'add_dashboard_widget', label: 'Show API Consoles on the dashboard', itemIds: [], count: 0, collectionId: 'collection_new', collectionName: 'API Consoles', boardId: 'board_main', boardName: 'Main' },
  ],
});

test('every write tool the engine offers is hidden from the tool-step rows', () => {
  for (const name of ['save_links', 'convert_items', 'update_item', 'restore_items', 'unarchive_items', 'update_collection', 'delete_collection', 'rename_tag', 'delete_tag',
    'link_items', 'unlink_items', 'show_collection_on_dashboard', 'create_note', 'create_collection']) assert.ok(WRITE_TOOLS.has(name), name);
  for (const tool of LIBRARY_TOOLS.filter(entry => entry.access === 'write')) assert.ok(WRITE_TOOLS.has(tool.name), `${tool.name} is a write tool the panel would show as a step`);
  for (const tool of LIBRARY_TOOLS.filter(entry => entry.access === 'read')) assert.ok(!WRITE_TOOLS.has(tool.name), `${tool.name} is a read step`);
});

test('every proposal op has an icon that exists', () => {
  const ops = ['create_collection', 'move_items', 'add_tags', 'remove_tags', 'set_favorite', 'archive_items', 'trash_items', 'create_note', 'append_to_note', 'update_item',
    'save_links', 'convert_items', 'restore_items', 'unarchive_items', 'update_collection', 'delete_collection', 'rename_tag', 'link_items', 'unlink_items', 'add_dashboard_widget'];
  for (const op of ops) {
    assert.notEqual(changeIcon(op), 'circle', `${op} has its own icon`);
    assert.ok(hasIcon(changeIcon(op)), `${op} icon ${changeIcon(op)} exists`);
  }
  assert.equal(changeIcon('some_future_op'), 'circle');
  assert.ok(hasIcon('circle'));
});

test('receipts put every new label in the past tense', () => {
  const lines = appliedLines({ changes: [
    { op: 'save_links', label: 'Save 17 links to API Consoles', itemIds: [], count: 17 },
    { op: 'save_links', label: 'Save 1 link to Inbox', itemIds: [], count: 1 },
    { op: 'convert_items', label: 'Turn 3 notes into links', count: 3 },
    { op: 'convert_items', label: 'Change 2 items to article', count: 2 },
    { op: 'restore_items', label: 'Restore 2 items from Trash', count: 2 },
    { op: 'unarchive_items', label: 'Unarchive 4 items', count: 4 },
    { op: 'update_collection', label: 'Rename collection A to B', count: 0 },
    { op: 'update_collection', label: 'Update collection A', count: 0 },
    { op: 'delete_collection', label: 'Delete collection Old (3 items move to Inbox)', count: 0 },
    { op: 'delete_collection', label: 'Delete collection Tiny (1 item moves to Inbox)', count: 0 },
    { op: 'rename_tag', label: 'Rename tag #a to #b on 5 items', count: 5 },
    { op: 'link_items', label: 'Link “A” to 2 items', count: 1 },
    { op: 'unlink_items', label: 'Unlink “A” from 2 items', count: 1 },
    { op: 'add_dashboard_widget', label: 'Show Work › API on the dashboard', count: 0 },
    { op: 'create_note', label: 'Create note “X” in Y', count: 1 },
    { op: 'mystery', label: 'Frobnicate 2 items', count: 2 },
  ] });
  assert.deepEqual(lines, ['Saved 17 links to API Consoles', 'Saved 1 link to Inbox', 'Turned 3 notes into links', 'Changed 2 items to article', 'Restored 2 items from Trash',
    'Unarchived 4 items', 'Renamed collection A to B', 'Updated collection A', 'Deleted collection Old (3 items moved to Inbox)', 'Deleted collection Tiny (1 item moved to Inbox)',
    'Renamed tag #a to #b on 5 items', 'Linked “A” to 2 items', 'Unlinked “A” from 2 items', 'Added Work › API to the dashboard', 'Created note “X” in Y', 'Frobnicate 2 items']);
});

test('an excluded item leaves every change it is in, and receipts count what is left', () => {
  const proposal = linksProposal();
  assert.deepEqual([...excludedByChange(proposal, ['note_b', 'unknown'])].map(([index, set]) => [index, [...set]]), [[2, ['note_b']], [3, ['note_b']]]);
  assert.deepEqual(appliedLines(proposal, ['item_azure', 'note_b']), ['Created collection API Consoles', 'Saved 2 links to API Consoles', 'Turned 1 note into links',
    'Moved 1 item to Trash', 'Added API Consoles to the dashboard']);
  // The same through a per-change Map (the older call shape) and through a Set.
  assert.deepEqual(appliedLines(proposal, excludedByChange(proposal, new Set(['item_azure']))), appliedLines(proposal, ['item_azure']));
  // A change left with nothing is dropped from the receipt.
  assert.deepEqual(appliedLines(proposal, ['note_a', 'note_b']), ['Created collection API Consoles', 'Saved 3 links to API Consoles', 'Moved 1 item to Trash',
    'Added API Consoles to the dashboard']);
  assert.deepEqual(appliedLines(proposal), ['Created collection API Consoles', 'Saved 3 links to API Consoles', 'Turned 2 notes into links', 'Moved 2 items to Trash',
    'Added API Consoles to the dashboard']);
});

test('Apply sends the engine the unchecked ids, plain apply without any, and discards when nothing is left', () => {
  const proposal = linksProposal();
  assert.equal(proposalDecision(proposal, []), 'apply');
  assert.equal(proposalDecision(proposal, new Set()), 'apply');
  assert.deepEqual(proposalDecision(proposal, new Set(['item_azure', 'not_in_any_change'])), { decision: 'apply', exclude: ['item_azure'] });
  assert.deepEqual(proposalDecision(proposal, ['note_b', 'note_b', 'item_gcp']), { decision: 'apply', exclude: ['note_b', 'item_gcp'] });
  const only = { changes: [{ op: 'save_links', label: 'Save 2 links to Inbox', itemIds: ['a', 'b'], count: 2 }] };
  assert.equal(proposalDecision(only, ['a', 'b']), 'discard', 'every link left out: nothing to apply');
  assert.deepEqual(proposalDecision(only, ['a']), { decision: 'apply', exclude: ['a'] });
});

test('note previews keep web addresses whole while removing Markdown marks', () => {
  const markdown = '# API Consoles\n\n- **AWS**: https://console.aws.amazon.com/console/home?region=us-east-1#/dash_board_x\n'
    + '- [Azure portal](https://portal.azure.com/#home) _quick_\n> see [[item_1]] and <https://example.com/a_b_c>\n1. `snake_case` (https://en.wikipedia.org/wiki/Foo_(bar)).';
  const snippet = noteSnippet(markdown, 400);
  assert.equal(snippet, 'API Consoles AWS: https://console.aws.amazon.com/console/home?region=us-east-1#/dash_board_x Azure portal quick see and https://example.com/a_b_c snake_case (https://en.wikipedia.org/wiki/Foo_(bar)).');
  for (const url of ['https://console.aws.amazon.com/console/home?region=us-east-1#/dash_board_x', 'https://example.com/a_b_c', 'https://en.wikipedia.org/wiki/Foo_(bar)']) {
    assert.ok(snippet.includes(url), `${url} is intact`);
  }
  // Shortened at a word boundary, never inside an address.
  const short = noteSnippet(markdown, 40);
  assert.equal(short, 'API Consoles AWS:…');
  assert.equal(noteSnippet('https://signin.aws.amazon.com/oauth?client_id=arn_aws_signin&code_challenge=abc_def#x', 20), 'https://signin.aws.amazon.com/oauth?client_id=arn_aws_signin&code_challenge=abc_def#x',
    'an address longer than the limit is still shown whole');
  assert.equal(noteSnippet(''), '');
  assert.equal(noteSnippet(undefined), '');
});

test('proposal rows describe the new ops: links with domains, fields, collections and the dashboard', () => {
  const ctx = {
    select: { byId: id => ({ rel_1: { id: 'rel_1', title: 'Kyoto guide' } })[id] || null, path: id => id === 'collection_work' ? [{ id, name: 'Work' }] : [], collection: () => null },
    library: { items: [{ id: 'i1', collectionId: 'collection_old' }, { id: 'i2', collectionId: 'collection_old', deletedAt: '2026-01-01' }], collections: [{ id: 'kid', parentId: 'collection_old' }] },
  };
  const proposal = linksProposal();
  const save = proposal.changes[1];
  assert.equal(changeSub(ctx, save), 'AWS Console (console.aws.amazon.com), portal.azure.com, GCP (console.cloud.google.com) · Tagged #cloud #azure');
  assert.equal(changeSub(ctx, { ...save, count: 17 }), 'AWS Console (console.aws.amazon.com), portal.azure.com, GCP (console.cloud.google.com) and 14 more · Tagged #cloud #azure');
  assert.equal(changeSub(ctx, save, new Set(['item_aws'])), 'portal.azure.com, GCP (console.cloud.google.com) · Tagged #Cloud #azure');
  assert.equal(flatText(changeLabel(ctx, save, 2, new Set(['collection_new']))), 'Save 2 links to API ConsolesNew');
  assert.equal(flatText(changeLabel(ctx, proposal.changes[2], 1)), 'Turn 1 note into links', 'engine wording, recounted');
  assert.equal(changeSub(ctx, proposal.changes[2]), 'AWS, Azure');
  assert.equal(flatText(changeLabel(ctx, proposal.changes[4], 0, new Set(['collection_new']))), 'Show API ConsolesNew on the dashboard');
  assert.equal(changeSub(ctx, proposal.changes[4]), 'Adds a links widget to the Main board');

  // The engine label names the fields; the second line gives the new values, the address whole.
  const update = { op: 'update_item', label: 'Update “Docs”: title, link, note, pin, read state and reminder', itemIds: ['x'], count: 1, items: [{ id: 'x', title: 'Docs' }],
    patch: { title: 'API docs', url: 'https://docs.example.com/a_b?c=d#e', content: '**New** body', pinned: true, read: false, reminderAt: '' } };
  assert.equal(changeSub(ctx, update), 'Title “API docs” · https://docs.example.com/a_b?c=d#e · Pinned · Unread · No reminder · New body');
  assert.equal(flatText(changeLabel(ctx, update, 1)), update.label, 'the engine wording');
  assert.equal(changeSub(ctx, { op: 'update_item', label: 'Rename “A” to “B”', itemIds: ['x'], count: 1, title: 'B' }), '', 'a lone rename is already the label');
  assert.equal(changeSub(ctx, { op: 'update_item', label: 'Change the link of “A”', itemIds: ['x'], count: 1, patch: { url: 'https://a.dev/?utm_source=x&sig=a_b' } }),
    'https://a.dev/?utm_source=x&sig=a_b', 'the new address exactly as it will be saved');
  assert.equal(changeSub(ctx, { op: 'update_item', label: 'Pin “A”', itemIds: ['x'], count: 1, patch: { pinned: true } }), '');
  assert.match(changeSub(ctx, { op: 'update_item', label: 'Set a reminder on “A”', itemIds: ['x'], count: 1, patch: { reminderAt: '2026-11-03T09:00:00.000Z' } }), /^Reminder \S/);

  const created = new Map([['collection_new', 'API Consoles']]);
  const renameOnly = { op: 'update_collection', label: 'Rename collection Work to Projects', itemIds: [], count: 0, collectionId: 'collection_work', collectionName: 'Work', patch: { name: 'Projects' } };
  assert.equal(flatText(changeLabel(ctx, renameOnly, 0)), 'Rename Work to “Projects”');
  assert.equal(changeSub(ctx, renameOnly), '');
  const moveOnly = { ...renameOnly, label: 'Move collection Work into API Consoles', patch: { parentId: 'collection_new' } };
  assert.equal(flatText(changeLabel(ctx, moveOnly, 0, new Set(['collection_new']), created)), 'Move Work into API ConsolesNew');
  assert.equal(flatText(changeLabel(ctx, { ...moveOnly, patch: { parentId: '' } }, 0)), 'Move Work to the top level');
  assert.equal(flatText(changeLabel(ctx, { ...moveOnly, patch: { pinned: false } }, 0)), 'Unpin Work');
  const several = { ...renameOnly, label: 'Update collection Work: name, icon, color, parent and description',
    patch: { name: 'Projects', icon: 'briefcase', color: '#3366ff', parentId: 'collection_new', description: 'Client work and **specs**' } };
  assert.equal(flatText(changeLabel(ctx, several, 0)), 'Update Work: name, icon, color, parent and description');
  assert.equal(changeSub(ctx, several, new Set(), { created }), 'Name “Projects” · Moves into API Consoles · Icon briefcase · Color #3366ff · Description “Client work and specs”');

  const remove = { op: 'delete_collection', label: 'Delete collection Old (4 items move to Inbox, 1 sub-collection move up a level)', itemIds: [], count: 0,
    collectionId: 'collection_old', collectionName: 'Old', itemCount: 4, childCount: 1 };
  assert.equal(changeSub(ctx, remove), '4 items move to Inbox · 1 sub-collection moves up a level', 'the engine counts');
  assert.equal(changeSub(ctx, { ...remove, itemCount: undefined, childCount: undefined }), '1 item moves to Inbox · 1 sub-collection moves up a level',
    'an older record is counted from the library, without trashed items');
  assert.equal(flatText(changeLabel(ctx, remove, 0)), 'Delete collection Old');
  assert.deepEqual(appliedLines({ changes: [remove] }), ['Deleted collection Old (4 items moved to Inbox, 1 sub-collection moved up a level)']);

  const tag = { op: 'rename_tag', label: 'Rename tag #js to #javascript on 3 items', itemIds: ['a', 'b', 'c'], count: 3, items: [{ id: 'a', title: 'A' }], from: 'js', to: 'javascript' };
  assert.equal(flatText(changeLabel(ctx, tag, 2)), 'Rename #js to #javascript on 2 items');
  assert.equal(flatText(changeLabel(ctx, { ...tag, from: '' }, 2)), 'Rename tag #js to #javascript on 2 items', 'falls back to the engine label');

  const link = { op: 'link_items', label: 'Link “Plan” to 2 items', itemIds: ['plan'], count: 1, items: [{ id: 'plan', title: 'Plan' }], relatedIds: ['rel_1', 'rel_gone'] };
  assert.equal(flatText(changeLabel(ctx, link, 1)), 'Link “Plan” to 2 items');
  assert.equal(changeSub(ctx, link), 'Kyoto guide and 1 more');
  assert.equal(changeSub(ctx, { ...link, related: [{ id: 'rel_gone', title: 'Old essay' }] }), 'Kyoto guide, Old essay', 'titles the engine listed');

  const restore = { op: 'restore_items', label: 'Restore 3 items from Trash', itemIds: ['a', 'b', 'c'], count: 3, items: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }] };
  assert.equal(flatText(changeLabel(ctx, restore, 2)), 'Restore 2 items from Trash');
  assert.equal(changeSub(ctx, restore, new Set(['b'])), 'A, C');
  assert.equal(flatText(changeLabel(ctx, { op: 'brand_new_op', label: 'Do something new', itemIds: [], count: 0 }, 0)), 'Do something new', 'unknown ops stay visible');
  assert.equal(flatText(changeLabel(ctx, { op: 'brand_new_op' }, 0)), 'brand new op');
});

test('a new note row previews its text without corrupting the addresses in it', () => {
  const ctx = { select: { byId: () => null, path: () => [] } };
  const note = { op: 'create_note', label: 'Create note “API Consoles”', itemIds: [], count: 1,
    note: { id: 'n', title: 'API Consoles', markdown: '## Consoles\n- AWS: https://console.aws.amazon.com/?state=hash_args#x\n- *Azure*: https://portal.azure.com/#@tenant_name' } };
  assert.equal(changeSub(ctx, note), 'Consoles AWS: https://console.aws.amazon.com/?state=hash_args#x Azure: https://portal.azure.com/#@tenant_name');
  assert.equal(changeSub(ctx, { ...note, note: { ...note.note, sticky: 'yellow', tags: ['aws'] } }).split(' · ').slice(0, 2).join(' · '), 'Yellow sticky note on the dashboard · Tagged #aws');
  assert.equal(changeSub(ctx, { op: 'append_to_note', label: 'Append to “Log”', itemIds: ['log'], count: 1, note: { id: 'log', markdown: '- [ ] Check https://a.dev/x_y' } }), 'Check https://a.dev/x_y');
});

test('the library starting points include saving pasted links into a collection', () => {
  const suggestion = suggestionsFor('library').find(entry => entry.icon === 'bookmark-plus');
  assert.ok(suggestion, 'a links suggestion is offered');
  assert.equal(suggestion.label, 'Save these links into a collection');
  assert.ok(suggestion.prompt.includes('…'), 'a template the person finishes (the collection name), not sent at once');
  assert.ok(suggestion.prompt.endsWith('\n'), 'the links are pasted on the next line');
});
