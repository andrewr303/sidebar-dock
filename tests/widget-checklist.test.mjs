import test from 'node:test';
import assert from 'node:assert/strict';
import { taskBlocks, appendTask, editTask, removeTask, removeTasks, setAllTasks, taskText } from '../extension/ui/widgets/notes-kit/model.js';
import { extractTasks, toggleTask } from '../extension/lib/notes.js';
import { renderMarkdown } from '../extension/lib/markdown.js';

const MIXED = [
  '# Launch',
  '',
  'Intro paragraph.',
  '',
  '```md',
  '- [ ] literal code',
  '```',
  '- [x] Done item',
  '- [ ] Open item \\',
  'continued line',
  '  - [ ] Nested child',
  '    - note under child',
  '',
  '## Later',
  '',
  'Closing words.',
].join('\n');

test('taskBlocks agrees with extractTasks and the rendered data-task-index', () => {
  const blocks = taskBlocks(MIXED);
  const tasks = extractTasks(MIXED);
  assert.deepEqual(blocks.map(b => b.index), tasks.map(t => t.index));
  assert.deepEqual(blocks.map(b => [b.start, b.end, b.indent, b.done]), [[7, 7, 0, true], [8, 9, 0, false], [10, 10, 1, false]]);
  assert.equal(blocks[2].subtreeEnd, 11, 'nested bullets belong to the task above them');
  const rendered = [...renderMarkdown(MIXED, { interactiveTasks: true }).matchAll(/data-task-index="(\d+)"/g)].map(m => Number(m[1]));
  assert.deepEqual(rendered, blocks.map(b => b.index));
  assert.equal(blocks[0].index, 1, 'the code-fence line keeps index 0');
});

test('taskBlocks finds tasks inside toggles at their absolute lines', () => {
  const md = 'Top\n:::toggle [open] More\n- [ ] Inside\n:::\n- [ ] After';
  const blocks = taskBlocks(md);
  assert.deepEqual(blocks.map(b => [b.index, b.start, b.plain]), [[0, 2, 'Inside'], [1, 4, 'After']]);
  assert.equal(editTask(md, 0, 'Changed'), 'Top\n:::toggle [open] More\n- [ ] Changed\n:::\n- [ ] After');
});

test('appendTask joins the last checklist, after nested items, keeping its marker and indentation', () => {
  assert.equal(appendTask(MIXED, 'New one').split('\n').slice(10, 14).join('\n'), '  - [ ] Nested child\n    - note under child\n- [ ] New one\n');
  assert.equal(appendTask('  * [ ] Star\n  * [x] Two\n\nText', 'Three'), '  * [ ] Star\n  * [x] Two\n  * [ ] Three\n\nText');
  assert.equal(appendTask('- [ ] A\n\n:::toggle [open] T\n- [ ] Inner\n:::', 'B'), '- [ ] A\n\n:::toggle [open] T\n- [ ] Inner\n- [ ] B\n:::');
});

test('appendTask without tasks adds a separated list at the end and keeps line endings', () => {
  assert.equal(appendTask('', 'First'), '- [ ] First');
  assert.equal(appendTask('   \n', 'First'), '- [ ] First');
  assert.equal(appendTask('Hello', 'x'), 'Hello\n\n- [ ] x');
  assert.equal(appendTask('Hello\n\n\n', 'x'), 'Hello\n\n- [ ] x\n');
  assert.equal(appendTask('- a bullet\n', 'x'), '- a bullet\n- [ ] x\n');
  assert.equal(appendTask('Hello\r\nWorld\r\n', 'x'), 'Hello\r\nWorld\r\n\r\n- [ ] x\r\n');
  assert.equal(appendTask('- [ ] A\r\n- [ ] B\r\n', 'C'), '- [ ] A\r\n- [ ] B\r\n- [ ] C\r\n');
  assert.equal(appendTask('```\n- [ ] code only\n```', 'Real'), '```\n- [ ] code only\n```\n\n- [ ] Real', 'code-fence lines are not tasks');
});

test('appendTask can fill a trailing empty task instead of adding another', () => {
  assert.equal(appendTask('- [ ] ', 'Milk', { fillEmpty: true }), '- [ ] Milk');
  assert.equal(appendTask('- [ ]', 'Milk', { fillEmpty: true }), '- [ ] Milk');
  assert.equal(appendTask('- [x] ', 'Milk', { fillEmpty: true }), '- [x] \n- [ ] Milk', 'a checked empty task is kept');
  assert.equal(appendTask('- [ ] ', 'Milk'), '- [ ] \n- [ ] Milk');
});

test('editTask rewrites only the item text, its state and indentation stay', () => {
  assert.equal(editTask('Intro\n  * [X] Old **bold**\nEnd', 0, 'New *text*'), 'Intro\n  * [X] New *text*\nEnd');
  const edited = editTask(MIXED, 2, 'Single line');
  assert.match(edited, /\n- \[ \] Single line\n  - \[ \] Nested child/);
  assert.ok(!edited.includes('continued line'), 'continuation lines are replaced');
  assert.equal(editTask(MIXED, 0, 'x'), MIXED, 'an index that names a code line changes nothing');
  assert.equal(editTask(MIXED, 9, 'x'), MIXED);
  assert.equal(editTask('- [ ] a\r\n- [ ] b', 0, 'A'), '- [ ] A\r\n- [ ] b');
  assert.equal(editTask('- [ ] a', 0, 'line\nbreak  and   spaces'), '- [ ] line break and spaces');
  assert.equal(editTask('- [ ] a\nNext', 0, 'ends with \\'), '- [ ] ends with \\\\\nNext', 'a trailing backslash cannot start a hard break');
});

test('taskText collapses whitespace and neutralizes trailing backslashes', () => {
  assert.equal(taskText('  a \n b\t c  '), 'a b c');
  assert.equal(taskText('x\\\\'), 'x\\\\');
  assert.equal(taskText('x\\'), 'x\\\\');
});

test('removeTask and removeTasks drop whole items and leave other bytes', () => {
  const once = removeTask(MIXED, 2);
  assert.ok(!once.includes('Open item') && !once.includes('continued line'));
  assert.match(once, /- \[x\] Done item\n  - \[ \] Nested child/);
  assert.equal(removeTask(MIXED, 0), MIXED, 'code-fence lines are never removed');
  const both = removeTasks(MIXED, [1, 3]);
  assert.deepEqual(extractTasks(both).map(t => t.plain), ['Open item \ncontinued line']);
  assert.equal(removeTasks('- [ ] a\r\n- [x] b\r\n- [ ] c', [1]), '- [ ] a\r\n- [ ] c');
  assert.equal(removeTasks('x', []), 'x');
});

test('setAllTasks checks or clears every real task and keeps code untouched', () => {
  const cleared = setAllTasks(MIXED, false);
  assert.deepEqual(extractTasks(cleared).map(t => t.done), [false, false, false]);
  assert.ok(cleared.includes('```md\n- [ ] literal code\n```'));
  const checked = setAllTasks('* [ ] a\n  - [X] b\n- [ ]', true);
  assert.equal(checked, '* [x] a\n  - [X] b\n- [x]');
  assert.equal(setAllTasks('no tasks', true), 'no tasks');
});

test('indices stay valid across toggle, edit and append round trips', () => {
  let md = MIXED;
  md = toggleTask(md, 2, true);
  md = editTask(md, 2, 'Renamed');
  md = appendTask(md, 'Added');
  const tasks = extractTasks(md);
  assert.deepEqual(tasks.map(t => [t.index, t.plain, t.done]), [[1, 'Done item', true], [2, 'Renamed', true], [3, 'Nested child', false], [4, 'Added', false]]);
});

test('setup states fit two rows: title and main action only, the rest returns from three rows', async () => {
  await import('../extension/ui/widgets/checklist.js');
  const { getWidget, widgetEnv } = await import('../extension/ui/dashboard/registry.js');
  const def = getWidget('checklist');
  const ctx = { library: { items: [], collections: [] }, select: { byId: () => null, collection: () => null, live: () => [], descendants: () => [] } };
  const draw = (config, w, h) => {
    const widget = { id: 'wcl', type: 'checklist', x: 0, y: 0, w, h, config };
    return String(def.render(ctx, widget, widgetEnv({ widget })));
  };
  for (const config of [{ source: 'note', noteId: '' }, { source: 'note', noteId: 'gone' }]) {
    const short = draw(config, 2, 2);
    assert.match(short, /class="w-checklist is-setup is-short"/);
    assert.match(short, /Create checklist/);
    assert.doesNotMatch(short, /empty-state-body|Choose a note/);
    const tall = draw(config, 2, 3);
    assert.doesNotMatch(tall, /is-short/);
    assert.match(tall, /empty-state-body/);
    assert.match(tall, /Choose a note/);
  }
  for (const config of [{ source: 'collection', collectionId: 'gone' }, { source: 'all' }]) {
    const short = draw(config, 4, 2);
    assert.match(short, /is-short/);
    assert.doesNotMatch(short, /empty-state-body/);
    assert.match(short, /data-action="w\.checklist\.(pick-collection|create)"/);
    assert.match(draw(config, 4, 3), /empty-state-body/);
  }
});
