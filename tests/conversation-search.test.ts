import test from "node:test";
import assert from "node:assert/strict";
import { searchConversationEntries, textBlocks } from "../extensions/lib/conversation-search.ts";

const at = (value: string) => new Date(value);

test("searches prior conversations by topic without a session ID", () => {
  const results = searchConversationEntries("modelo omniroute", [
    { id: "older", name: "Providers", updatedAt: at("2026-09-01T00:00:00Z"), entries: [{ role: "assistant", text: "Configuramos o modelo OmniRoute MiniMax.", timestamp: 1 }] },
    { id: "recent", name: "Unrelated", updatedAt: at("2026-09-02T00:00:00Z"), entries: [{ role: "user", text: "Vamos falar de calendários.", timestamp: 2 }] },
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "older");
  assert.match(results[0].excerpts[0].text, /OmniRoute/);
});

test("finds an exact session ID even when that ID is absent from message text", () => {
  const results = searchConversationEntries("01a0b453-d669-74c6-b9e6-9626b8fe45b7", [
    { id: "01a0b453-d669-74c6-b9e6-9626b8fe45b7", name: "Pulse fixes", updatedAt: at("2026-09-18T22:12:00Z"), entries: [{ role: "user", text: "Foram feitas as correções no pulso do package.", timestamp: 1 }] },
    { id: "other", updatedAt: at("2026-09-18T22:43:00Z"), entries: [{ role: "assistant", text: "Essa sessão não foi encontrada.", timestamp: 2 }] },
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "01a0b453-d669-74c6-b9e6-9626b8fe45b7");
  assert.match(results[0].excerpts[0].text, /correções/);
});

test("ranks exact topic matches before partial, then recency", () => {
  const results = searchConversationEntries("api evolution", [
    { id: "partial", updatedAt: at("2026-09-03T00:00:00Z"), entries: [{ role: "assistant", text: "A API está pronta.", timestamp: 1 }] },
    { id: "exact", updatedAt: at("2026-09-01T00:00:00Z"), entries: [{ role: "assistant", text: "A API Evolution foi configurada.", timestamp: 1 }] },
  ]);
  assert.deepEqual(results.map((result) => result.id), ["exact", "partial"]);
});

test("reads only text blocks and bounds result count", () => {
  assert.equal(textBlocks([{ type: "text", text: "visible" }, { type: "toolCall", name: "secret" }]), "visible");
  const candidates = Array.from({ length: 12 }, (_, index) => ({ id: String(index), updatedAt: at(`2026-09-${String(index + 1).padStart(2, "0")}T00:00:00Z`), entries: [{ role: "user" as const, text: "topic" }] }));
  assert.equal(searchConversationEntries("topic", candidates, 3).length, 3);
});
