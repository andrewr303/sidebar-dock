import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterConversations, plainPreview, latestAnswer, unansweredQuestion, conversationMarkdown, markdownFileName, conversationIdOf,
  historyGroups, CONVERSATION_BODY_PREFIX,
} from '../extension/ui/ai-panel.js';
import { createConversationStore, createMemoryStorage, CONVERSATIONS_KEY } from '../extension/lib/ai/conversations.js';

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
