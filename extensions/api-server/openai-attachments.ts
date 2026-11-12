/** Bounded attachment transport and preparation inside the selected profile worker. */
import { lookup } from "node:dns/promises";
import { get } from "node:https";
import { BlockList, isIP } from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CompatibilityError, attachmentError } from "./openai-errors.ts";
import { OPENAI_ATTACHMENT_BYTES, OPENAI_ATTACHMENT_TOTAL_BYTES, OPENAI_ATTACHMENT_COUNT, OPENAI_TEXT_CHARACTERS } from "../lib/openai-limits.ts";
import type { CompletionRequest } from "./openai-contract.ts";

export type InputAttachment = { kind: "image" | "file"; source: string; filename?: string; param: string };
export type InputImage = { type: "image"; data: string; mimeType: string };
export type AttachmentBudget = { count: number; bytes: number };
const officeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const mimeByExtension: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", xlsx: [...officeTypes][0], docx: [...officeTypes][1], pptx: [...officeTypes][2], txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", xml: "application/xml" };

function charge(budget: AttachmentBudget, bytes: number, param: string): void {
  if (bytes > OPENAI_ATTACHMENT_BYTES || (budget.bytes += bytes) > OPENAI_ATTACHMENT_TOTAL_BYTES) throw attachmentError("attachment_too_large", param);
}

export function decodeAttachment(source: string, param: string): { bytes: Buffer; mimeType: string } {
  const match = /^data:([a-z0-9.+/-]+);base64,([\s\S]*)$/i.exec(source);
  if (!match) throw attachmentError("invalid_attachment", param);
  const encoded = match[2];
  if (encoded.length > Math.ceil(OPENAI_ATTACHMENT_BYTES / 3) * 4) throw attachmentError("attachment_too_large", param);
  if (!encoded || !/^[a-z0-9+/]*={0,2}$/i.test(encoded) || encoded.length % 4 === 1) throw attachmentError("invalid_attachment", param);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) throw attachmentError("invalid_attachment", param);
  if (bytes.length > OPENAI_ATTACHMENT_BYTES) throw attachmentError("attachment_too_large", param);
  return { bytes, mimeType: match[1].toLowerCase() };
}

const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList(); globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) blocked.addSubnet(address, prefix, "ipv6");

export function isPublicAttachmentAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4") : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export function attachmentUrl(source: string, param: string): URL {
  let url: URL;
  try { url = new URL(source); } catch { throw attachmentError("attachment_url_blocked", param); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (source.length > 8192 || url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || (isIP(hostname) && !isPublicAttachmentAddress(hostname))) throw attachmentError("attachment_url_blocked", param);
  return url;
}

/** Keep only attachment sources, not arbitrary client content fields. */
export function normalizeAttachment(kind: "image" | "file", source: unknown, filename: unknown, param: string, budget: AttachmentBudget): InputAttachment {
  if (typeof source !== "string" || !source) throw attachmentError("invalid_attachment", param);
  if (++budget.count > OPENAI_ATTACHMENT_COUNT) throw attachmentError("attachment_too_large", param);
  if (filename != null && (typeof filename !== "string" || !filename || filename.length > 200 || /[\x00-\x1f\x7f/\\]/.test(filename))) throw attachmentError("invalid_attachment", param);
  if (!source.startsWith("data:") && !/^https:/i.test(source) && kind === "file") {
    const extension = typeof filename === "string" ? filename.split(".").at(-1)!.toLowerCase() : "";
    source = `data:${mimeByExtension[extension] ?? "application/octet-stream"};base64,${source}`;
  }
  if ((source as string).startsWith("data:")) {
    const decoded = decodeAttachment(source as string, param);
    charge(budget, decoded.bytes.length, param);
    if (kind === "image") validateImage(decoded.bytes, decoded.mimeType, param);
  } else attachmentUrl(source as string, param);
  return { kind, source: source as string, ...(filename ? { filename: filename as string } : {}), param };
}

function hasImageSignature(bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.subarray(0, 2).equals(Buffer.from([255, 216]))
    || /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))
    || (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
}

/** Signature/dimension checks run before any provider or native image decoder. */
export function validateImage(bytes: Buffer, declaredType: string, param: string): string {
  let mimeType = "", width = 0, height = 0;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR") {
    mimeType = "image/png"; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) {
    mimeType = "image/gif"; width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    mimeType = "image/jpeg";
    for (let offset = 2; offset + 4 < bytes.length;) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 7) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break; }
      offset += size;
    }
  } else if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    mimeType = "image/webp";
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X") { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (chunk === "VP8 " && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
    else if (chunk === "VP8L" && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
  }
  if (!mimeType || !width || !height || (declaredType.startsWith("image/") && declaredType !== mimeType && !(declaredType === "image/jpg" && mimeType === "image/jpeg"))) throw attachmentError("invalid_attachment", param);
  if (width > 16_384 || height > 16_384 || width * height > 40_000_000) throw attachmentError("attachment_too_large", param);
  return mimeType;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((result) => { signal.removeEventListener("abort", abort); resolve(result); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

/** DNS is checked once and pinned for the connection; redirects and ambient credentials are never used. */
export async function downloadAttachment(source: string, param: string, signal: AbortSignal, network = { lookup, get }): Promise<{ bytes: Buffer; mimeType: string }> {
  signal.throwIfAborted();
  const url = attachmentUrl(source, param);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  try {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable(network.lookup(hostname, { all: true, verbatim: true }), timeout);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAttachmentAddress(address))) throw attachmentError("attachment_url_blocked", param);
    const pinned = addresses[0];
    timeout.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const request = network.get(url, {
        signal: timeout, agent: false,
        lookup: ((_host: string, options: { all?: boolean }, callback: (...args: any[]) => void) => options.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family)) as any,
        headers: { "accept-encoding": "identity" },
      }, (response) => {
        response.on("error", reject);
        response.once("aborted", () => reject(attachmentError("attachment_download_failed", param)));
        response.once("close", () => { if (!response.complete) reject(attachmentError("attachment_download_failed", param)); });
        if (response.statusCode !== 200 || (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) { response.destroy(); reject(attachmentError("attachment_download_failed", param)); return; }
        if (Number(response.headers["content-length"] ?? 0) > OPENAI_ATTACHMENT_BYTES) { response.destroy(); reject(attachmentError("attachment_too_large", param)); return; }
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > OPENAI_ATTACHMENT_BYTES) { response.destroy(); reject(attachmentError("attachment_too_large", param)); }
          else chunks.push(chunk);
        });
        response.on("end", () => response.complete ? resolve({ bytes: Buffer.concat(chunks), mimeType: String(response.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim().toLowerCase() }) : reject(attachmentError("attachment_download_failed", param)));
      });
      request.on("error", reject);
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error && typeof error === "object" && "code" in error && ["attachment_url_blocked", "attachment_too_large", "attachment_download_failed"].includes(String(error.code))) throw error;
    throw attachmentError("attachment_download_failed", param);
  }
}

export async function extractDocument(bytes: Buffer, mimeType: string, filename: string | undefined, param: string, signal: AbortSignal): Promise<string> {
  let kind: string;
  if (bytes.subarray(0, 5).toString() === "%PDF-") kind = "pdf";
  else if (bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) kind = "office";
  else {
    const extensionType = mimeByExtension[filename?.split(".").at(-1)?.toLowerCase() ?? ""];
    if (mimeType === "application/pdf" || officeTypes.has(mimeType) || (extensionType && (extensionType === "application/pdf" || officeTypes.has(extensionType)))) throw attachmentError("invalid_attachment", param);
    if (!(mimeType.startsWith("text/") || ["application/json", "application/xml"].includes(mimeType) || extensionType?.startsWith("text/") || ["application/json", "application/xml"].includes(extensionType ?? ""))) throw attachmentError("unsupported_file_type", param);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) throw new Error("Binary content");
      if (text.length > OPENAI_TEXT_CHARACTERS) throw attachmentError("context_too_large", param);
      if (!text.trim()) throw attachmentError("document_text_missing", param);
      return text;
    } catch (error) { if (error instanceof CompatibilityError) throw error; throw attachmentError("invalid_attachment", param); }
  }
  signal.throwIfAborted();
  const python = process.platform === "linux" && existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
  const child = spawn(python, ["-I", fileURLToPath(new URL("./openai-document-extractor.py", import.meta.url)), kind], { stdio: ["pipe", "pipe", "pipe"], signal });
  const timer = setTimeout(() => child.kill("SIGKILL"), 25_000); timer.unref();
  let output = "", outputBytes = 0;
  child.stdout.setEncoding("utf8"); child.stderr.resume(); child.stdin.on("error", () => {});
  child.stdin.end(bytes);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(attachmentError("document_extractor_unavailable", param)));
      child.stdout.on("data", (chunk: string) => { outputBytes += Buffer.byteLength(chunk); if (outputBytes > 512_000) child.kill("SIGKILL"); else output += chunk; });
      child.once("close", (code) => code === 0 ? resolve() : reject(attachmentError("document_extraction_failed", param)));
    });
    const result = JSON.parse(output);
    if (result.error) throw attachmentError(["document_extractor_unavailable", "document_text_missing", "context_too_large", "unsupported_file_type"].includes(result.error) ? result.error : "document_extraction_failed", param);
    if (typeof result.text !== "string" || !result.text.trim()) throw attachmentError("document_text_missing", param);
    if (result.text.length > OPENAI_TEXT_CHARACTERS) throw attachmentError("context_too_large", param);
    return result.text;
  } catch (error) { signal.throwIfAborted(); if (error instanceof CompatibilityError) throw error; throw attachmentError("document_extraction_failed", param); }
  finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}

/** Sources never become local paths or tool calls; native images and extracted text stay request-scoped. */
export async function prepareAttachments(request: CompletionRequest, signal: AbortSignal): Promise<CompletionRequest> {
  const messages: CompletionRequest["messages"] = [];
  const budget: AttachmentBudget = { count: 0, bytes: 0 };
  let characters = request.instructions?.length ?? 0;
  for (const message of request.messages) {
    let content = message.content;
    const images: InputImage[] = [];
    for (const attachment of message.attachments ?? []) {
      signal.throwIfAborted();
      if (++budget.count > OPENAI_ATTACHMENT_COUNT) throw attachmentError("attachment_too_large", attachment.param);
      const { bytes, mimeType } = attachment.source.startsWith("data:") ? decodeAttachment(attachment.source, attachment.param) : await downloadAttachment(attachment.source, attachment.param, signal);
      charge(budget, bytes.length, attachment.param);
      if (attachment.kind === "image" || mimeType.startsWith("image/") || hasImageSignature(bytes)) images.push({ type: "image", data: bytes.toString("base64"), mimeType: validateImage(bytes, mimeType, attachment.param) });
      else {
        const text = await extractDocument(bytes, mimeType, attachment.filename, attachment.param, signal);
        content += `\n\n[Attached document: ${attachment.filename ?? "document"}]\n${text}\n[End attached document]`;
      }
    }
    characters += content.length;
    if (characters > OPENAI_TEXT_CHARACTERS) throw attachmentError("context_too_large");
    const { attachments: _sources, ...rest } = message;
    messages.push({ ...rest, content, ...(images.length ? { images } : {}) });
  }
  signal.throwIfAborted();
  return { ...request, messages };
}
