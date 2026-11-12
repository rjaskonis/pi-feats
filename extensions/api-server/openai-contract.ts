/** OpenAI wire contracts with profile-owned execution settings and multimodal input. */
import { CompatibilityError, attachmentError } from "./openai-errors.ts";
import { normalizeAttachment, type InputAttachment, type InputImage, type InputDocument, type FileDetail, type AttachmentBudget } from "./openai-attachments.ts";
import { OPENAI_TEXT_CHARACTERS } from "../lib/openai-limits.ts";
export { CompatibilityError, errorBody } from "./openai-errors.ts";

export type Protocol = "chat" | "responses";
export type ConversationMessage = { role: "system" | "user" | "assistant"; content: string; attachments?: InputAttachment[]; images?: InputImage[]; documents?: InputDocument[] };
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

function record(value: unknown, param: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompatibilityError("Expected an object.", param);
  return value as Record<string, unknown>;
}
function fields(body: Record<string, unknown>, allowed: string[], prefix = "") {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new CompatibilityError("Unsupported parameter.", `${prefix}${key}`, 400, "unsupported_parameter");
}
function content(value: unknown, param: string, types: string[], allowAttachments: boolean, budget: AttachmentBudget): Pick<ConversationMessage, "content" | "attachments"> {
  if (typeof value === "string") return { content: value };
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw new CompatibilityError("Expected text or between 1 and 1,000 content parts.", param);
  const text: string[] = [], attachments: InputAttachment[] = [];
  for (const [index, part] of value.entries()) {
    const at = `${param}.${index}`, item = record(part, at);
    if (types.includes(String(item.type))) {
      fields(item, ["type", "text", "annotations", "logprobs"], `${at}.`);
      if (typeof item.text !== "string") throw new CompatibilityError("Expected a text string.", at);
      if (item.annotations !== undefined && (!Array.isArray(item.annotations) || item.annotations.length)) throw new CompatibilityError("Annotations are not supported.", `${at}.annotations`);
      if (item.logprobs !== undefined && (!Array.isArray(item.logprobs) || item.logprobs.length)) throw new CompatibilityError("Log probabilities are not supported.", `${at}.logprobs`);
      text.push(item.text); continue;
    }
    const image = item.type === "image_url" || item.type === "input_image", file = item.type === "file" || item.type === "input_file";
    if (!image && !file) throw new CompatibilityError("Unsupported content part type.", `${at}.type`);
    if (!allowAttachments) throw new CompatibilityError("Attachments are supported only in user messages.", at);
    if (image) {
      fields(item, ["type", "image_url", "detail", "file_id"], `${at}.`);
      if (item.file_id != null) throw attachmentError("unsupported_file_reference", at);
      let source = item.image_url;
      if (source && typeof source === "object") { const image = record(source, `${at}.image_url`); fields(image, ["url", "detail"], `${at}.image_url.`); source = image.url; }
      attachments.push(normalizeAttachment("image", source, undefined, at, budget));
    } else {
      fields(item, item.type === "file" ? ["type", "file"] : ["type", "file_data", "file_url", "file_id", "filename", "detail"], `${at}.`);
      const file = item.type === "file" ? record(item.file, `${at}.file`) : item;
      if (item.type === "file") fields(file, ["file_data", "file_url", "file_id", "filename", "detail"], `${at}.file.`);
      if (file.file_id != null) throw attachmentError("unsupported_file_reference", at);
      if ((file.file_data != null) === (file.file_url != null)) throw attachmentError("invalid_attachment", at);
      if (file.file_url != null && (typeof file.file_url !== "string" || !/^https:/i.test(file.file_url))) throw attachmentError("attachment_url_blocked", at);
      if (file.detail != null && !["auto", "low", "high"].includes(String(file.detail))) throw new CompatibilityError("Expected auto, low or high file detail.", `${at}.detail`);
      attachments.push({ ...normalizeAttachment("file", file.file_data ?? file.file_url, file.filename, at, budget), ...(file.detail != null ? { detail: file.detail as FileDetail } : {}) });
    }
  }
  return { content: text.join(""), ...(attachments.length ? { attachments } : {}) };
}

/** Normalize either protocol without flattening user/assistant history into a prompt. */
export function normalizeRequest(input: unknown, protocol: Protocol): CompletionRequest {
  const body = record(input, "body");
  // Only explicitly normalized fields reach the executor. Client tools,
  // generation controls and other extra options are intentionally ignored:
  // profiles own tools/model settings; execution is single-choice, plain-text,
  // synchronous and stateless regardless of client preferences.
  if (typeof body.model !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(body.model)) throw new CompatibilityError("model must identify a Pi profile.", "model");
  if (body.stream != null && typeof body.stream !== "boolean") throw new CompatibilityError("stream must be a boolean.", "stream");
  // Stored-context references cannot be discarded without losing conversation
  // history. Unlike execution preferences, they must still fail explicitly.
  for (const field of ["previous_response_id", "conversation"]) if (body[field] != null) throw new CompatibilityError("Send conversation context explicitly in messages or input instead.", field, 400, "unsupported_parameter");
  let includeUsage = false;
  if (protocol === "chat" && body.stream === true && body.stream_options != null) {
    const options = record(body.stream_options, "stream_options");
    if (options.include_usage !== undefined && typeof options.include_usage !== "boolean") throw new CompatibilityError("Expected a boolean.", "stream_options.include_usage");
    includeUsage = options.include_usage === true;
  }
  let metadata: Record<string, string> | null = null;
  if (body.metadata != null) {
    const value = record(body.metadata, "metadata");
    if (Object.keys(value).length > 16 || Object.entries(value).some(([key, item]) => key.length > 64 || typeof item !== "string" || item.length > 512)) throw new CompatibilityError("metadata supports up to 16 string values (64-character keys, 512-character values).", "metadata");
    metadata = value as Record<string, string>;
  }
  const instructions = protocol === "responses" ? body.instructions : null;
  if (instructions != null && typeof instructions !== "string") throw new CompatibilityError("instructions must be a string.", "instructions");
  const raw = protocol === "chat" ? body.messages : typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input;
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) throw new CompatibilityError("Provide between 1 and 100 messages.", protocol === "chat" ? "messages" : "input");
  const budget: AttachmentBudget = { count: 0, bytes: 0 };
  const messages = raw.map((value, index): ConversationMessage => {
    const param = `${protocol === "chat" ? "messages" : "input"}.${index}`, item = record(value, param);
    fields(item, protocol === "chat" ? ["role", "content", "name", "refusal", "tool_calls"] : ["type", "role", "content", "id", "status", "phase"], `${param}.`);
    if (protocol === "responses" && item.type !== undefined && item.type !== "message") throw new CompatibilityError("Only message input items are supported.", `${param}.type`);
    if (!["system", "developer", "user", "assistant"].includes(String(item.role))) throw new CompatibilityError("Unsupported message role.", `${param}.role`);
    if (item.name != null) throw new CompatibilityError("Named messages are not supported.", `${param}.name`);
    if (item.refusal != null || (item.tool_calls != null && (!Array.isArray(item.tool_calls) || item.tool_calls.length))) throw new CompatibilityError("Tool calls and refusals are not supported as input.", param);
    for (const key of ["id", "status", "phase"]) if (item[key] != null && typeof item[key] !== "string") throw new CompatibilityError("Expected a string.", `${param}.${key}`);
    return { role: item.role === "developer" ? "system" : item.role as ConversationMessage["role"], ...content(item.content, `${param}.content`, protocol === "chat" ? ["text"] : item.role === "assistant" ? ["output_text", "input_text"] : ["input_text"], item.role === "user", budget) };
  });
  if (messages.at(-1)?.role !== "user" || (!messages.at(-1)!.content.trim() && !messages.at(-1)!.attachments?.length)) throw new CompatibilityError("The final message must contain user text or attachments.", protocol === "chat" ? "messages" : "input");
  if (messages.reduce((total, item) => total + item.content.length, (instructions as string | undefined)?.length ?? 0) > OPENAI_TEXT_CHARACTERS) throw attachmentError("context_too_large", protocol === "chat" ? "messages" : "input");
  return { profile: body.model, messages, stream: body.stream === true, includeUsage, metadata, instructions: instructions as string ?? null };
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
