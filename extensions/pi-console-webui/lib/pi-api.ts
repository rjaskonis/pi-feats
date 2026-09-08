import { getConfig } from "@/lib/config";

export async function piGet<T>(path: string): Promise<T> {
  const config = await getConfig();
  if (!config.apiToken) throw new Error("Pi API token is not configured");
  const response = await fetch(`${config.apiUrl}/api/${path}`, { headers: { authorization: `Bearer ${config.apiToken}` }, cache: "no-store" });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error?.message ?? body.error ?? "Pi API request failed"); }
  return response.json() as Promise<T>;
}
