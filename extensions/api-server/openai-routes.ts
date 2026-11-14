/** OpenAI-compatible HTTP endpoints; protocol framing is independent of Pi execution. */
import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { handleClientToolResponse } from "./openai-client-routes.ts";
import type { ClientToolsRuntime } from "./openai-client-runtime.ts";
import { OPENAI_BODY_BYTES } from "../lib/openai-limits.ts";
import { CompatibilityError, chatUsage, errorBody, normalizeRequest, outputMessage, responseObject, type CompletionRequest, type CompletionResult, type ExecutionEvent } from "./openai-contract.ts";

export type CompatibilityBackend = {
  clientTools?: ClientToolsRuntime;
  authorized(authorization: string | undefined): boolean;
  profiles(): Promise<Array<{ name: string }>>;
  validateProfile(profile: string): Promise<void>;
  execute(request: CompletionRequest, emit: (event: ExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<CompletionResult>;
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
    routes.addHook("onRequest", async (request, reply) => {
      if (!backend.authorized(request.headers.authorization)) return reply.code(401).send(errorBody(new CompatibilityError("Invalid API key.", null, 401, "invalid_api_key")));
    });
    routes.setErrorHandler((error, _request, reply) => {
      const details = error as { code?: string; statusCode?: number };
      const known = error instanceof CompatibilityError ? error : details.code === "FST_ERR_CTP_BODY_TOO_LARGE" ? new CompatibilityError("Request body is too large.", null, 413, "request_too_large") : details.statusCode === 400 || details.statusCode === 415 ? new CompatibilityError("Invalid JSON request body or content type.", null, details.statusCode) : error;
      reply.code(known instanceof CompatibilityError ? known.status : 500).send(errorBody(known));
    });
    routes.get("/models", async () => ({ object: "list", data: (await backend.profiles()).map(({ name }) => ({ id: name, object: "model", created: 0, owned_by: "pi" })) }));
    for (const protocol of ["chat", "responses"] as const) {
      routes.post(protocol === "chat" ? "/chat/completions" : "/responses", { bodyLimit: OPENAI_BODY_BYTES }, async (request, reply) => {
        let legacy: CompletionRequest | undefined;
        if (protocol === "responses" && backend.clientTools) {
          const selected = await backend.clientTools.select(request.body);
          if (selected.client) return handleClientToolResponse(request, reply, selected.client, backend.clientTools, writeSse);
          legacy = selected.legacy;
        }
        const input = legacy ?? normalizeRequest(request.body, protocol);
        await backend.validateProfile(input.profile);
        const controller = new AbortController();
        const disconnected = () => { if (!reply.raw.writableEnded) controller.abort(); };
        reply.raw.on("close", disconnected);
        request.raw.on("aborted", disconnected);
        if (request.raw.aborted || reply.raw.destroyed) controller.abort();
        const id = `${protocol === "chat" ? "chatcmpl" : "resp"}_${randomUUID().replaceAll("-", "")}`;
        const itemId = `msg_${randomUUID().replaceAll("-", "")}`;
        const created = Math.floor(Date.now() / 1000);
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
          }
        };
        try {
          controller.signal.throwIfAborted();
          const result = await backend.execute(input, emit, controller.signal);
          if (!input.stream) {
            if (protocol === "chat") return { id, object: "chat.completion", created, model: input.profile, choices: [{ index: 0, message: { role: "assistant", content: result.text, refusal: null }, logprobs: null, finish_reason: result.finishReason }], usage: chatUsage(result.usage) };
            return responseObject(input, id, created, [outputMessage(itemId, result.text, result.finishReason === "length" ? "incomplete" : "completed")], result);
          }
          if (!streaming || result.text !== partial) throw new CompatibilityError("Pi stream did not match the completed output.", null, 502, "invalid_stream");
          if (protocol === "chat") {
            await data(chunk({}, result.finishReason));
            if (input.includeUsage) await data({ id, object: "chat.completion.chunk", created, model: input.profile, choices: [], usage: chatUsage(result.usage) });
            await data("[DONE]");
          } else {
            const item = outputMessage(itemId, result.text, result.finishReason === "length" ? "incomplete" : "completed");
            await event("response.output_text.done", { ...position, text: result.text, logprobs: [] });
            await event("response.content_part.done", { ...position, part: item.content[0] });
            await event("response.output_item.done", { output_index: 0, item });
            await event(result.finishReason === "length" ? "response.incomplete" : "response.completed", { response: responseObject(input, id, created, [item], result) });
          }
          reply.raw.end();
        } catch (error) {
          if (controller.signal.aborted || reply.raw.destroyed) return;
          if (!streaming) throw error;
          const failure = errorBody(error).error;
          try {
            if (protocol === "chat") { await data({ error: failure }); await data("[DONE]"); }
            else await event("response.failed", { response: { ...responseObject(input, id, created, [outputMessage(itemId, partial, "incomplete")]), status: "failed", error: { code: "server_error", message: failure.message } } });
            reply.raw.end();
          } catch { controller.abort(); reply.raw.destroy(); }
        } finally {
          reply.raw.off("close", disconnected); request.raw.off("aborted", disconnected);
        }
      });
    }
  }, { prefix: "/v1" });
}
