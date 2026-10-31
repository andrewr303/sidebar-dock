// Widget settings dialog: the widget's own settings (its renderSettings, or a form generated from fields()) and the
// common appearance options (title, show title, background). Edits go to a draft copy of the config; Save validates,
// runs the widget's onSettingsSave and writes title, style and config in one update.
import { html, cx } from '../html.js';
import { icon } from '../icons.js';
import { dialogFrame, button, iconButton, input, textarea, select, segmented, switchToggle, field as fieldRow, emptyState, relativeDate, collectionIcon } from '../components.js';
import { registerActions } from '../runtime.js';
import { registerDialog } from '../overlay.js';
import { renderCollectionPickerTrigger } from '../pickers.js';
import { getWidget, bindSettingsDraft, getSettingsDraft, readPath, writePath } from './registry.js';
import * as dashboardStore from '../../lib/dashboard-store.js';
import { envFor, widgetTitle, removeWidget, bindWidgetSettings } from './frame.js';

const DIALOG = 'dashboard.widget-settings';
const FRAMES = [
  { value: 'default', label: 'Default' }, { value: 'card', label: 'Card' }, { value: 'glass', label: 'Glass' },
  { value: 'flat', label: 'Flat' }, { value: 'none', label: 'None' },
];
const fieldId = name => `wset-${String(name).replace(/[^\w-]+/g, '-')}`;
const entry = ctx => ctx.state.dialogs.findLast(d => d.name === DIALOG);
const uid = () => globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(36).slice(2, 10);

function fieldsFor(ctx, def, widget) {
  if (!def?.fields) return [];
  try { return def.fields(ctx, widget) || []; } catch (error) { console.error(error); return []; }
}

// ------------------------------------------------------------------ validation (pure)

const isHttpUrl = value => { try { return ['http:', 'https:'].includes(new URL(String(value)).protocol); } catch { return false; } };
// "Folder name" → "folder name", but acronyms stay as written ("URL", "ICS feed").
const lowerLabel = label => (/^[A-Z]{2}/.test(String(label)) ? String(label) : String(label || 'a value').replace(/^\w/, c => c.toLowerCase()));

/** Inline errors for a generic field list against a draft: { 'path': 'message' }. */
export function validateFields(fields, draft) {
  const errors = {};
  const check = (f, name, value) => {
    const empty = value === undefined || value === null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);
    if (f.required && empty) {
      errors[name] = f.type === 'note' ? 'Choose a note.' : f.type === 'collection' ? 'Choose a collection.' : f.type === 'list' ? `Add at least one ${lowerLabel(f.itemLabel || 'item')}.` : `Enter ${lowerLabel(f.label)}.`;
      return;
    }
    if (empty) return;
    if (f.type === 'url' && !isHttpUrl(value)) errors[name] = 'Enter a web address that starts with https://';
    if (f.type === 'number' || f.type === 'range') {
      const n = Number(value);
      if (!Number.isFinite(n)) errors[name] = 'Enter a number.';
      else if ((f.min != null && n < f.min) || (f.max != null && n > f.max)) {
        errors[name] = f.min != null && f.max != null ? `Enter a number from ${f.min} to ${f.max}.` : f.min != null ? `Enter ${f.min} or more.` : `Enter ${f.max} or less.`;
      }
    }
    if (f.type === 'list' && Array.isArray(value)) {
      value.forEach((row, index) => (f.itemFields || []).forEach(sub => check(sub, `${name}.${index}.${sub.name}`, row?.[sub.name])));
    }
  };
  for (const f of fields) {
    if (f.when && !f.when(draft)) continue;
    check(f, f.name, readPath(draft, f.name));
  }
  return errors;
}

// ------------------------------------------------------------------ generic field renderers

function notePicker(ctx, f, value, props, describedBy) {
  const query = String(props.noteQuery?.[f.name] || '').trim().toLowerCase();
  const notes = ctx.select.live().filter(item => item.type === 'note' && !item.sticky)
    .filter(item => !query || `${item.title}\n${item.content}`.toLowerCase().includes(query))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const selected = value ? ctx.select.byId(value) : null;
  const shown = [...(selected && !notes.slice(0, 6).some(n => n.id === selected.id) ? [selected] : []), ...notes.slice(0, 6)];
  return html`<div class="dash-note-picker">
    ${input({ id: fieldId(f.name), value: props.noteQuery?.[f.name] || '', placeholder: 'Search notes', icon: 'search', type: 'search', label: `Search notes for ${f.label}`,
      action: 'dashboard.note-query', attrs: { 'data-name': f.name }, describedBy })}
    <div class="dash-note-options" role="radiogroup" aria-label="${f.label}">
      ${shown.length ? shown.map(note => {
        const collection = note.collectionId ? ctx.select.collection(note.collectionId) : null;
        const checked = note.id === value;
        return html`<button type="button" role="radio" class="${cx('dash-note-option', checked && 'is-selected')}" aria-checked="${checked ? 'true' : 'false'}"
          tabindex="${checked || (!value && note === shown[0]) ? '0' : '-1'}" data-action="dashboard.draft-set" data-name="${f.name}" data-value="${note.id}">
          ${collectionIcon(collection, { size: 18 })}<span class="dash-note-option-title">${note.title || 'Untitled note'}</span>
          <span class="dash-note-option-meta">${relativeDate(note.updatedAt)}</span>${checked ? icon('check', { size: 14, className: 'dash-note-option-check' }) : ''}
        </button>`;
      }) : html`<p class="dash-note-empty">${query ? 'No notes match that search.' : 'You have no notes yet. Create one in Notes first.'}</p>`}
    </div>
  </div>`;
}

function listEditor(ctx, f, rows, errors) {
  const list = Array.isArray(rows) ? rows : [];
  const max = f.maxItems || 50;
  return html`<div class="dash-list" role="list" aria-label="${f.label}">
    ${list.map((row, index) => html`<div class="dash-list-row" role="listitem" data-key="${row?.id || `row-${index}`}">
      <div class="dash-list-fields">
        ${(f.itemFields || []).map(sub => {
          const name = `${f.name}.${index}.${sub.name}`;
          const value = row?.[sub.name] ?? '';
          const invalid = !!errors[name];
          if (sub.type === 'select') return select({ name, value, options: sub.options || [], action: 'dashboard.draft', label: `${sub.label} ${index + 1}`, size: 'sm', invalid });
          return input({ value, type: sub.type === 'url' ? 'url' : sub.type === 'number' ? 'number' : 'text', placeholder: sub.placeholder || sub.label, label: `${sub.label} ${index + 1}`,
            action: 'dashboard.draft', size: 'sm', invalid, attrs: { 'data-name': name, ...(sub.type === 'number' ? { 'data-type': 'number' } : {}), title: errors[name] || null } });
        })}
      </div>
      <div class="dash-list-tools">
        ${iconButton({ icon: 'arrow-up', label: `Move ${f.itemLabel || 'item'} ${index + 1} up`, size: 'sm', action: 'dashboard.list-move', disabled: index === 0, data: { name: f.name, index, dir: -1 } })}
        ${iconButton({ icon: 'arrow-down', label: `Move ${f.itemLabel || 'item'} ${index + 1} down`, size: 'sm', action: 'dashboard.list-move', disabled: index === list.length - 1, data: { name: f.name, index, dir: 1 } })}
        ${iconButton({ icon: 'x', label: `Remove ${f.itemLabel || 'item'} ${index + 1}`, size: 'sm', action: 'dashboard.list-remove', data: { name: f.name, index } })}
      </div>
    </div>`)}
    ${list.some((_, index) => (f.itemFields || []).some(sub => errors[`${f.name}.${index}.${sub.name}`]))
      ? html`<p class="field-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${Object.entries(errors).find(([key]) => key.startsWith(`${f.name}.`))?.[1]}</span></p>` : ''}
    ${list.length < max ? button({ label: f.addLabel || 'Add', icon: 'plus', size: 'sm', variant: 'ghost', action: 'dashboard.list-add', data: { name: f.name }, className: 'dash-list-add' }) : ''}
  </div>`;
}

function renderField(ctx, f, props) {
  const { draft, errors } = props;
  const value = readPath(draft, f.name) ?? f.default;
  const id = fieldId(f.name);
  const error = errors[f.name];
  const describedBy = error ? `${id}-error` : f.hint ? `${id}-hint` : undefined;
  const common = { label: f.label, hint: f.hint, error, id };
  switch (f.type) {
    case 'toggle':
      return html`<div class="dash-settings-toggle">${switchToggle({ checked: !!value, label: f.label, description: f.hint, action: 'dashboard.draft', data: { name: f.name, type: 'boolean' }, id })}</div>`;
    case 'textarea':
      return fieldRow({ ...common, control: textarea({ id, value: value ?? '', placeholder: f.placeholder || '', rows: f.rows || 4, action: 'dashboard.draft', invalid: !!error, describedBy, attrs: { 'data-name': f.name } }) });
    case 'select':
      return fieldRow({ ...common, control: select({ id, name: f.name, value: value ?? '', options: f.options || [], action: 'dashboard.draft', invalid: !!error, describedBy, className: 'is-block' }) });
    case 'segmented':
      return fieldRow({ ...common, control: segmented({ name: f.name, value: String(value ?? ''), options: (f.options || []).map(o => ({ ...o, value: String(o.value) })), action: 'dashboard.draft-set', ariaLabel: f.label }) });
    case 'color':
      return fieldRow({ ...common, control: html`<span class="dash-color-field"><input type="color" class="dash-color-input" id="${id}" value="${/^#[\da-f]{6}$/i.test(value || '') ? value : '#4f7cff'}"
        data-input="dashboard.draft" data-name="${f.name}" aria-label="${f.label}"><code class="dash-color-value">${value || '—'}</code></span>` });
    case 'range':
      return fieldRow({ ...common, control: html`<span class="dash-range-field"><input type="range" class="dash-range" id="${id}" min="${f.min ?? 0}" max="${f.max ?? 100}" step="${f.step ?? 1}"
        value="${value ?? f.min ?? 0}" data-input="dashboard.draft" data-name="${f.name}" data-type="number" data-render="true" ${describedBy ? html`aria-describedby="${describedBy}"` : ''}>
        <output class="dash-range-value" for="${id}">${value ?? f.min ?? 0}${f.unit || ''}</output></span>` });
    case 'collection':
      return fieldRow({ ...common, control: renderCollectionPickerTrigger({ ctx, value: value || '', action: 'dashboard.draft-pick', name: f.name, id, label: f.label,
        allowInbox: f.allowInbox !== false, allowCreate: f.allowCreate !== false, placeholder: f.placeholder || 'Choose a collection' }) });
    case 'note':
      return fieldRow({ ...common, control: notePicker(ctx, f, value, props, describedBy) });
    case 'list':
      return fieldRow({ label: f.label, hint: f.hint, error: Array.isArray(value) ? undefined : error, control: listEditor(ctx, f, value, errors) });
    default: {
      const type = f.type === 'url' ? 'url' : f.type === 'number' ? 'number' : 'text';
      return fieldRow({ ...common, control: input({ id, value: value ?? '', type, placeholder: f.placeholder || '', action: 'dashboard.draft', invalid: !!error, describedBy,
        required: !!f.required, attrs: { 'data-name': f.name, ...(type === 'number' ? { 'data-type': 'number', min: f.min ?? null, max: f.max ?? null, step: f.step ?? null } : {}),
          ...(type === 'url' ? { inputmode: 'url' } : {}) } }) });
    }
  }
}

// ------------------------------------------------------------------ dialog

function renderDialog(ctx, props) {
  const found = dashboardStore.findWidget(props.widgetId);
  if (!found) {
    return dialogFrame({ name: DIALOG, title: 'Widget removed', body: emptyState({ icon: 'layout-grid', title: 'This widget is no longer on your dashboard', compact: true }),
      footer: button({ label: 'Close', action: 'overlay.dismiss' }) });
  }
  const { widget, board } = found;
  const def = getWidget(widget.type);
  const env = { ...envFor(ctx, board, widget), draft: props.draft, errors: props.errors };
  let specific = '';
  try {
    specific = def?.renderSettings ? def.renderSettings(ctx, widget, props.draft, env) : fieldsFor(ctx, def, widget).filter(f => !f.when || f.when(props.draft)).map(f => renderField(ctx, f, props));
  } catch (error) {
    console.error(error);
    specific = emptyState({ icon: 'triangle-alert', title: 'These settings could not be shown', body: 'Close this dialog and try again.', compact: true, tone: 'danger' });
  }
  const hasSpecific = Array.isArray(specific) ? specific.length > 0 : !!String(specific);
  const bareDef = def?.frame === 'bare';
  const body = html`
    ${hasSpecific ? html`<section class="dash-settings-section" aria-labelledby="wset-specific">
      <h3 class="dash-settings-heading" id="wset-specific">${icon(def?.icon || 'layout-grid', { size: 14 })}${def?.title || 'Widget'}</h3>
      <div class="dash-settings-fields">${specific}</div>
    </section>` : ''}
    <section class="dash-settings-section" aria-labelledby="wset-appearance">
      <h3 class="dash-settings-heading" id="wset-appearance">${icon('palette', { size: 14 })}Appearance</h3>
      <div class="dash-settings-fields">
        ${fieldRow({ label: 'Title', id: 'wset-title', hint: def?.title ? `Leave empty to use “${widgetTitle({ ...widget, title: '' }, def)}”.` : '',
          control: input({ id: 'wset-title', value: props.title, placeholder: widgetTitle({ ...widget, title: '' }, def), action: 'dashboard.settings-title' }) })}
        ${bareDef ? '' : html`<div class="dash-settings-toggle">${switchToggle({ checked: !props.hideTitle, label: 'Show the title bar', description: 'Hidden titles stay available to screen readers.',
          action: 'dashboard.settings-hide-title' })}</div>`}
        ${fieldRow({ label: 'Background', control: segmented({ name: 'frame', value: props.frame, options: FRAMES, action: 'dashboard.settings-frame', ariaLabel: 'Background' }),
          hint: props.frame === 'default' ? 'Follows the widget style chosen for the whole dashboard.' : '' })}
      </div>
    </section>
    ${props.formError ? html`<p class="field-error dash-settings-error" role="alert">${icon('circle-alert', { size: 14 })}<span>${props.formError}</span></p>` : ''}`;
  const footer = html`${button({ label: 'Remove widget', icon: 'trash-2', variant: 'ghost', action: 'dashboard.settings-remove', className: 'dash-settings-remove' })}
    <span class="spacer"></span>
    ${button({ label: 'Cancel', action: 'overlay.dismiss' })}
    ${button({ label: 'Save', variant: 'primary', type: 'submit', loading: props.saving })}`;
  return html`<form class="dialog-form" data-submit="dashboard.settings-save" novalidate>${dialogFrame({ name: DIALOG, title: `${widgetTitle(widget, def)} settings`, body, footer })}</form>`;
}

export function openWidgetSettings(ctx, widgetId) {
  const found = dashboardStore.findWidget(widgetId);
  if (!found) { ctx.toast('That widget is no longer on your dashboard.', { tone: 'danger' }); return; }
  const { widget } = found;
  const def = getWidget(widget.type);
  const draft = structuredClone(widget.config || {});
  const holder = {
    widget,
    draft,
    set(patch = {}, { render = true } = {}) {
      const current = entry(ctx);
      if (!current) return;
      const errors = { ...current.props.errors };
      for (const [key, value] of Object.entries(patch)) {
        writePath(draft, key, value);
        for (const name of Object.keys(errors)) if (name === key || name.startsWith(`${key}.`)) delete errors[name];
      }
      current.props.errors = errors;
      if (render) ctx.updateDialog(DIALOG, { errors });
    },
    render() { ctx.updateDialog(DIALOG, {}); },
  };
  bindSettingsDraft(holder);
  ctx.openDialog(DIALOG, {
    widgetId, draft, title: widget.title || '', hideTitle: !!widget.style?.hideTitle, frame: widget.style?.frame || 'default', errors: {}, noteQuery: {},
    saving: false, formError: '', size: def?.settingsSize || (def?.renderSettings ? 'lg' : 'md'),
    onClose: () => { if (getSettingsDraft() === holder) bindSettingsDraft(null); },
  });
}
bindWidgetSettings(openWidgetSettings);

async function save(ctx) {
  const current = entry(ctx);
  if (!current || current.props.saving) return;
  const props = current.props;
  const found = dashboardStore.findWidget(props.widgetId);
  if (!found) return ctx.closeDialog(DIALOG);
  const def = getWidget(found.widget.type);
  let errors = def?.renderSettings ? {} : validateFields(fieldsFor(ctx, def, found.widget), props.draft);
  try { errors = { ...errors, ...(def?.validateSettings?.(props.draft) || {}) }; } catch (error) { console.error(error); }
  if (Object.keys(errors).length) {
    ctx.updateDialog(DIALOG, { errors, formError: '' });
    ctx.nextFrame(() => document.querySelector(`#${CSS.escape(current.id)} [aria-invalid="true"]`)?.focus());
    return;
  }
  ctx.updateDialog(DIALOG, { saving: true, formError: '' });
  try {
    const patch = def?.onSettingsSave ? await def.onSettingsSave(ctx, found.widget, props.draft) : undefined;
    const config = patch && typeof patch === 'object' ? patch : props.draft;
    const title = String(props.title || '').trim();
    await dashboardStore.updateWidget(props.widgetId, {
      title: title === (def?.title || '') ? '' : title,
      style: { frame: props.frame, hideTitle: !!props.hideTitle },
      config,
    });
    ctx.closeDialog(DIALOG);
  } catch (error) {
    console.error(error);
    ctx.updateDialog(DIALOG, { saving: false, formError: error?.message || 'These settings could not be saved. Try again.' });
  }
}

const draftHolder = () => getSettingsDraft();
const coerce = (el, raw) => {
  const type = el.dataset.type || (['number', 'range'].includes(el.type) ? 'number' : '');
  if (type === 'number') return raw === '' ? null : Number(raw);
  if (type === 'boolean') return el.type === 'checkbox' ? el.checked : raw === 'true';
  if (type === 'json') { try { return JSON.parse(raw); } catch { return raw; } }
  return el.type === 'checkbox' ? el.checked : raw;
};

registerActions({
  'dashboard.settings-save': ({ ctx }) => save(ctx),
  'dashboard.settings-title': ({ ctx, el }) => { const current = entry(ctx); if (current) current.props.title = el.value; },
  'dashboard.settings-hide-title': ({ ctx, el }) => ctx.updateDialog(DIALOG, { hideTitle: !el.checked }),
  'dashboard.settings-frame': ({ ctx, data }) => ctx.updateDialog(DIALOG, { frame: data.value }),
  'dashboard.settings-remove': async ({ ctx }) => {
    const current = entry(ctx);
    if (!current) return;
    ctx.closeDialog(DIALOG);
    await removeWidget(ctx, current.props.widgetId);
  },
  // Built-in draft actions for widget settings markup (see registry.js).
  'dashboard.draft': ({ el, event }) => {
    const holder = draftHolder();
    const name = el.dataset.name || el.name;
    if (!holder || !name) return;
    holder.set({ [name]: coerce(el, el.value) }, { render: event?.type === 'change' || el.dataset.render === 'true' });
  },
  'dashboard.draft-set': ({ ctx, data }) => {
    const holder = draftHolder();
    if (!holder || !data.name) return;
    // Generic segmented fields store their option's own value (numbers stay numbers).
    const current = entry(ctx);
    const found = current && dashboardStore.findWidget(current.props.widgetId);
    const def = found && getWidget(found.widget.type);
    const option = fieldsFor(ctx, def, found?.widget).find(f => f.name === data.name)?.options?.find(o => String(o.value) === data.value);
    const value = option ? option.value : data.type === 'number' ? Number(data.value) : data.type === 'boolean' ? data.value === 'true' : data.value;
    holder.set({ [data.name]: value });
  },
  'dashboard.draft-pick': ({ data }) => draftHolder()?.set({ [data.name]: data.value || '' }),
  'dashboard.note-query': ({ ctx, el }) => {
    const current = entry(ctx);
    if (!current) return;
    ctx.updateDialog(DIALOG, { noteQuery: { ...current.props.noteQuery, [el.dataset.name]: el.value } });
  },
  'dashboard.list-add': ({ ctx, data }) => {
    const holder = draftHolder();
    if (!holder) return;
    const current = entry(ctx);
    const found = dashboardStore.findWidget(current?.props.widgetId);
    const f = fieldsFor(ctx, found && getWidget(found.widget.type), found?.widget).find(x => x.name === data.name);
    const rows = [...(readPath(holder.draft, data.name) || [])];
    rows.push({ id: uid(), ...Object.fromEntries((f?.itemFields || []).map(sub => [sub.name, sub.default ?? ''])) });
    holder.set({ [data.name]: rows });
    ctx.nextFrame(() => [...document.querySelectorAll(`#${CSS.escape(current.id)} .dash-list-row`)].at(-1)?.querySelector('input, select')?.focus());
  },
  'dashboard.list-remove': ({ data }) => {
    const holder = draftHolder();
    if (!holder) return;
    const rows = [...(readPath(holder.draft, data.name) || [])];
    rows.splice(Number(data.index), 1);
    holder.set({ [data.name]: rows });
  },
  'dashboard.list-move': ({ data }) => {
    const holder = draftHolder();
    if (!holder) return;
    const rows = [...(readPath(holder.draft, data.name) || [])];
    const from = Number(data.index);
    const to = from + Number(data.dir);
    if (to < 0 || to >= rows.length) return;
    [rows[from], rows[to]] = [rows[to], rows[from]];
    holder.set({ [data.name]: rows });
  },
});

registerDialog(DIALOG, renderDialog, { size: 'md', className: 'dash-settings-dialog' });
