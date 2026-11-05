# Install and run Sidebar Dock · Still

Still is a Manifest V3 Chrome extension for Chrome 120 or later. Local bookmarks, notes and files need no account, server, build step or npm dependency installation.

The paths below are relative to your cloned or extracted project folder, the folder containing `package.json`. Open a terminal in that folder before running commands. Your checkout can be stored anywhere.

## Load the extension

1. Open `chrome://extensions` in the Chrome profile where you want Still.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the project's **`extension`** folder.
4. Pin **Still — bookmarks & notes** from Chrome's extensions menu.
5. Click its toolbar icon to open the sidebar beside the current page.

Choose the folder containing Still's `manifest.json`. If you are using a runtime ZIP, extract it first and select its `extension` subfolder. An extension-only ZIP instead has `manifest.json` at its extracted root; select that root folder.

Use **Open in a new tab** for the full workspace. The current view, space, search/type filters and open item carry over. Both extension views share `chrome.storage.local`; original attached files use IndexedDB. Chrome does not automatically sync this library to other computers.

Still requests `unlimitedStorage` for its growing library and attachments. Available disk capacity still applies. This permission does not grant general access to your filesystem; attach files explicitly through the file picker or drag and drop.

After changing extension code, click **Reload** on Still's card at `chrome://extensions`, then reopen the sidebar or reload Still tabs. Installation and reload are user actions; the project does not modify an existing browser profile automatically.

## Capture pages, passages and screenshots

Right-click a regular HTTP or HTTPS page, link, image or selected text to save it. Selected text can become a source-linked highlight or a connected note. Browser settings and other protected pages cannot be captured as normal webpages.

Still's right-click entries on a web page are:

| Entry | What it does |
| --- | --- |
| **Save page to Still** | Saves the page. When it has an `article` or `main` element, that text is kept as plain text and the item is an article; otherwise it is a bookmark. |
| **Save full-page screenshot to Still** | Starts a full-page screenshot (below). |
| **Save article to Still** | Reads the page's article with Readability and saves it as Markdown with its site, author, date, language and icon. A page with no readable text is saved the usual way. |
| **Select parts of page…** | Starts the page picker. Click the parts you want, then choose **Done** (or press Enter) on the page; Esc cancels. The parts are saved as one article in your default collection, and a notification says how many were saved. |
| **Save and research with AI** | Opens the side panel, saves the page as above, then starts [Research with AI](research-agent.md) on it. |
| **Save page to ▸** | Saves the page into a chosen or recent collection. |

Links, images and selected text have their own entries (**Save link to Still**, **Save image to Still**, **Highlight selection in Still**, **Create a note from selection** and the **Save … to ▸** menus). Right-clicking the toolbar icon offers **Save a screenshot to Still**, **Save full-page screenshot to Still** and **Open Still in a new tab**.

In the side panel, the **This page** tab and the Add menu also offer **Save article** and **Select parts**. **Save article** there opens a preview of the page content (rendered Markdown with a word count), the name, icon, collection, tags and a note before you save. A saved page offers **Update article**, which reads the page again and opens the same preview; saving replaces its article text and fills details it was missing.

### Permission prompts

Still declares no content scripts. It injects its page scripts (`lib/vendor/readability.js`, `content/article-extract.js` and `content/picker.js`) only when you choose an action, into the page's isolated world, and only reads the page.

- **Right-click entries** need no prompt: the click gives Still access to that tab.
- **Save article and Select parts from the side panel** need access to the page's site. When Still does not have it, a toast says "Allow Still to read <site> first." Its **Allow** button opens Chrome's prompt for that one site (for example `https://example.com/*`), then retries. Declining leaves the page unread; you can still save the link.
- **Research with AI** asks once for `https://api.anthropic.com/*` and, unless GitHub research is off, `https://api.github.com/*`. GitHub access is optional. **Save and research with AI** cannot show Chrome's prompt itself, so the side panel's Ask tab shows "Still needs access to api.anthropic.com to research this page." with an **Allow access** button.

All of these are optional host permissions in the manifest; Chrome lists the ones you granted on Still's details page, where you can remove them.

- **Find Threadkeeper** (Settings → Integrations → AI chat threads) asks for the optional `management` permission ("Read
  the list of your apps, extensions, and themes"), reads the list once to find an installed Threadkeeper, and removes the
  permission again straight away. Pasting Threadkeeper's ID instead needs no permission at all. Talking to Threadkeeper
  needs none either: extensions can message each other by ID, and Still only answers the Threadkeeper you connected (web
  pages can never message Still).

The sidebar screenshot control opens two choices. The page and extension-action context menus also expose screenshot actions:

| Choice | Saved result |
| --- | --- |
| **Visible page** | The current viewport as a local PNG attachment, with the page's source URL. |
| **Full page** | A bounded sequence of viewport captures assembled into one PNG, with source attribution and capture dimensions. |

Full-page capture displays progress and offers cancellation until saving starts. It temporarily scrolls the source page and restores page state through its cleanup path. A completed job offers **View screenshot**; it does not open a new item modal over subsequent work. Reopening the capture choices can recover the active job's progress.

Limits are **16,384 output pixels per axis, 48 megapixels, 50 tiles and a 120-second capture deadline**. The capture pipeline checks that it is still using the intended active source tab and that requested scroll positions were reached. Oversized or inaccessible pages fail with guidance; choose visible capture separately. The application does not silently substitute a partial image for a full-page screenshot. Changing layouts, nested scrollers, protected content and browser permissions can prevent capture.

Capture happens only after a requested action. It is not continuous browsing capture. The full-page mechanism has local planning, cancellation and cleanup tests; installed-extension capture activation and actual page restoration still require native browser verification.

When a page exposes readable article/main content, **Save page** stores a plain-text snapshot separately from personal notes; **Save article** and **Select parts** store Markdown instead. Editing notes preserves that source snapshot. Saving an external link creates its own bookmark and does not inherit the current page's article text. Saving an article for a page that is already saved refreshes its article text and fills empty details, and keeps its note, tags, collection and a title you set.

| Extension shortcut | Action |
| --- | --- |
| `Alt+Shift+S` | Save the active page. |
| `Alt+Shift+N` | Create a note and open the full library. |
| `Alt+Shift+L` | Open the full library in a new tab. |

Chrome may reserve or override shortcuts; review them at `chrome://extensions/shortcuts`.

## Notes and spaces

An empty library starts with sample items you can edit or move to Trash. Capturing before first opening the UI preserves that capture rather than replacing it with samples.

Inbox holds uncollected items. Create nested spaces with descriptions, covers, icons and pins, and keep separate full-tab/sidebar layouts. Space overviews include active descendant content. The Knowledge map draws only explicit links between admitted items; similar titles or tags do not create edges.

The note editor supports slash commands, tasks, headings, callouts, code, lists, quotes, editable tables, collapsible toggles and linked media/source blocks. Blocks, Markdown and Preview share the same portable Markdown representation. Save changes explicitly; deleting an item first moves it to recoverable Trash.

A note can be a subpage of another note or of any saved item. Type `/page` or choose **Add subpage** to create one; the parent gets a page block that shows the subpage's current title. The editor shows the page path above the title and a **Subpages** section, and the note menu has **Move to page…** and **Move to top level**. The detail view of any item lists its subpages with **New subpage**. Lists show top-level notes; search results include subpages with their path. Moving a page to Trash moves its subpages with it, and restoring it brings back the ones trashed together. Deleting a page block leaves the page in place.

`Ctrl/⌘ K` searches, `N` starts a note, `A` saves a link and `Ctrl/⌘ Enter` saves an edited note.

## Backups and external integrations

Use **Settings & backup** for full backups and supported bookmark imports. Full backups include original attached bytes, notes and subpages, highlights, links, collection metadata, dashboards, assistant chats and AI settings without keys. Assistant permissions and research agent settings stay on this device and are not in backups. HTML bookmarks, Markdown notes, CSV items and assistant chats are also exportable. Automatic snapshots on this device can be restored from the same section. Browser-bookmark permission is requested only when importing from Chrome.

Keep a backup before moving profiles or uninstalling Still. Uninstalling an extension removes its local data. Backups do not include account credentials. A legacy metadata-only backup cannot restore missing original files.

Raindrop import and selected-item export require your own token and optional API permission. Read [integrations.md](integrations.md) for setup and the distinction between implemented connections and links to external integration guides.

## Optional AI companion and MCP

Use an existing **Node.js 22+** installation. From the project folder:

```powershell
node bridge/server.mjs
```

The companion uses built-in Node modules and needs no `npm install`. The first run creates `~/.still/bridge.json` (or `$STILL_HOME/bridge.json`) containing the loopback address and random pairing token. Keep that file private. If you used an earlier version, its `bridge/.local/config.json` keeps working: the companion copies it to the new file on its first start and leaves the old one in place. `STILL_BRIDGE_CONFIG` overrides the path.

In Still's **AI connections & settings** or **A more connected space → Local MCP bridge**, pair the address and token, approve optional loopback access, and keep a Still sidebar or tab open for sync.

Add an API provider, a standard compatible endpoint, a local model or a supported Codex/Claude Code executable on PATH. Credentials for providers configured in the companion stay encrypted there; an API key added directly in Still stays in this device's extension storage. Saving a configuration does not generate an answer. **Sign in with ChatGPT** starts the installed Codex CLI's official device flow only when selected; Codex owns the resulting credentials.

**Ask about this space** limits context to that space's description and active nested content. AI output remains a proposal or unsaved draft until you apply/save it, except for the kinds of library change you allow in **Settings → Assistant permissions** (none by default), which apply at once with Undo. External provider requests send the context selected for that request to the configured provider.

**Research with AI** needs an Anthropic API key added directly in Still (not through the companion or a CLI) and Chrome access to `api.anthropic.com`, which it asks for on first use. It runs as a Claude Managed Agents session in your Anthropic account, billed there, and writes its own Research section and subpages into the saved item. See [Research with AI](research-agent.md).

**MCP & agents** provides client configuration previews, explicit connection actions and installation of the bundled agent skill. Applied configuration is distinct from a verified live client connection. These actions do not restart coding sessions. The local server offers read/write tools with revision checks, applied receipts and bounded attachment reads; it exposes no arbitrary filesystem tool.

- [AI providers](ai-providers.md)
- [CLI agents and official Codex sign-in](ai-cli.md)
- [MCP clients and agent skills](mcp-agents.md)
- [Context and prompt contracts](ai-prompts.md)
- [Research with AI](research-agent.md)

Account-backed OAuth completion, live inference, Raindrop authorization and actual coding-client activation have not been established by local fixtures. Native side-panel activation, context menus, notifications and capture likewise require verification in a loaded extension. Article capture, Select parts, subpages and Research with AI were tested with stubbed Chrome APIs, a test DOM and a local fake Managed Agents server, not in a loaded extension or against a live Anthropic account.

## Browser preview

From the project folder:

```powershell
node scripts/serve.mjs
```

Open `http://127.0.0.1:4173/` for the full layout, or `http://127.0.0.1:4173/?view=sidepanel` for the sidebar layout. Preview metadata uses browser local storage and files use IndexedDB. Preview data is separate from installed-extension data.

The preview cannot establish Chrome toolbar activation, actual context-menu capture, extension shortcuts, optional permission prompts or service-worker reminder delivery. **Save article** and **Select parts** are marked extension only there, and Research with AI says it is not available in the preview.

## Check and package a source checkout

Node.js 22+ is required. ZIP packaging also uses Python 3.9+ and its standard `zipfile` module. The scripts run `python`, or `python3` where only that name exists; set the `PYTHON` environment variable to use another Python executable.

```powershell
node scripts/check.mjs
node --test tests/*.test.mjs
node scripts/package.mjs
node scripts/package-runtime.mjs
```

Static checks validate first-party JavaScript, local import/export edges, manifest permissions/CSP, icons and every supplied image. They also check that the scripts injected into web pages (`content/` and `lib/vendor/`) are classic scripts with no `import` or `export`, that the manifest declares no content scripts or web-accessible resources, and that the vendored Readability file still matches its size and SHA-256 pin. Tests exercise local behavior; reference extensions are not executed.

- `artifacts/still-extension.zip` contains the new extension with `manifest.json` at the ZIP root.
- `artifacts/still-runtime.zip` contains the extension, optional companion, agent skills, public setup guides and an included **`START.md`**. Extract the bundle and follow that start guide.

Runtime bundles do not contain the complete development/test checkout. Run source-check commands from a source checkout rather than an extracted runtime bundle. Packaging verifies entrypoints, path safety, ZIP integrity and the vendored file's pin, and prints hashes. It excludes private credentials, original third-party packages and retained analysis artifacts; it does not publish to the Chrome Web Store. The only third-party code in either ZIP is Mozilla Readability (Apache-2.0), shipped unmodified with its license in `extension/assets/licenses/readability.txt`.

See the [public Fabric expansion and reference catalogue](fabric-expansion.md) for the implementation's inspiration and analysis boundaries. All supplied image references are available through **Help → The reference room**.
