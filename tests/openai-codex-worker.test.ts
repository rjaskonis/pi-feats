import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import * as zlib from "node:zlib";
import { normalizeRequest } from "../extensions/api-server/openai-contract.ts";
import { executeWorker } from "../extensions/api-server/openai-execution.ts";
import { dataUrl, pdfFixture, visualPdfFixture, pngDataUrl } from "./fixtures/openai-attachments.ts";

const cli = process.env.PI_OPENAI_TEST_CLI;
test("Codex sends images/files despite text-only catalog metadata and preserves explicit image policy", { skip: !cli, timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-codex-worker-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, "profiles", "native"), bin = join(root, "bin");
  await mkdir(profile, { recursive: true }); await mkdir(bin);
  if (process.env.PI_OPENAI_TEST_NONO === "1") {
    const nono = [join(homedir(), ".local", "bin", "nono"), ...(process.env.PATH ?? "").split(":").map((directory) => join(directory, "nono"))].find((path) => existsSync(path));
    assert.ok(nono, "Nono must already be installed for this opt-in validation.");
    await symlink(nono, join(bin, "nono"));
  }
  const calls: any[] = []; let providerError: unknown, expectFiles = true;
  const provider = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const encoded = Buffer.concat(chunks);
      const raw = req.headers["content-encoding"] === "zstd" ? (zlib as any).zstdDecompressSync(encoded) : encoded;
      const body = JSON.parse(raw.toString("utf8")); calls.push(body);
      assert.equal(req.url, "/native/codex/responses"); assert.equal(req.headers["chatgpt-account-id"], "native-test-account");
      assert.equal(body.model, "native-model");
      const images = body.input.flatMap((item: any) => Array.isArray(item.content) ? item.content.filter((part: any) => part.type === "input_image") : []);
      assert.equal(images.length, 1); assert.equal(images[0].image_url, pngDataUrl);
      assert.equal(body.store, false); assert.equal(body.stream, true); assert.ok(body.instructions.includes("Native fixture policy"));
      assert.ok(JSON.stringify(body.tools).includes('"name":"read"'));
      const files = body.input.flatMap((item: any) => Array.isArray(item.content) ? item.content.filter((part: any) => part.type === "input_file") : []);
      assert.equal(files.length, expectFiles ? 2 : 0);
      if (expectFiles) {
        assert.equal(files[0].filename, "history.pdf"); assert.equal(files[1].filename, "visual.pdf");
        assert.equal(files[0].file_data, dataUrl("application/pdf", pdfFixture())); assert.equal(files[1].file_data, dataUrl("application/pdf", visualPdfFixture()));
      }
      assert.ok(!JSON.stringify(body).includes("[[pi-file:")); assert.ok(!JSON.stringify(body).includes("[Attached document:"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      const responseId = `resp_native_${calls.length}`;
      frame({ type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
      let output: unknown[];
      if (!body.input.some((item: any) => item.type === "function_call_output")) {
        const item = { id: "fc_native", type: "function_call", call_id: "native-call", name: "read", arguments: '{"path":"SOUL.md"}', status: "completed" };
        frame({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } });
        frame({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments });
        frame({ type: "response.output_item.done", output_index: 0, item }); output = [item];
      } else {
        assert.ok(body.input.some((item: any) => item.type === "function_call_output" && JSON.stringify(item.output).includes("Native fixture policy")));
        const item = { id: "msg_native", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Native files read", annotations: [] }] };
        frame({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
        frame({ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } });
        for (const delta of ["Native ", "files read"]) frame({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta });
        frame({ type: "response.output_item.done", output_index: 0, item }); output = [item];
      }
      frame({ type: "response.completed", response: { id: responseId, status: "completed", output, usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24, input_tokens_details: { cached_tokens: 3 } } } });
      res.end();
    } catch (error) { providerError = error; if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => provider.close(() => resolve())));
  const port = (provider.address() as { port: number }).port;
  const extensions = [resolve("extensions/profiles.ts"), resolve("extensions/api-server/index.ts"), resolve("extensions/guardrails/index.ts")];
  const settings = { extensions, defaultProvider: "native-fixture", defaultModel: "native-model", defaultThinkingLevel: "off", compaction: { enabled: false }, retry: { enabled: false }, transport: "sse" };
  await writeFile(join(root, "settings.json"), JSON.stringify(settings));
  const token = `e30=.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "native-test-account" } })).toString("base64")}.test-signature`;
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { "native-fixture": { baseUrl: `http://127.0.0.1:${port}/native`, apiKey: token, api: "openai-codex-responses", models: [{ id: "native-model", name: "Native fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] } } }));
  await writeFile(join(profile, "settings.json"), JSON.stringify({ ...settings, extensions: undefined, sandbox: process.env.PI_OPENAI_TEST_NONO === "1", profile: { enabledTools: ["read"] } }));
  await writeFile(join(profile, "SOUL.md"), "Native fixture policy: preserve profile tools and instructions.");
  // Only the sandbox launcher is available on PATH, never pdftotext. The
  // image-only PDF would also fail text extraction even if Poppler were present.
  await writeFile(join(profile, ".env"), `PATH=${bin}\n`);
  const request = normalizeRequest({ model: "native", input: [
    { role: "user", content: [{ type: "input_text", text: "Earlier PDF" }, { type: "input_file", filename: "history.pdf", file_data: dataUrl("application/pdf", pdfFixture()) }] },
    { role: "assistant", content: "Ready" },
    { role: "user", content: [{ type: "input_text", text: "Read the files and use the profile tool before answering" }, { type: "input_file", filename: "visual.pdf", file_data: dataUrl("application/pdf", visualPdfFixture()) }, { type: "input_image", image_url: pngDataUrl }] },
  ] }, "responses");
  const run = async (input: ReturnType<typeof normalizeRequest>, onEvent: (event: any) => Promise<void> = async () => {}) => {
    try {
      return await executeWorker(process.execPath, [cli!, "--extension", extensions[0], "profile", "native", "--mode", "rpc", "--no-session"], { cwd: profile, env: { PATH: process.env.PATH, HOME: process.env.HOME, PI_OFFLINE: "1", PI_OPENAI_WORKER: "1", PI_CODING_AGENT_DIR: root, PI_PROFILE_ROOT: root } }, input, onEvent, new AbortController().signal);
    } catch (error) { if (providerError) throw providerError; throw error; }
  };
  const events: any[] = [];
  const result = await run(request, async (event) => { events.push(event); });
  assert.equal(providerError, undefined); assert.equal(calls.length, 2); assert.equal(result.text, "Native files read");
  assert.deepEqual(result.usage, { input: 40, output: 8, cached: 6, reasoning: 0 });
  assert.equal(events.filter((event) => event.type === "text").map((event) => event.delta).join(""), result.text);
  expectFiles = false;
  const imageOnly = normalizeRequest({ model: "native", input: [{ role: "user", content: [{ type: "input_image", image_url: pngDataUrl }] }] }, "responses");
  const imageResult = await run(imageOnly);
  assert.equal(imageResult.text, "Native files read"); assert.equal(calls.length, 4);
  assert.equal(providerError, undefined);
  const profileSettings = JSON.parse(await readFile(join(profile, "settings.json"), "utf8"));
  const models = JSON.parse(await readFile(join(root, "models.json"), "utf8"));
  assert.deepEqual(models.providers["native-fixture"].models[0].input, ["text"]);
  await writeFile(join(profile, "settings.json"), JSON.stringify({ ...profileSettings, images: { blockImages: true } }));
  const blockedEvents: any[] = [];
  await assert.rejects(run(imageOnly, async (event) => { blockedEvents.push(event); }), (error: any) => error.status === 400 && error.code === "image_input_disabled");
  assert.equal(calls.length, 4); assert.deepEqual(blockedEvents, []);
  assert.ok(!("packages" in profileSettings)); assert.ok(!("extensions" in profileSettings));
  for (const name of ["git", "npm", "extensions", "node_modules"]) assert.ok(!existsSync(join(profile, name)));
  if (existsSync(join(profile, "sessions"))) assert.deepEqual((await readdir(join(profile, "sessions"), { recursive: true })).filter((name) => name.endsWith(".jsonl")), []);
});
