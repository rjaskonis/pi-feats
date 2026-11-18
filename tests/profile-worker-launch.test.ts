import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchProfileWorkerDirect, launchProfileWorkerViaCli } from "../extensions/api-server/profile-worker-launch.ts";
import { piRuntimeEntry } from "../extensions/lib/pi-command.ts";
import { nonoPolicy } from "../extensions/lib/profile-sandbox.ts";

const options = { skip: process.env.PI_OPENAI_TEST_NONO !== "1" };
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const parent = join(homedir(), ".cache");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "pi-direct-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "profiles", "support");
  await mkdir(dir, { recursive: true });
  return { root, dir };
}

test("direct API launch preserves the workspace boundary and migrates only named-profile state", options, async t => {
  const { root, dir } = await fixture(t);
  const entry = process.env.PI_OPENAI_TEST_CLI ?? process.execPath;
  const ext = join(root, "extensions", "probe.ts");
  await mkdir(join(root, "extensions")); await writeFile(ext, "export default function () {}\n");
  await writeFile(join(root, "settings.json"), JSON.stringify({ extensions: [ext], sandbox: true }));
  await writeFile(join(root, "models.json"), "{}");
  await writeFile(join(dir, "settings.json"), JSON.stringify({ sandbox: true, packages: ["npm:legacy"], extensions: ["legacy.ts"], profile: { enabledExtensions: ["legacy"] } }));
  await writeFile(join(dir, ".env"), "FIXTURE_VALUE=isolated\nPI_APPLICATION_IDENTITY_KEY=injected\nPI_OPENAI_WORKER=unexpected\n");
  await mkdir(join(dir, ".runtime"));
  await writeFile(join(dir, ".runtime", "auth.json"), '{"fixture":{"type":"api_key"}}');
  for (const name of ["git", "npm", "extensions", "node_modules"]) await mkdir(join(dir, name));
  const policy = { ...nonoPolicy(dir, entry, { shared: true, profile: false }, [ext]), meta: { name: "test-custom", description: "Administrator-owned policy" } };
  const original = JSON.stringify(policy);
  await writeFile(join(dir, "nono.json"), original);
  const base = { PATH: process.env.PATH, PI_APPLICATION_SLUG: "inherited", PI_API_WORKER: "1", SSH_AUTH_SOCK: "/tmp/fixture" };
  const signal = new AbortController().signal;
  const result = await launchProfileWorkerDirect(root, "support", root, signal, entry, base);
  assert.equal(result.command, "nono");
  assert.equal(result.cwd, dir);
  assert.ok(result.args.some(value => value.endsWith("/openai-worker.mjs")));
  assert.deepEqual(result.args.slice(-2), ["--extension", ext]);
  assert.equal(result.env.PI_OPENAI_WORKER, "1");
  assert.equal(result.env.PI_ACTIVE_PROFILE, "support");
  assert.equal(result.env.PI_CODING_AGENT_SESSION_DIR, join(dir, "sessions"));
  assert.equal(result.env.FIXTURE_VALUE, "isolated");
  for (const name of ["PI_APPLICATION_SLUG", "PI_APPLICATION_IDENTITY_KEY", "PI_API_WORKER", "SSH_AUTH_SOCK"]) assert.equal(result.env[name], undefined);
  assert.equal(await readFile(join(dir, "nono.json"), "utf8"), original);
  assert.equal(await readlink(join(dir, "models.json")), join(root, "models.json"));
  assert.deepEqual(JSON.parse(await readFile(join(dir, "auth.json"), "utf8")), { fixture: { type: "api_key" } });
  const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
  assert.equal("extensions" in settings || "packages" in settings || "enabledExtensions" in settings.profile, false);
  for (const name of [".runtime", "git", "npm", "extensions", "node_modules"]) await assert.rejects(readFile(join(dir, name)), { code: "ENOENT" });
  const defaultLaunch = await launchProfileWorkerDirect(root, "default", root, signal, entry, base);
  assert.equal(defaultLaunch.command, process.execPath);
  assert.equal(defaultLaunch.env.FIXTURE_VALUE, undefined);
  assert.deepEqual(launchProfileWorkerViaCli(root, "support", dir, entry, base).args.slice(-5), ["profile", "support", "--mode", "rpc", "--no-session"]);
  await writeFile(join(dir, "nono.json"), "not a policy");
  await assert.rejects(launchProfileWorkerDirect(root, "support", dir, signal, entry, base), { code: "worker_configuration_error" });
});

test("direct launcher resolves managed release entries and rejects invalid preparation without leaking diagnostics", async t => {
  const { root, dir } = await fixture(t);
  const install = join(root, "install"), bin = join(install, "releases", "1.5.2", "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(install, "current-version"), "1.5.2\n");
  await symlink(process.execPath, join(bin, "pi"));
  const missing = join(root, "removed-release");
  assert.equal(await piRuntimeEntry(missing, install), join(bin, "pi"));
  await writeFile(join(install, "current-version"), "../not-a-version\n");
  await assert.rejects(piRuntimeEntry(missing, install), /unavailable/);
  await writeFile(join(dir, "settings.json"), '{"sandbox": true, BAD_PRIVATE_VALUE}');
  await assert.rejects(launchProfileWorkerDirect(root, "support", dir, new AbortController().signal, process.execPath, {}), {
    code: "worker_configuration_error", message: "Profile execution resources could not be loaded.",
  });
});
