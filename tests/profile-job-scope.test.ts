import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ProfileJobScope } from "../extensions/api-server/profile-job-scope.ts";

test("completed timers and request identity do not prevent safe worker reuse", async () => {
  const scope = new ProfileJobScope();
  try {
    await delay(1);
    process.env.PI_APPLICATION_IDENTITY_KEY = "scope-fixture";
    assert.equal(await scope.finish(), true);
  } finally { delete process.env.PI_APPLICATION_IDENTITY_KEY; }
});

test("leftover referenced or unreferenced extension timers require retirement", async () => {
  for (const unref of [false, true]) {
    const scope = new ProfileJobScope(), timer = setInterval(() => {}, 60_000);
    if (unref) timer.unref();
    try { assert.equal(await scope.finish(), false); }
    finally { clearInterval(timer); }
  }
});

test("background subprocesses cannot survive into the next identity", async () => {
  const scope = new ProfileJobScope();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
  const closed = once(child, "close");
  try { assert.equal(await scope.finish(), false); }
  finally { child.kill(); await closed; }
});

test("leftover process listeners require retirement even when unreferenced", async () => {
  const scope = new ProfileJobScope(), listener = () => {};
  process.on("beforeExit", listener);
  try { assert.equal(await scope.finish(), false); }
  finally { process.removeListener("beforeExit", listener); }
});

test("process environment and global mutations cannot contaminate another job", async () => {
  const scope = new ProfileJobScope();
  process.env.PI_SCOPE_LEAK_FIXTURE = "private-value";
  try { assert.equal(await scope.finish(), false); }
  finally { delete process.env.PI_SCOPE_LEAK_FIXTURE; }
  const globalScope = new ProfileJobScope(), key = Symbol("scope-global-fixture");
  Object.defineProperty(globalThis, key, { value: "private-value", configurable: true });
  try { assert.equal(await globalScope.finish(), false); }
  finally { Reflect.deleteProperty(globalThis, key); }
});
