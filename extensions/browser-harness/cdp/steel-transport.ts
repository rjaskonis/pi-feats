import WebSocket from "ws";
import type { CdpError } from "./errors";
import { cdpError, classifyRemoteError } from "./errors";
import type { CdpEvent, CdpRawMessage, CdpTransport } from "./types";
import { DEFAULT_TIMEOUT_MS, isCdpRawMessage } from "./types";
import { err, ok, type Result } from "../util/result";

export type EndpointProvider = () => Promise<Result<string, CdpError>>;

type Pending = {
  readonly method: string;
  readonly resolve: (value: Result<unknown, CdpError>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

export const createSteelTransport = (endpoint: EndpointProvider): CdpTransport => {
  let socket: WebSocket | null = null;
  let status: "open" | "closed" | "connecting" = "closed";
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const events: CdpEvent[] = [];
  let waiter: ((value: IteratorResult<CdpEvent>) => void) | undefined;
  const closeListeners = new Set<() => void>();

  const rejectPending = (message: string): void => {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.resolve(err(cdpError("transport_closed", message, request.method)));
      pending.delete(id);
    }
  };

  const emit = (event: CdpEvent): void => {
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve({ value: event, done: false });
      return;
    }
    events.push(event);
  };

  const close = async (): Promise<void> => {
    const current = socket;
    socket = null;
    status = "closed";
    rejectPending("Steel CDP connection closed");
    if (current && current.readyState !== WebSocket.CLOSED) current.close();
  };

  const connect = async (_ignoredUrl: string, options?: { timeoutMs?: number }): Promise<Result<void, CdpError>> => {
    if (status === "open" && socket?.readyState === WebSocket.OPEN) return ok(undefined);
    await close();
    status = "connecting";
    const resolved = await endpoint();
    if (!resolved.success) {
      status = "closed";
      return resolved;
    }
    const timeoutMs = options?.timeoutMs ?? 10_000;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Result<void, CdpError>): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      let ws: WebSocket;
      try { ws = new WebSocket(resolved.data, { perMessageDeflate: false }); }
      catch (error) {
        status = "closed";
        finish(err(cdpError("transport_closed", error instanceof Error ? error.message : String(error))));
        return;
      }
      socket = ws;
      const timer = setTimeout(() => {
        ws.close();
        status = "closed";
        finish(err(cdpError("timeout", `Steel CDP connection timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      ws.on("open", () => {
        clearTimeout(timer);
        status = "open";
        finish(ok(undefined));
      });
      ws.on("message", (data) => {
        let message: unknown;
        try { message = JSON.parse(data.toString()); } catch { return; }
        if (!isCdpRawMessage(message)) return;
        const raw = message as CdpRawMessage;
        if (raw.id !== undefined) {
          const request = pending.get(raw.id);
          if (!request) return;
          pending.delete(raw.id);
          clearTimeout(request.timer);
          if (raw.error) request.resolve(err(cdpError(classifyRemoteError(raw.error.message), raw.error.message, request.method)));
          else request.resolve(ok(raw.result));
          return;
        }
        if (raw.method) emit({ method: raw.method, params: raw.params ?? {}, ...(raw.sessionId ? { sessionId: raw.sessionId } : {}) });
      });
      const disconnected = (): void => {
        clearTimeout(timer);
        if (socket !== ws) return;
        socket = null;
        status = "closed";
        rejectPending("Steel CDP disconnected");
        for (const listener of closeListeners) listener();
        finish(err(cdpError("transport_closed", "Steel CDP disconnected before connection completed")));
      };
      ws.on("error", () => {});
      ws.on("close", disconnected);
    });
  };

  return {
    connect,
    close,
    request(method, params, options) {
      const ws = socket;
      if (!ws || status !== "open" || ws.readyState !== WebSocket.OPEN) {
        return Promise.resolve(err(cdpError("transport_closed", "Steel CDP is not connected", method)));
      }
      const id = nextId++;
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(err(cdpError("timeout", `Steel CDP command timed out after ${timeoutMs}ms`, method)));
        }, timeoutMs);
        pending.set(id, { method, resolve, timer });
        try {
          ws.send(JSON.stringify({ id, method, params, ...(options?.sessionId ? { sessionId: options.sessionId } : {}) }));
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          resolve(err(cdpError("transport_closed", error instanceof Error ? error.message : String(error), method)));
        }
      });
    },
    async *events() {
      while (true) {
        const event = events.shift();
        if (event) yield event;
        else yield await new Promise<CdpEvent>((resolve) => { waiter = (result) => resolve(result.value); });
      }
    },
    state: () => status,
    onClose(callback) { closeListeners.add(callback); return () => closeListeners.delete(callback); },
  };
};
