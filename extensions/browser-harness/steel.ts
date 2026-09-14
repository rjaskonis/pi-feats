import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { cdpError, type CdpError } from "./cdp/errors";
import { err, ok, type Result } from "./util/result";

const STATE_VERSION = 1;

type SteelState = {
  readonly version: number;
  readonly piProfile: string;
  readonly sessionContext?: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type SteelSession = { readonly id: string; readonly websocketUrl: string };

type SteelConfig = { readonly apiUrl: string; readonly apiKey?: string };

const agentDir = (): string => process.env["PI_CODING_AGENT_DIR"]?.trim() || join(homedir(), ".pi", "agent");
const activeProfile = (): string => process.env["PI_ACTIVE_PROFILE"]?.trim() || "default";
const statePath = (): string => join(agentDir(), "steel.json");

const config = (): SteelConfig => ({
  apiUrl: (process.env["STEEL_API_URL"]?.trim() || "http://127.0.0.1:3000").replace(/\/$/, ""),
  ...(process.env["STEEL_API_KEY"]?.trim() ? { apiKey: process.env["STEEL_API_KEY"]?.trim() } : {}),
});

const headers = (value: SteelConfig): HeadersInit => ({
  "content-type": "application/json",
  ...(value.apiKey ? { "steel-api-key": value.apiKey } : {}),
});

const loadState = async (): Promise<SteelState | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath(), "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = parsed as Partial<SteelState>;
    if (value.version !== STATE_VERSION || value.piProfile !== activeProfile()) return undefined;
    return value as SteelState;
  } catch { return undefined; }
};

const saveState = async (sessionContext: Record<string, unknown> | undefined): Promise<void> => {
  const path = statePath();
  const now = new Date().toISOString();
  const existing = await loadState();
  const state: SteelState = {
    version: STATE_VERSION,
    piProfile: activeProfile(),
    ...(sessionContext ? { sessionContext } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
};

const sessionEndpoint = (websocketUrl: string, apiUrl: string): Result<string, CdpError> => {
  try {
    const endpoint = new URL(websocketUrl);
    const api = new URL(apiUrl);
    // Self-hosted Steel returns its container hostname in websocketUrl. The API
    // origin is the reachable public endpoint and is therefore authoritative.
    endpoint.hostname = api.hostname;
    endpoint.port = api.port;
    if (api.protocol === "https:") endpoint.protocol = "wss:";
    else endpoint.protocol = "ws:";
    return ok(endpoint.toString());
  } catch {
    return err(cdpError("invalid_response", "Steel returned an invalid session websocketUrl"));
  }
};

const assertNoLiveSession = async (value: SteelConfig): Promise<Result<void, CdpError>> => {
  try {
    const response = await fetch(`${value.apiUrl}/v1/sessions`, { headers: headers(value) });
    const raw: unknown = await response.json();
    const sessions = raw && typeof raw === "object" ? (raw as { sessions?: unknown }).sessions : undefined;
    if (Array.isArray(sessions) && sessions.some((session) => session && typeof session === "object" && (session as { status?: unknown }).status === "live")) {
      return err(cdpError("remote_error", "Steel Browser v0.5.x supports one active session. Release the current browser session before using another Pi Profile."));
    }
    return ok(undefined);
  } catch (error) {
    return err(cdpError("transport_closed", `Steel API is unavailable: ${error instanceof Error ? error.message : String(error)}`));
  }
};

const createSession = async (value: SteelConfig, sessionContext?: Record<string, unknown>): Promise<Result<SteelSession, CdpError>> => {
  try {
    const response = await fetch(`${value.apiUrl}/v1/sessions`, {
      method: "POST",
      headers: headers(value),
      body: JSON.stringify({ ...(sessionContext ? { sessionContext } : {}) }),
    });
    const raw: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !raw || typeof raw !== "object") return err(cdpError("remote_error", `Steel session creation failed (${response.status})`));
    const data = raw as { id?: unknown; websocketUrl?: unknown };
    if (typeof data.id !== "string" || typeof data.websocketUrl !== "string") {
      return err(cdpError("invalid_response", "Steel did not return session id and websocketUrl"));
    }
    return ok({ id: data.id, websocketUrl: data.websocketUrl });
  } catch (error) {
    return err(cdpError("transport_closed", `Steel API is unavailable: ${error instanceof Error ? error.message : String(error)}`));
  }
};

const getSessionContext = async (value: SteelConfig, sessionId: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const response = await fetch(`${value.apiUrl}/v1/sessions/${encodeURIComponent(sessionId)}/context`, { headers: headers(value) });
    const data: unknown = await response.json();
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  } catch { return undefined; }
};

export type SteelRuntime = {
  endpoint(): Promise<Result<string, CdpError>>;
  status(): { readonly sessionId?: string; readonly hasPersistedContext: boolean };
  release(): Promise<void>;
};

/**
 * Steel Browser v0.5.x has a session API, not a Profiles API. The active Pi
 * Profile is therefore represented by a profile-scoped persisted SessionContext
 * in steel.json. Session lifecycle remains exclusively API-driven; CDP is used
 * only after the API returns the session websocket endpoint.
 */
export const createSteelRuntime = (): SteelRuntime => {
  let sessionId: string | undefined;
  let endpointUrl: string | undefined;
  let persistedContext = false;

  const endpoint = async (): Promise<Result<string, CdpError>> => {
    if (endpointUrl) return ok(endpointUrl);
    const settings = config();
    const available = await assertNoLiveSession(settings);
    if (!available.success) return available;
    const state = await loadState();
    persistedContext = state?.sessionContext !== undefined;
    const session = await createSession(settings, state?.sessionContext);
    if (!session.success) return session;
    const resolved = sessionEndpoint(session.data.websocketUrl, settings.apiUrl);
    if (!resolved.success) return resolved;
    sessionId = session.data.id;
    endpointUrl = resolved.data;
    return resolved;
  };

  return {
    endpoint,
    status: () => ({ ...(sessionId ? { sessionId } : {}), hasPersistedContext: persistedContext }),
    async release() {
      if (!sessionId) return;
      const settings = config();
      const id = sessionId;
      const context = await getSessionContext(settings, id);
      if (context) {
        await saveState(context);
        persistedContext = true;
      }
      sessionId = undefined;
      endpointUrl = undefined;
      try {
        await fetch(`${settings.apiUrl}/v1/sessions/${encodeURIComponent(id)}/release`, {
          method: "POST",
          headers: headers(settings),
        });
      } catch {}
    },
  };
};
