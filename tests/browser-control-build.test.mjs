import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GENERATED_FILES, GENERATED_PACKAGES, GENERATED_REQUIRED, GENERATED_SOURCE_HASH, layerSourceHash } from '../scripts/generated.mjs';
import { LAYER_ERROR_CODES, LAYER_REFUSAL_NOTICE, LAYER_TOOLS, LAYER_VERSION } from '../extension/lib/browser-control/catalogue.js';

const extensionFile = path => new URL(`../extension/${path}`, import.meta.url);

test('every generated file is pinned and the committed bytes match the pin', async () => {
  for (const path of GENERATED_REQUIRED) assert.ok(GENERATED_FILES.some(entry => entry.path === path), `${path} has a pin`);
  for (const entry of GENERATED_FILES) {
    const bytes = await readFile(extensionFile(entry.path));
    assert.equal(bytes.length, entry.bytes, `${entry.path} byte length`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.path} SHA-256`);
    assert.ok((await readFile(extensionFile(entry.license))).length > 1000, `${entry.path} has its notices`);
  }
});

test('the committed layer was built from the layer sources as they are now', async () => {
  assert.match(GENERATED_SOURCE_HASH, /^[0-9a-f]{64}$/);
  assert.equal(await layerSourceHash(), GENERATED_SOURCE_HASH, 'run "npm run build" in browser-control after changing it');
});

test('the pins name the packages inside the bundle', () => {
  assert.equal(GENERATED_PACKAGES['puppeteer-core'], '25.16.0');
  assert.equal(GENERATED_PACKAGES.zod, '4.6.7');
  // The WebDriver BiDi code is left out of the build (browser-control/build.mjs).
  assert.equal(GENERATED_PACKAGES['chromium-bidi'], undefined);
});

test('the notices name the layer, its origin and each bundled package', async () => {
  const notices = await readFile(extensionFile('assets/licenses/browser-control.txt'), 'utf8');
  for (const phrase of ['Still Agent browser control layer', 'Nanobrowser', 'puppeteer-core 25.16.0', 'zod 4.6.7', 'Apache License', 'MIT License']) {
    assert.ok(notices.includes(phrase), `notices mention ${phrase}`);
  }
});

test('the layer bundle imports nothing and evaluates the layer only on demand', async () => {
  const source = await readFile(extensionFile('lib/browser-control/layer.js'), 'utf8');
  assert.ok(source.startsWith('// Still browser control layer'), 'the banner says what the file is');
  // A module worker cannot use import(): the build must have turned the lazy imports into in-file initializers.
  assert.equal(/\bimport\s*\(/.test(source), false);
  assert.equal(/^\s*import\s/m.test(source), false);
  const before = new Set(Object.keys(globalThis));
  globalThis.chrome ??= {};
  const module = await import('../extension/lib/browser-control/layer.js');
  assert.deepEqual(Object.keys(module), ['loadBrowserControl']);
  const layer = await module.loadBrowserControl();
  assert.equal(typeof layer.createChromeController, 'function');
  assert.equal(typeof layer.siteOf, 'function');
  assert.equal(layer.siteOf('https://www.Example.com:8443/a'), 'example.com:8443');
  // Loading adds only what its packages are known to set: zod's shared config and registry, and Puppeteer's
  // URLPattern stand-in where the runtime has none (Chrome has its own).
  const known = new Set(['chrome', '__zod_globalConfig', '__zod_globalRegistry', 'URLPattern']);
  assert.deepEqual([...Object.keys(globalThis)].filter(key => !before.has(key) && !known.has(key)), []);
  assert.equal(globalThis.__zod_globalConfig?.jitless, true, 'zod is told not to probe for eval');
  assert.equal(await module.loadBrowserControl(), layer, 'a second call returns the same layer');
});

test('the catalogue is the layer\'s own tool list, as data', async () => {
  const { loadBrowserControl } = await import('../extension/lib/browser-control/layer.js');
  const layer = await loadBrowserControl();
  assert.equal(LAYER_VERSION, '0.3.0');
  assert.deepEqual([...LAYER_ERROR_CODES], [...layer.ERROR_CODES]);
  assert.equal(LAYER_REFUSAL_NOTICE, layer.REFUSAL_NOTICE);
  const specs = layer.TOOL_SPECS.filter(spec => spec.available);
  assert.deepEqual(LAYER_TOOLS.map(tool => tool.name), specs.map(spec => spec.name));
  assert.deepEqual(LAYER_TOOLS.map(tool => tool.name), ['snapshot', 'find', 'read', 'screenshot', 'click', 'set', 'fill_form', 'type', 'press', 'hover', 'scroll',
    'wait', 'navigate', 'tabs', 'upload', 'handle_dialog', 'ask_user', 'watch_download']);
  for (const [index, tool] of LAYER_TOOLS.entries()) {
    const spec = specs[index];
    assert.equal(tool.description, spec.description);
    assert.equal(tool.capability, spec.capability);
    const schema = structuredClone(layer.argsJsonSchema(spec));
    delete schema.$schema;
    assert.deepEqual(tool.schema, schema, `${tool.name} schema`);
    assert.equal(tool.schema.type, 'object');
    assert.equal(tool.schema.additionalProperties, false, `${tool.name} takes only its own arguments`);
  }
  const tabs = LAYER_TOOLS.find(tool => tool.name === 'tabs');
  assert.equal(tabs.readOnly, false);
  assert.deepEqual(tabs.readOnlyActions, ['list', 'select']);
  assert.equal(LAYER_TOOLS.find(tool => tool.name === 'snapshot').readOnly, true);
  assert.equal(LAYER_TOOLS.find(tool => tool.name === 'click').readOnly, false);
});
