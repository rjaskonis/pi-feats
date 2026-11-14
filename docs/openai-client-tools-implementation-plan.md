# OpenAI Client Tools: Additive Implementation Plan

## Status and scope

Implemented locally with the default-off policy described below. This document preserves the design and acceptance criteria; deployment and production activation have not been performed or authorized.

Goal: allow an unchanged Open WebUI to use its own file-reading tools with Pi's Responses API, while preserving existing profile behavior, internal tools, authentication, sandboxing, image input, document input, and ordinary stateless requests.

The integration is generic OpenAI-compatible client function calling. It must not require Open WebUI-specific headers, a fork of Open WebUI, a callback URL, or Open WebUI credentials on the Pi server.

## Verified starting point

- `openai-contract.ts` intentionally ignores client tool declarations, rejects tool-call/result history, and requires a final user message.
- `openai-execution.ts` executes an isolated profile SDK session through its existing launcher. It waits for completion, requires assistant text, and disposes the session.
- `openai-routes.ts` frames text-only output. It does not expose internal Pi tool calls.
- The worker currently consumes one JSON request through stdin EOF and exits after one execution.
- Open WebUI's native file workflow can offer `view_file` and `query_chat_files`, execute requested calls itself, and return `function_call_output` items.
- Open WebUI can return tool output as content-part arrays rather than just strings. Those arrays can contain text and images.
- Its default Responses continuation path sends explicit history. Generic stateful Responses is optional and is not supported by the existing Pi API.
- In Pi 1.5.2, tool-call validation and before-tool hooks happen before a tool's `execute` handler. `tool_execution_start` happens earlier and is not an authorization boundary.
- In parallel tool batches, result messages are appended after all executions complete. A pending external call can therefore delay the recording of an already completed internal tool result and its usage.

The session that motivated this work reported successful Docling conversion and stored extracted text. The missing capability is delegation to the client's file tools, not another upload or extraction endpoint.

## Non-regression contract

1. The feature is disabled by default and enabled explicitly per profile.
2. Disabled profiles use the existing parser, executor, EOF worker protocol, and response framing. Client `tools` remain ignored there, including existing compatibility behavior for unused options.
3. Enabled profiles without an applicable client-tool request also use the existing path. They must not allocate a continuation worker unnecessarily.
4. The first delivery supports Responses only. Chat Completions retains its current behavior; its tool-calling extension is a separate change.
5. Model/provider selection, credentials, generation settings, instructions, Guardrails, existing tool activation, Skills, and Nono remain profile-owned.
6. Existing direct Codex image/native-document handling and other-provider document extraction remain intact.
7. No internal tool calls, results, private instructions, or worker snapshots are exposed as client-owned calls.
8. No client-supplied code, command, or callback URL is executed by the Pi server. The external tool handler only delegates through the response protocol and receives a result.
9. Client tool choice and token/generation controls do not gain authority over the profile's internal execution.
10. Ordinary requests remain stateless. Only an authorized, outstanding client-tool exchange may retain bounded, temporary execution state.

## Profile policy

Introduce a profile-scoped policy; the exact schema must be checked against existing profile settings validation before implementation. Proposed shape:

```json
{
  "profile": {
    "clientTools": {
      "enabled": false,
      "allowedTools": ["view_file"]
    }
  }
}
```

Requirements:

- Enabling the feature is explicit; installing an update must not activate it for existing profiles.
- Tool names require explicit approval. Do not enable every tool offered by a client automatically.
- Unapproved tool declarations do not become active tools or model instructions.
- Accepted declarations are request-scoped and do not modify persistent active-tool lists.
- A client tool must never shadow an internal tool. Reserve a private registry namespace and reject ambiguous collisions.
- Preserve profile hooks and approval checks before exposing an executable client call.
- Treat client results as untrusted tool content, not system instructions or evidence that an internal tool executed.
- Policy revocation must prevent resuming an outstanding delegation under obsolete permissions.

For the initial Docling/Slim deployment, approve `view_file` first. Query/retrieval tools can require working embeddings and vector storage, which the motivating session did not have. Delegated file reading must not accidentally reintroduce that dependency. Approve query tools separately only after validating their existing Open WebUI prerequisites.

No new packages, extensions, npm trees, or node_modules directories may be created under named profiles.

## Architecture

### Keep the legacy execution strategy

Retain the existing single-request strategy as the default. Add a separate client-tool execution strategy selected only after profile policy and the request have been validated.

Policy resolution must precede interpreting tool declarations. In particular, introducing the feature must not make previously ignored malformed `tools` values fail for disabled profiles.

Validate the profile identifier before using it for policy lookup or filesystem paths.

### Add an authorized client-tool bridge

Create temporary SDK tool definitions for approved client functions, alongside—not instead of—the profile's internal tools.

The external handler waits for the client's result instead of executing a local implementation. It must not inject a fake result, throw a synthetic tool error to force a yield, or abort and restart the agent as a normal continuation mechanism.

Only calls that reach the approved execution boundary may be exposed to the client. Buffer model argument fragments if necessary: do not tell Open WebUI to execute a call that the SDK subsequently rejects because of invalid arguments, truncation, or a profile hook.

### Retain a bounded continuation worker

Preferred approach: keep the same isolated worker and in-memory SDK session alive while an approved client call is outstanding. Resume its waiting tool handler when the result arrives.

Use a separate framed stdin/control protocol for this strategy. Do not replace the legacy EOF protocol for ordinary requests. Reuse the existing SDK bootstrap and profile/Nono launcher instead of duplicating SDK resolution logic.

Associate opaque public call IDs with the private worker, native SDK call IDs, profile, canonical approved tool definition, and pending state. The wire client must not receive a private session snapshot.

The client can continue using standard function-call IDs and explicit history. No custom continuation header is required. Incoming results must match an issued, outstanding call in the authenticated profile scope.

Preserve the worker's private history, native document bindings, images, completed internal results, pending internal executions, and usage accounting. Do not reconstruct execution from only the public transcript and risk repeating internal side effects.

When the exchange finishes, dispose the session and worker as today. This is not permanent conversation storage or a general session-reuse feature.

### Separate HTTP completion from agent completion

A Responses response containing completed function-call arguments is a valid completed protocol leg even though the agent is waiting for client execution. It is not a failed response and does not require assistant text.

Finishing that HTTP response must not trigger the ordinary disconnect cleanup that would kill the waiting worker. Conversely, an abandoned or failed response before successful handoff must not leave an orphan worker.

A later HTTP request attaches a new output sink to the same outstanding execution after authorization and result validation. Requests without a valid outstanding continuation must never attach to a worker based only on the profile name.

Handle sequential and parallel SDK execution without forcing a different internal execution order. Expose only calls that are actually approved and pending. Never wait for every potential call in a sequential batch to start before handing off the first one.

### Bound lifetime and resource usage

Define and validate:

- Global and per-profile outstanding-worker limits.
- Outstanding-call lifetime and inactivity timeout.
- Maximum delegation rounds and calls per agent turn.
- Tool/schema/argument/result sizes and schema nesting depth.
- Existing aggregate request, image, document, and context limits.
- Per-worker output buffering and backpressure limits.

Select conservative defaults after measuring the proof of concept. Do not increase existing global attachment/body limits as part of this feature.

On expiry, disconnect, cancellation, shutdown, or policy revocation: abort pending handlers, stop the agent, terminate the process group if necessary, and remove registry entries. Do not silently rerun execution after lost state or a server restart.

Unknown, expired, cross-profile, conflicting, or already consumed results must produce explicit safe errors. Reject conflicting concurrent resumes. Never execute a tool result twice.

## Protocol work

### Input

For authorized Responses requests, add explicit types and validation for:

- Function tool declarations and JSON Schema parameters.
- Assistant `function_call` history items.
- `function_call_output` items correlated by `call_id`.
- String results and supported text/image content-part arrays.
- A final tool result as a valid continuation, without requiring a fabricated user message.

Validate schemas without network resolution or executable client code. Reject unsupported external schema references.

Represent a client's tool-execution failure as a failed tool result for the agent, not automatically as an HTTP/API execution failure. Invalid transport payloads remain explicit validation errors.

Validate image results under the same profile image policy and decoding/size controls as current user images. Account for them in Codex request-local visual capability handling as well.

Separate harmless Open WebUI display metadata from model content. Accept only explicitly understood fields; do not forward UI metadata or URLs as executable server instructions.

Distinguish historical completed calls from the current outstanding results. Do not resume an old execution merely because its call appears in replayed history. Verify exact replay and retry behavior against Open WebUI fixtures during the proof of concept.

The current rejection of generic `previous_response_id`/stored conversations remains in place for this delivery. Validate the default explicit-history Open WebUI path. Do not claim that a partial continuation registry implements full stateful Responses.

### Output and streaming

Add a client-tool outcome distinct from final assistant text. Represent function-call output items with stable item IDs, call IDs, function names, and valid JSON argument strings.

Support the required standard Responses events, including:

- `response.output_item.added` and `.done`.
- `response.function_call_arguments.delta` and `.done`.
- Text events when narration or a final answer is present.
- `response.completed` for a successful protocol leg.
- `response.failed` for actual execution/protocol failures.

Use consistent output indexes, IDs, ordering, usage, and semantic output between JSON and SSE. Do not require an empty assistant message for function-only output. Keep existing legacy text framing unchanged.

Only accepted client definitions appear as client tools. Internal Pi tools remain private. Report usage deltas across continuation legs so their sum matches the authoritative SDK ledger without counting restored history or earlier legs again. Explicitly handle delayed internal-tool usage recording in mixed batches.

## Implementation stages

### 0. Freeze baseline and prove SDK continuation

- Save regression expectations for existing JSON/SSE text, images, native files, fallback extraction, usage, profile policy, and cancellation.
- Build sanitized fixtures from the local Open WebUI conversion and continuation code; no live server modification is needed.
- Prove one delegated `view_file` call using the installed SDK, a local mock provider, an in-memory session, and a waiting tool handler.
- Prove both sequential and mixed parallel batches, policy-denied calls, truncated arguments, disconnect handling, and usage settlement.
- Measure waiting-worker memory and cleanup behavior.
- Confirm how approved tool definitions are activated and updated without changing persistent profile settings or existing internal tool activation.
- Confirm the precise Open WebUI follow-up payload, including tool-set changes and structured results.

Gate: do not proceed with the full feature if continuation requires SDK internals monkey-patching, fake results, bypassing profile hooks, or replaying completed internal side effects. Report the limitation and redesign first.

### 1. Add policy and isolated contracts

- Add profile policy parsing, validation, and documentation with a default-off setting.
- Add separate client-tool protocol types and validators.
- Keep policy-disabled normalization behavior unchanged.
- Add unit tests for schemas, names, history, result correlation, and all limits.

### 2. Add worker/control bridge and continuation registry

- Add the separate worker control mode through the existing launcher.
- Implement temporary authorized tools and private call-ID mappings.
- Implement ownership checks, timeouts, resource caps, concurrent-resume protection, and deterministic cleanup.
- Keep ordinary requests on the existing executor.

### 3. Add Responses JSON/SSE framing

- Add authorized call-only, text-plus-call, and final-answer outcomes.
- Separate HTTP handoff success from agent/session completion.
- Implement usage deltas and failure framing.
- Do not expand Chat Completions behavior in this stage.

### 4. End-to-end validation and documentation

- Simulate Open WebUI: declare file tools, receive a function call, execute it in the test client, return extracted text, and verify the final answer.
- Test multiple documents and multiple tool rounds.
- Run the supported official JavaScript and Python OpenAI SDK compatibility tests.
- Run isolated default/named/Nono profile tests, type-checking, and Console build validation where affected.
- Verify clean profile settings, shared-runtime ownership, no package trees under profiles, no persistent transcripts, and no unbounded retained workers.
- Record activation, limits, continuation expiry, unsupported generic stateful Responses, and rollback instructions.

### 5. Explicit activation and deployment

Only after implementation is validated and deployment is separately authorized:

- Update the package through the supported distribution path.
- Enable client tools only for the target profile and approve `view_file` initially. Do not enable query/retrieval tools until their separate storage and embedding prerequisites are confirmed.
- Validate the unchanged Open WebUI with one small synthetic document.
- Verify text/image/native-file regressions and resource cleanup.
- Roll back activation by disabling the profile policy; cancel its pending exchanges. No Open WebUI fork or configuration workaround is required for the default supported flow.

## Required acceptance tests

- Feature disabled: all existing behavior and tests remain valid; offered client tools still have no effect.
- Enabled with no applicable client tools: legacy execution and no continuation allocation.
- Other profiles and simultaneous conversations remain isolated.
- Internal tools still execute normally and cannot be shadowed or impersonated.
- An internal side-effect fixture executes exactly once across a client-tool continuation.
- One and multiple external calls work under both SDK execution orders without deadlock.
- Invalid, denied, or truncated calls never become executable client requests.
- Function-only Responses work without fake assistant text.
- Tool results work as strings and structured text/image arrays; image blocking still applies.
- Client tool failures reach the agent as errors without claiming a successful file read; malformed results cannot resume execution.
- The `view_file` flow works with Docling-extracted text and bypass enabled, without introducing embeddings or vector storage requirements.
- Model/provider selection, persistent settings, credentials, and existing tool activation are unchanged.
- Direct Codex/native files, stale image metadata handling, and extraction fallback regressions remain green.
- Unknown/expired/wrong-profile/duplicate/conflicting results fail safely and do not start replacement executions.
- Abort, expiry, failed handoff, shutdown, and policy revocation leave no orphan worker or pending promise.
- Usage across completed legs matches the SDK ledger, including mixed internal tool usage.
- Client schemas and results never become local executable code or replace profile instructions.

## Local implementation verification

- Public SDK waiting-tool handlers work in sequential and parallel batches without SDK internals patches, fake results, or restarting the agent.
- Full isolated regression run: 204 tests, 203 passed, one opt-in real-provider test intentionally skipped, no failures or cancellations. The run used Pi 1.5.2, Nono, and serial test-file execution to avoid unrelated worker startup contention.
- Real SDK/worker tests cover parallel/sequential delegated file reading, preservation of an internal filesystem action exactly once, completed-history replay into a fresh request, image results through ordinary OpenAI-compatible and Codex transports, stale Codex image metadata, profile-denied calls, truncated arguments, tool-name conflicts, and failed client results.
- Official JavaScript and Python OpenAI SDKs validate JSON and streaming function-call accumulation and continuation against a local deterministic worker. No paid model request or production Open WebUI/Docling request was made.
- Contract/runtime tests cover default-off and inapplicable legacy behavior, unknown/conflicting/cross-profile results, context/schema changes, concurrent resumes, capacity, expiry, policy revocation, failed handoff, and cancellation during asynchronous policy lookup.
- The existing isolated profile create/skills/extensions/packages checks pass, with no named-profile package trees or persistent transcripts.
- Targeted strict type-checking of the compatibility modules and profile store passes. Console build passes. A broader server type-check still reports the same 15 pre-existing diagnostics as HEAD (Applications, Pulse, context memory, and unrelated server handlers); those unrelated modules were not modified to mask the baseline errors.
- Waiting-worker caps are conservative defaults, not a production capacity benchmark. Native client-tool selection by a live provider and the deployed Open WebUI remain post-deployment smoke tests requiring separate authorization.
- Implementation modules: `openai-client-contract.ts`, `openai-client-runtime.ts`, `openai-client-worker.ts`, and `openai-client-routes.ts`, integrated through the existing API worker bootstrap and profile launcher.
- Pending execution accepts a fixed approved function-definition set. Generic stateful Responses and dynamic replacement of that set remain outside this delivery.

## Out of scope for the first delivery

- Changes or patches to Open WebUI or Docling.
- Pi-side retrieval from authenticated Open WebUI file URLs.
- A new Files API, vector database, or embeddings service.
- Permanent server-managed conversation history or generic Responses retrieval.
- Chat Completions client-tool support.
- Hosted provider tools, arbitrary client code execution, or provider/model changes.
- Modifying remote services, installing software, or enabling the feature automatically.
