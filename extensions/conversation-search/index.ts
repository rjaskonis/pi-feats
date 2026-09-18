import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { searchConversationEntries, textBlocks, type ConversationCandidate } from "../lib/conversation-search.ts";

const agentDirectory = () => process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
const sessionDirectory = () => process.env.PI_ACTIVE_PROFILE && process.env.PI_ACTIVE_PROFILE !== "default" ? join(agentDirectory(), "sessions") : undefined;

export default function registerConversationSearch(pi: ExtensionAPI): void {
  let currentSessionId: string | undefined;
  pi.on("session_start", async (_event, ctx) => { currentSessionId = ctx.sessionManager.getSessionId(); });
  pi.registerTool({
    name: "conversation_search",
    label: "Search Previous Conversations",
    description: "Search previous conversations in the active profile by topic, wording, session name, or session ID. Use this when the user asks what was discussed in another conversation or a previous session; the user does not need to know a session ID. Searches only this profile and never other profiles.",
    promptSnippet: "Search previous conversations in the active profile by topic, name, or session ID.",
    promptGuidelines: ["Use conversation_search when the user asks about information discussed in another conversation, a prior session, or asks you to search previous chats. Do not ask for a session ID before searching by topic. When the user supplies a session ID, pass it as sessionId so the exact session is prioritized."],
    parameters: Type.Object({ query: Type.String({ minLength: 2, description: "Topic, phrase, session name, or session ID to search for in prior conversations." }), sessionId: Type.Optional(Type.String({ minLength: 2, description: "Exact or partial session ID, when the user supplied one." })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum number of matching conversations to return." })) }),
    async execute(_id, params) {
      const directory = sessionDirectory();
      const sessions = (await SessionManager.listAll(directory)).filter((session) => session.id !== currentSessionId).sort((left, right) => right.modified.getTime() - left.modified.getTime()).slice(0, 500);
      const candidates: ConversationCandidate[] = [];
      for (const session of sessions) {
        try {
          const entries = SessionManager.open(session.path, directory, process.cwd()).getBranch().flatMap((entry: any) => {
            if (entry.type !== "message") return [];
            const role = entry.message?.role;
            if (role !== "user" && role !== "assistant") return [];
            const text = textBlocks(entry.message?.content);
            return text.trim() ? [{ role, text, timestamp: entry.timestamp }] : [];
          });
          if (entries.length) candidates.push({ id: session.id, name: session.name, updatedAt: session.modified, entries });
        } catch { /* A malformed or concurrently removed session must not block search. */ }
      }
      const search = params.sessionId ?? params.query;
      const results = searchConversationEntries(search, candidates, params.limit ?? 5);
      const text = results.length ? results.map((result, index) => [`${index + 1}. ${result.name?.trim() || "Untitled conversation"} (${result.id}) — updated ${result.updatedAt.toISOString()}`, ...result.excerpts.map((excerpt) => `   [${excerpt.role}] ${excerpt.text}`)].join("\n")).join("\n\n") : "No previous conversation in this profile matched that topic.";
      return { content: [{ type: "text" as const, text }], details: { query: search, searchedSessions: sessions.length, matches: results.map((result) => ({ id: result.id, name: result.name ?? null, updatedAt: result.updatedAt.toISOString(), score: result.score })) } };
    },
  });
}
