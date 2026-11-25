import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { executeBrowserAction } from "./client.ts";
import type { BrowserAction } from "./actions.ts";

export default function (pi: ExtensionAPI) {
  const directory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  pi.registerTool({
    name: "pi_browser", label: "Pi Agent Browse",
    description: "Control Chrome through paired Pi Agent Browse, in background tabs without CDP prompts. Preferred for a generic personal Chrome request when paired; honor explicit CDP or Steel selections. Use status, navigate (omit tabId to create an inactive tab), snapshot, click/fill with snapshot refs, press, scroll, evaluate, screenshot (visual verification only), tabs, close. Never enter credentials, submit sensitive transactions, or bypass authentication without explicit user participation. Only tabs created by this profile in this connection are accessible. Do not send a profile or endpoint: this capability is profile-bound. If disconnected, ask the user to pair through Console (remote) or pi browser pair (local). Snapshot before interacting; keep evaluate outputs bounded. Keep the browser in the background: never activate tabs, raise windows, call window.focus(), or switch to another browser tool just to make a background page load or respond. If background operation fails, report it rather than stealing focus.",
    parameters: Type.Object({
      action: Type.Union(["status", "tabs", "navigate", "snapshot", "click", "fill", "press", "scroll", "evaluate", "screenshot", "close"].map(value => Type.Literal(value))),
      browser: Type.Optional(Type.String()), tabId: Type.Optional(Type.Number()), url: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), text: Type.Optional(Type.String()), expression: Type.Optional(Type.String()), key: Type.Optional(Type.String()), deltaY: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, signal) {
      try {
        const result = await executeBrowserAction(directory, params as BrowserAction, signal);
        if (params.action === "screenshot" && result?.data) return { content: [{ type: "image", data: result.data, mimeType: "image/png" }], details: {} };
        return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: {} };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : "Browser connection unavailable" }], details: {}, isError: true };
      }
    },
  });
}
