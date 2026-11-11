import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import Fastify from "fastify";
import { registerCompatibilityRoutes } from "../extensions/api-server/openai-routes.ts";

// SDKs are optional test-only dependencies. No package installation or paid calls.
test("official JavaScript and Python SDK JSON, SSE and Responses accumulation", { timeout: 30_000 }, async (t) => {
  let OpenAI: any;
  try { OpenAI = (await import("openai")).default; } catch { t.skip("The optional openai JavaScript SDK is unavailable."); return; }
  const server = Fastify();
  registerCompatibilityRoutes(server, {
    authorized: (header) => header === "Bearer sdk-local-test",
    profiles: async () => [{ name: "support" }], validateProfile: async () => {},
    execute: async (request, emit, signal) => {
      await emit({ type: "ready" }); await emit({ type: "text", delta: "Hello" });
      if (request.messages.at(-1)?.content === "Fail") throw new Error("Internal fixture failure");
      await new Promise((resolve) => setTimeout(resolve, 10)); signal.throwIfAborted();
      await emit({ type: "text", delta: " SDK" });
      return { text: "Hello SDK", finishReason: "stop", usage: { input: 20, output: 4, cached: 3, reasoning: 1 } };
    },
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { server.server.closeAllConnections(); await server.close(); });
  const baseURL = `http://127.0.0.1:${(server.server.address() as { port: number }).port}/v1`;
  const client = new OpenAI({ apiKey: "sdk-local-test", baseURL });
  const messages = [{ role: "user", content: "Hello" }];
  assert.equal((await client.models.list()).data[0].id, "support");
  assert.equal((await client.chat.completions.create({ model: "support", messages })).choices[0].message.content, "Hello SDK");
  let text = "", tokens = 0;
  for await (const chunk of await client.chat.completions.create({ model: "support", messages, stream: true, stream_options: { include_usage: true } })) {
    text += chunk.choices[0]?.delta.content ?? ""; if (chunk.usage) tokens = chunk.usage.total_tokens;
  }
  assert.equal(text, "Hello SDK"); assert.equal(tokens, 24);
  assert.equal((await client.responses.create({ model: "support", input: "Hello", store: false })).output_text, "Hello SDK");
  const stream = client.responses.stream({ model: "support", input: "Hello", store: false });
  let deltas = 0; for await (const event of stream) if (event.type === "response.output_text.delta") deltas++;
  const final = await stream.finalResponse();
  assert.equal(final.output_text, "Hello SDK"); assert.equal(final.usage.total_tokens, 24); assert.equal(deltas, 2);
  await assert.rejects(async () => {
    for await (const _chunk of await client.chat.completions.create({ model: "support", messages: [{ role: "user", content: "Fail" }], stream: true })) { /* Consume until the error frame. */ }
  }, (error: any) => error.message.includes("Pi execution failed"));
  const failedStream = client.responses.stream({ model: "support", input: "Fail" });
  assert.equal((await failedStream.finalResponse()).status, "failed");
  const script = `import sys, json
try:
 import openai
except ImportError:
 sys.exit(77)
c = openai.OpenAI(api_key="sdk-local-test", base_url=sys.argv[1])
assert c.models.list().data[0].id == "support"
messages=[{"role":"user","content":"Hello"}]
assert c.chat.completions.create(model="support", messages=messages).choices[0].message.content == "Hello SDK"
chunks=list(c.chat.completions.create(model="support", messages=messages, stream=True, stream_options={"include_usage":True}))
assert "".join(x.choices[0].delta.content or "" for x in chunks if x.choices) == "Hello SDK"
assert chunks[-1].usage.total_tokens == 24
assert c.responses.create(model="support", input="Hello", store=False).output_text == "Hello SDK"
with c.responses.stream(model="support", input="Hello", store=False) as stream:
 events=list(stream)
 final=stream.get_final_response()
 assert final.output_text == "Hello SDK"
 assert final.usage.total_tokens == 24
 assert sum(e.type == "response.output_text.delta" for e in events) == 2
try:
 list(c.chat.completions.create(model="support", messages=[{"role":"user","content":"Fail"}], stream=True))
 raise AssertionError("Expected a stream failure")
except openai.APIError:
 pass
with c.responses.stream(model="support", input="Fail") as stream:
 events=list(stream)
 assert any(e.type == "response.failed" and e.response.status == "failed" for e in events)
 assert not any(e.type == "response.completed" for e in events)
 try:
  stream.get_final_response()
  raise AssertionError("Expected the Python helper to reject a failed response")
 except RuntimeError:
  pass
print(json.dumps({"python_sdk":openai.__version__}))
`;
  const child = spawn("python", ["-c", script, baseURL], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (code === 77) t.diagnostic("Python SDK unavailable; Python compatibility was not tested.");
  else { assert.equal(code, 0, stderr); t.diagnostic(stdout.trim()); }
});
