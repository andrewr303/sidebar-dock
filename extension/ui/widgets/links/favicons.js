// Site icons for link tiles. components.siteIcon layers Chrome's favicon over a letter tile, which suits small list
// icons but not a big app tile: a transparent favicon (GitHub, Wikipedia) shows the colored letter through it, and a
// site Chrome has no icon for comes back as a generic globe drawn over the letter. Tiles inside [data-link-icons]
// therefore settle on one of the two: each loaded icon is compared once with Chrome's generic image (a pixel
// signature; the image is same-origin so the canvas stays readable) and the verdict is remembered per page so the
// next new tab paints the final state at once. A remembered "no icon" keeps a hidden probe so a later visit upgrades it.
// Icons drawn as a light glyph on transparency (dark-mode favicons, white logos) get a dark plate instead of white.
import { html, cx } from '../../html.js';
import { favicon } from '../../components.js';

const STORE_KEY = 'still.link-icons.v1';
const LIMIT = 600;
const GENERIC = 0;
const REAL = 1;
const LIGHT = 2;   // real, but a light glyph on transparency: needs a dark plate
const defaults = new Map();       // size bucket -> Promise<signature | ''>
const bucket = size => (size > 32 ? 64 : 32);
const runtime = () => (globalThis.chrome?.runtime?.id && typeof globalThis.chrome.runtime.getURL === 'function' ? globalThis.chrome.runtime : null);
let verdicts = null;              // Map `${bucket}|${pageUrl}` -> REAL | GENERIC, oldest first
let saveTimer = 0;
let pending = 0;
let listening = false;

function load() {
  if (verdicts) return verdicts;
  verdicts = new Map();
  try {
    for (const [key, value] of Object.entries(JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) || '{}'))) {
      verdicts.set(key, [GENERIC, REAL, LIGHT].includes(value) ? value : GENERIC);
    }
  } catch { /* storage unavailable: start empty */ }
  return verdicts;
}

function remember(key, value) {
  const map = load();
  map.delete(key);
  map.set(key, value);
  while (map.size > LIMIT) map.delete(map.keys().next().value);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(map))); } catch { /* quota or private mode */ }
  }, 400);
}

const hasDomain = url => { try { return !!new URL(url).hostname; } catch { return false; } };

/** A tile icon: the site's own favicon when Chrome has one, else the letter tile (never both at once once known). */
export function tileIcon(url, { size = 32 } = {}) {
  const letter = favicon(url, { size, className: 'site-icon-fallback is-rounded' });
  const api = runtime();
  if (!api || !hasDomain(url)) return html`<span class="site-icon" style="--size:${size}px">${letter}</span>`;
  const b = bucket(size);
  const verdict = load().get(`${b}|${url}`);
  const src = `${api.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=${b}`;
  const real = verdict === REAL || verdict === LIGHT;
  const img = html`<img class="${cx('site-icon-img', verdict === GENERIC && 'is-probe')}" src="${src}" alt="" width="${size}" height="${size}" decoding="async" draggable="false">`;
  return html`<span class="${cx('site-icon', 'w-links-icon', real && 'is-real', verdict === LIGHT && 'is-light')}" style="--size:${size}px">${img}${real ? '' : letter}</span>`;
}

/** { signature, light } for a loaded icon: a pixel hash, and whether it is a light glyph on a mostly transparent ground. */
function inspect(img) {
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) return { signature: '', light: false };
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(img, 0, 0);
  const data = context.getImageData(0, 0, width, height).data;
  let hash = 2166136261;
  let clear = 0;
  let solid = 0;
  let luminance = 0;
  for (let i = 0; i < data.length; i += 1) hash = Math.imul(hash ^ data[i], 16777619) >>> 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 26) { clear += 1; continue; }
    if (alpha < 128) continue;
    solid += 1;
    luminance += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  }
  const pixels = data.length / 4;
  const light = solid > 0 && clear / pixels > 0.25 && luminance / solid > 0.82;
  return { signature: `${width}x${height}:${hash.toString(36)}`, light };
}

function defaultSignature(size) {
  if (!defaults.has(size)) {
    defaults.set(size, new Promise(resolve => {
      const img = new Image();
      img.onload = () => { try { resolve(inspect(img).signature); } catch { resolve(''); } };
      img.onerror = () => resolve('');
      img.src = `${runtime().getURL('/_favicon/')}?pageUrl=${encodeURIComponent('https://still-no-icon.invalid/')}&size=${size}`;
    }));
  }
  return defaults.get(size);
}

/** Watches icon loads inside [data-link-icons]; render runs (once per frame) when a tile's verdict changes. */
export function watchTileIcons(render) {
  if (listening || typeof document === 'undefined' || !runtime()) return;
  listening = true;
  document.addEventListener('load', async event => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('site-icon-img') || !img.closest('[data-link-icons]')) return;
    let params;
    try { params = new URL(img.currentSrc || img.src).searchParams; } catch { return; }
    const pageUrl = params.get('pageUrl');
    const size = Number(params.get('size')) || 32;
    if (!pageUrl) return;
    let verdict;
    try {
      const known = await defaultSignature(size);
      if (!known) return;
      const found = inspect(img);
      verdict = found.signature === known ? GENERIC : found.light ? LIGHT : REAL;
    } catch { return; }
    const key = `${size}|${pageUrl}`;
    if (load().get(key) === verdict) return;
    remember(key, verdict);
    if (!pending) pending = requestAnimationFrame(() => { pending = 0; render(); });
  }, true);
  // A failed icon request leaves the letter tile; nothing to remember.
}
