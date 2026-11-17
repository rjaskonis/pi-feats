import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sdkEntryForCli } from "../extensions/api-server/openai-worker-paths.mjs";

test("resolves the same host SDK for bundled, unbundled and symlinked Pi CLIs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-sdk-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(join(packageDir, "dist", "bundle"), { recursive: true });
  await mkdir(join(root, "node_modules", ".bin"));
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
  for (const file of ["dist/cli.js", "dist/bundle/cli.js", "dist/index.js"]) await writeFile(join(packageDir, file), "");
  const linked = join(root, "node_modules", ".bin", "pi");
  await symlink(join(packageDir, "dist", "bundle", "cli.js"), linked);
  for (const cli of [join(packageDir, "dist", "cli.js"), join(packageDir, "dist", "bundle", "cli.js"), linked]) {
    assert.equal(sdkEntryForCli(cli), join(packageDir, "dist", "index.js"));
  }
});

test("rejects a CLI outside the Pi package instead of guessing a neighboring SDK", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-unknown-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, "cli.js");
  await writeFile(cli, "");
  assert.throws(() => sdkEntryForCli(cli), /Unsupported Pi CLI installation/);
});
