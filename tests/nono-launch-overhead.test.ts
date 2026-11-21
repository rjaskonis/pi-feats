import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureProfileSandbox, sandboxedCommand } from "../extensions/lib/profile-sandbox.ts";

const enabled = process.platform === "linux" && process.env.PI_OPENAI_TEST_NONO_LAUNCH_OVERHEAD === "1";
const rounds = 7;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test("measure Nono launch overhead without importing the Pi SDK", { skip: !enabled, timeout: 60_000 }, async t => {
  const cache = join(homedir(), ".cache");
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "pi-nono-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "profiles", "support");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "settings.json"), '{"sandbox":true}\n');
  const policy = await ensureProfileSandbox(cwd, process.env.PI_OPENAI_TEST_CLI ?? process.execPath, [], { interactive: false });
  const env = { HOME: homedir(), PATH: process.env.PATH, XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache") };
  const targets = [
    { target: "native", command: "/usr/bin/printf", args: ["ready"] },
    { target: "node", command: process.execPath, args: ["-e", 'process.stdout.write("ready")'] },
  ];
  const samples = new Map<string, Array<{ readyMs: number; closeMs: number }>>();
  for (let round = 0; round < rounds; round++) for (const target of targets) for (const sandboxed of round % 2 ? [true, false] : [false, true]) {
    const launch = sandboxed ? sandboxedCommand(policy, cwd, target.command, target.args) : target;
    const started = performance.now();
    const result = await new Promise<{ readyMs: number; closeMs: number }>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, { cwd, env, stdio: ["ignore", "pipe", "ignore"], signal: AbortSignal.timeout(6000) });
      let output = "", readyMs: number | undefined;
      child.stdout.on("data", (value: Buffer) => { readyMs ??= Math.round(performance.now() - started); output += value.toString(); });
      child.once("error", reject);
      child.once("close", code => {
        if (code !== 0 || output !== "ready" || readyMs === undefined) reject(new Error(`${target.target} probe failed (exit ${code})`));
        else resolve({ readyMs, closeMs: Math.round(performance.now() - started) });
      });
    });
    const key = `${target.target}/${sandboxed ? "nono" : "plain"}`;
    const group = samples.get(key) ?? [];
    group.push(result); samples.set(key, group);
  }
  for (const [target, group] of samples) {
    assert.equal(group.length, rounds);
    const ready = group.map(row => row.readyMs);
    t.diagnostic(JSON.stringify({ target, medianReadyMs: median(ready), readyRangeMs: [Math.min(...ready), Math.max(...ready)], medianCloseMs: median(group.map(row => row.closeMs)) }));
  }
});
