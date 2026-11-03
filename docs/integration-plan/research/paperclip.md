# Paperclip research for Threadkeeper integration

I read the source of a shallow clone of `paperclipai/paperclip` at commit `4d31588` (2026-11-03). The CLI and server `package.json` files say version `0.3.1`, and the newest release note is `releases/v2026.1023.0.md`. The clone is at `/tmp/claude-0/-home-user/d6f09056-d3f2-52cc-95e4-14934adda9a1/scratchpad/research/paperclip-src/repo`. All paths below are relative to the repo root. Two extracted route lists are in the scratchpad: `research/all-routes.txt` (994 route declarations taken from `server/src/routes/*.ts`) and `research/openapi-routes.txt`.

## 1. What Paperclip is and how people run it

- Paperclip is a self-hosted Node.js server with a React UI that runs "companies" of AI agents. A company has an org chart, goals, projects, issues (tasks), heartbeat runs, budgets and approvals. Agents are external harnesses such as Claude Code, Codex, Cursor, Gemini, OpenCode, Pi, Hermes, Grok, Kimi, OpenClaw, plain processes or HTTP bots (`README.md`). It is MIT-licensed.
- **How it is started:** `npx paperclipai@latest onboard --yes`, or `pnpm dev` from source. The UI and API share one origin.
  - The default address is **`http://localhost:3100`**, with every API route under **`/api`** (`docs/api/overview.md`).
  - The port comes from `PORT`, then `config.server.port`, then `3100` (`server/src/config.ts:372`).
  - If the port is busy, the server takes the next free port via `detect-port` (`server/src/index.ts:620,777`). Threadkeeper should therefore probe `GET /api/health` instead of assuming 3100.
  - `GET /api/health` returns `{status, deploymentMode, deploymentExposure, version, ...}` (`server/src/routes/health.ts:295-330`).
- **Data location:** `~/.paperclip/instances/<instanceId|default>/`. `PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` override it (`packages/shared/src/home-paths.ts:4,17-34`). That folder holds `config.json`, an embedded Postgres, `data/storage` and `data/run-logs`.
- **Deployment modes** (`doc/DEPLOYMENT-MODES.md`):

  | Mode | Login | Where it listens |
  |---|---|---|
  | `local_trusted` (the quickstart default) | none | `server.bind=loopback` |
  | `authenticated` + `private` | Better Auth login | `lan`, `tailnet` or `custom` bind, LAN/Tailscale |
  | `authenticated` + `public` | Better Auth login | internet-facing, explicit `PAPERCLIP_PUBLIC_URL` |

- **Paperclip Cloud** is waitlist-only (`README.md`). Cloud-managed instances sign users in through Cloud, which shows up as actor source `cloud_tenant`.

## 2. HTTP API for reading agent work

Every route below is under `/api`. A route that takes an issue `:id` also accepts an identifier such as `PAP-39` (`router.param` → `resolveIssueRouteId`, `server/src/routes/issues.ts:8262-8279`). Issue detail routes return a private `ETag` and answer `304` to `If-None-Match` (`issues.ts:3643`, `server/src/middleware/private-json-etag.ts`). Errors look like `{"error": "..."}`.

### Companies
- `GET /companies?scope=accessible` returns `Company[]` (`server/src/routes/companies.ts:380`).
- `GET /companies/:companyId` returns one company.
- Company fields (`packages/shared/src/types/company.ts`): `id`, `name`, `description`, `status`, `issuePrefix`, `issueCounter`, `budgetMonthlyCents`, `spentMonthlyCents`, `createdAt`, `updatedAt`.

### Agents
- `GET /companies/:companyId/agents` and `GET /agents/:id` (`agents.ts:3939,4171`).
- Agent fields (`types/agent.ts:89-121`): `id`, `companyId`, `name`, `urlKey`, `role`, `title`, `status`, `reportsTo`, `adapterType`, `adapterConfig` (holds `model`, `cwd`, `env`), `runtimeConfig`, `lastHeartbeatAt`, `createdAt`, `updatedAt`.
- Adapter types: `claude_local`, `codex_local`, `paperclip_runner`, `cursor`, `cursor_cloud`, `gemini_local`, `grok_local`, `hermes_local`, `hermes_gateway`, `kimi_local`, `opencode_local`, `pi_local`, `openclaw_gateway`, `process`, `http` (`packages/shared/src/constants.ts:28-44`).
- `GET /agents/:id/task-sessions` (board only) returns `agent_task_sessions` rows: `taskKey` (normally the issue id), `sessionParamsJson` (`{sessionId, cwd, ...}`), `sessionDisplayId`, `lastRunId`, `adapterType`.
- `GET /agents/:id/runtime-state` returns `sessionId`, `totalInputTokens`, `totalCostCents`.

### Goals and projects
- `GET /companies/:companyId/goals`, `GET /goals/:id` (`goals.ts:14,21`).
- `GET /companies/:companyId/projects`, `GET /projects/:id`, `GET /projects/:id/workspaces` (`projects.ts:333,361,652`). A project workspace has `name`, `cwd` and `repoUrl`.

### Issues
`GET /companies/:companyId/issues` (`issues.ts:8553-8915`):

- **Filters:** `status` (comma-separated), `assigneeAgentId` (UUID or `null`), `projectId`, `parentId`, `labelId`, `q`, `originKind`, `includeRoutineExecutions`, `view` (`compact`, `index` or `rows`), `ids` and `parentIds` (at most 100).
- **Sync parameters:** `updatedSince` (ISO), `sortField` (`updated`, `created` or `id`), `sortDir`, `limit` (default **500**, max **1000**; `server/src/services/issues.ts:270-271`), `offset`, and `afterId`. `afterId` requires `sortField=id&sortDir=asc` with no offset (`services/issues.ts:8237`).
- **How `updatedSince` filters:** strictly `issues.updatedAt > since` (`services/issues.ts:8408-8412`).
- **Throttling:** too many concurrent requests get `429` with `Retry-After` and `{error, retryAfterSeconds}`.

`GET /issues/:id` (`issues.ts:9512`) returns the issue with:

- `project`, `goal`, `ancestors`, `planDocument`, `documentSummaries`, `currentExecutionWorkspace` (which has `cwd`, `repoUrl`, `branchName`), `workProducts`, `lastActivityAt`, `activeRun`.
- Core fields (`types/issue.ts:862-974`): `id`, `companyId`, `identifier` (for example `PAP-12`), `issueNumber`, `title`, `description`, `status`, `priority`, `assigneeAgentId`, `assigneeUserId`, `createdByAgentId`, `createdByUserId`, `parentId`, `projectId`, `goalId`, `executionRunId`, `checkoutRunId`, `conversationAgentId`, `startedAt`, `completedAt`, `cancelledAt`, `createdAt`, `updatedAt`.
- Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low` (`constants.ts:190-218`).

### Comments
- `GET /issues/:id/comments?order=asc|desc&after=<commentId>&limit=N` (`issues.ts:16644`). The default order is `desc`. `limit` is capped at `MAX_ISSUE_COMMENT_LIMIT = 500` (`issues.ts:400`). `afterCommentId` is an alias for `after`.
- `GET /issues/:id/recent-comments` returns `{comments, latestCommentId, hasMore}`.
- `IssueComment` fields (`types/issue.ts:1056-1086`): `id`, `issueId`, `authorType` (`user`, `agent` or `system`), `authorAgentId`, `authorUserId`, `onBehalfOfUserId`, `createdByRunId`, `body` (markdown), `presentation` (kind `message` or `system_notice`), `metadata`, `origin`, `deletedAt`, `createdAt`, `updatedAt`.
- **Posting a comment bumps the issue's `updatedAt`** (`services/issues.ts:13525-13529`). This is what makes `updatedSince` reliable for comment activity.

### Other issue reads
- `GET /issues/:id/documents`, `/documents/:key`, `/documents/:key/revisions`
- `GET /issues/:id/interactions`
- `GET /issues/:id/attachments` and `GET /attachments/:attachmentId/content`
- `GET /issues/:id/activity`
- `GET /issues/:id/approvals`

### Approvals
- `GET /companies/:companyId/approvals?status=pending`, `GET /approvals/:id`, `GET /approvals/:id/issues`, `GET /approvals/:id/comments` (`approvals.ts:215-509`).
- Approval fields: `id`, `type` (for example `hire_agent` or `approve_ceo_strategy`), `status`, `payload`, `decisionNote`, `decidedByUserId`, `decidedAt`, `createdAt`, `updatedAt`.

### Heartbeat runs (agent executions)
- `GET /companies/:companyId/heartbeat-runs?agentId=&limit=&summary=true&latestFailuresOnly=` (`agents.ts:6990`).
  - Ordered by `createdAt desc`. Default 200, max 1000 (`constants.ts:1510-1511`).
  - **There is no since-cursor.**
- `GET /companies/:companyId/live-runs?limit=&minCount=&distinctTasks=`
- `GET /issues/:id/runs` (`activity.ts:370`). Optional `runIds=` (up to 100) or `view=recent`. Each row has `runId`, `status`, `agentId`, `adapterType`, `startedAt`, `finishedAt`, `createdAt`, `invocationSource`, `usageJson`, `resultJson`, `logBytes`, `retryOfRunId`, `livenessState`, `wakeCommentId`, `contextCommentId` (`server/src/services/activity.ts:435-470`).
- `GET /heartbeat-runs/:runId` (`agents.ts:7159`) returns the full `HeartbeatRun` (`types/heartbeat.ts:158-240`):
  - Identity and status: `id`, `companyId`, `agentId`, `issueId`, `scopeKind`, `invocationSource` (`timer`, `assignment`, `on_demand` or `automation`), `status`.
  - Status values: `queued`, `scheduled_retry`, `running`, `succeeded`, `interrupted`, `failed`, `cancelled`, `timed_out`.
  - Timing and outcome: `startedAt`, `finishedAt`, `error`, `exitCode`, `usageJson`, `resultJson`, `durationMs`, `costUsd`.
  - Sessions: **`sessionIdBefore`, `sessionIdAfter`**.
  - Log location: `logStore` (`local_file` or `s3_segments`), `logRef`, `logBytes`.
  - Output: `stdoutExcerpt`, `lastOutputAt`, `contextSnapshot`. Runs also carry a `runtimeMode` column (`native` or `legacy`; `packages/db/src/schema/heartbeat_runs.ts`).
- `GET /heartbeat-runs/:runId/log?offset=&limitBytes=` (`agents.ts:7674`) returns `{runId, store, logRef, content, nextOffset?}`. `limitBytes` defaults to 256,000 and is capped at 1 MiB (`agents.ts:341-342`). `content` is NDJSON; each line is `{ts, attemptId?, stream: "stdout"|"stderr"|"system", chunk, seq?}` (`server/src/services/run-log-store.ts:373-381`).
- `GET /heartbeat-runs/:runId/events?afterSeq=&limit=200[&view=conversation]` (`agents.ts:7643`) returns `HeartbeatRunEvent[]`: `id`, `runId`, `agentId`, `seq`, `eventType`, `stream`, `level`, `message`, `payload`, `createdAt` (`types/heartbeat.ts:300-313`).
  - Native-runner runs put their transcript here as `payload.prpEvent` (schema `paperclip.prp.event.v1`).
  - `view=conversation` keeps only assistant messages, runtime requests and turn or terminal events (`server/src/services/heartbeat/conversation-events.ts`).
- `GET /heartbeat-runs/:runId/issues` and `GET /issues/:issueId/live-runs`.

### Costs
- `GET /companies/:companyId/costs/summary|by-agent|by-agent-model|by-provider|by-project|finance-events|window-spend` and `GET /issues/:id/cost-summary` (`costs.ts:99-379`).
- `cost_events` columns: `agentId`, `issueId`, `projectId`, `heartbeatRunId`, `provider`, `model`, `inputTokens`, `cachedInputTokens`, `outputTokens`, `costCents`, `occurredAt`.

### Activity
- `GET /companies/:companyId/activity?agentId=&entityType=&entityId=&limit=`
- `GET /companies/:companyId/timeline?from=&to=&issueId=&projectId=&limit=&offset=`

### OpenAPI
- `GET /api/openapi.json` (`server/src/routes/openapi.ts:13130`).

## 3. Authentication, CORS, and what a Chrome extension needs

**How the server identifies a caller** (`server/src/middleware/auth.ts:217-522`):

- **`local_trusted`:** every request with no bearer token becomes `{type:"board", userId:"local-board", isInstanceAdmin:true, source:"local_implicit"}`. **No key is needed.**
- **Bearer `pcp_board_<48 hex>`:** a board API key (`server/src/services/board-auth.ts:34-35`, table `board_api_keys`) gives full board access for that user, with `source:"board_key"`.
- **Bearer agent API key or run JWT:** agent-scoped access (`agent_key` or `agent_jwt`). These keys are created with `POST /agents/:id/keys`. They have a restricted view, so they are not suitable for Threadkeeper.
- **Better Auth session cookie:** `source:"session"`, authenticated mode only.

**Getting a board key without asking the user to paste anything.** The CLI's approval flow works for an extension too (`server/src/routes/access.ts:2785-2885`, `doc/CLI.md:9-35`):

1. `POST /api/cli-auth/challenges` with `{command:"Threadkeeper sync", clientName:"Threadkeeper", requestedAccess:"board", requestedCompanyId?}`. This call is anonymous.
2. The `201` response is `{id, token, boardApiToken, approvalPath, approvalUrl, pollPath, expiresAt, suggestedPollIntervalMs:1000}`.
3. Open `approvalUrl` (`/cli-auth/<id>?token=…`) in a tab. The user signs in and approves.
4. Poll `GET /api/cli-auth/challenges/:id?token=<token>` until `status` is `"approved"`. Status values are `pending`, `approved`, `cancelled` and `expired`. The challenge lasts 10 minutes.
5. Use `boardApiToken` as `Authorization: Bearer`. Confirm it with `GET /api/cli-auth/me`.
6. Revoke it with `POST /api/cli-auth/revoke-current`.

Limits: board keys expire after 30 days (`BOARD_API_KEY_TTL_MS`, `board-auth.ts:17`); creating challenges is rate-limited to 20 per minute per IP.

**Other ways to get a key:**
- From a signed-in session: `GET`, `POST` or `DELETE /api/board-api-keys` (body `{name, expiresAt?, requestedCompanyId?}`).
- A key the user pastes in.

**CORS.** The server sends no CORS headers except on plugin UI static files (`server/src/routes/plugin-ui-static.ts:494`). Threadkeeper must therefore call Paperclip from the extension service worker or extension pages. That requires `host_permissions` for `http://localhost:3100/*` and `http://127.0.0.1:3100/*`, plus a user-configured origin with optional permissions for LAN, Tailscale or custom ports. Content scripts cannot make these calls.

**Two guards that can block requests:**
- `boardMutationGuard` only checks `Origin` on non-GET requests, and skips `local_implicit` and `board_key` actors (`server/src/middleware/board-mutation-guard.ts:76-105`). Reads are never blocked by it.
- In private mode, a custom hostname must be on the allow-list (`npx paperclipai allowed-hostname <host>`, `server/src/middleware/private-hostname-guard.ts`).

## 4. Real-time events

**Endpoint:** a WebSocket at **`/api/companies/:companyId/events/ws`** (`server/src/realtime/live-events-ws.ts:107-108`). The server sends no SSE.

**Who can connect** (`live-events-ws.ts:150-243`):

| Caller | Accepted? |
|---|---|
| No token, `local_trusted` instance | yes |
| Better Auth session cookie, authenticated instance | yes |
| Cloud tenant headers | yes |
| Agent API key (as Bearer or `?token=`) | yes |
| **Board key (`pcp_board_…`)** | **no**. The socket only looks keys up in `agentApiKeys`, so the upgrade gets `403`. |

In practice, Threadkeeper gets push events in local mode, and should poll in authenticated mode unless session cookies work from the extension.

**Message format:**
- Server events: `{id, companyId, type, createdAt, toastEligible?, payload}` (`packages/shared/src/types/live.ts`).
- Event types (`constants.ts:948-962`): `heartbeat.run.queued`, `heartbeat.run.status`, `heartbeat.run.progress`, `heartbeat.run.event`, `heartbeat.run.log`, `heartbeat.run.activity`, `agent.status`, `agent.session.goal.changed`, `activity.logged`, `external_object.updated`, `plugin.*`.
- `activity.logged` payload: `{issueId, actorType, actorId, action, entityType, entityId, agentId, runId, details}` (`server/src/services/activity-log.ts:191-205`). The action is `issue.comment_added` for comments, `issue.updated`, and so on.
- **Opt-in transcript streaming:** the client sends `{type:"live.hello",version:1,capabilities:["run-interests"]}` and gets back `live.capabilities`. It then sends `{type:"live.interests",version:1,revision,runIds:[...]}` and gets `live.subscribed`.
- For runs the client has not subscribed to, full `heartbeat.run.event` and `heartbeat.run.log` messages are reduced to `heartbeat.run.activity` (at most 1 per run per second). The server may send `live.resync`, after which the client must re-read over HTTP (`doc/live-transcript-delivery.md`).

## 5. How runs relate to Claude Code and Codex sessions

**Sessions persist per agent and task.** An `agent_task_sessions` row is keyed by `(agentId, taskKey)`, and `taskKey` is the issue id (`server/src/services/heartbeat/run-preparation.ts:1544-1556`). Each heartbeat resumes the same CLI session. Every run records `sessionIdBefore` and `sessionIdAfter`.

**`claude_local` adapter:**
- It runs `claude --print --output-format stream-json --verbose [--resume <id>]` in the workspace cwd (`packages/adapters/claude-local/src/server/execute.ts:846-848`).
- Session params are `{sessionId, cwd, promptBundleKey, workspaceId?, repoUrl?, repoRef?}` (`execute.ts:1162-1176`).
- The config dir is the shared `~/.claude`, or `$CLAUDE_CONFIG_DIR` (`claude-config.ts:123-128`).
- **The transcript on disk is `~/.claude/projects/<cwd with non-alphanumerics replaced by "-">/<sessionId>.jsonl`** (`execute.ts:1399-1401`). This is the file Threadkeeper's `src/core/cli-sessions.ts` already imports.
- The link is: Paperclip `run.sessionIdAfter` equals the Threadkeeper `claude_code` thread's `sourceConversationId`.
- Exception: agents using **managed AI connections** run with a temporary `CLAUDE_CONFIG_DIR` under `os.tmpdir()` (`server/src/services/ai-connection-runtime.ts:199-206,327-337`). Those JSONLs do not survive, so the Paperclip run log is the only copy.

**`codex_local` adapter:**
- **The default `CODEX_HOME` is managed: `~/.paperclip/instances/default/companies/<companyId>/codex-home`.** Skill or connector runtimes use `.../codex-home/{skill|connector}-runtimes/<agentId>/<digest>` (`packages/adapters/codex-local/src/server/codex-home.ts:169-181`, `execute.ts:687-741`).
- Rollouts are written under `<CODEX_HOME>/sessions/...`, not `~/.codex/sessions`. Threadkeeper's Codex importer needs these as extra roots to see Paperclip-driven sessions.
- The link is: `sessionIdAfter` equals the Codex thread id.

**Workspaces:**
- The default agent workspace is `~/.paperclip/instances/default/workspaces/<agentId>` (`server/src/home-paths.ts`).
- Issues may instead use a project workspace `cwd` or an execution workspace (git worktree) at `issue.currentExecutionWorkspace.cwd`.

**Run logs on disk:** `~/.paperclip/instances/default/data/run-logs/<companyId>/<agentId>/<runId>.ndjson`, unless S3 storage is configured (`run-log-store.ts:333-336,563`).

**Turning a log into a transcript.** The UI's `buildTranscript` concatenates `stdout` chunks, splits them on newlines, and runs each line through the adapter's parser (`ui/src/adapters/transcript.ts:102-145`; Claude's parser is `packages/adapters/claude-local/src/ui/parse-stdout.ts`). The result is `TranscriptEntry` items (`packages/adapter-utils/src/types.ts:695-712`) with these kinds: `assistant`, `thinking`, `user`, `tool_call`, `tool_result`, `init` (`model`, `sessionId`), `result` (tokens, `costUsd`), `system`, `stderr`, `run_result`, `run_terminal`.

For native-runner runs (`runtimeMode:"native"`), read `/events?view=conversation` instead. Assistant text is at `payload.prpEvent.payload.text` or `payload.prpEvent.payload.item.text`, for item kinds `agent_message` and `assistant_message` (`ui/src/components/transcript/native-run-events.ts:44,735-750`).

**Your Grok Bot, Dots and Muse request.** Inside Paperclip these are `paperclip_runner` agents with `adapterConfig.provider` set to `grok_bot`, `openai_dot` or `muse`. They are experimental and off by default (`doc/grok-bot-agent.md`, `doc/openai-dot-runner.md`, `doc/muse-personal-agent.md`).
- Their runs are native, and Paperclip only sees what they report: "it cannot inspect every private Muse conversation/tool call".
- Grok Build is `grok_local`, or `paperclip_runner` with `provider:"acpx"` and `acpxAgent:"grok"` (`doc/grok-native-runner.md`).
- A Paperclip integration therefore captures their *task-level* work through issues, comments and the PRP events they report. It does not give Threadkeeper access to their private native chat histories.

## 6. Plugins and MCP

- **`@paperclipai/mcp-server`** (`packages/mcp-server/README.md`) is a thin stdio MCP wrapper over the same REST API. It is configured with `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` and `PAPERCLIP_COMPANY_ID`, and offers tools such as `paperclipListIssues`, `paperclipGetIssue` and `paperclipListComments`. It is meant for agents; a Chrome extension cannot host a stdio MCP server.
- **Plugins** (`doc/plugins/PLUGIN_SPEC.md`) are out-of-process workers on the server, with capabilities such as `events.subscribe` (for example `issue.comment.created`), `webhooks.receive`, `http.outbound` and UI slots. A plugin could push events to Threadkeeper, but the extension has no server to receive them. A plugin only makes sense later, for example a "Send to Threadkeeper" UI action.
- **Recommendation:** call the REST API directly, with the WebSocket as a change hint in local mode.

## 7. Recommended Threadkeeper model

### Threads
Make **one thread per Paperclip issue**, including Agent Chat conversations.
- Agent Chat conversations are issues with `conversationAgentId`, listed by `GET /companies/:id/chats` when the experimental `enableAgentChat` setting is on (`issues.ts:18708`).
- A thread contains the issue description, the comment thread and the run transcripts of the agents that worked on it.
- One thread per heartbeat would fragment the work: a single task can have dozens of runs, and they share one resumed CLI session per agent.
- Store `runIds` and `sessionIdAfter` values in the thread's metadata. When a matching `claude_code` or `codex` thread already exists, show a "linked CLI session" badge or merge rather than duplicating it.

### ConversationRecord mapping
- `provider`: a new `'paperclip'` entry in `PROVIDER_IDS` (`src/core/providers.ts`).
- `accountId`: the instance origin plus `userId` from `/api/cli-auth/me`, or `local-board`.
- `workspaceId`: `companyId`.
- `sourceConversationId`: `issue.id` (a stable UUID). `branchId`: `'main'`.
- `title`: `` `${identifier} ${title}` ``.
- `project` and `providerProjectName`: `issue.project?.name`, then `goal?.title`, then `company.name`.
- `canonicalUrl`: `${origin}/${company.issuePrefix}/issues/${identifier ?? id}`. UI routes are `:companyPrefix/issues/:issueId` (`ui/src/App.tsx:333,867`; `issueUrl()` prefers `identifier`, `ui/src/lib/utils.ts:261`). The unprefixed `/issues/:id` redirects.
- Other deep links: a run is `/${prefix}/agents/${agent.urlKey}/runs/${runId}` (`App.tsx:295`); a chat is `/${prefix}/chats/${agentRef}`.
- `createdAt`: `issue.createdAt`. `updatedAt`: the later of `issue.updatedAt` and `lastActivityAt`.
- `workspacePath`: `currentExecutionWorkspace.cwd`, then the latest run's `sessionParamsJson.cwd`, then the project workspace `cwd`.
- `modelSlug`: the `init` transcript entry's `model`, then the assignee's `adapterConfig.model`.
- `resumeCommand`:
  - `claude_local`: `cd <cwd> && claude --resume <sessionIdAfter>`, with a `CLAUDE_CONFIG_DIR=` prefix if non-default.
  - `codex_local`: `CODEX_HOME=<managed home> codex resume <id>`.
  - Otherwise `null`. Note that resuming outside Paperclip forks the session from Paperclip's view.
- `workflowState`: `in_progress` → `active`; `in_review` → `needs_review`; `todo` and `backlog` → `waiting`; `blocked` → `paused`; `done` → `done`; `cancelled` → `archived`.

### MessageRecord mapping
Order messages by `createdAt`.
- **Issue description:** `role:'user'`, `sourceMessageId: issue:<id>:description`.
- **Comments:** `authorType:'user'` → `user`; `agent` → `assistant`; `system`, or `presentation.kind:'system_notice'`, → `system`. Skip comments with `deletedAt`. `sourceMessageId: comment:<id>`.
- **Run transcripts:** insert each run as a block, keyed `run:<runId>:<seq|lineIndex>`.
  - `assistant` (non-delta, or deltas merged by `itemId`) → `assistant`.
  - `user` → `user`.
  - `tool_call` and `tool_result` → `tool`, truncated.
  - `init`, `result`, `run_result`, `stderr`, `system` → one compact `system` line per run (status, cost, tokens).
  - Drop `thinking` and `stdout` noise.
- **Optional extras:** `planDocument.body` as a `system` message, and pending `interactions` and `approvals` as `system`.

### Incremental sync
Per instance and company:

1. **Find changed issues.** Call `GET /companies/:cid/issues?updatedSince=<cursor>&sortField=updated&sortDir=asc&limit=500&offset=…`. Set the cursor to the maximum `updatedAt` seen minus about 2 seconds, because the filter is strictly greater-than and timestamps can tie; dedupe by id. Do the first backfill with `sortField=id&sortDir=asc&afterId=<lastId>`.
2. **Fetch each changed issue.** Call `GET /issues/:id` with `If-None-Match`. Then `GET /issues/:id/comments?order=asc&after=<lastCommentId>&limit=500`. Then `GET /issues/:id/runs`. For runs that are new, or whose `logBytes` grew, call `GET /heartbeat-runs/:runId/log?offset=<storedNextOffset>&limitBytes=1048576` and loop on `nextOffset`. For native runs, call `/events?view=conversation&afterSeq=<lastSeq>`.
3. **Catch run changes separately.** Runs may not touch the issue's `updatedAt`. Poll `GET /companies/:cid/heartbeat-runs?summary=true&limit=200`, which is newest first, and stop at the first known unchanged terminal run. Terminal statuses are `succeeded`, `failed`, `cancelled`, `timed_out` and `interrupted`. Re-fetch the run's `issueId`.
4. **Trigger syncs.** In local mode, use `activity.logged` (where `entityType` is `issue`) and `heartbeat.run.status` events over the WebSocket to schedule step 2 for that issue, with a timer fallback. In authenticated mode with a board key, use a timer only, for example 60 seconds with backoff on `429`.

Sources:
- [paperclipai/paperclip on GitHub](https://github.com/paperclipai/paperclip)
- [Paperclip docs: deployment modes](https://docs.paperclip.ing/reference/deploy/deployment-modes/)
- [jimmysong.io: Paperclip overview](https://jimmysong.io/ai/paperclip)
- [fast.io: Paperclip AI review 2026](https://fast.io/resources/paperclip-ai-review-2026/)
- [Zeabur template (release history)](https://zeabur.cn/templates/E6H44N)