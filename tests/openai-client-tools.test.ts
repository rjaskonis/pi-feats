import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import Fastify from "fastify";
import { ClientToolsRuntime } from "../extensions/api-server/openai-client-runtime.ts";
import { acceptedClientTools, clientToolPolicy, ensureInitialClientRequest, fingerprint, normalizeClientRequest } from "../extensions/api-server/openai-client-contract.ts";
import { registerCompatibilityRoutes } from "../extensions/api-server/openai-routes.ts";
import { pngDataUrl } from "./fixtures/openai-attachments.ts";

const settings = () => ({ defaultProvider: "fixture", defaultModel: "fixture", profile: { clientTools: { enabled: true, allowedTools: ["view_file"], timeoutMs: 5000 } } });
const tool = { type: "function", name: "view_file", description: "Read client file", parameters: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] } };
const initial = (profile = "support", stream = false) => ({ model: profile, tools: [tool, { type: "function", name: "bash", parameters: { type: "object" } }], input: "Read file", stream });
async function harness(t: any, mode?: string) {
  let config: any = settings(), launches = 0;
  const runtime = new ClientToolsRuntime({ settings: async () => config, maxWorkers: 2, perProfile: 1, launch: () => { launches++; return { command: process.execPath, args: [resolve("tests/fixtures/openai-client-worker.mjs")], cwd: process.cwd(), env: { CLIENT_FIXTURE_MODE: mode } }; } });
  const app = Fastify(); t.after(async () => { await runtime.close(); await app.close(); });
  registerCompatibilityRoutes(app, { clientTools: runtime, authorized: (header) => header === "Bearer test", profiles: async () => [{ name: "support" }], validateProfile: async () => {}, execute: async (request, emit) => { await emit({ type: "ready" }); await emit({ type: "text", delta: "Legacy unchanged" }); return { text: "Legacy unchanged", finishReason: "stop", usage: { input: 1, output: 1, cached: 0, reasoning: 0 } }; } });
  const send = (payload: unknown, authorization = "Bearer test") => app.inject({ method: "POST", url: "/v1/responses", headers: { authorization }, payload: payload as any });
  return { runtime, app, send, config: (value: any) => { config = value; }, launches: () => launches };
}
function continuation(call: any, text = "DOCUMENT_TOKEN", extra: Record<string, unknown> = {}) { return { model: "support", tools: [tool], input: [{ role: "user", content: "Read file" }, call, { type: "function_call_output", call_id: call.call_id, output: [{ type: "input_text", text }], status: "completed", files: [], embeds: [] }], ...extra }; }
function terminal(payload: string) { return payload.split("\n\n").filter((frame) => frame.includes("data: ")).map((frame) => JSON.parse(frame.split("data: ")[1])).find((event) => event.type === "response.completed")?.response; }

test("client policy is default-off and validates bounded explicit approvals", () => {
  assert.equal(clientToolPolicy({}).enabled, false);
  assert.equal(clientToolPolicy(settings()).enabled, true);
  for (const value of [{ enabled: "yes" }, { allowedTools: ["client__read"] }, { allowedTools: ["*"] }, { timeoutMs: 1 }, { maxCalls: 100 }]) assert.throws(() => clientToolPolicy({ profile: { clientTools: value } }));
});
test("only approved function schemas are accepted; external references and schema bombs fail", () => {
  const policy = clientToolPolicy(settings());
  assert.deepEqual(acceptedClientTools([tool, { type: "function", name: "bash" }, { type: "web_search" }], policy).map((item) => item.name), ["view_file"]);
  assert.equal(acceptedClientTools([{ type: "function", function: { name: tool.name, parameters: tool.parameters } }], policy)[0].name, tool.name);
  assert.throws(() => acceptedClientTools([tool, tool], policy));
  assert.throws(() => acceptedClientTools([{ ...tool, parameters: { type: "object", properties: { value: { $ref: "https://example.com/schema" } } } }], policy));
  let deep: any = {}; for (let i = 0; i < 30; i++) deep = { properties: { child: deep } };
  assert.throws(() => acceptedClientTools([{ ...tool, parameters: { type: "object", ...deep } }], policy));
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
});
test("structured client outputs and history are bounded and never impersonate internal tools", () => {
  const policy = clientToolPolicy(settings());
  const parsed = normalizeClientRequest({ ...initial(), input: [{ type: "function_call_output", call_id: "call_one", output: [{ type: "input_text", text: "Extracted PDF text" }, { type: "input_image", image_url: pngDataUrl }], status: "failed" }] }, policy);
  assert.equal(parsed.outputs[0].failed, true); assert.equal(parsed.outputs[0].attachments.length, 1);
  assert.equal(parsed.request.messages.length, 0);
  assert.throws(() => ensureInitialClientRequest(parsed));
  for (const call_id of [123, "", "x".repeat(257)]) assert.throws(() => normalizeClientRequest({ ...initial(), input: [{ type: "function_call_output", call_id, output: "value" }] }, policy));
  assert.throws(() => normalizeClientRequest({ ...initial(), input: [{ type: "function_call", name: "read", call_id: "one", arguments: "{}" }] }, policy));
  assert.throws(() => normalizeClientRequest({ ...initial(), input: [{ type: "function_call_output", call_id: "one", output: "x".repeat(100001) }] }, policy));
  const call = { type: "function_call", call_id: "old_call", name: "view_file", arguments: '{"file_id":"old"}' };
  const history = [{ role: "user", content: "Earlier" }, call, { type: "function_call_output", call_id: "old_call", output: "Old document" }];
  assert.throws(() => ensureInitialClientRequest(normalizeClientRequest({ ...initial(), input: [...history, { role: "user", content: [{ type: "input_image", image_url: pngDataUrl }] }] }, policy)));
  ensureInitialClientRequest(normalizeClientRequest({ ...initial(), input: [...history, { role: "assistant", content: [{ type: "output_text", text: "Earlier answer" }] }, { role: "user", content: "New question" }] }, policy));
});
test("disabled and inapplicable profiles keep legacy responses and ignore client preferences", async (t) => {
  const h = await harness(t); h.config({});
  const response = await h.send({ ...initial(), tools: "previously ignored", tool_choice: "required", temperature: 0 });
  assert.equal(response.statusCode, 200); assert.equal(response.json().output[0].content[0].text, "Legacy unchanged");
  assert.deepEqual(response.json().tools, []); assert.equal(h.launches(), 0);
  h.config(settings());
  assert.equal((await h.send({ model: "support", input: "Text only" })).statusCode, 200);
  assert.equal((await h.send({ ...initial(), tools: [{ type: "function", name: "unapproved" }] })).statusCode, 200);
  assert.equal(h.launches(), 0);
  const chat = await h.app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer test" }, payload: { model: "support", messages: [{ role: "user", content: "Hello" }], tools: [tool] } });
  assert.equal(chat.statusCode, 200); assert.equal(chat.json().choices[0].message.content, "Legacy unchanged"); assert.equal(h.launches(), 0);
  assert.equal((await h.send(initial(), "Bearer wrong")).statusCode, 401);
});
for (const stream of [false, true]) test(`Responses JSON/SSE delegated calls settle and resume without fake text (stream=${stream})`, async (t) => {
  const h = await harness(t);
  const first = await h.send(initial("support", stream)); assert.equal(first.statusCode, 200, first.payload);
  const result = stream ? terminal(first.payload) : first.json();
  assert.equal(result.output.length, 1); const call = result.output[0]; assert.equal(call.type, "function_call"); assert.equal(call.name, "view_file");
  if (stream) { assert.ok(first.payload.includes("response.function_call_arguments.delta")); assert.ok(!first.payload.includes("response.content_part.added")); }
  const wrong = await h.send(continuation(call, "value", { model: "different" })); assert.equal(wrong.statusCode, 409);
  const changed = await h.send(continuation(call, "value", { input: [{ role: "user", content: "Changed original" }, call, { type: "function_call_output", call_id: call.call_id, output: "value" }] })); assert.equal(changed.statusCode, 409);
  const final = await h.send(continuation(call, "DOCUMENT_TOKEN", { stream })); assert.equal(final.statusCode, 200, final.payload);
  const answer = stream ? terminal(final.payload) : final.json();
  assert.equal(answer.output[0].content[0].text, "Client document: DOCUMENT_TOKEN");
  assert.equal(result.usage.input_tokens + answer.usage.input_tokens, 30);
  assert.equal(result.usage.output_tokens + answer.usage.output_tokens, 5);
  assert.equal(h.launches(), 1); assert.equal(h.runtime.size, 0);
  const replay = await h.send(continuation(call)); assert.equal(replay.statusCode, 409); assert.equal(h.launches(), 1);
});
test("duplicate, forged, changed-schema and concurrent resumes cannot start replacement work", async (t) => {
  const h = await harness(t), first = await h.send(initial()), call = first.json().output[0];
  const changedSchema = await h.send(continuation(call, "x", { tools: [{ ...tool, description: "Changed" }] })); assert.equal(changedSchema.statusCode, 409);
  const malformed = await h.send(continuation(call, "x", { input: [call, { type: "function_call_output", call_id: call.call_id, output: "x" }, { type: "function_call_output", call_id: call.call_id, output: "x" }] })); assert.equal(malformed.statusCode, 400);
  const unknown = await h.send(continuation({ ...call, call_id: "call_" + "f".repeat(32) })); assert.equal(unknown.statusCode, 409);
  const extra = await h.send(continuation(call, "x", { input: [call, { type: "function_call_output", call_id: call.call_id, output: "x" }, { type: "function_call_output", call_id: "unissued_call", output: "must not be ignored" }] })); assert.equal(extra.statusCode, 409);
  const one = h.send(continuation(call)); await new Promise((resolve) => setTimeout(resolve, 10));
  const two = await h.send(continuation(call)); assert.equal(two.statusCode, 409);
  assert.equal((await one).statusCode, 200); assert.equal(h.launches(), 1);
});
test("worker-side result validation can be corrected without replaying the agent", async (t) => {
  const h = await harness(t), call = (await h.send(initial())).json().output[0];
  const error = await h.send(continuation(call, "reject-image")); assert.equal(error.statusCode, 400); assert.equal(error.json().error.code, "image_input_disabled");
  assert.equal((await h.send(continuation(call))).statusCode, 200); assert.equal(h.launches(), 1);
});
test("policy revocation, capacities and expiry release waiting workers", { timeout: 15000 }, async (t) => {
  const h = await harness(t), call = (await h.send(initial())).json().output[0];
  assert.equal((await h.send(initial())).statusCode, 429);
  h.config({ ...settings(), profile: { clientTools: { enabled: false, allowedTools: ["view_file"] } } });
  assert.equal((await h.send(continuation(call))).statusCode, 400);
  for (let i = 0; h.runtime.size && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.runtime.size, 0);
  h.config(settings()); const nextCall = (await h.send(initial())).json().output[0];
  await new Promise((resolve) => setTimeout(resolve, 5300));
  assert.equal((await h.send(continuation(nextCall))).statusCode, 409); assert.equal(h.runtime.size, 0);
});
test("aborted policy lookup cannot spawn an orphan worker", async () => {
  let release!: () => void, launched = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = new ClientToolsRuntime({ settings: async () => { await gate; return settings(); }, launch: () => { launched = true; throw new Error("Must not launch"); } });
  const input = normalizeClientRequest(initial(), clientToolPolicy(settings()));
  const controller = new AbortController();
  const run = runtime.execute(input, async () => {}, controller.signal);
  controller.abort(); release();
  await assert.rejects(run); assert.equal(launched, false); assert.equal(runtime.size, 0);
  await runtime.close();
});
test("global capacity and cross-conversation outputs remain isolated", async (t) => {
  const h = await harness(t), one = (await h.send(initial())).json().output[0], two = (await h.send(initial("other"))).json().output[0];
  assert.notEqual(one.call_id, two.call_id);
  assert.equal((await h.send(initial("third"))).statusCode, 429);
  const mixed = await h.send({ model: "support", tools: [tool], input: [{ type: "function_call_output", call_id: one.call_id, output: "one" }, { type: "function_call_output", call_id: two.call_id, output: "two" }] });
  assert.equal(mixed.statusCode, 400); assert.equal(h.launches(), 2);
  await h.runtime.close(); assert.equal(h.runtime.size, 0);
});
test("disconnect before the handoff finishes cancels its worker", async (t) => {
  const h = await harness(t, "delayed-yield");
  await h.app.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${(h.app.server.address() as { port: number }).port}/v1/responses`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify(initial("support", true)), signal: controller.signal });
  assert.equal(response.status, 200); controller.abort();
  for (let i = 0; h.runtime.size && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.runtime.size, 0); assert.equal(h.launches(), 1);
  h.app.server.closeAllConnections();
});
test("provider diagnostics and worker failures are not exposed", async (t) => {
  const h = await harness(t, "failure"), result = await h.send(initial());
  assert.equal(result.statusCode, 502); assert.ok(!result.payload.includes("PRIVATE_PROVIDER_SECRET"));
});
