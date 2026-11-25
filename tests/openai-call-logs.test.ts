import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { OpenAICallLogs } from "../extensions/api-server/openai-call-logs.ts";
import { registerOpenAICallLogRoutes } from "../extensions/api-server/openai-call-log-routes.ts";
import { snapshot } from "../extensions/api-server/openai-call-capture.ts";
import { proxyPiRequest } from "../extensions/pi-console-webui/lib/api-proxy.ts";
import { CompatibilityError } from "../extensions/api-server/openai-contract.ts";
import { registerCompatibilityRoutes } from "../extensions/api-server/openai-routes.ts";
import type { CallStage, OpenAICallLog } from "../extensions/lib/openai-call-log-types.ts";

const headers = { authorization: "Bearer fixture-credential" };
const responses = "/v1/responses";
const chat = "/v1/chat/completions";

test("compatibility logs capture JSON, SSE errors, rejected requests and disconnects without payloads", { timeout: 10_000 }, async (t) => {
  const calls: OpenAICallLog[] = [], workflows: CallStage[][] = [];
  let disconnected!: (call: OpenAICallLog) => void;
  const aborted = new Promise<OpenAICallLog>((resolve) => { disconnected = resolve; });
  const server = Fastify();
  t.after(() => { server.server.closeAllConnections(); return server.close(); });
  registerCompatibilityRoutes(server, {
    authorized: (value) => value === headers.authorization,
    profiles: async () => [{ name: "fixture" }],
    validateProfile: async (name) => { if (name === "missing") throw new CompatibilityError("Profile not found.", "model", 404, "model_not_found"); },
    logCall: (call, stages) => { calls.push(call); workflows.push(stages); if (call.outcome === "aborted") disconnected(call); },
    execute: async (request, emit, signal) => {
      await emit({ type: "ready" });
      if (request.profile === "disconnect") {
        await emit({ type: "text", delta: "Partial response" });
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }
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
  assert.deepEqual(workflows[0].map(({ id, outcome }) => [id, outcome]), [["request", "success"], ["validation", "success"], ["execution", "success"], ["response", "success"]]);
  assert.deepEqual(JSON.parse(JSON.stringify(workflows[0][0].data!.value)), { model: "fixture", messages: [{ role: "user", content: "Private prompt" }] });
  assert.deepEqual(JSON.parse(JSON.stringify(workflows[0][3].data!.value)), result.json());

  const failure = await server.inject({ method: "POST", url: responses, headers, payload: { model: "fixture", input: "Private prompt", stream: true } });
  assert.match(failure.body, /response\.failed/);
  assert.deepEqual([calls[1].endpoint, calls[1].httpStatus, calls[1].outcome, calls[1].stream, calls[1].errorCode], [responses, 200, "error", true, "fixture_error"]);
  await server.inject({ method: "POST", url: responses, headers: { ...headers, "content-type": "application/json" }, payload: "{" });
  assert.deepEqual([calls[2].profile, calls[2].httpStatus, calls[2].outcome], [null, 400, "error"]);
  assert.match(JSON.stringify(workflows[1].at(-1)?.data), /response\.failed/);
  const missing = await server.inject({ method: "POST", url: responses, headers, payload: { model: "missing", input: "Private prompt" } });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(workflows[3].map(({ id, outcome }) => [id, outcome]), [["request", "success"], ["validation", "error"], ["response", "error"]]);

  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  const response = await fetch(`${address}${responses}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ model: "disconnect", input: "Private prompt", stream: true }), signal: controller.signal });
  const reader = response.body!.getReader();
  let body = "";
  while (!body.includes("Partial response")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    body += Buffer.from(chunk.value!).toString();
  }
  controller.abort();
  const stopped = await aborted;
  assert.deepEqual([stopped.profile, stopped.httpStatus, stopped.outcome], ["disconnect", 200, "aborted"]);
  assert.equal(calls.length, 5);
  assert.match(JSON.stringify(workflows[4].at(-1)?.data), /Partial response/);
  assert.doesNotMatch(JSON.stringify(calls), /Private|fixture-credential/);
});

test("call storage keeps a bounded persistent history and filters before pagination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-openai-call-logs-"));
  const path = join(directory, "logs.sqlite");
  let store = new OpenAICallLogs(path);
  try {
    for (let id = 1; id <= 5_002; id++) {
      store.record({ id: String(id), endpoint: id % 2 ? responses : chat, receivedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(), profile: id === 2 ? "evicted" : "fixture", stream: null, httpStatus: 400, outcome: "error", durationMs: 0, errorCode: "invalid_request_error" }, [{ id: "request", outcome: "error", durationMs: 0 }]);
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
    const mixed = store.list({ endpoint: `${chat},${responses}`, outcome: "success,error" });
    assert.deepEqual(mixed.calls.slice(0, 2).map(({ endpoint }) => endpoint), [chat, responses]);
    assert.equal(mixed.calls.length, 100);
    const time = new Date(Date.UTC(2026, 0, 1, 0, 0, 4550)).toISOString();
    assert.deepEqual(store.list({ start: time, end: time }).calls.map(({ id }) => id), ["4550"]);
    assert.equal(store.detail("4502")?.stages, null);
    assert.equal(store.detail("4503")?.stages?.[0].id, "request");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("snapshot retains conversation data but excludes attachment bytes and common credential fields", () => {
  const captured = snapshot({ api_key: "fixture-secret", image_url: { url: "https://fixture.invalid/private" }, input: [{ type: "input_file", file_data: "fixture-bytes", filename: "report.pdf" }], prompt: "Visible conversation", long: "x".repeat(100_000) });
  const json = JSON.stringify(captured);
  assert.equal(captured.limited, true);
  assert.match(json, /Visible conversation|report\.pdf/);
  assert.doesNotMatch(json, /fixture-secret|fixture\.invalid|fixture-bytes/);
  assert.ok(Buffer.byteLength(json) <= 16_512);
});

test("Console proxy streams log invalidations and the API serves only authenticated details", { timeout: 10_000 }, async () => {
  const store = new OpenAICallLogs(":memory:");
  const server = Fastify();
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  registerOpenAICallLogRoutes(server, store, (request, reply) => {
    if (request.headers.authorization === headers.authorization) return true;
    reply.code(401).send({ error: "Unauthorized" }); return false;
  });
  registerCompatibilityRoutes(server, {
    authorized: (value) => value === headers.authorization,
    profiles: async () => [{ name: "fixture" }], validateProfile: async () => {},
    logCall: (call, stages) => store.record(call, stages), updateCall: (detail) => store.update(detail),
    execute: async (request, emit) => {
      await emit({ type: "ready" });
      if (request.stream) await gate;
      await emit({ type: "text", delta: "Example answer" });
      return { text: "Example answer", finishReason: "stop", usage: { input: 1, output: 1, cached: 0, reasoning: 0 } };
    },
  });
  const apiUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  const logsUrl = `${apiUrl}/api/openai-api-logs`;
  try {
    assert.equal((await fetch(`${logsUrl}/calls/example`)).status, 401);
    assert.equal((await fetch(`${logsUrl}/stream`)).status, 401);
    assert.equal((await fetch(`${logsUrl}?start=invalid`, { headers })).status, 400);
    const completed = await server.inject({ method: "POST", url: chat, headers, payload: { model: "fixture", messages: [{ role: "user", content: "Example prompt" }] } });
    assert.equal(completed.statusCode, 200);
    const stream = await proxyPiRequest(new Request("http://console/api/pi/openai-api-logs/stream", { signal: controller.signal }), ["openai-api-logs", "stream"], { apiUrl, apiToken: "fixture-credential" });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type")!, /text\/event-stream/);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    assert.match(decoder.decode((await reader.read()).value), /connected/);
    const request = await fetch(`${apiUrl}${responses}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ model: "fixture", stream: true, input: "Example prompt" }) });
    const notifications = decoder.decode((await reader.read()).value);
    const id = notifications.match(/"(resp_[a-f0-9]+)"/)?.[1];
    assert.ok(id);
    assert.doesNotMatch(notifications, /Example prompt/);
    const active = await fetch(`${logsUrl}?outcome=running`, { headers }).then((result) => result.json());
    assert.equal(active.calls[0].id, id);
    assert.equal(active.calls[0].outcome, "running");
    const filters = new URLSearchParams({ profile: "fixture", endpoint: `${chat},${responses}`, outcome: "running,success" });
    const mixed = await fetch(`${logsUrl}?${filters}`, { headers }).then((result) => result.json());
    assert.deepEqual(mixed.calls.map(({ id }: { id: string }) => id), [id, completed.json().id]);
    release();
    assert.match(await request.text(), /response.completed/);
    const detail = await fetch(`${logsUrl}/calls/${id}`, { headers }).then((result) => result.json());
    assert.equal(detail.call.outcome, "success");
    assert.match(JSON.stringify(detail.stages.at(-1).data), /Example answer/);
    assert.equal(detail.stages.at(-1).data.value.terminalEvent.type, "response.completed");
    await reader.cancel();
  } finally {
    release();
    controller.abort();
    server.server.closeAllConnections();
    await server.close();
    store.close();
  }
});
