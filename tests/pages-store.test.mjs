import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryStore, normalizeItem, MAX_ICON_DATA } from '../extension/lib/store.js';
import { MAX_PAGE_DEPTH } from '../extension/lib/pages.js';

function fixture(initial = null) {
  let value = initial ? structuredClone(initial) : null, writes = 0;
  const commits = [];
  const store = createLibraryStore({ read: async () => (value ? structuredClone(value) : null),
    write: async state => { writes++; value = structuredClone(state); }, onCommit: change => { commits.push(change); } });
  const call = (name, ...args) => store.dispatch(name, args);
  const item = id => value.items.find(entry => entry.id === id);
  return { call, item, commits, get value() { return value; }, get writes() { return writes; } };
}
const at = minutes => new Date(Date.UTC(2025, 0, 1, 0, minutes)).toISOString();
const later = (a, b) => Date.parse(b) > Date.parse(a);
// research (article, collection "work") > a > [b > c, d]; loose is a top-level note.
async function tree() {
  const h = fixture();
  const work = await h.call('createCollection', { name: 'Work' });
  const home = await h.call('createCollection', { name: 'Home' });
  const research = await h.call('saveItem', { type: 'article', title: 'Research', url: 'https://example.com/research', collectionId: work.id });
  const a = await h.call('saveItem', { type: 'note', title: 'A', parentId: research.id });
  const b = await h.call('saveItem', { type: 'note', title: 'B', parentId: a.id });
  const c = await h.call('saveItem', { type: 'note', title: 'C', parentId: b.id });
  const d = await h.call('saveItem', { type: 'note', title: 'D', parentId: a.id });
  const loose = await h.call('saveItem', { type: 'note', title: 'Loose' });
  return Object.assign(h, { work, home, research, a, b, c, d, loose });
}

test('new item fields are validated: page details, icon, language and parent', () => {
  const article = normalizeItem({ type: 'article', url: 'https://example.com', siteName: '  The\n  Site ', author: 'x'.repeat(400),
    publishedAt: '2024-05-01', icon: 'https://example.com/icon.png', lang: 'en_US' });
  assert.equal(article.siteName, 'The Site');
  assert.equal(article.author.length, 300);
  assert.equal(article.publishedAt, '2024-05-01T00:00:00.000Z');
  assert.equal(article.icon, 'https://example.com/icon.png');
  assert.equal(article.lang, 'en-US');
  assert.equal(article.parentId, '', 'only notes have a parent');
  const blank = normalizeItem({ type: 'note' });
  for (const field of ['parentId', 'siteName', 'author', 'publishedAt', 'icon', 'lang']) assert.equal(blank[field], '', field);
  assert.equal(normalizeItem({ type: 'note', publishedAt: 'last tuesday' }).publishedAt, '');
  assert.equal(normalizeItem({ type: 'note', siteName: 'y'.repeat(250) }).siteName.length, 200);
  assert.equal(normalizeItem({ type: 'note', lang: 'zh-Hans-CN' }).lang, 'zh-Hans-CN');
  for (const lang of ['en us', '<b>', 'x'.repeat(36), 'en-']) assert.equal(normalizeItem({ type: 'note', lang }).lang, '', lang);
  const png = `data:image/png;base64,${'A'.repeat(100)}`;
  assert.equal(normalizeItem({ type: 'note', icon: png }).icon, png);
  assert.equal(normalizeItem({ type: 'note', icon: `data:image/png;base64,${'A'.repeat(MAX_ICON_DATA)}` }).icon, '', 'over 16 KB');
  const svg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><text>★</text></svg>')}`;
  assert.equal(normalizeItem({ type: 'note', icon: svg }).icon, svg);
  for (const icon of ['javascript:alert(1)', 'data:text/html;base64,PHA+', 'data:image/svg+xml,<svg onload=x>', 'assets/icon.png', 'https://user:pw@example.com/i.png'])
    assert.equal(normalizeItem({ type: 'note', icon }).icon, '', icon);
  assert.equal(normalizeItem({ id: 'self', type: 'note', parentId: 'self' }).parentId, '');
  assert.equal(normalizeItem({ type: 'note', parentId: ' item_1 ' }).parentId, 'item_1');
});

test('saving a page again never blanks the captured details', async () => {
  const h = fixture();
  const first = await h.call('saveItem', { type: 'article', url: 'https://example.com/post', title: 'Post', siteName: 'Example', author: 'Ada',
    publishedAt: '2024-01-02T00:00:00Z', icon: 'https://example.com/favicon.png', lang: 'en' });
  const again = await h.call('saveItem', { type: 'article', url: 'https://example.com/post#top', title: 'Post', siteName: '', author: '', publishedAt: '', icon: '', lang: '' });
  assert.equal(again.id, first.id);
  for (const field of ['siteName', 'author', 'publishedAt', 'icon', 'lang']) assert.equal(again[field], first[field], field);
  const refreshed = await h.call('saveItem', { type: 'article', url: 'https://example.com/post', author: 'Grace', lang: 'en-GB' });
  assert.equal(refreshed.author, 'Grace');
  assert.equal(refreshed.lang, 'en-GB');
  assert.equal(refreshed.siteName, 'Example');
});

test('a re-save with an invalid page detail keeps the stored value instead of blanking it', async () => {
  const h = fixture();
  const first = await h.call('saveItem', { type: 'article', url: 'https://example.com/post', title: 'Post', siteName: 'Example', author: 'Ada',
    publishedAt: '2024-01-02T00:00:00Z', icon: 'https://example.com/favicon.png', lang: 'en', cover: 'https://example.com/cover.png' });
  // Non-empty but invalid incoming values: whitespace-only names, an unparsable date, a script icon, a bad tag, a bad cover.
  const again = await h.call('saveItem', { type: 'article', url: 'https://example.com/post', siteName: ' \n ', author: '\t',
    publishedAt: 'last tuesday', icon: 'javascript:alert(1)', lang: '<b>', cover: 'ftp://example.com/c.png' });
  assert.equal(again.id, first.id);
  for (const field of ['siteName', 'author', 'publishedAt', 'icon', 'lang', 'cover']) assert.equal(again[field], first[field], field);
  const huge = await h.call('saveItem', { type: 'article', url: 'https://example.com/post', icon: `data:image/png;base64,${'A'.repeat(MAX_ICON_DATA)}` });
  assert.equal(huge.icon, first.icon, 'an over-size inline icon does not replace the stored one');
  const valid = await h.call('saveItem', { type: 'article', url: 'https://example.com/post', icon: 'https://example.com/new.svg', publishedAt: '2025-03-04' });
  assert.equal(valid.icon, 'https://example.com/new.svg', 'a valid new value still wins');
  assert.equal(valid.publishedAt, '2025-03-04T00:00:00.000Z');
});

test('a new subpage needs a live parent of any type and lands in its collection', async () => {
  const t = await tree();
  assert.equal(t.a.parentId, t.research.id, 'an article can hold subpages');
  for (const page of [t.a, t.b, t.c, t.d]) assert.equal(t.item(page.id).collectionId, t.work.id, 'subpages inherit the collection');
  const chosen = await t.call('saveItem', { type: 'note', title: 'Elsewhere', parentId: t.a.id, collectionId: t.home.id });
  assert.equal(chosen.collectionId, t.home.id, 'a collection given by the caller wins');
  await assert.rejects(t.call('saveItem', { type: 'note', title: 'Orphan', parentId: 'item_missing' }), /That page no longer exists/);
  await t.call('deleteItem', t.loose.id);
  await assert.rejects(t.call('saveItem', { type: 'note', title: 'In trash', parentId: t.loose.id }), /That page no longer exists/);
  await assert.rejects(t.call('saveItem', { id: t.d.id, type: 'note', title: 'D', parentId: t.d.id }), /cannot be placed inside itself/);
  const bookmark = await t.call('saveItem', { type: 'bookmark', url: 'https://example.com/b', parentId: t.a.id });
  assert.equal(bookmark.parentId, '', 'only notes can be subpages');
});

test('pages nest up to the depth cap and no further', async () => {
  const h = fixture();
  let parent = await h.call('saveItem', { type: 'note', title: 'Level 0' });
  for (let level = 1; level <= MAX_PAGE_DEPTH; level++) parent = await h.call('saveItem', { type: 'note', title: `Level ${level}`, parentId: parent.id });
  await assert.rejects(h.call('saveItem', { type: 'note', title: 'Too deep', parentId: parent.id }), /nested 32 levels deep/);
  const top = await h.call('saveItem', { type: 'note', title: 'Top' });
  await h.call('saveItem', { type: 'note', title: 'Under top', parentId: top.id });
  const second = h.value.items.find(item => item.title === 'Level 31');
  await assert.rejects(h.call('movePage', top.id, { parentId: second.id }), /nested 32 levels deep/, 'the moved subtree counts too');
});

test('re-parenting refuses loops and carries the subtree into the new parent collection', async () => {
  const t = await tree();
  const before = t.writes;
  await assert.rejects(t.call('updateItem', t.a.id, { parentId: t.c.id }), /cannot be placed inside itself/);
  await assert.rejects(t.call('updateItem', t.a.id, { parentId: t.a.id }), /cannot be placed inside itself/);
  await assert.rejects(t.call('movePage', t.a.id, { parentId: t.d.id }), /cannot be placed inside itself/);
  assert.equal(t.writes, before, 'nothing was written');
  const home = await t.call('saveItem', { type: 'note', title: 'Home page', collectionId: t.home.id });
  const stampC = t.item(t.c.id).updatedAt;
  const moved = await t.call('movePage', t.b.id, { parentId: home.id, expectedUpdatedAt: t.item(t.b.id).updatedAt });
  assert.equal(moved.parentId, home.id);
  assert.equal(moved.collectionId, t.home.id);
  assert.equal(t.item(t.c.id).collectionId, t.home.id, 'the subtree moves with it');
  assert.ok(later(stampC, t.item(t.c.id).updatedAt), 'cascaded records get a new stamp');
  assert.deepEqual(new Set(t.commits.at(-1).changed.items), new Set([t.b.id, t.c.id]));
  const top = await t.call('movePage', t.b.id, { parentId: '' });
  assert.equal(top.parentId, '');
  assert.equal(top.collectionId, t.home.id, 'the top level keeps its own collection');
  await assert.rejects(t.call('movePage', t.b.id, { parentId: t.d.id, expectedUpdatedAt: at(0) }), /Conflict/);
  await assert.rejects(t.call('movePage', t.research.id, { parentId: t.loose.id }), /Only notes/);
  const writes = t.writes;
  assert.equal((await t.call('movePage', t.b.id, { parentId: '' })).id, t.b.id);
  assert.equal(t.writes, writes, 'moving to the same place writes nothing');
  await t.call('deleteItem', t.d.id);
  await assert.rejects(t.call('movePage', t.d.id, { parentId: '' }), /Restore this page/);
});

test('a moved page carries the new parent collection to its whole subtree, even when it already had it', async () => {
  const t = await tree();
  // B already sits in Home; its subpage C does not.
  await t.call('updateItem', t.c.id, { collectionId: t.home.id });
  await t.call('bulkUpdateItems', [{ id: t.b.id, patch: { collectionId: t.home.id } }, { id: t.c.id, patch: { collectionId: t.work.id } }]);
  assert.equal(t.item(t.b.id).collectionId, t.home.id);
  assert.equal(t.item(t.c.id).collectionId, t.work.id);
  const home = await t.call('saveItem', { type: 'note', title: 'Home page', collectionId: t.home.id });
  await t.call('movePage', t.b.id, { parentId: home.id });
  assert.equal(t.item(t.b.id).collectionId, t.home.id);
  assert.equal(t.item(t.c.id).collectionId, t.home.id, 'the subtree takes the new parent collection');
  assert.ok(t.commits.at(-1).changed.items.includes(t.c.id), 'onCommit reports the cascaded subpage');
  // updateItem re-parenting does the same, and a trashed subpage is left alone.
  await t.call('updateItem', t.c.id, { collectionId: t.work.id });
  const e = await t.call('saveItem', { type: 'note', title: 'E', parentId: t.c.id, collectionId: t.work.id });
  await t.call('deleteItem', e.id);
  await t.call('updateItem', t.b.id, { parentId: t.d.id });
  assert.equal(t.item(t.b.id).collectionId, t.work.id);
  assert.equal(t.item(t.c.id).collectionId, t.work.id);
  await t.call('updateItem', t.b.id, { parentId: home.id });
  assert.equal(t.item(t.c.id).collectionId, t.home.id);
  assert.equal(t.item(e.id).collectionId, t.work.id, 'a trashed subpage keeps its collection');
});

test('a parent id no item could have is refused instead of moving the page to the top level', async () => {
  const t = await tree();
  const before = t.writes;
  const long = `item_${'x'.repeat(200)}`;
  await assert.rejects(t.call('movePage', t.b.id, { parentId: long }), /That page no longer exists/);
  await assert.rejects(t.call('movePage', t.b.id, { parentId: 42 }), /That page no longer exists/);
  await assert.rejects(t.call('updateItem', t.b.id, { parentId: long }), /That page no longer exists/);
  await assert.rejects(t.call('updateItem', t.b.id, { parentId: { id: t.a.id } }), /That page no longer exists/);
  await assert.rejects(t.call('bulkUpdateItems', [{ id: t.b.id, patch: { parentId: long } }]), /That page no longer exists/);
  await assert.rejects(t.call('saveItem', { type: 'note', title: 'New', parentId: long }), /That page no longer exists/);
  assert.equal(t.writes, before, 'nothing was written');
  assert.equal(t.item(t.b.id).parentId, t.a.id);
  // The top level is still reachable with '' or null, and a non-note's parent is still dropped quietly.
  assert.equal((await t.call('updateItem', t.b.id, { parentId: null })).parentId, '');
  assert.equal((await t.call('movePage', t.b.id, { parentId: t.a.id })).parentId, t.a.id);
  assert.equal((await t.call('movePage', t.b.id, { parentId: '' })).parentId, '');
  assert.equal((await t.call('updateItem', t.research.id, { parentId: long })).parentId, '');
});

test('a collection change carries down to live subpages only', async () => {
  const t = await tree();
  await t.call('deleteItem', t.c.id);
  const trashedStamp = t.item(t.c.id).updatedAt;
  await t.call('updateItem', t.a.id, { collectionId: t.home.id });
  for (const page of [t.a, t.b, t.d]) assert.equal(t.item(page.id).collectionId, t.home.id, page.title);
  assert.equal(t.item(t.c.id).collectionId, t.work.id, 'a trashed subpage keeps its collection');
  assert.equal(t.item(t.c.id).updatedAt, trashedStamp);
  assert.equal(t.item(t.research.id).collectionId, t.work.id, 'parents are never changed');
  // In one batch, a subpage given its own collection keeps it and carries it down.
  await t.call('restoreItem', t.c.id);
  await t.call('bulkUpdateItems', [{ id: t.a.id, patch: { collectionId: t.work.id } }, { id: t.b.id, patch: { collectionId: '' } }]);
  assert.equal(t.item(t.d.id).collectionId, t.work.id);
  assert.equal(t.item(t.b.id).collectionId, '');
  assert.equal(t.item(t.c.id).collectionId, '');
});

test('trash stamps the identical deletedAt on live subpages; restore brings back only what was trashed together', async () => {
  const t = await tree();
  await t.call('deleteItem', t.c.id);
  const separate = t.item(t.c.id).deletedAt;
  await new Promise(resolve => setTimeout(resolve, 5));
  const trashed = await t.call('deleteItem', t.a.id);
  assert.ok(trashed.deletedAt);
  for (const page of [t.b, t.d]) assert.equal(t.item(page.id).deletedAt, trashed.deletedAt, page.title);
  assert.equal(t.item(t.c.id).deletedAt, separate, 'a subpage already in Trash keeps its own stamp');
  assert.equal(t.item(t.research.id).deletedAt, null);
  assert.deepEqual(new Set(t.commits.at(-1).changed.items), new Set([t.a.id, t.b.id, t.d.id]));
  const restored = await t.call('restoreItem', t.a.id);
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.parentId, t.research.id);
  for (const page of [t.b, t.d]) assert.equal(t.item(page.id).deletedAt, null, page.title);
  assert.equal(t.item(t.c.id).deletedAt, separate, 'trashed separately, so it stays in Trash');
  assert.equal(t.item(t.c.id).parentId, t.b.id);
});

test('restoring a subpage whose parent is still in Trash moves it to the top level', async () => {
  const t = await tree();
  await t.call('deleteItem', t.a.id);
  const child = await t.call('restoreItem', t.b.id);
  assert.equal(child.parentId, '');
  assert.equal(child.deletedAt, null);
  assert.equal(t.item(t.c.id).deletedAt, null, 'its own subpages trashed with it come back under it');
  assert.equal(t.item(t.c.id).parentId, t.b.id);
  assert.ok(t.item(t.d.id).deletedAt, 'its sibling stays in Trash');
  await t.call('restoreItem', t.a.id);
  assert.equal(t.item(t.b.id).parentId, '', 'restoring the old parent later does not re-nest it');
  assert.equal(t.item(t.d.id).deletedAt, null);
});

test('a page trashed again takes the subpages trashed with it to the new stamp', async () => {
  const t = await tree();
  await t.call('deleteItem', t.a.id);
  await new Promise(resolve => setTimeout(resolve, 5));
  const again = await t.call('deleteItem', t.a.id);
  for (const page of [t.b, t.c, t.d]) assert.equal(t.item(page.id).deletedAt, again.deletedAt, page.title);
  await t.call('restoreItem', t.a.id);
  for (const page of [t.a, t.b, t.c, t.d]) assert.equal(t.item(page.id).deletedAt, null, page.title);
});

test('bulk trash and restore patches cascade like deleteItem (Library, undo and assistant paths)', async () => {
  const t = await tree();
  const stamp = new Date().toISOString();
  // The Library trashes a selection that holds a page and one of its subpages.
  const result = await t.call('bulkUpdateItems', [{ id: t.a.id, patch: { deletedAt: stamp } }, { id: t.c.id, patch: { deletedAt: stamp } }]);
  assert.deepEqual(result.map(item => item.id), [t.a.id, t.c.id], 'only the listed items are returned');
  for (const page of [t.a, t.b, t.c, t.d]) assert.equal(t.item(page.id).deletedAt, stamp, page.title);
  // Undo restores the listed page; its subpages come back with it.
  await t.call('bulkUpdateItems', [{ id: t.a.id, patch: { deletedAt: null } }]);
  for (const page of [t.a, t.b, t.c, t.d]) assert.equal(t.item(page.id).deletedAt, null, page.title);
  // A batch that would build a loop fails as a whole, judged on the state after the batch.
  const before = structuredClone(t.value.items);
  await assert.rejects(t.call('bulkUpdateItems', [{ id: t.loose.id, patch: { parentId: t.d.id } }, { id: t.a.id, patch: { parentId: t.loose.id } }]), /cannot be placed inside itself/);
  assert.deepEqual(t.value.items, before, 'nothing was written');
  // Trashing a page and restoring a subpage of it in one batch: the subpage comes back at the top level.
  await t.call('deleteItem', t.c.id);
  const mixed = await t.call('bulkUpdateItems', [{ id: t.b.id, patch: { deletedAt: stamp } }, { id: t.c.id, patch: { deletedAt: null } }]);
  assert.equal(mixed[1].parentId, '');
  assert.equal(mixed[1].deletedAt, null);
});

test('a batch that trashes a page and its subpage with different stamps keeps them trashed together', async () => {
  const t = await tree();
  const early = new Date(Date.now() - 60000).toISOString(), late = new Date().toISOString();
  // The subpage is listed first with its own stamp; the page's stamp still wins for the whole subtree.
  const result = await t.call('bulkUpdateItems', [{ id: t.c.id, patch: { deletedAt: late } }, { id: t.a.id, patch: { deletedAt: early } }]);
  assert.equal(result[0].deletedAt, early, 'the returned subpage carries its ancestor stamp');
  for (const page of [t.a, t.b, t.c, t.d]) assert.equal(t.item(page.id).deletedAt, early, page.title);
  await t.call('restoreItem', t.a.id);
  for (const page of [t.a, t.b, t.c, t.d]) assert.equal(t.item(page.id).deletedAt, null, page.title);
  // Delete forever takes the subpage with the page.
  await t.call('bulkUpdateItems', [{ id: t.a.id, patch: { deletedAt: early } }, { id: t.b.id, patch: { deletedAt: late } }]);
  assert.equal(t.item(t.c.id).deletedAt, early, 'the trashed subpage passes the stamp on to its own subpages');
  const removed = await t.call('permanentlyDeleteItem', t.a.id);
  assert.deepEqual(new Set(removed.ids), new Set([t.a.id, t.b.id, t.c.id, t.d.id]));
});

test('a batch trash leaves a subpage trashed separately before, or restored in the batch, out of the cascade', async () => {
  const t = await tree();
  await t.call('deleteItem', t.b.id);
  const separate = t.item(t.b.id).deletedAt;
  const stamp = new Date(Date.parse(separate) + 1000).toISOString();
  // C was trashed together with B; re-stamping C in the same batch as A does not pull it under A, because B (between
  // them) was trashed on its own before.
  await t.call('bulkUpdateItems', [{ id: t.a.id, patch: { deletedAt: stamp } }, { id: t.c.id, patch: { deletedAt: new Date(Date.parse(stamp) + 1).toISOString() } }]);
  assert.equal(t.item(t.b.id).deletedAt, separate);
  assert.notEqual(t.item(t.c.id).deletedAt, stamp);
  assert.equal(t.item(t.d.id).deletedAt, stamp);
  // A page trashed while a subpage is restored in the same batch: the subpage stays out and moves to the top level.
  const u = await tree();
  await u.call('deleteItem', u.c.id);
  const mixed = await u.call('bulkUpdateItems', [{ id: u.a.id, patch: { deletedAt: stamp } }, { id: u.c.id, patch: { deletedAt: null } }]);
  assert.equal(mixed[1].deletedAt, null);
  assert.equal(mixed[1].parentId, '');
});

test('a batch that trashes a page and only edits a live subpage still trashes that subpage and its subtree', async () => {
  for (const order of ['page first', 'subpage first']) {
    const t = await tree();
    const stamp = new Date().toISOString();
    const changes = [{ id: t.a.id, patch: { deletedAt: stamp } }, { id: t.b.id, patch: { tags: ['keep'], title: 'B edited' } }];
    await t.call('bulkUpdateItems', order === 'page first' ? changes : changes.reverse());
    for (const page of [t.a, t.b, t.c, t.d]) assert.equal(t.item(page.id).deletedAt, stamp, `${order}: ${page.title}`);
    assert.deepEqual(t.item(t.b.id).tags, ['keep'], 'the edit itself still applies');
    assert.equal(t.item(t.b.id).parentId, t.a.id);
    assert.equal(t.item(t.research.id).deletedAt, null);
    await t.call('restoreItem', t.a.id);
    for (const page of [t.a, t.b, t.c, t.d]) assert.equal(t.item(page.id).deletedAt, null, `${order}: ${page.title} restored`);
    assert.equal(t.item(t.b.id).parentId, t.a.id, 'restored under its page');
    await t.call('deleteItem', t.a.id);
    const removed = await t.call('permanentlyDeleteItem', t.a.id);
    assert.deepEqual(new Set(removed.ids), new Set([t.a.id, t.b.id, t.c.id, t.d.id]), `${order}: delete forever takes the whole tree`);
  }
  // A subpage given a new collection in the same batch is trashed with the page, and its own subpages take the collection
  // too, so the tree comes back in one collection.
  const u = await tree();
  const stamp = new Date().toISOString();
  await u.call('bulkUpdateItems', [{ id: u.a.id, patch: { deletedAt: stamp } }, { id: u.b.id, patch: { collectionId: u.home.id } }]);
  for (const page of [u.a, u.b, u.c, u.d]) assert.equal(u.item(page.id).deletedAt, stamp, page.title);
  assert.equal(u.item(u.b.id).collectionId, u.home.id);
  assert.equal(u.item(u.c.id).collectionId, u.home.id, 'the moved subtree follows its page into the collection');
  assert.equal(u.item(u.d.id).collectionId, u.work.id, 'a sibling keeps the page collection');
  await u.call('restoreItem', u.a.id);
  for (const page of [u.a, u.b, u.c, u.d]) assert.equal(u.item(page.id).deletedAt, null, page.title);
  assert.equal(u.item(u.c.id).collectionId, u.home.id);
  // A page already in Trash that gets a new stamp takes along a subpage the batch only edits, but never one it restores.
  const v = await tree();
  await v.call('deleteItem', v.a.id);
  const old = v.item(v.a.id).deletedAt;
  const again = new Date(Date.parse(old) + 1000).toISOString();
  const [, edited] = await v.call('bulkUpdateItems', [{ id: v.a.id, patch: { deletedAt: again } }, { id: v.b.id, patch: { tags: ['keep'] } }]);
  assert.equal(edited.deletedAt, again, 'the returned subpage carries the new stamp');
  for (const page of [v.a, v.b, v.c, v.d]) assert.equal(v.item(page.id).deletedAt, again, page.title);
  const third = new Date(Date.parse(again) + 1000).toISOString();
  const [, back] = await v.call('bulkUpdateItems', [{ id: v.a.id, patch: { deletedAt: third } }, { id: v.b.id, patch: { deletedAt: null } }]);
  assert.equal(back.deletedAt, null);
  assert.equal(back.parentId, '', 'restored while its page stays in Trash: the top level');
  assert.equal(v.item(v.c.id).deletedAt, null, 'it brings its own subpages back');
  assert.equal(v.item(v.d.id).deletedAt, third);
});

test('delete forever from Trash removes subpages trashed together and lifts the rest', async () => {
  const t = await tree();
  await t.call('updateItem', t.loose.id, { relatedIds: [t.b.id, t.c.id] });
  await t.call('updateItem', t.b.id, { attachmentId: 'file_b', fileName: 'b.bin' });
  await t.call('updateItem', t.d.id, { attachmentId: 'file_d', fileName: 'd.bin' });
  await t.call('saveItem', { type: 'note', title: 'Shares d file', attachmentId: 'file_d' });
  await t.call('deleteItem', t.d.id);
  await new Promise(resolve => setTimeout(resolve, 5));
  await t.call('deleteItem', t.a.id);
  const loose = t.item(t.loose.id).updatedAt;
  const removed = await t.call('permanentlyDeleteItem', t.a.id);
  assert.deepEqual(removed.id, t.a.id);
  assert.deepEqual(new Set(removed.ids), new Set([t.a.id, t.b.id, t.c.id]));
  assert.deepEqual(removed.attachmentIds, ['file_b']);
  const d = t.item(t.d.id);
  assert.equal(d.parentId, t.research.id, 'trashed separately: moved up to the nearest page that stays');
  assert.ok(d.deletedAt, 'and still in Trash');
  assert.deepEqual(new Set(t.value.tombstones.map(grave => grave.id)), new Set([t.a.id, t.b.id, t.c.id]));
  assert.deepEqual(t.item(t.loose.id).relatedIds, []);
  assert.equal(t.item(t.loose.id).updatedAt, loose, 'backlink clean-up keeps the revision');
  const commit = t.commits.at(-1);
  assert.deepEqual(new Set(commit.deleted.items), new Set([t.a.id, t.b.id, t.c.id]));
  assert.ok(commit.changed.items.includes(t.d.id) && commit.changed.items.includes(t.loose.id));
});

test('delete forever of a live page never deletes its subpages: they move up a level', async () => {
  const t = await tree();
  const removed = await t.call('permanentlyDeleteItem', t.a.id, { expectedUpdatedAt: t.item(t.a.id).updatedAt });
  assert.deepEqual(removed.ids, [t.a.id]);
  for (const page of [t.b, t.d]) {
    assert.equal(t.item(page.id).parentId, t.research.id, page.title);
    assert.equal(t.item(page.id).deletedAt, null);
    assert.ok(later(page.updatedAt, t.item(page.id).updatedAt));
  }
  assert.equal(t.item(t.c.id).parentId, t.b.id);
  await t.call('permanentlyDeleteItem', t.research.id);
  assert.equal(t.item(t.b.id).parentId, '', 'nothing left above: the top level');
});

test('empty Trash lifts live subpages an older build left under trashed pages', async () => {
  const h = fixture({ schemaVersion: 1, settings: {}, collections: [], updatedAt: at(0), items: [
    { id: 'top', type: 'note', title: 'Top', createdAt: at(0), updatedAt: at(0) },
    { id: 'gone', type: 'note', title: 'Gone', parentId: 'top', deletedAt: at(1), attachmentId: 'file_gone', createdAt: at(0), updatedAt: at(1) },
    { id: 'kept', type: 'note', title: 'Kept', parentId: 'gone', createdAt: at(0), updatedAt: at(0), futureField: 'still here' },
  ] });
  const result = await h.call('emptyTrash');
  assert.deepEqual(result, { ids: ['gone'], attachmentIds: ['file_gone'] });
  assert.equal(h.item('kept').parentId, 'top');
  assert.equal(h.item('kept').futureField, 'still here');
  assert.ok(later(at(0), h.item('kept').updatedAt));
});

test('import repairs dangling parents, non-note children and loops, and keeps local parents', async () => {
  const h = fixture({ schemaVersion: 1, settings: {}, collections: [], updatedAt: at(0), items: [
    { id: 'local', type: 'note', title: 'Local page', createdAt: at(0), updatedAt: at(0) },
    { id: 'buried', type: 'note', title: 'Buried', createdAt: at(0), updatedAt: at(0) },
    { id: 'loopLocal', type: 'note', title: 'Loop local', parentId: 'loopFile', createdAt: at(0), updatedAt: at(5) },
  ] });
  await h.call('permanentlyDeleteItem', 'buried');
  await h.call('importLibrary', { collections: [], items: [
    { id: 'underLocal', type: 'note', title: 'Under local', parentId: 'local', updatedAt: at(1) },
    { id: 'dangling', type: 'note', title: 'Dangling', parentId: 'nowhere', updatedAt: at(1) },
    { id: 'underBuried', type: 'note', title: 'Under buried', parentId: 'buried', updatedAt: at(1) },
    { id: 'buried', type: 'note', title: 'Buried', updatedAt: at(0) },
    { id: 'bookmark', type: 'bookmark', url: 'https://example.com', title: 'Bookmark', parentId: 'local', updatedAt: at(1) },
    { id: 'p', type: 'note', title: 'P', parentId: 'q', updatedAt: at(1) }, { id: 'q', type: 'note', title: 'Q', parentId: 'p', updatedAt: at(1) },
    { id: 'loopFile', type: 'note', title: 'Loop file', parentId: 'loopLocal', updatedAt: at(2) },
  ] });
  assert.equal(h.item('underLocal').parentId, 'local', 'a parent already in this library is kept');
  assert.equal(h.item('dangling').parentId, '');
  assert.ok(later(at(1), h.item('dangling').updatedAt), 'a repair gets a new stamp');
  assert.equal(h.item('buried'), undefined, 'deleted here, not resurrected');
  assert.equal(h.item('underBuried').parentId, '');
  assert.equal(h.item('bookmark').parentId, '');
  assert.equal([h.item('p').parentId, h.item('q').parentId].filter(Boolean).length, 1, 'an in-file loop is broken, not refused');
  assert.equal(h.item('loopFile').parentId, '', 'across the file and this library, the incoming page is lifted');
  assert.equal(h.item('loopLocal').parentId, 'loopFile');
});

test('a seed with a damaged parent loop loads with the loop broken', async () => {
  const h = fixture();
  await h.call('loadLibrary', { schemaVersion: 1, settings: {}, collections: [], items: [
    { id: 'x', type: 'note', title: 'X', parentId: 'y', updatedAt: at(1) }, { id: 'y', type: 'note', title: 'Y', parentId: 'x', updatedAt: at(1) },
    { id: 'z', type: 'note', title: 'Z', parentId: 'missing', updatedAt: at(1) },
  ] });
  assert.equal(h.item('x').parentId, '');
  assert.equal(h.item('y').parentId, 'x');
  assert.equal(h.item('z').parentId, '');
  assert.equal(h.item('x').updatedAt, at(1), 'seed data keeps its stamps');
});

test('upsertContentSection appends or replaces the last copy of a section inside the write queue', async () => {
  const h = fixture();
  const note = await h.call('saveItem', { type: 'note', title: 'Notes', content: 'Mine\n' });
  let out = await h.call('upsertContentSection', note.id, { next: '## Research\n\nFirst' });
  assert.equal(out.replaced, false);
  assert.equal(out.item.content, 'Mine\n\n## Research\n\nFirst', 'the original text is kept byte for byte');
  assert.ok(later(note.updatedAt, out.item.updatedAt));
  out = await h.call('upsertContentSection', note.id, { previous: '## Research\n\nFirst', next: '## Research\n\nFirst\n\nSecond' });
  assert.equal(out.replaced, true);
  assert.equal(out.item.content, 'Mine\n\n## Research\n\nFirst\n\nSecond');
  // The user edited the section meanwhile: the new text lands as a fresh block and nothing of theirs is lost.
  const edited = await h.call('updateItem', note.id, { content: 'Mine\n\n## Research\n\nFirst (edited)\n\nSecond' });
  out = await h.call('upsertContentSection', note.id, { previous: '## Research\n\nFirst\n\nSecond', next: 'Third' });
  assert.equal(out.replaced, false);
  assert.equal(out.item.content, `${edited.content}\n\nThird`);
  // Only the LAST copy is replaced.
  const twice = await h.call('saveItem', { type: 'note', title: 'Twice', content: 'X\n\nX' });
  assert.equal((await h.call('upsertContentSection', twice.id, { previous: 'X', next: 'Y' })).item.content, 'X\n\nY');
  const empty = await h.call('saveItem', { type: 'note', title: 'Empty' });
  assert.equal((await h.call('upsertContentSection', empty.id, { next: 'Start' })).item.content, 'Start');
  const article = await h.call('saveItem', { type: 'article', title: 'A', url: 'https://example.com/a', articleContent: 'Original' });
  out = await h.call('upsertContentSection', article.id, { previous: 'Original', next: 'Corrected', field: 'articleContent' });
  assert.equal(out.item.articleContent, 'Corrected');
  assert.equal(out.item.content, '');
  await assert.rejects(h.call('upsertContentSection', article.id, { next: 'x', field: 'title' }), /Only the note or the saved page text/);
  await assert.rejects(h.call('upsertContentSection', article.id, { next: 42 }), /Markdown text/);
  await assert.rejects(h.call('upsertContentSection', article.id, { next: 'x'.repeat(250001), field: 'articleContent' }), /250,000/);
  await assert.rejects(h.call('upsertContentSection', 'item_missing', { next: 'x' }), /no longer exists/);
  // Writes queued back to back never lose one another.
  const busy = await h.call('saveItem', { type: 'note', title: 'Busy' });
  await Promise.all(['one', 'two', 'three'].map(next => h.call('upsertContentSection', busy.id, { next })));
  assert.equal(h.item(busy.id).content, 'one\n\ntwo\n\nthree');
});

test('cascades keep revisions moving forward and stale edits on a cascaded subpage conflict', async () => {
  const t = await tree();
  const b = t.item(t.b.id);
  await t.call('deleteItem', t.a.id);
  const trashed = t.item(t.b.id);
  assert.ok(later(b.updatedAt, trashed.updatedAt));
  await assert.rejects(t.call('updateItem', t.b.id, { title: 'Stale' }, { expectedUpdatedAt: b.updatedAt }), /Conflict/);
  await t.call('restoreItem', t.a.id);
  assert.ok(later(trashed.updatedAt, t.item(t.b.id).updatedAt));
  const stamps = t.value.items.map(item => item.updatedAt);
  await t.call('updateItem', t.a.id, { collectionId: t.home.id });
  t.value.items.forEach((item, position) => assert.ok(Date.parse(item.updatedAt) >= Date.parse(stamps[position]), item.title));
});

test('fields this build does not know survive every cascade, lift and move', async () => {
  const h = fixture({ schemaVersion: 1, settings: {}, collections: [{ id: 'c1', name: 'One' }, { id: 'c2', name: 'Two' }], updatedAt: at(0), items: [
    { id: 'p', type: 'note', title: 'P', collectionId: 'c1', createdAt: at(0), updatedAt: at(0), futureP: 1 },
    { id: 'k', type: 'note', title: 'K', parentId: 'p', collectionId: 'c1', createdAt: at(0), updatedAt: at(0), futureK: { order: 'a0' } },
    { id: 'g', type: 'note', title: 'G', parentId: 'k', collectionId: 'c1', createdAt: at(0), updatedAt: at(0), futureG: [1] },
    { id: 'other', type: 'note', title: 'Other', createdAt: at(0), updatedAt: at(0) },
  ] });
  await h.call('updateItem', 'p', { collectionId: 'c2' });
  await h.call('deleteItem', 'p');
  await h.call('restoreItem', 'p');
  await h.call('movePage', 'k', { parentId: 'other' });
  await h.call('permanentlyDeleteItem', 'other');
  assert.equal(h.item('p').futureP, 1);
  assert.deepEqual(h.item('k').futureK, { order: 'a0' });
  assert.deepEqual(h.item('g').futureG, [1]);
  assert.equal(h.item('k').parentId, '');
  assert.equal(h.item('g').parentId, 'k');
});
