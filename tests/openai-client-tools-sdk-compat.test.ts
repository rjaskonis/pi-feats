import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import Fastify from "fastify";
import { ClientToolsRuntime } from "../extensions/api-server/openai-client-runtime.ts";
import { registerCompatibilityRoutes } from "../extensions/api-server/openai-routes.ts";

test("official JavaScript and Python Responses SDKs accumulate delegated calls and continue them", { timeout: 30_000 }, async (t) => {
  let OpenAI: any;
  try { OpenAI = (await import("openai")).default; } catch { t.skip("Optional JavaScript OpenAI SDK is unavailable."); return; }
  const runtime = new ClientToolsRuntime({ settings: async () => ({ defaultProvider: "fixture", defaultModel: "fixture", profile: { clientTools: { enabled: true, allowedTools: ["view_file"] } } }), launch: () => ({ command: process.execPath, args: [resolve("tests/fixtures/openai-client-worker.mjs")], cwd: process.cwd(), env: {} }) });
  const app = Fastify();
  registerCompatibilityRoutes(app, { clientTools: runtime, authorized: (header) => header === "Bearer local-client-tools", profiles: async () => [{ name: "support" }], validateProfile: async () => {}, execute: async () => { throw new Error("Unexpected legacy execution"); } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await runtime.close(); app.server.closeAllConnections(); await app.close(); });
  const baseURL = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/v1`;
  const client = new OpenAI({ baseURL, apiKey: "local-client-tools", maxRetries: 0 });
  const tools = [{ type: "function", name: "view_file", parameters: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] } }];
  for (const stream of [false, true]) {
    const request = { model: "support", input: "Read file", tools };
    let first;
    if (stream) {
      const incoming = client.responses.stream(request); const events: any[] = [];
      for await (const event of incoming) events.push(event);
      first = await incoming.finalResponse();
      assert.ok(events.some((event) => event.type === "response.function_call_arguments.done"));
    } else first = await client.responses.create(request);
    assert.equal(first.output_text, ""); assert.equal(first.output[0].name, "view_file");
    const input = [{ role: "user", content: "Read file" }, ...first.output, { type: "function_call_output", call_id: first.output[0].call_id, output: "SDK_DOCUMENT" }];
    const final = stream ? await client.responses.stream({ model: "support", input, tools }).finalResponse() : await client.responses.create({ model: "support", input, tools });
    assert.equal(final.output_text, "Client document: SDK_DOCUMENT"); assert.equal(first.usage.input_tokens + final.usage.input_tokens, 30);
  }
  const script = `import sys,json
try:
 import openai
except ImportError:
 sys.exit(77)
c=openai.OpenAI(base_url=sys.argv[1],api_key="local-client-tools",max_retries=0)
tools=[{"type":"function","name":"view_file","parameters":{"type":"object","properties":{"file_id":{"type":"string"}},"required":["file_id"]}}]
for streaming in [False,True]:
 if streaming:
  with c.responses.stream(model="support",input="Read file",tools=tools) as stream:
   events=list(stream)
   first=stream.get_final_response()
   assert any(e.type=="response.function_call_arguments.done" for e in events)
 else:
  first=c.responses.create(model="support",input="Read file",tools=tools)
 assert first.output_text==""
 call=first.output[0]
 assert call.type=="function_call" and call.name=="view_file"
 follow=[{"role":"user","content":"Read file"},call.model_dump(exclude_none=True),{"type":"function_call_output","call_id":call.call_id,"output":[{"type":"input_text","text":"PYTHON_DOCUMENT"}]}]
 if streaming:
  with c.responses.stream(model="support",input=follow,tools=tools) as stream:
   list(stream)
   final=stream.get_final_response()
 else:
  final=c.responses.create(model="support",input=follow,tools=tools)
 assert final.output_text=="Client document: PYTHON_DOCUMENT"
 assert first.usage.input_tokens+final.usage.input_tokens==30
print(json.dumps({"python_sdk":openai.__version__}))
`;
  const child = spawn("python", ["-c", script, baseURL], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  if (code === 77) t.diagnostic("Optional Python SDK unavailable; Python compatibility was not tested.");
  else { assert.equal(code, 0, stderr); t.diagnostic(stdout.trim()); }
});
