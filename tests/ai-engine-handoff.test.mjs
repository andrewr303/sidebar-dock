import test from 'node:test';
import assert from 'node:assert/strict';
import { HANDOFF_TARGETS, MAX_HANDOFF_URL, buildHandoffPrompt, handoffPlan, handoffUrl } from '../extension/lib/ai/handoff.js';

const sources = Array.from({ length: 12 }, (_, index) => ({
  title: `Source ${index + 1} [draft]`, url: `https://example.com/articles/${index + 1}`,
  excerpt: `Excerpt ${index + 1} `.repeat(120),
}));

test('handoff URLs use each app’s prefill format with an encoded prompt', () => {
  const prompt = 'Compare these & tell me why? #1 café';
  const encoded = encodeURIComponent(prompt);
  assert.equal(handoffUrl('claude', prompt), `https://claude.ai/new?q=${encoded}`);
  assert.equal(handoffUrl('chatgpt', prompt), `https://chatgpt.com/?q=${encoded}`);
  assert.equal(handoffUrl('grok', prompt), `https://grok.com/?q=${encoded}`);
  assert.equal(handoffUrl('perplexity', prompt), `https://www.perplexity.ai/search?q=${encoded}`);
  assert.equal(handoffUrl('gemini', prompt), `https://gemini.google.com/app?q=${encoded}`);
  assert.equal(handoffUrl('copilot', prompt), `https://copilot.microsoft.com/?q=${encoded}`);
  assert.throws(() => handoffUrl('evil', prompt), /Choose Claude/);
  assert.equal(handoffPlan('chatgpt', prompt).copyFirst, false);
  assert.equal(handoffPlan('gemini', prompt).copyFirst, true, 'Gemini prefill is unreliable, so the prompt should be copied too');
  assert.ok(HANDOFF_TARGETS.every(target => target.base.startsWith('https://')));
});

test('buildHandoffPrompt puts the question first and lists linked sources with short excerpts', () => {
  const prompt = buildHandoffPrompt({ question: 'What do these say about calm design?', sources: [
    { title: 'Calm tech', url: 'https://calm.example/one', excerpt: '  Quiet   interfaces respect attention.  ' },
    { title: 'A note', excerpt: 'No link here' },
    { title: 'Bad link', url: 'javascript:alert(1)' },
  ] });
  assert.equal(prompt, [
    'What do these say about calm design?',
    '',
    'Sources from my Still library:',
    '',
    '1. [Calm tech](https://calm.example/one)',
    '   > Quiet interfaces respect attention.',
    '2. A note',
    '   > No link here',
    '3. Bad link',
  ].join('\n'));
  assert.equal(buildHandoffPrompt({ question: 'Just this' }), 'Just this');
});

test('long handoffs shrink and drop sources before touching the question, and stay under the URL limit', () => {
  const question = 'Summarize the main argument across my sources and list open questions.';
  for (const target of ['claude', 'chatgpt', 'grok', 'perplexity']) {
    const plan = handoffPlan(target, { question, sources });
    assert.ok(plan.url.length <= MAX_HANDOFF_URL, `${target} ${plan.url.length}`);
    assert.ok(plan.prompt.startsWith(question));
    assert.equal(plan.truncated, true);
    assert.equal(plan.copyFirst, true);
    assert.ok(plan.fullPrompt.length > plan.prompt.length);
    assert.match(plan.prompt, /Source 1/, 'the first sources survive');
  }
  const roomy = handoffPlan('chatgpt', { question, sources }, { maxLength: 400 });
  assert.ok(roomy.url.length <= 400);
  assert.match(roomy.prompt, /^Summarize[\s\S]*1\. \[Source 1 draft\]\(https:\/\/example\.com\/articles\/1\)/);
  const tight = handoffPlan('chatgpt', { question, sources }, { maxLength: 150 });
  assert.ok(tight.url.length <= 150);
  assert.equal(tight.prompt, question);
});

test('a plain string prompt is cut at a character boundary with an ellipsis', () => {
  const plan = handoffPlan('grok', '🙂'.repeat(5000), { maxLength: 1000 });
  assert.ok(plan.url.length <= 1000);
  assert.ok(plan.prompt.endsWith('…'));
  assert.doesNotThrow(() => decodeURIComponent(plan.url.split('?q=')[1]));
  const claude = handoffPlan('claude', 'a'.repeat(20000), { maxLength: 100000 });
  assert.ok(claude.prompt.length <= 14000, 'Claude truncates q near 14,000 characters');
});
