/** Profile-resident transport. Every job constructs and disposes its own session. */
import { createInterface } from "node:readline";
import { ProfileJobScope } from "./profile-job-scope.ts";
import { ClientWorker } from "./openai-client-worker.ts";
import { runCompatibilityWorker, WORKER_EVENT_PREFIX, type CompatibilityWorkerHooks, type ResidentExecution } from "./openai-execution.ts";
import type { CompletionRequest } from "./openai-contract.ts";
import type { ClientRequest } from "./openai-client-contract.ts";

export type ProfileJob = {
  request: CompletionRequest;
  client?: ClientRequest;
  application?: { sessionPath?: string; sessionId: string; application?: string; identityKey?: string; directContextMemory?: string; handoff?: string };
};

export async function runProfileWorker(host: typeof import("@earendil-works/pi-coding-agent"), clearExtensionCache: () => void): Promise<void> {
  process.env.PI_OPENAI_WORKER = "running";
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const resident: ResidentExecution = {};
  let busy = false, stopping = false;
  let client: ClientWorker | undefined;
  const write = (value: unknown) => {
    if (process.stdout.writableLength > 1024 * 1024) throw new Error("Worker consumer is too slow.");
    process.stdout.write(`${WORKER_EVENT_PREFIX}${JSON.stringify(value)}\n`);
  };
  // The parent owns cancellation and process-group termination. Never reuse a
  // cancelled runtime: tools/extensions may still have asynchronous work alive.
  const stop = () => { stopping = true; input.close(); if (!busy) process.exit(0); };
  process.once("SIGTERM", stop);
  process.stdin.once("end", stop);
  input.on("line", (line) => {
    if (stopping) return;
    if (Buffer.byteLength(line) > 210 * 1024 * 1024) return process.exit(1);
    let frame: any;
    try { frame = JSON.parse(line); } catch { return process.exit(1); }
    if (frame.type === "resume" && client && busy) { client.receive(frame); return; }
    if (frame.type === "shutdown" && !busy) return stop();
    if (frame.type !== "execute" || busy || !frame.job?.request) return process.exit(1);
    busy = true;
    void run(frame.job).then((reusable) => {
      busy = false;
      if (stopping) process.exit(0);
      write({ type: "idle", ...(!reusable ? { retire: true } : {}) });
    }).catch(() => process.exit(1));
  });
  async function run(job: ProfileJob): Promise<boolean> {
    clearExtensionCache();
    delete process.env.PI_PROFILE_WORKER_RETIRE;
    // Initialize lazy stdio handles before the job's lifecycle snapshot.
    void process.stdout; void process.stderr;
    const scope = new ProfileJobScope();
    resident.retire = false;
    // This is a single-profile process, with serialized jobs. Environment-backed
    // third-party extensions see request identity during factory/startup too.
    for (const key of Object.keys(process.env)) if (key.startsWith("PI_APPLICATION_")) delete process.env[key];
    const app = job.application;
    if (app) {
      process.env.PI_APPLICATION_SESSION_ID = app.sessionId;
      if (app.application) process.env.PI_APPLICATION_SLUG = app.application;
      if (app.identityKey) process.env.PI_APPLICATION_IDENTITY_KEY = app.identityKey;
      if (app.handoff) process.env.PI_APPLICATION_HANDOFF = app.handoff;
      if (app.directContextMemory !== undefined) process.env.PI_APPLICATION_DIRECT_CONTEXT_MEMORY = Buffer.from(app.directContextMemory).toString("base64url");
    }
    resident.application = app;
    resident.event = app ? (event) => {
      const e = event as any;
      if (e.type === "message_update" && ["thinking_start", "thinking_delta", "thinking_end"].includes(e.assistantMessageEvent?.type)) {
        write({ type: "activity", event: { type: e.type, assistantMessageEvent: { type: e.assistantMessageEvent.type, contentIndex: e.assistantMessageEvent.contentIndex } } });
      }
      // Activity only: do not duplicate complete messages or expose tool results
      // and thinking contents through the control channel.
      if (["agent_start", "agent_settled", "tool_execution_start", "tool_execution_end", "tool_execution_update"].includes(event.type)) {
        write({ type: "activity", event: { type: e.type, toolCallId: e.toolCallId, toolName: e.toolName, parentToolCallId: e.parentToolCallId, isError: e.isError } });
      }
    } : undefined;
    const hooks: CompatibilityWorkerHooks = {
      readRequest: async () => job.request,
      write,
      factory: () => {},
      attachmentBudget: { count: 0, bytes: 0 },
      prepare: async () => {},
      started: async () => {},
    };
    try {
      if (job.client) {
        client = new ClientWorker(job.client);
        try { await runCompatibilityWorker(host, client, resident); }
        finally { client.close(); client = undefined; }
      } else await runCompatibilityWorker(host, hooks, resident);
    } finally {
      clearExtensionCache();
      for (const key of Object.keys(process.env)) if (key.startsWith("PI_APPLICATION_")) delete process.env[key];
      resident.application = undefined; resident.event = undefined;
      const clean = await scope.finish();
      if (!clean || process.env.PI_PROFILE_WORKER_RETIRE === "1") resident.retire = true;
    }
    return !resident.retire;
  }
}
