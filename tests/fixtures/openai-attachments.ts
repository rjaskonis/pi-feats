import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";

export const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC", "base64");
export const pngDataUrl = `data:image/png;base64,${tinyPng.toString("base64")}`;
export const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`;

/** Valid standalone PDF with a real text layer, without test-only PDF packages. */
export function pdfFixture(text = "Fixture PDF invoice total 42"): Buffer {
  const stream = text ? `BT /F1 12 Tf 30 100 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET` : "";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

/** Image-only PDF: three red circles and two blue squares, with no text layer. */
export function visualPdfFixture(): Buffer {
  const width = 240, height = 150;
  const pixels = Buffer.alloc(width * height * 3, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const circle = [40, 110, 180].some((cx) => (x - cx) ** 2 + (y - 40) ** 2 <= 18 ** 2);
    const square = y >= 90 && y < 125 && ((x >= 25 && x < 60) || (x >= 95 && x < 130));
    if (circle || square) { const offset = (y * width + x) * 3; pixels[offset] = circle ? 230 : 0; pixels[offset + 1] = 0; pixels[offset + 2] = square ? 230 : 0; }
  }
  const image = deflateSync(pixels);
  const content = Buffer.from("q 240 0 0 150 0 0 cm /Im0 Do Q");
  const objects = [Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"), Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"), Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 150] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>"), Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from("\nendstream")]), Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")])];
  const chunks = [Buffer.from("%PDF-1.4\n")], offsets: number[] = [];
  let size = chunks[0].length;
  objects.forEach((object, i) => { offsets.push(size); const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]); chunks.push(chunk); size += chunk.length; });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

export function docxFixture(text = "Verification token: DOCX_NATIVE_59173"): Buffer {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return zipFixture({
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${escaped}</w:t></w:r></w:p></w:body></w:document>`,
  });
}

export function zipFixture(entries: Record<string, string>): Buffer {
  return execFileSync("python3", ["-I", "-c", "import sys,json,zipfile,io; b=io.BytesIO(); z=zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED); [z.writestr(k,v) for k,v in json.load(sys.stdin).items()]; z.close(); sys.stdout.buffer.write(b.getvalue())"], { input: JSON.stringify(entries), maxBuffer: 16 * 1024 * 1024 });
}
export function xlsxFixture(verificationToken?: string): Buffer {
  return zipFixture({
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>',
    "xl/sharedStrings.xml": '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Revenue</t></si></sst>',
    "xl/worksheets/sheet1.xml": verificationToken
      ? `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Verification</t></is></c><c r="B2" t="inlineStr"><is><t>${verificationToken.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></is></c></row></sheetData></worksheet>`
      : '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c><c r="C1"><f>B1*2</f><v>84</v></c><c r="D1" t="inlineStr"><is><t>Fixture spreadsheet</t></is></c></row></sheetData></worksheet>',
  });
}
