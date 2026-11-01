// Skins: every THEMES entry has token blocks for each mode it declares, and the resolved tokens of every skin, mode and
// accent keep text and controls legible. The cascade below reads tokens.css + skins.css as Chrome would for <html>
// (root-level selectors only, specificity then source order), so these ratios are the ones the user sees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEMES, WALLPAPER_PRESETS } from '../extension/ui/themes.js';

const read = path => readFileSync(new URL(`../extension/styles/${path}`, import.meta.url), 'utf8');
const TOKENS = read('tokens.css');
const SKINS = read('skins.css');
const ACCENTS = ['blue', 'teal', 'green', 'gold', 'orange', 'pink', 'graphite'];

// ---------- CSS: top-level rules (rules inside @media/@supports are skipped) ----------
function rules(css, source) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let depth = 0, start = 0, selector = '', skipDepth = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      const prelude = text.slice(start, i).trim();
      if (depth === 0) { selector = prelude; if (prelude.startsWith('@')) skipDepth = 0; }
      depth++; start = i + 1;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && skipDepth === -1) out.push({ selector, body: text.slice(start, i), source, order: out.length });
      if (depth === skipDepth) skipDepth = -1;
      start = i + 1;
    } else if (ch === ';' && depth === 0) start = i + 1;
  }
  return out;
}
function declarations(body) {
  const map = new Map();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) map.set(m[1], m[2].trim());
  return map;
}

// ---------- Selectors: compound selectors on the root element ----------
function parseCompound(sel) {
  sel = sel.trim();
  if (/[\s>+~]/.test(sel.replace(/\[[^\]]*\]/g, '').replace(/:not\([^)]*\)/g, ''))) return null; // descendant: not the root
  const conds = [];
  let spec = 0;
  let rest = sel;
  if (rest.startsWith(':root')) { spec++; rest = rest.slice(5); }
  for (const m of rest.matchAll(/(:not\()?\[([\w-]+)(?:="([^"]*)")?\]\)?/g)) {
    conds.push({ name: m[2], value: m[3], negate: !!m[1] });
    spec++;
  }
  const leftover = rest.replace(/(:not\()?\[([\w-]+)(?:="([^"]*)")?\]\)?/g, '');
  if (leftover.trim()) return null;
  return { conds, spec };
}
function matches(compound, attrs) {
  return compound.conds.every(({ name, value, negate }) => {
    const has = name in attrs && (value === undefined || attrs[name] === value);
    return negate ? !has : has;
  });
}
const ALL_RULES = [...rules(TOKENS, 0), ...rules(SKINS, 1)].map((r, i) => ({ ...r, index: i, decls: declarations(r.body) }));

function resolveTokens(attrs) {
  const applied = [];
  for (const rule of ALL_RULES) {
    if (!rule.decls.size) continue;
    let best = -1;
    for (const part of rule.selector.split(',')) {
      const c = parseCompound(part);
      if (c && matches(c, attrs)) best = Math.max(best, c.spec);
    }
    if (best >= 0) applied.push({ rule, spec: best });
  }
  applied.sort((a, b) => a.spec - b.spec || a.rule.index - b.rule.index);
  const tokens = new Map();
  for (const { rule } of applied) for (const [k, v] of rule.decls) tokens.set(k, v);
  return tokens;
}

// ---------- Colors ----------
function parseColor(str) {
  const s = str.trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map(c => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1];
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(v => (v.endsWith('%') ? parseFloat(v) / 100 : Number(v)));
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  return null;
}
const over = (top, bottom) => {
  const a = top[3];
  return [0, 1, 2].map(i => top[i] * a + bottom[i] * (1 - a)).concat(1);
};
const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// color-mix(in srgb, A p%, B): premultiplied mix, as browsers do.
function mix(a, p, b) {
  const alpha = a[3] * p + b[3] * (1 - p);
  if (!alpha) return [0, 0, 0, 0];
  return [0, 1, 2].map(i => (a[i] * a[3] * p + b[i] * b[3] * (1 - p)) / alpha).concat(alpha);
}

function color(tokens, value, seen = new Set()) {
  value = value.trim();
  const v = value.match(/^var\((--[\w-]+)(?:\s*,\s*(.+))?\)$/);
  if (v) {
    if (seen.has(v[1])) throw new Error(`cycle at ${v[1]}`);
    const next = tokens.get(v[1]) ?? v[2];
    if (next === undefined) throw new Error(`missing ${v[1]}`);
    return color(tokens, next, new Set([...seen, v[1]]));
  }
  const m = value.match(/^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+)\)$/);
  if (m) return mix(color(tokens, m[1], seen), Number(m[2]) / 100, color(tokens, m[3], seen));
  const c = parseColor(value);
  if (!c) throw new Error(`not a color: ${value}`);
  return c;
}
const colorsIn = str => [...str.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)].map(m => parseColor(m[0]));

// The backdrops a surface can sit on. Glass composites over its ambient gradient; the stops of the gradient and each
// translucent glow over each base color stand in for every pixel of it.
function backdrops(tokens, mode) {
  const ambient = tokens.get('--glass-ambient');
  if (!ambient) return [color(tokens, 'var(--bg-app)')];
  const all = colorsIn(ambient);
  const solid = all.filter(c => c[3] === 1);
  const glows = all.filter(c => c[3] < 1);
  const stops = [...solid, ...glows.flatMap(g => solid.map(s => over(g, s)))];
  const pane = color(tokens, 'var(--glass-surface)');
  assert.ok(stops.length > 2, `${mode} glass ambient has colors`);
  return stops.map(s => over(pane, s));
}

function surfaces(tokens, value, base) {
  const c = color(tokens, value);
  return base.map(b => (c[3] < 1 ? over(c, b) : c));
}
function minRatio(tokens, fg, bg, base) {
  let worst = Infinity;
  for (const b of surfaces(tokens, bg, base)) {
    let f = color(tokens, fg);
    if (f[3] < 1) f = over(f, b);
    worst = Math.min(worst, ratio(f, b));
  }
  return worst;
}

const TEXT = [
  ['--fg-default', ['--bg-app', '--bg-sidebar', '--bg-surface', '--bg-raised', '--bg-sunken', '--bg-field', '--bg-control'], 7],
  ['--fg-muted', ['--bg-app', '--bg-sidebar', '--bg-surface', '--bg-raised', '--bg-sunken'], 4.5],
  ['--fg-subtle', ['--bg-app', '--bg-sidebar', '--bg-surface', '--bg-raised', '--bg-sunken'], 4.5],
  ['--fg-link', ['--bg-app', '--bg-surface', '--bg-raised'], 4.5],
  ['--accent-soft-fg', ['--accent-soft', '--bg-app'], 4.5],
  ['--fg-on-accent', ['--accent'], 4.5],
  ['--fg-on-danger', ['--danger-solid'], 4.5],
  ['--danger', ['--bg-app', '--bg-surface', '--bg-raised', '--danger-soft'], 4.5],
  ['--success', ['--bg-app', '--bg-surface', '--success-soft'], 4.5],
  ['--warning', ['--bg-app', '--bg-surface', '--warning-soft'], 4.5],
  ['--info', ['--bg-app', '--bg-surface', '--info-soft'], 4.5],
  ['--fg-inverse', ['--bg-inverse'], 4.5],
  ['--tooltip-fg', ['--tooltip-bg'], 4.5],
  ['--toast-fg', ['--toast-bg'], 4.5],
  ['--toast-fg-muted', ['--toast-bg'], 4.5],
  ['--toast-action', ['--toast-bg'], 4.5],
];
const NON_TEXT = [
  ['--border-input', ['--bg-field', '--bg-app', '--bg-raised'], 3],
  ['--border-control', ['--bg-app', '--bg-raised'], 3],
  ['--focus-ring', ['--bg-app', '--bg-sidebar', '--bg-raised', '--accent-soft'], 3],
  ['--accent', ['--bg-app', '--bg-raised'], 3],
  ['--star', ['--bg-surface'], 3],
  ['--toast-success', ['--toast-bg'], 3],
  ['--toast-danger', ['--toast-bg'], 3],
  ['--toast-warning', ['--toast-bg'], 3],
];

function check(attrs, pairs, label) {
  const tokens = resolveTokens(attrs);
  const base = backdrops(tokens, attrs['data-theme']);
  const failures = [];
  for (const [fg, bgs, min] of pairs) for (const bg of bgs) {
    const r = minRatio(tokens, `var(${fg})`, `var(${bg})`, base);
    if (r < min) failures.push(`${fg} on ${bg}: ${r.toFixed(2)} < ${min}`);
  }
  assert.deepEqual(failures, [], `${label}\n  ${failures.join('\n  ')}`);
}

const modesOf = theme => theme.modes.map(mode => ({ 'data-skin': theme.id, 'data-theme': mode }));

test('THEMES ids are unique and every skin has token blocks for each declared mode', () => {
  const ids = THEMES.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], 'still');
  const selectors = rules(SKINS).map(r => r.selector.replace(/\s+/g, ' '));
  for (const theme of THEMES.filter(t => t.id !== 'still')) {
    assert.ok(theme.modes.length >= 1 && theme.modes.every(m => m === 'light' || m === 'dark'), theme.id);
    for (const mode of theme.modes) {
      const exact = `:root[data-skin="${theme.id}"][data-theme="${mode}"]`;
      const single = `:root[data-skin="${theme.id}"]`;
      const found = selectors.some(s => s.split(',').some(p => p.trim() === exact || (theme.modes.length === 1 && p.trim() === single)));
      assert.ok(found, `skins.css defines ${theme.id} ${mode}`);
      const tokens = resolveTokens({ 'data-skin': theme.id, 'data-theme': mode, 'data-accent': 'blue' });
      // The block sets the core of the semantic palette itself rather than inheriting Still's.
      const own = new Map(ALL_RULES.filter(r => r.source === 1 && r.selector.split(',').some(p => [exact, single].includes(p.trim().replace(/\s+/g, ' ')))).flatMap(r => [...r.decls]));
      for (const key of ['--bg-app', '--bg-sidebar', '--bg-surface', '--bg-raised', '--bg-sunken', '--fg-default', '--fg-muted', '--fg-subtle',
        '--border-subtle', '--border-default', '--border-input', '--focus-ring', '--danger', '--success', '--warning', '--shadow-md', '--toast-bg', '--tooltip-bg']) {
        assert.ok(own.has(key), `${theme.id} ${mode} sets ${key}`);
      }
      assert.ok(tokens.get('--accent'), `${theme.id} ${mode} resolves an accent`);
    }
  }
});

test('swatches in THEMES are valid colors for each declared mode', () => {
  for (const theme of THEMES) {
    for (const mode of theme.modes) {
      const swatch = theme.swatches?.[mode];
      assert.ok(Array.isArray(swatch) && swatch.length === 4, `${theme.id} ${mode} has 4 swatches`);
      for (const c of swatch) assert.ok(parseColor(c), `${theme.id} ${mode} swatch ${c}`);
    }
    for (const mode of Object.keys(theme.swatches)) assert.ok(theme.modes.includes(mode), `${theme.id} has no ${mode} swatch without the mode`);
  }
});

test('swatches match the resolved skin tokens (canvas, surface, accent, text)', () => {
  const hex = c => '#' + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  for (const theme of THEMES.filter(t => t.id !== 'glass')) {
    for (const mode of theme.modes) {
      const tokens = resolveTokens({ 'data-skin': theme.id, 'data-theme': mode, 'data-accent': 'blue' });
      const want = ['--bg-app', '--bg-surface', '--accent', '--fg-default'].map(k => hex(color(tokens, `var(${k})`)));
      assert.deepEqual(theme.swatches[mode].map(s => hex(parseColor(s))), want, `${theme.id} ${mode}`);
    }
  }
});

for (const theme of THEMES) {
  for (const attrs of modesOf(theme)) {
    test(`${theme.id} ${attrs['data-theme']}: text and controls meet contrast with every accent`, () => {
      for (const accent of ACCENTS) {
        // Still keeps its shipped accents (its dark blue fill is 3.0:1 on the canvas and carries white text).
        const nonText = theme.id === 'still' ? NON_TEXT.filter(([fg]) => fg !== '--accent') : NON_TEXT;
        check({ ...attrs, 'data-accent': accent }, accent === 'blue' ? [...TEXT, ...nonText] : [
          ['--fg-on-accent', ['--accent'], 4.5],
          ['--accent-soft-fg', ['--accent-soft', '--bg-app', '--bg-surface'], 4.5],
          ...(theme.id === 'still' ? [] : [['--accent', ['--bg-app'], 3]]),
        ], `${theme.id} ${attrs['data-theme']} ${accent}`);
      }
    });
  }
}

test('skin token blocks only set custom properties and color-scheme, never with !important', () => {
  // Plain root rules let Settings switch skins at any moment and let later sections (accent tints, wallpaper,
  // transparency) refine them.
  const tokenBlock = /^:root\[data-skin="\w+"\](\[data-theme="\w+"\])?(\[data-accent="\w+"\])?(\[data-(transparency|wallpaper)="\w+"\])?$/;
  const blocks = rules(SKINS).filter(r => tokenBlock.test(r.selector.trim()));
  assert.ok(blocks.length >= 20);
  for (const rule of blocks) {
    assert.ok(!/!important/.test(rule.body), rule.selector);
    for (const decl of rule.body.split(';').map(d => d.trim()).filter(Boolean)) {
      assert.match(decl, /^(--[\w-]+|color-scheme)\s*:/, `${rule.selector}: ${decl.slice(0, 40)}`);
    }
  }
});

for (const variant of [{ 'data-transparency': 'reduced' }, { 'data-wallpaper': 'on' }]) {
  for (const mode of ['light', 'dark']) {
    const label = Object.entries(variant).map(([k, v]) => `${k.slice(5)}=${v}`).join(' ');
    test(`glass ${mode} with ${label}: text and controls meet contrast`, () => {
      check({ 'data-skin': 'glass', 'data-theme': mode, 'data-accent': 'blue', ...variant }, [...TEXT, ...NON_TEXT], `glass ${mode} ${label}`);
    });
  }
}

test('the Liquid Glass ambient is the Aurora wallpaper preset in both modes', () => {
  const aurora = WALLPAPER_PRESETS.find(p => p.id === 'aurora');
  const glass = THEMES.find(t => t.id === 'glass');
  assert.equal(glass.wallpaper, 'aurora');
  const norm = s => s.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();
  for (const [mode, css] of [['light', aurora.css], ['dark', aurora.dark]]) {
    const tokens = resolveTokens({ 'data-skin': 'glass', 'data-theme': mode, 'data-accent': 'blue' });
    assert.equal(norm(tokens.get('--glass-ambient')), norm(css), mode);
  }
});
