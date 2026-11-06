#!/usr/bin/env node
// End to end with BOTH real extensions in Chromium: Still (this repo's extension/) and a built Threadkeeper.
//
//   TK_EXTENSION_DIR=/path/to/threadkeeper/.output/chrome-mv3 node scripts/e2e-threadkeeper.mjs [--out <dir>] [--headed]
//
// Needs Playwright (resolved from NODE_PATH or a global install) and a Chromium it can launch. It seeds Threadkeeper
// through its own Import dialog (a ChatGPT export and a Claude Code session) and its service worker database (a
// Paperclip agent thread, a thread in the local-only "Personal" project, an AI analysis v2), pairs the two extensions
// through Still's settings card and Threadkeeper's consent window, syncs, and checks the chat pages, updates, local-only
// removal, the assistant's thread tools, "Send to Still" and Still on its own. Screenshots and a JSON report go to
// --out (default: a new folder in the system temp directory). Exit code 1 when a check fails or a page logs an error.
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SD_DIR = path.resolve(here, '../extension');
const TK_DIR = process.env.TK_EXTENSION_DIR ? path.resolve(process.env.TK_EXTENSION_DIR) : '';
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
if (!TK_DIR || !existsSync(path.join(TK_DIR, 'manifest.json'))) {
  console.error('Set TK_EXTENSION_DIR to a built Threadkeeper (npm run build in threadkeeper → .output/chrome-mv3).');
  process.exit(2);
}
const OUT = path.resolve(option('--out') || await mkdtemp(path.join(tmpdir(), 'still-tk-e2e-')));
await mkdir(OUT, { recursive: true });
const { chromium } = createRequire(import.meta.url)('playwright');
const { threadHash, chatItemId } = await import(path.join(SD_DIR, 'lib/threadkeeper/protocol.js'));

/* ------------------------------------------------------------------ reporting */

const checks = [];
const consoleErrors = [];
const shots = [];
let current = '';
function check(ok, label, detail = '') {
  checks.push({ step: current, ok: !!ok, label, ...(detail ? { detail: String(detail).slice(0, 2000) } : {}) });
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${String(detail).slice(0, 400)}` : ''}`);
  return !!ok;
}
async function step(name, fn) {
  if (bailed || (option('--until') && parseFloat(name) > parseFloat(option('--until')))) return;
  current = name;
  const failedBefore = checks.filter(c => !c.ok).length;
  console.log(`\n# ${name}`);
  try { await fn(); } catch (error) { check(false, `${name} threw`, error?.stack || error); }
  if (flag('--bail') && checks.filter(c => !c.ok).length > failedBefore) bailed = true;
}
let bailed = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, { timeout = 30_000, interval = 500, label = 'condition' } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
}
async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  shots.push(file);
  return file;
}
// Benign noise that is not the product's (Chromium's own favicon fetches for extension pages etc.).
const IGNORED = [/favicon\.ico/i, /Failed to load resource: net::ERR_FILE_NOT_FOUND.*favicon/i];
function watchPage(page, where = '') {
  const label = () => where || page.url().replace(/^chrome-extension:\/\/[a-p]{32}\//, '');
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED.some(re => re.test(text))) return;
    consoleErrors.push({ step: current, where: label(), text });
  });
  page.on('pageerror', error => consoleErrors.push({ step: current, where: label(), text: `pageerror: ${error?.stack || error}` }));
}
function watchWorker(worker, name) {
  worker.on?.('console', msg => { if (msg.type() === 'error') consoleErrors.push({ step: current, where: `${name} worker`, text: msg.text() }); });
}
// Errors a service worker logged or threw, captured inside it (the console event does not reach every Playwright build).
const ERROR_TRAP = () => {
  if (globalThis.__e2eErrors) return true;
  globalThis.__e2eErrors = [];
  const original = console.error.bind(console);
  console.error = (...parts) => {
    globalThis.__e2eErrors.push(parts.map(part => part instanceof Error ? part.stack || part.message : typeof part === 'string' ? part : (() => { try { return JSON.stringify(part); } catch { return String(part); } })()).join(' '));
    original(...parts);
  };
  self.addEventListener('error', event => globalThis.__e2eErrors.push(`uncaught: ${event.message}`));
  self.addEventListener('unhandledrejection', event => globalThis.__e2eErrors.push(`unhandled rejection: ${event.reason?.stack || event.reason}`));
  return true;
};
async function drainWorkerErrors(worker, name) {
  try {
    const list = await worker.evaluate(() => { const list = globalThis.__e2eErrors || []; globalThis.__e2eErrors = []; return list; });
    for (const text of list) consoleErrors.push({ step: current, where: `${name} worker`, text });
  } catch {}
}

/* ------------------------------------------------------------------ fixtures */

const NOW = Date.now();
const iso = minutesAgo => new Date(NOW - minutesAgo * 60_000).toISOString();
const unix = minutesAgo => Math.floor((NOW - minutesAgo * 60_000) / 1000);

const REACT_ANSWER_1 = `Debounce the *value*, not the handler, and let an effect fire the request.

#### Option 1: a \`useDebounce\` hook

+ Keeps the input responsive (state updates on every keystroke)
+ Fires the request only after the user pauses
+ Works with any data-fetching library

\`\`\`tsx
import { useEffect, useState } from \x27react\x27;

export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
\`\`\`

Then in the component:

1) keep \`query\` in state,
2) derive \`debouncedQuery = useDebounce(query, 300)\`,
3) fetch in an effect keyed on \`debouncedQuery\`.

| Approach | Re-renders | Cancels stale requests |
| --- | --- | --- |
| \`useDebounce\` hook | every keystroke | no (add AbortController) |
| \`lodash.debounce\` in \`useMemo\` | fewer | no |

> **Tip:** 250–400 ms feels instant for search boxes.`;

const REACT_ANSWER_2 = `Yes. Pair the debounced value with an \`AbortController\` so a slow, stale response can never overwrite a newer one:

\`\`\`tsx
useEffect(() => {
  if (!debouncedQuery) return;
  const controller = new AbortController();
  fetch(\`/api/search?q=\${encodeURIComponent(debouncedQuery)}\`, { signal: controller.signal })
    .then(res => res.json())
    .then(setResults)
    .catch(err => { if (err.name !== 'AbortError') setError(err); });
  return () => controller.abort();
}, [debouncedQuery]);
\`\`\`

The cleanup runs before the next effect, so only the latest request survives.`;

const REACT_ANSWER_3 = `Here is a test with Vitest and fake timers:

\`\`\`ts
import { renderHook, act } from \x27@testing-library/react\x27;
import { vi, it, expect } from \x27vitest\x27;
import { useDebounce } from \x27./useDebounce\x27;

it('updates after the delay', () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ v }) => useDebounce(v, 300), { initialProps: { v: 'a' } });
  rerender({ v: 'ab' });
  expect(result.current).toBe('a');
  act(() => { vi.advanceTimersByTime(300); });
  expect(result.current).toBe('ab');
});
\`\`\``;

function chatgptConversation({ id, title, minutesAgo, turns }) {
  const mapping = {};
  let parent = null;
  turns.forEach(([role, text], i) => {
    const node = `${id}-n${i}`;
    mapping[node] = { id: node, parent, children: [], message: { id: node, author: { role }, create_time: unix(minutesAgo - i), content: { content_type: 'text', parts: [text] } } };
    if (parent) mapping[parent].children.push(node);
    parent = node;
  });
  return { id, title, create_time: unix(minutesAgo + 5), update_time: unix(minutesAgo - turns.length), current_node: parent, mapping, conversation_id: id };
}
const REACT_ID = '6a1f0c2e-react-debounce-0001';
const PERSONAL_ID = '6a1f0c2e-weekend-meals-0002';
const chatgptExport = [
  chatgptConversation({ id: REACT_ID, title: 'Debounce a search input in React', minutesAgo: 600, turns: [
    ['user', 'My search box fires a request on every keystroke. How do I debounce it in React with hooks?'],
    ['assistant', REACT_ANSWER_1],
    ['user', 'Can I also cancel requests that are already in flight?'],
    ['assistant', REACT_ANSWER_2],
    ['user', 'Great, I will go with the hook plus AbortController. Can you add a test for the hook?'],
    ['assistant', REACT_ANSWER_3],
  ] }),
  chatgptConversation({ id: PERSONAL_ID, title: 'Weekend meal plan for the family', minutesAgo: 900, turns: [
    ['user', 'Plan three dinners for the weekend, one vegetarian, using my grandmother\'s secret lasagna recipe.'],
    ['assistant', 'Friday: grandmother\'s lasagna. Saturday: chickpea curry (vegetarian). Sunday: roast chicken with root vegetables.'],
  ] }),
];

const CC_SESSION = '9d4b7f3a-2c61-4e1b-b0aa-5c3e1f7d2a90';
function claudeCodeSession() {
  const records = [];
  let t = 0;
  const ts = () => new Date(NOW - 300 * 60_000 + (t++) * 20_000).toISOString();
  const base = { sessionId: CC_SESSION, cwd: '/Users/me/code/billing-service', gitBranch: 'refactor/invoice-totals', version: '2.1.0' };
  let n = 0;
  const user = content => records.push({ type: 'user', ...base, uuid: `u${++n}`, timestamp: ts(), message: { role: 'user', content } });
  const assistant = content => records.push({ type: 'assistant', ...base, uuid: `a${++n}`, timestamp: ts(), message: { id: `msg_${n}`, role: 'assistant', model: 'claude-opus-4-1', content } });
  const tool = (name, input, output, error = false) => {
    const id = `toolu_${++n}`;
    assistant([{ type: 'tool_use', id, name, input }]);
    user([{ type: 'tool_result', tool_use_id: id, content: output, is_error: error }]);
  };
  records.push({ type: 'ai-title', sessionId: CC_SESSION, title: 'Refactor invoice totals into a pure module' });
  user('The invoice totals logic in src/invoices/totals.ts mixes tax, discounts and rounding with database calls. Refactor it into a pure module with tests. Keep the public API.');
  assistant([{ type: 'text', text: 'I will read the current implementation and its callers first.' }]);
  tool('Read', { file_path: '/Users/me/code/billing-service/src/invoices/totals.ts' }, 'export async function computeTotals(invoiceId: string) {\n  const lines = await db.lines.find(invoiceId);\n  let subtotal = 0;\n  for (const l of lines) subtotal += l.qty * l.unitPrice;\n  ...\n}');
  tool('Grep', { pattern: 'computeTotals', path: 'src' }, 'src/invoices/totals.ts\nsrc/api/invoices.ts\nsrc/jobs/monthly-close.ts');
  for (let i = 1; i <= 14; i++) {
    assistant([{ type: 'text', text: `Step ${i}: ${['Extracting the line subtotal into `lineSubtotal(line)`.', 'Moving the discount rules into `applyDiscounts(subtotal, rules)`.', 'Rounding with banker\'s rounding in one place (`roundMoney`).', 'Keeping `computeTotals(invoiceId)` as a thin wrapper that loads data and calls `totalsFor(lines, rules, taxRate)`.'][i % 4]}` }]);
    tool(i % 3 === 0 ? 'Bash' : 'Edit', i % 3 === 0 ? { command: 'npm test -- invoices', description: 'Run the invoice tests' }
      : { file_path: `/Users/me/code/billing-service/src/invoices/${i % 2 ? 'pure-totals.ts' : 'totals.ts'}`, old_string: 'subtotal +=', new_string: 'subtotal = add(subtotal,' },
    i % 3 === 0 ? `PASS src/invoices/totals.test.ts (${i} tests)\nOPENAI_API_KEY=sk-test${'a'.repeat(24)}` : 'The file has been updated.', i === 9);
  }
  user('Looks good. Is the monthly close job still using the old function?');
  assistant([{ type: 'text', text: 'Yes — `src/jobs/monthly-close.ts` still calls `computeTotals` per invoice. It now goes through the pure `totalsFor`, so behaviour is unchanged. Next I would batch the line loading there.\n\n```ts\nexport function totalsFor(lines: Line[], rules: DiscountRule[], taxRate: number): Totals {\n  const subtotal = lines.reduce((sum, l) => add(sum, lineSubtotal(l)), 0);\n  const discounted = applyDiscounts(subtotal, rules);\n  return { subtotal, discount: subtotal - discounted, tax: roundMoney(discounted * taxRate), total: roundMoney(discounted * (1 + taxRate)) };\n}\n```' }]);
  return records.map(record => JSON.stringify(record)).join('\n') + '\n';
}

/* ------------------------------------------------------------------ browser */

const profile = await mkdtemp(path.join(tmpdir(), 'still-tk-profile-'));
const launchArgs = dirs => ({
  channel: 'chromium', headless: !flag('--headed'), viewport: { width: 1280, height: 860 },
  args: [`--disable-extensions-except=${dirs.join(',')}`, `--load-extension=${dirs.join(',')}`],
});
let context = await chromium.launchPersistentContext(profile, launchArgs([SD_DIR, TK_DIR]));
context.on('page', page => watchPage(page));

async function workers(ctx, names) {
  const found = {};
  const inspect = async worker => {
    try {
      const name = await worker.evaluate(() => chrome.runtime.getManifest().name);
      if (!found[name]) { found[name] = worker; watchWorker(worker, name); await worker.evaluate(ERROR_TRAP); }
    } catch {}
  };
  ctx.on('serviceworker', inspect);
  await waitFor(async () => { for (const worker of ctx.serviceWorkers()) await inspect(worker); return names.every(name => found[name]); }, { timeout: 30_000, label: `service workers ${names.join(', ')}` });
  return found;
}
const NAMES = { still: JSON.parse(readFileSync(path.join(SD_DIR, 'manifest.json'), 'utf8')).name, tk: JSON.parse(readFileSync(path.join(TK_DIR, 'manifest.json'), 'utf8')).name };
let sw = await workers(context, [NAMES.still, NAMES.tk]);
let stillSw = sw[NAMES.still];
const tkSw = sw[NAMES.tk];
const stillId = new URL(stillSw.url()).host;
const tkId = new URL(tkSw.url()).host;
const stillUrl = (p = 'index.html') => `chrome-extension://${stillId}/${p}`;
const tkUrl = p => `chrome-extension://${tkId}/${p}`;
console.log(`Still ${stillId}\nThreadkeeper ${tkId}\nOutput ${OUT}`);
// The error trap works: a console.error in a worker is collected (then dropped from the report).
await stillSw.evaluate(() => console.error('e2e-probe'));
await drainWorkerErrors(stillSw, 'probe');
const probed = consoleErrors.findIndex(error => error.text.includes('e2e-probe'));
if (probed < 0) { console.error('The worker error trap does not work; console errors would go unnoticed.'); process.exit(2); }
consoleErrors.length = 0;

const libraryOf = () => stillSw.evaluate(async () => (await chrome.storage.local.get('still.library.v1'))['still.library.v1']);
const tkStateOf = () => stillSw.evaluate(async () => (await chrome.storage.local.get('still.threadkeeper.v1'))['still.threadkeeper.v1']);
const chatsOf = async () => ((await libraryOf())?.items || []).filter(item => item.type === 'chat');
const tkDb = (fn, arg) => tkSw.evaluate(fn, arg);
// Still's chat data store (IndexedDB still.chats.v1), read from a Still page.
async function chatDataOf(page) {
  return page.evaluate(async () => {
    const mod = await import(location.origin + '/lib/chat-data.js');
    const ids = await mod.listChatDataIds();
    const out = { ids, records: {}, transcripts: {}, stats: await mod.chatDataStats() };
    for (const id of ids) {
      const record = await mod.getChatRecord(id);
      const transcript = await mod.getChatTranscript(id);
      out.records[id] = record ? { threadKey: record.threadKey, revision: record.revision, fingerprint: record.fingerprint, hasAnalysis: !!record.thread?.analysis, analysisVersion: record.thread?.analysis?.analysisVersion || 0 } : null;
      out.transcripts[id] = transcript ? { revision: transcript.revision, messages: transcript.messages.length, totalMessages: transcript.totalMessages, truncated: transcript.truncated,
        redacted: transcript.messages.some(m => /\[redacted\]/.test(m.content)), leaked: transcript.messages.some(m => /sk-testaaaa/.test(m.content)) } : null;
    }
    return out;
  });
}

const keys = {};
let stillPage;

/* ------------------------------------------------------------------ 1. seed Threadkeeper */

await step('1. Seed Threadkeeper', async () => {
  const manager = await context.newPage();
  await manager.goto(tkUrl('manager.html'));
  await manager.getByRole('button', { name: /Import \/ Export/ }).first().click();
  const dialog = manager.locator('#tk-import-export-dialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('input[type=file]:not([webkitdirectory])').first().setInputFiles([
    { name: 'conversations.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(chatgptExport)) },
    { name: `${CC_SESSION}.jsonl`, mimeType: 'application/json', buffer: Buffer.from(claudeCodeSession()) },
  ]);
  const imported = await waitFor(() => tkDb(async () => {
    const convs = await globalThis.__threadkeeperDb.conversations.toArray();
    return convs.length >= 3 ? convs.map(c => ({ threadKey: c.threadKey, provider: c.provider, title: c.title, project: c.project, sourceConversationId: c.sourceConversationId, messageCount: c.messageCount })) : null;
  }), { timeout: 30_000, label: 'the import' });
  check(imported.length === 3, 'Import dialog stored the ChatGPT export and the Claude Code session', JSON.stringify(imported));
  keys.react = imported.find(c => c.sourceConversationId === REACT_ID)?.threadKey;
  keys.personal = imported.find(c => c.sourceConversationId === PERSONAL_ID)?.threadKey;
  keys.cc = imported.find(c => c.provider === 'claude_code')?.threadKey;
  check(keys.react && keys.personal && keys.cc, 'Thread keys for the ChatGPT chats and the Claude Code session', JSON.stringify(keys));
  await shot(manager, '01-threadkeeper-import');
  await manager.keyboard.press('Escape');

  // Local analysis runs as part of the import; wait for it so payloads carry an analysis.
  await waitFor(() => tkDb(async k => (await globalThis.__threadkeeperDb.insights.bulkGet([`local|${k.react}`, `local|${k.cc}`])).every(Boolean), keys), { timeout: 30_000, label: 'local analysis' });

  // The rest through Threadkeeper's own database (its service worker exposes the Dexie instance).
  const seeded = await tkDb(async ({ k, now }) => {
    const db = globalThis.__threadkeeperDb;
    const out = {};
    // Personal (local-only) project.
    const personal = await db.collections.get('Personal');
    out.personalLocalOnly = !!personal?.cloudExcluded;
    const pconv = await db.conversations.get(k.personal);
    await db.conversations.put({ ...pconv, project: 'Personal', projectSource: 'manual', categoryLocked: true });
    // A Paperclip agent thread (Paperclip threads come from its server sync; this is the record shape it writes).
    const base = await db.conversations.get(k.react);
    const sourceConversationId = 'issue-PAP-142';
    const threadKey = `paperclip:paperclip_local:company_acme:${sourceConversationId}:main`;
    const turns = [
      ['user', 'PAP-142: Plan Q1 hiring for the platform team. Budget is 3 senior engineers and 1 SRE.'],
      ['assistant', 'Plan:\n\n1. Open two senior backend roles in January (payments, data platform).\n2. Open the SRE role in January; it unblocks the on-call rotation.\n3. Hold the third senior role until the February budget review.\n\nRisks: recruiting lead time is ~10 weeks.'],
      ['tool', '[tool] create_issue {"title":"Write JD: Senior Backend (Payments)","assignee":"Recruiter"}'],
      ['assistant', 'Created PAP-143 (JD for Senior Backend, Payments) and assigned it to the Recruiter agent. Waiting on the CFO for the SRE band.'],
    ];
    await db.messages.bulkPut(turns.map(([role, content], i) => ({ messageKey: `${threadKey}:m:${i}`, threadKey, ordinal: i, sourceMessageId: `pc-${i}`, role, content,
      createdAt: new Date(now - (200 - i) * 60_000).toISOString(), contentHash: `pc${i}`, hasCode: false, hasArtifact: false, branchPath: 'main' })));
    await db.conversations.put({ ...base, threadKey, provider: 'paperclip', accountId: 'paperclip_local', workspaceId: 'company_acme', sourceConversationId, branchId: 'main', parentBranchId: null,
      siblingBranchIds: [], canonicalUrl: 'https://paperclip.example.com/acme/issues/PAP-142', title: 'PAP-142 · Plan Q1 hiring for the platform team', manualTitleOverride: null,
      createdAt: new Date(now - 205 * 60_000).toISOString(), updatedAt: new Date(now - 196 * 60_000).toISOString(), lastCapturedAt: new Date(now - 190 * 60_000).toISOString(),
      sourceRevision: 1, contentHash: 'paperclip-pap-142-r1', coverage: 'full', captureSource: 'portable_import', messageCount: turns.length, project: 'Company ops', projectSource: 'provider',
      categoryLocked: false, tags: ['hiring'], manualTags: [], workflowState: 'waiting', pinned: false, cloudExcluded: false, isSyntheticBenchmark: false,
      agentLabel: 'CEO · Claude Code', modelSlug: '', workspacePath: null, gitBranch: null, resumeCommand: null, linkedThreadKeys: [], providerProjectName: 'Company ops',
      latestDecisionText: null, latestDecisionMsgIndex: null, latestDecisionSpeaker: null, nextStepText: null, nextStepMsgIndex: null, nextStepSpeaker: null, manualNotes: '' });
    out.paperclip = threadKey;
    // An AI analysis (v2) and its structured summary for the React chat, matching the stored revision.
    const conv = await db.conversations.get(k.react);
    const generatedAt = new Date(now - 30 * 60_000).toISOString();
    const item = (text, idx, quote, speaker = 'user_committed', rationale = null) => ({ text, messageIndexes: idx, evidenceQuote: quote, speaker, provenance: 'explicit', rationale });
    await db.insights.put({ insightKey: `ai|${k.react}`, threadKey: k.react, source: 'ai', model: 'claude-sonnet-4-5', sourceRevision: conv.sourceRevision, contentHash: conv.contentHash, generatedAt,
      title: 'Debounce a React search input with a hook and AbortController', gist: 'Debounced a React search box with a useDebounce hook, cancelled stale requests with AbortController, and added a Vitest test.',
      summary: 'A search box fired a request per keystroke. The thread settled on a useDebounce hook plus AbortController cleanup, with a fake-timer test.',
      overview: ['A React search box sent a request on every keystroke. The assistant proposed debouncing the value with a small `useDebounce` hook rather than debouncing the handler.',
        'To stop stale responses overwriting newer ones, each effect run creates an AbortController and aborts it in cleanup. The user chose this combination and asked for a test, which uses Vitest fake timers.'],
      userGoal: 'Stop the search box from firing a request on every keystroke.', outcome: 'Hook + AbortController chosen; test written.', kind: 'coding',
      topics: ['react', 'debounce', 'hooks', 'abortcontroller', 'vitest'], entities: ['React', 'Vitest', 'AbortController', 'lodash'], languages: ['tsx', 'ts'],
      artifacts: [{ label: 'useDebounce.ts', kind: 'code', messageIndex: 1 }, { label: 'useDebounce.test.ts', kind: 'code', messageIndex: 5 }],
      produced: [{ label: 'useDebounce.ts', kind: 'code', description: 'Generic debounce hook (300 ms default).', messageIndex: 1 },
        { label: 'useDebounce.test.ts', kind: 'code', description: 'Vitest test with fake timers.', messageIndex: 5 }],
      lastUserAsk: 'Can you add a test for the hook?', suggestedStatus: 'done', statusReason: 'The approach is chosen and tested.', suggestedProject: null, userTurns: 3, hasCode: true, analysisVersion: 2 });
    await db.summaries.put({ threadKey: k.react, sourceRevision: conv.sourceRevision, contentHash: conv.contentHash, model: 'claude-sonnet-4-5', generatedAt, groundingVerified: true,
      whereYouLeftOff: 'You have the hook, the AbortController effect and a passing test; wiring it into the search page is next.', whereYouLeftOffMessageIndexes: [4, 5],
      currentStatus: 'Done', currentStatusMessageIndexes: [5],
      decisions: [item('Use a useDebounce hook plus AbortController', [4], 'I will go with the hook plus AbortController', 'user_committed', 'Debouncing the value keeps the input responsive and abort stops stale responses.')],
      openQuestions: [item('Should the delay be configurable per page?', [1], '250–400 ms feels instant for search boxes', 'assistant_suggested')],
      actionItems: [item('Wire useDebounce into the search page', [4], 'I will go with the hook plus AbortController'), item('Add the hook test to CI', [5], 'Here is a test with Vitest and fake timers', 'assistant_suggested')],
      constraints: [], entities: ['React'], artifactReferences: [], suggestedProject: null, suggestedTags: [], confidence: 0.9,
      keyPoints: [item('Debounce the value, not the handler', [1], 'Debounce the *value*, not the handler', 'assistant_suggested'),
        item('The effect cleanup aborts the previous request', [3], 'The cleanup runs before the next effect', 'assistant_suggested')],
      nextStep: 'Replace the inline fetch in SearchPage with the debounced effect.' });
    out.reactRevision = conv.sourceRevision;
    return out;
  }, { k: keys, now: NOW });
  keys.paperclip = seeded.paperclip;
  check(seeded.personalLocalOnly, 'Threadkeeper\'s "Personal" project is local-only');
  // Reload the manager so its live queries see the direct writes, then nudge the dock (privacy-changing writes do this in the app).
  await manager.reload();
  await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'DOCK_SYNC_NOW', privacy: true }).catch(() => null));
  await shot(manager, '02-threadkeeper-library');
  await manager.close();
});

/* ------------------------------------------------------------------ 2. pair */

await step('2. Pair from Still\'s settings', async () => {
  stillPage = await context.newPage();
  await stillPage.goto(stillUrl('index.html?libraryView=settings:integrations'));
  const card = stillPage.locator('#settings-threadkeeper');
  await card.waitFor({ state: 'visible', timeout: 20_000 });
  await card.scrollIntoViewIfNeeded();
  await shot(stillPage, '03-still-settings-not-connected');
  check(/Not connected/i.test(await card.innerText()), 'The card reads "Not connected"', await card.innerText());
  await card.getByRole('button', { name: /Enter its ID instead/ }).click();
  await card.locator('input[name=extensionId]').fill(tkId);
  const consentPromise = context.waitForEvent('page', { predicate: page => page.url().includes('/connect.html'), timeout: 20_000 });
  await card.locator('form.tk-manual button[type=submit]').click();
  const consent = await consentPromise;
  await consent.waitForLoadState('domcontentloaded');
  const codeEl = card.locator('.tk-code');
  await codeEl.waitFor({ state: 'visible', timeout: 10_000 });
  const code = (await codeEl.innerText()).replace(/\D/g, '');
  check(/^\d{6}$/.test(code), 'Still shows a 6-digit code while waiting', code);
  await shot(stillPage, '04-still-settings-pending');
  check((await tkStateOf())?.status === 'pending', 'Still is pending');
  await consent.waitForSelector('input[inputmode=numeric]');
  const consentText = await consent.locator('body').innerText();
  check(/Still/.test(consentText) && consentText.replace(/\s+/g, '').includes(stillId), 'The consent window names Still and its id');
  const allow = consent.getByRole('button', { name: /^Allow/ });
  check(await allow.isDisabled(), 'Allow is disabled before the code is typed');
  await consent.locator('input[inputmode=numeric]').fill(code === '000000' ? '111111' : '000000');
  check(await allow.isDisabled(), 'Allow stays disabled for a wrong code');
  await consent.locator('input[inputmode=numeric]').fill(code);
  await shot(consent, '05-threadkeeper-consent');
  const allowedAt = Date.now();
  await allow.click();
  await waitFor(async () => (await tkStateOf())?.status === 'paired', { timeout: 45_000, label: 'Still paired' }).catch(async error => {
    console.log('  diagnostics:', JSON.stringify({ still: await tkStateOf(), tk: await tkDb(() => globalThis.__threadkeeperDock.getState()),
      consent: consent.isClosed() ? 'closed' : (await consent.locator('body').innerText()).slice(-400), tkErrors: await tkDb(() => globalThis.__e2eErrors), rejections: await tkDb(() => globalThis.__threadkeeperGetSecurityRejections?.()) }, null, 1));
    throw error;
  });
  check(true, `Still is paired (${((Date.now() - allowedAt) / 1000).toFixed(1)} s after Allow)`);
  const tkState = await tkDb(() => globalThis.__threadkeeperDock.getState());
  check(tkState.pairedId === stillId, 'Threadkeeper is paired with Still', JSON.stringify({ pairedId: tkState.pairedId }));
  await waitFor(() => consent.isClosed() || consent.locator('text=/Allowed|Connected|You can close/i').count(), { timeout: 10_000, label: 'the consent window to finish' }).catch(() => {});
});

/* ------------------------------------------------------------------ 3. start syncing */

const byKey = (chats, key) => chats.find(chat => chat.chat?.threadKey === key);
await step('3. Start syncing (every thread, mirror projects)', async () => {
  const card = stillPage.locator('#settings-threadkeeper');
  await card.getByText('Choose what to sync').waitFor({ timeout: 15_000 });
  await waitFor(async () => /Threadkeeper can share/.test(await card.innerText()), { timeout: 15_000, label: 'facets' });
  const chooseText = await card.innerText();
  check(/Threadkeeper can share 3 threads/.test(chooseText), 'Facets count 3 shareable threads (Personal withheld)', chooseText.match(/Threadkeeper can share[^.]*/)?.[0]);
  check(!/Personal/.test(chooseText), 'The local-only project is not named');
  await shot(stillPage, '06-still-choose-what-to-sync');
  await card.getByRole('button', { name: /Start syncing/ }).click();
  const chats = await waitFor(async () => { const list = await chatsOf(); return list.length >= 3 ? list : null; }, { timeout: 180_000, interval: 1000, label: '3 chats in Still' });
  check(chats.length === 3, 'Three chats arrived', chats.map(c => c.title).join(' | '));
  check(!byKey(chats, keys.personal), 'The local-only thread never arrived');
  for (const [name, key] of Object.entries({ react: keys.react, cc: keys.cc, paperclip: keys.paperclip })) {
    const chat = byKey(chats, key);
    check(chat && chat.id === chatItemId(key), `${name}: deterministic id chat_tk_<hash>`, chat?.id);
  }
  const library = await libraryOf();
  const collections = library.collections.filter(c => !c.deletedAt);
  const parent = collections.find(c => c.name === 'AI chats' && !c.parentId);
  check(parent, 'Mirror placement created the "AI chats" collection');
  const childNames = collections.filter(c => c.parentId === parent?.id).map(c => c.name);
  const pc = byKey(chats, keys.paperclip);
  const cc = byKey(chats, keys.cc);
  const pcCollection = collections.find(c => c.id === pc?.collectionId);
  const ccCollection = collections.find(c => c.id === cc?.collectionId);
  check(pcCollection?.name === 'Company ops' && pcCollection.parentId === parent?.id, 'Paperclip chat sits in AI chats › Company ops', `${pcCollection?.name} / children: ${childNames}`);
  check(ccCollection?.name === 'billing-service' && ccCollection.parentId === parent?.id, 'Claude Code chat sits in AI chats › billing-service', ccCollection?.name);
  check(pc?.chat?.category === 'agent' || pc?.chat?.provider === 'paperclip', 'Paperclip chat keeps its provider/category', JSON.stringify(pc?.chat));
  // needsTranscript round trip: metadata first, then a transcript-bearing push.
  const data = await waitFor(async () => {
    const d = await chatDataOf(stillPage);
    return chats.every(c => d.transcripts[c.id]?.messages) ? d : null;
  }, { timeout: 180_000, interval: 1500, label: 'transcripts for every chat' });
  check(true, 'Every chat has its transcript in still.chats.v1 (needsTranscript round trip)');
  check(Object.keys(data.records).length >= 3 && Object.values(data.records).every(Boolean), 'chat-data holds a record per chat', JSON.stringify(data.stats));
  check(data.records[chatItemId(keys.react)]?.analysisVersion === 2, 'The React chat carries the AI v2 analysis');
  const ccCount = await tkDb(key => globalThis.__threadkeeperDb.messages.where('threadKey').equals(key).count(), keys.cc);
  check(ccCount > 30 && data.transcripts[chatItemId(keys.cc)]?.messages === ccCount && !data.transcripts[chatItemId(keys.cc)]?.truncated, `The long Claude Code session arrived whole (${ccCount} messages)`, JSON.stringify(data.transcripts[chatItemId(keys.cc)]));
  check(data.transcripts[chatItemId(keys.cc)]?.redacted && !data.transcripts[chatItemId(keys.cc)]?.leaked, 'Secrets in tool output were redacted');
  await stillPage.reload();
  const card2 = stillPage.locator('#settings-threadkeeper');
  await card2.waitFor();
  await card2.scrollIntoViewIfNeeded();
  await waitFor(async () => /3 chats in Still/.test(await card2.innerText()), { timeout: 15_000, label: 'the card status line' }).catch(() => {});
  check(/3 chats in Still/.test(await card2.innerText()), 'The card says 3 chats in Still', (await card2.innerText()).slice(0, 300));
  await shot(stillPage, '07-still-settings-syncing');
  const both = { still: (await tkStateOf())?.status, tk: await tkDb(async () => { const s = await globalThis.__threadkeeperDock.getState(); return { paired: s.paired, configured: s.configured, scope: s.prefs.scope }; }) };
  check(both.still === 'paired' && both.tk.paired && both.tk.configured && both.tk.scope === 'all', 'Both sides stay paired and configured', JSON.stringify(both));
});

/* ------------------------------------------------------------------ 4. chat pages */

async function openChatPage(page, id, { dark = false, side = false } = {}) {
  await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
  await page.goto(side ? stillUrl(`index.html?view=sidepanel&item=${id}`) : stillUrl(`index.html?libraryView=chats&item=${id}`));
  await page.locator('.chat-toolbar').first().waitFor({ timeout: 20_000 });
}
async function setView(page, view) {
  await page.locator(`.chat-views [data-action="chat.view"][data-value="${view}"], .chat-views button:has-text("${view === 'summary' ? 'Summary' : 'Transcript'}")`).first().click();
}
await step('4. Chat pages (Chats workspace and side panel)', async () => {
  const page = stillPage;
  const reactId = chatItemId(keys.react);
  await openChatPage(page, reactId);
  await setView(page, 'summary');
  const summary = page.locator('.markdown-body').first();
  await summary.waitFor({ timeout: 15_000 });
  await waitFor(async () => /What this thread is about/.test(await page.locator('main, body').first().innerText()), { timeout: 15_000, label: 'the summary' });
  const text = await page.locator('body').innerText();
  for (const heading of ['What this thread is about', 'Key points', 'Where you left off', 'Decisions', 'Next steps', 'Open questions', 'What was produced']) {
    check(text.includes(heading), `Summary shows "${heading}"`);
  }
  check(/Debounce/.test(text) && /useDebounce/.test(text), 'Summary carries the analysis text');
  await shot(page, '08-chat-summary-light');
  // #msg-N jump from the summary.
  const ref = page.locator('.markdown-body a[href="#msg-5"]').first();
  check(await ref.count(), 'Summary has message refs (#msg-N)');
  const href = await ref.getAttribute('href');
  await ref.click();
  const target = page.locator(`.chat-msg${href.replace('#', '#')}`);
  await target.waitFor({ timeout: 10_000 });
  check(await target.isVisible(), `Clicking ${href} switches to the transcript and shows that message`);
  // The jump scrolls smoothly (unless reduced motion): give it a moment.
  const inView = await waitFor(() => target.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight - 40; }), { timeout: 4000, interval: 200, label: 'the jump' }).catch(() => false);
  await shot(page, '08b-chat-jump-msg-6');
  check(inView, `${href} is scrolled into view`);
  // Transcript checks.
  await setView(page, 'transcript');
  await page.locator('.chat-msg').first().waitFor();
  const counts = await page.evaluate(() => ({
    user: document.querySelectorAll('.chat-msg[data-role=user] .chat-bubble').length,
    assistant: document.querySelectorAll('.chat-msg[data-role=assistant] .chat-md').length,
    code: document.querySelectorAll('.chat-msg[data-role=assistant] pre code').length,
    tables: document.querySelectorAll('.chat-msg[data-role=assistant] table').length,
    h3: [...document.querySelectorAll('.chat-msg[data-role=assistant] h3')].map(h => h.textContent),
    lists: document.querySelectorAll('.chat-msg[data-role=assistant] ul li').length,
    ol: document.querySelectorAll('.chat-msg[data-role=assistant] ol li').length,
    rawHash: [...document.querySelectorAll('.chat-msg[data-role=assistant] .chat-md')].some(el => /(^|\n)#### |(^|\n)\+ /.test(el.textContent)),
  }));
  check(counts.user === 3 && counts.assistant === 3, 'Transcript has 3 user bubbles and 3 assistant messages', JSON.stringify(counts));
  check(counts.code >= 3, 'Code blocks render as <pre><code>', counts.code);
  check(counts.tables >= 1, 'The Markdown table renders');
  check(counts.h3.some(h => /useDebounce/.test(h)), '#### heading is normalized to h3', JSON.stringify(counts.h3));
  check(counts.lists >= 3 && counts.ol >= 3 && !counts.rawHash, '"+ " bullets and "1)" lists render as lists');
  await shot(page, '09-chat-transcript-light');
  // Find in chat.
  const find = page.locator('.chat-find-input');
  await find.fill('AbortController');
  await page.waitForTimeout(400);
  const hits = await page.locator('mark.chat-find-hit').count();
  const countLabel = await page.locator('.chat-find-count').innerText();
  check(hits >= 2 && /\d/.test(countLabel), 'Find in chat highlights matches and shows a count', `${hits} hits, "${countLabel}"`);
  await find.press('Enter');
  check(await page.locator('mark.chat-find-hit.is-current').count() === 1, 'Enter steps to a current match');
  await shot(page, '10-chat-find');
  await find.fill('');
  // Claude Code session: tool chips.
  await openChatPage(page, chatItemId(keys.cc));
  await setView(page, 'transcript');
  await page.locator('.chat-msg').first().waitFor();
  const tools = await page.locator('.chat-msg[data-role=tool] details.chat-tool').count();
  check(tools >= 10, 'Claude Code tool messages render as collapsed tool chips', tools);
  await shot(page, '11-claude-code-transcript-light');
  // Paperclip summary shows the agent.
  await openChatPage(page, chatItemId(keys.paperclip));
  await setView(page, 'summary');
  await page.waitForTimeout(500);
  check(/CEO · Claude Code/.test(await page.locator('body').innerText()), 'Paperclip chat shows its agent label');
  await shot(page, '12-paperclip-summary-light');
  // Dark mode.
  await openChatPage(page, reactId, { dark: true });
  await setView(page, 'summary');
  await page.waitForTimeout(500);
  check(await page.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'Dark theme follows the system');
  await shot(page, '13-chat-summary-dark');
  await setView(page, 'transcript');
  await page.locator('.chat-msg').first().waitFor();
  await shot(page, '14-chat-transcript-dark');
  // Side panel.
  const side = await context.newPage();
  await side.setViewportSize({ width: 400, height: 860 });
  await openChatPage(side, reactId, { side: true });
  await setView(side, 'summary');
  await side.waitForTimeout(500);
  check(/What this thread is about/.test(await side.locator('body').innerText()), 'Side panel shows the chat summary');
  const overflow = await side.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, 'Side panel has no horizontal scroll', overflow);
  await shot(side, '15-sidepanel-summary-light');
  await setView(side, 'transcript');
  await side.locator('.chat-msg').first().waitFor();
  await shot(side, '16-sidepanel-transcript-light');
  await side.close();
  await page.emulateMedia({ colorScheme: 'light' });
});

/* ------------------------------------------------------------------ 5. updates and local-only */

await step('5. Updates keep a user rename; local-only removes the chat', async () => {
  const reactId = chatItemId(keys.react);
  // Rename in Still (through the library store, as the inline rename does).
  await stillPage.goto(stillUrl('index.html?libraryView=chats&item=' + reactId));
  await stillPage.locator('.chat-toolbar').waitFor();
  await stillPage.evaluate(async id => { const store = await import(location.origin + '/lib/store.js'); await store.updateItem(id, { title: 'My debounce notes (renamed)' }); }, reactId);
  const before = byKey(await chatsOf(), keys.react);
  check(before.title === 'My debounce notes (renamed)', 'Renamed in Still');
  // New message in Threadkeeper (a re-import of the conversation with one more turn, through upsert semantics).
  await tkDb(async ({ key, now }) => {
    const db = globalThis.__threadkeeperDb;
    const conv = await db.conversations.get(key);
    const ordinal = conv.messageCount;
    await db.messages.bulkPut([
      { messageKey: `${key}:m:${ordinal}`, threadKey: key, ordinal, sourceMessageId: `late-${ordinal}`, role: 'user', content: 'One more thing: should the hook also expose a flush() for submit buttons?', createdAt: new Date(now).toISOString(), contentHash: 'late-u', hasCode: false, hasArtifact: false, branchPath: 'main' },
      { messageKey: `${key}:m:${ordinal + 1}`, threadKey: key, ordinal: ordinal + 1, sourceMessageId: `late-${ordinal + 1}`, role: 'assistant', content: 'Yes: return `[debounced, flush]` where `flush()` clears the timer and sets the value at once.', createdAt: new Date(now).toISOString(), contentHash: 'late-a', hasCode: false, hasArtifact: false, branchPath: 'main' },
    ]);
    await db.conversations.put({ ...conv, messageCount: ordinal + 2, sourceRevision: conv.sourceRevision + 1, contentHash: `${conv.contentHash}-r2`, updatedAt: new Date(now).toISOString(), title: 'Debounce a search input in React (with flush)' });
  }, { key: keys.react, now: Date.now() });
  await stillPage.evaluate(async () => { const tk = await import(location.origin + '/lib/threadkeeper/client.js'); await tk.syncThreadkeeperNow(); });
  const after = await waitFor(async () => { const chat = byKey(await chatsOf(), keys.react); return chat && chat.chat.messageCount === 8 ? chat : null; }, { timeout: 240_000, interval: 2000, label: 'the update to arrive' });
  check(after.title === 'My debounce notes (renamed)', 'The user rename survived the update', after.title);
  const transcript = await waitFor(async () => { const d = await chatDataOf(stillPage); return d.transcripts[reactId]?.messages === 8 ? d.transcripts[reactId] : null; }, { timeout: 180_000, interval: 2000, label: 'the new transcript' });
  check(transcript.messages === 8, 'The new messages arrived in the transcript');

  // Mark the Paperclip thread local-only in Threadkeeper.
  const pcId = chatItemId(keys.paperclip);
  await tkDb(async key => { const db = globalThis.__threadkeeperDb; const conv = await db.conversations.get(key); await db.conversations.put({ ...conv, cloudExcluded: true }); }, keys.paperclip);
  const manager = await context.newPage();
  await manager.goto(tkUrl('manager.html'));
  await manager.evaluate(key => chrome.runtime.sendMessage({ type: 'DOCK_SYNC_NOW', threadKeys: [key], privacy: true }), keys.paperclip);
  await manager.close();
  await waitFor(async () => !(await libraryOf()).items.some(item => item.id === pcId), { timeout: 150_000, interval: 2000, label: 'the local-only chat to leave Still' });
  check(true, 'The untouched Paperclip chat was deleted from Still');
  const data = await chatDataOf(stillPage);
  check(!data.ids.includes(pcId), 'Its record and transcript were deleted from still.chats.v1');
});

/* ------------------------------------------------------------------ 6. assistant tools */

await step('6. Assistant thread tools without a model', async () => {
  await stillPage.goto(stillUrl('index.html?libraryView=chats'));
  await stillPage.waitForLoadState('domcontentloaded');
  const result = await stillPage.evaluate(async ({ cc, react }) => {
    const [{ createToolSession }, { threadSources }, store, { createSearch }, protocol] = await Promise.all([
      import(location.origin + '/lib/ai/tools.js'), import(location.origin + '/lib/ai/threads.js'), import(location.origin + '/lib/store.js'), import(location.origin + '/lib/ai/search.js'), import(location.origin + '/lib/threadkeeper/protocol.js')]);
    const getLibrary = () => store.loadLibrary();
    const sources = threadSources({ getLibrary });
    const threads = await sources.threads();
    const events = [];
    const session = createToolSession({ getLibrary, searchLibrary: createSearch({ getLibrary }).searchLibrary, store, threads, chats: sources.chats, threadTools: true,
      onEvent: event => events.push(event), onProposal: async () => 'apply' });
    const call = async (name, input) => { const [res] = await session.execute([{ id: `c_${name}_${events.length}`, name, input }]); let parsed; try { parsed = JSON.parse(res.content); } catch { parsed = res.content; } return { isError: !!res.isError, data: parsed }; };
    const search = await call('search_ai_threads', { query: 'invoice totals refactor', source: 'coding_agent' });
    const rows = search.data?.items || [];
    const get = await call('get_ai_threads', { ids: rows.slice(0, 1).map(r => r.id), detail: 'both', query: 'monthly close' });
    const created = await session.execute([{ id: 'cc1', name: 'create_collection', input: { name: 'Refactors' } }, { id: 'ii1', name: 'import_ai_threads', input: { ids: [protocol.threadCiteId(cc), protocol.threadCiteId(react)], collectionId: 'new:Refactors' } }]);
    const library = await store.loadLibrary();
    const refactors = library.collections.find(c => c.name === 'Refactors' && !c.deletedAt);
    return { threadsAvailable: !!threads, search, rows, get, created: created.map(r => ({ isError: !!r.isError, content: r.content.slice(0, 600) })),
      refactors: refactors ? { id: refactors.id, chats: library.items.filter(i => i.type === 'chat' && i.collectionId === refactors.id).map(i => i.id) } : null,
      expected: { cc: protocol.chatItemId(cc), react: protocol.chatItemId(react) } };
  }, { cc: keys.cc, react: keys.react });
  check(result.threadsAvailable, 'The Threadkeeper adapter is available to the assistant');
  check(!result.search.isError && result.rows.length >= 1, 'search_ai_threads (source coding_agent) returns rows', JSON.stringify(result.search).slice(0, 600));
  check(result.rows.every(r => r.source === 'coding_agent' || /Claude Code|Codex/.test(r.provider)), 'Every row is a coding-agent session', JSON.stringify(result.rows.map(r => [r.provider, r.source])));
  const ccRow = result.rows.find(r => r.threadKey === keys.cc);
  check(ccRow && ccRow.id === result.expected.cc && ccRow.inLibrary === result.expected.cc, 'The Claude Code row cites the library chat id', JSON.stringify(ccRow));
  check(!result.get.isError && /monthly|totals/i.test(JSON.stringify(result.get.data)), 'get_ai_threads reads the session', JSON.stringify(result.get.data).slice(0, 400));
  check(!/\[tool\]/.test(JSON.stringify(result.get.data)), 'get_ai_threads leaves tool messages out by default');
  check(result.created.every(r => !r.isError) && /applied/.test(result.created[1].content), 'import_ai_threads applied into a new collection', JSON.stringify(result.created));
  check(result.refactors && [result.expected.cc, result.expected.react].every(id => result.refactors.chats.includes(id)), 'Both chats are now in the new "Refactors" collection', JSON.stringify(result.refactors));
});

await step('6b. A touched chat that becomes local-only keeps only the user\'s notes', async () => {
  const ccId = chatItemId(keys.cc);
  await stillPage.evaluate(async id => { const store = await import(location.origin + '/lib/store.js'); await store.updateItem(id, { content: 'My notes: ask Dana about the rounding rule.' }); }, ccId);
  await tkDb(async key => { const db = globalThis.__threadkeeperDb; const conv = await db.conversations.get(key); await db.conversations.put({ ...conv, cloudExcluded: true }); }, keys.cc);
  const manager = await context.newPage();
  await manager.goto(tkUrl('manager.html'));
  await manager.evaluate(key => chrome.runtime.sendMessage({ type: 'DOCK_SYNC_NOW', threadKeys: [key], privacy: true }), keys.cc);
  await manager.close();
  const item = await waitFor(async () => { const chat = (await libraryOf()).items.find(entry => entry.id === ccId); return chat?.chat?.removed === 'local_only' ? chat : null; }, { timeout: 150_000, interval: 2000, label: 'the touched chat to be stripped' });
  check(item.title === 'Private thread' && item.content.includes('Dana') && !item.excerpt, 'Stripped to "Private thread" with the user\'s notes kept', JSON.stringify({ title: item.title, excerpt: item.excerpt, chat: item.chat }));
  check(!(await chatDataOf(stillPage)).ids.includes(ccId), 'Its summary and transcript were deleted');
  const hidden = await stillPage.evaluate(async () => {
    const [{ threadSources }, store] = await Promise.all([import(location.origin + '/lib/ai/threads.js'), import(location.origin + '/lib/store.js')]);
    const sources = threadSources({ getLibrary: () => store.loadLibrary() });
    return (await sources.chats.searchLocal('rounding invoice totals', { limit: 5 })).map(row => row.id ?? row.itemId);
  });
  check(!hidden.includes(ccId), 'The assistant no longer sees it', JSON.stringify(hidden));
});

/* ------------------------------------------------------------------ 7. Send to Still, then Still alone */

await step('7a. Send to Still (DOCK_SEND) with a target collection', async () => {
  // Bring the Paperclip thread back as shareable, then send it by hand into a named collection.
  await tkDb(async key => { const db = globalThis.__threadkeeperDb; const conv = await db.conversations.get(key); await db.conversations.put({ ...conv, cloudExcluded: false }); }, keys.paperclip);
  const manager = await context.newPage();
  await manager.goto(tkUrl('manager.html'));
  const res = await manager.evaluate(key => chrome.runtime.sendMessage({ type: 'DOCK_SEND', threadKeys: [key], target: { collectionName: 'Hiring' } }), keys.paperclip);
  check(res?.ok && res.queued === 1, 'Threadkeeper queued the send', JSON.stringify(res));
  await manager.close();
  const chat = await waitFor(async () => byKey(await chatsOf(), keys.paperclip), { timeout: 120_000, interval: 1500, label: 'the sent chat' });
  const library = await libraryOf();
  const hiring = library.collections.find(c => c.id === chat.collectionId);
  check(hiring?.name === 'Hiring' && !hiring.parentId, 'The sent chat landed in a top-level "Hiring" collection', hiring?.name);
  check(chat.chat.origin === 'manual', 'Its origin is manual');
});

await step('7b. Still keeps working without Threadkeeper', async () => {
  for (const [name, worker] of Object.entries(sw)) await drainWorkerErrors(worker, name);
  await context.close();
  context = await chromium.launchPersistentContext(profile, launchArgs([SD_DIR]));
  context.on('page', page => watchPage(page));
  sw = await workers(context, [NAMES.still]);
  stillSw = sw[NAMES.still];
  const page = await context.newPage();
  const reactId = chatItemId(keys.react);
  await openChatPage(page, reactId);
  await setView(page, 'summary');
  await waitFor(async () => /What this thread is about/.test(await page.locator('body').innerText()), { timeout: 15_000, label: 'the summary offline' });
  check(true, 'The summary renders without Threadkeeper');
  await setView(page, 'transcript');
  await page.locator('.chat-msg').first().waitFor({ timeout: 10_000 });
  check(await page.locator('.chat-msg').count() === 8, 'The transcript renders without Threadkeeper');
  await shot(page, '17-offline-transcript');
  const offline = await page.evaluate(async () => { const mod = await import(location.origin + '/lib/chat-data.js'); return mod.searchChats('AbortController', { limit: 5 }); });
  check(offline.results?.[0]?.id === reactId, 'Offline chat search finds the React chat', JSON.stringify(offline).slice(0, 300));
  const tools = await page.evaluate(async () => {
    const [{ createToolSession }, { threadSources }, store, { createSearch }] = await Promise.all([import(location.origin + '/lib/ai/tools.js'), import(location.origin + '/lib/ai/threads.js'), import(location.origin + '/lib/store.js'), import(location.origin + '/lib/ai/search.js')]);
    const getLibrary = () => store.loadLibrary();
    const sources = threadSources({ getLibrary });
    const threads = await sources.threads().catch(() => null);
    const session = createToolSession({ getLibrary, searchLibrary: createSearch({ getLibrary }).searchLibrary, store, threads, chats: sources.chats, threadTools: true, onProposal: async () => 'apply' });
    const [res] = await session.execute([{ id: 's', name: 'search_ai_threads', input: { query: 'debounce' } }]);
    return { threads: !!threads, content: res.content.slice(0, 800), isError: !!res.isError };
  });
  check(!tools.isError && /debounce/i.test(tools.content), 'search_ai_threads falls back to the chats saved in Still', tools.content);
  await page.goto(stillUrl('index.html?libraryView=settings:integrations'));
  const card = page.locator('#settings-threadkeeper');
  await card.waitFor();
  await card.scrollIntoViewIfNeeded();
  await waitFor(async () => /Not responding/i.test(await card.innerText()), { timeout: 30_000, label: '"Not responding"' }).catch(() => {});
  check(/Not responding/i.test(await card.innerText()), 'The settings card says "Not responding"', (await card.innerText()).slice(0, 300));
  await shot(page, '18-offline-settings');
  await drainWorkerErrors(stillSw, NAMES.still);
});

/* ------------------------------------------------------------------ report */

current = 'end';
try { for (const [name, worker] of Object.entries(sw)) await drainWorkerErrors(worker, name); } catch {}
await context.close().catch(() => {});
await rm(profile, { recursive: true, force: true }).catch(() => {});
const failed = checks.filter(c => !c.ok);
const report = { stillId, tkId, keys, checks, consoleErrors, screenshots: shots };
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; ${consoleErrors.length} console errors.`);
for (const error of consoleErrors) console.log(`  console error [${error.step}] ${error.where}: ${error.text.slice(0, 500)}`);
console.log(`Report: ${path.join(OUT, 'report.json')}`);
process.exit(failed.length || consoleErrors.length ? 1 : 0);
