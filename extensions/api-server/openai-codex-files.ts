/** Native file parts on the existing Codex transport; never a separate OpenAI API client. */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CompletionRequest } from "./openai-contract.ts";
import type { InputDocument } from "./openai-attachments.ts";
import { attachmentError, CompatibilityError } from "./openai-errors.ts";

export const CODEX_FILE_API = "openai-codex-responses";

/** Catalog defaults are not authoritative for the Codex backend's modalities.
 * Custom model entries can default to text-only when input metadata is omitted.
 * Keep image-blocking policy separate; let Codex validate native visual input.
 */
export function canAttemptVisualInput(model: { api?: string; input?: readonly string[] } | undefined): boolean {
  return !!model && (model.api === CODEX_FILE_API || model.input?.includes("image") === true);
}

type WirePart = Record<string, unknown>;

function nativeUserImageCount(payload: unknown, toolImages = false): number {
  if (!payload || typeof payload !== "object" || !("input" in payload) || !Array.isArray(payload.input)) return 0;
  return payload.input.reduce((count: number, item: any) => count + ((item?.role === "user" && Array.isArray(item.content) ? item.content : toolImages && item?.type === "function_call_output" && Array.isArray(item.output) ? item.output : []).filter((part: any) => part?.type === "input_image" && [part.image_url, part.file_id].some((value) => typeof value === "string" && value.length > 0)).length), 0);
}

/** Native PDF ingestion includes page images, so image policy still applies. */
export function hasNativePdfInput(request: CompletionRequest): boolean {
  return request.messages.some((message) => message.documents?.some((document) => document.mimeType === "application/pdf" || document.filename.toLowerCase().endsWith(".pdf") || Buffer.from(document.data.slice(0, 8), "base64").subarray(0, 5).toString() === "%PDF-"));
}

/** Request-local file bindings survive native context replay, retries and tool turns. */
export class CodexFileBindings {
  private readonly documents: InputDocument[];
  private readonly seen = new Set<string>();

  constructor(request: CompletionRequest) {
    this.documents = request.messages.flatMap((message) => message.documents ?? []);
  }

  get count(): number { return this.documents.length; }

  /** Expand files before existing provider-payload policy hooks inspect them. */
  inject(payload: unknown, model: { api: string }, requireUnseenFiles = true): unknown {
    if (!this.documents.length) return payload;
    if (model.api !== CODEX_FILE_API) throw attachmentError("native_file_provider_mismatch");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw attachmentError("native_file_context_missing");
    const body = payload as Record<string, unknown>;
    if (!Array.isArray(body.input)) throw attachmentError("native_file_context_missing");
    const found = new Set<string>();
    const input = body.input.map((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const item = value as Record<string, unknown>;
      if (item.role !== "user") return item;
      const content = typeof item.content === "string" ? [{ type: "input_text", text: item.content }] : item.content;
      if (!Array.isArray(content)) return item;
      let changed = false;
      const parts: WirePart[] = [];
      for (const raw of content) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw attachmentError("native_file_context_missing");
        const part = raw as WirePart;
        if (part.type !== "input_text" || typeof part.text !== "string") { parts.push(part); continue; }
        let remaining = part.text;
        while (true) {
          const matches = this.documents.map((document) => ({ document, offset: remaining.indexOf(document.marker) })).filter(({ offset }) => offset >= 0).sort((left, right) => left.offset - right.offset);
          const next = matches[0];
          if (!next) { if (remaining || !changed) parts.push({ ...part, text: remaining }); break; }
          const { document, offset } = next;
          if (offset) parts.push({ ...part, text: remaining.slice(0, offset) });
          parts.push({ type: "input_file", filename: document.filename, file_data: `data:${document.mimeType};base64,${document.data}`, ...(document.detail ? { detail: document.detail } : {}) });
          found.add(document.marker); changed = true;
          remaining = remaining.slice(offset + document.marker.length);
        }
      }
      return changed ? { ...item, content: parts } : item;
    });
    // Summaries may see only a subset of the conversation. A main model turn
    // must not drop any attachment that has not already reached a model call.
    if (requireUnseenFiles && this.documents.some((document) => !this.seen.has(document.marker) && !found.has(document.marker))) throw attachmentError("native_file_context_missing");
    for (const marker of found) this.seen.add(marker);
    return { ...body, input };
  }

  /** Never re-add raw files after a profile hook filters or rewrites its input. */
  validatePolicyResult(before: unknown, after: unknown, toolImages = false): void {
    const files = (payload: unknown): Map<string, number> => {
      const counts = new Map<string, number>();
      if (!payload || typeof payload !== "object" || !("input" in payload) || !Array.isArray(payload.input)) return counts;
      for (const item of payload.input) if (item?.role === "user" && Array.isArray(item.content)) {
        for (const part of item.content) if (part?.type === "input_file" && typeof part.filename === "string" && [part.file_data, part.file_id, part.file_url].some((value) => typeof value === "string" && value.length > 0)) counts.set(part.filename, (counts.get(part.filename) ?? 0) + 1);
      }
      return counts;
    };
    if (nativeUserImageCount(after, toolImages) < nativeUserImageCount(before, toolImages)) throw attachmentError("native_image_context_missing");
    const expected = files(before), retained = files(after);
    for (const [filename, count] of expected) if ((retained.get(filename) ?? 0) < count) throw attachmentError("native_file_context_missing");
  }

  assertDelivered(): void {
    if (this.documents.some((document) => !this.seen.has(document.marker))) throw attachmentError("native_file_context_missing");
  }

  clear(): void { this.documents.length = 0; this.seen.clear(); }
}

export type CodexFileBridge = { assertDelivered(): void; failure(): CompatibilityError | undefined; dispose(): void };

/** Wrap all SDK stream calls, including automatic compaction, without replacing auth or agent tools. */
export function installCodexFileBridge(session: AgentSession, request: CompletionRequest, signal: AbortSignal, bridgeOptions?: { toolImages?: boolean }): CodexFileBridge {
  const bindings = new CodexFileBindings(request);
  const original = session.agent.streamFunction;
  const visualInput = request.messages.some((message) => message.images?.length);
  let failure: CompatibilityError | undefined;
  const wrapped: typeof original = (model, context, options) => {
    // Request-local capability metadata prevents the SDK from downgrading user
    // images to text placeholders. Never mutate the selected/catalog model.
    const contextImages = bridgeOptions?.toolImages && context.messages.some((message) => (message.role === "user" || message.role === "toolResult") && Array.isArray(message.content) && message.content.some((part) => part.type === "image"));
    const requestModel = (visualInput || contextImages) && model.api === CODEX_FILE_API && !model.input.includes("image") ? { ...model, input: [...model.input, "image" as const] } : model;
    const expectedImages = model.api === CODEX_FILE_API ? context.messages.reduce((count, message) => count + ((message.role === "user" || (bridgeOptions?.toolImages && message.role === "toolResult")) && Array.isArray(message.content) ? message.content.filter((part) => part.type === "image").length : 0), 0) : 0;
    return original(requestModel, context, {
      ...options,
      onPayload: async (payload, physicalModel) => {
        signal.throwIfAborted(); options?.signal?.throwIfAborted();
        try {
          if (nativeUserImageCount(payload, bridgeOptions?.toolImages) < expectedImages) throw attachmentError("native_image_context_missing");
          const expanded = bindings.inject(payload, physicalModel, options?.sessionId === undefined || options.sessionId === session.sessionId);
          // Snapshot expected parts because a policy hook may mutate its argument.
          const expected = expanded && typeof expanded === "object" && "input" in expanded && Array.isArray(expanded.input)
            ? { input: expanded.input.map((item: any) => {
              if (!item || typeof item !== "object") return item;
              const copy = { ...item };
              for (const key of ["content", "output"]) if (Array.isArray(copy[key])) copy[key] = copy[key].map((part: any) => part && typeof part === "object" ? { ...part } : part);
              return copy;
            }) } : expanded;
          const transformed = await options?.onPayload?.(expanded, physicalModel);
          const body = transformed === undefined ? expanded : transformed;
          bindings.validatePolicyResult(expected, body, bridgeOptions?.toolImages);
          failure = undefined;
          return body;
        } catch (error) {
          failure = error instanceof CompatibilityError ? error : undefined;
          throw error;
        }
      },
    });
  };
  if (bindings.count || visualInput || bridgeOptions?.toolImages) session.agent.streamFunction = wrapped;
  return {
    assertDelivered: () => { if (failure) throw failure; bindings.assertDelivered(); },
    failure: () => failure,
    dispose: () => { if (session.agent.streamFunction === wrapped) session.agent.streamFunction = original; bindings.clear(); },
  };
}
