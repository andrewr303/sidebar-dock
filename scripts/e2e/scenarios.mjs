// The scenarios of the browser checks, with their judgements. The driver page inside the extension runs the plain data
// of each scenario and reports what happened; `check` runs here, in Node, on that report.
import assert from 'node:assert/strict';

const call = (tool, args, extra = {}) => ({ method: 'call', params: { tool, args }, ...extra });
/** The layer's result of a `call` step, or a failure that says what the host answered. */
function resultOf(step) {
  assert.equal(step.ok, true, `${step.method} ${step.tool || ''} was answered: ${JSON.stringify(step.error)}`);
  return step.result.result;
}

export function buildScenarios({ origin, port }) {
  const page = name => `${origin}/pages/${name}`;
  const site = `127.0.0.1:${port}`;

  return [
    {
      // The service worker's host and the bundled layer, without a model: every step is one request on the port.
      name: 'host-protocol',
      kind: 'protocol',
      steps: [
        { method: 'status' },
        { method: 'call', params: { tool: 'snapshot', args: {} } },
        { method: 'open', params: { policy: { mode: 'ask' }, reveal: false } },
        call('tabs', { action: 'open', url: page('shop.html') }),
        call('snapshot', {}),
        call('find', { role: 'button', name: 'Add to cart' }),
        call('click', { target: { role: 'button', name: 'Add to cart', nth: 0 }, observe: 'diff' }),
        call('read', {}),
        call('screenshot', {}),
        call('navigate', { url: page('contact.html') }),
        call('set', { target: { role: 'textbox', name: 'Your name' }, value: 'Ada' }),
        call('set', { target: { role: 'textbox', name: 'Message' }, value: 'Do you ship to Finland?' }),
        // A form submit asks in Ask mode: declined first, then approved.
        call('click', { target: { role: 'button', name: 'Send message' }, observe: 'diff' }, { answer: ['decline'] }),
        call('click', { target: { role: 'button', name: 'Send message' }, observe: 'diff' }, { answer: ['approve'] }),
        call('navigate', { url: page('account.html') }),
        // Typing a password is the person's own step in every mode: nothing is typed and no card can approve it.
        call('set', { target: { role: 'textbox', name: 'Password' }, value: 'hunter2-secret' }),
        // Deleting asks; "always allow on this site" then lets the second delete run without a card.
        call('click', { target: { role: 'button', name: 'Delete address Home' }, observe: 'diff' }, { answer: ['approve-remember'] }),
        call('click', { target: { role: 'button', name: 'Delete address Office' }, observe: 'diff' }),
        call('navigate', { url: 'chrome://settings/' }),
        call('upload', { paths: ['/etc/passwd'] }),
        { method: 'policy', params: { policy: { mode: 'ask', sites: { [site]: 'block' } } } },
        call('navigate', { url: page('shop.html') }),
        { method: 'close' },
        { method: 'state' },
      ],
      check(result, { server }) {
        const steps = result.steps;
        const at = index => steps[index];
        assert.deepEqual(at(0).result, { available: true, missing: [] });
        assert.equal(at(1).ok, false, 'a call before open is refused');
        assert.equal(at(1).error.code, 'not_open');
        assert.equal(at(2).ok, true, `open: ${JSON.stringify(at(2).error)}`);
        assert.match(at(2).result.sessionId, /^s\d+$/);

        const opened = resultOf(at(3));
        assert.equal(opened.ok, true, opened.text);
        assert.equal(at(3).result.state.tabs.length, 1);
        assert.equal(at(3).result.state.tabs[0].url, page('shop.html'));

        const snapshot = resultOf(at(4));
        assert.equal(snapshot.ok, true, snapshot.text);
        assert.match(snapshot.text, /<<<page-content [0-9a-f]{12} site=127\.0\.0\.1:\d+>>>/, 'page text is inside the boundary, named by its site');
        assert.match(snapshot.text, /<<<end-page-content [0-9a-f]{12}>>>/);
        assert.match(snapshot.text, /heading "Kettle shop"/);
        assert.match(snapshot.text, /\[[a-z]+\d+\] button "Add to cart"/, 'buttons carry refs');

        const found = resultOf(at(5));
        assert.equal(found.data.length, 2, found.text);

        const clicked = resultOf(at(6));
        assert.equal(clicked.ok, true, clicked.text);
        assert.equal(clicked.receipt.dispatched, true);
        assert.equal(clicked.receipt.effect.verdict, 'changed');
        assert.match(clicked.text, /1 item/, 'the diff shows the cart count');
        assert.equal(at(6).prompts.length, 0, 'adding to a cart is not a write that asks');

        const read = resultOf(at(7));
        assert.match(read.text, /49\.90 euros/);
        assert.match(read.text, /Cart: 1 item/);

        const shot = resultOf(at(8));
        assert.equal(shot.ok, true, shot.text);
        assert.equal(shot.data.pngHeader, 'iVBORw0KGgo', 'a PNG image');
        assert.ok(shot.data.width > 300 && shot.data.height > 300);

        assert.equal(resultOf(at(9)).ok, true, resultOf(at(9)).text);
        assert.equal(resultOf(at(10)).ok, true, resultOf(at(10)).text);
        assert.equal(resultOf(at(11)).ok, true, resultOf(at(11)).text);

        const declined = resultOf(at(12));
        assert.equal(at(12).prompts.length, 1, 'the submit asked');
        assert.equal(at(12).prompts[0].type, 'confirm');
        assert.equal(at(12).prompts[0].request.category, 'submit');
        assert.equal(at(12).prompts[0].request.site, site);
        assert.equal(declined.ok, false);
        assert.equal(declined.error.code, 'USER_DECLINED');
        assert.equal(declined.error.delivered, false, 'nothing reached the page');
        assert.equal(server.forms.length >= 0, true);

        const approved = resultOf(at(13));
        assert.equal(at(13).prompts.length, 1);
        assert.equal(approved.ok, true, approved.text);
        assert.equal(approved.receipt.confirmedByUser === true || approved.receipt.allowedBy === 'user', true, JSON.stringify(approved.receipt));
        assert.deepEqual(server.forms.filter(form => form.path === '/sent').map(form => form.fields), [{ name: 'Ada', message: 'Do you ship to Finland?' }], 'the form was sent exactly once');

        assert.equal(resultOf(at(14)).ok, true, resultOf(at(14)).text);
        const secret = resultOf(at(15));
        assert.equal(secret.ok, false, 'a password is never typed by the assistant');
        assert.equal(secret.error.code, 'USER_STEP');
        assert.equal(secret.error.details.reason, 'secret');
        assert.equal(at(15).prompts.length, 0, 'there is no card that could approve it');
        assert.equal(JSON.stringify(at(15)).includes('hunter2-secret'), false, 'the value does not come back in the result');

        const removed = resultOf(at(16));
        assert.equal(at(16).prompts.length, 1);
        assert.equal(at(16).prompts[0].request.category, 'delete');
        assert.equal(at(16).prompts[0].request.canRemember, true);
        assert.equal(removed.ok, true, removed.text);
        const second = resultOf(at(17));
        assert.equal(at(17).prompts.length, 0, 'the site rule from "always allow" lets the next delete run');
        assert.equal(second.ok, true, second.text);
        assert.equal(second.receipt.allowedBy, 'site-rule');

        const browserPage = resultOf(at(18));
        assert.equal(browserPage.ok, false);
        assert.equal(browserPage.error.code, 'URL_NOT_ALLOWED', 'browser pages are closed to the assistant');

        assert.equal(at(19).ok, false, 'upload is not among the host\'s tools');
        assert.equal(at(19).error.code, 'bad_request');

        assert.deepEqual(at(20).result, { ok: true });
        const blocked = resultOf(at(21));
        assert.equal(blocked.ok, false);
        assert.equal(blocked.error.code, 'URL_NOT_ALLOWED', 'a blocked site is closed in the running session');

        assert.deepEqual(at(22).result, { ok: true });
        assert.equal(at(23).error.code, 'not_open');
      },
    },
  ];
}
