import test from 'node:test';
import assert from 'node:assert/strict';
import { combineImports, importTitle, fileStatus, saveFileItem } from '../extension/ui/note-import.js';
import { parseNoteBlocks } from '../extension/lib/markdown.js';

test('several imports follow one another under file headings unless they open with their own title', () => {
  assert.equal(combineImports([{ name: 'a.md', markdown: 'Just text\n' }]), 'Just text');
  assert.equal(combineImports([{ name: 'a.md', markdown: '' }, { name: 'b.md', markdown: 'Only b' }]), 'Only b', 'an empty result adds no heading');
  const combined = combineImports([
    { name: 'Q3_notes.md', markdown: 'Plain start' },
    { name: 'report.pdf', markdown: '# Annual report\nBody' },
    { name: 'deck.pptx', markdown: 'Slides', heading: 'Roadmap *2026*' },
  ]);
  assert.equal(combined, '## Q3 notes\nPlain start\n# Annual report\nBody\n## Roadmap \\*2026\\*\nSlides');
  assert.deepEqual(parseNoteBlocks(combined).map(b => b.type), ['h2', 'paragraph', 'h1', 'paragraph', 'h2', 'paragraph']);
});

test('a single import into an untitled note suggests the document’s title', () => {
  assert.equal(importTitle({ markdown: '# Plan for Q4\nBody', title: 'Meta title', name: 'x.docx' }), 'Plan for Q4');
  assert.equal(importTitle({ markdown: 'Body', title: 'Meta title', name: 'x.docx' }), 'Meta title');
  assert.equal(importTitle({ markdown: 'Body', name: 'board_review.pdf' }), 'board review');
});

test('file rows say what is happening in plain words', () => {
  const target = { modelLabel: 'Claude Haiku 5.5' };
  assert.equal(fileStatus({ status: 'ready', label: 'PDF', size: 2048 }, target), 'PDF · 2.0 KB');
  assert.equal(fileStatus({ status: 'ready', label: 'Image', size: 10, needsAi: true }, target), 'Image · 10 B · read by AI');
  assert.equal(fileStatus({ status: 'reading' }, target), 'Converting…');
  assert.equal(fileStatus({ status: 'ai', progress: { phase: 'tidy', done: 1, total: 4 } }, target), 'Tidying with Claude Haiku 5.5 · part 2 of 4…');
  assert.equal(fileStatus({ status: 'ai', progress: { phase: 'tidy', done: 0, total: 1 } }, target), 'Tidying with Claude Haiku 5.5…');
  assert.equal(fileStatus({ status: 'ai', progress: { phase: 'read', chars: 1200 } }, target), 'Reading with Claude Haiku 5.5 · 1,200 characters…');
  assert.equal(fileStatus({ status: 'done', words: 1, warnings: [] }), '1 word ready');
  assert.equal(fileStatus({ status: 'done', words: 30, warnings: ['Only the first part was imported.'] }), 'Only the first part was imported. · 30 words ready');
  assert.equal(fileStatus({ status: 'error', message: 'Nope.' }), 'Nope.');
});

test('embedded uploads are saved as library items in the note’s collection, and the bytes are removed if the item fails', async () => {
  const calls = [];
  const ctx = {
    select: { collection: id => (id === 'design' ? { id } : null) },
    store: {
      saveAttachment: async file => { calls.push(['attach', file.name]); return { attachmentId: 'file_1', fileName: file.name, mime: file.type, size: file.size }; },
      saveItem: async input => { calls.push(['item', input.type, input.collectionId]); if (input.title === 'broken.pdf') throw new Error('Quota'); return { id: 'item_1', ...input }; },
      deleteAttachment: async id => { calls.push(['delete', id]); },
    },
  };
  const pdf = new File(['%PDF-1.4'], 'paper.pdf', { type: 'application/pdf' });
  assert.equal((await saveFileItem(ctx, pdf, 'design')).id, 'item_1');
  assert.equal((await saveFileItem(ctx, new File(['x'], 'clip.mp4', { type: 'video/mp4' }), 'gone')).collectionId, '', 'a missing collection falls back to the Inbox');
  await assert.rejects(saveFileItem(ctx, new File(['%PDF'], 'broken.pdf', { type: 'application/pdf' })), /Quota/);
  assert.deepEqual(calls, [['attach', 'paper.pdf'], ['item', 'file', 'design'], ['attach', 'clip.mp4'], ['item', 'video', ''], ['attach', 'broken.pdf'], ['item', 'file', ''], ['delete', 'file_1']]);
});
