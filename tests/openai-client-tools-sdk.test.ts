import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const cli = process.env.PI_OPENAI_TEST_CLI;
for (const mode of ["parallel", "sequential"] as const) test(`SDK client tool promises preserve internal execution in ${mode} batches`, { skip: !cli, timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-client-tool-sdk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0, sideEffects = 0, providerError: unknown;
  const provider = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests++;
      const toolResults = body.messages.filter((m: any) => m.role === "tool");
      const toolCalls = ["internal_once", "client__view_file", "client__view_file"].map((name, index) => ({ index, id: `call_${index}`, type: "function", function: { name, arguments: JSON.stringify(name === "internal_once" ? {} : { file_id: `file_${index}` }) } }));
      if (requests === 2) { assert.equal(toolResults.length, 3); assert.ok(JSON.stringify(toolResults).includes("Document token 1"), JSON.stringify(toolResults)); assert.ok(JSON.stringify(toolResults).includes("Document token 2")); }
      assert.ok(requests <= 2);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      frame({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: requests === 1 ? { role: "assistant", tool_calls: toolCalls } : { role: "assistant", content: "Client text received" }, finish_reason: null }] });
      frame({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: requests === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
      res.end("data: [DONE]\n\n");
    } catch (error) { providerError = error; res.writeHead(500); res.end(); }
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => provider.close(() => resolve())));
  const port = (provider.address() as { port: number }).port;
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", apiKey: "fixture", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] } } }));
  const host = await import(pathToFileURL(join(dirname(cli!), "index.js")).href);
  const settingsManager = host.SettingsManager.inMemory({ defaultProvider: "fixture", defaultModel: "fixture", compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await host.ModelRuntime.create({ modelsPath: join(root, "models.json"), authPath: join(root, "auth.json"), allowModelNetwork: false });
  const pending: Array<{ params: any; resolve: (value: any) => void }> = [];
  let notify: (() => void) | undefined;
  const resourceLoader = new host.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true });
  await resourceLoader.reload();
  const { session } = await host.createAgentSession({ cwd: root, agentDir: root, resourceLoader, settingsManager, modelRuntime, sessionManager: host.SessionManager.inMemory(root), tools: ["internal_once", "client__view_file"], customTools: [
    { name: "internal_once", label: "Internal", description: "Internal side effect", parameters: { type: "object", properties: {} }, execute: async () => { sideEffects++; return { content: [{ type: "text", text: "Private internal result" }], details: {} }; } },
    { name: "client__view_file", label: "Client file", description: "Client document reader", parameters: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] }, ...(mode === "sequential" ? { executionMode: "sequential" } : {}), execute: (_id: string, params: any) => new Promise((resolve) => { pending.push({ params, resolve }); notify?.(); }) },
  ] });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "rpc", onError: (e: unknown) => { throw e; } });
  session.setActiveToolsByName(["internal_once", "client__view_file"]);
  const run = session.prompt("Read two client files after the internal action", { expandPromptTemplates: false });
  void run.catch(() => {});
  for (let index = 0; index < 2; index++) {
    while (pending.length === 0) await Promise.race([new Promise<void>((resolve) => { notify = resolve; }), run.then(() => { throw providerError ?? new Error(`Run ended without delegation: ${JSON.stringify(session.messages.map((m: any) => ({ role: m.role, content: m.content, errorMessage: m.errorMessage })))}`); })]);
    const call = pending.shift()!; notify = undefined;
    assert.equal(requests, 1); assert.equal(sideEffects, 1);
    call.resolve({ content: [{ type: "text", text: `Document token ${index + 1}` }], details: {} });
  }
  await run; await session.waitForIdle();
  if (providerError) throw providerError;
  assert.equal(sideEffects, 1); assert.equal(requests, 2);
  assert.equal(session.getLastAssistantText(), "Client text received");
  assert.equal(session.getSessionStats().tokens.input, 20);
});
