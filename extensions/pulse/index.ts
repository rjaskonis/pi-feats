import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, openSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { PulseStore } from "./store.ts";

const root = () => process.env.PI_PROFILE_ROOT ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const dbPath = () => join(root(), "pulse.db"); const statePath = () => join(root(), "pulse-tick.state.json"); const logPath = () => join(root(), "pulse-tick.log");
type State = { pid: number; startedAt: string };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function json<T>(path: string): Promise<T | undefined> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return undefined; } }
async function write(path: string, value: unknown) { await mkdir(root(), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
async function sessionFile(profile: string, id: string): Promise<{ file: string; cwd: string } | undefined> {
  const directory = join(root(), profile === "default" ? "sessions" : join("profiles", profile, "sessions"));
  const visit = async (path: string): Promise<string | undefined> => { for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) { const candidate = join(path, entry.name); if (entry.isDirectory()) { const match = await visit(candidate); if (match) return match; } else if (entry.isFile() && entry.name.endsWith(`_${id}.jsonl`)) return candidate; } };
  const file = await visit(directory); if (!file) return undefined;
  const header = JSON.parse((await readFile(file, "utf8")).split("\n", 1)[0]) as { cwd?: string };
  return { file, cwd: header.cwd || process.cwd() };
}
function table(profile?: string) { const rows = new PulseStore(dbPath()).list(profile); const columns: Array<[string, number]> = [["STATUS", 8], ["TYPE", 9], ["NAME", 20], ["SCHEDULE", 20], ["THREAD SESSION", 24], ["NEXT RUN", 20], ["LAST RUN", 20]]; const clip = (v: string, n: number) => v.length > n ? `${v.slice(0, n - 1)}…` : v; const row = (values: string[]) => `│ ${values.map((v, i) => clip(v, columns[i][1]).padEnd(columns[i][1])).join(" │ ")} │`; const line = `┼${columns.map(([, n]) => "─".repeat(n + 2)).join("┼")}┼`; console.log(line.replaceAll("┼", "┬").replace(/^┬/, "┌").replace(/┬$/, "┐")); console.log(row(columns.map(([n]) => n))); console.log(line); for (const item of rows) { const color = item.enabled ? "\x1b[32m" : "\x1b[38;2;245;194;215m"; console.log(`${color}${row([item.enabled ? "enabled" : "disabled", item.type, item.name, item.schedule, item.thread_session_id, item.nextRunAt ?? "—", item.lastRunAt ?? "—"])}\x1b[0m`); } if (!rows.length) console.log(row(["—", "—", "No pulses configured", "—", "—", "—", "—"])); console.log(line.replaceAll("┼", "┴").replace(/^┴/, "└").replace(/┴$/, "┘")); }
async function start() { const current = await json<State>(statePath()); if (current && alive(current.pid)) return console.log(`Pulse tick is already running (PID ${current.pid}).`); await unlink(statePath()).catch(() => {}); const fd = openSync(logPath(), "a"); const child = spawn("sh", ["-c", "tail -f /dev/null | \"$@\"", "pi-pulse-tick", process.execPath, process.argv[1], "pulse", "tick"], { cwd: process.cwd(), detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, PI_PULSE_TICK: "1" } }); child.unref(); await write(statePath(), { pid: child.pid!, startedAt: new Date().toISOString() }); console.log(`Pulse tick started (PID ${child.pid}).`); }
async function stop() { const current = await json<State>(statePath()); if (!current || !alive(current.pid)) { await unlink(statePath()).catch(() => {}); return console.log("Pulse tick is not running."); } try { process.kill(-current.pid, "SIGTERM"); } catch { process.kill(current.pid, "SIGTERM"); } await unlink(statePath()).catch(() => {}); console.log("Pulse tick stopped."); }
async function status() { const state = await json<State>(statePath()); const store = new PulseStore(dbPath()); const enabled = store.list().filter((item) => item.enabled).length; console.log(!state || !alive(state.pid) ? `Pulse tick: stopped (${enabled} enabled pulses)` : `Pulse tick: running (PID ${state.pid}, ${enabled} enabled pulses, since ${state.startedAt})`); }
async function tick() { const store = new PulseStore(dbPath()); const execute = async () => { for (const pulse of store.due()) { const run = store.begin(pulse); try { const handoff = pulse.type === "heartbeat" ? store.handoff(pulse.id) : ""; const message = `[Pulse: ${pulse.name}]\n${pulse.prompt}${handoff ? `\n\nPrevious heartbeat state (private):\n${handoff}` : ""}`; const target = pulse.thread_session_id ? await sessionFile(pulse.profile, pulse.thread_session_id) : undefined; if (pulse.thread_session_id && !target) throw new Error(`Thread session '${pulse.thread_session_id}' was not found for profile '${pulse.profile}'.`); const result = await new Promise<string>((resolve, reject) => { const child = spawn(process.execPath, [process.argv[1], "profile", pulse.profile, ...(target ? ["--session", target.file] : ["--no-session"]), "--print", message], { cwd: target?.cwd ?? process.cwd(), env: { ...process.env, PI_PULSE_TICK: "1" }, stdio: ["ignore", "pipe", "pipe"] }); let output = "", error = ""; child.stdout.on("data", (data) => output += String(data)); child.stderr.on("data", (data) => error += String(data)); child.once("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(error.trim() || `Pi exited with ${code}`))); child.once("error", reject); }); const state = pulse.type === "heartbeat" ? result.slice(-8000) : undefined; store.complete(pulse, run, result, state); } catch (error) { store.fail(pulse, run, error instanceof Error ? error.message : String(error)); } } }; await execute(); const timer = setInterval(() => { void execute(); }, 15_000); await new Promise<void>((resolve) => { const close = () => { clearInterval(timer); resolve(); }; process.once("SIGTERM", close); process.once("SIGINT", close); }); }
export async function handlePulseCli(args: string[], selectedProfile?: string): Promise<boolean> { if (args[0] !== "pulse") return false; const profileIndex = args.indexOf("--profile"); const profile = selectedProfile ?? (profileIndex >= 0 ? args[profileIndex + 1] : undefined); if (args[1] === "tick" && process.env.PI_PULSE_TICK === "1") { await tick(); return true; } switch (args[1]) { case "start": await start(); break; case "stop": await stop(); break; case "status": await status(); break; case "list": table(profile); break; case "enable": case "disable": { const name = args[2]; if (!name) throw new Error("Usage: pi pulse enable|disable <name>"); new PulseStore(dbPath()).setEnabled(name, args[1] === "enable", profile); console.log(`Pulse '${name}' ${args[1]}d.`); break; } default: console.error("Usage: pi pulse start | stop | status | list | enable <name> | disable <name>"); process.exitCode = 1; } return true; }
export default async function (pi: ExtensionAPI) {
  if (await handlePulseCli(process.argv.slice(2))) process.exit();
  pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n\nWhen the user asks to schedule, automate, remind, run future work, or manage an existing schedule, use the schedule tool. Do not ask for a thread or session ID: creation binds the schedule to this conversation automatically.` }));
  pi.registerTool({
    name: "schedule",
    label: "Manage schedule",
    description: "Create, list, edit, enable, disable, or delete cron jobs, heartbeats, reminders, and future schedules. Use this whenever the user asks to schedule or manage scheduled work.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("update"), Type.Literal("enable"), Type.Literal("disable"), Type.Literal("delete")]),
      name: Type.Optional(Type.String({ description: "Schedule name. Required except when listing." })),
      description: Type.Optional(Type.String({ description: "Human-readable purpose, required for create." })),
      schedule: Type.Optional(Type.String({ description: "Five-field UTC cron expression or @once:<ISO-8601>. Required for create." })),
      prompt: Type.Optional(Type.String({ description: "Markdown instructions, required for create." })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const profile = process.env.PI_ACTIVE_PROFILE ?? "default", store = new PulseStore(dbPath());
        if (params.action === "list") { const pulses = store.list(profile); return { content: [{ type: "text", text: JSON.stringify(pulses) }], details: { pulses } }; }
        if (!params.name) throw new Error("A schedule name is required.");
        if (params.action === "create") {
          if (!params.description || !params.schedule || !params.prompt) throw new Error("Create requires name, description, schedule, and prompt.");
          const threadSessionId = ctx.sessionManager.getSessionId(); if (!threadSessionId) throw new Error("A persistent conversation session is required to create a schedule.");
          const pulse = store.create({ name: params.name, description: params.description, schedule: params.schedule, prompt: params.prompt, profile, thread_session_id: threadSessionId }); await start();
          return { content: [{ type: "text", text: JSON.stringify(pulse) }], details: pulse };
        }
        if (params.action === "enable" || params.action === "disable") { const pulse = store.setEnabled(params.name, params.action === "enable", profile); return { content: [{ type: "text", text: JSON.stringify(pulse) }], details: pulse }; }
        if (params.action === "delete") { store.delete(params.name, profile); return { content: [{ type: "text", text: `Schedule '${params.name}' deleted.` }], details: {} }; }
        const current = store.get(params.name, profile); if (!current) throw new Error("Schedule not found.");
        const pulse = store.update(params.name, profile, { description: params.description ?? current.description, schedule: params.schedule ?? current.schedule, prompt: params.prompt ?? current.prompt, thread_session_id: current.thread_session_id });
        return { content: [{ type: "text", text: JSON.stringify(pulse) }], details: pulse };
      } catch (error) { return { content: [{ type: "text", text: `Unable to manage schedule: ${error instanceof Error ? error.message : String(error)}` }], details: {}, isError: true }; }
    },
  });
}
