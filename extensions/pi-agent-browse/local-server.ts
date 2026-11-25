import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { join } from "node:path";
import { registerBrowserRoutes } from "./routes.ts";
import { browserRuntimeVersion } from "./version.ts";
import { localBrowserDirectory, localBrowserKey, localBrowserPort, localBrowserSecret, localBrowserSecretMatches, localProfileIdentity } from "./local-access.ts";

export async function runLocalServer(root: string, port = localBrowserPort) {
  const directory = localBrowserDirectory(root);
  const key = await localBrowserKey(root);
  const admin = localBrowserSecret(key, "admin");
  const runtimeVersion = browserRuntimeVersion();
  const server = Fastify({ bodyLimit: 128 * 1024, logger: false });
  await server.register(websocket, { options: { maxPayload: 8 * 1024 * 1024 } });
  server.addHook("onRequest", async (request, reply) => {
    if (request.headers.host !== `127.0.0.1:${port}`) return reply.code(403).send({ error: "Host refused" });
    reply.header("cache-control", "private, no-store");
  });
  const identity = (profile: string) => localProfileIdentity(root, profile).catch(() => undefined);
  const authorized = (request: { headers: { authorization?: string } }) => localBrowserSecretMatches(request.headers.authorization ?? "", `Bearer ${admin}`);
  const broker = await registerBrowserRoutes(server, {
    file: join(directory, "credentials.json"), port, available: true, local: true,
    validateProfile: async profile => { if (!await identity(profile)) throw new Error("Unknown profile"); },
    guard: (request, reply) => {
      if (authorized(request) && ["/api/browser/profiles/default/pair", "/api/browser/profiles/default/status"].includes(request.url)) return true;
      reply.code(401).send({ error: "Unauthorized" }); return false;
    },
    sharedLocal: {
      async workerProfile(token) {
        const match = /^([a-zA-Z][a-zA-Z0-9_-]{0,63})\.([A-Za-z0-9_-]{43})$/.exec(token);
        if (!match) return undefined;
        const id = await identity(match[1]);
        if (id && localBrowserSecretMatches(match[2], localBrowserSecret(key, "worker", match[1], id))) return match[1];
      },
    },
  });
  server.get("/api/browser/local/status", async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    return { ...broker.status("default"), runtimeVersion };
  });
  server.post("/api/browser/local/unpair", async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    return broker.revoke("default");
  });
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    await server.close();
    process.exit(0);
  };
  server.post("/api/browser/local/stop", async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    setTimeout(() => { void close(); }, 100);
    return { stopping: true };
  });
  await server.listen({ port, host: "127.0.0.1" });
  process.on("SIGTERM", () => { void close(); });
  process.on("SIGINT", () => { void close(); });
}
