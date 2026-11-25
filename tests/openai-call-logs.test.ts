import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { OpenAICallLogs } from "../extensions/api-server/openai-call-logs.ts";
import { CompatibilityError } from "../extensions/api-server/openai-contract.ts";
import { registerCompatibilityRoutes } from "../extensions/api-server/openai-routes.ts";
import type { OpenAICallLog } from "../extensions/lib/openai-call-log-types.ts";

const headers = { authorization: "Bearer fixture-credential" };
const responses = "/v1/responses";
const chat = "/v1/chat/completions";

test("compatibility logs capture JSON, SSE errors, rejected requests and disconnects without payloads", { timeout: 10_000 }, async (t) => {
  const calls: OpenAICallLog[] = [];
  let disconnected!: (call: OpenAICallLog) => void;
  const aborted = new Promise<OpenAICallLog>((resolve) => { disconnected = resolve; });
  const server = Fastify();
  t.after(() => { server.server.closeAllConnections(); return server.close(); });
  registerCompatibilityRoutes(server, {
    authorized: (value) => value === headers.authorization,
    profiles: async () => [{ name: "fixture" }],
    validateProfile: async () => {},
    logCall: (call) => { calls.push(call); if (call.outcome === "aborted") disconnected(call); },
    execute: async (request, emit, signal) => {
      await emit({ type: "ready" });
      if (request.profile === "disconnect") await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      if (request.stream) throw new CompatibilityError("Private provider detail", null, 502, "fixture_error");
      return { text: "Private model output", finishReason: "stop", usage: { input: 1, output: 1, cached: 0, reasoning: 0 } };
    },
  });
  await server.inject({ method: "POST", url: responses, payload: { model: "fixture", input: "Private prompt" } });
  await server.inject({ url: "/v1/models", headers });
  assert.equal(calls.length, 0);

  const result = await server.inject({ method: "POST", url: chat, headers, payload: { model: "fixture", messages: [{ role: "user", content: "Private prompt" }] } });
  const success = calls[0];
  assert.equal(success.id, result.json().id);
  assert.deepEqual([success.endpoint, success.profile, success.httpStatus, success.outcome, success.stream], [chat, "fixture", 200, "success", false]);
  assert.ok(success.durationMs >= 0 && Number.isFinite(Date.parse(success.receivedAt)));

  const failure = await server.inject({ method: "POST", url: responses, headers, payload: { model: "fixture", input: "Private prompt", stream: true } });
  assert.match(failure.body, /response\.failed/);
  assert.deepEqual([calls[1].endpoint, calls[1].httpStatus, calls[1].outcome, calls[1].stream, calls[1].errorCode], [responses, 200, "error", true, "fixture_error"]);
  await server.inject({ method: "POST", url: responses, headers: { ...headers, "content-type": "application/json" }, payload: "{" });
  assert.deepEqual([calls[2].profile, calls[2].httpStatus, calls[2].outcome], [null, 400, "error"]);

  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  const response = await fetch(`${address}${responses}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ model: "disconnect", input: "Private prompt", stream: true }), signal: controller.signal });
  await response.body!.getReader().read();
  controller.abort();
  const stopped = await aborted;
  assert.deepEqual([stopped.profile, stopped.httpStatus, stopped.outcome], ["disconnect", 200, "aborted"]);
  assert.equal(calls.length, 4);
  assert.doesNotMatch(JSON.stringify(calls), /Private|fixture-credential/);
});

test("call storage keeps a bounded persistent history and filters before pagination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-openai-call-logs-"));
  const path = join(directory, "logs.sqlite");
  let store = new OpenAICallLogs(path);
  try {
    for (let id = 1; id <= 5_002; id++) {
      store.record({ id: String(id), endpoint: id % 2 ? responses : chat, receivedAt: new Date().toISOString(), profile: id === 2 ? "evicted" : "fixture", stream: null, httpStatus: 400, outcome: "error", durationMs: 0, errorCode: "invalid_request_error" });
    }
    store.close();
    store = new OpenAICallLogs(path);
    assert.equal(store.list({ profile: "evicted" }).calls.length, 0);
    assert.equal(store.list({ outcome: "success" }).calls.length, 0);
    const first = store.list({ endpoint: responses, profile: "fixture", outcome: "error" });
    assert.equal(first.calls.length, 100);
    assert.equal(first.calls[0].id, "5001");
    const second = store.list({ endpoint: responses, before: first.next! });
    assert.equal(second.calls[0].id, "4801");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
