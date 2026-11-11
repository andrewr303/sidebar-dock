# Still data model and storage policy

This page lists every place Still keeps data, the shape of each record, and the rules that keep that data safe across
extension updates. It also covers how data is exported and how a future online sync would plug in. Everything is
local-first: nothing leaves the device unless the user exports a file or connects a service.

## Where data lives

### chrome.storage.local (extension) or localStorage (preview build)

| Key | Owner | Contents | In snapshots | In full backup | Device-only |
| --- | --- | --- | --- | --- | --- |
| `still.library.v1` | `lib/store.js` | Library: items, collections, settings, tombstones | yes | yes (settings without secrets) | secret-like settings keys |
| `still.dashboard.v1` | `lib/dashboard-store.js` | New-tab boards, widgets, widget config (kanban, quick links, notes draft) | yes | yes (secret-like config keys stripped) | no |
| `still.ai.v2` | `lib/ai/connections.js` | AI connections (non-secret fields), AI settings, overlays, model cache | yes | non-secret part, without the device-only settings | bridge auth; the `assistantPermissions`, `research`, `browser` and `webSearch` settings |
| `still.ai.secrets.v1` | `lib/ai/secrets.js` | `{ <connectionId>: { apiKey, updatedAt } }` | yes | **never** | **yes** |
| `still.ai.conversations.v2` | `lib/ai/conversations.js` | Conversation index `{ version: 2, migratedLegacy, items: [summary] }` | yes | yes | no |
| `still.ai.conversation.v2:<id>` | `lib/ai/conversations.js` | One conversation body (messages; research runs also keep their run record) | yes | yes | no |
| `still.ai.research.v1` | `lib/ai/research/provision.js` | Research agent and environment ids per Anthropic connection and workspace (below) | yes | **never** | **yes** |
| `still.accounts.v1` | `lib/accounts.js` | Connected accounts (GitHub, Linear, Product Hunt tokens; calendar feed URLs) | yes | **never** | **yes** |
| `still.integrations.v1` | `lib/integrations.js` | Raindrop and local-bridge tokens, bridge URL and switches | yes | **never** | **yes** |
| `still.ai.preferences.v1`, `still.ai.chats.v1` | legacy | Read-only migration sources from older builds; never deleted | yes | no | no |
| `still.meta.v1` | `lib/storage/meta.js` | `{ deviceId, installedAt, lastVersion, lastSnapshotAt, changedAt }` | no (bookkeeping) | `deviceId` only, in the manifest | **yes** |
| `still.widget-cache.v1` | `lib/widget-cache.js` | Rebuildable widget data cache `{ <key>: { value, at } }` | no (cache) | no | yes |
| `still.ui.recent.v1` | `ui/prefs.js`, `background.js` | Recently used collections for the "Save to" menus | no (cache) | no | yes |
| `still.threadkeeper.v1` | `lib/threadkeeper/state.js` | Pairing with Threadkeeper and the AI chat sync preferences (below) | no (bookkeeping) | **never** | **yes** |

"Secret-like" means a key that matches `token|secret|password|passphrase|credential|bridge|integration|api[-_]?key|authorization|cookie`
(case-insensitive). Those keys never go into an export file. Imports never apply them, and the device keeps its own.

`still.ai.research.v1` is `{ version: 1, byConnection: { '<connectionId>|<workspaceId>': { agentId, agentVersion, specHash,
environmentId, createdAt, updatedAt } } }`. It names resources in one person's Anthropic account, so no export carries
it. Writes use the Web Lock `still.ai.research.v1`. A stored `version` above 1 is never written over: research then
refuses to run (`newer_version`) rather than create agents the newer record cannot see. **Reset research agent** writes
an empty record; nothing is deleted from the Anthropic account. Restoring a snapshot that lacks the key removes it, and the
next run creates a new agent and environment.

`still.threadkeeper.v1` is device-only integration state, written under the Web Lock `still.threadkeeper.v1` by the
worker and the settings page: `{ version: 1, extensionId, status ('off' | 'pending' | 'paired' | 'denied' | 'revoked'),
pending: { requestId, extensionId, code, at } | null, epoch, configured, configDirty, backfill: { total, startedAt, paused },
tk: { version, capabilities }, pairedAt, lastSeenAt, lastSyncAt, lastError, lastErrorAt, counts: { created, updated,
removed }, prefs: { scope, projects, providers, transcripts, autoUpdate, placement, parentName, singleCollectionId,
matchExisting, topicsAsTags, onRemoved, defaultView, assistant: { search, context, decision } }, collections }`. The
protocol and every field's meaning are in `docs/threadkeeper-integration.md`. It is excluded from snapshots
(`SNAPSHOT_EXCLUDED_KEYS`): restoring an older snapshot must never unpair Still or bring back a revoked pairing. After a
snapshot restore or a backup import the worker starts a new sync `epoch`, so Threadkeeper re-offers what the restored
library lacks. It is never in a backup, so a crafted file cannot approve an extension id.

### chrome.storage.session (extension only, cleared when the browser closes)

| Key | Owner | Contents |
| --- | --- | --- |
| `still.capture.pickers.v1` | `background.js` | Page picker requests the worker started `{ <requestId>: { tabId, windowId, from, documentId, startedAt } }`, at most 20, each valid for 30 minutes. A picker result is accepted only for a known request id, from that tab's top frame. |
| `still.capture.drafts.v1` | `lib/capture.js`, `ui/quick-add.js` | Picker results finished while that window's side panel was closed `{ <draftId>: { draftId, windowId, tabId, createdAt, article } }`, at most 3. The side panel takes its window's newest one when it opens. |

Neither key is in snapshots or backups. Web pages cannot read `storage.session`.

### localStorage (per extension origin, every build)

| Key | Contents |
| --- | --- |
| `still.ui.v1` | UI preferences: panel width, sidebar state, expanded collections, rail preferences |
| `still.appearance.v1` | Boot cache of appearance settings (derived from library settings) |
| `still.notes.drafts.v1` | Unsaved note drafts `{ "<itemId>:<field>": { text, title, base, at } }`, expire after 30 days |
| `still.import.mode.v1`, `still.embed.hints.v1`, `still.link-icons.v1` | Small preferences and caches |

The extension's snapshots cover chrome.storage.local, so these localStorage keys are not in them. In the preview
build everything lives in localStorage, and snapshots include it, except the caches listed in
`SNAPSHOT_EXCLUDED_KEYS`.

### IndexedDB

| Database | Stores | Contents |
| --- | --- | --- |
| `still.attachments.v1` (v1) | `files` (keyPath `id`) | `{ id: 'file_<uuid>', blob, name, mime, size, createdAt }`: item files, screenshots, the uploaded wallpaper (`settings.wallpaper.attachmentId`) |
| `still.embeddings.v1` (v1) | `chunks`, `meta` | Semantic-search vectors. Rebuildable from the library (rebuilding costs embedding calls) |
| `still.snapshots.v1` (v1) | `summaries`, `payloads` (keyPath `id`) | Automatic device-local snapshots (see below) |
| `still.chats.v1` (v1) | `records`, `transcripts`, `dismissed`, `meta` (keyPath `id`) | AI chats' summaries and transcripts (`lib/chat-data.js`, see "AI chats") |

Every IndexedDB open uses guarded upgrades (`objectStoreNames.contains()` before `createObjectStore`). It closes its
connection on `versionchange`, reopens on the next call, and reports `blocked` as a clear error.

## The library record (`still.library.v1`)

```js
{
  schemaVersion: 1,                 // LIBRARY_SCHEMA_VERSION (lib/storage/migrations.js)
  updatedAt: ISO,                   // library-level stamp, bumped on every write (optimistic lock for bulk/tag edits)
  items: [Item], collections: [Collection],
  settings: { ... },                // appearance, new tab, wallpaper, dashboard, layouts... (settings-schema.js)
  tombstones: [{ kind: 'item' | 'collection', id, deletedAt }],   // present once something was hard-deleted
}
```

**Item:** `id ('item_<uuid>' or a fixed seed / import id), type ('bookmark' | 'article' | 'image' | 'video' | 'file' | 'note' | 'chat'),
title, url, excerpt, content (Markdown note), articleContent (<= 250k chars), tags[], collectionId ('' = Inbox), favorite,
archived, deletedAt (Trash), createdAt, updatedAt, cover, art, sourceUrl, highlights[{ id, text, note, color, createdAt, url }],
relatedIds[], reminderAt, reminderNotifiedAt, attachmentId, fileName, mime, size, pinned, read,
sticky ({ color, board, x, y, w, h, z, hidden } | null, notes only), chat ({ … }, chats only, below), parentId ('' = top level, notes only),
siteName (<= 200), author (<= 300), publishedAt (ISO or ''), icon (http(s) URL or data:image <= 16 KB, else ''),
lang (language tag <= 35), customIcon (an uploaded icon: base64 PNG, JPEG, GIF, WebP or AVIF data URL <= 64 KB, else '')`.

`cover` and `customIcon` can be uploads: `ui/item-media.js` decodes any image Chrome can open, scales it (covers to
1600 px on the longest side, icons to a 192 px square) and stores it in the item as a WebP data URL, so it works
offline and is included in backups. `customIcon` is kept apart from the captured `icon`, so saving the page again
never replaces an uploaded icon.

`siteName`, `author`, `publishedAt`, `icon` and `lang` are details captured with a page. Saving the same URL again
fills them only when the new value is not empty, so a later capture never blanks one. None of these fields needed a
migration: older records read as `''`, and older builds keep the fields through edits (`keepUnknown`).

**Collection:** `id, name, color, icon, parentId ('' = top level), description, cover, pinned, layout, sidebarLayout,
createdAt, updatedAt, deletedAt? (only when set)`. Order is the array order.

### Ids and timestamps

- Ids are `<prefix>_<uuid>` (`item_`, `collection_`, `highlight_`, `file_`), plus fixed ids from the seed (`welcome`,
  `design`, ...) and from imports (`raindrop-<id>`).
- `updatedAt` is an ISO string that only moves forward per record: it is `max(now, previous + 1 ms)`.
- An edit bumps it, and so does an edit as a side effect (tag rename, collection deletion moving items to the Inbox,
  re-parenting children, every subpage cascade and lift below). The exception is derived backlink clean-up: when an item
  is deleted forever, other items lose it from `relatedIds` without a new stamp, so an editor open on them keeps a valid
  revision. `onCommit` still reports those items as changed.
- Seed, import and backup data keep their own `createdAt` and `updatedAt` when they parse. A future stamp, for example
  from another device's clock, is clamped to now.

### Never dropping data

- When this build edits a stored item, collection, highlight or sticky placement, it keeps every key it does not know
  (`keepUnknown` in `store.js`). A field written by a newer build, or by an older one, therefore survives. Keys that
  arrive only with a patch, such as UI transient props, are dropped. Prototype keys are never copied.
- Seeding and importing keep unknown keys from the file.
- Trash is a soft delete (`deletedAt`). Hard deletes (delete forever, empty Trash, delete collection) record a tombstone,
  one per id, including subpages deleted with their page. Tombstones are capped at the newest 10,000, and one is
  removed when its id is created again.

### AI chats (type `chat`)

A chat is an AI conversation Still keeps from Threadkeeper (`docs/threadkeeper-integration.md`). The library item stays
small (about 1 KB); the analysis and the transcript live in IndexedDB `still.chats.v1`.

- **Item fields.** `id` is always `'chat_tk_' + threadHash(threadKey)` (`lib/threadkeeper/protocol.js chatItemId`). `url` is
  always `''` (saving a page dedupes non-notes by URL, so a chat never has one); `sourceUrl` is the original
  conversation (https) or `''`; `title` (≤ 300 when sync writes it), `excerpt` (the gist, ≤ 300) and `siteName` (the
  provider) come from sync; `createdAt` is the thread's. `content` holds the user's own notes, and `tags`, `favorite`,
  `archived`, `relatedIds` and subpages are the user's: sync never writes them (topics become tags only when a chat is
  created with the "Add topics as tags" preference, and those are recorded in `chat.syncedTags`).
- **`chat`:**

  ```js
  { v: 1, source: 'threadkeeper',
    threadKey,                 // ≤ 600, required: "A chat needs its Threadkeeper thread."
    provider,                  // [a-z0-9_]{1,40} or ''
    providerLabel,             // ≤ 80
    category,                  // 'chat' | 'coding_agent' | 'agent' | 'builder' | 'search' | 'companion' (else 'chat')
    kind, project, model,      // ≤ 40 / ≤ 200 / ≤ 120
    workflowState,             // 'active' | 'needs_review' | 'waiting' | 'paused' | 'done' | 'archived' | ''
    messageCount, lastActivityAt,
    topics,                    // ≤ 8 strings ≤ 40, deduped
    analysis: { source: 'ai' | 'local' | '', generatedAt }, analysisVersion,
    fingerprint, revision, seq,          // what Still holds (seq is Threadkeeper's monotonic counter)
    hasTranscript, transcriptTruncated,
    origin,                    // 'sync' | 'manual' | 'assistant' | 'import': how the chat was first created
    syncedAt,                  // last time sync changed the item
    syncedTitleHash, syncedExcerptHash,  // syncedHash() (lib/threadkeeper/protocol.js; 8 hex of the one-line text) of the
                                         // title / excerpt sync last wrote; store.js exports it as chatTextHash
    syncedTags,                // tags sync added on create
    autoCollectionId,          // the collection sync last chose ('' = Inbox)
    removed }                  // '' | 'deleted' | 'out_of_scope' | 'local_only' | 'disconnected'
  ```

  Every field is coerced and capped by `normalizeChat`; unknown keys from a newer build survive edits. The agent label,
  kind label, workspace path, git branch, start time and analysis model live in the IndexedDB record, not here.
- **Guards** (`normalizeItem`): no conversion into or out of `chat` ("Chats cannot be converted."); `saveItem` refuses
  `type: 'chat'` ("Chats come from Threadkeeper."); an ordinary edit (`updateItem`, `bulkUpdateItems`) can rename, move,
  tag, annotate or trash a chat but never rewrite its `chat` object. Chats can be parents of note subpages, never
  subpages. `LIBRARY_SCHEMA_VERSION` did not change: older builds refuse to import a backup with chats ("unsupported
  item type") and leave chats out of their exports as damaged items.
- **"Touched"** (`isChatTouched(item, items)`): the user wrote notes, has live subpages, added tags (beyond
  `syncedTags`), starred, renamed (title hash ≠ `syncedTitleHash`) or moved it (`collectionId ≠ autoCollectionId`). Sync
  never trashes or deletes a touched chat.
- **Store operations** (each one write, nothing written when nothing changes, `updatedAt` bumped on changed records):
  - `upsertChats(entries, { revive, ensureCollections, dismissedIds })` → `{ results: [{ threadKey, id, status, reason?,
    fingerprint?, seq? }], collections: [{ key, id, created }] }`, at most 100 entries. An entry is `{ threadKey, id?,
    fingerprint, seq, origin, revive?, tags?, item: { title, excerpt, sourceUrl, siteName, createdAt }, chat: { provider,
    providerLabel, category, kind, project, model, workflowState, messageCount, lastActivityAt, topics, analysis,
    analysisVersion, revision, hasTranscript, transcriptTruncated }, placement?: { collectionId } | { collectionKey } (+
    `force: true`) }`. Statuses: `created`, `updated`, `unchanged`, `skipped` with reason `invalid` (wrong id, or the id
    is not a chat of this thread), `stale` (older `seq`), `dismissed` (a new id listed in `dismissedIds`, unless revived)
    or `trashed` (only the `chat` metadata of a chat in Trash is refreshed). With `revive` a chat in Trash is restored
    with the subpages trashed with it and placed. Title, excerpt and collection follow sync only while the user has not
    changed them (`force` moves a chat the user moved, for an explicit manual target). A different `seq` alone is not
    a change. `ensureCollections: [{ key, name, parentKey?, parentId?, icon?, color? }]` are resolved on first use: a
    live collection with the same name (trimmed, any case) under the same parent is reused, else created. A collection
    id that no longer exists falls back to the Inbox. Creating a chat lifts its tombstone: the worker, not the store,
    decides whether a chat the user deleted forever may come back.
  - `markChatsRemoved([{ id, reason }], { trash })` → `{ results: [{ id, status: 'removed' | 'kept' | 'missing' }] }`.
    `local_only`: an untouched chat is deleted forever (with a tombstone); a touched one keeps its notes, user tags and
    subpages but loses everything from the thread (`title` "Private thread" unless renamed, excerpt, `sourceUrl`,
    `siteName`, synced tags, and `chat` down to `{ v, source, threadKey, origin, removed, syncedTitleHash,
    autoCollectionId }`). Such chats are left out of the bridge snapshot and the assistant. `deleted`, `out_of_scope`,
    `disconnected`: `chat.removed` is set; with `trash` untouched chats go to Trash, touched ones are `kept`.
  - `placeChats([{ id, collectionId | collectionKey }], { ensureCollections })` re-places chats after the placement
    preference changed; a chat the user moved is `kept`.
  - `setChatFlags([{ id, restore?, chat: { removed?, hasTranscript?, transcriptTruncated? } }])` changes only Still's
    own bookkeeping flags (an ordinary `bulkUpdateItems` never touches `chat`); `restore` brings a chat back from Trash
    (used after a stored transcript changes and when a new pairing restores chats a disconnect trashed).
  - `deleteChats(ids)` deletes chats forever without a tombstone (undoing an assistant import).
  - `CHAT_SYSTEM_DELETES` (`markChatsRemoved`, `deleteChats`) names the operations whose deletes are bookkeeping; for
    any other operation the worker's `onCommit` treats a deleted `chat_tk_` id as "deleted forever by the user" and
    records it in the `dismissed` store.
- **`still.chats.v1`** (`lib/chat-data.js`, injectable `indexedDB`, memory fallback without one):
  - `records`: `{ id, threadKey, fingerprint, revision, seq, storedAt, bytes, transcript: { revision, totalMessages,
    stored, truncated, bytes, storedAt } | null, thread }`, where `thread` is the sanitized `ThreadPayload` without its
    transcript (≤ 1 MB).
  - `transcripts`: `{ id, threadKey, revision, truncated, totalMessages, messages: [{ index, role, content, createdAt }],
    storedAt, bytes }`: messages sorted by 0-based index, roles `user | assistant | system | tool`, ≤ 121,000
    characters each, ≤ 20,000 messages and 32 M characters (first 20 and newest kept).
  - `dismissed`: `{ id, at }`, uncapped; `meta`: `{ id: 'store', storeId, createdAt }` (a new `storeId` means the
    store was lost, which starts a new sync epoch).
  - A record and its transcript are written in one transaction. `putChatData(id, { thread, transcript })` refuses an
    older `seq`, and without a transcript keeps the stored one only for the same `revision`.
    `mergeChatTranscriptWindow` merges later windows into the same revision (`truncated` clears once contiguous).
    Writes come from the service worker; pages read (`getChatRecord`, `getChatTranscript`, `searchChats`).
  - `sweepChatData(library)` deletes data whose id is not a library item (Trash counts; tombstones do not) once it is 10
    minutes old, and the data of `local_only` chats at once. The worker runs it on startup, install and the daily alarm.
  - `searchChats(query, { filters, limit })` is the offline search over summaries and transcript text.
  - `chatEntryFromThread(payload, { origin, placement, tags, revive, transcript })` maps a sanitized `ThreadPayload`
    onto an `upsertChats` entry (pure).
  - Not in snapshots. A restored chat whose data is missing shows that and can refresh from Threadkeeper.

### Subpages (the page tree)

A note can sit inside another item through `parentId`, like a page inside a page. The rules live in `lib/store.js`; the
read helpers (`parentIdOf`, `pageIndex`, `parentOf`, `childrenOf`, `descendantIds`, `ancestorsOf`, `isSubpage`,
`wouldCycle`, `pageTree`, `pageDepth`, `pageHeight`, `pageText`, `pageBlockLine`, `parsePageBlockLine`) are pure
functions in `lib/pages.js`. The bridge (`bridge/protocol.mjs`) imports the same module for its MCP checks.

- **Shape.** Only notes have a parent; the parent may be any item type (a note, a saved article, a bookmark, a file).
  There is no children array: `parentId` on the child is the only source of truth. Siblings are ordered by `createdAt`,
  then `id`. Pages nest at most 32 levels (`MAX_PAGE_DEPTH`). Every walk over stored data is guarded against loops.
- **Placing a page** (`saveItem` with `parentId`, `updateItem`, `bulkUpdateItems`, `movePage(id, { parentId,
  expectedUpdatedAt })`): the parent must exist and not be in Trash ("That page no longer exists."), the page cannot end
  up inside itself or one of its subpages ("A page cannot be placed inside itself."), and the whole subtree must fit
  under the cap ("Pages can be nested 32 levels deep."). A batch is checked on the state after the whole batch, so it
  cannot build a loop between its own entries; a failed check writes nothing.
- **Collections.** A new subpage takes its parent's collection unless the caller chose one. A page moved inside another
  takes that page's collection, and a page's collection change carries down to its live subpages in the same write
  (subpages patched in the same batch keep their own). A page moved to the top level keeps its collection.
- **Trash.** Trashing a page (`deleteItem`, or a `bulkUpdateItems` patch that sets `deletedAt`: Library trash and undo,
  the assistant's `trash_items`) gives its live subpages the identical `deletedAt` stamp. A subpage already in Trash
  keeps its own stamp. A page already in Trash that gets a new stamp takes the subpages trashed with it along.
- **Restore** (`restoreItem`, or a patch that clears `deletedAt`) brings back the subpages whose `deletedAt` equals the
  page's former stamp: those trashed together, never ones trashed separately. A restored page whose parent is still in
  Trash, or gone, moves to the top level (`parentId: ''`); restoring the old parent later does not re-nest it.
- **Delete forever.** `permanentlyDeleteItem` on a page in Trash also deletes the subpages that share its stamp. Its
  other subpages move up to the nearest page that stays (or the top level). On a live page (the assistant's undo of a
  note it created) no subpage is ever deleted: its children move up. It returns `{ id, ids, attachmentIds }`: every
  deleted id and the file blobs no remaining item uses. `emptyTrash` moves live subpages of trashed pages (left by an
  older build) up the same way. Callers that loop over delete forever skip ids a cascade already removed.
- **Research writes.** `upsertContentSection(id, { previous = '', next, field = 'content' })` reads the latest record
  inside the write queue: when `previous` is non-empty and found, its last occurrence becomes `next`; otherwise `next` is
  appended after a blank line, keeping the existing text byte for byte. Only `content` and `articleContent` can be
  written. It returns `{ item, replaced }`.
- **Page block.** A note links a subpage with one whole line, `[[item_id|Title]]{page}` (`pageBlockLine`). Older builds
  and wiki-aware tools read it as a wiki link. Deleting the line never deletes or moves the page.
- `onCommit` reports every record a cascade or lift changed, and every id deleted with a page.

### Schema versions and migrations

- `lib/storage/migrations.js` holds `LIBRARY_SCHEMA_VERSION` and an ordered registry `{ version, migrate(state) }`. Each
  migration upgrades version `n - 1` to `n`. It works on raw stored data, must be pure and synchronous, must not drop
  records or unknown fields, and should bump `updatedAt` on every record it changes. A shipped migration is never
  edited: add the next version instead.
- Every library operation reads storage first:
  - **Newer schema** (`schemaVersion > LIBRARY_SCHEMA_VERSION`, or a version that is not a whole number): every
    operation, reads included, throws `NewerLibraryError` ("Your library was saved by a newer version of Still. Update
    Still to keep editing; nothing was changed."), and nothing is written.
  - **Older schema:** the store awaits the `beforeMigration` hook, which takes a `'before-migration'` snapshot, then
    migrates and writes. If the snapshot fails, nothing is written.
  - **Unreadable shape** (items or collections not arrays): a clear error, and nothing is written.
- Imports accept `schemaVersion <= current`, migrating older ones, and refuse newer files.

### Import (`importLibrary(data, options)`)

- Records merge by id: the newer `updatedAt` wins, and on a tie the local copy is kept. Newer local edits therefore
  survive restoring an older backup.
- A record with a local tombstone at or after the file copy's `updatedAt` is not resurrected. A file copy edited after
  the deletion comes back and clears the tombstone.
- Imported items may point at collections already in the library. Dangling references and cross-file parent cycles are
  repaired: the item moves to the Inbox, or the collection moves to the top level.
- Imported subpages may sit inside items already in the library. A subpage whose parent is missing (not in the file or
  the library, skipped, or deleted here), a non-note with a parent, a page inside a loop (within the file or across
  the file and the library; an incoming page is lifted before a local one) or one nested over 32 levels moves to the
  top level with a new `updatedAt`. Seed data gets the same repair, keeping its stamps.
- `{ settings: true }` merges the file's settings key by key, with groups replaced whole. Secret-like keys are stripped
  from the file, and the device's own secret-like keys survive at every level. Without it, settings are untouched.
- The result is the library plus `importSummary: { items: { added, updated, kept, tombstoned }, collections: { ... },
  settings, skippedItemIds }`. The summary is not stored. A restore can use `skippedItemIds` to delete attachment blobs
  it saved for records that were not taken.

## Write path

- Pages never write the library themselves. They send `{ type: 'still:store', operation, args }` to the service worker,
  which runs every operation through one queue and writes the whole document with one `chrome.storage.local.set`. The
  preview build uses the Web Lock `still.library.v1` instead.
- Views follow changes through `storage.onChanged`.
- `createLibraryStore({ read, write, withLock, ready, onCommit, beforeMigration, migrations, schemaVersion })`:
  - `ready()` is awaited before every queued task. It is the worker's update-snapshot gate.
  - `exclusive(task)` runs a task alone in the queue. Snapshot restore uses it.
  - `onCommit({ operation, changed: { items, collections, settings }, deleted: { items, collections }, updatedAt })`
    runs after each successful write. Its errors are logged and never fail the write.

## Snapshots (device-local automatic backups)

`lib/storage/snapshots.js` keeps snapshots in IndexedDB `still.snapshots.v1`, on this device only.

- **Content:** every `still.` key in chrome.storage.local except caches and bookkeeping (`still.widget-cache.v1`,
  `still.ui.recent.v1`, `still.meta.v1`, `still.threadkeeper.v1`, plus the localStorage caches in the preview build).
  IndexedDB (attachments, AI chat data) is not copied. Secrets are included,
  because snapshots never leave the device and are never exported. Attachment blobs are not copied: they are only
  removed by an explicit delete forever or empty Trash.
- **Record:** `{ id, reason, createdAt, extensionVersion, previousVersion?, counts: { items, collections, notes, boards,
  conversations }, bytes, data }`. The summary and the data are stored apart, so listing snapshots never loads the data.
  The counts leave out trashed items.
- **When snapshots are taken:**

  | Reason | Trigger |
  | --- | --- |
  | `update` | On worker start, when the manifest version differs from `still.meta.v1.lastVersion`, or on the first run of a build with snapshots over existing data. Taken before any library operation is served (the store waits on this gate). `runtime.onInstalled`'s `previousVersion` is added to the record. Downgrades count too. |
  | `daily` | Alarm `still:snapshot-daily` (every 1440 min). Taken only if data changed since the last snapshot: `onCommit` and storage changes to other Still keys set `still.meta.v1.changedAt`. |
  | `before-migration` | The library store's migration hook. |
  | `before-restore` | Inside every restore, before anything is replaced. |
  | `manual`, `before-import` | Requested by pages, for example Settings, or a backup restore just before it writes. |

- **Retention:** the newest 30 are kept. The newest 5 `update`/`before-migration` and the newest 3 `before-restore`
  snapshots are never pruned, so up to 38 can exist.
- **Restore(id):**
  1. Runs inside the library write queue, holding the Web Locks of the dashboard, AI, conversation and API-key stores
     (`still.dashboard.v1`, `still.ai.v2`, `still.ai.conversations`, `still.ai.secrets.v1`; it waits at most 5 s for
     each, then carries on without it).
  2. Takes a `before-restore` snapshot first. If that fails, nothing is restored.
  3. Writes the snapshot's keys, then removes current `still.` keys that the snapshot lacks (caches and meta excepted).
  4. Views follow through `storage.onChanged`, so no view needs to be open.
  5. An older library schema in the snapshot is migrated on the next operation.
- **Page API:** `listSnapshots()`, `createSnapshot(reason = 'manual')`, `restoreSnapshot(id)` returns
  `{ restored: true, safetySnapshotId }`, and `deleteSnapshot(id)` returns `{ deleted }`. Pages message the worker
  (`{ type: 'still:snapshots', op, args }`). The preview build runs the same service in the page.
- Uninstalling the extension, or clearing its site data, deletes snapshots along with everything else. Users should
  keep a downloaded full backup somewhere else.

## Device metadata (`still.meta.v1`)

- `deviceId` is a random UUID created once per install. `getDeviceId()` returns it.
- `installedAt` records when this install began.
- `lastVersion` is the last extension version that ran.
- `lastSnapshotAt` and `changedAt` decide whether the daily snapshot is due.

Writes use the Web Lock `still.meta.v1`, and unknown keys are kept.

## Other stores

- **Dashboard (`still.dashboard.v1`, version 1):** `{ version, activeBoardId, boards: [{ id, name, icon, widgets: [{ id,
  type, x, y, w, h, title, style, config }] }], prefs, updatedAt }`. Widget data such as kanban boards and quick links
  lives in `widget.config`.
- **AI (`still.ai.v2`, version 2):** connections, settings, overlays and model cache. API keys are in `still.ai.secrets.v1`.
  Four settings are device-only: `assistantPermissions` (`{ create, organize, edit, dashboard, delete }`, each `'ask'` or
  `'allow'`, all `'ask'` by default; `lib/ai/permissions.js`), `research` (`{ enabled, connectionId, github, depth,
  maxSubpages, budgetUsd, allowOriginalEdits }`; `lib/ai/research/settings.js`), `browser` (`{ enabled, mode, sites,
  maxSteps }`: off by default, `mode` `'ask'` or `'auto'`, `sites` a map of at most 500 sites to `'allow'`, `'ask'` or
  `'block'`, `maxSteps` 10 to 200 with 60 by default; `lib/browser/settings.js`) and `webSearch` (`{ enabled, maxUses }`:
  off by default, `maxUses` 1 to 10 with 5 by default; `lib/ai/web-search.js`). A site key is a host as the address bar
  shows it, lower case, without `www.`, with its port when that is not the default. Reads normalize all four whatever
  was stored, and writes refuse values outside their ranges. `exportAiConfig` leaves them out and `importAiConfig` never
  applies them, so a crafted backup cannot turn on automatic assistant changes, let research edit originals or raise its
  cap, turn on browser automation, allow writes on a site or turn on web search.
  Deleting a connection that research was set to use resets `research.connectionId` to automatic.
- **Conversations:** an index (version 2) plus one body key per conversation. Caps: 300 conversations, 400 messages,
  200k characters per message, 4 MB per conversation.
  - An assistant message that worked in browser tabs carries `browser: { activity: [{ step, kind, text }],
    unverified?: [text] }`: the ledger of what it did (at most 60 lines of 400 characters; `kind` is `read`, `action`,
    `write`, `visit`, `handover`, `declined`, `blocked` or `merged`; a failed call keeps its kind and names the error code) and the steps it could not confirm (at most 20). The next turn of the conversation reads the ledger,
    and the panel shows the unconfirmed steps. Both are text Still wrote; page fragments in them are quoted.
  - An assistant message whose provider searched the web carries `webSources: [{ url, title }]` (at most 40, `http` and
    `https` addresses only). A message that read a web page, a web search result or an AI thread has
    `usedThreads: true`; such an answer is shown without loading remote images, also after a reload.
  - A research conversation has `kind: 'research'` and a run record `research: { itemId, sessionId, agentId,
    agentVersion, connectionId, status ('starting' | 'running' | 'waiting' | 'done' | 'stopped' | 'failed'), reason?,
    error, errorCode?, startedAt, finishedAt, ownerId, heartbeatAt, allowOriginalEdits, settings: { depth, maxSubpages,
    github, budgetUsd }, handled: { <eventId>: resultText }, undo: { itemId, sectionText, sectionHeader?,
    originalField?, originalText?, originalWritten?, subpageIds }, pages: [{ id, title, parent }], writes, usage?,
    stopRequestedAt?, budgetStopped?, undoneAt?, undoResult? }`. `handled` keeps the newest 300 tool results (about 1M characters), so a
    replayed tool call is answered without writing twice. `usage` is `{ costUsd, currency, inputTokens, outputTokens,
    cacheReadTokens, webSearches, activeSeconds }`.
  - Its assistant messages carry `research: { live, steps: [{ id, kind, label, detail?, url?, state, at }], subpages,
    writes, sessionId, baseline, sent, messageIds, request: { kind, text }, preview? }`. A repeated search or page read
    shares one step. Steps are capped at 200 per message: past that, the oldest finished steps (never writes or
    subpages) fold into one `collapsed` row ("N earlier steps") with a `count`.
  - The index summary of a research conversation keeps `kind` and `research: { status, itemId }`, so the history list
    can mark it and a new run can find a run already researching the same item.
  - These are plain data. Older builds keep them as unknown fields.
- These stores follow the same rules as the library: keep unknown keys, never write over a newer version, and serialise
  writes across views with a Web Lock (`still.dashboard.v1`, `still.ai.v2`, `still.ai.secrets.v1`,
  `still.ai.conversations`). Version gates:
  - Dashboard: a stored `version` above 1 is shown read-only; every write throws `code: 'newer_version'`.
  - AI state: a missing key is migrated from the legacy preferences or started blank. Any other value that is not
    `version: 2` (a newer version, an unreadable value) is used as a blank in-memory state and never written over.
    A stored secrets value that is not a plain object reads as no keys and is never written over.
  - Conversations: an index `version` above 2 is readable, but saves, deletes and imports throw `newer_version`.

## Export

`lib/portability.js` builds every export file and brings files back in.

- **Full backup (`backupVersion: 2`)**, one JSON file. The download is exactly `serializeBackup(backup).text`, and the
  size limit (200 MB) is measured on that string.

  ```
  { backupVersion: 2, schemaVersion, exportedAt,
    manifest: { app: 'still', extensionVersion, deviceId?, counts: { items, collections, notes, attachments, boards,
      conversations, aiConnections, chats }, warnings: [text] },
    items, collections, settings, tombstones?, updatedAt,   // the library, secret-like settings stripped
    dashboard?,                                            // portableDashboard: secret-like keys stripped
    attachments: [{ id, name, mime, data: 'data:<mime>;base64,…', ref?: 'wallpaper' }],
    conversations?: { version: 2, conversations },         // conversations.js exportAll
    aiConfig?: { version: 2, settings, connections },      // connections.js exportAiConfig: no keys or bridge auth
    chats?: { version: 1, records, transcripts } }         // still.chats.v1 rows of the library's chat items
  ```

  - The wallpaper image (`settings.wallpaper.attachmentId`) travels as an attachment marked `ref: 'wallpaper'`.
  - Items keep `parentId` and the captured page details. A subpage whose parent page is not in the file moves to the
    top level, with a warning. A malformed `parentId` makes an import fail before anything is written.
  - Tombstones are included in the file, but an import ignores them (a future sync engine will apply them).
  - Export never fails because of one bad record. Unrestorable fields are repaired, unrestorable records and missing
    attachment blobs are left out, and each of these adds a line to `manifest.warnings`. Files are added wallpaper
    first, then smallest first, while the file stays under the limit; the rest are left out with a warning.
  - AI chats: the summary records of the library's chat items always come first (smallest first, at most half the
    limit). Transcripts are added after the files, smallest first, chosen by their stored size without loading them
    all, so they are the first thing left out when the file runs out of room (with a warning; Threadkeeper can send
    them again). `manifest.counts.chats` counts the chat items.
  - It never contains API keys, account or integration tokens, the Threadkeeper pairing, snapshots or caches.
- **Other formats:** bookmarks as Netscape HTML, notes as Markdown, items as CSV (`url, title, tags, note, excerpt, type,
  collection, created, updated, site, author, published, language`; cells that start with `= + - @` get a leading
  apostrophe) and assistant chats as Markdown.
  - The CSV has no item ids, so subpages export and import as flat rows. Page icons are not a CSV column.
  - Chats: a CSV row carries the original conversation's link and comes back in as a bookmark (a chat row without a
    link is skipped, like a file); bookmark HTML leaves chats out; the notes Markdown includes a chat only when it has
    the user's notes, under an "AI chat · provider · project" line and the original link.
  - The notes Markdown puts each subpage section right after its parent page (depth first) under a "Subpage of" line
    linking to the parent's section, and turns page blocks into `- [Title](#section)` links (the page's title when it is
    not in the file). Lines inside code fences are left as written.
- **Restore** accepts `backupVersion` 1 or 2 with `schemaVersion <= current`, plus bookmark HTML and CSV:
  1. The whole file is checked before anything is written. A newer or invalid version is refused.
  2. A `before-import` snapshot is taken. If it fails, the import stops and nothing is written.
  3. Files are saved. Bytes already on this device (the item's own file, or the current wallpaper) are reused, so
     restoring the same backup twice stores no second copy.
  4. The library merges through `importLibrary(data, { settings })`, so newer local edits and tombstones are respected.
     Settings are restored for any JSON backup (version 1 or 2), never for HTML or CSV.
  5. Files saved for records the merge did not take (`importSummary.skippedItemIds`) are deleted again.
  6. AI chat data (`chats` part, checked before the snapshot: every record and transcript must belong to a chat item in
     the file, ids must match their thread, roles and sizes are bounded) is written for the chat items the merge took;
     a record older (by `seq`) than this device's is skipped, and this device's transcript of the same revision stays
     when the file left it out. A backup without the part restores its chats without summaries or transcripts.
  7. The dashboard, assistant chats (`importAll`) and AI connections (`importAiConfig`) follow. A failure in one of them, such as
     `newer_version`, becomes a warning. Undo data in imported chat proposals is dropped: restored chats show their
     proposals without Undo. A research conversation's run record (`conversation.research`, including its `undo`
     record) is restored as it was saved. Device-only AI settings are never restored.

## Sync plan (not built yet)

The pieces are in place so that an online database can be added behind an adapter without changing the stores:

1. **Change feed:** `createLibraryStore({ onCommit })` reports the changed and deleted item and collection ids, and
   whether settings changed, for every committed write. A sync engine queues these as outgoing deltas. Today the worker
   uses the hook only to mark snapshots as due.
2. **Identity:** `deviceId` (`still.meta.v1`) marks the origin of each change. Record ids are global UUIDs, except seed
   ids, which are identical on every install. The sync engine must treat seed records as local-only until the user
   edits them, or re-key them.
3. **Conflict rule:** last writer wins per record by `updatedAt`, the same rule import uses, with ties going to the
   local copy. Unknown fields are carried through. Clock skew is bounded by clamping future stamps to now on the way in.
4. **Deletions:** tombstones (`kind`, `id`, `deletedAt`) are uploaded so other devices delete too, and a remote record
   older than a local tombstone is never resurrected. Derived clean-up of backlinks is re-done by each device when it
   applies a tombstone.
5. **Adapter boundary:** the sync engine talks to the library only through store operations (`importLibrary` for
   incoming records, `onCommit` for outgoing ones) and keeps its cursor in its own key, for example
   `still.sync.v1`. Secrets, device-only keys and snapshots never sync.
6. **Not yet covered:** dashboard boards and widgets have only a document-level `updatedAt`. Collection order is the
   array position (subpages need no order key: siblings sort by `createdAt`, then `id`). Library settings have no
   per-key stamps. Each needs per-record stamps or order keys before it can sync record by record.
