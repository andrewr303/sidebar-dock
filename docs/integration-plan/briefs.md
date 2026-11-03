# Workstream briefs

Common rules for every workstream (in addition to `design.md §9`):

- Work **only** inside your worktree path. It is a git worktree on your own branch, based on the shared base commit
  that already contains the protocol doc and (in sidebar-dock) contract stubs marked `WORKSTREAM-STUB(<owner>)`.
- Edit only the files your brief owns. If you need a change in a file another workstream owns, do the smallest
  possible edit there (a one-line registration, an import, an enum entry) and list it in your final message. If you
  need a module another workstream owns and it is still a stub, import it anyway and code against its documented
  contract; do not rewrite the stub (its owner replaces it).
- If you own a stub, replace it completely (remove the `WORKSTREAM-STUB` header).
- Keep the existing code style of each file (sidebar-dock: dense modern JS, two-space indent, no semicolons policy as
  the file has; threadkeeper: TypeScript strict, React function components).
- Write tests next to the existing ones, using the existing harness conventions from the maps.
- Commit your work on your branch with clear messages; never push; never commit `node_modules`, `.output/` or
  scratch files.

## sd-data — Still data layer for chats
Worktree: `/home/user/wt/sd-data` (branch `wip/sd-data`). Design: §1, §2 (all), and §3 only for context.
Owns: `extension/lib/store.js`, `extension/lib/chat-data.js` (replace stub), `extension/lib/portability.js`,
`extension/lib/storage/snapshots.js` (lock name in `RESTORE_LOCKS`), `bridge/protocol.mjs` (+ any bridge code that
renders items), `extension/lib/library-views.js` NOT (sd-ui owns it), `docs/data-model.md`, tests for these
(`tests/chat-data.test.mjs`, `tests/store-chats.test.mjs`, updates to backup/bridge/portability tests).
Deliver: `chat` type end to end in the data layer, `upsertChats` and `markChatsRemoved` store ops + exported
wrappers, `normalizeChat`, conversion guards, `chat-data.js` (IndexedDB + memory fallback + `sweepChatData`),
backup part + restore, CSV/HTML/Markdown export behaviour, bridge filter enums (never create/convert), docs.

## sd-link — Still ⇄ Threadkeeper link (worker + page client)
Worktree: `/home/user/wt/sd-link` (branch `wip/sd-link`). Design: §1, §3 (all), §2.4, protocol doc.
Owns: `extension/lib/threadkeeper/{protocol,state,placement,worker,client}.js` (replace the protocol/client stubs;
keep `threadHash`/`chatItemId`/`threadCiteId` exactly), `extension/background.js`, `extension/manifest.json`
(optional `management`), `scripts/check.mjs` (allowlist), `tests/foundation-appearance.test.mjs` (expectation),
`docs/threadkeeper-integration.md` (only to fix real protocol defects, reported), tests
(`tests/threadkeeper-protocol.test.mjs`, `tests/threadkeeper-worker.test.mjs`, `tests/threadkeeper-state.test.mjs`,
`tests/threadkeeper-placement.test.mjs`, background external-listener tests incl. spoofed senders).
Store ops `upsertChats`/`markChatsRemoved` are built by sd-data in parallel: call them through
`handleStoreOperation('upsertChats', [entries, options])` (already imported in background.js) or an injected
`deps.store`, never a named import that does not exist yet. Chat data via `extension/lib/chat-data.js` (stub now).
Must include the shared `threadHash` vectors in tests.

## sd-ui — Still chat item UI
Worktree: `/home/user/wt/sd-ui` (branch `wip/sd-ui`). Design: §1, §4 (all), §2.1 for the item shape.
Owns: `extension/ui/chats.js` (new), `extension/lib/threadkeeper/summary.js` (replace stub), `extension/styles/chats.css`
(new), `extension/index.html`, `extension/newtab.html`, `extension/styles/skins.css`, `extension/app.js` (module
registration + routing for the `chats` view), `extension/ui/{components,cards,library,sidebar,shell,routes,selectors,
command,map,detail,notes,icons}.js`, `extension/lib/library-views.js`, README section on chats, tests
(`tests/chats-ui.test.mjs`, `tests/chat-summary.test.mjs`, updates to existing UI tests that enumerate types).
Uses: `lib/chat-data.js` (`getChatRecord`, `getChatTranscript`), `lib/threadkeeper/client.js` (state, `refreshChat`,
`loadTranscriptWindow`, `threadkeeperRequest('thread.open', …)`), `ui/threadkeeper-picker.js`
(`openThreadkeeperPicker(ctx, opts)` from the Chats view header and the command palette).
Make the Summary view look and feel exactly like a Still note page; make the Transcript view a faithful, polished chat
recreation. Check both themes (light/dark) via tokens only, side panel and full tab, reduced motion, keyboard access.

## sd-settings — Still settings card + Add AI chats picker
Worktree: `/home/user/wt/sd-settings` (branch `wip/sd-settings`). Design: §1, §6 (all), §2.4 (prefs), §5 (assistant
prefs only).
Owns: `extension/ui/settings/threadkeeper.js` (new), `extension/ui/threadkeeper-picker.js` (replace stub),
`extension/ui/settings.js`, `extension/ui/settings/catalog.js`, `extension/ui/settings/parts.js`, picker CSS (put it in
`extension/styles/settings.css` or a new `extension/styles/threadkeeper.css` linked in both html files before
`skins.css` — coordinate: sd-ui also edits the html files; adding one `<link>` line is fine), tests
(`tests/settings-threadkeeper.test.mjs`, `tests/threadkeeper-picker.test.mjs`, catalog test updates).
Uses: `lib/threadkeeper/client.js` (all functions) and `lib/threadkeeper/protocol.js` (`isExtensionId`).
The Connect click must call `requestAccess({ permissions: ['management'] })` synchronously before any await.

## sd-ai — Still assistant: thread tools, automatic thread context, decision model
Worktree: `/home/user/wt/sd-ai` (branch `wip/sd-ai`). Design: §1, §5 (all).
Owns: `extension/lib/ai/*` (tools, assistant, index, permissions, new `threads.js` adapter + `thread-context.js`
decision/fusion helpers), `extension/lib/ai-prompts.js`, `extension/ui/ai-panel.js`, `extension/ui/assistant-page.js`,
`extension/ui/settings/assistant.js` (keywords line only), `docs/ai-prompts.md`, one wiring line in `extension/app.js`
(pass the threads adapter to `ai.init`), tests (`tests/ai-threads-tools.test.mjs`, `tests/ai-thread-context.test.mjs`,
and updates to the existing tool/prompt/permission tests whose exhaustive lists change).
Uses: `lib/threadkeeper/client.js` (`threadkeeperRequest`, `importThreadkeeperThreads`, `getThreadkeeperState`,
`onThreadkeeperChange`), `lib/threadkeeper/protocol.js` (`threadCiteId`, `chatItemId`), `lib/chat-data.js`,
`lib/threadkeeper/summary.js` (`buildChatSummaryMarkdown`).

## tk-dock-core — Threadkeeper ⇄ Still link (core, runtime, consent page)
Worktree: `/home/user/wt/tk-dock` (branch `wip/tk-dock`). Design: §1, §7 (all except the "TK manager UI" bullet),
protocol doc. Owns: `src/core/dock/*` (new), `src/entrypoints/connect/*` (new), `src/entrypoints/background.ts`,
`src/core/messaging.ts`, `scripts/build-extension.mjs` (connect.html), `src/core/schema.ts` (settings `sidebarDock`
+ normalizeSettings only), `src/core/db.ts` (v3 tables + exports needed), `src/core/pipeline.ts` (dirty hooks only),
`src/core/providers.ts` (add a `category` field to the registry if missing: chat/coding_agent/agent/…; claude_code and
codex are coding_agent), tests under `tests/unit/dock-*.test.ts`, `docs/sidebar-dock-integration.md` (real defects
only), README + architecture notes. `node_modules` in the worktree is a symlink to the main checkout's.

## tk-dock-ui — Threadkeeper manager UI for Still (runs after tk-dock-core, same worktree)
Worktree: `/home/user/wt/tk-dock` (branch `wip/tk-dock`). Design: §7 "TK manager UI" bullet; read what tk-dock-core
built first (git log/diff on the branch). Owns: `src/entrypoints/manager/SettingsDialog.tsx` (Sidebar Dock section),
`src/entrypoints/manager/BulkActions.tsx` (Send to Still…), `src/entrypoints/manager/App.tsx` (detail Send button,
In-Still badge, `DOCK_SYNC_NOW` after page writes, `affectsBackground`), styles, tests (React tests like
`bulk.test.ts`), README.

## tk-summaries — Threadkeeper analysis v2 + overview styling
Worktree: `/home/user/wt/tk-summaries` (branch `wip/tk-summaries`). Design: §8 (all), `maps/tk-ai-ui.md §1-4`.
Owns: `src/core/ai/claude.ts`, `src/core/insights.ts`, `src/core/schema.ts` (ThreadInsight/ExtensionSummaryOutput/
verifier only), `src/core/db.ts` (summaryRecord copy only), `src/core/pipeline.ts` (analysisToInsight/
analysisToSummary/gates only), `src/core/adapters.ts` (Markdown), `src/core/summary-markdown.ts` (new),
`src/entrypoints/manager/ThreadOverview.tsx`, the focal/claims rendering in `src/entrypoints/manager/App.tsx`
(lines ~1101-1177 and ~1985-2062 only), `src/entrypoints/manager/styles.css` (overview/claims/chips),
`src/entrypoints/manager/SettingsDialog.tsx` ("Upgrade older summaries" control in the AI section only), tests
(`tests/unit/ai-backends.test.ts` fixture, new `tests/unit/summary-v2.test.ts`), README note.
Quality bar: rewrite the system prompt and field descriptions so the sample in `maps/tk-ai-ui.md §2` would come out
as a crisp, substantive, in-depth summary. Include in your final message a before/after example built from a
realistic fake thread (run the prompt-building code; you cannot call the real API).
