import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reexecCliWithRegularTui } from "./lib/cli-tui-mode.ts";

/** Keep finite pi-feats CLI commands out of Pi's alternate-screen TUI. */
export default async function (_pi: ExtensionAPI) {
  await reexecCliWithRegularTui();
}
