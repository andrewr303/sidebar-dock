import { describe, expect, it } from 'vitest';
import { compareEditorText, EDITOR_LABEL, lineBreakFor, splitLines, typedByLines } from '../interaction/editors';

describe('line breaks by editor family', () => {
  it('uses Shift+Enter for rich-text editors and a bare contenteditable, Enter for code editors and textareas', () => {
    for (const family of ['prosemirror', 'slate', 'quill', 'lexical', 'contenteditable'] as const) {
      expect(lineBreakFor(family)).toBe('Shift+Enter');
    }
    expect(lineBreakFor('codemirror')).toBe('Enter');
    expect(lineBreakFor('monaco')).toBe('Enter');
    expect(lineBreakFor(null)).toBe('Enter');
  });

  it('types line by line only inside a recognised editor', () => {
    expect(typedByLines('prosemirror')).toBe(true);
    expect(typedByLines('monaco')).toBe(true);
    expect(typedByLines(null)).toBe(false);
  });

  it('names every family', () => {
    expect(EDITOR_LABEL.prosemirror).toBe('ProseMirror');
    expect(EDITOR_LABEL.monaco).toBe('Monaco');
  });

  it('splits on every newline form and keeps a trailing empty line', () => {
    expect(splitLines('a\nb\r\nc\rd')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitLines('a\n')).toEqual(['a', '']);
    expect(splitLines('one')).toEqual(['one']);
  });
});

describe('editor read-back', () => {
  it('is met and exact when the text is equal', () => {
    expect(compareEditorText('Hello', 'Hello')).toMatchObject({ status: 'met', approximate: false });
  });

  it('tolerates a trailing newline, NBSP and zero-width characters, and says it is approximate', () => {
    const trailing = compareEditorText('one\ntwo', 'one\ntwo\n');
    expect(trailing).toMatchObject({ status: 'met', approximate: true });
    expect(trailing.detail).toContain('approximate');
    expect(compareEditorText('a b', 'a b')).toMatchObject({ status: 'met', approximate: true });
    expect(compareEditorText('ab', 'a​b')).toMatchObject({ status: 'met', approximate: true });
    expect(compareEditorText('a\nb', 'a  \r\nb\r\n')).toMatchObject({ status: 'met', approximate: true });
  });

  it('accepts a paragraph break read as spaces, approximately', () => {
    expect(compareEditorText('one two', 'one\n\ntwo')).toMatchObject({ status: 'met', approximate: true });
  });

  it('is unmet when the text really differs', () => {
    const r = compareEditorText('Hello', 'Help');
    expect(r.status).toBe('unmet');
    expect(r.detail).toContain('requested');
  });

  it('is not_checked when nothing could be read', () => {
    expect(compareEditorText('x', null).status).toBe('not_checked');
  });

  it('never calls a difference unmet for an editor that renders only some lines', () => {
    expect(compareEditorText('line 1\nline 2', 'line 1\nline 2\nline 3', true)).toMatchObject({
      status: 'met',
      approximate: true,
    });
    const hidden = compareEditorText('line 1\nline 900', 'line 1\nline 2', true);
    expect(hidden.status).toBe('not_checked');
    expect(hidden.detail).toContain('only the lines in view');
  });
});
