import { spawn } from "node:child_process";

const profileManagementActions = new Set(["add", "create", "delete", "list", "open", "remove", "resume"]);
const profileResourceCommands = new Set(["extensions", "packages", "sessions", "skills", "tools"]);
const topLevelCliCommands = new Set(["api", "console", "guardrails", "pulse", "ssh", "tools", "skills", "extensions", "packages", "sessions"]);

/** Remove the Pi TUI override before an extension dispatches positional CLI arguments. */
export function withoutTuiModeArgs(raw: string[]): string[] {
  const args: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index];
    if (value === "--tui-mode") { index += 1; continue; }
    if (value.startsWith("--tui-mode=")) continue;
    args.push(value);
  }
  return args;
}

export function hasTuiModeArg(args: string[]): boolean {
  return args.includes("--tui-mode");
}

/** Preserve an explicit user preference; otherwise make a finite CLI command render normally. */
export function withRegularTuiMode(args: string[]): string[] {
  return hasTuiModeArg(args) ? args : [...args, "--tui-mode", "regular"];
}

function profileCommandIsNonInteractive(args: string[]): boolean {
  const action = args[1];
  if (!action) return false;
  if (profileManagementActions.has(action.toLowerCase())) return true;
  return !profileManagementActions.has(action.toLowerCase()) && Boolean(args[2]) && (
    profileResourceCommands.has(args[2]) || ["api", "console", "guardrails", "pulse", "ssh"].includes(args[2])
  );
}

/**
 * True only for pi-feats commands that produce a finite CLI result. Interactive
 * Pi launches intentionally retain the selected profile's TUI preference.
 */
export function isPiFeatsNonInteractiveCli(raw: string[]): boolean {
  const args = withoutTuiModeArgs(raw);
  const command = args[0];
  if (!command) return false;
  if (topLevelCliCommands.has(command)) return true;
  if (command === "profile") return profileCommandIsNonInteractive(args);
  if (command === "remote") return ["add", "list", "delete"].includes(args[1] ?? "");

  const remote = command.match(/^remote:[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
  if (!remote) return false;
  const nested = args.slice(1);
  if (!nested.length || nested[0] === "bash") return false;
  if (nested[0] === "profile") return profileCommandIsNonInteractive(nested);
  return topLevelCliCommands.has(nested[0]);
}

/** Re-exec finite pi-feats CLI commands before Pi initializes its TUI. */
export async function reexecCliWithRegularTui(): Promise<boolean> {
  const args = process.argv.slice(2);
  if (!isPiFeatsNonInteractiveCli(args) || hasTuiModeArg(args)) return false;
  const child = spawn(process.execPath, [process.argv[1], ...withRegularTuiMode(args)], {
    stdio: "inherit",
    env: process.env,
  });
  const code = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolveExit(exitCode ?? 1));
  });
  process.exit(code);
}
