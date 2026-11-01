// Builds extension/ui/icon-pack.js from an AnimateIcons checkout (MIT, https://github.com/Avijit07x/animateicons).
//
// Still has no build step, so the extension cannot run AnimateIcons' motion runtime. This script keeps the resting
// frame of each Lucide-based AnimateIcons icon as plain SVG markup, plus the pack's categories and keywords so the
// collection icon picker can be browsed by group and searched by meaning ("money" finds wallet, coins, piggy bank).
//
// 1. In the AnimateIcons checkout: pnpm install, then pnpm --dir vanilla run gen (writes vanilla/src/generated).
// 2. node scripts/vendor-icons.mjs <path-to-animateicons-checkout>
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2];
if (!source) { console.error('Usage: node scripts/vendor-icons.mjs <animateicons checkout>'); process.exit(1); }
const generated = resolve(source, 'vanilla/src/generated/lucide');
const output = resolve(root, 'extension/ui/icon-pack.js');

// Interface chrome (arrows, layout, text formatting, cursors) and add/remove/off variants are left out: they are
// already covered by ui/icons.js where the app needs them and make poor collection icons.
const SKIP_CATEGORIES = new Set(['Arrows', 'Layout', 'Text formatting', 'Cursors']);
const SKIP_NAME = /^(a-arrow|align|arrow|case-|chevron|circle-arrow|circle-chevron|columns|corner|ellipsis|expand|fold|fullscreen|grip|heading|indent|list-|loader|log-|maximize|minimize|move|panel|pilcrow|redo|refresh|remove-formatting|repeat|rewind|fast-forward|rotate|rows|shrink|skip|square-arrow|square-chevron|step-|subscript|superscript|text-cursor|toggle|undo|unfold|wrap-text|zoom-)|-(plus|minus|x|off|inside|dashed|dashed-check|close)$/;
const SKIP_EXACT = new Set(['plus', 'minus', 'x', 'check', 'check-check', 'delete', 'menu', 'bold', 'italic', 'underline', 'strikethrough',
  'diff', 'signal-zero', 'signal-low', 'signal-medium', 'wifi-zero', 'wifi-low', 'battery-low', 'battery-medium', 'battery-warning',
  'circle-slash-2', 'square-slash', 'circle-stop', 'square-stop', 'octagon-pause', 'circle-pause', 'square-pause', 'pause', 'variable', 'regex',
  'copy', 'copy-check', 'external-link', 'share', 'download', 'upload', 'search', 'search-x', 'filter', 'funnel-x', 'info', 'circle-alert',
  'eye-closed', 'thumbs-down', 'thumbs-up']);

// AnimateIcons categories folded into the picker's browse groups, in display order.
const GROUPS = [
  ['Files & storage', ['File icons', 'Storage']],
  ['Work & money', ['Finance', 'E-commerce', 'Shopping', 'Charts', 'Logistics']],
  ['Communication', ['Communication', 'Mail', 'Social', 'Notification']],
  ['Code & devices', ['Coding & development', 'Devices', 'Connectivity']],
  ['Security & accounts', ['Security', 'Accounts & access']],
  ['Media & design', ['Multimedia', 'Photography', 'Design', 'Gaming']],
  ['Time & planning', ['Time & Date']],
  ['Places & travel', ['Navigation, Maps, and POIs', 'Travel', 'Transportation', 'Architecture', 'Home']],
  ['Nature & weather', ['Weather', 'Nature', 'Animals']],
  ['People & feelings', ['People', 'Emoji', 'Accessibility']],
  ['Science & health', ['Science', 'Medical', 'Mathematics']],
  ['Tools', ['Tools']],
  ['Shapes & brands', ['Shapes', 'Brands']],
];
const groupOf = new Map(GROUPS.flatMap(([label, categories]) => categories.map(category => [category, label])));
// A few icons whose first AnimateIcons category reads oddly in a picker.
const GROUP_OVERRIDES = {
  'book-open': 'Files & storage', 'book-open-check': 'Files & storage', 'book-open-text': 'Files & storage', 'text-search': 'Files & storage',
  coffee: 'Places & travel', utensils: 'Places & travel', layers: 'Shapes & brands', rocket: 'Science & health', lightbulb: 'Science & health',
  'graduation-cap': 'Science & health', dumbbell: 'People & feelings', 'biceps-flexed': 'People & feelings', flame: 'Nature & weather',
  telescope: 'Science & health', 'party-popper': 'People & feelings', medal: 'People & feelings', trophy: 'People & feelings', crown: 'People & feelings',
};

const IDENTITY = { x: 0, y: 0, rotate: 0, scale: 1, scaleX: 1, scaleY: 1, opacity: 1, pathLength: 1, pathOffset: 0, strokeDashoffset: 0,
  skewX: 0, skewY: 0, rotateX: 0, rotateY: 0, transformPerspective: undefined, originX: undefined, originY: undefined };
const DRAW_TAGS = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const attr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const isIdentity = (key, value) => key in IDENTITY && (IDENTITY[key] === undefined || IDENTITY[key] === value || value === '0%' || value === '0px');

class Unsupported extends Error {}

/** Resting-frame SVG markup for one node; '' when the part is hidden at rest. */
function renderNode(node, name) {
  const normal = { ...(node.normal || {}) };
  delete normal.transition;
  if (normal.opacity === 0 || normal.pathLength === 0 || normal.scale === 0 || node.style?.opacity === 0 || String(node.attrs?.opacity) === '0') return '';
  const attrs = { ...(node.attrs || {}) };
  for (const [key, value] of Object.entries(normal)) {
    if (key === 'strokeDashoffset') attrs['stroke-dashoffset'] = value;
    else if (key === 'strokeDasharray') { if (value === 'none') { delete attrs['stroke-dasharray']; delete attrs['stroke-dashoffset']; } else attrs['stroke-dasharray'] = value; }
    else if (key === 'opacity' && value !== 1) attrs.opacity = value;
    else if (key === 'strokeWidth' || key === 'pathLength') continue;
    else if (!isIdentity(key, value)) throw new Unsupported(`${name}: resting ${key}=${JSON.stringify(value)}`);
  }
  if (!DRAW_TAGS.has(node.tag) && node.tag !== 'g') throw new Unsupported(`${name}: <${node.tag}>`);
  const children = (node.children || []).map(child => renderNode(child, name)).join('');
  if (node.tag === 'g' && !children) return '';
  const list = Object.entries(attrs).filter(([key]) => key !== 'xmlns').map(([key, value]) => ` ${key}="${attr(value)}"`).join('');
  if (node.tag === 'g') return list ? `<g${list}>${children}</g>` : children;
  return `<${node.tag}${list}/>`;
}

const parseModule = text => {
  const json = text.slice(text.indexOf('= ') + 2, text.lastIndexOf(';')).replace(/\bInfinity\b/g, '1e9');
  return JSON.parse(json);
};

const meta = JSON.parse(await readFile(resolve(source, 'data/lucide-icons.json'), 'utf8'));
const files = new Set(await readdir(generated));
const paths = {};
const keywords = {};
const groups = new Map(GROUPS.map(([label]) => [label, []]));
const skipped = [];

for (const entry of meta) {
  const { name, category = [] } = entry;
  const file = `${name}.ts`;
  if (!files.has(file)) { skipped.push(`${name}: no generated data`); continue; }
  if (SKIP_EXACT.has(name) || SKIP_NAME.test(name) || category.every(c => SKIP_CATEGORIES.has(c))) continue;
  const group = GROUP_OVERRIDES[name] || category.map(c => groupOf.get(c)).find(Boolean);
  if (!group) { skipped.push(`${name}: no browse group for ${category.join(', ')}`); continue; }
  let markup;
  try {
    const data = parseModule(await readFile(resolve(generated, file), 'utf8'));
    if (data.attrs?.viewBox !== '0 0 24 24') throw new Unsupported(`${name}: viewBox ${data.attrs?.viewBox}`);
    markup = (data.children || []).map(child => renderNode(child, name)).join('');
  } catch (error) {
    if (error instanceof Unsupported) { skipped.push(error.message); continue; }
    throw error;
  }
  if (!markup) { skipped.push(`${name}: nothing visible at rest`); continue; }
  paths[name] = markup;
  const words = new Set([...(entry.keywords || []), ...category].flatMap(word => String(word).toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean));
  for (const part of name.split('-')) words.delete(part);
  keywords[name] = [...words].join(' ');
  groups.get(group).push(name);
}

const sortedGroups = [...groups].filter(([, names]) => names.length).map(([label, names]) => [label, names.sort()]);
const count = Object.keys(paths).length;
const body = `// Generated by scripts/vendor-icons.mjs from AnimateIcons (MIT, Avijit Dey), whose Lucide-based shapes are ISC licensed
// (see assets/licenses/animateicons.txt and lucide.txt). Do not edit by hand. ${count} icons, resting frame only.
/** name -> inner SVG markup for a 24x24 stroke icon. */
export const PACK_PATHS = ${JSON.stringify(Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))), null, 0).replace(/","/g, '",\n"')};
/** name -> space-separated search words (keywords and categories, without the words already in the name). */
export const PACK_KEYWORDS = ${JSON.stringify(Object.fromEntries(Object.entries(keywords).sort(([a], [b]) => a.localeCompare(b))), null, 0).replace(/","/g, '",\n"')};
/** Browse groups for the collection icon picker: [label, names]. */
export const PACK_GROUPS = ${JSON.stringify(sortedGroups).replace(/\],\["/g, '],\n["')};
`;
await writeFile(output, body);
console.log(`Wrote ${count} icons in ${sortedGroups.length} groups to ${output} (${(body.length / 1024).toFixed(0)} KB).`);
if (skipped.length) console.log(`Skipped ${skipped.length}:\n  ${skipped.join('\n  ')}`);
