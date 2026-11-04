import test from 'node:test';
import assert from 'node:assert/strict';
import { fitSize, squareCrop, fileProblem, IMAGE_KINDS, MAX_UPLOAD_BYTES, customIconSrc } from '../extension/ui/item-media.js';
import { normalizeItem, MAX_CUSTOM_ICON_DATA } from '../extension/lib/store.js';

test('uploads are scaled to fit the longest side without enlarging; icons are square', () => {
  assert.deepEqual(fitSize(4000, 3000, 1600), { width: 1600, height: 1200 });
  assert.deepEqual(fitSize(900, 3000, 1600), { width: 480, height: 1600 });
  assert.deepEqual(fitSize(320, 200, 1600), { width: 320, height: 200 }, 'small images keep their size');
  assert.deepEqual(fitSize(1024, 600, 192, { square: true }), { width: 192, height: 192 });
  assert.deepEqual(fitSize(48, 64, 192, { square: true }), { width: 48, height: 48 }, 'a small icon is not blown up');
  assert.deepEqual(fitSize(0, Number.NaN, 100), { width: 1, height: 1 });
  assert.deepEqual(squareCrop(400, 300), { x: 50, y: 0, size: 300 });
  assert.deepEqual(squareCrop(300, 500), { x: 0, y: 100, size: 300 });
  assert.equal(IMAGE_KINDS.icon.field, 'customIcon');
  assert.equal(IMAGE_KINDS.icon.budget, MAX_CUSTOM_ICON_DATA);
  assert.equal(IMAGE_KINDS.cover.field, 'cover');
});

test('a chosen file is checked before decoding: any image type, under 25 MB', () => {
  assert.equal(fileProblem(null), 'Choose an image file.');
  for (const type of ['image/png', 'image/jpeg', 'image/svg+xml', 'image/bmp', 'image/x-icon', 'image/heic', 'image/tiff', '']) {
    assert.equal(fileProblem({ type, size: 1000 }), '', type);
  }
  assert.equal(fileProblem({ type: 'application/pdf', size: 10 }), 'That file is not an image.');
  assert.equal(fileProblem({ type: 'image/png', size: MAX_UPLOAD_BYTES + 1 }), 'Choose an image under 25 MB.');
});

test('items keep an uploaded icon separately from the captured page icon', () => {
  const data = `data:image/webp;base64,${'A'.repeat(400)}`;
  const item = normalizeItem({ type: 'bookmark', url: 'https://a.com', icon: 'https://a.com/favicon.ico', customIcon: data });
  assert.equal(item.customIcon, data);
  assert.equal(item.icon, 'https://a.com/favicon.ico');
  // A later capture that fills `icon` leaves the uploaded one alone.
  assert.equal(normalizeItem({ icon: 'https://a.com/new.png' }, item).customIcon, data);
  assert.equal(normalizeItem({ customIcon: '' }, item).customIcon, '', 'removing works');
  for (const bad of ['https://a.com/x.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,AAAA',
    `data:image/png;base64,${'A'.repeat(MAX_CUSTOM_ICON_DATA)}`, 'data:image/png;base64,not base64!', 42]) {
    assert.equal(normalizeItem({ type: 'note', customIcon: bad }).customIcon, '', String(bad).slice(0, 40));
  }
  assert.equal(customIconSrc(item), data);
  assert.equal(customIconSrc({ customIcon: 'https://a.com/x.png' }), '');
  assert.equal(customIconSrc(null), '');
});
