import test from 'node:test';
import assert from 'node:assert/strict';
import { previewSource } from '../extension/ui/notes.js';

test('note previews drop a leading heading that repeats the title', () => {
  assert.equal(previewSource('# Weekly review\n\nWins and misses', 'Weekly review'), 'Wins and misses');
  assert.equal(previewSource('## Weekly review ##\nBody', 'weekly REVIEW'), 'Body');
  assert.equal(previewSource('# Another heading\nBody', 'Weekly review'), '# Another heading\nBody');
});

test('note previews drop the plain first line a sticky note takes its title from', () => {
  assert.equal(previewSource('Renew passport', 'Renew passport'), '', 'a one-line sticky note has no body to repeat');
  assert.equal(previewSource('Renew passport\nBring two photos', 'Renew passport'), 'Bring two photos');
  assert.equal(previewSource('\n  Renew passport  \r\n\r\nBring two photos', 'Renew passport'), 'Bring two photos');
  assert.equal(previewSource('**Groceries** for Sunday\n- milk', 'Groceries for Sunday'), '- milk', 'inline formatting is compared as text');
  assert.equal(previewSource('Groceries…\n- milk', 'Groceries…'), '- milk');
});

test('note previews keep first lines that carry more than the title', () => {
  for (const content of ['- [ ] Renew passport', '* Renew passport', '1. Renew passport', '> Renew passport', '::::toggle [open] Renew passport\nInside\n::::'])
    assert.equal(previewSource(content, 'Renew passport'), content, content);
  assert.equal(previewSource('Other first line\nRenew passport', 'Renew passport'), 'Other first line\nRenew passport');
  assert.equal(previewSource('Some text', ''), 'Some text', 'an untitled note keeps its first line');
  const long = `${'word '.repeat(30).trim()}\nnext`;
  assert.equal(previewSource(long, `${long.slice(0, 79)}…`), long, 'a line longer than a whole title is kept');
});
