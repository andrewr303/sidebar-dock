// Dialogs, popovers, menus, confirm/prompt and toasts. Overlays live in ctx.state so they re-render with the app;
// this module adds focus management, Escape/outside-click dismissal, focus trapping and anchored positioning.
import { html, cx, esc } from './html.js';
import { icon } from './icons.js';
import { registerActions } from './runtime.js';
import { kbd } from './components.js';

const dialogs = new Map();
const popovers = new Map();
let ctx = null;
let runtime = null;
const restoreFocus = new WeakMap();
// The menu's anchor while one of its items runs: the item goes away with the menu, so what it opens returns focus here.
let menuOrigin = null;

/** Register a dialog body: render(ctx, props) returns the dialog's inner markup (use dialogFrame from components). */
export const registerDialog = (name, render, options = {}) => dialogs.set(name, { render, ...options });
/** Register a popover body: render(ctx, props) returns inner markup. options: { role: 'dialog'|'menu'|'listbox', className } */
export const registerPopover = (name, render, options = {}) => popovers.set(name, { render, ...options });

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
const focusables = el => [...el.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null || n === document.activeElement);
const MENU_ITEMS = '[role^="menuitem"]:not([aria-disabled="true"]), [role="option"]:not([aria-disabled="true"])';

/**
 * The element focus should go back to when something opened now closes: the focused element, or, when that goes away
 * with a menu or popover (or focus is already lost), the anchor of the menu whose item runs or of the open popover.
 */
export function focusOrigin() {
  const active = document.activeElement;
  const inPopover = !!active?.closest?.('#still-popover');
  if (active && active !== document.body && active.isConnected && !inPopover) return active;
  const pop = inPopover ? ctx?.state.popover : null;
  return menuOrigin || (pop && (pop.anchorEl || pop.opener)) || active;
}

/**
 * Focuses el, or the one element a re-render put in its place (same id, or the same data-* attributes).
 * Returns false when neither is there.
 */
export function refocus(el) {
  if (!el || el === document.body) return false;
  let target = el.isConnected ? el : null;
  if (!target && el.nodeType === 1) {
    const data = [...el.attributes].filter(a => a.name.startsWith('data-')).map(a => `[${a.name}="${CSS.escape(a.value)}"]`).join('');
    const selector = el.id ? `#${CSS.escape(el.id)}` : data && `${el.localName}${data}`;
    const matches = selector ? [...document.querySelectorAll(selector)].filter(n => n.getClientRects().length) : [];
    target = matches.length === 1 ? matches[0] : null;
  }
  if (!target) return false;
  target.focus({ preventScroll: true });
  // A control shown only on hover (a row's … button once the pointer has left) cannot take focus: the row around it can.
  if (document.activeElement !== target) target.parentElement?.closest('[tabindex], a[href], button:not([disabled])')?.focus({ preventScroll: true });
  return true;
}

export function openDialog(name, props = {}) {
  if (!dialogs.has(name)) throw new Error(`Unknown dialog: ${name}`);
  const opener = focusOrigin();
  closePopover();
  const entry = { name, props, id: `dialog-${name}-${ctx.state.dialogs.length}` };
  restoreFocus.set(entry, opener);
  ctx.state.dialogs = [...ctx.state.dialogs, entry];
  runtime.nextFrame(() => {
    const el = document.getElementById(entry.id);
    if (!el) return;
    const target = el.querySelector('[autofocus], [data-autofocus]') || focusables(el.querySelector('.dialog-body') || el)[0] || el;
    target.focus({ preventScroll: true });
    if (target.select && target.dataset.selectOnFocus !== undefined) target.select();
  });
}

/** Closes the top dialog (or the named one). Returns false if a dialog's beforeClose vetoed it. */
export function closeDialog(name) {
  const stack = ctx.state.dialogs;
  const index = name ? stack.map(d => d.name).lastIndexOf(name) : stack.length - 1;
  if (index < 0) return true;
  const entry = stack[index];
  const spec = dialogs.get(entry.name);
  if (spec?.beforeClose && spec.beforeClose(ctx, entry.props) === false) return false;
  ctx.state.dialogs = stack.filter((_, i) => i !== index);
  entry.props.onClose?.();
  const opener = restoreFocus.get(entry);
  runtime.nextFrame(() => refocus(opener));
  return true;
}
export const isDialogOpen = name => ctx.state.dialogs.some(d => !name || d.name === name);
export const updateDialog = (name, patch) => {
  ctx.state.dialogs = ctx.state.dialogs.map(d => d.name === name ? { ...d, props: { ...d.props, ...patch } } : d);
  ctx.render();
};

/**
 * Open a popover anchored to an element or a {x, y} point (context menus).
 * placement: 'bottom-start' (default) | 'bottom-end' | 'top-start' | 'right-start' | 'bottom'.
 */
export function openPopover(name, anchor, props = {}, { placement = 'bottom-start', focus = true } = {}) {
  if (!popovers.has(name)) throw new Error(`Unknown popover: ${name}`);
  const opener = document.activeElement;
  const anchorEl = anchor instanceof Element ? anchor : null;
  if (ctx.state.popover?.anchorEl && ctx.state.popover.anchorEl === anchorEl && ctx.state.popover.name === name) { closePopover(); return; }
  anchorEl?.setAttribute('aria-expanded', 'true');
  ctx.state.popover = { name, props, anchorEl, point: anchorEl ? null : anchor, placement, opener };
  runtime.nextFrame(() => {
    const el = document.getElementById('still-popover');
    if (!el || !focus) return;
    const target = el.querySelector('[autofocus], [data-autofocus]') || el.querySelector(MENU_ITEMS) || focusables(el)[0];
    target?.focus({ preventScroll: true });
  });
}
export function closePopover({ restore = true } = {}) {
  const current = ctx?.state.popover;
  if (!current) return;
  current.anchorEl?.setAttribute('aria-expanded', 'false');
  ctx.state.popover = null;
  current.props.onClose?.();
  ctx.render();
  if (restore) runtime.nextFrame(() => { const back = current.anchorEl || current.opener; if (back?.isConnected) back.focus({ preventScroll: true }); });
}

/** Generic menu: items = [{ label, icon, action, data:{...}, shortcut, danger, checked, disabled, hint } | { separator: true } | { heading }] */
export const openMenu = (anchor, items, options = {}) => openPopover('menu', anchor, { items, label: options.label || 'Menu' }, options);

export function confirm({ title, body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'default' } = {}) {
  return new Promise(resolve => openDialog('confirm', { title, body, confirmLabel, cancelLabel, tone, resolve, onClose: () => resolve(false) }));
}
export function prompt({ title, label = '', value = '', placeholder = '', confirmLabel = 'Save', multiline = false } = {}) {
  return new Promise(resolve => openDialog('prompt', { title, label, value, placeholder, confirmLabel, multiline, resolve, onClose: () => resolve(null) }));
}

let toastSeq = 0;
/** toast('Saved'), toast('Could not save', { tone: 'danger' }), toast('Moved 3 items', { action: { label: 'Undo', run } }) */
export function toast(message, { tone = 'default', action = null, actions = null, duration = tone === 'danger' ? 7000 : 4000 } = {}) {
  const buttons = (actions || (action ? [action] : [])).filter(a => a && a.label && typeof a.run === 'function').slice(0, 2);
  const root = document.getElementById('toast-root');
  if (!root) return;
  const id = `toast-${++toastSeq}`;
  const el = document.createElement('div');
  el.className = 'toast';
  el.id = id;
  el.dataset.tone = tone;
  el.setAttribute('role', tone === 'danger' ? 'alert' : 'status');
  el.innerHTML = `${icon(tone === 'danger' ? 'alert-circle' : tone === 'success' ? 'check-circle' : tone === 'warning' ? 'triangle-alert' : 'info', { size: 16 })}<span class="toast-message">${esc(message)}</span>${buttons.map((a, i) => `<button type="button" class="btn btn-ghost btn-sm toast-action" data-index="${i}">${esc(a.label)}</button>`).join('')}<button type="button" class="icon-btn icon-btn-sm toast-close" aria-label="Dismiss">${icon('x', { size: 14 })}</button>`;
  const remove = () => { el.dataset.state = 'closing'; setTimeout(() => el.remove(), 160); };
  el.querySelector('.toast-close').addEventListener('click', remove);
  for (const button of el.querySelectorAll('.toast-action')) button.addEventListener('click', async () => {
    remove();
    try { await buttons[Number(button.dataset.index)].run(); } catch (error) { toast(error.message || 'That did not work.', { tone: 'danger' }); }
  });
  root.append(el);
  while (root.children.length > 4) root.firstElementChild.remove();
  let timer = setTimeout(remove, duration);
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => { timer = setTimeout(remove, 2000); });
}

function renderMenu(_ctx, { items, label }) {
  return html`<div class="menu" role="menu" aria-label="${label}">${items.map((item, index) => item.separator
    ? html`<div class="menu-separator" role="separator"></div>`
    : item.heading ? html`<div class="menu-heading" role="presentation">${item.heading}</div>`
    : html`<button type="button" class="${cx('menu-item', item.danger && 'is-danger')}" role="${item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}"
        ${item.checked !== undefined ? html`aria-checked="${item.checked ? 'true' : 'false'}"` : ''} ${item.disabled ? html`aria-disabled="true"` : ''}
        data-action="overlay.menu-item" data-index="${index}" tabindex="-1">
        ${item.icon ? icon(item.icon, { size: 16 }) : item.checked !== undefined ? icon(item.checked ? 'check' : 'blank', { size: 16 }) : ''}
        <span class="menu-label">${item.label}</span>${item.hint ? html`<span class="menu-hint">${item.hint}</span>` : ''}${item.shortcut ? kbd(item.shortcut) : ''}
      </button>`)}</div>`;
}

// Destructive confirms start on Cancel so Enter never deletes by accident.
function renderConfirm(_ctx, { title, body, confirmLabel, cancelLabel, tone }) {
  const danger = tone === 'danger';
  return html`<div class="dialog-header"><h2 class="dialog-title" id="dialog-title-confirm">${title}</h2></div>
    ${body ? html`<div class="dialog-body"><p class="dialog-text">${body}</p></div>` : ''}
    <div class="dialog-footer"><button type="button" class="btn btn-secondary" data-action="overlay.confirm-cancel" ${danger ? html`data-autofocus` : ''}>${cancelLabel}</button>
      <button type="button" class="${cx('btn', danger ? 'btn-danger' : 'btn-primary')}" data-action="overlay.confirm-ok" ${danger ? '' : html`data-autofocus`}>${confirmLabel}</button></div>`;
}
function renderPrompt(_ctx, { title, label, value, placeholder, confirmLabel, multiline }) {
  return html`<form data-submit="overlay.prompt-ok" class="dialog-form"><div class="dialog-header"><h2 class="dialog-title" id="dialog-title-prompt">${title}</h2></div>
    <div class="dialog-body"><label class="field"><span class="field-label">${label || title}</span>
      ${multiline ? html`<textarea class="textarea" name="value" rows="4" placeholder="${placeholder}" data-autofocus>${value}</textarea>`
        : html`<input class="input" name="value" value="${value}" placeholder="${placeholder}" data-autofocus data-select-on-focus autocomplete="off">`}</label></div>
    <div class="dialog-footer"><button type="button" class="btn btn-secondary" data-action="overlay.dismiss">Cancel</button><button type="submit" class="btn btn-primary">${confirmLabel}</button></div></form>`;
}

/** View fragment for app.js: dialogs stack + one popover. */
export function renderOverlays(viewCtx) {
  const stack = viewCtx.state.dialogs;
  const pop = viewCtx.state.popover;
  const popSpec = pop && popovers.get(pop.name);
  return html`${stack.map((entry, i) => {
    const spec = dialogs.get(entry.name);
    const size = entry.props.size || spec.size || 'md';
    return html`<div class="dialog-layer" data-key="${entry.id}-layer" style="z-index:${100 + i * 2}">
      <div class="dialog-backdrop" data-action="overlay.backdrop" data-dialog="${entry.name}"></div>
      <div class="${cx('dialog', spec.className)}" id="${entry.id}" data-key="${entry.id}" role="${spec.role || 'dialog'}" aria-modal="true"
        aria-labelledby="dialog-title-${entry.name}" data-size="${size}" tabindex="-1">${spec.render(viewCtx, entry.props)}</div></div>`;
  })}${popSpec ? html`<div class="${cx('popover', popSpec.className)}" id="still-popover" data-key="popover-${pop.name}" role="${popSpec.role === 'menu' ? 'none' : popSpec.role || 'dialog'}"
      data-placement="${pop.placement}" style="position:fixed;left:-9999px;top:0;z-index:${101 + stack.length * 2}">${popSpec.render(viewCtx, pop.props)}</div>` : ''}`;
}

function place() {
  const pop = ctx.state.popover;
  const el = document.getElementById('still-popover');
  if (!pop || !el) return;
  if (pop.anchorEl && !pop.anchorEl.isConnected) { closePopover({ restore: false }); return; }
  const rect = pop.anchorEl ? pop.anchorEl.getBoundingClientRect() : { left: pop.point.x, right: pop.point.x, top: pop.point.y, bottom: pop.point.y, width: 0, height: 0 };
  const gap = 6, margin = 8, vw = innerWidth, vh = innerHeight;
  const box = el.getBoundingClientRect();
  let [side, align] = pop.placement.split('-');
  let top = side === 'top' ? rect.top - box.height - gap : side === 'right' ? rect.top : rect.bottom + gap;
  let left = side === 'right' ? rect.right + gap : align === 'end' ? rect.right - box.width : align === 'start' ? rect.left : rect.left + rect.width / 2 - box.width / 2;
  if (side === 'bottom' && top + box.height > vh - margin && rect.top - box.height - gap > margin) top = rect.top - box.height - gap;
  if (side === 'top' && top < margin) top = rect.bottom + gap;
  if (side === 'right' && left + box.width > vw - margin) left = rect.left - box.width - gap;
  left = Math.max(margin, Math.min(left, vw - box.width - margin));
  top = Math.max(margin, Math.min(top, vh - box.height - margin));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.maxHeight = `${vh - margin * 2}px`;
}

// Markup cannot set a checkbox's indeterminate state; mirror data-indeterminate onto the property so assistive tech reads "mixed".
const indeterminate = new Set();
function syncIndeterminate() {
  for (const input of indeterminate) {
    if (input.isConnected && input.hasAttribute('data-indeterminate')) continue;
    input.indeterminate = false;
    indeterminate.delete(input);
  }
  for (const input of document.querySelectorAll('input[type="checkbox"][data-indeterminate]')) { input.indeterminate = true; indeterminate.add(input); }
}

function moveMenuFocus(menu, delta, absolute) {
  const items = [...menu.querySelectorAll(MENU_ITEMS)];
  if (!items.length) return;
  const index = items.indexOf(document.activeElement);
  const next = absolute !== undefined ? (absolute < 0 ? items.length - 1 : 0) : (index + delta + items.length) % items.length;
  items[next].focus();
}

export function initOverlays(appCtx, appRuntime) {
  ctx = appCtx;
  runtime = appRuntime;
  ctx.state.dialogs ||= [];
  ctx.state.popover ||= null;
  registerPopover('menu', renderMenu, { role: 'menu', className: 'popover-menu' });
  registerDialog('confirm', renderConfirm, { size: 'sm', role: 'alertdialog' });
  registerDialog('prompt', renderPrompt, { size: 'sm' });
  runtime.onRendered(place);
  runtime.onRendered(syncIndeterminate);
  addEventListener('resize', () => ctx.state.popover && place());

  registerActions({
    'overlay.dismiss': () => closeDialog(),
    'overlay.backdrop': ({ data }) => { const spec = dialogs.get(data.dialog); if (spec?.dismissable !== false) closeDialog(data.dialog); },
    'overlay.confirm-ok': () => { const top = ctx.state.dialogs.at(-1); const resolve = top.props.resolve; top.props.onClose = null; closeDialog(); resolve(true); },
    'overlay.confirm-cancel': () => closeDialog(),
    'overlay.prompt-ok': ({ el }) => { const top = ctx.state.dialogs.at(-1); const value = new FormData(el).get('value'); const resolve = top.props.resolve; top.props.onClose = null; closeDialog(); resolve(String(value ?? '')); },
    'overlay.menu-item': async ({ data, event }) => {
      const pop = ctx.state.popover;
      const item = pop?.props.items?.[Number(data.index)];
      if (!item || item.disabled) return;
      const anchor = pop.anchorEl;
      menuOrigin = anchor || pop.opener;
      closePopover({ restore: !item.keepFocus });
      try {
        if (item.run) await item.run(event);
        else if (item.action) await ctx.dispatch(item.action, { el: anchor || document.body, event, ctx, data: { ...(item.data || {}) } });
      } finally { menuOrigin = null; }
    },
  });

  // Roving arrow keys for segmented controls (radiogroup) and tab lists: move focus and activate (click) the next option.
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const option = event.target.closest?.('[role="radio"], [role="tab"]');
    const group = option?.parentElement?.closest('[role="radiogroup"], [role="tablist"]');
    if (!group || !group.contains(option) || option.closest('[role="menu"], [role="listbox"]')) return;
    const horizontal = group.getAttribute('aria-orientation') !== 'vertical';
    const keys = group.getAttribute('role') === 'radiogroup' ? ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
      : horizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    if (![...keys, 'Home', 'End'].includes(event.key)) return;
    const role = option.getAttribute('role');
    const options = [...group.querySelectorAll(`[role="${role}"]`)].filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    const index = options.indexOf(option);
    if (index < 0) return;
    const rtl = getComputedStyle(group).direction === 'rtl';
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const next = event.key === 'Home' ? options[0] : event.key === 'End' ? options.at(-1)
      : options[(index + (event.key.startsWith('ArrowLeft') || event.key.startsWith('ArrowRight') ? (rtl ? -step : step) : step) + options.length) % options.length];
    event.preventDefault();
    if (!next || next === option) return;
    next.focus();
    next.click();
  });

  document.addEventListener('pointerdown', event => {
    const pop = ctx.state.popover;
    if (!pop) return;
    const el = document.getElementById('still-popover');
    if (el?.contains(event.target) || pop.anchorEl?.contains(event.target)) return;
    closePopover({ restore: false });
  }, true);

  document.addEventListener('keydown', event => {
    const popEl = document.getElementById('still-popover');
    if (event.key === 'Escape') {
      if (ctx.state.popover) { event.preventDefault(); event.stopPropagation(); closePopover(); return; }
      const top = ctx.state.dialogs.at(-1);
      if (top && dialogs.get(top.name)?.dismissable !== false) { event.preventDefault(); event.stopPropagation(); closeDialog(); }
      return;
    }
    if (popEl && popEl.contains(document.activeElement)) {
      const menu = popEl.querySelector('[role="menu"], [role="listbox"]');
      if (menu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !event.target.matches('input, textarea')) {
        event.preventDefault();
        moveMenuFocus(menu, event.key === 'ArrowDown' ? 1 : -1, event.key === 'Home' ? 0 : event.key === 'End' ? -1 : undefined);
        return;
      }
      if (event.key === 'Tab' && menu && popEl.getAttribute('role') === 'none') { closePopover({ restore: false }); return; }
    }
    if (event.key === 'Tab') {
      const top = ctx.state.dialogs.at(-1);
      const el = top && document.getElementById(top.id);
      if (!el || ctx.state.popover) return;
      const list = focusables(el);
      if (!list.length) { event.preventDefault(); el.focus(); return; }
      const first = list[0], last = list.at(-1);
      if (event.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
  }, true);
}
