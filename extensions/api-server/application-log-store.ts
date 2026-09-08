import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export type CallStage = { id: string; type: string; label: string; startedAt: string; finishedAt?: string; input?: unknown; output?: unknown; payload?: unknown; stdout: string[]; stderr: string[]; error?: string };
export type ApplicationCall = { id: string; application: string; origin: string; receivedAt: string; finishedAt?: string; status: "running" | "success" | "error"; headers: Record<string, unknown>; stages: CallStage[]; error?: string };
export class ApplicationLogStore {
  private calls = new Map<string, ApplicationCall>(); private events = new EventEmitter(); private directory: string;
  constructor(applicationDirectory: string, readonly application: string) { this.directory = join(applicationDirectory, "logs", "calls"); }
  async initialize() { await mkdir(this.directory, { recursive: true }); const cutoff = Date.now() - 7 * 86400000; for (const entry of await readdir(this.directory)) { const path = join(this.directory, entry); try { const call = JSON.parse(await readFile(path, "utf8")) as ApplicationCall; if (new Date(call.receivedAt).getTime() < cutoff) await rm(path); else this.calls.set(call.id, call); } catch {} } }
  private async save(call: ApplicationCall) { await mkdir(this.directory, { recursive: true }); await writeFile(join(this.directory, `${call.id}.json`), JSON.stringify(call), "utf8"); this.events.emit("event", { type: "call.updated", call }); }
  start(payload: unknown, headers: Record<string, unknown>) { const call: ApplicationCall = { id: randomUUID(), application: this.application, origin: String(headers["x-forwarded-for"] ?? headers.origin ?? headers.host ?? "unknown"), receivedAt: new Date().toISOString(), status: "running", headers, stages: [{ id: randomUUID(), type: "request", label: "Request", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), payload, stdout: [], stderr: [] }] }; this.calls.set(call.id, call); void this.save(call); return call; }
  stage(call: ApplicationCall, type: string, label: string, input: unknown) { const stage: CallStage = { id: randomUUID(), type, label, startedAt: new Date().toISOString(), input, stdout: [], stderr: [] }; call.stages.push(stage); void this.save(call); return stage; }
  complete(call: ApplicationCall, stage: CallStage, output: unknown) { stage.output = output; stage.finishedAt = new Date().toISOString(); void this.save(call); }
  fail(call: ApplicationCall, stage: CallStage | undefined, error: unknown) { const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error); if (stage) { stage.error = message; stage.finishedAt = new Date().toISOString(); } call.error = message; call.status = "error"; call.finishedAt = new Date().toISOString(); void this.save(call); }
  finish(call: ApplicationCall, output: unknown) { call.status = "success"; call.finishedAt = new Date().toISOString(); const stage = this.stage(call, "final-response", "Final response", output); this.complete(call, stage, output); }
  list() { return [...this.calls.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)); }
  get(id: string) { return this.calls.get(id); }
  async clear() { this.calls.clear(); await rm(this.directory, { recursive: true, force: true }); await mkdir(this.directory, { recursive: true }); this.events.emit("event", { type: "logs.cleared" }); }
  on(listener: (event: unknown) => void) { this.events.on("event", listener); return () => this.events.off("event", listener); }
}
