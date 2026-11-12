import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRequest } from "../extensions/api-server/openai-contract.ts";
import { prepareAttachments, extractPreparedDocuments } from "../extensions/api-server/openai-attachments.ts";
import { CODEX_FILE_API, CodexFileBindings, hasNativePdfInput, installCodexFileBridge } from "../extensions/api-server/openai-codex-files.ts";
import { dataUrl, pdfFixture, visualPdfFixture } from "./fixtures/openai-attachments.ts";

const signal = () => new AbortController().signal;
async function nativeRequest() {
  return prepareAttachments(normalizeRequest({ model: "support", input: [
    { role: "user", content: [{ type: "input_text", text: "Earlier file" }, { type: "input_file", filename: "earlier.pdf", file_data: dataUrl("application/pdf", pdfFixture()), detail: "high" }] },
    { role: "assistant", content: "Earlier response" },
    { role: "user", content: [{ type: "input_text", text: "Compare files" }, { type: "input_file", filename: "visual.pdf", file_data: dataUrl("application/pdf", visualPdfFixture()) }] },
  ] }, "responses"), signal(), { documents: "defer" });
}

test("Codex documents retain original bytes without extracting text, including image-only PDFs", async () => {
  const request = await nativeRequest();
  assert.equal(request.messages[0].documents?.[0].data, pdfFixture().toString("base64"));
  assert.equal(request.messages[2].documents?.[0].data, visualPdfFixture().toString("base64"));
  assert.ok(!JSON.stringify(request.messages.map((message) => message.content)).includes("Fixture PDF invoice"));
  assert.ok(hasNativePdfInput(request));
  assert.equal(request.messages[0].documents?.[0].detail, "high");
  const plain = normalizeRequest({ model: "support", input: "Hello" }, "responses");
  assert.equal(hasNativePdfInput(plain), false);
});

test("payload bridge preserves profile instructions/tools and replaces history/current markers with native file parts", async () => {
  const request = await nativeRequest();
  const bindings = new CodexFileBindings(request);
  const input = request.messages.map((message) => ({ role: message.role, content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content }] }));
  const payload = { model: "profile-model", instructions: "Keep profile policy", tools: [{ type: "function", name: "read", parameters: {} }], store: false, stream: true, input };
  const original = structuredClone(payload);
  const result = bindings.inject(payload, { api: CODEX_FILE_API }) as any;
  assert.deepEqual(payload, original); assert.equal(result.model, payload.model); assert.equal(result.instructions, payload.instructions); assert.deepEqual(result.tools, payload.tools);
  const files = result.input.flatMap((item: any) => item.content.filter((part: any) => part.type === "input_file"));
  assert.equal(files.length, 2); assert.equal(files[0].filename, "earlier.pdf"); assert.equal(files[0].detail, "high");
  assert.equal(files[0].file_data, dataUrl("application/pdf", pdfFixture()));
  assert.equal(files[1].file_data, dataUrl("application/pdf", visualPdfFixture()));
  assert.ok(!JSON.stringify(result).includes("[[pi-file:"));
  bindings.assertDelivered();
  assert.deepEqual(bindings.inject(payload, { api: CODEX_FILE_API }), result);
  assert.deepEqual(bindings.inject(result, { api: CODEX_FILE_API }), result);
});

test("summary subsets and tool-loop replay preserve native documents without exposing them to other providers", async () => {
  const request = await nativeRequest(), bindings = new CodexFileBindings(request);
  const summary = { input: [{ role: "user", content: [{ type: "input_text", text: `<conversation>${request.messages[0].content}</conversation>Summarize.` }] }] };
  const summarized = bindings.inject(summary, { api: CODEX_FILE_API }, false) as any;
  assert.equal(summarized.input[0].content[1].type, "input_file");
  const current = { input: [{ role: "user", content: [{ type: "input_text", text: request.messages[2].content }] }] };
  bindings.inject(current, { api: CODEX_FILE_API }); bindings.assertDelivered();
  const continuation = { input: [{ role: "user", content: [{ type: "input_text", text: "Compacted conversation" }] }, { type: "function_call_output", call_id: "read_1", output: "Tool result" }] };
  assert.deepEqual(bindings.inject(continuation, { api: CODEX_FILE_API }), continuation);
  assert.throws(() => bindings.inject(current, { api: "openai-responses" }), (error: any) => error.code === "native_file_provider_mismatch");
});

test("missing or misrouted native file context fails rather than sending placeholder-only prompts", async () => {
  const request = await nativeRequest();
  for (const payload of [null, { messages: [] }, { input: [] }, { input: [{ role: "developer", content: [{ type: "input_text", text: request.messages[0].content + request.messages[2].content }] }] }]) {
    const bindings = new CodexFileBindings(request);
    assert.throws(() => bindings.inject(payload, { api: CODEX_FILE_API }), (error: any) => error.code === "native_file_context_missing");
    assert.throws(() => bindings.assertDelivered());
  }
});

test("stream wrapper exposes native files to profile payload hooks, supports compaction and restores itself on disposal", async () => {
  const request = await nativeRequest();
  const seen: any[] = [];
  const original = async (model: any, _context: any, options: any) => {
    const payload = await options.onPayload({ input: [{ role: "user", content: [{ type: "input_text", text: request.messages.map((message) => message.content).join("\n") }] }] }, model);
    seen.push(payload); return "original-result";
  };
  const session = { sessionId: "request-session", agent: { streamFunction: original } };
  const bridge = installCodexFileBridge(session as any, request, signal());
  const wrapped = session.agent.streamFunction;
  const result = await wrapped({ api: CODEX_FILE_API }, {}, { sessionId: "request-session", onPayload: (body: any) => { assert.equal(body.input[0].content.filter((part: any) => part.type === "input_file").length, 2); return { ...body, instructions: "Extension policy", tools: [{ name: "profile-tool" }] }; } });
  assert.equal(result, "original-result"); assert.equal(seen[0].instructions, "Extension policy"); assert.deepEqual(seen[0].tools, [{ name: "profile-tool" }]);
  assert.equal(seen[0].input[0].content.filter((part: any) => part.type === "input_file").length, 2);
  await wrapped({ api: CODEX_FILE_API }, {}, { sessionId: "compaction-session" });
  bridge.assertDelivered(); assert.equal(bridge.failure(), undefined);
  bridge.dispose(); assert.equal(session.agent.streamFunction, original);
});

test("file-filtering policy hooks cannot be bypassed by reattaching raw documents afterward", async () => {
  const request = await nativeRequest(); let sent = false;
  const original = async (model: any, _context: any, options: any) => {
    await options.onPayload({ input: [{ role: "user", content: [{ type: "input_text", text: request.messages.map((message) => message.content).join("\n") }] }] }, model);
    sent = true;
  };
  const session = { sessionId: "request-session", agent: { streamFunction: original } };
  const bridge = installCodexFileBridge(session as any, request, signal());
  await assert.rejects(session.agent.streamFunction({ api: CODEX_FILE_API }, {}, { sessionId: "request-session", onPayload: (body: any) => {
    body.input[0].content = body.input[0].content.filter((part: any) => part.type !== "input_file");
    return body;
  } }), (error: any) => error.code === "native_file_context_missing");
  assert.equal(sent, false); assert.equal(bridge.failure()?.code, "native_file_context_missing");
  assert.throws(() => bridge.assertDelivered()); bridge.dispose();
});

test("fallback extraction still works for non-Codex profiles and validates file detail", async () => {
  const normalized = normalizeRequest({ model: "support", input: [{ role: "user", content: [{ type: "input_file", filename: "notes.txt", file_data: Buffer.from("Fallback fixture text").toString("base64") }] }] }, "responses");
  const deferred = await prepareAttachments(normalized, signal(), { documents: "defer" });
  const extracted = await extractPreparedDocuments(deferred, signal());
  assert.match(extracted.messages[0].content, /Fallback fixture text/); assert.ok(!extracted.messages[0].content.includes("[[pi-file:")); assert.equal(extracted.messages[0].documents, undefined);
  assert.throws(() => normalizeRequest({ model: "support", input: [{ role: "user", content: [{ type: "input_file", filename: "notes.txt", file_data: "YQ==", detail: "invalid" }] }] }, "responses"));
});
