import test from 'node:test';
import assert from 'node:assert/strict';
import { icon, hasIcon, iconNames, searchIcons, iconChoices, COLLECTION_ICONS, COLLECTION_ICON_GROUPS } from '../extension/ui/icons.js';
import { PACK_PATHS, PACK_KEYWORDS, PACK_GROUPS } from '../extension/ui/icon-pack.js';

const browse = COLLECTION_ICON_GROUPS.flatMap(([, names]) => names);

test('the collection picker offers hundreds of distinct, renderable icons', () => {
  assert.ok(browse.length >= 500, `only ${browse.length} icons to browse`);
  assert.equal(new Set(browse).size, browse.length, 'an icon is listed in two groups');
  for (const name of browse) assert.ok(hasIcon(name), `${name} has no shape`);
  assert.equal(COLLECTION_ICON_GROUPS[0][0], 'Suggested');
  assert.deepEqual(COLLECTION_ICON_GROUPS[0][1], COLLECTION_ICONS);
});

test('pack icons are plain 24px stroke markup with nothing executable', () => {
  assert.ok(Object.keys(PACK_PATHS).length >= 500);
  for (const [name, markup] of Object.entries(PACK_PATHS)) {
    assert.match(markup, /^<(path|circle|ellipse|rect|line|polyline|polygon|g)[ >]/, name);
    assert.doesNotMatch(markup, /<(script|foreignObject|use|image|defs|clipPath)|\son\w+=|href=|xmlns/i, name);
    assert.ok(PACK_KEYWORDS[name] !== undefined, `${name} has no keywords`);
  }
  for (const [, names] of PACK_GROUPS) for (const name of names) assert.ok(name in PACK_PATHS, name);
});

test('icon() renders pack icons instead of the unknown-icon fallback', () => {
  const svg = String(icon('piggy-bank', { size: 20 }));
  assert.match(svg, /width="20"/);
  assert.equal(svg.includes(PACK_PATHS['piggy-bank']), true);
  assert.ok(iconNames().includes('piggy-bank'));
});

test('search matches meaning, names and plurals, best match first', () => {
  const money = searchIcons('money');
  for (const name of ['wallet', 'banknote', 'coins']) assert.ok(money.includes(name), `money should find ${name}`);
  assert.equal(searchIcons('dog')[0], 'dog');
  assert.equal(searchIcons('map pin')[0], 'map-pin');
  assert.ok(searchIcons('books').includes('book'));
  assert.ok(searchIcons('food').includes('pizza'), 'suggested icons have keywords too');
  assert.deepEqual(searchIcons('zzzz-nothing'), []);
  assert.deepEqual(searchIcons('  '), []);
  assert.ok(searchIcons('a', 5).length <= 5);
});

test('choices browse every group, search into one section, and keep an unlisted current icon visible', () => {
  assert.equal(iconChoices(''), COLLECTION_ICON_GROUPS);
  assert.deepEqual(iconChoices('xyzzy'), []);
  const [[label, names]] = iconChoices('coffee');
  assert.equal(label, '');
  assert.equal(names[0], 'coffee');
  const unlisted = iconNames().find(name => !browse.includes(name));
  assert.ok(unlisted, 'some interface icons are not offered for collections');
  assert.equal(iconChoices('', unlisted)[0][1][0], unlisted);
  assert.equal(iconChoices('', 'not-an-icon'), COLLECTION_ICON_GROUPS);
});
