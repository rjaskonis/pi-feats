import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const INJECTED_KEYS = "PI_PROFILE_ENV_KEYS";
// Never let a profile use the host user's SSH agent or askpass helper.
export const HOST_SSH_CREDENTIAL_KEYS = ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE"] as const;

function unquote(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    const body = value.slice(1, -1);
    return quote === '"' ? body.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : body;
  }
  const comment = value.search(/\s+#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

export function parseProfileEnv(source: string, path = ".env"): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`invalid .env entry in ${path}: ${rawLine}`);
    values[match[1]] = unquote(match[2]);
  }
  return values;
}

export async function readProfileEnv(agentDir: string): Promise<Record<string, string>> {
  const path = join(agentDir, ".env");
  if (!existsSync(path)) return {};
  return parseProfileEnv(await readFile(path, "utf8"), path);
}

/**
 * Produces an isolated environment for one profile. Values injected by a
 * previous profile launch are removed first, so they cannot leak into another
 * profile that does not define the same variable.
 */
export async function profileEnvironment(agentDir: string, base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = { ...base };
  for (const key of (base[INJECTED_KEYS] ?? "").split(",")) if (key) delete environment[key];
  delete environment[INJECTED_KEYS];
  for (const key of HOST_SSH_CREDENTIAL_KEYS) delete environment[key];

  const values = await readProfileEnv(agentDir);
  Object.assign(environment, values);
  // A profile .env must not reintroduce a host-agent socket by path.
  for (const key of HOST_SSH_CREDENTIAL_KEYS) delete environment[key];
  environment[INJECTED_KEYS] = Object.keys(values).filter((key) => !HOST_SSH_CREDENTIAL_KEYS.includes(key as typeof HOST_SSH_CREDENTIAL_KEYS[number])).sort().join(",");
  return environment;
}

/** Environment exposed to Application handlers; internal isolation metadata stays private. */
export async function handlerEnvironment(agentDir: string): Promise<Record<string, string | undefined>> {
  const environment = await profileEnvironment(agentDir);
  delete environment[INJECTED_KEYS];
  return environment;
}
