import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  button, iconButton, splitButton, checkbox, input, field, skeleton, cover, avatarTile, emptyState, colorVar, colorName,
  keyshortcuts, shortcutLabel, tooltipAttrs, highlightColor, HIGHLIGHT_COLORS, collectionIcon, favicon,
} from '../extension/ui/components.js';
import { COLLECTION_COLORS } from '../extension/ui/icons.js';

const flat = fragment => String(fragment).replace(/\s+/g, ' ');

test('shortcut helpers map mod to the platform key', () => {
  assert.equal(keyshortcuts('mod+shift+s', false), 'Control+Shift+S');
  assert.equal(keyshortcuts('mod+k', true), 'Meta+K');
  assert.equal(keyshortcuts('escape'), 'Escape');
  assert.equal(shortcutLabel('mod+enter', false), 'Ctrl+Enter');
  assert.equal(shortcutLabel('mod+enter', true), '⌘↵');
  assert.equal(flat(tooltipAttrs('Copy "link"', { placement: 'bottom end' })), 'data-tooltip="Copy &quot;link&quot;" data-tooltip-pos="bottom end"');
});

test('filled buttons move the shortcut into a tooltip; loading keeps the label and name', () => {
  const primary = flat(button({ label: 'Save', variant: 'primary', kbd: 'mod+enter' }));
  assert.ok(!primary.includes('class="kbd"'), 'no key caps inside a filled button');
  assert.match(primary, /aria-keyshortcuts="(Control|Meta)\+Enter"/);
  assert.match(primary, /data-tooltip="Save \(/);
  const secondary = flat(button({ label: 'Search', kbd: 'mod+k' }));
  assert.ok(secondary.includes('class="kbd"'), 'secondary buttons show key caps');
  assert.ok(!secondary.includes('data-tooltip'), 'labelled buttons need no tooltip');
  const loading = flat(button({ label: 'Save', icon: 'plus', variant: 'primary', loading: true }));
  assert.match(loading, /aria-busy="true" aria-disabled="true"/);
  assert.ok(loading.includes('<span class="btn-label">Save</span>') && loading.includes('class="spinner"') && loading.includes('<svg'), 'label, icon and spinner all render');
  assert.match(flat(button({ label: 'View', expanded: true })), /aria-expanded="true" aria-haspopup="true"/);
  assert.match(flat(splitButton({ label: 'Add', action: 'a', menuAction: 'b' })), /class="split-btn split-btn-primary"/);
});

test('icon buttons always carry a name and tooltip', () => {
  const out = flat(iconButton({ icon: 'x', label: 'Close', size: 'sm', tooltipPlacement: 'bottom', kbd: 'escape' }));
  assert.match(out, /aria-label="Close"/);
  assert.match(out, /data-tooltip="Close \(Escape\)" data-tooltip-pos="bottom"/);
  assert.match(out, /class="icon-btn icon-btn-sm"/);
});

test('fields wire errors to controls', () => {
  const out = flat(field({ label: 'URL', id: 'url', error: 'Enter a full address', control: input({ id: 'url', invalid: true, describedBy: 'url-error' }) }));
  assert.match(out, /class="field has-error"/);
  assert.match(out, /<label class="field-label" for="url">/);
  assert.match(out, /id="url-error"/);
  assert.match(out, /aria-invalid="true" aria-describedby="url-error"/);
  assert.match(flat(field({ label: 'Name', id: 'n', hint: 'Shown in lists', control: input({ id: 'n' }) })), /class="field-hint" id="n-hint"/);
  const box = flat(checkbox({ label: 'All', indeterminate: true }));
  assert.ok(box.includes('data-indeterminate') && !box.includes('aria-checked'), 'native checkbox state comes from the property, not aria-checked');
});

test('skeletons render their final geometry and stay hidden from assistive tech', () => {
  const out = flat(skeleton({ rows: 2, variant: 'row' }));
  assert.match(out, /^<div class="skeleton-group" aria-hidden="true">/);
  assert.equal(out.match(/class="skeleton skeleton-row"/g).length, 2);
  assert.equal(out.match(/skeleton-thumb/g).length, 2);
  assert.match(flat(skeleton({ rows: 1, variant: 'unknown' })), /skeleton skeleton-unknown"><span class="skeleton-bone skeleton-line">/);
});

test('covers without art become tinted tiles with a glyph, never an empty slab', () => {
  const tinted = flat(cover('', { icon: 'newspaper', color: 'blue' }));
  assert.match(tinted, /class="cover is-empty" data-color="blue"/);
  assert.ok(tinted.includes('<svg'));
  assert.match(flat(cover(null, { letter: 'raycast', color: '#123abc' })), /style="--tile:#123abc".*<span class="cover-letter">R<\/span>/);
  assert.match(flat(cover('javascript:alert(1)', { icon: 'image' })), /is-empty/, 'unsafe sources fall back');
  assert.match(flat(cover('https://example.com/a.png', { width: 64, height: 48 })), /<img src="https:\/\/example.com\/a.png" alt="" width="64" height="48" loading="lazy"/);
});

test('avatar tiles, collection icons and favicons map colors to palette tokens', () => {
  assert.match(flat(avatarTile({ label: 'Open AI', color: 'green' })), /data-color="green" style="--size:28px" aria-hidden="true">OA</);
  assert.match(flat(avatarTile({ label: 'x', color: '#e5484d' })), /data-color="red"/, 'legacy hex values map to names');
  assert.match(flat(collectionIcon({ icon: 'star', color: '#ABCDEF' })), /--tile:#abcdef/);
  assert.match(flat(collectionIcon({ icon: '🎨', color: 'pink' })), /collection-emoji/);
  assert.match(flat(favicon('https://www.example.com/x')), /class="favicon" data-color="\w+" style="--size:16px" aria-hidden="true">E</);
  for (const { name, hex } of COLLECTION_COLORS) {
    assert.equal(colorName(name), name);
    assert.equal(colorVar(hex), `var(--c-${name})`);
  }
  assert.equal(colorVar('url(x)'), 'var(--c-gray)', 'arbitrary strings never reach CSS');
});

test('empty states can announce load errors', () => {
  assert.match(flat(emptyState({ title: 'Couldn’t load', tone: 'danger' })), /data-tone="danger" role="alert"/);
  assert.ok(!flat(emptyState({ title: 'Nothing here' })).includes('role="alert"'));
});

test('highlight colors normalize to the tokenized set', () => {
  assert.equal(highlightColor('violet'), 'purple');
  assert.equal(highlightColor('Amber'), 'amber');
  assert.equal(highlightColor('chartreuse'), 'yellow');
  assert.equal(highlightColor(undefined), 'yellow');
  assert.ok(HIGHLIGHT_COLORS.includes('yellow'));
});

test('tokens.css defines every palette, highlight and accent token the components use', async () => {
  const css = await readFile(new URL('../extension/styles/tokens.css', import.meta.url), 'utf8');
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
  for (const { name } of COLLECTION_COLORS) {
    assert.ok(defined.has(`--c-${name}`) && defined.has(`--c-${name}-soft`), `--c-${name} and -soft`);
  }
  for (const color of HIGHLIGHT_COLORS) assert.ok(defined.has(`--hl-${color}`) && defined.has(`--hl-${color}-mark`), `--hl-${color}`);
  for (const name of ['--bg-app', '--bg-sidebar', '--bg-surface', '--bg-raised', '--bg-sunken', '--bg-field', '--bg-hover', '--bg-active', '--bg-selected',
    '--fg-default', '--fg-muted', '--fg-subtle', '--fg-on-accent', '--fg-on-danger', '--border-subtle', '--border-default', '--border-input', '--border-control',
    '--accent', '--accent-hover', '--accent-soft', '--accent-soft-fg', '--focus-ring', '--danger', '--danger-soft', '--success', '--success-soft', '--warning',
    '--warning-soft', '--font-sans', '--font-mono', '--control-h-sm', '--control-h-md', '--control-h-lg', '--row-h', '--sidebar-w', '--panel-w', '--star',
    '--z-sticky', '--z-dropdown', '--z-popover', '--z-overlay', '--z-dialog', '--z-toast', '--z-tooltip', '--lh-prose', '--icon-stroke', '--bg-tag']) {
    assert.ok(defined.has(name), name);
  }
  for (let i = 1; i <= 10; i++) assert.ok(defined.has(`--space-${i}`), `--space-${i}`);
  assert.ok(!/\[data-density="compact"\][^}]*--space-/.test(css), 'density never redefines spacing');
  assert.ok(!/data-accent="violet"/.test(css), 'no violet accent preset');
  for (const accent of ['teal', 'green', 'gold', 'orange', 'pink', 'graphite']) {
    assert.ok(css.includes(`[data-accent="${accent}"]`) && css.includes(`[data-theme="dark"][data-accent="${accent}"]`), accent);
  }
  const otherCss = await Promise.all(['base.css', 'components.css'].map(f => readFile(new URL(`../extension/styles/${f}`, import.meta.url), 'utf8')));
  for (const sheet of otherCss) {
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i.test(sheet.replace(/\/\*[\s\S]*?\*\//g, '')), 'no color literals outside tokens.css');
    assert.ok(!/backdrop-filter|transition:\s*all/.test(sheet));
  }
});
