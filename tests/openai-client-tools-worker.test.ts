import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import * as zlib from "node:zlib";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { ClientToolsRuntime } from "../extensions/api-server/openai-client-runtime.ts";
import { registerCompatibilityRoutes } from "../extensions/api-server/openai-routes.ts";
import { pngDataUrl } from "./fixtures/openai-attachments.ts";

const cli = process.env.PI_OPENAI_TEST_CLI;
for (const mode of ["parallel", "sequential", "codex", "blocked", "truncated", "collision", "failed"] as const) test(`Responses client file tools resume the same ${mode} Nono worker without replaying internal actions`, { skip: !cli, timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-client-worker-")), profile = join(root, "profiles", "support");
  await mkdir(profile, { recursive: true }); t.after(() => rm(root, { recursive: true, force: true }));
  const wireTool = mode === "collision" ? "internal_once" : "view_file";
  const policy = { enabled: true, allowedTools: [wireTool], timeoutMs: 30000 };
  const settings = { defaultProvider: "fixture", defaultModel: "fixture", defaultThinkingLevel: "off", transport: "sse", retry: { enabled: false }, compaction: { enabled: false }, sandbox: process.env.PI_OPENAI_TEST_NONO === "1", profile: { enabledTools: ["internal_once"], clientTools: policy } };
  await writeFile(join(profile, "settings.json"), JSON.stringify(settings));
  await writeFile(join(profile, "SOUL.md"), "Preserve the profile policy. Never expose internal tool output.");
  const fixture = join(root, "fixture.ts");
  await writeFile(fixture, `import {readFile,writeFile} from "node:fs/promises"; import {join} from "node:path";
export default function(pi) { ${mode === "failed" ? 'pi.on("tool_result",async(event,ctx)=>{if(event.toolName==="client__view_file"&&event.isError)await writeFile(join(ctx.cwd,"client-error.seen"),"yes");});' : ""} ${mode === "blocked" ? 'pi.on("tool_call",event=>{if(event.toolName==="client__view_file")return {block:true,reason:"Profile denied delegated tools"};});' : ""} pi.registerTool({ name:"internal_once",label:"Internal",description:"Internal action", ${mode === "sequential" ? 'executionMode:"sequential",' : ""} parameters:{type:"object",properties:{}}, async execute(_id,_args,_signal,_update,ctx) {const p=join(ctx.cwd,"once.count");let n=0;try{n=Number(await readFile(p,"utf8"));}catch{} await writeFile(p,String(n+1));return {content:[{type:"text",text:"PRIVATE_INTERNAL_VALUE"}],details:{}};}}); }`);
  const extensions = [resolve("extensions/profiles.ts"), resolve("extensions/api-server/index.ts"), resolve("extensions/guardrails/index.ts"), fixture];
  await writeFile(join(root, "settings.json"), JSON.stringify({ ...settings, extensions }));
  const calls: any[] = []; let providerError: unknown, historicalTurn = false;
  const provider = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const encoded = Buffer.concat(chunks);
      const raw = req.headers["content-encoding"] === "zstd" ? (zlib as any).zstdDecompressSync(encoded) : encoded;
      const body = JSON.parse(raw.toString()); calls.push(body);
      assert.ok(body.tools.some((tool: any) => (tool.function?.name ?? tool.name) === "internal_once"));
      assert.ok(body.tools.some((tool: any) => (tool.function?.name ?? tool.name) === "client__view_file"));
      assert.ok((body.instructions ?? body.messages?.[0].content).includes("Preserve the profile policy"));
      const finished = mode === "codex" ? body.input.filter((item: any) => item.type === "function_call_output") : body.messages.filter((message: any) => message.role === "tool");
      const toolCalls = ["internal_once", "client__view_file", "client__view_file"].map((name, index) => ({ index, id: `native_${index}`, type: "function", function: { name, arguments: JSON.stringify(index === 0 ? {} : { file_id: `doc_${index}` }) } }));
      if (finished.length) {
        assert.equal(finished.length, historicalTurn ? 2 : 3);
        if (historicalTurn) assert.ok(!JSON.stringify(finished).includes("PRIVATE_INTERNAL_VALUE"));
        if (mode === "blocked") assert.ok(JSON.stringify(finished).includes("Profile denied delegated tools"));
        else if (mode === "truncated") assert.ok(JSON.stringify(finished).includes("not executed"));
        else if (mode === "failed") assert.ok(JSON.stringify(finished).includes("CLIENT_FILE_ERROR"));
        else { assert.ok(JSON.stringify(finished).includes("Document token doc_1")); assert.ok(JSON.stringify(finished).includes("Document token doc_2")); }
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      if (mode === "codex") {
        frame({ type: "response.created", response: { id: `resp_${calls.length}`, status: "in_progress", output: [] } });
        let output: any[];
        if (!finished.length) {
          output = toolCalls.map((call, index) => ({ id: `fc_${index}`, type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: "completed" }));
          for (const [index, item] of output.entries()) {
            frame({ type: "response.output_item.added", output_index: index, item: { ...item, arguments: "", status: "in_progress" } });
            frame({ type: "response.function_call_arguments.delta", output_index: index, item_id: item.id, delta: item.arguments });
            frame({ type: "response.output_item.done", output_index: index, item });
          }
        } else {
          const images = finished.flatMap((item: any) => Array.isArray(item.output) ? item.output.filter((part: any) => part.type === "input_image") : []);
          assert.equal(images.length, 1); assert.equal(images[0].image_url, pngDataUrl);
          const item = { id: "msg_final", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Verified both client documents", annotations: [] }] };
          output = [item];
          frame({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } });
          frame({ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } });
          frame({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text });
          frame({ type: "response.output_item.done", output_index: 0, item });
        }
        frame({ type: "response.completed", response: { id: `resp_${calls.length}`, status: "completed", output, usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
        res.end(); return;
      }
      frame({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: finished.length ? { role: "assistant", content: mode === "blocked" ? "Profile denied delegated tools" : mode === "truncated" ? "Truncated calls were not executed" : mode === "failed" ? "Client file failed safely" : "Verified both client documents" } : { role: "assistant", tool_calls: toolCalls }, finish_reason: null }] });
      frame({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finished.length ? "stop" : mode === "truncated" ? "length" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
      res.end("data: [DONE]\n\n");
    } catch (error) { providerError = error; if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>((resolve) => provider.close(() => resolve())));
  const port = (provider.address() as { port: number }).port;
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { fixture: { api: mode === "codex" ? "openai-codex-responses" : "openai-completions", apiKey: mode === "codex" ? `e30=.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64")}.test` : "local-test", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "fixture", name: "Fixture", reasoning: false, input: mode === "codex" ? ["text"] : ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] } } }));
  const runtime = new ClientToolsRuntime({ settings: async () => JSON.parse(await readFile(join(profile, "settings.json"), "utf8")), launch: () => ({ command: process.execPath, args: [cli!, "--extension", extensions[0], "profile", "support", "--mode", "rpc", "--no-session"], cwd: profile, env: { PATH: process.env.PATH, HOME: process.env.HOME, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: root, PI_PROFILE_ROOT: root, PI_OPENAI_WORKER: "1" } }) });
  t.after(() => runtime.close());
  const app = Fastify(); t.after(() => app.close());
  registerCompatibilityRoutes(app, { clientTools: runtime, authorized: (header) => header === "Bearer fixture", profiles: async () => [{ name: "support" }], validateProfile: async () => {}, execute: async () => { throw new Error("Unexpected legacy execution"); } });
  const tools = [{ type: "function", name: wireTool, description: "Read an attached document in the client", parameters: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] } }];
  const input: any[] = [{ role: "user", content: "Read the two attached documents after the internal action" }];
  let totalInput = 0, totalOutput = 0, delegations = 0;
  for (let round = 0; round < 5; round++) {
    const response = await app.inject({ method: "POST", url: "/v1/responses", headers: { authorization: "Bearer fixture" }, payload: { model: "support", input, tools, stream: true } });
    if (providerError) throw providerError;
    if (mode === "collision") { assert.equal(response.statusCode, 400, response.payload); assert.equal(calls.length, 0); assert.ok(!existsSync(join(profile, "once.count"))); return; }
    if (mode === "truncated" && response.statusCode !== 200) { assert.equal(response.statusCode, 502, response.payload); assert.ok(!response.payload.includes("response.function_call_arguments.done")); break; }
    assert.equal(response.statusCode, 200, response.payload);
    const events = response.payload.split("\n\n").filter((frame) => frame.includes("data: ")).map((frame) => JSON.parse(frame.split("data: ")[1]));
    const terminal = events.find((event) => event.type === "response.completed");
    if (mode === "truncated" && events.some((event) => event.type === "response.failed")) { assert.ok(!events.some((event) => event.type === "response.function_call_arguments.done")); break; }
    assert.ok(terminal, response.payload);
    assert.ok(!response.payload.includes("PRIVATE_INTERNAL_VALUE")); assert.ok(!response.payload.includes('"name":"internal_once"'));
    const result = terminal.response; totalInput += result.usage.input_tokens; totalOutput += result.usage.output_tokens;
    const clientCalls = result.output.filter((item: any) => item.type === "function_call");
    if (!clientCalls.length) {
      assert.equal(result.output.filter((item: any) => item.type === "message").map((item: any) => item.content.map((part: any) => part.text).join("")).join("").trim(), mode === "blocked" ? "Profile denied delegated tools" : mode === "truncated" ? "Truncated calls were not executed" : mode === "failed" ? "Client file failed safely" : "Verified both client documents");
      input.push(...result.output); break;
    }
    assert.ok(events.some((event) => event.type === "response.function_call_arguments.done"));
    // Parallel internal work may still be completing at the handoff. Check
    // its exact-once effect after the agent has fully settled instead.
    input.push(...result.output);
    for (const call of clientCalls) {
      const args = JSON.parse(call.arguments); delegations++;
      input.push({ type: "function_call_output", call_id: call.call_id, output: [{ type: "input_text", text: mode === "failed" ? "CLIENT_FILE_ERROR" : `Document token ${args.file_id}` }, ...(args.file_id === "doc_1" && mode !== "failed" ? [{ type: "input_image", image_url: pngDataUrl }] : [])], status: mode === "failed" ? "failed" : "completed", files: [], embeds: [] });
    }
  }
  assert.equal(delegations, ["blocked", "truncated"].includes(mode) ? 0 : 2);
  if (mode === "truncated") { assert.ok(!existsSync(join(profile, "once.count"))); assert.ok(calls.length <= 2); }
  else { assert.equal(calls.length, 2); assert.equal(await readFile(join(profile, "once.count"), "utf8"), "1"); assert.equal(totalInput, 20); assert.equal(totalOutput, 8); }
  if (["parallel", "sequential", "codex"].includes(mode)) {
    historicalTurn = true;
    const replay = await app.inject({ method: "POST", url: "/v1/responses", headers: { authorization: "Bearer fixture" }, payload: { model: "support", input: [...input, { role: "user", content: "New question using the prior client documents" }], tools } });
    if (providerError) throw providerError;
    assert.equal(replay.statusCode, 200, replay.payload); assert.equal(replay.json().usage.input_tokens, 10); assert.equal(replay.json().usage.output_tokens, 4);
    assert.equal(await readFile(join(profile, "once.count"), "utf8"), "1"); assert.equal(calls.length, 3);
  }
  if (mode === "failed") assert.equal(await readFile(join(profile, "client-error.seen"), "utf8"), "yes");
  for (let count = 0; runtime.size && count < 100; count++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runtime.size, 0);
  const actual = JSON.parse(await readFile(join(profile, "settings.json"), "utf8"));
  assert.deepEqual(actual.profile.enabledTools, ["internal_once"]); assert.deepEqual(actual.profile.clientTools, policy);
  for (const name of ["packages", "extensions"]) assert.ok(!(name in actual));
  for (const name of ["git", "npm", "extensions", "node_modules"]) assert.ok(!existsSync(join(profile, name)));
  if (existsSync(join(profile, "sessions"))) assert.deepEqual((await readdir(join(profile, "sessions"), { recursive: true })).filter((name) => name.endsWith(".jsonl")), []);
});
