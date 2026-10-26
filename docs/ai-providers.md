# AI providers in Still

Still's AI editor sends only the request, conversation history and context selected for that turn. The local bridge owns the application instruction and streaming transport. Sources are quoted as untrusted reference data, and the assistant drafts text for the user to accept; provider responses do not automatically change library items, run commands or open files.

## Provider configuration

Start the local bridge, pair it with Still using its bridge token, then open AI provider settings. Add an API provider or select a supported installed CLI agent. Provider setup, model discovery, connection testing and generation are separate actions. Saving a provider makes no network request. Testing an API provider lists its models; it does not perform or prove inference. A successful model list does not establish entitlement to every listed model.

| Provider type | Generation transport | Authentication |
| --- | --- | --- |
| `openai` | Responses API with server-sent events | API key |
| `anthropic` | Messages API with server-sent events | API key |
| `openai-compatible` | Chat Completions with server-sent events | Optional API key and explicit base URL |
| `anthropic-compatible` | Messages-compatible server-sent events | Optional API key and explicit base URL |
| `openrouter` | Chat Completions with server-sent events | API key |
| `cloudflare` | Workers AI OpenAI-compatible Chat Completions | Account ID and API token |
| `bedrock` | ConverseStream with signed AWS event-stream frames | Explicit AWS credentials or selected AWS CLI credential resolution |
| `gemini` | `streamGenerateContent` with server-sent events | Gemini API key |
| `ollama` | Native `/api/chat` NDJSON | Local server; optional configured key |
| `lmstudio` | OpenAI-compatible Chat Completions | Local server; optional configured key |

Use the exact model ID discovered from your account or entered manually. Cloudflare model names such as `@cf/...` are preserved rather than replaced with internal model UUIDs. Bedrock inference profile IDs or ARNs can be entered when required by the model. Generic Azure support is not claimed; an Azure endpoint with different routing and authentication requires its own adapter.

The default endpoint can be changed for a compatible service. Remote endpoints require HTTPS. HTTP is allowed only for `localhost`, `127.0.0.1` and `::1`. Base URLs cannot contain embedded credentials, query strings or fragments. Requests reject redirects so an endpoint cannot forward authentication to another location.

Temperature, reasoning effort and image support start disabled or unspecified. Enable them only after checking the chosen model's contract. The bridge sends temperature only when explicitly enabled and configured; it sends effort only when the value appears in your configured supported-effort list. Model discovery reports image and effort metadata when the provider actually returns it, and leaves unknown capabilities unknown. It never substitutes a different model.

OpenAI uses `reasoning.effort`. Anthropic uses adaptive thinking plus `output_config.effort`. Compatible Chat Completions uses `reasoning_effort`, Gemini uses `thinkingConfig.thinkingLevel`, and Ollama uses its model-defined `think` value. These controls remain model-specific: an endpoint may reject a configured value. Bedrock does not map a generic effort across vendors; use the selected model's documented `additionalModelRequestFields` instead. Context selection is managed by the editor's source budget, with a separate local request size bound. No tokenizer-based claim about exact model context usage is made.

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
{"type":"start","promptVersion":"still-assistant-1.0","sources":[...]}
{"type":"delta","text":"A live portion of the answer"}
{"type":"done","text":"The complete answer","model":"actual-model","usage":{...}}
```

A failure ends with `type: "error"`, `message`, `partialText` and `aborted`; it never emits a successful `done` event. Partial output stays identifiable as incomplete. A client disconnect or Stop action aborts the actual provider request or owned CLI task. Both routes and transports have bounded timeouts and output limits, with no automatic retries or fallback provider that could duplicate cost. Token-limit stop reasons remain available in the completion result.

OpenAI, Anthropic and compatible endpoints use SSE framing with incremental UTF-8 decoding. Ollama uses NDJSON. Bedrock uses SigV4-signed ConverseStream requests and validates the CRCs of AWS event-stream frames. Missing terminal events, malformed events, late provider errors and corrupted binary frames fail instead of becoming successful completions.

## HTTP contract

The existing bridge validates bearer token, Host and Origin before invoking the AI router. Chat messages cannot override `system`; the bridge calls `assemblePrompt` itself. The server reads no source path or URL from the selected context.

| Method and path | Result |
| --- | --- |
| `GET /ai/providers` | Sanitized providers, provider-type catalog and detected CLI agents |
| `POST /ai/providers` | Save encrypted provider; return `{provider}` |
| `DELETE /ai/providers/:id` | Remove provider settings |
| `POST /ai/providers/:id/test` | Explicit metadata connection test; `inferenceTested: false` |
| `GET /ai/providers/:id/models` | Explicit model discovery; `{models}` |
| `GET /ai/cli/auth` | CLI sign-in state; `{agents}` |
| `POST /ai/cli/login` | Start Codex device sign-in; `{login}` |
| `GET /ai/cli/login/:id` | Read the retained sign-in job; `{login}` |
| `POST /ai/cli/login/:id/cancel` | Cancel that owned job; `{login}` |
| `POST /ai/chat` | Application-owned prompt and streaming NDJSON answer |

`createAiProviderService({configPath?,fetch?,timeoutMs?})` exposes `listProviders`, `saveProvider`, `deleteProvider`, `testProvider`, `listModels` and `generate`. `createAiRouter({providers?,cli?,timeoutMs?})` exposes `handle(request,response,{readJson,reply})`, which returns whether it handled the route. Dependency injection supports offline tests without account credentials.

## Evidence and limits

Provider tests cover encrypted CRUD/reopen/tamper detection, explicit-only networking, compatible endpoints, SSE fragmentation/Unicode, actual request parameter mapping, metadata discovery, unsupported controls, image gating, secret redaction, redirects, partial failures and cancellation. Bedrock signing matches a published AWS Smithy fixture; binary streaming tests verify CRCs and usage frames. Router tests use real loopback HTTP to verify server-owned prompts, live NDJSON event order, API/CLI dispatch, malformed inputs, client disconnect and timeout. All service credentials used in these tests are fake and test files live in isolated temporary directories.

No live paid inference, provider entitlement, production Cloudflare/AWS deployment, real API account or real OAuth completion has been used to claim provider verification. End-to-end installed-browser and account results must be reported separately from these local adapter tests.

Primary references checked October 25, 2026:

- [OpenAI streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses).
- [Anthropic streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming), [effort](https://platform.claude.com/docs/en/build-with-claude/effort), and [model discovery](https://platform.claude.com/docs/en/api/models/list).
- [Cloudflare OpenAI-compatible endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/).
- [OpenRouter streaming](https://openrouter.ai/docs/api_reference/streaming).
- [Bedrock ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html), [foundation model discovery](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html), and [AWS CLI credential export](https://docs.aws.amazon.com/cli/latest/reference/configure/export-credentials.html).
- [AWS SigV4](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html) and [Smithy signing reference implementation](https://github.com/smithy-lang/smithy-typescript/blob/main/packages/signature-v4/src/SignatureV4Base.ts).
- [Gemini streaming content API](https://ai.google.dev/api/generate-content), [Gemini thinking controls](https://ai.google.dev/gemini-api/docs/thinking).
- [Ollama chat API](https://docs.ollama.com/api/chat), [LM Studio Chat Completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions).
