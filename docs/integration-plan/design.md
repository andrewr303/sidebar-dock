# Implementation design: Threadkeeper ⇄ Still (Sidebar Dock) integration

Read this whole file before you start; then read the protocol contract (`docs/threadkeeper-integration.md` in
sidebar-dock, `docs/sidebar-dock-integration.md` in threadkeeper; identical text). The protocol is fixed: implement it
exactly, and if you find a real defect in it, implement the smallest compatible fix and report it in your final message
(do not silently diverge).

Codebase maps (read the ones for your area; they cite file:line):
`/tmp/claude-0/-home-user/d6f09056-d3f2-52cc-95e4-14934adda9a1/scratchpad/maps/` — `sd-data.md`, `sd-runtime.md`,
`sd-ui-items.md`, `sd-settings.md`, `sd-ai-tools.md`, `sd-ai-context.md`, `tk-data-pipeline.md`, `tk-search.md`,
`tk-ai-ui.md`. Research: `.../scratchpad/research/` (`paperclip.md`, `ai-landscape.md`, `tk-capture-arch.md`,
`selectors-*.md`).

## 0. What the user asked for (verbatim intent)

- Threadkeeper (TK) and Still / Sidebar Dock (SD) stay **separate extensions**; SD must keep working if TK crashes,
  is disabled or uninstalled. The integration is mostly TK → SD.
- The user **approves the integration in SD settings** and sets preferences there.
- A new SD library item type **`chat`** (next to notes and links) lives in collections. Every AI thread can be viewed in
  SD "essentially as pages/notes, but slightly different".
- A chat page has **multiple views**: (1) **Transcript**: the full chat with bubbles, recreating the conversation
  faithfully; (2) **Summary**: an in-depth summary that looks exactly like an existing SD note page, holding TK's
  analysis ("What this thread is about", goal, status, topics, mentions, artifacts, where you left off, decisions,
  action items / next steps, open questions) — with **better AI summaries and nicer styling** than TK produces today.
- TK keeps working on its own (semantic search etc.), and lets the user have **AI pull the conversations they want
  into collections**.
- SD's AI assistant must be able to use **all** thread information as context (not only imported chats), using
  decision (routing) models + embeddings + reranking, and use threads **directly** ("find all AI threads about X",
  "all coding agent sessions about refactoring", "pull them into a collection").
- (TK only) Paperclip integration and broad AI-product coverage are separate workstreams with their own briefs.

## 1. Shared conventions

- Protocol constant `still-threadkeeper/1`; both sides have their own copy of the validators (SD is plain JS, TK is TS).
- Message indexes are 0-based; UI shows `m{index+1}`.
- **Chat item id** (SD library id for a TK thread) is deterministic: `chatItemId(threadKey) = 'chat_tk_' + threadHash(threadKey)`
  where `threadHash` = 32 lowercase hex chars from two independent 64-bit FNV-1a hashes (BigInt; seeds
  `0xcbf29ce484222325n` over the UTF-8 bytes of `threadKey`, and the same over `'still:' + threadKey`), concatenated.
  It is sync and pure; both repos' tests assert the shared vectors listed in §7 (`protocol.ts`). **Citation id** for a thread that is not (yet) in the library: `'tk:' + threadHash(threadKey).slice(0, 16)`.
  Both match `/^[\w:.-]{1,200}$/` (SD's `validId` and citation regex).
- Wording in SD UI: the item type label is **"Chat"**, the nav entry **"Chats"**, the settings card "AI threads
  (Threadkeeper)". (SD already uses "chats" for assistant conversations in Settings → backup rows; keep those as they
  are and say "AI chats" where ambiguity matters.)
- No new runtime dependencies in either repo. SD stays build-free plain ES modules.
- Every new user-visible string is plain, calm and specific (match each app's existing voice).

## 2. Sidebar Dock (Still) — data

### 2.1 Library item of type `chat` (compact: ~1 KB)

`extension/lib/store.js`:
- `ITEM_TYPES` gains `'chat'` (also `lib/ai/tools.js:16`, `lib/portability.js:33` TYPES, `bridge/protocol.mjs` filter
  enums only — never in `create_item` / `update_item`). `'chat'` stays out of `CONVERT_TYPES`, `LINK_TYPES`, `NEEDS_URL`.
- `ITEM_FIELDS` gains `'chat'`. Add `CHAT_FIELDS` + `normalizeChat(value, type, stored)` following `normalizeSticky`
  (type gate → null for non-chat, bounded fields, `keepUnknown`), and a partial-patch merge like `stickyPatch`.
- Shape of `item.chat` (all strings trimmed & capped; arrays deduped & capped):
  ```js
  chat: {
    v: 1, source: 'threadkeeper',
    threadKey,            // ≤ 600 chars, required (normalizeItem throws "A chat needs its Threadkeeper thread." if missing)
    provider,             // ≤ 40, [a-z0-9_]
    providerLabel,        // ≤ 80
    category,             // 'chat'|'coding_agent'|'agent'|'builder'|'search'|'companion' (else 'chat')
    agentLabel,           // ≤ 120
    kind, kindLabel,      // ≤ 40 / ≤ 60
    project,              // ≤ 200 (TK project name)
    model,                // ≤ 120
    workflowState,        // TK workflow state or ''
    messageCount,         // int ≥ 0
    startedAt, lastActivityAt,   // ISO or ''
    topics,               // ≤ 8 strings ≤ 40
    analysis: { source: 'ai'|'local'|'', modelLabel /*≤80*/, generatedAt /*ISO|''*/ },
    workspacePath,        // ≤ 400
    gitBranch,            // ≤ 160
    fingerprint,          // ≤ 128
    revision,             // int ≥ 0
    hasTranscript, transcriptTruncated,   // booleans
    origin,               // 'sync'|'manual'|'assistant'|'import'
    syncedAt,             // ISO
    syncedTitle, syncedExcerpt,   // what sync last wrote (≤ 300 / ≤ 400): detects user renames/edits
    autoCollectionId,     // collection sync last placed it in ('' = Inbox)
    removed,              // ''|'deleted'|'out_of_scope'|'local_only'
  }
  ```
- Item fields for a chat: `title` (≤ 300 when written by sync), `url: ''` (**never** the provider URL: `saveItem` dedupes
  non-notes by canonical URL), `sourceUrl` = https original thread URL or '', `excerpt` = gist (≤ 300), `siteName` =
  providerLabel, `content` = the **user's own notes** (never written by sync), `articleContent: ''`, `tags` (user-owned;
  topics added only on create when the pref `topicsAsTags` is on), `collectionId`.
- Type transitions into or out of `'chat'` are refused in `normalizeItem` when `existing.type` is set and differs
  ("Chats cannot be converted."). `saveItem` refuses `type: 'chat'` ("Chats come from Threadkeeper.") — chats are
  created only by `upsertChats` and by imports/restores (`stored: true`).
- Chats can be **parents** of note subpages (the user's own notes inside a chat). They are never subpages.
- Do **not** bump `LIBRARY_SCHEMA_VERSION`.

### 2.2 New store operations (one write each)

```js
upsertChats(entries, { revive = false } = {}) → {
  results: [{ threadKey, id, status: 'created'|'updated'|'unchanged'|'skipped', reason? }],
  collections: [{ key, id, created: boolean }],
}
```
- `entries` ≤ 100. Entry: `{ id, threadKey, fingerprint, item: { title, excerpt, sourceUrl, siteName }, chat: {...},
  placement: { collectionId? , collectionKey? }, tags?: string[], origin, revive?: boolean }` plus an optional
  top-level `ensureCollections: [{ key, name, parentKey?, parentId?, icon?, color? }]` passed as
  `upsertChats(entries, { revive, ensureCollections })`. Ensured collections are matched **by name under the same
  parent** (case-insensitive, trimmed, live only) before creating one; `collectionKey` resolves to the ensured id.
- Rules, applied to the latest stored record inside the queue:
  - Unknown id + tombstone for that id → `skipped/dismissed` unless `revive` (entry or option); revive clears the tombstone.
  - Unknown id → create (type chat, `chat.origin`, `autoCollectionId` = resolved collection, `syncedTitle/Excerpt`).
    A collection id that no longer exists falls back to the Inbox.
  - Existing chat in Trash → update only `chat` metadata (keep `removed`), result `skipped/trashed`.
  - Existing chat: `title` only if `existing.title === existing.chat.syncedTitle`; `excerpt` only if
    `existing.excerpt === existing.chat.syncedExcerpt`; `collectionId` only if `existing.collectionId ===
    existing.chat.autoCollectionId` (the user has not moved it) **and** a placement was given; never touch `content`,
    `tags`, `favorite`, `archived`, `relatedIds`, `parentId`. Always refresh `chat` (and `sourceUrl`, `siteName`).
    A cleared `removed` flag is set back to `''` on any upsert.
  - Same fingerprint and nothing else differs → `unchanged`; no write at all when every entry is unchanged/skipped.
- Bump `updatedAt` on changed records (the search/indexer caches key on it).

```js
markChatsRemoved(entries /* [{ id, reason }] */, { trash = false } = {}) → { results: [{ id, status: 'removed'|'kept'|'missing' }] }
```
- Sets `chat.removed = reason`. `trash: true` also sets `deletedAt` (normal Trash semantics). Reason `local_only`
  additionally clears `excerpt` (if it equals `syncedExcerpt`) — the worker deletes the IDB data.

- Chat data cleanup is centralized: in the extension every library write runs in the worker, so the worker's store
  `onCommit` handler calls `deleteChatData(deleted.items)` for every hard-deleted item id (deleting unknown ids is a
  no-op). No UI caller of `permanentlyDeleteItem`/`emptyTrash` changes. The orphan sweep (§2.3) covers anything missed.
- "The user deleted this chat forever" is the library **tombstone** for its deterministic id: `upsertChats` skips
  tombstoned ids unless `revive` (manual sends and imports revive). There is no separate dismissed list.

### 2.3 Chat data store (IndexedDB `still.chats.v1`)

New module `extension/lib/chat-data.js` (modelled on `openAttachmentDb` / `idbSnapshotBackend`; injectable
`indexedDB`; memory fallback when IndexedDB is missing, so Node tests and the preview work):
```js
export const CHAT_DB = 'still.chats.v1';
export function createChatDataStore({ indexedDB } = {}) → { put, get, getTranscript, delete: del, ids, stats, clear }
// singleton helpers bound to globalThis.indexedDB:
export async function putChatData(id, { thread, transcript })   // thread = sanitized ThreadPayload without transcript.messages
export async function getChatRecord(id)      → { id, threadKey, fingerprint, revision, storedAt, thread } | null
export async function getChatTranscript(id)  → { id, threadKey, revision, truncated, totalMessages, messages, storedAt } | null
export async function deleteChatData(ids)    → number deleted
export async function listChatDataIds()      → string[]
export async function chatDataStats()        → { chats, transcripts, bytes }
```
- Two object stores: `records` (keyPath `id`) and `transcripts` (keyPath `id`). Version 1, guarded upgrades,
  `onversionchange` closes, `onblocked` gives a clear error.
- A `put` with `transcript: null` keeps the existing transcript **only if** its `revision` equals the new record's
  revision; otherwise deletes it (stale transcript must not pair with a newer summary).
- Not in snapshots (IndexedDB), not in chrome.storage. Full backups: §2.5.
- Orphan sweep `sweepChatData(library)`: deletes rows whose id is neither a library item (Trash counts) nor
  tombstoned... deleted only if absent from items AND not referenced; run from the worker on startup (after the
  startup gate) and on the daily snapshot alarm.

### 2.4 Device-only integration state `still.threadkeeper.v1` (chrome.storage.local; localStorage in preview)

Owned by `extension/lib/threadkeeper/state.js` (Web Lock `still.threadkeeper.v1`; add it to snapshot
`RESTORE_LOCKS`; keep the key in snapshots; never in backups — `createFullBackup` does not read it):
```js
{
  version: 1,
  extensionId: '',                 // paired / pending Threadkeeper id (32 chars a-p)
  status: 'off'|'pending'|'paired'|'denied'|'revoked',
  pending: null | { requestId, extensionId, at },
  tk: { version: '', capabilities: [] },
  pairedAt: '', lastSeenAt: '', lastSyncAt: '', lastError: '' , lastErrorAt: '',
  counts: { created: 0, updated: 0, removed: 0 },   // lifetime, informational
  prefs: {
    scope: 'all'|'projects'|'manual',           // default 'all' (the user wants every thread)
    projects: [],                               // TK project names (≤ 200)
    providers: [],                              // [] = all
    transcripts: true,
    autoUpdate: true,
    placement: 'mirror'|'single'|'inbox',       // default 'mirror'
    parentName: 'AI chats',                     // mirror: parent collection name (created on first use)
    singleCollectionId: '',                     // placement 'single'
    matchExisting: true,                        // mirror: reuse a top-level collection whose name equals the project
    topicsAsTags: false,
    onRemoved: 'keep'|'trash',                  // default 'keep'
    defaultView: 'summary'|'transcript',        // default 'summary'
    assistant: { search: true, context: 'auto'|'always'|'off', decision: true },  // default search on, context auto, decision on
  },
  collections: { },                // mirror memory: { [projectNameLower]: collectionId } and { __parent: id }
}
```
`normalizeThreadkeeperState(raw)` fills defaults and coerces every field; `patchPrefs(prefs, patch)` allowlists and
validates (throws a user-facing error on bad input). Both pure and exported for tests. Write it only through
`state.js` helpers under the Web Lock (worker and settings page both write it).

### 2.5 Backups / portability (`lib/portability.js`)

- `TYPES` gains `'chat'`; `checkItem` gains a `checkChat` (strict on import, repairs on export) and the
  "chat needs threadKey" rule; CSV import maps `type: chat` rows to excluded like `file`; HTML bookmarks skip chats
  (no `url`); notes Markdown export includes chat items that have `content` (user notes).
- Full backup gains an optional part `chats: { version: 1, records: [...], transcripts: [...] }` from
  `chat-data.js`, budgeted like attachments (smallest first, leave out with a `manifest.warnings` line when over
  the 200 MB limit; transcripts are the first thing to drop), `manifest.counts.chats`. Restore validates the part
  before the snapshot, then writes records/transcripts only for chat items the merge took (`skippedItemIds`).
  Older backups without the part restore fine (chats then show "Transcript not on this device — refresh from
  Threadkeeper").
- `docs/data-model.md` documents the new item type, `chat` shape, `still.chats.v1`, `still.threadkeeper.v1`, ops.

## 3. Sidebar Dock — Threadkeeper link (worker + page client)

### 3.1 Modules

- `extension/lib/threadkeeper/protocol.js` (pure, shared by worker/pages/tests):
  `PROTO`, `MESSAGE_TYPES_IN` (from TK), `MESSAGE_TYPES_OUT`, `envelope(type, fields)`, `isEnvelope(msg)`,
  `threadHash(threadKey)`, `chatItemId(threadKey)`, `threadCiteId(threadKey)`, `isExtensionId(id)` (`/^[a-p]{32}$/`),
  `sanitizeThreadPayload(raw)` → payload or throws (every field coerced/capped per protocol; transcript messages
  validated: role allowlist, content ≤ 120k chars, ≤ 4000 messages), `sanitizeThreadSummary(raw)`,
  `ThreadkeeperError` (`code`, `message`), `errorFromResponse(res)`.
- `extension/lib/threadkeeper/state.js` (above).
- `extension/lib/threadkeeper/placement.js` (pure): `planPlacement(payloads, prefs, library, memory)` →
  `{ ensureCollections, byThreadKey: { collectionId?|collectionKey? } }`. Mirror: parent `prefs.parentName` (top
  level; reuse memory id if still live, else match by name, else ensure), child = TK project name under it (or, with
  `matchExisting`, a live top-level collection with the same name), 'Unfiled / Uncertain' → the parent itself.
  Single: `singleCollectionId` if live, else Inbox. Inbox: ''. Manual target (`{ collectionId }` or
  `{ collectionName }`) wins for origin `manual`/`assistant`.
- `extension/lib/threadkeeper/worker.js` (service worker only; `configureThreadkeeperWorker(deps)` injected with
  `{ store, chatData, state, send, now, alarms, notify }` so tests can fake them):
  - `handleExternalMessage(message, sender)` → response object (never throws). Enforces: envelope + proto; sender
    id **and** `sender.url`/`origin` = `chrome-extension://<id>/`; unpaired senders may only use `hello`,
    `pair.granted`/`pair.denied` (and those only from the pending id with matching requestId); per-sender serial
    queue; payload size check (`JSON.stringify(message).length` ≤ 6 MB → else `too_large`).
  - Handlers: `hello`, `pair.granted` (store pairing, `lastSeenAt`, then `sync.configure` with prefs), `pair.denied`,
    `pair.revoke` (status `revoked`, keep chats), `threads.upsert` (sanitize each → placement → `putChatData`
    (transcript first) → `upsertChats` → on library failure delete the just-written chat data of created ids →
    results; tombstoned (deleted-forever) chats are skipped unless origin `manual`), `threads.remove` (reason `local_only`: delete chat
    data + `markChatsRemoved(trash: true)`; otherwise per `prefs.onRemoved`), `collections.list`, `chats.status`.
  - Outbound: `send(type, fields, { timeoutMs })` via `chrome.runtime.sendMessage(extensionId, envelope)`; maps
    `lastError`/timeouts to `{ ok:false, error:{ code:'unreachable' } }`; updates `lastSeenAt` on success.
  - Page proxy `handleThreadkeeperRequest(op, args)` for worker message type `still:threadkeeper`, ops:
    `state`, `connect` ({ extensionId }), `disconnect` ({ removeChats }), `setPrefs` (patch → `sync.configure`),
    `syncNow` (`sync.resync`), `request` ({ type, fields, timeoutMs } — only the read types
    `threads.search|threads.list|threads.get|threads.context|threads.related|facets|thread.open|sync.status`),
    `importThreads` ({ threadKeys ≤ 200, target, origin }) → `threads.get` with `transcript:'full', track:true` in
    batches of 20 → same apply path as `threads.upsert` with origin `manual`/`assistant` (revive tombstones)
    → `{ results }`, `refreshChat` ({ id }) → re-fetch one thread, `loadTranscriptWindow`
    ({ id, from, count }).
  - Store `onCommit` (already wired in background.js for snapshots): also `deleteChatData(deleted.items)`.
  - Alarms: `still:threadkeeper:retry` (backoff for a failed `sync.configure` after pairing), and a daily
    `still:threadkeeper:sweep` (orphan sweep + `hello` liveness). Never block startup; wait for the startup gate.
- `extension/lib/threadkeeper/client.js` (pages; preview-safe — no `chrome` at import time):
  ```js
  getThreadkeeperState()            → public state (a copy)
  onThreadkeeperChange(fn)          → unsubscribe   (storage.onChanged on the key; localStorage 'storage' in preview)
  discoverThreadkeeper()            → [{ id, name, version, enabled }]   // chrome.management.getAll(); caller must have
                                       // requested the optional 'management' permission in the click handler; removes it after
  connectThreadkeeper(extensionId)  → { status }
  disconnectThreadkeeper({ removeChats = false })
  setThreadkeeperPrefs(patch)       → state
  syncThreadkeeperNow()             → { queued }
  threadkeeperRequest(type, fields = {}, { timeoutMs, signal } = {}) → data   // throws ThreadkeeperError
  importThreadkeeperThreads(threadKeys, { target, origin = 'manual' }) → { results }
  refreshChat(id), loadTranscriptWindow(id, from, count)
  isThreadkeeperReady(state)        → boolean  (status 'paired')
  ```
  In the preview build (no extension) every call resolves to a calm "unavailable" state / throws
  `ThreadkeeperError('unavailable', 'Threadkeeper works when Still runs as an extension.')`.
- `extension/background.js`: import the worker module; `api.runtime.onMessageExternal?.addListener(...)` registered
  synchronously next to `onMessage` with the same `respond` envelope pattern (`return true`); add `'still:threadkeeper'`
  to `MESSAGE_TYPES` + a branch in `handleMessage`; alarm branch before the reminder branch; startup hook (after the
  gate) for sweep + `hello`; header doc updated.
- `extension/manifest.json`: `"management"` in `optional_permissions`; `scripts/check.mjs` allowlist +
  `tests/foundation-appearance.test.mjs` expectation updated.

## 4. Sidebar Dock — chat UI

New `extension/ui/chats.js` (registered in `app.js` modules) and `extension/styles/chats.css` (linked before
`skins.css` in **both** `index.html` and `newtab.html`; glass-skin lists in `skins.css` extended).

- **Hosts.** (a) `renderDetail` branch: `if (item.type === 'chat') return renderChatPage(ctx, item, { surface })` —
  side panel and the full-tab right panel. (b) Full-tab main view **`chats`** modelled on the Notes workspace:
  list pane (chats, newest activity first, filter by provider/category chips and collection, search box) + the chat
  page + optional rail; wire every touchpoint listed in `maps/sd-ui-items.md §3` (routes `MAIN_VIEWS`, `renderMain`,
  `viewTitle`, `NON_ITEM_VIEWS`, `itemsForView`, `VIEW_META`, `EMPTY`, sidebar `goToView`, `navigate`,
  `app.open-full`, `syncUrl` item for view `chats`, panel→page conversion). Opening a chat from any library list in
  the full tab opens it in the `chats` workspace (like notes open in the notes workspace); "Open in a new tab" from the
  side panel goes to `index.html?libraryView=chats&item=<id>`.
- **Chat page** (note-page look: `.ne` shell classes, `ne-head` crumbs/title/meta, `ne-foot`):
  - Toolbar: segmented **Summary | Transcript** (`chat.view`; remembers the last choice per user via prefs, default
    from `prefs.defaultView`), Ask about this chat (`detail.ask`), Open original (`sourceUrl`), Open in Threadkeeper
    (`thread.open`, only when paired), Refresh from Threadkeeper (only when paired), ⋯ menu (move to collection,
    tags, add subpage note, copy summary as Markdown, save summary as a note (creates a note subpage with the
    summary Markdown, then opens it), copy resume command (CLI threads), move to Trash).
  - Head: crumbs (collection path), title (`<h1 class="ne-title">`, editable inline like notes is optional — at least
    rename via menu), meta row: provider badge (icon + label; coding agents get a terminal glyph), agentLabel,
    project, kind, status pill, message count, last activity, "Analyzed by <model> · <relative>" or "On-device
    analysis", collection picker, tags editor (reuse detail actions keyed by `data-id`).
  - **Summary view**: `renderMarkdown(buildChatSummaryMarkdown(record, item))` inside `.markdown-body` in the note
    column, interactive tasks off. Then a **"Your notes"** block that edits `item.content` exactly like the detail
    panel's personal note (reuse that editor/markup), then Subpages, then "Linked from".
    Clicking a `#msg-N` link switches to Transcript and scrolls to / flashes message N.
  - **Transcript view**: bubbles. User: right-aligned accent-tinted bubble, text with `white-space: pre-wrap`
    (escaped; no markdown). Assistant: left, provider avatar mark + label, `renderMarkdown(normalizeLlmMarkdown(text))`
    (`####`→`###`, `+ `→`- `, `1) `→`1. `; pure + tested; never `compact`, never `citations`). Tool messages:
    collapsed `<details>` chips ("Tool · Read src/x.ts" first line), system: small centred notice. Each message has
    `id="msg-${index}"`, a hover `m{n}` label + timestamp, copy button. Long messages (> 6000 chars) collapse with
    "Show more". Render in pages of 150 from the end ("Show earlier messages"), mount with `data-morph="skip"` keyed
    `chat:${id}:${revision}`. Find-in-chat input (highlights matches, ↑/↓ to step, count). Truncated transcripts show a
    notice with "Load the full conversation from Threadkeeper" (window requests) when paired. No transcript stored →
    calm empty state ("This chat's transcript is not on this device" + Refresh when paired).
  - Images in assistant markdown render only if already allowed by `renderMarkdown` (remote image lines). Keep it.
  - All data via `getChatRecord(id)` / `getChatTranscript(id)` (async; cache per `id:fingerprint` in a module Map;
    loading skeleton; morph-safe).
- **`extension/lib/threadkeeper/summary.js`** (pure, shared with the assistant): `buildChatSummaryMarkdown(record,
  item)` → Markdown using only SD's supported blocks (h2/h3, paragraphs, `- ` lists, `- [ ]` tasks, quotes, callouts
  using SD's existing callout syntax, tables). Sections, each only when it has content:
  1. `## What this thread is about` — gist as the lead paragraph, then the `overview` paragraphs (or legacy `summary`
     when it differs from the gist).
  2. An "at a glance" table or definition-style lines: **Goal**, **Outcome**, **Status** (statusReason + workflow).
  3. `## Key points` — keyPoints with ` [m3](#msg-2)` refs (small, at line end).
  4. `## Where you left off` — callout (note/info kind) with the text + refs, then **Next step:** nextStep.
  5. `## Decisions` — "You decided" vs "Suggested" (speaker), text — rationale, refs.
  6. `## Next steps` — task list `- [ ] text` with refs (actionItems).
  7. `## Open questions` — list with refs.
  8. `## What was produced` — artifacts: **label** — description (kind), ref.
  9. `## Context` — Topics as inline `#topic` words (or chips text), Mentions (entities), Project, Provider/agent,
     Model, Workspace + branch (code), resume command in a code block, Captured/updated dates.
  Refs: `[m${i+1}](#msg-${i})`. Never emit raw HTML. Escape Markdown-significant characters in untrusted text where
  needed (pure helper, tested). Older TK analyses without overview/keyPoints still render well.
- Lists/cards: `TYPE_LABELS.chat = 'Chat'`, `TYPE_ICONS.chat = 'messages-square'`, `TYPE_HUES` entry,
  `itemSource` → providerLabel, `indicators()` message count + coding-agent badge, `is-chat` class, `noteCard`-style
  card that previews the gist; `ITEM_VIEW_TYPES`, `TYPE_CHIPS`, `VIEW_META`, `EMPTY`, shell `TYPE_FILTERS`,
  `viewTitle`, command palette `go-chats` + provider in `itemOption`, map `TYPE_FILTERS`/`KIND`,
  `library-views.js` chat count, search-syntax help text. Sidebar `FILTERS`: `{ view: 'chats', label: 'Chats', icon:
  'messages-square', count: c => c.byType.chat }` right after Notes (hidden at zero unless paired — add a
  `threadkeeperPaired` flag to `navCounts`).
- `ui/selectors.js` `searchRows` haystack includes `chat.providerLabel`, `chat.project`, `chat.topics`,
  `chat.agentLabel` for chat items.

## 5. Sidebar Dock — assistant (tools + automatic thread context)

Adapter, wired like the dashboard adapter (`index.js:50`, `init({ …, threads })`, getter per turn); `app.js` passes
it at init. It is **null unless** state is `paired`, capability `search` is present and `prefs.assistant.search`:
```js
threads = {
  search({ query, filters, limit, rerank, signal }) → { results: ThreadSummary[], total, withheld, semantic, reranked }
  get({ threadKeys, transcript, window, signal })    → { threads: ThreadPayload[], missing }
  context({ question, filters, limit, budgetChars, signal }) → { threads: [{ thread, passages }], withheld, semantic, reranked }
  facets({ signal })
  importThreads(threadKeys, { target, origin: 'assistant' }) → { results }
  localChatFor(threadKey) → library chat item | null     // dedupe: prefer the library copy
  readLocal(itemId) → Promise<{ record, transcript } | null>
  prefs() → { context, decision }
}
```
- **Read tools** (in `LIBRARY_TOOLS`, gated by a `THREAD_TOOLS` set like `DASHBOARD_TOOLS`; flat schemas per
  `maps/sd-ai-tools.md §4`):
  - `search_ai_threads` { query, source (enum all|chat|coding_agent|agent|builder|search|companion), provider
    (string), kind (enum of TK kinds + ''), project (string), status (enum), since, until (ISO strings), limit
    (integer, clamp 1..50, default 12), rerank (boolean) } → compact rows `{ id, threadKey, title, provider,
    agent, kind, project, updatedAt, messageCount, gist, snippet ≤ 220, score, inLibrary: itemId|null }`. `id` is
    the library chat id when imported, else `tk:` cite id. Register every row in `session.sources` so `[[id]]`
    citations resolve.
  - `get_ai_threads` { ids (array ≤ 10: chat item ids, `tk:` ids, or threadKeys), detail (enum summary|transcript|both,
    default summary), query (string, focuses the transcript on matching passages), offset (integer) } → per thread:
    summary Markdown (built with `buildChatSummaryMarkdown`) + transcript slice within a 60k total budget, `truncated`,
    `missing`. Falls back to the local copy (`readLocal`) for imported chats when TK is unreachable.
  - Also: `get_items` on chat items returns the summary (via `readLocal`) in its `article` slot.
- **Write tool** `import_ai_threads` { ids (array ≤ 200), collectionId (existing id, '' Inbox, or `new:<name>` with
  `create_collection` in the same step), tags (array) } — description ends with `${PROPOSE}`; permission category
  `create`; card rows "Import N chats to <collection>"; excludable per chat; apply calls
  `threads.importThreads(..., { target: { collectionId } })` then records `undo.createdItems` for created chats (not
  for already-present ones, which become a `move_items` op when the collection differs) — wire every registry in
  `maps/sd-ai-tools.md §2`.
- **Automatic context** (`gatherContext`, library and collection scopes; never in item/page scopes unless the
  question clearly asks about threads):
  1. Decision: `decideThreadContext(question, { prefs, fastModel })` → `{ use: boolean, query, filters }`. `'off'` →
     no; `'always'` → yes with the question as query; `'auto'` → regex prefilter (chat|thread|conversation|session|
     discussed|asked|told|claude|chatgpt|gemini|grok|codex|copilot|cursor|agent|prompt|we decided|last time…)
     → yes; clearly unrelated short questions → no; otherwise, when `prefs.decision` and a quick target exists whose
     `via` is `direct`, a fast-model call (Haiku-class, effort low, `maxTokens` ≥ 1000, 2.5 s budget) returns
     `{ "needsThreads": bool, "query": string, "filters": {...} }` parsed with `extractJson` + validation; any failure
     → fall back to the prefilter answer. Memoize per turn. Pure parts exported and tested.
  2. Retrieval: `threads.context({ question: query, filters, limit: 5, budgetChars: min(24000, left/3) })` with
     `AbortSignal.any([signal, AbortSignal.timeout(2500)])`, in parallel with `searchLibrary`. TK runs lexical +
     its embedding space + its reranker (`rerank: 'auto'`). On timeout/error continue silently.
  3. Fusion: drop threads already present as library chat items in the gathered sources; add the rest as sources
     `{ id: 'tk:…', kind: 'ai_thread', title, provider, project, updatedAt, gist, passages: [{ m, role, text }] }`;
     update `payload.note` wording; register in `known` so citations resolve; emit a `{ type: 'sources' }`-style early
     event or otherwise make streaming citations of `tk:` ids render (`ai-panel.js` four resolver spots); clicking a
     `tk:` citation opens the imported chat if present, otherwise offers "Import to Still" / "Open in Threadkeeper".
  4. Status line while waiting: "Checking your AI threads".
- Prompts (`ai-prompts.js`): thread tools guidance only when offered; citation rule for `tk:` ids; "imported" verb in
  the applied-results rule; bump `ASSISTANT_PROMPT_VERSION` and its test/doc; never write non-tool snake_case words.
- Settings → AI or the Threadkeeper card exposes `prefs.assistant` (Assistant can search AI threads; Automatic thread
  context: Smart / Always / Off; Use a fast model to decide) — implemented by the settings workstream via
  `setThreadkeeperPrefs`.
- `docs/ai-prompts.md` updated.

## 6. Sidebar Dock — settings and picker

`extension/ui/settings/threadkeeper.js`: `renderThreadkeeper(ctx, { where })`, `attachThreadkeeper(ctx)`,
`detachThreadkeeper()`, actions `settings.threadkeeper-*`. Placed in Integrations as group "AI chat threads" (id
`settings-threadkeeper-group`) above "Built in"; card anchor `settings-threadkeeper`; catalog keywords
(threadkeeper threads chats transcripts chatgpt claude gemini coding agent sessions paperclip — not `github`);
alias `threadkeeper → integrations`; `MARKS.threadkeeper`; command palette entry; About › where data lives row; backup
row copy mentions AI chats.
- States (pure exported `threadkeeperStatus(state, probe)` → `{ label, tone, icon }`): Not connected · Looking for
  Threadkeeper… · Waiting for you to allow it in Threadkeeper · Connected (Threadkeeper x.y) · Not responding (your
  chats stay available) · Denied in Threadkeeper · Disconnected.
- **Connect**: `requestAccess({ permissions: ['management'] })` synchronously in the click → `discoverThreadkeeper()`
  → 0 found: callout "Threadkeeper isn't installed or is turned off" + manual ID form; 1 found: `connectThreadkeeper`;
  several: radio list. Manual ID form (validates `/^[a-p]{32}$/`, explains where to copy it in Threadkeeper →
  Settings → Sidebar Dock). While pending: callout explaining the Threadkeeper window, with "Open again" (re-send) and
  "Cancel".
- **Preferences** (only when paired; each saves immediately through `setThreadkeeperPrefs`, toast on error):
  What to sync (segmented: Every thread / Threads from projects I choose / Only threads I add) + project checklist
  from `facets` (disclosure, counts); Providers checklist (optional); Where chats go (Mirror Threadkeeper projects
  inside "<parentName>" (editable name) / One collection (collection picker) / Inbox) + "Use my existing collection
  when the name matches"; Include full transcripts; Keep chats up to date; When a thread leaves Threadkeeper (Keep the
  chat / Move it to Trash); Add topics as tags; Open chats in (Summary / Transcript); Assistant: Let the assistant
  search my AI threads; Automatic thread context (Smart / Always / Off); Use a fast model to decide.
- **Sync now** (progress via storage changes / counts), last sync time, counts of chats in Still, last error.
- **Disconnect** (confirm; checkbox "Also remove the synced chats" → Trash).
- Privacy note: what Threadkeeper shares (never local-only threads), that Still stores copies on this device, that
  the assistant may send thread text to the AI provider chosen in Still when answering.
- **Add AI chats picker** (dialog, `extension/ui/threadkeeper-picker.js`): opened from the card ("Add chats…"), the
  Chats view header, the command palette ("Add AI chats from Threadkeeper") and Quick add's menu (not a type option).
  Search box (debounced `threads.search`; empty → `threads.list` recent), filter chips (source category, provider,
  project, kind), result rows with checkbox + provider mark + title + gist + project + date + "In Still" badge,
  select all in view, target collection picker (existing / new name / Inbox), Import button with progress →
  `importThreadkeeperThreads(keys, { target, origin: 'manual' })` → toast with "Open". Works in side panel and full tab.

## 7. Threadkeeper — Still link ("dock")

New folder `src/core/dock/`:
- `protocol.ts` — types (`ThreadSummary`, `ThreadPayload`, `SyncPrefs`, envelope, error codes), constants, zod or
  hand validators for every incoming SD message, `threadHash` (same algorithm as SD). Shared test vectors — both
  repos' tests must assert exactly these literals:
  `threadHash('chatgpt:acct_chatgpt_primary:ws_personal:abc:main') === 'a8165e07c2949d16a9c49f5c0e061c8a'`,
  `threadHash('claude_code:acct_claude_code_primary:ws_personal:5f0c-ü/x y:main') === 'ec30122ef1e1608ee0a26be36b1ad12a'`
  (FNV-1a 64: offset `0xcbf29ce484222325n`, prime `0x100000001b3n`, over UTF-8 bytes, masked to 64 bits, 16 hex
  zero-padded; second half hashes `'still:' + threadKey`).
- `state.ts` — pairing state in `SettingsRecord.sidebarDock` (nested merge in `normalizeSettings`):
  `{ pairedId: '', pairedName: '', pairedAt: '', allowSearch: true, shareTranscripts: true, prefs: SyncPrefs (defaults
  scope 'manual' until configured), lastPushAt: '', lastError: '', lastErrorAt: '' }`; pending request + recent denials
  in `chrome.storage.session` key `tk.dock.pending.v1` (fallback in-memory).
- `payload.ts` — `buildThreadSummary(conv, insight, extras)`, `buildThreadPayload(db, settings, threadKey, { transcript:
  'none'|'full'|'window', window })` (see `maps/tk-data-pipeline.md §2`: getSmartTitle, resolveInsight, summary,
  providerLabel/category, analysis mapping incl. new fields, transcript budget per protocol), `fingerprintOf(...)`.
- `outbox.ts` — Dexie **v3**: `dockOutbox: 'threadKey, notBefore'` (one coalescing row `{ threadKey, op:
  'upsert'|'remove', reason?, notBefore, attempts, lastError, leaseUntil }`) and `dockSent: 'threadKey'` (`{ threadKey,
  fingerprint, sentAt, tracked: boolean }`). `markDockDirty(db, keys)`, `reconcileDock(db, settings)` (scope/tracked
  → enqueue upserts whose fingerprint differs, removes for sent threads now deleted/out of scope/not remote-allowed),
  `drainDock(db, settings, send)` (batches ≤ 20 / ~4 MB, re-check privacy at send time, backoff 1/5/30/120 min, lease,
  `not_paired` → unpair, `unreachable` → keep). Do **not** use the `jobs` table.
- `query.ts` — core retrieval extracted from `App.tsx` search and `AskPanel.retrieve` (leave the UI code working;
  optionally switch the UI to call these): `searchThreads(db, settings, { query, filters, limit, rerank, excerpts })`,
  `listThreads(db, settings, { filters, sort, cursor, limit })`, `threadContext(db, settings, { question, filters,
  limit, budgetChars, semantic, rerank })` (passages keep ordinals; user/assistant roles only), `relatedThreads`,
  `facets`. Filters: providers, categories (from the provider registry), kinds (via resolveInsight), projects,
  states, since/until, threadKeys. Always excludes synthetic and non-remote-allowed threads (report `withheld`).
  A service-worker cache of the search index invalidated by Dexie `storagemutated` (or a cheap revision check).
- `external.ts` — `handleExternalMessage(message, sender)` (never throws; sender id + `chrome-extension://<id>/` origin;
  type allowlist; unpaired: `hello`, `pair.request` only; consent flow & rate limits per protocol; logs rejections to
  `securityRejectionLog`), and outbound `sendToDock(type, fields, { timeoutMs })`.
- Hooks: `markDockDirty` + a kick after `organizeStoredThread`, after each analysis job completes (`runAnalysisJobs`
  progress / post-job), in page-context write sites (send internal `DOCK_SYNC_NOW` → background drains), on delete;
  reconcile every 15 min (alarm `tk-dock-reconcile`), drain alarm `tk-dock-drain` (one-shot, 30 s floor, plus an
  in-SW `setTimeout` for snappier pushes while awake).
- `background.ts`: separate `chrome.runtime.onMessageExternal.addListener` (registered synchronously, `return true`);
  internal types `DOCK_SYNC_NOW`, `DOCK_GET_STATE`, `DOCK_PENDING`, `DOCK_DECIDE` (`{ requestId, allow }` from the
  consent page), `DOCK_UNPAIR`, `DOCK_SEND` (`{ threadKeys, target }` from Send to Still), `DOCK_COLLECTIONS`
  (proxy `collections.list`), `DOCK_STATUS_FOR` (proxy `chats.status`) — added to `PrivilegedCommandType`,
  `PRIVILEGED_TYPES`, and the manager-origin regex extended to `connect.html` (keep `.html.evil` rejected).
- Consent page `connect.html` (`src/entrypoints/connect/main.tsx` + small CSS; built by `build-extension.mjs`; not
  web-accessible): shows the pending request (self-declared name, id, time), what will be shared, the warning, Allow /
  Deny; closes itself after a decision; handles "no pending request" / expired gracefully. Opened by the worker with
  `chrome.windows.create({ url, type: 'popup', width: 480, height: 640 })` (fallback `tabs.create`).
- TK manager UI: Settings section **"Sidebar Dock"** (status, paired id/name/since, what Still asked to sync (read-only
  readout of prefs), toggles "Let Still search my threads" (allowSearch) and "Share full transcripts", Resync, Disconnect,
  "This Threadkeeper's ID" with Copy (for manual pairing), pending request Allow/Deny inline too); bulk action **Send to
  Still…** (collection picker from `DOCK_COLLECTIONS`, else "Still's default placement") and a detail-row button
  "Send to Still"; an "In Still · <collection>" badge in the thread detail (via `DOCK_STATUS_FOR`, cached).
- Docs: `docs/sidebar-dock-integration.md` (protocol) + README section + architecture note.

## 8. Threadkeeper — better summaries (analysis v2)

Per `maps/tk-ai-ui.md §2-4`:
- `ThreadAnalysisSchema` additions (all fields present; no zod min/max): `overview: string[]` (2-4 paragraphs),
  `keyPoints: EvidenceItem[]`, `produced: [{ label, kind, description, messageNumber|null }]`,
  `whereYouLeftOff.nextStep: string|null`, `rationale: string|null` on evidence items. Prompt rules: write about the
  work, not the conversation; ignore process turns ("continue", "stop asking for permission") unless they changed the
  outcome; never start with "The user"/"The assistant" (use "You" for the user where a subject is needed); gist ≤ 22
  words = subject + result; overview must not restate the gist; where-you-left-off is past-tense state, the next step
  is one imperative for the user; prefer concrete nouns (files, numbers, names); decisions carry rationale.
- `ANALYSIS_VERSION = 2` on AI insights; new optional fields on `ThreadInsight` (`overview`, `produced`,
  `analysisVersion`) and `ExtensionSummaryOutput` (`keyPoints`, `nextStep`); grounding: keyPoints go through
  `sanitizeSummaryForGrounding` and `checkItems`; `db.ts` summaryRecord copies them; `insight.summary =
  overview.join(' ')` (clamped) for legacy readers; `clean()` must keep paragraph breaks for overview.
- Analysis effort at least `medium`; transcript budget raised (≈ 160k chars, keep head + newest, mark the gap);
  `estimateAnalysisCostUsd` updated. No automatic re-analysis of v1 records; Settings → AI models gets "Upgrade older
  summaries" (count + cost estimate + confirm) that enqueues analysis for AI insights with `analysisVersion < 2`.
- Local analyzer: produce `overview` (1 paragraph) and better gist wording where cheap; keep it fast.
- `ThreadOverview` + App focal sections: overview paragraphs, key points list, produced list (label — description, ref),
  decisions with rationale, next step line, chips as `<ul>` with hidden separators, evidence markers with visually
  hidden text separators, "Copy summary" (Markdown from data via a new pure `buildSummaryMarkdown` in
  `src/core/summary-markdown.ts`, also used by Markdown handoff). Update test fixtures (`ANALYSIS`).

## 9. Testing & definition of done (every workstream)

- Add focused tests for everything new (pure helpers, store ops, validators, handlers incl. spoofed senders and
  malformed payloads, UI rendering via string/`fake-dom` assertions, tools via the existing harnesses).
- SD: run the test files you touched plus related ones (`node --test tests/<file>.test.mjs`), then
  `node scripts/check.mjs`. Before finishing, run the full suite once: `node --test tests/*.test.mjs` (the baseline
  has exactly 1 known failing test; you must not add failures — report the failing test names).
- TK: `npm run typecheck`, `npx vitest run <files>`, then `npm run check` once at the end.
- Update docs for what you built (SD README + docs/*.md; TK README + docs/architecture.md) — concise, accurate, no
  claims you did not verify.
- Commit in your worktree branch with clear messages (several commits are fine). Do not push. Never commit
  `node_modules` (it may be a symlink in your worktree) or `.output/`.
- Final message: what you built (files), contract deviations, test results (exact counts), anything left undone.
