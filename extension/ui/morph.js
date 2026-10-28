// Minimal keyed DOM morph. Patches an element's children to match new markup while keeping node identity,
// so focus, caret, scroll offsets and mounted widgets survive re-renders.
//   data-key="..."        stable identity among siblings (ids are used too)
//   data-morph="skip"     keep this element and its subtree exactly as it is (editors, canvases, live chat)
//   data-morph="replace"  always rebuild this element instead of patching it
const keyOf = node => node.nodeType === 1 ? (node.getAttribute('data-key') || node.id || null) : null;
const sameKind = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName;

function toFragment(next) {
  if (next instanceof Node) return next;
  const template = document.createElement('template');
  template.innerHTML = String(next ?? '');
  return template.content;
}

function syncAttributes(from, to) {
  for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of [...to.attributes]) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
}

function syncFormState(from, to) {
  const focused = from === document.activeElement;
  if (from.nodeName === 'INPUT') {
    if (!focused && from.value !== (to.getAttribute('value') ?? '') && !['checkbox', 'radio', 'file'].includes(from.type)) from.value = to.getAttribute('value') ?? '';
    if (['checkbox', 'radio'].includes(from.type)) from.checked = to.hasAttribute('checked');
    from.indeterminate = to.hasAttribute('data-indeterminate');
  } else if (from.nodeName === 'TEXTAREA') {
    if (!focused && from.value !== to.textContent) from.value = to.textContent;
  } else if (from.nodeName === 'OPTION') {
    from.selected = to.hasAttribute('selected');
  }
}

function morphNode(from, to) {
  if (!sameKind(from, to) || (to.nodeType === 1 && to.getAttribute('data-morph') === 'replace')) {
    from.replaceWith(to);
    return to;
  }
  if (from.nodeType !== 1) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return from;
  }
  if (from.getAttribute('data-morph') === 'skip' && to.getAttribute('data-morph') === 'skip'
    && from.getAttribute('data-key') === to.getAttribute('data-key')) return from;
  syncAttributes(from, to);
  const editing = from.isContentEditable && from.contains(document.activeElement);
  if (!editing && from.nodeName !== 'TEXTAREA') morphChildren(from, to);
  syncFormState(from, to);
  return from;
}

function morphChildren(from, to) {
  const keyed = new Map();
  for (let child = from.firstChild; child; child = child.nextSibling) {
    const key = keyOf(child);
    if (key) keyed.set(key, child);
  }
  let cursor = from.firstChild;
  for (let incoming = to.firstChild; incoming;) {
    const following = incoming.nextSibling;
    const key = keyOf(incoming);
    let match = null;
    if (key) {
      match = keyed.get(key) || null;
      if (match) keyed.delete(key);
    } else if (cursor && !keyOf(cursor) && sameKind(cursor, incoming)) {
      match = cursor;
    }
    if (match) {
      if (match === cursor) cursor = cursor.nextSibling;
      else from.insertBefore(match, cursor);
      morphNode(match, incoming);
    } else {
      from.insertBefore(incoming, cursor);
    }
    incoming = following;
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}

/** Replaces target's children with `next` (string, html`` fragment, Node or DocumentFragment) by patching. */
export function morph(target, next) {
  const active = document.activeElement;
  const focusKey = active && target.contains(active) ? (active.getAttribute('data-focus-key') || active.id) : null;
  const selection = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  morphChildren(target, toFragment(next));
  if (focusKey && !target.contains(document.activeElement)) {
    const again = target.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`) || target.querySelector(`#${CSS.escape(focusKey)}`);
    if (again) {
      again.focus({ preventScroll: true });
      if (selection && 'setSelectionRange' in again) try { again.setSelectionRange(...selection); } catch {}
    }
  }
  return target;
}
