// Dashboard boards and widget instances, stored apart from the library (key still.dashboard.v1) so layout edits never
// queue behind library writes. Every open Still view loads it and follows chrome.storage changes from other tabs.
// Widget data that belongs to the widget itself (kanban cards, quick links, embed URL) lives in widget.config;
// library-backed widgets keep only references (collection ids, note ids) there.
//
// State: { version: 1, activeBoardId, boards: [Board], prefs: {}, updatedAt }
// Board: { id, name, icon, widgets: [Widget] }
// Widget: { id, type, x, y, w, h, title, style: { frame: 'default'|'card'|'glass'|'flat'|'none', hideTitle }, config: {} }
// Coordinates are grid cells on the 12-column board grid (x 0..11, w 1..12, y >= 0, h >= 1).

import { findFreeSpot } from '../ui/dashboard/grid.js';

export const DASHBOARD_KEY = 'still.dashboard.v1';
export const GRID_COLUMNS = 12;

const uid = prefix => `${prefix}_${globalThis.crypto?.randomUUID?.().slice(0, 12) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`}`;
const clone = value => structuredClone(value);
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const int = (value, fallback, min, max) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const FRAMES = ['default', 'card', 'glass', 'flat', 'none'];

export function normalizeWidget(input = {}) {
  const w = int(input.w, 3, 1, GRID_COLUMNS);
  return {
    id: typeof input.id === 'string' && input.id ? input.id : uid('w'),
    type: String(input.type || 'unknown'),
    x: int(input.x, 0, 0, GRID_COLUMNS - w),
    y: int(input.y, 0, 0, 10000),
    w,
    h: int(input.h, 2, 1, 40),
    title: typeof input.title === 'string' ? input.title.slice(0, 200) : '',
    style: {
      frame: FRAMES.includes(input.style?.frame) ? input.style.frame : 'default',
      hideTitle: input.style?.hideTitle === true,
    },
    config: isObject(input.config) ? clone(input.config) : {},
  };
}

export function normalizeBoard(input = {}) {
  const ids = new Set();
  const widgets = (Array.isArray(input.widgets) ? input.widgets : []).filter(isObject).map(normalizeWidget).filter(widget => {
    if (ids.has(widget.id)) return false;
    ids.add(widget.id);
    return true;
  });
  return {
    id: typeof input.id === 'string' && input.id ? input.id : uid('board'),
    name: String(input.name || 'Main').trim().slice(0, 80) || 'Main',
    icon: typeof input.icon === 'string' && input.icon ? input.icon : 'layout-dashboard',
    widgets,
  };
}

export function normalizeDashboard(input) {
  const boardIds = new Set();
  const boards = (isObject(input) && Array.isArray(input.boards) ? input.boards : []).filter(isObject).map(normalizeBoard).filter(board => {
    if (boardIds.has(board.id)) return false;
    boardIds.add(board.id);
    return true;
  });
  if (!boards.length) boards.push(normalizeBoard({ name: 'Main' }));
  const activeBoardId = boards.some(b => b.id === input?.activeBoardId) ? input.activeBoardId : boards[0].id;
  return { version: 1, activeBoardId, boards, prefs: isObject(input?.prefs) ? clone(input.prefs) : {}, updatedAt: input?.updatedAt || new Date().toISOString() };
}

/** Storage-agnostic store (tests pass read/write). The module exports a default instance bound to extension storage. */
export function createDashboardStore({ read, write, seed = () => null }) {
  let state = null;
  let loading = null;
  let queue = Promise.resolve();
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) { try { fn(state); } catch (error) { console.error(error); } } };

  // One read per store, however many callers ask at once; a missing state is seeded and saved exactly once.
  function load() {
    if (state) return Promise.resolve(state);
    loading ||= (async () => {
      const stored = await read();
      if (stored) state = normalizeDashboard(stored);
      else {
        let seeded = null;
        try { seeded = await seed(); } catch (error) { console.error('[still] dashboard seed failed', error); }
        state = normalizeDashboard(seeded);
        await write(state);
      }
      return state;
    })().finally(() => { loading = null; });
    return loading;
  }

  /** Applies mutator(draft) to a copy of the state and saves it. mutator may return a result value. */
  function update(mutator) {
    const run = queue.then(async () => {
      await load();
      const draft = clone(state);
      const result = await mutator(draft);
      draft.updatedAt = new Date().toISOString();
      state = normalizeDashboard(draft);
      emit();
      await write(state);
      return result;
    });
    queue = run.catch(() => {});
    return run;
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
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Replaces the whole state (another tab saved it, or a backup was restored). */
    replace(next, { persist = false } = {}) {
      state = normalizeDashboard(next);
      emit();
      return persist ? write(state) : Promise.resolve();
    },
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
      const widget = normalizeWidget(input);
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
function followOtherViews() {
  if (followingChanges) return;
  followingChanges = true;
  const onChrome = (changes, areaName) => {
    if (areaName !== 'local' || !changes[DASHBOARD_KEY]?.newValue) return;
    const next = changes[DASHBOARD_KEY].newValue;
    if (next.updatedAt && next.updatedAt === dashboard.get()?.updatedAt) return;
    dashboard.replace(next);
  };
  if (area()) globalThis.chrome.storage.onChanged.addListener(onChrome);
  else globalThis.addEventListener?.('storage', event => {
    if (event.key !== DASHBOARD_KEY || !event.newValue) return;
    try { dashboard.replace(JSON.parse(event.newValue)); } catch { /* ignore malformed */ }
  });
}

export async function loadDashboard() {
  const state = await dashboard.load();
  followOtherViews();
  return state;
}
export const getDashboard = () => dashboard.get();
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
  const state = normalizeDashboard(input);
  for (const board of state.boards) for (const widget of board.widgets) {
    widget.config = stripSecrets(widget.config);
    if (widget.type === 'embed' && widget.config?.allowFraming) widget.config = { ...widget.config, allowFraming: false };
  }
  state.prefs = stripSecrets(state.prefs);
  return state;
}

/**
 * Merges a backed-up dashboard into the current one: boards with matching IDs are replaced, new boards are added after
 * the existing ones, and the backup's active board becomes active. Returns the merged state and how many boards changed.
 */
export function mergeDashboards(current, incoming) {
  const base = normalizeDashboard(current);
  const next = portableDashboard(incoming);
  const boards = base.boards.map(board => next.boards.find(b => b.id === board.id) || board);
  for (const board of next.boards) if (!base.boards.some(b => b.id === board.id)) boards.push(board);
  const merged = normalizeDashboard({ ...base, boards, activeBoardId: next.activeBoardId, prefs: { ...base.prefs, ...next.prefs }, updatedAt: new Date().toISOString() });
  return { state: merged, boards: next.boards.length };
}

/** Backup source for lib/portability.js bound to this view's dashboard (null outside extension or preview storage). */
export function dashboardBackupSource() {
  if (!area() && !globalThis.localStorage) return null;
  return {
    async exportDashboard() { return portableDashboard(await dashboard.load()); },
    async importDashboard(incoming) {
      const { state, boards } = mergeDashboards(await dashboard.load(), incoming);
      await dashboard.replace(state, { persist: true });
      return { boards };
    },
  };
}
