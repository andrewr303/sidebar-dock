# Threadkeeper map: AI analysis quality, manager UI and runtime (for the Sidebar Dock integration)

## 1. Analysis data flow (what a pushed thread has to carry)

`analyzeThreadWithClaude` (src/core/ai/claude.ts:247-306) produces a `ThreadAnalysis`. `analyzeThreadRemotely` (src/core/pipeline.ts:385) then splits it into two records.

1. **`ThreadInsight`** (narrative), from `analysisToInsight` (pipeline.ts:268-320). It is stored in `db.insights` under the key `ai|<threadKey>`. The type is at src/core/schema.ts:412-441:
   ```ts
   { insightKey; threadKey; source:'local'|'ai'; model; sourceRevision; contentHash; generatedAt;
     title; gist; summary; userGoal|null; outcome|null; kind:ThreadKind; topics[]; entities[]; languages[];
     artifacts: Array<{label; kind:ArtifactKind; messageIndex:number|null}>; lastUserAsk|null;
     suggestedStatus|null; statusReason|null; suggestedProject:{name,isNew,confidence,reason}|null;
     userTurns; hasCode }
   ```
   Clamps applied at pipeline.ts:275-311:
   - title 120, gist 220, summary 1200, userGoal and outcome 400 characters.
   - topics are normalized to `[a-z0-9.+#-]`, 2–40 characters, at most 8.
   - entities: at most 10 of 60 characters each. Artifacts: at most 12.
   - `clean()` replaces every run of whitespace with a single space (`.replace(/\s+/g,' ')`, pt.276), so any paragraph breaks are lost.
2. **`ExtensionSummaryOutput`** (grounded), from `analysisToSummary` (pipeline.ts:322-356) → `sanitizeSummaryForGrounding` (src/core/insights.ts:698-743) → `applySummaryEnrichment` (src/core/db.ts:593). It is stored in `db.summaries` as a `StructuredSummaryRecord` (schema.ts:226-233). Shapes:
   ```ts
   ExtractedItem { text; messageIndexes:number[]; evidenceQuote; provenance?:'explicit'|'inferred'; speaker:'user_committed'|'assistant_suggested' }  // schema.ts:202
   ExtensionSummaryOutput { whereYouLeftOff; whereYouLeftOffMessageIndexes; currentStatus; currentStatusMessageIndexes;
     decisions; openQuestions; actionItems; constraints: ExtractedItem[]; entities; artifactReferences: string[];
     suggestedProject|null; suggestedTags; confidence }                                                         // schema.ts:210
   ```
   - Message indexes are 0-based ordinals. The UI and the prompt use 1-based `mN`. The conversion is `toOrdinal` (pipeline.ts:262-266: `messageNumber - 1`, and null if no message has that ordinal).
   - `currentStatus` is filled from `statusReason || gist` (pt.342). `constraints` is always `[]` from AI analysis.
   - The AI's `whereYouLeftOff.quote` is dropped (only the index is kept), so that quote is never verified.

**Grounding invariants.** The verifier is `verifyExtensionSummaryEvidence` (schema.ts:235-311). It rejects the whole summary if any of these hold:
- an item has no `messageIndexes`;
- a quote shorter than 12 characters, or a quote that is not a substring of a referenced message after whitespace and case are normalized;
- `user_committed` on an assistant-only message;
- injection-pattern text (shared/cloud.ts:272-282) in `whereYouLeftOff`, `currentStatus` or an item's text.

It only checks the four item arrays (`checkItems` pt.305-308). `sanitizeSummaryForGrounding` first drops the items that would fail (or re-anchors a quote to the message that actually contains it), so the verifier normally passes.

`applySummaryEnrichment` re-verifies twice (db.ts:654 and inside the transaction at :736) and also refuses on tombstone, coverage, stale revision or content hash. `analyzeThreadRemotely` ignores its return value (pipeline.ts:450-456). A rejected summary therefore fails silently while the insight is still stored.

`db.ts:670-690` builds `summaryRecord` by listing every field explicitly, so any new summary field must be added there or it will be dropped. The Dexie indexes (db.ts:60 `summaries: 'threadKey, sourceRevision'`, db.ts:71 `insights: 'insightKey, threadKey, source, kind'`) do not need a version bump for fields that are not indexed.

**Local vs AI.**
- The on-device pass `analyzeThreadLocally` (insights.ts:590) writes `local|…` insights and summaries with `model === LOCAL_ANALYZER_MODEL = 'local-heuristics-v2'` (insights.ts:17). It overwrites an AI summary only when that summary is stale (pipeline.ts:176-189).
- `resolveInsight` (insights.ts:751-768) picks the insight to display. The push payload should use it and include `insight.source` and `summary.model`, so Sidebar Dock can label output as on-device or Claude.

**Model and effort.**
- `MODEL_OPTIONS` (claude.ts:33-38): opus-5-5, sonnet-5-5, haiku-5-5, fable-5-1, with labels and prices. `modelLabel` (ThreadOverview.tsx:17-19) strips `anthropic.` and matches with `startsWith`.
- Effort comes from the single global `settings.aiEffort`, typed `'low'|'medium'|'high'` (schema.ts:597). The default is `'low'` (schema.ts:701). It is used for analysis (claude.ts:284), organize (:383), ask (:442) and catch-up (:556).
- The API also accepts `xhigh` and `max`. Claude Opus 5.5's own default is `medium`.
- Analysis uses `max_tokens: 16000`, non-streaming, with `serverFallbackParams` (backends.ts:149-155). On Bedrock it uses the middleware instead (backends.ts:171-194, `withClient` claude.ts:58-71).
- `buildTranscript` (claude.ts:209-237) has a 60,000-character budget (about 15k tokens). It keeps the first 4 messages plus as many of the newest as fit, and drops the middle. Each message is clipped to 6,000 characters (tool messages to 400), keeping 70% from the start and 30% from the end.

## 2. Why the pasted output reads poorly

| Symptom | Root cause |
|---|---|
| Gist is a run-on about the chat itself ("assistant stopped to ask for input…") | Schema claude.ts:141-143 asks for one sentence that says both what the thread is about **and where it ended up**. Prompt :184 says "how it ended". Nothing tells the model to write about the subject rather than the conversation. On long threads the middle is dropped (claude.ts:223-235), so the newest turns dominate, and those are often process chatter ("stop asking permission"). Default effort `low` (schema.ts:701) makes this worse. |
| Summary repeats the gist | The summary description (:144, :185: "problem, what was produced, current state") overlaps the gist, and nothing says "don't repeat the gist". `ThreadOverview` hides the summary only when it is **exactly equal** to the gist (ThreadOverview.tsx:53). |
| "Where you left off" mixes state with instructions | Schema :162 asks for "where they stopped **and** what comes next". Prompt :190 says "what the user should do or read next", which invites imperatives. The latest user turn is often an instruction to the assistant, and the model echoes it. There is no separate next-step field, and `actionItems` overlap it. |
| `m3` on its own line | `.tk-claim-row` is a grid (styles.css:579-586) and `.tk-evidence-marker` is inline-flex (:598). Grid and flex children are blockified, so `innerText` and copy-paste put each marker on a new line (App.tsx:1141-1153, 1999-2020). |
| Artifacts jammed together (`…Addendum m2Grok bot…`) | ThreadOverview.tsx:99-104 maps the `<span className="tk-artifact">{label}<span> m{n}</span></span>` elements with **no text separator** between them. The visual gap is only `margin` (styles.css:1143-1152), so text extraction concatenates them. |
| Topics one per line | `.tk-chip-row` is `display:flex` (styles.css:903-908), so each chip is blockified and becomes its own line in copied text (ThreadOverview.tsx:76-90). |

Every artifact, topic and evidence marker lacks a plain-text representation. Text copied from the page, screen-reader output and any HTML-to-text path all get mangled. The same problem will reach Sidebar Dock if it renders from copied DOM text instead of structured data.

## 3. Proposed prompt and schema changes (compatible with the verifier and stored records)

**Rules.**
- Never remove or rename existing `ThreadAnalysisSchema` fields; `analysisToInsight` and `analysisToSummary` depend on them.
- Add new fields as `.nullable()` or as arrays. Every property must stay present, the same convention as `userGoal`.
- Don't use zod `.min/.max/.length`. Structured outputs does not support string or array length constraints. The SDK strips them from the schema it sends and validates them client-side, so an over-long array makes the parse fail and the call ends with "Claude returned no structured analysis". Put the limits in `.describe()` and clamp in `analysisToInsight` instead.
- A new schema costs one compile on its first request (cached for 24 hours).

**Additions to `ThreadAnalysisSchema`.**
```ts
gist: z.string().describe('<=22 words. The subject and its result, e.g. "Founder credibility addendum for the seed deck, drafted and approved." Never mention "the user"/"the assistant" or how the chat went.'),
overview: z.array(z.string()).describe('2-3 short paragraphs, each 2-4 sentences: (1) context and goal, (2) what was worked out or produced, with specifics, (3) where it stands. Must not restate the gist.'),
keyPoints: z.array(EvidenceItemSchema).describe('3-8 substantive facts, findings or conclusions from the content (not chat mechanics), each quoted.'),
produced: z.array(z.object({ label: z.string(), kind: z.enum([...]), description: z.string().describe('One line: what it is and its state.'), messageNumber: z.number().nullable() })),
whereYouLeftOff: z.object({
  text: z.string().describe('Past tense: the last substantive thing done or established. No instructions.'),
  nextStep: z.string().nullable().describe('One imperative next action for the user, or null.'),
  messageNumber: z.number(), quote: z.string() }),
// EvidenceItemSchema gains:
rationale: z.string().nullable().describe('Decisions only: why, in one clause; null otherwise.'),
```

**Prompt additions** to `ANALYSIS_SYSTEM_PROMPT` (claude.ts:180-195):
- "Write about the work, not the conversation. Ignore process turns (permission requests, 'continue', 'stop asking', retries) unless they changed the outcome."
- "Never begin with 'The user'/'The assistant'."
- "The gist, overview, where-you-left-off and next step must not repeat each other."
- "Prefer concrete nouns: file names, numbers, names."

**Mapping (no migration needed).**
- `insight.summary = overview.join(' ')`, clamped to 1200, which keeps the legacy readers working (search.ts, catch-up.ts:112, embeddings.ts:203).
- Add `overview?: string[]`, `produced?: …[]` and `analysisVersion?: number` to `ThreadInsight`.
- Add optional `keyPoints?: ExtractedItem[]` and `nextStep?: string | null` to `ExtensionSummaryOutput`, and pass both through `sanitizeSummaryForGrounding` (`clean(summary.keyPoints ?? [])`) and `checkItems` (schema.ts:305).
- `rationale` rides on `ExtractedItem`, where the verifier ignores unknown fields.
- Extend the explicit copy at db.ts:670-690.
- Readers must treat old records as `?? []`.
- To re-analyze v1 records, add `|| (aiInsight.analysisVersion ?? 1) < ANALYSIS_VERSION` to **both** gates: `needsRemoteWork` (pipeline.ts:92-96) and `wantsAi` (pipeline.ts:401). Doing this on demand only avoids an unexpected bill.

**Other knobs.**
- Run analysis at `medium` effort minimum, either through a separate setting or `max(aiEffort, 'medium')` at claude.ts:284.
- Raise the transcript budget well above 60k characters (it is roughly 15k tokens against a 1M context).
- Update `estimateAnalysisCostUsd`'s assumed output of 1800 tokens (claude.ts:479).
- Update the test fixture `ANALYSIS` (tests/unit/ai-backends.test.ts:16-33). The fixture must contain every field, or the zod parse fails.

## 4. Manager detail rendering (where to change it and what it shows)

- `ThreadOverview` (ThreadOverview.tsx:22-151):
  - provenance line :29-47;
  - gist `<p.tk-overview-gist>` :52, summary :53;
  - Goal/Outcome/Status `<dl>` :54-75 (note that Status is only shown when goal or outcome exists);
  - chips :76-90, "Mentions" :91-95, Artifacts :96-106, Project :112-119, CLI box :121-148.
- App.tsx, in the order rendered:
  - `<ThreadOverview>` :1985;
  - "Where you left off" `.tk-focal-left-off` :1994-2027, with the fallback chain `whereYouLeftOff → nextStepText → latestDecisionText → last message`;
  - Decisions :2029-2042, Action items :2044-2057, Open questions :2059-2062. All three go through `renderClaims(items, prefix, emptyText, fallback?)` (:1129-1177).
- Evidence markers show `d.messageIndexes.map(i=>`m${i+1}`).join(',')` (:1151). The pip's `data-speaker` gives a filled dot for `user_committed` (styles.css:628).
- `renderEvidencePassage` (:1101-1127) shows the cited message clipped to 1200 characters.

**Fixes.**
- Render overview paragraphs as `<p>`s.
- Render key points, decisions-with-rationale (`text — rationale`) and produced items as `<ul><li>`.
- Put text separators or `.tk-visually-hidden` (styles.css:778) labels such as `(source m3)` inside the markers.
- Use `<ul class="tk-chip-row">` with `li` chips and a hidden `, ` separator, or make the chips non-flex.
- Add a "Copy summary" button that builds Markdown from data. The existing `exportThreadToMarkdown` (src/core/adapters.ts:565-636) omits gist, summary, topics and artifacts entirely.

The same Markdown builder is the natural body for Sidebar Dock's "summary note" view.

## 5. Settings: adding a "Sidebar Dock" section

The `panels` Record is typed `Record<SectionId, …>`, so TypeScript forces every step below.
1. Add `'sidebarDock'` to `type SectionId` (SettingsDialog.tsx:155).
2. Add an entry to `SECTION_LABELS` (:157-166); its order is the nav order.
3. Add a case to `sectionStatus` (:261-289), for example `{text:'Paired'}`, `{text:'Off'}` or `{text:'Pending', tone:'danger'}`.
4. Add a `panels.sidebarDock` built from `<Section title note>` (:59-67), `<Toggle checked onChange label hint>` (:69-89) and `<Result state>` (:327-334). Use `TestState`/`IDLE` (:336-337) for a "Test connection" button, the same pattern as `testAi` (:400-408).
5. Settings fields:
   - Add them to `SettingsRecord` (schema.ts:560-632) and `DEFAULT_SETTINGS` (:662-731).
   - If you use a nested object such as `sidebarDock: { enabled, pairedExtensionId, autoPush, includeTranscript, pairedAt }`, it **must** be added to the nested merge list in `normalizeSettings` (:734-760). Otherwise a partially stored object loses its defaults (only `authorizedHosts`, `boundAccounts`, `autoOrganize` and `aws` are deep-merged).
   - Add the key to the `affectsBackground` list (App.tsx:345-367) so `SETTINGS_CHANGED` reaches the service worker.
   - The dialog receives `onPatch = persistSettingPatch` (App.tsx:2341); `saveSettingsPatch` is at db.ts:163.

## 6. Bulk action: "Send to Sidebar Dock"

- `type BulkAction` (BulkActions.tsx:127-136) → add `'send_sidebar_dock'`.
- Option arrays: `EDIT_ACTIONS` (:138-146) and `EXPORT_ACTIONS` (:148-151). Add a third optgroup `<optgroup label="Share">` at :377-390, or append to `EXPORT_ACTIONS`.
- Add a `handleSubmit` switch case (:271-295).
- Submit button label ternary (:435): add "Send".
- Gate the option on pairing state, which needs a new prop (`Props` :163-177; mounted at App.tsx:1666).
- Implement it like `exportAs` (:255-269): `run(async () => { const bundle = await exportSelectedThreads(sharedDb, orderedSelection); … return { text, reload:false } })`.
  - `exportSelectedThreads` (db.ts:967-997) returns `PortableBundle` (adapters.ts:452-461), which has **no insights**. Also load `resolveInsight(conv, local, ai)` for each thread.
  - `orderedSelection` (:206) includes threads hidden by the current filters.
- A single-thread action belongs in the detail action row next to "Copy handoff" (App.tsx:1969-1977).

## 7. Background runtime (background.ts)

**Module state.**
- `db` :25. `kickAnalysis()` :71-87 is single-flight (`analysisRun`); it runs `runAnalysisJobs(db,{maxJobs:8,timeBudgetMs:240_000})` and then calls `broadcastLibraryChanged()` only if `processed>0`.
- `broadcastLibraryChanged(threadKey?)` (:41-47) sends `{type:'LIBRARY_CHANGED', threadKey}` through `chrome.runtime.sendMessage`. It reaches only this extension's own pages.
- `organizeStoredThread` (:90-102) runs after every capture.
- `openManagerTab(query?)` (:171-181) reuses or focuses `manager.html?surface=page&…`.

**Listeners, as registered.**
- `tabs.onRemoved` :251
- `action.onClicked` :321
- `commands.onCommand` :334
- `runtime.onInstalled` / `runtime.onStartup` → `initializeBackground` :366-374
- `alarms.onAlarm` :413-425
- `runtime.onMessage` :427-770

**Alarms.**
- `'threadkeeper-resumable-jobs'` every 5 minutes → `processResumableJobs`.
- `ANALYSIS_SWEEP_ALARM='tk-analysis-sweep'` every 3 minutes.
- `ANALYSIS_DUE_ALARM='tk-analysis-due'`, one-shot, set by `scheduleAnalysisAlarm` (:63-68).

**onMessage branches** (every message is first gated by `validateRuntimeMessageSender`; the default reply is `{ok:true}` at :766; the handler `return true` is at :768):
- `GET_CAPTURE_AUTH_STATE` :444
- `PASSIVE_DOM_CAPTURE` :456
- `OVERLAY_FRAME_STATUS` :512
- `OPEN_MANAGER_FALLBACK` :519
- `GET_DIAGNOSTICS` :531
- `SETTINGS_CHANGED` :536
- `HISTORY_SYNC_EVENT` :544
- `START_HISTORY_SYNC` / `CANCEL_HISTORY_SYNC` / `GET_HISTORY_SYNC_STATE` :551-575
- `RUN_ANALYSIS_NOW` :577
- `REDEEM_OVERLAY_HANDSHAKE` :584
- the overlay-privileged set :632-639
- `OPEN_FULL_PAGE_MANAGER` :660
- `OPEN_ORIGINAL_THREAD` :672
- `CLOSE_THREADKEEPER_OVERLAY` :711

**Cross-extension integration points.**
- Register a **separate** `chrome.runtime.onMessageExternal.addListener` beside :427. Don't route it through `validateRuntimeMessageSender`: it rejects any `sender.id !== chrome.runtime.id` (messaging.ts:105-110), and test PRIV-11 (tests/unit/core.test.ts:775-800) locks that behavior in.
- The external handler should:
  - check `sender.id === settings.sidebarDock.pairedExtensionId` and that pairing is approved;
  - allow-list message types;
  - log rejections to `securityRejectionLog` (:182);
  - `return true` for async replies.
- Outbound pushes use `chrome.runtime.sendMessage(pairedId, msg)`. The manifest declares no `externally_connectable`, which means any extension may message Threadkeeper and no web page can. Threadkeeper's ID is unstable: the manifest has no `key` (build-extension.mjs:245), so an unpacked install's ID depends on its path. Pairing must therefore exchange IDs at run time and never hardcode them.

**Push triggers.** Analysis runs in **two** contexts:
- the service worker (`kickAnalysis`);
- the manager page (`startAnalysis` App.tsx:956-990 calling `runAnalysisJobs`, and `handleAnalyzeSelected` :992-1003 calling `analyzeThreadRemotely`).

A push hooked only in `kickAnalysis` misses analyses run from the manager. Two options:
- **Preferred:** a durable queue. Add a new `JobRecord.jobType` value `'push_sidebar_dock'` (schema.ts:359; enqueue with `enqueueJob` db.ts:1080), enqueue it at the end of `analyzeThreadRemotely` (after pipeline.ts:457) and in `organizeStoredThread`, and drain it from an alarm.
- **Or:** have the manager send `notifyBackground({type:'SIDEBAR_DOCK_PUSH', threadKeys})`.

**Pitfall (likely existing bug):** `processResumableJobs` (db.ts:1107-1190) takes **every** pending job regardless of `jobType` or `notBefore`. The handler in background.ts:416-420 only acts on `enrich_thread`, yet every job it takes is marked `completed`. Pending, debounced `analyze_thread` jobs, and any new push jobs, can therefore be swallowed without running. Filter by `jobType` there before adding a new type.

## 8. messaging.ts

To add internal message types (for example `SIDEBAR_DOCK_PAIR`, `SIDEBAR_DOCK_PUSH`):
- add them to the `PrivilegedCommandType` union (:4-18) **and** the `PRIVILEGED_TYPES` set (:70-85). Unknown types are rejected with "Unknown message type" (:153).
- The privileged origin regex only accepts `/(manager|sidepanel)\.html` (:114-119). A `connect.html` page sending privileged messages needs that alternation extended, plus a test in organizer.test.ts:794-807 (the `.html.evil` suffix case must still be rejected).

`ExtensionMessage` (:28-63) is documentation-only; it is not used for dispatch.

## 9. Build: emitting connect.html and manifest changes

- Pages are emitted with `pageHtml(surface, title)` (build-extension.mjs:225-238) and written at :239-240. Option one: add `fs.writeFileSync(path.join(outDir,'connect.html'), pageHtml('connect','Connect Sidebar Dock'))` and branch on `data-surface` in App, where `surface` is read at App.tsx:131.
- Option two: a separate esbuild entry, following blocks :204-216, writing to `assets/connect.js` with its own HTML.
- `web_accessible_resources` (:337-342) exposes only `manager.html` and `assets/*` to AI-site origins. Don't add `connect.html` unless another extension must frame it; another extension opening it in a tab doesn't need it.
- The CSP is `script-src 'self'` (:344), so no inline scripts. `use_dynamic_url` is forbidden (:347-350).
- `externally_connectable: { ids: [...] }` can't be used for unpacked-path IDs. Omitting it means every extension can connect, so the sender-ID check is the real gate.

## 10. Every list the integration must extend

- `SectionId`, `SECTION_LABELS`, `sectionStatus`, `panels` (SettingsDialog.tsx:155, :157, :261, :450)
- `BulkAction`, `EDIT_ACTIONS`/`EXPORT_ACTIONS`, `handleSubmit`, submit label (BulkActions.tsx:127, :138/:148, :271, :435)
- `PrivilegedCommandType`, `PRIVILEGED_TYPES`, manager-URL regex (messaging.ts:4, :70, :114)
- background `onMessage` branches (§7); new `onMessageExternal`
- `JobRecord.jobType` (schema.ts:359); job filters `where('jobType').equals(ANALYZE_JOB)` (pipeline.ts:490, :612, :618)
- `SettingsRecord`, `DEFAULT_SETTINGS`, `normalizeSettings` (schema.ts:560, :662, :734); `affectsBackground` (App.tsx:345)
- `ThreadAnalysisSchema`, `ANALYSIS_SYSTEM_PROMPT` (claude.ts:139, :180); `analysisToInsight`/`analysisToSummary` (pipeline.ts:268, :322); `sanitizeSummaryForGrounding` (insights.ts:698); `checkItems` (schema.ts:305-308); `summaryRecord` copy (db.ts:670)
- Text consumers of the summary: search (search.ts:534-545), embedding doc (embeddings.ts:188-211, gist/summary/topics/entities), Markdown export (adapters.ts:565), catch-up (catch-up.ts:112)
- Build pages (build-extension.mjs:239-240)

## 11. Search and "all threads" context (for the assistant tools)

Retrieval lives in a **React component**, not in core:
- `AskPanel.retrieve` (src/entrypoints/manager/AskPanel.tsx:127-170) does reciprocal-rank fusion, adding `1/(60+rank+1)` per list, over three lists:
  - lexical `MemorySearchIndex.searchLocal` (:133);
  - local hash vectors (`LOCAL_SPACE`, cosine > 0.12);
  - the remote embedding space (`embedTexts(...,'query')`).
- It filters out non-remote threads (`remoteAllowedKeys`), then `rerankForAsk` (:93-125) calls `rerankThreads` with `buildRerankDocument({title,gist,excerpt})` (rerank.ts:507, :576).
- `runHybridSearch` (search.ts:631) and `MemorySearchIndex` (search.ts:306) are the core pieces.

A `SEARCH_THREADS` external endpoint needs this fusion pulled out into a core function that loads conversations, insights and vectors from Dexie. Sidebar Dock could also run its own index over the pushed copies.

Useful filters already in the data:
- **Coding-agent sessions:** `PROVIDERS[p].reopen === 'terminal'` (claude_code, codex; providers.ts:56, :65).
- **Kind:** `THREAD_KINDS` (schema.ts:374-387).
- **Project:** `conv.project` / `providerProjectName`.
- **Workspace:** `workspacePath`, `gitBranch`.

**Privacy invariant:** `isRemoteAllowed(conv, settings, localOnlyProjects)` (privacy.ts:10) returns false for `cloudExcluded`, synthetic and `cloudExcludedProviders` threads. Push those with `localOnly:true`, or not at all, so Sidebar Dock never sends them to its LLM.

## 12. Test conventions (vitest, jsdom, fake-indexeddb)

- Config: `environment:'jsdom'`, `globals:true`, includes `tests/unit/**/*.test.ts(x)` (vitest.config.ts).
- Database: `import 'fake-indexeddb/auto'` and a fresh `new ThreadkeeperDB(\`Name_${n}_${Date.now()}\`)` per test (bulk.test.ts:1, :26-29). Thread fixtures come from `buildThreadKey(...)` + `upsertThread` (bulk.test.ts:33-53).
- React: `createRoot` on a `document.createElement('div')`, wrapped in `act(async…)`, then unmount and remove (bulk.test.ts:353-383).
- Claude: inject a `fetchImpl`. `messagesFetch(calls, respond?)` returns a canned `message` whose `content[0].text = JSON.stringify(ANALYSIS)` (ai-backends.test.ts:36-62); `INPUT` is at :64-73.
- Chrome APIs: `vi.stubGlobal('chrome', {...})` (capture.test.ts:275, site-data.test.ts:226).
- Grounding: build `msgs()` records and assert `verifyExtensionSummaryEvidence(...).errors` equals `[]` (organizer.test.ts:357-391; core.test.ts:416-445).
- Sender rules: organizer.test.ts:794-807 and core.test.ts:775-800.
- Run order: `npm run check` = typecheck, build, test.

## 13. Pitfalls checklist

- Sends from a service worker to an extension that isn't running or isn't installed reject ("Receiving end does not exist"). Wrap them in `.catch`, and reply with `{ok:false,error}` instead of throwing.
- `chrome.runtime` messages are JSON-serialized and capped at about 64 MiB. Transcripts can be large, so chunk them by message range and include `sourceRevision`/`contentHash` so the receiver can dedupe and order.
- Pushes must be idempotent, keyed on `threadKey` + `sourceRevision`.
- Send deletes as tombstones (`db.tombstones`), or Sidebar Dock keeps ghosts.
- Analysis can fail silently (summary rejected, pipeline.ts:450). Push whatever is in the database, not the in-memory analysis.
- Threadkeeper's own text is untrusted. The analysis prompt already treats the transcript as data (claude.ts:195). Sidebar Dock should treat all pushed text as data in its own prompts too.