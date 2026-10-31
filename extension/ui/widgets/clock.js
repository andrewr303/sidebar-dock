// Clock widget: a large digital clock, an analog face or a minimal time, with the date, an optional greeting and
// world clocks (offset from local time, day or night). Time moves without re-rendering the app: a shared ticker
// updates each clock's own text nodes every second (or every minute without seconds), and analog hands turn with
// Web Animations that are re-synced each minute and whenever the tab becomes visible.
import { html, cx, raw } from '../html.js';
import { icon } from '../icons.js';
import { segmented, switchToggle, field, iconButton } from '../components.js';
import { registerActions, registerMount } from '../runtime.js';
import { defineWidget, getSettingsDraft } from '../dashboard/registry.js';
import { findWidget, updateWidgetConfig } from '../../lib/dashboard-store.js';
import { settingsGroup } from '../../lib/settings-schema.js';
import { greetingFor } from '../dashboard/state.js';
import {
  clockParts, dateLine, relativeOffset, formatOffset, offsetSentence, dayRelation, relationLabel, isDaytime, normalizeZones, searchZones,
  zoneCity, aliasLabel, handAngles, localeUses12h,
} from './clock/time.js';

const STYLES = [{ value: 'digital', label: 'Digital', icon: 'clock' }, { value: 'analog', label: 'Analog', icon: 'watch' }, { value: 'minimal', label: 'Minimal', icon: 'minus' }];
const defaults = () => ({ style: 'digital', hour12: 'auto', seconds: false, showDate: true, greeting: true, zones: [] });
const configOf = widget => {
  const config = { ...defaults(), ...(widget?.config || {}) };
  if (!STYLES.some(s => s.value === config.style)) config.style = 'digital';
  if (![true, false, 'auto'].includes(config.hour12)) config.hour12 = 'auto';
  config.zones = normalizeZones(config.zones);
  return config;
};
const locale = () => globalThis.navigator?.language || undefined;
const MAX_ZONES = 12;

/** The greeting for the clock, unless the dashboard header already greets (then it would say the same thing twice). */
function greetingText(ctx, config) {
  if (!config.greeting) return '';
  const settings = ctx.library?.settings || {};
  const tab = settingsGroup(settings, 'newTab');
  const dash = settingsGroup(settings, 'dashboard');
  if (ctx.state.view === 'dashboard' && tab.greeting && dash.header !== false) return '';
  const name = String(tab.name || '').trim();
  return `${greetingFor()}${name ? `, ${name}` : ''}`;
}

// ------------------------------------------------------------------ rendering

function timeMarkup(parts, { seconds }) {
  return html`<span class="w-clock-hm" data-clock="hm">${parts.hm}</span>${seconds ? html`<span class="w-clock-sec" data-clock="sec">${parts.sep}${parts.sec}</span>` : ''}${parts.period
    ? html`<span class="w-clock-period" data-clock="period">${parts.period}</span>` : ''}`;
}

function faceMarkup(now, seconds) {
  const angles = handAngles(now);
  const ticks = [];
  for (let i = 0; i < 60; i++) {
    const hour = i % 5 === 0;
    ticks.push(raw(`<line class="w-clock-tick${hour ? ' is-hour' : ''}" x1="50" y1="${hour ? 5.5 : 5.5}" x2="50" y2="${hour ? 11 : 8}" transform="rotate(${i * 6} 50 50)"/>`));
  }
  const hand = (name, angle, y1, y2) => raw(`<line class="w-clock-hand is-${name}" data-hand="${name}" x1="50" y1="${y1}" x2="50" y2="${y2}" style="rotate:${angle.toFixed(2)}deg"/>`);
  return html`<svg class="w-clock-face" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
    <circle class="w-clock-dial" cx="50" cy="50" r="48.5"/>
    ${ticks}
    ${hand('hour', angles.hour, 54, 27)}${hand('minute', angles.minute, 55, 13)}${seconds ? hand('second', angles.second, 60, 9) : ''}
    <circle class="w-clock-pin" cx="50" cy="50" r="${seconds ? 2.2 : 2.6}"/>
  </svg>`;
}

function zoneRow(zone, now, config) {
  const parts = clockParts(now, { hour12: config.hour12, timeZone: zone.tz, locale: locale() });
  const offset = relativeOffset(now, zone.tz);
  const relation = dayRelation(now, zone.tz);
  const day = isDaytime(parts.hour);
  const meta = `${relation ? `${relationLabel(relation)} · ` : ''}${formatOffset(offset)}`;
  return html`<li class="w-clock-zone" data-key="${zone.id}" data-tz="${zone.tz}" data-daylight="${day ? 'day' : 'night'}" title="${zone.tz.replace(/_/g, ' ')}">
    <span class="w-clock-zone-sky" aria-hidden="true">${icon('sun', { size: 14, className: 'is-day' })}${icon('moon', { size: 14, className: 'is-night' })}</span>
    <span class="w-clock-zone-text">
      <span class="w-clock-zone-name">${zone.label}</span>
      <span class="w-clock-zone-meta" data-clock="zone-meta">${meta}</span>
    </span>
    <span class="w-clock-zone-time" data-clock="zone-time">${parts.hm}${parts.period ? html`<span class="w-clock-zone-period">${parts.period}</span>` : ''}</span>
    <span class="sr-only" data-clock="zone-label">${zone.label}: ${parts.label}, ${day ? 'daytime' : 'night'}, ${relation ? `${relationLabel(relation).toLowerCase()}, ` : ''}${offsetSentence(offset)}</span>
  </li>`;
}

function render(ctx, widget, env) {
  const config = configOf(widget);
  const now = new Date();
  const parts = clockParts(now, { hour12: config.hour12, locale: locale() });
  const greeting = config.style === 'minimal' ? '' : greetingText(ctx, config);
  const showDate = config.showDate && config.style !== 'minimal';
  const zones = config.zones;
  const seconds = !!config.seconds;
  return html`<div class="${cx('w-clock', zones.length && 'has-zones', greeting && 'has-greeting', showDate && 'has-date')}" data-style="${config.style}"
    data-mount="w.clock.tick" data-key="clock-${widget.id}" data-widget="${widget.id}" data-hour12="${String(config.hour12)}" data-seconds="${seconds ? 'true' : 'false'}">
    <div class="w-clock-main">
      ${greeting ? html`<p class="w-clock-greeting" data-clock="greeting">${greeting}</p>` : ''}
      ${config.style === 'analog'
        ? html`<div class="w-clock-analog" role="img" aria-label="${parts.label}" data-clock="analog">${faceMarkup(now, seconds)}</div>`
        : html`<p class="w-clock-time"><time data-clock="time" datetime="${now.toISOString()}">${timeMarkup(parts, { seconds })}</time></p>`}
      ${showDate ? html`<p class="w-clock-date" data-clock="date">${dateLine(now, { locale: locale() })}</p>` : ''}
    </div>
    ${zones.length ? html`<ul class="w-clock-zones" aria-label="World clocks">${zones.map(zone => zoneRow(zone, now, config))}</ul>` : ''}
  </div>`;
}

// ------------------------------------------------------------------ ticking

const reducedMotion = () => (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) || document.documentElement.dataset.motion === 'reduced';
const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
const PERIODS = { hour: 43_200_000, minute: 3_600_000, second: 60_000 };

/** Updates one clock's text nodes, zone rows and hands to `now`. */
function paint(el, now = new Date()) {
  const hour12 = el.dataset.hour12 === 'true' ? true : el.dataset.hour12 === 'false' ? false : 'auto';
  const parts = clockParts(now, { hour12, locale: locale() });
  setText(el.querySelector('[data-clock="hm"]'), parts.hm);
  setText(el.querySelector('[data-clock="sec"]'), `${parts.sep}${parts.sec}`);
  setText(el.querySelector('[data-clock="period"]'), parts.period);
  const time = el.querySelector('time[data-clock="time"]');
  if (time) time.setAttribute('datetime', now.toISOString());
  const analog = el.querySelector('[data-clock="analog"]');
  if (analog && analog.getAttribute('aria-label') !== parts.label) analog.setAttribute('aria-label', parts.label);
  setText(el.querySelector('[data-clock="date"]'), dateLine(now, { locale: locale() }));
  const greeting = el.querySelector('[data-clock="greeting"]');
  if (greeting) setText(greeting, greeting.textContent.replace(/^Good (morning|afternoon|evening|night)/, greetingFor(now)));
  for (const row of el.querySelectorAll('.w-clock-zone')) {
    const tz = row.dataset.tz;
    const zoneParts = clockParts(now, { hour12, timeZone: tz, locale: locale() });
    const timeEl = row.querySelector('[data-clock="zone-time"]');
    if (timeEl && timeEl.firstChild?.nodeValue !== zoneParts.hm) {
      timeEl.firstChild.nodeValue = zoneParts.hm;
      const period = timeEl.querySelector('.w-clock-zone-period');
      if (period) setText(period, zoneParts.period);
    }
    const offset = relativeOffset(now, tz);
    const relation = dayRelation(now, tz);
    const day = isDaytime(zoneParts.hour);
    setText(row.querySelector('[data-clock="zone-meta"]'), `${relation ? `${relationLabel(relation)} · ` : ''}${formatOffset(offset)}`);
    const label = row.querySelector('.w-clock-zone-name')?.textContent || zoneCity(tz);
    setText(row.querySelector('[data-clock="zone-label"]'), `${label}: ${zoneParts.label}, ${day ? 'daytime' : 'night'}, ${relation ? `${relationLabel(relation).toLowerCase()}, ` : ''}${offsetSentence(offset)}`);
    const daylight = day ? 'day' : 'night';
    if (row.dataset.daylight !== daylight) row.dataset.daylight = daylight;
  }
  syncHands(el, now);
}

// Hands sweep with Web Animations (one turn per period) started at the current angle; with reduced motion they jump
// to the current angle on each tick instead.
const handAnimations = new WeakMap();
function syncHands(el, now) {
  const hands = el.querySelectorAll('[data-hand]');
  if (!hands.length) return;
  const angles = handAngles(now);
  const still = reducedMotion() || typeof Element.prototype.animate !== 'function';
  for (const hand of hands) {
    const name = hand.dataset.hand;
    const angle = angles[name];
    let animation = handAnimations.get(hand);
    if (still) {
      animation?.cancel();
      handAnimations.delete(hand);
      hand.style.rotate = `${angle.toFixed(2)}deg`;
      continue;
    }
    if (!animation || animation.playState === 'idle') {
      animation = hand.animate([{ rotate: '0deg' }, { rotate: '360deg' }], { duration: PERIODS[name], iterations: Infinity, easing: 'linear' });
      handAnimations.set(hand, animation);
    }
    animation.currentTime = (angle / 360) * PERIODS[name];
  }
}

const clocks = new Set();
let timer = 0;
let lastSync = 0;
function schedule() {
  clearTimeout(timer);
  if (!clocks.size) return;
  const needsSeconds = [...clocks].some(el => el.dataset.seconds === 'true' && (el.dataset.style !== 'analog' || reducedMotion()));
  const now = Date.now();
  const delay = needsSeconds ? 1000 - (now % 1000) + 8 : 60_000 - (now % 60_000) + 8;
  timer = setTimeout(tick, delay);
}
function tick() {
  const now = new Date();
  // Hands only need re-syncing once a minute (or after the tab slept); text updates every tick.
  const resync = now.getTime() - lastSync > 55_000;
  if (resync) lastSync = now.getTime();
  for (const el of clocks) {
    if (!el.isConnected) { clocks.delete(el); continue; }
    if (resync || el.dataset.style !== 'analog' || reducedMotion()) paint(el, now);
  }
  schedule();
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (!document.hidden && clocks.size) { lastSync = 0; tick(); } });
}

registerMount('w.clock.tick', el => {
  clocks.add(el);
  lastSync = 0;
  paint(el);
  schedule();
  return {
    // A re-render may replace the hands (style or seconds changed): start them again from the current time.
    update() { paint(el); schedule(); },
    destroy() { clocks.delete(el); schedule(); },
  };
});

// ------------------------------------------------------------------ settings

const zoneSearch = new Map(); // widgetId -> query
const seenDrafts = new WeakSet();

function renderZoneEditor(ctx, widget, zones) {
  const query = zoneSearch.get(widget.id) || '';
  const now = new Date();
  const taken = new Set(zones.map(z => z.tz));
  const results = searchZones(query, { date: now, limit: 8 }).filter(r => !taken.has(r.tz) || r.alias);
  const full = zones.length >= MAX_ZONES;
  const listId = `w-clock-zones-${widget.id}`;
  return html`<div class="w-clock-zone-editor">
    ${zones.length ? html`<ol class="w-clock-zone-list" id="${listId}" aria-label="Your time zones">${zones.map((zone, index) => {
      const parts = clockParts(now, { hour12: 'auto', timeZone: zone.tz, locale: locale() });
      return html`<li class="w-clock-zone-edit" data-key="${zone.id}">
        <label class="sr-only" for="w-clock-label-${zone.id}">Name for ${zone.tz.replace(/_/g, ' ')}</label>
        <input class="input input-sm" id="w-clock-label-${zone.id}" value="${zone.label}" placeholder="${zoneCity(zone.tz)}" maxlength="40"
          data-input="dashboard.draft" data-name="zones.${index}.label" autocomplete="off">
        <span class="w-clock-zone-edit-meta">${parts.label} · ${formatOffset(relativeOffset(now, zone.tz))}</span>
        <span class="w-clock-zone-edit-tools">
          ${iconButton({ icon: 'arrow-up', label: `Move ${zone.label} up`, size: 'sm', action: 'w.clock.zone-move', disabled: index === 0, data: { index, dir: -1 } })}
          ${iconButton({ icon: 'arrow-down', label: `Move ${zone.label} down`, size: 'sm', action: 'w.clock.zone-move', disabled: index === zones.length - 1, data: { index, dir: 1 } })}
          ${iconButton({ icon: 'x', label: `Remove ${zone.label}`, size: 'sm', action: 'w.clock.zone-remove', data: { index } })}
        </span>
      </li>`;
    })}</ol>` : html`<p class="w-clock-zone-empty">No world clocks yet. Add cities to see their time beside yours.</p>`}
    ${full ? html`<p class="field-hint">You can show up to ${MAX_ZONES} time zones.</p>` : html`
      <div class="w-clock-zone-add">
        <label class="sr-only" for="w-clock-zone-q-${widget.id}">Search time zones</label>
        <span class="input-wrap">${icon('search', { size: 16, className: 'input-icon' })}<input class="input has-icon" id="w-clock-zone-q-${widget.id}" type="search" value="${query}"
          placeholder="Add a city or time zone (Tokyo, PST, +5:30)" data-input="w.clock.zone-query" data-keydown="w.clock.zone-key" data-widget="${widget.id}"
          aria-controls="w-clock-zone-results-${widget.id}" autocomplete="off" spellcheck="false"></span>
        <ul class="w-clock-zone-results" id="w-clock-zone-results-${widget.id}" aria-label="${query ? 'Matching time zones' : 'Popular time zones'}">
          ${results.length ? results.map(result => html`<li><button type="button" class="w-clock-zone-result" data-action="w.clock.zone-add" data-tz="${result.tz}"
            data-label="${aliasLabel(result.alias, result.tz)}" data-widget="${widget.id}">
            ${icon('plus', { size: 14 })}<span class="w-clock-zone-result-name">${result.alias ? `${result.alias}` : result.label}</span>
            <span class="w-clock-zone-result-meta">${result.alias ? zoneCity(result.tz) : result.region}${result.region || result.alias ? ' · ' : ''}${result.gmt}</span>
          </button></li>`) : html`<li class="w-clock-zone-none">No time zones match “${query}”.</li>`}
        </ul>
      </div>`}
  </div>`;
}

function renderSettings(ctx, widget, draft) {
  const holder = getSettingsDraft();
  if (holder && !seenDrafts.has(holder)) { seenDrafts.add(holder); zoneSearch.delete(widget.id); }
  const config = { ...defaults(), ...draft };
  const zones = normalizeZones(draft.zones);
  const twelve = localeUses12h(locale());
  return html`<div class="w-clock-settings">
    ${field({ label: 'Style', control: segmented({ name: 'style', value: config.style, options: STYLES, action: 'w.clock.set', ariaLabel: 'Clock style' }) })}
    ${field({ label: 'Hours', control: segmented({ name: 'hour12', value: String(config.hour12), action: 'w.clock.set', ariaLabel: 'Hours',
      options: [{ value: 'auto', label: `Automatic (${twelve ? '12-hour' : '24-hour'})` }, { value: 'true', label: '12-hour' }, { value: 'false', label: '24-hour' }] }) })}
    <div class="dash-settings-toggle">${switchToggle({ checked: !!config.seconds, label: 'Show seconds', action: 'dashboard.draft', data: { name: 'seconds', type: 'boolean' } })}</div>
    <div class="dash-settings-toggle">${switchToggle({ checked: config.showDate !== false, label: 'Show the date', description: 'Not shown with the minimal style.',
      action: 'dashboard.draft', data: { name: 'showDate', type: 'boolean' } })}</div>
    <div class="dash-settings-toggle">${switchToggle({ checked: config.greeting !== false, label: 'Show a greeting',
      description: 'Shown when the dashboard header is not greeting you already.', action: 'dashboard.draft', data: { name: 'greeting', type: 'boolean' } })}</div>
    ${field({ label: 'World clocks', hint: 'They appear when the widget is at least four columns wide or three rows tall.', control: renderZoneEditor(ctx, widget, zones) })}
  </div>`;
}

function menu(ctx, widget) {
  const config = configOf(widget);
  return [
    { heading: 'Style' },
    ...STYLES.map(style => ({ label: style.label, checked: config.style === style.value, run: () => updateWidgetConfig(widget.id, { style: style.value }) })),
    { separator: true },
    { label: config.seconds ? 'Hide seconds' : 'Show seconds', icon: 'timer', run: () => updateWidgetConfig(widget.id, { seconds: !config.seconds }) },
    { label: 'Add a time zone…', icon: 'globe', run: () => ctx.dispatch('dashboard.widget-settings', { data: { widget: widget.id } }) },
  ];
}

function setDraftZones(mutate) {
  const holder = getSettingsDraft();
  if (!holder) return;
  const zones = normalizeZones(holder.draft.zones);
  mutate(zones);
  holder.set({ zones });
}

registerActions({
  'w.clock.set': ({ data }) => {
    const value = data.value === 'true' ? true : data.value === 'false' ? false : data.value;
    getSettingsDraft()?.set({ [data.name]: value });
  },
  'w.clock.zone-query': ({ ctx, el }) => { zoneSearch.set(el.dataset.widget, el.value); ctx.render(); },
  'w.clock.zone-key': ({ el, event }) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (el.value.trim()) el.closest('.w-clock-zone-add')?.querySelector('.w-clock-zone-result')?.click();
  },
  'w.clock.zone-add': ({ ctx, data }) => {
    setDraftZones(zones => {
      if (zones.length >= MAX_ZONES) return;
      zones.push({ id: `z${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, label: data.label || zoneCity(data.tz), tz: data.tz });
    });
    zoneSearch.set(data.widget, '');
    // The search box keeps focus, so the re-render leaves its text alone: clear it here.
    const box = document.getElementById(`w-clock-zone-q-${data.widget}`);
    if (box) box.value = '';
    ctx.nextFrame(() => document.getElementById(`w-clock-zone-q-${data.widget}`)?.focus());
  },
  'w.clock.zone-remove': ({ data }) => setDraftZones(zones => { zones.splice(Number(data.index), 1); }),
  'w.clock.zone-move': ({ data }) => setDraftZones(zones => {
    const from = Number(data.index);
    const to = from + Number(data.dir);
    if (to < 0 || to >= zones.length) return;
    [zones[from], zones[to]] = [zones[to], zones[from]];
  }),
});

defineWidget({
  type: 'clock',
  title: 'Clock',
  description: 'The time and date, digital or analog, with world clocks.',
  icon: 'clock',
  category: 'info',
  keywords: ['time', 'date', 'world clock', 'time zone', 'analog', 'greeting'],
  size: { w: 3, h: 2, minW: 2, minH: 2, maxW: 12, maxH: 8 },
  presets: { S: { w: 2, h: 2 }, M: { w: 3, h: 2 }, L: { w: 4, h: 3 }, XL: { w: 6, h: 4 } },
  // New clocks start without a title bar: the time speaks for itself (the dashboard applies this when it supports it).
  style: { hideTitle: true },
  defaults,
  render,
  menu,
  renderSettings,
  settingsSize: 'md',
  onSettingsSave: (ctx, widget, draft) => {
    zoneSearch.delete(widget.id);
    const config = { ...defaults(), ...draft };
    return {
      style: STYLES.some(s => s.value === config.style) ? config.style : 'digital',
      hour12: [true, false, 'auto'].includes(config.hour12) ? config.hour12 : 'auto',
      seconds: !!config.seconds,
      showDate: config.showDate !== false,
      greeting: config.greeting !== false,
      zones: normalizeZones(config.zones).map(zone => ({ ...zone, label: zone.label.trim() || zoneCity(zone.tz) })),
    };
  },
});
