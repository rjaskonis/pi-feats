import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { listSessionMetadata } from "../extensions/lib/session-list-metadata.ts";

const timestamp = "2026-01-02T03:04:05.000Z";
const write = (path: string, entries: unknown[]) => writeFile(path, entries.map(value => JSON.stringify(value)).join("\n") + "\n");
const message = { type: "message", id: "user", parentId: null, timestamp, message: { role: "user", content: "First prompt", timestamp: Date.parse(timestamp) + 1 } };
const pulse = { type: "custom_message", id: "pulse", parentId: null, customType: "pulse", content: "Private Pulse body" };

test("session index follows active branches, preserves SDK metadata and never rewrites legacy files", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "sessions", "workspace"); await mkdir(dir, { recursive: true });
  const header = { type: "session", version: 3, id: "branch", cwd: root, timestamp };
  const branch = join(dir, "branch.jsonl"), legacy = join(dir, "legacy.jsonl");
  await write(branch, [header, message, { type: "session_info", id: "name", name: " Earlier " }, pulse]);
  await write(legacy, [{ ...header, id: "legacy", version: 1 }, { ...pulse, id: undefined }]);
  const before = await readFile(legacy, "utf8");
  const cold = await listSessionMetadata(root);
  assert.deepEqual(cold, await listSessionMetadata(root));
  assert.deepEqual(cold.map(({ id, pulseOnly }) => [id, pulseOnly]), [["branch", true], ["legacy", true]]);
  const sdk = await SessionManager.listAll(dir);
  for (const row of cold) {
    const source = sdk.find(s => s.id === row.id)!;
    for (const key of ["id", "cwd", "name", "firstMessage", "modified"] as const) assert.deepEqual(row[key], source[key]);
  }
  const index = join(root, ".session-list-index.json");
  assert.equal((await stat(index)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(index, "utf8"), /Private Pulse body/);
  assert.equal(await readFile(legacy, "utf8"), before);
  await appendFile(branch, JSON.stringify({ type: "session_info", id: "clear", parentId: "user", name: " " }) + "\n");
  const edited = (await listSessionMetadata(root)).find(s => s.id === "branch")!;
  assert.equal(edited.name, undefined); assert.equal(edited.pulseOnly, false);
  const moved = join(dir, "renamed.jsonl"); await rename(branch, moved); await rm(legacy);
  assert.deepEqual((await listSessionMetadata(root)).map(s => s.path), [moved]);
  await writeFile(index, "corrupt");
  assert.deepEqual((await listSessionMetadata(root, dir)).map(s => s.path), [moved]);
});
