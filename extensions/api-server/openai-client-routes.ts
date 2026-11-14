/** Responses framing for opt-in delegated functions; legacy framing stays separate. */
import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { errorBody, outputMessage, responseObject, type ExecutionEvent } from "./openai-contract.ts";
import { clientError, type ClientRequest, type ClientLeg } from "./openai-client-contract.ts";
import type { ClientToolsRuntime } from "./openai-client-runtime.ts";

type SseWriter = (reply: FastifyReply, frame: string, signal: AbortSignal) => Promise<void>;
export async function handleClientToolResponse(request: FastifyRequest, reply: FastifyReply, input: ClientRequest, runtime: ClientToolsRuntime, write: SseWriter): Promise<FastifyReply> {
  const controller = new AbortController();
  let finished = false;
  const disconnected = () => { if (!finished) { controller.abort(); runtime.cancel(input); } cleanup(); };
  const completed = () => { finished = true; cleanup(); };
  const cleanup = () => { reply.raw.off("close", disconnected); reply.raw.off("finish", completed); request.raw.off("aborted", disconnected); };
  reply.raw.once("close", disconnected); reply.raw.once("finish", completed); request.raw.once("aborted", disconnected);
  if (request.raw.aborted || reply.raw.destroyed) disconnected();
  const id = `resp_${randomUUID().replaceAll("-", "")}`, messageId = `msg_${randomUUID().replaceAll("-", "")}`, created = Math.floor(Date.now() / 1000);
  let sequence = 0, streaming = false, textStarted = false, ready = false, partial = "";
  const position = { item_id: messageId, output_index: 0, content_index: 0 };
  const response = (output: unknown[], leg?: ClientLeg) => ({ ...responseObject(input.request, id, created, output, leg ? { text: leg.text, usage: leg.usage, finishReason: leg.finishReason } : undefined), tools: leg?.tools ?? input.tools, parallel_tool_calls: !!leg && leg.calls.length > 1 });
  const event = (type: string, fields: Record<string, unknown>) => write(reply, `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`, controller.signal);
  const emit = async (value: ExecutionEvent) => {
    if (value.type === "ready") {
      if (ready) throw clientError("invalid_stream", "Duplicate stream initialization.", 502);
      ready = true;
      if (!input.request.stream) return;
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(name, value);
      reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" }); reply.raw.flushHeaders(); streaming = true;
      await event("response.created", { response: response([]) }); await event("response.in_progress", { response: response([]) });
    } else {
      if (!ready) throw clientError("invalid_stream", "Stream was not initialized.", 502);
      partial += value.delta;
      if (!input.request.stream) return;
      if (!textStarted) {
        textStarted = true;
        await event("response.output_item.added", { output_index: 0, item: { ...outputMessage(messageId, "", "in_progress"), content: [] } });
        await event("response.content_part.added", { ...position, part: { type: "output_text", text: "", annotations: [], logprobs: [] } });
      }
      await event("response.output_text.delta", { ...position, delta: value.delta, logprobs: [] });
    }
  };
  try {
    const leg = await runtime.execute(input, emit, controller.signal);
    if (!ready || partial !== leg.text) throw clientError("invalid_stream", "Pi output does not match the completed stream.", 502);
    const output: unknown[] = [];
    if (leg.text) output.push(outputMessage(messageId, leg.text, leg.finishReason === "length" ? "incomplete" : "completed"));
    output.push(...leg.calls);
    if (!input.request.stream) { reply.send(response(output, leg)); return reply; }
    if (textStarted) {
      const item = output[0] as ReturnType<typeof outputMessage>;
      await event("response.output_text.done", { ...position, text: leg.text, logprobs: [] });
      await event("response.content_part.done", { ...position, part: item.content[0] });
      await event("response.output_item.done", { output_index: 0, item });
    }
    for (const [offset, call] of leg.calls.entries()) {
      const output_index = offset + (leg.text ? 1 : 0), at = { item_id: call.id, output_index };
      await event("response.output_item.added", { output_index, item: { ...call, arguments: "", status: "in_progress" } });
      await event("response.function_call_arguments.delta", { ...at, delta: call.arguments });
      await event("response.function_call_arguments.done", { ...at, arguments: call.arguments });
      await event("response.output_item.done", { output_index, item: call });
    }
    await event(leg.finishReason === "length" ? "response.incomplete" : "response.completed", { response: response(output, leg) });
    reply.raw.end(); return reply;
  } catch (error) {
    if (controller.signal.aborted || reply.raw.destroyed) return reply;
    // A validation rejection can leave an issued delegation waiting for a
    // corrected result. Transport failures must instead cancel its worker.
    if (streaming) {
      runtime.cancel(input);
      try { await event("response.failed", { response: { ...response(partial ? [outputMessage(messageId, partial, "incomplete")] : []), status: "failed", error: { code: "server_error", message: errorBody(error).error.message } } }); reply.raw.end(); }
      catch { controller.abort(); reply.raw.destroy(); }
      return reply;
    }
    cleanup(); throw error;
  }
}
