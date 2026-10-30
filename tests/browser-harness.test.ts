import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import type { BrowserConnection, ConnectionSelection, ConnectionResource } from "../extensions/browser-harness/connection.ts";

const jiti = createJiti(import.meta.url);
const { createBrowserConnection } = await jiti.import<typeof import("../extensions/browser-harness/connection.ts")>("../extensions/browser-harness/connection.ts");
const { resolveEndpoint, endpointLabel } = await jiti.import<typeof import("../extensions/browser-harness/cdp/endpoint.ts")>("../extensions/browser-harness/cdp/endpoint.ts");
const { createBrowserClient } = await jiti.import<typeof import("../extensions/browser-harness/client.ts")>("../extensions/browser-harness/client.ts");
const { createWebSocketTransport } = await jiti.import<typeof import("../extensions/browser-harness/cdp/websocket-transport.ts")>("../extensions/browser-harness/cdp/websocket-transport.ts");
const { registerAllTools } = await jiti.import<typeof import("../extensions/browser-harness/registry.ts")>("../extensions/browser-harness/registry.ts");
const { allocateRef } = await jiti.import<typeof import("../extensions/browser-harness/util/refs.ts")>("../extensions/browser-harness/util/refs.ts");

async function mockBrowser() {
  const calls: string[] = [];
  const apiCalls: string[] = [];
  const tabs = new Map([["11111111111111111111111111111111", { url: "https://existing.example/", title: "Existing user tab" }]]);
  let serial = 1;
  let endpoint = "";
  let invalid = false;
  const http = createServer((req, res) => {
    if (req.url?.startsWith("/v1/")) {
      apiCalls.push(`${req.method} ${req.url}`);
      const origin = endpoint.replace("ws:", "http:").split("/devtools/")[0];
      const data = req.url === "/v1/sessions"
        ? req.method === "POST" ? { id: "mock-steel", websocketUrl: endpoint, debugUrl: `${origin}/viewer`, debuggerUrl: `${origin}/debugger`, sessionViewerUrl: `${origin}/session-viewer` } : { sessions: [] }
        : req.url.endsWith("/context") ? { cookies: [{ name: "mock-cookie" }] } : {};
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(data));
      return;
    }
    if (req.url === "/bad/json/version") { res.end("{}"); return; }
    if (!req.url?.startsWith("/json/version")) { res.writeHead(404); res.end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(invalid ? {} : { webSocketDebuggerUrl: endpoint }));
  });
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => ws.on("message", (raw) => {
    const { id, method, params } = JSON.parse(raw.toString());
    calls.push(method);
    let result: unknown = {};
    switch (method) {
      case "Target.getTargets": result = { targetInfos: [...tabs].map(([targetId, tab]) => ({ targetId, type: "page", ...tab })) }; break;
      case "Target.getTargetInfo": result = { targetInfo: { targetId: params.targetId, type: "page", ...tabs.get(params.targetId) } }; break;
      case "Target.createTarget": {
        const targetId = String(++serial).padStart(32, "0");
        tabs.set(targetId, { url: "about:blank", title: "Agent tab" });
        result = { targetId }; break;
      }
      case "Target.attachToTarget": result = { sessionId: `session-${params.targetId}-${++serial}` }; break;
      case "Browser.getWindowForTarget": result = { windowId: 1 }; break;
      case "Target.closeTarget": tabs.delete(params.targetId); result = { success: true }; break;
      case "Runtime.evaluate": result = { result: { type: "string", value: JSON.stringify({ url: "about:blank", title: "Agent", w: 800, h: 600, sx: 0, sy: 0, pw: 800, ph: 600 }) } }; break;
    }
    ws.send(JSON.stringify({ id, result }));
  }));
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  endpoint = `${base.replace("http:", "ws:")}/devtools/browser/test`;
  return {
    base, endpoint, tabs, calls, apiCalls,
    setInvalid: (value: boolean) => { invalid = value; },
    emit: (event: object) => { for (const ws of wss.clients) ws.send(JSON.stringify(event)); },
    disconnect: () => { for (const ws of wss.clients) ws.terminate(); },
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

test("endpoint discovery supports HTTP and direct WebSocket, with safe errors and labels", async () => {
  const browser = await mockBrowser();
  try {
    assert.deepEqual(await resolveEndpoint(browser.base), { success: true, data: browser.endpoint });
    assert.deepEqual(await resolveEndpoint(browser.endpoint), { success: true, data: browser.endpoint });
    assert.equal((await resolveEndpoint(`${browser.base}/bad`)).success, false);
    assert.equal((await resolveEndpoint("file:///secret")).success, false);
    assert.equal((await resolveEndpoint("not-a-url")).success, false);
    assert.equal(endpointLabel("wss://user:password@localhost:9222/devtools/browser/private?token=secret"), "wss://localhost:9222");
    browser.setInvalid(true);
    assert.equal((await resolveEndpoint(browser.base)).success, false);
  } finally { await browser.close(); }
});

test("CDP event consumers survive initial connection and terminate cleanly on disconnect", async () => {
  const browser = await mockBrowser();
  const transport = createWebSocketTransport(() => resolveEndpoint(browser.base));
  try {
    const events = transport.events()[Symbol.asyncIterator]();
    const waiting = events.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await transport.connect(browser.endpoint)).success, true);
    browser.emit({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "test-session" });
    const event = await Promise.race([waiting, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Event consumer timed out")), 1000); timer.unref(); })]);
    assert.equal(event.done, false);
    assert.equal(event.value.method, "Page.loadEventFired");
    const ending = events.next();
    await transport.close();
    assert.equal((await ending).done, true);
    assert.equal((await transport.connect(browser.endpoint)).success, true);
    assert.equal((await transport.request("Target.getTargets", {})).success, true);
  } finally { await transport.close(); await browser.close(); }
});

test("external CDP setup, authorized existing tabs, reconnect, and release preserve the user's browser", async () => {
  const browser = await mockBrowser();
  const connection: BrowserConnection = createBrowserConnection();
  try {
    assert.deepEqual(connection.selection(), { provider: "steel" });
    assert.equal((await connection.setup({ endpoint: browser.base })).success, true);
    assert.equal(connection.selection().provider, "cdp");
    assert.equal(connection.viewerUrl(), undefined);
    const client = connection.client();
    const userTab = "11111111111111111111111111111111";
    assert.equal(client.owns(userTab), false);
    assert.equal(client.canControl(userTab), false);
    assert.equal((await client.authorizeTab(userTab)).success, true);
    assert.equal((await client.switchTab(userTab)).success, true);
    assert.equal(client.canControl(userTab), true);
    assert.equal(client.owns(userTab), false);
    assert.equal((await client.closeTab(userTab)).success, false);
    assert.equal((await connection.setup()).success, true);
    assert.equal(client.current()?.targetId, userTab);
    // A reconnect must not claim every tab sharing the agent's window.
    client.session().setRefMap(new Map([["e-old", 99]]), new Map());
    await client.stop();
    assert.equal(client.session().resolveRef("e-old"), undefined);
    assert.equal((await connection.setup()).success, true);
    assert.equal(client.owns(userTab), false);
    await connection.release();
    assert.equal(browser.tabs.has(userTab), true);
    assert.equal(browser.tabs.size, 1);
    assert.equal(connection.client().canControl(userTab), false);
    assert.equal(connection.selection().provider, "cdp");
    assert.equal(browser.calls.includes("Browser.close"), false);
  } finally { await connection.release(); await browser.close(); }
});

test("failed explicit CDP stays selected, empty setup retries it, and Steel requires explicit selection", async () => {
  const browser = await mockBrowser();
  const created: ConnectionSelection[] = [];
  let steelReleases = 0;
  const factory = (selection: ConnectionSelection): ConnectionResource => {
    created.push(selection);
    const url = selection.provider === "cdp" ? selection.endpoint : browser.base;
    const client = createBrowserClient({ namespace: String(created.length), transport: createWebSocketTransport(() => resolveEndpoint(url)), remote: { cdpUrl: url, browserId: "mock" }, allowExistingTabs: selection.provider === "cdp" });
    return { client, viewerUrl: () => selection.provider === "steel" ? "https://viewer.example/" : undefined, release: async () => { if (selection.provider === "steel") steelReleases++; } };
  };
  const connection = createBrowserConnection(factory);
  try {
    assert.equal((await connection.setup()).success, true);
    assert.equal(connection.viewerUrl(), "https://viewer.example/");
    assert.equal((await connection.setup({ endpoint: `${browser.base}/bad` })).success, false);
    assert.equal(connection.selection().provider, "cdp");
    assert.equal((await connection.setup()).success, false);
    assert.equal(created.length, 2);
    assert.equal(steelReleases, 1);
    assert.equal((await connection.setup({ provider: "steel", endpoint: browser.base })).success, false);
    assert.equal((await connection.setup({ provider: "steel" })).success, true);
    assert.equal(connection.selection().provider, "steel");
    assert.equal((await connection.client().authorizeTab("11111111111111111111111111111111")).success, false);
    assert.equal(created.length, 3);
  } finally { await connection.release(); await browser.close(); }
});

test("switching waits for active tools and queued tools receive only the new client", async () => {
  const browser = await mockBrowser();
  const connection = createBrowserConnection();
  let finish!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  try {
    const old = connection.client();
    const running = connection.withClient(async (client: unknown) => {
      assert.equal(client, old);
      entered();
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    await ready;
    const switching = connection.setup({ endpoint: browser.base });
    const queued = connection.withClient(async (client: unknown) => { assert.notEqual(client, old); });
    assert.equal(connection.client(), old);
    finish();
    await running;
    assert.equal((await switching).success, true);
    await queued;
  } finally { await connection.release(); await browser.close(); }
});

test("default Steel setup still creates, exposes a viewer, persists context, and releases through its API", async () => {
  const browser = await mockBrowser();
  const dir = await mkdtemp(join(tmpdir(), "pi-browser-steel-"));
  const previous = { STEEL_API_URL: process.env.STEEL_API_URL, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.STEEL_API_URL = browser.base;
  process.env.PI_CODING_AGENT_DIR = dir;
  const connection = createBrowserConnection();
  try {
    assert.equal((await connection.setup()).success, true);
    assert.match(connection.viewerUrl()!, /interactive=true/);
    assert.equal((await connection.setup()).success, true);
    assert.equal(browser.apiCalls.filter((call) => call === "POST /v1/sessions").length, 1);
    await connection.release();
    assert.equal(browser.apiCalls.includes("POST /v1/sessions/mock-steel/release"), true);
    const state = JSON.parse(await readFile(join(dir, "steel.json"), "utf8"));
    assert.deepEqual(state.sessionContext, { cookies: [{ name: "mock-cookie" }] });
    assert.equal(state.sessionId, undefined);
  } finally {
    await connection.release();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("registered tools use the active connection and require explicit authorization of existing tabs", async () => {
  const browser = await mockBrowser();
  const connection = createBrowserConnection();
  type Tool = { name: string; execute: (id: string, args: object, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<{ details: { ok: boolean }; content: { type: string; text?: string }[] }> };
  const tools = new Map<string, Tool>();
  const pi = { registerTool: (tool: Tool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
  registerAllTools(pi, connection);
  const call = (name: string, args = {}) => tools.get(name)!.execute("test", args, undefined, undefined, {} as ExtensionContext);
  const userTab = "11111111111111111111111111111111";
  try {
    assert.equal((await call("browser_setup", { endpoint: browser.base })).details.ok, true);
    assert.equal((await call("browser_switch_tab", { targetId: userTab })).details.ok, false);
    assert.equal((await call("browser_switch_tab", { targetId: userTab, authorizeExisting: true })).details.ok, true);
    assert.equal((await call("browser_current_tab")).details.ok, true);
    assert.equal(connection.client().current()?.targetId, userTab);
    assert.equal((await call("browser_close_tab", { targetId: userTab })).details.ok, false);
    assert.equal((await call("browser_list_tabs")).content.some((part) => part.text?.includes("authorized existing")), true);
    const oldClient = connection.client();
    oldClient.session().setRefMap(new Map([["e-old", 99]]), new Map());
    assert.equal((await call("browser_setup", { endpoint: browser.endpoint })).details.ok, true);
    assert.notEqual(connection.client(), oldClient);
    assert.equal(connection.client().session().resolveRef("e-old"), undefined);
    assert.equal((await call("browser_switch_tab", { targetId: userTab })).details.ok, false);
    assert.equal(browser.tabs.has(userTab), true);
  } finally { await connection.release(); await browser.close(); }
});

test("reference allocation cannot collide across snapshots or connections", () => {
  const refs = Array.from({ length: 1000 }, allocateRef);
  assert.equal(new Set(refs).size, refs.length);
  assert.match(refs[0], /^e\d+$/);
});
