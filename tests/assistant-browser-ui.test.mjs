// The assistant panel's browser cards against a fake engine: what each card shows, what each answer sends to the engine,
// "Always allow on this site", withdrawn cards, the tab hint, the Chrome permission notice and the Ask first / Auto control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aiState } from '../extension/ui/ai-panel.js';
import { dispatch } from '../extension/ui/runtime.js';
import {
  BROWSER_MODES, cardOutcome, cardSubject, renderBrowserCard, renderBrowserModeButton, renderBrowserModeMenu, renderBrowserNotice, renderUnverified, targetText,
} from '../extension/ui/ai-browser.js';

const flat = fragment => String(fragment).replace(/\s+/g, ' ');
const plainText = fragment => String(fragment).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const ticks = async (until, max = 200) => { for (let i = 0; i < max && !until(); i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(until(), 'timed out'); };
const confirmRequest = (extra = {}) => ({ id: 'c1', tabId: 7, category: 'submit', action: 'click', target: '[a18] button «Send message»', origin: 'https://shop.example', site: 'shop.example',
  reason: 'the control submits a form', intent: 'send the message', canRemember: true, ...extra });
const pending = (type, request, id = 'browser-p1') => ({ id, type, request, status: 'pending', resolve: () => {} });

// ------------------------------------------------------------------------------------------------- drawing
test('an element is named for a person: no ref, ordinary quotes', () => {
  assert.equal(targetText('[a18] button «Send message»'), 'button “Send message”');
  assert.equal(targetText('textbox «Password»'), 'textbox “Password”');
  assert.equal(targetText(undefined), '');
  assert.equal(targetText(`[a1] link «${'x'.repeat(400)}»`).length, 200);
});

test('a write card says what, where and why, and offers Allow, Always allow and Don\'t allow', () => {
  const card = pending('confirm', confirmRequest());
  assert.equal(cardSubject(card), 'Click button “Send message” on shop.example');
  const out = flat(renderBrowserCard(card));
  assert.match(out, /<section class="ai-proposal ai-browser-card" data-key="bc:browser-p1" data-kind="confirm"/);
  assert.match(plainText(out), /Allow the assistant to send this\? Needs approval Click button “Send message” on shop\.example Why it asks: the control submits a form The assistant says: send the message/);
  assert.match(plainText(renderBrowserCard(pending('confirm', confirmRequest({ reason: 'it submits its form (POST «https://shop.example/sent»)' })))), /Why it asks: it submits its form \(POST “https:\/\/shop\.example\/sent”\)/, 'a page fragment in the reason reads as a quotation');
  assert.deepEqual([...out.matchAll(/data-action="ai\.browser-answer" data-id="browser-p1" data-answer="([^"]+)"/g)].map(match => match[1]), ['approve', 'approve-remember', 'decline']);
  assert.match(out, /data-action="ai\.browser-show" data-tab="7"/);
  assert.match(plainText(out), /Allow Always allow on this site Show the tab Don’t allow/);
  // A deletion is named as one; a card that may not be remembered has no "Always allow".
  const removal = flat(renderBrowserCard(pending('confirm', confirmRequest({ category: 'delete', canRemember: false, target: '[a4] button «Delete address Home»' }))));
  assert.match(plainText(removal), /Allow the assistant to delete this\?/);
  assert.ok(!removal.includes('approve-remember'));
  assert.ok(!flat(renderBrowserCard(pending('confirm', confirmRequest({ site: '' })))).includes('approve-remember'), 'no site, nothing to remember');
});

test('a write that goes somewhere else says so', () => {
  const out = plainText(renderBrowserCard(pending('confirm', confirmRequest({ frameHost: 'widgets.example', destinationHost: 'pay.example' }))));
  assert.match(out, /The element is inside a frame from widgets\.example\. It sends to pay\.example\./);
  assert.ok(!plainText(renderBrowserCard(pending('confirm', confirmRequest({ frameHost: 'shop.example', destinationHost: 'shop.example' })))).includes('inside a frame'), 'the same site is not news');
});

test('page text and the model\'s words on a card are text, never markup', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const out = String(renderBrowserCard(pending('confirm', confirmRequest({ target: `[a1] button «${hostile}»`, reason: hostile, intent: `${hostile} <a href="javascript:alert(1)">approve</a>`, site: 'shop.example' }))));
  assert.ok(!out.includes('<img'), 'no element from the page');
  assert.ok(!out.includes('<a href'), 'no link from the model');
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const ask = String(renderBrowserCard(pending('ask', { kind: 'takeover', message: `Sign in ${hostile}`, site: 'shop.example', tabId: 7 })));
  assert.ok(!ask.includes('<img'));
});

test('a hand-over card has no Allow: the step is the person\'s, whatever the mode', () => {
  for (const [reason, title] of [['secret', 'This step is yours: type it yourself'], ['pay', 'This step is yours: the payment'], ['grant', 'This step is yours: granting access'],
    ['prompt', 'This step is yours: the page is asking a question'], ['other', 'This step is yours']]) {
    const out = flat(renderBrowserCard(pending('handover', { reason, target: '[a5] textbox «Password»', site: 'shop.example', tabId: 7 }, 'browser-handover-1')));
    assert.match(plainText(out), new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Waiting for you textbox “Password” on shop\\.example`), reason);
    assert.deepEqual([...out.matchAll(/data-answer="([^"]+)"/g)].map(match => match[1]), ['given-back', 'cancelled'], 'Done or Skip, nothing else');
    assert.ok(!/approve/.test(out));
  }
  assert.match(plainText(renderBrowserCard(pending('handover', { reason: 'secret', target: 'textbox «Code»', site: 'x.example', tabId: 1 }))), /The assistant never types passwords, card numbers or codes/);
});

test('a question from the assistant is a takeover with Continue, or a typed answer with a warning about secrets', () => {
  const takeover = flat(renderBrowserCard(pending('ask', { kind: 'takeover', message: 'Please solve the CAPTCHA.', site: 'shop.example', tabId: 7 })));
  assert.match(plainText(takeover), /The assistant needs you to do a step Waiting for you Please solve the CAPTCHA\. On shop\.example Continue Show the tab Cancel/);
  assert.deepEqual([...takeover.matchAll(/data-answer="([^"]+)"/g)].map(match => match[1]), ['continue', 'cancel']);
  const typed = flat(renderBrowserCard(pending('ask', { kind: 'input', message: 'Which size?', site: 'shop.example', tabId: 7 })));
  assert.match(typed, /<form class="ai-proposal-foot ai-browser-form" data-submit="ai\.browser-input" data-id="browser-p1">/);
  assert.match(typed, /<input class="input input-sm ai-browser-input" type="text" name="answer"/);
  assert.match(plainText(typed), /Never type a password, a card number or a code here/);
});

test('a card that is no longer waiting is one line that says what was chosen', () => {
  const card = status => ({ ...pending('confirm', confirmRequest()), status, resolve: null });
  assert.deepEqual(cardOutcome(card('approved')), ['circle-check', 'Allowed: click button “Send message” on shop.example']);
  assert.deepEqual(cardOutcome(card('remembered')), ['circle-check', 'Allowed: click button “Send message” on shop.example. Changes on shop.example no longer ask.']);
  assert.deepEqual(cardOutcome(card('declined')), ['circle-x', 'Not allowed: click button “Send message” on shop.example']);
  assert.equal(cardOutcome(card('withdrawn'))[1], 'The assistant is no longer waiting for this.');
  assert.equal(cardOutcome({ type: 'handover', status: 'done', request: { reason: 'secret' } })[1], 'You did this step yourself.');
  assert.equal(cardOutcome({ type: 'handover', status: 'cancelled', request: {} })[1], 'You skipped this step.');
  assert.equal(cardOutcome({ type: 'ask', status: 'continued', request: { kind: 'input' } })[1], 'You answered the assistant.');
  const receipt = flat(renderBrowserCard(card('approved')));
  assert.match(receipt, /<div class="ai-receipt ai-browser-receipt" data-status="applied" data-key="bc:browser-p1">/);
  assert.ok(!receipt.includes('data-action'), 'nothing left to press');
  assert.match(flat(renderBrowserCard(card('declined'))), /data-status="declined"/);
  assert.equal(String(renderBrowserCard(null)), '');
});

test('steps that could not be confirmed are listed under the answer', () => {
  assert.equal(String(renderUnverified([])), '');
  assert.equal(String(renderUnverified(undefined)), '');
  const one = plainText(renderUnverified(['Clicked button «Send» on shop.example: the page showed no effect']));
  assert.match(one, /^One step could not be confirmed Look at the page before you rely on it\. Clicked button “Send” on shop\.example: the page showed no effect$/);
  const two = flat(renderUnverified(['a', 'b <script>']));
  assert.match(two, /2 steps could not be confirmed/);
  assert.ok(two.includes('b &lt;script&gt;') && !two.includes('<script>'));
});

test('the permission notice says what Chrome has to allow', () => {
  const out = plainText(renderBrowserNotice({ permissions: ['tabs', 'webNavigation'] }));
  assert.match(out, /Chrome has not allowed Still to see and open your tabs and follow page loads, so the assistant answered without the browser\./);
  assert.match(flat(renderBrowserNotice({ permissions: ['tabs'] })), /data-action="ai\.browser-allow"/);
});

test('the composer control shows the mode and its menu names both, with what never changes', () => {
  assert.deepEqual(BROWSER_MODES.map(mode => mode.value), ['ask', 'auto']);
  const ask = flat(renderBrowserModeButton({ mode: 'ask' }));
  assert.match(ask, /class="ai-model-btn ai-mode-btn" data-action="ai\.browser-mode"/);
  assert.match(plainText(ask), /^Ask first$/);
  const auto = flat(renderBrowserModeButton({ mode: 'auto', open: true, disabled: true }));
  assert.match(auto, /is-auto/);
  assert.match(auto, /aria-expanded="true"/);
  assert.match(auto, / disabled /);
  const menu = flat(renderBrowserModeMenu({ mode: 'auto' }));
  assert.deepEqual([...menu.matchAll(/role="menuitemradio" aria-checked="(true|false)" data-action="ai\.browser-pick-mode" data-mode="(\w+)"/g)].map(match => [match[2], match[1]]), [['ask', 'false'], ['auto', 'true']]);
  assert.match(plainText(menu), /When a step sends, posts or deletes Ask first Changes wait for you Auto Changes go ahead Auto still asks on sites you set to Ask\. Payments, sign-ins, passwords and codes are always yours\./);
});

// ------------------------------------------------------------------------------------------- with the panel
function fakeCtx({ sidepanel = false, page = null, settings = { browser: { enabled: true, mode: 'ask', sites: {}, maxSteps: 60 } } } = {}) {
  const calls = { settings: [], run: [], toasts: [] };
  let stored = structuredClone(settings);
  const ctx = {
    state: { view: 'assistant', panel: null, selection: new Set(), popover: null, dialogs: [], shell: { docked: true }, assistant: { layout: 'wide', sheet: null, query: '' }, page },
    env: { isSidepanel: sidepanel, isNewtab: false, isExtension: true, isMac: false, modKey: 'Ctrl' },
    prefs: { get: (key, fallback) => fallback, set() {} },
    library: { items: [], collections: [], settings: {} },
    select: { byId: () => null, live: () => [], path: () => [], collection: () => null, recentCollections: () => [], tree: () => [], descendants: id => [id], savedForUrl: () => null },
    store: {},
    ai: {
      listConversations: async () => [], saveConversation: async value => value, getConversation: async () => null,
      getAiSettings: async () => structuredClone(stored),
      setAiSettings: async patch => { calls.settings.push(structuredClone(patch)); stored = { ...stored, browser: { ...stored.browser, ...patch.browser } }; return structuredClone(stored); },
    },
    render() {}, renderNow() {}, nextFrame() {}, toast: (message, options) => calls.toasts.push([message, options]), syncUrl() {}, closePopover() {}, openPopover() {},
    // The worker's answer about the page beside the panel.
    chrome: async () => ({ tabId: page?.tabId, url: page?.url || '', title: page?.title || '', text: '' }),
  };
  const s = aiState(ctx);
  s.target = { providerName: 'Anthropic', model: 'claude-sonnet-5-5', modelLabel: 'Claude Sonnet 5.5', via: 'direct', efforts: [] };
  s.settings = structuredClone(settings);
  s.history = [];
  return { ctx, calls };
}

/** An engine turn that shows the given cards one after another and reports what each was answered with. */
function fakeRun(ctx, calls, cards, { events = [] } = {}) {
  const answers = [];
  ctx.ai.runAssistant = async options => {
    calls.run.push({ browser: options.browser });
    for (const event of events) options.onEvent(event);
    for (const card of cards) answers.push(await options.onBrowserPrompt(card));
    const message = { id: 'msg_1', role: 'assistant', text: 'Done.', proposals: [], tools: [], citations: [], browser: { activity: [{ step: 1, kind: 'write', text: 'tab 7 · click' }], unverified: ['click button «Send» on tab 7: the page showed no effect'] } };
    options.onEvent({ type: 'browser', activity: message.browser.activity, unverified: message.browser.unverified });
    return { conversation: { id: options.conversationId, title: 'Shop', messages: [{ id: 'q_1', role: 'user', text: 'Send it' }, message] }, message };
  };
  return answers;
}
const liveCards = ctx => aiState(ctx).run?.message.browserCards || [];
const send = async (ctx, question = 'Send the form') => { globalThis.document ??= { getElementById: () => null }; aiState(ctx).draft = question; await dispatch('ai.send', { ctx }); };

test('each answer on a card reaches the engine as the value the browser tools expect', async () => {
  const { ctx, calls } = fakeCtx();
  const answers = fakeRun(ctx, calls, [
    { id: 'browser-p1', type: 'confirm', request: confirmRequest() },
    { id: 'browser-p2', type: 'confirm', request: confirmRequest({ target: '[a2] button «Delete»', category: 'delete' }) },
    { id: 'browser-handover-1', type: 'handover', request: { reason: 'secret', target: 'textbox «Password»', site: 'shop.example', tabId: 7 } },
    { id: 'browser-p3', type: 'ask', request: { kind: 'takeover', message: 'Solve the CAPTCHA', site: 'shop.example', tabId: 7 } },
    { id: 'browser-p4', type: 'ask', request: { kind: 'input', message: 'Which size?', site: 'shop.example', tabId: 7 } },
    { id: 'browser-p5', type: 'ask', request: { kind: 'input', message: 'Which colour?', site: 'shop.example', tabId: 7 } },
  ]);
  await send(ctx);
  const waitFor = id => ticks(() => liveCards(ctx).some(card => card.id === id && card.status === 'pending'));
  await waitFor('browser-p1');
  assert.equal(aiState(ctx).announce.replace(/ /g, ''), 'The assistant is waiting for your approval.');
  await dispatch('ai.browser-answer', { ctx, data: { id: 'browser-p1', answer: 'approve' } });
  await waitFor('browser-p2');
  assert.equal(liveCards(ctx)[0].status, 'approved');
  await dispatch('ai.browser-answer', { ctx, data: { id: 'browser-p2', answer: 'decline' } });
  await waitFor('browser-handover-1');
  await dispatch('ai.browser-answer', { ctx, data: { id: 'browser-handover-1', answer: 'given-back' } });
  await waitFor('browser-p3');
  await dispatch('ai.browser-answer', { ctx, data: { id: 'browser-p3', answer: 'continue' } });
  await waitFor('browser-p4');
  await dispatch('ai.browser-input', { ctx, el: { elements: { answer: { value: '  Medium  ' } } }, data: { id: 'browser-p4' } });
  await waitFor('browser-p5');
  await dispatch('ai.browser-answer', { ctx, data: { id: 'browser-p5', answer: 'cancel' } });
  await ticks(() => !aiState(ctx).run);
  assert.deepEqual(answers, ['approve', 'decline', 'given-back', { outcome: 'continue' }, { outcome: 'continue', data: 'Medium' }, { outcome: 'cancel' }]);
  assert.deepEqual(calls.settings, [], 'no rule was saved');
});

test('a card takes only its own answers, once', async () => {
  const { ctx, calls } = fakeCtx();
  const answers = fakeRun(ctx, calls, [{ id: 'browser-handover-1', type: 'handover', request: { reason: 'pay', target: 'button «Pay now»', site: 'shop.example', tabId: 7 } }]);
  await send(ctx);
  await ticks(() => liveCards(ctx).length === 1);
  // An approval is not an answer to a hand-over, and an unknown card is ignored.
  await dispatch('ai.browser-answer', { ctx, data: { id: 'browser-handover-1', answer: 'approve' } });
  await dispatch('ai.browser-answer', { ctx, data: { id: 'nope', answer: 'given-back' } });
  assert.equal(liveCards(ctx)[0].status, 'pending');
  await dispatch('ai.browser-answer', { ctx, data: { id: 'browser-handover-1', answer: 'cancelled' } });
  await dispatch('ai.browser-answer', { ctx, data: { id: 'browser-handover-1', answer: 'given-back' } });
  await ticks(() => !aiState(ctx).run);
  assert.deepEqual(answers, ['cancelled'], 'the second press changed nothing');
});

test('"Always allow on this site" saves the rule, and only where the card offered it', async () => {
  const { ctx, calls } = fakeCtx({ settings: { browser: { enabled: true, mode: 'ask', sites: { 'bank.example': 'block' }, maxSteps: 60 } } });
  const answers = fakeRun(ctx, calls, [
    { id: 'browser-p1', type: 'confirm', request: confirmRequest() },
    { id: 'browser-p2', type: 'confirm', request: confirmRequest({ canRemember: false, site: 'other.example' }) },
  ]);
  await send(ctx);
  await ticks(() => liveCards(ctx).some(card => card.id === 'browser-p1'));
  await dispatch('ai.browser-answer', { ctx, data: { id: 'browser-p1', answer: 'approve-remember' } });
  await ticks(() => liveCards(ctx).some(card => card.id === 'browser-p2'));
  assert.equal(liveCards(ctx)[0].status, 'remembered');
  await dispatch('ai.browser-answer', { ctx, data: { id: 'browser-p2', answer: 'approve-remember' } });
  await ticks(() => !aiState(ctx).run);
  assert.deepEqual(answers, ['approve-remember', 'approve'], 'a card that cannot be remembered is allowed once');
  await ticks(() => calls.settings.length === 1);
  assert.deepEqual(calls.settings, [{ browser: { sites: { 'bank.example': 'block', 'shop.example': 'allow' } } }], 'the other rules are kept');
  assert.equal(aiState(ctx).settings.browser.sites['shop.example'], 'allow');
});

test('a card the engine stops waiting for can no longer be answered', async () => {
  const { ctx, calls } = fakeCtx();
  let withdraw;
  const seen = [];
  ctx.ai.runAssistant = async options => {
    calls.run.push({ browser: options.browser });
    const answer = options.onBrowserPrompt({ id: 'browser-p1', type: 'confirm', request: confirmRequest() });
    answer.then(value => seen.push(value));
    await new Promise(resolve => { withdraw = () => { options.onBrowserWithdrawn('browser-p1'); resolve(); }; });
    const message = { id: 'msg_1', role: 'assistant', text: '', error: 'Stopped', proposals: [], tools: [], citations: [] };
    return { conversation: { id: options.conversationId, title: 'x', messages: [{ id: 'q', role: 'user', text: 'x' }, message] }, message };
  };
  await send(ctx);
  await ticks(() => liveCards(ctx).length === 1);
  const card = liveCards(ctx)[0];
  withdraw();
  assert.equal(card.status, 'withdrawn');
  assert.match(plainText(renderBrowserCard(card)), /The assistant is no longer waiting for this\./);
  await dispatch('ai.browser-answer', { ctx, data: { id: 'browser-p1', answer: 'approve' } });
  await ticks(() => !aiState(ctx).run);
  assert.deepEqual(seen, [], 'a late press approves nothing');
});

test('beside a web page the assistant starts in that tab and the view follows it; in a full tab it does neither', async () => {
  const side = fakeCtx({ sidepanel: true, page: { tabId: 42, windowId: 1, url: 'https://shop.example/cart', title: 'Cart' } });
  fakeRun(side.ctx, side.calls, []);
  await send(side.ctx);
  await ticks(() => !aiState(side.ctx).run);
  assert.deepEqual(side.calls.run[0].browser, { tabId: 42, reveal: true });

  const browserPage = fakeCtx({ sidepanel: true, page: { tabId: 43, windowId: 1, url: 'chrome://extensions/', title: 'Extensions' } });
  fakeRun(browserPage.ctx, browserPage.calls, []);
  await send(browserPage.ctx);
  await ticks(() => !aiState(browserPage.ctx).run);
  assert.deepEqual(browserPage.calls.run[0].browser, { tabId: null, reveal: true }, 'a browser page is not a tab to work in');

  const full = fakeCtx({ sidepanel: false, page: { tabId: 44, windowId: 1, url: 'https://shop.example/', title: 'Shop' } });
  fakeRun(full.ctx, full.calls, []);
  await send(full.ctx);
  await ticks(() => !aiState(full.ctx).run);
  assert.deepEqual(full.calls.run[0].browser, { tabId: null, reveal: false });
});

test('when Chrome has not allowed the tabs, the composer says so until it is allowed, dismissed or the next question', async () => {
  const { ctx, calls } = fakeCtx();
  fakeRun(ctx, calls, [], { events: [{ type: 'browser_permission', permissions: ['tabs', 'webNavigation', 'downloads'] }] });
  await send(ctx);
  await ticks(() => !aiState(ctx).run);
  assert.deepEqual(aiState(ctx).browserNotice, { permissions: ['tabs', 'webNavigation'] }, 'only the permissions browser automation uses');
  await dispatch('ai.browser-notice-dismiss', { ctx });
  assert.equal(aiState(ctx).browserNotice, null);

  aiState(ctx).browserNotice = { permissions: ['tabs'] };
  const requested = [];
  const previous = globalThis.chrome;
  globalThis.chrome = { permissions: { request: async request => { requested.push(request); return true; } } };
  try { await dispatch('ai.browser-allow', { ctx }); } finally { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; }
  assert.deepEqual(requested, [{ permissions: ['tabs'] }]);
  assert.equal(aiState(ctx).browserNotice, null);
  assert.match(calls.toasts.at(-1)[0], /Ask again and the assistant can work in the browser/);
});

test('the saved answer keeps the steps that could not be confirmed', async () => {
  const { ctx, calls } = fakeCtx();
  fakeRun(ctx, calls, []);
  await send(ctx);
  await ticks(() => !aiState(ctx).run);
  const saved = aiState(ctx).conversation.messages.at(-1);
  assert.deepEqual(saved.browser.unverified, ['click button «Send» on tab 7: the page showed no effect']);
});

test('picking Auto or Ask first in the composer saves the mode', async () => {
  const { ctx, calls } = fakeCtx();
  await dispatch('ai.browser-pick-mode', { ctx, data: { mode: 'auto' } });
  assert.deepEqual(calls.settings, [{ browser: { mode: 'auto' } }]);
  assert.equal(aiState(ctx).settings.browser.mode, 'auto');
  await dispatch('ai.browser-pick-mode', { ctx, data: { mode: 'always' } });
  assert.equal(calls.settings.length, 1, 'an unknown mode is not saved');
});
