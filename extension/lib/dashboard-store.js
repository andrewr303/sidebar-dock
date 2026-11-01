// Dashboard boards and widget instances, stored apart from the library (key still.dashboard.v1) so layout edits never
// queue behind library writes. Every open Still view loads it and follows chrome.storage changes from other tabs.
// Widget data that belongs to the widget itself (kanban cards, quick links, embed URL) lives in widget.config;
// library-backed widgets keep only references (collection ids, note ids) there.
//
// State: { version: 1, activeBoardId, boards: [Board], prefs: {}, updatedAt }
// Board: { id, name, icon, widgets: [Widget] }
// Widget: { id, type, x, y, w, h, title, style: { frame: 'default'|'card'|'glass'|'flat'|'none', hideTitle }, config: {} }
// Coordinates are grid cells on the 12-column board grid (x 0..11, w 1..12, y >= 0, h >= 1).
//
// Durability rules: fields this build does not know (written by a newer or older build) ride along on every record, so
// an edit here never deletes them. A document whose version is newer than DASHBOARD_VERSION is shown but never written
// (every change throws a "newer version" error). Writes from every open view (new tabs, side panel, settings) take one
// Web Lock and re-read storage inside it, so two views editing at once never lose each other's change.

import { findFreeSpot } from '../ui/dashboard/grid.js';

export const DASHBOARD_KEY = 'still.dashboard.v1';
export const DASHBOARD_VERSION = 1;
export const GRID_COLUMNS = 12;

const uid = prefix => `${prefix}_${globalThis.crypto?.randomUUID?.().slice(0, 12) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`}`;
const clone = value => structuredClone(value);
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
// Strictly after the previous stamp, so two saves in the same millisecond never look like the same version.
const nextStamp = previous => new Date(Math.max(Date.now(), (Date.parse(previous) || 0) + 1)).toISOString();
const int = (value, fallback, min, max) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const FRAMES = ['default', 'card', 'glass', 'flat', 'none'];
const WIDGET_KEYS = ['id', 'type', 'x', 'y', 'w', 'h', 'title', 'style', 'config'];
const STYLE_KEYS = ['frame', 'hideTitle'];
const BOARD_KEYS = ['id', 'name', 'icon', 'widgets'];
const STATE_KEYS = ['version', 'activeBoardId', 'boards', 'prefs', 'updatedAt'];
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True when a stored dashboard was saved by a newer build; this build shows it but never writes it. */
export const isNewerDashboard = value => isObject(value) && Number(value.version) > DASHBOARD_VERSION;

function newerVersionError() {
  const error = new Error('Your dashboard was saved by a newer version of Still. Update Still to keep editing it; nothing was changed.');
  error.code = 'newer_version';
  return error;
}

// Plain-data fields outside `known`, copied so a newer build's additions survive this build's edits. Functions and
// other values that cannot be stored are dropped.
function unknownFields(input, known) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (known.includes(key) || UNSAFE_KEYS.has(key) || value === undefined || typeof value === 'function') continue;
    try { output[key] = clone(value); } catch { /* not storable */ }
  }
  return output;
}

// A frame this build does not draw (a newer build's) is kept as written; the renderer's CSS falls back to the default
// look for an unknown data-frame. Fresh widgets from the UI (strict) only get known frames.
const frameOf = (frame, strict) => FRAMES.includes(frame) ? frame : !strict && typeof frame === 'string' && /^[\w-]{1,40}$/.test(frame) ? frame : 'default';

/**
 * Repairs a widget record. Stored widgets keep fields and style keys this build does not know; `strict` (a new widget
 * built by the UI) keeps only the documented fields.
 */
export function normalizeWidget(input = {}, { strict = false } = {}) {
  const w = int(input.w, 3, 1, GRID_COLUMNS);
  const style = isObject(input.style) ? input.style : {};
  return {
    ...(strict ? {} : unknownFields(input, WIDGET_KEYS)),
    id: typeof input.id === 'string' && input.id ? input.id : uid('w'),
    type: String(input.type || 'unknown'),
    x: int(input.x, 0, 0, GRID_COLUMNS - w),
    y: int(input.y, 0, 0, 10000),
    w,
    h: int(input.h, 2, 1, 40),
    title: typeof input.title === 'string' ? input.title.slice(0, 200) : '',
    style: {
      ...(strict ? {} : unknownFields(style, STYLE_KEYS)),
      frame: frameOf(style.frame, strict),
      hideTitle: style.hideTitle === true,
    },
    config: isObject(input.config) ? clone(input.config) : {},
  };
}

export function normalizeBoard(input = {}) {
  const ids = new Set();
  const widgets = (Array.isArray(input.widgets) ? input.widgets : []).filter(isObject).map(widget => normalizeWidget(widget)).filter(widget => {
    if (ids.has(widget.id)) return false;
    ids.add(widget.id);
    return true;
  });
  return {
    ...unknownFields(input, BOARD_KEYS),
    id: typeof input.id === 'string' && input.id ? input.id : uid('board'),
    name: String(input.name || 'Main').trim().slice(0, 80) || 'Main',
    icon: typeof input.icon === 'string' && input.icon ? input.icon : 'layout-dashboard',
    widgets,
  };
}

export function normalizeDashboard(input) {
  const source = isObject(input) ? input : {};
  const boardIds = new Set();
  const boards = (Array.isArray(source.boards) ? source.boards : []).filter(isObject).map(normalizeBoard).filter(board => {
    if (boardIds.has(board.id)) return false;
    boardIds.add(board.id);
    return true;
  });
  if (!boards.length) boards.push(normalizeBoard({ name: 'Main' }));
  const activeBoardId = boards.some(b => b.id === source.activeBoardId) ? source.activeBoardId : boards[0].id;
  return {
    ...unknownFields(source, STATE_KEYS),
    // A newer build's version number is kept, so the state stays recognisably read-only wherever it travels.
    version: isNewerDashboard(source) ? source.version : DASHBOARD_VERSION,
    activeBoardId, boards, prefs: isObject(source.prefs) ? clone(source.prefs) : {}, updatedAt: source.updatedAt || new Date().toISOString(),
  };
}

/**
 * Storage-agnostic store (tests pass read/write, and optionally locks). The module exports a default instance bound to
 * extension storage. `locks` defaults to navigator.locks; pass null to rely on the per-store queue alone.
 */
export function createDashboardStore({ read, write, seed = () => null, locks }) {
  let state = null;
  // The default board shown while nothing is stored and no seed is available (side panel, settings). It is never saved
  // on its own, so the real first-run seed still happens when a view with a seed provider loads.
  let placeholder = false;
  // updatedAt of the value this view last read from or wrote to storage. A different stored stamp means another view
  // saved (or a snapshot was restored) since, so storage wins.
  let seen;
  let loading = null;
  let queue = Promise.resolve();
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) { try { fn(state); } catch (error) { console.error(error); } } };

  // `serial` orders this view's work; `exclusive` also holds the cross-view Web Lock for anything that writes.
  const serial = task => {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  };
  const exclusive = task => serial(() => {
    const api = locks === undefined ? globalThis.navigator?.locks : locks;
    return typeof api?.request === 'function' ? api.request(DASHBOARD_KEY, () => task()) : task();
  });
  const adopt = stored => { state = normalizeDashboard(stored); placeholder = false; seen = stored.updatedAt; };
  const save = async () => { await write(state); seen = state.updatedAt; };

  // Brings this view in line with storage (call inside the lock). Nothing stored: seed and save the first-run board, or
  // keep an unsaved placeholder when there is no seed. Returns true when the state changed.
  async function sync() {
    const stored = await read();
    if (stored) {
      if (state && !placeholder && stored.updatedAt === seen) return false;
      adopt(stored);
      return true;
    }
    if (state && !placeholder) return false;
    let seeded = null;
    try { seeded = await seed(); } catch (error) { console.error('[still] dashboard seed failed', error); }
    if (!isObject(seeded)) {
      if (state) return false;
      state = normalizeDashboard(null);
      placeholder = true;
      return true;
    }
    state = normalizeDashboard(seeded);
    placeholder = false;
    await save();
    return true;
  }

  // One read per store, however many callers ask at once; a missing state is seeded and saved exactly once, also when
  // several views open at the same time (the seed runs inside the lock after a re-read).
  function load() {
    if (state && !placeholder) return Promise.resolve(state);
    loading ||= (async () => {
      const shown = state;
      await exclusive(sync);
      if (shown && state !== shown) emit();
      return state;
    })().finally(() => { loading = null; });
    return loading;
  }

  /**
   * Applies mutator(draft) to a copy of the state and saves it. mutator may return a result value. Runs under the
   * cross-view lock after re-reading storage, so it always builds on the latest saved dashboard.
   */
  function update(mutator) {
    return exclusive(async () => {
      const adopted = await sync();
      if (isNewerDashboard(state)) { if (adopted) emit(); throw newerVersionError(); }
      const before = { state, placeholder };
      let result;
      try {
        const draft = clone(state);
        result = await mutator(draft);
        draft.updatedAt = nextStamp(state.updatedAt);
        state = normalizeDashboard(draft);
        placeholder = false;
      } catch (error) {
        if (adopted) emit();
        throw error;
      }
      emit();
      try { await save(); } catch (error) {
        // Show what is really saved rather than a change that never reached storage.
        ({ state, placeholder } = before);
        emit();
        throw error;
      }
      return result;
    });
  }

  const boardIn = (draft, boardId) => {
    const board = draft.boards.find(b => b.id === (boardId || draft.activeBoardId));
    if (!board) throw new Error('That dashboard no longer exists.');
    return board;
  };
  const locate = (draft, widgetId) => {
    for (const board of draft.boards) {
      const widget = board.widgets.find(w => w.id === widgetId);
      if (widget) return { board, widget };
    }
    throw new Error('That widget is no longer on your dashboard.');
  };

  return {
    load,
    get: () => state,
    /** True when the stored dashboard comes from a newer build: it is shown, but every change refuses. */
    readOnly: () => isNewerDashboard(state),
    /** True when nothing is saved yet and the board shown is the unsaved default (no seed was available). */
    isPlaceholder: () => placeholder,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /**
     * Replaces the whole state (a backup was restored). Queued behind this view's own updates; with persist it takes the
     * cross-view lock and refuses to overwrite a dashboard a newer build saved.
     */
    replace(next, { persist = false } = {}) {
      if (!persist) return serial(() => { state = normalizeDashboard(next); placeholder = false; emit(); });
      return exclusive(async () => {
        if (isNewerDashboard(await read()) || isNewerDashboard(next)) throw newerVersionError();
        const before = { state, placeholder };
        state = normalizeDashboard(next);
        placeholder = false;
        emit();
        try { await save(); } catch (error) {
          ({ state, placeholder } = before);
          emit();
          throw error;
        }
      });
    },
    /**
     * Adopts what storage holds now, after this view's queued writes: another view saved, or a snapshot was restored.
     * Reading storage (rather than trusting an event's value) means a late event never rolls the view back.
     */
    refresh: () => serial(async () => {
      if (!state) return state;
      const stored = await read();
      if (stored && (placeholder || stored.updatedAt !== seen)) { adopt(stored); emit(); }
      return state;
    }),
    update,
    activeBoard: () => state?.boards.find(b => b.id === state.activeBoardId) || state?.boards[0] || null,
    findWidget(widgetId) {
      for (const board of state?.boards || []) {
        const widget = board.widgets.find(w => w.id === widgetId);
        if (widget) return { board, widget };
      }
      return null;
    },
    setActiveBoard: boardId => update(draft => { boardIn(draft, boardId); draft.activeBoardId = boardId; }),
    addBoard: ({ name = 'New board', icon, widgets = [] } = {}) => update(draft => {
      const board = normalizeBoard({ name, icon, widgets });
      draft.boards.push(board);
      draft.activeBoardId = board.id;
      return board;
    }),
    updateBoard: (boardId, patch = {}) => update(draft => {
      const board = boardIn(draft, boardId);
      if (typeof patch.name === 'string') board.name = patch.name;
      if (typeof patch.icon === 'string') board.icon = patch.icon;
      if (Array.isArray(patch.widgets)) board.widgets = patch.widgets;
    }),
    removeBoard: boardId => update(draft => {
      if (draft.boards.length < 2) throw new Error('Keep at least one dashboard.');
      draft.boards = draft.boards.filter(b => b.id !== boardId);
      if (draft.activeBoardId === boardId) draft.activeBoardId = draft.boards[0].id;
    }),
    moveBoard: (boardId, toIndex) => update(draft => {
      const from = draft.boards.findIndex(b => b.id === boardId);
      if (from < 0) return;
      const [board] = draft.boards.splice(from, 1);
      draft.boards.splice(Math.max(0, Math.min(draft.boards.length, toIndex)), 0, board);
    }),
    /** Adds a widget; without numeric x/y it goes to the first free spot that fits its size. */
    addWidget: (boardId, input = {}) => update(draft => {
      const board = boardIn(draft, boardId);
      const widget = normalizeWidget(input, { strict: true });
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) Object.assign(widget, findFreeSpot(board.widgets, widget.w, widget.h, GRID_COLUMNS));
      board.widgets.push(widget);
      return widget;
    }),
    /** Copies a widget (new id, same type/config/style) into the first free spot at or below it. */
    duplicateWidget: widgetId => update(draft => {
      const { board, widget } = locate(draft, widgetId);
      const copy = normalizeWidget({ ...clone(widget), id: uid('w') });
      Object.assign(copy, findFreeSpot(board.widgets, copy.w, copy.h, GRID_COLUMNS, { fromY: widget.y }));
      board.widgets.push(copy);
      return copy;
    }),
    /** Moves a widget to another board, into that board's first free spot. */
    moveWidgetToBoard: (widgetId, boardId) => update(draft => {
      const { board: from, widget } = locate(draft, widgetId);
      const to = boardIn(draft, boardId);
      if (from.id === to.id) return widget;
      from.widgets = from.widgets.filter(w => w.id !== widgetId);
      Object.assign(widget, findFreeSpot(to.widgets, widget.w, widget.h, GRID_COLUMNS));
      to.widgets.push(widget);
      return widget;
    }),
    /** Patches top-level widget fields (x, y, w, h, title, style). config is merged shallowly when given. */
    updateWidget: (widgetId, patch = {}) => update(draft => {
      const { widget } = locate(draft, widgetId);
      for (const key of ['x', 'y', 'w', 'h', 'title']) if (key in patch) widget[key] = patch[key];
      if (isObject(patch.style)) widget.style = { ...widget.style, ...patch.style };
      if (isObject(patch.config)) widget.config = { ...widget.config, ...clone(patch.config) };
      return widget;
    }),
    /** Shallow-merges into widget.config (the usual way widgets save their own data). */
    updateWidgetConfig: (widgetId, patch = {}) => update(draft => {
      const { widget } = locate(draft, widgetId);
      widget.config = { ...widget.config, ...clone(patch) };
      return widget;
    }),
    /** Applies many {id, x, y, w, h} layout changes on one board in a single write (drag, resize, tidy). */
    applyLayout: (boardId, rects = []) => update(draft => {
      const board = boardIn(draft, boardId);
      const byId = new Map(rects.map(r => [r.id, r]));
      for (const widget of board.widgets) {
        const r = byId.get(widget.id);
        if (r) Object.assign(widget, { x: r.x, y: r.y, w: r.w, h: r.h });
      }
    }),
    removeWidget: widgetId => update(draft => {
      const { board, widget } = locate(draft, widgetId);
      board.widgets = board.widgets.filter(w => w.id !== widgetId);
      return { boardId: board.id, widget };
    }),
    /** Re-inserts a removed widget (Undo). If its spot was taken meanwhile, it goes to the first free spot. */
    restoreWidget: (boardId, widget) => update(draft => {
      const board = boardIn(draft, boardId);
      if (board.widgets.some(w => w.id === widget.id)) return;
      const restored = normalizeWidget(widget);
      const taken = board.widgets.some(w => w.x < restored.x + restored.w && w.x + w.w > restored.x && w.y < restored.y + restored.h && w.y + w.h > restored.y);
      if (taken) Object.assign(restored, findFreeSpot(board.widgets, restored.w, restored.h, GRID_COLUMNS));
      board.widgets.push(restored);
    }),
    /** Restores a removed board (Undo) at its old index. */
    restoreBoard: (board, index = Infinity) => update(draft => {
      if (draft.boards.some(b => b.id === board.id)) return;
      draft.boards.splice(Math.max(0, Math.min(draft.boards.length, index)), 0, normalizeBoard(board));
      draft.activeBoardId = board.id;
    }),
    setPrefs: patch => update(draft => { draft.prefs = { ...draft.prefs, ...clone(patch) }; }),
  };
}

// ------------------------------------------------------------------ default instance (extension or preview storage)

const area = () => globalThis.chrome?.storage?.local || null;
let seedProvider = () => null;

const dashboard = createDashboardStore({
  read: async () => {
    const local = area();
    if (local) return (await local.get(DASHBOARD_KEY))?.[DASHBOARD_KEY] || null;
    try { return JSON.parse(globalThis.localStorage?.getItem(DASHBOARD_KEY) || 'null'); } catch { return null; }
  },
  write: async value => {
    const local = area();
    if (local) await local.set({ [DASHBOARD_KEY]: value });
    else globalThis.localStorage?.setItem(DASHBOARD_KEY, JSON.stringify(value));
  },
  seed: () => seedProvider(),
});

/** The first-run board comes from ui/dashboard (it knows widget defaults and the library); set before loadDashboard. */
export function setDashboardSeed(fn) { seedProvider = typeof fn === 'function' ? fn : () => null; }

let followingChanges = false;
// Another view saved (or a snapshot was restored): adopt it after this view's own queued writes. The view's own echo
// (same updatedAt) is skipped without a read.
const followStorage = next => {
  if (!isObject(next) || (next.updatedAt && next.updatedAt === dashboard.get()?.updatedAt)) return;
  dashboard.refresh().catch(error => console.error('[still] dashboard could not follow another view', error));
};
function followOtherViews() {
  if (followingChanges) return;
  followingChanges = true;
  const onChrome = (changes, areaName) => {
    if (areaName === 'local' && changes[DASHBOARD_KEY]?.newValue) followStorage(changes[DASHBOARD_KEY].newValue);
  };
  if (area()) globalThis.chrome.storage.onChanged.addListener(onChrome);
  else globalThis.addEventListener?.('storage', event => {
    if (event.key !== DASHBOARD_KEY || !event.newValue) return;
    try { followStorage(JSON.parse(event.newValue)); } catch { /* ignore malformed */ }
  });
}

export async function loadDashboard() {
  const state = await dashboard.load();
  followOtherViews();
  return state;
}
export const getDashboard = () => dashboard.get();
/** True when the saved dashboard comes from a newer build of Still: it is shown, but changes are refused. */
export const isDashboardReadOnly = () => dashboard.readOnly();
export const subscribeDashboard = fn => dashboard.subscribe(fn);
export const updateDashboard = mutator => dashboard.update(mutator);
export const replaceDashboard = (next, options) => dashboard.replace(next, options);
export const activeBoard = () => dashboard.activeBoard();
export const findWidget = widgetId => dashboard.findWidget(widgetId);
export const setActiveBoard = boardId => dashboard.setActiveBoard(boardId);
export const addBoard = input => dashboard.addBoard(input);
export const updateBoard = (boardId, patch) => dashboard.updateBoard(boardId, patch);
export const removeBoard = boardId => dashboard.removeBoard(boardId);
export const moveBoard = (boardId, toIndex) => dashboard.moveBoard(boardId, toIndex);
export const addWidget = (boardId, input) => dashboard.addWidget(boardId, input);
export const updateWidget = (widgetId, patch) => dashboard.updateWidget(widgetId, patch);
export const updateWidgetConfig = (widgetId, patch) => dashboard.updateWidgetConfig(widgetId, patch);
export const applyLayout = (boardId, rects) => dashboard.applyLayout(boardId, rects);
export const removeWidget = widgetId => dashboard.removeWidget(widgetId);
export const restoreWidget = (boardId, widget) => dashboard.restoreWidget(boardId, widget);
export const restoreBoard = (board, index) => dashboard.restoreBoard(board, index);
export const duplicateWidget = widgetId => dashboard.duplicateWidget(widgetId);
export const moveWidgetToBoard = (widgetId, boardId) => dashboard.moveWidgetToBoard(widgetId, boardId);
export const setDashboardPrefs = patch => dashboard.setPrefs(patch);

// ------------------------------------------------------------------ backups (lib/portability.js)

// Widget config never holds credentials (lib/accounts.js does), but a backup strips anything that looks like one anyway.
const SECRET_KEY = /token|secret|password|passphrase|credential|api[-_]?key|authorization|cookie/i;
function stripSecrets(value, depth = 0) {
  if (depth > 20) return null;
  if (Array.isArray(value)) return value.map(entry => stripSecrets(entry, depth + 1));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEY.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key))
    .map(([key, entry]) => [key, stripSecrets(entry, depth + 1)]));
}

/**
 * A portable copy of a dashboard state: normalized, with credential-like config keys removed. Website widgets lose
 * "Allow embedding": it strips a site's framing protection, so it is only ever switched on by a person on this device.
 */
export function portableDashboard(input) {
  const { boards, prefs, ...rest } = normalizeDashboard(input);
  // Fields this build does not know travel too, minus anything named like a credential.
  const state = { ...stripSecrets(rest), boards, prefs: stripSecrets(prefs) };
  state.boards = boards.map(({ widgets, ...board }) => ({ ...stripSecrets(board), widgets: widgets.map(({ config, ...widget }) => {
    const portable = { ...stripSecrets(widget), config: stripSecrets(config) };
    if (portable.type === 'embed' && portable.config?.allowFraming) portable.config = { ...portable.config, allowFraming: false };
    return portable;
  }) }));
  return state;
}

/**
 * Merges a backed-up dashboard into the current one: boards with matching IDs are replaced, new boards are added after
 * the existing ones, and the backup's active board becomes active. Returns the merged state and how many boards changed.
 * Throws (code 'newer_version') when either side was saved by a newer build: merging would rewrite it in an older format.
 */
export function mergeDashboards(current, incoming) {
  if (isNewerDashboard(current) || isNewerDashboard(incoming)) throw newerVersionError();
  const base = normalizeDashboard(current);
  const next = portableDashboard(incoming);
  // Boards and widgets carry no stamps of their own, so the dashboards' stamps decide: when this device's dashboard was
  // saved after the backup, its boards stay as they are (an old backup never rolls back newer layouts or widget content).
  // Otherwise the backup's board wins, and widgets added here since are kept on it, so a restore never deletes any.
  // The stamps as saved (normalising fills a missing one with now, which would make any dashboard look newest).
  const stamp = value => Date.parse(isObject(value) && typeof value.updatedAt === 'string' ? value.updatedAt : '');
  const localNewer = Number.isFinite(stamp(current)) && Number.isFinite(stamp(incoming)) && stamp(current) >= stamp(incoming);
  let kept = 0;
  const boards = base.boards.map(board => {
    const backup = next.boards.find(b => b.id === board.id);
    if (!backup) return board;
    if (localNewer) { kept++; return board; }
    const widgets = backup.widgets.map(widget => ({ ...widget }));
    for (const widget of board.widgets) {
      if (widgets.some(w => w.id === widget.id)) continue;
      widgets.push({ ...widget, ...findFreeSpot(widgets, widget.w, widget.h, GRID_COLUMNS) });
    }
    return { ...backup, widgets };
  });
  for (const board of next.boards) if (!base.boards.some(b => b.id === board.id)) boards.push(board);
  const merged = normalizeDashboard({ ...base, boards, activeBoardId: next.activeBoardId, prefs: { ...base.prefs, ...next.prefs }, updatedAt: nextStamp(base.updatedAt) });
  return { state: merged, boards: next.boards.length - kept, kept };
}

/**
 * Backup source for lib/portability.js bound to this view's dashboard (null outside extension or preview storage).
 * exportDashboard() resolves to null while nothing is saved yet (only the unsaved default board exists), so a backup
 * never carries an empty placeholder board into another device. importDashboard() throws (code 'newer_version') when
 * either dashboard comes from a newer build; nothing is written then.
 */
export function dashboardBackupSource() {
  if (!area() && !globalThis.localStorage) return null;
  return {
    async exportDashboard() {
      const state = await dashboard.load();
      return dashboard.isPlaceholder() ? null : portableDashboard(state);
    },
    async importDashboard(incoming) {
      const { state, boards, kept } = mergeDashboards(await dashboard.load(), incoming);
      await dashboard.replace(state, { persist: true });
      return { boards, kept };
    },
  };
}
