import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { registerBrowserRoutes } from "./routes.ts";
import { browserRuntimeVersion } from "./version.ts";

export async function runLocalServer(directory: string) {
  const runtimeVersion = browserRuntimeVersion();
  const path = join(directory, "connection.json");
  const state = JSON.parse(await readFile(path, "utf8")) as { token: string; profile: string; port: number };
  const server = Fastify({ bodyLimit: 128 * 1024, logger: false });
  await server.register(websocket, { options: { maxPayload: 8 * 1024 * 1024 } });
  server.addHook("onRequest", async (request, reply) => {
    if (request.headers.host !== `127.0.0.1:${state.port}`) return reply.code(403).send({ error: "Host refused" });
  });
  const authorized = (request: { headers: { authorization?: string } }) => {
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    return !!token && Buffer.byteLength(token) === Buffer.byteLength(state.token) && timingSafeEqual(Buffer.from(token), Buffer.from(state.token));
  };
  const broker = await registerBrowserRoutes(server, {
    file: join(directory, "credentials.json"), port: state.port, available: true, local: true,
    validateProfile: async profile => { if (profile !== state.profile) throw new Error("Unknown profile"); },
    guard: (request, reply) => {
      if (authorized(request)) return true;
      reply.code(401).send({ error: "Unauthorized" }); return false;
    },
  });
  server.post("/api/browser/local/stop", async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    setTimeout(() => { void close(); }, 100);
    return { stopping: true };
  });
  broker.workerTokens.set(state.profile, state.token);
  await server.listen({ port: state.port, host: "127.0.0.1" });
  await writeFile(path, JSON.stringify({ ...state, pid: process.pid, runtimeVersion }), { mode: 0o600 });
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    await server.close();
    await unlink(join(directory, "starting.lock")).catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => { void close(); });
  process.on("SIGINT", () => { void close(); });
}
