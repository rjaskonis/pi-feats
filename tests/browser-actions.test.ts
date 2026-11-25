import test from "node:test";
import assert from "node:assert/strict";
import { browserAction } from "../extensions/pi-agent-browse/actions.ts";
import type { BrowserBroker } from "../extensions/pi-agent-browse/broker.ts";

function fixture(options: { groupId?: number; failGrouping?: boolean } = {}) {
  const connection = { browser: "chrome", tabs: new Set<number>() };
  const calls: { method: string; params: any }[] = [];
  const broker = {
    connection: () => connection,
    async rpc(target: unknown, method: string, params: any) {
      assert.equal(target, connection);
      calls.push({ method, params });
      if (method === "tabs.create") return { tabId: 42 };
      if (method === "debugger.sendCommand") {
        if (params.method === "DOM.resolveNode") return { object: { objectId: "node" } };
        if (params.method === "Runtime.callFunctionOn") return { result: { value: { x: 10, y: 20 } } };
        if (params.method === "Runtime.evaluate") return { result: { value: true } };
      }
      if (method === "tabs.group") {
        if (options.failGrouping) throw new Error("Grouping failed");
        return { groupId: options.groupId ?? 7 };
      }
      return {};
    },
  } as unknown as BrowserBroker;
  return { broker, connection, calls };
}

test("new background tabs are grouped before navigation with a stable profile label", async () => {
  const f = fixture();
  for (let count = 0; count < 2; count++) {
    const result = await browserAction(f.broker, "support", { action: "navigate", url: "https://example.com" });
    assert.deepEqual(result, { browser: "chrome", tabId: 42 });
  }
  const expected = [
    { method: "tabs.create", params: { active: false } },
    { method: "debugger.attach", params: { tabId: 42 } },
    { method: "tabs.group", params: { tabId: 42, sessionId: "Pi: support" } },
    { method: "debugger.sendCommand", params: { tabId: 42, method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } } },
    { method: "debugger.sendCommand", params: { tabId: 42, method: "Page.enable", params: {} } },
    { method: "debugger.sendCommand", params: { tabId: 42, method: "Page.navigate", params: { url: "https://example.com/" } } },
  ];
  assert.deepEqual(f.calls, [...expected, ...expected]);
});

test("extension grouping disabled is respected; existing tabs are not regrouped", async () => {
  const f = fixture({ groupId: -1 });
  await browserAction(f.broker, "default", { action: "navigate", url: "https://example.com" });
  assert.equal(f.calls.find(call => call.method === "tabs.group")?.params.sessionId, "Pi: default");
  f.calls.length = 0;
  await browserAction(f.broker, "default", { action: "navigate", tabId: 42, url: "https://example.org" });
  assert.deepEqual(f.calls.map(call => call.method), ["debugger.sendCommand"]);
});

test("grouping errors are reported instead of silently navigating an ungrouped tab", async () => {
  const f = fixture({ failGrouping: true });
  await assert.rejects(browserAction(f.broker, "support", { action: "navigate", url: "https://example.com" }), /Grouping failed/);
  assert.deepEqual(f.calls.map(call => call.method), ["tabs.create", "debugger.attach", "tabs.group"]);
});

test("normal background actions never request tab activation or foreground window focus", async () => {
  const f = fixture();
  await browserAction(f.broker, "support", { action: "navigate", url: "https://example.com" });
  const focus = f.calls.find(call => call.params.method === "Emulation.setFocusEmulationEnabled");
  assert.deepEqual(focus?.params.params, { enabled: true });
  assert.ok(f.calls.indexOf(focus!) < f.calls.findIndex(call => call.params.method === "Page.navigate"));
  await browserAction(f.broker, "support", { action: "click", tabId: 42, ref: "b1" });
  await browserAction(f.broker, "support", { action: "fill", tabId: 42, ref: "b1", text: "hello" });
  await browserAction(f.broker, "support", { action: "press", tabId: 42, key: "Tab" });
  await browserAction(f.broker, "support", { action: "scroll", tabId: 42, deltaY: 200 });
  await browserAction(f.broker, "support", { action: "screenshot", tabId: 42 });
  for (const call of f.calls) {
    assert.ok(!["tabs.update", "tabs.activate", "windows.update", "tabs.handoff"].includes(call.method));
    assert.notEqual(call.params.active, true);
    assert.notEqual(call.params.focused, true);
    assert.notEqual(call.params.method, "Page.bringToFront");
    const expression = call.params.params?.expression ?? call.params.params?.functionDeclaration ?? "";
    assert.doesNotMatch(expression, /window\.focus\s*\(/);
  }
});
