import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const cli = process.env.PI_OPENAI_TEST_CLI;
const run = promisify(execFile);

test("read-only CLI listings avoid an extra Pi and never start a session", { skip: !cli, timeout: 90_000 }, async t => {
  const cache = join(homedir(), ".cache");
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "pi-cli-resource-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extensions = join(root, "extensions");
  await mkdir(extensions);
  const probe = join(extensions, "probe.ts");
  await writeFile(probe, `export default function (pi) {
    if (process.env.PI_CLI_RESOURCES === "1") throw new Error("Unexpected CLI helper");
    pi.on("session_start", () => { throw new Error("Unexpected agent session"); });
  }`);
  await writeFile(join(root, "settings.json"), JSON.stringify({ extensions: [probe, resolve("extensions/cli-resources.ts"), resolve("extensions/profiles.ts")] }));
  const env = { HOME: homedir(), PATH: process.env.PATH, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: root, PI_PROFILE_ROOT: root };
  const invoke = async (args: string[]) => {
    const { stdout, stderr } = await run(cli!, args, { cwd: root, env, timeout: 20_000 });
    assert.doesNotMatch(stdout + stderr, /Unexpected CLI helper|Unexpected agent session/);
    return stdout + stderr;
  };
  const prefixes: string[][] = [[]];
  if (process.env.PI_OPENAI_TEST_NONO === "1") {
    await invoke(["profile", "create", "test-profile"]);
    prefixes.push(["profile", "test-profile"]);
    const workspace = join(root, "profiles", "test-profile");
    const settings = JSON.parse(await readFile(join(workspace, "settings.json"), "utf8"));
    assert.equal(settings.sandbox, true);
    assert.ok(!("packages" in settings) && !("extensions" in settings));
    const entries = await readdir(workspace);
    for (const name of ["git", "npm", "extensions", "node_modules"]) assert.ok(!entries.includes(name));
  }
  for (const prefix of prefixes) {
    for (const kind of ["packages", "extensions", "skills", "sessions"]) assert.match(await invoke([...prefix, kind, "list"]), new RegExp(`^${kind.toUpperCase()}\\b`, "m"));
    assert.match(await invoke([...prefix, "sessions", "list", "."]), /^SESSIONS\b/m);
    assert.match(await invoke([...prefix, "sessions", "list", "pulses"]), /^PULSE SESSIONS\b/m);
  }
  for (const dir of [root, join(root, "profiles", "test-profile")]) {
    const files = await readdir(join(dir, "sessions"), { recursive: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    assert.ok(!files.some(file => file.endsWith(".jsonl")));
  }
});
