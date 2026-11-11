// Rich-text and code editors: how the layer names them, how a multi-line value is typed into them, and how a value read
// back from them is compared. The probe finds the editor family from the page's markup (`editorFacts`); everything
// here is a fixed rule over that family, so the mechanism is known before anything is sent.
import type { EditorFamily } from '../../probe';
import { quote } from '../text';

export type { EditorFacts, EditorFamily } from '../../probe';

/** The editor family's name as the receipt prints it. */
export const EDITOR_LABEL: Record<EditorFamily, string> = {
  lexical: 'Lexical',
  prosemirror: 'ProseMirror',
  slate: 'Slate',
  quill: 'Quill',
  codemirror: 'CodeMirror',
  monaco: 'Monaco',
  contenteditable: 'contenteditable',
};

export type LineBreakKey = 'Shift+Enter' | 'Enter';

/**
 * The key that ends a line inside an editor, chosen from the family alone. Rich-text editors (ProseMirror, Slate,
 * Quill, Lexical and a bare contenteditable) take Enter as a new paragraph or block, which changes the document's
 * structure: Shift+Enter is their soft line break. Code editors and textareas take Enter as a newline.
 */
export function lineBreakFor(family: EditorFamily | null): LineBreakKey {
  return family === 'codemirror' || family === 'monaco' || family === null ? 'Enter' : 'Shift+Enter';
}

/** Whether a multi-line value is typed line by line with a line-break key (editors), not inserted as text in one go. */
export function typedByLines(family: EditorFamily | null): boolean {
  return family !== null;
}

/** The lines of a value, split on any newline form. A trailing newline gives a last empty line, as typed. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

// Non-breaking space, zero-width characters and the byte order mark: editors add them for layout.
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff]/g;

/** NBSP read as a space, CRLF as LF, invisible characters dropped, space before a newline and trailing newlines trimmed. */
function lenient(text: string): string {
  return text
    .replace(INVISIBLE, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n+$/g, '');
}

/** Every run of whitespace is one space, and the ends are trimmed. */
function collapsed(text: string): string {
  return lenient(text).replace(/\s+/g, ' ').trim();
}

export interface EditorComparison {
  status: 'met' | 'unmet' | 'not_checked';
  /** Met only after normalisation: the text differs from what was asked in whitespace, NBSP or trailing newlines. */
  approximate: boolean;
  detail: string;
}

/**
 * The read-back of a value in an editor. An editor normalises what it holds (a trailing newline, NBSP for a space,
 * paragraph breaks), so equal after that normalisation is met, and the receipt says it was approximate. `partial` is
 * for an editor that renders only the lines in view (Monaco): what was read can be a part of the document, so a
 * difference there is not_checked, never unmet.
 */
export function compareEditorText(wanted: string, got: string | null, partial = false): EditorComparison {
  if (got === null)
    return { status: 'not_checked', approximate: false, detail: 'the editor text could not be read back' };
  if (got === wanted) return { status: 'met', approximate: false, detail: `read back ${quote(got)}` };
  if (lenient(got) === lenient(wanted)) {
    return {
      status: 'met',
      approximate: true,
      detail: `read back ${quote(got)}; approximate: the editor changed whitespace, NBSP or the trailing newline`,
    };
  }
  if (collapsed(got) === collapsed(wanted)) {
    return {
      status: 'met',
      approximate: true,
      detail: `read back ${quote(got)}; approximate: equal only when runs of whitespace are collapsed`,
    };
  }
  if (partial) {
    const found = collapsed(got).includes(collapsed(wanted));
    return found
      ? {
          status: 'met',
          approximate: true,
          detail:
            'the requested text is among the lines the editor renders; approximate: the rest of the document was not read',
        }
      : {
          status: 'not_checked',
          approximate: true,
          detail: `this editor renders only the lines in view, so the value could not be confirmed (read ${quote(got)})`,
        };
  }
  return { status: 'unmet', approximate: false, detail: `read back ${quote(got)}, requested ${quote(wanted)}` };
}
