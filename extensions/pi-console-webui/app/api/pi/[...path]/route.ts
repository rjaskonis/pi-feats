import { validApiBearerToken } from "@/lib/api-auth";
import { authenticated } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { proxyError, proxyPiRequest } from "@/lib/api-proxy";

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const config = await getConfig();
  const { path } = await context.params;
  if (!(await authenticated()) && !validApiBearerToken(request.headers.get("authorization"), config.apiToken)) return proxyError(path, "Unauthorized", 401, "invalid_api_key");
  return proxyPiRequest(request, path, config);
}
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
