// GitHub widget settings (rendered inside the dashboard's widget settings dialog): lists, owners, repositories, layout and
// refresh. Edits go to the dialog's draft through getSettingsDraft(); nothing is saved until the dialog's Save.
import { html, cx, raw } from '../../html.js';
import { icon } from '../../icons.js';
import { registerActions } from '../../runtime.js';
import { button, checkbox, switchToggle, segmented, select, field, textarea, input } from '../../components.js';
import { getSettingsDraft } from '../../dashboard/registry.js';
import { TABS, normalizeConfig, cleanOwner, cleanRepo } from '../../../lib/github.js';
import { authState, githubAvatar, METHOD_LABELS } from './connection.js';
import { datasetFor } from './data.js';

const TAB_HINTS = {
  all: 'Every open pull request you can see', mine: 'Pull requests you opened', reviews: 'Waiting for your review', assigned: 'Assigned to you',
  drafts: 'Your drafts and drafts assigned to you', failing: 'Failing checks and red workflow runs', copilot: 'Copilot coding agent work',
  notifications: 'Unread GitHub notifications',
};
const LIST_SPLIT = /[\s,]+/;

const section = (title, body, description = '') => html`<section class="w-github-settings-section">
  <h3 class="w-github-settings-head">${title}</h3>${description ? html`<p class="w-github-settings-desc">${description}</p>` : ''}${body}</section>`;

export function renderGitHubSettings(ctx, widget, draft) {
  const c = normalizeConfig(draft);
  const info = authState().info;
  const snapshot = datasetFor(c)?.snapshot;
  const viewer = snapshot?.viewer;
  const excluded = new Set(c.excludeOwners.map(o => o.toLowerCase()));
  const known = viewer ? [{ login: viewer.login, avatarUrl: viewer.avatarUrl, you: true }, ...viewer.orgs] : [];
  const tabsError = !c.tabs.length || !(draft.tabs || []).length;
  return html`<div class="w-github-settings">
    ${section('Account', html`<div class="w-github-settings-account">
      ${info?.connected ? html`${githubAvatar(info.avatarUrl, 28)}<span class="w-github-settings-who"><strong>@${info.login}</strong><span>${METHOD_LABELS[info.method] || 'Connected'}</span></span>`
        : html`${githubAvatar('', 28)}<span class="w-github-settings-who"><strong>Not connected</strong><span>Connect GitHub to load pull requests.</span></span>`}
      ${button({ label: info?.connected ? 'Manage' : 'Connect GitHub', size: 'sm', variant: info?.connected ? 'secondary' : 'primary', action: 'w.github.open-connect' })}
    </div>`)}

    ${section('Lists', html`<div class="${cx('w-github-settings-tabs', tabsError && 'has-error')}" role="group" aria-label="Lists to show" ${tabsError ? html`aria-describedby="ghs-${widget.id}-tabs-error"` : ''}>
        ${TABS.map(tab => html`<div class="w-github-settings-tab">${checkbox({ checked: (draft.tabs || c.tabs).includes(tab.id), label: tab.label, action: 'w.github.set-tab', data: { tab: tab.id } })}
          <span class="w-github-settings-hint">${TAB_HINTS[tab.id]}</span></div>`)}
      </div>
      ${tabsError ? html`<p class="field-error" role="alert" id="ghs-${widget.id}-tabs-error">${icon('circle-alert', { size: 14 })}<span>Choose at least one list to show.</span></p>` : ''}`,
      'Each list becomes a tab. Small widgets show counts for open pull requests, reviews, failing checks and your inbox.')}

    ${section('Pull requests', html`
      ${known.length ? html`<fieldset class="w-github-settings-owners"><legend class="field-label">Accounts and organizations</legend>
        <div class="w-github-owner-grid">${known.map(owner => html`<label class="w-github-owner">
          <input type="checkbox" class="w-github-owner-input" ${excluded.has(owner.login.toLowerCase()) ? '' : raw('checked')} data-change="w.github.set-owner" data-owner="${owner.login}">
          ${githubAvatar(owner.avatarUrl, 20)}<span class="w-github-owner-name">${owner.login}${owner.you ? html` <span class="w-github-settings-hint">(you)</span>` : ''}</span>
          <span class="w-github-owner-check" aria-hidden="true">${icon('check', { size: 12, strokeWidth: 2.5 })}</span></label>`)}</div></fieldset>`
        : html`<p class="w-github-settings-desc">Your organizations appear here after the first refresh.</p>`}
      ${field({ label: 'Other owners', id: `ghs-${widget.id}-extra`, hint: 'People or organizations you contribute to, separated by commas. Their open pull requests are included.',
        control: input({ id: `ghs-${widget.id}-extra`, value: c.extraOwners.join(', '), placeholder: 'vercel, rust-lang', action: 'w.github.set-list-input', change: 'w.github.set-list', attrs: { 'data-key': 'extraOwners' }, describedBy: `ghs-${widget.id}-extra-hint` }) })}
      ${field({ label: 'Hidden repositories', id: `ghs-${widget.id}-repos`, hint: 'One owner/repository per line, for example acme/legacy-site.',
        control: textarea({ id: `ghs-${widget.id}-repos`, value: c.excludeRepos.join('\n'), rows: 3, placeholder: 'acme/legacy-site', action: 'w.github.set-list-input', change: 'w.github.set-list', attrs: { 'data-key': 'excludeRepos' }, describedBy: `ghs-${widget.id}-repos-hint` }) })}
      ${switchToggle({ checked: c.hideDrafts, label: 'Hide draft pull requests', description: 'Drafts stay in the Drafts list.', action: 'w.github.set', data: { key: 'hideDrafts', type: 'boolean' } })}
      ${switchToggle({ checked: c.hideBots, label: 'Hide pull requests from bots', description: 'Dependabot, Renovate, GitHub Actions and similar. Copilot stays visible.', action: 'w.github.set', data: { key: 'hideBots', type: 'boolean' } })}
    `)}

    ${section('Layout', html`<div class="w-github-settings-grid">
      ${field({ label: 'Group by', control: segmented({ name: 'groupBy', value: c.groupBy, action: 'w.github.set-choice', size: 'sm', ariaLabel: 'Group by',
        options: [{ value: 'none', label: 'None' }, { value: 'repo', label: 'Repository' }, { value: 'owner', label: 'Owner' }, { value: 'status', label: 'Status' }] }) })}
      ${field({ label: 'Density', control: segmented({ name: 'density', value: c.density, action: 'w.github.set-choice', size: 'sm', ariaLabel: 'Density',
        options: [{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }] }) })}
      ${field({ label: 'Sort by', id: `ghs-${widget.id}-sort`, control: select({ id: `ghs-${widget.id}-sort`, value: c.sort, action: 'w.github.set', size: 'sm',
        options: [{ value: 'updated', label: 'Recently updated' }, { value: 'created', label: 'Newest' }, { value: 'status', label: 'Needs attention first' }, { value: 'repo', label: 'Repository' }] }) })}
    </div>`, 'Medium widgets show one list at a time. Large widgets add a detail pane with checks, reviews and merge options.')}

    ${section('Updates', html`<div class="w-github-settings-grid">
      ${field({ label: 'Refresh', id: `ghs-${widget.id}-refresh`, control: select({ id: `ghs-${widget.id}-refresh`, value: String(c.refresh), action: 'w.github.set', size: 'sm',
        options: [{ value: '2', label: 'Every 2 minutes' }, { value: '5', label: 'Every 5 minutes' }, { value: '10', label: 'Every 10 minutes' }, { value: '30', label: 'Every 30 minutes' }, { value: '0', label: 'Only when I refresh' }] }) })}
      ${field({ label: 'Pull requests per owner', id: `ghs-${widget.id}-max`, control: select({ id: `ghs-${widget.id}-max`, value: String(c.maxPerOwner), action: 'w.github.set', size: 'sm',
        options: [100, 300, 500, 1000].map(n => ({ value: String(n), label: `Up to ${n.toLocaleString()}` })) }) })}
    </div>
    ${switchToggle({ checked: c.showCi, label: 'Check recent workflow runs', description: 'Looks for red GitHub Actions runs in the repositories with your busiest pull requests.', action: 'w.github.set', data: { key: 'showCi', type: 'boolean' } })}
    ${c.showCi ? field({ label: 'Repositories to check', id: `ghs-${widget.id}-ci`, control: select({ id: `ghs-${widget.id}-ci`, value: String(c.ciRepos || 6), action: 'w.github.set', size: 'sm',
      options: [3, 6, 12].map(n => ({ value: String(n), label: `${n} repositories` })) }) }) : ''}`,
      'Refreshes run in the background while the page is open and visible. Results are cached so new tabs show them at once.')}
  </div>`;
}

/** Store-ready config from the draft; throws (keeping the dialog open) when no list is chosen. */
export function saveGitHubSettings(draft) {
  if (!Array.isArray(draft.tabs) || !draft.tabs.length) throw new Error('Choose at least one list to show.');
  const next = normalizeConfig(draft);
  if (!next.tabs.includes(next.tab)) next.tab = next.tabs[0];
  return next;
}

const KEY_FROM_ID = { sort: 'sort', refresh: 'refresh', max: 'maxPerOwner', ci: 'ciRepos' };
const NUMERIC = new Set(['refresh', 'maxPerOwner', 'ciRepos']);
const parseList = (key, text) => [...new Set(String(text || '').split(key === 'excludeRepos' ? /[\s,]+/ : LIST_SPLIT)
  .map(v => (key === 'excludeRepos' ? cleanRepo(v) : cleanOwner(v))).filter(Boolean))];

registerActions({
  'w.github.set': ({ el, data }) => {
    const holder = getSettingsDraft();
    if (!holder) return;
    const key = data.key || KEY_FROM_ID[(el.id || '').split('-').pop()];
    if (!key) return;
    const value = data.type === 'boolean' ? !!el.checked : NUMERIC.has(key) ? Number(el.value) : el.value;
    holder.set({ [key]: value });
  },
  'w.github.set-choice': ({ data }) => { getSettingsDraft()?.set({ [data.name]: data.value }); },
  'w.github.set-tab': ({ el, data }) => {
    const holder = getSettingsDraft();
    if (!holder) return;
    const current = new Set(Array.isArray(holder.draft.tabs) ? holder.draft.tabs : normalizeConfig(holder.draft).tabs);
    if (el.checked) current.add(data.tab); else current.delete(data.tab);
    holder.set({ tabs: TABS.map(t => t.id).filter(id => current.has(id)) });
  },
  'w.github.set-owner': ({ el, data }) => {
    const holder = getSettingsDraft();
    if (!holder) return;
    const owner = data.owner.toLowerCase();
    const list = (holder.draft.excludeOwners || []).filter(o => String(o).toLowerCase() !== owner);
    if (!el.checked) list.push(data.owner);
    holder.set({ excludeOwners: list });
  },
  'w.github.set-list-input': ({ el }) => { getSettingsDraft()?.set({ [el.dataset.key]: parseList(el.dataset.key, el.value) }, { render: false }); },
  'w.github.set-list': ({ el }) => { getSettingsDraft()?.set({ [el.dataset.key]: parseList(el.dataset.key, el.value) }); },
});
