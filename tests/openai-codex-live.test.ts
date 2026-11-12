import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { profileEnvironment } from "../extensions/lib/profile-env.ts";
import { registerCompatibilityRoutes } from "../extensions/api-server/openai-routes.ts";
import { prepareAttachments } from "../extensions/api-server/openai-attachments.ts";
import { executeSession, restoreHistory } from "../extensions/api-server/openai-execution.ts";
import { CODEX_FILE_API, installCodexFileBridge } from "../extensions/api-server/openai-codex-files.ts";
import { dataUrl, pdfFixture, visualPdfFixture, xlsxFixture, docxFixture } from "./fixtures/openai-attachments.ts";

// Explicitly opt-in: uses the configured local Codex subscription and synthetic
// files only. Never uses a standalone API key, uploads stored files, or runs tools.
test("live Codex file inputs through the local compatibility endpoint", { skip: process.env.PI_CODEX_LIVE_TESTS !== "1", timeout: 240_000 }, async (t) => {
  const entry = process.env.PI_CODEX_SDK_ENTRY;
  assert.ok(entry, "Set PI_CODEX_SDK_ENTRY to the supported Pi SDK dist/index.js.");
  const host = await import(pathToFileURL(entry).href);
  const root = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  Object.assign(process.env, await profileEnvironment(root));
  const temp = await mkdtemp(join(tmpdir(), "pi-codex-live-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const runtime = await host.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), modelsStorePath: join(temp, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  t.after(() => runtime.settleCredentialWrites());
  const configured = host.SettingsManager.create("/tmp", root);
  const modelId = process.env.PI_CODEX_LIVE_MODEL ?? configured.getDefaultModel();
  const model = runtime.getModel("openai-codex", modelId);
  assert.ok(model && model.api === CODEX_FILE_API && new URL(model.baseUrl).hostname === "chatgpt.com", "Live validation must use the existing ChatGPT Codex provider, not api.openai.com.");

  const fixtures = [
    { filename: "fixture.pdf", mime: "application/pdf", bytes: pdfFixture("Verification token: PDF_NATIVE_84927"), question: "Read the verification token in the attached PDF and return the token only.", expected: "PDF_NATIVE_84927" },
    { filename: "fixture.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: xlsxFixture("XLSX_NATIVE_62814"), question: "In the Sales worksheet of the earlier attachment, find the row whose Item is Verification. Return its Value only.", expected: "XLSX_NATIVE_62814", history: true },
    { filename: "fixture.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: docxFixture(), question: "Read the verification token in the attached document and return the token only.", expected: "DOCX_NATIVE_59173" },
    { filename: "fixture.csv", mime: "text/csv", bytes: Buffer.from("item,verification\nrecord,CSV_NATIVE_36081\n"), question: "Read the verification value for the record row of the attached CSV. Return the value only.", expected: "CSV_NATIVE_36081" },
    { filename: "visual.pdf", mime: "application/pdf", bytes: visualPdfFixture(), question: "Count the red circles and blue squares in the attached PDF. Return only the two counts in this format: red_circles,blue_squares.", expected: "3,2", stream: true },
  ];
  let active: typeof fixtures[number], statuses: number[] = [], delivered = 0;
  const server = Fastify();
  t.after(() => server.close());
  registerCompatibilityRoutes(server, {
    authorized: (authorization) => authorization === "Bearer local-codex-test",
    profiles: async () => [{ name: "codex-validation" }], validateProfile: async () => {},
    execute: async (request, emit, signal) => {
      const prepared = await prepareAttachments(request, signal, { documents: "defer" });
      const manager = host.SessionManager.inMemory(temp); restoreHistory(manager, prepared);
      const settings = host.SettingsManager.inMemory({ defaultProvider: "openai-codex", defaultModel: model.id, defaultThinkingLevel: "off", retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off", transport: "sse" });
      const loader = new host.DefaultResourceLoader({ cwd: temp, agentDir: temp, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, systemPrompt: "Read only the provided synthetic attachment. Do not use tools. Follow the user's requested short answer format." });
      await loader.reload();
      const session = (await host.createAgentSession({ cwd: temp, agentDir: temp, model, modelRuntime: runtime, settingsManager: settings, sessionManager: manager, resourceLoader: loader, noTools: "all", thinkingLevel: "off" })).session;
      await session.bindExtensions({ mode: "rpc" });
      session.agent.transport = "sse";
      const sdkStream = session.agent.streamFunction;
      session.agent.streamFunction = (physical: any, context: any, options: any) => sdkStream(physical, context, {
        ...options,
        onPayload: async (payload: any, actualModel: any) => {
          const transformed = await options?.onPayload?.(payload, actualModel);
          const body = transformed === undefined ? payload : transformed;
          assert.equal(actualModel.api, CODEX_FILE_API); assert.equal(new URL(actualModel.baseUrl).hostname, "chatgpt.com");
          const files = body.input.flatMap((item: any) => Array.isArray(item.content) ? item.content.filter((part: any) => part.type === "input_file") : []);
          assert.equal(files.length, 1); assert.equal(files[0].file_data, dataUrl(active.mime, active.bytes));
          assert.equal(body.store, false); assert.equal(body.stream, true); assert.ok(!body.tools?.length);
          delivered += files.length;
          return body;
        },
        onResponse: async (response: any, actualModel: any) => { statuses.push(response.status); await options?.onResponse?.(response, actualModel); },
      });
      const bridge = installCodexFileBridge(session, prepared, signal);
      let pending = Promise.resolve();
      try {
        const result = await executeSession(session, prepared, (event) => { pending = pending.then(() => emit(event)); }, signal);
        await pending; bridge.assertDelivered(); return result;
      } finally { bridge.dispose(); }
    },
  });
  // A fallback PDF extractor would fail here: Poppler is deliberately not on
  // PATH. Raw input_file bytes are also asserted immediately before transport.
  const previousPath = process.env.PATH; process.env.PATH = "/nonexistent";
  try {
    for (const fixture of fixtures) {
      active = fixture; statuses = []; delivered = 0;
      const file = { type: "input_file", filename: fixture.filename, file_data: dataUrl(fixture.mime, fixture.bytes) };
      const input = fixture.history ? [{ role: "user", content: [{ type: "input_text", text: "Keep this attachment for the next question." }, file] }, { role: "assistant", content: "Ready." }, { role: "user", content: fixture.question }] : [{ role: "user", content: [{ type: "input_text", text: fixture.question }, file] }];
      const response = await server.inject({ method: "POST", url: "/v1/responses", headers: { authorization: "Bearer local-codex-test" }, payload: { model: "codex-validation", input, stream: fixture.stream ?? false } });
      assert.equal(response.statusCode, 200, "The local compatibility endpoint must accept the native attachment.");
      let result: any;
      if (fixture.stream) {
        const events = response.body.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));
        assert.equal(events.at(-1).type, "response.completed"); result = events.at(-1).response;
      } else result = response.json();
      assert.equal(result.status, "completed");
      const text = result.output.flatMap((item: any) => item.content ?? []).filter((part: any) => part.type === "output_text").map((part: any) => part.text).join("").trim();
      assert.equal(text, fixture.expected); assert.ok(delivered >= 1); assert.ok(statuses.includes(200));
      t.diagnostic(JSON.stringify({ model: model.id, api: model.api, endpointHost: "chatgpt.com", filename: fixture.filename, bytes: fixture.bytes.length, delivered, statuses, matched: true, text, usage: result.usage }));
    }
  } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
});
