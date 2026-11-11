import { readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { VENDORED_FILES, CLASSIC_SCRIPT_DIRS } from './vendored.mjs';
import { GENERATED_FILES, GENERATED_DIRS, GENERATED_REQUIRED, GENERATED_SOURCE_HASH, layerSourceHash } from './generated.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = resolve(root, 'extension');
const failures = [];
let inspectedImports = 0;
let inspectedAssets = 0;
const fail = message => failures.push(message);
const within = (parent, file) => file === parent || file.startsWith(parent + sep);
const label = file => relative(root, file).split(sep).join('/');
const jsFiles = [];

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) { fail(`Package source cannot contain symlinks: ${label(path)}`); continue; }
    if (entry.isDirectory()) output.push(...await walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

async function requireFile(file, owner) {
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    return true;
  } catch { fail(`${owner}: missing file ${label(file)}`); return false; }
}

async function localAsset(value, owner, base = extensionRoot) {
  if (!value || value.startsWith('#')) return;
  if (/^(data:|blob:)/i.test(value)) return;
  if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(value) || isAbsolute(value)) {
    fail(`${owner}: external or absolute packaged asset ${value}`); return;
  }
  const clean = decodeURIComponent(value.split(/[?#]/)[0]);
  const file = resolve(base, clean);
  if (!within(extensionRoot, file)) { fail(`${owner}: asset escapes extension directory`); return; }
  inspectedAssets++;
  await requireFile(file, owner);
}

function syntaxCheck(file) {
  return new Promise(resolveCheck => {
    const child = spawn(process.execPath, ['--check', file], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { fail(`${label(file)}: could not start syntax check: ${error.message}`); resolveCheck(); });
    child.once('close', code => { if (code !== 0) fail(`${label(file)}: syntax check failed\n${stderr.trim()}`); resolveCheck(); });
  });
}

const manifest = JSON.parse(await readFile(resolve(extensionRoot, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) fail('Manifest must use version 3.');
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version || '')) fail('Manifest version is invalid.');
if (manifest.background?.type !== 'module') fail('Background must be a module service worker.');
if (manifest.action?.default_popup) fail('Toolbar action must open the side panel.');
// favicon (site icons), search (the browser's default engine) and declarativeNetRequestWithHostAccess (the embed widget's
// per-site session rules, only effective on origins the user grants) add no install warning.
const expectedPermissions = new Set(['storage', 'unlimitedStorage', 'sidePanel', 'activeTab', 'contextMenus', 'scripting', 'alarms', 'notifications',
  'favicon', 'search', 'declarativeNetRequestWithHostAccess']);
const actualPermissions = new Set(manifest.permissions || []);
for (const permission of expectedPermissions) if (!actualPermissions.has(permission)) fail(`Manifest is missing ${permission} permission.`);
for (const permission of actualPermissions) if (!expectedPermissions.has(permission)) fail(`Review unexpected required permission: ${permission}`);
if ((manifest.host_permissions || []).length) fail('Host permissions must remain optional.');
// Optional grants requested at the moment of use: bookmarks import, the active tab's address for "This page",
// most visited sites for the dashboard, finding an installed Threadkeeper (management, removed again right after the
// lookup), and per-origin host access for reading saved pages and calling services the user connects.
const allowedOptionalPermissions = new Set(['bookmarks', 'tabs', 'topSites', 'management']);
if ((manifest.optional_permissions || []).some(permission => !allowedOptionalPermissions.has(permission))) fail('Unexpected optional permission.');
const allowedHosts = new Set(['http://127.0.0.1/*', 'http://localhost/*', 'https://api.raindrop.io/*', 'https://*/*', 'http://*/*']);
for (const host of manifest.optional_host_permissions || []) if (!allowedHosts.has(host)) fail(`Review unexpected optional host: ${host}`);
// Page access stays on demand: the worker injects its classic scripts with executeScript({ files }) after a user action,
// which needs neither declared content scripts nor page-visible extension files.
if (manifest.content_scripts?.length) fail('Review declared content_scripts: Still injects page scripts on demand only.');
if (manifest.web_accessible_resources?.length) fail('Review web_accessible_resources: no extension file should be exposed to web pages.');
const csp = manifest.content_security_policy?.extension_pages || '';
if (!/script-src\s+'self'\s*;/.test(csp) || /unsafe-eval|unsafe-inline|https?:|\*/.test(csp)) fail('Extension CSP must restrict scripts to self with no unsafe/remote execution.');

const overrides = manifest.chrome_url_overrides || {};
if (Object.keys(overrides).some(key => key !== 'newtab')) fail('Only the new tab page may be overridden.');
for (const [name, path] of Object.entries({ background: manifest.background?.service_worker, sidebar: manifest.side_panel?.default_path, newtab: overrides.newtab })) {
  if (!path) fail(`Manifest ${name} entry is missing.`); else await localAsset(path, `Manifest ${name}`);
}
// The new tab is the full-tab app under another address: it must load exactly what index.html loads, in the same order,
// and mark itself as the new tab entry (app.js keeps its address bar empty).
const pageAssets = page => [...page.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*['"]([^'"]+)['"][^>]*>/gi)]
  .map(match => match[1]).filter(ref => /\.(?:m?js|css)(?:[?#]|$)/.test(ref));
if (overrides.newtab) {
  try {
    const index = await readFile(resolve(extensionRoot, 'index.html'), 'utf8');
    const newtab = await readFile(resolve(extensionRoot, overrides.newtab.split(/[?#]/)[0]), 'utf8');
    const [want, got] = [pageAssets(index), pageAssets(newtab)];
    if (want.join('\n') !== got.join('\n')) {
      const missing = want.filter(ref => !got.includes(ref)), extra = got.filter(ref => !want.includes(ref));
      fail(`${overrides.newtab} must load the same stylesheets and scripts as index.html, in order${missing.length ? `; missing ${missing.join(', ')}` : ''}${extra.length ? `; extra ${extra.join(', ')}` : ''}.`);
    }
    if (!/<html\b[^>]*\bdata-entry\s*=\s*['"]newtab['"]/i.test(newtab)) fail(`${overrides.newtab} must declare <html data-entry="newtab">.`);
    if (/<html\b[^>]*\bdata-entry\s*=/i.test(index)) fail('index.html must not declare a data-entry.');
    if (!/<title>\s*New Tab\s*<\/title>/i.test(newtab)) fail(`${overrides.newtab} must be titled "New Tab".`);
  } catch (error) { fail(`New tab page: ${error.message}`); }
}
for (const [size, path] of Object.entries({ ...manifest.icons, ...manifest.action?.default_icon })) {
  await localAsset(path, `Manifest icon ${size}`);
  try {
    const bytes = await readFile(resolve(extensionRoot, path));
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== Number(size) || bytes.readUInt32BE(20) !== Number(size)) {
      fail(`Manifest icon ${size} must be a ${size}×${size} PNG.`);
    }
  } catch (error) { fail(`Icon ${size}: ${error.message}`); }
}

const extensionFiles = await walk(extensionRoot);
for (const directory of ['extension', 'bridge', 'scripts', 'tests']) {
  try { jsFiles.push(...(await walk(resolve(root, directory))).filter(path => /\.(?:m?js)$/.test(path))); }
  catch (error) { fail(`Cannot inspect ${directory}: ${error.message}`); }
}
// Keep process count bounded while checking every first-party JavaScript entry.
for (let index = 0; index < jsFiles.length; index += 4) await Promise.all(jsFiles.slice(index, index + 4).map(syntaxCheck));

const isClassicScript = file => CLASSIC_SCRIPT_DIRS.some(prefix => within(extensionRoot, file) && relative(extensionRoot, file).split(sep).join('/').startsWith(prefix));
// Injected page scripts must parse as classic scripts too (node --check above reads them as ES modules because of
// package.json "type": "module"): no import/export, no top-level return or await.
for (const file of jsFiles.filter(isClassicScript)) {
  const source = await readFile(file, 'utf8');
  try { new vm.Script(source, { filename: label(file) }); } catch (error) { fail(`${label(file)}: not a valid classic script: ${error.message}`); }
  if (/^\s*(?:import\s*[\w*{'"]|export\s)/m.test(source) || /\bimport\s*\(/.test(source)) fail(`${label(file)}: page scripts cannot use import or export.`);
}
for (const file of extensionFiles.filter(path => relative(extensionRoot, path).split(sep).join('/').startsWith('lib/vendor/'))) {
  if (!VENDORED_FILES.some(entry => resolve(extensionRoot, entry.path) === file)) fail(`${label(file)}: unreviewed vendored file (add its pin to scripts/vendored.mjs).`);
}
for (const entry of VENDORED_FILES) {
  const file = resolve(extensionRoot, entry.path);
  if (!(await requireFile(file, 'Vendored file'))) continue;
  const bytes = await readFile(file);
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    fail(`${label(file)}: vendored bytes changed; it must stay identical to ${entry.source}.`);
  }
  await requireFile(resolve(extensionRoot, entry.license), `${entry.path} license`);
}
// Generated files (scripts/generated.mjs): the committed build of the browser control layer must be the one its pins
// describe, and must come from the layer's sources as they are now. Nobody edits these files by hand.
const isGenerated = file => GENERATED_FILES.some(entry => resolve(extensionRoot, entry.path) === file);
if (!GENERATED_FILES.length) fail('scripts/generated.json is missing: run "npm run build" in browser-control.');
for (const path of GENERATED_REQUIRED) if (!GENERATED_FILES.some(entry => entry.path === path)) fail(`${path}: missing from the generated pins (run "npm run build" in browser-control).`);
for (const file of extensionFiles.filter(path => GENERATED_DIRS.some(prefix => relative(extensionRoot, path).split(sep).join('/').startsWith(prefix)))) {
  if (!isGenerated(file)) fail(`${label(file)}: only files written by the browser-control build belong in this folder.`);
}
for (const entry of GENERATED_FILES) {
  const file = resolve(extensionRoot, entry.path);
  if (!(await requireFile(file, 'Generated file'))) continue;
  const bytes = await readFile(file);
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    fail(`${label(file)}: generated bytes changed; run "npm run build" in browser-control instead of editing it.`);
  }
  await requireFile(resolve(extensionRoot, entry.license), `${entry.path} license`);
}
try {
  if (GENERATED_FILES.length && await layerSourceHash(root) !== GENERATED_SOURCE_HASH) {
    fail('browser-control changed after extension/lib/browser-control was built: run "npm run build" in browser-control and commit the result.');
  }
} catch (error) { fail(`Browser control sources: ${error.message}`); }
// The layer bundle must stand alone (the worker cannot resolve a package) and must offer its one entry.
try {
  const layerFile = resolve(extensionRoot, 'lib/browser-control/layer.js');
  if (isGenerated(layerFile)) {
    globalThis.chrome ??= {};
    const layerModule = await import(pathToFileURL(layerFile).href);
    if (typeof layerModule.loadBrowserControl !== 'function') fail('lib/browser-control/layer.js must export loadBrowserControl.');
  }
} catch (error) { fail(`lib/browser-control/layer.js does not load on its own: ${error.message}`); }
// Every script the worker injects with executeScript({ files }) must exist and be one of the classic page scripts.
try {
  const { ARTICLE_SCRIPT_FILES, PICKER_SCRIPT_FILES } = await import(pathToFileURL(resolve(extensionRoot, 'lib/capture.js')).href);
  for (const path of new Set([...ARTICLE_SCRIPT_FILES, ...PICKER_SCRIPT_FILES])) {
    const file = resolve(extensionRoot, path);
    if (!within(extensionRoot, file) || !isClassicScript(file)) fail(`Injected page script ${path} must live in ${CLASSIC_SCRIPT_DIRS.join(' or ')}.`);
    else await requireFile(file, 'Injected page script');
  }
} catch (error) { fail(`Injected page scripts: ${error.message}`); }

const sourceCache = new Map();
const sourceOf = async file => { if (!sourceCache.has(file)) sourceCache.set(file, await readFile(file, 'utf8')); return sourceCache.get(file); };
function exportNames(source) {
  const names = new Set([...source.matchAll(/\bexport\s+(?:(?:async\s+)?function|class|const|let|var)\s+(\w+)/g)].map(match => match[1]));
  for (const match of source.matchAll(/\bexport\s*\{([^}]+)\}/g)) for (const part of match[1].split(',')) names.add(part.trim().split(/\s+as\s+/).at(-1));
  if (/\bexport\s+default\b/.test(source)) names.add('default');
  return names;
}
for (const file of jsFiles) {
  const source = await sourceOf(file);
  const extensionSource = within(extensionRoot, file);
  const imports = [...source.matchAll(/\b(?:import|export)\s+(?:([\w$*{},\s]+?)\s+from\s*)?(['"])([^'"\r\n]+)\2/g),
    ...source.matchAll(/\bimport\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g)].map(match => ({ specifier: match[3] || match[2], bindings: match[3] ? match[1] : '' }));
  for (const { specifier, bindings } of imports) {
    if (specifier.startsWith('node:') && !extensionSource) continue;
    if (!specifier.startsWith('.')) { fail(`${label(file)}: module must be local${extensionSource ? ' browser code' : ' or a Node builtin'}: ${specifier}`); continue; }
    const target = resolve(dirname(file), specifier);
    const boundary = extensionSource ? extensionRoot : root;
    if (!within(boundary, target)) { fail(`${label(file)}: module path escapes its package: ${specifier}`); continue; }
    if (extensionSource && isClassicScript(target)) { fail(`${label(file)}: ${specifier} is a page script injected by the worker, not a module.`); continue; }
    inspectedImports++;
    if (!(await requireFile(target, label(file)))) continue;
    if (bindings?.includes('{')) {
      const names = exportNames(await sourceOf(target));
      for (const part of bindings.match(/\{([^}]+)\}/)[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name && !names.has(name)) fail(`${label(file)}: ${specifier} does not export ${name}.`);
      }
    }
  }
  // The generated layer bundle is third-party code built from pinned packages. This textual rule would misread it:
  // Puppeteer names methods $eval, and carries helper source for web pages as strings. Its bytes are pinned above, and
  // the CSP checked above keeps any extension context from running a string as code.
  if (extensionSource && !isGenerated(file) && /\beval\s*\(|\bnew\s+Function\s*\(|\bimportScripts\s*\(/.test(source)) fail(`${label(file)}: dynamic code execution is disallowed.`);
}
for (const file of extensionFiles) {
  const suffix = extname(file);
  if (suffix === '.html') {
    const html = await readFile(file, 'utf8');
    if (/\son[a-z]+\s*=/i.test(html)) fail(`${label(file)}: inline event handlers violate the extension CSP.`);
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const src = script[1].match(/\bsrc\s*=\s*['"]([^'"]+)['"]/i)?.[1];
      if (!src || script[2].trim()) fail(`${label(file)}: only local external script files are allowed.`);
      else await localAsset(src, label(file), dirname(file));
    }
    for (const match of html.matchAll(/<(?:link|img|source)\b[^>]*\b(?:href|src)\s*=\s*['"]([^'"]+)['"]/gi)) await localAsset(match[1], label(file), dirname(file));
  }
  if (suffix === '.css') {
    const css = await readFile(file, 'utf8');
    for (const match of css.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)) await localAsset(match[1], label(file), dirname(file));
  }
}

const { REFERENCE_ASSETS } = await import(pathToFileURL(resolve(extensionRoot, 'lib/references.js')).href);
const { SEED_LIBRARY } = await import(pathToFileURL(resolve(extensionRoot, 'lib/seed.js')).href);
const { normalizeItem } = await import(pathToFileURL(resolve(extensionRoot, 'lib/store.js')).href);
for (const item of SEED_LIBRARY.items) {
  try { normalizeItem(item); } catch (error) { fail(`Sample item ${item.id}: ${error.message}`); }
}
const originalImages = (await walk(resolve(root, 'images'))).map(file => relative(resolve(root, 'images'), file).split(sep).join('/'));
const catalogNames = new Set(REFERENCE_ASSETS.map(asset => asset.name));
if (catalogNames.size !== REFERENCE_ASSETS.length) fail('Reference image catalog contains duplicate names.');
for (const filename of originalImages) {
  if (!catalogNames.has(filename)) { fail(`Image is missing from reference catalog: ${filename}`); continue; }
  const asset = REFERENCE_ASSETS.find(asset => asset.name === filename);
  await localAsset(asset.path, `Image catalog ${filename}`);
  const originalHash = createHash('sha256').update(await readFile(resolve(root, 'images', filename))).digest('hex');
  const copiedHash = createHash('sha256').update(await readFile(resolve(extensionRoot, asset.path))).digest('hex');
  if (originalHash !== copiedHash) fail(`Supplied image bytes changed: ${filename}`);
}
if (failures.length) {
  for (const message of failures) process.stderr.write(`FAIL ${message}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Still checks passed: ${jsFiles.length} JavaScript files, ${inspectedImports} local module edges, ${inspectedAssets} asset references, ${originalImages.length} supplied images, valid MV3 manifest/CSP/icons.\n`);
  process.stdout.write('Static checks do not establish Chrome extension activation or UI behavior.\n');
}
