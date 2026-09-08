import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";

const hopByHopHeaders = new Set(["connection", "content-length", "host", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params; const config = await getConfig();
  const url = new URL(`/api/message/app/${encodeURIComponent(slug)}`, config.apiUrl); url.search = new URL(request.url).search;
  const headers = new Headers(); for (const [name, value] of request.headers) if (!hopByHopHeaders.has(name.toLowerCase())) headers.set(name, value);
  try { const body = await request.arrayBuffer(); const response = await fetch(url, { method: "POST", headers, body: body.byteLength ? body : undefined, cache: "no-store" }); const responseHeaders = new Headers(); for (const name of ["content-type", "cache-control"]) { const value = response.headers.get(name); if (value) responseHeaders.set(name, value); } return new Response(response.body, { status: response.status, headers: responseHeaders }); }
  catch { return NextResponse.json({ error: "Pi API is unavailable." }, { status: 503 }); }
}
