// Settings > Connected accounts: the cards integrations register with lib/accounts.js (GitHub, Linear, Product Hunt…).
// Each provider's renderCard(ctx) owns its markup and actions; this section frames the cards, keeps them in search and
// re-renders when an account changes in any Still view.
import { html, cx } from '../html.js';
import { emptyState, button } from '../components.js';
import { listAccountProviders, onAccountsChanged } from '../../lib/accounts.js';
import { group, searchable, note, callout, isSearching, providerMark } from './parts.js';

let offAccounts = null;
export function attachAccounts(ctx) {
  offAccounts?.();
  offAccounts = onAccountsChanged(() => ctx.render());
}
export function detachAccounts() {
  offAccounts?.();
  offAccounts = null;
}

// A card that brings its own heading (and frame) is shown as is; a bare one gets a heading from the provider's name,
// icon and description inside the settings card frame.
function accountSlot(ctx, provider) {
  let body;
  try { body = provider.renderCard(ctx); } catch (error) {
    console.error(error);
    body = callout({ tone: 'danger', title: `${provider.name} could not show its settings`, body: 'Reload Still to try again. Your saved account is not affected.' });
  }
  const own = /<h[1-6][\s>]/i.test(String(body ?? ''));
  return html`<div class="${cx('account-slot', own && 'is-own')}" id="settings-account-${provider.id}" data-provider="${provider.id}" data-key="account-${provider.id}" tabindex="-1">
    ${own ? '' : html`<header class="account-slot-head">${providerMark(provider.id, 36, { icon: provider.icon || 'key-round' })}
      <div class="account-slot-heading"><h4 class="account-slot-title">${provider.name}</h4>${provider.description ? html`<p class="account-slot-desc">${provider.description}</p>` : ''}</div></header>`}
    ${body}
  </div>`;
}

export function renderAccounts(ctx) {
  const providers = listAccountProviders();
  // Each card is rendered only when it survives the search, so a filtered-out provider costs nothing.
  const slots = () => providers.filter(provider => searchable([provider.name, provider.description, provider.keywords, 'account token sign in'], true)).map(provider => accountSlot(ctx, provider));
  return html`
    ${group({ title: 'Services', description: providers.length ? 'Connect the services your dashboard widgets use. Each widget asks for the account it needs.' : '',
      body: () => {
        const list = slots();
        if (list.length) return html`<div class="account-list">${list}</div>`;
        if (providers.length || isSearching()) return '';
        return emptyState({ icon: 'key-round', title: 'No services to connect yet',
          body: 'Widgets such as GitHub and Linear add their sign-in here once they are on your dashboard.',
          actions: ctx.env?.isSidepanel ? '' : button({ label: 'Open the dashboard', icon: 'layout-dashboard', size: 'sm', action: 'app.navigate', data: { view: 'dashboard' } }) });
      } })}
    ${isSearching() ? '' : note('lock', 'Tokens and sign-ins are stored only in this Chrome profile’s extension storage. They are never included in backups, exports, bridge sync or library settings, and are sent only to the service they belong to.')}`;
}
