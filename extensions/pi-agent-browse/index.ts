import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { executeBrowserAction } from "./client.ts";
import type { BrowserAction } from "./actions.ts";

export default function (pi: ExtensionAPI) {
  const directory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const environment = { ...process.env };
  pi.registerTool({
    name: "pi_browser", label: "Pi Agent Browse",
    description: "Control Chrome through paired Pi Agent Browse, in background tabs without CDP prompts. Preferred for a generic personal Chrome request when paired; honor explicit CDP or Steel selections. Use status, pair (Console mode only; generates a temporary code and download link for this session's profile), navigate (omit tabId or use 0 to create an inactive tab), snapshot, click/fill with snapshot refs, press, scroll, evaluate, screenshot (visual verification only), tabs, close. Never enter credentials, submit sensitive transactions, or bypass authentication without explicit user participation. Only tabs created by this profile in this connection are accessible. Do not send a profile or endpoint: this capability is profile-bound. For connection requests, check status and follow its connectionState/setup hints and the pi-agent-browse skill. Pair local Chrome once with the shared relay from the default local terminal. Once Chrome is connected, any local profile can use it without additional setup. In Console/server mode, check status first. Generate a code with pair when the user asks to connect an unpaired browser or add another one. Use Local Console only when Chrome runs on the API host; use Remote server otherwise. Do not start a standalone relay in Console mode. If already paired but offline, help reconnect before generating another code. Use the returned download link, address and expiry. Verify live status after pairing. A saved disconnected browser is not a live connection. Snapshot before interacting; keep evaluate outputs bounded. Keep the browser in the background: never activate tabs, raise windows, call window.focus(), or switch to another browser tool just to make a background page load or respond. If background operation fails, report it rather than stealing focus.",
    parameters: Type.Object({
      action: Type.Union(["status", "pair", "tabs", "navigate", "snapshot", "click", "fill", "press", "scroll", "evaluate", "screenshot", "close"].map(value => Type.Literal(value))),
      browser: Type.Optional(Type.String()), tabId: Type.Optional(Type.Number()), url: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), text: Type.Optional(Type.String()), expression: Type.Optional(Type.String()), key: Type.Optional(Type.String()), deltaY: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, signal) {
      try {
        const result = await executeBrowserAction(directory, params as BrowserAction, signal, environment);
        if (params.action === "screenshot" && result?.data) return { content: [{ type: "image", data: result.data, mimeType: "image/png" }], details: {} };
        return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: {} };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : "Browser connection unavailable" }], details: {}, isError: true };
      }
    },
  });
}
