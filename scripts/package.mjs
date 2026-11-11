import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDORED_FILES } from './vendored.mjs';
import { GENERATED_FILES } from './generated.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await import('./check.mjs');
if (process.exitCode) process.exit(process.exitCode);
const artifacts = resolve(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const target = resolve(artifacts, 'still-extension.zip');
// Python's standard-library ZIP writer avoids dependencies and shell trampolines.
const program = String.raw`
import hashlib, json, pathlib, sys, zipfile
source = pathlib.Path(sys.argv[1]).resolve(strict=True)
target = pathlib.Path(sys.argv[2]).resolve()
temporary = target.with_suffix('.zip.tmp')
pins = json.loads(sys.argv[3])
# Dotfiles (.DS_Store, editor state) never ship.
files = sorted(path for path in source.rglob('*') if path.is_file() and not any(part.startswith('.') for part in path.relative_to(source).parts))
for path in files:
    if path.is_symlink() or not path.resolve().is_relative_to(source):
        raise ValueError('Package source escapes extension directory')
with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in files:
        archive.write(path, path.relative_to(source).as_posix())
with zipfile.ZipFile(temporary) as archive:
    names = archive.namelist()
    required = ['manifest.json', 'index.html', 'newtab.html', 'theme-boot.js', 'background.js', 'app.js', 'lib/store.js', 'lib/integrations.js', 'icons/icon128.png',
                'content/article-extract.js', 'content/picker.js'] + [pin['path'] for pin in pins] + [pin['license'] for pin in pins]
    if any(name not in names for name in required):
        raise ValueError('Package is missing an extension entrypoint')
    for pin in pins:
        data = archive.read(pin['path'])
        if len(data) != pin['bytes'] or hashlib.sha256(data).hexdigest() != pin['sha256']:
            raise ValueError('Pinned file changed in the package: ' + pin['path'])
    if any(name.startswith('/') or '..' in pathlib.PurePosixPath(name).parts for name in names):
        raise ValueError('Unsafe archive entry')
    manifest = json.loads(archive.read('manifest.json'))
    if manifest.get('manifest_version') != 3:
        raise ValueError('Package manifest is not MV3')
    if manifest.get('chrome_url_overrides', {}).get('newtab') not in names:
        raise ValueError('Package manifest new tab page is missing')
    if archive.testzip() is not None:
        raise ValueError('ZIP integrity check failed')
temporary.replace(target)
print(json.dumps({'entries': len(names), 'manifest_version': manifest['manifest_version'], 'version': manifest['version'], 'entrypoints': required}))
`;
const runPython = python => new Promise((resolveRun, rejectRun) => {
  // Vendored third-party files and the generated browser control layer are both held to their pins inside the ZIP.
  const child = spawn(python, ['-c', program, resolve(root, 'extension'), target, JSON.stringify([...VENDORED_FILES, ...GENERATED_FILES])], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', stderr = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.once('error', error => rejectRun(Object.assign(new Error(`Python 3.9+ is required to package the extension: ${error.message}`), { code: error.code })));
  child.once('close', code => {
    if (code !== 0) rejectRun(new Error(`Extension packaging failed (${code}): ${stderr.trim()}`));
    else { process.stdout.write(`ZIP verified: ${output.trim()}\n`); resolveRun(); }
  });
});
// PYTHON wins; otherwise 'python', then 'python3' where only that name exists (macOS).
try { await runPython(process.env.PYTHON || 'python'); }
catch (error) { if (process.env.PYTHON || error.code !== 'ENOENT') throw error; await runPython('python3'); }
const info = await stat(target);
const hash = createHash('sha256').update(await readFile(target)).digest('hex');
process.stdout.write(`Created ${target}\n${info.size} bytes · SHA-256 ${hash}\n`);
