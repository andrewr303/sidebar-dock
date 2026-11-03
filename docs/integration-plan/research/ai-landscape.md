# AI products for Threadkeeper to support, November 2026

As of November 2026, "grok bot", "dots" and "muse" most likely mean three always-on agent products launched between August and September 2026. All three are new since my training data, and I confirmed each one against current sources:

- **"grok bot"** is xAI's Grok Bot. It has no web interface of its own.
- **"dots"** is OpenAI's dots. It lives inside chatgpt.com, which Threadkeeper already covers.
- **"muse"** is Meta's Muse agent. Its web app is at muse.ai.

The full product list (about 75 rows) and the provider-id list are below. Where I could not confirm a URL pattern, the row is marked "low".

## 1. What each product the user named most likely is

| Name | Most likely product | Evidence | Where conversations happen on the web | Conversation URL and where the id sits | Web interface? |
|---|---|---|---|---|---|
| **grok bot** | **Grok Bot** from xAI (now branded SpaceXAI): always-on cloud agents, each with its own computer. Beta since Aug 11, 2026. Access goes through Cursor or SuperGrok accounts. | [docs.x.ai/grok-bot/overview](https://docs.x.ai/grok-bot/overview), [faq](https://docs.x.ai/grok-bot/faq), [chat-and-collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration), [DataCamp](https://www.datacamp.com/blog/grok-bot) | The app is desktop (macOS, Windows, Linux; download at cursor.com/dashboard/bot) plus iOS and Android. In a browser it is reachable only through **X Chat on x.com**, through public `@bot` replies on X posts, and through Slack for shared bots. | X Chat: `x.com/i/chat/<conversationId>`. I confirmed that `x.com/i/chat` redirects to login with `redirect_after_login=/i/chat`. Public replies: `x.com/<user>/status/<postId>`. | **No standalone web UI.** X Chat is end-to-end encrypted, so only the rendered page (DOM) can be captured. |
| grok bot (other meanings) | (a) `@grok` on X, which Threadkeeper already covers as `grok_x`. (b) The Telegram bot `@GrokAI` ([TechCrunch](https://techcrunch.com/2025/05/28/xai-to-pay-300m-in-telegram-integrate-grok-into-app)). (c) Grok "companions" such as Ani ([Engadget](https://www.engadget.com/ai/groks-ai-chatbot-now-includes-companions-for-you-to-romance-133017601.html)). | | (b) Telegram app, or web.telegram.org. (c) Grok mobile apps. | — | (b) Telegram only. (c) App only. One unverified wiki claims `grok.com/ani`. |
| **dots** | **OpenAI dots**: always-on ChatGPT agents announced at DevDay on Sep 29, 2026. Pro and Business Premium plans only; not available in the EEA, Switzerland or the UK. | [TechCrunch](https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/), [DataCamp](https://www.datacamp.com/blog/openai-dots), [SmartScope](https://smartscope.blog/blog/openai-dots-user-guide-creation-steps-initial-setup-2026/) ("start at chatgpt.com/dots"), help article help.openai.com/en/articles/20001530 (blocked to my fetcher) | **chatgpt.com**, the host Threadkeeper already uses for ChatGPT. Also Slack, Teams, SMS (beta), and the mobile app for messaging only. | `chatgpt.com/dots/home`. Each dot has one direct-message (DM) thread at `chatgpt.com/dots/<threadId>`, which **redirects to `/dots/home`**, so the address bar never shows the id ([agent-tincan web-agents.md](https://github.com/mvanhorn/agent-tincan)). The page uses a messaging layout, not the normal ChatGPT conversation layout: `.messaging-root .message-list .message-row[data-message-id]`, with `.self` marking the user (from the ghost-in-the-loop userscript). | Yes, desktop browser. Mobile web is not supported. |
| dots (other meanings) | (a) Xiaohongshu's **点点 / Diandian** assistant, web app at **dots.ai**. (b) The "Dots" AI lab at RedNote, which publishes models (dots.llm1, dots3-note) but has no consumer chat of its own. (c) Dot by New Computer, **shut down Oct 5, 2025** ([TechCrunch](https://techcrunch.com/2025/09/05/personalized-ai-companion-app-dot-is-shutting-down)). | (a) The dots.ai HTML has title `点点` and loads `dots-for-pc` JS; I read its route table from the bundle. (b) [DataNorth](https://datanorth.ai/news/dots-studio-releases-dots3-note-preview), [Baidu Baike](https://baike.baidu.com/en/item/Dots/2411753). | (a) dots.ai, with login by QR code through the Xiaohongshu app. | (a) `dots.ai/home/<chatId>` (`/home/new` or a `pending-*` id while a chat is being created), `dots.ai/task/<taskId>`, `dots.ai/collection/<collectId>` | (a) Yes, a React single-page app. (c) Was iOS only, now gone. |
| **muse** | **Meta Muse**, Meta's personal AI agent. Launched Sep 8, 2026, US only, with a free tier and $20 and $100 plans. Its internal codename is "hatch". | [Axios](https://www.axios.com/2026/09/08/meta-debuts-muse-personal-ai-agent), [TechCrunch](https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/), [Wikipedia](https://en.wikipedia.org/wiki/Muse_(AI_agent)), [DataCamp](https://www.datacamp.com/blog/muse-agent). The muse.ai page title is "Muse — Your Personal AI Agent from Meta". | **muse.ai**. The API is at api.muse.ai and the session cookie is `hatch_sess`. Also iOS, Android, macOS apps and WhatsApp. | From the site's route table: main chat at `/` and `/thread/main`, new chat at `/thread/new`, **conversation at `/thread/<sessionId>`**. Also `/goals/<goalId>`, `/space/<slug>`, `/shared-agents/<id>`, `/library/...` | Yes, a Next.js single-page app. |
| muse (other meanings) | (a) **Muse Spark**, the Meta Superintelligence Labs model that has run **Meta AI** since Apr 8, 2026. (b) Microsoft Muse, a 2025 game-generation model. | (a) [Meta newsroom](https://about.fb.com/news/2026/04/int), [Notebookcheck](https://www.notebookcheck.net/Meta-upgrades-Meta-AI-with-Muse-Spark.1270170.0.html). (b) From my own knowledge; I did not look it up. | (a) www.meta.ai and meta.ai | (a) `www.meta.ai/prompt/<conversationId>`. Confirmed from the site's own JS by the foxcache project on 2026-10-15. | (a) Yes, Next.js. (b) No chat interface. |

## 2. Products beyond what Threadkeeper already supports

How to read the table:
- **SPA** means a single-page app, where moving between chats changes the URL without a full page load. Capture has to watch for those in-page URL changes.
- **Confidence:** "high" means the route table came from the site's own JS bundle, or two or more independent code sources agree. "medium" means one good source. "low" means I could not confirm the pattern.
- **Liveness:** I loaded every row's site with curl on 2026-11-03. Sites that answered with a bot check (Cloudflare or Vercel) are still live.

| # | Product | Hosts (exact) | Conversation URL / where the id sits | Category | SPA | Confidence |
|---|---|---|---|---|---|---|
| 1 | ChatGPT dots | chatgpt.com | `/dots/home`; `/dots/<threadId>` redirects to `/dots/home`, so the id is not in the address bar | agent | yes | high |
| 2 | Meta Muse | muse.ai | `/thread/<sessionId>`; main chat at `/`, `/thread/main` | agent | yes | high |
| 3 | Grok Bot (through X Chat) | x.com | `/i/chat/<conversationId>` | agent | yes | medium |
| 4 | Meta AI | www.meta.ai, meta.ai | `/prompt/<conversationId>` | chat | yes | high |
| 5 | Diandian 点点 (Xiaohongshu) | dots.ai | `/home/<chatId>`, `/task/<taskId>` | agent | yes | high |
| 6 | Claude Duet | claude.ai (already covered) | `/duet` (main chat; id not in URL), `/duet/chan_<id>` | agent | yes | medium |
| 7 | Manus (Meta-owned since Dec 2025) | manus.im, www.manus.im | `/app/<taskId>`; share links `/share/<id>` | agent | yes | high |
| 8 | Genspark | www.genspark.ai, genspark.ai | `/agents?id=<id>` (the id is a query parameter) | agent | yes | high |
| 9 | MiniMax Agent | agent.minimax.io, agent.minimax.cn (chat.minimax.io redirects here) | `/chat?id=<id>` | agent | yes | medium |
| 10 | Flowith | flowith.io | `/conv/<id>` | agent | yes | low |
| 11 | Gemini Enterprise | business.gemini.google, *.business.gemini.google | `…/session/<id>` | agent | yes | medium |
| 12 | Poe | poe.com | `/chat/<chatCode>`; `/<BotName>` starts a new chat | chat | yes | high |
| 13 | HuggingChat | huggingface.co (under `/chat`) | `/chat/conversation/<24-character hex id>` | chat | yes | high |
| 14 | Qwen Chat | chat.qwen.ai | `/c/<uuid>` (built on Open WebUI) | chat | yes | high |
| 15 | Qianwen 千问 (Alibaba, China) | www.qianwen.com, qianwen.com | `/chat/<hex>` | chat | yes | medium |
| 16 | Doubao 豆包 | www.doubao.com | `/chat/<id>`; also `/code/chat/<id>`, `/thread/<id>` | chat | yes | high |
| 17 | Dola (formerly Cici, ByteDance international) | www.dola.com (www.cici.com redirects here) | `/chat/<id>` | chat | yes | medium |
| 18 | Z.ai (GLM) | chat.z.ai, zchat.z.ai | `/c/<uuid>`; share links `/s/<id>` | chat | yes | high |
| 19 | ChatGLM 智谱清言 | chatglm.cn | id in the query parameter `cid=<id>`; shares at `/share/<id>` | chat | yes | medium |
| 20 | Tencent Yuanbao 元宝 | yuanbao.tencent.com | `/chat/<agentId>/<conversationId>` | chat | yes | high |
| 21 | Tencent ima | ima.qq.com | `/chat/<id>` | chat | yes | low |
| 22 | Baidu Wenxin (ERNIE; yiyan.baidu.com now goes here) | wenxin.baidu.com | `/search/<id>` | chat | yes | medium |
| 23 | StepFun 阶跃 | chat.stepfun.com | `/chats/<numericId>`; new chat at `/chats/new` | chat | yes | medium |
| 24 | LongCat (Meituan) | longcat.chat | `/c/<id>` | chat | yes | medium |
| 25 | Zhihu Zhida 知乎直答 | zhida.zhihu.com | `/search/<id>`, `/share/<id>` | search | yes | medium |
| 26 | Duck.ai | duck.ai | no id in the URL; chats are kept in browser storage, so an id has to be generated | chat | yes | high (host) |
| 27 | Proton Lumo | lumo.proton.me | `/u/<n>/c/<uuid>` | chat | yes | medium |
| 28 | Kagi Assistant | assistant.kagi.com (kagi.com/assistant redirects here) | id path not confirmed; the old pattern was `kagi.com/assistant/<uuid>` | chat | yes | low |
| 29 | Arena (formerly LMArena) | arena.ai (lmarena.ai redirects here) | `/c/<uuid>` | chat | yes | medium |
| 30 | OpenRouter Chat | openrouter.ai | `/chat?room=<roomId>` (chats kept in browser storage) | chat | yes | medium |
| 31 | T3 Chat | t3.chat | `/chat/<id>` | chat | yes | medium |
| 32 | Venice | venice.ai | `/chat/<id>` (chats kept in browser storage) | chat | yes | low |
| 33 | Monica | monica.im | `/home/chat/…` | chat | yes | low |
| 34 | Mammouth | mammouth.ai | `/app/a/<assistant>/c/<id>` | chat | yes | low |
| 35 | Abacus ChatLLM | apps.abacus.ai | `/chatllm/?appId=<id>&convoId=<id>` | chat | yes | medium |
| 36 | ChatHub | app.chathub.gg | not confirmed | chat | yes | low |
| 37 | TypingMind | www.typingmind.com | chats kept in browser storage; no id in the path | chat | yes | low |
| 38 | You.com (now mainly sells APIs) | you.com | `/search?q=…&cid=<cid>&tbm=youchat` | search | partly | low |
| 39 | Felo | felo.ai | `/search/<id>` | search | yes | medium |
| 40 | Gemini Notebook (NotebookLM, renamed Jul 2026) | notebook.google.com (notebooklm.google.com redirects here) | `/notebook/<notebookId>` | chat | yes | high |
| 41 | Notion AI | app.notion.com (www.notion.so for older sessions) | `/chat?t=<threadId>`; new chat at `/ai` | chat | yes | medium |
| 42 | Microsoft 365 Copilot Chat | m365.cloud.microsoft | `/chat` (no id in the path) | chat | yes | low |
| 43 | Google AI Mode | www.google.com | `/search?udm=50…` | search | no | low |
| 44 | Character.AI | character.ai | `/chat/<characterId>?hist=<chatId>` | companion | yes | high |
| 45 | Pi (maintenance mode) | pi.ai | `/talk`: one continuous thread, no id | companion | yes | medium |
| 46 | Replika | my.replika.com | one chat, no id | companion | yes | medium |
| 47 | Kindroid | kindroid.ai | `/home`; the selected companion is not in the URL | companion | yes | low |
| 48 | Nomi | beta.nomi.ai | `/nomis/<nomiId>` | companion | yes | medium |
| 49 | Talkie | talkie-ai.com | `/chat/<slug-id>` | companion | yes | medium |
| 50 | PolyBuzz | www.polybuzz.ai | `/character/chat/<id>` | companion | yes | low |
| 51 | Janitor AI | janitorai.com | `/chats/<chatId>` | companion | yes | medium |
| 52 | SpicyChat | spicychat.ai | `/chat/<characterId>` | companion | yes | medium |
| 53 | GitHub Copilot on github.com | github.com | chat `/copilot/c/<id>`; cloud agent `/copilot/tasks/<id>` and `/copilot/agents`; per pull request `/<owner>/<repo>/pull/<n>/agent-sessions/<id>` | coding-agent | partly | high (chat) / medium |
| 54 | Cursor web agents | cursor.com | `/agents/bc-<uuid>` (older form `/agents?id=bc-<uuid>`) | coding-agent | yes | high |
| 55 | Devin | app.devin.ai | `/sessions/<id>` | coding-agent | yes | high |
| 56 | Jules | jules.google.com | `/session/<id>` (also `/task/<id>`) | coding-agent | yes | high |
| 57 | Factory | app.factory.ai | `/sessions/<id>` | coding-agent | yes | medium |
| 58 | Amp | ampcode.com | `/threads/T-<uuid>` | coding-agent | partly | high |
| 59 | OpenCode share pages | opncd.ai | `/s/<id>` | coding-agent | yes | low |
| 60 | Replit Agent | replit.com | `/@<user>/<repl>` | builder | yes | medium |
| 61 | Lovable | lovable.dev | `/projects/<uuid>` | builder | yes | high |
| 62 | Bolt | bolt.new | `/~/<projectSlug>` | builder | yes | high |
| 63 | v0 | v0.app (v0.dev redirects here) | `/chat/<slug-id>` | builder | yes | high |
| 64 | Base44 | app.base44.com, base44.com | `/apps/<appId>/editor/…` | builder | yes | medium |
| 65 | Firebase Studio | firebase.studio, studio.firebase.google.com | `/<workspace-slug>` | builder | yes | low |
| 66 | Figma Make | www.figma.com | `/make/<fileKey>/<slug>` | builder | yes | medium |
| 67 | Emergent | app.emergent.sh | not confirmed | builder | yes | low |
| 68 | Same | same.new | `/chat/<id>` | builder | yes | low |
| 69 | Open WebUI (self-hosted) | any origin | `/c/<uuid>`; share links `/s/<id>` | chat | yes | high |
| 70 | LibreChat (self-hosted) | any origin | `/c/<uuid>`; new chat `/c/new` | chat | yes | high |
| 71 | LobeChat / LobeHub | app.lobehub.com, or any origin | `/chat?session=<id>&topic=<id>` (older format) | chat | yes | low |
| 72 | AnythingLLM (self-hosted) | any origin (default localhost:3001) | `/workspace/<slug>/t/<threadSlug>` | chat | yes | medium |
| 73 | NextChat (self-hosted) | any origin | `#/chat` (no id) | chat | yes | low |
| 74 | SillyTavern | localhost:8000 or any origin | no id in the URL | companion | yes | medium |
| 75 | Ollama | none | Ollama has no browser chat of its own; people reach it through Open WebUI, LibreChat or AnythingLLM (rows 69, 70, 72) | — | — | high |

**Self-hosted tools (rows 69–75)** cannot be listed in the manifest ahead of time, because they run on any address. They need optional host permissions requested at runtime for an origin the user enters, plus detection from the page itself.

**Dead or not worth adding:**
- **Phind** shut down on Jan 16, 2026 ([tooldirectory.ai](https://tooldirectory.ai/tools/phind)).
- **Dot by New Computer** shut down on Oct 5, 2025.
- **Liner** answers `getliner.com` with "Liner has moved" and loads its assets from liner.com. I did not check the new site.

**Changes affecting providers Threadkeeper already supports:**
- **Kimi** launched an international site at **www.kimi.ai** on 2026-08-30. Threadkeeper's manifest lists `kimi.ai` but not `www.kimi.ai`.
- **Microsoft Copilot** now sends copilot.microsoft.com to `copilot.com/chat`. Conversations are at `copilot.com/chat/conversation/<uuid>`.
- **Claude** has a new `/duet` path on claude.ai (row 6).

## Products that only exist as native apps

These cannot be captured by a Chrome extension:
- **Grok Bot**: desktop and mobile apps. The only browser route is X Chat on x.com.
- **Grok companions** (Ani and others): Grok iOS and Android apps.
- **Grok Telegram bot**: Telegram app (web.telegram.org exists but is a poor fit).
- **Muse**: the Mac app, the Muse Charm device and the WhatsApp channel. Its web app at muse.ai can be captured.
- **ChatGPT dots on mobile**: mobile web is not supported, and Slack, Teams and SMS conversations are outside the browser.
- **Meta AI inside WhatsApp, Instagram and Messenger**: these surfaces are mostly apps.
- **Ant LingGuang 灵光**: lingguang.com appears to be a landing page only; the product is an app.
- **Dot by New Computer**: was iOS only and is now gone.
- **Desktop and IDE products**:
  - ChatGPT, Claude, Copilot and Perplexity desktop apps
  - Codex CLI
  - Cursor, Windsurf and Antigravity IDEs
  - Ollama, LM Studio, Jan and Msty
  - Doubao and Kimi desktop apps
  - Siri and Apple Intelligence
- **Alexa+**: alexa.amazon.com went into a redirect loop when I tested it, so I could not confirm a web chat.

## Recommended provider ids

These follow Threadkeeper's existing ids (`chatgpt, claude, claude_code, codex, grok, grok_x, gemini, ai_studio, perplexity, deepseek, mistral, copilot, kimi, imported`).

**On hosts Threadkeeper already has permission for**, told apart by URL path the same way `claude_code` is today:
- `chatgpt_dots` (chatgpt.com/dots)
- `grok_bot` (x.com/i/chat)
- `claude_duet` (claude.ai/duet)
- `github_copilot`

**New hosts, grouped by category:**
- **Agent:** `muse`, `meta_ai`, `diandian`, `manus`, `genspark`, `minimax_agent`, `flowith`, `gemini_enterprise`
- **Chat:**
  - `poe`, `huggingchat`, `qwen`, `qianwen`, `doubao`, `dola`, `zai`, `chatglm`
  - `yuanbao`, `tencent_ima`, `wenxin`, `stepfun`, `longcat`
  - `duck_ai`, `lumo`, `kagi_assistant`, `arena`, `openrouter`
  - `t3_chat`, `venice`, `monica`, `mammouth`, `abacus_chatllm`, `chathub`, `typingmind`
  - `gemini_notebook`, `notion_ai`, `m365_copilot`
- **Search:** `zhida`, `you_com`, `felo`, `google_ai_mode`
- **Companion:** `character_ai`, `pi`, `replika`, `kindroid`, `nomi`, `talkie`, `polybuzz`, `janitor_ai`, `spicychat`
- **Coding agent:** `cursor_agents`, `devin`, `jules`, `factory`, `amp`, `opencode`
- **Builder:** `replit`, `lovable`, `bolt`, `v0`, `base44`, `firebase_studio`, `figma_make`, `emergent`, `same`
- **Self-hosted, on an origin the user grants:** `open_webui`, `librechat`, `lobechat`, `anythingllm`, `nextchat`, `sillytavern`, plus a catch-all `custom_web` for any other origin

Name the product rather than the company. For example, keep `gemini_notebook` and treat `notebooklm` as an alias for import and migration. Keep `meta_ai` and `muse` separate: they are different products on different hosts.

## Sources

- xAI Grok Bot: https://docs.x.ai/grok-bot/overview, https://docs.x.ai/grok-bot/faq, https://docs.x.ai/grok-bot/chat-and-collaboration, https://www.datacamp.com/blog/grok-bot, https://www.layer3labs.io/guides/what-is-grok-bot
- OpenAI dots: https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/, https://www.datacamp.com/blog/openai-dots, https://smartscope.blog/blog/openai-dots-user-guide-creation-steps-initial-setup-2026/, https://penchan.co/ai/chatgpt/chatgpt-dots/, https://github.com/mvanhorn/agent-tincan (docs/adapters/web-agents.md), https://github.com/MShneur/ghost-in-the-loop
- Meta Muse and Muse Spark: https://www.axios.com/2026/09/08/meta-debuts-muse-personal-ai-agent, https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/, https://en.wikipedia.org/wiki/Muse_(AI_agent), https://www.datacamp.com/blog/muse-agent, https://about.fb.com/news/2026/04/int, https://alternativeto.net/news/2026/4/meta-starts-its-new-muse-ai-model-family-with-muse-spark-in-a-broader-ai-strategy-reset/
- Xiaohongshu Dots and Diandian: https://baike.baidu.com/en/item/Dots/2411753, https://datanorth.ai/news/dots-studio-releases-dots3-note-preview, https://eu.36kr.com/en/p/3977478232184708
- Dot by New Computer: https://techcrunch.com/2025/09/05/personalized-ai-companion-app-dot-is-shutting-down
- Grok on Telegram and Grok companions: https://techcrunch.com/2025/05/28/xai-to-pay-300m-in-telegram-integrate-grok-into-app, https://www.engadget.com/ai/groks-ai-chatbot-now-includes-companions-for-you-to-romance-133017601.html
- Provider hosts and URL patterns, from open-source capture code current to Oct–Nov 2026: https://github.com/pooriaarab/foxcache (docs/providers), https://github.com/urzeye/ophel (src/adapters, registry/sites), https://github.com/henrimedeiros/aimori, https://github.com/anzchy/chat-memo-pro, https://github.com/JASON-QWeb/AiChat-QuickJump, https://github.com/mir-ashiq/metaai-api
- Status checks: Phind https://tooldirectory.ai/tools/phind; You.com https://thenewstack.io/how-you-com-survived-chatgpt-with-a-pivot-to-enterprise-ai/; Manus acquisition https://www.techradar.com/pro/meta-buys-manus-for-usd2-billion-to-power-high-stakes-ai-agent-race; Pi https://messengerbot.app/pi-by-inflection-ai-2026-features-safety-and-how-it-compares/

All downloads are in /tmp/claude-0/-home-user/d6f09056-d3f2-52cc-95e4-14934adda9a1/scratchpad/research/. They were only read and searched, never run. The cloned reference repositories are in /tmp/claude-0/-home-user/d6f09056-d3f2-52cc-95e4-14934adda9a1/scratchpad/research/repos/. No files under /home/user/threadkeeper or /home/user/sidebar-dock were changed.