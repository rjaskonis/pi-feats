import type { CallSnapshot, CallStage, CallStageId, OpenAICallDetail, OpenAICallLog, OpenAICallSummary } from "../lib/openai-call-log-types.ts";

// Bound both traversal and serialized size. Never copy binary attachment fields.
const detailBudget = 16_384;
const textLimit = 4_096;
const sensitive = /^(?:authorization|proxy[-_]authorization|api[-_]?key|password|secret|(?:access|refresh)[-_]?token|token|cookie|set-cookie)$/i;
const attachment = /^(?:file_data|image_data|audio_data|base64|b64_json|bytes|(?:image|file|audio)_url)$/i;

export function snapshot(input: unknown): CallSnapshot {
  let remaining = detailBudget, limited = false;
  const omit = (label: string) => { limited = true; return `[${label}]`; };
  const visit = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value === "boolean" || typeof value === "number") { remaining -= 25; return value; }
    if (typeof value === "string") {
      if (/^data:/i.test(value)) { remaining -= 32; return omit("Inline data omitted"); }
      const prefix = value.slice(0, Math.min(textLimit, Math.max(0, Math.floor(remaining / 6))));
      remaining -= Buffer.byteLength(JSON.stringify(prefix)) + 20;
      return prefix.length === value.length ? prefix : `${prefix}${omit("Truncated")}`;
    }
    if (typeof value !== "object" || depth > 16) { remaining -= 32; return omit("Value omitted"); }
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) {
        if (remaining < 64) { items.push(omit("Remaining items omitted")); break; }
        remaining -= 4; items.push(visit(item, depth + 1));
      }
      return items;
    }
    const object: Record<string, unknown> = Object.create(null);
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (remaining < 512 || key.length > 64) { object["[Omitted fields]"] = omit("Remaining fields omitted"); break; }
      remaining -= Buffer.byteLength(JSON.stringify(key)) + 4;
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      if (sensitive.test(key) || attachment.test(key) || (key === "data" && (typeof item === "string" || Array.isArray(item)))) {
        remaining -= 32; object[key] = omit("Field omitted");
      } else object[key] = visit(item, depth + 1);
    }
    return object;
  };
  const value = visit(input, 0);
  return { value, limited };
}

export class OpenAICallCapture {
  readonly call: OpenAICallSummary;
  private readonly started = performance.now();
  private stageStarted = this.started;
  private readonly stages: CallStage[] = [{ id: "request", outcome: "running", durationMs: null }];
  private partial = "";
  private partialLimited = false;
  private done = false;
  private readonly update?: (detail: OpenAICallDetail) => void;

  constructor(id: string, endpoint: OpenAICallLog["endpoint"], update?: (detail: OpenAICallDetail) => void) {
    this.update = update;
    this.call = { id, endpoint, receivedAt: new Date().toISOString(), profile: null, stream: null, httpStatus: null, outcome: "running", durationMs: null, errorCode: null };
    this.publish();
  }

  private publish() {
    try { this.update?.({ call: { ...this.call }, stages: this.stages.map((stage) => ({ ...stage })) }); }
    catch { /* Logging must not affect request handling. */ }
  }

  private current() { return this.stages[this.stages.length - 1]; }
  private endStage(outcome: OpenAICallLog["outcome"]) {
    Object.assign(this.current(), { outcome, durationMs: Math.round(performance.now() - this.stageStarted) });
  }

  stage(id: CallStageId, data?: unknown) {
    if (this.done) return;
    if (this.current().id !== id) {
      this.endStage("success");
      this.stages.push({ id, outcome: "running", durationMs: null });
      this.stageStarted = performance.now();
    }
    if (data !== undefined) this.current().data = snapshot(data);
    this.publish();
  }

  append(delta: string) {
    if (this.done || this.partialLimited) return;
    const available = textLimit - this.partial.length;
    this.partial += delta.slice(0, available);
    if (delta.length > available) this.partialLimited = true;
  }

  fail(code: string, body: unknown, terminalEvent?: unknown) {
    if (this.done) return;
    this.call.errorCode = code;
    if (this.current().id !== "response") this.endStage("error");
    if (this.current().id === "response") this.current().data = snapshot(this.partialResponse(body, terminalEvent));
    else {
      this.stageStarted = performance.now();
      this.stages.push({ id: "response", outcome: "running", durationMs: null, data: snapshot(this.partialResponse(body, terminalEvent)) });
    }
    this.publish();
  }

  private partialResponse(error?: unknown, terminalEvent?: unknown) {
    if (!this.partial.length && terminalEvent === undefined) return error;
    return { error, terminalEvent, partialOutput: this.partial, ...(this.partialLimited ? { partialOutputTruncated: true } : {}) };
  }

  finish(httpStatus: number | null, completed: boolean): OpenAICallLog {
    this.done = true;
    const outcome = !completed ? "aborted" : this.call.errorCode || (httpStatus ?? 500) >= 400 ? "error" : "success";
    this.endStage(outcome);
    if (!completed && this.partial.length) {
      const data = snapshot(this.partialResponse());
      const stage: CallStage = { id: "response", outcome: "aborted", durationMs: null, data };
      if (this.current().id === "response") this.current().data = data;
      else this.stages.push(stage);
    }
    const call = { ...this.call, httpStatus, outcome, durationMs: Math.round(performance.now() - this.started) } as OpenAICallLog;
    Object.assign(this.call, call);
    return call;
  }

  detail() { return this.stages; }
}
