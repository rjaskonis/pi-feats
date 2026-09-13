import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applicationExecutionContext } from "../lib/application-context.ts";
import { readProfileEnv } from "../lib/profile-env.ts";

type RecordValue = Record<string, unknown>;
type ComposioConfig = { apiKey: string; userId: string };
type ConnectedAccount = { id: string; alias?: string | null; wordId?: string | null; status?: string | null; toolkit?: { slug?: string | null } | null };
type ComposioClient = {
  sessions: { create(userId: string, options?: RecordValue): Promise<ComposioSession> };
  tools: { execute(slug: string, input: { arguments: RecordValue; userId: string; connectedAccountId?: string }): Promise<unknown> };
  connectedAccounts: { list(input: { userIds: string[]; toolkitSlugs?: string[] }): Promise<{ items?: ConnectedAccount[] }> };
};
type ComposioSession = {
  search(input: { query: string; toolkits?: string[] }): Promise<unknown>;
  authorize(toolkit: string, options?: { alias?: string }): Promise<{ id?: string; status?: string; redirectUrl?: string | null }>;
};

type Runtime = { config: ComposioConfig; client: ComposioClient; session: ComposioSession };
const runtimes = new Map<string, Promise<Runtime>>();

function asRecord(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function configurationError(message: string): Error { return new Error(`Composio is not configured: ${message}`); }

export function resolveComposioUserId(values: Record<string, string>, environment: NodeJS.ProcessEnv = process.env, identityKey = applicationExecutionContext.getStore()?.identityKey): string | undefined {
  return values.COMPOSIO_USER_ID?.trim()
    ?? environment.COMPOSIO_USER_ID?.trim()
    ?? identityKey
    ?? environment.PI_APPLICATION_IDENTITY_KEY?.trim();
}

async function configuration(): Promise<ComposioConfig> {
  const profileDir = process.env.PI_CODING_AGENT_DIR;
  const values = profileDir ? await readProfileEnv(profileDir) : {};
  const apiKey = values.COMPOSIO_API_KEY?.trim() ?? process.env.COMPOSIO_API_KEY?.trim();
  const userId = resolveComposioUserId(values);
  if (!apiKey) throw configurationError("set COMPOSIO_API_KEY in this profile's .env file.");
  if (!userId) throw configurationError("set COMPOSIO_USER_ID or invoke Composio from an Application identity.");
  return { apiKey, userId };
}

async function runtime(): Promise<Runtime> {
  const config = await configuration();
  const key = `${config.apiKey}\u0000${config.userId}`;
  let current = runtimes.get(key);
  if (!current) {
    current = (async () => {
      const module = await import("@composio/core") as { Composio?: new (input: { apiKey: string }) => ComposioClient; default?: new (input: { apiKey: string }) => ComposioClient };
      const Constructor = module.Composio ?? module.default;
      if (!Constructor) throw new Error("Unable to load the Composio SDK.");
      const client = new Constructor({ apiKey: config.apiKey });
      const session = await client.sessions.create(config.userId, { manageConnections: { enable: true } });
      return { config, client, session };
    })();
    runtimes.set(key, current);
  }
  try { return await current; }
  catch (error) { runtimes.delete(key); throw error; }
}

function selector(account: ConnectedAccount): string { return account.alias ?? account.wordId ?? account.id; }
export function selectConnectedAccount(items: ConnectedAccount[], toolkit: string, account?: string): string | undefined {
  const accounts = items.filter((item) => item.toolkit?.slug === toolkit && item.status?.toUpperCase() === "ACTIVE");
  if (!accounts.length) return undefined;
  if (account) {
    const found = accounts.find((item) => item.id === account || item.alias === account || item.wordId === account);
    if (!found) throw new Error(`No active ${toolkit} account matches "${account}".`);
    return found.id;
  }
  if (accounts.length === 1) return accounts[0].id;
  throw new Error(`Multiple active ${toolkit} accounts are connected. Choose one: ${accounts.map(selector).join(", ")}.`);
}
async function accountFor(client: ComposioClient, userId: string, toolkit: string, account?: string): Promise<string | undefined> {
  const result = await client.connectedAccounts.list({ userIds: [userId], toolkitSlugs: [toolkit] });
  return selectConnectedAccount(result.items ?? [], toolkit, account);
}

function inferToolkit(slug: string): string { return slug.split("_", 1)[0]?.toLowerCase() ?? ""; }
function result(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value }; }

export default function registerComposio(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "composio_search_tools",
    label: "Search connected services",
    description: "Find actions available in connected personal services.",
    parameters: Type.Object({ query: Type.String({ minLength: 1 }), toolkits: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) }),
    async execute(_id, params) {
      const current = await runtime();
      return result(await current.session.search({ query: params.query, ...(params.toolkits?.length ? { toolkits: params.toolkits } : {}) }));
    },
  });

  pi.registerTool({
    name: "composio_list_accounts",
    label: "List connected accounts",
    description: "List active and inactive accounts connected to a personal service.",
    parameters: Type.Object({ toolkit: Type.Optional(Type.String({ minLength: 1 })) }),
    async execute(_id, params) {
      const current = await runtime();
      const accounts = await current.client.connectedAccounts.list({ userIds: [current.config.userId], ...(params.toolkit ? { toolkitSlugs: [params.toolkit] } : {}) });
      return result({ accounts: accounts.items ?? [] });
    },
  });

  pi.registerTool({
    name: "composio_manage_connections",
    label: "Connect a personal service",
    description: "Check or start a secure connection to a personal service.",
    parameters: Type.Object({ toolkit: Type.String({ minLength: 1 }), alias: Type.Optional(Type.String({ minLength: 1 })) }),
    async execute(_id, params) {
      const current = await runtime();
      const connection = await current.session.authorize(params.toolkit, ...(params.alias ? [{ alias: params.alias }] : []));
      return result({ toolkit: params.toolkit, status: connection.status ?? "PENDING", connectionId: connection.id, connectUrl: connection.redirectUrl ?? undefined });
    },
  });

  pi.registerTool({
    name: "composio_execute_tool",
    label: "Use a connected service",
    description: "Run an action in a connected personal service.",
    parameters: Type.Object({
      slug: Type.String({ minLength: 1 }),
      arguments: Type.Optional(Type.Object({}, { additionalProperties: true })),
      toolkit: Type.Optional(Type.String({ minLength: 1 })),
      account: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_id, params) {
      const current = await runtime();
      const toolkit = params.toolkit ?? inferToolkit(params.slug);
      if (!toolkit) throw new Error("A toolkit is required to execute this action.");
      const connectedAccountId = await accountFor(current.client, current.config.userId, toolkit, params.account);
      const response = await current.client.tools.execute(params.slug, {
        arguments: asRecord(params.arguments),
        userId: current.config.userId,
        ...(connectedAccountId ? { connectedAccountId } : {}),
      });
      return result(response);
    },
  });
}
