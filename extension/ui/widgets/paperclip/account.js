// Paperclip account card: shown in Settings > Connected accounts, in the "Connect Paperclip" dialog and behind the
// widget's setup state. The address (and an optional key) is checked against Paperclip before it is saved to
// lib/accounts.js; when the key can see several companies, the person picks one. In local trusted mode no key is needed.
import { html, cx } from '../../html.js';
import { icon, registerIcons } from '../../icons.js';
import { button, input, select, field, badge, shortDate, dialogFrame } from '../../components.js';
import { registerActions } from '../../runtime.js';
import { registerDialog } from '../../overlay.js';
import { saveAccount, removeAccount, registerAccountProvider, validateToken } from '../../../lib/accounts.js';
import { requestOrigins } from '../../../lib/permissions.js';
import {
  PAPERCLIP_ACCOUNT_ID, DEFAULT_PAPERCLIP_URL, PAPERCLIP_DOCS, LOCAL_TOKEN, PaperclipError, normalizePaperclipUrl, createPaperclipClient, checkPaperclip,
} from '../../../lib/paperclip.js';
import { session, bindCtx, ensureAccount, connected, company, baseUrl, originFor, rerender, resetSession, errorInfo, checkAccess, refreshMounted, ensureLists, client } from './session.js';

// Lucide "paperclip" (kept here too in case the shared set drops it; existing names are never replaced).
registerIcons({ paperclip: '<path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/>' });

const DIALOG = 'w.paperclip.connect';
const draft = { url: '', key: '', error: '', busy: '', editing: false, choose: null, companyId: '' };

const fieldId = (context, name) => `paperclip-${name}-${context}`;

/** The card. context: 'settings' | 'dialog' keeps element ids unique when two copies are on screen. */
export function renderAccountCard(ctx, { context = 'settings' } = {}) {
  bindCtx(ctx);
  ensureAccount();
  const isConnected = connected();
  const info = session.info;
  const local = info?.method === 'local';
  const attention = isConnected && (session.authFailed || session.access === false);
  const status = !session.loaded ? null : attention ? { label: 'Needs attention', tone: 'warning', icon: 'triangle-alert' }
    : isConnected ? { label: 'Connected', tone: 'success', icon: 'circle-check' } : { label: 'Not connected', tone: 'neutral' };
  const showForm = !isConnected || draft.editing || session.authFailed;
  const host = baseUrl() ? baseUrl().replace(/^https?:\/\//, '') : '';
  return html`<div class="${cx('w-paperclip-account', context === 'dialog' && 'is-bare')}" data-context="${context}">
    ${context === 'settings' && status ? html`<p class="w-paperclip-account-status">${badge(status)}</p>` : ''}
    ${isConnected ? html`<div class="w-paperclip-account-who">
      <p class="w-paperclip-account-person">${company().name || 'Paperclip company'}${company().prefix ? html` <span class="w-paperclip-mono">${company().prefix}</span>` : ''}</p>
      <p class="w-paperclip-account-meta">${[host, local ? 'Local trusted mode, no key' : info?.meta?.agentId ? 'Agent key' : 'Board key'].filter(Boolean).join(' · ')}${info?.updatedAt ? ` · Checked ${shortDate(info.updatedAt)}` : ''}</p>
    </div>` : ''}
    ${isConnected && session.authFailed ? html`<p class="w-paperclip-account-alert" role="alert">${icon('triangle-alert', { size: 14 })}<span>Paperclip no longer accepts the saved key. Paste a new one, or leave it empty if Paperclip runs in local trusted mode.</span></p>` : ''}
    ${isConnected && !session.authFailed && session.access === false ? html`<div class="w-paperclip-account-alert" role="status">${icon('lock', { size: 14 })}<span>Chrome is not letting Still reach ${host}, so Paperclip widgets cannot refresh.</span>
      ${button({ label: `Allow access to ${host}`, size: 'sm', variant: 'secondary', action: 'w.paperclip.allow-access' })}</div>` : ''}
    ${draft.choose ? chooseCompany(context) : showForm ? connectForm(context) : ''}
    ${isConnected && !draft.choose ? html`<div class="w-paperclip-account-actions">
      ${button({ label: 'Check connection', icon: 'refresh-cw', size: 'sm', variant: 'secondary', action: 'w.paperclip.check', loading: draft.busy === 'check' })}
      ${!session.authFailed ? button({ label: draft.editing ? 'Keep current settings' : 'Change address or key', size: 'sm', variant: 'ghost', action: 'w.paperclip.edit', data: { context } }) : ''}
      ${button({ label: 'Disconnect', icon: 'log-out', size: 'sm', variant: 'ghost', action: 'w.paperclip.disconnect' })}
    </div>` : ''}
  </div>`;
}

function connectForm(context) {
  const urlId = fieldId(context, 'url');
  const keyId = fieldId(context, 'key');
  const value = draft.url || baseUrl() || DEFAULT_PAPERCLIP_URL;
  return html`<form class="w-paperclip-account-form" data-submit="w.paperclip.connect" data-context="${context}" novalidate>
    ${field({ label: 'Paperclip address', id: urlId, hint: 'Where Paperclip runs. The default local install uses http://localhost:3100.',
      control: input({ id: urlId, name: 'url', type: 'url', value, action: 'w.paperclip.field', placeholder: DEFAULT_PAPERCLIP_URL, describedBy: `${urlId}-hint`, attrs: { 'data-name': 'url' } }) })}
    ${field({ label: 'API key (optional)', id: keyId, error: draft.error,
      hint: html`Leave this empty when Paperclip runs in local trusted mode on this computer. Otherwise paste a board key (pcp_board_…) or an agent key. <a class="link-inline" href="${PAPERCLIP_DOCS}" target="_blank" rel="noopener noreferrer">Paperclip docs</a>`,
      control: input({ id: keyId, name: 'key', type: 'password', value: draft.key, action: 'w.paperclip.field', placeholder: 'Not needed in local trusted mode', invalid: !!draft.error,
        describedBy: draft.error ? `${keyId}-error` : `${keyId}-hint`, attrs: { 'data-name': 'key', autocomplete: 'off' } }) })}
    <div class="w-paperclip-account-submit">${button({ label: connected() ? 'Save' : 'Connect Paperclip', type: 'submit', size: 'sm', variant: 'primary', loading: draft.busy === 'connect' })}
      <span class="w-paperclip-account-note">${icon('lock', { size: 12 })}Stored only on this device.</span></div>
  </form>`;
}

function chooseCompany(context) {
  const id = fieldId(context, 'company');
  const options = draft.choose.companies.map(c => ({ value: c.id, label: c.prefix ? `${c.name} (${c.prefix})` : c.name || c.id }));
  return html`<form class="w-paperclip-account-form" data-submit="w.paperclip.choose" data-context="${context}" novalidate>
    ${field({ label: 'Company', id, hint: 'This key can see several companies. Choose the one whose tasks Still shows and creates.',
      control: select({ id, name: 'companyId', value: draft.companyId || options[0]?.value, options, describedBy: `${id}-hint` }) })}
    <div class="w-paperclip-account-submit">${button({ label: 'Use this company', type: 'submit', size: 'sm', variant: 'primary', loading: draft.busy === 'connect' })}
      ${button({ label: 'Cancel', size: 'sm', variant: 'ghost', action: 'w.paperclip.choose-cancel' })}</div>
  </form>`;
}

/** Opens the connect dialog (used by the widget's setup state, its menu and the Send dialog). */
export function openConnect(ctx) {
  Object.assign(draft, { error: '', busy: '', editing: false, choose: null });
  ctx.openDialog(DIALOG, {});
}

registerDialog(DIALOG, ctx => dialogFrame({ name: DIALOG, title: 'Connect Paperclip', subtitle: 'Your AI company’s tasks on the dashboard, and saved items sent as tasks.',
  body: renderAccountCard(ctx, { context: 'dialog' }) }), { size: 'sm', className: 'w-paperclip-connect-dialog' });

registerAccountProvider({
  id: PAPERCLIP_ACCOUNT_ID, name: 'Paperclip', icon: 'paperclip', order: 30, keywords: 'paperclip agents tasks issues company board key local trusted',
  description: 'Tasks from your Paperclip company on the dashboard, and Send to Paperclip for saved items. To let Paperclip agents read Still, use Agents & MCP.',
  renderCard: ctx => renderAccountCard(ctx, { context: 'settings' }),
});

async function save(ctx, { base, key, mode, company: chosen, agent, context }) {
  const previous = `${baseUrl()}|${company().id}`;
  await saveAccount(PAPERCLIP_ACCOUNT_ID, {
    token: key || LOCAL_TOKEN, method: key ? 'token' : 'local', name: chosen.name || agent?.name || 'Paperclip', login: base.replace(/^https?:\/\//, ''), scopes: [],
    meta: { baseUrl: base, companyId: chosen.id, companyPrefix: chosen.prefix || '', companyName: chosen.name || '', mode, agentId: agent?.id || '' },
  });
  if (previous !== `${base}|${chosen.id}`) resetSession();
  Object.assign(draft, { url: '', key: '', error: '', editing: false, choose: null, companyId: '' });
  session.authFailed = false;
  session.loaded = false;
  await ensureAccount();
  ctx.toast(`Connected to Paperclip${chosen.name ? ` (${chosen.name})` : ''}`, { tone: 'success' });
  if (context === 'dialog') ctx.closeDialog(DIALOG);
  ensureLists({ force: true });
  refreshMounted();
}

async function connect(ctx, { base, key, context, granted }) {
  draft.busy = 'connect';
  draft.error = '';
  ctx.render();
  try {
    let token = '';
    if (key.trim()) { try { token = validateToken(key, { label: 'Paperclip key' }); } catch (error) { throw new PaperclipError(error.message, { kind: 'invalid' }); } }
    if (!(await granted)) throw new PaperclipError(`Chrome did not allow Still to reach ${base.replace(/^https?:\/\//, '')}. Try again and choose Allow.`, { kind: 'network' });
    const result = await checkPaperclip(createPaperclipClient({ baseUrl: base, token }));
    if (!result.companies.length) throw new PaperclipError('Paperclip has no company yet. Create one in Paperclip, then connect again.', { kind: 'not_found' });
    if (result.companies.length > 1) {
      draft.choose = { base, key: token, mode: result.mode, companies: result.companies, context };
      draft.companyId = result.companies[0].id;
      return;
    }
    await save(ctx, { base, key: token, mode: result.mode, company: result.companies[0], agent: result.agent, context });
  } catch (error) {
    draft.error = errorInfo(error, 'Unable to connect Paperclip. Try again.').message;
    if (error?.kind === 'auth') draft.error = 'Paperclip did not accept that key. Check that you copied all of it, or leave it empty for local trusted mode.';
    ctx.nextFrame(() => document.getElementById(fieldId(context, 'key'))?.focus());
  } finally {
    draft.busy = '';
    rerender();
  }
}

registerActions({
  'w.paperclip.field': ({ el }) => { draft[el.dataset.name] = el.value; if (draft.error) draft.error = ''; },
  // Chrome only shows the host-access prompt inside the user's gesture, so ask before the first await.
  'w.paperclip.connect': ({ ctx, el, data }) => {
    const form = new FormData(el);
    const context = data.context || 'settings';
    let base;
    try { base = normalizePaperclipUrl(form.get('url') ?? draft.url); } catch (error) { draft.error = error.message; ctx.render(); return undefined; }
    const granted = requestOrigins([originFor(base)]);
    return connect(ctx, { base, key: String(form.get('key') ?? draft.key ?? ''), context, granted });
  },
  'w.paperclip.choose': async ({ ctx, el, data }) => {
    const pending = draft.choose;
    if (!pending) return;
    const id = String(new FormData(el).get('companyId') || draft.companyId);
    const chosen = pending.companies.find(c => c.id === id) || pending.companies[0];
    draft.busy = 'connect';
    ctx.render();
    try { await save(ctx, { base: pending.base, key: pending.key, mode: pending.mode, company: chosen, agent: null, context: data.context || pending.context }); }
    catch (error) { draft.error = errorInfo(error, 'Still could not save the Paperclip account. Try again.').message; draft.choose = null; }
    finally { draft.busy = ''; rerender(); }
  },
  'w.paperclip.choose-cancel': ({ ctx }) => { Object.assign(draft, { choose: null, key: '', companyId: '' }); ctx.render(); },
  'w.paperclip.allow-access': ({ ctx }) => requestOrigins([originFor(baseUrl())]).then(async ok => {
    await checkAccess();
    if (!ok) ctx.toast('Chrome did not allow access to Paperclip. Choose Allow to let your Paperclip widgets refresh.', { tone: 'warning' });
    else refreshMounted();
    rerender();
  }),
  'w.paperclip.edit': ({ ctx }) => {
    draft.editing = !draft.editing;
    Object.assign(draft, { error: '', key: '', url: '' });
    ctx.render();
  },
  'w.paperclip.check': async ({ ctx }) => {
    draft.busy = 'check';
    ctx.render();
    try {
      const api = await client();
      const result = await checkPaperclip(api);
      const still = result.companies.find(c => c.id === company().id);
      if (!still) throw new PaperclipError('The saved company is no longer visible to this key. Connect again to choose one.', { kind: 'not_found' });
      await saveAccount(PAPERCLIP_ACCOUNT_ID, { meta: { ...(session.info?.meta || {}), companyName: still.name || company().name, companyPrefix: still.prefix || company().prefix, mode: result.mode } });
      session.authFailed = false;
      session.loaded = false;
      await ensureAccount();
      ctx.toast('Paperclip is connected.', { tone: 'success' });
      refreshMounted();
    } catch (error) {
      if (error?.kind === 'auth') session.authFailed = true;
      ctx.toast(errorInfo(error, 'Unable to reach Paperclip. Try again.').message, { tone: 'danger' });
    } finally { draft.busy = ''; rerender(); }
  },
  'w.paperclip.disconnect': async ({ ctx }) => {
    const ok = await ctx.confirm({ title: 'Disconnect Paperclip?', confirmLabel: 'Disconnect', tone: 'danger',
      body: 'Still forgets the Paperclip address and key, and removes cached tasks from this device. Paperclip widgets stay on the dashboard and ask you to connect again. Nothing changes in Paperclip.' });
    if (!ok) return;
    await removeAccount(PAPERCLIP_ACCOUNT_ID);
    resetSession();
    Object.assign(draft, { url: '', key: '', error: '', busy: '', editing: false, choose: null });
    session.loaded = false;
    await ensureAccount();
    ctx.toast('Paperclip is disconnected.');
  },
});
