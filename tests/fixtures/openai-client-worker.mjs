/** Deterministic subprocess transport fixture; no network or real credentials. */
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
const prefix = "PI_OPENAI_EVENT:";
const send = (frame) => process.stdout.write(prefix + JSON.stringify(frame) + "\n");
let call;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const value = JSON.parse(line);
  if (value.type === "init") {
    call = { type: "function_call", id: "fc_" + randomUUID().replaceAll("-", ""), call_id: "call_" + randomUUID().replaceAll("-", ""), name: "view_file", arguments: '{"file_id":"doc_1"}', status: "completed" };
    send({ type: "ready" });
    if (process.env.CLIENT_FIXTURE_MODE === "failure") { send({ type: "failure", code: "PRIVATE_PROVIDER_SECRET" }); process.stdout.write("", () => process.exit(1)); return; }
    const yieldCall = () => send({ type: "yield", text: "", calls: [call], usage: { input: 10, output: 2, cached: 1, reasoning: 0 }, finishReason: "stop", pending: true });
    if (process.env.CLIENT_FIXTURE_MODE === "delayed-yield") setTimeout(yieldCall, 500); else yieldCall();
  } else if (value.type === "resume") {
    if (value.outputs[0].text === "reject-image") { send({ type: "resume_error", code: "image_input_disabled" }); return; }
    setTimeout(() => {
      send({ type: "ready" });
      const text = "Client document: " + value.outputs[0].text;
      send({ type: "text", delta: text });
      send({ type: "result", result: { text, calls: [], usage: { input: 20, output: 3, cached: 2, reasoning: 0 }, finishReason: "stop", pending: false } });
      process.stdout.write("", () => process.exit(0));
    }, 80);
  }
});
