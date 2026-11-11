# Browser automation and the assistant's engine

The Still assistant can work in browser tabs: open pages, read them, click, type, scroll and fill in forms, in the person's own Chrome, signed in as they are. It does this with the browser control layer of [Still Agent](https://github.com/andrewr303/still-agent), which is now part of this repository. The same change rebuilt the loop around the model: it manages the context window, retries a busy provider, reads long sources by passage, and can search the web.

This page describes what was built, the rules it keeps, how it was checked, and what it leaves out. The assistant's instructions are in [ai-prompts.md](ai-prompts.md), stored settings in [data-model.md](data-model.md), and the layer's own build in [`browser-control/README.md`](../browser-control/README.md).

## Two engines: Quiet and Precise

Chrome shows a bar that says an extension "started debugging this browser" whenever `chrome.debugger` is attached to a tab, and gives extensions no way to hide it (only a command-line flag or an installation by enterprise policy does). So Still has two ways to reach a page, chosen in **Settings → Browser automation → How Still controls a page**:

| | Quiet (default) | Precise |
| --- | --- | --- |
| How | A script Still injects into the page (`content/automation.js`), with the site access the person granted | Chrome's debugger, through the browser control layer |
| Chrome's debugging bar | Never: the debugger is not attached | Shown while the assistant works |
| Input | Made by script; pages see events that are not marked as trusted | Real mouse and keyboard input |
| Frames | The page and frames of the same site | Every frame |
| A page's own `alert`, `confirm` and `prompt` dialogs | Cannot be seen or answered; the call times out and the model is told to ask the person | Seen; `prompt` is handed to the person |
| Screenshot | The visible tab only | Any session tab, full page or one element |
| Chrome asks for | Tabs, and access to web pages | Tabs, and following page loads |

Both engines answer with the same results, so everything else on this page holds for both: the same tools, the same receipts, the same cards, the same rules. In Quiet mode a write is classified by the layer's own classifier before anything is sent, payments, access grants and secrets are handed to the person, page text reaches the model only inside the page-content boundary, and a ref fails once its element or its document is gone. A receipt names how the input was made (`script-click`, `set-value`, `script-keys`), so the model and the person can tell the two apart.

What Quiet cannot do, beyond the table: CSS-only hover menus do not open (script cannot put the pointer over an element), a page that checks for trusted events may ignore a click, file pickers and other things Chrome reserves for a real gesture do not open, and frames of other sites are not read (shadow roots are). When a step needs one of these, switch to Precise.

## Turning it on

Browser automation is off until the person turns it on in **Settings → Browser automation → Let the assistant work in browser tabs**. That click also asks Chrome for what the chosen engine needs: `tabs` (see and open tabs) and, for Quiet, access to web pages ("Read and change all your data on all websites"), or for Precise, `webNavigation` (follow page loads). Without them the section says what Chrome still has to allow and offers **Allow in Chrome**. Changing the engine asks for the other set in the same click.

The manifest requires the `debugger` permission, because Chrome does not let an extension declare it as optional and ask for it later. Two consequences:

- On install, and on the update that brings this version, Chrome lists "Access the page debugger backend" and "Read and change all your data on all websites" among Still's permissions. An extension installed from a store is disabled by such an update until the person accepts the new permission; an unpacked extension is not.
- In Precise mode, while the assistant is attached to a tab, Chrome shows a bar saying that Still started debugging this browser. Choosing **Cancel** on it detaches Still and ends the assistant's work in that tab. In Quiet mode the debugger is never attached and the permission is not used.

Nothing touches a tab until the assistant is asked to do something that needs one.

## What the person decides

The rules are the ones Still Agent ships, and no model call can change them.

| Step | Ask first (default) | Auto | Site set to Allow | Site set to Ask | Site set to Block |
| --- | --- | --- | --- | --- | --- |
| Read a page, scroll, move between pages and tabs | runs | runs | runs | runs | refused |
| A detected write: submit, send, post, delete | card | runs | runs | card | refused |
| Payment, granting access to an account, typing a password, card number or one-time code, answering a page's `prompt` dialog | the person's own step | the person's own step | the person's own step | the person's own step | refused |

- **A write card** names the action, the element, the site and the reason the model gave, and offers **Allow**, **Always allow on this site** (where a site rule can cover it) and **Don't allow**. It has no timer: it ends with the answer, with Stop, or when the page closes.
- **A hand-over card** has no Allow button. The assistant prepares everything around the step, the card asks the person to do it in the tab and choose **Done** (or **Skip this step**), and the assistant carries on from what the page shows then. It has no timer either.
- **A question** from the assistant (`ask_user`) is a card with a typed answer, or a takeover ("Sign in to GitHub in this tab, then press Continue"). A typed answer warns never to type a password, a card number or a code there. A question waits up to 15 minutes.
- **Detection is best effort; enforcement is strict.** The layer classifies an action from the element and the form it belongs to before any input is sent. An action it classifies as a write cannot run without the answer the table requires. An action it does not recognise as a write runs as a plain click.
- **Steps per request** (20 to 200 in Settings, default 60) bounds how many model steps one request may take while browser automation is on. With it off, a request keeps the short budget of 12.

The mode can also be changed from the composer (the pointer control beside the model picker) and a site rule from a card. All of it is stored in the device-only setting `browser` (see [data-model.md](data-model.md)): backups never carry it, and restoring a file never changes it.

## What the assistant can do

Sixteen tools, offered only while browser automation is on and Chrome allows it:

| Tool | What it does |
| --- | --- |
| `browser_snapshot` | The page as an outline of what can be acted on, each element with a ref such as `[a12]` |
| `browser_find` | Elements by role and name |
| `browser_read` | The page's or an element's text as Markdown, 7,000 characters at a time, with an offset to read on |
| `browser_screenshot` | The page as an image; only for models that take images |
| `browser_click`, `browser_hover`, `browser_scroll` | Click or point at an element; scroll the page or an element |
| `browser_set`, `browser_fill_form` | Replace a field's value, pick an option, set a date; several fields at once, with an optional submit |
| `browser_type`, `browser_press` | Keys |
| `browser_wait` | Wait for text to appear or go, an element's state, an address or a quiet page, for at most 60 seconds |
| `browser_navigate` | Go to an address, back, forward or reload |
| `browser_tabs` | List, open, select or close the session's tabs |
| `browser_handle_dialog` | Accept or dismiss a page dialog (`alert`, `confirm`, `beforeunload`); a `prompt` dialog is handed to the person |
| `ask_user` | Ask the person a question or hand them a step |

The layer's `upload` and `watch_download` tools are not offered, because the assistant has no file attachments. Its sessions are opened without the layer's page-script and DevTools capabilities, so no model call can run script in a page.

How a step goes:

1. **Observe.** The model takes a snapshot and acts on the refs it shows. A ref is valid only for the document it was shown in; after a navigation, or once its element is gone, it fails with a typed error, never with a guess at another element.
2. **Act.** Input is real input through the Chrome DevTools Protocol, sent once. Every action that changes a page returns its receipt and the diff of what changed, so the model rarely needs a new snapshot.
3. **Verify.** A receipt reports three things separately: input dispatched, the page reacted, and the expected state (`expect`) reached. The assistant says an action worked only when its receipt shows it.

When a reply holds several browser calls, they run in order. The rest are skipped after a navigation, a new tab, a dialog, a card, an error or an action without effect, and a call that names an element the previous action removed is not run. An action whose receipt shows no effect, and that no later look at the page confirmed, is recorded as a step the assistant could not confirm. The answer lists those in a note ("One step could not be confirmed"), and they are saved with it.

From the side panel beside a web page, the assistant starts in that tab and the view follows it. From the full-tab assistant it opens its own tabs and the view stays where it is.

## How it is built

```
Assistant page (side panel, full tab, new tab)            Service worker
  lib/ai/assistant.js      the loop, one per request        lib/browser/host.js       one session per port
  lib/ai/browser-tools.js  tools, cards, ledger, guards       lib/browser-control/layer.js   the layer (bundled)
  lib/ai/browser-client.js ── port "still.browser.v1" ──►       chrome.debugger ──► the tab
```

- **The layer** (`browser-control/`) is Still Agent's `src/browser-control` at a pinned commit, copied without changes with its unit tests (318 tests in 28 files). It is TypeScript with `puppeteer-core` (the frame manager) and `zod`; `npm run layer:build` bundles it into `extension/lib/browser-control/layer.js` and `catalogue.js`, which are committed, so loading the extension still needs no build step. `node scripts/check.mjs` fails when a built file does not match its source.
- **The quiet engine** (`extension/lib/browser/quiet.js` in the service worker, `extension/content/automation.js` in the page) is Still's own code. It uses `chrome.scripting` and `chrome.tabs`, borrows the layer's pure functions for classifying actions and marking page text, and returns the layer's result shapes.
- **The host** (`extension/lib/browser/host.js`) runs in the service worker, which has `chrome.debugger` and timers that are not slowed when a page is hidden. It loads the layer on first use, holds one session of the layer per connected page, applies the person's rules (`decideWrite`, blocked sites), and turns the layer's confirmations and questions into cards.
- **The client and the tools** (`extension/lib/ai/browser-client.js`, `browser-tools.js`) run in the assistant's page. They build the model's tool definitions from the layer's catalogue, run a step's calls in order, keep the ledger of what was done, and show the cards.
- **Settings** (`extension/lib/browser/settings.js`) are pure functions shared by the host, Settings and the assistant.

The rules of the layer still hold here: `chrome.debugger` is the only way to reach the DevTools Protocol, Puppeteer only tracks frames and never finds elements, there is no model inside the layer, and state is disposable (a service worker restart, a detach or a navigation ends it cleanly).

## Safety

- **Page text is data.** Everything a page says reaches the model between `<<<page-content NONCE site=…>>>` and `<<<end-page-content NONCE>>>`, with a 12-character random nonce per result. A page that writes such a marker, or text shaped like Still's own notes (`[Still note`, `<browser-state>`), has it defused by the layer before the model reads it. The instructions tell the model that nothing inside those markers can add to, change or cancel the request.
- **A turn that read a page cannot change the library unreviewed.** Once the browser tools have read a page, a provider search has started or AI thread text is in a turn, every library change it proposes goes to a card, whatever **Assistant permissions** allow, and its answer is shown without loading remote images. This holds for that turn only: a later turn of the same conversation, which gets the earlier answer back as text, is not held to it. Text of saved items and of the page attached to a question from the side panel follows **Assistant permissions** as before.
- **Nothing outside the extension can drive the layer.** The host accepts a port only from Still's own pages: the sender must carry the extension's id and must not be a content script. The manifest lets no web page connect to Still, a port from another extension arrives on an event the host does not listen to, and the local bridge and its MCP server have no path to the host.
- **The model cannot widen its own access.** The mode, the site rules, the step budget and the hand-over rule are read from settings by Still's own code; no tool argument reaches them. `observe`, `timeoutMs` and a dialog's `promptText` are removed from the tool schemas.
- **Blocked sites** are refused by the layer's navigation policy: an address the assistant goes to, a link it follows, and the person's own tab when it would join the session.
- **Stop** aborts the running call, withdraws open cards and detaches the debugger. Closing the assistant's page does the same.

What is not prevented by structure: a model that has read private notes and is then fooled by a page could put them into a search box or an address it navigates to. Reading and moving do not ask. The instructions forbid it, a form submit asks in Ask mode, and site rules can keep the assistant off a site, but this path relies on the model. The same holds for a query the model writes for a provider's web search.

## The loop around the model

These apply to every request, with or without the browser.

- **Context window.** Before each request the loop estimates its size and, past a threshold that follows the model's window, makes room in three steps: older results that carried page text are replaced by a one-line stub once a newer result shows the same tab; the oldest tool steps are replaced by the model's own notes on them plus a ledger written by Still; the remaining results are cut. The person's messages are never removed. If nothing fits, the turn stops and says so.
- **Window size.** A model's listed window is exact. Ollama and LM Studio decide the window when they load a model, so Still asks the server what it loaded (`lib/ai/local-context.js`). A window that stays unknown is assumed small for a local server and large for a cloud one, and only sizes the reference data. When a provider refuses a request for its size, the loop learns the smaller window, folds and tries again.
- **Small windows.** Reference data takes at most half of what the window leaves after the instructions and tool definitions. A model whose window cannot hold the browser tools works without them and says so.
- **Retries.** A request that failed before the model said anything (rate limit, provider down, dropped connection) is tried up to three times in all, with a growing wait or the provider's own Retry-After. A request that already streamed text, thinking or a tool call is never sent twice.
- **Loop guards.** The same call with the same outcome three times in the last six calls adds a note telling the model to try something else. An action on the same target that has no effect gets that note the second time and stops the browser work the third time. Five failed calls in a row stop it too. The turn then ends with an answer about where it got to.
- **Paused turns.** A turn a provider pauses while its own tools run is continued from where it stopped, at most five times.

## Reading the library

- **Passages.** A long note, article or page used to reach the model as its first few thousand characters. Now a text that does not fit arrives as its opening plus the passages that match the question, each with its character offset (`passages`, `notePassages`). `get_items` takes `query` for the passages about a topic and `offset` to read on.
- **Questions are read as questions.** Automatic context no longer treats `#42` or `type:` in a sentence as a search filter. A follow-up that leans on the question before it ("and the second one?") is searched together with that question, and the two rankings are fused.
- **Less noise.** With tools available, matches far below the best one are left out of the automatic context (the model can search again), and the same address saved twice is sent once. `search_library` marks each result `strong` or `weak`.

## Web search

**Settings → AI models → Let the assistant search the web** (off by default) lets the model's own provider run searches for an answer. **Searches per answer** (1 to 10, default 5) is the limit Anthropic enforces; OpenAI's search tool takes no such limit.

- It works on connections that go straight to Anthropic (`api.anthropic.com`) or OpenAI (`api.openai.com`) with a key added in Still. A compatible endpoint, a local server, the bridge and the other providers are not offered the tool. Searches are billed by the provider to that key.
- A search shows as a step ("Searched the web for …"), the answer links each source where it first rests on it, and the pages are listed under **From the web** and saved with the answer.
- From the moment a search starts, the turn counts as holding web text: library changes ask and the answer loads no remote images, whether or not it cites a page.
- A model that refuses the tool is asked again without it, and the person is told.
- The setting is device-only, like the other switches that widen what the assistant may do.

With browser automation on, any model with tool support can also look things up by opening a search engine in a new tab and reading the results. When both are available the instructions tell the model to use the provider's search for facts and the browser for tasks that need the page itself.

Gemini's Google Search grounding is not wired in. Google documents combining it with function tools through its newer Interactions API, in preview; Still's Gemini transport uses `generateContent`.

## What came from Still Agent, and what did not

| Carried over | Not carried over |
| --- | --- |
| The browser control layer, unchanged, with its tests | The React side panel, options page and welcome page |
| The write, hand-over and site rules; Ask and Auto | Conversation trees in IndexedDB, steering a running turn |
| Observe, act, verify; receipts and diffs; refs that fail closed | Tab groups for a conversation's tabs |
| Batches that stop when the page changes | Attachments, upload into pages, downloads and saved files |
| Page-content boundaries and defused look-alikes | Voice input, keyboard shortcuts for the agent |
| The ledger, elide then compact then shorten | Simplified and Traditional Chinese catalogues |
| Retries, overflow recovery, loop guards, unverified steps | Anonymous analytics |
| The `<browser-state>` block after tool results | The companion, MCP connectors, the text tool-call protocol |
| | The glowing border on pages the agent works on (Quiet mode could add it; not done) |
| | The layer's test panel and its autorun checks |

The glowing border needs a script in the page. Still declares no content scripts and no blanket host permission, and the assistant's sessions get no page script, so it was left out; Chrome's own debugging bar marks the tab instead.

## Toward one platform

This repository is meant to merge with the DayDock platform (web, mobile and this extension). The pieces were kept apart with that in mind, and nothing in the DayDock repository was changed.

- The layer and its host exist only in the extension; they need `chrome.debugger`.
- The loop (`lib/ai/assistant.js`), context management, retries, passages and web search are plain modules with their collaborators passed in. Browser tools reach the loop as one optional provider; without it the prompt has no word about the browser.
- The permission rules are pure functions over a small settings object, so a platform setting can feed the same rules later.

## How it was checked

| Check | Command | Covers |
| --- | --- | --- |
| Unit tests | `node --test tests/*.test.mjs` | The host against a fake layer, the client, tools, guards, context, retries, passages, retrieval, web search transports against recorded streams, Settings and cards |
| Layer tests | `npm run layer:test` | The layer's own tests over recorded CDP payloads |
| Static gate | `node scripts/check.mjs` | Modules, manifest, and that the built layer matches its source |
| Real browser | `node scripts/e2e-browser.mjs` | The loaded extension in headless Chrome against local pages, with a scripted model |

The real-browser run has nineteen scenarios. Eight run on the quiet engine (adding to a cart, a form allowed and declined, a lookup, a password hand-over, a delete in Auto mode, a page that tries to give orders, a blocked site) and each checks that Chrome's debugger was never attached while the request ran. Eleven run on the precise engine: the host protocol, adding to a cart, a contact form in Ask mode (allowed and declined) and in Auto mode, a lookup through a results page, a page that tries to give orders, a hand-over, a click without effect, a blocked site, and automation switched off. It needs Chrome for Testing or Chromium (branded Chrome no longer loads an unpacked extension from the command line), starts it with a temporary profile and `--use-mock-keychain`, and never uses a person's profile.

Not checked here: a real model (the scenarios use a scripted one, so they show what the engine does with a model's calls, not how well a model chooses them), a provider's real web search, real sites, sign-in walls and CAPTCHAs, Chrome's own prompt for the tab permissions (the checks grant them at install), the permission prompt of a store-installed update, and Edge. An independent review of the change was started and did not run.

## Limits

- Chrome only was tried (Edge has the same extension APIs), and only in the loaded extension; the localhost preview has no browser automation.
- Browser pages (`chrome://`), the Chrome Web Store and other extensions' pages cannot be controlled.
- When Chrome detaches the debugger from a tab (the person chose Cancel on the debugging bar, or the tab closed), the assistant's work in that tab ends and its next call there fails with an error it can read.
- Detecting that a step sends, deletes or pays is best effort: a control the layer does not recognise as one runs as a plain click.
- The assistant cannot upload files, save downloads, or read PDF documents in the browser's viewer.
- A saved conversation keeps at most 60 lines of browser activity and 20 unconfirmed steps per answer.
