import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChatSummaryMarkdown, escapeMarkdown, inlineCode, codeBlock, refsMarkdown, messageRef, safeResumeCommand, normalizeLlmMarkdown, workflowLabel, categoryLabel, oneLine,
} from '../extension/lib/threadkeeper/summary.js';
import { renderMarkdown, standaloneImage } from '../extension/lib/markdown.js';

const day = iso => String(iso).slice(0, 10);
const v2 = {
  thread: {
    threadKey: 'claude_code:acct:ws:abc:main', provider: 'claude_code', providerLabel: 'Claude Code', agentLabel: '', project: 'Billing', workflowState: 'waiting',
    model: 'claude-opus-4-5', workspacePath: "/home/me/it's here", gitBranch: 'fix/webhooks', createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-03T18:00:00Z',
    resumeCommand: "cd '/home/me/it'\\''s here' && claude --resume 'f1e2-3a'",
    analysis: {
      source: 'ai', model: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', generatedAt: '2026-10-03T19:00:00Z', analysisVersion: 2,
      gist: 'Stripe webhooks now go through a queue, so retries no longer double-charge.',
      overview: ['You moved webhook handling behind SQS with idempotency keys.', 'Stripe webhooks now go through a queue, so retries no longer double-charge.', 'Two tests still fail on staging.'],
      summary: 'Legacy text that must not show when an overview exists.',
      userGoal: 'Stop duplicate charges on retried webhooks', outcome: 'Queue in place; staging deploy pending', statusReason: 'Waiting on the staging deploy',
      kindLabel: 'Debugging', topics: ['webhooks', 'stripe api'], entities: ['Stripe', 'SQS'], languages: ['TypeScript'],
      keyPoints: [{ text: 'Idempotency keys come from the event id', refs: [4, 4, 9] }],
      whereYouLeftOff: { text: 'Unit tests pass; staging is not deployed', refs: [41] },
      nextStep: 'Deploy the queue worker to staging',
      decisions: [
        { text: 'Use SQS instead of a cron retry', rationale: 'It is already in the stack', speaker: 'user_committed', refs: [12], quote: '' },
        { text: 'Add a dead-letter queue', rationale: '', speaker: 'assistant_suggested', refs: [], quote: '' },
      ],
      actionItems: [{ text: 'Deploy the queue worker to staging.', rationale: '', speaker: 'user_committed', refs: [] }, { text: 'Write the runbook', rationale: '', speaker: 'user_committed', refs: [30] }],
      openQuestions: [{ text: 'How long do we keep processed event ids?', rationale: '', speaker: 'user_committed', refs: [] }],
      constraints: [{ text: 'No new infrastructure', rationale: '', speaker: 'user_committed', refs: [2] }],
      artifacts: [{ label: 'src/queue.ts', kind: 'code', description: 'The SQS consumer', ref: 20 }, { label: '', kind: 'code', description: 'ignored', ref: null }],
    },
  },
};

test('message refs are 0-based in the link and 1-based in the label, deduped, sorted and capped', () => {
  assert.equal(messageRef(2), '[m3](#msg-2)');
  assert.equal(refsMarkdown([9, 4, 4, -1, 1.5, 'x', 100]), ' [m5](#msg-4) [m10](#msg-9) [m101](#msg-100)');
  assert.equal(refsMarkdown([1, 2, 3, 4, 5, 6]), ' [m2](#msg-1) [m3](#msg-2) [m4](#msg-3) [m5](#msg-4)');
  assert.equal(refsMarkdown(7), ' [m8](#msg-7)');
  assert.equal(refsMarkdown(null), '');
  assert.equal(refsMarkdown([]), '');
});

test('escapeMarkdown keeps untrusted text literal: no blocks, links, wiki links, embeds or HTML', () => {
  const nasty = ['# Heading', '- item', '1. one', '2) two', '> quote', '---', ':::toggle x', '::embed[x](https://e.com)', '![[file]]', '[[Secret note]]',
    '[click](javascript:alert(1))', '<script>alert(1)</script>', '**bold** _it_ `code` ~~s~~', '| a | b |', '\\[m1](#msg-0)'];
  for (const text of nasty) {
    const rendered = renderMarkdown(escapeMarkdown(text));
    assert.match(rendered, /^<p>/, text);
    assert.doesNotMatch(rendered, /<(?:h\d|ul|ol|li|blockquote|hr|details|strong|em|code|del|table|script|img|iframe)\b|note-link|markdown-embed|markdown-page|href="javascript:/, text);
    // The only link that survives is a plain https address, which stays a normal external link.
    for (const [, attrs] of rendered.matchAll(/<a\b([^>]*)>/g)) assert.match(attrs, /data-autolink="bare" href="https:\/\/e\.com\/"/, text);
  }
  assert.equal(renderMarkdown(escapeMarkdown('Fix #12 *now*')), '<p>Fix #12 *now*</p>');
  assert.equal(escapeMarkdown('two\nlines\u202e  here'), 'two lines here');
});

test('inline code and code blocks cannot be closed early by backticks in the text', () => {
  assert.equal(inlineCode('a`b'), '`` a`b ``');
  assert.equal(inlineCode('plain'), '`plain`');
  assert.equal(inlineCode(''), '');
  assert.equal(codeBlock('x ``` y', 'sh'), '````sh\nx ``` y\n````');
  assert.equal(renderMarkdown(codeBlock('one\n```\ntwo')), '<pre class="markdown-code"><code>one\n```\ntwo</code></pre>');
});

test('the resume command is rebuilt from validated parts and refused otherwise', () => {
  assert.equal(safeResumeCommand(v2.thread), "cd '/home/me/it'\\''s here' && claude --resume 'f1e2-3a'");
  assert.equal(safeResumeCommand({ provider: 'codex', resumeCommand: "codex resume 'abc_9'" }), "codex resume 'abc_9'");
  for (const resumeCommand of ["claude --resume 'abc'; rm -rf /", "claude --resume 'a b'", 'claude --resume abc', "cd /tmp && claude --resume 'abc'",
    "claude --resume 'abc' && curl evil", "cd '/tmp\n' && claude --resume 'abc'", '']) {
    assert.equal(safeResumeCommand({ provider: 'claude_code', resumeCommand }), '', resumeCommand);
  }
  // A command must belong to the thread's own CLI.
  assert.equal(safeResumeCommand({ provider: 'chatgpt', resumeCommand: "claude --resume 'abc'" }), '');
  assert.equal(safeResumeCommand({ provider: 'claude_code', resumeCommand: "codex resume 'abc'" }), '');
});

test('a current analysis becomes a note-like page with every section in order', () => {
  const md = buildChatSummaryMarkdown(v2, { title: 'Webhooks', excerpt: 'older gist', chat: { topics: ['webhooks', 'queues'] } }, { formatDate: day });
  const headings = md.split('\n').filter(line => line.startsWith('## ')).map(line => line.slice(3));
  assert.deepEqual(headings, ['What this thread is about', 'Key points', 'Where you left off', 'Decisions', 'Constraints', 'Next steps', 'Open questions', 'What was produced', 'Context']);
  const lines = md.split('\n');
  // The gist leads; the overview follows without repeating it; the legacy summary stays out.
  assert.equal(lines[1], 'Stripe webhooks now go through a queue, so retries no longer double-charge.');
  assert.equal(lines[2], 'You moved webhook handling behind SQS with idempotency keys.');
  assert.equal(lines[3], 'Two tests still fail on staging.');
  assert.doesNotMatch(md, /Legacy text/);
  assert.match(md, /^\*\*Goal:\*\* Stop duplicate charges on retried webhooks$/m);
  assert.match(md, /^\*\*Status:\*\* Waiting — Waiting on the staging deploy$/m);
  assert.match(md, /^- Idempotency keys come from the event id \[m5\]\(#msg-4\) \[m10\]\(#msg-9\)$/m);
  assert.match(md, /^> \[!NOTE\]\n> Unit tests pass; staging is not deployed \[m42\]\(#msg-41\)\n\*\*Next step:\*\* Deploy the queue worker to staging$/m);
  assert.match(md, /^### You decided\n- Use SQS instead of a cron retry — It is already in the stack \[m13\]\(#msg-12\)\n### Suggested\n- Add a dead-letter queue$/m);
  // The next step is not repeated as an action item.
  assert.match(md, /## Next steps\n- \[ \] Write the runbook \[m31\]\(#msg-30\)\n## Open questions/);
  assert.match(md, /^- \*\*src\/queue\.ts\*\* — The SQS consumer \(code\) \[m21\]\(#msg-20\)$/m);
  assert.doesNotMatch(md, /ignored/);
  assert.match(md, /^\*\*Topics:\*\* \\#webhooks \\#stripe-api \\#queues$/m);
  assert.match(md, /^\*\*Mentions:\*\* Stripe, SQS$/m);
  assert.match(md, /^\*\*Workspace:\*\* `\/home\/me\/it's here` on `fix\/webhooks`$/m);
  assert.match(md, /^\*\*Dates:\*\* started 2026-10-01, last activity 2026-10-03$/m);
  assert.match(md, /^\*\*Summary:\*\* written by Claude Sonnet 4\.5 on 2026-10-03$/m);
  assert.match(md, /```sh\ncd '\/home\/me\/it'\\''s here' && claude --resume 'f1e2-3a'\n```$/);
});

test('the summary renders with Still blocks only: headings, callout, tasks, ref links, code; never raw HTML', () => {
  const evil = structuredClone(v2);
  evil.thread.analysis.gist = '<img src=x onerror=alert(1)> [[Private]] ![x](https://tracker.example/p.png)';
  evil.thread.analysis.keyPoints.push({ text: '[pwn](javascript:alert(1)) <iframe>', refs: [] });
  const out = renderMarkdown(buildChatSummaryMarkdown(evil, {}, { formatDate: day }), { images: false });
  assert.doesNotMatch(out, /<img|<iframe|<script|href="javascript:|note-link/);
  // A remote image address stays text (at most a link the user can choose to open); nothing loads it.
  assert.doesNotMatch(out, /src="https:\/\/tracker/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /<h2>What this thread is about<\/h2>/);
  assert.match(out, /<div class="markdown-callout" data-kind="note" role="note">/);
  assert.match(out, /<div class="task-line"><span class="task-check" aria-hidden="true"><\/span><span>Write the runbook <a class="markdown-link" href="#msg-30">m31<\/a><\/span><\/div>/);
  assert.match(out, /<pre class="markdown-code"><code data-language="sh">/);
});

test('older analyses and chats without a stored record still read well', () => {
  const v1 = { thread: { provider: 'chatgpt', providerLabel: 'ChatGPT', project: 'Unfiled / Uncertain', analysis: { source: 'local', gist: 'Trip ideas for Lisbon', summary: 'Compared neighbourhoods and day trips.', topics: ['travel'], keyPoints: [], decisions: [] } } };
  const md = buildChatSummaryMarkdown(v1, {}, { formatDate: day });
  assert.equal(md.split('\n').slice(0, 3).join('\n'), '## What this thread is about\nTrip ideas for Lisbon\nCompared neighbourhoods and day trips.');
  assert.doesNotMatch(md, /Project/, 'the Unfiled bucket is not a project');
  assert.match(md, /\*\*Summary:\*\* written on this device by Threadkeeper/);
  assert.match(md, /\*\*Provider:\*\* ChatGPT/);
  // Only suggested decisions: one list, labelled as not confirmed.
  const suggested = buildChatSummaryMarkdown({ thread: { analysis: { decisions: [{ text: 'Try Redis', speaker: 'assistant_suggested', refs: [] }] } } }, {});
  assert.equal(suggested, '## Decisions\n*Suggested, not confirmed:*\n- Try Redis');
  // No record: the item's gist and metadata stand in.
  const bare = buildChatSummaryMarkdown(null, { excerpt: 'Refactor the parser', siteName: 'Codex', chat: { provider: 'codex', providerLabel: 'Codex', project: 'Still', workflowState: 'done' } }, { formatDate: day });
  assert.equal(bare, '## What this thread is about\nRefactor the parser\n**Status:** Done\n## Context\n**Project:** Still\n**Provider:** Codex');
  assert.equal(buildChatSummaryMarkdown(null, {}), '');
  assert.equal(buildChatSummaryMarkdown({ thread: { analysis: 'junk', overview: 5 } }, { chat: 'junk' }), '');
});

test('model Markdown is normalized for Still: deep headings, + lists and 1) lists, never inside code', () => {
  const input = '#### Plan\n##### Deep\n+ one\n  + nested\n1) first\n10) tenth\n```\n#### keep\n+ keep\n1) keep\n```\n+not a list\n####no space';
  assert.equal(normalizeLlmMarkdown(input), '### Plan\n### Deep\n- one\n  - nested\n1. first\n10. tenth\n```\n#### keep\n+ keep\n1) keep\n```\n+not a list\n####no space');
  assert.equal(normalizeLlmMarkdown('~~~js\n+ x\n~~~\n+ y'), '~~~js\n+ x\n~~~\n- y');
  assert.equal(normalizeLlmMarkdown('a\r\nb'), 'a\nb');
  assert.match(renderMarkdown(normalizeLlmMarkdown('#### Title\n+ a\n+ b')), /^<h3>Title<\/h3><ul><li>a<\/li><li>b<\/li><\/ul>$/);
});

test('renderMarkdown images:false shows a standalone image as a link and never loads it', () => {
  const md = '![chart](https://img.example/c.png "Q3")';
  assert.ok(standaloneImage(md));
  assert.match(renderMarkdown(md), /<img src="https:\/\/img\.example\/c\.png"/);
  const off = renderMarkdown(md, { images: false });
  assert.doesNotMatch(off, /<img/);
  assert.equal(off, '<p><a class="markdown-media-link" href="https://img.example/c.png" target="_blank" rel="noopener noreferrer" title="Q3"><span>Image · </span>chart</a></p>');
  assert.equal(renderMarkdown('![](https://img.example/c.png)', { images: false }), '<p><a class="markdown-media-link" href="https://img.example/c.png" target="_blank" rel="noopener noreferrer"><span>Image · </span>https://img.example/c.png</a></p>');
});

test('labels', () => {
  assert.equal(workflowLabel('needs_review'), 'Needs review');
  assert.equal(workflowLabel('nope'), '');
  assert.equal(categoryLabel('coding_agent'), 'Coding agent');
  assert.equal(categoryLabel('???'), 'Chat');
  assert.equal(oneLine(' a \n\t b\u0007 '), 'a b');
});
