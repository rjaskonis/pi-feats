import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { Result } from "../util/result";
import { err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { performSetup } from "../setup";

const SetupArgs = Type.Object({});

export const setupTool = defineBrowserTool({
  name: "browser_setup",
  label: "Browser Setup",
  description:
    "Initialize browser control for the active Pi Profile. Creates or reuses its Steel Session and opens an agent tab. " +
    "Call when browser tools are not connected. Idempotent.",
  promptSnippet: "Initialize browser connection",
  promptGuidelines: [
    "Call browser_setup when a browser tool reports that the Steel browser is not connected.",
    "This tool is idempotent — calling it when already connected is harmless.",
    "After browser_setup succeeds, retry the browser tool that failed.",
  ],
  parameters: SetupArgs,
  concurrency: "parallel",
  ensureAlive: false,
  renderCall: () => new Text("🔧 Initializing browser...", 0, 0),
  async handler(_args, { client, extensionCtx }): Promise<Result<ToolOk, ToolErr>> {
    const result = await performSetup(client, extensionCtx);
    if (result.success) {
      return ok({ text: result.data });
    }
    return err({ kind: "internal", message: result.error });
  },
});
