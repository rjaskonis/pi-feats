import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { OpenAICallLogs, OpenAICallQuery } from "./openai-call-logs.ts";

export function registerOpenAICallLogRoutes(server: FastifyInstance, logs: OpenAICallLogs, guard: (request: FastifyRequest, reply: FastifyReply) => boolean) {
  const base = "/api/openai-api-logs";
  const streams = new Set<() => void>();
  server.addHook("preClose", async () => { for (const close of streams) close(); });
  server.get<{ Querystring: OpenAICallQuery }>(base, async (request, reply) => {
    if (!guard(request, reply)) return;
    const { endpoint, profile, outcome, before, start, end } = request.query;
    const invalid = [endpoint, profile, outcome, before, start, end].some((value) => value !== undefined && typeof value !== "string");
    const startMs = start ? Date.parse(start) : undefined, endMs = end ? Date.parse(end) : undefined;
    if (invalid || (start && !Number.isFinite(startMs)) || (end && !Number.isFinite(endMs)) || (startMs !== undefined && endMs !== undefined && startMs > endMs)) {
      return reply.code(400).send({ error: "Invalid log filter or date range." });
    }
    reply.header("cache-control", "no-store");
    return logs.list({ endpoint, profile, outcome, before, start: startMs === undefined ? undefined : new Date(startMs).toISOString(), end: endMs === undefined ? undefined : new Date(endMs).toISOString() });
  });
  server.get<{ Params: { id: string } }>(`${base}/calls/:id`, async (request, reply) => {
    if (!guard(request, reply)) return;
    reply.header("cache-control", "no-store");
    const detail = logs.detail(request.params.id);
    if (!detail) return reply.code(404).send({ error: "Call not found." });
    return detail;
  });
  // Send only invalidations; payloads stay on the authenticated detail endpoint.
  // The same-origin Console proxy already forwards streaming HTTP responses.
  server.get(`${base}/stream`, async (request, reply) => {
    if (!guard(request, reply)) return;
    if (streams.size >= 64) return reply.code(503).send({ error: "Too many log subscribers." });
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" });
    const write = (frame: string) => { if (!response.write(frame)) response.destroy(); };
    const unsubscribe = logs.subscribe((id) => write(`data: ${JSON.stringify(id)}\n\n`));
    const heartbeat = setInterval(() => write(": keepalive\n\n"), 15_000);
    heartbeat.unref();
    const close = () => { unsubscribe(); clearInterval(heartbeat); streams.delete(close); if (!response.writableEnded) response.end(); };
    streams.add(close);
    response.once("close", close);
    write(": connected\n\n");
  });
}
