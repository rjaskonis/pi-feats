import assert from "node:assert/strict";
import test from "node:test";
import { runtimePaths } from "../extensions/lib/profile-sandbox.ts";

test("permits the active managed Pi release for sandboxed profiles", () => {
  const entry = "/home/user/.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
  assert.ok(runtimePaths(entry).includes("/home/user/.pi/agent/install/releases/1.0.4"));
});

test("permits the global Node package root for sandboxed profiles", () => {
  const entry = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
  assert.ok(runtimePaths(entry).includes("/usr/local/lib"));
});
