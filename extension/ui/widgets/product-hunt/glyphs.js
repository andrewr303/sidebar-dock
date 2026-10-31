// Product Hunt glyphs and image tiles: the brand mark, the upvote triangle and product thumbnails that fall back to a
// letter tile (the public feed has no images, and a thumbnail that fails to load is replaced by the tile).
import { html, cx } from '../../html.js';
import { icon, registerIcons } from '../../icons.js';
import { avatarTile } from '../../components.js';
import { thumbnailUrl } from '../../../lib/producthunt.js';
import { rerender } from './session.js';

registerIcons({
  'product-hunt': '<circle cx="12" cy="12" r="10" /><path d="M10 17V7h3.5a3 3 0 0 1 0 6H10" />',
  'ph-upvote': '<path d="M13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />',
});

const HUES = ['red', 'orange', 'amber', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'pink'];
/** A stable palette hue for a name, so a product keeps its tile color between refreshes. */
export function hueFor(name = '') {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return HUES[hash % HUES.length];
}

/** Brand tile (Product Hunt orange) for the account card and setup states. */
export const brandMark = (size = 36) => html`<span class="w-ph-mark" style="--size:${size}px" aria-hidden="true">${icon('product-hunt', { size: Math.round(size * 0.6), strokeWidth: 2 })}</span>`;

// Thumbnails that failed to load fall back to their letter tile on the next render. Images sit on a light plate (logos
// often have transparent backgrounds drawn for white), so the tile is never shown under a loading or loaded image.
const broken = new Set();
let watching = false;
function watchBroken() {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  document.addEventListener('error', event => {
    const img = event.target;
    if (img?.tagName !== 'IMG' || !img.classList?.contains('w-ph-thumb-img')) return;
    const src = img.getAttribute('src');
    if (!src || broken.has(src)) return;
    broken.add(src);
    rerender();
  }, true);
}

/** Product thumbnail: the product's image, or a letter tile without one. Decorative (the name is always next to it). */
export function thumb(post, size = 40, { className } = {}) {
  watchBroken();
  const src = thumbnailUrl(post?.thumbnail, size);
  if (src && !broken.has(src)) {
    return html`<span class="${cx('w-ph-thumb', 'has-image', className)}" style="--size:${size}px" aria-hidden="true"><img class="w-ph-thumb-img" src="${src}" alt="" width="${size}" height="${size}"
      loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable="false"></span>`;
  }
  const letter = [...String(post?.name || '?').trim()][0] || '?';
  return html`<span class="${cx('w-ph-thumb', className)}" style="--size:${size}px" aria-hidden="true">${avatarTile({ label: letter, color: hueFor(post?.name), size, className: 'w-ph-thumb-tile' })}</span>`;
}

const compact = typeof Intl !== 'undefined' ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }) : null;
/** Vote and comment counts: grouped below 10,000, compact above ("12K"). */
export const countText = n => (n >= 10000 && compact ? compact.format(n) : Number(n || 0).toLocaleString());
