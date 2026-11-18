import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeRequest } from "../extensions/api-server/openai-contract.ts";
import type { LatencyTrace } from "../extensions/api-server/latency-trace.ts";
import { ProfileWorkerRuntime, profileWorkerVersion } from "../extensions/api-server/profile-worker-runtime.ts";
import { extensionCatalog } from "../extensions/lib/extension-catalog.ts";
import { launchProfileWorkerDirect, launchProfileWorkerViaCli } from "../extensions/api-server/profile-worker-launch.ts";
import { ensureProfileSandbox, sandboxedCommand } from "../extensions/lib/profile-sandbox.ts";

const cli = process.env.PI_OPENAI_TEST_CLI ? resolve(process.env.PI_OPENAI_TEST_CLI) : undefined;
const enabled = cli && process.env.PI_OPENAI_TEST_LAUNCH_BENCHMARK === "1";
const compareCache = process.env.PI_OPENAI_TEST_LAUNCH_CACHE === "1";
const rounds = Number(process.env.PI_OPENAI_TEST_LAUNCH_ROUNDS ?? 5);
const run = promisify(execFile);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const ms = (number: number) => Math.round(number);

async function residentPss(pid: number | undefined): Promise<number | undefined> {
  if (pid === undefined || process.platform !== "linux") return;
  try {
    const root = `/proc/${pid}`;
    const pss = (await readFile(`${root}/smaps_rollup`, "utf8")).match(/^Pss:\s+(\d+) kB$/m);
    const children = (await readFile(`${root}/task/${pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean);
    const descendants = await Promise.all(children.map(child => residentPss(Number(child))));
    if (pss && descendants.every(value => value !== undefined)) return Number(pss[1]) + descendants.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  } catch { /* PSS is optional; process permissions can prevent sampling. */ }
}

test("benchmark CLI and direct worker launch with a localhost model and sandbox parity", { skip: !enabled, timeout: 360_000 }, async (t) => {
  // The CLI may otherwise inherit a configured model or a user's installed extensions.
  assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
  const env = { HOME: homedir(), PATH: process.env.PATH, PI_OFFLINE: "1" };
  await run("nono", ["--version"], { env });
  await mkdir(join(homedir(), ".cache"), { recursive: true });
  const root = await mkdtemp(join(homedir(), ".cache", "pi-launch-benchmark-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const support = join(root, "profiles", "support");
  const neighbor = join(root, "profiles", "neighbor", "private.txt");
  await mkdir(support, { recursive: true });
  await mkdir(join(root, "profiles", "neighbor"));
  await writeFile(neighbor, "NEIGHBOR_FIXTURE_MARKER");
  await writeFile(join(support, "own.txt"), "OWN_FIXTURE_MARKER");
  await writeFile(join(support, ".env"), "PI_LAUNCH_FIXTURE_MARKER=profile-env\n");
  const probe = join(root, "probe.ts");
  await writeFile(probe, `import { readFileSync } from "node:fs";
import { join } from "node:path";
export default function (pi) {
  let turns = 0;
  const read = (path) => { try { return readFileSync(path, "utf8"); } catch { return "denied"; } };
  pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\nLAUNCH_FIXTURE " + JSON.stringify({
    active: process.env.PI_ACTIVE_PROFILE, env: process.env.PI_LAUNCH_FIXTURE_MARKER ?? null,
    own: read(join(process.cwd(), "own.txt")), neighbor: read(${JSON.stringify(neighbor)}), turns: ++turns
  }) }));
}`);
  const base = { defaultProvider: "fixture", defaultModel: "fixture", defaultThinkingLevel: "off", compaction: { enabled: false } };
  const external: unknown = JSON.parse(process.env.PI_OPENAI_TEST_EXTERNAL_EXTENSIONS ?? "[]");
  assert.ok(Array.isArray(external) && external.every(path => typeof path === "string" && resolve(path) === path));
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const shipped = process.env.PI_OPENAI_TEST_LAUNCH_SHIPPED === "1" ? manifest.pi.extensions : ["extensions/profiles.ts"];
  const settings = { ...base, extensions: [...shipped.map((path: string) => resolve(path)), ...external, probe] };
  if (process.env.PI_OPENAI_TEST_RUNTIME_NPM_DIR) await symlink(resolve(process.env.PI_OPENAI_TEST_RUNTIME_NPM_DIR), join(root, "npm"), "dir");
  await writeFile(join(root, "settings.json"), JSON.stringify(settings));
  await writeFile(join(support, "settings.json"), JSON.stringify({ ...base, sandbox: true }));

  const contexts: Array<{ active: string; env: string | null; own: string; neighbor: string; turns: number }> = [];
  const provider = createServer(async (req, res) => {
    try {
      let input = ""; for await (const chunk of req) input += chunk;
      const { messages } = JSON.parse(input);
      const system = messages.filter((item: { role: string }) => item.role === "system").map((item: { content: string }) => item.content).join("\n");
      const marker = system.match(/^LAUNCH_FIXTURE (\{[^\n]+\})$/m);
      if (!marker) { res.writeHead(400).end(); return; }
      contexts.push(JSON.parse(marker[1]));
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [delta, finish_reason] of [[{ role: "assistant", content: "OK" }, null], [{}, "stop"]]) {
        res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    } catch { res.writeHead(400).end(); }
  });
  await new Promise<void>((resolveListen, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolveListen); });
  t.after(() => new Promise<void>((done) => provider.close(() => done())));
  const address = provider.address(); assert.ok(address && typeof address === "object");
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", apiKey: "local-fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }] } } }));

  const modes = compareCache ? ["cli", "direct", "direct-empty-cache", "direct-sdk-cache"] : ["cli", "direct"];
  const seededCaches = new Map<string, string>();
  if (compareCache) {
    const { sdkEntryForCli } = await import("../extensions/api-server/openai-worker-paths.mjs");
    const sdk = sdkEntryForCli(cli!);
    for (const [profile, dir] of [["default", root], ["support", support]]) {
      const cache = join(dir, ".benchmark-sdk-cache");
      const args = ["--input-type=module", "-e", `import { getCompileCacheDir, flushCompileCache } from 'node:module';
        import { pathToFileURL } from 'node:url';
        if (!getCompileCacheDir()) throw new Error('Compile cache unavailable');
        const start = performance.now();
        await import(pathToFileURL(process.argv[1]).href);
        const sdkImportMs = Math.round(performance.now() - start);
        flushCompileCache();
        console.log(JSON.stringify({ sdkImportMs }));`, sdk];
      const sources = (await extensionCatalog(root, settings)).filter(entry => entry.enabled).map(entry => entry.path);
      const launch = profile === "default" ? { command: process.execPath, args } : sandboxedCommand(await ensureProfileSandbox(dir, cli!, sources), dir, process.execPath, args);
      const { stdout } = await run(launch.command, launch.args, { cwd: dir, env: { ...env, NODE_COMPILE_CACHE: cache } });
      seededCaches.set(profile, cache);
      t.diagnostic(JSON.stringify({ profile, sdkCacheSeedImportMs: JSON.parse(stdout.trim()).sdkImportMs }));
    }
  }

  const rows: Array<{ profile: string; mode: string; coldReadyMs: number; coldTotalMs: number; prepMs: number; beforeInitMs: number; initMs: number; warmReadyMs: number; pssMiB?: number }> = [];
  for (let i = 0; i < rounds; i++) for (const profile of ["default", "support"]) {
    const named = profile !== "default", dir = named ? support : root;
    // Alternate ordering within each profile so cache and load drift do not
    // invariably favor the prototype. No real provider credentials are inherited.
    for (const mode of [...modes.slice(i % modes.length), ...modes.slice(0, i % modes.length)]) {
      const start = performance.now();
      const childEnv: NodeJS.ProcessEnv = { ...env };
      if (mode === "direct-empty-cache") childEnv.NODE_COMPILE_CACHE = join(dir, `.benchmark-empty-cache-${i}`);
      if (mode === "direct-sdk-cache") childEnv.NODE_COMPILE_CACHE = seededCaches.get(profile)!;
      let prepMs = 0;
      const pool = new ProfileWorkerRuntime({ agentDir: root, launch: async (profile, signal) => {
        const prepareStart = performance.now();
        try { return mode === "cli" ? launchProfileWorkerViaCli(root, profile, dir, cli!, childEnv) : await launchProfileWorkerDirect(root, profile, dir, signal, cli!, childEnv); }
        finally { prepMs = performance.now() - prepareStart; }
      }, version: () => profileWorkerVersion(root, dir) });
      try {
        const execute = async (started: number) => {
          const trace: LatencyTrace = { started };
          const before = contexts.length;
          const result = await pool.execute(profile, { request: normalizeRequest({ model: profile, input: "Reply with OK only." }, "responses") }, async () => {}, AbortSignal.timeout(30_000), undefined, undefined, trace);
          assert.equal(result.text, "OK"); assert.equal(contexts.length, before + 1);
          assert.deepEqual(contexts.at(-1), { active: profile, env: named ? "profile-env" : null, own: named ? "OWN_FIXTURE_MARKER" : "denied", neighbor: named ? "denied" : "NEIGHBOR_FIXTURE_MARKER", turns: 1 });
          assert.equal(trace.retired, false); assert.equal(trace.execution?.modelStreamsCompleted, 1);
          return trace;
        };
        const cold = await execute(start), warm = await execute(performance.now());
        assert.equal(cold.worker, "cold"); assert.equal(warm.worker, "reused");
        assert.equal(cold.execution?.workerPid, warm.execution?.workerPid);
        assert.ok(cold.untilReadyMs && cold.execution?.agentInitMs && warm.untilReadyMs);
        const pss = await residentPss(warm.launcherPid);
        rows.push({ profile, mode, coldReadyMs: ms(cold.untilReadyMs), coldTotalMs: ms(cold.untilIdleMs!), prepMs: ms(prepMs), beforeInitMs: ms(cold.untilReadyMs - prepMs - cold.execution.agentInitMs), initMs: ms(cold.execution.agentInitMs), warmReadyMs: ms(warm.untilReadyMs), ...(pss === undefined ? {} : { pssMiB: ms(pss / 1024) }) });
        t.diagnostic(JSON.stringify(rows.at(-1)));
      } finally { await pool.close(); }
    }
  }
  for (const profile of ["default", "support"]) for (const mode of modes) {
    const group = rows.filter(row => row.profile === profile && row.mode === mode);
    t.diagnostic(JSON.stringify({ profile, mode, medianColdReadyMs: median(group.map(row => row.coldReadyMs)), medianColdTotalMs: median(group.map(row => row.coldTotalMs)), medianPrepMs: median(group.map(row => row.prepMs)), medianBeforeInitMs: median(group.map(row => row.beforeInitMs)), medianAgentInitMs: median(group.map(row => row.initMs)), coldReadyRangeMs: [Math.min(...group.map(row => row.coldReadyMs)), Math.max(...group.map(row => row.coldReadyMs))], medianWarmReadyMs: median(group.map(row => row.warmReadyMs)), medianPssMiB: group.every(row => row.pssMiB !== undefined) ? median(group.map(row => row.pssMiB!)) : undefined }));
  }
});
