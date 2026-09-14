import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BrowserClient } from "./client";

export function registerSetupCommand(pi: ExtensionAPI, client: BrowserClient): void {
  pi.registerCommand("browser-setup", {
    description: "Start a Steel API session for the active Pi Profile",
    handler: async (_args, ctx) => {
      const result = await performSetup(client, ctx);
      ctx.ui.notify(result.success ? result.data : result.error, result.success ? "info" : "error");
    },
  });
}

export type SetupResult = { success: true; data: string } | { success: false; error: string };

export async function performSetup(client: BrowserClient, _ctx?: ExtensionContext): Promise<SetupResult> {
  const started = await client.start();
  if (!started.success) return { success: false, error: `Steel browser connection failed: ${started.error.message}` };

  const tab = await client.newTab("about:blank");
  if (!tab.success) return { success: false, error: `Steel browser connected but could not open an agent tab: ${tab.error.message}` };

  const info = await client.pageInfo();
  const page = info.success && !("dialog" in info.data) ? info.data.url : "about:blank";
  return { success: true, data: `Steel browser connected.\nCurrent page: ${page}` };
}
