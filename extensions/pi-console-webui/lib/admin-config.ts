import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type AdminTarget = "api-server" | "pi-console-webui";
// The API token must never reach the browser. Console credentials are intentionally editable in the administrative UI.
const secrets: Record<AdminTarget, string[]> = { "api-server": ["apiToken"], "pi-console-webui": [] };
const file = (target: AdminTarget) => join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), target === "api-server" ? "api-server.json" : "pi-console.webui.json");
const valid = (target: string): target is AdminTarget => target === "api-server" || target === "pi-console-webui";
export const isAdminTarget = valid;
async function raw(target: AdminTarget): Promise<Record<string, unknown>> { return JSON.parse(await readFile(file(target), "utf8")) as Record<string, unknown>; }
export async function readAdminConfig(target: AdminTarget) { const config = await raw(target); return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, secrets[target].includes(key) ? "<redacted>" : value])); }
export async function writeAdminConfig(target: AdminTarget, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a JSON object.");
  const current = await raw(target), next = { ...current, ...(value as Record<string, unknown>) };
  for (const key of secrets[target]) if (next[key] === "<redacted>" || next[key] === undefined) next[key] = current[key];
  if (typeof next.host !== "string" || !next.host) throw new Error("host must be a non-empty string.");
  if (!Number.isInteger(next.port) || (next.port as number) < 1 || (next.port as number) > 65535) throw new Error("port must be an integer between 1 and 65535.");
  const path = file(target), temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8"); await rename(temporary, path);
  return readAdminConfig(target);
}
