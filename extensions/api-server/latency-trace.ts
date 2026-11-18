import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const LATENCY_TRACE_HEADER = "x-pi-trace-latency";
export const LATENCY_ID_HEADER = "x-pi-trace-id";
export const latencyMs = (duration: number) => Math.round(Math.max(0, duration) * 10) / 10;

const workerKeys = ["workerPid", "agentInitMs", "promptMs", "firstModelStartMs", "modelActiveMs", "modelStreams", "modelStreamsCompleted", "sessionCleanupMs"] as const;
export type WorkerLatency = Partial<Record<(typeof workerKeys)[number], number>>;
export type LatencyTrace = {
  started: number;
  queueMs?: number;
  dispatchMs?: number;
  untilReadyMs?: number;
  untilFirstTextMs?: number;
  untilResultMs?: number;
  workerBaselineMs?: number;
  untilIdleMs?: number;
  launcherPid?: number;
  worker?: "cold" | "reused";
  retired?: boolean;
  execution?: WorkerLatency;
};
export type LatencyRecord = Omit<LatencyTrace, "started"> & {
  id: string;
  protocol: "chat" | "responses";
  stream: boolean;
  outcome: "success" | "error" | "aborted";
  totalMs: number;
};

/** Rebuild the record from numeric fields only. Never pass worker diagnostics through. */
export function readWorkerLatency(input: unknown): WorkerLatency | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>, result: WorkerLatency = {};
  for (const key of workerKeys) {
    const n = record[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER / 10) result[key] = latencyMs(n);
  }
  return result;
}

/** Observe the SDK model boundary without consuming, wrapping, or delaying its stream. */
export function observeModelLatency(runtime: ModelRuntime, metrics: WorkerLatency) {
  const original = runtime.streamSimple;
  const descriptor = Object.getOwnPropertyDescriptor(runtime, "streamSimple");
  let promptStart: number | undefined, modelStart = 0, active = 0, busyMs = 0;
  const streamSimple: ModelRuntime["streamSimple"] = function (this: ModelRuntime, ...args) {
    if (promptStart === undefined) return original.apply(this, args);
    const now = performance.now();
    metrics.firstModelStartMs ??= latencyMs(now - promptStart);
    metrics.modelStreams = (metrics.modelStreams ?? 0) + 1;
    if (active++ === 0) modelStart = now;
    const finish = () => {
      if (promptStart === undefined) return;
      metrics.modelStreamsCompleted = (metrics.modelStreamsCompleted ?? 0) + 1;
      if (--active === 0) busyMs += performance.now() - modelStart;
    };
    let stream: ReturnType<ModelRuntime["streamSimple"]>;
    try { stream = original.apply(this, args); }
    catch (error) { finish(); throw error; }
    try { void stream.result().then(finish, finish); }
    catch { /* A custom stream may not offer observable completion. */ }
    return stream;
  };
  try { Object.defineProperty(runtime, "streamSimple", { configurable: true, writable: true, value: streamSimple }); }
  catch { /* A sealed runtime can still report prompt duration. */ }
  const observing = runtime.streamSimple === streamSimple;
  return {
    start() {
      promptStart = performance.now();
      if (observing) metrics.modelStreams = metrics.modelStreamsCompleted = 0;
    },
    end() {
      if (promptStart === undefined) return;
      const now = performance.now();
      metrics.promptMs = latencyMs(now - promptStart);
      if (observing) metrics.modelActiveMs = latencyMs(busyMs + (active ? now - modelStart : 0));
      promptStart = undefined;
    },
    restore() {
      if (runtime.streamSimple !== streamSimple) return;
      if (descriptor) Object.defineProperty(runtime, "streamSimple", descriptor);
      else Reflect.deleteProperty(runtime, "streamSimple");
    },
  };
}
