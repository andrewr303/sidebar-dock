// Subpage UI (contract §2): the page block in Markdown and the block editor, standalone images, browse-list hiding and
// Trash roots, the Notes list tree, breadcrumbs, the move-to-page picker, delete-forever cascades, duplicate merge and
// the research trigger gate. UI modules are tested through their pure helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, parseNoteBlocks, serializeNoteBlocks, plainText, parsePage, serializePage, standaloneImage } from '../extension/lib/markdown.js';
import { parseMarkdown, serializeBlocks, findBlockCommands, slashCatalogue, htmlToMarkdown, BLOCK_COMMANDS } from '../extension/lib/block-editor.js';
import { extractWikiLinks, noteTitleFromContent, wordCount } from '../extension/lib/notes.js';
import { pageBlockLine, parsePageBlockLine } from '../extension/lib/pages.js';
import { createSelectors, isBrowseView, trashedTogetherIds } from '../extension/ui/selectors.js';
import { noteTreeRows, pagePathLabel } from '../extension/ui/notes.js';
import { crumbTrail, pageMoveCandidates, subpagesMoving, confirmTrash } from '../extension/ui/note-editor.js';
import { planMerge, planKeepNewest, undoFor, deleteItemsForever, trashMessage, restoreMessage, researchMenuItem, trashItems } from '../extension/ui/library.js';
import { createLibraryStore } from '../extension/lib/store.js';
import { itemOption } from '../extension/ui/command.js';
import { withPageLinks, filterMapItems } from '../extension/ui/map.js';
import { pathOfItem } from '../extension/ui/cards.js';
import { registerActions, hasAction, dispatch } from '../extension/ui/runtime.js';

const at = n => `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`;
const item = (id, props = {}) => ({ id, type: 'note', title: id, url: '', content: '', tags: [], collectionId: '', highlights: [], relatedIds: [],
  parentId: '', deletedAt: null, archived: false, favorite: false, createdAt: at(1), updatedAt: at(1), ...props });
const resolver = items => target => { const hit = items.find(entry => entry.id === target && !entry.deletedAt); return hit ? { id: hit.id, title: hit.title, type: hit.type } : null; };

/* ------------------------------------------------------------------ page block grammar */

test('page blocks parse as their own block and untouched lines keep their exact bytes', () => {
  const source = 'Intro\n[[note_1|Child page]]{page}\n[[note_2]]{page}  \r\n[[note_3|Third]]{page}\t\nOutro';
  const blocks = parseNoteBlocks(source);
  assert.deepEqual(blocks.map(b => b.type), ['paragraph', 'page', 'page', 'page', 'paragraph']);
  assert.deepEqual([blocks[1].target, blocks[1].label], ['note_1', 'Child page']);
  assert.deepEqual([blocks[2].target, blocks[2].label], ['note_2', '']);
  assert.equal(serializeNoteBlocks(blocks), source, 'untouched page lines (trailing spaces, \\r, tab) round trip byte for byte');
  assert.equal(serializeBlocks(parseMarkdown(source)), source, 'the block editor model round trips too');
  blocks[1].label = 'Renamed [x] | y';
  assert.equal(serializeNoteBlocks(blocks).split('\n')[1], '[[note_1|Renamed x y]]{page}', 'an edited block serializes canonically and cannot break its brackets');
  assert.equal(serializePage({ target: 'a]b', label: '' }), '[[a b]]{page}');
  assert.equal(serializePage({ target: 'n1', label: 'Title' }), pageBlockLine('n1', 'Title'), 'the canonical line is the one lib/pages.js writes');
  assert.deepEqual(parsePage(pageBlockLine('n9', 'Notes on X')), { target: 'n9', label: 'Notes on X' });
  assert.deepEqual(parsePageBlockLine('[[n9|Notes on X]]{page}'), { id: 'n9', label: 'Notes on X' }, 'one grammar shared with lib/pages.js');
});

test('a lone [[link]] keeps its meaning; typed look-alike text stays text; page lines end tables and hard breaks', () => {
  assert.equal(parseNoteBlocks('[[note_1|Child]]')[0].type, 'paragraph', 'a wiki link alone on a line is still a paragraph');
  assert.equal(parseNoteBlocks('[[note_1|Child]]{page} trailing words')[0].type, 'paragraph', 'only a whole line is a page block');
  const typed = [{ id: 'x', type: 'paragraph', text: '[[note_1|Child]]{page}', checked: false, language: '' }];
  const saved = serializeNoteBlocks(typed);
  assert.equal(saved, '\\[[note_1|Child]]{page}');
  assert.equal(parseNoteBlocks(saved)[0].type, 'paragraph', 'reopened, typed text is still a paragraph');
  assert.equal(parseNoteBlocks('  [[n1|C]]{page}')[0].type, 'page', 'an indented page line is a page block, as in lib/pages.js');
  assert.equal(serializeNoteBlocks([{ ...typed[0], text: '  [[n1|C]]{page}' }]), '  \\[[n1|C]]{page}', 'indented look-alike text is escaped too');
  assert.deepEqual(parseNoteBlocks('line one\\\n[[n1|C]]{page}').map(b => b.type), ['paragraph', 'page'], 'a page line is never swallowed by a hard break');
  const table = parseNoteBlocks('| A | B |\n| --- | --- |\n| 1 | 2 |\n[[n1|C]]{page}');
  assert.deepEqual(table.map(b => b.type), ['table', 'page'], 'a page line right after a table is not one more row');
  assert.equal(serializeNoteBlocks(table), '| A | B |\n| --- | --- |\n| 1 | 2 |\n[[n1|C]]{page}');
});

test('rendered page rows show the current title, open like links and read "Deleted page" when gone', () => {
  const items = [item('n1', { title: 'Live title' }), item('n2', { title: 'Trashed', deletedAt: at(2) }), item('Old', { title: 'Title match' })];
  const html = renderMarkdown('[[n1|Stale label]]{page}\n[[n2|Was here]]{page}\n[[missing|Gone]]{page}', { resolveLink: resolver(items) });
  assert.match(html, /^<div class="markdown-page" data-target="n1" data-label="Live title"><a class="note-link markdown-page-link" href="#" data-id="n1" data-type="note" data-target="n1" data-label="Live title" data-page=""><svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg><span class="markdown-page-title">Live title<\/span><\/a><\/div>/);
  assert.doesNotMatch(html, /Stale label/, 'a renamed page never shows its old label');
  assert.equal((html.match(/is-missing/g) || []).length, 2, 'a trashed page and a missing page both read as deleted');
  assert.match(html, /<span class="markdown-page-title">Deleted page<\/span>/);
  // A page block only matches by id: a title that happens to equal the target is not the page.
  const byTitle = renderMarkdown('[[Old|x]]{page}', { resolveLink: target => (target === 'Old' ? { id: 'other', title: 'Other' } : null) });
  assert.match(byTitle, /is-missing/);
  // Without a resolver (exports, previews that cannot look items up) the stored label shows as plain text.
  assert.match(renderMarkdown('[[n1|Stored label]]{page}'), /<div class="markdown-page" data-target="n1" data-label="Stored label"><span class="markdown-page-link">.*Stored label<\/span><\/span><\/div>$/);
  assert.doesNotMatch(renderMarkdown('[[n1|Stored label]]{page}'), /is-missing|<a /);
  assert.match(renderMarkdown('[[n1|C]]{page}', { compact: true, resolveLink: resolver(items) }), /markdown-page-link/, 'cards render page rows too');
  assert.match(renderMarkdown(':::toggle [open] More\n[[n1|C]]{page}\n:::', { resolveLink: resolver(items) }), /<details[^>]*><summary>More<\/summary><div><div class="markdown-page"/);
  assert.equal(plainText('Intro\n[[n1|Child page]]{page}'), 'Intro\nChild page', 'excerpts and word counts read the label, never the id');
  assert.equal(wordCount('[[n1|Two words]]{page}'), 2);
});

test('page targets count as links, and a leading page block is not the note title', () => {
  assert.deepEqual(extractWikiLinks('See [[Alpha]]\n[[n1|Child]]{page}\n```\n[[n2|Code]]{page}\n```'), ['Alpha', 'n1']);
  assert.equal(noteTitleFromContent('[[n1|Child]]{page}\nReal first line'), 'Real first line');
});

/* ------------------------------------------------------------------ images */

test('a line that is only an http(s) image renders as an image; everything else keeps the link behaviour', () => {
  assert.deepEqual(standaloneImage('![Chart of results](https://example.com/a.png)'), { src: 'https://example.com/a.png', alt: 'Chart of results', title: '' });
  assert.deepEqual(standaloneImage('  ![a \\] b](<https://example.com/x y.png>)  '), null, 'an address with spaces is not a safe image');
  assert.deepEqual(standaloneImage('![a](https://example.com/p%28x%29.png "Caption")'), { src: 'https://example.com/p%28x%29.png', alt: 'a', title: 'Caption' });
  assert.deepEqual(standaloneImage('![a](<https://example.com/b.png>)')?.src, 'https://example.com/b.png', 'the block editor writes <url> destinations');
  assert.equal(standaloneImage('![a](https://example.com/w_(x).png)')?.src, 'https://example.com/w_(x).png', 'balanced parentheses stay part of the address');
  for (const text of ['![a](javascript:alert(1))', '![a](data:image/png;base64,AAAA)', '![a](mailto:a@b.com)', 'see ![a](https://e.com/a.png)', '![a](https://e.com/a.png) and more', '![a](https://e.com/a.png)\\\n![b](https://e.com/b.png)'])
    assert.equal(standaloneImage(text), null, text);
  const html = renderMarkdown('# Article\n![Diagram “one”](https://example.com/d.png)\n_Figure 1_');
  assert.match(html, /<p class="markdown-image"><img src="https:\/\/example.com\/d.png" alt="Diagram “one”" loading="lazy" decoding="async" referrerpolicy="no-referrer"><\/p><p><em>Figure 1<\/em><\/p>$/);
  assert.match(renderMarkdown('![x" onerror="alert(1)](https://example.com/a.png)'), /alt="x&quot; onerror=&quot;alert\(1\)"/, 'alt text is escaped');
  assert.match(renderMarkdown('- ![a](https://example.com/a.png)'), /markdown-media-link/, 'images inside lists stay links');
  assert.match(renderMarkdown('![a](javascript:alert(1))'), /^<p>!\[a\]\(javascript:alert\(1\)\)<\/p>$/);
  assert.equal(htmlToMarkdown(renderMarkdown('![Pic](https://example.com/p.png)')), '![Pic](<https://example.com/p.png>)', 'a copied image pastes back as an image line');
});

/* ------------------------------------------------------------------ block editor */

test('/page is its own slash command; the note-link command no longer answers to "page"', () => {
  const full = slashCatalogue({ links: true, page: true, embed: true, importFiles: true, ai: true });
  assert.equal(findBlockCommands('/page', full)[0][0], 'page');
  for (const alias of ['subpage', 'child', 'nested', 'newpage']) assert.equal(findBlockCommands(alias, full)[0][0], 'page', alias);
  assert.equal(findBlockCommands('wiki', full)[0][0], 'note-link');
  assert.equal(findBlockCommands('mention', full)[0][0], 'note-link');
  assert.equal(findBlockCommands('backlink', full)[0][0], 'note-link');
  assert.deepEqual(findBlockCommands('/page', slashCatalogue({ links: true })).map(c => c[0]), [], 'without a host that creates pages, /page offers nothing');
  assert.ok(!slashCatalogue({}).some(c => c[0] === 'page' || c[0] === 'note-link'), 'extras appear only when the host enables them');
  assert.equal(findBlockCommands('').length, BLOCK_COMMANDS.length, 'the host-free catalogue is unchanged');
});

test('page rows copied out of a preview paste back as the same page block', () => {
  const items = [item('n1', { title: 'Child page' })];
  const source = '# Parent\nIntro\n[[n1|Child page]]{page}\n- a';
  assert.equal(htmlToMarkdown(renderMarkdown(source, { resolveLink: resolver(items) })), source);
  assert.equal(htmlToMarkdown(renderMarkdown('[[gone|Old title]]{page}', { resolveLink: () => null })), '[[gone|Old title]]{page}', 'a deleted page keeps its reference');
  assert.equal(htmlToMarkdown('<div class="rich-page" data-target="n1" data-label="Child"><button>Child</button></div>'), '[[n1|Child]]{page}', 'from the editor DOM too');
  assert.equal(htmlToMarkdown('<p>See <a class="note-link markdown-page-link" data-target="n1" data-label="Child">Child</a> here</p>'), 'See [[n1|Child]] here', 'inside a sentence it is a wiki link');
});

/* ------------------------------------------------------------------ selectors: browse lists, Trash, page helpers */

function library() {
  const items = [
    item('root', { title: 'Project', collectionId: 'c1', updatedAt: at(5) }),
    item('child', { title: 'Research', parentId: 'root', collectionId: 'c1', createdAt: at(2), favorite: true, tags: ['ai'] }),
    item('grand', { title: 'Sources', parentId: 'child', collectionId: 'c1', createdAt: at(3) }),
    item('article', { type: 'article', title: 'Saved article', url: 'https://a.com', updatedAt: at(4) }),
    item('research', { title: 'Findings', parentId: 'article' }),
    item('orphan', { title: 'Orphan', parentId: 'missing' }),
    item('trashedParent', { title: 'Old page', deletedAt: at(9) }),
    item('trashedKid', { title: 'Old kid', parentId: 'trashedParent', deletedAt: at(9) }),
    item('trashedGrand', { title: 'Old grand', parentId: 'trashedKid', deletedAt: at(9) }),
    item('soloKid', { title: 'Trashed alone', parentId: 'trashedParent', deletedAt: at(8) }),
  ];
  return { updatedAt: 'v1', items, collections: [{ id: 'c1', name: 'Work', parentId: '' }], settings: {} };
}

test('browse lists hide subpages; search, favorites and tags show them; Trash shows what was trashed on its own', () => {
  const select = createSelectors(library);
  const ids = view => select.itemsForView({ view }).map(i => i.id).sort();
  assert.deepEqual(ids('all'), ['article', 'orphan', 'root'], 'a subpage under any live item (note or article) sits under it');
  assert.deepEqual(ids('notes'), ['orphan', 'research', 'root'], 'a note under an article still appears in Notes views');
  assert.deepEqual(ids('type:note'), ['orphan', 'research', 'root']);
  assert.deepEqual(ids('collection:c1'), ['root']);
  assert.deepEqual(ids('inbox'), ['article', 'orphan']);
  assert.deepEqual(ids('favorites'), ['child'], 'favorites stay flat');
  assert.deepEqual(ids('tag:ai'), ['child'], 'tags stay flat');
  assert.deepEqual(select.itemsForView({ view: 'all', query: 'research' }).map(i => i.id), ['child'], 'search results include subpages');
  assert.deepEqual(ids('trash'), ['soloKid', 'trashedParent'], 'a subpage trashed with its page is counted on the page row');
  assert.deepEqual(select.itemsForView({ view: 'trash', query: 'old' }).map(i => i.id).sort(), ['trashedGrand', 'trashedKid', 'trashedParent'], 'searching Trash finds every page');
  assert.equal(select.trashedWith('trashedParent'), 2, 'kid and grandchild went with it; the one trashed separately did not');
  assert.equal(select.trashedWith('root'), 0);
  assert.deepEqual(trashedTogetherIds(library().items, 'trashedParent').sort(), ['trashedGrand', 'trashedKid']);
  assert.equal(select.counts().notes, 5, 'counts stay item counts (documented): every live note, subpages included');
  for (const view of ['all', 'inbox', 'notes', 'type:note', 'collection:x']) assert.equal(isBrowseView(view), true, view);
  for (const view of ['favorites', 'highlights', 'reminders', 'tag:x', 'untagged', 'duplicates', 'archive', 'trash']) assert.equal(isBrowseView(view), false, view);

  // An archived parent does not hide its live subpage in browse views or Notes tree.
  const withArchivedParent = () => {
    const base = library();
    base.items.push(
      item('archivedParent', { title: 'Archived parent', archived: true }),
      item('childOfArchived', { title: 'Live subpage of archived', parentId: 'archivedParent' }),
    );
    return base;
  };
  const archSelect = createSelectors(withArchivedParent);
  assert.equal(archSelect.parentOf('childOfArchived'), null, 'liveParentOf ignores archived parents');
  assert.ok(archSelect.itemsForView({ view: 'notes' }).some(i => i.id === 'childOfArchived'));
  assert.ok(archSelect.itemsForView({ view: 'all' }).some(i => i.id === 'childOfArchived'));

  // findByUrl / savedForUrl also matches item.sourceUrl when an article was saved under its canonical URL.
  const withCanonical = () => {
    const base = library();
    base.items.push(
      item('canonArt', { type: 'article', url: 'https://example.com/canonical', sourceUrl: 'https://example.com/tab-url?utm_source=x' }),
      // Saved from a page with "Save link" / "Save image": sourceUrl is the page it was found on, not the item.
      item('linkFromPage', { type: 'bookmark', url: 'https://other.example/linked', sourceUrl: 'https://example.com/listing' }),
      item('imageFromPage', { type: 'image', url: 'https://cdn.example/pic.png', sourceUrl: 'https://example.com/listing' }),
      item('pageNote', { url: 'https://example.com/tab-url' }),
    );
    return base;
  };
  const canonSelect = createSelectors(withCanonical);
  assert.equal(canonSelect.savedForUrl('https://example.com/tab-url')?.id, 'canonArt');
  assert.equal(canonSelect.savedForUrl('https://example.com/canonical')?.id, 'canonArt');
  assert.equal(canonSelect.savedForUrl('https://example.com/listing'), null, 'a page a link or image was saved from is not saved itself');
  assert.deepEqual(canonSelect.findByUrl('https://example.com/listing'), []);
  assert.deepEqual(canonSelect.findByUrl('https://example.com/tab-url').map(i => i.id), ['pageNote', 'canonArt'], 'direct matches come first');
  assert.deepEqual(canonSelect.notesForUrl('https://example.com/tab-url').map(i => i.id), ['pageNote']);
});

test('page selectors: children, path, descendants and counts are live-only and loop-safe', () => {
  const lib = library();
  lib.items.push(item('loopA', { parentId: 'loopB' }), item('loopB', { parentId: 'loopA' }));
  const select = createSelectors(() => lib);
  assert.deepEqual(select.children('root').map(i => i.id), ['child']);
  assert.deepEqual(select.pagePath('grand').map(i => i.id), ['root', 'child']);
  assert.deepEqual(select.pageDescendants('root'), ['child', 'grand']);
  assert.equal(select.subpageCount('article'), 1);
  assert.equal(select.parentOf('grand')?.id, 'child');
  assert.equal(select.parentOf('orphan'), null, 'a missing parent means top level');
  assert.equal(select.subpageCount('trashedParent'), 0, 'trashed subpages are not counted');
  assert.ok(select.pagePath('loopA').length <= 2, 'a loop left by an older build never hangs');
  assert.equal(select.children('root'), select.children('root'), 'memoized per library version');
});

/* ------------------------------------------------------------------ Notes list tree and paths */

test('the Notes list shows top-level notes with expandable subpages; a search is flat', () => {
  const lib = library();
  const select = createSelectors(() => lib);
  const notes = lib.items.filter(i => i.type === 'note' && !i.deletedAt);
  const opts = { childrenOf: id => select.children(id), nested: note => !!select.parentOf(note.id) };
  const shape = rows => rows.map(r => `${'  '.repeat(r.depth)}${r.note.id}${r.childCount ? `(${r.childCount}${r.expanded ? ' open' : ''})` : ''}`);
  assert.deepEqual(shape(noteTreeRows(notes, opts)), ['root(1)', 'research', 'orphan']);
  assert.deepEqual(shape(noteTreeRows(notes, { ...opts, expanded: new Set(['root', 'child']) })), ['root(1 open)', '  child(1 open)', '    grand', 'research', 'orphan']);
  assert.deepEqual(shape(noteTreeRows(notes, { ...opts, expanded: new Set(['child']) })), ['root(1)', 'research', 'orphan'], 'a collapsed parent hides the whole subtree');
  assert.deepEqual(noteTreeRows(notes, { ...opts, query: 'sou' }).map(r => [r.note.id, r.depth]), notes.map(n => [n.id, 0]), 'a search lists every match flat');
  const loop = [item('a', { parentId: 'b' }), item('b', { parentId: 'a' }), item('top')];
  assert.deepEqual(noteTreeRows(loop, { childrenOf: id => loop.filter(n => n.parentId === id), nested: n => !!n.parentId, expanded: new Set(['top', 'a', 'b']) }).map(r => r.note.id), ['top']);
  // A note whose parent is archived (not in the unarchived notes list) renders as a top-level entry in noteTreeRows.
  const withArchived = [item('arch', { archived: true }), item('subOfArch', { parentId: 'arch' })];
  const unarchivedNotes = withArchived.filter(n => !n.archived);
  assert.deepEqual(noteTreeRows(unarchivedNotes, { childrenOf: () => [], nested: () => true }).map(r => r.note.id), ['subOfArch']);
  assert.equal(pagePathLabel(['Project', 'Research']), 'Project › Research');
  assert.equal(pagePathLabel(['A', 'B', 'C', 'D']), '… › C › D');
  assert.equal(pagePathLabel([]), '');
  assert.equal(pathOfItem({ select }, lib.items.find(i => i.id === 'grand')), 'Project › Research');
  assert.equal(pathOfItem({ select }, lib.items.find(i => i.id === 'root')), '');
});

test('a subpage is a Notes row of its own whenever its parent is not listed: article, archived, filtered or pinned elsewhere', () => {
  const lib = library();
  lib.items.push(
    item('archived', { title: 'Old project', archived: true }), item('underArchived', { title: 'Still useful', parentId: 'archived' }),
    item('pinnedParent', { title: 'Pinned', pinned: true }), item('pinnedKid', { title: 'Kid of pinned', parentId: 'pinnedParent' }),
    item('elsewhere', { title: 'Other collection', collectionId: 'c2' }), item('filteredKid', { title: 'In c1', parentId: 'elsewhere', collectionId: 'c1' }),
  );
  const select = createSelectors(() => lib);
  const live = lib.items.filter(i => i.type === 'note' && !i.deletedAt && !i.archived);
  const tree = { childrenOf: id => select.children(id).filter(n => !n.archived), nested: note => !!select.parentOf(note.id) };
  const roots = list => noteTreeRows(list, tree).filter(r => r.depth === 0).map(r => r.note.id);
  // The full list: research (under an article) and the subpage of an archived note are top-level rows.
  assert.deepEqual(roots(live).sort(), ['elsewhere', 'orphan', 'pinnedParent', 'research', 'root', 'underArchived']);
  assert.deepEqual(select.pagePath('underArchived').map(i => i.id), ['archived'], 'its row can still name the archived parent');
  assert.deepEqual(select.pagePath('research').map(i => i.id), ['article']);
  // A collection filter that leaves the parent out: the subpage is a row of its own instead of vanishing.
  assert.deepEqual(roots(live.filter(n => n.collectionId === 'c1')).sort(), ['filteredKid', 'root']);
  // Pinned and the rest are two lists of one pane: a subpage of a pinned page sits under it, not again among the rest.
  const listed = new Set(live.map(n => n.id));
  const rest = live.filter(n => !n.pinned);
  assert.ok(roots(rest).includes('pinnedKid'), 'judged by its own group alone, the kid would be listed a second time');
  assert.ok(!noteTreeRows(rest, { ...tree, listed }).some(r => r.note.id === 'pinnedKid'), 'with it, the kid is not a second top-level row');
  assert.deepEqual(noteTreeRows(live.filter(n => n.pinned), { ...tree, listed, nested: () => false, expanded: new Set(['pinnedParent']) }).map(r => r.note.id),
    ['pinnedParent', 'pinnedKid'], 'it is reached by expanding its pinned parent');
  // The library browse lists agree: Notes keeps subpages of articles and of archived notes, All items keeps the latter.
  assert.ok(['research', 'underArchived'].every(id => select.itemsForView({ view: 'notes' }).some(i => i.id === id)));
  assert.ok(['research', 'underArchived'].every(id => select.itemsForView({ view: 'type:note' }).some(i => i.id === id)));
  assert.ok(select.itemsForView({ view: 'all' }).some(i => i.id === 'underArchived'));
  assert.ok(!select.itemsForView({ view: 'notes' }).some(i => i.id === 'pinnedKid' || i.id === 'child'), 'a subpage of a live note stays under it');
});

/* ------------------------------------------------------------------ editor: breadcrumbs, move picker, trash */

test('breadcrumbs keep every ancestor while they fit and fold the middle into a menu', () => {
  const chain = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }));
  const shape = trail => trail.map(entry => (entry.more ? `…${entry.more.map(x => x.id).join('')}` : entry.item.id)).join(' ');
  assert.equal(shape(crumbTrail(chain.slice(0, 3), 3)), 'a b c');
  assert.equal(shape(crumbTrail(chain, 3)), 'a …bc d e');
  assert.equal(shape(crumbTrail(chain, 2)), '…abc d e', 'the side panel keeps the nearest pages');
  assert.equal(shape(crumbTrail(chain, 1)), '…abcd e');
  assert.deepEqual(crumbTrail([], 3), []);
});

test('"Move to page" offers live items, never the note itself or its subpages, notes first', () => {
  const items = [...library().items, item('child2', { title: 'Project notes', parentId: 'root' }), item('trashedDesc', { title: 'Hidden', parentId: 'child', deletedAt: at(9) })];
  const ids = options => pageMoveCandidates(items, options).map(i => i.id);
  const forRoot = ids({ id: 'root' });
  for (const blocked of ['root', 'child', 'grand', 'child2', 'trashedParent', 'trashedDesc']) assert.ok(!forRoot.includes(blocked), blocked);
  assert.ok(forRoot.includes('article') && forRoot.includes('orphan'), 'any live item can hold a page');
  assert.deepEqual(ids({ id: 'grand', query: 'proj' }), ['root', 'child2'], 'title matches only; prefix matches first');
  assert.ok(ids({ id: 'grand', query: 'saved' }).includes('article'));
  assert.ok(ids({ id: 'grand' }).indexOf('article') > ids({ id: 'grand' }).indexOf('orphan'), 'notes rank before other items');
});

test('moving to Trash counts the subpages that go along, in the prompt and the toast', async () => {
  const lib = library();
  assert.equal(subpagesMoving(lib, ['root']), 2);
  assert.equal(subpagesMoving(lib, ['root', 'child']), 1, 'an item that is itself being trashed is not counted twice');
  assert.equal(subpagesMoving(lib, ['article']), 1, 'a saved article takes its research subpages along');
  assert.equal(trashMessage(1, 2), 'Moved 1 item and 2 subpages to Trash');
  assert.equal(trashMessage(2), 'Moved 2 items to Trash');
  assert.equal(restoreMessage(2, { subpages: 3 }), 'Restored 2 items and 3 subpages');
  assert.equal(restoreMessage(1, { lifted: 1 }), 'Restored 1 item. It moved to the top level because the parent page is still in Trash or was deleted.');
  const asked = [];
  const ctx = { library: { ...lib, settings: { confirmDelete: true } }, confirm: async options => { asked.push(options); return true; } };
  await confirmTrash(ctx, [lib.items[0]]);
  assert.equal(asked[0].body, 'Its 2 subpages move to Trash too. You can restore items from Trash until you empty it.');
  await confirmTrash(ctx, [lib.items[3]]);
  assert.equal(asked[1].body, 'Its subpage moves to Trash too. You can restore items from Trash until you empty it.');
  await confirmTrash(ctx, [lib.items[5]]);
  assert.equal(asked[2].body, 'You can restore items from Trash until you empty it.', 'unchanged without subpages');
  const toasts = [];
  const writes = [];
  const fake = { library: lib, state: { selection: new Set(), panel: null }, select: { byId: id => lib.items.find(i => i.id === id) },
    confirm: async () => true, store: { bulkUpdateItems: async changes => { writes.push(changes); return changes; } },
    toast: message => toasts.push(message), render() {}, closePanel() {} };
  await trashItems(fake, ['root']);
  assert.deepEqual(writes[0].map(change => change.id), ['root'], 'only the page is patched; the store cascades the same stamp');
  assert.equal(toasts[0], 'Moved 1 item and 2 subpages to Trash');
});

/* ------------------------------------------------------------------ library: delete forever, duplicate merge */

test('delete forever skips ids a cascade already removed and cleans the files the store reports', async () => {
  const calls = [];
  const store = {
    async permanentlyDeleteItem(id) {
      calls.push(id);
      if (id === 'page') return { id, ids: ['page', 'sub1', 'sub2'], attachmentIds: ['blob-sub1'] };
      if (id === 'gone') throw new Error('Item no longer exists.');
      return { id, ids: [id], attachmentIds: id === 'file' ? ['blob-file'] : [] };
    },
  };
  const outcome = await deleteItemsForever(store, ['page', 'sub1', 'file', 'gone', 'sub2']);
  assert.deepEqual(calls, ['page', 'file', 'gone'], 'subpages deleted by the cascade are not asked for again');
  assert.deepEqual(outcome.ids.sort(), ['file', 'gone', 'page', 'sub1', 'sub2']);
  assert.deepEqual(outcome.attachmentIds.sort(), ['blob-file', 'blob-sub1']);
  const partial = { ids: [], attachmentIds: [] };
  const failing = { async permanentlyDeleteItem(id) { if (id === 'b') throw new Error('Storage is full'); return { id, ids: [id], attachmentIds: [`f-${id}`] }; } };
  await assert.rejects(deleteItemsForever(failing, ['a', 'b', 'c'], partial), /Storage is full/);
  assert.deepEqual(partial, { ids: ['a'], attachmentIds: ['f-a'] }, 'a failure halfway still tells the caller which files to clean');
  const legacy = await deleteItemsForever({ async permanentlyDeleteItem(id) { return { id }; } }, ['x']);
  assert.deepEqual(legacy, { ids: ['x'], attachmentIds: [] });
});

test('merging duplicates moves subpages of a removed copy under the kept one, one patch per item', () => {
  const keep = item('new', { type: 'article', url: 'https://a.com' });
  const old = item('old', { type: 'article', url: 'https://a.com/' });
  const research = item('research', { parentId: 'old' });
  const both = item('both', { parentId: 'old', relatedIds: ['old', 'x'] });
  const deep = item('deep', { parentId: 'research' });
  const trashed = item('trashedSub', { parentId: 'old', deletedAt: at(3) });
  const changes = planMerge([keep, old], [keep, old, research, both, deep, trashed], { now: 'NOW' });
  assert.deepEqual(changes.map(c => c.id), ['new', 'old', 'research', 'both'], 'grandchildren follow their parent; trashed subpages are left alone');
  assert.deepEqual(changes[1], { id: 'old', patch: { deletedAt: 'NOW' } });
  assert.deepEqual(changes[2], { id: 'research', patch: { parentId: 'new' } });
  assert.deepEqual(changes[3], { id: 'both', patch: { parentId: 'new', relatedIds: ['new', 'x'] } }, 'a subpage that also linked to the copy gets a single combined patch');

  // A kept copy inside a removed copy first moves above every removed copy on its path, so the removed copy's subpages
  // (its own former parent included) can all move under it: none is left for the trash cascade, and no loop forms.
  const top = item('top');
  const loser = item('loser', { type: 'note', url: 'https://a.com', parentId: 'top' });
  const mid = item('mid', { parentId: 'loser' });
  const winner = item('winner', { type: 'note', url: 'https://a.com', parentId: 'mid' });
  const sibling = item('sibling', { parentId: 'loser' });
  const cycleSafe = planMerge([winner, loser], [top, loser, mid, winner, sibling], { now: 'NOW' });
  const byTarget = Object.fromEntries(cycleSafe.map(c => [c.id, c.patch]));
  assert.equal(byTarget.winner.parentId, 'top', 'winner lifts to the first page above the removed copy');
  assert.deepEqual(byTarget.mid, { parentId: 'winner' }, 'its former parent moves under it instead of going to Trash with the copy');
  assert.equal(byTarget.sibling.parentId, 'winner', 'other subpages of loser still move under winner');
  assert.equal(byTarget.top, undefined, 'a page above the removed copy stays where it is');
});

// Applies a planned change list through the real store (its trash cascade and loop checks) and returns the library.
async function applyThroughStore(items, plan) {
  let value = { items: structuredClone(items), collections: [] };
  const store = createLibraryStore({ read: async () => structuredClone(value), write: async state => { value = structuredClone(state); } });
  const before = await store.dispatch('loadLibrary', []);
  const changes = plan(before.items);
  await store.dispatch('bulkUpdateItems', [changes]);
  const after = structuredClone(value);
  return { before, after, changes, store, get value() { return value; } };
}
const byIdOf = library => new Map(library.items.map(entry => [entry.id, entry]));
// Every parent chain ends: walking up from any item never meets the item again.
const assertNoLoop = library => {
  const index = byIdOf(library);
  for (const start of library.items) {
    const seen = new Set([start.id]);
    for (let cur = index.get(start.parentId); cur; cur = index.get(cur.parentId)) {
      assert.ok(!seen.has(cur.id), `${start.id} sits inside itself`);
      seen.add(cur.id);
    }
  }
};

test('Keep newest and Merge send only the removed copies to Trash and never build a loop (through the store)', async () => {
  const [keep, old] = [item('keep', { type: 'article', url: 'https://dup.example/a', updatedAt: at(5) }), item('old', { type: 'article', url: 'https://dup.example/a/' })];
  const articles = [keep, old, item('sub', { parentId: 'old' }), item('grand', { parentId: 'sub' }), item('gone', { parentId: 'old', deletedAt: at(3) }), item('mine', { parentId: 'keep' })];
  for (const [label, plan] of [['Keep newest', all => planKeepNewest([keep, old], all, { now: at(9) })], ['Merge', all => planMerge([keep, old], all, { now: at(9) })]]) {
    const { after } = await applyThroughStore(articles, plan);
    const result = byIdOf(after);
    assert.equal(result.get('old').deletedAt, at(9), `${label}: the older copy is in Trash`);
    for (const id of ['keep', 'sub', 'grand', 'mine']) assert.equal(result.get(id).deletedAt, null, `${label}: ${id} stays live`);
    assert.deepEqual([result.get('sub').parentId, result.get('grand').parentId], ['keep', 'sub'], `${label}: the subtree moves under the kept copy`);
    assert.equal(result.get('gone').deletedAt, at(3), `${label}: a subpage already in Trash is left alone`);
    assertNoLoop(after);
  }

  // A kept copy nested inside a removed copy (possible for notes): the merge lifts it above every removed copy.
  const nested = [item('top'), item('loser', { url: 'https://n.example', parentId: 'top' }), item('mid', { parentId: 'loser' }),
    item('winner', { url: 'https://n.example', parentId: 'mid', updatedAt: at(5) }), item('sibling', { parentId: 'loser' }), item('deep', { parentId: 'winner' })];
  const pick = all => ['winner', 'loser'].map(id => all.find(entry => entry.id === id));
  for (const [label, plan] of [['Keep newest', all => planKeepNewest(pick(all), all, { now: at(9) })], ['Merge', all => planMerge(pick(all), all, { now: at(9) })]]) {
    const { after } = await applyThroughStore(nested, plan);
    const result = byIdOf(after);
    assert.equal(result.get('loser').deletedAt, at(9), label);
    for (const id of ['top', 'mid', 'winner', 'sibling', 'deep']) assert.equal(result.get(id).deletedAt, null, `${label}: ${id} stays live`);
    assert.deepEqual(['winner', 'mid', 'sibling', 'deep'].map(id => result.get(id).parentId), ['top', 'winner', 'winner', 'winner'], label);
    assertNoLoop(after);
  }

  // Two removed copies on the kept copy's path, and a loop left by an older build between the kept copy and a removed one.
  const stacked = [item('a1', { url: 'https://s.example', parentId: 'x' }), item('x', { parentId: 'a2' }), item('a2', { url: 'https://s.example', parentId: 'root' }),
    item('root'), item('k', { url: 'https://s.example', parentId: 'a1', updatedAt: at(5) })];
  const plan = planKeepNewest(['k', 'a1', 'a2'].map(id => stacked.find(entry => entry.id === id)), stacked, { now: at(9) });
  assert.deepEqual(plan.find(change => change.id === 'k').patch, { parentId: 'root' }, 'above the highest removed copy');
  const looped = [item('k2', { url: 'https://l.example', parentId: 'l2' }), item('l2', { url: 'https://l.example', parentId: 'k2' })];
  assert.deepEqual(planKeepNewest(looped, looped, { now: at(9) })[0], { id: 'k2', patch: { parentId: '' } }, 'a loop through a removed copy ends at the top level');
  const { after } = await applyThroughStore(stacked, all => planKeepNewest(['k', 'a1', 'a2'].map(id => all.find(entry => entry.id === id)), all, { now: at(9) }));
  assert.deepEqual(['k', 'x'].map(id => [byIdOf(after).get(id).parentId, byIdOf(after).get(id).deletedAt]), [['root', null], ['k', null]]);
  assertNoLoop(after);
});

test('Undo of Keep newest puts the copy and its subpages back', async () => {
  const items = [item('keep', { type: 'article', url: 'https://u.example', updatedAt: at(5) }), item('old', { type: 'article', url: 'https://u.example' }), item('sub', { parentId: 'old' })];
  const run = await applyThroughStore(items, all => planKeepNewest(all.slice(0, 2), all, { now: at(9) }));
  const undo = undoFor(run.changes, id => run.before.items.find(entry => entry.id === id));
  await run.store.dispatch('bulkUpdateItems', [undo]);
  const result = byIdOf(run.value);
  assert.deepEqual([result.get('old').deletedAt, result.get('sub').parentId, result.get('sub').deletedAt], [null, 'old', null]);
});

test('library.dupe-keep reparents subpages of older duplicates onto the kept newest copy before trashing', async () => {
  const keep = item('keep', { type: 'article', url: 'https://dup.example/a' });
  const old = item('old', { type: 'article', url: 'https://dup.example/a' });
  const sub = item('sub', { parentId: 'old', title: 'Research subpage' });
  const all = [keep, old, sub];
  const writes = [];
  const fakeCtx = {
    library: { items: all, settings: {} },
    select: {
      duplicates: () => [{ url: 'https://dup.example/a', items: [keep, old] }],
      byId: id => all.find(i => i.id === id) || null,
    },
    store: { bulkUpdateItems: async changes => { writes.push(changes); return changes; } },
    toast() {},
    render() {},
  };
  await dispatch('library.dupe-keep', { ctx: fakeCtx, data: { url: 'https://dup.example/a' } });
  assert.equal(writes.length, 1);
  const subChange = writes[0].find(c => c.id === 'sub');
  const oldChange = writes[0].find(c => c.id === 'old');
  assert.deepEqual(subChange, { id: 'sub', patch: { parentId: 'keep' } });
  assert.ok(oldChange?.patch?.deletedAt);
  assert.ok(writes[0].indexOf(subChange) < writes[0].indexOf(oldChange), 'subpage is reparented before loser is trashed');
});

test('command palette itemOption includes the parent page trail for subpages', () => {
  const lib = library();
  const select = createSelectors(() => lib);
  const ctx = { select };
  const grand = lib.items.find(i => i.id === 'grand');
  const research = lib.items.find(i => i.id === 'research');
  const root = lib.items.find(i => i.id === 'root');
  assert.equal(itemOption(ctx, grand).hint, 'Note · Project › Research · Work');
  assert.equal(itemOption(ctx, research).hint, 'Note · Saved article · Inbox');
  assert.equal(itemOption(ctx, root).hint, 'Note · Work');
});

/* ------------------------------------------------------------------ map edges and the research trigger */

test('the map links a page to its subpages without changing the stored records', () => {
  const items = [item('p', { relatedIds: ['x'] }), item('c', { parentId: 'p' }), item('d', { parentId: 'p' }), item('e', { parentId: 'elsewhere' })];
  const linked = withPageLinks(items);
  assert.deepEqual(linked[0].relatedIds, ['x', 'c', 'd']);
  assert.deepEqual(items[0].relatedIds, ['x'], 'the library copy is untouched');
  assert.equal(linked[1], items[1], 'records that gain nothing are not copied');
  assert.deepEqual(filterMapItems(linked, { query: 'c', search: (rows, q) => rows.filter(r => r.id === q) }).items.map(i => i.id).sort(), ['c', 'p'], 'a matching subpage brings its page along');
});

test('research entries appear only once the research view registered research.start, and never for Trash', () => {
  const live = item('a');
  // ui/research.js may already be loaded through the import graph; register a stand-in only when it is not.
  if (!hasAction('research.start')) {
    assert.equal(researchMenuItem(live), null, 'no dead menu entry without the action');
    registerActions({ 'research.start': () => {} });
  }
  assert.deepEqual(researchMenuItem(live), { label: 'Research more with AI', icon: 'telescope', action: 'research.start', data: { id: 'a' } });
  assert.equal(researchMenuItem(item('t', { deletedAt: at(2) })), null);
  assert.equal(researchMenuItem(null), null);
});
