// Escape scopes for the kanban dialogs: Escape inside a nested piece of a dialog (a color picker, the new-label form,
// a search that has text) closes or clears that piece instead of the whole dialog. The overlay takes Escape in the
// document's capture phase, so a scope listens one step earlier (window, capture) for keys pressed inside its element
// and stops them there.
//   <div data-mount="w.kanban.escape" data-escape="<action>" [data-escape-when="value"] ...>
// data-escape-when="value" only takes Escape while the focused field has text. The action receives the scope element
// (and its dataset) like any other action.
import { registerMount } from '../../runtime.js';

registerMount('w.kanban.escape', (el, ctx) => {
  const onKey = event => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || !el.dataset.escape || !el.contains(event.target)) return;
    if (el.dataset.escapeWhen === 'value' && !event.target?.value) return;
    event.preventDefault();
    event.stopPropagation();
    ctx.run(() => ctx.dispatch(el.dataset.escape, { el, event, data: el.dataset }));
  };
  addEventListener('keydown', onKey, true);
  return { destroy() { removeEventListener('keydown', onKey, true); } };
});
