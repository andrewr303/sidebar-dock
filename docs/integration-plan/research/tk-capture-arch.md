# Threadkeeper capture providers: how they are defined and wired, and what a generic "any AI site" capture needs

Paths below are relative to /home/user/threadkeeper. One correction to the task: `site-data-main.ts` is in `src/entrypoints/`, not `src/core/`.

## 1. The registry: src/core/providers.ts

**Types**
- `PROVIDER_IDS` is a `const` tuple (providers.ts:5-20). `type ProviderId = (typeof PROVIDER_IDS)[number]` (22).
- `type CaptureProviderId = Exclude<ProviderId,'imported'>` (24).
- `CAPTURE_PROVIDER_IDS` filters out `'imported'` (162-164).

**`ProviderInfo` fields** (26-36): `{ id; label; maker; matchPatterns: string[]; reopen: 'web'|'terminal'|'none'; captureNote }`.
- There is no `hosts` field. There is no per-entry id extractor, no capture-method field and no default-enabled flag.
- The header says "adding a provider is one entry" (1-3). That is not true today. Host routing and id extraction are hand-written, outside `PROVIDERS` (38-160).

**Host and path routing**
- `providerForPage(parsed: URL): ProviderId|null` (206-226) is a hand-written if-chain on hostname and path:
  - chatgpt vs codex by `/codex` (209-211)
  - claude vs claude_code by `/code` (212-214)
  - X counts only on `/i/grok` (217)
  - `KIMI_HOSTS` and `COPILOT_HOSTS` sets (202-203)
- `detectProviderFromUrl(url)` (229-241) calls it, then falls back to the test hint `?tk_provider=` (239-240). Any page can set that hint.
- `isCapturePageUrl(url)` (248-256) ignores the hint and requires https. It gates the overlay (background.ts:276-277).

**Id extraction:** `extractConversationIdFromUrl(url)` (261-304).
- Per-provider `switch` for grok_x `?conversation=`, ai_studio `/prompts/:id` and kimi (269-285).
- Then a generic regex list: `/codex/tasks/`, `/code/`, `/c/`, `/chat/s/`, `/chat/`, `/chats/`, `/app/`, `/gem/../`, `/search/` (286-296).
- Then `?conversation=`, then the `tk_conv_id` hint (301-303).
- ChatGPT Projects: `parseChatGptProjectRoute` and `extractChatGptProjectSlug` (310-337).

**Labels:** `providerLabel(id)` (191-193), used by App.tsx, ThreadOverview, AskPanel, insights, pipeline, catch-up and library-organize.

**Manifest helpers:** `captureMatchPatterns()` (167-171) deduplicates every capture provider's `matchPatterns`. `toOriginMatchPatterns()` (177-185) turns them into origin patterns.

### Build derivation (scripts/build-extension.mjs)

`loadManifestMatchPatterns()` (112-145) bundles providers.ts with esbuild and imports it from a `data:` URL. It returns:
- `capture` = `captureMatchPatterns()`
- `grokX` = `PROVIDERS.grok_x.matchPatterns`, hard-coded (128)
- `siteData` = chatgpt + claude patterns, hard-coded (133)
- `domCapture` = `capture` minus grokX (141)
- `webAccessible` = `toOriginMatchPatterns(capture)` (143)

These feed the manifest:
- `host_permissions` = every capture pattern plus 3 API hosts (253-258). **Every capture host is a required install-time permission.**
- `optional_host_permissions` already lists AWS, MongoDB and Cohere (261-268).
- `content_scripts` (308-332):
  - `content.js` at document_idle on domCapture
  - `content.js` at document_start on grokX
  - `grok-x-main.js` with `world:'MAIN'` on grokX
  - `site-data-main.js` with `world:'MAIN'` on siteData
- `web_accessible_resources` puts `manager.html` and `assets/*` on the capture origins (337-342). `use_dynamic_url` is banned because of Edge, and the build asserts this (333-350).
- `permissions`: storage, unlimitedStorage, alarms, scripting, sidePanel (252). There is no `activeTab`.

A new DOM provider gets its host permission, content script and overlay access automatically. A new MAIN-world observer provider needs build-script edits, because the grokX and siteData lists are hard-coded.

### Every place that enumerates providers (all must change when an id is added)

| Where | What | How it updates |
|---|---|---|
| providers.ts:5-20, 38-160, 206-226, 269-296 | id, entry, host routing, id extraction | manual |
| schema.ts:634-649 | `DEFAULT_ACCOUNT_IDS: Record<ProviderId,string>` | manual (fails to compile until added) |
| dom-capture.ts:608-624 | `ADAPTERS: Record<ProviderId, DomAdapter>` | manual (fails to compile until added) |
| adapters.ts:81-107 | capability rows (`'kimi_dom'` etc.) | manual |
| history-sync.ts:17-27, 42-123 | `SyncProviderId` union and `SYNC_PROVIDERS` | manual, if Catch up is wanted |
| schema.ts:663-673 | `authorizedHosts` / `boundAccounts` defaults | derived |
| db.ts:1022-1024 | `providerCounts` | derived |
| App.tsx:625 | filter chips | derived |
| SettingsDialog.tsx:268-269, 508-516 | toggles: label + `captureNote`, writes `authorizedHosts` | derived |
| CatchUp.tsx:102 | Catch up list | derived from `SYNC_PROVIDERS` × `authorizedHosts` |

Tests that pin provider lists:
- capture.test.ts:713-735 (manifest patterns)
- history-sync.test.ts:356 (asserts the api strategy list equals `['chatgpt','claude']`)
- organizer.test.ts:~770-790 (v1→v2 settings migration)

### DB and settings migration

- `SettingsRecord.authorizedHosts: Record<CaptureProviderId, boolean>` and `boundAccounts: Record<ProviderId, {accountId, workspaceId}>` (schema.ts:563-564). Also `cloudExcludedProviders: ProviderId[]` (568).
- `DEFAULT_SETTINGS` turns every capture provider ON (`CAPTURE_PROVIDER_IDS.map(id=>[id,true])`, 665-667).
- `normalizeSettings` (734-760) spreads defaults under the stored maps. Every read goes through it: `ensureStarterCollectionsAndSettings` (db.ts:149), `saveSettingsPatch` (db.ts:168-169), pipeline.ts:360 and 373.
- **So a new id needs no Dexie migration, but existing users get it ON silently after the update.** An opt-in provider needs the default built from a new registry field such as `defaultEnabled`.
- Dexie indexes `provider` as a plain string (db.ts:55, 66), so new ids need no schema bump. The only settings migration is v2 (db.ts:69-111), which forced all hosts on.
- **Never remove or rename an id.** `parseThreadKey` rejects unknown providers (schema.ts:84), and `threadKey = provider:account:workspace:conv:branch` with `:` replaced by `_` (68-77).

## 2. DOM capture: src/core/dom-capture.ts

**Interfaces**
- `DomExtractionResult` (12-22): `{provider, sourceConversationId, branchId, canonicalUrl, title, coverage:'partial'|'title_only', messages: UpsertThreadInput['messages'], providerProjectName, modelSlug}`.
- `RawTurn` (26-34): `{el, role:'user'|'assistant'|'tool', body?, bodies?: Element[], id?, model?}`.
- `DomAdapter` (36-43): `turns(doc): RawTurn[]` and `title(doc,url,convId): string|null`, plus optional `project?(doc,url)`, `isStreaming?(el)` and `strip?: string` (a selector for reasoning blocks, scoped to the reply body).

**Adapters:** chatgpt and codex (334-374), claude and claude_code (384-429), grok (431-454), gemini (456-487, `strip:'model-thoughts'`), perplexity (489-503), deepseek (507-534), copilot (544-561), ai_studio (565-582), kimi (584-598). mistral has `turns: () => []` and relies on the fallbacks (600-606). grok_x and imported are no-ops (615, 623).

**Selection:** `extractVisibleDomConversation(doc, href)` (636-743).
- Provider = `<html data-tk-provider>` if it is a valid id, else `detectProviderFromUrl` (640-643). It returns null for imported and grok_x (645).
- Conversation id = `data-tk-conversation-id` or `[data-conversation-id]`, else the URL (647-651). **With no id there is no capture.**
- Branch comes from `[data-branch-id]` or `data-tk-branch-id`, else `'main'` (653-657).
- **Security issue:** the `data-tk-*` attributes and the `tk_provider` query hint are controlled by the page. On a user-added site, a page could file its content as another provider. These must be ignored outside tests.

**Fallback chain** (659-666): adapter, then `genericTurns`, then `heuristicTurns`. ChatGPT and Claude never fall back.
- `genericTurns` (261-274) uses `GENERIC_ROLE_SELECTOR` = `[data-message-author-role]`, `[data-testid^="conversation-turn"]`, `[data-tk-message-role]` (208-212). It splits a ChatGPT turn holding several messages into separate turns.
- `genericRole` (214-227) reads the role attributes, the nested role, `data-turn`, and the `font-user-message` class. Anything else is assistant.
- `heuristicTurns` (276-310) scans `[data-testid*=message i], [data-role], [data-author], [class*=message i], [data-content$=message]`, excluding nav, aside, form and contenteditable. It classifies with `HEURISTIC_USER` (user|human|query|prompt) and `HEURISTIC_ASSISTANT` (assistant|bot|ai|model|response|answer) over testid, role, author, content and className.
- Last resort: `.markdown, .prose, .ds-markdown, message-content` become assistant-only turns.

**Message boundaries and ids**
- `outermost()` (130-140) drops nested matches.
- `messageBodies()` (230-236): `[data-message-content]`, else every outermost `.markdown` as `bodies`, else `.whitespace-pre-wrap`.
- `stableMessageKey` (192-198): adapter id, then own `MESSAGE_KEY_ATTRS` (`data-turn-key`, `data-message-id`, `data-virtual-list-item-key`, `data-archer-id`; 170-175), then nearest keyed ancestor.
- Fallback id is positional `${conv}_${branch}_m_${i}`, with `#n` added to avoid collisions (711-714).

**Filters**
- Composer and draft exclusion: anything under `form`, `[data-testid=composer]` or contenteditable (677-683).
- Streaming: `data-streaming="true"`, `.result-streaming`, or `adapter.isStreaming` (685-693). ChatGPT checks `CHATGPT_STREAMING` (314-315, 371-373); Claude checks `data-is-streaming` (424-428).
- **The generic and heuristic paths have no streaming detection.** A mid-stream reply can be captured and is only corrected when the positional id is overwritten on a later capture.

**Text extraction:** `extractReadableText(root, skipSelector?)` (89-127).
- Skips `SKIP_TAGS` (BUTTON, SVG, IMG, FORM, …; 45-60), `aria-hidden`, and `.sr-only`.
- `BLOCK_TAGS` add newlines (62-82). `PRE` becomes fenced code with the `language-x` class (107-111). `LI` becomes "- ". `BR` becomes a newline.
- Then whitespace is normalized. This is readable text with fences and bullets, not full markdown: no headings, links, emphasis or tables, and ordered lists also become "-".

**Title:** `adapter.title`, else the first user message (80 chars), else "Untitled conversation" (725-730). `canonicalizeConversationUrl` keeps only the `?conversation` parameter (788-803). That would lose ids carried in other query parameters on generic sites.

## 3. src/entrypoints/content.ts

**Init:** guarded by `Symbol.for('threadkeeper.contentScriptInitialized')` (591-596), so the module runs once per page.
- On X (`isXHostname`) it listens for Grok-on-X window messages. Elsewhere it listens for site-data messages (615-620).
- The runtime listener (624-692) handles: `TOGGLE_THREADKEEPER_OVERLAY`, `TK_PING`, `TK_CAPTURE_NOW` (explicit), `TK_HISTORY_SYNC_RUN`, `TK_HISTORY_SYNC_CANCEL`, `TK_HISTORY_LIST_SIDEBAR`, `TK_CAPTURE_PROBE`, `CLOSE_THREADKEEPER_OVERLAY`.

**Observer** (697-735, not on X)
- `MutationObserver` on `documentElement` with `{childList, subtree, characterData}`. Mutations that touch only the overlay are ignored (698-716).
- Initial schedule on load. A 1500 ms `setInterval` URL poll resets stale retries on single-page-app navigation (728-734).

**Debounce:** `schedulePassiveDomCapture(explicit)` (448-515).
- Quiet window `CAPTURE_QUIET_MS = 900`, cap `CAPTURE_MAX_WAIT_MS = 4000` (414-415).
- `delay = explicit ? 50 : max(50, min(900, pendingSince + 4000 - now))` (459).
- Navigation guard `isStaleAfterNavigation` (441-446): a new conversation id carrying the previous conversation's keyed ids or identical text is retried every 700 ms, up to `MAX_STALE_RETRIES = 8` (430-431, 470-475).
- Fingerprint `provider:conv:branch:title:project:id:len|…` (478) suppresses unchanged resends unless explicit.

**Payload sent by `sendCapture()`** (312-327, 484-498):
`{type:'PASSIVE_DOM_CAPTURE', explicitInvoke, payload:{provider, sourceConversationId, branchId, canonicalUrl, title, createdAt:null, updatedAt:now, coverage, captureSource:'dom_observer', messages, providerProjectName, modelSlug}}`.
- `lastCaptureStatus` feeds the Diagnostics probe (299-310, 568-589).
- The site-data path (`scheduleSiteDataCapture`, 371-409) debounces 300 ms and sends `captureSource:'network_observer'` with `coverage:'full'`.

**Background handler** (background.ts:456-510)
- Rejects unknown providers and `imported`.
- Skips when `!authorizedHosts[provider] && !message.explicitInvoke` (464). **`explicitInvoke` is supplied by the content script.**
- Builds the threadKey from `boundAccounts[provider]`.
- Clamps the source to `network_observer` or `dom_observer`. Only `network_observer` may keep `'full'`; `upsertThread` enforces the same rule (db.ts ~300-307).
- Organizes the thread, then `syncOrchestrator.noteCapture(tabId, convId, n)`.
- **It never checks that `payload.provider` matches `sender.tab.url`.**

## 4. Catch up (v0.4)

**history-sync.ts**
- `SyncProviderId` (17-27). `SyncProviderInfo {id, label, strategy:'api'|'sidebar', homeUrl, hostPatterns, note}` (29-38).
- `SYNC_PROVIDERS` (42-123): only chatgpt and claude use `'api'`. Gemini, grok, perplexity, deepseek, kimi, mistral, copilot and ai_studio use `'sidebar'`. grok_x, claude_code and codex are not included.
- Limits: `SYNC_MAX_API = 300`, `SYNC_MAX_SIDEBAR = 30`, at most 31 days (133-137).
- `SyncEvent` union (159-165). `validateSyncEvent` (176-222) rebuilds `conversation` events through `validateSiteConversation` and requires the providers to match (193-196).

**site-api.ts (ChatGPT and Claude only)**
- `type SiteProvider = 'chatgpt'|'claude'` (16). `SiteConversation` (18-29).
- URL matchers: `/backend-api/conversation/<uuid>` (69-72) and `/api/organizations/<org>/chat_conversations/<uuid>` (75-78).
- Parsers: `parseChatGptConversation` (164) and `parseClaudeConversation` (267), dispatched by `parseSiteConversation` (308-310).
- `SITE_DATA_MESSAGE_SOURCE` / `SiteDataMessage` (324-331). `matchSiteConversationRequest(hostname, url)` (334-349). `parseSiteDataMessage` (351-363).
- `validateSiteConversation` (372-404): hard-coded provider check (377), canonical URL (398), and caps of 20k messages and 2M characters.

**site-history.ts**
- `ApiSyncParams` (24-40): `{provider, runId, sinceMs, max, known, origin, cookies, fetchImpl, emit, isCancelled, sleep, random?}`.
- `getJson` (79-107): same-origin `credentials:'include'` GET. 401 becomes `needs_login`, 403 or non-JSON becomes `blocked`, 429 or 5xx retries with Retry-After or backoff (3 attempts).
- `runApiSync` (244-311) branches on `p.provider === 'chatgpt'` for the label (246), listing (253), detail URL (275-280) and parser (283). It paces 500-1000 ms between reads and stops after 3 consecutive failures.
- It runs in the content script, started by `startApiSync` (content.ts:533-565). That function hard-codes the chatgpt and claude hosts (536-538).

**sidebar-history.ts:** `readSidebarConversations(doc, pageUrl, provider, limit)` (22-42) is generic and has no selectors.
- Any `a[href]` whose https URL resolves to this provider and yields an id counts. Route words in `NOT_A_CONVERSATION` are excluded (20).
- `loadSidebarConversations` (68-93) scrolls the nearest overflow container: 700 ms per scroll, patience 2, up to 20 scrolls, scroll position restored.

**sync-orchestrator.ts**
- `SyncEnv` (29-51); the Chrome implementation is in sync-env.ts:14-111.
- `start` sorts api providers first (88-94). `handleEvent` requires runId, provider and sender tab to match (116-118).
- `runProvider` (200-218): find or open a tab, wait for it, `ensureContentScript` (`executeScript` content.js, sync-env.ts:70-80).
- `runApi` (220-253): `TK_HISTORY_SYNC_RUN`, 120 s idle timeout.
- `runSidebar` (255-292) plus `captureInTab` (295-321): open each URL in a background tab, send `TK_CAPTURE_NOW`, resolve on `noteCapture` (158-161) or the 25 s timeout.
- Stored by `storeSyncedConversation` (background.ts:105-134) with `captureSource:'history_sync'`. It respects `authorizedHosts`.

**Adding a reader**
- **Sidebar strategy (nearly free):** a `SyncProviderId` member plus a `SYNC_PROVIDERS` entry `{strategy:'sidebar', homeUrl}`. It needs the provider's URLs to resolve through `detectProviderFromUrl` and `extractConversationIdFromUrl`.
- **API strategy (6 files):**
  1. Widen `SiteProvider` and add `parseXConversation(json, hintedId)` plus a canonical URL function.
  2. Update the provider checks at site-api.ts:356, 377 and 398, and `parseSiteConversation`.
  3. Add listing, detail and auth branches in `runApiSync`.
  4. Set `strategy:'api'` in `SYNC_PROVIDERS`.
  5. Update the host gate at content.ts:536-538.
  6. Optionally add a passive reader: `matchSiteConversationRequest` plus build-extension.mjs:133.

  Also update history-sync.test.ts:356. Before many providers are added, refactor into a `SiteApiReader` registry: `{provider, label, prepare(p), list(p, ctx), detailUrl(origin, id, ctx), parse(json, id), canonicalUrl(id), matchRequest?(hostname, url)}`.

## 5. MAIN-world response observer (grok-x.ts, grok-x-main.ts, site-data-main.ts)

The pattern has four parts and can be reused for any site whose UI loads conversations as JSON.

**1. A pure parser module with no dependencies,** bundled into the page.
- grok-x.ts header (1-5). `GROK_X_ITEMS_OPERATION`, `GROK_X_MESSAGE_SOURCE` (7-8).
- `GrokXMessage {id, role, text, createdAt}` and `GrokXCaptureMessage {source, restId, messages}` (10-25).
- `isGrokXItemsUrl` (37), `extractGrokXRestId(url, body, base)` (56-70), `parseGrokXItems(json)` (108-143). The parser drops `is_partial` items and gives id-less items FNV content-hash ids.

**2. A MAIN-world hook** (grok-x-main.ts).
- Wraps `fetch`: the call goes through `Reflect.apply`, and `.then` is registered before the page gets the promise, so `response.clone().json()` runs before the page reads the body (39-73).
- Wraps `XMLHttpRequest.open` and `send`: arguments are forwarded exactly, and the response is read only after `load` (75-113).
- `Symbol.for` HOOK_FLAG prevents a double wrap (115-120). Nothing may throw into the page.
- Posts with `window.postMessage(msg, location.origin)` (17-30).
- site-data-main.ts is the fetch-only, GET-only version keyed by `matchSiteConversationRequest` (32-66). It posts raw JSON and parses in the isolated world, which keeps the MAIN-world bundle small.

**3. An isolated listener** (content.ts:334-346 and 353-366).
- Requires `event.source === window && event.origin === location.origin`.
- Re-validates the payload (`parseGrokXCaptureMessage` 149-176, or `parseSiteDataMessage`).
- Requires the URL's conversation id to match, merges pages (`mergeGrokXMessages` 184-215), and schedules capture.

**4. A manifest entry** with `world:'MAIN'` and `run_at:'document_start'` (build-extension.mjs:319-331), plus an esbuild entry (179-201).

To generalize: one MAIN-world bundle holding `{matchRequest(hostname, url, method)}` per provider, and isolated-world parsers producing `SiteConversation`. Make the build derive the MAIN-world matches from a registry field (e.g., `capture: {dom: true, networkObserver?: 'chatgpt'|…}`) instead of hard-coding them.

## 6. Host permissions today, and runtime user-added sites

**Today:** every capture pattern is a required `host_permission`.

**Implications for adding providers:**
- Chrome Web Store and Edge Add-ons installs: an update that adds hosts raises new permission warnings and disables the extension until the user re-approves.
- Users can still restrict Site access even for required hosts.

So new providers, and certainly the generic option, belong in `optional_host_permissions`.

**Proposed design**

1. **Manifest:** add `'https://*/*'` to `optional_host_permissions` (build-extension.mjs:261). Expect closer store review on Chrome Web Store and Edge Add-ons. Keep `use_dynamic_url` off for Edge (333-350).
2. **Grant:** a "Capture this site" button in the side panel or Settings calls `chrome.permissions.request({origins:['https://host/*']})` inside the click handler. Reuse `requestHostAccess` and `hasHostAccess` (aws.ts:86-108). This cannot be called from the service worker or a content script.
3. **Register:**
   ```ts
   chrome.scripting.registerContentScripts([{
     id: 'tk-site-<hash>',
     matches: [origin],
     js: ['content-scripts/content.js'],
     runAt: 'document_idle',
     persistAcrossSessions: true,
   }])
   ```
   Also `executeScript` into tabs already open on that site.
4. **Persist and reconcile:**
   - Make a settings list the source of truth, e.g., `customSites: Array<{origin, label, enabled, addedAt}>`.
   - On `runtime.onInstalled` and `onStartup` (background.ts:401-412), diff it against `getRegisteredContentScripts()` and `permissions.contains`.
   - Handle `permissions.onRemoved` (unregister and disable) and `onAdded`.
5. **Identity:**
   - Add one id, `'web'`, to `PROVIDER_IDS` (default `authorizedHosts.web = false`) and store the site origin on the record.
   - Or derive `sourceConversationId` from host plus `extractConversationIdFromUrl`, else a hash of origin and path.
   - Content.ts needs the site config from the background (e.g., extend `GET_CAPTURE_AUTH_STATE` to resolve by sender), not from page attributes.
6. **Overlay:** `isCapturePageUrl` excludes custom sites and the web-accessible-resource matches are static, so use the side panel or a full tab there. Widening the matches to `https://*/*` would expose `manager.html` to every site and make the extension fingerprintable.
7. **Sender validation:**
   - `validateRuntimeMessageSender` accepts `CONTENT_SCRIPT_TYPES` from any sender with a `tab` or `url` (messaging.ts:87-94, 143-151).
   - For dynamic origins, the background must derive the provider from `sender.url` / `sender.origin` and require `sender.frameId === 0`: either `isCapturePageUrl`, or a listed, enabled custom site whose permission is still held.
   - It must override `payload.provider` and canonicalize URLs from the sender.
   - It must stop letting a content-script-supplied `explicitInvoke` bypass `authorizedHosts` for custom sites.
   - Content.ts must ignore `data-tk-provider`, `data-tk-conversation-id` and the `tk_provider` / `tk_conv_id` hints outside tests.
8. **Generic capture quality:** generic sites rely on `genericTurns`/`heuristicTurns`, which have no streaming detection. Add a stability check (text unchanged across two debounced ticks, or `aria-busy`) before sending.
9. **Edge and Chrome:** both support `optional_host_permissions`, `permissions.request` and `registerContentScripts`; `world:'MAIN'` in dynamic registration needs Chrome 102 or later (the build targets chrome120). Whether `activeTab` would work for one-off captures in side-panel launch mode needs testing.

**Named products:** grok.com (`grok`) and X (`grok_x`) are supported. "Dots" and "Muse" have no registry entries; their hosts and markup need to be confirmed before writing adapters. The generic opt-in path covers them in the meantime.

## 7. Tests

- **Environment:** jsdom (vitest.config.ts). Each file sets the page URL with a `// @vitest-environment-options {"url": …}` header: capture.test.ts:1 (`x.com/i/grok?conversation=1890`) and site-data.test.ts:1 (`chatgpt.com/c/<uuid>`).
- **Pure DOM fixtures:** `parse = html => new DOMParser().parseFromString(html, 'text/html')` (capture.test.ts:30). Call `extractVisibleDomConversation(doc, explicitUrl)` and assert `messages.map(m => [m.role, m.content])`, ids, title and provider.
  - Coverage: ChatGPT (429-512), Claude (514-547), stable keys (549-599), AI Studio, Kimi, Copilot, Gemini, DeepSeek and Grok (601-711), manifest patterns (713-735).
- **Entrypoint integration:**
  - Stub `window.fetch` and the XHR prototype, then `await import('…/grok-x-main.js')` or `site-data-main.js`.
  - `vi.stubGlobal('chrome', {runtime: {getURL, sendMessage(msg, cb), onMessage: {addListener}}})`, then `await import('…/content.js')` (capture.test.ts:268-286, site-data.test.ts:223-236).
  - Dispatch `MessageEvent`s with forged `source` and `origin` values. Use fake timers (`advanceTimersByTime(1500 / 6000)`) and filter the sent messages for `PASSIVE_DOM_CAPTURE`.
  - Because of the content.ts init guard, a new provider's integration test needs its own file and URL header.
- **capture-check.test.ts** (1-48) tests `describeCaptureProbe` (diagnostics.ts:291) with no DOM.
- **site-data.test.ts** covers the parsers (62-178), multi-message turns (179-215) and the observer, stale-navigation and never-quiet cases (217-377).
- **Other suites:** history-sync.test.ts drives the orchestrator through a fake `SyncEnv`. organizer.test.ts covers the settings migration.
- **jsdom limitation:** there is no layout, so sidebar scrolling and any visibility-based heuristic cannot be exercised there.