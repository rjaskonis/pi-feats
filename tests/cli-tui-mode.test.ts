import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasTuiModeArg, isPiFeatsNonInteractiveCli, withRegularTuiMode, withoutTuiModeArgs } from "../extensions/lib/cli-tui-mode.ts";
import { piCommand } from "../extensions/lib/pi-command.ts";

test("classifies finite pi-feats CLI commands for regular TUI mode", () => {
  for (const args of [
    ["sessions", "list"],
    ["sessions", "rename", "abc", "Incident"],
    ["skills", "list"],
    ["tools", "disable", "bash"],
    ["extensions", "list"],
    ["packages", "enable", "npm:pi-feats"],
    ["profile", "list"],
    ["profile", "support", "sessions", "list"],
    ["profile", "support", "guardrails", "validate"],
    ["profile", "support", "pulse", "list"],
    ["profile", "support", "api", "status"],
    ["profile", "support", "console", "status"],
    ["profile", "support", "ssh", "list"],
    ["guardrails", "list"],
    ["ssh", "list"],
    ["pulse", "status"],
    ["api", "status"],
    ["console", "status"],
    ["remote", "list"],
    ["remote:alphanexus", "profile", "support", "sessions", "list"],
    ["remote:alphanexus", "profile", "support", "skills", "enable", "incident-response"],
    ["remote:alphanexus", "packages", "list"],
  ]) assert.equal(isPiFeatsNonInteractiveCli(args), true, args.join(" "));
});

test("preserves interactive Pi launches and shell access", () => {
  for (const args of [
    [],
    ["--resume"],
    ["profile", "support"],
    ["profile", "support", "resume"],
    ["profile", "support", "open", "session-id"],
    ["remote:alphanexus"],
    ["remote:alphanexus", "bash"],
    ["remote:alphanexus", "profile", "support"],
  ]) assert.equal(isPiFeatsNonInteractiveCli(args), false, args.join(" ") || "pi");
});

test("adds regular TUI mode only when the caller did not choose one", () => {
  assert.deepEqual(withRegularTuiMode(["sessions", "list"]), ["sessions", "list", "--tui-mode", "regular"]);
  assert.deepEqual(withRegularTuiMode(["sessions", "list", "--tui-mode", "fullscreen"]), ["sessions", "list", "--tui-mode", "fullscreen"]);
  assert.deepEqual(withRegularTuiMode(["sessions", "list", "--tui-mode=fullscreen"]), ["sessions", "list", "--tui-mode=fullscreen", "--tui-mode", "regular"]);
  assert.equal(hasTuiModeArg(["sessions", "list", "--tui-mode", "regular"]), true);
});

test("removes TUI flags before positional CLI dispatch", () => {
  assert.deepEqual(withoutTuiModeArgs(["profile", "support", "sessions", "list", "--tui-mode", "regular"]), ["profile", "support", "sessions", "list"]);
  assert.deepEqual(withoutTuiModeArgs(["--tui-mode=regular", "api", "status"]), ["api", "status"]);
});

test("uses the launcher from PATH when a worker's original Pi entry was replaced", async () => {
  const stale = join(tmpdir(), `missing-pi-entry-${Date.now()}`);
  assert.deepEqual(piCommand(stale), { command: "pi", args: [] });

  const entry = join(await mkdtemp(join(tmpdir(), "pi-entry-")), "pi");
  await writeFile(entry, "");
  assert.deepEqual(piCommand(entry), { command: process.execPath, args: [entry] });
});
