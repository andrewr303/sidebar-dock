// What the assistant panel shows while the assistant works in browser tabs (lib/ai/browser-tools.js): the cards that
// wait for the person (allow a change, do a step that is theirs, answer something the assistant asked), what became of
// each card, the steps the assistant could not confirm, the notice when Chrome has not allowed it, and the composer's
// Ask first / Auto control. ai-panel.js owns the state and the actions; these functions only draw.
//
// Everything on a card that came from a page or from the model (an element's name, a site, the assistant's stated
// purpose, its question) is text. html`` escapes it, and nothing here turns it into markup or a link.
import { html, cx } from './html.js';
import { icon } from './icons.js';
import { button, badge, iconButton } from './components.js';

const text = value => (typeof value === 'string' ? value : '');

// The layer writes page fragments as «…»; a person reads ordinary quotation marks.
const quoted = value => text(value).replace(/«/g, '“').replace(/»/g, '”').replace(/\s+/g, ' ').trim();

/** An element as the layer names it ('[a18] button «Send message»') in words a person reads: button “Send message”. */
export function targetText(target) {
  return quoted(text(target).replace(/^\[\w+\]\s*/, '')).slice(0, 200);
}

const ACTIONS = { click: 'Click', set: 'Fill in', fill_form: 'Fill in and send', type: 'Type into', press: 'Press a key on', navigate: 'Open', upload: 'Upload to', handle_dialog: 'Answer' };
const CONFIRM_TITLES = { submit: 'Allow the assistant to send this?', delete: 'Allow the assistant to delete this?', upload: 'Allow the assistant to upload this?' };
const HANDOVER = {
  secret: { title: 'This step is yours: type it yourself', body: 'The assistant never types passwords, card numbers or codes. Type it in the tab, then choose Done.' },
  pay: { title: 'This step is yours: the payment', body: 'The assistant prepared what it could. Make the payment in the tab yourself, then choose Done.' },
  grant: { title: 'This step is yours: granting access', body: 'Giving an app or a site access to an account is your decision. Do it in the tab yourself, then choose Done.' },
  prompt: { title: 'This step is yours: the page is asking a question', body: 'Answer the page’s question in the tab yourself, then choose Done.' },
};

/** What a card is about, as one line: Click button “Send message” on shop.example. */
export function cardSubject(card) {
  const request = card?.request || {};
  const target = targetText(request.target);
  const site = text(request.site);
  if (card?.type === 'confirm') return `${ACTIONS[request.action] || 'Act on'} ${target || 'an element'}${site ? ` on ${site}` : ''}`;
  if (card?.type === 'handover') return `${target || 'A step'}${site ? ` on ${site}` : ''}`;
  return site ? `On ${site}` : '';
}

/** How a card that is no longer waiting reads: [icon, text]. */
export function cardOutcome(card) {
  const subject = cardSubject(card);
  const about = subject ? `: ${subject.charAt(0).toLowerCase()}${subject.slice(1)}` : '';
  switch (card?.status) {
    case 'approved': return ['circle-check', `Allowed${about}`];
    case 'remembered': return ['circle-check', `Allowed${about}. Changes on ${text(card.request?.site) || 'this site'} no longer ask.`];
    case 'declined': return ['circle-x', `Not allowed${about}`];
    case 'continued': return ['circle-check', card.request?.kind === 'input' ? 'You answered the assistant.' : 'You did the step and continued.'];
    case 'done': return ['circle-check', 'You did this step yourself.'];
    case 'cancelled': return ['circle-x', card.type === 'handover' ? 'You skipped this step.' : 'You cancelled.'];
    default: return ['circle-x', 'The assistant is no longer waiting for this.'];
  }
}

const head = (glyph, title, id, label = 'Waiting for you') => html`<header class="ai-proposal-head">${icon(glyph, { size: 16 })}
  <h3 class="ai-proposal-title" id="${id}">${title}</h3>${badge({ label, tone: 'warning', className: 'ai-proposal-badge' })}</header>`;
const showTab = card => (Number.isInteger(card.request?.tabId) ? button({ label: 'Show the tab', icon: 'app-window', variant: 'secondary', size: 'sm', action: 'ai.browser-show', data: { tab: card.request.tabId } }) : '');
const answer = (card, value, options) => button({ size: 'sm', action: 'ai.browser-answer', data: { id: card.id, answer: value }, disabled: !card.resolve, ...options });

function confirmCard(card, titleId) {
  const request = card.request || {};
  const site = text(request.site);
  const elsewhere = [text(request.frameHost) && request.frameHost !== site ? `The element is inside a frame from ${request.frameHost}.` : '',
    text(request.destinationHost) && request.destinationHost !== site ? `It sends to ${request.destinationHost}.` : ''].filter(Boolean).join(' ');
  return html`<section class="ai-proposal ai-browser-card" data-key="bc:${card.id}" data-kind="confirm" aria-labelledby="${titleId}">
    ${head('shield-check', CONFIRM_TITLES[request.category] || 'Allow the assistant to make this change?', titleId, 'Needs approval')}
    <div class="ai-browser-body">
      <p class="ai-browser-subject">${cardSubject(card)}</p>
      ${text(request.reason) ? html`<p class="ai-browser-line">${icon('info', { size: 14 })}<span>Why it asks: ${quoted(request.reason).slice(0, 300)}</span></p>` : ''}
      ${elsewhere ? html`<p class="ai-browser-line is-warning">${icon('triangle-alert', { size: 14 })}<span>${elsewhere}</span></p>` : ''}
      ${text(request.intent) ? html`<p class="ai-browser-line">${icon('sparkles', { size: 14 })}<span>The assistant says: ${text(request.intent).slice(0, 300)}</span></p>` : ''}
    </div>
    <footer class="ai-proposal-foot">
      ${answer(card, 'approve', { label: 'Allow', variant: 'primary' })}
      ${request.canRemember === true && site ? answer(card, 'approve-remember', { label: 'Always allow on this site', variant: 'secondary' }) : ''}
      ${showTab(card)}
      <span class="spacer"></span>
      ${answer(card, 'decline', { label: 'Don’t allow', variant: 'ghost' })}
    </footer>
  </section>`;
}

function handoverCard(card, titleId) {
  const copy = HANDOVER[card.request?.reason] || { title: 'This step is yours', body: 'Do this step in the tab yourself, then choose Done.' };
  return html`<section class="ai-proposal ai-browser-card" data-key="bc:${card.id}" data-kind="handover" aria-labelledby="${titleId}">
    ${head('hand', copy.title, titleId)}
    <div class="ai-browser-body">
      ${cardSubject(card) ? html`<p class="ai-browser-subject">${cardSubject(card)}</p>` : ''}
      <p class="ai-browser-line"><span>${copy.body}</span></p>
    </div>
    <footer class="ai-proposal-foot">
      ${answer(card, 'given-back', { label: 'Done', variant: 'primary' })}
      ${showTab(card)}
      <span class="spacer"></span>
      ${answer(card, 'cancelled', { label: 'Skip this step', variant: 'ghost' })}
    </footer>
  </section>`;
}

function askCard(card, titleId) {
  const request = card.request || {};
  const typed = request.kind === 'input';
  const message = text(request.message).slice(0, 2000);
  const where = text(request.site) ? `On ${request.site}` : '';
  const body = html`<div class="ai-browser-body">
      <p class="ai-browser-message">${message}</p>
      ${where ? html`<p class="ai-browser-line"><span>${where}</span></p>` : ''}
      ${typed ? html`<p class="ai-browser-line">${icon('lock', { size: 14 })}<span>Never type a password, a card number or a code here. Type those in the page yourself.</span></p>` : ''}
    </div>`;
  if (!typed) {
    return html`<section class="ai-proposal ai-browser-card" data-key="bc:${card.id}" data-kind="ask" aria-labelledby="${titleId}">
      ${head('hand', 'The assistant needs you to do a step', titleId)}
      ${body}
      <footer class="ai-proposal-foot">
        ${answer(card, 'continue', { label: 'Continue', variant: 'primary' })}
        ${showTab(card)}
        <span class="spacer"></span>
        ${answer(card, 'cancel', { label: 'Cancel', variant: 'ghost' })}
      </footer>
    </section>`;
  }
  return html`<section class="ai-proposal ai-browser-card" data-key="bc:${card.id}" data-kind="ask" aria-labelledby="${titleId}">
    ${head('circle-help', 'The assistant has a question', titleId)}
    ${body}
    <form class="ai-proposal-foot ai-browser-form" data-submit="ai.browser-input" data-id="${card.id}">
      <input class="input input-sm ai-browser-input" type="text" name="answer" aria-label="Your answer" maxlength="2000" autocomplete="off" spellcheck="true"
        data-focus-key="ai-browser-input-${card.id}" ${card.resolve ? '' : html`disabled`}>
      ${button({ label: 'Send', type: 'submit', variant: 'primary', size: 'sm', disabled: !card.resolve })}
      ${answer(card, 'cancel', { label: 'Cancel', variant: 'ghost' })}
    </form>
  </section>`;
}

/**
 * One browser card: { id, type: 'confirm' | 'handover' | 'ask', request, status, resolve }. While status is 'pending'
 * it is a card with its choices (disabled once the engine no longer waits); afterwards one line that says what the
 * person chose.
 */
export function renderBrowserCard(card) {
  if (!card || typeof card.id !== 'string') return '';
  if (card.status !== 'pending') {
    const [glyph, line] = cardOutcome(card);
    return html`<div class="ai-receipt ai-browser-receipt" data-status="${['approved', 'remembered', 'continued', 'done'].includes(card.status) ? 'applied' : card.status}" data-key="bc:${card.id}">
      ${icon(glyph, { size: 16, className: 'ai-receipt-icon' })}<div class="ai-receipt-text"><p class="ai-receipt-title">${line}</p></div></div>`;
  }
  const titleId = `ai-bc-${card.id}`;
  if (card.type === 'confirm') return confirmCard(card, titleId);
  if (card.type === 'handover') return handoverCard(card, titleId);
  return askCard(card, titleId);
}

/** A line Still wrote about the browser (a tool row, an unconfirmed step) as a person reads it: page fragments in ordinary quotes. */
export const browserLine = value => quoted(value);

/** The steps the assistant could not confirm, under its answer: plain lines written by Still from the layer's receipts. */
export function renderUnverified(labels) {
  const list = (Array.isArray(labels) ? labels : []).filter(label => typeof label === 'string' && label).slice(0, 20);
  if (!list.length) return '';
  return html`<div class="ai-unverified" role="note">
    ${icon('circle-alert', { size: 16 })}
    <div class="ai-unverified-text"><p class="ai-unverified-title">${list.length === 1 ? 'One step could not be confirmed' : `${list.length} steps could not be confirmed`}</p>
      <p>Look at the page before you rely on ${list.length === 1 ? 'it' : 'them'}.</p>
      <ul class="ai-unverified-list" role="list">${list.map(label => html`<li>${quoted(label).slice(0, 400)}</li>`)}</ul></div>
  </div>`;
}

const PERMISSION_WORDS = { tabs: 'see and open your tabs', webNavigation: 'follow page loads', sites: 'read and change the pages it works on' };

/** The notice above the composer when browser automation is on but Chrome has not allowed the tab permissions. */
export function renderBrowserNotice(notice) {
  const parts = (Array.isArray(notice?.permissions) ? notice.permissions : []).map(name => PERMISSION_WORDS[name] || name);
  const access = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || 'work in your tabs';
  return html`<div class="ai-notice" role="alert" data-key="ai.browser-notice">
    ${icon('mouse-pointer-click', { size: 16 })}
    <div class="ai-notice-text"><p>Chrome has not allowed Still to ${access}, so the assistant answered without the browser.</p>
      <div class="ai-notice-actions">${button({ label: 'Allow in Chrome', variant: 'primary', size: 'sm', action: 'ai.browser-allow' })}
        ${button({ label: 'Browser settings', variant: 'ghost', size: 'sm', action: 'ai.browser-settings' })}</div></div>
    ${iconButton({ icon: 'x', label: 'Dismiss', size: 'sm', action: 'ai.browser-notice-dismiss' })}
  </div>`;
}

export const BROWSER_MODES = Object.freeze([
  { value: 'ask', label: 'Ask first', hint: 'Changes wait for you' },
  { value: 'auto', label: 'Auto', hint: 'Changes go ahead' },
]);

/** The composer's control for how much the assistant may change on pages. Shown only while browser automation is on. */
export function renderBrowserModeButton({ mode = 'ask', open = false, disabled = false } = {}) {
  const current = BROWSER_MODES.find(entry => entry.value === mode) || BROWSER_MODES[0];
  return html`<button type="button" class="${cx('ai-model-btn', 'ai-mode-btn', mode === 'auto' && 'is-auto')}" data-action="ai.browser-mode" aria-haspopup="menu" aria-expanded="${open ? 'true' : 'false'}"
    ${disabled ? html`disabled` : ''} data-tooltip="Browser: ${current.label}. ${current.hint}." aria-label="Browser automation: ${current.label}">
    ${icon('mouse-pointer-click', { size: 12 })}<span class="ai-model-label">${current.label}</span>${icon('chevron-down', { size: 12 })}</button>`;
}

export function renderBrowserModeMenu({ mode = 'ask' } = {}) {
  return html`<div class="menu ai-model-menu" role="menu" aria-label="Browser automation">
    <div class="menu-heading" role="presentation">When a step sends, posts or deletes</div>
    ${BROWSER_MODES.map(entry => html`<button type="button" class="menu-item" role="menuitemradio" aria-checked="${entry.value === mode ? 'true' : 'false'}" data-action="ai.browser-pick-mode"
      data-mode="${entry.value}" tabindex="-1">${icon(entry.value === mode ? 'check' : 'blank', { size: 16 })}<span class="menu-label">${entry.label}</span><span class="menu-hint">${entry.hint}</span></button>`)}
    <div class="menu-separator" role="separator"></div>
    <p class="ai-mode-note">Auto still asks on sites you set to Ask. Payments, sign-ins, passwords and codes are always yours.</p>
    <button type="button" class="menu-item" role="menuitem" data-action="ai.browser-settings" tabindex="-1">${icon('settings', { size: 16 })}<span class="menu-label">Browser automation settings…</span></button>
  </div>`;
}
