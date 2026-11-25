import { getConfig } from "@/lib/config";

// Public and fixed to this single artifact. Never attach the Console's API token.
export async function GET(request: Request): Promise<Response> {
  const headers = new Headers({ "Cache-Control": "no-store" });
  try {
    const { apiUrl } = await getConfig();
    const upstream = await fetch(new URL("/api/browser/pi-agent-browse-extension.zip", apiUrl), {
      cache: "no-store", redirect: "error", signal: request.signal,
    });
    for (const name of ["content-type", "content-disposition", "x-content-type-options"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return Response.json({ error: "Pi API is unavailable." }, { status: 503, headers });
  }
}
