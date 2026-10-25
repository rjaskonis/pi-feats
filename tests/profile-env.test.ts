import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { profileEnvironment, registerProfileEnvReload, reloadProfileEnvironment } from "../extensions/lib/profile-env.ts";

test("reload applies additions, changes and removals for default and named profiles independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-env-"));
  try {
    const named = join(root, "profiles", "test-profile");
    await mkdir(named, { recursive: true });
    await writeFile(join(root, ".env"), "SHARED=default\nREMOVED=old\n");
    await writeFile(join(named, ".env"), "SHARED=named\nNAMED_ONLY=yes\n");
    const base = { UNRELATED: "keep", SHARED: "inherited" };
    const defaultEnv = await profileEnvironment(root, base);
    const namedEnv = await profileEnvironment(named, base);
    await writeFile(join(root, ".env"), "SHARED=updated\nADDED=new\nSSH_AUTH_SOCK=/forbidden\n");
    await reloadProfileEnvironment(root, defaultEnv);
    assert.equal(defaultEnv.SHARED, "updated");
    assert.equal(defaultEnv.ADDED, "new");
    assert.equal(defaultEnv.REMOVED, undefined);
    assert.equal(defaultEnv.UNRELATED, "keep");
    assert.equal(defaultEnv.SSH_AUTH_SOCK, undefined);
    assert.equal(namedEnv.SHARED, "named");
    await writeFile(join(named, ".env"), "SHARED=named-updated\n");
    await reloadProfileEnvironment(named, namedEnv);
    assert.equal(namedEnv.SHARED, "named-updated");
    assert.equal(namedEnv.NAMED_ONLY, undefined);
    assert.equal(namedEnv.ADDED, undefined);
    assert.equal(defaultEnv.SHARED, "updated");
    await unlink(join(named, ".env"));
    await reloadProfileEnvironment(named, namedEnv);
    assert.equal(namedEnv.SHARED, undefined);
    assert.equal(namedEnv.UNRELATED, "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid or unreadable env files leave the entire environment unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-env-"));
  try {
    const path = join(root, ".env");
    await writeFile(path, "VALUE=old\n");
    const environment = await profileEnvironment(root, { UNRELATED: "keep" });
    const previous = { ...environment };
    await writeFile(path, "VALUE=new\ninvalid secret entry\n");
    await assert.rejects(reloadProfileEnvironment(root, environment));
    assert.deepEqual(environment, previous);
    await unlink(path);
    await mkdir(path);
    await assert.rejects(reloadProfileEnvironment(root, environment));
    assert.deepEqual(environment, previous);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only reload shutdown refreshes process.env before replacement factories run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-env-"));
  const previous = { ...process.env };
  const handlers = new Map<string, Function>();
  const pi = { on: (event: string, handler: Function) => handlers.set(event, handler) } as unknown as ExtensionAPI;
  try {
    await writeFile(join(root, ".env"), "PI_ENV_RELOAD_TEST=old\n");
    Object.assign(process.env, await profileEnvironment(root));
    registerProfileEnvReload(pi, root);
    assert.deepEqual([...handlers.keys()], ["session_shutdown"]);
    const shutdown = handlers.get("session_shutdown")!;
    await writeFile(join(root, ".env"), "PI_ENV_RELOAD_TEST=new\n");
    for (const reason of ["new", "resume", "fork", "quit"]) {
      await shutdown({ reason });
      assert.equal(process.env.PI_ENV_RELOAD_TEST, "old");
    }
    await shutdown({ reason: "reload" });
    assert.equal(process.env.PI_ENV_RELOAD_TEST, "new");
    await writeFile(join(root, ".env"), "PI_ENV_RELOAD_TEST=partial\nsecret invalid entry\n");
    await assert.rejects(shutdown({ reason: "reload" }), (error: Error) => {
      assert.match(error.message, /previous environment was preserved/);
      assert.ok(!error.message.includes("secret invalid entry"));
      return true;
    });
    assert.equal(process.env.PI_ENV_RELOAD_TEST, "new");
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});
