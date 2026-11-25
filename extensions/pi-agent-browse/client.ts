import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserAction } from "./actions.ts";

export async function browserConnection(agentDir: string, environment: NodeJS.ProcessEnv = process.env) {
  if (environment.PI_BROWSER_ENDPOINT || environment.PI_BROWSER_TOKEN) {
    if (!environment.PI_BROWSER_ENDPOINT || !environment.PI_BROWSER_TOKEN) throw new Error("Incomplete browser worker capability");
    const endpoint = new URL(environment.PI_BROWSER_ENDPOINT);
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error("Browser worker endpoint must be the local API broker");
    return { endpoint: endpoint.origin, token: environment.PI_BROWSER_TOKEN };
  }
  const state = JSON.parse(await readFile(join(agentDir, "browser-local", "connection.json"), "utf8"));
  if (!Number.isSafeInteger(state.port) || state.port < 1024 || state.port > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(state.token)) throw new Error("Invalid local browser configuration");
  return { endpoint: `http://127.0.0.1:${state.port}`, token: state.token };
}
export async function browserRequest(connection: { endpoint: string; token: string }, path: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`${connection.endpoint}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${connection.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000),
  });
  const text = await response.text();
  if (text.length > 9 * 1024 * 1024) throw new Error("Browser response too large");
  const data = JSON.parse(text);
  if (!response.ok) throw new Error(data.error ?? `Browser request failed (${response.status})`);
  return data;
}
export async function executeBrowserAction(agentDir: string, action: BrowserAction, signal?: AbortSignal) {
  const connection = await browserConnection(agentDir);
  return (await browserRequest(connection, "/api/browser/worker/command", action, signal)).result;
}
