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
- **Settings:** one searchable page (press `/`) with Appearance, New tab & dashboard, General, Library & backup, AI models, Assistant permissions, Research agent, Semantic search, Agents & MCP, Connected accounts, Integrations, Keyboard shortcuts, About and Help. In the side panel it opens as a panel with the same sections.

## Connected accounts

The GitHub and Linear widgets sign in from **Settings → Connected accounts** or from the widget. Credentials stay in this device's extension storage, apart from the library: never in backups, exports, widget settings, cached widget data or bridge sync. Chrome asks for optional access to the service's API when you connect.

| Service | Sign-in |
| --- | --- |
| GitHub | A personal access token (classic with `repo`, `read:org`, `workflow` and `notifications` for every feature, or fine-grained for chosen repositories); **Sign in** with GitHub's OAuth device flow and an OAuth app you own (paste its client ID; Still ships no client secret); or **GitHub CLI**, where the paired local bridge answers `GET /github/token` with `gh auth token` (or `GITHUB_TOKEN` / `GH_TOKEN` from its environment), only with the pairing token |
| Linear | A personal API key, checked with Linear before it is saved |

## One library, connected ideas

- **Mixed content:** bookmarks, captured article text, notes, images, videos and original files. Personal notes stay separate from saved source text.
- **Rich notes:** slash commands, headings, tasks, lists, callouts, quotes, code, dividers, inline formatting, editable tables, collapsible toggles and safe media/source links. Blocks, Markdown and Preview share a portable Markdown representation.
- **Subpages:** a note can live inside another note or inside any saved item, like a page inside a page. `/page` or **Add subpage** creates one and adds a page block (`[[id|Title]]{page}`) that shows its current title. Notes show their page path above the title and a **Subpages** section; the detail view of any item lists its subpages; **Move to page…** and **Move to top level** re-parent a note. Lists show top-level notes, with a chevron or count for subpages; search results include subpages with their path. Moving a page to Trash takes its subpages with it, restoring brings back the ones trashed together, and a page's collection carries down to its subpages. Pages nest at most 32 levels. Deleting a page block never deletes the page.
- **Import and embed:** `/import` turns PDF, Word, PowerPoint, Excel, Markdown, HTML, CSV, EPUB, RTF, text and image files into editable blocks, converted on this device, with an optional **Tidy with AI** pass by the provider's fast model at low effort. `/embed` shows live pages, YouTube/Vimeo/Loom videos, Figma, Google Docs and PDFs in a note, or an uploaded file from the library. See [import and embeds](docs/import-and-embeds.md).
- **Spaces:** Inbox for uncollected items; nested collections with descriptions, covers, colors, icons and pins. The icon picker offers about 600 icons in browsable groups, searchable by meaning ("money" finds wallets and coins). Overviews count notes, files/media and links/articles across descendants. Full-tab and sidebar layouts are independent, including per-space preferences.
- **Connections:** related items and computed backlinks let notes, articles and files support the same idea. The **Knowledge map** shows explicit saved links with scope/search/type filters, keyboard navigation and a clear 60-item display cap. Similarity does not create edges.
- **Organization:** tags, favorites, archive, recoverable Trash, reminders, bulk actions, drag-to-collection and grid/list/masonry views.
- **Search:** titles, URLs, descriptions, notes, captured text and highlights. Use `tag:design`, `#design`, `type:note` or quoted phrases.
- **Capture:** right-click pages, links, images or selected text to save sources, highlights and connected notes. Choose visible-page or full-page screenshots; both retain source attribution.
- **Article capture:** **Save article** keeps a page's readable text as Markdown with its headings, lists, quotes, code, tables, images and video embeds, plus its site, author, publication date, language and icon. **Select parts** lets you click several parts of a page and saves them, in page order, as one article. Both are in the side panel (and its command palette) and in a page's right-click menu.
- **Research with AI:** a research agent reads a saved item, searches the web and GitHub, and writes a cited Research section and, when needed, subpages into it. See [Research with AI](#research-with-ai).

Full-page capture has progress, cancellation before saving, source-page restoration and an explicit result action. It is bounded to **16,384 pixels per axis, 48 megapixels, 50 viewport tiles and a 120-second capture deadline**. Oversized pages fail with guidance to choose visible capture. Protected pages, changing content, nested scroll containers and browser access restrictions can prevent capture.

`Ctrl/⌘ K` searches, `N` creates a note, `A` saves a link and `Ctrl/⌘ Enter` saves an edited note. Extension-wide shortcuts are in [INSTALL.md](docs/INSTALL.md).

### Article capture and Select parts

**Save article** (the side panel's **Save article**, the Add dialog's **Capture article**, or **Save article to Still** in a page's right-click menu) loads [Mozilla Readability](#third-party-code) and Still's own extractor into the page only when you ask. Readability picks the main content, and Still converts it to the Markdown its notes use. X posts, GitHub repositories and YouTube watch pages have their own readers. When Readability finds too little text, Still tries the page's single `article`, then `main`, then the body without navigation, footers and forms. In the side panel, a preview shows the page content with its word count, the name, icon, collection, tags and a note before you save. From the right-click menu the article saves at once; a page with no readable text is saved as an ordinary page. Saving a page that is already in your library refreshes its article text and fills empty details; its note, title, tags and collection stay as you left them. The page itself is only read, never changed.

**Select parts** (the side panel, or **Select parts of page…** in the right-click menu) starts a picker on the page. Hover and click parts to select them, use **−** and **+** on a selection (or ↓ and ↑ while hovering) to narrow or widen it, then choose **Done** or press Enter; Esc cancels. Selecting a part that contains another absorbs it. Up to 30 parts are saved as one article. From the side panel the result opens in the article preview; from the menu it saves to your default collection and Chrome shows a notification such as "Saved 3 selections from example.com". The picker draws its outlines in its own layer and never styles page elements.

The detail view shows a captured page's icon, site, author and publication date. Images in captured articles stay links to their source sites.

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

Choose exact models and supported effort, temperature, image and context/output limits. Credentials for providers configured in the local companion are encrypted in its storage; an API key added directly in Still stays in this device's extension storage and never enters a backup. Provider tests and model discovery are explicit actions. Sending a prompt uses the selected provider or CLI. Still does not install coding agents or copy Codex account tokens.

The AI sidebar supports selected-item, current-space and relevant-library context, source citations, writing actions, streaming, cancellation, local conversation history and visible partial failures. **Ask about this space** includes its description and active nested content without broadening to other spaces. Responses can become connected notes or be explicitly inserted, appended or substituted into an unsaved draft. Retrieved content remains untrusted reference material.

### Assistant permissions

The assistant can also organize the library. It searches and reads items, then stages changes as a proposal card you apply or discard, with Undo afterwards. Changes cover new notes and subpages, saved links, collections, moves, tags, favorites, archive, Trash and restore, item edits, links between items and dashboard widgets. **Settings → Assistant permissions** chooses which kinds of change apply without review:

| Level | Create | Organize | Edit | Dashboard | Delete |
| --- | --- | --- | --- | --- | --- |
| Always ask (default) | Ask | Ask | Ask | Ask | Ask |
| Trusted | Allow | Allow | Allow | Allow | Ask |
| Full access | Allow | Allow | Allow | Allow | Allow |

**Custom** sets each kind separately. A step applies at once only when every change in it is of a kind you allow and it changes at most 50 items (subpages that move or go to Trash with a page count too); anything else, or anything this version cannot classify, waits on a card. Changes applied this way show as "Applied automatically" with Undo. One request can apply at most 12 steps automatically and propose at most 4 for review. The assistant's instructions and tool descriptions follow the setting, so it does not claim a change is waiting for you when it was applied. Permissions stay on this device: backups never include them and restoring a file never changes them. See [prompt contracts](docs/ai-prompts.md#assistant-permission-levels).

### Research with AI

**Research with AI** researches one saved item as a [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) session in your own Anthropic account, with Claude Sonnet 5.5. It needs an Anthropic API key added in **Settings → AI models** (keys used through the local bridge, Claude Code, Codex or a compatible endpoint cannot run it) and one-time Chrome access to `api.anthropic.com`. The agent uses web search, web fetch and read-only GitHub tools. It writes, through Still's own tools, only a dated **Research** section with source links on that item and the subpages it creates. It does not read your other items, does not change your text or the original unless you turn that on, and never deletes anything. The assistant shows its progress, cost and controls: Stop, Resume, Raise cap and continue, and Undo research changes (removes the section, moves the subpages to Trash). Each run has a spending cap, $5 by default, billed to your Anthropic account. **Settings → Research agent** sets depth, GitHub use, subpages per run, the cap and whether the original may be edited; these settings stay on this device. See [Research with AI](docs/research-agent.md).

### MCP and coding agents

The MCP server exposes **33 tools** to read and update notes, saved article text, highlights, relationships, collection metadata, tags and item state, plus paginated exports and bounded original-file reads. Subpages are notes with a `parentId`: `create_item` accepts one, `list_items` and `search_library` filter by it, `get_item` lists `subpageIds`, and `move_page` moves a note inside another item or back to the top level. Mutations return a queued receipt; clients must check `get_operation` for `saved` or `failed`. Revision checks reject stale edits. File reads return at most 65,536 bytes per chunk and never accept arbitrary filesystem paths.

**Settings → Agents & MCP** offers reviewable client setup and installation of the included [Still workspace agent skill](agent-skills/still-workspace/SKILL.md). Configuration and skill installation require an explicit action and return receipts. Keep a syncing Still view open while a client uses the library.

- [Providers and local endpoints](docs/ai-providers.md)
- [CLI agents and official Codex sign-in](docs/ai-cli.md)
- [MCP clients and agent skills](docs/mcp-agents.md)
- [Context and prompt contracts](docs/ai-prompts.md)
- [Research with AI](docs/research-agent.md)
- [Raindrop, GitHub and other integrations](docs/integrations.md)

Raindrop import uses your personal token to bring in collections, links, notes and highlights. Selected URL items can be sent back explicitly. Raindrop's remote MCP server is a separate data source. Notion, Readwise, Zapier, Make, n8n and RSS cards link to official guides; Drive and Dropbox are manual backup destinations.

## Data ownership and portability

Library metadata stays in `chrome.storage.local`; original file bytes stay in IndexedDB. Uploads are bounded to **100 MB per file** and portable imports to **200 MB per backup**, subject to available device storage.

**Settings & backup → Full backup** exports sources, personal notes, subpages, captured page details, highlights, connections, nested collection metadata, original file bytes, the wallpaper, dashboards, assistant chats (research conversations included) and AI settings (never API keys, account tokens or other credentials, and never the device-only assistant permissions and research agent settings). Import validates the whole file before writing, takes an automatic snapshot first, and rolls back newly written attachments if a later stage fails. Records merge by ID and the newer copy wins, so newer edits on this device are kept and items deleted forever are not brought back; non-secret preferences come back, device credentials stay local. A legacy metadata-only backup cannot restore bytes it never contained.

Still also keeps **automatic snapshots** on this device (after an update, daily when something changed, and before every import or restore); Settings lists them and restores any of them, taking a safety snapshot first. Snapshots are deleted with the extension's data, so keep a downloaded full backup elsewhere. See [docs/data-model.md](docs/data-model.md).

HTML bookmark import/export preserves nested folders. CSV import and export support quoted multiline fields, notes, tags, descriptions, type, collection, dates, site, author, published date and language; CSV has no item IDs, so subpages come back as top-level notes. Markdown export retains personal notes, annotations and source connections, puts each subpage after its parent page and turns page blocks into links, and assistant chats export as Markdown too. Existing Chrome bookmarks can be imported after granting optional access.

## References and provenance

All **29 supplied reference images** are packaged in **Help → The reference room**, with captions. The [reference catalogue and Fabric expansion notes](docs/fabric-expansion.md) distinguish read-only browser observations and bounded static findings from functionality implemented here.

Original third-party packages, private account observations, copied source and decompiler artifacts are excluded from publication. Static recovery is partial; Sidebar Dock does not claim complete Fabric reconstruction, source-format compatibility or feature parity.

### Third-party code

Still ships one third-party file: [Mozilla Readability](https://github.com/mozilla/readability)'s `Readability.js`, licensed under the Apache License 2.0, as [`extension/lib/vendor/readability.js`](extension/lib/vendor/readability.js). It is pinned to upstream commit `ab4027a8b37669745016869a37a504727992b2ba` and kept byte for byte unmodified (90,944 bytes, SHA-256 `e9330028c8a5a4aa7d75147be2605d520f7f213c7b28474947dc0e9c984e9bed`). [`extension/assets/licenses/readability.txt`](extension/assets/licenses/readability.txt) records that provenance with the upstream NOTICE and the full license text. `scripts/check.mjs` and both packaging scripts refuse a changed copy (the pins are in [`scripts/vendored.mjs`](scripts/vendored.mjs)). Everything else, including the article-to-Markdown converter, the X, GitHub and YouTube readers and the page picker, is original code.

Raindrop's [help centre](https://help.raindrop.io/), [Claude guide](https://help.raindrop.io/integrations/claude) and [integration directory](https://help.raindrop.io/integrations) also informed the library and connection flows.

## Validation and current limits

From Node.js 22+:

```powershell
node --test tests/*.test.mjs
node scripts/check.mjs
node scripts/package.mjs
node scripts/package-runtime.mjs
```

The current local suite contains **1,206 tests** covering storage/revisions, dashboard layout and backup, widget data, themes, sticky notes, rich-note round trips, nested space boundaries, explicit graph links, capture planning/cancellation/cleanup, binary backup restoration, rejected imports, file conversion against real PDF/Office/EPUB fixtures, AI import fallbacks, embed round trips, provider transports, official CLI login protocol handling and authenticated MCP mutation receipts. Newer tests cover article extraction and the Markdown converter on a small test DOM, the page picker, article capture through the worker, subpage cascades, imports and MCP tools, assistant permission levels, and the research engine against a local fake Managed Agents server. On the latest run on the development machine, **1,194 passed and 12 failed**. All 12 failures are in `tests/ai-cli.test.mjs` and depend on the machine: there, the tests' temporary folders resolve through `/private/var`, and their stand-in Codex CLI is reported as unsupported. The same 12 fail on a clean checkout of the previous commit, so these features did not cause them. Static checks validate imports, assets, manifest/CSP, reference images, injected page scripts and the vendored file's pin. Packaging checks validate ZIP entrypoints and integrity.

BrowserOS neo checks exercised table/toggle editing and persistence, space metadata/layout persistence, a locally mocked space-cited AI answer, separate conversations when changing spaces, keyboard map navigation, wide/narrow layouts and dark mode. Screenshots above show the actual isolated preview; no paid model request was made. Reduced-motion styles were checked; animation frame rate was not measured.

Installed-extension activation of native capture, context menus, side-panel APIs and notifications still needs real-browser verification. Article capture, Select parts, subpages and Research with AI were tested only with stubbed Chrome APIs and a test DOM, not in a loaded extension, and no live Managed Agents session was run. Account-backed OAuth completion, live Raindrop access, paid inference, provider entitlement and actual Claude/Codex client activation have not been established by local fixtures. Those tests do not establish model answer quality.

There is no cross-device cloud sync, hosted collaboration, automatic page-annotation reattachment, video transcription or text extraction from saved PDF/EPUB files (use `/import` in a note to turn one into text). Those files can still be stored, downloaded, tagged, embedded and connected to notes. Sites that refuse framing cannot be embedded; their embeds keep an Open link. Remote covers load from their source sites. The MCP bridge shares with configured local clients while enabled; an external AI provider receives the context selected for that request.

**Article capture limits.** Capture needs access to the page: the right-click menu has it for that tab, and the side panel asks Chrome for access to the site when it lacks it. Browser pages, the Chrome Web Store and PDF, image or video documents cannot be read. Only the top-level document is read: content inside frames is not, so embedded posts and widgets are missing; a recognized YouTube, Vimeo, Loom or X player becomes an embed line and another titled frame a link. Readability can drop parts it judges to be clutter, such as comment sections or short sharing sections, and on unusual layouts it can keep clutter or miss an intro. Content that has not loaded yet (for example on scroll) is not captured. Captured text is cut at 250,000 characters on a block boundary, with at most 50 images and 2,000 table rows; pages over 30,000 elements skip Readability, and a conversion stops after about 4 seconds. Images are not downloaded.

**Select parts limits.** The picker runs only in the top-level page. It cannot select inside frames, and cross-origin frames cannot be read at all: a whole frame can be selected and becomes an embed line or link like above. While picking, page hover styles and cursors over frames do not show, and wheel scrolling over a frame scrolls the page around it, not the frame's own content. Frames inside open shadow roots are not covered and still receive clicks. Up to 30 parts per selection.

**Subpage limits.** Only notes can be subpages. Archiving a page does not archive its subpages. Siblings are ordered by creation time; there is no manual order. CSV exports and imports subpages as flat rows.

**Research limits.** Research needs an Anthropic API key added in Still and one-time access to `api.anthropic.com`, and cannot run in the localhost preview. Each run is a Managed Agents session stored in your Anthropic account and billed there; Still never deletes those sessions. The model is fixed to Claude Sonnet 5.5. The run makes progress only while the Still page that started it (or one that resumed it) is open. The agent cannot read your other saved items. The right-click **Save and research with AI** entry stays visible when research is turned off; it then saves the page and the side panel says research is off. If the side panel does not answer within about 2 seconds, the saved item opens in a Still tab and research does not start.
