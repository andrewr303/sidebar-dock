# Sidebar Dock · Still

**Version 0.4.0** — a local-first Chrome sidebar, new tab dashboard and full-tab workspace for bookmarks, articles, files, highlights and connected notes. Collect a source, think beside it, and bring the same context to your AI or coding agent.

Seven themes, from warm matte Still to Liquid Glass, with light/dark modes, soft edges and reduced-motion support keep the workspace calm. The sidebar, the new tab dashboard and full-tab views share one library. Opening the full workspace preserves the current view, space, filters and open item.

![Still space with a contextual AI sidebar](docs/screenshots/workspace.png)

![Explicit relationships in the dark knowledge map](docs/screenshots/knowledge-map.jpg)

## Start using it

Local bookmarking and notes need no account, build step or dependency installation.

1. Open `chrome://extensions` in Chrome 120 or later and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository's **`extension`** folder.
3. Pin **Still** and click its icon to open the sidebar. New tabs open your dashboard; **Open in a new tab** opens the full workspace.
4. Save a link, write a note, drop a file or use the page's right-click menu.

For an optional browser preview, use an existing **Node.js 22+** installation:

```powershell
node scripts/serve.mjs
```

Open [the local preview](http://127.0.0.1:4173/). Preview storage and extension storage are separate. Chrome capture, context menus, notifications and bookmark access require the loaded extension. See [installation and permissions](docs/INSTALL.md).

## New tab dashboard

New tabs open a dashboard of widgets on a 12-column grid, with a greeting, the date and the weather, and one search bar for the web, your library or the assistant. **Settings → New tab & dashboard** chooses the start page (Dashboard, All items, Inbox, Notes or the AI assistant), the search engine, the greeting and the wallpaper.

- **Boards:** several dashboards, switched from the header. **Edit layout** moves and resizes widgets with the pointer or the keyboard; narrow windows stack them in order. Each widget has its own settings, title and background (card, glass, flat or none).
- **Widgets:** Links folder, Quick links, Notes, Checklist, Sticky notes, Kanban board, Clock, Weather, Calendar, Website, Most visited, Bookmarks, Product Hunt, GitHub and Linear. Library widgets show ordinary Still items, so their links, notes and tasks also appear in search, backups and AI context. Fetched data is cached so a new tab paints at once and refreshes in the background. Widgets that need Chrome access (top sites, bookmarks, a site's address) ask the first time.
- **Sticky notes:** notes that float over a board, move and resize freely, and gather on the **Sticky notes** corkboard. They stay ordinary notes in Notes, search, backups, the assistant and MCP clients. One switch shows or hides them on every board.
- **Wallpaper:** six presets, a color or your own image, with dim and blur, behind the dashboard or every page.

## Themes, full-screen assistant and settings

- **Themes:** Still, White, Liquid Glass, Midnight, Nord, Paper and Rosé recolor the sidebar, side panel, full tab and dashboard. Choose light, dark or system mode, one of seven accents, text size, density, corners, sidebar width, and reduced transparency or motion.
- **Full-screen assistant:** the **AI assistant** view gives a conversation the whole tab: a chats rail with search and history by day, a wide transcript with a docked composer, and a **Context & sources** rail with what the next question is about and the sources of the latest answer. The same chat moves between the side panel's Ask tab, the full-tab panel and this page. **Ask AI** in the dashboard search continues here.
- **Settings:** one searchable page (press `/`) with Appearance, New tab & dashboard, General, Library & backup, AI models, Semantic search, Agents & MCP, Connected accounts, Integrations, Keyboard shortcuts, About and Help. In the side panel it opens as a panel with the same sections.

## Connected accounts

The GitHub and Linear widgets sign in from **Settings → Connected accounts** or from the widget. Credentials stay in this device's extension storage, apart from the library: never in backups, exports, widget settings, cached widget data or bridge sync. Chrome asks for optional access to the service's API when you connect.

| Service | Sign-in |
| --- | --- |
| GitHub | A personal access token (classic with `repo`, `read:org`, `workflow` and `notifications` for every feature, or fine-grained for chosen repositories); **Sign in** with GitHub's OAuth device flow and an OAuth app you own (paste its client ID; Still ships no client secret); or **GitHub CLI**, where the paired local bridge answers `GET /github/token` with `gh auth token` (or `GITHUB_TOKEN` / `GH_TOKEN` from its environment), only with the pairing token |
| Linear | A personal API key, checked with Linear before it is saved |

## One library, connected ideas

- **Mixed content:** bookmarks, captured article text, notes, images, videos and original files. Personal notes stay separate from saved source text.
- **Rich notes:** slash commands, headings, tasks, lists, callouts, quotes, code, dividers, inline formatting, editable tables, collapsible toggles and safe media/source links. Blocks, Markdown and Preview share a portable Markdown representation.
- **Import and embed:** `/import` turns PDF, Word, PowerPoint, Excel, Markdown, HTML, CSV, EPUB, RTF, text and image files into editable blocks, converted on this device, with an optional **Tidy with AI** pass by the provider's fast model at low effort. `/embed` shows live pages, YouTube/Vimeo/Loom videos, Figma, Google Docs and PDFs in a note, or an uploaded file from the library. See [import and embeds](docs/import-and-embeds.md).
- **Spaces:** Inbox for uncollected items; nested collections with descriptions, covers, colors, icons and pins. The icon picker offers about 600 icons in browsable groups, searchable by meaning ("money" finds wallets and coins). Overviews count notes, files/media and links/articles across descendants. Full-tab and sidebar layouts are independent, including per-space preferences.
- **Connections:** related items and computed backlinks let notes, articles and files support the same idea. The **Knowledge map** shows explicit saved links with scope/search/type filters, keyboard navigation and a clear 60-item display cap. Similarity does not create edges.
- **Organization:** tags, favorites, archive, recoverable Trash, reminders, bulk actions, drag-to-collection and grid/list/masonry views.
- **Search:** titles, URLs, descriptions, notes, captured text and highlights. Use `tag:design`, `#design`, `type:note` or quoted phrases.
- **Capture:** right-click pages, links, images or selected text to save sources, highlights and connected notes. Choose visible-page or full-page screenshots; both retain source attribution.

Full-page capture has progress, cancellation before saving, source-page restoration and an explicit result action. It is bounded to **16,384 pixels per axis, 48 megapixels, 50 viewport tiles and a 120-second capture deadline**. Oversized pages fail with guidance to choose visible capture. Protected pages, changing content, nested scroll containers and browser access restrictions can prevent capture.

`Ctrl/⌘ K` searches, `N` creates a note, `A` saves a link and `Ctrl/⌘ Enter` saves an edited note. Extension-wide shortcuts are in [INSTALL.md](docs/INSTALL.md).

## AI and coding agents

The optional local companion handles provider credentials, streaming and coding-agent connections. It uses Node's built-in modules; **there are no npm packages to install**.

```powershell
node bridge/server.mjs
```

The first run creates `bridge/.local/config.json` with a random pairing token. Keep it private. In Still → **Settings → AI models → Local bridge**, enter the loopback address and token, approve Chrome's optional loopback permission and keep a Still view open for sync. Starting the bridge does not configure or launch an AI client.

Open **Settings → AI models** to choose a connection:

| Connection | Supported paths |
| --- | --- |
| API providers | OpenAI Responses, Anthropic Messages, OpenRouter, Cloudflare Workers AI, AWS Bedrock ConverseStream and Google Gemini |
| Compatible/local endpoints | OpenAI-compatible and Anthropic-compatible APIs, Ollama and LM Studio |
| Coding agents | Codex CLI and Claude Code discovered on the bridge's PATH, using supported models and existing CLI authentication |
| Codex OAuth | Explicit **Sign in with ChatGPT** through Codex's official device-code/app-server flow; Codex owns its credentials |
| MCP clients | Claude Desktop, Claude Code, Codex and compatible clients using the local bridge |

Choose exact models and supported effort, temperature, image and context/output limits. API credentials are encrypted in the local companion's storage. Provider tests and model discovery are explicit actions. Sending a prompt uses the selected provider or CLI. Still does not install coding agents or copy Codex account tokens.

The AI sidebar supports selected-item, current-space and relevant-library context, source citations, writing actions, streaming, cancellation, local conversation history and visible partial failures. **Ask about this space** includes its description and active nested content without broadening to other spaces. Responses can become connected notes or be explicitly inserted, appended or substituted into an unsaved draft. Retrieved content remains untrusted reference material.

The MCP server exposes **32 tools** to read and update notes, saved article text, highlights, relationships, collection metadata, tags and item state, plus paginated exports and bounded original-file reads. Mutations return a queued receipt; clients must check `get_operation` for `saved` or `failed`. Revision checks reject stale edits. File reads return at most 65,536 bytes per chunk and never accept arbitrary filesystem paths.

**Settings → Agents & MCP** offers reviewable client setup and installation of the included [Still workspace agent skill](agent-skills/still-workspace/SKILL.md). Configuration and skill installation require an explicit action and return receipts. Keep a syncing Still view open while a client uses the library.

- [Providers and local endpoints](docs/ai-providers.md)
- [CLI agents and official Codex sign-in](docs/ai-cli.md)
- [MCP clients and agent skills](docs/mcp-agents.md)
- [Context and prompt contracts](docs/ai-prompts.md)
- [Raindrop, GitHub and other integrations](docs/integrations.md)

Raindrop import uses your personal token to bring in collections, links, notes and highlights. Selected URL items can be sent back explicitly. Raindrop's remote MCP server is a separate data source. Notion, Readwise, Zapier, Make, n8n and RSS cards link to official guides; Drive and Dropbox are manual backup destinations.

## Data ownership and portability

Library metadata stays in `chrome.storage.local`; original file bytes stay in IndexedDB. Uploads are bounded to **100 MB per file** and portable imports to **200 MB per backup**, subject to available device storage.

**Settings & backup → Full backup** exports sources, personal notes, highlights, connections, nested collection metadata and original file bytes. Import validates before merging and rolls back newly written attachments if a later stage fails. Matching IDs restore those records; device credentials and preferences remain local. A legacy metadata-only backup cannot restore bytes it never contained.

HTML bookmark import/export preserves nested folders. CSV supports quoted multiline fields, notes, tags and descriptions. Markdown export retains personal notes, annotations and source connections. Existing Chrome bookmarks can be imported after granting optional access.

## References and provenance

All **29 supplied reference images** are packaged in **Help → The reference room**, with captions. The [reference catalogue and Fabric expansion notes](docs/fabric-expansion.md) distinguish read-only browser observations and bounded static findings from functionality implemented here.

Original third-party packages, private account observations, copied source and decompiler artifacts are excluded from publication. Static recovery is partial; Sidebar Dock does not claim complete Fabric reconstruction, source-format compatibility or feature parity.

Raindrop's [help centre](https://help.raindrop.io/), [Claude guide](https://help.raindrop.io/integrations/claude) and [integration directory](https://help.raindrop.io/integrations) also informed the library and connection flows.

## Validation and current limits

From Node.js 22+:

```powershell
node --test tests/*.test.mjs
node scripts/check.mjs
node scripts/package.mjs
node scripts/package-runtime.mjs
```

The current local suite contains **743 tests** covering storage/revisions, dashboard layout and backup, widget data, themes, sticky notes, rich-note round trips, nested space boundaries, explicit graph links, capture planning/cancellation/cleanup, binary backup restoration, rejected imports, file conversion against real PDF/Office/EPUB fixtures, AI import fallbacks, embed round trips, provider transports, official CLI login protocol handling and authenticated MCP mutation receipts. Static checks validate imports, assets, manifest/CSP and reference images. Packaging checks validate ZIP entrypoints and integrity.

BrowserOS neo checks exercised table/toggle editing and persistence, space metadata/layout persistence, a locally mocked space-cited AI answer, separate conversations when changing spaces, keyboard map navigation, wide/narrow layouts and dark mode. Screenshots above show the actual isolated preview; no paid model request was made. Reduced-motion styles were checked; animation frame rate was not measured.

Installed-extension activation of native capture, context menus, side-panel APIs and notifications still needs real-browser verification. Account-backed OAuth completion, live Raindrop access, paid inference, provider entitlement and actual Claude/Codex client activation have not been established by local fixtures. Those tests do not establish model answer quality.

There is no cross-device cloud sync, hosted collaboration, semantic embedding index, automatic page-annotation reattachment, video transcription or text extraction from saved PDF/EPUB files (use `/import` in a note to turn one into text). Those files can still be stored, downloaded, tagged, embedded and connected to notes. Sites that refuse framing cannot be embedded; their embeds keep an Open link. Article capture depends on readable page content and permission. Remote covers load from their source sites. The MCP bridge shares with configured local clients while enabled; an external AI provider receives the context selected for that request.
