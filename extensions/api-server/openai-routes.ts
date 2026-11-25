/** OpenAI-compatible HTTP endpoints; protocol framing is independent of Pi execution. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { OpenAICallCapture } from "./openai-call-capture.ts";
import type { CallStage, OpenAICallDetail, OpenAICallLog } from "../lib/openai-call-log-types.ts";
import { randomUUID } from "node:crypto";
import { handleClientToolResponse } from "./openai-client-routes.ts";
import { LATENCY_ID_HEADER, LATENCY_TRACE_HEADER, latencyMs, type LatencyRecord, type LatencyTrace } from "./latency-trace.ts";
import type { ClientToolsRuntime } from "./openai-client-runtime.ts";
import { OPENAI_BODY_BYTES } from "../lib/openai-limits.ts";
import { CompatibilityError, chatUsage, errorBody, normalizeRequest, outputMessage, responseObject, type CompletionRequest, type CompletionResult, type ExecutionEvent } from "./openai-contract.ts";

export type CompatibilityBackend = {
  clientTools?: ClientToolsRuntime;
  authorized(authorization: string | undefined): boolean;
  profiles(): Promise<Array<{ name: string }>>;
  validateProfile(profile: string): Promise<void>;
  execute(request: CompletionRequest, emit: (event: ExecutionEvent) => Promise<void>, signal: AbortSignal, trace?: LatencyTrace): Promise<CompletionResult>;
  logLatency?(record: LatencyRecord): void;
  logCall?(record: OpenAICallLog, stages: CallStage[]): void;
  updateCall?(detail: OpenAICallDetail): void;
};
const responseId = (protocol: "chat" | "responses") => `${protocol === "chat" ? "chatcmpl" : "resp"}_${randomUUID().replaceAll("-", "")}`;

function captureCall(reply: FastifyReply, call: OpenAICallCapture, record: NonNullable<CompatibilityBackend["logCall"]>) {
  const recordOutcome = (completed: boolean) => {
    reply.raw.off("finish", finish);
    reply.raw.off("close", close);
    const httpStatus = reply.raw.headersSent ? reply.raw.statusCode : null;
    try { record(call.finish(httpStatus, completed), call.detail()); }
    catch { /* Logging must not change the response. */ }
  };
  const finish = () => recordOutcome(true);
  const close = () => recordOutcome(reply.raw.writableFinished);
  reply.raw.once("finish", finish);
  reply.raw.once("close", close);
};

/** Wait for writable backpressure without leaving close/error listeners behind. */
export async function writeSse(reply: FastifyReply, frame: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (reply.raw.destroyed) throw new Error("Response connection closed.");
  if (reply.raw.write(frame)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => error(new CompatibilityError("The response consumer is too slow.", null, 502, "slow_consumer")), 30_000);
    timer.unref();
    const cleanup = () => { clearTimeout(timer); reply.raw.off("drain", drain); reply.raw.off("close", close); reply.raw.off("error", error); signal.removeEventListener("abort", close); };
    const drain = () => { cleanup(); resolve(); };
    const close = () => { cleanup(); reject(new Error("Response connection closed.")); };
    const error = (cause: Error) => { cleanup(); reject(cause); };
    reply.raw.once("drain", drain); reply.raw.once("close", close); reply.raw.once("error", error); signal.addEventListener("abort", close, { once: true });
    if (signal.aborted || reply.raw.destroyed) close();
  });
}

/** Register an encapsulated /v1 API with its own OpenAI error envelope. */
export function registerCompatibilityRoutes(server: FastifyInstance, backend: CompatibilityBackend): void {
  server.register(async (routes) => {
    const calls = new WeakMap<FastifyRequest, OpenAICallCapture>();
    routes.addHook("onRequest", async (request, reply) => {
      if (!backend.authorized(request.headers.authorization)) return reply.code(401).send(errorBody(new CompatibilityError("Invalid API key.", null, 401, "invalid_api_key")));
    });
    routes.setErrorHandler((error, request, reply) => {
      const details = error as { code?: string; statusCode?: number };
      const known = error instanceof CompatibilityError ? error : details.code === "FST_ERR_CTP_BODY_TOO_LARGE" ? new CompatibilityError("Request body is too large.", null, 413, "request_too_large") : details.statusCode === 400 || details.statusCode === 415 ? new CompatibilityError("Invalid JSON request body or content type.", null, details.statusCode) : error;
      const body = errorBody(known), call = calls.get(request);
      call?.fail(body.error.code, body);
      reply.code(known instanceof CompatibilityError ? known.status : 500).send(body);
    });
    routes.get("/models", async () => ({ object: "list", data: (await backend.profiles()).map(({ name }) => ({ id: name, object: "model", created: 0, owned_by: "pi" })) }));
    for (const protocol of ["chat", "responses"] as const) {
      const route = protocol === "chat" ? "/chat/completions" : "/responses";
      routes.post(route, { bodyLimit: OPENAI_BODY_BYTES, onRequest: async (request, reply) => {
        if (!backend.logCall) return;
        const call = new OpenAICallCapture(responseId(protocol), `/v1${route}`, backend.updateCall);
        calls.set(request, call);
        captureCall(reply, call, backend.logCall);
      } }, async (request, reply) => {
        const call = calls.get(request), id = call?.call.id ?? responseId(protocol);
        if (call && request.body && typeof request.body === "object") {
          const { model, stream } = request.body as { model?: unknown; stream?: unknown };
          if (typeof model === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(model)) call.call.profile = model;
          call.call.stream = stream === undefined ? false : typeof stream === "boolean" ? stream : null;
        }
        if (call) {
          call.stage("request", request.body);
          call.stage("validation", { profile: call.call.profile, streaming: call.call.stream });
        }
        let legacy: CompletionRequest | undefined;
        if (protocol === "responses" && backend.clientTools) {
          const selected = await backend.clientTools.select(request.body);
          if (selected.client) return handleClientToolResponse(request, reply, selected.client, backend.clientTools, writeSse, id, call);
          legacy = selected.legacy;
        }
        const input = legacy ?? normalizeRequest(request.body, protocol);
        const trace: LatencyTrace | undefined = backend.logLatency && request.headers[LATENCY_TRACE_HEADER] === "1" ? { started: performance.now() } : undefined;
        const controller = new AbortController();
        const disconnected = () => { if (!reply.raw.writableEnded) controller.abort(); };
        reply.raw.on("close", disconnected);
        request.raw.on("aborted", disconnected);
        if (request.raw.aborted || reply.raw.destroyed) controller.abort();
        const itemId = `msg_${randomUUID().replaceAll("-", "")}`;
        const created = Math.floor(Date.now() / 1000);
        if (trace) reply.header(LATENCY_ID_HEADER, id);
        let outcome: LatencyRecord["outcome"] = "error";
        let streaming = false, sequence = 0, partial = "";
        const data = (value: unknown) => writeSse(reply, `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`, controller.signal);
        const event = (type: string, value: Record<string, unknown>) => writeSse(reply, `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`, controller.signal);
        const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({ id, object: "chat.completion.chunk", created, model: input.profile, choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }], ...(input.includeUsage ? { usage: null } : {}) });
        const position = { item_id: itemId, output_index: 0, content_index: 0 };
        const emit = async (value: ExecutionEvent) => {
          if (!input.stream) return;
          controller.signal.throwIfAborted();
          if (value.type === "ready") {
            if (streaming) throw new CompatibilityError("Duplicate stream initialization.", null, 502, "invalid_stream");
            reply.hijack();
            for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(name, value);
            reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
            reply.raw.flushHeaders(); streaming = true;
            if (protocol === "chat") await data(chunk({ role: "assistant", content: "" }));
            else {
              const response = responseObject(input, id, created, []);
              await event("response.created", { response });
              await event("response.in_progress", { response });
              await event("response.output_item.added", { output_index: 0, item: { ...outputMessage(itemId, "", "in_progress"), content: [] } });
              await event("response.content_part.added", { ...position, part: { type: "output_text", text: "", annotations: [], logprobs: [] } });
            }
          } else {
            if (!streaming) throw new CompatibilityError("Pi stream was not initialized.", null, 502, "invalid_stream");
            partial += value.delta;
            if (protocol === "chat") await data(chunk({ content: value.delta }));
            else await event("response.output_text.delta", { ...position, delta: value.delta, logprobs: [] });
            call?.append(value.delta);
          }
        };
        try {
          controller.signal.throwIfAborted();
          await backend.validateProfile(input.profile);
          call?.stage("execution");
          const result = await backend.execute(input, emit, controller.signal, trace);
          const chatResponse = () => ({ id, object: "chat.completion", created, model: input.profile, choices: [{ index: 0, message: { role: "assistant", content: result.text, refusal: null }, logprobs: null, finish_reason: result.finishReason }] });
          const resultItem = () => outputMessage(itemId, result.text, result.finishReason === "length" ? "incomplete" : "completed");
          if (!input.stream) {
            outcome = "success";
            const response = protocol === "chat" ? { ...chatResponse(), usage: chatUsage(result.usage) } : responseObject(input, id, created, [resultItem()], result);
            call?.stage("response", response);
            return response;
          }
          if (!streaming || result.text !== partial) throw new CompatibilityError("Pi stream did not match the completed output.", null, 502, "invalid_stream");
          call?.stage("response");
          if (protocol === "chat") {
            await data(chunk({}, result.finishReason));
            if (input.includeUsage) await data({ id, object: "chat.completion.chunk", created, model: input.profile, choices: [], usage: chatUsage(result.usage) });
            await data("[DONE]");
            call?.stage("response", { response: { ...chatResponse(), ...(input.includeUsage ? { usage: chatUsage(result.usage) } : {}) }, terminalEvent: "[DONE]" });
          } else {
            const item = resultItem();
            await event("response.output_text.done", { ...position, text: result.text, logprobs: [] });
            await event("response.content_part.done", { ...position, part: item.content[0] });
            await event("response.output_item.done", { output_index: 0, item });
            const type = result.finishReason === "length" ? "response.incomplete" : "response.completed";
            const response = responseObject(input, id, created, [item], result);
            const terminalEvent = { type, sequence_number: sequence };
            await event(type, { response });
            call?.stage("response", { response, terminalEvent });
          }
          reply.raw.end();
          outcome = "success";
        } catch (error) {
          if (controller.signal.aborted || reply.raw.destroyed) return;
          if (!streaming) throw error;
          const failure = errorBody(error).error;
          call?.fail(failure.code, failure, protocol === "chat" ? "[DONE]" : { type: "response.failed", sequence_number: sequence });
          try {
            if (protocol === "chat") { await data({ error: failure }); await data("[DONE]"); }
            else await event("response.failed", { response: { ...responseObject(input, id, created, [outputMessage(itemId, partial, "incomplete")]), status: "failed", error: failure } });
            reply.raw.end();
          } catch { controller.abort(); reply.raw.destroy(); }
        } finally {
          if (trace) {
            const { started, ...metrics } = trace;
            try { backend.logLatency?.({ id, protocol, stream: input.stream, outcome: controller.signal.aborted ? "aborted" : outcome, totalMs: latencyMs(performance.now() - started), ...metrics }); }
            catch { /* Diagnostics must not change the response. */ }
          }
          reply.raw.off("close", disconnected); request.raw.off("aborted", disconnected);
        }
      });
    }
  }, { prefix: "/v1" });
}
