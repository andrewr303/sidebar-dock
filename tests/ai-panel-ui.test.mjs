import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveContext, suggestionsFor, streamingCitations, numberCitations, exportAnswer, classifyError, appliedLines, exclusionPatches,
  historyGroups, shortModelLabel, formatDuration, MAX_QUESTION,
} from '../extension/ui/ai-panel.js';
import { renderMarkdown } from '../extension/lib/markdown.js';

const page = { url: 'https://example.com/post', title: 'A post' };

test('context: items beat the page, the page beats a collection, the library is the fallback', () => {
  assert.deepEqual(resolveContext({}).scope, { scope: 'library' });
  assert.equal(resolveContext({}).chips[0].removable, false, 'the library fallback cannot be removed');
  assert.deepEqual(resolveContext({ viewCollectionId: 'design' }).scope, { scope: 'collection', collectionId: 'design' });
  assert.deepEqual(resolveContext({ viewCollectionId: '' }).scope, { scope: 'collection', collectionId: '' }, 'Inbox is the empty collection id');
  assert.deepEqual(resolveContext({ page, viewCollectionId: 'design' }).scope, { scope: 'page', page: { url: page.url, title: 'A post' } });
  const items = resolveContext({ page, selectionIds: ['a', 'b'], added: ['c', 'a'] });
  assert.equal(items.kind, 'items');
  assert.deepEqual(items.scope, { scope: 'items', ids: ['c', 'a', 'b'] });
  assert.deepEqual(items.chips.map(chip => chip.key), ['added:c', 'added:a', 'selection:a,b']);
  assert.deepEqual(resolveContext({ added: ['x'] }).scope, { scope: 'item', ids: ['x'] });
  assert.equal(resolveContext({ page: { url: 'chrome://newtab/' } }).kind, 'library', 'only web pages become context');
});

test('context: dismissed and explicit chips', () => {
  assert.equal(resolveContext({ page, dismissed: new Set([`page:${page.url}`]) }).kind, 'library');
  assert.equal(resolveContext({ selectionIds: ['a'], dismissed: new Set(['selection:a']) }).kind, 'library');
  assert.equal(resolveContext({ selectionIds: ['a', 'b'], dismissed: new Set(['selection:a']) }).kind, 'items', 'a new selection shows again');
  const explicit = resolveContext({ explicit: { scope: 'collection', collectionId: 'travel' }, page, selectionIds: ['a'] });
  assert.deepEqual(explicit.scope, { scope: 'collection', collectionId: 'travel' }, 'an explicit scope ignores automatic context');
  assert.equal(explicit.chips[0].key, 'explicit');
  assert.deepEqual(resolveContext({ explicit: { scope: 'library' }, page }).scope, { scope: 'library' });
  assert.deepEqual(resolveContext({ explicit: { scope: 'page' }, page, dismissed: new Set([`page:${page.url}`]) }).scope.scope, 'page');
  assert.deepEqual(resolveContext({ explicit: { scope: 'item', ids: ['a', 'a', 'b'] } }).scope, { scope: 'items', ids: ['a', 'b'] });
});

test('suggestions adapt to the context and templates keep their gaps', () => {
  assert.deepEqual(suggestionsFor('page').map(s => s.label), ['Summarize this page', 'Key points', 'Find related in my library', 'Save this with tags']);
  assert.equal(suggestionsFor('page')[3].run, 'save-page');
  assert.equal(suggestionsFor('collection', { collectionName: 'Travel' })[0].label, 'Digest of Travel');
  assert.equal(suggestionsFor('items', { count: 1 })[0].label, 'Summarize this item');
  assert.equal(suggestionsFor('items', { count: 4 })[0].label, 'Summarize these 4 items');
  const general = suggestionsFor('library');
  assert.equal(general.length, 4);
  assert.ok(general.some(s => s.prompt.includes('…')), 'general starters are templates to finish');
  for (const s of [...general, ...suggestionsFor('page'), ...suggestionsFor('collection'), ...suggestionsFor('items', { count: 2 })]) {
    assert.doesNotMatch(s.label, /—|!/, 'copy rules: no em dashes or exclamation marks');
  }
});

test('streaming citations number sources by first appearance and skip unknown ids', () => {
  const known = { a: { title: 'Alpha', url: 'https://a.example/' }, b: { title: 'Beta' } };
  const list = streamingCitations('See [[b]] and [[a]], again [[b]], not [[zzz]].', id => known[id] || null);
  assert.deepEqual(list, [{ n: 1, id: 'b', title: 'Beta', url: '' }, { n: 2, id: 'a', title: 'Alpha', url: 'https://a.example/' }]);
});

test('numbered citation chips replace markdown.js source chips and keep markup escaped', () => {
  const citations = [{ n: 1, id: 'item_1', title: 'Tom & "Jerry"' }, { n: 2, id: 'page:current', title: 'This page' }];
  const markup = numberCitations(renderMarkdown('One [[item_1]] two [[page:current]] three [[gone]].', { citations }), citations);
  assert.match(markup, /<span class="ai-cite" data-tooltip="Tom &amp; &quot;Jerry&quot;"><button type="button" class="ai-citation is-numbered" data-action="ai\.cite" data-id="item_1" aria-label="Source 1: Tom &amp; &quot;Jerry&quot;">1<\/button><\/span>/);
  assert.match(markup, /data-id="page:current"[^>]*>2<\/button>/);
  assert.match(markup, /ai-citation-unavailable/, 'unknown ids keep the markdown.js fallback');
  assert.doesNotMatch(markup, /data-ai-action/);
});

test('answers export with titles: Markdown links for copying, note links for notes', () => {
  const citations = [{ n: 1, id: 'a', title: 'Alpha [draft]', url: 'https://a.example/' }, { n: 2, id: 'page:current', title: 'Page', url: 'https://p.example/' }, { n: 3, id: 'n', title: 'Note', url: '' }];
  const answer = 'Read [[a]] and [[page:current]] plus [[n]] [[missing]].';
  assert.equal(exportAnswer(answer, citations), 'Read [Alpha draft](https://a.example/) and [Page](https://p.example/) plus Note.');
  assert.equal(exportAnswer(answer, citations, { links: 'wiki' }), 'Read [[Alpha draft]] and [Page](https://p.example/) plus [[Note]].');
  assert.equal(exportAnswer('Gone [[a]].', citations, { links: 'wiki', isItem: () => false }), 'Gone [Alpha draft](https://a.example/).');
});

test('error kinds come from the engine code or its message', () => {
  assert.equal(classifyError({ code: 'rate_limit', message: 'x' }), 'rate_limit');
  assert.equal(classifyError({ code: 'error', message: 'Allow Still to reach api.openai.com.' }), 'permission', 'the generic code falls back to the message');
  assert.equal(classifyError({ message: 'Stopped' }), 'aborted');
  assert.equal(classifyError({ aborted: true }), 'aborted');
  assert.equal(classifyError({ message: 'Allow Still to reach api.anthropic.com.' }), 'permission');
  assert.equal(classifyError({ message: 'Allow Still to reach localhost:11434 to use this connection.' }), 'permission');
  assert.equal(classifyError({ message: 'Check the API key. Anthropic did not accept it.' }), 'auth');
  assert.equal(classifyError({ message: 'Add your OpenAI API key in AI settings.' }), 'auth');
  assert.equal(classifyError({ message: 'Connect an AI provider in Settings.' }), 'no_connection');
  assert.equal(classifyError({ message: 'Rate limited by Anthropic. Wait a moment and try again.' }), 'rate_limit');
  assert.equal(classifyError({ message: 'Anthropic is having trouble right now (HTTP 529). Try again in a moment.' }), 'provider_down');
  assert.equal(classifyError({ message: 'Ollama blocked the request. Start Ollama with OLLAMA_ORIGINS=chrome-extension://* and try again.' }), 'origin_blocked');
  assert.equal(classifyError({ message: 'Anthropic could not find the model x. Pick another model in AI settings.' }), 'not_found');
  assert.equal(classifyError({ message: 'The model declined to answer this request.' }), 'refusal');
  assert.equal(classifyError({ message: 'Something odd' }), 'other');
});

const proposal = {
  id: 'p1',
  changes: [
    { op: 'create_collection', label: 'Create collection Travel › Japan', itemIds: [], count: 0, collectionId: 'c-new' },
    { op: 'move_items', label: 'Move 3 items to Travel › Japan', itemIds: ['a', 'b', 'c'], count: 3, collectionId: 'c-new', items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    { op: 'add_tags', label: 'Add tag #japan to 2 items', itemIds: ['a', 'b'], count: 2, tags: ['japan'], items: [{ id: 'a' }, { id: 'b' }] },
    { op: 'remove_tags', label: 'Remove tag #old from 1 item', itemIds: ['a'], count: 1, tags: ['OLD'], items: [{ id: 'a' }] },
    { op: 'trash_items', label: 'Move 1 item to Trash', itemIds: ['d'], count: 1, items: [{ id: 'd' }] },
  ],
};

test('applied lines use the past tense and leave out excluded items', () => {
  assert.deepEqual(appliedLines(proposal), ['Created collection Travel › Japan', 'Moved 3 items to Travel › Japan', 'Added tag #japan to 2 items',
    'Removed tag #old from 1 item', 'Moved 1 item to Trash']);
  const excluded = new Map([[1, new Set(['b', 'c'])], [4, new Set(['d'])]]);
  assert.deepEqual(appliedLines(proposal, excluded), ['Created collection Travel › Japan', 'Moved 1 item to Travel › Japan', 'Added tag #japan to 2 items',
    'Removed tag #old from 1 item'], 'a change with nothing left is dropped');
});

test('exclusion patches restore only what the excluded changes touched', () => {
  const before = new Map([
    ['a', { id: 'a', collectionId: '', tags: ['old', 'keep'], favorite: false }],
    ['b', { id: 'b', collectionId: 'reading', tags: [] }],
    ['d', { id: 'd', collectionId: '', tags: [], deletedAt: null }],
  ]);
  const excluded = new Map([[1, new Set(['b'])], [3, new Set(['a'])], [4, new Set(['d'])]]);
  const patches = exclusionPatches(proposal, excluded, before);
  assert.deepEqual(patches.find(entry => entry.id === 'b').patch, { collectionId: 'reading' }, 'b stays where it was but keeps the new tag');
  assert.deepEqual(patches.find(entry => entry.id === 'a').patch, { tags: ['old', 'keep', 'japan'] }, 'a keeps the added tag and its old one');
  assert.deepEqual(patches.find(entry => entry.id === 'd').patch, { deletedAt: null });
  assert.deepEqual(exclusionPatches(proposal, new Map(), before), []);
  assert.deepEqual(exclusionPatches(proposal, new Map([[1, new Set(['missing'])]]), before), [], 'unknown items are skipped');
});

test('history groups by last activity', () => {
  const now = new Date(2026, 9, 28, 15, 0, 0);
  const at = (days, hours = 0) => new Date(2026, 9, 28 - days, 12 + hours).toISOString();
  const groups = historyGroups([
    { id: '1', updatedAt: at(0) }, { id: '2', updatedAt: at(1) }, { id: '3', updatedAt: at(3) }, { id: '4', updatedAt: at(20) }, { id: '5', updatedAt: at(90) }, { id: '6', updatedAt: 'nope' },
  ], now);
  assert.deepEqual(groups.map(group => [group.label, group.items.map(entry => entry.id)]),
    [['Today', ['1']], ['Yesterday', ['2']], ['Previous 7 days', ['3']], ['Previous 30 days', ['4']], ['Older', ['5', '6']]]);
});

test('model labels and durations', () => {
  assert.equal(shortModelLabel('Claude Opus 5.5'), 'Opus 5.5');
  assert.equal(shortModelLabel('GPT-6.1 Sol'), 'GPT-6.1 Sol');
  assert.equal(shortModelLabel(''), 'Model');
  assert.equal(formatDuration(400), '1s');
  assert.equal(formatDuration(6200), '6s');
  assert.equal(formatDuration(65000), '1m 5s');
  assert.equal(MAX_QUESTION, 32000, 'matches the engine limit');
});
