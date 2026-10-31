// Calendar widget: a month grid with Still reminders, daily notes and optional iCal feeds, plus the selected day's
// agenda (or the days ahead on large cards). Small cards show today's date and what is next; a mini month opens a
// day menu on click. Daily notes use the same titles as Notes > Daily note (lib/notes.js dailyNoteTitle), so a day
// opens its note or creates it. The layout follows the widget body's size (styles/widgets/calendar.css).
import { html, cx, plural } from '../html.js';
import { icon } from '../icons.js';
import { button, iconButton, segmented, switchToggle, field, select } from '../components.js';
import { registerActions, registerMount } from '../runtime.js';
import { defineWidget, getSettingsDraft } from '../dashboard/registry.js';
import { findWidget, getDashboard } from '../../lib/dashboard-store.js';
import { requestOrigins } from '../../lib/permissions.js';
import { onAccountsChanged } from '../../lib/accounts.js';
import { dailyNoteTitle, noteTemplates } from '../../lib/notes.js';
import { expandEvents, normalizeFeedUrl } from '../../lib/ics.js';
import { openNote } from '../note-editor.js';
import { createNote } from '../notes.js';
import { dayKey, fromKey, addDays, addMonths, weekStartFor, monthGrid, isoWeek, weekdayNames, bucketByDay, keyDelta } from './calendar/month.js';
import {
  FEED_COLORS, feedCacheKey, hostOf, cachedFeed, cachedAt, feedState, refreshFeed, storeFeedUrls, forgetFeedUrls, fetchFeed,
} from './calendar/feeds.js';
import { writeCache } from '../../lib/widget-cache.js';
import './weather/icons.js';

const defaults = () => ({ weekStart: 'auto', reminders: true, dailyNotes: true, weekNumbers: false, feeds: [] });
// A feed's origin (scheme and host, not secret) lets "Allow access" ask Chrome inside the click; the address itself stays
// in device storage (calendar/feeds.js).
const cleanFeeds = list => (Array.isArray(list) ? list : []).filter(f => f && typeof f.id === 'string' && f.id).slice(0, 12).map((f, index) => ({
  id: f.id.slice(0, 40), name: String(f.name || '').trim().slice(0, 60) || f.host || 'Calendar',
  color: FEED_COLORS.includes(f.color) ? f.color : FEED_COLORS[index % FEED_COLORS.length], host: String(f.host || '').slice(0, 120),
  origin: /^https?:\/\/[^/\s]+$/.test(String(f.origin || '')) ? f.origin : f.host ? `https://${f.host}` : '',
}));
const configOf = widget => {
  const config = { ...defaults(), ...(widget?.config || {}) };
  if (!['auto', 'sunday', 'monday'].includes(config.weekStart)) config.weekStart = 'auto';
  config.feeds = cleanFeeds(config.feeds);
  return config;
};
const locale = () => globalThis.navigator?.language || undefined;
const AGENDA_DAYS = 14;

// ------------------------------------------------------------------ formatting

const formats = new Map();
const fmt = options => {
  const key = JSON.stringify(options);
  if (!formats.has(key)) formats.set(key, new Intl.DateTimeFormat(locale(), options));
  return formats.get(key);
};
const monthLabel = (year, month) => fmt({ month: 'long', year: 'numeric' }).format(new Date(year, month, 1));
const longDate = date => fmt({ weekday: 'long', month: 'long', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }).format(date);
const shortDay = date => fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(date);
const timeOf = ms => fmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
function dayHeading(date, today = new Date()) {
  const diff = Math.round((fromKey(dayKey(date)) - fromKey(dayKey(today))) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return shortDay(date);
}
function whenLabel(entry, day) {
  if (entry.allDay) return 'All day';
  const startsToday = dayKey(new Date(entry.start)) === day;
  const endsToday = dayKey(new Date(entry.end - 1)) === day;
  if (entry.kind === 'reminder' || entry.end <= entry.start) return timeOf(entry.start);
  if (!startsToday && !endsToday) return 'All day';
  if (!startsToday) return `Until ${timeOf(entry.end)}`;
  return `${timeOf(entry.start)}–${timeOf(entry.end)}`;
}

// Daily note titles per day key (Intl formatting is the slow part of a render, so it is remembered).
const titleCache = new Map();
const dailyTitle = key => {
  if (!titleCache.has(key)) { if (titleCache.size > 800) titleCache.clear(); titleCache.set(key, dailyNoteTitle(fromKey(key))); }
  return titleCache.get(key);
};

// ------------------------------------------------------------------ data

/** Live daily notes by title (newest wins). */
let notesMemo = { stamp: null, map: new Map() };
function dailyNotes(ctx) {
  const stamp = ctx.library?.updatedAt;
  if (notesMemo.stamp !== stamp || !ctx.library) {
    const map = new Map();
    for (const item of ctx.select.live()) {
      if (item.type !== 'note' || item.sticky || !item.title) continue;
      const previous = map.get(item.title);
      if (!previous || String(item.updatedAt) > String(previous.updatedAt)) map.set(item.title, item);
    }
    notesMemo = { stamp, map };
  }
  return notesMemo.map;
}

function reminderEntries(ctx) {
  const out = [];
  for (const item of ctx.select.live()) {
    const start = Date.parse(item.reminderAt || '');
    if (!Number.isFinite(start)) continue;
    out.push({ kind: 'reminder', key: `r:${item.id}`, id: item.id, type: item.type, title: item.title || (item.type === 'note' ? 'Untitled note' : 'Untitled item'),
      start, end: start, allDay: false, done: !!item.reminderNotifiedAt, color: 'amber' });
  }
  return out;
}

function eventEntries(config, from, to) {
  const out = [];
  for (const feed of config.feeds) {
    const data = cachedFeed(feed.id);
    if (!data?.events) continue;
    for (const occurrence of expandEvents(data.events, from, to)) {
      out.push({ ...occurrence, kind: 'event', key: `e:${feed.id}:${occurrence.key}`, title: occurrence.summary, color: feed.color, feed: feed.id, feedName: feed.name });
    }
  }
  return out;
}

/** Entries by day key for [first, last] (Dates) and the daily note of each day: { byDay, notes }. Memoized per widget and range. */
const dataMemo = new Map();
function dataFor(ctx, widget, config, first, last) {
  const from = first.getTime();
  const to = addDays(last, 1).getTime();
  const memoKey = `${widget.id}|${from}|${to}`;
  const stamp = [ctx.library?.updatedAt, config.reminders, config.dailyNotes, ...config.feeds.map(f => `${f.id}:${f.color}:${cachedAt(f.id)}`)].join('|');
  const memo = dataMemo.get(memoKey);
  if (memo?.stamp === stamp) return memo.value;
  if (dataMemo.size > 40) dataMemo.clear();
  const entries = [...(config.reminders ? reminderEntries(ctx) : []), ...eventEntries(config, from, to)].filter(e => e.end >= from && e.start < to);
  const byDay = bucketByDay(entries, first, last);
  const notes = new Map();
  if (config.dailyNotes) {
    const titles = dailyNotes(ctx);
    for (let day = first; day <= last; day = addDays(day, 1)) {
      const note = titles.get(dailyTitle(dayKey(day)));
      if (note) notes.set(dayKey(day), note);
    }
  }
  const value = { byDay, notes };
  dataMemo.set(memoKey, { stamp, value });
  return value;
}

// ------------------------------------------------------------------ view state

const views = new Map(); // widgetId -> { year, month, selected }
function viewOf(widgetId) {
  if (!views.has(widgetId)) {
    const now = new Date();
    views.set(widgetId, { year: now.getFullYear(), month: now.getMonth(), selected: dayKey(now) });
  }
  return views.get(widgetId);
}
function selectDay(widgetId, key) {
  const view = viewOf(widgetId);
  const date = fromKey(key);
  Object.assign(view, { selected: key, year: date.getFullYear(), month: date.getMonth() });
}

// ------------------------------------------------------------------ rendering

const dot = color => html`<span class="w-calendar-dot" data-color="${color}"></span>`;

function dayCell(widget, cell, data, view) {
  const entries = data.byDay.get(cell.key) || [];
  const note = data.notes.get(cell.key);
  const selected = cell.key === view.selected;
  const colors = [...(note ? ['note'] : []), ...new Set(entries.map(e => e.color))].slice(0, 3);
  const label = `${longDate(cell.date)}${cell.today ? ', today' : ''}${entries.length ? `, ${plural(entries.length, 'event')}` : ''}${note ? ', daily note' : ''}`;
  return html`<div role="gridcell" class="w-calendar-cell" aria-selected="${selected ? 'true' : 'false'}" data-key="${cell.key}">
    <button type="button" class="${cx('w-calendar-day', !cell.inMonth && 'is-outside', cell.weekend && 'is-weekend', cell.today && 'is-today', selected && 'is-selected')}"
      tabindex="${selected ? '0' : '-1'}" data-action="w.calendar.day" data-widget="${widget.id}" data-day="${cell.key}" aria-label="${label}"
      ${cell.today ? html`aria-current="date"` : ''}>
      <span class="w-calendar-num">${cell.day}</span>
      <span class="w-calendar-dots" aria-hidden="true">${colors.map(dot)}</span>
    </button>
  </div>`;
}

function renderMonth(widget, config, data, view, weeks, weekStart) {
  const names = weekdayNames(weekStart, locale());
  const titleId = `w-calendar-title-${widget.id}`;
  return html`<div class="w-calendar-month">
    <div class="w-calendar-nav">
      <h3 class="w-calendar-title" id="${titleId}" aria-live="polite">${monthLabel(view.year, view.month)}</h3>
      <div class="w-calendar-nav-buttons">
        ${iconButton({ icon: 'chevron-left', label: 'Previous month', size: 'sm', action: 'w.calendar.page', data: { widget: widget.id, delta: -1 }, className: 'w-calendar-prev' })}
        <button type="button" class="w-calendar-today-btn" data-action="w.calendar.today" data-widget="${widget.id}" aria-label="Go to today">Today</button>
        ${iconButton({ icon: 'chevron-right', label: 'Next month', size: 'sm', action: 'w.calendar.page', data: { widget: widget.id, delta: 1 }, className: 'w-calendar-next' })}
      </div>
    </div>
    <div class="${cx('w-calendar-grid', config.weekNumbers && 'has-weeks')}" role="grid" aria-labelledby="${titleId}" data-keydown="w.calendar.key" data-widget="${widget.id}">
      <div role="row" class="w-calendar-row is-head">
        ${config.weekNumbers ? html`<div role="columnheader" class="w-calendar-weekno is-head"><span aria-hidden="true">#</span><span class="sr-only">Week</span></div>` : ''}
        ${names.map(name => html`<div role="columnheader" class="${cx('w-calendar-weekday', name.weekend && 'is-weekend')}" title="${name.long}">
          <span aria-hidden="true">${name.short}</span><span class="sr-only">${name.long}</span></div>`)}
      </div>
      ${weeks.map(week => html`<div role="row" class="w-calendar-row" data-key="${week[0].key}">
        ${config.weekNumbers ? html`<div role="rowheader" class="w-calendar-weekno"><span class="sr-only">Week </span>${isoWeek(week[3].date)}</div>` : ''}
        ${week.map(cell => dayCell(widget, cell, data, view))}
      </div>`)}
    </div>
  </div>`;
}

function entryRow(entry, day, widget) {
  const when = whenLabel(entry, day);
  if (entry.kind === 'reminder') {
    return html`<li class="${cx('w-calendar-entry', entry.done && 'is-done')}" data-key="${entry.key}" data-kind="reminder">
      <button type="button" class="w-calendar-entry-main" data-action="w.calendar.open-item" data-id="${entry.id}" data-type="${entry.type}">
        <span class="w-calendar-entry-mark" data-color="amber" aria-hidden="true">${icon(entry.done ? 'bell-off' : 'bell', { size: 12 })}</span>
        <span class="w-calendar-entry-when">${when}</span>
        <span class="w-calendar-entry-title">${entry.title}</span>
        <span class="sr-only">, reminder${entry.done ? ', already sent' : ''}</span>
      </button>
    </li>`;
  }
  const link = entry.url || '';
  const main = html`<span class="w-calendar-entry-mark" data-color="${entry.color}" aria-hidden="true"></span>
    <span class="w-calendar-entry-when">${when}</span>
    <span class="w-calendar-entry-title">${entry.title}</span>
    ${entry.location && !/^https?:\/\//.test(entry.location) ? html`<span class="w-calendar-entry-place">${entry.location}</span>` : ''}
    <span class="sr-only">, ${entry.feedName}</span>`;
  return html`<li class="w-calendar-entry" data-key="${entry.key}" data-kind="event" title="${entry.feedName}${entry.location ? ` · ${entry.location}` : ''}">
    ${link ? html`<a class="w-calendar-entry-main" href="${link}" target="_blank" rel="noopener noreferrer">${main}</a>` : html`<div class="w-calendar-entry-main is-static">${main}</div>`}
    ${entry.meetingUrl ? html`<a class="w-calendar-join" href="${entry.meetingUrl}" target="_blank" rel="noopener noreferrer" aria-label="Join the call for ${entry.title}">
      ${icon('video', { size: 14 })}<span>Join</span></a>` : ''}
  </li>`;
}

function noteRow(note) {
  const excerpt = String(note.excerpt || '').trim();
  return html`<li class="w-calendar-entry" data-key="note-${note.id}" data-kind="note">
    <button type="button" class="w-calendar-entry-main" data-action="w.calendar.open-note" data-id="${note.id}" title="Open ${note.title}">
      <span class="w-calendar-entry-mark" data-color="note" aria-hidden="true">${icon('notebook-pen', { size: 12 })}</span>
      <span class="w-calendar-entry-title">Daily note</span>
      <span class="w-calendar-entry-when">${excerpt || 'Open the note for this day'}</span>
    </button>
  </li>`;
}

function dayBlock(widget, config, data, key, { selected = false, today }) {
  const entries = data.byDay.get(key) || [];
  const note = data.notes.get(key);
  const date = fromKey(key);
  const headingId = `w-calendar-day-${widget.id}-${key}`;
  return html`<section class="${cx('w-calendar-agenda-day', selected && 'is-selected')}" data-key="${key}" aria-labelledby="${headingId}">
    <h4 class="w-calendar-agenda-head" id="${headingId}"><span>${dayHeading(date, today)}</span>${dayHeading(date, today) !== shortDay(date) ? html`<span class="w-calendar-agenda-date">${shortDay(date)}</span>` : ''}</h4>
    ${note || entries.length ? html`<ul class="w-calendar-entries">${note ? noteRow(note) : ''}${entries.map(entry => entryRow(entry, key, widget))}</ul>` : ''}
    ${selected && !entries.length && !note ? html`<p class="w-calendar-empty">Nothing planned.</p>` : ''}
    ${selected && config.dailyNotes && !note ? html`<button type="button" class="w-calendar-create" data-action="w.calendar.create-note" data-day="${key}">
      ${icon('plus', { size: 14 })}<span>Create note for this day</span></button>` : ''}
  </section>`;
}

const upcomingOf = env => env.size === 'l' || env.size === 'xl';

function renderAgenda(widget, config, view, env, today, data) {
  const upcoming = upcomingOf(env);
  const start = fromKey(view.selected);
  const end = addDays(start, upcoming ? AGENDA_DAYS - 1 : 0);
  const days = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const key = dayKey(day);
    if (key === view.selected || data.byDay.has(key) || data.notes.has(key)) days.push(key);
  }
  return html`<div class="${cx('w-calendar-agenda', upcoming && 'is-upcoming')}" aria-label="${upcoming ? 'Agenda' : 'Selected day'}" role="region">
    ${days.map(key => dayBlock(widget, config, data, key, { selected: key === view.selected, today }))}
    ${upcoming && days.length === 1 && !(data.byDay.get(view.selected) || []).length ? html`<p class="w-calendar-empty is-soft">Nothing else in the next two weeks.</p>` : ''}
  </div>`;
}

function renderTodayTile(widget, today, data) {
  const key = dayKey(today);
  const now = Date.now();
  const next = [...(data.byDay.get(key) || []), ...(data.byDay.get(dayKey(addDays(today, 1))) || [])]
    .find(entry => entry.allDay ? dayKey(new Date(entry.start)) >= key : entry.end > now);
  const count = (data.byDay.get(key) || []).length;
  const nextDay = next && dayKey(new Date(Math.max(next.start, now))) !== key ? 'Tomorrow' : '';
  return html`<button type="button" class="w-calendar-tile" data-action="w.calendar.day" data-widget="${widget.id}" data-day="${key}"
    aria-label="${longDate(today)}${count ? `, ${plural(count, 'event')} today` : ''}. Show this day">
    <span class="w-calendar-tile-date">
      <span class="w-calendar-tile-weekday">${fmt({ weekday: 'long' }).format(today)}</span>
      <span class="w-calendar-tile-num">${today.getDate()}</span>
      <span class="w-calendar-tile-month">${fmt({ month: 'long' }).format(today)}</span>
    </span>
    <span class="w-calendar-tile-next">${next
      ? html`<span class="w-calendar-tile-next-when">${nextDay ? `${nextDay} · ` : ''}${whenLabel(next, dayKey(new Date(Math.max(next.start, now))))}</span><span class="w-calendar-tile-next-title">${next.title}</span>`
      : html`<span class="w-calendar-tile-next-when">${count ? plural(count, 'event') : 'Nothing planned'}</span>`}</span>
  </button>`;
}

function renderAlerts(widget, config) {
  const failing = config.feeds.map(feed => ({ feed, state: feedState(feed.id) })).filter(({ state }) => state.error && !state.promise);
  if (!failing.length) return '';
  const { feed, state } = failing[0];
  const access = state.kind === 'access';
  return html`<div class="w-calendar-alert" role="status">
    ${icon(access ? 'lock' : 'triangle-alert', { size: 14 })}
    <span class="w-calendar-alert-text" title="${state.error}"><strong>${feed.name}</strong> ${access ? 'needs access' : 'could not be loaded'}${failing.length > 1 ? ` (and ${plural(failing.length - 1, 'other')})` : ''}</span>
    ${access
      ? button({ label: `Allow access to ${feed.host || 'the calendar'}`, size: 'sm', variant: 'secondary', action: 'w.calendar.allow', data: { widget: widget.id, feed: feed.id } })
      : button({ label: 'Try again', size: 'sm', variant: 'ghost', action: 'w.calendar.refresh', data: { widget: widget.id } })}
  </div>`;
}

function render(ctx, widget, env) {
  const config = configOf(widget);
  const view = viewOf(widget.id);
  const today = new Date();
  const weekStart = weekStartFor(config.weekStart, locale());
  const weeks = monthGrid(view.year, view.month, weekStart, today);
  // One range covers the month grid, today and tomorrow (small tile) and the agenda after the selected day.
  const midnight = fromKey(dayKey(today));
  const selected = fromKey(view.selected);
  const first = new Date(Math.min(weeks[0][0].date, midnight, selected));
  const last = new Date(Math.max(weeks[5][6].date, addDays(midnight, 1), addDays(selected, upcomingOf(env) ? AGENDA_DAYS - 1 : 0)));
  const data = dataFor(ctx, widget, config, first, last);
  return html`<div class="w-calendar" data-mount="w.calendar.sync" data-key="cal-${widget.id}" data-widget="${widget.id}" data-today="${dayKey(today)}">
    <div class="w-calendar-small">${renderTodayTile(widget, today, data)}</div>
    ${renderMonth(widget, config, data, view, weeks, weekStart)}
    ${renderAgenda(widget, config, view, env, today, data)}
    ${renderAlerts(widget, config)}
  </div>`;
}

// Loads feeds in the background and re-renders when the day changes.
registerMount('w.calendar.sync', (el, ctx) => {
  let day = dayKey(new Date());
  const check = (force = false) => {
    const found = findWidget(el.dataset.widget);
    if (!found) return;
    for (const feed of configOf(found.widget).feeds) refreshFeed(feed, { force, onChange: () => ctx.render() });
  };
  queueMicrotask(() => check());
  const timer = setInterval(() => {
    const now = dayKey(new Date());
    if (now !== day) {
      // Keep following today when the person was looking at today.
      const view = views.get(el.dataset.widget);
      if (view?.selected === day) selectDay(el.dataset.widget, now);
      day = now;
      ctx.render();
    }
    if (!document.hidden) check();
  }, 60_000);
  return { update: () => queueMicrotask(() => check()), destroy: () => clearInterval(timer) };
});
onAccountsChanged(() => forgetFeedUrls());

// ------------------------------------------------------------------ actions

/** Whether this widget shows its agenda (set by container queries), so a click selects instead of opening a menu. */
const agendaVisible = el => {
  const agenda = el.closest('.w-calendar')?.querySelector('.w-calendar-agenda');
  return !!agenda && getComputedStyle(agenda).display !== 'none';
};

function openNoteById(ctx, id) {
  if (!ctx.select.byId(id)) { ctx.toast('That note is no longer in your library.', { tone: 'danger' }); return; }
  openNote(ctx, id);
}
function openItemById(ctx, id, type) {
  if (type === 'note') return openNoteById(ctx, id);
  return ctx.openItem(id);
}

async function createDailyNote(ctx, key) {
  const date = fromKey(key);
  const title = dailyNoteTitle(date);
  const existing = dailyNotes(ctx).get(title);
  if (existing) { openNoteById(ctx, existing.id); return; }
  const template = noteTemplates(date).find(entry => entry.id === 'daily');
  const fallback = ctx.library?.settings?.defaultCollectionId;
  await createNote(ctx, { title, content: template?.content || '', collectionId: fallback && ctx.select.collection(fallback) ? fallback : '', focus: 'body' });
}

function dayMenu(ctx, widget, key) {
  const config = configOf(widget);
  const date = fromKey(key);
  const data = dataFor(ctx, widget, config, date, date);
  const entries = data.byDay.get(key) || [];
  const note = data.notes.get(key);
  const items = [{ heading: longDate(date) }];
  for (const entry of entries.slice(0, 12)) {
    const when = whenLabel(entry, key);
    if (entry.kind === 'reminder') items.push({ label: entry.title, hint: when, icon: 'bell', run: () => openItemById(ctx, entry.id, entry.type) });
    else items.push({ label: entry.title, hint: when, icon: entry.meetingUrl ? 'video' : 'calendar', disabled: !entry.url && !entry.meetingUrl,
      run: () => globalThis.open?.(entry.meetingUrl || entry.url, '_blank', 'noopener') });
  }
  if (entries.length > 12) items.push({ label: `${plural(entries.length - 12, 'more event')}`, disabled: true });
  if (!entries.length) items.push({ label: 'Nothing planned', disabled: true });
  if (config.dailyNotes) {
    items.push({ separator: true });
    items.push(note ? { label: 'Open daily note', icon: 'notebook-pen', run: () => openNoteById(ctx, note.id) }
      : { label: 'Create note for this day', icon: 'plus', run: () => ctx.run(() => createDailyNote(ctx, key)) });
  }
  return items;
}

function focusDay(widgetId, key) {
  const root = document.querySelector(`.w-calendar[data-widget="${CSS.escape(widgetId)}"]`);
  root?.querySelector(`.w-calendar-day[data-day="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

registerActions({
  'w.calendar.day': ({ ctx, el, data }) => {
    const found = findWidget(data.widget);
    if (!found) return;
    selectDay(data.widget, data.day);
    ctx.render();
    if (!agendaVisible(el)) ctx.openMenu(el, dayMenu(ctx, found.widget, data.day), { placement: 'bottom-start', label: longDate(fromKey(data.day)) });
    // Picking a day in the next or previous month redraws the grid: keep focus on the chosen day.
    else if (el.classList.contains('w-calendar-day')) ctx.nextFrame(() => focusDay(data.widget, data.day));
  },
  'w.calendar.page': ({ ctx, data }) => {
    const view = viewOf(data.widget);
    const next = addMonths(view, Number(data.delta) || 0);
    const selected = fromKey(view.selected);
    const day = Math.min(selected.getDate(), new Date(next.year, next.month + 1, 0).getDate());
    Object.assign(view, next, { selected: dayKey(new Date(next.year, next.month, day)) });
    ctx.render();
  },
  'w.calendar.today': ({ ctx, data }) => {
    selectDay(data.widget, dayKey(new Date()));
    ctx.render();
    ctx.nextFrame(() => focusDay(data.widget, viewOf(data.widget).selected));
  },
  'w.calendar.key': ({ ctx, el, event }) => {
    if (!event.target.closest?.('.w-calendar-day')) return;
    const view = viewOf(el.dataset.widget);
    const current = fromKey(view.selected);
    const rtl = getComputedStyle(el).direction === 'rtl';
    let next = null;
    const delta = keyDelta(event.key, rtl);
    if (delta) next = addDays(current, delta);
    else if (event.key === 'PageUp' || event.key === 'PageDown') {
      const target = addMonths({ year: current.getFullYear(), month: current.getMonth() }, (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1));
      next = new Date(target.year, target.month, Math.min(current.getDate(), new Date(target.year, target.month + 1, 0).getDate()));
    } else if (event.key === 'Home' || event.key === 'End') {
      const found = findWidget(el.dataset.widget);
      const start = weekStartFor(configOf(found?.widget).weekStart, locale());
      const offset = (current.getDay() - start + 7) % 7;
      next = addDays(current, event.key === 'Home' ? -offset : 6 - offset);
    }
    if (!next) return;
    event.preventDefault();
    selectDay(el.dataset.widget, dayKey(next));
    ctx.render();
    ctx.nextFrame(() => focusDay(el.dataset.widget, dayKey(next)));
  },
  'w.calendar.open-note': ({ ctx, data }) => openNoteById(ctx, data.id),
  'w.calendar.open-item': ({ ctx, data }) => openItemById(ctx, data.id, data.type),
  'w.calendar.create-note': ({ ctx, data }) => createDailyNote(ctx, data.day),
  'w.calendar.refresh': ({ ctx, data }) => {
    const found = findWidget(data.widget);
    for (const feed of configOf(found?.widget).feeds) refreshFeed(feed, { force: true, onChange: () => ctx.render() });
  },
  'w.calendar.allow': ({ ctx, data }) => {
    const found = findWidget(data.widget);
    const feed = configOf(found?.widget).feeds.find(f => f.id === data.feed);
    if (!feed) return undefined;
    // The address is on the device, but Chrome needs the request inside this click: ask for the feed's host now.
    const asked = requestOrigins([feed.origin || `https://${feed.host}`]);
    return asked.then(granted => {
      if (!granted) { ctx.toast(`Still can’t read ${feed.name} without access to ${feed.host}.`, { tone: 'warning' }); return; }
      refreshFeed(feed, { force: true, onChange: () => ctx.render() });
    });
  },
});

// ------------------------------------------------------------------ settings

// The "Add a calendar" form and per-feed test results while the settings dialog is open.
const forms = new Map(); // widgetId -> { url, name, error, testing: Set, tested: { id: { ok, message } } }
const seenDrafts = new WeakSet();
const formOf = widgetId => {
  if (!forms.has(widgetId)) forms.set(widgetId, { url: '', name: '', error: '', testing: new Set(), tested: {} });
  return forms.get(widgetId);
};
const newId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const COLOR_LABELS = { blue: 'Blue', green: 'Green', orange: 'Orange', violet: 'Violet', pink: 'Pink', teal: 'Teal', red: 'Red', amber: 'Amber', indigo: 'Indigo', gray: 'Gray' };

function feedStatus(feed, form) {
  if (form.testing.has(feed.id)) return html`<span class="w-calendar-feed-status">Checking…</span>`;
  const test = form.tested[feed.id];
  if (test) return html`<span class="${cx('w-calendar-feed-status', !test.ok && 'is-error')}">${test.message}</span>`;
  const state = feedState(feed.id);
  if (state.error && !state.promise) return html`<span class="w-calendar-feed-status is-error">${state.error}</span>`;
  const data = cachedFeed(feed.id);
  return html`<span class="w-calendar-feed-status">${data ? `${feed.host} · ${plural(data.events.length, 'event')}` : feed.host}</span>`;
}

function renderFeeds(widget, draft) {
  const form = formOf(widget.id);
  const feeds = Array.isArray(draft.feeds) ? draft.feeds : [];
  const urlId = `w-calendar-feed-url-${widget.id}`;
  return html`<div class="w-calendar-feeds">
    ${feeds.length ? html`<ul class="w-calendar-feed-list" aria-label="Calendar feeds">${feeds.map((feed, index) => html`<li class="w-calendar-feed" data-key="${feed.id}">
      <span class="w-calendar-feed-swatch" data-color="${feed.color}" aria-hidden="true"></span>
      <span class="w-calendar-feed-fields">
        <label class="sr-only" for="w-calendar-feed-name-${feed.id}">Name for ${feed.host || 'this calendar'}</label>
        <input class="input input-sm" id="w-calendar-feed-name-${feed.id}" value="${feed.name}" placeholder="${feed.host || 'Calendar'}" maxlength="60"
          data-input="dashboard.draft" data-name="feeds.${index}.name" autocomplete="off">
        ${feedStatus(feed, form)}
      </span>
      ${select({ name: `feeds.${index}.color`, value: feed.color, action: 'dashboard.draft', label: `Color for ${feed.name || feed.host}`, size: 'sm',
        options: FEED_COLORS.map(color => ({ value: color, label: COLOR_LABELS[color] })) })}
      ${iconButton({ icon: 'trash-2', label: `Remove ${feed.name || feed.host}`, size: 'sm', action: 'w.calendar.feed-remove', data: { widget: widget.id, index } })}
    </li>`)}</ul>` : ''}
    <div class="w-calendar-feed-add">
      <div class="field">
        <label class="field-label" for="${urlId}">Calendar address (iCal)</label>
        <input class="input" id="${urlId}" type="url" inputmode="url" value="${form.url}" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
          data-input="w.calendar.feed-form" data-field="url" data-widget="${widget.id}" data-keydown="w.calendar.feed-key" autocomplete="off" spellcheck="false"
          ${form.error ? html`aria-invalid="true" aria-describedby="${urlId}-error"` : html`aria-describedby="${urlId}-hint"`}>
        ${form.error ? html`<p class="field-error" id="${urlId}-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${form.error}</span></p>`
          : html`<p class="field-hint" id="${urlId}-hint">Paste a public or secret iCal link (.ics or webcal://). The address stays on this device and is never included in backups.</p>`}
      </div>
      <div class="w-calendar-feed-add-row">
        <label class="sr-only" for="w-calendar-feed-newname-${widget.id}">Name (optional)</label>
        <input class="input" id="w-calendar-feed-newname-${widget.id}" value="${form.name}" placeholder="Name (optional)" maxlength="60"
          data-input="w.calendar.feed-form" data-field="name" data-widget="${widget.id}" data-keydown="w.calendar.feed-key" autocomplete="off">
        ${button({ label: 'Add calendar', icon: 'plus', action: 'w.calendar.feed-add', data: { widget: widget.id } })}
      </div>
    </div>
  </div>`;
}

function renderSettings(ctx, widget, draft) {
  const holder = getSettingsDraft();
  if (holder && !seenDrafts.has(holder)) { seenDrafts.add(holder); forms.delete(widget.id); }
  const config = { ...defaults(), ...draft };
  const auto = weekStartFor('auto', locale());
  const autoName = weekdayNames(auto, locale())[0].long;
  return html`<div class="w-calendar-settings">
    ${field({ label: 'Week starts on', control: segmented({ name: 'weekStart', value: config.weekStart, action: 'dashboard.draft-set', ariaLabel: 'Week starts on',
      options: [{ value: 'auto', label: `Automatic (${autoName})` }, { value: 'sunday', label: 'Sunday' }, { value: 'monday', label: 'Monday' }] }) })}
    <div class="dash-settings-toggle">${switchToggle({ checked: config.reminders !== false, label: 'Show reminders', description: 'Items in your library with a reminder appear on their day.',
      action: 'dashboard.draft', data: { name: 'reminders', type: 'boolean' } })}</div>
    <div class="dash-settings-toggle">${switchToggle({ checked: config.dailyNotes !== false, label: 'Show daily notes', description: 'Days with a daily note open it; other days can start one.',
      action: 'dashboard.draft', data: { name: 'dailyNotes', type: 'boolean' } })}</div>
    <div class="dash-settings-toggle">${switchToggle({ checked: !!config.weekNumbers, label: 'Show week numbers', action: 'dashboard.draft', data: { name: 'weekNumbers', type: 'boolean' } })}</div>
    ${field({ label: 'Calendar feeds', control: renderFeeds(widget, draft) })}
  </div>`;
}

function addFeed(ctx, widgetId) {
  const holder = getSettingsDraft();
  const form = formOf(widgetId);
  if (!holder) return undefined;
  const url = normalizeFeedUrl(form.url);
  if (!url) {
    form.error = form.url.trim() ? 'Enter a calendar address that starts with https:// or webcal://.' : 'Paste a calendar address first.';
    ctx.render();
    ctx.nextFrame(() => document.getElementById(`w-calendar-feed-url-${widgetId}`)?.focus());
    return undefined;
  }
  const asked = requestOrigins([url]); // during the gesture
  const feeds = Array.isArray(holder.draft.feeds) ? [...holder.draft.feeds] : [];
  const used = new Set(feeds.map(f => f.color));
  const feed = { id: newId(), name: form.name.trim(), color: FEED_COLORS.find(c => !used.has(c)) || FEED_COLORS[feeds.length % FEED_COLORS.length],
    host: hostOf(url), origin: new URL(url).origin, url };
  feeds.push(feed);
  Object.assign(form, { url: '', name: '', error: '' });
  form.testing.add(feed.id);
  holder.set({ feeds });
  return asked.then(async granted => {
    try {
      if (!granted) throw new Error(`Allow access to ${feed.host} to read this calendar.`);
      const result = await fetchFeed(url);
      writeCache(feedCacheKey(feed.id), result);
      form.tested[feed.id] = { ok: true, message: `${feed.host} · ${plural(result.events.length, 'event')}` };
      const current = getSettingsDraft();
      const row = current?.draft.feeds?.find(f => f.id === feed.id);
      if (row && !row.name && result.name) row.name = result.name;
    } catch (error) {
      form.tested[feed.id] = { ok: false, message: error?.message || 'Unable to read this calendar.' };
    } finally {
      form.testing.delete(feed.id);
      getSettingsDraft()?.render();
    }
  });
}

/** Feed ids still used by any calendar widget other than `exceptId` (a duplicated widget shares its feeds). */
function feedsInUse(exceptId) {
  const ids = new Set();
  for (const board of getDashboard()?.boards || []) {
    for (const w of board.widgets) if (w.type === 'calendar' && w.id !== exceptId) for (const f of cleanFeeds(w.config?.feeds)) ids.add(f.id);
  }
  return ids;
}

registerActions({
  'w.calendar.feed-form': ({ el }) => {
    const form = formOf(el.dataset.widget);
    form[el.dataset.field] = el.value;
    if (el.dataset.field === 'url') form.error = '';
  },
  'w.calendar.feed-key': ({ ctx, el, event }) => {
    if (event.key !== 'Enter') return undefined;
    event.preventDefault();
    return addFeed(ctx, el.dataset.widget);
  },
  'w.calendar.feed-add': ({ ctx, data }) => addFeed(ctx, data.widget),
  'w.calendar.feed-remove': ({ data }) => {
    const holder = getSettingsDraft();
    if (!holder) return;
    const feeds = [...(holder.draft.feeds || [])];
    feeds.splice(Number(data.index), 1);
    holder.set({ feeds });
  },
});

function menu(ctx, widget) {
  const config = configOf(widget);
  return [
    { label: 'Go to today', icon: 'calendar-check', run: () => { selectDay(widget.id, dayKey(new Date())); ctx.render(); } },
    ...(config.feeds.length ? [{ label: 'Refresh calendars', icon: 'refresh-cw', run: () => ctx.dispatch('w.calendar.refresh', { data: { widget: widget.id } }) }] : []),
    { label: config.feeds.length ? 'Calendar feeds…' : 'Add a calendar feed…', icon: 'rss', run: () => ctx.dispatch('dashboard.widget-settings', { data: { widget: widget.id } }) },
  ];
}

defineWidget({
  type: 'calendar',
  title: 'Calendar',
  description: 'The month with your reminders, daily notes and iCal calendars.',
  icon: 'calendar',
  category: 'info',
  keywords: ['month', 'date', 'agenda', 'events', 'ics', 'ical', 'google calendar', 'reminders', 'daily note'],
  size: { w: 3, h: 4, minW: 2, minH: 2, maxW: 12, maxH: 10 },
  presets: { S: { w: 2, h: 2 }, M: { w: 3, h: 4 }, L: { w: 6, h: 4 }, XL: { w: 8, h: 5 } },
  defaults,
  render,
  menu,
  renderSettings,
  settingsSize: 'md',
  validateSettings: () => null,
  onSettingsSave: async (ctx, widget, draft) => {
    forms.delete(widget.id);
    const config = { ...defaults(), ...draft };
    const feeds = Array.isArray(draft.feeds) ? draft.feeds : [];
    const before = cleanFeeds(widget.config?.feeds).map(f => f.id);
    const kept = new Set(feeds.map(f => f.id));
    const inUse = feedsInUse(widget.id);
    const added = Object.fromEntries(feeds.filter(f => f.url).map(f => [f.id, f.url]));
    const removed = before.filter(id => !kept.has(id) && !inUse.has(id));
    if (Object.keys(added).length || removed.length) await storeFeedUrls(added, removed);
    return {
      weekStart: ['auto', 'sunday', 'monday'].includes(config.weekStart) ? config.weekStart : 'auto',
      reminders: config.reminders !== false,
      dailyNotes: config.dailyNotes !== false,
      weekNumbers: !!config.weekNumbers,
      feeds: cleanFeeds(feeds),
    };
  },
});
