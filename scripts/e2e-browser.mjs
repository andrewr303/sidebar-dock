// Browser checks: loads a copy of the extension in headless Chrome and runs the assistant's browser work against local
// pages, with a scripted model. Nothing connects to Chrome from outside: the only CDP client is the extension itself,
// through chrome.debugger, as in real use.
//
//   node scripts/e2e-browser.mjs [--only <name>[,<name>...]] [--headful] [--keep] [--timeout <seconds>] [--verbose]
//
// Chrome: CHROME_PATH, or a Chrome for Testing or Chromium this script finds. Branded Chrome no longer loads an
// unpacked extension from the command line, so it cannot be used.
//
// The copy differs from extension/ in three ways, none of which ship: the manifest grants at install what the product
// asks for in a click (tabs, webNavigation, and the loopback host of the local model), the worker also opens the driver
// page (scripts/e2e/worker-boot.js), and the driver page itself is added (scripts/e2e/driver.*).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './e2e/server.mjs';
import { buildScenarios } from './e2e/scenarios.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const option = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const timeoutMs = Number(option('--timeout') ?? 240) * 1000;
const only = (option('--only') || '').split(',').filter(Boolean);

async function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [];
  // Playwright's and Puppeteer's download folders hold Chrome for Testing or Chromium builds.
  for (const base of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', join(homedir(), '.cache', 'ms-playwright')].filter(Boolean)) {
    if (!existsSync(base)) continue;
    for (const name of (await readdir(base)).filter(entry => /^chromium-\d+$/.test(entry)).sort().reverse()) {
      candidates.push(join(base, name, 'chrome-linux64', 'chrome'), join(base, name, 'chrome-linux', 'chrome'),
        join(base, name, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'), join(base, name, 'chrome-win', 'chrome.exe'));
    }
  }
  const puppeteer = join(homedir(), '.cache', 'puppeteer', 'chrome');
  if (existsSync(puppeteer)) {
    for (const name of (await readdir(puppeteer)).sort().reverse()) {
      candidates.push(join(puppeteer, name, 'chrome-linux64', 'chrome'), join(puppeteer, name, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        join(puppeteer, name, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'), join(puppeteer, name, 'chrome-win64', 'chrome.exe'));
    }
  }
  candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser');
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error('No Chrome for Testing or Chromium found. Set CHROME_PATH to one.');
  return found;
}

/** A copy of extension/ with the test manifest, the driver page and the worker's extra import. */
async function prepareExtension(directory, serverOrigin) {
  const target = join(directory, 'extension');
  await cp(resolve(root, 'extension'), target, { recursive: true });
  const manifestFile = join(target, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const granted = ['tabs', 'webNavigation'];
  manifest.permissions = [...new Set([...manifest.permissions, ...granted])];
  manifest.optional_permissions = manifest.optional_permissions.filter(permission => !granted.includes(permission));
  const loopback = ['http://127.0.0.1/*', 'http://localhost/*'];
  manifest.host_permissions = loopback;
  manifest.optional_host_permissions = manifest.optional_host_permissions.filter(host => !loopback.includes(host));
  manifest.name = 'Still (browser checks)';
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const driver = join(target, 'e2e');
  await mkdir(driver, { recursive: true });
  for (const name of ['driver.html', 'driver.js', 'worker-boot.js']) {
    const source = await readFile(resolve(root, 'scripts', 'e2e', name), 'utf8');
    // In the repository the driver imports the extension's modules from ../../extension; in the copy it sits inside it.
    await writeFile(join(driver, name), source.split('../../extension/').join('../'));
  }
  await writeFile(join(driver, 'config.json'), JSON.stringify({ server: serverOrigin }));
  const worker = join(target, 'background.js');
  await writeFile(worker, `${await readFile(worker, 'utf8')}\nimport './e2e/worker-boot.js';\n`);
  return target;
}

const job = { scenarios: [] };
const server = await startServer({ job });
const scenarios = buildScenarios({ origin: server.origin, port: server.port, server }).filter(scenario => !only.length || only.includes(scenario.name));
if (!scenarios.length) { process.stderr.write('No scenario matches --only.\n'); await server.close(); process.exit(2); }
// The driver gets the plain data of each scenario; the checks and the scripted models stay here.
job.scenarios = scenarios.map(({ check, script, ...data }) => data);
for (const scenario of scenarios) if (typeof scenario.script === 'function') server.setModel(scenario.model, scenario.script);

const work = await mkdtemp(join(tmpdir(), 'still-e2e-'));
const extension = await prepareExtension(work, server.origin);
const chromePath = await findChrome();
const chromeArgs = [
  `--user-data-dir=${join(work, 'profile')}`,
  `--load-extension=${extension}`,
  `--disable-extensions-except=${extension}`,
  // Chrome for Testing must never reach the real macOS Keychain.
  '--use-mock-keychain',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-search-engine-choice-screen',
  '--enable-logging=stderr',
  '--v=0',
  '--window-size=1280,900',
  '--lang=en-US',
  '--accept-lang=en-US',
  ...(flag('--headful') ? [] : ['--headless=new']),
  // A container runs as root, where Chrome's sandbox cannot start.
  ...(userInfo().uid === 0 || process.env.STILL_E2E_NO_SANDBOX ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : []),
  'about:blank',
];
const chrome = spawn(chromePath, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
const consoleLines = [];
chrome.stderr.setEncoding('utf8');
let stderrTail = '';
chrome.stderr.on('data', chunk => {
  stderrTail = (stderrTail + chunk).slice(-4000);
  for (const line of chunk.split('\n')) {
    const match = /:CONSOLE[^\]]*\] "(.*)", source: (.*)$/.exec(line);
    if (match && match[2].startsWith('chrome-extension://')) {
      consoleLines.push(match[1]);
      if (flag('--verbose')) process.stdout.write(`  [console] ${match[1]}\n`);
    }
  }
});

process.stdout.write(`Chrome: ${chromePath}\nServer: ${server.origin}\n`);
const outcome = await new Promise(resolveOutcome => {
  const timer = setTimeout(() => resolveOutcome({ timedOut: true }), timeoutMs);
  server.report.then(report => { clearTimeout(timer); resolveOutcome({ report }); });
  chrome.once('exit', code => { clearTimeout(timer); resolveOutcome({ exited: code }); });
});

const exited = new Promise(resolveExit => (chrome.exitCode !== null ? resolveExit() : chrome.once('exit', resolveExit)));
chrome.kill();
await exited;
await server.close();

const failures = [];
const results = outcome.report?.results || [];
if (outcome.timedOut) failures.push(`No report from the extension within ${timeoutMs / 1000} s.`);
if (outcome.exited !== undefined) failures.push(`Chrome exited (${outcome.exited}) before the checks finished.\n${stderrTail.slice(-1500)}`);
if (outcome.report?.fatal) failures.push(`The driver page failed: ${outcome.report.fatal}\n${outcome.report.stack || ''}`);
let passed = 0;
for (const scenario of scenarios) {
  const result = results.find(entry => entry.name === scenario.name);
  try {
    if (!result) throw new Error('the driver reported no result');
    if (!result.ok) throw new Error(`the driver failed: ${result.error}\n${result.stack || ''}`);
    await scenario.check(result, { server, consoleLines });
    passed++;
    process.stdout.write(`PASS ${scenario.name} (${result.ms} ms)\n`);
  } catch (error) {
    failures.push(`${scenario.name}: ${error.message}`);
    process.stdout.write(`FAIL ${scenario.name}\n     ${String(error.message).split('\n').join('\n     ')}\n`);
  }
}
// A string run as code in an extension context would be refused by the CSP, and Chrome logs each refusal.
const refusals = consoleLines.filter(line => /Refused to evaluate|unsafe-eval|EvalError/i.test(line));
if (refusals.length) failures.push(`The extension tried to run a string as code:\n${refusals.slice(0, 5).join('\n')}`);

const artifacts = resolve(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const resultsFile = join(artifacts, 'e2e-browser.json');
await writeFile(resultsFile, JSON.stringify({ chrome: chromePath, userAgent: outcome.report?.userAgent, scenarios: scenarios.map(scenario => scenario.name), results, console: consoleLines,
  forms: server.forms, modelRequests: server.modelRequests, failures }, null, 2));
if (flag('--keep')) process.stdout.write(`Kept ${work}\n`);
else await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);

process.stdout.write(`${passed} of ${scenarios.length} browser scenarios passed. Details: ${resultsFile}\n`);
if (failures.length) {
  process.stderr.write(`\n${failures.join('\n\n')}\n`);
  process.exit(1);
}
