/** Waiting client functions inside the existing isolated profile SDK worker. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentSession, ExtensionAPI, SettingsManager, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runCompatibilityWorker, restoreHistory, WORKER_EVENT_PREFIX, type CompatibilityWorkerHooks } from "./openai-execution.ts";
import { prepareAttachments } from "./openai-attachments.ts";
import { attachmentError, CompatibilityError } from "./openai-errors.ts";
import { canAttemptVisualInput } from "./openai-codex-files.ts";
import { OPENAI_BODY_BYTES, OPENAI_TEXT_CHARACTERS } from "../lib/openai-limits.ts";
import { CLIENT_PREFIX, CLIENT_LIMITS, acceptedClientTools, clientError, clientToolPolicy, emptyClientUsage, policyFingerprint, usageDelta, validateClientArguments, type ClientCall, type ClientOutput, type ClientRequest, type ResumeClientMessage } from "./openai-client-contract.ts";
import type { CompletionRequest, ConversationMessage, TokenUsage } from "./openai-contract.ts";

type Host = typeof import("@earendil-works/pi-coding-agent");
type Prepared = { content: any[]; details: { source: string }; isError: boolean };
type Pending = { call: ClientCall; resolve(value: Prepared): void; reject(error: Error): void; issued: boolean };
const zeroNativeUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

class ClientWorker implements CompatibilityWorkerHooks {
  attachmentBudget = { count: 0, bytes: 0 };
  private init!: ClientRequest;
  private policy!: ReturnType<typeof clientToolPolicy>;
  private session?: AgentSession;
  private api?: ExtensionAPI;
  private host!: Host;
  private settings!: SettingsManager;
  private signal!: AbortSignal;
  private buffer = "";
  private initialResolve!: (value: any) => void;
  private initialReject!: (error: Error) => void;
  private initial = new Promise<any>((resolve, reject) => { this.initialResolve = resolve; this.initialReject = reject; });
  private initialized = false;
  private commands = Promise.resolve();
  private pending = new Map<string, Pending>();
  private history = new Map<string, Prepared>();
  private historyEntries: Array<{ id: string; output: Prepared }> = [];
  private sentUsage = emptyClientUsage();
  private active = true;
  private text = "";
  private characters = 0;
  private calls = 0;
  private scheduled = false;
  private closed = false;
  readonly factory = (api: ExtensionAPI) => { this.api = api; };
  private frame(value: unknown): void {
    if (process.stdout.writableLength > 1024 * 1024) throw clientError("slow_consumer", "The response consumer is too slow.", 502);
    process.stdout.write(`${WORKER_EVENT_PREFIX}${JSON.stringify(value)}\n`);
  }
  private data = (chunk: string) => {
    try {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > OPENAI_BODY_BYTES + 1_048_576) throw clientError("request_too_large", "Client worker frame exceeds limit.", 413);
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        const value = JSON.parse(line);
        if (!this.initialized) { this.initialized = true; this.initialResolve(value); }
        else this.commands = this.commands.then(() => this.resume(value)).catch(() => { this.abort(); });
      }
    } catch (error) { this.initialReject(error as Error); this.abort(); }
  };
  private ended = () => { this.initialReject(new Error("Worker control channel closed.")); this.abort(); };
  async readRequest(signal: AbortSignal): Promise<CompletionRequest> {
    this.signal = signal;
    process.stdin.setEncoding("utf8"); process.stdin.on("data", this.data); process.stdin.once("end", this.ended);
    void this.initial.catch(() => {});
    signal.addEventListener("abort", this.abort, { once: true });
    const value = await this.initial;
    if (this.closed) throw clientError("client_tool_cancelled", "Client worker was cancelled.", 502);
    if (value?.type !== "init" || !value.input) throw clientError("invalid_client_input", "Invalid worker initialization.");
    this.init = value.input;
    this.policy = clientToolPolicy(JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), "utf8").catch((error) => { if (error.code === "ENOENT") return "{}"; throw error; })));
    if (!this.policy.enabled) throw clientError("client_tools_disabled", "Client tools are disabled for this profile.", 403);
    this.init.tools = acceptedClientTools(this.init.tools, this.policy);
    return this.init.request;
  }
  async prepare(request: CompletionRequest, host: Host, settings: SettingsManager): Promise<void> {
    if (this.closed) throw clientError("client_tool_cancelled", "Client worker was cancelled.", 502);
    this.host = host; this.settings = settings;
    this.characters = request.messages.reduce((sum, message) => sum + message.content.length, request.instructions?.length ?? 0);
    for (const item of this.init.input) if (item.kind === "result") {
      this.history.set(item.output.call_id, await this.prepareOutput(item.output, this.attachmentBudget));
      this.characters += item.output.text.length;
    }
    if (this.characters > OPENAI_TEXT_CHARACTERS) throw attachmentError("context_too_large");
  }
  private async resize(output: Prepared): Promise<void> {
    const images = output.content.filter((part) => part.type === "image");
    if (!images.length) return;
    if (this.settings.getBlockImages()) throw attachmentError("image_input_disabled");
    if (this.session && !canAttemptVisualInput(this.session.model)) throw attachmentError("unsupported_image_model");
    const options = this.settings.getImageAutoResize() ? this.session?.model?.inputLimits?.images?.resize : { maxWidth: 16_384, maxHeight: 16_384, maxBytes: 14 * 1024 * 1024 };
    for (const image of images) {
      const decoded = await this.host.resizeImage(Buffer.from(image.data, "base64"), image.mimeType, options).catch(() => null);
      if (!decoded) throw attachmentError("invalid_attachment");
      image.data = decoded.data; image.mimeType = decoded.mimeType;
    }
  }
  private async prepareOutput(output: ClientOutput, budget: { count: number; bytes: number }): Promise<Prepared> {
    const prepared = await prepareAttachments({ ...this.init.request, messages: [{ role: "user", content: output.text, attachments: output.attachments }] }, this.signal, { budget });
    const message = prepared.messages[0];
    const result: Prepared = { content: [{ type: "text", text: message.content }, ...(message.images ?? [])], details: { source: "client" }, isError: output.failed };
    await this.resize(result);
    return result;
  }
  restore(manager: SessionManager, request: CompletionRequest): Array<{ id: string; index: number }> {
    const restored: Array<{ id: string; index: number }> = [];
    const flush = (calls: ClientCall[]) => { if (calls.length) manager.appendMessage({ role: "assistant", content: calls.map((call) => ({ type: "toolCall" as const, id: call.call_id, name: `${CLIENT_PREFIX}${call.name}`, arguments: JSON.parse(call.arguments) })), api: "openai-completions", provider: "external", model: "external", usage: zeroNativeUsage(), stopReason: "toolUse", timestamp: Date.now() }); };
    let calls: ClientCall[] = [];
    for (const item of this.init.input) {
      if (item.kind === "call") { calls.push(item.call); continue; }
      flush(calls); calls = [];
      if (item.kind === "message") {
        if (item.index === request.messages.length - 1) continue;
        for (const entry of restoreHistory(manager, { ...request, messages: [request.messages[item.index], request.messages.at(-1)!] })) restored.push({ id: entry.id, index: item.index });
      } else {
        const output = this.history.get(item.output.call_id)!;
        const sourceCall = this.init.input.find((entry) => entry.kind === "call" && entry.call.call_id === item.output.call_id);
        if (sourceCall?.kind !== "call") throw clientError("invalid_client_result", "Historical client result has no function call.");
        const id = manager.appendMessage({ role: "toolResult", toolCallId: item.output.call_id, toolName: `${CLIENT_PREFIX}${sourceCall.call.name}`, ...output, timestamp: Date.now() });
        this.historyEntries.push({ id, output });
      }
    }
    flush(calls); return restored;
  }
  async started(session: AgentSession, request: CompletionRequest): Promise<void> {
    this.session = session;
    this.characters = request.messages.reduce((sum, message) => sum + message.content.length, request.instructions?.length ?? 0) + this.init.input.reduce((sum, item) => sum + (item.kind === "result" ? item.output.text.length : 0), 0);
    if (this.characters > OPENAI_TEXT_CHARACTERS) throw attachmentError("context_too_large");
    if (this.closed) { await session.abort(); throw clientError("client_tool_cancelled", "Client worker was cancelled.", 502); }
    for (const { id, output } of this.historyEntries) { await this.resize(output); session.sessionManager.appendContextEdit(id, { content: output.content }); }
    if (this.historyEntries.length) session.refreshContext();
    const known = new Set(session.getAllTools().map((tool) => tool.name));
    for (const tool of this.init.tools) if (known.has(tool.name) || known.has(`${CLIENT_PREFIX}${tool.name}`)) throw clientError("client_tool_name_conflict", "A client tool conflicts with a profile tool.");
    const active = this.api!.getActiveTools();
    for (const tool of this.init.tools) {
      const definition: ToolDefinition = { name: `${CLIENT_PREFIX}${tool.name}`, label: `Client: ${tool.name}`, description: tool.description, parameters: tool.parameters as any, exposure: "model-only", defaultActive: false, execute: async (_id, params, signal) => this.delegate(tool.name, params, signal) };
      this.api!.registerTool(definition);
    }
    this.api!.setActiveTools([...active, ...this.init.tools.map((tool) => `${CLIENT_PREFIX}${tool.name}`)]);
  }
  private async delegate(name: string, args: unknown, signal?: AbortSignal): Promise<Prepared> {
    signal?.throwIfAborted(); this.signal.throwIfAborted();
    if (this.closed || ++this.calls > this.policy.maxCalls) { this.abort(); throw clientError("client_tool_call_limit", "Client tool call limit exceeded.", 502); }
    validateClientArguments(args);
    const argumentsText = JSON.stringify(args);
    if (Buffer.byteLength(argumentsText) > CLIENT_LIMITS.argumentBytes) throw clientError("client_tool_argument_limit", "Client tool arguments exceed the limit.");
    const call_id = `call_${randomUUID().replaceAll("-", "")}`;
    const call: ClientCall = { type: "function_call", id: `fc_${randomUUID().replaceAll("-", "")}`, call_id, name, arguments: argumentsText, status: "completed" };
    return new Promise<Prepared>((resolve, reject) => {
      const aborted = () => { this.pending.delete(call_id); reject(new Error("Client tool execution cancelled.")); };
      signal?.addEventListener("abort", aborted, { once: true });
      this.pending.set(call_id, { call, issued: false, resolve: (result) => { signal?.removeEventListener("abort", aborted); resolve(result); }, reject: (error) => { signal?.removeEventListener("abort", aborted); reject(error); } });
      this.schedule();
    });
  }
  private totalUsage(): TokenUsage {
    const tokens = this.session!.getSessionStats().tokens;
    return { input: tokens.input + tokens.cacheRead + tokens.cacheWrite, output: tokens.output, cached: tokens.cacheRead, reasoning: this.session!.sessionManager.getEntries().reduce((sum, entry: any) => sum + (entry.type === "message" && ["assistant", "toolResult"].includes(entry.message.role) ? entry.message.usage?.reasoning ?? 0 : entry.usage?.reasoning ?? 0), 0) };
  }
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      try {
        if (!this.active || this.closed) return;
        const pending = [...this.pending.values()].filter((item) => !item.issued);
        if (!pending.length) return;
        for (const item of pending) item.issued = true;
        const total = this.totalUsage(), usage = usageDelta(total, this.sentUsage); this.sentUsage = total;
        this.active = false;
        this.frame({ type: "yield", text: this.text, calls: pending.map((item) => item.call), usage, finishReason: "stop", pending: true });
      } catch { this.abort(); }
    });
  }
  private async resume(value: ResumeClientMessage): Promise<void> {
    try {
      if (value?.type !== "resume" || this.active || !this.session || this.closed) throw clientError("client_tool_resume_conflict", "The client continuation is not waiting.", 409);
      const current = clientToolPolicy(JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), "utf8")));
      if (policyFingerprint(current) !== policyFingerprint(this.policy)) throw clientError("client_tool_policy_changed", "The client tool policy changed.", 409);
      const expected = [...this.pending.values()].filter((item) => item.issued);
      if (!Array.isArray(value.outputs) || !expected.length || value.outputs.length !== expected.length || new Set(value.outputs.map((item) => item.call_id)).size !== expected.length || expected.some((item) => !value.outputs.some((output) => output.call_id === item.call.call_id))) throw clientError("invalid_client_result", "Return exactly the outstanding client tool results.");
      const budget = { ...this.attachmentBudget }, prepared = new Map<string, Prepared>();
      let characters = this.characters;
      for (const output of value.outputs) { prepared.set(output.call_id, await this.prepareOutput(output, budget)); characters += output.text.length; }
      const additions: ConversationMessage[] = [];
      for (const addition of value.additions ?? []) {
        const normalized = await prepareAttachments({ ...this.init.request, messages: [addition] }, this.signal, { budget });
        const message = normalized.messages[0];
        const output: Prepared = { content: [...(message.images ?? [])], details: { source: "client" }, isError: false }; await this.resize(output);
        additions.push(message); characters += message.content.length;
      }
      if (characters > OPENAI_TEXT_CHARACTERS) throw attachmentError("context_too_large");
      for (const message of additions) await this.session.prompt(message.content, { source: "rpc", expandPromptTemplates: false, streamingBehavior: "steer", ...(message.images?.length ? { images: message.images } : {}) });
      this.attachmentBudget = budget; this.characters = characters;
      this.active = true; this.text = ""; this.frame({ type: "ready" });
      for (const output of value.outputs) { const pending = this.pending.get(output.call_id)!; this.pending.delete(output.call_id); pending.resolve(prepared.get(output.call_id)!); }
      this.schedule();
    } catch (error) {
      if (error instanceof CompatibilityError) this.frame({ type: "resume_error", code: error.code });
      else throw error;
    }
  }
  write = (frame: any): void => {
    if (frame.type === "text") {
      if (!this.active) throw clientError("invalid_stream", "Unexpected text during client handoff.", 502);
      this.text += frame.delta;
      if (Buffer.byteLength(this.text) > CLIENT_LIMITS.outputBytes) throw clientError("output_limit_exceeded", "Client leg output exceeds the limit.", 502);
    }
    if (frame.type === "result") {
      const usage = usageDelta(frame.result.usage, this.sentUsage);
      this.frame({ type: "result", result: { text: this.text, calls: [], usage, finishReason: frame.result.finishReason, pending: false } });
    } else this.frame(frame);
  };
  private abort = () => {
    if (this.closed) return;
    this.closed = true;
    void this.session?.abort().catch(() => {});
    for (const item of this.pending.values()) item.reject(new Error("Client tool execution cancelled."));
    this.pending.clear();
  };
  close(): void {
    this.abort(); process.stdin.off("data", this.data); process.stdin.off("end", this.ended); process.stdin.pause();
    this.signal?.removeEventListener("abort", this.abort);
  }
}

export async function runClientToolsWorker(host: Host): Promise<void> {
  const worker = new ClientWorker();
  try { await runCompatibilityWorker(host, worker); }
  finally { worker.close(); }
}
