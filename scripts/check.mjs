import { readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const expectedPermissions = new Set(['storage', 'unlimitedStorage', 'sidePanel', 'activeTab', 'contextMenus', 'scripting', 'alarms', 'notifications']);
const actualPermissions = new Set(manifest.permissions || []);
for (const permission of expectedPermissions) if (!actualPermissions.has(permission)) fail(`Manifest is missing ${permission} permission.`);
for (const permission of actualPermissions) if (!expectedPermissions.has(permission)) fail(`Review unexpected required permission: ${permission}`);
if ((manifest.host_permissions || []).length) fail('Host permissions must remain optional.');
// Optional grants requested at the moment of use: bookmarks import, the active tab's address for "This page",
// and per-origin host access for reading saved pages and calling AI providers the user connects.
const allowedOptionalPermissions = new Set(['bookmarks', 'tabs']);
if ((manifest.optional_permissions || []).some(permission => !allowedOptionalPermissions.has(permission))) fail('Unexpected optional permission.');
const allowedHosts = new Set(['http://127.0.0.1/*', 'http://localhost/*', 'https://api.raindrop.io/*', 'https://*/*', 'http://*/*']);
for (const host of manifest.optional_host_permissions || []) if (!allowedHosts.has(host)) fail(`Review unexpected optional host: ${host}`);
const csp = manifest.content_security_policy?.extension_pages || '';
if (!/script-src\s+'self'\s*;/.test(csp) || /unsafe-eval|unsafe-inline|https?:|\*/.test(csp)) fail('Extension CSP must restrict scripts to self with no unsafe/remote execution.');

for (const [name, path] of Object.entries({ background: manifest.background?.service_worker, sidebar: manifest.side_panel?.default_path })) {
  if (!path) fail(`Manifest ${name} entry is missing.`); else await localAsset(path, `Manifest ${name}`);
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
  if (extensionSource && /\beval\s*\(|\bnew\s+Function\s*\(|\bimportScripts\s*\(/.test(source)) fail(`${label(file)}: dynamic code execution is disallowed.`);
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
