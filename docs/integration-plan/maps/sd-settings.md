# Sidebar Dock: Settings and Integrations map for the Threadkeeper card

## 1. How Settings is put together

- **One renderer, two surfaces.** `renderSettingsPage(ctx, { surface })` (`extension/ui/settings.js:507-534`) draws both the full tab (views `settings` and `settings:<id>`) and the side-panel cover (`ctx.state.panel = { kind: 'settings' }`). A hidden marker `<span data-mount="settings-live">` (`:523`) starts the data lifecycle through `registerMount('settings-live', …)` (`:424-427`). That calls `attach(ctx)` (`:398-410`) and, on unmount, `detach()` (`:412-420`).
- **Section dispatch.** `renderSection(ctx, id)` is a `switch` (`settings.js:629-646`). The Integrations section is `renderIntegrations(ctx)` (`:1208-1227`).
- **Module state** (`settings.js:293-306`):
  - `data = { integration, storage, commands, connections, aiSettings, bridge, aiError, index, clients, clientsError, importJob, raindrop, login, snapshots, backupJob }`
  - `drafts = { bridgeUrl: null, bridgeToken: '', raindropToken: '' }`
  - `live = { offAi, offIndex, tick, loginTimer, mounted, pausedHere, searchTimer, engineSettled, pending: { providerId, anchor }, returnTo }`
- **Loading.**
  - `loadIntegration(ctx)` (`:340-343`) calls `integrations.getIntegrationSettings()`.
  - `refresh(ctx, { bridge })` (`:383-387`) runs `Promise.allSettled([loadIntegration, loadStorage, loadCommands, loadSnapshots, loadAi])`, then `loadClients`.
  - `attach()` also starts a 5 s re-render tick: `setInterval(() => { if (live.mounted && !document.hidden) ctx.render(); }, 5000)` (`:405`). The tick only re-renders; it does not reload data.
  - `init(ctx)` (`:1979-1995`) runs once after the AI engine loads.
- **UI state** lives in `uiState(ctx)`, which returns `ctx.state.settings ||= { section: 'general', list: true, query: '', open: new Set() }` (`ui/settings/parts.js:23`). Disclosure state is `uiState(ctx).open`. The `settings.disclose` action is at `settings.js:1569-1573`.
- **Search.** `searchResults(ctx, terms)` (`settings.js:600-610`) renders **every section** inside `renderFiltered(terms, [section.label], () => renderSection(ctx, section.id))`. `parts.js` then:
  - drops rows that do not match (`matches()`, `:52-57`);
  - drops empty cards and groups (`card()` `:93-97`, `group()` `:81-90`);
  - makes `loadingBlock()` return `''` while searching (`:152`).
  - Custom blocks join search through `searchable(texts, fragment)` (`:59`).
  - Notes, callouts and job status should be hidden with `isSearching()`, as in `settings.js:694`, `:697` and `:868`.

## 2. Every list the integration must extend (found by grep)

| What | Where | Notes |
|---|---|---|
| Section catalog | `ui/settings/catalog.js:14-50` (`SETTINGS_SECTIONS`); integrations entry `:42-43` (`summary: 'Raindrop.io and other apps'`, `keywords: 'integrations raindrop notion readwise zapier make n8n rss drive dropbox'`) | Add Threadkeeper keywords here. **Do not add `github`**: `tests/settings-catalog.test.mjs:91` asserts `matchSections('github')` is exactly `['research','accounts']`. |
| Nav groups | `catalog.js:5-11` (`SETTINGS_GROUPS`) | A new section must use group `connections`. `tests/settings-catalog.test.mjs:17-23` asserts the exact grouping. |
| Section aliases | `catalog.js:54-55` (`ALIASES`) | For example `threadkeeper: 'integrations'` (or the new section id), so `openSettings(ctx,'threadkeeper')` works. |
| Section switch | `settings.js:629-646` | Only needed for a new section. |
| `openSettings` doc list | `settings.js:431-435` | Lists section ids. |
| Integrations "Built in" rows | `settings.js:1212-1219` | Add a row or card here. |
| Catalog exclusion list | `settings.js:1210`: `INTEGRATION_CATALOG.filter(entry => !['claude','codex','raindrop'].includes(entry.id))` | If `threadkeeper` is added to `INTEGRATION_CATALOG` (`lib/integrations.js:6-18`), it **must** be added to this list. Otherwise it shows up again as an external "Other apps" link. |
| Provider marks | `ui/settings/parts.js:161-170` (`MARKS`) | Add `threadkeeper: { icon: 'messages-square', color: … }`. The `messages-square` icon already exists (used at `settings.js:707`). |
| About › "Where your data lives" | `settings.js:1264-1273` | Add a Threadkeeper privacy row. |
| Full-backup row copy | `settings.js:691-692` | Lists what a backup holds. Update it if chat items or transcripts are included. |
| Command palette | `ui/command.js:62-76` (`shell.settings` entries) | Add a "Threadkeeper" entry. |
| `shell.settings` action | `ui/shell.js:336`: `openSettings(ctx, payload(event, data).section \|\| 'general')` | **Drops `anchor`.** Extend it to pass `{ anchor: payload(...).anchor }` if the palette should deep-link to the card. |
| Integration client API | `lib/integrations.js:230-233` (returned object) and singleton wrappers `:236-247` | New methods need both. |
| Public integration shape | `lib/integrations.js:91-94` (`getIntegrationSettings`) | A whitelist of non-secret fields; it never echoes tokens. |
| Worker message whitelist | `background.js:113-116` (`MESSAGE_TYPES`, exported `:1003`) | Only if "Sync now" goes through the worker via `ctx.chrome(type)` (`app.js:96-101`). |
| Page broadcast listener | `app.js:374` (`still:full-page-progress`) | This is the pattern for a `still:threadkeeper-progress` broadcast. The worker sends it like `background.js:738`. |
| Storage table | `docs/data-model.md:11-25` | Add a row for the new key. Fill in snapshot, backup and device-only. |
| Static check allowlists | `scripts/check.mjs:67-79` (required permissions, `allowedOptionalPermissions = ['bookmarks','tabs','topSites']`, `allowedHosts`) | Cross-extension messaging needs **no** new permission. Adding `management` would fail the check. |

## 3. Building blocks: exact signatures

From `ui/settings/parts.js`:
- `group({ title, description, actions, body, id, className, keywords })` (`:81`). `body` may be a function, which makes the group title count as search context. With `id`, the heading id is `${id}-title`; otherwise it is a slug from `headingIdFor`. Call `resetIds()` (`:72`) once per page render; `renderSettingsPage` already does at `:508`.
- `card(rows, className)` (`:93`).
- `row({ label, description, control, lead, className, stacked, id, descClass, keywords })` (`:100`). An `id` adds `tabindex="-1"`, so the row can be an anchor.
- `switchRow({ keywords, id, ...switchToggleOptions })` (`:110`).
- `blockRow({ label, description, body, id, className, keywords, lead })` (`:116`).
- `callout({ tone, icon, title, body, actions, live, className })` (`:125`).
- `progressBar({ percent = null, label, tone })` (`:139`). A `null` percent gives an indeterminate bar.
- `disclosure(ctx, id, label, { count })` with `aria-controls="settings-more-${id}"` (`:146`), and `disclosed(ctx,id)` (`:145`).
- `withBusy(ctx, key, fn)` / `isBusy(key)` (`:25-33`). A module-global `Set` re-renders before and after the work and ignores a re-entrant call with the same key.
- Also `note(glyph, body)` (`:158`), `providerMark(id, size, fallback)` (`:173`) and `linkButton({ label, href, icon, variant, size })` (`:154`).

From `ui/components.js`:
- `button({ label, icon, iconRight, variant='secondary', size='md', action, data, type='button', disabled, pressed, loading, kbd, title, id, className, attrs, hideLabel, tooltip, expanded })` (`:44`)
- `select({ name, value, options, action, id, label, className, size, disabled, invalid, describedBy })` (`:135`). `action` becomes `data-change`. Options are `[{value,label}]` or `[{group, options}]`.
- `switchToggle({ checked, label, description, action, data, name, id, disabled, className })` (`:150`). Fires `data-change`.
- `checkbox({ checked, label, action, data, name, id, className, hideLabel, indeterminate, disabled, value })` (`:144`)
- `chip({ label, icon, color, selected, removable, action, removeAction, data, count, className, title })` (`:99`). Uses `aria-pressed`.
- `input({ name, value, placeholder, type, action, change, id, required, disabled, attrs, label, invalid, describedBy, readonly, … })` (`:108`). `action` becomes `data-input`; `id` also sets `data-focus-key`, which keeps focus across morphs.
- `field({ label, hint, error, control, id, className, inline })` (`:157`). The hint id is `${id}-hint` and the error id `${id}-error`.
- `segmented({ name, value, options, action, size, ariaLabel, className })` (`:79`)
- `badge({ label, tone, icon })` (`:165`)

Settings has **no multi-select component.** For a list of remote projects, use a list of `checkbox()` (or `chip()` toggles) with `data: { project: id }`, inside a `disclosure()` once the list gets long. `dataAttrs` (`components.js:7-9`) turns camelCase keys into kebab-case `data-*` attributes, and handlers receive `el.dataset`.

**Action runtime.** `registerActions(map)` (`ui/runtime.js:15-20`) warns on duplicate names, and the later one wins. Handlers receive `({ el, event, ctx, data: el.dataset })` (`:104`). A form's `data-submit` handler gets the `<form>` as `el`, and the default is prevented. Thrown errors become danger toasts through `ctx.run` (`app.js:60-66`), so handlers just `throw new Error('user-facing text')`. Sub-modules register their own actions: see `ui/settings/newtab.js:251` and `ui/settings/appearance.js:146`.

## 4. Patterns to copy for the card

**Status, form and buttons: Raindrop** (`settings.js:818-846`)
- `raindropStatus(info)` maps state to a `{label,tone,icon}` badge: Connected / Token saved / Not connected.
- `raindropBlock` is a `div.settings-row.is-stacked` with `id="settings-raindrop" tabindex="-1"` (the anchor target). It holds a `<form data-submit="settings.raindrop-connect">`. The secret input value comes from `drafts` and is updated by a non-rendering input action: `'settings.raindrop-field': ({ el }) => { drafts.raindropToken = el.value; }` (`:1659`).
- Buttons change with state: "Connect" or "Save and check", plus "Bring in library" and "Disconnect".
- A job block with `role="status"` and a `progressBar` renders while `data.raindrop?.running`.

**Progress job** (`settings.js:1673-1686`)
- Set `data.raindrop = { running: true, items: 0 }` and call `ctx.render()`.
- Run `integrations.importFromRaindrop({ onProgress: p => { data.raindrop = { running: true, items: p.items }; ctx.render(); } })`.
- Clear it in `finally { data.raindrop = null; ctx.render(); }`.
- A second click is ignored while `running`.
- Use this as the model for "Sync now", with `{ running, done, total, phase }` and a determinate `progressBar({ percent })` once the total is known.

**Pair and unpair: local bridge** (`settings.js:968-1011`, `:1807-1864`)
- `pairForm(info, where)` builds element ids with a `where` suffix (`settings-bridge-${suffix}-${where}`), because the same block renders in two sections (AI and Agents). **Search renders all sections at once**, so any card that appears in two places needs suffixed ids.
- `settings.bridge-pair` reads values from the form first and falls back to drafts: `form.querySelector('input[name="token"]')?.value ?? drafts.bridgeToken`.
- Unpair confirms first: `ctx.confirm({ title, body, confirmLabel, tone: 'danger' })`. Then it calls `integrations.disconnectBridge()`, clears dependent `data.*` fields, runs `refresh(...)` and toasts.

**Toggles and selects.**
- `switchRow({ label, description, checked, action: 'settings.toggle', data: { key } })` with an **allowlisted** handler: `if (!['openPanelOnSave','startOnPage','confirmDelete'].includes(payload.key)) return undefined;` (`:1578-1581`).
- Selects read `el.value` (`settings.ai-model` `:1767-1771`).
- Research validates through `researchPatch(name, value)` (`ui/settings/assistant.js`, tested at `tests/settings-assistant.test.mjs:134-141`). Copy this allowlist-and-coerce pattern for Threadkeeper preferences.

**Connected-service card: accounts**
- Providers register `{ id, name, icon, description, order, keywords, renderCard(ctx) }` with `registerAccountProvider` (`lib/accounts.js:109-113`). `ui/settings/accounts.js:21-33` wraps each in `div.account-slot#settings-account-${id}` (tabindex -1, `data-key`), catches render errors into a danger callout, and hides the default heading if the card renders its own `<h*>`.
- Live updates: `attachAccounts(ctx)` subscribes `onAccountsChanged(() => ctx.render())` (`ui/settings/accounts.js:10-17`). `lib/accounts.js:46-50` listens to `chrome.storage.onChanged` so other tabs and the side panel stay current.
- Example card: `ui/widgets/linear/account.js:23-60`, registered at `:83-87`. It uses a `context` argument so ids stay unique when the card renders in Settings and in a dialog.
- `getAccountInfo(id)` strips `token`/`refreshToken` and exposes `connected: !!token` (`lib/accounts.js:70-75`).
- Writes are serialized by an in-module promise queue (`mutate`, `:34-43`). That covers one JS context only.

## 5. Asking Chrome for permissions from a click

- `requestAccess(request)` (`settings.js:317-323`) must be **called before the handler's first `await`**. Chrome only shows the prompt during the user gesture. Examples:
  - `const granted = requestAccess({ origins: [RAINDROP_ORIGIN] });` followed by `withBusy(..., async () => { if (!(await granted)) throw … })` (`:1660-1672`)
  - `{ permissions: ['bookmarks'] }` (`:1652`)
  - bridge loopback (`:1814-1819`)
  - `ai.saveConnection` (comment at `:1729`)
- Shared helpers: `lib/permissions.js` (`requestOrigins` `:30`, `requestPermissions` `:45`, `hasOrigins` `:22`, `onPermissionsChanged` `:53`), and `ui/quick-add.js:257`. Without `chrome.permissions` (preview build or Node tests) every request resolves to `true`.
- **Threadkeeper needs no Chrome permission.** `chrome.runtime.sendMessage(otherId, msg)` and `runtime.onMessageExternal` work between extensions without declarations. "User approval" must be app-level pairing: a stored, allowed extension ID.
- The manifest (`extension/manifest.json`) has no `externally_connectable`. If one is ever added for web pages, it **must** also list `"ids"` (the Threadkeeper ID or `"*"`), or extension-to-extension messaging stops.
- `scripts/check.mjs` does not check `externally_connectable`, but it rejects any new optional permission such as `management`. Detect whether Threadkeeper is installed with a ping message instead.

## 6. Where device-only state lives, and why backups skip it

**Current keys**

| Key | Owner | Holds | Snapshots | Full backup |
|---|---|---|---|---|
| `still.integrations.v1` | `lib/integrations.js:3`, read/write `:20-31` | Raindrop and bridge tokens, URL, switches | yes | **never** |
| `still.accounts.v1` | `lib/accounts.js:5` | Account tokens | yes | **never** |

The GitHub widget also reads `still.integrations.v1` directly (`ui/widgets/github/connection.js:95-99`). Both rows are in `docs/data-model.md:20-21`.

**Why backups never include them.** `createFullBackup` (`lib/portability.js:390-432`) adds only a fixed set of parts: library (`store.exportLibrary`), `dashboard`, `conversations` and `aiConfig`. A new storage key is therefore left out automatically. On top of that:
- Library settings pass through `stripSecrets` with `SECRET_KEY = /token|secret|password|passphrase|credential|bridge|integration|api[-_]?key|authorization|cookie/i` (`portability.js:36`, `:70-75`).
- The store applies the same rule on import (`lib/store.js:230-249`, `mergeImportedSettings`) and on `exportLibrary` (`store.js:817-822`).

**Snapshots.** `isSnapshotKey` covers every `still.*` key except `SNAPSHOT_EXCLUDED_KEYS` (`lib/storage/snapshots.js:33-39`). A restore replaces those keys, and removes a key the snapshot lacks, under `RESTORE_LOCKS` (`:37`, used at `:179-185`).

**Recommendation**
- Use a dedicated key, `still.threadkeeper.v1`, with an injectable factory modelled on `createIntegrationClient({ storage, fetch, store })` (`integrations.js:70`). Suggested fields: `{ version, extensionId, status, pendingRequest, pairedAt, prefs: { autoSync, collectionId, providers, kinds, projectIds }, cursor, lastSyncAt, lastError, counts }`.
- Alternatively, add a nested `threadkeeper` object to `still.integrations.v1`. In that case `update()` (`integrations.js:95`) merges **top-level only**, so the nested object must be written whole, and you must extend the `getIntegrationSettings` whitelist.
- **Unpacked extension IDs come from the install path,** so they differ per machine. That is a hard reason for device-only storage.
- Leave the key in snapshots (the default). Then the pairing and cursor roll back together with the library's chat items. Imports must still be idempotent by thread ID.
- Add the new key's lock name to `RESTORE_LOCKS` if pages and the worker both write it.

**Pitfalls**
- **Race:** `integrations.js` `update()` is an unlocked read-modify-write. A worker writing sync state while the Settings page writes preferences will lose an update. Serialize with `navigator.locks.request('still.threadkeeper.v1', …)`, as `secrets.js:49` and the bridge sync (`integrations.js:216`) do.
- If any Threadkeeper preference goes into **library settings** (`store.updateSettings` or `patchGroup`, `lib/settings-schema.js:116-119`), a key name containing `integration`, `bridge` or `token` is **silently stripped from exports and never imported**. For example, `threadkeeperIntegration` would be stripped.
- Grouped settings objects are replaced whole. Always write them through `patchGroup` and add defaults in `GROUP_DEFAULTS` (`settings-schema.js:76`).
- `getIntegrationSettings` must never return a secret. `tests/integrations.test.mjs:212` asserts `'raindropToken' in …` is `false`.
- Nothing pushes integration changes to Settings today: `integrations.js` has no `storage.onChanged` listener. Add one in the new client, mirroring `lib/accounts.js:46-50`, and subscribe and unsubscribe in `attach()`/`detach()` (`settings.js:398-420`). Without it, worker-driven status will look stale.

## 7. Linking to a section or row

- `openSettings(ctx, section, { anchor, providerId })` (`settings.js:436-458`) sets `live.pending.anchor`. `afterOpen` (`:468-476`) then calls `reveal(document.getElementById(anchor))` (`:479-487`), which scrolls, focuses and flashes `.is-flash` (`styles/settings.css:290`).
- Inside Settings, use `button({ action: 'settings.section', data: { section: 'library', anchor: 'settings-raindrop' } })` (`settings.js:1214`). It goes through `goToSection` (`:1422-1438`), and modifier clicks keep native link behaviour (`:1522-1527`).
- The full tab uses `<a href="index.html?libraryView=settings%3A<id>">` (`sectionHref` `:504`). The side panel uses buttons (`navEntry` `:555-563`). URLs carry no anchor (`ui/routes.js:28-33`).
- Callers today:
  - `ui/ai-panel.js:2058-2060` (`ai.setup`, `ai.settings`, `ai.permissions`)
  - `ui/sidebar.js:529-530`
  - `ui/shell.js:281`, `:336-337`, `:361-363`
  - `ui/research.js:292-293`
  - `ui/research-view.js:262-267` (toast action `run: () => openSettings(...)`)
- The assistant's "connect Threadkeeper" calls to action should use `openSettings(ctx, 'integrations', { anchor: 'settings-threadkeeper' })`.
- **The anchor element must render while data is still loading.** `afterOpen` looks it up on the next frame. Raindrop gets this right because it renders from `data.integration || {}`. A card that returns `loadingBlock()` first loses the anchor.

## 8. Recommended plan

1. **New module `extension/ui/settings/threadkeeper.js`.** It exports `renderThreadkeeper(ctx, { where })`, `attachThreadkeeper(ctx)` and `detachThreadkeeper()`, and registers its own `settings.threadkeeper-*` actions, following newtab and accounts.
2. **Placement.** Import it in `settings.js:22-25` and call it from `renderIntegrations` as a new `group({ title: 'AI chat threads', id: 'settings-threadkeeper-group', keywords: 'threadkeeper threads chats transcripts claude chatgpt gemini coding agent sessions', body: () => … })` above "Built in". Wire attach and detach next to `attachAccounts`/`detachAccounts` (`:408`, `:419`).
3. **Card body**, a `blockRow` with `id: 'settings-threadkeeper'`:
   - Lead `providerMark('threadkeeper', 32)`.
   - Label plus `badge(threadkeeperStatus(state))`, a pure, exported and tested function like `connectionStatus` (`:133-139`) or `bridgeSummary` (`:232-239`). Suggested states: Not installed / Waiting for approval / Connected / Not responding / Error.
   - **Pending pair request:** callout with Approve and Deny, plus the requesting extension's name and ID.
   - **Manual ID:** `<form data-submit="settings.threadkeeper-pair">` with `input({ name: 'extensionId', action: 'settings.threadkeeper-field' })` from `drafts`. Validate `/^[a-p]{32}$/`.
   - **Connect / Disconnect:** Connect sends a ping message; Disconnect asks `ctx.confirm` first and says the imported chats stay.
   - **Preferences:** `switchRow` (auto-sync, include coding-agent sessions), `select` (target collection: reuse `renderCollectionPickerTrigger` as at `:661`), `segmented` (kinds).
   - **Projects:** a checkbox list from `Threadkeeper list-projects`, inside `disclosure(ctx,'threadkeeper-projects')`.
   - **Sync now:** `button({ loading: !!job?.running })` plus the job block and `progressBar`.
   - A `note('lock', …)` explaining that pairing stays on this device, hidden while searching.
4. **Data.** Add `data.threadkeeper` and a `loadThreadkeeper(ctx)` call to `refresh()` (`:384`). Probe Threadkeeper with a timeout, mirroring `loadClients` (`AbortSignal.timeout(8000)`, `:369`).
5. **Sync.** Run it in the worker (`ctx.chrome('still:threadkeeper-sync')`; extend `MESSAGE_TYPES`). Report progress through a runtime broadcast handled next to `app.js:374`, or through storage changes.
6. **Security.**
   - In `onMessageExternal`, accept only `sender.id === stored extensionId && status === 'paired'`. A pair request is the only message allowed from unpaired senders.
   - Validate every field. Do not trust markup; transcripts must render through `html` escaping.
   - Rate-limit pending requests.

## 9. Other pitfalls and invariants

- **Unique element ids across sections.** Search renders all sections in one DOM. Suffix ids with `where`, as `pairForm` does (`settings.js:998-999`).
- **Must work in Node.** `renderIntegrations` must work with a stub ctx that has no `ai`, `chrome`, `prefs` or `integrations`. Tests render the whole page in Node (`tests/settings-assistant.test.mjs:151-171`). Module top level must use optional chaining for `chrome.*`, as `lib/accounts.js:46` does.
- **Wording.** "Chats" already means assistant conversations: the Export chats row (`:706`), `snapshotDetails` (`:787`) and the backup toast (`:1591-1592`). Use "AI threads" or "chat threads" for Threadkeeper items to avoid ambiguity.
- **Cross-scope costs of storing transcripts inside library items:**
  - Everything lives in the one `still.library.v1` blob.
  - The bridge POSTs the whole library to `/sync` every ~2 s (`integrations.js:198-203`, `:219`). The bridge limit is `MAX_SYNC_BODY = 64 MiB` (`bridge/server.mjs:12`), and `publicSnapshot` (`integrations.js:42-47`) sends every item.
  - Item types are enumerated in `lib/store.js:7` (`ITEM_TYPES`) and in `lib/portability.js:33` (`TYPES`). A `chat` type missing there is rejected on save or import.
  - Full backups are capped at 200 MB (`portability.js:26`).
  - Prefer storing transcripts in a separate store, with summary and metadata on the item.
- Chrome messages are JSON-serialized and limited to roughly 64 MiB per message. Page transcripts in chunks.
- `check.mjs:75` checks that named imports exist, and `:79` forbids `eval` / `new Function`.

## 10. Tests and how they drive the UI

Run with `node --test tests/*.test.mjs`; the static checks are `node scripts/check.mjs`.

- **`tests/settings-ui.test.mjs`**
  - Imports the parts and asserts on HTML strings flattened with ``const flat = v => String(v).replace(/\s+/g,' ')``: group ids, search filtering via `renderFiltered(searchTerms('font'), ['Appearance'], () => sample())`, hit counts, and `providerMark` fallbacks.
  - For full sections it imports `settings.js` dynamically (`:122`) and renders with a stub: `{ library: {items:[],collections:[],settings:{}}, select: { counts: () => ({trash:0}) }, env: { isExtension:false }, state: { settings: { section, list:false, query:'', open:new Set() } }, render(){} }` (`:124-125`). It then asserts that `data-action="settings.x"` strings and copy are present.
- **`tests/settings-catalog.test.mjs`** holds the exact navigation-grouping assertion (`:17-23`), alias and view normalization, `adjacentSections`, and the `matchSections('github')` exact match (`:91`).
- **`tests/settings-assistant.test.mjs`** drives actions:
  - `const { dispatch } = await import('../extension/ui/runtime.js')`, then `await dispatch('settings.research', { ctx, el: { name, value }, data: {...} })`.
  - The ctx comes from `actionCtx` (`:196-199`), which provides `toast`, `nextFrame(){}`, `confirm: async () => true` and `prefs.get`. A fake `ai` records writes (`:176-195`).
  - It asserts on the write log, then re-renders and checks the selected radios. It also renders `renderSettingsPage(...)` for both surfaces and for search mode (`:151-171`).
- **`tests/integrations.test.mjs`** builds `createIntegrationClient({ storage: storageFixture(), store, fetch })` with an in-memory `storageFixture` (`:18-21`) and fake HTTP servers. It checks that secrets never appear in public shapes or snapshots (`:80-119`, `:211-212`).
- **Backup and snapshot coverage:**
  - `tests/backup-v2.test.mjs:87-125` asserts secret-named settings never appear in backup text and that device secrets survive an import.
  - `tests/storage-snapshots.test.mjs:81-89` checks which keys snapshots copy. Add the new key's expectation there.

**For new tests:** export the pure helpers (status, preference patch, ID validation) and the section renderer for Node rendering, as `renderLibrarySection` (`settings.js:680`) and `renderAssistantSettingsSection` (`:957`) are. Drive the actions with `dispatch`, and inject the message transport and storage so no `chrome.runtime` is needed.