# Install and run Sidebar Dock · Still

Still is a Manifest V3 Chrome extension for Chrome 116 or later. Local bookmarks, notes and files need no account, server, build step or npm dependency installation.

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

The sidebar screenshot control opens two choices. The page and extension-action context menus also expose screenshot actions:

| Choice | Saved result |
| --- | --- |
| **Visible page** | The current viewport as a local PNG attachment, with the page's source URL. |
| **Full page** | A bounded sequence of viewport captures assembled into one PNG, with source attribution and capture dimensions. |

Full-page capture displays progress and offers cancellation until saving starts. It temporarily scrolls the source page and restores page state through its cleanup path. A completed job offers **View screenshot**; it does not open a new item modal over subsequent work. Reopening the capture choices can recover the active job's progress.

Limits are **16,384 output pixels per axis, 48 megapixels, 50 tiles and a 120-second capture deadline**. The capture pipeline checks that it is still using the intended active source tab and that requested scroll positions were reached. Oversized or inaccessible pages fail with guidance; choose visible capture separately. The application does not silently substitute a partial image for a full-page screenshot. Changing layouts, nested scrollers, protected content and browser permissions can prevent capture.

Capture happens only after a requested action. It is not continuous browsing capture. The full-page mechanism has local planning, cancellation and cleanup tests; installed-extension capture activation and actual page restoration still require native browser verification.

When a page exposes readable article/main content, capture stores a plain-text snapshot separately from personal notes. Editing notes preserves that source snapshot. Saving an external link creates its own bookmark and does not inherit the current page's article text.

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

`Ctrl/⌘ K` searches, `N` starts a note, `A` saves a link and `Ctrl/⌘ Enter` saves an edited note.

## Backups and external integrations

Use **Settings & backup** for full backups and supported bookmark imports. Full backups include original attached bytes, notes, highlights, links and collection metadata. HTML bookmarks and Markdown notes are also exportable. Browser-bookmark permission is requested only when importing from Chrome.

Keep a backup before moving profiles or uninstalling Still. Uninstalling an extension removes its local data. Backups do not include account credentials. A legacy metadata-only backup cannot restore missing original files.

Raindrop import and selected-item export require your own token and optional API permission. Read [integrations.md](integrations.md) for setup and the distinction between implemented connections and links to external integration guides.

## Optional AI companion and MCP

Use an existing **Node.js 22+** installation. From the project folder:

```powershell
node bridge/server.mjs
```

The companion uses built-in Node modules and needs no `npm install`. The first run creates `bridge/.local/config.json` containing the loopback address and random pairing token. Keep that file private.

In Still's **AI connections & settings** or **A more connected space → Local MCP bridge**, pair the address and token, approve optional loopback access, and keep a Still sidebar or tab open for sync.

Add an API provider, a standard compatible endpoint, a local model or a supported Codex/Claude Code executable on PATH. API credentials stay encrypted in the companion. Saving a configuration does not generate an answer. **Sign in with ChatGPT** starts the installed Codex CLI's official device flow only when selected; Codex owns the resulting credentials.

**Ask about this space** limits context to that space's description and active nested content. AI output remains a proposal or unsaved draft until you apply/save it. External provider requests send the context selected for that request to the configured provider.

**MCP & agents** provides client configuration previews, explicit connection actions and installation of the bundled agent skill. Applied configuration is distinct from a verified live client connection. These actions do not restart coding sessions. The local server offers read/write tools with revision checks, applied receipts and bounded attachment reads; it exposes no arbitrary filesystem tool.

- [AI providers](ai-providers.md)
- [CLI agents and official Codex sign-in](ai-cli.md)
- [MCP clients and agent skills](mcp-agents.md)
- [Context and prompt contracts](ai-prompts.md)

Account-backed OAuth completion, live inference, Raindrop authorization and actual coding-client activation have not been established by local fixtures. Native side-panel activation, context menus, notifications and capture likewise require verification in a loaded extension.

## Browser preview

From the project folder:

```powershell
node scripts/serve.mjs
```

Open `http://127.0.0.1:4173/` for the full layout, or `http://127.0.0.1:4173/?view=sidepanel` for the sidebar layout. Preview metadata uses browser local storage and files use IndexedDB. Preview data is separate from installed-extension data.

The preview cannot establish Chrome toolbar activation, actual context-menu capture, extension shortcuts, optional permission prompts or service-worker reminder delivery.

## Check and package a source checkout

Node.js 22+ is required. ZIP packaging also uses Python 3.9+ and its standard `zipfile` module. If necessary, set the `PYTHON` environment variable to the Python executable you already use.

```powershell
node scripts/check.mjs
node --test tests/*.test.mjs
node scripts/package.mjs
node scripts/package-runtime.mjs
```

Static checks validate first-party JavaScript, local import/export edges, manifest permissions/CSP, icons and every supplied image. Tests exercise local behavior; reference extensions are not executed.

- `artifacts/still-extension.zip` contains the new extension with `manifest.json` at the ZIP root.
- `artifacts/still-runtime.zip` contains the extension, optional companion, agent skills, public setup guides and an included **`START.md`**. Extract the bundle and follow that start guide.

Runtime bundles do not contain the complete development/test checkout. Run source-check commands from a source checkout rather than an extracted runtime bundle. Packaging verifies entrypoints, path safety and ZIP integrity and prints hashes. It excludes private credentials, original third-party packages and retained analysis artifacts; it does not publish to the Chrome Web Store.

See the [public Fabric expansion and reference catalogue](fabric-expansion.md) for the implementation's inspiration and analysis boundaries. All supplied image references are available through **Help → The reference room**.
