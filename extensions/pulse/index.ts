import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { openSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { PulseStore } from "./store.ts";
import { ApplicationStore } from "../api-server/application-store.ts";

const root = () => process.env.PI_PROFILE_ROOT ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const dbPath = () => join(root(), "pulse.db");
const statePath = () => join(root(), "pulse-tick.state.json");
const logPath = () => join(root(), "pulse-tick.log");
const TICK_INTERVAL_MS = 60_000;
type State = { pid: number; owner?: string; startedAt: string };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function json<T>(path: string): Promise<T | undefined> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return undefined; } }
async function write(path: string, value: unknown, exclusive = false) { await mkdir(root(), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: exclusive ? "wx" : "w" }); }

/** The SQLite lease is the singleton authority; the state file is diagnostic only. */
async function acquireTickLock(store: PulseStore): Promise<{ owner: string; release: () => Promise<void> } | undefined> {
  const owner = randomUUID();
  if (!store.claimTickLease(owner)) return undefined;
  const state: State = { pid: process.pid, owner, startedAt: new Date().toISOString() };
  await write(statePath(), state);
  return { owner, release: async () => {
    store.releaseTickLease(owner);
    const current = await json<State>(statePath());
    if (current?.owner === owner) await unlink(statePath()).catch(() => {});
  } };
}

export async function profileModelArgs(profile: string, agentDir = root()): Promise<string[]> {
  const settingsPath = profile === "default" ? join(agentDir, "settings.json") : join(agentDir, "profiles", profile, "settings.json");
  const settings = await json<Record<string, unknown>>(settingsPath);
  const provider = typeof settings?.defaultProvider === "string" ? settings.defaultProvider.trim() : "";
  const model = typeof settings?.defaultModel === "string" ? settings.defaultModel.trim() : "";
  return provider && model ? ["--provider", provider, "--model", model] : [];
}

function sessionDirectory(profile: string): string { return join(root(), profile === "default" ? "sessions" : join("profiles", profile, "sessions")); }
export function pulseSessionId(type: "cron" | "heartbeat", date = new Date()): string { return `pulse-${type}_${date.toISOString().slice(0, 16).replace("T", "-").replace(":", "-")}`; }

async function sessionFile(profile: string, id: string): Promise<{ file: string; cwd: string } | undefined> {
  const directory = sessionDirectory(profile);
  const visit = async (path: string): Promise<string | undefined> => { for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) { const candidate = join(path, entry.name); if (entry.isDirectory()) { const match = await visit(candidate); if (match) return match; } else if (entry.isFile() && entry.name.endsWith(`_${id}.jsonl`)) return candidate; } };
  const file = await visit(directory); if (!file) return undefined;
  const header = JSON.parse((await readFile(file, "utf8")).split("\n", 1)[0]) as { cwd?: string };
  return { file, cwd: header.cwd || process.cwd() };
}
async function createPulseSession(profile: string, type: "cron" | "heartbeat", cwd: string): Promise<{ id: string; file: string }> {
  const base = pulseSessionId(type); let id = base, suffix = 2;
  while (await sessionFile(profile, id)) id = `${base}-${String(suffix++).padStart(2, "0")}`;
  const session = SessionManager.create(cwd, sessionDirectory(profile), { id });
  session.appendSessionInfo(id);
  const file = session.getSessionFile();
  if (!file) throw new Error("Unable to create the Pulse execution session.");
  return { id, file };
}

async function appendPulseResult(profile: string, sessionId: string, content: string, details: Record<string, unknown>): Promise<void> {
  const target = await sessionFile(profile, sessionId);
  if (!target) throw new Error(`Session '${sessionId}' was not found for profile '${profile}'.`);
  SessionManager.open(target.file, sessionDirectory(profile), target.cwd).appendCustomMessageEntry("pulse", content, true, details);
}

function table(profile?: string) { const rows = new PulseStore(dbPath()).list(profile); const columns: Array<[string, number]> = [["STATUS", 8], ["TYPE", 9], ["NAME", 20], ["SCHEDULE", 20], ["THREAD SESSION", 24], ["NEXT RUN", 20], ["LAST RUN", 20]]; const clip = (v: string, n: number) => v.length > n ? `${v.slice(0, n - 1)}…` : v; const row = (values: string[]) => `│ ${values.map((v, i) => clip(v, columns[i][1]).padEnd(columns[i][1])).join(" │ ")} │`; const line = `┼${columns.map(([, n]) => "─".repeat(n + 2)).join("┼")}┼`; console.log(line.replaceAll("┼", "┬").replace(/^┬/, "┌").replace(/┬$/, "┐")); console.log(row(columns.map(([n]) => n))); console.log(line); for (const item of rows) { const color = item.enabled ? "\x1b[32m" : "\x1b[38;2;245;194;215m"; console.log(`${color}${row([item.enabled ? "enabled" : "disabled", item.type, item.name, item.schedule, item.thread_session_id, item.nextRunAt ?? "—", item.lastRunAt ?? "—"])}\x1b[0m`); } if (!rows.length) console.log(row(["—", "—", "No pulses configured", "—", "—", "—", "—"])); console.log(line.replaceAll("┼", "┴").replace(/^┴/, "└").replace(/┴$/, "┘")); }
async function start() { const current = await json<State>(statePath()); if (current && alive(current.pid)) return console.log(`Pulse tick is already running (PID ${current.pid}).`); const fd = openSync(logPath(), "a"); const child = spawn("sh", ["-c", "tail -f /dev/null | \"$@\"", "pi-pulse-tick", process.execPath, process.argv[1], "pulse", "tick"], { cwd: process.cwd(), detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, PI_PULSE_TICK: "1" } }); child.unref(); console.log(`Pulse tick starting (PID ${child.pid}).`); }
async function stop() { const current = await json<State>(statePath()); if (!current || !alive(current.pid)) return console.log("Pulse tick is not running."); try { process.kill(-current.pid, "SIGTERM"); } catch { process.kill(current.pid, "SIGTERM"); } console.log(`Pulse tick stopping (PID ${current.pid}).`); }
async function restart() {
  const current = await json<State>(statePath());
  await stop();
  if (current) for (let attempt = 0; attempt < 50 && alive(current.pid); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (current && alive(current.pid)) throw new Error(`Pulse tick (PID ${current.pid}) did not stop within 5 seconds.`);
  await start();
}
async function status() { const state = await json<State>(statePath()); const store = new PulseStore(dbPath()); const enabled = store.list().filter((item) => item.enabled).length; console.log(!state || !alive(state.pid) ? `Pulse tick: stopped (${enabled} enabled pulses)` : `Pulse tick: running (PID ${state.pid}, ${enabled} enabled pulses, since ${state.startedAt})`); }
async function executePulse(store: PulseStore, pulse: Awaited<ReturnType<PulseStore["claimDue"]>>[number], owner: string) {
  const renew = setInterval(() => { store.renewClaim(pulse.pulse.id, pulse.runId, owner); store.claimTickLease(owner); }, 30_000);
  try {
    const handoff = pulse.pulse.type === "heartbeat" ? store.handoff(pulse.pulse.id) : "";
    const message = `[Pulse: ${pulse.pulse.name}]\n${pulse.pulse.prompt}${handoff ? `\n\nPrevious heartbeat state (private):\n${handoff}` : ""}`;
    const source = pulse.pulse.thread_session_id ? await sessionFile(pulse.pulse.profile, pulse.pulse.thread_session_id) : undefined;
    if (pulse.pulse.thread_session_id && !source) throw new Error(`Thread session '${pulse.pulse.thread_session_id}' was not found for profile '${pulse.pulse.profile}'.`);
    const execution = await createPulseSession(pulse.pulse.profile, pulse.pulse.type, source?.cwd ?? process.cwd());
    store.setRunSession(pulse.runId, execution.id);
    const modelArgs = await profileModelArgs(pulse.pulse.profile);
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [process.argv[1], "profile", pulse.pulse.profile, "--session", execution.file, ...modelArgs, "--print", message], { cwd: source?.cwd ?? process.cwd(), env: { ...process.env, PI_PULSE_TICK: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", error = "";
      child.stdout.on("data", (data) => output += String(data)); child.stderr.on("data", (data) => error += String(data));
      child.once("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(error.trim() || `Pi exited with ${code}`)));
      child.once("error", reject);
    });
    const content = `[Pulse: ${pulse.pulse.name}]\n${result}`;
    const details = { pulseId: pulse.pulse.id, pulseName: pulse.pulse.name, runId: pulse.runId, executionSessionId: execution.id, type: pulse.pulse.type, completedAt: new Date().toISOString() };
    if (pulse.pulse.thread_session_id) await appendPulseResult(pulse.pulse.profile, pulse.pulse.thread_session_id, content, details);
    if (pulse.pulse.insertIntoApiSession) {
      const applications = new ApplicationStore(join(root(), "applications.db"));
      for (const active of applications.activeSessions({ profile: pulse.pulse.profile })) {
        try { await appendPulseResult(pulse.pulse.profile, active.sessionId, content, { ...details, application: active.application }); }
        catch (error) { console.error(`Unable to insert Pulse '${pulse.pulse.name}' into Application '${active.application}' session '${active.sessionId}': ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    store.complete(pulse.pulse, pulse.runId, result, pulse.pulse.type === "heartbeat" ? result.slice(-8000) : undefined, owner);
  } catch (error) { store.fail(pulse.pulse, pulse.runId, error instanceof Error ? error.message : String(error), owner); }
  finally { clearInterval(renew); }
}
async function tick() {
  const store = new PulseStore(dbPath());
  const lock = await acquireTickLock(store);
  if (!lock) return console.log("Pulse tick is already running.");
  const { owner, release } = lock;
  const expiredClaims = store.expiredClaims();
  if (expiredClaims) console.error(`Pulse tick found ${expiredClaims} expired active claim(s). Run 'pi pulse recover' only after confirming their workers are gone.`);
  let stopped = false, wake: (() => void) | undefined;
  const active = new Set<Promise<void>>();
  const launch = (pulse: Awaited<ReturnType<PulseStore["claimDue"]>>[number]) => {
    let task: Promise<void>;
    task = executePulse(store, pulse, owner).catch((error) => console.error(`Unexpected failure in Pulse '${pulse.pulse.name}': ${error instanceof Error ? error.message : String(error)}`)).finally(() => active.delete(task));
    active.add(task);
  };
  const close = () => { stopped = true; wake?.(); };
  process.once("SIGTERM", close); process.once("SIGINT", close);
  try {
    while (!stopped) {
      if (!store.claimTickLease(owner)) { console.error("Pulse tick lost its SQLite lease; stopping."); break; }
      // Claiming is atomic and exclusive per Pulse. Workers are intentionally
      // launched independently so unrelated scheduled work can overlap.
      for (const pulse of store.claimDue(undefined, owner)) { if (stopped) break; launch(pulse); }
      await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, TICK_INTERVAL_MS); }); wake = undefined;
    }
  } finally {
    // Do not release the scheduler lease while this tick still owns work.
    await Promise.allSettled([...active]);
    await release();
  }
}
export async function handlePulseCli(args: string[], selectedProfile?: string): Promise<boolean> { if (args[0] !== "pulse") return false; const profileIndex = args.indexOf("--profile"); const profile = selectedProfile ?? (profileIndex >= 0 ? args[profileIndex + 1] : undefined); if (args[1] === "tick" && process.env.PI_PULSE_TICK === "1") { await tick(); return true; } switch (args[1]) { case "start": await start(); break; case "stop": await stop(); break; case "restart": await restart(); break; case "status": await status(); break; case "list": table(profile); break; case "recover": { const recovered = new PulseStore(dbPath()).recoverExpiredClaims(profile); console.log(`Recovered ${recovered} expired Pulse claim(s).`); break; } case "enable": case "disable": { const name = args[2]; if (!name) throw new Error("Usage: pi pulse enable|disable <name>"); new PulseStore(dbPath()).setEnabled(name, args[1] === "enable", profile); console.log(`Pulse '${name}' ${args[1]}d.`); break; } default: console.error("Usage: pi pulse start | stop | restart | status | list | recover | enable <name> | disable <name>"); process.exitCode = 1; } return true; }
export default async function (pi: ExtensionAPI) {
  if (await handlePulseCli(process.argv.slice(2))) process.exit();
  pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n\nWhen the user asks to schedule, automate, remind, run future work, or manage an existing schedule, use the schedule tool. Do not ask for a thread or session ID: creation binds the schedule to this conversation automatically.` }));
  pi.registerTool({
    name: "schedule",
    label: "Manage schedule",
    description: "Create, list, edit, enable, disable, or delete cron jobs, heartbeats, reminders, and future schedules. Use this whenever the user asks to schedule or manage scheduled work. When the user asks to notify or deliver the result through an Application channel such as WhatsApp, set insertIntoApiSession=true; this only records the result in active Application sessions, while sending remains the Pulse prompt/Skill's responsibility.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("update"), Type.Literal("enable"), Type.Literal("disable"), Type.Literal("delete")]),
      name: Type.Optional(Type.String({ description: "Schedule name. Required except when listing." })),
      description: Type.Optional(Type.String({ description: "Human-readable purpose, required for create." })),
      schedule: Type.Optional(Type.String({ description: "Five-field UTC cron expression or @once:<ISO-8601>. Required for create." })),
      prompt: Type.Optional(Type.String({ description: "Markdown instructions, required for create." })),
      insertIntoApiSession: Type.Optional(Type.Boolean({ description: "Set true when the Pulse result should also be inserted into every active Application session for this profile. This records context only; it does not send through an outbound handler." })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const profile = process.env.PI_ACTIVE_PROFILE ?? "default", store = new PulseStore(dbPath());
        if (params.action === "list") { const pulses = store.list(profile); return { content: [{ type: "text", text: JSON.stringify(pulses) }], details: { pulses } }; }
        if (!params.name) throw new Error("A schedule name is required.");
        if (params.action === "create") {
          if (!params.description || !params.schedule || !params.prompt) throw new Error("Create requires name, description, schedule, and prompt.");
          const threadSessionId = ctx.sessionManager.getSessionId(); if (!threadSessionId) throw new Error("A persistent conversation session is required to create a schedule.");
          const pulse = store.create({ name: params.name, description: params.description, schedule: params.schedule, prompt: params.prompt, insertIntoApiSession: params.insertIntoApiSession === true, profile, thread_session_id: threadSessionId }); await start();
          return { content: [{ type: "text", text: JSON.stringify(pulse) }], details: pulse };
        }
        if (params.action === "enable" || params.action === "disable") { const pulse = store.setEnabled(params.name, params.action === "enable", profile); return { content: [{ type: "text", text: JSON.stringify(pulse) }], details: pulse }; }
        if (params.action === "delete") { store.delete(params.name, profile); return { content: [{ type: "text", text: `Schedule '${params.name}' deleted.` }], details: {} }; }
        const current = store.get(params.name, profile); if (!current) throw new Error("Schedule not found.");
        const pulse = store.update(params.name, profile, { description: params.description ?? current.description, schedule: params.schedule ?? current.schedule, prompt: params.prompt ?? current.prompt, thread_session_id: current.thread_session_id, insertIntoApiSession: params.insertIntoApiSession ?? current.insertIntoApiSession });
        return { content: [{ type: "text", text: JSON.stringify(pulse) }], details: pulse };
      } catch (error) { return { content: [{ type: "text", text: `Unable to manage schedule: ${error instanceof Error ? error.message : String(error)}` }], details: {}, isError: true }; }
    },
  });
}
