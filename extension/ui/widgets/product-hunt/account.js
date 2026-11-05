// Product Hunt account card: shown in Settings > Connected accounts, in the "Connect Product Hunt" dialog and behind the
// widget's "Get rankings" prompts. A developer token is checked against the API before it is saved to lib/accounts.js.
// The API accepts requests from any origin, so connecting needs no host access.
import { html, cx, safeSrc } from '../../html.js';
import { icon } from '../../icons.js';
import { button, input, field, badge, shortDate, dialogFrame, avatarTile } from '../../components.js';
import { registerActions } from '../../runtime.js';
import { registerDialog } from '../../overlay.js';
import { saveAccount, removeAccount, registerAccountProvider, validateToken } from '../../../lib/accounts.js';
import { ACCOUNT_ID, TOKEN_URL, ProductHuntError, createProductHuntClient } from '../../../lib/producthunt.js';
import { session, bindCtx, ensureAccount, connected, rerender, resetSession, errorInfo, client, refreshMounted } from './session.js';
import { brandMark } from './glyphs.js';

const DIALOG = 'w.product-hunt.connect';
const draft = { token: '', error: '', busy: '', replacing: false };
const tokenField = context => `ph-token-${context}`;

function who() {
  const info = session.info;
  if (!info?.connected) return null;
  return { name: info.name || '', username: info.login || '', avatarUrl: info.avatarUrl || '' };
}

/**
 * The card. context: 'settings' | 'dialog' keeps element ids unique when two copies are on screen; level is the heading
 * level for the card title; bare drops the card chrome (inside a dialog).
 */
export function renderAccountCard(ctx, { context = 'settings', level = 4, bare = false } = {}) {
  bindCtx(ctx);
  ensureAccount();
  const isConnected = connected();
  const person = who();
  const status = !session.loaded ? null : isConnected && session.authFailed ? { label: 'Needs attention', tone: 'warning', icon: 'triangle-alert' }
    : isConnected ? { label: 'Connected', tone: 'success', icon: 'circle-check' } : { label: 'Not connected', tone: 'neutral' };
  const showForm = !isConnected || draft.replacing || session.authFailed;
  const titleId = `ph-account-title-${context}`;
  const heading = html`<span class="w-ph-account-name">Product Hunt</span>${status ? badge(status) : ''}`;
  const title = level === 3 ? html`<h3 class="w-ph-account-title" id="${titleId}">${heading}</h3>` : level === 2 ? html`<h2 class="w-ph-account-title" id="${titleId}">${heading}</h2>`
    : html`<h4 class="w-ph-account-title" id="${titleId}">${heading}</h4>`;
  return html`<section class="${cx('w-ph-account', bare && 'is-bare')}" aria-labelledby="${titleId}" data-context="${context}">
    <header class="w-ph-account-head">
      ${brandMark(36)}
      <div class="w-ph-account-heading">
        ${title}
        <p class="w-ph-account-desc">Adds daily rankings, upvotes, comments and topics to the Product Hunt widget. Without a token, the widget shows the latest launches from the public feed.</p>
      </div>
    </header>
    ${isConnected ? html`<div class="w-ph-account-who">
      ${safeSrc(person?.avatarUrl) ? html`<img class="w-ph-account-avatar" src="${safeSrc(person.avatarUrl)}" alt="" width="36" height="36" referrerpolicy="no-referrer">`
        : avatarTile({ label: person?.name || 'Product Hunt', icon: person?.name ? undefined : 'key-round', size: 36, round: true, color: 'orange' })}
      <div class="w-ph-account-who-text">
        <p class="w-ph-account-person">${person?.name || 'Developer token'}</p>
        <p class="w-ph-account-meta">${person?.username ? `@${person.username}` : 'Saved on this device'}${session.info?.updatedAt ? html`<span> · Checked ${shortDate(session.info.updatedAt)}</span>` : ''}</p>
      </div>
    </div>` : ''}
    ${isConnected && session.authFailed ? html`<p class="w-ph-account-alert" role="alert">${icon('triangle-alert', { size: 14 })}<span>Product Hunt no longer accepts the saved token, so your widgets show the public feed. Paste a new developer token to see rankings again.</span></p>` : ''}
    ${showForm ? tokenForm(context) : ''}
    ${isConnected ? html`<div class="w-ph-account-actions">
      ${button({ label: 'Check connection', icon: 'refresh-cw', size: 'sm', variant: 'secondary', action: 'w.product-hunt.check', loading: draft.busy === 'check' })}
      ${!session.authFailed ? button({ label: draft.replacing ? 'Keep current token' : 'Replace token', size: 'sm', variant: 'ghost', action: 'w.product-hunt.replace-token', data: { context } }) : ''}
      ${button({ label: 'Disconnect', icon: 'log-out', size: 'sm', variant: 'ghost', action: 'w.product-hunt.disconnect', className: 'w-ph-account-disconnect' })}
    </div>` : ''}
  </section>`;
}

function tokenForm(context) {
  const id = tokenField(context);
  const isConnected = connected();
  return html`<form class="w-ph-account-form" data-submit="w.product-hunt.connect" data-context="${context}" novalidate>
    <ol class="w-ph-account-steps">
      <li>Open <a class="link-inline" href="${TOKEN_URL}" target="_blank" rel="noopener noreferrer">API applications on Product Hunt</a> and add an application. Any name works; use <code>https://localhost</code> as the redirect URI.</li>
      <li>Copy the application’s <strong>Developer token</strong> and paste it here.</li>
    </ol>
    ${field({ label: isConnected ? 'New developer token' : 'Developer token', id, error: draft.error,
      hint: 'Still uses it only to read public launches. It never posts or votes for you.',
      control: input({ id, name: 'token', type: 'password', value: draft.token, action: 'w.product-hunt.token-input', placeholder: 'Paste the developer token', invalid: !!draft.error,
        describedBy: draft.error ? `${id}-error` : `${id}-hint`, required: true }) })}
    <div class="w-ph-account-submit">${button({ label: isConnected ? 'Save new token' : 'Connect Product Hunt', type: 'submit', size: 'sm', variant: 'primary', loading: draft.busy === 'connect' })}
      <span class="w-ph-account-note">${icon('lock', { size: 12 })}Stored only on this device.</span></div>
  </form>`;
}

/** Opens the connect dialog (used by the widget's prompts and menus). */
export function openConnect(ctx) {
  Object.assign(draft, { error: '', busy: '', replacing: false });
  ctx.openDialog(DIALOG, {});
}

registerDialog(DIALOG, ctx => dialogFrame({ name: DIALOG, title: 'Connect Product Hunt', body: renderAccountCard(ctx, { context: 'dialog', level: 3, bare: true }) }),
  { size: 'sm', className: 'w-ph-connect-dialog' });

registerAccountProvider({
  id: ACCOUNT_ID, name: 'Product Hunt', icon: 'product-hunt', order: 30, keywords: 'product hunt launches rankings upvotes developer token api',
  description: 'Daily rankings, upvotes and topics for the Product Hunt widget.',
  renderCard: ctx => renderAccountCard(ctx, { context: 'settings', level: 4 }),
});

function focusToken(ctx, context) {
  ctx.nextFrame(() => document.getElementById(tokenField(context))?.focus({ preventScroll: false }));
}

const profile = person => ({ name: person.name, login: person.username, avatarUrl: person.avatarUrl, meta: { userId: person.id } });

async function connect(ctx, { token: raw, context }) {
  draft.busy = 'connect';
  draft.error = '';
  ctx.render();
  try {
    let token;
    try { token = validateToken(raw, { label: 'developer token' }); } catch (error) { throw new ProductHuntError(error.message, { kind: 'input' }); }
    const person = await createProductHuntClient({ token }).viewer();
    resetSession();
    await saveAccount(ACCOUNT_ID, { token, method: 'token', scopes: ['public'], ...profile(person) });
    Object.assign(draft, { token: '', error: '', replacing: false });
    session.loaded = false;
    await ensureAccount();
    ctx.toast(person.name ? `Connected to Product Hunt as ${person.name}` : 'Connected to Product Hunt', { tone: 'success' });
    if (context === 'dialog') ctx.closeDialog(DIALOG);
    refreshMounted({ force: false });
  } catch (error) {
    draft.error = error?.kind === 'auth' ? 'Product Hunt did not accept that token. Copy the Developer token (not the API key or secret) and try again.'
      : errorInfo(error, 'Unable to connect Product Hunt. Try again.').message;
    focusToken(ctx, context);
  } finally {
    draft.busy = '';
    rerender();
  }
}

registerActions({
  'w.product-hunt.token-input': ({ el }) => { draft.token = el.value; if (draft.error) draft.error = ''; },
  'w.product-hunt.connect': ({ ctx, el, data }) => connect(ctx, { token: String(new FormData(el).get('token') ?? draft.token ?? ''), context: data.context || 'settings' }),
  'w.product-hunt.open-connect': ({ ctx }) => openConnect(ctx),
  'w.product-hunt.replace-token': ({ ctx, data }) => {
    draft.replacing = !draft.replacing;
    draft.error = '';
    draft.token = '';
    ctx.render();
    if (draft.replacing) focusToken(ctx, data.context || 'settings');
  },
  'w.product-hunt.check': async ({ ctx }) => {
    draft.busy = 'check';
    ctx.render();
    try {
      const person = await (await client()).viewer();
      await saveAccount(ACCOUNT_ID, profile(person));
      session.authFailed = false;
      session.loaded = false;
      await ensureAccount();
      ctx.toast(person.name ? `Product Hunt is connected as ${person.name}.` : 'Product Hunt is connected.', { tone: 'success' });
      refreshMounted();
    } catch (error) {
      if (error?.kind === 'auth') session.authFailed = true;
      ctx.toast(errorInfo(error, 'Unable to reach Product Hunt. Try again.').message, { tone: 'danger' });
    } finally { draft.busy = ''; rerender(); }
  },
  'w.product-hunt.disconnect': async ({ ctx }) => {
    const ok = await ctx.confirm({ title: 'Disconnect Product Hunt?', confirmLabel: 'Disconnect', tone: 'danger',
      body: 'Still removes your developer token and cached rankings from this device. Your Product Hunt widgets keep showing the latest launches from the public feed. To stop the token working everywhere, delete the application on Product Hunt.' });
    if (!ok) return;
    await removeAccount(ACCOUNT_ID);
    resetSession();
    Object.assign(draft, { token: '', error: '', busy: '', replacing: false });
    session.loaded = false;
    await ensureAccount();
    ctx.toast('Product Hunt is disconnected.');
  },
});
