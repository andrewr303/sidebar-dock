# Research with AI

**Research with AI** takes one saved item (an article, a bookmark, a note or a file) and researches it further. The research agent reads the saved page, searches the web and, for technical topics, GitHub, then writes a sourced **Research** section into the item and, when there is a lot to cover, a few subpages. It runs as a [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) session in your own Anthropic account, and it writes into Still only through Still's own tools.

The engine is in [`extension/lib/ai/research/`](../extension/lib/ai/research/); the conversation view and actions are in [`ui/research.js`](../extension/ui/research.js) and [`ui/research-view.js`](../extension/ui/research-view.js).

## What you need

- **The installed extension.** Research does not run in the localhost preview (`node scripts/serve.mjs`). The Managed Agents API sends no CORS headers, so only an extension page with host access to `api.anthropic.com` can call it.
- **An Anthropic API key added in Still.** Add it under **Settings → AI models** as an Anthropic connection. Still keeps it in this device's extension storage (`still.ai.secrets.v1`). Research cannot use connections that go through the local bridge, Claude Code, Codex or an Anthropic-compatible endpoint: Managed Agents exists only on `api.anthropic.com`. The key's account must have access to the Managed Agents beta (`anthropic-beta: managed-agents-2026-04-01`). Keys that are not scoped to a workspace need the connection's workspace ID, as for chat.
- **Host access, asked once.** The first time you start research, Chrome asks to let Still reach `https://api.anthropic.com/*`, and `https://api.github.com/*` unless GitHub research is off. Research needs the Anthropic access; GitHub access is optional. Chrome does not ask again once access is granted.
- **Offer Research with AI** turned on in **Settings → Research agent** (it is on by default).

## Start research

The **Research with AI** action (telescope icon) appears in:

- the item's detail view header;
- the side panel's **This page** tab when the current page is saved;
- the Add dialog after you save an article;
- **Research more with AI** in the note editor's menu, the Notes list menu and the library item menu.

On a web page, the right-click menu also has **Save and research with AI**. It opens the side panel, saves the page (as an article when it has readable text), then starts research there.

The run starts at once, with no dialog, and its conversation opens in the assistant: the **Ask** tab in the side panel, or the **AI assistant** view in a full tab. If that view is already answering a question, a toast offers to open the research instead, so the answer is not interrupted. Starting research on an item that is already being researched opens the existing run.

The conversation is titled "Research: <item title>" and shows:

- a status bar: **Starting**, **Researching**, **Paused**, **Paused at the spending cap**, **Paused, connection lost**, **Done**, **Failed** or **Stopped**;
- a progress timeline of searches, pages read, GitHub lookups, writes and subpages, with links to the pages read;
- the agent's short progress notes and its closing summary;
- chips for the subpages it created, and the cost once the run ends ("$0.84 of $5 cap").

The pages the agent read also appear as the conversation's sources. The status bar's actions are **Stop**, **Resume**, **Raise cap and continue**, **Try again**, **Allow access**, **Open AI settings**, **Open note** and **Undo research changes**, depending on the run's state.

Once a run ends, the composer sends follow-ups to the research agent, not to the chat model ("Ask the research agent for more"). A follow-up goes to the same session when it can. When that session is gone, was ended, or is paused at its spending cap, Still starts a new session and gives it a summary of the earlier work and the subpages it created.

## How a run works

1. **Setup, once per connection and workspace.** Still creates an agent named "Still research agent" (model `claude-sonnet-5-5`) and an environment named "Still research" (cloud, unrestricted networking) in the key's workspace. It records their IDs on this device in `still.ai.research.v1`. When Still's agent definition changes, the agent is updated in place. An agent or environment that was archived or deleted in the Claude Console is created again. Still never archives or deletes anything in your account.
2. **The session.** Each run creates a session for that agent, pinned to its version. The session's effort follows the depth setting (Quick `low`, Standard `medium`, Deep `high`); a workspace that refuses the effort override runs the agent's own model settings instead. Its budget is your spending cap, and its title is the conversation title. Its metadata holds `app`, `item_id` and `conversation_id`.
3. **The first message.** Still opens the event stream first, then sends one message describing the item and the run. See [What is sent to Anthropic](#what-is-sent-to-anthropic).
4. **The work.** The agent runs on Anthropic's servers. Web search and web fetch run there too. When it calls one of Still's tools, the call runs in the Still page that started the run, which writes the result into your library. Each result is saved in the conversation before it is sent back, so a replayed event is answered again from that record and never writes twice.
5. **The end.** An idle session with `end_turn` is **Done** (or **Stopped** after you pressed Stop). Reaching the spending cap pauses the run (**Paused at the spending cap**). A refusal, repeated errors or a terminated or deleted session is **Failed**, with a readable error.

The run lives in the Still page that started it. Other Still views show the stored copy, updated about once a second. That page saves a heartbeat every 5 seconds. If it closes, other views show **Paused** after 30 seconds without a heartbeat and offer **Resume**. Meanwhile the session waits at its next Still tool call. A dropped event stream reconnects by itself: Still reads the session's history, skips events it already handled and answers calls the session is still waiting for. After 8 failed reconnects the run is **Paused, connection lost**, and **Resume** continues it.

## Tools

The agent has two built-in tools from Anthropic's agent toolset, both allowed without approval prompts (`always_allow`):

| Tool | Behavior |
| --- | --- |
| `web_search` | Web search, run by Anthropic. |
| `web_fetch` | Reads one page, cut at 15,000 tokens. It can only open URLs that already appeared in the conversation: the saved page's URL, search results, GitHub results and pages already fetched. |

The toolset's other tools (`bash`, `read`, `write`, `edit`, `glob`, `grep`) are turned off. Because the web tools need no approval and the network is unrestricted, a prompt-injected page could otherwise make the agent send what it read elsewhere.

Still's own tools run in your browser:

| Tool | Behavior |
| --- | --- |
| `append_to_document` | Adds Markdown to this run's research section. The first call starts the section. |
| `replace_research_section` | Rewrites the body of this run's own section. Links to its subpages are kept. |
| `create_subpage` | Creates a note nested under the item (or under a subpage from this run) and links it from the section. Limited by **Subpages per run**. |
| `update_subpage` | Appends to or replaces the body of a subpage this run created. |
| `edit_original` | Replaces the original text, only when **Allow editing the original** is on. Otherwise it returns an error and changes nothing. |
| `github_search_repositories` | Searches repositories (read-only). |
| `github_get_repository` | Reads one repository: description, topics, license, stars, forks, last push, latest release and a README excerpt of at most 6,000 characters. |
| `github_search_code` | Searches code. Needs a connected GitHub account. |
| `github_search_issues` | Searches issues and pull requests. |

Write limits: at most 60,000 characters of Markdown per call, a research section of at most 200,000 characters and an original of at most 250,000 characters. GitHub limits: at most 15 requests per run, each answered from a per-run cache when repeated. Search queries can have at most 256 characters and five `AND`/`OR`/`NOT` operators. A rate limit that resets within 10 seconds is waited out; a longer one returns a `rate_limited` result, and the agent is told to use web search. With GitHub research off, the GitHub tools return an error.

The agent's tool and system definitions are in [`agent-config.js`](../extension/lib/ai/research/agent-config.js) and [`custom-tools.js`](../extension/lib/ai/research/custom-tools.js). Search counts per depth are guidance in the prompt, because Managed Agents' web tools have no `max_uses` setting; the spending cap is the hard stop.

## What it writes, and what it never touches

**It writes:**

- **One research section** at the end of the item's note (the `content` field): a `## Research` heading, a dated line such as "_Researched with Claude on November 2, 2026_", then the findings with inline source links. For a saved article or bookmark, this is your personal note on the item; the captured article text is not changed. For a note, the section goes after your text.
- **Subpages**, when the material is extensive: notes nested under the item, each linked from the section by a page block line (`[[item_id|Title]]{page}`). They take the item's collection.
- **The original**, only through `edit_original` and only when **Allow editing the original** is on. That is the captured article text for a saved article, or the note body (without the research section) for a note.

Before saving, Still removes control characters from the agent's Markdown. Links whose target is not a web address (`javascript:`, `data:`, `vbscript:`, `file:`) keep their text and lose the link. If you edit the research section while the run is going, the next write starts a new research block below it instead of overwriting your change.

**It never:**

- changes any other item in your library, or reads one. The agent sees the item, the titles of its existing subpages and nothing else from your library;
- changes text outside its own section;
- changes subpages that you or another run created;
- changes the original unless you turned that on;
- deletes anything. Undo moves the run's subpages to the Trash.

## Settings

**Settings → Research agent**:

| Setting | Default | Choices |
| --- | --- | --- |
| Offer Research with AI | On | Shows or hides Research with AI on saved items. The right-click **Save and research with AI** entry stays in the menu; with research off it saves the article and the side panel says research is off. |
| Connection | Automatic | Automatic uses the chat connection when it is a direct Anthropic key, else the first enabled direct Anthropic key. Or pick one. |
| Model | Claude Sonnet 5.5 | Fixed. |
| Depth | Standard | Quick (about 5 web searches, effort `low`), Standard (about 12, `medium`), Deep (about 25, `high`). |
| GitHub research | Automatic for tech topics | Always, or Off. |
| Subpages per run | 6 | None to 12. |
| Spending cap per run | $5 | $1, $2, $3, $5, $10, $15, $20, $30 or $50. |
| Allow editing the original | Off | On lets research rewrite the original when you ask it to. Undo puts it back. |
| Reset research agent | | Forgets this device's agent and environment IDs, so the next run creates new ones. Nothing is deleted from your account. |

These settings are device-only. Full backups leave them out, and restoring a file never changes them, so a crafted backup cannot raise the spending cap or allow edits to originals. A run keeps the depth, GitHub mode, subpage limit and spending cap it started with. Its follow-ups use the same values, or a cap you raised.

## Costs and the spending cap

Anthropic bills each research session to the account of the API key that runs it, at Anthropic's [Managed Agents prices](https://platform.claude.com/docs/en/about-claude/pricing). When this feature was built, those covered model tokens at the model's list price, web searches per 1,000, no per-request charge for web fetch, and session runtime per session-hour, counted only while the session is running. A session that waits for Still's next tool result is idle, not running. Still does not estimate prices before a run. After a run, the status bar shows what the session cost, from the session's reported usage.

The spending cap is sent as the session's [budget](https://platform.claude.com/docs/en/managed-agents/budgets), in whole US cents (`budget: { type: 'limit', max_list_cost: { amount, currency: 'USD' } }`). Anthropic checks it before each model request, and the request that crosses it still finishes, so the final cost can end slightly above the cap. When the session reaches it, Anthropic pauses the session, and the run shows **Paused at the spending cap**. **Raise cap and continue** offers the next few amounts above both the cap and what was spent, up to $100. Raising the cap resumes the paused turn. You can also stop the run there.

**Stop** interrupts the session (`user.interrupt`), and the run ends **Stopped**. If the session does not confirm within 30 seconds, Still ends the run anyway. Deleting a research conversation while it runs also interrupts its session.

## What is sent to Anthropic

The first message of a session contains:

- the item's title, URL, type, site, author, published date, date saved, tags and the titles of its existing subpages;
- its captured text, up to 150,000 characters (for a note, the note body; for other items, the captured article text or the excerpt), with a note when it was cut;
- for items that are not notes, your note on the item, up to 20,000 characters;
- your instructions, if any, up to 4,000 characters;
- the run settings (depth, maximum subpages, GitHub mode, whether the original may be edited) and today's date.

Saved text is wrapped in tags and labeled as reference data that must not be followed. The agent is told to search with topic terms, never with sentences from your note. Later messages carry your follow-ups and the results of Still's tools (what was written, and GitHub data).

Anthropic stores the agent, the environment and each session in your account, including the session's events: the page text above, searches, fetched content and the agent's messages. Still does not archive or delete them; manage them in the Claude Console. Web searches and fetches are made by Anthropic, not by your browser.

GitHub calls go from your browser to `api.github.com`. They use your connected GitHub account (**Settings → Connected accounts**) when there is one, and GitHub's public rate limits otherwise.

On this device, the research conversation (messages, steps, the run record with its undo record and recent tool results) is an ordinary assistant chat. It is included in full backups and assistant chat exports. The agent and environment record (`still.ai.research.v1`) stays on this device and is never part of a backup. See [the data model](data-model.md).

These measures narrow, but do not remove, the risk that text in a fetched page or saved item steers the agent: the untrusted-data labels, the disabled file and shell tools, `web_fetch` limited to URLs already seen, no access to the rest of your library and writes limited to the run's own section and subpages. Read what the agent wrote before relying on it.

## Undo

**Undo research changes** appears once a run has ended (**Done**, **Stopped** or **Failed**) and has written something. After you confirm, Still:

- removes the research section it is tracking, if that text is still on the item exactly as written;
- moves the subpages the research created to the Trash (top-level ones first; their own subpages go with them);
- restores the original, if `edit_original` changed it and nobody edited it since.

Anything you edited since stays as it is, and the toast says what was kept. Undo runs once per conversation. Continuing the research (a follow-up, or raising the cap) offers Undo again when the new run ends. A paused run cannot be undone; stop it first.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "Research runs in the Still extension. It is not available in this preview." | Load the extension (see [INSTALL.md](INSTALL.md)). |
| "Research needs an Anthropic API key. Add one in AI settings to start." | Still opens AI settings. Add an Anthropic connection with an API key. Bridge, CLI and compatible connections cannot run research. |
| "Research is turned off. Turn it on in AI settings." | **Settings → Research agent → Offer Research with AI**. |
| "Research needs access to api.anthropic.com. Allow it to start." | Choose **Allow access** and accept Chrome's prompt. |
| "Still needs access to api.anthropic.com to research this page." | Shown in the Ask tab after **Save and research with AI**, which cannot ask Chrome itself. Choose **Allow access**. |
| **Save and research with AI** opened the item in a Still tab | The side panel did not answer within about 2 seconds, so research did not start. Use **Research with AI** on the item. |
| Failed with a key, workspace or authentication error | **Open AI settings** and check the Anthropic connection, including its workspace ID. |
| "Your Anthropic account has a billing problem." | Check the account's plan and credits, then **Try again**. |
| "This research is still running in another Still window." | Wait for it, or stop it there. |
| **Paused** | The page running it closed. **Resume** continues it from this view. |
| **Paused, connection lost** | **Resume** once you are back online. |
| **Paused at the spending cap** | **Raise cap and continue**, or **Stop**. |
| "Choose a spending cap above what this research has already spent." | Pick a higher amount. |
| "This research session no longer exists in your Anthropic account." | Start the research again. |
| "The research agent is missing from your Anthropic workspace." | Still recreates it on the next session. If it keeps failing, use **Reset research agent**. |
| "Research was set up by a newer version of Still." | Update Still on this device. |
| GitHub lookups are rate limited | Connect a GitHub account in **Settings → Connected accounts**, or let the agent continue with web search. |

## Limits

- Only direct Anthropic API-key connections, only in the installed extension, only with model Claude Sonnet 5.5.
- One run per item at a time.
- The run needs a Still page open to make progress. With every Still page closed, the session waits.
- Depth sets search guidance and effort. The spending cap is the only hard limit on cost.
- The agent cannot read your other saved items, so it cannot connect the research to them.
- Research on an item without a URL or captured text relies on the title, tags and your note.
- Tests cover the engine against a local fake Managed Agents server, the tools against a stub store and GitHub API, and the views with stubbed Chrome APIs. No live Managed Agents session, real Anthropic account or installed-extension run was used to verify this feature.

Primary references checked November 1, 2026: Claude Managed Agents [overview](https://platform.claude.com/docs/en/managed-agents/overview), [agent setup](https://platform.claude.com/docs/en/managed-agents/agent-setup), [environments](https://platform.claude.com/docs/en/managed-agents/environments), [events and streaming](https://platform.claude.com/docs/en/managed-agents/events-and-streaming), [session operations](https://platform.claude.com/docs/en/managed-agents/session-operations), [budgets](https://platform.claude.com/docs/en/managed-agents/budgets) and [web restrictions](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions); [web fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool); [pricing](https://platform.claude.com/docs/en/about-claude/pricing).
