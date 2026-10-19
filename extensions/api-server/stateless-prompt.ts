export type StatelessHistoryMessage = { role: "user" | "assistant"; content: string };

export function buildStatelessPrompt(history: StatelessHistoryMessage[], message: string): string {
  if (!history.length) return message;
  const transcript = history.map((item) => `${item.role === "user" ? "User" : "Assistant"}: ${item.content}`).join("\n");
  return `## Conversation history\n${transcript}\n\n## Current user message\n${message}`;
}
