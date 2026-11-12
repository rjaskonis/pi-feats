# OpenAI-compatible profile API

The API Server exposes existing Pi profiles through Chat Completions and Responses, with text output and text/image/document input. This is independent of Applications, identity keys, handlers and session rollover.

| Method | Direct path | Console proxy path |
| --- | --- | --- |
| GET | `/v1/models` | `/api/pi/v1/models` |
| POST | `/v1/chat/completions` | `/api/pi/v1/chat/completions` |
| POST | `/v1/responses` | `/api/pi/v1/responses` |

Use the existing API token in `Authorization: Bearer <PI_API_TOKEN>`. The Console proxy also preserves its existing session authentication. No extra credential is created. Configure TLS, authentication and network policy before exposing either service. Disable buffering in any external reverse proxy for SSE; the application sends `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` but cannot control infrastructure buffering.

## Profiles and execution

`model` is required and selects an exact Pi profile name, including `default`. It never selects a provider model. Names follow `[A-Za-z][A-Za-z0-9_-]{0,63}`. Missing profiles return HTTP 404 with `model_not_found`. Model discovery publishes only IDs, `object`, `owned_by: "pi"` and `created: 0` (a stable sentinel because profile creation times are not recorded).

Each request launches a dedicated SDK worker through the existing profile launcher, loading that profile's environment, credentials, instructions, extensions, Skills and tool policy. Named-profile Nono settings are enforced without an unsandboxed fallback. Shared packages remain root-owned. Execution requires the modern Pi SDK APIs available in Pi 1.5.2; worker initialization fails closed if the host lacks them.

The worker creates a `SessionManager.inMemory()` before constructing its only executing session. User and assistant history is restored as native structured messages, not a text transcript. There is no persistent chat transcript and no conversation reuse between calls, including simultaneous calls to one profile. Profile resources remain durable and **tools can have side effects**.

System and developer messages map to ordered request-scoped system-prompt additions. Pi has no distinct developer role: both roles have the same instruction level. Instruction messages are hoisted out of conversational history in their original relative order; Responses top-level `instructions` is appended last. These additions do not replace the profile prompt, SOUL, Guardrails or tool declarations. They are not native system loadout snapshots, which would otherwise change active tools when restoring history.

The final conversational message must contain user text or attachments. Assistant-prefill, instruction-only and assistant-terminal histories are rejected, not repaired with a synthetic prompt. Typical SDK `messages`/string `input` requests and explicit prior output followed by a user message are supported.

## JavaScript

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.PI_API_TOKEN,
  baseURL: "http://127.0.0.1:8767/v1",
  // Alternative: https://pi.example.com/api/pi/v1
});

const completion = await client.chat.completions.create({
  model: "support",
  messages: [
    { role: "system", content: "Answer briefly." },
    { role: "user", content: "My name is Ada." },
    { role: "assistant", content: "Hello, Ada." },
    { role: "user", content: "What is my name?" },
  ],
});
console.log(completion.choices[0].message.content);

const stream = client.responses.stream({
  model: "support", input: "Hello", store: false,
});
for await (const event of stream) {
  if (event.type === "response.output_text.delta") process.stdout.write(event.delta);
}
console.log((await stream.finalResponse()).output_text);
```

Chat streaming uses `stream: true`; `stream_options: { include_usage: true }` requests a final usage-only chunk. Chat streams terminate with `[DONE]`. Responses streams use typed lifecycle events with sequential `sequence_number` values and terminate with `response.completed`, `response.incomplete` or `response.failed`, not `[DONE]`.

## Python

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["PI_API_TOKEN"],
    base_url="http://127.0.0.1:8767/v1",
)
response = client.responses.create(model="support", input="Hello", store=False)
print(response.output_text)

with client.responses.stream(model="support", input="Hello", store=False) as stream:
    for event in stream:
        if event.type == "response.output_text.delta":
            print(event.delta, end="", flush=True)
    final_response = stream.get_final_response()
```

## Client options are ignored by default

No compatibility header or client-specific setting is required. Both POST endpoints accept and discard additional top-level options rather than returning `unsupported_parameter`. In particular:

- Client-owned `tools`, `tool_choice`, `parallel_tool_calls`, legacy `functions` and `function_call` are ignored. Only the selected Pi profile's tools execute; supplied client tools are never registered or called.
- Generation controls such as `temperature`, `top_p`, `top_k`, token limits (`max_tokens`, `max_completion_tokens`, `max_output_tokens`), penalties, seed, stop sequences and reasoning settings are ignored. The profile's configured provider/model and runtime settings remain unchanged. A caller-supplied token limit is not enforced.
- Output preferences such as structured `response_format` / `text.format`, log probabilities, modalities, audio options and `include` are ignored. The API still returns text without a JSON/schema guarantee or reasoning output.
- `n`, `store`, `background`, `truncation`, service-tier preferences and unknown provider-specific options are ignored. Every call still produces one synchronous, stateless response without storage, even if the caller asks otherwise.
- `user` and `safety_identifier` are ignored, including client-specific object values. They do not control identity routing, moderation or policy.

Ignored options are not parsed, validated, forwarded to the worker or applied to profile settings. HTTP body limits still cover the entire request, including ignored options. Core fields and actual conversation content remain validated. Stored-context references, tool-result input and unsupported content types are **not** ignored because doing so would silently lose conversational context.

This allows Open WebUI to send its built-in tool definitions and automatic-task generation settings unchanged. Open WebUI tools remain unused, while Pi profile tools stay active. Automatic titles, tags and suggestions still make additional agent calls and consume tokens; accepting their output-format preference does not guarantee JSON output.

## Images and documents

Images are native Pi image blocks, not base64 dumped into a text prompt. Both current and historical user messages retain images. PNG, JPEG, GIF and WebP are supported. The profile must select a vision-capable model and permit image input; otherwise the API returns `unsupported_image_model` or `image_input_disabled` before starting the public stream. Pi's image decoder validates the payload, and image resizing follows the profile settings and selected model limits. Attachments are accepted only in user messages; attachment-only user turns are valid.

Chat image example (replace `<base64>` with actual data):

```json
{
  "model": "support",
  "messages": [{ "role": "user", "content": [
    { "type": "text", "text": "Describe this image." },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,<base64>", "detail": "auto" } }
  ] }]
}
```

Responses image parts use `{ "type": "input_image", "image_url": "data:image/png;base64,<base64>" }`. `detail` is accepted as an advisory field; Pi controls image processing.

### Native files through Codex (preferred for Codex profiles)

When the selected profile uses Pi's `openai-codex-responses` API, documents are sent as **native `input_file` parts with their original bytes** through that same provider. The default destination is `https://chatgpt.com/backend-api/codex/responses`, using the profile's existing Codex authentication. There is no standalone `api.openai.com` client, separate API key, `/v1/files` upload or provider/model switch.

This works for both public protocols: Chat `file` parts and Responses `input_file` parts are normalized into the same Codex-native request. No special header or Open WebUI setting is needed. File `detail: "auto" | "low" | "high"` is preserved when supplied.

Pi 1.5.2's base message union cannot represent a file block. The bridge therefore keeps request-local file bindings alongside authoritative user/assistant history and replaces their internal markers at the final provider-payload boundary. It wraps the existing SDK stream function and exposes the expanded native file parts to existing provider-payload policy hooks, preserving profile instructions, authentication, internal tools, usage and cancellation. It never reattaches original files after a policy hook removes them; filtered-out required files fail explicitly. Text-only input guardrails do not automatically inspect binary document contents: document-content policies must inspect the native file parts or reject them. Files are reattached during tool turns, retries and compaction requests; internal markers and base64-as-text prompts are not sent to the model. Missing file context or a switch to an incompatible transport fails explicitly instead of silently dropping attachments.

On this path, **Python, Poppler, OCR and local Office parsers are not used to read documents**. Codex performs the file processing. A PDF with only page images can be interpreted by the model; it does not require a local text layer. Because PDF processing includes visual input, a vision-capable profile that permits images is required for native PDFs too.

Real end-to-end validation through our local `/v1/responses` endpoint succeeded with PDF, an image-only PDF, XLSX (including caller-supplied history), DOCX and CSV on `gpt-6.1-sol`. The byte-identical native file parts and the `chatgpt.com` destination were checked before transmission; the responses returned the expected file-only values. See [the evidence and reproduction procedure](CODEX-NATIVE-FILES.md).

Other file types are forwarded unchanged on the Codex path, but acceptance, parsing, context limits and fidelity remain model/backend capabilities. Spreadsheet ingestion is not an Excel engine: do not assume exact cell addressing, recalculated formulas or unrestricted full-workbook access. If a native Codex request fails, it is **not** silently retried through local extraction or a standalone OpenAI endpoint.

### Extraction fallback for other profile APIs

For profiles using a different API, documents retain the existing conversion to user-role text inside the selected profile worker, including Nono when enabled. Supported fallback formats:

- PDF: the real text layer, extracted by Poppler (`pdftotext`). Scanned/image-only PDFs fail with `document_text_missing`; perform OCR first or send page images to a vision-capable profile. Embedded diagrams/images are not rendered automatically.
- XLSX: sheet names, cell addresses, text, raw values, formulas and available cached results. Formulas/macros are never executed or recalculated. Styles, charts and date/number formatting are not rendered.
- DOCX: main-body paragraphs and tables. Headers, footers, embedded images and full layout fidelity are outside this extractor's scope.
- PPTX: slide text in presentation order, without slide rendering, notes or embedded images.
- UTF-8 TXT, Markdown, CSV, TSV, JSON and XML: decoded as text, without evaluating embedded content. Legacy binary XLS/DOC and password-protected documents are not supported.

Responses document example:

```json
{
  "model": "support",
  "input": [{ "role": "user", "content": [
    { "type": "input_text", "text": "Summarize this workbook." },
    { "type": "input_file", "filename": "report.xlsx", "file_data": "<base64>" }
  ] }]
}
```

`file_data` accepts raw base64 (provide a filename) or a MIME-qualified base64 data URL. Chat uses `{ "type": "file", "file": { "filename": "report.pdf", "file_data": "data:application/pdf;base64,<base64>" } }`. Images and multiple documents may be combined in one request. On the fallback path, extracted documents are labeled in user context. On the Codex path, original bytes are attached as native file content instead. Pi does not store the originals on disk or stage editable files for agent tools. Attachment failures never silently drop a file; the provider's own data-handling policies still apply.

Image URLs and `file_url` can reference publicly reachable HTTPS content. Downloads reject credentials, nonstandard ports, redirects, compressed HTTP bodies, loopback/private/link-local/reserved addresses and unsafe DNS results. The checked DNS address is pinned to the actual connection. No Pi API token, cookies or other ambient credentials are forwarded to attachment hosts. Each download has a 20-second deadline.

Open WebUI may already extract uploaded PDF/Office documents into retrieval context; that text remains supported without document dependencies in Pi. For direct file input, the UI/client must send the bytes or a public URL. A private Open WebUI `/api/v1/files/...` URL or an OpenAI `file_id` is not an attachment payload the Pi server can access automatically. Send `file_data` or let the client extract its own attachment; IDs are explicitly rejected with `unsupported_file_reference` rather than guessed, ignored or fetched with unrelated credentials.

### Fallback document runtime prerequisites

These prerequisites apply only to the non-Codex extraction fallback, not native Codex file input. Office document extraction requires **Python 3**, using only its standard library. PDF extraction additionally requires **Poppler's `pdftotext`**. These must exist in the Pi runtime/container and be accessible under the named profile's existing Nono policy. On Linux, the worker prefers `/usr/bin/python3` over environment shims. No dependencies are installed automatically and no additional profile sandbox permissions are granted.

For example, an administrator can include `python3` and `poppler-utils` in a Debian/Ubuntu runtime image. A missing executable produces `document_extractor_unavailable` (HTTP 503). This is an operational prerequisite, not permission for the API to install software or modify a container.

The extractor runs as a short-lived subprocess within the request's process group, with a 25-second deadline. On POSIX it also limits address space to 512 MiB and CPU time to 20 seconds. Office archives are bounded by entry count and expanded size; traversal paths, symlinks, encryption, duplicate entries, DTDs and entities are rejected. No archive is extracted to the filesystem, and PDF bytes are piped to Poppler without temporary files.

## Supported input and limits

- Chat `messages`: `system`, `developer`, `user`, `assistant`, with string content or `text` parts; user content also accepts `image_url` and `file` parts.
- Responses `input`: a string or message list. Text parts use `input_text`; user messages also accept `input_image` and `input_file`. Previous assistant output messages can use `output_text` with empty annotations/logprobs. Item IDs, status and phase are caller-owned transport metadata, never server lookup keys.
- `stream` is boolean. Chat `stream_options.include_usage` is a validated boolean when streaming; other stream options are ignored. For non-streaming requests and Responses, `stream_options` is ignored.
- Responses supports top-level string `instructions`. Non-null `previous_response_id` and `conversation` are rejected in both protocols: send explicit history in `messages` or `input` instead.
- `metadata`: at most 16 string entries, keys up to 64 characters, values up to 512 characters. Responses echoes it; Chat accepts it without storage or identity routing.
- At most 100 messages, 1,000 parts per message and 100,000 total text characters, including instructions, fallback-extracted documents and resize notes. Native Codex document content is not locally extracted or counted as text characters; the attachment byte limits and Codex's own context limits apply. Extracted text is never silently truncated.
- At most 10 attachments per request, 10 MiB per attachment and 20 MiB aggregate decoded attachment bytes, including history. Images must be no larger than 16,384 pixels on either axis or 40 megapixels. Encoded image bytes do not count as prompt-text characters.
- Compatibility POST JSON bodies are limited to 32 MiB to accommodate base64 overhead, consistently at the direct API, Console proxy and worker transport. Other existing API routes retain their own limits. External ingress/body limits may still require deployment-specific configuration.
- Visible output is bounded to 16 MiB. Worker frame, transport and writable backlog limits prevent unlimited pending output. Initialization has a 60-second deadline and each blocked SSE drain has a 30-second deadline. A caller disconnect cancels the agent and request-owned worker process group; force termination follows a one-second grace period when needed.

Actual tool calls/results in history, non-message Responses input items, audio/video parts and unsupported attachment formats/references are rejected rather than discarded. Unknown nested message/content fields and malformed supported fields also remain errors. Response retrieval/storage, server-managed conversations and WebSocket transport are not implemented. Profile-owned internal tools remain available; their calls and results are not exposed as client-owned function calls.

## Output, usage and failures

All assistant text is exposed incrementally, including narration before internal tools. Non-empty assistant turns are separated by two newlines in both JSON and SSE. Responses currently merges these turns into one output message. Reasoning blocks and raw tool results are never part of visible output. Terminal success waits for full Pi settlement, including automatic continuations and retries.

If an extension rewrites already-streamed text instead of preserving its prefix, the request fails with `output_rewritten`; it never reports a contradictory successful final response. This applies to JSON too so both modes have the same policy. Extensions that require arbitrary completed-message rewrites are not compatible with this incremental-output mode.

Usage is derived from Pi's authoritative execution ledger across model turns, retries, compaction and reported nested tool work. Restored assistant history has zero usage. Mapping: input = uncached input + cache reads + cache writes; cached = cache reads; output includes reasoning; reasoning is a subset, not added again to the total. Nested calls are counted through their already-aggregated parent tool usage, never counted twice. Work not reported by a tool cannot be inferred.

A model output limit maps to Chat `finish_reason: "length"` and Responses `status: "incomplete"` with `max_output_tokens`. Runtime/provider errors and deferred provider responses are failures, not successful completion. Empty/non-text-only results fail outside this text-output scope.

Errors use `{ "error": { "message", "type", "param", "code" } }`. Statuses include 400 (validation), 401 (authentication), 404 (profile), 413 (bounds), 415 (content type), 500 (server) and 502 (execution). SSE headers are delayed until worker initialization succeeds. After headers, Chat emits an error frame followed by `[DONE]`; Responses emits `response.failed`. Neither emits normal terminal success afterward. With the validated SDK versions, JavaScript `finalResponse()` returns the failed object; Python exposes `response.failed` while `get_final_response()` raises because no completed event arrived. Inspect failure events rather than treating partial text as success. Client errors never include subprocess stderr, provider diagnostics, credentials or prompts. Server diagnostics use safe operation/profile/error codes only.

## Local validation

No paid model calls are necessary. Contract/SDK/proxy tests use deterministic localhost fixtures:

```bash
npm run test:extensions
npm run build:web
PI_OPENAI_TEST_CLI=/absolute/path/to/pi/dist/cli.js \
PI_OPENAI_TEST_NONO=1 \
node --experimental-strip-types --test tests/openai-worker-integration.test.ts tests/openai-codex-worker.test.ts
```

The Codex worker test uses a deterministic localhost Codex mock, verifies native current/history files through an internal tool loop under Nono, and deliberately removes Poppler from PATH. The extraction-fallback integration test uses a temporary Pi root, tests default/named/Nono execution, verifies native image/text history, PDF/XLSX extraction, image payloads above 1 MiB, vision capability errors, credential separation, concurrent conversation isolation, internal tool turns, usage, cancellation and profile tool policy, rejects failed sandbox startup, runs isolated profile creation/resource commands and checks that no profile-local package trees or persistent transcripts are created. Without `PI_OPENAI_TEST_CLI` it is explicitly skipped. `PI_OPENAI_TEST_NONO=1` requires an already-installed Nono; it never installs it.

Compatibility was validated locally with Pi 1.5.2, JavaScript `openai` 7.15.0 and Python `openai` 2.48.0: discovery, both JSON protocols, both SSE protocols, JavaScript `finalResponse()`, Python `get_final_response()` and image/file request serialization. Attachment tests additionally exercise real PDF/Office extraction, limits and SSRF protections without external network requests. SDKs are optional test-only dependencies; unavailable SDK checks are reported without automatic installation. Proxy tests exercise the same streaming gateway used by the Next route, including downstream body cancellation; external proxy/network buffering requires deployment-specific verification.

Live Codex validation is explicitly opt-in and consumes the existing Codex subscription's quota. It is skipped by ordinary test runs and never uses a standalone OpenAI API key:

```bash
PI_CODEX_LIVE_TESTS=1 \
PI_CODEX_SDK_ENTRY=/absolute/path/to/pi/dist/index.js \
node --experimental-strip-types --test tests/openai-codex-live.test.ts
```

Run this from a repository checkout with local Codex credentials and the supported Pi SDK. `PI_CODEX_LIVE_MODEL` can select an existing Codex model for the validation without mutating profile settings. Only synthetic files are sent; agent tools are disabled and Poppler is deliberately unavailable during the test. Do not treat a mocked transport test alone as evidence of real backend file support.
