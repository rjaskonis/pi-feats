import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findSessionFile } from "../extensions/lib/session-files.ts";

test("session lookup accepts header IDs and legacy filename aliases without rewriting files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-files-"));
  try {
    const nested = join(directory, "nested");
    await mkdir(nested);
    const file = join(nested, "2026-10-29T19-00-00-000Z_pulse-heartbeat_2026-10-29-19-00.jsonl");
    await writeFile(file, JSON.stringify({ type: "session", id: "actual-id", cwd: "/workspace" }) + "\n");
    await writeFile(join(directory, "broken.jsonl"), "not json\n");
    for (const id of ["actual-id", "pulse-heartbeat_2026-10-29-19-00"]) {
      assert.deepEqual(await findSessionFile(directory, id), { file, cwd: "/workspace" });
    }
    assert.equal(await findSessionFile(directory, "missing-id"), undefined);
    assert.equal(await findSessionFile(directory, "../actual-id"), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("header identity wins over a conflicting filename alias", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-files-"));
  try {
    await writeFile(join(directory, "a_requested.jsonl"), JSON.stringify({ type: "session", id: "unrelated", cwd: "/other" }) + "\n");
    const file = join(directory, "z_filename.jsonl");
    await writeFile(file, JSON.stringify({ type: "session", id: "requested", cwd: "/workspace" }) + "\n");
    assert.deepEqual(await findSessionFile(directory, "requested"), { file, cwd: "/workspace" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
