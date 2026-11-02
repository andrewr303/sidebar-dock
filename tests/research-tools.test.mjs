import test from 'node:test';
import assert from 'node:assert/strict';
import { applySection, createGitHubResearch, createToolRunner, describeToolUse, isErrorResult, sanitizeMarkdown, sectionHeader, upsertSection,
  validateGitHubQuery } from '../extension/lib/ai/research/custom-tools.js';
import { pageBlockLine } from '../extension/lib/pages.js';
import { createLibraryStore } from '../extension/lib/store.js';
import { json } from './research-fake-server.mjs';

const NOW = '2026-11-01T10:00:00.000Z';

function memoryStore(seed, { section = true } = {}) {
  let state = null;
  const library = createLibraryStore({ read: async () => state, write: async next => { state = next; } });
  const call = (operation, ...args) => library.dispatch(operation, args);
  const store = {
    ready: call('loadLibrary', seed), calls: [],
    loadLibrary: () => call('loadLibrary'),
    saveItem: input => { store.calls.push(['saveItem', input]); return call('saveItem', input); },
    updateItem: (id, patch, options = {}) => { store.calls.push(['updateItem', id, patch, options]); return call('updateItem', id, patch, options); },
    deleteItem: (id, options = {}) => call('deleteItem', id, options),
  };
  if (section) store.upsertContentSection = (id, options) => { store.calls.push(['upsertContentSection', id, options]); return call('upsertContentSection', id, options); };
  return store;
}
const seed = () => ({
  schemaVersion: 1, collections: [{ id: 'reading', name: 'Reading' }],
  items: [
    { id: 'art', type: 'article', title: 'Readability in 2026', url: 'https://example.com/readability', articleContent: '# Original\n\nCaptured text.', content: 'My note.', collectionId: 'reading' },
    { id: 'note', type: 'note', title: 'Ideas', content: 'Note body.' },
    { id: 'link', type: 'bookmark', title: 'A link', url: 'https://example.com/link' },
  ],
});
const item = async (store, id) => (await store.loadLibrary()).items.find(entry => entry.id === id);
const parse = result => JSON.parse(result.text);

async function runner({ store, itemId = 'art', state = {}, ...options } = {}) {
  const library = store || memoryStore(seed());
  await library.ready;
  return { store: library, state, tools: createToolRunner({ store: library, itemId, state, now: () => NOW, ...options }) };
}

for (const variant of ['store op', 'fallback']) {
  test(`append_to_document (${variant}): starts a dated section, extends it, and starts a fresh block when the user edited it`, async () => {
    const { store, state, tools } = await runner({ store: memoryStore(seed(), { section: variant === 'store op' }) });
    const first = await tools.run('append_to_document', { markdown: '### Background\n\nFirst [finding](https://a.example/1).' });
    assert.equal(first.isError, false);
    assert.deepEqual(parse(first), { ok: true, section: 'started' });
    assert.equal(first.step.kind, 'write');
    const header = sectionHeader(NOW);
    assert.equal(header, '## Research\n\n_Researched with Claude on November 1, 2026_');
    let article = await item(store, 'art');
    assert.equal(article.content, `My note.\n\n${header}\n\n### Background\n\nFirst [finding](https://a.example/1).`);
    assert.equal(article.articleContent, '# Original\n\nCaptured text.', 'the captured original is never touched');
    assert.equal(state.undo.sectionText, `${header}\n\n### Background\n\nFirst [finding](https://a.example/1).`);

    assert.equal(parse(await tools.run('append_to_document', { markdown: '### More\n\nSecond.' })).section, 'extended');
    article = await item(store, 'art');
    assert.equal(article.content, `My note.\n\n${header}\n\n### Background\n\nFirst [finding](https://a.example/1).\n\n### More\n\nSecond.`);
    assert.equal(state.writes, 2);

    // The user edits the research section: the next write starts a new block and never overwrites their edit.
    await store.updateItem('art', { content: article.content.replace('Second.', 'Second, edited by me.') });
    const userEdit = store.calls.length - 1;
    const third = parse(await tools.run('append_to_document', { markdown: 'Third.' }));
    assert.equal(third.section, 'restarted');
    assert.match(third.note, /starts a new research block/);
    article = await item(store, 'art');
    assert.match(article.content, /Second, edited by me\.\n\n## Research\n\n_Researched with Claude on November 1, 2026_\n\nThird\.$/);
    assert.equal(state.undo.sectionText, `${header}\n\nThird.`);
    const toolCalls = store.calls.filter((call, index) => index !== userEdit);
    if (variant === 'store op') assert.deepEqual(toolCalls.map(([name]) => name), ['upsertContentSection', 'upsertContentSection', 'upsertContentSection'], 'the store op does every section write');
    else {
      assert.deepEqual(toolCalls.map(([name]) => name), ['updateItem', 'updateItem', 'updateItem']);
      assert.ok(toolCalls.every(([, , , options]) => typeof options.expectedUpdatedAt === 'string'), 'fallback writes are revision-checked');
    }
  });
}

test('replace_research_section rewrites only its own section and keeps links to its subpages', async () => {
  const { store, state, tools } = await runner({ maxSubpages: 3 });
  await tools.run('append_to_document', { markdown: 'Draft text.' });
  const page = parse(await tools.run('create_subpage', { title: 'Benchmarks', markdown: 'Numbers [here](https://bench.example).' }));
  const result = parse(await tools.run('replace_research_section', { markdown: '### Summary\n\nTighter text.' }));
  assert.equal(result.section, 'replaced');
  const content = (await item(store, 'art')).content;
  assert.equal(content, `My note.\n\n${sectionHeader(NOW)}\n\n### Summary\n\nTighter text.\n\n${pageBlockLine(page.id, 'Benchmarks')}`);
  assert.ok(!content.includes('Draft text.'));
  assert.equal(state.undo.sectionText, content.slice('My note.\n\n'.length));
});

test('create_subpage: a note under the item, linked with a page block, nested pages under this run\'s pages only, capped by maxSubpages', async () => {
  const { store, state, tools } = await runner({ maxSubpages: 2 });
  const first = await tools.run('create_subpage', { title: '  Licensing   and governance ', markdown: 'Body one.' });
  assert.equal(first.isError, false);
  const page = parse(first);
  assert.equal(page.title, 'Licensing and governance');
  assert.equal(first.step.label, 'Created subpage “Licensing and governance”');
  const saved = await item(store, page.id);
  assert.equal(saved.type, 'note');
  assert.equal(saved.parentId, 'art');
  assert.equal(saved.collectionId, 'reading', 'a subpage lands in its parent\'s collection');
  assert.equal(saved.content, 'Body one.');
  assert.match((await item(store, 'art')).content, new RegExp(`## Research[\\s\\S]*\\[\\[${page.id}\\|Licensing and governance\\]\\]\\{page\\}$`));

  const nested = parse(await tools.run('create_subpage', { title: 'Patents', markdown: 'Nested.', parent: page.id }));
  assert.equal((await item(store, nested.id)).parentId, page.id);
  assert.equal((await item(store, page.id)).content, `Body one.\n\n${pageBlockLine(nested.id, 'Patents')}`);
  assert.deepEqual(state.undo.subpageIds, [page.id, nested.id]);
  assert.deepEqual(state.pages.map(entry => entry.parent), ['document', page.id]);

  const capped = await tools.run('create_subpage', { title: 'One too many', markdown: 'x' });
  assert.equal(capped.isError, true);
  assert.equal(parse(capped).error, 'subpage_limit');
  assert.match(parse(capped).message, /at most 2 subpages/);
  const foreign = await tools.run('create_subpage', { title: 'x', markdown: 'y', parent: 'note' });
  assert.equal(parse(foreign).error, 'subpage_limit', 'the cap is checked first');

  const none = await runner({ maxSubpages: 0 });
  assert.match(parse(await none.tools.run('create_subpage', { title: 'x', markdown: 'y' })).message, /creates no subpages/);
  const wrongParent = await runner({ maxSubpages: 3 });
  assert.equal(parse(await wrongParent.tools.run('create_subpage', { title: 'x', markdown: 'y', parent: 'note' })).error, 'unknown_parent');
  assert.equal((await wrongParent.store.loadLibrary()).items.length, 3, 'nothing was created');
});

test('update_subpage changes only subpages this run created, by append or replace (keeping nested links)', async () => {
  const { store, tools } = await runner({ maxSubpages: 4 });
  const page = parse(await tools.run('create_subpage', { title: 'Notes', markdown: 'Start.' }));
  const child = parse(await tools.run('create_subpage', { title: 'Child', markdown: 'Kid.', parent: page.id }));
  assert.deepEqual(parse(await tools.run('update_subpage', { id: page.id, markdown: 'Appended.' })), { ok: true, id: page.id, mode: 'append' });
  assert.equal((await item(store, page.id)).content, `Start.\n\n${pageBlockLine(child.id, 'Child')}\n\nAppended.`);
  await tools.run('update_subpage', { id: page.id, markdown: 'Rewritten.', mode: 'replace' });
  assert.equal((await item(store, page.id)).content, `Rewritten.\n\n${pageBlockLine(child.id, 'Child')}`);
  const refused = await tools.run('update_subpage', { id: 'note', markdown: 'Hijack.' });
  assert.equal(parse(refused).error, 'not_this_run');
  assert.equal((await item(store, 'note')).content, 'Note body.');
});

test('edit_original is refused unless the run allows it; when allowed it replaces the original and records the undo values', async () => {
  const refused = await runner();
  const result = await refused.tools.run('edit_original', { markdown: 'Rewritten.' });
  assert.equal(result.isError, true);
  assert.equal(parse(result).error, 'not_allowed');
  assert.match(parse(result).message, /stays as it is/);
  assert.equal((await item(refused.store, 'art')).articleContent, '# Original\n\nCaptured text.');

  const article = await runner({ allowOriginalEdits: true });
  assert.deepEqual(parse(await article.tools.run('edit_original', { markdown: '# Fixed\n\nBetter text.' })), { ok: true, field: 'article text' });
  assert.equal((await item(article.store, 'art')).articleContent, '# Fixed\n\nBetter text.');
  assert.equal((await item(article.store, 'art')).content, 'My note.', 'the user note is untouched');
  await article.tools.run('edit_original', { markdown: 'Second edit.' });
  assert.deepEqual([article.state.undo.originalField, article.state.undo.originalText, article.state.undo.originalWritten], ['articleContent', '# Original\n\nCaptured text.', 'Second edit.']);

  // A note: the body is replaced, and this run's section stays after it.
  const note = await runner({ itemId: 'note', allowOriginalEdits: true });
  await note.tools.run('append_to_document', { markdown: 'Found things.' });
  await note.tools.run('edit_original', { markdown: 'Clearer body.' });
  const body = (await item(note.store, 'note')).content;
  assert.equal(body, `Clearer body.\n\n${sectionHeader(NOW)}\n\nFound things.`);
  assert.equal(note.state.undo.originalText, 'Note body.');
  const bookmark = await runner({ itemId: 'link', allowOriginalEdits: true });
  assert.equal(parse(await bookmark.tools.run('edit_original', { markdown: 'x' })).error, 'no_original');
});

test('inputs are validated and cleaned: size cap, empty text, unsafe link schemes, unknown tools, a stopped run, a missing page', async () => {
  const { store, tools } = await runner();
  assert.equal(parse(await tools.run('append_to_document', { markdown: 'x'.repeat(60001) })).error, 'too_long');
  assert.equal(parse(await tools.run('append_to_document', { markdown: '   ' })).error, 'empty');
  assert.equal(parse(await tools.run('append_to_document', null)).error, 'empty');
  await tools.run('append_to_document', { markdown: 'See [this](javascript:alert(1)) and ![img](data:image/png;base64,AAA) and [ok](https://ok.example).\u0007' });
  assert.match((await item(store, 'art')).content, /See this and img and \[ok\]\(https:\/\/ok\.example\)\.$/);
  assert.equal(sanitizeMarkdown('a\r\nb [x](  vbscript:foo) [y](file:///etc/passwd)'), 'a\nb x y');
  assert.equal(parse(await tools.run('rm_rf', {})).error, 'unknown_tool');
  const stopped = await runner({ isStopped: () => true });
  assert.equal(parse(await stopped.tools.run('append_to_document', { markdown: 'x' })).error, 'stopped');
  assert.equal((await item(stopped.store, 'art')).content, 'My note.');
  await store.deleteItem('art');
  const trashed = await tools.run('append_to_document', { markdown: 'x' });
  assert.equal(parse(trashed).error, 'failed');
  assert.match(parse(trashed).message, /Trash/);
  assert.equal(isErrorResult(trashed.text), true);
  assert.equal(isErrorResult('{"ok":true}'), false);
  assert.equal(isErrorResult('not json'), false);
});

test('section helpers: last occurrence replaced, blank-line append, and the store op used when present', async () => {
  assert.deepEqual(applySection('a X b X c', 'X', 'Y'), { text: 'a X b Y c', replaced: true });
  assert.deepEqual(applySection('body', 'missing', 'new'), { text: 'body\n\nnew', replaced: false });
  assert.deepEqual(applySection('body\n', '', 'new'), { text: 'body\n\nnew', replaced: false });
  assert.deepEqual(applySection('body\n\n', '', 'new'), { text: 'body\n\nnew', replaced: false });
  assert.deepEqual(applySection('', '', 'new'), { text: 'new', replaced: false });
  const calls = [];
  const store = { upsertContentSection: async (id, options) => { calls.push([id, options]); return { item: { id }, replaced: true }; } };
  assert.deepEqual(await upsertSection(store, 'i', { previous: 'p', next: 'n' }), { item: { id: 'i' }, replaced: true });
  assert.deepEqual(calls, [['i', { previous: 'p', next: 'n', field: 'content' }]]);
  assert.equal(describeToolUse('github_get_repository', { owner: 'mozilla', repo: 'readability' }).url, 'https://github.com/mozilla/readability');
  assert.equal(describeToolUse('mystery', {}).kind, 'tool');
});

// ------------------------------------------------------------------ GitHub

function github(handler, options = {}) {
  const calls = [];
  const sleeps = [];
  let clock = Date.parse(NOW);
  const fetchImpl = async (url, init = {}) => { const call = { url: String(url), headers: init.headers || {} }; calls.push(call); return handler(call, calls.length - 1); };
  const reader = createGitHubResearch({ fetchImpl, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; }, ...options });
  return { calls, sleeps, reader };
}
const repo = { full_name: 'mozilla/readability', description: 'A standalone version of the readability library', html_url: 'https://github.com/mozilla/readability',
  stargazers_count: 9000, forks_count: 600, language: 'JavaScript', topics: ['reader', 'parser'], license: { spdx_id: 'Apache-2.0' }, pushed_at: '2026-10-01T00:00:00Z', archived: false,
  homepage: '', open_issues_count: 50, default_branch: 'main', created_at: '2010-01-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', private_field: 'dropped' };

test('GitHub search without a token is unauthenticated; with one it sends the token; results are compact JSON with html_url', async () => {
  const anonymous = github(() => json({ total_count: 1, incomplete_results: false, items: [repo] }, 200, { 'x-ratelimit-remaining': '9', 'x-ratelimit-resource': 'search' }), { getToken: async () => '' });
  const result = await anonymous.reader.run('github_search_repositories', { query: 'readability parser', sort: 'stars', limit: 3 });
  assert.equal(anonymous.calls[0].headers.Authorization, undefined);
  assert.equal(anonymous.calls[0].headers.Accept, 'application/vnd.github+json');
  assert.equal(anonymous.calls[0].url, 'https://api.github.com/search/repositories?q=readability%20parser&sort=stars&order=desc&per_page=3');
  assert.deepEqual(result.items[0], { full_name: 'mozilla/readability', description: 'A standalone version of the readability library', html_url: 'https://github.com/mozilla/readability',
    stars: 9000, forks: 600, language: 'JavaScript', topics: ['reader', 'parser'], license: 'Apache-2.0', pushed_at: '2026-10-01T00:00:00Z', archived: false });
  await anonymous.reader.run('github_search_repositories', { query: 'readability parser', sort: 'stars', limit: 3 });
  assert.equal(anonymous.calls.length, 1, 'the same request is answered from the run cache');

  const token = 'ghp_TESTTOKEN0123456789abcdef';
  const authed = github(() => json({ total_count: 0, items: [] }), { getToken: async () => token });
  await authed.reader.run('github_search_issues', { query: 'repo:mozilla/readability is:issue crash' });
  assert.equal(authed.calls[0].headers.Authorization, `Bearer ${token}`);
});

test('github_get_repository reads the repo, latest release and README (raw media type, 6k excerpt, labeled untrusted)', async () => {
  const readme = '# Readability\n' + 'x'.repeat(7000);
  const { calls, reader } = github(call => {
    if (call.url.endsWith('/readme')) return new Response(readme, { status: 200 });
    if (call.url.endsWith('/releases/latest')) return json({ message: 'Not Found' }, 404);
    return json(repo);
  }, { getToken: async () => '' });
  const result = await reader.run('github_get_repository', { owner: 'mozilla', repo: 'readability' });
  assert.deepEqual(calls.map(call => call.url.replace('https://api.github.com', '')), ['/repos/mozilla/readability', '/repos/mozilla/readability/releases/latest', '/repos/mozilla/readability/readme']);
  assert.equal(calls[2].headers.Accept, 'application/vnd.github.raw+json');
  assert.equal(result.latest_release, null, 'no release is fine');
  assert.equal(result.readme.excerpt.length, 6000);
  assert.equal(result.readme.truncated, true);
  assert.match(result.readme.note, /Untrusted/);
  assert.equal(result.stars, 9000);
  assert.ok(!('private_field' in result));
  await assert.rejects(reader.run('github_get_repository', { owner: 'bad owner', repo: 'x' }), error => error.code === 'invalid');
});

test('GitHub code search needs a token; queries are validated before a call; mode off disables the tools', async () => {
  const { calls, reader } = github(() => json({ total_count: 1, items: [{ repository: { full_name: 'a/b' }, path: 'src/x.js', html_url: 'https://github.com/a/b/blob/main/src/x.js' }] }), { getToken: async () => '' });
  await assert.rejects(reader.run('github_search_code', { query: 'parseArticle' }), error => error.code === 'token_required' && /connected GitHub account/.test(error.message));
  assert.equal(calls.length, 0);
  const withToken = github(() => json({ total_count: 1, items: [{ repository: { full_name: 'a/b' }, path: 'src/x.js', html_url: 'https://github.com/a/b/blob/main/src/x.js' }] }), { getToken: async () => 'ghp_x' });
  assert.deepEqual((await withToken.reader.run('github_search_code', { query: 'parseArticle' })).items, [{ repository: 'a/b', path: 'src/x.js', html_url: 'https://github.com/a/b/blob/main/src/x.js' }]);
  assert.match(validateGitHubQuery('x'.repeat(257)), /256 characters/);
  assert.match(validateGitHubQuery('a AND b OR c AND d OR e NOT f NOT g'), /five AND, OR or NOT/);
  assert.equal(validateGitHubQuery('a AND b'), '');
  await assert.rejects(reader.run('github_search_repositories', { query: '' }), error => error.code === 'invalid_query');
  const off = github(() => json({}), { mode: 'off' });
  await assert.rejects(off.reader.run('github_search_repositories', { query: 'x' }), error => error.code === 'github_off');
  assert.equal(off.calls.length, 0);
});

test('GitHub rate limits: a reset within 10 s is waited out and retried; a later one becomes a rate_limited result; a bad token falls back', async () => {
  const resetSoon = Math.floor(Date.parse(NOW) / 1000) + 5;
  const soon = github((call, index) => index === 0 ? json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSoon) })
    : json({ total_count: 0, items: [] }), { getToken: async () => '' });
  assert.deepEqual(await soon.reader.run('github_search_repositories', { query: 'x' }), { total_count: 0, incomplete_results: false, items: [] });
  assert.equal(soon.calls.length, 2);
  assert.ok(soon.sleeps[0] >= 5000 && soon.sleeps[0] <= 5500);

  const later = github(() => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSoon + 3600) }), { getToken: async () => '' });
  const error = await later.reader.run('github_search_repositories', { query: 'x' }).catch(failure => failure);
  assert.equal(error.code, 'rate_limited');
  assert.match(error.message, /Use web_search/);
  // The known limit is honoured without another request.
  await assert.rejects(later.reader.run('github_search_repositories', { query: 'y' }), failure => failure.code === 'rate_limited');
  assert.equal(later.calls.length, 1);

  // Through the runner the agent gets a structured, non-fatal result.
  const runnerResult = await createToolRunner({ store: { loadLibrary: async () => ({ items: [] }) }, itemId: 'x', state: {}, github: later.reader }).run('github_search_repositories', { query: 'z' });
  assert.equal(runnerResult.isError, true);
  assert.equal(JSON.parse(runnerResult.text).error, 'rate_limited');
  assert.ok(JSON.parse(runnerResult.text).reset_at);

  const stale = github(call => call.headers.Authorization ? json({ message: 'Bad credentials' }, 401) : json({ total_count: 0, items: [] }), { getToken: async () => 'ghp_revoked' });
  await stale.reader.run('github_search_repositories', { query: 'x' });
  assert.deepEqual(stale.calls.map(call => !!call.headers.Authorization), [true, false]);

  const capped = github(() => json({ total_count: 0, items: [] }), { getToken: async () => '', maxCalls: 2 });
  await capped.reader.run('github_search_repositories', { query: 'a' });
  await capped.reader.run('github_search_repositories', { query: 'b' });
  await assert.rejects(capped.reader.run('github_search_repositories', { query: 'c' }), failure => failure.code === 'call_limit');
});
