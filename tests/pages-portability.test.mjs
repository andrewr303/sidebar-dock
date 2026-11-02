import test from 'node:test';
import assert from 'node:assert/strict';
import { createFullBackup, serializeBackup, importPortableFile, exportItemsCsv, exportNotesMarkdown } from '../extension/lib/portability.js';
import { createLibraryStore } from '../extension/lib/store.js';
import { pageBlockLine } from '../extension/lib/pages.js';

function device(seed = { schemaVersion: 1, items: [], collections: [], settings: {} }) {
  let library = structuredClone(seed);
  const core = createLibraryStore({ read: async () => library, write: async value => { library = value; } });
  return {
    call: (name, ...args) => core.dispatch(name, args),
    get library() { return library; },
    store: {
      exportLibrary: () => core.dispatch('exportLibrary'), importLibrary: (value, options) => core.dispatch('importLibrary', [value, options]),
      bulkUpdateItems: (changes, options) => core.dispatch('bulkUpdateItems', [changes, options]),
      async getAttachment() { return null; }, async saveAttachment() { throw new Error('no files here'); }, async deleteAttachment() {},
    },
  };
}
const isolated = { dashboard: null, conversations: null, aiConfig: null, snapshot: null, deviceId: null };
const file = (text, name) => new File([text], name);
const at = '2026-03-01T00:00:00.000Z';
const details = { siteName: 'Example Times', author: 'Ada Lovelace', publishedAt: '2026-02-01T09:00:00.000Z', icon: 'https://example.com/icon.png', lang: 'en-GB' };
const seed = () => ({ schemaVersion: 1, settings: {}, collections: [], items: [
  { id: 'article', type: 'article', title: 'Saved article', url: 'https://example.com/post', content: `Intro\n\n${pageBlockLine('child', 'Old title')}`, ...details, createdAt: at, updatedAt: at },
  { id: 'child', type: 'note', title: 'Findings', parentId: 'article', content: `Body\n\n${pageBlockLine('grandchild', 'Deeper')}`, createdAt: '2026-03-01T00:00:01.000Z', updatedAt: at },
  { id: 'grandchild', type: 'note', title: 'Deeper', parentId: 'child', content: 'Details', createdAt: '2026-03-01T00:00:02.000Z', updatedAt: at },
  { id: 'other', type: 'note', title: 'Other note', content: '```\n[[child|Findings]]{page}\n```', createdAt: at, updatedAt: at },
] });

test('a full backup carries parents and page details and restores them', async () => {
  const source = device(seed());
  const backup = await createFullBackup(source.store, isolated);
  assert.deepEqual(backup.manifest.warnings, []);
  const article = backup.items.find(item => item.id === 'article');
  for (const [field, value] of Object.entries(details)) assert.equal(article[field], value, field);
  assert.equal(backup.items.find(item => item.id === 'grandchild').parentId, 'child');
  const target = device();
  await importPortableFile(file(serializeBackup(backup).text, 'still-backup.json'), target.store, isolated);
  const restored = new Map(target.library.items.map(item => [item.id, item]));
  assert.equal(restored.get('child').parentId, 'article');
  assert.equal(restored.get('grandchild').parentId, 'child');
  for (const [field, value] of Object.entries(details)) assert.equal(restored.get('article')[field], value, field);
});

test('import refuses a malformed parent id before anything is written', async () => {
  const target = device();
  const bad = { ...seed(), backupVersion: 2, attachments: [] };
  bad.items[1].parentId = 'not a valid id!';
  await assert.rejects(importPortableFile(file(JSON.stringify(bad), 'still-backup.json'), target.store, isolated), /Parent page has an invalid ID/);
  assert.equal(target.library.items.length, 0);
  // An unusable date or icon is not a reason to refuse a backup: the store drops it.
  const odd = { ...seed(), backupVersion: 2, attachments: [] };
  Object.assign(odd.items[0], { publishedAt: 'someday', icon: 'javascript:alert(1)', lang: 'not a tag' });
  await importPortableFile(file(JSON.stringify(odd), 'still-backup.json'), target.store, isolated);
  const article = target.library.items.find(item => item.id === 'article');
  assert.deepEqual([article.publishedAt, article.icon, article.lang], ['', '', '']);
});

test('export moves a subpage whose parent is not in the file to the top level and says so', async () => {
  const library = seed();
  library.items.push({ id: 'stray', type: 'note', title: 'Stray', parentId: 'gone', createdAt: at, updatedAt: at });
  library.items.push({ id: 'broken', type: 'bookmark', title: 'Broken', url: 'javascript:alert(1)', createdAt: at, updatedAt: at });
  library.items.push({ id: 'under-broken', type: 'note', title: 'Under broken', parentId: 'broken', createdAt: at, updatedAt: at });
  const backup = await createFullBackup({ exportLibrary: async () => library, getAttachment: async () => null }, isolated);
  assert.equal(backup.items.find(item => item.id === 'stray').parentId, '');
  assert.equal(backup.items.find(item => item.id === 'under-broken').parentId, '');
  assert.equal(backup.items.find(item => item.id === 'child').parentId, 'article');
  assert.ok(backup.manifest.warnings.some(warning => /Moved 2 subpages to the top level/.test(warning)), backup.manifest.warnings.join(' | '));
});

test('CSV carries the page details and brings them back', async () => {
  const csv = exportItemsCsv(seed());
  const target = device();
  await importPortableFile(file(csv, 'still-items.csv'), target.store, isolated);
  const article = target.library.items.find(item => item.title === 'Saved article');
  for (const [field, value] of Object.entries(details).filter(([field]) => field !== 'icon')) assert.equal(article[field], value, field);
  assert.equal(article.icon, '', 'icons are not a CSV column');
  assert.equal(target.library.items.find(item => item.title === 'Deeper').parentId, '', 'subpages come in flat: a CSV has no item ids');
});

test('Markdown export puts subpages after their parent and turns page blocks into links', () => {
  const markdown = exportNotesMarkdown(seed());
  const order = ['## Saved article', '## Findings', '## Deeper', '## Other note'].map(heading => markdown.indexOf(heading));
  assert.ok(order.every((position, index) => position >= 0 && (!index || position > order[index - 1])), markdown);
  assert.match(markdown, /Source: <https:\/\/example.com\/post>\n\n_Example Times · by Ada Lovelace · published 2026-02-01_\n/);
  assert.match(markdown, /## Findings\n\nSubpage of \[Saved article\]\(#saved-article\)/);
  assert.match(markdown, /## Deeper\n\nSubpage of \[Findings\]\(#findings\)/);
  assert.match(markdown, /Intro\n\n- \[Findings\]\(#findings\)/, 'the current title, not the stale label');
  assert.match(markdown, /Body\n\n- \[Deeper\]\(#deeper\)/);
  assert.match(markdown, /```\n\[\[child\|Findings\]\]\{page\}\n```/, 'code blocks stay as written');
  assert.doesNotMatch(markdown, /\{page\}\n(?!```)/);
});

test('Markdown export anchors count repeated headings, and missing pages fall back to their label', () => {
  const library = { schemaVersion: 1, settings: {}, collections: [], items: [
    { id: 'one', type: 'note', title: 'Plan', content: '## Plan\n\nNotes', createdAt: at, updatedAt: at },
    { id: 'two', type: 'note', title: 'Plan', parentId: 'one', content: `${pageBlockLine('gone', 'Removed [page]')}\n${pageBlockLine('trashed', 'Trashed')}`, createdAt: '2026-03-01T00:00:01.000Z', updatedAt: at },
    { id: 'trashed', type: 'note', title: 'Trashed', parentId: 'two', deletedAt: at, createdAt: at, updatedAt: at },
    { id: 'link', type: 'bookmark', title: 'A [link]', url: 'https://example.com/l', createdAt: at, updatedAt: at },
    { id: 'under-link', type: 'note', title: 'Under a link', parentId: 'link', createdAt: at, updatedAt: at },
  ] };
  const markdown = exportNotesMarkdown(library);
  // Headings in order: "Still notes", "Plan" (section one), "Plan" (inside its note), "Plan" (section two).
  assert.match(markdown, /## Plan\n\nSubpage of \[Plan\]\(#plan\)/);
  assert.match(markdown, /- Removed page\n- Trashed\n/, 'pages not in the file show their label');
  assert.match(markdown, /## Under a link\n\nSubpage of \[A \\\[link\\\]\]\(<https:\/\/example.com\/l>\)/, 'a parent without a section links to its page');
  assert.doesNotMatch(markdown, /## Trashed/);
  const target = exportNotesMarkdown({ ...library, items: [...library.items, { id: 'three', type: 'note', title: 'Index', content: pageBlockLine('two', 'Plan'), createdAt: at, updatedAt: at }] });
  assert.match(target, /- \[Plan\]\(#plan-2\)/, 'the second section titled Plan is the third Plan heading');
});
