# Sidebar Dock data layer: integration map for a `chat` item type

## 1. The library document and how it is written

- **One JSON document**, `chrome.storage.local['still.library.v1']` (`store.js:6`), shaped `{ schemaVersion, items, collections, settings, updatedAt, tombstones? }`. `emptyLibrary` is at `store.js:197-199`, and the shape is documented in `docs/data-model.md:72-80`.
- **Single writer.** Pages send `{ type: 'still:store', operation, args[] }` (`store.js:10`, `operation()` at `store.js:790-797`). The worker routes them through `handleMessage`, which first requires `sender.id === api.runtime.id` (`background.js:885`) and then calls `handleStoreOperation` (`background.js:894`, `store.js:786-789`). Inside the worker, `workerMode` (set by `configureStoreWorker`, `store.js:783`, called at `background.js:81-85`) makes the store functions dispatch locally. An `onMessageExternal` handler in `background.js` can therefore call `saveItem` and the other exports directly, the way `background.js:908` already does.
- **Security pitfall.** `handleStoreOperation` accepts any operation name. An external (Threadkeeper) listener must be a separate listener with its own allowlist and a check for the paired id. It must never forward to `handleMessage`, `handleStoreOperation` or `MESSAGE_TYPES` (`background.js:113-116`).
- **Write cost is O(whole library), several times per operation.** Every `dispatch` (`store.js:352-746`) does all of this:
  - `read()` and `structuredClone` (`current()`, `store.js:340`).
  - `write(clone(state))` (`store.js:741`), which is one `chrome.storage.local.set` of the whole document (`store.js:775`).
  - `notify` clones once per listener (`store.js:338`).
  - `clone(result)` (`store.js:744`). `loadLibrary` and `importLibrary` return the whole library over runtime messaging.
  - `commitIndex` / `commitChange` walk every record (`store.js:303-321`).

  Outside the store, the same document also travels in four more ways:
  - `storage.onChanged` sends `newValue`, the full document, to every open view (`subscribe`, `store.js:823-830`).
  - Bridge sync posts `publicSnapshot(library)` every 2 s (`integrations.js:42-47`, `:202`, `startBridgeSync interval = 2000`). The server limit is `MAX_SYNC_BODY = 64 MiB` (`bridge/server.mjs:12`).
  - Every snapshot copies the whole key, and up to 38 snapshots are kept (`snapshots.js:31`, `:135`).
  - The `vector-store.js:1-3` comment states the same rule explicitly: large data never goes in the library JSON.
- **Caps that exist.**
  - `articleContent` is sliced to 250,000 characters (`store.js:159`). `upsertContentSection` throws above that (`store.js:584`).
  - `icon` data is capped at 16 KB (`MAX_ICON_DATA`, `store.js:87`).
  - `siteName` ≤ 200, `author` ≤ 300, `lang` ≤ 35 (`store.js:175-176`), parent id ≤ 200 (`store.js:99`), collection `description` ≤ 12,000 (`store.js:189`).
  - At most 10,000 tombstones (`store.js:9`).
  - `title`, `content`, `excerpt`, `tags` and unknown keys have **no store cap**. The bridge caps `content` at 1,000,000, `excerpt` at 20,000 and `title` at 1,000 (`protocol.mjs:13`).
  - `unlimitedStorage` is required (`manifest.json` permissions, enforced at `scripts/check.mjs:67`), so there is no 10 MB quota.
- **Recommendation.** Keep chat items small: metadata plus summaries, with a budget of roughly 8 KB for `chat` and at most about 64 KB of summary. Do **not** mirror every Threadkeeper thread as a library item. Use two tiers:
  1. An IndexedDB mirror of all threads (section 4). The assistant searches this.
  2. Library items of type `chat`, created only for threads the user or assistant imports into collections, or for a curated auto-push set.

## 2. Adding item type `chat`: normalization

**Registries in `store.js`**

- `ITEM_TYPES` (`store.js:7`). `normalizeItem` throws `'Unknown item type.'` for anything outside it (`store.js:146-147`).
- `ITEM_FIELDS` (`store.js:22-25`) controls `keepUnknown` (`store.js:32-40`):
  - A key outside `ITEM_FIELDS` is copied only from the **stored** record. That is `existing`, or `merged` when `{ stored: true }` (`store.js:178`).
  - Consequence: a new nested `chat` sent through `saveItem` or `updateItem` (not stored) is **dropped** on create. On update, the stored copy wins and the patch is ignored.
  - The fix is to add `'chat'` to `ITEM_FIELDS` and set it explicitly in the item literal (`store.js:156-177`).

**Follow the sticky pattern exactly**

- `normalizeSticky(value, type, stored)` (`store.js:121-134`): a type gate, bounded fields, then `keepUnknown(..., stored, STICKY_FIELDS)`.
- It is called as `sticky: normalizeSticky(merged.sticky, type, stored ? merged.sticky : existing.sticky)` (`store.js:173`).
- The partial-patch merge is at `store.js:143-145`: `{ sticky: { x } }` merges into `existing.sticky`.

Add the same three pieces: a `CHAT_FIELDS` set, `normalizeChat(value, type, stored)` that returns `null` for non-chat types, and a `chatPatch` merge before `merged.type` is read.

**Proposed bounded shape** (all strings one-line-capped with `oneLine`, `store.js:80`; dates through `isoDate`, `store.js:81-84`; arrays through `list`, `store.js:15`):

```js
chat: { threadId, source: 'threadkeeper', provider, kind /* 'chat' | 'coding-agent' */, project, model, threadUrl,
        messageCount, startedAt, lastMessageAt, sourceUpdatedAt, analysisHash, topics: [],
        transcript: { bytes, messages, hash, storedAt } | null, importedAt }
```

**Required-field rule.** Mirror `store.js:149-151`: throw if `type === 'chat'` and there is no `chat.threadId`. Throwing inside `validateLibrary` (`store.js:213`) aborts the **whole** import or seed. The same rule must therefore go into `portability.checkItem` (section 5).

**Other `normalizeItem` branches to extend**

- The default title (`store.js:158`) yields `'Untitled item'` for chats. Add `'Untitled chat'`.
- `art` (`store.js:163`) has a closed enum. Optional.
- `pageParent` (`store.js:100`) and `parentIdOf` (`pages.js:20-24`) only let notes have a parent. Chats can be **parents** (a user note inside a chat) but never subpages. No change is needed in `pages.js`.

**Field placement**

| Field | What goes in it |
| --- | --- |
| `excerpt` | Short summary |
| `articleContent` | The in-depth summary Markdown. This is the source-owned field: Threadkeeper overwrites it, it is capped at 250k, and the reader tab already renders it (`detail.js:144`). |
| `content` | Untouched, so the user's personal note survives re-pushes |
| `url` | `''` |
| `sourceUrl` | The provider's thread link |

The reason for `url: ''`:
- `saveItem` dedupes any non-note by canonical URL (`store.js:508-509`). A push with a `url` would turn the user's bookmark of that thread into the chat.
- Capture keeps an existing type only for `image`, `video`, `file` and `article` (`capture.js:231`, `capture.js:404`). Capturing the provider page would turn the chat into an article and overwrite `articleContent`.
- `sourceUrl` is only used for dedupe on `article` items (`capture.js:281`, `selectors.js:196`).

**Guard type changes in the store**

These can all change an item's type:
- `convert_items` (`ai/tools.js:956-972`).
- MCP `update_item`, whose patch has a `type` enum (`protocol.mjs:13`).
- `quick-add.js:210/220`.

`normalizeChat` would null the metadata on any conversion. Refuse a transition into or out of `chat` in `normalizeItem` whenever `existing.type` is set. Refuse `type: 'chat'` in the `saveItem` case (`store.js:506-530`) so that chats are created only by the new operation and by imports.

**Timestamps.** `updatedAt` comes from the input only when `stored: true` (`store.js:162`). Put Threadkeeper's own time in `chat.sourceUpdatedAt`.

**Ids.** Use a deterministic, idempotent id such as `chat_tk_<threadId>`. It must match `/^[\w:.-]{1,200}$/` (`validId`, `portability.js:44`) and the bridge `idField` limit of 200 (`protocol.mjs:6`).

**Schema version.** Do not bump `LIBRARY_SCHEMA_VERSION` (`migrations.js:14`). A bump makes older builds refuse every operation (`assertLibraryVersion`, `migrations.js:41-45`), and no existing record changes, so `LIBRARY_MIGRATIONS` stays empty (`migrations.js:17`). Document how older builds behave:
- Their export drops chats as "damaged items".
- Their import refuses backups that contain chats.
- Their UI falls back to `TYPE_LABELS[...] || 'Item'`.

## 3. Store operations and the bulk upsert

**Exported wrappers** (`store.js:798-822`). All return clones.

```js
loadLibrary(seed) · saveItem(input) · updateItem(id, patch, { expectedUpdatedAt }) · deleteItem(id, opts) · restoreItem(id, opts)
permanentlyDeleteItem(id, opts) -> { id, ids, attachmentIds } · createCollection(input) · updateCollection(id, patch, opts)
deleteCollection(id, opts) · mutateTags({ oldTag, newTag|null, expectedLibraryUpdatedAt? }) · bulkUpdateItems([{ id, patch }], { expectedLibraryUpdatedAt })
emptyTrash() -> { ids, attachmentIds } · moveCollection(id, { parentId, beforeId }) · movePage(id, { parentId, expectedUpdatedAt })
upsertContentSection(id, { previous = '', next, field = 'content' }) -> { item, replaced } · updateSettings(patch)
importLibrary(data, { settings }) -> library + importSummary · exportLibrary() (strips /token|secret|password|credential|bridge/, store.js:820)
```

**Existing bulk paths, and why none fits pushes**

- `bulkUpdateItems` (`store.js:589-604`): one write and atomic, but it **only patches existing items** (`findItem` throws, `store.js:376`).
- `importLibrary` (`store.js:676-735`):
  - It merges by id with newer-wins and respects tombstones (`store.js:700`).
  - It **replaces whole records**, so the user's `collectionId`, `tags` and `favorite` would be lost.
  - It always writes (`changed = true`).
  - It returns the full library.
  - It is unsuitable for pushes.

**Recommendation: a new `case 'upsertChats'`** in the switch (`store.js:504-737`), with a wrapper next to `store.js:798-816`. Arguments: `[entries, { expectedLibraryUpdatedAt?, collectionId?, revive? }]`. For each entry:

1. Skip the entry if its id has a tombstone and `revive` is not set (`tombstonesOf`, `store.js:252`). `saveItem`'s `unbury` (`store.js:528`) would otherwise **resurrect** a chat the user deleted forever on the next push.
2. If the item exists, build the next record with `normalizeItem({ title, excerpt, articleContent, chat }, existing)`. Never touch `collectionId`, `tags`, `favorite`, `archived`, `deletedAt` or `content`. Skip it entirely when `chat.analysisHash` is unchanged.
3. If it is new, call `normalizeItem(input)` and validate the target collection with `findCollection`. Fall back to the Inbox if the collection is gone.
4. Collect `[existing|null, next]` pairs and call `commitItems(changes)` once (`store.js:410-480`). Then `unbury` the revived ids.
5. Set `changed` only when something changed, so a no-op push writes nothing, sends no broadcast, does not mark snapshots dirty, and triggers no bridge sync.
6. Return a compact `{ added, updated, skipped: [{ id, reason }], items: [{ id, updatedAt }] }`, never the full library.
7. Cap the batch at 100, matching MCP `bulk_update_items` (`protocol.mjs:66`).

**Places to register the new operation**

- `ai/index.js:37-38` `STORE_METHODS`, if the assistant uses it.
- `integrations.js:141-197` `applyCommand`, only if MCP exposes it.

## 4. Where large per-item data lives: transcripts in IndexedDB

**Pattern to copy**

- `openAttachmentDb` (`store.js:859-880`): a cached promise, a guarded `onupgradeneeded` with `objectStoreNames.contains`, and `onversionchange → close and null`. It also handles `onclose`, `onerror → null` and `onblocked` with a clear error.
- `attachmentTransaction` (`store.js:881-895`): resolves on `oncomplete` and resets the cached handle if `db.transaction` throws.
- `idbSnapshotBackend` (`snapshots.js:68-108`) is the multi-store `transact(stores, mode, body)` variant. It takes an injectable `idb`, which tests need.

**Use a new database**, for example `still.chats.v1` at version 1. Do **not** add a store to `still.attachments.v1`:
- Bumping it to version 2 makes `indexedDB.open('still.attachments.v1', 1)` in a downgraded build fail with `VersionError`, which breaks every file.
- Any open view gets `onblocked`.

Suggested stores:

| Store | Key | Contents |
| --- | --- | --- |
| `transcripts` | keyPath `id` = chat item id | `{ id, threadId, messages: [{ id, role, text, at, model? }], bytes, hash, sourceUpdatedAt, storedAt }` |
| `threads` | keyPath `threadId`, indexes `provider`, `kind`, `project`, `lastMessageAt` | The all-threads mirror the assistant searches |

**Keep transcripts out of `chrome.storage.local`.** A `still.*` key there is copied into every snapshot (`isSnapshotKey`, `snapshots.js:39`). It is also broadcast through `onChanged`, and it marks the daily snapshot dirty (`background.js` `storage.onChanged` listener).

**Keep mirror vectors out of `still.embeddings.v1`.** `planIndex` deletes vector state for any id that is not a live library item (`indexer.js:102-116`), so thread vectors need their own database or namespace. The indexer only sees item text from `itemIndexText` (`indexer.js:70-84`), capped at 64 chunks of 1,200 characters (`indexer.js:5-8`). Add `chat.provider`, `kind` and `project` to its `header` there.

**Write ordering.** IndexedDB and the library are not written atomically. Write the transcript first, then the item. If the library write fails, delete the transcript, as `importPortableFile` does for files (`portability.js:805-810`).

**Delete-forever cleanup**

- `removeItems` (`store.js:486-503`) returns `{ ids, attachmentIds }`. Add `transcriptIds` (ids of removed items with `type === 'chat'`) to the result of `permanentlyDeleteItem` and `emptyTrash`.
- Callers that must also delete transcripts:
  - `library.js:246-263` `deleteItemsForever`, then `library.js:670-690`.
  - `library.js:692-700` `emptyTrash`.
  - `settings.js:1699-1700`.
  - `integrations.js:146-160` (bridge; also report `fileCleanup`).
  - `ai/tools.js:491-493` (undo).
  - `widgets/links-folder.js:116`.
- Because transcripts are keyed by item id, also run an orphan sweep on worker start or the daily alarm. Delete only rows whose id is neither in `items` (Trash counts as present) nor in `tombstones`.
- A snapshot restore can bring back a chat whose transcript is gone, the same as with attachments (`snapshots.js:3-5`). The chat page must show "Transcript unavailable — re-sync from Threadkeeper".

**Pairing state.** Store it device-only, either in `still.integrations.v1` (`docs/data-model.md:21`) or in a new `still.threadkeeper.v1` key. Never put it in library `settings` under a name that misses `SECRET_SETTING` (`store.js:231`) or `SECRET_KEY` (`portability.js:36`): a crafted backup could otherwise approve an extension id. If pages write that key under a Web Lock, add the lock to `RESTORE_LOCKS` (`snapshots.js:37`).

## 5. Portability (`portability.js`)

**Format** (`portability.js:3-13`, assembled at `:428-432`):

```
{ backupVersion: 2, schemaVersion, exportedAt, manifest: { app, extensionVersion, deviceId?, counts: { items, collections, notes, attachments, boards, conversations, aiConnections }, warnings },
  items, collections, settings, tombstones?, updatedAt, dashboard?, attachments: [{ id, name, mime, data: 'data:<mime>;base64,…', ref?: 'wallpaper' }],
  conversations?: { version: 2, conversations }, aiConfig?: { version: 2, settings, connections } }
```

**Required change: `TYPES`** (`portability.js:33`) gates `checkItem` (`:151`).
- Without `'chat'`, export drops every chat item: `exportableLibrary` puts it in `dropped` and warns "Left out N damaged items" (`:269-287`).
- Without `'chat'`, import refuses the whole file.
- `checkItem` (`:148-187`) carries an invariant (`:143-147`): it must reject everything `normalizeItem` rejects. Add the `chat.threadId` rule next to `:167`. Add a `checkChat` that is strict on import and repairs on export. `ITEM_STRINGS`, `ITEM_FLAGS` and `ITEM_DATES` (`:130-133`) do not cover nested objects.

**Transcripts in a full backup**

- Add a `SOURCES` entry (`:367-373`), for example `chats: async () => import('./chat-store.js')`, and a `part('chats', …)` in `createFullBackup` (`:394-426`). The output is `chatTranscripts?: { version: 1, transcripts }`.
- Add `counts.chats` to the manifest (`:487-489`).
- `part` must run **before** the files are budgeted. The file budget is computed from the serialized backup (`:452`), so transcripts shrink the room for files. Apply a smallest-first room check with a warning for transcripts too.
- `serializeBackup` throws above 200 MB (`MAX_BACKUP_BYTES`, `:26`, `:499-506`).
- `guardJson` allows depth ≤ 30 (`:48-55`), which is fine for root → section → array → entry → messages → message.

**Restore**

- Validate the outer shape before the snapshot, like `validateConversations` (`:322-326`, `:722-725`).
- Restore after `importLibrary` through `restore(key, …)` (`:839-862`).
- Restore only transcripts whose item was taken (`importSummary.skippedItemIds`, `:813-815`).

**Other formats**
- CSV `csvType` (`:569-574`) must map `chat` to excluded, as it does for `file`. Otherwise a `type: chat` row with a link imports as a chat that has no transcript.
- Chats with empty `url` are left out of HTML bookmarks automatically (`:870`).
- `exportNotesMarkdown` includes only notes or items with `content` or highlights (`:923`). Consider including the chat summary.
- `exportConversationsMarkdown` (`:977-995`) is the model for a transcript export with `> **You:**` lines.
- Restore steps are documented at `docs/data-model.md:318-329`.

## 6. Snapshots, meta and migrations

- Snapshots copy every `still.` key except `SNAPSHOT_EXCLUDED_KEYS` (`snapshots.js:33-34`). IndexedDB is not copied, so transcripts are excluded.
- `countSnapshot` (`snapshots.js:48-55`) counts notes. A `chats` count is optional.
- `meta.js` (`createMetaStore`, `:25-45`) keeps unknown keys under the Web Lock `still.meta.v1`. Its `deviceId` is the change origin for a future sync.
- `area.js` provides `chromeArea`, `webArea` and `memoryArea` (`:14-50`). Use `memoryArea` in tests for any new chrome.storage key.

## 7. Bridge / MCP (`bridge/protocol.mjs`)

- `types` (`:4`) feeds:
  - the `itemProperties.type` enum (`:13`), used by `create_item` and by the `update_item` patch;
  - `searchProperties.type` (`:24`), used by `search_library`, `list_items` and `export_library`;
  - `semantic_search.type` (`:41`);
  - `capabilities.itemTypes` and `pages.parentTypes` (`:121`, `:125`).
- `validate` (`:75-87`) enforces enums only on tool **arguments**. `sync` (`:141-156`) accepts any item type in the snapshot. Chats will therefore show up in `list_items`, but agents cannot filter by `type: chat` until it is in the enum.
- **Recommendation:** use a separate `filterTypes = [...types, 'chat']` for search, list and semantic search, plus `itemTypes`. Keep `chat` out of `create_item` and the `update_item` patch, so agents cannot forge chats or convert them.
- `validateItem` (`:93-100`) requires a URL only for bookmark, image, video and file, so it needs no change.
- `markdown()` (`:105-110`) and `export_item` should render the chat metadata.
- `selectedItems` (`:157-168`) does not search `chat.*`.
- `plainItem` (`:102`) and `publicSnapshot` (`integrations.js:42-47`) pass `chat` through. Keep it small: the sync limit is 64 MiB.

## 8. Every place that enumerates item types (grep-verified)

**Closed lists and maps**

- `store.js:7` `ITEM_TYPES`. Also read by `app.js:289` (URL `?type=`).
- `ai/tools.js`:
  - `:16` `ITEM_TYPES` (enums at `:63`, `:73`; filters at `:582`, `:633`).
  - `:25` `CONVERT_TYPES` (`:140`, `:957`).
  - `:26` `LINK_TYPES`.
  - `:28` `NEEDS_URL` (`:1011`).
  - `:231` `TYPE_WORDS`.
- `portability.js:33` `TYPES`, `:167`, `:572-573`.
- `bridge/protocol.mjs:4`, `:97-98`.
- `ui/components.js:308` `TYPE_LABELS` and `:309` `TYPE_ICONS`.
- `lib/block-editor.js:358` has a separate `TYPE_ICONS`.
- `ui/selectors.js:13` `ITEM_VIEW_TYPES` (counts at `:142`; filters at `:223`, `:228`, `:243`, `:297`).
- `ui/sidebar.js:31-34` type views.
- `ui/library.js:36-37` `TYPE_CHIPS`, `:50-55` view meta, `:65`.
- `ui/shell.js:33-34` `TYPE_FILTERS`, `:38`, `:69` title map.
- `ui/settings.js:105` search help text.
- `ui/map.js:17`, `:25-26`.
- `ui/quick-add.js:142`, `:316-318`, `:329`.
- `ui/cards.js:13` `MEDIA_TYPES`.
- `ui/widgets/links/model.js:6` `LINK_TYPES`.
- `lib/library-views.js:40-42` (`buildSpaceContext` counts; add `chatCount`).
- `lib/integrations.js:58` (Raindrop mapping).
- `lib/capture.js:231`, `:404`.
- `docs/data-model.md:82`.

**`type === 'note'` and similar branches**

- Data layer: `store.js:100`, `122`, `158`, `288`, `393`, `508-509`, `562`; `pages.js:21`; `snapshots.js:53`; `portability.js:487`, `572`, `923`; `capture.js:280-281`; `notes.js:45`, `:70`; `dashboard-seed.js:11`, `:26`; `ai/assistant.js:126-127`; `ai/research/*`; `background.js:314-315`.
- UI: `cards.js`, `detail.js`, `note-editor.js`, `notes.js`, `page.js`, `command.js`, `dashboard/search.js`, `widgets/*`, `ai-panel.js`, `assistant-page.js`, `stickies.js`.
- `bridge/protocol.mjs:245`, `:261`.

## 9. Test conventions

- **Store tests** build an in-memory store: `createLibraryStore({ read: async () => value && structuredClone(value), write: async s => { writes++; value = structuredClone(s); }, onCommit })` and call `store.dispatch(name, args)`.
  - Examples: `tests/store-bulk.test.mjs:5-11` and `tests/storage-library.test.mjs:6-12`. The latter's `at(minutes)` helper gives stable stamps.
  - Assert the write count (one write per batch), failed batches changing nothing, keep-unknown round-trips (`storage-library.test.mjs:14-40`) and tombstone limits (`:144-147`).
- **IndexedDB tests** use `fakeIndexedDB()`, defined inline in `tests/storage-snapshots.test.mjs:13-55`; it is not shared. The pattern:
  - `idb.seed(name, 0, stores)` and `globalThis.indexedDB = idb`.
  - Assert guarded upgrades and reopening after `connection.onversionchange()` (`:250-264`).
  - A new chat DB should take an injectable `idb`, as `idbSnapshotBackend` does.
- **Backup tests** use the `device()` harness (`tests/backup-v2.test.mjs:9-30`): a memory library, an attachment map and an ordered `log`. Sources are injected through options (`dashboard`, `conversations` and so on; `null` turns one off).
- **Bridge tests** use `tests/bridge-mcp-tools.test.mjs:11-30`: `createBridgeState` plus a real `createLibraryStore`, and `TOOLS` is imported for schema checks.
- Run `node --test tests/*.test.mjs` and `node scripts/check.mjs`. `check.mjs` validates the manifest's permissions, hosts and CSP (`:60-84`). It does not flag `externally_connectable`, but adding a required permission would fail it.