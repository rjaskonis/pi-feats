import assert from "node:assert/strict";
import test from "node:test";
import { hasTuiModeArg, isPiFeatsNonInteractiveCli, withRegularTuiMode, withoutTuiModeArgs } from "../extensions/lib/cli-tui-mode.ts";

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
