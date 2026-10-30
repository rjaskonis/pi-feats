import WebSocket from "ws";
import { cdpError, classifyRemoteError, type CdpError } from "./errors";
import { DEFAULT_TIMEOUT_MS, isCdpRawMessage, type CdpEvent, type CdpTransport } from "./types";
import { err, ok, type Result } from "../util/result";

export type EndpointProvider = () => Promise<Result<string, CdpError>>;
type Pending = { method: string; resolve: (value: Result<unknown, CdpError>) => void; timer: ReturnType<typeof setTimeout> };

/** Shared by Steel and explicitly supplied browser endpoints. */
export const createWebSocketTransport = (endpoint: EndpointProvider): CdpTransport => {
  let socket: WebSocket | null = null;
  let status: "open" | "closed" | "connecting" = "closed";
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const events: CdpEvent[] = [];
  let waiter: ((value: IteratorResult<CdpEvent>) => void) | undefined;
  const listeners = new Set<() => void>();
  let cancelConnect: (() => void) | undefined;

  const close = async (): Promise<void> => {
    const ws = socket;
    const wasActive = status !== "closed";
    socket = null;
    status = "closed";
    cancelConnect?.();
    cancelConnect = undefined;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.resolve(err(cdpError("transport_closed", "CDP connection closed", request.method)));
    }
    pending.clear();
    events.length = 0;
    // An initial no-op close must not terminate the session's waiting event consumer.
    if (wasActive) {
      waiter?.({ value: undefined, done: true });
      waiter = undefined;
    }
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate();
    if (wasActive) for (const listener of listeners) listener();
  };

  return {
    close,
    async connect(_url, options) {
      if (status === "open" && socket?.readyState === WebSocket.OPEN) return ok(undefined);
      await close();
      status = "connecting";
      const resolved = await endpoint();
      if (!resolved.success) { status = "closed"; return resolved; }
      return new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: Result<void, CdpError>) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cancelConnect = undefined;
          resolve(result);
        };
        cancelConnect = () => finish(err(cdpError("transport_closed", "CDP connection closed before connection completed")));
        let ws: WebSocket;
        try { ws = new WebSocket(resolved.data, { perMessageDeflate: false }); }
        catch { status = "closed"; finish(err(cdpError("transport_closed", "Invalid CDP WebSocket endpoint"))); return; }
        socket = ws;
        timer = setTimeout(() => {
          finish(err(cdpError("timeout", "CDP connection timed out")));
          void close();
        }, options?.timeoutMs ?? 10_000);
        ws.on("open", () => { status = "open"; finish(ok(undefined)); });
        ws.on("message", (data) => {
          let raw: unknown;
          try { raw = JSON.parse(data.toString()); } catch { return; }
          if (!isCdpRawMessage(raw)) return;
          if (raw.id !== undefined) {
            const request = pending.get(raw.id);
            if (!request) return;
            pending.delete(raw.id);
            clearTimeout(request.timer);
            request.resolve(raw.error
              ? err(cdpError(classifyRemoteError(raw.error.message), raw.error.message, request.method))
              : ok(raw.result));
          } else if (raw.method) {
            const event = { method: raw.method, params: raw.params ?? {}, ...(raw.sessionId ? { sessionId: raw.sessionId } : {}) };
            if (waiter) { const consume = waiter; waiter = undefined; consume({ value: event, done: false }); }
            else events.push(event);
          }
        });
        ws.on("error", () => {
          if (socket !== ws) return;
          finish(err(cdpError("transport_closed", "CDP WebSocket connection failed")));
          void close();
        });
        ws.on("close", () => { if (socket === ws) void close(); });
      });
    },
    request(method, params, options) {
      const ws = socket;
      if (!ws || status !== "open") return Promise.resolve(err(cdpError("transport_closed", "CDP is not connected", method)));
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(err(cdpError("timeout", "CDP command timed out", method)));
        }, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        pending.set(id, { method, resolve, timer });
        try { ws.send(JSON.stringify({ id, method, params, ...(options?.sessionId ? { sessionId: options.sessionId } : {}) })); }
        catch {
          pending.delete(id);
          clearTimeout(timer);
          resolve(err(cdpError("transport_closed", "CDP command could not be sent", method)));
        }
      });
    },
    async *events() {
      while (true) {
        const event = events.shift();
        if (event) yield event;
        else {
          const next = await new Promise<IteratorResult<CdpEvent>>((resolve) => { waiter = resolve; });
          if (next.done) return;
          yield next.value;
        }
      }
    },
    state: () => status,
    onClose(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
};
