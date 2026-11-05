import test from 'node:test';
import assert from 'node:assert/strict';
import { recentNotes, scopeNotes, clampLimit, pickerNotes, captureDraft, quickAppend, appendBlock, excerptSource } from '../extension/ui/widgets/notes-kit/model.js';

const note = (id, extra = {}) => ({ id, type: 'note', title: id, content: '', collectionId: '', tags: [], updatedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', ...extra });
const NOTES = [
  note('a', { collectionId: 'design', updatedAt: '2026-10-05T00:00:00.000Z', tags: ['Launch'] }),
  note('b', { collectionId: 'type', updatedAt: '2026-10-07T00:00:00.000Z' }),
  note('c', { updatedAt: '2026-10-06T00:00:00.000Z', createdAt: '2026-03-01T00:00:00.000Z' }),
  note('d', { updatedAt: '2026-10-08T00:00:00.000Z', sticky: { color: 'yellow' } }),
  note('e', { pinned: true, collectionId: 'travel', updatedAt: '2026-09-01T00:00:00.000Z' }),
  note('f', { deletedAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }),
  note('g', { archived: true, updatedAt: '2026-10-09T00:00:00.000Z' }),
  { id: 'link', type: 'bookmark', title: 'link', updatedAt: '2026-10-10T00:00:00.000Z' },
];

test('recentNotes lists live notes, pinned first, then newest edit, and leaves sticky notes out', () => {
  const { rows, total } = recentNotes(NOTES);
  assert.deepEqual(rows.map(n => n.id), ['e', 'b', 'c', 'a']);
  assert.equal(total, 4);
  assert.deepEqual(recentNotes(NOTES, { includeStickies: true }).rows.map(n => n.id), ['e', 'd', 'b', 'c', 'a']);
});

test('recentNotes filters by collection subtree, Inbox and tag', () => {
  assert.deepEqual(recentNotes(NOTES, { collectionId: 'design', within: ['design', 'type'] }).rows.map(n => n.id), ['b', 'a'], 'nested collections count');
  assert.deepEqual(recentNotes(NOTES, { collectionId: 'design' }).rows.map(n => n.id), ['a'], 'without a subtree only the collection itself');
  assert.deepEqual(recentNotes(NOTES, { collectionId: '' }).rows.map(n => n.id), ['c'], "'' is the Inbox");
  assert.deepEqual(recentNotes(NOTES, { collectionId: '*', tag: '#launch' }).rows.map(n => n.id), ['a'], 'tags match without case or #');
  assert.deepEqual(recentNotes(NOTES, { collectionId: 'missing', within: new Set(['missing']) }).rows, []);
});

test('recentNotes sorts by creation or title and caps the list while reporting the total', () => {
  assert.deepEqual(recentNotes(NOTES, { sort: 'created' }).rows.map(n => n.id), ['e', 'c', 'a', 'b']);
  assert.deepEqual(recentNotes(NOTES, { sort: 'title' }).rows.map(n => n.id), ['e', 'a', 'b', 'c']);
  const capped = recentNotes(NOTES, { limit: 2 });
  assert.deepEqual([capped.rows.length, capped.total], [2, 4]);
  assert.deepEqual([clampLimit(0), clampLimit('3'), clampLimit(500), clampLimit('x')], [8, 3, 50, 8]);
});

test('scopeNotes keeps sticky notes unless asked and ignores non-notes', () => {
  assert.deepEqual(scopeNotes(NOTES).map(n => n.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(scopeNotes(NOTES, { includeStickies: false }).map(n => n.id), ['a', 'b', 'c', 'e']);
  assert.deepEqual(scopeNotes(null), []);
});

test('pickerNotes ranks title matches above text matches and can prefer checklists', () => {
  const notes = [
    note('Plans', { content: 'see launch plan', updatedAt: '2026-10-09T00:00:00.000Z' }),
    note('Launch plan', { content: '- [ ] ship', updatedAt: '2026-10-01T00:00:00.000Z' }),
    note('The launch', { updatedAt: '2026-10-05T00:00:00.000Z' }),
    note('Groceries', { content: '- [ ] milk', updatedAt: '2026-10-02T00:00:00.000Z' }),
  ];
  assert.deepEqual(pickerNotes(notes, { query: 'launch' }).map(n => n.id), ['Launch plan', 'The launch', 'Plans']);
  assert.deepEqual(pickerNotes(notes, { query: 'LAUNCH plan' }).map(n => n.id), ['Launch plan', 'Plans']);
  assert.deepEqual(pickerNotes(notes, { preferTasks: true }).map(n => n.id), ['Groceries', 'Launch plan', 'Plans', 'The launch']);
  assert.deepEqual(pickerNotes(notes, { query: 'nothing here' }), []);
  assert.equal(pickerNotes(NOTES).some(n => ['f', 'g', 'link'].includes(n.id)), false);
});

test('captureDraft turns a first line into a title and keeps the rest as the body', () => {
  assert.deepEqual(captureDraft('# Idea for **launch**\n\nBody line\n- [ ] task\n'), { title: 'Idea for launch', content: 'Body line\n- [ ] task' });
  assert.deepEqual(captureDraft('Call Sam'), { title: 'Call Sam', content: '' });
  assert.deepEqual(captureDraft('\n\n  Buy milk  \r\nand bread'), { title: 'Buy milk', content: 'and bread' });
  assert.deepEqual(captureDraft('- [ ] a task first\nmore'), { title: '', content: '- [ ] a task first\nmore' });
  assert.deepEqual(captureDraft('> quoted'), { title: '', content: '> quoted' });
  const long = 'x'.repeat(81);
  assert.deepEqual(captureDraft(`${long}\nnext`), { title: '', content: `${long}\nnext` });
  assert.equal(captureDraft('   \n  '), null);
  assert.equal(captureDraft(undefined), null);
});

test('quickAppend adds paragraphs or tasks at the end of a note', () => {
  assert.equal(quickAppend('Hello', 'World'), 'Hello\n\nWorld');
  assert.equal(quickAppend('- [ ] One\n', '[] Two'), '- [ ] One\n- [ ] Two\n');
  assert.equal(quickAppend('Text', '[ ]   Spaced   task '), 'Text\n\n- [ ] Spaced task');
  assert.equal(quickAppend('Text', '- [ ] Already a task'), 'Text\n\n- [ ] Already a task');
  assert.equal(quickAppend('', 'First'), 'First');
  assert.equal(quickAppend('Keep', '   '), 'Keep');
  assert.equal(appendBlock('A\r\n', 'B\nC'), 'A\r\n\r\nB\r\nC\r\n');
});

test('excerptSource skips what the title already shows', () => {
  assert.equal(excerptSource({ title: '', content: 'First line\nSecond line' }), 'Second line');
  assert.equal(excerptSource({ title: 'Untitled note', content: 'Only' }), '');
  assert.equal(excerptSource({ title: 'Plan', content: '# Plan\nBody' }), 'Body');
  assert.equal(excerptSource({ title: 'Plan', content: '# Other\nBody' }), '# Other\nBody');
  assert.equal(excerptSource(null), '');
});

test('setTaskDone keeps the newest click shown while an earlier write for the same task finishes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // the completed-task linger timer must not keep the test waiting
  const { setTaskDone, shownDone } = await import('../extension/ui/widgets/notes-kit/shared.js');
  let note = { id: 'race-note', type: 'note', content: '- [ ] Buy milk', updatedAt: '2026-11-01T00:00:00.000Z' };
  const writes = [];
  const ctx = {
    select: { byId: id => (id === note.id ? note : null) },
    store: {
      updateItem: (id, patch) => new Promise(resolve => writes.push(() => {
        note = { ...note, ...patch, updatedAt: new Date(Date.parse(note.updatedAt) + 1000).toISOString() };
        resolve(note);
      })),
    },
    render() {}, toast() {},
  };
  const task = () => ({ index: 0, done: /\[x\]/.test(note.content) });
  const first = setTaskDone(ctx, note.id, 0, true);
  const second = setTaskDone(ctx, note.id, 0, false);
  assert.equal(shownDone(note.id, task()), false, 'the box shows the latest click at once');
  while (!writes.length) await new Promise(resolve => setImmediate(resolve));
  writes.shift()();
  await first;
  assert.equal(task().done, true, 'the first write landed');
  assert.equal(shownDone(note.id, task()), false, 'the second click still shows while its write is pending');
  while (!writes.length) await new Promise(resolve => setImmediate(resolve));
  writes.shift()();
  await second;
  assert.equal(task().done, false);
  assert.equal(shownDone(note.id, task()), false);
});
