import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
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
  await writeFile(probe, `const identity = process.env.PI_APPLICATION_IDENTITY_KEY ?? "none"; const directMemory = process.env.PI_APPLICATION_DIRECT_CONTEXT_MEMORY ? Buffer.from(process.env.PI_APPLICATION_DIRECT_CONTEXT_MEMORY, "base64url").toString() : "none"; let turns=0;
export default function(pi) {
  let brokenCleanup = false;
  if (identity === "customprovider") pi.registerProvider("scope-fixture", { api: "openai-completions", apiKey: "local-only", baseUrl: "http://127.0.0.1:1", models: [] });
  pi.on("before_agent_start", (event, ctx) => {
    if (JSON.stringify(event).includes("DIRTY_JOB_MARKER")) { setInterval(() => {}, 60000).unref(); process.on("beforeExit", () => {}); globalThis.__fixtureIdentity = identity; }
    if (JSON.stringify(event).includes("BROKEN_CLEANUP_MARKER")) brokenCleanup = true;
    return { systemPrompt: event.systemPrompt + "\\nWORKER_PID=" + process.pid + ";IDENTITY=" + identity + ";TURNS=" + (++turns) + ";MEMORY=" + directMemory + ";GLOBAL=" + (globalThis.__fixtureIdentity ?? "none") + ";CUSTOM_PROVIDER=" + ctx.modelRegistry.getRegisteredProviderIds().includes("scope-fixture") };
  });
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
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  // Exercise every shipped extension's real startup/shutdown lifecycle. Browser,
  // Composio and other external-service tools are never invoked by this fixture.
  const settings = { extensions: [...manifest.pi.extensions.map((path: string) => resolve(path)), probe, externalEntry], defaultProvider: "fixture", defaultModel: "fixture", defaultThinkingLevel: "off", compaction: { enabled: false } };
  await writeFile(join(root, "settings.json"), JSON.stringify(settings));
  await writeFile(join(root, ".env"), "PI_API_WORKER_IDLE_TIMEOUT_SECONDS=1\n");
  await writeFile(join(root, "api-server.json"), JSON.stringify({ host: "127.0.0.1", port: 0, apiToken: "fixture-token" }));
  await writeFile(join(profile, "settings.json"), JSON.stringify({ ...settings, extensions: undefined, sandbox: process.env.PI_OPENAI_TEST_NONO === "1", profile: { enabledTools: ["read"] } }));
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", apiKey: "local-only", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] } } }));
  const child = spawn(process.execPath, [resolve("tests/fixtures/profile-api.mjs"), root, cli!], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let diagnostics = ""; child.stdout.on("data", (chunk) => { diagnostics += chunk; }); child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const ended = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => { child.send?.("close"); await ended; });
  const address = await new Promise<any>((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", (code) => reject(new Error(`API exited ${code}: ${diagnostics}`))); });
  const post = async (path: string, payload: unknown, method = "POST", expected = 200) => {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { authorization: "Bearer fixture-token", "content-type": "application/json" }, body: JSON.stringify(payload) });
    const text = await res.text(); assert.equal(res.status, expected, `${text}\nFixture calls: ${JSON.stringify(calls.slice(-2))}`); return res.headers.get("content-type")?.includes("text/event-stream") ? text : JSON.parse(text);
  };
  const wire = () => JSON.stringify(calls.at(-1).messages);
  const pid = () => wire().match(/WORKER_PID=(\d+)/)?.[1];
  const coldStart = performance.now();
  const chat = await post("/v1/chat/completions", { model: "support", messages: [{ role: "user", content: "CHAT_MARKER" }] });
  const coldMs = performance.now() - coldStart;
  const firstPid = pid(); assert.ok(firstPid);
  assert.ok(wire().includes("EXTERNAL_EXTENSION_LOADED"));
  if (process.env.PI_OPENAI_TEST_NONO === "1") assert.ok(wire().includes("EXTERNAL_WRITABLE=false"));
  const warmStart = performance.now();
  const chatStream = await post("/v1/chat/completions", { model: "support", stream: true, messages: [{ role: "user", content: "WARM_CHAT_MARKER" }] });
  const warmMs = performance.now() - warmStart;
  assert.ok(chatStream.includes("[DONE]"));
  assert.equal(chat.choices[0].message.content, "Fixture answer"); assert.equal(pid(), firstPid);
  const response = await post("/v1/responses", { model: "support", input: "RESPONSES_MARKER", stream: true });
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
  t.diagnostic(`Local mock HTTP timings: cold=${coldMs.toFixed(0)}ms warm=${warmMs.toFixed(0)}ms after-expiry=${restartMs.toFixed(0)}ms (not model latency).`);
});
