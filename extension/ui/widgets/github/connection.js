// GitHub sign-in for the dashboard widget and Settings > Connected accounts: personal access token, OAuth device flow with
// the user's own OAuth app, or the token the GitHub CLI already has on this computer (through the paired local bridge).
// The token lives only in lib/accounts.js; this module keeps display info (login, avatar, scopes) and the sign-in UI state.
import { html, cx, safeSrc } from '../../html.js';
import { icon } from '../../icons.js';
import { registerActions } from '../../runtime.js';
import { registerDialog } from '../../overlay.js';
import { button, input, field, badge, spinner, segmented, dialogFrame, relativeDate } from '../../components.js';
import { prefs } from '../../prefs.js';
import { getAccount, getAccountInfo, saveAccount, removeAccount, onAccountsChanged, registerAccountProvider, redactToken, validateToken as checkTokenText } from '../../../lib/accounts.js';
import { hasOrigins, requestOrigins, onPermissionsChanged } from '../../../lib/permissions.js';
import { INTEGRATION_STORAGE_KEY } from '../../../lib/integrations.js';
import { deleteCache } from '../../../lib/widget-cache.js';
import {
  createGitHubClient, validateToken, requestDeviceCode, pollDeviceFlow, fetchBridgeToken, missingScopes, validClientId, GitHubError,
  API_ORIGINS, DEVICE_ORIGINS, RECOMMENDED_SCOPES, CLASSIC_TOKEN_URL, FINE_GRAINED_TOKEN_URL, OAUTH_APPS_URL,
} from '../../../lib/github.js';

export const ACCOUNT_ID = 'github';
const METHODS = [
  { value: 'bridge', label: 'GitHub CLI', icon: 'terminal' },
  { value: 'oauth', label: 'Sign in', icon: 'log-in' },
  { value: 'token', label: 'Token', icon: 'key-round' },
];
export const METHOD_LABELS = { token: 'Personal access token', oauth: 'Signed in with GitHub', bridge: 'GitHub CLI on this computer' };
const SOURCE_LABELS = { gh: 'GitHub CLI on this computer', GITHUB_TOKEN: 'GITHUB_TOKEN on this computer', GH_TOKEN: 'GH_TOKEN on this computer' };
const KIND_LABELS = { classic: 'Classic token', 'fine-grained': 'Fine-grained token', oauth: 'OAuth token', app: 'GitHub App token', installation: 'Installation token' };

// ------------------------------------------------------------------ state

let appCtx = null;
const auth = { loaded: false, info: null, access: null, bridge: null };
const ui = { method: null, busy: '', error: '', notice: '', token: '', clientId: prefs.get('githubClientId', '') || '' };
let device = null; // { userCode, verificationUri, expiresAt, controller }
const listeners = new Set();

const rerender = () => appCtx?.render();
/** Called when the account or host access changes (the data layer drops its client and refreshes). */
export const onAuthChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const notify = () => { for (const fn of listeners) { try { fn(auth.info); } catch (error) { console.error(error); } } };

async function loadAuth() {
  try { auth.info = await getAccountInfo(ACCOUNT_ID); } catch { auth.info = null; }
  auth.access = auth.info?.connected ? await hasOrigins(API_ORIGINS) : null;
  auth.loaded = true;
  rerender();
}

// Read the account at import so needsSetup() and Settings know the state before any widget renders.
loadAuth();

/** Binds the app ctx once (render functions call it) and starts watching accounts and permissions. */
export function bindConnection(ctx) {
  if (appCtx) return;
  appCtx = ctx;
  if (auth.loaded) rerender(); else loadAuth();
  onAccountsChanged(async () => {
    const before = auth.info?.updatedAt;
    await loadAuth();
    if (auth.info?.updatedAt !== before) notify();
  });
  onPermissionsChanged(async () => {
    const before = auth.access;
    auth.access = auth.info?.connected ? await hasOrigins(API_ORIGINS) : null;
    if (before !== auth.access) { rerender(); notify(); }
  });
}

/** { loaded, info (account without its token, or null), access (host access granted; null when not connected) }. */
export const authState = () => auth;

// ------------------------------------------------------------------ the client

let client = null;
/** A client bound to the stored token; bridge tokens are re-read once when GitHub answers 401. */
export function getClient() {
  if (client) return client;
  client = createGitHubClient({
    getToken: async () => (await getAccount(ACCOUNT_ID))?.token || '',
    refreshToken: async () => {
      const account = await getAccount(ACCOUNT_ID);
      if (account?.method !== 'bridge') return null;
      const fresh = await fetchBridgeToken(path => bridgeRequest(path));
      if (fresh.token !== account.token) await saveAccount(ACCOUNT_ID, { token: fresh.token, meta: { ...(account.meta || {}), source: fresh.source } });
      return fresh.token;
    },
  });
  return client;
}
onAuthChange(() => { client = null; });

// ------------------------------------------------------------------ local bridge

/** Reads the paired bridge settings (URL and pairing token) the integrations module keeps. */
async function bridgeSettings() {
  const local = globalThis.chrome?.storage?.local;
  if (local) return (await local.get(INTEGRATION_STORAGE_KEY))?.[INTEGRATION_STORAGE_KEY] || {};
  try { return JSON.parse(globalThis.localStorage?.getItem(INTEGRATION_STORAGE_KEY) || '{}') || {}; } catch { return {}; }
}

const BRIDGE_DOWN = 'The local bridge is not running. Start it with npm run bridge in the Still folder, then try again.';
/**
 * GET a bridge route. Prefers integrations.requestBridge; builds that only allow /ai and /connections routes are reached
 * directly with the same pairing token and loopback rules.
 */
async function bridgeRequest(path) {
  const settings = await bridgeSettings();
  if (!settings.bridgeToken) throw new GitHubError('Pair the local bridge first. It is in Settings under AI models.', { kind: 'auth' });
  const integrations = appCtx?.integrations;
  if (integrations?.requestBridge) {
    try { return await integrations.requestBridge(path, { signal: AbortSignal.timeout(15000) }); }
    catch (error) {
      // A failed or timed-out fetch means nothing answered at the bridge address (requestBridge passes those through raw).
      if (error instanceof TypeError || error?.name === 'TimeoutError') throw new GitHubError(BRIDGE_DOWN, { kind: 'network' });
      if (!/Unsupported bridge route/i.test(error?.message || '')) throw error;
    }
  }
  let url;
  try { url = new URL(settings.bridgeUrl || 'http://127.0.0.1:43123'); } catch { throw new GitHubError('The paired bridge address is not valid. Pair the bridge again.', { kind: 'invalid' }); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new GitHubError('The bridge must run on this computer (a loopback address).', { kind: 'invalid' });
  let response;
  try {
    response = await fetch(`${url.origin}${path}`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${settings.bridgeToken}` } });
  } catch { throw new GitHubError(BRIDGE_DOWN, { kind: 'network' }); }
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    if (response.status === 404 && !data?.error) throw new GitHubError('This bridge is older than the GitHub widget. Restart it from the latest Still folder.', { kind: 'not_found' });
    throw new GitHubError(typeof data?.error === 'string' ? data.error : `The bridge returned HTTP ${response.status}.`, { kind: response.status === 401 ? 'auth' : 'http' });
  }
  return data;
}

async function refreshBridgeStatus() {
  try {
    const settings = await bridgeSettings();
    auth.bridge = { paired: !!settings.bridgeToken, url: settings.bridgeUrl || '' };
  } catch { auth.bridge = { paired: false }; }
  rerender();
}

// ------------------------------------------------------------------ connect / disconnect

async function storeAccount(ctx, token, method, extra = {}) {
  const who = await validateToken(token);
  await saveAccount(ACCOUNT_ID, {
    token, method, login: who.login, name: who.name, avatarUrl: who.avatarUrl, scopes: who.scopes,
    meta: { kind: who.kind, checkedAt: new Date().toISOString(), ...extra },
  });
  ui.token = '';
  ui.error = '';
  ui.notice = '';
  ui.method = null;
  await loadAuth();
  notify();
  ctx.closeDialog?.('github.connect');
  ctx.toast(`Connected to GitHub as @${who.login}.`, { tone: 'success' });
  const missing = missingScopes(who.scopes);
  if (missing.length) ctx.toast(`Some features need more access: add ${missing.join(', ')} to the token.`, { tone: 'warning', duration: 9000 });
}

/** Runs a sign-in step with a busy flag and a readable, token-free error under the card. */
async function attempt(ctx, busy, fn, secret = '') {
  if (ui.busy) return;
  ui.busy = busy;
  ui.error = '';
  rerender();
  try { await fn(); }
  catch (error) {
    if (error?.kind !== 'cancelled') ui.error = redactToken(error?.message || 'GitHub did not answer. Try again.', secret);
  } finally { ui.busy = ''; rerender(); }
}

function cancelDevice() {
  device?.controller?.abort();
  device = null;
}

export async function disconnect(ctx) {
  const ok = await ctx.confirm({ title: 'Disconnect GitHub?', body: 'Still forgets the saved credential on this device. Your GitHub widgets keep their settings and show a Connect button.', confirmLabel: 'Disconnect', tone: 'danger' });
  if (!ok) return;
  cancelDevice();
  await removeAccount(ACCOUNT_ID);
  deleteCache('github'); // cached pull request lists can name private repositories
  await loadAuth();
  notify();
  ctx.toast('GitHub disconnected.');
}

export function openConnect(ctx, method) {
  bindConnection(ctx);
  if (method) ui.method = method;
  ui.error = '';
  refreshBridgeStatus();
  ctx.openDialog('github.connect', { size: 'md' });
}

// ------------------------------------------------------------------ account card

const avatar = (url, size = 40, label = '') => safeSrc(url)
  ? html`<img class="w-github-avatar" src="${safeSrc(url)}" alt="${label}" width="${size}" height="${size}" style="--size:${size}px" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
  : html`<span class="w-github-avatar is-empty" style="--size:${size}px" aria-hidden="true">${icon('github', { size: Math.round(size * 0.55) })}</span>`;
export { avatar as githubAvatar };

const external = (href, label) => html`<a class="link-inline" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;

function connectedCard(ctx, info, scope) {
  const meta = info.meta || {};
  const methodLabel = info.method === 'bridge' ? SOURCE_LABELS[meta.source] || METHOD_LABELS.bridge : METHOD_LABELS[info.method] || 'Connected';
  const missing = missingScopes(info.scopes);
  const fineGrained = !Array.isArray(info.scopes);
  return html`<div class="w-github-account is-connected" data-scope="${scope}">
    <div class="w-github-account-who">
      ${avatar(info.avatarUrl, 40)}
      <div class="w-github-account-text">
        <p class="w-github-account-name">${info.name || info.login} ${info.name ? html`<span class="w-github-account-login">@${info.login}</span>` : ''}</p>
        <p class="w-github-account-meta">${methodLabel}${meta.kind && KIND_LABELS[meta.kind] && info.method === 'token' ? ` · ${KIND_LABELS[meta.kind]}` : ''}${meta.checkedAt ? ` · Checked ${relativeDate(meta.checkedAt).toLowerCase()}` : ''}</p>
      </div>
      ${badge({ label: auth.access === false ? 'Needs access' : 'Connected', tone: auth.access === false ? 'warning' : 'success', icon: auth.access === false ? 'lock' : 'check' })}
    </div>
    ${fineGrained
      ? html`<p class="w-github-account-note">${icon('info', { size: 14 })}<span>Fine-grained and app tokens get repository access from their settings on GitHub. If an organization is missing, add it under Other owners in the widget’s settings. Notifications need a classic token or GitHub sign-in.</span></p>`
      : html`<ul class="w-github-scopes" aria-label="Token scopes">${RECOMMENDED_SCOPES.map(scopeName => {
        const has = !missing.includes(scopeName);
        return html`<li class="${cx('w-github-scope', !has && 'is-missing')}">${icon(has ? 'check' : 'circle-alert', { size: 12 })}<span>${scopeName}</span><span class="sr-only">${has ? 'granted' : 'missing'}</span></li>`;
      })}</ul>
      ${missing.length ? html`<p class="w-github-account-note is-warning">${icon('triangle-alert', { size: 14 })}<span>Add ${missing.join(', ')} to see ${missing.includes('notifications') ? 'your inbox' : 'everything'}${missing.includes('workflow') ? ' and re-run workflows' : ''}${missing.includes('read:org') ? ' and private organizations' : ''}.</span></p>` : ''}`}
    ${ui.error && !ui.method ? html`<p class="w-github-account-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${ui.error}</span></p>` : ''}
    <div class="w-github-account-actions">
      ${auth.access === false ? button({ label: 'Allow access to api.github.com', icon: 'lock-open', size: 'sm', variant: 'primary', action: 'w.github.allow' }) : ''}
      ${button({ label: 'Check connection', icon: 'refresh-cw', size: 'sm', action: 'w.github.check', loading: ui.busy === 'check' })}
      ${button({ label: 'Change sign-in', size: 'sm', variant: 'ghost', action: 'w.github.change' })}
      ${button({ label: 'Disconnect', size: 'sm', variant: 'ghost', action: 'w.github.disconnect', className: 'w-github-danger-text' })}
    </div>
  </div>`;
}

function methodPanel(ctx, method, scope) {
  const id = name => `gh-${scope}-${name}`;
  if (method === 'token') {
    return html`<form class="w-github-method" data-submit="w.github.connect-token" novalidate>
      <p class="w-github-method-lead">Paste a personal access token. A classic token with the ${RECOMMENDED_SCOPES.map((scopeName, i) => html`${i ? (i === RECOMMENDED_SCOPES.length - 1 ? ' and ' : ', ') : ''}<code>${scopeName}</code>`)} scopes unlocks every feature. Fine-grained tokens work for pull requests in the repositories you choose.</p>
      <p class="w-github-method-links">${external(CLASSIC_TOKEN_URL, html`${icon('external-link', { size: 12 })}<span>Create a classic token</span>`)}${external(FINE_GRAINED_TOKEN_URL, html`${icon('external-link', { size: 12 })}<span>Create a fine-grained token</span>`)}</p>
      ${field({ label: 'Personal access token', id: id('token'), error: ui.error || '', hint: 'Still checks the token with GitHub before saving it.',
        control: input({ id: id('token'), name: 'token', type: 'password', value: ui.token, action: 'w.github.token-input', placeholder: 'ghp_… or github_pat_…', invalid: !!ui.error, describedBy: ui.error ? `${id('token')}-error` : `${id('token')}-hint` }) })}
      <div class="w-github-method-actions">${button({ label: 'Connect GitHub', type: 'submit', variant: 'primary', size: 'sm', loading: ui.busy === 'token' })}</div>
    </form>`;
  }
  if (method === 'oauth') {
    if (device) {
      return html`<div class="w-github-method w-github-device" role="group" aria-label="Device sign-in">
        <p class="w-github-method-lead">Enter this code on GitHub to approve Still. It expires at ${new Date(device.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.</p>
        <div class="w-github-device-code"><output class="w-github-code" aria-label="Your sign-in code">${device.userCode}</output>
          ${button({ label: 'Copy code', icon: 'copy', size: 'sm', action: 'app.copy', data: { text: device.userCode, done: 'Code copied' } })}</div>
        <div class="w-github-method-actions">
          ${button({ label: 'Copy code and open GitHub', icon: 'external-link', variant: 'primary', size: 'sm', action: 'w.github.device-open' })}
          ${button({ label: 'Cancel', size: 'sm', variant: 'ghost', action: 'w.github.device-cancel' })}
        </div>
        <p class="w-github-waiting" role="status">${spinner({ size: 14 })}<span>Waiting for you to approve on GitHub…</span></p>
      </div>`;
    }
    return html`<form class="w-github-method" data-submit="w.github.device-start" novalidate>
      <p class="w-github-method-lead">Sign in with an OAuth app you own. Create one in ${external(OAUTH_APPS_URL, 'GitHub developer settings')} (any homepage and callback URL), turn on <strong>Enable Device Flow</strong>, then paste its client ID.</p>
      ${field({ label: 'OAuth app client ID', id: id('client'), error: ui.error || '', hint: 'The client ID is not a secret. Still asks for repo, read:org, workflow and notifications.',
        control: input({ id: id('client'), name: 'clientId', value: ui.clientId, action: 'w.github.client-input', placeholder: 'Ov23li…', invalid: !!ui.error, describedBy: ui.error ? `${id('client')}-error` : `${id('client')}-hint` }) })}
      <div class="w-github-method-actions">${button({ label: 'Sign in with GitHub', icon: 'log-in', type: 'submit', variant: 'primary', size: 'sm', loading: ui.busy === 'device' })}</div>
    </form>`;
  }
  const paired = auth.bridge?.paired;
  return html`<div class="w-github-method">
    <p class="w-github-method-lead">Use the GitHub sign-in this computer already has. The local bridge asks <code>gh auth token</code>, or reads <code>GITHUB_TOKEN</code> when the CLI is not signed in. When the token changes, Still reads it again.</p>
    ${auth.bridge && !paired ? html`<p class="w-github-account-note">${icon('plug-zap', { size: 14 })}<span>The local bridge is not paired yet. Start it with <code>npm run bridge</code> in the Still folder and pair it in Settings.</span></p>` : ''}
    ${ui.error ? html`<p class="w-github-account-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${ui.error}</span></p>` : ''}
    <div class="w-github-method-actions">
      ${auth.bridge && !paired
        ? button({ label: 'Pair the local bridge', iconRight: 'arrow-right', variant: 'primary', size: 'sm', action: 'w.github.pair-bridge' })
        : button({ label: 'Use the GitHub CLI token', icon: 'terminal', variant: 'primary', size: 'sm', action: 'w.github.connect-bridge', loading: ui.busy === 'bridge' })}
    </div>
  </div>`;
}

/** The account card for Settings > Connected accounts and the connect dialog. scope keeps element ids unique per place. */
export function renderAccountCard(ctx, { scope = 'settings' } = {}) {
  bindConnection(ctx);
  if (!auth.loaded) return html`<div class="w-github-account is-loading" aria-busy="true">${spinner({ size: 16, label: 'Checking GitHub' })}</div>`;
  if (auth.bridge === null) refreshBridgeStatus();
  if (auth.info?.connected && !ui.method) return connectedCard(ctx, auth.info, scope);
  const method = ui.method || auth.info?.method || (auth.bridge?.paired ? 'bridge' : 'token');
  return html`<div class="w-github-account" data-scope="${scope}">
    ${segmented({ name: `gh-method-${scope}`, value: method, options: METHODS, action: 'w.github.method', size: 'sm', ariaLabel: 'How to connect GitHub', className: 'w-github-methods' })}
    ${methodPanel(ctx, method, scope)}
    ${auth.info?.connected ? html`<div class="w-github-method-actions is-end">${button({ label: 'Keep current sign-in', size: 'sm', variant: 'ghost', action: 'w.github.keep' })}</div>` : ''}
  </div>`;
}

registerAccountProvider({
  id: ACCOUNT_ID, name: 'GitHub', icon: 'github', order: 10,
  description: 'Pull requests, reviews, CI and Copilot work for the GitHub widget.',
  renderCard: ctx => renderAccountCard(ctx, { scope: 'settings' }),
});

registerDialog('github.connect', ctx => dialogFrame({
  name: 'github.connect', title: auth.info?.connected ? 'GitHub account' : 'Connect GitHub',
  subtitle: 'Your credential stays on this device. It is not included in backups, exports or bridge sync.',
  body: renderAccountCard(ctx, { scope: 'dialog' }),
}), { size: 'md', beforeClose: () => { if (ui.method && auth.info?.connected) ui.method = null; return true; } });

// ------------------------------------------------------------------ actions

registerActions({
  'w.github.method': ({ data }) => { ui.method = data.value; ui.error = ''; if (data.value !== 'oauth') cancelDevice(); rerender(); },
  'w.github.change': () => { ui.method = auth.info?.method || 'token'; ui.error = ''; refreshBridgeStatus(); rerender(); },
  'w.github.keep': () => { ui.method = null; ui.error = ''; cancelDevice(); rerender(); },
  'w.github.token-input': ({ el }) => { ui.token = el.value; },
  'w.github.client-input': ({ el }) => { ui.clientId = el.value.trim(); },
  'w.github.open-connect': ({ ctx, data }) => openConnect(ctx, data.method || null),
  'w.github.pair-bridge': ({ ctx }) => { ctx.closeDialog?.('github.connect'); ctx.navigate('settings:ai'); },
  'w.github.disconnect': ({ ctx }) => disconnect(ctx),
  'w.github.allow': ({ ctx }) => {
    const granted = requestOrigins(API_ORIGINS);
    return granted.then(async ok => {
      auth.access = ok ? true : await hasOrigins(API_ORIGINS);
      if (!ok) ctx.toast('Chrome did not allow access to api.github.com. Try again and choose Allow.', { tone: 'warning' });
      rerender();
      notify();
    });
  },
  'w.github.connect-token': ({ ctx, el }) => {
    const granted = requestOrigins(API_ORIGINS);
    const value = new FormData(el).get('token') ?? ui.token;
    let token = '';
    try { token = checkTokenText(String(value || ''), { label: 'GitHub token' }); }
    catch (error) { ui.error = error.message; rerender(); return; }
    return attempt(ctx, 'token', async () => {
      if (!(await granted)) throw new GitHubError('Chrome did not allow Still to reach api.github.com. Try again and choose Allow.', { kind: 'forbidden' });
      await storeAccount(ctx, token, 'token');
    }, token);
  },
  'w.github.connect-bridge': ({ ctx }) => {
    const granted = requestOrigins(API_ORIGINS);
    return attempt(ctx, 'bridge', async () => {
      if (!(await granted)) throw new GitHubError('Chrome did not allow Still to reach api.github.com. Try again and choose Allow.', { kind: 'forbidden' });
      const { token, source } = await fetchBridgeToken(path => bridgeRequest(path));
      await storeAccount(ctx, token, 'bridge', { source }).catch(error => {
        if (error?.kind !== 'auth') throw error;
        throw new GitHubError(source === 'gh' ? 'GitHub did not accept the GitHub CLI’s token. Run gh auth login on this computer, then try again.'
          : `GitHub did not accept the token in ${source}. Update it, restart the bridge, then try again.`, { kind: 'auth' });
      });
    });
  },
  'w.github.device-start': ({ ctx, el }) => {
    const granted = requestOrigins(DEVICE_ORIGINS);
    const clientId = String(new FormData(el).get('clientId') ?? ui.clientId).trim();
    ui.clientId = clientId;
    if (!validClientId(clientId)) { ui.error = 'Paste the client ID from your OAuth app’s settings on GitHub.'; rerender(); return; }
    prefs.set('githubClientId', clientId);
    return attempt(ctx, 'device', async () => {
      if (!(await granted)) throw new GitHubError('Chrome did not allow Still to reach github.com. Try again and choose Allow.', { kind: 'forbidden' });
      const code = await requestDeviceCode({ clientId });
      const controller = new AbortController();
      device = { ...code, controller };
      ui.busy = '';
      rerender();
      try {
        const { token } = await pollDeviceFlow({ clientId, deviceCode: code.deviceCode, interval: code.interval, expiresAt: code.expiresAt, signal: controller.signal });
        if (device?.controller !== controller) return;
        device = null;
        await storeAccount(ctx, token, 'oauth', { clientId });
      } catch (error) {
        if (device?.controller === controller) device = null;
        throw error;
      }
    });
  },
  'w.github.device-open': async ({ ctx }) => {
    if (!device) return;
    try { await navigator.clipboard.writeText(device.userCode); } catch { /* the code stays visible */ }
    const url = device.verificationUri;
    if (globalThis.chrome?.tabs?.create) await chrome.tabs.create({ url }); else window.open(url, '_blank', 'noopener');
    ctx.toast('Code copied. Paste it on GitHub to approve.');
  },
  'w.github.device-cancel': () => { cancelDevice(); ui.error = ''; rerender(); },
  'w.github.check': ({ ctx }) => attempt(ctx, 'check', async () => {
    const account = await getAccount(ACCOUNT_ID);
    if (!account?.token) throw new GitHubError('Connect GitHub first.', { kind: 'auth' });
    let token = account.token;
    let extra = {};
    if (account.method === 'bridge') ({ token, source: extra.source } = await fetchBridgeToken(path => bridgeRequest(path)));
    const who = await validateToken(token).catch(error => { throw new GitHubError(redactToken(error.message, token), error); });
    await saveAccount(ACCOUNT_ID, { ...(token !== account.token ? { token } : {}), login: who.login, name: who.name, avatarUrl: who.avatarUrl, scopes: who.scopes,
      meta: { ...(account.meta || {}), ...extra, kind: who.kind, checkedAt: new Date().toISOString() } });
    await loadAuth();
    notify();
    ctx.toast(`GitHub is connected as @${who.login}.`, { tone: 'success' });
  }),
});
