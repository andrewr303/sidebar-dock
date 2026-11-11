// The quiet browser engine: the assistant's browser tools without chrome.debugger, so Chrome shows no "started
// debugging this browser" bar. It reads and acts through a script Still injects into the tab (content/automation.js,
// with the site access the person granted), and answers with the same results as the browser control layer, so the
// host (host.js), the cards and the assistant's tools work with either engine.
//
// What stays the same as the layer: a write is classified before anything is sent and waits for the person's rule or
// card; payments, access grants and secrets are handed to the person; page text reaches the model only inside the
// page-content boundary; a ref fails once its element or document is gone; every call has a time limit.
// What is weaker, and said in the results: input is made by script, a page's own dialogs cannot be seen or answered,
// frames of other sites are not read, and a screenshot needs the tab to be the visible one.
//
// createQuietController({ api, helpers, prompt }) -> { createSession, closeSession, tabState, epoch }
// helpers: the layer's pure functions (untrusted, quote, cutText, classify, siteOf, isBlockedSite), so both engines
// classify and mark text by one set of rules. prompt: { confirm(request, signal), ask(request, signal) } as in host.js.

const PAGE_TIMEOUT_MS = 10_000;
const LOAD_TIMEOUT_MS = 15_000;
const DIFF_MAX_LINES = 800;
const MECHANISM_NOTE = 'made by script, without the debugger';

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const isWeb = url => /^https?:\/\//i.test(String(url || ''));
const plain = value => JSON.parse(JSON.stringify(value ?? {}));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Refusal extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}

/** Lines of `next` against `prev` as the layer's compact edit script: counts of kept lines, { add }, { remove }. */
export function lineDiff(prev, next) {
  if (prev.length > DIFF_MAX_LINES || next.length > DIFF_MAX_LINES) return null;
  const rows = prev.length + 1, cols = next.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = prev.length - 1; i >= 0; i--) for (let j = next.length - 1; j >= 0; j--) {
    table[i * cols + j] = prev[i] === next[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
  }
  const ops = [];
  const keep = () => { if (typeof ops.at(-1) === 'number') ops[ops.length - 1]++; else ops.push(1); };
  let i = 0, j = 0;
  while (i < prev.length && j < next.length) {
    if (prev[i] === next[j]) { keep(); i++; j++; }
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) ops.push({ remove: prev[i++] });
    else ops.push({ add: next[j++] });
  }
  while (i < prev.length) ops.push({ remove: prev[i++] });
  while (j < next.length) ops.push({ add: next[j++] });
  return ops;
}

export function createQuietController({ api = globalThis.chrome, helpers, prompt } = {}) {
  const { untrusted, quote, cutText, classify, siteOf, isBlockedSite } = helpers;
  const tabStates = new Map();
  const sessions = new Set();
  let sessionCount = 0;
  let requestCount = 0;
  const stateOf = tabId => { let state = tabStates.get(tabId); if (!state) { state = { rev: 0, lines: null, documentId: '', pending: [] }; tabStates.set(tabId, state); } return state; };

  // ------------------------------------------------------------------------------------------------------- results
  const errorLine = error => `error ${error.code} (${error.delivered === false ? 'nothing dispatched; safe to retry' : error.delivered === 'unknown' ? 'delivery unknown; look before retrying' : 'input was delivered; do not retry blindly'})\n${error.message}\n${error.hint}`;
  const failure = (code, message, { delivered = false, hint = '', details, ...rest } = {}) => {
    const error = { code, message, delivered, hint, ...(details ? { details } : {}), ...rest };
    return { ok: false, error, text: errorLine(error).trimEnd() };
  };
  const HINTS = {
    STALE_REF: 'Take a new snapshot and use the refs it shows.',
    NOT_FOUND: 'Take a snapshot to see what the page holds now.',
    AMBIGUOUS: 'Use a ref from a snapshot, or add nth.',
    NOT_ACTIONABLE: 'Look at the page: the control may need another step first.',
    NOT_EDITABLE: 'Pick a field that takes text.',
    BAD_TARGET: 'Use a ref from a snapshot, or a role and name.',
  };
  const receiptLines = receipt => {
    const parts = [receipt.action, receipt.target, receipt.mechanism].filter(Boolean);
    if (receipt.sensitive) parts.push(`${receipt.sensitive}: ${receipt.allowedBy === 'site-rule' ? "allowed by the site's rule" : receipt.allowedBy === 'auto' ? 'allowed by Auto mode' : receipt.confirmedByUser ? 'approved by user' : 'not confirmed'}`);
    parts.push(receipt.dispatched === true ? 'dispatched' : receipt.dispatched === 'unknown' ? 'dispatch unknown' : 'not dispatched');
    const lines = [parts.join(' · '), `effect: ${receipt.effect.verdict}${receipt.effect.signals.length ? ` · ${receipt.effect.signals.join(' · ')}` : ''}`];
    if (receipt.postcondition) lines.push(`expect: ${receipt.postcondition.status}${receipt.postcondition.detail ? ` · ${receipt.postcondition.detail}` : ''}`);
    if (receipt.navigation) lines.push(`navigation: ${receipt.navigation.kind} ${quote(receipt.navigation.url)}`);
    if (receipt.newTab) lines.push(`new tab: ${receipt.newTab.tabId} ${quote(receipt.newTab.url)}`);
    return lines;
  };
  // A page's own line as the tool's line quotes it: `[q3] button "Send"` becomes `[q3] button «Send»`.
  const targetLine = line => String(line || '').replace(/^(\[\w+\]\s+)?(\S+) "(.*)"$/s, (_, ref = '', role, name) => `${ref}${role} ${quote(name, 120)}`);

  // ----------------------------------------------------------------------------------------------------------- tabs
  const getTab = async tabId => { try { return await api.tabs.get(tabId); } catch { return null; } };
  async function loaded(tabId, signal, timeoutMs = LOAD_TIMEOUT_MS) {
    const started = Date.now();
    // A navigation a click started may not have begun yet.
    await sleep(80);
    for (;;) {
      if (signal?.aborted) throw new Refusal('CANCELLED', 'Stopped.', { delivered: 'unknown' });
      const tab = await getTab(tabId);
      if (!tab) throw new Refusal('TAB_CLOSED', 'The tab was closed.', { delivered: 'unknown' });
      if (tab.status === 'complete') return tab;
      if (Date.now() - started > timeoutMs) return tab;
      await sleep(120);
    }
  }

  /** One request to the page's script, injected on first use and again after a navigation. */
  async function page(tabId, name, args = {}, { timeoutMs = PAGE_TIMEOUT_MS } = {}) {
    const call = () => api.scripting.executeScript({ target: { tabId }, func: (method, input) => (globalThis.__stillAutomation ? globalThis.__stillAutomation.run(method, input) : { missing: true }), args: [name, plain(args)] });
    const run = async () => {
      let [frame] = await call();
      if (frame?.result?.missing) {
        await api.scripting.executeScript({ target: { tabId }, files: ['content/automation.js'] });
        [frame] = await call();
      }
      return frame?.result;
    };
    let timer;
    try {
      const result = await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Refusal('TIMEOUT', 'The page did not answer in time. It may be showing a dialog of its own, or be busy.', { delivered: 'unknown', hint: 'Ask the user to look at the tab (ask_user, kind "takeover"), or wait and take a snapshot.' })), timeoutMs); })]);
      if (!isObject(result)) throw new Refusal('PAGE_UNREACHABLE', 'The page gave no answer.', { delivered: 'unknown', hint: 'Take a snapshot to see the page as it is now.' });
      return result;
    } finally { clearTimeout(timer); }
  }

  const pageFailure = (result, delivered = false) => failure(result.code || 'PAGE_ERROR', String(result.message || 'The page refused the request.'), { delivered: result.dispatched ?? delivered, hint: HINTS[result.code] || 'Take a snapshot to see the page as it is now.' });

  // --------------------------------------------------------------------------------------------------------- session
  function createSession(config = {}) {
    const tabs = new Set();
    let active = null;
    let policy = { blocked: [...(config.urlPolicy?.blocked || [])] };
    const nonce = [...crypto.getRandomValues(new Uint8Array(6))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const boundary = { labels: [...(config.boundary?.labels || [])] };
    const budget = Number.isInteger(config.budget) && config.budget > 500 ? config.budget : 7000;
    const wrap = (text, url) => untrusted(nonce, text, { ...boundary, source: { site: siteOf(url) } });
    const allowed = url => isWeb(url) && !isBlockedSite(url, policy.blocked);

    async function useTab(tabId) {
      const id = Number.isInteger(tabId) ? tabId : active;
      if (!Number.isInteger(id) || !tabs.has(id)) throw new Refusal('NO_TAB', Number.isInteger(tabId) ? `Tab ${tabId} is not one of this conversation's tabs.` : 'There is no active tab.', { hint: 'Open one with tabs (action "open"), or list the tabs.' });
      const tab = await getTab(id);
      if (!tab) { tabs.delete(id); tabStates.delete(id); if (active === id) active = [...tabs].at(-1) ?? null; throw new Refusal('TAB_CLOSED', 'The tab was closed.', { hint: 'List the tabs, or open one.' }); }
      const url = tab.url || tab.pendingUrl || '';
      if (!isWeb(url)) throw new Refusal('RESTRICTED_PAGE', `This page (${quote(url, 120)}) cannot be controlled: only web pages can.`, { hint: 'Navigate the tab to a web address, or open a new tab.' });
      if (!allowed(url)) throw new Refusal('URL_NOT_ALLOWED', `${quote(url, 160)} is not allowed: the user blocked this site.`, { hint: 'Work without this site, or ask the user.', decisionSource: 'user', retryable: false });
      return tab;
    }

    /** Captures the outline and says how it differs from the last one shown for this document. */
    async function observe(tab, mode = 'full') {
      const state = stateOf(tab.id);
      const outline = await page(tab.id, 'outline', {});
      if (outline.ok === false) throw new Refusal(outline.code || 'PAGE_ERROR', outline.message || 'The page could not be read.', { hint: 'Try again in a moment.' });
      const since = state.rev;
      const previous = state.documentId === outline.documentId ? state.lines : null;
      state.rev += 1;
      state.lines = outline.lines;
      state.documentId = outline.documentId;
      const base = { tabId: tab.id, url: outline.url, title: outline.title, rev: state.rev };
      const notices = outline.notices.map(notice => `notice: ${notice}`);
      const ops = mode === 'diff' && previous ? lineDiff(previous, outline.lines) : null;
      if (ops) {
        const changes = ops.filter(op => typeof op !== 'number');
        if (!changes.length) return { page: { ...base, changed: 'none' }, lines: [`page · tab ${tab.id} · rev ${since} → ${state.rev} · no change`], changes: 0 };
        const body = changes.map(op => (op.add !== undefined ? `+ ${op.add}` : `- ${op.remove}`)).join('\n');
        return { page: { ...base, changed: 'diff', diff: { since, ops } }, changes: changes.length,
          lines: [`page · tab ${tab.id} · rev ${since} → ${state.rev} · ${changes.length} line${changes.length === 1 ? '' : 's'} changed`, wrap(cutText(body, budget, ''), outline.url), ...notices] };
      }
      let body = `${outline.header}\n${outline.lines.join('\n')}`;
      const cut = body.length > budget;
      if (cut) body = body.slice(0, body.lastIndexOf('\n', budget));
      return { page: { ...base, changed: 'full', snapshot: body }, changes: -1, refs: outline.refs, partial: cut,
        lines: [wrap(body, outline.url), ...(cut ? ['The outline was cut to fit. Use find or read for the rest, or snapshot with a scope.'] : []), ...notices] };
    }

    // ---- what only the person decides ----
    async function gate({ tab, info, mode, action, intent, signal }) {
      const site = siteOf(tab.url);
      const target = targetLine(info.line).replace(/^\[\w+\]\s*/, '');
      if (info.destination && isWeb(info.destination) && !allowed(info.destination)) {
        throw new Refusal('URL_NOT_ALLOWED', `${quote(info.destination, 160)} is not allowed: the user blocked this site. Nothing was sent.`, { hint: 'Work without this site, or ask the user.', decisionSource: 'user', retryable: false });
      }
      const { category, reason } = classify({ mode, name: info.name || '', role: info.role || '', facts: info.facts, url: info.url });
      if (!category) return {};
      if (category === 'pay' || category === 'grant') {
        throw new Refusal('USER_STEP', `This step is the user's own: ${reason}. Nothing was sent.`, { hint: 'Still hands the step to the user. Do not try it another way.', details: { reason: category, target, site }, decisionSource: 'policy', retryable: false });
      }
      const decided = (await config.decideWrite?.({ site, category, tabId: tab.id, action, target })) || { decision: 'ask', canRemember: false };
      if (decided.decision === 'run') return { sensitive: category, allowedBy: decided.by === 'site-rule' ? 'site-rule' : 'auto' };
      const destinationHost = info.destination && isWeb(info.destination) && siteOf(info.destination) !== site ? siteOf(info.destination) : '';
      let origin = '';
      try { origin = new URL(tab.url).origin; } catch { origin = ''; }
      const answer = await prompt.confirm({ id: `quiet-${++requestCount}`, tabId: tab.id, category, action, target, origin, site, ...(destinationHost ? { destinationHost } : {}),
        ...(intent ? { intent: String(intent).slice(0, 500) } : {}), reason, canRemember: decided.canRemember === true }, signal);
      if (signal?.aborted) throw new Refusal('CANCELLED', 'Stopped.', {});
      if (answer !== 'approve' && answer !== 'approve-remember') {
        throw new Refusal('USER_DECLINED', `The user did not allow this ${category}. Nothing was sent.`, { hint: 'This is the user\'s answer. Carry on without it, or ask them.', decisionSource: 'user', retryable: false });
      }
      return { sensitive: category, confirmedByUser: true, allowedBy: 'user' };
    }

    const secretStep = (tab, info) => new Refusal('USER_STEP', 'This field takes a password, a card number or a code. The user types those themselves. Nothing was sent.',
      { hint: 'Still hands the step to the user. Do not ask them for the value.', details: { reason: 'secret', target: targetLine(info.line).replace(/^\[\w+\]\s*/, ''), site: siteOf(tab.url) }, decisionSource: 'policy', retryable: false });

    async function inspect(tab, target) {
      const info = await page(tab.id, 'inspect', target ? { target } : {});
      if (info.ok === false) throw new Refusal(info.code || 'PAGE_ERROR', info.message || 'The element could not be found.', { hint: HINTS[info.code] || '' });
      return info;
    }

    async function expectation(tab, expect, target) {
      if (!isObject(expect) || !Object.keys(expect).length) return undefined;
      const now = await getTab(tab.id);
      const checks = [];
      if (typeof expect.url === 'string') checks.push([`address contains ${quote(expect.url, 80)}`, String(now?.url || '').includes(expect.url)]);
      let seen = null;
      try { seen = await page(tab.id, 'check', { ...(expect.text !== undefined ? { text: expect.text } : {}), ...(expect.textGone !== undefined ? { textGone: expect.textGone } : {}),
        ...(target && ['value', 'checked', 'gone'].some(key => expect[key] !== undefined) ? { target, value: expect.value, checked: expect.checked, gone: expect.gone } : {}) }); } catch { seen = null; }
      if (!seen || seen.ok === false) return { status: 'not_checked', detail: 'the page could not be read' };
      if (expect.text !== undefined) checks.push([`text ${quote(expect.text, 80)} is on the page`, seen.text === true]);
      if (expect.textGone !== undefined) checks.push([`text ${quote(expect.textGone, 80)} is gone`, seen.textGone === true]);
      for (const key of ['value', 'checked', 'gone']) if (expect[key] !== undefined) checks.push([`${key} is ${quote(String(expect[key]), 80)}`, seen[key] === true]);
      const unmet = checks.filter(([, met]) => !met).map(([label]) => label);
      return unmet.length ? { status: 'unmet', detail: `not seen: ${unmet.join('; ')}` } : { status: 'met' };
    }

    /** One action on the page, after the gate: dispatch, wait for the page to settle, look again. */
    async function perform({ tab, action, request, info, allow = {}, args, signal, target }) {
      const state = stateOf(tab.id);
      const opened = [];
      const onCreated = created => { if (created.openerTabId === tab.id) opened.push(created); };
      api.tabs.onCreated?.addListener?.(onCreated);
      let done = null;
      let replaced = false;
      if (signal?.aborted) throw new Refusal('CANCELLED', 'Stopped.', {});
      try {
        // An action that sends the page elsewhere (a link, a form) takes the script with it, and Chrome may never
        // answer the call. The tab starting to load is the sign; the script gets a moment to answer first.
        let onUpdated;
        const left = new Promise(resolve => { onUpdated = (id, change) => { if (id === tab.id && change.status === 'loading') resolve(); }; });
        api.tabs.onUpdated?.addListener?.(onUpdated);
        try {
          const acting = page(tab.id, 'act', request, { timeoutMs: PAGE_TIMEOUT_MS + 2000 }).then(value => ({ value }), error => ({ error }));
          const outcome = await Promise.race([acting, left.then(() => Promise.race([acting, sleep(500).then(() => ({ replaced: true }))]))]);
          if (outcome.replaced) replaced = true;
          else if (outcome.error) {
            if (outcome.error instanceof Refusal && outcome.error.code === 'TIMEOUT') throw outcome.error;
            // Either the page went away under the script (the action navigated it), or Chrome would not run the script
            // at all. The second is an error to report, not a navigation.
            const now = await getTab(tab.id);
            const reachable = now && now.url === tab.url && now.status === 'complete' ? await page(tab.id, 'ping', {}).then(answer => answer?.ok === true, () => false) : true;
            if (!reachable) throw outcome.error;
            replaced = true;
          } else done = outcome.value;
        } finally { api.tabs.onUpdated?.removeListener?.(onUpdated); }
        if (done && done.ok === false) return pageFailure(done);
        const after = await loaded(tab.id, signal);
        await sleep(60);
        const navigated = replaced || (after.url && after.url !== tab.url);
        const receipt = { action, ...(info?.line || done?.line ? { target: targetLine(done?.line || info.line) } : {}), mechanism: done?.mechanism || 'script-click', dispatched: true,
          effect: { verdict: 'none', signals: [...(done?.signals || [])] }, how: [MECHANISM_NOTE], ...allow };
        if (navigated) receipt.navigation = { url: after.url, kind: replaced || state.documentId !== done?.documentId ? 'new-document' : 'same-document' };
        for (const created of opened) {
          const fresh = await getTab(created.id);
          if (!fresh) continue;
          tabs.add(fresh.id);
          config.onTabJoined?.(fresh.id, 'page-opened');
          receipt.newTabs = [...(receipt.newTabs || []), { tabId: fresh.id, url: fresh.url || fresh.pendingUrl || '' }];
        }
        if (receipt.newTabs?.length) receipt.newTab = { tabId: receipt.newTabs[0].tabId, url: receipt.newTabs[0].url };
        const lines = [];
        let pageState;
        let pageError;
        if (!allowed(after.url) && isWeb(after.url)) lines.push(`policy: URL_NOT_ALLOWED · the page went to ${quote(after.url, 160)}, a site the user blocked`);
        else if (args.observe !== 'none') {
          try { const seen = await observe(after, args.observe === 'full' || navigated ? 'full' : 'diff'); pageState = seen.page; lines.push(...seen.lines); if (seen.changes !== 0) receipt.effect.signals.push(seen.changes > 0 ? `${seen.changes} outline line${seen.changes === 1 ? '' : 's'} changed` : 'new page state'); }
          catch (error) { pageError = { code: error.code || 'PAGE_ERROR', message: String(error.message || error), delivered: true, hint: 'Take a snapshot.' }; lines.push(`page: could not be read after the action (${pageError.code})`); }
        }
        if (navigated) receipt.effect.signals.unshift('navigated');
        if (receipt.newTab) receipt.effect.signals.push('opened a tab');
        receipt.effect.verdict = receipt.effect.signals.length ? 'changed' : 'none';
        const post = await expectation(after, args.expect, target);
        if (post) receipt.postcondition = post;
        return { ok: true, receipt, ...(pageState ? { page: pageState } : {}), ...(pageError ? { pageError } : {}), data: { value: done?.value ?? null, checked: done?.checked ?? null },
          text: [...receiptLines(receipt), ...lines].join('\n') };
      } finally { api.tabs.onCreated?.removeListener?.(onCreated); }
    }

    const isEnter = keys => /^(?:enter|return)$/i.test(String(keys || '').trim());

    // ------------------------------------------------------------------------------------------------------ tools
    const tools = {
      async snapshot(args) {
        const tab = await useTab(args.tabId);
        if (args.scope) { const scoped = await page(tab.id, 'outline', { scope: args.scope }); if (scoped.ok === false) return pageFailure(scoped); }
        const seen = await observe(tab, 'full');
        return { ok: true, page: seen.page, data: { status: seen.partial ? 'partial' : 'complete', refs: seen.refs, frames: { captured: 1, skipped: 0, failed: 0 }, notices: [], captureMs: 0 },
          text: [`snapshot · tab ${tab.id} · rev ${seen.page.rev} · ${seen.refs} ref${seen.refs === 1 ? '' : 's'}`, ...seen.lines].join('\n') };
      },

      async find(args) {
        const tab = await useTab(args.tabId);
        const found = await page(tab.id, 'find', { role: args.role, name: args.name, text: args.text, within: args.within, limit: args.limit });
        if (found.ok === false) return pageFailure(found);
        const body = found.matches.map(match => match.line).join('\n') || '(no match)';
        return { ok: true, data: { matches: found.matches.map(match => ({ ...match, tabId: tab.id })), total: found.total },
          text: [`find · tab ${tab.id} · ${found.total} match${found.total === 1 ? '' : 'es'}${found.total > found.matches.length ? ` (the first ${found.matches.length} shown)` : ''}`, wrap(body, found.url)].join('\n') };
      },

      async read(args) {
        const tab = await useTab(args.tabId);
        const maxChars = Math.min(Number.isInteger(args.maxChars) ? args.maxChars : budget, budget);
        const got = await page(tab.id, 'read', { ref: args.ref, format: args.format, offset: args.offset, maxChars });
        if (got.ok === false) return pageFailure(got);
        const end = got.offset + got.text.length;
        const rest = got.length - end;
        return { ok: true, page: { tabId: tab.id, url: got.url, title: got.title, rev: stateOf(tab.id).rev, changed: 'none' }, data: { offset: got.offset, length: got.length, next: rest > 0 ? end : null },
          text: [`read · tab ${tab.id} · characters ${got.offset}–${end} of ${got.length}`, wrap(got.text || '(no text)', got.url), ...(rest > 0 ? [`${rest} more characters: read again with offset ${end}.`] : [])].join('\n') };
      },

      async screenshot(args) {
        const tab = await useTab(args.tabId);
        if (!tab.active) return failure('NOT_VISIBLE', 'A screenshot needs the tab to be the visible tab of its window, and it is not.', { hint: 'Read the page with snapshot or read instead, or ask the user to switch to the tab.' });
        let url;
        try { url = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' }); }
        catch (error) { return failure('SCREENSHOT_FAILED', `The screenshot could not be taken: ${String(error?.message || error).slice(0, 200)}`, { hint: 'Read the page with snapshot or read instead.' }); }
        const base64 = String(url || '').replace(/^data:image\/png;base64,/, '');
        return { ok: true, page: { tabId: tab.id, url: tab.url, title: tab.title || '', rev: stateOf(tab.id).rev, changed: 'none' }, data: { mimeType: 'image/png', base64, width: tab.width || 0, height: tab.height || 0, scale: 1, origin: { x: 0, y: 0 } },
          text: `screenshot · tab ${tab.id} · the visible part of the page` };
      },

      async click(args, signal) {
        const tab = await useTab(args.tabId);
        const info = await inspect(tab, args.target);
        const allow = await gate({ tab, info, mode: 'activate', action: 'click', intent: args.intent, signal });
        return perform({ tab, action: 'click', request: { kind: 'click', target: { ref: info.ref } }, info, allow, args, signal, target: { ref: info.ref } });
      },

      async hover(args, signal) {
        const tab = await useTab(args.tabId);
        const info = await inspect(tab, args.target);
        return perform({ tab, action: 'hover', request: { kind: 'hover', target: { ref: info.ref } }, info, args, signal, target: { ref: info.ref } });
      },

      async set(args, signal) {
        const tab = await useTab(args.tabId);
        const info = await inspect(tab, args.target);
        if (info.secret) throw secretStep(tab, info);
        const allow = args.submit === true ? await gate({ tab, info, mode: 'enter', action: 'set and press Enter', intent: args.intent, signal }) : {};
        const result = await perform({ tab, action: 'set', request: { kind: 'set', target: { ref: info.ref }, value: args.value }, info, allow: args.submit ? {} : allow, args: args.submit ? { ...args, observe: 'none', expect: undefined } : args, signal, target: { ref: info.ref } });
        if (!result.ok || args.submit !== true) return result;
        return perform({ tab, action: 'press Enter', request: { kind: 'press', target: { ref: info.ref }, keys: 'Enter' }, info, allow, args, signal, target: { ref: info.ref } });
      },

      async type(args, signal) {
        const tab = await useTab(args.tabId);
        const info = await inspect(tab, args.target);
        if (info.none) return failure('NOT_EDITABLE', 'No text field has the focus.', { hint: 'Name the field to type into with target.' });
        if (info.secret) throw secretStep(tab, info);
        const allow = args.submit === true ? await gate({ tab, info, mode: 'enter', action: 'type and press Enter', intent: args.intent, signal }) : {};
        const result = await perform({ tab, action: 'type', request: { kind: 'type', target: { ref: info.ref }, text: args.text, replace: args.replace === true }, info, args: args.submit ? { ...args, observe: 'none', expect: undefined } : args, signal, target: { ref: info.ref } });
        if (!result.ok || args.submit !== true) return result;
        return perform({ tab, action: 'press Enter', request: { kind: 'press', target: { ref: info.ref }, keys: 'Enter' }, info, allow, args, signal, target: { ref: info.ref } });
      },

      async press(args, signal) {
        const tab = await useTab(args.tabId);
        const info = await inspect(tab, args.target);
        let allow = {};
        if (!info.none && isEnter(args.keys)) allow = await gate({ tab, info, mode: info.facts?.textEntry || info.facts?.field ? 'enter' : 'activate', action: 'press Enter', intent: args.intent, signal });
        else if (!info.none && /^(?:space|spacebar| )$/i.test(String(args.keys).trim()) && !info.facts?.textEntry) allow = await gate({ tab, info, mode: 'activate', action: 'press Space', intent: args.intent, signal });
        return perform({ tab, action: `press ${quote(args.keys, 40)}`, request: { kind: 'press', ...(info.none ? {} : { target: { ref: info.ref } }), keys: args.keys }, info: info.none ? null : info, allow, args, signal, target: info.none ? null : { ref: info.ref } });
      },

      async scroll(args, signal) {
        const tab = await useTab(args.tabId);
        const info = args.target ? await inspect(tab, args.target) : null;
        return perform({ tab, action: 'scroll', request: { kind: 'scroll', ...(info ? { target: { ref: info.ref } } : {}), to: args.to, by: args.by }, info, args, signal, target: info ? { ref: info.ref } : null });
      },

      async fill_form(args, signal) {
        const tab = await useTab(args.tabId);
        // Everything is looked at and decided before the first field is touched.
        const fields = [];
        for (const field of args.fields) { const info = await inspect(tab, field.target); if (info.secret) throw secretStep(tab, info); fields.push({ info, value: field.value }); }
        const submit = args.submit ? await inspect(tab, args.submit) : null;
        const allow = submit ? await gate({ tab, info: submit, mode: 'activate', action: 'fill in and send a form', intent: args.intent, signal }) : {};
        const receipts = [];
        const lines = [];
        for (const { info, value } of fields) {
          const result = await perform({ tab, action: 'set', request: { kind: 'set', target: { ref: info.ref }, value }, info, args: { observe: 'none' }, signal, target: { ref: info.ref } });
          if (!result.ok) return { ...result, data: { receipts, submitted: false }, text: [...lines, result.text, 'The form was not sent.'].join('\n') };
          receipts.push(result.receipt);
          lines.push(result.text);
        }
        if (!submit) {
          const seen = args.observe === 'none' ? null : await observe(await useTab(tab.id), 'diff').catch(() => null);
          return { ok: true, ...(seen ? { page: seen.page } : {}), data: { receipts, submitted: false }, text: [...lines, ...(seen ? seen.lines : [])].join('\n') };
        }
        const sent = await perform({ tab, action: 'click', request: { kind: 'click', target: { ref: submit.ref } }, info: submit, allow, args, signal, target: { ref: submit.ref } });
        if (sent.receipt) receipts.push(sent.receipt);
        return { ...sent, receipt: undefined, data: { receipts, submitted: sent.ok === true }, text: [...lines, sent.text].join('\n') };
      },

      async wait(args, signal) {
        const tab = await useTab(args.tabId);
        const limit = Math.min(60_000, Number.isInteger(args.timeoutMs) ? args.timeoutMs : Number.isInteger(args.ms) && !args.text && !args.textGone && !args.target && !args.url ? args.ms : 10_000);
        const started = Date.now();
        const timed = !args.text && !args.textGone && !args.target && !args.url;
        let met = '';
        for (;;) {
          if (signal?.aborted) throw new Refusal('CANCELLED', 'Stopped.', {});
          if (timed) { if (Date.now() - started >= limit) { met = 'time'; break; } }
          else {
            const now = await getTab(tab.id);
            const seen = await page(tab.id, 'check', { text: args.text, textGone: args.textGone, ...(args.target ? { target: args.target, state: args.state || 'visible' } : {}) }).catch(() => null);
            const all = [args.url ? String(now?.url || '').includes(args.url) : true, args.text !== undefined ? seen?.text === true : true, args.textGone !== undefined ? seen?.textGone === true : true, args.target ? seen?.state === true : true];
            if (seen && all.every(Boolean)) { met = args.text !== undefined ? 'text' : args.textGone !== undefined ? 'textGone' : args.target ? 'target' : 'url'; break; }
            if (Date.now() - started >= limit) break;
          }
          await sleep(200);
        }
        const waited = Date.now() - started;
        const seen = args.observe && args.observe !== 'none' ? await observe(await useTab(tab.id), args.observe).catch(() => null) : null;
        return { ok: true, ...(seen ? { page: seen.page } : {}), data: { matched: !!met, met: met || null, waitedMs: waited },
          text: [`wait · tab ${tab.id} · ${met ? `met (${met})` : 'not met'} after ${waited} ms`, ...(seen ? seen.lines : [])].join('\n') };
      },

      async navigate(args, signal) {
        const tab = await useTab(args.tabId);
        if ((args.url === undefined) === (args.action === undefined)) return failure('BAD_REQUEST', 'Give exactly one of url and action.', { hint: 'For example { url: "https://example.com" } or { action: "back" }.' });
        if (args.url !== undefined) {
          let target = '';
          try { target = new URL(args.url, tab.url).href; } catch { target = ''; }
          if (!isWeb(target)) return failure('URL_NOT_ALLOWED', `${quote(args.url, 160)} is not a web address. Nothing was sent.`, { hint: 'Use an http or https address.' });
          if (!allowed(target)) return failure('URL_NOT_ALLOWED', `${quote(target, 160)} is not allowed: the user blocked this site. Nothing was sent.`, { hint: 'Work without this site, or ask the user.', decisionSource: 'user', retryable: false });
          await api.tabs.update(tab.id, { url: target });
        } else if (args.action === 'back') await api.tabs.goBack(tab.id);
        else if (args.action === 'forward') await api.tabs.goForward(tab.id);
        else await api.tabs.reload(tab.id);
        const after = await loaded(tab.id, signal);
        const receipt = { action: 'navigate', mechanism: 'navigation', dispatched: true, effect: { verdict: 'changed', signals: ['navigated'] }, navigation: { url: after.url || '', kind: 'new-document' } };
        const lines = [];
        let pageState;
        if (!allowed(after.url)) lines.push(`policy: URL_NOT_ALLOWED · the page went to ${quote(after.url, 160)}, which cannot be used`);
        else if (args.observe !== 'none') { try { const seen = await observe(after, 'full'); pageState = seen.page; lines.push(...seen.lines); } catch (error) { lines.push(`page: could not be read (${error.code || 'PAGE_ERROR'})`); } }
        const post = allowed(after.url) ? await expectation(after, args.expect, null) : undefined;
        if (post) receipt.postcondition = post;
        return { ok: true, receipt, ...(pageState ? { page: pageState } : {}), text: [...receiptLines(receipt), ...lines].join('\n') };
      },

      async tabs(args, signal) {
        const list = async () => {
          const rows = [];
          for (const id of [...tabs]) { const tab = await getTab(id); if (!tab) { tabs.delete(id); tabStates.delete(id); continue; } rows.push({ tabId: id, url: tab.url || tab.pendingUrl || '', title: tab.title || '', active: id === active }); }
          if (active !== null && !tabs.has(active)) active = rows.at(-1)?.tabId ?? null;
          return { tabs: rows.map(row => ({ ...row, active: row.tabId === active })), activeTabId: active };
        };
        const render = data => data.tabs.map(tab => `${tab.active ? '* ' : '  '}[${tab.tabId}] ${quote(tab.title || '(untitled)', 120)} ${quote(tab.url, 160)}`).join('\n') || '(no tabs)';
        if (args.action === 'open') {
          const url = typeof args.url === 'string' && args.url ? args.url : '';
          if (!isWeb(url)) return failure('URL_NOT_ALLOWED', `${quote(url, 160)} is not a web address. No tab was opened.`, { hint: 'Give an http or https address.' });
          if (!allowed(url)) return failure('URL_NOT_ALLOWED', `${quote(url, 160)} is not allowed: the user blocked this site. No tab was opened.`, { hint: 'Work without this site, or ask the user.', decisionSource: 'user', retryable: false });
          const created = await api.tabs.create({ url, active: (await config.reveal?.(null)) !== false });
          tabs.add(created.id);
          active = created.id;
          config.onTabJoined?.(created.id, 'opened');
          const after = await loaded(created.id, signal);
          const data = await list();
          return { ok: true, page: { tabId: created.id, url: after.url || url, title: after.title || '', rev: 0, changed: 'none' }, data, text: `opened tab ${created.id} ${quote(after.url || url, 160)}\n${render(data)}` };
        }
        if (args.action === 'select' || args.action === 'close') {
          const id = Number.isInteger(args.tabId) ? args.tabId : active;
          if (!Number.isInteger(id) || !tabs.has(id)) return failure('NO_TAB', `Tab ${args.tabId ?? ''} is not one of this conversation's tabs.`, { hint: 'List the tabs first.' });
          if (args.action === 'select') { active = id; if ((await config.reveal?.(id)) === true) await api.tabs.update(id, { active: true }).catch(() => undefined); }
          else { tabs.delete(id); tabStates.delete(id); await api.tabs.remove(id).catch(() => undefined); if (active === id) active = [...tabs].at(-1) ?? null; }
        }
        const data = await list();
        return { ok: true, data, text: `${args.action === 'close' ? 'closed a tab\n' : args.action === 'select' ? 'selected a tab\n' : ''}${render(data)}` };
      },

      async handle_dialog() {
        return failure('UNSUPPORTED', 'In this mode Still cannot see or answer a page\'s own dialogs.', { hint: 'If a dialog is open, ask the user to answer it in the tab (ask_user, kind "takeover").' });
      },

      async ask_user(args, signal) {
        const tabId = Number.isInteger(args.tabId) ? args.tabId : active;
        const request = { id: `quiet-${++requestCount}`, tabId: Number.isInteger(tabId) ? tabId : -1, kind: args.kind === 'input' ? 'input' : 'takeover', message: String(args.message || '').slice(0, 2000) };
        const state = Number.isInteger(tabId) ? stateOf(tabId) : null;
        const modal = { kind: 'user-request', detail: `${request.kind}: ${request.message}` };
        state?.pending.push(modal);
        const abort = new AbortController();
        const onAbort = () => abort.abort();
        signal?.addEventListener?.('abort', onAbort);
        let timer;
        let answer;
        try {
          answer = await Promise.race([prompt.ask(request, abort.signal), new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), config.askTimeoutMs || 300_000); })]);
        } finally {
          clearTimeout(timer);
          abort.abort();
          signal?.removeEventListener?.('abort', onAbort);
          if (state) state.pending = state.pending.filter(entry => entry !== modal);
        }
        if (signal?.aborted) throw new Refusal('CANCELLED', 'Stopped.', {});
        if (answer === 'timeout') return failure('TIMEOUT', 'The user did not answer in time.', { hint: 'Finish with what you have and say what is left for the user.' });
        if (!isObject(answer) || answer.outcome !== 'continue') return failure('USER_DECLINED', 'The user did not continue.', { hint: 'This is the user\'s answer. Finish with what you have.', decisionSource: 'user', retryable: false });
        const typed = typeof answer.data === 'string' && answer.data ? answer.data : '';
        return { ok: true, data: { outcome: 'continue', ...(typed ? { data: typed } : {}) }, text: typed ? `the user answered: ${quote(typed, 2000)}` : 'the user did the step and gave the tab back. Take a snapshot before going on.' };
      },
    };

    const session = {
      id: `quiet-session-${++sessionCount}`,
      hasTab: tabId => tabs.has(tabId),
      async share(tabId) {
        const tab = await getTab(tabId);
        if (!tab) throw new Refusal('TAB_CLOSED', 'The tab is gone.', {});
        const url = tab.url || tab.pendingUrl || '';
        if (!isWeb(url)) throw new Refusal('RESTRICTED_PAGE', 'Only web pages can be controlled.', {});
        if (!allowed(url)) throw new Refusal('URL_NOT_ALLOWED', 'The user blocked this site.', {});
        tabs.add(tabId);
        active = tabId;
        config.onTabJoined?.(tabId, 'shared');
      },
      setUrlPolicy(next) { policy = { blocked: [...(next?.blocked || [])] }; },
      async call(tool, args = {}, { signal } = {}) {
        if (!Object.hasOwn(tools, tool)) return failure('BAD_REQUEST', `There is no tool named ${tool}.`, { hint: 'Use one of the browser tools.' });
        try {
          if (signal?.aborted) throw new Refusal('CANCELLED', 'Stopped.', {});
          const result = await tools[tool](isObject(args) ? args : {}, signal);
          // A tab's waiting request (a question to the person) travels with every result, as in the layer.
          return result;
        } catch (error) {
          if (error instanceof Refusal) return failure(error.code, error.message, { hint: HINTS[error.code] || '', ...error.extra });
          // Chrome's own refusal to run a script in the page: the site access is missing, or the page is one of Chrome's.
          if (/cannot access|permission|cannot be scripted|extensions gallery/i.test(String(error?.message || ''))) {
            return failure('NO_SITE_ACCESS', 'Chrome did not let Still work on this page.', { delivered: 'unknown', hint: 'Tell the user: Still needs access to this site (Settings, Browser automation, Allow in Chrome), or the page is one Chrome protects.' });
          }
          return failure('INTERNAL', String(error?.message || error).split('\n')[0].slice(0, 300), { delivered: 'unknown', hint: 'Take a snapshot to see the page as it is now.' });
        }
      },
      close() { for (const id of tabs) tabStates.delete(id); tabs.clear(); active = null; },
    };
    sessions.add(session);
    return session;
  }

  return {
    createSession,
    async closeSession(session) { session?.close?.(); sessions.delete(session); },
    tabState: tabId => { const state = tabStates.get(tabId); return state ? { rev: state.rev, pending: state.pending } : null; },
    epoch: { prefix: 'q' },
  };
}
