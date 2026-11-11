// The driver page of the browser checks. scripts/e2e-browser.mjs copies it into a copy of the extension, where it runs
// as one of the extension's own pages: it reaches the service worker's browser host the way the assistant does, and the
// assistant's engine through the same modules the app uses. It fetches a job from the local server, runs each scenario
// and posts what happened; the Node side judges the results.
import { BROWSER_PORT } from '../../extension/lib/browser/host.js';

const log = document.getElementById('log');
const say = line => { log.textContent += `${line}\n`; };
const config = await (await fetch('./config.json')).json();
const server = config.server;
const post = (path, value) => fetch(`${server}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

/** A port to the browser host with request/response matching and answers for the prompts a step expects. */
function connectHost() {
  const port = chrome.runtime.connect({ name: BROWSER_PORT });
  const waiting = new Map();
  const prompts = [];
  const events = [];
  let answers = [];
  let count = 0;
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
    for (const { reject } of waiting.values()) reject(new Error('The port closed.'));
    waiting.clear();
  });
  port.onMessage.addListener(message => {
    if (message.kind === 'response') {
      const entry = waiting.get(message.id);
      waiting.delete(message.id);
      entry?.resolve(message);
    } else if (message.kind === 'prompt') {
      prompts.push({ type: message.type, request: message.request });
      // A step says how its prompts are answered, in order; a prompt nobody expected is declined.
      const answer = answers.length ? answers.shift() : (message.type === 'confirm' ? 'decline' : { outcome: 'cancel' });
      if (answer !== 'leave-open') port.postMessage({ kind: 'answer', promptId: message.promptId, answer });
    } else {
      events.push(message);
    }
  });
  return {
    prompts, events,
    get disconnected() { return disconnected; },
    request(method, params, { answer = [] } = {}) {
      answers = [...answer];
      const id = `r${++count}`;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        port.postMessage({ kind: 'request', id, method, params });
      });
    },
    close() { try { port.disconnect(); } catch { /* Already closed. */ } },
  };
}

/** A scenario of plain host requests: each step is { method, params, answer?: [answers] }. */
async function runProtocol(scenario) {
  const host = connectHost();
  const steps = [];
  try {
    for (const step of scenario.steps) {
      const before = host.prompts.length;
      const started = performance.now();
      const response = await host.request(step.method, step.params, { answer: step.answer });
      const result = response.ok ? response.result : null;
      // A screenshot is megabytes of base64: report its size, not its bytes.
      const image = result?.result?.data?.base64;
      if (typeof image === 'string') result.result.data = { ...result.result.data, base64: `<${image.length} base64 characters>`, pngHeader: image.slice(0, 11) };
      steps.push({ method: step.method, tool: step.params?.tool, ok: response.ok, result, error: response.ok ? null : response.error,
        prompts: host.prompts.slice(before), ms: Math.round(performance.now() - started) });
    }
  } finally {
    host.close();
  }
  return { steps, events: host.events };
}

const runners = { protocol: runProtocol };

async function main() {
  const job = await (await fetch(`${server}/e2e/job`)).json();
  const results = [];
  for (const scenario of job.scenarios || []) {
    say(`running ${scenario.name}`);
    const started = performance.now();
    try {
      const runner = runners[scenario.kind];
      if (!runner) throw new Error(`Unknown scenario kind ${scenario.kind}`);
      const outcome = await runner(scenario, job);
      results.push({ name: scenario.name, ok: true, ms: Math.round(performance.now() - started), ...outcome });
    } catch (error) {
      results.push({ name: scenario.name, ok: false, error: `${error?.message || error}`, stack: String(error?.stack || '').slice(0, 2000) });
    }
    say(`  finished ${scenario.name}`);
  }
  await post('/e2e/report', { results, userAgent: navigator.userAgent });
  say('reported');
}

main().catch(error => post('/e2e/report', { results: [], fatal: `${error?.message || error}`, stack: String(error?.stack || '') }));
