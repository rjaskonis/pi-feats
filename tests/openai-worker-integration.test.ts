import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { executeWorker } from "../extensions/api-server/openai-execution.ts";
import { normalizeRequest } from "../extensions/api-server/openai-contract.ts";

// Opt-in: this exercises the installed host runtime, never real credentials/providers.
const cli = process.env.PI_OPENAI_TEST_CLI;
test("dedicated worker restores history, profile resources, usage and isolation", { skip: !cli, timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-openai-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: any[] = [];
  const authorizations: Array<string | undefined> = [];
  let providerCancelled!: () => void;
  const cancelledProvider = new Promise<void>((resolve) => { providerCancelled = resolve; });
  const provider = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    calls.push(JSON.parse(body)); authorizations.push(req.headers.authorization);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (choices: unknown[], usage?: unknown) => res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "fixture", choices, ...(usage ? { usage } : {}) })}\n\n`);
    const wireMessages = JSON.stringify(calls.at(-1).messages);
    if (wireMessages.includes("Use internal tool") && !calls.at(-1).messages.some((message: any) => message.role === "tool")) {
      frame([{ index: 0, delta: { role: "assistant", content: "Reading", tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "SOUL.md" }) } }] }, finish_reason: null }]);
      frame([{ index: 0, delta: {}, finish_reason: "tool_calls" }], { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, prompt_tokens_details: { cached_tokens: 3 } });
      res.end("data: [DONE]\n\n"); return;
    }
    if (wireMessages.includes("Hold for cancellation")) {
      res.once("close", providerCancelled);
      frame([{ index: 0, delta: { role: "assistant", content: "Waiting" }, finish_reason: null }]);
      return;
    }
    frame([{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    frame([{ index: 0, delta: { content: " Ada" }, finish_reason: null }]);
    frame([{ index: 0, delta: {}, finish_reason: "stop" }], { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, prompt_tokens_details: { cached_tokens: 3 } });
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => provider.close(() => resolve())));
  const port = (provider.address() as { port: number }).port;
  const extensions = [resolve("extensions/profiles.ts"), resolve("extensions/api-server/index.ts"), resolve("extensions/guardrails/index.ts"), resolve("extensions/cli-resources.ts")];
  const settings = { extensions, defaultProvider: "fixture", defaultModel: "fixture", defaultThinkingLevel: "off", compaction: { enabled: false } };
  await writeFile(join(root, "settings.json"), JSON.stringify(settings));
  await writeFile(join(root, ".env"), "FIXTURE_API_KEY=fixture-default-token\n");
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "$FIXTURE_API_KEY", api: "openai-completions", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] } } }));
  const named = join(root, "profiles", "support");
  await mkdir(named, { recursive: true });
  await writeFile(join(named, "settings.json"), JSON.stringify({ ...settings, extensions: undefined, sandbox: false, profile: { enabledTools: ["read"] } }));
  await writeFile(join(named, ".env"), "FIXTURE_API_KEY=fixture-support-token\n");
  await writeFile(join(named, "SOUL.md"), "Profile fixture policy: preserve the blue umbrella.");
  const env = { PI_OFFLINE: "1", PATH: process.env.PATH, HOME: process.env.HOME, PI_CODING_AGENT_DIR: root, PI_PROFILE_ROOT: root, PI_OPENAI_WORKER: "1" };
  for (const profile of ["default", "support", ...(process.env.PI_OPENAI_TEST_NONO === "1" ? ["support"] : [])]) {
    if (profile === "support" && calls.length >= 2) {
      const config = JSON.parse(await readFile(join(named, "settings.json"), "utf8"));
      await writeFile(join(named, "settings.json"), JSON.stringify({ ...config, sandbox: true }));
    }
    const request = normalizeRequest({ model: profile, instructions: "Request fixture instructions", input: [{ role: "system", content: "Caller fixture policy" }, { role: "user", content: "My name is Ada" }, { role: "assistant", content: "Welcome Ada" }, { role: "user", content: "Hello" }] }, "responses");
    const events: any[] = [];
    const result = await executeWorker(process.execPath, [cli!, "--extension", extensions[0], "profile", profile, "--mode", "rpc", "--no-session"], { cwd: root, env }, request, async (event) => { events.push(event); }, new AbortController().signal);
    assert.equal(result.text, "Hello Ada");
    assert.equal(result.usage.input, 20); assert.equal(result.usage.output, 4); assert.equal(result.usage.cached, 3);
    assert.ok(events.filter((event) => event.type === "text").length >= 2);
    const call = calls.at(-1);
    assert.equal(call.model, "fixture");
    assert.equal(authorizations.at(-1), profile === "default" ? "Bearer fixture-default-token" : "Bearer fixture-support-token");
    assert.ok(call.messages.some((message: any) => message.role === "assistant" && message.content.includes("Welcome Ada")));
    const wire = JSON.stringify(call.messages);
    assert.ok(wire.includes("Caller fixture policy")); assert.ok(wire.includes("Request fixture instructions"));
    if (profile === "support") {
      assert.ok(wire.includes("blue umbrella"));
      assert.deepEqual(call.tools.map((tool: any) => tool.function.name), ["read"]);
    }
    else assert.ok(call.tools.some((tool: any) => tool.function.name === "read"));
  }
  const run = (request: ReturnType<typeof normalizeRequest>, emit: (event: any) => Promise<void>, signal = new AbortController().signal) => executeWorker(process.execPath, [cli!, "--extension", extensions[0], "profile", request.profile, "--mode", "rpc", "--no-session"], { cwd: request.profile === "default" ? root : named, env }, request, emit, signal);
  const toolEvents: any[] = [];
  const toolResult = await run(normalizeRequest({ model: "support", input: "Use internal tool" }, "responses"), async (event) => { toolEvents.push(event); });
  assert.equal(toolResult.text, "Reading\n\nHello Ada"); assert.equal(toolResult.usage.input, 40); assert.equal(toolResult.usage.output, 8);
  assert.equal(toolEvents.filter((event) => event.type === "text").map((event) => event.delta).join(""), toolResult.text);
  assert.ok(calls.at(-1).messages.some((message: any) => message.role === "tool" && JSON.stringify(message).includes("blue umbrella")));
  const isolatedCalls = calls.length;
  await Promise.all(["support", "default"].map((model) => run(normalizeRequest({ model, input: "Independent request" }, "responses"), async () => {})));
  assert.equal(calls.length, isolatedCalls + 2);
  for (const call of calls.slice(isolatedCalls)) assert.ok(!JSON.stringify(call.messages).includes("My name is Ada"));
  assert.deepEqual(new Set(authorizations.slice(isolatedCalls)), new Set(["Bearer fixture-default-token", "Bearer fixture-support-token"]));
  const cancellation = new AbortController();
  await assert.rejects(run(normalizeRequest({ model: "support", input: "Hold for cancellation" }, "responses"), async (event) => { if (event.type === "text") cancellation.abort(); }, cancellation.signal), (error: any) => error.name === "AbortError");
  await cancelledProvider;
  if (process.env.PI_OPENAI_TEST_NONO === "1") {
    const before = calls.length;
    const request = normalizeRequest({ model: "support", input: "Do not bypass the sandbox" }, "responses");
    await assert.rejects(executeWorker(process.execPath, [cli!, "--extension", extensions[0], "profile", "support", "--mode", "rpc", "--no-session"], { cwd: named, env: { ...env, PATH: "/nonexistent" } }, request, async () => {}, new AbortController().signal), (error: any) => error.status === 502);
    assert.equal(calls.length, before);
  }
  const cliEnv = { ...env, PI_OPENAI_WORKER: undefined };
  for (const args of [["profile", "create", "test-profile"], ...["skills", "extensions", "packages"].map((kind) => ["profile", "test-profile", kind, "list"])]) {
    const child = spawn(process.execPath, [cli!, "--extension", extensions[0], ...args], { cwd: root, env: cliEnv, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostics = "";
    child.stdout.on("data", (chunk) => { diagnostics += chunk; }); child.stderr.on("data", (chunk) => { diagnostics += chunk; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, diagnostics);
  }
  const created = join(root, "profiles", "test-profile");
  const createdSettings = JSON.parse(await readFile(join(created, "settings.json"), "utf8"));
  assert.ok(!("packages" in createdSettings)); assert.ok(!("extensions" in createdSettings));
  for (const name of ["git", "npm", "extensions", "node_modules"]) assert.ok(!existsSync(join(created, name)));
  const profileSettings = JSON.parse(await readFile(join(named, "settings.json"), "utf8"));
  assert.ok(!("packages" in profileSettings)); assert.ok(!("extensions" in profileSettings));
  for (const name of ["git", "npm", "extensions", "node_modules"]) assert.ok(!existsSync(join(named, name)));
  for (const dir of [root, named]) {
    const sessions = join(dir, "sessions");
    if (existsSync(sessions)) assert.deepEqual((await readdir(sessions, { recursive: true })).filter((name) => name.endsWith(".jsonl")), []);
  }
});
