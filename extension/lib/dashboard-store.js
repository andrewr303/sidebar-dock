// Dashboard boards and widget instances, stored apart from the library (key still.dashboard.v1) so layout edits never
// queue behind library writes. Every open Still view loads it and follows chrome.storage changes from other tabs.
// Widget data that belongs to the widget itself (kanban cards, quick links, embed URL) lives in widget.config;
// library-backed widgets keep only references (collection ids, note ids) there.
//
// State: { version: 1, activeBoardId, boards: [Board], prefs: {}, updatedAt }
// Board: { id, name, icon, widgets: [Widget] }
// Widget: { id, type, x, y, w, h, title, style: { frame: 'default'|'card'|'glass'|'flat'|'none', hideTitle }, config: {} }
// Coordinates are grid cells on the 12-column board grid (x 0..11, w 1..12, y >= 0, h >= 1).

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
  const widgets = (Array.isArray(input.widgets) ? input.widgets : []).map(normalizeWidget).filter(widget => {
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
  const boards = (isObject(input) && Array.isArray(input.boards) ? input.boards : []).map(normalizeBoard);
  if (!boards.length) boards.push(normalizeBoard({ name: 'Main' }));
  const activeBoardId = boards.some(b => b.id === input?.activeBoardId) ? input.activeBoardId : boards[0].id;
  return { version: 1, activeBoardId, boards, prefs: isObject(input?.prefs) ? clone(input.prefs) : {}, updatedAt: input?.updatedAt || new Date().toISOString() };
}

/** Storage-agnostic store (tests pass read/write). The module exports a default instance bound to extension storage. */
export function createDashboardStore({ read, write, seed = () => null }) {
  let state = null;
  let queue = Promise.resolve();
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) { try { fn(state); } catch (error) { console.error(error); } } };

  async function load() {
    if (state) return state;
    const stored = await read();
    if (stored) state = normalizeDashboard(stored);
    else {
      state = normalizeDashboard(await seed());
      await write(state);
    }
    return state;
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
    /** Adds a widget; x/y default to the first free spot (placement is the caller's job when it cares). */
    addWidget: (boardId, input) => update(draft => {
      const board = boardIn(draft, boardId);
      const widget = normalizeWidget(input);
      board.widgets.push(widget);
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
    /** Re-inserts a removed widget (Undo). */
    restoreWidget: (boardId, widget) => update(draft => {
      const board = boardIn(draft, boardId);
      if (!board.widgets.some(w => w.id === widget.id)) board.widgets.push(normalizeWidget(widget));
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
export const setDashboardPrefs = patch => dashboard.setPrefs(patch);
