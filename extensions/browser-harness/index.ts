import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBrowserConnection, type BrowserConnection } from "./connection";
import { getBrowserSystemPrompt } from "./prompt";
import { registerSetupCommand } from "./setup";
import { registerAllTools } from "./registry";
import { cleanupTempDirs } from "./util/truncate";

/** Steel by default, with explicit session-scoped external CDP selection. */
export default function browserHarnessExtension(pi: ExtensionAPI): void {
  let connection: BrowserConnection | undefined;

  pi.registerCommand("browser-status", {
    description: "Show the selected browser connection and its status",
    handler: async (_args, ctx) => {
      ctx.ui.notify([
        `Connection: ${connection?.label() ?? "Steel (default)"}`,
        `Browser: ${connection?.client().status().alive ? "connected" : "not connected"}`,
        `Pi Profile: ${process.env["PI_ACTIVE_PROFILE"] ?? "default"}`,
        ...(connection?.viewerUrl() ? [`Live viewer: ${connection.viewerUrl()}`] : []),
      ].join("\n"), "info");
    },
  });
  pi.registerCommand("browser-viewer", {
    description: "Show the Steel live viewer, if available for the selected connection",
    handler: async (_args, ctx) => {
      const viewer = connection?.viewerUrl();
      ctx.ui.notify(viewer ? `Open the shared Steel browser viewer:\n${viewer}` : "No live viewer is available for the selected connection.", viewer ? "info" : "error");
    },
  });
  pi.registerCommand("browser-release", {
    description: "Release Steel or disconnect external CDP without closing the user's browser or existing tabs",
    handler: async (_args, ctx) => {
      await connection?.release();
      ctx.ui.notify("Browser connection released. The selected provider is retained for reconnection.", "info");
    },
  });
  pi.on("session_start", async () => {
    connection = createBrowserConnection();
    registerAllTools(pi, connection);
    registerSetupCommand(pi, connection);
  });
  pi.on("session_shutdown", async () => {
    try { await connection?.release(); }
    finally { connection = undefined; await cleanupTempDirs(); }
  });
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: event.systemPrompt + getBrowserSystemPrompt(connection?.label() ?? "Steel (default)"),
  }));
}
