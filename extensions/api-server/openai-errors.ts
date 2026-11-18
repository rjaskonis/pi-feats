/** Only explicit safe messages may cross the compatibility API boundary. */
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
  return { error: { message: known ? error.message : "Pi execution failed.", type: known && (error.status === 401 || error.code === "provider_authentication_failed") ? "authentication_error" : known && error.code === "provider_usage_limit_exceeded" ? "rate_limit_error" : known && error.status < 500 ? "invalid_request_error" : "server_error", param: known ? error.param : null, code: known ? error.code : "server_error" } };
}

/** Fixed upstream categories, distinct from local bearer and capacity failures. */
export function providerFailure(code: unknown): CompatibilityError | undefined {
  if (code === "provider_authentication_failed") return new CompatibilityError("The profile's provider credentials are missing, invalid, or could not be refreshed. Sign in to the provider again or update the profile's API key.", null, 424, code);
  if (code === "provider_usage_limit_exceeded") return new CompatibilityError("The profile's provider usage limit has been reached. Wait for the limit to reset or review the provider's plan and quota.", null, 429, code);
  return undefined;
}

/** SDK failures may contain credentials or response bodies: classify, never forward. */
export function classifyProviderFailure(error: unknown): CompatibilityError | undefined {
  if (error instanceof CompatibilityError) return undefined;
  const details = error && typeof error === "object" ? error as { status?: unknown; statusCode?: unknown; message?: unknown; code?: unknown } : undefined;
  const message = (typeof error === "string" ? error : typeof details?.message === "string" ? details.message : "").slice(0, 65_536);
  const unauthorized = details?.status === 401 || details?.statusCode === 401
    || /^(?:Error:\s*)?(?:HTTP\s+)?401\b/i.test(message)
    || /\b(?:incorrect|invalid|missing) api key\b|\bno api key (?:found|available|provided)\b/i.test(message)
    || (/\boauth\b|\btoken refresh\b/i.test(message) && /\b401\b|\binvalid_grant\b|\brefresh_token_(?:reused|expired|invalidated)\b/i.test(message));
  if (unauthorized) return providerFailure("provider_authentication_failed");
  const quota = typeof details?.code === "string" && /^(?:usage_limit_reached|usage_not_included|insufficient_quota|quota_exceeded)$/.test(details.code)
    || /\b(?:usage_limit_reached|usage_not_included|insufficient_quota|quota_exceeded)\b/i.test(message)
    || /\b(?:usage limit|quota)\b[^\r\n]{0,40}\b(?:reached|exceeded)\b|\byou have hit your (?:chatgpt )?usage limit\b|\bexceeded (?:your )?(?:current )?quota\b/i.test(message);
  return quota ? providerFailure("provider_usage_limit_exceeded") : undefined;
}

/** Worker codes map to fixed public errors, never subprocess diagnostics. */
export const attachmentFailures: Record<string, { status: number; message: string }> = {
  invalid_attachment: { status: 400, message: "The attachment is malformed or its format does not match its content." },
  attachment_too_large: { status: 413, message: "Attachment data exceeds the supported size limits." },
  attachment_url_blocked: { status: 400, message: "Attachment URLs must use public HTTPS addresses without credentials. Embed private files as base64 instead." },
  attachment_download_failed: { status: 400, message: "The attachment could not be downloaded. Embed it as base64 instead." },
  unsupported_file_reference: { status: 400, message: "Stored file IDs are not supported. Send file_data or a public file_url instead." },
  unsupported_file_type: { status: 400, message: "Supported documents are PDF, XLSX, DOCX, PPTX and UTF-8 text files." },
  document_extraction_failed: { status: 400, message: "The document could not be read. Check its format, encryption and size." },
  document_text_missing: { status: 400, message: "The document contains no extractable text. For scanned PDFs, send page images or perform OCR first." },
  document_extractor_unavailable: { status: 503, message: "Document extraction requires Python 3; PDF extraction also requires pdftotext (Poppler) in the Pi runtime." },
  native_image_context_missing: { status: 502, message: "The native Codex request did not retain the uploaded images. No image-omitted placeholder was accepted as a successful visual request." },
  native_file_context_missing: { status: 502, message: "The native Codex request did not retain the attached files. No standalone OpenAI API or local-extraction fallback was used." },
  native_file_provider_mismatch: { status: 400, message: "Native file context requires the Codex Responses transport. The profile switched to an incompatible provider." },
  image_input_disabled: { status: 400, message: "Image input is disabled by the selected profile's settings." },
  unsupported_image_model: { status: 400, message: "The selected profile's configured model does not support image input. Select a vision-capable profile." },
  context_too_large: { status: 413, message: "Conversation text including extracted documents exceeds 100,000 characters." },
};

export function attachmentError(code: string, param: string | null = null): CompatibilityError {
  const safeCode = Object.hasOwn(attachmentFailures, code) ? code : "invalid_attachment";
  const failure = attachmentFailures[safeCode];
  return new CompatibilityError(failure.message, param, failure.status, safeCode);
}
