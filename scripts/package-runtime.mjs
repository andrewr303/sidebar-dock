import {spawn} from 'node:child_process';
import {mkdir,readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await import('./check.mjs');if(process.exitCode)process.exit(process.exitCode);
const folder=resolve(root,'artifacts');await mkdir(folder,{recursive:true});const target=resolve(folder,'still-runtime.zip');
const program=String.raw`
import pathlib,sys,zipfile,json
root=pathlib.Path(sys.argv[1]).resolve(strict=True)
target=pathlib.Path(sys.argv[2]).resolve()
files=[]
for directory in ['extension','bridge','agent-skills']:
    for p in (root/directory).rglob('*'):
        rel=p.relative_to(root)
        if any(part.startswith('.') for part in rel.parts): continue
        if not p.is_file(): continue
        if p.is_symlink() or not p.resolve().is_relative_to(root): raise ValueError('Runtime source escapes project')
        if directory=='bridge' and p.suffix!='.mjs': continue
        files.append(p)
files += [root/'docs'/name for name in ['INSTALL.md','integrations.md','ai-providers.md','ai-cli.md','ai-prompts.md','mcp-agents.md','fabric-expansion.md']]
files += [root/'package.json',root/'README.md']
files += list((root/'docs'/'screenshots').glob('*'))
temporary=target.with_suffix('.zip.tmp')
with zipfile.ZipFile(temporary,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for p in sorted(set(files)): z.write(p,p.relative_to(root).as_posix())
    z.writestr('START.md','# Still runtime\n\nExtract this folder. Use Node.js 22 or later. No packages need installing.\n\n1. Load the extension subfolder with Chrome Load unpacked.\n2. From this folder run: node bridge/server.mjs\n3. Pair Still with the local address and private token from bridge/.local/config.json.\n4. Open Ask AI settings to choose a provider or CLI, or MCP & agents to review a client connection and install its skill.\n\nNo credentials, original third-party extension packages, test fixtures or research archives are included. Live accounts still require your authorization. Verification commands in the source README require the full source checkout.\n')
with zipfile.ZipFile(temporary) as z:
    names=z.namelist()
    for required in ['extension/manifest.json','bridge/server.mjs','bridge/ai/router.mjs','extension/lib/ai-prompts.js','agent-skills/still-workspace/SKILL.md','START.md']:
        if required not in names: raise ValueError('Missing runtime entry '+required)
    if any('/.local/' in n or '..' in pathlib.PurePosixPath(n).parts for n in names): raise ValueError('Unsafe runtime entry')
    if z.testzip() is not None: raise ValueError('Runtime ZIP integrity failure')
temporary.replace(target)
print(json.dumps({'entries':len(names),'credentialsIncluded':False,'crcVerified':True}))
`;
await new Promise((done,reject)=>{const child=spawn(process.env.PYTHON||'python',['-c',program,root,target],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('close',code=>code===0?(process.stdout.write(out),done()):reject(new Error(err)));});
const data=await readFile(target);process.stdout.write(`Created ${target}\n${(await stat(target)).size} bytes · SHA-256 ${createHash('sha256').update(data).digest('hex')}\n`);
