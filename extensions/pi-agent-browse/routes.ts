import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BrowserBroker, type CredentialStore } from "./broker.ts";
import { browserAction, type BrowserAction } from "./actions.ts";

export const extensionOrigin = "chrome-extension://heidjicdbehhgidkhaofophkickmhijo";
export async function registerBrowserRoutes(server: FastifyInstance, options: {
  file: string | CredentialStore; port: number; endpoint?: string; available: boolean;
  guard(request: FastifyRequest, reply: FastifyReply): boolean;
  validateProfile(profile: string): Promise<unknown>;
  local?: boolean;
  sharedRemote?: boolean;
  sharedLocal?: {
    workerProfile(token: string): Promise<string | undefined>;
  };
}) {
  const broker = new BrowserBroker(options.file, options.port, options.endpoint, !!(options.sharedLocal || options.sharedRemote));
  await broker.load();
  server.addHook("preClose", async () => broker.close());
  const attempts = new Map<string, { count: number; until: number }>();
  server.get(options.local ? "/extension" : "/api/browser/connect", {
    websocket: true,
    preValidation: async (request, reply) => {
      if (!options.available) return reply.code(503).send({ error: "Configure a public HTTPS origin before enabling remote browser pairing" });
      if (request.headers.origin !== extensionOrigin) return reply.code(403).send({ error: "Extension origin refused" });
      const now = Date.now();
      for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      // Deliberately use the socket peer, not untrusted forwarded headers. Shared proxies share this budget.
      let entry = attempts.get(request.ip);
      if (!entry) {
        if (attempts.size >= 2048) return reply.code(429).send({ error: "Pairing rate limit" });
        entry = { count: 0, until: now + 60_000 }; attempts.set(request.ip, entry);
      }
      if (++entry.count > 30) return reply.code(429).send({ error: "Pairing rate limit" });
    },
  }, socket => broker.accept(socket));
  for (const action of ["pair", "status", "unpair"] as const) {
    server.route<{ Params: { profile: string } }>({
      method: action === "status" ? "GET" : "POST", url: options.sharedRemote ? `/api/browser/shared/${action}` : `/api/browser/profiles/:profile/${action}`,
      handler: async (request, reply) => {
        reply.header("cache-control", "private, no-store");
        if (!options.guard(request, reply)) return;
        const profile = options.sharedRemote ? "default" : request.params.profile;
        if (!options.sharedRemote) await options.validateProfile(profile);
        if (action === "status") return { available: options.available, ...broker.status(profile) };
        if (action === "unpair") return broker.revoke(profile);
        if (!options.available) return reply.code(503).send({ error: "Remote pairing requires a public HTTPS origin" });
        return broker.pair(profile);
      },
    });
  }
  server.post<{ Body: BrowserAction }>("/api/browser/worker/command", { bodyLimit: 128 * 1024 }, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const profile = options.sharedLocal ? await options.sharedLocal.workerProfile(token) : broker.workerProfile(token);
    if (!profile) return reply.code(401).send({ error: "Invalid browser worker capability" });
    if (!request.body || typeof request.body !== "object" || typeof request.body.action !== "string") return reply.code(400).send({ error: "A browser action is required" });
    try {
      await options.validateProfile(profile);
      if (options.sharedRemote && broker.workerTokens.get(profile) !== token) return reply.code(401).send({ error: "Invalid browser worker capability" });
      const shared = options.sharedLocal || options.sharedRemote;
      const actionResult = await browserAction(shared ? {
        status: () => broker.sharedStatus(token),
        connection: (name, browser) => broker.sharedConnection(name, token, browser),
        rpc: broker.rpc.bind(broker),
      } : broker, profile, request.body);
      const result = request.body.action === "status" ? { ...(actionResult as object), available: options.available } : actionResult;
      if (JSON.stringify(result)?.length > 8 * 1024 * 1024) return reply.code(413).send({ error: "Browser result too large; return a bounded slice" });
      return { result };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Browser command failed" }); }
  });
  return broker;
}
