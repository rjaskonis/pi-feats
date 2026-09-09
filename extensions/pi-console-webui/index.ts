import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { existsSync, openSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

type ConsoleSettings = { host?: string; port?: number; username?: string; password?: string; secret?: string };
type LegacySettings = Record<string, unknown> & { console?: ConsoleSettings };
type State = { pid: number; host: string; port: number; startedAt: string };
const root = __dirname;
// Package dependencies are installed at the package root. Keep the nested
// location as a fallback for direct development use.
const dependencyRoot = () => existsSync(join(root, "node_modules", "next")) ? root : join(root, "..", "..");
const nextBinary = () => join(dependencyRoot(), "node_modules", "next", "dist", "bin", "next");
const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const configPath = () => join(agentDir(), "pi-console.webui.json");
const legacySettingsPath = () => join(agentDir(), "settings.json");
const statePath = () => join(agentDir(), "pi-console-webui.state.json");
const logPath = () => join(agentDir(), "pi-console-webui.log");
async function readJson<T>(path: string): Promise<T | undefined> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
async function writeJson(path: string, value: unknown) { await mkdir(agentDir(), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
async function settings(): Promise<ConsoleSettings> { const current = await readJson<ConsoleSettings>(configPath()); if (current) return current; const legacy = await readJson<LegacySettings>(legacySettingsPath()); const console = legacy?.console ?? {}; await writeJson(configPath(), console); if (legacy?.console) { const { console: _console, ...remaining } = legacy; await writeJson(legacySettingsPath(), remaining); } return console; }
async function config(): Promise<Required<ConsoleSettings>> { const current = await settings(); const host = typeof current.host === "string" && current.host ? current.host : "127.0.0.1"; const port = Number.isInteger(current.port) && current.port! > 0 && current.port! <= 65535 ? current.port : 3030; const username = typeof current.username === "string" && current.username ? current.username : "admin"; const password = typeof current.password === "string" && current.password ? current.password : "change-me"; const secret = typeof current.secret === "string" && current.secret ? current.secret : randomBytes(32).toString("base64url"); const resolved = { ...current, host, port, username, password, secret }; await writeJson(configPath(), resolved); return resolved; }
async function state(): Promise<State | undefined> { return readJson<State>(statePath()); }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function start() { const cfg = await config(), current = await state(), next = nextBinary(); if (current && alive(current.pid)) return console.log(`Pi Console is already running at http://${current.host}:${current.port}`); if (!existsSync(next)) throw new Error(`Dependencies are missing. Reinstall the Pi package or run npm install in ${dependencyRoot()}.`); const log = openSync(logPath(), "a"); const build = spawn(process.execPath, [next, "build"], { cwd: root, stdio: ["ignore", log, log] }); const code = await new Promise<number>((resolveBuild) => build.once("exit", (value) => resolveBuild(value ?? 1))); if (code !== 0) throw new Error(`Next build failed; see ${logPath()}`); const child = spawn(process.execPath, [next, "start", "--hostname", cfg.host, "--port", String(cfg.port)], { cwd: root, detached: true, stdio: ["ignore", log, log], env: process.env }); child.unref(); await writeJson(statePath(), { pid: child.pid!, host: cfg.host, port: cfg.port, startedAt: new Date().toISOString() }); console.log(`Pi Console started at http://${cfg.host}:${cfg.port}`); console.log(`Console credentials are configured in ${configPath()}.`); }
async function stop() { const current = await state(); if (!current || !alive(current.pid)) { await unlink(statePath()).catch(() => {}); return console.log("Pi Console is not running."); } try { process.kill(-current.pid, "SIGTERM"); } catch { process.kill(current.pid, "SIGTERM"); } await unlink(statePath()).catch(() => {}); console.log("Pi Console stopped."); }
async function status() { const current = await state(); console.log(current && alive(current.pid) ? `Pi Console: running at http://${current.host}:${current.port}` : "Pi Console: stopped"); }
export default async function (_pi: ExtensionAPI) { const [command, action] = process.argv.slice(2); if (command !== "console") return; if (action === "start") await start(); else if (action === "stop") await stop(); else if (action === "restart") { await stop(); await start(); } else if (action === "status") await status(); else { console.error("Usage: pi console start | stop | restart | status"); process.exitCode = 1; } process.exit(); }
