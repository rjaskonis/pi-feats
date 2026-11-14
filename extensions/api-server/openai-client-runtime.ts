/** Bounded, profile-scoped continuation actors; ordinary requests never allocate one. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CompatibilityError, normalizeRequest, type ExecutionEvent, type ConversationMessage, type CompletionRequest } from "./openai-contract.ts";
import { attachmentFailures, attachmentError } from "./openai-errors.ts";
import { WORKER_EVENT_PREFIX } from "./openai-execution.ts";
import { OPENAI_BODY_BYTES } from "../lib/openai-limits.ts";
import { CLIENT_LIMITS, acceptedClientTools, clientError, clientToolPolicy, clientOutputFingerprint, ensureInitialClientRequest, fingerprint, normalizeClientRequest, policyFingerprint, validateClientArguments, type ClientCall, type ClientLeg, type ClientRequest, type ClientOutput, type ClientToolPolicy } from "./openai-client-contract.ts";

export type ClientLaunch = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };
export type ClientRuntimeOptions = { settings(profile: string): Promise<unknown>; launch(profile: string): ClientLaunch; maxWorkers?: number; perProfile?: number };
type Emit = (event: ExecutionEvent) => Promise<void>;
type LegWaiter = { emit: Emit; signal: AbortSignal; abort(): void; resolve(value: ClientLeg): void; reject(error: Error): void; ready: boolean; text: string };
function safeFailure(code: unknown): CompatibilityError {
  if (typeof code === "string" && Object.hasOwn(attachmentFailures, code)) return attachmentError(code);
  const known: Record<string, [number, string]> = {
    client_tool_name_conflict: [400, "A client function conflicts with a profile tool."],
    client_tools_disabled: [403, "Client tools are disabled for this profile."],
    client_tools_policy_invalid: [502, "The profile client-tool policy is invalid."],
    client_tool_policy_changed: [409, "The profile client-tool policy changed. Start a new request without replaying server actions automatically."],
    invalid_client_result: [400, "Return exactly the outstanding client tool results."],
    client_tool_resume_conflict: [409, "The client continuation is not waiting."],
    profile_model_unavailable: [502, "The profile's configured model is unavailable."],
    context_too_large: [413, "The conversation exceeds the context limit."],
  };
  const value = typeof code === "string" ? known[code] : undefined;
  return value ? clientError(String(code), value[1], value[0]) : clientError("client_tool_execution_failed", "Pi client-tool execution failed.", 502);
}
function securityVersion(settings: any): string {
  return fingerprint({ policy: clientToolPolicy(settings), provider: settings?.defaultProvider, model: settings?.defaultModel, images: settings?.images, sandbox: settings?.sandbox, tools: settings?.profile?.enabledTools });
}

class ClientActor {
  readonly child: ChildProcessWithoutNullStreams;
  readonly issued = new Map<string, ClientCall>();
  readonly pending = new Map<string, ClientCall>();
  readonly completedOutputs = new Map<string, string>();
  private proposedOutputs?: ClientOutput[];
  readonly done: Promise<void>;
  state: "running" | "waiting" | "finishing" | "closed" = "running";
  version: string;
  private waiter?: LegWaiter;
  private result?: ClientLeg;
  private timer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;
  private buffer = "";
  private bytes = 0;
  private born = Date.now();
  private ended = false;
  private reader?: Promise<void>;
  readonly initial: ClientRequest;
  readonly policy: ClientToolPolicy;
  private notify: (actor: ClientActor, calls: ClientCall[]) => void;
  private removed: (actor: ClientActor) => void;
  private refreshed: () => Promise<string>;
  constructor(initial: ClientRequest, policy: ClientToolPolicy, version: string, launch: ClientLaunch, notify: (actor: ClientActor, calls: ClientCall[]) => void, removed: (actor: ClientActor) => void, refreshed: () => Promise<string>) {
    this.initial = initial; this.policy = policy; this.notify = notify; this.removed = removed; this.refreshed = refreshed;
    this.version = version;
    this.child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: { ...launch.env, PI_OPENAI_CLIENT_TOOLS_WORKER: "1" }, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume(); this.child.stdin.on("error", () => this.cancel());
    this.done = new Promise<void>((resolve) => {
      this.child.once("error", () => { this.ended = true; this.cancel(); resolve(); });
      this.child.once("close", (code) => {
        void (this.reader ?? Promise.resolve()).finally(() => {
          this.ended = true;
          if (code === 0 && this.result && !this.buffer.trim() && this.state !== "closed") this.settle(this.result);
          else this.reject(safeFailure(undefined));
          this.cleanup(); this.kill(true); resolve();
        });
      });
    });
    this.reader = this.read().catch(() => this.cancel());
    this.lease(60_000);
  }
  private kill(force = false): void {
    try { if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, force ? "SIGKILL" : "SIGTERM"); else this.child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* Already reaped. */ }
  }
  private lease(timeout = this.policy.timeoutMs): void {
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.min(timeout, this.born + 600_000 - Date.now());
    this.timer = setTimeout(() => this.cancel(clientError("client_tool_expired", "The client tool continuation expired. Server actions were not replayed.", 409)), Math.max(delay, 1)); this.timer.unref();
  }
  private detach(): LegWaiter | undefined {
    const waiter = this.waiter; this.waiter = undefined;
    if (waiter) waiter.signal.removeEventListener("abort", waiter.abort);
    return waiter;
  }
  private reject(error: Error): void { this.detach()?.reject(error); }
  private settle(leg: ClientLeg): void { this.detach()?.resolve(leg); }
  private attach(emit: Emit, signal: AbortSignal): Promise<ClientLeg> {
    signal.throwIfAborted();
    if (this.waiter || this.state === "closed") throw clientError("client_tool_resume_conflict", "The continuation is already in use or closed.", 409);
    return new Promise((resolve, reject) => {
      const abort = () => this.cancel(clientError("client_tool_cancelled", "Client execution was cancelled.", 502));
      this.waiter = { emit, signal, abort, resolve, reject, ready: false, text: "" };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  private send(value: unknown): void {
    const text = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(text) > OPENAI_BODY_BYTES + 1_048_576) throw clientError("request_too_large", "Client worker frame exceeds limit.", 413);
    this.child.stdin.write(text, (error) => { if (error) this.cancel(); });
  }
  start(emit: Emit, signal: AbortSignal): Promise<ClientLeg> {
    const pending = this.attach(emit, signal);
    try { this.send({ type: "init", input: { ...this.initial, outputs: [] } }); } catch (error) { this.cancel(error as Error); }
    return pending;
  }
  resume(outputs: ClientOutput[], additions: ConversationMessage[], emit: Emit, signal: AbortSignal): Promise<ClientLeg> {
    if (this.state !== "waiting") throw clientError("client_tool_resume_conflict", "The continuation is already running.", 409);
    if (outputs.length !== this.pending.size || new Set(outputs.map((item) => item.call_id)).size !== this.pending.size || outputs.some((item) => !this.pending.has(item.call_id))) throw clientError("invalid_client_result", "Return exactly the outstanding client tool results.");
    const pending = this.attach(emit, signal); this.state = "running"; this.proposedOutputs = outputs;
    try { this.send({ type: "resume", outputs, additions }); } catch (error) { this.cancel(error as Error); }
    return pending;
  }
  private async read(): Promise<void> {
    this.child.stdout.setEncoding("utf8");
    for await (const chunk of this.child.stdout) {
      this.bytes += Buffer.byteLength(chunk); this.buffer += chunk;
      if (this.bytes > CLIENT_LIMITS.outputBytes * 8 || Buffer.byteLength(this.buffer) > CLIENT_LIMITS.outputBytes * 2) throw new Error("Worker transport exceeds limit.");
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (line.startsWith(WORKER_EVENT_PREFIX)) await this.frame(JSON.parse(line.slice(WORKER_EVENT_PREFIX.length)));
      }
    }
  }
  private validateLeg(value: any, pending: boolean): ClientLeg {
    if (!this.waiter?.ready || typeof value.text !== "string" || value.text !== this.waiter.text || !["stop", "length"].includes(value.finishReason) || !value.usage || ["input", "output", "cached", "reasoning"].some((key) => !Number.isFinite(value.usage[key]) || value.usage[key] < 0)) throw new Error("Invalid worker leg.");
    if (!Array.isArray(value.calls) || (pending ? value.calls.length === 0 : value.calls.length !== 0)) throw new Error("Invalid worker calls.");
    for (const call of value.calls) {
      if (!/^call_[a-f0-9]{32}$/.test(call.call_id) || !/^fc_[a-f0-9]{32}$/.test(call.id) || this.issued.has(call.call_id) || !this.initial.tools.some((tool) => tool.name === call.name) || typeof call.arguments !== "string" || Buffer.byteLength(call.arguments) > CLIENT_LIMITS.argumentBytes || call.type !== "function_call" || call.status !== "completed") throw new Error("Invalid client call.");
      const args = JSON.parse(call.arguments); validateClientArguments(args); if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid client arguments.");
      this.issued.set(call.call_id, call); this.pending.set(call.call_id, call);
    }
    if (this.issued.size > this.policy.maxCalls) throw new Error("Too many client calls.");
    return { text: value.text, calls: value.calls, tools: this.initial.tools, usage: value.usage, finishReason: value.finishReason, pending };
  }
  private async frame(value: any): Promise<void> {
    if (this.state === "closed") return;
    if (value.type === "failure") { this.cancel(safeFailure(value.code)); return; }
    if (value.type === "resume_error") {
      if (!this.waiter || this.waiter.ready || this.issued.size === 0) throw new Error("Invalid resume rejection.");
      this.state = "waiting"; this.proposedOutputs = undefined; this.reject(safeFailure(value.code)); return;
    }
    const waiter = this.waiter; if (!waiter || this.result) throw new Error("Unexpected worker record.");
    if (value.type === "ready") {
      if (waiter.ready) throw new Error("Duplicate ready.");
      const refreshed = await this.refreshed();
      if (this.waiter !== waiter) return;
      this.version = refreshed;
      for (const output of this.proposedOutputs ?? []) this.completedOutputs.set(output.call_id, clientOutputFingerprint(output));
      this.proposedOutputs = undefined;
      this.pending.clear(); waiter.ready = true; this.lease(); await waiter.emit({ type: "ready" });
    } else if (value.type === "text") {
      if (!waiter.ready || typeof value.delta !== "string") throw new Error("Invalid text.");
      waiter.text += value.delta;
      if (Buffer.byteLength(waiter.text) > CLIENT_LIMITS.outputBytes) throw new Error("Output limit exceeded.");
      await waiter.emit({ type: "text", delta: value.delta });
    } else if (value.type === "yield") {
      const leg = this.validateLeg(value, true); this.state = "waiting"; this.lease(); this.notify(this, leg.calls); this.settle(leg);
    } else if (value.type === "result") { this.result = this.validateLeg(value.result, false); this.state = "finishing"; }
    else throw new Error("Unknown worker record.");
  }
  cancel(error: Error = safeFailure(undefined)): void {
    if (this.state === "closed") return;
    this.reject(error); this.cleanup();
    this.kill(); this.killTimer = setTimeout(() => this.kill(true), 1000); this.killTimer.unref();
  }
  private cleanup(): void {
    this.state = "closed";
    if (this.timer) clearTimeout(this.timer);
    if (this.killTimer) clearTimeout(this.killTimer);
    if (this.ended) { this.removed(this); this.child.stdin.destroy(); }
  }
}

export class ClientToolsRuntime {
  private actors = new Set<ClientActor>();
  private calls = new Map<string, ClientActor>();
  private watcher?: ReturnType<typeof setInterval>;
  private closed = false;
  private options: ClientRuntimeOptions;
  constructor(options: ClientRuntimeOptions) { this.options = options; }
  get size(): number { return this.actors.size; }
  async select(body: unknown): Promise<{ client?: ClientRequest; legacy?: CompletionRequest }> {
    let legacyError: unknown, legacy: CompletionRequest | undefined;
    try { legacy = normalizeRequest(body, "responses"); } catch (error) { legacyError = error; }
    const raw = body as any;
    const history = Array.isArray(raw?.input) && raw.input.some((item: any) => ["function_call", "function_call_output"].includes(item?.type));
    if (legacyError && !history) throw legacyError;
    if (typeof raw?.model !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw.model)) { if (legacyError) throw legacyError; return { legacy }; }
    const settings = await this.options.settings(raw.model);
    const policy = clientToolPolicy(settings);
    if (!policy.enabled) { this.revoke(raw.model); if (legacyError) throw legacyError; return { legacy }; }
    if (!history && !acceptedClientTools(raw.tools, policy).length) { if (legacyError) throw legacyError; return { legacy }; }
    return { client: normalizeClientRequest(body, policy) };
  }
  private watch(): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      for (const actor of this.actors) void this.options.settings(actor.initial.request.profile).then((settings) => { if (securityVersion(settings) !== actor.version) actor.cancel(clientError("client_tool_policy_changed", "The profile policy changed.", 409)); }).catch(() => actor.cancel());
    }, 5000); this.watcher.unref();
  }
  revoke(profile: string): void { for (const actor of this.actors) if (actor.initial.request.profile === profile) actor.cancel(clientError("client_tool_policy_changed", "Client tools were disabled for this profile.", 409)); }
  cancel(request: ClientRequest): void { for (const actor of this.actors) if (actor.initial === request || request.outputs.some((output) => this.calls.get(output.call_id) === actor)) actor.cancel(); }
  async execute(input: ClientRequest, emit: Emit, signal: AbortSignal): Promise<ClientLeg> {
    signal.throwIfAborted();
    if (this.closed) throw clientError("client_tools_unavailable", "The client-tool runtime is shutting down.", 503);
    const settings = await this.options.settings(input.request.profile), policy = clientToolPolicy(settings), version = securityVersion(settings);
    signal.throwIfAborted();
    if (this.closed) throw clientError("client_tools_unavailable", "The client-tool runtime is shutting down.", 503);
    if (!policy.enabled) { this.revoke(input.request.profile); throw clientError("client_tools_disabled", "Client tools are disabled for this profile.", 403); }
    const matched = new Set<ClientActor>();
    for (const output of input.outputs) { const actor = this.calls.get(output.call_id); if (actor?.pending.has(output.call_id)) matched.add(actor); }
    if (matched.size > 1) throw clientError("invalid_client_result", "Results from different continuations cannot be combined.");
    const existing = [...matched][0];
    if (existing) {
      if (existing.initial.request.profile !== input.request.profile) throw clientError("client_tool_profile_mismatch", "The client continuation belongs to another profile.", 409);
      if (existing.version !== version || policyFingerprint(existing.policy) !== policyFingerprint(policy)) { existing.cancel(); throw clientError("client_tool_policy_changed", "The profile configuration changed.", 409); }
      if (input.toolsSupplied && fingerprint([...input.tools].sort((a, b) => a.name.localeCompare(b.name))) !== fingerprint([...existing.initial.tools].sort((a, b) => a.name.localeCompare(b.name)))) throw clientError("client_tool_context_mismatch", "Client function definitions cannot change during a pending exchange.", 409);
      const original = existing.initial.request;
      if (input.request.messages.length && (input.request.messages.length < original.messages.length || fingerprint(input.request.messages.slice(0, original.messages.length)) !== fingerprint(original.messages) || input.request.instructions !== original.instructions)) throw clientError("client_tool_context_mismatch", "The continuation changed the original request context.", 409);
      for (const item of input.input) if (item.kind === "call") {
        const historical = existing.initial.input.find((entry) => entry.kind === "call" && entry.call.call_id === item.call.call_id);
        const known = existing.issued.get(item.call.call_id) ?? (historical?.kind === "call" ? historical.call : undefined);
        if (!known || item.call.name !== known.name || fingerprint(JSON.parse(item.call.arguments)) !== fingerprint(JSON.parse(known.arguments))) throw clientError("client_tool_context_mismatch", "The continuation changed an issued function call.", 409);
      }
      for (const output of input.outputs) if (!existing.pending.has(output.call_id)) {
        const historical = existing.initial.outputs.find((item) => item.call_id === output.call_id);
        const known = existing.completedOutputs.get(output.call_id) ?? (historical ? clientOutputFingerprint(historical) : undefined);
        if (!known || known !== clientOutputFingerprint(output)) throw clientError("client_tool_context_mismatch", "The continuation contains an unknown or conflicting result.", 409);
      }
      const outputs = input.outputs.filter((output) => existing.pending.has(output.call_id));
      const lastResult = input.input.reduce((last, item, index) => item.kind === "result" && existing.pending.has(item.output.call_id) ? index : last, -1);
      const additions = input.input.slice(lastResult + 1).flatMap((item) => item.kind === "message" && input.request.messages[item.index].role === "user" ? [input.request.messages[item.index]] : []);
      return existing.resume(outputs, additions, emit, signal);
    }
    ensureInitialClientRequest(input);
    if (this.actors.size >= (this.options.maxWorkers ?? CLIENT_LIMITS.workers) || [...this.actors].filter((actor) => actor.initial.request.profile === input.request.profile).length >= (this.options.perProfile ?? CLIENT_LIMITS.perProfile)) throw clientError("client_tool_capacity", "Too many active client tool executions. Retry later without replaying completed server actions.", 429);
    const actor = new ClientActor(input, policy, version, this.options.launch(input.request.profile), (owner, calls) => { for (const call of calls) { if (this.calls.has(call.call_id)) throw new Error("Duplicate continuation ID."); this.calls.set(call.call_id, owner); } }, (owner) => {
      this.actors.delete(owner);
      for (const [id, value] of this.calls) if (value === owner) this.calls.delete(id);
      if (!this.actors.size && this.watcher) { clearInterval(this.watcher); this.watcher = undefined; }
    }, async () => {
      const current = await this.options.settings(input.request.profile);
      if (securityVersion(current) !== version || policyFingerprint(clientToolPolicy(current)) !== policyFingerprint(policy)) throw clientError("client_tool_policy_changed", "The profile client-tool policy changed.", 409);
      return securityVersion(current);
    });
    this.actors.add(actor); this.watch();
    return actor.start(emit, signal);
  }
  async close(): Promise<void> { this.closed = true; const actors = [...this.actors]; for (const actor of actors) actor.cancel(); await Promise.all(actors.map((actor) => actor.done)); }
}
