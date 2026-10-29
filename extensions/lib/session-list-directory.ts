import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export async function canonicalSessionDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  return realpath(absolute).catch(() => absolute);
}

/** Carry the caller's directory across CLI helpers and profile sandbox re-execs. */
export async function sessionListDirectoryEnvironment(args: string[], cwd = process.cwd(), environment: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const index = args.findIndex((arg, i) => arg === "sessions" && args[i + 1] === "list");
  return {
    PI_SESSION_LIST_CWD: index >= 0 && args[index + 2] === "."
      ? await canonicalSessionDirectory(environment.PI_SESSION_LIST_CWD ?? cwd)
      : undefined,
  };
}

/** Match the exact workspace, not its descendants or similarly named siblings. */
export async function sessionsInDirectory<T extends { cwd: string }>(sessions: T[], directory: string): Promise<T[]> {
  const target = await canonicalSessionDirectory(directory);
  const paths = new Map<string, Promise<string>>();
  const matches = await Promise.all(sessions.map(async (session) => {
    if (!paths.has(session.cwd)) paths.set(session.cwd, canonicalSessionDirectory(session.cwd));
    return await paths.get(session.cwd) === target;
  }));
  return sessions.filter((_, index) => matches[index]);
}
