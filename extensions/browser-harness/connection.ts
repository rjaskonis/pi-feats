import { randomUUID } from "node:crypto";
import { createBrowserClient, type BrowserClient } from "./client";
import { createSteelRuntime } from "./steel";
import { createSteelTransport } from "./cdp/steel-transport";
import { createWebSocketTransport } from "./cdp/websocket-transport";
import { endpointLabel, resolveEndpoint, validateEndpoint } from "./cdp/endpoint";
import { createMutex } from "./util/mutex";
import { performSetup, type SetupResult } from "./setup";

export type ConnectionSelection = { provider: "steel" } | { provider: "cdp"; endpoint: string };
export type SetupOptions = { provider?: "steel" | "cdp"; endpoint?: string };
export type BrowserConnection = {
  client(): BrowserClient;
  selection(): ConnectionSelection;
  label(): string;
  viewerUrl(): string | undefined;
  withClient<T>(fn: (client: BrowserClient) => Promise<T>): Promise<T>;
  setup(options?: SetupOptions): Promise<SetupResult>;
  release(): Promise<void>;
};
export type ConnectionResource = {
  client: BrowserClient;
  viewerUrl(): string | undefined;
  release(): Promise<void>;
};

function createResource(selection: ConnectionSelection): ConnectionResource {
  const namespace = `browser-${process.env["PI_ACTIVE_PROFILE"] ?? "default"}-${randomUUID()}`;
  if (selection.provider === "steel") {
    const steel = createSteelRuntime();
    const client = createBrowserClient({ namespace, transport: createSteelTransport(() => steel.endpoint()), remote: { cdpUrl: "steel://active-profile", browserId: "steel" } });
    return { client, viewerUrl: () => steel.status().viewerUrl, release: () => steel.release() };
  }
  const client = createBrowserClient({
    namespace,
    transport: createWebSocketTransport(() => resolveEndpoint(selection.endpoint)),
    remote: { cdpUrl: selection.endpoint, browserId: "external" },
    allowExistingTabs: true,
  });
  return { client, viewerUrl: () => undefined, release: async () => {} };
}

/** Shared leases preserve parallel reads; switching waits for every current tool to finish. */
export function createBrowserConnection(factory = createResource): BrowserConnection {
  let selected: ConnectionSelection = { provider: "steel" };
  let resource = factory(selected);
  const gate = createMutex();
  let active = 0;
  let drained: (() => void) | undefined;
  const label = () => selected.provider === "steel" ? "Steel" : `External CDP (${endpointLabel(selected.endpoint)})`;

  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const unlock = await gate.acquire();
    try {
      if (active) await new Promise<void>((resolve) => { drained = resolve; });
      return await fn();
    } finally { unlock(); }
  }
  async function disconnect(): Promise<void> {
    try {
      // Only created tabs are disposable. Authorized existing tabs are never owned.
      if (resource.client.status().alive) await resource.client.closeOwnedTabs();
    } finally {
      try { await resource.client.stop(); }
      finally { await resource.release(); }
    }
  }
  return {
    client: () => resource.client,
    selection: () => ({ ...selected }),
    label,
    viewerUrl: () => resource.viewerUrl(),
    async withClient(fn) {
      const unlock = await gate.acquire();
      const client = resource.client;
      active++;
      unlock();
      try { return await fn(client); }
      finally { if (--active === 0) { drained?.(); drained = undefined; } }
    },
    async setup(options = {}) {
      if (options.endpoint !== undefined && options.provider === "steel") return { success: false, error: "Steel does not accept an external CDP endpoint." };
      if (options.endpoint !== undefined) {
        const checked = validateEndpoint(options.endpoint);
        if (!checked.success) return { success: false, error: checked.error.message };
        options = { ...options, endpoint: checked.data };
      }
      return exclusive(async () => {
        if (options.provider === "cdp" && !options.endpoint && selected.provider !== "cdp") return { success: false, error: "Selecting external CDP requires an endpoint." };
        const next: ConnectionSelection = options.endpoint
          ? { provider: "cdp", endpoint: options.endpoint }
          : options.provider === "steel" ? { provider: "steel" } : selected;
        const changed = next.provider !== selected.provider || (next.provider === "cdp" && selected.provider === "cdp" && next.endpoint !== selected.endpoint);
        if (changed) {
          await disconnect();
          selected = next;
          resource = factory(selected);
        }
        // On failure the explicit selection remains selected; there is no Steel fallback.
        return performSetup(resource.client, undefined, () => resource.viewerUrl(), label());
      });
    },
    release: () => exclusive(async () => {
      await disconnect();
      // Discard ownership and references even when reconnecting to the same endpoint.
      resource = factory(selected);
    }),
  };
}
