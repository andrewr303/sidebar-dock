// Theme catalogue (ui/themes.js) and appearance settings (lib/settings-schema.js): modes, wallpaper presets, the
// scales Settings offers and the tokens.css blocks behind them, and how stored settings are read back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  THEMES, THEME_IDS, themeById, resolveMode, supportsMode, WALLPAPER_PRESETS, wallpaperPreset,
  FONT_SIZES, RADII, SIDEBAR_WIDTHS, WIDGET_STYLES,
} from '../extension/ui/themes.js';
import {
  APPEARANCE_DEFAULTS, WALLPAPER_DEFAULTS, DASHBOARD_DEFAULTS, NEWTAB_DEFAULTS, SETTINGS_CHOICES,
  appearanceOf, settingsGroup, patchGroup,
} from '../extension/lib/settings-schema.js';

const TOKENS = readFileSync(new URL('../extension/styles/tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const SKINS = readFileSync(new URL('../extension/styles/skins.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** Custom properties of the first rule whose selector is exactly `selector`. */
function block(css, selector) {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `rule ${selector}`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
}

test('THEMES: ids, copy and modes', () => {
  assert.deepEqual(THEME_IDS, ['still', 'white', 'glass', 'midnight', 'nord', 'paper', 'rose']);
  for (const theme of THEMES) {
    assert.match(theme.id, /^[a-z]+$/);
    assert.ok(theme.label && theme.description.endsWith('.'), theme.id);
    assert.ok(theme.modes.length >= 1 && theme.modes.length <= 2, theme.id);
    assert.ok(typeof theme.accentLabel === 'string' && theme.accentLabel.length > 2, `${theme.id} names its accent`);
  }
  assert.deepEqual(themeById('white').modes, ['light']);
  assert.deepEqual(themeById('midnight').modes, ['dark']);
  assert.equal(themeById('nope').id, 'still');
  assert.equal(themeById(undefined).id, 'still');
  assert.ok(Object.isFrozen(THEMES));
});

test('resolveMode: single-mode skins force their mode; others follow the choice or the system', () => {
  assert.equal(resolveMode('white', 'dark', true), 'light');
  assert.equal(resolveMode('midnight', 'light', false), 'dark');
  assert.equal(resolveMode('nord', 'dark', false), 'dark');
  assert.equal(resolveMode('nord', 'light', true), 'light');
  assert.equal(resolveMode('glass', 'system', true), 'dark');
  assert.equal(resolveMode('glass', 'system', false), 'light');
  assert.equal(resolveMode('paper', undefined, true), 'dark');
  assert.equal(resolveMode('unknown', 'bogus', false), 'light');
  assert.equal(supportsMode('white', 'dark'), false);
  assert.equal(supportsMode('rose', 'dark'), true);
});

test('wallpaper presets: unique ids, light and dark gradients made of valid colors', () => {
  const ids = WALLPAPER_PRESETS.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(wallpaperPreset('canyon').id, 'canyon');
  assert.equal(wallpaperPreset('missing').id, WALLPAPER_PRESETS[0].id);
  for (const preset of WALLPAPER_PRESETS) {
    for (const css of [preset.css, preset.dark]) {
      assert.ok(typeof css === 'string' && css.length > 20, preset.id);
      assert.ok(!/url\(|;|\{|\}|<|>/.test(css), `${preset.id} is a plain gradient`);
      assert.match(css, /(linear|radial)-gradient\(/);
      // Balanced parentheses: the value can sit inside background-image without breaking the declaration.
      let depth = 0;
      for (const ch of css) { depth += ch === '(' ? 1 : ch === ')' ? -1 : 0; assert.ok(depth >= 0); }
      assert.equal(depth, 0, preset.id);
      const colors = css.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) || [];
      assert.ok(colors.length >= 2, `${preset.id} has colors`);
      for (const c of colors.filter(c => c.startsWith('#'))) assert.match(c, /^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    }
    assert.ok(preset.label, preset.id);
  }
  assert.ok(THEMES.filter(t => t.wallpaper).every(t => ids.includes(t.wallpaper)));
});

test('Settings scales match their tokens.css blocks', () => {
  const base = block(TOKENS, ':root');
  assert.equal(base['--text-sm'], `${FONT_SIZES.find(f => f.value === 'md').px}px`);
  for (const size of FONT_SIZES.filter(f => f.value !== 'md')) {
    const tokens = block(TOKENS, `[data-font-size="${size.value}"]`);
    assert.equal(tokens['--text-sm'], `${size.px}px`, size.value);
    const steps = ['--text-xs', '--text-sm', '--text-md', '--text-lg', '--text-xl', '--text-2xl'].map(k => parseFloat(tokens[k]));
    assert.ok(steps.every((v, i) => i === 0 || v >= steps[i - 1]), `${size.value} scale ascends`);
    assert.ok(steps[0] >= 12, `${size.value} never under 12px`);
    assert.match(tokens['--ui-bump'], /^-?\d+px$/);
  }
  for (const radius of RADII.filter(r => r.value !== 'default')) assert.equal(Number(block(TOKENS, `[data-radius="${radius.value}"]`)['--radius-k']), radius.k);
  assert.equal(Number(base['--radius-k']), RADII.find(r => r.value === 'default').k);
  assert.equal(base['--sidebar-w'], `${SIDEBAR_WIDTHS.find(w => w.value === 'default').px}px`);
  for (const width of SIDEBAR_WIDTHS.filter(w => w.value !== 'default')) assert.equal(block(TOKENS, `[data-sidebar-width="${width.value}"]`)['--sidebar-w'], `${width.px}px`);
  const motion = block(TOKENS, '[data-motion="reduced"]');
  assert.equal(motion['--dur-fast'], '0ms');
  assert.equal(motion['--press-scale'], '1');
  assert.deepEqual(WIDGET_STYLES.map(s => s.value), ['card', 'glass', 'flat', 'raised', 'clear', 'tinted', 'gradient', 'outline']);
  const dashboardCss = readFileSync(new URL('../extension/styles/dashboard.css', import.meta.url), 'utf8');
  for (const style of WIDGET_STYLES.filter(s => s.value !== 'card')) {
    assert.ok(dashboardCss.includes(`[data-widget-style="${style.value}"]`), `${style.value} has a dashboard-wide material`);
    assert.ok(dashboardCss.includes(`[data-frame="${style.value}"]`), `${style.value} has a per-widget Background and a preview`);
    assert.ok(style.description, style.value);
  }
});

test('skins.css honours reduced motion and reduced transparency', () => {
  assert.match(SKINS, /:root\[data-motion="reduced"\] \*,[\s\S]*?animation-duration: 1ms !important/);
  assert.match(SKINS, /:root\[data-transparency="reduced"\] \*,[\s\S]*?backdrop-filter: none !important/);
  assert.match(SKINS, /@media \(prefers-reduced-transparency: reduce\)/);
  for (const mode of ['light', 'dark']) {
    const opaque = block(SKINS, `:root[data-skin="glass"][data-theme="${mode}"][data-transparency="reduced"]`);
    for (const key of ['--glass-surface', '--glass-panel', '--glass-bar', '--bg-app', '--bg-surface', '--bg-raised']) assert.match(opaque[key], /^#[0-9a-f]{6}$/, `${mode} ${key} is opaque`);
  }
});

test('appearanceOf fills defaults and rejects values outside the choices', () => {
  assert.deepEqual(appearanceOf({}), { ...APPEARANCE_DEFAULTS });
  assert.deepEqual(appearanceOf(undefined), { ...APPEARANCE_DEFAULTS });
  const read = appearanceOf({ skin: 'nord', theme: 'dark', fontSize: 'xl', radius: 'round', motion: 'reduced', transparency: 'reduced', sidebarWidth: 'wide', favicons: false, accent: 'teal', density: 'compact' });
  assert.deepEqual(read, { skin: 'nord', theme: 'dark', accent: 'teal', density: 'compact', fontSize: 'xl', radius: 'round', motion: 'reduced', transparency: 'reduced', favicons: false, sidebarWidth: 'wide' });
  const bad = appearanceOf({ skin: 'solarized', theme: 'sepia', fontSize: 'huge', radius: 3, motion: true, transparency: '', sidebarWidth: null, favicons: 'yes', density: 'cozy' });
  for (const key of ['skin', 'theme', 'fontSize', 'radius', 'motion', 'transparency', 'sidebarWidth', 'favicons', 'density']) assert.equal(bad[key], APPEARANCE_DEFAULTS[key], key);
  // Every skin in the catalogue is a valid choice, and nothing else is.
  assert.deepEqual(SETTINGS_CHOICES.appearance.skin, THEME_IDS);
  for (const id of THEME_IDS) assert.equal(appearanceOf({ skin: id }).skin, id);
});

test('settingsGroup merges over defaults, clamps ranges, rejects unknown choices and keeps unknown keys', () => {
  assert.deepEqual(settingsGroup({}, 'wallpaper'), { ...WALLPAPER_DEFAULTS });
  assert.deepEqual(settingsGroup({ dashboard: 'nope' }, 'dashboard'), { ...DASHBOARD_DEFAULTS });
  assert.deepEqual(settingsGroup({ newTab: { name: 'Maddy', search: false } }, 'newTab'), { ...NEWTAB_DEFAULTS, name: 'Maddy', search: false });
  const wp = settingsGroup({ wallpaper: { kind: 'video', preset: 'lagoon', dim: 120, blur: -4, scope: 'everywhere', url: 'https://example.com/a.jpg', extra: 1 } }, 'wallpaper');
  assert.equal(wp.kind, 'none');
  assert.equal(wp.preset, 'lagoon');
  assert.equal(wp.dim, 80);
  assert.equal(wp.blur, 0);
  assert.equal(wp.scope, 'dashboard');
  assert.equal(wp.url, 'https://example.com/a.jpg');
  assert.equal(wp.extra, 1);
  assert.equal(settingsGroup({ wallpaper: { preset: 'gone', dim: Number.NaN } }, 'wallpaper').preset, 'aurora');
  assert.equal(settingsGroup({ wallpaper: { dim: Number.NaN } }, 'wallpaper').dim, 0);
  assert.equal(settingsGroup({ dashboard: { widgetStyle: 'neon', gap: 'lg' } }, 'dashboard').widgetStyle, 'card');
  assert.equal(settingsGroup({ dashboard: { widgetStyle: 'glass', gap: 'xl' } }, 'dashboard').gap, 'md');
  assert.equal(settingsGroup({ newTab: { engine: 'altavista', view: 'collection:abc' } }, 'newTab').engine, 'default');
  assert.equal(settingsGroup({ newTab: { view: 'collection:abc' } }, 'newTab').view, 'collection:abc');
  assert.equal(settingsGroup({ newTab: { view: '' } }, 'newTab').view, 'dashboard');
  assert.throws(() => settingsGroup({}, 'other'), /Unknown settings group/);
});

test('patchGroup writes the whole group with the patch applied', async () => {
  const writes = [];
  const store = { updateSettings: async patch => { writes.push(patch); return patch; } };
  await patchGroup(store, { wallpaper: { kind: 'preset', preset: 'dusk', custom: true } }, 'wallpaper', { dim: 30 });
  assert.deepEqual(writes, [{ wallpaper: { kind: 'preset', preset: 'dusk', custom: true, dim: 30 } }]);
  await patchGroup(store, {}, 'dashboard', { gap: 'sm' });
  assert.deepEqual(writes[1], { dashboard: { gap: 'sm' } });
});
