import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** Resolve an SDK-compatible CLI entry without starting the CLI. */
export async function piRuntimeEntry(entry = process.argv[1], managedRoot = process.env.PI_MANAGED_INSTALL_ROOT): Promise<string> {
  if (entry && existsSync(entry)) return resolve(entry);
  // Match the managed shell launcher's release resolution without invoking it.
  if (managedRoot && isAbsolute(managedRoot)) {
    const version = (await readFile(join(managedRoot, "current-version"), "utf8")).split("\n", 1)[0];
    if (version !== "." && version !== ".." && /^[A-Za-z0-9._+-]+$/.test(version)) {
      const cli = join(managedRoot, "releases", version, "node_modules", ".bin", "pi");
      if (existsSync(cli)) return cli;
    }
  }
  throw new Error("The active Pi runtime entry is unavailable.");
}

/** Build a CLI invocation without relying on a managed release that was removed. */
export function piCommand(entry = process.argv[1]): { command: string; args: string[] } {
  return entry && existsSync(entry)
    ? { command: process.execPath, args: [entry] }
    : { command: "pi", args: [] };
}
