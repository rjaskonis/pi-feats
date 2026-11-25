import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { registerBrowserRoutes, extensionOrigin } from "../extensions/pi-agent-browse/routes.ts";
import { ecdhKeyPair, normalizePairingCode, pairingCodeMaterial, pairingProof, pairingSessionKey, randomNonce, sameSecret, sessionProof, unwrapToken } from "../extensions/pi-agent-browse/pairing.ts";

const remoteEndpoint = "wss://pi.example/api/browser/connect";
async function fixture(available = true) {
  const directory = await mkdtemp(join(tmpdir(), "pi-browser-test-"));
  const server = Fastify();
  await server.register(websocket, { options: { maxPayload: 8 * 1024 * 1024 } });
  const broker = await registerBrowserRoutes(server, {
    file: join(directory, "credentials.json"), port: 443, endpoint: remoteEndpoint, available,
    guard: (request, reply) => { if (request.headers.authorization === "Bearer admin") return true; reply.code(401).send({ error: "Unauthorized" }); return false; },
    validateProfile: async profile => { if (!["default", "support"].includes(profile)) throw new Error("Unknown profile"); },
  });
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address() as { port: number };
  const endpoint = `ws://127.0.0.1:${address.port}/api/browser/connect`;
  return { directory, server, broker, endpoint, async close() { await server.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function connect(endpoint: string, browser: string, secret: { code: string } | { token: string }, proofEndpoint = remoteEndpoint) {
  const socket = new WebSocket(endpoint, { origin: extensionOrigin });
  const messages: any[] = [];
  const waiting: { resolve(value: any): void; reject(error: Error): void }[] = [];
  let closed: Error | undefined;
  const refuse = (error: Error) => { closed = error; for (const pending of waiting.splice(0)) pending.reject(error); };
  socket.on("close", code => refuse(new Error(`Pairing refused or disconnected (${code})`)));
  socket.on("error", refuse);
  socket.on("message", data => { const value = JSON.parse(data.toString()); if (waiting.length) waiting.shift()!.resolve(value); else messages.push(value); });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : closed ? Promise.reject(closed) : new Promise<any>((resolve, reject) => waiting.push({ resolve, reject }));
  await once(socket, "open");
  const nonce = randomNonce();
  const exchange = "code" in secret ? await ecdhKeyPair() : undefined;
  const send = (method: string, params: object = {}) => socket.send(JSON.stringify({ method, params }));
  send("protocol", { protocolVersion: 3 });
  send("hello", { protocolVersion: 3, profileId: browser, pairing: { nonce, mode: exchange ? "code" : "token", ecdh: exchange?.publicKey } });
  const challenge = await next();
  assert.equal(challenge.method, "auth.challenge");
  let token = "token" in secret ? secret.token : "";
  if (exchange && "code" in secret) {
    const key = await pairingSessionKey(await pairingCodeMaterial(normalizePairingCode(secret.code)!), (await exchange.secret(challenge.params.ecdh))!, { endpoint: proofEndpoint, port: 443, extensionNonce: nonce, relayNonce: challenge.params.nonce, extensionKey: exchange.publicKey, relayKey: challenge.params.ecdh });
    send("auth.code", { proof: await sessionProof(key, "extension") });
    const response = await next();
    assert.equal(response.method, "auth.token");
    assert.ok(sameSecret(await sessionProof(key, "relay"), response.params.proof));
    token = (await unwrapToken(key, response.params.wrapped))!;
  } else assert.ok(sameSecret(await pairingProof(token, "relay", 443, challenge.params.nonce, nonce, proofEndpoint), challenge.params.proof));
  send("auth.response", { proof: await pairingProof(token, "extension", 443, nonce, challenge.params.nonce, proofEndpoint) });
  send("ready");
  const settings = await next();
  assert.equal(settings.method, "relay.settings");
  socket.send(JSON.stringify({ id: settings.id, result: {} }));
  return { socket, token, next, send };
}

test("profile-bound pairing, command routing, persistence, reconnection and revocation", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const unauth = await f.server.inject({ method: "POST", url: "/api/browser/profiles/support/pair" });
    assert.equal(unauth.statusCode, 401);
    const paired = await f.server.inject({ method: "POST", url: "/api/browser/profiles/support/pair", headers: { authorization: "Bearer admin" } });
    const code = paired.json().code;
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    await assert.rejects(connect(f.endpoint, "wrong-code", { code: "0000-0000" }), /Pairing refused/);
    await assert.rejects(connect(f.endpoint, "wrong-host", { code }, "wss://other.example/api/browser/connect"), /Pairing refused/);
    const browser = await connect(f.endpoint, "test-browser", { code });
    await assert.rejects(connect(f.endpoint, "reuse-code", { code }), /Pairing refused/);
    const otherCode = await f.broker.pair("default");
    await assert.rejects(connect(f.endpoint, "test-browser", { code: otherCode.code }), /Pairing refused/);
    assert.equal(f.broker.status("support").browsers[0].connected, true);
    assert.equal(f.broker.status("default").browsers.length, 0);
    assert.equal((await stat(join(f.directory, "credentials.json"))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(join(f.directory, "credentials.json"), "utf8"))[0].token, browser.token);
    assert.equal((f.broker as any).codes.has("support"), false);
    const support = f.broker.workerToken("support");
    const other = f.broker.workerToken("default");
    const cannotAdmin = await f.server.inject({ method: "POST", url: "/api/browser/profiles/default/pair", headers: { authorization: `Bearer ${support}` } });
    assert.equal(cannotAdmin.statusCode, 401);
    const unknown = await f.server.inject({ method: "POST", url: "/api/browser/worker/command", headers: { authorization: "Bearer admin" }, payload: { action: "status" } });
    assert.equal(unknown.statusCode, 401, "admin token is not a worker capability");
    const denied = await f.server.inject({ method: "POST", url: "/api/browser/worker/command", headers: { authorization: `Bearer ${other}` }, payload: { action: "navigate", url: "https://example.com", profile: "support" } });
    assert.equal(denied.statusCode, 400);
    const command = f.server.inject({ method: "POST", url: "/api/browser/worker/command", headers: { authorization: `Bearer ${support}` }, payload: { action: "navigate", url: "https://example.com" } });
    for (const [method, result] of [["tabs.create", { tabId: 12 }], ["debugger.attach", {}], ["tabs.group", { groupId: 7 }], ["debugger.sendCommand", {}], ["debugger.sendCommand", {}], ["debugger.sendCommand", {}]] as const) {
      const message = await browser.next(); assert.equal(message.method, method);
      if (method === "tabs.create") assert.equal(message.params.active, false);
      if (method === "tabs.group") assert.deepEqual(message.params, { tabId: 12, sessionId: "Pi: support" });
      browser.socket.send(JSON.stringify({ id: message.id, result }));
    }
    assert.equal((await command).json().result.tabId, 12);
    const personal = await f.server.inject({ method: "POST", url: "/api/browser/worker/command", headers: { authorization: `Bearer ${support}` }, payload: { action: "evaluate", tabId: 99, expression: "location.href" } });
    assert.equal(personal.statusCode, 400);
    const closing = once(browser.socket, "close"); browser.socket.close(); await closing;
    const reconnect = await connect(f.endpoint, "test-browser", { token: browser.token });
    assert.equal(f.broker.status("support").browsers[0].tabs, 0, "tabs must not transfer across connections");
    const closed = once(reconnect.socket, "close"); await f.broker.revoke("support"); await closed;
    assert.equal(f.broker.status("support").browsers.length, 0);
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, "credentials.json"), "utf8")), []);
    const replay = new WebSocket(f.endpoint, { origin: extensionOrigin });
    await once(replay, "open"); const rejected = once(replay, "close");
    replay.send(JSON.stringify({ method: "protocol", params: { protocolVersion: 3 } }));
    replay.send(JSON.stringify({ method: "hello", params: { protocolVersion: 3, profileId: "test-browser", pairing: { nonce: randomNonce(), mode: "token" } } }));
    assert.equal((await rejected)[0], 4006);
  } finally { await f.close(); }
});

test("expired, replaced and reused codes cannot pair; wrong origin and protocol refused", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.broker.pair("support");
    const second = await f.broker.pair("support");
    assert.notEqual(first.code, second.code);
    await assert.rejects(connect(f.endpoint, "old-code", { code: first.code }), /Pairing refused/);
    (f.broker as any).codes.get("support").expiresAt = Date.now() - 1;
    const socket = new WebSocket(f.endpoint, { origin: extensionOrigin });
    await once(socket, "open");
    const exchange = await ecdhKeyPair(); const nonce = randomNonce();
    const challenge = once(socket, "message");
    socket.send(JSON.stringify({ method: "protocol", params: { protocolVersion: 3 } }));
    socket.send(JSON.stringify({ method: "hello", params: { protocolVersion: 3, profileId: "browser", pairing: { nonce, mode: "code", ecdh: exchange.publicKey } } }));
    const value = JSON.parse((await challenge)[0].toString());
    const key = await pairingSessionKey(await pairingCodeMaterial(normalizePairingCode(second.code)!), (await exchange.secret(value.params.ecdh))!, { endpoint: remoteEndpoint, port: 443, extensionNonce: nonce, relayNonce: value.params.nonce, extensionKey: exchange.publicKey, relayKey: value.params.ecdh });
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ method: "auth.code", params: { proof: await sessionProof(key, "extension") } }));
    assert.equal((await closed)[0], 4006);
    assert.equal(f.broker.status("support").browsers.length, 0);
    const origin = await f.server.inject({ method: "GET", url: "/api/browser/connect", headers: { origin: "https://evil.example", connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    assert.equal(origin.statusCode, 403);
    const wrong = new WebSocket(f.endpoint, { origin: extensionOrigin }); await once(wrong, "open");
    const refused = once(wrong, "close"); wrong.send(JSON.stringify({ method: "hello", params: { protocolVersion: 99 } }));
    assert.equal((await refused)[0], 4006);
  } finally { await f.close(); }
});
