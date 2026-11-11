/** Streaming Pi gateway, shared by the Next route and local contract tests. */
export function proxyError(path: string[], message: string, status: number, code: string): Response {
  return Response.json(path[0] === "v1"
    ? { error: { message, type: status === 401 ? "authentication_error" : "server_error", param: null, code } }
    : { error: message }, { status });
}

export async function proxyPiRequest(request: Request, path: string[], config: { apiUrl: string; apiToken: string }): Promise<Response> {
  if (!config.apiToken) return proxyError(path, "Pi API token is not configured", 503, "server_error");
  const prefix = path[0] === "profile" || path[0] === "v1" ? "/" : "/api/";
  const url = new URL(`${prefix}${path.map(encodeURIComponent).join("/")}`, config.apiUrl);
  url.search = new URL(request.url).search;
  const headers = new Headers({ authorization: `Bearer ${config.apiToken}` });
  const contentType = request.headers.get("content-type");
  const method = request.method;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const cleanup = () => request.signal.removeEventListener("abort", abort);
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  try {
    let payload: ArrayBuffer | undefined;
    if (!["GET", "HEAD"].includes(method)) {
      if (path[0] === "v1" && request.body) {
        const reader = request.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1_048_576) {
              await reader.cancel().catch(() => {}); cleanup();
              return Response.json({ error: { message: "Request body is too large.", type: "invalid_request_error", param: null, code: "request_too_large" } }, { status: 413 });
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        payload = bytes.buffer;
      } else payload = await request.arrayBuffer();
    }
    if (contentType && payload && payload.byteLength > 0) headers.set("content-type", contentType);
    const response = await fetch(url, { method, headers, body: payload && payload.byteLength > 0 ? payload : undefined, cache: "no-store", signal: controller.signal });
    const responseHeaders = new Headers();
    for (const name of ["content-type", "cache-control", "x-accel-buffering"]) { const value = response.headers.get(name); if (value) responseHeaders.set(name, value); }
    const reader = response.body?.getReader();
    const stream = reader ? new ReadableStream({
      async pull(target) {
        try {
          const { done, value } = await reader.read();
          if (done) { cleanup(); target.close(); } else target.enqueue(value);
        } catch (error) { cleanup(); abort(); target.error(error); }
      },
      async cancel(reason) { cleanup(); abort(); await reader.cancel(reason).catch(() => {}); },
    }) : null;
    if (!reader) cleanup();
    return new Response(stream, { status: response.status, headers: responseHeaders });
  } catch {
    cleanup(); abort();
    return proxyError(path, "Pi API is unavailable. Start it with: pi api start", 503, "server_error");
  }
}
