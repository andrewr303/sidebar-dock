// Passages: the parts of a long text that matter for a question. The assistant's context and get_items used to cut a
// long article or note at its start, so anything past the first few thousand characters never reached the model,
// however well it matched. Here a text that does not fit is given as its opening plus the windows that match the
// question best, each with its character offset, so the model can also ask to read on from there.
//
// Scoring is lexical (the question's words, by how many of them a window holds and how often), so it works without
// the semantic index. Chunks the index found are passed in and kept as passages too (they may match by meaning alone).
// Pure: no storage, no network.
import { isStopWord, tokenize } from './search.js';

const SENTENCE_END = /[.!?。！？](?=["'”’)\]]*\s)|\n/g;
export const PASSAGE_SIZE = 1200;
/** The share of a text's room given to its opening when passages follow. */
const HEAD_SHARE = 0.35;
/** The most windows scored in one text (about half a megabyte at the default size). */
const MAX_WINDOWS = 400;

const text = value => (typeof value === 'string' ? value : '');

// Where a window may end: a paragraph break, else a sentence end, else a space, in the second half of the window.
function cutPoint(value, start, limit, size) {
  const floor = start + Math.floor(size * 0.5);
  const paragraph = value.lastIndexOf('\n\n', limit - 1);
  if (paragraph >= floor) return paragraph + 2;
  SENTENCE_END.lastIndex = floor;
  let sentence = -1;
  for (let match; (match = SENTENCE_END.exec(value)) && match.index < limit - 1;) sentence = match.index + 1;
  if (sentence > floor) return sentence;
  const space = value.lastIndexOf(' ', limit - 1);
  return space > floor ? space + 1 : limit;
}

/** The text as consecutive windows of about `size` characters: [{ start, end }]. Offsets are into the text as given. */
export function passageWindows(value, { size = PASSAGE_SIZE, from = 0, max = MAX_WINDOWS } = {}) {
  const source = text(value);
  const windows = [];
  for (let start = Math.max(0, from); start < source.length && windows.length < max;) {
    const limit = Math.min(source.length, start + size);
    const end = limit < source.length ? cutPoint(source, start, limit, size) : limit;
    if (source.slice(start, end).trim()) windows.push({ start, end });
    start = Math.max(end, start + 1);
  }
  return windows;
}

/** The words of a question that can tell one passage from another: its tokens without stop words (all of them when every token is one). */
export function questionTerms(question) {
  const all = [...new Set(tokenize(text(question)))].filter(token => token.length > 1 || /[^\x00-\x7f]/.test(token));
  const meaningful = all.filter(token => !isStopWord(token));
  return (meaningful.length ? meaningful : all).slice(0, 40);
}

/**
 * Windows of `value` that hold words of the question, best first: [{ start, end, score, matched }]. A window that
 * holds more of the distinct words always outranks one that repeats fewer of them.
 */
export function rankPassages(value, question, { size = PASSAGE_SIZE, from = 0 } = {}) {
  const terms = questionTerms(question);
  if (!terms.length) return [];
  const source = text(value);
  const wanted = new Set(terms);
  const ranked = [];
  for (const window of passageWindows(source, { size, from })) {
    const counts = new Map();
    for (const token of tokenize(source.slice(window.start, window.end))) if (wanted.has(token)) counts.set(token, (counts.get(token) || 0) + 1);
    if (!counts.size) continue;
    let repeats = 0;
    for (const count of counts.values()) repeats += Math.min(count, 5);
    ranked.push({ ...window, matched: counts.size, score: counts.size * 100 + repeats });
  }
  return ranked.sort((a, b) => b.score - a.score || a.start - b.start);
}

const wordCut = (value, max) => {
  if (value.length <= max) return value;
  const space = value.lastIndexOf(' ', max);
  return value.slice(0, space > max * 0.6 ? space : max);
};

/**
 * Fits a text into `budget` characters for a question.
 *   -> { text, truncated: false }                              the whole text, when it fits
 *   -> { text: opening, passages: [{ at, text }], truncated: true, length }   its opening and the matching windows
 *   -> { text: opening, truncated: true, length }              only the opening, when nothing in it matches
 * passages are in reading order; `at` is the character offset of each in the text. chunks: texts the semantic index
 * found for this item ([string]); those not already covered are added as passages without an offset.
 */
export function fitText(value, question, { budget = 8000, size = PASSAGE_SIZE, chunks = [] } = {}) {
  const source = text(value);
  const room = Math.max(0, Math.floor(budget));
  if (source.length <= room) return { text: source, truncated: false };
  const ranked = room >= size ? rankPassages(source, question, { size }) : [];
  const extra = (Array.isArray(chunks) ? chunks : []).map(text).filter(Boolean);
  if (!ranked.length && !extra.length) return { text: wordCut(source, room), truncated: true, length: source.length };
  const headRoom = Math.floor(room * HEAD_SHARE);
  const head = wordCut(source, headRoom);
  let left = room - head.length;
  const chosen = [];
  for (const window of ranked) {
    // A window the opening already shows adds nothing.
    if (window.end <= head.length) continue;
    const start = Math.max(window.start, head.length);
    const piece = source.slice(start, window.end);
    if (piece.length > left) continue;
    chosen.push({ at: start, text: piece.trim() });
    left -= piece.length;
    if (left < size / 2) break;
  }
  const seen = value => { const probe = value.replace(/\s+/g, ' ').trim().slice(0, 80); return !probe || [head, ...chosen.map(entry => entry.text)].some(part => part.replace(/\s+/g, ' ').includes(probe)); };
  const meaning = [];
  for (const chunk of extra) {
    if (chunk.length > left || seen(chunk)) continue;
    meaning.push({ text: chunk.trim() });
    left -= chunk.length;
  }
  const passages = [...chosen.sort((a, b) => a.at - b.at), ...meaning];
  if (!passages.length) return { text: wordCut(source, room), truncated: true, length: source.length };
  return { text: head, passages, truncated: true, length: source.length };
}

/** A slice of a text from a character offset, for reading on: { text, at, next? } where next is the offset after it. */
export function readFrom(value, offset, budget) {
  const source = text(value);
  const at = Math.max(0, Math.min(source.length, Number.isInteger(offset) ? offset : 0));
  const end = Math.min(source.length, at + Math.max(0, Math.floor(budget)));
  return { text: source.slice(at, end), at, ...(end < source.length ? { next: end } : {}) };
}
