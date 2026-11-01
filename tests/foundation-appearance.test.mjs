import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appearanceAttributes, appearanceSnapshot, appearanceChanged, wallpaperStyle, wallpaperActive, cssUrl, modePreference } from '../extension/ui/appearance.js';
import { bootView, startView, documentTitle, isMainView, ownsHeader } from '../extension/ui/routes.js';
import { WALLPAPER_PRESETS } from '../extension/ui/themes.js';
import { COMMANDS, rankCommands } from '../extension/ui/command.js';

const ATTRIBUTES = ['data-skin', 'data-theme', 'data-accent', 'data-density', 'data-font-size', 'data-radius', 'data-motion', 'data-transparency',
  'data-sidebar-width', 'data-wallpaper', 'data-wallpaper-scope'];

test('appearanceAttributes fills every attribute with defaults and resolves the system mode', () => {
  const light = appearanceAttributes({});
  assert.deepEqual(Object.keys(light).sort(), [...ATTRIBUTES].sort());
  assert.deepEqual(light, {
    'data-skin': 'still', 'data-theme': 'light', 'data-accent': 'blue', 'data-density': 'comfortable', 'data-font-size': 'md',
    'data-radius': 'default', 'data-motion': 'system', 'data-transparency': 'full', 'data-sidebar-width': 'default',
    'data-wallpaper': 'off', 'data-wallpaper-scope': 'dashboard',
  });
  assert.equal(appearanceAttributes({}, { prefersDark: true })['data-theme'], 'dark');
  assert.equal(appearanceAttributes({ theme: 'light' }, { prefersDark: true })['data-theme'], 'light', 'an explicit mode beats the system');
  const custom = appearanceAttributes({ skin: 'nord', theme: 'dark', accent: 'teal', density: 'compact', fontSize: 'xl', radius: 'round', motion: 'reduced',
    transparency: 'reduced', sidebarWidth: 'wide' });
  assert.equal(custom['data-skin'], 'nord');
  assert.equal(custom['data-theme'], 'dark');
  assert.equal(custom['data-accent'], 'teal');
  assert.equal(custom['data-density'], 'compact');
  assert.equal(custom['data-font-size'], 'xl');
  assert.equal(custom['data-radius'], 'round');
  assert.equal(custom['data-motion'], 'reduced');
  assert.equal(custom['data-transparency'], 'reduced');
  assert.equal(custom['data-sidebar-width'], 'wide');
});

test('appearanceAttributes rejects unknown values and honors single-mode skins', () => {
  const odd = appearanceAttributes({ skin: 'neon', accent: 'violet', fontSize: 'huge', radius: 3, density: 'airy', sidebarWidth: 'xl', motion: 'off' });
  assert.equal(odd['data-skin'], 'still');
  assert.equal(odd['data-accent'], 'blue', 'violet is the retired name of the default accent');
  assert.equal(odd['data-font-size'], 'md');
  assert.equal(odd['data-radius'], 'default');
  assert.equal(odd['data-density'], 'comfortable');
  assert.equal(odd['data-sidebar-width'], 'default');
  assert.equal(odd['data-motion'], 'system');
  assert.equal(appearanceAttributes({ accent: 'x" onload="1' })['data-accent'], 'blue', 'accents are plain words');
  assert.equal(appearanceAttributes({ skin: 'white', theme: 'dark' }, { prefersDark: true })['data-theme'], 'light');
  assert.equal(appearanceAttributes({ skin: 'midnight', theme: 'light' })['data-theme'], 'dark');
  assert.equal(modePreference({ skin: 'midnight', theme: 'light' }), 'dark');
  assert.equal(modePreference({ skin: 'white' }), 'light');
  assert.equal(modePreference({ skin: 'nord' }), 'system');
  assert.equal(modePreference({ skin: 'nord', theme: 'dark' }), 'dark');
});

test('wallpaper scope and state: glass always paints behind the app and draws its own ambient background', () => {
  assert.equal(appearanceAttributes({ wallpaper: { kind: 'preset', preset: 'lagoon' } })['data-wallpaper'], 'on');
  assert.equal(appearanceAttributes({ wallpaper: { kind: 'preset' } })['data-wallpaper-scope'], 'dashboard');
  assert.equal(appearanceAttributes({ wallpaper: { kind: 'preset', scope: 'app' } })['data-wallpaper-scope'], 'app');
  const glass = appearanceAttributes({ skin: 'glass' });
  assert.equal(glass['data-wallpaper'], 'off', 'no wallpaper chosen: skins.css draws the glass ambient background');
  assert.equal(glass['data-wallpaper-scope'], 'app');
  assert.equal(appearanceAttributes({ skin: 'glass', wallpaper: { kind: 'color', color: '#203040', scope: 'dashboard' } })['data-wallpaper-scope'], 'app');
  assert.equal(wallpaperActive({ kind: 'none' }), false);
  assert.equal(wallpaperActive({ kind: 'color', color: 'red' }), false, 'only hex colors');
  assert.equal(wallpaperActive({ kind: 'color', color: '#abc' }), true);
  assert.equal(wallpaperActive({ kind: 'url', url: 'http://example.com/a.jpg' }), false, 'only https');
  assert.equal(wallpaperActive({ kind: 'url', url: 'https://example.com/a.jpg' }), true);
  assert.equal(wallpaperActive({ kind: 'image', attachmentId: '' }), false);
  assert.equal(wallpaperActive({ kind: 'image', attachmentId: 'file_1' }), true);
});

test('wallpaperStyle builds the layer CSS for presets, colors and URLs and clamps dim and blur', () => {
  const aurora = WALLPAPER_PRESETS.find(p => p.id === 'aurora');
  assert.equal(wallpaperStyle({ kind: 'preset', preset: 'aurora' }, 'light').image, aurora.css);
  assert.equal(wallpaperStyle({ kind: 'preset', preset: 'aurora' }, 'dark').image, aurora.dark, 'dark mode uses the dark variant');
  assert.equal(wallpaperStyle({ kind: 'preset', preset: 'missing' }, 'light').image, WALLPAPER_PRESETS[0].css, 'unknown presets fall back to the first');
  assert.equal(wallpaperStyle({ kind: 'color', color: '#1f2a44' }).image, 'linear-gradient(#1f2a44, #1f2a44)');
  assert.equal(wallpaperStyle({ kind: 'color', color: 'url(x)' }).image, '');
  assert.equal(wallpaperStyle({ kind: 'url', url: 'https://images.example.com/a b.jpg' }).image, 'url("https://images.example.com/a%20b.jpg")');
  assert.equal(wallpaperStyle({ kind: 'url', url: 'javascript:alert(1)' }).image, '');
  assert.equal(wallpaperStyle({ kind: 'url', url: 'https://user:pw@example.com/a.jpg' }).image, '', 'no credentials in addresses');
  assert.equal(wallpaperStyle({ kind: 'none' }).image, '');
  assert.deepEqual(wallpaperStyle({ kind: 'image', attachmentId: 'file_9', dim: 40, blur: 12 }), { image: '', dim: 0.4, blur: 12, attachmentId: 'file_9' });
  const clamped = wallpaperStyle({ kind: 'preset', dim: 300, blur: -5 });
  assert.equal(clamped.dim, 0.8);
  assert.equal(clamped.blur, 0);
  assert.equal(wallpaperStyle({ kind: 'preset', dim: 'x', blur: 99 }).blur, 40);
});

test('cssUrl keeps addresses inside a quoted url()', () => {
  assert.equal(cssUrl('https://example.com/a.jpg'), 'url("https://example.com/a.jpg")');
  const tricky = cssUrl('https://example.com/a".jpg);background:red');
  assert.ok(tricky.startsWith('url("https://example.com/') && tricky.endsWith('")'));
  assert.doesNotMatch(tricky.slice(5, -2), /["\\]/, 'no raw quote or backslash survives inside the string');
  assert.equal(cssUrl('not a url'), '');
  assert.equal(cssUrl('data:image/png;base64,AAAA'), '');
});

test('appearanceSnapshot caches attributes, the mode preference and both wallpaper variants, never object URLs', () => {
  const snap = appearanceSnapshot({ skin: 'paper', theme: 'system', fontSize: 'lg', wallpaper: { kind: 'preset', preset: 'dusk', dim: 20, blur: 6 } });
  assert.equal(snap.theme, 'system');
  assert.equal(snap.attrs['data-skin'], 'paper');
  assert.equal(snap.attrs['data-font-size'], 'lg');
  assert.equal(snap.attrs['data-wallpaper'], 'on');
  assert.equal('data-theme' in snap.attrs, false, 'the mode is resolved at boot from the preference');
  const dusk = WALLPAPER_PRESETS.find(p => p.id === 'dusk');
  assert.deepEqual(snap.wallpaper, { light: dusk.css, dark: dusk.dark, dim: 0.2, blur: 6, attachmentId: '' });
  const image = appearanceSnapshot({ wallpaper: { kind: 'image', attachmentId: 'file_2' } });
  assert.deepEqual([image.wallpaper.light, image.wallpaper.dark, image.wallpaper.attachmentId], ['', '', 'file_2']);
  assert.doesNotMatch(JSON.stringify(image), /blob:/);
  assert.equal(appearanceSnapshot({ skin: 'midnight' }).theme, 'dark');
});

test('appearanceChanged notices appearance keys and the wallpaper group only', () => {
  assert.equal(appearanceChanged({ theme: 'dark' }, { theme: 'dark', aiModel: 'x' }), false);
  assert.equal(appearanceChanged({}, { skin: 'glass' }), true);
  assert.equal(appearanceChanged({ fontSize: 'md' }, { fontSize: 'lg' }), true);
  assert.equal(appearanceChanged({ wallpaper: { kind: 'preset', dim: 0 } }, { wallpaper: { kind: 'preset', dim: 10 } }), true);
  assert.equal(appearanceChanged({ newTab: { view: 'all' } }, { newTab: { view: 'notes' } }), false);
  assert.equal(appearanceChanged(undefined, {}), false);
});

test('startView and bootView choose where a page opens', () => {
  const params = query => new URLSearchParams(query);
  assert.equal(startView({}), 'dashboard', 'the dashboard is the default start page');
  assert.equal(startView({ newTab: { view: 'notes' } }), 'notes');
  assert.equal(startView({ newTab: { view: 'settings:appearance' } }), 'dashboard', 'settings are never a start page');
  assert.equal(startView({ newTab: { view: 'nonsense' } }), 'dashboard');
  assert.equal(startView({ newTab: { view: 'collection:c1' } }, { hasCollection: id => id === 'c1' }), 'collection:c1');
  assert.equal(startView({ newTab: { view: 'collection:gone' } }, { hasCollection: () => false }), 'dashboard');
  assert.equal(bootView(params(''), {}), 'dashboard', 'a bare index.html and the new tab open the start page');
  assert.equal(bootView(params(''), { newTab: { view: 'inbox' } }), 'inbox');
  assert.equal(bootView(params('libraryView=all'), {}), 'all', 'an explicit view wins');
  assert.equal(bootView(params('libraryView=settings:accounts'), {}), 'settings:accounts');
  assert.equal(bootView(params('libraryView=bogus<x>'), {}), 'dashboard');
  assert.equal(bootView(params('item=abc'), {}), 'all', 'an item address opens in the library');
  assert.equal(bootView(params('q=design'), {}), 'all');
  assert.equal(bootView(params('view=sidepanel'), { newTab: { view: 'notes' } }, { sidepanel: true }), 'all', 'the side panel ignores the start page');
  assert.equal(bootView(params('view=sidepanel&libraryView=tasks'), {}, { sidepanel: true }), 'tasks');
});

test('routes: main views, own-header views and tab titles', () => {
  for (const view of ['dashboard', 'assistant', 'stickies', 'settings', 'settings:newtab', 'all', 'collection:x', 'tag:a b', 'type:article']) assert.ok(isMainView(view), view);
  for (const view of ['', 'settings:', 'settings:Bad', 'dash', null]) assert.equal(isMainView(view), false, String(view));
  assert.ok(ownsHeader('dashboard') && ownsHeader('assistant') && ownsHeader('settings') && ownsHeader('settings:appearance'));
  assert.equal(ownsHeader('all') || ownsHeader('stickies') || ownsHeader('notes'), false);
  assert.equal(documentTitle({ newtab: true, label: 'Dashboard' }), 'New Tab', 'the new tab keeps Chrome’s name');
  assert.equal(documentTitle({ label: 'Inbox' }), 'Inbox · Still');
  assert.equal(documentTitle({ sidepanel: true, label: 'Inbox' }), 'Still');
  assert.equal(documentTitle({}), 'Still');
});

test('palette commands reach the new views and settings sections', () => {
  const label = command => (typeof command.label === 'function' ? 'Switch theme' : command.label);
  const byId = Object.fromEntries(COMMANDS.map(command => [command.id, command]));
  assert.equal(byId['go-dashboard'].view, 'dashboard');
  assert.equal(byId.assistant.view, 'assistant');
  assert.equal(byId['go-stickies'].view, 'stickies');
  assert.equal(byId['new-sticky'].action, 'stickies.new');
  assert.deepEqual([byId['add-widget'].view, byId['add-widget'].action], ['dashboard', 'dashboard.add-widget']);
  assert.equal(byId['edit-dashboard'].action, 'dashboard.edit');
  assert.deepEqual(['appearance', 'newtab', 'accounts'].map(id => byId[id].data.section), ['appearance', 'newtab', 'accounts']);
  assert.equal(rankCommands(COMMANDS, 'dashboard', label)[0].id, 'go-dashboard');
  assert.equal(rankCommands(COMMANDS, 'wallpaper', label)[0].id, 'newtab');
  assert.equal(rankCommands(COMMANDS, 'liquid glass', label)[0].id, 'appearance');
  assert.equal(rankCommands(COMMANDS, 'sticky', label)[0].id, 'go-stickies');
});

test('the new tab page mirrors index.html and the manifest overrides only the new tab', async () => {
  const root = new URL('../extension/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.deepEqual(manifest.chrome_url_overrides, { newtab: 'newtab.html' });
  for (const permission of ['favicon', 'search', 'declarativeNetRequestWithHostAccess']) assert.ok(manifest.permissions.includes(permission), permission);
  assert.ok(manifest.optional_permissions.includes('topSites'));
  assert.equal(manifest.permissions.includes('topSites'), false, 'most visited sites stay an optional grant');
  const assets = page => [...page.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*"([^"]+\.(?:js|css))"/g)].map(match => match[1]);
  const index = await readFile(new URL('index.html', root), 'utf8');
  const newtab = await readFile(new URL('newtab.html', root), 'utf8');
  assert.deepEqual(assets(newtab), assets(index));
  assert.match(newtab, /<html[^>]*data-entry="newtab"/);
  assert.match(newtab, /<title>New Tab<\/title>/);
  assert.doesNotMatch(index, /data-entry=/);
});
