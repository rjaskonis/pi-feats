# OpenAI-compatible profile API

The API Server exposes existing Pi profiles through text-only Chat Completions and Responses. This is independent of Applications, identity keys, handlers and session rollover.

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

The final conversational message must be a non-empty user message. Assistant-prefill, instruction-only and assistant-terminal histories are rejected, not repaired with a synthetic prompt. Typical SDK `messages`/string `input` requests and explicit prior output followed by a user message are supported.

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

## Supported input and limits

- Chat `messages`: `system`, `developer`, `user`, `assistant`, with string content or `text` parts.
- Responses `input`: a string or message list. Text parts use `input_text`; previous assistant output messages can use `output_text` with empty annotations/logprobs. Item IDs and status are caller-owned transport metadata, never server lookup keys.
- `stream` is boolean; `store` must be omitted, null or false. Chat `n` must be omitted, null or 1. Only plain-text `response_format` / `text.format` is supported.
- Responses supports top-level string `instructions`. Background execution must be omitted, null or false. Non-null `previous_response_id` and `conversation` are rejected.
- `metadata`: at most 16 string entries, keys up to 64 characters, values up to 512 characters. Responses echoes it; Chat accepts it without storage or identity routing.
- `user` and `safety_identifier`: optional strings accepted as non-operational metadata, not stored or used for moderation, policy enforcement or Application identity routing.
- At most 100 messages and 100,000 total text characters, including instructions; HTTP JSON bodies are limited to 1 MiB, including at the Console proxy.
- Visible output is bounded to 16 MiB. Worker frame, transport and writable backlog limits prevent unlimited pending output. Initialization has a 60-second deadline and each blocked SSE drain has a 30-second deadline. A caller disconnect cancels the agent and request-owned worker process group; force termination follows a one-second grace period when needed.

Unknown parameters and semantic requests outside this scope are rejected explicitly, including generation controls (`temperature`, `top_p`, token limits, reasoning settings, stop sequences), structured output guarantees, log probabilities, multiple choices, client-defined tools, tool-result inputs, hosted OpenAI tools, image/audio/video/files, response storage and retrieval, background work and WebSocket transport. Profile-owned internal tools remain available; their calls and results are not exposed as client-owned function calls.

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
node --experimental-strip-types --test tests/openai-worker-integration.test.ts
```

The integration test uses a temporary Pi root, tests default/named/Nono execution, verifies native history, credential separation, concurrent conversation isolation, internal tool turns, usage, cancellation and profile tool policy, rejects failed sandbox startup, runs isolated profile creation/resource commands and checks that no profile-local package trees or persistent transcripts are created. Without `PI_OPENAI_TEST_CLI` it is explicitly skipped. `PI_OPENAI_TEST_NONO=1` requires an already-installed Nono; it never installs it.

Compatibility was validated locally with Pi 1.5.2, JavaScript `openai` 7.15.0 and Python `openai` 2.48.0: discovery, both JSON protocols, both SSE protocols, JavaScript `finalResponse()` and Python `get_final_response()`. SDKs are optional test-only dependencies; unavailable SDK checks are reported without automatic installation. Proxy tests exercise the same streaming gateway used by the Next route, including downstream body cancellation; external proxy/network buffering requires deployment-specific verification.
