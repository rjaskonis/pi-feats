export type ApplicationHandlerType = "inbound" | "outbound" | "transform";
export function applicationHandlerTemplate(type: ApplicationHandlerType): string {
  if (type === "inbound") return `type Payload = Record<string, unknown>;
type Context = Record<string, any>;
type State = Record<string, unknown>;

export async function handle(
  payload: Payload,
  headers: Record<string, unknown> = {},
  query: Record<string, unknown> = {},
  context: Context,
  state: State = {},
  env: Record<string, string | undefined> = {},
) {
  // context.settings is ~/.pi/agent/settings.json.
  // context.application.settings belongs only to this Application.
  // Preferred: identityKey resolves through this Application's Identity Key mappings.
  // An exact key wins; '*' is the fallback mapping for all unknown identities.
  return {
    identityKey: String(payload.identityKey ?? ""),
    state: { ...state },
    payload: { message: String(payload.message ?? "") },
  };
}

// Alternatively, omit identityKey and return a direct route instead:
// return { profile: "default", sessionPrefix: "conversation", payload: { message: "..." } };
// sessionPrefix is optional in that mode and defaults to "default".
`;
  if (type === "outbound") return `type Payload = Record<string, any>;
type Context = Record<string, any>;
type State = Record<string, unknown>;

export async function handle(
  payload: Payload,
  headers: Record<string, unknown> = {},
  query: Record<string, unknown> = {},
  context: Context,
  state: State = {},
  env: Record<string, string | undefined> = {},
) {
  // payload.message.content contains the Pi response.
  // Use state for data preserved by inbound and context.settings for global Pi settings.
  return { payload, response: String(payload.message?.content ?? "") };
}
`;
  return `type Payload = Record<string, unknown>;
type Context = Record<string, any>;
type State = Record<string, unknown>;

export async function handle(
  payload: Payload,
  headers: Record<string, unknown> = {},
  query: Record<string, unknown> = {},
  context: Context,
  state: State = {},
  env: Record<string, string | undefined> = {},
) {
  // Transforms run in the configured order before inbound.
  return { payload: { ...payload }, state: { ...state } };
}
`;
}
