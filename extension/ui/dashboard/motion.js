// Dashboard motion: the dragged widget's live offset (read by the frame renderer so a re-render mid-drag keeps it under
// the pointer) and FLIP animations that glide widgets to their new cells when the layout changes.

let visual = null;
/** { id, kind: 'move' | 'resize', tx, ty } while a widget is being dragged or resized, else null. */
export const dragVisual = () => visual;
export const setDragVisual = value => { visual = value; };

export const reducedMotion = () => !!(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  || globalThis.document?.documentElement.dataset.motion === 'reduced');

const EASE = 'cubic-bezier(0.2, 0, 0, 1)';

/** Positions of the widget frames relative to their grid (so page scroll between snapshots does not count). */
export function snapshotFrames(grid = document.querySelector('.dash-grid')) {
  const out = new Map();
  if (!grid) return out;
  const origin = grid.getBoundingClientRect();
  for (const el of grid.querySelectorAll(':scope > .widget')) {
    const rect = el.getBoundingClientRect();
    out.set(el.dataset.widgetId, { left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height });
  }
  return out;
}

/** Animates frames from their snapshot positions to where they are now. Returns true when anything moved. */
export function playFlip(before, { skip = '', grid = document.querySelector('.dash-grid'), duration = 220 } = {}) {
  if (!grid || !before?.size) return false;
  const after = snapshotFrames(grid);
  let moved = false;
  for (const [id, now] of after) {
    const old = before.get(id);
    if (!old || id === skip) continue;
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    const sizeChanged = Math.abs(old.width - now.width) > 1 || Math.abs(old.height - now.height) > 1;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && !sizeChanged) continue;
    moved = true;
    if (reducedMotion() || Math.abs(dx) + Math.abs(dy) < 1) continue;
    const el = grid.querySelector(`:scope > [data-widget-id="${CSS.escape(id)}"]`);
    el?.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration, easing: EASE });
  }
  return moved;
}

let pending = null;
/** Call right before a stored layout change: the next render that moves widgets animates them from here. */
export function animateNextLayout() {
  if (reducedMotion() || typeof document === 'undefined') return;
  pending = { rects: snapshotFrames(), at: performance.now() };
}

/** Wires the pending FLIP to the render loop (once, from the dashboard's init). */
export function initMotion(ctx) {
  ctx.onRendered?.(() => {
    if (!pending) return;
    if (performance.now() - pending.at > 800) { pending = null; return; }
    if (playFlip(pending.rects)) pending = null;
  });
}
