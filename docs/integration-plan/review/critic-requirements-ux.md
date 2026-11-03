**Design review: requirements coverage and UX (15 issues, most severe first)**

1. **Critical. §5 (adapter gating, "Also: get_items…", Automatic context steps 3–4) and §4 toolbar "Ask about this chat".**
   - **What goes wrong:**
     - **Ask about this chat:** this runs `gatherContext` with item scope, which uses `sourceRecord` (`assistant.js:31-43`). That function reads only `title`, `excerpt` and `content`. So the model gets the title, a 300-character gist and the user's notes, but no summary and no transcript. Connections without tools (bridge, CLI agents) have no way to get more.
     - **Library scope:** `searchLibrary` finds chat X by its title, and Threadkeeper (TK) returns X with passages. Step 3 then drops X's TK passages because X is "already present as a library chat item". With the default scope `all`, almost every thread is a library chat, so this happens on almost every question.
     - **Without TK:** `readLocal` and `localChatFor` live on the `threads` adapter. That adapter is null after Disconnect, after revoke, when TK turns off "Let Still search" or when `prefs.assistant.search` is off. Imported chats then become title-only to the assistant, which breaks "Still never needs TK…".
     - **Collection scope:** thread retrieval is not limited to the collection.
   - **Fix:**
     - Split the adapter in two. `chats` is always present in the extension and needs no TK: `readLocal`, `localChatFor`, `searchLocal`. `threads` stays TK-gated as now.
     - In `gatherContext`, for every chat item added in any scope, await `chats.readLocal(id)`. Put `buildChatSummaryMarkdown` into `article` (about 60% of the item budget). Put up to 3 user/assistant messages from the local transcript that match the question into `passages: [{m, role, text}]`.
     - Item or items scope on chats: also call `threads.context({question, filters:{threadKeys}})` when TK is available.
     - Collection scope: pass `filters.threadKeys` = the threadKeys of chats in that collection.
     - Fusion: never drop TK passages. When `chatItemId(threadKey)` is a library item, merge the passages into that source and cite it by the library id.

2. **High. §3.1 `pair.granted` handler, §2.4 defaults, §6 "Preferences (only when paired)".**
   - **What goes wrong:**
     - Allow in TK immediately sends `sync.configure {scope:'all', transcripts:true}`, with placement `mirror` and `matchExisting`. Before the user has seen a single preference, thousands of threads start arriving. An "AI chats" tree with one collection per project is created, or chats pour into same-named existing collections (TK starter areas such as "HypeStake").
     - Backing out (Disconnect, remove, Empty Trash) leaves tombstones that block re-sync (§2.2).
     - Progress shows lifetime counts only. Still never keeps the `queued` total.
   - **Fix:**
     - After `pair.granted`, set `status:'paired', configured:false` and send nothing. TK stays at `manual`.
     - The card shows a "Choose what to sync" step with:
       - `facets` totals, for example "Every thread: 2,931 in 18 projects".
       - A placement preview, for example "Creates "AI chats" with 18 collections" or "Adds 412 chats to your collection HypeStake".
       - A "Start syncing" button that sends `sync.configure` and stores `backfill:{ total: queued, startedAt }`.
     - Show progress as a determinate bar (created since `startedAt` / total) and add "Pause".

3. **High. §5 read tools (`ids`), §5 step 3 (`tk:` citation click), protocol `threads.get`.**
   - **What goes wrong:**
     - Turn 1, "find my coding-agent sessions about refactoring", cites `[[tk:9f…]]` rows. Turn 2, "pull them into a Refactors collection", starts a new tool session with empty `session.sources`. `historyMessages` replays only the answer text.
     - A `tk:` id is a 16-hex hash prefix and cannot be reversed. So `import_ai_threads` either fails or re-searches and imports a different set than the user saw.
     - Saved citations (`{n,id,title,url}`) have no threadKey, so "Import / Open in Threadkeeper" on an old citation cannot work after a reload.
   - **Fix:**
     - Add `citeIds?: string[]` to `threads.get` and to `filters`. TK keeps a cached `threadCiteId → threadKey` map.
     - Still resolves imported chats by prefix (`'chat_tk_' + h16`) and other threads through `threads.get({citeIds})`.
     - Store `threadKey` in thread citation records and in `proposalNote` lines.

4. **High. §5 Automatic context, steps 1–2.**
   - **What goes wrong:**
     - The decision call (up to 2.5 s) runs first, then `threads.context` with a 2.5 s timeout. That timeout must cover TK's remote query embedding and its reranker, whose own timeout is 8 s (`rerank.ts:53`).
     - After TK's service worker idles out (about 30 s), it also has to rebuild its search index from every message (tk-search §9).
     - Typical turns will time out silently, so the requirement "uses ALL thread info with embeddings and reranking" is not actually met. Ambiguous questions also wait up to about 5 s before the first token.
     - The protocol says 20 s for this call; the design says 2.5 s.
   - **Fix:**
     - At turn start, run `threads.context({semantic:'local', rerank:'off'})` (3 s) in parallel with the decision call and `searchLibrary`.
     - If the decision or a strong prefilter match says threads are needed, run `semantic:'auto', rerank:'auto'` with an 8 s budget under the status "Checking your AI threads", and use the better result.
     - Send `hello` to warm TK when the assistant panel opens.
     - After 3 failures in a row, skip TK for 5 minutes.
     - When thread context was wanted but missing, set `payload.note` to "AI threads were not available for this answer." and show a small notice.

5. **High. §2.2 `markChatsRemoved`, §3.1 `threads.remove`, §6 Disconnect "Also remove the synced chats", protocol `local_only`.**
   - **What goes wrong:**
     - A chat has user notes in `content` and two subpage notes. The thread moves into TK's local-only "Personal" project.
     - `markChatsRemoved(trash:true)` runs. Store cascade rule 3 (`store.js:402`) gives the subpages the same `deletedAt`, so the user's notes go to Trash silently.
     - The next Empty Trash, which is very likely after a mass removal or disconnect, destroys them.
     - The same happens with `onRemoved:'trash'` and when narrowing the scope (every thread outside the new scope gets `out_of_scope`).
   - **Fix:**
     - Define "user-touched": the chat has `content`, live subpages, tags, `favorite`, `collectionId ≠ autoCollectionId`, or `title ≠ syncedTitle`.
     - Never trash a user-touched chat. Set `removed`. For `local_only`, delete its chat data and clear `excerpt`, and keep the notes, subpages and a banner.
     - Disconnect-remove trashes only untouched chats and tells the user how many with notes stay.
     - Narrowing the scope asks for confirmation with the number of chats that will leave.

6. **High. §2.2 create, §2.4 `scope:'all'`, §4 lists.**
   - **What goes wrong:**
     - Every backfilled chat gets `createdAt = now()` (`store.js:154`), and "newest" sorts by `createdAt` (`selectors.js:258`). All items shows 3,000 chats above everything the user saved, and placement `inbox` makes the Inbox unusable.
     - Related items, the map, top-bar search and `recentCollections` (by `updatedAt`, `selectors.js:208`) fill up with chats. Every TK re-analysis bumps `updatedAt` again.
     - Each 20-thread batch rewrites and broadcasts a library growing toward about 3 MB, so about 150 full rewrites during backfill. The UI janks and the user's own saves wait in the same queue.
   - **Fix:**
     - Create chats with `createdAt = startedAt || lastActivityAt`.
     - All items, Inbox, related, map and `recentCollections` exclude chats that are still where sync placed them (`collectionId === autoCollectionId`), with a "+N AI chats" chip to include them.
     - The worker coalesces upserts into one `upsertChats` write per ≤100 entries or ≤2 s.
     - TK sends the next batch only after the ack plus 1 s.

7. **Medium. §2.4/§6 preferences, §7 `dockSent`.**
   - **What goes wrong:**
     - Switching from Mirror to One collection sends `sync.configure`. TK's reconcile sees equal fingerprints and queues nothing, so the existing chats never move.
     - Turning on "Include full transcripts" (or TK's "Share full transcripts") changes no fingerprint, so existing chats never get transcripts. Turning it off leaves the old ones in place.
   - **Fix:**
     - Still applies placement changes locally: a re-place op over chats with `collectionId === autoCollectionId`, after a confirm that shows the count.
     - TK stores a `prefsHash` (scope, providers, transcripts, `shareTranscripts`) in each `dockSent` row; a different hash re-queues the thread.
     - When transcripts are turned off, Still offers "Remove N stored transcripts?".

8. **Medium. Protocol pairing steps 2–6, §3.1, §2.4 `pending`.**
   - **What goes wrong:**
     - Capabilities arrive only in `pair.granted`, and `hello` does not return them. If TK later turns off search, Still keeps offering tools that fail with `disabled`. If TK turns it back on, the tools never return.
     - `pair.granted` is sent once. If Still's worker is in its startup gate (up to 20 s) and TK's 10 s send times out, TK thinks it is paired while Still stays `pending` forever, because Still has no expiry.
     - "Open again" then gets `{status:'paired'}` with no capabilities.
   - **Fix:**
     - `hello` and `pair.request` responses carry `tk:{version, capabilities}`.
     - TK sends `hello` whenever one of its toggles changes. Still refreshes capabilities on every `hello` and on any `disabled` error.
     - TK retries `pair.granted` until Still answers ok.
     - Still treats `status:'paired'` as granted.
     - Still's pending request expires after 10 minutes with "The request expired — try again".

9. **Medium. §5 `search_ai_threads`, §4 Chats view search, protocol principle "never needs TK to … search".**
   - **What goes wrong:**
     - When TK is off, `search_ai_threads` is still offered (status is still `paired`) and every call errors, with no fallback.
     - The Chats view search, `search.js` `fieldTexts` and `indexer.js` `itemIndexText` only see the title, gist and notes. A chat titled "Stripe help" about webhooks cannot be found by "webhook", online or offline.
   - **Fix:**
     - Add `searchChats(query, filters, limit)` to `chat-data.js`: token scoring over record gist, overview, key points, topics, entities and project, plus transcript text.
     - `search_ai_threads` falls back to it with the note "searched the chats saved in Still". The Chats view search uses it too.
     - The indexer gets an async `extraText(item)` hook that adds a ≤4k digest for chats and puts provider, project and kind in the header.

10. **Medium. §5 `search_ai_threads`, protocol `threads.search`.**
    - **What goes wrong:**
      - For "find all coding-agent sessions about refactoring", `limit` is at most 50 and there is no offset or cursor. With 140 real matches the model sees 50.
      - Hybrid search always fills k, so with 12 real matches the model sees 50 rows including weak neighbours, and it may import them.
    - **Fix:**
      - Add `cursor`/`nextCursor` to `threads.search` and `offset` to the tool.
      - Mark each row `match:'strong'|'weak'`: strong means a lexical, title or summary hit, or a rerank score ≥ 0.5.
      - The tool description says: for "all …" requests, page until `total` and import only strong matches.

11. **Medium. §2.2 "no separate dismissed list", §5 import undo, protocol (no untrack).**
    - **What goes wrong:**
      - Undo of an assistant import calls `permanentlyDeleteItem`, which leaves a tombstone. TK keeps those threads tracked and pushing, and Still answers `skipped/dismissed` forever. Under scope `all` those threads never appear again.
      - Deleting a manually added chat forever never tells TK.
      - Tombstones are capped at 10,000 (`store.js:9`) and shared with the whole library. Emptying a Trash full of chats evicts older tombstones, so dismissed chats and user-deleted items can come back.
    - **Fix:**
      - Keep an uncapped `dismissed` store (threadKey → time) in chat-data IndexedDB.
      - Undo of an import deletes chats without dismissing them.
      - Add `threads.untrack {threadKeys}` (Still → TK), sent on delete-forever and on undo.

12. **Medium. §3.1 disconnect and `pair.revoke`, §7 outbox.**
    - **What goes wrong:**
      - After Disconnect with "Also remove synced chats", a later Connect does nothing useful. TK's `dockSent` still matches every fingerprint, so reconcile queues nothing, and any re-push gets `skipped/trashed`. The Chats view stays empty until the user restores thousands of items from Trash by hand.
      - What TK does on unpair (outbox, `dockSent`, `tracked`, prefs) is not specified.
    - **Fix:**
      - On any unpair (either side, or a `not_paired` answer), TK clears its outbox, `dockSent`, tracked list and stored prefs.
      - Still marks chats it trashed at Disconnect as `removed:'disconnected'` and restores them on the next `pair.granted`.
      - The first `sync.configure` of a new pairing implies a full resync.

13. **Medium. §8, protocol `ThreadPayload.analysis`, §4 meta row.**
    - **What goes wrong:**
      - Most existing threads have v1 or on-device analyses, and the "Upgrade older summaries" control exists only in TK. Users without a TK AI key get only heuristic summaries.
      - Still cannot request a better summary and cannot tell v1 from v2, because the payload has no `analysisVersion`. So the "better AI summaries" requirement rarely shows up in Still.
    - **Fix:**
      - Add `analysisVersion` to `ThreadPayload.analysis` and to `item.chat.analysis`.
      - Add `threads.analyze {threadKeys ≤50}` → `{queued, skipped:[{threadKey, reason:'no_ai'|'local_only'|'fresh'}], estimateUsd}`.
      - The chat page shows "Older summary — Improve", and the Settings card shows "N chats have older summaries — Improve all (≈$X)". Optionally fall back to Still's own AI.

14. **Medium. §0 "TK lets the user have AI pull conversations into collections", §7 TK manager UI.**
    - **What goes wrong:** TK only has a manual multi-select "Send to Still…". There is no path from TK's semantic search or Ask results into a Still collection.
    - **Fix:** Add "Send results to Still…" on the search results header (current reranked results, ≤200) and "Send these N threads to Still…" under each Ask answer (its cited threads). Both use the `DOCK_COLLECTIONS` picker plus "New collection…" (`target.collectionName`).

15. **Medium. §4 Transcript view, §3.1 `loadTranscriptWindow`.**
    - **What goes wrong:**
      - A long coding-agent session over 3.5 MB or 4,000 messages arrives truncated (first 20 plus the newest).
      - Summary refs into the gap, such as `[m214](#msg-213)`, find no element.
      - Windows loaded later are not specified as stored, so they are lost on reload and unavailable without TK.
      - Paging 150 messages from the end leaves early refs (m3) unrendered.
    - **Fix:**
      - Merge fetched windows into the stored transcript (same `revision` only) and clear `truncated` once it is contiguous.
      - While paired, fetch missing ranges in the background when a truncated chat is opened.
      - A `#msg-N` link renders the page containing N before scrolling. If N is not stored, show "Messages m21–m1830 aren't on this device — Load from Threadkeeper".

**What the design is missing for implementers**
- **Privacy note:**
  - Still's questions go to TK, and from TK to its embedding and rerank providers, on every automatic-context turn.
  - Chat titles and gists go to Still's embedding provider and to bridge/MCP clients through `publicSnapshot`.
  - Offer to keep chats out of the bridge.
- **`chat.removed` in the UI:** a banner and a list badge for deleted, out-of-scope and local-only chats, and turn off Refresh and Open in Threadkeeper for them.
- **§2.3 orphan sweep:** the rule contradicts itself. It should read: delete rows whose id is not an item (Trash counts), whatever the tombstones say, and only if `storedAt` is older than 10 minutes, so the sweep cannot race an in-flight upsert.
- **Branches:** ChatGPT export branches become separate threads titled "X (branch_2)". Add `branchId`/`siblingThreadKeys` to ThreadSummary and group them in the UI.
- **Summary page details:**
  - Rename §6 "Next steps" to "Action items" and dedupe it against `nextStep`.
  - "Your notes" should use the note page's block editor, not the compact inline editor (`is-compact`), so the page reads like a note.
- **Mirror collections:** define what happens when the user deletes or renames the mirror parent or a project child (today the chats end up in the Inbox).
- **Settings:** chat-data size from `chatDataStats` and a "Remove stored transcripts" action.
- **Picker:** "Load more" using `threads.list` `nextCursor`.
- **Liveness:** the threshold for "Not responding" (how many failed `hello` probes, over how long).