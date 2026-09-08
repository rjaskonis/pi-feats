import { NextResponse } from "next/server";
import { authenticated } from "@/lib/auth";
import { getConfig } from "@/lib/config";

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  if (!(await authenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { path } = await context.params;
  const config = await getConfig();
  if (!config.apiToken) return NextResponse.json({ error: "Pi API token is not configured" }, { status: 503 });
  const prefix = path[0] === "profile" ? "/" : "/api/";
  const url = new URL(`${prefix}${path.map(encodeURIComponent).join("/")}`, config.apiUrl);
  url.search = new URL(request.url).search;
  const headers = new Headers({ authorization: `Bearer ${config.apiToken}` });
  const contentType = request.headers.get("content-type");
  const method = request.method;
  try {
    const payload = ["GET", "HEAD"].includes(method) ? undefined : await request.arrayBuffer();
    if (contentType && payload && payload.byteLength > 0) headers.set("content-type", contentType);
    const response = await fetch(url, { method, headers, body: payload && payload.byteLength > 0 ? payload : undefined, cache: "no-store" });
    const responseHeaders = new Headers();
    for (const name of ["content-type", "cache-control"]) { const value = response.headers.get(name); if (value) responseHeaders.set(name, value); }
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch {
    return NextResponse.json({ error: "Pi API is unavailable. Start it with: pi api start" }, { status: 503 });
  }
}
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
