import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { classifyProviderFailure, errorBody, providerFailure, CompatibilityError } from "../extensions/api-server/openai-errors.ts";
import { normalizeRequest } from "../extensions/api-server/openai-contract.ts";
import { executeSession, executeWorker } from "../extensions/api-server/openai-execution.ts";
import { registerCompatibilityRoutes } from "../extensions/api-server/openai-routes.ts";
import { ClientToolsRuntime } from "../extensions/api-server/openai-client-runtime.ts";

const code = "provider_usage_limit_exceeded", privateMessage = "Codex error: The usage limit has been reached PRIVATE_PROVIDER_MARKER";
const request = normalizeRequest({ model: "support", input: "Hello" }, "responses");
function session(mode: "event" | "ledger" | "throw" = "event") {
  let listener = (_event: any) => {}, disposed = false;
  const message = { role: "assistant", content: [], stopReason: "error", errorMessage: privateMessage };
  return {
    messages: mode === "ledger" ? [message] : undefined,
    subscribe(fn: any) { listener = fn; return () => {}; },
    async prompt() { if (mode === "throw") throw new Error(privateMessage); if (mode === "event") listener({ type: "message_end", message }); },
    async waitForIdle() {}, async abort() {}, dispose() { disposed = true; },
    get disposed() { return disposed; },
  };
}
const check = (error: any) => error.status === 429 && error.code === code && !error.message.includes("PRIVATE_PROVIDER_MARKER");

test("classifies explicit provider usage limits, not arbitrary throttling or unrelated failures", () => {
  for (const error of [privateMessage, new Error(privateMessage), "You have hit your ChatGPT usage limit (pro plan). Try again in ~5 min.", "429 quota exceeded", "You exceeded your current quota PRIVATE_PROVIDER_MARKER", { code: "usage_limit_reached", message: "PRIVATE_PROVIDER_MARKER" }, { code: "insufficient_quota" }, "usage_not_included", "quota_exceeded"]) {
    const failure = classifyProviderFailure(error)!;
    assert.ok(check(failure));
    assert.equal(errorBody(failure).error.type, "rate_limit_error");
    assert.ok(!JSON.stringify(errorBody(failure)).includes("PRIVATE_PROVIDER_MARKER"));
  }
  for (const error of ["429 too many requests", { status: 429 }, "503 unavailable", "OAuth refresh failed (503)", "403 model denied", "usage limit configuration", "Request aborted", undefined, new CompatibilityError("Quota reached")]) assert.equal(classifyProviderFailure(error), undefined);
  assert.equal(classifyProviderFailure({ status: 401, message: privateMessage })?.code, "provider_authentication_failed");
  assert.equal(providerFailure("PRIVATE_PROVIDER_MARKER"), undefined);
});
for (const mode of ["event", "ledger", "throw"] as const) test(`executor preserves safe usage limits from ${mode}`, async () => {
  const value = session(mode);
  await assert.rejects(executeSession(value as any, request, () => {}, new AbortController().signal), check);
  assert.ok(value.disposed);
});
const frames = [{ type: "ready" }, { type: "failure", code, message: "PRIVATE_PROVIDER_MARKER" }];
test("dedicated worker reconstructs only the allowlisted usage error", async () => {
  const script = `process.stdin.resume();process.stdin.on('end',()=>{for(const value of ${JSON.stringify(frames)})console.log('PI_OPENAI_EVENT:'+JSON.stringify(value));});`;
  await assert.rejects(executeWorker(process.execPath, ["-e", script], { cwd: process.cwd(), env: process.env }, request, async () => {}, new AbortController().signal), check);
});
for (const protocol of ["chat", "responses"] as const) for (const stream of [false, true]) test(`${protocol} ${stream ? "SSE" : "JSON"} preserves safe usage limits`, async (t) => {
  const server = Fastify();
  registerCompatibilityRoutes(server, { authorized: value => value === "Bearer local", profiles: async () => [{ name: "support" }], validateProfile: async () => {}, execute: async (input, emit, signal) => executeSession(session() as any, input, event => { void emit(event); }, signal) });
  t.after(() => server.close());
  const result = await server.inject({ method: "POST", url: protocol === "chat" ? "/v1/chat/completions" : "/v1/responses", headers: { authorization: "Bearer local" }, payload: { model: "support", stream, ...(protocol === "chat" ? { messages: [{ role: "user", content: "Hello" }] } : { input: "Hello" }) } });
  assert.equal(result.statusCode, stream ? 200 : 429);
  assert.ok(result.body.includes(`"code":"${code}"`));
  assert.ok(result.body.includes('"type":"rate_limit_error"'));
  assert.ok(!result.body.includes("PRIVATE_PROVIDER_MARKER"));
  if (stream && protocol === "responses") assert.ok(result.body.includes("response.failed"));
});
for (const stream of [false, true]) test(`client-tool ${stream ? "SSE" : "JSON"} preserves safe usage limits`, async (t) => {
  const script = `process.stdin.once('data',()=>{for(const value of ${JSON.stringify(frames)})console.log('PI_OPENAI_EVENT:'+JSON.stringify(value));});`;
  const client = new ClientToolsRuntime({ settings: async () => ({ profile: { clientTools: { enabled: true, allowedTools: ["view_file"] } } }), launch: () => ({ command: process.execPath, args: ["-e", script], cwd: process.cwd(), env: {} }) });
  const server = Fastify();
  registerCompatibilityRoutes(server, { clientTools: client, authorized: value => value === "Bearer local", profiles: async () => [{ name: "support" }], validateProfile: async () => {}, execute: async () => { throw Error("Unexpected ordinary execution"); } });
  t.after(async () => { await client.close(); await server.close(); });
  const result = await server.inject({ method: "POST", url: "/v1/responses", headers: { authorization: "Bearer local" }, payload: { model: "support", input: "Hello", stream, tools: [{ type: "function", name: "view_file", parameters: { type: "object", properties: {} } }] } });
  assert.equal(result.statusCode, stream ? 200 : 429);
  assert.ok(result.body.includes(`"code":"${code}"`));
  assert.ok(result.body.includes('"type":"rate_limit_error"'));
  assert.ok(!result.body.includes("PRIVATE_PROVIDER_MARKER"));
});
