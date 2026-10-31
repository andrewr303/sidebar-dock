// Linear account card: shown in Settings > Connected accounts, in the "Connect Linear" dialog and behind the widget's
// setup state. A personal API key is checked against Linear's viewer query before it is saved to lib/accounts.js.
import { html, cx } from '../../html.js';
import { icon } from '../../icons.js';
import { button, input, field, badge, shortDate, dialogFrame } from '../../components.js';
import { registerActions } from '../../runtime.js';
import { registerDialog } from '../../overlay.js';
import { saveAccount, removeAccount, registerAccountProvider, validateToken } from '../../../lib/accounts.js';
import { requestOrigins } from '../../../lib/permissions.js';
import { ACCOUNT_ID, LINEAR_ORIGIN, LINEAR_KEYS_URL, LinearError, createLinearClient } from '../../../lib/linear.js';
import { session, bindCtx, ensureAccount, connected, viewer, rerender, resetSession, errorInfo, client, ensureTeams, refreshMounted, checkAccess } from './session.js';
import { personAvatar } from './glyphs.js';

const DIALOG = 'w.linear.connect';
const draft = { key: '', error: '', busy: '', replacing: false };

const keyField = context => `linear-key-${context}`;

/**
 * The card. context: 'settings' | 'dialog' | 'widget' keeps element ids unique when two copies are on screen;
 * level is the heading level for the card title; bare drops the card chrome (inside a dialog).
 */
export function renderAccountCard(ctx, { context = 'settings', level = 4, bare = false } = {}) {
  bindCtx(ctx);
  ensureAccount();
  const who = viewer();
  const isConnected = connected();
  const attention = isConnected && (session.authFailed || session.access === false);
  const status = !session.loaded ? null : attention ? { label: 'Needs attention', tone: 'warning', icon: 'triangle-alert' }
    : isConnected ? { label: 'Connected', tone: 'success', icon: 'circle-check' } : { label: 'Not connected', tone: 'neutral' };
  const showForm = !isConnected || draft.replacing || session.authFailed;
  const titleId = `linear-account-title-${context}`;
  const heading = html`<span class="w-linear-account-name">Linear</span>${status ? badge(status) : ''}`;
  return html`<section class="${cx('w-linear-account', bare && 'is-bare')}" aria-labelledby="${titleId}" data-context="${context}">
    <header class="w-linear-account-head">
      <span class="w-linear-account-mark" aria-hidden="true">${icon('linear', { size: 18 })}</span>
      <div class="w-linear-account-heading">
        ${level === 3 ? html`<h3 class="w-linear-account-title" id="${titleId}">${heading}</h3>` : level === 2 ? html`<h2 class="w-linear-account-title" id="${titleId}">${heading}</h2>`
          : html`<h4 class="w-linear-account-title" id="${titleId}">${heading}</h4>`}
        <p class="w-linear-account-desc">Shows your issues, the current cycle and your inbox on the dashboard. Change status or priority and create issues without leaving Still.</p>
      </div>
    </header>
    ${isConnected && who ? html`<div class="w-linear-account-who">
      ${personAvatar(who, { size: 36 })}
      <div class="w-linear-account-who-text">
        <p class="w-linear-account-person">${who.fullName || who.name}</p>
        <p class="w-linear-account-meta">${[who.email, who.organization?.name && `${who.organization.name} workspace`].filter(Boolean).join(' · ')}${session.info?.updatedAt ? html`<span class="w-linear-account-checked"> · Checked ${shortDate(session.info.updatedAt)}</span>` : ''}</p>
      </div>
    </div>` : ''}
    ${isConnected && session.authFailed ? html`<p class="w-linear-account-alert" role="alert">${icon('triangle-alert', { size: 14 })}<span>Linear no longer accepts the saved key. Paste a new personal API key to reconnect.</span></p>` : ''}
    ${isConnected && !session.authFailed && session.access === false ? html`<div class="w-linear-account-alert" role="status">${icon('lock', { size: 14 })}<span>Chrome is not letting Still reach api.linear.app, so your widgets cannot refresh.</span>
      ${button({ label: 'Allow access to api.linear.app', size: 'sm', variant: 'secondary', action: 'w.linear.allow-access' })}</div>` : ''}
    ${showForm ? keyForm(context) : ''}
    ${isConnected ? html`<div class="w-linear-account-actions">
      ${button({ label: 'Check connection', icon: 'refresh-cw', size: 'sm', variant: 'secondary', action: 'w.linear.check', loading: draft.busy === 'check' })}
      ${!session.authFailed ? button({ label: draft.replacing ? 'Keep current key' : 'Replace key', size: 'sm', variant: 'ghost', action: 'w.linear.replace-key', data: { context } }) : ''}
      ${button({ label: 'Disconnect', icon: 'log-out', size: 'sm', variant: 'ghost', action: 'w.linear.disconnect', className: 'w-linear-account-disconnect' })}
    </div>` : ''}
  </section>`;
}

function keyForm(context) {
  const id = keyField(context);
  const isConnected = connected();
  return html`<form class="w-linear-account-form" data-submit="w.linear.connect" data-context="${context}" novalidate>
    ${field({ label: isConnected ? 'New personal API key' : 'Personal API key', id, error: draft.error,
      hint: html`Create one in Linear under <a class="link-inline" href="${LINEAR_KEYS_URL}" target="_blank" rel="noopener noreferrer">Settings → Security &amp; access</a>. Give it read and write access so you can update and create issues here.`,
      control: input({ id, name: 'key', type: 'password', value: draft.key, action: 'w.linear.key-input', placeholder: 'lin_api_…', invalid: !!draft.error,
        describedBy: draft.error ? `${id}-error` : `${id}-hint`, required: true }) })}
    <div class="w-linear-account-submit">${button({ label: isConnected ? 'Save new key' : 'Connect Linear', type: 'submit', size: 'sm', variant: 'primary', loading: draft.busy === 'connect' })}
      <span class="w-linear-account-note">${icon('lock', { size: 12 })}Stored only on this device.</span></div>
  </form>`;
}

/** Opens the connect dialog (used by the widget's setup state and menus). */
export function openConnect(ctx) {
  Object.assign(draft, { error: '', busy: '', replacing: false });
  ctx.openDialog(DIALOG, {});
}

registerDialog(DIALOG, ctx => dialogFrame({ name: DIALOG, title: 'Connect Linear', body: renderAccountCard(ctx, { context: 'dialog', level: 3, bare: true }) }), { size: 'sm', className: 'w-linear-connect-dialog' });

registerAccountProvider({
  id: ACCOUNT_ID, name: 'Linear', icon: 'linear', order: 20, keywords: 'linear issues cycle api key',
  description: 'Issues, cycles and inbox for the Linear widget.',
  renderCard: ctx => renderAccountCard(ctx, { context: 'settings', level: 4 }),
});

function focusKey(ctx, context) {
  ctx.nextFrame(() => document.getElementById(keyField(context))?.focus({ preventScroll: false }));
}

async function connect(ctx, { key, context, granted }) {
  draft.busy = 'connect';
  draft.error = '';
  ctx.render();
  try {
    let token;
    try { token = validateToken(key, { label: 'Linear API key' }); } catch (error) { throw new LinearError(error.message, { kind: 'input' }); }
    if (!(await granted)) throw new LinearError('Chrome did not allow Still to reach api.linear.app. Try again and choose Allow.', { kind: 'access' });
    const who = await createLinearClient({ token }).viewer();
    const previous = session.info?.meta?.viewerId;
    if (previous && previous !== who.id) resetSession();
    await saveAccount(ACCOUNT_ID, {
      token, method: 'token', login: who.email, name: who.name, avatarUrl: who.avatarUrl, scopes: [],
      meta: { viewerId: who.id, fullName: who.fullName, organization: { name: who.organization.name, urlKey: who.organization.urlKey } },
    });
    Object.assign(draft, { key: '', error: '', replacing: false });
    session.authFailed = false;
    session.access = true;
    session.status.clear();
    session.loaded = false;
    await ensureAccount();
    ctx.toast(`Connected to Linear as ${who.fullName || who.name}`, { tone: 'success' });
    if (context === 'dialog') ctx.closeDialog(DIALOG);
    ensureTeams({ force: true }).then(() => refreshMounted());
  } catch (error) {
    draft.error = errorInfo(error, 'Unable to connect Linear. Try again.').message;
    if (error?.kind === 'auth') draft.error = 'Linear did not accept that key. Check that you copied all of it and that it has not been revoked.';
    focusKey(ctx, context);
  } finally {
    draft.busy = '';
    rerender();
  }
}

registerActions({
  'w.linear.key-input': ({ el }) => { draft.key = el.value; if (draft.error) { draft.error = ''; } },
  // Chrome only shows the host-access prompt inside the user's gesture, so ask before the first await.
  'w.linear.connect': ({ ctx, el, data }) => {
    const granted = requestOrigins([LINEAR_ORIGIN]);
    const key = String(new FormData(el).get('key') ?? draft.key ?? '');
    return connect(ctx, { key, context: data.context || 'settings', granted });
  },
  'w.linear.allow-access': ({ ctx }) => requestOrigins([LINEAR_ORIGIN]).then(async ok => {
    await checkAccess();
    if (!ok) ctx.toast('Chrome did not allow access to api.linear.app. Choose Allow to let your Linear widgets refresh.', { tone: 'warning' });
    else { ensureTeams({ force: true }); refreshMounted(); }
    rerender();
  }),
  'w.linear.replace-key': ({ ctx, data }) => {
    draft.replacing = !draft.replacing;
    draft.error = '';
    draft.key = '';
    ctx.render();
    if (draft.replacing) focusKey(ctx, data.context || 'settings');
  },
  'w.linear.check': async ({ ctx }) => {
    draft.busy = 'check';
    ctx.render();
    try {
      const who = await (await client()).viewer();
      await saveAccount(ACCOUNT_ID, { login: who.email, name: who.name, avatarUrl: who.avatarUrl,
        meta: { viewerId: who.id, fullName: who.fullName, organization: { name: who.organization.name, urlKey: who.organization.urlKey } } });
      session.authFailed = false;
      session.loaded = false;
      await ensureAccount();
      ctx.toast(`Linear is connected as ${who.fullName || who.name}.`, { tone: 'success' });
      refreshMounted();
    } catch (error) {
      if (error?.kind === 'auth') session.authFailed = true;
      ctx.toast(errorInfo(error, 'Unable to reach Linear. Try again.').message, { tone: 'danger' });
    } finally { draft.busy = ''; rerender(); }
  },
  'w.linear.disconnect': async ({ ctx }) => {
    const ok = await ctx.confirm({ title: 'Disconnect Linear?', confirmLabel: 'Disconnect', tone: 'danger',
      body: 'Still removes your API key and cached Linear issues from this device. Your Linear widgets stay on the dashboard and ask you to connect again. To stop the key working everywhere, revoke it in Linear.' });
    if (!ok) return;
    await removeAccount(ACCOUNT_ID);
    resetSession();
    Object.assign(draft, { key: '', error: '', busy: '', replacing: false });
    session.loaded = false;
    await ensureAccount();
    ctx.toast('Linear is disconnected.');
  },
});
