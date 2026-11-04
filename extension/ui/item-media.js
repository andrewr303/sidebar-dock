// Uploaded icons and cover images for library items (notes and links). An upload is decoded in the page (any format
// Chrome can open: PNG, JPEG, WebP, GIF, AVIF, SVG, BMP, ICO), scaled down and stored inside the item as a WebP data
// URL, so it works offline, needs no host access and travels with backups. Covers show on note pages, in the detail
// panel and in library rows and cards; icons show on dashboard tiles, Notes widget rows, note pages and library rows.
// The size math is pure and unit tested; decoding and the file chooser need a browser.
import { html, cx, safeSrc } from './html.js';
import { MAX_CUSTOM_ICON_DATA } from '../lib/store.js';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Longest side in pixels and the largest stored data URL, per kind. Icons are cropped square. */
export const IMAGE_KINDS = Object.freeze({
  cover: Object.freeze({ field: 'cover', max: 1600, budget: 700 * 1024, square: false, label: 'cover' }),
  icon: Object.freeze({ field: 'customIcon', max: 192, budget: MAX_CUSTOM_ICON_DATA, square: true, label: 'icon' }),
});
const QUALITIES = [0.86, 0.74, 0.6];
const UNREADABLE = 'Chrome could not open that image. Try a PNG, JPEG, WebP, GIF, AVIF, SVG, BMP or ICO file.';

/** Pixel size that fits inside max on the longest side, never enlarging. Square kinds use the shorter side. */
export function fitSize(width, height, max, { square = false } = {}) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  if (square) { const side = Math.max(1, Math.min(max, w, h)); return { width: side, height: side }; }
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** The centered square of a width × height image: { x, y, size } in source pixels. */
export function squareCrop(width, height) {
  const size = Math.min(width, height);
  return { x: Math.round((width - size) / 2), y: Math.round((height - size) / 2), size };
}

/** Checks a chosen file before decoding it: '' when it may be an image, else a readable reason. */
export function fileProblem(file) {
  if (!file) return 'Choose an image file.';
  if (file.size > MAX_UPLOAD_BYTES) return 'Choose an image under 25 MB.';
  // Some systems leave the type empty (HEIC, unusual extensions): those still get a decoding attempt.
  if (file.type && !/^image\//i.test(file.type)) return 'That file is not an image.';
  return '';
}

/** Opens the system file chooser for one image. Resolves the File, or null when the person cancels. */
export function pickImageFile() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => resolve(input.files?.[0] || null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

/** { source, width, height, close } for an image file; SVG and ICO go through an <img> when createImageBitmap refuses. */
async function decode(file) {
  try {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
  } catch { /* fall back to an <img> below */ }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    // An SVG without width and height reports 0: draw it at a size big enough for a cover.
    const width = img.naturalWidth || 1200;
    const height = img.naturalHeight || (img.naturalWidth ? img.naturalWidth : 1200);
    return { source: img, width, height, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(UNREADABLE);
  }
}

/** Decodes, crops (icons), scales and encodes an image file as a WebP data URL that fits the kind's budget. */
export async function imageToDataUrl(file, kind = IMAGE_KINDS.cover) {
  const problem = fileProblem(file);
  if (problem) throw new Error(problem);
  const image = await decode(file);
  try {
    const crop = kind.square ? squareCrop(image.width, image.height) : { x: 0, y: 0, size: 0 };
    const sw = kind.square ? crop.size : image.width;
    const sh = kind.square ? crop.size : image.height;
    let max = kind.max;
    for (let attempt = 0; attempt < 6; attempt++) {
      const { width, height } = fitSize(sw, sh, max, { square: kind.square });
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(image.source, crop.x, crop.y, sw, sh, 0, 0, width, height);
      // WebP keeps transparency (JPEG would turn a transparent logo black).
      for (const quality of QUALITIES) {
        const url = canvas.toDataURL('image/webp', quality);
        if (!/^data:image\/(webp|png);base64,/.test(url)) throw new Error(UNREADABLE);
        if (url.length <= kind.budget) return url;
      }
      max = Math.max(16, Math.round(Math.min(max, Math.max(width, height)) * 0.72));
    }
    throw new Error(`That image is too detailed to keep as a${kind.label === 'icon' ? 'n' : ''} ${kind.label}. Try a simpler or smaller one.`);
  } finally { image.close(); }
}

/* ------------------------------------------------------------------ item flows */

/**
 * Asks for an image and stores it as the item's cover or icon, with an Undo toast. `write(patch)` saves the change
 * (defaults to ctx.store.updateItem; the note editor passes its own so its save state stays in step). Returns true
 * when something was saved.
 */
export async function uploadItemImage(ctx, itemId, kindName, { write } = {}) {
  const kind = IMAGE_KINDS[kindName];
  if (!kind) return false;
  // The chooser opens before any await, while the click still counts as a user gesture.
  const file = await pickImageFile();
  if (!file) return false;
  const value = await imageToDataUrl(file, kind);
  const item = ctx.select.byId(itemId);
  if (!item || item.deletedAt) throw new Error('This item no longer exists.');
  const save = write || (patch => ctx.store.updateItem(itemId, patch));
  const previous = item[kind.field] || '';
  await save({ [kind.field]: value });
  ctx.toast(`${previous ? 'Changed' : 'Added'} the ${kind.label}`, { tone: 'success', action: { label: 'Undo', run: () => save({ [kind.field]: previous }) } });
  return true;
}

/** Removes the item's cover or icon, with an Undo toast. */
export async function removeItemImage(ctx, itemId, kindName, { write } = {}) {
  const kind = IMAGE_KINDS[kindName];
  const item = ctx.select.byId(itemId);
  if (!kind || !item?.[kind.field]) return false;
  const save = write || (patch => ctx.store.updateItem(itemId, patch));
  const previous = item[kind.field];
  await save({ [kind.field]: '' });
  ctx.toast(`Removed the ${kind.label}`, { action: { label: 'Undo', run: () => save({ [kind.field]: previous }) } });
  return true;
}

/** Menu entries for an item's uploaded icon: upload (or change) and, when one is set, remove. */
export function iconMenuItems(ctx, item, { write } = {}) {
  if (!item) return [];
  return [
    { label: item.customIcon ? 'Change icon…' : 'Upload icon…', icon: 'image-plus', run: () => ctx.run(() => uploadItemImage(ctx, item.id, 'icon', { write })) },
    item.customIcon && { label: 'Remove icon', icon: 'x', run: () => ctx.run(() => removeItemImage(ctx, item.id, 'icon', { write })) },
  ].filter(Boolean);
}

/** Menu entries for an item's cover: upload, an image link (optional), and remove when one is set. */
export function coverMenuItems(ctx, item, { write, link } = {}) {
  if (!item) return [];
  return [
    { label: item.cover ? 'Upload a new cover…' : 'Upload cover…', icon: 'upload', run: () => ctx.run(() => uploadItemImage(ctx, item.id, 'cover', { write })) },
    link && { label: 'Use an image link…', icon: 'link', run: link },
    item.cover && { label: 'Remove cover', icon: 'x', run: () => ctx.run(() => removeItemImage(ctx, item.id, 'cover', { write })) },
  ].filter(Boolean);
}

/* ------------------------------------------------------------------ rendering */

/** The item's uploaded icon as an image source ('' when it has none). */
export const customIconSrc = item => (/^data:image\//i.test(item?.customIcon || '') ? safeSrc(item.customIcon) : '');

/** The uploaded icon as a rounded square of `size` px, or '' when the item has none. */
export function customIcon(item, { size = 20, className } = {}) {
  const src = customIconSrc(item);
  return src ? html`<span class="${cx('item-custom-icon', className)}" style="--size:${size}px" aria-hidden="true"><img src="${src}" alt="" width="${size}" height="${size}"
    decoding="async" draggable="false"></span>` : '';
}
