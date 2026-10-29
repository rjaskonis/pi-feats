import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { canonicalSessionDirectory, sessionListDirectoryEnvironment, sessionsInDirectory } from "../extensions/lib/session-list-directory.ts";

test("directory filtering matches the exact normalized workspace and symlink aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-list-directory-"));
  try {
    const workspace = join(root, "workspace"), alias = join(root, "alias");
    await mkdir(join(workspace, "child"), { recursive: true });
    await symlink(workspace, alias, "dir");
    const sessions = [
      { id: "exact", cwd: workspace },
      { id: "normalized", cwd: join(workspace, "child") + "/.." },
      { id: "alias", cwd: alias },
      { id: "child", cwd: join(workspace, "child") },
      { id: "sibling", cwd: join(root, "workspace-other") },
    ];
    assert.deepEqual((await sessionsInDirectory(sessions, alias)).map((s) => s.id), ["exact", "normalized", "alias"]);
    assert.deepEqual(await sessionsInDirectory(sessions, join(root, "empty")), []);
    assert.equal(await canonicalSessionDirectory(join(root, "missing", "..", "gone")), resolve(root, "gone"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI directory context survives helper and profile working-directory changes", async () => {
  const original = resolve("/workspace/original");
  const captured = await sessionListDirectoryEnvironment(["profile", "support", "sessions", "list", "."], original, {});
  assert.equal(captured.PI_SESSION_LIST_CWD, original);
  const forwarded = await sessionListDirectoryEnvironment(["--no-session", "sessions", "list", "."], "/agent/profiles/support", captured);
  assert.equal(forwarded.PI_SESSION_LIST_CWD, original);
  for (const args of [["sessions", "list"], ["sessions", "list", "pulses"], ["skills", "list"], ["sessions", "rename", "id", "."]]) {
    assert.equal((await sessionListDirectoryEnvironment(args, original, captured)).PI_SESSION_LIST_CWD, undefined);
  }
});
