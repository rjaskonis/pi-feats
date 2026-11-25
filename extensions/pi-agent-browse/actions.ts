import type { BrowserBroker } from "./broker.ts";

export type BrowserAction = { action: string; browser?: string; tabId?: number; url?: string; ref?: string; text?: string; expression?: string; key?: string; deltaY?: number };
const allowed = new Set(["status", "tabs", "navigate", "snapshot", "click", "fill", "press", "scroll", "evaluate", "screenshot", "close"]);

export async function browserAction(broker: Pick<BrowserBroker, "status" | "connection" | "rpc">, profile: string, input: BrowserAction) {
  if (!allowed.has(input.action)) throw new Error("Unsupported browser action");
  if (input.action === "status") return broker.status(profile);
  const connection = broker.connection(profile, input.browser);
  if (input.action === "tabs") return { browser: connection.browser, tabs: [...connection.tabs] };
  const cdp = async (tabId: number, method: string, params: object = {}) => {
    return await broker.rpc(connection, "debugger.sendCommand", { tabId, method, params }) as any;
  };
  const validateUrl = (value: unknown) => {
    if (typeof value !== "string") throw new Error("A URL is required");
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP or HTTPS URL without credentials");
    return url.href;
  };
  let tabId = input.tabId;
  // Some tool adapters supply 0 for an omitted numeric argument. Only navigation may create a new tab.
  if (input.action === "navigate" && (tabId === undefined || tabId === 0)) {
    const url = validateUrl(input.url);
    const tab = await broker.rpc(connection, "tabs.create", { active: false }) as { tabId: number };
    tabId = tab.tabId;
    connection.tabs.add(tabId);
    await broker.rpc(connection, "debugger.attach", { tabId });
    // Creation does not group tabs; let the extension apply its grouping/collapse settings.
    await broker.rpc(connection, "tabs.group", { tabId, sessionId: `Pi: ${profile}` });
    // Make the page behave as focused without activating its tab or raising the OS window.
    await cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
    await cdp(tabId, "Page.enable");
    const result = await cdp(tabId, "Page.navigate", { url });
    if (result.errorText) throw new Error(result.errorText);
    return { browser: connection.browser, tabId };
  }
  if (!Number.isSafeInteger(tabId) || !connection.tabs.has(tabId!)) throw new Error("This tab is not owned by this profile's current browser connection. Open a new tab with navigate.");
  const id = tabId!;
  const evaluate = async (expression: string) => {
    const result = await cdp(id, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: 10_000 });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Page script failed");
    return result.result?.value;
  };
  switch (input.action) {
    case "navigate": {
      const result = await cdp(id, "Page.navigate", { url: validateUrl(input.url) });
      if (result.errorText) throw new Error(result.errorText);
      return { tabId: id };
    }
    case "snapshot": {
      const result = await cdp(id, "Accessibility.getFullAXTree");
      const nodes = result.nodes.filter((node: any) => !node.ignored);
      const bounded = (value: unknown) => typeof value === "string" ? value.slice(0, 2000) : value;
      return { tabId: id, nodes: nodes.slice(0, 800).map((node: any) => ({ nodeId: node.nodeId, parentId: node.parentId, ref: node.backendDOMNodeId ? `b${node.backendDOMNodeId}` : undefined, role: node.role?.value, name: bounded(node.name?.value), value: bounded(node.value?.value), states: node.properties?.filter((property: any) => ["disabled", "checked", "focused", "expanded", "selected"].includes(property.name)).map((property: any) => ({ name: property.name, value: property.value?.value })) })), truncated: nodes.length > 800 };
    }
    case "evaluate":
      if (typeof input.expression !== "string" || input.expression.length > 64_000) throw new Error("Provide a page JavaScript expression (maximum 64000 characters)");
      return evaluate(input.expression);
    case "click":
    case "fill": {
      if (!/^b[1-9][0-9]*$/.test(input.ref ?? "")) throw new Error("Use a ref from snapshot");
      const node = await cdp(id, "DOM.resolveNode", { backendNodeId: Number(input.ref!.slice(1)) });
      const objectId = node.object?.objectId;
      if (!objectId) throw new Error("Stale ref; take another snapshot");
      try {
        const result = await cdp(id, "Runtime.callFunctionOn", {
          objectId, returnByValue: true,
          functionDeclaration: input.action === "click" ? "function(){ this.scrollIntoView({block:'center',inline:'center'}); const r=this.getBoundingClientRect(); if(!r.width || !r.height || this.disabled) throw new Error('Element is not clickable'); return {x:r.x+r.width/2,y:r.y+r.height/2}; }" : "function(value){ if(this.disabled || this.readOnly) throw new Error('Field is not editable'); this.focus(); if(this.isContentEditable) this.textContent=value; else { const p=this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter=Object.getOwnPropertyDescriptor(p,'value').set; setter.call(this,value); } this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return this.value ?? this.textContent; }",
          arguments: input.action === "fill" ? [{ value: input.text ?? "" }] : [],
        });
        if (result.exceptionDetails) throw new Error("Element action failed; take another snapshot and check whether the field is editable");
        if (input.action === "click") {
          const { x, y } = result.result.value;
          await cdp(id, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
          await cdp(id, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
          return { clicked: input.ref };
        }
        return result.result?.value;
      } finally { await cdp(id, "Runtime.releaseObject", { objectId }).catch(() => {}); }
    }
    case "press": {
      const codes: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
      if (!input.key || !(input.key in codes)) throw new Error("Supported keys: Enter, Tab, Escape, Backspace, Delete, ArrowLeft, ArrowUp, ArrowRight, ArrowDown");
      await cdp(id, "Input.dispatchKeyEvent", { type: "keyDown", key: input.key, windowsVirtualKeyCode: codes[input.key] });
      await cdp(id, "Input.dispatchKeyEvent", { type: "keyUp", key: input.key, windowsVirtualKeyCode: codes[input.key] });
      return { pressed: input.key };
    }
    case "scroll":
      if (!Number.isFinite(input.deltaY) || Math.abs(input.deltaY!) > 10_000) throw new Error("Provide deltaY between -10000 and 10000");
      return evaluate(`window.scrollBy(0,${input.deltaY}); ({x:window.scrollX,y:window.scrollY})`);
    case "screenshot": return cdp(id, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    case "close":
      await broker.rpc(connection, "tabs.remove", { tabId: id });
      connection.tabs.delete(id);
      return { closed: id };
  }
}
