import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { Result } from "../util/result";
import { err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import type { BrowserConnection } from "../connection";

const SetupArgs = Type.Object({
  provider: Type.Optional(Type.Union([Type.Literal("steel"), Type.Literal("cdp")], { description: "Select Steel explicitly or external CDP. Omit to keep the selected connection (initially Steel)." })),
  endpoint: Type.Optional(Type.String({ description: "Explicit HTTP(S) discovery base URL or browser WebSocket CDP URL. Implies provider:'cdp'." })),
});

export const createSetupTool = (connection?: BrowserConnection) => defineBrowserTool({
  name: "browser_setup",
  label: "Browser Setup",
  description:
    "Initialize browser control. Defaults to Steel in a new session. Supply endpoint to select an existing CDP browser, or provider:'steel' to return to Steel. " +
    "Without arguments, reconnects the selected browser. Selection persists for this session only. Failed explicit connections never fall back to Steel. Idempotent.",
  promptSnippet: "Initialize browser connection",
  promptGuidelines: [
    "An already-open Chrome/local-browser request selects external CDP even without an endpoint. Load the browser-harness skill and read only that browser's DevToolsActivePort metadata to resolve its WebSocket before asking the user for a URL. Do not launch browsers, scan unrelated profiles, or probe remote environments.",
    "Call browser_setup with the supplied or resolved endpoint before other browser tools. Steel is the default only when no external browser is requested.",
    "Chrome UI-enabled debugging can return HTTP 404 for /json/version. Resolve DevToolsActivePort and use its WebSocket instead of asking for the same port again or suggesting a restart. Only the user may approve the connection dialog.",
    "An empty setup preserves the current selection; use provider:'steel' to switch back explicitly.",
    "Never silently fall back to Steel after an explicit CDP connection fails.",
    "This tool is idempotent — calling it when already connected is harmless.",
    "After browser_setup succeeds, retry the browser tool that failed.",
  ],
  parameters: SetupArgs,
  concurrency: "parallel",
  ensureAlive: false,
  renderCall: () => new Text("🔧 Initializing browser...", 0, 0),
  async handler(args): Promise<Result<ToolOk, ToolErr>> {
    if (!connection) return err({ kind: "internal", message: "Browser connection manager is unavailable." });
    const result = await connection.setup(args);
    if (result.success) {
      return ok({ text: result.data });
    }
    return err({ kind: "internal", message: result.error });
  },
});

export const setupTool = createSetupTool();
