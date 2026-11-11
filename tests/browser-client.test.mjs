import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserHost } from '../extension/lib/browser/host.js';
import { BrowserClientError, createBrowserClient } from '../extension/lib/ai/browser-client.js';
import { fakeChrome, fakeLayer, portPair, settle } from './helpers/browser-fakes.mjs';

/** A client wired to the real host through connected ports. `pairs` holds every port the client opened. */
function setup({ granted, layer = fakeLayer(), pingMs = 0 } = {}) {
  const api = fakeChrome({ granted });
  const host = createBrowserHost({ api, loadLayer: layer.load, isContentSender: () => false });
  const pairs = [];
  const client = createBrowserClient({ pingMs, connect: () => { const pair = portPair(); pairs.push(pair); host.connect(pair.worker); return pair.page; } });
  return { api, host, layer, client, pairs };
}

test('status answers without opening a session or loading the layer', async () => {
  const { client, layer, pairs } = setup({ granted: ['tabs'] });
  assert.deepEqual(await client.status(), { available: false, missing: ['webNavigation'] });
  assert.equal(layer.loads, 0);
  assert.equal(client.isOpen, false);
  assert.equal(client.connected, true);
  await client.close();
  assert.equal(client.connected, false);
  assert.equal(pairs.length, 1);
});

test('a call before open is refused; open then call returns the layer result and the tabs', async () => {
  const { client, layer } = setup();
  await assert.rejects(client.call('snapshot', {}), error => error instanceof BrowserClientError && error.code === 'not_open');
  const opened = await client.open({ policy: { mode: 'ask' }, reveal: true, startTabId: 7 });
  assert.equal(opened.sessionId, 's1');
  assert.deepEqual(opened.startTab, { ok: true });
  assert.equal(opened.state.activeTabId, 7);
  assert.equal(client.isOpen, true);
  const session = layer.sessions[0];
  session.handler = (tool, args) => ({ ok: true, text: `did ${tool} ${JSON.stringify(args)}`, page: { tabId: 7, url: 'https://site7.example/', rev: 2, changed: 'full' } });
  const answer = await client.call('snapshot', { tabId: 7 });
  assert.equal(answer.result.text, 'did snapshot {"tabId":7}');
  assert.equal(answer.reconnected, false);
  assert.deepEqual(answer.state.tabs.map(tab => tab.tabId), [7]);
  await client.close();
  assert.deepEqual(layer.closed, ['s1'], 'closing ends the session in the worker');
});

test('a refused open carries the permissions to ask for', async () => {
  const { client } = setup({ granted: [] });
  await assert.rejects(client.open({ policy: {} }), error => error.code === 'needs_permission' && error.permissions.join() === 'tabs,webNavigation');
  assert.equal(client.isOpen, false);
});

test('a confirmation goes to the handler and its answer back to the layer; no handler declines', async () => {
  const { client, layer } = setup();
  await client.open({ policy: { mode: 'ask' }, startTabId: 7 });
  const session = layer.sessions[0];
  const seen = [];
  client.onPrompt(async prompt => { seen.push(prompt); return 'approve'; });
  session.handler = async () => {
    const answer = await layer.prompt.confirm({ id: 'c1', tabId: 7, category: 'submit', action: 'click', target: 'button «Send»', origin: 'https://site7.example', site: 'site7.example', reason: 'submits a form', canRemember: true });
    return { ok: answer !== 'decline', text: `answer: ${answer}` };
  };
  assert.equal((await client.call('click', { target: { ref: 'a1' } })).result.text, 'answer: approve');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'confirm');
  assert.equal(seen[0].request.target, 'button «Send»');
  assert.equal(seen[0].request.canRemember, true);

  client.onPrompt(null);
  assert.equal((await client.call('click', { target: { ref: 'a1' } })).result.text, 'answer: decline');
  client.onPrompt(async () => { throw new Error('the card broke'); });
  const errors = console.error;
  console.error = () => {};
  try { assert.equal((await client.call('click', { target: { ref: 'a1' } })).result.text, 'answer: decline', 'a failing card declines'); }
  finally { console.error = errors; }
  await client.close();
});

test('Stop reaches the worker as a cancel, and the open card is withdrawn', async () => {
  const { client, layer } = setup();
  await client.open({ policy: { mode: 'ask' }, startTabId: 7 });
  const session = layer.sessions[0];
  const withdrawn = [];
  let shown = null;
  client.onPrompt(prompt => { shown = prompt; return new Promise(() => {}); });
  client.onWithdrawn(promptId => withdrawn.push(promptId));
  session.handler = async (tool, args, { signal }) => {
    const answer = await layer.prompt.confirm({ id: 'c1', tabId: 7, category: 'submit', action: 'click', target: 'button', origin: 'o', site: 'site7.example', reason: 'r', canRemember: false }, signal);
    return { ok: false, text: `error ${signal.aborted ? 'CANCELLED' : 'USER_DECLINED'}`, error: { code: signal.aborted ? 'CANCELLED' : 'USER_DECLINED', delivered: false }, answer };
  };
  const stop = new AbortController();
  const pending = client.call('click', { target: { ref: 'a1' } }, { signal: stop.signal });
  await settle();
  assert.ok(shown, 'the card is open');
  stop.abort();
  const answer = await pending;
  assert.equal(answer.result.error.code, 'CANCELLED');
  assert.deepEqual(withdrawn, [shown.promptId]);
  await client.close();
});

test('after the worker stops, the next call opens the session again, shares the tabs it held and says so', async () => {
  const { client, layer, pairs } = setup();
  await client.open({ policy: { mode: 'auto', sites: { 'blocked.example': 'block' } }, reveal: true, startTabId: 7 });
  await client.share(9);
  assert.deepEqual((await client.state()).tabs.map(tab => tab.tabId).sort(), [7, 9]);
  pairs[0].cut();
  assert.equal(client.connected, false);
  assert.equal(client.isOpen, true, 'the session is still the client\'s to reopen');
  const answer = await client.call('snapshot', {});
  assert.equal(answer.reconnected, true);
  assert.equal(pairs.length, 2);
  const second = layer.sessions[1];
  assert.deepEqual([...second.tabs.keys()].sort(), [7, 9], 'the tabs the first session held are shared again');
  assert.equal(second.config.urlPolicy.blocked.join(), 'blocked.example', 'with the same rules');
  assert.equal(second.config.reveal(), true);
  const next = await client.call('snapshot', {});
  assert.equal(next.reconnected, false);
  await client.close();
});

test('a call the worker died under is reported as interrupted, never retried', async () => {
  const { client, layer, pairs } = setup();
  await client.open({ policy: {}, startTabId: 7 });
  const session = layer.sessions[0];
  let calls = 0;
  session.handler = () => { calls++; return new Promise(() => {}); };
  const pending = client.call('click', { target: { ref: 'a1' } });
  await settle();
  pairs[0].cut();
  await assert.rejects(pending, error => error.code === 'interrupted');
  assert.equal(calls, 1);
  assert.equal(pairs.length, 1, 'no second port was opened for the same call');
  await client.close();
});

test('a policy change is kept for a reopened session and sent to an open one', async () => {
  const { client, layer, pairs } = setup();
  await client.open({ policy: { mode: 'ask' }, startTabId: 7 });
  await client.setPolicy({ mode: 'ask', sites: { 'shop.example': 'block' } });
  assert.deepEqual(layer.sessions[0].policies.at(-1).blocked, ['shop.example']);
  pairs[0].cut();
  await client.call('snapshot', {});
  assert.deepEqual(layer.sessions[1].config.urlPolicy.blocked, ['shop.example']);
  await client.close();
});

test('an open session keeps the worker awake with pings and stops when it closes', async () => {
  const { client, pairs } = setup({ pingMs: 5 });
  await client.open({ policy: {} });
  await new Promise(resolve => setTimeout(resolve, 40));
  const pings = pairs[0].page.sent.filter(message => message.kind === 'ping').length;
  assert.ok(pings >= 2, `pings sent: ${pings}`);
  await client.close();
  const after = pairs[0].page.sent.length;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(pairs[0].page.sent.length, after, 'no ping after close');
});
