// Original capture implementation. Chrome permits two captureVisibleTab calls per second:
// https://developer.chrome.com/docs/extensions/reference/api/tabs#property-MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND
export const FULL_PAGE_LIMITS = Object.freeze({ maxAxis: 16_384, maxPixels: 48_000_000, maxTiles: 50 });

export function checkCaptureCancelled(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Full-page capture cancelled.');
}

export function planFullPageCapture(metrics, limits = FULL_PAGE_LIMITS) {
  const { documentWidth: width, documentHeight: height, viewportWidth, viewportHeight, devicePixelRatio: scale } = metrics;
  if (![width, height, viewportWidth, viewportHeight, scale].every(value => Number.isFinite(value) && value > 0)) throw new Error('The page returned invalid capture dimensions.');
  const outputWidth = Math.round(width * scale), outputHeight = Math.round(height * scale);
  if (outputWidth < 1 || outputHeight < 1) throw new Error('The page returned invalid capture dimensions.');
  const columns = Math.ceil(width / viewportWidth), rows = Math.ceil(height / viewportHeight);
  if (outputWidth > limits.maxAxis || outputHeight > limits.maxAxis || outputWidth * outputHeight > limits.maxPixels || columns * rows > limits.maxTiles) {
    throw new Error(`This page is too large for a full-page capture (${outputWidth} × ${outputHeight}, ${columns * rows} tiles). Limits: ${limits.maxAxis}px per side, ${Math.floor(limits.maxPixels / 1_000_000)} megapixels and ${limits.maxTiles} tiles. Use a visible screenshot instead.`);
  }
  const tiles = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const x = column * viewportWidth, y = row * viewportHeight;
    const right = Math.min(width, x + viewportWidth), bottom = Math.min(height, y + viewportHeight);
    // The final viewport may overlap, but the output rectangles never do.
    tiles.push({ index: tiles.length, x, y, width: right - x, height: bottom - y,
      scrollX: Math.min(x, Math.max(0, width - viewportWidth)), scrollY: Math.min(y, Math.max(0, height - viewportHeight)),
      outputX: Math.round(x * scale), outputY: Math.round(y * scale),
      outputWidth: Math.round(right * scale) - Math.round(x * scale), outputHeight: Math.round(bottom * scale) - Math.round(y * scale) });
  }
  return { ...metrics, width: outputWidth, height: outputHeight, tiles };
}

function abortableSleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    checkCaptureCancelled(signal);
    const abort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error('Full-page capture cancelled.')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// One FIFO shared by visible captures and every full-page job. 600ms leaves margin
// around Chrome's two-per-second boundary. Failed/aborted calls cannot poison it.
export function createCaptureRateLimiter({ now = () => performance.now(), sleep = abortableSleep, intervalMs = 600 } = {}) {
  let tail = Promise.resolve(), lastCall = -Infinity;
  return (capture, signal, beforeCapture = async () => {}) => {
    const operation = tail.then(async () => {
      checkCaptureCancelled(signal);
      const delay = Math.max(0, intervalMs - (now() - lastCall));
      if (delay) await sleep(delay, signal);
      await beforeCapture();
      checkCaptureCancelled(signal);
      lastCall = now();
      return capture();
    });
    tail = operation.catch(() => {});
    return operation;
  };
}
export const captureRateLimiter = createCaptureRateLimiter();

// These functions run only in Chrome's ISOLATED world. Each function is self
// contained because executeScript serializes its body, not this module scope.
export async function prepareFullPageCapture(jobId) {
  const key = '__stillOwnedFullPageCapture';
  if (globalThis[key]) throw new Error('A page capture is already preparing this document.');
  const root = document.documentElement, body = document.body;
  if (!root || !body) throw new Error('This document is not ready for capture.');
  if (Math.abs((globalThis.visualViewport?.scale || 1) - 1) > 0.01) throw new Error('Reset pinch zoom before capturing the full page.');
  const elements = document.querySelectorAll('*');
  if (elements.length > 50_000) throw new Error('This page has too many elements to prepare safely. Use a visible screenshot instead.');
  const repeated = [];
  for (const element of elements) {
    if (element === root || element === body) continue;
    const position = getComputedStyle(element).position;
    if (position === 'fixed' || position === 'sticky') repeated.push({ element, position, seen: false });
  }
  const state = { jobId, url: location.href, x: scrollX, y: scrollY, patches: new Map(), repeated, timer: null };
  function patch(element, property, value) {
    let record = state.patches.get(element);
    if (!record) { record = { original: element.getAttribute('style'), properties: new Map(), expected: element.getAttribute('style') }; state.patches.set(element, record); }
    if (!record.properties.has(property)) record.properties.set(property, { value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property) });
    element.style.setProperty(property, value, 'important');
    record.expected = element.getAttribute('style');
  }
  state.restore = () => {
    clearTimeout(state.timer);
    let concurrentStyleChanges = false;
    const unchanged = new Set();
    const scrollProperties = new Set(['scroll-behavior', 'scroll-snap-type', 'overflow-anchor']);
    // Restore layout first, keep smooth scrolling/snap disabled while returning
    // to the old position, then restore the exact original inline attributes.
    for (const [element, record] of state.patches) {
      if (element.getAttribute('style') === record.expected) unchanged.add(element);
      else concurrentStyleChanges = true;
      for (const [property, original] of record.properties) if (!scrollProperties.has(property)) {
        if (original.value) element.style.setProperty(property, original.value, original.priority); else element.style.removeProperty(property);
      }
    }
    globalThis.scrollTo(state.x, state.y);
    for (const [element, record] of state.patches) {
      if (unchanged.has(element)) {
        if (record.original === null) element.removeAttribute('style'); else element.setAttribute('style', record.original);
      } else {
        for (const [property, original] of record.properties) {
          if (original.value) element.style.setProperty(property, original.value, original.priority); else element.style.removeProperty(property);
        }
      }
    }
    if (globalThis[key] === state) delete globalThis[key];
    return { restored: true, concurrentStyleChanges };
  };
  state.touch = () => { clearTimeout(state.timer); state.timer = setTimeout(() => state.restore(), 20_000); };
  state.patch = patch;
  state.metrics = () => ({ documentWidth: Math.max(root.scrollWidth, body.scrollWidth, innerWidth), documentHeight: Math.max(root.scrollHeight, body.scrollHeight, innerHeight),
    viewportWidth: innerWidth, viewportHeight: innerHeight, devicePixelRatio, url: location.href });
  globalThis[key] = state;
  try {
    for (const element of [root, body]) {
      patch(element, 'scroll-behavior', 'auto'); patch(element, 'scroll-snap-type', 'none'); patch(element, 'overflow-anchor', 'none');
    }
    // Remove viewport scrollbars; programmatic scroll remains available.
    patch(root, 'overflow', 'hidden');
    state.touch();
    globalThis.scrollTo(0, 0);
    await new Promise(resolve => { let done = false; const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } }; const timer = setTimeout(finish, 200); requestAnimationFrame(() => requestAnimationFrame(finish)); });
    return state.metrics();
  } catch (error) { state.restore(); throw error; }
}

export async function scrollFullPageCapture(jobId, tile) {
  const state = globalThis.__stillOwnedFullPageCapture;
  if (!state || state.jobId !== jobId || state.url !== location.href) throw new Error('The capture document changed or its preparation expired.');
  state.touch();
  // A sticky element is hidden only once a previous tile has included it.
  // This preserves sticky headings that first appear farther down the document.
  if (tile.index > 0) for (const entry of state.repeated) if (!entry.hidden && (entry.seen || entry.position === 'fixed')) {
    state.patch(entry.element, 'visibility', 'hidden'); entry.hidden = true;
  }
  globalThis.scrollTo(tile.scrollX, tile.scrollY);
  await new Promise(resolve => { let done = false; const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } }; const timer = setTimeout(finish, 200); requestAnimationFrame(() => requestAnimationFrame(finish)); });
  for (const entry of state.repeated) {
    const rect = entry.element.getBoundingClientRect();
    if (rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight) entry.seen = true;
  }
  return { ...state.metrics(), scrollX: globalThis.scrollX, scrollY: globalThis.scrollY };
}

export function inspectFullPageCapture(jobId) {
  const state = globalThis.__stillOwnedFullPageCapture;
  if (!state || state.jobId !== jobId || state.url !== location.href) throw new Error('The capture document changed or its preparation expired.');
  state.touch();
  return { ...state.metrics(), scrollX: globalThis.scrollX, scrollY: globalThis.scrollY };
}

export function restoreFullPageCapture(jobId) {
  const state = globalThis.__stillOwnedFullPageCapture;
  return state?.jobId === jobId ? state.restore() : { restored: false };
}

export function pngDataUrlBlob(dataUrl) {
  if (typeof dataUrl !== 'string' || !/^data:image\/png;base64,[a-z\d+/]+=*$/i.test(dataUrl)) throw new Error('Chrome did not return a valid PNG screenshot.');
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), character => character.charCodeAt(0));
  if (bytes.length < 24 || bytes.slice(0, 8).some((value, index) => value !== [137, 80, 78, 71, 13, 10, 26, 10][index])) throw new Error('Chrome returned unreadable screenshot bytes.');
  return new Blob([bytes], { type: 'image/png' });
}

export async function stitchFullPageTiles(plan, captures, { signal, Canvas = globalThis.OffscreenCanvas, decode = globalThis.createImageBitmap } = {}) {
  checkCaptureCancelled(signal);
  if (!Canvas || !decode) throw new Error('This Chrome version cannot stitch a full-page screenshot.');
  if (captures.length !== plan.tiles.length) throw new Error('The full-page capture is incomplete.');
  const canvas = new Canvas(plan.width, plan.height), context = canvas.getContext('2d', { alpha: false });
  if (!context) { canvas.width = 0; canvas.height = 0; throw new Error('Chrome could not allocate the full-page image.'); }
  try {
    for (let index = 0; index < captures.length; index++) {
      checkCaptureCancelled(signal);
      const capture = captures[index], tile = plan.tiles[index];
      const bitmap = await decode(pngDataUrlBlob(capture.dataUrl));
      try {
        checkCaptureCancelled(signal);
        if (Math.abs(bitmap.width - Math.round(plan.viewportWidth * plan.devicePixelRatio)) > 1 || Math.abs(bitmap.height - Math.round(plan.viewportHeight * plan.devicePixelRatio)) > 1) throw new Error('The browser viewport changed size during capture.');
        const scaleX = bitmap.width / plan.viewportWidth, scaleY = bitmap.height / plan.viewportHeight;
        const sourceX = (tile.x - capture.scrollX) * scaleX, sourceY = (tile.y - capture.scrollY) * scaleY;
        if (sourceX < -1 || sourceY < -1 || sourceX + tile.width * scaleX > bitmap.width + 1 || sourceY + tile.height * scaleY > bitmap.height + 1) throw new Error('The page could not scroll to the required capture position.');
        context.drawImage(bitmap, Math.max(0, sourceX), Math.max(0, sourceY), tile.width * scaleX, tile.height * scaleY, tile.outputX, tile.outputY, tile.outputWidth, tile.outputHeight);
      } finally { bitmap.close(); }
    }
    checkCaptureCancelled(signal);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    checkCaptureCancelled(signal);
    const ratio = Math.min(1, 640 / Math.max(plan.width, plan.height));
    const thumbnail = new Canvas(Math.max(1, Math.round(plan.width * ratio)), Math.max(1, Math.round(plan.height * ratio)));
    try {
      const previewContext = thumbnail.getContext('2d', { alpha: false });
      if (!previewContext) throw new Error('Chrome could not allocate a screenshot preview.');
      previewContext.drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
      const preview = await thumbnail.convertToBlob({ type: 'image/webp', quality: 0.8 });
      const bytes = new Uint8Array(await preview.arrayBuffer());
      let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      checkCaptureCancelled(signal);
      return { blob, cover: `data:${preview.type};base64,${btoa(binary)}`, width: plan.width, height: plan.height, tileCount: plan.tiles.length };
    } finally { thumbnail.width = 0; thumbnail.height = 0; }
  } finally { canvas.width = 0; canvas.height = 0; }
}

// A bounded WebP card preview (data URL, longest side <= maxSide) for a screenshot. The full PNG lives in the
// attachment store; a full-resolution data URL in `cover` would be rewritten with the whole library on every save.
export async function imagePreviewDataUrl(blob, { maxSide = 640, Canvas = globalThis.OffscreenCanvas, decode = globalThis.createImageBitmap } = {}) {
  if (!Canvas || !decode) throw new Error('This Chrome version cannot create a screenshot preview.');
  const bitmap = await decode(blob);
  let canvas;
  try {
    const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    canvas = new Canvas(Math.max(1, Math.round(bitmap.width * ratio)), Math.max(1, Math.round(bitmap.height * ratio)));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Chrome could not allocate a screenshot preview.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const preview = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    const bytes = new Uint8Array(await preview.arrayBuffer());
    let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return `data:${preview.type || 'image/webp'};base64,${btoa(binary)}`;
  } finally {
    bitmap.close?.();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

export async function assertCaptureTab(api, tab) {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId) || !/^https?:\/\//i.test(tab.url || '')) throw new Error('Open an http or https webpage before saving a screenshot.');
  const [current] = await api.tabs.query({ active: true, windowId: tab.windowId });
  if (current?.id !== tab.id) throw new Error('The active tab changed. Save the screenshot again.');
  if (current.url !== tab.url || (current.pendingUrl && current.pendingUrl !== tab.url)) throw new Error('The page URL changed during capture. Save the screenshot again.');
  return current;
}

export async function captureFullPagePixels(tab, { api, jobId, signal, onProgress = () => {}, limiter = captureRateLimiter, stitch = stitchFullPageTiles, limits = FULL_PAGE_LIMITS } = {}) {
  await assertCaptureTab(api, tab);
  checkCaptureCancelled(signal);
  let prepared = false, documentId, plan, result, failure;
  const captures = [];
  const inject = async (func, args) => {
    const target = { tabId: tab.id, ...(documentId ? { documentIds: [documentId] } : { frameIds: [0] }) };
    const response = await api.scripting.executeScript({ target, world: 'ISOLATED', func, args });
    const main = response?.[0];
    if (!main || main.error) throw new Error(main?.error?.message || 'Chrome could not access the capture document.');
    if (documentId && main.documentId && main.documentId !== documentId) throw new Error('The capture document changed.');
    if (!documentId) documentId = main.documentId;
    return main.result;
  };
  const checkMetrics = metrics => {
    if (!metrics || metrics.url !== tab.url || ['documentWidth', 'documentHeight', 'viewportWidth', 'viewportHeight', 'devicePixelRatio'].some(key => !Number.isFinite(metrics[key]) || Math.abs(metrics[key] - plan[key]) > 0.01)) throw new Error('The page layout or URL changed during capture. Try again after it finishes loading.');
  };
  try {
    onProgress({ status: 'preparing', completed: 0, total: 0 });
    // Set before injection: even an interrupted preparation gets a restore attempt.
    prepared = true;
    const metrics = await inject(prepareFullPageCapture, [jobId]);
    checkCaptureCancelled(signal);
    if (metrics.url !== tab.url) throw new Error('The page URL changed during capture.');
    plan = planFullPageCapture(metrics, limits);
    for (const tile of plan.tiles) {
      checkCaptureCancelled(signal);
      await assertCaptureTab(api, tab);
      const position = await inject(scrollFullPageCapture, [jobId, tile]);
      checkMetrics(position);
      if (Math.abs(position.scrollX - tile.scrollX) > 1 || Math.abs(position.scrollY - tile.scrollY) > 1) throw new Error('The page did not reach the requested scroll position.');
      const dataUrl = await limiter(() => api.tabs.captureVisibleTab(tab.windowId, { format: 'png' }), signal, async () => {
        checkCaptureCancelled(signal);
        await assertCaptureTab(api, tab);
        const before = await inject(inspectFullPageCapture, [jobId]);
        checkMetrics(before);
        if (Math.abs(before.scrollX - position.scrollX) > 0.01 || Math.abs(before.scrollY - position.scrollY) > 0.01) throw new Error('The page scrolled during capture. Keep the tab still and try again.');
      });
      await assertCaptureTab(api, tab);
      const after = await inject(inspectFullPageCapture, [jobId]);
      checkMetrics(after);
      if (Math.abs(after.scrollX - position.scrollX) > 0.01 || Math.abs(after.scrollY - position.scrollY) > 0.01) throw new Error('The page scrolled during capture. Keep the tab still and try again.');
      checkCaptureCancelled(signal);
      pngDataUrlBlob(dataUrl);
      captures.push({ dataUrl, scrollX: position.scrollX, scrollY: position.scrollY });
      onProgress({ status: 'capturing', completed: captures.length, total: plan.tiles.length, width: plan.width, height: plan.height });
    }
  } catch (error) { failure = error; }
  finally {
    if (prepared) {
      try {
        const restored = await inject(restoreFullPageCapture, [jobId]);
        if (!restored?.restored && !failure) failure = new Error('Page preparation expired before capture completed.');
      } catch (error) {
        // Navigated documents are gone. An inaccessible old document also has a
        // 20-second restoration watchdog; never inject into a replacement frame.
        failure = new Error(`${failure?.message || 'Full-page capture stopped.'} Page restoration could not be confirmed: ${error.message}`);
      }
    }
  }
  if (failure) throw failure;
  checkCaptureCancelled(signal);
  onProgress({ status: 'stitching', completed: captures.length, total: plan.tiles.length, width: plan.width, height: plan.height });
  try { result = await stitch(plan, captures, { signal }); }
  finally { captures.length = 0; }
  checkCaptureCancelled(signal);
  return result;
}
