// Place picker for the weather widget: a city search combobox over Open-Meteo geocoding and "Use my location"
// (navigator.geolocation plus a reverse lookup for the name). Used by the widget's setup state and its settings
// dialog; each use has a scope ('w:<widgetId>' or 'set:<widgetId>') holding its query, results and status.
//
// Chrome only shows a permission prompt during a user gesture, so picking a place and "Use my location" request host
// access synchronously, before their first await. Open-Meteo also answers cross-origin requests, so a declined
// prompt does not block the weather.
import { html, cx, raw } from '../../html.js';
import { icon } from '../../icons.js';
import { button, spinner } from '../../components.js';
import { registerActions } from '../../runtime.js';
import { getSettingsDraft } from '../../dashboard/registry.js';
import { updateWidgetConfig } from '../../../lib/dashboard-store.js';
import { requestOrigins } from '../../../lib/permissions.js';
import { searchPlaces, reversePlace, placeLabel, geolocationMessage, WEATHER_ORIGINS, LOCATE_ORIGINS } from '../../../lib/weather.js';

const scopes = new Map();
const scopeState = scope => {
  if (!scopes.has(scope)) scopes.set(scope, { query: '', results: [], searched: '', loading: false, locating: false, error: '', active: -1, seq: 0, timer: 0 });
  return scopes.get(scope);
};
const language = () => String(globalThis.navigator?.language || 'en').slice(0, 2);
const idFor = scope => `wx-search-${scope.replace(/[^\w-]/g, '-')}`;

/** Forgets a scope's search (after a place is chosen or the dialog closes). */
export function resetSearch(scope) {
  const state = scopes.get(scope);
  if (state) clearTimeout(state.timer);
  scopes.delete(scope);
}

/** The combobox, its results and the "Use my location" button. */
export function renderPlacePicker(scope, { widgetId, autofocus = false, compact = false, invalid = '' } = {}) {
  const state = scopeState(scope);
  const id = idFor(scope);
  const listId = `${id}-list`;
  const open = state.results.length > 0;
  const error = state.error || (!open && !state.loading && !state.locating ? invalid : '');
  const status = state.locating ? 'Finding your location…'
    : state.loading ? 'Searching…'
    : error ? error
    : state.searched && !state.results.length ? `No places match “${state.searched}”. Check the spelling or try a nearby city.`
    : open ? `${state.results.length} ${state.results.length === 1 ? 'place' : 'places'} found. Use the arrow keys to choose one.` : '';
  return html`<div class="${cx('w-weather-picker', compact && 'is-compact')}" data-scope="${scope}">
    <div class="w-weather-picker-row">
      <label class="sr-only" for="${id}">Search for a city</label>
      <span class="input-wrap w-weather-picker-field">${icon('search', { size: 16, className: 'input-icon' })}
        <input class="input has-icon" id="${id}" data-focus-key="${id}" type="search" value="${state.query}" placeholder="Search for a city"
          role="combobox" aria-autocomplete="list" aria-expanded="${open ? 'true' : 'false'}" aria-controls="${listId}"
          ${open && state.active >= 0 ? html`aria-activedescendant="${id}-opt-${state.active}"` : ''} ${autofocus ? raw('data-autofocus') : ''}
          ${invalid && !open ? html`aria-invalid="true" aria-describedby="${id}-status"` : ''}
          data-input="w.weather.search" data-keydown="w.weather.search-key" data-scope="${scope}" data-widget="${widgetId}"
          autocomplete="off" spellcheck="false" enterkeyhint="search">
        ${state.loading ? html`<span class="w-weather-picker-spin">${spinner({ size: 14 })}</span>` : ''}
      </span>
      ${button({ label: state.locating ? 'Locating…' : 'Use my location', icon: 'locate-fixed', variant: 'secondary', size: compact ? 'sm' : 'md',
        action: 'w.weather.locate', data: { scope, widget: widgetId }, loading: state.locating, className: 'w-weather-locate',
        attrs: { title: 'Show the weather where you are. Chrome asks before sharing your location.' } })}
    </div>
    <ul class="w-weather-results" id="${listId}" role="listbox" aria-label="Places" ${open ? '' : raw('hidden')}>
      ${state.results.map((place, index) => html`<li class="${cx('w-weather-result', index === state.active && 'is-active')}" role="option" id="${id}-opt-${index}"
        aria-selected="${index === state.active ? 'true' : 'false'}" data-action="w.weather.pick" data-scope="${scope}" data-widget="${widgetId}" data-index="${index}">
        ${icon('map-pin', { size: 14, className: 'w-weather-result-icon' })}
        <span class="w-weather-result-text"><span class="w-weather-result-name">${place.name}</span>
          <span class="w-weather-result-detail">${[place.admin, place.country].filter(Boolean).join(', ')}</span></span>
      </li>`)}
    </ul>
    <p class="${cx('w-weather-picker-status', error && 'is-error', !status && 'sr-only')}" id="${id}-status" role="status">${error ? icon('circle-alert', { size: 14 }) : ''}<span>${status}</span></p>
  </div>`;
}

async function runSearch(ctx, scope) {
  const state = scopeState(scope);
  const query = state.query.trim();
  const seq = ++state.seq;
  if (query.length < 2) {
    Object.assign(state, { results: [], searched: '', loading: false, error: '', active: -1 });
    ctx.render();
    return;
  }
  state.loading = true;
  ctx.render();
  try {
    const results = await searchPlaces(query, { language: language() });
    if (seq !== state.seq) return;
    Object.assign(state, { results, searched: query, loading: false, error: '', active: results.length ? 0 : -1 });
  } catch (error) {
    if (seq !== state.seq) return;
    Object.assign(state, { results: [], searched: '', loading: false, error: error?.message || 'Unable to search for places. Try again.', active: -1 });
  }
  ctx.render();
}

/** Stores a chosen place: into the open settings draft (scope 'set:…') or straight into the widget ('w:…'). */
async function choose(ctx, scope, widgetId, place) {
  resetSearch(scope);
  if (scope.startsWith('set:')) {
    getSettingsDraft()?.set({ location: place });
    ctx.render();
    return;
  }
  await updateWidgetConfig(widgetId, { location: place });
  ctx.toast(`Showing the weather for ${placeLabel(place)}`, { tone: 'success' });
}

function pick(ctx, scope, widgetId, index) {
  const state = scopeState(scope);
  const place = state.results[index];
  if (!place) return undefined;
  requestOrigins(WEATHER_ORIGINS); // during the gesture; the result does not gate the forecast
  return choose(ctx, scope, widgetId, place);
}

function currentPosition() {
  return new Promise((resolve, reject) => {
    const geo = globalThis.navigator?.geolocation;
    if (!geo) { reject(Object.assign(new Error('unavailable'), { code: 2 })); return; }
    geo.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, maximumAge: 30 * 60_000, timeout: 15_000 });
  });
}

/** Whether the scope's picker is on screen (small setup cards hide it and show only their short buttons). */
function pickerShown(scope) {
  const el = globalThis.document?.querySelector(`.w-weather-picker[data-scope="${CSS.escape(scope)}"]`);
  return !!el && el.getClientRects().length > 0;
}

/** Shows a locate failure in the picker, or as a toast when the picker is hidden (else the click seems to do nothing). */
function locateFailed(ctx, scope, state, message) {
  Object.assign(state, { locating: false, error: message });
  ctx.render();
  if (!pickerShown(scope)) ctx.toast(message, { tone: 'warning' });
}

async function locate(ctx, scope, widgetId) {
  const state = scopeState(scope);
  if (state.locating) return;
  requestOrigins(LOCATE_ORIGINS); // during the gesture
  Object.assign(state, { locating: true, error: '', results: [], active: -1 });
  ctx.render();
  let position;
  try {
    position = await currentPosition();
  } catch (error) {
    locateFailed(ctx, scope, state, geolocationMessage(error?.code));
    return;
  }
  const { latitude, longitude } = position.coords;
  const place = await reversePlace(latitude, longitude, { language: language() });
  state.locating = false;
  if (!place) { locateFailed(ctx, scope, state, geolocationMessage(2)); return; }
  await choose(ctx, scope, widgetId, place);
}

registerActions({
  'w.weather.search': ({ ctx, el }) => {
    const scope = el.dataset.scope;
    const state = scopeState(scope);
    state.query = el.value;
    state.error = '';
    clearTimeout(state.timer);
    state.timer = setTimeout(() => ctx.run(() => runSearch(ctx, scope)), 280);
  },
  'w.weather.search-key': ({ ctx, el, event }) => {
    const scope = el.dataset.scope;
    const state = scopeState(scope);
    const count = state.results.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!count) return;
      event.preventDefault();
      state.active = (state.active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      ctx.render();
      ctx.nextFrame(() => document.getElementById(`${idFor(scope)}-opt-${state.active}`)?.scrollIntoView({ block: 'nearest' }));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (count) return pick(ctx, scope, el.dataset.widget, Math.max(0, state.active));
      clearTimeout(state.timer);
      return runSearch(ctx, scope);
    } else if (event.key === 'Escape' && (count || state.query)) {
      // In the widget, Escape closes the results, then clears the search (in a dialog it closes the dialog first).
      event.preventDefault();
      clearTimeout(state.timer);
      Object.assign(state, { query: count ? state.query : '', results: [], searched: '', active: -1, error: '' });
      if (!count) el.value = '';
      ctx.render();
    }
    return undefined;
  },
  'w.weather.pick': ({ ctx, el }) => pick(ctx, el.dataset.scope, el.dataset.widget, Number(el.dataset.index)),
  'w.weather.locate': ({ ctx, data }) => locate(ctx, data.scope, data.widget),
});
