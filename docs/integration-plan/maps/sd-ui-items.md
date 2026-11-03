# Sidebar Dock item UI: integration map for item type `chat`

All paths are relative to `/home/user/sidebar-dock/`. Line numbers were current when this map was written. Nothing was edited.

## 0. Core primitives every chat UI piece must use

**Templating** is in `extension/ui/html.js`:
- `html\`\`` (`:57`) escapes every interpolation through `esc` (`:44`, which handles `& < > " '`). The exceptions are values already wrapped as a `Fragment` by `html`/`raw()`. Arrays are joined. `null`, `undefined`, `true` and `false` render as an empty string (`:52-55`).
- `raw(value)` (`:50`) is the only bypass. Use it only on output of `renderMarkdown` or `icon()`.
- Helpers: `cx(...)` (`:64`), `attrs(map)` (`:67`), `plural(count, one, many)` (`:92`).
- `safeHref(value)` (`:73`) allows http(s), mailto, chrome-extension and relative links. Anything else becomes `#`.
- `safeSrc(value)` (`:84`) allows http(s), `data:image/*`, `blob:` and packaged `assets|icons|images/` paths.
- Always quote attributes. For CSS custom properties, pass values through `colorVar()` (`extension/ui/components.js:206`), never raw strings.

**Event delegation** is in `extension/ui/runtime.js`:
- `registerActions(map)` (`:15`) maps names to handlers of the form `({ el, event, ctx, data })`, where `data = el.dataset`.
- Markup binds handlers with `data-action` (click), `data-input`, `data-change`, `data-submit` (default is prevented) and `data-keydown` (`:113-117`). The listeners are document-level and use `closest()`. They skip anything that is `:disabled` or `[aria-disabled="true"]` (`:108`).
- Registering the same name twice warns, and the later handler wins (`:17`).
- Naming convention is `module.verb`, for example `detail.tab`, `notes.open` or `library.type-filter`. Use `chat.*`. Unknown prefixes land in the "Other" group of the shortcuts list (`SHORTCUT_GROUPS`, `extension/ui/settings.js:254`).
- `registerMount(name, fn)` (`:33`) pairs with `<div data-mount data-morph="skip" data-key="unique">`. `fn(el, ctx)` returns `{ update, destroy }`.
- `registerShortcuts([{ keys, action, label, when, allowInInputs }])` (`:39`).

**DOM morph** is in `extension/ui/morph.js:1-5`:
- `data-key` keeps identity among siblings.
- `data-morph="skip"` keeps a subtree only when the old and new nodes share the same `data-key` (`:43`). Put the content revision in the key, as `detail.reader` does with `data-key="reader:${item.id}:${item.updatedAt}"` (`extension/ui/detail.js:368`).

**ctx API** (`extension/app.js:51-101`):
- Navigation: `ctx.navigate(view, { keep, item })` (`:69`), `ctx.openItem(id, { tab = 'details' })` (`:89`, sets `state.panel = { kind: 'item', id, tab }`), `ctx.closePanel()` (`:95`).
- Rendering: `ctx.render()` (batched with rAF), `ctx.nextFrame(fn)`.
- Errors and feedback: `ctx.run(fn)` (catches errors and toasts them), `ctx.openMenu(anchor, items, opts)`, `ctx.toast(msg, { tone, action })`.
- State and data: `ctx.prefs.get/set`, `ctx.select.*`, `ctx.env.{isSidepanel,isExtension,isNewtab}`.

**Module wiring:**
- A new UI module must be imported in `extension/app.js` and appended to `modules` (`:308`) to get `init(ctx)`.
- Its actions register at import time, so it must also be in the import graph (`extension/ui/shell.js` imports the render functions).

## 1. How a note opens as a full page today

**State.** Notes have their own state, not a URL route. `ctx.state.notes = { scope, collectionId, noteId, query, mode, sort }` (`extension/app.js:47`). The lazy initialiser is `notesState` (`extension/ui/notes.js:172`).

**Opening.** `openNote(ctx, id, { focus, from })` (`extension/ui/note-editor.js:219-236`):
- Sets `state.notes.noteId` and `returnTo`.
- In the side panel: `state.panel = null; state.sideTab = 'notes'; ctx.render()`.
- In the full tab: clears an item panel, clears a mismatched collection filter, then `ctx.navigate('notes', { keep: true })`.
- `closeNote` is at `:238`.

**Full tab rendering.**
- `renderMain` (`extension/ui/shell.js:115-125`) sends `view === 'notes'` to `renderNotesWorkspace(ctx)` (`extension/ui/notes.js:338`).
- `renderNotesWorkspace` turns an item panel that points at a note into `s.noteId` (`:341-348`). That conversion is the trick that makes `?libraryView=notes&item=<id>` deep-link work.
- Its grid is list pane, then `<section class="notes-editor-pane">` containing `renderNoteEditor(ctx, id, { surface: 'full' })`, then `renderRail` (`:475`).
- The top bar (search, Ask, Add) still shows, because `OWN_HEADER_VIEWS = ['dashboard','assistant']` (`extension/ui/routes.js:8`).

**Full tab URL.**
- `openInFullTab(ctx, id)` (`extension/ui/note-editor.js:1379-1386`) builds `index.html?libraryView=notes&item=<id>`.
- `applyBootParams` (`extension/app.js:285-302`) turns `item` into `state.panel = { kind: 'item', … }`.
- `syncUrl` (`extension/app.js:112-125`) writes `item` only for `panel.kind === 'item'`, so an open note is not kept in the URL after boot.

**Side panel.**
- `renderSideContent` (`extension/ui/shell.js:183-191`) checks, in order: settings panel, item panel → `renderDetail(side)`, ai/ask, page, notes → `renderSideNotes` (`extension/ui/notes.js:570`), then library.
- `renderSideEditor` (`extension/ui/notes.js:576-590`) draws a sticky header: back button `notes.back`, a collection crumb, and `notes.open-full` (maximize). Below it is `renderNoteEditor(…, { surface: 'side' })`.

**The page itself.**
- `renderNoteEditor` (`extension/ui/note-editor.js:321`) returns only an empty mount.
- The `note-editor` mount (`:400`) builds `shell(variant, surface)` (`:370-397`) once.
- Structure: `.ne.ne-{full|side}` contains, in order:
  - `.ne-toolbar[role=toolbar]` (`TOOLS` `:332`, `toolbarMarkup` `:352`)
  - `.ne-banner`
  - `.ne-scroll > .ne-doc`, holding:
    - `.ne-head`: `nav.ne-crumbs[data-region=crumbs]`, `textarea.ne-title`, `.ne-meta[data-region=meta]`
    - `.ne-body` (block editor)
    - `.ne-ai`
    - `section.ne-subpages[data-region]`
    - `section.ne-links[data-region]`
  - `footer.ne-foot`
- `renderRegions` (`:758`) morphs the declarative regions after every app render:
  - `renderCrumbs` (`:1264`) shows the page path.
  - `renderMeta` (`:1234`) shows the collection picker, linked page, reminder, pin and tags.
  - `renderSubpages` (`:1280`) builds the Subpages list from `ctx.select.children(id)` and `subpageCount`.
  - `renderLinks` (`:1359`) shows "Linked from".
- These four helpers are not exported. A chat page must either export them (the crumbs and subpages logic is generic) or copy the markup.

**Detail panel route for notes.** From any non-Notes view, `app.open-item` leads to `renderDetail`. For notes it shows an "Open in notes" button (`detail.open-note`) at `extension/ui/detail.js:334`, which calls `openNoteTab` (`:587-591`).

## 2. Detail panel: the existing per-type branch point

`renderDetail(ctx, id, { surface = 'full' } = {})` is at `extension/ui/detail.js:401-426`.
- `surface: 'side'` renders full-screen with a back arrow (`app.close-panel`).
- `surface: 'full'` is the right-hand panel, `PANEL = { min: 340, max: 640 }` (`extension/ui/shell.js:45`).

Type-specific spots in `detail.js`:
- `TABS` (`:19-23`).
- `renderTabs` filter (`:144`): `t.value !== 'reader' || item.type !== 'note' || item.articleContent`.
- Tab whitelist (`:410`): `['details','reader','notes'].includes(requested)`.
- `renderCover` returns `''` for notes (`:153`).
- `renderSource` uses `TYPE_LABELS` (`:182-183`).
- Description hidden for notes (`:329`).
- Section heading "Note" or "Your note" (`:334`).
- Notes section is non-note only (`:286`).
- `detail.menu` has non-note entries (`:792-793`).

**Recommended hook:** at the top of `renderDetail`, add `if (item.type === 'chat') return renderChatPage(ctx, item, { surface })`. Keep the same outer `<div class="detail" data-surface data-key="detail:${id}">` and back/close header so the side-panel back flow and Escape (`shell.escape`, `extension/ui/shell.js:395`) keep working.

## 3. Recommended chat page: one renderer, two hosts

Create `extension/ui/chats.js` exporting `renderChatPage(ctx, item, { surface })` and `init`.

### State

```js
ctx.state.chats ||= { chatId: null, view: 'summary' }  // 'summary' | 'transcript'
```
Persist the last choice per user with `ctx.prefs.set('chatView', …)`.

### Hosts

- **Side panel:** the `renderDetail` branch above. Navigation is free because `ctx.openItem` already lands there.
- **Full tab, minimal:** the detail-panel branch plus an "Open as page" button.
- **Full tab, page:** a new main view `chats`, mirroring the Notes workspace. It requires every one of these:
  - `MAIN_VIEWS` regex (`extension/ui/routes.js:4`).
  - `renderMain` branch (`extension/ui/shell.js:115`).
  - `viewTitle` map (`:70-72`).
  - `NON_ITEM_VIEWS` (`:42`), so a top-bar search jumps to All items.
  - `selectors.itemsForView` branch `view === 'chats'` (`extension/ui/selectors.js:214-248`). Without it, the side-panel library drill-down falls through to all `live()` items.
  - `VIEW_META` and `EMPTY` (`extension/ui/library.js:39`, `:418`).
  - The side-panel special case in `goToView` (`extension/ui/sidebar.js:79-90`) and in `ctx.navigate` (`extension/app.js:80-81`).
  - The `app.open-full` mapping (`extension/app.js:254-264`).
  - `syncUrl` should write `item` while `view === 'chats'` (`:112-125`).
  - Copy the panel-to-page conversion from `extension/ui/notes.js:341-348`.

### Markup that reuses the note look (tokens only)

```
<div class="note-editor-host is-{full|side}">          ← height:100% host (extension/styles/notes.css:249-250)
 <div class="ne ne-{full|side} chat-page">
  <div class="ne-toolbar" role="toolbar">
    segmented({ name:'chat-view', value, action:'chat.view', size:'sm', ariaLabel:'Show',
      options:[{value:'summary',label:'Summary',icon:'file-text'},{value:'transcript',label:'Transcript',icon:'messages-square'}] })
    <div class="ne-tools-end"> Ask (detail.ask data-id) · Open source (app.open-url) · ⋯ (detail.menu data-id) </div>
  </div>
  <div class="ne-scroll"><div class="ne-doc">
    <div class="ne-head"> crumbs · <h1 class="ne-title"> · <div class="ne-meta"><div class="ne-props">…chips…</div></div></div>
    <div class="chat-body">  summary: <div class="markdown-body">raw(renderMarkdown(...))</div>  |  transcript list </div>
    <section class="ne-subpages">…</section>
  </div></div>
  <footer class="ne-foot"> N messages · synced X ago · source </footer>
 </div></div>
```

**Components:**
- `segmented(...)` is at `extension/ui/components.js:79`. The alternative is `tabs()` at `:90`, which needs a `role=tabpanel` with `aria-controls`.
- Roving arrow keys for any `[role=radiogroup]` or `[role=tablist]` are already global (`extension/ui/overlay.js:276-296`).

**Meta row:** reuse the detail actions, which are keyed by `data-id` and work in any container:
- `detail.collection` (`extension/ui/detail.js:659`, uses `pickCollection`)
- `detail.add-tag-open`, `detail.tags-change`, `detail.tags-done` (`:668-680`). The tag editor looks up `.detail-tags.is-editing`, so keep that class.
- `library.favorite`
- `detail.ask` (`:610`) calls `askAi(ctx, { scope: 'item', ids: [id] })`.

Do not reuse `editor.*` actions: they resolve an editor instance through `instanceOf(el)` (`extension/ui/note-editor.js:395, 406`).

**Alignment pitfall:**
- `.ne-head` has `padding-inline-start: var(--be-gutter)` and, in the full tab, `max-inline-size: calc(72ch + var(--be-gutter))` (`extension/styles/notes.css:357-362`). Both assume a block-editor handle gutter.
- For read-only bodies, either give `.chat-body` the same padding and max width, or set `--be-gutter: 0` on `.chat-page`.
- `.ne-title` is styled for a textarea (`:363-380`). An `<h1>` works because it has `margin: 0`.

**Subpages:** `ctx.select.children(chat.id)` works for any parent. The store only lets notes have a `parentId` (`extension/lib/store.js:100`, `:393`, `:562`), so user notes and Threadkeeper-derived notes can hang under a chat. The detail-panel `renderSubpages` (`extension/ui/detail.js:237-252`) is already type-agnostic.

**Links in summary Markdown:** a `[[Title]]` link renders as `a.note-link[data-id]`. Clicks on it are only intercepted inside `[data-item-card]` (`extension/ui/library.js:1095`). Wrap the summary in `data-action="chat.body"` and copy `notes.card-body` (`extension/ui/notes.js:780-787`).

## 4. Markdown rendering for summaries and bubbles

`renderMarkdown(markdown, { interactiveTasks=false, compact=false, citations, resolveLink, linkClass })` is at `extension/lib/markdown.js:350`. It is dependency-free and never emits raw HTML. Wrap its output in `.markdown-body` (`extension/styles/editor.css:7, 739`).

**What it renders safely:**

| Input | Output | Source |
|---|---|---|
| `<script>…</script>` | escaped text | |
| `[x](javascript:…)` | left as literal text | `safeMarkdownUrl` `:11-16` (http(s) without credentials, mailto, `#anchor`) |
| external links | `target="_blank" rel="noopener noreferrer"` | |
| fenced code | `<pre class="markdown-code"><code data-language>` | `:371`; no syntax highlighting |
| tables | `.markdown-table-wrap` (scrolls on x) > `table.markdown-table` | `:303` |
| a line that is only `![](https://…)` | lazy `<img referrerpolicy="no-referrer">` | `:334-344`; still fetches a remote host, a privacy note for transcripts |

**Quirks that matter for LLM output (verified):**
- `####`-and-deeper headings stay literal; only h1 to h3 are parsed (`:226`).
- `+ item` and `1) item` are not lists.
- Every single newline starts a new `<p>`.
- **Do not pass `compact: true` for transcript or summary.** It truncates to the first 12 blocks and 3 table rows (`:346`, `:365`). The CSS class `.is-compact` is independent of that option and only changes sizing (`editor.css:24`).
- **Do not pass `citations`**, not even `[]`. A non-null citation map turns `[[word]]` into `[source unavailable]` (`:90-93`).
- Pass `resolveLink: noteLinkResolver(ctx)` (`extension/ui/cards.js:65`) only for the summary. In transcripts, a stray `[[x]]` would otherwise become `span.note-link.is-missing`.
- Normalise before rendering: `####+` to `###`, `+ ` to `- `, `N)` to `N.`. Keep this as a pure helper so it can be tested.

**Bubble pattern to copy:** `extension/ui/ai-panel.js:1270-1291`.
- User turn: `<div class="ai-q"><div class="ai-bubble">${text}</div></div>`. Plain text with `white-space: pre-wrap` (`extension/styles/ai.css:128-137`).
- Assistant turn: `<div class="ai-md markdown-body is-compact">${raw(renderMarkdown(text))}</div>`.
- **Pitfall:** `--ai-text` is defined only on `.ai-panel` (`ai.css:11-13`). Reusing `.ai-bubble` or `.ai-md` outside it loses the font size. Define `--ai-text` on `.chat-transcript`, or use your own `.chat-msg[data-role]` classes in a new stylesheet.

**Performance:**
- Memoise rendered HTML per `id:updatedAt`. Use `remember()` (`extension/ui/cards.js:55-62`) or `derive()` (`extension/ui/notes.js:164`).
- Render long transcripts once into a `data-morph="skip"` mount, keyed with `updatedAt` (pattern: `detail.reader`, `extension/ui/detail.js:462-466`).
- Page the messages: the library uses `PAGE = 150` with "Show N more" (`extension/ui/library.js:20`, `:540-544`).

**Block editor:** it has no read-only mode. Its `'preview'` mode is just `renderMarkdown(value, { interactiveTasks: true, resolveLink })` (`extension/lib/block-editor.js:1039-1041`). For read-only "note blocks", render Markdown directly.

## 5. Lists and cards: type icons and counts

`renderItem(ctx, item, { layout, surface, index, selected, tabStop, showCollection, view })` (`extension/ui/cards.js:351-364`) chooses among:
- `listRow` (`:248`), `headlineRow` (`:269`), `noteCard` (`:278`), `coverCard` (`:290`), `masonryTile` (`:303`), `mediaCard` (`:323`), `sideRow` (`:337`).
- Notes get `noteCard` for the cards and masonry layouts (`:354-356`). A chat card that previews the summary would add a branch there.

**Where the type shows up:**
- `sourceBit` (`:144-149`): with no `url`, it shows `icon(TYPE_ICONS[type])` plus `fileName || TYPE_LABELS[type]`.
- `itemSource` (`:99-102`): add a chat branch returning the provider name (ChatGPT, Claude Code and so on).
- `generatedArt` (`:125-132`): with no domain, draws the type icon on `TYPE_HUES` (`:12`); add a `chat` hue.
- `headlineRow` lead (`:271`), `mediaCard` (`:329`), `ariaLabel` (`:246`).
- `shell()` adds `is-note` (`:241`); add `is-chat`.

**Counts on a row:** `indicators()` (`:190-206`) shows `item-ind` icon-plus-number pairs for tasks, highlights, notes on the page, subpages and favorite. Add a message count, for example `icon('messages-square')`, and a coding-agent badge here.
- **Pitfall:** `:200` shows "Has a note" for any non-note item with `content`. Keep `content` as the user's personal note, which is what `renderPersonalNote` edits (`extension/ui/detail.js:226-234`). Store the summary in its own field.

**Other count surfaces:**
- `renderItemLink(ctx, item, { meta, actions })` (`extension/ui/cards.js:367`).
- Detail-section counts use `<span class="detail-count">`.
- The note page uses `ne-count-pill`.
- `count(n)` (`extension/ui/components.js:167`).

**Library filter chips:**
- `viewFacets(rows)` (`extension/ui/library.js:71`) returns `{ total, types, untagged, tags }`.
- Chips only render for entries in `TYPE_CHIPS` (`:35-38`, used at `:397`).

## 6. Sidebar "Chats" entry with a count

- Rows come from `FILTERS` (`extension/ui/sidebar.js:24-38`). Row shape: `{ view, label, icon, count: c => n, always?, fullOnly?, opensTab?, drop?, filter? }`, rendered by `navRow` (`:97-106`).
- Counts come from `navCounts` (`:68-73`), which is `ctx.select.counts()` plus `stickies`.
- `counts()` (`extension/ui/selectors.js:140-163`) returns `{ all, inbox, favorites, notes, highlights, untagged, tasksOpen, reminders, byType, byCollection, byCollectionDeep, archive, trash, duplicates }`.
- `byType` already counts any type (`:146`). Its zero seed comes from `ITEM_VIEW_TYPES` (`:13`), so add `'chat'` there.

**Cheapest correct entry,** placed right after Notes:
```js
{ view: 'type:chat', label: 'Chats', icon: 'messages-square', count: c => c.byType.chat }
```
- `type:[a-z]+` already passes `MAIN_VIEWS`.
- `itemsForView` handles `type:` generically (`extension/ui/selectors.js:228`), and `isBrowseView` covers it (`:20`).
- The side panel gets it automatically through the Library drill-down.
- Without `always: true` the row hides at zero (`extension/ui/sidebar.js:206`). To show the row only while the integration is paired, add a flag to `navCounts`, because the row callbacks receive only `counts`.
- With a dedicated `chats` view, use `view: 'chats'` and complete every item in the section 3 list.

## 7. Every enumeration to extend (found by grep)

| Where | What |
|---|---|
| `extension/lib/store.js:7` `ITEM_TYPES` | `normalizeItem` throws "Unknown item type." (`:147`). `ITEM_FIELDS` (`:22-25`) drops unknown fields that arrive with a patch. `articleContent` is capped at 250000 characters (`:159`). |
| `extension/lib/ai/tools.js:16` `ITEM_TYPES`, `:231` `TYPE_WORDS` | Assistant tool enums. |
| `extension/lib/portability.js:33` `TYPES` | Export and import. |
| `extension/ui/selectors.js:13` `ITEM_VIEW_TYPES`; `:300` `searchRows` haystack (title, url, excerpt, content, articleContent, fileName, tags, highlights) | Add the summary or transcript field. |
| `extension/ui/components.js:308-309` `TYPE_LABELS`, `TYPE_ICONS` | `chat: 'Chat'`, `chat: 'messages-square'`. |
| `extension/ui/cards.js:12` `TYPE_HUES` | |
| `extension/ui/library.js:35` `TYPE_CHIPS`, `:39` `VIEW_META` (`'type:chat'`), `:418` `EMPTY` | |
| `extension/ui/shell.js:32` `TYPE_FILTERS` (search menu), `:69` `viewTitle` type map, `:26` `SIDE_TABS` (leave it; four tabs), `:42` `NON_ITEM_VIEWS` | |
| `extension/ui/sidebar.js:24` `FILTERS` | |
| `extension/ui/routes.js:4` `MAIN_VIEWS` | Only for a `chats` view. |
| `extension/app.js:289` boot `type` param validated against `store.ITEM_TYPES` | |
| `extension/ui/command.js:23` `COMMANDS` | Add `go-chats`. `itemOption` (`:189-204`) builds `where` from `domainOf(url)` for non-notes; add a provider branch. |
| `extension/ui/quick-add.js:315` `TYPE_OPTIONS` | Link / Note / File; leave chat out, since chats are pushed, not added by hand. |
| `extension/ui/map.js:17-19` `TYPE_FILTERS`, `KIND`, `:22` `typeMatches` | |
| `extension/ui/settings.js:105` `SEARCH_SYNTAX` "type:note" help text; `extension/ui/settings/newtab.js:13` `START_PAGES` | Optional. |
| `extension/lib/library-views.js:42` | Source count, bookmark and article only. |
| `extension/styles/skins.css:1051-1057` glass-skin container lists | Add `.chat-page` and its head, toolbar and footer, or they paint opaque under Liquid Glass. |

## 8. Side panel versus full tab

| | Side panel | Full tab |
|---|---|---|
| Entry | `index.html?view=sidepanel` (`extension/manifest.json:51`) | `index.html` |
| Flags | `isSidepanel`; `html[data-surface=side]` (`extension/app.js:202`); denser tokens (`extension/styles/tokens.css:626-633`) | |
| Layout | Header, `side-main`, tab bar | Sidebar, top bar or own header, `main`, resizable panel (`FULL_PANELS = ['item','ai']`, `extension/ui/shell.js:44`) |
| URL | `syncUrl` is a no-op; `state.sideStack` holds the library drill-downs | `syncUrl` writes `libraryView`, `q`, `tag`, `type`, `item` |
| Routing | `navigate` (`extension/app.js:69-88`) and `sidePanelRoute` (`:229-245`) send assistant, dashboard, stickies and settings elsewhere; `notes` becomes `sideTab` | Normal navigation |
| Hand-off | `app.open-full` carries the panel item and tab into a new tab | |

## 9. Icons

- `icon(name, { size = 16, className, label, strokeWidth = 1.75 })` (`extension/ui/icons.js:453`). An unknown name warns once and draws `circle`.
- `message-square` and `messages-square` both exist (`icons.js:192-193`, and the pack at `extension/ui/icon-pack.js:328, 342`).
- Also present: `message-circle`, `message-square-text`, `bot`, `terminal`, `square-terminal`, `code-xml`, `git-branch`, `workflow`, `scroll-text`, `brain`.
- Missing: `folder-git`, `notebook-text`, `arrow-left-right`, `replace`.
- `ALIASES` (`:438`) already maps `callout` to `message-square`. Optionally add `chat: 'messages-square'`.
- Add custom glyphs with `registerIcons(map)` (`:445`), which never replaces existing names.

## 10. Styles

- Stylesheets are plain `<link>` tags in `extension/index.html` (tokens.css, base, components, shell, library, detail, capture, notes, editor, ai, settings, map, dashboard, widgets, stickies, assistant, then `skins.css` last).
- To add `styles/chats.css`, insert it before `skins.css` in **both** `extension/index.html` and `extension/newtab.html` in the same order. `scripts/check.mjs:92-107` fails otherwise.
- The root-level `extension/*.css` files (styles.css, design.css, ai.css, editor.css, spaces.css and others) are legacy and not linked.

**Token rules** (`extension/styles/tokens.css:1-45`):
- Feature CSS uses only tier-2 and tier-3 tokens: `--bg-*`, `--fg-*`, `--border-*`, `--accent*`, `--c-<hue>`, `--space-*`, `--radius-*`, `--text-*`, `--lh-*`. Never a color literal.
- Dark mode is `[data-theme="dark"]` (`:302`), mirrored in the `prefers-color-scheme` fallback (`:434`). Tokens flip automatically, so feature CSS only needs `[data-theme="dark"]` for deliberate differences, as with `.ai-bubble` (`extension/styles/ai.css:137`).
- High contrast and reduced motion are handled in `tokens.css:640-669`.

## 11. Tests

- Run with `node --test tests/*.test.mjs` (each file runs in its own process).
- UI modules import cleanly in Node. Tests import pure exported helpers and render functions, then assert on strings with `const flat = f => String(f).replace(/\s+/g,' ')` (`tests/ui-components.test.mjs:10`, `tests/assistant-page.test.mjs:7`).

**Full-render tests** build a fake ctx (`tests/assistant-page.test.mjs:16-37`) with:
- `state`, `env`, `prefs.get/set` over a Map, `library`, `select` (a stub or the real `createSelectors(() => lib)` from `extension/ui/selectors.js`)
- `render()`, `nextFrame()`, `toast()`, `syncUrl()`

**Other conventions:**
- Item factory: `const item = (id, props) => ({ id, type:'note', … , ...props })` (`tests/pages-ui.test.mjs:20-22`).
- A real store is available through `createLibraryStore` (`extension/lib/store.js:334`).
- Action tests use `registerActions`, `hasAction` and `dispatch` from `extension/ui/runtime.js` (`tests/pages-ui.test.mjs:18`, `:487-497`).
- Modules that touch `document` at render time get a stub first: `globalThis.document ??= {…}` (`tests/research-ui.test.mjs:24`, `tests/capture-ui.test.mjs:9`).
- `tests/helpers/fake-dom.mjs` exports `parseHTML(html)` and `createWindow(html)`, with querySelector support for tag, `#id`, `.class`, `[attr op value]`, descendant and `>`. Unsupported selectors throw. Use it to parse chat-page markup, for example to assert there is no `<script>`, to count `[data-role=user]` bubbles, or to check the `aria-checked` view switch. Today it is used only by `tests/article-extract.test.mjs` and `tests/capture-article.test.mjs`.
- Markdown tests compare exact HTML strings (`tests/markdown-render.test.mjs`). `tests/pages-ui.test.mjs` tests only pure helpers.
- Name the new file `tests/chats-ui.test.mjs`.

## 12. Pitfalls and invariants

- **Provider URL in `url`:** `saveItem` dedupes any non-note item by `canonicalUrl(url)` (`extension/lib/store.js:508-509`), so saving that page later would merge into the chat item. `savedForUrl` (`extension/ui/selectors.js:199`) and `notesOnPage` would also treat the chat as the saved item for that page. Prefer `sourceUrl`, or choose this behaviour deliberately for the This page tab.
- **Updates need revision checks:** detail edits go through `ctx.store.updateItem(id, changes, { expectedUpdatedAt })` (`extension/ui/detail.js:556`). A Threadkeeper push that rewrites the item must preserve user-owned fields (`collectionId`, `tags`, `content`, `favorite`, `relatedIds`).
- **Reader tab:** it shows whenever `articleContent` is set (`extension/ui/detail.js:144`). If the transcript lives there, hide Reader for chats or treat it as the Transcript view.
- **Memoisation keys:** selectors are memoised on `library.updatedAt` (`extension/ui/selectors.js:51-58`). Any chat-derived cache should use the same stamp, or `id:updatedAt`.
- **Single-view state:** `ctx.state.panel.tab` is whitelisted (`extension/ui/detail.js:410`). Add `summary` and `transcript` there if the chat reuses the panel's tab state.