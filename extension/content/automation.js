// The page side of the quiet browser engine (lib/browser/quiet.js). The service worker injects this file into a tab's
// isolated world when the assistant works there, and calls __stillAutomation.run(name, args). It reads the page as an
// outline, finds the element a call names, says what kind of control it is, and acts on it with DOM events.
//
// No chrome.debugger is involved, so Chrome shows no debugging bar. The price: input is made by script (pages see
// isTrusted false), native dialogs cannot be answered, and frames of other sites are not read.
//
// Rules kept from the browser control layer: a ref names one element of this document and fails once the element is
// gone; observing changes nothing; a password, card number or code is never returned; every result is plain data.
// A classic script: no import, no export. Running it twice keeps the first copy and its refs.
(() => {
  if (globalThis.__stillAutomation) return;

  const refs = new Map();
  const refOf = new WeakMap();
  let counter = 0;
  const documentId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const MASK = '••••••';
  const clean = (value, max = 200) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
  const fail = (code, message) => ({ ok: false, code, message });

  // ------------------------------------------------------------------------------------------------ what an element is
  const INPUT_ROLES = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    search: 'searchbox', file: 'button', hidden: '' };
  const HEADING = /^H[1-6]$/;
  const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem']);

  function roleOf(el) {
    const explicit = clean(el.getAttribute('role')).split(' ')[0].toLowerCase();
    if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit;
    const tag = el.tagName;
    if (tag === 'A' || tag === 'AREA') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'INPUT') { const type = (el.getAttribute('type') || 'text').toLowerCase(); return type in INPUT_ROLES ? INPUT_ROLES[type] : el.hasAttribute('list') ? 'combobox' : 'textbox'; }
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'OPTION') return 'option';
    if (HEADING.test(tag)) return 'heading';
    if (tag === 'IMG') return el.getAttribute('alt') ? 'img' : '';
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return 'textbox';
    return '';
  }

  const textOf = (el, max) => clean(el.innerText ?? el.textContent, max);

  function nameOf(el) {
    const labelled = clean(el.getAttribute('aria-labelledby'));
    if (labelled) {
      const text = labelled.split(' ').map(id => { const node = el.getRootNode().getElementById?.(id) || document.getElementById(id); return node ? textOf(node, 120) : ''; }).filter(Boolean).join(' ');
      if (text) return clean(text, 120);
    }
    const aria = clean(el.getAttribute('aria-label'), 120);
    if (aria) return aria;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(type)) return clean(el.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''), 120);
      if (tag === 'INPUT' && type === 'image') return clean(el.getAttribute('alt') || el.getAttribute('title') || 'Submit', 120);
      const label = [...(el.labels || [])].map(node => textOf(node, 120)).filter(Boolean).join(' ');
      return clean(label || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '', 120);
    }
    if (tag === 'IMG') return clean(el.getAttribute('alt'), 120);
    return clean(textOf(el, 120) || el.getAttribute('title') || el.querySelector?.('img[alt]')?.getAttribute('alt') || '', 120);
  }

  function visible(el) {
    if (!el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (el.tagName === 'OPTION') return true;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || style.display === 'contents';
  }

  const SECRET_HINT = /passw|passcode|\botp\b|one.?time|verification.?code|security.?code|\bcvv\b|\bcvc\b|\bcsc\b|card.?(?:number|no)|cc.?num|\bpin\b/i;
  const SECRET_AUTOCOMPLETE = /current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp/;
  function isSecret(el) {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
    if ((el.getAttribute('type') || '').toLowerCase() === 'password') return true;
    if (SECRET_AUTOCOMPLETE.test((el.getAttribute('autocomplete') || '').toLowerCase())) return true;
    return SECRET_HINT.test(`${el.getAttribute('name') || ''} ${el.id || ''} ${nameOf(el)}`);
  }
  const looksLikeCard = value => { const digits = String(value).replace(/[\s-]/g, ''); return /^\d{13,19}$/.test(digits); };

  function refFor(el) {
    let ref = refOf.get(el);
    if (!ref) { ref = `q${++counter}`; refOf.set(el, ref); refs.set(ref, new WeakRef(el)); }
    return ref;
  }

  function stateOf(el, role) {
    const parts = [];
    const tag = el.tagName;
    if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton' || role === 'slider' || (role === 'combobox' && tag === 'INPUT')) {
      const value = tag === 'INPUT' || tag === 'TEXTAREA' ? el.value : textOf(el, 200);
      if (value) parts.push(`value ${isSecret(el) || looksLikeCard(value) ? MASK : `"${clean(value, 120)}"`}`);
    }
    if (tag === 'SELECT') { const chosen = [...el.selectedOptions].map(option => clean(option.label || option.text, 60)); if (chosen.length) parts.push(`selected "${chosen.join('", "')}"`); }
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      const checked = tag === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true';
      parts.push(checked ? 'checked' : 'unchecked');
    }
    if (el.getAttribute('aria-expanded')) parts.push(el.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-selected') === 'true') parts.push('selected');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    if (el.required) parts.push('required');
    return parts.length ? ` (${parts.join(', ')})` : '';
  }

  const describe = (el, role = roleOf(el)) => `${role || el.tagName.toLowerCase()} "${nameOf(el)}"`;

  // ------------------------------------------------------------------------------------------------------- the outline
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'SVG', 'PATH']);
  const shadowOf = el => { try { return globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el) || el.shadowRoot || null; } catch { return el.shadowRoot || null; } };

  /** Walks the page in reading order. visit(el, role) returns false to skip the element's subtree. */
  function walk(root, visit, notices) {
    const step = node => {
      for (const child of node.children || []) {
        if (SKIP.has(child.tagName.toUpperCase()) || !visible(child)) continue;
        const role = roleOf(child);
        if (visit(child, role) === false) continue;
        if (child.tagName === 'IFRAME' || child.tagName === 'FRAME') {
          let inner = null;
          try { inner = child.contentDocument; } catch { inner = null; }
          if (inner?.body) step(inner.body);
          else if (notices) notices.push(`a frame from ${clean(child.getAttribute('src') || 'another site', 80)} was not read`);
          continue;
        }
        const shadow = shadowOf(child);
        if (shadow) step(shadow);
        step(child);
      }
    };
    step(root);
  }

  // What makes an element more than a run of text: a control, a heading, a picture or a block inside it.
  const STRUCTURE = 'a[href],button,input,select,textarea,summary,[role],[contenteditable],h1,h2,h3,h4,h5,h6,img[alt],p,div,li,ul,ol,dl,table,tr,td,th,section,article,iframe,form,label,pre,blockquote';
  // The element's own text: its direct text nodes, not its children's.
  const ownText = el => clean([...el.childNodes].filter(node => node.nodeType === 3).map(node => node.nodeValue).join(' '), 300);

  function outline({ scope } = {}) {
    const lines = [];
    const notices = [];
    let count = 0;
    const root = scope ? resolveRef(scope) : document.body;
    if (!root) return fail('STALE_REF', 'The scope is no longer in the page.');
    if (root.ok === false) return root;
    walk(root, (el, role) => {
      if (role === 'heading') { lines.push(`heading "${nameOf(el)}" (level ${el.tagName[1] || el.getAttribute('aria-level') || 2})`); return false; }
      if (INTERACTIVE.has(role)) {
        count++;
        lines.push(`[${refFor(el)}] ${describe(el, role)}${stateOf(el, role)}`);
        // A select's options are part of the control; a listbox keeps its own.
        if (el.tagName === 'SELECT') for (const option of [...el.options].slice(0, 30)) lines.push(`  option "${clean(option.label || option.text, 80)}"${option.selected ? ' (selected)' : ''}`);
        return false;
      }
      if (role === 'img') { lines.push(`img "${nameOf(el)}"`); return false; }
      // A run of text with only inline markup inside ("Cart: <b>1 item</b>") is one line, as a person reads it.
      if (!el.querySelector(STRUCTURE)) { const whole = textOf(el, 300); if (whole) lines.push(`text "${whole}"`); return false; }
      const text = ownText(el);
      if (text) lines.push(`text "${text}"`);
      return true;
    }, notices);
    const scroller = document.scrollingElement || document.documentElement;
    const header = `${clean(document.title, 120) || '(untitled)'} · ${location.href} · viewport ${Math.round(scroller.scrollTop)}–${Math.round(scroller.scrollTop + innerHeight)} of ${Math.round(scroller.scrollHeight)} px`;
    return { ok: true, documentId, url: location.href, title: document.title, header, lines, refs: count, notices: [...new Set(notices)].slice(0, 5) };
  }

  // ------------------------------------------------------------------------------------------------ finding an element
  function resolveRef(ref) {
    const el = refs.get(String(ref))?.deref();
    if (!el) return fail('STALE_REF', `There is no element ${ref} in this page. Refs from before a navigation are gone: take a new snapshot.`);
    if (!el.isConnected) return fail('STALE_REF', `The element ${ref} is no longer in the page. Take a new snapshot.`);
    return el;
  }

  function candidates({ role, name, text, within }) {
    const root = within ? resolveRef(within) : document.body;
    if (!root || root.ok === false) return root || [];
    const wanted = clean(name).toLowerCase();
    const loose = clean(text).toLowerCase();
    const found = [];
    walk(root, (el, elRole) => {
      if (!elRole || (role && elRole !== String(role).toLowerCase())) return true;
      if (!role && !INTERACTIVE.has(elRole) && elRole !== 'heading') return true;
      const label = nameOf(el).toLowerCase();
      const value = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? (isSecret(el) ? '' : String(el.value).toLowerCase()) : '';
      if (wanted && !label.includes(wanted)) return true;
      if (loose && !label.includes(loose) && !value.includes(loose)) return true;
      found.push({ el, role: elRole, exact: !wanted || label === wanted });
      return true;
    });
    return found;
  }

  /** The one element a target names: { ref } or { role, name?, nth?, within? }. A name matches exactly, else as a part. */
  function resolve(target) {
    if (!target || typeof target !== 'object') return fail('BAD_TARGET', 'Name the element with a ref from a snapshot, or a role and name.');
    if (target.ref) return resolveRef(target.ref);
    if (!target.role) return fail('BAD_TARGET', 'This engine finds elements by ref, or by role and name.');
    const all = candidates(target);
    if (!Array.isArray(all)) return all;
    const exact = all.filter(entry => entry.exact);
    const list = exact.length ? exact : all;
    if (!list.length) return fail('NOT_FOUND', `No ${target.role}${target.name ? ` named "${clean(target.name, 80)}"` : ''} is on the page. Take a snapshot to see what is there.`);
    if (Number.isInteger(target.nth)) return list[target.nth]?.el || fail('NOT_FOUND', `There are only ${list.length} matches.`);
    if (list.length > 1) return fail('AMBIGUOUS', `${list.length} elements match: ${list.slice(0, 5).map(entry => `[${refFor(entry.el)}] ${describe(entry.el, entry.role)}`).join(', ')}. Use a ref or nth.`);
    return list[0].el;
  }

  // -------------------------------------------------------------------------------------- facts for the write decision
  const TEXT_TYPES = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number']);
  const takesText = el => el.tagName === 'TEXTAREA' || el.isContentEditable || (el.tagName === 'INPUT' && TEXT_TYPES.has((el.getAttribute('type') || '').toLowerCase()));
  const isSubmitButton = el => (el.tagName === 'BUTTON' && ['', 'submit'].includes((el.getAttribute('type') || '').toLowerCase())) || (el.tagName === 'INPUT' && ['submit', 'image'].includes((el.getAttribute('type') || '').toLowerCase()));
  const SEARCH_WORDS = /\bsearch\b|\bfind\b|搜索|查找/i;
  const MONEY = /(?:[$€£¥₹]\s?\d[\d.,]*|\d[\d.,]*\s?(?:USD|EUR|GBP|JPY|CNY|€|\$|£|¥|元))/;

  function factsOf(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const form = el.form || el.closest?.('form') || null;
    const buttons = form ? [...form.elements].filter(isSubmitButton) : [];
    const textEntry = takesText(el);
    const defaultButton = textEntry ? buttons[0] : buttons.find(button => !button.disabled);
    const fields = form ? [...form.elements].filter(node => ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) && (node.getAttribute('type') || '').toLowerCase() !== 'hidden') : [];
    const submitter = isSubmitButton(el) && !!form;
    const method = ((submitter && el.getAttribute('formmethod')) || form?.getAttribute('method') || 'get').toLowerCase();
    const searchField = type === 'search' || ['searchbox', 'combobox'].includes(roleOf(el)) || !!el.closest?.('[role="search"], search')
      || SEARCH_WORDS.test(`${el.getAttribute('name') || ''} ${el.getAttribute('placeholder') || ''} ${nameOf(el)}`);
    return {
      tag, type,
      classes: clean(`${el.getAttribute('class') || ''} ${el.getAttribute('data-testid') || ''} ${el.getAttribute('data-test') || ''} ${el.getAttribute('data-qa') || ''}`, 200),
      isLink: tag === 'a' && el.hasAttribute('href'),
      submitter,
      field: (tag === 'input' && TEXT_TYPES.has(type)) || tag === 'select',
      form: form ? {
        method, action: clean((submitter && el.getAttribute('formaction')) || form.action || location.href, 300),
        search: form.getAttribute('role') === 'search' || !!form.closest('[role="search"], search') || fields.some(node => (node.getAttribute('type') || '').toLowerCase() === 'search')
          || (fields.length === 1 && method === 'get'),
        fields: fields.length,
        blockingFields: fields.filter(node => node.tagName === 'INPUT' && TEXT_TYPES.has((node.getAttribute('type') || '').toLowerCase())).length,
        hasSubmitButton: buttons.length > 0,
        defaultButton: defaultButton ? { name: nameOf(defaultButton), disabled: !!defaultButton.disabled, accessibleName: nameOf(defaultButton) } : null,
      } : null,
      money: clean(MONEY.exec(`${textOf(el, 300)} ${el.parentElement ? textOf(el.parentElement, 600) : ''}`)?.[0] || '', 40),
      textEntry, searchField,
    };
  }

  /** What a call is about to act on, before anything is sent: the worker decides from this whether the person must agree. */
  function inspect({ target }) {
    const el = target ? resolve(target) : (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
    if (!el) return { ok: true, documentId, url: location.href, none: true };
    if (el.ok === false) return el;
    const role = roleOf(el);
    const link = el.closest?.('a[href]');
    const form = el.form || el.closest?.('form');
    return { ok: true, documentId, url: location.href, ref: refFor(el), role, name: nameOf(el), line: `[${refFor(el)}] ${describe(el, role)}`, facts: factsOf(el), secret: isSecret(el),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', visible: visible(el),
      destination: link ? link.href : isSubmitButton(el) && form ? String(form.action || '') : '', newTab: !!link && link.target === '_blank' };
  }

  // ------------------------------------------------------------------------------------------------------------ acting
  const fire = (el, type, Ctor = Event, init = {}) => el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init }));
  const pointerAt = el => { const rect = el.getBoundingClientRect(); return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, view: window }; };

  function setNative(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
  }

  function insertText(el, text, replace) {
    el.focus();
    if (el.isContentEditable) {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      if (!replace) range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      // The editor's own handlers run, as they do for typing.
      if (!document.execCommand('insertText', false, text)) { if (replace) el.textContent = text; else el.append(text); fire(el, 'input', InputEvent, { inputType: 'insertText', data: text }); }
      return 'insert-text';
    }
    setNative(el, replace ? text : `${el.value}${text}`);
    fire(el, 'input', InputEvent, { inputType: 'insertText', data: text });
    fire(el, 'change');
    return replace ? 'set-value' : 'insert-text';
  }

  function setValue(el, value) {
    const role = roleOf(el);
    const tag = el.tagName;
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      const want = value === true || value === 'true' || value === 'on' || value === 'checked';
      const now = tag === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true';
      if (want !== now) el.click();
      return { mechanism: 'script-click' };
    }
    if (tag === 'SELECT') {
      const wanted = (Array.isArray(value) ? value : [value]).map(entry => clean(entry).toLowerCase());
      const options = [...el.options];
      const picked = wanted.map(text => options.find(option => clean(option.label || option.text).toLowerCase() === text) || options.find(option => option.value.toLowerCase() === text)
        || options.find(option => clean(option.label || option.text).toLowerCase().includes(text)));
      if (picked.some(option => !option)) return fail('NOT_FOUND', `The list has no option ${JSON.stringify(value)}. Its options: ${options.slice(0, 20).map(option => `"${clean(option.label || option.text, 60)}"`).join(', ')}.`);
      for (const option of options) option.selected = picked.includes(option);
      fire(el, 'input');
      fire(el, 'change');
      return { mechanism: 'select-option' };
    }
    if (!takesText(el) && tag !== 'INPUT') return fail('NOT_EDITABLE', `${describe(el)} does not take a value.`);
    if (el.readOnly || el.disabled) return fail('NOT_EDITABLE', `${describe(el)} is read-only or disabled.`);
    return { mechanism: insertText(el, String(value), true) };
  }

  const KEY_ALIASES = { enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: ' ', spacebar: ' ', backspace: 'Backspace', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown',
    left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' };
  function chord(keys) {
    const parts = String(keys).split('+').map(part => part.trim()).filter(Boolean);
    const last = parts.pop() || '';
    const key = KEY_ALIASES[last.toLowerCase()] || last;
    const mods = parts.map(part => part.toLowerCase());
    return { key, ctrlKey: mods.some(mod => ['control', 'ctrl', 'controlormeta'].includes(mod)), metaKey: mods.some(mod => ['meta', 'cmd', 'command'].includes(mod)), shiftKey: mods.includes('shift'), altKey: mods.includes('alt') };
  }

  function press(el, keys) {
    const init = chord(keys);
    const target = el || (document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body);
    const allowed = fire(target, 'keydown', KeyboardEvent, init);
    if (allowed && !init.ctrlKey && !init.metaKey && !init.altKey) {
      // What the browser itself would do for the keys a page most often relies on.
      if (init.key === 'Enter') {
        if (target.tagName === 'INPUT' && target.form) { if (typeof target.form.requestSubmit === 'function') target.form.requestSubmit(); else target.form.submit(); }
        else if (['BUTTON', 'A', 'SUMMARY'].includes(target.tagName) || ['button', 'link', 'menuitem', 'option', 'tab'].includes(roleOf(target))) target.click();
      } else if (init.key === ' ' && (['BUTTON', 'SUMMARY'].includes(target.tagName) || ['button', 'checkbox', 'radio', 'switch'].includes(roleOf(target)))) target.click();
    }
    fire(target, 'keyup', KeyboardEvent, init);
    return { mechanism: 'script-keys' };
  }

  function scroll({ el, to, by }) {
    const scroller = el || document.scrollingElement || document.documentElement;
    const before = scroller.scrollTop;
    if (to === 'top') scroller.scrollTop = 0;
    else if (to === 'bottom') scroller.scrollTop = scroller.scrollHeight;
    else if (to && typeof to === 'object') { const goal = resolve(to); if (goal.ok === false) return goal; goal.scrollIntoView({ block: 'center' }); }
    else scroller.scrollTop += Number.isFinite(by?.px) ? by.px : (Number.isFinite(by?.pages) ? by.pages : 1) * (el ? el.clientHeight : innerHeight) * 0.9;
    return { mechanism: 'script-scroll', moved: Math.round(scroller.scrollTop - before), at: Math.round(scroller.scrollTop), of: Math.round(scroller.scrollHeight) };
  }

  /** Runs one action and reports what the page did in the moments after: DOM changes, a new address, a moved focus. */
  async function act({ kind, target, value, text, keys, replace, to, by, settleMs = 1200 }) {
    let el = null;
    if (target) { el = resolve(target); if (el.ok === false) return el; }
    if (el && kind !== 'scroll' && kind !== 'hover' && (el.disabled || el.getAttribute('aria-disabled') === 'true')) return fail('NOT_ACTIONABLE', `${describe(el)} is disabled.`);
    const before = { url: location.href, focus: document.activeElement, value: el && 'value' in el ? el.value : null, checked: el && 'checked' in el ? el.checked : null };
    let mutations = 0;
    let last = performance.now();
    const observer = new MutationObserver(list => { mutations += list.length; last = performance.now(); });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    let done;
    try {
      if (el && kind !== 'scroll') el.scrollIntoView({ block: 'center', inline: 'nearest' });
      if (kind === 'click') {
        const at = pointerAt(el);
        fire(el, 'pointerdown', PointerEvent, at); fire(el, 'mousedown', MouseEvent, at);
        if (typeof el.focus === 'function') el.focus({ preventScroll: true });
        fire(el, 'pointerup', PointerEvent, at); fire(el, 'mouseup', MouseEvent, at);
        el.click();
        done = { mechanism: 'script-click' };
      } else if (kind === 'set') done = setValue(el, value);
      else if (kind === 'type') {
        const field = el || document.activeElement;
        if (!field || field === document.body || !takesText(field)) done = fail('NOT_EDITABLE', 'No text field has the focus. Name the field to type into.');
        else done = { mechanism: insertText(field, String(text ?? ''), replace === true) };
      } else if (kind === 'press') done = press(el, keys);
      else if (kind === 'hover') { const at = pointerAt(el); for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) fire(el, type, type.startsWith('pointer') ? PointerEvent : MouseEvent, at); done = { mechanism: 'script-hover' }; }
      else if (kind === 'scroll') done = scroll({ el, to, by });
      else done = fail('BAD_REQUEST', `Unknown action ${kind}.`);
    } catch (error) {
      observer.disconnect();
      return { ok: false, code: 'ACTION_FAILED', message: clean(error?.message || error, 300), dispatched: 'unknown' };
    }
    if (done.ok === false) { observer.disconnect(); return done; }
    // Wait until the page has been still for a moment, within the budget.
    const started = performance.now();
    await new Promise(resolveWait => { const tick = () => { const now = performance.now(); if (now - last > 180 || now - started > settleMs) resolveWait(); else setTimeout(tick, 60); }; setTimeout(tick, 120); });
    observer.disconnect();
    const signals = [];
    if (mutations) signals.push(`${mutations} DOM change${mutations === 1 ? '' : 's'}`);
    if (location.href !== before.url) signals.push('address changed');
    if (document.activeElement !== before.focus) signals.push('focus moved');
    if (el && before.value !== null && el.value !== before.value) signals.push('value changed');
    if (el && before.checked !== null && el.checked !== before.checked) signals.push(el.checked ? 'checked' : 'unchecked');
    if (done.moved) signals.push(`scrolled ${done.moved} px`);
    const target2 = el && el.isConnected ? el : null;
    return { ok: true, documentId, url: location.href, mechanism: done.mechanism, signals, line: el ? `[${refFor(el)}] ${describe(el)}` : '',
      value: target2 && 'value' in target2 && !isSecret(target2) && !looksLikeCard(target2.value) ? String(target2.value).slice(0, 2000) : null,
      checked: target2 && 'checked' in target2 ? !!target2.checked : null, gone: !!el && !el.isConnected, scroll: done.at !== undefined ? { at: done.at, of: done.of } : null };
  }

  // ------------------------------------------------------------------------------------------------------------ reading
  const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'UL', 'OL', 'LI', 'TABLE', 'TR', 'BLOCKQUOTE', 'PRE', 'FORM', 'FIELDSET', 'FIGURE', 'DL', 'DT', 'DD', 'DETAILS', 'BR', 'HR']);
  function markdown(root, plain) {
    const out = [];
    const emit = text => { if (text) out.push(text); };
    const step = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { emit(child.nodeValue.replace(/\s+/g, ' ')); continue; }
        if (child.nodeType !== 1 || SKIP.has(child.tagName.toUpperCase()) || !visible(child)) continue;
        const tag = child.tagName;
        if (HEADING.test(tag)) { emit(`\n\n${plain ? '' : `${'#'.repeat(Number(tag[1]))} `}${textOf(child, 300)}\n\n`); continue; }
        if (tag === 'A' && child.hasAttribute('href') && !plain) { const label = textOf(child, 200); if (label) emit(`[${label.replace(/[\[\]]/g, '')}](${child.href})`); continue; }
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { if (!isSecret(child) && child.value && !looksLikeCard(child.value)) emit(` ${clean(child.value, 200)} `); continue; }
        if (tag === 'IMG') { const alt = clean(child.getAttribute('alt'), 120); if (alt) emit(plain ? alt : `![${alt}]`); continue; }
        if (tag === 'LI') emit('\n- ');
        else if (BLOCKS.has(tag)) emit('\n\n');
        if (tag === 'IFRAME' || tag === 'FRAME') { try { if (child.contentDocument?.body) step(child.contentDocument.body); } catch { /* Another site's frame. */ } continue; }
        const shadow = shadowOf(child);
        if (shadow) step(shadow);
        step(child);
        if (BLOCKS.has(tag)) emit('\n\n');
      }
    };
    step(root);
    return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  }

  function read({ ref, format, offset = 0, maxChars = 7000 }) {
    const root = ref ? resolveRef(ref) : document.querySelector('main, article, [role="main"]') || document.body;
    if (!root || root.ok === false) return root || fail('NOT_FOUND', 'The page has no content.');
    const text = markdown(root, format === 'text');
    const at = Math.max(0, Math.min(text.length, offset));
    return { ok: true, documentId, url: location.href, title: document.title, text: text.slice(at, at + maxChars), offset: at, length: text.length };
  }

  function find(query) {
    const all = candidates(query);
    if (!Array.isArray(all)) return all;
    const limit = Math.max(1, Math.min(200, Number.isInteger(query.limit) ? query.limit : 20));
    return { ok: true, documentId, url: location.href, total: all.length, matches: all.slice(0, limit).map(entry => ({ ref: refFor(entry.el), line: `[${refFor(entry.el)}] ${describe(entry.el, entry.role)}${stateOf(entry.el, entry.role)}` })) };
  }

  /** Whether a condition holds now: text on the page, text gone, an element's state, and the facts an expectation needs. */
  function check({ text, textGone, target, state, value, checked, gone }) {
    const page = (document.body?.innerText || '').replace(/\s+/g, ' ');
    const has = needle => page.includes(clean(needle, 2000));
    const result = { ok: true, documentId, url: location.href };
    if (text !== undefined) result.text = has(text);
    if (textGone !== undefined) result.textGone = !has(textGone);
    if (target) {
      const el = resolve(target);
      const found = el.ok !== false;
      result.attached = found;
      result.visible = found && visible(el);
      result.enabled = found && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      if (state) result.state = state === 'attached' ? found : state === 'detached' ? !found : state === 'visible' ? result.visible : state === 'hidden' ? !result.visible : result.enabled;
      if (value !== undefined) result.value = found && 'value' in el && !isSecret(el) ? String(el.value) === String(value) : false;
      if (checked !== undefined) result.checked = found && (el.tagName === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true') === checked;
      if (gone !== undefined) result.gone = !found === gone;
    }
    return result;
  }

  const methods = { outline, inspect, act, read, find, check, ping: () => ({ ok: true, documentId, url: location.href }) };
  globalThis.__stillAutomation = {
    documentId,
    async run(name, args) {
      if (!Object.hasOwn(methods, name)) return fail('BAD_REQUEST', `Unknown request ${name}.`);
      try { return await methods[name](args && typeof args === 'object' ? args : {}); }
      catch (error) { return fail('PAGE_ERROR', clean(error?.message || error, 300)); }
    },
  };
})();
