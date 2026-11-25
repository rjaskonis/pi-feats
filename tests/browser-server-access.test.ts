import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverBrowserEnvironment, startServerBrowserAccess } from "../extensions/pi-agent-browse/server-access.ts";
import { executeBrowserAction } from "../extensions/pi-agent-browse/client.ts";
import { browserStatusGuidance } from "../extensions/pi-agent-browse/guidance.ts";

test("server shell selects the current profile privately and never falls back after shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-browser-pty-"));
  const tokens = new Map(["default", "support"].map(profile => [profile, randomBytes(32).toString("base64url")]));
  let close: (() => Promise<void>) | undefined;
  try {
    assert.deepEqual(await serverBrowserEnvironment(root, "default", {}), {});
    const marker = { PI_BROWSER_SERVER_MODE: "1" };
    assert.deepEqual(await serverBrowserEnvironment(root, "default", { PI_API_PROXY_TARGET: "http://127.0.0.1:8767" }), marker);
    close = await startServerBrowserAccess(root, 8767, async profile => {
      const token = tokens.get(profile);
      if (!token) throw new Error("Unknown profile");
      return token;
    });
    for (const profile of ["default", "support"]) {
      assert.deepEqual(await serverBrowserEnvironment(root, profile, {}), { ...marker, PI_BROWSER_ENDPOINT: "http://127.0.0.1:8767", PI_BROWSER_TOKEN: tokens.get(profile) });
    }
    assert.deepEqual(await serverBrowserEnvironment(root, "unknown", {}), marker);
    assert.deepEqual(await serverBrowserEnvironment(root, "default", { ...marker, PI_PROFILE_REEXEC: "1" }), marker);
    assert.deepEqual(await serverBrowserEnvironment(root, "support", { PI_BROWSER_ENDPOINT: "http://127.0.0.1:8767", PI_BROWSER_TOKEN: tokens.get("support") }), {});
    const path = join(root, "browser", "launcher.json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const { socketPath } = JSON.parse(await readFile(path, "utf8"));
    const denied = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(socketPath);
      let response = "";
      socket.on("connect", () => socket.write(`${tokens.get("support")} default\n`));
      socket.on("data", data => { response += data; });
      socket.on("end", () => resolve(response.trim()));
      socket.on("error", reject);
    });
    assert.equal(denied, "{}", "a profile token cannot mint another profile's token");
    await close(); close = undefined;
    const offline = await serverBrowserEnvironment(root, "default", {});
    assert.deepEqual(offline, marker);
    const status = await executeBrowserAction(root, { action: "status" }, undefined, offline);
    assert.equal(status.connectionState, "server_unavailable");
    assert.equal(status.setup.mode, "console");
    assert.equal(status.setup.nextStep, "check_server_browser_service");
    await assert.rejects(executeBrowserAction(root, { action: "tabs" }, undefined, offline), /server browser service is unavailable/);
    tokens.set("default", randomBytes(32).toString("base64url"));
    close = await startServerBrowserAccess(root, 8767, async profile => tokens.get(profile)!);
    assert.equal((await serverBrowserEnvironment(root, "default", {})).PI_BROWSER_TOKEN, tokens.get("default"));
  } finally { await close?.(); await rm(root, { recursive: true, force: true }); }
});

test("an offline paired remote browser is not a request to generate another code", () => {
  const status = browserStatusGuidance({ available: true, browsers: [{ connected: false }] }, "console");
  assert.equal(status.connectionState, "paired_disconnected");
  assert.equal(status.setup.nextStep, "check_chrome_connection");
});
