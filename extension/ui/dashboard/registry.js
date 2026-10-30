// Widget registry. Each widget module calls defineWidget() at import time (ui/widgets/index.js imports them all);
// the dashboard renders instances from lib/dashboard-store.js through these definitions.
//
// Definition:
// {
//   type: 'clock',                     stable id (kebab-case), never renamed once shipped
//   title, description, icon,          gallery copy; icon is a ui/icons.js name
//   category: 'library' | 'productivity' | 'info' | 'web' | 'developer'
//   keywords: ['time', ...],           gallery search
//   size: { w, h, minW, minH, maxW, maxH }   default and limits in grid cells (12 columns; one row = --dash-row)
//   presets: { S: {w,h}, M: {w,h}, L: {w,h}, XL: {w,h} }   optional quick sizes offered in the widget menu
//   frame: 'card' | 'bare',            bare = no card chrome or header (e.g. a big clock, a folder tile)
//   defaults: () => config,            initial widget.config
//   render(ctx, widget, env) => html   body markup; env = widgetEnv() below
//   headerActions?(ctx, widget, env) => html   extra icon buttons in the frame header (refresh, add)
//   menu?(ctx, widget, env) => [menu items]    extra entries for the frame's ⋯ menu (ctx.openMenu item format)
//   fields?(ctx, widget) => [field]    generic settings form (see FIELD_TYPES)
//   renderSettings?(ctx, widget, draft, env) => html   custom settings body (replaces fields); edits go to draft
//   onSettingsSave?(ctx, widget, draft) => configPatch | Promise   called by the settings dialog before saving
//   init?(ctx)                         once, the first time the dashboard renders
//   permissions?: { origins: [], permissions: [] }   optional grants the widget may ask for (shown in the gallery)
//   preview?: string                   short static preview label for the gallery (optional)
// }
//
// Markup conventions inside render(): action names are prefixed 'w.<type>.' and carry data-widget="${widget.id}";
// handlers find the instance with findWidget(data.widget) from lib/dashboard-store.js. Imperative pieces (iframes,
// timers, drag) use registerMount('w.<type>.<name>', ...) with data-morph="skip" and a unique data-key.
// CSS classes are prefixed .w-<type>-; each widget's styles live in styles/widgets/<type>.css.

export const CATEGORIES = Object.freeze([
  { id: 'library', label: 'Your library', icon: 'library' },
  { id: 'productivity', label: 'Productivity', icon: 'list-checks' },
  { id: 'info', label: 'Time & weather', icon: 'cloud-sun' },
  { id: 'web', label: 'Web & browser', icon: 'globe' },
  { id: 'developer', label: 'Developer', icon: 'code-xml' },
]);

/**
 * Field descriptors for fields(): { name, label, type, hint, placeholder, options: [{value,label}], min, max, step,
 * itemFields (type 'list'), addLabel (type 'list'), when?(draft) }. Types:
 */
export const FIELD_TYPES = Object.freeze([
  'text', 'url', 'number', 'textarea', 'select', 'segmented', 'toggle', 'color', 'range',
  'collection',  // a library collection id ('' = Inbox) via the collection picker
  'note',        // a library note id
  'list',        // array of objects edited with itemFields (e.g. [{ title, url }])
]);

const widgets = new Map();

export function defineWidget(def) {
  if (!def?.type || typeof def.render !== 'function') throw new Error('A widget needs a type and a render function.');
  if (widgets.has(def.type)) console.warn(`[still] widget "${def.type}" defined twice; the later one wins.`);
  const size = { w: 3, h: 2, minW: 1, minH: 1, maxW: 12, maxH: 12, ...(def.size || {}) };
  widgets.set(def.type, {
    title: def.type, description: '', icon: 'layout-grid', category: 'productivity', keywords: [], frame: 'card',
    defaults: () => ({}), ...def, size,
  });
  return widgets.get(def.type);
}

export const getWidget = type => widgets.get(type) || null;
export const listWidgets = () => [...widgets.values()];

/** Coarse size class from grid cells, for widgets that switch layouts: xs | s | m | l | xl. */
export function sizeBucket(w, h) {
  if (w <= 2 && h <= 2) return 'xs';
  if (w <= 3 || h <= 2) return 's';
  if (w <= 6 && h <= 5) return 'm';
  if (w <= 8 && h <= 8) return 'l';
  return 'xl';
}

/** Clamps a requested size to a definition's limits. */
export function clampSize(def, { w, h }) {
  const s = def?.size || {};
  return {
    w: Math.max(s.minW || 1, Math.min(s.maxW || 12, Math.round(w) || s.w || 3)),
    h: Math.max(s.minH || 1, Math.min(s.maxH || 12, Math.round(h) || s.h || 2)),
  };
}

/**
 * The env passed to render/headerActions/menu/renderSettings:
 * { size, w, h, editing, board, surface, newtab, update(patch) -> Promise (merges into widget.config) }.
 * The dashboard builds it; update is bound to the instance.
 */
export function widgetEnv({ widget, board, editing = false, surface = 'full', newtab = false, update }) {
  return { size: sizeBucket(widget.w, widget.h), w: widget.w, h: widget.h, editing, board, surface, newtab, update };
}
