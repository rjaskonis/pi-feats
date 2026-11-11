import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { proxyError, proxyPiRequest } from "../extensions/pi-console-webui/lib/api-proxy.ts";
import { registerCompatibilityRoutes } from "../extensions/api-server/openai-routes.ts";

test("Console proxy preserves SSE, streams immediately and cancels upstream on body cancellation", { timeout: 10_000 }, async (t) => {
  let aborted!: () => void;
  const abortSeen = new Promise<void>((resolve) => { aborted = resolve; });
  const server = Fastify();
  registerCompatibilityRoutes(server, {
    authorized: (header) => header === "Bearer proxy-test", profiles: async () => [{ name: "support" }], validateProfile: async () => {},
    execute: async (_request, emit, signal) => {
      await emit({ type: "ready" }); await emit({ type: "text", delta: "First" });
      await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { aborted(); resolve(); }, { once: true }); });
      signal.throwIfAborted(); throw new Error("Unreachable");
    },
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { server.server.closeAllConnections(); await server.close(); });
  const apiUrl = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
  const response = await proxyPiRequest(new Request("http://console/api/pi/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "support", input: "Hello", stream: true }) }), ["v1", "responses"], { apiUrl, apiToken: "proxy-test" });
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  assert.equal(response.headers.get("x-accel-buffering"), "no"); assert.match(response.headers.get("cache-control")!, /no-transform/);
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /response.created/);
  await reader.cancel(); await abortSeen;
});

test("Console proxy maps legacy and v1 paths, query strings and compatible errors", async (t) => {
  const server = Fastify();
  server.get("/*", async (request) => ({ url: request.url, auth: request.headers.authorization }));
  await server.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { server.server.closeAllConnections(); await server.close(); });
  const config = { apiUrl: `http://127.0.0.1:${(server.server.address() as { port: number }).port}`, apiToken: "proxy-test" };
  for (const [path, expected] of [[["v1", "models"], "/v1/models?q=1"], [["profile", "support"], "/profile/support?q=1"], [["sessions"], "/api/sessions?q=1"]] as Array<[string[], string]>) {
    const response = await proxyPiRequest(new Request("http://console/api/pi/anything?q=1"), path, config);
    const value = await response.json(); assert.equal(value.url, expected); assert.equal(value.auth, "Bearer proxy-test");
  }
  assert.equal((await proxyError(["v1"], "Unauthorized", 401, "invalid_api_key").json()).error.type, "authentication_error");
  assert.equal((await proxyError(["sessions"], "Unauthorized", 401, "invalid_api_key").json()).error, "Unauthorized");
  const unavailable = await proxyPiRequest(new Request("http://console/api/pi/v1/models"), ["v1", "models"], { ...config, apiToken: "" });
  assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).error.type, "server_error");
  const oversized = await proxyPiRequest(new Request("http://console/api/pi/v1/responses", { method: "POST", body: "x".repeat(1_048_577) }), ["v1", "responses"], config);
  assert.equal(oversized.status, 413); assert.equal((await oversized.json()).error.code, "request_too_large");
});
