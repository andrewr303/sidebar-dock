# Sidebar Dock (Still): runtime and messaging map for the Threadkeeper integration

**Failing test:** not found. I ran 35 test files one at a time and all passed: core-background, storage-background, capture-background, pages-worker, capture-article-background, full-page-capture, ai-engine2-tools-more, ai-cli, capture-ui, foundation-appearance, research-ui, assistant-helpers, widget-calendar, widget-github, storage-library, notes, pages-store, agent-connections, bridge-setup, integrations, library-ui, ui-foundation, ai-providers, settings-catalog, settings-ui, shell-ui, settings-assistant. `node scripts/check.mjs` also passes (301 JS files, 1191 module edges). README.md:166 says the 12 failures on the author's macOS machine were all in `tests/ai-cli.test.mjs`. That file passes 17/17 on this Linux host, so the failure must be in a file I did not run (AI engine, research, import, MCP or widgets).

---

## 1. Manifest and static gates

**`extension/manifest.json`**
- Required permissions, lines 8-20: `storage, unlimitedStorage, sidePanel, activeTab, contextMenus, scripting, alarms, notifications, favicon, search, declarativeNetRequestWithHostAccess`.
- `optional_permissions`, lines 21-25: `bookmarks, tabs, topSites`.
- `optional_host_permissions`: lines 26-32.
- Background is a module worker (`background.js`, `"type": "module"`), lines 33-36.
- CSP, line 77: `script-src 'self'; object-src 'self'; base-uri 'self';`.
- There is no `key`, no `externally_connectable`, no `content_scripts` and no `web_accessible_resources`.

**`scripts/check.mjs`** (the only thing that would reject the integration's manifest changes):
- Line 68: the `expectedPermissions` set. Any new *required* permission fails with "Review unexpected required permission" (line 72).
- Line 76: `allowedOptionalPermissions = new Set(['bookmarks', 'tabs', 'topSites'])`, checked at line 77 ("Unexpected optional permission."). **Adding `"management"` to `optional_permissions` means adding it here too.**
- Line 78: allowlist for optional hosts.
- Line 73: `host_permissions` must be empty.
- Lines 82-83: `content_scripts` and `web_accessible_resources` must be empty.
- Line 85: CSP regex (no `unsafe-*`, `https:` or `*`).
- Line 88: only `newtab` may be overridden.
- There is **no allowlist of manifest keys**, so `externally_connectable` would pass the static check.
- Module graph:
  - Every import must be relative and inside `extension/` (lines 173-176). Bare or npm specifiers fail.
  - Extension code may not import classic page scripts (`content/`, `lib/vendor/`; `scripts/vendored.mjs:15`), line 177.
  - Named imports must exist in the target's exports (lines 180-186).
  - `eval`, `new Function` and `importScripts` are banned in `extension/` (line 188).
- HTML: no inline handlers (line 194) and no inline `<script>` (line 197).
- `newtab.html` must load the same CSS and JS as `index.html`, in the same order (lines ~94-109). The same rule is tested in `tests/foundation-appearance.test.mjs:167-180`, which also asserts `optional_permissions.includes('topSites')`.
- Every `.js`/`.mjs` file under `extension`, `bridge`, `scripts` and `tests` gets `node --check` (line 126).

**`scripts/package.mjs:31-32`** requires the zip to contain `manifest.json, index.html, newtab.html, theme-boot.js, background.js, app.js, lib/store.js, lib/integrations.js, icons/icon128.png, content/article-extract.js, content/picker.js` plus the vendored pins. New files are zipped automatically: everything under `extension/` except dotfiles (line 22).
**`scripts/package-runtime.mjs:23,33`** lists the shipped docs and required entries. Add a new doc to the list at line 23 if it should ship.

**Recommendation: do not declare `externally_connectable`.** Without it Chrome accepts messages from *all extensions* and from no web pages. Enforce the allowlist in code instead.
- Threadkeeper's manifest has no `key` (`threadkeeper/scripts/build-extension.mjs` ~line 247), so its unpacked ID depends on the folder path. Pinning an ID in `ids` would break.
- **Never add `key` to Still's manifest.** It changes Still's extension ID, which orphans all `chrome.storage.local` and IndexedDB data for existing unpacked installs.

## 2. Worker message router: `extension/background.js`

**Header contract, lines 5-59.** Requests are `{ type, ...fields }`, and fields may also sit under `payload`. `messageInput()` at lines 154-156 flattens `payload` over the message. Every reply is `{ ok: true, result } | { ok: false, error }`. Update this header when adding message types.

**Message type list, lines 112-116:**
```js
const CAPTURE_MESSAGES = ['captureCurrent', 'saveCurrentTab', 'still:capture-current'];
const MESSAGE_TYPES = ['still:store', SNAPSHOT_MESSAGE, ...CAPTURE_MESSAGES, 'captureScreenshot', ..., 'still:capture-article', 'still:start-picker', 'still:picker-result'];
```
`MESSAGE_TYPES` is exported (line 1003). `storage-background.test.mjs:64` asserts it includes `'still:snapshots'`.

**Listener, lines 953-959.** This is the async pattern to copy exactly:
```js
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !MESSAGE_TYPES.includes(message.type)) return false;   // unknown types are ignored silently
  const respond = response => { try { sendResponse(response); } catch { /* The requesting view closed. */ } };
  handleMessage(message, sender).then(result => respond({ ok: true, result }), error => respond({ ok: false, error: error.message }));
  return true;
});
```

**`export async function handleMessage(message, sender)`, lines 884-917.**
- Line 885: `if (!sender || sender.id !== api.runtime.id) throw new Error('Untrusted extension message.')`.
- Lines 889-892: `isContentSender(sender)` (lines 553-558) classifies senders by `sender.url`/`sender.origin` against `api.runtime.getURL('')`, never by `sender.tab`.
- Then an if-chain dispatches on type. Line 894 is `still:store` → `handleStoreOperation(input.operation, input.args)`; the chain ends with `throw new Error('Unknown Still request.')` at line 916.
- **A new page→worker type needs both** an entry in `MESSAGE_TYPES` and a branch in this chain. Without the `MESSAGE_TYPES` entry the listener returns false, and `ctx.chrome` throws "Chrome could not complete that action."

**Adding `onMessageExternal`**
- Register it synchronously inside the same top-level block `if (api?.runtime?.onMessage) { ... }` (lines 953-1001), directly after line 959. MV3 only delivers the waking event to listeners registered synchronously during worker start.
- Use optional chaining (`api.runtime.onMessageExternal?.addListener(...)`). The background test mocks (`core-background.test.mjs:13`, `capture-background.test.mjs:16`, `storage-background.test.mjs:26`, `pages-worker.test.mjs:18`, `capture-article-background.test.mjs:27`) do not define `onMessageExternal`, so an unguarded call crashes at import. `full-page-capture.test.mjs:228` sets `chrome = { runtime: { id } }`, which skips the whole block.
- Use a separate exported `handleExternalMessage(message, sender)`. Do **not** reuse `handleMessage`: line 885 rejects every foreign `sender.id`, and line 894 would expose the full store op set.
- Use the same `return true` + `respond({ok,…})` envelope. `minimum_chrome_version` is 120 (manifest line 7), so do not rely on promise-returning listeners.

**Security for external senders**
- Require `sender.id` to equal the paired Threadkeeper ID.
- Require `sender.url?.startsWith(\`chrome-extension://${id}/\`)` (or `sender.origin === 'chrome-extension://' + id`). Threadkeeper's content scripts on chatgpt.com and similar sites share its ID but carry web URLs and `sender.tab`. Reject them, mirroring `isContentSender`.
- Whitelist the message types.
- Validate every field: strings, lengths, `safeUrl()` from `lib/store.js:50`.
- Process requests through a per-sender serial queue.
- An unpaired sender may only send a `pair-request`. Store it as pending, rate-limited, and never auto-approve.

**Error and badge helpers**
- `reportError` (lines 135-140): console, then a red "!" badge, then `scheduleBadgeClear`.
- `attempt(call)` (lines 122-124): swallows errors for best-effort calls.
- `later(task, delay)` (lines 126-130): an unref'd timer.
- `wait` (line 132).

**Broadcasts to pages** use `api.runtime.sendMessage(...)` wrapped in `attempt` (line 657; `publishCaptureProgress` at lines 734-740). Having nobody listening is fine. `deliverToPanel` (lines 258-265) retries 9 × 250 ms until a page answers truthy, which suits targeted panel requests.

**Message size:** extension messages are JSON-serialized and Chrome hard-caps one message at about 64 MiB. Chunk transcript pushes (for example ≤ 1-4 MB per message, with acks) and make every chunk idempotent.

## 3. Writing items from the worker

**Already imported** (background.js:61-64): `configureStoreWorker, handleStoreOperation, loadLibrary, saveItem, updateItem, createCollection, subscribe, STORAGE_KEY, canonicalUrl, safeUrl, saveAttachment, deleteAttachment`.
- `configureStoreWorker` (lines 81-85) sets `workerMode = true` (store.js:783). Every wrapper in store.js:798-816 then dispatches in-process to `localStore.dispatch` instead of messaging (`operation()`, store.js:790-797).
- So worker code calls `await saveItem({...})`, `createCollection({ name, parentId })`, `bulkUpdateItems([{id, patch}], opts)`, `updateItem(id, patch, {expectedUpdatedAt})` directly.

**Write queue: `createLibraryStore`, store.js:334ff.**
- All ops are serialized (`enqueue`, about lines 341-347). Each op awaits `ready()` → `startupGate` (background.js:79, 962-964), which can stall up to `STARTUP_GATE_MS = 20000` (line 133) after an extension update. Threadkeeper's send timeout must exceed 20 s, or it must retry.
- Each successful op writes the **entire library** to `chrome.storage.local['still.library.v1']` (store.js:774-776), calls `notify`, then `onCommit` → `snapshots.markDirty()`.
- `runExclusive(task)` (store.js:785, 747) is available, but the task **must not call dispatch**. A multi-step import therefore cannot be wrapped around store ops. Add a single new op in the `switch` (store.js:504-737; current cases are listed at 505-676) plus an exported wrapper next to lines 798-816. Example: `upsertChats([...], {collectionId})`, done as one write.
- `bulkUpdateItems` (store.js:589-604) only patches existing items. There is no bulk create.

**Pitfalls in `normalizeItem` and `saveItem`**
- `ITEM_TYPES = ['bookmark','article','image','video','file','note']` (store.js:7). `normalizeItem` throws `'Unknown item type.'` at line 147, so `'chat'` must be added here first.
- `ITEM_FIELDS` (store.js:22-25): new fields such as `chat: {provider, threadId, kind, project, …}` **must be listed**. For new items `keepUnknown` copies unknown keys only from `existing` (line 194), so unknown input keys are silently dropped.
- `articleContent` is truncated to 250000 chars (line 159). `content` is not truncated.
- `saveItem` without `id` but with `url` merges into **any** live non-note item with the same `canonicalUrl` (lines 507-516). A chat with a `chatgpt.com/c/…` URL would merge into a bookmark of that thread. Always pass a stable explicit `id` (for example `chat_tk_<threadId>`). `normalizeItem` uses `existing.id || input.id || uid('item')` (line 155), so an unknown explicit id creates a new item.
- `saveItem` calls `unbury` (line 527). Re-pushing a permanently deleted chat id resurrects it. Check `state.tombstones` (`{kind:'item', id, deletedAt}`, store.js:252-263) or keep a dismissed-thread list before upserting.
- An invalid `collectionId` throws `'Collection no longer exists.'` (line 524). Resolve it with `resolveCaptureCollection(library, requested)` (`lib/capture.js:308-316`), which falls back to Inbox `''` with `collectionFallback: true`.
- **Do not call `loadLibrary()` in the worker on an empty store** (background.js:143). Use `readLibrary()` (lines 144-148; cached in `libraryCache`, kept fresh by `subscribe` at 994-998).
- A push that arrives before the user's first UI open creates `emptyLibrary()`, so the UI never seeds `SEED_LIBRARY` (store.js:363-366). That is probably acceptable, but document it.

**Size and snapshots: important for transcripts**
- Every library write sends the whole library through `storage.onChanged` to every open page (store.js:825) and the worker. Every open page's AI indexer reacts (`lib/ai/index.js:160-164`).
- `isSnapshotKey` (`lib/storage/snapshots.js:39`) snapshots **every** `still.*` key in `chrome.storage.local` except `SNAPSHOT_EXCLUDED_KEYS` (line 33). Up to 38 snapshots are kept in IndexedDB (lines 29-31).
- Put full transcripts in a dedicated IndexedDB database written by the worker. The model is `still.attachments.v1`, store.js:859-903, which is explicitly not snapshotted per snapshots.js:4-5. Alternatively, add the key to `SNAPSHOT_EXCLUDED_KEYS`.
- Keep only metadata, the summary and a bounded excerpt in the library item.
- If a new `still.*` key has its own Web Lock writer, add it to `RESTORE_LOCKS` (line 37). `countSnapshot` (lines 48-56) holds the per-kind counts shown in Settings.

## 4. How pages learn about changes

- **Library:** `store.subscribe(listener)` (store.js:823-830) listens to `chrome.storage.onChanged` for `STORAGE_KEY` (and to `window.storage` in preview). `app.js:348-355` swaps `library` and calls `runtime.render()`. Worker writes therefore appear in all views automatically.
- **Other keys** (a chats or pairing key): add an `onChanged` listener in the page, for example `quick-add.js:1511-1513` for `'still.ui.recent.v1'`. Or broadcast `{type:'still:…'}` from the worker.
- Page listeners must check `sender.id === chrome.runtime.id` (see `notes.js:872-883`, `quick-add.js:1517-1530`, `page.js:116-120`) and dedupe by `requestId`.
- Worker-side `storage.onChanged` listeners are at background.js:987 (recent collections → menus) and 989-991 (marks any `still.*` change dirty for snapshots).

## 5. Page-side senders

- `ctx.chrome(type, payload)` (`app.js:96-101`) sends `{ type, ...payload }`, unwraps `{ok,result}`, and throws `'This needs Still installed as a Chrome extension.'` in preview. Its callers include `ui/detail.js:732`, `ui/page.js:77`, `ui/quick-add.js:286,486,960,1034,1105,1116,1154,1172,1238`, `ui/sidebar.js:286`, `ui/library.js:871`, `ui/settings.js:1655` and `ui/ai-panel.js:501`.
- `still:store` comes from `lib/store.js:790-797`.
- **The template for a new dual-mode API is `lib/storage/snapshots.js:255-273`.** `viaWorker()` holds when there is no in-worker service, `chrome.runtime.id` exists and `sendMessage` + `storage.local` are present. Otherwise the request runs in-process. The worker side is `handleSnapshotRequest(op, args, service)` (line 241), registered via `configureSnapshotWorker()` (line 258) and routed at background.js:895. Build a `lib/threadkeeper.js` with `configureThreadkeeperWorker()`, `handleThreadkeeperRequest(op, args)` and page wrappers the same way.
- **The AI engine runs in the page, not the worker.** `app.js:362-367` dynamic-imports `lib/ai/index.js` and calls `init({ store, getLibrary, integrations, onLibraryChange, dashboard })` (index.js:149-172). Assistant tools that search Threadkeeper therefore run page-side:
  - Either call `chrome.runtime.sendMessage(tkId, msg)` directly. Extension pages can do this with no permission. It rejects with "Could not establish connection. Receiving end does not exist." when Threadkeeper is missing, disabled or crashed; fall back to the local copies.
  - Or proxy through a worker type such as `still:threadkeeper` { op, args }. That centralizes the paired-ID check, so prefer it.

## 6. Alarms, lifecycle, notifications, menus

**Alarms**
- Names in use: `'still:clear-badge'`, `SNAPSHOT_ALARM = 'still:snapshot-daily'` (snapshots.js:27) and `REMINDER_PREFIX = 'still:reminder:'` (background.js:89).
- `handleAlarm` (lines 830-856) is an early-return chain. Add the retry branch, for example `alarm.name.startsWith('still:threadkeeper:')`, before line 844 (`if (!alarm.name.startsWith(REMINDER_PREFIX)) return;`). Await `startupGate` as line 843 does.
- `syncReminders` (lines 814-823) clears only `REMINDER_PREFIX` alarms, so a new prefix is safe.
- For periodic alarms, copy `ensureSnapshotAlarm` (lines 859-863): check `getAll()` first so the countdown is not reset.
- Chrome alarms have a 30 s floor (comment at line 283). For shorter delays, pair `later()` with an alarm as `scheduleBadgeClear` does (lines 281-286).

**Lifecycle**
- `onInstalled` (lines 966-974) rebuilds menus and annotates the update snapshot.
- `onStartup` (lines 975-979) restores reminders and rebuilds menus.
- Either is a good hook for asking the paired Threadkeeper for a resync. Do it after `startupGate`, best-effort, never blocking.
- The `permissions.onAdded`/`onRemoved` hooks (lines 992-993) handle only `'tabs'`. Add a `'management'` branch if discovery reacts to that grant.

**Notifications**
- Use `notify(id, title, message)` (lines 563-565; the title is sliced to 200).
- The `onClicked` handler (lines 983-986) opens only `still:item:<id>` via `openLibrary(itemId)` (lines 242-245), then clears the notification.
- A pairing prompt needs a new prefix (for example `still:threadkeeper:pair`) and a branch that opens `api.runtime.getURL('index.html?libraryView=settings:threadkeeper')`. `MAIN_VIEWS` (`ui/routes.js:4`) accepts `settings:[a-z-]+`, so the section id must be lowercase letters and hyphens.

**Context menus**
- `MENU_ITEMS` (lines 94-110); new top-level items go before the "Save … to" parents (comment at line 103).
- `core-background.test.mjs:37-38` asserts the exact id order, so update it if a menu is added.

## 7. Optional permissions and the settings approval UI

**Helpers**
- `lib/permissions.js`: `requestPermissions(list)` (lines 45-50) and `requestOrigins` (lines 30-35) must be called **synchronously in the click handler, before any await**.
- `hasPermissions` (lines 37-42) and `onPermissionsChanged(fn)` (lines 53-59).
- All of them resolve `true` when `chrome.permissions` is absent (preview).
- Settings has its own `requestAccess(request)` (`ui/settings.js:319-323`). Its usage pattern, `settings.import-chrome` at lines 1650-1658, is:
  ```js
  const granted = requestAccess({ permissions: ['bookmarks'] });
  return withBusy(ctx, key, async () => { if (!(await granted)) throw …; … });
  ```
  `withBusy` is in `ui/settings/parts.js:28`.

**`management` can be an optional permission.** Chrome's non-optional list is debugger, declarativeNetRequest, devtools, experimental, geolocation, mdns, proxy, tts, ttsEngine and wallpaper. It shows the prompt "Manage your apps, extensions, and themes".
- Messaging itself needs no permission. `management` is only useful for discovering Threadkeeper's unpinned ID: `chrome.management.getAll()` → match `name === 'Threadkeeper' && enabled`.
- After the grant, guard calls as `chrome.management?.getAll`.
- Offer manual ID entry as a fallback, and also accept a Threadkeeper-initiated `pair-request` (it learns Still's ID the same way).
- Store the approved ID in a device key such as `still.threadkeeper.v1`, **not** in library `settings`. `exportLibrary` (store.js:817-822) strips only keys matching `/token|secret|password|credential|bridge/`, so a library-settings key would leak into backups.

**Settings surfaces to extend**
- `SETTINGS_SECTIONS` (`ui/settings/catalog.js:14-50`; group `'connections'` or `'ai'`).
- `ALIASES` (catalog.js:54-55).
- `renderSection` switch (`ui/settings.js:629-641+`).
- Section ids are matched by `/settings(?::([a-z-]+))?/` (catalog.js:69).

## 8. Preview build constraints

- `scripts/serve.mjs` serves `extension/` statically at 127.0.0.1:4173 with the CSP header at line 12 (`connect-src 'self' http://127.0.0.1:* http://localhost:* https:`).
- **No `chrome` and no worker.**
  - `app.js:34`: `isExtension = !!globalThis.chrome?.runtime?.id`.
  - The store runs in the page on localStorage under a Web Lock (store.js:765-779).
  - Snapshots run in-process (snapshots.js:260).
  - `permissions.js` returns true; `ctx.chrome` throws.
- New page modules must not touch `chrome.*` at import time; use a lazy accessor like `permissions.js:5`. Guard every call with `globalThis.chrome?.runtime?.sendMessage` and `ctx.env.isExtension`.
- Return "Threadkeeper unavailable" or empty results so the UI and assistant tools degrade instead of throwing. Tests import UI and lib modules in Node without `chrome`, which imposes the same requirement.
- Register new UI modules in `app.js:308` (`modules` array; `init(ctx)` is called at lines 369-371).

## 9. Lists the integration must extend (found by grep)

| What | Where |
|---|---|
| Item types | `lib/store.js:7`; `lib/ai/tools.js:16` (plus enum uses at 63, 73, 582, 633); `ui/selectors.js:13` (`ITEM_VIEW_TYPES`) and filters at 243, 297; `lib/portability.js:33` (`TYPES`); `bridge/protocol.mjs:4`; `app.js:289` (`?type=` boot filter) |
| Item fields | `lib/store.js:22-25` `ITEM_FIELDS` |
| Store ops | `lib/store.js` switch 504-737 and wrappers 798-816; `lib/ai/index.js:37-38` `STORE_METHODS` (the assistant's proxy list) |
| Worker message types | `background.js:112-116` `MESSAGE_TYPES`; branches 884-917; header doc 5-59 |
| Alarm names | `background.js:89`, 284-285, 830-856; `snapshots.js:27` |
| Notification ids and click routing | `background.js:563-565`, 593, 598, 853, 983-986 |
| Menus | `background.js:94-111` and test `core-background.test.mjs:37` |
| Snapshot keys and locks | `snapshots.js:33,37,39,48-56` |
| Permission allowlists | `scripts/check.mjs:68,76,78`; `tests/foundation-appearance.test.mjs:171-173` |
| Settings sections | `ui/settings/catalog.js:14,54`; `ui/settings.js:629` |
| UI modules | `app.js:308` |
| Packaged docs | `scripts/package-runtime.mjs:23` |

## 10. Test conventions

- Tests use `node:test` + `node:assert/strict`.
- Chrome is mocked inline per file:
  - The `events()` helper is `{ listeners: [], addListener(l){…}, removeListener(l){…} }` (for example `core-background.test.mjs:4`).
  - Assign `globalThis.chrome = {...}` **before** `await import('../extension/background.js')`. Each file runs in its own process, so worker module state persists across the tests in a file.
- Call the exported `handleMessage(msg, { id: chrome.runtime.id })` directly (`storage-background.test.mjs:47-49`), or invoke `chrome.runtime.onInstalled.listeners[i](…)` (line 66).
- `storage-background.test.mjs:5-44` has the richest mock: a `values` map, a `change()` that emits `storage.onChanged`, `getManifest` and alarms.
- For external messaging, add `onMessageExternal: events()`. Export `handleExternalMessage` and test it directly, including spoofed-sender rejection (wrong `id`, a web `url` with Threadkeeper's id, an unpaired id sending a non-pair type).
- UI tests use `tests/helpers/fake-dom.mjs`.

## 11. Where to hook in

1. **`background.js`:** import a new `lib/threadkeeper.js` (worker service, pairing state, validation, upsert via one new store op).
   - Add `api.runtime.onMessageExternal?.addListener(...)` after line 959 using the same envelope.
   - Add `'still:threadkeeper'` to `MESSAGE_TYPES` plus a branch near line 895, for settings, page tools and the import proxy.
   - Add an alarm branch before line 844 and a notification-click branch at line 983.
2. **`lib/store.js`:** add `'chat'` to `ITEM_TYPES` (line 7) and the new fields to `ITEM_FIELDS`. Add an `upsertChats` op that does a single write, uses explicit ids and checks tombstones.
3. **Transcripts:** worker-owned IndexedDB (follow `openAttachmentDb`, store.js:860-880). The library item holds the summary and a ≤250k excerpt for the existing indexer and search.
4. **Settings:** a new section with a "Connect Threadkeeper" button that calls `requestPermissions('management')` synchronously, then discovers the ID, pairs and stores it. Also show approve/deny for pending requests. Update `check.mjs:76`.
5. **Assistant tools:** page-side, through the worker proxy (or a guarded direct `sendMessage(tkId)`), falling back to the local chat items when Threadkeeper is unreachable.