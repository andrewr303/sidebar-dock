import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_SECTIONS, SETTINGS_GROUPS, normalizeSection, isSection, sectionById, sectionFromView, settingsView, groupSections, adjacentSections,
  textOf, searchTerms, matchesTerms, matchSections,
} from '../extension/ui/settings/catalog.js';

test('every section has a known group, an icon and copy, and ids are unique', () => {
  const groups = new Set(SETTINGS_GROUPS.map(group => group.id));
  const ids = SETTINGS_SECTIONS.map(section => section.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const section of SETTINGS_SECTIONS) {
    assert.ok(groups.has(section.group), `${section.id} has a known group`);
    assert.ok(section.icon && section.label && section.summary && section.description, `${section.id} has copy`);
  }
  // The brief's navigation: Personalize · Library · AI · Connections · Help.
  assert.deepEqual(groupSections().map(group => [group.label, group.sections.map(s => s.id)]), [
    ['Personalize', ['appearance', 'newtab']],
    ['Library', ['general', 'library']],
    ['AI', ['ai', 'assistant', 'research', 'search', 'agents']],
    ['Connections', ['accounts', 'integrations']],
    ['Help', ['shortcuts', 'about', 'help']],
  ]);
});

test('sections normalize from ids, aliases and views', () => {
  assert.equal(normalizeSection('appearance'), 'appearance');
  assert.equal(normalizeSection('THEME'), 'appearance');
  assert.equal(normalizeSection('new-tab'), 'newtab');
  assert.equal(normalizeSection('backup'), 'library');
  assert.equal(normalizeSection('nope'), 'general');
  assert.equal(normalizeSection('nope', ''), '');
  assert.equal(normalizeSection(undefined), 'general');
  assert.ok(isSection('accounts'));
  assert.ok(!isSection('theme'));
  assert.equal(sectionById('ai').label, 'AI models');
  assert.equal(normalizeSection('permissions'), 'assistant');
  assert.equal(sectionById('assistant').label, 'Assistant permissions');
  assert.equal(sectionById('research').label, 'Research agent');
  assert.equal(sectionFromView('settings:research'), 'research');
  assert.equal(sectionById('missing'), null);

  assert.equal(sectionFromView('settings:newtab'), 'newtab');
  assert.equal(sectionFromView('settings:wallpaper'), 'newtab');
  assert.equal(sectionFromView('settings'), '');
  assert.equal(sectionFromView('settings:unknown'), '');
  assert.equal(sectionFromView('all'), '');
  assert.equal(settingsView('theme'), 'settings:appearance');
  assert.equal(settingsView('whatever'), 'settings:general');
});

test('groupSections keeps only the requested sections and drops empty groups', () => {
  const groups = groupSections(['ai', 'help']);
  assert.deepEqual(groups.map(group => group.id), ['ai', 'help']);
  assert.deepEqual(groups.flatMap(group => group.sections.map(s => s.id)), ['ai', 'help']);
  assert.deepEqual(groupSections([]), []);
});

test('adjacent sections follow navigation order', () => {
  assert.equal(adjacentSections('appearance').previous, null);
  assert.equal(adjacentSections('appearance').next.id, 'newtab');
  assert.equal(adjacentSections('accounts').previous.id, 'agents');
  assert.equal(adjacentSections('help').next, null);
  assert.deepEqual(adjacentSections('missing'), { previous: null, next: null });
});

test('textOf flattens fragments, entities and accents for matching', () => {
  assert.equal(textOf('<span class="x">Raindrop.io</span> <b>Connected</b>'), 'raindrop.io connected');
  assert.equal(textOf('Rosé &amp; Nord'), 'rose & nord');
  assert.equal(textOf(['Chrome’s', null, false, ['zoom']]), "chrome's zoom");
  assert.equal(textOf({ toString: () => '<i>Fragment</i>' }), 'fragment');
  assert.equal(textOf(undefined), '');
});

test('search terms are lower-case words without duplicates; every term must match', () => {
  assert.deepEqual(searchTerms('  Font  SIZE font '), ['font', 'size']);
  assert.deepEqual(searchTerms(''), []);
  assert.equal(searchTerms('a b c d e f g h i j').length, 8);
  assert.ok(matchesTerms([], 'anything'));
  assert.ok(matchesTerms(searchTerms('text size'), 'Text size', 'Scales text'));
  assert.ok(matchesTerms(searchTerms('rose'), 'Rosé', 'Soft pinks'));
  assert.ok(!matchesTerms(searchTerms('text color'), 'Text size'));
  // Context (section and group titles) counts too.
  assert.ok(matchesTerms(searchTerms('appearance density'), 'Appearance', 'Density'));
});

test('matchSections finds sections by name, summary and keywords', () => {
  // GitHub is a connected account, and the research agent can search it.
  assert.deepEqual(matchSections('github').map(s => s.id), ['research', 'accounts']);
  assert.ok(matchSections('wallpaper').some(s => s.id === 'newtab'));
  assert.ok(matchSections('dark mode').some(s => s.id === 'appearance'));
  assert.ok(matchSections('backup').some(s => s.id === 'library'));
  // Automatic snapshots and the chat/CSV exports live in Library & backup.
  for (const query of ['snapshot', 'rollback', 'chats', 'spreadsheet']) assert.ok(matchSections(query).some(s => s.id === 'library'), query);
  // Assistant permissions and the research agent (contracts §8).
  for (const query of ['permissions', 'approval', 'auto apply', 'trusted', 'full access', 'links folders']) assert.ok(matchSections(query).some(s => s.id === 'assistant'), query);
  for (const query of ['research', 'managed agents', 'spending cap', 'subpages', 'sonnet']) assert.ok(matchSections(query).some(s => s.id === 'research'), query);
  assert.equal(matchSections('').length, SETTINGS_SECTIONS.length);
  assert.deepEqual(matchSections('qqqzzz'), []);
});
