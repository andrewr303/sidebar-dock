// Widget registry. Each widget module calls defineWidget() at import time (ui/widgets/index.js imports them all);
// the dashboard renders instances from lib/dashboard-store.js through these definitions.
//
// Definition:
// {
//   type: 'clock',                     stable id (kebab-case), never renamed once shipped
//   title, description, icon,          gallery copy; icon is a ui/icons.js name
//   displayTitle?(ctx, widget) => string   instance title when the person has not renamed it (e.g. the collection name)
//   category: 'library' | 'productivity' | 'info' | 'web' | 'developer'
//   keywords: ['time', ...],           gallery search
//   size: { w, h, minW, minH, maxW, maxH }   default and limits in grid cells (12 columns; one row = --dash-row)
//   presets: { S: {w,h}, M: {w,h}, L: {w,h}, XL: {w,h} }   optional quick sizes offered in the widget menu
//                                      (without presets the menu offers sizes computed by sizePresets() below)
//   frame: 'card' | 'bare',            bare = no card chrome or header (e.g. a big clock, a folder tile)
//   defaults: () => config,            initial widget.config
//   render(ctx, widget, env) => html   body markup; env = widgetEnv() below
//   headerActions?(ctx, widget, env) => html   extra icon buttons in the frame header (refresh, add)
//   menu?(ctx, widget, env) => [menu items]    extra entries for the frame's ⋯ menu (ctx.openMenu item format)
//   fields?(ctx, widget) => [field]    generic settings form (see FIELD_TYPES)
//   renderSettings?(ctx, widget, draft, env) => html   custom settings body (replaces fields); edits go to draft (see below)
//   onSettingsSave?(ctx, widget, draft) => configPatch | Promise   called by the settings dialog before saving; return the
//                                      config to store (or undefined to store the draft as is); throw an Error with a
//                                      readable message to keep the dialog open and show it
//   validateSettings?(draft) => { fieldName: 'message' } | null   inline errors shown before onSettingsSave runs
//   needsSetup?(config) => boolean     true opens the settings dialog right after the widget is added from the gallery
//   init?(ctx)                         once, the first time the dashboard renders
//   permissions?: { origins: [], permissions: [] }   optional grants the widget may ask for (shown in the gallery)
//   preview?: string                   short static preview label for the gallery (optional)
// }
//
// Markup conventions inside render(): action names are prefixed 'w.<type>.' and carry data-widget="${widget.id}";
// handlers find the instance with findWidget(data.widget) from lib/dashboard-store.js. Imperative pieces (iframes,
// timers, drag) use registerMount('w.<type>.<name>', ...) with data-morph="skip" and a unique data-key.
// CSS classes are prefixed .w-<type>-; each widget's styles live in styles/widgets/<type>.css.
//
// Dashboard actions widgets may use in their own markup (all take data-widget="${widget.id}"):
//   'dashboard.widget-settings'   opens the widget settings dialog (use it for "Set up" buttons in setup states)
//   'dashboard.widget-reload'     re-renders the widget after an error
// The frame marks its root with data-widget-id and the body with .widget-body (a size container named "widget").
//
// Settings drafts. The widget settings dialog keeps an editable copy of widget.config (the draft) until Save. Inside
// renderSettings, either
//   - use the built-in draft actions on plain controls (data-name is a config key, dotted paths like "show.hourly" work):
//       <input data-input="dashboard.draft" data-name="city">            text, number (type="number"), range, color
//       <select data-change="dashboard.draft" data-name="units">          selects; checkboxes and switches use data-change too
//       segmented({ name: 'style', value: draft.style, options, action: 'dashboard.draft-set' })   buttons with data-value
//     Inputs re-render the dialog only for change events (typing never loses focus); add data-render="true" to re-render on
//     input, or data-type="number" | "boolean" | "json" to coerce the value.
//   - or, from your own action handlers, call getSettingsDraft() and mutate it: getSettingsDraft()?.set({ key: value })
//     (re-renders the dialog; pass { render: false } while typing) or read .draft / .widget.

export const CATEGORIES = Object.freeze([
  { id: 'library', label: 'Your library', icon: 'library' },
  { id: 'productivity', label: 'Productivity', icon: 'list-checks' },
  { id: 'info', label: 'Time & weather', icon: 'cloud-sun' },
  { id: 'web', label: 'Web & browser', icon: 'globe' },
  { id: 'developer', label: 'Developer', icon: 'code-xml' },
]);

/**
 * Field descriptors for fields(): { name, label, type, hint, placeholder, options: [{value,label}], min, max, step, required,
 * itemFields (type 'list'), addLabel (type 'list'), maxItems (type 'list'), when?(draft) }. name may be a dotted path. Types:
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

const PRESET_LABELS = { S: 'Small', M: 'Medium', L: 'Large', XL: 'Extra large' };
/**
 * Quick sizes for the widget menu: the definition's presets, else S/M/L/XL derived from its default size and limits
 * (duplicates dropped). Returns [{ key, label, w, h }].
 */
export function sizePresets(def) {
  const s = def?.size || { w: 3, h: 2 };
  const raw = def?.presets && Object.keys(def.presets).length ? def.presets : {
    S: { w: Math.min(s.w, Math.max(2, s.w - 1)), h: Math.min(s.h, Math.max(2, s.h - 1)) },
    M: { w: s.w, h: s.h },
    L: { w: s.w + 2, h: s.h + 2 },
    XL: { w: s.w + 4, h: s.h + 4 },
  };
  const seen = new Set();
  const out = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!value) continue;
    const size = clampSize(def, value);
    const id = `${size.w}x${size.h}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ key, label: PRESET_LABELS[key] || key, ...size });
  }
  return out;
}

/**
 * The env passed to render/headerActions/menu/renderSettings:
 * { size, w, h, editing, board, surface, newtab, update(patch) -> Promise (merges into widget.config) }.
 * The dashboard builds it; update is bound to the instance.
 */
export function widgetEnv({ widget, board, editing = false, surface = 'full', newtab = false, update }) {
  return { size: sizeBucket(widget.w, widget.h), w: widget.w, h: widget.h, editing, board, surface, newtab, update };
}

// ------------------------------------------------------------------ settings draft (owned by the settings dialog)

let activeDraft = null;
/**
 * The open widget settings dialog's draft: { widget, draft, set(patch, { render = true }), render() } or null.
 * set() merges top-level keys (use dotted keys for nested values: set({ 'show.hourly': false })).
 */
export const getSettingsDraft = () => activeDraft;
/** Internal: the settings dialog binds its draft holder while it is open (null when it closes). */
export function bindSettingsDraft(holder) { activeDraft = holder || null; }

/** Reads a dotted path from an object: readPath({ a: { b: 1 } }, 'a.b') -> 1. */
export function readPath(object, path) {
  return String(path).split('.').reduce((value, key) => (value == null ? undefined : value[key]), object);
}
/** Writes a dotted path into an object in place, creating plain objects on the way. Prototype keys are ignored. */
export function writePath(object, path, value) {
  const keys = String(path).split('.');
  if (keys.some(key => key === '__proto__' || key === 'constructor' || key === 'prototype')) return object;
  let target = object;
  for (const [index, key] of keys.slice(0, -1).entries()) {
    if (!target[key] || typeof target[key] !== 'object') target[key] = /^\d+$/.test(keys[index + 1]) ? [] : {};
    target = target[key];
  }
  target[keys.at(-1)] = value;
  return object;
}
