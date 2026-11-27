import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BrowserBroker, type CredentialStore } from "./broker.ts";
import { browserAction, type BrowserAction } from "./actions.ts";

export const extensionOrigin = "chrome-extension://heidjicdbehhgidkhaofophkickmhijo";
export async function registerBrowserRoutes(server: FastifyInstance, options: {
  file: string | CredentialStore; port: number; endpoint?: string; available: boolean;
  guard(request: FastifyRequest, reply: FastifyReply): boolean;
  validateProfile(profile: string): Promise<unknown>;
  local?: boolean;
  pairingDownloadUrl?: string;
  loopback?: boolean;
  profileBinding?(profile: string): string;
  sharedLocal?: {
    workerProfile(token: string): Promise<string | undefined>;
  };
}) {
  const broker = new BrowserBroker(options.file, options.port, options.endpoint, !!options.sharedLocal);
  await broker.load();
  server.addHook("preClose", async () => broker.close());
  const attempts = new Map<string, { count: number; until: number }>();
  const transport = options.available && !options.local ? (options.loopback ? "loopback" : "remote") : undefined;
  const loopbackAuthority = options.loopback && options.endpoint ? new URL(options.endpoint).host : undefined;
  server.get(options.local ? "/extension" : "/api/browser/connect", {
    websocket: true,
    preValidation: async (request, reply) => {
      if (!options.available) return reply.code(503).send({ error: "Configure a public HTTPS origin before enabling remote browser pairing" });
      if (options.loopback && (request.headers.host !== loopbackAuthority || !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.raw.socket.remoteAddress ?? ""))) {
        return reply.code(403).send({ error: "Local Console browser connections must use the loopback API address" });
      }
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
      method: action === "status" ? "GET" : "POST", url: `/api/browser/profiles/:profile/${action}`,
      handler: async (request, reply) => {
        reply.header("cache-control", "private, no-store");
        if (!options.guard(request, reply)) return;
        const profile = request.params.profile;
        await options.validateProfile(profile);
        const binding = options.profileBinding ? options.profileBinding(profile) : profile;
        if (action === "status") return { available: options.available, transport, ...broker.status(binding) };
        if (action === "unpair") return broker.revoke(binding);
        if (!options.available) return reply.code(503).send({ error: "Remote pairing requires a public HTTPS origin" });
        if (options.profileBinding) {
          await broker.revokePreviousProfileBindings(profile, binding);
          if (options.profileBinding(profile) !== binding) return reply.code(409).send({ error: "Profile changed; request a new code" });
        }
        return broker.pair(binding);
      },
    });
  }
  server.post<{ Body: BrowserAction }>("/api/browser/worker/command", { bodyLimit: 128 * 1024 }, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const binding = options.sharedLocal ? await options.sharedLocal.workerProfile(token) : broker.workerProfile(token);
    if (!binding) return reply.code(401).send({ error: "Invalid browser worker capability" });
    if (!request.body || typeof request.body !== "object" || typeof request.body.action !== "string") return reply.code(400).send({ error: "A browser action is required" });
    try {
      const profile = options.profileBinding ? binding.split(":", 1)[0] : binding;
      await options.validateProfile(profile);
      if (options.profileBinding && options.profileBinding(profile) !== binding) return reply.code(401).send({ error: "Invalid browser worker capability" });
      if (!options.sharedLocal && broker.workerTokens.get(binding) !== token) return reply.code(401).send({ error: "Invalid browser worker capability" });
      if (request.body.action === "pair") {
        if (request.body.loopbackOnly && !options.loopback) return reply.code(403).send({ error: "Use the Console to manage remote browser pairing." });
        if (!transport || !options.endpoint || !options.pairingDownloadUrl) return reply.code(503).send({ error: "Profile pairing requires an available Console browser connection." });
        const address = new URL(options.endpoint).host;
        if (options.profileBinding) await broker.revokePreviousProfileBindings(profile, binding);
        if (broker.workerTokens.get(binding) !== token || (options.profileBinding && options.profileBinding(profile) !== binding)) return reply.code(401).send({ error: "Invalid browser worker capability" });
        return { result: { ...await broker.pair(binding), mode: transport, address, downloadUrl: options.pairingDownloadUrl, extensionSettingsUrl: `${extensionOrigin}/settings.html` } };
      }
      const shared = options.sharedLocal;
      const actionResult = await browserAction(shared ? {
        status: () => broker.sharedStatus(token),
        connection: (name, browser) => broker.sharedConnection(name, token, browser),
        rpc: broker.rpc.bind(broker),
      } : {
        status: () => broker.status(binding),
        connection: (_name, browser) => broker.connection(binding, browser),
        rpc: broker.rpc.bind(broker),
      }, profile, request.body);
      const result = request.body.action === "status" ? { ...(actionResult as object), available: options.available, transport } : actionResult;
      if (JSON.stringify(result)?.length > 8 * 1024 * 1024) return reply.code(413).send({ error: "Browser result too large; return a bounded slice" });
      return { result };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Browser command failed" }); }
  });
  return broker;
}
