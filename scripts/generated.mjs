// Files under extension/ that a build writes: the browser control layer and its tool catalogue (browser-control/build.mjs).
// The extension is loaded exactly as it is committed, so check.mjs and both packaging scripts hold these files to the
// pins in generated.json, and check.mjs also compares the hash of the sources they were built from. A change to the
// layer's source that was not built again therefore fails the check, without installing the layer's dependencies.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pinsFile = resolve(root, 'scripts', 'generated.json');
// Absent only before the first build: check.mjs then reports the missing pins.
const pins = existsSync(pinsFile) ? JSON.parse(readFileSync(pinsFile, 'utf8')) : { sourceHash: '', packages: {}, files: [] };

/** The pinned files: { path (inside extension/), bytes, sha256, license (the notices file, inside extension/) }. */
export const GENERATED_FILES = pins.files.map(file => ({ license: 'assets/licenses/browser-control.txt', ...file }));
/** The hash of the layer's sources at the time of the build (layerSourceHash). */
export const GENERATED_SOURCE_HASH = pins.sourceHash;
/** The npm packages inside the layer bundle, with the versions built. */
export const GENERATED_PACKAGES = pins.packages;
/** The modules the extension must only ever get from the build. */
export const GENERATED_REQUIRED = ['lib/browser-control/layer.js', 'lib/browser-control/catalogue.js'];
/** Folders of extension/ that hold nothing but generated files: every file in them must be pinned. */
export const GENERATED_DIRS = ['lib/browser-control/'];

// What the build reads from browser-control/: the layer's source without its tests, the bundle entry and its stand-ins,
// the build script, the package manifest and lockfile (they pin what is bundled), the TypeScript settings and the two
// licence texts that go into the notices. The README and the test settings are not inputs.
const BUILD_INPUT_FILES = ['build.mjs', 'entry.ts', 'package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE', 'NOTICE'];
const BUILD_INPUT_DIRS = ['src', 'stubs'];

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

/**
 * One hash over every file the layer build reads from this repository. Line endings are normalized, so a checkout
 * with CRLF gives the same hash.
 */
export async function layerSourceHash(base = root) {
  const directory = resolve(base, 'browser-control');
  const paths = BUILD_INPUT_FILES.map(name => resolve(directory, name));
  for (const name of BUILD_INPUT_DIRS) paths.push(...await walk(resolve(directory, name)));
  const files = paths.map(path => [relative(directory, path).split(sep).join('/'), path]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash('sha256');
  for (const [name, path] of files) {
    const text = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
    hash.update(`${name}\n${createHash('sha256').update(text).digest('hex')}\n`);
  }
  return hash.digest('hex');
}
