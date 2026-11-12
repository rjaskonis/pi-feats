import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import Fastify from "fastify";
import { registerCompatibilityRoutes } from "../extensions/api-server/openai-routes.ts";
import { normalizeRequest, type CompletionRequest } from "../extensions/api-server/openai-contract.ts";
import { decodeAttachment, downloadAttachment, extractDocument, isPublicAttachmentAddress, prepareAttachments, validateImage } from "../extensions/api-server/openai-attachments.ts";
import { executeSession, restoreHistory } from "../extensions/api-server/openai-execution.ts";
import { dataUrl, pdfFixture, pngDataUrl, tinyPng, xlsxFixture, zipFixture } from "./fixtures/openai-attachments.ts";
import { OPENAI_ATTACHMENT_BYTES, OPENAI_ATTACHMENT_COUNT } from "../extensions/lib/openai-limits.ts";

function request(parts: unknown[], protocol: "chat" | "responses" = "responses"): CompletionRequest {
  return normalizeRequest({ model: "support", [protocol === "chat" ? "messages" : "input"]: [{ role: "user", content: parts }] }, protocol);
}
const image = { type: "input_image", image_url: pngDataUrl, detail: "auto" };
const signal = () => new AbortController().signal;
const documentDependencies = spawnSync("python3", ["--version"]).status === 0 && spawnSync("pdftotext", ["-v"]).status === 0;
const documentTestOptions = { skip: documentDependencies ? false : "Document fixtures require Python 3 and Poppler; no dependencies are installed automatically." };

for (const protocol of ["chat", "responses"] as const) {
  test(`${protocol}: images and file attachments are preserved, including attachment-only input`, async () => {
    const images = protocol === "chat" ? [{ type: "image_url", image_url: { url: pngDataUrl, detail: "high" } }] : [image];
    const normalized = request(images, protocol);
    assert.equal(normalized.messages[0].content, ""); assert.equal(normalized.messages[0].attachments?.length, 1);
    const prepared = await prepareAttachments(normalized, signal());
    assert.deepEqual(prepared.messages[0].images, [{ type: "image", data: tinyPng.toString("base64"), mimeType: "image/png" }]);
    assert.equal(prepared.messages[0].attachments, undefined);
    const raw = Buffer.from("CSV fixture\nProduct,Total\nWidget,42\n").toString("base64");
    const file = { file_data: raw, filename: "sales.csv" };
    const withFile = request(protocol === "chat" ? [{ type: "file", file }] : [{ type: "input_file", ...file }], protocol);
    const result = await prepareAttachments(withFile, signal());
    assert.match(result.messages[0].content, /Attached document: sales.csv/); assert.match(result.messages[0].content, /Widget,42/);
  });
}

test("both HTTP protocols accept image payloads above the old 1 MiB body cap without special headers", async (t) => {
  const server = Fastify(); let calls = 0;
  registerCompatibilityRoutes(server, {
    authorized: (value) => value === "Bearer attachment-test", profiles: async () => [{ name: "support" }], validateProfile: async () => {},
    execute: async (request, emit) => {
      calls++; assert.equal(request.messages[0].attachments?.[0].kind, "image");
      assert.ok(request.messages[0].attachments![0].source.length > 1_048_576);
      await emit({ type: "ready" }); await emit({ type: "text", delta: "Seen" });
      return { text: "Seen", finishReason: "stop", usage: { input: 1, output: 1, cached: 0, reasoning: 0 } };
    },
  });
  t.after(() => server.close());
  const source = dataUrl("image/png", Buffer.concat([tinyPng, Buffer.alloc(1_100_000)]));
  for (const protocol of ["chat", "responses"] as const) for (const stream of [false, true]) {
    const payload = protocol === "chat" ? { model: "support", stream, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: source } }] }] } : { model: "support", stream, input: [{ role: "user", content: [{ type: "input_image", image_url: source }] }] };
    const response = await server.inject({ method: "POST", url: protocol === "chat" ? "/v1/chat/completions" : "/v1/responses", headers: { authorization: "Bearer attachment-test" }, payload });
    assert.equal(response.statusCode, 200); assert.ok(response.body.includes("Seen"));
  }
  const denied = await server.inject({ method: "POST", url: "/v1/responses", payload: { model: "support", input: [{ role: "user", content: [{ type: "input_image", image_url: source }] }] } });
  assert.equal(denied.statusCode, 401); assert.equal(calls, 4);
});

test("history images are native messages, final images reach prompt, and profile vision capability is enforced", async () => {
  const normalized = normalizeRequest({ model: "support", input: [{ role: "user", content: [image] }, { role: "assistant", content: "An image" }, { role: "user", content: [image] }] }, "responses");
  const prepared = await prepareAttachments(normalized, signal());
  const entries: any[] = []; restoreHistory({ appendMessage: (value) => { entries.push(value); return "id"; } }, prepared);
  assert.equal(entries[0].role, "user"); assert.equal(entries[0].content[1].type, "image"); assert.equal(entries[0].content[1].data, tinyPng.toString("base64"));
  for (const vision of [false, true]) {
    let listener: (event: any) => void = () => {}, disposed = false, prompt: any;
    const session = {
      model: { input: vision ? ["text", "image"] : ["text"] },
      subscribe: (callback: any) => { listener = callback; return () => {}; },
      prompt: async (text: string, options: any) => { prompt = { text, options }; listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Seen" }] } }); },
      waitForIdle: async () => {}, abort: async () => {}, dispose: () => { disposed = true; },
    };
    const events: any[] = [];
    const running = executeSession(session as any, prepared, (event) => events.push(event), signal());
    if (vision) { assert.equal((await running).text, "Seen"); assert.equal(prompt.text, ""); assert.deepEqual(prompt.options.images, prepared.messages[2].images); }
    else { await assert.rejects(running, (error: any) => error.status === 400 && error.code === "unsupported_image_model"); assert.equal(prompt, undefined); assert.deepEqual(events, []); }
    assert.ok(disposed);
  }
});

test("PDF, XLSX, DOCX and PPTX extract real content without executing formulas or external relationships", documentTestOptions, async () => {
  const pdf = await extractDocument(pdfFixture(), "application/pdf", "invoice.pdf", "input", signal());
  assert.match(pdf, /Fixture PDF invoice total 42/);
  const xlsx = await extractDocument(xlsxFixture(), "application/octet-stream", "sales.xlsx", "input", signal());
  assert.match(xlsx, /Sheet: Sales/); assert.match(xlsx, /A1="Revenue"/); assert.match(xlsx, /B1="42"/); assert.match(xlsx, /=B1\*2 \[cached value: 84\]/); assert.match(xlsx, /Fixture spreadsheet/);
  const docx = zipFixture({ "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Fixture contract</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table total 42</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' });
  assert.match(await extractDocument(docx, "application/octet-stream", "contract.docx", "input", signal()), /Fixture contract\nTable total 42/);
  const pptx = zipFixture({ "ppt/presentation.xml": '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>', "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>', "ppt/slides/slide1.xml": '<slide><t>Fixture presentation</t></slide>' });
  assert.match(await extractDocument(pptx, "application/octet-stream", "slides.pptx", "input", signal()), /Slide 1\nFixture presentation/);
  const combined = await prepareAttachments(request([{ type: "input_text", text: "Summarize" }, { type: "input_file", file_data: dataUrl("application/pdf", pdfFixture()), filename: "invoice.pdf" }, image, { type: "input_file", file_data: xlsxFixture().toString("base64"), filename: "sales.xlsx" }]), signal());
  assert.equal(combined.messages[0].images?.length, 1); assert.match(combined.messages[0].content, /invoice total 42/); assert.match(combined.messages[0].content, /Fixture spreadsheet/);
});

test("bad documents, scans, XML entities, ZIP traversal and expanded archives fail with safe errors", documentTestOptions, async () => {
  for (const [bytes, mimeType, filename, code] of [
    [pdfFixture(""), "application/pdf", "scan.pdf", "document_text_missing"],
    [Buffer.from("not a PDF"), "application/pdf", "invoice.pdf", "invalid_attachment"],
    [Buffer.from("binary\0data"), "text/plain", "sample.txt", "invalid_attachment"],
    [Buffer.from("\u00ff", "latin1"), "text/plain", "sample.txt", "invalid_attachment"],
    [zipFixture({ "word/document.xml": '<!DOCTYPE test [<!ENTITY x "secret">]><document>&x;</document>' }), "application/zip", "doc.docx", "document_extraction_failed"],
    [zipFixture({ "../secret": "not extracted", "word/document.xml": "<document/>" }), "application/zip", "doc.docx", "document_extraction_failed"],
    [zipFixture({ "word/document.xml": "x".repeat(OPENAI_ATTACHMENT_BYTES + 1) }), "application/zip", "doc.docx", "document_extraction_failed"],
    [Buffer.from("x".repeat(100_001)), "text/plain", "sample.txt", "context_too_large"],
  ] as const) await assert.rejects(extractDocument(bytes, mimeType, filename, "input", signal()), (error: any) => error.code === code && !error.message.includes("secret"));
});

test("base64, attachment counts, dimensions, filenames, actual types and stored IDs remain validated", () => {
  assert.throws(() => decodeAttachment("data:image/png;base64,!!!!", "input"));
  assert.throws(() => validateImage(tinyPng, "image/jpeg", "input"));
  assert.throws(() => validateImage(Buffer.from([255, 216, ...Array(20).fill(255)]), "image/jpeg", "input"), (error: any) => error.code === "invalid_attachment");
  const huge = Buffer.from(tinyPng); huge.writeUInt32BE(100_000, 16);
  assert.throws(() => validateImage(huge, "image/png", "input"), (error: any) => error.code === "attachment_too_large");
  assert.throws(() => request(Array(OPENAI_ATTACHMENT_COUNT + 1).fill(image)), (error: any) => error.code === "attachment_too_large");
  assert.throws(() => request([{ type: "input_file", file_data: "YQ==", filename: "../secret.txt" }]));
  assert.throws(() => request([{ type: "input_file", file_data: "YQ==", file_url: "https://example.com/test.txt" }]));
  assert.throws(() => request([{ type: "input_file", file_id: "file_stored" }]), (error: any) => error.code === "unsupported_file_reference");
  assert.throws(() => normalizeRequest({ model: "support", input: [{ role: "system", content: [image] }, { role: "user", content: "Hi" }] }, "responses"));
  const controller = new AbortController(); controller.abort();
  return assert.rejects(prepareAttachments(request([image]), controller.signal), (error: any) => error.name === "AbortError");
});

test("missing document runtime dependencies and oversized extracted context return explicit errors", async () => {
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try { await assert.rejects(extractDocument(pdfFixture(), "application/pdf", "invoice.pdf", "input", signal()), (error: any) => error.code === "document_extractor_unavailable" && error.status === 503); }
  finally { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; }
  const file = { type: "input_file", filename: "large.txt", file_data: Buffer.from("x".repeat(60_000)).toString("base64") };
  await assert.rejects(prepareAttachments(request([file, file]), signal()), (error: any) => error.status === 413 && error.code === "context_too_large");
});

test("aggregate decoded attachment bytes are bounded even when individual files fit", () => {
  const padded = dataUrl("image/png", Buffer.concat([tinyPng, Buffer.alloc(8 * 1024 * 1024 - tinyPng.length)]));
  assert.throws(() => request(Array(3).fill({ type: "input_image", image_url: padded })), (error: any) => error.status === 413 && error.code === "attachment_too_large");
});

test("private, loopback, metadata, mapped IPv6, credentials and non-HTTPS attachment URLs are blocked", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.1.3", "192.168.1.1", "169.254.169.254", "100.100.100.200", "0.0.0.0", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2002:7f00:1::", "2001:db8::1"]) assert.equal(isPublicAttachmentAddress(address), false, address);
  assert.ok(isPublicAttachmentAddress("8.8.8.8")); assert.ok(isPublicAttachmentAddress("2606:4700:4700::1111"));
  for (const url of ["http://example.com/a.png", "https://user:password@example.com/a.png", "https://127.1/a.png", "https://example.com:444/a.png", "file:///etc/passwd", "/api/v1/files/private/content"]) assert.throws(() => request([{ type: "input_image", image_url: url }]), (error: any) => error.code === "attachment_url_blocked");
  let connected = false;
  await assert.rejects(downloadAttachment("https://example.com/image", "input", signal(), { lookup: async () => [{ address: "127.0.0.1", family: 4 }], get: () => { connected = true; } } as any), (error: any) => error.code === "attachment_url_blocked");
  assert.equal(connected, false);
});

test("public downloads pin DNS, forward no credentials, reject redirects and bound response data", async () => {
  for (const mode of ["success", "redirect", "too-large"] as const) {
    const network = {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      get: (_url: URL, options: any, callback: (response: any) => void) => {
        assert.deepEqual(options.headers, { "accept-encoding": "identity" }); assert.equal(options.agent, false);
        options.lookup("example.com", { all: true }, (error: unknown, addresses: unknown) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]); });
        const handle = new EventEmitter();
        queueMicrotask(() => {
          const response = Object.assign(new PassThrough(), { statusCode: mode === "redirect" ? 302 : 200, headers: { "content-type": "image/png", ...(mode === "too-large" ? { "content-length": String(OPENAI_ATTACHMENT_BYTES + 1) } : {}) }, complete: true });
          callback(response); if (mode === "success") response.end(tinyPng);
        });
        return handle;
      },
    };
    const downloading = downloadAttachment("https://example.com/image", "input", signal(), network as any);
    if (mode === "success") assert.deepEqual((await downloading).bytes, tinyPng);
    else await assert.rejects(downloading, (error: any) => error.code === (mode === "redirect" ? "attachment_download_failed" : "attachment_too_large"));
  }
});
