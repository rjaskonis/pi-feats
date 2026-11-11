/** Text-only OpenAI wire contracts and strict request normalization. */
export type Protocol = "chat" | "responses";
export type ConversationMessage = { role: "system" | "user" | "assistant"; content: string };
export type CompletionRequest = {
  profile: string;
  messages: ConversationMessage[];
  stream: boolean;
  includeUsage: boolean;
  metadata: Record<string, string> | null;
  instructions: string | null;
};
export type TokenUsage = { input: number; output: number; cached: number; reasoning: number };
export type CompletionResult = { text: string; finishReason: "stop" | "length"; usage: TokenUsage };
export type ExecutionEvent = { type: "ready" } | { type: "text"; delta: string };

/** A safe, client-facing error; integration exceptions must not be exposed. */
export class CompatibilityError extends Error {
  readonly param: string | null;
  readonly status: number;
  readonly code: string;
  constructor(message: string, param: string | null = null, status = 400, code = "invalid_request_error") {
    super(message); this.param = param; this.status = status; this.code = code;
  }
}

export function errorBody(error: unknown) {
  const known = error instanceof CompatibilityError;
  return { error: { message: known ? error.message : "Pi execution failed.", type: known && error.status < 500 ? (error.status === 401 ? "authentication_error" : "invalid_request_error") : "server_error", param: known ? error.param : null, code: known ? error.code : "server_error" } };
}

function record(value: unknown, param: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompatibilityError("Expected an object.", param);
  return value as Record<string, unknown>;
}
function fields(body: Record<string, unknown>, allowed: string[], prefix = "") {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new CompatibilityError("Unsupported parameter.", `${prefix}${key}`, 400, "unsupported_parameter");
}
function text(value: unknown, param: string, types: string[]): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.length) throw new CompatibilityError("Expected text or a non-empty array of text parts.", param);
  return value.map((part, index) => {
    const item = record(part, `${param}.${index}`);
    fields(item, ["type", "text", "annotations", "logprobs"], `${param}.${index}.`);
    if (!types.includes(String(item.type)) || typeof item.text !== "string") throw new CompatibilityError("Only text content is supported.", `${param}.${index}`);
    if (item.annotations !== undefined && (!Array.isArray(item.annotations) || item.annotations.length)) throw new CompatibilityError("Annotations are not supported.", `${param}.${index}.annotations`);
    if (item.logprobs !== undefined && (!Array.isArray(item.logprobs) || item.logprobs.length)) throw new CompatibilityError("Log probabilities are not supported.", `${param}.${index}.logprobs`);
    return item.text;
  }).join("");
}

/** Normalize either protocol without flattening user/assistant history into a prompt. */
export function normalizeRequest(input: unknown, protocol: Protocol): CompletionRequest {
  const body = record(input, "body");
  const common = ["model", "stream", "stream_options", "store", "metadata", "user", "safety_identifier"];
  fields(body, [...common, ...(protocol === "chat" ? ["messages", "n", "response_format"] : ["input", "instructions", "background", "previous_response_id", "conversation", "text"])]);
  if (typeof body.model !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(body.model)) throw new CompatibilityError("model must identify a Pi profile.", "model");
  if (body.stream != null && typeof body.stream !== "boolean") throw new CompatibilityError("stream must be a boolean.", "stream");
  if (body.store != null && body.store !== false) throw new CompatibilityError("Only store: false is supported.", "store", 400, "unsupported_parameter");
  if (body.n != null && body.n !== 1) throw new CompatibilityError("Only n: 1 is supported.", "n", 400, "unsupported_parameter");
  if (body.background != null && body.background !== false) throw new CompatibilityError("Background execution is not supported.", "background", 400, "unsupported_parameter");
  for (const field of ["previous_response_id", "conversation"]) if (body[field] != null) throw new CompatibilityError("Send conversation context in input instead.", field, 400, "unsupported_parameter");
  for (const field of ["user", "safety_identifier"]) if (body[field] != null && typeof body[field] !== "string") throw new CompatibilityError("Expected a string.", field);
  let includeUsage = false;
  if (body.stream_options != null) {
    const options = record(body.stream_options, "stream_options");
    fields(options, protocol === "chat" ? ["include_usage", "include_obfuscation"] : ["include_obfuscation"], "stream_options.");
    if (!body.stream) throw new CompatibilityError("stream_options requires stream: true.", "stream_options");
    if (options.include_usage !== undefined && typeof options.include_usage !== "boolean") throw new CompatibilityError("Expected a boolean.", "stream_options.include_usage");
    if (options.include_obfuscation !== undefined && options.include_obfuscation !== false) throw new CompatibilityError("Stream obfuscation is not supported.", "stream_options.include_obfuscation");
    includeUsage = options.include_usage === true;
  }
  const format = protocol === "chat" ? body.response_format : body.text == null ? undefined : (() => { const value = record(body.text, "text"); fields(value, ["format"], "text."); return value.format; })();
  if (format != null) { const value = record(format, protocol === "chat" ? "response_format" : "text.format"); fields(value, ["type"]); if (value.type !== "text") throw new CompatibilityError("Only plain text output is supported.", protocol === "chat" ? "response_format" : "text.format", 400, "unsupported_parameter"); }
  let metadata: Record<string, string> | null = null;
  if (body.metadata != null) {
    const value = record(body.metadata, "metadata");
    if (Object.keys(value).length > 16 || Object.entries(value).some(([key, item]) => key.length > 64 || typeof item !== "string" || item.length > 512)) throw new CompatibilityError("metadata supports up to 16 string values (64-character keys, 512-character values).", "metadata");
    metadata = value as Record<string, string>;
  }
  if (body.instructions != null && typeof body.instructions !== "string") throw new CompatibilityError("instructions must be a string.", "instructions");
  const raw = protocol === "chat" ? body.messages : typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input;
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) throw new CompatibilityError("Provide between 1 and 100 text messages.", protocol === "chat" ? "messages" : "input");
  const messages = raw.map((value, index): ConversationMessage => {
    const param = `${protocol === "chat" ? "messages" : "input"}.${index}`, item = record(value, param);
    fields(item, protocol === "chat" ? ["role", "content", "name", "refusal", "tool_calls"] : ["type", "role", "content", "id", "status"], `${param}.`);
    if (protocol === "responses" && item.type !== undefined && item.type !== "message") throw new CompatibilityError("Only message input items are supported.", `${param}.type`);
    if (!["system", "developer", "user", "assistant"].includes(String(item.role))) throw new CompatibilityError("Unsupported message role.", `${param}.role`);
    if (item.name != null) throw new CompatibilityError("Named messages are not supported.", `${param}.name`);
    if (item.refusal != null || (item.tool_calls != null && (!Array.isArray(item.tool_calls) || item.tool_calls.length))) throw new CompatibilityError("Tool calls and refusals are not supported as input.", param);
    for (const key of ["id", "status"]) if (item[key] != null && typeof item[key] !== "string") throw new CompatibilityError("Expected a string.", `${param}.${key}`);
    return { role: item.role === "developer" ? "system" : item.role as ConversationMessage["role"], content: text(item.content, `${param}.content`, protocol === "chat" ? ["text"] : item.role === "assistant" ? ["output_text", "input_text"] : ["input_text"]) };
  });
  if (messages.at(-1)?.role !== "user" || !messages.at(-1)!.content.trim()) throw new CompatibilityError("The final message must be a non-empty user message.", protocol === "chat" ? "messages" : "input");
  if (messages.reduce((total, item) => total + item.content.length, (body.instructions as string | undefined)?.length ?? 0) > 100_000) throw new CompatibilityError("Conversation exceeds 100,000 characters.", protocol === "chat" ? "messages" : "input", 413);
  return { profile: body.model, messages, stream: body.stream === true, includeUsage, metadata, instructions: body.instructions as string ?? null };
}

export function chatUsage(usage: TokenUsage) {
  return { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output, prompt_tokens_details: { cached_tokens: usage.cached }, completion_tokens_details: { reasoning_tokens: usage.reasoning } };
}
export function responseUsage(usage: TokenUsage) {
  return { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output, input_tokens_details: { cached_tokens: usage.cached }, output_tokens_details: { reasoning_tokens: usage.reasoning } };
}
export function outputMessage(id: string, text: string, status = "completed") {
  return { id, type: "message", role: "assistant", status, content: [{ type: "output_text", text, annotations: [], logprobs: [] }] };
}
export function responseObject(request: CompletionRequest, id: string, created: number, output: unknown[], result?: CompletionResult) {
  return { id, object: "response", created_at: created, completed_at: result ? Math.floor(Date.now() / 1000) : null, status: result ? result.finishReason === "length" ? "incomplete" : "completed" : "in_progress", error: null, incomplete_details: result?.finishReason === "length" ? { reason: "max_output_tokens" } : null, instructions: request.instructions, model: request.profile, output, parallel_tool_calls: false, tool_choice: "auto", tools: [], text: { format: { type: "text" } }, temperature: null, top_p: null, max_output_tokens: null, previous_response_id: null, reasoning: { effort: null, summary: null }, store: false, background: false, truncation: "disabled", metadata: request.metadata ?? {}, usage: result ? responseUsage(result.usage) : null };
}
