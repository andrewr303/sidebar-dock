import test from 'node:test';
import assert from 'node:assert/strict';
import { PASSAGE_SIZE, fitText, passageWindows, questionTerms, rankPassages, readFrom } from '../extension/lib/ai/passages.js';

const filler = (label, paragraphs) => Array.from({ length: paragraphs }, (_, index) => `${label} paragraph ${index + 1}. The committee reviewed routine matters and adjourned without further remarks on the agenda.`).join('\n\n');
// A long article whose answer sits far past its opening.
const article = [filler('Opening', 30), 'The refund policy changed in March: customers may now return kettles within ninety days, and the restocking fee was abolished.', filler('Middle', 60),
  'Warranty claims for the copper kettle are handled by the Tampere workshop, which replies within five working days.', filler('Closing', 30)].join('\n\n');

test('windows cover the text in order, end at paragraph or sentence breaks, and keep true offsets', () => {
  const windows = passageWindows(article);
  assert.ok(windows.length > 10);
  assert.equal(windows[0].start, 0);
  for (let index = 1; index < windows.length; index++) assert.equal(windows[index].start, windows[index - 1].end, 'no gap and no overlap');
  assert.equal(windows.at(-1).end, article.length);
  for (const window of windows) assert.ok(window.end - window.start <= PASSAGE_SIZE);
  const endsCleanly = windows.slice(0, -1).filter(window => /(\n\n|[.!?]\s?)$/.test(article.slice(window.start, window.end)));
  assert.ok(endsCleanly.length >= windows.length - 2, 'cuts fall on paragraph or sentence ends');
  assert.deepEqual(passageWindows(''), []);
  assert.deepEqual(passageWindows('short'), [{ start: 0, end: 5 }]);
  // A text without any break is still cut, and the walk always moves forward.
  const solid = passageWindows('x'.repeat(5000));
  assert.equal(solid.length, 5);
  assert.equal(solid.at(-1).end, 5000);
  assert.equal(passageWindows('x'.repeat(100_000), { size: 100, max: 50 }).length, 50, 'the number of windows is bounded');
});

test('the words of a question that tell passages apart: no stop words, unless that is all there is', () => {
  assert.deepEqual(questionTerms('What is the refund policy for kettles?'), ['refund', 'policy', 'kettle']);
  assert.deepEqual(questionTerms('what is it'), ['what', 'is', 'it'], 'a question of only stop words keeps them');
  assert.deepEqual(questionTerms(''), []);
  assert.deepEqual(questionTerms(null), []);
  assert.equal(questionTerms(Array.from({ length: 100 }, (_, index) => `word${index}`).join(' ')).length, 40);
});

test('passages are ranked by how many of the question\'s words they hold, then by how often', () => {
  const ranked = rankPassages(article, 'What is the refund policy for kettles?');
  assert.ok(ranked.length >= 1);
  const best = article.slice(ranked[0].start, ranked[0].end);
  assert.match(best, /The refund policy changed in March/);
  assert.equal(ranked[0].matched, 3);
  assert.ok(ranked.every((entry, index) => index === 0 || entry.score <= ranked[index - 1].score));
  assert.deepEqual(rankPassages(article, 'zebra quantum'), [], 'nothing matches, nothing is returned');
  assert.deepEqual(rankPassages(article, ''), []);
  // More distinct words beat more repeats of one word.
  const text = `${'kettle '.repeat(40)}\n\n${'x '.repeat(700)}\n\nA kettle with a refund.`;
  const order = rankPassages(text, 'kettle refund', { size: 300 });
  assert.match(text.slice(order[0].start, order[0].end), /A kettle with a refund/);
});

test('a text that fits is given whole; one that does not is its opening and the passages that match', () => {
  assert.deepEqual(fitText('Short note.', 'anything', { budget: 100 }), { text: 'Short note.', truncated: false });
  const fitted = fitText(article, 'Who handles warranty claims for the copper kettle?', { budget: 6000 });
  assert.equal(fitted.truncated, true);
  assert.equal(fitted.length, article.length);
  assert.ok(fitted.text.startsWith('Opening paragraph 1.'), 'the opening is kept for context');
  assert.ok(fitted.text.length <= 6000 * 0.35);
  assert.ok(fitted.passages.length >= 1);
  const found = fitted.passages.find(passage => /Tampere workshop/.test(passage.text));
  assert.ok(found, 'the passage far past the opening reaches the model');
  assert.equal(article.slice(found.at, found.at + 40), found.text.slice(0, 40), 'its offset points at it in the text');
  assert.ok(found.at > 8000, 'it sits beyond what a cut at the start would have kept');
  const total = fitted.text.length + fitted.passages.reduce((sum, passage) => sum + passage.text.length, 0);
  assert.ok(total <= 6000, `${total} characters for a budget of 6000`);
  for (let index = 1; index < fitted.passages.length; index++) assert.ok(fitted.passages[index].at > fitted.passages[index - 1].at, 'passages are in reading order');
});

test('when nothing in the text matches, the model gets the opening as before', () => {
  const fitted = fitText(article, 'zebra quantum', { budget: 3000 });
  assert.equal(fitted.passages, undefined);
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.text.length <= 3000 && fitted.text.length > 2000);
  assert.ok(fitted.text.startsWith('Opening paragraph 1.'));
  // A budget too small for a window is the opening too.
  assert.equal(fitText(article, 'refund policy', { budget: 400 }).passages, undefined);
  assert.deepEqual(fitText('', 'x', { budget: 10 }), { text: '', truncated: false });
});

test('a match that is already in the opening is not repeated', () => {
  const text = `Refund policy: ninety days. ${'Other text follows here. '.repeat(400)}`;
  const fitted = fitText(text, 'refund policy', { budget: 4000 });
  assert.ok(fitted.text.startsWith('Refund policy: ninety days.'));
  assert.ok(!(fitted.passages || []).some(passage => /Refund policy/.test(passage.text)));
});

test('chunks the semantic index found are kept as passages when the words alone did not find them', () => {
  const meaning = 'Customers who are unhappy can send the product back for their money.';
  const fitted = fitText(article, 'zebra quantum', { budget: 4000, chunks: [meaning, article.slice(0, 200)] });
  assert.equal(fitted.truncated, true);
  assert.deepEqual(fitted.passages, [{ text: meaning }], 'the chunk is added; one the opening already shows is not');
  const both = fitText(article, 'refund policy', { budget: 6000, chunks: [meaning] });
  assert.ok(both.passages.some(passage => passage.at > 0) && both.passages.some(passage => passage.text === meaning));
  assert.equal(both.passages.at(-1).text, meaning, 'passages with an offset come first, in reading order');
});

test('reading on from an offset returns the next part and where it ends', () => {
  assert.deepEqual(readFrom('abcdefghij', 3, 4), { text: 'defg', at: 3, next: 7 });
  assert.deepEqual(readFrom('abcdefghij', 8, 10), { text: 'ij', at: 8 });
  assert.deepEqual(readFrom('abc', 99, 10), { text: '', at: 3 });
  assert.deepEqual(readFrom('abc', -5, 2), { text: 'ab', at: 0, next: 2 });
  assert.deepEqual(readFrom('abc', 1.5, 2), { text: 'ab', at: 0, next: 2 }, 'an offset that is not a whole number starts at the beginning');
});
