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

test("permits adjacent code of external extension entrypoints without granting write access", () => {
  const directory = "/opt/fixture-extension";
  const policy = nonoPolicy("/tmp/agent/profiles/support", "/usr/local/bin/pi", { shared: false, profile: true }, [`${directory}/extension.ts`, "/opt/fixture-directory"]);
  assert.ok(policy.filesystem.read.includes(directory));
  assert.ok(policy.filesystem.read.includes("/opt/fixture-directory"));
  assert.ok(!policy.filesystem.read.includes("/opt"));
  assert.ok(!policy.filesystem.allow.includes(directory));
  assert.ok(!policy.filesystem.allow_file.includes(directory));
});

test("does not broaden file grants to the agent root, its ancestors, or other profiles", () => {
  const sources = ["/extension.ts", "/tmp/extension.ts", "/tmp/agent/extension.ts", "/tmp/agent/profiles/extension.ts", "/tmp/agent/profiles/neighbor/extension.ts"];
  const policy = nonoPolicy("/tmp/agent/profiles/support", "/usr/local/bin/pi", { shared: false, profile: true }, sources);
  for (const source of sources) assert.ok(policy.filesystem.read.includes(source));
  for (const directory of ["/", "/tmp", "/tmp/agent", "/tmp/agent/profiles", "/tmp/agent/profiles/neighbor"]) assert.ok(!policy.filesystem.read.includes(directory));
});

test("permits the active managed Pi release for sandboxed profiles", () => {
  const entry = "/home/user/.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
  assert.ok(runtimePaths(entry).includes("/home/user/.pi/agent/install/releases/1.0.4"));
});

test("permits the global Node package root for sandboxed profiles", () => {
  const entry = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
  assert.ok(runtimePaths(entry).includes("/usr/local/lib"));
});
