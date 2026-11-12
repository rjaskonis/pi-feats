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
  return { error: { message: known ? error.message : "Pi execution failed.", type: known && error.status < 500 ? (error.status === 401 ? "authentication_error" : "invalid_request_error") : "server_error", param: known ? error.param : null, code: known ? error.code : "server_error" } };
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
