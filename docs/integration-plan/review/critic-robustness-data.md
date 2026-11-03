**Design review: Still and Threadkeeper integration (robustness, data integrity, performance)**

Code facts I checked against the real files: store writes and commits (`store.js:741-743`, `commitChange` at `store.js:308-321`), snapshot restore deleting keys (`snapshots.js:188`), the 2 s bridge post of the whole library (`integrations.js:42-47`, `:202`, `:219`), TK capture rewriting `lastCapturedAt` (`db.ts:432`), TK's SW lifecycle (`background.ts:365-425`), and the note editor's conflict path.

### Ranked issues

**1. CRITICAL — The default "every thread" scope makes the whole-document library write path blow up**
- **Sections:** §2.4 `prefs.scope` default `'all'`; §2.2 / §3.1 `threads.upsert` (one `upsertChats` per message); §7 drain ("in-SW `setTimeout` for snappier pushes"); protocol batch limit of 20.
- **Scenario:**
  - At 10k threads a chat item is about 1.5–2 KB, because the `chat` object has about 35 keys and duplicates `syncedTitle`/`syncedExcerpt`. The library grows to about 15–20 MB.
  - Every write does several full clones, one `chrome.storage.local.set` of the whole document, and an `onChanged` broadcast of the whole document to every open view (side panel and every new tab).
  - It also marks snapshots dirty (up to 38 copies), and the bridge posts the full JSON plus a `loadLibrary` round trip every 2 s.
  - The first backfill is 500 such writes, so roughly 20–30 GB of copying. After that, each message the user sends on chatgpt.com produces a push, which rewrites the whole library again.
  - This also hits note editing: the conflict path in `note-editor.js` reloads the whole library over messaging.
- **Fix:** preferably go two-tier. Keep all threads only in `still.chats.v1` records (the Chats view lists from IndexedDB) and create library items only for imported or project-scoped threads. If `'all'` must stay, the design must also say all of the following:
  - Slim the item: replace `syncedTitle`/`syncedExcerpt` with 8-hex hashes, and move `workspacePath`, `gitBranch`, `analysis`, `model`, `agentLabel`, `kindLabel` and `startedAt` to the IndexedDB record.
  - Coalesce on the Still worker: buffer upsert entries across messages and flush one `upsertChats` at 100 entries, 2 s idle or 5 s max. Respond after the flush.
  - Raise the protocol batch to 100 for pushes without transcripts. Backfill metadata first and transcripts later, throttled.
  - In TK, set the per-thread `notBefore = lastChange + max(60 s, aiDebounceSeconds)` and drop the snappy `setTimeout`.
  - Add an acceptance test: a 10k fixture finishes backfill in ≤ 110 library writes.

**2. HIGH — `dockSent` is not tied to which Still library acknowledged it**
- **Sections:** §7 `outbox.ts` (`dockSent: 'threadKey'`); protocol "Delivery guarantees" and `pair.granted`.
- **Scenario:**
  - Still is reinstalled, from the same folder (same unpacked id, empty storage) or from a new folder (new id).
  - Or the user restores a Still snapshot or backup.
  - After re-pairing, `reconcileDock` finds every fingerprint equal to `dockSent` and pushes nothing. The Chats view stays empty or stale for good.
  - `tracked` flags are also stored in `dockSent` (the same table), so they survive into the new pairing.
- **Fix:**
  - Still state gains `epoch` (a uuid). It is regenerated on fresh state, on disconnect, on snapshot restore and on backup import, and sent in `pair.request`, `hello` and `sync.configure`.
  - TK stores `peerId` and `peerEpoch`. On any change it clears `dockSent`, keeps tracked keys in a separate Dexie v3 table `dockTracked`, and reseeds from a new Still message `chats.digest { cursor }` → `{ chats: { [threadKey]: { fingerprint, revision, hasTranscript } }, nextCursor }` (pages of 1000).
  - Do not use a blind `sync.resync`.

**3. HIGH — The orphan sweep races the apply path and keeps the wrong rows**
- **Sections:** §2.3 `sweepChatData` (the garbled "nor tombstoned… not referenced" rule); §3.1 apply order "putChatData (transcript first) → upsertChats"; §3.1 startup hook.
- **Scenario A:**
  - Startup in an MV3 service worker means every wake. A TK push wakes Still, and the sweep runs alongside the push.
  - The push writes the transcript to IndexedDB. The sweep reads the library (no item yet), sees the IndexedDB id and deletes it. Then `upsertChats` creates the item.
  - Later pushes are `unchanged`, so the transcript is never sent again.
- **Scenario B:**
  - The worker writes chat data before `upsertChats` returns `skipped/dismissed` (tombstone), or a page's `deleteChatData` races an in-flight push.
  - The row's id is tombstoned, and the sweep's rule keeps it. The transcript of a chat deleted forever stays on the device, and in backups, indefinitely.
- **Fix:**
  - Use one worker-wide `applyQueue` (a mutex) for `threads.upsert`, `threads.remove`, `importThreads`, `refreshChat`, `disconnect(removeChats)` and the sweep.
  - Inside it, decide each entry against a fresh library read before any IndexedDB write. Skip tombstoned, dismissed and trashed-for-`local_only` ids.
  - Sweep rule: delete rows whose id is not in `library.items` (Trash counts as present; tombstoned ids are deleted) and whose `storedAt` is older than 10 minutes.
  - Run the sweep (and `hello`) only from `onStartup`, `onInstalled` and the daily alarm, never at module evaluation.

**4. HIGH — No guard against stale writes, and several concurrent writers**
- **Sections:** §2.2 rules; §3.1 handlers (the per-sender queue and the page-proxy `importThreads`/`refreshChat` are separate paths); §7 `DOCK_SEND` and the coalescing outbox; protocol idempotency.
- **Scenario A:**
  - The drain pushes fingerprint f2 while `importThreads` (30 s `threads.get`) or a direct "Send to Still" applies an older f1 afterwards.
  - TK records f2 as acknowledged, so reconcile never repairs it. Still is stale for good.
- **Scenario B:** the ack of an in-flight push deletes the outbox row that `markDockDirty` re-dirtied meanwhile, so the update waits 15 minutes for reconcile.
- **Fix:**
  - `ThreadPayload.seq` is a TK-wide monotonic counter persisted in settings and assigned at build time.
  - Still stores `chat.seq` and the record's `seq`. `upsertChats`/`putChatData` treat `seq < stored` as `unchanged`, reason `stale`.
  - Results include the `fingerprint` Still now holds, and TK writes that value into `dockSent`.
  - In TK, every send (drain, `DOCK_SEND`, resync) goes through the outbox. Rows carry `dirtySeq`, and `markDockDirty` bumps it without touching the lease.
  - On ack, delete the row only if `dirtySeq` is unchanged (in an rw transaction). Add an in-memory drain mutex, because the alarm and the `setTimeout` can fire together.

**5. HIGH — `threads.get` responses have no size limit**
- **Sections:** protocol `threads.get` (≤ 20 keys, 3.5 MB transcript each); §3.1 `importThreads` (batches of 20, `transcript:'full'`).
- **Scenario:** 20 large Claude Code sessions make a response of about 70 MB. That breaks the 6 MB rule and Chrome's roughly 64 MiB limit, so the whole import batch fails as `unreachable`.
- **Fix:**
  - Protocol: every response is ≤ 4 MB of JSON.
  - `threads.get` packs threads in request order (always at least one) and returns the rest in `deferred: string[]`, which is separate from `missing`. Still loops on `deferred`.

**6. HIGH — Pairing state in snapshots, and `not_paired` handling**
- **Sections:** §2.4 ("add it to snapshot `RESTORE_LOCKS`; keep the key in snapshots"); protocol "`not_paired` → TK drops the pairing".
- **Scenario A:**
  - A restore removes every key the snapshot lacks (`snapshots.js:188`).
  - Restoring any snapshot older than the pairing (to recover a note, say) silently unpairs Still. TK then gets `not_paired`, drops the pairing, and the user must consent again.
- **Scenario B:** a snapshot taken while paired with an id the user later revoked restores that id as `paired`.
- **Scenario C:** Still never handles `not_paired` from TK. TK drops the pairing on a single transient `not_paired` (Still reading its state while `pending` during "Open again").
- **Fix:**
  - Add `still.threadkeeper.v1` to `SNAPSHOT_EXCLUDED_KEYS` (device bookkeeping) instead of `RESTORE_LOCKS`. After a restore, bump `epoch` (see issue 2).
  - Still answers `pending_approval` while re-pairing with the same id, and `not_paired` only for unknown senders.
  - When TK answers `not_paired`, Still sets status to `revoked`.
  - TK drops the pairing only on `pair.revoke`, or on `not_paired` seen twice at least 60 s apart.

**7. MEDIUM-HIGH — The fingerprint is undefined and transcripts are re-sent needlessly**
- **Sections:** protocol `fingerprint` ("changes whenever anything Still shows changes"); §7 `fingerprintOf`; §4 summary "Captured/updated dates".
- **Scenario:**
  - Still shows "Captured" from `lastCapturedAt`, which TK rewrites on every passive capture (`db.ts:432`), even with no content change. Each capture would then become a push and a library write.
  - Every metadata change (project move, analysis landing) re-sends up to 3.5 MB of transcript.
- **Fix:**
  - List the fingerprint inputs explicitly: `revision`, `contentHash`, title, gist, project, `workflowState`, tags, pinned, url, coverage, `analysis.{source, model, generatedAt, analysisVersion}`, transcript-sharing flag.
  - Never include `lastCapturedAt` or any `Date.now()`-derived value.
  - `dockSent` also stores `revision` and `transcriptRevision`. TK sends `included:false` when Still already has that revision.
  - Still's results carry `needsTranscript:true` when its copy is missing (after a sweep or restore).
  - The drain drops an upsert whose fingerprint equals `dockSent`.

**8. MEDIUM-HIGH — Automatic context can't meet its 2.5 s budget**
- **Sections:** §5 step 2 (`rerank:'auto'`, TK embedding space, 2.5 s); §7 `query.ts` cache invalidated by `storagemutated`.
- **Scenario:**
  - The reranker alone may take up to 8 s.
  - A cold TK service worker (idle-killed after about 30 s, which is typical between assistant turns) rebuilds the index from every message. At 10k threads that takes seconds.
  - `storagemutated` fires on every capture write, so the cache rarely stays warm.
  - Still aborts locally but TK keeps going, so each turn can pay for an embedding and a rerank call while the context never arrives.
- **Fix:**
  - Automatic context sends `semantic:'local', rerank:'off'` plus a new `deadlineMs` that TK honors by aborting remote calls.
  - TK picks candidates from persisted thread vectors and insights, and loads messages only for the top `limit` threads.
  - Invalidate the cache per `threadKey`/`sourceRevision`, not wholesale.
  - Acceptance target: cold p95 under 1.5 s on a 10k fixture.

**9. MEDIUM — Reconcile cost and the wake ping-pong**
- **Sections:** protocol and §7 ("reconcile… after Threadkeeper starts", every 15 min); §3.1 (Still `hello` in the startup hook).
- **Scenario:**
  - A reconcile reads 10k conversations, 20k insights and 10k summaries, roughly 50–150 MB, to build fingerprints.
  - If "starts" means service-worker start, it runs on every wake. TK's analysis alarms wake it every 3 minutes, and every Still wake (each new tab) sends `hello`, which wakes TK and triggers yet another full reconcile.
- **Fix:**
  - "Starts" means `onStartup`/`onInstalled` only. Persist `lastReconcileAt` and skip if it is less than 10 minutes old.
  - Compare a cheap digest from the conversation row (`sourceRevision`, `contentHash`, project, `workflowState`, `manualTitleOverride`, tags, pinned, `cloudExcluded`) plus a privacy check. Store it in `dockSent.cheapDigest`, and build the full fingerprint only on a mismatch.
  - Analysis landing is already hooked through `markDockDirty`.
  - Process with a persisted cursor and about 2 s of work per tick.

**10. MEDIUM — Removing a `local_only` thread leaves sensitive data, and a pending removal can be overwritten**
- **Sections:** §2.2 `markChatsRemoved` (clears only the excerpt); §7 coalescing row with `op`.
- **Scenario A:**
  - The item stays in Trash with its title, `chat.topics`, project, `workspacePath`, `gitBranch` and topic tags.
  - `publicSnapshot` includes trashed items, so these go to the bridge and MCP agents every 2 s, and also into backups and lexical search.
- **Scenario B:** a later capture's `markDockDirty` overwrites the pending `remove(local_only)` with `upsert`. The send-time check then just skips it, so the remove waits up to 15 minutes for reconcile while Still's assistant can still use the chat.
- **Fix:**
  - For `local_only`, strip `chat` down to `{ v, source, threadKey, origin, removed }`.
  - Set the title to "Private thread" when it equals the synced title, and remove sync-added tags (track `syncedTags`).
  - Exclude these chats from `publicSnapshot` and the assistant. Delete forever when there are no user notes or subpages.
  - In TK, a `remove` op is never downgraded to `upsert`. An upsert that fails the send-time check for a key in `dockSent` becomes `remove(local_only)` immediately.

**11. MEDIUM — The dismissed list and acknowledgement rules don't work as written**
- **Sections:** §3.1 ("onCommit sees deleted chat ids; keep a small id→threadKey lookup from the deleted record"); §2.4 `dismissed`; protocol results.
- **Scenario:**
  - `onCommit` receives only the deleted ids (`commitChange`), and `notify` has already replaced the cache. Chat ids are one-way hashes, so the threadKey can't be recovered.
  - The worker-level dismissed check also applies to existing items, so a chat brought back by a restore never updates again.
  - TK keeps pushing tracked threads that Still dismissed, forever.
  - An assistant import undo (`permanentlyDeleteItem`) dismisses the thread permanently.
  - Nothing defines which result statuses TK counts as delivered, so `skipped/invalid` and `skipped/too_large` retry forever.
- **Fix:**
  - Store `dismissed` as `chat_tk_` ids. Check it only for ids absent from `library.items`.
  - Protocol: `created`, `updated` and `unchanged`, and `skipped` with reason `dismissed`, `trashed` or `invalid`, all count as delivered.
  - On `too_large`, retry once without the transcript, then count it as delivered.
  - On `dismissed`, TK sets `tracked=false, dismissed=true` and does not push again until a manual send.
  - Undo of an import removes the chat without leaving a tombstone.

**12. MEDIUM — `revive` doesn't cover Trash (broken requirement)**
- **Sections:** §2.2 ("Existing chat in Trash → … skipped/trashed") versus the protocol ("creates chats even if the user had removed that chat before"); §3.1 `threads.upsert` with `origin:'manual'` never says to pass `revive`.
- **Scenario:** the user imports from the picker, or uses "Send to Still", on a chat that is in Trash. The result is "0 imported" and the chat stays in Trash.
- **Fix:**
  - With `revive` (origin `manual`/`assistant`), restore from Trash: clear `deletedAt` using `restoreItem` semantics, including subpages trashed with it, clear `removed`, and apply the target placement.
  - Pass `revive:true` for `threads.upsert` with `origin:'manual'`.

**13. MEDIUM — Still's preferences aren't enforced on receive, and scope changes trash curated chats**
- **Sections:** §3.1 `setPrefs` (`sync.configure` is retried only "after pairing"); §2.2 `markChatsRemoved` (`kept` is undefined).
- **Scenario A:** TK is asleep or disabled when the user turns transcripts off or narrows the scope. TK keeps the old prefs, and Still stores whatever arrives.
- **Scenario B:** with `onRemoved:'trash'`, narrowing the scope sends `out_of_scope`. That trashes chats the user moved, annotated or gave subpages; trashing a parent cascades to its subpages.
- **Fix:**
  - Keep `configDirty` and `configVersion` in state. Retry on the alarm and on any inbound TK message.
  - Still enforces its own prefs: with transcripts off, store none; skip `origin:'sync'` entries for unknown ids that fall outside the scope, projects or providers.
  - `markChatsRemoved` returns `kept` for `deleted`/`out_of_scope` when the chat has content, subpages, favorite, user tags, or `collectionId ≠ autoCollectionId`.

**14. MEDIUM — The sender check as written rejects real messages**
- **Sections:** protocol and §3.1/§7 (`sender.url` or `sender.origin` "starts with `chrome-extension://<id>/`").
- **Scenario:**
  - `sender.origin` never has a trailing slash. An implementation keyed on `origin` therefore rejects every message, and unit tests with hand-built senders won't catch it.
  - Separately, reusing `background.js`'s `respond({ ok, result })` wrapper (§3.1 says to use "the same `respond` envelope pattern") produces `{ ok, result: {...} }`, which TK cannot parse.
- **Fix:**
  - Accept the sender when `sender.url` starts with `chrome-extension://${id}/`, or when `sender.origin === 'chrome-extension://' + id`. Reject whenever `sender.tab` is set.
  - The external listener returns `handleExternalMessage`'s flat protocol envelope as is.

### Missing details an implementer needs
- **Backfill UX:** before the first push, show TK's `facets.total` with a size estimate, plus a progress indicator and a way to pause.
- **Pairing handshake:** TK counts itself paired only after Still acknowledges `pair.granted`. A failed `pair.granted` delivery leaves TK unpaired, with a clear state on both sides.
- **Peer back online:** an inbound `hello` from the paired Still resets TK's backoff and starts a drain. Still sends `hello` on `onStartup`/`onInstalled`; otherwise retries can lag by up to 120 minutes.
- **Startup gate:** the store's startup gate can take up to 20 s after an update, but the `threads.upsert` timeout is 10 s. Say that a timeout is retried and that the late-applied result is harmless.
- **`syncedTitle`/`syncedExcerpt`:** store them after the same normalization as `title`/`excerpt`, or the rename check never matches. `syncedAt` must not change on `unchanged` pushes, or nothing is ever "unchanged".
- **`hasTranscript`:** keep it in sync whenever the stored transcript is deleted (the revision rule, `local_only`, the sweep).
- **Page cache:** the per-page `id:fingerprint` Map can hold 3.5 MB transcripts. Make it an LRU (about 3 transcripts and 50 records).
- **Full backup:** pick transcripts by a stored per-row `bytes` value without loading them all. Export only rows whose id is a library chat item.
- **Worker state:** the worker reloads its in-memory pairing state on `storage.onChanged` for its key. Throttle writes of `lastSeenAt` and `counts` to about once a minute (each write broadcasts to every page and marks snapshots dirty).
- **Mirror memory:** the `__parent` sentinel collides with a TK project named "__parent". Use a separate field.
- **Tests:** a 10k-thread performance fixture on both sides, a TK v3 migration test, and race tests for: sweep during apply, import during push, disconnect during push, and an old `seq` arriving after a new one.