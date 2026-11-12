# Native document input through the Codex provider

## Finding

Native inline file input **works through the ChatGPT Codex backend used by Pi**. It is not necessary to call the standalone OpenAI API or locally extract document text for Codex-backed profiles.

This conclusion is based on live requests, not just SDK types, documentation or a mock server. The implementation uses Pi's existing `openai-codex-responses` adapter, existing Codex credentials and its normal `https://chatgpt.com/backend-api/codex/responses` route. No standalone API key, file-upload service, hosted Code Interpreter or File Search was used.

## Why the SDK inspection alone was insufficient

Pi 1.5.2's native base message content can represent text and images, not generic files. The examined official Codex client's `ContentItem` and `UserInput` enums also lacked an `input_file` variant. Those are client-side serialization boundaries; they do **not** prove rejection by the backend.

The supported SDK `onPayload` boundary can carry a normal Responses `input_file` content item after native transcript conversion. `openai-codex-files.ts` integrates that boundary into the existing agent stream rather than replacing the agent with a second client/runtime. Existing profile instructions, tools, authentication, lifecycle and accounting remain in place. Existing payload-policy hooks see the native file parts before transmission. If they remove required files, the bridge fails instead of adding the originals back after the policy hook.

The SDK stream wrapper also covers compaction/summarization calls. File bindings are request-local; their internal text markers are replaced with file parts before transport. A missing binding or incompatible provider fails closed. A native failure is not silently rerouted to `api.openai.com` or a local extraction fallback.

## Live end-to-end results

Validated through the local Pi-compatible `POST /v1/responses` endpoint, then the existing Codex provider:

- Host SDK: Pi **1.5.2**.
- Configured Codex model: **`gpt-6.1-sol`**.
- Provider API: **`openai-codex-responses`**.
- Provider endpoint host: **`chatgpt.com`**.
- Agent tools: disabled for live validation, so no local document-reading tool could supply the answers.
- Poppler: deliberately unavailable on PATH during the live test.
- File bytes: asserted byte-identical in the final provider payload.
- All fixtures: synthetic, with no user documents or authentication data embedded.

| Fixture | Original bytes | HTTP | Expected file-only answer | Actual answer | Input/output tokens |
| --- | ---: | ---: | --- | --- | ---: |
| PDF with text | 611 | 200 | `PDF_NATIVE_84927` | `PDF_NATIVE_84927` | 94 / 9 |
| XLSX via explicit earlier-message history | 1,640 | 200 | `XLSX_NATIVE_62814` | `XLSX_NATIVE_62814` | 158 / 11 |
| DOCX | 823 | 200 | `DOCX_NATIVE_59173` | `DOCX_NATIVE_59173` | 90 / 10 |
| CSV | 42 | 200 | `CSV_NATIVE_36081` | `CSV_NATIVE_36081` | 108 / 9 |
| Image-only PDF, streamed response | 1,240 | 200 | Three red circles, two blue squares: `3,2` | `3,2` | 443 / 7 |

The expected verification strings were present only in the files, not the questions. The visual PDF contained only a raster image, with no font/text layer to extract. The XLSX case verified that the file can be supplied in an earlier user message and referenced by the current question. Both ordinary JSON and Responses SSE terminal output were validated.

Earlier low-level SDK probes independently succeeded for PDF, XLSX, DOCX and CSV, and for the same image-only PDF. One initial end-to-end XLSX question asking for an exact cell coordinate returned a header instead of the requested numeric value. The semantic row/value test above passed. This is a fidelity limitation to keep visible: native spreadsheet ingestion and an LLM answer are not an exact Excel cell-access/calculation engine.

These are small, controlled capability checks, not a guarantee for every file type, workbook feature, PDF complexity, model, plan, context length or future backend version. Unsupported formats and native service failures remain errors. The existing byte/attachment limits still apply; native document contents are not subjected to the local text extractor's 100,000-character cap.

## Reproduce safely

Run from the repository checkout with existing local Codex credentials. This explicitly consumes Codex subscription quota. It does not modify a remote Pi/container or use a standalone OpenAI API key.

```bash
PI_CODEX_LIVE_TESTS=1 \
PI_CODEX_SDK_ENTRY=/absolute/path/to/pi/dist/index.js \
node --experimental-strip-types --test tests/openai-codex-live.test.ts
```

The test uses the configured default model under `openai-codex`; optionally set `PI_CODEX_LIVE_MODEL` to another existing Codex model. It refuses a standalone API hostname, creates only temporary in-memory test sessions, sends synthetic fixtures, and does not persist chat transcripts. Authentication remains managed by the existing SDK, including normal token refresh when required.

Ordinary regression runs skip this live test. Deterministic validation remains available without any real provider calls:

```bash
node --experimental-strip-types --test tests/openai-codex-files.test.ts
PI_OPENAI_TEST_CLI=/absolute/path/to/pi/dist/cli.js \
PI_OPENAI_TEST_NONO=1 \
node --experimental-strip-types --test tests/openai-codex-worker.test.ts
```

The isolated worker test checks actual SDK serialization and SSE parsing against a localhost Codex mock, including compressed requests, profile instructions/tools, native history, two model/tool turns, usage totals, no profile-local package trees and no persistent transcript. Its restricted PATH makes Poppler unavailable; it runs under the existing Nono launcher when requested.

## Scope and boundaries

- Both public protocols accept inline documents; the native path is selected by the configured Pi model API, not the caller's profile ID or a compatibility header.
- This change does not implement `/v1/files`, vector stores, File Search, server-side response storage or arbitrary cross-service `file_id` resolution. Open WebUI file IDs are not assumed to be Codex file IDs.
- Existing public-URL download safeguards and attachment byte limits remain in force. No credentials are forwarded to attachment hosts.
- Native PDFs include visual input, so the profile's image capability and block-images policy remain enforced.
- Profiles using non-Codex APIs retain the existing extraction fallback with its documented Python/Poppler prerequisites. No new standalone OpenAI route is created as a fallback.
- The Codex backend is the route used by the Codex client, not a promise that every public Responses/Files endpoint exists under it. The inline `input_file` capability was verified on the stated account/model/runtime combination.

## References examined

- [OpenAI file-input guide](https://developers.openai.com/api/docs/guides/file-inputs): distinguishes PDF visual processing, document text processing and spreadsheet augmentation.
- [Sign in with ChatGPT preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations): model-dependent text/image/file inputs; no general Files upload API on that documented flow. This document concerns another supported ChatGPT-plan routing configuration, not a reason to replace Pi's Codex endpoint with it.
- [Official Codex `ContentItem` source](https://github.com/openai/codex/blob/e61a08f9ecb93a29d5379b123bee047fff0c7a24/codex-rs/protocol/src/models.rs): the examined enum has no generic file variant.
- [Official Codex `UserInput` source](https://github.com/openai/codex/blob/e61a08f9ecb93a29d5379b123bee047fff0c7a24/codex-rs/protocol/src/user_input.rs): RPC/client input representation is distinct from backend acceptance.
- [Official Codex file-upload source](https://github.com/openai/codex/blob/e61a08f9ecb93a29d5379b123bee047fff0c7a24/codex-rs/codex-api/src/files.rs) and [Apps tool integration](https://github.com/openai/codex/blob/e61a08f9ecb93a29d5379b123bee047fff0c7a24/codex-rs/core/src/mcp_openai_file.rs): file upload for Apps tools is not, by itself, proof of a generic model file-input API. This implementation does not depend on that upload path.
- [Codex PDF-support issue #1797](https://github.com/openai/codex/issues/1797): a separate user report describes the same client-side enum boundary and a successful native-backend proof of concept. That report motivated investigation but was not substituted for our live tests.
