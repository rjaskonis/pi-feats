import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type HistoryMessage = { role: "user" | "assistant"; content: string };
const historyEnvironmentKey = "PI_STATELESS_APPLICATION_HISTORY";

function historyFromEnvironment(): HistoryMessage[] {
  const encoded = process.env[historyEnvironmentKey];
  if (!encoded) return [];
  delete process.env[historyEnvironmentKey];
  const history = JSON.parse(encoded) as unknown;
  if (!Array.isArray(history) || history.some((item) => !item || typeof item !== "object" || !["user", "assistant"].includes((item as HistoryMessage).role) || typeof (item as HistoryMessage).content !== "string")) throw new Error("Invalid stateless Application history.");
  return history as HistoryMessage[];
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    for (const item of historyFromEnvironment()) {
      const timestamp = Date.now();
      if (item.role === "user") ctx.sessionManager.appendMessage({ role: "user", content: item.content, timestamp });
      else ctx.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: item.content }], api: "openai-completions", provider: "external-history", model: "external-history", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp } as any);
    }
  });
}
