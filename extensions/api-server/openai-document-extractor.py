"""Isolated, bounded document-to-text extraction. No macros, formulas or links execute."""
import io
import json
import re
import subprocess
import sys
import threading
import zipfile
import xml.etree.ElementTree as ET

MAX_TEXT = 100_000
MAX_FILE = 10 * 1024 * 1024
MAX_INFLATED = 40 * 1024 * 1024
MAX_ENTRIES = 2000


class ExtractionError(Exception):
    pass


def bounded(text):
    if len(text) > MAX_TEXT:
        raise ExtractionError("context_too_large")
    return text


def office_text(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_ENTRIES or sum(item.file_size for item in entries) > MAX_INFLATED:
            raise ExtractionError("document_extraction_failed")
        names = [item.filename for item in entries]
        if len(set(names)) != len(names):
            raise ExtractionError("document_extraction_failed")
        for item in entries:
            if item.flag_bits & 1 or item.file_size > MAX_FILE or item.filename.startswith("/") or ".." in item.filename.split("/") or "\\" in item.filename:
                raise ExtractionError("document_extraction_failed")
            if (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise ExtractionError("document_extraction_failed")

        def xml(name):
            with archive.open(name) as entry:
                raw = entry.read(MAX_FILE + 1)
            if len(raw) > MAX_FILE or b"\0" in raw or re.search(br"<!\s*(DOCTYPE|ENTITY)", raw, re.I):
                raise ExtractionError("document_extraction_failed")
            return ET.fromstring(raw)

        def local(tag):
            return tag.rsplit("}", 1)[-1]

        def target(base, value):
            # Relationships may only point into the expected package directory.
            value = value.lstrip("/")
            if ".." in value.split("/") or "\\" in value or ":" in value:
                raise ExtractionError("document_extraction_failed")
            return value if value.startswith(base + "/") else base + "/" + value

        if "xl/workbook.xml" in names:
            strings = []
            if "xl/sharedStrings.xml" in names:
                for item in xml("xl/sharedStrings.xml"):
                    strings.append("".join(node.text or "" for node in item.iter() if local(node.tag) == "t"))
            relations = {item.attrib["Id"]: item.attrib.get("Target", "") for item in xml("xl/_rels/workbook.xml.rels") if item.attrib.get("TargetMode") != "External"}
            output = []
            length = 0
            for sheet in xml("xl/workbook.xml").iter():
                if local(sheet.tag) != "sheet":
                    continue
                relation = next((value for key, value in sheet.attrib.items() if local(key) == "id"), "")
                path = target("xl", relations.get(relation, ""))
                heading = "Sheet: " + sheet.attrib.get("name", "Sheet") + "\n"
                output.append(heading)
                length += len(heading)
                for row in xml(path).iter():
                    if local(row.tag) != "row":
                        continue
                    cells = []
                    for cell in row:
                        if local(cell.tag) != "c":
                            continue
                        value = next((node.text or "" for node in cell if local(node.tag) == "v"), "")
                        formula = next((node.text or "" for node in cell if local(node.tag) == "f"), "")
                        if cell.attrib.get("t") == "s":
                            value = strings[int(value)]
                        elif cell.attrib.get("t") == "inlineStr":
                            value = "".join(node.text or "" for node in cell.iter() if local(node.tag) == "t")
                        elif cell.attrib.get("t") == "b":
                            value = "TRUE" if value == "1" else "FALSE"
                        if formula:
                            value = "=" + formula + (" [cached value: " + value + "]" if value else " [no cached value]")
                        cells.append(cell.attrib.get("r", "cell") + "=" + json.dumps(value, ensure_ascii=False))
                    line = "\t".join(cells) + "\n"
                    length += len(line)
                    if length > MAX_TEXT:
                        raise ExtractionError("context_too_large")
                    output.append(line)
            return bounded("\n".join(output))
        if "word/document.xml" in names:
            output = []
            length = 0
            for paragraph in xml("word/document.xml").iter():
                if local(paragraph.tag) != "p":
                    continue
                text = "".join((node.text or "") if local(node.tag) == "t" else "\t" if local(node.tag) == "tab" else "\n" if local(node.tag) in ("br", "cr") else "" for node in paragraph.iter())
                length += len(text) + 1
                if length > MAX_TEXT:
                    raise ExtractionError("context_too_large")
                output.append(text)
            return "\n".join(output)
        if "ppt/presentation.xml" in names:
            relations = {item.attrib["Id"]: item.attrib.get("Target", "") for item in xml("ppt/_rels/presentation.xml.rels") if item.attrib.get("TargetMode") != "External"}
            output = []
            length = 0
            for slide in xml("ppt/presentation.xml").iter():
                if local(slide.tag) != "sldId":
                    continue
                relation = next((value for key, value in slide.attrib.items() if key.startswith("{") and local(key) == "id"), "")
                path = target("ppt", relations.get(relation, ""))
                text = "Slide " + str(len(output) + 1) + "\n" + "\n".join(node.text or "" for node in xml(path).iter() if local(node.tag) == "t")
                length += len(text) + 2
                if length > MAX_TEXT:
                    raise ExtractionError("context_too_large")
                output.append(text)
            return "\n\n".join(output)
        raise ExtractionError("unsupported_file_type")


def extract(data, kind):
    if kind == "office":
        return office_text(data)
    if kind == "pdf":
        try:
            process = subprocess.Popen(["pdftotext", "-layout", "-enc", "UTF-8", "-", "-"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        except FileNotFoundError:
            raise ExtractionError("document_extractor_unavailable")

        def feed():
            try:
                process.stdin.write(data)
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass

        timer = threading.Timer(20, process.kill)
        timer.daemon = True
        timer.start()
        threading.Thread(target=feed, daemon=True).start()
        try:
            output = process.stdout.read(MAX_TEXT * 4 + 1)
            if len(output) > MAX_TEXT * 4:
                raise ExtractionError("context_too_large")
            if process.wait(timeout=1):
                raise ExtractionError("document_extraction_failed")
            return bounded(output.decode("utf-8", errors="strict"))
        finally:
            timer.cancel()
            if process.poll() is None:
                process.kill()
            process.wait()
    raise ExtractionError("unsupported_file_type")


try:
    # Limits also apply to Poppler. The enclosing profile sandbox and request
    # process group remain authoritative for filesystem/network/cancellation.
    try:
        import resource
        for category, maximum in ((resource.RLIMIT_AS, 512 * 1024 * 1024), (resource.RLIMIT_CPU, 20)):
            soft, hard = resource.getrlimit(category)
            limit = min([maximum] + [value for value in (soft, hard) if value != resource.RLIM_INFINITY])
            resource.setrlimit(category, (limit, limit))
    except ImportError:
        pass
    data = sys.stdin.buffer.read(MAX_FILE + 1)
    if len(data) > MAX_FILE:
        raise ExtractionError("document_extraction_failed")
    text = extract(data, sys.argv[1])
    if not text.strip():
        raise ExtractionError("document_text_missing")
    result = {"text": text}
except ExtractionError as error:
    result = {"error": str(error)}
except Exception:
    result = {"error": "document_extraction_failed"}
sys.stdout.reconfigure(encoding="utf-8")
print(json.dumps(result, ensure_ascii=False))
