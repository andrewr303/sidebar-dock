// Edit mode: drag a widget by its header, resize it from its right edge, bottom edge or corner (pointer events with
// pointer capture), auto-scroll near the edges, keyboard moves and resizes, Tidy up and leaving edit mode.
// While the pointer moves, frames are repositioned directly in the DOM (no app render); the drop commits one layout
// write with applyLayout and the following render agrees with what is already on screen.
import { registerActions, registerShortcuts } from '../runtime.js';
import * as dashboardStore from '../../lib/dashboard-store.js';
import { getWidget } from './registry.js';
import { moveWidget, resizeWidget, nudgeWidget, compact, layoutChanges, cellAt, spanFor, GRID_COLS } from './grid.js';
import { dashUi, storedLayout, setLayoutPreview, canEdit } from './state.js';
import { setDragVisual, snapshotFrames, playFlip, animateNextLayout, reducedMotion } from './motion.js';
import { removeWidget, widgetTitle } from './frame.js';

const DRAG_THRESHOLD = 4;
const EDGE = 64;

let session = null;

function metricsOf(grid) {
  const style = getComputedStyle(grid);
  const gap = parseFloat(style.columnGap) || 0;
  const rowHeight = parseFloat(style.gridAutoRows) || 72;
  const rect = grid.getBoundingClientRect();
  return { cols: GRID_COLS, gap, rowHeight, colWidth: (rect.width - gap * (GRID_COLS - 1)) / GRID_COLS };
}
const cellLeft = (x, m) => x * (m.colWidth + m.gap);
const cellTop = (y, m) => y * (m.rowHeight + m.gap);
const place = (el, r) => {
  el.style.gridColumn = `${r.x + 1} / span ${r.w}`;
  el.style.gridRow = `${r.y + 1} / span ${r.h}`;
};
const frameEl = (grid, id) => grid.querySelector(`:scope > [data-widget-id="${CSS.escape(id)}"]`);
const position = r => `column ${r.x + 1}, row ${r.y + 1}`;

function announce(ctx, text) {
  dashUi(ctx).announce = text;
  ctx.render();
}

/** Writes the previewed rects into the DOM, animating the widgets that make room. */
function applyPreview(s, next) {
  const before = snapshotFrames(s.grid);
  s.preview = next;
  for (const r of next) {
    const el = frameEl(s.grid, r.id);
    if (el) place(el, r);
  }
  const target = next.find(r => r.id === s.id);
  if (s.placeholder && target) { place(s.placeholder, target); s.placeholder.hidden = false; }
  setLayoutPreview({ boardId: s.boardId, rects: next });
  playFlip(before, { skip: s.id, grid: s.grid, duration: 180 });
  const badge = s.frame.querySelector('.widget-size-badge');
  if (badge && target) badge.textContent = `${target.w} × ${target.h}`;
}

function update() {
  const s = session;
  if (!s) return;
  const dx = s.lastX - s.startX;
  const dy = s.lastY - s.startY + (s.scroller.scrollTop - s.startScroll);
  if (!s.active) {
    if (Math.hypot(s.lastX - s.startX, s.lastY - s.startY) < DRAG_THRESHOLD) return;
    s.active = true;
    s.frame.classList.add(s.kind === 'move' ? 'is-moving' : 'is-resizing');
    s.dashboard.classList.add('is-dragging');
    document.documentElement.classList.add('is-dashboard-dragging');
  }
  const m = s.m;
  if (s.kind === 'move') {
    const px = cellLeft(s.item.x, m) + dx;
    const py = cellTop(s.item.y, m) + dy;
    const cell = cellAt(px, py, m, s.item.w);
    const current = s.preview.find(r => r.id === s.id);
    if (cell.x !== current.x || cell.y !== current.y) applyPreview(s, moveWidget(s.base, s.id, cell));
    const placed = s.preview.find(r => r.id === s.id);
    const tx = px - cellLeft(placed.x, m);
    const ty = py - cellTop(placed.y, m);
    s.frame.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px)`;
    setDragVisual({ id: s.id, kind: 'move', tx, ty });
    return;
  }
  const widthPx = s.item.w * m.colWidth + (s.item.w - 1) * m.gap + (s.edge.includes('e') ? dx : 0);
  const heightPx = s.item.h * m.rowHeight + (s.item.h - 1) * m.gap + (s.edge.includes('s') ? dy : 0);
  const limits = s.def?.size || {};
  const w = Math.max(limits.minW || 1, Math.min(limits.maxW || GRID_COLS, GRID_COLS - s.item.x, spanFor(widthPx, m.colWidth, m.gap)));
  const h = Math.max(limits.minH || 1, Math.min(limits.maxH || 40, spanFor(heightPx, m.rowHeight, m.gap)));
  const current = s.preview.find(r => r.id === s.id);
  if (w !== current.w || h !== current.h) applyPreview(s, resizeWidget(s.base, s.id, { w, h }, GRID_COLS, limits));
  setDragVisual({ id: s.id, kind: 'resize', tx: 0, ty: 0 });
}

function autoScroll() {
  const s = session;
  if (!s) return;
  if (s.active) {
    const box = s.scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : s.scroller.getBoundingClientRect();
    let velocity = 0;
    if (s.lastY < box.top + EDGE) velocity = -(box.top + EDGE - s.lastY) / 3;
    else if (s.lastY > box.bottom - EDGE) velocity = (s.lastY - (box.bottom - EDGE)) / 3;
    if (velocity) {
      const before = s.scroller.scrollTop;
      s.scroller.scrollTop += Math.max(-28, Math.min(28, velocity));
      if (s.scroller.scrollTop !== before) update();
    }
  }
  s.raf = requestAnimationFrame(autoScroll);
}

function start(ctx, event) {
  if (event.button !== 0 || session || !(event.target instanceof Element)) return;
  const dashboard = event.target.closest('.dashboard.is-editing');
  if (!dashboard || !canEdit(ctx)) return;
  const resize = event.target.closest('[data-resize]');
  const handle = !resize && event.target.closest('[data-drag-handle]');
  if (!resize && !handle) return;
  if (!resize && event.target.closest('button, a[href], input, select, textarea')) return;
  const frame = event.target.closest('.widget');
  const grid = frame?.parentElement;
  const board = dashboardStore.activeBoard();
  const id = frame?.dataset.widgetId;
  const widget = board?.widgets.find(w => w.id === id);
  if (!frame || !grid?.classList.contains('dash-grid') || !widget) return;
  event.preventDefault();
  const base = storedLayout(board);
  const scroller = document.getElementById('main') || document.scrollingElement;
  session = {
    ctx, kind: resize ? 'resize' : 'move', edge: resize?.dataset.resize || '', id, boardId: board.id, base, preview: base,
    item: base.find(r => r.id === id), def: getWidget(widget.type), title: widgetTitle(widget), frame, grid, dashboard, scroller, m: metricsOf(grid),
    placeholder: dashboard.querySelector('.dash-placeholder'), startX: event.clientX, startY: event.clientY, lastX: event.clientX,
    lastY: event.clientY, startScroll: scroller.scrollTop, pointerId: event.pointerId, active: false, raf: 0,
  };
  frame.focus({ preventScroll: true });
  try { frame.setPointerCapture(event.pointerId); } catch { /* the pointer may already be gone */ }
  setLayoutPreview({ boardId: board.id, rects: base });
  session.raf = requestAnimationFrame(autoScroll);
}

function move(event) {
  if (!session || event.pointerId !== session.pointerId) return;
  session.lastX = event.clientX;
  session.lastY = event.clientY;
  update();
}

async function finish(event, { cancel = false } = {}) {
  const s = session;
  if (!s || (event && event.pointerId !== s.pointerId)) return;
  session = null;
  cancelAnimationFrame(s.raf);
  try { s.frame.releasePointerCapture(s.pointerId); } catch { /* already released */ }
  s.frame.classList.remove('is-moving', 'is-resizing');
  s.dashboard.classList.remove('is-dragging');
  document.documentElement.classList.remove('is-dashboard-dragging');
  if (s.placeholder) s.placeholder.hidden = true;
  setDragVisual(null);
  const { ctx } = s;
  if (!s.active) { setLayoutPreview(null); return; }
  const rects = cancel ? s.base : s.preview;
  // Glide the dropped widget from under the pointer into its cell.
  const offset = s.frame.style.transform;
  s.frame.style.transform = '';
  if (offset && !reducedMotion()) s.frame.animate([{ transform: offset }, { transform: 'translate(0, 0)' }], { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  if (cancel) applyPreview(s, s.base);
  const changes = layoutChanges(s.base, rects);
  setLayoutPreview({ boardId: s.boardId, rects });
  try {
    if (changes.length) await dashboardStore.applyLayout(s.boardId, changes);
  } finally {
    setLayoutPreview(null);
  }
  const placed = rects.find(r => r.id === s.id);
  if (changes.length && placed) announce(ctx, s.kind === 'move' ? `Moved ${s.title} to ${position(placed)}` : `Resized ${s.title} to ${placed.w} by ${placed.h}`);
  else ctx.render();
}

// ------------------------------------------------------------------ keyboard

async function keyboard(ctx, el, event) {
  if (event.target !== el || !dashUi(ctx).editing || !canEdit(ctx)) return;
  const id = el.dataset.widgetId;
  const board = dashboardStore.activeBoard();
  const widget = board?.widgets.find(w => w.id === id);
  if (!widget) return;
  const title = widgetTitle(widget);
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[event.key]) {
    event.preventDefault();
    const [dx, dy] = arrows[event.key];
    const base = storedLayout(board);
    const item = base.find(r => r.id === id);
    const def = getWidget(widget.type);
    const next = event.shiftKey ? resizeWidget(base, id, { w: item.w + dx, h: item.h + dy }, GRID_COLS, def?.size) : nudgeWidget(base, id, dx, dy, GRID_COLS);
    const changes = layoutChanges(base, next);
    const placed = next.find(r => r.id === id);
    if (!changes.length) return announce(ctx, event.shiftKey ? `${title} cannot be resized further that way` : `${title} cannot move further that way`);
    animateNextLayout(ctx);
    await dashboardStore.applyLayout(board.id, changes);
    announce(ctx, event.shiftKey ? `Resized ${title} to ${placed.w} by ${placed.h}` : `Moved ${title} to ${position(placed)}`);
    ctx.nextFrame(() => el.isConnected && el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }));
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    const frames = [...document.querySelectorAll('.dash-grid > .widget')];
    const next = frames[frames.indexOf(el) + 1] || frames[frames.indexOf(el) - 1];
    await removeWidget(ctx, id);
    ctx.nextFrame(() => (next?.isConnected ? next : document.querySelector('.dash-actions [data-action="dashboard.add-widget"]'))?.focus({ preventScroll: true }));
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    ctx.dispatch('dashboard.widget-settings', { data: { widget: id } });
  }
}

/** Turns edit mode on or off, keeping focus on the toggle (it changes from "Edit layout" to "Done"). */
export function setEditing(ctx, on) {
  const ui = dashUi(ctx);
  if (on && !canEdit(ctx)) {
    ctx.toast('Widen the window to rearrange widgets.', { tone: 'warning' });
    return;
  }
  ui.editing = !!on;
  ui.search = { ...ui.search, open: false };
  ui.announce = on ? 'Editing layout' : 'Layout saved';
  ctx.render();
  ctx.nextFrame(() => document.querySelector('.dash-actions [data-action="dashboard.edit"]')?.focus({ preventScroll: true }));
}

async function tidy(ctx) {
  const board = dashboardStore.activeBoard();
  if (!board) return;
  const base = storedLayout(board);
  const changes = layoutChanges(base, compact(base));
  if (!changes.length) { ctx.toast('Everything is already tidy.'); return; }
  animateNextLayout(ctx);
  await dashboardStore.applyLayout(board.id, changes);
  announce(ctx, 'Moved widgets up to close the gaps');
}

registerActions({
  'dashboard.edit': ({ ctx }) => {
    if (ctx.state.view !== 'dashboard') { ctx.navigate('dashboard'); return setEditing(ctx, true); }
    return setEditing(ctx, !dashUi(ctx).editing);
  },
  'dashboard.edit-exit': ({ ctx }) => setEditing(ctx, false),
  'dashboard.tidy': ({ ctx }) => tidy(ctx),
  'dashboard.frame-key': ({ ctx, el, event }) => keyboard(ctx, el, event),
});

registerShortcuts([
  { keys: 'escape', action: 'dashboard.edit-exit', label: 'Leave dashboard edit mode',
    when: ctx => ctx.state.view === 'dashboard' && !!ctx.state.dash?.editing && !ctx.state.dialogs.length && !ctx.state.popover },
]);

let wired = false;
/** Pointer wiring for drag and resize (once, from the dashboard's init). */
export function initEdit(ctx) {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  document.addEventListener('pointerdown', event => start(ctx, event));
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', event => finish(event));
  document.addEventListener('pointercancel', event => finish(event, { cancel: true }));
  document.addEventListener('keydown', event => {
    if (session && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null, { cancel: true }); }
  }, true);
}
