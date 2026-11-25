import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { registerBrowserRoutes, extensionOrigin } from "../extensions/pi-agent-browse/routes.ts";

test("unconfigured remote transport reports unavailable and cannot issue codes or upgrade", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-browser-unavailable-"));
  const server = Fastify();
  await server.register(websocket);
  await registerBrowserRoutes(server, { file: join(directory, "credentials.json"), port: 443, available: false, validateProfile: async () => {}, guard: () => true });
  try {
    const status = await server.inject({ method: "GET", url: "/api/browser/profiles/default/status" });
    assert.equal(status.json().available, false);
    assert.equal(status.headers["cache-control"], "private, no-store");
    assert.equal((await server.inject({ method: "POST", url: "/api/browser/profiles/default/pair" })).statusCode, 503);
    const upgrade = await server.inject({ method: "GET", url: "/api/browser/connect", headers: { origin: extensionOrigin, connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    assert.equal(upgrade.statusCode, 503);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
