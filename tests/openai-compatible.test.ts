import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { EventEmitter } from "node:events";
import { CompatibilityError, normalizeRequest, type CompletionRequest } from "../extensions/api-server/openai-contract.ts";
import { registerCompatibilityRoutes, writeSse, type CompatibilityBackend } from "../extensions/api-server/openai-routes.ts";
import { executeSession, executeWorker, restoreHistory, WORKER_EVENT_PREFIX } from "../extensions/api-server/openai-execution.ts";

const usage = { input: 12, output: 4, cached: 3, reasoning: 1 };
const body = (protocol: "chat" | "responses", stream = false) => protocol === "chat" ? { model: "support", messages: [{ role: "user", content: "Hello" }], stream } : { model: "support", input: "Hello", stream };
const normalized = () => normalizeRequest(body("chat"), "chat");
const ignoredClientOptions = {
  tools: [{ type: "function", function: { name: "get_current_timestamp", parameters: { type: "object", properties: {} } } }],
  tool_choice: "required", parallel_tool_calls: true, functions: [{ name: "legacy_tool" }], function_call: "auto",
  temperature: 0.5, top_p: 0.9, top_k: 20, min_p: 0.1, max_tokens: 1000, max_completion_tokens: 1000, max_output_tokens: 1000,
  frequency_penalty: 0.5, presence_penalty: 0.5, seed: 42, stop: ["END"], logprobs: true, top_logprobs: 5, logit_bias: { "1": -10 },
  reasoning_effort: "high", reasoning: { effort: "high", summary: "auto" }, include: ["reasoning.encrypted_content"],
  response_format: { type: "json_schema", json_schema: { name: "ignored", schema: { type: "object" } } },
  text: { format: { type: "json_object" }, verbosity: "low" }, modalities: ["audio"], audio: { voice: "alloy", format: "mp3" },
  n: 3, store: true, background: true, service_tier: "priority", truncation: "auto",
  user: { id: "client-user" }, safety_identifier: { ignored: true }, unknown_provider_setting: { enabled: true },
};
function backend(overrides: Partial<CompatibilityBackend> = {}): CompatibilityBackend {
  return {
    authorized: (value) => value === "Bearer test-token",
    profiles: async () => [{ name: "default" }, { name: "support" }],
    validateProfile: async (profile) => { if (profile !== "support" && profile !== "default") throw new CompatibilityError("Profile not found.", "model", 404, "model_not_found"); },
    execute: async (_request, emit, signal) => { signal.throwIfAborted(); await emit({ type: "ready" }); await emit({ type: "text", delta: "Hel" }); await emit({ type: "text", delta: "lo" }); return { text: "Hello", finishReason: "stop", usage }; },
    ...overrides,
  };
}
async function app(overrides: Partial<CompatibilityBackend> = {}) {
  const server = Fastify(); registerCompatibilityRoutes(server, backend(overrides)); await server.ready(); return server;
}
const headers = { authorization: "Bearer test-token" };
const url = (protocol: string) => protocol === "chat" ? "/v1/chat/completions" : "/v1/responses";
function frames(text: string) { return text.split("\n\n").filter(Boolean).map((frame) => { const data = frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6); return data === "[DONE]" ? data : JSON.parse(data); }); }

test("normalization preserves structured chronological context and text parts", () => {
  const request = normalizeRequest({ model: "support", messages: [{ role: "system", content: "Policy" }, { role: "user", content: [{ type: "text", text: "Ada" }] }, { role: "assistant", content: "Hello Ada" }, { role: "developer", content: "Be brief" }, { role: "user", content: "My name?" }] }, "chat");
  assert.deepEqual(request.messages.map((message) => message.role), ["system", "user", "assistant", "system", "user"]);
  const entries: any[] = []; restoreHistory({ appendMessage: (value) => { entries.push(value); return "id"; } }, request);
  assert.equal(entries.length, 2); assert.equal(entries[0].content, "Ada"); assert.equal(entries[1].content[0].text, "Hello Ada");
});

test("Responses accepts instructions and previous output messages as caller-owned history", () => {
  const request = normalizeRequest({ model: "support", instructions: "Be concise", input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }, { id: "msg_old", type: "message", status: "completed", phase: "final_answer", role: "assistant", content: [{ type: "output_text", text: "Hi", annotations: [], logprobs: [] }] }, { role: "user", content: "Continue" }], store: false, text: { format: { type: "text" } } }, "responses");
  assert.equal(request.instructions, "Be concise"); assert.equal(request.messages[1].content, "Hi");
});

for (const protocol of ["chat", "responses"] as const) {
  test(`${protocol}: ignores client execution preferences without forwarding them or mutating input`, () => {
    const input = { ...body(protocol), ...structuredClone(ignoredClientOptions) };
    const original = structuredClone(input);
    assert.deepEqual(normalizeRequest(input, protocol), normalizeRequest(body(protocol), protocol));
    assert.deepEqual(input, original);
    // Ignored options are not parsed or applied, even if their values are malformed.
    assert.deepEqual(normalizeRequest({ ...body(protocol), tools: 1, temperature: {}, max_output_tokens: "invalid", text: false }, protocol), normalizeRequest(body(protocol), protocol));
  });
  test(`${protocol}: still validates core fields, real content and stored-context references`, () => {
    assert.throws(() => normalizeRequest({ ...body(protocol), stream: "true" }, protocol));
    const messages = [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/image.png" }] }];
    assert.throws(() => normalizeRequest({ ...body(protocol), [protocol === "chat" ? "messages" : "input"]: messages }, protocol));
    for (const field of ["previous_response_id", "conversation"]) assert.throws(() => normalizeRequest({ ...body(protocol), [field]: "stored-context" }, protocol), (error: any) => error.param === field);
    const toolHistory = protocol === "chat" ? [{ role: "tool", tool_call_id: "call_1", content: "result" }] : [{ type: "function_call_output", call_id: "call_1", output: "result" }];
    assert.throws(() => normalizeRequest({ ...body(protocol), [protocol === "chat" ? "messages" : "input"]: [...toolHistory, { role: "user", content: "Hello" }] }, protocol));
  });
  test(`${protocol}: Open WebUI-style options work in JSON and SSE with profile-owned settings`, async (t) => {
    const requests: CompletionRequest[] = [];
    const server = await app({ execute: async (request, emit, signal) => { requests.push(request); return backend().execute(request, emit, signal); } });
    t.after(() => server.close());
    for (const stream of [false, true]) {
      const response = await server.inject({ method: "POST", url: url(protocol), headers, payload: { ...body(protocol, stream), ...ignoredClientOptions } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(requests.at(-1), normalizeRequest(body(protocol, stream), protocol));
      const value = stream ? frames(response.body) : response.json();
      if (protocol === "chat") {
        if (stream) assert.equal(value.at(-2).choices[0].finish_reason, "stop");
        else { assert.equal(value.choices.length, 1); assert.equal(value.choices[0].message.content, "Hello"); assert.equal(value.choices[0].message.tool_calls, undefined); }
      } else {
        const result = stream ? value.at(-1).response : value;
        assert.equal(result.status, "completed"); assert.equal(result.store, false); assert.equal(result.background, false);
        assert.deepEqual(result.tools, []); assert.equal(result.parallel_tool_calls, false); assert.equal(result.max_output_tokens, null);
        assert.deepEqual(result.text.format, { type: "text" }); assert.equal(result.output[0].content[0].text, "Hello");
      }
    }
  });
  test(`${protocol}: JSON completion selects the requested profile`, async (t) => {
    let selected: CompletionRequest | undefined;
    const server = await app({ execute: async (request, emit, signal) => { selected = request; return backend().execute(request, emit, signal); } }); t.after(() => server.close());
    const response = await server.inject({ method: "POST", url: url(protocol), headers, payload: body(protocol) });
    assert.equal(response.statusCode, 200); const value = response.json(); assert.equal(value.model, "support"); assert.equal(selected?.profile, "support");
    assert.equal(value.usage.total_tokens, 16);
    if (protocol === "chat") { assert.equal(value.object, "chat.completion"); assert.equal(value.choices[0].message.content, "Hello"); assert.equal(value.choices[0].finish_reason, "stop"); }
    else { assert.equal(value.object, "response"); assert.equal(value.status, "completed"); assert.equal(value.output[0].content[0].text, "Hello"); assert.equal(value.store, false); }
  });
  test(`${protocol}: streams valid incremental frames and terminal usage`, async (t) => {
    const server = await app(); t.after(() => server.close());
    const response = await server.inject({ method: "POST", url: url(protocol), headers, payload: { ...body(protocol, true), ...(protocol === "chat" ? { stream_options: { include_usage: true } } : {}) } });
    assert.equal(response.statusCode, 200); assert.match(response.headers["content-type"]!, /text\/event-stream/); assert.equal(response.headers["x-accel-buffering"], "no");
    const events = frames(response.body);
    if (protocol === "chat") {
      assert.deepEqual(events.slice(1, 3).map((value) => value.choices[0].delta.content), ["Hel", "lo"]);
      assert.equal(events.at(-3).choices[0].finish_reason, "stop"); assert.equal(events.at(-2).usage.total_tokens, 16); assert.deepEqual(events.at(-2).choices, []); assert.equal(events.at(-1), "[DONE]");
      assert.equal(new Set(events.filter((value) => value !== "[DONE]").map((value) => value.id)).size, 1);
    } else {
      assert.deepEqual(events.map((value) => value.type), ["response.created", "response.in_progress", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"]);
      assert.deepEqual(events.map((value) => value.sequence_number), events.map((_, index) => index));
      assert.equal(events.at(-1).response.output[0].content[0].text, "Hello"); assert.equal(events.at(-1).response.usage.total_tokens, 16);
      assert.equal(events[4].item_id, events[2].item.id);
    }
  });
  test(`${protocol}: reports truncation correctly in JSON and SSE`, async (t) => {
    const server = await app({ execute: async (request, emit, signal) => ({ ...await backend().execute(request, emit, signal), finishReason: "length" }) }); t.after(() => server.close());
    for (const stream of [false, true]) {
      const response = await server.inject({ method: "POST", url: url(protocol), headers, payload: body(protocol, stream) });
      const value = stream ? frames(response.body) : response.json();
      if (protocol === "chat") assert.equal(stream ? value.at(-2).choices[0].finish_reason : value.choices[0].finish_reason, "length");
      else { const result = stream ? value.at(-1).response : value; assert.equal(result.status, "incomplete"); assert.equal(result.incomplete_details.reason, "max_output_tokens"); if (stream) assert.equal(value.at(-1).type, "response.incomplete"); }
    }
  });
  test(`${protocol}: authentication, validation, and profile errors use OpenAI envelopes`, async (t) => {
    const server = await app(); t.after(() => server.close());
    for (const [payload, auth, status, param] of [[body(protocol), {}, 401, null], [{ ...body(protocol), model: "missing" }, headers, 404, "model"], [{ ...body(protocol), stream: "invalid" }, headers, 400, "stream"]] as const) {
      const response = await server.inject({ method: "POST", url: url(protocol), headers: auth, payload });
      assert.equal(response.statusCode, status); const error = response.json().error; assert.equal(error.param, param); assert.equal(typeof error.type, "string"); assert.equal(typeof error.code, "string");
    }
    const malformed = await server.inject({ method: "POST", url: url(protocol), headers: { ...headers, "content-type": "application/json" }, payload: "{" });
    assert.equal(malformed.statusCode, 400); assert.equal(malformed.json().error.type, "invalid_request_error");
  });
  test(`${protocol}: failures before/after SSE never expose integration details`, async (t) => {
    for (const started of [false, true]) {
      const server = await app({ execute: async (_request, emit) => { if (started) { await emit({ type: "ready" }); await emit({ type: "text", delta: "Partial" }); } throw new Error("secret provider body"); } }); t.after(() => server.close());
      const response = await server.inject({ method: "POST", url: url(protocol), headers, payload: body(protocol, true) });
      assert.ok(!response.body.includes("secret"));
      if (!started) { assert.equal(response.statusCode, 500); assert.equal(response.json().error.type, "server_error"); }
      else { assert.equal(response.statusCode, 200); const events = frames(response.body); assert.ok(protocol === "chat" ? events.some((value) => value.error) : events.some((value) => value.type === "response.failed")); }
    }
  });
}

test("models lists profile IDs without exposing paths", async (t) => {
  const server = await app(); t.after(() => server.close());
  const response = await server.inject({ url: "/v1/models", headers });
  assert.deepEqual(response.json().data.map((model: any) => model.id), ["default", "support"]); assert.ok(!response.body.includes("path"));
});

test("real HTTP streams before completion and disconnect aborts execution", async (t) => {
  let release!: () => void, aborted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const abortSeen = new Promise<void>((resolve) => { aborted = resolve; });
  const server = await app({ execute: async (_request, emit, signal) => {
    signal.addEventListener("abort", () => { aborted(); release(); }, { once: true });
    await emit({ type: "ready" }); await emit({ type: "text", delta: "First" }); await gate; signal.throwIfAborted(); return { text: "First", finishReason: "stop", usage };
  } });
  await server.listen({ host: "127.0.0.1", port: 0 }); t.after(() => { release(); return server.close(); });
  const address = server.server.address() as { port: number };
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body("responses", true)), signal: controller.signal });
  const reader = response.body!.getReader(); const first = await reader.read(); assert.ok(new TextDecoder().decode(first.value).includes("response.created"));
  controller.abort(); await abortSeen; server.server.closeAllConnections();
});

function fakeSession(events: any[], error?: Error) {
  let listener: (event: any) => void = () => {}, disposed = false, aborted = false;
  return {
    subscribe: (callback: any) => { listener = callback; return () => { listener = () => {}; }; },
    prompt: async () => { for (const event of events) listener(event); if (error) throw error; }, waitForIdle: async () => {},
    abort: async () => { aborted = true; }, dispose: () => { disposed = true; }, state: () => ({ disposed, aborted }),
  };
}
const modelUsage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 1 };
function assistant(text: string, stopReason = "stop", usage = modelUsage) { return { role: "assistant", content: [{ type: "text", text }], stopReason, usage }; }

test("executor accumulates real usage across model/tool turns and streams the same text it returns", async () => {
  const session = fakeSession([
    { type: "message_start", message: assistant("") }, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Working" } }, { type: "message_end", message: assistant("Working", "toolUse") },
    { type: "message_end", message: { role: "toolResult", usage: modelUsage } },
    { type: "message_start", message: assistant("") }, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done" } }, { type: "message_end", message: assistant("Done") },
  ]);
  const events: any[] = [];
  const result = await executeSession(session as any, normalized(), (event) => events.push(event), new AbortController().signal);
  assert.equal(result.text, "Working\n\nDone"); assert.equal(events.filter((event) => event.type === "text").map((event) => event.delta).join(""), result.text);
  assert.deepEqual(result.usage, { input: 39, output: 15, cached: 6, reasoning: 3 }); assert.ok(session.state().disposed);
});

test("executor disposes on errors, pre-abort, missing response, and finalized output rewrites", async () => {
  const controller = new AbortController(); controller.abort();
  for (const [session, signal] of [[fakeSession([], new Error("failure")), new AbortController().signal], [fakeSession([]), controller.signal], [fakeSession([]), new AbortController().signal], [fakeSession([{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Before" } }, { type: "message_end", message: assistant("After") }]), new AbortController().signal]] as const) {
    await assert.rejects(executeSession(session as any, normalized(), () => {}, signal)); assert.ok(session.state().disposed);
  }
});

test("worker channel streams structured records and redacts stderr on failure", async () => {
  const script = `process.stdin.resume(); process.stdin.on('end', () => { for (const value of [{type:'ready'}, {type:'text',delta:'Hello'}, {type:'result',result:{text:'Hello',finishReason:'stop',usage:${JSON.stringify(usage)}}}]) console.log(${JSON.stringify(WORKER_EVENT_PREFIX)}+JSON.stringify(value)); });`;
  const events: any[] = [];
  const result = await executeWorker(process.execPath, ["-e", script], { cwd: process.cwd(), env: process.env }, normalized(), async (event) => { events.push(event); }, new AbortController().signal);
  assert.equal(result.text, "Hello"); assert.equal(events[1].delta, "Hello");
  await assert.rejects(executeWorker(process.execPath, ["-e", "console.error('secret'); process.exit(1)"], { cwd: process.cwd(), env: process.env }, normalized(), async () => {}, new AbortController().signal), (error: any) => !error.message.includes("secret") && error.status === 502);
});

test("strict bounds, nested validation, profile names and terminal history shapes", () => {
  for (const model of ["../support", "/tmp/support", "support/x", "", "x".repeat(65)]) assert.throws(() => normalizeRequest({ ...body("chat"), model }, "chat"));
  assert.doesNotThrow(() => normalizeRequest({ ...body("responses"), input: "x".repeat(100_000) }, "responses"));
  assert.throws(() => normalizeRequest({ ...body("responses"), input: "x".repeat(100_001) }, "responses"), (error: any) => error.status === 413);
  assert.throws(() => normalizeRequest({ ...body("responses"), instructions: "x", input: "x".repeat(100_000) }, "responses"));
  for (const messages of [[], Array.from({ length: 101 }, () => ({ role: "user", content: "x" })), [{ role: "assistant", content: "Hello" }], [{ role: "user", content: " " }]]) assert.throws(() => normalizeRequest({ ...body("chat"), messages }, "chat"));
  for (const metadata of [Array(2), { key: 1 }, { ["k".repeat(65)]: "x" }, { key: "x".repeat(513) }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [String(i), "x"]))]) assert.throws(() => normalizeRequest({ ...body("chat"), metadata }, "chat"));
  assert.throws(() => normalizeRequest({ ...body("chat"), messages: [{ role: "user", content: [{ type: "text", text: "x", unknown: true }] }] }, "chat"));
  assert.throws(() => normalizeRequest({ ...body("chat", true), stream_options: { include_usage: "invalid" } }, "chat"));
});

test("stream options preserve usage while ignoring unknown options and inapplicable fields", () => {
  assert.equal(normalizeRequest({ ...body("chat", true), stream_options: { include_usage: true, include_obfuscation: true, future_option: {} } }, "chat").includeUsage, true);
  assert.equal(normalizeRequest({ ...body("chat"), stream_options: { include_usage: true } }, "chat").includeUsage, false);
  assert.equal(normalizeRequest({ ...body("responses", true), stream_options: { include_usage: "ignored", include_obfuscation: true } }, "responses").includeUsage, false);
  assert.equal(normalizeRequest({ ...body("chat"), instructions: { ignored: true } }, "chat").instructions, null);
  assert.throws(() => normalizeRequest({ ...body("responses"), instructions: { invalid: true } }, "responses"));
});

test("HTTP body limits and unsupported media types retain compatible envelopes", async (t) => {
  const server = await app(); t.after(() => server.close());
  const oversized = await server.inject({ method: "POST", url: url("responses"), headers, payload: { ...body("responses"), input: "x".repeat(1_048_576) } });
  assert.equal(oversized.statusCode, 413); assert.equal(oversized.json().error.code, "request_too_large");
  const media = await server.inject({ method: "POST", url: url("responses"), headers: { ...headers, "content-type": "application/xml" }, payload: "<request/>" });
  assert.equal(media.statusCode, 415); assert.equal(media.json().error.type, "invalid_request_error");
});

test("SSE drain waits release all listeners on completion and cancellation", async () => {
  for (const cancel of [false, true]) {
    const raw = Object.assign(new EventEmitter(), { destroyed: false, write: () => false });
    const controller = new AbortController();
    const writing = writeSse({ raw } as any, "frame", controller.signal);
    assert.equal(raw.listenerCount("drain"), 1);
    if (cancel) { controller.abort(); await assert.rejects(writing); } else { raw.emit("drain"); await writing; }
    for (const name of ["drain", "close", "error"]) assert.equal(raw.listenerCount(name), 0);
  }
});

test("worker rejects missing, truncated, duplicate and failed terminal records", async () => {
  const ready = { type: "ready" }, result = { type: "result", result: { text: "Hello", finishReason: "stop", usage } };
  for (const records of [[ready], [ready, result, result], [ready, { type: "failure" }, result], [ready, { ...result, result: { ...result.result, usage: { input: -1 } } }]]) {
    const script = `process.stdin.resume(); process.stdin.on('end',()=>{for(const value of ${JSON.stringify(records)}) console.log(${JSON.stringify(WORKER_EVENT_PREFIX)}+JSON.stringify(value));});`;
    await assert.rejects(executeWorker(process.execPath, ["-e", script], { cwd: process.cwd(), env: process.env }, normalized(), async () => {}, new AbortController().signal));
  }
  const script = `console.log(${JSON.stringify(WORKER_EVENT_PREFIX + JSON.stringify(ready))});process.stdout.write(${JSON.stringify(WORKER_EVENT_PREFIX + JSON.stringify(result))});`;
  await assert.rejects(executeWorker(process.execPath, ["-e", script], { cwd: process.cwd(), env: process.env }, normalized(), async () => {}, new AbortController().signal));
});

test("worker cancellation terminates an active process", async () => {
  const controller = new AbortController();
  const result = executeWorker(process.execPath, ["-e", `console.log(${JSON.stringify(WORKER_EVENT_PREFIX)}+JSON.stringify({type:'ready'})); process.stdin.resume(); setInterval(()=>{},1000);`], { cwd: process.cwd(), env: process.env }, normalized(), async () => controller.abort(), controller.signal);
  await assert.rejects(result, (error: any) => error.name === "AbortError");
});
