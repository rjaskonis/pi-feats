import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ConsoleConfig = { username: string; password: string; apiUrl: string; apiToken: string; secret: string };
type ApiConfig = { host?: string; port?: number; apiToken?: string };
type WebUiConfig = { username?: string; password?: string; secret?: string };
async function readJson<T>(path: string): Promise<T> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {} as T; throw error; } }
export async function getConfig(): Promise<ConsoleConfig> {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const [api, console] = await Promise.all([readJson<ApiConfig>(join(agentDir, "api-server.json")), readJson<WebUiConfig>(join(agentDir, "pi-console.webui.json"))]);
  const host = api.host === "0.0.0.0" || !api.host ? "127.0.0.1" : api.host;
  const apiUrl = process.env.PI_API_PROXY_TARGET || `http://${host}:${api.port ?? 8767}`;
  return { username: console.username ?? "admin", password: console.password ?? "change-me", apiUrl, apiToken: api.apiToken ?? "", secret: console.secret ?? `${console.username ?? "admin"}:${console.password ?? "change-me"}` };
}
