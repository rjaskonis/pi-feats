import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProfileWorkerRuntime, profileWorkerVersion } from "../extensions/api-server/profile-worker-runtime.ts";
import { ClientToolsRuntime } from "../extensions/api-server/openai-client-runtime.ts";
import { normalizeRequest } from "../extensions/api-server/openai-contract.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "pi-profile-workers-"));
  let launches = 0, version = "one";
  const warnings: string[] = [];
  const launch = () => { launches++; return { command: process.execPath, args: [resolve("tests/fixtures/profile-worker.mjs")], cwd: root, env: {} }; };
  const runtime = new ProfileWorkerRuntime({ agentDir: root, launch, version: async () => version, warn: (message) => warnings.push(message) });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const run = (content = "hello", profile = "support", signal = new AbortController().signal) => runtime.execute(profile, { request: normalizeRequest({ model: profile, input: content }, "responses") }, async () => {}, signal);
  return { root, runtime, run, launch, warnings, get launches() { return launches; }, version: (value: string) => { version = value; } };
}

test("resource signatures detect configuration/code changes but ignore idle-timeout-only edits", async (t) => {
  const f = await fixture(t);
  const extension = join(f.root, "probe.ts");
  await writeFile(extension, "export default function() {}\n");
  await writeFile(join(f.root, "settings.json"), JSON.stringify({ extensions: [extension] }));
  await writeFile(join(f.root, ".env"), "TOKEN=private\nPI_API_WORKER_IDLE_TIMEOUT_SECONDS=600\n");
  const initial = await profileWorkerVersion(f.root, f.root);
  await writeFile(join(f.root, ".env"), "TOKEN=private\nPI_API_WORKER_IDLE_TIMEOUT_SECONDS=2\n");
  assert.equal(await profileWorkerVersion(f.root, f.root), initial);
  await writeFile(extension, "export default function() { /* changed source */ }\n");
  assert.notEqual(await profileWorkerVersion(f.root, f.root), initial);
  await writeFile(join(f.root, ".env"), "TOKEN=replaced\n");
  assert.notEqual(await profileWorkerVersion(f.root, f.root), initial);
  await writeFile(join(f.root, ".env"), "MALFORMED_PRIVATE_VALUE\n");
  await assert.rejects(profileWorkerVersion(f.root, f.root), (error: any) => error.code === "worker_configuration_error" && !error.message.includes("MALFORMED_PRIVATE_VALUE"));
});

test("resident and client-tool transports preserve safe provider authentication failures", async (t) => {
  const f = await fixture(t);
  const check = (error: any) => error.status === 424 && error.code === "provider_authentication_failed" && !error.message.includes("PRIVATE_TOKEN_MARKER");
  await assert.rejects(f.run("provider-auth-failure"), check);
  const client = new ClientToolsRuntime({ settings: async () => ({ profile: { clientTools: { enabled: true, allowedTools: ["view_file"] } } }), launch: f.launch, transport: profile => f.runtime.clientTransport(profile) });
  t.after(() => client.close());
  const input = (await client.select({ model: "support", input: "provider-auth-failure", tools: [{ type: "function", name: "view_file", parameters: { type: "object", properties: {} } }] })).client!;
  await assert.rejects(client.execute(input, async () => {}, new AbortController().signal), check);
  assert.ok((await f.run()).text);
});

test("profile lanes reuse one process, serialize concurrent boot and isolate profiles", async (t) => {
  const f = await fixture(t);
  const values = await Promise.all(Array.from({ length: 6 }, () => f.run()));
  assert.equal(new Set(values.map((v) => v.text)).size, 1); assert.equal(f.launches, 1);
  const other = await f.run("hello", "sales"); assert.notEqual(other.text, values[0].text); assert.equal(f.launches, 2);
  f.version("two"); assert.notEqual((await f.run()).text, values[0].text); assert.equal(f.launches, 3);
});

test("startup-generated resource changes establish the reuse baseline after initialization", async (t) => {
  const f = await fixture(t); let version = "before";
  const pool = new ProfileWorkerRuntime({ agentDir: f.root, launch: () => { version = "after"; return f.launch(); }, version: async () => version });
  t.after(() => pool.close());
  const run = () => pool.execute("support", { request: normalizeRequest({ model: "support", input: "hello" }, "responses") }, async () => {}, new AbortController().signal);
  assert.equal((await run()).text, (await run()).text); assert.equal(f.launches, 1);
  version = "updated"; await run(); assert.equal(f.launches, 2);
});

test("profile queues reject excess reservations rather than allocating more processes", async (t) => {
  const f = await fixture(t);
  const jobs = Array.from({ length: 64 }, () => f.run("delay:200"));
  const settled = Promise.allSettled(jobs);
  await assert.rejects(f.run(), (error: any) => error.status === 429 && error.code === "worker_capacity");
  const client = new ClientToolsRuntime({ settings: async () => ({ profile: { clientTools: { enabled: true, allowedTools: ["view_file"] } } }), launch: f.launch, transport: (profile) => f.runtime.clientTransport(profile) });
  t.after(() => client.close());
  const input = (await client.select({ model: "support", input: "client", tools: [{ type: "function", name: "view_file", parameters: { type: "object", properties: {} } }] })).client!;
  await assert.rejects(client.execute(input, async () => {}, new AbortController().signal), (error: any) => error.status === 429 && error.code === "worker_capacity");
  await f.runtime.close(); await settled; assert.ok(f.launches <= 1);
});

test("idle expiry is measured after completion, supports hot reload/removal and reboots", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, ".env"), "PI_API_WORKER_IDLE_TIMEOUT_SECONDS=1\n");
  const initial = await f.run();
  await sleep(600); assert.equal((await f.run()).text, initial.text);
  await sleep(600); assert.equal((await f.run()).text, initial.text);
  await sleep(1200); assert.equal(f.runtime.size, 0);
  const second = await f.run(); assert.notEqual(second.text, initial.text);
  await writeFile(join(f.root, ".env"), "PI_API_WORKER_IDLE_TIMEOUT_SECONDS=invalid\n"); await f.runtime.refreshTimeout();
  assert.equal(f.warnings.length, 1);
  await rm(join(f.root, ".env")); await f.runtime.refreshTimeout();
  await sleep(1200); assert.equal(f.runtime.size, 1);
  assert.equal((await f.run()).text, second.text);
  await sleep(1100);
  await writeFile(join(f.root, ".env"), "PI_API_WORKER_IDLE_TIMEOUT_SECONDS=1\n"); await f.runtime.refreshTimeout();
  assert.equal(f.runtime.size, 0);
});

test("the lazy configuration watcher reloads the root env without an explicit refresh", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, ".env"), "PI_API_WORKER_IDLE_TIMEOUT_SECONDS=1\n");
  const pool = new ProfileWorkerRuntime({ agentDir: f.root, launch: f.launch, reloadIntervalMs: 20 });
  t.after(() => pool.close());
  const run = () => pool.execute("support", { request: normalizeRequest({ model: "support", input: "hello" }, "responses") }, async () => {}, new AbortController().signal);
  const first = await run(); await rm(join(f.root, ".env"));
  await sleep(1200); assert.equal(pool.size, 1); assert.equal((await run()).text, first.text);
});

test("active requests and queued reservations do not expire; queued cancellation does not cancel active work", { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, ".env"), "PI_API_WORKER_IDLE_TIMEOUT_SECONDS=1\n");
  let ready!: () => void; const started = new Promise<void>((resolve) => { ready = resolve; });
  const first = f.runtime.execute("support", { request: normalizeRequest({ model: "support", input: "delay:1400" }, "responses") }, async (event) => { if (event.type === "ready") ready(); }, new AbortController().signal);
  await started;
  const cancel = new AbortController(); const second = f.run("hello", "support", cancel.signal);
  const rejection = assert.rejects(second, (error: any) => error.name === "AbortError"); cancel.abort(); await rejection;
  const third = f.run();
  await sleep(1100); assert.equal(f.runtime.size, 1); assert.equal(f.runtime.isBusy("support"), true);
  await first; await third; assert.equal(f.launches, 1);
});

test("crash, active cancellation and shutdown fail without replay and reap processes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run("crash"), (error: any) => error.code === "worker_transport_error" && !error.message.includes("secret"));
  assert.equal(f.launches, 1); await f.run(); assert.equal(f.launches, 2);
  const controller = new AbortController();
  await assert.rejects(f.runtime.execute("support", { request: normalizeRequest({ model: "support", input: "hang" }, "responses") }, async (event) => { if (event.type === "ready") controller.abort(); }, controller.signal), (error: any) => error.name === "AbortError");
  await f.run(); assert.equal(f.launches, 3); await f.runtime.close(); assert.equal(f.runtime.size, 0);
  await assert.rejects(f.run(), (error: any) => error.status === 503);
});

test("client continuations reserve the same profile lane until final cleanup, then ordinary requests reuse it", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const client = new ClientToolsRuntime({ settings: async () => ({ profile: { clientTools: { enabled: true, allowedTools: ["view_file"], timeoutSeconds: 30 } } }), launch: f.launch, transport: (profile) => f.runtime.clientTransport(profile) });
  t.after(() => client.close());
  const initial = (await client.select({ model: "support", input: "client", tools: [{ type: "function", name: "view_file", parameters: { type: "object", properties: {} } }] })).client!;
  const first = await client.execute(initial, async () => {}, new AbortController().signal);
  assert.equal(first.pending, true); assert.equal(f.runtime.isBusy("support"), true);
  const ordinary = f.run();
  const continuation = (await client.select({ model: "support", input: [{ type: "function_call_output", call_id: first.calls[0].call_id, output: "done" }] })).client!;
  const result = await client.execute(continuation, async () => {}, new AbortController().signal);
  const final = await ordinary;
  assert.equal(result.pending, false); assert.equal(result.text.split(":")[1], final.text.split(":")[1]); assert.equal(f.launches, 1);
});
