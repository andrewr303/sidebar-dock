// Dashboard header: greeting and date (with the weather chip), the unified search, the board switcher and the actions
// (Ask, Add widget, Edit layout, Customize). There is no app top bar on this view, so this is the top of the page.
// The search comes after the actions in the DOM because narrower dashboards show it on a row below them; wide ones
// place it between heading and actions with grid areas (and reading-flow keeps focus in that visual order).
import { html, cx } from '../html.js';
import { icon, registerIcons } from '../icons.js';
import { button, iconButton } from '../components.js';
import { registerActions } from '../runtime.js';
import { navToggle } from '../sidebar.js';
import { askAi } from '../ai-panel.js';
import { stickiesShown, setStickiesShown } from '../stickies.js';
import * as weather from '../widgets/weather.js';
import { WALLPAPER_PRESETS, WIDGET_STYLES } from '../themes.js';
import { patchGroup, settingsGroup } from '../../lib/settings-schema.js';
import * as dashboardStore from '../../lib/dashboard-store.js';
import { renderSearch } from './search.js';
import { dashUi, dashboardPrefs, newTabPrefs, greetingFor, canEdit } from './state.js';

registerIcons({
  'pencil-ruler': '<path d="M13 7 8.7 2.7a2.41 2.41 0 0 0-3.4 0L2.7 5.3a2.41 2.41 0 0 0 0 3.4L7 13"/><path d="m8 6 2-2"/><path d="m18 16 2-2"/><path d="m17 11 4.3 4.3c.94.94.94 2.46 0 3.4l-2.6 2.6c-.94.94-2.46.94-3.4 0L11 17"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
});

export const BOARD_ICONS = Object.freeze(['layout-dashboard', 'house', 'briefcase', 'code-xml', 'book-open', 'sparkles', 'palette', 'rocket',
  'coffee', 'music', 'plane', 'star', 'heart', 'leaf', 'target', 'graduation-cap']);
const STYLES = WIDGET_STYLES;
const GAPS = [{ value: 'sm', label: 'Compact spacing' }, { value: 'md', label: 'Comfortable spacing' }, { value: 'lg', label: 'Roomy spacing' }];
const menuOpenFor = (ctx, action) => ctx.state.popover?.anchorEl?.dataset?.action === action;

/** The weather agent's compact chip ('' when there is no weather widget or no cached forecast yet). */
function weatherChip(ctx) {
  try { return weather.renderWeatherChip?.(ctx) || ''; } catch (error) { console.error(error); return ''; }
}

export function dateLabel(date = new Date()) {
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

export function renderHeader(ctx, board) {
  const ui = dashUi(ctx);
  const dash = dashboardPrefs(ctx);
  const tab = newTabPrefs(ctx);
  const name = String(tab.name || '').trim();
  const title = tab.greeting ? `${greetingFor()}${name ? `, ${name}` : ''}` : board.name;
  const chip = dash.weatherChip ? weatherChip(ctx) : '';
  const editing = ui.editing && canEdit(ctx);
  const showHeader = dash.header !== false;
  return html`<header class="${cx('dash-header', !showHeader && 'is-minimal', tab.search && 'has-search')}" data-key="dash-header">
    <div class="dash-heading">
      ${navToggle(ctx)}
      <div class="dash-heading-text">
        <h1 class="${cx('dash-title', !showHeader && 'sr-only')}">${editing ? `Editing ${board.name}` : title}</h1>
        ${showHeader ? html`<p class="dash-meta"><span class="dash-date">${dateLabel()}</span>${chip ? html`<span class="dash-meta-sep" aria-hidden="true">·</span>${chip}` : ''}</p>` : ''}
      </div>
    </div>
    <div class="dash-actions" role="group" aria-label="Dashboard actions">
      ${editing ? html`
        ${button({ label: 'Tidy up', icon: 'wand-sparkles', variant: 'ghost', action: 'dashboard.tidy', attrs: { 'data-tooltip': 'Move widgets up to close gaps' } })}
        ${button({ label: 'Add widget', icon: 'plus', variant: 'secondary', action: 'dashboard.add-widget' })}
        ${button({ label: 'Done', icon: 'check', variant: 'primary', action: 'dashboard.edit', attrs: { 'aria-keyshortcuts': 'Escape' } })}`
      : html`
        ${showHeader ? html`<button type="button" class="dash-board-switch" data-action="dashboard.board-menu" aria-haspopup="true"
          aria-expanded="${menuOpenFor(ctx, 'dashboard.board-menu') ? 'true' : 'false'}" aria-label="Board: ${board.name}. Switch board" data-tooltip="Switch board">
          ${icon(board.icon || 'layout-dashboard', { size: 16 })}<span class="dash-board-name">${board.name}</span>${icon('chevron-down', { size: 14, className: 'dash-board-chevron' })}
        </button>` : ''}
        ${iconButton({ icon: 'sparkles', label: 'Ask AI', action: 'dashboard.ask', kbd: 'mod+shift+a' })}
        ${iconButton({ icon: 'plus', label: 'Add widget', action: 'dashboard.add-widget' })}
        ${iconButton({ icon: 'pencil-ruler', label: canEdit(ctx) ? 'Edit layout' : 'Widen the window to edit the layout', action: 'dashboard.edit', pressed: false,
          disabled: !canEdit(ctx) })}
        ${iconButton({ icon: 'palette', label: 'Customize', action: 'dashboard.customize', expanded: menuOpenFor(ctx, 'dashboard.customize'), tooltipPlacement: 'bottom end' })}`}
    </div>
    ${tab.search && !editing ? renderSearch(ctx) : ''}
  </header>
  ${editing ? html`<p class="dash-edit-hint" data-key="dash-edit-hint">${icon('info', { size: 14 })}<span>Drag a widget by its header to move it and drag its edges to resize.
    With a widget focused, arrow keys move it, Shift and arrow keys resize it and Delete removes it.</span></p>` : ''}`;
}

// ------------------------------------------------------------------ boards

const shortcutHint = (ctx, index) => (index < 9 ? `${ctx.env.isMac ? '⌥' : 'Alt'} ${index + 1}` : undefined);

function boardMenu(ctx) {
  const state = dashboardStore.getDashboard();
  const board = dashboardStore.activeBoard();
  return [
    { heading: 'Boards' },
    ...state.boards.map((b, index) => ({ label: b.name, checked: b.id === board.id, hint: shortcutHint(ctx, index), run: () => switchBoard(ctx, b.id) })),
    { separator: true },
    { label: 'New board…', icon: 'plus', run: () => newBoard(ctx) },
    { label: 'Rename board…', icon: 'pencil', run: () => renameBoard(ctx, board) },
    { label: 'Change icon…', icon: 'palette', keepFocus: true, run: () => iconMenu(ctx, board) },
    ...(state.boards.length > 1 ? [
      { label: 'Move board up', icon: 'arrow-up', disabled: state.boards[0].id === board.id, run: () => dashboardStore.moveBoard(board.id, state.boards.indexOf(board) - 1) },
      { label: 'Move board down', icon: 'arrow-down', disabled: state.boards.at(-1).id === board.id, run: () => dashboardStore.moveBoard(board.id, state.boards.indexOf(board) + 1) },
    ] : []),
    { separator: true },
    { label: 'Delete board…', icon: 'trash-2', danger: true, disabled: state.boards.length < 2, run: () => deleteBoard(ctx, board) },
  ];
}

function iconMenu(ctx, board) {
  const anchor = document.querySelector('.dash-board-switch');
  if (!anchor) return;
  ctx.openMenu(anchor, BOARD_ICONS.map(name => ({ label: name.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase()), icon: name,
    hint: board.icon === name ? 'Current' : undefined, run: () => dashboardStore.updateBoard(board.id, { icon: name }) })),
  { placement: 'bottom-end', label: 'Board icon' });
}

export async function switchBoard(ctx, boardId) {
  const ui = dashUi(ctx);
  if (dashboardStore.getDashboard()?.activeBoardId === boardId) return;
  ui.search = { ...ui.search, open: false };
  await dashboardStore.setActiveBoard(boardId);
  const board = dashboardStore.activeBoard();
  ui.announce = `Showing ${board?.name || 'board'}`;
  ctx.render();
}

async function newBoard(ctx) {
  const name = await ctx.prompt({ title: 'New board', label: 'Board name', placeholder: 'Work, Reading, Side projects…', confirmLabel: 'Create board' });
  if (name === null) return;
  const board = await dashboardStore.addBoard({ name: name.trim() || 'New board' });
  dashUi(ctx).announce = `Created ${board.name}`;
  ctx.toast(`Created ${board.name}. Add a few widgets to get started.`, { tone: 'success' });
}

async function renameBoard(ctx, board) {
  const name = await ctx.prompt({ title: 'Rename board', label: 'Board name', value: board.name, confirmLabel: 'Rename' });
  if (name === null || !name.trim() || name.trim() === board.name) return;
  await dashboardStore.updateBoard(board.id, { name: name.trim() });
}

async function deleteBoard(ctx, board) {
  const state = dashboardStore.getDashboard();
  if (state.boards.length < 2) return;
  const count = board.widgets.length;
  const ok = await ctx.confirm({ title: `Delete ${board.name}?`, confirmLabel: 'Delete board', tone: 'danger',
    body: count ? `Its ${count === 1 ? 'widget' : `${count} widgets`} will be removed too. Library items the widgets show stay in your library.` : 'This board has no widgets.' });
  if (!ok) return;
  const index = state.boards.findIndex(b => b.id === board.id);
  const snapshot = structuredClone(board);
  await dashboardStore.removeBoard(board.id);
  ctx.toast(`Deleted ${board.name}`, { action: { label: 'Undo', run: () => dashboardStore.restoreBoard(snapshot, index) } });
}

// ------------------------------------------------------------------ customize

function customizeMenu(ctx) {
  const settings = ctx.library?.settings || {};
  const wallpaper = settingsGroup(settings, 'wallpaper');
  const dash = settingsGroup(settings, 'dashboard');
  const tab = settingsGroup(settings, 'newTab');
  const setWallpaper = patch => patchGroup(ctx.store, ctx.library.settings, 'wallpaper', patch);
  const setDash = patch => patchGroup(ctx.store, ctx.library.settings, 'dashboard', patch);
  const setTab = patch => patchGroup(ctx.store, ctx.library.settings, 'newTab', patch);
  const custom = ['color', 'image', 'url'].includes(wallpaper.kind);
  return [
    { heading: 'Wallpaper' },
    { label: 'No wallpaper', checked: wallpaper.kind === 'none', run: () => setWallpaper({ kind: 'none' }) },
    ...WALLPAPER_PRESETS.map(preset => ({ label: preset.label, checked: wallpaper.kind === 'preset' && wallpaper.preset === preset.id,
      run: () => setWallpaper({ kind: 'preset', preset: preset.id }) })),
    ...(custom ? [{ label: 'Your wallpaper', checked: true, run: () => {} }] : []),
    { separator: true },
    { heading: 'Widgets' },
    ...STYLES.map(style => ({ label: style.label, checked: dash.widgetStyle === style.value, run: () => setDash({ widgetStyle: style.value }) })),
    { separator: true },
    ...GAPS.map(gap => ({ label: gap.label, checked: dash.gap === gap.value, run: () => setDash({ gap: gap.value }) })),
    { separator: true },
    { heading: 'Show' },
    { label: 'Greeting', checked: !!tab.greeting, run: () => setTab({ greeting: !tab.greeting }) },
    { label: 'Search bar', checked: !!tab.search, run: () => setTab({ search: !tab.search }) },
    { label: 'Weather in header', checked: !!dash.weatherChip, run: () => setDash({ weatherChip: !dash.weatherChip }) },
    { label: 'Sticky notes', checked: stickiesShown(ctx), run: () => setStickiesShown(ctx, !stickiesShown(ctx)) },
    { separator: true },
    { label: 'More in Settings', icon: 'settings', run: () => ctx.navigate('settings:newtab') },
  ];
}

registerActions({
  'dashboard.board-menu': ({ ctx, el }) => ctx.openMenu(el, boardMenu(ctx), { placement: 'bottom-end', label: 'Boards' }),
  'dashboard.customize': ({ ctx, el }) => ctx.openMenu(el, customizeMenu(ctx), { placement: 'bottom-end', label: 'Customize dashboard' }),
  'dashboard.ask': ({ ctx }) => askAi(ctx),
  'dashboard.new-board': ({ ctx }) => newBoard(ctx),
});
