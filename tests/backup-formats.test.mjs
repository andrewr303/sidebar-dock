import test from 'node:test';
import assert from 'node:assert/strict';
import { exportItemsCsv, importPortableFile, parseCsv, CSV_COLUMNS, exportConversationsMarkdown, exportChatsMarkdown } from '../extension/lib/portability.js';
import { createLibraryStore } from '../extension/lib/store.js';
import { createConversationStore, createMemoryStorage } from '../extension/lib/ai/conversations.js';

function device(seed = { schemaVersion: 1, items: [], collections: [], settings: {} }) {
  let library = structuredClone(seed);
  const core = createLibraryStore({ read: async () => library, write: async value => { library = value; } });
  return {
    get library() { return library; },
    store: {
      exportLibrary: () => core.dispatch('exportLibrary'), importLibrary: (value, options) => core.dispatch('importLibrary', [value, options]),
      async getAttachment() { return null; }, async saveAttachment() { throw new Error('no files in CSV'); }, async deleteAttachment() {},
    },
  };
}
const options = { dashboard: null, conversations: null, aiConfig: null, snapshot: null };
const csvFile = (text, name = 'still-items.csv') => new File([text], name, { type: 'text/csv' });
const pathOf = (library, id) => {
  const names = [];
  for (let c = library.collections.find(entry => entry.id === id); c; c = library.collections.find(entry => entry.id === c.parentId)) names.unshift(c.name);
  return names.join(' / ');
};

const library = () => ({ schemaVersion: 1, settings: {},
  collections: [{ id: 'root', name: 'Research', parentId: '' }, { id: 'deep', name: 'Deeper', parentId: 'root' }],
  items: [
    { id: 'b', type: 'bookmark', title: 'Useful, "quoted" link', url: 'https://example.com/?a=1&b=2', tags: ['design', 'ideas'], content: 'Line one\nLine two', excerpt: 'Short', collectionId: 'deep',
      createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-02-03T04:05:06.000Z' },
    { id: 'n', type: 'note', title: '=SUM(A1:A2)', content: '- [ ] a task', collectionId: 'root', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-02T00:00:00.000Z' },
    { id: 'r', type: 'article', title: 'An article', url: 'https://example.com/read', tags: [] },
    { id: 't', type: 'bookmark', title: 'In the trash', url: 'https://example.com/t', deletedAt: '2026-04-01T00:00:00.000Z' },
  ] });

test('CSV export writes the documented columns, escapes formulas and skips Trash', () => {
  const csv = exportItemsCsv(library());
  assert.ok(csv.startsWith('﻿url,title,tags,note,excerpt,type,collection,created,updated\r\n'));
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], [...CSV_COLUMNS]);
  assert.equal(rows.length, 4, 'header plus three items; the trashed one is left out');
  assert.deepEqual(rows[1], ['https://example.com/?a=1&b=2', 'Useful, "quoted" link', 'design, ideas', 'Line one\nLine two', 'Short', 'bookmark', 'Research / Deeper', '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z']);
  assert.equal(rows[2][1], "'=SUM(A1:A2)", 'a spreadsheet will not run it as a formula');
  assert.equal(rows[2][3], "'- [ ] a task");
  assert.equal(rows[2][0], '');
  assert.equal(rows[2][5], 'note');
});

test('CSV round trip brings back links, notes, types, collections and dates, reusing collections that already exist', async () => {
  const csv = exportItemsCsv(library());
  const target = device({ schemaVersion: 1, items: [], settings: {}, collections: [{ id: 'mine', name: 'research', parentId: '' }] });
  const result = await importPortableFile(csvFile(csv), target.store, options);
  assert.equal(result.items, 3);
  assert.deepEqual(result.warnings, []);
  const byTitle = title => target.library.items.find(item => item.title === title);
  const link = byTitle('Useful, "quoted" link');
  assert.equal(link.type, 'bookmark');
  assert.equal(link.url, 'https://example.com/?a=1&b=2');
  assert.deepEqual(link.tags, ['design', 'ideas']);
  assert.equal(link.content, 'Line one\nLine two');
  assert.equal(link.excerpt, 'Short');
  assert.equal(link.createdAt, '2026-01-02T03:04:05.000Z');
  assert.equal(link.updatedAt, '2026-02-03T04:05:06.000Z');
  assert.equal(pathOf(target.library, link.collectionId), 'research / Deeper');
  const note = byTitle('=SUM(A1:A2)');
  assert.equal(note.type, 'note');
  assert.equal(note.url, '');
  assert.equal(note.content, '- [ ] a task');
  assert.equal(note.collectionId, 'mine', 'the existing collection (any letter case) is reused');
  assert.equal(byTitle('An article').type, 'article');
  assert.equal(target.library.collections.length, 2, 'only "Deeper" was new');
  await importPortableFile(csvFile(csv), target.store, options);
  assert.equal(target.library.collections.length, 2, 'a second import adds no duplicate collections');
});

test('CSV import: link type alias, files without bytes become links, rows without a link are reported', async () => {
  const target = device();
  const csv = 'URL,Title,Type\nhttps://a.example,A,link\nhttps://b.example/doc.pdf,B,file\n,No link,bookmark\n,Just a note,note\nhttps://c.example,C,mystery\n';
  const result = await importPortableFile(csvFile(csv, 'other-app.csv'), target.store, options);
  assert.equal(result.items, 4);
  assert.match(result.warnings[0], /Skipped 1 row without a link/);
  assert.deepEqual(target.library.items.map(item => [item.title, item.type]).sort(), [['A', 'bookmark'], ['B', 'bookmark'], ['C', 'bookmark'], ['Just a note', 'note']]);
});

const conversations = { version: 2, conversations: [
  { id: 'c2', title: 'Links [draft] | today', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z', messages: [
    { role: 'user', text: 'Save these\n\nhttps://example.com/a' },
    { role: 'assistant', text: 'Saved Alpha [[a]] and a page [[page:current]] . Unknown [[zzz]].', citations: [{ id: 'a', title: 'Alpha', url: 'https://example.com/a (1)' }, { id: 'page:current', title: 'This page', url: '' }] },
    { role: 'assistant', text: '', error: 'Rate limited' },
    { role: 'assistant', text: '', error: 'Stopped' },
  ] },
  { id: 'c1', title: '', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', messages: [{ role: 'user', text: 'Hi' }] },
] };

test('assistant chats export as one Markdown file with readable citations', () => {
  const markdown = exportConversationsMarkdown(conversations);
  assert.match(markdown, /^# Still assistant chats\n/);
  assert.match(markdown, /## Links draft today\n\n_Started 2026-10-01, last message 2026-10-03_/);
  assert.match(markdown, /> \*\*You:\*\* Save these\n>\n> https:\/\/example.com\/a/);
  assert.match(markdown, /Saved Alpha \[Alpha\]\(https:\/\/example.com\/a%20%281%29\) and a page This page\. Unknown\./);
  assert.match(markdown, /_The answer did not finish: Rate limited_/);
  assert.ok(!markdown.includes('Stopped'));
  assert.match(markdown, /---\n\n## Assistant chat\n\n_Started 2026-09-01_\n\n> \*\*You:\*\* Hi/);
  assert.equal(exportConversationsMarkdown({ conversations: [] }), '# Still assistant chats\n\n_No assistant chats yet._\n');
});

test('exportChatsMarkdown reads every saved conversation from the chat store', async () => {
  const chats = createConversationStore({ storage: createMemoryStorage() });
  await chats.saveConversation({ id: 'c1', title: 'Kyoto', messages: [{ id: 'm', role: 'user', text: 'Temples?' }] });
  const { markdown, count } = await exportChatsMarkdown({ conversations: chats });
  assert.equal(count, 1);
  assert.match(markdown, /## Kyoto/);
  await assert.rejects(exportChatsMarkdown({ conversations: null }), /not available/);
});
