import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryStore, stripNoteTitleHeading } from '../extension/lib/store.js';

const stamp = '2026-10-01T10:00:00.000Z';
const note = (id, title, content) => ({ id, type: 'note', title, content, url: '', excerpt: '', tags: [], collectionId: '', highlights: [], relatedIds: [], createdAt: stamp, updatedAt: stamp });

function fixture(value) {
  let writes = 0;
  const store = createLibraryStore({ read: async () => (value ? structuredClone(value) : null), write: async state => { writes++; value = structuredClone(state); } });
  return { call: (name, ...args) => store.dispatch(name, args), writes: () => writes, stored: () => value };
}

test('a level-1 heading that repeats the title is stripped with the blank line after it; anything else stays', () => {
  assert.equal(stripNoteTitleHeading('# Trip plan\n\n- [ ] Book flights', 'Trip plan'), '- [ ] Book flights');
  assert.equal(stripNoteTitleHeading('# Trip plan\n- [ ] Book flights', 'Trip plan'), '- [ ] Book flights', 'no blank line to remove');
  assert.equal(stripNoteTitleHeading('# Trip plan\r\n\r\nBody', ' Trip plan '), 'Body', 'CRLF, title trimmed');
  assert.equal(stripNoteTitleHeading('# Trip plan  \n\n\nBody', 'Trip plan'), '\nBody', 'only one blank line goes');
  assert.equal(stripNoteTitleHeading('# Trip plan', 'Trip plan'), '');
  assert.equal(stripNoteTitleHeading('# Trip plans\n\nBody', 'Trip plan'), '# Trip plans\n\nBody', 'different text');
  assert.equal(stripNoteTitleHeading('# trip plan\n\nBody', 'Trip plan'), '# trip plan\n\nBody', 'exact match only');
  assert.equal(stripNoteTitleHeading('## Trip plan\n\nBody', 'Trip plan'), '## Trip plan\n\nBody', 'level-2 heading');
  assert.equal(stripNoteTitleHeading('#\n\nBody', ''), '#\n\nBody');
  assert.equal(stripNoteTitleHeading('# \n\nBody', '  '), '# \n\nBody', 'empty title');
  assert.equal(stripNoteTitleHeading('Intro\n# Trip plan\n\nBody', 'Trip plan'), 'Intro\n# Trip plan\n\nBody', 'the heading must come first');
});

test('loading an existing library migrates note bodies once, keeps everything else and never runs again', async () => {
  const library = {
    schemaVersion: 1, updatedAt: stamp, settings: {}, collections: [],
    items: [
      note('same', 'Trip plan', '# Trip plan\n\n- [ ] Book flights'),
      note('other', 'Trip plan', '# Packing\n\nShoes'),
      note('h2', 'Trip plan', '## Trip plan\n\nBody'),
      note('blank', '', '# \n\nBody'),
      { ...note('link', 'Trip plan', '# Trip plan\n\nNot a note'), type: 'bookmark', url: 'https://example.com/' },
    ],
  };
  const { call, writes, stored } = fixture(library);
  const loaded = await call('loadLibrary');
  const content = id => loaded.items.find(item => item.id === id).content;
  assert.equal(content('same'), '- [ ] Book flights');
  assert.equal(content('other'), '# Packing\n\nShoes');
  assert.equal(content('h2'), '## Trip plan\n\nBody');
  assert.equal(content('blank'), '# \n\nBody');
  assert.equal(content('link'), '# Trip plan\n\nNot a note', 'only notes change');
  assert.equal(loaded.items.find(item => item.id === 'same').updatedAt, stamp, 'item stamps are kept');
  assert.deepEqual(loaded.migrations, ['note-title-heading']);
  assert.equal(writes(), 1);

  // Idempotent: a second load writes nothing, and a title heading written after the migration stays.
  await call('loadLibrary');
  assert.equal(writes(), 1);
  await call('updateItem', 'same', { content: '# Trip plan\n\nAgain' });
  assert.equal((await call('loadLibrary')).items.find(item => item.id === 'same').content, '# Trip plan\n\nAgain');
  assert.deepEqual(stored().migrations, ['note-title-heading']);
});

test('a library created now is current: its notes are kept as given and the migration is marked done', async () => {
  const { call, writes } = fixture(null);
  const seed = { schemaVersion: 1, items: [note('plan', 'Trip plan', '# Trip plan\n- [ ] Book flights')], collections: [], settings: {} };
  const loaded = await call('loadLibrary', seed);
  assert.equal(loaded.items[0].content, '# Trip plan\n- [ ] Book flights');
  assert.deepEqual(loaded.migrations, ['note-title-heading']);
  assert.equal(writes(), 1);
  await call('loadLibrary');
  assert.equal(writes(), 1);
});
