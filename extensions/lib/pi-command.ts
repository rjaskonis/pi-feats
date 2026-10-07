import { existsSync } from "node:fs";

/**
 * Return a fresh Pi CLI invocation. Managed Pi upgrades replace release files,
 * so a long-running worker must not blindly reuse a now-deleted argv[1].
 */
export function piCommand(entry = process.argv[1]): { command: string; args: string[] } {
  return entry && existsSync(entry)
    ? { command: process.execPath, args: [entry] }
    : { command: "pi", args: [] };
}
