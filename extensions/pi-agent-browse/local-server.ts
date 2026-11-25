import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { registerBrowserRoutes } from "./routes.ts";
import { browserRuntimeVersion } from "./version.ts";
import { localBrowserDirectory, localBrowserKey, localBrowserPort, localBrowserSecret, localBrowserSecretMatches, localProfileIdentity } from "./local-access.ts";

type Grant = { profile: string; identity: string; browser: string };

export async function runLocalServer(root: string, port = localBrowserPort) {
  const directory = localBrowserDirectory(root);
  const key = await localBrowserKey(root);
  const admin = localBrowserSecret(key, "admin");
  const grantsPath = join(directory, "grants.json");
  let grants: Grant[] = [];
  try {
    grants = JSON.parse(await readFile(grantsPath, "utf8"));
    if (!Array.isArray(grants) || grants.length > 1024 || grants.some(g => !g || [g.profile, g.identity, g.browser].some(value => typeof value !== "string"))) throw new Error("Invalid local browser grants");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
      // The shared Chrome connection is paired independently of named profiles.
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
      async authorizedBrowsers(profile, token) {
        const id = await identity(profile);
        if (!id || !localBrowserSecretMatches(token, `${profile}.${localBrowserSecret(key, "worker", profile, id)}`)) throw new Error("Invalid browser worker capability");
        // Read the live grants only once identity lookup is complete, without an asynchronous gap before dispatch.
        return () => {
          const paired = new Set(broker.browserStatus().browsers.map(browser => browser.id));
          return grants.filter(g => g.profile === profile && g.identity === id && paired.has(g.browser)).map(g => g.browser);
        };
      },
    },
  });
  let changes = Promise.resolve();
  server.get("/api/browser/local/status", async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    const status = broker.browserStatus();
    const paired = new Set(status.browsers.map(browser => browser.id));
    const valid = await Promise.all(grants.map(async g => paired.has(g.browser) && await identity(g.profile) === g.identity ? { profile: g.profile, browser: g.browser } : undefined));
    return { ...status, runtimeVersion, grants: valid.filter(Boolean) };
  });
  const saveGrants = async (next: Grant[]) => {
    const temporary = `${grantsPath}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 });
    await rename(temporary, grantsPath);
    grants = next;
  };
  server.post("/api/browser/local/unpair", async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    const change = changes.then(async () => {
      const previous = grants;
      await saveGrants([]);
      for (const grant of previous) broker.clearScope(grant.profile, grant.browser);
      return broker.revoke("default");
    });
    changes = change.then(() => {}, () => {});
    return change;
  });
  server.post<{ Body: { profile?: string; browser?: string; revoke?: boolean } }>("/api/browser/local/grant", async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    const { profile, browser, revoke } = request.body ?? {};
    if (typeof profile !== "string" || (browser !== undefined && typeof browser !== "string")) return reply.code(400).send({ error: "Provide a profile and optional browser ID" });
    const change = changes.then(async () => {
      const id = await identity(profile);
      if (!id && !revoke) throw new Error("Unknown profile");
      const paired = broker.browserStatus().browsers.filter(item => !browser || item.id === browser);
      if (!revoke && paired.length !== 1) throw new Error(paired.length ? "Select a browser ID from pi browser status" : "Pair Chrome before granting access");
      const selected = revoke ? browser : paired[0].id;
      const stale = grants.filter(g => g.profile === profile && (!selected || selected === g.browser) && (revoke || g.identity !== id));
      const next = grants.filter(g => !stale.includes(g));
      if (!revoke && !next.some(g => g.profile === profile && g.browser === selected)) next.push({ profile, identity: id!, browser: selected! });
      if (next.length > 1024) throw new Error("Too many browser grants");
      await saveGrants(next);
      for (const g of stale) broker.clearScope(g.profile, g.browser);
      return { profile, browser: selected, authorized: !revoke };
    });
    changes = change.then(() => {}, () => {});
    try { return await change; }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
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
