import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { planFullPageCapture, createCaptureRateLimiter, prepareFullPageCapture, scrollFullPageCapture, restoreFullPageCapture,
  captureFullPagePixels, stitchFullPageTiles, pngDataUrlBlob, imagePreviewDataUrl } from '../extension/lib/full-page-capture.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=';
const tab = { id: 7, windowId: 1, url: 'https://example.com/page', title: 'An example' };
const metrics = (extra = {}) => ({ documentWidth: 250, documentHeight: 190, viewportWidth: 100, viewportHeight: 80, devicePixelRatio: 1, ...extra });
const immediateLimiter = async (capture, signal, before = async () => {}) => { await before(); if (signal?.aborted) throw signal.reason; return capture(); };

test('planner covers both axes exactly, including cropped last rows/columns and fractional DPR', () => {
  const plan = planFullPageCapture(metrics({ devicePixelRatio: 1.25 }));
  assert.equal(plan.tiles.length, 9);
  assert.deepEqual([plan.width, plan.height], [313, 238]);
  const last = plan.tiles.at(-1);
  assert.deepEqual([last.x, last.y, last.scrollX, last.scrollY, last.width, last.height], [200, 160, 150, 110, 50, 30]);
  assert.equal(plan.tiles.reduce((sum, tile) => sum + tile.outputWidth * tile.outputHeight, 0), plan.width * plan.height);
  const pixels = new Uint8Array(plan.width * plan.height);
  for (const tile of plan.tiles) for (let y = tile.outputY; y < tile.outputY + tile.outputHeight; y++) for (let x = tile.outputX; x < tile.outputX + tile.outputWidth; x++) pixels[y * plan.width + x]++;
  assert.ok(pixels.every(value => value === 1), 'no missing or overlapping output pixels');
});

test('planner rejects every output limit explicitly instead of returning a partial image', () => {
  assert.throws(() => planFullPageCapture(metrics({ documentHeight: 17_000 })), /too large.*17000/s);
  assert.throws(() => planFullPageCapture(metrics({ documentWidth: 7000, documentHeight: 7000, viewportWidth: 7000, viewportHeight: 7000 })), /48 megapixels/);
  assert.throws(() => planFullPageCapture(metrics({ documentWidth: 100, documentHeight: 5100, viewportHeight: 100 })), /51 tiles/);
  assert.throws(() => planFullPageCapture(metrics({ viewportWidth: 0 })), /invalid capture dimensions/);
});

test('FIFO limiter enforces Chrome spacing at native invocation and survives failure/cancellation', async () => {
  let now = 0;
  const times = [], sleeps = [];
  const limiter = createCaptureRateLimiter({ now: () => now, sleep: async (delay, signal) => { if (signal?.aborted) throw signal.reason; sleeps.push(delay); now += delay; } });
  const capture = () => { times.push(now); return now; };
  await Promise.all([limiter(capture, undefined, async () => { now += 750; }), limiter(capture), limiter(capture)]);
  assert.deepEqual(times, [750, 1350, 1950]);
  const cancelled = new AbortController(); cancelled.abort(new Error('cancelled in queue'));
  await assert.rejects(limiter(capture, cancelled.signal), /cancelled in queue/);
  await assert.rejects(limiter(() => { throw new Error('native failure'); }), /native failure/);
  await limiter(capture);
  assert.deepEqual(times, [750, 1350, 1950, 3150]);
  assert.ok(sleeps.every(delay => delay >= 600));
});

// This DOM fixture runs our own injected functions, never Fabric's scripts.
function pageFixture({ width = 250, height = 190 } = {}) {
  const environment = { console, setTimeout, clearTimeout, queueMicrotask, location: { href: tab.url }, innerWidth: 100, innerHeight: 80, devicePixelRatio: 1,
    scrollX: 23, scrollY: 31, visualViewport: { scale: 1 }, requestAnimationFrame: callback => queueMicrotask(callback) };
  const makeElement = (position = 'static', original = null, top = 0) => {
    let attribute = original;
    const values = new Map();
    const parse = () => { values.clear(); for (const declaration of (attribute || '').split(';')) { const colon = declaration.indexOf(':'); if (colon < 0) continue; const value = declaration.slice(colon + 1).trim(); values.set(declaration.slice(0, colon).trim(), { value: value.replace(/\s*!important$/, ''), priority: /!important$/.test(value) ? 'important' : '' }); } };
    const write = () => { attribute = [...values].map(([property, entry]) => `${property}: ${entry.value}${entry.priority ? ' !important' : ''};`).join(' '); };
    parse();
    return { position, scrollWidth: width, scrollHeight: height,
      style: { getPropertyValue: property => values.get(property)?.value || '', getPropertyPriority: property => values.get(property)?.priority || '',
        setProperty: (property, value, priority = '') => { values.set(property, { value, priority }); write(); }, removeProperty: property => { values.delete(property); write(); } },
      getAttribute: name => name === 'style' ? attribute : null,
      setAttribute: (name, value) => { if (name === 'style') { attribute = value; parse(); } }, removeAttribute: name => { if (name === 'style') { attribute = null; parse(); } },
      getBoundingClientRect: () => ({ left: 0, right: 90, top: position === 'fixed' ? top : Math.max(0, top - environment.scrollY), bottom: (position === 'fixed' ? top : Math.max(0, top - environment.scrollY)) + 20 }) };
  };
  const root = makeElement('static', 'color: red; scroll-behavior: smooth;'), body = makeElement();
  const fixed = makeElement('fixed', 'visibility: visible !important;'), below = makeElement('sticky', null, 120);
  const elements = [root, body, fixed, below];
  environment.document = { documentElement: root, body, querySelectorAll: () => elements };
  environment.getComputedStyle = element => ({ position: element.position });
  environment.scrollTo = (x, y) => { environment.scrollX = Math.max(0, Math.min(x, width - environment.innerWidth)); environment.scrollY = Math.max(0, Math.min(y, height - environment.innerHeight)); };
  const context = vm.createContext(environment);
  const run = (func, args) => { context.__arguments = args; return vm.runInContext(`(${func.toString()})(...__arguments)`, context); };
  return { environment, root, body, fixed, below, run };
}

test('isolated preparation restores exact styles and scroll; repeated chrome hides only after a tile includes it', async () => {
  const page = pageFixture();
  const originals = [page.root, page.body, page.fixed, page.below].map(element => element.getAttribute('style'));
  try {
    const prepared = await page.run(prepareFullPageCapture, ['owned-job']);
    const plan = planFullPageCapture(prepared);
    await page.run(scrollFullPageCapture, ['owned-job', plan.tiles[0]]);
    assert.equal(page.fixed.style.getPropertyValue('visibility'), 'visible');
    assert.equal(page.below.style.getPropertyValue('visibility'), '');
    await page.run(scrollFullPageCapture, ['owned-job', plan.tiles[1]]);
    assert.equal(page.fixed.style.getPropertyValue('visibility'), 'hidden');
    assert.equal(page.below.style.getPropertyValue('visibility'), '', 'unseen lower sticky heading remains in the document');
    await page.run(scrollFullPageCapture, ['owned-job', plan.tiles[3]]);
    assert.equal(page.below.style.getPropertyValue('visibility'), '');
    await page.run(scrollFullPageCapture, ['owned-job', plan.tiles[4]]);
    assert.equal(page.below.style.getPropertyValue('visibility'), 'hidden');
    assert.equal(page.run(restoreFullPageCapture, ['different-job']).restored, false);
  } finally { page.run(restoreFullPageCapture, ['owned-job']); }
  assert.deepEqual([page.root, page.body, page.fixed, page.below].map(element => element.getAttribute('style')), originals);
  assert.deepEqual([page.environment.scrollX, page.environment.scrollY], [23, 31]);
  assert.equal(page.environment.__stillOwnedFullPageCapture, undefined);
});

test('restoration preserves unrelated style edits made by a page during capture', async () => {
  const page = pageFixture();
  await page.run(prepareFullPageCapture, ['concurrent-job']);
  page.root.style.setProperty('color', 'blue');
  const result = page.run(restoreFullPageCapture, ['concurrent-job']);
  assert.equal(result.concurrentStyleChanges, true);
  assert.equal(page.root.style.getPropertyValue('color'), 'blue');
  assert.equal(page.root.style.getPropertyValue('scroll-behavior'), 'smooth');
  assert.equal(page.root.style.getPropertyValue('overflow'), '');
  assert.equal(page.body.getAttribute('style'), null);
});

function captureFixture(options = {}) {
  const page = pageFixture(options), scripts = [], progress = [], captures = [];
  let current = { ...tab }, count = 0;
  const api = { runtime: { sendMessage: async () => {} }, tabs: { query: async () => [current], captureVisibleTab: async () => {
    count++; captures.push([page.environment.scrollX, page.environment.scrollY]); await options.onCapture?.(count, { page, setCurrent: value => { current = value; } }); return png;
  } }, scripting: { executeScript: async request => {
    scripts.push(request); assert.equal(request.world, 'ISOLATED');
    if (scripts.length > 1) assert.deepEqual(request.target.documentIds, ['original-document']);
    return [{ documentId: 'original-document', frameId: 0, result: await page.run(request.func, request.args) }];
  } } };
  const stitch = async (plan, values) => {
    assert.equal(page.environment.__stillOwnedFullPageCapture, undefined, 'document restored before stitching');
    assert.equal(values.length, plan.tiles.length);
    return { blob: new Blob(['png'], { type: 'image/png' }), cover: 'data:image/webp;base64,YQ==', width: plan.width, height: plan.height, tileCount: values.length };
  };
  return { api, page, scripts, captures, progress, stitch };
}

test('capture captures all tiles, targets the original document and restores before stitching', async () => {
  const fixture = captureFixture();
  const result = await captureFullPagePixels(tab, { ...fixture, jobId: 'capture-success', limiter: immediateLimiter, onProgress: value => fixture.progress.push(value) });
  assert.deepEqual(fixture.captures, [[0, 0], [100, 0], [150, 0], [0, 80], [100, 80], [150, 80], [0, 110], [100, 110], [150, 110]]);
  assert.equal(result.tileCount, 9);
  assert.equal(fixture.progress.at(-1).status, 'stitching');
  assert.deepEqual([fixture.page.environment.scrollX, fixture.page.environment.scrollY], [23, 31]);
});

test('50-tile capture renews the restoration watchdog across a 30-second job', async () => {
  let now = 0, nextId = 0;
  const timers = new Map();
  const advance = milliseconds => {
    now += milliseconds;
    for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.callback();
  };
  const fixture = captureFixture({ width: 100, height: 4000, onCapture: () => advance(600) });
  fixture.page.environment.setTimeout = (callback, delay) => { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; };
  fixture.page.environment.clearTimeout = id => timers.delete(id);
  const result = await captureFullPagePixels(tab, { ...fixture, jobId: 'capture-long-heartbeat', limiter: immediateLimiter });
  assert.equal(result.tileCount, 50);
  assert.equal(now, 30_000);
  assert.equal(timers.size, 0, 'restoration removes its watchdog after success');
  assert.equal(fixture.page.environment.__stillOwnedFullPageCapture, undefined);
});

test('an abandoned preparation watchdog restores original page state without a worker', async () => {
  const page = pageFixture();
  const timers = new Map(); let nextId = 0;
  page.environment.setTimeout = (callback, delay) => { const id = ++nextId; timers.set(id, { callback, delay }); return id; };
  page.environment.clearTimeout = id => timers.delete(id);
  await page.run(prepareFullPageCapture, ['abandoned-capture']);
  const watchdog = [...timers.values()].find(timer => timer.delay === 20_000);
  assert.ok(watchdog);
  watchdog.callback();
  assert.equal(page.environment.__stillOwnedFullPageCapture, undefined);
  assert.equal(page.root.getAttribute('style'), 'color: red; scroll-behavior: smooth;');
  assert.deepEqual([page.environment.scrollX, page.environment.scrollY], [23, 31]);
  assert.equal(timers.size, 0);
});

test('cancellation during an in-flight native capture restores the page and never stitches partial content', async () => {
  const controller = new AbortController();
  const fixture = captureFixture({ onCapture: () => controller.abort(new Error('Full-page capture cancelled.')) });
  let stitched = false;
  await assert.rejects(captureFullPagePixels(tab, { ...fixture, jobId: 'capture-cancel', signal: controller.signal, limiter: immediateLimiter,
    stitch: async () => { stitched = true; } }), /cancelled/);
  assert.equal(fixture.captures.length, 1);
  assert.equal(stitched, false);
  assert.equal(fixture.page.environment.__stillOwnedFullPageCapture, undefined);
  assert.equal(fixture.page.root.getAttribute('style'), 'color: red; scroll-behavior: smooth;');
});

test('tab switches, URL changes and layout changes abort with restoration before persistence', async () => {
  for (const kind of ['tab', 'url', 'layout']) {
    const fixture = captureFixture({ onCapture: (count, { page, setCurrent }) => {
      if (kind === 'tab') setCurrent({ ...tab, id: 99 });
      if (kind === 'url') setCurrent({ ...tab, url: 'https://example.com/elsewhere' });
      if (kind === 'layout') page.root.scrollHeight += 100;
    } });
    await assert.rejects(captureFullPagePixels(tab, { ...fixture, jobId: `capture-${kind}`, limiter: immediateLimiter }), /active tab changed|URL changed|layout/);
    assert.equal(fixture.page.environment.__stillOwnedFullPageCapture, undefined);
  }
});

test('over-limit pages and native errors still restore prepared CSS and position', async () => {
  const over = captureFixture({ height: 18_000 });
  await assert.rejects(captureFullPagePixels(tab, { ...over, jobId: 'capture-large', limiter: immediateLimiter }), /too large/);
  assert.equal(over.captures.length, 0);
  assert.equal(over.page.environment.__stillOwnedFullPageCapture, undefined);
  const broken = captureFixture({ onCapture: () => { throw new Error('Chrome capture failed'); } });
  await assert.rejects(captureFullPagePixels(tab, { ...broken, jobId: 'capture-error', limiter: immediateLimiter }), /Chrome capture failed/);
  assert.deepEqual([broken.page.environment.scrollX, broken.page.environment.scrollY], [23, 31]);
});

test('stitcher crops overlapping final viewports, closes images and creates a bounded WebP preview', async () => {
  const calls = [], canvases = [], images = [];
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; canvases.push(this); }
    getContext() { return { drawImage: (...args) => calls.push(args) }; }
    async convertToBlob({ type }) { return new Blob(['pixels'], { type }); }
  }
  const plan = planFullPageCapture(metrics({ devicePixelRatio: 2 }));
  const captured = plan.tiles.map(tile => ({ dataUrl: png, scrollX: tile.scrollX, scrollY: tile.scrollY }));
  const decode = async () => { const bitmap = { width: 200, height: 160, closed: false, close() { this.closed = true; } }; images.push(bitmap); return bitmap; };
  const result = await stitchFullPageTiles(plan, captured, { Canvas, decode });
  assert.deepEqual(calls[8].slice(1), [100, 100, 100, 60, 400, 320, 100, 60]);
  assert.ok(images.every(bitmap => bitmap.closed));
  assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  assert.equal(result.blob.type, 'image/png');
  assert.match(result.cover, /^data:image\/webp;base64,/);
  assert.deepEqual([result.width, result.height], [500, 380]);
  assert.throws(() => pngDataUrlBlob('https://example.com/untrusted.png'), /valid PNG/);
  const bad = new AbortController(); bad.abort(new Error('cancelled before stitching'));
  await assert.rejects(stitchFullPageTiles(plan, captured, { Canvas, decode, signal: bad.signal }), /cancelled before stitching/);
  const mismatch = async () => ({ width: 300, height: 160, close() { this.closed = true; } });
  await assert.rejects(stitchFullPageTiles(plan, captured, { Canvas, decode: mismatch }), /viewport changed/);
});

test('screenshot preview is a bounded WebP data URL and releases its bitmap and canvas', async () => {
  const canvases = [], drawn = [];
  let closed = false;
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; canvases.push(this); }
    getContext() { return { drawImage: (...args) => drawn.push(args) }; }
    async convertToBlob({ type }) { return new Blob(['webp-bytes'], { type }); }
  }
  const decode = async () => ({ width: 2560, height: 1440, close() { closed = true; } });
  const preview = await imagePreviewDataUrl(pngDataUrlBlob(png), { Canvas, decode });
  assert.equal(preview, `data:image/webp;base64,${Buffer.from('webp-bytes').toString('base64')}`);
  assert.deepEqual(drawn[0].slice(1), [0, 0, 640, 360], 'longest side scaled to 640');
  assert.ok(closed && canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  await assert.rejects(imagePreviewDataUrl(pngDataUrlBlob(png), { Canvas: undefined, decode }), /cannot create a screenshot preview/);
  const small = await imagePreviewDataUrl(pngDataUrlBlob(png), { Canvas, decode: async () => ({ width: 1, height: 1, close() {} }) });
  assert.match(small, /^data:image\/webp;base64,/);
  assert.deepEqual(drawn.at(-1).slice(1), [0, 0, 1, 1], 'never upscaled');
});

// The following exercises job/persistence ownership with a mocked Chrome edge.
// It does not establish native extension activation or actual raster fidelity.
globalThis.chrome = { runtime: { id: 'test-full-page' } };
const { startFullPageCapture, cancelFullPageCapture, getFullPageCaptureJob, handleMessage } = await import('../extension/background.js');
function jobDependencies(extra = {}) {
  const persisted = [], removed = [], messages = [];
  return { persisted, removed, messages, captureApi: { runtime: { sendMessage: async message => { messages.push(message); throw new Error('receiving view closed'); } }, tabs: { query: async () => [{ ...tab }] } },
    capturePixels: async (source, { onProgress }) => { onProgress({ status: 'stitching', completed: 2, total: 2, width: 100, height: 160 }); return { blob: new Blob(['png'], { type: 'image/png' }), cover: 'data:image/webp;base64,YQ==', width: 100, height: 160, tileCount: 2 }; },
    persistAttachment: async file => ({ attachmentId: 'owned-file', fileName: file.name }), removeAttachment: async id => { removed.push(id); },
    persistItem: async item => { persisted.push(item); return { ...item, id: 'saved-image' }; }, ...extra };
}

test('owned job persists one local PNG/source item and progress tolerates a closed extension view', async () => {
  const deps = jobDependencies();
  const job = startFullPageCapture(tab, { ...deps, jobId: 'job-success' });
  const result = await job.promise;
  assert.equal(result.jobId, job.id);
  assert.equal(result.id, 'saved-image');
  assert.equal(result.tileCount, 2);
  assert.equal(deps.persisted.length, 1);
  assert.equal(deps.persisted[0].sourceUrl, tab.url);
  assert.equal(deps.persisted[0].attachmentId, 'owned-file');
  assert.equal(deps.messages.at(-1).status, 'saved');
  assert.equal(deps.messages.at(-1).itemId, result.id);
  assert.equal(getFullPageCaptureJob(job.id).status, 'saved');
  assert.equal(getFullPageCaptureJob(job.id).itemId, result.id);
  assert.ok(deps.messages.filter(message => message.status !== 'saved').every(message => !Object.hasOwn(message, 'itemId')));
  assert.equal(job.cancel().cancelled, false);
  await assert.rejects(handleMessage({ type: 'cancelFullPageCapture', jobId: job.id }, { id: 'untrusted' }), /Untrusted/);
});

test('job cancellation owns one handle and cleans a PNG created during an in-flight attachment write', async () => {
  let started, release;
  const writing = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const deps = jobDependencies({ persistAttachment: async () => { started(); await gate; return { attachmentId: 'cancelled-owned-file' }; } });
  const job = startFullPageCapture(tab, { ...deps, jobId: 'job-cancelled' });
  const rejected = assert.rejects(job.promise, /cancelled/);
  await writing;
  assert.throws(() => startFullPageCapture(tab, { ...deps, jobId: 'job-overlapping' }), /already running/);
  assert.equal(cancelFullPageCapture('someone-elses-job').cancelled, false);
  assert.equal(job.cancel().cancelled, true);
  release(); await rejected;
  assert.deepEqual(deps.removed, ['cancelled-owned-file']);
  assert.equal(deps.persisted.length, 0);
  assert.equal(getFullPageCaptureJob(job.id).status, 'cancelled');
});

test('a cancel arriving while active-tab lookup is pending already has an owned handle', async () => {
  let resolveTab, captured = false;
  const source = new Promise(resolve => { resolveTab = resolve; });
  const deps = jobDependencies({ capturePixels: async () => { captured = true; throw new Error('unexpected capture'); } });
  const job = startFullPageCapture(source, { ...deps, jobId: 'job-tab-query-race' });
  const rejected = assert.rejects(job.promise, /cancelled/);
  assert.equal(getFullPageCaptureJob().jobId, job.id);
  assert.equal(job.cancel().cancelled, true);
  resolveTab(tab); await rejected;
  assert.equal(captured, false);
  assert.equal(getFullPageCaptureJob(), null);
});

test('job persistence failure removes only its attachment; final commit cannot claim cancellation', async () => {
  const deps = jobDependencies({ persistItem: async () => { throw new Error('Library storage failed'); } });
  const failed = startFullPageCapture(tab, { ...deps, jobId: 'job-persist-failure' });
  await assert.rejects(failed.promise, /Library storage failed/);
  assert.deepEqual(deps.removed, ['owned-file']);
  assert.equal(getFullPageCaptureJob(failed.id).status, 'error');
  assert.ok(deps.messages.every(message => !Object.hasOwn(message, 'itemId')));
  let started, release;
  const committing = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const next = jobDependencies({ persistItem: async item => { started(); await gate; return { ...item, id: 'committed' }; } });
  const saving = startFullPageCapture(tab, { ...next, jobId: 'job-commit-phase' });
  await committing;
  assert.equal(getFullPageCaptureJob(saving.id).status, 'saving');
  assert.equal(next.messages.at(-1).status, 'saving');
  assert.deepEqual(saving.cancel(), { jobId: saving.id, cancelled: false, status: 'saving' });
  release(); assert.equal((await saving.promise).id, 'committed');
  assert.deepEqual(next.removed, []);
});
