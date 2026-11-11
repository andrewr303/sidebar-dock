import test from 'node:test';
import assert from 'node:assert/strict';
import { ASK_TIMEOUT_MS, BROWSER_PORT, HOST_TOOLS, NOTE_LABELS, RESULT_BUDGET, createBrowserHost } from '../extension/lib/browser/host.js';
import { EXTENSION_ID, PAGE, fakeLayer, fakePort, settle, tick } from './helpers/browser-fakes.mjs';

function setup({ granted = ['tabs', 'webNavigation'], layer = fakeLayer(), debuggerApi = { sendCommand() {} } } = {}) {
  const api = {
    runtime: { id: EXTENSION_ID, getURL: path => `chrome-extension://${EXTENSION_ID}/${path}` },
    permissions: { contains: async request => request.permissions.every(permission => granted.includes(permission)) },
    tabs: { get: async tabId => ({ id: tabId, url: `https://www.site${tabId}.example/path` }) },
    debugger: debuggerApi,
  };
  const host = createBrowserHost({ api, loadLayer: layer.load, isContentSender: sender => !String(sender?.url || '').startsWith(api.runtime.getURL('')) });
  return { api, host, layer, granted };
}

let requestId = 0;
/** Sends one request on a port and returns its response once the host has answered. */
async function request(port, method, params) {
  const id = ++requestId;
  port.send({ kind: 'request', id, method, params });
  for (let index = 0; index < 50; index++) {
    const response = port.posted.find(message => message.kind === 'response' && message.id === id);
    if (response) return response;
    await tick();
  }
  throw new Error(`No response to ${method}`);
}

async function opened(options = {}, params = { policy: { engine: 'precise', mode: 'ask' }, reveal: true, startTabId: 7 }) {
  const context = setup(options);
  const port = fakePort();
  context.host.connect(port);
  const response = await request(port, 'open', params);
  return { ...context, port, response, session: context.layer.sessions.at(-1) };
}

test('only the assistant\'s own pages may connect', () => {
  const { host } = setup();
  const other = fakePort(PAGE, 'something-else');
  assert.equal(host.connect(other), false, 'another port name is not the host\'s');
  assert.equal(other.disconnected, false);

  const contentScript = fakePort({ id: EXTENSION_ID, url: 'https://example.com/page', origin: 'https://example.com', tab: { id: 3 } });
  assert.equal(host.connect(contentScript), true);
  assert.equal(contentScript.disconnected, true, 'a content script carries the extension id but is refused');
  assert.equal(contentScript.onMessage.listeners.length, 0);

  const foreign = fakePort({ id: 'anotherextensionidanotherextensio', url: 'chrome-extension://anotherextensionidanotherextensio/page.html' });
  host.connect(foreign);
  assert.equal(foreign.disconnected, true);

  const unknown = fakePort(null);
  host.connect(unknown);
  assert.equal(unknown.disconnected, true);
  assert.equal(host.sessionCount, 0);

  const page = fakePort();
  assert.equal(host.connect(page), true);
  assert.equal(page.disconnected, false);
  assert.equal(host.sessionCount, 1);
});

test('status names the missing Chrome permissions without loading the layer', async () => {
  const { host, layer } = setup({ granted: ['tabs'] });
  const port = fakePort();
  host.connect(port);
  const response = await request(port, 'status', { engine: 'precise' });
  assert.deepEqual(response, { kind: 'response', id: response.id, ok: true, result: { available: false, missing: ['webNavigation'], engine: 'precise' } });
  assert.equal(layer.loads, 0);

  const withAll = setup();
  assert.deepEqual(await withAll.host.status('precise'), { available: true, missing: [], engine: 'precise' });
  const withoutDebugger = setup({ debuggerApi: null });
  assert.equal((await withoutDebugger.host.status('precise')).available, false);
});

test('open refuses without the tab permissions and says which to ask for', async () => {
  const { host, layer } = setup({ granted: [] });
  const port = fakePort();
  host.connect(port);
  const response = await request(port, 'open', { policy: { engine: 'precise', mode: 'auto' } });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'needs_permission');
  assert.deepEqual(response.error.permissions, ['tabs', 'webNavigation']);
  assert.equal(layer.loads, 0, 'the layer is not loaded for a session that cannot start');
});

test('open creates a session with the fixed preset and shares the tab the person is on', async () => {
  const { response, session, layer } = await opened({}, { policy: { engine: 'precise', mode: 'ask', sites: { 'blocked.example': 'block', 'ok.example': 'allow' } }, reveal: true, startTabId: 7 });
  assert.equal(response.ok, true);
  assert.equal(layer.loads, 1);
  assert.equal(response.result.sessionId, 's1');
  assert.equal(response.result.epoch, 'a');
  assert.deepEqual(response.result.startTab, { ok: true });
  assert.deepEqual(response.result.state, { tabs: [{ tabId: 7, url: 'https://site7.example/', title: 'Tab 7', active: true, rev: 0, pending: [] }], activeTabId: 7 });

  const config = session.config;
  assert.deepEqual(config.capabilities, ['human'], 'no page script, devtools or files');
  assert.equal(config.handover, true, 'payments, grants, secrets and prompt dialogs go to the person');
  assert.equal(config.confirmTimeoutMs, Infinity);
  assert.equal(config.askTimeoutMs, ASK_TIMEOUT_MS);
  assert.equal(config.budget, RESULT_BUDGET);
  assert.deepEqual(config.boundary, { labels: [...NOTE_LABELS] });
  assert.deepEqual(config.urlPolicy, { allow: [], deny: [], blocked: ['blocked.example'] });
  assert.equal(config.reveal(), true);
  assert.equal(config.uploadSources, undefined);
});

test('a start tab that cannot join is reported, and the session still opens', async () => {
  const { response } = await opened({}, { policy: { engine: 'precise' }, startTabId: 404 });
  assert.equal(response.ok, true);
  assert.deepEqual(response.result.startTab, { ok: false, code: 'TAB_NOT_IN_SESSION', message: 'Tab 404 does not exist' });
  assert.deepEqual(response.result.state, { tabs: [], activeTabId: null });
});

test('the write decision follows the person\'s mode and site rules', async () => {
  const ask = await opened({}, { policy: { engine: 'precise', mode: 'ask', sites: { 'shop.example': 'allow', 'bank.example': 'ask' } } });
  const decide = ask.session.config.decideWrite;
  assert.deepEqual(decide({ category: 'submit', site: 'other.example', tabId: 1 }), { decision: 'ask', by: 'auto', canRemember: true });
  assert.deepEqual(decide({ category: 'delete', site: 'shop.example', tabId: 1 }), { decision: 'run', by: 'site-rule', canRemember: true });
  assert.deepEqual(decide({ category: 'submit', site: 'bank.example', tabId: 1 }), { decision: 'ask', by: 'site-rule', canRemember: false });
  assert.deepEqual(decide({ category: 'submit', site: '', tabId: 1 }), { decision: 'ask', canRemember: false }, 'a page without a host always asks');

  const auto = await opened({}, { policy: { engine: 'precise', mode: 'auto', sites: { 'bank.example': 'ask' } } });
  assert.equal(auto.session.config.decideWrite({ category: 'submit', site: 'other.example', tabId: 1 }).decision, 'run');
  assert.equal(auto.session.config.decideWrite({ category: 'submit', site: 'bank.example', tabId: 1 }).decision, 'ask', 'a site set to Ask asks in Auto mode too');

  const nonsense = await opened({}, { policy: { engine: 'precise', mode: 'everything', sites: 'no' } });
  assert.equal(nonsense.session.config.decideWrite({ category: 'submit', site: 'a.example', tabId: 1 }).decision, 'ask', 'an unknown mode is Ask');
});

test('call runs only the offered tools and returns the result with the tab state', async () => {
  const { port, session, layer } = await opened();
  for (const tool of ['upload', 'watch_download', 'eval', 'devtools', '', 'constructor']) {
    const refused = await request(port, 'call', { tool, args: {} });
    assert.equal(refused.ok, false, `${tool || '(empty)'} is refused`);
    assert.equal(refused.error.code, 'bad_request');
  }
  assert.equal(session.calls.filter(call => call.tool !== 'tabs').length, 0, 'a refused tool never reaches the layer');
  assert.deepEqual([...HOST_TOOLS].sort(), ['ask_user', 'click', 'fill_form', 'find', 'handle_dialog', 'hover', 'navigate', 'press', 'read', 'screenshot', 'scroll', 'set', 'snapshot', 'tabs', 'type', 'wait']);

  layer.tabStates.set(7, { rev: 4, pending: [{ kind: 'dialog', detail: 'confirm "Leave?"' }] });
  session.handler = (tool, args) => ({ ok: true, text: `clicked ${args.target.ref}`, receipt: { action: 'click', dispatched: true, effect: { verdict: 'changed', signals: ['dom'] } } });
  const response = await request(port, 'call', { tool: 'click', args: { target: { ref: 'a12' }, observe: 'diff' } });
  assert.equal(response.ok, true);
  assert.deepEqual(session.calls.at(-2).args, { target: { ref: 'a12' }, observe: 'diff' });
  assert.equal(response.result.result.text, 'clicked a12');
  assert.equal(response.result.result.receipt.effect.verdict, 'changed');
  assert.deepEqual(response.result.state.tabs[0], { tabId: 7, url: 'https://site7.example/', title: 'Tab 7', active: true, rev: 4, pending: [{ kind: 'dialog', detail: 'confirm "Leave?"' }] });

  session.handler = null;
  const withoutArgs = await request(port, 'call', { tool: 'snapshot', args: 'not an object' });
  assert.equal(withoutArgs.ok, true);
  assert.deepEqual(session.calls.at(-2).args, {});
});

test('a request before open is refused, and an unknown method too', async () => {
  const { host } = setup();
  const port = fakePort();
  host.connect(port);
  for (const method of ['call', 'state', 'share']) {
    const response = await request(port, method, { tool: 'snapshot', tabId: 1 });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'not_open');
  }
  for (const method of ['toString', '__proto__', 'nope']) {
    const response = await request(port, method);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'bad_request');
  }
});

test('cancel aborts the running call', async () => {
  const { port, session } = await opened();
  let seen = null;
  session.handler = (tool, args, options) => new Promise(resolve => {
    seen = options.signal;
    options.signal.addEventListener('abort', () => resolve({ ok: false, text: 'error CANCELLED', error: { code: 'CANCELLED', message: 'cancelled', delivered: false, hint: '' } }));
  });
  const id = ++requestId;
  port.send({ kind: 'request', id, method: 'call', params: { tool: 'wait', args: { ms: 5000 } } });
  await settle();
  assert.equal(seen.aborted, false);
  port.send({ kind: 'cancel', id });
  await settle();
  assert.equal(seen.aborted, true);
  const response = port.posted.find(message => message.kind === 'response' && message.id === id);
  assert.equal(response.result.result.error.code, 'CANCELLED');
});

test('a confirmation goes to the page that holds the tab and takes only the three answers', async () => {
  const { port, layer } = await opened();
  const request7 = { id: 'c1', tabId: 7, category: 'submit', action: 'click', target: 'button «Send»', origin: 'https://site7.example', site: 'site7.example',
    intent: 'send the form', reason: 'the button submits a form', canRemember: true, secret: 'never forwarded' };
  const waiting = layer.prompt.confirm(request7, new AbortController().signal);
  await settle();
  const card = port.posted.find(message => message.kind === 'prompt');
  assert.equal(card.type, 'confirm');
  assert.deepEqual(card.request, { id: 'c1', tabId: 7, category: 'submit', action: 'click', target: 'button «Send»', origin: 'https://site7.example', site: 'site7.example',
    intent: 'send the form', reason: 'the button submits a form', canRemember: true });
  port.send({ kind: 'answer', promptId: card.promptId, answer: 'approve' });
  assert.equal(await waiting, 'approve');

  const second = layer.prompt.confirm({ ...request7, id: 'c2' }, new AbortController().signal);
  await settle();
  const secondCard = port.posted.filter(message => message.kind === 'prompt').at(-1);
  port.send({ kind: 'answer', promptId: secondCard.promptId, answer: 'yes please' });
  assert.equal(await second, 'decline', 'anything but approve is a decline');
  port.send({ kind: 'answer', promptId: secondCard.promptId, answer: 'approve' });

  assert.equal(await layer.prompt.confirm({ ...request7, tabId: 99 }, new AbortController().signal), 'decline', 'no page holds tab 99');
});

test('"always allow on this site" takes effect for the session and only where it was offered', async () => {
  const { port, layer, session } = await opened();
  const base = { id: 'c1', tabId: 7, category: 'submit', action: 'click', target: 'button «Send»', origin: 'https://site7.example', site: 'site7.example', reason: 'submits' };
  assert.equal(session.config.decideWrite({ category: 'submit', site: 'site7.example', tabId: 7 }).decision, 'ask');

  const notOffered = layer.prompt.confirm({ ...base, canRemember: false }, new AbortController().signal);
  await settle();
  port.send({ kind: 'answer', promptId: port.posted.filter(message => message.kind === 'prompt').at(-1).promptId, answer: 'approve-remember' });
  assert.equal(await notOffered, 'approve', 'remembering is dropped where the card did not offer it');
  assert.equal(session.config.decideWrite({ category: 'submit', site: 'site7.example', tabId: 7 }).decision, 'ask');

  const offered = layer.prompt.confirm({ ...base, canRemember: true }, new AbortController().signal);
  await settle();
  port.send({ kind: 'answer', promptId: port.posted.filter(message => message.kind === 'prompt').at(-1).promptId, answer: 'approve-remember' });
  assert.equal(await offered, 'approve-remember');
  assert.deepEqual(session.config.decideWrite({ category: 'submit', site: 'site7.example', tabId: 7 }), { decision: 'run', by: 'site-rule', canRemember: true });
});

test('a prompt whose wait ends is withdrawn, and a late answer has no effect', async () => {
  const { port, layer } = await opened();
  const abort = new AbortController();
  const waiting = layer.prompt.confirm({ id: 'c1', tabId: 7, category: 'delete', action: 'click', target: 'button «Delete»', origin: '', site: 'site7.example', reason: 'deletes', canRemember: false }, abort.signal);
  await settle();
  const card = port.posted.find(message => message.kind === 'prompt');
  abort.abort();
  assert.equal(await waiting, 'decline');
  assert.deepEqual(port.posted.at(-1), { kind: 'prompt-withdrawn', promptId: card.promptId });
  port.send({ kind: 'answer', promptId: card.promptId, answer: 'approve' });

  const already = new AbortController();
  already.abort();
  assert.equal(await layer.prompt.confirm({ id: 'c2', tabId: 7, category: 'delete', site: 'site7.example' }, already.signal), 'decline');
  assert.equal(port.posted.filter(message => message.kind === 'prompt').length, 1, 'an already ended wait shows no card');
});

test('a hand-over names the site from the tab, not from page text, and bounds a typed answer', async () => {
  const { port, layer } = await opened();
  const waiting = layer.prompt.ask({ id: 'u1', tabId: 7, kind: 'input', message: 'Which size?', origin: 'https://evil.example', site: 'evil.example' }, new AbortController().signal);
  await settle();
  const card = port.posted.find(message => message.kind === 'prompt');
  assert.deepEqual(card.request, { id: 'u1', tabId: 7, kind: 'input', message: 'Which size?', site: 'site7.example' });
  port.send({ kind: 'answer', promptId: card.promptId, answer: { outcome: 'continue', data: 'L'.repeat(5000), extra: true } });
  assert.deepEqual(await waiting, { outcome: 'continue', data: 'L'.repeat(2000) });

  const takeover = layer.prompt.ask({ id: 'u2', tabId: 7, kind: 'takeover', message: 'Sign in, then press Done.' }, new AbortController().signal);
  await settle();
  const second = port.posted.filter(message => message.kind === 'prompt').at(-1);
  assert.equal(second.request.kind, 'takeover');
  port.send({ kind: 'answer', promptId: second.promptId, answer: 'continue' });
  assert.deepEqual(await takeover, { outcome: 'cancel' }, 'anything but a continue object cancels');
  assert.deepEqual(await layer.prompt.ask({ id: 'u3', tabId: 99, kind: 'takeover', message: 'x' }, new AbortController().signal), { outcome: 'cancel' });
});

test('policy replaces the rules and the blocked sites of the open session', async () => {
  const { port, session } = await opened({}, { policy: { engine: 'precise', mode: 'ask' }, startTabId: 7 });
  const response = await request(port, 'policy', { policy: { engine: 'precise', mode: 'auto', sites: { 'https://www.Blocked.example/x': 'block' } } });
  assert.deepEqual(response.result, { ok: true });
  assert.deepEqual(session.policies.at(-1), { allow: [], deny: [], blocked: ['blocked.example'] });
  assert.equal(session.config.decideWrite({ category: 'submit', site: 'any.example', tabId: 7 }).decision, 'run');
});

test('share adds a tab and reports a tab that cannot join', async () => {
  const { port, session } = await opened({}, { policy: { engine: 'precise' } });
  const response = await request(port, 'share', { tabId: 9 });
  assert.equal(response.ok, true);
  assert.equal(response.result.state.activeTabId, 9);
  assert.equal(session.hasTab(9), true);
  const failed = await request(port, 'share', { tabId: 404 });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'tab_not_in_session');
  assert.equal((await request(port, 'share', {})).error.code, 'bad_request');
  assert.ok(port.posted.some(message => message.kind === 'tabs' && message.state.activeTabId === 9), 'the page hears that the tabs changed');
});

test('closing the port ends the session: calls stop, cards go and the layer session is closed', async () => {
  const { port, layer, session, host } = await opened();
  let signal = null;
  session.handler = (tool, args, options) => new Promise(() => { signal = options.signal; });
  port.send({ kind: 'request', id: ++requestId, method: 'call', params: { tool: 'wait', args: {} } });
  const waiting = layer.prompt.confirm({ id: 'c1', tabId: 7, category: 'submit', site: 'site7.example', canRemember: false }, new AbortController().signal);
  await settle();
  port.close();
  await settle();
  assert.equal(signal.aborted, true);
  assert.equal(await waiting, 'decline');
  assert.deepEqual(layer.closed, ['s1']);
  assert.equal(host.sessionCount, 0);
  const before = port.posted.length;
  port.send({ kind: 'request', id: ++requestId, method: 'state' });
  await settle();
  assert.equal(port.posted.length, before, 'a closed port is not answered');
});

test('close ends the session and a second open starts a new one', async () => {
  const { port, layer } = await opened();
  assert.deepEqual((await request(port, 'close')).result, { ok: true });
  assert.deepEqual(layer.closed, ['s1']);
  assert.equal((await request(port, 'state')).error.code, 'not_open');
  const again = await request(port, 'open', { policy: { engine: 'precise' } });
  assert.equal(again.result.sessionId, 's2');
  assert.equal(layer.starts, 1, 'the controller is made once per worker');
  const reopened = await request(port, 'open', { policy: { engine: 'precise' } });
  assert.equal(reopened.result.sessionId, 's3');
  assert.deepEqual(layer.closed, ['s1', 's2'], 'opening again closes the session before it');
});

test('a layer that fails to start is reported and tried again next time', async () => {
  const layer = fakeLayer({ failStart: 1 });
  const { host } = setup({ layer });
  const port = fakePort();
  host.connect(port);
  const failed = await request(port, 'open', { policy: { engine: 'precise' } });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'unavailable');
  assert.match(failed.error.message, /no debugger/);
  const second = await request(port, 'open', { policy: { engine: 'precise' } });
  assert.equal(second.ok, true);
  assert.equal(layer.starts, 2);
});

test('with two pages on one tab, the card goes to the page whose call is running', async () => {
  const { host, layer } = setup();
  const [first, second] = [fakePort(), fakePort({ ...PAGE, url: `${PAGE.url}&second` })];
  host.connect(first);
  host.connect(second);
  await request(first, 'open', { policy: { engine: 'precise' }, startTabId: 7 });
  await request(second, 'open', { policy: { engine: 'precise' }, startTabId: 7 });
  layer.sessions[1].handler = () => new Promise(() => {});
  second.send({ kind: 'request', id: ++requestId, method: 'call', params: { tool: 'click', args: {} } });
  await settle();
  layer.prompt.confirm({ id: 'c1', tabId: 7, category: 'submit', site: 'site7.example', canRemember: false }, new AbortController().signal);
  await settle();
  assert.equal(first.posted.some(message => message.kind === 'prompt'), false);
  assert.equal(second.posted.some(message => message.kind === 'prompt'), true);
});

test('malformed messages are ignored', async () => {
  const { port } = await opened();
  const before = port.posted.length;
  for (const message of [null, 'text', 42, [], {}, { kind: 'request' }, { kind: 'request', id: {}, method: 'state' }, { kind: 'answer', promptId: 'nope', answer: 'approve' },
    { kind: 'cancel', id: 'nope' }, { kind: 'ping' }, { kind: 'unknown', id: 1 }]) port.send(message);
  await settle();
  assert.equal(port.posted.length, before);
});
