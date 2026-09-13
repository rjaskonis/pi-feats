import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { applicationExecutionContext } from "../lib/application-context.ts";
import { ensureDefaultProfileContextMemory, resolveContextMemory, snapshotMessage, updateContextMemory, type ContextMemoryAction, type ContextMemoryToolTarget } from "../lib/context-memory.ts";

const actions = ["read", "insert", "update", "remove", "replace"] as const;
const targets = ["operational", "personal"] as const;
const agentRoot = () => process.env.PI_PROFILE_ROOT ?? process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
const profileDirectory = () => process.env.PI_CODING_AGENT_DIR ?? agentRoot();
function executionContext() {
  const application = applicationExecutionContext.getStore();
  return { application: application?.application ?? process.env.PI_APPLICATION_SLUG, identityKey: application?.identityKey ?? process.env.PI_APPLICATION_IDENTITY_KEY, profile: application?.profile ?? process.env.PI_ACTIVE_PROFILE ?? "default", sessionId: application?.sessionId };
}

export default function registerContextMemory(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries() as Array<{ type?: string; customType?: string }>;
    if (entries.some((entry) => entry.type === "custom" && entry.customType === "context-memory-snapshot")) return;
    // Never inject into an already established session when the extension is added later.
    if (entries.some((entry) => entry.type === "message")) return;
    try {
      await ensureDefaultProfileContextMemory(profileDirectory());
      const memory = await resolveContextMemory(agentRoot(), profileDirectory(), executionContext());
      const content = snapshotMessage(memory);
      if (!content) return;
      return { message: { customType: "context-memory-snapshot", content, display: false } };
    } catch (error) {
      console.error(`Context Memory resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  pi.registerTool({
    name: "context_memory",
    label: "Context Memory",
    description: "Read or safely update persistent Context Memory. Use 'operational' for shared operational facts and 'personal' for a person's durable facts. 'personal' automatically writes to the configured PROFILE.md or identity USER.md. Never use file paths.",
    parameters: Type.Object({
      action: Type.Union(actions.map((value) => Type.Literal(value))),
      target: Type.Union(targets.map((value) => Type.Literal(value))),
      content: Type.Optional(Type.String()),
      match: Type.Optional(Type.String()),
      confirmed: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      await ensureDefaultProfileContextMemory(profileDirectory());
      const result = await updateContextMemory(agentRoot(), profileDirectory(), executionContext(), params.action as ContextMemoryAction, params.target as ContextMemoryToolTarget, params.content, params.match, params.confirmed);
      const text = result.action === "read" ? result.content || "No Context Memory has been stored for this target." : result.changed ? `Context Memory ${result.action} completed for ${result.target}. ${result.remaining} of ${result.limit} characters remain. It will be included in new sessions.` : `Context Memory already matched the requested state. ${result.remaining} of ${result.limit} characters remain.`;
      return { content: [{ type: "text" as const, text }], details: { target: result.target, action: result.action, changed: result.changed, used: result.used, limit: result.limit, remaining: result.remaining } };
    },
  });
}
