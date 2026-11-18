import assert from "node:assert/strict";
import test from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeWorkerInfrastructure, isTerminalPresentation, preserveComputerUseConfiguration } from "../extensions/api-server/worker-infrastructure.ts";
import { ProfileJobScope } from "../extensions/api-server/profile-job-scope.ts";

test("only marked Orca terminal presentation files are excluded before discovery results reach the loader", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-ui-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = ["orca-agent-status.ts", "orca-titlebar-spinner.ts", "orca-prefill.ts", "orca-custom-tool.ts", "user-tool.ts"].map(name => join(root, name));
  for (const path of paths) await writeFile(path, "// @orca-managed-pi-extension\nthrow Error('Must not evaluate during discovery');\n");
  const unmarked = join(root, "unmarked", "orca-agent-status.ts");
  assert.equal(await isTerminalPresentation(unmarked), false);
  await writeFile(paths[4], "export default function() {}\n");
  for (const path of paths.slice(0, 3)) assert.equal(await isTerminalPresentation(path), true);
  for (const path of paths.slice(3)) assert.equal(await isTerminalPresentation(path), false);
  await writeFile(paths[0], "export default function() {}\n");
  assert.equal(await isTerminalPresentation(paths[0]), false, "a user extension with the same filename must not be suppressed");
  await writeFile(paths[0], "// @orca-managed-pi-extension\nthrow Error('Must not evaluate');\n");
  const resources = paths.map((path, index) => ({ path, enabled: index !== 3, metadata: { scope: "user", source: "fixture" } }));
  const calls: unknown[] = [];
  class Discovery {
    marker = "bound-this";
    async resolve(...args: unknown[]) { assert.equal(this.marker, "bound-this"); calls.push(args); return { extensions: resources, skills: ["preserved"], prompts: [], themes: [], installFailures: [] }; }
    async resolveExtensionSources(...args: unknown[]) { return this.resolve(...args); }
  }
  initializeWorkerInfrastructure({ DefaultPackageManager: Discovery } as any);
  const once = Discovery.prototype.resolve;
  initializeWorkerInfrastructure({ DefaultPackageManager: Discovery } as any);
  assert.equal(Discovery.prototype.resolve, once);
  for (const method of ["resolve", "resolveExtensionSources"] as const) {
    const result = await new Discovery()[method]("argument");
    assert.deepEqual(result.extensions, resources.slice(3));
    assert.deepEqual(result.skills, ["preserved"]);
  }
  assert.ok(calls.every(args => JSON.stringify(args) === '["argument"]'));
});

test("proxy ALS infrastructure is empty between identities and does not exempt global replacements", async () => {
  class Discovery { async resolve() { return { extensions: [] }; } async resolveExtensionSources() { return { extensions: [] }; } }
  initializeWorkerInfrastructure({ DefaultPackageManager: Discovery } as any);
  const key = Symbol.for("pi-web-access.proxyStorage"), storage = Reflect.get(globalThis, key) as AsyncLocalStorage<string>;
  for (const identity of ["alice", "bob"]) {
    const scope = new ProfileJobScope();
    assert.equal(storage.getStore(), undefined);
    await storage.run(identity, async () => { await Promise.resolve(); assert.equal(storage.getStore(), identity); });
    assert.equal(storage.getStore(), undefined);
    assert.equal(await scope.finish(), true);
  }
  const scope = new ProfileJobScope();
  Reflect.set(globalThis, key, new AsyncLocalStorage());
  try { assert.equal(await scope.finish(), false); }
  finally { Reflect.set(globalThis, key, storage); }
});

test("Computer Use installer configuration is restored, but unrelated environment and live resources remain dirty", async () => {
  const key = "PI_COMPUTER_USE_LINUX_HELPER_PATH", original = process.env[key];
  try {
    for (const before of [undefined, "/profile/original-helper"]) {
      if (before === undefined) delete process.env[key]; else process.env[key] = before;
      const restore = preserveComputerUseConfiguration(), scope = new ProfileJobScope();
      process.env[key] = "/installation/bin/linux-bridge";
      restore();
      assert.equal(process.env[key], before);
      assert.equal(await scope.finish(), true);
    }
    const restore = preserveComputerUseConfiguration(), scope = new ProfileJobScope();
    process.env[key] = "/installation/bin/linux-bridge";
    process.env.PI_UNEXPECTED_JOB_MUTATION = "identity";
    const timer = setInterval(() => {}, 60_000); timer.unref();
    restore();
    try { assert.equal(await scope.finish(), false); }
    finally { clearInterval(timer); delete process.env.PI_UNEXPECTED_JOB_MUTATION; }
  } finally { if (original === undefined) delete process.env[key]; else process.env[key] = original; }
});
