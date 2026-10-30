import { cdpError, type CdpError } from "./errors";
import { err, ok, type Result } from "../util/result";

export function validateEndpoint(value: string): Result<string, CdpError> {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.hash) throw new Error();
    return ok(url.href);
  } catch {
    return err(cdpError("discovery_failed", "CDP endpoint must be an HTTP(S) or WebSocket URL without a fragment."));
  }
}

/** Never include credentials, query parameters, or browser identifiers in status output. */
export function endpointLabel(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}`;
}

export async function resolveEndpoint(value: string, timeoutMs = 10_000): Promise<Result<string, CdpError>> {
  const checked = validateEndpoint(value);
  if (!checked.success) return checked;
  const url = new URL(checked.data);
  if (url.protocol === "ws:" || url.protocol === "wss:") return ok(url.href);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/json/version`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    if (!response.ok) {
      const hint = response.status === 404
        ? " Chrome UI-enabled remote debugging may expose WebSocket only. For an explicitly requested local Chrome, resolve its DevToolsActivePort and retry with the ws:// endpoint; do not assume a closed port or require a restart. For a remote browser, obtain its WebSocket from that environment instead."
        : "";
      return err(cdpError("discovery_failed", `CDP discovery returned HTTP ${response.status}.${hint}`));
    }
    const body = await response.json() as { webSocketDebuggerUrl?: unknown };
    if (typeof body?.webSocketDebuggerUrl !== "string") throw new Error();
    const ws = new URL(body.webSocketDebuggerUrl);
    if (ws.protocol !== "ws:" && ws.protocol !== "wss:") throw new Error();
    return ok(ws.href);
  } catch {
    return err(cdpError("discovery_failed", "CDP discovery failed: unreachable endpoint, timeout, or invalid /json/version response."));
  }
}
