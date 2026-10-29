import assert from "node:assert/strict";
import test from "node:test";
import { nonoPolicy, runtimePaths } from "../extensions/lib/profile-sandbox.ts";

test("permits only read access to shared Application SQLite files", () => {
  const policy = nonoPolicy("/tmp/agent/profiles/support", "/usr/local/bin/pi", { shared: true, profile: true }, []);
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `/tmp/agent/applications.db${suffix}`;
    assert.ok(policy.filesystem.read.includes(path));
    assert.ok(!policy.filesystem.allow.includes(path));
    assert.ok(!policy.filesystem.allow_file.includes(path));
  }
  assert.ok(!policy.filesystem.allow.includes("/tmp/agent"));
});

test("permits the active managed Pi release for sandboxed profiles", () => {
  const entry = "/home/user/.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
  assert.ok(runtimePaths(entry).includes("/home/user/.pi/agent/install/releases/1.0.4"));
});

test("permits the global Node package root for sandboxed profiles", () => {
  const entry = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
  assert.ok(runtimePaths(entry).includes("/usr/local/lib"));
});
