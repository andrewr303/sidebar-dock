# Fabric-informed expansion in Sidebar Dock 0.2

Sidebar Dock, presented as **Still**, is an original local-first implementation. This document separates features seen in references or installed packages from functionality built here. It contains no recovered third-party source, private account identifiers or raw analysis graphs.

## Inputs and product identity

The installed Fabric desktop app and supplied browser-extension packages were inspected as inert files. Originals were preserved and analysis used owned copies. Fabric's executable and helper scripts were not launched for static analysis.

The folder labelled `fabric` contained **Fabric web clipper 2.2.12** and **Bookmarkify 2.21 and 2.22**. Bookmarkify's canvas, sticky notes and canvas history belong to Bookmarkify; they are not Fabric evidence.

The desktop app identified itself as **Fabric 0.2.15**, built with Electron and ToDesktop. Its main workspace and tray load hosted Fabric pages. The local package primarily supplies a desktop shell and does not contain the complete hosted editor, search, AI or synchronization implementation.

## Actual Ghidra and JavaScript coverage

| Evidence stream | Completed work | Boundary |
| --- | --- | --- |
| Desktop package | Inventory of 2,637 archive entries; selected entry/plugin reads; package and Electron fuse identity checks | Fuse states and bundled capabilities do not establish running behavior or exploitability. |
| Desktop native Ghidra | Windows active-window addon: 547 discovered functions, 119 imports and selected decompilations connecting foreground-window, title and process-identity calls | The bounded 225 MB main-executable analysis timed out without exporting a program. Supporting-library evidence does not reconstruct the hosted editor. |
| Desktop JavaScript REA | Four focused plugins parsed: selected text, files, inter-window messaging and local communication | Graph retention is partial. Whole-archive and large entry-bundle passes timed out. |
| Supplied extensions | All 392 files inventoried/hashed; all 78 JavaScript files scanned with bounded literal queries | Inventory and literal matches do not recover a complete program model. |
| Fabric clipper REA | Partial application graph, retained summary and bounded inert-text feature inspection | Two sources parsed; two large minified sources were heap-limited. An oversized graph was retained, not represented as complete recovery. |
| Bookmarkify REA | Nine selected application files parsed; two supplied versions compared | Selected files matched across versions; five other files differed. Application equivalence was not established. |

Desktop findings support selected-text capture, source-window attribution, folder/document deep links and continuity through tray/window entry points. Filesystem and foreground-window access are native capabilities. Sidebar Dock does not acquire them through additional Chrome permissions.

The clipper's shipped resource and command catalogues support mixed resources, nested spaces, rich blocks and capture modes. Static names do not establish account entitlement, private backend behavior, remote writes or an offline sync guarantee. Complete Fabric reconstruction and exact format compatibility are not claimed.

## Read-only BrowserOS observations

A signed-in Fabric session was inspected through BrowserOS without sending a query or changing content or settings. Feature-level observations were:

- Home combined recent notes, links, files and spaces.
- Navigation exposed Library, Connections, Chats, Tasks, Access & AIs and Brain explorer.
- Inbox offered a cover action, grid selector, note/link cards and Create, Search and Assistant entry points.
- Assistant showed a persona, automatic model selection, new-chat controls, customization entry points, an actions menu and an explicit current-space context chip.

No AI response, mutation, provider connection, sync implementation, semantic-search quality or private API behavior was verified. No authentication material was extracted. Personal content, account identifiers and workspace URLs are omitted here.

## Observation to implementation

| Observed feature or reference | Sidebar Dock implementation | Practical limit |
| --- | --- | --- |
| Mixed notes, sources and files | One local library; personal notes separate from captured article text; related items and backlinks | No Fabric account import or remote-format compatibility. |
| Inbox and contextual spaces | Built-in Inbox; nested collection descriptions, covers, icons and pins; independent full-tab/sidebar layouts; descendant counts | Existing storage schema retained. No cloud space sync. |
| Current-space Assistant chip | Space description and active nested content become explicit AI context; citations open items or spaces | Missing/deleted spaces cannot broaden to the whole library. Live answer quality remains unverified. |
| Rich slash-command blocks | Original editable Markdown tables, persistent toggles, tasks, lists, callouts and linked media/source blocks | Markdown round trips are the portable contract, not Fabric's internal editor schema. |
| Relationship navigation | Explicit-link Knowledge map with scope/search/type filters, focus/hover neighbors and keyboard opening | UI cap: 60 matching items. Tags, titles and similarity create no edges. |
| Visible/full-document capture | Original bounded tiling/stitching, progress, cancellation, cleanup, source attribution and result action | Installed native activation still requires real-browser verification. Region/element selection is not implemented. |
| Continuity across entry points | Shared sidebar/full-tab storage; navigation preserves space, filters and open item | No desktop tray app, filesystem watcher or system-wide selected-text capture. |
| Agent access to knowledge | MCP read/write tools, revision checks, applied receipts and bundled agent skill | Keep a syncing view open. No automatic client launch or invented connection success. |

Full-page capture limits are 16,384 output pixels per axis, 48 megapixels, 50 tiles and a 120-second capture deadline. Oversized pages or failed scrolling report failure. Visible capture remains a separate user choice; partial output is not silently substituted for a complete document.

## All 29 supplied image references

Every image is packaged intact in **Help → The reference room**, with its catalogue caption. The first 23 cover library/capture/notes flows, four cover AI/provider/MCP interfaces and two cover Fabric blocks and space-scoped AI. Images are design references, not proof that depicted cloud or AI features exist here.

| Packaged reference | Focus |
| --- | --- |
| [collection-context-menu.avif](../extension/assets/references/collection-context-menu.avif) | Collection context menu |
| [collections-create.avif](../extension/assets/references/collections-create.avif) | Creating nested collections |
| [devices.f8bf769e.png](../extension/assets/references/devices.f8bf769e.png) | A library across devices |
| [highlights-intro.avif](../extension/assets/references/highlights-intro.avif) | Reading and highlighting articles |
| [Screenshot 2026-10-25 144442.png](../extension/assets/references/Screenshot%202026-10-25%20144442.png) | Sidebar bookmark list |
| [Screenshot 2026-10-25 144456.png](../extension/assets/references/Screenshot%202026-10-25%20144456.png) | Sidebar bookmark grid |
| [Screenshot 2026-10-25 144504.png](../extension/assets/references/Screenshot%202026-10-25%20144504.png) | Notes and tasks with source links |
| [Screenshot 2026-10-25 144510.png](../extension/assets/references/Screenshot%202026-10-25%20144510.png) | Page-linked notes |
| [Screenshot 2026-10-25 144523.png](../extension/assets/references/Screenshot%202026-10-25%20144523.png) | Note stacks and organization |
| [Screenshot 2026-10-25 144859.png](../extension/assets/references/Screenshot%202026-10-25%20144859.png) | Capture actions menu |
| [Screenshot 2026-10-25 145112.png](../extension/assets/references/Screenshot%202026-10-25%20145112.png) | Collections and tag organization |
| [Screenshot 2026-10-25 145126.png](../extension/assets/references/Screenshot%202026-10-25%20145126.png) | Quick save with notes |
| [Screenshot 2026-10-25 145150.png](../extension/assets/references/Screenshot%202026-10-25%20145150.png) | Full library workspace |
| [Screenshot 2026-10-25 145211.png](../extension/assets/references/Screenshot%202026-10-25%20145211.png) | Collections and nesting |
| [Screenshot 2026-10-25 145231.png](../extension/assets/references/Screenshot%202026-10-25%20145231.png) | Highlights and item views |
| [Screenshot 2026-10-25 145255.png](../extension/assets/references/Screenshot%202026-10-25%20145255.png) | Chatting with an article |
| [Screenshot 2026-10-25 145259.png](../extension/assets/references/Screenshot%202026-10-25%20145259.png) | Sidebar and related sources |
| [Screenshot 2026-10-25 145305.png](../extension/assets/references/Screenshot%202026-10-25%20145305.png) | Files and supported formats |
| [Screenshot 2026-10-25 145429.png](../extension/assets/references/Screenshot%202026-10-25%20145429.png) | Asking your library a question |
| [Screenshot 2026-10-25 145524.png](../extension/assets/references/Screenshot%202026-10-25%20145524.png) | A focused page-linked notebook |
| [Screenshot 2026-10-25 145539.png](../extension/assets/references/Screenshot%202026-10-25%20145539.png) | Article and research notes side by side |
| [Screenshot 2026-10-25 145928.png](../extension/assets/references/Screenshot%202026-10-25%20145928.png) | Visual masonry library |
| [search-collections.avif](../extension/assets/references/search-collections.avif) | Finding collections with search |
| [ai-sidebar-reference.png](../extension/assets/references/ai-sidebar-reference.png) | Notion-style AI conversation sidebar |
| [ai-provider-catalog-reference.png](../extension/assets/references/ai-provider-catalog-reference.png) | Coding agents, APIs and local model connections |
| [ai-provider-settings-reference.png](../extension/assets/references/ai-provider-settings-reference.png) | Provider model and capability configuration |
| [mcp-connections-reference.png](../extension/assets/references/mcp-connections-reference.png) | MCP server and coding-agent connection controls |
| [fabric-blocks-reference.png](../extension/assets/references/fabric-blocks-reference.png) | Fabric block command menu, tables and callouts |
| [fabric-space-ai-reference.png](../extension/assets/references/fabric-space-ai-reference.png) | Fabric spaces with a contextual AI sidebar |

The device/sync and cloud-AI images describe reference-product behavior. Sidebar Dock currently provides local persistence, portable backups and optional configured AI/MCP connections. It does not provide cross-device sync, a semantic embedding index or hosted collaboration.
