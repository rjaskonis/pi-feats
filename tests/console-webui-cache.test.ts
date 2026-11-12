import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceHash } from "../scripts/console-webui-cache.mjs";

test("Console build cache includes shared request limits and ignores generated build output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-console-cache-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "console"), shared = join(root, "openai-limits.ts");
  await mkdir(app); await writeFile(join(app, "proxy.ts"), "export const proxy = true;\n");
  await writeFile(shared, "export const LIMIT = 1;\n");
  const before = await sourceHash(app, [shared]);
  assert.equal(before, await sourceHash(app, [shared]));
  await mkdir(join(app, ".next")); await writeFile(join(app, ".next", "generated.js"), "build output");
  assert.equal(before, await sourceHash(app, [shared]));
  await writeFile(shared, "export const LIMIT = 2;\n");
  assert.notEqual(before, await sourceHash(app, [shared]));
});
