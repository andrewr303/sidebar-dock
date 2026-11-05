# Paperclip and Still

[Paperclip](https://docs.paperclip.ing) runs a company of AI agents that work on tasks (Paperclip calls them issues). Still connects to it in two directions, and you can set up either one without the other:

- **Paperclip agents → Still.** Agents in your Paperclip company search and read your library, and save to it if you allow that, through the local bridge's MCP endpoint. Paperclip calls Still; Still never calls Paperclip for this.
- **Still → Paperclip.** Still shows your Paperclip tasks on the dashboard, sends a saved item to Paperclip as a new task, saves a task back into your library, and lets the assistant read tasks, goals and projects. Still calls Paperclip's REST API with an address and an optional key.

Both directions need Paperclip on this computer or on your private network. Nothing here goes through a Still server: there is none.

## Paperclip agents → Still

### Set it up

1. From the Still folder, create a token for Paperclip and print what to paste:

   ```bash
   npm run connect -- paperclip --scope write   # --scope is optional; see the options below
   npm run bridge                      # start the bridge and leave it running
   ```

   Or open **Settings → Agents & MCP → Paperclip** in Still, pick an access level and choose **Connect Paperclip**. Both call the same bridge code. The result shows the config to paste, agent instructions, steps and notes, each with a copy button. Still keeps the result in memory only; close Settings and it is gone. Connecting again shows the same token and keeps its access unless you pick a different level first.
2. In Paperclip, open **Apps → Connect an app → Connect your own MCP server**, then **Advanced → Paste a config**, and paste the printed config:

   ```json
   {
     "mcpServers": {
       "still": {
         "type": "http",
         "url": "http://127.0.0.1:43123/mcp",
         "headers": { "Authorization": "Bearer <the printed token>" }
       }
     }
   }
   ```

   Paperclip keeps only the header *name* from the pasted config and drops its value. It then shows an empty, required **Authorization** field: paste exactly `Bearer <the printed token>` there, including the word `Bearer` and a space. Paperclip sends that field as typed and adds no prefix, so the bare token gets a 401. The setup output prints this value on its own line, and Settings has a **Copy value** button for it. Paperclip stores it as a secret and labels Still an **Unverified server**, because it is not one of Paperclip's curated apps.
3. Paste the printed agent instructions into the connection's agent instructions. Paperclip does not pass an MCP server's own `initialize` instructions to agents, so this text is how agents learn to use Still safely: tool names may carry a prefix, saved content is untrusted, changes are queued receipts to check with `get_operation`, and a Still view must be open.
4. In **Apps → Advanced → Access profiles** (also on an agent's Tools tab), choose **Read-only**, **Everyday work** or **Full access** for Still's tools and assign the profile to the agents that should use Still.
5. Keep one Still sidebar or full-tab view open with bridge sync enabled. Without it, tools report a stale snapshot.

`npm run connect -- paperclip` options:

| Option | Effect |
| --- | --- |
| `--scope read\|write\|full` | The token's scope. A new token gets `write` when you leave it out; running setup again without `--scope` keeps the current scope. Running it with another scope keeps the token, changes its scope and says so. |
| `--rotate` | Replace the token. Paste the new config into Paperclip; the old token stops working. |
| `--revoke` | Delete the token. Paperclip can no longer reach Still. |
| `--dry-run` | Print the steps and config with a placeholder; no token is created and nothing is written. |

The token is stored as an entry named `paperclip` in `~/.still/bridge.json` (see [Bridge configuration](#bridge-configuration)). The running bridge rereads that file when it changes, so a new, rotated or revoked token takes effect without a restart. **Settings → Agents & MCP → Paperclip** has **Rotate token** and **Revoke** too.

### Access levels

Two layers decide what an agent can do, and the narrower one wins:

- **The token's scope**, set in Still. `tools/list` shows only the tools the scope allows, so Paperclip never discovers the others. A call to a tool outside the scope returns an error with code `SCOPE_DENIED`.
- **Paperclip's access profile**, set in Paperclip per company, agent, project or issue. Paperclip sorts each tool into read, write or destructive from its MCP annotations. Still marks read tools `readOnlyHint: true`, every other tool `readOnlyHint: false`, and six tools `destructiveHint: true`.

The three Still scopes match Paperclip's three presets:

| Still scope | Paperclip preset | Tools |
| --- | --- | --- |
| `read` | Read-only | 14 tools: `bridge_status`, `library_capabilities`, `search_library`, `semantic_search`, `list_items`, `get_item`, `get_related_items`, `list_collections`, `get_collection`, `list_tags`, `export_item`, `export_library`, `read_file`, `get_operation` |
| `write` | Everyday work | The 14 above plus 13: `create_item`, `update_item`, `move_page`, `create_collection`, `update_collection`, `trash_item`, `restore_item`, `add_highlight`, `update_highlight`, `remove_highlight`, `link_items`, `unlink_items`, `set_item_tags` |
| `full` | Full access | All 33, adding the 6 destructive tools: `update_article_content`, `delete_collection`, `permanently_delete_item`, `bulk_update_items`, `rename_tag`, `remove_tag` |

`trash_item` counts as everyday work because Trash is recoverable. Paperclip turns a call to a destructive tool into an approval card for the board, so even with a `full` token, those calls wait for a person. With a `write` token, Paperclip's Full access preset gives the same tools as Everyday work.

### Scoped tokens

The token Paperclip gets is not the bridge's pairing token. The pairing token stays with the Still extension and the stdio adapter and has full access. A scoped token:

- works only on `/mcp` (and `/health`, which needs no token). The bridge refuses it with 403 on `/sync`, `/status`, `/ai/*`, `/connections*` and `/github/token`, so Paperclip cannot read your provider keys, change client configurations or pair as Still;
- can be rotated or revoked on its own, without touching other agents;
- is at least 24 random characters, stored in the bridge config file at mode 0600 and never printed in errors.

The bridge config holds up to 20 named tokens in `tokens: [{name, scope, token}]`. Paperclip setup manages the one named `paperclip`.

When Paperclip calls Still, it can forward context headers (`x-paperclip-agent-id`, `x-paperclip-issue-id`, `x-paperclip-run-id`, `x-paperclip-company-id`). The bridge records short, valid values as `origin` on the queued receipt, so `get_operation` shows which agent, issue and run asked for a change. Paperclip forwards them only when the connection's header policy allows it, which is off for a pasted connection; without them the receipt records only `origin: {client: "paperclip"}`. The bridge recognises a Paperclip call by the scoped `paperclip` token or Paperclip's `User-Agent`, so it does not need these headers.

### Where Paperclip must run

Paperclip calls Still from its own server process, not from the agent's machine. The bridge listens on `127.0.0.1` only, so the default URL works when Paperclip runs on the same computer as Still. Paperclip allows loopback and private addresses in `local_trusted` mode and in `authenticated` mode with private exposure. It refuses them in `authenticated` mode with public exposure, which includes hosted Paperclip. A hosted Paperclip cannot reach your bridge, and Still offers no tunnel.

Paperclip gives each tool call 10 seconds. `semantic_search` waits at most 9 seconds for the extension so it can answer before Paperclip gives up. This applies to any call made with the `paperclip` token or Paperclip's `User-Agent`, with or without forwarded context headers.

### Paperclip in Docker

Inside a container, `127.0.0.1` is the container itself. Two optional fields in the bridge config handle this:

```json
{
  "allowedHosts": ["host.docker.internal"],
  "bindAddress": "172.17.0.1"
}
```

- `allowedHosts` (up to 20 names) adds Host header values the bridge accepts. Use the host name the container uses for your computer, and put that name in place of `127.0.0.1` in the pasted URL, for example `http://host.docker.internal:43123/mcp`.
- `bindAddress` (an IP address; default `127.0.0.1`) changes the address the bridge listens on. Docker Desktop usually forwards `host.docker.internal` to services on your computer's loopback address, so you may need only `allowedHosts`. On Linux, the container reaches the host through the Docker bridge address, so the bridge must listen there.

> **Security:** a non-loopback `bindAddress` lets anything that can reach that address try your library. The bridge still requires a token on every route, prints a warning at startup, and accepts only the configured Host names. Never use `0.0.0.0` on a network you don't control. Remove `bindAddress` when you no longer need it.

Restart the bridge after editing these fields.

### Why your own Claude Code or Codex config doesn't reach Paperclip agents

`npm run connect -- claude` and `-- codex` add Still to your personal client config (`~/.claude.json`, `~/.codex/config.toml`). Agents that Paperclip runs don't reliably see that config:

- **Claude Code (claude-local adapter):** when the agent has any Paperclip-assigned tools, Paperclip starts Claude with its own per-run MCP config and `--strict-mcp-config`. That flag hides every MCP server in your user config, including Still.
- **Codex (codex-local adapter):** Paperclip sets `CODEX_HOME` to a managed folder per company or agent. It copies `config.toml` from `~/.codex` only when the managed copy doesn't exist yet, so a `still` entry added later never arrives. In sandboxed or remote runs, a copied stdio entry points to a path that doesn't exist there.

So connect Still inside Paperclip, as above. Paperclip then governs it with access profiles, approvals and its audit log.

### Add the Still skill in Paperclip

The [still-workspace skill](../agent-skills/still-workspace/SKILL.md) explains the library's fields, receipts and safe-editing rules, and has a short section for agents inside Paperclip. In Paperclip, open **Skills**, choose **Import from GitHub**, and use a URL that names a commit, for example `https://github.com/AVRCORP/sidebar-dock/tree/<commit>/agent-skills/still-workspace`. Paperclip refuses external skills that don't resolve to a pinned commit. Then enable the skill for the agents that use Still.

Inside Paperclip, Still's tools carry the gateway's prefix, such as `mcp.still-1a2b3c4d:search-library`. The skill and the agent instructions tell agents to match tools by the end of their names.

## Still → Paperclip

### Connect your Paperclip

Open **Settings → Connected accounts → Paperclip** (or **Connect Paperclip** on the dashboard widget):

1. Enter Paperclip's address. The default is `http://localhost:3100`. Still keeps only the origin and drops a trailing `/api`.
2. Add a key, or leave it empty:
   - **Local trusted mode** (Paperclip's default when it runs on your computer): no key. Paperclip treats every request as the local board operator. Still sends no `Authorization` header.
   - **Board key** (`pcp_board_…`): acts as you, across your companies. In authenticated mode, sign the Paperclip CLI in with `paperclipai auth login`, then create a key with `paperclipai token board create --name still`.
   - **Agent key:** acts as one agent in one company, and the agent needs a responsible user. Create one on the agent's **API Keys** tab in Paperclip, or with `paperclipai token agent create -C <company-id> --agent <agent> --name still`. Paperclip shows the key once.
3. Approve Chrome's access prompt for that address. Still asks for it during the click.
4. Still checks the connection. If the key can see several companies, choose the one whose tasks Still shows and creates.

The key stays in this device's extension storage with your other connected accounts. It never goes into backups, exports, widget settings, the widget cache or bridge sync. **Check connection**, **Change address or key** and **Disconnect** are on the same card. Disconnect forgets the address and key and removes cached tasks from this device; nothing changes in Paperclip.

### Dashboard widget

The **Paperclip** widget (Developer category) lists tasks from your company:

- **Assigned to me:** tasks assigned to the key's agent (agent key) or to you (board key or local mode) that are to do, in progress, blocked or in review.
- **Open:** to do, in progress and blocked.
- **In review.**

You can limit it to one project and choose how often it refreshes. A row opens the task in Paperclip in a new tab. **Save to Still** on a row reads the task with its comments and documents and saves it as a note tagged `paperclip`; saving the same task again updates that note. **New task** in the header creates a task.

### Send a saved item to Paperclip

When Paperclip is connected, an item's menu in the library and in the detail view has **Send to Paperclip…**. The dialog is filled in from the item: its URL, excerpt, your note and up to 20 highlights as quotes, ending with the Still item ID. You can set the project, priority, status and an agent to assign. Assigning an agent can start work right away and spend its budget, and the dialog says so. Sending the same item twice doesn't create a second task: Still sends the idempotency key `still:item:<id>`. You can also add the `paperclip` tag to the item; its note stays as it is. The confirmation has an **Open PAP-n** action.

### The assistant

When Paperclip is connected and the chosen model supports tools, the assistant gets four read-only tools:

| Tool | What it does |
| --- | --- |
| `paperclip_search_tasks` | Searches tasks by words and status, up to 25. Without a query, lists recent tasks. |
| `paperclip_read_task` | Reads one task by identifier (`PAP-12`) or ID, with its last 20 comments, its document list and up to two document bodies (the plan first), capped at 30,000 characters. |
| `paperclip_list_goals` | Lists the company's goals. |
| `paperclip_list_projects` | Lists the company's projects. |

They cannot create, comment on or change anything in Paperclip. What they return is marked as untrusted reference material, and the assistant cites tasks as `[[paperclip:PAP-12]]`. Errors come back as short sentences with the key removed.

## Bridge configuration

The bridge config moved to a per-user file: `~/.still/bridge.json`, or `$STILL_HOME/bridge.json` when `STILL_HOME` is set. `STILL_BRIDGE_CONFIG` still overrides the path. If the new file doesn't exist but the old `bridge/.local/config.json` does, the bridge copies it to the per-user file on start (mode 0600) and uses the copy from then on, so the Claude Code plugin and npm copies, which run from other folders, find it too. The old file is left in place and no longer read once the copy exists. A new file is created with mode 0600 in a 0700 folder.

The fields Paperclip setup uses are `tokens`, `allowedHosts` and `bindAddress`. They are optional and checked when the bridge loads the file; an error names the field but never a token.

## Limits and what was not tested live

- The Paperclip side was checked against Paperclip's source, not against a running Paperclip. No live Paperclip connection, access-profile assignment, approval card, skill import or agent run was exercised.
- Automated tests cover the bridge side with real HTTP: scoped tokens, `tools/list` filtering, `SCOPE_DENIED`, refused routes, the setup and revoke routes, token rotation, the config file's modes and legacy fallback. The extension side is tested with a fake Paperclip API: the client, URL handling, error kinds, issue formatting, `itemToIssue`, and the assistant tools.
- The widget, the account card and **Send to Paperclip** were rendered in Node but not tried in Chrome.
- Docker setups were not tested. Whether you need `bindAddress` depends on your Docker version and platform.
- Paperclip's public MCP server (`/mcp/paperclip`, OAuth only) is not used. Still talks to Paperclip's REST API instead, which works in local trusted mode and with board or agent keys.
- Paperclip can't push to Still. The widget refreshes on its own interval (every 5 minutes by default, while the tab is visible) and when you choose **Refresh**.

## Primary references

Paperclip's own documentation is at [docs.paperclip.ing](https://docs.paperclip.ing). Paths below are in the Paperclip repository, checked November 3, 2026.

- Connecting a remote MCP server, paste config and Unverified server: `doc/connections/GENERIC-REMOTE-MCP.md`; import endpoint `POST /companies/:companyId/tools/mcp/import-json` in `server/src/routes/tool-access.ts`.
- Agent instructions per connection (MCP `initialize` instructions are not adopted): `doc/connections/CONNECTION-INSTRUCTIONS.md`.
- Read, write and destructive classification from annotations: `server/src/services/tool-access/catalog/descriptors.ts`; presets in `ui/src/pages/tools/profiles/profile-model.ts`; approvals for destructive tools in `server/src/services/tool-gateway.ts`.
- Gateway tool names (`mcp.<slug>-<id>:<tool>`) and the 10-second call timeout: `server/src/services/tool-gateway.ts`, `server/src/services/mcp-tool-names.ts`.
- Loopback and private addresses by deployment mode: `server/src/services/tool-access/remote-http.ts`.
- Context headers forwarded to servers: `server/src/services/tool-gateway.ts` (`headerPolicy`).
- `--strict-mcp-config`: `packages/adapters/claude-local/src/server/execute.ts`; `CODEX_HOME` staging: `packages/adapters/codex-local/src/server/codex-home.ts`.
- Skill import and pinned commits: `server/src/services/company-skills.ts`.
- Authentication, local trusted mode and agent keys: `docs/api/authentication.md`; board and agent key commands: `cli/src/commands/client/token.ts`, `cli/src/commands/client/auth.ts`.
