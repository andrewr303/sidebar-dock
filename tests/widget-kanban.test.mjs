import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBoard, defaultBoard, normalizeDue, addDays, toDateKey,
  addCard, updateCard, deleteCard, insertCard, nextInColumn, moveCard, moveCardToIndex, stepCard, shiftCard, duplicateCard,
  addChecklistItem, toggleChecklist, updateChecklistItem, removeChecklistItem, checklistProgress,
  createLabel, updateLabel, deleteLabel, toggleLabel, labelByName,
  addColumn, updateColumn, renameColumn, setLimit, setColumnColor, moveColumn, moveColumnBefore, deleteColumn, restoreColumn, clearDone, restoreCards,
  setFilter, clearFilter, isFiltered, filterCards, dueInfo, dueLabel, wipState, columnStats, upNext, cardToMarkdown, columnCards, findCard, toConfig, isDoneColumn,
  settingsErrors, applySettings, settingsNotes, layoutFor,
} from '../extension/ui/widgets/kanban/model.js';

const NOW = '2026-10-30T09:00:00.000Z';
const TODAY = new Date(2026, 9, 30, 9, 0);
const titles = (board, columnId) => columnCards(board, columnId).map(card => card.title);

function sample() {
  return normalizeBoard({
    columns: [{ id: 'a', title: 'To do' }, { id: 'b', title: 'Doing', limit: 2 }, { id: 'c', title: 'Done', done: true }],
    labels: [{ id: 'red', name: 'Bug', color: 'red' }, { id: 'blue', name: 'Feature', color: 'blue' }],
    cards: [
      { id: '1', columnId: 'a', title: 'One', labels: ['red'] },
      { id: '2', columnId: 'a', title: 'Two', description: 'Fix the login form' },
      { id: '3', columnId: 'b', title: 'Three', labels: ['blue'], priority: 'high', due: '2026-11-02' },
      { id: '4', columnId: 'a', title: 'Four', checklist: [{ id: 'x', text: 'Write tests', done: true }, { id: 'y', text: 'Ship', done: false }] },
      { id: '5', columnId: 'c', title: 'Five', due: '2026-10-01' },
    ],
  }, { now: NOW });
}

test('normalizeBoard repairs stored configs', () => {
  const empty = normalizeBoard(undefined, { now: NOW });
  assert.deepEqual(empty.columns.map(c => c.title), ['To do', 'In progress', 'Done']);
  assert.equal(empty.columns[2].done, true);
  assert.deepEqual(empty.cards, []);
  assert.deepEqual(empty.filter, { label: '', query: '' });
  assert.equal(empty.layout, 'auto');

  const board = normalizeBoard({
    columns: [{ id: 'a', title: '  Backlog  ', color: 'purple', limit: -3 }, { id: 'a', title: 'Dupe', limit: '4' }, 'junk'],
    labels: [{ id: 'l1', name: 'Bug', color: 'nope' }, { id: 'l2', name: '   ' }],
    cards: [
      { id: 'c1', columnId: 'missing', title: '', labels: ['l1', 'l2', 'l1'], priority: 'critical', due: '2026-02-30', checklist: [{ text: 'a', done: 1 }, null] },
      { id: 'c1', columnId: 'a', title: 'Second with same id' },
    ],
    filter: { label: 'gone', query: 'x' },
    layout: 'grid',
    extra: true,
  }, { now: NOW });
  assert.equal(board.columns.length, 2);
  assert.equal(board.columns[0].title, 'Backlog');
  assert.equal(board.columns[0].color, '');
  assert.equal(board.columns[0].limit, 0);
  assert.notEqual(board.columns[1].id, 'a', 'duplicate column ids are replaced');
  assert.equal(board.columns[1].limit, 4);
  assert.deepEqual(board.labels, [{ id: 'l1', name: 'Bug', color: 'gray' }]);
  const [first, second] = board.cards;
  assert.equal(first.columnId, 'a', 'unknown column falls back to the first');
  assert.equal(first.title, 'Untitled card');
  assert.deepEqual(first.labels, ['l1']);
  assert.equal(first.priority, 'none');
  assert.equal(first.due, '', 'impossible dates are dropped');
  assert.equal(first.checklist.length, 1);
  assert.equal(first.checklist[0].done, false, 'only true counts as done');
  assert.notEqual(second.id, 'c1', 'duplicate card ids are replaced');
  assert.deepEqual(board.filter, { label: '', query: 'x' });
  assert.equal(board.layout, 'auto');
  assert.equal('extra' in board, false);
  assert.deepEqual(normalizeBoard(board, { now: NOW }), board, 'normalizing twice changes nothing');
});

test('defaultBoard has three columns, labels and teaching cards with a due date in two days', () => {
  const board = defaultBoard(TODAY);
  assert.deepEqual(board.columns.map(c => c.title), ['To do', 'In progress', 'Done']);
  assert.equal(board.columns[1].limit, 3);
  assert.ok(board.labels.length >= 3);
  assert.ok(board.cards.length >= 3);
  assert.ok(board.cards.every(card => board.columns.some(c => c.id === card.columnId)));
  const plan = board.cards.find(card => card.due);
  assert.equal(plan.due, '2026-11-01');
  assert.deepEqual(checklistProgress(plan), { done: 1, total: 3 });
});

test('dates: normalizeDue, toDateKey, addDays, dueInfo and dueLabel', () => {
  assert.equal(normalizeDue('2026-12-31'), '2026-12-31');
  assert.equal(normalizeDue('2026-13-01'), '');
  assert.equal(normalizeDue('31/12/2026'), '');
  assert.equal(toDateKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(addDays(new Date(2026, 11, 31), 1), '2027-01-01');
  assert.deepEqual([dueInfo('2026-10-29', TODAY).state, dueInfo('2026-10-29', TODAY).days], ['overdue', -1]);
  assert.equal(dueInfo('2026-10-30', TODAY).state, 'today');
  assert.equal(dueInfo('2026-10-31', TODAY).state, 'tomorrow');
  assert.equal(dueInfo('2026-11-05', TODAY).state, 'soon');
  assert.equal(dueInfo('2026-12-05', TODAY).state, 'later');
  assert.equal(dueInfo('', TODAY).state, 'none');
  assert.equal(dueLabel('2026-10-30', TODAY), 'Today');
  assert.equal(dueLabel('2026-10-31', TODAY), 'Tomorrow');
  assert.equal(dueLabel('2026-10-29', TODAY), 'Yesterday');
  assert.equal(dueLabel('2026-11-02', TODAY, 'en-US'), 'Mon');
  assert.equal(dueLabel('2026-12-25', TODAY, 'en-US'), 'Dec 25');
  assert.equal(dueLabel('2027-01-04', TODAY, 'en-US'), 'Jan 4, 2027');
});

test('addCard appends or prepends, ignores blank titles and unknown columns', () => {
  const board = sample();
  const added = addCard(board, 'a', { id: 'n', title: '  New  card ', priority: 'urgent', labels: ['blue', 'nope'] }, { now: NOW });
  assert.deepEqual(titles(added, 'a'), ['One', 'Two', 'Four', 'New card']);
  const card = findCard(added, 'n');
  assert.equal(card.priority, 'urgent');
  assert.deepEqual(card.labels, ['blue']);
  assert.equal(card.createdAt, NOW);
  assert.deepEqual(titles(addCard(board, 'a', { title: 'Top' }, { atStart: true }), 'a'), ['Top', 'One', 'Two', 'Four']);
  assert.deepEqual(titles(addCard(board, 'c', { title: 'Into done' }), 'c'), ['Five', 'Into done']);
  assert.equal(addCard(board, 'a', { title: '   ' }), board);
  assert.equal(addCard(board, 'zzz', { title: 'x' }), board);
  assert.notEqual(findCard(addCard(board, 'a', { id: '1', title: 'Clash' }), '1').title, 'Clash', 'existing ids are not reused');
});

test('updateCard patches known fields, keeps blank titles and reports no-ops', () => {
  const board = sample();
  const next = updateCard(board, '2', { title: 'Two!', description: 'Line one\r\nLine two', priority: 'low', due: '2026-11-11', itemId: 'item_1', labels: ['red', 'ghost'] }, { now: NOW });
  const card = findCard(next, '2');
  assert.equal(card.title, 'Two!');
  assert.equal(card.description, 'Line one\nLine two');
  assert.equal(card.priority, 'low');
  assert.equal(card.due, '2026-11-11');
  assert.equal(card.itemId, 'item_1');
  assert.deepEqual(card.labels, ['red']);
  assert.equal(card.updatedAt, NOW);
  assert.equal(findCard(updateCard(board, '2', { title: '  ' }), '2').title, 'Two');
  assert.equal(updateCard(board, '2', { title: 'Two' }), board, 'unchanged fields return the same board');
  assert.equal(updateCard(board, 'missing', { title: 'x' }), board);
  assert.equal(findCard(updateCard(board, '3', { due: '' }), '3').due, '');
  assert.equal(findCard(updateCard(board, '3', { priority: 'bogus' }), '3').priority, 'high');
});

test('deleteCard with insertCard restores the card at its old position', () => {
  const board = sample();
  const card = findCard(board, '2');
  const before = nextInColumn(board, '2');
  assert.equal(before, '4');
  const removed = deleteCard(board, '2');
  assert.deepEqual(titles(removed, 'a'), ['One', 'Four']);
  assert.deepEqual(titles(insertCard(removed, card, { beforeId: before }), 'a'), ['One', 'Two', 'Four']);
  assert.deepEqual(titles(insertCard(deleteCard(removed, '4'), card, { beforeId: before }), 'a'), ['One', 'Two'], 'falls back to the end');
  assert.equal(insertCard(board, card), board, 'a card that is still there is not duplicated');
  assert.equal(nextInColumn(board, '4'), null);
  assert.equal(deleteCard(board, 'missing'), board);
});

test('moveCard and moveCardToIndex reorder within and across columns', () => {
  const board = sample();
  assert.deepEqual(titles(moveCard(board, '4', 'a', '1'), 'a'), ['Four', 'One', 'Two']);
  assert.deepEqual(titles(moveCard(board, '1', 'a', null), 'a'), ['Two', 'Four', 'One']);
  const across = moveCard(board, '1', 'b', '3', { now: NOW });
  assert.deepEqual(titles(across, 'a'), ['Two', 'Four']);
  assert.deepEqual(titles(across, 'b'), ['One', 'Three']);
  assert.equal(findCard(across, '1').updatedAt, NOW);
  assert.deepEqual(titles(moveCard(board, '1', 'c', 'not-in-c'), 'c'), ['Five', 'One'], 'a before id from another column means the end');
  assert.equal(moveCard(board, '2', 'a', '4'), board, 'same position returns the same board');
  assert.equal(moveCard(board, '2', 'a', '2'), board);
  assert.equal(moveCard(board, '2', 'nope'), board);
  assert.deepEqual(titles(moveCardToIndex(board, '1', 'a', 2), 'a'), ['Two', 'Four', 'One']);
  assert.deepEqual(titles(moveCardToIndex(board, '4', 'a', 0), 'a'), ['Four', 'One', 'Two']);
  assert.deepEqual(titles(moveCardToIndex(board, '2', 'b', 99), 'b'), ['Three', 'Two']);
  assert.deepEqual(titles(moveCardToIndex(board, '2', 'b', -5), 'b'), ['Two', 'Three']);
});

test('stepCard reorders by one and respects the visible (filtered) cards', () => {
  const board = sample();
  assert.deepEqual(titles(stepCard(board, '2', -1), 'a'), ['Two', 'One', 'Four']);
  assert.deepEqual(titles(stepCard(board, '2', 1), 'a'), ['One', 'Four', 'Two']);
  assert.equal(stepCard(board, '1', -1), board, 'already first');
  assert.equal(stepCard(board, '4', 1), board, 'already last');
  // Only One and Four are visible: moving Four up jumps over the hidden Two.
  assert.deepEqual(titles(stepCard(board, '4', -1, ['1', '4']), 'a'), ['Four', 'One', 'Two']);
  // Moving One down past Four (visible) lands right after Four.
  assert.deepEqual(titles(stepCard(board, '1', 1, ['1', '4']), 'a'), ['Two', 'Four', 'One']);
});

test('shiftCard moves between neighbouring columns and keeps the row', () => {
  const board = sample();
  const right = shiftCard(board, '2', 1);
  assert.deepEqual(titles(right, 'a'), ['One', 'Four']);
  assert.deepEqual(titles(right, 'b'), ['Three', 'Two']);
  assert.deepEqual(titles(shiftCard(board, '1', 1), 'b'), ['One', 'Three']);
  assert.deepEqual(titles(shiftCard(board, '3', -1), 'a'), ['Three', 'One', 'Two', 'Four']);
  assert.equal(shiftCard(board, '1', -1), board, 'no column to the left');
  assert.equal(shiftCard(board, '5', 1), board, 'no column to the right');
});

test('duplicateCard copies below with fresh ids', () => {
  const board = sample();
  const next = duplicateCard(board, '4', { id: 'copy', now: NOW });
  assert.deepEqual(titles(next, 'a'), ['One', 'Two', 'Four', 'Four']);
  const copy = findCard(next, 'copy');
  assert.equal(copy.checklist.length, 2);
  assert.notEqual(copy.checklist[0].id, findCard(next, '4').checklist[0].id);
  assert.equal(duplicateCard(board, 'nope'), board);
});

test('checklist reducers', () => {
  const board = sample();
  const added = addChecklistItem(board, '4', '  Write   docs ', { id: 'z' });
  assert.deepEqual(findCard(added, '4').checklist.map(i => i.text), ['Write tests', 'Ship', 'Write docs']);
  assert.equal(addChecklistItem(board, '4', '   '), board);
  assert.deepEqual(checklistProgress(findCard(toggleChecklist(board, '4', 'y'), '4')), { done: 2, total: 2 });
  assert.deepEqual(checklistProgress(findCard(toggleChecklist(board, '4', 'x', false), '4')), { done: 0, total: 2 });
  assert.equal(toggleChecklist(board, '4', 'x', true), board, 'already done');
  assert.equal(findCard(updateChecklistItem(board, '4', 'y', 'Ship it'), '4').checklist[1].text, 'Ship it');
  assert.deepEqual(findCard(updateChecklistItem(board, '4', 'y', ''), '4').checklist.map(i => i.id), ['x'], 'blank text removes the item');
  assert.deepEqual(findCard(removeChecklistItem(board, '4', 'x'), '4').checklist.map(i => i.id), ['y']);
  assert.equal(removeChecklistItem(board, '4', 'nope'), board);
  assert.deepEqual(checklistProgress(findCard(board, '1')), { done: 0, total: 0 });
});

test('labels: create, find, rename, recolor, toggle and delete', () => {
  const board = sample();
  const created = createLabel(board, { id: 'g', name: 'Docs', color: 'green' });
  assert.deepEqual(created.labels.at(-1), { id: 'g', name: 'Docs', color: 'green' });
  assert.equal(createLabel(board, { name: 'bug' }), board, 'names are unique regardless of case');
  assert.equal(createLabel(board, { name: ' ' }), board);
  assert.equal(labelByName(board, ' BUG ')?.id, 'red');
  assert.equal(createLabel(board, { id: 'q', name: 'Odd', color: 'mauve' }).labels.at(-1).color, 'gray');
  assert.deepEqual(updateLabel(board, 'red', { name: 'Defect', color: 'orange' }).labels[0], { id: 'red', name: 'Defect', color: 'orange' });
  assert.equal(updateLabel(board, 'red', { name: '' }), board);
  assert.deepEqual(findCard(toggleLabel(board, '2', 'blue'), '2').labels, ['blue']);
  assert.deepEqual(findCard(toggleLabel(board, '1', 'red'), '1').labels, []);
  assert.equal(toggleLabel(board, '1', 'ghost'), board);
  const filtered = setFilter(board, { label: 'red' });
  const removed = deleteLabel(filtered, 'red');
  assert.deepEqual(removed.labels.map(l => l.id), ['blue']);
  assert.deepEqual(findCard(removed, '1').labels, []);
  assert.equal(removed.filter.label, '', 'a deleted label stops filtering');
});

test('columns: add, update, move, delete and restore', () => {
  const board = sample();
  const added = addColumn(board, { id: 'r', title: 'Review', color: 'violet', limit: '2' }, 2);
  assert.deepEqual(added.columns.map(c => c.id), ['a', 'b', 'r', 'c']);
  assert.equal(added.columns[2].limit, 2);
  assert.equal(addColumn(board, { title: ' ' }), board);
  assert.equal(renameColumn(board, 'a', 'Backlog').columns[0].title, 'Backlog');
  assert.equal(renameColumn(board, 'a', ''), board);
  assert.equal(setLimit(board, 'b', 0).columns[1].limit, 0);
  assert.equal(setLimit(board, 'b', 2), board);
  assert.equal(setColumnColor(board, 'a', 'teal').columns[0].color, 'teal');
  assert.equal(setColumnColor(board, 'a', 'neon').columns[0].color, '');
  assert.equal(updateColumn(board, 'a', { done: true }).columns[0].done, true);
  assert.deepEqual(moveColumn(board, 'a', 2).columns.map(c => c.id), ['b', 'c', 'a']);
  assert.deepEqual(moveColumn(board, 'c', -4).columns.map(c => c.id), ['c', 'a', 'b']);
  assert.equal(moveColumn(board, 'a', 0), board);
  assert.deepEqual(moveColumnBefore(board, 'c', 'a').columns.map(c => c.id), ['c', 'a', 'b']);
  assert.deepEqual(moveColumnBefore(board, 'a', null).columns.map(c => c.id), ['b', 'c', 'a']);
  const column = board.columns[0];
  const cards = columnCards(board, 'a');
  const deleted = deleteColumn(board, 'a');
  assert.deepEqual(deleted.columns.map(c => c.id), ['b', 'c']);
  assert.equal(columnCards(deleted, 'a').length, 0);
  assert.equal(deleted.cards.length, 2);
  const restored = restoreColumn(deleted, column, 0, cards);
  assert.deepEqual(restored.columns.map(c => c.id), ['a', 'b', 'c']);
  assert.deepEqual(titles(restored, 'a'), ['One', 'Two', 'Four']);
  const single = normalizeBoard({ columns: [{ id: 'only', title: 'Only' }] });
  assert.equal(deleteColumn(single, 'only'), single, 'the last column stays');
});

test('clearDone empties a column and restoreCards puts the cards back', () => {
  const board = sample();
  const cleared = clearDone(board, 'a');
  assert.equal(columnCards(cleared, 'a').length, 0);
  assert.equal(clearDone(cleared, 'a'), cleared);
  assert.deepEqual(titles(restoreCards(cleared, columnCards(board, 'a')), 'a'), ['One', 'Two', 'Four']);
});

test('filters match title, description, checklist and label names', () => {
  const board = sample();
  assert.equal(isFiltered(board.filter), false);
  const byLabel = setFilter(board, { label: 'red' });
  assert.equal(isFiltered(byLabel.filter), true);
  assert.deepEqual(filterCards(byLabel).map(c => c.id), ['1']);
  assert.deepEqual(filterCards(setFilter(board, { query: 'login' })).map(c => c.id), ['2']);
  assert.deepEqual(filterCards(setFilter(board, { query: 'ship' })).map(c => c.id), ['4']);
  assert.deepEqual(filterCards(setFilter(board, { query: 'feature three' })).map(c => c.id), ['3']);
  assert.deepEqual(filterCards(setFilter(board, { query: 'nothing here' })), []);
  assert.equal(setFilter(board, { label: 'ghost' }).filter.label, '');
  assert.equal(setFilter(board, { query: '' }), board);
  assert.equal(clearFilter(byLabel).filter.label, '');
});

test('summaries: wipState, columnStats, upNext and isDoneColumn', () => {
  const board = sample();
  assert.equal(wipState({ limit: 0 }, 9), 'none');
  assert.equal(wipState({ limit: 2 }, 1), 'under');
  assert.equal(wipState({ limit: 2 }, 2), 'at');
  assert.equal(wipState({ limit: 2 }, 3), 'over');
  assert.deepEqual(columnStats(board).map(s => [s.column.id, s.count, s.wip]), [['a', 3, 'none'], ['b', 1, 'under'], ['c', 1, 'none']]);
  assert.equal(isDoneColumn(board, 'c'), true);
  assert.equal(isDoneColumn(board, 'a'), false);
  const next = upNext(updateCard(board, '1', { priority: 'urgent' }));
  assert.deepEqual(next.map(c => c.id), ['3', '1'], 'dated first, then by priority; done columns are skipped');
  assert.deepEqual(upNext(board, { limit: 0 }), []);
});

test('cardToMarkdown writes description, tasks and facts', () => {
  const board = sample();
  const md = cardToMarkdown(findCard(updateCard(board, '4', { description: 'Plan', labels: ['red'], priority: 'high', due: '2026-11-03' }), '4'),
    updateCard(board, '4', { labels: ['red'] }));
  assert.equal(md, 'Plan\n\n- [x] Write tests\n- [ ] Ship\n\nLabels: Bug · Priority: High · Due: 2026-11-03 · Column: To do');
  assert.equal(cardToMarkdown(findCard(board, '1'), board), 'Labels: Bug · Column: To do');
});

test('toConfig keeps only the stored keys', () => {
  const config = toConfig(sample());
  assert.deepEqual(Object.keys(config).sort(), ['cards', 'columns', 'filter', 'labels', 'layout', 'showDescriptions']);
  assert.deepEqual(normalizeBoard(config, { now: NOW }), normalizeBoard(sample(), { now: NOW }));
});

test('layoutFor: automatic shows the board from 5 × 4 cells, explicit layouts win', () => {
  const board = sample();
  assert.equal(layoutFor(board, { w: 6, h: 4 }), 'board');
  assert.equal(layoutFor(board, { w: 5, h: 4 }), 'board');
  assert.equal(layoutFor(board, { w: 12, h: 3 }), 'summary');
  assert.equal(layoutFor(board, { w: 4, h: 8 }), 'summary');
  assert.equal(layoutFor({ ...board, layout: 'board' }, { w: 2, h: 2 }), 'board');
  assert.equal(layoutFor({ ...board, layout: 'summary' }, { w: 12, h: 8 }), 'summary');
  assert.equal(layoutFor({ ...board, layout: 'weird' }, { w: 3, h: 3 }), 'summary');
});

test('settingsErrors flags unnamed columns, bad limits and duplicate or empty labels', () => {
  assert.equal(settingsErrors({ columns: [{ id: 'a', title: 'To do', limit: null }, { id: 'b', title: 'Doing', limit: 3 }], labels: [{ id: 'x', name: 'Bug' }] }), null);
  assert.deepEqual(settingsErrors({ columns: [], labels: [] }), { columns: 'Add at least one column.' });
  const errors = settingsErrors({
    columns: [{ id: 'a', title: '  ' }, { id: 'b', title: 'Doing', limit: 2.5 }, { id: 'c', title: 'Done', limit: -1 }, { id: 'd', title: 'Later', limit: 1000 }, { id: 'e', title: 'Ok', limit: '' }],
    labels: [{ id: 'x', name: 'Bug' }, { id: 'y', name: ' bug ' }, { id: 'z', name: '' }],
  });
  assert.deepEqual(Object.keys(errors).sort(), ['columns.0.title', 'columns.1.limit', 'columns.2.limit', 'columns.3.limit', 'labels.1.name', 'labels.2.name']);
  assert.match(errors['labels.1.name'], /already has this name/);
});

test('applySettings keeps cards, moves cards out of removed columns and drops removed labels', () => {
  const board = sample();
  const next = applySettings(board, {
    layout: 'summary',
    showDescriptions: true,
    columns: [{ id: 'b', title: 'Doing now', color: 'violet', limit: null, done: false }, { id: 'new', title: 'Review', color: 'nope', limit: 4 }, { id: 'c', title: 'Done', done: true }],
    labels: [{ id: 'blue', name: 'Feature', color: 'teal' }],
  });
  assert.equal(next.layout, 'summary');
  assert.equal(next.showDescriptions, true);
  assert.deepEqual(next.columns.map(c => [c.id, c.title, c.color, c.limit, c.done]),
    [['b', 'Doing now', 'violet', 0, false], ['new', 'Review', '', 4, false], ['c', 'Done', '', 0, true]]);
  assert.equal(next.cards.length, board.cards.length);
  assert.deepEqual(columnCards(next, 'b').map(c => c.id), ['1', '2', '3', '4']); // column a's cards move to the first column
  assert.deepEqual(findCard(next, '1').labels, []);
  assert.deepEqual(findCard(next, '3').labels, ['blue']);
  assert.deepEqual(next.labels, [{ id: 'blue', name: 'Feature', color: 'teal' }]);
  // Nothing in the draft: the board stays as it was.
  assert.deepEqual(applySettings(board, {}), board);
});

test('settingsNotes says what saving does to cards in removed columns and with removed labels', () => {
  const board = sample();
  assert.deepEqual(settingsNotes(board, { columns: board.columns, labels: board.labels }), { columns: '', labels: '' });
  assert.deepEqual(settingsNotes(board, { columns: [{ id: 'b', title: 'Doing' }, { id: 'c', title: 'Done' }], labels: [{ id: 'blue' }] }), {
    columns: '3 cards from removed columns will move to “Doing”.',
    labels: 'Removed labels will come off 1 card.',
  });
  assert.equal(settingsNotes(board, { columns: [{ id: 'x', title: '' }], labels: board.labels }).columns, '5 cards from removed columns will move to “the first column”.');
});
