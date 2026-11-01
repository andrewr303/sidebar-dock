# Still integrations

Still stores its library on this device. External services connect only after you configure them and choose an action. No account, AI subscription or network connection is required for local bookmarking and notes.

## Claude and Codex: your local library

The included MCP bridge lets desktop MCP clients search your actual Still library, read notes and highlights, and queue new notes, bookmarks, collections and edits. It uses Node.js built-in modules; there are no packages to install. Node.js 22 or later is required.

The fastest setup is two commands from the repository folder:

```bash
npm run connect -- claude     # or codex, desktop (Claude Desktop), cursor, opencode, gemini; add --skill for the agent skill
npm run bridge                # start the bridge (node bridge/server.mjs) and leave it running
```

`npm run connect` creates `bridge/.local/config.json` with a random token on first use, adds the `still` entry to the chosen client through the same reviewed connection service as the in-app **Connect** button, and prints the bridge URL, the token and the pairing steps. `npm run connect -- status` shows whether the bridge is running and whether Still is syncing.

Step by step, or to configure a client by hand:

1. Start the bridge in a terminal from the repository folder: `npm run bridge` (or `node bridge/server.mjs`).
2. Open `bridge/.local/config.json`. The first run creates a random token there. Keep this file private; it is excluded from Git. Windows filesystem access follows the containing directory's ACLs.
3. In Still → Settings → Agents & MCP, paste that token and the default URL `http://127.0.0.1:43123`, then connect. Approve Chrome's optional loopback permission when prompted. Keep a Still sidebar or full-tab view open for synchronization. The bridge updates about every two seconds while the view is open; closing every Still view stops sync. It does not run a browser or restart your applications.
4. Add the local MCP entry to your chosen client and restart or reconnect that client when convenient.

In the examples below, replace `/path/to/sidebar-dock` with this repository's absolute path and `node` with the absolute path of your Node.js executable (Still shows both once the bridge is paired, and `npm run connect` uses them automatically). Using the same absolute paths as automatic setup keeps the entry from being reported as a conflict later.

Claude Code (user scope, available in every project):

```bash
claude mcp add --transport stdio --scope user still -- node "/path/to/sidebar-dock/bridge/mcp.mjs"
```

Claude Desktop: merge this entry into `claude_desktop_config.json` (macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`, Linux `~/.config/Claude/`; Settings → Developer → Edit Config opens it), then fully quit and reopen Claude Desktop:

```json
{
  "mcpServers": {
    "still": {
      "command": "node",
      "args": ["/path/to/sidebar-dock/bridge/mcp.mjs"]
    }
  }
}
```

Codex `~/.codex/config.toml` (merge, preserving existing entries), or `codex mcp add still -- node "/path/to/sidebar-dock/bridge/mcp.mjs"`:

```toml
[mcp_servers.still]
command = "node"
args = ["/path/to/sidebar-dock/bridge/mcp.mjs"]
```

These are manual configuration examples. **Settings → Agents & MCP** in Still and `npm run connect` can review and explicitly apply a client connection, preserving unrelated settings and recording a backup/receipt. It can also install the bundled agent skill. No client is configured, launched or restarted automatically. The stdio adapter reads its token from the local configuration file. No secret belongs in the client examples. Override the configuration file path with `STILL_BRIDGE_CONFIG` in both bridge and MCP process environments if needed. For another port, change the loopback URL in that file and in Still, then restart the bridge yourself.

Ask your client: “Find my bookmarks about motion, read their notes, and create a linked note summarizing my findings.” With semantic search turned on in Still, the agent can also find items by meaning (“what did I save about making animations feel calm?”) through `semantic_search`, which uses Still's own embedding index; the bridge stores no vectors. Saved text is untrusted reference material. MCP tools declare that source text cannot become instructions for the agent.

The current server exposes **32 tools** for paginated traversal, keyword and semantic search, notes, captured source, highlights and annotations, relationships, item/collection edits, bulk organizing of up to 100 items, global tags, recoverable trash/restore, explicitly confirmed permanent deletion, exports, and chunked original-file reads. The exact tool catalogue, connection controls and skill workflow are in [MCP and agent skills](mcp-agents.md). Clients should discover the live schemas rather than assume a prefix or historical list.

Mutations first return `status: "queued", saved: false`. The client must check `get_operation` for `saved` or `failed`, then re-read the record. The extension checks `expectedUpdatedAt` inside its serialized write queue. Global tag edits use the library revision. Read-file operations become `completed`, not `saved`; explicit file reads return at most 65,536 bytes per chunk. Source text and personal notes remain separate fields.

The server listens only on `127.0.0.1`. It validates Host, Origin and a bearer token, bounds input size (16 MiB per request, 64 MiB for the library sync), and exposes no arbitrary filesystem APIs. Routes match on the path, so a query string does not change which route answers. Any Chrome extension origin is accepted because the token is the real gate; to accept only your installed Still, add `"extensionIds": ["<32-letter extension ID>"]` to `bridge/.local/config.json` and restart the bridge. Snapshots stay in bridge process memory and disappear when it exits. The bridge receives notes, saved metadata and highlights; settings, integration tokens and embedded image covers stay out of periodic snapshots. Original file bytes stay in IndexedDB until a client explicitly requests a bounded read_file operation, then only the requested chunk passes through the local bridge and its receipt. External image URLs may remain as metadata. Disconnect in Still to stop sharing; terminate your bridge process when finished.

Advanced clients can use authenticated Streamable HTTP at `http://127.0.0.1:43123/mcp`; POST returns a JSON MCP response. GET returns 405 because no SSE stream is maintained. The stdio entry above works with both clients without putting the token into their settings. The bridge supports MCP initialization, ping and tools; it does not implement resources, prompts, elicitation or subscriptions.

## Raindrop.io library import and selected-item export

Create an application in [Raindrop's App Management Console](https://app.raindrop.io/settings/integrations) and copy its Test token for your own account. In Still → Integrations, paste the token and connect. Chrome asks for optional access to `https://api.raindrop.io/`. The token is stored separately in `chrome.storage.local` on this device, never in the portable library backup or bridge snapshot.

Choose **Import library** to fetch all root and nested collections and paginate saved items 50 at a time. Still maps collection hierarchy, tags, notes, favorites and highlights, including highlight annotations. It reads Raindrop; it does not delete or move remote data. Fetch failure leaves the local library unchanged. A successful import merges by stable `raindrop-<id>` identifiers, so repeated imports update the same imported entries. Reimporting intentionally refreshes those entries from Raindrop and can replace local edits to them; export a local backup first if you need those edits preserved. Items already saved independently in Still may share a URL with imported entries.

Choose **Send to Raindrop** on a selected item to upload its URL, title, description, note, tags, favorite flag and highlights. Imported items update their original Raindrop ID; other items create a remote bookmark in Unsorted. Local-only collections are not automatically created remotely. Uploaded file bytes, standalone notes without URLs and library-wide two-way synchronization are not supported. Disconnect removes the local token. This uses personal-token authentication, not an OAuth app with a client secret embedded in an extension.

Raindrop's own remote MCP server is separate from the included local Still bridge. Its official address is `https://api.raindrop.io/rest/v2/ai/mcp`, using Streamable HTTP with OAuth. Its access and search capabilities depend on the Raindrop account and plan. [Raindrop's MCP documentation](https://help.raindrop.io/integrations/mcp), [Claude connection guide](https://help.raindrop.io/integrations/claude).

## GitHub and Linear for dashboard widgets

The GitHub and Linear widgets use accounts connected in **Settings → Connected accounts** or from the widget's own Connect button. Credentials are stored under their own key in `chrome.storage.local` on this device, never in the library, portable backups, exports, widget settings, the widget cache or bridge snapshots. Chrome asks for optional access to `https://api.github.com/` (plus `https://github.com/` for device sign-in) or `https://api.linear.app/` when you connect.

GitHub widget: personal access token, OAuth device flow with your own OAuth app, or the GitHub CLI / `GITHUB_TOKEN` through the local bridge (`GET /github/token`, pairing token required).

- **Personal access token:** a classic token with `repo`, `read:org`, `workflow` and `notifications` unlocks every feature. Fine-grained tokens work for pull requests in the repositories you choose.
- **Sign in (OAuth device flow):** create an OAuth app in GitHub's developer settings (any homepage and callback URL), turn on **Enable Device Flow** and paste its client ID. Still shows a code to enter on GitHub and asks for `repo`, `read:org`, `workflow` and `notifications`. The client ID is not a secret, and Still ships no client secret.
- **GitHub CLI through the local bridge:** with the bridge paired, Still calls `GET /github/token` on the loopback bridge with the pairing token. The bridge runs `gh auth token`, or reads `GITHUB_TOKEN` or `GH_TOKEN` from its own environment when the CLI is not signed in, and answers 404 when it finds neither. When the token changes, Still reads it again.

Linear widget: a personal API key from Linear's security settings, checked against Linear's viewer query before it is saved. Disconnect removes the key and cached issues from this device; revoke the key in Linear to stop it working everywhere.

## Other services

The integration directory links to official Raindrop guides for Notion, Readwise, Zapier, Make, n8n and RSS. These open the relevant setup documentation; they are not native Still connections and are not marked connected. Drive and Dropbox are manual backup destinations: export a Still JSON backup, then store that file using your own account. No background cloud upload runs.

## Verification and sources

Automated tests exercise the real loopback HTTP server and extension store together: authenticated sync, queued MCP note creation/edit/trash and acknowledgements, note/highlight search, stale-state errors, rejected Host/Origin/credentials, newline-delimited stdio exchange, 50-item Raindrop pagination, nested data mapping, atomic failure and secret isolation. Raindrop REST is tested against a local mock. No real account token, live provider write, installed Claude/Codex session or OAuth authorization has been used to establish a live-account claim.

Primary references checked October 25, 2026:

- [Raindrop personal access token](https://developer.raindrop.io/v1/authentication/token), [collections API](https://developer.raindrop.io/v1/collections/methods), [paginated bookmarks](https://developer.raindrop.io/v1/raindrops/multiple), [single bookmark fields](https://developer.raindrop.io/v1/raindrops/single).
- [Official OpenAI MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
- [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp).
- [MCP transports specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

## In-app AI

The assistant can call providers directly from the extension, or through the same local bridge for provider credentials kept outside the browser, model discovery, streamed responses, embeddings (`POST /ai/embeddings`) and CLI sessions. It supports the providers listed in [ai-providers.md](ai-providers.md), the Codex sign-in flow in [ai-cli.md](ai-cli.md), and the source-grounded writing contract in [ai-prompts.md](ai-prompts.md). MCP access and an AI provider connection are separate: a coding agent can use the library MCP tools without routing its model through Still.
