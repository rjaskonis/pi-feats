import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { classifyProviderFailure, errorBody, providerFailure } from "../extensions/api-server/openai-errors.ts";
import { normalizeRequest } from "../extensions/api-server/openai-contract.ts";
import { executeSession, executeWorker, WORKER_EVENT_PREFIX } from "../extensions/api-server/openai-execution.ts";
import { registerCompatibilityRoutes } from "../extensions/api-server/openai-routes.ts";
import { ClientToolsRuntime } from "../extensions/api-server/openai-client-runtime.ts";

for (const stream of [false, true]) test(`client-tool Responses ${stream ? "SSE" : "JSON"} preserves provider authentication errors`, async (t) => {
  const script = `process.stdin.once('data',()=>{for(const value of [{type:'ready'},{type:'failure',code:'provider_authentication_failed',message:'PRIVATE_TOKEN_MARKER'}])console.log('PI_OPENAI_EVENT:'+JSON.stringify(value));});`;
  const client = new ClientToolsRuntime({ settings: async () => ({ profile: { clientTools: { enabled: true, allowedTools: ["view_file"] } } }), launch: () => ({ command: process.execPath, args: ["-e", script], cwd: process.cwd(), env: {} }) });
  const server = Fastify();
  registerCompatibilityRoutes(server, { clientTools: client, authorized: value => value === "Bearer local", profiles: async () => [{ name: "support" }], validateProfile: async () => {}, execute: async () => { throw Error("Unexpected ordinary execution"); } });
  t.after(async () => { await client.close(); await server.close(); });
  const result = await server.inject({ method: "POST", url: "/v1/responses", headers: { authorization: "Bearer local" }, payload: { model: "support", input: "Hello", stream, tools: [{ type: "function", name: "view_file", parameters: { type: "object", properties: {} } }] } });
  assert.equal(result.statusCode, stream ? 200 : 424);
  assert.ok(result.body.includes('"code":"provider_authentication_failed"'));
  assert.ok(result.body.includes('"type":"authentication_error"'));
  assert.ok(!result.body.includes("PRIVATE_TOKEN_MARKER"));
  if (stream) assert.ok(result.body.includes("response.failed"));
});

const privateError = 'OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (401): {"refresh_token":"PRIVATE_TOKEN_MARKER"}';
const request = normalizeRequest({ model: "support", input: "Hello" }, "responses");
function session(mode: "event" | "ledger" | "throw" = "event") {
  let listener = (_event: any) => {}, disposed = false;
  const message = { role: "assistant", content: [], stopReason: "error", errorMessage: privateError };
  return {
    messages: mode === "ledger" ? [message] : undefined,
    subscribe(fn: any) { listener = fn; return () => {}; },
    async prompt() { if (mode === "throw") throw new Error(privateError); if (mode === "event") listener({ type: "message_end", message }); },
    async waitForIdle() {}, async abort() {}, dispose() { disposed = true; },
    get disposed() { return disposed; },
  };
}

test("classifies SDK credential failures without forwarding provider diagnostics", () => {
  for (const error of [privateError, new Error(privateError), { status: 401, message: "PRIVATE_TOKEN_MARKER" }, "401 Unauthorized", "No API key found for openai", "Incorrect API key provided: PRIVATE_TOKEN_MARKER", "OAuth refresh failed: invalid_grant"]) {
    const failure = classifyProviderFailure(error)!;
    assert.equal(failure.code, "provider_authentication_failed");
    assert.equal(failure.status, 424);
    assert.equal(errorBody(failure).error.type, "authentication_error");
    assert.ok(!JSON.stringify(errorBody(failure)).includes("PRIVATE_TOKEN_MARKER"));
  }
  for (const error of ["500 Internal server error", "OAuth refresh failed (503): unavailable", "429 quota exceeded", "403 permission denied for this model", "Request aborted", "Network timeout", undefined]) assert.equal(classifyProviderFailure(error), undefined);
  assert.equal(providerFailure("PRIVATE_TOKEN_MARKER"), undefined);
});

for (const mode of ["event", "ledger", "throw"] as const) test(`executor preserves authentication failures from ${mode} and disposes the session`, async () => {
  const value = session(mode);
  await assert.rejects(executeSession(value as any, request, () => {}, new AbortController().signal), (error: any) => error.status === 424 && error.code === "provider_authentication_failed" && !error.message.includes("PRIVATE_TOKEN_MARKER"));
  assert.ok(value.disposed);
});

test("dedicated worker reconstructs only the allowlisted authentication error", async () => {
  const code = `process.stdin.resume();process.stdin.on('end',()=>{console.error('PRIVATE_TOKEN_MARKER');for(const value of [{type:'ready'},{type:'failure',code:'provider_authentication_failed',message:'PRIVATE_TOKEN_MARKER'}])console.log(${JSON.stringify(WORKER_EVENT_PREFIX)}+JSON.stringify(value));});`;
  await assert.rejects(executeWorker(process.execPath, ["-e", code], { cwd: process.cwd(), env: process.env }, request, async () => {}, new AbortController().signal), (error: any) => error.status === 424 && error.code === "provider_authentication_failed" && !error.message.includes("PRIVATE_TOKEN_MARKER"));
});

for (const protocol of ["chat", "responses"] as const) for (const stream of [false, true]) test(`${protocol} ${stream ? "SSE" : "JSON"} exposes safe provider auth errors, distinct from API bearer errors`, async (t) => {
  const server = Fastify();
  registerCompatibilityRoutes(server, {
    authorized: value => value === "Bearer local",
    profiles: async () => [{ name: "support" }], validateProfile: async () => {},
    execute: async (input, emit, signal) => executeSession(session() as any, input, event => { void emit(event); }, signal),
  });
  t.after(() => server.close());
  const url = protocol === "chat" ? "/v1/chat/completions" : "/v1/responses";
  const payload = { model: "support", stream, ...(protocol === "chat" ? { messages: [{ role: "user", content: "Hello" }] } : { input: "Hello" }) };
  const result = await server.inject({ method: "POST", url, headers: { authorization: "Bearer local" }, payload });
  assert.equal(result.statusCode, stream ? 200 : 424);
  assert.ok(result.body.includes('"code":"provider_authentication_failed"'));
  assert.ok(result.body.includes('"type":"authentication_error"'));
  assert.ok(!result.body.includes("PRIVATE_TOKEN_MARKER"));
  if (stream && protocol === "responses") assert.ok(result.body.includes("response.failed"));
  const invalid = await server.inject({ method: "POST", url, payload });
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.json().error.code, "invalid_api_key");
});
