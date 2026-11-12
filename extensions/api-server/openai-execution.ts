/** Shared ephemeral Pi execution, with a structured subprocess event channel. */
import type { AgentSession, AgentSessionEvent, SessionManager as SessionManagerType } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { prepareAttachments } from "./openai-attachments.ts";
import { attachmentError, attachmentFailures } from "./openai-errors.ts";
import { OPENAI_BODY_BYTES, OPENAI_ATTACHMENT_BYTES, OPENAI_TEXT_CHARACTERS } from "../lib/openai-limits.ts";
import { CompatibilityError, type CompletionRequest, type CompletionResult, type ExecutionEvent, type TokenUsage } from "./openai-contract.ts";

export const WORKER_EVENT_PREFIX = "PI_OPENAI_EVENT:";
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** Populate authoritative session context before constructing the AgentSession. */
export function restoreHistory(manager: Pick<SessionManagerType, "appendMessage">, request: CompletionRequest): Array<{ id: string; index: number }> {
  const restoredImages: Array<{ id: string; index: number }> = [];
  for (const [index, message] of request.messages.slice(0, -1).entries()) {
    if (message.role === "assistant") manager.appendMessage({ role: "assistant", content: [{ type: "text", text: message.content }], api: "openai-completions", provider: "external", model: "external", usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() });
    else if (message.role === "user") {
      const id = manager.appendMessage({ role: "user", content: message.images?.length ? [{ type: "text", text: message.content }, ...message.images] : message.content, timestamp: Date.now() });
      if (message.images?.length) restoredImages.push({ id, index });
    }
    // Instruction roles are appended to the profile prompt, not recorded as
    // native system loadout snapshots (which would deactivate profile tools).
  }
  return restoredImages;
}

/** Execute a prepared session and dispose it on every success, failure, or abort. */
export async function executeSession(session: AgentSession, request: CompletionRequest, emit: (event: ExecutionEvent) => void, signal: AbortSignal): Promise<CompletionResult> {
  const usage: TokenUsage = { input: 0, output: 0, cached: 0, reasoning: 0 };
  let text = "", current = "", lastReason = "", bytes = 0, needsSeparator = false;
  let eventError: unknown;
  const abort = () => { void session.abort().catch(() => {}); };
  const sendText = (delta: string) => {
    if (!delta) return;
    bytes += Buffer.byteLength(delta) + (needsSeparator ? 2 : 0);
    if (bytes > MAX_OUTPUT_BYTES) throw new CompatibilityError("Pi output exceeded the response limit.", null, 502, "output_limit_exceeded");
    if (needsSeparator) { emit({ type: "text", delta: "\n\n" }); text += "\n\n"; needsSeparator = false; }
    emit({ type: "text", delta }); text += delta; current += delta;
  };
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (eventError) return;
    try {
      if (event.type === "message_start" && event.message.role === "assistant") { current = ""; needsSeparator = text.length > 0; }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") sendText(event.assistantMessageEvent.delta);
      if (event.type !== "message_end") return;
      const message = event.message;
      if ((message.role === "assistant" || message.role === "toolResult") && message.usage) {
        usage.input += message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
        usage.output += message.usage.output;
        usage.cached += message.usage.cacheRead;
        usage.reasoning += message.usage.reasoning ?? 0;
      }
      if (message.role !== "assistant") return;
      lastReason = message.stopReason;
      const finalText = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      // Finalized text may add a suffix, but bytes already streamed cannot be retracted.
      if (!finalText.startsWith(current)) throw new CompatibilityError("Pi rewrote already streamed output.", null, 502, "output_rewritten");
      sendText(finalText.slice(current.length));
    } catch (error) { eventError = error; abort(); }
  });
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    if (request.messages.some((message) => message.images?.length) && !session.model?.input.includes("image")) throw attachmentError("unsupported_image_model");
    emit({ type: "ready" });
    const final = request.messages.at(-1)!;
    await session.prompt(final.content, { source: "rpc", expandPromptTemplates: false, ...(final.images?.length ? { images: final.images } : {}) });
    await session.waitForIdle();
    if (eventError) throw eventError;
    signal.throwIfAborted();
    if (session.messages) {
      const authoritative = session.messages.findLast((message) => message.role === "assistant");
      if (authoritative?.role === "assistant") {
        const finalText = authoritative.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        if (finalText !== current) throw new CompatibilityError("Pi rewrote already streamed output.", null, 502, "output_rewritten");
        lastReason = authoritative.stopReason;
      } else if (text) throw new CompatibilityError("Pi removed the completed output.", null, 502, "output_rewritten");
    }
    if (lastReason === "error" || lastReason === "aborted" || lastReason === "deferred") throw new CompatibilityError("Pi did not complete the response.", null, 502, "generation_failed");
    if (!text) throw new CompatibilityError("Pi completed without a text response.", null, 502, "response_missing");
    // The authoritative ledger includes compaction, retries and nested tool usage.
    // Restored history carries zero usage and therefore cannot inflate these totals.
    if (session.getSessionStats) {
      const tokens = session.getSessionStats().tokens;
      usage.input = tokens.input + tokens.cacheRead + tokens.cacheWrite;
      usage.output = tokens.output;
      usage.cached = tokens.cacheRead;
      usage.reasoning = session.sessionManager.getEntries().reduce((total, entry) => {
        const value = entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")
          ? entry.message.usage : "usage" in entry ? entry.usage : undefined;
        return total + (value && typeof value === "object" && "reasoning" in value && typeof value.reasoning === "number" ? value.reasoning : 0);
      }, 0);
    }
    return { text, finishReason: lastReason === "length" ? "length" : "stop", usage };
  } finally {
    signal.removeEventListener("abort", abort); unsubscribe();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); session.dispose(); }
  }
}

/** Run inside the existing profile launcher (and Nono when enabled). */
export async function runCompatibilityWorker(host?: typeof import("@earendil-works/pi-coding-agent")): Promise<void> {
  // Disable worker dispatch when the SDK reloads the shared API extension.
  process.env.PI_OPENAI_WORKER = "running";
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_APPLICATION_") || key === "PI_API_WORKER" || key === "PI_PROFILE_DISCOVER_TOOLS") delete process.env[key];
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const write = (value: unknown) => {
    if (process.stdout.writableLength > 1024 * 1024) throw new CompatibilityError("The response consumer is too slow.", null, 502, "slow_consumer");
    process.stdout.write(`${WORKER_EVENT_PREFIX}${JSON.stringify(value)}\n`);
  };
  let session: AgentSession | undefined;
  try {
    let input = "", inputBytes = 0;
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      inputBytes += Buffer.byteLength(chunk);
      if (inputBytes > OPENAI_BODY_BYTES + 1_048_576) throw new CompatibilityError("Request is too large.", null, 413);
      input += String(chunk);
    }
    const rawRequest = JSON.parse(input) as CompletionRequest;
    input = "";
    const request = await prepareAttachments(rawRequest, controller.signal);
    const { createAgentSession, createCodemodeExtension, createToolSearchExtension, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, resizeImage, formatDimensionNote } = host ?? await import("@earendil-works/pi-coding-agent");
    const { join } = await import("node:path");
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const cwd = process.cwd();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    if (request.messages.some((message) => message.images?.length) && settingsManager.getBlockImages()) throw attachmentError("image_input_disabled");
    const additionalExtensionPaths: string[] = [];
    for (let i = 2; i < process.argv.length; i++) {
      if (process.argv[i] === "--extension" || process.argv[i] === "-e") additionalExtensionPaths.push(process.argv[++i]);
      else if (process.argv[i].startsWith("--extension=")) additionalExtensionPaths.push(process.argv[i].slice("--extension=".length));
    }
    const instructions = [...request.messages.filter((message) => message.role === "system").map((message) => message.content), ...(request.instructions ? [request.instructions] : [])];
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths,
      extensionFactories: [
        { name: "codemode", builtin: true, factory: createCodemodeExtension({ mode: "on" }) },
        { name: "tool-search", builtin: true, factory: createToolSearchExtension() },
        { name: "mcp", builtin: true, factory: createMcpExtension() },
      ],
      ...(instructions.length ? { appendSystemPrompt: instructions } : {}) });
    await loader.reload();
    if (loader.getExtensions().errors.length) throw new Error("Profile extension initialization failed.");
    const manager = SessionManager.inMemory(cwd);
    const restoredImages = restoreHistory(manager, request);
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
    controller.signal.throwIfAborted();
    session = (await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: manager, modelRuntime: runtime })).session;
    const configuredProvider = settingsManager.getDefaultProvider(), configuredModel = settingsManager.getDefaultModel();
    if ((configuredProvider && session.model?.provider !== configuredProvider) || (configuredModel && session.model?.id !== configuredModel)) {
      throw new CompatibilityError("The profile's configured model is unavailable.", null, 502, "profile_model_unavailable");
    }
    if (request.messages.some((message) => message.images?.length) && !session.model?.input.includes("image")) throw attachmentError("unsupported_image_model");
    // Validate and normalize history as well as the final prompt using the
    // selected model's limits and the profile's image-resizing policy. Pi's
    // prompt path may otherwise omit undecodable images with only a text hint.
    const resizeOptions = settingsManager.getImageAutoResize() ? session.model?.inputLimits?.images?.resize : { maxWidth: 16_384, maxHeight: 16_384, maxBytes: Math.ceil(OPENAI_ATTACHMENT_BYTES / 3) * 4 + 1 };
    for (const message of request.messages) for (const image of message.images ?? []) {
      controller.signal.throwIfAborted();
      const decoded = await resizeImage(Buffer.from(image.data, "base64"), image.mimeType, resizeOptions).catch(() => null);
      if (!decoded) throw attachmentError("invalid_attachment");
      image.data = decoded.data; image.mimeType = decoded.mimeType;
      const note = formatDimensionNote(decoded);
      if (note) message.content += `\n\n${note}`;
    }
    if (request.messages.reduce((total, message) => total + message.content.length, request.instructions?.length ?? 0) > OPENAI_TEXT_CHARACTERS) throw attachmentError("context_too_large");
    for (const { id, index } of restoredImages) {
      const message = request.messages[index];
      manager.appendContextEdit(id, { content: [{ type: "text", text: message.content }, ...message.images!] });
    }
    if (restoredImages.length) session.refreshContext();
    await session.bindExtensions({ mode: "rpc", onError: () => { process.stderr.write("OpenAI worker extension failed.\n"); } });
    const result = await executeSession(session, request, write, controller.signal);
    session = undefined;
    write({ type: "result", result });
  } catch (error) {
    process.stderr.write(`OpenAI worker failed (${error instanceof CompatibilityError ? error.code : "runtime_error"}).\n`);
    session?.dispose();
    write({ type: "failure", code: error instanceof CompatibilityError ? error.code : "generation_failed" });
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
  // Flush the structured channel before the outer CLI runtime is terminated.
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
}

/** Stream a worker without buffering the complete JSONL transport in memory. */
export async function executeWorker(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, request: CompletionRequest, emit: (event: ExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<CompletionResult> {
  signal.throwIfAborted();
  const child = spawn(command, args, { ...options, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (force = false) => {
    try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); else child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* The worker may already have exited. */ }
  };
  const abort = () => { kill(); killTimer ??= setTimeout(() => kill(true), 1000); killTimer.unref(); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  // Never expose stderr: providers and extensions can include sensitive details.
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  void exited.catch(() => {});
  child.stdin.end(JSON.stringify(request));
  let result: CompletionResult | undefined, failure = false, failureCode = "generation_failed", buffer = "", ready = false, outputBytes = 0, transportBytes = 0;
  const startupTimer = setTimeout(abort, 60_000);
  startupTimer.unref();
  const outputHash = createHash("sha256");
  child.stdout.setEncoding("utf8");
  try {
    for await (const chunk of child.stdout) {
      signal.throwIfAborted();
      transportBytes += Buffer.byteLength(chunk);
      if (transportBytes > MAX_OUTPUT_BYTES * 8) throw new Error("Worker transport exceeds limit.");
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_OUTPUT_BYTES * 2) throw new Error("Worker frame exceeds limit.");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.startsWith(WORKER_EVENT_PREFIX)) continue;
        const value = JSON.parse(line.slice(WORKER_EVENT_PREFIX.length));
        if (result || failure) throw new Error("Worker sent data after terminal record.");
        if (value.type === "ready") { if (ready) throw new Error("Duplicate worker initialization."); ready = true; clearTimeout(startupTimer); await emit({ type: "ready" }); }
        else if (value.type === "text") {
          if (!ready || typeof value.delta !== "string") throw new Error("Invalid worker text event.");
          outputBytes += Buffer.byteLength(value.delta);
          outputHash.update(value.delta);
          if (outputBytes > MAX_OUTPUT_BYTES) throw new Error("Worker output exceeds limit.");
          await emit({ type: "text", delta: value.delta });
        }
        else if (value.type === "result") result = value.result;
        else if (value.type === "failure") {
          failure = true;
          if (typeof value.code === "string" && (Object.hasOwn(attachmentFailures, value.code) || ["output_rewritten", "output_limit_exceeded", "slow_consumer", "generation_failed", "response_missing", "profile_model_unavailable"].includes(value.code))) failureCode = value.code;
        }
        else throw new Error("Unknown worker record.");
      }
      if (buffer.length > MAX_OUTPUT_BYTES * 2) throw new Error("Worker frame exceeds limit.");
    }
    const code = await exited;
    signal.throwIfAborted();
    if (failure && Object.hasOwn(attachmentFailures, failureCode)) throw attachmentError(failureCode);
    if (buffer.trim() || code !== 0 || failure || !result || !ready || typeof result.text !== "string" || !["stop", "length"].includes(result.finishReason) || !result.usage || ["input", "output", "cached", "reasoning"].some((key) => !Number.isFinite(result!.usage[key as keyof TokenUsage]) || result!.usage[key as keyof TokenUsage] < 0)) throw new CompatibilityError("Pi execution failed.", null, 502, failureCode);
    if (Buffer.byteLength(result.text) !== outputBytes || outputHash.digest("hex") !== createHash("sha256").update(result.text).digest("hex")) throw new CompatibilityError("Pi stream did not match the completed output.", null, 502, "invalid_stream");
    return result;
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    throw error instanceof CompatibilityError ? error : new CompatibilityError("Pi execution failed.", null, 502, "worker_transport_error");
  } finally {
    clearTimeout(startupTimer);
    signal.removeEventListener("abort", abort);
    if (child.exitCode === null && child.signalCode === null) { abort(); await exited.catch(() => {}); }
    // Reap request-owned descendants even if the worker leader already exited.
    kill(true);
    if (killTimer) clearTimeout(killTimer);
  }
}
