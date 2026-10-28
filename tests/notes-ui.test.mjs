import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNTITLED, titleValue, normalizeTitle, mergeRelatedIds, readingMinutes, reconcile, applyAiResult, searchLinkCandidates,
  draftDecision, mergeTagList, AI_ACTIONS, trashConfirmation,
} from '../extension/ui/note-editor.js';
import {
  NO_COLLECTION, inCollection, filterNotes, collectionCounts, previewSource, groupTasks, taskTotals, shortAgo, editedLabel, pageNoteDraft,
  remapTaskIndex,
} from '../extension/ui/notes.js';

const note = (id, patch = {}) => ({ id, type: 'note', title: id, content: '', collectionId: '', tags: [], pinned: false,
  createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', ...patch });

test('title field shows the store fallback as empty and saves an empty title as the fallback', () => {
  assert.equal(titleValue(UNTITLED), '');
  assert.equal(titleValue('  Untitled note '), '');
  assert.equal(titleValue('Plan'), 'Plan');
  assert.equal(normalizeTitle('  Weekly   sync \n'), 'Weekly sync');
  assert.equal(normalizeTitle('   '), UNTITLED);
});

test('related ids keep explicit links, add wiki links once and never link a note to itself', () => {
  assert.deepEqual(mergeRelatedIds(['a', 'b'], ['b', 'c', 'self', '', null], 'self'), ['a', 'b', 'c']);
  assert.deepEqual(mergeRelatedIds(undefined, ['x'], 'y'), ['x']);
  assert.deepEqual(mergeRelatedIds(['self'], [], 'self'), []);
});

test('reading time rounds to whole minutes and is zero for an empty note', () => {
  assert.equal(readingMinutes(0), 0);
  assert.equal(readingMinutes(10), 1);
  assert.equal(readingMinutes(460), 2);
});

test('reconcile tells metadata-only changes, own saves, clean reloads and real conflicts apart', () => {
  const base = { title: 'A', text: 'one', updatedAt: 't1' };
  assert.equal(reconcile(base, null), 'gone');
  assert.equal(reconcile(base, { title: 'A', content: 'one', updatedAt: 't1' }), 'same');
  assert.equal(reconcile(base, { title: 'A', content: 'one', updatedAt: 't2', tags: ['x'] }, { dirty: true }), 'rebase');
  assert.equal(reconcile(base, { title: 'A', content: 'two', updatedAt: 't2' }, { dirty: true, pending: { title: 'A', text: 'two' } }), 'own');
  assert.equal(reconcile(base, { title: 'A', content: 'remote', updatedAt: 't2' }, { dirty: false }), 'reload');
  assert.equal(reconcile(base, { title: 'A', content: 'remote', updatedAt: 't2' }, { dirty: true }), 'conflict');
  assert.equal(reconcile(base, { title: 'Renamed', content: 'one', updatedAt: 't2' }, { dirty: true }), 'conflict');
  // An inline editor only owns its field: a title change elsewhere is metadata to it.
  assert.equal(reconcile(base, { title: 'Renamed', content: 'one', updatedAt: 't2' }, { dirty: true, title: false }), 'rebase');
});

test('AI results replace the selected range or go below the selection line as their own paragraph', () => {
  const md = 'Intro line\n\nSecond paragraph here.\nThird line';
  const start = md.indexOf('Second'), end = start + 'Second paragraph'.length;
  assert.equal(applyAiResult(md, { start, end }, 'Better words', 'replace'), 'Intro line\n\nBetter words here.\nThird line');
  assert.equal(applyAiResult(md, { start, end }, '- [ ] Task', 'below'), 'Intro line\n\nSecond paragraph here.\n\n- [ ] Task\n\nThird line');
  assert.equal(applyAiResult('Only line', null, 'Summary', 'below'), 'Only line\n\nSummary\n');
  assert.equal(applyAiResult('', null, 'Start', 'below'), 'Start\n');
  assert.equal(applyAiResult(md, { start, end }, '   ', 'replace'), md, 'empty results change nothing');
  assert.equal(applyAiResult('Short', { start: 2, end: 99 }, 'X', 'replace'), 'Short\n\nX\n', 'an out-of-range selection appends instead');
});

test('the [[ link picker ranks title prefixes and notes first, skipping deleted items and the note itself', () => {
  const items = [
    note('n1', { title: 'Weekly sync', updatedAt: '2026-10-02T00:00:00.000Z' }),
    { id: 'b1', type: 'bookmark', title: 'Weekly digest', url: 'https://example.com/a', updatedAt: '2026-10-03T00:00:00.000Z' },
    note('n2', { title: 'Our weekly plan', updatedAt: '2026-10-04T00:00:00.000Z' }),
    note('n3', { title: 'Weekly old', deletedAt: '2026-10-05T00:00:00.000Z' }),
    note('self', { title: 'Weekly self' }),
  ];
  const results = searchLinkCandidates(items, 'week', { exclude: 'self', collectionName: () => '' });
  assert.deepEqual(results.map(r => r.id), ['n1', 'n2', 'b1']);
  assert.equal(results[2].subtitle, 'example.com');
  assert.equal(results[0].subtitle, 'Note');
  assert.equal(searchLinkCandidates(items, '', { exclude: 'self', limit: 2 }).length, 2);
});

test('drafts restore only on the revision they were written against', () => {
  const item = { title: 'A', content: 'saved', updatedAt: 't1' };
  assert.equal(draftDecision(null, item), 'none');
  assert.equal(draftDecision({ text: 'saved', title: 'A', base: 't0' }, item), 'discard');
  assert.equal(draftDecision({ text: 'typed', title: 'A', base: 't1' }, item), 'restore');
  assert.equal(draftDecision({ text: 'typed', title: 'A', base: 't0' }, item), 'conflict');
  assert.equal(draftDecision({ text: 'saved', title: '', base: 't0' }, { ...item, title: UNTITLED }), 'discard');
});

test('suggested tags merge lowercase without duplicates', () => {
  assert.deepEqual(mergeTagList(['ai'], 'AI, #Agents, design.\n- notes'), ['ai', 'agents', 'design', 'notes']);
  assert.ok(AI_ACTIONS.some(action => action.id === 'translate') && AI_ACTIONS.every(action => action.label && action.icon));
});

test('note lists filter by collection and search, then sort with pinned notes first', () => {
  const notes = [
    note('a', { title: 'Beta', collectionId: 'c1', updatedAt: '2026-10-03T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' }),
    note('b', { title: 'alpha', collectionId: '', updatedAt: '2026-10-05T00:00:00.000Z', createdAt: '2026-09-03T00:00:00.000Z', tags: ['ux'] }),
    note('c', { title: 'Gamma', collectionId: 'c1', pinned: true, updatedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-09-02T00:00:00.000Z', content: 'mentions kyoto' }),
  ];
  assert.deepEqual(filterNotes(notes).map(n => n.id), ['c', 'b', 'a']);
  assert.deepEqual(filterNotes(notes, { sort: 'title' }).map(n => n.id), ['c', 'b', 'a']);
  assert.deepEqual(filterNotes(notes, { sort: 'created' }).map(n => n.id), ['c', 'b', 'a']);
  assert.deepEqual(filterNotes(notes.map(n => ({ ...n, pinned: false })), { sort: 'title' }).map(n => n.id), ['b', 'a', 'c']);
  assert.deepEqual(filterNotes(notes, { collectionId: 'c1' }).map(n => n.id), ['c', 'a']);
  assert.deepEqual(filterNotes(notes, { collectionId: NO_COLLECTION }).map(n => n.id), ['b']);
  assert.deepEqual(filterNotes(notes, { query: 'kyoto' }).map(n => n.id), ['c']);
  assert.deepEqual(filterNotes(notes, { query: '#ux' }).map(n => n.id), ['b']);
  assert.deepEqual(collectionCounts(notes), { total: 3, none: 1, byId: { c1: 2 } });
});

test('the collection filter matches all notes, notes without a collection or one collection', () => {
  const filed = note('f', { collectionId: 'c1' }), loose = note('l');
  assert.ok(inCollection(filed, '') && inCollection(loose, ''));
  assert.ok(!inCollection(filed, NO_COLLECTION) && inCollection(loose, NO_COLLECTION));
  assert.ok(inCollection(filed, 'c1') && !inCollection(loose, 'c1') && !inCollection(filed, 'c2'));
});

test('previews skip a leading heading that repeats the title', () => {
  assert.equal(previewSource('# Plan\n\nBody text', 'Plan'), 'Body text');
  assert.equal(previewSource('## Other\nBody', 'Plan'), '## Other\nBody');
  assert.equal(previewSource('', 'Plan'), '');
});

test('tasks group by note with open, done and all filters', () => {
  const notes = [
    note('old', { content: '- [ ] one\n- [x] two', updatedAt: '2026-10-01T00:00:00.000Z' }),
    note('new', { content: 'Intro\n- [x] three\n```\n- [ ] in code\n```', updatedAt: '2026-10-09T00:00:00.000Z' }),
    note('none', { content: 'No tasks here' }),
  ];
  const open = groupTasks(notes, 'open');
  assert.deepEqual(open.map(g => [g.note.id, g.tasks.map(t => t.plain), g.done, g.total]), [['old', ['one'], 1, 2]]);
  const done = groupTasks(notes, 'done');
  assert.deepEqual(done.map(g => g.note.id), ['new', 'old']);
  assert.deepEqual(groupTasks(notes, 'all').map(g => g.tasks.length), [1, 2]);
  assert.deepEqual(taskTotals(notes), { open: 1, done: 2, all: 3 });
});

test('a task checked outside the editor maps onto the editor\'s unsaved text', () => {
  const stored = '- [ ] Alpha\n- [ ] Beta\n- [ ] Gamma';
  // Same text: same index.
  assert.equal(remapTaskIndex(stored, stored, 1), 1);
  // Unrelated edits keep the index.
  assert.equal(remapTaskIndex(stored, 'Intro\n\n- [ ] Alpha\n- [ ] Beta\n- [ ] Gamma', 2), 2);
  // A task added above moves Beta down one.
  assert.equal(remapTaskIndex(stored, '- [ ] New\n- [ ] Alpha\n- [ ] Beta\n- [ ] Gamma', 1), 2);
  // Repeated texts match by occurrence.
  assert.equal(remapTaskIndex('- [ ] Call\n- [ ] Call', '- [ ] Other\n- [ ] Call\n- [ ] Call', 1), 2);
  // A task deleted or reworded in the editor has no match.
  assert.equal(remapTaskIndex(stored, '- [ ] Alpha\n- [ ] Gamma', 1), null);
  assert.equal(remapTaskIndex(stored, stored.replace('Beta', 'Bravo'), 1), null);
  assert.equal(remapTaskIndex(stored, stored, 7), 7);
  assert.equal(remapTaskIndex(stored, `${stored}\n`, 7), null);
});

test('list ages and card labels stay short', () => {
  const now = Date.parse('2026-10-28T15:00:00');
  const at = offset => new Date(now - offset).toISOString();
  assert.equal(shortAgo(at(20e3), now), 'Now');
  assert.equal(shortAgo(at(5 * 60e3), now), '5m');
  assert.equal(shortAgo(at(3 * 3600e3), now), '3h');
  assert.equal(shortAgo(new Date('2026-10-27T09:00:00').toISOString(), now), 'Yesterday');
  assert.equal(shortAgo(new Date('2026-10-26T09:00:00').toISOString(), now), 'Mon');
  assert.equal(shortAgo(new Date('2026-10-02T09:00:00').toISOString(), now), 'Oct 2');
  assert.equal(shortAgo(new Date('2025-01-02T09:00:00').toISOString(), now), 'Jan 2, 2025');
  assert.equal(shortAgo('not a date', now), '');
  assert.equal(editedLabel(at(20e3), now), 'Edited just now');
  assert.equal(editedLabel(at(3 * 3600e3), now), 'Edited 3h ago');
  assert.equal(editedLabel(new Date('2026-10-27T09:00:00').toISOString(), now), 'Edited yesterday');
  assert.equal(editedLabel(new Date('2026-10-02T09:00:00').toISOString(), now), 'Edited Oct 2');
});

test('the page composer names the note after the page and starts the body with the typed line', () => {
  assert.deepEqual(pageNoteDraft({ url: 'https://example.com/a', title: '  Building   agents ' }, ' First thought '),
    { title: 'Notes on Building agents', content: 'First thought\n', url: 'https://example.com/a' });
  assert.deepEqual(pageNoteDraft({ url: 'https://www.example.com/a', title: '' }, ''), { title: 'Notes on example.com', content: '', url: 'https://www.example.com/a' });
});

test('moving a note to Trash asks first only when the confirm setting is on, in the library\'s words', () => {
  assert.equal(trashConfirmation(undefined), null);
  assert.equal(trashConfirmation({}), null);
  assert.equal(trashConfirmation({ confirmDelete: false }), null);
  assert.equal(trashConfirmation({ confirmDelete: 'true' }), null, 'only a real true turns it on');
  assert.deepEqual(trashConfirmation({ confirmDelete: true }),
    { title: 'Move this note to Trash?', body: 'You can restore it from Trash.', confirmLabel: 'Move to Trash', tone: 'danger' });
});
