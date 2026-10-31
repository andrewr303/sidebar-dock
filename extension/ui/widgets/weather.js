// Weather widget: current conditions, the next hours, a 7-day forecast and details (wind, humidity, sun times) from
// Open-Meteo for one place. Forecasts are cached in lib/widget-cache.js for 20 minutes, so a new tab paints the last
// forecast at once and refreshes it in the background. Sections appear as the widget grows (container queries in
// styles/widgets/weather.css). Also exports renderWeatherChip(ctx) for the dashboard header.
import { html, cx } from '../html.js';
import { icon } from '../icons.js';
import { button, iconButton, segmented, switchToggle, field, emptyState } from '../components.js';
import { registerActions, registerMount } from '../runtime.js';
import { defineWidget, getSettingsDraft } from '../dashboard/registry.js';
import { findWidget, activeBoard, updateWidgetConfig } from '../../lib/dashboard-store.js';
import { readCache, writeCache, isStale } from '../../lib/widget-cache.js';
import { hasOrigins, requestOrigins } from '../../lib/permissions.js';
import {
  weatherCondition, resolveUnit, unitLabel, weatherCacheKey, normalizePlace, placeLabel, fetchForecast, upcomingHours, today, formatTemp,
  formatWind, formatHour, formatClock, formatDay, updatedLabel, weatherError, WEATHER_MAX_AGE, WEATHER_ORIGINS, ATTRIBUTION,
} from '../../lib/weather.js';
import './weather/icons.js';
import { renderPlacePicker, resetSearch } from './weather/location.js';

const defaults = () => ({ location: null, units: 'auto', show: { hourly: true, daily: true, details: true } });
const configOf = widget => {
  const config = { ...defaults(), ...(widget?.config || {}) };
  config.show = { ...defaults().show, ...(widget?.config?.show || {}) };
  config.location = normalizePlace(config.location);
  return config;
};
const locale = () => globalThis.navigator?.language || undefined;
const RETRY_MS = { rate: 15 * 60_000, access: 60 * 60_000, location: 60 * 60_000 };

// Background refreshes per cache key: { promise, error, kind, failedAt }. Shared by every widget showing that place.
const sync = new Map();

function refresh(ctx, place, unit, { force = false } = {}) {
  const key = weatherCacheKey(place, unit);
  const state = sync.get(key) || {};
  if (state.promise) return state.promise;
  if (!force && state.failedAt && Date.now() - state.failedAt < (RETRY_MS[state.kind] || 5 * 60_000)) return null;
  if (!force && !isStale(key, WEATHER_MAX_AGE)) return null;
  const promise = (async () => {
    try {
      writeCache(key, await fetchForecast(place, unit));
      sync.set(key, {});
    } catch (error) {
      let failure = error;
      // A failed request without host access is most likely the missing grant.
      if (error?.kind === 'network' && !(await hasOrigins(WEATHER_ORIGINS))) {
        failure = weatherError('access', 'Still needs access to open-meteo.com to load the weather.');
      }
      sync.set(key, { error: failure?.message || 'Unable to load the weather. Try again in a few minutes.', kind: failure?.kind || 'http', failedAt: Date.now() });
    }
    ctx.render();
  })();
  sync.set(key, { ...state, promise });
  ctx.render();
  return promise;
}

// ------------------------------------------------------------------ rendering

const glyph = (condition, size, className) => html`<span class="${cx('w-weather-glyph', className)}" data-tint="${condition.tint}" aria-hidden="true">${icon(condition.icon, { size, strokeWidth: size > 28 ? 1.5 : 1.75 })}</span>`;

function tempMarkup(value, unit, className = 'w-weather-temp') {
  const text = formatTemp(value);
  return html`<span class="${className}"><span aria-hidden="true">${text}</span><span class="${className}-unit" aria-hidden="true">${unitLabel(unit)}</span><span class="sr-only">${text.replace('°', '')} degrees ${unit === 'f' ? 'Fahrenheit' : 'Celsius'}</span></span>`;
}

function renderSetup(ctx, widget) {
  return html`<div class="w-weather is-setup" data-widget="${widget.id}">
    <div class="w-weather-setup-head">
      <span class="w-weather-setup-icon" aria-hidden="true">${icon('wx-cloud-sun', { size: 22 })}</span>
      <div class="w-weather-setup-text">
        <p class="w-weather-setup-title">Show the weather for a place</p>
        <p class="w-weather-setup-body">Search for a city or use your location. The forecast comes from Open-Meteo.</p>
      </div>
    </div>
    <div class="w-weather-setup-inline">${renderPlacePicker(`w:${widget.id}`, { widgetId: widget.id, compact: true })}</div>
    <div class="w-weather-setup-short">
      ${button({ label: 'Choose a city', icon: 'search', size: 'sm', variant: 'secondary', action: 'dashboard.widget-settings', data: { widget: widget.id } })}
      ${iconButton({ icon: 'locate-fixed', label: 'Use my location', size: 'sm', variant: 'secondary', action: 'w.weather.locate', data: { scope: `w:${widget.id}`, widget: widget.id } })}
    </div>
  </div>`;
}

function renderLoading(widget, place) {
  return html`<div class="w-weather is-loading" data-widget="${widget.id}" aria-busy="true">
    <div class="w-weather-now">
      <span class="w-weather-glyph is-bone skeleton-bone"></span>
      <div class="w-weather-reading"><span class="skeleton-bone w-weather-bone-temp"></span><span class="skeleton-bone w-weather-bone-line"></span></div>
    </div>
    <p class="sr-only" role="status">Loading the weather for ${placeLabel(place)}</p>
  </div>`;
}

function renderError(widget, place, state) {
  const access = state.kind === 'access';
  return html`<div class="w-weather is-error" data-widget="${widget.id}">${emptyState({
    icon: access ? 'lock' : 'cloud-off', compact: true, tone: access ? undefined : 'danger',
    title: access ? 'Allow access to load the weather' : `Unable to load the weather for ${placeLabel(place)}`,
    body: state.error,
    actions: access
      ? button({ label: 'Allow access to open-meteo.com', icon: 'lock-open', size: 'sm', variant: 'primary', action: 'w.weather.allow', data: { widget: widget.id } })
      : button({ label: 'Try again', icon: 'refresh-cw', size: 'sm', action: 'w.weather.refresh', data: { widget: widget.id } }),
  })}</div>`;
}

function renderHours(data, unit) {
  const hours = upcomingHours(data, Date.now(), 12);
  if (!hours.length) return '';
  const anyWet = hours.some(hour => Number(hour.pop) >= 30);
  return html`<ol class="${cx('w-weather-hours', anyWet && 'has-pop')}" aria-label="Next hours">${hours.map((hour, index) => {
    const condition = weatherCondition(hour.code, hour.isDay);
    const wet = Number(hour.pop) >= 30;
    return html`<li class="w-weather-hour" data-key="h${hour.time}">
      <span class="w-weather-hour-time">${index ? formatHour(hour.time, data.tz, locale()) : 'Now'}</span>
      ${glyph(condition, 20)}
      <span class="w-weather-hour-temp">${formatTemp(hour.temp)}</span>
      <span class="${cx('w-weather-pop', !wet && 'is-dry')}" aria-hidden="${wet ? 'false' : 'true'}">${wet ? `${Math.round(hour.pop)}%` : '0%'}</span>
      <span class="sr-only">${condition.label}${wet ? `, ${Math.round(hour.pop)}% chance of precipitation` : ''}</span>
    </li>`;
  })}</ol>`;
}

function renderDays(data, unit) {
  const days = data.daily || [];
  if (!days.length) return '';
  const low = Math.min(...days.map(d => d.min));
  const high = Math.max(...days.map(d => d.max));
  const span = Math.max(1, high - low);
  const now = data.current?.temp;
  return html`<ol class="w-weather-days" aria-label="7-day forecast">${days.map((day, index) => {
    const condition = weatherCondition(day.code, true);
    const from = ((day.min - low) / span) * 100;
    const to = ((day.max - low) / span) * 100;
    const marker = index === 0 && Number.isFinite(now) && now >= day.min && now <= day.max ? ((now - low) / span) * 100 : null;
    const wet = Number(day.pop) >= 30;
    return html`<li class="w-weather-day" data-key="d${day.time}">
      <span class="w-weather-day-name">${formatDay(day.time, data.tz, locale(), { first: index === 0 })}</span>
      ${glyph(condition, 18)}
      <span class="${cx('w-weather-pop', !wet && 'is-dry')}" aria-hidden="true">${wet ? `${Math.round(day.pop)}%` : ''}</span>
      <span class="w-weather-day-low" aria-hidden="true">${formatTemp(day.min)}</span>
      <span class="w-weather-range" aria-hidden="true"><span class="w-weather-range-fill" style="inset-inline-start:${from.toFixed(1)}%;inline-size:${Math.max(4, to - from).toFixed(1)}%"></span>
        ${marker !== null ? html`<span class="w-weather-range-now" style="inset-inline-start:${marker.toFixed(1)}%"></span>` : ''}</span>
      <span class="w-weather-day-high" aria-hidden="true">${formatTemp(day.max)}</span>
      <span class="sr-only">${condition.label}, high ${formatTemp(day.max)}, low ${formatTemp(day.min)}${wet ? `, ${Math.round(day.pop)}% chance of precipitation` : ''}</span>
    </li>`;
  })}</ol>`;
}

function renderDetails(data, unit) {
  const day = today(data);
  const rows = [
    { icon: 'wind', label: 'Wind', value: formatWind(data.current.wind, unit) },
    { icon: 'droplets', label: 'Humidity', value: Number.isFinite(data.current.humidity) ? `${Math.round(data.current.humidity)}%` : '–' },
    { icon: 'sunrise', label: 'Sunrise', value: formatClock(day?.sunrise, data.tz, locale()) },
    { icon: 'sunset', label: 'Sunset', value: formatClock(day?.sunset, data.tz, locale()) },
  ];
  return html`<dl class="w-weather-details">${rows.map(row => html`<div class="w-weather-detail">
    <dt>${icon(row.icon, { size: 14 })}<span>${row.label}</span></dt><dd>${row.value}</dd></div>`)}</dl>`;
}

function render(ctx, widget, env) {
  const config = configOf(widget);
  const place = config.location;
  if (!place) return renderSetup(ctx, widget);
  const unit = resolveUnit(config.units, locale());
  const key = weatherCacheKey(place, unit);
  const entry = readCache(key);
  const state = sync.get(key) || {};
  const data = entry?.value?.current ? entry.value : null;
  const mount = html`data-mount="w.weather.sync" data-key="wx-${widget.id}" data-widget="${widget.id}"`;
  if (!data) {
    const body = state.error && !state.promise ? renderError(widget, place, state) : renderLoading(widget, place);
    return html`<div class="w-weather-root" ${mount}>${body}</div>`;
  }
  const condition = weatherCondition(data.current.code, data.current.isDay);
  const day = today(data);
  const headless = !!(widget.style?.hideTitle || widget.style?.frame === 'none' || widget.title);
  const updated = updatedLabel(entry.at);
  const failed = state.error && !state.promise;
  const show = config.show;
  return html`<div class="w-weather-root" ${mount}>
    <div class="${cx('w-weather', show.hourly && 'has-hours', show.daily && 'has-days', show.details && 'has-details')}" data-tint="${condition.tint}" data-widget="${widget.id}">
      <div class="w-weather-now" title="${placeLabel(place, { detail: true })} · ${updated}">
        ${glyph(condition, 48, 'is-hero')}
        <div class="w-weather-reading">
          ${tempMarkup(data.current.temp, unit)}
          <p class="w-weather-cond">${condition.label}</p>
        </div>
        <div class="w-weather-meta">
          ${headless ? html`<p class="w-weather-place">${icon(place.source === 'device' ? 'navigation-2' : 'map-pin', { size: 12 })}<span>${placeLabel(place)}</span></p>` : ''}
          ${day ? html`<p class="w-weather-hilo"><span>H ${formatTemp(day.max)}</span><span>L ${formatTemp(day.min)}</span></p>` : ''}
          <p class="w-weather-feels">Feels like ${formatTemp(data.current.feels)}</p>
        </div>
      </div>
      ${show.hourly ? html`<section class="w-weather-section is-hours" aria-label="Hourly forecast">${renderHours(data, unit)}</section>` : ''}
      ${show.daily ? html`<section class="w-weather-section is-days" aria-label="7-day forecast">${renderDays(data, unit)}</section>` : ''}
      ${show.details ? html`<section class="w-weather-section is-details" aria-label="Details">${renderDetails(data, unit)}</section>` : ''}
      <p class="${cx('w-weather-foot', failed && 'is-error')}">
        ${failed ? html`<button type="button" class="w-weather-retry" data-action="w.weather.refresh" data-widget="${widget.id}" title="${state.error} ${updated}."
          aria-label="Unable to refresh the weather. ${updated}. Try again">
          ${icon('triangle-alert', { size: 12 })}<span class="w-weather-retry-text">Unable to refresh. Try again</span></button>` : html`<span role="status">${updated}</span>`}
        <a class="w-weather-credit" href="${ATTRIBUTION.href}" target="_blank" rel="noopener noreferrer">Open-Meteo</a>
      </p>
    </div>
  </div>`;
}

// Fetches when the cached forecast is missing or stale, then checks again every minute while the tab is visible.
registerMount('w.weather.sync', (el, ctx) => {
  const check = (force = false) => {
    if (typeof document !== 'undefined' && document.hidden && !force) return;
    const found = findWidget(el.dataset.widget);
    const config = found && configOf(found.widget);
    if (!config?.location) return;
    refresh(ctx, config.location, resolveUnit(config.units, locale()), { force });
  };
  queueMicrotask(() => check());
  const timer = setInterval(() => check(), 60_000);
  const onVisible = () => { if (!document.hidden) check(); };
  document.addEventListener('visibilitychange', onVisible);
  return {
    update: () => queueMicrotask(() => check()),
    destroy() { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); },
  };
});

// ------------------------------------------------------------------ header, menu and settings

function headerActions(ctx, widget) {
  const config = configOf(widget);
  if (!config.location) return '';
  const key = weatherCacheKey(config.location, resolveUnit(config.units, locale()));
  const busy = !!sync.get(key)?.promise;
  return html`<button type="button" class="${cx('icon-btn', 'icon-btn-sm', 'w-weather-refresh', busy && 'is-busy')}" data-action="w.weather.refresh" data-widget="${widget.id}"
    aria-label="Refresh the weather" data-tooltip="${busy ? 'Refreshing…' : 'Refresh'}" ${busy ? html`aria-busy="true"` : ''}>${icon('refresh-cw', { size: 14 })}</button>`;
}

function menu(ctx, widget) {
  const config = configOf(widget);
  const unit = resolveUnit(config.units, locale());
  return [
    ...(config.location ? [
      { label: 'Refresh', icon: 'refresh-cw', run: () => refreshWidget(ctx, widget.id) },
      { label: unit === 'f' ? 'Show Celsius' : 'Show Fahrenheit', icon: 'thermometer', run: () => updateWidgetConfig(widget.id, { units: unit === 'f' ? 'c' : 'f' }) },
    ] : []),
    { label: config.location ? 'Change place…' : 'Choose a place…', icon: 'map-pin', run: () => ctx.dispatch('dashboard.widget-settings', { data: { widget: widget.id } }) },
    { label: 'Weather data by Open-Meteo', icon: 'external-link', run: () => globalThis.open?.(ATTRIBUTION.href, '_blank', 'noopener') },
  ];
}

// Each opening of the settings dialog starts with an empty search (the draft holder is new per opening).
const seenDrafts = new WeakSet();
function renderSettings(ctx, widget, draft, env) {
  const holder = getSettingsDraft();
  if (holder && !seenDrafts.has(holder)) { seenDrafts.add(holder); resetSearch(`set:${widget.id}`); }
  const place = normalizePlace(draft.location);
  const auto = resolveUnit('auto', locale());
  const show = { ...defaults().show, ...(draft.show || {}) };
  return html`<div class="w-weather-settings">
    ${field({ label: 'Place', control: html`
      ${place ? html`<div class="w-weather-current-place">
        ${icon(place.source === 'device' ? 'navigation-2' : 'map-pin', { size: 16 })}
        <span class="w-weather-current-name"><strong>${place.name}</strong>${[place.admin, place.country].filter(Boolean).length ? html`<span>${[place.admin, place.country].filter(Boolean).join(', ')}</span>` : ''}</span>
      </div>` : ''}
      ${renderPlacePicker(`set:${widget.id}`, { widgetId: widget.id, autofocus: !place, invalid: env?.errors?.location || '' })}` })}
    ${field({ label: 'Units', control: segmented({ name: 'units', value: draft.units || 'auto', action: 'dashboard.draft-set', ariaLabel: 'Units',
      options: [{ value: 'auto', label: `Automatic (°${unitLabel(auto)})` }, { value: 'f', label: '°F, mph' }, { value: 'c', label: '°C, km/h' }] }) })}
    <div class="dash-settings-toggle">${switchToggle({ checked: show.hourly, label: 'Show the next hours', description: 'Appears when the widget is at least three rows tall.',
      action: 'dashboard.draft', data: { name: 'show.hourly', type: 'boolean' } })}</div>
    <div class="dash-settings-toggle">${switchToggle({ checked: show.daily, label: 'Show the 7-day forecast', description: 'Appears when the widget is tall enough.',
      action: 'dashboard.draft', data: { name: 'show.daily', type: 'boolean' } })}</div>
    <div class="dash-settings-toggle">${switchToggle({ checked: show.details, label: 'Show wind, humidity, sunrise and sunset', action: 'dashboard.draft', data: { name: 'show.details', type: 'boolean' } })}</div>
    <p class="w-weather-attribution">${icon('info', { size: 14 })}<span>Forecasts come from <a href="${ATTRIBUTION.href}" target="_blank" rel="noopener noreferrer">Open-Meteo.com</a> (CC BY 4.0).
      Only the place’s coordinates are sent.</span></p>
  </div>`;
}

function refreshWidget(ctx, widgetId) {
  const found = findWidget(widgetId);
  const config = found && configOf(found.widget);
  if (!config?.location) return undefined;
  return refresh(ctx, config.location, resolveUnit(config.units, locale()), { force: true });
}

registerActions({
  'w.weather.refresh': ({ ctx, data }) => refreshWidget(ctx, data.widget),
  'w.weather.allow': ({ ctx, data }) => {
    const asked = requestOrigins(WEATHER_ORIGINS); // during the gesture
    return asked.then(granted => {
      if (!granted) { ctx.toast('Still can’t load the weather without access to open-meteo.com.', { tone: 'warning' }); return undefined; }
      return refreshWidget(ctx, data.widget);
    });
  },
});

// ------------------------------------------------------------------ header chip

/**
 * Compact current weather for the dashboard header ("☁ 66°F Aurora · Partly cloudy") from the first weather widget
 * on the active board, from cached data only. '' when there is none.
 */
export function renderWeatherChip() {
  const board = activeBoard();
  const widget = board?.widgets.find(w => w.type === 'weather' && normalizePlace(w.config?.location));
  if (!widget) return '';
  const config = configOf(widget);
  const unit = resolveUnit(config.units, locale());
  const entry = readCache(weatherCacheKey(config.location, unit));
  const current = entry?.value?.current;
  if (!current) return '';
  const condition = weatherCondition(current.code, current.isDay);
  const temp = formatTemp(current.temp);
  return html`<span class="w-weather-chip" data-tint="${condition.tint}" title="${placeLabel(config.location, { detail: true })} · ${updatedLabel(entry.at)}">
    ${glyph(condition, 16, 'is-chip')}<span class="w-weather-chip-temp">${temp}${unitLabel(unit)}</span>
    <span class="w-weather-chip-text">${placeLabel(config.location)} · ${condition.label}</span></span>`;
}

// ------------------------------------------------------------------ definition

defineWidget({
  type: 'weather',
  title: 'Weather',
  description: 'Current conditions, the next hours and the week ahead for a place.',
  icon: 'cloud-sun',
  category: 'info',
  keywords: ['forecast', 'temperature', 'rain', 'sun', 'climate', 'open-meteo'],
  size: { w: 3, h: 2, minW: 2, minH: 2, maxW: 12, maxH: 8 },
  presets: { S: { w: 2, h: 2 }, M: { w: 3, h: 2 }, L: { w: 6, h: 3 }, XL: { w: 6, h: 5 } },
  permissions: { origins: [...WEATHER_ORIGINS] },
  defaults,
  displayTitle: (ctx, widget) => placeLabel(configOf(widget).location),
  needsSetup: config => !normalizePlace(config?.location),
  render,
  headerActions,
  menu,
  renderSettings,
  settingsSize: 'md',
  validateSettings: draft => (normalizePlace(draft.location) ? null : { location: 'Choose a place for the weather.' }),
  onSettingsSave: (ctx, widget, draft) => {
    resetSearch(`set:${widget.id}`);
    const show = { ...defaults().show, ...(draft.show || {}) };
    return { ...draft, location: normalizePlace(draft.location), units: ['auto', 'f', 'c'].includes(draft.units) ? draft.units : 'auto', show };
  },
});
