/** Opt-in client function contracts. Legacy requests never enter this parser. */
import { createHash } from "node:crypto";
import { CompatibilityError, normalizeRequest, type CompletionRequest, type ConversationMessage, type TokenUsage } from "./openai-contract.ts";
import { normalizeAttachment, type InputAttachment, type AttachmentBudget } from "./openai-attachments.ts";
import { OPENAI_TEXT_CHARACTERS } from "../lib/openai-limits.ts";

export const CLIENT_PREFIX = "client__";
export const CLIENT_LIMITS = { workers: 4, perProfile: 2, tools: 16, rawTools: 128, schemaBytes: 262144, argumentBytes: 65536, outputBytes: 16 * 1024 * 1024 } as const;
export type ClientToolPolicy = { enabled: boolean; allowedTools: string[]; timeoutMs: number; maxCalls: number };
export type ClientTool = { type: "function"; name: string; description: string; parameters: Record<string, unknown>; strict?: boolean };
export type ClientCall = { type: "function_call"; id: string; call_id: string; name: string; arguments: string; status: "completed" };
export type ClientOutput = { call_id: string; text: string; attachments: InputAttachment[]; failed: boolean };
export type ClientInput = { kind: "message"; index: number } | { kind: "call"; call: ClientCall } | { kind: "result"; output: ClientOutput };
export type ClientRequest = { request: CompletionRequest; tools: ClientTool[]; toolsSupplied: boolean; input: ClientInput[]; outputs: ClientOutput[] };
export type ClientLeg = { text: string; calls: ClientCall[]; tools?: ClientTool[]; usage: TokenUsage; finishReason: "stop" | "length"; pending: boolean };
export const clientError = (code: string, message: string, status = 400, param: string | null = null) => new CompatibilityError(message, param, status, code);
const namePattern = /^[A-Za-z_][A-Za-z0-9_-]{0,55}$/;
const idPattern = /^[A-Za-z0-9_:.|/-]{1,256}$/;
export function object(value: unknown, param: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw clientError("invalid_client_tools", "Expected an object.", 400, param);
  return value as Record<string, any>;
}
export function clientToolPolicy(settings: unknown): ClientToolPolicy {
  const raw = (settings as any)?.profile?.clientTools;
  const defaults = { enabled: false, allowedTools: [], timeoutMs: 120_000, maxCalls: 16 };
  if (raw === undefined) return defaults;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw.enabled !== undefined && typeof raw.enabled !== "boolean") || (raw.allowedTools !== undefined && (!Array.isArray(raw.allowedTools) || raw.allowedTools.length > CLIENT_LIMITS.tools || raw.allowedTools.some((name: unknown) => typeof name !== "string" || !namePattern.test(name) || name.startsWith(CLIENT_PREFIX))))) throw clientError("client_tools_policy_invalid", "The profile client-tool policy is invalid.", 502);
  const timeoutMs = raw.timeoutMs ?? defaults.timeoutMs, maxCalls = raw.maxCalls ?? defaults.maxCalls;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 300_000 || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 32) throw clientError("client_tools_policy_invalid", "The profile client-tool limits are invalid.", 502);
  return { enabled: raw.enabled === true, allowedTools: [...new Set<string>(raw.allowedTools ?? [])], timeoutMs, maxCalls };
}
export const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)).digest("hex");
export const clientOutputFingerprint = (output: ClientOutput): string => fingerprint({ call_id: output.call_id, text: output.text, failed: output.failed, attachments: output.attachments.map(({ kind, source, filename, detail }) => ({ kind, source, filename, detail })) });
export const policyFingerprint = (policy: ClientToolPolicy): string => fingerprint({ ...policy, allowedTools: [...policy.allowedTools].sort() });

function validateSchema(value: unknown, depth = 0, nodes = { count: 0 }): void {
  if (depth > 24 || ++nodes.count > 8192) throw clientError("client_tool_schema_limit", "Client tool schema exceeds complexity limits.");
  if (Array.isArray(value)) { for (const item of value) validateSchema(item, depth + 1, nodes); }
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw clientError("invalid_client_tool_schema", "Unsafe schema property.");
    if (key === "$ref" && (typeof item !== "string" || !item.startsWith("#/"))) throw clientError("invalid_client_tool_schema", "Only local JSON Schema references are supported.");
    validateSchema(item, depth + 1, nodes);
  }
}
export function validateClientArguments(value: unknown, depth = 0, nodes = { count: 0 }): void {
  if (depth > 24 || ++nodes.count > 8192) throw clientError("invalid_client_call", "Client function arguments exceed complexity limits.");
  if (Array.isArray(value)) for (const item of value) validateClientArguments(item, depth + 1, nodes);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw clientError("invalid_client_call", "Unsafe argument property.");
    validateClientArguments(item, depth + 1, nodes);
  }
}
export function acceptedClientTools(value: unknown, policy: ClientToolPolicy): ClientTool[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > CLIENT_LIMITS.rawTools) throw clientError("invalid_client_tools", "Expected at most 128 tool definitions.", 400, "tools");
  const tools: ClientTool[] = []; let bytes = 0;
  for (const raw of value) {
    const item = object(raw, "tools");
    if (item.type !== "function") continue;
    const source = item.function ? object(item.function, "tools.function") : item;
    if (!policy.allowedTools.includes(source.name)) continue;
    if (tools.some((tool) => tool.name === source.name)) throw clientError("invalid_client_tools", "Duplicate client tool name.");
    if (!namePattern.test(source.name) || source.name.startsWith(CLIENT_PREFIX) || (source.description != null && (typeof source.description !== "string" || source.description.length > 8192)) || (source.strict != null && typeof source.strict !== "boolean")) throw clientError("invalid_client_tools", "Invalid client function definition.");
    const parameters = object(source.parameters ?? { type: "object", properties: {} }, "tools.parameters");
    if (parameters.type !== "object") throw clientError("invalid_client_tool_schema", "Client tool parameters must be an object schema.");
    bytes += Buffer.byteLength(JSON.stringify(parameters)) + Buffer.byteLength(source.description ?? "");
    if (bytes > CLIENT_LIMITS.schemaBytes) throw clientError("client_tool_schema_limit", "Client tool definitions exceed the size limit.");
    validateSchema(parameters);
    tools.push({ type: "function", name: source.name, description: source.description ?? "", parameters, ...(source.strict == null ? {} : { strict: source.strict }) });
  }
  if (tools.length > CLIENT_LIMITS.tools) throw clientError("client_tool_schema_limit", "Too many approved client tools.");
  return tools;
}

export function normalizeClientRequest(value: unknown, policy: ClientToolPolicy): ClientRequest {
  const body = object(value, "body");
  const tools = acceptedClientTools(body.tools, policy);
  const raw = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) throw clientError("invalid_client_input", "Provide between 1 and 100 Responses input items.", 400, "input");
  const messages: unknown[] = [], input: ClientInput[] = [], outputs: ClientOutput[] = [];
  const calls = new Map<string, ClientCall>(), resolved = new Set<string>();
  const budget: AttachmentBudget = { count: 0, bytes: 0 }; let textBytes = 0;
  for (const [index, rawItem] of raw.entries()) {
    const item = object(rawItem, `input.${index}`);
    if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || !idPattern.test(item.call_id) || (item.id != null && (typeof item.id !== "string" || item.id.length > 256)) || !policy.allowedTools.includes(item.name) || item.name.startsWith(CLIENT_PREFIX) || typeof item.arguments !== "string" || Buffer.byteLength(item.arguments) > CLIENT_LIMITS.argumentBytes || calls.has(item.call_id)) throw clientError("invalid_client_call", "Invalid or unapproved client function call.", 400, `input.${index}`);
      let args: unknown; try { args = JSON.parse(item.arguments); } catch { throw clientError("invalid_client_call", "Function arguments must be valid JSON."); }
      object(args, `input.${index}.arguments`); validateClientArguments(args);
      const call: ClientCall = { type: "function_call", id: typeof item.id === "string" ? item.id : item.call_id, call_id: item.call_id, name: item.name, arguments: item.arguments, status: "completed" };
      calls.set(call.call_id, call); input.push({ kind: "call", call });
    } else if (item.type === "function_call_output") {
      if (typeof item.call_id !== "string" || !idPattern.test(item.call_id) || resolved.has(item.call_id) || (item.status != null && !["completed", "failed"].includes(item.status))) throw clientError("invalid_client_result", "Invalid or duplicate client tool result.", 400, `input.${index}`);
      const text: string[] = [], attachments: InputAttachment[] = [];
      if (typeof item.output === "string") text.push(item.output);
      else if (Array.isArray(item.output) && item.output.length <= 1000) for (const rawPart of item.output) {
        const part = object(rawPart, `input.${index}.output`);
        if (["input_text", "text"].includes(part.type) && typeof part.text === "string") text.push(part.text);
        else if (part.type === "input_image" && part.file_id == null) attachments.push(normalizeAttachment("image", part.image_url, undefined, `input.${index}.output`, budget));
        else throw clientError("invalid_client_result", "Unsupported client tool result content.");
      } else throw clientError("invalid_client_result", "Client tool output must be text or supported content parts.");
      const joined = text.join("\n"); textBytes += joined.length;
      if (textBytes > OPENAI_TEXT_CHARACTERS) throw clientError("client_tool_result_limit", "Client tool results exceed the context limit.", 413);
      const output = { call_id: item.call_id, text: joined, attachments, failed: item.status === "failed" };
      resolved.add(item.call_id); outputs.push(output); input.push({ kind: "result", output });
    } else { input.push({ kind: "message", index: messages.length }); messages.push(item); }
  }
  const request = normalizeRequest({ ...body, input: messages }, "responses", { allowToolTail: true, allowEmpty: true });
  for (const message of request.messages) for (const attachment of message.attachments ?? []) normalizeAttachment(attachment.kind, attachment.source, attachment.filename, attachment.param, budget);
  if (request.messages.reduce((sum, message) => sum + message.content.length, request.instructions?.length ?? 0) + textBytes > OPENAI_TEXT_CHARACTERS) throw clientError("client_tool_result_limit", "Conversation and client results exceed the context limit.", 413);
  return { request, tools, toolsSupplied: body.tools !== undefined, input, outputs };
}

export function clientHistoryOnly(input: ClientRequest): boolean { return input.input.at(-1)?.kind === "message" && input.request.messages.at(-1)?.role === "user"; }
export function ensureInitialClientRequest(input: ClientRequest): void {
  const final = input.request.messages.at(-1);
  if (!clientHistoryOnly(input) || !final || (!final.content.trim() && !final.attachments?.length)) throw clientError("client_tool_continuation_missing", "The client tool continuation is unknown or expired. Do not replay server actions automatically.", 409);
  const lastResult = input.input.reduce((last, item, index) => item.kind === "result" ? index : last, -1);
  if (lastResult >= 0 && !input.input.slice(lastResult + 1, -1).some((item) => item.kind === "message" && input.request.messages[item.index].role === "assistant" && !!input.request.messages[item.index].content.trim())) throw clientError("client_tool_continuation_missing", "The client tool continuation is unknown or expired. Server actions were not replayed.", 409);
  const calls = new Map<string, string>();
  for (const item of input.input) {
    if (item.kind === "call") calls.set(item.call.call_id, item.call.name);
    if (item.kind === "result" && !calls.has(item.output.call_id)) throw clientError("invalid_client_result", "Historical tool results require a preceding approved function call.");
  }
  for (const id of calls.keys()) if (!input.outputs.some((output) => output.call_id === id)) throw clientError("invalid_client_result", "Historical client calls must have results.");
}
export function usageDelta(total: TokenUsage, previous: TokenUsage): TokenUsage {
  const delta = {} as TokenUsage;
  for (const key of ["input", "output", "cached", "reasoning"] as const) {
    if (!Number.isFinite(total[key]) || total[key] < previous[key]) throw clientError("client_tool_usage_invalid", "The worker usage ledger is invalid.", 502);
    delta[key] = total[key] - previous[key];
  }
  return delta;
}
export const emptyClientUsage = (): TokenUsage => ({ input: 0, output: 0, cached: 0, reasoning: 0 });
export type ResumeClientMessage = { type: "resume"; outputs: ClientOutput[]; additions: ConversationMessage[] };
