# Coding agents inside Still

Still's local bridge can send a selected library conversation to an installed **Codex CLI** or **Claude Code**. Choose the agent, model, and reasoning effort in Still, then send a request. The bridge starts a separate, non-interactive child process for that request. It does not resume, queue into, or restart an existing coding session.

CLI availability is discovered from the bridge process's `PATH`. Discovery checks launcher files and supported `--help` flags; it does not run a model or initiate sign-in. If the CLI is absent or too old for the required flags, Still reports that status rather than using another agent. Install or update the CLI yourself using its official instructions, then refresh discovery. No CLI installation is performed automatically.

On Windows, native `.exe` files run directly. Standard npm `.cmd` launchers are parsed for the specific Codex or Claude package entrypoint and that JavaScript file is run through Node directly. The bridge never runs a command shell or evaluates the shim. A configured executable must match the agent's discovered absolute PATH launcher. Arbitrary command strings and additional flags are not accepted.

## Codex sign-in with ChatGPT

Select **Sign in with ChatGPT** to begin an explicit Codex device-code login. Still starts its own `codex app-server --stdio`, initializes the documented JSON-line protocol, and requests `account/login/start` with `type: "chatgptDeviceCode"`. It displays the verification link and code returned by Codex. Open the link yourself and finish sign-in. Device-code access may need enabling in your ChatGPT security settings or workspace policy. [Official Codex authentication documentation](https://developers.openai.com/codex/auth/)

The displayed state remains pending or awaiting your action until `account/login/completed` confirms success. Cancelling sends `account/login/cancel` and stops the bridge-owned login process. A failed, expired, or unsupported login remains a failure. Still does not invent OAuth client IDs, copy a credential cache, read token files, expose account identity, or store Codex access/refresh tokens in the extension. The Codex CLI owns its normal authentication storage. [Official app-server login protocol](https://developers.openai.com/codex/app-server/)

A sign-in job expires after 15 minutes. Finished jobs stay readable for an hour so a status poll still resolves, then the bridge drops them when the next sign-in starts.

Existing Codex authentication can also be used. The status action calls the CLI's read-only login status command and returns only an authenticated/unauthenticated/unknown state and authentication method. It excludes credential text and account details. There is no automatic logout or account switching.

## Execution boundaries

Each generation receives its prompt through stdin, runs in a fresh directory beneath the operating system's temporary folder, and removes that owned directory afterward. User-selected model and effort values are forwarded unchanged as validated individual arguments. Prompt text and credentials are not passed as command-line arguments. The bridge does not modify your current CLI configuration.

Codex runs with `--no-daemon exec --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --sandbox read-only --json`. Per-request configuration disables shell execution, hooks, web search, MCP servers, connected apps, and subagents; project instructions are omitted. Codex's read-only sandbox prevents repository writes. There is no verified universal switch removing every Codex tool, so Still explicitly reports `toolsDisabled: false` and stops the request if the JSON event stream reports a tool or unsupported item. That event check is a detection boundary, not a claim that all possible tool actions were prevented before observation. [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/), [configuration reference](https://developers.openai.com/codex/config-reference/)

Claude runs in print mode with streamed JSON, `--tools ""`, MCP denial and an empty strict MCP configuration, safe/restricted mode, no Chrome integration, disabled slash commands, and no session persistence. Safe mode retains the existing CLI authentication; `--bare` is deliberately omitted because it does not use the subscription login. Claude's initial event is checked for unexpected enabled tools, and any observed tool call stops the request. Organization-managed CLI policy still applies. [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [programmatic usage](https://code.claude.com/docs/en/headless)

The existing Claude login is used. If it is missing, sign in through Claude's own supported authentication flow and refresh status. Still does not collect a Claude password or copy its authentication tokens.

Selected saved text remains untrusted reference material. The CLI integration is for answering, summarizing, and drafting text; the application remains responsible for explicit library writes. Sending a request shares the selected conversation and source excerpts with the selected agent's configured provider and uses that account's normal limits and billing. CLI discovery and offline tests do not establish model access or a successful live request.

## Cancellation and errors

Cancellation targets only the `ChildProcess` retained for the current Still request. Windows cancellation uses that owned PID's process tree with hidden `taskkill.exe`; it never kills agents by process name or selects unrelated sessions. Native child launches set `windowsHide: true` and `shell: false`.

Partial text is streamed as it arrives as NDJSON `delta` events, the same stream API providers use; CLI agents emit no `thinking` events because the bridge reads only their answer text. A generation is limited to 300 seconds, the same limit as API providers. It becomes a completed answer only after the CLI reports a successful terminal event and exits successfully. Invalid JSON, failed turns, nonzero exits, unexpected tools, cancellation, output overflow, and timeouts remain explicit failures. Diagnostic output redacts common API-key, bearer-token, JWT, and named-token patterns. Authentication process output is not forwarded to the UI or retained as a transcript.

## Using Still from these agents

Answering inside Still (this page) and giving an agent access to your library are separate. To let Claude Code or Codex search and edit the library through MCP, run `npm run connect -- claude` or `npm run connect -- codex` from the repository folder; it registers `bridge/mcp.mjs` with `claude mcp add --transport stdio --scope user` or `codex mcp add`, using the same discovered executable as this adapter. See [MCP and agent skills](mcp-agents.md).

## Developer interface

`bridge/ai/cli.mjs` exports `createCliService({ spawn?, which?, cwdRoot? })`. The service provides:

| Method | Result |
| --- | --- |
| `listAgents({ refresh? })` / `discover(...)` | Agent availability, detected launcher, supported capabilities, and restrictions. |
| `generate({ agentId, system, messages, model?, reasoningEffort?, executable?, signal?, onDelta? })` | `{ text, agentId, model?, usage, finishReason: "completed" }`; `onDelta` receives text strings. |
| `startCodexLogin()` | A public login job with `id`, `status`, and verification URL/code when user action is needed. |
| `getLoginStatus(id)` | Current sanitized public job state. |
| `cancelLogin(id)` | Cancels a pending owned login and returns its public state. |
| `authStatus({ agentId? })` | Sanitized auth state for Codex and/or Claude. |
| `dispose()` | Stops processes owned by this service. |

Agent IDs are `codex` and `claude`; UI provider IDs can map `cli:codex` and `cli:claude` to those IDs. `resolveAgentExecutable(agentId)` is also exported for the application's separately authorized MCP configuration actions. It returns a validated `{ path, command, prefix, launchMode, agentId }`, never a shell command string.

Offline checks:

```powershell
node --test tests/ai-cli.test.mjs
```

These tests use mocked child processes. They cover discovery, npm launcher validation, exact safety flags, stdin prompts, response streaming, tool-event rejection, incomplete/failing streams, authentication redaction, explicit device login, cancellation, and owned-process cleanup. They do not perform paid inference, real sign-in, credential changes, or a live OAuth completion.
