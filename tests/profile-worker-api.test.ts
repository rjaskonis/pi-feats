import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
const cli = process.env.PI_OPENAI_TEST_CLI;

test("HTTP compatibility and Direct share a resident profile process, preserve stateful transcripts, SSE and ack webhooks", { skip: !cli, timeout: 90_000 }, async (t) => {
  await mkdir(join(homedir(), ".cache"), { recursive: true });
  // /tmp is broadly accessible in the sandbox, so isolation probes live outside it.
  const root = await mkdtemp(join(homedir(), ".cache", "pi-profile-worker-api-")), profile = join(root, "profiles", "support");
  await mkdir(profile, { recursive: true }); t.after(() => rm(root, { recursive: true, force: true }));
  // Optional installed npm dependencies belong to the shared runtime, not the
  // profile. The sandbox grants this runtime tree read-only, as in production.
  if (process.env.PI_OPENAI_TEST_RUNTIME_NPM_DIR) await symlink(process.env.PI_OPENAI_TEST_RUNTIME_NPM_DIR, join(root, "npm"), "dir");
  const ownFile = join(profile, "own.txt"), neighborFile = join(root, "profiles", "neighbor", "private.txt");
  await mkdir(join(root, "profiles", "neighbor"), { recursive: true });
  await writeFile(ownFile, "OWN_WORKSPACE_DATA"); await writeFile(neighborFile, "NEIGHBOR_WORKSPACE_SECRET");
  const calls: any[] = []; let webhook!: (body: any) => void;
  const delivered = new Promise<any>((resolve) => { webhook = resolve; });
  const provider = createServer(async (req, res) => {
    let source = ""; for await (const chunk of req) source += chunk;
    const body = JSON.parse(source);
    if (req.url === "/webhook") { webhook(body); res.end("ok"); return; }
    calls.push(body);
    if (JSON.stringify(body.messages).includes("PROVIDER_USAGE_REJECT_MARKER")) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "The usage limit has been reached PRIVATE_PROVIDER_TOKEN_MARKER", type: "insufficient_quota", code: "insufficient_quota" } })); return;
    }
    if (JSON.stringify(body.messages).includes("PROVIDER_AUTH_REJECT_MARKER")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API key: PRIVATE_PROVIDER_TOKEN_MARKER", type: "invalid_request_error", code: "invalid_api_key" } })); return;
    }
    if (JSON.stringify(body.messages).includes("TRACE_PROVIDER_DELAY_MARKER")) await new Promise(resolve => setTimeout(resolve, 160));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta: unknown, finish_reason: unknown, usage?: unknown) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
    const messages = JSON.stringify(body.messages);
    if (!body.messages.some((message: any) => message.role === "tool") && /READ_(OWN|NEIGHBOR)_PROBE/.test(messages)) {
      frame({ role: "assistant", content: "Reading", tool_calls: [{ index: 0, id: "probe_read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: messages.includes("READ_OWN_PROBE") ? ownFile : neighborFile }) } }] }, null);
      frame({}, "tool_calls", { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }); res.end("data: [DONE]\n\n"); return;
    }
    frame({ role: "assistant", content: messages.includes("EMPTY_RESPONSE_MARKER") ? "" : "Fixture answer" }, null);
    frame({}, "stop", { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }); res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => provider.close(() => resolve())));
  const port = (provider.address() as { port: number }).port;
  const probe = join(root, "probe.ts");
  await writeFile(probe, `import { AsyncLocalStorage } from "node:async_hooks";
const proxyStorage = globalThis[Symbol.for("pi-web-access.proxyStorage")] ??= new AsyncLocalStorage();
const previousProxy = proxyStorage.getStore() ?? "none";
const previousHelper = process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH;
process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH = "/fixture/installation/bin/linux-bridge";
const identity = process.env.PI_APPLICATION_IDENTITY_KEY ?? "none"; const directMemory = process.env.PI_APPLICATION_DIRECT_CONTEXT_MEMORY ? Buffer.from(process.env.PI_APPLICATION_DIRECT_CONTEXT_MEMORY, "base64url").toString() : "none"; let turns=0;
export default function(pi) {
  let brokenCleanup = false;
  if (identity === "customprovider") pi.registerProvider("scope-fixture", { api: "openai-completions", apiKey: "local-only", baseUrl: "http://127.0.0.1:1", models: [] });
  pi.on("before_agent_start", async (event, ctx) => proxyStorage.run(identity, async () => {
    await Promise.resolve();
    if (JSON.stringify(event).includes("DIRTY_JOB_MARKER")) { setInterval(() => {}, 60000).unref(); process.on("beforeExit", () => {}); globalThis.__fixtureIdentity = identity; }
    if (JSON.stringify(event).includes("BROKEN_CLEANUP_MARKER")) brokenCleanup = true;
    return { systemPrompt: event.systemPrompt + "\\nWORKER_PID=" + process.pid + ";IDENTITY=" + identity + ";TURNS=" + (++turns) + ";MEMORY=" + directMemory + ";GLOBAL=" + (globalThis.__fixtureIdentity ?? "none") + ";CUSTOM_PROVIDER=" + ctx.modelRegistry.getRegisteredProviderIds().includes("scope-fixture") + ";PROXY=" + proxyStorage.getStore() + ";PREVIOUS_PROXY=" + previousProxy + ";PREVIOUS_HELPER=" + previousHelper };
  }));
  pi.on("session_shutdown", () => { if (brokenCleanup) throw new Error("Fixture cleanup failed"); });
}`);
  const external = await mkdtemp(join(homedir(), ".cache", "pi-worker-external-extension-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await mkdir(join(external, "lib"));
  await writeFile(join(external, "lib", "helper.ts"), 'export const marker = "EXTERNAL_EXTENSION_LOADED";');
  const externalEntry = join(external, "extension.ts");
  await writeFile(externalEntry, `import { marker } from "./lib/helper.ts";
import { writeFileSync } from "node:fs";
export default function(pi) {
  let writable = false;
  try { writeFileSync(${JSON.stringify(join(external, "write-probe.txt"))}, "probe"); writable = true; } catch {}
  pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\n" + marker + ";EXTERNAL_WRITABLE=" + writable }));
}`);
  const terminal = ["orca-agent-status.ts", "orca-titlebar-spinner.ts", "orca-prefill.ts"].map(name => join(root, name));
  for (const path of terminal) await writeFile(path, '// @orca-managed-pi-extension\nthrow new Error("Headless workers must not evaluate terminal presentation modules");\n');
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  // Exercise every shipped extension's real startup/shutdown lifecycle. Browser,
  // Composio and other external-service tools are never invoked by this fixture.
  // Opt in to local third-party lifecycle validation without calling their tools
  // or reading real credentials. Generation still uses the localhost mock.
  const integrationPaths = JSON.parse(process.env.PI_OPENAI_TEST_EXTERNAL_EXTENSIONS ?? "[]");
  assert.ok(Array.isArray(integrationPaths) && integrationPaths.every(path => typeof path === "string"));
  const settings = { extensions: [...manifest.pi.extensions.map((path: string) => resolve(path)), probe, externalEntry, ...terminal, ...integrationPaths], defaultProvider: "fixture", defaultModel: "fixture", defaultThinkingLevel: "off", compaction: { enabled: false } };
  await writeFile(join(root, "settings.json"), JSON.stringify(settings));
  await writeFile(join(root, ".env"), "PI_API_WORKER_IDLE_TIMEOUT_SECONDS=1\n");
  await writeFile(join(root, "api-server.json"), JSON.stringify({ host: "127.0.0.1", port: 0, apiToken: "fixture-token", workerLauncher: process.env.PI_OPENAI_TEST_WORKER_LAUNCHER }));
  await writeFile(join(profile, "settings.json"), JSON.stringify({ ...settings, extensions: undefined, sandbox: process.env.PI_OPENAI_TEST_NONO === "1", profile: { enabledTools: ["read"] } }));
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", apiKey: "local-only", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] } } }));
  const child = spawn(process.execPath, [resolve("tests/fixtures/profile-api.mjs"), root, cli!], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, PI_COMPUTER_USE_LINUX_HELPER_PATH: "BASE_HELPER_FIXTURE" } });
  let diagnostics = ""; child.stdout.on("data", (chunk) => { diagnostics += chunk; }); child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const ended = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => { child.send?.("close"); await ended; });
  const address = await new Promise<any>((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", (code) => reject(new Error(`API exited ${code}: ${diagnostics}`))); });
  const traces = () => diagnostics.split("\n").filter(line => line.startsWith("[pi-api-latency] ")).map(line => JSON.parse(line.slice("[pi-api-latency] ".length)));
  let traceId: string | null;
  const post = async (path: string, payload: unknown, method = "POST", expected = 200, trace = false) => {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { authorization: "Bearer fixture-token", "content-type": "application/json", ...(trace ? { "x-pi-trace-latency": "1" } : {}) }, body: JSON.stringify(payload) });
    traceId = res.headers.get("x-pi-trace-id");
    if (trace) assert.match(traceId ?? "", /^(chatcmpl|resp)_[a-f0-9]{32}$/);
    else assert.equal(traceId, null);
    const text = await res.text();
    if (expected === 200 && calls.length) {
      const messages = JSON.stringify(calls.at(-1).messages);
      assert.match(messages, /PREVIOUS_PROXY=none/);
      if (!integrationPaths.length) assert.match(messages, /PREVIOUS_HELPER=BASE_HELPER_FIXTURE/);
    }
    assert.equal(res.status, expected, `${text}\nFixture calls: ${JSON.stringify(calls.slice(-2))}`); return res.headers.get("content-type")?.includes("text/event-stream") ? text : JSON.parse(text);
  };
  const wire = () => JSON.stringify(calls.at(-1).messages);
  const pid = () => wire().match(/WORKER_PID=(\d+)/)?.[1];
  const coldStart = performance.now();
  const chat = await post("/v1/chat/completions", { model: "support", messages: [{ role: "user", content: "CHAT_MARKER TRACE_PROVIDER_DELAY_MARKER" }] }, "POST", 200, true);
  const coldId = traceId!; assert.equal(coldId, chat.id);
  const coldMs = performance.now() - coldStart;
  const firstPid = pid(); assert.ok(firstPid);
  assert.ok(wire().includes("EXTERNAL_EXTENSION_LOADED"));
  if (process.env.PI_OPENAI_TEST_NONO === "1") assert.ok(wire().includes("EXTERNAL_WRITABLE=false"));
  const warmStart = performance.now();
  const chatStream = await post("/v1/chat/completions", { model: "support", stream: true, messages: [{ role: "user", content: "WARM_CHAT_MARKER" }] });
  const warmMs = performance.now() - warmStart;
  assert.ok(chatStream.includes("[DONE]"));
  assert.equal(chat.choices[0].message.content, "Fixture answer"); assert.equal(pid(), firstPid);
  const response = await post("/v1/responses", { model: "support", input: "RESPONSES_MARKER", stream: true }, "POST", 200, true);
  const warmId = traceId!; assert.ok(response.includes(warmId));
  assert.ok(response.includes("response.completed")); assert.equal(pid(), firstPid); assert.ok(!wire().includes("CHAT_MARKER"));
  if (process.env.PI_OPENAI_TEST_NONO === "1") {
    await post("/v1/responses", { model: "support", input: "READ_OWN_PROBE" });
    assert.ok(wire().includes("OWN_WORKSPACE_DATA")); assert.equal(pid(), firstPid);
    await post("/v1/responses", { model: "support", input: "READ_NEIGHBOR_PROBE" });
    assert.ok(!wire().includes("NEIGHBOR_WORKSPACE_SECRET")); assert.match(wire(), /EACCES|denied|not permitted|restricted|sandbox/i); assert.equal(pid(), firstPid);
  }
  await post("/api/applications", { name: "Fixture", slug: "fixture", responseMode: "result" }, "POST", 201);
  await post("/api/applications/fixture/identity-mappings/alice", { profile: "support", sessionPrefix: "alice" }, "PUT");
  const first = await post("/api/message/app/fixture", { identityKey: "alice", message: "STATEFUL_API_MARKER", contextMemory: "APP_DIRECT_SECRET_MARKER" });
  assert.equal(first.response, "Fixture answer"); assert.equal(pid(), firstPid); assert.ok(wire().includes("IDENTITY=alice;TURNS=1")); assert.ok(wire().includes("APP_DIRECT_SECRET_MARKER"));
  await post("/api/message/app/fixture", { identityKey: "alice", message: "LATER_DIRECT_API_MARKER", contextMemory: "SECOND_APP_MEMORY_SECRET" });
  assert.ok(wire().includes("SECOND_APP_MEMORY_SECRET")); assert.ok(!wire().includes("APP_DIRECT_SECRET_MARKER"));
  const beforeStateless = await readdir(join(profile, "sessions"), { recursive: true });
  for (const entry of beforeStateless.filter((path) => path.endsWith(".jsonl"))) {
    const transcript = await readFile(join(profile, "sessions", entry), "utf8");
    assert.ok(!transcript.includes("APP_DIRECT_SECRET_MARKER"));
    assert.ok(!transcript.includes("SECOND_APP_MEMORY_SECRET"));
  }
  await post("/api/message/app/fixture", { identityKey: "alice", sessionType: "stateless", history: [{ role: "user", content: "CALLER_HISTORY_MARKER" }], message: "STATELESS_API_MARKER" });
  assert.ok(!wire().includes("APP_DIRECT_SECRET_MARKER"));
  assert.ok(wire().includes("CALLER_HISTORY_MARKER")); assert.ok(!wire().includes("STATEFUL_API_MARKER")); assert.equal(pid(), firstPid);
  assert.deepEqual(await readdir(join(profile, "sessions"), { recursive: true }), beforeStateless);
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const restartStart = performance.now();
  const next = await post("/api/message/app/fixture", { identityKey: "alice", message: "RESTORED_API_MARKER" });
  const restartMs = performance.now() - restartStart;
  assert.ok(!wire().includes("APP_DIRECT_SECRET_MARKER")); assert.ok(!wire().includes("SECOND_APP_MEMORY_SECRET"));
  assert.equal(next.sessionId, first.sessionId); assert.notEqual(pid(), firstPid);
  assert.ok(wire().includes("STATEFUL_API_MARKER")); assert.ok(!wire().includes("STATELESS_API_MARKER")); assert.ok(!wire().includes("CALLER_HISTORY_MARKER"));
  const streamed = await post(`/profile/support/api/sessions/${first.sessionId}/chat/stream`, { message: "SESSION_STREAM_MARKER" });
  assert.ok(streamed.includes("event: token")); assert.ok(streamed.includes("event: done"));
  assert.ok(wire().includes("STATEFUL_API_MARKER")); assert.ok(wire().includes("IDENTITY=none;TURNS=1"));
  await post("/api/applications", { name: "Ack fixture", slug: "ack-fixture", responseMode: "ack" }, "POST", 201);
  await post("/api/applications/ack-fixture/identity-mappings/alice", { profile: "support", sessionPrefix: "alice" }, "PUT");
  await post("/api/message/app/ack-fixture", { identityKey: "alice", sessionType: "stateless", message: "ACK_API_MARKER", responseWebhookUrl: `http://127.0.0.1:${port}/webhook` }, "POST", 202);
  assert.equal((await delivered).response, "Fixture answer");
  await post("/v1/responses", { model: "support", input: "AFTER_APP_MARKER" });
  assert.ok(wire().includes("IDENTITY=none;TURNS=1")); assert.ok(!wire().includes("STATEFUL_API_MARKER"));
  await post("/api/message/app/fixture", { identityKey: "alice", sessionType: "stateless", message: "DIRTY_JOB_MARKER" });
  const dirtyPid = pid(), beforeRecovery = calls.length;
  assert.ok(wire().includes("GLOBAL=alice"));
  await post("/v1/responses", { model: "support", input: "AFTER_DIRTY_MARKER" });
  assert.notEqual(pid(), dirtyPid); assert.ok(wire().includes("GLOBAL=none"));
  assert.equal(calls.length, beforeRecovery + 1, "retirement must not replay server actions");
  await post("/v1/responses", { model: "support", input: "BROKEN_CLEANUP_MARKER" });
  const brokenPid = pid();
  await post("/v1/responses", { model: "support", input: "AFTER_BROKEN_CLEANUP" });
  assert.notEqual(pid(), brokenPid, "failed shutdown hooks must prevent reuse");
  await post("/api/applications/fixture/identity-mappings/customprovider", { profile: "support", sessionPrefix: "customprovider" }, "PUT");
  await post("/api/message/app/fixture", { identityKey: "customprovider", sessionType: "stateless", message: "CUSTOM_PROVIDER_MARKER" });
  const providerPid = pid(); assert.ok(wire().includes("CUSTOM_PROVIDER=true"));
  await post("/v1/responses", { model: "support", input: "AFTER_CUSTOM_PROVIDER" });
  assert.notEqual(pid(), providerPid); assert.ok(wire().includes("CUSTOM_PROVIDER=false"));
  const empty = await post("/api/message/app/fixture", { identityKey: "alice", sessionType: "stateless", message: "READ_OWN_PROBE EMPTY_RESPONSE_MARKER" }, "POST", 502);
  // The existing Application HTTP envelope maps status-bearing errors to BAD_REQUEST.
  assert.equal(empty.error.code, "BAD_REQUEST"); assert.match(empty.error.message, /without an assistant response/);
  const authentication = await post("/v1/chat/completions", { model: "support", messages: [{ role: "user", content: "PROVIDER_AUTH_REJECT_MARKER" }] }, "POST", 424);
  assert.equal(authentication.error.code, "provider_authentication_failed");
  assert.equal(authentication.error.type, "authentication_error");
  assert.ok(!JSON.stringify(authentication).includes("PRIVATE_PROVIDER_TOKEN_MARKER"));
  const failedStream = await post("/v1/responses", { model: "support", input: "PROVIDER_AUTH_REJECT_MARKER", stream: true });
  assert.ok(failedStream.includes("response.failed"));
  assert.ok(failedStream.includes("provider_authentication_failed"));
  assert.ok(!failedStream.includes("PRIVATE_PROVIDER_TOKEN_MARKER"));
  await post("/v1/responses", { model: "support", input: "AFTER_AUTH_FAILURE" });
  const quota = await post("/v1/chat/completions", { model: "support", messages: [{ role: "user", content: "PROVIDER_USAGE_REJECT_MARKER" }] }, "POST", 429);
  assert.equal(quota.error.code, "provider_usage_limit_exceeded");
  assert.equal(quota.error.type, "rate_limit_error");
  assert.ok(!JSON.stringify(quota).includes("PRIVATE_PROVIDER_TOKEN_MARKER"));
  const quotaStream = await post("/v1/responses", { model: "support", input: "PROVIDER_USAGE_REJECT_MARKER", stream: true });
  assert.ok(quotaStream.includes("response.failed"));
  assert.ok(quotaStream.includes("provider_usage_limit_exceeded"));
  assert.ok(quotaStream.includes('"type":"rate_limit_error"'));
  assert.ok(!quotaStream.includes("PRIVATE_PROVIDER_TOKEN_MARKER"));
  await post("/v1/responses", { model: "support", input: "AFTER_QUOTA_FAILURE" });
  const settingsPath = join(profile, "settings.json");
  const originalSettings = await readFile(settingsPath, "utf8");
  const beforeUnavailable = calls.length;
  await writeFile(settingsPath, JSON.stringify({ ...JSON.parse(originalSettings), defaultModel: "PRIVATE_MISSING_MODEL_MARKER" }));
  const unavailable = await post(`/profile/support/api/sessions/${first.sessionId}/chat/stream`, { message: "MODEL_UNAVAILABLE_MARKER" });
  const failure = unavailable.split("\n\n").find((frame: string) => frame.startsWith("event: error\n"));
  assert.ok(failure);
  const data = JSON.parse(failure.split("\n")[1].slice(6));
  assert.equal(data.code, "profile_model_unavailable");
  assert.match(data.error, /configured model is unavailable.*provider catalog/);
  assert.doesNotMatch(unavailable, /PRIVATE_MISSING_MODEL_MARKER|event: done/);
  const compatUnavailable = await post("/v1/chat/completions", { model: "support", messages: [{ role: "user", content: "MODEL_UNAVAILABLE_MARKER" }] }, "POST", 502);
  assert.equal(compatUnavailable.error.code, data.code);
  assert.equal(compatUnavailable.error.message, data.error);
  assert.equal(calls.length, beforeUnavailable, "must not generate using a fallback model");
  await writeFile(settingsPath, originalSettings);
  await post("/v1/responses", { model: "support", input: "AFTER_MODEL_RESTORED" });
  const records = traces();
  assert.deepEqual(records.map(item => item.id), [coldId, warmId]);
  const [cold, warm] = records;
  assert.equal(cold.worker, "cold"); assert.equal(warm.worker, "reused");
  assert.equal(String(cold.execution.workerPid), firstPid); assert.equal(cold.execution.workerPid, warm.execution.workerPid);
  assert.ok(cold.launchPrepMs >= 0 && cold.launchPrepMs <= cold.dispatchMs);
  assert.equal(warm.launchPrepMs, undefined);
  for (const key of ["nodeToEntryMs", "sdkSetupMs", "sdkImportMs", "workerModulesMs", "nodeToFirstJobMs"]) {
    assert.ok(cold.execution[key] >= 0);
    assert.equal(warm.execution[key], undefined);
  }
  assert.ok(cold.execution.nodeToFirstJobMs >= cold.execution.sdkImportMs);
  assert.equal(cold.launcherPid, warm.launcherPid);
  assert.ok(cold.execution.modelActiveMs >= 150);
  for (const trace of records) {
    assert.equal(trace.outcome, "success"); assert.equal(trace.retired, false);
    assert.equal(trace.execution.modelStreams, 1); assert.equal(trace.execution.modelStreamsCompleted, 1);
    assert.ok(trace.execution.promptMs >= trace.execution.modelActiveMs);
    assert.ok(trace.execution.agentInitMs > 0);
    assert.ok(trace.untilReadyMs >= trace.dispatchMs && trace.dispatchMs >= trace.queueMs);
    assert.ok(trace.totalMs >= trace.untilIdleMs && trace.untilIdleMs >= trace.untilResultMs && trace.untilResultMs >= trace.untilFirstTextMs && trace.untilFirstTextMs >= trace.untilReadyMs);
  }
  assert.doesNotMatch(JSON.stringify(records), /TRACE_PROVIDER_DELAY_MARKER|fixture-token|local-only|Fixture answer/);
  t.diagnostic(`Local mock HTTP timings: cold=${coldMs.toFixed(0)}ms warm=${warmMs.toFixed(0)}ms after-expiry=${restartMs.toFixed(0)}ms (not model latency).`);
});
