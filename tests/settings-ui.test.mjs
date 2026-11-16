import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFiltered, isSearching, group, card, row, switchRow, blockRow, searchable, resetIds, providerMark } from '../extension/ui/settings/parts.js';
import { searchTerms } from '../extension/ui/settings/catalog.js';
import { appearanceValues, themePreviewStyle, ACCENTS } from '../extension/ui/settings/appearance.js';
import { wallpaperUrl, cssUrl, hexColor, START_PAGES, SEARCH_ENGINES } from '../extension/ui/settings/newtab.js';
import { THEMES, themeById } from '../extension/ui/themes.js';
import { NEWTAB_DEFAULTS } from '../extension/lib/settings-schema.js';

const flat = value => String(value).replace(/\s+/g, ' ');

const sample = () => [
  group({ title: 'Saving', body: () => card([
    row({ label: 'Default collection', description: 'Where new links go.', control: '<select></select>' }),
    switchRow({ label: 'Open the side panel after saving', description: 'Shows the saved page.', checked: true, action: 'x' }),
  ]) }),
  group({ title: 'Look', keywords: 'theme', body: () => card([
    row({ label: 'Text size', keywords: 'font zoom', description: 'Scales text.' }),
    blockRow({ label: 'Corners', description: 'Rounded or sharp.', body: '<div>tiles</div>' }),
  ]) }),
].join('');

test('outside search every row renders; group headings get stable, unique ids', () => {
  resetIds();
  const out = flat(sample());
  assert.ok(!isSearching());
  for (const label of ['Default collection', 'Open the side panel after saving', 'Text size', 'Corners']) assert.ok(out.includes(label), label);
  assert.match(out, /id="settings-group-saving"/);
  assert.match(out, /aria-labelledby="settings-group-saving"/);
  resetIds();
  const twice = flat(group({ title: 'Local bridge', body: 'a' })) + flat(group({ title: 'Local bridge', body: 'b' }));
  assert.match(twice, /settings-group-local-bridge"/);
  assert.match(twice, /settings-group-local-bridge-2"/);
});

test('search keeps matching rows and drops empty cards and groups', () => {
  const { content, hits } = renderFiltered(searchTerms('font'), ['Appearance'], () => sample());
  const out = flat(content);
  assert.equal(hits, 1);
  assert.ok(out.includes('Text size'));
  assert.ok(!out.includes('Default collection'));
  assert.ok(!out.includes('Saving'), 'a group with no matches is removed');
  assert.ok(!isSearching(), 'search state is restored afterwards');
});

test('a group title (or section) matching the query keeps all of its rows', () => {
  const byGroup = flat(renderFiltered(searchTerms('saving'), ['General'], () => sample()).content);
  assert.ok(byGroup.includes('Default collection') && byGroup.includes('Open the side panel after saving'));
  assert.ok(!byGroup.includes('Text size'));
  const bySection = renderFiltered(searchTerms('general'), ['General'], () => sample());
  assert.equal(bySection.hits, 4);
});

test('no matches renders nothing at all', () => {
  const result = renderFiltered(searchTerms('qqzz'), ['General'], () => sample());
  assert.equal(result.content, '');
  assert.equal(result.hits, 0);
});

test('searchable blocks take part as one unit', () => {
  const block = () => searchable(['Raindrop.io', 'token'], '<div>raindrop form</div>');
  assert.equal(String(block()), '<div>raindrop form</div>');
  assert.equal(renderFiltered(searchTerms('token'), [], block).content, '<div>raindrop form</div>');
  assert.equal(renderFiltered(searchTerms('github'), [], block).content, '');
});

test('provider marks fall back to the given icon or letter', () => {
  assert.match(flat(providerMark('anthropic', 32)), /data-color="orange"[^>]*>A</);
  assert.match(flat(providerMark('unknown', 36, { icon: 'github' })), /<svg/);
  assert.match(flat(providerMark('unknown', 32, { text: 'Z', color: 'teal' })), /data-color="teal"[^>]*>Z</);
});

test('appearance values fill defaults and normalize the accent and theme', () => {
  const a = appearanceValues({});
  assert.equal(a.skin, 'still');
  assert.equal(a.theme, 'system');
  assert.equal(a.accent, 'blue');
  assert.equal(a.fontSize, 'md');
  assert.equal(appearanceValues({ accent: 'amber' }).accent, 'gold');
  assert.equal(appearanceValues({ accent: 'violet' }).accent, 'blue');
  assert.equal(appearanceValues({ skin: 'nope' }).skin, 'still');
  assert.equal(appearanceValues({ theme: 'sepia' }).theme, 'system');
  assert.ok(ACCENTS.every(entry => entry.id && entry.label));
});

test('theme previews paint each theme in the mode it would use', () => {
  for (const theme of THEMES) {
    for (const mode of theme.modes) {
      const style = themePreviewStyle(theme, mode);
      const [bg, , accent] = theme.swatches[mode];
      assert.ok(style.includes(`--tp-bg:${bg}`), `${theme.id} ${mode} background`);
      assert.ok(style.includes(`--tp-accent:${accent}`), `${theme.id} ${mode} accent`);
    }
  }
  assert.ok(themePreviewStyle(themeById('glass'), 'dark').includes('--tp-wallpaper:'), 'glass shows its ambient wallpaper');
  // A single-mode theme asked for the other mode falls back to its own.
  assert.ok(themePreviewStyle(themeById('midnight'), 'light').includes('--tp-bg:#000000'));
});

test('wallpaper addresses must be https; CSS urls are quoted and escaped', () => {
  assert.equal(wallpaperUrl(' https://images.example.com/a b.jpg '), 'https://images.example.com/a%20b.jpg');
  assert.equal(wallpaperUrl('http://example.com/a.jpg'), '');
  assert.equal(wallpaperUrl('javascript:alert(1)'), '');
  assert.equal(wallpaperUrl('data:image/png;base64,AAAA'), '');
  assert.equal(wallpaperUrl('not a url'), '');
  assert.equal(cssUrl('https://a.example/x.jpg'), 'url("https://a.example/x.jpg")');
  assert.equal(cssUrl('blob:chrome-extension://id/uuid'), 'url("blob:chrome-extension://id/uuid")');
  assert.ok(!/[^\\]"\)/.test(cssUrl('https://a.example/x").jpg').slice(0, -2)), 'quotes cannot close the url');
  assert.equal(hexColor('#1F2A44'), '#1f2a44');
  assert.equal(hexColor('#123'), '');
  assert.equal(hexColor('red'), '');
});

test('start pages and engines cover the schema values', () => {
  assert.ok(START_PAGES.some(page => page.value === NEWTAB_DEFAULTS.view));
  assert.ok(SEARCH_ENGINES.some(engine => engine.value === NEWTAB_DEFAULTS.engine));
  assert.deepEqual(START_PAGES.map(page => page.value), ['dashboard', 'all', 'inbox', 'notes', 'assistant']);
  assert.deepEqual(SEARCH_ENGINES.map(engine => engine.value), ['default', 'google', 'duckduckgo', 'bing', 'kagi', 'perplexity', 'brave']);
});

/* ------------------------------------------------------------------ Library & backup */

const { renderLibrarySection, loadSnapshots, importReport, snapshotDetails, dayDockReport } = await import('../extension/ui/settings.js');
const { createSnapshot } = await import('../extension/lib/storage/snapshots.js');
const libraryCtx = (open = []) => ({ library: { items: [], collections: [], settings: {} }, select: { counts: () => ({ trash: 0 }) }, env: { isExtension: false },
  state: { settings: { section: 'library', list: false, query: '', open: new Set(open) } }, render() {} });

test('Library & backup offers every export and says what a full backup holds and where snapshots live', () => {
  resetIds();
  const out = flat(renderLibrarySection(libraryCtx()));
  for (const action of ['settings.backup', 'settings.import-choose', 'settings.export-html', 'settings.export-notes', 'settings.export-csv', 'settings.export-chats', 'settings.snapshot-create']) {
    assert.ok(out.includes(`data-action="${action}"`), action);
  }
  assert.match(out, /settings and wallpaper, dashboards and widgets, assistant chats and AI connections/);
  assert.match(out, /API keys, account tokens and passwords are never included/);
  assert.match(out, /Automatic snapshots/);
  assert.match(out, /stay on this device only: removing Still or clearing its data deletes them, so keep a downloaded full backup somewhere else too/);
  assert.match(out, /Loading snapshots/, 'before the list arrives');
});

test('Library & backup starts with Move to DayDock: one export, a link to the import page and what is never written', () => {
  resetIds();
  const out = flat(renderLibrarySection(libraryCtx()));
  assert.ok(out.indexOf('>Move to DayDock<') >= 0 && out.indexOf('>Move to DayDock<') < out.indexOf('>Backup<'), 'the group comes first');
  assert.match(out, /DayDock is the online home for your library\. Export everything DayDock can import into one file, then choose it on DayDock&#39;s import page\./);
  assert.match(out, /<button type="button" class="btn btn-primary btn-sm" data-action="settings\.daydock-export"[^>]*>.*?<span class="btn-label">Export for DayDock<\/span>/);
  assert.match(out, /<a class="btn btn-secondary btn-sm" href="https:\/\/daydock\.tech\/library\/import" target="_blank" rel="noopener noreferrer"><span class="btn-label">Open DayDock import<\/span>/);
  assert.match(out, /<p class="settings-note">.*?Nothing is uploaded by this step\. The API keys, passwords and connected accounts set up in Still are never written to the file\. Everything you saved is written as it is, so review it before you import it anywhere\.<\/span><\/p>/);
  assert.ok(!out.includes('settings.daydock-dismiss'), 'no status before an export');
  // Search finds the row by any of its words and drops the note and the other groups.
  for (const query of ['daydock', 'migrate', 'transfer']) {
    const found = renderFiltered(searchTerms(query), [], () => renderLibrarySection(libraryCtx()));
    assert.equal(found.hits, 1, query);
    assert.match(flat(found.content), /settings\.daydock-export/);
    assert.ok(!flat(found.content).includes('Nothing is uploaded') && !flat(found.content).includes('settings.backup'), query);
  }
});

test('the DayDock export report says what is in the file, what stays here, any warnings and the next step', () => {
  const summary = { saves: 5, notes: 2, collections: 2, highlights: 3, boards: 2, widgets: 3, files: 1, fileBytes: 2048, trash: 2, deleted: 2, warnings: [],
    left: ['1 assistant conversation', 'settings and wallpaper', 'connected accounts and API keys'] };
  const report = dayDockReport(summary, 'still-for-daydock-2026-11-13.json');
  assert.equal(report.title, 'Export for DayDock downloaded');
  assert.deepEqual(report.lines, ['In the file: 5 saves, 2 notes, 2 collections, 3 highlights, 2 dashboards with 3 widgets, 1 file (2.0 KB).',
    '2 items in Trash are in the file and stay in Trash.',
    'Stays in this extension: 1 assistant conversation, settings and wallpaper, connected accounts and API keys.',
    'Next, choose still-for-daydock-2026-11-13.json on DayDock\'s import page.']);
  assert.equal(report.summary, 'Export for DayDock downloaded: 5 saves, 2 notes, 2 collections, 3 highlights, 2 dashboards with 3 widgets, 1 file (2.0 KB)');
  const tight = dayDockReport({ ...summary, trash: 1, files: 0, fileBytes: 0, warnings: ['1 file did not fit: a backup can hold up to 200 MB. Download the largest files from your library to keep a copy.'] }, 'x.json');
  assert.equal(tight.title, 'Export for DayDock downloaded, with these notes');
  assert.equal(tight.lines[1], '1 item in Trash is in the file and stays in Trash.');
  assert.match(tight.lines[3], /1 file did not fit/);
  assert.equal(tight.lines.at(-1), 'Next, choose x.json on DayDock\'s import page.');
  const empty = dayDockReport({ saves: 0, notes: 0, collections: 0, highlights: 0, boards: 0, widgets: 0, files: 0, fileBytes: 0, trash: 0, warnings: [], left: [] });
  assert.deepEqual(empty.lines, ['This library is empty, so the file has nothing to import.', 'Next, choose the file on DayDock\'s import page.']);
  assert.equal(empty.summary, 'Export for DayDock downloaded');
  // Sentence case, straight quotes, no em dashes.
  for (const text of [report.title, tight.title, ...report.lines, ...empty.lines]) assert.ok(!/[\u2014\u2018\u2019\u201c\u201d]/.test(text), text);
});

test('the snapshot list shows date, kind, contents, Restore and Delete, newest five first', async () => {
  await loadSnapshots();
  assert.match(flat(renderLibrarySection(libraryCtx())), /No snapshots yet/);
  for (let index = 0; index < 7; index++) await createSnapshot('manual');
  await loadSnapshots();
  resetIds();
  const out = flat(renderLibrarySection(libraryCtx()));
  assert.equal(out.match(/data-action="settings\.snapshot-restore"/g).length, 5);
  assert.equal(out.match(/data-action="settings\.snapshot-delete"/g).length, 5);
  assert.match(out, /data-tone="accent"[^>]*>Manual</);
  assert.match(out, /Taken by you · 0 items, 0 collections, 0 dashboards, 0 chats/);
  assert.match(out, /Show 2 older snapshots/);
  assert.match(out, /data-id="snapshot_[\w-]+"/);
  assert.ok(!out.includes('id="settings-more-snapshots"'), 'older snapshots stay folded');
  assert.match(out, /aria-controls="settings-more-snapshots"/);
  resetIds();
  const open = flat(renderLibrarySection(libraryCtx(['snapshots'])));
  assert.equal(open.match(/data-action="settings\.snapshot-restore"/g).length, 7);
  assert.match(open, /id="settings-more-snapshots"/);
  assert.match(open, /Show fewer snapshots/);
});

test('snapshot details name the reason and what the snapshot holds', () => {
  const counts = { items: 12, collections: 1, notes: 3, boards: 2, conversations: 1 };
  assert.equal(snapshotDetails({ reason: 'update', extensionVersion: '0.5.0', previousVersion: '0.4.0', counts, bytes: 2048 }),
    'Still updated from 0.4.0 to 0.5.0 · 12 items, 1 collection, 2 dashboards, 1 chat · 2.0 KB');
  assert.equal(snapshotDetails({ reason: 'before-import', extensionVersion: '0.5.0', counts }), 'Taken before an import · Still 0.5.0 · 12 items, 1 collection, 2 dashboards, 1 chat');
  assert.match(snapshotDetails({ reason: 'daily', counts: {} }), /^Daily copy · 0 items/);
});

test('the import report says what came back, what was kept and how to go back', () => {
  const report = importReport({ items: 4, files: 1, warnings: [], notes: ['1 AI connection came back without its API key. Add it again in AI models.'], settings: true, boards: 2,
    conversations: { added: 3, updated: 1, skipped: 0 }, aiConnections: 1, snapshotId: 'snapshot_1',
    library: { items: { added: 3, updated: 1, kept: 2, tombstoned: 1 } } }, 'still-backup.json');
  assert.equal(report.title, 'Brought in still-backup.json');
  assert.deepEqual(report.lines, ['3 items added.', '1 item updated to the file’s newer copy.', '2 items already here kept as they are: this device’s copy is the same or newer.',
    '1 item you deleted forever stayed deleted.', '1 file restored.', 'Settings restored.', '2 dashboards restored.', '4 assistant chats restored.', '1 AI connection added.']);
  assert.match(report.notes.join(' '), /API key.*Automatic snapshots/);
  assert.equal(report.summary, 'Brought in 4 items, 1 file, 2 dashboards, 4 chats');
  assert.deepEqual(importReport({ items: 2, warnings: [] }, 'links.csv').lines, ['2 items added.']);
  assert.deepEqual(importReport({ items: 0, library: { items: { added: 0, updated: 0, kept: 0, tombstoned: 0 } } }).lines, ['Nothing new: everything in the file is already here.']);
});
