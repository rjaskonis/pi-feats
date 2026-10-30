import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BrowserClient } from "./client";
import type { BrowserConnection, SetupOptions } from "./connection";

export type ViewerUrlProvider = () => string | undefined;

export function registerSetupCommand(
  pi: ExtensionAPI,
  connection: BrowserConnection,
): void {
  pi.registerCommand("browser-setup", {
    description: "Connect to Steel (default) or an explicit CDP endpoint: /browser-setup [steel|URL]",
    handler: async (args, ctx) => {
      const value = args.trim();
      const options: SetupOptions = !value ? {} : value === "steel" ? { provider: "steel" } : { endpoint: value };
      const result = await connection.setup(options);
      ctx.ui.notify(result.success ? result.data : result.error, result.success ? "info" : "error");
    },
  });
}

export type SetupResult = { success: true; data: string } | { success: false; error: string };

export async function performSetup(
  client: BrowserClient,
  _ctx?: ExtensionContext,
  viewerUrl?: ViewerUrlProvider,
  label = "Steel",
): Promise<SetupResult> {
  const wasConnected = client.status().alive;
  const started = await client.start();
  if (!started.success) return { success: false, error: `${label} browser connection failed: ${started.error.message}` };

  if (!client.current() || !client.canControl(client.current()!.targetId)) {
    const tab = await client.newTab("about:blank");
    if (!tab.success) return { success: false, error: `${label} browser connected but could not open an agent tab: ${tab.error.message}` };
  }

  const info = await client.pageInfo();
  const page = info.success && !("dialog" in info.data) ? info.data.url : "about:blank";
  const viewer = viewerUrl?.();
  return {
    success: true,
    data: [
      `${label} browser ${wasConnected ? "already connected" : "connected"}.`,
      `Current page: ${page}`,
      ...(viewer ? [`Live viewer: ${viewer}`] : []),
    ].join("\n"),
  };
}
