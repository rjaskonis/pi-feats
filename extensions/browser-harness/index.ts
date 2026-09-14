import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBrowserClient, type BrowserClient } from "./client";
import { getBrowserSystemPrompt } from "./prompt";
import { registerSetupCommand } from "./setup";
import { registerAllTools } from "./registry";
import { cleanupTempDirs } from "./util/truncate";
import { createSteelTransport } from "./cdp/steel-transport";
import { createSteelRuntime, type SteelRuntime } from "./steel";

/** Browser harness backed by the Steel SessionContext of the active Pi Profile. */
export default function steelBrowserHarnessExtension(pi: ExtensionAPI): void {
  let client: BrowserClient | undefined;
  let steel: SteelRuntime | undefined;

  pi.registerCommand("browser-status", {
    description: "Show the Steel browser status for the active Pi Profile",
    handler: async (_args, ctx) => {
      const status = client?.status();
      const steelStatus = steel?.status();
      ctx.ui.notify([
        `Browser: ${status?.alive ? "connected" : "not connected"}`,
        `Pi Profile: ${process.env["PI_ACTIVE_PROFILE"] ?? "default"}`,
        `Persisted Steel context: ${steelStatus?.hasPersistedContext ? "available" : "not created"}`,
        `Steel Session: ${steelStatus?.sessionId ?? "none"}`,
      ].join("\n"), "info");
    },
  });

  pi.registerCommand("browser-release", {
    description: "Disconnect and release the active Steel browser session",
    handler: async (_args, ctx) => {
      if (client) await client.stop();
      await steel?.release();
      ctx.ui.notify("Steel browser session released.", "info");
    },
  });

  pi.on("session_start", async () => {
    steel = createSteelRuntime();
    client = createBrowserClient({
      namespace: `steel-${process.env["PI_ACTIVE_PROFILE"] ?? "default"}`,
      transport: createSteelTransport(() => steel!.endpoint()),
      // The transport resolves the actual session CDP endpoint lazily.
      remote: { cdpUrl: "steel://active-profile", browserId: "steel" },
    });
    registerAllTools(pi, client);
    registerSetupCommand(pi, client);
  });

  pi.on("session_shutdown", async () => {
    if (client) {
      try {
        await client.closeOwnedTabs();
        await client.stop();
      } catch {}
    }
    await steel?.release();
    await cleanupTempDirs();
    client = undefined;
    steel = undefined;
  });

  pi.on("before_agent_start", async (event) => {
    if (!client?.status().alive) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n## Steel Browser Control\nBrowser tools (browser_*) are available. Use browser_setup when browser interaction is needed; it creates a Steel Session through the Steel API and restores the active Pi Profile's persisted browser context.`, 
      };
    }
    return { systemPrompt: event.systemPrompt + getBrowserSystemPrompt() };
  });
}
