// The driver page of the browser checks. scripts/e2e-browser.mjs copies it into a copy of the extension, where it runs
// as one of the extension's own pages: it reaches the service worker's browser host the way the assistant does, and the
// assistant's engine through the same modules the app uses. It fetches a job from the local server, runs each scenario
// and posts what happened; the Node side judges the results.
import { BROWSER_PORT } from '../../extension/lib/browser/host.js';
import * as ai from '../../extension/lib/ai/index.js';
import * as store from '../../extension/lib/store.js';

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

// The assistant's engine, started once the way app.js starts it: the shared library store and a connection to the
// scripted model on the local server.
let engine = null;
function startEngine() {
  engine ||= (async () => {
    let library = await store.loadLibrary();
    store.subscribe(next => { library = next; });
    const handle = ai.init({ store, getLibrary: () => library, onLibraryChange: listener => store.subscribe(listener) });
    await Promise.resolve(handle.ready).catch(() => null);
    const connection = await ai.saveConnection({ providerId: 'custom-openai', baseUrl: `${server}/v1`, label: 'Scripted model' });
    return { connectionId: connection.id };
  })();
  return engine;
}

const BROWSER_OFF = { enabled: false, mode: 'ask', sites: {}, maxSteps: 60 };
const ASK_ALL = { create: 'ask', organize: 'ask', edit: 'ask', dashboard: 'ask', delete: 'ask' };

/**
 * A scenario of one request to the assistant: { model, input, context?, hint?, settings?: { browser, assistantPermissions },
 * seed?: [items], answers?: { confirm: [], ask: [], handover: [], proposal: [] } }. Cards are answered in order; a card
 * nobody expected is declined. Reports the saved message, the events, the cards and the library afterwards.
 */
async function runAssistant(scenario) {
  const { connectionId } = await startEngine();
  const seeded = [];
  for (const item of scenario.seed || []) seeded.push((await store.saveItem(item)).id);
  await ai.setAiSettings({ chat: { connectionId, model: scenario.model },
    browser: { ...BROWSER_OFF, ...(scenario.settings?.browser || {}) }, assistantPermissions: { ...ASK_ALL, ...(scenario.settings?.assistantPermissions || {}) } });
  const answers = { confirm: [], ask: [], handover: [], proposal: [], ...(scenario.answers || {}) };
  const declined = { confirm: 'decline', ask: { outcome: 'cancel' }, handover: 'cancelled' };
  const events = [];
  const prompts = [];
  const proposals = [];
  const withdrawn = [];
  const status = await ai.browserStatus();
  const { message } = await ai.runAssistant({
    input: scenario.input, context: scenario.context || { scope: 'library' }, browser: scenario.hint || { reveal: false },
    onEvent: event => {
      if (event.type === 'text' || event.type === 'thinking') return;
      if (event.type === 'done') { events.push({ type: 'done' }); return; }
      events.push(JSON.parse(JSON.stringify(event)));
    },
    onProposal: async proposal => { proposals.push(JSON.parse(JSON.stringify(proposal))); return answers.proposal.length ? answers.proposal.shift() : 'discard'; },
    onBrowserPrompt: async prompt => {
      prompts.push(JSON.parse(JSON.stringify(prompt)));
      return answers[prompt.type]?.length ? answers[prompt.type].shift() : declined[prompt.type];
    },
    onBrowserWithdrawn: id => withdrawn.push(id),
  });
  const library = await store.loadLibrary();
  return {
    status, seeded, events, prompts, proposals, withdrawn,
    message: { text: message.text, error: message.error, tools: message.tools, browser: message.browser || null, usedThreads: message.usedThreads === true,
      proposals: (message.proposals || []).map(proposal => ({ status: proposal.status, autoApproved: proposal.autoApproved === true })) },
    items: library.items.map(item => ({ id: item.id, title: item.title, deleted: !!item.deletedAt })),
  };
}

const runners = { protocol: runProtocol, assistant: runAssistant };

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
