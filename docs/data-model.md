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
| `still.ai.v2` | `lib/ai/connections.js` | AI connections (non-secret fields), AI settings, overlays, model cache | yes | non-secret part | bridge auth |
| `still.ai.secrets.v1` | `lib/ai/secrets.js` | `{ <connectionId>: { apiKey, updatedAt } }` | yes | **never** | **yes** |
| `still.ai.conversations.v2` | `lib/ai/conversations.js` | Conversation index `{ version: 2, migratedLegacy, items: [summary] }` | yes | yes | no |
| `still.ai.conversation.v2:<id>` | `lib/ai/conversations.js` | One conversation body (messages) | yes | yes | no |
| `still.accounts.v1` | `lib/accounts.js` | Connected accounts (GitHub, Linear, Product Hunt tokens; calendar feed URLs) | yes | **never** | **yes** |
| `still.integrations.v1` | `lib/integrations.js` | Raindrop and local-bridge tokens, bridge URL and switches | yes | **never** | **yes** |
| `still.ai.preferences.v1`, `still.ai.chats.v1` | legacy | Read-only migration sources from older builds; never deleted | yes | no | no |
| `still.meta.v1` | `lib/storage/meta.js` | `{ deviceId, installedAt, lastVersion, lastSnapshotAt, changedAt }` | no (bookkeeping) | `deviceId` only, in the manifest | **yes** |
| `still.widget-cache.v1` | `lib/widget-cache.js` | Rebuildable widget data cache `{ <key>: { value, at } }` | no (cache) | no | yes |
| `still.ui.recent.v1` | `ui/prefs.js`, `background.js` | Recently used collections for the "Save to" menus | no (cache) | no | yes |

"Secret-like" means a key that matches `token|secret|password|passphrase|credential|bridge|integration|api[-_]?key|authorization|cookie`
(case-insensitive). Those keys never go into an export file. Imports never apply them, and the device keeps its own.

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

**Item:** `id ('item_<uuid>' or a fixed seed / import id), type ('bookmark' | 'article' | 'image' | 'video' | 'file' | 'note'),
title, url, excerpt, content (Markdown note), articleContent (<= 250k chars), tags[], collectionId ('' = Inbox), favorite,
archived, deletedAt (Trash), createdAt, updatedAt, cover, art, sourceUrl, highlights[{ id, text, note, color, createdAt, url }],
relatedIds[], reminderAt, reminderNotifiedAt, attachmentId, fileName, mime, size, pinned, read,
sticky ({ color, board, x, y, w, h, z, hidden } | null, notes only)`.

**Collection:** `id, name, color, icon, parentId ('' = top level), description, cover, pinned, layout, sidebarLayout,
createdAt, updatedAt, deletedAt? (only when set)`. Order is the array order.

### Ids and timestamps

- Ids are `<prefix>_<uuid>` (`item_`, `collection_`, `highlight_`, `file_`), plus fixed ids from the seed (`welcome`,
  `design`, ...) and from imports (`raindrop-<id>`).
- `updatedAt` is an ISO string that only moves forward per record: it is `max(now, previous + 1 ms)`.
- An edit bumps it, and so does an edit as a side effect (tag rename, collection deletion moving items to the Inbox,
  re-parenting children). The exception is derived backlink clean-up: when an item is deleted forever, other items lose
  it from `relatedIds` without a new stamp, so an editor open on them keeps a valid revision. `onCommit` still reports
  those items as changed.
- Seed, import and backup data keep their own `createdAt` and `updatedAt` when they parse. A future stamp, for example
  from another device's clock, is clamped to now.

### Never dropping data

- When this build edits a stored item, collection, highlight or sticky placement, it keeps every key it does not know
  (`keepUnknown` in `store.js`). A field written by a newer build, or by an older one, therefore survives. Keys that
  arrive only with a patch, such as UI transient props, are dropped. Prototype keys are never copied.
- Seeding and importing keep unknown keys from the file.
- Trash is a soft delete (`deletedAt`). Hard deletes (delete forever, empty Trash, delete collection) record a tombstone.
  Tombstones are capped at the newest 10,000, and one is removed when its id is created again.

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
  `still.ui.recent.v1`, `still.meta.v1`, plus the localStorage caches in the preview build). Secrets are included,
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
- **Conversations:** an index (version 2) plus one body key per conversation. Caps: 300 conversations, 400 messages,
  200k characters per message, 4 MB per conversation.
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
      conversations, aiConnections }, warnings: [text] },
    items, collections, settings, tombstones?, updatedAt,   // the library, secret-like settings stripped
    dashboard?,                                            // portableDashboard: secret-like keys stripped
    attachments: [{ id, name, mime, data: 'data:<mime>;base64,…', ref?: 'wallpaper' }],
    conversations?: { version: 2, conversations },         // conversations.js exportAll
    aiConfig?: { version: 2, settings, connections } }     // connections.js exportAiConfig: no keys or bridge auth
  ```

  - The wallpaper image (`settings.wallpaper.attachmentId`) travels as an attachment marked `ref: 'wallpaper'`.
  - Tombstones are included in the file, but an import ignores them (a future sync engine will apply them).
  - Export never fails because of one bad record. Unrestorable fields are repaired, unrestorable records and missing
    attachment blobs are left out, and each of these adds a line to `manifest.warnings`. Files are added wallpaper
    first, then smallest first, while the file stays under the limit; the rest are left out with a warning.
  - It never contains API keys, account or integration tokens, snapshots or caches.
- **Other formats:** bookmarks as Netscape HTML, notes as Markdown, items as CSV (`url, title, tags, note, excerpt, type,
  collection, created, updated`; cells that start with `= + - @` get a leading apostrophe) and assistant chats as
  Markdown.
- **Restore** accepts `backupVersion` 1 or 2 with `schemaVersion <= current`, plus bookmark HTML and CSV:
  1. The whole file is checked before anything is written. A newer or invalid version is refused.
  2. A `before-import` snapshot is taken. If it fails, the import stops and nothing is written.
  3. Files are saved. Bytes already on this device (the item's own file, or the current wallpaper) are reused, so
     restoring the same backup twice stores no second copy.
  4. The library merges through `importLibrary(data, { settings })`, so newer local edits and tombstones are respected.
     Settings are restored for any JSON backup (version 1 or 2), never for HTML or CSV.
  5. Files saved for records the merge did not take (`importSummary.skippedItemIds`) are deleted again.
  6. The dashboard, chats (`importAll`) and AI connections (`importAiConfig`) follow. A failure in one of them, such as
     `newer_version`, becomes a warning. Undo data in imported chat proposals is dropped: undo records from a file are
     never trusted.

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
   array position. Library settings have no per-key stamps. Each needs per-record stamps or order keys before it can
   sync record by record.
