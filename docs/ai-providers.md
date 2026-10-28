# AI providers in Still

Still's AI editor sends only the request, conversation history and context selected for that turn. The local bridge owns the application instruction and streaming transport. Sources are quoted as untrusted reference data, and the assistant drafts text for the user to accept; provider responses do not automatically change library items, run commands or open files.

## Provider configuration

Start the local bridge, pair it with Still using its bridge token, then open AI provider settings. Add an API provider or select a supported installed CLI agent. Provider setup, model discovery, connection testing and generation are separate actions. Saving a provider makes no network request. Testing an API provider lists its models; it does not perform or prove inference. A successful model list does not establish entitlement to every listed model.

| Provider type | Default base URL | Generation transport | Embeddings | Authentication |
| --- | --- | --- | --- | --- |
| `openai` | `https://api.openai.com/v1` | Responses API with server-sent events | `text-embedding-3-small` (default), `text-embedding-3-large` | API key |
| `anthropic` | `https://api.anthropic.com/v1` | Messages API, version `2026-10-21` | None; use Voyage AI | API key; optional workspace ID |
| `openai-compatible` | (your URL) | Chat Completions | Your server's `/embeddings` model | Optional API key and explicit base URL |
| `anthropic-compatible` | (your URL) | Messages-compatible server-sent events | None | Optional API key and explicit base URL |
| `openrouter` | `https://openrouter.ai/api/v1` | Chat Completions | None | API key |
| `cloudflare` | `https://api.cloudflare.com/client/v4` | Workers AI OpenAI-compatible Chat Completions | None | Account ID and API token |
| `bedrock` | `https://bedrock-runtime.<region>.amazonaws.com` | ConverseStream with signed AWS event-stream frames | None | Explicit AWS credentials or selected AWS CLI credential resolution |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `streamGenerateContent` with server-sent events | `gemini-embedding-2` (default), `gemini-embedding-001` | Gemini API key |
| `ollama` | `http://127.0.0.1:11434` | Native `/api/chat` NDJSON | `/api/embed` with a local model such as `embeddinggemma` | Local server; optional configured key |
| `lmstudio` | `http://127.0.0.1:1234/v1` | OpenAI-compatible Chat Completions | Your loaded embedding model | Local server; optional configured key |
| `xai` | `https://api.x.ai/v1` | Chat Completions (Grok) | None | API key |
| `mistral` | `https://api.mistral.ai/v1` | Chat Completions | `mistral-embed` (default), `codestral-embed` | API key |
| `groq` | `https://api.groq.com/openai/v1` | Chat Completions | None | API key |
| `deepseek` | `https://api.deepseek.com` | Chat Completions | None | API key |
| `voyage` | `https://api.voyageai.com/v1` | None (embeddings only) | `voyage-4` (default), `voyage-4-large`, `voyage-4-lite`, `voyage-code-4` and earlier | API key |

`GET /ai/providers` returns this catalog with UI metadata per type: `keyRequired`, `temperature` (whether the control exists at all), `maxOutputTokens` (the default output cap, or `null` when the provider's own default applies), `streamUsage` and `embeddings: {default, models}` or `null`. Voyage keys created in MongoDB Atlas use `https://ai.mongodb.com/v1`; enter that as the base URL for those keys.

Use the exact model ID discovered from your account or entered manually. Cloudflare model names such as `@cf/...` are preserved rather than replaced with internal model UUIDs. Bedrock inference profile IDs or ARNs can be entered when required by the model. Generic Azure support is not claimed; an Azure endpoint with different routing and authentication requires its own adapter.

The default endpoint can be changed for a compatible service. Remote endpoints require HTTPS. HTTP is allowed only for `localhost`, `127.0.0.1` and `::1`. Base URLs cannot contain embedded credentials, query strings or fragments. Requests reject redirects so an endpoint cannot forward authentication to another location.

Temperature, reasoning effort and image support start disabled or unspecified, except for a new first-party `anthropic` provider, which starts with image input and the efforts `low`, `medium`, `high`, `xhigh` and `max` enabled because every current Claude model accepts them. Enable the others only after checking the chosen model's contract. The bridge sends temperature only when explicitly enabled and configured; it sends effort only when the value appears in your configured supported-effort list. Model discovery reports image and effort metadata when the provider actually returns it, and leaves unknown capabilities unknown. It never substitutes a different model.

Model discovery follows pagination: Anthropic `GET /v1/models?limit=1000` then `after_id` while `has_more`, and Gemini `pageSize=1000` then `pageToken`, up to 2,000 models. Each model reports `kind` (`chat`, `embedding`), `contextWindow` and `maxOutputTokens` when the provider publishes them. Gemini models that neither generate nor embed (image and video models) are left out.

### Anthropic (Claude)

The `anthropic` type sends `anthropic-version: 2026-10-21`. That version rejects `temperature`, `top_p` and `top_k` on every model, so the bridge never sends them: the temperature capability does not exist for this type, a stored temperature from an older configuration is dropped, and a request that asks for one fails before any network call. Each request:

- streams with `stream: true` and a default `max_tokens` of 32,000 (thinking tokens count against it; set `maxOutputTokens` to change it);
- sends `thinking: {type: "adaptive", display: "summarized"}` for Claude 4.6 and later (Haiku 5 and later), and for an unrecognized model ID when an effort is chosen, and `output_config: {effort}` when you pick one of `low`, `medium`, `high`, `xhigh`, `max`. Older Claude models (such as Opus 4.5) reject adaptive thinking, so they receive the effort alone. Claude Opus 5.5 and Haiku 5.5 default to `medium` when no effort is sent;
- adds top-level `cache_control: {type: "ephemeral"}` so a repeated system prompt and history are served from the prompt cache;
- for exactly `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-fable-5-1` (optionally with a dated `-YYYYMMDD` suffix), adds the header `anthropic-beta: server-side-fallback-2026-07-01` and body `fallbacks: "default"`, so a safety-classifier decline is retried server-side on Anthropic's recommended model in the same stream. The `done` event then reports the serving `model` and `fallback: {from, to}`. Other Claude models (including Opus 5 and every Haiku) and Anthropic-compatible endpoints never get this;
- sends `anthropic-workspace-id` when the provider has `config.workspaceId` (required for API keys that are not scoped to a workspace; the error message says so).

`stop_reason: "refusal"` ends the request as an error that quotes `stop_details.category` and `explanation` when present, keeps the partial text and reports `stopReason: "refusal"`. `stop_reason: "max_tokens"` completes normally with that stop reason when there is text, and fails with a clear message when the whole budget went to thinking.

`anthropic-compatible` endpoints (proxies, gateways and other servers that speak the Messages API) keep `anthropic-version: 2023-06-01` unless `config.anthropicVersion` sets another date, default to 4,096 output tokens, and receive `thinking`/`output_config` only when an effort is chosen. They never receive caching or fallback fields.

### Other providers

OpenAI uses `reasoning.effort`. Anthropic uses adaptive thinking plus `output_config.effort`. Compatible Chat Completions (including xAI, Mistral, Groq and DeepSeek) uses `reasoning_effort`, Gemini uses `thinkingConfig.thinkingLevel` with `includeThoughts: true`, and Ollama uses its model-defined `think` value. Chat Completions requests ask for streamed usage with `stream_options: {include_usage: true}` for OpenAI-compatible servers, OpenRouter, LM Studio, xAI, Groq and DeepSeek; Mistral and Cloudflare report usage without it. When no output limit is configured, OpenAI uses 32,000 `max_output_tokens`; Chat Completions providers other than Cloudflare (4,096) and Gemini omit the limit so the provider's default applies; Ollama and Bedrock keep 4,096. These controls remain model-specific: an endpoint may reject a configured value. Bedrock does not map a generic effort across vendors; use the selected model's documented `additionalModelRequestFields` instead. Context selection is managed by the editor's source budget, with a separate local request size bound. No tokenizer-based claim about exact model context usage is made.

Explicitly attached images must be raster PNG, JPEG, GIF or WebP data, at most three attachments and 8 MB per decoded image. The HTTP request and provider service impose additional total-size limits. Image input must be enabled for that provider. Remote image URLs and filesystem paths are not fetched by this service. CLI chat currently accepts text context; choose an image-capable API for image requests.

## Credentials and local storage

Provider metadata and credentials are encrypted together in `bridge/.local/ai-providers.enc.json` using AES-256-GCM. A separate random 32-byte key lives beside it as `ai-providers.enc.json.key`. New files request mode `0600`; Windows access follows the containing directory's inherited ACLs. The directory is excluded from Git and extension packaging.

This is local encryption, not a hardware-backed vault. Someone who can read both local files can decrypt the provider settings. Keep both private and back them up together if you need recovery. A missing key or tampered ciphertext fails closed and is not silently overwritten. Keys are never returned by provider list/save endpoints, placed in extension storage, included in library backups or logged by the service. Blank credential fields preserve an existing key; an explicit `null` removes that credential field.

API usage starts only when you explicitly test/discover models or send a chat request. Inference may incur the chosen provider's charges. This implementation does not create provider accounts, purchase credits, grant cloud permissions or change account budgets.

For Bedrock's default credential option, Still runs only:

```text
aws configure export-credentials --format process [--profile selected-profile]
```

It runs through a direct, hidden process with allowlisted arguments and a bounded timeout; no shell is involved. The AWS CLI resolves its configured credential chain. Still does not read arbitrary AWS files, implement its own SSO login or automatically refresh a user's login. Exported temporary credentials remain in memory for that request and are not saved into the provider registry. Selecting this mode authorizes that resolution when you test or generate, rather than whenever settings are displayed.

## CLI agents and Codex sign-in

CLI agents are implemented separately in `bridge/ai/cli.mjs`. The router dispatches only `cli:codex` and `cli:claude`; it passes the same server-owned instruction and selected text context as API chat. It cannot pass an arbitrary command, executable, workspace or tool list from an AI chat request. Installed-agent discovery and actual sign-in status are reported separately.

Codex device sign-in is delegated to the supported installed Codex app-server flow. The UI receives the verification URL, short user code and job status; the CLI owns authentication. Still does not extract or repurpose Codex OAuth tokens as OpenAI API keys. Starting or cancelling sign-in requires its own explicit UI action. An authenticated CLI session is distinct from a separately configured API provider.

The exact agent flags, supported-version checks and isolation limits are defined and tested in the CLI adapter. No universal inability to use tools is implied merely by a prompt. An unsupported CLI is reported as unsupported instead of being launched with guessed flags.

## Streaming and failures

The editor receives newline-delimited JSON from the authenticated local bridge:

```text
{"type":"start","promptVersion":"still-assistant-1.1","sources":[...]}
{"type":"thinking","text":"A reasoning summary fragment"}
{"type":"delta","text":"A live portion of the answer"}
{"type":"done","text":"The complete answer","model":"actual-model","usage":{...},"stopReason":"end_turn"}
```

`thinking` events carry reasoning summaries when the provider streams them (Anthropic `thinking_delta`, Gemini thought parts when an effort is chosen, Ollama `message.thinking`, `reasoning_content`/`reasoning` from xAI, DeepSeek and OpenRouter, and Mistral thinking parts). OpenAI streams `response.reasoning_summary_text.delta` only when a request asks for `reasoning.summary`, which the bridge does not send because some accounts must be verified first; OpenAI answers therefore arrive without `thinking` events. They never enter `text`, are capped at 4 MiB per answer, and clients that predate them ignore unknown event types.

A failure ends with `type: "error"`, `message`, `partialText`, `aborted` and, for a model refusal, `stopReason: "refusal"`; it never emits a successful `done` event. Partial output stays identifiable as incomplete. A client disconnect or Stop action aborts the actual provider request or owned CLI task. Both routes and transports have bounded timeouts and output limits, with no automatic retries or fallback provider that could duplicate cost. Token-limit stop reasons remain available in the completion result.

Provider requests share the router's 300-second limit (the provider service default now matches it), model listing is capped at 30 seconds and embeddings at 120 seconds.

OpenAI, Anthropic and compatible endpoints use SSE framing with incremental UTF-8 decoding. Ollama uses NDJSON. Bedrock uses SigV4-signed ConverseStream requests and validates the CRCs of AWS event-stream frames. Missing terminal events, malformed events, late provider errors and corrupted binary frames fail instead of becoming successful completions.

## Embeddings

`embed({providerId, inputs, model?, dimensions?, inputType})` turns 1 to 256 non-empty texts (each at most 100,000 characters, 8 MiB in total) into vectors. `inputType` is `document` (default) or `query`. The model comes from the request, then `config.embeddingModel`, then the catalog default; dimensions come from the request or `config.embeddingDimensions` (1 to 8,192). The result is `{vectors: number[][], model, dimensions, usage: {inputTokens}}`, in input order.

| Provider | Request |
| --- | --- |
| OpenAI, OpenAI-compatible, LM Studio | `POST {base}/embeddings` with `{model, input, encoding_format: "float", dimensions?}` |
| Voyage AI | `POST {base}/embeddings` with `{input, model, input_type, truncation: true, output_dimension?}` |
| Gemini | `POST {base}/models/{model}:batchEmbedContents`, 100 texts per call. `gemini-embedding-001` gets `taskType` `RETRIEVAL_DOCUMENT` or `RETRIEVAL_QUERY`; `gemini-embedding-2` rejects `taskType`, so texts are prefixed `task: search result \| query: ` or `title: none \| text: `. Vectors are L2-normalized. |
| Mistral | `POST {base}/embeddings` with `{model, input, output_dimension?}` |
| Ollama | `POST {base}/api/embed` with `{model, input, truncate: true, dimensions?}` |

Anthropic has no embeddings API; the error points to Voyage AI, Anthropic's recommended embeddings partner. Chat-only types (xAI, Groq, DeepSeek, OpenRouter, Cloudflare, Bedrock) are refused before any request. Embedding requests cost money on hosted providers, so the bridge makes them only when the extension asks. Testing a Voyage provider embeds one short query (it has no model-list endpoint) and reports `inferenceTested: true`.

## HTTP contract

The existing bridge validates bearer token, Host and Origin before invoking the AI router. Chat messages cannot override `system`; the bridge calls `assemblePrompt` itself. The server reads no source path or URL from the selected context.

| Method and path | Result |
| --- | --- |
| `GET /ai/providers` | Sanitized providers, provider-type catalog, detected CLI agents and `runtime: {projectRoot, nodePath, mcpEntry, platform, features}` |
| `POST /ai/providers` | Save encrypted provider; return `{provider}` |
| `DELETE /ai/providers/:id` | Remove provider settings |
| `POST /ai/providers/:id/test` | Explicit metadata connection test; `inferenceTested: false` |
| `GET /ai/providers/:id/models` | Explicit model discovery; `{models}` |
| `GET /ai/cli/auth` | CLI sign-in state; `{agents}` |
| `POST /ai/cli/login` | Start Codex device sign-in; `{login}` |
| `GET /ai/cli/login/:id` | Read the retained sign-in job; `{login}` |
| `POST /ai/cli/login/:id/cancel` | Cancel that owned job; `{login}` |
| `POST /ai/chat` | Application-owned prompt and streaming NDJSON answer |
| `POST /ai/embeddings` | `{providerId, inputs, model?, dimensions?, inputType?}` → `{vectors, model, dimensions, usage}`; aborted when the client disconnects |

`runtime.nodePath` and `runtime.mcpEntry` are the exact strings `bridge/connections.mjs` writes into client configurations; the extension passes them to `getMcpSetup(projectRoot, {nodePath})` so manual snippets match automatic setup. `runtime.features` lists `embeddings`, `thinkingEvents`, `semanticSearchTool` and the `anthropicVersion` in use.

`createAiProviderService({configPath?,fetch?,timeoutMs?})` exposes `listProviders`, `saveProvider`, `deleteProvider`, `testProvider`, `listModels`, `generate` (with `onDelta` and `onThinking` callbacks) and `embed`. `createAiRouter({timeoutMs?,providers?,cli?,embeddingTimeoutMs?})` exposes `handle(request,response,{readJson,reply})`, which returns whether it handled the route. Dependency injection supports offline tests without account credentials.

## Evidence and limits

Provider tests cover encrypted CRUD/reopen/tamper detection, explicit-only networking, compatible endpoints, SSE fragmentation/Unicode, actual request parameter mapping (including the Anthropic `2026-10-21` request shape, fallback opt-in per model, refusals and output-budget stops, and the xAI/Mistral/Groq/DeepSeek endpoints), paginated metadata discovery, every embeddings mapping and its validation, unsupported controls, image gating, secret redaction, redirects, partial failures and cancellation. Bedrock signing matches a published AWS Smithy fixture; binary streaming tests verify CRCs and usage frames. Router tests use real loopback HTTP to verify server-owned prompts, live NDJSON event order, API/CLI dispatch, malformed inputs, client disconnect and timeout. All service credentials used in these tests are fake and test files live in isolated temporary directories.

No live paid inference, provider entitlement, production Cloudflare/AWS deployment, real API account or real OAuth completion has been used to claim provider verification. End-to-end installed-browser and account results must be reported separately from these local adapter tests.

Primary references checked October 25, 2026, with the additions checked October 28, 2026 (Anthropic versioning, refusals and fallbacks; xAI, Mistral, Groq, DeepSeek and Voyage; Gemini and Ollama embeddings):

- [Anthropic API versioning](https://platform.claude.com/docs/en/api/versioning), [refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback), [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [embeddings guidance](https://platform.claude.com/docs/en/build-with-claude/embeddings).
- [xAI chat completions](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions), [Mistral API](https://docs.mistral.ai/api/) and [embeddings endpoint](https://docs.mistral.ai/api/endpoint/embeddings), [Groq OpenAI compatibility](https://console.groq.com/docs/openai), [DeepSeek API](https://api-docs.deepseek.com/).
- [Voyage AI embeddings API](https://docs.voyageai.com/reference/embeddings-api), [Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings), [Ollama embed](https://docs.ollama.com/api/embed), [OpenAI embeddings](https://developers.openai.com/api/docs/guides/embeddings).
- [OpenAI streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses).
- [Anthropic streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming), [effort](https://platform.claude.com/docs/en/build-with-claude/effort), and [model discovery](https://platform.claude.com/docs/en/api/models/list).
- [Cloudflare OpenAI-compatible endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/).
- [OpenRouter streaming](https://openrouter.ai/docs/api_reference/streaming).
- [Bedrock ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html), [foundation model discovery](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html), and [AWS CLI credential export](https://docs.aws.amazon.com/cli/latest/reference/configure/export-credentials.html).
- [AWS SigV4](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html) and [Smithy signing reference implementation](https://github.com/smithy-lang/smithy-typescript/blob/main/packages/signature-v4/src/SignatureV4Base.ts).
- [Gemini streaming content API](https://ai.google.dev/api/generate-content), [Gemini thinking controls](https://ai.google.dev/gemini-api/docs/thinking).
- [Ollama chat API](https://docs.ollama.com/api/chat), [LM Studio Chat Completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions).
