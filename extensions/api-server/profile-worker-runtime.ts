/** On-demand, serialized execution lanes. A lane never changes its profile. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ClientRequest } from "./openai-client-contract.ts";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { globSync } from "node:fs";
import { extensionCatalog } from "../lib/extension-catalog.ts";
import { parseProfileEnv } from "../lib/profile-env.ts";
import { CompatibilityError, type CompletionResult, type ExecutionEvent } from "./openai-contract.ts";
import { attachmentError, attachmentFailures, providerFailure } from "./openai-errors.ts";
import { WORKER_EVENT_PREFIX } from "./openai-execution.ts";
import type { ClientLaunch } from "./openai-client-runtime.ts";
import type { ProfileJob } from "./profile-worker.ts";

const TIMEOUT_KEY = "PI_API_WORKER_IDLE_TIMEOUT_SECONDS";
const MAX_TIMER = 2_147_483_647;
const failure = () => new CompatibilityError("Pi worker execution failed. Server actions were not replayed.", null, 502, "worker_transport_error");
import { latencyMs, readWorkerLatency, type LatencyTrace } from "./latency-trace.ts";

type Emit = (event: ExecutionEvent) => Promise<void>;
type Pending = { trace?: LatencyTrace; emit: Emit; activity?: (event: Record<string, unknown>) => void; telemetry?: (value: any) => void; resolve(result: CompletionResult): void; reject(error: unknown): void; text: string; ready: boolean; result?: CompletionResult; error?: Error };
type Lane = { tail: Promise<void>; reservations: number; worker?: Worker };

class Worker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly done: Promise<void>;
  idleSince = Date.now();
  timer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;
  private pending?: Pending;
  private clientFrame?: (frame: unknown) => Promise<void>;
  private closed = false;
  private reader: Promise<void>;
  private buffer = "";
  version: string;
  private initialized = false;
  private readonly startupVersion?: () => Promise<string>;
  constructor(launch: ClientLaunch, version: string, startupVersion?: () => Promise<string>) {
    this.version = version; this.startupVersion = startupVersion;
    this.child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: { ...launch.env, PI_PROFILE_WORKER: "1" }, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => this.stop());
    // Only explicitly tagged memory telemetry may leave stderr. Provider error
    // text can contain credentials; never include it in HTTP errors or logs.
    this.child.stderr.setEncoding("utf8");
    let stderr = "";
    this.child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      let end: number;
      while ((end = stderr.indexOf("\n")) >= 0) {
        const line = stderr.slice(0, end); stderr = stderr.slice(end + 1);
        if (line.startsWith("PI_CONTEXT_MEMORY_LOG:")) try { this.pending?.telemetry?.(JSON.parse(line.slice("PI_CONTEXT_MEMORY_LOG:".length))); } catch { /* Ignore malformed telemetry. */ }
      }
      if (stderr.length > 65_536) stderr = "";
    });
    this.reader = this.read().catch(() => this.stop());
    this.done = new Promise<void>((resolve) => {
      const ended = () => {
        this.closed = true;
        this.pending?.reject(failure()); this.pending = undefined;
        if (this.timer) clearTimeout(this.timer);
        if (this.killTimer) clearTimeout(this.killTimer);
        this.kill(true); resolve();
      };
      this.child.once("error", ended);
      this.child.once("close", () => { void this.reader.finally(ended); });
    });
  }
  get alive(): boolean { return !this.closed; }
  private kill(force = false): void {
    try { if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, force ? "SIGKILL" : "SIGTERM"); else this.child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* Already exited. */ }
  }
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.pending?.reject(failure()); this.pending = undefined;
    // SIGTERM allows extension cleanup; the entire process group is reaped even
    // if a descendant keeps a pipe open or ignores graceful shutdown.
    this.kill(); this.killTimer = setTimeout(() => this.kill(true), 1000); this.killTimer.unref();
  }
  async execute(job: ProfileJob, emit: Emit, signal: AbortSignal, activity?: Pending["activity"], telemetry?: Pending["telemetry"], trace?: LatencyTrace): Promise<CompletionResult> {
    signal.throwIfAborted();
    if (!this.alive || this.pending) throw failure();
    if (this.timer) clearTimeout(this.timer);
    const abort = () => this.stop();
    signal.addEventListener("abort", abort, { once: true });
    const startup = setTimeout(abort, 60_000); startup.unref();
    try {
      return await new Promise<CompletionResult>((resolve, reject) => {
        this.pending = { trace, emit: async (event) => {
          if (event.type === "ready") {
            clearTimeout(startup);
            if (!this.initialized) {
              // Profile synchronization/sandbox preparation can create their
              // own resources. Snapshot after initialization, not before boot.
              if (this.startupVersion) {
                const baselineStart = trace ? performance.now() : 0;
                try { this.version = await this.startupVersion(); }
                finally { if (trace) trace.workerBaselineMs = latencyMs(performance.now() - baselineStart); }
              }
              this.initialized = true;
            }
          }
          await emit(event);
        }, activity, telemetry, resolve, reject, text: "", ready: false };
        const wire = JSON.stringify({ type: "execute", job }) + "\n";
        if (Buffer.byteLength(wire) > 210 * 1024 * 1024) { this.stop(); return; }
        if (trace) trace.dispatchMs = latencyMs(performance.now() - trace.started);
        this.child.stdin.write(wire, (error) => { if (error) this.stop(); });
        if (signal.aborted) abort();
      });
    } catch (error) {
      this.stop();
      if (signal.aborted) signal.throwIfAborted();
      throw error;
    } finally { clearTimeout(startup); signal.removeEventListener("abort", abort); }
  }
  send(value: unknown): void {
    this.child.stdin.write(JSON.stringify(value) + "\n", (error) => { if (error) this.stop(); });
  }
  async client(input: ClientRequest, frame: (value: any) => Promise<void>, signal: AbortSignal): Promise<void> {
    this.clientFrame = frame;
    try { await this.execute({ request: input.request, client: input }, async () => {}, signal); }
    finally { this.clientFrame = undefined; }
  }
  private async read(): Promise<void> {
    this.child.stdout.setEncoding("utf8");
    for await (const chunk of this.child.stdout) {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 34 * 1024 * 1024) throw failure();
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.startsWith(WORKER_EVENT_PREFIX)) continue;
        const value = JSON.parse(line.slice(WORKER_EVENT_PREFIX.length)), p = this.pending;
        if (!p) throw failure();
        if (value.type === "idle") {
          this.pending = undefined; this.idleSince = Date.now();
          if (p.trace) {
            p.trace.untilIdleMs = latencyMs(performance.now() - p.trace.started);
            p.trace.retired = value.retire === true || !!p.error || !p.result;
          }
          if (p.error) { p.reject(p.error); this.stop(); }
          else if (!p.result) { p.reject(failure()); this.stop(); }
          else { if (value.retire === true) this.stop(); p.resolve(p.result); }
        } else if (this.clientFrame) {
          if (value.type === "ready") { p.ready = true; await p.emit({ type: "ready" }); }
          if (value.type === "result") p.result = value.result;
          await this.clientFrame(value);
        } else if (p.result || p.error) throw failure();
        else if (value.type === "ready") {
          if (p.ready) throw failure();
          p.ready = true;
          if (p.trace) p.trace.untilReadyMs = latencyMs(performance.now() - p.trace.started);
          await p.emit({ type: "ready" });
        }
        else if (value.type === "text") {
          if (!p.ready || typeof value.delta !== "string") throw failure();
          if (p.trace && value.delta) p.trace.untilFirstTextMs ??= latencyMs(performance.now() - p.trace.started);
          p.text += value.delta;
          if (Buffer.byteLength(p.text) > 16 * 1024 * 1024) throw failure();
          await p.emit({ type: "text", delta: value.delta });
        } else if (value.type === "latency" && p.trace) p.trace.execution = readWorkerLatency(value.metrics);
        else if (value.type === "activity") p.activity?.(value.event);
        else if (value.type === "result") {
          const r = value.result;
          if (!p.ready || !r || r.text !== p.text || !["stop", "length"].includes(r.finishReason) || !r.usage || ["input", "output", "cached", "reasoning"].some((key) => !Number.isFinite(r.usage[key]) || r.usage[key] < 0)) throw failure();
          if (p.trace) p.trace.untilResultMs = latencyMs(performance.now() - p.trace.started);
          p.result = r;
        } else if (value.type === "failure") p.error = providerFailure(value.code) ?? (Object.hasOwn(attachmentFailures, value.code) ? attachmentError(value.code) : new CompatibilityError("Pi execution failed.", null, 502, ["output_rewritten", "output_limit_exceeded", "slow_consumer", "response_missing", "profile_model_unavailable"].includes(value.code) ? value.code : "generation_failed"));
        else throw failure();
      }
    }
  }
}

export type ProfileWorkerOptions = {
  agentDir: string;
  launch(profile: string): ClientLaunch;
  version?(profile: string): Promise<string>;
  warn?(message: string): void;
  /** Tests can shorten only the configuration polling interval. */
  reloadIntervalMs?: number;
};

export class ProfileWorkerRuntime {
  private lanes = new Map<string, Lane>();
  private workers = new Set<Worker>();
  private closed = false;
  private seconds = 600;
  private watcher?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;
  private initialized?: Promise<void>;
  private readonly options: ProfileWorkerOptions;
  constructor(options: ProfileWorkerOptions) { this.options = options; }
  get size(): number { return [...this.workers].filter((worker) => worker.alive).length; }
  isBusy(profile: string): boolean { return !!this.lanes.get(profile)?.reservations; }
  async refreshTimeout(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const source = await readFile(join(this.options.agentDir, ".env"), "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
        const raw = parseProfileEnv(source)[TIMEOUT_KEY];
        const seconds = raw === undefined ? 600 : /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > Number.MAX_SAFE_INTEGER / 1000) throw new Error("Invalid timeout");
        this.seconds = seconds;
        for (const lane of this.lanes.values()) this.expire(lane);
      } catch { this.options.warn?.(`[pi-api] Invalid or unreadable worker idle timeout; keeping ${this.seconds} seconds.`); }
    })();
    try { await this.refreshing; } finally { this.refreshing = undefined; }
  }
  private initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      await this.refreshTimeout();
      if (this.closed) return;
      this.watcher = setInterval(() => { void this.refreshTimeout(); }, this.options.reloadIntervalMs ?? 60_000); this.watcher.unref();
    })();
  }
  private expire(lane: Lane): void {
    const worker = lane.worker;
    if (!worker) return;
    if (worker.timer) clearTimeout(worker.timer);
    if (lane.reservations || !worker.alive) return;
    const delay = worker.idleSince + this.seconds * 1000 - Date.now();
    if (delay <= 0) { worker.stop(); return; }
    worker.timer = setTimeout(() => this.expire(lane), Math.min(delay, MAX_TIMER)); worker.timer.unref();
  }
  async execute(profile: string, job: ProfileJob, emit: Emit, signal: AbortSignal, activity?: Pending["activity"], telemetry?: Pending["telemetry"], trace?: LatencyTrace): Promise<CompletionResult> {
    return this.run(profile, signal, (worker) => worker.execute(trace ? { ...job, traceLatency: true } : job, emit, signal, activity, telemetry, trace), trace);
  }
  /** A request-scoped pipe facade preserves the validated client actor protocol.
   * Closing it releases the lane, not the healthy resident profile process. */
  clientTransport(profile: string): ChildProcessWithoutNullStreams {
    const transport = new EventEmitter() as ChildProcessWithoutNullStreams;
    const output = new PassThrough(); const stderr = new PassThrough();
    const controller = new AbortController();
    let active: Worker | undefined, started = false, ended = false, buffer = "";
    const finish = (code: number) => {
      if (ended) return;
      ended = true; output.end(); stderr.end();
      setImmediate(() => transport.emit("close", code));
    };
    const stdin = new Writable({ write: (chunk, _encoding, callback) => {
      try {
        buffer += chunk.toString();
        if (Buffer.byteLength(buffer) > 210 * 1024 * 1024) throw failure();
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (!started) {
            if (value.type !== "init" || !value.input) throw failure();
            started = true;
            void this.run(profile, controller.signal, async (worker) => {
              active = worker;
              await worker.client(value.input, async (frame) => {
                if (!output.write(`${WORKER_EVENT_PREFIX}${JSON.stringify(frame)}\n`)) throw failure();
              }, controller.signal);
            }).then(() => finish(0), (error) => {
              if (!ended) output.write(`${WORKER_EVENT_PREFIX}${JSON.stringify({ type: "failure", code: error instanceof CompatibilityError ? error.code : "worker_transport_error" })}\n`);
              finish(1);
            });
          } else {
            if (!active || value.type !== "resume") throw failure();
            active.send(value);
          }
        }
        callback();
      } catch (error) { controller.abort(); finish(1); callback(error as Error); }
    } });
    Object.assign(transport, { stdin, stdout: output, stderr, pid: undefined, kill: () => { if (!ended) { controller.abort(); finish(1); } return true; } });
    return transport;
  }
  private async run<T>(profile: string, signal: AbortSignal, operation: (worker: Worker) => Promise<T>, trace?: LatencyTrace): Promise<T> {
    signal.throwIfAborted();
    if (this.closed) throw new CompatibilityError("The worker runtime is shutting down.", null, 503, "worker_unavailable");
    let lane = this.lanes.get(profile);
    if (!lane) { lane = { tail: Promise.resolve(), reservations: 0 }; this.lanes.set(profile, lane); }
    // A bounded lane avoids an unlimited backlog behind a long tool execution.
    if (lane.reservations >= 64) throw new CompatibilityError("The profile execution queue is full.", null, 429, "worker_capacity");
    const previous = lane.tail;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    lane.tail = previous.then(() => slot);
    lane.reservations++;
    if (lane.worker?.timer) clearTimeout(lane.worker.timer);
    // Cancellation of a queued job never kills the active job. Keep its queue
    // slot chained until predecessors finish, without keeping HTTP open.
    let aborted!: () => void;
    const cancelled = new Promise<never>((_, reject) => { aborted = () => reject(signal.reason ?? new Error("Aborted")); signal.addEventListener("abort", aborted, { once: true }); if (signal.aborted) aborted(); });
    const queuedAt = trace ? performance.now() : 0;
    try {
      try { await Promise.race([previous, cancelled]); }
      finally { if (trace) trace.queueMs = latencyMs(performance.now() - queuedAt); }
      signal.throwIfAborted();
      await this.initialize();
      if (this.closed) throw failure();
      const version = await (this.options.version?.(profile) ?? Promise.resolve(""));
      if (lane.worker && (!lane.worker.alive || lane.worker.version !== version)) { lane.worker.stop(); await lane.worker.done; lane.worker = undefined; }
      signal.throwIfAborted();
      if (this.closed) throw failure();
      if (trace) trace.worker = lane.worker ? "reused" : "cold";
      if (!lane.worker) {
        const worker = lane.worker = new Worker(this.options.launch(profile), version, this.options.version ? () => this.options.version!(profile) : undefined);
        this.workers.add(worker); void worker.done.then(() => this.workers.delete(worker));
      }
      if (trace) trace.launcherPid = lane.worker.child.pid;
      return await operation(lane.worker);
    } finally {
      signal.removeEventListener("abort", aborted);
      // Releasing early is safe: lane.tail still waits for previous.
      release(); lane.reservations--; this.expire(lane);
    }
  }
  async invalidate(profile: string): Promise<void> {
    const lane = this.lanes.get(profile);
    if (!lane?.worker) return;
    lane.worker.stop(); await lane.worker.done; lane.worker = undefined;
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.watcher) clearInterval(this.watcher);
    for (const worker of this.workers) worker.stop();
    await Promise.all([...this.workers].map((worker) => worker.done));
  }
}

/** Content hashes for configuration; metadata for local resource trees. No
 * transcripts, credentials or personal memory are retained in this signature. */
export async function profileWorkerVersion(root: string, directory: string): Promise<string> {
  try { return await fingerprintResources(root, directory); }
  catch { throw new CompatibilityError("Profile execution resources could not be loaded.", null, 502, "worker_configuration_error"); }
}

async function fingerprintResources(root: string, directory: string): Promise<string> {
  const hash = createHash("sha256");
  const visited = new Set<string>();
  const walk = async (path: string): Promise<void> => {
    if (visited.has(path)) return;
    visited.add(path);
    const metadata = await stat(path).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!metadata) return;
    hash.update(`${path}:${metadata.mtimeMs}:${metadata.size}`);
    if (!metadata.isDirectory()) return;
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (["node_modules", ".git", ".next"].includes(entry.name) || entry.isSymbolicLink()) continue;
      await walk(join(path, entry.name));
    }
  };
  const rootSettings = JSON.parse(await readFile(join(root, "settings.json"), "utf8").catch((error) => { if (error.code === "ENOENT") return "{}"; throw error; }));
  for (const extension of await extensionCatalog(root, rootSettings)) if (extension.enabled) {
    await walk(/^index\.[cm]?[jt]s$/.test(basename(extension.path)) ? dirname(extension.path) : extension.path);
    await walk(join(dirname(extension.path), "lib"));
  }
  for (const base of new Set([root, directory])) {
    const settings = JSON.parse(await readFile(join(base, "settings.json"), "utf8").catch((error) => { if (error.code === "ENOENT") return "{}"; throw error; }));
    for (const kind of ["skills", "prompts", "themes"]) for (const declaration of Array.isArray(settings[kind]) ? settings[kind] : []) {
      if (typeof declaration !== "string" || /^[!-]/.test(declaration)) continue;
      const path = resolve(base, declaration.replace(/^\+/, "").replace(/^~\//, `${homedir()}/`));
      for (const resource of /[*?\[{}]/.test(path) ? globSync(path) : [path]) await walk(resource);
    }
    for (const name of ["settings.json", "models.json", "auth.json", "guardrails.json", "mcp.json", "SOUL.md", ".env"]) {
      let value = await readFile(join(base, name), "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
      if (base === root && name === ".env") { const values = parseProfileEnv(value); delete values[TIMEOUT_KEY]; value = JSON.stringify(values); }
      hash.update(base + name + value);
    }
    for (const name of ["extensions", "guardrails", "skills", "prompts", "themes"]) await walk(join(base, name));
  }
  return hash.digest("hex");
}
