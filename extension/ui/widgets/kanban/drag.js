// Pointer drag and drop for the kanban board: cards within and between columns, and columns by their header. The board
// re-renders a placeholder where the drop would land (from dragFor()), a floating copy follows the pointer, and the
// column strip and lists scroll when the pointer nears their edges. Escape cancels. Keyboard and menu commands are
// the other paths to the same moves (ui/widgets/kanban.js).
import { registerMount } from '../../runtime.js';
import { moveCard, moveColumnBefore, findCard, findColumn } from './model.js';
import { save, announce, boardById } from './store.js';

const SLOP = 5;           // px of travel before a press becomes a drag (a shorter press is a click)
const EDGE = 56;          // px from a scroll edge where auto-scroll starts
const MAX_SPEED = 18;     // px per frame

let drag = null;

/** The drag in progress on a widget, once it has started: { kind, id, target, height, width }. */
export const dragFor = widgetId => (drag?.started && drag.widgetId === widgetId ? drag : null);

const reducedMotion = () => document.documentElement.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;

function makeGhost(source, rect, kind) {
  const ghost = source.cloneNode(true);
  for (const node of [ghost, ...ghost.querySelectorAll('[id], [data-action], [data-keydown], [data-mount], [tabindex]')]) {
    node.removeAttribute('id');
    node.removeAttribute('data-action');
    node.removeAttribute('data-keydown');
    node.removeAttribute('data-mount');
    node.removeAttribute('data-key');
    if (node !== ghost) node.setAttribute('tabindex', '-1');
  }
  ghost.classList.remove('is-drag-source');
  ghost.classList.add('w-kanban-ghost', `is-${kind}`);
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  Object.assign(ghost.style, { insetInlineStart: 'auto', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  document.body.append(ghost);
  return ghost;
}

function nearestColumn(strip, x) {
  let best = null;
  let distance = Infinity;
  for (const col of strip.querySelectorAll(':scope > .w-kanban-col:not(.is-drag-source)')) {
    const r = col.getBoundingClientRect();
    const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    if (d < distance) { best = col; distance = d; }
  }
  return best;
}

function cardTarget(strip, x, y) {
  const column = nearestColumn(strip, x);
  if (!column) return null;
  let beforeId = null;
  for (const card of column.querySelectorAll('.w-kanban-list > .w-kanban-card:not(.is-drag-source)')) {
    const r = card.getBoundingClientRect();
    if (y < r.top + r.height / 2) { beforeId = card.dataset.card; break; }
  }
  return { columnId: column.dataset.column, beforeId };
}

function columnTarget(strip, x) {
  const rtl = getComputedStyle(strip).direction === 'rtl';
  for (const col of strip.querySelectorAll(':scope > .w-kanban-col:not(.is-drag-source)')) {
    const r = col.getBoundingClientRect();
    const middle = r.left + r.width / 2;
    if (rtl ? x > middle : x < middle) return { beforeId: col.dataset.column };
  }
  return { beforeId: null };
}

const sameTarget = (a, b) => !!a && !!b && a.columnId === b.columnId && a.beforeId === b.beforeId;
const speed = (distance) => Math.min(MAX_SPEED, Math.ceil(distance / 3));

registerMount('w.kanban.board', (root, ctx) => {
  const widgetId = root.dataset.widget;
  let raf = 0;

  const strip = () => root.querySelector('.w-kanban-strip');

  function retarget() {
    if (!drag?.started) return;
    const el = strip();
    if (!el) return;
    const next = drag.kind === 'card' ? cardTarget(el, drag.x, drag.y) : columnTarget(el, drag.x);
    if (next && !sameTarget(next, drag.target)) { drag.target = next; ctx.render(); }
  }

  function scrollTick() {
    raf = 0;
    if (!drag?.started) return;
    const el = strip();
    let moved = false;
    if (el) {
      const r = el.getBoundingClientRect();
      const dx = drag.x < r.left + EDGE ? -speed(r.left + EDGE - drag.x) : drag.x > r.right - EDGE ? speed(drag.x - (r.right - EDGE)) : 0;
      if (dx && el.scrollWidth > el.clientWidth) { const before = el.scrollLeft; el.scrollLeft += dx; moved ||= el.scrollLeft !== before; }
      if (drag.kind === 'card') {
        const column = nearestColumn(el, drag.x);
        const list = column?.querySelector('.w-kanban-list');
        if (list && list.scrollHeight > list.clientHeight) {
          const lr = list.getBoundingClientRect();
          const dy = drag.y < lr.top + EDGE / 2 ? -speed((lr.top + EDGE / 2 - drag.y) * 2) : drag.y > lr.bottom - EDGE / 2 ? speed((drag.y - (lr.bottom - EDGE / 2)) * 2) : 0;
          if (dy) { const before = list.scrollTop; list.scrollTop += dy; moved ||= list.scrollTop !== before; }
        }
      }
    }
    if (moved) retarget();
    raf = requestAnimationFrame(scrollTick);
  }

  function start() {
    const rect = drag.source.getBoundingClientRect();
    drag.started = true;
    drag.height = Math.round(rect.height);
    drag.width = Math.round(rect.width);
    drag.offsetX = drag.startX - rect.left;
    drag.offsetY = drag.startY - rect.top;
    drag.ghost = makeGhost(drag.source, rect, drag.kind);
    drag.rect = rect;
    document.documentElement.classList.add('is-kanban-dragging');
    globalThis.getSelection?.()?.removeAllRanges();
    retarget();
    if (!drag.target) drag.target = drag.kind === 'card' ? { columnId: drag.from.columnId, beforeId: drag.from.beforeId } : { beforeId: drag.from.beforeId };
    ctx.render();
    raf ||= requestAnimationFrame(scrollTick);
  }

  function follow() {
    if (!drag?.ghost) return;
    const tilt = drag.kind === 'card' && !reducedMotion() ? ' rotate(1.5deg)' : '';
    drag.ghost.style.transform = `translate(${Math.round(drag.x - drag.startX)}px, ${Math.round(drag.y - drag.startY)}px)${tilt}`;
  }

  function onMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.started) {
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < SLOP) return;
      start();
    }
    event.preventDefault();
    follow();
    retarget();
  }

  function teardown() {
    removeEventListener('pointermove', onMove, true);
    removeEventListener('pointerup', onUp, true);
    removeEventListener('pointercancel', onCancel, true);
    removeEventListener('keydown', onKey, true);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    document.documentElement.classList.remove('is-kanban-dragging');
  }

  // A drag ends with a click on whatever is under the pointer; swallow it so the card does not also open.
  function swallowClick() {
    const swallow = event => { event.stopPropagation(); event.preventDefault(); };
    addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0);
  }

  // The floating copy glides into the slot it was dropped on, then goes (a cancelled drag just drops it).
  function land(ghost, slot, from) {
    if (!ghost) return;
    const to = slot?.isConnected && getComputedStyle(slot).display !== 'none' ? slot.getBoundingClientRect() : null;
    if (!to || reducedMotion()) { ghost.remove(); return; }
    ghost.classList.add('is-landing');
    ghost.style.transform = `translate(${Math.round(to.left - from.left)}px, ${Math.round(to.top - from.top)}px)`;
    setTimeout(() => ghost.remove(), 170);
  }

  function finish(commit) {
    const current = drag;
    teardown();
    if (!current) return;
    drag = null;
    if (!current.started) return;
    swallowClick();
    const placeholder = root.querySelector('.w-kanban-placeholder, .w-kanban-col-placeholder');
    land(current.ghost, commit ? placeholder : null, current.rect);
    if (!commit || !current.target) { ctx.render(); return; }
    const { kind, id, target } = current;
    ctx.run(async () => {
      const board = boardById(widgetId);
      if (kind === 'card') {
        const next = await save(ctx, widgetId, b => moveCard(b, id, target.columnId, target.beforeId));
        const card = board && findCard(board, id);
        const column = next && findColumn(next, target.columnId);
        if (next && card && column) announce(ctx, widgetId, card.columnId === column.id ? `Moved “${card.title}” within ${column.title}.` : `Moved “${card.title}” to ${column.title}.`);
      } else {
        const next = await save(ctx, widgetId, b => moveColumnBefore(b, id, target.beforeId));
        const column = next && findColumn(next, id);
        if (column) announce(ctx, widgetId, `Moved the ${column.title} column to position ${next.columns.indexOf(column) + 1} of ${next.columns.length}.`);
      }
    });
  }

  function onUp(event) { if (drag && event.pointerId === drag.pointerId) finish(true); }
  function onCancel(event) { if (drag && event.pointerId === drag.pointerId) finish(false); }
  function onKey(event) {
    if (event.key !== 'Escape' || !drag) return;
    event.preventDefault();
    event.stopPropagation();
    finish(false);
  }

  function onDown(event) {
    if (drag || event.button !== 0 || event.pointerType === 'touch' || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest('input, textarea, select, a, [contenteditable], .w-kanban-card-menu, .w-kanban-col-menu, .w-kanban-col-foot, .w-kanban-filter')) return;
    const card = target.closest('.w-kanban-card');
    const head = !card && target.closest('.w-kanban-col-head');
    const source = card || head?.closest('.w-kanban-col');
    if (!source || !root.contains(source)) return;
    const board = boardById(widgetId);
    if (!board) return;
    let from;
    if (card) {
      const list = board.cards.filter(c => c.columnId === card.closest('.w-kanban-col')?.dataset.column);
      const index = list.findIndex(c => c.id === card.dataset.card);
      from = { columnId: card.closest('.w-kanban-col')?.dataset.column, beforeId: list[index + 1]?.id || null };
    } else {
      const index = board.columns.findIndex(c => c.id === source.dataset.column);
      from = { beforeId: board.columns[index + 1]?.id || null };
    }
    drag = {
      kind: card ? 'card' : 'column', widgetId, id: card ? card.dataset.card : source.dataset.column, source, from,
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, started: false, target: null,
    };
    addEventListener('pointermove', onMove, true);
    addEventListener('pointerup', onUp, true);
    addEventListener('pointercancel', onCancel, true);
    addEventListener('keydown', onKey, true);
  }

  root.addEventListener('pointerdown', onDown);
  // Native drag of text or images inside a card would fight the pointer drag.
  const onNativeDrag = event => { if (event.target instanceof Element && event.target.closest('.w-kanban-card, .w-kanban-col-head')) event.preventDefault(); };
  root.addEventListener('dragstart', onNativeDrag);
  return {
    destroy() {
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('dragstart', onNativeDrag);
      if (drag?.widgetId === widgetId) { drag.ghost?.remove(); teardown(); drag = null; }
    },
  };
});
