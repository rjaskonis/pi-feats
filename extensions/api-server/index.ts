import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { existsSync, openSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

type ApiSettings = { host?: string; port?: number; apiToken?: string; cors?: { origin?: string } };
type LegacySettings = Record<string, unknown> & { api?: ApiSettings };
type State = { pid: number; host: string; port: number; startedAt: string };
const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const configPath = () => join(agentDir(), "api-server.json");
const legacySettingsPath = () => join(agentDir(), "settings.json");
const statePath = () => join(agentDir(), "api-server.state.json");
const logPath = () => join(agentDir(), "api-server.log");

async function readJson<T>(path: string): Promise<T | undefined> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`); } }
async function writeJson(path: string, value: unknown) { await mkdir(agentDir(), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
async function migrateLegacyConfig(): Promise<ApiSettings> {
  const current = await readJson<ApiSettings>(configPath());
  if (current) return current;
  const legacy = await readJson<LegacySettings>(legacySettingsPath());
  const api = legacy?.api ?? {};
  await writeJson(configPath(), api);
  if (legacy?.api) { const { api: _api, ...remaining } = legacy; await writeJson(legacySettingsPath(), remaining); }
  return api;
}
async function getApiSettings(): Promise<Required<Pick<ApiSettings, "host" | "port" | "apiToken">> & ApiSettings> {
  const api = await migrateLegacyConfig();
  const host = typeof api.host === "string" && api.host ? api.host : "0.0.0.0";
  const port = typeof api.port === "number" && Number.isInteger(api.port) && api.port > 0 && api.port <= 65535 ? api.port : 8767;
  const apiToken = typeof api.apiToken === "string" && api.apiToken.length >= 24 ? api.apiToken : randomBytes(32).toString("base64url");
  const resolved = { ...api, host, port, apiToken, cors: api.cors ?? { origin: "*" } };
  if (api.apiToken !== apiToken || api.host !== host || api.port !== port || !api.cors) await writeJson(configPath(), resolved);
  return resolved;
}
async function readState(): Promise<State | undefined> { return readJson<State>(statePath()); }
function isAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function clearStaleState() { const state = await readState(); if (state && !isAlive(state.pid)) await unlink(statePath()).catch(() => {}); }
async function start() {
  const api = await getApiSettings(); await clearStaleState(); const current = await readState();
  if (current && isAlive(current.pid)) return console.log(`API is already running (PID ${current.pid}) at http://${current.host}:${current.port}`);
  const fd = openSync(logPath(), "a");
  const child = spawn("sh", ["-c", "tail -f /dev/null | \"$@\"", "pi-api-worker", process.execPath, process.argv[1], "--mode", "rpc", "--no-session"], { cwd: process.cwd(), detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, PI_API_WORKER: "1" } });
  child.unref(); await writeJson(statePath(), { pid: child.pid!, host: api.host, port: api.port, startedAt: new Date().toISOString() });
  console.log(`API started at http://${api.host}:${api.port} (PID ${child.pid}).`); console.log(`The token is stored in ${configPath()}.`);
}
async function stop() { const state = await readState(); if (!state || !isAlive(state.pid)) { await unlink(statePath()).catch(() => {}); return console.log("API is not running."); } try { process.kill(-state.pid, "SIGTERM"); } catch { process.kill(state.pid, "SIGTERM"); } for (let i = 0; i < 30 && isAlive(state.pid); i++) await new Promise((resolve) => setTimeout(resolve, 100)); if (isAlive(state.pid)) { try { process.kill(-state.pid, "SIGKILL"); } catch { process.kill(state.pid, "SIGKILL"); } } await unlink(statePath()).catch(() => {}); console.log("API stopped."); }
async function status() { await clearStaleState(); const state = await readState(); console.log(!state || !isAlive(state.pid) ? "API: stopped" : `API: running (PID ${state.pid}) at http://${state.host}:${state.port}`); }
async function handleCliCommand(): Promise<boolean> { const args = process.argv.slice(2); if (args[0] !== "api" || process.env.PI_API_WORKER === "1") return false; switch (args[1]) { case "start": await start(); break; case "stop": await stop(); break; case "status": await status(); break; case "restart": await stop(); await start(); break; default: console.error("Usage: pi api start | stop | restart | status"); process.exitCode = 1; } return true; }
export default async function (pi: ExtensionAPI) { if (await handleCliCommand()) process.exit(); if (process.env.PI_API_WORKER !== "1") return; pi.on("session_start", async () => { const { startApiServer } = await import("./server.ts"); await startApiServer({ agentDir: agentDir(), cwd: process.cwd() }); }); }
